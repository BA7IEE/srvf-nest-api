# Changelog

本仓库版本号在 `package.json#version` 与 Swagger `setVersion(...)` 同步维护;tag 由维护者按需打。

## Unreleased

- (无;待下一波 V2 / V2.x 增量或文档变更登记)

## v0.15.0 - 2026-05-20

> SemVer 拍板:`0.14.0 → 0.15.0` 归类为 **minor**。本版本新增 App API Phase 2 mobile surface 15 个 `/api/app/v1/*` endpoint,完成 P0-F 管理面 RBAC 收紧,并完成 Phase 1A Swagger surface-module tag 重命名;旧 `/api/v2/*` / Admin / Ops / Auth 路径保持兼容,0 schema migration,0 新依赖。

### Added

- **App API Phase 2 mobile surface — 15 个新 endpoint + 5 个新 Controller**(沿 [`docs/app-api-phase-2-review.md`](docs/app-api-phase-2-review.md) + Phase 0.5 / 0.6 / 0.7 全套约束):
  - **P2-1**(#144):`GET /api/app/v1/me` / `GET /api/app/v1/me/account` / `GET /api/app/v1/me/capabilities`(新 `app-me.controller.ts`;`@Controller('app/v1/me')`;暴露 **product-level capability** 而非 raw RBAC permission code,沿 [`CLAUDE.md §19.7 D-5.3`](CLAUDE.md))
  - **P2-2**(#146 实施 / #145 评审):`GET /api/app/v1/me/profile` / `PATCH /api/app/v1/me/profile`(白名单严格 **2 字段** `nickname` + `avatarKey`;`PATCH` **禁止**夹带 Member 业务字段 / Emergency contacts / Organization / Department / Account / Role / Permission / Status / 审批内部字段;身份证号默认掩码后 4 位)
  - **P2-3**(#148 实施 / #147 评审):`PUT /api/app/v1/me/password`(独立 PR;继承 P0-D / P0-E 全套铁律 `@PasswordChangeThrottle()` + `OLD_PASSWORD_INVALID=10005` + `NEW_PASSWORD_SAME_AS_OLD=10006` + 联动撤本人全部 refresh token + audit `password.change.self`)
  - **P2-4a**(#153 实施 / #149 + #152 评审 lock):`GET /api/app/v1/activities/available`(我可参加的活动列表:published + 报名窗内 + 未满 + 未被本人报过;新 method `activities.service.listAvailableForMember(memberId, query)`,**不**复用 admin `list`)
  - **P2-4b**(#154 实施):`GET /api/app/v1/activities/{id}`(App 视角详情 DTO;复用 `findOne` + 新 `AppActivityPresenter`,与 admin DTO 物理隔离)
  - **P2-5a**(#155 实施 / #150 + #151 评审):`GET /api/app/v1/my/registrations` / `GET /api/app/v1/my/registrations/{id}` / `GET /api/app/v1/my/activities`(新 `app-my-registrations.controller.ts`;`@Controller('app/v1/my')`;资源 owner 双重校验)
  - **P2-5b**(#156 实施):`POST /api/app/v1/my/registrations`(入参带 `activityId`;Policy 检查活动状态 / 报名窗 / 上限 / 已报过 / 资格)/ `PATCH /api/app/v1/my/registrations/{id}/cancel`(状态机 transition guard + 取消窗校验)
  - **P2-6**(#158 实施 / #157 评审):`GET /api/app/v1/my/attendance-records`(本人考勤记录汇总;新 `app-my-attendance-records.controller.ts` + `AppMyAttendanceRecordDto` + `app-my-attendance-records.service.ts` + 新 Presenter)
  - **P2-7**(#160 实施 / #159 评审):`GET /api/app/v1/my/certificates`(本人证书列表;新 `app-my-certificates.controller.ts` + `AppMyCertificateDto` + `app-my-certificates.service.ts` + `certificates.service.listForMember(memberId, query)`)
- **App API 准入语义**(沿 [`docs/app-permission-boundary-review.md §10.2`](docs/app-permission-boundary-review.md) D-5):仅 `User.memberId != null && User.status=ACTIVE && User.deletedAt IS NULL && Member.status=ACTIVE` 的正式队员可用 App;候选 / 临时编号志愿者**本期不支持**;Admin 兼队员走 linked-member self perspective,**不**扩大字段可见性
- **App API DTO 严格 Mobile 隔离**:Phase 2 全部 DTO 均新建 `dto/app/` 子目录承载;**禁止** `extends` / `Pick` / `Omit` / `IntersectionType` / `PartialType` / `OmitType` 一个 Admin DTO 构造 App DTO(沿 [Phase 0.6 §6.1](docs/data-access-lifecycle-boundary-review.md) + [Phase 0.7 §2.2](docs/code-architecture-boundary-review.md));App API where 子句永远用 `currentUser.memberId` 锁定本人(`scope = self`);**永不返回 L3 字段**(`passwordHash` / `refreshToken` / `tokenHash` / `secretKey*` / `secretId*` / 完整 signed URL)
- **P0-F RBAC 收紧 4 PR**(管理面收紧;沿 [first-release P0-F 评审范式](docs/first-release-readiness-plan.md)):
  - **PR-1**(#132):RBAC 管理面 `rbac/*` 接入 `rbac.can()`
  - **PR-2 / PR-2A / PR-2B**(#133 评审 / #134 + #135 + #136 实施):config 管理面接入 `rbac.can()`(分 PR-2A 与 PR-2B 两步;含 #135 `ops-admin` 角色 grant SOP)
  - **PR-3**(#137 评审 / #138 实施):users 管理面接入 `rbac.can()`
  - **PR-4**(#139 评审 / #140 实施):audit-logs 管理面接入 `rbac.can()`
- **App API E2E 覆盖扩张**:Phase 2 新增 **8 个 App API e2e spec**(`test/e2e/app-me.e2e-spec.ts` / `app-me-password.e2e-spec.ts` / `app-activities-available.e2e-spec.ts` / `app-activities-detail.e2e-spec.ts` / `app-my-registrations-read.e2e-spec.ts` / `app-my-registrations-write.e2e-spec.ts` / `app-my-attendance-records.e2e-spec.ts` / `app-my-certificates.e2e-spec.ts`);E2E spec 总数 55 → **63**

### Changed

- **Phase 1A Swagger Tag 重命名**(#142;沿 [`docs/api-client-boundary-phase-1-review.md`](docs/api-client-boundary-phase-1-review.md)):Swagger `@ApiTags` 向 `surface-module` 分类体系收敛(App / Admin / System / Public 4 surface × module 命名);**0 endpoint 变更 / 0 path 变更 / 0 DTO 变更 / 0 行为变更**;仅 controller `@ApiTags(...)` 字符串调整
- **Contract OpenAPI snapshot 覆盖面扩张**:`test/contract/openapi.contract-spec.ts` `EXPECTED_ROUTES` 新增 **15 个 `/api/app/v1/*` 端点白名单**(P2-1 ~ P2-7 全部);snapshot 同步更新覆盖全部新增 endpoint 与 DTO

### Docs

- **App API Phase 2 评审稿系列**(8 份评审稿,沿 P2-N 串行立项范式):
  - [`docs/app-api-phase-2-review.md`](docs/app-api-phase-2-review.md):Phase 2 总评审稿(#143 / P2-0;15 endpoint + 9 PR 串 + 15 条风险表)
  - [`docs/app-api-p2-2-profile-review.md`](docs/app-api-p2-2-profile-review.md)(#145):P2-2 profile read/update 实施评审
  - [`docs/app-api-p2-3-password-review.md`](docs/app-api-p2-3-password-review.md)(#147):P2-3 password 实施评审
  - [`docs/app-api-p2-4-activities-review.md`](docs/app-api-p2-4-activities-review.md)(#149 / #152 lock):P2-4 activities 实施评审
  - [`docs/app-api-p2-5-registrations-review.md`](docs/app-api-p2-5-registrations-review.md)(#150 / #151 index sync):P2-5 registrations 实施评审
  - [`docs/app-api-p2-6-attendance-records-review.md`](docs/app-api-p2-6-attendance-records-review.md)(#157):P2-6 attendance-records 实施评审
  - [`docs/app-api-p2-7-my-certificates-review.md`](docs/app-api-p2-7-my-certificates-review.md)(#159):P2-7 my-certificates 实施评审
- **Phase 0/1 客户端边界评审**(#141):新增顶层规范 [`docs/api-client-boundary.md`](docs/api-client-boundary.md) + 现状盘点 [`docs/api-client-boundary-inventory.md`](docs/api-client-boundary-inventory.md) + 分阶段路线 [`docs/api-client-boundary-migration-plan.md`](docs/api-client-boundary-migration-plan.md) + Phase 1 评审 [`docs/api-client-boundary-phase-1-review.md`](docs/api-client-boundary-phase-1-review.md) + 4 份 App 边界配套评审(`app-permission-boundary-review.md` / `data-access-lifecycle-boundary-review.md` / `code-architecture-boundary-review.md`)
- **P0-F RBAC 评审稿系列**:#133(config PR-2 评审)/ #135(ops-admin grant SOP)/ #137(users PR-3 评审)/ #139(audit-logs PR-4 评审)
- **v0.14.0 handoff entrypoint 刷新**(#131):`docs/current-state.md` v0.14.0 release 后入口刷新
- **P2-8 docs-only 收尾**(本 PR):`docs/current-state.md` §1 + §2 + §4 回填(HEAD `72763f5` → `a327c7b`,Unreleased 累计能力段)/ `CHANGELOG.md` Unreleased 段填充本段 / `docs/app-api-phase-2-review.md` §12.4 验收锚点 P2-0 ~ P2-7 标 ✅,P2-8 标本 PR;**0 src / 0 prisma / 0 test / 0 contract snapshot / 0 package / 0 workflow / 0 .env.example / 0 README / 0 handoff / 0 CLAUDE.md / 0 AGENTS.md / 0 ARCHITECTURE.md** 变更

## v0.14.0 - 2026-05-18

v0.13.0 之后主线增量:**P0-E refresh token / logout / logout-all 完整闭环**(评审稿 + 铁律解锁 + 2 hotfix → 代码实现 → 状态回填 4-PR 串行;沿 P0-D 范式)。**唯一运行时代码变更**为 P0-E PR-3 #127(`POST /api/auth/{refresh,logout,logout-all}` + `LoginResponseDto` 扩 2 字段 + `refresh_tokens` 表 + 联动撤销 4 场景 + 5 audit + `REFRESH_TOKEN_INVALID=10007`);其余 docs-only / ci(smoke) workflow env 修复。**1 schema migration**(`20260517165220_add_refresh_tokens`;0 修改既有表 / 0 数据回填 / 0 DROP)/ **0 新依赖**;**v1 14 路由 schema 严格 zero drift**(snapshot diff 仅新增 +3 路由 / +2 DTO / +2 LoginResponseDto 字段 / +1 BizCode;删除项仅 LoginDto/Response summary 与 expiresIn example "7d" → "15m" 文案细化非字段变更)。

**SemVer 拍板**:0.13.0 → 0.14.0 **minor**(向后兼容能力扩展:新增 3 个 auth 接口 + 1 个 BizCode + 5 个 audit event + 1 个独立 throttler + 3 个 env;`LoginDto` 入参 zero drift / JWT payload zero drift,无 breaking);沿 v0.6.0 → v0.7.0 → ... → v0.13.0 全部 minor 节奏。

**为什么 refresh TTL 90d**:本系统是深圳救援队内部管理系统,使用频次比公网 SaaS 低,30d 会让低频用户(月度 / 季度参与活动的志愿队员)频繁触发 absolute expiration 误以为账号失效;90d 把"必须重登"周期对齐到"季度"心智;**仍坚守** absolute expiration(沿 OWASP)+ rotation always + family revoke + 联动撤销四防线。

### Docs

- `docs(first-release): backfill P0-E completion status`(#128,squash commit `96e4c85`;P0-E PR-4 状态回填,A 档 docs-only):
  - 沿 P0-E 4-PR 串行范式(#126 评审稿+铁律解锁+2 hotfix → #127 代码实现 → 本 PR 回填),把 P0-E 已落地事实同步到 7 个文档,不动 src / prisma / test / package / workflow。
  - [`docs/first-release-readiness-plan.md`](docs/first-release-readiness-plan.md):§3.1 P0-E 标题加 ✅;详细列出已落地能力(3 接口 + LoginResponseDto +2 字段 + refresh_tokens 表 + 联动撤销 4 场景 + 5 audit + 10007);§4 P0 推荐顺序行 / §5 PR 拆分行 / §8 最终建议行同步标 ✅。
  - [`docs/first-release-frontend-scope.md`](docs/first-release-frontend-scope.md):起步包 51 → **54 路由**(auth 段 1 → 4 加 refresh / logout / logout-all);总路由 139 → 142;§3.2 鉴权段加 access 15m + refresh 90d + REFRESH_TOKEN_INVALID=10007 三阶段错误码区分;**新增 §3.2.1 token 生命周期段**(login → refresh → logout / logout-all 完整伪流;前端关键铁律 4 条:access 401 先 refresh / refresh 10007 跳登录不重试 / refresh token 存储等级 = password / refreshExpiresAt 是 ISO 8601 UTC)。
  - [`docs/first-release-bizcode-mapping.md`](docs/first-release-bizcode-mapping.md):BizCode 总数 124 → **125**;§4 表加 `10007 REFRESH_TOKEN_INVALID`(失败 4 子原因统一返;前端处理:**清本地 token 跳登录,不重试 refresh**);§1.3 实数说明追加 PR-3 #127 +10007 记账;§4 行 178 / §5 行 529 总数更新。
  - [`docs/first-release-bootstrap-sop.md`](docs/first-release-bootstrap-sop.md):§2.1 会变 env 列表加 `PASSWORD_CHANGE_THROTTLE_*` / `REFRESH_THROTTLE_*` / `JWT_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN`;**新增 P0-E PR-3 token env 锁定值段**(`JWT_EXPIRES_IN=15m` / `JWT_REFRESH_EXPIRES_IN=90d` / `REFRESH_THROTTLE_*` 默认 30/60 可选);§2.2 production 启动强校验红线段加 `JWT_REFRESH_EXPIRES_IN` 必填(P0-E PR-3 jwt.config fail-fast);§3.3 migration 触发段加 P0-E PR-3 上线 migration 提示(`20260517165220_add_refresh_tokens` + 必须先注入 env 再 deploy 否则 fail-fast)。
  - [`docs/current-state.md`](docs/current-state.md):§1 main HEAD `5fba386` → **`25f03fb`** + Unreleased 累计 P0-E 系列;§2 加 Unreleased P0-E 能力清单(3 接口 + refresh_tokens 表 + 4 联动撤销场景 + 5 audit + 10007 + 独立 throttler);测试与契约更新为 unit 14 spec/922 用例 + e2e 55 spec/1291 用例(原 13/13 + 51/1252);§4 P0 行 P0-E 状态从"待立项"改为 ✅(同 P0-B 测试 COS 闭环验收 #125 标 ✅);仍待立项收敛为 P0-F / P0-H / P0-I。
  - [`docs/security.md`](docs/security.md):**Token 吊销升级路径段重写**——开头从"当前版本不实现 refresh token"改为"P0-E PR-3 已落地";加 P0-E 已落地能力表(refresh / logout / logout-all / LoginResponseDto / refresh_tokens 表 / 联动撤销 4 场景 / TTL / 限流 / audit)+ P0-E 仍不做清单(tokenVersion / access blacklist / Redis / cookie / 查询接口 / 设备列表)+ refresh token 安全策略表(生成 / 存储 / 哈希 / 日志-audit-OpenAPI-测试-handoff redact / 入参出参 / TTL / rotation / reuse / logout / logout-all / 失败统一码 / 限流)+ tokenVersion 升级路径(本期不做,触发条件 + 6 步施工 + 不做理由);已落地策略表追加 3 行(refresh + logout 接口 / refresh 限流 / 改密-重置-禁用-软删联动撤销 refresh)。
  - [`CHANGELOG.md`](CHANGELOG.md):Unreleased 顶部新增本 docs 回填条目;P0-E PR-3 feat 条目原样保留;P0-E PR-2 / hotfix-1 / hotfix-2 docs 条目原样保留(沿 keep-a-changelog reverse-chrono 范式)。
  - 明确**不改**:[`docs/handoff/v0.13.0.md`](docs/handoff/v0.13.0.md)(历史快照,沿 process.md §6)/ 不 bump version / 不创建 tag / Release / 不清理分支 / worktree。
  - **0 src / 0 prisma / 0 test / 0 package.json / 0 pnpm-lock.yaml / 0 workflow / 0 .env.example / 0 migration** 变更;仅 7 个 docs + 1 CHANGELOG = 8 文件 docs-only。

### Added

- `feat(auth): add refresh token + logout + logout-all`(P0-E PR-3,D 档代码):
  - 沿 [P0-E 评审稿 v1](docs/first-release-p0e-refresh-token-review.md) §3-§9 9 条已决策实施;沿 [CLAUDE.md §9 P0-E refresh token 鉴权铁律](CLAUDE.md) 16 类硬约束。
  - **新增 3 个 API 端点**:
    - `POST /api/auth/refresh`(`@Public()` + `@RefreshThrottle()` 30/60 IP;入参 `RefreshTokenDto { refreshToken }`;rotation always + family revoke + absolute expiration;失败统一 `REFRESH_TOKEN_INVALID=10007`)
    - `POST /api/auth/logout`(`@Public()` + 无限流;入参 `LogoutDto { refreshToken }`;幂等;只撤销当前 row;不吊销 access;响应 200 + data:null)
    - `POST /api/auth/logout-all`(`JwtAuthGuard` + 复用 `@PasswordChangeThrottle()` 5/60 IP;撤销该 user 全部未过期未撤销 refresh;返 `{ revokedCount }`)
  - **扩展 `POST /api/auth/login`**:`LoginResponseDto` 新增 `refreshToken` + `refreshExpiresAt` 字段(字段集恰好 5 项);**`LoginDto` 入参 schema 严格 zero drift**(沿评审稿 §3.1 D-1)。
  - **新增 schema**:`prisma/migrations/20260517165220_add_refresh_tokens` — `refresh_tokens` 表(`id` / `userId` / `tokenHash @unique` / `familyId` / `expiresAt` / `createdAt` / `rotatedAt` / `revokedAt` / `revokedReason` / `replacedById @unique` / `ipFirstSeen` / `uaFirstSeen` + 6 索引 + 2 FK);**0 修改既有表 / 0 数据回填 / 0 DROP**;`User` 仅追加反向 relation 不增字段。
  - **`refreshExpiresAt` 语义**:ISO 8601 UTC 字符串,family **absolute expiration** 时刻;rotation 后所有新 refresh token **继承同一个 `refreshExpiresAt`**,响应里返回**相同 ISO 时刻字符串**;**禁止** sliding expiration;客户端读 `refreshExpiresAt` 即知 family 何时过期,无需信任本地时钟做 `now + TTL` 计算。
  - **refresh token 生成与存储**:`crypto.randomBytes(32).toString('base64url')` 256 bit 熵;sha256 hex 入库(`tokenHash @unique`);明文绝不入库 / 日志 / audit / OpenAPI 示例 / 测试 fixture / 测试快照(沿 CLAUDE.md §9 P0-E 子节)。
  - **JWT payload 严格 zero drift**:仍 `{ sub, username }`(+ 标准 `iat / exp / nbf`);`JwtStrategy.validate` 仍只看 `deletedAt + status === ACTIVE`,不读 `passwordHash` / `tokenVersion`(沿 D-4)。
  - **联动撤销 4 场景**(沿评审稿 §7 + CLAUDE.md §9):
    - 本人改密(`PUT /api/users/me/password`):事务内追加 `tx.refreshToken.updateMany` `revokedReason='self-password-change'`;audit `password.change.self` extra 加 `refreshTokensRevoked: count`
    - 管理员重置(`PUT /api/users/:id/password`):**改为 `prisma.$transaction`**(原非事务,沿 D-PR3-1);新 audit `password.reset.by-admin` actorUserId = SUPER_ADMIN/ADMIN;`revokedReason='admin-password-reset'`
    - 用户被禁用(`PATCH /api/users/:id/status` → `DISABLED`):事务内 `revokedReason='admin-disable'`(沿 D-PR3-2 仅撤销 refresh,**不补 audit**)
    - 用户被软删(`DELETE /api/users/:id`):事务内 `revokedReason='admin-delete'`(沿 D-PR3-2 仅撤销 refresh)
  - **access token 仍不主动吊销**(沿 P0-E v1 D-4):依赖 `JWT_EXPIRES_IN=15m` 自然过期(由 `7d` 收敛)+ `JwtStrategy.validate` 每请求查库阻断 `DISABLED` / 软删用户;**e2e §7.5 反向锁定断言**(改密后旧 access 仍可调 `/me`)继续保留。
  - **三 throttler 实例物理隔离**:`default`(login 5/60 IP)/ `password-change`(改密 + logout-all 5/60 IP)/ **新增 `refresh`**(refresh 30/60 IP,比前两者放宽允许多 tab 并发);命中全部走 `BizException(TOO_MANY_REQUESTS=42900)` + HTTP 429;**不暴露** `Retry-After` / `X-RateLimit-*` 头(沿 V1.1 §17.7 `setHeaders: false`)。
  - **新增 1 个 BizCode**:`REFRESH_TOKEN_INVALID = 10007`(HTTP 401;沿 100xx users 段,LOGIN_FAILED=10004 / OLD_PASSWORD_INVALID=10005 / NEW_PASSWORD_SAME_AS_OLD=10006 之后下一可用号位);**不拆** `EXPIRED` / `REVOKED` / `REPLAY`(沿评审稿 D-6 + v1 §8 防账号枚举铁律;refresh 失败 4 子原因统一响应体 / HTTP status / message 完全一致)。
  - **新增 5 个 audit event**(`AuditLogEvent` union 由 19 项 → 24 项):
    - `auth.login`(login 成功路径;extra.familyId)
    - `auth.refresh`(refresh 成功 + family revoke 路径;extra.familyId / replayDetected / familyRevoked?)
    - `auth.logout`(含幂等命中均写;extra.found: boolean)
    - `auth.logout-all`(extra.revokedCount: number)
    - `password.reset.by-admin`(管理员重置今前无 audit;P0-E 顺手补;extra.refreshTokensRevoked)
    - **audit `extra` 禁止**写 refresh token 明文 / `tokenHash` / `passwordHash` / IP 完整段(IP 已在 `AuditContext.ip` 字段)。
  - **新增 1 个装饰器**:`@RefreshThrottle()`(metadata `REFRESH_THROTTLE_KEY` + throttler name `REFRESH_THROTTLER_NAME='refresh'`;沿 P0-D `@PasswordChangeThrottle` 范式)。
  - **新增 util**:`generateRefreshTokenRaw()` / `hashRefreshToken(raw)` / `generateFamilyId()` / `parseMsString(value)`(`src/modules/auth/refresh-token.util.ts`;沿"0 新依赖"约束,手写最小 ms 解析器,不引入 `ms` 包)。
  - **新增 3 个 env**:`JWT_REFRESH_EXPIRES_IN=90d`(refresh TTL,absolute expiration 不滑动;沿 D-5)/ `REFRESH_THROTTLE_LIMIT`(默认 30) / `REFRESH_THROTTLE_TTL_SECONDS`(默认 60);`JWT_EXPIRES_IN` 由 `7d` 改 `15m`(`.env.example` 同步更新;沿 D-PR3-5;运维上线时同步 prod env)。
  - **为什么 refresh TTL 90d**(沿评审稿 §3.5 D-5 + 用户 hotfix-2 拍板):本系统是深圳救援队内部管理系统,使用频次比公网 SaaS 低,30d 会让低频用户(月度 / 季度参与活动的志愿队员)频繁触发 absolute expiration 误以为账号失效;90d 把"必须重登"周期对齐到"季度"心智;**仍坚守 absolute expiration**(沿 OWASP)+ rotation always + family revoke + 联动撤销四防线。
  - **本期不做**:`tokenVersion` 字段(沿 D-4)/ access token blacklist / refresh_tokens 查询接口 / 已登录设备列表 UI / 单设备管理 / device fingerprint / Redis / Queue / Cron(refresh 撤销靠 DB 主键索引 sub-ms 查询)/ 完整 OAuth tree / httpOnly cookie / 改 `LoginDto` 入参 / 微信小程序 OAuth(沿评审稿 D-9)。
  - **测试覆盖**:
    - 新增 1 unit spec(`refresh-token.util.spec.ts` 24 用例)
    - 新增 4 e2e spec(`auth-refresh.e2e-spec.ts` 12 用例 / `auth-logout.e2e-spec.ts` 9 用例 / `auth-logout-all.e2e-spec.ts` 8 用例 / `auth-refresh-throttle.e2e-spec.ts` 3 用例)
    - 修改 6 既有 spec(`auth-login` 加 5 字段断言 / `users-change-my-password` 加 3 用例联动撤销 / `users-password-reset` 加 3 用例联动撤销 + 新 audit / `users-soft-delete` 加 1 用例 / `users-admin-crud` 加 1 用例 DISABLED 撤销 / `audit-logs` 加 `truncateAuditLogsTestOnly` 防 loginAs 写 audit 污染)
    - 修改 1 unit `logger-options.spec.ts`(`fakeAppCfg` 补 `refreshThrottle` 字段)
    - 修改 1 contract `openapi.contract-spec.ts`:`EXPECTED_ROUTES` 加 3 新路由白名单;snapshot 更新(diff +402/-2;**v1 14 路由 schema 严格 zero drift**:删除项仅 LoginDto/Response summary 与 expiresIn example "7d" → "15m" 文案细化,非字段变更)
  - **全套验证**:`pnpm lint`(src + test 0 error / 0 warning)/ `pnpm typecheck`(空输出)/ `pnpm test:contract`(255 用例)/ `pnpm test`(unit 14 spec / 922 用例)/ `pnpm test:e2e`(**55 spec / 1291 用例**;原 51 → 55 spec,+4 P0-E spec;原 1252 → 1291 用例,+39 P0-E 用例)全绿。

### Docs

- `docs(p0e): adjust refresh token TTL 30d → 90d`(P0-E PR-2.x-2 docs hotfix,A 档 docs-only):
  - **TTL 修正**:在 PR-1 评审稿 v1 ([`docs/first-release-p0e-refresh-token-review.md`](docs/first-release-p0e-refresh-token-review.md)) merge 前修订 refresh token absolute expiration 时长;就地更新 PR-1 / PR-2 / PR-2.x 既有 Unreleased 条目,无需另起评审稿 v2(沿 §14.3 merged 前可改原则)。
  - 调整面:**仅** refresh token TTL(`JWT_REFRESH_EXPIRES_IN`)从 `30d` 改为 **`90d`**;**access token TTL 仍为 `15m`**(`JWT_EXPIRES_IN=15m`,不动)
  - **三铁律不变**:
    - **absolute expiration 仍坚守**(rotation 出来的新 refresh token `expiresAt` **不延长**,严格继承原 family 首个 token 的 `expiresAt`;沿 OWASP)
    - **sliding expiration 仍禁止**(任何形式的 refresh-on-use 延期都视为违反 D-5)
    - **rotation always 仍坚守**(每次 `POST /api/auth/refresh` 必发新 refresh + 旧 refresh 同事务内标 `rotatedAt + revokedAt + replacedById`)
  - **达到 `refreshExpiresAt` 后必须重新登录**(`POST /api/auth/login`);refresh 接口对已过期 family 返 `REFRESH_TOKEN_INVALID=10007`(沿 §6.5);客户端不应也不能"自动续期"绕过此约束
  - **为什么 90d**:本系统是**深圳救援队内部管理系统**,主要用户是队员与管理员(沿 [`.claude/CLAUDE.md` Project Background](.claude/CLAUDE.md));内部系统使用频次比公网 SaaS 低,30d 会让低频使用者(如月度 / 季度参与活动的志愿队员)频繁触发 absolute expiration → 跳登录页 → 误以为账号失效;90d 把"必须重登"周期对齐到"季度"心智,与队员实际使用节奏相符;**仍避免无限续期**(沿 OWASP absolute expiration 红线);若未来切换为公网 SaaS / 高频应用 / 多租户场景,**必须**重新评估
  - 安全侧:rotation always + family revoke + 改密 / 禁用 / 删除联动撤销四道防线仍生效;90d 仅放宽 absolute 上限,**不**放宽其他任一防线
  - 运维侧:`refresh_tokens` 表数据量可能膨胀 3x(rotation 每次 +1 行,90d 窗口),由评审稿 §5.4 顺手清理策略缓解;若量级失控再立项 cron(沿 §13.3 反模式表"不做 cron 定时任务")
  - 可回退性:`JWT_REFRESH_EXPIRES_IN` 是 env,运维可在不发版的情况下回调(例如真出现频发被盗 refresh 事件时改回 30d);**但**调整后已签发的 refresh token 仍按其 `expiresAt` 计算,**不**回溯
  - 改动文件 4 个:
    - [`docs/first-release-p0e-refresh-token-review.md`](docs/first-release-p0e-refresh-token-review.md):§2 偏差段(行 112)+ §3.1 D-1(2 处 TTL 字符串举例)+ §3.5 D-5(标题 + 具体值 + env + **新增"为什么 90d"长段** + 新增"达到 refreshExpiresAt 后必须重新登录"行)+ §4.1 行为补充(`now + 30d` → `now + 90d`)+ §4.2 refresh 伪逻辑返回行(`'30d'` → `row.expiresAt.toISOString()`,显式表达 absolute expiration + ISO 8601)+ §9 影响清单(jwt.config.ts 行 + `.env.example` 行)+ §12 风险表(refresh_tokens 表膨胀风险等级注释)
    - [`CLAUDE.md`](CLAUDE.md) §9 P0-E 子节(3 处:`refreshExpiresAt` 段 ISO 示例日期 + TTL 字符串举例 + `absolute expiration` 段 TTL 值锁定 + 新增"达到 refreshExpiresAt 后必须重新登录"约束)
    - [`AGENTS.md`](AGENTS.md):同 CLAUDE.md 镜像
    - [`CHANGELOG.md`](CHANGELOG.md):就地修正 PR-1 / PR-2 条目里 2 处 `30d` → `90d` 表述 + 本 hotfix 条目登记
  - **`LoginDto` 入参 schema 仍严格 zero drift**(沿评审稿 v1 D-1;TTL 调整与入参无关)
  - **JWT payload 仍严格 zero drift**(`{ sub, username }`;沿评审稿 v1 D-4)
  - **0 src / 0 prisma / 0 migration / 0 test / 0 OpenAPI snapshot / 0 新依赖** 变更
  - 命中替换:评审稿 9 处实际 TTL 值 + 4 处 TTL 字符串举例同步 / CLAUDE.md 3 处 / AGENTS.md 3 处 / CHANGELOG 2 处(PR-1 / PR-2 条目就地修正),累计 **21 处**(保留 1 处 CHANGELOG hotfix 自身条目里的 "30d → 90d" 事实陈述作为 audit trail)

- `docs(p0e): rename refreshExpiresIn → refreshExpiresAt`(PR-2.x docs hotfix,A 档 docs-only):
  - **语义修正**:在 PR-1 评审稿 v1 ([`docs/first-release-p0e-refresh-token-review.md`](docs/first-release-p0e-refresh-token-review.md)) merge 前修订 `LoginResponseDto` 新增字段名;就地更新 PR-1 / PR-2 既有 Unreleased 条目,无需另起评审稿 v2。
  - 字段名:`refreshExpiresIn` → **`refreshExpiresAt`**(LoginResponseDto / RefreshResponseDto 响应字段)
  - 语义升级:从"原样回传 TTL 字符串(如 `"30d"`)"改为"**ISO 8601 UTC 时间字符串**(`new Date(...).toISOString()` 格式,如 `"2026-06-17T00:00:00.000Z"`),表示 **refresh token family 的 absolute expiration 时刻**;rotation 后新 refresh token **继承同一个 `refreshExpiresAt`**,响应里返回**相同的 ISO 时刻字符串**;**禁止** sliding expiration / refresh-on-use 延期"
  - 设计理由:TTL 形态让客户端必须信任本地时钟做 `now + TTL` 计算,跨设备时钟漂移会导致 family 续期失败;ISO 时刻形态消除此风险;客户端读 `refreshExpiresAt` 即知 family 何时过期,无需本地时钟参与计算
  - **TTL 配置 ≠ 响应字段**:服务端 env `JWT_REFRESH_EXPIRES_IN` 与 `jwt.config.ts` 内部 TTL 字段沿 v1 `expiresIn` 范式不变;响应字段 `refreshExpiresAt` 在 service 内 `new Date(now + ttlMs).toISOString()` 计算
  - 改动文件 4 个:
    - [`docs/first-release-p0e-refresh-token-review.md`](docs/first-release-p0e-refresh-token-review.md):§3.1 D-1(决策段重写,补 7 条语义说明)+ §4.1(响应示例 JSON)+ §4.2(refresh 接口响应描述)+ §8.2(e2e 断言文案 + 新增 rotation 同一时刻字符串相等硬断言)+ §9 影响清单(jwt.config.ts 行重写,明示 TTL 配置 ≠ 响应字段)
    - [`CLAUDE.md`](CLAUDE.md) §9 P0-E 子节 "DTO / Response 契约" 段:`refreshExpiresAt` 行替换 + 新增 2 行铁律(ISO 8601 UTC 语义 + TTL 配置 ≠ 响应字段)
    - [`AGENTS.md`](AGENTS.md):同 CLAUDE.md 镜像
    - [`CHANGELOG.md`](CHANGELOG.md) Unreleased PR-1 条目第 1 条就地修正 + 本条目登记
  - **`LoginDto` 入参 schema 仍严格 zero drift**(沿评审稿 v1 D-1)
  - **JWT payload 仍严格 zero drift**(`{ sub, username }`;沿评审稿 v1 D-4 + §3.1 不变)
  - **0 src / 0 prisma / 0 migration / 0 test / 0 OpenAPI snapshot / 0 新依赖** 变更
  - 命中替换:评审稿 7 处(5 处字段名替换 + 2 处刻意保留为反向声明 / 不暴露 config 字段名,改写为等价表达)/ CLAUDE.md 1 处 / AGENTS.md 1 处 / CHANGELOG.md 1 处(PR-1 条目第 1 条),累计 **10 处**

- `docs(p0e): allow refresh token / logout`(PR-2,A 档 docs-only):
  - 修订 [`CLAUDE.md`](CLAUDE.md) / [`AGENTS.md`](AGENTS.md) 4 处段落 + 新增 1 个 §9 子节,让后续 P0-E 代码实现(PR-3)不再被旧"不做 refresh token / logout"误挡;**不**修改 [`docs/first-release-p0e-refresh-token-review.md`](docs/first-release-p0e-refresh-token-review.md)(评审稿冻结后不回改,沿 process.md §6)。
  - 改动点 1 — §1 SRVF 三档解锁拆分:
    - A 档**新增** 1 条:`refresh token / logout / logout-all`(P0-E + 评审稿 v1 已冻结;代码实现仍待 PR-3 落地)
    - B 档**移除**旧"refresh token / logout / `tokenVersion` / token revoke"合并行;**拆分**为 `tokenVersion` 字段(本期不做)/ access token blacklist(本期不做)两行;Redis 行措辞更新("P0-E refresh token 撤销不引入 Redis")
    - C 档**新增** 3 条:复杂 session 管理 UI / refresh_tokens 查询接口 / 完整 OAuth 2.0 复杂度(沿 P0-E v1 D-9)
  - 改动点 2 — §5 BizCode 编码段:补"**P0-E refresh token 段位登记**"段,登记 `REFRESH_TOKEN_INVALID = 10007`(HTTP 401);明示**禁止**拆 `EXPIRED` / `REVOKED` / `REPLAY`(沿 v1 §8 防账号枚举铁律)。
  - 改动点 3 — §9 密码处理铁律 2 行升级:
    - 旧"管理员重置密码后不主动吊销旧 token"→ 升级为"不主动吊销 access token + **必须**主动撤销目标全部 refresh token(`revokedReason='admin-password-reset'`)"
    - 旧"本人改密成功后不主动吊销旧 token;`tokenVersion` / refresh token / token revoke 仍归 P0-E,本接口不预实现"→ 升级为"不主动吊销 access token + **必须**主动撤销该 user 全部 refresh token(`revokedReason='self-password-change'`);`tokenVersion` 仍本期不做(沿 P0-E v1 D-4)"
    - **新增** 1 行:用户被 `DISABLED` / 软删时**必须**主动撤销目标全部 refresh token(`revokedReason='admin-disable'` / `'admin-delete'`)
  - 改动点 4 — §9 末追加新子节 **"P0-E refresh token 鉴权铁律"**(2026-05-17 由 P0-E 评审稿 v1 解锁;共 16 类硬约束):
    - refresh token 生成与存储(`crypto.randomBytes(32).base64url`;opaque random token;**明文绝不入库**,只存 `sha256(raw)`;**禁止** bcrypt;明文绝不入日志 / audit / OpenAPI 示例 / 测试 fixture / 测试快照 / 文档示例 / handoff / release notes)
    - JWT payload 严格 zero drift(`{ sub, username }`;**禁止**新增 `role` / `permissions` / `tokenVersion` / `tv` / `jti` / `email`)
    - DTO / Response 契约(`LoginDto` zero drift;`LoginResponseDto` 允许 +2 字段共 5 项;`RefreshTokenDto` / `LogoutDto` 严格 1 字段白名单)
    - rotation 与 expiration 三不变式(rotation always + absolute expiration 90d 不滑动 + reuse detection 触发 family revoke;**90d** 由 PR-2.x-2 docs hotfix 从 30d 调整,沿评审稿 §3.5 D-5)
    - logout 行为契约(只撤销当前 + `@Public()` + 幂等 + access token 不消费)
    - logout-all 行为契约(走 `JwtAuthGuard` + 撤销该 user 全部 + 返 `{ revokedCount }`)
    - 联动撤销四场景(本人改密 / 管理员重置 / 用户禁用 / 用户软删 → `updateMany` 同事务 + audit `extra.refreshTokensRevoked` 必写)
    - access token 行为锁定(不主动吊销 + 15m TTL 自然过期 + `JwtStrategy` 每请求查库阻断 DISABLED / 软删 + e2e §7.5 反向锁定断言继续保留)
    - 限流契约(`refresh` 新建独立 throttler 30/60 IP / `logout` 无限流 / `logout-all` 复用 `password-change` 5/60 IP;三 throttler 物理隔离;不暴露 `Retry-After` / `X-RateLimit-*` 头)
    - audit 4 新事件 + 1 隐含新增(`auth.login` / `auth.refresh` / `auth.logout` / `auth.logout-all` + `password.reset.by-admin`;命名 PR-3 启动前与既有 18 项逐字复核;`extra` 禁止写 refresh 明文 / `tokenHash` / `passwordHash`)
    - BizCode 段位锁死(仅 10007;**禁止**拆细)
    - 不做清单(`tokenVersion` / access blacklist / 查询接口 / 设备列表 / Redis / Queue / Cron / OAuth tree / httpOnly cookie / 改 `LoginDto` 入参 / 微信 OAuth)
    - 实施前置(`prisma migrate dev` 前必须先 `--create-only` 贴 SQL 等用户拍板;PR-3 启动前必须按评审稿 §11 五项复核点逐项 grep)
  - 改动点 5 — §17.3(V1.1 仍然不做):把"不做 refresh token / 微信登录..."行修订:`refresh token / logout / logout-all 由 P0-E 评审稿 v1 冻结后开放(铁律见 §9 P0-E 子节);两者均不通过 V1.1 工程加固通道实现`。
  - 改动点 6 — §17.1(CLAUDE.md only;V1.1 范围一句话总结):在历史段后追加 1 行 SRVF v0.13.0 注,明示 P0-E 走独立通道,与 V1.1 历史陈述不冲突。
  - **0 src / 0 prisma / 0 migration / 0 test / 0 OpenAPI snapshot / 0 新依赖 / 0 修改评审稿** 变更;`CLAUDE.md` / `AGENTS.md` P0-E 解锁面镜像对齐(两文件历史性差异段不在本期修订范围)。

- `docs(review): P0-E refresh token strategy v1`(本 PR 之前的 PR-1 评审稿,A 档 docs-only;条目随 PR-1 commit 已在 Unreleased 落地):
  - 新增 [`docs/first-release-p0e-refresh-token-review.md`](docs/first-release-p0e-refresh-token-review.md)(D 档前置评审稿 v1 正式版;沿 [P0-D 评审稿 4-PR 串行范式](docs/first-release-p0d-change-my-password-review.md) #115 → #116 → #117 → #118)。
  - 冻结 P0-E refresh token / logout / logout-all 设计决策 9 条(已由用户拍板):
    1. `LoginResponseDto` 扩展 `refreshToken` + `refreshExpiresAt` 2 字段(`LoginDto` 入参 schema 严格 zero drift;`refreshExpiresAt` 是 ISO 8601 UTC 字符串,表示 refresh token family 的 absolute expiration,rotation 继承同一时刻不滑动 — 沿评审稿 v1 §3.1 D-1 与 PR-2.x docs hotfix)
    2. 本期落地 `POST /api/auth/refresh`(rotation always + family revoke + absolute expiration)/ `POST /api/auth/logout`(幂等)/ `POST /api/auth/logout-all`(撤销该 user 全部 refresh)
    3. 本人改密 / 管理员重置密码 / 用户禁用 / 用户软删 → 主动撤销目标用户全部 refresh token(`updateMany` + `revokedReason`);access token **仍不主动吊销**(沿 D-4)
    4. **不**做 `tokenVersion`;JWT payload 严格 zero drift(`{ sub, username }`);`JwtStrategy.validate` 仍只看 `deletedAt + status === ACTIVE`,**不读** `passwordHash`
    5. access TTL `15m`(由当前 7d 收敛)/ refresh TTL `90d`(PR-2.x-2 docs hotfix 从 30d 调整,降低内部系统低频用户频繁重登的不便,沿评审稿 §3.5 D-5)/ **absolute expiration**(rotation 不延长 expiresAt;达到 `refreshExpiresAt` 后必须重新登录);不做 sliding expiration
    6. 新增 1 个 BizCode:`REFRESH_TOKEN_INVALID = 10007`(HTTP 401;沿 100xx users 段位,LOGIN_FAILED=10004 / 10005 / 10006 之后下一可用号位);**不拆** `EXPIRED` / `REVOKED` / `REPLAY`(沿 v1 §8 防账号枚举铁律)
    7. `refresh` 限流走新建独立 throttler 实例 `refresh`(IP 维度 30/60);`logout` 不限流;`logout-all` 复用 P0-D `password-change` throttler(IP 维度 5/60);全部命中走统一 42900,不暴露 `Retry-After` / `X-RateLimit-*` 头
    8. 新增 4 个 audit event:`auth.login` / `auth.refresh` / `auth.logout` / `auth.logout-all`(命名风格沿 P0-D `password.change.self` kebab-case;命名 PR-3 启动前再次复核);**隐含范围扩展**新增 `password.reset.by-admin`(管理员重置今未写 audit,PR-3 顺手补)
    9. 本期**不做**:refresh_tokens 查询接口 / 已登录设备列表 UI / 单设备管理 / 完整 OAuth tree / device fingerprint / httpOnly cookie / Redis / Queue / Cron / access token 黑名单 / `LoginDto` schema 变更 / `tokenVersion` / 微信小程序 OAuth
  - 评审稿含 §0 用途与定位 / §1 当前事实盘点(带文件+行号引用)/ §2 文档偏差修正 / §3 已决策 9 条 / §4 接口契约总览 / §5 安全规则(refresh token 生成与存储 / 数据模型 RefreshToken 草案 / 索引 / 清理策略 / timing 防御 / 日志-audit 敏感字段 / BizCode 段位 / 限流 / audit 4 事件)/ §6 rotation 流程 / §7 改密-禁用-删除联动 refresh 撤销 / §8 验收标准(新建 4 e2e spec + 修改 4 e2e spec + 新建 3 unit spec)/ §9 API/DTO/service/OpenAPI 影响清单 / §10 PR 拆分(强串行 PR-1 → PR-2 → PR-3 → PR-4)/ §11 代码 PR 前 5 项复核点 / §12 migration 风险与回滚策略(含 access TTL 7d → 15m 回滚口子)/ §13 D 档判定与降速依据(含禁止"顺手做"清单)/ §14 元信息与撰写边界。
  - 本评审稿**是评审稿,不代表已经允许直接写代码**;PR-2(`CLAUDE.md` / `AGENTS.md` 铁律解锁)merged 之前**禁止**开 PR-3;PR-3 在 `prisma migrate dev` 前**必须**先回到对话贴预生成 SQL 等用户确认(沿 [`CLAUDE.md §0`](CLAUDE.md))。
  - **0 src / 0 prisma / 0 migration / 0 test / 0 OpenAPI snapshot / 0 新依赖** 变更;**0 修改** `CLAUDE.md` / `AGENTS.md`(铁律解锁归下一 PR)。

- `docs(handoff): backfill P0-B test-bucket verification completion`(#125,合入于 2026-05-17;沿 P0-D PR-4 #118 状态回填范式):
  - 反映 **2026-05-17 测试 COS bucket(`ap-guangzhou`)5 步闭环验收已通过** 的事实;**未发现需要修改代码的问题**;代码层 attachments / storage / Provider / audit / 信息泄漏防御全部符合 v0.13.0 评审稿;代码层附件链路可进入第一版前端联调。
  - 修订 [`docs/handoff/v0.13.0.md`](docs/handoff/v0.13.0.md):§5.3 P0-B 行 ⏳ → ✅;新增 §5.5 详细验收回填段(验收日期 / 验收环境 / 验收链路 / 结论 / 保留说明);§7.2 表格行 P0-B 同步。
  - 修订 [`docs/first-release-readiness-plan.md`](docs/first-release-readiness-plan.md):§3.1 P0-B 段加 **状态** 头部 + 标记 ✅(测试 bucket);§4 / §5 表格行 P0-B 同步;§8 收尾段 P0-B 措辞同步。
  - **保留**:本次为**测试 COS 账号**(用户已做消耗限制,上线前会关闭);**生产上线前必须**更换为正式 bucket / IAM 子账号 / 独立 `STORAGE_ENCRYPTION_KEY`,并重新按 [`docs/ops/cos-production-rollout-checklist.md`](docs/ops/cos-production-rollout-checklist.md) §1-§9 全套跑 production 验收;归 **P0-H 部署演练** 范畴,本次**不**视为 P0-H 完成;P0-E / P0-F / P0-I 仍 ⏳ 未启动。
  - 0 代码 / schema / migration / 测试 / 依赖变更;0 secret / bucket 名 / APPID / signed URL / JWT 落仓库。

## v0.13.0 - 2026-05-17

v0.12.0 之后主线增量:P0-D 本人自助改密完整闭环(评审稿 → 铁律修订 → 代码实现 → 状态回填 4-PR 序列)+ 第一版前端联调包配套文档系列(P0-A 起步包 / P0-G BizCode mapping / P0-C bootstrap SOP / P0-D 状态回填)。**唯一运行时代码变更**为 P0-D PR-3 #117(`PUT /api/users/me/password`);其余 12 个 commit 均为 docs-only 或 chore。**0 schema / 0 migration / 0 新依赖 / 0 新 Permission seed**;**v1 已有 14 接口 + V2 117 + RBAC 16 + attachments 主 7 + 配置三表 15 + storage 5 既有路径 / 入参 / 主响应字段严格 zero drift**(contract snapshot 仅新增 1 路由 + 1 DTO + 2 BizCode 出现在错误码字段)。

**SemVer 拍板**:0.12.0 → 0.13.0 **minor**(向后兼容的能力扩展:新增 1 个本人接口 + 2 个 BizCode + 1 个 audit event + 1 个独立 throttler + 2 个 env);无 breaking;沿 v0.6.0 → v0.7.0 → v0.8.0 → v0.9.0 → v0.10.0 → v0.11.0 → v0.12.0 全部 minor 节奏。

### Added

- `feat(users): add self-service password change`(#117,squash commit `8a70573`):
  - P0-D 本人自助改密代码实现;严格按 [P0-D 评审稿](docs/first-release-p0d-change-my-password-review.md)(#115)§5 / §7 全部覆盖。
  - 新增 1 个 API 端点:`PUT /api/users/me/password`(任意登录用户;入参 `ChangeMyPasswordDto { oldPassword, newPassword }`,严格白名单 2 字段;响应沿 `userSafeSelect`,永不含 `passwordHash`)。
  - 新增 2 个 BizCode(沿 100xx users 业务级段位,LOGIN_FAILED=10004 之后下两个号位):`OLD_PASSWORD_INVALID = 10005`(HTTP 401;沿评审稿 §5.3:本人改密无账号枚举攻击面,不复用 10004 的模糊语义)/ `NEW_PASSWORD_SAME_AS_OLD = 10006`(HTTP 400;业务级语义校验)。
  - 新增 1 个独立 throttler 实例:`name: 'password-change'`,IP 维度 5 次 / 60 秒(`PASSWORD_CHANGE_THROTTLE_LIMIT` / `PASSWORD_CHANGE_THROTTLE_TTL_SECONDS` 可配),与登录限流物理隔离(登录失败爆破不消耗改密配额,反之亦然);沿 V1.1 内存 storage,不引入 Redis;不暴露阈值 / `Retry-After` / `X-RateLimit-*` 头。
  - 新增 1 个装饰器:`@PasswordChangeThrottle()`(metadata 标记型,沿 `@LoginThrottle` 范式);新增 metadata key `PASSWORD_CHANGE_THROTTLE_KEY` 与 throttler name 常量 `PASSWORD_CHANGE_THROTTLER_NAME = 'password-change'`。
  - 新增 1 个 audit event:`'password.change.self'`(写入 `AuditLogsService.log()` 落库;`resourceType='user'` / `resourceId=currentUser.id`;严格不写入 `oldPassword` / `newPassword` / `passwordHash` 任何明文或 hash;沿评审稿 §5.6)。
  - 新增 2 个 env 变量:`PASSWORD_CHANGE_THROTTLE_LIMIT`(默认 5,推荐区间 [1, 100])/ `PASSWORD_CHANGE_THROTTLE_TTL_SECONDS`(默认 60,推荐区间 [1, 3600]);任一非正整数或越界,启动 fail-fast。
  - 业务流程严格按评审稿 §5.2 顺序 1→5:`findFirst(notDeletedWhere)` 取当前 `passwordHash` → `bcrypt.compare(oldPassword)` → 严格 `===` 比较 oldPassword/newPassword(不 trim / toLowerCase)→ `bcrypt.hash(newPassword)` → `prisma.$transaction` 内 `user.update + auditLogs.log` 原子(沿 emergency-contacts / certificates 范式)。timing 防御:禁止"先比对 oldPassword === newPassword 跳过 bcrypt"的优化(避免泄漏 newPassword 与 oldPassword 是否相同信息)。
  - `UsersModule` 新增 `imports: AuditLogsModule`(供注入 `AuditLogsService`)。
  - **不主动吊销旧 token**:改密成功后 `JwtStrategy.validate` 仅看 `deletedAt + status === ACTIVE`,不读 `passwordHash`,已签发 token 仍有效;如需立即阻断,管理员把目标用户 `status` 改 `DISABLED`;`tokenVersion` / refresh token / token revoke 归 **P0-E** 统一评审,本接口**不**预实现。
  - 通过 e2e 21 用例覆盖评审稿 §7.1-§7.7(核心成功路径 / 错误码 / DTO 校验 / 跨角色 / 反向锁定旧 token / audit log 写入 + 不含敏感字段 / DB 状态 / 限流 6 连击);全量 e2e 1252/1252 通过(51 suites);contract snapshot diff 仅新增 1 路由 + 1 DTO + 2 BizCode 出现在错误码字段,**v1 已有路由 schema 零漂移**。
  - `users-me.e2e-spec.ts` FORBIDDEN_FIELDS 追加 `oldPassword` / `newPassword`,锁死 `PATCH /api/users/me` 仍不得接受密码字段。

### Changed

- `docs(p0d): allow self-service password change`(#116,squash commit `faf01ee`):
  - 修订 `CLAUDE.md` / `AGENTS.md` §1(v1 不做的事)/ §9(密码处理铁律)/ §11(`UpdateMyProfileDto` 白名单)/ §17.3(V1.1 禁止项):把 v1 原本"不实现本人改密码接口"明文升级为"P0-D 评审稿冻结后允许实现 `PUT /api/users/me/password`(铁律见 §9)";新增 8 条 §9 铁律覆盖接口路径 / 入参 DTO 严格白名单 / 错误码 / 限流 / audit / 不主动吊销旧 token / 不做首次登录强制改密 / 不做忘记密码;`UpdateMyProfileDto` 禁用字段扩到含 `oldPassword` / `newPassword`。

- `docs(first-release): backfill P0-D completion status`(#118,squash commit `b9c13d7`):
  - 同步 `docs/current-state.md` / `docs/first-release-readiness-plan.md` / `docs/first-release-frontend-scope.md` / `docs/first-release-bizcode-mapping.md` / `docs/first-release-bootstrap-sop.md` / `docs/security.md` 6 个文档,反映 P0-D 已落地事实。
  - 前端联调起步包总数:**总路由 138 → 139,起步包 50 → 51**(算式 51 + 42 + 46 = 139);新增 `PUT /users/me/password` 行;§5 P1 后接 users 行注释修订;§8.2 BizCode 起步包子集追加 10005 / 10006。
  - BizCode 全量表:`100xx + 101xx` users / auth 段从 **7 条 → 9 条**(新增 10005 / 10006);全量从 **122 条 → 124 条**(保留 P0-G 时刻 122 条为历史档案)。
  - `security.md` 已落地策略表追加 2 行(本人自助改密 + 改密接口防爆破);日志 redact 清单追加 `req.body.oldPassword` / `*.oldPassword`;Token 吊销升级路径补充本人改密同样不主动吊销旧 token,归 P0-E。
  - `bootstrap-sop.md` §9.1 默认 SUPER_ADMIN 创建段后追加"建议立即调 `PUT /api/users/me/password` 改默认占位密码"完整段(含接口特性 / 限流 / audit / token 行为);§13 排错表追加 10005 / 10006 两行。

### Docs

- `docs: add current-state and process entrypoints`(squash commit `55979a5`):新增 `docs/current-state.md`(当前事实入口)与 `docs/process.md`(协作流程 / PR 分级 / D 档降速 / release 收口制度)2 个权威源文档;`docs/current-state.md` 后续在每次 release / handoff / 状态回填后滚动维护。

- `docs: clarify archived documentation status`(squash commit `6880695`):在多个老草案 / 历史评审稿文档顶部添加"归档状态"段头,与"当前事实"文档区分。

- `chore: remove stale landed-pr comments`(squash commit `83d4764`):清理散落在主线文档的过期 PR 评论链接。

- `docs(first-release): add readiness plan`(squash commit `3b70934`):新建 `docs/first-release-readiness-plan.md`(第一版上线前总账,P0/P1/P2 三档剩余事项;P0-A/B/C/D/E/F/G/H/I 各项立项说明)。

- `docs(first-release): frontend integration scope`(squash commit `a240e0a`):新建 `docs/first-release-frontend-scope.md`(P0-A 前端联调范围清单,起步包 50 路由 + P1 后接 42 + 第一版不接 46;第 P0-D 落地后扩到起步包 51)。

- `docs(first-release): add bizcode mapping for frontend`(#111,squash commit `3e021fd`):新建 `docs/first-release-bizcode-mapping.md`(P0-G BizCode 翻译表,撰写时 122 条全量;经 P0-D #117 新增 10005 / 10006 后实数 124 条,P0-D PR-4 #118 同步本文)。

- `docs(first-release): backfill P0-G completion status`(#112,squash commit `231958b`):P0-G 落地状态回填到 readiness-plan / frontend-scope 等文档。

- `docs(first-release): add bootstrap SOP`(#113,squash commit `f516ae8`):新建 `docs/first-release-bootstrap-sop.md`(P0-C 从空仓库 / 空数据库 → 第一个真实账号可登录的 zero-to-login 串行 SOP;dev / staging / prod 三档差异;14 dict_type 清单 + 测试账号矩阵创建路径 + 5 分钟 dry-run + 13 行失败排查表;702 行)。

- `docs(first-release): backfill P0-C completion status`(#114,squash commit `92b1c77`):P0-C 落地状态回填到 readiness-plan 等文档。

- `docs(first-release): add change my password review`(#115,squash commit `842450e`):新建 `docs/first-release-p0d-change-my-password-review.md`(P0-D 评审稿,A 档 docs-only;冻结密码策略 / 错误码段位 / 限流参数 / audit 事件 / 不吊销旧 token / 4-PR 拆分;为 PR-2 / PR-3 / PR-4 提供严格落地依据)。

## v0.12.0 - 2026-05-16

V2 第一阶段在 v0.11.0(批次 7.5 C-7.5 Provider 全栈实施)基础之上,完成 **C-7.5 治理收口 + production storage_settings fail-fast + smoke env**(6 个 PR 累计:#97 ops SOP + #98 Fast-1 措辞清理 + #99 Slow-6 IN_USE 跨表引用约束 + #100 Slow-6 CHANGELOG 登记 + #101 L-1 system MIME blocked 拆码 + #102 production storage_settings fail-fast + APP_ENV=smoke for docker-smoke)。**新增 4 个 BizCode**(13030 / 13031 / 13032 / 13033)+ **AppEnv 新增 'smoke'** + **`isProductionLike` helper** + **6 处 production-like 守护改造**;**v1 14 + V2 117 + RBAC 16 + attachments 主 7 + 配置三表 15 + storage 5 既有接口路径 / 入参 / 主响应字段严格 zero drift**(contract snapshot CI 守护;7 端点 errorCode enum 增量;`@ApiOperation.summary` 文案微调,**不算 schema drift**);**累计 152 接口**(沿 v0.11.0);**累计 Prisma 表 24 张**(沿 v0.11.0);**0 schema / 0 migration / 0 新依赖 / 0 新 Permission seed / 0 新 AuditLogEvent**。

**SemVer 拍板**:0.11.0 → 0.12.0 **minor**(向后兼容的能力扩展:新增 4 个 BizCode + 3 端点 errorCode enum 增量(IN_USE)+ 2 端点 errorCode enum 增量(SYSTEM_MIME_BLOCKED)+ AppEnv 扩展 'smoke' + production 启动守护;**0 schema / 0 migration / 0 新依赖**;v1 14 + V2 117 + RBAC 16 既有接口零字段 / 路径 / 主响应字段改动;**无 breaking change**:`ATTACHMENT_MIME_NOT_ALLOWED`(13012)的系统级 MIME 黑名单子集被拆分到 13033,但同一拒绝场景从客户端"显示提示"层面看是更精准的语义,**不构成 breaking**;沿 v0.6.0 → v0.7.0 → v0.8.0 → v0.9.0 → v0.10.0 → v0.11.0 minor 风格)。

### Added

- `feat(attachments): enforce IN_USE constraint on config soft-delete (Slow-6)`(#99,squash commit `7acb2cf`):
  - 为附件类型配置、MIME 配置、尺寸限制配置的 soft-delete / 停用路径补齐跨表引用保护;沿评审稿 §8.1 段位预留 + Step 1 调研报告 + 用户 Q-cross / Q-cross-impl 全 A 拍板。
  - 新增 3 个 BizCode(全部 HTTP 409):`ATTACHMENT_TYPE_IN_USE`(13030)/ `ATTACHMENT_MIME_CONFIG_IN_USE`(13031)/ `ATTACHMENT_SIZE_LIMIT_CONFIG_IN_USE`(13032)。
  - 3 个 service 各加 1 个 `private async assertXxxNotInUse()`;5 个调用点(type / mime 各 softDelete + updateStatus → INACTIVE 双路径对称 + size softDelete);refCount > 0 即拒绝;不在 message / extra 暴露引用数(沿 v1 §10 信息泄漏防御)。
  - 5 个端点受影响(0 path / 0 DTO / 0 主响应字段 drift);仅 `@ApiBizErrorResponse` 追加对应 BizCode + `@ApiOperation.summary` 加 IN_USE 提示;contract snapshot 仅 errorCode enum + summary 文案增量。
  - 8 e2e 用例覆盖(test/e2e/attachment-configs.in-use.e2e-spec.ts);全套 e2e 50 suites / 1229 tests 通过。
  - **不改 API path / DTO / Prisma schema / migration / 主模块 7 端点行为**;不实装 `ATTACHMENT_SYSTEM_MIME_BLOCKED`(留独立 PR);不引入 FK(沿 D6 Q3 A 多态外键决议)。

- `feat(attachments): split system MIME blocklist error code`(#101,squash commit `200fd1e`):
  - V2.x L-1:把系统级 MIME 黑名单(`SYSTEM_MIME_BLOCKLIST`)从复用 `13012 ATTACHMENT_MIME_NOT_ALLOWED` 拆出独立 BizCode `13033 ATTACHMENT_SYSTEM_MIME_BLOCKED`(400);沿评审稿 §6.6 + §8.1 + Q3 v1.0 + Q-mb 全 A 拍板。
  - 段位说明:评审稿 §8.1 原本规划 `13031`,因 V2.x Slow-6 PR #99 已占用 `13031` 给 `ATTACHMENT_MIME_CONFIG_IN_USE`,故顺延至 `13033`(连续 13030/31/32 跨表 IN_USE 之后)。
  - 实施范围(方案 A):仅 attachments 上传校验链(`create` + `upload-url`)的 `isMimeBlocked` 命中点单独抛 13033;**`assertMimeAllowed` 保留"白名单未命中"路径继续抛 13012**(语义保留)。**配置三表 `attachment_mime_configs` CRUD 行为不变**(沿 §6.6 + Q3 v1.0 fail-close 原设计)。
  - 2 端点受影响(`POST /api/v2/attachments` + `POST /api/v2/attachments/upload-url`;0 path / 0 DTO / 0 主响应字段 drift);仅 `@ApiBizErrorResponse` 追加 + `@ApiOperation.summary` 微调。
  - 4 处 e2e 断言更新(`application/zip` / `video/mp4` 等系统级黑名单 13012 → 13033;`image/svg+xml` / `image/gif` 等"白名单未命中"场景**保留 13012**)。
  - **不改 prisma / migration / package / lockfile / docs 主线**;**不实装** `ATTACHMENT_SYSTEM_MIME_BLOCKED` 在配置三表层(沿方案 A 不破坏 §6.6 fail-close 哲学)。

- `feat(storage): production storage_settings fail-fast + APP_ENV=smoke for docker-smoke`(#102,squash commit `3a25a2c`):
  - V2.x production fail-fast:production 启动期**强制校验** `storage_settings` 必须真实初始化为可用 COS;**拒绝 LOCAL** / **拒绝缺凭证** / **拒绝缺 bucket/region** / **拒绝 disabled**。沿 Step 1 调研报告修正版 + 用户拍板修正版 1-9 项。
  - **AppEnv 扩展 `'smoke'`**(`src/config/app.config.ts` `VALID_APP_ENVS`):CI Docker smoke job 专用 AppEnv;**不得用于真实部署**。
  - **新增 `isProductionLike(env)` helper**:smoke + production 联合判断;**6 处守护改造**(`LOG_LEVEL` 默认 / `STORAGE_ENCRYPTION_KEY` 必填 / CORS 严格 / `swaggerEnabled` 默认禁 / `AllExceptionsFilter` 隐藏 message / logger `isProd` JSON 输出)→ smoke 行为完全沿 production。
  - **`StorageSettingsService.onApplicationBootstrap` 严格 5 项校验**(`env === 'production'` 严格守卫;smoke 跳过):settings 存在 + enabled=true + providerType=COS + bucket/region 非空 + credentialStatus=CONFIGURED;任一失败 throw Error → Pod CrashLoop;错误消息含 `docs/ops/cos-production-rollout-checklist.md §7 / §8` 修复指引;**永不**包含凭证 secret 明文 / 密文。
  - `docker-smoke.yml` `APP_ENV=production → smoke` + 详细注释。
  - Unit 新增 11 用例覆盖(env=dev/test/smoke 跳过 + env=production 5 校验逐一 + 成功路径);**0 e2e 新增**(沿"production env e2e 成本高 + 扰动既有 fixture"原则)。
  - **不改 schema / migration / Router / Provider / attachments / audit-logs / permissions / BizCode**;**不引入** 凭证 env / bootstrap env / LOCAL seed row。

### Docs

- `docs(ops): add COS production rollout checklist`(#97,squash commit `b87a4fb`):新建 `docs/ops/cos-production-rollout-checklist.md`(13 章节,766 行)— 运维 SOP 文档,用于 v0.11.0 C-7.5 Provider 全栈实施收口后,**队组织运维侧 + 维护者**协作将腾讯云 COS 接入生产链路。覆盖:bucket 创建 / IAM 最小 Policy 模板(CAM 控制台校验)/ CORS / lifecycle + versioning + SSE-COS / `STORAGE_ENCRYPTION_KEY` 生成与注入(K8s/Docker/Systemd 三种)/ Storage Settings 后台初始化 / reset-credentials 凭证录入(防 history 留痕)/ upload-url → PUT → confirm-upload → accessUrl 下载 → DELETE 5 步闭环验收 / 5 种回滚场景 / 15 条集中安全禁止项。新建子目录 `docs/ops/`;0 凭证 / bucket / APPID / 域名实值。

- `docs: clean up stale wording for v0.11.0(Fast-1)`(#98,squash commit `3775ade`):清理 v0.11.0 发布后散落在主线文档的过期措辞;沿 V2 红线 §5.4 最小修订原则(不删原文 / 不重写整段 / 段头补范围)。7 处变更(4 文件,+9/-5 行):TASKS.md §8.2 Q14/Q15 状态更新 + TASKS.md §8.5 Provider 实装状态更新 + V2 红线 C-7 行 `accessUrl 占位` → `accessUrl 已真实化` + README.md "v0.7.0 后状态" → "v0.11.0 后状态" + 3 处段头适用范围注脚(TASKS §0 / ARCHITECTURE §11.3 / §12.4)。

- `docs(changelog): record Slow-6 IN_USE constraint in Unreleased`(#100,squash commit `e81458f`):补记 PR #99 Slow-6 IN_USE 跨表引用约束到 `CHANGELOG.md` 的 `## Unreleased` 段(作为下一版本候选内容);**不回改 `## v0.11.0 - 2026-05-16` 段**(沿 release notes 不回改原则)。

## v0.11.0 - 2026-05-16

V2 第一阶段在 v0.10.0(批次 7 C-7 attachments 全模块实施收官)基础之上,完成 **V2.x C-7.5 Provider 选型评审 + 实施全栈落地**(批次 7.5 ≈ C-7 的 Provider 接通 + 后台凭证管理;沿 D7-provider v1.0 35 项决议;**13 个 PR 累计**:#82-#85 设计/立项 4 PR + #86-#93 实施 7 PR + 1 P1 技术债 + landing PR #94 + 本 PR bump version)。**新增 1 张表 + 5 个 API + 3 个 StorageProvider 方法 + 2 个 enum + 1 个 unique 约束**;**腾讯云 COS Provider + LocalProvider + 动态路由 + AES-256-GCM 凭证加密 + signed URL 直传 + 后台凭证管理**全部就绪。**v1 14 + V2 117 + RBAC 16 + attachments 主 7 + 配置三表 15 既有接口 schema + paths 严格 zero drift**(contract snapshot CI 守护;`AttachmentResponseDto.accessUrl.description` 文案微调 1 行,字段类型 `string | null` 不变,**不算 schema drift**)。**累计 122 接口**(原 117 + 5 storage)。**累计 Prisma 表 23 张**(原 22 + 1 storage_settings)。**0 新 BizCode / 0 新 RBAC Permission / 0 新 AuditLogEvent**(沿评审 B3 / B4 / §6.6.5)。**新增 1 个运行时依赖**:`cos-nodejs-sdk-v5@^2.15.4`(Q-89-8;加密辅助沿 Node 原生 crypto,0 新依赖)。

**SemVer 拍板**:0.10.0 → 0.11.0 **minor**(向后兼容的能力扩展:新增 5 V2 接口 + 1 表 + 2 migrations + 1 runtime 依赖 + 2 enum + 3 StorageProvider 方法;v1 14 + V2 117 + RBAC 16 既有接口零字段 / 路径 / 错误码改动;无 breaking change;`AttachmentResponseDto.accessUrl` 字段值由"恒返 null"变为"成功 URL / 失败 null",字段类型 `string | null` 不变,**不构成 breaking change**;`Attachment.key` 加 `@unique` 约束在 v0.10.0 release 前未有生产数据写入,**不构成 breaking change**;沿 v0.6.0 → v0.7.0 → v0.8.0 → v0.9.0 → v0.10.0 minor 风格)。

### Added

C-7.5 Provider **完整能力全部落地**(沿 D7-provider v1.0 35 项决议 + Q-87 / Q-89 / Q-90 / Q-10 / Q-11 / Q-UK 全部子项拍板;**8 个实施 PR 累计**:#86 interface + #87 schema + reader + #88 LocalProvider + #89 CosProvider + Router + #90 wire attachments + #91 upload-url + confirm-upload + #92 P1 技术债 + #93 后台 admin API):

| 维度 | 数量 |
|---|---|
| Prisma 表 | **+1**(`storage_settings` 15 字段;沿 Q24 一次设计完整)|
| Prisma enum | **+2**(`StorageProviderType` LOCAL/COS / `StorageMimePolicyMode` INHERIT/OVERRIDE)|
| Prisma migrations | **+2**(`v2_c75_storage_settings` + `attachment_key_unique`)|
| Prisma unique 约束 | **+1**(`attachments.key @unique`;P1 技术债 #92;并发 replay 防御)|
| API 端点 | **+5**(主模块 +2:`POST /attachments/upload-url` + `POST /attachments/confirm-upload`;后台 +3:`GET /storage-settings` + `PATCH /storage-settings` + `POST /storage-settings/reset-credentials`)|
| StorageProvider 方法 | **+3**(`generateUploadUrl` / `generateDownloadUrl` / `headObject`;沿 F5 6 方法)|
| StorageProvider 类型 | **+5**(`GenerateUploadUrlInput` / `UploadUrlResult` / `GenerateDownloadUrlInput` / `DownloadUrlResult` / `HeadObjectResult`)|
| Provider 实现 | **+2**(`LocalStorageProvider` dev/test + `CosStorageProvider` 生产 COS)|
| Provider 路由 | **+1**(`StorageProviderRouter` 动态;每次方法调用 resolve;沿 settings 60s cache)|
| Service | **+2**(`StorageSettingsService` 读取层 + `StorageCryptoService` AES-256-GCM 加密 helper)|
| HMAC token util | **+1**(`upload-token.util.ts` HMAC-SHA256 紧凑格式;0 jsonwebtoken 依赖)|
| BizCode | **0 新增**(沿 B3 / Q-10-11 / Q-11-4;复用 13001/13010-13013/13015/30100/40100/INTERNAL_ERROR)|
| RBAC Permission seed | **0 新增**(沿 B3;upload-url / confirm-upload 复用 `attachment.upload.<type>.<scope>`;后台 CRUD 走 `@Roles(SUPER_ADMIN, ADMIN)`)|
| AuditLogEvent union | **0 新增**(沿 B4 + §6.6.5;`attachment.upload` extra 加 `uploadConfirmedAt + uploadVia: 'direct'`;storage_settings 0 audit)|
| 运行时依赖 | **+1**(`cos-nodejs-sdk-v5@^2.15.4`;加密辅助沿 Node 原生 crypto / scrypt / randomBytes,0 新依赖)|
| env 变量 | **+2**(`STORAGE_ENCRYPTION_KEY` 必填 prod / `STORAGE_LOCAL_ROOT` LocalProvider 根目录)|
| 实施 PR | **8 个**(#86-#93;集中 2026-05-15 ~ 2026-05-16 落地)|
| Unit 增量 | **+88**(原 764 → 852;含 storage 22 + LocalProvider 16 + cos+router 32 + upload-token 18)|
| E2E 增量 | **+58**(原 1163 → 1221;含 28 upload + 30 storage-settings)|
| Contract 增量 | **+11**(原 240 → 251;5 paths + 6 DTO schemas)|

**关键里程碑**:

- **腾讯云 COS Provider 实装**(沿 F3 / Q1 / Q4):`cos-nodejs-sdk-v5@^2.15.4`;读 `storage_settings` 不依赖 env(沿 Q23);每次方法调用 `requireCosContext()`(不缓存 SDK;沿 Q-89-2);4 档守护(settings null / providerType 错配 / credentialStatus 非 CONFIGURED / bucket+region 缺失)
- **LocalStorageProvider 实装**(沿 F2;dev / test 主路径):fs.writeFile + 路径安全防御(防 `../` 逃逸);ENOENT 幂等
- **StorageProviderRouter 动态路由**(沿 Q-89-1):每次方法调用 `resolve()`;`STORAGE_PROVIDER` DI token = `useExisting StorageProviderRouter`;运维改 `storage_settings.providerType` ≤ 60s 内自动切换;无需重启
- **`storage_settings` 表 + 配置读取层**(沿 §6.5 + Q24):一次设计 15 字段(首期闲置 2 字段;沿 §6.5.3);Service 60s 缓存 + 解密 + 三档状态合成
- **AES-256-GCM 凭证加密**(沿 §6.6.1 + Q21):scrypt 派生 32 字节 key + 随机 12B IV + 16B authTag;复用 `STORAGE_ENCRYPTION_KEY` env(沿 v1 `JWT_SECRET` 范式);**明文永不入 DB / 日志 / audit / response**
- **`accessUrl` 真实化**(沿 Q14 + PR #90):由恒返 null 改为 `provider.generateDownloadUrl()` 返签名 URL;Provider 不可用时降级 null + WARN 日志(沿 §6.6.3 信息泄漏防御)
- **`POST /upload-url` + `POST /confirm-upload`**(沿 §8.3 + §8.4 + Q5/Q6/Q7):模式 B 签名直传;`uploadToken` HMAC-SHA256 紧凑格式(类 JWT 不引入 jsonwebtoken;沿 §8.3.4);Service 流程 6 步(验签 → headObject → size 一致 → PII 不重做 → 落库 + audit fail-fast → generateDownloadUrl 填 accessUrl)
- **后台 Storage Settings CRUD + reset-credentials**(沿 §6.5 + §6.6 + Q-11):`@Roles(SUPER_ADMIN, ADMIN)` 入口;PATCH upsert(不存在创建 default;沿 Q-11-1);凭证只允许 reset 替换(沿 §6.6.2);`credentialStatus` 三态化(configured / missing / invalid;沿 §6.6.3);`StorageSettingsService.invalidate()` 缓存主动失效
- **`Attachment.key @unique` P1 技术债修复**(PR #92;承接 PR #91 已知偏差):双层防御 = Service 层 `findFirst` 早返(串行场景省事务开销)+ DB UNIQUE 强制 + P2002 catch(并发 race 兜底)
- **0 新依赖加密路径**:Node 原生 `crypto`(AES-256-GCM / HMAC-SHA256 / scrypt / randomBytes / timingSafeEqual);沿 V1.1 §17.3 严控
- **v1 14 + V2 117 + RBAC 16 接口 zero drift**:Contract snapshot CI 守护

**未做项 / 仍挂起项**(沿 v1.0 已锁挂起 + Q-11-3 / Q-11-6 / §6.6.5;**留 v1.1+ 或独立后续 PR**):

- uploadToken 重放防御 / 黑名单(沿 §8.4.4;依赖 `attachment.key UNIQUE` + P2002,已由 PR #92 强化)
- 失败回滚 Provider 文件(沿 §8.4.4;依赖 Provider lifecycle 30 天兜底)
- multipart upload 支持(沿 Q13;单文件 ≤ 5GB 走 PUT signed URL)
- STS 临时凭证(沿 Q19;不采用)
- 跨 Provider 迁移路径(沿 Q15;COS 暂不迁移)
- bootstrap fallback(env 兜底自动创建 row;沿 Q-11-3;留 v1.1+ 专项 PR)
- test-connection API(沿 Q-11-6;留 COS 真实凭证联调专项)
- Storage Settings 配置变更 audit_logs(沿 §6.6.5;留独立专项 PR)
- **生产侧 COS bucket / IAM / CORS / lifecycle / versioning / SSE-COS 配置**(由队组织运维侧承载;系统侧不硬编码;沿 §6.4)
- **生产凭证录入**(运维通过 `POST /storage-settings/reset-credentials` + `STORAGE_ENCRYPTION_KEY` env;沿 §6.6.2)
- **版本号 bump / git tag / GitHub Release / v0.11.0 handoff**(留独立 PR #13 / #14 + 维护者手动;本 landing **不动** `package.json` / Swagger version)

### Docs

- `chore: bump version to 0.11.0`(本 PR):V2 第一阶段 v0.11.0 版本收口 bump;沿 v0.10.0 / v0.9.0 / v0.8.0 / v0.7.0 / v0.6.0 历次 bump PR 一致范式;变更 3 文件:`package.json` `version` 字段 `0.10.0 → 0.11.0` + `src/bootstrap/apply-swagger.ts` `setVersion('0.10.0') → setVersion('0.11.0')` + 本 CHANGELOG `Unreleased` 段折叠为 `## v0.11.0 - 2026-05-16` 段(Unreleased 留 `(无;待下一波)` 占位);**SemVer 拍板** 段写入 v0.11.0 段开头(沿 v0.10.0 / v0.9.0 / v0.8.0 范式;"推荐"→"拍板");**不动**代码逻辑 / schema / migration / seed / pnpm-lock.yaml / 测试 / `prisma/**` / `test/**` / `.github/**` / `docs/**`;**不打 git tag**(留维护者手动操作;沿 v0.10.0 handoff §6 + PR #80 范式)/ **不发 GitHub Release**(沿 §6)/ **不新建 v0.11.0 handoff**(留独立后续 PR;沿 PR #80 → PR #81 两段范式);沿历史 5 次 bump PR(#32 / #42 / #63 / #80)一致范式
- `docs(v2): record C-7.5 provider implementation landing`(PR #94,squash commit `8f135e8`):C-7.5 Provider 实施收口文档登记;4 处文档修订(本 CHANGELOG `Unreleased` `### Added` 段 + [`TASKS.md §9`](TASKS.md) C-7.5 任务清单 + [`docs/V2红线与复活路径.md`](docs/V2红线与复活路径.md) §4.3 C-10 行 + [`docs/批次7_provider选型_V2x立项记录.md`](docs/批次7_provider选型_V2x立项记录.md) §四 PR 拆分实际完成清单 + §六合并后下一步);**仅 docs**,不动代码 / schema / migration / 测试 / package.json / pnpm-lock.yaml / src/** / prisma/** / test/** / .github/** / [`docs/批次7_provider选型_API前评审.md`](docs/批次7_provider选型_API前评审.md)(v1.0 冻结稿;沿 §18.7)/ [`docs/handoff/v0.10.0.md`](docs/handoff/v0.10.0.md)(历史 handoff;沿 V2 红线 §5.1)/ README.md / ARCHITECTURE.md / CLAUDE.md / AGENTS.md;**不 bump version / 不打 tag / 不发 Release / 不启动 bump PR / handoff PR**(留独立 PR);沿 C-7 attachments landing PR #79 范式
- `feat(storage): add Storage Settings admin APIs and credential reset`(PR #93,squash commit `85cae45`):Storage Settings 后台管理 API 全部落地;3 端点(`GET /storage-settings` + `PATCH /storage-settings` upsert + `POST /storage-settings/reset-credentials`);3 DTO(`StorageSettingsResponseDto` / `UpdateStorageSettingsDto` / `ResetStorageCredentialsDto`);凭证 6 层防护(response / 日志 / DB 密文 / IV 随机 / forbidNonWhitelisted / 出参 DTO 字段集);credentialStatus 三态全覆盖;Q-11-1 到 Q-11-19 全部 19 项拍板落地;30 e2e + 0 新 BizCode / 0 audit / 0 prisma / 0 package(沿 §6.5 / §6.6 + Q-11)
- `chore(prisma): add unique constraint for attachment key`(PR #92,squash commit `fc08d17`):P1 技术债修复(承接 PR #91 已知偏差);Attachment.key 加 @unique;1 migration(单条 CREATE UNIQUE INDEX;0 ALTER / 0 DROP);Service 注释更新("@unique + findFirst + P2002 双层兜底");dev DB 重复 key 自检 0 行;沿评审 §8.4.4 原始设计 + Q-UK-1 到 Q-UK-10 拍板
- `feat(attachments): add upload-url and confirm-upload APIs`(PR #91,squash commit `527aa47`):attachments 模式 B 签名直传 API 落地;2 端点(`POST /upload-url` + `POST /confirm-upload`);3 DTO + uploadToken HMAC-SHA256 紧凑格式(0 jsonwebtoken 依赖;复用 STORAGE_ENCRYPTION_KEY);Service 流程 6 步(验签 → headObject → size 一致 → PII 不重做 → 落库 + audit fail-fast → generateDownloadUrl 填 accessUrl);28 e2e + 18 upload-token unit;0 新 BizCode(复用 13001/13010-13013/13015/30100;信息泄漏防御);audit extra 加 `uploadConfirmedAt + uploadVia:'direct'`(沿 B4);Q-10-1 到 Q-10-15 全部拍板落地
- `feat(attachments): wire storage provider into attachment accessUrl and delete flow`(PR #90,squash commit `119778c`):attachments 接通 storage Provider;`accessUrl` 由恒返 null → `provider.generateDownloadUrl()` 真实 URL(失败降级 null + WARN);7 调用点全部 await `this.toResponseDto`;`delete` 末尾事务外 `tryDeleteFromProvider`(失败 warn 不回滚 DB / audit;沿 F4 + Q3 路线 C);contract snapshot 仅 `accessUrl.description` 1 行文案微调(字段类型不变;不算 schema drift);Q-90-1 到 Q-90-9 全部拍板落地
- `feat(storage): add CosStorageProvider with dynamic router for C-7.5 v1.0`(PR #89,squash commit `f44310c`):CosStorageProvider 5 方法实装(`cos-nodejs-sdk-v5@^2.15.4`;每次方法调用 `requireCosContext()` 不缓存 SDK;4 档守护);StorageProviderRouter 动态路由(`STORAGE_PROVIDER` DI token = `useExisting StorageProviderRouter`;运维改 settings ≤ 60s 自动切换;0 重启);CosProviderUnavailableError 单独 export;jest.mock 整包 SDK(0 真实联网);32 unit + 1 新依赖;Q-89-1 到 Q-89-8 全部拍板落地
- `feat(storage): add LocalStorageProvider for C-7.5 v1.0`(PR #88,squash commit `bceba0f`):LocalStorageProvider 5 方法实装(fs 读写 + 路径安全防御 / `../` 逃逸 throw / ENOENT 幂等 / generateUploadUrl 返 stub URL / generateDownloadUrl 返相对 URL);`storage.constants.ts` Symbol DI token;`storage.module.ts` providers 注册;`STORAGE_LOCAL_ROOT` env(default `./tmp/storage`);`.gitignore` 加 `tmp`;16 unit;Q-88-1 到 Q-88-7 全部拍板落地(0 Provider 实装外溢)
- `chore(prisma): add storage_settings schema and config reader for C-7.5 v1.0`(PR #87,squash commit `45ae871`):storage_settings schema(15 字段一次设计完整;沿 Q24)+ 2 enum(`StorageProviderType` / `StorageMimePolicyMode`)+ 1 migration;StorageSettingsService(60s 缓存 + 解密 + 三态合成 + singleton 防御)+ StorageCryptoService(AES-256-GCM;Node 原生 crypto + scrypt;0 新依赖)+ StorageModule 装载;`STORAGE_ENCRYPTION_KEY` env 启动校验(production fail-fast);28 unit;`.env.example` 同步;sync `.env.test` STORAGE_ENCRYPTION_KEY 由后续 PR #91 补;Q-87-1 到 Q-87-6 全部拍板落地
- `chore(storage): extend StorageProvider interface for C-7.5 v1.0`(PR #86,squash commit `fc8241d`):StorageProvider interface 扩展 +3 方法(`generateUploadUrl` / `generateDownloadUrl` / `headObject`;沿 F5 6 方法)+5 类型;0 实装 / 0 callsite / 0 module wiring(沿评审 §7.4 v1.0 锁;Q5a expiresIn=number 秒 / Q5b headers Record<string,string> 必填 / Q5c method 'PUT'|'POST' 联合保留默认 'PUT')
- `docs(v2-design): start C-7.5 provider V2.x implementation track`(PR #85,squash commit `5e12511`):C-7.5 Provider 选型 V2.x 立项 PR;新建 [`docs/批次7_provider选型_V2x立项记录.md`](docs/批次7_provider选型_V2x立项记录.md) 9 章节(沿 D7-attachments 立项 PR #69 范式);TASKS §9 + V2 红线 §4.3 C-10 行 + 本 CHANGELOG Unreleased;**仅 docs**,不动代码;承接 v1.0 冻结(PR #84 `f8b357d`)+ D7-attachments Q14/Q15 挂起项
- `docs(v2-design): freeze provider selection review v1.0`(PR #84,squash commit `f8b357d`):C-7.5 v1.0 冻结稿(35 项决议:F 5 + B 5 + Q 25;Q5/Q6/Q7 接口与 DTO 锁 + Q8 TTL 升级锁;**禁止扩 scope**;**目标 = v1.0 冻结后直接可进入立项 PR**)
- `docs(v2-design): refine provider selection review decisions v0.2`(PR #83,squash commit `8d19a07`):C-7.5 v0.2 局部收口 + 架构修订(锁腾讯 COS Q1/Q4 + 14 项 Q;**新增 Q20-Q25 后台配置 + 凭证加密架构修订**;13 PR → 14 PR)
- `docs(v2-design): add provider selection review draft v0.1`(PR #82,squash commit `6dbdbed`):C-7.5 Provider 选型评审 v0.1 草稿(5 项 F 锁 + 5 项 B 锁 + 15 项 Q 待评审;承接 D7-attachments Q14/Q15 挂起项 + D6 决议 5)

## v0.10.0 - 2026-05-15

V2 第一阶段在 v0.9.0(批次 8 C-6 RBAC 全模块实施收官)基础之上,完成 **V2.x C-7 attachments 全模块实施**(批次 7;沿 D7-attachments v1.0 27 项决议;**9 个实施 PR + landing PR + bump PR 累计**:#70 适配 + #71 schema + #72-#74 配置三表 CRUD + #75 seed + #76 主模块 + #77 主模块 audit + #78 配置三表 audit + #79 docs landing + 本 PR bump version);**新增 22 个 attachments 端点 + 4 张表 + 13 条 BizCode + 20 条 Permission seed + 1 个 RbacRole 内置角色 + 3 个 AuditLogEvent**;**首次业务模块接入 RBAC `rbac.can()` + audit_logs 同事务 fail-fast**;**v1 14 + V2 79 + RBAC 16 既有接口 schema + paths 严格 zero drift**(contract snapshot CI 守护);**累计 117 接口**(原 95 + 22 attachments);**累计 Prisma 表 22 张**(原 18 + 4 attachments);**累计 BizCode 段位实装**(沿用 RBAC 14 + audit 8 等基础上新增 130xx 段 13 项);**累计 AuditLogEvent union 17 项**(原 14 + 3 attachments)。

**SemVer 拍板**:0.9.0 → 0.10.0 **minor**(向后兼容的能力扩展:新增 22 个 V2 接口 + 4 张表 + 1 个 migration + 20 条 Permission seed + 1 个 RbacRole 内置角色 + 3 个 AuditLogEvent;v1 14 + V2 79 + RBAC 16 既有接口零字段 / 路径 / 错误码改动;无 breaking change;`Certificate.attachmentKey` drop column 在本 v0.10.0 release 前已通过 PR #71 在 schema + e2e 中彻底清理 — 该字段为 v2 batch 2 引入时即标记为废弃,无生产数据依赖,**不构成 breaking change**(沿 D6 Q10 B / D7 v1.0 §4.6 + 用户拍板提前清理);沿 v0.6.0 → v0.7.0 → v0.8.0 → v0.9.0 minor 风格)。

### Added

C-7 attachments **完整能力全部落地**(沿 D7 v1.0 27 项决议 + 用户 PR #6a/#6b/#6c/#6d 拍板;**9 个实施 PR 累计**:#70 适配 + #71 schema + #72-#74 配置三表 CRUD + #75 seed + #76 主模块 + #77 主模块 audit + #78 配置三表 audit;详见 §C-7 实施收口摘要 + 下方逐 PR 登记):

| 维度 | 数量 |
|---|---|
| Prisma 表 | **+4**(`attachments` / `attachment_type_configs` / `attachment_mime_configs` / `attachment_size_limit_configs`) |
| API 端点 | **+22**(主模块 7 + type×6 + mime×6 + size×5;sizeLimit 表无 status 字段) |
| BizCode(130xx 段) | **+13**(13001 / 13010-13013 / 13015 / 13020-13027) |
| Permission seed | **+20 条 `attachment.*`**(member×8 + certificate×8 + activity×4) |
| RbacRole 内置角色 | **+1**(`member` placeholder + 9 条 RolePermission:8 `.self` + 1 `activity.view`) |
| AuditLogEvent | **+3**(`attachment.upload` / `attachment.delete` / `attachment.config.change`;union 现 17 项) |
| 实施 PR | **9 个**(#70-#78;2026-05-15 同日全部 squash merge) |
| e2e 增量 | **+91 用例**(attachments.e2e 51 + attachments.audit 19 + attachment-configs.audit 21) |

**关键里程碑**:

- **首次业务模块接入 `rbac.can()`**(沿 D7 F3 + F5;attachments 主模块 PR #6b):入口仅 `JwtAuthGuard`,**不加 `@Roles(...)`**;7 个端点全部在 Service 层显式调 `rbac.can(user, action, resource?)`,失败统一抛 `BizException(BizCode.RBAC_FORBIDDEN)`(30100);PermissionsModule 同步 `exports: [RbacService]` 供首批业务消费
- **首批主模块 + 配置模块都接入 audit_logs**(沿 D7 F6 + D6 同事务 fail-fast):11 个配置写端点共用单事件 `attachment.config.change`(`extra.configType` + `extra.operation` 区分;沿 D11 路线 A);2 个主模块写端点用独立事件 `attachment.upload` / `attachment.delete`;校验链留事务外,写入 + audit 同 `$transaction(async (tx) => ...)` 一起提交,P2002 / audit 失败 → 一起回滚
- **首次接入 RBAC 4 段 code**(`attachment.<action>.<resourceType>.<scope>`):适配 PR #70 把 `CODE_PATTERN` 从 3 段放宽到 3-4 段(沿 F1);D7-RBAC v1.2 文档修订(PR #66)已提前落地正则规则
- **ownerType 双层校验**(沿 Q5):业务层 `AttachmentOwnerType` TS enum(`'member' | 'certificate' | 'activity'`)代码防错 + 配置表 `attachment_type_configs.code` 运行时权威白名单;两者必须保持同步
- **PII 检测**(沿 Q9):身份证号正则 `\d{17}[\dXx]` 在 `originalName` / `description` / `tags` 三字段;**不调用 OCR**;命中抛 `BizException(BizCode.ATTACHMENT_PII_DETECTED)`(13015)
- **系统级 MIME 黑名单**(沿 Q13 + §6.6):`application/zip` / `video/*` 等 8 项精确 + 1 项通配前缀;Service 层硬编码;即使后台运营在 `attachment_mime_configs` 配置为 ACTIVE 也不允许通过
- **信息泄漏防御**(沿 Q13 PR #6b):读路径(`GET /:id`)不存在 + 无权统一返 `13001`;写路径(`PATCH` / `DELETE`)沿用 `30100 RBAC_FORBIDDEN`
- **v1 14 + V2 79 + RBAC 16 接口 zero drift**:Contract snapshot CI 守护;OpenAPI paths + schemas 不漂移

**未做项 / 仍挂起项**(沿 D7 v1.0 已锁挂起;**留独立后续 PR / 由业务方提供**):

- Provider 实装(沿 F2 + B9 + Q14 / Q15;签名 URL / STS / 中转代理 / 删除失败处理 / 生命周期策略由 Provider 选型独立评审决定)
- ADMIN 内置角色 / ADMIN 自动持 `.other` 全集(Q12 沿用挂起;留独立"RBAC 内置角色 / ADMIN 默认附件权限"专项评审 PR;实施期默认按方案 B)
- 退队清理 N 具体值(Q8 v1.1;`Member.status=DISABLED ≥ N` + 后台提示语义已锁,**N 不在 schema 硬编码**,由队里管理层 / 合规口径确认)
- 入队同意书正式条款文本(B8 v1.1;最低原则四锚点已锁,正式文本由业务方提供,**不写入本系统仓库**)
- 跨表引用约束(13030 `ATTACHMENT_TYPE_IN_USE` 等;Q2 / Q6 / Q7 v1.0:本 C-7 不查跨表;留专项 PR)
- 业务模块全面接入 `rbac.can()`(超 C-7 范围;不在本 landing 边界)
- **版本号 bump / git tag / GitHub Release / v0.9.1 handoff**(留独立 PR;本 landing **不动** `package.json` / Swagger version)

### Docs

- `chore: bump version to 0.10.0`(本 PR):V2 第一阶段 v0.10.0 版本收口 bump,沿 v0.9.0 / v0.8.0 / v0.7.0 / v0.6.0 三次 bump PR 一致范式;变更 3 文件:`package.json` `version` 字段 `0.9.0 → 0.10.0` + `src/bootstrap/apply-swagger.ts` `setVersion('0.9.0') → setVersion('0.10.0')` + 本 CHANGELOG `Unreleased` 段折叠为 `## v0.10.0 - 2026-05-15` 段(Unreleased 留 `(无;待下一波)` 占位);**SemVer 拍板** 段写入 v0.10.0 段开头(沿 v0.9.0 / v0.8.0 范式);**不动**代码逻辑 / schema / migration / seed / pnpm-lock.yaml / 测试 / `prisma/**` / `test/**` / `.github/**` / `docs/**`;**不打 git tag**(留维护者手动操作;沿 v0.9.0 handoff §6.1 + PR #63 范式)/ **不发 GitHub Release**(沿 §6.2)/ **不新建 v0.10.0 handoff**(留独立后续 PR;沿 PR #63 → PR #64 两段范式);沿历史 4 次 bump PR(#32 / #42 / #63)一致范式
- `docs(v2): record C-7 attachments implementation landing`(PR #79,squash commit `656df13`):C-7 attachments 实施收口文档登记;4 处文档修订(本 CHANGELOG `Unreleased` `### Added` 段 + [`docs/V2红线与复活路径.md`](docs/V2红线与复活路径.md) §4 C-7 行 + [`docs/批次7_attachments_V2x立项记录.md`](docs/批次7_attachments_V2x立项记录.md) §一时间线 + §四 PR 拆分 + §六合并后的下一步 + [`TASKS.md §8`](TASKS.md) C-7 任务清单);**仅 docs**,不动代码 / schema / migration / 测试 / package.json / pnpm-lock.yaml / src/** / prisma/** / test/** / .github/** / `docs/批次7_attachments_API前评审.md`(D7 v1.0 冻结文档)/ `docs/handoff/v0.9.0.md`(历史 handoff)/ `docs/批次8_RBAC_*` / README.md / ARCHITECTURE.md / CLAUDE.md / AGENTS.md;**不 bump version / 不打 tag / 不发 Release / 不新建 handoff**(留独立 PR 由维护者拍板;**版本号 bump 已由本 v0.10.0 chore PR 完成**);沿 C-6 RBAC landing PR #62 范式
- `feat(attachments): integrate attachment config audit logs`(PR #78,squash commit `8ee24e2`):配置三表 11 个写端点接入 audit_logs;新增 `AuditLogEvent.attachment.config.change`(union 现 17 项;路线 A 单事件名 + extra 区分);`resourceType` 按表区分(`attachment_type_config` / `attachment_mime_config` / `attachment_size_limit_config`);`extra.configType ∈ {type, mime, sizeLimit}` + `extra.operation ∈ {create, update, update-status, delete}`;`update-status` 沿 cert.verify/reject 状态机范式 before/after 仅 `{ status }`;同事务 fail-fast;P2002 兜底外层包 `$transaction`;snapshot 不含 id / 时间戳 / deletedAt;新增 21 个 audit e2e 用例(`test/e2e/attachment-configs.audit.e2e-spec.ts`);contract 0 drift;沿 D7 v1.0 §7.1 / §7.2 + 用户 PR #6d Q1-Q8 拍板
- `feat(attachments): integrate audit logs`(PR #77,squash commit `abd9b32`):attachments 主模块 2 个写端点接入 audit_logs;新增 `AuditLogEvent.attachment.upload` / `attachment.delete`;`extra.scope ∈ {'self', 'other', null}`(activity 粗粒度为 null);`extra.deletedByPath ∈ {'owner', 'admin'}`(按 `currentUser.id === uploadedBy` 判定);`toAttachmentAuditSnapshot()` 13 字段完整快照(不含 `accessUrl` / `checksum` / `etag` / `id` / 时间戳);Controller 加 `@Req()` + `buildAuditMeta`;Service `create` / `delete` wrap `$transaction(async (tx) => ...)`;校验链留事务外;**不审计 PATCH metadata**(Q7 锁)/ **不审计 view/list**(R4)/ **不审计失败操作**(F6 fail-fast);新增 19 个 audit e2e 用例(`test/e2e/attachments.audit.e2e-spec.ts`);contract 0 drift;沿 D7 v1.0 §7.1 / §7.2 + 用户 PR #6c Q1-Q8 拍板
- `feat(attachments): add attachments main module with RBAC integration`(PR #76,squash commit `308d6d9`):attachments 主模块 **7 个端点 + RBAC 集成**(`POST /api/v2/attachments` 创建 / `GET /api/v2/attachments` 列表 / `GET /by-owner` 按归属列表 / `GET /me/uploaded` 本人上传列表 / `GET /:id` 详情 / `PATCH /:id` 更新元数据 / `DELETE /:id` 物理删);入口仅 `JwtAuthGuard`(沿 F3;**不加 `@Roles`**);全部判权在 Service 层 `rbac.can()`(沿 F5);ownerType 双层校验(13010)+ ownerId 真实性(13011);mime 三层校验(系统级黑名单 + `attachment_mime_configs` override + `defaultMimeWhitelist`;13012);size 上限(`attachment_size_limit_configs` override + `defaultMaxSizeBytes`;13013);PII 检测(身份证号正则;13015);信息泄漏防御(读路径无权 → 13001;写路径无权 → 30100);accessUrl 占位恒返 null(沿 Q14);scope 自动判 `.self` / `.other`(certificate Service 层先查 `Certificate.memberId` 转 RBAC `member` resource);activity 粗粒度判权(无 self/other);DELETE 物理删(沿 Q11;不查跨表引用);新增 6 个 BizCode + 51 个 e2e 用例;PermissionsModule `exports: [RbacService]`(首次外露给业务模块);沿 D7 v1.0 §5 / §6 + 用户 PR #6b 14 项 Q 拍板
- `feat(permissions): seed attachment permissions and member role`(PR #75,squash commit `ff34616`):seed 20 条 `attachment.*` Permission(`attachment.<action>.<resourceType>[.<scope>]`;member×8 + certificate×8 + activity×4;沿 §6.1 Q11 锁定清单)+ `member` 内置 RbacRole placeholder + 9 条 RolePermission(8 `.self` + 1 `attachment.view.activity`);seed 幂等(全部 upsert);**不自动给任何 user 分配 `member` 角色**(Q2 沿用);**不创建 ADMIN 内置角色**(Q12 v1.0 沿用挂起);**不接入 dept-chief / dept-deputy 层级**(seed 真实名留 .env.seed.local);8 个 seed e2e 用例;沿 D7 v1.0 §6.1 / §10 + 用户 PR #6a Q1-Q5 拍板
- `feat(attachments): add attachment size limit config module`(PR #74,squash commit `81c9bff`):AttachmentSizeLimitConfig CRUD **5 个端点**(本表无 `status` 字段;Q1 v1.0);`typeConfigId` 1:1 UNIQUE(`typeConfigId` 单字段;每 type 至多一条 override);新增 BizCode 13026 / 13027 + 复用 13020(`typeConfigId` 不存在 → 13020);PATCH 仅 `maxSizeBytes` / `remark`(typeConfigId 不可改);Q5:`maxSizeBytes=null` Service 层提前拒(防 Prisma NOT NULL 撞 500);软删 deletedAt = now()(本表无 status 同步置)+ 复用既有 `(typeConfigId, deletedAt=null)` 隐含 unique;独立 `AttachmentSizeLimitConfigTypeConfigSummaryDto`(Q4:不复用 mime summary);28 个 e2e 用例;沿 D7 v1.0 §4.4 + 用户 PR #5 Q1-Q8 拍板
- `feat(attachments): add attachment mime config module`(PR #73,squash commit `579429b`):AttachmentMimeConfig CRUD **6 个端点**(含独立 PATCH `/:id/status`);(typeConfigId, mime) 复合 UNIQUE(含软删历史 Q8;沿 CLAUDE.md §10 软删 unique 铁律);新增 BizCode 13022 / 13024 / 13025 + 复用 13020;Service 层 MIME 格式 regex 校验(`/^[a-z][a-z0-9-]*\/(\*|[a-z0-9.+-]+)$/`;沿 Q1);PATCH 仅 `remark`(mime / typeConfigId 不可改;Q3 / Q4);出参嵌套 `typeConfig: { id, code, displayName }`(Q2);软删 deletedAt = now() + 同步置 `status=INACTIVE`;28 个 e2e 用例;沿 D7 v1.0 §4.3 + 用户 PR #4 Q1-Q8 拍板
- `feat(attachments): add attachment type config module`(PR #72,squash commit `663506d`):AttachmentTypeConfig CRUD **6 个端点**(含独立 PATCH `/:id/status`);`code` 全局 UNIQUE(含软删历史;沿 CLAUDE.md §10);新增 BizCode 13020 / 13021 / 13023(`code` 格式 / `code` 已存在 / 不存在 / 已软删);Service 层 `code` 格式 regex 校验(沿 RbacRole.code 范式 `/^[a-z][a-z0-9-]{2,32}$/`);PATCH 仅资料字段(code 不可改 / status 走独立端点;Q1 / Q5);软删 deletedAt = now() + 同步置 `status=INACTIVE`(沿 dictionaries 范式);29 个 e2e 用例;**6 端点不接 rbac.can()**(F4:配置三表是系统配置 / 运维能力,不为其单设 `rbac.config.*` 权限点;入口固定 `@Roles(SUPER_ADMIN, ADMIN)`);沿 D7 v1.0 §4.2 + 用户 PR #3 Q1-Q7 拍板
- `chore(prisma): add attachments schema and config tables`(PR #71,squash commit `ce37ffe`):Prisma schema **+4 model**(`Attachment` 13 业务字段 + 多态外键无 DB FK + 硬删除无 deletedAt / `AttachmentTypeConfig` + `AttachmentMimeConfig` + `AttachmentSizeLimitConfig` 各含 deletedAt 软删字段);**+1 migration**(`20260515_xxx_add_attachments`;同 migration 内 drop `Certificate.attachmentKey` 列 — 沿 D7 v1.0 §4.6 + 用户拍板提前清理);+`AttachmentAccessLevel` enum(PUBLIC / INTERNAL / SENSITIVE);+`AttachmentTypeConfigStatus` / `AttachmentMimeConfigStatus` enum(本批次无 size status enum);User 反向 relation `attachmentsUploaded`(`uploadedBy → User.id` Restrict);沿 D7 v1.0 §4 schema 描述 + 用户 PR #2 8 项 Q 拍板
- `feat(permissions): support 4-segment permission codes`(PR #70,squash commit `4d9332e`):Permission code 正则放宽到 **3-4 段**(`/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,3}$/`;沿 D7-RBAC v1.2 + D7-attachments F1);适配 `attachment.<action>.<resourceType>.<scope>` 4 段命名(scope ∈ {self, other};activity 仍 3 段);**zero 行为变更**(仅放宽接受范围;既有 3 段 code 完全兼容);若干 e2e 用例补 4 段 fixture;沿 D7-RBAC PR #66(文档修订)代码侧落地 + 用户拍板
- `docs(v2-design): start C-7 attachments V2.x implementation track`(PR #69,squash commit `e620a2c`):C-7 attachments V2.x 立项 PR;**D7 v1.0 已冻结(PR #68 `5da801f`)→ V2.x implementation track 启动**;本 PR 同时修订 4 处文档(新增 [`docs/批次7_attachments_V2x立项记录.md`](docs/批次7_attachments_V2x立项记录.md) + 更新 [`TASKS.md §8`](TASKS.md) + 更新 [`docs/V2红线与复活路径.md`](docs/V2红线与复活路径.md) C-7 行 + 本 CHANGELOG);立项 PR 合并即**解除 C-7 attachments 的 V2 §18 调研期硬禁止**;**实施 PR #1 仍需单独启动 + 用户授权 + schema diff/migration SQL 双确认**(沿 CLAUDE.md §0 铁律);**并行可启动**:Provider 选型独立评审稿(决议 Q14/Q15) + "RBAC 内置角色 / ADMIN 默认附件权限"专项评审 PR(决议 Q12),均需用户明确授权;本 PR 仅文档修订,不动代码 / schema / migration / 测试 / package.json / pnpm-lock.yaml / D7-RBAC / D7-attachments 已冻结文档 / 历史 handoff;沿 D7-RBAC V2.x 立项 PR #52 风格
- `docs(v2-design): freeze attachments API review v1.0`(PR #68,squash commit `5da801f`):D7-attachments 评审稿 v0.2 → **v1.0 冻结稿**;基于用户拍板冻结剩余决议;**27 项决议锁定**(F 5 + B 9 + Q 13;沿 v0.2 锁定项 + 沿用)+ **Q12 ADMIN 内置角色沿用挂起**(留独立"RBAC 内置角色 / ADMIN 默认附件权限"专项评审 PR;**不阻塞 attachments 主体冻结**;实施期默认按方案 B 沿 v0.9.0 §5 现状)+ **Q14 / Q15 沿用挂起待 Provider 选型评审**(签名 URL / STS / 中转代理 / 删除失败处理 / 生命周期策略由 Provider 选型决定,提前锁定易返工)+ **Q16 沿用建议不冻结**(沿 §13 9-11 PR 建议,实施期允许按风险拆分或合并)+ **入队同意书锁最低原则四锚点**(上传授权 / 用途 / 保存 / 访问;**正式条款文本 v1.1 由业务方提供,不写入本系统仓库**)+ **退队清理 N 锁配置项语义**(`disabled` 后 N 天后台提示 + 系统不自动删除 + N 不在 schema 硬编码;**具体 N 值 v1.1 由队里管理层 / 合规口径确认**);**v1.0 冻结完成,可进入 C-7 attachments V2.x 立项 PR**(由维护者授权);PR #68 仅文档修订,不动代码 / schema / migration / 测试 / package.json / pnpm-lock.yaml
- `docs(v2-design): refine attachments API review decisions v0.2`(PR #67,squash commit `e4ff48f`):D7-attachments 评审稿 v0.1 → **v0.2 局部收口稿**;基于用户一次性批量拍板 Q1-Q16;**锁定 13 项 Q**(Q1 复用 attachments + ownerType=activity + subType=cover / Q2 accessLevel = hint+索引(RBAC 单一权威)/ Q3 tags = `String[]`(不建关联表)/ Q4 uploadedBy = User.id / Q5 ownerType 双层校验(业务层 enum 硬编码 + 配置表运行时白名单)/ Q6 checksum/etag 不进普通出参 / Q7 PATCH metadata 不审计 / Q8 退队 `status=DISABLED ≥ N + 后台提示`(N 待业务确认)/ Q9 预留 `ATTACHMENT_PII_DETECTED=13015` / Q10 activity 不分 self/other / Q11 锁定 20 条 `attachment.*` 权限点清单(seed 留实施 PR)/ Q13 系统级 MIME 黑名单(D7 设计清单)) + **挂起 1 项**(Q12 ADMIN 内置角色,影响 RBAC seed/bootstrap + 业务管理员默认能力) + **挂起 2 项待 Provider 选型**(Q14 上传策略 / Q15 删除策略) + **不冻结 1 项**(Q16 PR 拆分,沿 §13 9-11 PR 建议);**v1.0 暂不冻结**(留入队同意书条款 + N 时长 + Q12 等业务方进一步澄清);沿 D7-RBAC v0.2 / v1.0 / v1.1 收口类 PR 范式在 Unreleased 登记;PR #67 仅文档修订,不动代码 / schema / migration / 测试 / package.json / pnpm-lock.yaml

## v0.9.0 - 2026-05-14

V2 第一阶段在 v0.8.0(批次 6 `audit_logs` 第二波写操作迁移收官)基础之上,完成 **V2.x
C-6 RBAC 全模块实施**(批次 8;沿 D7 v1.1 25 项决议;**11 PR 累计**:#52 立项 + #53
v1.1 命名修订 + #54 schema/migration + #55-#61 7 个 feat PR + #62 docs 收口 + 本 PR
bump version);**新增 16 个 RBAC 端点 + 4 张 RBAC 表 + 14 条 BizCode + `RbacService`
判权核心 + `RbacCacheService` 进程内 TTL 缓存 + seed/bootstrap**;**v1 14 + V2 79 既有
接口 schema + paths 严格 zero drift**(contract snapshot CI 守护);**累计 95 接口**
(原 79 + 16 RBAC);累计 contract snapshot **200 个用例**(原 184 + 16 路由 + 22 DTO 增量)。

**SemVer 拍板**:0.8.0 → 0.9.0 **minor**(向后兼容的能力扩展:新增 16 个 V2 接口 +
4 张表 + 1 个 migration + `CurrentUserPayload.memberId` 服务端扩展;v1 14 + V2 79 既有
接口零字段 / 路径 / 错误码改动;无 breaking change;沿 v0.7.0 → v0.8.0 minor 风格)。

**重要业务能力**(前端 / 运营 / 接入方必读):

- **RBAC 4 表模型全部就位**(沿 D7 v1.1 §4):`RbacRole`(`@@map("roles")`,软删)/
  `Permission`(`@@map("permissions")`,物理删)/ `RolePermission`(`@@map("role_permissions")`,
  物理删,`@@unique([roleId, permissionId])`)/ `UserRole`(`@@map("user_roles")`,物理删,
  `@@unique([userId, roleId])`)。**v1 enum Role 保持不动**(沿 D7 v1.1 命名修订 B1 +
  A-4 红线);RBAC 4 表作为业务级权限点,与三层 Role 并存(沿 D12 永不切换)。
- **16 个 RBAC 端点全部就位**(沿 D7 v1.1 §5.1 F2):
  - `/api/v2/permissions` × 4(GET 列表 / POST 创建 / PATCH 更新 / DELETE 删除)
  - `/api/v2/roles` × 5(GET 列表 / GET 详情含 permissions / POST / PATCH / DELETE 软删)
  - `/api/v2/roles/:id/permissions[/:permissionId]` × 2(POST 批量授权 / DELETE 撤权)
  - `/api/v2/users/:userId/roles[/:roleId]` × 3(GET 查 / POST 分配 / DELETE 撤销)
  - `/api/v2/rbac/me/permissions` × 1(任何登录用户;SUPER_ADMIN 返 Permission.code 全集)
  - `/api/v2/rbac/reload` × 1(3 档 scope:all / user(+userId) / role(+roleId))
- **入口权限标注**:全部 16 端点入口仍 `@Roles(Role.SUPER_ADMIN, Role.ADMIN)`(me/permissions
  额外加 USER);**Service 层显式 `rbac.can()` 在业务模块的实际接入留后续 PR**(沿 F5 + F9 +
  用户拍板;本批次 0 处业务调用 `rbac.can()`;`RBAC_FORBIDDEN=30100` 段位预留)。
- **`RbacService` 判权核心**:`getUserPermissionCodes` / `can` / `judge` / `checkOwnership` /
  `getMyPermissions` / `reload`;判权优先级 SUPER_ADMIN 短路 → user_roles → role_permissions →
  permissions 聚合 → 精确匹配 → `.self` ownership(沿 D7 §7.1 / §8.2;`user.id` / `user.memberId`
  混合 owner)。
- **`RbacCacheService` 进程内 TTL 缓存**:Map + setTimeout 等价进程内 TTL;3 个 invalidate 入口
  (单 user / 持某 role 所有 user 批量 / 全量);`RBAC_CACHE_TTL_SECONDS` env 可调(默认 1800 秒,
  推荐区间 [60, 86400])。**不引入 Redis / node-cache / lru-cache**(沿 V1.1 §17.3 + D5 v1.0 锁)。
- **`CurrentUserPayload` 扩展**:`+memberId: string | null`(沿 D7 §8.3 owner 判定);
  `JwtStrategy.validate()` select 同步追加;**v1 14 接口 response 契约 zero drift**
  (memberId **不**进 `UserResponseDto` / `userSafeSelect`,仅服务端内部使用)。
- **14 条 BizCode 段位 `300xx + 301xx` 实装**(沿 D7 §12 + F1):
  - `300xx` 通用:`PERMISSION_NOT_FOUND` / `PERMISSION_CODE_ALREADY_EXISTS` /
    `INVALID_PERMISSION_CODE_FORMAT` / `ROLE_NOT_FOUND` / `ROLE_CODE_ALREADY_EXISTS` /
    `ROLE_DELETED` / `INVALID_ROLE_CODE_FORMAT` / `ROLE_PERMISSION_NOT_FOUND` /
    `USER_ROLE_ALREADY_EXISTS` / `USER_ROLE_NOT_FOUND`(10 项)
  - `301xx` 权限 / 边界:`RBAC_FORBIDDEN`(段位预留)/ `LAST_OPS_ADMIN_PROTECTED` /
    `CANNOT_ASSIGN_HIGHER_ROLE`(3 项)
  - 沿 baseline §1.1 段位锁定(避开 `140xx + 141xx` audit_logs;中间留 `240xx-290xx`)
- **Q7 角色分级 C2 中庸方案**(沿 D7 v1.1 §6.2 + 用户拍板;UserRolesService 内 inline
  `canAssignRole` 私有 helper):SUPER_ADMIN 通过任何 / 持 ops-admin 可分配非 ops-admin /
  其他(包括 ADMIN 单独)抛 `CANNOT_ASSIGN_HIGHER_ROLE`(30102);**dept-chief / dept-deputy
  实际层级未实装**(留业务模块 RBAC 接入 PR)。
- **最后一个 ops-admin 保护**(沿 D7 §6.3 + v1 §13 最后一个 SUPER_ADMIN 保护范式):
  撤 ops-admin 角色时事务内 count 剩余活跃持有者 ≥ 1,否则抛 `LAST_OPS_ADMIN_PROTECTED`(30101)。
- **seed/bootstrap**(沿 D7 v1.1 §10):`prisma/seed.ts` 追加 `seedRbac()`,upsert 14 条
  `rbac.*` Permission 全集 + `ops-admin` RbacRole + 14 条 RolePermission 映射;
  bootstrap 走 `RBAC_INITIAL_OPS_ADMIN_USER_ID` env 优先 → SUPER_ADMIN fallback;
  强校验"至少 1 个活跃 user_role 持有 ops-admin",否则 throw;**全部幂等**(重复跑零增量)。
- **测试覆盖**:7 e2e suites(`permissions` / `rbac-roles` / `role-permissions` / `user-roles` /
  `rbac-me-permissions` / `rbac-reload` / `seed-rbac`)+ 1 unit spec(`rbac.service.spec.ts`);
  contract snapshot 200 个用例(增量 16 路由 + 22 DTO;v1 14 + V2 79 既有接口 zero drift)。

**仍未做项**(沿 D7 决议 + 用户拍板任务边界):

- ❌ **未接入任何业务模块判权**(0 处 `rbac.can()` 业务调用;`RBAC_FORBIDDEN=30100`
  仅段位预留)
- ❌ **未把 14 个 RBAC CRUD 端点接 `rbac.can()`**(入口仍 `@Roles(SUPER_ADMIN, ADMIN)`;
  留 C-7 attachments 启动时或专项 PR 接入)
- ❌ **未 seed 4 条 `attachment.*` 权限点**(D7 §10.2 锁定 4 段 code 与 PR #2 实装
  Permission code 3 段正则 `/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2}$/` 冲突;
  留 C-7 attachments 启动时另议正则放宽或 code 命名)
- ❌ **未 seed `role-a..role-f` placeholder 业务角色**(不写真实部门名 / 职务名 /
  队内角色名;由后续运营通过 API 创建,或 `.env.seed.local` 私有 seed 处理)
- ❌ **未实装 dept-chief / dept-deputy 层级**(D7 §6.2 层级表锁定但本批次 seed 不实装)
- ❌ **未创建 "ADMIN 内置角色"**(ADMIN 自动继承 USER 权限 D7 §7.1 / §8.2 描述
  通过 seed 实现,留真实业务权限点落地后再处理;14 条 rbac.* 均为管理类权限)
- ❌ **未启动 C-7 attachments D7 评审稿**(沿 PR #45 决议 1:必须等 C-6 完整收口 +
  v0.9.0 release 后才启动)

**实施 PR 时间线**(沿 D7 §16 / TASKS.md §7):

| PR | 实际 # | 类型 | squash | 主题 |
|---|---|---|---|---|
| 立项 | #52 | docs(v2-design) | `172b684` | start C-6 RBAC V2.x implementation track |
| v1.1 命名修订 | #53 | docs(v2-design) | `569771b` | revise RBAC role model naming(`Role` → `RbacRole`) |
| **1** | #54 | chore(prisma) | `88cb4d1` | add RBAC schema and migration |
| 2 | #55 | feat(permissions) | `6ff55b6` | add Permission CRUD module |
| 3 | #56 | feat(permissions) | `edcb91e` | add RbacRole CRUD module |
| 4 | #57 | feat(permissions) | `0d50c99` | add RolePermission assignment module and cache skeleton |
| 5 | #58 | feat(permissions) | `affc1e8` | add UserRole CRUD module |
| 6 | #59 | feat(permissions) | `46664c7` | add RbacService and me permissions endpoint |
| 7 | #60 | feat(permissions) | `6de6f64` | add RBAC reload endpoint |
| 8 | #61 | feat(permissions) | `43db185` | add RBAC seed/bootstrap |
| 9 | #62 | docs(v2) | `7e97dac` | record C-6 RBAC implementation landing |
| **10 (本 PR)** | — | chore | — | bump version to 0.9.0 |
| 11 | 待启动 | docs(v2) | — | v0.9.0 handoff |

### Added

- **V2.x C-6 RBAC 实施 PR #1-#8 全部合入 main**(沿 [`docs/批次8_RBAC_API前评审.md`](docs/批次8_RBAC_API前评审.md) D7 v1.1 + [`docs/批次8_RBAC_V2x立项记录.md`](docs/批次8_RBAC_V2x立项记录.md));包括:
  - **schema**(PR #54 `chore(prisma)`):4 张 RBAC 表 `RbacRole` / `Permission` / `RolePermission` / `UserRole`(DB 表名 `@@map("roles")` / `permissions` / `role_permissions` / `user_roles`);沿 D7 v1.1 B1 命名修订(避 v1 enum Role 冲突)+ D4 软删策略(RbacRole 软删,其余 3 表物理删)
  - **16 个端点全部就位**(`/api/v2/permissions/*` × 4 + `/api/v2/roles/*` × 5 + `/api/v2/roles/:id/permissions[/:permissionId]` × 2 + `/api/v2/users/:userId/roles[/:roleId]` × 3 + `/api/v2/rbac/me/permissions` × 1 + `/api/v2/rbac/reload` × 1):
    - PR #55 `feat(permissions): add Permission CRUD module`(端点 1-4;BizCode 30001 / 30002 / 30008)
    - PR #56 `feat(permissions): add RbacRole CRUD module`(端点 5-9;BizCode 30003 / 30004 / 30005 / 30009)
    - PR #57 `feat(permissions): add RolePermission assignment module and cache skeleton`(端点 10-11;BizCode 30011 + `RbacCacheService` Map+TTL 骨架)
    - PR #58 `feat(permissions): add UserRole CRUD module`(端点 12-14;BizCode 30006 / 30007 / 30101 / 30102 + Q7 C2 中庸角色分级 + 最后一个 ops-admin 保护)
    - PR #59 `feat(permissions): add RbacService and me permissions endpoint`(端点 15;`RbacService.{getUserPermissionCodes, can, judge, checkOwnership, getMyPermissions}` + `CurrentUserPayload.memberId` 扩展 + `RBAC_CACHE_TTL_SECONDS` env + BizCode 30100 段位预留)
    - PR #60 `feat(permissions): add RBAC reload endpoint`(端点 16;3 档 scope `all` / `user` / `role`)
  - **seed/bootstrap**(PR #61 `feat(permissions): add RBAC seed/bootstrap`):`prisma/seed.ts` 追加 `seedRbac()` — 14 条 `rbac.*` Permission upsert + `ops-admin` RbacRole upsert + 14 条 RolePermission 映射 + `RBAC_INITIAL_OPS_ADMIN_USER_ID` env 优先 / SUPER_ADMIN fallback bootstrap + 强校验至少 1 个活跃 ops-admin 持有者;全部幂等
  - **`CurrentUserPayload` 扩展**:`+memberId: string | null`(沿 D7 §8.3 owner 判定);JwtStrategy select 同步追加;**v1 14 接口 response 契约 zero drift**(memberId 不进 UserResponseDto / userSafeSelect)
  - **BizCode 段位 `300xx + 301xx` 实装**:14 个错误码全部落地(`PERMISSION_NOT_FOUND` / `PERMISSION_CODE_ALREADY_EXISTS` / `INVALID_PERMISSION_CODE_FORMAT` / `ROLE_NOT_FOUND` / `ROLE_CODE_ALREADY_EXISTS` / `ROLE_DELETED` / `INVALID_ROLE_CODE_FORMAT` / `ROLE_PERMISSION_NOT_FOUND` / `USER_ROLE_ALREADY_EXISTS` / `USER_ROLE_NOT_FOUND` / `RBAC_FORBIDDEN`(段位预留)/ `LAST_OPS_ADMIN_PROTECTED` / `CANNOT_ASSIGN_HIGHER_ROLE`)
  - **测试覆盖**:7 suites unit + 40 suites e2e + contract snapshot 16 路由 + 22 DTO(沿 PR #55-#61 累计);v1 14 + V2 79 既有接口 schema / paths **zero drift**
  - **明确未做项**(沿用户拍板任务边界 / D7 决议 + PR #1-#8 累计):
    - ❌ **未接入任何业务模块判权**(0 处 `rbac.can()` 业务调用;`RBAC_FORBIDDEN=30100` 仅段位预留,等真实业务模块接入时再使用)
    - ❌ **未把 14 个 RBAC CRUD 端点接 `rbac.can()`**(沿 F9 + 用户拍板;留 PR #8 seed 后另起 PR 或 C-7 attachments 启动时一并接入)
    - ❌ **未 seed 4 条 `attachment.*`**(D7 §10.2 锁定 4 段 code 与 PR #2 实装 Permission code 3 段正则冲突;留 C-7 attachments 启动时另议)
    - ❌ **未 seed `role-a..role-f` placeholder 业务角色**(不写真实部门名 / 职务名 / 队内角色名;由后续运营通过 API 创建或 `.env.seed.local` 私有 seed 处理)
    - ❌ **未实装 dept-chief / dept-deputy 层级**(seed 真实名留 PR #8 已收口;实际业务层级判定留业务模块 RBAC 接入 PR)
    - ❌ **未创建"ADMIN 内置角色"**(ADMIN 自动继承 USER 权限留真实业务权限点落地后再处理;14 条 rbac.* 均为管理类权限)
    - ❌ **未 bump version / 未 tag / 未 release**(version 仍 `0.8.0`;bump 留 PR #10 + release 留 PR #11 v0.9.0 handoff)
- 沿 baseline §13.3:**纯 docs 收口 PR 不动 schema / migration / 代码 / 测试 / version / tag / release**(本 changelog 段位身为收口 PR 自身,不动以上路径)。

### Docs

- 新增 [`docs/handoff/v0.8.0.md`](docs/handoff/v0.8.0.md):v0.8.0 阶段交接说明
  (批次 6 `audit_logs` 第二波写操作迁移收官 + 当前 pino-only 调用点精确口径
  + 下一会话启动提示词)。接续 `docs/handoff/v0.5.0.md`;v0.6.0 / v0.7.0 未单独
  建 handoff,本文件直接补 v0.8.0 后归档。
- 修正 [`docs/V2红线与复活路径.md`](docs/V2红线与复活路径.md) `audit_logs` 剩余
  pino-only 调用点口径表述:统一为"**9 个 pino-only 调用点**(grep 实际数);
  按业务类别口径 = **8 类 read / 查看边界 + 1 个 exportCsv 借用
  `registration.review` 字符串**"。涉及 §3.1c-F2 / §3.1c-F3 /
  §3.1c PR #5 范围本身 / §3.1d-F2 / §3.1d-F3 / §3.1d 收官里程碑 / §4 C-1
  共 7 处累计视角段位 + 附录 A v0.6 修订记录。
  §3.1-F3 / §3.1b-F3 PR #3 / PR #4 时段历史快照视角保留"8 处"不动
  (那时段尚无 exportCsv 残留,8 处为正确历史快照)。
- **不动 Q1=A 决议**,**不暗示马上迁移 read 类**,**不把当前阶段不做写成永久不做**。
- **CHANGELOG v0.8.0 已发布段保持不变**(纯文档表述修正,不回改已发布历史段;
  新口径仅在 V2 红线 + 本 handoff 体现)。
- 纯文档变更,沿 baseline §13.3:**不改 schema / migration / 代码 / 测试 /
  version / tag / release**。
- 新增 [`docs/批次7_attachments_业务访谈提纲.md`](docs/批次7_attachments_业务访谈提纲.md):
  C-7 attachments 业务访谈**前置提纲** v0.1(11 个待业务方确认的问题 + 硬边界
  + 不覆盖范围 + 引用)。**非业务确认稿**;答案收齐后才升级为 D6 业务确认稿,
  再进 D7 评审稿。**不写 Provider 选型 / schema / API / RBAC 方案 / 字典 seed
  真实值**(沿 V2 §18.2 / §18.3 / handoff §5.3 Slow-2 硬前置)。**批次号 7 暂定**,
  正式编号以 D7 评审通过 + V2.x 立项 commit 为准。共用上一条"纯文档变更"边界声明。
- 新增 [`docs/handoff/v0.8.1.md`](docs/handoff/v0.8.1.md):v0.8.0 后 V2 设计文档
  阶段交接说明(13 章节;含 C-7 attachments 2 件 + C-6 RBAC 3 件文档归档 + D7 v0.1
  草稿待评审 / 微调 / 冻结 + 下一会话启动提示词 + worktree 工作流速查)。接续
  `docs/handoff/v0.8.0.md`;**v0.8.0 → 现在零代码 / 零 schema 改动**;package version /
  Swagger setVersion 仍 0.8.0;v0.8.0 tag / release 仍 Latest。**v0.8.1 是阶段标识,
  不是 SemVer**。详见 [`v0.8.1.md §3 全景表`](docs/handoff/v0.8.1.md)(PR #43-#48
  6 个 docs PR 累计变更)。本 PR 沿 PR #43 v0.8.0 handoff 风格(handoff + CHANGELOG
  同时改);PR #45-#48(D6 业务确认稿 + D7 评审稿)**不补登 changelog**
  (沿"D6 / D7 中间产物不进 changelog"风格;本 handoff §3 链式总结即可)。
  共用上方"纯文档变更"边界声明。
- 修订 [`docs/批次8_RBAC_API前评审.md`](docs/批次8_RBAC_API前评审.md) v0.1 草稿
  → **v0.2 局部收口稿**(沿 v0.8.1 handoff §10 启动后 Fast-1 任务);**局部锁定
  5 项**:(1) D12 过渡终止条件 = (c) 永不切换,`users.policy.ts` 永久共存 + RBAC
  业务级补充;(2) F5 判权调用方式 = Service 层显式 `rbac.can()`,**不**做
  `RbacGuard` 装饰器;(3) F1 BizCode 段位 = `300xx` 通用 / `301xx` 权限边界
  (避开 `140xx + 141xx`,该段已被 audit_logs 批次 6 v0.7.0 占用;中间留
  `240xx-290xx` 给未来未规划业务模块);(4) [`docs/srvf-foundation-baseline.md`](docs/srvf-foundation-baseline.md)
  §1.1 同步追加 `300xx + 301xx` `permissions`(C-6 RBAC)模块段位预留 + 附录 A
  v0.6;(5) [`ARCHITECTURE.md`](ARCHITECTURE.md) §9 升级路径修订:原"权限点到
  按钮级"条目去 `casl` 库 + 改触发条件描述为"按钮级 / resource type 级 RBAC
  (C-6 D7 v0.2 局部收口)" + 加 4 表 + 自实现 `RbacService` + Service 层显式
  `rbac.can()` + BizCode 段位 `300xx + 301xx` 链路。**其他 20 项决议保持 v0.1
  待评审状态**(D2 / D3 / D4 / D5 / D6 / D7 / D8 / D9 / D10 / D11 / B1-B3 /
  D1 / F2-F4 / F6-F10),v1.0 冻结另起 PR + 用户拍板。**段位预留 ≠ 段位实装**,
  RBAC 4 model + ~14 个 BizCode 实装由 C-6 RBAC V2.x 立项后实施 PR 完成。
  **不**修订 `docs/handoff/v0.8.1.md`(沿 V2 红线 §5.1 历史 handoff 不回改;
  过期段位号表述以本评审稿 + baseline + 本 CHANGELOG 段为准)。共用上方"纯文档
  变更"边界声明:**不改 schema / migration / 代码 / 测试 / version / tag / release**。
- 修订 [`docs/批次8_RBAC_API前评审.md`](docs/批次8_RBAC_API前评审.md) v0.2 局部收口稿
  → **v1.0 冻结稿**(本 PR;沿用户冻结指令一次性锁定剩余 20 项决议)。**25 项决议
  全部 🔒 v1.0 冻结**:**B1-B3 / D1-D11 / D12(沿 v0.2)/ F1(沿 v0.2)/ F2-F4 /
  F5(沿 v0.2)/ F6-F10**。冻结要点:(D2)权限点 code 命名 `<module>.<action>.<resource_type>`
  kebab-case;(D3)资源所有权 user.id + Member.id 混合,Service 层显式构造
  `RbacResource`;(D4)RBAC 4 model 软删策略 = Role 软删 / Permission/RolePermission/UserRole
  物理删;(D5/D6/F8)进程内 short TTL + 显式 reload + 默认 30 分钟(`RBAC_CACHE_TTL_SECONDS`
  env 可调);(D7)角色层级三级 SUPER_ADMIN > ops-admin > 业务部门角色;(D8)角色
  可分配性代码硬编码,**不**引入 `role_assignable_targets` 配置表;(D9)bootstrap =
  `RBAC_INITIAL_OPS_ADMIN_USER_ID` 优先 + SUPER_ADMIN fallback;(D10)"最后一个
  ops-admin 保护"4 个触发场景;(D11)`AuditLogEvent` 新增 9 项 union(路线 A 多
  operation 共用单一事件名 + `extra.operation` 区分;沿 audit_logs v0.8.0 收官范式
  + A-17 同事务 fail-fast);(F2-F4)16 端点路径 + me/permissions / reload 字段 +
  reload scope 三种;(F6/F7)seed 真实角色名走 `.env.seed.local`(R13) + `Role.code`
  3-32 字符;(F9)`rbac.can()` 仅在新增 V2 接口启用,沿 A-2 红线;(F10)9 个 feat PR
  + 1 bump + 1 docs 收口。**v1.0 冻结结论**:C-6 RBAC 可进入 V2.x 立项准备,**但
  仍不得直接实施**;下一步必须是 **C-6 V2.x 立项 commit / docs PR**,实施 PR 仍需
  单独启动;段位预留 ≠ 段位实装;`300xx + 301xx` 仅在 baseline §1.1 段位预留,14 个
  BizCode 实装由 C-6 V2.x 立项后实施 PR 完成。本 PR 仅修订 `docs/批次8_RBAC_API前评审.md`
  + `CHANGELOG.md`;**不**修订 baseline / ARCHITECTURE.md(段位 + §9 v0.2 已锁,
  v1.0 沿用)/ V2红线 / handoff / TASKS.md。共用上方"纯文档变更"边界声明。
- 新增 [`docs/批次8_RBAC_V2x立项记录.md`](docs/批次8_RBAC_V2x立项记录.md)
  + `TASKS.md` 追加 §7 V2.x C-6 RBAC 立项准备:**C-6 RBAC 已从 D7 v1.0 冻结
  (PR #51 / `b301da8`)进入 V2.x 立项准备**;25 项决议全部锁定;RBAC 4 表模型
  (`Role` / `Permission` / `RolePermission` / `UserRole`)+ BizCode 段位
  `300xx + 301xx`(baseline §1.1 已预留)+ `users.policy.ts` 永久共存(D12 永不
  切换;不迁出 v1 14 + 既有 V2 79 接口)+ Service 层显式 `rbac.can()`(F5;**不**做
  Guard 装饰器);**不引入 casl / Redis / 队列 / 定时任务**;**不扩 Role enum**
  (沿 A-4);**不改 v1 14 接口**(沿 A-2 zero drift);**C-7 attachments 必须等
  C-6 上线后再进入 D7-attachments 评审**(沿 PR #45 决议 1)。**本 PR 仅立项,
  不实施**:不动 `src/**` / `prisma/**` / `test/**` / `package.json` /
  `pnpm-lock.yaml`;不新增 migration / 不改 seed;不 bump version / 不 tag /
  不 release;**不启动 RBAC 实施**。合并后下一步必须是实施 PR #1
  (`chore(prisma): add RBAC schema and migration`),实施 PR 仍需单独启动 +
  用户授权;实施 PR 拆分见立项记录 §四(11 PR:9 feat + 1 bump + 1 v0.9.0
  handoff;实施周期 2-3 周参考 batch6)。**不**修订 baseline / ARCHITECTURE.md /
  V2 红线 / handoff(均已在 v0.2 / v1.0 阶段就位,v2.x 立项沿用);共用上方
  "纯文档变更"边界声明。
- 修订 [`docs/批次8_RBAC_API前评审.md`](docs/批次8_RBAC_API前评审.md) v1.0 冻结稿
  → **v1.1 修订稿**(纯命名修订)。**触发**:实施 PR #1 启动时跑
  `pnpm prisma generate` 发现 `model Role` 与 v1 已有 `enum Role { SUPER_ADMIN,
  ADMIN, USER }` 名称冲突(Prisma 不允许 model 与 enum 同名);v1.0 评审过程
  未捕获此纸面 vs 实际差异(D7 v0.1 / v0.2 / v1.0 三段 Prisma DSL 仅作设计草案
  展示,未真正跑过 `prisma generate` 验证)。**用户拍板方案 A**:RBAC 模型 Prisma
  model `Role` → **`RbacRole`**;DB 表名仍 **`@@map("roles")`** ;API 路径仍
  **`/api/v2/roles`**;业务概念仍叫"角色";Prisma client 用法 `prisma.role.xxx` →
  **`prisma.rbacRole.xxx`**;User 反向 relation `userRoles` 加
  **`@relation("UserRoleHolder")`** 消歧(因 User 上对 UserRole 有 2 个反向);
  **v1 enum Role 保持不动**(`SUPER_ADMIN / ADMIN / USER` 三层永远不变;沿 A-2 +
  A-4 红线)。**修订范围**:25 项决议除 B1 / D4 / D11 / F7 命名同步外,其余 21 项
  全部沿 v1.0 不变;其余 3 model(`Permission` / `RolePermission` / `UserRole`)
  顺手追加 `@@map("permissions")` / `@@map("role_permissions")` / `@@map("user_roles")`
  保持 DB 表名 snake_case 复数风格(沿 audit_logs / API 路径风格)。**本 PR 仅
  文档修订**:不动 `src/**` / `prisma/**` / `test/**` / `package.json` /
  `pnpm-lock.yaml`;不新增 migration / 不改 seed;不 bump version / 不 tag /
  不 release;**不启动 RBAC 实施**(本 PR 合并后,实施 PR #1 才允许重新启动)。
  **不**修订 baseline / ARCHITECTURE.md / V2 红线 / handoff / 立项记录 / TASKS.md
  §7(均已锁,实施 PR #1 落地时按 v1.1 命名同步)。共用上方"纯文档变更"边界声明。

## v0.8.0 - 2026-05-13

V2 第一阶段在 v0.7.0(批次 6 PR #1 + PR #2 落地,`audit_logs` 基础设施 + 第一批 8 处
写操作迁移)基础之上,完成 SRVF 业务 **批次 6 PR #3 / #4 / #5 / #6**(`audit_logs` 第二波
写操作渐进迁移),覆盖 **4 个 v2 业务模块 / 22 处写 hook**;**累计 V2 79 接口**(与
v0.7.0 一致,本版本不新增接口);**累计 93 接口** contract snapshot 保护;v1 14 + V2
既有 79 接口 schema + paths 严格 **zero drift**。

**SemVer 拍板**:0.7.0 → 0.8.0 **minor**(向后兼容的内部能力增强:22 处业务写操作
audit 落库;无新增接口 / 字段 / 状态机变化 / schema 改动;沿 v0.6.0 → v0.7.0 风格)。

**重要业务能力**(前端 / 运营 / 接入方必读):

- **`audit_logs` 第二波写操作迁移全部完成**(沿 D-A 修订渐进迁出策略):
  - **contribution-rules**(3 处:`create` / `update` / `softDelete`)
  - **activities**(5 处:`create` / `update` / `softDelete` / `publish` / `cancel`)
  - **activity-registrations**(6 处:`create` / `createMy` / `approve` / `reject` /
    `cancelAdmin` / `cancelMy`)
  - **attendances**(8 处:`submit` / `edit` × 2 / `softDelete` / `approve` / `reject` /
    `finalApprove` / `finalReject`)
- **累计 22 处写 hook 全部接入 `AuditLogsService.log()` 同事务落库**;`AuditLogEvent`
  union **从 6 项扩展到 17 项**(+11 项:`contribution-rule.{create, update, delete}` × 3 +
  `activity.publish` × 1 + `registration.{create, review}` × 2 +
  `attendance-sheet.{submit, edit, delete, review, final-review}` × 5)
- **路线 A 事件命名策略**:多个相关 operation 共用单一事件名,通过 `context.extra`
  字段细分语义(沿 batch3 草案 §20.2 有意设计;D2 same-value 同值挪字符串):
  - `activity.publish` 承载 5 个 operation(create / update / softDelete / publish / cancel,
    `extra.operation` 区分)
  - `registration.create` 承载 2 个 viaPath(admin / self,`extra.viaPath` 区分)
  - `registration.review` 承载 4 个 action(approve / reject / cancelAdmin / cancelMy,
    `extra.action` 区分;cancel 再用 `extra.cancelledByPath` 细分)
  - `attendance-sheet.edit` 承载 2 个 operation(edit / edit-no-records,`extra.operation` 区分)
  - `attendance-sheet.review` 承载 2 个 action(approve / reject,`extra.action` 区分)
  - `attendance-sheet.final-review` 承载 2 个 action(final-approve / final-reject,
    `extra.action` 区分)
- 写操作返回结构、HTTP status、路径**完全不变**,前端无需调整;controller 仅新增
  `@Req()` 参数构造 `AuditMeta`(不进 OpenAPI;contract snapshot zero drift)
- **read 类查看行为仍按 Q1=A 决议不迁移**:`auditPlaceholder` 28 项 union 中
  剩余 **8 处 read 类调用**继续 pino-only(`member-profiles` 1 / `emergency-contacts` read 1 /
  `certificates` read 3 / `attendances` read 3 / `activity-registrations` exportCsv 1);
  当前阶段不写入 `audit_logs` 表,仅 pino 结构化日志保留
- **同事务 fail-fast 不可降级**(沿 D-B 红线):业务 `BizException` 回滚整个
  `prisma.$transaction`,`audit_logs` 与业务表同时入 / 同时不入;e2e 显式覆盖
  字典 invalid / R31 失败 / 重复报名等回滚路径,确保审计与业务原子绑定
- **`eventPlaceholder('attendance.recorded')` 业务事件机制独立**(沿 D-S7):
  `finalApprove` 同事务触发业务事件,与 audit 是两套机制并存;DB 事务原子性保证
  audit 失败 → 事务回滚 → 业务事件随之回滚

**实施铁律 / 范式锁定**:

- **A-16 红线刷新**:`AuditEvent`(`auditPlaceholder` 28 项)与 `AuditLogEvent`
  (`AuditLogsService` 17 项)**物理隔离**;事件名同值;新增审计事件须先经评审稿决议;
  本版本严格遵守"D2 same-value 同值挪字符串"路径
- **resourceType 命名规约**:snake_case 单数(`contribution_rule` / `activity` /
  `activity_registration` / `attendance_sheet`),沿 v0.7.0 第一波 `emergency_contact` /
  `certificate` 风格
- **`toAuditSnapshot` helper 范式**:每个迁移模块新增 `toAuditSnapshot` /
  `toSheetAuditSnapshot` 私有方法,从 service safe row 输出 JSON-safe 快照
  (Date → ISO string / Decimal → string / Json 经类型守卫);字段全部非敏感
  (打码矩阵 §4.3 未命中),沿 v0.7.0 不打码范式
- **controller `buildAuditMeta` 范式**:单 controller 模块沿用 controller 类内
  私有方法(contribution-rules / activities);**多 controller 模块**(activity-registrations
  双 controller / attendances 三 controller)提升到模块级函数,避免重复定义
- **不补 `changedFields`**:状态机流转模块(activity-registrations approve/reject/cancel /
  attendances approve/reject/final-*)与 records 全量替换模块(attendances edit)统一
  不引入 `Object.keys(dto)` 的 changedFields;仅 contribution-rules / activities `update`
  作为通用 update 接口提供 changedFields
- **records 快照策略**(attendances 模块):
  - 涉及 records 集合变更的操作(`submit` / `edit` × 2 / `softDelete` / `finalReject`)
    必含 records 完整快照
  - 仅改 sheet 字段的操作(`approve` / `reject` / `finalApprove`)只放 sheet 快照 +
    `extra.recordsCount` 元数据

**OpenAPI contract snapshot**:本版本不改 controller 响应 / Swagger 结构 / paths;
v1 14 + V2 既有 79 schemas / paths 全部不变;controller 增 `@Req()` 参数不进 OpenAPI;
**累计 V2 79 接口**(与 v0.7.0 一致);**累计 93 接口** contract snapshot 保护。

**e2e 覆盖**:

- 累计 e2e 用例 **778**(v0.7.0 release 时 724,+54):
  - PR #3 contribution-rules:+10(`audit-logs-migrations.e2e-spec.ts` +9 it + 1 fix)
  - PR #4 activities:+13
  - PR #5 activity-registrations:+12
  - PR #6 attendances:+19
- 既有 emergency-contacts / certificates / contribution-rules / activities /
  activity-registrations / attendances 业务 e2e **零退化**
- contract snapshot 6 次连续验证零漂移(代码 PR ×4 + docs PR ×4 全部跑过 contract 测试)

### PR 全景表

| PR | 类型 | 模块 / 主题 | 写 hook | union 增量 | merge commit |
|---|---|---|---|---|---|
| #34 | feat | contribution-rules | 3 | +3 | `e8fefe0` |
| #35 | docs | record audit_logs contribution-rules migration | — | — | `a99dd3e` |
| #36 | feat | activities | 5 | +1 | `e6fc079` |
| #37 | docs | record audit_logs activities migration | — | — | `eb2cc33` |
| #38 | feat | activity-registrations | 6 | +2 | `cdd4794` |
| #39 | docs | record audit_logs registration migration | — | — | `9909d97` |
| #40 | feat | attendances | 8 | +5 | `13db2cc` |
| #41 | docs | record audit_logs attendances migration | — | — | `b10a338` |
| **合计** | **4 + 4** | **4 模块** | **22 处** | **+11**(union 6 → 17) | — |

### v0.8.0 范围严控 — 未做项

- **不改 `prisma/schema.prisma`** / 不新增 migration
- **不改 `auditPlaceholder` 函数体**(`src/common/audit/audit-placeholder.ts` 28 项 union
  原样保留;8 处 read 类仍依赖 pino-only 占位)
- **不改 `AuditEvent` union**(28 项原样;新增 11 项仅在 `AuditLogEvent` 中,D2 同值并存)
- **不启动 read 类审计**(沿 Q1=A;业务确认稿升级到 Q1=B 或 C 时另开评审)
- **不启动新业务模块**(attachments / member_profiles / events / event_participants
  仍延后,见 docs/V2红线与复活路径.md §4.3)
- **不引入 RBAC / APD 部门部长细分权限**(attendances final-review 仍 ADMIN/SUPER_ADMIN)
- **不引入 Redis / 队列 / 定时任务 / cls-rs / AsyncLocalStorage**(沿 V1.1 §11.3)
- **不引入 records / extras 字段打码**(沿 v0.7.0 不打码范式;后续业务需打码须独立评审)

---

### V2 Batch 6 PR #6 Implementation(2026-05-13;audit_logs 第二波写操作迁移收官)

- `13db2cc` feat(audit-logs): migrate attendances write events to AuditLogsService (#40) —
  **`audit_logs` 第二波最后一批**(D-A 修订渐进迁出策略,沿 D6 v1.1 §8 / §16.3 F2 触发条件;
  紧接 PR #5 activity-registrations 之后):
  attendances 模块 **8 处写操作**(`submit` / `edit` × 2 / `softDelete` / `approve` /
  `reject` / `finalApprove` / `finalReject`)从 pino-only `auditPlaceholder`
  迁移到 `AuditLogsService.log()` **同事务落库**;
  **事件名沿 D2 同值零变更**(从旧 `AuditEvent` union 挪到 `AuditLogEvent` union),
  且 **5 个事件名共承担 8 处 operation**(沿 batch3 草案 §20.2 A4-A8 + batch 4-B 终审有意设计;
  路线 A:不拆 `attendance-sheet.approve / .reject / .final-approve / .final-reject` 等新事件名):
  - `attendance-sheet.submit`(1 处,`attendances.service.ts:submit`;Sheet + N records 一次性
    入库,D11 推动 Activity → completed)
  - `attendance-sheet.edit`(2 处共用,`extra.operation ∈ {edit, edit-no-records}` 区分):
    - `attendances.service.ts:edit`(主路径,旧 records 软删 + 新 records 创建,version+1)
    - `attendances.service.ts:edit`(no-records 分支,仅 version+1 + previousSnapshot)
  - `attendance-sheet.delete`(1 处,`attendances.service.ts:softDelete`;pending Sheet 软删
    + records 级联软删)
  - `attendance-sheet.review`(2 处共用,`extra.action ∈ {approve, reject}` 区分):
    - `attendances.service.ts:approve`(`pending → pending_final_review`,R31 校验;
      批次 4-B 状态机升级,**不再触发** `attendance.recorded` — 触发位置移到 final-approve)
    - `attendances.service.ts:reject`(`pending → rejected`,reviewNote 必填)
  - `attendance-sheet.final-review`(2 处共用,`extra.action ∈ {final-approve, final-reject}` 区分):
    - `attendances.service.ts:finalApprove`(`pending_final_review → approved`;**触发**
      `attendance.recorded` 业务事件;贡献值正式生效;`extra.eventTriggered=true` 标识)
    - `attendances.service.ts:finalReject`(`pending_final_review → final_rejected`;
      records 跟随软删;finalReviewNote 必填)
  - 调用样式从 `auditPlaceholder(event, ctx)` 改为 `await this.auditLogs.log({ ..., tx })`,
    `tx` 来自业务 `prisma.$transaction` 内,**audit 与业务同事务、同回滚**(沿 D-B fail-fast / D9);
  **`AuditLogEvent` union 从 12 项扩展为 17 项**;与 `auditPlaceholder` 28 项 union 仍
  **物理隔离**(A-16 红线 / D2);**`attendance-sheet.read.other` 字符串同时存在于
  `AuditEvent`(pino-only:3 处 read.other 残留)与 `AuditLogEvent` 不重叠**(read 路径
  仍走 pino-only);
  **5 个 service 写操作通过 extra 字段细分语义**,按 `event` 字段筛选无法直接区分 8 种 operation,
  需用 `event='attendance-sheet.<name>' AND context->'extra'->>'operation'='xxx'` 组合查询;
  **3 处 read.other 不迁移**(line 710 `list` / line 730 `findOne` / line 772 `reviewDetail`):
  read/list/detail 行为,无 DB mutation,**保持 pino-only**;沿 Q1=A "当前阶段不记录查看行为"
  严格执行;e2e 显式断言"GET list / detail / review-detail 不入库"3 个用例;
  service 内 `auditPlaceholder` import **保留**(read.other 仍依赖);
  **`eventPlaceholder('attendance.recorded')` 不动**(line 1251,`finalApprove` 同事务内
  触发业务事件;**与 audit 是两套独立机制**,沿 D-S7;两者同事务并存,audit 写失败 →
  整个事务回滚 → 业务事件随之回滚,由 DB 事务原子性保证;e2e 用例 "finalApprove 与
  attendance.recorded 业务事件并存" 显式验证);
  **final-review 权限未改**:仍保持 `@Roles(SUPER_ADMIN, ADMIN)`(行 274 / 296);
  **APD 部门部长/副部长细分权限尚未实装**,后置(本批次纯 audit 迁移,不动权限语义);
  **contribution rule 预填(D14 5.B)/ R31 校验(approve 时所有 `records.contributionPoints` 必填)
  逻辑未改**(本批次只动 audit hook 调用样式,不动业务规则);
  **attendances.controller.ts 改造**:3 个 controller(`AttendanceSheetsCollectionController` +
  `AttendanceSheetsResourceController` + `AttendanceRecordsMeController`)共用**模块级
  `buildAuditMeta()`** 函数(沿 PR #5 activity-registrations 模块级范式;3 个 controller
  共享避免重复定义);7 个写方法各加 `@Req() req: Request` 参数,显式构造 `AuditMeta`
  传给 service;`list` / `findOne` / `reviewDetail` / `listMyRecords` 4 个 read 接口**完全不动**;
  **attendances.module.ts 改造**:`imports: [DatabaseModule, AuditLogsModule]`,
  注入 `AuditLogsService`;
  **新增 `toSheetAuditSnapshot()` helper**(与现有 `buildSnapshot` 语义分离:`buildSnapshot`
  服务于 `sheet.previousSnapshot` 业务列,`toSheetAuditSnapshot` 服务于 `audit_logs.context`):
  字段集 = `sheetSafeSelect` + 可选 `RecordWithMemberRow[]`;Date 经 `.toISOString()`,
  Decimal 经 `.toString()` / `decimalToString`;字段全部非敏感(打码矩阵 §4.3 未命中,沿
  PR #3 / PR #4 / PR #5 不打码范式;`reviewNote` / `finalReviewNote` 文本字段保持原值);
  **records 快照策略**(submit / edit × 2 / softDelete / finalReject 必含 records;
  approve / reject / finalApprove 只放 sheet + `extra.recordsCount`):
  - `submit`:`after` 含 `sheet + records` 完整快照 / `extra.{operation:'submit', activityId, recordsCount, activityPushedToCompleted}`
  - `edit`(主路径):`before` 含 sheet + 旧 records / `after` 含 sheet + 新 records / `extra.{operation:'edit', oldRecordsCount, newRecordsCount, newVersion}`
  - `edit`(no-records):`before` / `after` 各含 sheet + currentRecords(records 不变,仅 version+1) / `extra.{operation:'edit-no-records', recordsCount, newVersion}`
  - `softDelete`:`before` 含 sheet + records / 不传 `after` / `extra.{operation:'delete', priorStatusCode, recordsCount}`
  - `approve`:`before` / `after` 仅含 sheet / `extra.{operation:'review', action:'approve', priorStatusCode, nextStatusCode:'pending_final_review', recordsCount}`
  - `reject`:`before` / `after` 仅含 sheet / `extra.{operation:'review', action:'reject', priorStatusCode, nextStatusCode:'rejected'}`
  - `finalApprove`:`before` / `after` 仅含 sheet / `extra.{operation:'final-review', action:'final-approve', priorStatusCode, nextStatusCode:'approved', recordsCount, eventTriggered:true}`
  - `finalReject`:`before` 含 sheet + records / `after` 仅含 sheet(records 已软删) / `extra.{operation:'final-review', action:'final-reject', priorStatusCode, nextStatusCode:'final_rejected', recordsCount, finalReviewNote}`
  `resourceType` 固定 `attendance_sheet`(snake_case 单数,对齐前 5 个迁移模块的
  resourceType 风格:`emergency_contact` / `certificate` / `contribution_rule` / `activity` /
  `activity_registration`);
  `finalApprove` 复用 `recordsForEvent` 变量避免重复查 records(与 `eventPlaceholder` 共享同一
  `recordWithMemberSelect` 查询结果);
  **不补 `changedFields`**(本模块 `edit` 是 records 全量替换不是字段 update;approve /
  reject / final-* 是状态机流转,无字段 update);沿 PR #5 activity-registrations 不补范式;
  **attendances 模块内实际 `auditPlaceholder` 调用 = 3**(line 710 / 730 / 772 全部 read.other,
  read/list/detail/review-detail 保持 pino-only;沿 Q1=A 边界);
  **e2e 扩展**:`test/e2e/audit-logs-migrations.e2e-spec.ts` 加 1 个 describe(19 个 it):
  - 8 处 hook 触发 ×8(`submit` / `edit` 主路径 / `edit-no-records` / `softDelete` /
    `approve` / `reject` / `finalApprove` / `finalReject` 各 1)
  - context 锁形(`requestId` 非空 / `ip` `ua` 字段存在)×1
  - before/after 结构 ×4(`submit` only after / `edit` before+after with version 跳变 /
    `softDelete` only before / `finalReject` before 含 records / after 仅 sheet)
  - 同事务回滚 ×2(`submit` 字典 invalid → audit 不入表 + sheet 不入表;
    `approve` R31 失败 → 22072 CONFLICT → audit 不入表 + 状态不变)
  - read.other 不入库 ×3(`GET list` / `GET detail` / `GET review-detail` 显式边界断言)
  - `finalApprove` 与 `attendance.recorded` 业务事件并存 ×1(两套机制独立验证)
  累计 e2e 用例 **778**(PR #5 后 759,+19);
  **OpenAPI contract snapshot 零漂移**:本批次不改 controller 响应 / Swagger 结构 / paths;
  v1 14 + V2 既有 79 schemas / paths 全部不变(controller 增 `@Req()` 参数不进 OpenAPI);
  **累计 V2 79 接口**(与 v0.7.0 一致);**累计 93 接口 contract snapshot 保护**;
  本批次**不做**(范围严控):
  - 不改 `prisma/schema.prisma` / 不新增 migration
  - 不改 `auditPlaceholder` 函数体(F1 保持;3 处 read.other 仍依赖)
  - 不改 `AuditEvent` union(28 项原样;`attendance-sheet.*` 5 项在 `AuditEvent`
    与 `AuditLogEvent` 中同值并存,D2 设计意图)
  - 不迁移 3 处 read.other(沿 Q1=A 边界 #3,**当前批次不做**,非"永久不做")
  - 不动 `eventPlaceholder('attendance.recorded')`(沿 D-S7;两套机制独立)
  - 不动 final-review 权限(APD 细分仍后置)
  - 不动 contribution rule 预填 / R31 校验逻辑(纯 audit 迁移,不动业务规则)
  - 不引入 records 字段打码(本次纯迁移)
  - 不补 `changedFields`(本模块无通用 update)
  - 不动 attendances.e2e-spec.ts ~80 业务 e2e(业务 e2e 零退化)
  - 不 bump `package.json#version` / 不改 Swagger `setVersion`(仍 `0.7.0`)
  - 不打 tag / 不发 GitHub Release

#### audit_logs 第二波写操作迁移收官里程碑

**PR #34 / PR #36 / PR #38 / PR #40 四个代码 PR 合并后,audit_logs 第二波所有写操作
迁移工作全部完成**:

| PR | 模块 | 写 hook | union 增量 |
|---|---|---|---|
| #34 | contribution-rules | 3 | +3(`contribution-rule.{create, update, delete}`) |
| #36 | activities | 5 | +1(`activity.publish` 共用) |
| #38 | activity-registrations | 6 | +2(`registration.{create, review}` 共用) |
| #40 | attendances | 8 | +5(`attendance-sheet.{submit, edit, delete, review, final-review}`) |
| **合计** | **4 模块** | **22 处写** | **+11**(`AuditLogEvent` union 6 → 17) |

**剩余 8 处 read 类 `auditPlaceholder` 调用**继续 pino-only(沿 Q1=A 业务确认稿
"当前阶段不记录查看行为"决议):

- `member-profiles` 1 处(`profile.read.other`)
- `emergency-contacts` 1 处(`emergency-contact.read.other`)
- `certificates` 3 处(`certificate.read.other` × 2 / `certificate.read.qualification-flag` × 1)
- `attendances` 3 处(`attendance-sheet.read.other`)— PR #6 显式确认不迁移
- `activity-registrations` 1 处(`exportCsv` 的 `registration.review`)— PR #5 显式确认不迁移

**未做**(沿前面 4 个 PR 收口边界):

- 不改 `prisma/schema.prisma` / 不新增 migration
- 不改 `auditPlaceholder` 函数体 / 不改 `AuditEvent` union(28 项原样)
- 不迁移 8 处 read.other(沿 Q1=A;**当前阶段不做**,非"永久不做")
- 不 bump `package.json#version` / 不改 Swagger `setVersion`(仍 `0.7.0`)
- 不打 tag / 不发 GitHub Release

### V2 Batch 6 PR #5 Implementation(2026-05-13)

- `cdd4794` feat(audit-logs): migrate activity-registrations write events to AuditLogsService (#38) —
  **`audit_logs` 第二波第三步**(D-A 修订渐进迁出策略,沿 D6 v1.1 §8 / §16.3 F2 触发条件;
  紧接 PR #4 activities 迁移之后):
  activity-registrations 模块 **6 处写操作**(管理端 `create` / `approve` / `reject` /
  `cancelAdmin` + 队员端 `createMy` / `cancelMy`)从 pino-only `auditPlaceholder`
  迁移到 `AuditLogsService.log()` **同事务落库**;
  **事件名沿 D2 同值零变更**(从旧 `AuditEvent` union 挪到 `AuditLogEvent` union),
  且 **2 个事件名共承担 6 个 operation**(沿 batch3 草案 §20.2 A2 / A3 有意设计;
  路线 A:不拆 `registration.approve` / `registration.reject` / `registration.cancel` 等新事件名):
  - `registration.create`(2 处):
    - `activity-registrations.service.ts:create`(ADMIN 代报名,`extra.viaPath='admin'`)
    - `activity-registrations.service.ts:createMy`(USER 自助,`extra.viaPath='self'`,
      `extra.targetMemberId` = USER 绑定的 memberId)
  - `registration.review`(4 处):
    - `activity-registrations.service.ts:approve`(`extra.action='approve'` + `extra.priorStatusCode='pending'` + `extra.nextStatusCode='pass'`)
    - `activity-registrations.service.ts:reject`(`extra.action='reject'` + `extra.nextStatusCode='reject'`)
    - `activity-registrations.service.ts:cancelAdmin`(`extra.action='cancel'` + `extra.cancelledByPath='admin'` + `extra.cancelReason`)
    - `activity-registrations.service.ts:cancelMy`(`extra.action='cancel'` + `extra.cancelledByPath='self'` + `extra.cancelReason`)
  - 调用样式从 `auditPlaceholder(event, ctx)` 改为 `await this.auditLogs.log({ ..., tx })`,
    `tx` 来自业务 `prisma.$transaction` 内,**audit 与业务同事务、同回滚**(沿 D-B fail-fast / D9);
  **`AuditLogEvent` union 从 10 项扩展为 12 项**(`emergency-contact.write` × 1 +
  `certificate.{create,update,delete,verify,reject}` × 5 + `contribution-rule.{create,update,delete}` × 3 +
  `activity.publish` × 1 + `registration.create` × 1 + `registration.review` × 1);
  与 `auditPlaceholder` 28 项 union 仍**物理隔离**(A-16 红线 / D2);
  **`registration.create` / `registration.review` 字符串同时存在于 `AuditEvent`(pino-only
  exportCsv 残留)与 `AuditLogEvent`(DB write × 6)**:这是 D2 same-value 设计意图,
  not bug;`exportCsv` 调用走 `AuditEvent` 路径,其他 6 处写走 `AuditLogEvent` 路径;
  **5 个 service 写操作通过 extra 字段细分语义**,按 `event` 字段筛选无法直接区分 6 种 operation,
  需用 `event='registration.review' AND context->'extra'->>'action'='xxx'` 组合查询;
  **剩余 16 处**写/读事件继续 pino-only,等后续批次按需迁出(activity-registrations 模块内
  仅剩 `exportCsv` 1 处 pino-only);
  **`exportCsv` 不迁移**(line 742,`auditPlaceholder('registration.review', ...)` 保留):
  这是 **read/export 行为**(无 DB mutation,不在 `prisma.$transaction` 内),
  按 Q1=A "当前阶段不记录查看行为" 严格执行,**保持 pino-only**;e2e 显式断言"exportCsv 不入库";
  **service 内 `auditPlaceholder` import 保留**(exportCsv 仍依赖);
  **activity-registrations.controller.ts 改造**:模块级 `buildAuditMeta()` 私有函数
  (沿 contribution-rules / activities 范式,但因本模块有 **2 个 controller** 共享 audit meta 构造,
  提取到模块级以避免双 controller 重复定义);6 个写方法(`create` / `approve` / `reject` /
  `cancel` + `createMy` / `cancelMy`)各加 `@Req() req: Request` 参数,显式构造 `AuditMeta`
  传给 service(D8:不引入 cls-rs / AsyncLocalStorage);`list` / `listMy` / `findMy` /
  `exportRegistrations` 4 个 read 接口**完全不动**;
  **activity-registrations.module.ts 改造**:`imports: [DatabaseModule, AuditLogsModule]`,
  注入 `AuditLogsService`;
  **新增 `toAuditSnapshot()` helper**(沿 contribution-rules / activities `toAuditSnapshot` 范式):
  字段集 = `registrationSafeSelect` 剔除 `id` / `createdAt` / `updatedAt`(audit_logs 自带);
  `extras` 字段经 `jsonAsObject` 取强类型;Date 字段(`registeredAt` / `reviewedAt` /
  `cancelledAt`)由 Prisma JsonValue 写入时自动调 `Date.toJSON()` → ISO string;
  字段全部非敏感(D6 v1.1 §7.3 打码矩阵未命中),**不打码,原值入审计**;
  **注意**:`extras` 是用户自定义 JSON,可能包含报名时填写的个人信息(紧急联系人 / 偏好等),
  **本次纯迁移不引入打码**(沿原 `auditPlaceholder` 无打码行为 + 沿 PR #3 / PR #4 不打码范式);
  若后续业务认为 `extras` 含敏感字段需独立批次评审打码策略;
  **audit context 结构**:
  - `create`(admin/self):`after` 完整 snapshot + `extra.{operation:'create', viaPath, activityId, targetMemberId}`
  - `approve`:`before` + `after` + `extra.{operation:'review', action:'approve', priorStatusCode, nextStatusCode:'pass', activityId, targetMemberId}`
  - `reject`:`before` + `after` + `extra.{operation:'review', action:'reject', priorStatusCode, nextStatusCode:'reject', activityId, targetMemberId}`
  - `cancelAdmin`:`before` + `after` + `extra.{operation:'review', action:'cancel', priorStatusCode, nextStatusCode:'cancelled', cancelledByPath:'admin', cancelReason, activityId, targetMemberId}`
  - `cancelMy`:`before` + `after` + `extra.{operation:'review', action:'cancel', priorStatusCode, nextStatusCode:'cancelled', cancelledByPath:'self', cancelReason, activityId, targetMemberId}`
  `resourceType` 固定 `activity_registration`(snake_case 单数,对齐第一波 `emergency_contact` /
  `certificate` 与 PR #3 `contribution_rule` 与 PR #4 `activity` 风格);
  **不补 `changedFields`**:本模块无通用 update 接口(approve/reject/cancel 都是状态机
  流转,不是字段更新),不引入 `Object.keys(dto)` 的 changedFields(差异于 PR #3 contribution-rules /
  PR #4 activities `update`);
  **activity-registrations 模块内实际 `auditPlaceholder` 调用 = 1**(line 742,exportCsv,
  read/export 保持 pino-only;沿 Q1=A 边界);
  **e2e 扩展**:`test/e2e/audit-logs-migrations.e2e-spec.ts` 加 1 个 describe(12 个 it):
  6 处 hook 触发 ×6(admin create / self create / approve / reject / admin cancel / self cancel)+
  context 锁形(`requestId` 非空 / `ip` `ua` 字段存在)+ before/after 结构(create only after / approve before+after)+
  同事务回滚(重复报名 `ACTIVITY_REGISTRATION_ALREADY_EXISTS` → audit + 业务都不入表)+
  **exportCsv 不入库**(显式边界断言,验证 read/export 路径继续 pino-only)+
  未迁移 read 路径不入库 ×2(`GET list` / `GET detail/me` 不写 audit_logs);
  累计 e2e 用例 **759**(PR #4 后 747,+12);
  **OpenAPI contract snapshot 零漂移**:本批次不改 controller 响应 / Swagger 结构 / paths;
  v1 14 + V2 既有 79 schemas / paths 全部不变(controller 增 `@Req()` 参数不进 OpenAPI);
  **累计 V2 79 接口**(与 v0.7.0 一致);**累计 93 接口 contract snapshot 保护**;
  本批次**不做**(范围严控):
  - 不改 `prisma/schema.prisma` / 不新增 migration
  - 不改 `auditPlaceholder` 函数体(F1 保持;占位定义仍在 `src/common/audit/audit-placeholder.ts`;
    exportCsv 仍依赖)
  - 不改 `AuditEvent` union(28 项原样)
  - 不迁移 read 类查看事件(沿 Q1=A 业务确认稿决议,F3 保持;**当前批次不做**,非"永久不做")
  - 不迁移 `exportCsv` 的 `registration.review` pino 调用(read/export 行为,沿 Q1=A 边界)
  - 不动 `attendances`(写 8 处)模块的写操作 `auditPlaceholder` 调用
    (F4 保持;**仍待后续独立批次按需迁出**,非"永久不做";剩余写 hook 共 8 处)
  - 不动 read 类残留 8 处调用(`member-profiles` 1 / `emergency-contacts` read 1 /
    `certificates` read 3 / `attendances` read 3;沿 Q1=A,**当前阶段不迁移**)
  - 不引入 `extras` 字段打码(本次纯迁移)
  - 不补 `changedFields`(本模块无通用 update)
  - 不 bump `package.json#version` / 不改 Swagger `setVersion`(仍 `0.7.0`)
  - 不打 tag / 不发 GitHub Release

### V2 Batch 6 PR #4 Implementation(2026-05-13)

- `e6fc079` feat(audit-logs): migrate activities write events to AuditLogsService (#36) —
  **`audit_logs` 第二波第二步**(D-A 修订渐进迁出策略,沿 D6 v1.1 §8 / §16.3 F2 触发条件;
  紧接 PR #3 contribution-rules 迁移之后):
  activities 模块 **5 处写操作**(`create` / `update` / `softDelete` / `publish` / `cancel`)
  从 pino-only `auditPlaceholder` 迁移到 `AuditLogsService.log()` **同事务落库**;
  **事件名沿 D2 同值零变更**(从旧 `AuditEvent` union 挪到 `AuditLogEvent` union),
  且 5 个 operation **共用同一事件名** `activity.publish`(沿 batch3 草案 §20.2 A1 有意设计;
  路线 A:不拆 `activity.create / activity.update / ...`):
  - `activity.publish`(`activities.service.ts:create`,`extra.operation='create'` + `extra.nextStatusCode='draft'`)
  - `activity.publish`(`activities.service.ts:update`,`extra.operation='update'` + `extra.priorStatusCode` + `extra.changedFields=Object.keys(dto)`)
  - `activity.publish`(`activities.service.ts:softDelete`,`extra.operation='softDelete'` + `extra.priorStatusCode`)
  - `activity.publish`(`activities.service.ts:publish`,`extra.operation='publish'` + `extra.priorStatusCode` + `extra.nextStatusCode='published'`)
  - `activity.publish`(`activities.service.ts:cancel`,`extra.operation='cancel'` + `extra.priorStatusCode` + `extra.nextStatusCode='cancelled'` + `extra.cancelReason`)
  - 调用样式从 `auditPlaceholder(event, ctx)` 改为 `await this.auditLogs.log({ ..., tx })`,
    `tx` 来自业务 `prisma.$transaction` 内,**audit 与业务同事务、同回滚**(沿 D-B fail-fast / D9);
  **`AuditLogEvent` union 从 9 项扩展为 10 项**(`emergency-contact.write` × 1 +
  `certificate.{create,update,delete,verify,reject}` × 5 + `contribution-rule.{create,update,delete}` × 3 +
  `activity.publish` × 1);与 `auditPlaceholder` 28 项 union 仍**物理隔离**(A-16 红线 / D2);
  **5 个 service 写操作共用 1 个事件字符串**(`activity.publish`),按 `event` 字段筛选无法直接区分
  5 种 operation,需用 `event='activity.publish' AND context->'extra'->>'operation'='xxx'` 组合查询;
  **剩余 18 处**写/读事件继续 pino-only,等后续批次按需迁出;
  **activities.controller.ts 改造**:5 个写方法(`create` / `update` / `softDelete` / `publish` / `cancel`)
  各加 `@Req() req: Request` 参数,controller 内 `buildAuditMeta(req)` 私有方法从
  nestjs-pino `req.id` + `req.ip` + `req.headers['user-agent']` 显式构造 `AuditMeta` 传给
  service(沿第一波 emergency-contacts / certificates 与 PR #3 contribution-rules 范式;
  D8:不引入 cls-rs / AsyncLocalStorage);`list` / `findOne` 两个 read 接口**完全不动**;
  **activities.module.ts 改造**:`imports: [DatabaseModule, AuditLogsModule]`,
  注入 `AuditLogsService`;
  **新增 `toAuditSnapshot()` helper**(沿 contribution-rules `toAuditSnapshot` 范式):
  字段集 = `activitySafeSelect` 剔除 `id` / `createdAt` / `updatedAt`(audit_logs 自带);
  Decimal 字段(`locationLongitude` / `locationLatitude`)经 `decimalToString` 转 string;
  Json 字段(`registrationSchema` / `galleryImageUrls` / `content`)经
  `jsonAsObject` / `jsonAsStringArray` 取强类型;Date 字段(`startAt` / `endAt` /
  `registrationDeadline` / `publishedAt` / `cancelledAt`)由 Prisma JsonValue 写入时
  自动调 `Date.toJSON()` → ISO string;字段全部非敏感
  (D6 v1.1 §7.3 打码矩阵未命中),**不打码,原值入审计**;
  **audit context 结构**:`create` = `after` 完整 snapshot + `extra.{operation:'create', nextStatusCode:'draft'}`;
  `update` = `before` + `after` + `extra.{operation:'update', priorStatusCode, changedFields:Object.keys(dto)}`;
  `softDelete` = `before` + `extra.{operation:'softDelete', priorStatusCode}`;
  `publish` = `before` + `after` + `extra.{operation:'publish', priorStatusCode, nextStatusCode:'published'}`;
  `cancel` = `before` + `after` + `extra.{operation:'cancel', priorStatusCode, nextStatusCode:'cancelled', cancelReason}`;
  `resourceType` 固定 `activity`(单数,对齐第一波 `emergency_contact` / `certificate` 与 PR #3 `contribution_rule` 风格);
  **activities 模块内实际 `auditPlaceholder` 调用 = 0**(仅余 2 处注释字面量描述迁移历史:
  `activities.service.ts:32` 顶部注释 + `audit-placeholder.ts:30` AuditEvent union 注释);
  **e2e 扩展**:`test/e2e/audit-logs-migrations.e2e-spec.ts` 加 1 个 describe(13 个 it):
  触发断言 ×5(create / update / softDelete / publish / cancel 各 1)+ context 锁形
  (`requestId` 非空 / `ip` `ua` 字段存在)+ before/after 结构 ×4(create only after / update before+after /
  softDelete only before / publish before+after)+ 同事务回滚(`activityTypeCode invalid` →
  audit + 业务都不入表)+ 未迁移 read 路径不入库 ×2(`GET list` / `GET detail` 不写 audit_logs);
  累计 e2e 用例 **747**(PR #3 后 734,+13);
  **OpenAPI contract snapshot 零漂移**:本批次不改 controller 响应 / Swagger 结构 / paths;
  v1 14 + V2 既有 79 schemas / paths 全部不变(controller 增 `@Req()` 参数不进 OpenAPI);
  **累计 V2 79 接口**(与 v0.7.0 一致);**累计 93 接口 contract snapshot 保护**;
  本批次**不做**(范围严控):
  - 不改 `prisma/schema.prisma` / 不新增 migration
  - 不改 `auditPlaceholder` 函数体(F1 保持;占位定义仍在 `src/common/audit/audit-placeholder.ts`)
  - 不改 `AuditEvent` union(28 项原样)
  - 不迁移 read 类查看事件(沿 Q1=A 业务确认稿决议,F3 保持;**当前批次不做**,非"永久不做")
  - 不动 `activity-registrations`(7 处写) / `attendances`(写 8 处) 模块的写操作 `auditPlaceholder` 调用
    (F4 保持;**仍待后续独立批次按需迁出**,非"永久不做";剩余写 hook 共 15 处)
  - 不动 read 类残留 8 处调用(`member-profiles` 1 / `emergency-contacts` read 1 /
    `certificates` read 3 / `attendances` read 3;沿 Q1=A,**当前阶段不迁移**)
  - 不 bump `package.json#version` / 不改 Swagger `setVersion`(仍 `0.7.0`)
  - 不打 tag / 不发 GitHub Release

### V2 Batch 6 PR #3 Implementation(2026-05-13)

- `e8fefe0` feat(audit-logs): migrate contribution-rules write events to AuditLogsService (#34) —
  **`audit_logs` 第二波第一步**(D-A 修订渐进迁出策略,沿 D6 v1.1 §8 / §16.3 F2 触发条件):
  contribution-rules 模块 **3 处写操作**(`create` / `update` / `softDelete`)从 pino-only
  `auditPlaceholder` 迁移到 `AuditLogsService.log()` **同事务落库**;事件名沿 D2 同值零变更
  (从旧 `AuditEvent` union 挪到 `AuditLogEvent` union):
  - `contribution-rule.create`(`contribution-rules.service.ts:create`)
  - `contribution-rule.update`(`contribution-rules.service.ts:update`)
  - `contribution-rule.delete`(`contribution-rules.service.ts:softDelete`)
  - 调用样式从 `auditPlaceholder(event, ctx)` 改为 `await this.auditLogs.log({ ..., tx })`,
    `tx` 来自业务 `prisma.$transaction` 内,**audit 与业务同事务、同回滚**(沿 D-B fail-fast / D9);
  **`AuditLogEvent` union 从 6 项扩展为 9 项**(`emergency-contact.write` × 1 +
  `certificate.{create,update,delete,verify,reject}` × 5 + `contribution-rule.{create,update,delete}` × 3);
  与 `auditPlaceholder` 28 项 union 仍**物理隔离**(A-16 红线 / D2);**剩余 19 项**写/读事件
  继续 pino-only,等后续批次按需迁出;
  **contribution-rules.controller.ts 改造**:3 个写方法(`create` / `update` / `softDelete`)
  各加 `@Req() req: Request` 参数,controller 内 `buildAuditMeta(req)` 私有方法从
  nestjs-pino `req.id` + `req.ip` + `req.headers['user-agent']` 显式构造 `AuditMeta` 传给
  service(沿第一波 emergency-contacts / certificates 范式;D8:不引入 cls-rs / AsyncLocalStorage);
  `list` / `findOne` 两个 read 接口**完全不动**;
  **contribution-rules.module.ts 改造**:`imports: [DatabaseModule, AuditLogsModule]`,
  注入 `AuditLogsService`;
  **service 内部 select 扩展**:`softDelete` 的 `existing` select 由 `{ id: true }`
  扩展为 `contributionRuleSafeSelect`(全字段),让 `softDelete` 一次 query 即可拿到 `before`
  完整快照,无需额外 round-trip(沿 certificates 第一波范式);
  **新增 `toAuditSnapshot()` helper**(沿 `toCertSnapshot` 范式):将 `SafeContributionRule`
  转为 JSON-safe 入 audit context;Decimal 字段(`durationThreshold` / `pointsBelow` /
  `pointsAbove` / `dailyCap`)经 `decimalToNumber` 转 number;字段全部非敏感
  (D6 v1.1 §7.3 打码矩阵未命中),**不打码,原值入审计**;
  **audit context 结构**:`create` = `after` 完整 8 字段 snapshot + `extra.operation='create'`;
  `update` = `before` + `after` 完整 8 字段 + `extra.{operation:'update', changedFields:Object.keys(dto)}`;
  `softDelete` = `before` 完整 8 字段 + `extra.{operation:'softDelete', priorStatus}`;
  `resourceType` 固定 `contribution_rule`(下划线,对齐第一波 `emergency_contact` 风格);
  **contribution-rules 模块内实际 `auditPlaceholder` 调用 = 0**(仅余 2 处注释字面量描述迁移历史);
  **e2e 扩展**:`test/e2e/audit-logs-migrations.e2e-spec.ts` 加 1 个 describe(9 个 it):
  触发断言 ×3 + context 锁形(`requestId` 非空 / `ip` `ua` 字段存在)+ before/after 结构 ×3 +
  同事务回滚(`activityTypeCode invalid` → audit + 业务都不入表)+ 未迁移 read 路径不入库 ×2
  (`GET list` / `GET detail` 不写 audit_logs);累计 e2e 用例 **734**(v0.7.0 release 时 724,+10);
  **OpenAPI contract snapshot 零漂移**:本批次不改 controller 响应 / Swagger 结构 / paths;
  v1 14 + V2 既有 79 schemas / paths 全部不变;**累计 V2 79 接口**(与 v0.7.0 一致);
  **累计 93 接口 contract snapshot 保护**;
  本批次**不做**(范围严控):
  - 不改 `prisma/schema.prisma` / 不新增 migration
  - 不改 `auditPlaceholder` 函数体(F1 保持;占位定义仍在 `src/common/audit/audit-placeholder.ts`)
  - 不改 `AuditEvent` union(28 项原样)
  - 不迁移 read 类查看事件(沿 Q1=A 业务确认稿决议,F3 保持;**当前批次不做**,非"永久不做")
  - 不动 activities / activity-registrations / attendances 模块的写操作 `auditPlaceholder` 调用
    (F4 保持;**仍待后续独立批次按需迁出**,非"永久不做";三个模块的写操作 hook 共
    `activities` 5 + `activity-registrations` 7 + `attendances` 写 8 = 20 处)
  - 不动 read 类残留 8 处调用(`member-profiles` 1 / `emergency-contacts` read 1 /
    `certificates` read 3 / `attendances` read 3;沿 Q1=A,**当前阶段不迁移**)
  - 不 bump `package.json#version` / 不改 Swagger `setVersion`(仍 `0.7.0`)
  - 不打 tag / 不发 GitHub Release

- `<本 PR>` docs(v2): record audit_logs contribution-rules migration —
  **本 docs PR**:CHANGELOG `Unreleased` 段记录 PR #34 落地(本节)+ `docs/V2红线与复活路径.md`
  状态同步(A-16 union 计数 6 → 9 / §3.1 PR #3 已完成标注 / §4.1 C-1 进度 22 → 19 待迁 /
  §5 D 类增加局部突破说明 / §7.1 Fast-1 现状刷新);**diff 仅限 markdown**;
  本 PR **不动**:`src/` / `prisma/` / `test/` / `package.json` / `pnpm-lock.yaml` /
  `auditPlaceholder` / `AuditEvent` / `version` / `tag` / `release`

## v0.7.0 - 2026-05-12

V2 第一阶段在 v0.6.0(批次 5-A 落地,V2 77 接口)基础之上,完成 SRVF 业务 **批次 6 PR #1 + PR #2**
(`audit_logs` 基础设施 + 第一批 8 处写操作迁移落库),**累计 V2 79 接口**(原 77 + audit-logs
查询 2);**累计 93 接口** contract snapshot 保护;v1 14 + V2 既有 77 接口 schema + paths
严格 **zero drift**。

**SemVer 预判**(下一独立 PR `chore: bump version to 0.7.0` 时拍板):0.6.0 → 0.7.0 **minor**
(向后兼容的功能新增:`audit_logs` 表 + 2 个查询接口 + 8 处写操作改记审计;沿 v0.5.0 → v0.6.0 风格)。

**重要业务能力**(前端 / 运营 / 接入方必读):

- 新增 `/api/v2/audit-logs` 2 个查询接口,统一 `@Roles(SUPER_ADMIN, ADMIN)`;
  `ADMIN` 仅能看自己操作 OR 操作对象是 `USER` 的审计记录(`list` where 注入 +
  `detail` 二次校验,越级查 `SUPER_ADMIN` 的详情 → `14101 FORBIDDEN_AUDIT_LOG_READ` / 403)
- 紧急联系人(`emergency-contacts`)与证书(`certificates`)的 **8 个写操作**
  (`create` / `update` / `softDelete` × 3 + `verify` / `reject` × 2)自动写入 `audit_logs`;
  返回结构、HTTP status、路径**完全不变**,前端无需调整
- 敏感字段(紧急联系人 `contactName` / `phonePrimary` / `phoneBackup` / `address`)
  在审计上下文中**已打码**(`张*` / `138****1111` / `广东省深圳市******`);
  证书字段全部非敏感,**原值入审计**(沿 Q4 业务确认稿打码矩阵)
- **不记录查看行为**(Q1=A 业务决议):列表 / 详情 / 资质查询接口**不写** `audit_logs`,
  仅 pino 结构化日志保留(`auditPlaceholder` 28 项 union 中 22 项**继续 pino-only**;
  本批次仅 6 项落库,后续批次按需迁出)
- **不做失败操作审计**(D-B fail-fast):业务 `BizException` 回滚整个 `prisma.$transaction`,
  `audit_logs` 与业务表同时入 / 同时不入,**不存在"操作失败但审计成功"的中间态**
- **不做 audit_logs 自身审计**(F6):查询 `/api/v2/audit-logs` 不会产生新审计记录
- **写入后不可改不可删**(R1 红线):`AuditLog` model 无 `updatedAt` / `deletedAt`;
  controller 不开放 `POST` / `PATCH` / `PUT` / `DELETE`(框架返 404);测试库**豁免**(`TRUNCATE` 仅 `test/helpers/audit-logs-cleanup.ts` 双保险 helper 可调用)

详见 [`docs/批次6_audit_logs_API前评审.md`](docs/批次6_audit_logs_API前评审.md) v1.1 D6 评审稿
(25 项决议:B1-B5 / D1-D10 / F1-F10)与下方批次 6 子段。

### V2 Batch 6 PR #1 Implementation(2026-05-12)

- `9aac9d0` feat(audit-logs): add schema + module + AuditLogsService + maskPii util (#29) —
  **新增 `prisma/migrations/20260512140546_v2_batch6_audit_logs/migration.sql`**:`audit_logs`
  表 9 业务字段 + `actorUser` FK Restrict + 3 复合索引(`(resourceType, resourceId)` /
  `(actorUserId, createdAt)` / `(event, createdAt)`),**无 `updatedAt` / `deletedAt`**(R1 红线);
  **新增 `src/modules/audit-logs/` 模块**(主体 4 文件 + `audit-logs.select.ts` 安全字段 select
  + `audit-logs.types.ts` 6 项 `AuditLogEvent` union + 6 字段 `AuditContext` 锁形 + `AuditMeta`
  3 字段,共 6 文件,D6 v1.1 §15.3);
  **新增 2 接口**(全部 `@Roles(SUPER_ADMIN, ADMIN)`):`GET /api/v2/audit-logs`(分页 +
  6 字段过滤:`resourceType` / `resourceId` / `event` / `actorUserId` / `startDate` /
  `endDate`)/ `GET /api/v2/audit-logs/:id`(`assertCanReadAuditLog` 二次校验,越级 403);
  **新增 `src/common/audit/mask-pii.util.ts`** 4 函数(`maskName` / `maskPhone` /
  `maskAddress` / `maskIdCard`;空字符串 / null / undefined 统一短路返 `null`,D6 v1.1 §7.1);
  **新增 BizCode `140xx + 141xx`** 段位 2 码:`14001` `AUDIT_LOG_NOT_FOUND` / `14101`
  `FORBIDDEN_AUDIT_LOG_READ`;**不开**(沿 D6 v1.1 §9):`14002+`(无唯一约束)/ `14010+`
  (无业务级输入校验)/ `14102+`(沿 baseline,USER 越权走通用 `FORBIDDEN` / 40300);
  **`AuditLogsService.log()`** 落库入口,接受 `tx?: Prisma.TransactionClient` 透传
  (D9 同事务保证;不引入 cls-rs / AsyncLocalStorage,D8 显式 meta 路径);
  **`AuditEvent`(28 项)与 `AuditLogEvent`(6 项)物理隔离**(D2):前者留 pino-only 占位
  在 `src/common/audit/audit-placeholder.ts`,后者走 DB 落库在 `src/modules/audit-logs/audit-logs.types.ts`;
  事件名同值,后续批次迁移**仅是把字符串从一个 union 挪到另一个**;
  **`test/helpers/audit-logs-cleanup.ts`** `truncateAuditLogsTestOnly` helper:
  `assertTestDatabaseUrl` 强制 `app_test` 子串 + `APP_ENV !== 'production'` 双保险防御,
  仅 `test/` 引用,生产代码绝不可调用(F10 红线);
  **unit**:`mask-pii.util.spec.ts` 30 + `audit-logs.service.spec.ts` 15(`log` 7 + `findOne`
  权限矩阵 8) = 45 新增;**e2e**:`test/e2e/audit-logs.e2e-spec.ts` 38 用例覆盖 D6 v1.1 §12
  PR #1 矩阵(权限边界 4 + list where 注入 4 + detail 权限 7 + list 过滤 + 排序 7 + 分页 2 +
  不可改不可删 4 + AuditContext 锁形 5 + 不审计自身 2 + DTO 白名单 2 + cleanup helper 1);
  **OpenAPI contract snapshot 更新**:新增 2 paths(`/api/v2/audit-logs` × 2)+ 2 named schemas
  (`AuditContextDto` / `AuditLogResponseDto`);`AuditLogQueryDto` 沿 batch 3 `@Query` 内联范式
  不入 `components.schemas`;v1 14 + V2 既有 77 schemas / paths **零漂移**

### V2 Batch 6 PR #2 Implementation(2026-05-12)

- `aeb2ea8` feat(audit-logs): migrate emergency-contacts + certificates write events to AuditLogsService (#30) —
  **8 处写操作迁移**(D6 v1.1 §8.2 D-A 修订核心):
  - `emergency-contacts.service.ts` 3 处:`create` / `update` / `softDelete`(事件 `emergency-contact.write`)
  - `certificates.service.ts` 5 处:`create` / `update` / `softDelete` / `verify` / `reject`
    (事件 `certificate.create` / `.update` / `.delete` / `.verify` / `.reject`)
  - 调用样式从 `auditPlaceholder(event, ctx)` 改为 `await this.auditLogs.log({ ..., tx })`,
    `tx` 来自业务 `prisma.$transaction` 内,**audit 与业务同事务、同回滚**(D-B fail-fast,D9);
  **8 处 controller 改造**:`emergency-contacts.controller.ts` 3 个 + `certificates.controller.ts`
  5 个写方法各加 `@Req() req: Request` 参数,通过 controller 内 `buildAuditMeta(req)` 私有方法
  从 nestjs-pino `req.id` + `req.ip` + `req.headers['user-agent']` 显式构造 `AuditMeta` 传给
  service(D8:不引入 cls-rs / AsyncLocalStorage);
  **2 个 module 改造**:`emergency-contacts.module.ts` + `certificates.module.ts` 各 `imports:
  [DatabaseModule, AuditLogsModule]`,注入 `AuditLogsService`;
  **service 内部 select 扩展**:`findContactInMemberOrThrow` / `findCertificateInMemberOrThrow`
  的 `select` 由 `{ id, memberId[, certStatusCode] }` 扩展为完整 `*SafeSelect`(全字段),
  让 `update` / `softDelete` / `verify` / `reject` 一次 query 即可拿到 `before` 数据,无需额外
  round-trip(D6 v1.1 §8.2);返回类型变为 `Safe*` 类型,调用方仅取 `id` / `memberId` /
  `certStatusCode` 的语义**完全兼容**(类型是超集);
  **打码矩阵实施**(D6 v1.1 §7.3 / Q4 业务确认稿):紧急联系人 4 字段经 `maskName` /
  `maskPhone` / `maskAddress` 打码后入 `audit.context.before` / `after`;证书字段全部非敏感
  原值入审计;`Date` 字段统一 `.toISOString()` 避免 Prisma `InputJsonValue` 拒 `Date` 对象
  (D6 v1.1 §R5);`verify` / `reject` 的 `before` / `after` 仅状态相关字段(`status` /
  `verifyNote`),非完整快照;
  **22 处未迁移 `auditPlaceholder` 调用零修改**(F2 / D1 决议):member-profiles 1 / emergency-contacts
  `read.other` 1 / certificates `read.other` × 2 + `read.qualification-flag` 1 / activities 5 /
  registrations 7 / attendances 12 / contribution-rules 3 = 32 处其它调用全部继续 pino-only,
  后续批次按需迁出;**事件名同步,迁移成本极低**;
  **e2e**:新增 `test/e2e/audit-logs-migrations.e2e-spec.ts` 25 用例覆盖 D6 v1.1 §12 PR #2 矩阵
  (8 处迁移 hook 触发 + 5 before/after 结构 + 6 打码生效 + 2 同事务行为 + 4 未迁移路径不入库);
  **既有 e2e 零退化**:emergency-contacts(33 用例)/ certificates(50 用例)/ v1 + V2 既有
  661 用例 100% 通过(D6 v1.1 §15.1 A 档门槛);
  **OpenAPI contract snapshot 零漂移**:`@Req()` 不污染 OpenAPI,170 / 170 contract + 2 / 2
  snapshots 全过(本批次的核心契约保护)

### Docs(2026-05-12)

- `e8819f0` docs(v2-batch-6): archive audit_logs business confirmation (#27) —
  归档 D6 业务确认稿(Q1=A 不记查看 / Q2=A 永久保留 / Q3=B 管理员看自己 + 超管看全部 /
  Q4 打码 4 字段 / Q5=B 第一批接 EC + 证书写操作)
- `06796df` docs(v2-batch-6): archive audit_logs API review (#28) — 归档 D6 v1.1 评审稿
  (25 项决议:B1-B5 / D1-D10 / F1-F10;D-A 拍板"不升级 `auditPlaceholder` 函数体"为本批次核心)
- (本 PR)`docs(v2-batch-6): record audit_logs first-wave landing` — CHANGELOG `Unreleased`
  段批次 6 落地记录 + `docs/srvf-foundation-baseline.md §1.1` v0.6 修订(`140xx + 141xx`
  `audit_logs` 段位收口,2 个 BizCode 已实装)

### 本批次不包含(沿 D6 v1.1 §3 F1-F10 + 业务确认稿 Q1-Q5)

- **F1** 不升级 `auditPlaceholder` 函数体(D-A 拍板核心:`auditPlaceholder` 保留 pino-only
  占位实现,**永不写库**,与 `AuditLogsService.log` 物理隔离)
- **F2** 不迁移 22 处之外的 `auditPlaceholder` 调用(member-profiles / EC / certificates read
  类 / activities / registrations / attendances / contribution-rules 等 32 处其它继续 pino-only)
- **F3** 不记录任何查看行为(Q1=A 决议;list / detail / qualification-flag 接口**不写**
  `audit_logs`,仅 pino 结构化日志)
- **F4** 不接 `activities` / `activity-registrations` / `attendances` / `contribution-rules` 写事件
  (Q5=B 范围外;后续批次按需迁出)
- **F5** 不做 `audit_logs` 的 export / 复杂搜索 / 归档 / 清理 / 删除 / 编辑接口
  (R1 红线:写入后不可改不可删)
- **F6** 不做失败操作审计(D-B fail-fast:`success` 默认 `true`,`BizException` 回滚整事务,
  审计与业务同生同灭;后续不开 `success=false` 写入路径)
- **F7** 不审计 `audit_logs` 自身(避免循环;`list` / `detail` 调用不调 `log()`)
- **F8** 不引入队列 / Redis / 定时任务 / cls-rs / AsyncLocalStorage(D8:`AuditMeta` 由 controller
  层从 `@Req()` 构造显式传给 service)
- **F9** 不改 v1 任何接口 / 表 / 测试(零漂移红线)
- **F10** 不改 `prisma/seed.ts`(`audit_logs` seed 数据由 e2e 测试自行造,生产无种子)

### 验证基线(本 Unreleased 段)

| 维度 | v0.6.0 | 批次 6 PR #1 后 | 批次 6 PR #2 后(当前) |
|---|---|---|---|
| `pnpm test`(unit) | 557 / 4 suites | 612 / 6 suites(+ mask-pii 30 + audit-logs.service 15)| **612** / 6 suites |
| `pnpm test:e2e` | 661 / 31 suites | 699 / 32 suites(+ audit-logs 38)| **724** / 33 suites(+ audit-logs-migrations 25) |
| `pnpm test:contract` | 166 + 2 snapshots | 170 + 2 snapshots(+ 2 paths + 2 schemas)| **170** + 2 snapshots(零漂移) |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | 0 warnings / PASS / PASS | 0 warnings / PASS / PASS | **0 warnings / PASS / PASS** |
| CI(PR #29 / #30) | — | 3 jobs 全绿:Lint/Typecheck/E2E ~2m51s + Docker image build ~1m10s + Container boot + API smoke ~1m39s | 2 jobs 全绿:Lint/Typecheck/E2E ~2m46s + Docker image build ~1m6s(Docker Smoke paths filter 未触发,符合预期) |

### 非阻塞事项(转交后续 PR)

- **NB-1** PR #4 `chore: bump version to 0.7.0`:`package.json#version` 0.6.0 → 0.7.0 +
  `src/bootstrap/apply-swagger.ts:20` `setVersion('0.6.0' → '0.7.0')`;merge 后维护者
  手动打 `v0.7.0` tag + GitHub Release
- **NB-2** `docs/handoff/v0.6.0.md` 新建:批次 6 落地后下一会话交接 markdown,可作为
  PR #4 顺手做或独立小 PR;沿 batch 5-A `v0.5.0.md` 范式
- **NB-3** 22 处未迁移 `auditPlaceholder` 调用的批量迁出:**不立即做**,等具体业务方对
  这些 hook 提出"需要查证据 / 审计"诉求时,按事件名同步范式逐批迁出(评审稿 §8.4)
- **NB-4** `AuditLog.actorUserId` `onDelete: Restrict` 在 v1 user 软删契约下**不会触发**
  (v1 user 永远软删 `deletedAt`,不物理删除);若未来引入 user 物理删除,需要单独评审
  审计悬空策略
- **NB-5** Swagger UI 手工验收(`/api/docs` 打开试调 2 个查询接口 + 8 个写接口的典型成功 /
  错误路径)在 **PR #4 `chore: bump version to 0.7.0`** 或 **v0.7.0 release 前**补一次记录
  (B 档 baseline §14 验收门槛)

## v0.6.0 - 2026-05-12

V2 第一阶段在 v0.5.0(批次 4 全部落地,V2 72 接口)基础之上,完成 SRVF 业务 **批次 5-A**
(ContributionRule CRUD:5 个管理接口 + 230xx BizCode 段位收口 + AuditEvent +3 +
attendance e2e P2-1 缺口补齐),**累计 V2 77 接口**(原 72 + 批次 5-A 5);**累计 91 接口**
contract snapshot 保护;v1 14 + V2 既有 72 接口 schema + paths 严格 **zero drift**。

**SemVer 预判**(下一独立 PR `chore: bump version to 0.6.0` 时拍板):0.5.0 → 0.6.0 **minor**
(向后兼容的功能新增,沿 v0.4.0 → v0.5.0 风格)。

**重要业务能力**(前端 / 接入方必读):

- 新增 `/api/v2/contribution-rules` 5 个 CRUD 接口,统一 `@Roles(SUPER_ADMIN, ADMIN)`;
  APD 部门部长 / 副部长专属权限**未做**(留 5-B 独立批次)
- `durationThreshold = NULL` 多条 ACTIVE 由 service 层在 create / update 时**直接拒绝**抛
  `23002 CONTRIBUTION_RULE_ACTIVE_DUPLICATE`(DB partial unique 在 PG NULL 行为下不约束 NULL
  多条,**业务层兜底是唯一来源**)
- PATCH 禁改 `activityTypeCode` / `attendanceRoleCode` / `durationThreshold` 三元组,改维度
  必须停用旧规则后新建;由 `UpdateContributionRuleDto` 白名单 + 全局 `ValidationPipe
  forbidNonWhitelisted` 拦截抛 `BAD_REQUEST` / 40000(**不开** `23030`)
- 规则修改**只影响新提交** AttendanceSheet,**不重算**历史 / pending / pending_final_review
  / rejected / final_rejected Sheet(沿 batch 4-B "submit 时同事务内预填,之后不再读" 语义)
- `softDelete` 写 `deletedAt + deletedByUserId`(schema 已在 batch 4-A 包含字段),
  `status` 不强制改 `INACTIVE`;**注意**:`AttendanceRecord` 的软删字段集与
  `ContributionRule` 不同,5-A 不复用 / 不混淆 / 不抽公共工具

详见 [`docs/批次5-A_贡献值规则CRUD_API前评审.md`](docs/批次5-A_贡献值规则CRUD_API前评审.md) v1.1
(D6 评审稿,33 项决议)与下方批次 5-A 子段。

### V2 Batch 5-A Implementation(2026-05-12)

- `cfa396d` feat(contribution-rules): add v2 batch5-A contribution rule CRUD (#24) —
  **新增 `src/modules/contribution-rules/` 模块**(主体 4 文件 +
  `contribution-rules.select.ts` 安全字段 select 辅助文件,共 5 文件;沿 v1
  `users.select.ts` 范式,D6 v1.1 决议 E2);
  **新增 5 接口**(全部 `@Roles(SUPER_ADMIN, ADMIN)`):`GET /api/v2/contribution-rules` /
  `GET /api/v2/contribution-rules/:id` / `POST /api/v2/contribution-rules` /
  `PATCH /api/v2/contribution-rules/:id` / `DELETE /api/v2/contribution-rules/:id`;
  **新增 BizCode `230xx`** 段位 5 码:`23001` `CONTRIBUTION_RULE_NOT_FOUND` /
  `23002` `CONTRIBUTION_RULE_ACTIVE_DUPLICATE` / `23010` `CONTRIBUTION_RULE_POINTS_INVALID` /
  `23011` `CONTRIBUTION_RULE_ACTIVITY_TYPE_INVALID` / `23012` `CONTRIBUTION_RULE_ROLE_CODE_INVALID`;
  **不开**(沿 D6 v1.1 §5 / §2.2 E8 锁定):`23030` `KEY_FIELDS_NOT_EDITABLE`(PATCH 维度
  禁改交给 DTO 白名单 + ValidationPipe `forbidNonWhitelisted` 拦截)/ `23101~23104`
  `FORBIDDEN_*`(沿 baseline,Guard 拒绝走通用 `40300`)/ `23103` `LAST_RULE_PROTECTED`
  (无最后一条规则保护需求,沿 batch 4-B `22048` 不抛错路径);
  **service 行为**:`create` / `update` 同事务 ACTIVE 唯一性兜底(含 `durationThreshold = NULL`
  维度;`excludeId` 排除自身);Prisma P2002 兜底转 `23002`(沿 member-departments /
  member-profiles 范式,Prisma 6.x P2002 `meta.target` 不可靠 → 直接抛 `ACTIVE_DUPLICATE`);
  字典 `activity_type` + `attendance_role` active 校验沿 batch 3 activities 范式 inline
  `assertDictItemValid`;`update` 仅传 `pointsBelow` / `pointsAbove` / `dailyCap` / `status` /
  `remark` 5 字段(白名单 + ValidationPipe `forbidNonWhitelisted` 双重防护);`softDelete`
  写 `deletedAt + deletedByUserId`,`status` 不强制改(沿 D6 v1.1 E5);
  **AuditEvent union 新增 3 项**:`contribution-rule.create` / `contribution-rule.update` /
  `contribution-rule.delete`(`list` / `findOne` 不 hook,沿 batch 3 写操作 hook 范式;
  `auditPlaceholder` 实现仍为 pino log,**不落 `audit_logs` 表**,沿 D6 v1.1 F7);
  **e2e**:新增 `test/e2e/contribution-rules.e2e-spec.ts` 43 用例覆盖 D6 §7.1 全矩阵
  (list 7 / detail 3 / create 17 / update 10 / delete 4 / perm 2);
  **补 attendance e2e** `contributionPoints: null` 显式入参跳过预填用例(P2-1 缺口收口,
  沿 PR #22 范式;`test/e2e/attendances.e2e-spec.ts:1816`);
  **OpenAPI contract snapshot 更新**:新增 5 paths + 3 named schemas
  (`CreateContributionRuleDto` / `UpdateContributionRuleDto` / `ContributionRuleResponseDto`);
  `ContributionRuleQueryDto` 沿 batch 3 `@Query` 内联范式不入 `components.schemas`;
  v1 14 + batch 1-4 既有 schemas / paths **零漂移**

### Docs(2026-05-12)

- `1e09135` docs(v2-batch-5a): archive contribution rule CRUD API review (D6 v1.1) (#23) —
  `docs/批次5-A_贡献值规则CRUD_API前评审.md` v1.1 评审稿归档,作为 5-A 实施 PR 的前置依据
- (本 PR)`docs(v2-batch5a-landing)`:CHANGELOG `Unreleased` 段批次 5-A 落地记录 +
  `docs/srvf-foundation-baseline.md §1.1` v0.5 修订(`230xx` `contribution_rules` 段位收口,
  未规划模块从 `240xx` 起)+ `docs/handoff/v0.5.0.md` 新建(批次 5-A 落地后下一会话交接)

### 本批次不包含(沿 D6 v1.1 §2.4 F1-F10)

- **F1** 不改 `prisma/schema.prisma`(ContributionRule schema 与 partial unique 已在 batch 4-A 落地)
- **F2** 不新增 migration
- **F3** 不做 APD 部门部长 / 副部长权限细分(留 5-B)
- **F4** 5-A 不做 `dryRun` / 试算接口;若运营强需求,**作为独立批次评审立项后再做**
- **F5** 5-A 不做批量重算 attendance Sheet;默认不做,除非后续独立评审
- **F6** 不做 `contribution_points` 独立流水表 / cron-job(handoff §7.1 / `ARCHITECTURE.md §9` 升级路径锁定,**永久不做**)
- **F7** 不做 `audit_logs` 落库(留独立形态评审)
- **F8** 不改 attendance 状态机(5 态闭集 + APD 终审流程不动)
- **F9** 不改 `attendance.recorded` 触发点(仍仅 final-approve)
- **F10** 不改 v1 14 接口 + batch 1-4 schemas / paths(零漂移)

### 验证基线(本 Unreleased 段)

| 维度 | v0.5.0 | 批次 5-A 后 |
|---|---|---|
| `pnpm test`(unit) | 532 / 4 suites | **557** / 4 suites |
| `pnpm test:e2e` | 617 / 30 suites(含 PR #22 +1) | **661** / 31 suites |
| `pnpm test:contract` | 158 + 2 snapshots | **166** + 2 snapshots |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | 0 warnings / PASS / PASS | 0 warnings / PASS / PASS |
| CI(PR #24) | — | 3 jobs 全绿:Lint/Typecheck/E2E ~2m47s + Docker image build ~1m7s + Container boot + API smoke + graceful shutdown ~1m37s |

### 非阻塞事项(转交后续 PR)

- **NB-1** `detail` / `create` / `update` 出参字段保护断言可后续增强:显式断言
  `expect(res.body.data).not.toHaveProperty('deletedAt' / 'deletedByUserId')`,沿
  `detail-1` 既有模式(可放 v0.6.x 小 PR 或 5-B 实施 PR 顺手补)
- **NB-2** `audit-1` 用例:`create` / `update` / `delete` 触发 `auditPlaceholder` log 的硬验证
  (沿 batch 2 / 3 e2e audit 测法)可后续增强
- **NB-3** Swagger UI 手工验收(`/api/docs` 打开试调 5 接口的典型成功 / 错误路径)在
  **下一独立 PR `chore: bump version to 0.6.0`** 或 **v0.6.0 release 前**补一次记录
  (B 档 baseline §14 验收门槛)

## v0.5.0 - 2026-05-12

V2 第一阶段在 v0.4.0(批次 3A + 批次 3B,V2 70 接口)基础之上,完成 SRVF 业务**批次 4**
(贡献值业务规则:ContributionRule schema + AttendanceSheet 终审 3 字段 + 终审 service /
API + ContributionRule 系统预填 + Activity.completed 单向推动),**累计 V2 72 接口**
(原 70 + 批次 4-B 终审 2);v1 14 + V2 既有 70 接口 schema + paths 严格 **zero drift**;
**累计 86 接口** contract snapshot 保护。

**SemVer 判断**:0.4.0 → 0.5.0 选 **minor**(向后兼容的功能新增 + 文档语义升级)。沿 v0.3.0 → v0.4.0
风格(批次 3 26 接口 minor);批次 4 在 SemVer 0.x.x 阶段属于"开发期未稳定",minor 可包含
状态机扩展与事件触发位置切换(详见批次 4-B 段)— 维护者已知,前端需配套升级。

**重要语义变更**(前端 / 接入方必读):

- `AttendanceSheet.statusCode` 状态机由 **3 态扩展为 5 态**:新增 `pending_final_review` /
  `final_rejected`;`approved` 语义由"APD approve 后即 approved"升级为 **"终审通过"**
  (贡献值正式生效);中间态 `pending_final_review` = "APD 一级通过,待 APD 终审"
- `PATCH .../attendance-sheets/:id/approve` 流转由 `pending → approved` 改为
  `pending → pending_final_review`,**不再触发** `attendance.recorded`
- 新增 `PATCH .../attendance-sheets/:id/final-approve` 与 `.../final-reject` 终审接口;
  `attendance.recorded` 触发位置**移到** `final-approve`
- `POST .../attendance-sheets` 创建时事务内按 `ContributionRule` 预填 `contributionPoints`;
  无匹配规则保持 `null`,APD 终审仍是最终裁定
- 首张 AttendanceSheet 提交时事务内 `Activity.statusCode published → completed`,单向不可逆;
  `completed` 在批次 4 语义 = "活动已进入考勤提交阶段",**不**代表"全部终审通过"
- 终审权限当前沿 `ADMIN / SUPER_ADMIN`(沿 D-S2 不开 `22044`);APD 部门部长 / 副部长专属权限
  留后续 RBAC 批次

详见 [`docs/handoff/v0.4.0.md`](docs/handoff/v0.4.0.md) §12 批次 4 已落地段(9 项核心语义)
与下方批次 4-A / 4-B / 4-C 子段。

### Docs(v0.4.0 release 之后,2026-05-11 ~ 2026-05-12)
- `dd13291` docs(handoff): add v0.4.0 stage handoff for next AI session — `docs/handoff/v0.4.0.md` 落档,
  作为 v0.4.0 release 后"下一会话交接"入口;后续在批次 4-C 中追加批次 4 完成事实
- `0cde221` docs(baseline): fix certificates BizCode segment ownership (#17) — `docs/srvf-foundation-baseline.md`
  §1.1 段位归属修正

### V2 Batch 4-A Schema(ContributionRule + AttendanceSheet 终审 3 字段;2026-05-11)
- `2190803` chore(prisma): add batch4 contribution rule schema (#18) —
  **新增 `ContributionRule` model**(13 字段:`activityTypeCode` / `attendanceRoleCode` /
  `durationThreshold` Decimal(5,2) 可空 / `pointsBelow` Decimal(5,2) / `pointsAbove` Decimal(5,2) 可空 /
  `dailyCap` Decimal(5,2) 可空 / `note` / `status` ContributionRuleStatus enum / `createdByUserId` /
  `updatedByUserId` / `deletedByUserId` 3 个审计 FK + `createdAt` / `updatedAt` / `deletedAt`)+
  **新增 `ContributionRuleStatus` enum**(`ACTIVE` / `INACTIVE`,baseline §2.2.3 ENUM 命名)+
  **AttendanceSheet 加 3 字段终审**(`finalReviewerUserId?` / `finalReviewedAt?` / `finalReviewNote?`,
  D-S5;`SheetFinalReviewer` relation 反挂 User)+
  **partial unique index `contribution_rules_activity_role_threshold_active_unique`**
  (手工 SQL 追加:`WHERE deletedAt IS NULL AND status = 'ACTIVE'`;
  注:PostgreSQL NULL 语义不阻止 `durationThreshold = NULL` 多条 ACTIVE 并存,
  service 层按 `ORDER BY createdAt ASC LIMIT 1` 兜底,见 §6 已知缺口)+
  **3 个新 BizCode**(`220xx` attendances 段位补 3 项,**复用 batch 3B 段位,不新开模块码**):
  `22043 ATTENDANCE_SHEET_FINAL_REJECTED_NOT_EDITABLE` /
  `22045 ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID` /
  `22046 ATTENDANCE_SHEET_FINAL_REVIEW_NOTE_REQUIRED`(沿 D-S2 / batch 3A 不开 `FORBIDDEN_*` 模块码,
  权限不足走通用 `40300`)+
  **`attendance_sheet_status` 字典扩展为 5 态**(原 `pending` / `approved` / `rejected` +
  新 `pending_final_review` / `final_rejected`;字段层仍是 `String`,**未引 Prisma enum**)+
  本 PR 不动 service / DTO / controller / e2e / contract / OpenAPI snapshot,**纯 schema + BizCode 落地**

### V2 Batch 4-B Service / API(终审 + 贡献值预填 + Activity 推动;2026-05-12)
- `6812db9` feat(attendances): add v2 batch4-B final review and contribution prefill (#19) —
  **2 个新路由**(累计 attendances 9 → 11,V2 接口 84 → 86):
  - `PATCH /api/v2/attendance-sheets/:id/final-approve` — APD 终审通过
    (`pending_final_review → approved`;**触发** `attendance.recorded`;沿 D-S5 / D-S7)
  - `PATCH /api/v2/attendance-sheets/:id/final-reject` — APD 终审驳回
    (`pending_final_review → final_rejected`;`finalReviewNote` 必填;records **跟随软删**;
    **不触发** `attendance.recorded`)
  - 两路由 Swagger summary 文案:"终审通过 / 驳回(当前沿用管理权限,细分权限后置;...)" —
    避免暗示已实装 "APD 部门部长 / 副部长" 专属权限(沿 D-S2 不开 `22044`,见 §8 权限边界)
  - **状态机 3 态 → 5 态**(D-S6):
    `pending → rejected`(一级驳回)/ `pending → pending_final_review → approved`(终审通过)/
    `pending → pending_final_review → final_rejected`(终审驳回);
    `pending_final_review` / `final_rejected` 一律不可 `edit` / `softDelete`
    (沿 §2.1 业务规则,`22030` / `22043`)
  - **`approved` 语义升级**:v0.4.0 之前 = "APD approve 后即 approved";
    批次 4 后 = **"终审通过"**(贡献值正式生效);
    `pending_final_review` = "APD 一级审核通过,待 APD 部门部长 / 副部长终审"
  - **`attendance.recorded` 触发位置切换**(沿 D-S7):
    从 `approve` 后移到 `final-approve`;
    `approve` / `reject` / `final-reject` / `submit` / `edit` / `delete` **均不触发**
  - **D14 ContributionRule 预填**(沿 D-A8 候选 5.B):
    POST `/attendance-sheets` 事务内按 `(activityTypeCode, attendanceRoleCode, durationMinutes)` 匹配规则,
    预填 `contributionPoints`;调用方传值**不覆盖**;
    无匹配规则 → 保持 `null`(不抛错;沿 D-S11 `22048` 不开);
    每日上限 `dailyCap` 默认 1.5(沿 Q-OPEN-7 锁定);
    **不暴露** `ContributionRule` CRUD 接口,**不引** `contribution_points` 流水表(均留后续批次)
  - **D11 Activity.completed 推动**(沿 D-S10 / 业务规则文档 §3):
    首张 AttendanceSheet 提交时,事务内 `Activity.statusCode published → completed`,
    单向不可逆;后续 Sheet 提交幂等(已 completed → 无操作);
    `approve` / `reject` / `final-reject` 均**不回退** `Activity.completed`;
    `completed` 在批次 4 语义 = "活动已进入考勤提交阶段",**不**代表"全部终审通过"
    (沿业务规则文档 §3.4:运营可通过 `AttendanceSheet` 列表观察"虽 completed 但无通过考勤")
  - **DTO 变更**:
    新增 `FinalApproveAttendanceSheetDto`(optional `finalReviewNote`,@MaxLength 500)+
    `FinalRejectAttendanceSheetDto`(required `finalReviewNote`,@MinLength 1 / @MaxLength 500);
    `AttendanceSheetResponseDto` 追加 3 字段(`finalReviewerUserId?` / `finalReviewedAt?` /
    `finalReviewNote?`);`reviewNote` / `reviewedAt` / `reviewerUserId` 描述加 "APD 一级" 前缀;
    `statusCode` 描述升级为 5 态文字(注:字段仍是 OpenAPI `string` 类型,**非 enum 数组**,
    见 §6 已知缺口)
  - **AuditEvent union 追加 1 项**:`attendance-sheet.final-review`
    (`action='final-approve' | 'final-reject'`,触发于 finalApprove / finalReject service 同事务内)
  - **e2e 累计**:attendances 69 → 93(+24 用例:终审 / D14 预填 / D11 推动 / 5 态边界);
    全量 e2e 592 → **616**;无 v1 / batch 1 / batch 2 / batch 3 退化
  - **contract 累计**:154 + 2 snapshots → **158 + 2 snapshots**(routes +2 + DTO +2 +
    AttendanceSheetResponseDto +3 字段 + summary 文案锁定);v1 14 + V2 86 接口 zero drift
  - **本 PR 边界**:
    - 不动 `prisma/schema.prisma`(批次 4-A 已一次入库)
    - 不动 migration / seed / reset-db
    - 不暴露 `ContributionRule` CRUD 接口
    - 不引入 `contribution_points` 流水表
    - 不复活 `audit_logs` 表
    - 不引入新依赖
    - APD 部门部长 / 副部长**专属权限未实装**(沿 ADMIN / SUPER_ADMIN;细分权限后置)

### V2 Batch 4-C Docs Release Prep(批次 4 文档收口;2026-05-12)
- `a463fb9` docs(v2-batch-4c): record batch 4-A/4-B landing and 9-point semantics (#20) —
  `CHANGELOG.md` Unreleased 段全量补齐批次 4 三子段(本段)+ `README.md` V2 attendances 行
  更新(3 态 → 5 态,9 → 11 接口,累计 84 → 86 V2)+ `docs/srvf-foundation-baseline.md`
  §1.1 段位表 `220xx` 行追加批次 4-A "3 BizCode" 事实 + `docs/handoff/v0.4.0.md` 追加
  批次 4 完成状态与 9 项核心语义清单;**未** bump version(留独立 PR;由本 `chore: bump
  version to 0.5.0` PR 落地)+ **未** 改 src / prisma / e2e / contract / OpenAPI snapshot
  (本 PR contract zero drift 验证通过)

### Boundaries / Validation(Unreleased 累计;批次 4-A + 4-B 后)
- v1 14 接口 + V2 first stage 29 + 批次 1 7 + 批次 2 8 + 批次 3A 17 + 批次 3B 9 +
  **批次 4-B 2** 接口 schema + paths **zero drift**;累计 **86 接口** 进入 contract snapshot
- v1 14 接口 schema + paths 严格 zero drift(LoginDto / UserResponseDto 不漂移)
- 批次 4-A schema(commit `2190803`)+ 批次 4-B service/API(commit `6812db9`)+ 批次 4-C docs(本 PR)
  形成 **schema → service → docs** 三 PR 拆分,沿 v0.3.0 / v0.4.0 节奏
- 累计验收(merge 时本地 + CI 全绿):
  - `pnpm test` unit 532 / 4 suites(原 517 + 批次 4-A 15 BizCode 元属性遍历自动覆盖)
  - `pnpm test:e2e` **616** / 30 suites(原 592 + 批次 4-B **24**;无退化)
  - `pnpm test:contract` **158 + 2 snapshots**(累计 86 接口 contract zero drift)
  - `pnpm lint` 0 warnings / `pnpm typecheck` PASS / `pnpm build` PASS
  - 批次 4-A PR #18 CI 全绿;批次 4-B PR #19 CI 全绿(Docker + Lint/Typecheck/E2E 双绿)
- **批次 4 永久不做 / 留后续批次**(沿决议表 v1.0):
  - **不暴露** `ContributionRule` CRUD 接口(留运营后台或单独管理 PR)
  - **不引** `contribution_points` 独立流水表 / cron-job(D49 / R32 永久不做,沿 v0.4.0 / 业务规则文档)
  - **不复活** `audit_logs` 表(沿 batch 1 占位)
  - **不实装** APD 部门部长 / 副部长专属权限(沿 D-S2 不开 `22044`;留后续 RBAC 批次)
  - **不开** `BizCode 22044`(权限不足走通用 `40300`)
  - **不引** Prisma enum 锁 `attendance_sheet_status`(字段仍是 `String`,5 态走字典闭集)
  - **`Activity.complete` 独立接口形态**(Q-A11 永久不做;推动机制由 D11 在 `submit` 内触发)

## v0.4.0 - 2026-05-11

V2 第一阶段在 v0.3.0(批次 1 + 批次 2)基础之上,完成 SRVF 业务**批次 3**(activities +
activity-registrations + attendances 共 3 模块,**26 接口**:批次 3A 17 + 批次 3B 9),
**v1 14 接口 + 既有 V2 52 接口 schema + paths 严格 zero drift**;**累计 84 接口**
进入 contract snapshot 保护范围。

### V2 Batch 3 Schema(activities + attendances 共享 schema;2026-05-10)
- `31c8187` chore(prisma): add v2 batch3 activities attendances schema (#9) —
  Activity / ActivityRegistration / AttendanceSheet / AttendanceRecord **4 model** 一次入库
  (共享 schema,3A / 3B PR 不再动 schema)+ User / Organization / Member 9 反向 relation
  (沿批次 1 / 批次 2 R2 范式)+ partial unique index
  `activity_registrations_activity_member_active_unique`
  (`WHERE deleted_at IS NULL AND statusCode != 'cancelled'`,手工 SQL 追加)+
  显式 `@db.Decimal` 注解(`AttendanceRecord.serviceHours / contributionPoints` `Decimal(5,2)`,
  `Activity.locationLongitude / locationLatitude` `Decimal(10,7)`)+ 5 个闭集字典 seed
  (`activity_status` 4 态 / `registration_status` 4 态 / `attendance_sheet_status` 3 态 /
  `attendance_status` 3 态 / `attendance_role` 7 项)+ `activity_type` 2 级树占位(3 父 + 4 子;
  `seedActivityTypeHierarchy`)+ `reset-db.ts` TRUNCATE 顺序更新(孙→子→父依赖)+
  `AuditEvent` union 追加批次 3 8 项(`activity.publish` / `registration.create` /
  `registration.review` / `attendance-sheet.{submit,edit,delete,read.other,review}`)+
  新增 `BusinessEvent` union(`attendance.recorded`;3A 暂不调用,留 3B)

### V2 Batch 3A API(activities + activity-registrations + CSV export;2026-05-11)
- `6a9339b` feat(activities): add v2 batch3A activities and registrations (#10) —
  **17 接口**(activities 7 + registrations 管理端 6 + 队员端 4;
  Q-A3 USER 自助 `POST /api/v2/users/me/activities/:activityId/registration` 与
  ADMIN 代报名 `POST /api/v2/activities/:activityId/registrations` 拆开)+
  **118 e2e**(activities 57 + registrations 61)+
  **13 BizCode**(activities `200xx` 9 个 + registrations `210xx` 4 个;不开 `FORBIDDEN_*`
  模块码;USER 越权一律 404 沿 §1.7 风格)+
  AuditEvent 3 类调用(`activity.publish` / `registration.create` / `registration.review`)+
  Q-A6 CSV 名单导出走 `StreamableFile`(`ResponseInterceptor` 已通过 `instanceof` 自动跳过,
  **未改 interceptor**;默认 `scope=pass` 仅返审核通过 / 可选 `scope=all` 返全部;
  XLSX 直接 400;**不落 export_logs / 不生成 AttendanceRecord;副作用 0**)+
  Q-A12 cancelled Activity 拒改(`update` / `publish` 抛 20030;`delete` 允许,沿 D3)+
  Q-A7 USER + ADMIN `activities` 同路由 service 按 Role 过滤(USER 列表强制
  `statusCode ∈ {published, completed}` 并忽略入参 `statusCode`;USER detail
  draft/cancelled → 404)+ partial unique 防重复报名(`取消后允许重报`)+
  capacity 仅统计 `pass`(`cancelled` 自动释放名额)

### V2 Batch 3A Docs(README + CHANGELOG;2026-05-11)
- `dd040fb` docs(v2-batch-3a): record batch 3 schema + 3A API in README and CHANGELOG (#11) —
  README V2 路由表接口总数 44 → 61;新增 activities(7)/ activity-registrations(10)两行;
  CHANGELOG Unreleased 段追加 batch 3 schema(`31c8187`)+ 3A API(`6a9339b`)子段 +
  Boundaries / Validation 段;3B 落地前的 docs 收口

### V2 Batch 3B Docs(README + CHANGELOG;2026-05-11)
- `c1606e8` docs(v2-batch-3b): record attendance API completion (#13) —
  README V2 路由表接口总数 61 → 70;新增 attendances(批次 3B)9 接口行;
  落地总结段补充 attendance_sheets / attendance_records 已落地 + 累计 84 接口 zero drift;
  CHANGELOG Unreleased 段追加 batch 3A docs(`dd040fb`)+ batch 3B API(`5dbd230`)子段;
  Boundaries / Validation 段累计 75 → 84 接口、unit 452 → 517 / e2e 523 → 592 /
  contract 136 → 154 + 永久不做清单(`/me/service-hours` / `contribution_points` 流水表 /
  rejected clone / `Activity.complete` / XLSX / 动态表单引擎);v0.4.0 release 前最后 docs 收口

### V2 Batch 3B API(attendances + APD review + /me/attendance-records;2026-05-11)
- `5dbd230` feat(attendances): add v2 batch3B attendance sheets and review (#12) —
  **9 接口**(管理端 8 + 队员端 1):
  - 管理端:`POST /activities/:activityId/attendance-sheets`(事务内 create Sheet + N records)/
    `GET /activities/:activityId/attendance-sheets`(列表)/ `GET /attendance-sheets/:id`(简化详情)/
    **`GET /attendance-sheets/:id/review-detail`**(R25:Activity 8 + Sheet + Records[含 Member 嵌套]
    APD 完整审核视图)/ `PATCH /attendance-sheets/:id`(D38:后端事务内生成 Q-S16 完整快照
    `previousSnapshot` + `version+1`;旧 records 软删 + 新 records 创建)/
    `DELETE /attendance-sheets/:id`(级联软删 records)/ `PATCH /attendance-sheets/:id/approve`
    (`pending → approved`;R31 所有 records.contributionPoints 必填;**同事务内触发
    `eventPlaceholder('attendance.recorded')` approved-only**)/ `PATCH /attendance-sheets/:id/reject`
    (`pending → rejected`;reviewNote 必填)
  - 队员端:**`GET /api/v2/users/me/attendance-records`**(Q-A14 / R29 / R33 仅 approved Sheet 内
    records;分页 + 可选 activityId 过滤;不返他人)
  - **14 BizCode**:`20122 ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN`(activities 段补充)+
    `220xx` attendances 13 项(22001 NOT_FOUND / 22030 STATUS_INVALID /
    22040 APPROVED_NOT_EDITABLE / 22041 REJECTED_NOT_EDITABLE / 22051 ROLE_CODE_INVALID /
    22052 STATUS_CODE_INVALID / 22060 TIME_OVERLAP / 22061 CHECK_OUT_BEFORE_CHECK_IN /
    22070 SERVICE_HOURS_INVALID / 22071 SERVICE_HOURS_EXCEEDS_SPAN /
    22072 CONTRIBUTION_POINTS_REQUIRED / 22073 REGISTRATION_ACTIVITY_MISMATCH);不开
    `FORBIDDEN_*` 模块码(沿基线)/ 22042 VERSION_CONFLICT(D37 暂不启用乐观锁)/
    22050 RECORD_NOT_FOUND(Q-A9 不暴露独立 Record 查询)
  - **69 e2e**(attendances.e2e-spec.ts;权限 / 状态机 / 时间不重叠 / serviceHours / R23 / R28
    previousSnapshot / R31 contributionPoints / Q-A14 /me-records / DTO 白名单 / approved-only 事件)
  - **65 unit**(BizCode 元属性遍历自动覆盖 14 项新条目)
  - AuditEvent 5 类调用(`attendance-sheet.submit` / `attendance-sheet.edit` /
    `attendance-sheet.delete` / `attendance-sheet.read.other` / `attendance-sheet.review`;
    union 已在 commit `31c8187` 落地,3B 启用其余 5 项,**未动 audit-placeholder.ts**)
  - BusinessEvent 1 类调用(`attendance.recorded` approved-only;sheet 级 + records 数组
    9 字段 context;**未动 event-placeholder.ts**;触发位置:approve service 事务内,
    rejected / submit / edit / delete 均不触发)
  - 时间不重叠校验(R16 / Q-S15):同 memberId × `[checkInAt, checkOutAt)` 左闭右开;
    跨 Sheet / 跨 Activity 全局;service 层 `assertNoTimeOverlap` 实装;**不**做 PG EXCLUDE 约束
  - serviceHours 规则(D14 / D45 / D46 / D51):未传自动 `(checkOut-checkIn)/3600` /
    `<= 0` 拒(`@Min(0.01)` DTO 兜底 + service 兜底)/ `> 跨度` 拒(22071)/
    允许 `< 跨度`(D46 吃饭休息不计入)
  - R23 跨表:`registrationId !== null` 时校验 `registration.activityId === sheet.activityId`;
    失败 → 22073(`mismatch` 与 `not found` 走同码,沿 §1.7 风格)
  - 3B PR 未引入新依赖;**未动** schema / migration / seed / reset-db / 3A 模块 /
    response interceptor / event-placeholder / audit-placeholder / package.json

### Boundaries / Validation(Unreleased 累计)
- v1 14 接口 + V2 first stage 29 + 批次 1 7 + 批次 2 8 + 批次 3A 17 + **批次 3B 9** 接口
  schema + paths **zero drift**;累计 **84 接口** 进入 contract snapshot 保护范围
- 批次 3 schema(commit `31c8187`)含 4 model + partial unique + 反向 relation,
  **3A + 3B 共享同一份 schema**;3A / 3B PR **均未动 schema / migration / seed / reset-db**
- 3A + 3B PR 均**未引入新依赖**(CSV 手写 `escapeCsvField`;previousSnapshot Json passthrough)
- 累计验收(merge 时本地 + CI 全绿):
  - `pnpm test` unit **517** / 4 suites(原 452 + 批次 3B 65 BizCode 自动遍历)
  - `pnpm test:e2e` **592** / 30 suites(原 523 + 批次 3B **69**;无 v1 / batch 1 / batch 2 /
    batch 3A 退化)
  - `pnpm test:contract` **154** + 2 snapshots(累计 84 接口 contract zero drift)
  - `pnpm lint` 0 warnings / `pnpm typecheck` PASS / `pnpm build` PASS
  - **批次 3B PR #12 CI 3 jobs 全绿**(Lint/Typecheck/E2E 2m47s + Docker build 56s +
    Container smoke 1m42s)
- **永久不做 / 不在批次 3 范围**(沿决议表):
  - `GET /api/v2/users/me/service-hours` **服务时长汇总统计接口**(Q-A5 永久不做,
    留后续"数据统计 / APP 数据"模块或批次 4 贡献值核算)
  - `contribution_points` **独立流水表 / cron-job**(D49 / R32;留批次 4 决议)
  - `POST /attendance-sheets/:id/clone` **rejected Sheet 复制接口**(Q-A4 不实装;
    前端从 `review-detail` 取字段组装新 POST)
  - `PATCH /activities/:id/complete` **Activity.complete 接口**(Q-A11 不实装;
    `completed` 留字典占位,推动机制留批次 4)
  - **XLSX 名单导出**(Q-A6 第一版仅 CSV;`format=xlsx` 入参直接 400)
  - **动态表单引擎**(R19;`extras` / `previousSnapshot` / `registrationSchema` 仅
    `@IsObject()` / Json passthrough,不做嵌套 schema 校验)
  - 独立 `AttendanceRecord` CRUD 路径(Q-A9 不暴露;通过 Sheet `review-detail` 一次返回)
  - `220xx` `ATTENDANCE_RECORD_NOT_FOUND` / `22042` `VERSION_CONFLICT` 不开(沿决议表)

## v0.3.0 - 2026-05-10

V2 第一阶段在 v0.2.0 基础数据底座之上,完成 SRVF 业务批次 1 + 批次 2,共新增 15 接口
(累计 V2 第一阶段 44 接口),**v1 14 接口 schema + paths 严格 zero drift**。

### V2 Batch 1(member_profiles + emergency_contacts;2026-05-10)
- `dbfca6a` chore(prisma): add batch 1 member profile schema —
  MemberProfile(40 字段,1:1 with Member)+ EmergencyContact(8 字段,N:1)+ 6 个字典 seed
- `5d540ce` feat(v2-batch-1): add member-profiles + emergency-contacts modules (#2) —
  7 接口(3 profile + 4 emergency-contact)+ 57 e2e + 10 BizCode(160xx / 190xx)+ AuditEvent 6 项
- `32b03c8` docs(v2-batch-1): correct stale post-merge claims (#4)

### V2 Batch 2(certificates;2026-05-10)
- `8c86aac` chore(prisma): add v2 batch 2 certificates schema (#5) —
  Certificate(18 字段,N:1 + 3 ON DELETE Restrict FK;状态机闭集 4 态)+ 3 个字典 seed
- `ce56018` feat(certificates): add v2 batch 2 certificates module (#6) —
  8 接口(嵌套子资源 + verify / reject / qualification-flag 动作)+ 66 e2e +
  5 BizCode(180xx / 181xx)+ AuditEvent 10 项
- `74f72b4` docs(v2-batch-2): sync facts after schema + API merge (#7)

### CI / Testing
- `6637733` ci: fix docker smoke compose network name (#3)
- `2fdf1fc` test(e2e): stabilize supertest server lifecycle
- `4f4283d` chore: clean up v0.2.0 release housekeeping

### Docs
- `e68c177` docs: add SRVF business docs pointer

### Boundaries / Validation
- v1 14 接口 + V2 first stage 29 接口 + 批次 1 7 接口 schema + paths **zero drift**
- 全部新接口 ADMIN / SUPER_ADMIN 兜底;**未开放** USER 自助路由
- 软删走 `deletedAt`;禁用 hard delete;FK 全部 ON DELETE Restrict
- DTO 严格白名单 + 全局 `ValidationPipe`(forbidNonWhitelisted)+ 统一响应包装 + `BizException`
- AuditEvent union 严格锁死(批次 1 / 批次 2 共 16 项,含 4 项占位)
- 未实装:attachments / audit_logs 表 / RBAC 表 / 60 天提醒任务 / 自动失效 job /
  applicants / activities / attendances / honors / USER 自助路由
- 验收(release 前 main 上 commit `74f72b4` 全量回归):
  - `pnpm test` unit **387**
  - `pnpm test:e2e` **405** / 27 suites(v1 162 + 批次 1 57 + V2 first stage 120 + 批次 2 66;零退化)
  - `pnpm test:contract` **107 + 2 snapshots**(v1 14 + V2 first stage 29 + 批次 1 7 + 批次 2 8 = 58 接口 contract zero drift)
  - `pnpm lint` 0 warnings / `pnpm typecheck` PASS / `pnpm build` PASS

## v0.2.0 - 2026-05-09

### V2 First Stage (srvf-foundation Step 1-7) — 2026-05-08

V2-D8 第一阶段开发已完成,等待维护者按需 release / tag。基础数据底座 4 模型 + v1 兼容性追加 + auth memberNo 登录回退 全部交付,共 29 个新接口。

#### Schema + Seed(Step 1-2)
- `36c0837` chore(prisma): add V2 foundation schema (4 models + users.memberId)
- `53c9a03` chore(seed): add V2 neutral demo dictionary seeds

#### 业务模块(Step 3-6,共 29 接口)
- `33dbd69` feat(dictionaries) — `dict_types` + `dict_items` 双表 13 接口(父子树形 / 启停 / 软删显式封装)
- `da54cf3` feat(organizations) — 树形 7 接口(单根上限 + last-root 保护 + `nodeTypeCode` 走字典)
- `1baa6c6` feat(members) — `memberNo` 全局唯一不复用 6 接口(严禁敏感字段;`gradeCode` 字典校验)
- `c8bc4fd` feat(auth) — `memberNo` 登录回退(`LoginDto` schema **零漂移**;`PrismaService` 直读 member 表;Timing dummy bcrypt 强制扩展;统一抛 `LOGIN_FAILED` 防账号枚举)
- `54a14e0` feat(member-departments) — 一人一部门 3 接口(partial unique `WHERE deletedAt IS NULL` + PUT 幂等 + 软删旧 + 创建新单事务)

#### V2 第一阶段铁律
- v1 14 接口 schema + paths **严格 zero drift**(`LoginDto` / `LoginResponseDto` / `UserResponseDto` 不变)
- 4 个新模块 schema + paths 在 OpenAPI 快照中锁定(31 schemas + 25 paths)
- 字典 / 组织 / 队员 / 归属 全部走软删显式封装(`notDeletedWhere` helper;详情查询禁 `findUnique`)
- 4 个新 enum status 由 Prisma 控制(`DictTypeStatus` / `DictItemStatus` / `OrganizationStatus` / `MemberStatus`)
- BizCode 4 段位:`110xx` organizations / `120xx` dictionaries / `150xx` members / `170xx` member-departments
- 引用约束 + 软删 全部包在 `prisma.$transaction` 原子完成

#### 验收(Step 7 收口)
- `pnpm lint` / `pnpm typecheck` / `pnpm test`(312)/ `pnpm test:e2e`(24 suites / 282 tests;两次稳定,v1 162 零退化)/ `pnpm test:contract`(78 + 2 snapshots)/ `pnpm build`(首次跑过,`dist/` 生成)
- B 档:`pnpm start:dev` / `/api/docs` 200 / `/api/health/live`/`/ready` 200 + `db: up` / `/api/docs-json` v1 10 + V2 15 paths(dict 7 + org 4 + members 3 + member-dept 1)/ v1 admin 登录 200 / V2 各模块贯通流(GET dict-types / GET org tree / GET members / PUT 部门 / GET 部门 / DELETE 部门)/ SIGTERM 优雅关闭

#### V2.x 复活路径(已延后,不在本阶段)
- `member_profiles` / `attachments` / `audit_logs` / `events` / `event_participants`

#### 不在本阶段范围
- 一人多部门 / `isPrimary` / `joinedAt` / `endedAt` / 进出原因 / 部门变更历史 / RBAC / Redis / 队列 / 文件上传 Provider / LLM / pgvector / 多租户

#### 后续 housekeeping(已记录,非阻塞)
- e2e 间歇性 v1 `auth-login.e2e-spec.ts` `'nonexistentuser'` 收到 HTTP 404 而非 401(LOGIN_FAILED)现象;Step 7 两次重跑稳定 282/282;根因可能是 `ThrottlerStorage` 跨 spec 累计或 NestJS 路由初始化 race;独立 task 跟进
- `ORGANIZATION_ROOT_ALREADY_EXISTS` message 措辞优化候选(当前"活跃根节点" vs 实现 `deletedAt=null` 不区分 status,语义略有歧义)

### Docs
- 模板 freeze 文档收口:`README.md` 顶部新增一行说明,声明 `Template baseline: v0.1.6`、`main` 分支进入 template-freeze 模式(仅允许 docs / CI 触发路径变更),新业务模块应在派生项目(例如 `u-rescue-api`)中开发,不在本模板仓库继续堆叠。中英混排,方便 AI 与开源用户理解
- `docs/docker-smoke-test.md` 标题与开头说明改为 "v0.1.5 首轮手动报告(v0.1.6 已修复其中 logger WARN)",显式声明本文档定位为历史快照、v0.1.6 已修复 §6.1 的 WARN、当前自动化以 `.github/workflows/docker-smoke.yml` 为准并列出最新触发路径。smoke 结果本身一行未动
- `docs/deployment.md` 末尾新增 "Branch protection / required checks" 章节:列出建议的 required checks(`Lint / Typecheck / E2E`、`Docker image build`),说明 Docker Smoke 当前建议 non-required(容器启动级 smoke,受 runner / docker / network 时序影响更高,失败应人工查看而非默认阻塞所有 PR),并给出后续提升为 required 的触发条件(连续观察 ≥4 周无假阳性 / 进入正式生产部署前 / 引入显著放大启动差异的变更)
- `README.md` "常用命令"段补充 `pnpm test`(unit:不启动 Nest、不连数据库)与 `pnpm test:contract`(OpenAPI 契约快照,锁 14 接口 schema)两条护栏命令的简短说明,原"E2E 测试"段重命名为"测试(三档)",`pnpm test:e2e` 与 `pnpm db:test:init` / `pnpm db:test:reset` 的语义保持不变;补齐意图是避免新用户只跑 e2e 而忽略 unit / contract 两层快速反馈。仅 README 文案补充,无 API / Prisma schema / 依赖 / Dockerfile / docker-compose.yml / CI workflow / `src/**` 变更
- `docs/docker-smoke-test.md` §6.1 修正启动期 WARN(`[LegacyRouteConverter] Unsupported route path: "/api/*"`)的根因描述。v0.1.5 报告时初步判断与 Swagger 静态资源 / fallback route 有关,**该判断不准确**;v0.1.6 已定位真实根因为 `nestjs-pino` 的 `LoggerModule.configure()` 默认 `forRoutes: [{ path: '*', method: ALL }]` 与 `app.setGlobalPrefix('/api')` 拼接成 `/api/*`,触发 NestJS 11 + path-to-regexp v8 的 `LegacyRouteConverter`,因为 LoggerModule 注册两个 middleware 所以 WARN 重复一次。已在 `src/bootstrap/logger-options.ts` 中通过显式 `forRoutes: [{ path: '*path', method: RequestMethod.ALL }]` 修复。文档同步更新结论行(§9 摘要)标注"已在 v0.1.6 修复",并指明 v0.1.6 之后 smoke 复测应不再出现该 WARN。仅文档修正,smoke test 结果与判定不变,无 API / Prisma schema / 依赖 / Dockerfile / CI / src 变化

### Changed
- `.github/workflows/docker-smoke.yml` 的 `pull_request.paths` 在原 `Dockerfile` / `package.json` / `pnpm-lock.yaml` / `prisma/**` / 自身之外,先后两次扩展:(1) 增加 `docker-compose.yml`(Docker Smoke workflow 依赖其中的 Postgres service / `container_name: u-nest-api-postgres` / 网络名 `u-nest-api-starter_default`,原 paths 未覆盖会导致 `docker-compose.yml` 变更不触发 smoke);(2) 增加 production boot 敏感路径 `src/main.ts` / `src/app.module.ts` / `src/bootstrap/**` / `src/config/**` / `src/database/**`(Docker Smoke 依赖容器在 production 模式下的真实启动行为:config validation、global prefix、logger 初始化、Prisma graceful shutdown)。**不**纳入整个 `src/**`,业务模块改动仍走 `ci.yml` 的 e2e。该 workflow 仍是 non-required check

### Added
- 新增 `.github/workflows/docker-smoke.yml`,作为对 `docs/docker-smoke-test.md` §7 第二轮自动化的最小落地。独立于 `ci.yml`,触发范围限定 `Dockerfile` / `package.json` / `pnpm-lock.yaml` / `prisma/**` / 该 workflow 自身,只在 `pull_request` 触发,不绑 `push: main`。job 串行覆盖:`docker compose up -d postgres` → 创建独立 `app_smoke` DB → host 侧 `pnpm prisma:generate` / `pnpm prisma:deploy` / `pnpm prisma:seed`(跑两次验证幂等)→ `docker build` 生产镜像 → 以 `APP_ENV=production` + `ENABLE_SWAGGER=false` 启动 app 容器(加入 `u-nest-api-starter_default` 网络,host 端口 `13000` → 容器 `3000`)→ 轮询 `/api/health/live` ready → smoke 检查 `/api/health` `/api/health/live` `/api/health/ready` `/api/docs`(404)`/api/docs-json`(404)、登录正确凭据 / 用户不存在 / 错密码三场景(用户不存在与错密码响应体用 `jq -S | diff` 强制完全一致)、`/api/users/me` 无 token / 带 token(断言不含 `passwordHash`)→ `docker stop -t 10` 后断言 exit code = 0 验证 graceful shutdown。`JWT_SECRET` / `SUPER_ADMIN_PASSWORD` 由 step 内 `openssl rand` 临时生成 + `::add-mask::`,不进 GitHub Secrets。失败时统一 dump `docker ps -a` / app container logs / postgres logs 尾部 / `/tmp/smoke-*.json` 响应体;`if: always()` 清理 app container 与 docker compose。**non-required check**(不进 branch protection),失败不阻塞合并,只作早期告警

### Not changed
- `.github/workflows/ci.yml` / `Dockerfile` / `docker-compose.yml` / `prisma/schema.prisma` / `package.json` / `pnpm-lock.yaml` / `src/**` / `docs/docker-smoke-test.md` 一行未动
- 14 个业务接口路径 / 方法 / 入参 / 出参 / 权限标注 / HTTP status / 错误码 / 响应体格式与 v0.1.6 完全一致
- 依赖版本未变更,未引入新依赖

## v0.1.6 - 2026-05-03

Docker smoke test documentation and startup warning cleanup.

### Added
- 新增 `docs/docker-smoke-test.md`,记录基于 v0.1.5 镜像 (HEAD `0826787`) 的第一轮手动 Docker smoke test:production 模式启动、独立 `app_smoke` DB、`prisma migrate deploy` + `prisma db seed`(幂等)、`/api/health` / `/api/health/live` / `/api/health/ready`、production 下 Swagger 关闭(404)、登录三场景统一错误码、`/api/users/me`、非 root + helmet + 优雅关闭 (exit 0) 全部验证通过。文档同时给出第二轮自动化进 CI 的最小方案建议(独立 `.github/workflows/docker-smoke.yml`,只在影响 Dockerfile / Prisma / lockfile 的 PR 触发,非 required check)

### Fixed
- 启动期消除 `[LegacyRouteConverter] Unsupported route path: "/api/*"` WARN(原本打两次)。根因:`nestjs-pino` 的 `LoggerModule.configure()` 默认 `forRoutes: [{ path: '*', method: ALL }]`,与 `app.setGlobalPrefix('/api')` 拼接后变成 `/api/*`,触发 NestJS 11 / path-to-regexp v8 的 legacy 路由自动转换并 warn(LoggerModule 注册 pino-http + bindLoggerMiddleware 两个 middleware,因此 warn 重复一次)。修复:在 `src/bootstrap/logger-options.ts` 显式声明 `forRoutes: [{ path: '*path', method: RequestMethod.ALL }]`,使用 path-to-regexp v8 命名 wildcard 跳过 legacy 转换路径,与 `LegacyRouteConverter` 错误信息推荐写法一致。语义不变,仍匹配全部以 `/api` 开头的请求;无 API / Prisma schema / 依赖 / Dockerfile / CI 变化

### Not changed
- 14 个业务接口路径 / 方法 / 入参 / 出参 / 权限标注 / HTTP status / 错误码 / 响应体格式与 v0.1.5 完全一致
- `prisma/schema.prisma` 与已存在 migration 不变
- 依赖版本未变更,`pnpm-lock.yaml` 未变化
- Dockerfile / `.github/workflows/ci.yml` / 其他 `src/**/*.ts` 未动

## v0.1.5 - 2026-05-03

V1.4 template maintenance — zero lint warnings, Prisma 7 upgrade evaluation, and prisma.config.ts migration.

V1.4-1 Lint 严格模式 — 不新增功能,不改 API / Prisma schema / 依赖版本;只把 `test/` 中遗留的 128 个 `@typescript-eslint/no-unsafe-argument` warning 收敛到 0,并在 `pnpm lint` 启用 `--max-warnings 0` 严格模式,封堵后续 lint 漂移。

### Added
- 新增 `test/helpers/http-server.ts`,提供 `httpServer(app: INestApplication): App` helper,把 `app.getHttpServer()` 的 `any` 返回值集中收敛为 supertest 的 `App` 类型;test 调用点统一改为 `request(httpServer(app))`,消除 125 处 `no-unsafe-argument` warning

### Changed
- `test/**/*.ts` 中所有 `request(app.getHttpServer())` 调用改为 `request(httpServer(app))`,涉及 19 个 e2e spec、`test/contract/openapi.contract-spec.ts`、`test/fixtures/auth.fixture.ts`、`test/helpers/call-endpoint.ts`
- `Object.keys(res.body.data)` 三处改为 `Object.keys(res.body.data as object)`(`users-me` / `users-admin-crud` / `users-admin-list`),在调用点显式收紧 supertest `Response.body: any` 的类型,消除 4 处 `no-unsafe-argument` warning
- `package.json#scripts.lint` 加上 `--max-warnings 0`,本地与 CI 共用同一入口;`.github/workflows/ci.yml` 的 `Lint` 步骤新增注释说明严格模式来源,避免未来误删 flag
- `docs/v1.3-plan.md` §6 标记 `[done — V1.4-1]`
- V1.4-2 Prisma 7 升级评估:新增 `docs/v1.4-prisma7-evaluation.md`,基于 Prisma 官方升级指南与本仓库源码 / Dockerfile / CI 触点,系统评估 Prisma 6.19.3 → 7.x 的影响面、风险矩阵、推荐升级步骤、回滚方案,以及拆分 PR 建议;结论:**当前不建议升级**(`prisma-client-js` → `prisma-client` generator 迁移会联动改写 Dockerfile §80-§150 的 prod 子集裁剪逻辑,投入产出比低,7.x 仍兼容 deprecated generator);唯一可考虑现在做的最小化收敛是 `package.json#prisma` → `prisma.config.ts` 迁移(独立任务,不在本评估内执行)。本任务**不升级依赖**、不改运行时代码、不动 Dockerfile / CI / Prisma schema
- V1.4-3 Prisma 配置迁移到 `prisma.config.ts`(对应评估文档 §6.1 / §7 PR A):新增 `prisma.config.ts`(`defineConfig({ migrations: { seed: 'tsx prisma/seed.ts' } })`),删除 `package.json#prisma` 配置块;为还原 Prisma CLI 检测到 `prisma.config.ts` 后**关闭**自动 `.env` 加载的副作用,在 config 顶部 `import 'dotenv/config'`(`dotenv` 已是 devDependency,无新增依赖,lockfile 无漂移)。仍在 Prisma 6.19.3,**不升级 prisma / @prisma/client**,**不改 schema.prisma**(datasource / generator 仍是 schema 内事实源),不改 Dockerfile / CI / 运行时代码。验证:`pnpm prisma:generate` / `prisma:deploy` / `prisma:seed`(含幂等)三命令均输出 `Loaded Prisma config from prisma.config.ts.` 并按预期完成

### Not changed
- 14 个业务接口路径 / 方法 / 入参 / 出参 / 权限标注 / HTTP status / 错误码 / 响应体格式与 v0.1.4 完全一致
- `prisma/schema.prisma` 与已存在 migration 不变
- 依赖版本未变更(未升级 Prisma 6 → 7,未引入新依赖)
- `pnpm-lock.yaml` 未变化(V1.4-3 使用的 `dotenv` 已是 devDependency)
- 业务模块未新增,RBAC / refresh token / 文件上传 Provider 仍未实现
- `eslint.config.mjs` 规则未调整(未对 `test/**/*.ts` 关闭 `no-unsafe-argument`,而是从源头补类型)
- Prisma Client generator 仍是 `prisma-client-js`(deprecated 但兼容,未迁到 `prisma-client`)
- Dockerfile / `.github/workflows/ci.yml` / `src/**/*.ts` / `prisma/seed.ts` 一行未动

## v0.1.4 - 2026-05-03

V1.3 Contract Hardening — 不新增业务功能,不修改 API 响应格式,不改 Prisma schema;只把"模板的契约面"(API schema、错误码 ↔ HTTP status、权限策略)从"E2E 顺带覆盖"升级为"独立断言 + 自动化 CI 护栏"。

V1.3 子任务一览:

- **V1.3-1** users.policy 单测矩阵(3×3 角色 × 4 函数 = 36 个判定点),`UsersService.findOne()` 拆出 `canViewUser` 语义
- **V1.3-2** BizCode 元属性单测断言(key 命名 / code 段位 / message / httpStatus 全量遍历)
- **V1.3-3** OpenAPI 快照测试(14 路由白名单 + 11 核心 DTO + `paths` / `components.schemas` 两段快照)
- **V1.3-4** 错误响应 Swagger schema 显式化(`ApiBizErrorResponse` 装饰器 + 14 路由错误码 schema 全量补全)
- **V1.3-5** CI 跑 unit + contract tests(`pnpm test` / `pnpm test:contract` 进 `Lint / Typecheck / E2E` job)

### Added
- V1.3-1 Contract Hardening:新增 `src/modules/users/users.policy.spec.ts`,以 `it.each` 表格化覆盖 `canViewUser` / `canManageUser` / `canCreateRole` / `canChangeRole` 的 3×3 角色矩阵(36 个判定点)
- 新增 `test/jest-unit.config.ts` 与 `pnpm test` 脚本(只跑 `src/**/*.spec.ts`,不启动 NestJS / 不连库),与 `pnpm test:e2e` 解耦
- `tsconfig.json` 排除 `src/**/*.spec.ts`,避免 spec 文件被 `nest build` 打入 `dist/`
- V1.3-2 Contract Hardening:新增 `src/common/exceptions/biz-code.constant.spec.ts`,`Object.entries(BizCode)` 遍历断言每个条目的 key(大写 SNAKE_CASE)、`code`(正整数 + 全局唯一 + 落在已分段范围内)、`message`(非空 string + 已 trim)、`httpStatus`(合法 `HttpStatus` 枚举值);避免新增 BizCode 漏掉基本约束
- V1.3-3 Contract Hardening:新增 `test/contract/openapi.contract-spec.ts` + Jest 原生快照,从 `/api/docs-json` 抓取 OpenAPI v3 文档并锁定:14 个业务接口 + 3 个健康检查 + auth/login 共 14 条路由的存在性、HTTP 方法集合与白名单一致(防漏增 / 漏删)、核心 11 个 DTO schema 仍存在、`paths` 与 `components.schemas` 两段快照保护字段级漂移
- 新增 `test/jest-contract.config.ts` 与 `pnpm test:contract` 脚本(复用 e2e 的 globalSetup,串行执行,与 `pnpm test:e2e` 解耦),首次快照已入 git;后续 schema 变更需显式 `pnpm test:contract -u` 在 PR diff 中 review
- V1.3-4 Contract Hardening:新增 `ApiBizErrorResponse(...bizCodes)` 装饰器(`src/common/decorators/api-response.decorator.ts`),按 `httpStatus` 自动分组、合并相同 status 下的多个业务码到一条 `@ApiResponse`,响应 schema 结构与 `AllExceptionsFilter` 真实输出 `{ code, message, data: null }` 一致,`code.enum` 列出全部可能业务码、`description` 列出每个 code 的语义
- 给所有 controller 方法补全错误响应 Swagger 装饰器:`auth/login`(400/401/429,替换原裸 `@ApiResponse`)、`health/ready`(500)、`users/me` 系列(401 / 400)、`users` 管理系列(覆盖 400/401/403/404/409 + `FORBIDDEN_ROLE_OPERATION`/`CANNOT_OPERATE_SELF`/`LAST_SUPER_ADMIN_PROTECTED`/`USER_NOT_FOUND`/`USERNAME_ALREADY_EXISTS`/`EMAIL_ALREADY_EXISTS` 等业务码)
- 同步刷新 `test/contract/__snapshots__/openapi.contract-spec.ts.snap`,新增的错误响应 schema 进入快照保护范围
- V1.3-5 Contract Hardening:`.github/workflows/ci.yml` 在 `Lint / Typecheck / E2E` job 内新增 `Run unit tests`(`pnpm test`)与 `Run contract tests`(`pnpm test:contract`)两步,顺序为 lint → typecheck → build → db setup → prisma:deploy → unit → contract → e2e。补全 V1.3-1(`users.policy.spec.ts`)/ V1.3-2(`biz-code.constant.spec.ts`)/ V1.3-3 + V1.3-4(OpenAPI 契约快照含错误响应 schema)在 CI 内的真实护栏覆盖

### Changed
- 同步项目版本号到 `0.1.4`(`package.json#version` + Swagger `setVersion('0.1.4')`)
- `UsersService.findOne()` 改为通过新增的 `assertCanViewUser` 走 `canViewUser` 策略;管理 / 删除 / 重置密码 / 改角色 / 改状态等"修改类"操作继续走 `canManageUser`。当前两者判定相同,仅区分语义,API 行为不变

### Not changed
- 14 个业务接口路径 / 方法 / 入参 / 出参 / 权限标注 / HTTP status / 错误码 / 响应体格式与 v0.1.3 完全一致
- `prisma/schema.prisma` 与已存在 migration 不变
- 业务模块未新增,RBAC / refresh token / 文件上传 Provider 仍未实现

## v0.1.3 - 2026-05-03

V1.2 模板收敛 — 不新增业务功能,不修改 API 响应格式,不做破坏性数据库变更;只提升长期可维护性、AI 二开稳定性和文档可读性。

### Changed
- 同步项目版本号到 `0.1.3`(`package.json#version`、Swagger `setVersion('0.1.3')`)
- 拆分 `src/app.module.ts`:logger / request-id / throttle 配置抽到 `src/bootstrap/`(`logger-options.ts` / `request-id.ts` / `throttle-options.ts`),`AppModule` 仅保留模块注册与全局 Guard 注册
- 新增 `src/modules/users/users.policy.ts`:集中 `canViewUser` / `canManageUser` / `canCreateRole` / `canChangeRole` 4 个纯函数;`UsersService` 不再散落角色判断,SUPER_ADMIN 结构性不变式(自我保护、最后一个 SUPER_ADMIN 保护)仍由 service 内事务保障
- 拆分 `README.md`:复杂内容迁移到 `docs/development.md` / `docs/testing.md` / `docs/deployment.md` / `docs/security.md`,`README.md` 仅保留项目定位、快速启动、路由总览、常用命令、文档入口
- `docs/security.md` 显式记录:当前版本支持软删除但不提供 restore 接口、误删恢复需 DBA 人工处理、未来 restore 接口契约预定义为 `PATCH /api/users/:id/restore`(仅 SUPER_ADMIN);token 吊销不实现 refresh token / Redis blacklist,仅记录未来 `tokenVersion` 升级路径
- 新增 `FINAL_REPORT.md`:本轮变更文件 / 原因 / 验收 / 遗留风险 / 建议 commit 命令
- 新增 `docs/v1.3-plan.md`:V1.3 Contract Hardening Plan(仅文档,不执行)

### Not changed
- API 响应格式、HTTP status、错误码、Swagger schema 与 v0.1.2 完全一致
- `prisma/schema.prisma` 与已存在 migration 不变
- 14 个业务接口路径 / 方法 / 入参 / 出参 / 权限标注与 v0.1.2 完全一致
- `.env.example` / `Dockerfile` / `.dockerignore` / `docker-compose.yml` / `.github/workflows/` 未触碰
- E2E 全量 19 spec / 162 用例继续通过(本机 ~15.6s)

## v0.1.2 - 2026-05-03

V1.1.1 工程收口修补 — 不引入新业务,不重构架构,只对 V1.1 之后暴露的版本一致性、生产迁移命令、CI 闭环、lint/typecheck 覆盖范围、README 残留表述做最小修补,并作为 patch release 正式发布。

### Fixed
- 同步项目版本号到 `0.1.2`(`package.json#version`、Swagger `setVersion('0.1.2')`),与本次 `v0.1.2` patch release 对齐
- 新增 `pnpm prisma:deploy` 脚本,作为生产数据库迁移固定入口(等价 `prisma migrate deploy`);保留 `pnpm prisma:migrate` 作为开发态入口
- CI 在 `typecheck` 之后、E2E 之前新增 `pnpm build` 步骤,显式验证 `tsconfig.build.json` 与 nest 构建产物链路
- CI 新增独立 `docker-build` job,验证多阶段 `Dockerfile` 在 CI 环境可成功构建出生产镜像(不做容器启动 / smoke test)
- CI 在数据库初始化之后、E2E 之前显式跑一次 `pnpm prisma:deploy`,验证生产迁移命令可执行(已迁移环境下为 no-op)
- `pnpm lint` 覆盖范围扩展为 `src/**/*.ts` + `test/**/*.ts` + `prisma/**/*.ts`
- `pnpm typecheck` 在原有 `tsconfig.json` 基础上追加 `test/tsconfig.test.json`,让测试代码也进入类型检查
- ESLint 显式 `project` 列表覆盖 `src` / `test` / `prisma` 三处源码;新增 `prisma/tsconfig.eslint.json` 仅供 ESLint 解析使用,不进入运行时构建链路;规则写入 `ARCHITECTURE.md` §11.7
- README 修正 V1.1 之后已不再准确的表述(Docker 用途、生产迁移策略、`prisma:deploy` 入口、runner 镜像不含 Prisma CLI 的说明)
- 新增 `CHANGELOG.md` 跟踪发布历史

## v0.1.1

- V1.1 engineering hardening
- Added GitHub Actions CI(lint / typecheck / E2E,基于 `docker compose` 启动 `postgres:16-alpine`)
- Added 多阶段 Dockerfile(`deps` → `builder` → `runner`,`node:22-alpine`,以非 root 用户运行)
- 接入结构化日志(`nestjs-pino`)与请求 ID(`x-request-id`,`cuid()` 兜底生成),敏感字段日志显示为 `[REDACTED]`
- 优雅关闭(`app.enableShutdownHooks()` + `PrismaService.onModuleDestroy()`)
- 健康检查分层(`/api/health` / `/api/health/live` / `/api/health/ready`,基于 `@nestjs/terminus`)
- helmet HTTP 安全头(Swagger UI 局部禁用 CSP)
- 登录接口限流(`@nestjs/throttler` 内存 storage,默认 IP 维度 5 次 / 60 秒)
- 扩展 E2E 覆盖(当前 19 spec / 162 用例)

## v0.1.0

- v1 基础闭环:NestJS + Prisma + PostgreSQL + Docker Compose + Swagger + JWT 登录 + 用户 CRUD + 简单角色权限 + 统一异常与返回格式
