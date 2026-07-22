# 安全说明

> 本文记录当前版本已落地的安全策略,以及刻意未实现、留待 [`ARCHITECTURE.md`](../ARCHITECTURE.md) §9 升级条件触发后再做的能力的**升级路径**。
>
> AI 二开时务必读完本文,不得擅自把"升级路径"段落里的能力直接落到代码里。

---

## 已落地策略

| 能力 | 实现位置 | 说明 |
|---|---|---|
| 防账号枚举 | `auth.service.ts` | 四场景(`username` 不存在 / `password` 错 / 已禁用 / 已软删除)统一 `LOGIN_FAILED` + HTTP 401,`username` 不存在路径仍跑 `bcrypt.compare(dummyHash)` 抹平 timing |
| 密码哈希 | `auth.service.ts` / `users.service.ts` | `bcryptjs`,salt rounds=10;响应 DTO 永不含 `passwordHash`(`userSafeSelect` 排除) |
| 字段白名单 | `*.dto.ts` + 全局 `forbidNonWhitelisted: true` | 入参 DTO 不声明的字段直接 422;`UpdateMyProfileDto` 仅 `nickname/avatarKey`,`UpdateUserDto` 不接受 `role/password/status` |
| 角色策略集中 | `src/modules/users/users.policy.ts` | 4 个纯函数(`canViewUser` / `canManageUser` / `canCreateRole` / `canChangeRole`),双层校验:Guard 管入口、policy 管业务 |
| 自我保护 | `users.service.ts` | 自删 / 自禁 / 自改角色一律 `CANNOT_OPERATE_SELF` |
| 最后一个 SUPER_ADMIN 保护 | `users.service.ts` `assertNotLastSuperAdmin` | 在事务内 `count` 剩余活跃 super admin,< 1 抛 `LAST_SUPER_ADMIN_PROTECTED` |
| helmet HTTP 安全头 | `bootstrap/apply-global-setup.ts` | 默认开启,Swagger UI 局部放开 CSP |
| 登录限流 | `@nestjs/throttler` PostgreSQL shared storage | 10 个命名实例共用数据库并以 `(throttlerName,key)` 物理隔离；登录实例仅作用于 `POST /api/auth/v1/login`,IP 维度 5 次 / 60 秒(`LOGIN_THROTTLE_LIMIT` / `LOGIN_THROTTLE_TTL_SECONDS` 可配),不暴露阈值；DB/storage 异常 fail-closed 为 50000,零本地 Map fallback |
| 可信代理身份边界 | `config/app.config.ts` + `bootstrap/apply-global-setup.ts` | 单一 `APP_TRUSTED_PROXY_CIDRS=none\|CIDR,...`；只收 canonical network CIDR，production/smoke 缺失或非法即启动失败。Express 原生 XFF 右向左首个不可信截断，`none` 映射 `trust proxy=false`且仅适用于真实直连；反代下 `none` 会把全部 client 汇入 proxy IP。全局边界先建立 request ID；紧随 Helmet 的 normalizer 在 CORS preflight/pino/throttler/controller 前把 mapped IPv4 归 native、IPv6 归 lowercase 压缩，并把非法 token/getter 异常或配置非 `none` 时仍为 trusted proxy 的最终 identity 统一拒绝为 40000。拒绝响应保留 request ID/Helmet/允许 Origin CORS，只写固定 event+reqId 的安全日志，不进入普通 request serializer。禁止 boolean/hop/wildcard/默认全信，不把 `Forwarded` / `X-Real-IP` 当身份来源。IP 仅用于限流、audit、SMS/OCR 防刷取证，不是鉴权身份，正常 HTTP 日志按下方路径 redact |
| HTTP 日志最小化 + 敏感字段 redact | `bootstrap/logger-options.ts` | 自动 request 日志只保留 method + pathname，query/originalUrl/headers 不进入应用日志；结构化敏感字段显示为 `[REDACTED]`,**不仅仅是长度截断** |
| 启动强校验 | `config/app.config.ts` + `prisma/seed.ts` | `APP_ENV=production` 下拒绝默认值的 `JWT_SECRET` / `APP_CORS_ORIGIN=*` / `SUPER_ADMIN_PASSWORD` / `SUPER_ADMIN_USERNAME=admin`；production/smoke 必须显式配置可信代理 CIDR或 `none` |
| 本人自助改密 | `controllers/app-me.controller.ts` + `users.service.ts` + `audit-logs.service.ts` | `PUT /api/app/v1/me/password`(`ChangeMyPasswordDto { oldPassword, newPassword }`);严格事务内顺序:`bcrypt.compare(oldPassword)` → 严格 `===` 比较 oldPassword/newPassword → `bcrypt.hash(newPassword)` → 撤销该 user 全部活跃 refresh(`self-password-change`)→ 写 audit log `password.change.self`;响应 `userSafeSelect`(永不含 `passwordHash`);旧 access 不主动吊销、≤15m 自然过期 |
| 改密接口防爆破 | `@PasswordChangeThrottle` + `throttler-biz.guard.ts` | 独立 throttler 实例 `password-change`,与登录限流物理隔离;IP 维度 5 次 / 60 秒(`PASSWORD_CHANGE_THROTTLE_LIMIT` / `PASSWORD_CHANGE_THROTTLE_TTL_SECONDS` 可配);共用 PostgreSQL storage(不引入 Redis);不暴露阈值 / `Retry-After` / `X-RateLimit-*` |
| refresh token / logout / logout-all(P0-E PR-3 + identity session P0 PR2) | `auth.service.ts` + `refresh-token.util.ts` + `audit-logs.service.ts` | `POST /api/auth/v1/refresh`(rotation always + family revoke + absolute expiration)/ `POST /api/auth/v1/logout`(任一可识别且未过期 row〔含 rotated ancestor〕幂等撤销所属 family 全部活跃未过期 token)/ `POST /api/auth/v1/logout-all`(撤销该 user 全部 refresh);`refresh_tokens` 表只存 `sha256(raw).hex`,明文绝不入库;refresh 失败 4 子原因统一 `REFRESH_TOKEN_INVALID=10007`(不拆 EXPIRED/REVOKED/REPLAY);**其他 family 与 access token 不受 logout 影响**,access 仍不主动吊销;TTL `access 15m / refresh 90d` |
| refresh 接口防爆破 | `@RefreshThrottle` + `throttler-biz.guard.ts`(P0-E PR-3)| 独立 throttler 实例 `refresh`,与登录 / 改密物理隔离;IP 维度 30 次 / 60 秒(`REFRESH_THROTTLE_LIMIT` / `REFRESH_THROTTLE_TTL_SECONDS` 可配,放宽允许多 tab 并发 refresh);共用 PostgreSQL storage;不暴露阈值头 |
| 手机号绑定发码 / 验码防爆破(SMS 基础设施 T3,2026-06-10;冻结评审稿 [`sms-verification-infra-review.md`](archive/reviews/sms-verification-infra-review.md) D-SMS-6 / E-23) | `@SmsSendThrottle` / `@SmsVerifyThrottle` + `throttler-biz.guard.ts` | 第 4 / 5 throttler 实例 `sms-send` / `sms-verify`,与登录 / 改密 / refresh 物理隔离:`POST /api/app/v1/me/phone/send-code` IP 5 次 / 60 秒(`SMS_SEND_THROTTLE_LIMIT` / `SMS_SEND_THROTTLE_TTL_SECONDS` 可配);`PUT /api/app/v1/me/phone` IP 10 次 / 60 秒(`SMS_VERIFY_THROTTLE_LIMIT` / `SMS_VERIFY_THROTTLE_TTL_SECONDS` 可配);防刷三层的 IP 层(同号 60s 间隔 + 同号自然日上限在 SmsCodeService DB 层);共用 PostgreSQL storage;不暴露阈值头 |
| 身份绑定 step-up + refresh 撤销(identity session P0 PR1,2026-07-17) | `auth/identity-step-up.service.ts` + `users.service.ts` | 现有 AuthController 新增 password/SMS/WeChat 三因子签发与 SMS 发码共 4 个 JWT-protected route；proof 固定 5 分钟、action 仅 `PHONE_BIND/WECHAT_BIND`，从 JWT secret 经 HKDF-SHA256 派生 signing/snapshot 两域并用专用 audience。两个 App PUT 在 parameterized `User FOR UPDATE` 锁内重算 snapshot；真实 phone/wechat 变更与 refresh 全撤销、既有 bind/rebind audit 同事务，reason 为 `self-phone-identity-change` / `self-wechat-identity-change`；同目标 no-op 不撤销不写变更 audit。proof 失败统一 10008，因子未绑定 10009；旧 access 不主动吊销 |
| 改密 / 重置 / 身份换绑 / 禁用 / 软删联动撤销 refresh(P0-E PR-3 + identity session P0 PR1;共 7 场景) | `users.service.ts` / `auth/password-reset.service.ts` / `auth/login-wechat.service.ts` 同事务 `tx.refreshToken.updateMany` | 本人改密 → `self-password-change` / 本人短信重置 → `self-password-reset` / 管理员重置 → `admin-password-reset` / 本人换手机号 → `self-phone-identity-change` / 本人换微信(含 pre-auth bind/rebind)→ `self-wechat-identity-change` / 用户被禁用 → `admin-disable` / 用户软删 → `admin-delete`;**access token 仍不主动吊销**(15m 自然过期 + `JwtStrategy.validate` 每请求查库阻断 DISABLED / 软删);**JWT payload 严格 zero drift** `{ sub, username }` |
| 找回密码防枚举(2026-06-11;冻结评审稿 [`password-reset-by-sms-review.md`](archive/reviews/password-reset-by-sms-review.md) §4) | `auth/password-reset.service.ts` + `@PasswordResetThrottle()` | `POST /api/auth/v1/password-reset{,/send-code}` 两公开端点:四种无效号码场景(不存在 / 未绑定 / 禁用 / 软删)send-code 返回**完全相同**泛化 200 且零留痕;reset 一切失败统一 `SMS_CODE_INVALID=24010`;10006 不消费验证码且仅对已验码者可达(防密码 oracle);第 6 throttler 实例 IP 3/60s(`PASSWORD_RESET_THROTTLE_LIMIT` / `PASSWORD_RESET_THROTTLE_TTL_SECONDS` 可配);残余侧信道与图形码重启条件见评审稿 R-1 / §9 |
| OTP(验证码)登录防枚举(2026-06-11;冻结评审稿 [`queue-b-otp-birthday-infra-review.md`](archive/reviews/queue-b-otp-birthday-infra-review.md) §5) | `auth/login-sms.service.ts` + `@LoginSmsThrottle()` | `POST /api/auth/v1/login-sms{,/send-code}` 两公开端点(密码登录的**并行方式**,[`auth-jwt-refresh`](reference/auth-jwt-refresh.md) 行已解锁改写、密码登录契约零变化):send-code 四无效场景同泛化 200 零留痕;登录一切失败统一 24010(**不用 10004**,两套防枚举体系各自闭合);会话签发经 `AuthService.createSession` 与密码登录同构(同 refresh family / lastLoginAt;audit `auth.login.sms` 掩码);第 7 throttler 实例 IP 5/60s(`LOGIN_SMS_THROTTLE_LIMIT` / `LOGIN_SMS_THROTTLE_TTL_SECONDS` 可配) |
| 短信验证码静态库防护(2026-07-14 第七刀) | `sms-code.service.ts` + `sms-code-hash.util.ts` | 入库值固定为 `HMAC-SHA256(pepperKey, phone:purpose:code)` 的 64 字符 hex;`pepperKey` 由既有 `SMS_ENCRYPTION_KEY` 经独立固定 salt + scrypt 派生,不新增 env、不直接复用凭据加密 key;同验证码跨手机号/用途不可关联,pepper / key 永不进入日志、audit、响应或 fixture,明文验证码不入库/audit/响应;dev/test 未配置 key 时发码/验码运行时拒绝且不留验证码 row;旧短效验证码不回填,按原 TTL 自然失效 |
| 微信小程序登录防侧写(2026-06-12;冻结评审稿 [`wechat-mini-login-review.md`](archive/reviews/wechat-mini-login-review.md) §4) | `auth/login-wechat.service.ts` + `src/modules/wechat/` + `@LoginWechatThrottle()` | `POST /api/auth/v1/login-wechat` + `POST /api/auth/v1/wechat-bind{,/send-code}` 三公开端点(**第三个独立认证端点**,[`auth-jwt-refresh`](reference/auth-jwt-refresh.md) 微信行已解锁、密码登录契约零变化):login-wechat 未绑 200 `{bindingRequired:true}`(非枚举面:openid 须经持微信账号的 wx.login code 换取),命中但账号禁用/软删统一 25010 防侧写;wechat-bind/send-code 四无效号码场景同泛化 200 零留痕,绑定**七步顺序冻结**(25002 仅对已证手机控制权者可达,防绑定关系 oracle);会话签发经 `AuthService.createSession` 同构(audit `auth.login.wechat` openid 一律掩码;wx code / session_key 零出现);第 8 throttler 实例 IP 5/60s(`LOGIN_WECHAT_THROTTLE_LIMIT` / `LOGIN_WECHAT_THROTTLE_TTL_SECONDS` 可配,三端点共用一实例);上游 code2session 硬编码微信域 + 8s 超时 + 失败路径 warn 日志(仅 err.name/status,零 secret/URL,2026-06-12 增量审计①收口) |

附件内容类型纵深校验(v0.44.0 findings #22/#23/#24):`image/svg+xml` / `text/html` / `application/xhtml+xml` 永久拒绝;confirm-upload 对 JPG/PNG/WEBP/GIF/PDF 经 `StorageProvider.readObjectPrefix` 回读最多 12 字节核对魔数,COS 使用 ranged getObject;不符返 `ATTACHMENT_CONTENT_TYPE_MISMATCH=13016`,不因客户端声明或运营白名单放行。

### 日志 redact 清单

> 与 [`src/bootstrap/logger-options.ts`](../src/bootstrap/logger-options.ts) 的 `LOG_REDACT_PATHS` 逐条一致(2026-07-04 pre-go-live readiness review v0.35.0 §4 F-1 true-up);新增字段时两处同步追加,不能只在某条日志手工裁剪。分类背景见 [`srvf-foundation-baseline.md` §8.2](srvf-foundation-baseline.md)。

URL query 不依赖字段 redact：pino request serializer 在序列化边界直接丢弃 `?` 后内容，并且不输出 `query` / `originalUrl` / headers。边缘 ingress/access log 必须同样只记 pathname；应用层修复不能清除已经由代理记录的 query。

```
req.headers.authorization
req.headers.cookie
req.headers["x-forwarded-for"]
req.headers.forwarded
req.headers["x-real-ip"]
res.headers["set-cookie"]
req.ip
req.ips
req.remoteAddress
req.remotePort
req.socket.remoteAddress
req.socket.remotePort
req.connection.remoteAddress
req.connection.remotePort
req.body.password
req.body.oldPassword
req.body.newPassword
req.body.token
req.body.accessToken
req.body.refreshToken
req.body.stepUpToken
*.password
*.oldPassword
*.newPassword
*.passwordHash
*.token
*.accessToken
*.refreshToken
*.stepUpToken
*.secret
*.idCard
*.idCardNumber
*.idNumber
*.nationalId
*.phone
*.phoneNumber
*.mobile
*.mobileNumber
*.tel
*.emergencyContact
*.emergencyContactName
*.emergencyContactPhone
*.emergencyContactRelation
*.medicalInfo
*.medicalHistory
*.medicalNotes
*.allergies
*.chronicDiseases
*.bloodType
*.remarksSensitive
*.bankAccount
*.bankCard
*.bankCardNumber
*.cardNumber
*.creditCard
*.cvv
*.homeAddress
*.address
*.residenceAddress
*.dateOfBirth
*.dob
*.birthDate
*.wechat
*.wechatId
*.openId
*.openid
*.unionId
*.certificateNo
*.licenseNo
*.policyNo
*.sex
*.nation
*.birth
*.authority
*.validDate
*.documentNumber
*.realName
*.certNumber
*.policyNumber
```

新增字段时同步追加,不能只在某条日志手工裁剪。

---

## 软删除策略

- **当前版本支持软删除**:`DELETE /api/admin/v1/users/:id` 走 `update({ deletedAt: new Date(), status: DISABLED })`,从不调用 `prisma.user.delete()`
- 所有非"管理员看回收站"查询经 `notDeletedWhere()` 过滤,业务接口看不到已删用户
- `username` / `email` 唯一性预检查走 `findUnique`(包含软删记录),软删后这两个字段**不复用**——避免身份冒用
- **当前版本不提供 restore 接口**;误删恢复需数据库管理员人工操作:
  ```sql
  UPDATE "User" SET "deletedAt" = NULL, "status" = 'ACTIVE' WHERE id = '...';
  ```
- 后续若实现 restore,接口契约预定义为:
  - `PATCH /api/admin/v1/users/:id/restore`
  - **仅 `SUPER_ADMIN` 可用**(`@Roles(Role.SUPER_ADMIN)`)
  - 入参为空,出参与其他用户接口一致(`UserResponseDto`)
  - 同样要在事务里检查 `username` / `email` 是否被新用户占用,若占用则要求先重命名旧记录或拒绝恢复
  - **本节属于升级路径,AI 不得在 V1.2 范围内实现**

---

## Token 吊销升级路径

**当前版本 P0-E PR-3(#127,2026-05-18)已落地 refresh token / logout / logout-all**(沿 [`docs/archive/reviews/first-release-p0e-refresh-token-review.md` v1](archive/reviews/first-release-p0e-refresh-token-review.md) 9 条已决策);**不引入 Redis blacklist**(refresh 撤销靠 DB 主键索引 sub-ms 查询;沿 D-9)。

### P0-E 已落地能力(2026-05-18)

| 能力 | 实施位置 |
|---|---|
| `POST /api/auth/v1/refresh` | rotation always + family revoke + absolute expiration;失败统一 `REFRESH_TOKEN_INVALID=10007` |
| `POST /api/auth/v1/logout` | 任一可识别且未过期 row(含 rotated ancestor)撤销所属 family 全部活跃未过期 refresh;未知 / row 过期 / family 已全撤均幂等 200;其他 family 与 access 不动 |
| `POST /api/auth/v1/logout-all` | 撤销该 user 全部未过期未撤销 refresh;返 `{ revokedCount }` |
| `LoginResponseDto` 扩展 | `refreshToken`(256bit base64url opaque random)+ `refreshExpiresAt`(ISO 8601 UTC family absolute expiration 时刻);字段集恰好 5 项 |
| **refresh_tokens 表** | `tokenHash @unique`(sha256 hex)+ `familyId` + `expiresAt` + `rotatedAt` + `revokedAt` + `revokedReason` + `replacedById` + `ipFirstSeen` / `uaFirstSeen`(后两者仅供审计不出对外 API) |
| **联动撤销 7 场景**(2026-07-17 identity session P0 PR1 由 5 扩 7) | 本人改密 `self-password-change` / 本人短信重置 `self-password-reset` / 管理员重置 `admin-password-reset` / 本人换手机号 `self-phone-identity-change` / 本人换微信 `self-wechat-identity-change` / 用户禁用 `admin-disable` / 用户软删 `admin-delete`(真实变更同事务原子；同目标 no-op 不撤销) |
| TTL 锁定 | `JWT_EXPIRES_IN=15m`(由 7d 收敛)/ `JWT_REFRESH_EXPIRES_IN=90d` family **absolute expiration**;rotation 继承同一 `refreshExpiresAt` 不延长;**禁止** sliding expiration |
| 限流 | 独立 throttler `refresh` 30/60 IP(与 `default` / `password-change` 物理隔离);`logout` **无限流**;`logout-all` 复用 `password-change` 5/60 IP |
| audit | 沿用 `auth.login` / `auth.refresh` / `auth.logout` / `auth.logout-all` / `password.reset.by-admin` 5 事件;`auth.logout` 仅真实状态变化写一次,extra 恰好 `familyId/revokedCount`,no-op 零 audit |

### P0-E 仍不做(沿评审稿 v1 D-4 / D-9)

- **`tokenVersion` 字段**(本期不做;`User` schema 不增字段):依靠 access TTL 15m 自然过期 + `JwtStrategy.validate` 每请求查库阻断 DISABLED / 软删 user
- **access token 不主动吊销**:改密 / 手机或微信身份换绑 / 禁用 / 删除后不做 blacklist；ACTIVE 且未软删用户的旧 access 在剩余 ≤ 15m TTL 内仍可用，禁用 / 删除由 `JwtStrategy.validate()` 下一请求阻断；strategy 只看 `deletedAt === null && status === UserStatus.ACTIVE`,**不读** `passwordHash` / `tokenVersion`
- access token blacklist / JWT revoke list / Redis / Queue / Cron(2026-06-11 注:cron 能力已按升级路径限定解锁**仅生日批**,见 current-state §3;**token 清理类 cron 仍不做**)/ 完整 OAuth tree / httpOnly cookie / refresh_tokens 查询接口 / 已登录设备列表 UI / 单设备管理 / device fingerprint / 微信小程序 OAuth(2026-06-12 注:微信小程序**登录**已解锁落地——code2session 第三认证端点,见上文速查表与 [`wechat-mini-login-review.md`](archive/reviews/wechat-mini-login-review.md);完整 OAuth 网页授权 / unionid 体系 / session_key 存储仍不做)

### refresh token 安全策略(P0-E PR-3 + [`identity session P0 PR2`](archive/reviews/identity-session-p0-step-up-logout-review.md) 锁定)

| 维度 | 锁定值 |
|---|---|
| 生成 | `crypto.randomBytes(32).toString('base64url')`(256 bit 熵;**不是 JWT** opaque random) |
| 存储 | DB 仅存 `tokenHash = sha256(raw).hex`(64 字符);**明文绝不入库** |
| 哈希算法 | sha256(**不用** bcrypt / argon2:高熵随机串无暴破语义) |
| 日志 / audit / OpenAPI 示例 / 测试 fixture / 测试快照 / handoff / release notes | **明文绝不出现**(redact 列表已含 `refreshToken`) |
| 入参 / 出参 | 仅 `LoginResponseDto` / refresh 响应 / `RefreshTokenDto` / `LogoutDto` `data.refreshToken`;**绝不**进入 JWT payload(payload 严格 zero drift `{ sub, username }`) |
| TTL | refresh `90d` family **absolute expiration**;rotation 继承同一 `expiresAt` 不延长 |
| rotation | **rotation always**(每次 refresh 必发新 raw + 旧 raw 同事务标 `rotatedAt + revokedAt + replacedById`) |
| reuse detection | 旧 raw 重放命中(`rotatedAt != null`)→ 独立事务 family revoke(`updateMany where familyId data.revokedReason='family-revoked'`)+ audit `extra.replayDetected=true, familyRevoked=true` |
| logout 行为 | hash 后查 row 不按 `revokedAt` 过滤;可识别且未过期 row(含 rotated ancestor)按 `familyId` 撤销全部 `revokedAt=null AND expiresAt>now`;未知 / row 过期 / family 已全撤幂等 200 且零 audit;`count>0` 才写 `auth.logout` + `familyId/revokedCount`;其他 family 与 access 不动 |
| logout-all 行为 | `updateMany where userId revokedReason='logout'`;返 `{ revokedCount }`;**不**吊销 access |
| 失败统一码 | `REFRESH_TOKEN_INVALID=10007`(refresh 失败 4 子原因:不存在 / 已撤销 / 已过期 / 重放命中,**统一**返;**不**拆 EXPIRED / REVOKED / REPLAY;沿 v1 §8 防账号枚举) |

### tokenVersion 升级路径(若未来真出现"必须 access token 立即失效"诉求,本期**不做**)

**触发条件**:出现"改密 / 禁用 / 删除后,access token 必须在 ≤ 5s 内失效"硬性安全要求(当前 access 15m 自然过期 + refresh 撤销联动已覆盖 99% 场景)。

**推荐升级路径**(按顺序施工;沿评审稿 §3.3):

1. **schema**:`User` 增加 `tokenVersion Int @default(0)`,迁移已存在用户为 `0`
2. **JWT payload**:增加 `tv: number` 字段,签发时取自 `user.tokenVersion`(**会破坏** P0-E 已锁定的 payload zero drift;需评估前端联调影响)
3. **JwtStrategy.validate()**:除现有 `deletedAt === null && status === ACTIVE` 校验外,追加 `payload.tv === user.tokenVersion`,不一致抛 `UNAUTHORIZED`
4. **吊销触发点**:重置密码 / 禁用用户 / 显式"踢下线"等场景,在写库事务内 `tokenVersion: { increment: 1 }`(与 P0-E 联动撤销 refresh 形成"refresh 撤销 + access 失效"双重保险)
5. **不引入 Redis**:每请求多读一个字段,与现有 `JwtStrategy` 单次查库合并,无新增 IO
6. **升级条件**:见 [`ARCHITECTURE.md`](../ARCHITECTURE.md) §9。**AI 不得在 P0-E 范围内实现**,需用户明确确认升级后单独立项(沿 P0-E v1 D-4 + [`docs/current-state.md §3` 评审解锁清单](current-state.md) "默认不做,可评审解锁")

**为什么 P0-E 没做**:`status=DISABLED` 即时阻断 + access TTL 15m 自然过期 + refresh 撤销联动已覆盖绝大多数场景;`tokenVersion` 增加 schema 维护与 JWT payload 字段(破坏 zero drift),投入 / 回报不匹配。仅在出现"5s 内必须失效"硬性诉求时再立项。

---

## RBAC / scoped-authz 交叉引用

本文件不是 RBAC / scoped-authz(组织职务 + 分管 + 统一鉴权)的权威源,只覆盖认证(登录 / 密码 / token)相关安全策略,不重复判权设计。权威源:[`AGENTS.md`](../AGENTS.md) §8 / §13(RBAC / 判权铁律)、[`src/modules/authz/CLAUDE.md`](../src/modules/authz/CLAUDE.md)(判权大脑本地事实)、[`docs/ops/scoped-authz-go-live-checklist.md`](ops/scoped-authz-go-live-checklist.md)(上线初始化 SOP,含考勤终审绑定 / `22074`-`22075` 行为)。

## 控制面审计(control-plane audit)权威规则

> 收敛「哪些控制面高危写必须 audit / 哪些刻意不写」的单一权威表述。2026-07-13 第六刀 finding 15 由维护者拍板系统性全覆盖,推翻 users D-PR3-2 / sms D-SMS-9 / storage §6.6.5 的“不写 / 留专项”挂起决定;四类 settings 与 users 三类高危写均已接入同事务审计。2026-07-14 第七刀补齐 members 轴关联账号启停入口。

**判据**:授权 / 组织事实、账号角色 / 状态 / 删除、供应商开关与凭据重置均属必须可取证的控制面高危写。敏感度不是跳过审计的理由,而是约束 audit payload:**凭据 / 密码 / secret 的明文和密文永不进入 audit**;settings update 只记非敏感变更字段名,reset-credentials 只记动作、actor 与 row.id。

### 写 audit(授权 / 组织事实变更)

| 配置面 | 事件(resourceType) | 落地 |
|---|---|---|
| **RBAC 授权配置**:RbacRole 建/改/软删、RolePermission 授予/撤销、Permission CRUD | `rbac-role.{create,update,delete}` / `role-permission.{grant,revoke}` / `permission.{create,update,delete}`(`rbac_role` / `role_permission` / `permission`) | 第三轮 review v0.38.0 §F&A-2 补齐(三服务经 [`permissions/config-audit.util.ts`](../src/modules/permissions/config-audit.util.ts) 直写,避 PermissionsModule↔AuditLogsModule 模块环) |
| **user-role / role-binding**:角色分配/撤销、scoped 绑定建/撤 | `role-binding.{create,revoke}`(`role_binding`;`extra.viaPath ∈ {user-role, role-binding}`) | scoped-authz PR6 |
| **organizations**:建 / reparent / 启停 / 软删(纯 cosmetic update 不写) | `organization.{create,move,status-change,delete}`(`organization`) | #495(review #484 G18) |
| **memberships**:建 / 结束 / 迁移(纯 PATCH 不写) | `membership.{set,end,transfer}`(`membership`) | #490 / F4 transfer |
| **position / supervision assignments**:任命/撤销、建/撤分管 | `position-assignment.{create,revoke}` / `supervision-assignment.{create,revoke}` | scoped-authz PR4 / PR5 |
| **attachment-configs**:三表建/改/改状态/删 | `attachment.config.change`(伞事件;`extra.configType` + `extra.operation`) | attachments PR #6d |
| **contribution-rules**:建/改/软删 | `contribution-rule.{create,update,delete}` | audit PR #3 |
| **users**:角色 / 状态 / 软删 | `user.role.update` / `user.status.update` / `user.soft-delete`(`user`;before/after 仅 role/status/delete) | 2026-07-13 第六刀 finding 15;推翻 users D-PR3-2 |
| **members 轴关联账号**:启停 | `member.account.status-change`(`member`;before/after 仅 status;extra 仅 linkedUserId/refreshTokensRevoked) | 2026-07-14 第七刀 finding 15 残留;user 写/refresh 撤销/audit 同事务 |
| **storage / sms / wechat / realname settings**:update / reset credentials | `<provider>-setting.update` / `<provider>-setting.reset-credentials`(`<provider>_setting`;update 仅 `extra.changedFields`,reset 无 before/after/extra) | 2026-07-13 第六刀 finding 15;凭据明文/密文永不入 audit |

### 刻意不写 audit(当前明确范围)

| 配置面 | 理由 |
|---|---|
| **dictionaries(字典类型 / 字典项)** | 分类字典,变更不改授权事实;属 v2 早期「4 模型写不接 audit」的原始范围,保持不写 |

> 变更本表任一归属(把某 config 面从「不写」挪到「写」或反之)= 判权 / 审计事实变更,按 D 档降速,先与维护者对齐。

## 敏感读取审计

Admin 读取他人档案、紧急联系人、自购保险、证书、考勤与招新材料时必须写入 `audit_logs`。本批次新增 8 个读取事件；活动报名 CSV 导出复用既有 `registration.review`。App 本人 self-scope 读取不在本批次扩面。

| 读取面 | 事件 | resource 锚点 |
|---|---|---|
| 队员扩展档案 | `profile.read.other` | `member_profile` / profile id(无档案时 nullable) |
| 紧急联系人 | `emergency-contact.read.other` | `member` / member id |
| 队员自购保险 | `member-insurance.read.other` | `member` / member id |
| 证书列表 / 详情 | `certificate.read.other` | list=`member`;detail=`certificate` |
| 资质布尔查询 | `certificate.read.qualification-flag` | `member` / member id |
| 考勤单列表 / 详情 / 审核详情 | `attendance-sheet.read.other` | list=`activity`;detail=`attendance_sheet` |
| 活动报名 CSV | `registration.review` + `extra.operation='export'` | `activity` / activity id |
| 招新列表 / 详情 / CSV / 证书图 / 发号预检 | `recruitment-application.read.other` | `recruitment_application` 或 `recruitment_cycle` |
| 招新证件图 | `recruitment-application.id-card-image.read` | `recruitment_application` / application id |

顺序与失败语义固定如下：

- 普通读取：鉴权与业务查询成功后 `await` 审计，再返回数据；审计拒绝直接上抛，fail-closed。
- CSV：必须在 controller 获得 generator / stream 前完成审计；不得在 generator 尾部补记，审计失败时不得发送首字节。
- 签名 URL：完成资源与 key 存在性守卫后、任何 `generateDownloadUrl` 调用前完成审计；审计失败时 provider 调用次数必须为 0。
- 每条记录显式保存 `actorUserId` / `actorRoleSnap` 与 controller 构造的 `AuditMeta(requestId/ip/ua)`。
- `extra` 只允许 operation、filterFields 字段名、maskLevel、字段名和安全计数；禁止姓名、手机号、身份证号、保单号、object key、URL、token、credential、原始 filter 值与自由文本。
