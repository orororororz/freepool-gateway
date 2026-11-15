# syntax=docker/dockerfile:1
#
# freepool-gateway — 匿名免费车道 / Kilo 免费池 的 OpenAI 兼容网关
#
# 构建：docker compose build
# 运行：docker compose up -d
#
# ── 为什么源码是内置的，而不是构建时下载 ────────────────────────────────
# 运行所需的源码**内置在构建上下文里**（package.json / src，
# 共约 440 KB）：
#   · 构建不依赖 GitHub 可用性，完全可复现、可离线
#   · 镜像体积不变（这些文件本来就要拷进去）
#   · 唯一需要联网的步骤是装 Bun（见下），换 Dockerfile.reuse-bun 可绕过
# 升级时：替换同目录下的 src/ 与 package.json，再重新 build。
# 版本号由 package.json 的 "version" 决定，server.mjs 启动时读取并回报。
#
# 构建策略：单阶段运行时。
# 运行时 = node:24-alpine（约 50 MB）+ Bun（约 96 MB）+ 源码（0.4 MB）。

FROM node:24-alpine

# tini 转发信号，保证 SIGTERM 能到达 node，容器停止时不留半开的连接。
# libstdc++ / libgcc：bun 的 musl 构建在运行时需要它们。node:alpine 一般已经带了
# （Node 自己也是 C++），这里显式声明一次，换基础镜像时不会静静失效。
RUN apk add --no-cache tini libstdc++ libgcc

# ── Bun 运行时 ─────────────────────────────────────────────────────────
# 匿名免费车道的**推理请求**必须由 Bun 发出：免费池在推理路径上做 TLS 客户端
# 指纹识别，Node 内置的 undici 指纹不被接受（src/egress.js:203-243 只有
# opencode.ai 的 /inference/ POST 才走 Bun；GET 清单可以走 Node）。
#
# 用 npm 装：bun 的 npm 包把 musl 变体放在 optionalDependencies 里
# （@oven/bun-linux-x64-musl 声明了 "libc": ["musl"]），npm 会按容器的 libc
# 自动选中。Alpine community 仓库里没有 bun 包，apk add bun 走不通。
#
# 末尾强制 `bun --version`：装不上就让构建在这里失败，而不是等第一个推理请求。
ARG BUN_VERSION=1.4.4
RUN set -eux; \
    npm install -g --fetch-retries=5 --fetch-retry-maxtimeout=120000 "bun@${BUN_VERSION}"; \
    npm cache clean --force; \
    bun --version

WORKDIR /app

# package.json 必须带：src/ 下没有自己的 package.json，
# 根部的 "type": "module" 决定了 src/*.js 按 ESM 解析。少了它直接崩。
COPY package.json ./package.json
COPY src ./src
COPY server.mjs ./server.mjs
# 清单工具：容器内也能跑。
COPY list-models.mjs ./list-models.mjs

# 启动前自检：确认整形层依赖的两个官方资产在位（缺了会静默降级成空提示，
# 那样每个请求都会被免费池 429，很难排查）。
RUN set -eux; \
    test -f /app/src/core/runtime.js; \
    test -f /app/src/forward.js; \
    test -f /app/src/o2a.js; \
    test -f /app/src/o2a/assets/opencode_tools.json; \
    test -f /app/src/o2a/assets/opencode_prompt_v2.txt

# 数据目录：密钥、模型清单缓存、用量统计都落在这里。
RUN mkdir -p /data && chown -R node:node /data /app

ENV NODE_ENV=production \
    FP_HOME=/data \
    FP_LOCAL_PORT=18900 \
    FP_RELAY_PORT=18901 \
    FP_REFRESH_MINUTES=15 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# 只有中继端口需要暴露：回环端口是给容器内中继回拨用的。
EXPOSE 18901

VOLUME ["/data"]

USER node

# 存活探针打回环的 /health（该端点在密钥校验之前应答，无需鉴权）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${FP_LOCAL_PORT}/health" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.mjs"]
