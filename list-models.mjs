#!/usr/bin/env node
/**
 * list-models — 打印网关的模型清单。
 *
 * 网关只回答「免费池里有哪些模型」。这个脚本把清单取下来，按车道分组打印，
 * 或者输出成一行逗号分隔的 id（方便粘贴进任何客户端的模型输入框）。
 *
 * 用法：
 *
 *   1) 表格形式，按车道分组：
 *      node list-models.mjs --gateway http://127.0.0.1:18901 --key fp-xxx
 *
 *   2) 只输出 id，一行逗号分隔（粘贴用）：
 *      node list-models.mjs --gateway http://127.0.0.1:18901 --key fp-xxx --ids
 *
 *   3) 过滤某条车道（anonymous / kilo）：
 *      node list-models.mjs --key fp-xxx --lane kilo
 *
 *   4) 原样输出网关返回的 JSON：
 *      node list-models.mjs --key fp-xxx --json
 *
 * 密钥也可以从环境变量取：FP_RELAY_KEY。
 *
 * @module list-models.mjs
 */

const argv = process.argv.slice(2)

function arg(name) {
  const index = argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) return undefined
  return value
}
const flag = (name) => argv.includes(`--${name}`)

const GATEWAY = (arg('gateway') || process.env.FP_GATEWAY || 'http://127.0.0.1:18901').replace(/\/+$/, '')
const GATEWAY_KEY = arg('key') || process.env.FP_RELAY_KEY
const LANE = arg('lane')

function fail(message) {
  console.error(`取清单失败：${message}`)
  process.exit(1)
}

async function main() {
  if (!GATEWAY_KEY) fail('缺少网关密钥：用 --key 或设 FP_RELAY_KEY')

  let response
  try {
    response = await fetch(`${GATEWAY}/v1/models`, {
      headers: { authorization: `Bearer ${GATEWAY_KEY}` },
    })
  } catch (error) {
    fail(`连不上网关 ${GATEWAY}（${error?.message ?? error}）`)
  }
  if (response.status === 401) fail('网关拒绝了这个密钥（401），检查 --key')
  if (!response.ok) fail(`网关返回 HTTP ${response.status}`)

  const payload = await response.json()

  if (flag('json')) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }

  const rows = (Array.isArray(payload?.data) ? payload.data : [])
    .map(row => ({ id: String(row.id), lane: row.x_fp_lane ?? 'unknown' }))
    .filter(row => LANE === undefined || row.lane === LANE)

  if (rows.length === 0) fail(LANE === undefined ? '网关返回的模型清单为空' : `没有车道为 ${LANE} 的模型`)

  // --ids：列表走 stdout（方便 `$(...)` 捕获），说明走 stderr。
  if (flag('ids')) {
    console.log(rows.map(row => row.id).join(','))
    console.error(`共 ${rows.length} 个模型`)
    return
  }

  const width = Math.max(...rows.map(row => row.lane.length))
  for (const row of rows) console.log(`[${row.lane.padEnd(width)}] ${row.id}`)
  console.error(`\n共 ${rows.length} 个模型`)
}

main().catch(error => fail(error?.message ?? String(error)))
