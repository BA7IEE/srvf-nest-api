# auth — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);架构边界读 [`/docs/architecture-boundary.md`](../../../docs/architecture-boundary.md);安全相关读 [`/docs/security.md`](../../../docs/security.md)。本文件**只**记录在本目录工作时容易踩雷的本地铁律。

## Scope

- **登录 / 刷新 / 注销 / token 安全链路**:`POST /api/auth/login` / `/refresh` / `/logout` / `/logout-all`
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
- **logout 幂等 / 限流当前事实**:`/auth/logout` 不存在 / 已撤销 / 已过期均返 200,写 audit `extra.found` 区分;当前**未挂限流装饰器**(沿评审稿 §3.7 D-7,避免攻击者吃光合法用户配额);保持当前 logout / logout-all 的幂等、撤销与限流语义,如需调整幂等或限流策略,必须先做安全评审并补测试
- **logout-all** 撤销该 user 全部未过期且未撤销的 refresh;当前复用 `@PasswordChangeThrottle()`
- **access token 当前不主动吊销**(沿 D-4):由 `JWT_EXPIRES_IN` 自然过期 + JwtStrategy 每请求查库阻断 DISABLED / 软删用户;保持当前策略,如需引入 blacklist / Redis / tokenVersion 必须走设计决议
- **password change**:本人改密在 [`users.service.ts:249`](../users/users.service.ts:249) 主动撤销该 user 全部未过期 refresh(`revokedReason='self-password-change'`);旧 access 仍可调直至自然过期(e2e 反向锁定)
- **audit events 4 个**(写路径全部经 `AuditLogsService`):`auth.login` / `auth.refresh` / `auth.logout` / `auth.logout-all`;extra 字段允许 `familyId / replayDetected / familyRevoked / revokedCount / found`,**禁止**任何明文 / hash
- **限流装饰器** 3 个 throttler 物理隔离:`@LoginThrottle` / `@RefreshThrottle('refresh' 30/60 IP)` / `@PasswordChangeThrottle('password-change' 5/60 IP)`;命中抛 `TOO_MANY_REQUESTS`,**不**返 `X-RateLimit-*` / `Retry-After` 头
- **AuthModule 唯一 strategy** 是 `JwtStrategy`;**无** LocalStrategy(沿 [`auth.module.ts:40`](auth.module.ts:40))

## Risk points (不要做)

- ❌ **不**给 `JwtPayload` 加 role / tokenVersion / 完整用户对象等任何额外字段(沿 ARCHITECTURE.md §7.6 + P0-E v1 D-4)
- ❌ **不**在 JwtAuthGuard 再写一份用户有效性查库(每请求查库的唯一点是 `JwtStrategy.validate`)
- ❌ **不**在本 PR / 普通改动里引入 access token blacklist / Redis 撤销 / tokenVersion 强一致;当前 access 不主动吊销是显式策略,如需变更必须走设计决议
- ❌ **不**把 refresh token 明文写入 DB / 日志 / audit / OpenAPI 示例 / e2e fixture / 文档示例(沿评审稿 §5.1)
- ❌ **不**弱化 refresh rotation / family revoke / reuse detection 语义;判断顺序 `rotatedAt → revokedAt → user inactive` 不可调换
- ❌ **不**让 login 失败响应在 5 类场景间出现可区分 timing / message / status — 防账号枚举
- ❌ **不**绕过 `TIMING_DUMMY_HASH`;命中或未命中都必须跑一次 `bcrypt.compare`
- ❌ **不**在本 PR / 普通改动里调整 `/auth/logout` 幂等或限流策略;如需调整必须先做安全评审并补测试
- ❌ **不**引入 LocalStrategy / OAuth / passport-* 其他策略(无设计决议)
- ❌ **不**改 `AuditMeta` 构造方式为隐式(cls-rs / AsyncLocalStorage);沿 controller `buildAuditMeta(req)` 显式传(沿 D6 v1.1 §11.2 / D8)
- ❌ 本目录任何"普通 docs-only"以外的改动都**非低风险**;改 token 链路 / payload / 错误码 / 限流均按 D 档降速,并跑安全相关 e2e

## Validation

- `pnpm lint` + `pnpm typecheck`
- `pnpm test` — 覆盖 `auth.service` / `refresh-token.util` 单测
- `pnpm test:e2e -- auth` — 覆盖登录 / 刷新 / 注销 / logout-all e2e
- 改 audit event / extra → 必须跑 auth characterization e2e(若存在)
- 改 DTO 字段 / endpoint path / Swagger schema / 错误码 → 必须再跑 `pnpm test:contract`
