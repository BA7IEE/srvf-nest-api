# AGENTS.md — 长期 AI 协作铁律主入口

> 给所有 **AI 编码助手 / Agent**(Claude Code、Cursor、GitHub Copilot Chat、Continue、Cline、其他 CLI / IDE Agent)看的项目工作铁律,从 `ARCHITECTURE.md` §7 与附录抽取并随 SRVF 派生演进。
>
> **本文件是长期 AI 协作铁律唯一主入口**。`CLAUDE.md` 自 v0.15.0 docs 治理收口起已收口为入口转发(≤80 行),不再维护独立规则副本。

---

## 权威源分层(冲突时按此顺序判定)

| 你想知道的事 | 第一时间读 |
|---|---|
| **当前事实**(版本、open PR、最新 release、surface 状态、当前债务) | [`docs/current-state.md`](docs/current-state.md) |
| **长期 AI 协作铁律**(本文件 §1-§20) | **本文件 `AGENTS.md`** |
| **API surface 长期边界**(/api/app/v1 / /api/v2 / root legacy + Mixed Controller 存量) | [`docs/api-surface-policy.md`](docs/api-surface-policy.md)(归档的设计期顶层规范见 [`docs/archive/plans/api-client-boundary-design-period.md`](docs/archive/plans/api-client-boundary-design-period.md)) |
| **Participation 业务上下文边界图**(activities / activity-registrations / attendances / contribution-rules 4 模块;不含 certificates) | [`docs/participation-bounded-context.md`](docs/participation-bounded-context.md) |
| **附件配置三表边界**(`AttachmentTypeConfig` / `AttachmentMimeConfig` / `AttachmentSizeLimitConfig` override-with-default;不合表 / 不抽 facade) | [`docs/attachment-config-boundary.md`](docs/attachment-config-boundary.md) |
| **架构边界铁律**(Presenter / QueryService / PolicyService / StateMachine / AuditRecorder / Effect 抽离决策;承接 §19.7 D-7 的 active execution policy) | [`docs/architecture-boundary.md`](docs/architecture-boundary.md) |
| **V2 基线规范 / 红线** | [`docs/srvf-foundation-baseline.md`](docs/srvf-foundation-baseline.md) / [`docs/V2红线与复活路径.md`](docs/V2红线与复活路径.md) |
| **流程制度**(开工 checklist / PR 五档 / release 收口) | [`docs/process.md`](docs/process.md) |
| **架构设计背景**(v1 蓝图 / V1.1 工程加固 / V2 §12) | [`ARCHITECTURE.md`](ARCHITECTURE.md)(请先读其顶部"当前阶段说明") |
| **历史 handoff / 评审稿 / 批次 / first-release 过程档案** | [`docs/archive/`](docs/archive/) — **历史证据,不再作为当前执行约束** |

**冲突顺序**(从高到低):
1. **当前事实**:[`docs/current-state.md`](docs/current-state.md) + 代码 + GitHub 当前状态
2. **长期铁律**:本文件 > [`srvf-foundation-baseline.md`](docs/srvf-foundation-baseline.md) > [`V2红线与复活路径.md`](docs/V2红线与复活路径.md) > [`api-surface-policy.md`](docs/api-surface-policy.md)
3. **流程制度**:[`docs/process.md`](docs/process.md)
4. **架构设计背景**:[`ARCHITECTURE.md`](ARCHITECTURE.md)
5. **历史证据**:[`docs/archive/`](docs/archive/) — 仅作为"为什么这么决议"的可追溯性参考

**铁律**:
- 除非用户明确要求,AI **不得**修改 `ARCHITECTURE.md`、`AGENTS.md`、`docs/srvf-foundation-baseline.md`、`docs/V2红线与复活路径.md`、`docs/api-surface-policy.md`
- 实现过程中发现文档与代码冲突时,**必须先暂停并说明**,不得擅自调和
- `archive/**` 内文档只代表归档时刻的决议;当前代码已演进,以 `src/**` + `docs/current-state.md` 为准

---

## 0. 修改代码前必读

- 通用 Agent 必读:`ARCHITECTURE.md` / `AGENTS.md`;如使用 Claude Code,还必须读 `CLAUDE.md`
- 任何不在 v1 范围内的新增功能(见 §1),**必须先暂停并说明原因,不得擅自实现**
- 执行 `prisma migrate dev` 前必须先说明将生成 / 执行的迁移内容并等待确认;生产环境只允许 `prisma migrate deploy` 已审查 migration
- **pnpm-only**:依赖安装与脚本执行统一使用 `pnpm`,禁止 `npm` / `yarn` / `bun`,避免 lockfile 漂移
- `@nestjs/swagger` 必须按其 `peerDependencies` 选择与当前 NestJS 主版本兼容的版本,**禁止手动钉死主版本号**(如硬写 `^7.x`),否则会出现 peer 警告并隐藏 schema bug
- 每次只实现一个阶段,不跨阶段提前写;每个阶段完成后必须 lint / typecheck / test,或至少启动服务验证
- **跨文件改动先按符号 / 引用链确认,再动手**:改 class / method / DTO / provider 注入链 / 调用点前,优先用 TypeScript 符号定义跳转 + 引用查找(LSP / IDE / `tsc`)确认目标的真实身份与全部调用点;`grep` 同名命中**只用于定位候选**,**禁止**仅凭字符串同名直接改(大项目里同名 method / DTO / 字段极易命中错符号,盲改会漏掉真正的调用点 / 注入链或误改无关同名符号)

---

## 1. v1 不做的事(刻意砍,需要时再加)

> **SRVF 派生项目读取规则**(v0.15.0 起 docs 治理收口):
> - 本仓库 `srvf-nest-api` 是 `u-nest-api-starter` 的派生项目;当前版本以 [`package.json`](package.json) `version` 字段为准、当前能力与 surface 状态以 [`docs/current-state.md`](docs/current-state.md) 为准。
> - 本节"v1 不做"在 SRVF 中按 **A / B / C 三档** 分类,不再是永久禁令;升级触发条件见 [`ARCHITECTURE.md §9`](ARCHITECTURE.md)。
> - 原属"不预先做"的条目(RBAC / refresh token / App API / 附件 Provider / audit_logs)已由真实业务诉求驱动解锁;**当前已解锁完整清单见 [`docs/current-state.md §2`](docs/current-state.md)**。
> - 当用户提出**真实业务需求 / 联调需求 / 上线风险 / 安全风险**时,AI **不得仅凭旧条目直接拒绝**,应进入评审解锁(说明状态 → 列出影响面 → 判断档位 → 给出最小评审方案 → 等用户拍板)。

### A. 已解锁(可正常使用与扩展)

已落地的能力(audit_logs / attachments + COS / RBAC / 本人改密 / refresh token + logout + logout-all / App API Phase 2 等)以 [`docs/current-state.md §2`](docs/current-state.md) 为权威清单源。本节不再逐项罗列实施 PR 状态;新增工作必须遵守:

- 涉及密码 / refresh token / access token / audit 写入 → 见 §9
- 涉及 App API / Mobile DTO / surface 边界 → 见 §2 + [`docs/api-surface-policy.md`](docs/api-surface-policy.md)
- 涉及 RBAC / Guard / 角色边界 → 见 §8 + §13
- 涉及职责类抽出(Presenter / QueryService / PolicyService / StateMachine / AuditRecorder / Effect)→ 见 §2 + [`docs/architecture-boundary.md`](docs/architecture-boundary.md)

### B. 默认不做,可评审解锁(真实需求触发评审)

- access token 即时吊销(`tokenVersion` 字段 / access token blacklist / JWT revoke list):沿 §9 P0-E + 15m access TTL 自然过期 + `JwtStrategy.validate` 每请求查库承接;诉求出现时按 [`docs/security.md` Token 吊销升级路径](docs/security.md) 单独立项
- RBAC 业务面全面接入(管理面已于 v0.15.0 P0-F 收紧,业务模块 / attachments 之外仍归 Slow-4 范围)
- 微信登录 / 小程序登录(业务明确需要时单独评审)
- 多租户(真实业务出现跨队隔离诉求时单独架构评审)
- Redis / queue / cron(异步任务诉求触发时评审,需评估运维承接;refresh token 撤销不引入 Redis,沿 DB 主键索引 sub-ms 查询承接)

### C. 当前阶段仍不做

- LLM / 向量检索 / pgvector(`modules/ai/` 保持 README 占位)
- 完整动态权限平台(permission 表 + 后台可配权限点 + casl)
- 复杂 session 管理 UI(多设备登录列表 / 强制下线某设备 / device fingerprint)
- refresh_tokens 查询接口(`GET /api/auth/refresh-tokens` 列本人活跃 token)
- 完整 OAuth 2.0 / OIDC / refresh token tree 复杂度
- 无真实需求的多租户提前设计
- 无运维承接能力的基础设施提前引入(Redis / queue / cron)

**永久铁律(不解锁)**:不引入 `LocalStrategy`(`username + password` 校验在 `auth.service.ts` 内手写)、不创建 `*.entity.ts`(本项目不是 TypeORM 项目)、不使用 Prisma 全局软删中间件 / client extension、**不缓存用户身份有效性状态**(`JwtStrategy.validate` 必每请求查库确认 `deletedAt + status`,确保禁用 / 软删用户下一请求即时失效;未触发 `ARCHITECTURE.md` §9 升级条件前)。**注**:`RbacCacheService`(`src/modules/permissions/rbac-cache.service.ts`)是 RBAC permission resolution cache,**不属于**用户身份有效性状态缓存,是已解锁能力,见 §8 末尾。

---

## 2. 模块结构:默认 4 文件基线 + 已解锁例外

业务模块**默认**以 4 文件为基线:

```
modules/<name>/
├── <name>.module.ts
├── <name>.controller.ts
├── <name>.service.ts
└── <name>.dto.ts
```

SRVF 派生项目已解锁以下例外。**执行细节以 [`docs/api-surface-policy.md`](docs/api-surface-policy.md)(surface 边界 / Mixed Controller 存量 / mobile-like endpoint 处置)+ [`docs/architecture-boundary.md`](docs/architecture-boundary.md)(职责类抽离触发条件)为长期权威**;本节只保留例外名称 + 不可变铁律。

**已解锁例外**:

- **Surface-specific Controller / DTO**:App / Mobile surface 用 `controllers/app-*.controller.ts` + `dto/app/` 子目录;Legacy 兼容入口用 `controllers/*-legacy.controller.ts`。新移动端 endpoint **只能**落 `/api/app/v1/*` 且必须建独立 Mobile Controller(详 [`api-surface-policy.md §2.1`](docs/api-surface-policy.md))
- **同模块内职责类抽出**(Presenter / QueryService / PolicyService / StateMachine / AuditRecorder / Effect 6 类):触发条件与边界规则见 [`architecture-boundary.md §3 / §6`](docs/architecture-boundary.md)
- **DTO 子目录**:单个 dto 文件超 300 行,允许拆同模块内 `dto/` 目录
- **health/ 例外**:`health/` 只有 `health.module.ts` + `health.controller.ts`

**不可变铁律**(违反任一视作越权):

- ❌ **禁止** `*.entity.ts`(本项目不是 TypeORM 项目)
- ❌ **禁止**跨模块公共目录(`common/utils/` / `shared-services/` / 任何 "common util grab-bag")
- ❌ **禁止**用 `extends` / `Pick` / `Omit` / `IntersectionType` / `PartialType` / `OmitType` 从 Admin DTO 派生 App DTO(沿 §19.7 D-6)
- ❌ **禁止**在未补 characterization tests 前拆 god-service(沿 [`api-surface-policy.md §7 P1-B`](docs/api-surface-policy.md) + [`current-state.md §4 P2`](docs/current-state.md))
- ❌ **不再新增 Mixed Controller**(class-level + 方法级双 `@ApiTags`);现存 6 处存量保留不扩展,详 [`api-surface-policy.md §5.1`](docs/api-surface-policy.md)
- ✅ 新业务模块**平铺**加在 `src/modules/` 下,**禁止**嵌套 `system/` / `business/` / `core/` 子目录

> **冲突顺序**:本节与 [`api-surface-policy.md`](docs/api-surface-policy.md) / [`architecture-boundary.md`](docs/architecture-boundary.md) 冲突时,以后者为准并回头同步本节;**不**允许"按 4 文件基线读"否决 surface 拆分既成事实。

---

## 3. 命名铁律

| 场景 | 错误 | 正确 |
|---|---|---|
| 密码字段 | `password`(model / response DTO) | `passwordHash`(仅 Prisma model 与 service 内部) |
| 文件标识 | `path` / `filename` / `url` | `key` |
| 角色判断 | `if (user.role === 'admin')` | `if (user.role === Role.ADMIN)` |
| 角色装饰器 | `@Roles('admin')` | `@Roles(Role.SUPER_ADMIN, Role.ADMIN)` |
| 错误抛出 | `throw new Error('用户不存在')` | `throw new BizException(BizCode.USER_NOT_FOUND)` |
| 时间字段 | `create_time` / `createTime` | `createdAt` |
| 主键 | 自增 int | `cuid()` 字符串 |
| 角色 / 状态枚举 | 手写 `users.enum.ts` | 从 `@prisma/client` 导入 `Role` / `UserStatus` |

`Role` / `UserStatus` 唯一来源是 Prisma schema:

```typescript
import { Role, UserStatus } from '@prisma/client';
```

### 字段校验铁律(DTO 层硬约束)

| 字段 | 入参 DTO 校验 | 入库前归一化 |
|---|---|---|
| `username` | `@Matches(/^[a-z0-9_-]{3,32}$/)`(小写字母+数字+下划线+中横线,3-32) | `trim()` + `toLowerCase()` |
| `email` | `@IsOptional()` + `@IsEmail()` | `trim()` + `toLowerCase()`;空字符串按未填写处理(写入前置 `null`,**不要**写空字符串入库) |
| `password` / `newPassword` | `@MinLength(8)`,必须含数字 + 字母 | 落库前必须 `bcrypt.hash()`,绝不裸传 Prisma |
| `nickname` | `@MaxLength(50)` | — |
| `avatarKey` | `@MaxLength(255)` | — |

`username` / `email` 的 `trim()` + `toLowerCase()` 必须在**入库前**和**所有查询前**统一执行,避免大小写账号或首尾空格账号并存(`Admin` 与 `admin` 同账号)。

---

## 4. 统一返回格式

所有接口经 `ResponseInterceptor` 包装为 `{ code: 0, message: 'ok', data }`。业务代码**只 `return data`**,永远不要手动包外层结构。

### 分页

入参固定使用 `PaginationQueryDto`,`page` / `pageSize` 命名固定,默认 `page=1` / `pageSize=20`,`pageSize` 最大 100。**禁止 `limit/offset` / `skip/take` / `cursor`**。Prisma 查询时换算 `skip = (page - 1) * pageSize`,`take = pageSize`。

出参固定 `PageResultDto<T>`(`items` / `total` / `page` / `pageSize`),禁止 `{ list, count }` / `{ rows, total }` 等变体。默认排序 `orderBy: { createdAt: 'desc' }`。

### `ResponseInterceptor` 跳过路径

用 `startsWith` 匹配以下前缀,匹配则不动响应体:`/api/docs`(自动覆盖 `/api/docs-json` / `/api/docs-yaml`)/ `/favicon.ico` / `/metrics` / 文件下载流响应。

**铁律:Swagger UI 与 OpenAPI JSON/YAML 永远不能被业务响应包装。** 实现完成后必须实际访问 `/api/docs` 与 `/api/docs-json` 验收。

`/api/health` **走包装**,不在跳过列表;controller 返回 `{ status: 'ok' }`,最终响应 `{ code: 0, message: 'ok', data: { status: 'ok' } }`。

---

## 5. 错误处理

### `BizCode` 三字段对象 + `BizException` 类型签名

- 集中维护在 `common/exceptions/biz-code.constant.ts`,每个 BizCode 必须同时携带 `code` / `message` / `httpStatus` 三字段,定义为 `as const`(示例:`USER_NOT_FOUND: { code: 10001, message: '用户不存在', httpStatus: HttpStatus.NOT_FOUND }`)
- `BizException` 构造参数类型锁死为 `(typeof BizCode)[keyof typeof BizCode]` 联合类型;**禁止**接收裸数字 / 字符串 / 临时对象(必须 `throw new BizException(BizCode.USER_NOT_FOUND)` 形式,不接受 `10001` / `'USER_ERROR'` / `{ code: 10099, ... }`)
- BizException 内 `super(biz.message)`,自动同步 message 到 Error.message

### `AllExceptionsFilter` 处理规则

- `BizException` → 读 `httpStatus`,响应 `{ code, message, data: null }` + 对应 HTTP status
- NestJS `HttpException` → 沿用其 HTTP status,`code` 用通用 BizCode(`BAD_REQUEST` / `UNAUTHORIZED` / `FORBIDDEN` / `NOT_FOUND` / `INTERNAL_ERROR`)
- 未知异常 → HTTP 500,`code` 为 `INTERNAL_ERROR`,生产环境不暴露 `error.message`

业务响应体始终 `{ code, message, data }` 三字段;HTTP status 始终保持语义。**禁止为了"统一"返回 HTTP 200。**

### BizCode 编码段

- `4xxxx` / `5xxxx`:**通用 HTTP 级错误**,与 HTTP status 段对齐(未登录 / 无权限 / 资源不存在 / 服务器错误)
- `100xx`:`users` 模块**业务级错误**(包含 `auth`,**`auth` 不单开段**;如登录失败 `LOGIN_FAILED=10004`、用户名 / 邮箱冲突)
- `101xx`:`users` 权限 / 操作边界错误
- `110xx`+:后续业务模块按 `orgs:110xx/111xx` / `missions:120xx/121xx` 平铺,每模块 200 个号段

**通用 token / 鉴权失败统一复用 `UNAUTHORIZED=40100`,不另起编号**:`JwtStrategy.validate()` 中 token 无效 / 已过期 / 用户被禁 / 用户被软删全部抛 `UNAUTHORIZED`。这类是 HTTP 401 通用语义,不是业务级错误;AI **禁止**为 `TOKEN_INVALID` / `TOKEN_EXPIRED` 之类自创 `100xx` 业务码。

**`100xx` 段位实数(锁死)**:10001 USER_NOT_FOUND / 10002 USERNAME_ALREADY_EXISTS / 10003 EMAIL_ALREADY_EXISTS / 10004 LOGIN_FAILED / 10005 OLD_PASSWORD_INVALID(P0-D) / 10006 NEW_PASSWORD_SAME_AS_OLD(P0-D) / **10007 REFRESH_TOKEN_INVALID**(P0-E,HTTP 401,详 §9 P0-E 子节 + [评审稿 §5.7](docs/archive/reviews/first-release-p0e-refresh-token-review.md))。10007 **仅占 1 个号位**:refresh 失败 4 种子原因统一返;**禁止**拆 `REFRESH_TOKEN_EXPIRED` / `REFRESH_TOKEN_REVOKED` / `REFRESH_TOKEN_REPLAY`(沿 §8 防账号枚举铁律精神)。

新增 BizCode 必须先说明使用场景与前端提示价值,确认后加入,显式声明 `httpStatus`。

### Prisma 错误转换

`P2002` 唯一约束错误必须显式捕获 `Prisma.PrismaClientKnownRequestError`(`err.code === 'P2002'`),根据 `err.meta?.target` 转为对应 `BizException`(`USERNAME_ALREADY_EXISTS` / `EMAIL_ALREADY_EXISTS`),不丢给全局过滤器兜底。**`err.meta?.target` 是 `string[]` 而非 `string`**,必须用 `target.includes('username')` 数组方法判断;**禁止** `target === 'username'`(多列复合唯一约束场景会漏判)。

---

## 6. Swagger 100% 覆盖

- 每个 Controller 方法必须 `@ApiOperation({ summary })`
- 每个 DTO 字段必须 `@ApiProperty({ description })`
- 需鉴权方法必须 `@ApiBearerAuth()`
- 响应类型按返回结构选用,**禁止裸写** `@ApiOkResponse({ type: Dto })`:
  - 单对象:`@ApiWrappedOkResponse(Dto)`
  - 数组:`@ApiWrappedArrayResponse(Dto)`
  - **分页:`@ApiWrappedPageResponse(Dto)`**(必须用此装饰器)
- 三个装饰器集中放在 `common/decorators/api-response.decorator.ts`
- `PageResultDto<T>` 是 TS 泛型,`@nestjs/swagger` 无法 reflect 泛型参数,因此分页接口**必须**用 `@ApiWrappedPageResponse(Dto)`,装饰器内部用 `getSchemaPath(Dto)` + `allOf` 显式描述 `data: { items, total, page, pageSize }`,否则前端 SDK 生成器拿到的是单对象 schema。需要在 controller 类上配套 `@ApiExtraModels(Dto, PageResultDto)`

---

## 7. 全局 ValidationPipe

`main.ts` 注册全局 `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`。`forbidNonWhitelisted` 保证 DTO 未声明字段直接报错;**禁止** controller 重复配置局部 `ValidationPipe`。

---

## 8. 权限与鉴权

### Guard 全局注册 + `@Public()` / `@Roles(...)` 互斥

- `JwtAuthGuard` + `RolesGuard` 通过 `AppModule.providers` 中 `APP_GUARD` 全局注册,顺序固定 `JwtAuthGuard` → `RolesGuard`(先验登录,再验角色);**禁止在 controller 上 `@UseGuards(...)`**
- 未标 `@Public()` 默认要登录;`@Public()` 与 `@Roles(...)` 互斥
- `RolesGuard` 看到 `@Roles(...)` 但 `request.user` 为空 → **拒绝访问**(抛 `BizException(BizCode.UNAUTHORIZED)`),不要因没拿到 user 就放行
- `JwtAuthGuard.canActivate` 用 `reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [handler, class])`,命中 `@Public()` 直接返 true,否则走 `super.canActivate`;`@Public()` 装饰器 `SetMetadata(IS_PUBLIC_KEY, true)`,常量与装饰器同文件导出

### 登录

- v1 入参固定 `username + password`(不支持 email / 手机号 / 验证码登录)
- `username` 入库与查询前统一 `trim()` + `toLowerCase()`
- 校验在 `auth.service.ts` 内手写:`findFirst` → `bcrypt.compare` → `JwtService.sign`
- **不引入 `LocalStrategy`**
- 登录成功后**顺手更新** `lastLoginAt = new Date()`;更新失败只 `logger.warn`,**不阻断登录响应**(避免一次写库失败把登录链路挂掉);v1 不做 `login_logs` 表
- `userSafeSelect` 与 `UserResponseDto` 必须包含 `lastLoginAt` 字段,管理后台用于查看账号活跃度

### 登录失败防账号枚举

四场景统一抛 `BizException(BizCode.LOGIN_FAILED)`,响应 `{ code: 10004, message: '账号或密码错误', data: null }` + HTTP 401,**完全相同**:`username` 不存在 / `password` 错误 / 账号已禁用(`status=DISABLED`)/ 账号已软删除(`deletedAt != null`)。

禁止在登录接口区分提示"账号不存在""密码错误""账号被禁用",任何字段差异(包括 message 文案、错误码细分、响应耗时显著差异)都视为枚举漏洞。

**Timing 防御铁律**:`username` 不存在时**也必须**跑一次 `bcrypt.compare(password, dummyHash)`(用一个预先生成、模块级常量化的固定 dummy hash),保证四场景的响应耗时一致。**禁止** `if (!user) throw LoginFailed` 这类早返回——`bcrypt.compare` 是慢操作(~50ms 量级),早返回会让"账号不存在"明显比"密码错误"快几十毫秒,攻击者据此可枚举有效账号(timing oracle 攻击)。

### JwtPayload 最小

`JwtPayload` 仅含 `sub: string`(user.id)+ `username: string`;**不塞 `role`,不塞完整用户对象**。

### 查库唯一位置

`JwtStrategy.validate()` 每次请求根据 `payload.sub` 查库,校验 `deletedAt === null && status === UserStatus.ACTIVE`。校验失败(token 无效 / 已过期 / 用户不存在 / 用户被禁用 / 用户已软删除)统一抛 `BizException(BizCode.UNAUTHORIZED)`。

`validate()` 返回的对象由 passport 自动挂到 `request.user`。`JwtAuthGuard` 不要再写一份查库逻辑。

### 两阶段错误码区分

| 阶段 | 触发位置 | 错误码 | code | message |
|---|---|---|---|---|
| 登录阶段 | `auth.service.ts` 校验 `username + password` 失败 | `LOGIN_FAILED` | 10004 | 账号或密码错误 |
| 已登录请求 | `JwtStrategy.validate()` token / 用户状态失败 | `UNAUTHORIZED` | 40100 | 未登录或登录已失效 |

两者 HTTP status 都是 401,**前端必须按 `code` 区分**(避免管理员重置密码后旧 token 失效被前端当成"登录表单密码错")。

### `CurrentUser` 类型

`CurrentUser` 含 `id: string` / `username: string` / `role: Role` / `status: UserStatus`(由 `JwtStrategy.validate` 查库后挂到 `request.user`)。**权限判断必须使用本次查库得到的 `role`,不得信任 token payload 中的角色信息**。

### 不缓存用户身份有效性状态

**禁止**缓存"该 user 当前是否 ACTIVE / 是否被软删 / 是否被禁用"这层身份有效性状态。`JwtStrategy.validate()` 必须每请求查库确认 `deletedAt === null && status === ACTIVE`,确保**禁用 / 删除用户能在下一次请求即时失效**。每请求查库是有意设计:主键索引 sub-millisecond 级,远不是瓶颈;换来"被禁用户即时失效"。升级条件见 `ARCHITECTURE.md` §9(用户校验耗时 >20% 或单表 QPS > 1000 才考虑 Redis 短 TTL 缓存)。

### RBAC permission resolution cache(不缓存身份原则的唯一例外)

[`RbacCacheService`](src/modules/permissions/rbac-cache.service.ts) 是 **`rbac.can()` 权限解析缓存**(`RolePermission` join 结果),**不**属于身份有效性状态缓存。约束:显式 TTL `RBAC_CACHE_TTL_SECONDS=1800`(从 [`app.config.ts`](src/config/app.config.ts) 注入,**禁止**硬编码);三档显式失效路径 `invalidateAll` / `invalidateUser` / `invalidateRole` 与 `RolePermission` / `UserRole` / `RbacRole` 变更 1:1 绑定;缓存层故障**保守降级**,不阻断 `rbac.can()` 主路径;**不**替代 `JwtStrategy.validate` 每请求查库;**不**引入 Redis / 外部 KV(沿 §1 B 档),当前实现为进程内 Map + TTL。

---

## 9. 密码处理铁律

| 出现位置 | `password` | `passwordHash` |
|---|---|---|
| Prisma model | ❌ | ✅ 唯一允许 |
| 响应 DTO | ❌ | ❌ |
| 请求 DTO | ✅ (`password` / `newPassword`) | ❌ |
| service 内部 | ✅(只能从请求 DTO 读取,落库前必须哈希) | ✅ |

- v1 默认 `bcryptjs`,salt rounds 固定 `10`
- 安装:`pnpm add bcryptjs` + 类型 `pnpm add -D @types/bcryptjs`
- 统一 import:`import * as bcrypt from 'bcryptjs'`
- DTO 校验:密码至少 8 位 + 含数字 + 字母
- service 接收 `password` 后**入库前必须** `bcrypt.hash()`,绝不裸传 Prisma
- 响应 DTO 通过 `userSafeSelect` 排除 `passwordHash`,任何接口响应里都不应出现该字段
- `POST /api/users` **必须由调用方传 `password`**,禁止后端生成默认密码或留空
- `PUT /api/users/:id/password` 接收 `ResetUserPasswordDto { newPassword }`,**不需要 `oldPassword`**,但必须走 `assertCanManageUser`
- 管理员重置密码后**不主动吊销 access token**(access ≤ 15m 自然过期);**必须主动撤销目标用户全部 refresh token**(详 §9 P0-E 联动撤销四场景);如需立即阻断 access token,由管理员把目标用户 `status` 改 `DISABLED`(经每请求查库即时生效)
- **本人自助改密只能通过独立接口** `PUT /api/users/me/password`(v0.13.0 已落地,行为冻结于 [P0-D 评审稿](docs/archive/reviews/first-release-p0d-change-my-password-review.md));**不得**在 `PATCH /api/users/me` 或其他资料更新接口里夹带"顺手改密码"逻辑;管理员重置他人密码接口 `PUT /api/users/:id/password` 契约保持不变
- 本人改密接口入参固定 `ChangeMyPasswordDto { oldPassword, newPassword }`(`oldPassword` 必填,与管理员重置无 `oldPassword` 的语义对称区分);`newPassword` 沿 `ResetUserPasswordDto.newPassword` 范式(至少 8 位 + 数字 + 字母);严格白名单,**禁止**夹带 `username` / `email` / `role` / `status` / `passwordHash` / `id` 任何其他字段
- 本人改密新增 BizCode:`OLD_PASSWORD_INVALID = 10005`(HTTP 401)、`NEW_PASSWORD_SAME_AS_OLD = 10006`(HTTP 400);**禁止**复用 `LOGIN_FAILED` 或 `BAD_REQUEST` 兜底语义
- 本人改密接口必须挂 `@PasswordChangeThrottle()`(IP 5/60 秒;沿 §17 `@nestjs/throttler` 内存 storage,**禁止** Redis;limit / ttl 从 `src/config/app.config.ts` 注入,**禁止**硬编码在装饰器)
- 本人改密成功必须写 audit `AuditLogEvent.UserPasswordChangedSelf`;**禁止**把 `oldPassword` / `newPassword` / `passwordHash` 任何明文或 hash 写入 audit
- 本人改密成功后**不主动吊销 access token**;**必须主动撤销该用户全部 refresh token**(详 §9 P0-E 联动撤销四场景);`tokenVersion` **不做**,沿 §1 B 档
- 用户被 `DISABLED`(`PATCH /api/users/:id/status` → `DISABLED`)或被软删(`DELETE /api/users/:id`)时,**必须**主动撤销目标用户全部 refresh token(详 §9 P0-E 联动撤销四场景);access token 由 `JwtStrategy.validate` 每请求查库即时失效
- 本人改密接口**不做**首次登录强制改密、忘记密码 / 邮箱找回、user-member 绑定能力;这些越界诉求出现时必须暂停说明

### P0-E refresh token 鉴权铁律(v0.14.0 落地,行为冻结)

> 本子节是 P0-E refresh token / logout / logout-all 闭环已落地后的不可变行为约束(v0.14.0 发布 2026-05-17T19:16:06Z)。详细设计冻结于 [`docs/archive/reviews/first-release-p0e-refresh-token-review.md`](docs/archive/reviews/first-release-p0e-refresh-token-review.md);冲突时以评审稿 + 当前代码为准,本节让步。

**refresh token 生成与存储**:
- 由 `crypto.randomBytes(32).toString('base64url')` 生成(256 bit 熵 opaque random token,**非** JWT,客户端不可解析);**禁止** JWT / UUID / 自增 ID / `Math.random`
- 明文**绝不入库**;DB 仅存 `tokenHash = sha256(raw).digest('hex')`(64 字符 hex,字段 `tokenHash @unique`);**禁止** bcrypt / argon2(高熵随机串无暴破语义,sha256 sub-ms 性能远优)
- 明文**绝不**进入:日志 / audit `context.*` / OpenAPI 示例 / 测试 fixture / 快照 / 文档 / handoff / release notes;只在 login / refresh 接口响应体 `data.refreshToken` 中出现一次

**JWT payload 严格 zero drift**:
- `JwtPayload` 严格保持 `{ sub, username }` + `iat / exp / nbf` 标准字段;**禁止**新增 `role` / `permissions` / `tokenVersion` / `tv` / `jti` / `email` / 任何业务字段
- `JwtStrategy.validate` 严格 `select: { id, username, role, status, memberId }`;**禁止**读 `passwordHash` / `tokenVersion`(后者不存在);校验仅 `deletedAt === null && status === ACTIVE`
- e2e `auth-login.e2e-spec.ts` 硬断言 payload 字段集恰好为 `{ sub, username, iat, exp, nbf }`,**禁止**改此断言

**DTO / Response 契约**:
- `LoginDto` 入参 schema 严格 **zero drift**(字段名 / 类型 / `@Matches` / `@MinLength` / `@MaxLength` 全保留);**禁止**新增任何字段(`rememberMe` / `deviceId` / `clientId` / `keepSignedIn` 等)
- `LoginResponseDto` 字段集恰好 5 项(v1 基础 + `refreshToken: string` + `refreshExpiresAt: string`);**禁止**再增
- `refreshExpiresAt` 是 **ISO 8601 UTC 时间字符串**(`new Date(...).toISOString()`,示例 `"2026-08-16T00:00:00.000Z"`),**不是 TTL**;语义是 family **absolute expiration 时刻**;rotation 后新 token 继承同一个 `refreshExpiresAt`,**禁止** sliding / refresh-on-use 延期。服务端 env `JWT_REFRESH_EXPIRES_IN`(TTL)与响应字段职责分离
- `RefreshTokenDto` / `LogoutDto` 严格白名单 1 字段(`refreshToken`);**禁止**夹带 `deviceId` / `userId` / 其他字段

**rotation 与 expiration 三不变式**:
- **rotation always**:每次 `POST /api/auth/refresh` 必发新 token + 旧 refresh 同事务内标 `rotatedAt + revokedAt + replacedById`
- **absolute expiration**:`expiresAt` 不延长,严格继承 family 首个 token;refresh TTL `90d`;达到 `refreshExpiresAt` 后必须重新登录(`POST /api/auth/login`),refresh 接口对已过期 family 返 `REFRESH_TOKEN_INVALID=10007`
- **reuse detection 触发 family revoke**:收到 `rotatedAt != null` 的 row(旧 raw 被重放)→ 同事务内 `updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: now(), revokedReason: 'family-revoked' } })`,然后抛 `REFRESH_TOKEN_INVALID`

**logout 行为契约**:
- `POST /api/auth/logout` 走 `@Public()`(refresh token 自身即凭证),只撤销**当前** refresh token(`revokedReason='logout'`,其他 rotation 链 token 不动);**幂等**(不存在 / 已撤销 / 已过期 → 仍返 200,沿 RFC 7009 §2.2),**不**抛业务码;access token 若随头传入**不**校验、**不**消费、**不**吊销
- `POST /api/auth/logout-all` 走 `JwtAuthGuard`,撤销当前 user 全部未过期且未撤销的 refresh token(`updateMany revokedReason='logout'`);返 `{ revokedCount }`

**联动撤销四场景**(沿 §9 主条目;`updateMany` 必须**同事务**内与主写操作执行,沿 `prisma.$transaction` 范式;audit `extra.refreshTokensRevoked: count` 必写):本人改密 → `'self-password-change'` / 管理员重置 → `'admin-password-reset'` / 用户禁用 → `'admin-disable'` / 用户软删 → `'admin-delete'`

**access token 行为锁定**:
- **不主动吊销**;依赖 `JWT_EXPIRES_IN=15m` 自然过期 + `JwtStrategy.validate` 每请求查库阻断 `DISABLED` / 软删用户
- access token blacklist / JWT revoke list **不做**(沿 §1 C 档);未来"改密后所有 access 立即失效"诉求出现时沿 §1 B 档 `tokenVersion` 路径单独评审
- e2e `users-change-my-password.e2e-spec.ts §7.5` "改密后旧 access token 仍可调 `/me`" 反向锁定断言**保留不破**

**限流契约**:
- `POST /api/auth/refresh`:独立 throttler `'refresh'`,IP **30 次 / 60 秒**;装饰器 `@RefreshThrottle()`(纯 metadata,limit / ttl 在 `throttle-options.ts` 从 `app.config.ts` 注入)
- `POST /api/auth/logout`:**无限流**(刻意;避免攻击者吃光合法 logout 配额)
- `POST /api/auth/logout-all`:复用 `'password-change'` throttler(IP 5/60);沿"高危操作低频限流"语义
- 三 throttler(`default` / `password-change` / `refresh`)**物理隔离**:登录失败爆破不消耗 refresh / logout-all 配额,反之亦然
- 命中走 `BizException(BizCode.TOO_MANY_REQUESTS)` + HTTP 429;**不暴露** `Retry-After` / `X-RateLimit-*` 头(沿 [`src/bootstrap/throttle-options.ts`](src/bootstrap/throttle-options.ts) `setHeaders: false`)

**audit 写入**(5 事件,kebab-case `<resource>.<action>` / `<resource>.<action>.<scope>`):
- 事件:`auth.login`(`extra.familyId`)/ `auth.refresh`(`extra.familyId / replayDetected / familyRevoked?`)/ `auth.logout`(`extra.found: boolean`,含幂等命中均写)/ `auth.logout-all`(`extra.revokedCount: number`)/ `password.reset.by-admin`
- `extra` **禁止**写:refresh token 明文 / `tokenHash` / `passwordHash` / IP 完整段(IP 已在 `AuditContext.ip`)
- `extra` **允许**写:`familyId`(cuid) / `replayDetected: boolean` / `revokedCount: number` / `revokedReason` 字符串 / `found: boolean`

**BizCode 段位(锁死)**:
- `REFRESH_TOKEN_INVALID = 10007`(HTTP 401);沿 100xx users 段,LOGIN_FAILED=10004 / OLD_PASSWORD_INVALID=10005 / NEW_PASSWORD_SAME_AS_OLD=10006 之后下一可用号位
- refresh 失败 4 种子原因(不存在 / 已撤销 / 已过期 / 重放命中)统一返 10007;**禁止**拆 `REFRESH_TOKEN_EXPIRED` / `REFRESH_TOKEN_REVOKED` / `REFRESH_TOKEN_REPLAY`(沿 §5 + 评审稿 v1 D-6;细分让攻击者据错误码反推 token 状态,违 §8 防账号枚举铁律精神)
- logout / logout-all **不**抛业务码(logout 幂等;logout-all 走通用 40100 / 42900)

**不做清单**(沿评审稿 v1 D-9):
- ❌ `tokenVersion` 字段 / access token blacklist / JWT revoke list / refresh_tokens 查询接口 / 已登录设备列表 UI / 单设备管理 / device fingerprint
- ❌ Redis / Queue / Cron(refresh token 撤销靠 DB 主键索引 sub-ms 查询)
- ❌ 完整 OAuth 2.0 / OIDC / refresh token tree / httpOnly cookie 传 refresh token(多端 Web + 小程序 + APP 统一 body 传)
- ❌ 改 `LoginDto` / `JwtPayload` / `JwtStrategy` 查库字段(沿 v2-api-contract §6.5 + 本节铁律)
- ❌ refresh token 失败码细分 / 微信小程序 / OAuth 第三方登录

---

## 10. 软删除

不使用 Prisma 全局软删除中间件 / client extension。在 `users.service.ts` 内封装 `notDeletedWhere<T>(where)` 工具(返回 `{ ...where, deletedAt: null }`),所有过滤场景统一调用。

- **禁止** `prisma.user.delete()`,删除走 `update({ deletedAt: new Date(), status: UserStatus.DISABLED })`
- 所有非"管理员看回收站"查询经 `notDeletedWhere()` 过滤
- 业务详情查询禁用 `prisma.user.findUnique()`,统一 `findFirst({ where: notDeletedWhere(...) })`
- `seed` / 创建 / 更新用户的 `username` / `email` 唯一性预检查**必须**用 `findUnique`(包含软删记录),**禁止**用 `findFirst + notDeletedWhere`——软删后 `username` / `email` 不复用,唯一性预检查的目的就是检测包含软删在内的全部占用;若用 `notDeletedWhere` 过滤,软删占用会通过预检查,落库时撞 unique index 报 P2002,前端拿到一个本可前置友好提示的服务器侧异常
- `findById` 找不到(含已软删)统一抛 `BizException(BizCode.USER_NOT_FOUND)`
- 访问已删除用户的详情 / 修改 / 重置密码 / 改角色 / 改状态 / 删除接口,统一表现为用户不存在
- 登录路径额外校验 `status === ACTIVE`,不只 `deletedAt === null`
- v1 不提供恢复接口

---

## 11. DTO 与 Prisma 类型严格分离

- 入参 DTO 带 `class-validator` 装饰器
- 出参 DTO `UserResponseDto` 显式列出对外字段(永不含 `passwordHash`,**必须包含** `lastLoginAt`)
- Prisma 生成的 `User` 类型仅在 service 内部用,**绝不直接返给 controller / 前端**
- `User` 对外返回必须使用集中定义的 `userSafeSelect`(在 `modules/users/users.select.ts`)
- `UserResponseDto` 与 `userSafeSelect` **必须同步维护**:增删字段时同时改两边
- 禁止 `*.entity.ts`

### 入参 DTO 字段白名单(纵深防御)

`forbidNonWhitelisted: true` 是兜底,DTO 自身白名单是第一道防线;一旦 DTO 多声明一个字段,纵深防御直接破口。

- **`UpdateMyProfileDto`**(`PATCH /api/users/me`):仅允许 `nickname` / `avatarKey`。**禁止**包含 `username` / `email` / `password` / `newPassword` / `oldPassword` / `passwordHash` / `role` / `status` / `deletedAt` / `id` / `lastLoginAt` 等任何字段;本人自助改密必须走独立接口 `PUT /api/users/me/password`(铁律见 §9)
- **`UpdateUserDto`**(`PATCH /api/users/:id`,管理员改用户资料):**禁止**包含 `role` / `password` / `passwordHash` / `status` / `deletedAt` / `id`。角色修改走 `PATCH /api/users/:id/role`,密码重置走 `PUT /api/users/:id/password`,启用 / 禁用走 `PATCH /api/users/:id/status`,软删除走 `DELETE /api/users/:id`,**绝不在更新资料接口里夹带**
- **`CreateUserDto.role`** 可选,**禁止**直接透传给 Prisma;必须经业务层根据当前用户角色校验后再决定写入值(见 §13)

### `IdParamDto` 字符串校验

所有 `:id` 路径参数都通过 `IdParamDto` 校验:`@IsString()` + `@Length(8, 64)`(长度校验,不写死 cuid 正则)+ `@ApiProperty({ example: 'cl9z3a8b00000abcd1234efgh' })`。**禁止** `@Param('id', ParseIntPipe)` / `id: number` / `@IsInt()`。

---

## 12. 事务

`prisma.$transaction` 必须用于:

- 多个写操作
- 先检查再写入的关键业务
- 管理员保护类操作(删除 / 禁用 / 降级 super admin)

**"检查剩余活跃 super admin 数 + 执行更新" 必须在同一事务内**,避免并发请求破坏"至少一个活跃 super admin"的不变式。

不需要事务:单表只读、单条普通资料更新且不依赖检查结果维护不变式。

---

## 13. 角色层级与管理员保护

层级固定:`SUPER_ADMIN > ADMIN > USER`。三层 Role **不是 RBAC**,不要扩展 permission 表 / `user_roles` 多对多 / `casl`。

### 管理边界

- v1 只有 `prisma/seed.ts` 能创建 `SUPER_ADMIN`;业务 API **禁止**创建 `SUPER_ADMIN`
- `SUPER_ADMIN` 业务 API 创建用户只允许 `role=ADMIN | USER`
- `ADMIN` 调用创建接口最终只能创建 `USER`;显式传 `ADMIN` / `SUPER_ADMIN` 抛 `FORBIDDEN_ROLE_OPERATION`
- `ADMIN` 只能管理 `USER`,不能查看 / 修改 / 禁用 / 删除 / 降级 / 创建 `ADMIN` / `SUPER_ADMIN`
- `USER` 只能访问本人接口

### 双层校验

**Guard 管入口,Service 管业务**:Guard 层 `@Roles(Role.SUPER_ADMIN, Role.ADMIN)` 只决定谁能进管理接口;Service 层必须经统一 `assertCanManageUser(currentUser, targetUser)` 二次校验"能操作谁"——SUPER_ADMIN 总通过,ADMIN 只能管理 USER,其余抛 `BizException(BizCode.FORBIDDEN_ROLE_OPERATION)`。**禁止**在 service 散落手写 `currentUser.role === ...` 角色比较绕过此函数。

以下接口必须先 `findFirst` 查出目标用户,再 `assertCanManageUser`:`GET /api/users/:id` / `PATCH /api/users/:id` / `PUT /api/users/:id/password` / `PATCH /api/users/:id/role` / `PATCH /api/users/:id/status` / `DELETE /api/users/:id`。

### 自我保护(防误操作)

`id === currentUser.id` 时拒绝以下操作,抛 `BizException(BizCode.CANNOT_OPERATE_SELF)`:`DELETE /api/users/:id` / `PATCH /api/users/:id/status`(改 `DISABLED`)/ `PATCH /api/users/:id/role`。

`PATCH /api/users/:id` 永远不接受 `role` 字段;角色修改必须走 `PATCH /api/users/:id/role`。

### 最后一个 SUPER_ADMIN 保护(防代码漏洞)

任何"剥夺超级管理员权限"操作前,在同一 `prisma.$transaction` 内查询剩余活跃 super admin 数并执行更新,确保操作后剩余 ≥ 1,否则抛 `BizException(BizCode.LAST_SUPER_ADMIN_PROTECTED)`。适用接口(当且仅当目标用户当前是 super admin 时检查):`DELETE /api/users/:id` / `PATCH /api/users/:id/status`(改 `DISABLED`)/ `PATCH /api/users/:id/role`(改 `ADMIN` 或 `USER`)。

### 用户列表可见范围

`SUPER_ADMIN`:可看全部(`SUPER_ADMIN` / `ADMIN` / `USER`);`ADMIN`:只能看 `USER`;`USER`:不能进入管理列表。

### 字段透传安全

`CreateUserDto.role` 可选,不传默认 `USER`,**禁止把 role 从 DTO 直接透传给 Prisma**;必须经业务层根据当前用户角色校验后再决定写入值。

### SUPER_ADMIN 之间互操作(v1 设计选择)

v1 允许 `SUPER_ADMIN` **互相管理**(重置密码 / 禁用 / 改角色 / 软删除),仅受 §13 **自我保护** + **最后一个 SUPER_ADMIN 保护** 两层约束。即:`SUPER_ADMIN A` 操作 `SUPER_ADMIN B` 全部允许(剩余活跃 super admin ≥ 1 时);`SUPER_ADMIN A` 对自己执行任一上述操作命中自我保护拒绝。

这是**明确选择,不是疏漏**:v1 默认只有一个 SUPER_ADMIN(`prisma/seed.ts` 创建),互操作是低频运维场景;禁止互操作会导致"前任 SUPER_ADMIN 离职后无法被接任者接管"的死锁。真出现"SUPER_ADMIN 互不可操作"诉求按 `ARCHITECTURE.md §9` 升级路径处理(**作为权限模型升级**,不是渐进改造)。

AI **禁止**凭直觉额外加"SUPER_ADMIN 互不可操作"校验,**禁止**在 `assertCanManageUser` 里把 `targetUser.role === Role.SUPER_ADMIN` 列为禁止条件。

---

## 14. 配置文件归属

**归属铁律**:`APP_PORT` / `APP_ENV` / `APP_CORS_ORIGIN` / `ENABLE_SWAGGER` → `src/config/app.config.ts`;`DATABASE_URL` → `src/config/database.config.ts`;`JWT_SECRET` / `JWT_EXPIRES_IN` → `src/config/jwt.config.ts`;`SUPER_ADMIN_*` **不进 config**,仅 `prisma/seed.ts` 内 `process.env` 直读(显式例外)。

- 业务代码与 service **不直接 `process.env.XXX`**,统一通过对应 `*.config.ts` 注入(`SUPER_ADMIN_*` 是唯一例外)
- 不为 CORS / Swagger / 单一开关再单建 `cors.config.ts` / `swagger.config.ts`
- 新增环境变量先决定归属,再同步加进 `.env.example` 与启动强校验
- **业务判断只用 `APP_ENV`,禁止混用 `NODE_ENV`** 做业务配置判断;`NODE_ENV` 只留给框架与工具链(NestJS / Prisma / Webpack)内部使用

### 启动强校验铁律(production fail-fast,禁止 fallback 默认值兜底)

应用启动时必须强校验,任一不满足直接抛错退出:

- `APP_ENV` 必须 ∈ `{ development, test, production }`
- `JWT_SECRET` 至少 32 字符;**production 下不允许等于 `.env.example` 默认值** `please-change-me-in-production-min-32-chars`(推荐 `openssl rand -base64 48` 生成);**密钥绝不进日志 / audit / 响应**
- `APP_CORS_ORIGIN` production 下**禁止**为空 / **禁止** `*`,必须显式列出前端域名;解析支持英文逗号分隔多 origin(`split(',').map(trim).filter(Boolean)`)
- `ENABLE_SWAGGER` **必须严格字符串判断 `=== 'true'`**(**禁止** `Boolean(process.env.ENABLE_SWAGGER)` 或 truthy 判断,否则字符串 `'false'` 会被误判为开启);Swagger 开关公式 `APP_ENV !== 'production' || ENABLE_SWAGGER === 'true'`
- `prisma/seed.ts` 额外校验:`SUPER_ADMIN_USERNAME` 必须符合 username 格式(小写字母+数字+下划线+中横线,3-32);**production 下禁止** `SUPER_ADMIN_USERNAME=admin` 或 `SUPER_ADMIN_PASSWORD=ChangeMe123456`(`.env.example` 默认值);对应用户已存在时**不覆盖**密码 / 角色 / 邮箱,只打印提示

---

## 15. 历史实施顺序归档

v1 骨架搭建实施顺序已于 v0.1.x 完成,原文已归档至 [`docs/archive/legacy/agents-historical-design-period.md`](docs/archive/legacy/agents-historical-design-period.md)。当前阶段顺序与开工节奏以 [`docs/process.md §2-§5`](docs/process.md) + [`docs/current-state.md`](docs/current-state.md) 为准;架构蓝图见 [`ARCHITECTURE.md`](ARCHITECTURE.md)。

---

## 16. 测试策略

- v1 初始搭建不强制 E2E,不阻塞骨架
- `auth` / `users` 稳定后优先引入 E2E
- E2E 必须断言统一响应格式;错误响应必须**同时断言 HTTP status code 与 `BizCode.httpStatus` 一致**
- 登录失败必须覆盖**防账号枚举四场景**(`username` 不存在 / `password` 错 / 已禁用 / 已软删除),响应体与 HTTP status 完全相同
- E2E 优先覆盖:登录、JWT 鉴权、用户 CRUD、角色边界、软删除、禁用用户、最后一个 SUPER_ADMIN 保护、唯一约束冲突

---

## 17. V1.1 历史规则归档

V1.1 工程加固阶段(`nestjs-pino` / `@nestjs/throttler` / `helmet` / `@nestjs/terminus` / 优雅关闭 / GitHub Actions CI / Dockerfile 多阶段)已收口于 v0.7.0 之前;原 §17.1-§17.10 全段已归档至 [`docs/archive/legacy/agents-historical-design-period.md`](docs/archive/legacy/agents-historical-design-period.md)。

当前工程铁律承接者:**选型 / 健康检查 / 优雅关闭 / 登录限流** → [`ARCHITECTURE.md §11`](ARCHITECTURE.md);**`TOO_MANY_REQUESTS=42900` / 日志屏蔽 / 验收门槛** → [`docs/srvf-foundation-baseline.md`](docs/srvf-foundation-baseline.md);**限流不暴露阈值 / `Retry-After` / 统一过滤器** → 本文件 §5 + §8;**PR 分级 / D 档降速 / 收尾报告** → [`docs/process.md`](docs/process.md);**当前已落地能力** → [`docs/current-state.md §2`](docs/current-state.md)。

---

## 18. V2 设计纪律(当前仍有效部分)

V2 早期调研 / 设计阶段过程性约束(原 §18.1 / §18.2 / §18.3 / §18.5 / §18.6 / §18.7)已随批次 5-A / 6 / 7 / 8 + P0-* 落地完成其阶段使命,原文已归档至 [`docs/archive/legacy/agents-historical-design-period.md`](docs/archive/legacy/agents-historical-design-period.md)。下列子节(§18.4 / §18.4.1)是**长期仍生效**的设计纪律,保留原小节编号,以本节为权威源,适用任何 AI Agent / 自动化工具(不限工具链)。

### 18.4 协作纪律与敏感信息字段三问(精简自原 §18.4)

- **敏感信息字段三问**:涉及身份证 / 紧急联系人 / 医疗 / 证件照等敏感字段,**纳入任何 schema / DTO / 草案之前**必须先单独回答三问 ——
  1. **业务用途**:服务于哪个具体业务流程?
  2. **查看角色**:哪些角色 / 权限点可见?默认掩码策略是什么?
  3. **保存期限**:保留多久?是否需要"队员退队 → 清理"的处理?

  任何"先占位以后再用 / 先存着规则以后补"在敏感字段场景下视作越权。
- **不假设合规方案**:涉及敏感字段必须单独提问,不假设默认合规方案。
- **字典 seed 真实内容**:由用户**私下提供**,不进公共仓库历史。
- **冲突暂停铁律**:发现 v1 / V1.1 铁律 / baseline / V2 红线与新诉求冲突 → **必须暂停说明**,不擅自调和。

### 18.4.1 baseline 规范的强制读取与遵守

任何 Agent 在 V2 草案 / 开发场景下动手之前,**必须**读取并遵守 [`docs/srvf-foundation-baseline.md`](docs/srvf-foundation-baseline.md)(自 commit `16876fe` 起锁定)承载的 13 项 A 档基线规范(BizCode 段位 / 命名 / 响应包装 / DTO 白名单 / 模块结构 / 错误码命名 / 配置归属 / 日志屏蔽 / Guard / 软删除 / v1 兼容性 / 时区 / 验收门槛)。

冲突优先级见 baseline §14.4。**违反 baseline 任一项视作越权**,必须暂停并向用户说明,**禁止**自行调和。

---

## 19. API Client Boundary 决策锁

API Client Boundary 设计期(Phase 0)过程性约束(原 §19.1 ~ §19.6)已随 Phase 0 设计期 + Phase 1A Swagger Tag 重命名(v0.15.0)+ Phase 2 完整 15 endpoint(P2-0 ~ P2-8)落地完成其阶段使命,原文已归档至 [`docs/archive/legacy/agents-historical-design-period.md`](docs/archive/legacy/agents-historical-design-period.md)。当前 API surface 长期边界以 [`docs/api-surface-policy.md`](docs/api-surface-policy.md) 为准(归档的设计期顶层规范 `docs/api-client-boundary.md` 已迁至 [`docs/archive/plans/api-client-boundary-design-period.md`](docs/archive/plans/api-client-boundary-design-period.md));冲突优先级见 §18.4.1 / [`docs/srvf-foundation-baseline.md §14.4`](docs/srvf-foundation-baseline.md)。

§19.7 D-1 ~ D-8 是用户已拍板的**长期决策锁**,**未归档**,仍以本节为权威源。后续若需新增"客户端边界执行铁律",应**新增** §20+,**不**修订本节(§19)。

### 19.7 已锁定决策(不再重开讨论)

> 本子节记录 2026-05-19 设计期 v0 + Phase 1 评审稿轮中**用户已拍板**的决策。
> AI 在未来会话中**禁止**重新质疑、重新评估、或建议变更以下决策;若用户主动要求重开,**必须**先暂停说明本节存在再讨论。
> `CLAUDE.md` 自 v0.15.0 起已收口为入口 / 路由文件,不再镜像本节;长期决策以本 `AGENTS.md §19.7` 为权威源。

**D-1**:`contribution-rules` 客户端边界归 **System**(2026-05-19 拍板;详 [`api-client-boundary-inventory.md §2.25`](docs/archive/reviews/api-client-boundary-inventory.md))。目标路径 `/api/system/v1/contribution-rules/*`;普通 ADMIN 如需使用通过 `contribution-rule.*` 权限点明确授权,**不**归 Admin API。

**D-2**:Phase 3 路径策略 = **方案 C**(`/api/v2/*` 长期保留为 Admin Legacy;2026-05-19 拍板;详 [`api-client-boundary-migration-plan.md §5`](docs/archive/plans/api-client-boundary-migration-plan.md))。旧 `/api/v2/*` **不**主动 deprecated / **不**强制迁移 / **不**做大面积老接口双写;新 App API 默认 `/api/app/v1/*` / 新 System API 默认 `/api/system/v1/*` / 新 Admin API 默认 `/api/admin/v1/*`;PC 管理后台联调口径**不**因 Phase 3 破坏。
> ⚠️ **2026-06-01 已重开并被 §21 D-9 取代**:用户主动要求重开本条(已按本节 preamble"暂停说明后再讨论"履行),拍板放弃"方案 C",改为 **Route B 全量物理迁移**。**本条"不强制迁移 / 不做大面积双写"自 2026-06-01 起不再作为执行约束**;新 App / System / Admin 默认前缀的部分仍有效。当前执行权威源:§21 D-9 + [`docs/api-surface-migration-plan.md`](docs/api-surface-migration-plan.md)。D-1 / D-3 ~ D-8 不受影响。

**D-3**:Phase 1 拆分 = **1A(Tag 改名)+ 1B(Public/Auth path alias)两个独立 PR**(2026-05-19 评审稿;详 [`api-client-boundary-phase-1-review.md`](docs/archive/reviews/api-client-boundary-phase-1-review.md))。Phase 1 整体为 **C 档**(非 A 档 docs-only),1A 与 1B 各自单独走 C 档验收;AI **禁止**自行启动 Phase 1A / 1B 代码改造,必须用户在 [`docs/process.md`](docs/process.md) 流程内单独立项。

**D-4**:Phase 0.5 App 身份 / 权限 / 数据可见性专项评审是 **Phase 2 启动的硬前置**(2026-05-19 立项;详 [`app-permission-boundary-review.md`](docs/archive/reviews/app-permission-boundary-review.md))。Phase 2 立项评审稿启动前,业务方**必须**先决议该专项 §10.1 标记 ✅ 阻塞的事项(候选 / 临时编号 App 登录策略、Admin 兼队员 `/me` 行为、`/me/permissions` 返 capability vs permission code、`me/*` 与 `my/*` 是否拆等);AI **禁止**在没有该专项决议结果的情况下启动 Phase 2 任何 P0 接口代码实施;该专项**不**改 schema / migration / Role enum / Permission seed / 任何 endpoint / 任何 DTO,严格沿 §19.1 设计期硬禁止。

**D-5**:App permission decisions locked before Phase 2(详 [`app-permission-boundary-review.md §10.2`](docs/archive/reviews/app-permission-boundary-review.md)):
- **D-5.1**:Candidate / temporary-number volunteers **out of App login scope**;App APIs only support users with `User.memberId != null` AND `User.status = ACTIVE` AND `User.deletedAt IS NULL` AND `Member.status = ACTIVE`
- **D-5.2**:Admin-as-member uses **linked-member self perspective**;`ADMIN` / `SUPER_ADMIN` 角色**不**扩大 AppSelf 字段可见性;account without `memberId` → `canUseApp = false`
- **D-5.3**:App `GET /api/app/v1/me/capabilities` 返 product-level capabilities(`canUseApp` / `canRegisterActivity` 等),**禁止** raw RBAC permission codes;capabilities **不是**授权证明,后端每个写端点必须重做授权校验;**禁止 reintroduce** `/api/app/v1/me/permissions` as raw RBAC code endpoint
- **D-5.4**:`/me/*`(identity / account / profile / capability)与 `/my/*`(business records owned by current member)**physically separated** in path segments

**D-6**:Data access and lifecycle boundary is a Phase 2 precondition(详 [`app-permission-boundary-review.md`](docs/archive/reviews/app-permission-boundary-review.md) + [`data-access-lifecycle-boundary-review.md`](docs/archive/reviews/data-access-lifecycle-boundary-review.md))。Agents **不得**:reuse Admin DTOs(`extends` / `Pick` / `Omit` 构造 App DTO 视作越权);assume `Role.USER` equals "mobile access"(Admin 兼队员也走 App self perspective);Mobile endpoint 内默认 `scope = all`(Mobile 默认 `scope = self`);跳过状态机校验直接执行写动作;响应 DTO 中暴露 **L3 Credential** 字段(`passwordHash` / `refreshToken` / `tokenHash` / `secretKey*` / `secretId*` / 完整 signed URL)— snapshot 测试出现直接拒合并。

**D-7**:Code architecture boundary before App API implementation(详 [`code-architecture-boundary-review.md`](docs/archive/reviews/code-architecture-boundary-review.md);active execution policy 见 [`docs/architecture-boundary.md`](docs/architecture-boundary.md))。Agents **不得**继续把 surface-specific DTO / scope / field masking / state transition / export / audit / effect 逻辑直接堆进大 service 而不先识别 6 类抽离边界:**Presenter**(entity → DTO/View + FieldPolicy)/ **QueryService**(读 + scope + 分页;Mobile 默认 `scope = self`)/ **PolicyService**(业务合法性,**不**塞 `rbac.can(...)`)/ **StateMachine**(显式 transition,**不**零散 if/else)/ **AuditRecorder**(统一审计 + mask 敏感字段)/ **Effect / Workflow**(post-commit 副作用,**不**和主交易混)。**不要求**立即大规模重构(`attendances.service.ts` 1413 LOC 等不动),要求新工作 **boundary-aware**;Refactor Triggers:新 mobile endpoint → 新 Mobile Controller + App DTO + Presenter;新高敏字段 → 同步 FieldPolicy;新导出 → ExportService + AuditRecorder;新审批状态 → StateMachine;新 scope → ScopeResolver + QueryService;新通知 / 短信 → Effect / Workflow。

**D-8**:Phase 2 App API implementation requires Phase 2 review(详 [`app-api-phase-2-review.md`](docs/archive/reviews/app-api-phase-2-review.md) + Phase 0.5/0.6/0.7 评审稿)。Agents **不得**实现 Phase 2 endpoints from [`api-client-boundary-migration-plan.md §4.1`](docs/archive/plans/api-client-boundary-migration-plan.md) 旧 11-endpoint list 而不应用 Phase 0.5/0.6/0.7 决策。关键约束:`/me/permissions` → `/me/capabilities`(沿 D-5.3);`/me/*` 与 `/my/*` 物理分离(沿 D-5.4);App DTOs **不得** reuse Admin DTOs(沿 D-6;`extends` / `Pick` / `Omit` / `IntersectionType` / `PartialType` / `OmitType` 视作越权);Mobile scope defaults to `self`(沿 D-6;App where 子句永远 `currentUser.memberId` 锁定本人,**禁止**用 `role` 短路);L3 字段(`passwordHash` / `refreshToken` / `tokenHash` / `secretKey*` / `secretId*` / 完整 signed URL)**永远不返回**(snapshot 测试出现直接拒合并)。Phase 2 实施按 [`app-api-phase-2-review.md §8.1`](docs/archive/reviews/app-api-phase-2-review.md) P2-0 ~ P2-7 串行;agents **禁止**自行启动 P2-N,必须用户在 [`docs/process.md`](docs/process.md) 流程内逐个立项。

**违反铁律**:发现本节决策与新任务诉求冲突 → **必须暂停说明**,不擅自调和;不主动建议"重新评估方案 A/B"或"把 contribution-rules 改归 Admin"等回滚动作。

---

## 20. Git 安全与 worktree 收尾铁律

> 承接 G-11(worktree / 并行任务协作);完整 SOP 见 [`docs/process.md §5.4`](docs/process.md)。本节只列硬约束,**不**展开 SOP 全文。

- **禁止**未经用户授权执行 `git reset --hard` / `git push --force` / `git worktree remove --force` / 批量 `git branch -D`;任一动作必须先说明风险并等用户拍板。
- Squash merge 后若 `git branch -d` 报 `not fully merged`,**必须**先按 [`docs/process.md §5.4.6`](docs/process.md) 做 patch-equivalence 核验,再允许对**目标分支**(仅本次任务对应分支)使用 `-D`。
- 清理 worktree 前**必须**先确认目标 worktree clean(`git -C <worktree> status --short` 为空);dirty / untracked 时只能停下报告,不得 `--force`。
- 任何 cleanup 只能作用于**当前任务目标分支 / worktree**;**禁止**顺手清理 unrelated worktree、本地孤立 `claude/*` 分支、或非本任务 head 的 `origin/claude/*` 远端分支(本地、远端同标准)。
- `.DS_Store` 等 macOS Finder 元数据按 [`docs/process.md §5.4.5`](docs/process.md) 处置(仅允许就地 `rm` 后重核 `status`);**不得**借此顺带清理其它 untracked 文件。
- `gh pr merge --squash --delete-branch` 与 `git ls-remote --heads origin` 的 exit code 不能单独作为成败依据;必须按 [`docs/process.md §5.4.2 / §5.4.4`](docs/process.md) 复核 PR state 与 stdout。

---

## 21. API Surface 全量迁移决策(Route B;承接并取代 §19.7 D-2)

> 本节是 §19.7 决策锁的**后续层**:沿 §19 开头"新增'客户端边界执行铁律'应**新增 §20+,不修订本节(§19)**"的 append-only 规则;§20 已被"Git 安全"占用,故顺延至本节。**D-series 编号在本节延续**(D-9),保持与 §19.7 D-1 ~ D-8 的交叉引用连续性。
> 2026-06-01 用户主动要求重开 §19.7 D-2(已按 §19.7 preamble"暂停说明本节存在后再讨论"履行),拍板放弃"方案 C(`/api/v2/*` 长期保留)",改为 **Route B 全量物理迁移**。

**D-9(2026-06-01 拍板;取代 D-2 的"不迁移"部分)**:API surface 改为**按客户端 / 使用场景四分 + 预留开放平台**:

| Surface | 前缀 | 用途 |
|---|---|---|
| Admin | `/api/admin/v1/*` | 管理后台 / 运维后台业务 |
| App | `/api/app/v1/*` | App / 小程序 / 队员端(**已建成,不迁移**) |
| Auth | `/api/auth/v1/*` | 登录 / 刷新 / 登出 / 认证会话 |
| System | `/api/system/v1/*` | 健康检查 / 运行状态 / 系统元信息 / ops 配置(承接 D-1 `contribution-rules` → System) |
| Open | `/api/open/v1/*` | **预留**,本期不实现、不占用 |

存量 `/api/v2/*` / `/api/auth/*` / `/api/users/*` / `/api/health/*` **将按 alias → 灰度 → deprecate → 删除分阶段全量迁移**(取代 D-2 的"不强制迁移 / 不做大面积老接口双写")。执行细节、逐 endpoint 归属、阶段顺序、回退条件以 active 权威源 [`docs/api-surface-migration-plan.md`](docs/api-surface-migration-plan.md) + [`docs/api-surface-policy.md §0`](docs/api-surface-policy.md) 为准。

约束:
- 迁移是 **D 档**:严格分阶段、分 PR、串行;每阶段先评审稿冻结再动代码;AI **禁止**自行启动任一阶段代码改造,必须用户逐阶段立项(沿 [`docs/process.md §4`](docs/process.md))。
- **alias 阶段只加不删**(老 + 新 path 并存),保证零破坏;删除老 path 只能在 deprecation 窗口 ≥ 2 release + 前端/移动端切流确认 + 单独公告后执行。
- **D-1**(`contribution-rules` → System)、**D-3** Phase 1A(Tag 改名,已完成)、**D-4 ~ D-8**(App 身份/权限/DTO/数据访问/架构边界)**继续完全有效**,本节不触碰;raw permission code ≠ app capability(D-5.3)在迁移中继续保持。
- 灰区归属(audit-logs / storage / RBAC 系 / dictionaries / attachment-configs 归 Admin 还是 System)由迁移计划 Phase 0 产出映射表并经用户签字冻结,本节**不**预先拍板。
