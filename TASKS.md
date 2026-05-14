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
| **V2-D5** | 调研访谈与资料收集(用户主导) | ✅ 已完成(commit `17486fe` / `92d7512`,访谈答案已回填 research.md §4 + 同步到 data-model-draft v0.2) | V2-D1..D4 |
| **V2-D6** | 输出 `docs/srvf-foundation-data-model-draft.md`(候选模型草案) | 🟡 v0.3 D7-min 决议版(commit `4333c31`,**非 D8 开发立项**) | V2-D5 阶段性产出 |
| **V2-D7** | 模型评审会 — 逐模型决议(实现 / 延后 / 砍掉) | ✅ **D7-min 已完成**(commit `4333c31`,4 进入 / 5 延后 / 0 砍掉) | V2-D6 |
| **V2-D8** | 设计阶段终点 — 决定是否进入开发立项 | ✅ **D8 立项文档完成(5/5),等待用户最后拍板进入 Step 1 开发** | V2-D7 |

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

- **状态**:✅ **已完成阶段性调研回填**(2026-05-07)
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
- **完成说明**(2026-05-07):
  - **轻量访谈工具就位**:commit `c18db59` 交付 [`docs/srvf-foundation-interview-brief.md`](./docs/srvf-foundation-interview-brief.md)(450 行,18 题),设计为"被访谈人 20 分钟以内能答完",覆盖 9 个 [待调研] 项中的 8 个(§4.7 历史数据迁移略去,因 `research.md §3.15` 已锁定 V2 不做导入工具)
  - **research.md §4 回填(Stage 1)**:commit `17486fe` 把用户 18 题访谈答案翻译为四档结论,逐节追加 `#### 4.x.X 调研结论(V2-D5 回填,2026-05-07)` 子段,原 [待调研] 正文与标签保留
  - **data-model-draft v0.2 同步(Stage 2)**:commit `92d7512` 把 D5 结论联动到草案 §3 / §4 / §6 — §3.x.9 D5 调研结论(9 处)+ §4 D5 联动(4 处)+ §6 D5 进展三档标记(9 处)+ §7.1 v0.2 版本行
  - `docs/srvf-foundation-research-questions.md`(详细版 82 题)继续 Untracked,作为**升级路径**保留;若后续需要更深入访谈可启用
  - **当前 D5 状态**:**已完成阶段性调研回填**;9 个候选模型从"骨架级"演进到"形态级有阶段性结论"
- **D5 结论速览**(详见 `research.md §4` / `data-model-draft.md §3.x.9`):
  - 组织结构:单根树 / 3 层不写死 / 支持增删改但不可改父级
  - 队员部门:一人一部门(路径 B 保留中间表 + 单归属约束)
  - 队员等级:约 9 类走字典,不保留等级历史
  - 离队档案:完整保留
  - 敏感信息:F1 / F2 / F3 三问业务侧已答,**[当前倾向 + 合规待确认] C2**
  - events:升级为"全做(档 a 升级版)",大类+子类,兼容人工录入考勤
  - 字典:双表当前倾向,dict_items 父子树形(类别总数 / 异质性仍待补)
  - 附件:队员 + 活动归属,单归属默认,多态外键
- **后续如有补充访谈,作为 v0.3 增量回填**:
  - 不影响当前 D5 阶段性完成状态
  - 走相同三阶段流程(回填 research.md → 同步 data-model-draft → 同步 TASKS.md)
  - 触发场景示例:D7 评审中发现新的待调研项 / 用户主动恢复详细版访谈 / 合规口径 / 部门具体名单录入

#### V2-D6 输出 `docs/srvf-foundation-data-model-draft.md`(候选模型草案)

- **状态**:🟡 **v0.3 D7-min 决议版**(commit `4333c31`,**非 D8 开发立项**)
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
- **演进轨迹**(2026-05-07):
  - **骨架版(v0.1)**:commit `308ce5a` 交付 `docs/srvf-foundation-data-model-draft.md` 初稿(1014 行) — 9 候选模型 + 6 跨模型模式 + baseline 锁定清单 + D5 依赖列表
  - **v0.2 含 D5 结论**:commit `92d7512` 同步 D5 访谈结论(基于 commit `17486fe` research.md §4 回填),改动 +344 / -16,文件总行数 1342:
    - §2 总览表 [先] 列升级为"当前倾向"
    - §3.x.9 D5 调研结论子段(9 处)
    - §4 跨模型模式 D5 联动(§4.1.6 / §4.2.5 / §4.5.5 / §4.6.4,4 处)
    - §6 D5 调研依赖列表三档进展标记(9 处)+ §6.X 整体速览表
    - §7.1 v0.2 版本行
  - **v0.3 D7-min 决议**:commit `4333c31` 同步 D7-min 决议(路线切换为"V2 第一阶段最小可开发版"),改动 +391 / -19,文件总行数 1714:
    - §2 总览表 [先(D7-min)] 列升级为最终决议
    - §3.x.10 D7-min 决议子段(9 处) — 4 进入模型锁定 schema 决策摘要 / 5 延后模型写明延后原因 + 复活路径
    - §4 跨模型模式 D7-min 联动(§4.1.7 / §4.2.6 / §4.3.4 / §4.4.5 / §4.5.6 / §4.6.5,6 处)
    - §6.Y D7-min 决议速览
    - §7.1 v0.3 版本行
- **当前 D6 状态**:🟡 **v0.3 D7-min 决议版**
  - 4 模型形态级方向 D7-min 已锁定:`dictionaries` / `organizations` / `members` / `member_departments`(进入 V2 第一阶段)
  - 5 模型 D7-min 已锁定延后:`member_profiles` / `attachments` / `audit_logs` / `events` / `event_participants`(全部延后到 V2.x,无砍掉)
  - **仍非 D8 开发立项**;V2 第一阶段进入开发由 D8 决议拍板
- **下一步**:
  - **V2-D8 决策**(用户拍板):是否升级 `ARCHITECTURE.md §12` 为开发蓝图(§12.7+);是否新建 `docs/v2-plan.md` / `docs/v2-data-model.md` / `docs/v2-api-contract.md`;是否在 `TASKS.md` 新增 §6 V2 开发阶段
  - 通过 D8 → V2 第一阶段开发启动(4 模型 + v1 `users.memberId` 可空外键追加)
- **明确禁止**(承接草案 §0.3 / §7.3 / §3.x.9 / §3.x.10 各模型尾注):
  - **不得**据此直接开发 schema / migration / API / V2 业务模块 controller / service / dto
  - **不得**因 v0.3 落地就把"V2 第一阶段进入"视为"已拍板开发"
  - **不得**绕过 D8 决策直接进入实施层
  - 开发阶段以 D8 决议为准

#### V2-D7 模型评审会 — 逐模型决议

- **状态**:✅ **D7-min 已完成**(commit `4333c31`,2026-05-07)
- **前置**:V2-D6 完成
- **路线**:**V2 第一阶段最小可开发版(D7-min)** — 用户拍板从原计划"完整 D7-1/D7-2/D7-3/D7-4 分批评审" → "最小可开发版一次拍板",理由:效率优先,先完成人员底座闭环;5 延后模型保留 V2.x 复活路径
- **9 模型最终决议**:
  - ✅ **进入 V2 第一阶段(4 个)**:`dictionaries` / `organizations` / `members` / `member_departments`
  - ⏸️ **延后到 V2.x(5 个)**:`member_profiles` / `attachments` / `audit_logs` / `events` / `event_participants`
  - ❌ **砍掉**:**无**(所有延后模型保留 BizCode 段位 + 形态级讨论作为 V2.x 起点)
- **D7-2 / D7-3 / D7-4 转为 V2.x 触发条件**:
  - 原计划 D7-2(members + member_departments):**已合并**到 D7-min,完成
  - 原计划 D7-3(member_profiles 合规专场):**转为 V2.x 触发** — 等合规材料补齐后启动
  - 原计划 D7-4(events + event_participants):**转为 V2.x 触发** — 等用户拍板需求后启动
- **产出**:草案 v0.3 D7-min 决议版(`docs/srvf-foundation-data-model-draft.md` commit `4333c31`)
  - §3.x.10 9 个模型决议子段就位
  - §4 6 个跨模型模式 D7-min 联动子段就位
  - §6.Y D7-min 决议速览就位
  - §7.1 版本表 v0.3 行就位
- **验收(已满足)**:
  - 9 个候选模型全部有决议(无悬空)
  - 4 进入模型锁定 schema 决策摘要(D-/O-/M-/MD- 编号)
  - 5 延后模型写明延后原因 + 复活路径
  - 草案进入"D7-min 决议版"状态(仍非 D8 开发立项)
- **红线**(沿用 + 强化):
  - 评审通过 ≠ 开发启动;**V2-D7-min 完成后仍禁止** schema / migration / 模块代码动作
  - **D8 仍需用户单独拍板**;不得因 D7-min 已完成就跳进 D8 / 跳进开发
  - 4 个跨模型模式全部拍板单一方案(可以是"暂时保留双方案对比",但需写明触发选边的条件)
  - 草案文档进入"冻结"状态,后续修改需走变更说明
- **红线**:评审通过≠开发启动;V2-D7 完成后仍**禁止** schema / migration / 模块代码动作

#### V2-D8 设计阶段终点 — 决定是否进入开发立项

- **状态**:✅ **立项文档完成,等待用户最终开发拍板**(2026-05-08)
- **前置**:V2-D7 完成 ✅
- **决议**:**A. 进入开发**(用户已拍板,5 份立项文档已就位)
- **已交付的 5 份立项产出物**:
  - **D8-1** `ARCHITECTURE.md §12.8-§12.11` V2 第一阶段开发蓝图 — commit `85cec75`
  - **D8-2** `docs/v2-plan.md` V2 第一阶段开发执行计划(7 步顺序 + 每步任务卡)— commit `bff9c93`
  - **D8-3** `docs/v2-data-model.md` 4 模型 + `users.memberId` 数据模型说明 — commit `af236f2`
  - **D8-4** `docs/v2-api-contract.md` 29 个 V2 接口契约草案 — commit `627eda5`
  - **D8-5** `TASKS.md §6` V2 第一阶段开发任务卡(本次同步 commit)— 见 §6
- **第一阶段开发范围(D7-min 锁定)**:
  - ✅ `dictionaries`(`dict_types` + `dict_items`)
  - ✅ `organizations`
  - ✅ `members`
  - ✅ `member_departments`
  - ✅ v1 `users.memberId` 可空外键追加
- **延后到 V2.x**(无砍掉):
  - ⏸️ `member_profiles`(合规未补)
  - ⏸️ `attachments`
  - ⏸️ `audit_logs`(V2.x 第一个增量)
  - ⏸️ `events`
  - ⏸️ `event_participants`
- **明确禁止**(D8 立项完成 ≠ 开发启动):
  - ❌ **未经用户最后拍板,不得修改 `prisma/schema.prisma`**
  - ❌ **不得生成 migration**
  - ❌ **不得新建 V2 controller / service / dto**(`src/modules/dictionaries/` / `organizations/` / `members/` / `member-departments/` 任一)
  - ❌ **不得写 seed 真实业务取值**(neutral-demo 也需 Step 2 启动后才写)
  - ❌ **不得开始 Step 1**(V2-D8 ✅ 仅表示立项文档就位;开发由用户单独拍板触发)
  - ❌ 不得据此跳过 §6 的 7 步开发顺序
  - ❌ 不得据此偷开发延后 5 模型
- **D8 关闭后下一步路径**:
  - 用户拍板"启动 V2 第一阶段开发" → 进入 §6 任务卡 Step 1
  - 用户拍板"延后开发" → §6 各 Step 维持 ⏳ 待启动;V2-D8 状态保持 ✅(立项档案)
  - 用户拍板"范围调整" → 回到 V2-D6 / D7-min 重新拍板;§6 任务卡可能需重新校对

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
- **A 档与 D5 解耦推进**:A 档不依赖 D5 业务调研结论,A1 已证明在 D5 任意阶段(暂停 / 进行中 / 已完成)均可独立推进
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

#### 5.5.4.3 V2.x 复活触发条件(D7-min 延后模型,自 commit `4333c31`)

D7-min 决议(§5.2 V2-D7)原将 5 个模型延后到 V2.x;复活触发条件如下,**任一即可启动对应延后模型的 V2.x 立项**:

> **当前状态**(v0.7.0 后):`audit_logs` 已作为 V2.x 第一个增量于 v0.7.0 局部启动(批次 6 经业务确认稿 + D6 评审 + 用户拍板 + PR #29 / PR #30 实施);**仍延后 4 个**:`member_profiles` / `attachments` / `events` / `event_participants`;`audit_logs` 剩余 22 处 `auditPlaceholder` 调用渐进迁移见 [`docs/V2红线与复活路径.md`](../docs/V2红线与复活路径.md) §4.1 C-1。

| 模型 | V2.x 复活触发条件 | 复活后流程 |
|---|---|---|
| `member_profiles` | **合规材料补齐**:永久保存敏感信息合规依据 + 数据最小化说明 + 退队最小化处理方案 + 医疗信息"紧急通知等"用途的更具体表述(应急联络 / 安全保障 / 出动风险参考) | 启动 D7-3 评审 → V2.x 开发立项 |
| `attachments` | 任一即可:(a) `member_profiles` 解锁(承载证件附件元数据);(b) `events` 解锁(承载活动现场照 / 纪要);(c) 用户拍板独立的"队员档案附件"需求 | 启动 D7 attachments 评审 → V2.x 开发立项 |
| `audit_logs` | **作为 V2.x 第一个增量启动**(无独立触发条件,跟随 V2.x 启动节奏);接入 V2 第一阶段已交付 4 模型的关键写操作(管理员状态变更 / 删除 / 角色变更 / 部门归属变更等) | ✅ **v0.7.0 第一波已实施**(`emergency-contacts` + `certificates` 8 处写操作 + 2 查询接口);剩余 22 处迁移见 `docs/V2红线与复活路径.md §4.1 C-1` |
| `events` | 用户拍板需求(救援队需要在系统中记录哪些类型的活动 / 事件成为强诉求) | 启动 D7-4 评审(对应原计划批次)→ V2.x 开发立项 |
| `event_participants` | **跟随 events 复活路径**(无独立触发条件) | 与 events 同批进 V2.x 开发立项 |

**所有延后模型保留**:

- BizCode 段位(baseline §1.1):`130xx`/`131xx`(attachments)/ `140xx`/`141xx`(audit_logs)/ `160xx`/`161xx`(member_profiles)/ `180xx`/`181xx`(events)/ `190xx`/`191xx`(event_participants)
- 草案 §3.x.1 - §3.x.10 形态级讨论作为 V2.x 起点
- D5 调研结论 + D7-min 决议作为 V2.x 起手时的"当前倾向"

**复活时的红线**(D7-min 已锁,V2.x 不再重新讨论):

- `member_profiles`:任何敏感字段进入实施层前**必须**走 `research.md §4.3` 三问 + 合规依据补全
- `events`:回退档"全做(档 a 升级版)"沿用;但**禁止**强行通用化做大宽表;**禁止**完整状态机引擎;**兼容人工录入考勤** + **报名考勤维持弱关联**
- `audit_logs`:不替代版本化;不读审计;`before/after` 快照写入前必须按 baseline §8 屏蔽
- `attachments`:**仅元数据,不实装 Provider**(沿用 `research.md §3.10`)
- 真实业务取值(部门名 / 等级名 / 字典内容)继续不进 git history(R13)

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

---

## 6. V2 — srvf-nest-api 第一阶段开发任务卡

> **状态**:V2-D8 立项已完成(5/5 产出物就位)+ memberNo 决议已纳入(2026-05-08;Q1=A / Q2=B-1 / Q3-Q9 全部锁定);**等待用户最后拍板**进入 Step 1 开发。
> **范围**:V2 第一阶段 4 模型 + `users.memberId` 可空外键追加 + `Member.memberNo` 业务唯一编号 + v1 `auth.service.ts` 登录查找扩展支持 memberNo 回退(D7-min + memberNo 决议锁定)。
> **依据**:`ARCHITECTURE.md §12.8-§12.11`(memberNo 决议后修订)/ `docs/v2-plan.md` v0.2 / `docs/v2-data-model.md` v0.2 / `docs/v2-api-contract.md` v0.2(含 §6.6 v1 登录路径 memberNo 回退查找)/ baseline(commit `16876fe`)。
> **解除条件**:Step 1-7 全部 ✅ 后,V2 第一阶段开发闭环;V2.x 启动需用户单独拍板(对应 §6.11)。

### 6.0 范围速读

> **V2 第一阶段 Step 1-7 已全部完成**(2026-05-08),进入维护者复核 / release 决策前状态。详细完成情况见 §6.2-§6.8 各 Step 的"完成情况"事实块。

本区块是 V2 第一阶段开发任务卡,**仅含 7 步开发任务**;**不含**:

- ❌ V2 设计阶段任务(已锁定在 §5)
- ❌ V2.x 后续阶段任务(待用户单独拍板)
- ❌ 任何延后模型(`member_profiles` / `attachments` / `audit_logs` / `events` / `event_participants`)的开发任务

> **范围说明**:上述"延后模型"清单是 D7-min 决议时刻(2026-05-07)的快照;`audit_logs` 已于 v0.7.0 作为 V2.x 第一个增量局部启动(经业务确认稿 + D6 评审 + 用户拍板),沿 `ARCHITECTURE.md §12.11.2`;当前仍延后的是 `member_profiles` / `attachments` / `events` / `event_participants` 共 4 个;`audit_logs` 剩余 22 处迁移见 [`docs/V2红线与复活路径.md`](../docs/V2红线与复活路径.md) §4.1 C-1。

**任何"看起来该顺手做"的事项**(包括延后模型、暂不做项、未登记新依赖等),按 §6.10 范围外统一处理流程,**禁止**未经用户确认就动作。

### 6.1 任务总览

| Step | 任务 | 状态 | 主要文件范围 | 前置 |
|---|---|---|---|---|
| **Step 1** | Prisma schema + migration | ✅ 已完成 (commit `36c0837`) | `prisma/schema.prisma` / `prisma/migrations/20260507181930_v2_foundation/` | **D8 用户最终拍板** |
| **Step 2** | seed neutral-demo | ✅ 已完成 (commit `53c9a03`) | `prisma/seed.ts` | Step 1 |
| **Step 3** | dictionaries 模块 | ✅ 已完成 (commit `33dbd69`) | `src/modules/dictionaries/` | Step 1-2 |
| **Step 4** | organizations 模块 | ✅ 已完成 (commit `da54cf3`) | `src/modules/organizations/` | Step 3 |
| **Step 5** | members 模块 + v1 users.memberId hook + v1 auth.service.ts 登录回退 | ✅ 已完成 (commits `1baa6c6` + `c8bc4fd`) | `src/modules/members/` + `src/modules/auth/auth.service.ts`(**唯一受限放开**;memberNo 登录回退查找;v1 users.service / dto 经评估**未改动**)| Step 3 |
| **Step 6** | member_departments 归属能力 | ✅ 已完成 (commit `54a14e0`) | `src/modules/member-departments/`(独立模块) | Step 4 + Step 5 |
| **Step 7** | E2E + contract + 文档收口 | ✅ 已完成 (commit `9f42a9a`) | `README.md` + `CHANGELOG.md`(snapshot Step 6 已锁定;TASKS.md §6 收尾走本 G commit) | Step 1-6 全部完成 |

**总览铁律**:Step 1 启动需用户**单独拍板**触发;**不得**因 V2-D8 ✅ 就跳进 Step 1。

### 6.2 Step 1 — Prisma schema + migration

- **状态**:✅ 已完成(commit `36c0837`,2026-05-08)
- **前置条件**:
  - V2-D8 ✅(已满足)
  - **用户单独拍板"启动 Step 1"**(待满足)
  - 工作树干净(无未 commit 改动)
- **允许改动**:
  - 新增 5 个 Prisma model:`DictType` / `DictItem` / `Organization` / `Member` / `MemberDepartment`
  - `Member` model 必含 `memberNo` 字段:String / 必填 / **普通全局唯一约束**(不用部分唯一索引;**包含软删记录全表唯一**,软删后不释放)/ 字段长度 1-32 / 字符集 `[A-Za-z0-9-]`(详见 `docs/v2-data-model.md §5.2-§5.3`)
  - 修改 v1 `User` model:**仅**追加可空 `memberId` 字段 + 关系到 `Member`(其他字段 / 索引 / 外键全部不动)
  - 生成 migration 文件(命名 `<timestamp>_v2_foundation` 或拆多个)
  - 跑 `pnpm prisma:generate` / `pnpm prisma:migrate dev`(本地)/ `pnpm prisma:deploy`(CI)
- **禁止改动**:
  - ❌ 不写任何业务代码(`src/modules/<v2-business>/` 不创建)
  - ❌ 不写 seed 业务数据(留 Step 2)
  - ❌ 不修改 `users.service.ts` / `users.dto.ts` / `users.controller.ts`(留 Step 5)
  - ❌ 不实装 5 个延后模型的 schema
  - ❌ 不修改 `docker-compose.yml` / 任何 config / env
  - ❌ 不修改 v1 14 接口契约
- **交付物**:
  - `prisma/schema.prisma` 改动(5 model 新增 + User 加 memberId)
  - `prisma/migrations/<timestamp>_*/migration.sql` 文件
  - Prisma client 重新生成
  - 本地 + CI 测试库迁移成功
- **验收命令**(对齐 baseline §13):
  - A 档:`pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm test:e2e`(v1 既有零退化)/ `pnpm test:contract`(OpenAPI 不变)
  - B 档:`pnpm start:dev` 服务启动 / `curl /api/health/live` / `curl /api/health/ready` / SIGTERM 优雅关闭
- **回滚风险**:
  - migration 反向需 `prisma migrate reset`(用户授权 Prisma 安全机制)
  - v1 表结构破坏:**风险极低**,因仅 ADD COLUMN(`users.memberId`)+ 新表,无 ALTER 既有字段
  - 回滚:`git revert <commit>` + `pnpm prisma migrate reset --force --skip-seed`(需用户授权)+ `pnpm prisma:deploy`
- **建议 commit message**:`chore(prisma): add V2 foundation schema (4 models + users.memberId)`
- **完成情况**(2026-05-08):
  - commit `36c0837` `chore(prisma): add V2 foundation schema (4 models + users.memberId)`
  - 交付:`prisma/schema.prisma` 改动 + `prisma/migrations/20260507181930_v2_foundation/migration.sql` 新增
  - 决策点 D-1 落地:migration 末尾手动追加 `MemberDepartment_memberId_active_key` partial unique index(`memberId` 在 `deletedAt IS NULL` 范围内唯一)
  - A 档全过:`pnpm lint` / `pnpm typecheck` / `pnpm test`(177 passed)/ `pnpm test:e2e`(19 suites / 162 tests v1 零退化)/ `pnpm test:contract`(29 tests / 2 snapshots OpenAPI 零漂移)
  - B 档全过:`pnpm start:dev` 启动成功 / `GET /api/health/live` 200 / `GET /api/health/ready` 200(`db: up`)/ `GET /api/health` v1 兼容 200 / SIGTERM 优雅关闭
  - 范围合规:仅触碰 `prisma/`,v1 `src/**` / `seed.ts` / `package.json` / Docker / CI / config 全部零改动
  - Step 2 仍 ⏳ 待启动,等用户单独拍板触发

### 6.3 Step 2 — seed neutral-demo

- **状态**:✅ 已完成(commit `53c9a03`,2026-05-08)
- **前置条件**:Step 1 完成
- **允许改动**:
  - 修改 `prisma/seed.ts`,**追加** 2 类字典类型 neutral-demo seed(节点类别 / 队员等级)
  - 占位 items(neutral-demo 抽象值,如 `demo-type-1` / `demo-grade-1`)
  - seed 必须**幂等**(跑两次结果一致)
- **禁止改动**:
  - ❌ 不写真实部门类别名(具体业务上的部门 / 小组 / 编组类别取值)
  - ❌ 不写真实等级名(具体业务上的等级 / 资质取值)
  - ❌ 不预填业务数据(无 organizations / members / member_departments seed)
  - ❌ 不修改 SUPER_ADMIN seed 逻辑
  - ❌ 不写 5 延后模型的 seed
  - ❌ seed 不强制 SUPER_ADMIN 绑 member(`memberId` 默认 null)
- **交付物**:
  - `prisma/seed.ts` 改动(neutral-demo 字典 seed 追加)
  - 跑两次 `pnpm prisma:seed` 幂等校验通过
- **验收命令**:
  - A 档:`pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm test:e2e` / `pnpm test:contract`
  - B 档:`pnpm prisma:seed` 跑两次幂等 + `pnpm start:dev` 启动
- **回滚风险**:`git revert <commit>` + `pnpm prisma:seed`(回到上一版 seed 状态);风险**极低**
- **建议 commit message**:`chore(seed): add V2 foundation neutral-demo dict seed`
- **完成情况**(2026-05-08):
  - commit `53c9a03` `chore(seed): add V2 neutral demo dictionary seeds`
  - 交付:`prisma/seed.ts` 改动(+88/-21);新增 `V2_DICT_SEED` 常量 + `seedV2Dictionaries()` 函数;SUPER_ADMIN 控制流 `return` → `if/else`,确保 SUPER_ADMIN 已存在时仍续跑字典 seed(创建逻辑代码零改动)
  - type code 决议(B-2):`node_type` + `member_grade`(snake_case 命名风格对齐);Step 2 commit 时 `docs/v2-plan.md §2.2` 草案与实施 dict_type code 的差异已通过 housekeeping 同步至 `member_grade`
  - 数据清单:dict_types = 2(`node_type` / `member_grade`)+ dict_items = 4(每类 2 个 `demo-*` 抽象占位,全部 `parentId = null` 顶层、`status = ACTIVE`、`sortOrder` 0/1)
  - 幂等策略:`upsert` + `update: {}` 不覆盖运营运行时手动调整;两次 `pnpm prisma:seed` 后 dict_types / dict_items 行数不变
  - A 档全过:`pnpm lint` / `pnpm typecheck` / `pnpm test`(177 passed)/ `pnpm test:e2e`(19 suites / 162 tests v1 零退化)/ `pnpm test:contract`(29 tests / 2 snapshots OpenAPI 零漂移)
  - B 档全过:`pnpm prisma:seed` 跑两次幂等(输出一致 + SQL 验证 dict_types = 2 / dict_items = 4)/ `pnpm start:dev` 启动成功 / `GET /api/health/live` 200 / `GET /api/health/ready` 200(`db: up`)/ SIGTERM 优雅关闭
  - 范围合规:仅触碰 `prisma/seed.ts`,schema / migration / `src/**` / `package.json` / Docker / CI / config / env 全部零改动
  - Step 3 仍 ⏳ 待启动,等用户单独拍板触发

### 6.4 Step 3 — dictionaries 模块

- **状态**:✅ 已完成(commit `33dbd69`,2026-05-08)
- **前置条件**:Step 1-2 完成
- **允许改动**:
  - 新建 `src/modules/dictionaries/` 4 文件(`module.ts` / `controller.ts` / `service.ts` / `dto.ts`)
  - 实施 dict_types + dict_items 双表 CRUD(对照 `docs/v2-api-contract.md §2`,13 接口)
  - dict_items 父子树形查询能力
  - 启停 / 软删显式封装(用 `notDeletedWhere` helper)
  - BizCode 段位 `120xx + 121xx`(对齐 baseline §1.1)
  - Swagger 100% 覆盖 + DTO 白名单
  - e2e 测试覆盖(`test/e2e/dictionaries.e2e-spec.ts`)
  - OpenAPI 契约快照更新(`pnpm test:contract -u`)
- **禁止改动**:
  - ❌ 不写真实字典内容(seed 真实取值)
  - ❌ 不开发 organizations / members / member_departments(留 Step 4-6)
  - ❌ 不开发 5 延后模型
  - ❌ 不接入 audit_logs(audit_logs 已延后)
  - ❌ 不实现字典缓存(沿用 v1 §1 不主动加缓存)
  - ❌ 不实现复杂查询(全文搜索 / 多语言 / metadata 高级查询等)— 仅基础 CRUD
  - ❌ RBAC / permission 表 / casl 等权限框架(沿用 v1 §1)
  - ❌ 批量导入导出
- **交付物**:
  - 4 文件模块就位
  - 13 接口契约一致(对照 v2-api-contract.md §2)
  - Swagger 100% 覆盖 / DTO 白名单 / 软删显式封装
  - BizCode 新增条目按段位 `120xx + 121xx`
  - e2e 覆盖典型成功 / 错误路径
  - OpenAPI 契约快照更新
- **验收命令**:
  - A 档:`pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm test:e2e`(v1 + V2 dictionaries)/ `pnpm test:contract -u`(快照更新后通过)
  - B 档(必跑):`pnpm start:dev` / `curl /api/docs` Swagger UI / `curl /api/docs-json` / dict_types 列表接口 spot check / 错误路径 spot check / SIGTERM
- **回滚风险**:`git revert <commit>` 模块整体撤回;schema 不动(Step 1 已固化)
- **建议 commit message**:`feat(dictionaries): add V2 foundation dictionaries module`
- **完成情况**(2026-05-08):
  - commit `33dbd69` `feat(dictionaries): add V2 foundation dictionaries module`
  - 交付:5 新文件(`dictionaries.module.ts` / `dictionaries.dto.ts` / `dictionaries.service.ts` / `dictionaries.controller.ts` + `test/e2e/dictionaries.e2e-spec.ts`)+ 5 改动(`app.module.ts` 注册 / `biz-code.constant.ts` +9 / `test/contract/openapi.contract-spec.ts` + snapshot / `test/setup/reset-db.ts` 扩 TRUNCATE);共 10 files / +4528 / -2
  - 4 文件铁律:`dictionaries.controller.ts` 单文件双 @Controller 类(DictTypesController + DictItemsController),严格符合 CLAUDE.md §2 / baseline §5.1
  - 13 接口落地:`/api/v2/dict-types` 6 + `/api/v2/dict-items` 7(含 `/tree` 在 `/:id` 之前定义防 first-match 冲突)
  - 5 决策点落地:① DELETE 引用查 dict_items + organizations.nodeTypeCode + members.gradeCode(Step 4-5 后无需补)/ ② 不登记 121xx FORBIDDEN_MANAGE_DICTIONARY / ③ DictItemTreeNodeDto 独立类 / ④ tree 深度无限制 / ⑤ 引用检查 + 软删事务原子性
  - 9 条新 BizCode(120xx + 121xx 段;dict_type=12001-12002/12030,dict_item=12010-12014/12031)
  - 软删显式封装:`notDeletedWhere` helper / 唯一性预检查 `findUnique` 包含软删 / P2002 兜底转 BizCode
  - A 档全过:`pnpm lint` / `pnpm typecheck` / `pnpm test`(4 suites / 222 tests,v1 177 + 新增 45 = BizCode 9 × 5 断言)/ `pnpm test:e2e`(20 suites / 197 tests,v1 162 零退化 + V2 35)/ `pnpm test:contract`(51 tests / 2 snapshots,v1 29 + V2 22)
  - B 档全过:`pnpm start:dev` / `GET /api/docs` 200 / `/api/health/live` 200 / `/api/health/ready` 200(`db: up`)/ `/api/v2/dict-types` 未登录 401(UNAUTHORIZED)/ `/api/docs-json` 含 v1 10 paths + V2 7 paths / SIGTERM 优雅关闭
  - v1 14 接口 OpenAPI schema + paths **零漂移**:用 inline node 脚本逐个 schema(11 项)/ path(10 项)严格字符串相等比对,全部 OK
  - 范围合规:仅触碰 `src/modules/dictionaries/` + `src/app.module.ts` + `src/common/exceptions/biz-code.constant.ts` + `test/`(基建 + e2e + contract);schema / migrations / seed / users / auth / health / database / bootstrap / config / package / Docker / CI 全部零改动
  - Step 4 仍 ⏳ 待启动,等用户单独拍板触发

### 6.5 Step 4 — organizations 模块

- **状态**:✅ 已完成(commit `da54cf3`,2026-05-08)
- **前置条件**:Step 1-3 完成(依赖字典 nodeTypeCode)
- **允许改动**:
  - 新建 `src/modules/organizations/` 4 文件
  - 实施树形 CRUD(对照 `docs/v2-api-contract.md §3`,7 接口)
  - 树形查询(按 parentId 拼接子树)
  - 新增 / 编辑 / 停用 / 软删
  - parentId 创建时设置(可空 = 根节点)
  - **PATCH 严禁改 parentId**:DTO 白名单不含;业务码 `ORGANIZATION_PARENT_CHANGE_FORBIDDEN`
  - nodeTypeCode 走字典(联动 §6.4 字典模式;创建 / 更新时 service 层校验存在性 + status=ACTIVE)
  - 节点撤销:启停 status + 防御性 deletedAt
  - BizCode 段位 `110xx + 111xx`
  - Swagger 100% 覆盖 + DTO 白名单 + 软删显式封装
  - e2e 测试覆盖
- **禁止改动**:
  - ❌ 改父级(D7-min O-1 锁定)
  - ❌ 临时编组(D7-min O-4 锁定延后)
  - ❌ 节点负责人 / 简介 / 联系方式 / 内部编号 等扩展属性(D7-min O-5 锁定延后)
  - ❌ 跨部门小组(D7-min O-4 锁定延后)
  - ❌ 真实部门名(seed neutral-demo,真实取值由运营录入;R13 红线)
  - ❌ 不接入 audit_logs(已延后)
- **交付物**:
  - 4 文件模块就位
  - 7 接口契约一致
  - 树形查询能力
  - nodeTypeCode 字典 code 校验
  - 启停 + 软删 + BizCode 段位 + Swagger / e2e / OpenAPI 快照
- **验收命令**:
  - A 档:同 §6.4
  - B 档(必跑):`pnpm start:dev` + Swagger + 树形查询 spot check + 不可改父级 spot check + SIGTERM
- **回滚风险**:同 §6.4(模块整体可 revert)
- **建议 commit message**:`feat(organizations): add V2 foundation organizations module`
- **完成情况**(2026-05-08):
  - commit `da54cf3` `feat(organizations): add V2 foundation organizations module`
  - 交付:5 新文件(`organizations.module.ts` / `organizations.dto.ts` / `organizations.service.ts` / `organizations.controller.ts` + `test/e2e/organizations.e2e-spec.ts`)+ 5 改动(`app.module.ts` 注册 / `biz-code.constant.ts` +9 / `test/contract/openapi.contract-spec.ts` + snapshot / `test/setup/reset-db.ts` 扩 TRUNCATE);共 10 files / +2738 / -1
  - 4 文件铁律严格符合 CLAUDE.md §2 / baseline §5.1
  - 7 接口落地:`GET /api/v2/organizations`(列表;`?parentId=null` 字面值过滤根)/ `GET /tree`(在 `:id` 之前定义;深度无限制)/ `POST` / `GET/PATCH/DELETE /:id` / `PATCH /:id/status`
  - 8 决策点全部按修订执行:① CYCLE/PARENT_CHANGE_FORBIDDEN 登记备用 ② 不登记 FORBIDDEN_MANAGE_ORGANIZATION ③ 引用查 organizations.parentId + member_departments.organizationId(Step 6 后无需补) ④ **单根上限不区分 status**(`deletedAt=null` 即占位) ⑤ last-root 保护两场景(DELETE 根 + PATCH status=INACTIVE 根)⑥ `'node_type'` 模块内常量化 ⑦ OrganizationTreeNodeDto 独立类(沿用 dictionaries) ⑧ DTO @IsString + service 转换字面值
  - 9 条新 BizCode(110xx + 111xx 段位):11001 NOT_FOUND / 11010 PARENT_NOT_FOUND / 11011 NODE_TYPE_INVALID / 11012 PARENT_CYCLE / 11013 PARENT_CHANGE_FORBIDDEN(后两条 DTO 兜底登记备用)/ 11030 HAS_CHILDREN / 11031 HAS_MEMBERS / 11032 ROOT_ALREADY_EXISTS / 11103 LAST_ROOT_PROTECTED
  - nodeTypeCode 6 项 AND 校验:`dict_type.code='node_type'` + `status=ACTIVE` + `deletedAt=null` + `dict_item.code=nodeTypeCode` + `status=ACTIVE` + `deletedAt=null`(N:1 关系 filter 一次查询完成)
  - 软删显式封装:`findFirst + notDeletedWhere`(详情查询禁 `findUnique`);引用检查 + 软删全部包在 `prisma.$transaction`(决策 5 修订)
  - PATCH 严格白名单:`UpdateOrganizationDto` 仅 `name / sortOrder / nodeTypeCode`,**绝对不含** `parentId`(D7-min O-1 红线);e2e `PATCH 拒绝 parentId(forbidNonWhitelisted)` 测试覆盖
  - A 档全过:`pnpm lint` / `pnpm typecheck` / `pnpm test`(4 suites / 267 tests,222 + 新增 45 = 9 BizCode × 5 断言)/ `pnpm test:e2e`(21 suites / 225 tests,v1 162 零退化 + dict 35 零退化 + org 28)/ `pnpm test:contract`(63 tests / 2 snapshots)
  - B 档全过:`pnpm start:dev` / `GET /api/docs` 200 / `/api/health/live` 200 / `/api/health/ready` 200(`db: up`)/ `/api/v2/organizations` 未登录 401(UNAUTHORIZED)/ `/api/docs-json` v1 10 paths + V2 11 paths(dict 7 + org 4) / SIGTERM 优雅关闭
  - v1 14 接口 + Step 3 dictionaries OpenAPI schema + paths **零漂移**:用 inline node 脚本逐个 schema(v1 11 + dict 9 = 20 项)/ path(v1 10 + dict 7 = 17 项)严格字符串相等比对,全部 OK
  - 范围合规:仅触碰 `src/modules/organizations/` + `src/app.module.ts` + `src/common/exceptions/biz-code.constant.ts` + `test/`(基建 + e2e + contract);schema / migrations / seed / users / auth / health / dictionaries / database / bootstrap / config / package / Docker / CI 全部零改动
  - **后续 housekeeping(不阻塞 Step 4)**:
    - `ORGANIZATION_ROOT_ALREADY_EXISTS` message 措辞后续可优化为"系统已存在根节点"或"系统已存在未软删除根节点"(当前措辞"活跃根节点"与实现 `deletedAt=null` 不区分 status 略有歧义)
    - Step 6 落地 `MemberDepartment` 真实归属数据后,统一检查 `test/setup/reset-db.ts` TRUNCATE 顺序(当前依赖 PostgreSQL CASCADE 自动级联,Step 6 后建议显式列入)
  - Step 5 仍 ⏳ 待启动,等用户单独拍板触发

### 6.6 Step 5 — members 模块

- **状态**:✅ 已完成(commits `1baa6c6` + `c8bc4fd`,2026-05-08)
- **前置条件**:Step 1-3 完成(依赖字典 gradeCode)
- **允许改动**:
  - 新建 `src/modules/members/` 4 文件
  - 实施 members CRUD(对照 `docs/v2-api-contract.md §4`,6 接口);含 `memberNo` 全生命周期:
    - POST 创建 memberNo 必填 + 弱约束校验(`@MinLength(1)` / `@MaxLength(32)` / `@Matches(/^[A-Za-z0-9-]+$/)`)
    - 入库前 `trim()` 保留原大小写
    - 唯一性预检查走 `findUnique` 包含软删记录;撞约束抛 `MEMBER_NO_ALREADY_EXISTS`(150xx,409)
    - GET 列表支持 `?memberNo=<exact>` 精确查询
    - GET 详情 + POST/PATCH 响应 MemberResponseDto 必返 memberNo
    - **UpdateMemberDto 白名单不含 memberNo**(forbidNonWhitelisted 自动拒绝 PATCH 改编号)
  - **修改 v1 `src/modules/users/users.service.ts`** 追加 `memberId` 字段处理逻辑(仅服务侧;v1 接口出参不变)
  - **修改 v1 `src/modules/users/users.dto.ts`**(若 Step 5 决定 v1 接口可选返回 `memberId`,需显式说明 + 更新 OpenAPI 快照;**默认不改**)
  - ⚠️ **受限放开** 修改 v1 `src/modules/auth/auth.service.ts`:**唯一**允许的扩展是登录查找路径加 `memberNo` 回退查找(对应 ARCHITECTURE.md §12.8.2.4 + `docs/v2-api-contract.md §6.6` 全部硬约束):
    - 账号枚举相关失败场景防护(响应体 / HTTP status / Timing 完全一致;详见 `docs/v2-api-contract.md §6.6.3`)
    - 强制扩展 dummy bcrypt 到新路径
    - 通过 `PrismaService` 直读 `member` 表
    - 禁止 import `MembersModule` / `MembersService` / V2 BizCode
    - 复用 `LOGIN_FAILED = 10004`,**禁止**自创新业务码
  - gradeCode 走字典(联动 §6.4)
  - status 切换:`ACTIVE` ↔ `INACTIVE`(独立接口 `PATCH /:id/status`)
  - BizCode 段位 `150xx + 151xx`(新增 `MEMBER_NO_ALREADY_EXISTS` 等)
  - `assertCanManageMember` Service 层显式校验(沿用 v1 §13)
  - Swagger 100% 覆盖 + DTO 白名单 + 软删显式封装
  - e2e 覆盖管理员路径 + 角色边界 + memberNo CRUD + memberNo 登录回退账号枚举相关失败场景(详见 `docs/v2-api-contract.md §6.6.3`)+ Timing 抽样 + **v1 接口零退化** + **v1 LoginDto schema 零漂移**
- **禁止改动**:
  - ❌ **任何敏感字段**(身份证 / 紧急联系人 / 医疗 / 出生日期 / 住址 / 性别 / 联系方式 等)— DTO 白名单严格拒绝
  - ❌ 不在 members 主表挂 `organizationId`(完全走 §6.7 member_departments)
  - ❌ 不在 v1 `UserResponseDto` 出参中**新增必返**字段(`memberId` / `memberNo` 默认不返回);**禁止**默认改成可选返回 memberNo(对齐 memberNo 决议 Q7;前端展示 memberNo 走 V2 members 接口)
  - ❌ **不**修改 v1 `auth.controller.ts` / `auth.dto.ts`(LoginDto 字段名 / 类型 / 校验装饰器 / 路径全保留;HTTP 契约零漂移)
  - ❌ **不**修改 v1 `auth/strategies/*`(JwtStrategy 等)
  - ❌ 不修改 v1 `health/` / `bootstrap/` / `database/prisma.service.ts`
  - ❌ 不实现 member_profiles(已延后)
  - ❌ 不实现资质维度(D5 未触及,延后)
  - ❌ 不实现"用户绑定/解绑 member"接口(留 V2.x)
  - ❌ 不开发"改 memberNo"独立接口(留 V2.x 评估)
  - ❌ 不为 memberNo 登录路径自创业务码(必须复用 v1 `LOGIN_FAILED`)
  - ❌ auth.service **禁止** import `MembersModule` / `MembersService` / V2 BizCode 段位常量
- **交付物**:
  - 4 文件模块就位
  - v1 `users.service.ts` 追加 memberId 处理(v1 接口契约不变)
  - v1 `auth.service.ts` 登录查找扩展(memberNo 回退 + dummy bcrypt 扩展;HTTP 契约 / OpenAPI schema 零漂移)
  - 6 接口契约一致(含 memberNo 入参 / 出参 / 查询 / 错误码)
  - gradeCode 字典 code 校验
  - status 切换 + 软删显式封装
  - `assertCanManageMember` Service 层校验
  - Swagger / e2e / OpenAPI 快照(V2 新接口加入;v1 14 接口含 LoginDto schema 全部不漂移)
- **验收命令**:
  - A 档:同 §6.4,**重点验证 v1 14 接口零退化 + v1 LoginDto schema 零漂移**
  - B 档(必跑):
    - `pnpm start:dev`
    - v1 `POST /api/auth/login`(username 登录)→ 200,响应不含 memberId / memberNo
    - v1 `POST /api/auth/login`(memberNo 登录,新功能)→ 200,响应 schema 与 username 登录完全一致
    - v1 `POST /api/auth/login` 账号枚举相关失败场景防护(输入值两路径均未命中 / member 未绑 user / 账号禁用或软删 / 密码错)→ 401 + LOGIN_FAILED 10004,响应体 / 耗时一致
    - v1 `GET /api/users/me` → 200,响应不含 memberNo
    - V2 `GET /api/v2/members` → 200(管理员)+ 详情含 memberNo / 403(USER)
    - V2 `GET /api/v2/members?memberNo=<value>` → 200 + 精确匹配
    - V2 `POST /api/v2/members`(无 memberNo / 撞唯一)→ 400 / 409
    - V2 `PATCH /api/v2/members/:id { memberNo: '...' }` → 400(forbidNonWhitelisted)
    - `pnpm test:contract` 严格证明 v1 LoginDto schema diff = 0
    - SIGTERM 关停
- **回滚风险**:
  - `git revert <auth-commit>` 单独撤回 auth(因强制拆 2 commit,可独立回滚)
  - `git revert <members-commit>` 单独撤回 members CRUD
  - 两 commit 独立可回滚;e2e 护栏护住回归
- **建议 commit message**(memberNo 决议:**强制拆 2 commit**,见 `docs/v2-plan.md §2.5` commit message 段全文):
  - Commit 1:`feat(members): add memberNo to member lifecycle`(members CRUD + v1 users.memberId hook)
  - Commit 2:`feat(auth): support memberNo login fallback`(auth.service.ts 登录回退;**仅含此一处文件改动 + 配套 e2e + 快照对比**;**严禁**与 members CRUD 揉合)
- **完成情况**(2026-05-08):
  - **强制拆 2 commit**(ARCHITECTURE.md §12.8.2.4 / docs/v2-plan.md §2.5 / CLAUDE.md §17 红线;严禁揉合;独立可 revert):
    - **Commit 1** `1baa6c6` `feat(members): add memberNo to member lifecycle`(10 files / +2299 / -1)
      - 文件范围:`src/app.module.ts` / `src/common/exceptions/biz-code.constant.ts` / `src/modules/members/`(4 文件)/ `test/contract/openapi.contract-spec.ts` + snapshot / `test/e2e/members.e2e-spec.ts` / `test/setup/reset-db.ts`
      - **不含**:`auth.service.ts` / `auth-memberno-login.e2e-spec.ts`
    - **Commit 2** `c8bc4fd` `feat(auth): support memberNo login fallback`(2 files / +273 / -10)
      - 文件范围:`src/modules/auth/auth.service.ts` / `test/e2e/auth-memberno-login.e2e-spec.ts`
      - **不含**:members / contract / biz-code / app.module / reset-db
  - members 6 接口落地:`GET /api/v2/members`(列表 + memberNo 精确查询 + gradeCode/status 过滤)/ `POST`(memberNo 必填全局唯一不复用)/ `GET/:id` / `PATCH/:id`(白名单仅 displayName/gradeCode)/ `PATCH/:id/status` / `DELETE/:id`(SA 专属 + active dept + linked user 引用拒删)
  - memberNo 全生命周期:DTO `@Matches(/^[A-Za-z0-9-]+$/)` + `@MinLength(1)` + `@MaxLength(32)` + service `trim()` 保留大小写 + `findUnique` 包含软删唯一性预检查(不复用)+ P2002 兜底转 `MEMBER_NO_ALREADY_EXISTS` + PATCH 严禁改 memberNo(forbidNonWhitelisted 兜底)
  - gradeCode 6 项 AND 校验:`dict_type.code='member_grade'` + `status=ACTIVE` + `deletedAt=null` + `dict_item.code=gradeCode` + `status=ACTIVE` + `deletedAt=null`(N:1 关系 filter 一次查询);`MEMBER_GRADE_DICT_CODE` 模块内常量化
  - **auth.service.ts memberNo 登录回退**(唯一受限放开):
    - 服务端查找路径扩展(对应 `docs/v2-api-contract.md §6.6.2`):username 未命中 → trim 后(原大小写)按 memberNo 在 member 表 `findUnique` → 含全表手动 `deletedAt === null` 过滤 → 反查 `users.memberId` 找 user
    - 严守红线:`LoginDto` schema 0 改动 / `LoginResponseDto` schema 0 改动 / `LOGIN_FAILED = 10004` 复用(**禁止**自创业务码)/ Timing dummy bcrypt 强制扩展到 memberNo 路径 / `PrismaService` 直读 member,**禁止** import `MembersModule`/`MembersService`/V2 BizCode(防 v1→V2 循环依赖)/ 不改 `auth.controller.ts`/`auth.dto.ts`/`auth/strategies/*`
    - 账号枚举防护 4 场景全部统一抛 `LOGIN_FAILED`(响应体 / HTTP / message 完全一致)
  - **v1 users.memberId hook 评估结果**:本步**未改** `src/modules/users/users.service.ts` / `users.dto.ts` — v1 14 接口契约不需要 memberId 字段(对齐 §12.8.2.1 红线 + memberNo 决议 Q7);`users.memberId` 关联完全由 schema 字段(Step 1 已建)+ V2 members 模块独立维护;用户绑定/解绑接口留 V2.x,运营当前通过 DB 直改(B 档 spot check 已验证)
  - 5 条新 BizCode(150xx 段位;**不登记** `FORBIDDEN_MANAGE_MEMBER`):15001 NOT_FOUND / 15002 MEMBER_NO_ALREADY_EXISTS / 15010 GRADE_CODE_INVALID / 15030 HAS_ACTIVE_DEPARTMENT / 15031 HAS_LINKED_USER
  - 软删显式封装(baseline §10):`findFirst + notDeletedWhere`(详情查询禁 `findUnique`)+ 引用检查 + 软删事务原子(`prisma.$transaction`);软删 = `update({ deletedAt, status: INACTIVE })`,**不**自动解除 user 绑定 / **不**自动解除 active dept
  - **`LoginDto` / `LoginResponseDto` / `UserResponseDto` 严格 zero drift**(memberNo 登录回退是纯 service 层扩展,无 DTO/schema 变化)
  - A 档全过:`pnpm lint` / `pnpm typecheck` / `pnpm test`(4 suites / 292 tests,267 + 新增 25 = 5 BizCode × 5 断言)/ `pnpm test:e2e`(23 suites / 263 tests,v1 162 零退化 + dict 35 + org 28 + members 25 + memberNo login 13)/ `pnpm test:contract`(73 tests / 2 snapshots)
  - B 档全过:`pnpm start:dev` / `GET /api/docs` 200 / `/api/health/live` 200 / `/api/health/ready` 200(`db: up`)/ v1 `POST /api/auth/login`(username/admin)200 / v1 `GET /api/users/me` 出参**不含** memberId/memberNo / `POST /api/v2/members` 含 memberNo 不含 deletedAt / DB 直改绑定 admin.memberId / `POST /api/auth/login`(memberNo `demo-spot-001`)200 + accessToken / 账号枚举 3 场景全部 `LOGIN_FAILED 10004` 同 message / `/api/docs-json` v1 10 + V2 14 paths(dict 7 + org 4 + members 3) / SIGTERM 优雅关闭
  - **v1 + dict + org zero drift**:严格 inline node 比对 v1 11 + dict 9 + org 5 = 25 schemas + v1 10 + dict 7 + org 4 = 21 paths 全部 OK(commit 1 重生成 snap 后即冻结;commit 2 不改 snap)
  - 范围合规:仅触碰 `src/modules/members/` + `src/modules/auth/auth.service.ts`(唯一受限放开)+ `src/app.module.ts` + `src/common/exceptions/biz-code.constant.ts` + `test/`(基建 + e2e + contract);schema / migrations / seed / users.service / users.dto / users.controller / auth.controller / auth.dto / auth/strategies / health / database / bootstrap / config / package / Docker / CI 全部零改动
  - Step 6 仍 ⏳ 待启动,等用户单独拍板触发

### 6.7 Step 6 — member_departments 归属能力

- **状态**:✅ 已完成(commit `54a14e0`,2026-05-08)
- **前置条件**:Step 1-5 完成
- **允许改动**:
  - 部门归属接口(对照 `docs/v2-api-contract.md §5`,3 接口;路径**嵌套**在 `members/:memberId/department/`)
  - 实施位置:`src/modules/member-departments/` **或**作为 `src/modules/members/` 的子能力(由 Step 6 实施时按 NestJS 路由组织决定)
  - 查询当前正式部门 / 设置 / 更换 / 解除
  - **单归属唯一约束**:`(memberId)` 在 `deletedAt = null` 范围内唯一
  - PUT 幂等单事务(已有归属 → 软删旧 + 创建新)
  - BizCode 段位 `170xx + 171xx`
  - 错误码:`MEMBER_DEPARTMENT_NOT_FOUND` / `MEMBER_DEPARTMENT_ALREADY_EXISTS` / `MEMBER_INACTIVE` / `ORGANIZATION_INACTIVE`
  - Swagger / DTO 白名单 / 软删显式封装
  - e2e 覆盖一人一部门约束 / 软删后重新归属 / 跨实体引用
- **禁止改动**:
  - ❌ 一人多部门能力(D7-min MD-6 锁定不做)
  - ❌ 引入 `isPrimary` / `joinedAt` / `endedAt` / 进出原因 字段(D7-min MD-5 锁定不引入)
  - ❌ 跨部门角色 / 等级独立性(默认全队统一)
  - ❌ 部门归属变更历史保留(D5 Q18 ② 锁定不保留)
  - ❌ 不接入 audit_logs(已延后)
- **交付物**:
  - 3 接口契约一致
  - 单归属唯一约束业务规则(部分唯一索引或全局约束 + 业务规则)
  - 软删时旧记录由 deletedAt 区分,新归属不撞约束
  - BizCode 段位 / Swagger / e2e / OpenAPI 快照
- **验收命令**:
  - A 档:同 §6.4
  - B 档:`pnpm start:dev` + 一人一部门约束 spot check(尝试给同一 member 挂两个部门 → 应失败) + SIGTERM
- **回滚风险**:`git revert <commit>`;Prisma 部分唯一索引若不支持需降级路径(详见 `v2-data-model.md §6.3`)
- **建议 commit message**:`feat(member-departments): add V2 foundation member-departments capability`
- **完成情况**(2026-05-08):
  - commit `54a14e0` `feat(member-departments): add V2 foundation member-departments capability`
  - 交付:5 新文件(`member-departments.module.ts` / `member-departments.dto.ts` / `member-departments.service.ts` / `member-departments.controller.ts` + `test/e2e/member-departments.e2e-spec.ts`)+ 5 改动(`app.module.ts` 注册 / `biz-code.constant.ts` +4 / `test/contract/openapi.contract-spec.ts` + snapshot / `test/setup/reset-db.ts` 显式加 MemberDepartment);共 10 files / +1379 / -1
  - 4 文件铁律严格符合 CLAUDE.md §2 / baseline §5.1;**独立模块** `src/modules/member-departments/`(非 members 子能力)
  - 3 接口落地(嵌套在 `members/:memberId/` 下,单数 'department' 表达一人一部门):
    - `GET /api/v2/members/:memberId/department`(无归属返 `data: null`)
    - `PUT /api/v2/members/:memberId/department`(幂等设置;同 org 直接返回不更新;不同 org 软删旧 + 创建新单事务)
    - `DELETE /api/v2/members/:memberId/department`(软删;无归属抛 `MEMBER_DEPARTMENT_NOT_FOUND`)
  - 4 条新 BizCode(170xx 段位;**不登记** `FORBIDDEN_MANAGE_MEMBER_DEPARTMENT`):17001 NOT_FOUND / 17002 ALREADY_EXISTS(并发兜底)/ 17030 MEMBER_INACTIVE / 17031 ORGANIZATION_INACTIVE;复用 `MEMBER_NOT_FOUND` (15001) / `ORGANIZATION_NOT_FOUND` (11001)
  - 8 决策点全部按方案落地:① 独立模块 ② BizCode 17001-17031 ③ 不登记 FORBIDDEN_* ④ GET 无归属返 null ⑤ PUT 同 org 幂等无副作用(直接返回现归属,id / 时间戳不变) ⑥ TRUNCATE 顺序显式 `User, MemberDepartment, Organization, Member, DictItem, DictType` ⑦ DELETE Swagger 复用 `MemberDepartmentResponseDto` ⑧ **P2002 兜底不解析 target,任意 P2002 统一转 `MEMBER_DEPARTMENT_ALREADY_EXISTS`**(因 partial unique index 是 Step 1 migration.sql 末尾手动追加,Prisma client target 不可靠)
  - PUT 不同 org:软删旧 + 创建新在同一 `prisma.$transaction` 原子完成,防撞 partial unique
  - 软删显式封装(baseline §10):`findFirst + notDeletedWhere`(详情查询禁 `findUnique`);引用检查 + 软删事务原子;软删 = `update({ deletedAt })`
  - 单归属约束实施:Step 1 migration 末尾手动追加 partial unique index `MemberDepartment_memberId_active_key ON ("memberId") WHERE "deletedAt" IS NULL` 在 DB 层兜底;e2e 验证直接 DB create 第二条 active → P2002 拒绝,软删后再 PUT 同 org → 创建新归属不撞
  - `test/setup/reset-db.ts` housekeeping 落地(对应 Step 4 完成情况记录的项):TRUNCATE 显式列入 `MemberDepartment`(不再依赖 PostgreSQL CASCADE 自动级联)
  - A 档全过:`pnpm lint` / `pnpm typecheck` / `pnpm test`(4 suites / 312 tests,292 + 新增 20 = 4 BizCode × 5 断言)/ `pnpm test:e2e`(24 suites / 282 tests,v1 162 零退化 + dict 35 + org 28 + members 25 + auth memberNo 13 + member-dept ~22)/ `pnpm test:contract`(78 tests / 2 snapshots)
  - B 档全过:`pnpm start:dev` / `GET /api/docs` 200 / `/api/health/live`/`/ready` 200 + `db: up` / `/api/v2/members/abc/department` 未登录 401 / `/api/docs-json` v1 10 + V2 15 paths(dict 7 + org 4 + members 3 + member-dept 1) / v1 admin login + GET 无归属 null + PUT 设置 200 + GET 有归属 + PUT 同 org 幂等 id 不变 + DELETE 200 + DELETE 再次 → `MEMBER_DEPARTMENT_NOT_FOUND` (17001) / SIGTERM 优雅关闭
  - **v1 + dict + org + members zero drift**:严格 inline node 比对 v1 11 + dict 9 + org 5 + members 4 = 29 schemas + v1 10 + dict 7 + org 4 + members 3 = 24 paths 全部 OK
  - 范围合规:仅触碰 `src/modules/member-departments/` + `src/app.module.ts` + `src/common/exceptions/biz-code.constant.ts` + `test/`(基建 + e2e + contract);schema / migrations / seed / `auth` / `users` / `health` / `dictionaries` / `organizations` / `members` 已有逻辑 / `database` / `bootstrap` / `config` / `package` / Docker / CI 全部零改动;一人多部门 / `isPrimary` / `joinedAt` / `endedAt` / 进出原因 / 部门变更历史 / `audit_logs` / 延后 5 模型 全部不引入
  - **后续 housekeeping(不阻塞 Step 6)**:e2e 间歇性 v1 `auth-login.e2e-spec.ts` `'nonexistentuser'` 收到 HTTP 404 而非 401(LOGIN_FAILED)现象;重跑稳定,与 Step 6 改动无关(未改 auth.service.ts 或全局中间件);可能根因 ThrottlerStorage 跨 spec 累计 / NestJS 路由初始化 race;作为独立 task 跟进
  - Step 7 仍 ⏳ 待启动,等用户单独拍板触发

### 6.8 Step 7 — E2E + contract + 文档收口

- **状态**:✅ 已完成(commit `9f42a9a`,2026-05-08)
- **前置条件**:Step 1-6 全部完成
- **允许改动**:
  - 全量 e2e 跑通(v1 + V2,确认全绿)
  - 契约快照锁定(`__snapshots__/openapi.contract-spec.ts.snap` 一并 commit)
  - 更新 `README.md` "必读文档" / 快速启动 等章节(加 V2 模块说明)
  - 更新 `CHANGELOG.md`:V2 第一阶段开发完成的发布说明
  - 更新 `TASKS.md §6` Step 1-7 标 ✅ 已完成 + V2-D8 二级状态收尾(可选标"已 ship")
  - 同步 `data-model-draft.md` v0.4(可选,标记 4 模型已实施;非必须)
  - **不**更新 `ARCHITECTURE.md §12.7+` 内容(蓝图级,已锁;状态由 TASKS.md 反映)
- **禁止改动**:
  - ❌ 新功能开发(本步纯收口)
  - ❌ schema 改动 / migration 改动
  - ❌ 范围扩张(任何 V2.x 模型 / 任何 v1 接口契约改动)
  - ❌ 修改 baseline / research / interview-brief / research-questions(已锁定)
- **交付物**:
  - 全量 e2e 通过(v1 162 + V2 新增 X 个,全部通过)
  - 契约快照锁定(43 接口 schema 全部稳定)
  - README / CHANGELOG / TASKS.md §6 Step 1-7 标 ✅ + V2-D8 收尾标记
  - V2 第一阶段 ship-readiness audit 通过
- **验收命令**(全跑):
  - A 档:`pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm test:e2e` / `pnpm test:contract` / `pnpm build`
  - B 档:`pnpm start:dev` + Swagger UI 完整含 v1 + V2 接口 + `/api/health/live` + `/api/health/ready` + v1 14 接口典型路径 spot check(全部 200 / 响应契约不变)+ V2 4 模块典型路径 spot check + SIGTERM
- **回滚风险**:本步纯收口;`git revert <commit>` 仅文档 / 快照,无代码运行时影响
- **建议 commit message**:`docs+test: V2 first-stage ship-ready (Step 7 wrap-up)`
- **完成情况**(2026-05-08):
  - F commit:`9f42a9a` `docs: V2 first-stage ship-ready (Step 7 wrap-up)`(2 files / +56)
  - 改动范围:`README.md`(+19;必读文档表追加 v2-plan / v2-data-model / v2-api-contract;路由总览追加 V2 第一阶段摘要表 5 行)+ `CHANGELOG.md`(+37;Unreleased 顶部追加 V2 First Stage 分组,列出 Step 1-6 全部 commit hash + 铁律 + 验收数字 + V2.x 复活路径 + 不在本阶段范围 + 非阻塞 housekeeping)
  - 仅文档收口,**不**改 src / prisma / test / TASKS / docs/v2-* / ARCHITECTURE / baseline / research / data-model-draft / package / Docker / CI / snapshot(Step 6 已锁定)
  - 表述纪律:用"V2 第一阶段开发已完成,等待维护者按需 release / tag",**未**写"全部最终完成 / 正式发布"过满表述
  - **A 档全过**:`pnpm lint` / `pnpm typecheck` / `pnpm test`(312 tests)/ `pnpm test:e2e`(24 suites / 282 tests,**两次连续稳定**,v1 162 零退化)/ `pnpm test:contract`(78 tests / 2 snapshots,**无 -u**,验证 snapshot 文件与 HEAD commit 一致)/ `pnpm build`(**首次跑过**,`dist/main.js` + `dist/app.module.js` 等产物完整生成)
  - **inline node zero drift 全量验证**:`Snapshot 文件与 HEAD 完全一致(无未 commit 漂移)` + 31 schemas + 25 paths 全部 present(v1 11+10 / dict 9+7 / org 5+4 / members 4+3 / member-dept 2+1)
  - **B 档全过**:`pnpm start:dev` / `GET /api/docs` 200 / `/api/health/live` 200 / `/api/health/ready` 200(`db: up`)/ `/api/docs-json` v1 10 + V2 15 paths(dict 7 + org 4 + members 3 + member-dept 1)/ v1 admin 登录 200 + token len=199 / `GET /api/users/me` 出参**不含** memberId / memberNo(zero drift)/ V2 spot check:`GET /api/v2/dict-types` 200 / `GET /api/v2/organizations/tree` 200 / `GET /api/v2/members` 200 / `PUT /api/v2/members/:id/department` 200 / `GET` 归属 200 + orgId 正确 / `DELETE` 归属 200 / SIGTERM 优雅关闭
  - **V2 第一阶段 Step 1-7 全部完成**(F + G commits 全部锁定):
    - Step 1 schema + migration:F=`36c0837` + G=`694a1fa`
    - Step 2 seed neutral-demo:F=`53c9a03` + G=`1189450`
    - Step 3 dictionaries:F=`33dbd69` + G=`411cad6`
    - Step 4 organizations:F=`da54cf3` + G=`88f9c1f`
    - Step 5 members + auth memberNo 回退:F=`1baa6c6` + `c8bc4fd` + G=`2782e82`
    - Step 6 member-departments:F=`54a14e0` + G=`2e7ecb4`
    - Step 7 ship-ready 收口:F=`9f42a9a` + G=本 commit
  - **后续 housekeeping**(已记录 CHANGELOG / 历次完成情况,**非阻塞**;**不在本 commit 处理**):
    - e2e 间歇性 v1 `auth-login.e2e-spec.ts` `'nonexistentuser'` 收到 HTTP 404 而非 401 现象(Step 7 两次连续 282/282 稳定,**未复现**;独立 task 跟进)
    - `ORGANIZATION_ROOT_ALREADY_EXISTS` message 措辞优化候选(当前"活跃根节点" vs 实现 `deletedAt=null` 不区分 status)
  - **不启动 V2.x**(member_profiles / attachments / audit_logs / events / event_participants 全部保留延后);**不启动 housekeeping**;V2.x 启动需用户单独拍板(对应 §6.11)

### 6.9 通用验收 checklist

每个 Step 完成前 / commit 前,**逐项过一遍**(对齐 baseline §13):

#### A 档(必跑)

- [ ] `pnpm lint`(0 warnings / 0 errors,`--max-warnings 0`)
- [ ] `pnpm typecheck`(tsc src + tsc test 双段无错)
- [ ] `pnpm test`(unit)
- [ ] `pnpm test:e2e`(v1 既有 162 tests + V2 新增 e2e;**v1 零退化是硬约束**)
- [ ] `pnpm test:contract`(若涉及 OpenAPI schema 变更,显式 `-u` 更新快照)

#### B 档(涉及全局行为 / v1 兼容性 / schema / API 时追加)

- [ ] `pnpm start:dev` 服务启动无错(关注 redact 解析 / migration apply / 路由注册等)
- [ ] `curl /api/health/live` → 200
- [ ] `curl /api/health/ready` → 200(DB 连通)
- [ ] `curl /api/docs` Swagger UI 完整含 v1 + V2 接口
- [ ] `curl /api/docs-json` OpenAPI JSON
- [ ] **抽查 v1 auth / users 关键接口**(`POST /api/auth/login` / `GET /api/users/me` / `GET /api/users/:id` 等典型路径)— 全部 200 + 响应契约不变
- [ ] **确认 OpenAPI v1 schema 不漂移**(snapshot diff 仅含新增 V2 / 不含 v1 字段变化;**`LoginDto` schema 严格零漂移**)
- [ ] (Step 5 必跑)v1 `POST /api/auth/login` 账号枚举相关失败场景防护(输入值在 username / memberNo 两条路径下均未命中 / memberNo 命中但未绑 user / 账号禁用或软删 / 密码错)— 响应体 / HTTP status / 耗时一致
- [ ] V2 新接口典型成功路径 + 典型错误路径(权限拒绝 / 资源不存在 / 业务校验失败 等)
- [ ] (Step 5 必跑)V2 members 接口 memberNo 校验:必填 / trim / 长度 / 字符集 / 全局唯一(撞软删历史抛 `MEMBER_NO_ALREADY_EXISTS`)/ PATCH 拒绝改 memberNo
- [ ] SIGTERM 优雅关闭

任一未通过 → **不算完成,不能 commit,不能向用户报告"任务完成"**(沿用 V1.1 §17.10 末尾纪律 + V2 §13)。

### 6.10 范围外的统一处理

V2 第一阶段开发期间遇到任何"看起来该顺手做"的事项,**全部**走以下流程:

1. **暂停**,不要先实现
2. 在与用户的对话里声明:这件事属于以下哪一类范围外:
   - `member_profiles` 任何字段 / 接口 / schema(合规未补)
   - `attachments` 任何元数据 / 上传 Provider / 业务挂载
   - `audit_logs` 任何接入 / 表创建(V2.x 第一个增量做)
   - `events` / `event_participants` 任何接口 / schema
   - **RBAC** / permission 表 / casl 任何权限框架
   - **上传 Provider** 实装(本地 / OSS / R2 任一)
   - **真实字典 seed**(部门类别 / 等级 / 活动类型 / 证书类型 任一具体取值)
   - **批量导入导出**(任何模块)
   - **通知系统**(短信 / 邮件 / 微信 / 企业微信 任一)
   - **统计报表 / BI / 数据大屏**
   - **任何敏感字段**(身份证 / 紧急联系人 / 医疗 / 出生 / 住址 / 性别 / 第三方账号 / 凭证 等)
   - **修改 v1 14 接口契约**(任何路径 / DTO / 错误码变化)
   - **修改 docker-compose.yml** / **修改 .github/workflows/**
   - **引入未登记新依赖**
3. 由用户决定:
   - **a. 写入 §6 已有 Step 内**(若属于已立项范围)
   - **b. 写入 §6.11 V2.x 复活触发条件**(若属于延后)
   - **c. 写入 V2.x 后续阶段独立任务卡**(若属于新需求)
   - **d. 直接放弃**(若不需要)

**禁止**未经用户确认就动作。这是 V2 第一阶段开发最容易破口的地方,纪律与 V1.1 §4 / V2 §5.4 一致。

**v1 兼容性红线下唯一已开口子**(自 memberNo 决议 2026-05-08):

- ⚠️ `src/modules/auth/auth.service.ts` 受限放开 — **唯一**允许的扩展是 memberNo 登录回退查找(详见 ARCHITECTURE.md §12.8.2.4 + `docs/v2-api-contract.md §6.6` + 本节 §6.6 Step 5)
- ❌ 任何**其他** v1 auth 文件改动(`auth.controller.ts` / `auth.dto.ts` / `strategies/*`)仍属范围外
- ❌ 任何想"再开第二个口子"的诉求(例如"顺手在 auth.service.ts 加 SSO 登录")必须按本节流程暂停 + 用户拍板,不得援引此唯一已开口子作为先例

### 6.11 V2.x 复活触发条件

V2 第一阶段开发完成 → **不自动**进入 V2.x;V2.x 启动需用户单独拍板。

D7-min 决议时刻锁定 5 个延后模型,V2.x 复活触发条件如下(指向 §5.5.4.3 完整版,本节简写):

> **当前状态**(v0.7.0 后):`audit_logs` 已局部启动;**仍延后 4 个**:`member_profiles` / `attachments` / `events` / `event_participants`。

| 模型 | V2.x 复活触发(简写) |
|---|---|
| `member_profiles` | **合规材料补齐**(详见 §5.5.4.3) |
| `attachments` | profiles 或 events 解锁 / 用户单独拍板附件需求 |
| `audit_logs` | ✅ **v0.7.0 第一波已实施**;剩余 22 处迁移属可复活项,见 [`docs/V2红线与复活路径.md`](../docs/V2红线与复活路径.md) §4.1 C-1 |
| `events` | 用户拍板需求(救援队需要在系统中记录哪些类型的活动 / 事件成为强诉求) |
| `event_participants` | **跟随 events** 复活路径 |

完整复活流程见 `TASKS.md §5.5.4.3`(D7-min 锁定的延后触发清单)。

---

## 7. V2.x C-6 RBAC(批次 8)

> **状态(2026-05-14 PR #9 docs 收口)**:🎯 **设计 + schema + CRUD + service + seed/bootstrap 全部完成**(PR #54-#61 实施 PR #1-#8 + 本 docs 收口 PR #9);docs 收口进行中;**bump version + v0.9.0 handoff 待用户授权启动**。
> **入口文档**:[`docs/批次8_RBAC_V2x立项记录.md`](docs/批次8_RBAC_V2x立项记录.md)
> **D7 v1.1 冻结**:PR #51 v1.0 → PR #53 v1.1 命名修订(squash commit `569771b`)
> **业务模块判权接入仍待后续批次**(0 处 `rbac.can()` 业务调用;14 RBAC CRUD 入口仍 `@Roles(SUPER_ADMIN, ADMIN)`)。

### 7.1 时间线(设计 + 立项 + 实施 + 收口)

| 阶段 | PR | squash commit | 状态 |
|---|---|---|---|
| 业务访谈提纲 | #46 | `1b33c4e` | ✅ |
| D6 业务确认稿 | #47 | `44e1326` | ✅ |
| D7 v0.1 草稿 | #48 | `b892a7e` | ✅ |
| D7 v0.2 局部收口 | #50 | `6d54ec3` | ✅ |
| D7 v1.0 冻结 | #51 | `b301da8` | ✅ |
| V2.x 立项 PR | #52 | `172b684` | ✅ |
| D7 v1.1 命名修订 | #53 | `569771b` | ✅ |
| 实施 PR #1 schema + migration | #54 | `88cb4d1` | ✅ |
| 实施 PR #2 Permission CRUD | #55 | `6ff55b6` | ✅ |
| 实施 PR #3 RbacRole CRUD | #56 | `edcb91e` | ✅ |
| 实施 PR #4 RolePermission + cache skeleton | #57 | `0d50c99` | ✅ |
| 实施 PR #5 UserRole CRUD + Q7 + ops-admin 保护 | #58 | `affc1e8` | ✅ |
| 实施 PR #6 RbacService + me/permissions + memberId | #59 | `46664c7` | ✅ |
| 实施 PR #7 reload endpoint | #60 | `6de6f64` | ✅ |
| 实施 PR #8 seed/bootstrap | #61 | `43db185` | ✅ |
| **PR #9 docs 收口** | 本 PR | — | 🔄 **本 PR** |
| PR #10 bump version 0.8.0 → 0.9.0 | 待启动 | — | ⏳ 等用户授权 |
| PR #11 v0.9.0 handoff | 待启动 | — | ⏳ 等用户授权 |

### 7.2 决议锁定

25 项决议全部 🔒 v1.0 冻结 + v1.1 命名修订(B 3 + D 12 + F 10)。详见 [`docs/批次8_RBAC_API前评审.md §18`](docs/批次8_RBAC_API前评审.md) D7 v1.1 决议表。

### 7.3 实施前置硬约束(沿 §7 立项记录 §三)

- ✅ 不引入 `casl` / Redis / 队列 / 定时任务(已落地;`RbacCacheService` 用 Map + setTimeout 等价进程内 TTL)
- ✅ 不扩 `Role` enum(沿 A-4 红线;`SUPER_ADMIN / ADMIN / USER` 三层永远不变)
- ✅ 不改 v1 14 + 既有 V2 79 接口(沿 A-2 红线 zero drift;contract snapshot 守护)
- ✅ 不动 `users.policy.ts`(沿 D12 永久共存)
- ⏸️ C-7 attachments 仍等 PR #10 / #11 收口完成后才进入 D7-attachments 评审(沿 PR #45 决议 1)

### 7.4 实施 PR 落地(沿 §7 立项记录 §四)

参见 §7.1 时间线表 PR #54-#61 + 本 PR #9。

**累计基础能力**(2026-05-14 实测):
- 4 张 RBAC 表 + 1 个 migration(`add_rbac`)
- 16 个 RBAC 端点(全部 `@ApiBearerAuth()` + Swagger 注册;**contract snapshot 增量 16 路由 + 22 DTO**)
- 14 个 BizCode(`300xx` × 9 + `301xx` × 3 段位实装 + `RBAC_FORBIDDEN=30100` 段位预留 + 30011 `ROLE_PERMISSION_NOT_FOUND`)
- 1 个 `RbacService`(`getUserPermissionCodes` / `can` / `judge` / `checkOwnership` / `getMyPermissions` / `reload`)
- 1 个 `RbacCacheService`(Map + TTL + 3 个 invalidate 入口;`RBAC_CACHE_TTL_SECONDS` env 可调)
- 1 个 seed 拓展(14 条 rbac.* + ops-admin RbacRole + 14 条 RolePermission + bootstrap with env / SUPER_ADMIN fallback + 强校验)
- `CurrentUserPayload.memberId` 扩展(沿 D7 §8.3 owner 判定;v1 14 接口 response zero drift)
- 7 个 e2e spec(`permissions` / `rbac-roles` / `role-permissions` / `user-roles` / `rbac-me-permissions` / `rbac-reload` / `seed-rbac`)+ 1 个 unit spec(`rbac.service.spec.ts`)

### 7.5 本 PR #9 docs 收口边界

仅 docs(4 处):

- ✅ 更新 [`docs/批次8_RBAC_V2x立项记录.md`](docs/批次8_RBAC_V2x立项记录.md):状态头部 + §四 PR 拆分表标记 PR #1-#8 已合入 + §六 合并后下一步重写
- ✅ 更新 [`CHANGELOG.md`](CHANGELOG.md) Unreleased `### Added`:记录 PR #1-#8 累计 + 明确未做项
- ✅ 更新 [`docs/V2红线与复活路径.md`](docs/V2红线与复活路径.md):C-6 行 + Slow-1 行状态修订
- ✅ 更新本 `TASKS.md §7`(本节)

不动:

- ❌ `src/**` / `prisma/**` / `test/**` / `package.json` / `pnpm-lock.yaml`
- ❌ 不新增 migration / 不改 seed.ts
- ❌ 不 bump version / 不 tag / 不 release
- ❌ 不启动 C-7 attachments / 不接业务模块判权 / 不实装 dept-chief / 不 seed `attachment.*` / 不 seed `role-a..role-f` / 不创建 ADMIN 内置角色

### 7.6 合并后下一步

本 PR #9 合并后,**下一步是 PR #10 bump version 0.8.0 → 0.9.0**(SemVer minor;新模块 + 新表 + 16 接口),需用户明确授权。

PR #10 合入后,启动 PR #11 v0.9.0 handoff(13 章节范式;包括下一会话提示词)。

PR #11 release tag v0.9.0 后,**才**启动 C-7 attachments D7 评审稿(沿 PR #45 决议 1)。

**禁止**:未经用户授权,**不**启动 PR #10 / PR #11 / C-7 attachments / 业务模块判权接入。

---

## 8. V2.x C-7 attachments(批次 7)

> **状态(2026-05-14 V2.x 立项 PR)**:🎯 **D7 v1.0 冻结完成,V2.x implementation track 启动**;**实施 PR #1 待用户授权 + schema diff/migration SQL 双确认**。
> **入口文档**:[`docs/批次7_attachments_V2x立项记录.md`](docs/批次7_attachments_V2x立项记录.md)
> **D7 v1.0 冻结**:PR #68 `5da801f`(27 项锁定 + 1 挂起 + 2 挂起待 Provider + 1 不冻结 + 2 v1.1)
> **文档先决条件**:D7-RBAC v1.2 已合(PR #66 `2b934c5`;Permission code 正则文档 3-4 段)

### 8.1 设计 + 立项时间线

| 阶段 | PR | squash commit | 状态 |
|---|---|---|---|
| 业务访谈提纲 | #44 | `08aa4d7` | ✅ |
| D6 业务确认稿 | #45 | 沿 PR #44 后续 | ✅ |
| D7 v0.1 草稿 | #65 | `ebb530e` | ✅ |
| D7-RBAC v1.2 修订(Permission code 正则 3-4 段) | #66 | `2b934c5` | ✅(为本批次提供文档先决条件) |
| D7 v0.2 局部收口 | #67 | `e4ff48f` | ✅ |
| D7 v1.0 冻结 | #68 | `5da801f` | ✅ |
| **V2.x 立项 PR** | **本 PR** | — | 🔄 **本 PR** |
| 实施 PR #1 schema + migration + CODE_PATTERN 放宽 + Certificate.attachmentKey drop | 待启动 | — | ⏳ 等用户授权 + schema diff/migration SQL 双确认 |
| 实施 PR #2-#9 / bump / handoff | 待启动 | — | ⏳ 等用户授权(每 PR 独立) |

### 8.2 决议锁定

**27 项决议 🔒 v1.0 冻结**(F 5 + B 9 + Q 13)+ **🔄 Q12 挂起**(留独立 ADMIN 内置角色专项评审 PR)+ **⏸ Q14 / Q15 挂起待 Provider 选型评审** + **📋 Q16 建议不冻结(PR 拆分)** + **⏳ B8 同意书正式文本 + Q8 N 具体值 v1.1 由业务方提供**。

详见 [`docs/批次7_attachments_API前评审.md §16`](docs/批次7_attachments_API前评审.md) D7 v1.0 决议表 + [`docs/批次7_attachments_V2x立项记录.md §一`](docs/批次7_attachments_V2x立项记录.md)。

### 8.3 实施前置硬约束(沿 §8 立项记录 §三)

- ❌ Provider 不实装(F2 锁;Provider 选型独立评审稿同期推进)
- ❌ 不实装真上传 / 真下载(D7 实施期接口落库元数据 + 占位 URL)
- ❌ 不做病毒扫描 / 加密 KMS / 自动清理 / OCR / 秒传(沿 D6 + 决议 4)
- ❌ 不引入 Redis / 队列 / 定时任务(沿 V1.1 §17.3)
- ❌ 不动 v1 14 + V2 79 + RBAC 16 既有接口(沿 A-2 红线 zero drift)
- ❌ 不动 `users.policy.ts`(沿 D7-RBAC D12 永久共存)
- ⏳ **实施 PR #1 启动前必须先展示 schema diff + migration SQL**,等用户明确确认后才执行 `prisma migrate dev`(沿 CLAUDE.md §0 铁律)
- ⏳ Q12 ADMIN 内置角色实施期默认按方案 B(沿 v0.9.0 §5 现状,ADMIN 默认无 RBAC 业务角色;需 ops-admin 显式分配)

### 8.4 实施 PR 拆分建议(Q16 不冻结)

参见 [`docs/批次7_attachments_V2x立项记录.md §四`](docs/批次7_attachments_V2x立项记录.md) 11 PR 建议表。

**关键 PR**:
- **PR #1**(`chore(prisma)`):4 model + migration + `CODE_PATTERN` 放宽 + Certificate.attachmentKey drop column;**破坏性 schema 变更**,启动前展示 diff/SQL 双确认
- **PR #2-#5**(`feat(attachments)` / `feat(attachment-configs)`):主模块 CRUD + 配置三表 CRUD
- **PR #6**(`feat(attachments)`):RBAC 集成 + `attachment.*` 20 条权限点 seed + USER 内置角色 placeholder seed
- **PR #7**(`feat(attachments)`):audit_logs 集成(3 项 union + 同事务 wrap)
- **PR #8**(`feat(certificates)`):Certificate.attachmentKey 引用清理
- **PR #9**(`docs(v2-batch7-landing)`):docs 收口
- **PR #10**(`chore`):bump version 0.9.0 → 0.10.0
- **PR #11**(`docs(v2)`):v0.10.0 handoff

**新增依赖预期 0 个**(沿 D7-RBAC `RbacCacheService` Map + setTimeout 范式)。

### 8.5 本 V2.x 立项 PR 边界

仅 docs(4 处):

- ✅ 新增 [`docs/批次7_attachments_V2x立项记录.md`](docs/批次7_attachments_V2x立项记录.md)
- ✅ 更新本 `TASKS.md §8`(本节)
- ✅ 更新 [`docs/V2红线与复活路径.md`](docs/V2红线与复活路径.md):C-7 行从"D7 attachments 评审 → V2.x 立项"改为"D7 v1.0 已冻结,V2.x implementation track 启动";Provider 仍挂起;attachments 作为业务判权接入首个范本
- ✅ 更新 [`CHANGELOG.md`](CHANGELOG.md) Unreleased 追加一行

不动:

- ❌ `src/**` / `prisma/**` / `test/**` / `package.json` / `pnpm-lock.yaml`
- ❌ 不放宽 `CODE_PATTERN` 常量(留实施 PR #1)
- ❌ 不新增 migration / 不改 seed.ts
- ❌ 不 bump version / 不 tag / 不 release
- ❌ 不启动 C-7 实施 PR / Provider 选型评审稿 / ADMIN 内置角色专项评审 PR
- ❌ 不改 D7-RBAC / D7-attachments 已冻结文档 / 历史 handoff

### 8.6 合并后下一步

本立项 PR 合并后,**解除 V2 §18 调研期硬禁止**;**下一步是 C-7 实施 PR #1**(`chore(prisma): add Attachment schema + Permission code regex relax`),需:

1. **用户明确授权启动**
2. **AI 先展示 schema diff + migration SQL + Certificate 出参 contract snapshot 预期变更**
3. **等用户明确"破坏性变更已经过评审"后才执行 `prisma migrate dev`**(沿 CLAUDE.md §0 铁律)

**并行可启动**(独立 PR;均需用户明确授权):

- Provider 选型独立评审稿(决议 Q14 / Q15;沿 D6 决议 5)
- "RBAC 内置角色 / ADMIN 默认附件权限"专项评审 PR(决议 Q12)

**v1.1 修订 PR**:等业务方提供 B8 同意书正式文本 + Q8 N 具体值后启动。

**禁止**:未经用户授权,**不**启动实施 PR #1 / Provider 选型评审稿 / ADMIN 内置角色专项评审 PR / v1.1 修订 PR。
