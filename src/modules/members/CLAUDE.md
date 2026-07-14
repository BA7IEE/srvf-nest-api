# members — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);权限保护读 [`/src/modules/permissions/CLAUDE.md`](../permissions/CLAUDE.md);架构边界读 [`/docs/architecture-boundary.md`](../../../docs/architecture-boundary.md)。本文件只记录队员模块容易踩雷的本地铁律。

## Scope

- 队员 CRUD、账号开通/绑定/解绑/退号重开/启停/批量开号，以及一键离队编排。
- 队员轴直接写关联 `User` 的既有路径只承接 `role=USER` 账号；管理员或 SUPER_ADMIN 账号必须回用户轴处理。

## Local facts

- **最后 ops-admin 保护(2026-07-13 finding-4 同类残留收口)**:`MembersService` 注入 permissions 模块导出的 `LastAdminProtectionPolicy`。三条会让 live 关联账号退出 active holder 集合的路径，均在原事务内、实际停用/软删前调用同一个 `assertCanDeactivateOpsAdminUser(tx, userId)`：`updateAccountStatus` 仅 `status=DISABLED`；`offboard` 仅 linked 存在且尚未 DISABLED；`reopenAccount` 软删 `oldLink` 前。
- **跨轴同锁**:上述调用复用 policy 内唯一锁键 `role-bindings:last-ops-admin`，与 users disable/soft-delete、role-bindings、user-roles 削权路径串行；禁止在 members 内复制 count、任期谓词、advisory-lock SQL 或另造锁键。
- **事务与副作用顺序不变**:守卫拒绝时账号、ops-admin 绑定、member/offboard 其它腿、refresh token 与 reopen 新号均不得变化；放行后仍沿既有顺序执行 refresh 撤销、探测式 username、先软删旧号再建新号及 audit。
- **非削权路径不接守卫**:`bindAccount` 只写 `memberId`；`unbindAccount` 只置 `memberId=null`，账号仍 live，二者不调用最后管理员策略。
- **role 护栏优先**:三条削权路径继续先拒 `role!==USER` 的关联账号；SUPER_ADMIN 不进入 last-ops-admin 检查，沿既有 `MEMBER_ACCOUNT_ROLE_NOT_MANAGEABLE` 行为。
- **账号启停审计(2026-07-14 第七刀)**:`updateAccountStatus` 的 user status 写、禁用时 refresh token 撤销与 `member.account.status-change` 必须在同一事务；before/after 只含 status，extra 只含 linkedUserId/refreshTokensRevoked，禁止 phone/openid/secret。
- **offboard/reopen 已覆盖**:`offboard` 用伞事件 `member.offboard` 记录账号停用腿与撤销计数；`reopenAccount` 用 `member.account-reopened` 记录旧号软删/新号创建结果，两者原本即与业务写同事务，第七刀不新增重复事件。

## Risk points

- ❌ 不复用 `UsersService`、不引入模块环，也不把 policy 调用移到事务外。
- ❌ 不因本保护改 endpoint、DTO、OpenAPI、Permission、Role、BizCode、schema 或 migration。
- ❌ 不改变 offboard 幂等 skip、refresh 撤销 reason、reopen username 探测与软删/建号先后序。

## Validation

- `pnpm test:e2e -- members-last-ops-admin members-account-lifecycle members-offboard users-last-super-admin control-plane-audit-characterization`
- 依赖 permissions policy 的安全改动必须跑 `pnpm agent:check:full`，并确认 contract snapshot 零漂移。
