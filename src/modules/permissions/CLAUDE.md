# permissions — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);架构边界读 [`/docs/architecture-boundary.md`](../../../docs/architecture-boundary.md);API surface 边界读 [`/docs/api-surface-policy.md`](../../../docs/api-surface-policy.md);相关安全章节读 [`/docs/security.md`](../../../docs/security.md)。本文件**只**记录在本目录工作时容易踩雷的本地铁律。

## Scope

- **RBAC 配置中心**:`Permission` / `RbacRole` / `RolePermission` / `UserRole` CRUD + **判权核心** `RbacService`
- **15+1 端点**(累计):14 个 RBAC CRUD(Permission / Role / RolePermission / UserRole)+ `GET /v2/rbac/me/permissions`(端点 15)+ `POST /v2/rbac/reload`(端点 16)
- **判权优先级**(沿 D7 v1.1 §7.1):SUPER_ADMIN 短路 → ADMIN 经 seed 继承 USER 权限(本身不特判)→ user_roles → role_permissions 聚合 → `.self` 后缀做 ownership
- **不负责**:登录 / refresh / 改密(在 [`/src/modules/auth/`](../auth/));capability map 出口在 [`/src/modules/users/app-capability.service.ts`](../users/app-capability.service.ts) — **不是**本模块

## Local facts

- **入口模式当前现状**:P0-F PR-1 起本模块 5 controller + 多数业务模块 controller 已迁移到"入口仅 `JwtAuthGuard`,**不**挂 `@Roles(...)`,Service 内 `rbac.can()` 判权 + 失败抛 `RBAC_FORBIDDEN(30100)`"模式;但仓库整体仍**双轨并存** — 例如 [`activity-registrations.controller.ts`](../activity-registrations/activity-registrations.controller.ts) 等老 controller 仍用 `@Roles(SUPER_ADMIN, ADMIN)` 入口判权(沿当前迁移进度)。**这是当前迁移状态,不代表鼓励长期混用**;修改权限边界时必须说明 controller guard、service-level `rbac.can()`、数据范围(where 子句 / `.self`)三者关系
- **`RbacService` 是唯一判权出口**:`can()` / `judge()` / `getMyPermissions()` / `reload()`;`SUPER_ADMIN` 短路在 `judge()` 内实现;`ADMIN` 继承 USER 由 **seed 给 ADMIN 内置角色配 USER 级权限点**实现,Service 本身**不**对 `ADMIN` 特判
- **`RbacCacheService` 是 permission resolution cache**(Map + TTL,沿 `RBAC_CACHE_TTL_SECONDS` env / app.config 默认 1800s);**不是**用户身份有效性缓存(身份每请求查库,在 JwtStrategy);invalidate 入口 3 个:`invalidateUser` / `invalidateAllUsersWithRole`(失败仅 logger.warn 不抛)/ `invalidateAll`
- **raw permission ≠ app capability**(沿 D-5.3 + Phase 0.7 §3.2):
  - `GET /api/v2/rbac/me/permissions`(本模块,raw `Permission.code` 集合 + 业务角色摘要;SUPER_ADMIN 返 Permission.code 全集而**非** `["*"]`)
  - `GET /api/app/v1/me/capabilities`(在 `users/` 模块,product-level capability map,经四维降权;**不是**授权证明,后端写端点必须重新做四维校验)
- **`/reload` 三档 scope**:`all` / `user(+userId)` / `role(+roleId)`;缺字段抛 `BAD_REQUEST`;userId / roleId 不存在静默成功;出参恒为 `{ reloaded: true }`
- **`.self` ownership**:`ownerType='user'` → `ownerId === user.id`;`ownerType='member'` → `ownerId === user.memberId`(未绑定 memberId 时 fail-close);未知 ownerType / 缺 resource → fail-close(沿 [`rbac.service.ts:203`](rbac.service.ts:203))
- **错误码段位**:`PERMISSION_NOT_FOUND/30001` / `RBAC_ROLE_NOT_FOUND/30003` / `INVALID_PERMISSION_CODE_FORMAT/30008` / `PERMISSION_CODE_ALREADY_EXISTS/30009` / `LAST_OPS_ADMIN_PROTECTED/30101` 等;`RBAC_FORBIDDEN=30100` 是判权失败统一码
- **Permission 物理删**(D4 v1.0);`RolePermission` FK Cascade 自动联级清理
- **seed 文件** [`/prisma/seed.ts`](../../../prisma/seed.ts) 内 `RBAC_PERMISSION_SEED` / `DICT_PERMISSION_SEED` / `ORG_PERMISSION_SEED` 等;**RolePermission 映射 + Permission code 集合属于高风险变更**

## Risk points (不要做)

- ❌ **不**在本"docs-only / 局部 PR"中把 controller 入口 `@Roles` ↔ Service 内 `rbac.can()` 双轨随手统一成单一模型;现状是迁移中,统一改造需独立设计 PR — 但**不代表鼓励长期混用**
- ❌ **不**把 `/api/v2/rbac/me/permissions` 与 `/api/app/v1/me/capabilities` 混为一谈;raw code 不出 App;capability 不替代后端判权
- ❌ **不**在本"docs-only / 局部 PR"中改 seed `Permission.code` 集合 / `RolePermission` 映射 / `RbacRole` 内置角色 — 任何 Permission code 改名 / 增删 / 角色权限重映射都按 D 档降速,先与维护者对齐
- ❌ **不**给 `RbacService.can()` 加 `ADMIN` 内置短路(`ADMIN` 继承 USER 由 seed 实现;Service 不特判,沿 [`rbac.service.ts:124`](rbac.service.ts:124))
- ❌ **不**给 `SUPER_ADMIN` 的 `me/permissions` 返 `["*"]` 或空数组(返 `Permission.code` 全集是显式拍板)
- ❌ **不**新增 `GET /v2/users/:userId/permissions`(管理员查他人;非 D7 §5.1 端点;沿用户拍板留 PR 边界)
- ❌ **不**批量给所有业务 controller 接 `rbac.can()`;新增 / 改判权要说明三层关系:controller 入口 Guard、Service 内 `rbac.can()`、数据范围(where 子句 / `.self`)
- ❌ **不**改 `RBAC_FORBIDDEN=30100` / `LAST_OPS_ADMIN_PROTECTED=30101` 等错误码语义 / 段位;新增段位前先与维护者对齐
- ❌ **不**弱化 `SUPER_ADMIN > ADMIN > USER` 三档身份边界;**不**让 RBAC 业务角色拿到等同 `SUPER_ADMIN` 的短路语义
- ❌ **不**引入 CASL / 完整动态权限平台 / 新权限 DSL(无设计决议)
- ❌ **不**把 `RbacCacheService` 当用户身份缓存用 — invalidate 链路也只清权限点缓存,不阻断已签 JWT
- ❌ **不**改 `rbac-cache.service.ts` 失败语义(`invalidateAllUsersWithRole` 失败 logger.warn 不抛是显式范式)

## Validation

- `pnpm lint` + `pnpm typecheck`
- `pnpm test` — 覆盖 `rbac.service.spec.ts`(判权矩阵)
- `pnpm test:e2e` — 至少覆盖 RBAC CRUD + `me/permissions` + `/reload` 相关 e2e
- 改任一业务模块判权 → 还需跑该业务模块对应 e2e + characterization
- 改 DTO 字段 / endpoint path / Swagger schema / 错误码 → 必须再跑 `pnpm test:contract`
