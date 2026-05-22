# Architecture V1.1 Engineering Hardening (Historical)

> **Status**: archived historical material.
> **Source**: `ARCHITECTURE.md §11` (including §11.1-§11.7) moved verbatim from [`ARCHITECTURE.md`](../../../ARCHITECTURE.md) at commit `d81c2ab` (PR-6 `docs: rewrite ARCHITECTURE.md as top-level entrypoint`, archived 2026-05-22).
> This section is retained for traceability only and **is not the current execution authority**.
>
> **Active references承接 from this section**:
> - **A condensed V1.1 summary is kept active** in the new top-level [`ARCHITECTURE.md §5`](../../../ARCHITECTURE.md). External references to `ARCHITECTURE.md §11` continue to resolve via that active summary;只有当读者需要看 V1.1 阶段的完整详细约束(11.2 表 / 11.3 禁止项 / 11.4 与 v1 衔接 / 11.5 新增 env / 11.6 与 §9 边界声明 / 11.7 ESLint project)时,才阅读本归档原文
> - **当前已落地的 V1.1 能力清单**: [`docs/current-state.md §2`](../../current-state.md) "V1.1 工程加固"段
> - **运行 / 部署 SOP** (Dockerfile / GitHub Actions CI / graceful shutdown / health 三端点):[`docs/deployment.md`](../../deployment.md) / [`docs/development.md`](../../development.md) / [`docs/testing.md`](../../testing.md)
> - **限流 / 日志屏蔽 / TOO_MANY_REQUESTS=42900 / 验收门槛** 等长期铁律: [`AGENTS.md §17`](../../../AGENTS.md) + [`docs/srvf-foundation-baseline.md`](../../srvf-foundation-baseline.md)
> - **V1.1 历史 AI 协作铁律全文**(原 §17.1-§17.10):[`docs/archive/legacy/agents-historical-design-period.md`](./agents-historical-design-period.md)
>
> **Paths**: original section used repo-root-relative paths. Those strings are preserved verbatim below — they no longer resolve as Markdown links from this nested archive location, but the textual references are still meaningful when read from repo root.

---

## 11. V1.1 Engineering Hardening

> **定位**:V1.1 是 v1 完成后的"工程加固增量",不是新版本的功能升级,也不是 §9 升级路径的提前触发。本章节给出的能力**全部围绕底座侧的可观测性、运维基础、安全加固**展开,不新增任何业务接口、不修改任何业务路由、不改动业务数据模型。
>
> **与 v1 的关系**:§1-§10 是 v1 蓝图,**保持不变**;V1.1 只在底座之上增量补充。任何 V1.1 条目与 v1 已有铁律冲突时,**以 v1 铁律为准**,V1.1 让步。
>
> **与 §9 升级路径的关系**:§9 列出的所有"升级触发条件"在 V1.1 阶段**仍然不触发**;V1.1 不引入 Redis、不引入 BullMQ、不引入 RBAC、不引入 refresh token、不引入文件上传 Provider、不引入 LLM、不引入审计日志表、不引入用户状态缓存。

### 11.1 V1.1 目标

为 v1 骨架补足"能上生产"的最小工程基线,具体覆盖三件事:

1. **可观测性**:把"出了问题查不到"变成"出了问题能在 5 分钟内定位"——结构化日志 + 请求 ID 贯通。
2. **运维基础**:把"本地能跑"变成"容器能起、CI 能跑、SIGTERM 能优雅退出"——Dockerfile + GitHub Actions + graceful shutdown + 健康检查分层。
3. **安全加固**:把"裸跑在公网会被扫死"变成"基线防护到位"——helmet HTTP 头 + 登录接口限流。

V1.1 不追求完备,只求把"裸 v1 直接上线"的几个最常见塌方点补上。任何超出这三件事的能力(指标采集、APM 接入、tracing、审计日志持久化、性能 profile)都不属于 V1.1。

### 11.2 V1.1 允许做的事

| 能力 | 选型 | 范围 |
|---|---|---|
| **结构化日志** | `nestjs-pino` + `pino`(开发可叠 `pino-pretty`) | 替换 NestJS 默认 Logger;输出 JSON;**自动屏蔽敏感字段** `password` / `newPassword` / `passwordHash` / `authorization` / `cookie` / `token` / `accessToken` / `refreshToken` / `secret` |
| **请求 ID 追踪** | `nestjs-pino` 内置或自写中间件 | 读 `x-request-id` 请求头,缺失则用 `cuid()` 生成;同时写回响应头 `x-request-id`;贯穿同一请求所有日志的 `requestId` 字段 |
| **优雅关闭** | NestJS `app.enableShutdownHooks()` + `OnModuleDestroy` | `PrismaService` 实现 `OnModuleDestroy`,在 `onModuleDestroy()` 内 `await this.$disconnect()`;监听 SIGTERM / SIGINT 后等待 in-flight 请求完成 |
| **HTTP 安全头** | `helmet` | `app.use(helmet())`,默认配置;若与 Swagger UI 的 inline script CSP 冲突,**仅对 `/api/docs` 路径**关闭 `contentSecurityPolicy`,**禁止全局关闭** |
| **登录接口限流** | `@nestjs/throttler` 内存 storage | **仅作用于 `POST /api/auth/login`**(基于路径或 controller 装饰器);默认 `5 次 / 60 秒 / per IP`(具体参数走 `app.config.ts`);超限抛新增的 `BizException(BizCode.TOO_MANY_REQUESTS)` |
| **健康检查升级** | `@nestjs/terminus` | 在 `health/` 模块下新增 `GET /api/health/live`(进程存活)与 `GET /api/health/ready`(DB 连通);保留原 `GET /api/health` 作向后兼容,响应等同 `/live`;三者都 `@Public()`,都走统一响应包装 |
| **Dockerfile** | 多阶段:deps → builder → runner | 基于 `node:22-alpine`;runner 阶段切换到非 root 用户(优先用 `node` 用户);`prisma migrate deploy` 在容器入口 entrypoint 里显式执行,**不能**在镜像构建阶段执行 |
| **CI 流水线** | GitHub Actions(`.github/workflows/ci.yml`) | 触发:`push` 到 `main` + 所有 PR;步骤:checkout → setup-node 22 → pnpm install(带 store 缓存)→ lint → typecheck → 起 PostgreSQL service container → `db:test:init` → `test:e2e` |
| **新增错误码** | `BizCode.TOO_MANY_REQUESTS` | `code: 42900`,`message: '请求过于频繁，请稍后再试'`,`httpStatus: HttpStatus.TOO_MANY_REQUESTS`(429);**不暴露阈值数字、剩余配额、重置时间到 message** |
| **新增环境变量** | 见 §11.5 | `LOG_LEVEL` / `LOGIN_THROTTLE_LIMIT` / `LOGIN_THROTTLE_TTL_SECONDS`;统一归 `app.config.ts`,启动强校验 |

### 11.3 V1.1 禁止做的事

V1.1 仍然**不做**以下事项,任何 AI 看到 V1.1 章节不要把它当成"放开口子"的信号(**适用范围**:V1.1 工程加固阶段;V2.x 已通过独立评审解锁 RBAC / `attachments` 元数据 / 文件上传 Provider 等;详见 §12 + [`docs/V2红线与复活路径.md`](./docs/V2红线与复活路径.md) §4):

- 不引入 Redis(包括限流的 Redis storage、用户状态缓存、JWT 黑名单)——限流只用 `@nestjs/throttler` 内存 storage
- 不引入 BullMQ / 任务队列 / 定时任务
- 不做操作日志 / 审计日志的**数据库持久化**——只做结构化日志输出到 stdout
- 不接入 OpenTelemetry / Jaeger / Zipkin 等 tracing 系统
- 不接入 Sentry / Datadog / New Relic 等 APM
- 不暴露 Prometheus `/metrics` 端点(若未来需要,按 §9 升级路径处理,且 `/metrics` 必须加入 `ResponseInterceptor` 跳过列表)
- 不做 refresh token / 本人改密码接口 / 微信小程序登录 / RBAC 权限表 / 多租户 / 文件上传 Provider / pgvector / LLM
- 不在 v1 业务模块(`auth` / `users` / `health`)里夹带新业务字段、新业务路由
- 不修改 §6 API 接口清单中已有接口的入参 / 出参 / HTTP 方法 / 权限标注
- 不修改 Prisma `User` 模型(不加日志相关字段、不加请求统计字段)
- 不修改 §1-§10 任何 v1 铁律的语义;V1.1 只能在已有铁律之上**追加**约束,不能**放宽**已有约束

### 11.4 V1.1 与 v1 铁律的衔接

V1.1 新增能力必须复用 v1 已建立的基础设施,**禁止另起炉灶**:

- **错误处理**:限流、健康检查 ready 失败等异常**必须**走 `BizException` + `AllExceptionsFilter`,响应体仍然是 `{ code, message, data: null }`,HTTP status 由 BizCode 的 `httpStatus` 决定;**禁止**直接 `throw new HttpException` 绕过统一错误码
- **响应格式**:健康检查升级后的三个端点(`/api/health` / `/api/health/live` / `/api/health/ready`)**继续走** `ResponseInterceptor` 包装,响应体形如 `{ code: 0, message: 'ok', data: { status: 'ok', ... } }`;**不要**为了对齐 `@nestjs/terminus` 的原生输出绕过包装
- **Swagger 覆盖**:`/api/health/live` 与 `/api/health/ready` 必须 `@ApiOperation` + `@ApiWrappedOkResponse(...)`,与 v1 的 Swagger 100% 覆盖铁律一致
- **配置归属**:V1.1 新增的 `LOG_LEVEL` / `LOGIN_THROTTLE_LIMIT` / `LOGIN_THROTTLE_TTL_SECONDS` 全部归 `src/config/app.config.ts`,**禁止**为日志或限流单独建 `logger.config.ts` / `throttler.config.ts`
- **错误码段位**:`TOO_MANY_REQUESTS = 42900` 落在 `4xxxx` 通用 HTTP 段,**不**占用业务模块的 `100xx` / `110xx` 段位
- **日志屏蔽**:敏感字段屏蔽列表必须与 §7.7 / §9 密码处理铁律对齐,至少包含 `password` / `newPassword` / `passwordHash` / `authorization` / `cookie` / `token` / `accessToken` / `refreshToken` / `secret`;DTO 字段一旦命中此清单,日志中**必须**显示为 `[REDACTED]`,**不能**仅做长度截断
- **限流防绕过**:`POST /api/auth/login` 限流后,**不要**在 `auth.service.ts` 内自写 `setTimeout` 之类的伪限流;限流统一由 `@nestjs/throttler` 提供,绕过它就等于关掉限流

### 11.5 V1.1 新增环境变量

| 变量 | 默认值 | 归属 | 说明 |
|---|---|---|---|
| `LOG_LEVEL` | `info`(生产) / `debug`(非生产) | `src/config/app.config.ts` | pino 日志级别;允许值 `fatal` / `error` / `warn` / `info` / `debug` / `trace` |
| `LOGIN_THROTTLE_LIMIT` | `5` | `src/config/app.config.ts` | `POST /api/auth/login` 每 TTL 窗口允许的最大尝试次数 |
| `LOGIN_THROTTLE_TTL_SECONDS` | `60` | `src/config/app.config.ts` | `POST /api/auth/login` 限流 TTL,单位秒;最小 1,最大 3600 |

启动强校验追加:

- `LOG_LEVEL` 必须 ∈ `{ fatal, error, warn, info, debug, trace }`
- `LOGIN_THROTTLE_LIMIT` 必须为正整数,推荐范围 `[1, 100]`
- `LOGIN_THROTTLE_TTL_SECONDS` 必须为正整数,推荐范围 `[1, 3600]`
- 任一不满足直接抛错退出,**禁止**用 fallback 默认值在生产环境兜底

`.env.example` 必须同步追加以上三项,值留空或写注释默认,**不允许**在 `.env.example` 中写敏感值。

### 11.6 V1.1 与 §9 升级路径的边界声明

V1.1 完成后,以下场景**仍然走 §9 升级路径**,V1.1 不替代:

| 真实诉求 | V1.1 是否解决 | 应走的升级路径 |
|---|---|---|
| 单实例 QPS 上升后限流要在多实例间共享配额 | ❌ 不解决(V1.1 用内存 storage,多实例不共享) | §9 引入 Redis + `@nestjs/throttler` Redis storage |
| 用户登录被禁用后,旧 token 必须立即失效 | ❌ 不解决 | §9 引入用户状态 Redis 缓存 + 主动失效 |
| 需要把所有 4xx / 5xx 异常上报到 Sentry | ❌ 不解决 | §9 升级条目"接入 APM" |
| 需要查"某次错误对应的完整调用链" | ❌ 不解决(V1.1 只有日志,没 tracing) | §9 升级条目"引入 OpenTelemetry" |
| 需要按用户 / 接口维度采集 P95 / P99 延迟 | ❌ 不解决 | §9 升级条目"引入 Prometheus / Grafana" |

V1.1 完成后,**不要**因为"日志已经接进来了"就顺手把上面任一条带做;每一条都需要重新评估业务诉求与 §9 升级路径。

---

### 11.7 ESLint TypeScript Project 覆盖规则

项目使用显式 `parserOptions.project` 列表覆盖 `src` / `test` / `prisma` 三处 TypeScript 源码(不使用 `projectService` 自动发现,因为 `prisma/` 目录不在任何运行时 tsconfig 的 `include` 中)。

新增任何 TypeScript 源码目录(如 `scripts/`、`tools/`、`migrations/` 等)时,维护者必须按以下顺序执行:

1. 为新目录新增或更新对应的 `tsconfig` 文件(若不希望进入运行时构建,参考 `prisma/tsconfig.eslint.json` 模式,只供 ESLint 解析使用)
2. 在 `eslint.config.mjs` 的 `parserOptions.project` 数组中追加新 `tsconfig` 路径
3. 确认 `pnpm lint` 通过

**禁止**新增 TypeScript 目录但不同步更新 ESLint project 覆盖 — 未覆盖的 `.ts` 文件会被 typescript-eslint 抛 `was not found by the project service` 解析错误,直接破坏 lint 闭环。
