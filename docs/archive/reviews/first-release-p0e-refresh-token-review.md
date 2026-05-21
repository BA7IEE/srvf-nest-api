# P0-E refresh token / logout 评审稿 v1(PR-1 评审稿,非执行稿)

> **状态**:**v1 正式版,D 档前置评审稿,非执行稿**。
> 本文档**不是**代码实现说明,**不是**铁律修订(铁律修订归 PR-2)。
> 本文档冻结 P0-E refresh token / logout 的设计决策,供后续 PR-2 / PR-3 / PR-4 严格按本评审稿落地。
>
> **冲突优先级**(沿 [`process.md §6`](process.md)):`ARCHITECTURE.md` > `CLAUDE.md` / `AGENTS.md` > `docs/srvf-foundation-baseline.md` > `docs/V2红线与复活路径.md` > **本评审稿** > handoff > `current-state.md` > `process.md`。冲突时本评审稿让步。
>
> **不在本文范围**:接口字段细节(回 [`v2-api-contract.md`](v2-api-contract.md));BizCode 全量翻译(回 [`first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md));前端联调范围调整(归 PR-4);现有 readiness-plan / frontend-scope / bootstrap-sop / bizcode-mapping / current-state / security 的回填(归 PR-4);代码落地细节(归 PR-3 实施稿);`CLAUDE.md` / `AGENTS.md` 铁律修订(归 PR-2)。
>
> **本稿是评审稿,不代表已经允许直接写代码**。PR-2(铁律解锁)merged 之前,**禁止**开 PR-3(代码 PR);PR-3 启动前**必须**重读本评审稿 §10 复核点 + 评审稿冻结前置(沿 P0-D 评审稿 4-PR 串行范式 #115 → #116 → #117 → #118)。

---

## §0 用途与定位

### 0.1 解决什么问题

第一版前端联调起步包准备就绪([P0-A](first-release-frontend-scope.md) / [P0-G](first-release-bizcode-mapping.md) / [P0-C](first-release-bootstrap-sop.md) / [P0-D](first-release-p0d-change-my-password-review.md) 全部已落地于 v0.13.0),但第一版上线后**没有任何 token 生命周期管理能力**。带来四个具体痛点:

1. **真实下线能力缺失**:管理员被解雇后,运维只能 `PATCH /api/users/:id/status` 改 `DISABLED` 间接阻断;`DISABLED` 语义是"封号",比"下线"重,且**不可逆**直到管理员手动 `ACTIVE`。
2. **本人下线能力缺失**:用户在公共电脑 / 共享设备登录后,**无任何接口**让其主动注销当前会话;`JWT_EXPIRES_IN=7d` 默认情况下,token 留在浏览器 / Keychain 中长达 7 天。
3. **改密无法吊销已发 token**:P0-D 本人改密(`PUT /api/users/me/password`)与管理员重置(`PUT /api/users/:id/password`)都**不主动吊销旧 token**,沿 [`security.md` Token 吊销升级路径](security.md);改密后 ≤ 7d 旧 token 仍可调任意业务接口。
4. **无感续期 / 长在线体验缺失**:前端期望"短 access token + 长 refresh token"模式;当前 7d 单 token 模型既不安全(长窗口被偷),也不友好(到期一刀切跳登录页)。

P0-E 的最小目标:让任意登录用户能主动 logout,让 access token TTL 收敛到 15 分钟,引入 refresh token 承接续期与主动撤销,**且不破** v1 已建立的安全模型(JWT payload 仍最小、JwtStrategy 每请求查库、不引入 Redis)。

### 0.2 本评审稿的边界

- 本评审稿**只**讨论 refresh token + logout + logout-all 三类接口与配套撤销策略。
- 本评审稿**不**讨论 RBAC 收紧(归 P0-F)、上传下载闭环(归 P0-B)、首次登录强制改密 / 邮箱找回(归 P1 / P2)、`tokenVersion` 字段(本期**不做**,详见 §3.3)。
- 本评审稿**不**改任何运行时代码 / schema / migration / seed / 测试 / OpenAPI snapshot。
- 本评审稿**不**改 readiness-plan / frontend-scope / bizcode-mapping / bootstrap-sop / current-state / security(这些状态回填归 PR-4)。
- 本评审稿**不**改 `CLAUDE.md` / `AGENTS.md`(铁律修订归 PR-2)。

### 0.3 谁拍板了什么

本评审稿 v1 的全部决策点已由用户拍板(2026-05-17 P0-E 评审会话);9 条决策见 §3。
**PR-2 / PR-3 启动前**仍需:
- PR-1(本 PR)merged → PR-2 启动
- PR-2 merged → PR-3 启动(沿 §10 复核点逐项再读一遍)
- PR-3 执行 `prisma migrate dev` 前,**必须**先回到对话贴出预生成 SQL 等用户确认(沿 [`CLAUDE.md §0`](../CLAUDE.md))

---

## §1 当前事实盘点

> 本节带文件 + 行号引用,凡判断必有证据;v1 / V1.1 / V2 / V2.x 历史决策不重述。

### 1.1 已有能力(login + jwt-strategy + 限流)

| 能力 | 接口 / 模块 | 关键约束 |
|---|---|---|
| 登录 | `POST /api/auth/login`([auth.controller.ts:23-33](../src/modules/auth/auth.controller.ts:23))| `@Public()` + `@LoginThrottle()`(default throttler,5 次 / 60 秒,IP 维度);响应 `{ accessToken, tokenType: 'Bearer', expiresIn }`(沿 [auth.dto.ts:42-54](../src/modules/auth/auth.dto.ts:42)) |
| 防账号枚举 | `auth.service.ts:49-103` | 四场景统一 `LOGIN_FAILED=10004` + HTTP 401;timing 抹平(`bcrypt.compare` 必跑一次,未命中走预生成 dummy hash) |
| JWT 签发 | `JwtModule.registerAsync`([auth.module.ts:25-31](../src/modules/auth/auth.module.ts:25))| 仅 `secret + expiresIn`;`JWT_EXPIRES_IN=7d`(沿 [.env.example:25-27](../.env.example));**未设** `issuer` / `audience` / `jwtid` |
| JWT payload | `JwtPayload { sub, username }`([jwt.strategy.ts:14-17](../src/modules/auth/strategies/jwt.strategy.ts:14))| **不**塞 role / permissions / tokenVersion;e2e 硬断言 payload 字段集恰好为 `{ sub, username, iat, exp, nbf }`(沿 [auth-login.e2e-spec.ts:47-67](../test/e2e/auth-login.e2e-spec.ts:47)) |
| JwtStrategy 每请求查库 | `JwtStrategy.validate`([jwt.strategy.ts:41-53](../src/modules/auth/strategies/jwt.strategy.ts:41))| select 字段 `{ id, username, role, status, memberId }`,**不读** `passwordHash`;校验 `deletedAt === null && status === ACTIVE`,任一失败 → `UNAUTHORIZED=40100` |
| memberNo 登录回退 | `auth.service.ts:60-74` | V2 唯一服务端语义扩展(沿 [v2-api-contract §6.6](v2-api-contract.md));`LoginDto` schema zero drift |
| 登录限流 | `default` throttler([throttle-options.ts:17-23](../src/bootstrap/throttle-options.ts:17))| 5/60 IP;命中 → `TOO_MANY_REQUESTS=42900` + HTTP 429;`setHeaders: false` 关闭 `Retry-After` / `X-RateLimit-*` 头 |
| 改密限流 | `password-change` throttler([throttle-options.ts:24-28](../src/bootstrap/throttle-options.ts:24))| 5/60 IP;与登录物理隔离;P0-D #117 已落地 |
| 改密 audit | `password.change.self`([audit-logs.types.ts:40](../src/modules/audit-logs/audit-logs.types.ts:40))| P0-D #117 已落地;事件名风格 `<resource>.<action>.<scope>` kebab-case |

### 1.2 明确不存在的能力

- **logout 接口**:全仓 grep,`AuthController` 仅 33 行,只有 `POST /login`。
- **refresh token 接口 / 数据模型**:全仓 grep `refresh|RefreshToken|tokenVersion` 仅命中:
  - [`src/bootstrap/logger-options.ts:37,44`](../src/bootstrap/logger-options.ts:37) — 日志 redact 列表(`req.body.refreshToken` / `*.refreshToken`)
  - **无任何** Prisma model / service / controller / DTO / migration
- **改密后吊销旧 token**:沿 [`security.md` Token 吊销升级路径](security.md);v1 / V1.1 / V2 / V2.x / P0-D 全程明文不做。
- **强制下线机制**:**仅有**用户态阻断(`PATCH /api/users/:id/status` → `DISABLED`,经每请求查库立即生效);**没有** token 态吊销路径。
- **多设备会话管理 UI**:无任何"已登录设备列表 / 强制下线某台设备"接口或 schema。

### 1.3 当前 token 吊销补偿方案(只有用户态阻断)

| 场景 | 当前补偿手段 | access token 失效时机 | refresh token 失效时机 |
|---|---|---|---|
| 用户被解雇 → 立即下线 | `PATCH /:id/status` → `DISABLED` | **下一次请求即失效**(每请求查库) | N/A(无 refresh) |
| 用户改密(本人 / 管理员)| 无 | **不失效**,旧 token ≤ 7d 仍可用 | N/A |
| 用户公共电脑登录后离开 | 无 | 等 7d 自然过期 | N/A |
| 系统级紧急吊销(怀疑 secret 泄露)| 改 `JWT_SECRET` | 全员旧 token 立即失效(登出风暴)| N/A |

### 1.4 BizCode 段位现状(P0-E 涉及段)

沿 [biz-code.constant.ts](../src/common/exceptions/biz-code.constant.ts) + [baseline §1.1](srvf-foundation-baseline.md):

- `40100 UNAUTHORIZED`:`JwtStrategy.validate` 失败统一码(不可被细分)
- `42900 TOO_MANY_REQUESTS`:throttler 命中统一码
- `100xx` users 业务级,**已用 10001-10006**(P0-D #117 占 10005 / 10006);**10007 是下一可用号位**
- ARCHITECTURE.md §7.3 行 462-464 明确授权:"出现 refresh token 需细分原因(`REFRESH_TOKEN_EXPIRED` vs `REFRESH_TOKEN_REVOKED`)的需求时,才在 100xx 段新增"

### 1.5 OpenAPI contract snapshot 约束

- 单文件 snapshot `test/contract/__snapshots__/openapi.contract-spec.ts.snap`,zero drift(沿 [docs/current-state.md §2](current-state.md))
- v1 14 接口 schema 永久 zero drift(沿 [`v2-api-contract.md §6.1 / §6.5`](v2-api-contract.md))
- `LoginDto` 字段 / 校验装饰器是**硬约束**(沿 [`v2-api-contract.md §6.5 / §6.6.1`](v2-api-contract.md));P0-E **不**改 `LoginDto`
- `LoginResponseDto` **不**在该硬约束列表内,P0-E 扩展 2 个字段(详见 §4.1)
- 沿 P0-D PR-3 #117 / handoff v0.13.0 §0 验收范式,**任何 P0-E 实施 PR 必须保证 snapshot diff 仅新增,不删除**

### 1.6 现有 e2e 测试覆盖边界(P0-E 涉及部分)

- `test/e2e/auth-login.e2e-spec.ts` — 11 用例;**含** payload 字段集硬断言(line 47-67)+ 防账号枚举四场景 body 全等
- `test/e2e/auth-jwt-guard.e2e-spec.ts` — 7 用例;含 `DISABLED` / 软删立即失效 + 过期 1ms
- `test/e2e/auth-login-throttle.e2e-spec.ts` — 4 用例
- `test/e2e/auth-memberno-login.e2e-spec.ts` — memberNo 全套
- `test/e2e/users-change-my-password.e2e-spec.ts` — P0-D 21 用例;**含** §7.5 "改密后旧 token 仍可调 `/me`" 反向锁定断言(line 21-23)

---

## §2 文档偏差修正(本 PR 不动,留 PR-4)

[`first-release-readiness-plan.md §3.1 P0-E`](first-release-readiness-plan.md) 当前措辞写"第一版**不一定**做 refresh token,但必须明确'用户体验上 token 过期怎么办'(前端处理重登 vs 后端发 refresh token)"。**本评审稿已锁定方向**:**做** refresh token + logout + logout-all,推荐 access 15m + refresh 90d(沿 §3.5 D-5)。

修正动作:

- 本 PR(PR-1)**不动** readiness-plan,只在本评审稿记录偏差。
- PR-4 在 P0-E 状态回填时,把 readiness-plan §3.1 P0-E 状态从"待立项 / 必须先评审"改为"✅ 已落地",措辞同步本评审稿决策。

---

## §3 已决策(用户拍板,9 条)

> 本节是 P0-E 的**设计骨架**,PR-3 严格按本节实施;任何偏离本节的实现均视为越权。

### 3.1 决策 D-1:LoginResponseDto 扩展 2 字段
**已决策**:`LoginResponseDto` 新增 `refreshToken: string` + `refreshExpiresAt: string` 字段(向后兼容;旧前端忽略未知字段)。
- `LoginDto` 入参 schema 严格 **zero drift**(沿 [`v2-api-contract.md §6.5`](v2-api-contract.md))
- `LoginResponseDto` 出参由 4 字段(`accessToken / tokenType / expiresIn` + 新增 `refreshToken / refreshExpiresAt`)= **5 字段**(`tokenType` 仍为字面量 `'Bearer'`)
- `refreshToken` 是**不透明随机字符串**(`crypto.randomBytes(32).toString('base64url')`),**不是 JWT**;客户端不应也不能解析其中信息
- **`refreshExpiresAt` 语义**(2026-05-18 修正,沿评审稿 docs hotfix):
  - **类型**:`string`,固定 **ISO 8601 UTC 时间字符串**(`new Date(...).toISOString()` 输出格式,带毫秒 + `Z` 后缀;示例 `"2026-06-17T00:00:00.000Z"`)
  - **语义**:**refresh token family 的 absolute expiration 时刻**(不是 TTL,不是相对时长)
  - **来源**:login 首次签发时 `refreshExpiresAt = new Date(now + JWT_REFRESH_EXPIRES_IN).toISOString()`,与 `refresh_tokens.expiresAt` DB 字段同值同序列化
  - **rotation 行为**:`POST /api/auth/refresh` rotation 出来的新 refresh token **继承同一个 `refreshExpiresAt`**,响应里返回**相同的 ISO 时刻字符串**(absolute expiration / 沿 D-5;**不做** sliding expiration / refresh-on-use 延期)
  - **客户端用法**:客户端读 `refreshExpiresAt` 即知 family 何时过期;**无需** `now + TTL` 计算,**无需**信任本地时钟;rotation 后仍是同一时刻
  - **服务端 env 配置仍叫** `JWT_REFRESH_EXPIRES_IN`(代表 TTL 配置,如 `"90d"`);**响应字段叫** `refreshExpiresAt`(代表绝对时刻);两者职责分离(沿 §9 影响清单)
  - **刻意不返 TTL 字符串形态**(如 `"90d"`,沿 `expiresIn` 范式):TTL 形态让客户端必须信任本地时钟做 `now + TTL` 计算,跨设备时钟漂移会导致 family 续期失败;ISO 时刻形态消除此风险

### 3.2 决策 D-2:本期落地 3 个新接口
**已决策**:本期(P0-E)落地三个新 API 端点:
- `POST /api/auth/refresh`(rotation always + family revoke + absolute expiration)
- `POST /api/auth/logout`(撤销当前 refresh token;不吊销 access)
- `POST /api/auth/logout-all`(撤销该 user 所有未撤销且未过期的 refresh token)

详细契约见 §4。

### 3.3 决策 D-3:四种敏感事件撤销 refresh
**已决策**:以下四种事件**主动撤销**目标用户所有 refresh token(`updateMany`):
1. 本人自助改密(`PUT /api/users/me/password`)`revokedReason='self-password-change'`
2. 管理员重置他人密码(`PUT /api/users/:id/password`)`revokedReason='admin-password-reset'`
3. 用户被禁用(`PATCH /api/users/:id/status` → `DISABLED`)`revokedReason='admin-disable'`
4. 用户被软删除(`DELETE /api/users/:id`)`revokedReason='admin-delete'`

详细行为见 §8 / §9。
**access token 不主动吊销**(沿 D-4);access token 在其 ≤ 15m TTL 内仍可用是预期代价。

### 3.4 决策 D-4:不做 tokenVersion
**已决策**:本期**不**做 `tokenVersion` 字段;**不**改 JWT payload。
- `User` schema **零变更**(沿 P0-D 范式)
- `JwtPayload` 仍 `{ sub, username }`;e2e 硬断言("payload 字段集恰好 `{ sub, username, iat, exp, nbf }`")保留
- `JwtStrategy.validate` 仍只看 `deletedAt + status === ACTIVE`,**不读** `passwordHash`,**不读** `tokenVersion`
- 后果接受:改密 / 禁用 / 删除事件触发后,目标用户已签发 access token 在其剩余 TTL(≤ 15m)内仍可用;refresh token 已撤销,无法换新 access

### 3.5 决策 D-5:TTL = access 15m / refresh 90d / absolute expiration
**已决策**:
- access token TTL:`15m`(`JWT_EXPIRES_IN=15m`;由当前 `7d` 收敛)
- refresh token TTL:`90d`(`JWT_REFRESH_EXPIRES_IN=90d`)
- **absolute expiration**:rotation 出来的新 refresh token `expiresAt` **不延长**,继承原 family 首个 token 的 `expiresAt`(沿 OWASP "Refresh token MUST have absolute expiration")
- **不做** sliding expiration(避免 "refresh token 永不过期" 的安全收益消失)
- **达到 `refreshExpiresAt` 后必须重新登录**(`POST /api/auth/login`);refresh 接口对已过期 family 返 `REFRESH_TOKEN_INVALID=10007`(沿 §6.5);客户端不应也不能"自动续期"绕过此约束

**为什么 90d 而不是 30d**(2026-05-18 由 P0-E v1 docs hotfix 从 30d 调整为 90d):
- **业务侧**:本系统是**深圳救援队内部管理系统**,主要用户是队员与管理员(沿 [`.claude/CLAUDE.md` Project Background](../.claude/CLAUDE.md));内部系统使用频次比公网 SaaS 低,30d 会让低频使用者(如月度 / 季度参与活动的志愿队员)频繁触发 absolute expiration → 跳登录页 → 误以为账号失效;90d 把"必须重登"周期对齐到"季度"心智(3 个月一次),与队员实际使用节奏相符
- **安全侧**:仍坚守 absolute expiration(不是"永不过期";沿 OWASP 红线);rotation always + family revoke + 改密 / 禁用 / 删除联动撤销四道防线仍生效;90d 仅放宽 absolute 上限,**不**放宽其他任一防线
- **运维侧**:`refresh_tokens` 表数据量可能膨胀 3x(rotation 每次 +1 行,90d 窗口),由 §5.4 顺手清理策略缓解;若量级失控再立项 cron(沿 §13.3 反模式表)
- **不是**因为"用户体验更顺",而是因为"低频内部使用场景下,30d 误伤面 > 90d 安全代价";若未来切换为公网 SaaS / 高频应用 / 多租户场景,**必须**重新评估并回到本节修订
- **如未来需调整**:`JWT_REFRESH_EXPIRES_IN` 是 env,运维侧可在不发版的情况下回调(例如真出现频发被盗 refresh 事件时改回 30d);**但**调整后**已签发**的 refresh token 仍按其 `expiresAt` 计算,**不**回溯

### 3.6 决策 D-6:BizCode 仅新增 1 个,不拆细
**已决策**:仅新增 `REFRESH_TOKEN_INVALID = 10007`(HTTP 401)。
- **不拆**`REFRESH_TOKEN_EXPIRED` / `REFRESH_TOKEN_REVOKED` / `REFRESH_TOKEN_REPLAY`
- 沿 v1 §8 防账号枚举语义:refresh 失败的 4 种子原因(不存在 / 已撤销 / 已过期 / 重放命中)统一返 10007,**响应体 + HTTP status + message 完全一致**

### 3.7 决策 D-7:限流参数
**已决策**:
- `POST /api/auth/refresh`:**新建独立 throttler 实例** `refresh`,IP 维度 `30 次 / 60 秒`
- `POST /api/auth/logout`:**无限流**(刻意;避免攻击者把合法用户的 logout 配额吃光让其无法登出)
- `POST /api/auth/logout-all`:**复用 `password-change` throttler**(IP 维度 5/60;沿 P0-D 语义"高危操作低频限流")
- 命中全部走统一 `TOO_MANY_REQUESTS=42900` + HTTP 429;**不暴露** `Retry-After` / `X-RateLimit-*` 头(沿 [throttle-options.ts:30](../src/bootstrap/throttle-options.ts:30))

### 3.8 决策 D-8:新增 4 个 audit 事件
**已决策**:`AuditLogEvent` union 新增 4 项(命名风格沿 P0-D `password.change.self` 与现有 17 项 kebab-case `<resource>.<action>` / `<resource>.<action>.<scope>`):
- `auth.login`(login 成功路径写入)
- `auth.refresh`(refresh 成功路径写入)
- `auth.logout`(logout 路径写入,含幂等命中"已撤销 / 已过期 / 不存在"也写,extra.found ∈ {true,false})
- `auth.logout-all`(logout-all 路径写入,extra.revokedCount: number)

**命名风格 PR-3 启动前再次复核**(沿 [P0-D 评审稿 §9.1 范式](first-release-p0d-change-my-password-review.md))。

### 3.9 决策 D-9:本期不做的扩展能力
**已决策**:以下能力本期(P0-E)**不做**,出现真实诉求时单独立项:
- ❌ `GET /api/auth/refresh-tokens`(查询本人活跃 refresh token 列表)
- ❌ "已登录设备列表" UI(`device_name` / `last_seen_at` 等"列表展示"字段)
- ❌ 单设备管理(`DELETE /api/auth/refresh-tokens/:id` 强制下线某台设备)
- ❌ 完整 OAuth 2.0 / OIDC / refresh token tree 复杂度
- ❌ device fingerprint / 浏览器指纹采集
- ❌ `httpOnly` cookie 传递(多端 Web + 小程序 + APP,统一 body 传 refresh)
- ❌ Redis / Queue / Cron(沿 [`CLAUDE.md §1 B 档`](../CLAUDE.md) + V1.1 §17.3)
- ❌ access token 黑名单(只做 refresh token 撤销)
- ❌ 改 `LoginDto` 入参 schema(沿 v2-api-contract §6.5)
- ❌ `tokenVersion` 字段(D-4 已决策)
- ❌ 微信小程序 / OAuth 第三方登录

---

## §4 接口契约(代码 PR 必须严格遵循)

### 4.1 POST /api/auth/login(扩展 2 字段,不改入参)

**入参**:`LoginDto { username, password }`,**严格 zero drift**(字段名 / 类型 / `@Matches` / `@MinLength` / `@MaxLength` 全保留;沿 [auth.dto.ts:14-40](../src/modules/auth/auth.dto.ts:14))。

**响应**:`LoginResponseDto`,新增 2 字段;**新增**响应字段集恰好 5 项:

```jsonc
// 草案示例(实际值由代码 PR 阶段生成;refreshToken 占位符,绝不入仓库)
// refreshExpiresAt 是 ISO 8601 UTC 字符串(family absolute expiration;详见 §3.1 D-1)
{
  "code": 0,
  "message": "ok",
  "data": {
    "accessToken": "<JWT>",
    "tokenType": "Bearer",
    "expiresIn": "15m",
    "refreshToken": "<opaque-256bit-base64url>",
    "refreshExpiresAt": "2026-06-17T00:00:00.000Z"
  }
}
```

**行为补充**:
- login 成功时 service 内同步签 access token + 创建 1 条 `refresh_tokens` 行(`familyId = cuid()`,`expiresAt = now + 90d`,`tokenHash = sha256(rawRefresh)`)+ 写 audit `auth.login`
- `lastLoginAt` 仍 fire-and-forget 更新(沿现状 [auth.service.ts:88-95](../src/modules/auth/auth.service.ts:88))
- audit `extra` 写 `{ familyId }`(便于审计串联同 family 的后续 refresh / logout 事件)
- e2e payload 字段集硬断言更新:`Object.keys(payload)` 仍只 ∈ `{ sub, username, iat, exp, nbf }`(refresh 流**不**改 JWT payload;沿 D-4)

**BizCode**:沿现状(`40000 BAD_REQUEST` / `10004 LOGIN_FAILED` / `42900 TOO_MANY_REQUESTS`),**无新增**。

### 4.2 POST /api/auth/refresh(新增)

**鉴权**:`@Public()`(refresh 时 access token 通常已过期,**不能**走 `JwtAuthGuard`)。

**限流**:`@RefreshThrottle()`(新装饰器;走独立 throttler 实例 `refresh`,30/60 IP)。

**入参**:`RefreshTokenDto`,严格白名单 1 字段:
```typescript
class RefreshTokenDto {
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}
```

**响应**:**同 `LoginResponseDto`**(rotation 必发**新** accessToken + **新** refreshToken;`refreshExpiresAt` **严格继承原 family 首个 token 的 `expiresAt`** ISO 8601 UTC 时刻字符串,响应**返回相同的时刻字符串**,**不延长**;沿 D-5 absolute expiration + §3.1 D-1 语义)。

**BizCode**:`40000 BAD_REQUEST`(DTO 校验) / `10007 REFRESH_TOKEN_INVALID`(refresh 失败统一码) / `42900 TOO_MANY_REQUESTS`(限流命中)。

**行为(伪逻辑,仅描述意图)**:

```
1. raw = body.refreshToken;tokenHash = sha256(raw).hex
2. prisma.$transaction(async tx => {
   a. row = tx.refreshToken.findUnique({ where: { tokenHash } })
   b. row 不存在 / row.revokedAt != null / row.expiresAt <= now() → 抛 REFRESH_TOKEN_INVALID
      (不区分子原因;响应体 / HTTP status / message 完全一致)
   c. 重放检测:row.rotatedAt != null 命中(攻击者拿旧 raw 重放)
      → tx.refreshToken.updateMany({
           where: { familyId: row.familyId, revokedAt: null },
           data: { revokedAt: now(), revokedReason: 'family-revoked' }
         })
      → audit 'auth.refresh' with extra.replayDetected=true, extra.familyRevoked=true
      → 抛 REFRESH_TOKEN_INVALID
   d. user = tx.user.findFirst({ where: { id: row.userId, deletedAt: null } })
   e. user 不存在 / user.status !== ACTIVE
      → tx.refreshToken.update({ where: { id: row.id }, data: { revokedAt: now(), revokedReason: 'family-revoked' } })
        + tx.refreshToken.updateMany 同 family(防止旁路签发链可换 access)
      → 抛 REFRESH_TOKEN_INVALID
   f. 生成 newRaw = crypto.randomBytes(32).toString('base64url');newHash = sha256(newRaw)
   g. newRow = tx.refreshToken.create({ data: {
        tokenHash: newHash, userId: row.userId, familyId: row.familyId,
        expiresAt: row.expiresAt /* absolute,继承原 family */,
        ipFirstSeen: <login 时已写,本次不更新>,
        uaFirstSeen: <同上>,
      }})
   h. tx.refreshToken.update({ where: { id: row.id }, data: {
        rotatedAt: now(), revokedAt: now(), revokedReason: 'rotated', replacedById: newRow.id
      }})
   i. accessToken = jwt.sign({ sub: user.id, username: user.username })
   j. auditLogs.log({ event: 'auth.refresh', actorUserId: user.id,
                      extra: { familyId: row.familyId, replayDetected: false }, tx })
3. 返回 LoginResponseDto(accessToken, 'Bearer', '15m', newRaw, row.expiresAt.toISOString())
   // refreshExpiresAt 严格继承原 family 首个 token 的 expiresAt,absolute expiration,不延长(沿 §3.1 D-1)
})
```

**timing 防御**:三种"refresh 失败"路径(不存在 / 已撤销 / 已过期)耗时统计上不可区分(sha256 ≪ 1ms,DB findUnique 同一索引 sub-ms,差异不可统计)。

### 4.3 POST /api/auth/logout(新增)

**鉴权**:`@Public()`(refresh token 本身已是凭证;允许在 access token 过期后 logout)。

**限流**:**无**(沿 D-7)。

**入参**:`LogoutDto`,严格白名单 1 字段:
```typescript
class LogoutDto {
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}
```

**响应**:沿统一响应包装,`{ code: 0, message: 'ok', data: null }` + HTTP 200。
- **不**用 `@HttpCode(204)`(`ResponseInterceptor` 会把 204 空体改成 200 + 包装,详见 [ARCHITECTURE.md §7.3](../ARCHITECTURE.md))
- 沿 RFC 7009 §2.2 **幂等**:不存在 / 已撤销 / 已过期 → 仍返 200

**BizCode**:`40000 BAD_REQUEST`(DTO 校验),**无其他业务码**(幂等成功)。

**行为(伪逻辑)**:

```
1. raw = body.refreshToken;tokenHash = sha256(raw).hex
2. prisma.$transaction(async tx => {
   a. row = tx.refreshToken.findUnique({ where: { tokenHash } })
   b. row 存在且未撤销且未过期 → tx.refreshToken.update({
        where: { id: row.id },
        data: { revokedAt: now(), revokedReason: 'logout' }
      })
   c. auditLogs.log({ event: 'auth.logout', actorUserId: row?.userId ?? null,
                      resourceType: 'refresh_token', resourceId: row?.id ?? null,
                      extra: { found: row !== null }, tx })
3. 返回 200 + data:null
})
```

**铁律**:
- **不**主动吊销 access token(沿 D-4;access ≤ 15m 自然过期)
- 同一 family 的**其他** rotation 链 token **不动**(只杀当前)
- access token 字段(`Authorization` 头)如有传入,**不**校验、**不**消费;refresh token 是 logout 的唯一凭证

### 4.4 POST /api/auth/logout-all(新增)

**鉴权**:`JwtAuthGuard`(沿现有全局 Guard;需要知道是哪个 user;controller 不标 `@Roles`)。

**限流**:`@PasswordChangeThrottle()`(**复用** P0-D 已建的 `password-change` throttler,5/60 IP;沿 D-7)。

**入参**:**无 body**。

**响应**:`{ code: 0, message: 'ok', data: { revokedCount: number } }` + HTTP 200。

**BizCode**:`40100 UNAUTHORIZED`(未登录) / `42900 TOO_MANY_REQUESTS`(限流命中)。

**行为(伪逻辑)**:

```
1. currentUser = req.user(JwtAuthGuard 已挂)
2. prisma.$transaction(async tx => {
   a. result = tx.refreshToken.updateMany({
        where: { userId: currentUser.id, revokedAt: null, expiresAt: { gt: now() } },
        data: { revokedAt: now(), revokedReason: 'logout' }
      })
   b. auditLogs.log({ event: 'auth.logout-all', actorUserId: currentUser.id,
                      resourceType: 'user', resourceId: currentUser.id,
                      extra: { revokedCount: result.count }, tx })
3. 返回 { revokedCount: result.count }
})
```

**铁律**:
- **不**吊销当前 access token(沿 D-4)
- audit log **必写** `extra.revokedCount`(便于审计 / 告警"为什么一次踢 N 台")
- `revokedCount = 0` 也写 audit(幂等场景;沿 audit-logs.types.ts D-B 范式)

### 4.5 接口契约总览表

| 路径 | 鉴权 | 限流 | 入参 DTO | 响应 | BizCode |
|---|---|---|---|---|---|
| `POST /api/auth/login` | `@Public()` | `default` 5/60 IP | `LoginDto`(zero drift)| `LoginResponseDto`(**+2 字段**)| 40000 / 10004 / 42900 |
| `POST /api/auth/refresh` | `@Public()` | `refresh` 30/60 IP | `RefreshTokenDto { refreshToken }` | 同 `LoginResponseDto` | 40000 / 10007 / 42900 |
| `POST /api/auth/logout` | `@Public()` | **无** | `LogoutDto { refreshToken }` | 200 + data:null | 40000 |
| `POST /api/auth/logout-all` | `JwtAuthGuard` | `password-change` 5/60 IP | 无 body | 200 + `{ revokedCount: number }` | 40100 / 42900 |

---

## §5 安全规则(详细,代码 PR 必须严格遵循)

### 5.1 refresh token 生成与存储

- **明文生成**:`crypto.randomBytes(32).toString('base64url')`(256 bit 熵;base64url 不含 `+ / =`,URL / Header / Body 全兼容)
- **明文返回**:仅在 login / refresh 接口响应体中(`data.refreshToken`);**绝不**入 audit log、**绝不**入业务日志(沿 §5.6)
- **入库 hash**:`crypto.createHash('sha256').update(raw).digest('hex')`(64 字符 hex);DB 字段 `tokenHash @unique`
- **不**用 bcrypt / argon2:refresh token 是高熵随机串(2^256),不存在"被暴力破解"语义;sha256 sub-ms 查询性能远优 bcrypt(避免重复 bcrypt 性能拖累 refresh 接口)

### 5.2 数据模型草案(`refresh_tokens` 表)

**注意**:本节是**草案**,字段最终命名 / index 细节由 PR-3 实施时根据 Prisma 版本与既有 model 风格(沿 `audit_logs` / `attachments` 范式)微调;字段语义不动。

```prisma
model RefreshToken {
  id              String    @id @default(cuid())
  userId          String
  tokenHash       String    @unique               // sha256(raw) hex
  familyId        String                          // 同一登录链(rotation 串)的关联 id
  expiresAt       DateTime                        // 绝对过期(rotation 不延长)
  createdAt       DateTime  @default(now())
  rotatedAt       DateTime?                       // rotation 时间(被替换时填)
  revokedAt       DateTime?                       // 撤销时间
  revokedReason   String?                         // 'logout' | 'rotated' | 'family-revoked'
                                                  //   | 'admin-disable' | 'admin-delete'
                                                  //   | 'self-password-change' | 'admin-password-reset'
                                                  // (字符串枚举,沿 audit event 风格,不上 Prisma enum)
  replacedById    String?   @unique               // rotation 后产生的新 token id
  lastUsedAt      DateTime?                       // refresh 接口最后一次成功使用时刻(可选;PR-3 决定是否首期落)
  ipFirstSeen     String?                         // 首次签发 IP(仅供审计;不出对外 API)
  uaFirstSeen     String?                         // 首次签发 UA(仅供审计;不出对外 API)

  user            User           @relation(fields: [userId], references: [id], onDelete: Restrict)
  replacedBy      RefreshToken?  @relation("ReplacedBy", fields: [replacedById], references: [id], onDelete: SetNull)
  replaces        RefreshToken?  @relation("ReplacedBy")

  @@index([userId])
  @@index([familyId])
  @@index([expiresAt])
  @@index([revokedAt])
  @@map("refresh_tokens")
}
```

**字段必要性**:
- `tokenHash @unique`:refresh 接口主查询索引
- `familyId`:支持 family revoke(沿 §6.4)
- `rotatedAt + replacedById`:rotation 链可追溯
- `revokedReason`:运维 / 前端可分辨"为什么走";沿 D-8 audit `extra.familyId` 串联
- `ipFirstSeen / uaFirstSeen`:**只写不出**(对外 API 永远不返回这两个字段;不出现在任何 ResponseDto)
- `User.refreshTokens` 反向 relation:PR-3 实施时按 Prisma 风格补 1 行(沿 `User.auditLogs` / `User.userRoles` 范式)

**`onDelete` 策略**:`Restrict`(用户软删除走 `deletedAt` 字段,不物理删除;refresh token 的 `userId` 引用悬空仅理论风险)。

### 5.3 索引建议

| 索引 | 用途 |
|---|---|
| `tokenHash @unique` | refresh / logout 接口主查询(O(1)) |
| `@@index([userId])` | logout-all + 改密 / 禁用 / 删除联动撤销(`updateMany where userId`) |
| `@@index([familyId])` | family revoke(`updateMany where familyId`) |
| `@@index([expiresAt])` | 顺手清理过期 token(沿 §5.4) |
| `@@index([revokedAt])` | 运维查询 / 监控 |

### 5.4 物理清理策略

- **不做** cron 定时任务(违反 [`CLAUDE.md §1`](../CLAUDE.md) + V1.1 §17.3)
- refresh / logout / login 路径**顺手**清理:同一 user 已过期 ≥ 7d **且** 已撤销 ≥ 7d 的 token,单条 `deleteMany`,事务内一并执行
- 容忍 DB 内一定时间窗口的"过期未清理"行(磁盘可控;若量级失控再立项 cron)

**决策延后**:具体清理阈值(7d)由 PR-3 实施时拍板;本评审稿不锁死。

### 5.5 timing 防御

- refresh 接口"不存在 / 已撤销 / 已过期"必须响应耗时统计上**不可区分**(沿 v1 §8 防账号枚举铁律);实现路径:三场景都跑同一 `findUnique({ where: { tokenHash } })`,sha256 + DB 查询差异 < 1ms
- 重放检测命中(family revoke)耗时显著大于普通失败 — **接受**(攻击者已被锁定,timing 泄漏不增加损害)
- 不做 dummy sha256(sha256 本身 sub-ms,timing 差异不可统计)

### 5.6 日志 / audit 敏感字段

- **绝不**写入 `rawRefreshToken` / `tokenHash` 到 audit log `context.*`(沿 [security.md 日志 redact 清单](security.md))
- 日志 redact 已覆盖 `refreshToken`(沿 [logger-options.ts:37,44](../src/bootstrap/logger-options.ts:37) + [logger-options.spec.ts:45,51](../src/bootstrap/logger-options.spec.ts:45));PR-3 **不**新增 redact 字段
- audit `extra` 允许写:`familyId`(refresh token 行的 cuid,不是凭证)/ `replayDetected: boolean` / `revokedCount: number` / `revokedReason` 字符串
- **绝不**写:`refreshToken` 原值 / `tokenHash` / `passwordHash` / IP 完整段(IP 在 `AuditContext.ip` 已有,沿 audit-logs.types.ts:55)

### 5.7 BizCode 段位归属(锁死)

| BizCode | code | message | httpStatus | 段位归属 |
|---|---|---|---|---|
| `REFRESH_TOKEN_INVALID` | **10007** | `refresh token 无效或已过期` | 401 (`UNAUTHORIZED`) | 沿 v1 §5 BizCode 编码段:`100xx` users 模块业务级(含 auth);已用 10001-10006,**10007 是下一可用号位**;PR-3 启动前再次复核(沿 P0-D §9.4 范式) |

**不开的码**(沿 D-6 决策):
- 10008 / 10009 `REFRESH_TOKEN_EXPIRED` / `REFRESH_TOKEN_REVOKED` — 不开
- `REFRESH_TOKEN_REPLAY` — 不开(replay 与其他失败语义对用户一致)
- `LOGOUT_*` — 不开(logout 接口幂等不抛业务码)
- `LOGOUT_ALL_NOT_LOGGED_IN` — 不开(沿现有 `40100 UNAUTHORIZED`)

### 5.8 限流(锁死)

| 接口 | throttler 实例 | limit / ttl | 装饰器 |
|---|---|---|---|
| `POST /api/auth/login` | `default` | 5 / 60(沿现状) | `@LoginThrottle()` |
| `POST /api/auth/refresh` | **新建 `refresh`** | 30 / 60 | `@RefreshThrottle()`(新装饰器) |
| `POST /api/auth/logout` | (无) | (无) | (无装饰器) |
| `POST /api/auth/logout-all` | `password-change`(**复用 P0-D**) | 5 / 60(沿现状) | `@PasswordChangeThrottle()`(**复用**) |

- 全部命中走统一 `TOO_MANY_REQUESTS=42900` + HTTP 429
- **不暴露** `Retry-After` / `X-RateLimit-*` 头(沿 [throttle-options.ts:30](../src/bootstrap/throttle-options.ts:30))
- 新装饰器 `@RefreshThrottle()` 沿 P0-D `@PasswordChangeThrottle` 范式([password-change-throttle.decorator.ts](../src/common/decorators/password-change-throttle.decorator.ts))实现:**纯 metadata 标记**,limit / ttl 由 throttler 注册时从 `app.config.ts` 注入,**不**硬编码
- `throttler-biz.guard.ts` 需扩 1 处:`shouldSkip` / `handleRequest` 加 `REFRESH_THROTTLE_KEY` 与 `'refresh'` throttler.name 对应分支

### 5.9 audit 写入(锁死,4 个新事件)

| 事件名 | 写入位置 | resourceType | resourceId | extra |
|---|---|---|---|---|
| `auth.login` | `auth.service.login` 成功路径 | `'user'` | `user.id` | `{ familyId }` |
| `auth.refresh` | `auth.service.refresh` 成功路径 + family revoke 路径 | `'refresh_token'` | `row.id`(rotation 前)| `{ familyId, replayDetected, familyRevoked? }` |
| `auth.logout` | `auth.service.logout`(含幂等命中)| `'refresh_token'` | `row?.id ?? null` | `{ found: boolean }` |
| `auth.logout-all` | `auth.service.logoutAll` | `'user'` | `currentUser.id` | `{ revokedCount: number }` |

- 命名风格 PR-3 启动前**逐字复核**(沿 P0-D §9.1)
- audit 写入与业务写入**同事务**(沿 D-B fail-fast;P0-D 已遵循)
- 失败回滚由 `AllExceptionsFilter` + `prisma.$transaction` 自然回滚,无需特别策略

### 5.10 token 行为锁定(沿现状不破)

- **改密后**(本人 / 管理员):**access token 不主动吊销**(沿 D-4 / [`security.md` Token 吊销升级路径](security.md));**refresh token 全部撤销**(沿 D-3)
- **禁用 / 软删后**:access token **下一次请求**即失效(沿现状 [jwt.strategy.ts:49](../src/modules/auth/strategies/jwt.strategy.ts:49));refresh token **全部撤销**(沿 D-3)
- **重新启用**(`PATCH /:id/status` → `ACTIVE`):**不**主动签新 refresh token;用户需重新 login

---

## §6 refresh token rotation 流程(详细伪逻辑)

> 本节供 PR-3 实施时对照;伪逻辑只描述意图,**不写实现**。

### 6.1 rotation 主流程

详见 §4.2 伪逻辑(login → refresh → rotation always + family revoke + absolute expiration)。

### 6.2 rotation 不变式

- **每次 refresh 必发新 refresh**(rotation always;旧 refresh 立即标记 `rotated + revoked + replacedById`)
- **新 refresh 的 `expiresAt` 继承原 family 首个 token 的 `expiresAt`**(absolute expiration;不延长)
- **新 refresh 的 `familyId` 继承**(同 family 共享 id)
- **`ipFirstSeen / uaFirstSeen` 不更新**(它们是 login 时的快照)
- **新 refresh 的 `tokenHash` 必不与任何历史 `tokenHash` 冲突**(crypto.randomBytes 256-bit 熵,理论冲突概率 ~2^-128)

### 6.3 family revoke 触发条件

1. **重放命中**:`refresh` 接口收到 `rotatedAt != null` 的 row(沿 §4.2 步骤 c)
2. **用户被禁 / 软删**:`refresh` 接口收到的 row 对应的 user `status !== ACTIVE` 或 `deletedAt != null`(沿 §4.2 步骤 e)
3. **不**因 logout-single 触发(沿 §4.3 铁律:只杀当前)

### 6.4 family revoke 行为

```
tx.refreshToken.updateMany({
  where: { familyId: row.familyId, revokedAt: null },
  data: { revokedAt: now(), revokedReason: 'family-revoked' }
})
```

- 沿用 v1 `assertNotLastSuperAdmin` 范式,**在同一事务**内执行 `updateMany` + 抛错
- audit `auth.refresh` 写 `extra.replayDetected=true, extra.familyRevoked=true`(或 `extra.userInactive=true` 对应场景 2)

### 6.5 失败统一不分原因(锁死)

沿 D-6 + §5.7:三种 refresh 失败子原因(不存在 / 已撤销 / 已过期 / 重放命中)统一返 `10007`;响应体 / HTTP status / message **完全一致**(沿 v1 §8 防账号枚举铁律精神)。

---

## §7 改密 / 禁用 / 删除联动 refresh 撤销

> 本节 PR-3 实施时**必须**修改既有 service(`users.service.ts`)。**这是 P0-E 与 P0-D 的衔接面**,严格按本节实施。

### 7.1 本人自助改密(`PUT /api/users/me/password`)

**改动范围**:`UsersService.changeMyPassword` 现有事务([users.service.ts:198-245](../src/modules/users/users.service.ts:198))内**追加** 1 行 `updateMany`,并在 audit `extra` 加 `refreshTokensRevoked: count`。

伪逻辑增量:
```
// 现有 tx 内,user.update + auditLogs.log 之间插入:
const result = await tx.refreshToken.updateMany({
  where: { userId: currentUser.id, revokedAt: null, expiresAt: { gt: now() } },
  data: { revokedAt: now(), revokedReason: 'self-password-change' }
});
// auditLogs.log extra 增量:
extra: { ...existing, refreshTokensRevoked: result.count }
```

**铁律**:
- **access token 不主动吊销**(沿 D-4;改密后 ≤ 15m 仍可调业务接口)
- e2e 用例新增 ≥ 3 条(沿 §8 验收)
- P0-D 评审稿 §5.7 "改密后旧 token 不主动吊销" 中 "旧 token" 此处特指 **access token**;refresh token 在 P0-E 落地后**主动撤销**

### 7.2 管理员重置他人密码(`PUT /api/users/:id/password`)

**改动范围**:`UsersService.resetPassword` 现有方法([users.service.ts:355-371](../src/modules/users/users.service.ts:355))从 `prisma.user.update` 改为 `prisma.$transaction`,加 `updateMany` + audit log(P0-D 目前 admin reset 路径**未写 audit**;PR-3 顺手补)。

伪逻辑增量:
```
return prisma.$transaction(async tx => {
  const updated = await tx.user.update({
    where: { id }, data: { passwordHash }, select: userSafeSelect,
  });
  const result = await tx.refreshToken.updateMany({
    where: { userId: id, revokedAt: null, expiresAt: { gt: now() } },
    data: { revokedAt: now(), revokedReason: 'admin-password-reset' }
  });
  await auditLogs.log({
    event: 'password.reset.by-admin',  // 新 audit 事件;命名 PR-3 启动前复核
    actorUserId: currentUser.id,
    resourceType: 'user', resourceId: id,
    extra: { refreshTokensRevoked: result.count },
    tx,
  });
  return updated;
});
```

**注意**:本期新增 audit 事件 `password.reset.by-admin` 是 §3.8 D-8 的**隐含范围扩展**(D-8 仅列了 4 个 `auth.*` 事件);PR-3 启动前需在评审稿小修订或直接在 PR-3 描述中明确;命名风格 PR-3 启动前再次复核。

### 7.3 用户被禁用(`PATCH /api/users/:id/status` → `DISABLED`)

**改动范围**:`UsersService.updateStatus` 现有事务([users.service.ts:406-430](../src/modules/users/users.service.ts:406))加 `updateMany`(仅当 `dto.status === DISABLED`)。

伪逻辑增量:
```
// 现有 tx 内,user.update 后:
if (dto.status === UserStatus.DISABLED) {
  await tx.refreshToken.updateMany({
    where: { userId: id, revokedAt: null, expiresAt: { gt: now() } },
    data: { revokedAt: now(), revokedReason: 'admin-disable' }
  });
}
// audit:沿现有路径(若 updateStatus 当前无 audit,本期顺手补;否则增量 extra)
```

### 7.4 用户被软删除(`DELETE /api/users/:id`)

**改动范围**:`UsersService.softDelete` 现有事务([users.service.ts:434-454](../src/modules/users/users.service.ts:434))加 `updateMany`。

伪逻辑同 §7.3,`revokedReason='admin-delete'`。

### 7.5 用户被启用(`PATCH /api/users/:id/status` → `ACTIVE`)
**不**做任何 refresh 操作;用户需重新 login(沿 D-3 反向语义)。

### 7.6 SUPER_ADMIN 互操作 / last super admin 保护

- `last_super_admin_protected` 校验**先于**任何 refresh 撤销动作(沿 v1 §13);校验失败 → `LAST_SUPER_ADMIN_PROTECTED=10103`,**不**进入 refresh 清理事务
- SUPER_ADMIN 互相禁用 / 软删 / 改角色后,目标 refresh token 同 §7.3 / §7.4 撤销

---

## §8 验收标准(代码 PR 必须全部覆盖)

### 8.1 新建 e2e spec(4 个)

#### `test/e2e/auth-refresh.e2e-spec.ts`(目标用例数 10-12)
- [ ] **正常 refresh** → 200 + 新 access + 新 refresh + 字段集恰好 5 项
- [ ] **重复 refresh 同一 raw**(rotation 后再用旧 raw)→ family revoke + `10007`
- [ ] **不存在的 refresh** → `10007`
- [ ] **已撤销的 refresh** → `10007`
- [ ] **已过期的 refresh** → `10007`(用 `JWT_REFRESH_EXPIRES_IN=1ms` + sleep 50ms 制造,沿 [auth-jwt-guard.e2e-spec.ts:119-131](../test/e2e/auth-jwt-guard.e2e-spec.ts:119) 范式)
- [ ] **refresh 时用户被禁** → `10007` + 当前 row + 同 family 全部撤销
- [ ] **refresh 时用户软删** → `10007` + 同上
- [ ] **失败 4 场景响应体完全相等**(用 `toEqual` 严格比较,沿 [auth-login.e2e-spec.ts:152-158](../test/e2e/auth-login.e2e-spec.ts:152) 范式)
- [ ] **新 refresh 的 `expiresAt` 与原 family 首个一致**(absolute expiration 硬断言)
- [ ] **新 access payload 字段集恰好 `{ sub, username, iat, exp, nbf }`**(沿 [auth-login.e2e-spec.ts:64-66](../test/e2e/auth-login.e2e-spec.ts:64))

#### `test/e2e/auth-logout.e2e-spec.ts`(目标用例数 6-8)
- [ ] **正常 logout** → 200 + DB 内 `revokedAt != null` + `revokedReason='logout'`
- [ ] **不存在的 refresh** → 仍 200(幂等)
- [ ] **已撤销的 refresh** → 仍 200(幂等)
- [ ] **已过期的 refresh** → 仍 200(幂等)
- [ ] **logout 后 access token 仍可调 `GET /me`**(沿 D-4;15m 窗口接受;硬断言"不主动吊销 access")
- [ ] **logout 后同一 refresh 不能再换 access** → `10007`
- [ ] **logout 不要求 access token**(可在 access token 过期后 logout 自己,验证 `@Public()`)
- [ ] **同 family 其他 rotation 链 token 不受影响**(只杀当前)

#### `test/e2e/auth-logout-all.e2e-spec.ts`(目标用例数 5-6)
- [ ] **正常 logout-all** → 200 + `revokedCount > 0` + DB 内该 user 全部 refresh 撤销
- [ ] **单设备 logout-all** → `revokedCount === 1`
- [ ] **多设备 logout-all**(预先 login 3 次)→ `revokedCount === 3`
- [ ] **未登录 logout-all** → `40100`
- [ ] **同一 user 两次 logout-all** → 第二次 `revokedCount === 0`(幂等)
- [ ] **audit_logs 写入 `auth.logout-all` + `extra.revokedCount`**

#### `test/e2e/auth-refresh-throttle.e2e-spec.ts`(目标用例数 3-4)
- [ ] **30/60 IP 验证**:命中 30 次后第 31 次 → `42900`
- [ ] **与 `default`(login) throttler 物理隔离**:login 配额不被 refresh 吃掉(沿 [auth-login-throttle.e2e-spec.ts:108-121](../test/e2e/auth-login-throttle.e2e-spec.ts:108) 范式)
- [ ] **不暴露 `Retry-After` / `X-RateLimit-*` 头**(沿 [auth-login-throttle.e2e-spec.ts:83-98](../test/e2e/auth-login-throttle.e2e-spec.ts:83))

### 8.2 修改现有 e2e spec(4 个)

#### `test/e2e/auth-login.e2e-spec.ts`
- [ ] **新增** "成功路径返 refreshToken + refreshExpiresAt 字段 + 字段集恰好 5 项"硬断言;`refreshExpiresAt` 必须能被 `new Date(...).getTime()` 解析(ISO 8601 UTC);**断言 rotation 后新 refresh 响应的 `refreshExpiresAt` 与 login 首次返回字符串完全相等**(absolute expiration 硬约束)
- [ ] **保留** "payload 仅含 sub + username + 标准 jwt 字段"硬断言(line 47-67;**不改**)
- [ ] **新增** "login 写 audit `auth.login` + extra.familyId"

#### `test/e2e/auth-jwt-guard.e2e-spec.ts`
- [ ] **不改**既有 7 用例(P0-E 不动 access 即时失效路径)
- [ ] **新增** ≥ 1 用例:`JWT_EXPIRES_IN=15m` 默认情景下基础失效行为不变(轻断言)

#### `test/e2e/users-change-my-password.e2e-spec.ts`
- [ ] **新增** ≥ 3 用例:
  - 改密后 DB 内目标用户所有 refresh 全部 `revokedAt != null` + `revokedReason='self-password-change'`
  - 改密前的 refresh 不能再 refresh → `10007`
  - audit `password.change.self` 写 `extra.refreshTokensRevoked > 0`
- [ ] **保留**既有 21 用例,**含** §7.5 "改密后旧 access token 仍可调 `/me`" 反向锁定(line 21-23;沿 D-4)

#### `test/e2e/users-password-reset.e2e-spec.ts`
- [ ] **新增** ≥ 3 用例:
  - 管理员重置后 DB 内目标用户所有 refresh 全部撤销 + `revokedReason='admin-password-reset'`
  - 重置前的 refresh 不能再 refresh → `10007`
  - audit `password.reset.by-admin`(新事件名,沿 §7.2 复核)写入

### 8.3 修改 `users-soft-delete.e2e-spec.ts` / `users-admin-crud.e2e-spec.ts`
- [ ] **新增** ≥ 2 用例:
  - 用户被 `DISABLED` 后 refresh 全部 `revokedReason='admin-disable'`
  - 用户被软删后 refresh 全部 `revokedReason='admin-delete'`

### 8.4 新建 unit spec(3 个,草案)

- **`src/modules/auth/auth.service.spec.ts`**(若不存在则新建):login 同步签 access + 创建 refresh row;refresh rotation;refresh 重放 family revoke;logout 幂等;logout-all updateMany
- **`src/modules/auth/refresh-token.util.spec.ts`**(新文件):`generateRefreshTokenRaw` / `hashRefreshToken` 边界
- **`src/common/exceptions/biz-code.constant.spec.ts`**:断言 `REFRESH_TOKEN_INVALID = 10007` + httpStatus 401(沿现有 [biz-code.constant.spec.ts](../src/common/exceptions/biz-code.constant.spec.ts) 范式)

### 8.5 不破坏现有测试

- 全部 51 e2e spec(1252 用例)必须仍通过(沿 P0-D PR-3 #117 验收门槛)
- `auth-memberno-login.e2e-spec.ts` **不动**
- `pnpm lint` / `pnpm typecheck` / `pnpm test:e2e` / `pnpm test:contract` 全部通过

---

## §9 API / DTO / service / OpenAPI 影响清单

| 维度 | 改动 | 备注 |
|---|---|---|
| `prisma/schema.prisma` | 新增 `RefreshToken` model + `User.refreshTokens` 反向 relation | 沿 §5.2 草案;PR-3 实施时按 Prisma / 既有 model 风格微调 |
| `prisma/migrations/*` | 新增 1 个 migration:`add_refresh_tokens` | PR-3 在 `prisma migrate dev` 前**必须**先回到对话贴出预生成 SQL 等用户确认(沿 [`CLAUDE.md §0`](../CLAUDE.md)) |
| `prisma/seed.ts` | **零变更** | refresh_tokens 是运行时数据,无 seed |
| `src/modules/auth/auth.dto.ts` | 新增 `RefreshTokenDto` + `LogoutDto`;扩展 `LoginResponseDto` 加 2 字段 | 严格白名单;`refreshToken` 在 `LoginResponseDto` 用 `@ApiProperty` |
| `src/modules/auth/auth.controller.ts` | 新增 3 方法(`refresh` / `logout` / `logoutAll`) | 沿现有 Swagger 装饰器风格(`@ApiOperation` / `@ApiWrappedOkResponse(...)` / `@ApiBizErrorResponse(...)`);`logoutAll` 沿 `@HttpCode(200)` |
| `src/modules/auth/auth.service.ts` | 新增 `refresh` / `logout` / `logoutAll` 方法;`login` 扩展生成 refresh + 写 audit | 沿现有事务范式;**禁止** import V2 BizCode / Members 模块(沿 [v2-api-contract §6.6.4](v2-api-contract.md)) |
| `src/modules/auth/auth.module.ts` | `imports` 加 `AuditLogsModule`(供注入 `AuditLogsService`)+ `DatabaseModule`(已有) | 沿 P0-D `UsersModule.imports: AuditLogsModule` 范式 |
| `src/modules/auth/refresh-token.util.ts`(新文件)| 沉淀 `generateRefreshTokenRaw()` / `hashRefreshToken()` 2 个纯函数 | 沿 v1 §2 不跨模块公共目录;放 auth 模块内 |
| `src/modules/users/users.service.ts` | 改 4 方法:`changeMyPassword` / `resetPassword` / `updateStatus` / `softDelete` 加 refresh 撤销 + audit 增量 | 沿 §7;`UsersModule.imports` 已含 `AuditLogsModule` 与 `PrismaService`,无新依赖 |
| `src/common/exceptions/biz-code.constant.ts` | 新增 1 条:`REFRESH_TOKEN_INVALID=10007` | 沿 §5.7;PR-3 启动前再次复核 100xx 段位无抢号 |
| `src/modules/audit-logs/audit-logs.types.ts` | `AuditLogEvent` union 新增 5 项(沿 D-8 + §7.2) | `auth.login` / `auth.refresh` / `auth.logout` / `auth.logout-all` / `password.reset.by-admin` |
| `src/common/decorators/refresh-throttle.decorator.ts`(新文件)| 沿 `password-change-throttle.decorator.ts` 范式([代码](../src/common/decorators/password-change-throttle.decorator.ts)) | metadata key `REFRESH_THROTTLE_KEY` + throttler name `REFRESH_THROTTLER_NAME = 'refresh'` |
| `src/common/guards/throttler-biz.guard.ts` | 扩 1 处:`shouldSkip` / `handleRequest` 加 `REFRESH_THROTTLE_KEY` + `'refresh'` 分支 | 沿现有 password-change 分支范式([throttler-biz.guard.ts:36-74](../src/common/guards/throttler-biz.guard.ts:36)) |
| `src/bootstrap/throttle-options.ts` | `throttlers[]` 数组追加 1 项 `{ name: 'refresh', limit, ttl }` | 沿 [throttle-options.ts:24-28](../src/bootstrap/throttle-options.ts:24) password-change 范式 |
| `src/config/app.config.ts` | 新增 2 个字段:`REFRESH_THROTTLE_LIMIT` / `REFRESH_THROTTLE_TTL_SECONDS`;启动强校验加 2 行 | 默认 30 / 60;推荐区间沿 V1.1 [1, 100] / [1, 3600];fail-fast |
| `src/config/jwt.config.ts` | 新增 1 个 TTL 配置字段(读 env `JWT_REFRESH_EXPIRES_IN`,如 `"90d"`)| 字段名沿 v1 `jwt.config.expiresIn` 范式由 PR-3 实施时确定;启动强校验存在。**响应字段**叫 `refreshExpiresAt`(ISO 8601 UTC 绝对时刻字符串,在 service 内 `new Date(now + ttlMs).toISOString()` 计算;沿 §3.1 D-1);**TTL 配置 ≠ 响应字段**,职责分离 |
| `.env.example` | 新增 3 行:`JWT_REFRESH_EXPIRES_IN=90d` / `REFRESH_THROTTLE_LIMIT=` / `REFRESH_THROTTLE_TTL_SECONDS=` | 沿 P0-D `PASSWORD_CHANGE_THROTTLE_*` 范式;含完整中文注释 |
| OpenAPI snapshot | 增量 diff(+3 路由 / +2 DTO / +2 LoginResponseDto 字段 / +1 BizCode 出现在错误码字段) | PR-3 阶段 `pnpm test:contract -u` 后人工 review,确认 v1 已有路由 schema 零漂移 |
| `docs/v2-api-contract.md` | 增量 1 段说明(若 v1 段有 auth 路由汇总,同步加 3 行) | PR-4 阶段同步,不在本评审稿强制 |
| `package.json` / `pnpm-lock.yaml` | **零变更** | `crypto` 是 Node 内置,无新依赖 |
| `Dockerfile` / `.github/workflows/*` | **零变更** | — |
| `prisma/schema.prisma` `User` 模型字段 | **零变更**(仅加反向 relation) | 沿 D-4 不做 tokenVersion |
| `JwtPayload` 类型 | **零变更** | 沿 D-4 不改 payload |

---

## §10 PR 拆分(强串行,不并发)

| # | PR 标题(建议) | 档位 | 范围 | 前置 | 验收 |
|---|---|---|---|---|---|
| **PR-1** | `docs(review): P0-E refresh token strategy v1`(**本 PR**)| **A 档 docs-only** | 仅新增本评审稿 1 个文件 + CHANGELOG Unreleased 增 1 行 | 用户已拍板 §3 D-1 ~ D-9 | 本评审稿冻结;`git diff --stat` 仅 2 文件 docs |
| PR-2 | `docs(p0e): allow refresh token / logout` | A 档 docs-only | 修订 `CLAUDE.md` / `AGENTS.md` 相关段:把"v1 不实现 refresh token / logout"明文升级为"P0-E 评审稿冻结后允许实现"+ 同步 §1 / §5(BizCode 段位 10007)/ §8(Guard 链)/ §9(密码处理与撤销联动)/ §17 关键铁律 | PR-1 已 merged | 文档前后一致;`pnpm lint` 仍通过(docs-only) |
| PR-3 | `feat(auth): add refresh token + logout + logout-all` | **D 档代码** | 严格按本评审稿 §3 / §4 / §5 / §6 / §7 / §8 / §9 实施;严格不夹带 §3.9 任一项 | PR-2 已 merged + 用户对 `prisma migrate dev` 预生成 SQL 拍板 | A+B 档双门槛(沿 V1.1 §17.10);§8 验收用例全部 ✅;`pnpm lint` / `pnpm typecheck` / `pnpm test:e2e` / `pnpm test:contract` 全部通过 |
| PR-4 | `docs(first-release): backfill P0-E status` | A 档 docs-only | 1) [`readiness-plan §3.1 P0-E`](first-release-readiness-plan.md) 状态从"必须先 D 档评审"改"✅";顺手修 §2 偏差措辞<br/>2) [`frontend-scope`](first-release-frontend-scope.md) 起步包加 `POST /api/auth/refresh` / `POST /api/auth/logout` / `POST /api/auth/logout-all` 3 条(51 → 54);同步联调包齐备清单<br/>3) [`bizcode-mapping`](first-release-bizcode-mapping.md) 加 `REFRESH_TOKEN_INVALID=10007` 1 条 + 前端 token 生命周期图<br/>4) [`bootstrap-sop`](first-release-bootstrap-sop.md) 加 `JWT_REFRESH_EXPIRES_IN` / `REFRESH_THROTTLE_*` env 段 + "默认 SUPER_ADMIN 改密后 refresh 自动撤销" SOP 注释<br/>5) [`current-state §2`](current-state.md) 加 1 行能力清单<br/>6) [`security.md` 已落地策略表](security.md) 加 2 行(refresh + logout / 改密-禁用-删除联动撤销)+ Token 吊销升级路径段更新(P0-E 已落地,`tokenVersion` 仍归未来) | PR-3 已 merged | 跨文档一致;不夹带 src / schema / 测试 |

**铁律**:
- **PR 之间强串行**,不并发(沿 [`process.md §4`](process.md))
- **PR-3 严禁夹带 §3.9 任一项**;发现越权立刻打回重做
- **PR-3 不动 release / tag / version**;不进入 release 收口阶段
- **PR-3 在 `prisma migrate dev` 前必须暂停**,把预生成 SQL 与影响表清单贴对话等用户确认(沿 [`CLAUDE.md §0`](../CLAUDE.md))
- **不**触发 [`ARCHITECTURE.md §9`](../ARCHITECTURE.md) 升级路径中"Redis / queue / cron";refresh token 撤销靠 DB 主键索引 sub-ms 查询,不需要缓存

---

## §11 代码 PR 前复核点(PR-3 启动前必须再次确认)

PR-3 启动前,以下 **5 项**必须做一次只读复核(沿 [`process.md §4`](process.md) D 档降速流程 + P0-D §9 范式)。

### 11.1 现有 `AuditLogEvent` 命名风格逐字对齐

- 用 grep 取既有 18 项 `AuditLogEvent` 取值(沿 [audit-logs.types.ts:19-40](../src/modules/audit-logs/audit-logs.types.ts:19)),确认本评审稿拟新增 5 项命名:
  - `auth.login` / `auth.refresh` / `auth.logout` / `auth.logout-all` / `password.reset.by-admin`
- 是否符合 kebab-case `<resource>.<action>` 或 `<resource>.<action>.<scope>` 风格?
- `auth.logout-all` 的 `logout-all` 是否符合 `attendance-sheet.final-review` 范式(action 段内含 dash)?
- `password.reset.by-admin` 是否符合 `password.change.self` 对称命名(scope 段用 `by-admin`)?
- 若现有命名风格与本评审拟用名不一致,**以现有风格为准**修订本评审稿(本节是允许的小修订,不算决策点变化)。

### 11.2 现有 Throttler 装饰器复用方式

- 用 grep 看 [`password-change-throttle.decorator.ts`](../src/common/decorators/password-change-throttle.decorator.ts) 实现;确认 `@RefreshThrottle()` 沿同款 metadata 范式
- `throttle-options.ts` 注册 `'refresh'` throttler 实例,与既有 `'default'` / `'password-change'` 物理隔离;`throttler-biz.guard.ts` 加分支即可
- **不**改 `throttler-biz.guard.ts` 既有 `default` / `password-change` 分支逻辑

### 11.3 现有 OpenAPI error 装饰器风格

- 用 grep 看 `@ApiBizErrorResponse(...)` 在 login / change-my-password 的具体写法
- 本评审拟用形态:
  - `refresh`:`@ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.REFRESH_TOKEN_INVALID, BizCode.TOO_MANY_REQUESTS)`
  - `logout`:`@ApiBizErrorResponse(BizCode.BAD_REQUEST)`
  - `logout-all`:`@ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.TOO_MANY_REQUESTS)`
- 若现有风格有顺序约定 / 排序约定,**以现有风格为准**

### 11.4 10007 与源码现有码位的冲突复核

- 本评审稿 §5.7 已记录"100xx 段已用 10001-10006,10007 为下一可用号位"
- PR-3 启动前**再次 grep**:`grep -E "code:\s*1000[7-9]" src/common/exceptions/biz-code.constant.ts` 应无命中
- 若发生抢号,需另起评审稿小修订,**不**自动顺延号位

### 11.5 `prisma migrate dev` 预生成 SQL 复核

- PR-3 实施时执行 `prisma migrate dev --name add_refresh_tokens --create-only`(生成但不 apply)
- 把预生成 SQL **完整内容**贴回对话(含 CREATE TABLE / INDEX / FK 全部 DDL),等用户确认后再 `prisma migrate dev`
- 沿 [`CLAUDE.md §0`](../CLAUDE.md) "执行 `prisma migrate dev` 前必须先说明将生成 / 执行的迁移内容并等待确认"

---

## §12 migration 风险与回滚策略

### 12.1 migration 内容

- 单一 `prisma migrate dev --name add_refresh_tokens` 产物(草案文件名,PR-3 实施时按 Prisma 自动生成时间戳)
- **仅新建** `refresh_tokens` 表 + 5 个 index + 2 个 FK(`userId` → `users.id` ON DELETE Restrict;`replacedById` → `refresh_tokens.id` ON DELETE SetNull)
- **0 修改** `users` / `audit_logs` 等既有表(沿 D-4 不加 `tokenVersion`)

### 12.2 风险评估

| 风险 | 等级 | 缓解 |
|---|---|---|
| migration 失败(prisma sql 不兼容)| 低 | 新建表,无 ALTER 既有表;失败重试 / 改 migration 重跑 |
| 既有 1252 e2e 退化 | 中 | A 档基础验收必须 zero failure(沿 V1.1 §17.10) |
| OpenAPI snapshot v1 路由 drift | 高 | PR-3 必须证明 v1 14 路由 schema diff = 0(沿 [v2-api-contract §6.5](v2-api-contract.md));snapshot diff 仅含 +3 路由 / +2 DTO / +2 LoginResponseDto 字段 / +1 BizCode |
| 旧前端不识别 `refreshToken` 字段 | 低 | 向后兼容(JSON 多字段不报错);前端按 PR-4 联调清单升级 |
| 旧前端不调 refresh,access 7d → 15m 突然到期 | 中 | PR-3 / PR-4 必须在 CHANGELOG 与 frontend-scope 醒目提示 "access TTL 15m,客户端必须接 refresh 流"|
| 改密 / 禁用 / 删除联动撤销影响 v1 路由 schema | 中 | 仅改 `users.service.ts` 内部 service 逻辑;controller / DTO / 响应 schema **不变**;OpenAPI snapshot v1 路由 zero drift |
| `lastLoginAt` 改密时被刷(回归 P0-D §7.7 断言)| 中 | PR-3 必须保留 P0-D `users-change-my-password.e2e-spec.ts:7.7` "改密后 lastLoginAt 不变" 断言;不夹带 |
| `refresh_tokens` 表数据膨胀 | 中(P0-E v1 docs hotfix 后由 30d 调整为 90d,可能膨胀 3x)| rotation 每次 +1 行,**90d TTL**;沿 §3.5 D-5 设计取舍**接受**;§5.4 顺手清理策略缓解;若量级失控再立项 cron(沿 §13.3 反模式表) |
| 数据迁移 / 回填 | **无** | 全新表,无回填 |

### 12.3 回滚策略

**完全回滚(PR-3 整体回滚)**:
- 代码回滚:`gh pr revert <PR-3>` 生成 revert PR;controller / service / dto / module / 装饰器 / config / env 全部移除
- migration 回滚:**不**写 `prisma migrate reset`(危险);新建 `drop_refresh_tokens` migration(单独 PR)按顺序:
  1. `DROP INDEX` 5 个
  2. `DROP TABLE refresh_tokens`
- 数据库残留 `refresh_tokens` 表非阻断性(无外键被引用,可保留观察一段时间再 drop)
- 沿 [`process.md §4`](process.md) D 档铁律,回滚 PR 单独评审,不夹带

**仅回滚 access TTL(若 7d → 15m 导致前端联调集中爆雷)**:
- 临时通过 `JWT_EXPIRES_IN=7d` env 回到原 TTL(代码不动)
- refresh / logout / logout-all 接口仍可用(refresh 接口对 access TTL 无依赖)
- 这是**运行时配置回滚**,不需要代码 PR;前端联调阶段保留这个口子

**仅回滚改密联动撤销**(若发现 §7 联动撤销逻辑有 bug):
- 临时把 `users.service.ts` 中 `tx.refreshToken.updateMany` 调用注释掉(单文件 git checkout)
- 但 audit log 增量(`extra.refreshTokensRevoked`)需同步移除,否则 audit 字段不一致
- 不推荐此操作;有 bug 直接修代码并补 e2e,**不**用配置回滚

### 12.4 prisma migrate 命令前置(沿 [`CLAUDE.md §0`](../CLAUDE.md))

- 实施 PR 执行 `prisma migrate dev` 前**必须**先做(沿 §11.5):
  1. `prisma migrate dev --name add_refresh_tokens --create-only`
  2. 把生成的 SQL 完整贴回对话
  3. 等用户拍板再 `prisma migrate dev`(apply)
- 生产环境只允许 `prisma migrate deploy`;**禁止** `prisma migrate dev` / `prisma db push`

---

## §13 D 档判定与降速依据

**结论:D 档**(确定无疑)。

### 13.1 D 档触发条件(沿 [`process.md §4`](process.md))

| 触发条件 | 命中? | 证据 |
|---|---|---|
| 修改 `prisma/schema.prisma` / 增加 `migrations/` | ✅ | §5.2 新增 `RefreshToken` model + 1 migration |
| 修改登录 / JWT / `auth.service.ts` / `JwtStrategy` | ✅ | §4.1 扩 login,§4.2 新增 refresh,§4.3 新增 logout,§4.4 新增 logout-all,4 处方法 |
| 修改 `audit_logs` 任何 `AuditLogEvent` union 项 | ✅ | §3.8 D-8 新增 4 个 + §7.2 新增 1 个 = 5 个 |
| 安全相关 | ✅ | refresh token 失窃 / 重放 / family revoke / 改密-禁用-删除联动撤销 |
| 改全局 Guard / Interceptor / ValidationPipe | ✅ | §5.8 扩 `throttler-biz.guard.ts` 加 `refresh` 分支 |
| 修改 `BizCode` 段位语义 | ⚠ 段内新增 | §5.7 新增 1 个 100xx 段内业务码(沿 process.md "新增 BizCode 仍要登记段位,但不视作降速" — 但其他多项已触发,整体 D 档不变) |
| package.json 新依赖 | ❌ | `crypto` 是 Node 内置,无新依赖 |

### 13.2 降速流程(沿 process.md §4)

- ✅ **步骤 1**(只读调研):上轮 P0-E 评审会话已完成(产 20 节评审稿草案)
- ✅ **步骤 2**(风险表):§12 已列
- ✅ **步骤 3**(方案 A/B 对比):上轮草案 §3 / §4 已对比并由用户拍板
- ✅ **步骤 4**(用户拍板):本稿 §3 9 条决策已锁
- ✅ **步骤 5**(评审稿冻结):**本 PR-1**(冻结即合入)
- ⏳ **步骤 6**(再实施):PR-2 → PR-3 → PR-4 串行

### 13.3 禁止"顺手做"清单

沿 V1.1 §17.9 + P0-D 范式,PR-3 实施时**禁止**:

| 反模式 | 为什么禁止 |
|---|---|
| 接了 refresh token → 顺手把 access TTL payload 加 `tv` | 沿 D-4 不做 tokenVersion |
| 接了 refresh token → 顺手做 device 列表查询接口 | 沿 D-9 不做 |
| 接了 logout-all → 顺手做 "管理员强制下线某用户"接口 | 不在 P0-E 范围;归 P0-F 或单独立项 |
| 改了 `auth.service.ts` → 顺手优化 memberNo 登录路径 | 不在 P0-E 范围 |
| 加了 `auth.login` audit → 顺手把 `LoginDto.username` 写进 audit `extra` | 防账号枚举攻击面 |
| 加了 refresh 接口 → 顺手在 `LoginDto` 加 `rememberMe` 字段 | 沿 v2-api-contract §6.5 LoginDto 硬约束 |
| 改了 `users.service.ts` → 顺手把 `lastLoginAt` 在改密时刷一下 | 沿 P0-D §7.7 反向断言 |
| 写 refresh_tokens 行时 → 顺手记录完整 IP / UA 进 audit `extra` | audit context 已有 ip/ua 字段(沿 audit-logs.types.ts:55);不重复 |
| 加 cron / 定时任务清理 refresh_tokens | 沿 [`CLAUDE.md §1`](../CLAUDE.md) C 档不做 cron;§5.4 路径触发性清理已覆盖 |

---

## §14 不在本文范围 / 引用来源 / 文档元信息

### 14.1 不在本文范围

| 类别 | 权威源 |
|---|---|
| 接口字段详情 / OpenAPI | [`v2-api-contract.md`](v2-api-contract.md) + Swagger `/api/docs` |
| 完整 BizCode 翻译 | [`first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md) |
| 前端联调起步包 51 接口 | [`first-release-frontend-scope.md`](first-release-frontend-scope.md) |
| 第一版剩余账本 P0/P1/P2 | [`first-release-readiness-plan.md`](first-release-readiness-plan.md) |
| 从零部署 SOP | [`first-release-bootstrap-sop.md`](first-release-bootstrap-sop.md) |
| 安全策略已落地表 | [`security.md`](security.md) |
| 协作流程 / D 档降速 / PR 拆分 | [`process.md`](process.md) |
| 当前事实 / 风险账单 | [`current-state.md`](current-state.md) |
| Token 吊销升级路径(本评审推动落地) | [`security.md`](security.md) Token 吊销升级路径段 |
| P0-D 本人改密评审稿(P0-E 的衔接面) | [`first-release-p0d-change-my-password-review.md`](first-release-p0d-change-my-password-review.md) |
| RBAC 收紧(P0-F)| [`first-release-readiness-plan.md §3.1 P0-F`](first-release-readiness-plan.md) |
| 上传下载闭环(P0-B)| [`ops/cos-production-rollout-checklist.md`](ops/cos-production-rollout-checklist.md) |

### 14.2 引用来源

- [`README.md`](../README.md)
- [`.env.example`](../.env.example)
- [`CLAUDE.md`](../CLAUDE.md) §1 / §5 / §6 / §8 / §9 / §14 / §17
- [`AGENTS.md`](../AGENTS.md) §1 / §5 / §8 / §9
- [`ARCHITECTURE.md`](../ARCHITECTURE.md) §1 / §6 / §7.3 / §7.6 / §9 / §11
- [`process.md`](process.md) §3 / §4 / §6
- [`security.md`](security.md)
- [`current-state.md`](current-state.md)
- [`v2-api-contract.md`](v2-api-contract.md) §6.5 / §6.6
- [`first-release-readiness-plan.md`](first-release-readiness-plan.md)
- [`first-release-frontend-scope.md`](first-release-frontend-scope.md)
- [`first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md)
- [`first-release-bootstrap-sop.md`](first-release-bootstrap-sop.md)
- [`first-release-p0d-change-my-password-review.md`](first-release-p0d-change-my-password-review.md)
- 源码只读引用(不复制):
  - [`src/modules/auth/auth.controller.ts`](../src/modules/auth/auth.controller.ts)
  - [`src/modules/auth/auth.service.ts`](../src/modules/auth/auth.service.ts)
  - [`src/modules/auth/auth.dto.ts`](../src/modules/auth/auth.dto.ts)
  - [`src/modules/auth/auth.module.ts`](../src/modules/auth/auth.module.ts)
  - [`src/modules/auth/strategies/jwt.strategy.ts`](../src/modules/auth/strategies/jwt.strategy.ts)
  - [`src/modules/users/users.controller.ts`](../src/modules/users/users.controller.ts)
  - [`src/modules/users/users.service.ts`](../src/modules/users/users.service.ts)
  - [`src/modules/users/users.dto.ts`](../src/modules/users/users.dto.ts)
  - [`src/common/exceptions/biz-code.constant.ts`](../src/common/exceptions/biz-code.constant.ts)
  - [`src/common/guards/throttler-biz.guard.ts`](../src/common/guards/throttler-biz.guard.ts)
  - [`src/common/decorators/login-throttle.decorator.ts`](../src/common/decorators/login-throttle.decorator.ts)
  - [`src/common/decorators/password-change-throttle.decorator.ts`](../src/common/decorators/password-change-throttle.decorator.ts)
  - [`src/bootstrap/throttle-options.ts`](../src/bootstrap/throttle-options.ts)
  - [`src/bootstrap/logger-options.ts`](../src/bootstrap/logger-options.ts)
  - [`src/config/app.config.ts`](../src/config/app.config.ts)
  - [`src/config/jwt.config.ts`](../src/config/jwt.config.ts)
  - [`src/modules/audit-logs/audit-logs.types.ts`](../src/modules/audit-logs/audit-logs.types.ts)
  - [`src/modules/audit-logs/audit-logs.service.ts`](../src/modules/audit-logs/audit-logs.service.ts)
  - [`prisma/schema.prisma`](../prisma/schema.prisma)
  - [`test/e2e/auth-login.e2e-spec.ts`](../test/e2e/auth-login.e2e-spec.ts)
  - [`test/e2e/auth-jwt-guard.e2e-spec.ts`](../test/e2e/auth-jwt-guard.e2e-spec.ts)
  - [`test/e2e/auth-login-throttle.e2e-spec.ts`](../test/e2e/auth-login-throttle.e2e-spec.ts)
  - [`test/e2e/auth-memberno-login.e2e-spec.ts`](../test/e2e/auth-memberno-login.e2e-spec.ts)
  - [`test/e2e/users-change-my-password.e2e-spec.ts`](../test/e2e/users-change-my-password.e2e-spec.ts)
  - [`test/e2e/users-password-reset.e2e-spec.ts`](../test/e2e/users-password-reset.e2e-spec.ts)

### 14.3 文档元信息

- **状态**:**v1 正式版**(用户已对 §3 全部 9 条决策拍板;等待 PR-1 合入冻结)
- **PR 标题建议**:`docs(review): P0-E refresh token strategy v1`
- **档位**:**A 档 docs-only**(沿 [`process.md §3`](process.md))
- **本 PR 不夹带**:`CLAUDE.md` / `AGENTS.md` / `src/*` / `prisma/*` / `test/*` / `package.json` / `pnpm-lock.yaml` / OpenAPI snapshots / `.github/workflows/*` / `docs/current-state.md` / `docs/first-release-readiness-plan.md` / `docs/first-release-frontend-scope.md` / `docs/first-release-bizcode-mapping.md` / `docs/first-release-bootstrap-sop.md` / `docs/security.md` / release / tag / version
- **本 PR 唯一改动**:新增本评审稿 1 个文件 + `CHANGELOG.md` `## Unreleased` 段增 1 条 docs 记录
- **冻结后的修订规则**:本评审稿冻结后(PR-1 merged),**不回改本文**;若 §11 复核点暴露重大冲突,另起 `docs(review): P0-E refresh token strategy v2` 增量稿,不动 v1 文本(沿 [`process.md §6`](process.md) handoff 不回改范式)
- **本评审稿与 P0-D 评审稿的关系**:P0-D §5.7 "改密成功后旧 token 不主动吊销"中"旧 token"特指 **access token**;P0-E 落地后,**refresh token 在改密时主动撤销**(沿 §7.1);P0-D 与 P0-E 在 access token 行为上一致(不主动吊销),在 refresh token 行为上由 P0-E 接管

### 14.4 撰写边界声明

- 本评审稿**不引入新事实**;所有引用均来自已合入 main 的代码与文档(基线:v0.13.0 / main HEAD `5fba386`)
- 本评审稿**不调和**与 readiness-plan 已存在的措辞偏差(§2 仅指出,修正归 PR-4)
- 本评审稿**不**承诺 PR-3 的具体实现细节(如 method 命名、装饰器命名、文件路径细节);仅锁定行为契约 / 字段语义 / 错误码 / 鉴权 / 限流 / audit / 验收用例
- 本评审稿**不**输出任何真实 secret / token / signed URL / SecretId / SecretKey;所有 `<JWT>` / `<opaque-256bit-base64url>` 均为占位符
- 本评审稿**是评审稿,不代表已经允许直接写代码**;PR-2 / PR-3 启动有严格前置(详见 §10)
