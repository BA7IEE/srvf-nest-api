# members — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);权限保护读 [`/src/modules/permissions/CLAUDE.md`](../permissions/CLAUDE.md);架构边界读 [`/docs/architecture-boundary.md`](../../../docs/architecture-boundary.md)。本文件只记录队员模块容易踩雷的本地铁律。

## Scope

- 队员 CRUD、账号开通/绑定/解绑/退号重开/启停/批量开号，以及一键离队编排。
- 队员轴直接写关联 `User` 的既有路径只承接 `role=USER` 账号；管理员或 SUPER_ADMIN 账号必须回用户轴处理。

## Local facts

- **部门数据范围(v0.49)**:`list/options` 先取 `AuthzService.getVisibleOrganizationScope('member.read.record')`，再与用户 `organizationId/includeDescendants` 过滤取交集；成员归属只认 active PRIMARY，SECONDARY/TEMPORARY/SUPPORT 不扩大可见范围。有效持码但组织集合为空返回空列表，无码才返 30100。
- **point auth**:除 `create` 保持 no-ref/GLOBAL-only 外，成员详情及全部单项写操作都用 `{type:'member', id}`；bulk grant 每项独立 point auth。证书点动作按 certificate ref，档案/联系人/保险按 member ref；`resource_not_found` 仅对旧 GLOBAL 持码者回退既有业务 NOT_FOUND，scoped 调用者统一 30100。
- **敏感二次授权**:`member-profile.read.sensitive` 与 `emergency-contact.read.sensitive` 也必须带 member ref；基础 read 通过但 sensitive 未通过时继续掩码。副职只读投影明确不含任何 `*.read.sensitive`。
- **最后 ops-admin 保护(2026-07-13 finding-4 同类残留收口)**:`MembersService` 注入 permissions 模块导出的 `LastAdminProtectionPolicy`。三条会让 live 关联账号退出 active holder 集合的路径，均在原事务内、实际停用/软删前调用同一个 `assertCanDeactivateOpsAdminUser(tx, userId)`：`updateAccountStatus` 仅 `status=DISABLED`；`offboard` 仅 linked 存在且尚未 DISABLED；`reopenAccount` 软删 `oldLink` 前。
- **跨轴同锁**:上述调用复用 policy 内唯一锁键 `role-bindings:last-ops-admin`，与 users disable/soft-delete、role-bindings、user-roles 削权路径串行；削权事务须先经 policy 取得该 invariant lock，再按 Member → User 取 lifecycle 行锁，锁后调用 assert 重算，避免 audit actor 外键与 advisory lock 形成死锁；禁止在 members 内复制 count、任期谓词、advisory-lock SQL 或另造锁键。
- **事务与副作用顺序不变**:守卫拒绝时账号、ops-admin 绑定、member/offboard 其它腿、refresh token 与 reopen 新号均不得变化；放行后仍沿既有顺序执行 refresh 撤销、探测式 username、先软删旧号再建新号及 audit。
- **非削权路径不接守卫**:`bindAccount` 只写 `memberId`；`unbindAccount` 只置 `memberId=null`，账号仍 live，二者不调用最后管理员策略。
- **role 护栏优先**:三条削权路径继续先拒 `role!==USER` 的关联账号；SUPER_ADMIN 不进入 last-ops-admin 检查，沿既有 `MEMBER_ACCOUNT_ROLE_NOT_MANAGEABLE` 行为。
- **账号启停审计(2026-07-14 第七刀)**:`updateAccountStatus` 的 user status 写、禁用时 refresh token 撤销与 `member.account.status-change` 必须在同一事务；before/after 只含 status，extra 只含 linkedUserId/refreshTokensRevoked，禁止 phone/openid/secret。
- **offboard/reopen 已覆盖**:`offboard` 用伞事件 `member.offboard` 记录账号停用腿与撤销计数；`reopenAccount` 用 `member.account-reopened` 记录旧号软删/新号创建结果，两者原本即与业务写同事务，第七刀不新增重复事件。
- **Member lifecycle 线性化**:offboard、linked 账号启用/绑定/重开、任职/分管创建、USER/MEMBER/POSITION_ASSIGNMENT direct binding 创建或恢复都先锁同一 Member 行；跨资源锁序固定 Member → User。offboard 在该事务内同时结束 active memberships、任职、分管与三类 direct binding，响应中的 residual 任职/分管字段只为兼容保留且终态为 0；INACTIVE Member 不得经任一入口恢复账号或授权来源。
- **Membership offboard 收口**:Member 行锁下逐条调用 Membership 状态机做 ACTIVE→ENDED；ACTIVE 任期按不变式必已开始且 `endedAt=null`，因此 offboard 统一以当前时刻结束，不得恢复批量盲写时间。
- **关联账号 session 锁(2026-07-22 D-PR1)**：`reopenAccount` / `updateAccountStatus` / `offboard` 在 Member 行锁后按 linked userId 调 `lockAuthSessionUser()`，锁后复读 memberId/role/status，再做软删或禁用、refresh 全撤销与 audit；禁止恢复旧的 `memberId` 裸 User 行锁作为 session 第二轨。

## Risk points

- ❌ 不复用 `UsersService`、不引入模块环，也不把 policy 调用移到事务外。
- ❌ 不因本保护改 endpoint、DTO、OpenAPI、Permission、Role、BizCode、schema 或 migration。
- ❌ 不改变 offboard 幂等 skip、refresh 撤销 reason、reopen username 探测与软删/建号先后序。
- ❌ 不绕开 `member-lifecycle-lock.ts` 另造生命周期锁，也不采用 User → Member 的反向锁序。
- ❌ 不在关联账号 session mutation 里先改 User/refresh 再补锁，也不基于锁前 linked role/status 快照提交。

## Validation

- `pnpm test:e2e -- department-data-scope-members.e2e-spec.ts`
- `pnpm test:e2e -- members-last-ops-admin members-account-lifecycle members-offboard users-last-super-admin control-plane-audit-characterization`
- 依赖 permissions policy 的安全改动必须跑 `pnpm agent:check:full`，并确认 contract snapshot 零漂移。
