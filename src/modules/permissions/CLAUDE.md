# permissions — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);架构边界读 [`/docs/architecture-boundary.md`](../../../docs/architecture-boundary.md);API surface 边界读 [`/docs/api-surface-policy.md`](../../../docs/api-surface-policy.md);相关安全章节读 [`/docs/security.md`](../../../docs/security.md)。本文件**只**记录在本目录工作时容易踩雷的本地铁律。

## Scope

- **RBAC 配置中心**:`Permission` / `RbacRole` / `RolePermission` / `UserRole` CRUD + **判权核心** `RbacService`
- **15+1 端点**(累计):14 个 RBAC CRUD(Permission / Role / RolePermission / UserRole)+ `GET /api/system/v1/rbac/me/permissions`(端点 15)+ `POST /api/system/v1/rbac/reload`(端点 16)
- **判权优先级**(沿 D7 v1.1 §7.1):SUPER_ADMIN 短路 → ADMIN 经 seed 继承 USER 权限(本身不特判)→ **global RoleBinding**(终态 scoped-authz PR6 起,判权读源从 `user_roles` 重指向 `RoleBinding(principalType=USER, scopeType=GLOBAL, status=ACTIVE)`)→ role_permissions 聚合 → `.self` 后缀做 ownership
- **不负责**:登录 / refresh / 改密(在 [`/src/modules/auth/`](../auth/));capability map 出口在 [`/src/modules/users/app-capability.service.ts`](../users/app-capability.service.ts) — **不是**本模块

## Local facts

- **入口模式当前现状(2026-06-11 Slow-4 收口,单轨)**:全仓 controller 一律"入口仅 `JwtAuthGuard`,**不**挂 `@Roles(...)`,Service 内 `rbac.can()` 判权 + 失败抛 `RBAC_FORBIDDEN(30100)`"(活跃 `@Roles` = 0;`RolesGuard` 机制保留 Guard 链作防御性兜底;activities 列表/详情等 `[auth]` 端点无码仅登录)。业务面 ADMIN 权限由内置角色 `biz-admin`(绑 35)承载,seed 幂等补挂每个非软删 ADMIN;修改权限边界时仍必须说明 controller guard、service-level `rbac.can()`、数据范围(where 子句 / `.self`)三者关系
- **`RbacService` 是唯一 legacy GLOBAL 判权出口**:`can()` / `judge()` / `getMyPermissions()` / `reload()`;`getUserPermissionCodes()` 每次直读 PostgreSQL 当前事实,无跨请求 Map/TTL;`SUPER_ADMIN` 短路在 `judge()` 内实现;`ADMIN` 继承 USER 由 **seed 给 ADMIN 内置角色配 USER 级权限点**实现,Service 本身**不**对 `ADMIN` 特判
- **🔴 判权唯一读源 = 当前在期 global RoleBinding(终态 scoped-authz PR6;冻结稿 §8.2 行为锁)**:`getUserPermissionCodes`〔判权聚合〕/`getEffectiveRoles`〔角色摘要〕**只读** `RoleBinding(principalType=USER, scopeType=GLOBAL, status=ACTIVE, startedAt<=now, endedAt=null|>=now, deletedAt=null)`;任期边界与 `AuthzService` 共用 [`role-binding-validity.ts`](role-binding-validity.ts) 单一谓词/where 构造(起止时刻均含边界),未来/过期 GLOBAL 绑定不再产权限或角色摘要。**旧 UserRole 表已 DROP**(每条 UserRole 已由第 37 migration 回填为该形态 RoleBinding;第 39 migration 冻结表 cleanup 物理删除)。**只读 GLOBAL,绝不判 scoped**——经 `role-bindings/` CRUD 建的 ORGANIZATION/TREE/ACTIVITY/RESOURCE/SELF 绑定入库即止,判权忽略(scoped 判权是 PR8 AuthzService)。改判权/读源必跑 characterization(rbac.service.spec 判权矩阵 + user-roles/role-bindings e2e + `authz-rbac-equivalence` 任期矩阵)
- **`UserRolesService` 内部换存储、对外契约零变(PR6)**:assign/list/revoke **读写 global RoleBinding**;端点路径 + 码(`rbac.user-role.{read,create,delete}`)+ 请求/响应 DTO 逐字不变;**撤销 = 软删**(status=ENDED + endedAt + deletedAt,非物理删);建/撤写 audit(`role-binding.{create,revoke}` + extra.viaPath='user-role';**直写 auditLog** 规避 PermissionsModule↔AuditLogsModule 模块环,本仓 forwardRef 零使用)
- **角色委派单一闸(2026-07-13 第一档安全收口)**:`RoleDelegationPolicy.assertActorMayConferRole()` 是 role-bindings create/preview/特权 update + user-roles assign/revoke 的唯一委派入口;`isControlPlanePermissionCode()` 是控制面权限单一谓词(`rbac.*` ∪ `role-binding.*` ∪ 6 条 [`reserved-super-admin-permission-codes.ts`](reserved-super-admin-permission-codes.ts) 保留码)。SUPER_ADMIN 短路;非 SUPER_ADMIN 即使持 global ops-admin,也不得授予/撤销 `ops-admin` 或含任一控制面码的角色(统一 `30102`)。特权 update 指 reactivation 或任期扩张(`startedAt` 提前 / `endedAt` 延后;当前 DTO 不接受 `endedAt:null`,契约不扩字段)
- **末位管理员单一策略(2026-07-13 第二档安全收口)**:[`LastAdminProtectionPolicy`](last-admin-protection.policy.ts) 承接两条不变量及唯一 advisory-lock helper:最后活跃 `SUPER_ADMIN` 使用锁键 `users:last-super-admin`;最后 active GLOBAL `ops-admin` 持有人使用既有锁键 `role-bindings:last-ops-admin`。后者统一覆盖 role-bindings status/remove、旧 user-roles revoke、users disable/soft-delete;最后持有人统一返既有 `30101`。新增任何削权路径必须先接此策略,禁止另造 count/lock 或换锁键
- **控制面授码 + 内置角色删保护**:role-permissions assign 对非 SUPER_ADMIN 禁止分配上述任一控制面码,整批返 `30103`;[`protected-role-codes.ts`](protected-role-codes.ts) 是 API 删除保护的 7 角色唯一清单(`ops-admin` / `member` / `biz-admin` / `org-admin` / `group-manager` / `org-supervisor` / `attendance-final-reviewer`),任何身份含 SUPER_ADMIN 删除均返 `30104`,自定义角色删除逻辑不变。seed-rbac e2e 是两份 SoT 的漂移哨兵;**禁止**在 service / 测试 / 文档另造代码清单
- **`RbacService.getRoleIdsWithPermission(roleIds, code)` 是 PR8 additive**(终态 scoped-authz;冻结稿 §5.2「roleHasPermission」批量形态):仅供 `authz/` 模块三源虚拟 grant 的"角色含码"过滤;排除软删角色;与 legacy GLOBAL 聚合一样每次直读 DB。`can()/judge()` 仅在 GLOBAL 绑定任期维度收紧为当前在期,其余语义不变 —— 改此方法或任期谓词必跑 authz 等价矩阵 e2e(`authz-rbac-equivalence`)
- **多实例一致性终态(D-RBAC)**:权限/角色/role-permission/user-role/role-binding 写路径不维护本地失效链；提交后其他 Nest 实例下一请求通过共享 PostgreSQL 立即看到 grant/revoke/角色软删。`reload` 仅保留兼容契约与输入校验,不再清内部状态；不引 Redis/pub-sub/替代 cache。
- **raw permission ≠ app capability**(沿 D-5.3 + Phase 0.7 §3.2):
  - `GET /api/system/v1/rbac/me/permissions`(本模块,raw `Permission.code` 集合 + 业务角色摘要;SUPER_ADMIN 返 Permission.code 全集而**非** `["*"]`)
  - `GET /api/app/v1/me/capabilities`(在 `users/` 模块,product-level capability map,经四维降权;**不是**授权证明,后端写端点必须重新做四维校验)
- **`/reload` 三档 scope**:`all` / `user(+userId)` / `role(+roleId)`;缺字段抛 `BAD_REQUEST`;userId / roleId 不存在静默成功;出参恒为 `{ reloaded: true }`
- **`.self` ownership**:`ownerType='user'` → `ownerId === user.id`;`ownerType='member'` → `ownerId === user.memberId`(未绑定 memberId 时 fail-close);未知 ownerType / 缺 resource → fail-close(沿 [`rbac.service.ts:203`](rbac.service.ts:203))
- **错误码段位**:`PERMISSION_NOT_FOUND/30001` / `RBAC_ROLE_NOT_FOUND/30003` / `INVALID_PERMISSION_CODE_FORMAT/30008` / `PERMISSION_CODE_ALREADY_EXISTS/30009` / `LAST_OPS_ADMIN_PROTECTED/30101`(含 role-binding/user-role 撤权及禁用/软删最后 ops-admin 持有人) / `CANNOT_ASSIGN_HIGHER_ROLE/30102` / `PERMISSION_RESERVED_SUPER_ADMIN_ONLY/30103` / `PROTECTED_ROLE_DELETE_FORBIDDEN/30104`;`RBAC_FORBIDDEN=30100` 是判权失败统一码
- **Permission 物理删**(D4 v1.0);`RolePermission` FK Cascade 自动联级清理
- **seed 文件** [`/prisma/seed.ts`](../../../prisma/seed.ts) 内 `RBAC_PERMISSION_SEED` / `DICT_PERMISSION_SEED` / `ORG_PERMISSION_SEED` 等;**RolePermission 映射 + Permission code 集合属于高风险变更**

## Risk points (不要做)

- ❌ **不**给任何端点重新挂 `@Roles(...)` 入口判权(Slow-4 已收口单轨;新管理面 endpoint 默认 R 模式,权限事实变更一律 D 档)
- ❌ **不**把 `/api/system/v1/rbac/me/permissions` 与 `/api/app/v1/me/capabilities` 混为一谈;raw code 不出 App;capability 不替代后端判权
- ❌ **不**在本"docs-only / 局部 PR"中改 seed `Permission.code` 集合 / `RolePermission` 映射 / `RbacRole` 内置角色 — 任何 Permission code 改名 / 增删 / 角色权限重映射都按 D 档降速,先与维护者对齐
- ❌ **不**给 `RbacService.can()` 加 `ADMIN` 内置短路(`ADMIN` 继承 USER 由 seed 实现;Service 不特判,沿 [`rbac.service.ts:124`](rbac.service.ts:124))
- ❌ **不**给 `SUPER_ADMIN` 的 `me/permissions` 返 `["*"]` 或空数组(返 `Permission.code` 全集是显式拍板)
- ❌ **不**新增 `GET /api/system/v1/users/:userId/permissions`(管理员查他人;非 D7 §5.1 端点;沿用户拍板留 PR 边界)
- ❌ **不**批量给所有业务 controller 接 `rbac.can()`;新增 / 改判权要说明三层关系:controller 入口 Guard、Service 内 `rbac.can()`、数据范围(where 子句 / `.self`)
- ❌ **不**改 `RBAC_FORBIDDEN=30100` / `LAST_OPS_ADMIN_PROTECTED=30101` 等错误码语义 / 段位;新增段位前先与维护者对齐
- ❌ **不**弱化 `SUPER_ADMIN > ADMIN > USER` 三档身份边界;**不**让 RBAC 业务角色拿到等同 `SUPER_ADMIN` 的短路语义
- ❌ **不**引入 CASL / 完整动态权限平台 / 新权限 DSL(无设计决议)
- ❌ **不**为判权重新引入跨请求 Map/TTL、no-op cache、Redis/pub-sub 或提交后 invalidate 正确性链；当前事实必须由 PostgreSQL 每请求解析

## Validation

- `pnpm lint` + `pnpm typecheck`
- `pnpm test` — 覆盖 `rbac.service.spec.ts`(判权矩阵)
- `pnpm test:e2e` — 至少覆盖 RBAC CRUD + `me/permissions` + `/reload` 相关 e2e
- 改任一业务模块判权 → 还需跑该业务模块对应 e2e + characterization
- 改 DTO 字段 / endpoint path / Swagger schema / 错误码 → 必须再跑 `pnpm test:contract`
