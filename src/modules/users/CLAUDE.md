# users — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);权限与鉴权边界读 [`/src/modules/permissions/CLAUDE.md`](../permissions/CLAUDE.md);安全规则读 [`/docs/security.md`](../../../docs/security.md)。本文件只记录在本目录工作时容易踩雷的本地铁律。

## Scope

- Admin 用户 CRUD、角色/状态/密码管理，以及 App 本人资料、手机号、微信绑定等用户身份面。
- 管理端入口由 `rbac.can()` 判粗粒度权限；能操作谁继续由 `users.policy.ts` 与自我保护规则判定。

## Local facts

- **身份有效性不缓存**:`JwtStrategy.validate()` 每请求查库；本模块禁用/软删下一请求即时失效。
- **最后管理员保护(2026-07-13 第二档安全收口)**:`UsersService.updateRole/updateStatus/softDelete` 不再自建 count。三条 last-SUPER_ADMIN 削权路径统一委托 `LastAdminProtectionPolicy` 并取 `users:last-super-admin` advisory lock；禁用/软删用户还须取 `role-bindings:last-ops-admin` 锁，若目标是唯一 active GLOBAL `ops-admin` 持有人则返既有 `LAST_OPS_ADMIN_PROTECTED=30101`。
- **事务边界**:上述 guard 与实际角色/状态/软删写入必须在同一 `prisma.$transaction` 内；锁后重算、再写入，禁止把检查移到事务外。
- **联动撤销不变**:禁用/软删成功仍在同事务撤销 refresh token，reason 分别为 `admin-disable` / `admin-delete`；保护守卫拒绝时用户与 refresh token 均不得变化。
- **本人身份换绑 step-up**:`PUT app/v1/me/phone` / `me/wechat` 均必填 `stepUpToken`；transaction 内先用 parameterized `SELECT ... FOR UPDATE` 锁当前 User，再重读完整 credential snapshot 并校验 action-bound proof。真实变更才在同事务写身份、撤销全部活跃未过期 refresh(`self-phone-identity-change` / `self-wechat-identity-change`)并写既有 masked bind/rebind audit；同目标 no-op 不撤 refresh、不写变更 audit。旧 access 不主动吊销。
- **控制面审计(2026-07-13 第六刀)**:`updateRole` / `updateStatus` / `softDelete` 与用户行写入在同一事务记录 `user.role.update` / `user.status.update` / `user.soft-delete`；before/after 仅含 role/status/delete 动作，不得含 `passwordHash` 或任何 secret。该决定推翻 users D-PR3-2 的“不写 audit”挂起结论。
- **linked Member 生命周期锁**:linked 账号状态更新固定按 advisory invariant（削权时）→ Member → User 取锁并锁后重读；启用前再次确认 Member=ACTIVE。`SUPER_ADMIN` 削权的 advisory 顺序固定 last-SA → last-ops；不得先锁 User 再等待 invariant lock，否则互禁事务会经 audit actor 外键形成死锁。该顺序与 members offboard 共用，禁止 INACTIVE Member 的账号被用户轴重新启用。
- **角色边界不变**:`SUPER_ADMIN > ADMIN > USER`、自我保护、`assertCanManageUser`、最后一个 SUPER_ADMIN 保护均沿 harness reference/roles-admin-protection.md；不得把 RBAC 业务角色当作系统 `Role.SUPER_ADMIN`。

## Risk points

- ❌ 不在 users service 复制 last-admin count / advisory-lock SQL；新增削权入口必须复用 `LastAdminProtectionPolicy`。
- ❌ 不因 ops-admin 守卫改 DTO、端点、OpenAPI、Role enum 或 token 行为。
- ❌ 不把 GLOBAL RoleBinding 的任期判定复制进 users；判权任期真值在 `permissions/role-binding-validity.ts`，last-ops-admin 不变量沿 active binding + active user 的既有口径。
- ❌ 不把 proof 校验移到 User 行锁外，不用 `$queryRawUnsafe` / 字符串拼接锁 SQL；不把 `stepUpToken`、snapshot、当前因子或完整 phone/openid 写入 audit / 日志 / App 响应。

## Validation

- `pnpm test -- --runInBand src/modules/users/users.service.spec.ts src/modules/permissions/last-admin-protection.policy.spec.ts`
- `pnpm test:e2e -- users-last-super-admin user-roles role-bindings`
- 改端点/DTO/Swagger 时另跑 `pnpm test:contract`；本次第二档收口要求 contract 零漂移。
