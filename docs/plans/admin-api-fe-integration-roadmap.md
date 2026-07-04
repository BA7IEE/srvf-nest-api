# Admin API — 后台前端对接接口批次路线图(plan-only 冻结稿)

> **性质**:规划路线图 + 决策清单。**本文只做分析规划,不改任何 `src` / `prisma` / `seed` / 测试 / 端点**;实现另起 per-batch goal(process §7.1)。
> **状态**:🧊 **冻结待拍板**(A 档 docs-only)。维护者对 §3 决策清单 D1–D10 + §8 分批序列勾选拍板后,本文转为执行基线;全序列 ship 完成后按 scoped-authz 先例归档至 `docs/archive/reviews/`。
> **基线**:v0.35.0,HEAD `6c61e937`(#499 已合入);计数 权限码 **191** / ops-admin **91** / EXPECTED_ROUTES **292** / controller **63** / 模块 **34** / 角色 **7** / migration **39**;`## Unreleased` 已累积 #494/#495 两笔 additive。
> **盘点日期**:2026-07-04。**现状表每一格均已对 live 代码逐条亲核**(见 §2 file:line 锚点),纠正处以「⚠️ 纠错」标注。
> **权威源关系**:本文是 derived 规划稿,**非规则源**;与 [`AGENTS.md`](../../AGENTS.md) / [`docs/api-surface-policy.md`](../api-surface-policy.md) / [`docs/architecture-boundary.md`](../architecture-boundary.md) / [`prisma/seed.ts`](../../prisma/seed.ts) 冲突时一律让步。字段真相 = live `/api/docs-json`。

---

## 0. 摘要 + 决策速览(维护者最低阅读量)

**要解决的问题**:后台管理前端(姊妹仓 srvf-admin-web)对接需要一批**搜索 / 选择器 / 跨轴总表 / 批量授权诊断**类只读+少量写端点。现状后端沿「所有权轴嵌套查询」建面,缺横扫搜索、下拉选择器、批量 label 解析、批量判权。

**规划结论(全部可满足零破坏红线)**:

- ✅ **零 schema / 零 migration / 零新表 / 零新 enum**:15 组全部只读写既有表(members / users / organizations / positions / activities / activity_registrations / attendance_sheets / role_bindings / member_organization_memberships / organization_position_assignments / organization_supervision_assignments / organization_closure)。逐条确认见 §5。
- ✅ **零破坏**:所有「增强」= 给既有 list DTO **加可选 query 参数**(默认值保持旧行为)+ 所有「新增」= 新路由;**唯一破坏风险**(把既有 bare-array list 改成分页)已通过「新增 `/page` 兄弟路由、旧数组端点不动」规避(D9)。
- 📊 **预计计数 delta**(全 5 批累计,待实现期精算):权限码 **191 → ~197**(+3~6 新码)· EXPECTED_ROUTES **292 → ~318**(+~26 路由)· controller **63 → ~65**(+1~2,主要 meta / action-state)· 模块 **34 → ~35**(+1 meta)· migration **39 不变** · 角色 **7 不变**。

**D1–D10 推荐一览(勾选即拍板;详见 §3)**:

| # | 决策 | 推荐 |
|---|---|---|
| **D1** | 模糊搜索参数命名 | 统一 `q`(跨字段主搜)+ 保留精确 `memberNo`/`gradeCode`/`status`;需精确单字段子串时用 `xxxContains`;**弃 `xxxLike`** |
| **D2** | 选择器 options 的 RBAC | options 复用对应资源 `.read.record` 码(list 投影,**不新增码**);仅 `resolve-labels` / `action-state` / `explain-batch` 各自 +1 新码 |
| **D3** | options 独立路由 vs `?view=options` | **独立 `/options` 路由**,内部复用同一 QueryService/查询构造 |
| **D4** | `roles/options` surface 归属 | 落 **`system/v1/roles/options`**(roles 是 System/RBAC 资源,选择器随本体;不在 admin/v1 另开 roles 路径) |
| **D5** | resolve-labels 契约与防枚举 | `POST admin/v1/meta/resolve-labels` `{refs:[{type,id}]}`(type 白名单)→ 分组 map;找不到/无权 id **静默省略**;refs ≤ 200;**+1 新码** |
| **D6** | `expand` 统一语义 | 每资源固定**最小展开字段集**,`expand=a,b` 逗号分隔白名单;**必须批量 join 禁 N+1**;默认不展开(旧形状不变);首批落地于 F2 |
| **D7** | `includeDescendants` 边界 | 经 `organization_closure` 展开子树**仅作列表数据过滤,绝不进判权路径**(承接 scoped-authz);**新增统一只读 helper** `queryDescendantOrgIds()`;默认 false |
| **D8** | action-state / explain-batch 落位 | **出到可实现契约级**;`explain-batch` = explain 批量壳(同 reason 枚举)· `action-state/batch` = authz + 各资源状态机**只读**校验;均落 **authz 模块**;标为独立 phase **殿后**(F3 末);**无需二级 T0**(除非实现期暴露跨模块状态机耦合) |
| **D9** | role-bindings 分页 | 新增 **`/page`**(分页 + expand + `scopeOrgId`/`roleCode`/`principalQ`/`includeExpired`/`q`);旧数组端点 `GET /role-bindings` 逐字不动 |
| **D10** | 分批优先级 | **刚需先、批量授权殿后**:F1=A 搜索&选择器+resolve-labels → F2=B 增强+expand 约定 → F3=C role-bindings/page+detail+explain-batch+action-state → F4=D 组织轴+memberships 总表/transfer/conflicts+tree-with-summary → F5=E 任职/分管总表+preview |

拍板回执区见 §11。

---

## 1. 背景与范围

### 1.1 触发

后台前端(srvf-admin-web,Vue3 + pure-admin,独立姊妹仓)从「资源后台」重构为「任务驱动后台」。前端自查确诊:后端 URL 树本已按任务驱动 IA(沿轴下钻齐全,GAP-001/002 跨轴只读已于 2026-06-23 补齐),但仍缺三类**横切能力**:

1. **搜索**:各资源列表只有精确码过滤,无跨字段模糊主搜 `q`、无日期区间、无组织子树过滤。
2. **选择器**:表单里的「选队员 / 选组织 / 选活动 / 选角色 / 选职务」下拉全靠拉全量 list,无轻量 `options` 投影;跨资源 id→label 回显无批量 `resolve-labels`。
3. **批量授权诊断 + 总表**:scoped-authz 落地后,role-bindings / 任职 / 分管三张授权表只有轴视图或 bare-array,缺分页总表、detail、批量判权(`explain-batch` / `action-state`)。

### 1.2 范围(A–E 五组,15 子项)

| 组 | 主题 | 子项 |
|---|---|---|
| **A** | 搜索 & 选择器 & meta | A1 members · A2 users · A3 organizations · A4 roles · A5 positions · A6 activities · A7 meta/resolve-labels |
| **B** | 跨轴列表增强 | B1 registrations · B2 attendance-sheets |
| **C** | 授权诊断 & role-bindings | C1 role-bindings 分页/detail/preview/batch · C2 authz/explain-batch · C3 action-state |
| **D** | memberships 组织轴 & 总表 | D1 memberships 总表/detail/transfer/conflicts + 组织轴 + tree-with-summary |
| **E** | 任职 / 分管总表 | E1 position-assignments 总表/detail/preview · E2 supervision-assignments 分页/detail/coverage-preview |

### 1.3 不在本路线图范围

- ❌ 任何写侧新业务规则(除 memberships transfer 这一明确的组织变更写操作外,全为读端点)。
- ❌ App / open / system 面新增(除 D4 roles/options 落 system/v1 外);其余全 `admin/v1`(承接 api-surface-policy §0)。
- ❌ 前端仓(srvf-admin-web)代码——本仓只交付后端端点 + 同 PR 更新 `docs/handoff`。
- ❌ 拆 god-service 业务逻辑行为(仅在读路径新增 QueryService,见 §7)。

---

## 2. 现状盘点(15 组逐条亲核)

> 图例:**EXISTS** = 已实现且满足需求 · **PARTIAL** = 端点在但能力不足 · **MISSING** = 完全不存在。所有 file:line 均 2026-07-04 对 live 代码核验。

### A 组 — 搜索 & 选择器

| # | 资源 | 现状端点 / list DTO | 亲核结论 | file:line |
|---|---|---|---|---|
| **A1** | members | `admin/v1/members`(6 路由);`ListMembersQueryDto` = `memberNo`(精确,max32)/ `gradeCode`(max64)/ `status` + 分页 | **PARTIAL**:无 `q`/displayName 模糊、无 `organizationId`/`includeDescendants`、无 `/options` | ctrl [`members.controller.ts:31`](../../src/modules/members/members.controller.ts) · dto [`members.dto.ts:118`](../../src/modules/members/members.dto.ts) · svc `members.service.ts:123` |
| **A2** | users | `admin/v1/users`(10 路由);`ListUsersQueryDto` = **零业务过滤**,仅继承分页(DTO 注释明写「v1 不引入 q/role/status」) | **PARTIAL(最弱)**:无 `q`/username/nickname/email/phone/role/status/memberId、无 `/options`;service 内 `canViewUser` 仅角色可见性裁剪、非 query | ctrl [`users.controller.ts:48`](../../src/modules/users/users.controller.ts) · dto [`users.dto.ts:219`](../../src/modules/users/users.dto.ts) · svc `users.service.ts:326` |
| **A3** | organizations | `admin/v1/organizations`(8 路由,含 `GET /tree` @66 在 `:id` 前);`ListOrganizationsQueryDto` = `parentId`(max64,接受字面 `'null'` 查根)/ `nodeTypeCode` / `status`;`OrganizationTreeQueryDto` = `status` only | **PARTIAL**:无 `name`/`code`/`q`、无 `/options`、无 `/tree-options`、无 `/tree-with-summary`;`/tree` 已存在(O(N) 内存拼树,无 N+1) | ctrl [`organizations.controller.ts:50`](../../src/modules/organizations/organizations.controller.ts) · dto [`organizations.dto.ts:212`](../../src/modules/organizations/organizations.dto.ts) · svc `organizations.service.ts:184`/`:216` |
| **A4** | roles | RBAC roles 在 **`system/v1/roles`**(5 路由);`ListRbacRolesQueryDto` = `code`(contains 模糊,max33) | **MISSING(选择器)**:无 `admin/v1/roles` 任何变体、无 `roles/options`;⚠️ **纠错确认**:roles 属 **System surface 非 admin**——这是 D4 的核心事实 | ctrl [`rbac-roles.controller.ts:43`](../../src/modules/permissions/rbac-roles.controller.ts) · dto [`rbac-roles.dto.ts:103`](../../src/modules/permissions/rbac-roles.dto.ts) |
| **A5** | positions | `admin/v1/positions`(5 路由);`PositionQueryDto` = `categoryCode` / `status` + 分页 | **MISSING(选择器)**:list 已有基础过滤,无 `/options` | ctrl [`positions.controller.ts:39`](../../src/modules/positions/positions.controller.ts) · dto [`positions.dto.ts:199`](../../src/modules/positions/positions.dto.ts) |
| **A6** | activities | `admin/v1/activities`(7 路由);`ListActivitiesQueryDto` = `statusCode` / `activityTypeCode` / `organizationId` / `isPublicRegistration` + 分页 | **PARTIAL**:4 个种子字段全部证实存在;无 `q`/`dateFrom`/`dateTo`/`includeDescendants`/`includeStats`/`/options` | ctrl [`activities.controller.ts:41`](../../src/modules/activities/activities.controller.ts) · dto [`activities.dto.ts:524`](../../src/modules/activities/activities.dto.ts) · svc `activities.service.ts:298` |
| **A7** | meta/resolve-labels | — | **MISSING(net-new)**:批量 id→label 全缺,无 `meta` 模块 | 无 |

### B 组 — 跨轴列表增强

| # | 资源 | 现状端点 / list DTO | 亲核结论 | file:line |
|---|---|---|---|---|
| **B1** | registrations | `admin/v1/registrations`(`AdminRegistrationsController`,`GET` @39,2026-06-23 跨轴补全建);`ListRegistrationsQueryDto` = `statusCode` only;响应 `AdminRegistrationListItemDto` **已含** activityTitle/memberNo/memberDisplayName | **PARTIAL**:无 `q`/`memberQ`/`activityQ`/`memberId`/`activityId`/`organizationId`/`includeDescendants`/`dateFrom`/`dateTo`/`expand` | ctrl [`admin-registrations.controller.ts`](../../src/modules/activity-registrations/controllers/admin-registrations.controller.ts) · dto [`activity-registrations.dto.ts:224`](../../src/modules/activity-registrations/activity-registrations.dto.ts) · svc `listAllForAdmin()` |
| **B2** | attendance-sheets | `admin/v1/attendance-sheets`(`AttendanceSheetsResourceController`,`GET` @136);`ListAttendanceSheetsQueryDto` = `statusCode` only;响应 `AdminAttendanceSheetListItemDto` 已含 activityTitle;**读路径已用 `AttendancePresenter`** | **PARTIAL**:无 `q`/`activityQ`/`organizationId`/`includeDescendants`/`dateFrom`/`dateTo`/`expand` | ctrl [`attendances.controller.ts:129`](../../src/modules/attendances/attendances.controller.ts) · dto [`attendances.dto.ts:229`](../../src/modules/attendances/attendances.dto.ts) · presenter [`attendance-presenter.ts:100`](../../src/modules/attendances/attendance-presenter.ts) |

> ⚠️ **纠错/补充**:全仓 grep 证实 **`expand` query 参数当前在任何端点都不存在**(D6 是净新约定)。supervision-assignments DTO 里的 `expandedOrganizationIds` 是**输出**字段(closure 展开结果),非 query。

### C 组 — 授权诊断 & role-bindings

| # | 资源 | 现状端点 | 亲核结论 | file:line |
|---|---|---|---|---|
| **C1** | role-bindings | `admin/v1/role-bindings`(4 路由:`GET` list @41 / `POST` @55 / `PATCH :id` @85 / `DELETE :id` @107);过滤 `principalType`/`principalId`/`roleId`/`scopeType`/`status`(5) | **PARTIAL**:⚠️ **list 返回 bare 数组不分页**(`@ApiWrappedArrayResponse`,svc 返 `RoleBindingResponseDto[]`);**无 `GET /:id` detail**(只有 PATCH/DELETE :id);无 `/page`/`/preview`/`/batch`;无 `scopeOrgId`/`q`/`includeExpired`/`expand` | ctrl [`role-bindings.controller.ts:37`](../../src/modules/role-bindings/role-bindings.controller.ts) · dto [`role-bindings.dto.ts:90`](../../src/modules/role-bindings/role-bindings.dto.ts) |
| **C2** | authz/explain | `admin/v1/authz`(1 路由:`POST /explain` @25,deny=200 数据);`AuthzReason` = **11 值**(2 allow:`super_admin_pass`/`matched`;9 deny:`no_permission`/`out_of_scope`/`out_of_supervised_scope`/`expired_grant`/`inactive_org`/`self_approval_forbidden`/`same_reviewer_forbidden`/`sensitive_denied`/`resource_not_found`) | **MISSING(batch)**:无 `explain-batch` | ctrl [`authz.controller.ts:21`](../../src/modules/authz/authz.controller.ts) · types [`authz.types.ts:43`](../../src/modules/authz/authz.types.ts) · 枚举 `authz.dto.ts:45` |
| **C3** | action-state | — | **MISSING(net-new)**:业务态批量闸全缺 | 无 |

### D 组 — memberships

| # | 资源 | 现状端点 | 亲核结论 | file:line |
|---|---|---|---|---|
| **D1** | memberships | 仅**队员轴** `admin/v1/members/:memberId/memberships`(`MembershipsController`,4 路由:`GET` list @38 / `POST` @56 / `PATCH :id` @80 / `DELETE :id` end @101);`MembershipResponseDto`(12 字段) | **MISSING(多项)**:无顶层 `admin/v1/memberships` 总表、无 `GET /:id` detail、无 `transfer`、无 `conflicts`、无组织轴 `organizations/:orgId/memberships`、无 `:orgId/members/options`、无 `tree-with-summary`;表 `member_organization_memberships` + `organization_closure` 均**已存在** | ctrl [`memberships.controller.ts:34`](../../src/modules/member-departments/memberships.controller.ts) · dto [`memberships.dto.ts:14`](../../src/modules/member-departments/memberships.dto.ts) · svc `memberships.service.ts:103` |

### E 组 — 任职 / 分管

| # | 资源 | 现状端点 | 亲核结论 | file:line |
|---|---|---|---|---|
| **E1** | position-assignments | 仅**双轴**:`GET`/`POST` org 轴 `organizations/:orgId/position-assignments`(@42/@60)· `GET` member 轴 `members/:memberId/position-assignments`(@91)· `POST :id/revoke`(@111)· `GET :id/history`(@132) | **MISSING**:⚠️ **无全局 flat list**、**无 detail `GET /:id`**(只有 `:id/history`、`:id/revoke`)、无 `preview`;list 返 bare 数组 | ctrl [`position-assignments.controller.ts`](../../src/modules/position-assignments/position-assignments.controller.ts) · dto [`position-assignments.dto.ts:11`](../../src/modules/position-assignments/position-assignments.dto.ts) |
| **E2** | supervision-assignments | 全局 list `GET admin/v1/supervision-assignments`(@45)⚠️ **返 bare 数组不分页** + `POST`(@55) + member 轴 `members/:memberId/supervision-scope`(@82) + org 轴 `organizations/:orgId/supervisors`(@103,DIRECT/INHERITED) + `PATCH :id`(@124) + `POST :id/revoke`(@145) | **PARTIAL/MISSING**:全局 list 无分页/过滤/expand;无 detail `GET /:id`;无 `coverage-preview`;closure 已用于 supervision-scope/supervisors 的**展示读**(注释明写「绝非判权」) | ctrl [`supervision-assignments.controller.ts`](../../src/modules/supervision-assignments/supervision-assignments.controller.ts) · dto [`supervision-assignments.dto.ts:14`](../../src/modules/supervision-assignments/supervision-assignments.dto.ts) |

### 2.1 现状架构横断结论(影响 §7)

- **QueryService 全仓 0 个**(architecture-boundary §5 标 deferred);**Presenter 仅 1 个**(`attendance-presenter.ts`)。members/users/organizations/positions/activities/registrations/role-bindings/memberships/position-assignments/supervision-assignments 的 list 全部**内联在主 service**。
- **closure 读只有写侧 util**:[`organization-closure.util.ts`](../../src/modules/organizations/organization-closure.util.ts) 只有 `buildCreateClosureEdges`/`buildReparentEdgesToInsert`/`isReparentCycle`(建树/迁树写边);**读侧「给 orgId 求后代 id 集」helper 不存在**,supervision/position 各自 ad-hoc 查 `organization_closure`。→ D7 需新增统一只读 helper。
- **分页出参**已有铁律基建:`PaginationQueryDto`(page/pageSize,默认 1/20,上限 100)+ `PageResultDto<T>`(items/total/page/pageSize)+ `@ApiWrappedPageResponse` 装饰器([`pagination.dto.ts`](../../src/common/dto/pagination.dto.ts) / [`api-response.decorator.ts:107`](../../src/common/decorators/api-response.decorator.ts))。**新分页端点直接复用,零基建**。

---

## 3. 横切决策清单 D1–D10(每题:盘点 → 推荐)

### D1 — 模糊搜索参数命名

- **盘点**:现有模糊过滤仅 2 处且命名不一——roles 用裸 `code`(contains,`rbac-roles.service.ts:111`)、content 用 `keyword`(contains+insensitive,`content.service.ts:185`)。members/activities 等全是精确码。无 `xxxLike`/`xxxContains` 存量。
- **推荐**:
  - **跨字段主搜统一叫 `q`**(单参数模糊命中该资源的若干可读字段,如 members 的 `q` 命中 displayName + memberNo;users 的 `q` 命中 username + nickname + email + phone)。每资源在契约里固定 `q` 覆盖字段集(见 §4)。
  - **保留既有精确过滤**:`memberNo`/`gradeCode`/`status`/`statusCode`/`activityTypeCode`/`nodeTypeCode`/`categoryCode` 语义不变。
  - **需要精确到单字段的子串**时用 `<field>Contains`(如 `nameContains`);**统一弃用 `xxxLike` 命名**。
  - 全部 `q`/`*Contains` 用 Prisma `contains` + `mode:'insensitive'`(对齐 content 先例)。
- **拍板**:☐ 按推荐 ☐ 其他 ______

### D2 — 选择器 options 的 RBAC

- **盘点**:options = list 的轻量投影(只回 `{id,label,...极少字段}`),读的是同一批数据。权限码命名铁律 `{module}.{action}.{resourceType}`,读多为 `{resource}.read.record`([`seed.ts`](../../prisma/seed.ts) 已有 `member.read.record`/`activity-registration.read.record`/... )。
- **推荐**:
  - **options 复用对应资源的 `.read.record` 码,不新增权限码**(它就是 list 的投影,授权面一致)。members/options→`member.read.record`;organizations/options→`organization.read.record`;activities/options→`activity.read.record`;positions/options→`position.read.record`;roles/options→`role.read.record`(现有 roles 读码,D4 决定 surface)。
  - **仅 3 个 net-new 诊断/聚合端点各自 +1 新码**:`resolve-labels`(D5)、`action-state`(D8)、`explain-batch`(D8)。
- **拍板**:☐ 按推荐 ☐ 其他 ______

### D3 — options 独立路由 vs `?view=options`

- **盘点**:两选项——(a) 独立 `GET .../options`;(b) 在 list 上加 `?view=options` 改变响应形状。
- **推荐**:**(a) 独立 `/options` 路由**。理由:① `?view=options` 会让同一端点返回两种响应形状,破坏 contract snapshot 的单一 schema 契约(本仓 contract 断言按端点锁 schema);② 独立路由的 OpenAPI 文档清晰、前端类型生成友好;③ 内部**复用同一 QueryService/查询构造**(options 只是 select 更窄 + 强制轻量分页/上限),不重复逻辑。**结论:独立路由 + 共享查询实现**。
- **拍板**:☐ 按推荐 ☐ 其他 ______

### D4 — `roles/options` 的 surface 归属

- **盘点**:roles CRUD 唯一实现在 **`system/v1/roles`**(`rbac-roles.controller.ts:43`),api-surface-policy §0 把 RBAC 系归 **System surface**(`/api/system/v1/*`);后台前端已在消费 system 面(`system/v1/rbac/me/permissions`,§9.4)。goal 禁区写「全部 admin/v1」——roles 是这条的**唯一例外候选**。
- **推荐**:**落 `system/v1/roles/options`**(留在 roles 本体所在的 System surface)。**api-surface 登记理由**:roles 是 System/RBAC 基础设施资源而非 admin 业务资源;options 是同一资源的读投影,**资源不应跨 surface 分裂**(把选择器放 admin/v1 会让「roles」这一资源同时出现在 system + admin 两面,违反 surface 单一归属原则)。前端已直连 system 面,取角色下拉多调一个 system 端点无额外成本。
  - ⚠️ **与 goal「全部 admin/v1」的张力**:这是 D1–D10 里唯一跨 surface 的决策,**显式请维护者拍**;若维护者更看重前端选择器路径一致性,备选 = `admin/v1/roles/options` 单读端点(需在 api-surface-policy 登记「roles 选择器 admin 面例外」)。
- **拍板**:☐ 按推荐(system/v1)☐ 备选(admin/v1)☐ 其他 ______

### D5 — resolve-labels 契约与防枚举

- **盘点**:前端跨资源回显(如 audit / role-bindings 里的 `principalId`、各种 `xxxId`)需要批量 id→人类可读 label,当前只能逐资源单查。承接 R13 + 防枚举铁律(authz/explain 的 `resource_not_found` 亦是 200 数据、不泄存在性)。
- **推荐**:
  - `POST admin/v1/meta/resolve-labels`,入 `{ refs: [{ type, id }] }`,`type` ∈ 白名单枚举(`member`/`user`/`organization`/`position`/`role`/`activity`);出 `{ [type]: { [id]: { label, ...极少非敏感字段 } } }` 分组 map。
  - **防枚举 + 防越权**:调用者对某 type **无 `.read.record` 权**、或 id 不存在/软删 → **静默省略该 id**(不报错、不占位、不泄存在性)。
  - **refs 条数上限 200**(超限 400);单请求可混合多 type。
  - **+1 新码** `meta.resolve.label`(绑 ops-admin,诊断/通用读)。
- **拍板**:☐ 按推荐 ☐ 其他 ______

### D6 — `expand=true` 统一语义

- **盘点**:`expand` 当前全仓不存在。B 组跨轴列表(registrations/attendance-sheets)需要按需附带关联实体(member 摘要 / activity 摘要 / organization 摘要),但默认列表要轻。
- **推荐**:
  - 语法 `expand=a,b`(逗号分隔白名单枚举),**默认空 = 旧响应形状逐字不变**(保 additive)。
  - 每资源**固定最小展开字段集**(如 registrations 的 `expand=member` 附 `{memberNo,displayName,gradeCode}`、`expand=activity` 附 `{title,startAt,organizationId}`)。
  - **必须批量 join / `in` 一次查完,禁 N+1**(承接 organizations `/tree` 的 O(N) 先例):service 先收集页内所有关联 id → 单次 `findMany({where:{id:{in:[...]}}})` → 内存拼装。
  - **定义为仓库级约定**(写进 architecture-boundary 或 handoff 约定段),**首批落地于 F2**(B 组),后续资源沿用。
- **拍板**:☐ 按推荐 ☐ 其他 ______

### D7 — `includeDescendants` 边界

- **盘点**:members/activities/registrations/attendance-sheets/memberships 的「按组织过滤」需要「本组织 + 全部后代组织」。`organization_closure` 表存在,但**读侧后代展开 helper 不存在**(§2.1)。scoped-authz 铁律:**closure 绝不进判权路径**。
- **推荐**:
  - `includeDescendants=true`(默认 false)配合 `organizationId=X` 使用:展开 `X` 及其全部后代 org id,作为**列表数据 where 过滤**(`organizationId in [...]`)。
  - **新增统一只读 helper** `queryDescendantOrgIds(orgId): Promise<string[]>`(读 `organization_closure WHERE ancestorId = orgId`),放 organizations 模块导出,各消费方注入复用。**这是纯读查询,零 schema**。
  - **红线复述**:此 helper **只用于列表数据过滤,绝不用于 RbacService/AuthzService 判权**(判权仍走 authz 三源推导,PR8 语义不变)。helper 注释 + PR body 显式声明。
- **拍板**:☐ 按推荐 ☐ 其他 ______

### D8 — action-state/batch 与 authz/explain-batch(本批最重)

- **盘点**:
  - `explain-batch` = 现有单条 `authz/explain` 的批量壳:入 `[{userId,action,resourceRef?}]` → 出 `[{...,decision}]`,**同一套 `AuthzReason` 11 值枚举**,逻辑 = 循环调 `AuthzService.explain`(内部可批量预取判权源)。
  - `action-state/batch` = 前端「一组按钮该不该亮」的组合闸:入 `[{action,resourceType,resourceId}]` → 出 `[{action,resourceId,allowed,reason}]`;`allowed` = **authz 判权 ∧ 资源状态机只读校验**(如「考勤已终审 → 不可再终审」「活动已取消 → 不可报名」「同人自审」);状态机部分**只读**调各模块已有 StateMachine 的纯判定,不写、不跃迁。
- **推荐**:
  - **出到可实现契约级**(见 §4 C2/C3),不停在概念。
  - **落位 authz 模块**:`explain-batch` 扩 `AuthzController`;`action-state/batch` 新增 `ActionStateController`(authz 模块内),编排 `AuthzService` + 注入各模块 StateMachine 的只读判定方法。
  - 各 +1 新码:`authz.explain-batch.decision`、`authz.action-state.decision`(均绑 ops-admin,镜像 `authz.explain.decision`)。
  - **标为独立 phase 殿后**(F3 末尾子项);**无需二级 T0**——`explain-batch` 纯壳,`action-state` 是「authz + 只读状态机」组合,不引入新判权语义。**唯一升级触发**:若实现期发现需要在 authz 模块反向依赖多个业务模块的 StateMachine 造成模块环、或状态机判定需要新的跨聚合读 → 届时人话简报升 mini-T0,不擅自扩。
- **拍板**:☐ 按推荐(出契约级 + 殿后 + 无需二级 T0)☐ 要求先出二级 T0 ☐ 其他 ______

### D9 — role-bindings 分页

- **盘点**:`GET admin/v1/role-bindings` 现返 **bare 数组**(`@ApiWrappedArrayResponse`)。就地改分页 = **breaking**(响应形状变)。
- **推荐**:**新增 `GET admin/v1/role-bindings/page`**(分页 + `expand` + `scopeOrgId`/`roleCode`/`principalQ`/`includeExpired`/`q`);**旧 `GET /role-bindings` 数组端点逐字不动**。detail `GET /role-bindings/:id` 同批补(现无)。两读端点复用现有 `role-binding.read.record` 码(D2)。
- **拍板**:☐ 按推荐 ☐ 其他 ______

### D10 — 分批优先级

- **盘点**:维护者定调「刚需先 / 批量授权·批量任命·批量分管殿后」。
- **推荐 F 序列**(详见 §8):
  - **F1 = A**(搜索 & 选择器 + resolve-labels)——前端每个列表/表单都要,刚需最高;首批确立 D1(`q`)/D2(options RBAC)/D3(独立路由)/D7(includeDescendants helper)约定。
  - **F2 = B**(registrations/attendance-sheets 增强 + expand)——审批工作台刚需;确立 D6(expand)约定。
  - **F3 = C**(role-bindings/page + detail + explain-batch + action-state)——授权诊断,批量判权殿后子项。
  - **F4 = D**(组织轴 memberships + 总表 + transfer + conflicts + tree-with-summary)——批量任命/组织管理。
  - **F5 = E**(任职/分管总表 + detail + preview)——批量任命/分管收尾。
- **拍板**:☐ 按推荐 ☐ 调整顺序 ______

---

## 4. 逐端点契约草案(A–E)

> 约定:所有路径省略 `/api` 前缀;`[rbac: x]` = 走 R 模式 `rbac.can(x)`(本仓无 `@RequirePermissions`);分页端点复用 `PageResultDto` + `@ApiWrappedPageResponse`;所有新增 query 参数均 `@IsOptional`。**新增/增强** + **additive/breaking** 见每条尾标。

### F1 / A 组

**A1 members**
- **增强** `GET admin/v1/members`:`ListMembersQueryDto` **+可选** `q`(命中 displayName+memberNo)、`organizationId`、`includeDescendants`(默认 false,配合 organizationId)。旧字段/响应不变。`[rbac: member.read.record]` — **additive**。
- **新增** `GET admin/v1/members/options`:query `q?`/`organizationId?`/`includeDescendants?`/`limit?`(≤100);响应 `{items:[{id,label,memberNo,gradeCode}]}`(label=displayName)。`[rbac: member.read.record]` — **additive**。

**A2 users**
- **增强** `GET admin/v1/users`:`ListUsersQueryDto` **+可选** `q`(命中 username+nickname+email+phone)、`role`、`status`、`memberId`。service `canViewUser` 可见性裁剪保留。`[rbac: user.read.record]`(核对现有 users list 码)— **additive**。
- **新增** `GET admin/v1/users/options`:query `q?`/`limit?`;响应 `{items:[{id,label,username}]}`(label=nickname||username)。**additive**。

**A3 organizations**
- **增强** `GET admin/v1/organizations`:**+可选** `q`(命中 name+code)、`nameContains?`/`codeContains?`(D1 精确子串备用)。**additive**。
- **新增** `GET admin/v1/organizations/options`:query `q?`/`nodeTypeCode?`/`status?`/`limit?`;响应 `{items:[{id,label,code,nodeTypeCode,parentId}]}`(label=name)。`[rbac: organization.read.record]` — **additive**。
- **新增** `GET admin/v1/organizations/tree-options`:整棵树的极简 `{id,label,code,children[]}` 投影(表单级联选择器用);复用 `getTree` 的 O(N) 拼装。**additive**。（`tree-with-summary` 归 F4/D,因需 membership 计数。）

**A4 roles**（surface 见 D4）
- **新增** `GET system/v1/roles/options`(**推荐**;备选 admin/v1):query `q?`(命中 code+displayName)/`limit?`;响应 `{items:[{id,label,code}]}`(label=displayName)。复用现有 roles 读码。**additive**。

**A5 positions**
- **新增** `GET admin/v1/positions/options`:query `categoryCode?`/`status?`/`q?`/`limit?`;响应 `{items:[{id,label,categoryCode}]}`。`[rbac: position.read.record]` — **additive**。

**A6 activities**
- **增强** `GET admin/v1/activities`:**+可选** `q`(命中 title)、`dateFrom`/`dateTo`(按 startAt 区间)、`includeDescendants`(配合既有 `organizationId`)、`includeStats`(默认 false;true 时每行附 `{registrationCount,attendanceSheetCount}`,批量聚合禁 N+1)。**additive**。
- **新增** `GET admin/v1/activities/options`:query `q?`/`statusCode?`/`organizationId?`/`limit?`;响应 `{items:[{id,label,startAt,statusCode}]}`(label=title)。`[rbac: activity.read.record]` — **additive**。

**A7 meta（net-new 模块）**
- **新增** `POST admin/v1/meta/resolve-labels`(D5):入 `{refs:[{type,id}]}`(type 白名单,refs≤200);出 `{[type]:{[id]:{label,...}}}`;无权/不存在静默省略。`[rbac: meta.resolve.label]`(**+1 新码**)。deny 语义 = 省略非报错。**additive(net-new)**。

### F2 / B 组

**B1 registrations** — **增强** `GET admin/v1/registrations`:`ListRegistrationsQueryDto` **+可选** `q`(命中 memberNo+memberDisplayName+activityTitle)、`memberQ`、`activityQ`、`memberId`、`activityId`、`organizationId`(经 activity→org)、`includeDescendants`、`dateFrom`/`dateTo`(registeredAt)、`expand=member,activity`(D6)。响应默认形状不变;expand 命中才附字段。`[rbac: activity-registration.read.record]` — **additive**。

**B2 attendance-sheets** — **增强** `GET admin/v1/attendance-sheets`:`ListAttendanceSheetsQueryDto` **+可选** `q`(命中 activityTitle+submitter)、`activityQ`、`organizationId`、`includeDescendants`、`dateFrom`/`dateTo`(submittedAt)、`expand=activity`。经既有 `AttendancePresenter` 扩展。`[rbac: attendance.read.sheet]` — **additive**。

### F3 / C 组

**C1 role-bindings**（D9）
- **新增** `GET admin/v1/role-bindings/page`:分页;query = 既有 5 过滤 + `scopeOrgId?`/`roleCode?`/`principalQ?`/`includeExpired?`(默认 false=仅 ACTIVE)/`q?`/`expand=role,principal`。响应 `PageResultDto<RoleBindingResponseDto(+expand)>`。`[rbac: role-binding.read.record]` — **additive**。
- **新增** `GET admin/v1/role-bindings/:id`:detail(现无)。同码。**additive**。
- **新增** `GET admin/v1/role-bindings/preview`(dry-run 校验一条待建绑定的合法性/冲突,不写):入与 create 同参;出 `{valid,conflicts[],resolvedScope}`。复用 read 码或 **+1** `role-binding.preview.record`(⚠️ 决策点,§6 标注)。**additive**。
- **新增** `POST admin/v1/role-bindings/batch`(批量建绑定;写):入 `[{...create}]`;出逐条 `{ok|blocked|already-exists}`。复用 `role-binding.create.record`(镜像 announcement-import 幂等)。**additive**。
- 旧 `GET /role-bindings`(数组)/ `POST` / `PATCH :id` / `DELETE :id` **逐字不动**。

**C2 authz/explain-batch**（D8)— **新增** `POST admin/v1/authz/explain-batch`:入 `{items:[{userId,action,resourceRef?}]}`(≤200);出 `{items:[{...输入, decision:{allow,reason,matchedGrant?}}]}`,**同 11 值 reason 枚举**;deny=200 数据。`[rbac: authz.explain-batch.decision]`(**+1 新码**)。**additive(net-new)**。

**C3 action-state/batch**（D8,殿后)— **新增** `POST admin/v1/authz/action-state/batch`:入 `{items:[{action,resourceType,resourceId}]}`(≤200);出 `{items:[{action,resourceId,allowed,reason}]}`;`allowed=authz ∧ 状态机只读校验`;reason ∈ authz 11 值 ∪ 状态机 `state_forbidden`(新增前端友好枚举)。`[rbac: authz.action-state.decision]`(**+1 新码**)。**additive(net-new)**。

### F4 / D 组 memberships

- **新增** `GET admin/v1/memberships`:分页总表;query `memberId?`/`organizationId?`/`includeDescendants?`/`membershipType?`/`status?`/`q?`/`expand=member,organization`。`PageResultDto<MembershipResponseDto(+expand)>`。`[rbac: membership.list.record]` — **additive**。
- **新增** `GET admin/v1/memberships/:id`:detail。`[rbac: membership.read.record]` — **additive**。
- **新增** `GET admin/v1/memberships/conflicts`:检测冲突(如多 PRIMARY / 悬空)只读诊断;query `organizationId?`/`includeDescendants?`。复用 `membership.list.record`。**additive**。
- **新增** `GET admin/v1/organizations/:orgId/memberships`:组织轴列表(分页);`includeDescendants?`。复用 `membership.list.record`。**additive**。
- **新增** `GET admin/v1/organizations/:orgId/members/options`:该组织(±后代)可选队员下拉;复用 `member.read.record`。**additive**。
- **新增** `GET admin/v1/organizations/tree-with-summary`:org 树 + 每节点 membership 计数(批量聚合禁 N+1);复用 `organization.read.record`。**additive**。
- **新增(写)** `POST admin/v1/memberships/transfer`:把某队员的 membership 从 orgA 迁到 orgB(单事务 end 旧 + create 新,受既有 partial unique 约束);入 `{memberId,fromOrganizationId,toOrganizationId,membershipType,reason?}`;出新 `MembershipResponseDto`。**+1 新码** `membership.transfer.record`(绑 biz-admin,组织变更业务写)+ **+1 audit event** `membership.transfer`(复用既有 memberships 审计路径,§ architecture 无 schema)。**additive(新写端点,零 schema)**。

### F5 / E 组

**E1 position-assignments**
- **新增** `GET admin/v1/position-assignments`:全局分页总表(现无);query `organizationId?`/`includeDescendants?`/`memberId?`/`positionId?`/`status?`/`q?`/`expand=member,position,organization`。`PageResultDto`。`[rbac: position-assignment.read.record]` — **additive**。
- **新增** `GET admin/v1/position-assignments/:id`:detail(现只有 `:id/history`、`:id/revoke`)。同码。**additive**。
- **新增** `POST admin/v1/position-assignments/preview`:dry-run 任命 5 校验(职务适配/独占/兼任/requireMembership/任期),不写;出 `{valid,violations[]}`。复用 read 码或 **+1** `position-assignment.preview.record`(⚠️ 决策点)。**additive**。

**E2 supervision-assignments**（D9 同型)
- **新增** `GET admin/v1/supervision-assignments/page`:分页总表(旧 `GET /supervision-assignments` 数组不动);query `supervisorMemberId?`/`organizationId?`/`includeDescendants?`/`scopeMode?`/`status?`/`q?`/`expand=supervisor,organization`。`[rbac: supervision-assignment.read.record]` — **additive**。
- **新增** `GET admin/v1/supervision-assignments/:id`:detail。同码。**additive**。
- **新增** `POST admin/v1/supervision-assignments/coverage-preview`:dry-run 展示某待建分管将覆盖哪些组织(closure 展开,展示读非判权);出 `{expandedOrganizationIds[]}`。复用 read 码。**additive**。

---

## 5. 分类与影响汇总(additive/breaking + 零 schema 断言)

### 5.1 additive vs breaking 逐条断言

| 变更类型 | 条目 | 判定 | 依据 |
|---|---|---|---|
| 既有 list DTO +可选 query 参数 | A1/A2/A3/A6 list、B1/B2 list | **additive** | 新增 `@IsOptional` 参数,缺省 = 旧行为;响应形状不变 |
| 全新 `/options`/`resolve-labels`/`tree-options` 路由 | A1/A2/A3/A5/A6/A4/A7 | **additive** | 新路由,不动旧端点 |
| `expand=` 按需附字段 | B1/B2、各分页总表 | **additive**(条件成立) | 默认 `expand` 空 → 响应逐字不变;**红线:expand 缺省必须保持旧形状** |
| 新分页 `/page` + 旧数组保留 | C1 role-bindings、E2 supervision | **additive** | D9:旧 bare-array 端点逐字不动,新增 `/page` |
| 全新总表/detail/preview | C1/C2/C3、D1、E1/E2 | **additive** | 全新路由 |
| memberships transfer(写) | D1 | **additive** | 新写端点 + 新码 + 新 audit event;**读写既有表,零 schema** |

**唯一 breaking 风险已规避**:把 role-bindings / supervision 既有 bare-array list 就地改分页 = breaking → 用「新 `/page` 兄弟路由」替代(D9)。**全路线图零 breaking**。

### 5.2 零 schema / 零 migration / 零新表 逐资源确认

| 资源 | 读写的既有表 | 新增字段? |
|---|---|---|
| members / users / organizations / positions / activities | 各自既有表 | 无 |
| registrations / attendance-sheets | `activity_registrations` / `attendance_sheets` + join `activities`(有 `organizationId`)/ `members` | 无 |
| role-bindings | `role_bindings` | 无 |
| authz explain-batch / action-state | 无自有表(判权源推导 + 各模块 StateMachine 只读) | 无 |
| memberships(含 transfer) | `member_organization_memberships` + `organization_closure` | 无(transfer = end+create 既有行,受既有 partial unique) |
| position/supervision assignments | `organization_position_assignments` / `organization_supervision_assignments` + `organization_closure` | 无 |
| resolve-labels | 上述各既有表只读 | 无 |
| includeDescendants helper | `organization_closure` 只读查询 | 无 |

✅ **断言:全 15 组零 `schema.prisma` 改动、零新 migration、零新表、零新 enum**。
⚠️ **偏离登记**:亲核未发现任何一项「其实需要新表/新 enum/schema」;若实现期某项被发现需要,按 process §4.1 人话简报升 D 档,不擅自扩(见 §10)。

---

## 6. 档位与权限码 delta

### 6.1 每批档位

| 批 | 组 | 档位 | 理由 |
|---|---|---|---|
| F1 | A | **B 档**(+1 新码 `meta.resolve.label` 使 A7 触及 seed → 该 PR 拆分:纯 query 增强/options 为 B 档;含新码的 meta 为 seed 变更走 **C 档**子 PR) | 多为 additive query/读端点;新码是 seed 写 |
| F2 | B | **B 档** | 纯 query 参数增强 + expand,零新码零 seed |
| F3 | C | **C 档** | +3 新码(explain-batch/action-state/可选 preview),seed 变更 |
| F4 | D | **C 档** | +1~2 新码(transfer + 可选)、+1 audit event union、写端点 |
| F5 | E | **B~C 档** | 读总表/detail 零新码(B);preview 若加新码则该子项 C 档 |

> 注:凡触及 `prisma/seed.ts` 权限码 / `AuditLogEvent` union 的子项按 process §4「D 档特征」——本仓惯例把「新增权限码 + seed 绑定」作为 **C 档**(评审稿预授权范围)处理,新增 `AuditLogEvent` union 项为 D 档特征需单列。transfer 的 audit event 需在实现 PR 显式登记。

### 6.2 权限码清单(拟新增)

| 新码 | 归属批 | 绑定角色 | 用途 |
|---|---|---|---|
| `meta.resolve.label` | F1 | ops-admin | 批量 id→label 诊断读 |
| `authz.explain-batch.decision` | F3 | ops-admin | 批量判权解释(镜像 `authz.explain.decision`) |
| `authz.action-state.decision` | F3 | ops-admin | 批量业务态闸 |
| `role-binding.preview.record` *(可选)* | F3 | ops-admin | ⚠️ 决策点:preview 复用 `read.record` 还是独立码 |
| `membership.transfer.record` | F4 | biz-admin | 组织变更写 |
| `position-assignment.preview.record` *(可选)* | F5 | ops-admin | ⚠️ 决策点:同上 |

**options 端点全部 0 新码**(复用 `.read.record`,D2)。

### 6.3 计数 delta(预计,待实现期精算)

| 计数 | 现 | 预计终值 | delta 说明 |
|---|---|---|---|
| 权限码 | 191 | **~194–197** | +3 必增(meta/explain-batch/action-state)+ 0–3 可选(2 preview + transfer;transfer 必增 → +4 保底) |
| ops-admin 绑定 | 91 | +3~5 | 上述除 transfer 外均绑 ops-admin |
| biz-admin 绑定 | 72 | +1 | membership.transfer |
| EXPECTED_ROUTES | 292 | **~318** | +~26 新路由(A:~8 · B:0 · C:~6 · D:~7 · E:~5;B 组纯 query 增强不加路由) |
| controller | 63 | **~65** | +1 meta,+0~1 action-state(其余扩既有 controller) |
| 模块 | 34 | **~35** | +1 meta;authz 扩既有 |
| migration | 39 | **39(不变)** | 零 schema |
| 角色 | 7 | **7(不变)** | 不新增角色 |

> 每子 PR 落地时须同步 `EXPECTED_ROUTES` / `docs:rbacmap:check`(191→新值)/ `docs:codemap:check`,并在 RBAC_MAP 追加戳。

---

## 7. 架构映射(QueryService / Presenter)

> 依据 [`architecture-boundary.md §3.2/§5/§6`](../architecture-boundary.md):QueryService 触发条件 = 「list 查询变大(多 filter 分支 / 动态 select)/ 多端点共享读模型 / admin·options 读形状分化」。本批**正是该触发的首次成立**(§5 标 QueryService "deferred — none required yet",触发出现即解锁)。

| 资源 | 读端点(list/options/page/detail/expand)增量 | 架构决策 |
|---|---|---|
| **members** | list 增强 + options + includeDescendants | **抽 `MembersQueryService`**:filter 分支从 3→6+、options 与 list 共享 select 策略、includeDescendants 动态 where → 命中 §3.2 三条触发 |
| **users** | list 从零过滤→多 filter + options | **抽 `UsersQueryService`**:当前零过滤,新增 `q`/role/status/memberId + canViewUser 可见性交织 → 触发成立 |
| **organizations** | list + options + tree-options | **抽 `OrganizationsQueryService`**:list/options/tree 三读形状分化 + closure-descendants → 触发成立;`queryDescendantOrgIds` helper 亦落此 |
| **activities** | list 增强 + options + includeStats | **抽 `ActivitiesQueryService`**:含批量 stats 聚合 → 触发成立 |
| **positions / roles** | 仅 +options | **暂不抽**:options 是窄投影,主 service list 已小;options 方法内联主 service 即可(§6 "logic < a few clear lines 不抽") |
| **registrations / attendance-sheets** | list 大幅增强 + expand | **抽 `*QueryService`**:多 filter + expand 批量 join → 触发成立;attendance 已有 Presenter,QueryService 与之并存(读构造 vs 出参塑形分离) |
| **role-bindings / memberships / position-assignments / supervision-assignments** | +page/detail/总表/expand | **抽各自 `*QueryService`**:总表 + expand + includeDescendants → 触发成立 |
| **authz explain-batch / action-state** | net-new 编排 | **不抽 QueryService**(非 list 读构造):`explain-batch` 扩 `AuthzExplainService`;`action-state` 新 `ActionStateService` 编排 AuthzService + StateMachine 只读判定 |
| **meta/resolve-labels** | net-new | 新 `MetaModule` + `MetaService`(跨资源批量读投影;白名单 type→各资源只读查询) |

**Presenter**:除 attendance 既有 `AttendancePresenter` 外,本批**不新增 Presenter**——options/label 出参形状简单,QueryService 内联塑形即可(避免 §6 "generic grab-bag" 与过度抽象)。expand 出参组装留在各 QueryService。

**统一约定沉淀**(写进 architecture-boundary 或 handoff 约定段,首批落地):① `q`/`*Contains` 命名(D1);② options 独立路由 + 共享 QueryService(D3);③ expand 白名单 + 批量 join 禁 N+1(D6);④ `queryDescendantOrgIds` 只读 helper + closure 非判权(D7)。

---

## 8. 分批 PR 序列(F1–F5)

> 每批 1 个逻辑批(可再拆子 PR);反映维护者定调「刚需先 / 批量授权·任命·分管殿后」。依赖 = 前置约定必须先落。

| 批 | 内容 | 档位 | 依赖 | 优先级 | 权限码/路由 delta |
|---|---|---|---|---|---|
| **F1** | **A 组**:members/users/organizations/activities list 增强 + 6 资源 options + meta/resolve-labels;确立 D1(`q`)/D2/D3/D7(closure 读 helper)约定 | B档(+C档 meta 子 PR) | 无 | 🔴 最高(每列表/表单刚需) | +1 码(meta)· +~8 路由 · +1 模块(meta) |
| **F2** | **B 组**:registrations/attendance-sheets list 增强 + **确立 D6 expand 约定** | B档 | F1(复用 includeDescendants helper) | 🔴 高(审批工作台刚需) | +0 码 · +0 路由(纯 query) |
| **F3** | **C 组**:role-bindings `/page`+detail+preview+batch(D9)+ authz `explain-batch` + **action-state 殿后子项**(D8) | C档 | 无(authz 已在) | 🟠 中(授权诊断) | +3~4 码 · +~6 路由 |
| **F4** | **D 组**:memberships 总表+detail+conflicts+**transfer(写)**+组织轴+`:orgId/members/options`+tree-with-summary | C档 | F1(options/helper 约定) | 🟠 中(批量任命/组织管理) | +1~2 码 · +~7 路由 · +1 audit event |
| **F5** | **E 组**:position-assignments 总表+detail+preview · supervision `/page`+detail+coverage-preview | B~C档 | F1(helper)、F4(组织轴范式) | 🟡 低(批量任命/分管收尾) | +0~2 码 · +~5 路由 |

**序列理由**:F1/F2 = 前端每天用的搜索/选择器/工作台,刚需;F3–F5 = scoped-authz 的批量运营面,重要但非日常高频,殿后。约定沉淀集中在 F1(命名/options/helper)+ F2(expand),后批复用不返工。

**每批收口铁律**(沿本仓惯例):同 PR 更新 `docs/handoff`(反漂,§9)+ `EXPECTED_ROUTES` + `docs:rbacmap:check`/`docs:codemap:check` + RBAC_MAP 戳 + contract snapshot(仅新增);e2e 覆盖新端点 + 既有断言零修改(additive 自证)。

---

## 9. handoff 更新计划(本 goal 不改 handoff 正文,仅登记计划)

`docs/handoff/`(canonical:能力图 + 踩坑 + 缺口台账;字段真相 = live `/api/docs-json`)后续每批实现 PR 需同步:

- **`docs/handoff/admin-web.md`**:
  - 新增「搜索 & 选择器能力图」段——每资源的 `q` 覆盖字段、options 端点、includeDescendants 用法(F1 落)。
  - 「审批工作台」段补 registrations/attendance-sheets 的 expand + 组织子树过滤(F2 落)。
  - 「授权诊断」段新增 explain-batch / action-state / role-bindings 分页(F3 落)。
  - 「组织 & 成员管理」段新增 memberships 组织轴 / transfer / tree-with-summary(F4 落);「任职分管」段补总表/preview(F5 落)。
  - GAP 台账:登记本路线图为 GAP-008(建议编号,承接 GAP-007 scoped-authz),分 F1–F5 逐批标「规划→已发」。
- **`docs/handoff/openapi.json`**:每批 PR 刷新(新端点 schema)。
- **反漂铁律**:凡改 RBAC/契约(F3/F4 新码、transfer)必须**同 PR** 更新 admin-web 能力图 + 前端对接指南(承接既有铁律)。

---

## 10. 禁区遵从与偏离登记

- ✅ **A 档 docs-only**:本 goal 仅产出本文 + NEXT_TASKS 指针;`git diff --name-only origin/main` 只含 docs 下 `.md`。
- ✅ **不替维护者终决**:D1–D10 只给推荐 + 拍板占位;§11 回执区待勾选。
- ✅ **铁律遵从**:API surface(全 admin/v1,唯一 D4 roles/options 显式请拍 system/v1)· 架构边界(QueryService 首次触发解锁,§7)· scoped-authz closure 非判权(D7)· R13(全文示例用合成占位,无真实 PII)。
- ⚠️ **偏离即停结论**:逐条亲核**未发现**任何清单项其实需要新表/新 enum/schema、或某「增强」其实 breaking、或与既有铁律冲突。**唯一需维护者拍的张力** = D4(roles/options 的 surface 归属,与 goal「全部 admin/v1」措辞的例外)。其余全部落在零破坏 additive 内。
- ⚠️ **实现期护栏**:若某批实现时发现(a)expand/includeStats 的聚合无法避免 N+1 而需反范式列、(b)action-state 需 authz 反依赖业务模块 StateMachine 造成模块环、(c)transfer 的组织变更需要新 audit 字段——均按 process §4.1 人话简报升档,**不擅自扩 schema / 不夹带**。

---

## 11. 决策拍板回执区(维护者勾选)

**横切决策**(✅ 已拍板 2026-07-04,维护者:全按推荐):

- D1 命名(`q`+`*Contains`,弃 Like):☑ 按推荐
- D2 options 复用 `.read.record`:☑ 按推荐
- D3 独立 `/options` 路由:☑ 按推荐
- D4 roles/options → **system/v1**:☑ 按推荐(system) ← 唯一 surface 决策,实拍确认落 `system/v1`
- D5 resolve-labels 契约 + 静默省略 + refs≤200:☑ 按推荐
- D6 expand 白名单 + 禁 N+1 + 默认关:☑ 按推荐
- D7 includeDescendants 只读 helper + closure 非判权:☑ 按推荐
- D8 explain-batch/action-state 出契约级 + authz 模块 + 殿后 + 无二级 T0:☑ 按推荐
- D9 role-bindings 新 `/page`、旧数组不动:☑ 按推荐
- D10 F 序列 A→B→C→D→E:☑ 按推荐

**遗留小决策**(推迟到对应实现批拍板,本轮不定):

- preview 端点(role-binding/position-assignment)复用 `read.record` 还是独立 `.preview.record` 码:☐ 复用 ☐ 独立码 —— 留 F3/F5 实现批
- action-state 的状态机 `state_forbidden` reason 是否并入 `AuthzReason` 枚举还是独立:☐ 并入 ☐ 独立 —— 留 F3 实现批

**分批启动授权**:☑ F1 可先起 per-batch goal(逐批;非全序列一次授权)

---

> **下一步**:✅ §11 已拍板(2026-07-04)→ F1 per-batch goal 已起草下发(A 组搜索&选择器 + resolve-labels)。F2–F5 逐批回头起。全序列 ship 后本文归档至 `docs/archive/reviews/`(沿 scoped-authz 先例)。
