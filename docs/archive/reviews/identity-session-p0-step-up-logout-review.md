# Identity Session P0：step-up 与 refresh-family logout 冻结评审稿

> **状态**：D 档评审稿 + 立项记录；本文件随 PR0 合入后冻结，不回改。
>
> **基线**：`origin/main` `432e1bdd`（v0.58.0）；模块 36 / Controller 74 / Endpoint 360 / Migration 54 / BizCode 250 / 权限码 206 / AuditLogEvent 113 / Cron 2。
>
> **拍板凭据**：维护者已明确回复“按推荐，创建执行 lane”，授权本 goal 内 `+4 auth/v1 route / +1 SmsPurpose migration / +2 BizCode / +1 AuditLogEvent` 的 D 档增量。
>
> **PR0 写集**：仅本文件；0 `src/**` / 0 `prisma/**` / 0 `test/**` / 0 contract / 0 active docs 变更。
>
> **终态边界**：不引入 Redis，不让既有 access token 立即失效，不进入 version bump / release / tag / GitHub Release。

---

## 0. 冻结结论

1. 采用**方案 A：无 proof 表的 5 分钟短期签名 step-up proof**。proof 绑定 `user + action + current credential snapshot`，签名密钥与 snapshot HMAC 密钥均从现有 `JWT_SECRET` 经 HKDF-SHA256 派生，但使用不同 `info` 域；禁止直接用 access JWT 原密钥签 proof。
2. `PUT /api/app/v1/me/phone` 与 `PUT /api/app/v1/me/wechat` 都新增必填 `stepUpToken`。access token 只证明当前登录态，不能单独完成手机号 / 微信绑定或换绑，也不能借新绑定因子直接签出 90d refresh。
3. 真实身份变更在 `UsersService` 持有的事务内完成：parameterized `SELECT ... FOR UPDATE` 锁 User → 重新计算 snapshot → 校验 proof → 更新身份 → 撤销该 user 全部活跃未过期 refresh → 写既有 bind / rebind audit。旧 access token 仍按现行规则最长 15 分钟自然过期。
4. pre-auth `wechat-bind` 继续以**当前 phone OTP**为身份锚；发生首绑 / 换绑时，绑定事务同步撤销旧 refresh，事务提交后才由 `createSession` 创建新 family。
5. `POST /api/auth/v1/logout` 从“当前 row 撤销”升级为“可识别且未过期的 token 所属 family 撤销”；rotated ancestor 也能定位 family，其他 family 与已签 access token 不受影响。
6. PR0 → PR1 → PR2 **严格串行**：PR0 合入后才开 PR1；PR1 合入、其余 lane rebase `main` 后才开 PR2。不得把 PR1 / PR2 混进同一个 PR。

### 0.1 supersede 边界（只新增声明，不回改历史冻结稿）

本稿只在本次身份与会话范围内覆盖以下两项旧决定，其他决定继续有效：

- 覆盖 `wechat-mini-login-review.md` 的 D-W3 中“已登录 `PUT me/wechat` 只凭 JWT 即可换绑、无需当前因子”的部分；新终态是 access JWT + 针对 `WECHAT_BIND` 的有效 step-up proof。
- 覆盖 `first-release-p0e-refresh-token-review.md` 中 `logout` “只撤销当前 refresh row”的部分；新终态是由任一可识别且未过期的 family token 撤销该 family 的全部活跃未过期 token。

**不得**回改上述两份历史原文；本稿不是对 P0-E 的 rotation always、90d absolute expiration、reuse detection、refresh 失败统一 10007、access 15m 自然过期、logout 幂等 / 无限流等其他锁的重开。

---

## 1. 当前事实与立项探针

| 探针                   | 当前事实                                                                                    | 本稿终态                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| App 手机绑定           | `BindMyPhoneDto` 仅 `phone + code`；事务内更新 phone + audit，未撤销 refresh                | DTO 必填 `stepUpToken`；User 行锁内复核 proof；真实变更同事务撤销 refresh + audit                     |
| App 微信绑定           | `BindMyWechatDto` 仅 `code`；现有 D-W3 只凭 JWT 即可换绑                                    | DTO 必填 `stepUpToken`；必须是 `WECHAT_BIND` action proof；真实变更同事务撤销 refresh + audit         |
| pre-auth `wechat-bind` | phone OTP 绑定事务与随后 `createSession` 串行；绑定事务当前未撤销旧 refresh                 | 保留 phone OTP 锚；真实绑定事务先撤销旧 refresh，再 `createSession` 新 family                         |
| logout                 | 可识别 fresh row 只更新该 row；rotated ancestor 因 `revokedAt != null` 幂等返回             | 可识别且未过期 row（含 rotated ancestor）用于定位 family，`updateMany` 撤销该 family 活跃未过期 token |
| 日志 redact            | 已覆盖 password / accessToken / refreshToken / phone / openid，未覆盖 `stepUpToken`         | 同步新增 `req.body.stepUpToken` 与 `*.stepUpToken`；snapshot / proof 不得出日志                       |
| 活跃安全文档           | 同时存在“改密不撤旧 token”与“改密撤 refresh、access 不撤”的不精确口径；logout 写为 row-only | PR1 / PR2 按各自实现 true-up 为“refresh 撤销、access 不主动撤销”与 family logout 精确口径             |
| 计数                   | 36 / 74 / 360 / 54 / 250 / 206 / 113 / 2                                                    | PR1 后 36 / 74 / 364 / 55 / 252 / 206 / 114 / 2；PR2 数量零增量                                       |

若后续 lane 的 live 探针已经满足某项终态，必须跳过重复实施并报告；若 live 代码、`current-state`、contract 或 GitHub 状态互相冲突，立即停下上报，不自行调和。

---

## 2. A — 终态 DoD（逐条可核验）

- [ ] 只持有效 access token，无法完成手机号或微信绑定 / 换绑，也无法借新因子签出 90d refresh；两个 App PUT 均对缺失、错误 action、错误 user、过期或 stale snapshot 的 step-up proof 失败关闭。
- [ ] 密码账号可用当前密码 step-up；随机不可用口令但有当前手机号的 phone-only 账号可用 SMS step-up；有当前 openid 的 openid-only 账号可用 WeChat step-up。不得把“所有 User 都有 `passwordHash`”误当成“所有用户都知道密码”。
- [ ] step-up token TTL 固定 300 秒；绑定 `sub + action + factor + current credential snapshot + aud + iat + exp`；使用与 access JWT 域隔离的派生签名密钥与专用 audience。
- [ ] snapshot 是当前凭据状态的 HMAC 摘要，不含明文密码、passwordHash、phone、openid 或 token；任一真实密码 / phone / openid 变更后 snapshot 改变，旧 proof 自动失效。
- [ ] 两个 App PUT 在事务内先用 parameterized `SELECT ... FOR UPDATE` 锁 User，再重新读取当前凭据、计算 snapshot 并二次复核 proof；并发身份变更被同一 User 行锁串行。
- [ ] `PUT /api/app/v1/me/phone` 与 `PUT /api/app/v1/me/wechat` 均新增必填 `stepUpToken`；真实身份变更、该 user 全部活跃未过期 refresh 撤销、既有 bind / rebind audit 在同一事务；旧 access 仍最长 15m 自然过期。
- [ ] phone / wechat refresh 撤销原因固定为 `self-phone-identity-change` / `self-wechat-identity-change`；不新增 Prisma enum，不改变 access JWT payload。
- [ ] pre-auth `wechat-bind` 仍以当前 phone OTP 为身份锚；真实首绑 / 换绑的 binding transaction 同步撤销旧 refresh，提交后 `createSession` 创建新 family；不得在撤销事务提交前签出新 family。
- [ ] logout：任一可识别且未过期的 refresh family token（含 rotated ancestor）可撤销该 family 全部活跃未过期 token；未知、过期、已全撤 family 仍幂等 200；其他 family 不动；已签 access 不动。
- [ ] audit / log / contract / OpenAPI 示例 / fixture / snapshot / handoff 不泄露 password、passwordHash、SMS code、wx code、session_key、`stepUpToken`、proof snapshot、完整 phone 或完整 openid。
- [ ] `auth.step-up` 仅在 proof 成功签发后写；`extra` 恰好只含 `action` / `factor`，不含凭据、token、hash、snapshot 或完整身份值。
- [ ] PR1 通过对应 unit、step-up + phone / wechat E2E、auth 回归、contract、`pnpm agent:check:full`；contract snapshot diff 逐行解释，4 route 纯新增、0 route 删除、0 L3 字段。
- [ ] PR2 通过 auth service unit、logout family E2E、auth 回归、contract zero-drift、`pnpm agent:check:full`；0 route / DTO / BizCode / schema / AuditLogEvent 数量增量。
- [ ] PR1 精确终值：Endpoint 360→364、Migration 54→55、BizCode 250→252、AuditLogEvent 113→114；权限码 206、模块 36、Controller 74、Cron 2 不变。PR2 上述计数全部不变。

---

## 3. B — 探针驱动任务队列

| PR                                 | 开工探针                                                                                                                                     | 仅在探针未满足时实施                                                                                                                                          | 结束探针 / 计数                                                                                                   | 串行前置                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **PR0：本冻结稿**                  | 本文件不存在；当前仍为 JWT-only authed WeChat rebind + logout row-only                                                                       | 仅新增本文件，冻结 DoD / 队列 / 授权 / 禁止域 / 写集 / 风险 / A-B / 回退                                                                                      | 精确 diff 仅本文件；docs 三门禁通过                                                                               | 当前维护者拍板已具备                                                  |
| **PR1：step-up + identity rebind** | 4 route、`IDENTITY_STEP_UP`、10008/10009、`auth.step-up`、`identity-step-up.service.ts` 任一缺失即按本稿补齐；若已完整存在则只验证不重复实现 | Auth step-up 签发 + Users phone/wechat proof 消费 + pre-auth wechat-bind refresh 撤销 + 唯一 enum migration + audit/redact/tests/contract/handoff/active docs | 364 routes / 55 migrations / 252 BizCode / 114 AuditLogEvent；206 permission / 36 module / 74 controller / 2 cron | **PR0 merged**；migration token 仅授予此 lane；不得运行真实 DB 写命令 |
| **PR2：refresh-family logout**     | `AuthService.logout` 若仍按 row `update` 或对 rotated ancestor 直接幂等，则实施；若已是符合本稿的 family `updateMany`，只补验证 / 文档       | 仅改变既有 logout service 行为与 unit/E2E/active docs；沿用 route、DTO、BizCode、schema、AuditLogEvent                                                        | 数量增量全为 0；contract snapshot zero drift                                                                      | **PR1 merged + rebase main**                                          |

串行铁律：PR0 未合入不得开 PR1；PR1 未合入且 PR2 lane 未 rebase 最新 `main` 不得开 PR2。每个 PR 单独 `agent:preflight --lane`、单独分支、单独 ready PR；不自动合并。

---

## 4. C — 授权清单（名字与语义冻结）

### 4.1 四个新 Auth endpoint

四个 endpoint 都落现有 `AuthController('auth/v1')`，默认经 `JwtAuthGuard`；**不得**标 `@Public()`，不得新建 Controller，故 route +4、Controller +0。

| Endpoint                                  | 当前因子输入                                                     | action                      | 限流复用          | 成功响应                                             |
| ----------------------------------------- | ---------------------------------------------------------------- | --------------------------- | ----------------- | ---------------------------------------------------- |
| `POST /api/auth/v1/step-up/password`      | 当前密码；不得接 username / 新密码                               | `PHONE_BIND \| WECHAT_BIND` | `password-change` | `StepUpResponseDto { stepUpToken, expiresAt }`       |
| `POST /api/auth/v1/step-up/sms/send-code` | 不接任意目标 phone；只向当前 User.phone 发码                     | `PHONE_BIND \| WECHAT_BIND` | `sms-send`        | 复用既有泛化发码响应；永不返回验证码或 `stepUpToken` |
| `POST /api/auth/v1/step-up/sms`           | 当前 User.phone 收到的 `IDENTITY_STEP_UP` code                   | `PHONE_BIND \| WECHAT_BIND` | `sms-verify`      | `StepUpResponseDto { stepUpToken, expiresAt }`       |
| `POST /api/auth/v1/step-up/wechat`        | `wx.login` code；code2session 的 openid 必须等于当前 User.openid | `PHONE_BIND \| WECHAT_BIND` | `login-wechat`    | `StepUpResponseDto { stepUpToken, expiresAt }`       |

冻结约束：

- action 对外枚举**恰好** `PHONE_BIND | WECHAT_BIND`；factor 内部枚举恰好 `PASSWORD | SMS | WECHAT`。
- 三个 proof 签发 endpoint 的响应字段集恰好 `stepUpToken + expiresAt`；`expiresAt` 为 ISO 8601 UTC 绝对时间。send-code 不签 proof，只返回既有安全的发码状态。
- `stepUpToken` 只由 Auth surface 返回；`PUT app/v1/me/phone` 与 `PUT app/v1/me/wechat` 的响应 DTO 保持现有安全形状，**绝不**返回 token / snapshot。
- SMS 与 WeChat step-up 只能验证**当前已绑定因子**；禁止把要绑定的新 phone / 新 openid 当作当前因子，禁止 body 接收任意 current phone / openid 来绕过服务端取值。
- 不新增 permission / Role / seed / throttler；现有四类 throttler 的限额、存储与防枚举纪律不变。

### 4.2 `SmsPurpose` 与唯一 migration

- `SmsPurpose` 仅新增 `IDENTITY_STEP_UP`。
- PR1 仅允许一个 additive migration：PostgreSQL enum `ADD VALUE 'IDENTITY_STEP_UP'`；0 table / 0 column / 0 index / 0 backfill / 0 seed。
- enum value 视为不可简单回收；回退时保留该值，**禁止 down migration**。
- 本稿与 goal 不构成运行 `prisma migrate dev|reset|db push` 的授权；PR1 只产出并审查 migration SQL，真实 DB 写另按规则实时授权。

### 4.3 BizCode（+2，100xx users/auth 段）

| 名称                         |  code | HTTP | 统一语义 / 前端价值                                                                                                                               |
| ---------------------------- | ----: | ---: | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STEP_UP_PROOF_INVALID`      | 10008 |  401 | proof 过期、签名错误、audience 错、sub/user 错、action 错、snapshot stale **统一同码同 message**；前端丢弃 proof 并重新 step-up，不得细分失败原因 |
| `STEP_UP_FACTOR_UNAVAILABLE` | 10009 |  409 | 当前账号没有所请求的当前因子；前端可切换到另一个可用 factor，不泄露任意他人账号状态                                                               |

底层当前因子验证失败继续遵守既有防枚举纪律：SMS / WeChat 不细分验证码、绑定状态或上游细节；password 不因账号来源区分提示。不得再新增第三个 step-up BizCode。

### 4.4 `IdentityStepUpService`、密钥域与 proof

- AuthModule 内新增单责 `identity-step-up.service.ts`，由 AuthModule provider + export；UsersModule **单向** import AuthModule 并消费该 service。AuthModule 不 import UsersModule，禁止 `forwardRef()`，不新增模块。
- 该 service 只负责当前因子验证、snapshot 计算、proof 签发 / 验证与成功签发 audit；User 身份写、refresh 撤销与 bind/rebind audit 仍由 UsersService 持有事务与编排。
- 从既有 `JWT_SECRET` 经 HKDF-SHA256 派生两把 32-byte 子密钥；固定 salt 版本域，`info` 至少分别为 `srvf.identity-step-up.signing.v1` 与 `srvf.identity-step-up.snapshot.v1`。不得直接复用 access JWT secret，不新增 env。
- proof 专用 audience 固定 `srvf.identity-step-up`；TTL 固定 300 秒；payload 至少含 `sub / action / factor / snapshot / aud / iat / exp`。`JwtPayload` 严格保持 `{ sub, username }`，step-up payload 不得并入 JwtPayload 类型。
- snapshot 使用派生 snapshot key 对固定字段顺序的当前 User credential state 做 HMAC-SHA256，再编码为 opaque digest；输入至少覆盖 `id / passwordHash / phone / phoneVerifiedAt / openid / status / deletedAt`。token 中只放 digest，不放上述原值。
- `JWT_SECRET` 轮换会同时使未过期 step-up proof 失效，这是接受的 fail-closed 行为；不得为兼容旧 proof 维护第二套 secret。
- password 签发必须比较当前 `passwordHash`；SMS 发码 / 验码只用当前 User.phone + `SmsPurpose.IDENTITY_STEP_UP` + 当前 userId；WeChat 只接受 code2session 得到的当前 User.openid。

### 4.5 身份变更事务与并发锁

`UsersService.bindMyPhone` / `bindMyWechat` 的真实变更顺序冻结为：

1. 开启 Prisma transaction。
2. 用 tagged / parameterized raw query 执行 `SELECT ... FROM users WHERE id = <bound parameter> FOR UPDATE`；禁止字符串拼接、`$queryRawUnsafe` 或在事务外先读后信。
3. 在锁内重新读取 User 当前 `passwordHash / phone / phoneVerifiedAt / openid / status / deletedAt`，重新计算 snapshot，并校验 proof 的 signature / audience / exp / sub / action / snapshot。
4. 校验目标身份占用（仍含软删占用）；同目标视为幂等 no-op，不写 identity-change audit、不撤 refresh，也不视作 proof 消费；他人占用沿既有码与 P2002 兜底。
5. 真实变更时更新 `phone + phoneVerifiedAt` 或 `openid`。
6. 同事务 `refreshToken.updateMany` 撤销该 user 全部 `revokedAt=null AND expiresAt>now` 的 token；phone 固定 `self-phone-identity-change`，wechat 固定 `self-wechat-identity-change`。
7. 同事务写既有 `phone.bind.self / phone.rebind.self` 或 `wechat.bind.self / wechat.rebind.self`；继续 mask phone / openid，禁止把 proof、snapshot 或当前因子放 audit。
8. 提交后返回既有 App DTO；旧 access token 不主动吊销。

方案 A 没有 server-side proof row，因此“消费”由真实凭据变更导致 snapshot 自失效来实现：一个 proof 第一次成功改到新目标后立即 stale；同目标幂等没有状态变化，允许重复得到同一安全结果，不伪装成单次消费。

### 4.6 pre-auth `wechat-bind`

- 继续要求当前 phone 的 `SmsPurpose.WECHAT_BIND` OTP；不得改为只凭 wx code 或 access token。
- code2session、防枚举校验顺序、openid 含软删占用、P2002 兜底继续保留。
- 发生首绑 / 换绑时，`user.update(openid)` + `refreshToken.updateMany(... self-wechat-identity-change)` + 既有 `wechat.bind.self / wechat.rebind.self` audit 在同一 binding transaction。
- binding transaction 提交后才调用 `AuthService.createSession`，由它创建新的 refresh family；“绑定已提交、createSession 失败”的既有窄窗口继续接受，客户端可重新走已绑 `login-wechat`。
- already-bound-to-self 仍是幂等，不伪造 bind/rebind audit；本稿不把它改造成身份变更。

### 4.7 AuditLogEvent 与 logger redaction

- AuditLogEvent 仅新增一个：`auth.step-up`。
- 只在 password / sms / wechat proof **成功签发**后写；send-code、失败验证、proof 消费不写该新事件。
- `extra` 字段集恰好 `{ action, factor }`；禁止 `stepUpToken`、signature、snapshot、password / passwordHash、SMS / wx code、phone、openid、token hash。
- logger redaction 同步新增 `req.body.stepUpToken` 与 `*.stepUpToken`；任何显式记录 proof payload 的代码都禁止。需要记录 action / factor 时仅记录非敏感枚举。

### 4.8 refresh-family logout（PR2）

既有 `POST /api/auth/v1/logout` route / `LogoutDto { refreshToken }` / `@Public()` / 无限流 / 200 `data:null` 全部保持，只替换 service 语义：

1. hash raw refresh，按 `tokenHash` 查 row，至少取 `id / userId / familyId / expiresAt`；不要求 row 当前未撤销，因此 rotated ancestor 可定位 family。
2. row 不存在或 row 自身已过期：直接幂等 200，零 audit。
3. row 可识别且未过期：同一事务 `updateMany where familyId=<row.familyId> AND revokedAt=null AND expiresAt>now`，统一写 `revokedAt=now / revokedReason='logout'`。
4. `revokedCount=0`（family 已全撤）幂等 200，零 audit；`revokedCount>0` 才沿用 `auth.logout`，`extra` 固定新增 `familyId / revokedCount`，不新增 AuditLogEvent。
5. query 不带 `userId` 扩大范围，也不碰其他 family；access token 头若存在仍不校验、不消费、不吊销。
6. rotation / refresh reuse detection 的 10007 与 family-revoked 行为不改；logout 用 rotated ancestor 是显式撤销，不等价于 refresh replay。

PR2 数量增量固定为：0 route / 0 DTO / 0 BizCode / 0 schema / 0 migration / 0 AuditLogEvent / 0 permission / 0 controller / 0 module / 0 cron。

### 4.9 contract、测试与 active docs true-up

PR1 必须覆盖：

- unit：HKDF 两域不等、audience / TTL / payload、snapshot 稳定与变更失效、三因子成功 / 失败、10008 统一、10009 fallback、audit secret-safe。
- E2E：四 route 鉴权与 throttler 复用；password / phone-only SMS / openid-only WeChat 三路径；两个 App PUT 缺 proof / action 错 / user 错 / stale / 过期；User 行锁串行；真实变更撤 refresh + audit；同目标幂等；pre-auth wechat-bind 撤旧 family 后创建新 family；旧 access 仍可在有效期内使用。
- contract：`EXPECTED_ROUTES` 显式 +4 到 364；OpenAPI snapshot 逐行解释；新增 Auth response 含 `stepUpToken`，App response 不含；L3 扫描零命中。
- handoff / active docs：至少 true-up `docs/handoff/miniapp.md`、`docs/handoff/openapi.json`、`docs/security.md`、`docs/current-state.md` 与触碰模块的 `CLAUDE.md` / Prisma 账本；历史 archive 不回改。

PR2 必须覆盖：

- unit / E2E：fresh leaf、rotated ancestor、同 family 多 active row、未知、过期、已全撤、其他 family 不动、access 不动、audit 仅真实撤销且含 familyId/revokedCount。
- contract：route / DTO / OpenAPI snapshot zero drift；运行 contract gate 但不得为 PR2 刷出 schema 差异。
- active docs：把 `docs/security.md` 的 logout row-only 口径 true-up 为 family 口径；历史 P0-E 评审稿不回改。

两个实现 PR 都必须跑对应 auth / users 横切组 + `pnpm agent:check:full`；snapshot 禁止盲 `-u`，每一行 diff 必须能映射到本稿授权。

---

## 5. D — 禁止域

- 禁 Redis / queue / 新 cron / 新 proof table / `tokenVersion` / access blacklist / JWT revoke list / JwtPayload 增字段 / LocalStrategy。
- 禁新 permission / Role / seed / 新 throttler；禁止改变既有 throttler 数值、storage 或 header 行为。
- 禁让 access token 因 phone / wechat 变更或 logout 立即失效；仍沿 15m 自然过期与 `JwtStrategy.validate` 每请求查 ACTIVE / deletedAt。
- 禁把 `stepUpToken` 放入 App response、audit、日志、OpenAPI 示例、fixture、snapshot、handoff；禁止记录 password、SMS/wx code、snapshot、完整 phone/openid。
- 禁降低登录、SMS、WeChat、refresh 防枚举；禁止为 step-up 细分过期 / 签名 / audience / user / action / snapshot 错误。
- 禁顺手修全仓限流、多实例内存缓存、通用审计、其他 13 组问题；发现只上报。
- 禁 `prisma migrate dev|reset|db push`；PR1 只产出唯一 additive migration，真实 DB 写另行实时授权。
- 禁回改任何既有 frozen review / archive / 已发布 CHANGELOG 段；本文件合入后同样不回改。
- 禁 release / version bump / tag / GitHub Release；禁进入 E 档收口。
- 禁新增模块、Controller、通用 util grab-bag、repository abstraction、`forwardRef()` 环依赖或跨模块大重构。
- 禁 PR1 / PR2 写集外“顺手修”；写集外发现一律进入总控简报，未经新拍板不实施。

---

## 6. E — 写集声明

### 6.1 PR0 精确写集

唯一允许新增：

```text
docs/archive/reviews/identity-session-p0-step-up-logout-review.md
```

禁止修改任何其他文件，包括 `src/**`、`prisma/**`、`test/**`、contract snapshot、`docs/current-state.md`、`docs/security.md`、根规则、CHANGELOG 与既有 archive。

### 6.2 PR1 预计写集边界

允许范围仅为下列身份 step-up 实现与同 PR contract / handoff true-up；具体文件以 live 引用链为准，写集外停：

```text
src/modules/auth/
  auth.controller.ts
  auth.dto.ts
  auth.module.ts
  identity-step-up.service.ts                 # 新增
  identity-step-up.service.spec.ts            # 新增
  login-wechat.service.ts
  login-wechat.service.spec.ts
  CLAUDE.md

src/modules/users/
  controllers/app-me.controller.ts
  dto/app/app-me-phone.dto.ts
  dto/app/app-me-wechat.dto.ts
  users.module.ts
  users.service.ts
  users.service.spec.ts
  CLAUDE.md

prisma/schema.prisma                          # SmsPurpose +1
prisma/migrations/<one_timestamp>_add_identity_step_up_sms_purpose/migration.sql
prisma/CLAUDE.md

src/common/exceptions/biz-code.constant.ts
src/common/exceptions/biz-code.constant.spec.ts
src/modules/audit-logs/audit-logs.types.ts
src/bootstrap/logger-options.ts
src/bootstrap/logger-options.spec.ts

test/e2e/auth-step-up.e2e-spec.ts             # 可新增
test/e2e/app-me-phone-bind.e2e-spec.ts
test/e2e/app-me-wechat.e2e-spec.ts
test/e2e/auth-wechat.e2e-spec.ts
test/fixtures/**                              # 仅本能力必要 fixture
test/contract/openapi.contract-spec.ts
test/contract/__snapshots__/openapi.contract-spec.ts.snap

docs/handoff/miniapp.md
docs/handoff/openapi.json
docs/security.md
docs/current-state.md
CODEMAP.md                                    # 新 service 若守护要求 true-up
```

`src/modules/sms/**` 只有 live 引用链证明 `IDENTITY_STEP_UP` 消费必须同步时才可进入写集；不得借 enum 增量改短信通道、hash、retention 或限流。`docs/archive/**` 在 PR1 为 0 diff。

### 6.3 PR2 预计写集边界

```text
src/modules/auth/auth.service.ts
src/modules/auth/auth.service.spec.ts
src/modules/auth/CLAUDE.md
test/e2e/auth-logout.e2e-spec.ts
docs/security.md
docs/current-state.md                         # 仅行为事实 true-up，计数不变
```

PR2 不得修改 controller / DTO / BizCode / schema / migration / AuditLogEvent union / permission / seed / contract snapshot / handoff OpenAPI。若测试证明必须触碰上述任一项，停止并回总控重新拍板，不用“测试需要”扩权。

---

## 7. 方案 A / B 对比与密码-only 否决

| 维度           | 方案 A（采用）：短期签名 proof，无表                              | 方案 B：持久化 `step_up_proofs` 表                          |
| -------------- | ----------------------------------------------------------------- | ----------------------------------------------------------- |
| proof 生命周期 | 5m；签名 + audience + user/action + credential snapshot           | DB row 管理 issued / consumed / revoked / expires           |
| 单次语义       | 真实身份变更使 snapshot 改变，旧 proof 自失效；同目标幂等不算消费 | 可原子 compare-and-set 严格单次消费                         |
| 主动撤销       | 不能单独撤销某个未用 proof；JWT_SECRET 轮换可整体 fail-closed     | 可按 user / proof 主动撤销，logout 可即时撤未用 proof       |
| 并发           | User row lock + 锁内 snapshot 二次复核串行真实变更                | proof row + User row 双锁，锁顺序与死锁面更复杂             |
| schema / 运维  | 仅 SmsPurpose additive migration；无 proof retention / cleanup    | 新表、索引、retention、cleanup、审计与 migration 回退复杂度 |
| 泄漏面         | proof 只在 Auth response；DB 无 proof row                         | DB 持久化 proof hash / metadata，增加查询与留存面           |
| 当前需求匹配   | 满足 5m、高危换绑、真实变更后失效、无 Redis / 无新表约束          | 当前没有硬需求支撑额外复杂度                                |

**采用 A**。只有出现“logout 必须即时撤销所有未使用 proof”、运营必须点杀某个 proof、或合规要求持久化逐 proof 消费 / 撤销证据等硬需求时，才重开方案 B 的独立 D 档评审；不得在 PR1 顺手建表。

**密码-only 方案明确否决**：招新 / 队员开号存在随机生成、用户不可用 / 不知晓的口令。若只允许当前密码 step-up，会把 phone-only / openid-only 账号永久锁在身份管理之外；因此必须同时提供 password / SMS / WeChat 三条当前因子路径。

---

## 8. 风险表

| 风险                                | 最坏影响                                              | 冻结缓解                                                                                       | 回退 / 触发                                                  |
| ----------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 仅 access 即可换绑                  | 被盗 access 可接管 phone / openid 并换出 90d refresh  | 两个 App PUT 必填 action-bound proof；新因子不能作为当前因子                                   | 先在网关关闭两个换绑 PUT                                     |
| proof 重放（无表）                  | 5m 内重复请求                                         | snapshot + User row lock；首次真实变更后 stale；同目标仅幂等 no-op                             | 若要求严格单次或 logout 撤 proof，重开方案 B                 |
| proof / access 密钥域混用           | access token 被误当 step-up 或反向伪造                | HKDF 两个独立 info + 专用 audience；禁止原 secret 直签 proof                                   | 回退 PR1 代码；保留 enum migration                           |
| snapshot 设计漏字段                 | 改了某凭据但 proof 仍有效                             | 固定覆盖 passwordHash / phone / phoneVerifiedAt / openid / status / deletedAt；unit 逐字段变更 | 新漏项属 D 档安全 finding，停下评审                          |
| 事务外校验 TOCTOU                   | 两个并发 proof 连续换绑                               | parameterized User `FOR UPDATE`；锁内重算 snapshot 和二次复核                                  | 发现无法锁内复核则 PR1 不得合入                              |
| User 行锁死锁 / 延迟                | 身份写阻塞或 deadlock                                 | 单一 User 锁，固定先锁 User 再做该事务其余写；不跨 user 锁                                     | 监测到锁风险先关闭换绑，单独评审锁顺序                       |
| factor 不可用                       | 随机口令账号无法 step-up                              | password / SMS / WeChat 三路径 + 10009 提示切换；仅验证当前因子                                | 三路径仍无因子的账号不得降级为 access-only，走人工恢复另立项 |
| SMS / WeChat 枚举回归               | 暴露账号 / 绑定状态                                   | 复用现有防枚举码、校验顺序与 throttler；不接任意 current identity                              | 发现响应差异立即阻断对应 step-up endpoint                    |
| 身份变更后旧 refresh 可续期         | 攻击者保留 90d 会话                                   | 身份写 + 全 refresh updateMany + bind/rebind audit 同事务                                      | 网关先关换绑；回退实现但不得取消现有其他撤销场景             |
| pre-auth bind 撤销后新 session 失败 | 用户短时无 refresh                                    | 绑定事务提交后 createSession；客户端可 login-wechat 重登；窄窗口沿现状接受                     | 若故障率不可接受，另评审 outbox / 补偿，禁止本期加 queue     |
| rotated ancestor logout 被当 replay | 正常 logout 失败或误报攻击                            | logout 仅定位 family 并显式撤销；不走 refresh reuse detection                                  | PR2 可独立回退 row-only                                      |
| family updateMany 误伤其他登录      | 其他 device family 被撤                               | where 必须只含命中 `familyId` + active/unexpired；E2E 建两 family 反向锁                       | PR2 独立回退；不得改成 userId logout-all                     |
| audit / log 泄露 proof 或身份值     | 凭据被日志长期保存                                    | `auth.step-up extra` 两字段；logger redact stepUpToken；fixture / snapshot secret scan         | 泄漏即阻断合入并轮换受影响 secret                            |
| enum migration 不可简单回收         | 回退代码后 DB 多一个闲置 enum value                   | additive、无消费者时无害；明确禁止 down migration                                              | 代码回退保留 `IDENTITY_STEP_UP`                              |
| Auth ↔ Users 环依赖                 | Nest 启动失败或 `forwardRef` 扩散                     | Auth export 单责 service；Users 单向 import Auth；Auth 不 import Users                         | 出现环即停，不以 `forwardRef` 绕过                           |
| contract / handoff 漂移             | 客户端误用 token 或漏必填字段                         | PR1 contract +4、snapshot 逐行解释、miniapp + OpenAPI 同 PR true-up                            | snapshot 含额外 route / L3 字段即拒合                        |
| active docs 口径冲突                | 维护者误认为“旧 token”包含 access 与 refresh 同一语义 | PR1 精确写“refresh 撤销、access 15m 不主动撤销”；PR2 精确写 family logout                      | PR0 不回改 active docs；由各实现 PR 同步                     |

---

## 9. 回退方案

1. **第一响应**：先在网关关闭 `PUT /api/app/v1/me/phone` 与 `PUT /api/app/v1/me/wechat` 的换绑入口；Auth 登录 / refresh / logout 与查询保持可用。
2. **PR1 代码回退**：回退 step-up route、DTO、service、身份写编排与 audit / contract 增量；已落地的 additive `SmsPurpose.IDENTITY_STEP_UP` migration **保留**，禁止 down migration。
3. **数据处理**：本方案无 proof table、无 backfill；回退不需删业务数据。已发生的 phone / openid 合法变更与 audit 历史不物理删除。
4. **access / refresh**：已撤销 refresh 不恢复；已签 access 继续按原 exp 自然过期。禁止为了回退重新激活已撤销 token。
5. **PR2 独立回退**：family logout 可单独回退到 row-only service 语义；不影响 PR1 step-up、schema、route 或 DTO。
6. **方案 B 不是回退动作**：只有新增硬需求后另立 D 档，不在事故处理中临时建 `step_up_proofs` 表。

---

## 10. 本次未做（PR0）

- 未修改任何 `src/**`、`prisma/**`、`test/**`、contract snapshot、handoff、active docs、规则文档、CHANGELOG 或既有 archive。
- 未实现 4 个 step-up route、SmsPurpose migration、BizCode、AuditLogEvent、logger redact、User 行锁、refresh 撤销或 family logout。
- 未运行任何 Prisma migration / reset / db push；未连接或写入真实数据库。
- 未引入 Redis / queue / cron / proof table / tokenVersion / access blacklist / 新 permission / Role / seed / throttler。
- 未修改 access token 失效语义；未进入 release / version bump / tag / GitHub Release；未合并 PR。
