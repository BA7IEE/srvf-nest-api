# audit-logs — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md)；鉴权与 RBAC 单轨读 [`/docs/reference/auth-jwt-refresh.md`](../../../docs/reference/auth-jwt-refresh.md)。本文件只记录本目录易漂移的读取范围与不可变写入边界。

## Scope

- 对外仅 `GET system/v1/audit-logs` 与 `GET system/v1/audit-logs/:id`；禁止新增 update / delete / export。
- `AuditLogsService.log()` 是业务写路径的不可变追加入口；读取 audit-logs 自身不写 audit。
- 入口授权只走 `RbacService.can('audit-log.read.entry')`，因此只认当前有效 `USER × GLOBAL RoleBinding`；不把本模块伪装成 `AuthzService` scoped consumer。

## Read scope

- `SUPER_ADMIN` 可读取全部。
- 其他持有 `audit-log.read.entry` 的账号，不论系统 `Role` 是 ADMIN 还是 USER，只能读取：
  - `actorUserId === currentUser.id`；或
  - `actorRoleSnap === Role.USER`。
- `actorUserId=null` 的系统记录仅 SUPER_ADMIN 可读，除非该行 `actorRoleSnap=USER`。
- list 与 detail 必须复用 `AuditLogReadScopePolicy`。list 把显式过滤与强制范围用数据库 `AND` 求交；禁止覆盖调用方过滤，也禁止读后内存裁剪，否则 `total` / 分页会失真或泄露。
- detail 先区分不存在 `14001`，存在但超出范围返 `14101`；list 对超范围行静默隐藏。无入口权限统一返 `30100`。

## Contract locks

- query、DTO、context 形状与错误码不因读取范围改变。
- 稳定排序保持 `createdAt DESC, id DESC`。
- `auditLogSafeSelect` 与 `AuditLogResponseDto` 同步；不暴露 actor relation。
- 不新增 Permission / Role / seed / schema / migration，也不让 scoped RoleBinding 在本模块生效。

## Validation

- unit：read-scope policy + `audit-logs.service.spec.ts`
- E2E：`audit-logs.e2e-spec.ts`（真实 Role.USER + GLOBAL RoleBinding + HTTP）与写路径回归 `audit-logs-migrations.e2e-spec.ts`
- RBAC 任期/等价探针、contract snapshot、全量 `pnpm agent:check:full`
