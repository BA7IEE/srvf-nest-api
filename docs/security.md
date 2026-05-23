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
| 登录限流 | `@nestjs/throttler` 内存 storage | 仅 `POST /api/auth/login`,IP 维度 5 次 / 60 秒(可配),不暴露阈值 |
| 日志敏感字段 redact | `bootstrap/logger-options.ts` | 命中字段日志显示为 `[REDACTED]`,**不仅仅是长度截断** |
| 启动强校验 | `config/app.config.ts` + `prisma/seed.ts` | `APP_ENV=production` 下拒绝默认值的 `JWT_SECRET` / `APP_CORS_ORIGIN=*` / `SUPER_ADMIN_PASSWORD` / `SUPER_ADMIN_USERNAME=admin` |
| 本人自助改密 | `users.controller.ts` + `users.service.ts` + `audit-logs.service.ts` | `PUT /api/users/me/password`(`ChangeMyPasswordDto { oldPassword, newPassword }`);严格事务内顺序:`bcrypt.compare(oldPassword)` → 严格 `===` 比较 oldPassword/newPassword → `bcrypt.hash(newPassword)` → 写 audit log `password.change.self`;响应 `userSafeSelect`(永不含 `passwordHash`);**不**主动吊销旧 token(沿 Token 吊销升级路径) |
| 改密接口防爆破 | `@PasswordChangeThrottle` + `throttler-biz.guard.ts` | 独立 throttler 实例 `password-change`,与登录限流物理隔离;IP 维度 5 次 / 60 秒(`PASSWORD_CHANGE_THROTTLE_LIMIT` / `PASSWORD_CHANGE_THROTTLE_TTL_SECONDS` 可配);内存 storage(不引入 Redis);不暴露阈值 / `Retry-After` / `X-RateLimit-*` |
| refresh token / logout / logout-all(P0-E PR-3) | `auth.service.ts` + `refresh-token.util.ts` + `audit-logs.service.ts` | `POST /api/auth/refresh`(rotation always + family revoke + absolute expiration)/ `POST /api/auth/logout`(幂等;只撤销当前 row)/ `POST /api/auth/logout-all`(撤销该 user 全部 refresh);`refresh_tokens` 表只存 `sha256(raw).hex`,明文绝不入库;refresh 失败 4 子原因统一 `REFRESH_TOKEN_INVALID=10007`(不拆 EXPIRED/REVOKED/REPLAY);**access token 仍不主动吊销**(沿 D-4);TTL `access 15m / refresh 90d` |
| refresh 接口防爆破 | `@RefreshThrottle` + `throttler-biz.guard.ts`(P0-E PR-3)| 独立 throttler 实例 `refresh`,与登录 / 改密物理隔离;IP 维度 30 次 / 60 秒(`REFRESH_THROTTLE_LIMIT` / `REFRESH_THROTTLE_TTL_SECONDS` 可配,放宽允许多 tab 并发 refresh);内存 storage;不暴露阈值头 |
| 改密 / 重置 / 禁用 / 软删联动撤销 refresh(P0-E PR-3) | `users.service.ts` 同事务 `tx.refreshToken.updateMany` | 本人改密 → `self-password-change` / 管理员重置 → `admin-password-reset`(+ 新 audit `password.reset.by-admin`)/ 用户被禁用 → `admin-disable` / 用户软删 → `admin-delete`;**access token 仍不主动吊销**(沿 D-4;15m 自然过期 + `JwtStrategy.validate` 每请求查库阻断 DISABLED / 软删);**JWT payload 严格 zero drift** `{ sub, username }` |

### 日志 redact 清单

```
req.headers.authorization
req.headers.cookie
res.headers["set-cookie"]
req.body.password
req.body.oldPassword
req.body.newPassword
req.body.token
req.body.accessToken
req.body.refreshToken
*.password
*.oldPassword
*.newPassword
*.passwordHash
*.token
*.accessToken
*.refreshToken
*.secret
```

新增字段时同步追加,不能只在某条日志手工裁剪。

---

## 软删除策略

- **当前版本支持软删除**:`DELETE /api/users/:id` 走 `update({ deletedAt: new Date(), status: DISABLED })`,从不调用 `prisma.user.delete()`
- 所有非"管理员看回收站"查询经 `notDeletedWhere()` 过滤,业务接口看不到已删用户
- `username` / `email` 唯一性预检查走 `findUnique`(包含软删记录),软删后这两个字段**不复用**——避免身份冒用
- **当前版本不提供 restore 接口**;误删恢复需数据库管理员人工操作:
  ```sql
  UPDATE "User" SET "deletedAt" = NULL, "status" = 'ACTIVE' WHERE id = '...';
  ```
- 后续若实现 restore,接口契约预定义为:
  - `PATCH /api/users/:id/restore`
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
| `POST /api/auth/refresh` | rotation always + family revoke + absolute expiration;失败统一 `REFRESH_TOKEN_INVALID=10007` |
| `POST /api/auth/logout` | 幂等;只撤销当前 refresh row;不吊销 access |
| `POST /api/auth/logout-all` | 撤销该 user 全部未过期未撤销 refresh;返 `{ revokedCount }` |
| `LoginResponseDto` 扩展 | `refreshToken`(256bit base64url opaque random)+ `refreshExpiresAt`(ISO 8601 UTC family absolute expiration 时刻);字段集恰好 5 项 |
| **refresh_tokens 表** | `tokenHash @unique`(sha256 hex)+ `familyId` + `expiresAt` + `rotatedAt` + `revokedAt` + `revokedReason` + `replacedById` + `ipFirstSeen` / `uaFirstSeen`(后两者仅供审计不出对外 API) |
| **联动撤销 4 场景** | 本人改密 `self-password-change` / 管理员重置 `admin-password-reset` / 用户禁用 `admin-disable` / 用户软删 `admin-delete`(同事务原子) |
| TTL 锁定 | `JWT_EXPIRES_IN=15m`(由 7d 收敛)/ `JWT_REFRESH_EXPIRES_IN=90d` family **absolute expiration**;rotation 继承同一 `refreshExpiresAt` 不延长;**禁止** sliding expiration |
| 限流 | 独立 throttler `refresh` 30/60 IP(与 `default` / `password-change` 物理隔离);`logout` **无限流**;`logout-all` 复用 `password-change` 5/60 IP |
| audit | 新增 `auth.login` / `auth.refresh` / `auth.logout` / `auth.logout-all` / `password.reset.by-admin` 共 5 事件 |

### P0-E 仍不做(沿评审稿 v1 D-4 / D-9)

- **`tokenVersion` 字段**(本期不做;`User` schema 不增字段):依靠 access TTL 15m 自然过期 + `JwtStrategy.validate` 每请求查库阻断 DISABLED / 软删 user
- **access token 不主动吊销**:改密 / 禁用 / 删除后,access 在剩余 ≤ 15m TTL 内仍可用;`JwtStrategy.validate()` 只看 `deletedAt === null && status === UserStatus.ACTIVE`,**不读** `passwordHash` / `tokenVersion`
- access token blacklist / JWT revoke list / Redis / Queue / Cron / 完整 OAuth tree / httpOnly cookie / refresh_tokens 查询接口 / 已登录设备列表 UI / 单设备管理 / device fingerprint / 微信小程序 OAuth

### refresh token 安全策略(P0-E PR-3 锁定;沿 [`AGENTS.md §9` P0-E 子节](../AGENTS.md))

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
| logout 行为 | 只撤销当前 row;同 family 其他 rotation 链不动;幂等;**不**吊销 access |
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
6. **升级条件**:见 [`ARCHITECTURE.md`](../ARCHITECTURE.md) §9。**AI 不得在 P0-E 范围内实现**,需用户明确确认升级后单独立项(沿 P0-E v1 D-4 + [`AGENTS.md §1 B 档`](../AGENTS.md) "默认不做,可评审解锁")

**为什么 P0-E 没做**:`status=DISABLED` 即时阻断 + access TTL 15m 自然过期 + refresh 撤销联动已覆盖绝大多数场景;`tokenVersion` 增加 schema 维护与 JWT payload 字段(破坏 zero drift),投入 / 回报不匹配。仅在出现"5s 内必须失效"硬性诉求时再立项。
