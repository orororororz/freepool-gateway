#!/usr/bin/env node
/**
 * freepool-gateway — 把 opencode.ai 的「匿名免费车道」与「Kilo 免费池」
 * 暴露成一个 OpenAI 兼容的 HTTP 网关，任何 OpenAI 客户端都能直接连。
 *
 * ── 设计 ────────────────────────────────────────────────────────────────
 * 本文件是**薄壳**：模型通道、客户端指纹整形、目录刷新、可用性探测、
 * 思考强度、流式解析、错误分类全部由 `src/` 实现；本文件只负责端口、鉴权、
 * 数据目录、启动横幅与版本上报，不介入任何推理逻辑。
 *
 * 职责边界：路由、优先级、故障转移、计量与限流全部由调用方决定；
 * 本网关只回答两件事 ——「有哪些模型」和「这次请求发给谁」。没有网页控制台
 * 也没有管理 API，所有配置通过环境变量，密钥落在数据目录的 settings.json。
 * 除两条免费车道所必需之外，不对任何第三方厂商发出网请求。
 *
 * ── 对外接口 ────────────────────────────────────────────────────────────
 *   回环监听  127.0.0.1:${FP_LOCAL_PORT}   （容器内，供中继回拨）
 *   中继监听  0.0.0.0:${FP_RELAY_PORT}     （容器外，客户端走这个）
 *   GET  /health                     存活探针，无需鉴权
 *   GET  /v1/models                  模型清单
 *   POST /v1/chat/completions        对话（流式 / 非流式）
 *   POST /v1/responses               Responses API（流式 / 非流式）
 *
 * ── 鉴权模型 ────────────────────────────────────────────────────────────
 * `src/` 把「管理面」和「推理面」分得很干净：管理面只允许回环，推理面
 * 另开一个绑定 0.0.0.0 的中继，用一把**独立的**中继密钥鉴权。
 * 容器之间访问不是回环，所以必须走中继 —— 这是本薄壳存在的理由。
 * 本网关只补推理侧，不补管理侧。
 *
 * @module server.mjs
 */

import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createModelRuntime, createRuntimeStores } from './src/core/runtime.js'
import { startForwardServer, startLanRelay } from './src/forward.js'
import { findBunExecutable } from './src/bun-fetch.js'

// src/ 内部只认这两个变量名，这里把对外的 FP_* 别名映射过去，
// 这样容器侧只需要知道 FP_BUN / FP_TRANSPORT。
if (process.env.FP_BUN) process.env.OUR_FREE_MODEL_BUN = process.env.FP_BUN
if (process.env.FP_TRANSPORT) process.env.OUR_FREE_MODEL_FREE_TRANSPORT = process.env.FP_TRANSPORT

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 铸造一把密钥。前缀只用于辨认来源，与运行时的旧格式无关。 */
function mintKey() {
  return `fp-${crypto.randomBytes(24).toString('base64url')}`
}

/** 版本号：从随镜像 COPY 进来的 package.json 读取，用于 UA 归属与 /health 回报。 */
function readVersion() {
  try {
    const raw = fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return typeof parsed.version === 'string' ? parsed.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

const VERSION = readVersion()
const PRODUCT = 'freepool-gateway'

const DATA_DIR = path.resolve(process.env.FP_HOME || '/data')
const LOCAL_HOST = '127.0.0.1'
const LOCAL_PORT = Number(process.env.FP_LOCAL_PORT || 18900)
const RELAY_PORT = Number(process.env.FP_RELAY_PORT || 18901)
/** 目录刷新周期（分钟），默认 15。 */
const REFRESH_MINUTES = Number(process.env.FP_REFRESH_MINUTES || 15)

/**
 * 是否启用模型名别名层（把 id 里的 ':' 与 '/' 换成安全字符）。
 *
 * 默认关闭 —— OpenAI 协议本身不对 model 字段的字符做限制，含 ':free' 的
 * id 在标准客户端里都能直接调用。只有当某个客户端确实把含冒号或斜杠的
 * 名字截断/解析错乱时才打开它。
 *
 * 打开后：/v1/models 返回清洗后的名字，原始 id 放在 x_fp_model_id 字段，
 * 请求进来时网关自己反查回真实 id —— 客户端不需要改任何配置。
 */
const MODEL_ALIAS = process.env.FP_MODEL_ALIAS === '1'

const logger = {
  log: (...args) => console.log(`[${PRODUCT}]`, ...args),
  warn: (...args) => console.warn(`[${PRODUCT}]`, ...args),
  error: (...args) => console.error(`[${PRODUCT}]`, ...args),
  debug: (...args) => { if (process.env.FP_DEBUG === '1') console.debug(`[${PRODUCT}]`, ...args) },
}

/** 启动横幅：客户端接入需要的几个值全部在这里。 */
function banner({ localPort, relayPort, key, relayKey }) {
  const lines = [
    '',
    '════════════════════════════════════════════════════════════════════',
    ` ${PRODUCT} ${VERSION}`,
    '════════════════════════════════════════════════════════════════════',
    ` 回环推理   http://${LOCAL_HOST}:${localPort}/v1        （容器内专用）`,
    ` 中继推理   http://<容器地址>:${relayPort}/v1       ← 客户端 Base URL`,
    '',
    ' 接入方式（OpenAI 兼容）：',
    `   地址       http://<主机名或IP>:${relayPort}      ← 填成 Base URL`,
    `   密钥       ${relayKey}`,
    `   模型       见 GET /v1/models 的 id 原样填写`,
    '',
    ` 本机回环密钥 ${key}（仅供容器内自检用，勿外发）`,
    '',
    ` 模型别名   ${MODEL_ALIAS ? '已启用（id 中的 : 与 / 会被清洗）' : '未启用（保持原始 id）'}`,
    '════════════════════════════════════════════════════════════════════',
    '',
  ]
  console.log(lines.join('\n'))
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })

  const stores = createRuntimeStores({ dataDir: DATA_DIR, logger })
  const { settings } = stores

  // 复用持久化的密钥；没有就生成一把。两把密钥必须不同 —— 中继密钥会离开
  // 容器（填进客户端配置），回环密钥只在容器内自检时用。
  //
  // 用本产品自己的字段名（fpLocalKey / fpRelayKey），不复用运行时里已有的
  // 中继字段（forwardKey 等）：那些字段另有语义（中继开关、端口、密钥轮换流程
  // 都挂在上面），共用同一批字段会让两边互相干扰。
  const existing = settings.get()
  // 旧字段名只为迁移保留：已有数据目录里的密钥会被继续沿用，免得重建后
  // 客户端的 Bearer 突然 401。迁移过一次之后这两行就能删。
  const priorLocal = existing.ofmLocalKey
  const priorRelay = existing.ofmRelayKey
  const localKey = typeof existing.fpLocalKey === 'string' && existing.fpLocalKey !== ''
    ? existing.fpLocalKey
    : typeof priorLocal === 'string' && priorLocal !== '' ? priorLocal : mintKey()
  const relayKey = typeof existing.fpRelayKey === 'string'
    && existing.fpRelayKey !== '' && existing.fpRelayKey !== localKey
    ? existing.fpRelayKey
    : typeof priorRelay === 'string' && priorRelay !== '' && priorRelay !== localKey
      ? priorRelay
      : mintKey()

  settings.update({
    fpLocalKey: localKey,
    fpRelayKey: relayKey,
    // 路由与容灾由调用方负责，本网关只提供「有哪些模型」这一件事。
    combos: [],
  })
  settings.flush()
  if (settings.writeFailed) throw new Error('could not persist the gateway keys')

  // 只启用匿名车道与 Kilo 车道，其余运行时挂载点显式关闭：
  //   sealedCredential    → null  不启用密封凭据车道
  //   subscriptionRuntime   不传  不启用
  //   extensionRuntime    → null  不挂扩展平台
  const runtime = createModelRuntime({
    ...stores,
    logger,
    attributionUserAgent: `${PRODUCT}/${VERSION}`,
    sealedCredential: () => null,
    extensionRuntime: null,
  })

  // 匿名车道的推理请求必须走 Bun（免费池对推理路径做 TLS 客户端指纹识别）。
  // 缺 Bun 时只有匿名车道会失败，Kilo 车道照常可用 —— 启动就说清楚，
  // 免得等到用户调接口时才看到一个 502。
  const bun = findBunExecutable()
  if (bun === undefined) {
    logger.warn('未检测到 Bun —— 匿名免费车道的推理请求会失败（免费池在推理路径上做客户端指纹识别）。')
    logger.warn('Kilo 车道不受影响。安装 Bun 或把可执行文件路径写入 FP_BUN。')
  } else {
    logger.log(`Bun 传输就绪：${bun}`)
  }

  let refreshTimer
  let refreshInFlight = null
  let stopped = false

  const refreshCatalog = (force = false) => {
    if (refreshInFlight) return refreshInFlight
    // probe: false —— 只刷新清单，不发探测请求。
    // 探测会真实消耗免费额度，启动时默认不做。
    refreshInFlight = runtime.refreshCatalog({ probe: false, force })
      .then(result => {
        const count = runtime.publicModelRows().length
        logger.log(`模型清单已刷新：${count} 个模型`)
        return result
      })
      .catch(error => logger.warn(`模型清单刷新失败：${error?.message ?? error}`))
      .finally(() => { refreshInFlight = null })
    return refreshInFlight
  }

  // ── 兼容层：模型清单与模型名 ─────────────────────────────────────────
  //
  // 客户端会先用 GET /v1/models 拿清单，再拿其中的 id 直接发起对话。因此：
  //   · 清单必须只含**真实模型**；
  //   · 每个 id 必须能被直接调用（实测 26 个全部 200）；
  //   · 名字尽量保持原始 id，避免让客户端做任何映射。
  //
  // 车道来源从 runtime 的目录里取，标注为 x_fp_lane，方便排查时区分。
  const laneOf = (id) => {
    const entry = runtime.state().catalog.find(candidate => candidate.id === id)
    if (entry?.channel === 'kilo') return 'kilo'
    if (entry?.channel === 'combo') return 'combo'
    return 'anonymous'
  }

  /** 把 id 里的 ':' 与 '/' 换成安全字符（仅 MODEL_ALIAS 开启时使用）。 */
  const safeModelName = (id) => id.replace(/:/g, '-').replace(/\//g, '-')

  /**
   * 对外的模型清单：
   *  · 只列真实模型；
   *  · 开启别名层时清洗 id，并把原始 id 放进 x_fp_model_id；
   *  · 每个条目带上 x_fp_lane 标注来源车道。
   */
  const publicRows = () => {
    const rows = runtime.publicModelRows()
    const out = []
    const used = new Set()
    for (const row of rows) {
      const lane = laneOf(row.id)
      if (lane === 'combo') continue
      const id = MODEL_ALIAS ? safeModelName(row.id) : row.id
      if (used.has(id)) continue
      used.add(id)
      out.push({
        ...row,
        id,
        x_fp_lane: lane,
        ...(MODEL_ALIAS && id !== row.id ? { x_fp_model_id: row.id } : {}),
      })
    }
    return out
  }

  /**
   * 反查：把客户端传来的模型名还原成真实 id。
   * 先按清洗名匹配（MODEL_ALIAS 模式），再退回原样 —— 于是原始 id 和
   * 清洗后的名字**都能用**，客户端不需要额外配置。
   */
  const resolveModel = (model) => {
    const name = String(model ?? '')
    if (!MODEL_ALIAS) return name
    for (const row of runtime.publicModelRows()) {
      if (safeModelName(row.id) === name) return row.id
    }
    return name
  }

  // 回环推理面：只绑 127.0.0.1，中继回拨到这里。
  //
  // 端口固定（不是 0）是刻意的：HEALTHCHECK 要打一个确定的地址。代价是端口
  // 被占用时会直接失败 —— 这里把宿主给出的 EADDRINUSE 换成人能看懂的话，
  // 否则用户只会看到一坨 listen 堆栈。
  let listener
  try {
    listener = await startForwardServer({
      config: () => ({
        host: LOCAL_HOST,
        port: LOCAL_PORT,
        enabled: settings.get().enabled !== false,
        key: localKey,
      }),
      complete: (request, onChunk) => runtime.complete({ ...request, model: resolveModel(request.model) }, onChunk),
      modelRows: publicRows,
      health: () => ({
        ok: true,
        service: PRODUCT,
        product: 'freepool-gateway',
        version: VERSION,
        capabilities: { anonymous: true, kilo: true },
      }),
      log: message => logger.warn(`forward: ${message}`),
    })
  } catch (error) {
    if (error?.code === 'EADDRINUSE') {
      throw new Error(`回环端口 ${LOCAL_HOST}:${LOCAL_PORT} 已被占用。用 FP_LOCAL_PORT 换一个空闲端口（注意 HEALTHCHECK 会跟着这个变量走）。`)
    }
    throw error
  }

  // 容器外可达的推理面：绑 0.0.0.0，用独立的中继密钥鉴权，
  // 命中后回拨 127.0.0.1:<回环端口> 并换上回环密钥。
  const relay = await startLanRelay({
    config: () => ({
      enabled: !stopped && settings.get().enabled !== false,
      host: '0.0.0.0',
      port: RELAY_PORT,
      targetPort: listener.port,
      lanKey: relayKey,
      localKey,
    }),
    log: message => logger.warn(`relay: ${message}`),
  })

  banner({ localPort: listener.port, relayPort: relay.port, key: localKey, relayKey })

  // 启动刷新：先把清单拉起来，服务起来就能直接读到模型。
  await refreshCatalog(true)

  const scheduleRefresh = () => {
    clearTimeout(refreshTimer)
    if (stopped) return
    const minutes = Number.isFinite(REFRESH_MINUTES) && REFRESH_MINUTES > 0 ? REFRESH_MINUTES : 15
    refreshTimer = setTimeout(() => { void refreshCatalog(); scheduleRefresh() }, minutes * 60_000)
    refreshTimer.unref?.()
  }
  scheduleRefresh()

  const shutdown = async () => {
    if (stopped) return
    stopped = true
    clearTimeout(refreshTimer)
    await Promise.all([relay.close(), listener.close()])
    stores.settings.dispose()
    stores.stats.dispose()
    stores.availability.dispose()
    stores.catalogStore.dispose()
    logger.log('已停止')
  }

  process.once('SIGINT', () => { void shutdown().then(() => process.exit(0)) })
  process.once('SIGTERM', () => { void shutdown().then(() => process.exit(0)) })
}

main().catch(error => {
  console.error(`[${PRODUCT}] 启动失败：${error?.message ?? error}`)
  process.exitCode = 1
})
