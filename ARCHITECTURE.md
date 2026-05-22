# ARCHITECTURE.md — SRVF API 顶层架构入口

> 本文是 SRVF API 的**顶层架构入口与升级路径权威源**。
>
> - **当前事实**(版本 / open PR / 已发能力 / surface 状态)见 [`docs/current-state.md`](./docs/current-state.md)
> - **长期 AI 协作铁律**(命名 / 错误码 / Guard / 软删 / App API 边界 / §19.7 D-series 决策锁)见 [`AGENTS.md`](./AGENTS.md)
> - **流程与 PR 分级**见 [`docs/process.md`](./docs/process.md)
> - **本文** 聚焦长期生效的设计哲学、升级路径(§9)、V1.1 工程加固摘要(§11)、文档权威源地图,以及历史架构归档索引
>
> 历史 v1 / V1.1 / V2 第一阶段设计期蓝图原文(原 §1-§12,共 1547 行)自 PR-6 起归档至 `docs/archive/**`,见本文 §14。

---

## 0. 当前阶段说明

本文于 2026-05-22 由 PR-6 从设计期蓝图(原 1547 行)收口为顶层架构入口,原 §1-§10 + 附录 / §11 / §12 全部归档至 `docs/archive/**`(见 §14)。本文**保留原 §9(升级路径)/ §11(V1.1 工程加固)的章节编号**,以确保 [`AGENTS.md`](./AGENTS.md) / [`docs/current-state.md`](./docs/current-state.md) / [`docs/V2红线与复活路径.md`](./docs/V2红线与复活路径.md) / [`docs/security.md`](./docs/security.md) 等 active 文档对 "ARCHITECTURE.md §9 / §11" 的现有引用持续可达。

### 0.1 文档权威源分层(冲突时按此顺序)

| 维度 | 权威源 |
|---|---|
| **当前事实**(版本 / open PR / 已发能力 / surface 状态 / 当前债务) | [`docs/current-state.md`](./docs/current-state.md) |
| **长期 AI 协作铁律**(命名 / 错误码 / Guard / 软删 / 密码 / DTO 分离 / 角色层级 / refresh token / §19.7 D-series 决策锁) | [`AGENTS.md`](./AGENTS.md) §1-§19 |
| **流程制度**(开工 checklist / PR 五档 / D 档降速 / release 收口 / AI 协作纪律) | [`docs/process.md`](./docs/process.md) |
| **本文(顶层架构入口)** | 设计哲学(§1)+ 技术栈快照(§2)+ 升级路径(§9 active)+ V1.1 摘要(§11 active)+ 权威源地图(§13)+ 归档索引(§14) |
| **V2 基线 / 红线** | [`docs/srvf-foundation-baseline.md`](./docs/srvf-foundation-baseline.md) / [`docs/V2红线与复活路径.md`](./docs/V2红线与复活路径.md) |
| **API surface 边界** | [`docs/api-surface-policy.md`](./docs/api-surface-policy.md) |
| **架构边界铁律** | [`docs/architecture-boundary.md`](./docs/architecture-boundary.md) |
| **历史架构蓝图原文** | [`docs/archive/legacy/architecture-v1-blueprint.md`](./docs/archive/legacy/architecture-v1-blueprint.md) / [`docs/archive/legacy/architecture-v1-1-hardening.md`](./docs/archive/legacy/architecture-v1-1-hardening.md) / [`docs/archive/plans/architecture-v2-first-stage-blueprint.md`](./docs/archive/plans/architecture-v2-first-stage-blueprint.md) |

**铁律**:
- 当前事实与本文冲突 → 以 [`docs/current-state.md`](./docs/current-state.md) 为准
- 长期铁律与本文冲突 → 以 [`AGENTS.md`](./AGENTS.md) 为准
- 归档目录(`docs/archive/**`)内文档**只代表归档时刻的决议**,不再作为当前规则依据;active 引用应指向上表 active 权威源,而非 archive

---

## 1. 设计哲学

底座的存在意义是"让 AI 在新业务场景下少出错、少返工"。以下 4 条是长期生效的核心设计哲学:

- **API-only**:前端永远独立项目,绝不混在一起。AI 在全栈混合项目里最容易搞蒙。
- **强约定 > 灵活配置**:统一返回格式、统一错误处理、统一模块结构、统一命名。让 AI 不靠猜。
- **命名即文档**:`passwordHash` 不叫 `password`,`key` 不叫 `path`,`@Roles(Role.SUPER_ADMIN)` 不写 `'admin'` 字符串。读代码不用猜语义。
- **极简主义优先**:任何"未来可能用到"的功能先砍掉,需要时再加。复杂度上去,AI 改起来就慢、错、乱。真有诉求按 §9 升级路径走,**禁止**"以为以后会用得到"提前实装。

历史 v1 设计原则原文(`Interface stability > implementation completeness` / `不预先做 RBAC / 多租户 / 刷新 token` 等)见归档 [`architecture-v1-blueprint.md §1`](./docs/archive/legacy/architecture-v1-blueprint.md)。注意:原文中"v1 不预先做 RBAC / refresh token / 附件 Provider / App API / audit_logs"等条目**已被 SRVF 业务驱动解锁**,当前 A/B/C 三档读取规则以 [`AGENTS.md §1`](./AGENTS.md) 为准。

---

## 2. 当前技术栈

| 层 | 选型 | 当前版本(以 `package.json` 为准) | 用途 |
|---|---|---|---|
| 框架 | **NestJS** | ^11 | 强约定 + 模块化适合"底座 + 业务"复用 |
| 运行时 | **Node.js** | 22 LTS | 稳,生态全 |
| 数据库 | **PostgreSQL** | 16 | 关系数据 + JSON + 向量(pgvector 触发后)一把梭 |
| ORM | **Prisma** | ^6 | schema-first,类型安全,AI 训练语料最多 |
| 鉴权 | **@nestjs/jwt** + **passport-jwt** | — | JWT 登录与请求鉴权;refresh token(P0-E)见 [`AGENTS.md §9`](./AGENTS.md) |
| 密码哈希 | **bcryptjs** | salt rounds 10 | 跨平台部署稳定 |
| API 文档 | **@nestjs/swagger** | 按 `peerDependencies` 选 | **禁止**手动钉死主版本号 |
| 校验 | **class-validator** + **class-transformer** | — | NestJS 标配 |
| 日志 | **nestjs-pino** + **pino** | V1.1 落地 | 结构化 JSON + 敏感字段自动屏蔽(详 §11) |
| 限流 | **@nestjs/throttler** | 内存 storage | `login` / `password-change` / `refresh` 三 throttler 物理隔离 |
| 健康检查 | **@nestjs/terminus** | — | `/api/health` / `/live` / `/ready` 三端点(详 §11) |
| 容器化 | **Docker Compose** | — | 本地 PostgreSQL;运维 SOP 见 [`docs/deployment.md`](./docs/deployment.md) |
| 包管理 | **pnpm** | `packageManager` 字段钉死 | **禁止** npm / yarn / bun |

历史 v1 技术栈原表(含选型理由 / Prisma 6 vs 7 决策等)见归档 [`architecture-v1-blueprint.md §2`](./docs/archive/legacy/architecture-v1-blueprint.md)。

---

## 3. 项目结构 / 模块边界

当前 `src/modules/` 已远超 v1 蓝图阶段的 4 模块,实际目录与历史 v1 蓝图原文(归档于 [`architecture-v1-blueprint.md §3`](./docs/archive/legacy/architecture-v1-blueprint.md))已显著漂移。本文**不再**维护具体目录树,改由以下 active 文档承接:

- **当前 active 项目结构** / 路由总览 / 环境变量索引:[`docs/development.md`](./docs/development.md)
- **模块结构铁律**(4 文件默认基线 + 已解锁例外:Surface-specific Controller / `dto/app/` 子目录 / 同模块内职责类抽出):[`AGENTS.md §2`](./AGENTS.md)
- **API surface 三前缀边界**(`/api/app/v1/*` / `/api/v2/*` / Root Legacy):[`docs/api-surface-policy.md`](./docs/api-surface-policy.md)
- **架构边界铁律**(Presenter / QueryService / PolicyService / StateMachine / AuditRecorder / Effect 6 类抽离决策;承接 [`AGENTS.md §19.7 D-7`](./AGENTS.md)):[`docs/architecture-boundary.md`](./docs/architecture-boundary.md)

**模块扩展铁律**:新业务模块**平铺**加在 `src/modules/` 下,**禁止**嵌套 `system/` / `business/` / `core/` 等子目录;**禁止** `*.entity.ts`(本项目不是 TypeORM)。

---

## 4. v1 范围 / 不做清单(已演进)

历史 v1 蓝图阶段对"v1 不做的事"的清单原文见归档 [`architecture-v1-blueprint.md §4`](./docs/archive/legacy/architecture-v1-blueprint.md)。**该清单中的多数项目已被 SRVF 业务驱动解锁**(RBAC v0.13.0+ / refresh token v0.14.0+ / 附件 Provider v0.10.0~v0.12.0 / App API Phase 2 v0.15.0 / audit_logs v0.7.0+ / 本人改密 v0.13.0)。

**当前** 解锁 / 未解锁的清单以以下 active 文档为准:

- **A/B/C 三档读取**(已解锁 / 评审解锁 / 仍不做):[`AGENTS.md §1`](./AGENTS.md)
- **V2 五档红线 / V2.x 复活路径**(A 不可破 / B 当前批次禁止 / C 可复活 / D 历史过期 / E 待业务确认):[`docs/V2红线与复活路径.md`](./docs/V2红线与复活路径.md)
- **当前已落地能力清单**:[`docs/current-state.md §2`](./docs/current-state.md)

---

## 5. 数据模型

历史 v1 单 `User` 表模型 + 字段约定原文见归档 [`architecture-v1-blueprint.md §5`](./docs/archive/legacy/architecture-v1-blueprint.md)。当前 schema 已远超 v1 单表,以以下 active 权威源为准:

- **当前 Prisma schema**:[`prisma/schema.prisma`](./prisma/schema.prisma)(单一权威源)
- **字段命名 / 时间戳 / 主键 / 软删除 / 密码 / 角色枚举铁律**:[`AGENTS.md §3 / §9 / §10`](./AGENTS.md)
- **V2 命名约定**(外键 / 中间表 / 启停字段 / 字典关联):[`docs/srvf-foundation-baseline.md §2`](./docs/srvf-foundation-baseline.md)
- **V2 第一阶段数据模型说明**(4 模型 + `users.memberId`):[`docs/v2-data-model.md`](./docs/v2-data-model.md)
- **敏感字段三问**(身份证 / 紧急联系人 / 医疗等纳入 schema 的前置条件):[`AGENTS.md §18.4`](./AGENTS.md) + [`docs/srvf-foundation-baseline.md §8`](./docs/srvf-foundation-baseline.md)(屏蔽清单)

---

## 6. API 接口清单

历史 v1 14 接口清单 + HTTP 方法规则原文见归档 [`architecture-v1-blueprint.md §6`](./docs/archive/legacy/architecture-v1-blueprint.md)。当前接口数已远超 v1 14 个;v1 14 接口 schema **严格 zero drift** 是 V2 红线 A-2(见 [`docs/V2红线与复活路径.md §A-2`](./docs/V2红线与复活路径.md))。

当前 API 接口以以下 active 权威源为准:

- **OpenAPI / Swagger 实时文档**:`/api/docs`(运行时);`test/contract/__snapshots__/openapi.contract-spec.ts.snap`(契约快照)
- **API surface 三前缀策略 + Mixed Controller 存量 + mobile-like endpoint 处置矩阵**:[`docs/api-surface-policy.md`](./docs/api-surface-policy.md)
- **V2 第一阶段接口契约**(含 §6.6 memberNo 登录回退):[`docs/v2-api-contract.md`](./docs/v2-api-contract.md)
- **Participation 业务上下文边界图**(activities / activity-registrations / attendances / contribution-rules):[`docs/participation-bounded-context.md`](./docs/participation-bounded-context.md)
- **HTTP 方法选择 / 统一返回格式 / 错误处理**:[`AGENTS.md §4 / §5 / §8`](./AGENTS.md)

---

## 7. 命名与编码约定

历史 v1 §7(11 个子节,600+ 行铁律)原文见归档 [`architecture-v1-blueprint.md §7`](./docs/archive/legacy/architecture-v1-blueprint.md)。**长期铁律已全部承接到** [`AGENTS.md`](./AGENTS.md):

| 历史 §7.X 子节 | 当前 active 权威源 |
|---|---|
| §7.1 模块结构(4 文件) | [`AGENTS.md §2`](./AGENTS.md) |
| §7.2 命名铁律 | [`AGENTS.md §3`](./AGENTS.md) |
| §7.3 统一返回格式 + BizCode + BizException + ResponseInterceptor 跳过路径 | [`AGENTS.md §4 / §5`](./AGENTS.md) |
| §7.4 Swagger 100% 覆盖 | [`AGENTS.md §6`](./AGENTS.md) |
| §7.5 全局 ValidationPipe | [`AGENTS.md §7`](./AGENTS.md) |
| §7.6 权限标注 + JWT + 登录防账号枚举 + Timing 防御 | [`AGENTS.md §8`](./AGENTS.md) |
| §7.7 密码处理 | [`AGENTS.md §9`](./AGENTS.md) |
| §7.8 软删除 | [`AGENTS.md §10`](./AGENTS.md) |
| §7.9 DTO 与 Prisma 分离 + IdParamDto | [`AGENTS.md §11`](./AGENTS.md) |
| §7.10 事务使用规则 | [`AGENTS.md §12`](./AGENTS.md) |
| §7.11 角色层级与管理员保护 | [`AGENTS.md §13`](./AGENTS.md) |

---

## 8. 环境变量

历史 v1 §8 `.env.example` 模板 + 配置归属表原文见归档 [`architecture-v1-blueprint.md §8`](./docs/archive/legacy/architecture-v1-blueprint.md)。当前 env 已新增 `JWT_REFRESH_EXPIRES_IN` / `LOG_LEVEL` / `LOGIN_THROTTLE_LIMIT` / `LOGIN_THROTTLE_TTL_SECONDS` / `PASSWORD_CHANGE_THROTTLE_*` / `REFRESH_THROTTLE_*` / `STORAGE_ENCRYPTION_KEY` 等多项。

当前 env 与配置归属以以下 active 权威源为准:

- **`.env.example`** 实时模板:[`.env.example`](./.env.example)(运行时)
- **配置归属规则 + 启动强校验铁律**:[`AGENTS.md §14`](./AGENTS.md)
- **V2 配置归属决策模板**(应用级 / 数据库 / JWT / 模块特有 / seed 一次性):[`docs/srvf-foundation-baseline.md §7`](./docs/srvf-foundation-baseline.md)
- **运行环境变量索引**:[`docs/development.md §6`](./docs/development.md)

---

## 9. 升级路径(active)

> 本节是本文的**核心 active 章节**,完整保留自原 ARCHITECTURE.md §9。[`AGENTS.md`](./AGENTS.md) / [`docs/V2红线与复活路径.md`](./docs/V2红线与复活路径.md) / [`docs/security.md`](./docs/security.md) 等 active 文档均以 "ARCHITECTURE.md §9 升级路径" 作为基础设施扩张的触发条件单一权威源,引用锚点不变。

底座是活的,但不要预先做。下表是"何时该加什么":

**路径写法约定**:本节"加在哪里"列统一使用 `src/` 开头的完整路径,避免脱离上下文歧义。新加目录或文件都落在 `src/` 下,不要在项目根新建 `auth/`、`common/` 等目录。

| 触发信号 | 该加什么 | 加在哪里 |
|---|---|---|
| 第一个产品要传文件 | 再注册 storage provider,实现 `LocalStorageProvider` 或 `OssStorageProvider` | `src/common/storage/providers/` |
| 救援队系统启动 | `modules/orgs/`(组织/部门),`User` 加 `orgId` 字段 | `src/modules/orgs/` |
| 出现"A 队不能看 B 队数据" | 引入 `tenantId`,所有 service 显式按租户过滤 | 各业务 `src/modules/<name>/<name>.service.ts` |
| 真要做"按钮级 / resource type 级 RBAC"(C-6 D7 v0.2 局部收口) | 加 `Role` / `Permission` / `RolePermission` / `UserRole` 4 表 + 自实现 `RbacService`(沿 [`docs/批次8_RBAC_API前评审.md`](docs/批次8_RBAC_API前评审.md) D7 v0.2 决议;**不**用 `casl` 库;Service 层显式 `rbac.can()` 调用,不做 Guard 装饰器;BizCode 段位 `300xx + 301xx`)| `src/modules/permissions/` |
| 第一个小程序产品要接 | 加微信登录策略 | `src/modules/auth/strategies/wechat-mini.strategy.ts` |
| 真有"无感续期"诉求 | 加 refresh token 表 + 接口 | `src/modules/auth/` |
| 出现"普通用户自助改密码"产品 | 加 `PUT /api/users/me/password` + `ChangeMyPasswordDto` + 防爆破;是否吊销其他设备 token 由该产品安全策略决定 | `src/modules/auth/` + `src/modules/users/` |
| 真有异步任务 / 限流 | 加 Redis + BullMQ | 新增 `src/modules/queue/` 模块 |
| 第一个 AI 产品启动 | 再注册 `AiModule`,填充 `modules/ai/`,接 Vercel AI SDK,加 pgvector | `src/modules/ai/` |
| 真有审计需求 | 加 `operation_logs` 表 + 全局拦截器 | `src/common/interceptors/audit.interceptor.ts` |
| JWT 每请求查库成为瓶颈(用户校验耗时占请求 >20%,或单表 QPS > 1000) | 引入 Redis 缓存用户状态(短 TTL,如 30s),禁用/软删时主动失效缓存 | `src/modules/auth/user-state.cache.ts`(用户状态缓存属于鉴权热路径,先归属 auth;若后续出现通用缓存需求再抽 `src/common/cache/`) |

**判定原则**:不是"觉得以后会用",而是"现在的产品需求里出现了这个明确诉求"。

> **当前已解锁能力**(由真实业务诉求驱动经独立评审解锁,对应本表多条已落地):RBAC(v0.13.0+ / v0.15.0 P0-F 管理面收紧)/ refresh token + logout + logout-all(v0.14.0+)/ attachments 元数据 + 配置三表 + COS Provider(v0.10.0~v0.12.0)/ App API Phase 2 15 endpoint(v0.15.0)/ audit_logs(v0.7.0+ / 第二波 22 处写迁移已完成)/ 本人改密 P0-D(v0.13.0)。详 [`docs/current-state.md §2`](./docs/current-state.md)。仍未解锁的项目(Redis / BullMQ / 微信小程序登录 / pgvector / LLM / 多租户 / `tokenVersion` 字段 / access token blacklist)继续遵守本表触发条件。

---

## 10. 部署

历史 v1 §10 部署原文(Docker Compose / 生产部署候选 / 迁移流程)见归档 [`architecture-v1-blueprint.md §10`](./docs/archive/legacy/architecture-v1-blueprint.md)。当前部署 SOP 以以下 active 文档为准:

- **运行时部署 SOP** / Docker 镜像 / 生产部署 / 迁移流程:[`docs/deployment.md`](./docs/deployment.md)
- **docker smoke CI 形态**:[`docs/docker-smoke-test.md`](./docs/docker-smoke-test.md)
- **运维侧真实 COS 上线 SOP**:[`docs/ops/cos-production-rollout-checklist.md`](./docs/ops/cos-production-rollout-checklist.md)
- **生产 `prisma migrate deploy` 铁律 / 禁止 `prisma migrate dev` 直连生产**:[`AGENTS.md §0`](./AGENTS.md) + V2 红线 A-12

---

## 11. V1.1 工程加固摘要(active 锚点)

> V1.1 工程加固("能上生产"的最小工程基线)已于 v0.1.5 / v0.1.6 收口。本节是 active 摘要锚点,保证 [`AGENTS.md §17`](./AGENTS.md) / [`docs/current-state.md`](./docs/current-state.md) / [`docs/deployment.md`](./docs/deployment.md) 对 "ARCHITECTURE.md §11" 的现有引用持续可达。原 §11.1-§11.7 详细约束见归档 [`architecture-v1-1-hardening.md`](./docs/archive/legacy/architecture-v1-1-hardening.md)。

### 11.1 V1.1 覆盖能力

V1.1 在 v1 业务接口与数据模型不变的前提下补齐以下基础工程能力:

- **结构化日志**:`nestjs-pino` + `pino`(开发可叠 `pino-pretty`);**自动屏蔽敏感字段** `password` / `newPassword` / `passwordHash` / `authorization` / `cookie` / `token` / `accessToken` / `refreshToken` / `secret`(V2 屏蔽清单预扩展见 [`docs/srvf-foundation-baseline.md §8`](./docs/srvf-foundation-baseline.md))
- **请求 ID 追踪**:读 `x-request-id` 请求头,缺失则用 `cuid()` 生成;同时写回响应头;贯穿同一请求所有日志的 `requestId` 字段
- **优雅关闭**:`app.enableShutdownHooks()` + `OnModuleDestroy`;`PrismaService` 在 `onModuleDestroy()` 内 `await this.$disconnect()`
- **HTTP 安全头**:`helmet` 全局启用;仅对 `/api/docs` 路径关闭 `contentSecurityPolicy`(Swagger UI 兼容)
- **登录限流**:`@nestjs/throttler` 内存 storage;仅作用于 `POST /api/auth/login`,默认 `5 次 / 60 秒 / per IP`;超限抛 `BizException(BizCode.TOO_MANY_REQUESTS)`(`code: 42900` / HTTP 429);**不暴露**阈值数字、剩余配额、重置时间到 message
- **健康检查分层**:`@nestjs/terminus`;`/api/health/live`(进程存活)+ `/api/health/ready`(DB 连通)+ `/api/health`(向后兼容,等同 `/live`);三者都 `@Public()`,都走统一响应包装
- **Dockerfile 多阶段**:`node:22-alpine` deps → builder → runner;runner 切换到非 root 用户(优先用 `node` 用户);`prisma migrate deploy` 在 entrypoint 显式执行,**不能**在镜像构建阶段执行
- **CI 流水线**:`.github/workflows/ci.yml`;`push` 到 `main` + 所有 PR 触发;步骤 checkout → setup-node 22 → pnpm install(带 store 缓存)→ lint → typecheck → 起 PostgreSQL service container → `db:test:init` → `test:e2e`

### 11.2 V1.1 阶段不做 → V2.x 已部分解锁

V1.1 阶段**不引入** Redis / BullMQ / OpenTelemetry / Sentry / APM / Prometheus / RBAC / refresh token / 多租户 / 文件上传 Provider / LLM / 审计日志持久化 / 用户状态缓存。**当前 V2.x 已通过独立评审解锁**:`audit_logs`(v0.7.0)/ RBAC(v0.13.0)/ refresh token(v0.14.0)/ attachments + COS Provider(v0.10.0~v0.12.0)/ 本人改密(v0.13.0)/ App API Phase 2(v0.15.0)。当前仍未解锁项继续遵守 §9 升级路径。详 [`docs/current-state.md §2`](./docs/current-state.md) + [`docs/V2红线与复活路径.md §4`](./docs/V2红线与复活路径.md)。

### 11.3 V1.1 新增环境变量

`LOG_LEVEL` / `LOGIN_THROTTLE_LIMIT` / `LOGIN_THROTTLE_TTL_SECONDS` 统一归 `src/config/app.config.ts`,启动强校验。详细取值范围 / 启动强校验规则见归档 [`architecture-v1-1-hardening.md §11.5`](./docs/archive/legacy/architecture-v1-1-hardening.md)。

### 11.4 V1.1 与 §9 升级路径的边界声明

V1.1 完成后,多实例配额共享 / 用户禁用即时失效 / Sentry 上报 / OpenTelemetry tracing / Prometheus P95/P99 等场景**仍然走 §9 升级路径**;V1.1 不替代。详见归档 [`architecture-v1-1-hardening.md §11.6`](./docs/archive/legacy/architecture-v1-1-hardening.md)。

### 11.5 ESLint TypeScript Project 覆盖规则

新增任何 TypeScript 源码目录(`scripts/` / `tools/` / `migrations/` 等)时,**必须**同步更新 `eslint.config.mjs` 的 `parserOptions.project` 数组;**禁止**未覆盖的 `.ts` 文件破坏 lint 闭环。详细操作步骤见归档 [`architecture-v1-1-hardening.md §11.7`](./docs/archive/legacy/architecture-v1-1-hardening.md)。

---

## 12. V2 派生项目方向(已归档)

历史 §12 V2 派生项目方向原文(§12.1-§12.11,含 V2 第一阶段开发蓝图 / Step 1-7 / v1 兼容性红线 / 绝对禁止清单 / D8 解除条件 / V2.x 复活路径)整段归档至 [`docs/archive/plans/architecture-v2-first-stage-blueprint.md`](./docs/archive/plans/architecture-v2-first-stage-blueprint.md)。

**V2 第一阶段开发(Step 1-7)已于 v0.2.0 全部完成**。当前 V2 / V2.x 状态以以下 active 权威源为准:

- **V2.x 复活触发条件 / 延后模型当前清单 / A/B/C/D/E 五档红线**:[`docs/V2红线与复活路径.md §4`](./docs/V2红线与复活路径.md)(滚动维护)
- **V2 基线规范**(BizCode 段位 / 命名 / DTO 白名单 / 软删 / v1 兼容 / 时区 / 验收门槛 13 项 A 档):[`docs/srvf-foundation-baseline.md`](./docs/srvf-foundation-baseline.md)
- **V2 数据模型**(4 模型 + `users.memberId`):[`docs/v2-data-model.md`](./docs/v2-data-model.md)
- **V2 第一阶段接口契约**(含 §6.6 memberNo 登录回退):[`docs/v2-api-contract.md`](./docs/v2-api-contract.md)
- **V2 第一阶段执行计划历史快照**(原 `docs/v2-plan.md`):[`docs/archive/plans/v2-first-stage-plan.md`](./docs/archive/plans/v2-first-stage-plan.md)
- **当前 V2 / V2.x 已落地能力清单**:[`docs/current-state.md §2`](./docs/current-state.md) "V2 数据底座" / "V2 批次" / "V2.x C-6/C-7/C-7.5" 段

外部对 `ARCHITECTURE.md §12.X` 的引用(§12.6 / §12.8 / §12.8.1 / §12.8.2 / §12.8.2.1 / §12.8.2.2 / §12.8.2.3 / §12.8.2.4 / §12.8.2.5 / §12.8.3 / §12.8.4 / §12.9 / §12.10 / §12.11 等)自 PR-6 起统一指向归档文件 `docs/archive/plans/architecture-v2-first-stage-blueprint.md §12.X`;新文档建议引用上面 "active 权威源" 列表,而非归档文件。

---

## 13. 其它 active 权威源(不在本文维护)

| 你想知道的事 | active 权威源 |
|---|---|
| **当前事实**(版本 / open PR / 已发能力 / surface 状态 / 当前债务 / 不做清单) | [`docs/current-state.md`](./docs/current-state.md) |
| **长期 AI 协作铁律**(命名 / Guard / 软删 / 错误码 / 密码 / DTO 分离 / 角色层级 / refresh token / §19.7 D-series 决策锁) | [`AGENTS.md`](./AGENTS.md) §1-§19 |
| **流程制度**(开工 checklist / PR 五档 / D 档降速 / release 收口 / AI 协作纪律 / 收尾报告) | [`docs/process.md`](./docs/process.md) |
| **V2 基线规范**(13 项 A 档) | [`docs/srvf-foundation-baseline.md`](./docs/srvf-foundation-baseline.md) |
| **V2 五档红线 / V2.x 复活路径** | [`docs/V2红线与复活路径.md`](./docs/V2红线与复活路径.md) |
| **API surface 长期边界** | [`docs/api-surface-policy.md`](./docs/api-surface-policy.md) |
| **架构边界 / 服务抽离决策**(Presenter / QueryService / PolicyService / StateMachine / AuditRecorder / Effect) | [`docs/architecture-boundary.md`](./docs/architecture-boundary.md) |
| **Participation 业务上下文边界图** | [`docs/participation-bounded-context.md`](./docs/participation-bounded-context.md) |
| **附件配置三表边界** | [`docs/attachment-config-boundary.md`](./docs/attachment-config-boundary.md) |
| **V2 数据模型** / **V2 接口契约** | [`docs/v2-data-model.md`](./docs/v2-data-model.md) / [`docs/v2-api-contract.md`](./docs/v2-api-contract.md) |
| **运行 / 部署 / 测试 / 安全 / 排错 SOP** | [`docs/development.md`](./docs/development.md) / [`docs/deployment.md`](./docs/deployment.md) / [`docs/testing.md`](./docs/testing.md) / [`docs/security.md`](./docs/security.md) / [`docs/ops/cos-production-rollout-checklist.md`](./docs/ops/cos-production-rollout-checklist.md) |
| **Claude Code 入口转发** | [`CLAUDE.md`](./CLAUDE.md)(收口为 ≤80 行入口转发) |

---

## 14. 历史架构归档索引

PR-6(2026-05-22)将原 ARCHITECTURE.md 1547 行设计期蓝图拆解归档,统一存于 `docs/archive/**`。归档文件**只代表归档时刻的决议**,不再作为当前规则依据;active 引用应指向 §13 列出的 active 权威源,而非以下归档文件。

| 归档文件 | 内容 | 原 ARCHITECTURE.md 章节 |
|---|---|---|
| [`docs/archive/legacy/architecture-v1-blueprint.md`](./docs/archive/legacy/architecture-v1-blueprint.md) | v1 蓝图原文 + 实施顺序附录 | §1 设计原则 / §2 技术栈 / §3 项目结构 / §4 v1 范围 / §5 数据模型 / §6 API 接口清单 / §7 命名与编码约定(7.1-7.11)/ §8 环境变量 / §9 升级路径(active 锚点已迁本文 §9)/ §10 部署 / 附录 实施顺序 |
| [`docs/archive/legacy/architecture-v1-1-hardening.md`](./docs/archive/legacy/architecture-v1-1-hardening.md) | V1.1 工程加固原文 | §11.1 - §11.7(active 摘要锚点已迁本文 §11) |
| [`docs/archive/plans/architecture-v2-first-stage-blueprint.md`](./docs/archive/plans/architecture-v2-first-stage-blueprint.md) | V2 派生项目方向原文 | §12.1 - §12.11(V2 第一阶段 Step 1-7 已于 v0.2.0 全部完成) |

历史 release handoff / 评审稿 / 批次决议 / Phase reviews / first-release 过程档案另存于 [`docs/archive/handoff/`](./docs/archive/handoff/) / [`docs/archive/reviews/`](./docs/archive/reviews/) / [`docs/archive/batches/`](./docs/archive/batches/) / [`docs/archive/plans/`](./docs/archive/plans/) / [`docs/archive/legacy/`](./docs/archive/legacy/),不再作为当前执行约束。

---

## 15. 本文不维护的事

- ❌ **不维护**当前版本号 / open PR / release 状态 / 已发能力清单(那是 [`docs/current-state.md`](./docs/current-state.md) 的职能)
- ❌ **不复制** [`AGENTS.md`](./AGENTS.md) 全文铁律(命名 / Guard / 软删 / 密码 / DTO / 角色层级 / refresh token / §19.7 决策锁全部在 AGENTS.md)
- ❌ **不维护**单批次评审稿 / 历史 handoff / PR 编号(那是 [`docs/archive/`](./docs/archive/) 的职能)
- ❌ **不维护**当前项目目录结构 / 模块清单(那是 [`docs/development.md`](./docs/development.md) + `src/modules/` 实际状态)
- ❌ **不维护**当前 API surface endpoint 清单(那是 [`docs/api-surface-policy.md`](./docs/api-surface-policy.md) + Swagger `/api/docs`)
- ❌ **不维护**V2 schema / 接口契约细节(那是 [`docs/v2-data-model.md`](./docs/v2-data-model.md) / [`docs/v2-api-contract.md`](./docs/v2-api-contract.md))
- ❌ **不维护**PR 分级 / 流程制度(那是 [`docs/process.md`](./docs/process.md))
- ❌ **不维护**Claude Code 入口转发(那是 [`CLAUDE.md`](./CLAUDE.md))

本文**只维护**:文档权威源分层(§0)/ 长期设计哲学(§1)/ 当前技术栈快照(§2)/ 项目结构与模块边界跳转(§3)/ v1 范围演进说明(§4)/ 数据模型权威源跳转(§5)/ API 接口清单跳转(§6)/ 命名与编码约定跳转表(§7)/ 环境变量跳转(§8)/ **升级路径触发表(§9,active 单一权威源)**/ 部署跳转(§10)/ **V1.1 工程加固摘要(§11,active 锚点)**/ V2 派生项目方向跳转(§12)/ 其它 active 权威源地图(§13)/ 历史架构归档索引(§14)/ 本文边界声明(§15)。

如本文与 [`docs/current-state.md`](./docs/current-state.md) / [`AGENTS.md`](./AGENTS.md) / [`docs/process.md`](./docs/process.md) 表述冲突,按 §0.1 权威源分层让步,**不**擅自调和;遇冲突先向用户汇报。
