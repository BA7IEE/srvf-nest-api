# auth — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);架构边界读 [`/docs/architecture-boundary.md`](../../../docs/architecture-boundary.md);安全相关读 [`/docs/security.md`](../../../docs/security.md)。本文件**只**记录在本目录工作时容易踩雷的本地铁律。

## Scope

- **登录 / 刷新 / 注销 / token 安全链路**:`POST /api/auth/v1/login` / `/refresh` / `/logout` / `/logout-all`(Route B 终态前缀 `auth/v1`)
- **找回密码(pre-auth)**:`POST /api/auth/v1/password-reset/send-code` + `POST /api/auth/v1/password-reset`(2026-06-11;[`password-reset.service.ts`](password-reset.service.ts),冻结评审稿 [`password-reset-by-sms-review.md`](../../../docs/archive/reviews/password-reset-by-sms-review.md);验证码签发/校验在 [`/src/modules/sms/`](../sms/)`SmsCodeService`)
- **OTP(验证码)登录(pre-auth,密码登录的并行方式)**:`POST /api/auth/v1/login-sms/send-code` + `POST /api/auth/v1/login-sms`(2026-06-11;[`login-sms.service.ts`](login-sms.service.ts),冻结评审稿 [`queue-b-otp-birthday-infra-review.md §5`](../../../docs/archive/reviews/queue-b-otp-birthday-infra-review.md);harness reference/auth-jwt-refresh.md 登录契约行已解锁改写,密码登录契约零变化)
- **微信小程序登录 + 绑定(pre-auth,第三个独立认证端点)**:`POST /api/auth/v1/login-wechat` + `POST /api/auth/v1/wechat-bind{,/send-code}`(2026-06-12;[`login-wechat.service.ts`](login-wechat.service.ts),冻结评审稿 [`wechat-mini-login-review.md`](../../../docs/archive/reviews/wechat-mini-login-review.md);code2session 在 [`/src/modules/wechat/`](../wechat/)`WechatService`,绑定锚点 = 手机短信 `SmsPurpose.WECHAT_BIND`;authed 换绑/查询在 users 模块 `me/wechat`)
- **身份绑定 step-up(identity session P0 PR1)**:`POST /api/auth/v1/step-up/password` / `step-up/sms/send-code` / `step-up/sms` / `step-up/wechat`(默认 JWT-protected；[`identity-step-up.service.ts`](identity-step-up.service.ts) 只负责当前因子验证、proof 签发/验证与 `auth.step-up` audit；UsersModule 单向 import AuthModule 消费，AuthModule 禁止反向 import UsersModule)
- **JwtStrategy** 是 v1 唯一鉴权阶段查库点(沿 [`strategies/jwt.strategy.ts`](strategies/jwt.strategy.ts));JwtAuthGuard 不应再写一份查库逻辑
- **不负责**:本人改密(在 [`/src/modules/users/`](../users/)`changeMyPassword`;但改密会**主动撤销**该 user 全部未过期 refresh,沿 P0-E PR-3)、RBAC 判权(在 [`/src/modules/permissions/`](../permissions/))、capabilities 出口(在 `users/app-capability.service.ts`)

## Local facts

- **JwtPayload 最小化**:`{ sub, username }`(沿 [`strategies/jwt.strategy.ts:14`](strategies/jwt.strategy.ts:14));**不**塞 role / 完整用户对象 / tokenVersion
- **JwtStrategy.validate** 每请求按 `payload.sub` 查库,校验 `deletedAt === null && status === ACTIVE`,失败抛 `UNAUTHORIZED`(沿 [`strategies/jwt.strategy.ts:41`](strategies/jwt.strategy.ts:41))
- **refresh token 入库只存 hash**:`sha256(raw).hex`(64 字符),DB 字段 `refresh_tokens.tokenHash @unique`;明文只在 login / refresh 响应的 `data.refreshToken` 出现一次(沿 [`refresh-token.util.ts:23`](refresh-token.util.ts:23))
- **refresh rotation always + family revoke + reuse detection**:`rotatedAt !== null` 命中视为重放 → family revoke + audit `replayDetected/familyRevoked`(沿 [`auth.service.ts:199`](auth.service.ts:199))
- **refresh expiresAt absolute**:rotation 后继承原 family 首个 token 的 `expiresAt`,**不**延长(沿 [`auth.service.ts:278`](auth.service.ts:278))
- **login 失败统一** `BizCode.LOGIN_FAILED = 10004`,5 类失败场景同响应体(防账号枚举);任一路径**必跑**一次 `bcrypt.compare`(命中走真 hash / 未命中走 `TIMING_DUMMY_HASH`)(沿 [`auth.service.ts:43`](auth.service.ts:43))
- **refresh 失败统一** `BizCode.REFRESH_TOKEN_INVALID = 10007`,4 子原因(不存在 / 已撤销 / 已过期 / 重放)不区分;token 不存在时**不写 audit**
- **logout 幂等 / 限流当前事实**:`/auth/logout` 不存在 / 已撤销 / 已过期均返 200,但 finding #9 加固后**仅真实命中并完成撤销时**写 `auth.logout`(`extra.found=true`),未知/失效 token 零 audit;当前**未挂限流装饰器**(沿评审稿 §3.7 D-7,避免攻击者吃光合法用户配额);保持当前 logout / logout-all 的幂等、撤销与限流语义,如需调整幂等或限流策略,必须先做安全评审并补测试
- **logout-all** 撤销该 user 全部未过期且未撤销的 refresh;当前复用 `@PasswordChangeThrottle()`
- **access token 当前不主动吊销**(沿 D-4):由 `JWT_EXPIRES_IN` 自然过期 + JwtStrategy 每请求查库阻断 DISABLED / 软删用户;保持当前策略,如需引入 blacklist / Redis / tokenVersion 必须走设计决议
- **password change**:本人改密在 [`users.service.ts:249`](../users/users.service.ts:249) 主动撤销该 user 全部未过期 refresh(`revokedReason='self-password-change'`);旧 access 仍可调直至自然过期(e2e 反向锁定)
- **password reset by SMS(pre-auth,2026-06-11)**:校验顺序**冻结**(评审稿 E-5)= 解析用户 → 码预检不消费 → 10006 不烧码 → 原子消费 → 事务(改密 + 撤销全部未撤销未过期 refresh `'self-password-reset'`〔联动撤销第 5 场景,harness reference/auth-jwt-refresh.md〕+ audit);**防枚举** = 四种无效号码场景(不存在 / 未绑定 / 禁用 / 软删)send-code 返回与有效号完全相同泛化 200 且零留痕,reset 一切失败统一 `SMS_CODE_INVALID=24010`;成功 `data:null` 不自动登录;旧 access 沿 D-4 不吊销(e2e 正向断言)
- **OTP 登录(pre-auth,2026-06-11)**:校验顺序**冻结**(评审稿 E-O5)= 解析用户(四无效场景 → 24010)→ `verifyAndConsume(LOGIN)` 原子消费 → `AuthService.createSession`(与密码登录**同一签发路径**,E-O6:同 `LoginResponseDto` / 同 refresh family / lastLoginAt 同步 / audit `auth.login.sms`);**防枚举** = send-code 四无效场景泛化 200 零留痕,登录一切失败统一 `SMS_CODE_INVALID=24010`(**不用 10004**,两套防枚举体系各自闭合);不更新 `phoneVerifiedAt`;号码无账号不自动注册
- **`createSession` 是唯一会话签发点**(login / login-sms / login-wechat 三种登录方式共用;原 login 第 5-8 步原样抽取,行为锁 = auth 既有 e2e 断言零修改全绿):改签发逻辑 = 同时改三种登录方式,按 D 档降速
- **微信登录(pre-auth,2026-06-12)**:login-wechat = code2session → 已绑 `createSession` / 未绑 `{bindingRequired:true, session:null}`(非枚举面);命中但账号 DISABLED/软删 → 统一 25010(防侧写);wechat-bind **七步校验顺序冻结**(评审稿 §4.3)= code2session 最前(失败不烧 SMS 码)→ 解析手机号(四无效 → 24010)→ 码预检不消费 → openid 占用(他人 → 25002,仅对已证手机控制权者可达)→ 原子消费 → 绑定事务 + audit → createSession;openid 占用**含软删**;wx code / session_key / 完整 openid 三不入日志响应 audit
- **identity step-up proof**:action 恰好 `PHONE_BIND/WECHAT_BIND`、factor 恰好 `PASSWORD/SMS/WECHAT`；JWT secret 经 HKDF-SHA256 派生 `signing.v1` / `snapshot.v1` 两把 32-byte key，audience 固定 `srvf.identity-step-up`、TTL 固定 300s；snapshot HMAC 输入固定覆盖 `id/passwordHash/phone/phoneVerifiedAt/openid/status/deletedAt`。签名/过期/audience/sub/action/snapshot 失败统一 10008，不细分；无当前 phone/openid 返 10009；`JwtPayload` 仍严格 `{sub,username}`。
- **pre-auth 微信真实 bind/rebind 的会话顺序**:`user.update` + 旧 refresh 全撤销(`self-wechat-identity-change`) + bind/rebind audit 同一 transaction；提交后才 `createSession` 新 family。already-bound-to-self 仍 no-op，不撤旧 family、不写变更 audit。
- **audit events 10 个**(本模块写路径,全部经 `AuditLogsService`):`auth.login` / `auth.login.sms`(extra `familyId` + `phone` 掩码 + `codeId`)/ `auth.login.wechat`(extra `familyId` + `openid` 掩码)/ `auth.refresh` / `auth.logout` / `auth.logout-all` / `password.reset.by-sms`(actor=本人;extra `refreshTokensRevoked` + `phone` 掩码 + `codeId`)/ `wechat.bind.self` / `wechat.rebind.self`(bind 路径,extra `viaPath:'pre-auth'` + `phone` 掩码 + `codeId`;users 模块 me/wechat 路径同名事件 `viaPath:'me'`)/ `auth.step-up`(仅成功签发；extra 恰好 `action/factor`);extra 字段**禁止**任何 proof、snapshot、明文 / hash / 完整号码 / 完整 openid
- **限流复用**:step-up password/SMS send/SMS verify/WeChat 分别复用 `password-change` / `sms-send` / `sms-verify` / `login-wechat` 既有实例；不新增 throttler、不改限额/storage/header。命中抛 `TOO_MANY_REQUESTS`，**不**返 `X-RateLimit-*` / `Retry-After` 头。
- **AuthModule 唯一 strategy** 是 `JwtStrategy`;**无** LocalStrategy(沿 [`auth.module.ts:40`](auth.module.ts:40))

## Risk points (不要做)

- ❌ **不**给 `JwtPayload` 加 role / tokenVersion / 完整用户对象等任何额外字段(沿 ARCHITECTURE.md §7.6 + P0-E v1 D-4)
- ❌ **不**在 JwtAuthGuard 再写一份用户有效性查库(每请求查库的唯一点是 `JwtStrategy.validate`)
- ❌ **不**在本 PR / 普通改动里引入 access token blacklist / Redis 撤销 / tokenVersion 强一致;当前 access 不主动吊销是显式策略,如需变更必须走设计决议
- ❌ **不**把 refresh token 明文写入 DB / 日志 / audit / OpenAPI 示例 / e2e fixture / 文档示例(沿评审稿 §5.1)
- ❌ **不**把 `stepUpToken` / proof payload / snapshot / password / SMS 或 wx code 写入日志、audit、示例或 App 响应；logger redaction 必须同时覆盖精确与通配字段
- ❌ **不**弱化 refresh rotation / family revoke / reuse detection 语义;判断顺序 `rotatedAt → revokedAt → user inactive` 不可调换
- ❌ **不**让 login 失败响应在 5 类场景间出现可区分 timing / message / status — 防账号枚举
- ❌ **不**绕过 `TIMING_DUMMY_HASH`;命中或未命中都必须跑一次 `bcrypt.compare`
- ❌ **不**在本 PR / 普通改动里调整 `/auth/logout` 幂等或限流策略;如需调整必须先做安全评审并补测试
- ❌ **不**引入 LocalStrategy / OAuth / passport-\* 其他策略(无设计决议)
- ❌ **不**改 `AuditMeta` 构造方式为隐式(cls-rs / AsyncLocalStorage);沿 controller `buildAuditMeta(req)` 显式传(沿 D6 v1.1 §11.2 / D8)
- ❌ **不**破坏 password-reset 防枚举一致性:不为"号码不存在 / 禁用 / 软删"开任何可区分响应(字段 / message / 错误码细分);不在 send-code 写无效号侧痕;不把 10006 检查挪到码预检之前(密码 oracle);不让 reset 返回 token / 用户字段
- ❌ **不**破坏 login-sms 防枚举一致性(同上范式):登录失败永远统一 24010,**不**细分、不混用 10004/10005;不在密码登录端点混入手机号/验证码入参(harness reference/auth-jwt-refresh.md 改写后契约);不给 OTP 登录加"自动注册"或"OTP+密码二要素"(goal 禁止域)
- ❌ **不**破坏微信登录防侧写一致性:login-wechat 对"账号禁用/软删"不开可区分响应(统一 25010);wechat-bind 七步顺序不可调换(25002 必须在码预检后;code2session 必须最前);不给微信登录加"自动注册"/ unionid·session_key 存储 / 本人裸解绑(评审稿 §12 本期不做)
- ❌ 本目录任何"普通 docs-only"以外的改动都**非低风险**;改 token 链路 / payload / 错误码 / 限流均按 D 档降速,并跑安全相关 e2e

## Validation

- `pnpm lint` + `pnpm typecheck`
- `pnpm test` — 覆盖 `auth.service` / `refresh-token.util` 单测
- `pnpm test:e2e -- auth` — 覆盖登录 / 刷新 / 注销 / logout-all e2e
- 改 audit event / extra → 必须跑 auth characterization e2e(若存在)
- 改 DTO 字段 / endpoint path / Swagger schema / 错误码 → 必须再跑 `pnpm test:contract`
