# users — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);权限与鉴权边界读 [`/src/modules/permissions/CLAUDE.md`](../permissions/CLAUDE.md);安全规则读 [`/docs/security.md`](../../../docs/security.md)。本文件只记录在本目录工作时容易踩雷的本地铁律。

## Scope

- Admin 用户 CRUD、角色/状态/密码管理，以及 App 本人资料、手机号、微信绑定等用户身份面。
- 管理端入口由 `rbac.can()` 判粗粒度权限；能操作谁继续由 `users.policy.ts` 与自我保护规则判定。

## Local facts

- **身份有效性不缓存**:`JwtStrategy.validate()` 每请求查库；本模块禁用/软删下一请求即时失效。
- **跨域事务身份读取（C1 D2a）**:`user-active-identity.query.ts` 的 `loadActiveUserIdentityInTx(tx, userId)` 是 User 属主公开的只读原语；只返 ACTIVE 且未软删的 id/username/role/status/memberId，无结果返 null。调用者负责事务、显式锁序与后续 `rbac.can(...tx)`；原语不新建事务、不取隐式锁、不缓存，不改旧用户 API。指标命令在等待锁后再次调用，禁止改回跨域直读 User 或拿请求开始时的身份替代。
- **App 活动能力投影**:`/me/capabilities` 的 `activities.canInitiateActivity/canDirectPublishOwnActivity` 与 `managed.*` 只作产品入口提示；每次按共享 `isFormalMemberGradeCode()`（精确 `level-1`…`level-7`）、当前 authz scope、本人发起记录和 active responsibility 直读 PostgreSQL，零跨请求缓存，写端仍须重新判权。
- **最后管理员保护(v0.61.0 PR-C)**:`UsersService.updateRole/updateStatus/softDelete` 不自建 count。三条 last-SUPER_ADMIN 削权路径统一委托 `LastAdminProtectionPolicy` 并取 `users:last-super-admin` advisory lock；禁用/软删用户还须取 `role-bindings:last-ops-admin` 锁，锁后按统一任期真值重算。若操作会让当前有效 ops-admin holder 或其中 `endedAt=null` 常驻 holder 任一归零，返既有 `LAST_OPS_ADMIN_PROTECTED=30101`。
- **事务边界**:上述 guard 与实际角色/状态/软删写入必须在同一 `prisma.$transaction` 内；锁后重算、再写入，禁止把检查移到事务外。
- **联动撤销不变**:禁用/软删成功仍在同事务撤销 refresh token，reason 分别为 `admin-disable` / `admin-delete`；保护守卫拒绝时用户与 refresh token 均不得变化。
- **本人身份换绑 step-up**:`PUT app/v1/me/phone` / `me/wechat` / `me/wecom` 均必填 `stepUpToken`；transaction 内先用 parameterized `SELECT ... FOR UPDATE` 锁当前 User，再重读完整 credential snapshot 并校验 action-bound proof。真实变更才在同事务写身份、撤销全部活跃未过期 refresh(`self-phone-identity-change` / `self-wechat-identity-change` / `self-wecom-identity-change`)并写既有 masked bind/rebind audit；同目标 no-op 不撤 refresh、不写变更 audit。旧 access 不主动吊销。
- **企业微信身份子域(T3,2026-08-02)**:`user-wecom-binding.service.ts` 独立成文件(冻结稿 §4.1 文件计划),承载 `GET/PUT app/v1/me/wecom` 与 `DELETE admin/v1/users/:id/wecom`;**不进** `users.service.ts`。与 auth 的 `login-wecom.service.ts` 是**姊妹方法**(锁序 / occupancy 判据 / revoke+create 两步 / refresh 撤销 / Audit 形状逐条对齐,只差"用什么证明账号控制权":那边短信码,这边 step-up proof)—— **改一边必须同时翻另一边**。`WECOM_BIND` 的 proof 校验必须传**锁后重读**的身份快照(传锁前的会让"管理员刚清除、旧 proof 又绑回来"这条攻击重新打开)。admin 清除是解除绑定的唯一显式路径(D-WC-9,App 无 `DELETE me/wecom`),幂等空转不写 audit、不撤 refresh。
- **企业微信身份的生命周期归属(T4,2026-08-02,D-WC-10)**:撤销 active `WecomIdentity` 的**唯一原语**是 [`wecom-identity-revoke.ts`](wecom-identity-revoke.ts) 的 `revokeActiveWecomIdentityInTx(tx, {userId, revokedByUserId, revokedAt})`(纯 tx 函数,沿 `auth/auth-session-lock` 范式;`members.service.reopenAccount` 跨模块直接 import,**不**注入 UsersService、不产生模块环)。三个落点 —— `clearUserWecom` / `softDelete` / members `reopenAccount` —— 一律调它,**禁止**任何一处自己写 `wecomIdentity.update`。调用位置固定在 `lockAuthSessionUser` **之后**、refresh 撤销与 audit **之前**(锁序 §9.1 `User → WecomIdentity → RefreshToken/Audit`);原语自身刻意不取 User 锁(隐式取锁 = 调用方看不见的锁序)。
- **代际终止 vs 临时停用(T4 分界线,别搞反)**:**撤销** = `softDelete`(User 不会回来了)+ members `reopenAccount`(旧 User 代际终止);**保留** = `updateStatus` disable / enable、members `account/status`、members `offboard` —— 这三条**一列都不许动**(停用可恢复,绑定是组织资产不随状态抖动;顺手撤掉会让每次误禁再恢复都逼用户重走企业微信授权,而这条错误没有任何断言会红)。判据钉在 `test/e2e/wecom-user-lifecycle.e2e-spec.ts` 的**整行快照相等**(含 `updatedAt`)。审计走既有 umbrella 事件加一个 `extra.wecomIdentitiesRevoked`(恒写含 0),**不另造逐腿事件**(冻结稿 §11.3 末条)。
- **账号头像(issue #1055 T3,2026-08-20)**:`app-avatar.service.ts` 独立成文件,承载 `GET/POST/DELETE app/v1/me/avatar`;**不进** `users.service.ts`。形状是 **multipart 直传服务端**(不是 issue §7.1 的 upload-url + confirm)—— 服务端要规范化就必须看见字节,签名 URL 直传会让**未规范化的原图带着 EXIF/GPS 先落进 storage**。本模块**只依赖 attachments 的一个面**(`AttachmentVisualIdentityUploadService`);`AttachmentAccessService` / `AttachmentStorageOrchestrator` 都没有导出,拿不到它们正是 internal-only 边界的一部分。事务边界恒为「短事务备 intent → **事务外** Provider put+HEAD → 短事务落库改指针」,两次都 `SELECT … FOR UPDATE` 锁 User(阶段间锁是放开的,中途账号可能已被软删)。清空幂等,**空转不写 audit**(沿 `wecom.clear.by-admin` 口径)。
- ❌ **旧头像清理必须 `prepareDelete` + `executeEventKey` 成对调用**:前者只落删除意图并返 eventKey,后者才做 Provider 调用与 Attachment 行删除。只调前半截的现象是**替换成功、指针也对,只有旧行永远不走** —— 表面上一切正常。配对形状见 `attachment-write.service.ts:362-367`。
- **控制面审计(2026-07-13 第六刀)**:`updateRole` / `updateStatus` / `softDelete` 与用户行写入在同一事务记录 `user.role.update` / `user.status.update` / `user.soft-delete`；before/after 仅含 role/status/delete 动作，不得含 `passwordHash` 或任何 secret。该决定推翻 users D-PR3-2 的“不写 audit”挂起结论。
- **linked Member 生命周期锁**:linked 账号状态更新固定按 advisory invariant（削权时）→ Member → User 取锁并锁后重读；启用前再次确认 Member=ACTIVE。`SUPER_ADMIN` 削权的 advisory 顺序固定 last-SA → last-ops；不得先锁 User 再等待 invariant lock，否则互禁事务会经 audit actor 外键形成死锁。该顺序与 members offboard 共用，禁止 INACTIVE Member 的账号被用户轴重新启用。
- **角色边界不变**:`SUPER_ADMIN > ADMIN > USER`、自我保护、`assertCanManageUser`、最后一个 SUPER_ADMIN 保护均沿 [`roles-admin-protection`](../../../docs/reference/roles-admin-protection.md)；不得把 RBAC 业务角色当作系统 `Role.SUPER_ADMIN`。
- **User session 锁(2026-07-22 D-PR1)**：本人/管理员改密、status/soft-delete、phone/wechat 真实变更或清除都在原事务内复用 `auth-session-lock.ts` 的 User 行锁，锁后重读权威身份快照，再写 User、撤 refresh、写 audit；linked 账号继续先锁 Member，削权继续先取既有 invariant advisory lock。

## Risk points

- ❌ 不在 users service 复制 last-admin count / advisory-lock SQL；新增削权入口必须复用 `LastAdminProtectionPolicy`。
- ❌ 不因 ops-admin 守卫改 DTO、端点、OpenAPI、Role enum 或 token 行为。
- ❌ 不把 GLOBAL RoleBinding 的任期判定复制进 users；判权与 last-ops-admin 的任期真值都在 `permissions/role-binding-validity.ts`，并同时守住当前有效与当前常驻两组 holder。
- ❌ 不把 proof 校验移到 User 行锁外，不用 `$queryRawUnsafe` / 字符串拼接锁 SQL；不把 `stepUpToken`、snapshot、当前因子或完整 phone/openid 写入 audit / 日志 / App 响应。
- ❌ 不在 User session 相关路径复制 `FOR UPDATE` SQL 或 broad revoke 后补锁；顺序必须是 invariant/Member → `lockAuthSessionUser()` → 锁后复读 → mutation/revoke → audit。

## Validation

- `pnpm test -- --runInBand src/modules/users/users.service.spec.ts src/modules/permissions/last-admin-protection.policy.spec.ts`
- `pnpm test:e2e -- users-last-super-admin user-roles role-bindings`
- 改端点/DTO/Swagger 时另跑 `pnpm test:contract`；本次第二档收口要求 contract 零漂移。
