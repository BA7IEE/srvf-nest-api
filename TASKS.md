# TASKS.md — V1.1 工程加固任务清单

> 本文件是 V1.1 工程加固的**唯一执行清单**。规范定义见 `ARCHITECTURE.md` §11、`AGENTS.md` §17、`CLAUDE.md` §17。
> 与上述文档冲突时,**以 `ARCHITECTURE.md` §11 为准**。
> 任务编号沿用仓库现有"阶段.子任务"风格(v1 收尾在 14.9,V1.1 从 15.1 起)。

---

## 0. V1.1 范围速读

只做三件事:

1. **可观测性**:结构化日志(pino)+ 请求 ID 贯通
2. **运维基础**:CI 流水线 + 优雅关闭 + 健康检查分层 + Dockerfile
3. **安全加固**:helmet HTTP 头 + 登录接口限流(内存 storage)

**仍然不做**(详见 `ARCHITECTURE.md` §11.3 / `AGENTS.md` §17.3 / `CLAUDE.md` §17.3):

- 不引入 Redis / BullMQ / 队列
- 不做审计日志数据库持久化
- 不接 OpenTelemetry / Sentry / APM / Prometheus
- 不做 RBAC / refresh token / 多租户 / 文件上传 Provider / LLM
- 不修改 `prisma/schema.prisma`、不修改 v1 已有业务接口
- 不修改 `docker-compose.yml`(用户明确锁定)

---

## 1. 任务总览

| 编号 | 任务 | 类别 | 依赖前置 | 状态 |
|---|---|---|---|---|
| 15.1 | GitHub Actions CI 流水线 | 工程基础 | — | ✅ 已完成 |
| 15.2 | 接入结构化日志(`nestjs-pino`) | 可观测性 | 15.1 | ✅ 已完成 |
| 15.3 | 请求 ID 贯通(`x-request-id`) | 可观测性 | 15.2 | ✅ 已完成 |
| 15.4 | 优雅关闭(shutdown hooks + `OnModuleDestroy`) | 进程生命周期 | 15.1 | ✅ 已完成 |
| 15.5 | 健康检查分层(`@nestjs/terminus`) | 进程生命周期 | 15.1 | ✅ 已完成 |
| 15.6 | helmet HTTP 安全头 | 安全加固 | 15.1 | ✅ 已完成 |
| 15.7 | 登录接口限流(`@nestjs/throttler` + `TOO_MANY_REQUESTS`) | 安全加固 | 15.1 | ✅ 已完成 |
| 15.8 | Dockerfile 多阶段构建 | 容器化 | 15.2-15.7 全部完成 | ✅ 已完成 |
| 15.9 | V1.1 验收 + README 增量更新 | 收尾 | 15.1-15.8 全部完成 | ✅ 已完成 |

执行原则:

- **逐个完成**:每个任务一次一 commit,commit message 前缀建议 `v1.1: <编号> <简述>`(对齐仓库 `test: 14.x` 风格)
- **每步验证**:任务声称完成前必须跑 `pnpm lint` + `pnpm typecheck` + `pnpm test:e2e`,且不破坏 v1 已有 137 用例
- **新依赖必须登记**:任务卡的"新增依赖"列就是 `package.json` 唯一允许新增的清单;额外依赖需要回到本文件登记后再装
- **不得跨任务搬运改动**:例如 15.2 引入日志时,不得顺手做 15.3 请求 ID 中间件——保持 commit 边界清晰

---

## 2. 任务卡

### 15.1 — GitHub Actions CI 流水线

**目标**:为后续 V1.1 任务提供"自动化验证安全网"。每次 push 与 PR 自动跑 lint + typecheck + E2E,守住 v1 已有的 137 用例不退化。

**前置依赖**:无。

**范围内**:

- 新增 `.github/workflows/ci.yml`
- 触发:`push` 到 `main` + 所有 `pull_request`
- Job 步骤(单 job 串行即可,V1.1 不引入矩阵):
  1. `actions/checkout`
  2. `pnpm/action-setup`(锁定 `package.json` 中 `packageManager` 声明的版本)
  3. `actions/setup-node`(Node 22,启用 pnpm cache)
  4. `pnpm install --frozen-lockfile`
  5. `pnpm lint`
  6. `pnpm typecheck`
  7. 启动 PostgreSQL 16 service container(端口 5432,user/pwd/db 与 `.env.test` 对齐)
  8. `pnpm db:test:init`
  9. `pnpm test:e2e`
- CI 环境变量:对齐 `.env.test`,通过 `env:` 段或 GitHub `secrets`(本任务用环境内联值即可,不需要真 secrets)

**范围外**:

- 不做发布/部署 job(不推 npm、不推 Docker Hub、不推 GHCR)
- 不引入 dependabot / renovate(后续单独评估)
- 不集成 codecov / coveralls(覆盖率门禁不在 V1.1)
- 不并行多 Node 版本(只跑 Node 22 LTS)

**新增依赖**:无(GitHub Actions 由托管方提供)。

**新增/修改文件**:

- 新增:`.github/workflows/ci.yml`

**验收标准**:

- [ ] PR 触发时 CI 跑通,绿勾
- [ ] CI 中 `pnpm test:e2e` 输出 `Tests: 137 passed`(或更多,若 V1.1 后续任务追加了 E2E)
- [ ] CI 总耗时 ≤ 5 min(macOS 本机参考 14s,远端含拉镜像、装依赖会更长,但应在合理区间)
- [ ] 故意打破 lint(本地试一次)能让 CI 红
- [ ] 故意打破 E2E(本地试一次)能让 CI 红

---

### 15.2 — 接入结构化日志(`nestjs-pino`)

**目标**:把 NestJS 默认 Logger 替换为 `nestjs-pino`,JSON 输出,自动屏蔽敏感字段;开发环境可读,生产环境机器可解析。

**前置依赖**:15.1(让 CI 守住改动后 137 用例不退化)。

**范围内**:

- 在 `AppModule` 中注入 `LoggerModule.forRootAsync({ ... })`(或 `forRoot`,异步注入便于读取 `app.config.ts`)
- 配置:
  - JSON 输出
  - 生产环境直接 stdout JSON;非生产环境通过 `pino-pretty` 美化(仅 dev 依赖)
  - `redact.paths` **必须**至少包含:`req.headers.authorization`、`req.headers.cookie`、`req.body.password`、`req.body.newPassword`、`req.body.token`、`req.body.accessToken`、`req.body.refreshToken`、`*.passwordHash`、`*.secret`;命中字段输出 `[REDACTED]`
  - 自动接管 NestJS 的 `Logger` 实例(`useLogger(app.get(Logger))`)
- 新增环境变量 `LOG_LEVEL`(默认非生产 `debug` / 生产 `info`),归 `src/config/app.config.ts`,启动校验值 ∈ `{ fatal, error, warn, info, debug, trace }`
- `.env.example` 同步追加 `LOG_LEVEL=`
- HTTP 请求自动日志:`method` / `url` / `statusCode` / `responseTime` / `requestId` / `userId`(若已登录),**禁止**默认打印请求体

**范围外**:

- 不接日志收集后端(ELK / Loki / CloudWatch)——只输出 stdout
- 不引入日志文件 rolling
- 不接错误上报(Sentry 等)
- 不替换 `console.log` 为 logger(项目代码中本来就不该有 `console.log`,若有应作为本任务子检查项移除)
- 不为业务模块新增专用 logger 命名空间(下个任务做)

**新增依赖**(`pnpm add`):

- `nestjs-pino`
- `pino`
- `pino-http`(`nestjs-pino` peer)
- `pino-pretty`(`pnpm add -D`)

**新增/修改文件**:

- 修改:`src/app.module.ts`(注入 `LoggerModule`)
- 修改:`src/main.ts`(`useLogger`)
- 修改:`src/config/app.config.ts`(读 `LOG_LEVEL` + 启动强校验)
- 修改:`.env.example`(追加 `LOG_LEVEL=`)
- 不需要 `src/common/logger/` 子目录,所有配置走 `app.config.ts` + `LoggerModule.forRootAsync`

**验收标准**:

- [ ] 启动后默认输出 JSON 日志(开发模式可叠 pino-pretty 美化)
- [ ] `pnpm test:e2e` 通过(137 用例,日志接入不破坏 E2E)
- [ ] 登录请求日志中 `req.body.password` 显示为 `[REDACTED]`
- [ ] 登录响应日志不包含 `accessToken` 明文(若被截获到日志路径,需在 redact paths 中)
- [ ] `LOG_LEVEL=invalid` 启动报错退出
- [ ] `pnpm lint` / `pnpm typecheck` 通过

---

### 15.3 — 请求 ID 贯通(`x-request-id`)

**目标**:让每个请求有唯一 ID,贯穿日志与响应头;前端报错时拿到 ID,后端日志能精准对齐。

**前置依赖**:15.2(日志已接,请求 ID 才有承载)。

**范围内**:

- 优先使用 `nestjs-pino` 内置 `genReqId` 选项,接收 `x-request-id` 请求头;头缺失则用 `cuid()` 生成
- 中间件 / `pino-http` 钩子在响应头写回 `x-request-id`
- 所有日志条目自动携带 `reqId`(pino 默认行为,确认未被覆盖)
- 不在响应体的 `data` / `message` / `code` 中暴露 requestId(请求 ID 只放响应头与日志)

**范围外**:

- 不持久化到数据库
- 不塞进 JWT payload
- 不在 BizException / AllExceptionsFilter 中把 requestId 拼到 `message` 里
- 不为 requestId 单独建 `RequestContextService`(`AsyncLocalStorage` 之类),v1.1 用 pino 自带的 req 绑定即可

**新增依赖**:无(pino 已带)。

**新增/修改文件**:

- 修改:`src/app.module.ts` 的 `LoggerModule.forRootAsync` 配置(加 `genReqId`)
- 必要时新增:`src/common/middleware/request-id.middleware.ts`(若 pino 内置 hook 无法满足"覆盖原始头但保留外部传入 ID"的需求)

**验收标准**:

- [ ] 任意请求响应头中包含 `x-request-id`
- [ ] 客户端传入 `x-request-id: my-trace-123`,响应头回显同值
- [ ] 客户端不传时,响应头出现合法 `cuid()` 值
- [ ] 日志条目中可见 `reqId` 字段,与响应头一致
- [ ] `pnpm test:e2e` 通过
- [ ] `pnpm lint` / `pnpm typecheck` 通过

---

### 15.4 — 优雅关闭(shutdown hooks + `OnModuleDestroy`)

**目标**:SIGTERM / SIGINT 时让在飞请求跑完、Prisma 连接干净关闭,避免容器重启时丢请求或留连接。

**前置依赖**:15.1(CI 守住回归)。

**范围内**:

- `src/main.ts` 调用 `app.enableShutdownHooks()`
- `src/database/prisma.service.ts` 实现 `OnModuleDestroy`,在 `onModuleDestroy()` 内 `await this.$disconnect()`
- 文档化关闭顺序:HTTP server 停接 → 等 in-flight 请求 → `OnModuleDestroy`(Prisma 断连)→ `OnApplicationShutdown`

**范围外**:

- 不在 `main.ts` 自写 `process.on('SIGTERM', ...)`
- 不调 `process.exit(0)` 强制退出
- 不引入 PM2 / `pino-final` 等 graceful shutdown 库(NestJS 已经处理)
- 不修改业务模块的关闭逻辑

**新增依赖**:无。

**新增/修改文件**:

- 修改:`src/main.ts`
- 修改:`src/database/prisma.service.ts`

**验收标准**:

- [ ] 本地 `pnpm start:dev` 后 `Ctrl+C`(SIGINT)能干净退出,日志显示 Prisma 断连
- [ ] `pnpm test:e2e` 通过(测试用例中创建的 NestJS app 关闭时不抛连接错误)
- [ ] 手动测试:启动服务,curl 慢请求(若有可控制时长的接口)+ 同时发 SIGTERM,服务等待请求完成再退
- [ ] `pnpm lint` / `pnpm typecheck` 通过

---

### 15.5 — 健康检查分层(`@nestjs/terminus`)

**目标**:为生产部署提供 K8s liveness / readiness 兼容的健康检查,同时**保留** v1 已有的 `/api/health` 不破坏向后兼容。

**关键约束**:可以使用 `@nestjs/terminus` 的检查能力(如 `HealthCheckService`、`PrismaHealthIndicator` 或等价的 DB ping),但**不得破坏项目统一响应格式**。`/api/health`、`/api/health/live`、`/api/health/ready` 仍应遵循项目既有 `ResponseInterceptor` 包装规则,响应体仍是 `{ code: 0, message: 'ok', data: { ... } }`,**禁止**为对齐 terminus 原生输出而绕过 `ResponseInterceptor`、自定义跳过列表、或改写 `data` 外层结构。

**关于 ready 失败 HTTP status 的最终决策(方案 A,最高优先级 `ARCHITECTURE.md` §11.4)**:

- ready DB 探测失败时**必须**抛 `BizException(BizCode.INTERNAL_ERROR)`,经 `AllExceptionsFilter` 按 `BizCode.INTERNAL_ERROR.httpStatus` 输出 **HTTP 500**,响应体为 `{ code: 50000, message: '服务器内部错误', data: null }`
- 本期**不**新增 `BizCode.SERVICE_UNAVAILABLE`,**不**修改 `AllExceptionsFilter`,**不**做 ready 路径特判
- `ARCHITECTURE.md` §11.4 明确"HTTP status 由 `BizCode` 的 `httpStatus` 决定";`BizCode.INTERNAL_ERROR.httpStatus` 是 500,因此 ready 失败的 HTTP status 必然是 500,这是有意为之的设计选择,而非 K8s 标准 readiness 503 语义
- 若未来需要标准 HTTP 503,应单独设计 `BizCode.SERVICE_UNAVAILABLE`(建议 `code: 50300`、`httpStatus: 503`),并同步更新本节及 `AGENTS.md` §17.5 / `CLAUDE.md` §17.5;**不在 15.5 范围内处理**
- K8s readiness probe 对 5xx 一律视作 unready,500 与 503 在容器编排层面行为一致,不影响生产可用性

**前置依赖**:15.1(CI 守住改动后 137 用例 + 新增的 health E2E 一起回归)。

**范围内**:

- `src/modules/health/` 升级:
  - 引入 `@nestjs/terminus`
  - `GET /api/health/live` — 进程存活,@Public(),返回 `{ status: 'ok' }`
  - `GET /api/health/ready` — DB 连通(`PrismaHealthIndicator` 或等价 `prisma.$queryRaw\`SELECT 1\``),@Public(),成功返回 `{ status: 'ok', db: 'up' }`,失败抛 `BizException(BizCode.INTERNAL_ERROR)` → 由 `AllExceptionsFilter` 按 `BizCode.INTERNAL_ERROR.httpStatus` 输出 HTTP 500 + `{ code: 50000, message: '服务器内部错误', data: null }`(详见上方"关于 ready 失败 HTTP status 的最终决策")
  - `GET /api/health` — 保留,实现等同 `/live`,响应仍为 `{ status: 'ok' }`(v1 已有 E2E 必须继续过)
- 三端点都走 `ResponseInterceptor` 包装(响应体 `{ code: 0, message: 'ok', data: { ... } }`)
- 三端点都有 `@ApiOperation` + `@ApiWrappedOkResponse(...)`(其中 `data` 的 schema 用一个轻量 `HealthResponseDto`,不要在 v1 的 `users` / `auth` 模块下放)

**范围外**:

- 不接 Redis 健康检查(V1.1 没引入 Redis)
- 不接外部 API 健康检查
- 不暴露 `/metrics`
- 不创建新 `*.config.ts`
- 不修改 v1 已有的 `health.e2e-spec.ts` 用例(扩展可以加新文件,旧用例必须继续过)

**新增依赖**(`pnpm add`):

- `@nestjs/terminus`
- `@nestjs/axios`(若 `@nestjs/terminus` peer 提示需要,且 V1.1 未触达 HTTP 检查时可不装,优先免装)

**新增/修改文件**:

- 修改:`src/modules/health/health.module.ts`
- 修改:`src/modules/health/health.controller.ts`
- 新增:`src/modules/health/health.dto.ts`(`HealthResponseDto`,字段 `status: 'ok'`、可选 `db: 'up' | 'down'`)
- 新增 E2E:`test/e2e/health-live.e2e-spec.ts`、`test/e2e/health-ready.e2e-spec.ts`(注意:不修改 `test/e2e/health.e2e-spec.ts`,新建独立 spec)

> **注意**:本任务因为只允许新增 spec、不允许修改既有 spec,所以新 spec 独立成文件。

**验收标准**:

- [ ] `GET /api/health` 仍按 v1 契约返回(已有 E2E 通过)
- [ ] `GET /api/health/live` 返回 200 + 包装响应体
- [ ] `GET /api/health/ready` DB 通时 200 + `data.db = 'up'`;DB 故障时 **HTTP 500** + `{ code: 50000, message: '服务器内部错误', data: null }`(可手动断 DB 复现;HTTP status 由 `BizCode.INTERNAL_ERROR.httpStatus` 决定,详见任务卡顶部"最终决策")
- [ ] Swagger UI 中三端点都能看到完整描述与响应 schema
- [ ] `pnpm test:e2e` 通过(137 + 新增用例)
- [ ] `pnpm lint` / `pnpm typecheck` 通过

---

### 15.6 — helmet HTTP 安全头

**目标**:为 HTTP 响应附加基线安全头,降低公网裸跑被扫的攻击面。

**前置依赖**:15.1。

**范围内**:

- `src/main.ts` 中 `app.use(helmet())`
- 默认配置即可
- 若 Swagger UI 因 inline script 被 CSP 拦掉,**仅对 `/api/docs` 路径**关闭 `contentSecurityPolicy`(局部禁用,不要全局关)

**范围外**:

- 不开启 HSTS preload 列表(需要域名所有权,生产部署再处理)
- 不自定义 CSP 白名单(超出 V1.1 范围,先用 helmet 默认)
- 不为 helmet 单建 `*.config.ts`

**新增依赖**(`pnpm add`):

- `helmet`

**新增/修改文件**:

- 修改:`src/main.ts`

**验收标准**:

- [ ] 任意接口响应头包含 `X-Content-Type-Options: nosniff`、`X-Frame-Options`、`Strict-Transport-Security` 等 helmet 默认头(具体清单按 helmet 版本)
- [ ] `/api/docs` 在浏览器中正常打开(若需局部禁 CSP,确认仅 docs 路径,非全局)
- [ ] `pnpm test:e2e` 通过
- [ ] `pnpm lint` / `pnpm typecheck` 通过

---

### 15.7 — 登录接口限流(`@nestjs/throttler` + `TOO_MANY_REQUESTS`)

**目标**:为 `POST /api/auth/login` 加 IP 维度限流,挡住自动化爆破;不引入 Redis,只用内存 storage。

**前置依赖**:15.1。

**范围内**:

- 新增 BizCode 常量:`TOO_MANY_REQUESTS = { code: 42900, message: '请求过于频繁，请稍后再试', httpStatus: HttpStatus.TOO_MANY_REQUESTS }`
- `@nestjs/throttler` 全局注册,但**仅作用于 `POST /api/auth/login`**(用 `@Throttle()` 装饰器或 `@SkipThrottle()` 在其余 controller 上跳过,二选一,优先按"白名单装饰"实现:全局默认 `@SkipThrottle()`,只在登录接口加 `@Throttle({ default: { limit, ttl } })`)
- 限流参数从 `app.config.ts` 注入,新增环境变量:
  - `LOGIN_THROTTLE_LIMIT`(默认 `5`)
  - `LOGIN_THROTTLE_TTL_SECONDS`(默认 `60`)
- 启动校验:两值都必须为正整数,推荐范围 `[1, 100]` / `[1, 3600]`
- `.env.example` 同步追加
- 自定义 `ThrottlerGuard` 子类,把 throttler 抛出的异常转为 `BizException(BizCode.TOO_MANY_REQUESTS)`,确保走 `AllExceptionsFilter` 统一响应体
- E2E 新增:登录限流命中场景(`test/e2e/auth-login-throttle.e2e-spec.ts`),需要在测试中等待 TTL 过期或调小 TTL(通过 `.env.test` 覆盖参数)

**范围外**:

- 不对 `/api/users` / `/api/users/me` 等其它接口加限流
- 不引入 Redis storage
- 不在响应头返回 `Retry-After` 暴露阈值与剩余配额(若 throttler 默认加,需要在自定义 guard 中移除)
- 不做 username 维度限流(V1.1 仅 IP 维度,够挡爆破)

**新增依赖**(`pnpm add`):

- `@nestjs/throttler`

**新增/修改文件**:

- 修改:`src/common/exceptions/biz-code.constant.ts`(新增 `TOO_MANY_REQUESTS`)
- 修改:`src/config/app.config.ts`(读 `LOGIN_THROTTLE_LIMIT` / `LOGIN_THROTTLE_TTL_SECONDS` + 校验)
- 修改:`src/app.module.ts`(注册 `ThrottlerModule.forRootAsync`)
- 修改:`src/modules/auth/auth.controller.ts`(`POST /login` 加 `@Throttle(...)`)
- 新增:`src/common/guards/throttler-biz.guard.ts`(自定义子类,转 BizException)或在 `AllExceptionsFilter` 内识别 `ThrottlerException` 转 BizCode(择一,记录在任务卡注释中)
- 修改:`.env.example`(追加两个新变量)
- 新增 E2E:`test/e2e/auth-login-throttle.e2e-spec.ts`

**验收标准**:

- [ ] `POST /api/auth/login` 连续超过限制后返回 HTTP 429 + `{ code: 42900, message: '请求过于频繁，请稍后再试', data: null }`
- [ ] 限流响应**不含**阈值数字、剩余配额、重置时间
- [ ] 其他接口(如 `GET /api/users/me`)不被限流(在 E2E 中验证或手动 200+ 次请求观察)
- [ ] `LOGIN_THROTTLE_LIMIT=0` 启动报错
- [ ] `pnpm test:e2e` 通过
- [ ] `pnpm lint` / `pnpm typecheck` 通过

---

### 15.8 — Dockerfile 多阶段构建

**目标**:交付一个可直接构建的应用镜像,满足首次生产部署需要;**不修改** `docker-compose.yml`。

**前置依赖**:15.2 - 15.7 全部完成(让镜像里跑的就是 V1.1 全套加固后的应用)。

**范围内**:

- 新增 `Dockerfile`(项目根),三阶段:
  1. **deps**:`node:22-alpine`,`pnpm install --frozen-lockfile`(利用 pnpm cache mount 加速)
  2. **builder**:复制源码 + 依赖,`pnpm prisma:generate` + `pnpm build`,产出 `dist/`
  3. **runner**:`node:22-alpine`,只复制必要文件(`dist/`、`node_modules/` 中 production 依赖、`prisma/` 目录、`package.json`),切换到非 root 用户(`node`),`CMD ["node", "dist/main.js"]`
- 新增 `.dockerignore`:屏蔽 `node_modules`、`.git`、`.env*`、`dist`(builder 之外不复制)、`test/`、`.planning/`、本地缓存等
- 新增 `docker-entrypoint.sh`(可选):启动前先跑 `pnpm prisma migrate deploy`(只跑已审查 migration,符合 v1 铁律);若不引入 entrypoint,需在文档中说明部署方按需先跑 migration
- Dockerfile 注释中标注:`prisma migrate deploy` **不能在镜像构建阶段**执行(镜像构建期不应连库),只能在容器启动时由 entrypoint 执行

**范围外**:

- 不修改 `docker-compose.yml`(用户明确锁定)
- 不交付 `docker-compose.prod.yml`(生产 compose 需按真实部署环境定制,不在 V1.1)
- 不交付 K8s manifests / Helm chart
- 不交付镜像推送脚本(GHCR / Docker Hub / 阿里云容器镜像服务)
- 不引入 PM2 / forever 之类的进程管理器(NestJS 自身 + Docker 重启策略已够用)

**新增依赖**:无(无新 npm 依赖)。

**新增/修改文件**:

- 新增:`Dockerfile`
- 新增:`.dockerignore`
- 可选新增:`docker-entrypoint.sh`(若选择 entrypoint 方式;否则在 README 中说明)

**验收标准**:

- [ ] `docker build -t u-nest-api-starter:v1.1 .` 在干净本地能构建通过
- [ ] 构建后镜像大小 ≤ 400MB(alpine + prod-only 依赖,合理上限)
- [ ] 运行时 `docker run --rm -e DATABASE_URL=... -e JWT_SECRET=... ... u-nest-api-starter:v1.1` 能起服务,`/api/health/live` 200
- [ ] 镜像不以 root 运行(`docker run ... id` 可验证)
- [ ] Dockerfile 中**不包含** `prisma migrate deploy` 步骤(只在 entrypoint 或部署方手动执行)
- [ ] `.dockerignore` 包含 `.env`、`.env.test`、`.git`、`node_modules`、`test/`、`.planning/`、`dist/`(注意:builder 阶段产物不要被 host 的 dist 污染)
- [ ] CI(15.1 流水线)继续过

---

### 15.9 — V1.1 验收 + README 增量更新

**目标**:跑一遍完整验收 + 在 README.md 中追加一段 V1.1 已落地能力说明,正式宣告 V1.1 完成。

**前置依赖**:15.1 - 15.8 全部完成。

**范围内**:

- 完整跑一遍:`pnpm lint` + `pnpm typecheck` + `pnpm test:e2e` + 手工启动 + Swagger UI + 三个 health 端点 + 登录限流命中演示
- 在 `README.md` 追加一节"V1.1 工程加固已落地能力",列出:
  - 结构化日志 + 敏感字段屏蔽
  - 请求 ID `x-request-id` 贯通
  - 优雅关闭
  - 健康检查 `/api/health` / `/live` / `/ready`
  - helmet HTTP 安全头
  - 登录接口限流(`POST /api/auth/login`,默认 5 次 / 60 秒 / per IP,内存 storage)
  - Dockerfile 多阶段构建
  - GitHub Actions CI
- 在 `README.md` 路由总览表中追加 `GET /api/health/live` 与 `GET /api/health/ready` 两行(注意:不修改 v1 路由清单的描述,只是补充新端点)
- 更新本文件(TASKS.md)所有任务状态为 ✅ 已完成

**范围外**:

- 不修改 `ARCHITECTURE.md`(V1.1 已在 §11 落地,不需要再改)
- 不修改 `AGENTS.md` / `CLAUDE.md`(已在 §17 落地)
- 不发布版本号(若需要 git tag,由用户决定,不自动打)
- 不写 CHANGELOG.md(项目暂无,不在 V1.1 引入)

**新增依赖**:无。

**新增/修改文件**:

- 修改:`README.md`
- 修改:`TASKS.md`(状态收尾)

**验收标准**:

- [ ] `pnpm lint` / `pnpm typecheck` / `pnpm test:e2e` 全绿
- [ ] CI 流水线全绿
- [ ] Swagger `/api/docs` 中可见三个 health 端点 + 登录接口的限流相关错误响应描述(若 BizCode `TOO_MANY_REQUESTS` 列入 Swagger 错误响应表,要在 controller 上加 `@ApiResponse({ status: 429, ... })`)
- [ ] `docker build` 通过,容器内服务能起
- [ ] README.md 新章节准确描述 V1.1 已落地能力,**不**夸大(例如不要写"接入了 APM"——V1.1 没接)
- [ ] 本文件所有 9 条任务状态更新为 ✅

---

## 3. 任务执行 checklist 通用模板

每个任务开始前:

- [ ] 已读 `ARCHITECTURE.md` §11
- [ ] 已读 `AGENTS.md` §17 / `CLAUDE.md` §17
- [ ] 已确认前置任务全部完成
- [ ] 已确认本任务"范围外"列表,排除"顺手做"的诱惑
- [ ] 已用 TodoWrite 拆出当前任务子步骤(Claude Code 专用)

每个任务声称完成前:

- [ ] `pnpm lint` 通过
- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test:e2e` 通过(含 v1 已有 137 用例 + 本任务新增 E2E)
- [ ] 启动服务,Swagger UI 可访问
- [ ] `GET /api/health` 仍按 v1 契约返回(向后兼容)
- [ ] 本任务卡所有"验收标准"打勾
- [ ] 没有引入未在任务卡声明的新依赖
- [ ] commit message 前缀 `v1.1: <编号> <简述>`

---

## 3.1 后续小改进(不阻塞发布)

V1.1 / v0.1.2 工程收口已完成,以下属于低优先级清理项,作为独立任务持续推进。**禁止**在业务任务中"顺手"扩大改动一并处理:

- [ ] 逐步降低测试代码与 Prisma seed 中的 ESLint warnings(主要是 `@typescript-eslint/no-unsafe-argument`),不能降低 `src/` 业务代码规则严格度

---

## 4. 范围外的统一处理

执行 V1.1 任务过程中遇到任何"看起来该顺手做"的事项,**全部**走以下流程:

1. **暂停**,不要先实现
2. 在与用户的对话里声明:这件事在 V1.1 范围外,具体属于哪条禁止项 / 哪条 §9 升级路径
3. 由用户决定:
   - **a. 写入 TASKS.md 新任务卡**(若用户认为应纳入 V1.1)
   - **b. 写入 backlog**(若用户认为应延后,可记在 `.planning/` 或单独文件)
   - **c. 直接放弃**(若用户认为不需要)

**禁止**未经用户确认就实现"顺手"事项。这是 V1.1 阶段最容易破口的地方。

---

## 5. V2 — srvf-nest-api 基础数据底座(设计阶段)

> **范围**:仅 `srvf-nest-api` 派生项目;不回流 `u-nest-api-starter` 模板仓。
> **本区块覆盖**:V2 设计与调研任务(§5.0-§5.4)+ 完全不依赖业务调研的 **A 档基建快车道**(§5.5)。**不含**业务模块开发任务 — 业务开发(含组织 / 字典 / 队员 / 附件 / 审计 / 事件等表与对应 controller/service/dto)须 V2-D8 通过后另起 `## 6. V2 — srvf-nest-api 基础数据底座(开发阶段)` 区块。
> **铁律依据**:[`docs/srvf-foundation-research.md`](./docs/srvf-foundation-research.md) + [`docs/srvf-foundation-baseline.md`](./docs/srvf-foundation-baseline.md) + `ARCHITECTURE.md §12` + `CLAUDE.md §18` + `AGENTS.md §18`。
> **当前阶段终点**:进入 `docs/srvf-foundation-data-model-draft.md` 起草并通过评审,**不是**进入开发。
> **解除条件**:V2-D7 完成后,另起 `## 6. V2 — srvf-nest-api 基础数据底座(开发阶段)` 区块,**禁止**在本节内追加开发任务。

### 5.0 范围速读

本阶段**只允许**以下动作:

- 读取既有代码 / 文档 / Git 历史
- 撰写 / 修改 V2 设计阶段的 4 类文档(研究 / 草案 / 蓝图登记 / 设计任务卡)
- 用户访谈 / 资料收集 / 调研结果回填
- 评审与标签化结论(已确认 / 当前倾向 / 待调研 / 暂不做)

本阶段**禁止**的动作清单见 `CLAUDE.md §18.1` / `AGENTS.md §18.1`,本节不重复。

**新增隐含约束(自 commit `16876fe` 起)**:本区块所有 V2 任务(含 §5.5 A 档快车道)默认遵守 [`docs/srvf-foundation-baseline.md`](./docs/srvf-foundation-baseline.md) 的全部规范(BizCode 段位、命名约定、响应包装、DTO 白名单、模块结构、错误码命名、配置归属、日志屏蔽、Guard、软删除、v1 兼容性、时区、验收门槛),**无需**逐任务重述。任务卡仅列任务**自身**的额外验收项;违反基线规范任一项视作越权,必须暂停并向用户说明(对应 baseline §14.2)。

### 5.1 任务总览

| 编号 | 标题 | 状态 | 前置 |
|---|---|---|---|
| **V2-D1** | 输出 `docs/srvf-foundation-research.md`(研究文档) | ✅ 已完成(初稿通过评审) | 无 |
| **V2-D2** | 同步追加 `ARCHITECTURE.md §12` | ✅ 已完成(本批次) | V2-D1 |
| **V2-D3** | 同步追加 `CLAUDE.md §18` / `AGENTS.md §18` | ✅ 已完成(本批次) | V2-D1 |
| **V2-D4** | 同步追加 `TASKS.md` V2 设计任务卡(本节) | ✅ 已完成(本批次) | V2-D1 |
| **V2-D5** | 调研访谈与资料收集(用户主导) | 🟡 访谈工具已交付,等待用户访谈回填(commit `c18db59`) | V2-D1..D4 |
| **V2-D6** | 输出 `docs/srvf-foundation-data-model-draft.md`(候选模型草案) | 🟡 起草中(commit `308ce5a`) | V2-D5 阶段性产出 |
| **V2-D7** | 模型评审会 — 逐模型决议(实现 / 延后 / 砍掉) | ⏳ 待启动 | V2-D6 |
| **V2-D8** | 设计阶段终点 — 决定是否进入开发立项 | ⏳ 待启动 | V2-D7 |

#### A 档基建快车道(与 V2-D5..D8 并行,详见 §5.5)

| 编号 | 标题 | 状态 | 前置 |
|---|---|---|---|
| **A1** | 新增 `src/common/prisma/soft-delete.util.ts` 纯函数 helper + 单元测试 | ✅ 已完成(commit `d8fd444`) | V2-D2..D4 完成 + baseline §10.2 锁定 |
| **A2** | 日志屏蔽清单代码侧扩展(`src/bootstrap/logger-options.ts` `redact` 配置) | ✅ 已完成(commit `3c61dfa`) | V2 默认预屏蔽,后续新增敏感字段仍按 baseline §8.4 与 schema 同批次或先于维护 |
| **A3** | `biz-code.constant.ts` 加段位映射 JSDoc 注释 | ⏸️ 暂缓 | 等首次新增 V2 BizCode 时同 commit 联动 |
| **A4** | V2 通用命名 / DTO / Swagger / Guard / 验收 代码侧"适配" | ❌ 不做 | v1 已按 baseline 实现,无需"适配" |
| **A5** | 其他公共工具(时间格式化 / 字典查询 helper 等)预先抽象 | ❌ 不做 | YAGNI;真有第二个使用方时单独立项 |

### 5.2 任务卡

#### V2-D1 输出 `docs/srvf-foundation-research.md`(研究文档)

- **状态**:✅ 已完成
- **产出**:研究文档初稿 → 1 轮小修 → 评审通过,作为 V2 设计阶段的边界文档冻结
- **验收(已满足)**:用户对研究文档 §3 / §4 / §5 / §6 / §7 五节逐项确认无遗留意见

#### V2-D2 同步追加 `ARCHITECTURE.md §12`

- **状态**:✅ 已完成(本批次)
- **范围**:在 `ARCHITECTURE.md` 末尾追加 §12,仅包含"V2 派生项目方向"声明,**不**包含 schema / 字段 / API 路径 / 实施顺序
- **验收(已满足)**:
  - 不动 `ARCHITECTURE.md §1-§11`
  - §12 内容仅引用 `docs/srvf-foundation-research.md`,不重复罗列具体清单
  - 显式声明"派生项目专属"+"不破坏模板仓 freeze"

#### V2-D3 同步追加 `CLAUDE.md §18` / `AGENTS.md §18`

- **状态**:✅ 已完成(本批次)
- **范围**:V2 调研 / 设计阶段约束,**非执行约束**;两份文档对齐
- **验收(已满足)**:
  - 不动 `CLAUDE.md §1-§17` / `AGENTS.md §1-§17`
  - §18.1 列硬禁止清单(行为级)
  - §18.2 列设计期内容禁止(草案表达级)
  - §18.3 列设计期表达要求(措辞级)
  - §18.4 列协作纪律
  - §18.5 列工具链约束(Claude / 通用 agent 各一版本)
  - §18.6 列"顺手做"反模式
  - §18.7 列解除时机

#### V2-D4 同步追加 `TASKS.md` V2 设计任务卡

- **状态**:✅ 已完成(本批次,即本节)
- **范围**:仅设计阶段任务,**不含**任何开发任务
- **验收(已满足)**:
  - 任务名不得出现"实现 / 创建 / migration / service / controller / E2E / Swagger / Seed 落地"等执行词
  - 终点显式指向"是否进入开发立项",不是"完成开发"

#### V2-D5 调研访谈与资料收集(用户主导)

- **状态**:🟡 **访谈工具已交付,等待用户访谈回填**(commit `c18db59`,2026-05-07)
- **前置**:V2-D1..D4 全部完成
- **执行主体**:**用户主导**,AI 仅做信息整理与文档回填
- **调研项**(对应研究文档 §4 待调研清单):
  - V2-D5.1 真实组织结构形态(层级深度 / 是否多树根 / 是否跨树移动)— 研究文档 §4.1
  - V2-D5.2 队员等级 / 资质体系形态(取值数量级 / 互斥关系 / 是否需要历史)— §4.2
  - V2-D5.3 敏感信息合规口径(身份证 / 紧急联系人 / 医疗信息的存储与访问规则)— §4.3
  - V2-D5.4 历史 / 版本化需求(是否需要 / 粒度 / 真实使用场景)— §4.4
  - V2-D5.5 一人多部门形态(常态 / 例外 / 是否区分主部门)— §4.5
  - V2-D5.6 events 模型承载范围(救援 / 训练 / 会议 / 公益活动 / 考核 字段差异)— §4.6
  - V2-D5.7 历史数据迁移需求是否存在(仅记录,不评估方案)— §4.7
  - V2-D5.8 字典是否需要"类型元数据"(决定双表 vs 单表)— §4.8
  - V2-D5.9 附件元数据归属模式(多态外键 vs 业务表自挂 vs 多对多)— §4.9
- **产出**:每项调研结论以 `已确认 / 当前倾向 / 待调研(延后) / 暂不做` 四档之一回填到研究文档 §4 对应小节
- **验收**:
  - 9 项 [待调研] 全部有阶段性结论或显式延后
  - 任何"我现在还不能定"的项标注为"延后到 V2.x"或"延后到草案评审中讨论",**不留白**
- **红线**:
  - 调研结果**不**直接写进 `ARCHITECTURE.md §12` 或 `CLAUDE.md §18` / `AGENTS.md §18`
  - 真实的部门名 / 等级取值 / 字典内容**不进**公共仓库 — 见研究文档 §5.1 与 §7-R13
- **当前进展**(2026-05-07):
  - **已新增** [`docs/srvf-foundation-interview-brief.md`](./docs/srvf-foundation-interview-brief.md)(commit `c18db59`,450 行)— 18 题轻量访谈版,设计为"被访谈人 20 分钟以内能答完",覆盖 9 个 [待调研] 项中的 8 个(§4.7 历史数据迁移略去,因 `research.md §3.15` 已锁定 V2 不做导入工具)
  - `docs/srvf-foundation-research-questions.md` 已起草完整 9 节(共 82 题),作为**详细版工具文档**保留为 Untracked,**不进** git history;轻量版与详细版的关系见 `interview-brief.md §3.1` 题目映射表
  - **当前状态**:🟡 **访谈工具已交付,等待用户实际访谈**
  - **历史轨迹**:
    - 早期阶段:用户决定优先推进 §5.5 A 档快车道(已交付 A1 / A2),曾标 ⏸️ 暂停
    - 现阶段:V2-D6 草案骨架(commit `308ce5a`)已就位,需要 D5 调研结论才能从骨架演进到 v0.1;轻量访谈版作为快速路径于 commit `c18db59` 交付
  - **下一步依赖**:**用户与救援队负责人 / 队委 / 部门骨干的实际访谈**
  - **访谈完成后回填路径**(对应 `interview-brief.md §1.4` / §3.3):
    - (a) 按 📌 标签把答案翻译为 `research.md §4.x` 的"调研结论"段
    - (b) 把 `data-model-draft.md §3.x.5` / §3.x.8 / §6.x 的 [待调研] / "缺结论时处理"替换为已采用结论
    - (c) 跨模型模式(`data-model-draft.md §4`)按联动标签更新
  - **回填后 D6 可演进**:草案骨架(commit `308ce5a`)→ v0.1 含调研结论 → 评审 → v1.0 锁定 → 进入 D7 模型决议
  - **若访谈仍受阻,可启用回退路径**:每个 D6 候选模型有"不回答时 D6 默认处理"(见 `data-model-draft.md §6` 与 `interview-brief.md` 各题 📌 标签),按默认推进的代价是各模型只能进入"最小骨架",不会得到形态优化

#### V2-D6 输出 `docs/srvf-foundation-data-model-draft.md`(候选模型草案)

- **状态**:🟡 **起草中**(commit `308ce5a`,非评审通过版)
- **前置**:V2-D5 至少完成 §4.1 / §4.5 / §4.6 / §4.8 / §4.9 五项(决定模型形态的关键调研)
- **范围**:候选模型草案,每个模型必须带 6 维标签([稳/研][赖][敏][史][先])与"待确认清单"
- **草案应覆盖的 10 个候选模型**(顺序 ≠ 优先级,顺序 ≠ 实施顺序):
  1. dict_types / dict_items
  2. organizations(组织树)
  3. users(沿用 v1)+ 与 members 关联方案讨论
  4. members(队员主表)
  5. member_profiles(扩展资料)
  6. member_departments(关系中间表)
  7. attachments(通用附件元数据)
  8. audit_logs(审计)
  9. events(通用事件 — 含回退三档讨论)
  10. event_participants(参与关系 — 可能延后或砍掉)
- **草案应覆盖的 4 个跨模型模式**:
  - 字典使用模式(双表 vs 单表 + 回退条件)
  - 软删除模式(逐表评估)
  - 审计日志写入模式(显式 vs 拦截器 + 回退条件)
  - 附件归属模式(多态外键 vs 业务表自挂 vs 多对多)
- **验收**:
  - 10 个候选模型全部带 6 维标签
  - 4 个跨模型模式各列**至少 1 个备选方案 + 回退条件**
  - 不出现 Prisma DSL / API 路径 / 最终 ER 图 / 真实救援队字典内容
  - 与研究文档 §3 / §6 无冲突;若有冲突,先回到研究文档评审
- **红线**:草案禁止"实现 / 创建 / 落表"措辞;只允许"形态 / 候选 / 待确认 / 风险"措辞
- **当前进展**(2026-05-07):
  - **已新增** [`docs/srvf-foundation-data-model-draft.md`](./docs/srvf-foundation-data-model-draft.md)(commit `308ce5a`,1014 行)
  - **当前状态**:🟡 **草案骨架已交付,非评审通过版**
  - **已交付内容**:
    - §0-§1 文档定位 + 6 维标注体系
    - §2 9 个候选模型的标签速览总览表
    - §3 9 个候选模型逐节展开(每模型 8 子项模板)
    - §4 6 个跨模型模式(字典引用 / users-members 关联 / 软删 / 审计 / 附件归属 / events 回退三档)
    - §5 baseline 锁定内容清单(24 项,不再重复讨论)
    - §6 D5 调研依赖列表式
    - §7 版本与下一步 + 附录 A 草案完成度自检表
  - **下一步依赖**:**D5 调研结论回填**(至少 §4.1 / §4.5 / §4.6 / §4.8 / §4.9 五项),目前 V2-D5 处于 ⏸️ 暂停状态
  - **下一步流程**:D5 阶段性结论回填 → 草案 v0.1 → v1.0 评审通过 → 进入 D7 模型决议
  - **禁止**(承接草案 §0.3 / §7.3):**不得**据此直接开发 schema / migration / API / V2 业务模块 controller/service/dto;开发阶段以 D8 决议为准

#### V2-D7 模型评审会 — 逐模型决议

- **状态**:⏳ 待启动
- **前置**:V2-D6 完成
- **产出**:对 10 个候选模型逐个标记 `进入 V2 / 延后到 V2.x / 砍掉`,把决议写进草案文档对应小节
- **验收**:
  - 10 个候选模型全部有决议(无悬空)
  - 4 个跨模型模式全部拍板单一方案(可以是"暂时保留双方案对比",但需写明触发选边的条件)
  - 草案文档进入"冻结"状态,后续修改需走变更说明
- **红线**:评审通过≠开发启动;V2-D7 完成后仍**禁止** schema / migration / 模块代码动作

#### V2-D8 设计阶段终点 — 决定是否进入开发立项

- **状态**:⏳ 待启动
- **前置**:V2-D7 完成
- **决策项**:
  - 是否升级 `ARCHITECTURE.md §12` 为带 schema 的开发蓝图(新增 §12.7+ 子节)
  - 是否新建 `docs/v2-plan.md` / `docs/v2-data-model.md` / `docs/v2-api-contract.md` 三份开发级文档
  - 是否在 `TASKS.md` 新增 `## 6. V2 — srvf-nest-api 基础数据底座(开发阶段)` 区块
  - 是否在 `CLAUDE.md` / `AGENTS.md` 新增 §19 V2 开发执行约束
- **可能的决议**:
  - **A. 进入开发** → 启动以上 4 类产物,V2-D8 关闭,V2 设计阶段任务卡冻结
  - **B. 延后开发** → 维持设计阶段产物,记录"延后原因 + 重启条件",V2-D8 标记延后
  - **C. 范围调整** → 回到 V2-D6 草案文档增删模型,重新走 V2-D7 评审
- **红线**:V2-D8 结论必须由用户拍板,AI 不自行判定;无论结论是 A / B / C,**禁止**在结论拍板前启动任何代码 / schema 动作

### 5.3 通用执行 checklist(适用 V2-D2..D7 任意文档型任务)

每次 V2 设计阶段任务开始前 / commit 前,逐项过一遍:

- [ ] 本次动作仅修改文档,未修改 `src/**` / `prisma/**` / `test/**` / `package.json` / `pnpm-lock.yaml` / `Dockerfile` / `docker-compose.yml` / `.github/workflows/**`
- [ ] 本次动作未运行 `pnpm add` / `prisma migrate` / `prisma db push` / `prisma generate` / 任何 seed 写入
- [ ] 文档措辞使用四档标签(已确认 / 当前倾向 / 待调研 / 暂不做),无模糊措辞
- [ ] 涉及救援队真实信息(部门名 / 等级 / 字典内容)的内容**未**进入公共仓库历史
- [ ] 与研究文档 §3 / §6 无冲突;若发现冲突,已先回到研究文档评审
- [ ] commit 仅含文档变更,message 前缀为 `v2-design: <章节> <简述>`

### 5.4 范围外的统一处理

V2 设计阶段任务执行过程中遇到任何"看起来该顺手做"的事项(不论是代码、schema、依赖、测试、新文档),**全部**走以下流程:

1. **暂停**,不要先实现 / 不要先写
2. 在与用户的对话里声明:这件事在 V2 设计阶段范围外,具体属于:
   - `CLAUDE.md §18.1` / `AGENTS.md §18.1` 的哪条硬禁止?
   - `CLAUDE.md §18.2` / `AGENTS.md §18.2` 的哪条内容禁止?
   - 研究文档 §3 的哪条暂不做项?
3. 由用户决定:
   - **a. 写入研究文档 §4 待调研项**(若需要进一步调研)
   - **b. 等待 V2-D6 草案阶段处理**(若属于模型形态决策)
   - **c. 等待 V2-D8 / 后续开发阶段处理**(若属于实现层动作)
   - **d. 直接放弃**(若不需要)

**禁止**未经用户确认就动作。这是 V2 设计阶段最容易破口的地方,与 V1.1 §4 的纪律一致。

---

### 5.5 A 档 — V2 基建快车道(与 V2-D5..D8 并行)

#### 5.5.0 范围与边界

A 档快车道源自 [`docs/srvf-foundation-baseline.md`](./docs/srvf-foundation-baseline.md) 锁定的"完全不依赖业务调研"的通用基建,与 V2-D5..D8 设计阶段任务**并行而非替代**。

**A 档允许做的**:

- ✅ 基线规范代码侧落地(纯函数 helper 等)
- ✅ 与业务调研结果**完全无关**的内部基建
- ✅ 新建 `src/common/<新子目录>/` 中的纯工具文件

**A 档禁止做的**(违反任一视作越权):

- ❌ 绕过 D6/D7 引入业务表 / Schema / 业务模块 controller/service/dto
- ❌ 实现研究文档 §3 任一暂不做项
- ❌ 在没有 D5 调研结果支撑下决策业务模型字段集
- ❌ 修改 v1 已交付 src/(`auth/` / `users/` / `health/` / `config/` / `common/` 已有文件 / `database/` / `bootstrap/`)— 这是 `CLAUDE.md §18.1` 的硬禁止,**新建** `src/common/<子目录>` 不算修改既有

**A 档存在意义**:让 V2 在调研周期内仍能稳步推进**不依赖业务结论**的基建,而**不**为快进 D6/D7 而牺牲设计纪律。

#### 5.5.1 A 档任务总览

(见 §5.1 末尾的 A 档表格,本节不重复)

#### 5.5.2 任务卡

##### A1 新增 `src/common/prisma/soft-delete.util.ts` 纯函数 helper

- **状态**:✅ 已完成
- **commit**:`d8fd444` `chore: add soft-delete pure-function util`
- **交付**:
  - `src/common/prisma/soft-delete.util.ts`(22 行,导出 `notDeletedWhere<T>`)
  - `src/common/prisma/soft-delete.util.spec.ts`(61 行,8 个单元测试)
- **形态铁律对照**:baseline §10.2.2(纯函数;**不**引入 class / `@Injectable` / Prisma middleware / client extension / BaseRepository / 装饰器 / Pipe / Guard / Interceptor)
- **影响**:零 — 未接入任何 service,v1 接口契约不变,Prisma schema / migration / package 全部不动
- **验收(已满足)**:
  - `pnpm lint` ✅(0 warnings / 0 errors)
  - `pnpm typecheck` ✅(tsc src + tsc test 双段无错)
  - `pnpm test` ✅(3 suites / 119 tests,新 spec 8 测全过)
  - `pnpm test:e2e` ✅(19 suites / 162 tests,v1 零退化)
  - `pnpm test:contract` 不需要(不涉及 OpenAPI)

##### A2 日志屏蔽清单代码侧扩展

- **状态**:✅ 已完成
- **commit**:`3c61dfa` `chore: extend log redact paths for V2 sensitive fields`
- **解锁路径**:用户在 A4 批次评估中显式许可触碰 `src/bootstrap/`(`CLAUDE.md §18.1` 列入禁止区);经评估**字段尚未落表 → 屏蔽规则提前加无害**(pino redact 路径不命中即跳过,零运行时副作用),baseline §8.4 同时允许"先于"字段落表,故采用"防御性预扩展"路径
- **交付**:
  - `src/bootstrap/logger-options.ts`(+62 / -1):在 v1 既有 16 项 redact paths 之上**追加** 7 个分类共 39 个 V2 字段(个人身份证 / 联系方式 / 医疗健康 / 财务防御 / 地址 / 出生信息 / 第三方账号与凭证)
  - `src/bootstrap/logger-options.spec.ts`(+153,新建):58 个静态断言测试,覆盖 v1 既有项保留 + V2 39 字段就位 + 整体属性(无重复 / 无空 / `censor === '[REDACTED]'`)
- **形态铁律对照**:baseline §8.2(屏蔽清单分类)+ baseline §8.4(修订纪律 — "字段不存在时无害,字段一旦落表自动生效")
- **关于子串通配规则**:baseline §8.2 提到的 `secret` / `credential` / `private` / `pwd` 子串通配,**pino `redact.paths` 不支持**;本次仅枚举具体字段名,源码注释中已显式声明此局限;子串约定继续作为团队规范由 code review 守护
- **验收(全过)**:
  - `pnpm lint` ✅(0 errors)
  - `pnpm typecheck` ✅(双段无错)
  - `pnpm test` ✅(4 suites / 177 tests,新 spec 58 测全过)
  - `pnpm test:e2e` ✅(19 suites / 162 tests,v1 零退化)
  - `pnpm test:contract` 不适用(redact 不影响 OpenAPI schema)
  - B 档启动验证 ✅:`pnpm start:dev` 1 秒就绪 / `GET /api/health/live` HTTP 200 / `GET /api/docs-json` HTTP 200(32 KB)/ 启动日志无 redact 解析错误 / SIGTERM 优雅关闭(2 秒内端口释放)
- **不影响范围**(零变更):Prisma schema / migration / seed / `package.json` / v1 14 接口契约 / v1 16 项原 redact paths / logger 行为架构 / 全局中间件注册 / Guard / Pipe / 拦截器
- **后续维护**:再有敏感字段进入 schema 时,仍**必须**按 baseline §8.4 在**同批次或先于** schema commit 维护本清单(见 §5.5.4)

##### A3 `biz-code.constant.ts` 加段位映射 JSDoc 注释

- **状态**:⏸️ 暂缓
- **范围**:在文件顶部加 baseline §1.1 总段位映射的 JSDoc 注释(**不改任何代码值**)
- **暂缓原因**:
  - 仍触碰 v1 src/(虽只加注释,仍属修改 v1 已交付文件)
  - 价值低 — 段位映射在 baseline §1.1 已锁,代码内不重复登记不影响开发
  - 真新增 V2 BizCode 时本就要打开此文件,届时一并做更经济
- **解锁条件**:首次有 V2 模块需要在 `biz-code.constant.ts` 新增 BizCode 时,**与该新增同 commit** 完成注释扩展
- **不独立立项**:同 A2

##### A4 V2 通用命名 / DTO / Swagger / Guard / 验收 代码侧"适配"

- **状态**:❌ 不做
- **原因**:这些规则在 baseline §2 / §3 / §4 / §6 / §7 / §9 / §13 中是"约定 / 政策";v1 / V1.1 代码已按相同政策实现(全局 `ValidationPipe` / `ResponseInterceptor` / `AllExceptionsFilter` / `@ApiWrappedXxx` 三装饰器 / Guard 全局注册 / `IdParamDto` 等)。V2 新模块按规范写即可,**无需**专门"适配"。
- **何时复活**:除非未来发现 v1 实现与 baseline 政策出现实质偏差(届时按 v1 §6 接口兼容性优先,以 baseline 让步)。

##### A5 其他公共工具(时间格式化 / 字典查询 helper 等)预先抽象

- **状态**:❌ 不做
- **原因**:无现有使用方,过早抽象违反 YAGNI。任何公共工具应"先有第二个使用场景,再抽公共"。
- **何时复活**:某 V2 业务模块开发时发现需要的工具与已有 helper 形态相近,**且至少有两个使用方**,才抽公共;单使用方继续放在该模块内。

#### 5.5.3 与 V2-D5..D8 的关系

- **A 档不绕过 D6/D7**:A 档只做"无 schema、无业务模块"的基建;任何业务模型表设计仍走完整 D5 → D6 → D7 → D8
- **A 档不替代 D5 调研**:A 档不能用"先做基建"当借口跳过敏感字段 / 等级 / 组织结构的调研
- **A 档可在 D5 暂停期推进**:A1 已证明可行
- **A 档完成不触发 D8 升级**:A 档完成 ≠ "开发阶段开启";开发阶段仍以 D8 决议为准

#### 5.5.4 A2 / A3 解锁触发器

#### 5.5.4.1 A2 已提前完成(自 commit `3c61dfa`)

A2 已经以"防御性预扩展"路径完成 V2 默认预屏蔽,**不再**等待"首个敏感字段进入 schema"触发。

后续维护规则(承接 baseline §8.4):

| 后续场景 | 维护要求 |
|---|---|
| 新增敏感字段到任何 V2 schema | **必须**按 baseline §8.4 在**同批次或先于**该 schema commit 维护 `LOG_REDACT_PATHS` 清单与对应单元测试 |
| 重命名已屏蔽字段 | 同 commit 更新清单,旧名称防御性留置 |
| 删除已屏蔽字段 | 清单条目**保留**(防御性留置,避免后续误恢复字段时漏屏蔽) |
| 引入新类别敏感字段(生物特征 / 位置轨迹 / 图像内容描述等) | 必须扩展 baseline §8.2 分类 + 同 commit 扩展本清单 |

#### 5.5.4.2 A3 解锁触发器(未变)

A3 解锁的规则:**与 v1 src/ 改动同 commit 才有实质价值**。

| 触发场景 | 联动任务 |
|---|---|
| 首次新增 V2 模块的 BizCode | A3 联动(同 commit 加段位注释) |
| 其他"顺手做"反模式 | 暂缓,等独立任务 |

A1 / A2 已分别独立完成;A3-A5 中的 A3 仍要求**搭车**于业务任务,**不**独立立项;A4 / A5 标记"不做"维持。

#### 5.5.5 A 档执行 checklist

A 档任务**不**适用 §5.3 的"仅文档变更" checklist(A 档涉及代码)。改用以下:

- [ ] 本次动作严守 baseline §10.2.2 / §13 / 任务卡对应章节的形态铁律
- [ ] 不接入任何现有 service / controller / Prisma path(除非任务卡显式声明搭车)
- [ ] 不引入新依赖(`package.json` / `pnpm-lock.yaml` 不变)
- [ ] 不修改 `prisma/schema.prisma` / `migrations/` / `seed.ts`
- [ ] 不修改 v1 已交付 src/(`CLAUDE.md §18.1` 列出的禁止区)
- [ ] 跑 baseline §13 验收门槛对应档位:
  - 纯新增 src 文件且不接入任何运行路径 → 仅 A 档(`pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm test:e2e`;`pnpm test:contract` 仅当影响 OpenAPI 时跑)
  - 涉及全局中间件 / 拦截器 / Guard / Controller / Swagger → A + B 档
- [ ] commit message 前缀按性质区分:
  - 纯基础设施代码:`chore: <简述>`
  - V2 设计文档同步:`v2-design: <简述>`
  - 修复:`fix: <简述>`
