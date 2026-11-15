# freepool-gateway

> **一个网关，26 个免费模型，三种协议。** 不用注册、不用填 Key、不用在后台申请配额 —— 装上就能用 OpenAI SDK、Claude Code、Gemini SDK 里任意一种连进来。
>
> 它把 opencode.ai 的匿名免费池和 Kilo 的免费池接成标准接口，剩下的（路由、重试、计量、限流）留给你的调用方。**这个网关不记账，也不替你做决策。**

## 亮点

- **零凭据启动**——匿名车道的凭据就是公开的 `Bearer public`，首次启动只需要容器，不需要任何账号。Kilo 车道自带公共免费池，同样不需要 Key。

- **清单跟随上游，不存快照**——模型集合、上下文长度、是否支持思考都在刷新时重新拉取（默认 15 分钟一轮，`FP_REFRESH_MINUTES` 可调）。上游下线一个模型，这里下一次刷新就消失，不会留一个点了就 404 的死条目。

- **完整的客户端指纹整形**——免费池在推理路径上校验客户端身份，所以请求出去之前要按官方 CLI 的形状重排：UA、工具名绑定、官方工具集注入、会话 id 铸造、`traceparent`。这一层不是可选装饰，它决定了请求是被正常应答还是被 429 挡回来。

- **三条线都能直连**——`/v1/chat/completions` 与 `/v1/responses` 走 OpenAI 协议，`/v1/messages` 走 Anthropic 原生格式（含 `thinking` 块、真实 `stop_reason`、流内 error 事件），`/v1beta/models/{model}:generateContent` 走 Gemini 原生格式。Claude Code、Anthropic SDK、Gemini SDK 都能把这里当成官方端点用，不需要中间转换层。

- **鉴权两种写法都收**——`Authorization: Bearer <密钥>` 或 `x-api-key: <密钥>`。后者是 Anthropic SDK 的默认行为，前者是 OpenAI 的，两种都支持意味着客户端不用为这个网关改代码。

- **中继与推理面分离**——回环端口（`18900`）只服务健康检查和中继回拨，中继（`18901`）用一把独立的密钥对外。凭据不回传、不出容器，外部拿到的密钥打不开回环面。

- **思考强度真实下发**——声明了档位菜单的模型（如 DeepSeek V4.1 Flash、GLM 5.3 Flash）把 `reasoning_effort` 原值送上游，上游会校验集合外的取值；没有菜单的模型走 token 预算阶梯。不是假装设置生效。

## 你会看到什么

模型清单是标准 OpenAI 形状，每个条目额外带几个自定义字段：

```json
{
  "object": "list",
  "data": [
    {
      "id": "big-pickle",
      "object": "model",
      "created": 1794734561,
      "owned_by": "freepool-gateway",
      "context_window": 262144,
      "x_fp_lane": "anonymous",
      "x_fp_efforts": ["light", "balanced", "deep"],
      "x_fp_effort_default": "balanced"
    }
  ]
}
```

`x_fp_lane` 标出这条模型属于哪条车道，`x_fp_efforts` 是它自己的思考档位（没有档位的模型不带这个字段）。标准客户端会忽略这三个字段，但它们对排查很有用 —— 429 从哪条车道来、这个模型能怎么调思考强度，一眼就能分。

配额撞墙时上游的原文长这样，它同时告诉你重开的时间：

```
the OpenCode free quota window is open on this egress: Free usage limit reached
… retry after 2026-11-16T00:00:01.605Z, or switch the lane's exit proxy
```

## 跑起来

```bash
docker compose up -d
docker compose logs -f freepool-gateway
```

日志里打印三样东西：地址、密钥、模型。密钥存在 `/data/settings.json`，容器重建不会变 —— 但数据目录丢了就要重新配客户端。

```bash
curl -s http://127.0.0.1:18901/v1/chat/completions \
  -H "Authorization: Bearer <密钥>" -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash-free","messages":[{"role":"user","content":"hi"}]}'
```

端口发布成 `18901:18901` 就是给局域网用的；只想本机访问就写 `127.0.0.1:18901:18901`，前面挂反代或隧道。

## 接进客户端

三样东西：Base URL、密钥、模型 id。

`/v1` 前缀有个坑值得先说：网关对 `/v1/chat/completions` 和 `/chat/completions` 都响应，但很多客户端会自己补 `/v1`，你写重了就成了 `/v1/v1/...`。所以 Base URL 最稳的写法是**不带** `/v1`。

```python
from openai import OpenAI

client = OpenAI(base_url="http://192.168.1.5:18901", api_key="<密钥>")
print(client.chat.completions.create(
    model="glm-5.3-flash-free",
    messages=[{"role": "user", "content": "say hi"}],
).choices[0].message.content)
```

Claude 形状的客户端同样把 Base URL 填成 `http://<主机>:18901` —— Anthropic SDK 会自己拼 `/v1/messages`，你再加一层 `/v1` 就又重了。Gemini 的客户端指到同一个根地址即可，路径里的 `/v1beta` 由它自己带。三种协议共用同一把密钥和同一份模型清单。

模型名里的 `:` 和 `/` 保持原样，比如 `nvidia/nemotron-3.5-super-vl:free`。实测各家客户端都认；万一哪个客户端把这种名字截断，打开 `FP_MODEL_ALIAS=1`，网关会把 `:` 和 `/` 换成 `-`，原始 id 塞进 `x_fp_model_id`，两种名字都能调用 —— 因为它自己反查。

当前会挂出来的 26 个：

```
anonymous  big-pickle, mimo-v2.6-flash-free, deepseek-v4.1-flash-free,
           glm-5.3-flash-free, longcat-2.5-free, iceman-free,
           inkling-2-small-free, beam-free, flint-40b-free,
           nemotron-3.5-super-vl-free, nemotron-3.5-lightning-free,
           minimax-m3.1-flash-free

kilo       kilo-auto/free, openrouter/free, stealth/glyph-cluster,
           liquid/lfm-3-1.7b:free, cohere/north-mini-code:free,
           particle-ai/particle-1:free, reflection/beam-free,
           nvidia/nemotron-3.5-super-vl:free, nvidia/nemotron-3.5-lightning:free,
           nvidia/nemotron-3-ultra-550b-a55b:free,
           nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free,
           inclusionai/ling-3.2-flash:free, baidu/ernie-5.5-flash-preview:free,
           dots-studio/dots-3-note-preview:free
```

## 实现结构

入口只有一个：`server.mjs`（约 320 行）。它不碰推理逻辑，只做四件事 —— 起两个监听、管密钥、定时刷清单、把版本号打进 `/health`。

推理路径在 `src/` 里，按层分：

- `forward.js` 是 HTTP 面：路由、鉴权、SSE 写出、四类协议各自的端点。
- `adapter.js` 是分派：判定这条请求属于哪条车道、装思考预算、调用整形、把流式块摊成 `StreamChunk`。
- `upstream.js` + `o2a.js` 负责「让请求看起来来自官方客户端」，`egress.js` 决定出口并决定这次请求用 Node 还是 Bun 发。
- `messages.js` 是内部格式与三种线格式的互转；`stream.js` 解析 SSE；`http.js` 管传输与错误分类；`route/classify.js` 把失败归成可重试/不可重试。
- `catalog.js` 拼清单，`kilo.js` 是 Kilo 车道的客户端，`store.js` 存设置与用量，`probe.js` 做可用性探测。

## 三个花过时间才弄明白的行为

**一、Bun 不是性能选择，是准入条件。**

免费池在推理路径上做 TLS 客户端指纹识别，Node 内置的 undici 指纹会被拒。所以 `egress.js` 里把这件事写死：只有 `opencode.ai` 的 `/inference/` POST 必须走 Bun，而 GET 清单可以走 Node。镜像里装 Bun 的 musl 静态构建，就是为了这一条 POST。Kilo 车道不需要它 —— 这也是为什么「没有 Bun」时你还能用一半的模型。

**二、429 报文不区分「配额烧尽」和「非官方客户端」。**

两种失败在上游眼里是同一个错误。所以把 `FP_TRANSPORT` 设成 `node` 想绕开 Bun 时，你只会看到一个 429，判断不出是配额问题还是指纹问题 —— 这个回退开关不建议依赖，保持 `auto`。判断配额是否烧尽要看报错里有没有 `retry after` 那个时间戳。

**三、配额是按「会话 × 出口 IP × project」分桶的。**

会话标识取自请求体的 `user` / `conversation` 字段。多数客户端不传，于是所有请求落进同一个 `forward:shared` 会话 —— 一个桶，一起打满。想让不同使用者各占一份配额，让他们带上 `user`（OpenAI SDK 的 `user` 参数就是干这个的）；想扩容就多出口 IP，因为按出口分桶本来就是这套配额模型的结构。

## 已知边界

**配额有窗口。** 按出口 IP 计，UTC 午夜重开。同一出口上所有人共用一份，高强度使用会提前烧光，那时候匿名模型一起 429。换出口的办法是给容器加 `HTTP_PROXY` / `HTTPS_PROXY`（优先级：本车道代理 → 全局出口 → 环境代理 → 直连）。Kilo 车道不受这条限制，是这时候的退路。

**429 会被重试放大。** 客户端 SDK 默认重试，聚合网关也重试，而你只有这一个上游，等于在同一个已打满的桶上反复撞。把调用方的重试压到一次以内。

**地区门。** 能用哪些模型取决于容器出口 IP，部分出口会被按地区拦掉（403 `RegionError`）。换出口即可。

**对面一改闸门就会断。** 客户端指纹那道校验已经迭代过三次（v1 → v2 → v1.4.6），一旦对面再动，这个镜像就开始 403，届时更新 `src/` 重新构建。

**没有网页控制台，也没有管理 API。** 配置全走环境变量：`FP_HOME`、`FP_RELAY_PORT`、`FP_DEBUG`、`FP_MODEL_ALIAS`、`FP_TRANSPORT`、`HTTP_PROXY`、`FP_REFRESH_MINUTES`，默认值写在 `Dockerfile` 的 `ENV` 里。

**免费池会记录 prompt。** Kilo 和 opencode 的模型卡都写明了这一点。敏感内容别往上跑。

**中继端口别裸奔到公网。** 它只有一把静态密钥，没有限流、没有 IP 白名单、没有账号维度。要对外就套反代和访问控制。

## 部署到 NAS 之类的地方

镜像基于 `node:24-alpine`，是 **musl**。想用 `Dockerfile.reuse-bun` 从已有镜像复制 Bun，源镜像必须是 alpine 变体（`oven/bun:*alpine*`）；`oven/bun:1`、`slim`、`debian` 都是 glibc，拷进去跑不起来。也别想着把宿主机的 bun 二进制挂进容器 —— NAS 宿主机基本都是 glibc 发行版，一挂就废。

容器以 `USER node`（uid 1000）运行，挂宿主目录时要给它写权限；用 named volume 或 `./data:/data` 不会遇到这个。
