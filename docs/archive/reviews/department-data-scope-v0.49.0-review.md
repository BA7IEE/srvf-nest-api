# 部门数据范围全面接线评审稿（v0.49.0）

> 状态：**已冻结，允许按本文串行实施**
>
> 冻结日期：2026-07-14
>
> 目标版本：v0.49.0
>
> 任务级别：D（授权矩阵与组织数据范围变更）
>
> 用户授权来源：2026-07-14 Codex goal「部门数据范围全面接线」
>
> 适用范围：本文列出的副职只读派生、Admin 组织范围、成员轴/活动轴接线和前端有效权限出口；不扩张至 App API、招新、入队或其他 RBAC family。

## 1. 开工事实与零迁移结论

冻结时 live `main` 为 `008f05f1`，与 `origin/main` 零 ahead/behind，worktree clean，open PR = 0；`pnpm agent:preflight` 通过。基线版本/最新 tag 均为 v0.48.0。

当前固定计数：Permission 206、内置 RbacRole 7、Prisma migration 50、HTTP routes 337、Controller 66、Module 35、BizCode 232、AuditLogEvent 113。本文实施后预期：Permission 仍为 206、Prisma migration 仍为 50、RbacRole 增至 9；新增一个独立 System Controller 后 routes / Controller 预计分别增至 338 / 67，其余固定计数不变。

本目标不修改 Prisma schema，不生成 migration，不执行 `prisma migrate reset` / `prisma migrate deploy`。若实现中发现必须修改 schema 或执行上述写操作，立即停止并重新取得实时授权。

## 2. 冻结授权矩阵

### 2.1 正职与副职投影

现有正职语义保持：

| 职务 | 自动角色 | scope | 能力来源 |
|---|---|---|---|
| `team-leader` | `org-admin` | `ORGANIZATION_TREE` | 现有 `ORG_ADMIN_PERMISSION_SEED` |
| `dept-leader` | `org-admin` | `ORGANIZATION_TREE` | 现有 `ORG_ADMIN_PERMISSION_SEED` |
| `group-leader` | `group-manager` | `ORGANIZATION_TREE` | 现有 `GROUP_MANAGER_PERMISSION_CODES` |

旧 R5「三个副职零 policy」被本目标明确、有限地取代为「副职只读投影，写权限仍为零」：

| 职务 | 新增自动角色 | scope | 唯一允许的能力来源 |
|---|---|---|---|
| `vice-captain` | `org-readonly` | `ORGANIZATION_TREE` | `ORG_ADMIN_PERMISSION_SEED` 的只读投影 |
| `dept-deputy` | `org-readonly` | `ORGANIZATION_TREE` | `ORG_ADMIN_PERMISSION_SEED` 的只读投影 |
| `deputy-group-leader` | `group-readonly` | `ORGANIZATION_TREE` | `GROUP_MANAGER_PERMISSION_CODES` 的只读投影 |

只读投影必须由对应正职码集计算，禁止手抄第二份 permission 列表。冻结谓词为：

```ts
const isReadonlyProjectionCode = (code: string): boolean =>
  !code.endsWith('.read.sensitive') &&
  (code.includes('.read.') || code.startsWith('attachment.view.'));
```

因此所有 `*.read.sensitive`、create/update/delete/status/approve/reject/publish/upload 等写码和敏感明文码均被排除。`org-readonly` / `group-readonly` 加入 protected role code 清单；seed 每次对两个角色执行**期望集合精确同步**（补缺失并删除过时 RolePermission），不能只做累加 upsert。

seed 运行时不变式冻结为：

1. 三个副职恰好分别映射到上述只读角色，scope 均为 `TREE`；
2. 三个副职不存在指向其他角色的 active policy；
3. 两个只读角色的实际 permission 集合与动态投影完全相等；
4. 投影中不存在 `*.read.sensitive`、不存在任何非只读 permission。

### 2.2 明确不变的权限 family

`recruitment-*`、`recruitment-application.*`、`team-join-*` 的 Permission、RolePermission、PositionRolePolicy 和业务授权代码必须保持 zero diff。`org-readonly` 仅从已经排除了上述中央流程 family 的 `ORG_ADMIN_PERMISSION_SEED` 派生；本目标禁止借机调整招新/入队边界。

## 3. Authz 可见组织范围契约

`AuthzService` 增加统一的「某用户对某 action 的可见组织范围」解析，不另建平行判权实现。其 grant 来源与 `authz.explain()` 同源：direct RoleBinding、PositionRolePolicy 派生、OrganizationSupervisionAssignment 派生，且遵守 active / expired / deleted / organization active 条件。

返回语义冻结为：

```ts
interface VisibleOrganizationScope {
  hasPermission: boolean;
  global: boolean;
  organizationIds: string[];
}
```

- SUPER_ADMIN 或有效 `GLOBAL` grant：`hasPermission=true, global=true`，调用方不加组织过滤。
- 有效 `ORGANIZATION` grant：加入 active scope root。
- 有效 `ORGANIZATION_TREE` grant：通过 `OrganizationClosure` 展开 scope root 及后代组织，去重后返回。
- 仅有非组织型有效 grant：`hasPermission=true, global=false, organizationIds=[]`；对组织平铺列表采取保守空集。
- 仅有过期/删除/失效 grant，或 action 完全无 grant：`hasPermission=false`。
- 调用方发现 `hasPermission=false` 必须抛 `RBAC_FORBIDDEN=30100`；`hasPermission=true` 但可见组织为空必须返回空列表，不能误报 30100。
- 用户显式选择 organization 时，先按现有 descendant 语义展开用户过滤，再与 auth scope 求交集；交集为空返回空列表。

成员/证书/档案轴的组织归属只认 `OrganizationMembership.status=ACTIVE` 且 `membershipType=PRIMARY`。SECONDARY membership 不扩大管理范围。参与域平铺列表按 `Activity.organizationId` 限制。

## 4. 业务接线清单

### 4.1 members 与嵌套资源

| 入口 | action | 资源/过滤轴 | 冻结行为 |
|---|---|---|---|
| members list / options | `member.read.record` | active PRIMARY membership | auth scope 与用户 organization filter 求交；空 scope 返回空集 |
| member detail | `member.read.record` | `{ type: 'member', id }` | 跨组织 30100；GLOBAL 用户仍保留既有 not-found 语义 |
| member update/status/delete/account/binding/offboard/bulk 等所有写入口 | 各入口现有 permission | `{ type: 'member', id }` | 每个目标逐点授权；禁止用列表 scope 替代写授权 |
| member create | 现有 create permission | 无既存 member anchor | 保持 GLOBAL-only；不凭副职/部门 scope 创建 |
| certificates | 现有 certificate action | detail 用 certificate ref；member 入口用 member ref | 跨组织 detail/write 30100 |
| member profiles | 现有 profile action | member ref | 敏感字段仍需独立 sensitive permission；副职只读投影不含 sensitive |
| emergency contacts | 现有 contact action | member ref | 不新增 resolver resource type |
| member insurances | `member-insurance.read.other` | member ref | 跨组织 30100 |

点资源接线沿现有 `AuthzService.explain`；`resource_not_found` 仅在用户原本具有同 action 的 GLOBAL RBAC permission 时回退到既有 service not-found，以避免把不存在资源泄漏给 scoped 用户，同时不破坏全局管理员契约。

### 4.2 participation 五个入口

| 入口 | action | 冻结范围 |
|---|---|---|
| `ActivityRegistrationsService.listAllForAdmin` | `activity-registration.read.record` | `activity.organizationId` ∩ 用户 organization filter |
| `ActivityRegistrationsService.listForMemberAdmin` | `activity-registration.read.record` | member ref |
| `AttendancesService.listAllSheetsForAdmin` | `attendance.read.sheet` | `activity.organizationId` ∩ 用户 organization filter |
| `AttendancesService.listRecordsForMemberAdmin` | 现有 attendance record action | member ref |
| `AttendancesService.getMemberContributionSummary` | 现有 contribution action | member ref |

前两项平铺列表遵守「无 permission=30100、有 permission 但空组织范围=空列表」；后三项跨组织资源统一 30100。

## 5. 前端有效权限出口

新增独立 System surface：

```http
GET /api/system/v1/authz/me/effective-permissions
```

仅要求登录，不新增 Permission code。响应 `data.permissions: string[]`，去重、字典序稳定，包含当前用户从 direct RoleBinding、正/副职 policy 和分管关系获得的所有**当前有效** permission code；SUPER_ADMIN 返回全部现有 permission code。

以下边界锁定：

- 既有 `GET /api/system/v1/rbac/me/permissions` 的 path、DTO、`permissions` 语义和 `RbacService` 读取来源零变化；
- 新出口由 Authz 模块独立 Controller / DTO 承接，禁止把 System endpoint 混入 Admin Controller；
- 不改变 `/api/app/v1/me/capabilities`，不向 App API 暴露 raw permission codes；
- 不返回 role/binding/scope 内部明细，不新增敏感信息面。

## 6. 架构抽离决议

本目标不新建 MembersQueryService / ParticipationQueryService。原因是跨模块复用的新语义是「授权 grant → 可见组织集合」，权威归属明确在 `AuthzService`；各模块只新增局部 Prisma where 交集和既有 point-resource 调用，尚未形成独立、重复的业务查询编排。若实现中出现第二套 scope 解析或大段重复查询编排，必须暂停重新评审，而不是继续堆入 service。

模块依赖只允许业务 Module 单向 import `AuthzModule`；禁止 PermissionsModule 反向 import AuthzModule，避免环依赖；禁止修改 `RbacService.can/judge` 的行为锁。

## 7. 串行 PR 与门禁

实施按下列顺序串行，前一 PR merge + clean 后才开启下一 PR：

1. **T0**：本文冻结稿（docs-only）。
2. **PR1 seed**：两个只读角色、动态投影、精确同步、六条正/副职 policy、protected role、seed runtime invariant 与 seed-rbac tests；对原 R5 冻结稿做最小 supersession 注记。
3. **PR2 authz**：visible organization scope、effective permissions System endpoint、authz equivalence/unit/e2e。
4. **PR3 member axis**：members list/options/detail/all writes + certificate/profile/contact/insurance point scope 与矩阵 e2e。
5. **PR4 participation**：五个入口及活动轴/成员轴 e2e。
6. **PR5 landing docs**：admin handoff、RBAC map、go-live checklist、CHANGELOG Unreleased 和记账更新。
7. **Release**：bump PR → handoff PR → handoff squash tag `v0.49.0` → GitHub Release → backfill PR → clean closeout。

每个代码 PR 至少跑目标 lint/typecheck/unit/e2e；首尾各跑一次 `pnpm agent:check:full`。最终必须额外证明：

- clean test DB seed 成功并在同库第二次 seed 幂等；migration count 仍为 50；
- dept-leader list/options 只见本部门+子树，跨部门 detail/update/certificate/profile 均 30100；
- 三个副职只读非空，全部写入口 30100；
- participation 五入口范围矩阵通过；
- derived-only 用户的新 effective permissions 出口非空，旧 me/permissions 语义零变化；
- `rbac.service.spec`、authz equivalence、seed-rbac、全量 e2e 全绿；
- recruitment/team-join seed 与业务授权代码 diff 为零；
- `docs/handoff/admin-web.md`、`docs/ai-harness/RBAC_MAP.md`、`docs/ops/scoped-authz-go-live-checklist.md`、`docs/current-state.md`、CHANGELOG 与 live 事实一致。

## 8. 停止规则、回滚与上线后动作

出现以下任一情况立即停止：需要 schema migration / migrate reset / migrate deploy；发现与已冻结 Permission family 边界冲突；出现无法解释为测试竞态的 auth matrix 回归；需要修改 App API 或招新/team-join 授权代码。

代码回滚按 PR 逆序 revert；seed 角色/permission/policy 仅为配置 upsert，可通过回滚代码并再次执行受审 seed 收敛，不删业务数据。上线后按 `docs/ops/scoped-authz-go-live-checklist.md`：先建立真实职务任职，验证 derived-only 权限与范围；再移除部门管理者的 `biz-admin` GLOBAL 绑定；明确保留招新/team-join 的显式授权，不由部门职务自动继承。

## 9. 本次未做

- 不改 App API / capabilities；
- 不改 Permission code、BizCode、AuditLogEvent 或 Prisma schema；
- 不改变 recruitment/team-join 权限 family 与业务判权；
- 不赋予副职任何写、审批、终审、敏感明文或跨组织能力；
- 不让 SECONDARY membership 扩大成员管理范围；
- 不引入 QueryService、缓存、Redis、queue 或新的授权数据模型；
- 不自动创建生产任职、不自动移除现网 `biz-admin` 绑定。
