# V1.1 §15.8 — Dockerfile 多阶段构建
#
# 阶段:deps → builder → runner
# 设计目标:
#   - 镜像最终运行 dist/main.js,基于 node:22-alpine,使用非 root 用户
#   - pnpm 版本与 package.json `packageManager` 字段对齐(pnpm@10.14.0)
#   - prisma generate 在 builder 阶段执行(不连库,纯本地 schema → client)
#   - runner 阶段的 node_modules 是真正的 prod-only 子集
#     (pnpm prune --prod 在 pnpm 10 下只清理 hoist symlink,
#      不删 .pnpm store 内的 dev 包数据 → 因此采用"备份 generated
#      client → rm -rf node_modules → pnpm install --prod 重装 →
#      还原 generated client"的方式裁剪)
#   - 部署侧迁移规则:`prisma migrate deploy` 不在镜像构建阶段执行,也不在
#     容器启动 CMD 中执行;由部署流程独立调用(见文末"生产迁移原则")
#
# 构建:
#   docker build -t u-nest-api-starter:v1.1 .
#
# 运行(示例):
#   docker run --rm -p 3000:3000 \
#     -e DATABASE_URL=postgresql://postgres:postgres@host.docker.internal:5432/app \
#     -e APP_ENV=production \
#     -e JWT_SECRET="$(openssl rand -base64 48)" \
#     -e APP_CORS_ORIGIN=https://app.example.com \
#     u-nest-api-starter:v1.1

ARG NODE_VERSION=22
ARG PNPM_VERSION=10.14.0

# =====================================================================
# Stage 1: deps — 全量依赖(含 dev),供 builder 编译使用
# =====================================================================
FROM node:${NODE_VERSION}-alpine AS deps

# Prisma 在 alpine(musl)下需要 openssl 与 libc6-compat 才能加载 query engine
RUN apk add --no-cache libc6-compat openssl

# corepack 启用 + 锁定 pnpm 版本(对齐 packageManager 字段,避免漂移)
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /app

# 仅复制依赖描述文件,最大化利用 layer 缓存(源码变动不会失效本层)
COPY package.json pnpm-lock.yaml ./

# --frozen-lockfile:严格按 lockfile 装依赖,版本不漂移
# --ignore-scripts:跳过 postinstall 类脚本,避免 prisma 在缺 schema 时尝试 generate
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

# =====================================================================
# Stage 2: builder — 编译 + 生成 Prisma Client + 裁剪到真正 prod 子集
# =====================================================================
FROM node:${NODE_VERSION}-alpine AS builder

RUN apk add --no-cache libc6-compat openssl

ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /app

# 复用 deps 阶段已装好的 node_modules(含 dev 依赖,nest CLI / prisma CLI 都在)
COPY --from=deps /app/node_modules ./node_modules

# 编译期需要的源码与配置
COPY package.json pnpm-lock.yaml ./
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY prisma ./prisma
COPY src ./src

# Prisma Client 生成(只读 schema.prisma,不连库)
RUN pnpm prisma:generate

# nest build → dist/main.js
RUN pnpm build

# ---- 裁剪到 prod-only ----
# 备份 generated Prisma Client。pnpm isolated linker(默认)下,prisma generate 写两个
# 兄弟目录到 .pnpm/@prisma+client@.../node_modules/:
#   @prisma/client   (公开包,含 default.js → require('.prisma/client/default'))
#   .prisma          (schema-bound runtime + alpine query engine .so)
# 两者必须同时备份;漏其中之一,runtime 会抛 Cannot find module '.prisma/client/default'
RUN PRISMA_PARENT_SRC=$(ls -d /app/node_modules/.pnpm/@prisma+client@*/node_modules) && \
    mkdir -p /tmp/prisma-generated && \
    cp -R "$PRISMA_PARENT_SRC"/@prisma/client /tmp/prisma-generated/client-pkg && \
    cp -R "$PRISMA_PARENT_SRC"/.prisma        /tmp/prisma-generated/dot-prisma

# 清空 node_modules 后用 hoisted linker 装 prod-only,顶层 node_modules 是 npm 兼容
# 的扁平布局,便于后续精确删除 dev-only 工具链与 hoist 出来的 optional peer。
#
# 注:不能加 --config.auto-install-peers=false (会与 lockfile 不匹配,frozen-lockfile
# 报 ERR_PNPM_LOCKFILE_CONFIG_MISMATCH);改在 install 后显式 rm 已知 dev-only 顶层包
RUN rm -rf node_modules
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --prod --frozen-lockfile --ignore-scripts \
        --config.node-linker=hoisted

# 显式删除 runtime 完全不引用的 dev-only 顶层包(grep dist/ 已确认外部 require 仅
# 包含: @nestjs/* @prisma/client bcryptjs class-transformer class-validator
# helmet nestjs-pino passport-jwt rxjs;@prisma/client runtime 也只 require Node
# 内置模块 + 自带 query engine,不依赖以下任何包)
#   prisma                    — Prisma CLI 工具,容器内不跑 generate/migrate
#   typescript                — @prisma/client 的 optional peer,runtime 不需要
#   effect                    — @prisma/config 的依赖,@prisma/client 不引用
#   @prisma/engines           — Prisma CLI 用的 migration / format engine
#   @prisma/engines-version
#   @prisma/config            — Prisma CLI 配置加载
#   @prisma/debug
#   @prisma/fetch-engine
#   @prisma/get-platform
#   @prisma/generator-helper
#   @prisma/generator
#   @prisma/internals
#   @types                    — TypeScript 类型,runtime 不需要
#
# !!! 维护铁律 !!!
# 当前删除清单基于"现有 dist/ 实际 require 的外部包" + "@prisma/client 内部 runtime
# 引用"两处验证得出。下列任一变化发生时,**必须**重跑 docker build 与容器 smoke test
# 重新核对清单(grep dist/ 与 @prisma/client/runtime 的 require,补/删条目):
#   - 升级 Prisma 主版本(可能新增 runtime 子包依赖,如未来版本拆出新引擎包)
#   - 升级 NestJS 主版本(可能引入新 prod runtime 依赖)
#   - package.json dependencies 字段新增/移除条目
#   - lockfile 大版本重写(pnpm 升级、依赖大规模 dedupe)
#
# **禁止**未经验证就增删本清单(漏删 → 镜像膨胀;误删 → 容器启动 MODULE_NOT_FOUND)。
# Smoke test 至少覆盖:GET /api/health、GET /api/health/ready、GET /api/docs;
# 容器进程必须为非 root(uid 1000 node)。
RUN rm -rf \
        node_modules/prisma \
        node_modules/typescript \
        node_modules/effect \
        node_modules/@prisma/engines \
        node_modules/@prisma/engines-version \
        node_modules/@prisma/config \
        node_modules/@prisma/debug \
        node_modules/@prisma/fetch-engine \
        node_modules/@prisma/get-platform \
        node_modules/@prisma/generator-helper \
        node_modules/@prisma/generator \
        node_modules/@prisma/internals \
        node_modules/@types

# 还原 generated Prisma Client 到 hoisted 布局的固定路径
# (hoisted 模式下 node_modules/@prisma/client 是真实目录,直接覆盖)
RUN rm -rf /app/node_modules/@prisma/client && \
    cp -R /tmp/prisma-generated/client-pkg /app/node_modules/@prisma/client && \
    cp -R /tmp/prisma-generated/dot-prisma /app/node_modules/.prisma && \
    rm -rf /tmp/prisma-generated

# =====================================================================
# Stage 3: runner — 最小生产镜像,非 root 运行
# =====================================================================
FROM node:${NODE_VERSION}-alpine AS runner

# Prisma 运行期同样需要 openssl / libc6-compat;NestJS 自身能处理 SIGTERM,
# 不引入额外 init,保持镜像最小
RUN apk add --no-cache libc6-compat openssl

WORKDIR /app

# 提示常用库切到生产模式(pino 之类会读取),业务配置仍由 APP_ENV 控制(§14)
ENV NODE_ENV=production

# 仅复制生产运行所需:dist 编译产物 + prod-only node_modules + prisma schema/migrations
# + package.json(node 解析模块时需要)。全部 chown=node:node,USER node 切换后能读
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/package.json ./package.json

# node:alpine 内置 uid=1000 的 node 用户;切换后进程不再以 root 运行
USER node

# APP_PORT 默认 3000,与 .env.example 一致;运行时可通过 -e APP_PORT 覆盖
EXPOSE 3000

# 直接 exec node,PID 1 是 Node 进程,可以直接收到 SIGTERM,
# 配合 main.ts 的 app.enableShutdownHooks() 做优雅关闭
CMD ["node", "dist/main.js"]

# ---------------------------------------------------------------------
# 生产迁移原则(本镜像不内置 migration 执行链路)
# ---------------------------------------------------------------------
# 本镜像**不会**在构建期连库,也**不会**在容器启动 CMD / ENTRYPOINT 中自动执行
# 任何数据库 migration。原则如下:
#
#   1. 生产环境**禁止**使用 `prisma migrate dev`(会改 schema 并生成新 migration),
#      该命令仅用于本地开发,与 v1 §0 铁律一致
#
#   2. 生产环境只允许执行已审查、已提交的 `prisma migrate deploy`
#
#   3. `prisma migrate deploy` 必须在"应用副本启动之前"由部署流程独立执行,
#      典型承载形式包括(择一,由部署环境决定):
#        - CI/CD pipeline 在发布新版本镜像前的独立步骤
#        - K8s Job / initContainer / Helm pre-upgrade hook
#        - 部署平台提供的一次性 migration job
#      具体使用哪种镜像、哪种触发方式、如何注入 DATABASE_URL,**由部署环境决定**,
#      不在 15.8 范围内固化(本任务只交付应用镜像本身)
#
#   4. 禁止在本 Dockerfile 添加 ENTRYPOINT 让容器启动时自动跑 migrate deploy:
#        - 启动时连库失败 → 容器反复重启,K8s rollback 行为不可控
#        - 多副本同时启动 → 多个 migrate deploy 并发,Prisma migration_lock 不保证安全
#        - 迁移应是部署流程的**显式**步骤,不是容器**隐式**行为
