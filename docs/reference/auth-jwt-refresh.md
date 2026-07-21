# 鉴权 · 密码 · refresh token(P0-E 行为冻结)(reference · 触碰才读)

> Harness 2.0 细则层:承接 harness v1 `AGENTS.md` §8 / §9 **原文逐字搬家(零放宽;唯一机械改写=相对链接前缀)**;恒读入口与速查见根 [`AGENTS.md`](../../AGENTS.md),原文快照 [`archive/harness-v1/AGENTS.md`](../archive/harness-v1/AGENTS.md)。
> 机器锁定:auth e2e(JwtPayload 字段集硬断言 / 防枚举四场景 / §7.5 反向锁)+ throttler e2e + P0-E 冻结评审稿。

## 8. 权限与鉴权

### Guard 全局注册 + `@Public()` / `@Roles(...)` 互斥

- `JwtAuthGuard` + `RolesGuard` 通过 `AppModule.providers` 中 `APP_GUARD` 全局注册,顺序固定 `JwtAuthGuard` → `RolesGuard`(先验登录,再验角色);**禁止在 controller 上 `@UseGuards(...)`**
- 未标 `@Public()` 默认要登录;`@Public()` 与 `@Roles(...)` 互斥
- **判权单轨现状(2026-06-11 Slow-4 收口,冻结评审稿 [`docs/archive/reviews/slow4-rbac-business-face-review.md`](../archive/reviews/slow4-rbac-business-face-review.md))**:全仓活跃 `@Roles(...)` 使用点 = 0——管理面 / 配置面 / 业务面判权一律下沉 Service 层 `rbac.can('<code>')`(SUPER_ADMIN 短路;拒权统一 `RBAC_FORBIDDEN` 30100),controller 入口仅 JwtAuthGuard;`RolesGuard` 机制与 `@Roles` 装饰器**保留在 Guard 链**(防御性兜底,不删);新 endpoint **不**再标 `@Roles`(管理面默认 R 模式,沿 [`docs/ai-harness/RBAC_MAP.md §6`](../ai-harness/RBAC_MAP.md));三层 `Role` enum 仍是身份层事实(SA 短路 / §13 用户管理边界 / App 准入),**不**因此废除
- `RolesGuard` 看到 `@Roles(...)` 但 `request.user` 为空 → **拒绝访问**(抛 `BizException(BizCode.UNAUTHORIZED)`),不要因没拿到 user 就放行
- `JwtAuthGuard.canActivate` 用 `reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [handler, class])`,命中 `@Public()` 直接返 true,否则走 `super.canActivate`;`@Public()` 装饰器 `SetMetadata(IS_PUBLIC_KEY, true)`,常量与装饰器同文件导出

### 登录

- 密码登录(`POST /api/auth/v1/login`)入参固定 `username + password`(不支持 email 登录 / 不支持在本端点混入手机号或验证码);**验证码(OTP)登录为独立端点** `POST /api/auth/v1/login-sms`(2026-06-11 解锁,冻结评审稿 [`docs/archive/reviews/queue-b-otp-birthday-infra-review.md`](../archive/reviews/queue-b-otp-birthday-infra-review.md);防枚举统一 24010,会话签发与密码登录同构),密码登录契约本身零变化
- **微信小程序登录为第三个独立认证端点** `POST /api/auth/v1/login-wechat`(2026-06-12 解锁,沿 login-sms 范式,冻结评审稿 [`docs/archive/reviews/wechat-mini-login-review.md`](../archive/reviews/wechat-mini-login-review.md)):`{code}`→code2session→已绑 `createSession` 同构签发 / 未绑返 `bindingRequired:true`;**绑定锚点 = 手机短信**(pre-auth `wechat-bind{,/send-code}` 验 `SmsPurpose.WECHAT_BIND` 码,防枚举沿 login-sms 泛化 200 + 统一 24010);`User.openid` 唯一含软删占用,解绑唯一路径 = admin 清除;appSecret/session_key 是 L3(session_key 不存储即弃),openid 非 L3 但不滥回显(响应/audit 一律掩码);密码登录契约零变化
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

### RBAC permission resolution 每请求直读 PostgreSQL

[`RbacService`](../../src/modules/permissions/rbac.service.ts) 的 `getUserPermissionCodes()` / `can()` / `judge()` 每次按当前时刻读取在期 GLOBAL `RoleBinding → RolePermission → Permission`，不保留跨请求 Map / TTL，也不依赖提交后 invalidate 正确性链；多实例在 grant / revoke 提交后的下一次请求直接读取当前数据库事实。`POST /api/system/v1/rbac/reload` 仅兼容保留 all / user / role 三档输入校验与 `{ reloaded: true }` 响应，不再清理内部缓存状态。该行为同样不替代 `JwtStrategy.validate` 每请求查身份有效性；禁止恢复跨请求 permission cache 或引入 Redis / 外部 KV。


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
- `POST /api/admin/v1/users` **必须由调用方传 `password`**,禁止后端生成默认密码或留空
- `PUT /api/admin/v1/users/:id/password` 接收 `ResetUserPasswordDto { newPassword }`,**不需要 `oldPassword`**,但必须走 `assertCanManageUser`
- 管理员重置密码后**不主动吊销 access token**(access ≤ 15m 自然过期);**必须主动撤销目标用户全部 refresh token**(详 §9 P0-E 联动撤销五场景);如需立即阻断 access token,由管理员把目标用户 `status` 改 `DISABLED`(经每请求查库即时生效)
- **本人自助改密只能通过独立接口** `PUT /api/app/v1/me/password`(原 `/api/users/me/password` 于 v0.13.0 落地、Route B 终态迁至 App surface;行为冻结于 [P0-D 评审稿](../archive/reviews/first-release-p0d-change-my-password-review.md));**不得**在 `PATCH /api/app/v1/me/profile` 或其他资料更新接口里夹带"顺手改密码"逻辑;管理员重置他人密码接口 `PUT /api/admin/v1/users/:id/password` 契约保持不变
- 本人改密接口入参固定 `ChangeMyPasswordDto { oldPassword, newPassword }`(`oldPassword` 必填,与管理员重置无 `oldPassword` 的语义对称区分);`newPassword` 沿 `ResetUserPasswordDto.newPassword` 范式(至少 8 位 + 数字 + 字母);严格白名单,**禁止**夹带 `username` / `email` / `role` / `status` / `passwordHash` / `id` 任何其他字段
- 本人改密新增 BizCode:`OLD_PASSWORD_INVALID = 10005`(HTTP 401)、`NEW_PASSWORD_SAME_AS_OLD = 10006`(HTTP 400);**禁止**复用 `LOGIN_FAILED` 或 `BAD_REQUEST` 兜底语义
- 本人改密接口必须挂 `@PasswordChangeThrottle()`(IP 5/60 秒;沿 §17 `@nestjs/throttler` PostgreSQL shared storage,**禁止** Redis / 本地 Map fallback;limit / ttl 从 `src/config/app.config.ts` 注入,**禁止**硬编码在装饰器)
- 本人改密成功必须写 audit `AuditLogEvent.UserPasswordChangedSelf`;**禁止**把 `oldPassword` / `newPassword` / `passwordHash` 任何明文或 hash 写入 audit
- 本人改密成功后**不主动吊销 access token**;**必须主动撤销该用户全部 refresh token**(详 §9 P0-E 联动撤销五场景);`tokenVersion` **不做**,沿 §1 B 档
- 用户被 `DISABLED`(`PATCH /api/admin/v1/users/:id/status` → `DISABLED`)或被软删(`DELETE /api/admin/v1/users/:id`)时,**必须**主动撤销目标用户全部 refresh token(详 §9 P0-E 联动撤销五场景);access token 由 `JwtStrategy.validate` 每请求查库即时失效
- 本人改密接口**不做**首次登录强制改密、忘记密码 / 邮箱找回、user-member 绑定能力;这些越界诉求出现时必须暂停说明

### P0-E refresh token 鉴权铁律(v0.14.0 落地,行为冻结)

> 本子节是 P0-E refresh token / logout / logout-all 闭环已落地后的不可变行为约束(v0.14.0 发布 2026-05-17T19:16:06Z)。详细设计冻结于 [`docs/archive/reviews/first-release-p0e-refresh-token-review.md`](../archive/reviews/first-release-p0e-refresh-token-review.md);冲突时以评审稿 + 当前代码为准,本节让步。

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
- **rotation always**:每次 `POST /api/auth/v1/refresh` 必发新 token + 旧 refresh 同事务内标 `rotatedAt + revokedAt + replacedById`
- **absolute expiration**:`expiresAt` 不延长,严格继承 family 首个 token;refresh TTL `90d`;达到 `refreshExpiresAt` 后必须重新登录(`POST /api/auth/v1/login`),refresh 接口对已过期 family 返 `REFRESH_TOKEN_INVALID=10007`
- **reuse detection 触发 family revoke**:收到 `rotatedAt != null` 的 row(旧 raw 被重放)→ 同事务内 `updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: now(), revokedReason: 'family-revoked' } })`,然后抛 `REFRESH_TOKEN_INVALID`

**logout 行为契约**:
- `POST /api/auth/v1/logout` 走 `@Public()`(refresh token 自身即凭证),只撤销**当前** refresh token(`revokedReason='logout'`,其他 rotation 链 token 不动);**幂等**(不存在 / 已撤销 / 已过期 → 仍返 200,沿 RFC 7009 §2.2),**不**抛业务码;access token 若随头传入**不**校验、**不**消费、**不**吊销
- `POST /api/auth/v1/logout-all` 走 `JwtAuthGuard`,撤销当前 user 全部未过期且未撤销的 refresh token(`updateMany revokedReason='logout'`);返 `{ revokedCount }`

**联动撤销五场景**(沿 §9 主条目;`updateMany` 必须**同事务**内与主写操作执行,沿 `prisma.$transaction` 范式):本人改密 → `'self-password-change'`(audit `password.change.self`,`extra.refreshTokensRevoked: count` 必写)/ 本人短信验证码重置(找回密码,pre-auth)→ `'self-password-reset'`(2026-06-11,冻结评审稿 [password-reset-by-sms-review](../archive/reviews/password-reset-by-sms-review.md);audit `password.reset.by-sms`,`extra.refreshTokensRevoked: count` 必写)/ 管理员重置 → `'admin-password-reset'`(audit `password.reset.by-admin`,`extra.refreshTokensRevoked: count` 必写)/ 用户禁用 → `'admin-disable'`(**2026-07-13 第六刀推翻 D-PR3-2**:`UsersService.updateStatus` 必须同事务写 `user.status.update` before/after audit;**2026-07-14 第七刀补齐第二条触发路径**:`PATCH admin/v1/members/:id/account/status` 必须在同事务写 `member.account.status-change` before/after audit,详见 `members.service.ts` `updateAccountStatus`)/ 用户软删 → `'admin-delete'`(**2026-07-13 第六刀推翻 D-PR3-2**:`UsersService.softDelete` 必须同事务写 `user.soft-delete` before/after audit)

**access token 行为锁定**:
- **不主动吊销**;依赖 `JWT_EXPIRES_IN=15m` 自然过期 + `JwtStrategy.validate` 每请求查库阻断 `DISABLED` / 软删用户
- access token blacklist / JWT revoke list **不做**(沿 §1 C 档);未来"改密后所有 access 立即失效"诉求出现时沿 §1 B 档 `tokenVersion` 路径单独评审
- e2e `users-change-my-password.e2e-spec.ts §7.5` "改密后旧 access token 仍可调 `/me`" 反向锁定断言**保留不破**

**限流契约**:
- 全部 10 个命名 throttler 共用 PostgreSQL storage，并以 `(throttlerName,key)` 唯一行物理隔离；保留包默认 IP tracker / hash key，DB/storage 异常 fail-closed 为 50000，绝不回退进程内 Map
- IP tracker 只读取全局固化后的 Express `req.ip`：`applyGlobalSetup` 先把 `app.trustedProxyCidrs` 设置为原生 `trust proxy`，按 X-Forwarded-For 从右向左在首个不可信 hop 截断；Helmet 后、CORS preflight/pino/throttler/controller 前的唯一 normalizer 再把 mapped IPv4 归 native、IPv6 归 lowercase 压缩，并将非法 token/getter 异常或配置非 `none` 时仍落在 trusted CIDR 的最终 identity 统一收口为 40000。只支持直接 socket + XFF；不把 `Forwarded` / `X-Real-IP` 当身份来源，也不自行拆解 XFF
- IP 是限流、审计与成本防刷维度，不是鉴权身份。production/smoke 只能显式配置实际直连 backend socket 的精确代理 CIDR；`none` 仅适用于 backend 真实直连，反代承流时使用 `none` 会把全部 client 汇入 proxy IP，造成共享 429 与审计/成本证据污染。禁止 `true`、hop number、临时全信以及用整个 Pod/RFC1918 网段替代真实拓扑
- `POST /api/auth/v1/refresh`:独立 throttler `'refresh'`,IP **30 次 / 60 秒**;装饰器 `@RefreshThrottle()`(纯 metadata,limit / ttl 在 `throttle-options.ts` 从 `app.config.ts` 注入)
- `POST /api/auth/v1/logout`:**无限流**(刻意;避免攻击者吃光合法 logout 配额)
- `POST /api/auth/v1/logout-all`:复用 `'password-change'` throttler(IP 5/60);沿"高危操作低频限流"语义
- 三 throttler(`default` / `password-change` / `refresh`)**物理隔离**:登录失败爆破不消耗 refresh / logout-all 配额,反之亦然
- 命中走 `BizException(BizCode.TOO_MANY_REQUESTS)` + HTTP 429;**不暴露** `Retry-After` / `X-RateLimit-*` 头(沿 [`src/bootstrap/throttle-options.ts`](../../src/bootstrap/throttle-options.ts) `setHeaders: false`)

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
- ❌ refresh token 失败码细分 / OAuth 第三方登录(微信小程序登录已于 2026-06-12 解锁为第三个独立认证端点,见 §8「登录」;其余第三方登录仍不做)
