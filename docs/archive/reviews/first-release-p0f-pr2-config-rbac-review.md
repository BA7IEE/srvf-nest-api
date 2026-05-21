# P0-F PR-2 配置类接口 RBAC 接入评审稿 v1(评审稿,非执行稿)

> **状态**:**v1 评审稿,D 档前置评审稿,非执行稿**。
> 本文档**不是**代码实现说明,**不是**铁律修订,**不是** seed/schema 变更。
> 本文档冻结 P0-F PR-2 配置类接口 RBAC 接入的设计决策,供 PR-2A(代码 PR)/ PR-2B(代码 PR)严格按本评审稿落地。
>
> **冲突优先级**(沿 [`process.md §6`](process.md)):`ARCHITECTURE.md` > `CLAUDE.md` / `AGENTS.md` > [`docs/srvf-foundation-baseline.md`](srvf-foundation-baseline.md) > [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) > **本评审稿** > handoff > [`current-state.md`](current-state.md) > [`process.md`](process.md)。冲突时本评审稿让步。
>
> **不在本文范围**:接口字段细节(回 [`v2-api-contract.md`](v2-api-contract.md));BizCode 全量翻译(回 [`first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md));非 6 模块的其它 12 个 v1 业务模块(归后续 P0-F PR-3+);Slow-3 部门部长 / 副部长细粒度权限(归 V2 Slow 通道);Slow-4 79 接口全量 RBAC(归 V2 Slow 通道);代码落地细节(归 PR-2A / PR-2B 实施稿);`CLAUDE.md` / `AGENTS.md` 铁律修订(若有,归独立 docs PR)。
>
> **本稿是评审稿,不代表已经允许直接写代码**。**禁止**在 D1-D4 拍板前启动 PR-2A / PR-2B;**禁止**在 PR-2A merged 前启动 PR-2B(沿 §11 拆分建议串行约束)。PR-2A / PR-2B 启动前**必须**重读本评审稿 §13 复核点。

---

## §0 用途与定位

### 0.1 解决什么问题

P0-F PR-1([PR #132](https://github.com/) commit `488b814`)已完成 5 个 RBAC 元接口的 RBAC 接入,把 `permissions` / `rbac-roles` / `role-permissions` / `user-roles` / `rbac` 五 controller 13 端点从 v1 三层 `@Roles(SUPER_ADMIN, ADMIN)` 切换到 service 层 `rbac.can()`(沿 attachments F3 / F5 v1.0 范本)。但**当前事实仍然是**:

- 仅 `attachments`(17 接口)+ `permissions` 模块(13 端点)共 30 端点已接入 `rbac.can()`
- 其余 18 个非 attachments 业务模块共 100+ 端点仍走 `@Roles(Role.SUPER_ADMIN, Role.ADMIN)`(沿 [`current-state.md §4`](current-state.md))
- **配置类接口尤为关键**:dictionaries / organizations / member-departments / contribution-rules / attachment-{type,mime,size-limit}-configs / storage-settings 这 6 模块 48 端点是"系统运维 + 业务底座配置",ADMIN 默认全权管理(包括凭证录入 / 字典软删 / 组织节点软删)带来三个风险:
  1. **`storage-settings.reset-credentials` 凭证录入对 ADMIN 开放**:沿 [`readiness-plan §3.1`](first-release-readiness-plan.md) 已经指出"凭证录入应该 SUPER_ADMIN-only,ADMIN 边界未定义"
  2. **dict-type / dict-item / organization `softDelete` 仅 SUPER_ADMIN**:v1 已用 `@Roles(SUPER_ADMIN)` 单角色限制,但与 ADMIN 其它管理动作语义不对称
  3. **运营场景的 ADMIN 与系统配置场景的 ADMIN 没有边界**:同一个 ADMIN 既能改 storage 凭证,也能改活动报名规则,误操作风险高

PR-2 的最小目标:让 6 模块 48 端点接入 `rbac.can()`,通过 `ops-admin` 角色(或决议派生角色)显式承载运营配置职责;凭证录入收紧至 SUPER_ADMIN-only;**且不破** PR-1 已建立的 RBAC 模型(JwtPayload 仍最小、JwtStrategy 每请求查库、单一 `RBAC_FORBIDDEN=30100`、不引入 Redis)。

### 0.2 本评审稿的边界

- 本评审稿**只**讨论 6 模块 48 端点(dict / org / member-dept / contrib-rule / attach-configs / storage-settings)的 RBAC 接入策略与 permission code 设计。
- 本评审稿**不**讨论:
  - users / auth / audit-logs 模块(沿 [`readiness-plan §3.1 P0-F`](first-release-readiness-plan.md);users 的 self/other 拆分留独立评审)
  - 业务记录类(activities / activity-registrations / attendances / members / member-profiles / emergency-contacts / certificates)的 self/other RBAC 接入(归 Slow-4)
  - 部门部长 / 副部长层级权限(归 Slow-3 业务方拍板)
  - RBAC schema 变更(`User.role` 删除、`Role` enum 变化、新增字段全部排除)
  - migration / seed 真实运营数据录入(seed 仅扩 permission + RolePermission 映射)
  - `tokenVersion` / access token blacklist(已在 P0-E 评审稿 D-4 锁死本期不做)
- 本评审稿**不**改任何运行时代码 / schema / migration / seed / 测试 / OpenAPI snapshot。
- 本评审稿**不**改 [`readiness-plan`](first-release-readiness-plan.md) / [`frontend-scope`](first-release-frontend-scope.md) / [`bizcode-mapping`](first-release-bizcode-mapping.md) / [`bootstrap-sop`](first-release-bootstrap-sop.md) / [`current-state.md`](current-state.md) / [`security.md`](security.md)(这些状态回填归 PR-2A / PR-2B 各自的 docs 收口 PR 或 v0.15.0 handoff)。
- 本评审稿**不**改 [`CLAUDE.md`](../CLAUDE.md) / [`AGENTS.md`](../AGENTS.md)(若 D1-D4 拍板后确需铁律修订,归独立 docs PR;沿 P0-D / P0-E 范式)。

### 0.3 谁要拍板

本评审稿 v1 提出 4 个决议项(D1-D4),全部由用户拍板:

- **D1**:ops-admin 是否绑定 PR-2A / PR-2B 配置类权限,以及边界
- **D2**:`storage-setting.reset.credentials` 是否仅 SUPER_ADMIN,不绑 ops-admin
- **D3**:dict-type / dict-item / organization `softDelete` 是否给 ops-admin
- **D4**:member-department 命名采用 `set/clear` 还是 `update/delete`

PR-2A 启动前必须 D1-D4 全部拍板;PR-2A merged → PR-2B 启动(沿 P0-D / P0-E 4-PR 串行范式精神)。

---

## §1 当前事实盘点

> 本节带文件 + 行号引用,凡判断必有证据;v1 / V1.1 / V2 / V2.x / PR-1 历史决策不重述。

### 1.1 PR-1 已建立的 RBAC 接入范式(代码层 + e2e 层)

| 层 | 范式 | 引用 |
|---|---|---|
| controller | 移除 `@Roles(...)` 装饰器;仅留 `JwtAuthGuard`;`@ApiBizErrorResponse(...)` 内 `FORBIDDEN` 替换为 `RBAC_FORBIDDEN` | [`permissions.controller.ts:28-31`](../src/modules/permissions/permissions.controller.ts:28) |
| service | constructor 注入 `RbacService`;加 helper `assertCanOrThrow(user, action)`;每端点首句调用 | [`permissions.service.ts:41-45`](../src/modules/permissions/permissions.service.ts:41) / [`permissions.service.ts:89`](../src/modules/permissions/permissions.service.ts:89) |
| 失败响应 | 统一 `BizException(BizCode.RBAC_FORBIDDEN)`(`30100`,HTTP 403);沿 [biz-code.constant.ts:763](../src/common/exceptions/biz-code.constant.ts:763) | PR-1 commit `488b814` |
| e2e fixture | `seedRbacPermissionsAndOpsAdmin` / `grantOpsAdminToUser` / `revokeOpsAdminFromUser` 三 helper;`beforeAll` seed 14 条 rbac.* + ops-admin | [`test/fixtures/rbac.fixture.ts`](../test/fixtures/rbac.fixture.ts) |
| e2e 矩阵 | 5 用例(USER → 30100 / ADMIN 默认 → 30100 / ADMIN+ops-admin → 通过 / SUPER_ADMIN 短路 / me/permissions 任意登录) | [`test/e2e/permissions.e2e-spec.ts:69-168`](../test/e2e/permissions.e2e-spec.ts:69) |

### 1.2 RbacService 判权能力(沿 D7 v1.1 §7.1)

| 步骤 | 行为 | 引用 |
|---|---|---|
| 1. SUPER_ADMIN 短路 | `user.role === SUPER_ADMIN` → `allowed: true, reason: 'super_admin_pass'` | [`rbac.service.ts:118-121`](../src/modules/permissions/rbac.service.ts:118) |
| 2. cache 查询 | `RbacCacheService.get(userId)` 命中直接返;miss 走 DB join → set cache | [`rbac.service.ts:73-104`](../src/modules/permissions/rbac.service.ts:73) |
| 3. action 精确匹配 | `permissions.has(action)` 否则 `no_permission` | [`rbac.service.ts:128-131`](../src/modules/permissions/rbac.service.ts:128) |
| 4. `.self` 后缀 ownership | `action.endsWith('.self')` 触发 `checkOwnership(user, resource)`;PR-2 本期**不使用** `.self` 后缀 | [`rbac.service.ts:135-143`](../src/modules/permissions/rbac.service.ts:135) |

### 1.3 seed 现状(沿 [prisma/seed.ts](../prisma/seed.ts))

| 实体 | 当前 seed 数量 | PR-2 后预期 |
|---|---|---|
| `RBAC_PERMISSION_SEED`(rbac.*) | 14 条 | 14 条(不动)|
| `ATTACHMENT_PERMISSION_SEED`(attachment.*) | 20 条(member 8 + cert 8 + activity 4)| 20 条(不动)|
| `MEMBER_ROLE_PERMISSION_CODES`(member 角色) | 9 条 | 9 条(不动)|
| **PR-2A 新增 permission**(dict / org / member-dept / contrib-rule)| 0 | **19 条** |
| **PR-2B 新增 permission**(attach-config / storage-setting)| 0 | **15 条** |
| `ops-admin` RolePermission 绑定 | 14 条 rbac.* | **沿 D1 拍板扩张** |

### 1.4 BizCode 段位现状(P0-F PR-2 涉及段)

| 段位 | 实数 | PR-2 后 |
|---|---|---|
| `30100 RBAC_FORBIDDEN` | 已实装([biz-code.constant.ts:763](../src/common/exceptions/biz-code.constant.ts:763)) | 复用,**不新增** |
| 4xxxx `FORBIDDEN`(40300) | 仍存在,沿 v1 通用 HTTP 级 | PR-2 把 6 模块 48 端点的 `@ApiBizErrorResponse(FORBIDDEN)` 替换为 `RBAC_FORBIDDEN`;通用 `FORBIDDEN` 段位保留,不删除 |
| 模块 30002 / 30003 / 30005 / 30006 / 30007 / 30008 / 30009 / 30011 / 30101 / 30102 | RBAC 业务码,已实装 | **不动** |

PR-2A / PR-2B **不新增任何 BizCode**(沿 PR-1 零新增范式)。

### 1.5 OpenAPI contract snapshot 约束

- 当前 [`test/e2e/__snapshots__/openapi.contract-spec.ts.snap`](../test/e2e/__snapshots__/openapi.contract-spec.ts.snap) 已锁定 v1 14 路由 + V2 79 路由的完整契约
- PR-1 已经把 5 个 RBAC 元 controller 13 端点的 `403` 段从 `40300/FORBIDDEN` 改为 `30100/RBAC_FORBIDDEN`(184 行 diff;沿 PR #132)
- PR-2A / PR-2B **预期 snapshot diff**:
  - 仅 48 端点的 `403` 段 enum 替换;**0 路径增删** / **0 schema 字段增删** / **0 tag 变化**
  - 量级:PR-2A ~360 行;PR-2B ~280 行;合计 ~640 行(沿 PR-1 184 行 / 13 端点 ≈ 14 行/端点 推算)

### 1.6 现有 e2e 测试覆盖边界(P0-F PR-2 涉及部分)

| spec 文件 | 用例数估算 | FORBIDDEN 断言数 | 备注 |
|---|---|---|---|
| [`dictionaries.e2e-spec.ts`](../test/e2e/dictionaries.e2e-spec.ts) | 较多 | 4 | PR-2A 扩 |
| [`organizations.e2e-spec.ts`](../test/e2e/organizations.e2e-spec.ts) | 较多 | 3 | PR-2A 扩 |
| [`member-departments.e2e-spec.ts`](../test/e2e/member-departments.e2e-spec.ts) | 中等 | 3 | PR-2A 扩 |
| [`contribution-rules.e2e-spec.ts`](../test/e2e/contribution-rules.e2e-spec.ts) | 较多 | 5 | PR-2A 扩 |
| [`attachment-type-configs.e2e-spec.ts`](../test/e2e/attachment-type-configs.e2e-spec.ts) | 中等 | 2 | PR-2B 扩 |
| [`attachment-mime-configs.e2e-spec.ts`](../test/e2e/attachment-mime-configs.e2e-spec.ts) | 中等 | 2 | PR-2B 扩 |
| [`attachment-size-limit-configs.e2e-spec.ts`](../test/e2e/attachment-size-limit-configs.e2e-spec.ts) | 中等 | 2 | PR-2B 扩 |
| [`storage-settings.e2e-spec.ts`](../test/e2e/storage-settings.e2e-spec.ts) | 中等 | (待 grep) | PR-2B 扩,含 reset-credentials 收紧验证 |
| **合计** | — | **21** | 全部需改 `RBAC_FORBIDDEN`;每文件加 ≥ 5 用例矩阵 |

---

## §2 PR-2 范围

### 2.1 在本范围(48 端点 / 8 controller / 6 模块)

**PR-2A 范围**(4 模块 / 28 端点):

| 模块 | controller | 端点数 | 资源语义 |
|---|---|---|---|
| `dictionaries` | [DictTypesController / DictItemsController](../src/modules/dictionaries/dictionaries.controller.ts)(单文件双 controller)| 6 + 7 = 13 | 字典类型 + 字典项(树形;运营底座)|
| `organizations` | [OrganizationsController](../src/modules/organizations/organizations.controller.ts) | 7 | 组织节点(救援队 + 部门;树形)|
| `member-departments` | [MemberDepartmentsController](../src/modules/member-departments/member-departments.controller.ts) | 3 | 队员当前部门归属(嵌套路径)|
| `contribution-rules` | [ContributionRulesController](../src/modules/contribution-rules/contribution-rules.controller.ts) | 5 | 贡献值规则(配置;不含流水)|

**PR-2B 范围**(4 controller / 20 端点):

| 模块 / controller | 端点数 | 资源语义 |
|---|---|---|
| `attachment-type-configs` | 6 | 附件类型配置(member/cert/activity 三类)|
| `attachment-mime-configs` | 6 | 附件 MIME 白名单 |
| `attachment-size-limit-configs` | 5 | 附件尺寸上限 |
| `storage-settings`([位于 src/common/storage/](../src/common/storage/storage-settings.controller.ts)) | 3 | COS / LOCAL 凭证 + Provider 路由(singleton)|

### 2.2 不在本范围(显式排除)

| 模块 | 排除原因 |
|---|---|
| `users` | self/other 拆分敏感;归独立 P0-F 后续 PR;sensitive field 读权限留 Slow-3 |
| `auth` | 全 `@Public()` + JWT;无 `@Roles` 装饰器需迁移 |
| `audit-logs` | 读权限策略需独立评审(谁能看谁的 audit);归独立 P0-F 后续 PR |
| `activities` / `activity-registrations` / `attendances` | 业务记录类;self/other 拆分敏感;归 Slow-4 |
| `members` / `member-profiles` / `emergency-contacts` / `certificates` | 涉敏数据 self/other 拆分;归 Slow-4 |
| `attachments`(主模块,非 attachment-configs)| 已接入 `rbac.can()`(PR-1 前 F3/F5 v1.0 已落地);**不动** |
| `permissions` / `rbac-roles` / `role-permissions` / `user-roles` / `rbac` | PR-1 #132 已接入;**不动** |
| `health` | 全 `@Public()`;无需 RBAC |
| `ai` | README 占位;无路由 |

**Slow-3 / Slow-4 启动诉求**:本评审稿**不**触发,沿 [`current-state.md §3`](current-state.md) Slow-3 待用户拍板。

---

## §3 当前 @Roles 使用点统计(48 处)

> 全部数据基于 main HEAD `488b814`(PR-1 落地后)+ grep 实测。

### 3.1 PR-2A 范围(28 处)

| controller | 端点 / HTTP / 角色锁 | 行号 |
|---|---|---|
| `DictTypesController` | `GET /v2/dict-types` SA+ADMIN | [42](../src/modules/dictionaries/dictionaries.controller.ts:42) |
| `DictTypesController` | `POST /v2/dict-types` SA+ADMIN | [51](../src/modules/dictionaries/dictionaries.controller.ts:51) |
| `DictTypesController` | `GET /v2/dict-types/:id` SA+ADMIN | [65](../src/modules/dictionaries/dictionaries.controller.ts:65) |
| `DictTypesController` | `PATCH /v2/dict-types/:id` SA+ADMIN | [79](../src/modules/dictionaries/dictionaries.controller.ts:79) |
| `DictTypesController` | `PATCH /v2/dict-types/:id/status` SA+ADMIN | [96](../src/modules/dictionaries/dictionaries.controller.ts:96) |
| `DictTypesController` | `DELETE /v2/dict-types/:id` **SA only** | [113](../src/modules/dictionaries/dictionaries.controller.ts:113) |
| `DictItemsController` | `GET /v2/dict-items` SA+ADMIN | [139](../src/modules/dictionaries/dictionaries.controller.ts:139) |
| `DictItemsController` | `POST /v2/dict-items` SA+ADMIN | [153](../src/modules/dictionaries/dictionaries.controller.ts:153) |
| `DictItemsController` | `GET /v2/dict-items/tree` SA+ADMIN | [173](../src/modules/dictionaries/dictionaries.controller.ts:173) |
| `DictItemsController` | `GET /v2/dict-items/:id` SA+ADMIN | [187](../src/modules/dictionaries/dictionaries.controller.ts:187) |
| `DictItemsController` | `PATCH /v2/dict-items/:id` SA+ADMIN | [201](../src/modules/dictionaries/dictionaries.controller.ts:201) |
| `DictItemsController` | `PATCH /v2/dict-items/:id/status` SA+ADMIN | [218](../src/modules/dictionaries/dictionaries.controller.ts:218) |
| `DictItemsController` | `DELETE /v2/dict-items/:id` **SA only** | [235](../src/modules/dictionaries/dictionaries.controller.ts:235) |
| `OrganizationsController` | `GET /v2/organizations` SA+ADMIN | [34](../src/modules/organizations/organizations.controller.ts:34) |
| `OrganizationsController` | `GET /v2/organizations/tree` SA+ADMIN | [44](../src/modules/organizations/organizations.controller.ts:44) |
| `OrganizationsController` | `POST /v2/organizations` SA+ADMIN | [53](../src/modules/organizations/organizations.controller.ts:53) |
| `OrganizationsController` | `GET /v2/organizations/:id` SA+ADMIN | [72](../src/modules/organizations/organizations.controller.ts:72) |
| `OrganizationsController` | `PATCH /v2/organizations/:id` SA+ADMIN | [86](../src/modules/organizations/organizations.controller.ts:86) |
| `OrganizationsController` | `PATCH /v2/organizations/:id/status` SA+ADMIN | [107](../src/modules/organizations/organizations.controller.ts:107) |
| `OrganizationsController` | `DELETE /v2/organizations/:id` **SA only** | [127](../src/modules/organizations/organizations.controller.ts:127) |
| `MemberDepartmentsController` | `GET /v2/members/:memberId/department` SA+ADMIN | [28](../src/modules/member-departments/member-departments.controller.ts:28) |
| `MemberDepartmentsController` | `PUT /v2/members/:memberId/department` SA+ADMIN | [43](../src/modules/member-departments/member-departments.controller.ts:43) |
| `MemberDepartmentsController` | `DELETE /v2/members/:memberId/department` SA+ADMIN | [66](../src/modules/member-departments/member-departments.controller.ts:66) |
| `ContributionRulesController` | `GET /v2/contribution-rules` SA+ADMIN | [63](../src/modules/contribution-rules/contribution-rules.controller.ts:63) |
| `ContributionRulesController` | `POST /v2/contribution-rules` SA+ADMIN | [77](../src/modules/contribution-rules/contribution-rules.controller.ts:77) |
| `ContributionRulesController` | `GET /v2/contribution-rules/:id` SA+ADMIN | [100](../src/modules/contribution-rules/contribution-rules.controller.ts:100) |
| `ContributionRulesController` | `PATCH /v2/contribution-rules/:id` SA+ADMIN | [114](../src/modules/contribution-rules/contribution-rules.controller.ts:114) |
| `ContributionRulesController` | `DELETE /v2/contribution-rules/:id` SA+ADMIN | [139](../src/modules/contribution-rules/contribution-rules.controller.ts:139) |

**PR-2A 小结**:28 端点;3 处 `DELETE` 仅 SA(命中 D3);其余 25 处 SA+ADMIN。

### 3.2 PR-2B 范围(20 处)

| controller | 端点 / HTTP / 角色锁 | 行号 |
|---|---|---|
| `AttachmentTypeConfigsController` | `GET /v2/attachment-type-configs` SA+ADMIN | [58](../src/modules/attachment-configs/attachment-type-configs.controller.ts:58) |
| `AttachmentTypeConfigsController` | `POST /v2/attachment-type-configs` SA+ADMIN | [71](../src/modules/attachment-configs/attachment-type-configs.controller.ts:71) |
| `AttachmentTypeConfigsController` | `GET /v2/attachment-type-configs/:id` SA+ADMIN | [93](../src/modules/attachment-configs/attachment-type-configs.controller.ts:93) |
| `AttachmentTypeConfigsController` | `PATCH /v2/attachment-type-configs/:id` SA+ADMIN | [107](../src/modules/attachment-configs/attachment-type-configs.controller.ts:107) |
| `AttachmentTypeConfigsController` | `PATCH /v2/attachment-type-configs/:id/status` SA+ADMIN | [129](../src/modules/attachment-configs/attachment-type-configs.controller.ts:129) |
| `AttachmentTypeConfigsController` | `DELETE /v2/attachment-type-configs/:id` SA+ADMIN | [152](../src/modules/attachment-configs/attachment-type-configs.controller.ts:152) |
| `AttachmentMimeConfigsController` | `GET /v2/attachment-mime-configs` SA+ADMIN | [58](../src/modules/attachment-configs/attachment-mime-configs.controller.ts:58) |
| `AttachmentMimeConfigsController` | `POST /v2/attachment-mime-configs` SA+ADMIN | [72](../src/modules/attachment-configs/attachment-mime-configs.controller.ts:72) |
| `AttachmentMimeConfigsController` | `GET /v2/attachment-mime-configs/:id` SA+ADMIN | [95](../src/modules/attachment-configs/attachment-mime-configs.controller.ts:95) |
| `AttachmentMimeConfigsController` | `PATCH /v2/attachment-mime-configs/:id` SA+ADMIN | [109](../src/modules/attachment-configs/attachment-mime-configs.controller.ts:109) |
| `AttachmentMimeConfigsController` | `PATCH /v2/attachment-mime-configs/:id/status` SA+ADMIN | [131](../src/modules/attachment-configs/attachment-mime-configs.controller.ts:131) |
| `AttachmentMimeConfigsController` | `DELETE /v2/attachment-mime-configs/:id` SA+ADMIN | [154](../src/modules/attachment-configs/attachment-mime-configs.controller.ts:154) |
| `AttachmentSizeLimitConfigsController` | `GET /v2/attachment-size-limit-configs` SA+ADMIN | [56](../src/modules/attachment-configs/attachment-size-limit-configs.controller.ts:56) |
| `AttachmentSizeLimitConfigsController` | `POST /v2/attachment-size-limit-configs` SA+ADMIN | [69](../src/modules/attachment-configs/attachment-size-limit-configs.controller.ts:69) |
| `AttachmentSizeLimitConfigsController` | `GET /v2/attachment-size-limit-configs/:id` SA+ADMIN | [91](../src/modules/attachment-configs/attachment-size-limit-configs.controller.ts:91) |
| `AttachmentSizeLimitConfigsController` | `PATCH /v2/attachment-size-limit-configs/:id` SA+ADMIN | [105](../src/modules/attachment-configs/attachment-size-limit-configs.controller.ts:105) |
| `AttachmentSizeLimitConfigsController` | `DELETE /v2/attachment-size-limit-configs/:id` SA+ADMIN | [127](../src/modules/attachment-configs/attachment-size-limit-configs.controller.ts:127) |
| `StorageSettingsController` | `GET /v2/storage-settings` SA+ADMIN | [40](../src/common/storage/storage-settings.controller.ts:40) |
| `StorageSettingsController` | `PATCH /v2/storage-settings` SA+ADMIN | [52](../src/common/storage/storage-settings.controller.ts:52) |
| `StorageSettingsController` | `POST /v2/storage-settings/reset-credentials` SA+ADMIN | [67](../src/common/storage/storage-settings.controller.ts:67) |

**PR-2B 小结**:20 端点;含 1 处凭证敏感(命中 D2);3 个 controller 文件头注释里"F4 v1.0 锁:不接 rbac.can()"需同步撤销(沿 [`attachment-mime-configs.controller.ts:38`](../src/modules/attachment-configs/attachment-mime-configs.controller.ts:38) / [`attachment-type-configs.controller.ts:37`](../src/modules/attachment-configs/attachment-type-configs.controller.ts:37) / [`attachment-size-limit-configs.controller.ts:36`](../src/modules/attachment-configs/attachment-size-limit-configs.controller.ts:36) / [`attachment-configs.module.ts:19-26`](../src/modules/attachment-configs/attachment-configs.module.ts:19))。

---

## §4 permission code 设计(34 条候选)

### 4.1 命名规则(沿 PR-1 + D2 v1.2 正则)

- 正则 `/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,3}$/` —— 3-4 段 kebab-case
- 语义 `<module>.<action>.<resource_type>[.<scope>]`
- 段间严格 `.` 分隔;段内仅 `[a-z0-9-]`;首字母小写
- PR-2 本期**不使用** `.self` 后缀(配置类对象无 owner 语义)
- 沿 PR-1 "dash + R/C/U/D 4 段拆分"(read/create/update/delete + 个别自定义动词)
- 复用 `RBAC_FORBIDDEN=30100`,**不开**新 BizCode

### 4.2 PR-2A 候选 19 条

| 模块 | code | 覆盖端点 | 段数 |
|---|---|---|---|
| dict | `dict.read.type` | `GET /v2/dict-types`(list)+ `GET /v2/dict-types/:id`(findOne) | 3 |
| dict | `dict.create.type` | `POST /v2/dict-types` | 3 |
| dict | `dict.update.type` | `PATCH /v2/dict-types/:id` + `PATCH /v2/dict-types/:id/status` | 3 |
| dict | `dict.delete.type` | `DELETE /v2/dict-types/:id`(命中 D3) | 3 |
| dict | `dict.read.item` | `GET /v2/dict-items` + `GET /v2/dict-items/tree` + `GET /v2/dict-items/:id` | 3 |
| dict | `dict.create.item` | `POST /v2/dict-items` | 3 |
| dict | `dict.update.item` | `PATCH /v2/dict-items/:id` + `PATCH /v2/dict-items/:id/status` | 3 |
| dict | `dict.delete.item` | `DELETE /v2/dict-items/:id`(命中 D3) | 3 |
| org | `org.read.node` | `GET /v2/organizations` + `GET /v2/organizations/tree` + `GET /v2/organizations/:id` | 3 |
| org | `org.create.node` | `POST /v2/organizations` | 3 |
| org | `org.update.node` | `PATCH /v2/organizations/:id` + `PATCH /v2/organizations/:id/status` | 3 |
| org | `org.delete.node` | `DELETE /v2/organizations/:id`(命中 D3) | 3 |
| member-dept | `member-department.read.current` 或 `member-department.read.assignment` | `GET /v2/members/:memberId/department`(命中 D4) | 3 |
| member-dept | `member-department.set.current` 或 `member-department.update.assignment` | `PUT /v2/members/:memberId/department`(命中 D4) | 3 |
| member-dept | `member-department.clear.current` 或 `member-department.delete.assignment` | `DELETE /v2/members/:memberId/department`(命中 D4) | 3 |
| contrib | `contribution.read.rule` | `GET /v2/contribution-rules` + `GET /v2/contribution-rules/:id` | 3 |
| contrib | `contribution.create.rule` | `POST /v2/contribution-rules` | 3 |
| contrib | `contribution.update.rule` | `PATCH /v2/contribution-rules/:id` | 3 |
| contrib | `contribution.delete.rule` | `DELETE /v2/contribution-rules/:id` | 3 |

**PR-2A 端点 → code 映射汇总**:28 端点 → 19 code(GET 多端点共享 `read`;`PATCH /:id` + `PATCH /:id/status` 共享 `update`)。

### 4.3 PR-2B 候选 15 条

| 模块 | code | 覆盖端点 | 段数 |
|---|---|---|---|
| attach-config | `attachment-config.read.type` | `GET /v2/attachment-type-configs` + `GET /v2/attachment-type-configs/:id` | 3 |
| attach-config | `attachment-config.create.type` | `POST /v2/attachment-type-configs` | 3 |
| attach-config | `attachment-config.update.type` | `PATCH /v2/attachment-type-configs/:id` + `PATCH /v2/attachment-type-configs/:id/status` | 3 |
| attach-config | `attachment-config.delete.type` | `DELETE /v2/attachment-type-configs/:id` | 3 |
| attach-config | `attachment-config.read.mime` | `GET /v2/attachment-mime-configs` + `GET /v2/attachment-mime-configs/:id` | 3 |
| attach-config | `attachment-config.create.mime` | `POST /v2/attachment-mime-configs` | 3 |
| attach-config | `attachment-config.update.mime` | `PATCH /v2/attachment-mime-configs/:id` + `PATCH /v2/attachment-mime-configs/:id/status` | 3 |
| attach-config | `attachment-config.delete.mime` | `DELETE /v2/attachment-mime-configs/:id` | 3 |
| attach-config | `attachment-config.read.size-limit` | `GET /v2/attachment-size-limit-configs` + `GET /v2/attachment-size-limit-configs/:id` | 3 |
| attach-config | `attachment-config.create.size-limit` | `POST /v2/attachment-size-limit-configs` | 3 |
| attach-config | `attachment-config.update.size-limit` | `PATCH /v2/attachment-size-limit-configs/:id` | 3 |
| attach-config | `attachment-config.delete.size-limit` | `DELETE /v2/attachment-size-limit-configs/:id` | 3 |
| storage | `storage-setting.read.singleton` | `GET /v2/storage-settings` | 3 |
| storage | `storage-setting.update.singleton` | `PATCH /v2/storage-settings` | 3 |
| storage | `storage-setting.reset.credentials` | `POST /v2/storage-settings/reset-credentials`(命中 D2) | 3 |

**PR-2B 端点 → code 映射汇总**:20 端点 → 15 code。

### 4.4 段位与已实装的物理隔离

| 已实装 module 段位 | 新增 module 段位 | 是否碰撞 |
|---|---|---|
| `rbac.*`(14 条;PR-1) | `dict.*` / `org.*` / `member-department.*` / `contribution.*` / `attachment-config.*` / `storage-setting.*` | ❌ |
| `attachment.*`(20 条;F3/F5 v1.0) | `attachment-config.*` | ❌(物理隔离,前者业务上传,后者系统配置) |

### 4.5 命名取舍说明

- `member-department.*`(单一 module 段)而非 `member.*.department`(避免与未来 `member.read.profile` / `member.update.profile` 冲突)
- `attachment-config.*` 而非 `attachment.config.*`(避免与 `attachment.upload.* / view.* / update.* / delete.*` 段混乱)
- `contribution.*.rule` 而非 `contribution-rule.*`(保留 `contribution.*` 段位给未来流水表,沿 [`readiness-plan §3.3`](first-release-readiness-plan.md) P2 暂不做 Contribution 流水表)
- `storage-setting.*`(单数)而非 `storage-settings.*`(沿 attachment 单数惯例 + 与表名复数 `storage_settings` 解耦)
- 资源词:`type` / `item` / `node` / `current` / `rule` / `mime` / `size-limit` / `singleton` / `credentials`

---

## §5 决议项 D1-D4

> 每个决议列 A / B / C 三选项 + 推荐项 + 理由 + 风险。**禁止预判用户拍板结果**;§6 推荐拍板作为默认,但**任一项**可被用户改动。

### 5.1 D1:ops-admin 是否绑定 PR-2A / PR-2B 配置类权限

**问题**:PR-1 创建的 `ops-admin` 角色当前仅持 14 条 `rbac.*` 权限(RBAC 自身配置)。PR-2A / PR-2B 新增 34 条配置类权限,是否一并绑给 `ops-admin`?

**选项**:

| 选项 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| **A**(推荐) | `ops-admin` 扩张绑 PR-2A 19 条 + PR-2B 14 条(除 `storage-setting.reset.credentials`);PR-2A / PR-2B 同节奏推进 | 心智模型简单(运营持单一 `ops-admin` 角色 = RBAC 元 + 配置全权);沿 PR-1 `ops-admin` 定位"运营管理员"自然扩展 | 角色范围一次性扩大 3.4× 倍(14 → 47);未来"运营 ≠ 配置管理员"诉求出现时不易回滚 |
| **B** | 拆三个独立角色:`ops-admin`(14 条 rbac.*)/ `config-admin`(PR-2A + PR-2B 33 条)/ `secret-admin`(凭证 1 条) | 职责分离最清晰;符合"最小权限"原则 | 运维负担显著增加(同一运营需 grant 三角色);PR-2A / PR-2B 不再"一个角色搞定" |
| **C** | `ops-admin` 仅扩 PR-2A(+19 条);PR-2B 留待 PR-2B 评审时单独决议(此时再决定扩 `ops-admin` 还是拆 `config-admin`) | 决议可分阶段;PR-2A 风险隔离 | 双轨期(PR-2A merged 后 PR-2B 仍 SA+ADMIN);运营在 PR-2B merge 前对 attachments-configs / storage-settings 行为不变 |

**推荐**:**A(沿 §6.1 默认推荐)**——一致性优先,运维心智一致。

**风险**:`ops-admin` 一旦覆盖 47 条权限,撤销某个具体权限需要走 `DELETE /v2/roles/:id/permissions/:permissionId`(沿 RBAC PR #4 已实装),操作可逆但回滚链路较长。

### 5.2 D2:`storage-setting.reset.credentials` 是否仅 SUPER_ADMIN

**问题**:COS SecretId / SecretKey 录入是凭证敏感操作(沿 [`readiness-plan §3.1`](first-release-readiness-plan.md) "凭证录入应该 SUPER_ADMIN-only,ADMIN 边界未定义")。是否把 `storage-setting.reset.credentials` 这条权限**不绑** `ops-admin`,只让 SUPER_ADMIN 短路通过?

**选项**:

| 选项 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| **A**(推荐) | seed 创建该 permission 但**不绑** `ops-admin`;SUPER_ADMIN 经短路通过;ADMIN+ops-admin → `30100` | 凭证最小权限;沿 readiness-plan 暗示 | ADMIN(包括 ops-admin)调 reset-credentials 时报 30100,与 v1 现状行为反转;运维需理解"只有 SUPER_ADMIN 能改凭证" |
| **B** | 绑给 `ops-admin`,与 `update.singleton` 同等 | 沿 v1 SA+ADMIN 现状;运维无感知变化 | 凭证录入对 ADMIN 开放,readiness-plan 已点出的安全风险未消除 |
| **C** | 新建独立 `secret-admin` 角色,grant 给指定 SUPER_ADMIN 或专门凭证管理员 | 职责分离最细 | 新增角色 + 运维额外 grant 步骤;PR-2B 复杂度上升 |

**推荐**:**A**——一刀切收紧;沿 readiness-plan 风险公示;反正 PR-2B 上线前 SUPER_ADMIN 必须存在(seed 已保证),无 grant 链路。

**风险**:
- 上线后若运维仅 ADMIN 身份(未配 SUPER_ADMIN),会发现 reset-credentials 无法调用;需 PR-2B 上线前确认 SUPER_ADMIN 在职 + 可用
- 紧急回滚路径:DB 直改 `RolePermission`(`INSERT INTO role_permissions ...` grant `storage-setting.reset.credentials` 给 `ops-admin`)+ 重启 / `POST /v2/rbac/reload` 失效缓存

### 5.3 D3:dict-type / dict-item / organization `softDelete` 是否给 ops-admin

**问题**:v1 这 3 个端点用 `@Roles(Role.SUPER_ADMIN)` 单角色限制(仅 SA);RBAC 模型下,持 `ops-admin` 的 ADMIN 是否能调?

**选项**:

| 选项 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| **A**(推荐) | `dict.delete.type` / `dict.delete.item` / `org.delete.node` 绑给 `ops-admin`(ADMIN+ops-admin 可删) | 业务上"运营软删字典项 / 组织节点"是合理日常诉求;sub-protection 已在 service 内(`DICT_TYPE_IN_USE` / `ORGANIZATION_HAS_CHILDREN` / `LAST_ROOT_ORGANIZATION_PROTECTED` 等)| 与 v1 `@Roles(SUPER_ADMIN)` 单角色限制行为反转;前端 UI 需重新考虑"删除按钮可见性" |
| **B** | sub-protection:不绑 `ops-admin`;ADMIN+ops-admin → `30100`;仅 SA 短路 | 沿 v1 语义;最强保守 | "运营软删字典"日常诉求被堵 |
| **C** | 拆 sub-permission `dict.delete.type.super-only` / `org.delete.node.super-only` 4 段(scope=super-only)不绑任何角色,SA 短路放行 | 命名显式;沿 4 段范式 | 段位浪费;`.super-only` 后缀语义在 RbacService 无原生支持(`.self` 已用于 ownership);仅起命名提示作用 |

**推荐**:**A**——业务合理性优先;sub-protection 已在 service 层(不会因放宽权限破坏不变式)。

**风险**:
- 前端"删除按钮"以前可能仅对 SUPER_ADMIN 显示,放宽后需同步刷新 UI 权限判断
- 若用户不接受,改 B 选项零额外成本(seed 不绑这 3 条给 `ops-admin` 即可)

### 5.4 D4:member-department 命名采用 `set/clear` 还是 `update/delete`

**问题**:`PUT /v2/members/:memberId/department`(幂等设置)与 `DELETE /v2/members/:memberId/department`(解除归属)的 permission code 动词怎么选?

**选项**:

| 选项 | code | 优点 | 缺点 |
|---|---|---|---|
| **A**(推荐) | `member-department.set.current` + `member-department.clear.current` + `member-department.read.current` | 动词与 HTTP 方法语义对齐(`PUT` = set / `DELETE` = clear);沿 PR-1 `rbac.config.reload` 自定义动词范式 | 自定义动词,统计 / 报表里需特殊处理 |
| **B** | `member-department.update.assignment` + `member-department.delete.assignment` + `member-department.read.assignment` | 沿 R/C/U/D 4 段标准;统计 / 报表友好 | `update`/`delete` 与"幂等设置"/"解除归属"业务语义不完全对齐 |
| **C** | 混合:`member-department.assign` + `member-department.unassign` + `member-department.read` | 动词最直白 | 与 R/C/U/D 范式偏离更多;`read` 仅 2 段不合法 |

**推荐**:**A**——业务语义清晰优先;接受 B 作为备选(若用户拍板偏好严格 R/C/U/D)。

**风险**:无实质风险;命名变更成本低(改 seed + service 字符串 + e2e 字符串即可)。

---

## §6 推荐拍板

### 6.1 默认推荐组合

| 决议 | 推荐 | 引用 |
|---|---|---|
| D1 ops-admin 绑定策略 | **A**:PR-2A 19 条 + PR-2B 14 条(除凭证)一并绑 `ops-admin` | §5.1 |
| D2 凭证 reset 权限 | **A**:`storage-setting.reset.credentials` **不绑** `ops-admin`,仅 SA 短路 | §5.2 |
| D3 dict/org 软删权限 | **A**:`dict.delete.type` / `dict.delete.item` / `org.delete.node` 绑 `ops-admin`(放宽) | §5.3 |
| D4 member-department 命名 | **A**(主推):`set` / `clear` / `read` + `.current` resourceType;**接受 B 作为备选** | §5.4 |

### 6.2 推荐组合下的 ops-admin 最终绑定矩阵

- 既有 14 条 `rbac.*`(沿 PR-1)
- PR-2A 后扩 19 条:`dict.*`(8)+ `org.*`(4)+ `member-department.*`(3)+ `contribution.*`(4)
- PR-2B 后扩 14 条:`attachment-config.*`(12)+ `storage-setting.*`(2,**不含** `reset.credentials`)
- 合计 **47 条**;SUPER_ADMIN 短路通过任意 action(沿 D7 §7.1 / `rbac.service.ts:118`)

---

## §7 seed 变更设计

### 7.1 只改 seed,不改 schema(沿 §0.2 / §2.2 / [`CLAUDE.md §1 不解锁`](../CLAUDE.md))

- **不动** [`prisma/schema.prisma`](../prisma/schema.prisma)
- **不动** 任何 [`prisma/migrations/`](../prisma/migrations/)
- **不动** RBAC 4 表(`permissions` / `rbac_roles` / `role_permissions` / `user_roles`)结构

### 7.2 [`prisma/seed.ts`](../prisma/seed.ts) 变更点(预生成 SQL 不适用 —— seed 是运行时 upsert)

| 位置 | PR-2A 改 | PR-2B 改 |
|---|---|---|
| `RBAC_PERMISSION_SEED` 之后新增 module 段位常量 | 新增 4 个常量数组(`DICT_PERMISSION_SEED` 8 条 / `ORG_PERMISSION_SEED` 4 条 / `MEMBER_DEPARTMENT_PERMISSION_SEED` 3 条 / `CONTRIBUTION_PERMISSION_SEED` 4 条) | 新增 2 个常量数组(`ATTACHMENT_CONFIG_PERMISSION_SEED` 12 条 / `STORAGE_SETTING_PERMISSION_SEED` 3 条) |
| `seedRbac` 函数 step 1 upsert Permission | 把新 4 数组与现 `RBAC_PERMISSION_SEED` / `ATTACHMENT_PERMISSION_SEED` 一同循环 upsert | 把新 2 数组追加循环 upsert |
| `seedRbac` 函数 step 3 ops-admin RolePermission 映射 | `ops-admin` 绑定数组从 14 条扩到 33 条(沿 D3 推荐 A) | 数组从 33 扩到 47 条;**`storage-setting.reset.credentials` 跳过**(沿 D2 推荐 A) |
| `OPS_ADMIN_DESCRIPTION` 常量文案 | "RBAC 自身 14 条 + 配置类 19 条" | "RBAC 自身 14 条 + 配置类 33 条;凭证 reset 仅 SUPER_ADMIN" |
| `console.log('[seed] RBAC role-permissions ensured ...')` | 数字与上述同步 | 同上 |

### 7.3 [`test/fixtures/rbac.fixture.ts`](../test/fixtures/rbac.fixture.ts) 变更点

- 沿 fixture 第 17 行说明:`resetDb` 清空 RBAC 4 表,e2e 必须自带 seed
- PR-2A:`seedRbacPermissionsAndOpsAdmin` 内的 `RBAC_PERMISSIONS` 常量从 14 条扩到 33 条(沿 D3 推荐 A,3 个软删 grant 给 ops-admin)
- PR-2B:`RBAC_PERMISSIONS` 从 33 扩到 47 条;`storage-setting.reset.credentials` 加入 `permission.upsert` 但**不**加入 `rolePermission.createMany`(沿 D2 推荐 A)
- **不**新建独立 fixture 文件(沿 PR-1 "一个 fixture 一次 seed 全集"范式)

### 7.4 seed 幂等性保证

- 现有 `prisma.permission.upsert({ where: { code }, update: {}, create: {...} })` 范式天然幂等
- 现有 `prisma.rolePermission.upsert({ where: { roleId_permissionId: ... }, update: {}, create: ... })` 范式天然幂等
- 多次跑 seed 不重复创建;**已绑的 RolePermission 不会因 seed re-run 被撤销**

### 7.5 生产 / 测试 / 演练环境的 seed 行为

| 环境 | 首次 seed 后 ops-admin 权限 | 第二次 seed(re-run)后 |
|---|---|---|
| dev | 47 条(PR-2 完整后) | 47 条(upsert no-op) |
| test(e2e DB) | fixture 控制,与 seed 解耦 | fixture 控制 |
| staging | 47 条 | 47 条(upsert no-op) |
| production | 47 条 | 47 条(upsert no-op);**运营若手工撤销了某 RolePermission,seed re-run 会重新加回**(沿 现 seed `update: {}` 不覆盖既有,但 RolePermission 走 createMany / upsert,需 PR-2 实施时显式确认) |

**实施前置**(沿 [`CLAUDE.md §0`](../CLAUDE.md)):seed 改动**不需要** `prisma migrate dev`,但 PR-2A / PR-2B 提交前**必须**在 dev 跑一次 `pnpm db:seed` 验证 47 条 RolePermission 都符合预期。

---

## §8 controller / service 改造范式

> 严格沿 PR-1 attachments F3 / F5 v1.0 范本;**禁止**自创新范式。

### 8.1 controller 改 4 项(每端点)

```ts
// 改前(沿 v1 / V2.x 既有 8 controller 48 端点)
@Get()
@Roles(Role.SUPER_ADMIN, Role.ADMIN)
@ApiOperation({ summary: '列出字典类型(分页)' })
@ApiWrappedPageResponse(DictTypeResponseDto)
@ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
list(@Query() query: ListDictTypesQueryDto): Promise<PageResultDto<DictTypeResponseDto>> {
  return this.service.listDictTypes(query);
}

// 改后(沿 PR-1 permissions.controller.ts:40-49 范式)
@Get()
@ApiOperation({ summary: '列出字典类型(分页)' })
@ApiWrappedPageResponse(DictTypeResponseDto)
@ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
list(
  @CurrentUser() user: CurrentUserPayload,
  @Query() query: ListDictTypesQueryDto,
): Promise<PageResultDto<DictTypeResponseDto>> {
  return this.service.listDictTypes(user, query);
}
```

**4 项动作**:
1. 移除 `@Roles(Role.SUPER_ADMIN, Role.ADMIN)` 装饰器与 `Roles` import
2. `@ApiBizErrorResponse(...)` 内 `BizCode.FORBIDDEN` → `BizCode.RBAC_FORBIDDEN`
3. 新增 `@CurrentUser() user: CurrentUserPayload`(dict / org / member-dept 当前**未注入** user,必须新增;contribution-rules / attachment-configs 已注入,沿既有签名)
4. service 方法签名首参 `user`(改 dict / org / member-dept;contribution-rules / attachment-configs 已有 `currentUser` 参数,沿既有签名)

### 8.2 service 改 3 项

```ts
// 沿 PR-1 permissions.service.ts:41-45 范式
private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
  if (!(await this.rbac.can(user, action))) {
    throw new BizException(BizCode.RBAC_FORBIDDEN);
  }
}

// 业务方法首句调用
async list(user: CurrentUserPayload, query: ListDictTypesQueryDto): Promise<PageResultDto<DictTypeResponseDto>> {
  await this.assertCanOrThrow(user, 'dict.read.type');
  // ... 既有业务逻辑
}
```

**3 项动作**:
1. constructor 注入 `private readonly rbac: RbacService`
2. 加 `assertCanOrThrow` private helper(沿 PR-1 `permissions.service.ts:41-45` 字面复制,**禁止**改动签名)
3. 每业务方法首句 `await this.assertCanOrThrow(user, '<permission.code>')`(在 DB 查询 / 事务**之前**)

### 8.3 module 改 1 项

```ts
// 沿现有 module 范式追加 PermissionsModule import
@Module({
  imports: [DatabaseModule, PermissionsModule, ...既有 imports],
  controllers: [...],
  providers: [...],
})
```

**前置确认**:[`permissions.module.ts`](../src/modules/permissions/permissions.module.ts) 必须 `exports: [RbacService]`;PR-2A / PR-2B 启动前 grep 验证,若未导出**先**改 [`permissions.module.ts`](../src/modules/permissions/permissions.module.ts) 加 exports(此改动单独不算"改 PR-2 范围",视为前置基建)。

### 8.4 attachment-configs 文件头注释清理(仅 PR-2B)

- [`attachment-configs.module.ts:19-26`](../src/modules/attachment-configs/attachment-configs.module.ts:19) "入口 @Roles(SUPER_ADMIN, ADMIN);不接 rbac.can()" → 改 P0-F PR-2B 锁定描述
- [`attachment-type-configs.controller.ts:37-38`](../src/modules/attachment-configs/attachment-type-configs.controller.ts:37) "F4 v1.0 锁:全部使用 @Roles ...;不接 rbac.can()" → 改撤销说明
- [`attachment-mime-configs.controller.ts:38-39`](../src/modules/attachment-configs/attachment-mime-configs.controller.ts:38) 同上
- [`attachment-size-limit-configs.controller.ts:36-37`](../src/modules/attachment-configs/attachment-size-limit-configs.controller.ts:36) 同上

**为什么明文撤销 F4 锁**:F4 v1.0 是 attachments 评审稿历史决议"配置三表是系统配置,不为其单设 rbac.config.* 权限点";本评审稿明文撤销该锁,沿 P0-F PR-2 推动配置类接口 RBAC 接入(D1 决议)。

### 8.5 特殊处理

- **storage-settings 位于 [`src/common/storage/`](../src/common/storage/)**:`StorageModule` import `PermissionsModule` 时**必须 grep 验证**无循环依赖(PR-2B 启动前确认);若有循环依赖,fallback 方案:`PermissionsModule` exports 范围内拆 `RbacModule` 独立模块(此 fallback 不在 PR-2 范围,需先发现再决议)
- **dict 单文件双 controller**:[`DictTypesController` + `DictItemsController`](../src/modules/dictionaries/dictionaries.controller.ts) 共用单 service [`DictionariesService`](../src/modules/dictionaries/dictionaries.service.ts);两 controller 独立改,service 加一个 `assertCanOrThrow` 即可
- **attachment-configs 单模块三 controller**:[3 controller](../src/modules/attachment-configs/) + 3 service;每 service 独立加 `assertCanOrThrow`(沿 PR-1 5 service 5 helper 范式)
- **member-departments 嵌套路径**:`/v2/members/:memberId/department` 不变;permission 判断**不**传 resource(本期不做 self/other,ADMIN 视角)

---

## §9 e2e 矩阵

### 9.1 每 spec 文件最小 5 用例(沿 PR-1 [`test/e2e/permissions.e2e-spec.ts:69-168`](../test/e2e/permissions.e2e-spec.ts:69) 范式)

| 用例 | 行为 | 期望响应 |
|---|---|---|
| 1 | 未登录 GET → 401 | `expectBizError(res, BizCode.UNAUTHORIZED)` |
| 2 | USER 角色任一端点 → 403 | `expectBizError(res, BizCode.RBAC_FORBIDDEN)` |
| 3 | ADMIN 默认(未持 ops-admin)任一端点 → 403 | `expectBizError(res, BizCode.RBAC_FORBIDDEN)` |
| 4 | ADMIN 持 ops-admin → 通过(`grantOpsAdminToUser` + try / finally + `revokeOpsAdminFromUser`) | 业务成功响应 |
| 5 | SUPER_ADMIN 短路 → 通过(无需 grant) | 业务成功响应 |

### 9.2 PR-2A 特殊用例(D3 软删放宽验证)

| spec | 用例 | 期望 |
|---|---|---|
| dictionaries.e2e | ADMIN+ops-admin 调 `DELETE /v2/dict-types/:id` → 200 | 软删成功 |
| dictionaries.e2e | ADMIN+ops-admin 调 `DELETE /v2/dict-items/:id` → 200 | 软删成功 |
| organizations.e2e | ADMIN+ops-admin 调 `DELETE /v2/organizations/:id` → 200 | 软删成功 |

**若 D3 拍板 B**:三用例改 `→ 30100 RBAC_FORBIDDEN`;sub-protection 仍由 SA 短路覆盖。

### 9.3 PR-2B 特殊用例(D2 凭证收紧验证)

| spec | 用例 | 期望 |
|---|---|---|
| storage-settings.e2e | ADMIN+ops-admin 调 `POST /v2/storage-settings/reset-credentials` → 30100 | RBAC_FORBIDDEN(凭证 ADMIN 不可调) |
| storage-settings.e2e | SUPER_ADMIN 调 `POST /v2/storage-settings/reset-credentials` → 200 | 凭证录入成功 |

**若 D2 拍板 B**:第一用例改 `→ 200`;凭证录入对 ADMIN 开放。

### 9.4 用例数量估算

| 范围 | spec 文件 | 用例增量 | 累计 |
|---|---|---|---|
| PR-2A | dictionaries / organizations / member-departments / contribution-rules | 5 × 4 + D3 特殊 3 = 23 | ~23 新用例 |
| PR-2B | attachment-{type,mime,size-limit}-configs / storage-settings | 5 × 4 + D2 特殊 2 = 22 | ~22 新用例 |
| 合计 | 8 spec | **~45 新用例** | 现 1294 → ~1339 |

`pnpm test:e2e` 耗时预期增加 ~5%(沿 PR-1 增 5 用例 + 2 contract spec 后耗时变化推算)。

### 9.5 fixture 复用方式

- `seedRbacPermissionsAndOpsAdmin` 扩到 47 条 permission;PR-2A 用 33 条版本,PR-2B 用 47 条版本(沿 §7.3 双阶段扩展)
- `grantOpsAdminToUser` / `revokeOpsAdminFromUser` 不变(签名不动)
- 每 spec `beforeAll` 调用 `seedRbacPermissionsAndOpsAdmin` 一次;`grantOpsAdminToUser` 在用例 4 / D3 / D2 用例内按需调用,`afterEach` / `finally` 内 revoke

---

## §10 OpenAPI snapshot 预期变化

### 10.1 变化范围

| 变化类型 | 量级 | 备注 |
|---|---|---|
| `responses.403` enum 替换:`40300 / 无权限访问` → `30100 / RBAC 权限不足` | 48 端点 × ~14 行 ≈ **640 行 +-** | PR-2A ~360 行 / PR-2B ~280 行 |
| `paths.*` 路径增删 | **0** | PR-2 不动 endpoint |
| `paths.*.parameters` 或 `requestBody` | **0** | PR-2 不动 DTO / 入参 |
| `components.schemas.*` | **0** | PR-2 不动响应 DTO / 字段集 |
| `tags` | **0** | controller `@ApiTags(...)` 不动 |

### 10.2 contract spec 验收(沿 [`test/e2e/openapi.contract-spec.ts`](../test/e2e/openapi.contract-spec.ts) 255 用例)

- PR-1 #132 已通过完整 contract spec 验证(沿 commit message "1294 e2e + 255 contract 全绿")
- PR-2A / PR-2B 预期不引入新 contract spec 失败;若失败,优先检查 `@ApiBizErrorResponse` 装饰器签名与 `RBAC_FORBIDDEN` BizCode 引用(沿 PR-1 同款修复路径)
- snapshot diff 必须**只**包含 `403` enum 段位变化;**禁止**出现路径 / DTO / tag diff(若出现,视为越权改动,PR-2 必须回退)

### 10.3 breaking change 性质

- 前端调用方:**HTTP status 不变**(仍是 403);**响应 body `code` 由 40300 → 30100**
- 翻译表:沿 [`first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md) `RBAC_FORBIDDEN=30100` 已存在(PR-1 收口时落地);PR-2 不引入新翻译
- 前端处理:若前端按 HTTP status 处理,无变化;若按 BizCode 处理,需识别 30100(沿 PR-1 同款 breaking)

---

## §11 PR 拆分建议

### 11.1 推荐:PR-2A 先行 + PR-2B 单独评审

| 因素 | PR-2A 先行的理由 |
|---|---|
| 风险 | PR-2A 不涉及凭证,D3 软删放宽是低风险;PR-2B 涉及凭证 reset(D2)+ attachments F4 锁定撤销,需独立评审 |
| 决议简单度 | PR-2A 决议主要是 D1 部分 + D3 + D4;PR-2B 决议主要是 D1 部分 + D2 |
| OpenAPI diff 量级 | PR-2A ~360 行 / PR-2B ~280 行,分两次 review 比一次 640 行更可控 |
| seed / fixture 双阶段扩展 | PR-2A 后扩到 33 条;PR-2B 后扩到 47 条;运维 grant 路径清晰 |
| 回滚成本 | PR-2A 单独回滚不影响 attach-config / storage-setting;PR-2B 单独回滚不影响 4 模块 |
| 串行节奏 | PR-2A merged → PR-2B 启动(沿 P0-D / P0-E 4-PR 串行精神) |

### 11.2 备选(不推荐):单 PR 合并 PR-2A + PR-2B

| 缺点 |
|---|
| ~1500-2000 行代码变更一次过,review 负担显著 |
| OpenAPI snapshot diff ~640 行一次过 |
| seed 一次扩 34 条,fixture 一次扩 33 条 |
| D2 凭证收紧 + D3 软删放宽 + attachments F4 锁定撤销混在一起;若某条决议需回滚,整 PR 全退 |

### 11.3 不推荐:更细拆分(PR-2A 再拆 4 子 PR)

| 缺点 |
|---|
| 4 子 PR 各自 fixture 微调,e2e 节奏断裂 |
| seed 三阶段扩展(14 → 22 → 26 → 29 → 33),实施成本高 |
| 与 P0-D / P0-E "粗粒度串行 PR"范式不一致 |

### 11.4 PR-2A / PR-2B 各自的 commit message 范式(沿 PR-1 #132)

```
feat(rbac): enforce permissions on config APIs (PR-2A)

P0-F PR-2A:把 4 模块 8 controller 28 端点 controller 入口从 v1 三层
@Roles(SUPER_ADMIN, ADMIN) 切换到 Service 层 rbac.can()(沿 PR-1 #132 范本)。

- 28 处 @Roles 装饰器从 dict / org / member-dept / contrib-rule 移除
- 4 service 加 assertCanOrThrow 范式 + 注入 RbacService
- 19 条新 permission code 落 seed + ops-admin 绑定(D1 + D3 沿评审稿 v1)
- 4 个 e2e spec 改造覆盖 5 用例矩阵(USER / ADMIN 默认 / ADMIN+ops-admin /
  SUPER_ADMIN 短路 / 软删放宽 D3 验证)
- 失败统一抛 BizException(BizCode.RBAC_FORBIDDEN)(30100);零新增 BizCode
- 不动:schema / migration / attachments / users / audit-logs / 业务记录类
- (验收数据 PR 实施后填)e2e + contract + lint + typecheck + build 全绿
```

PR-2B commit message 沿 PR-2A 范式,描述凭证收紧(D2)+ F4 锁定撤销。

---

## §12 风险与回滚

### 12.1 ADMIN 默认无权限导致运营不可用(最高优先级风险)

- **风险**:PR-2A / PR-2B merged 上线后,所有现役 ADMIN 立即对 6 模块 48 端点报 30100;若未提前 grant `ops-admin`,运营当天瘫痪
- **缓解**:
  - PR-2A 上线 SOP 前置:运维**必须**手工调 `POST /api/v2/users/:userId/roles` 把所有现役 ADMIN 都绑 `ops-admin`,**再** merge PR-2A;PR-2B 同
  - 沿 PR-1 #132 commit message 暗示("ADMIN 默认 30100")已建立此心智
  - 评审稿明文要求:上线 SOP 增 "PR-2A 上线前 grant ops-admin 给所有 ADMIN"步骤
- **回滚**:若运营瘫痪,DB 直改 `INSERT INTO user_roles ...` 给受影响 ADMIN;或 revert PR-2A 整 PR

### 12.2 ops-admin 权限过大(D1 推荐 A 的代价)

- **风险**:`ops-admin` 一次性扩到 47 条权限;未来"运营 ≠ 配置管理员"诉求出现时回滚链路长
- **缓解**:
  - 沿 PR-1 RBAC 已实装 `DELETE /v2/roles/:id/permissions/:permissionId` 接口,可单条撤销
  - 若未来需拆 `config-admin` 独立角色,改 seed + 运行时迁移 RolePermission 即可(非破坏性)
- **回滚**:无回滚需求(扩张可撤销)

### 12.3 storage-setting.reset.credentials 凭证敏感(D2 推荐 A 的代价)

- **风险**:PR-2B 上线后,持 ops-admin 的 ADMIN 无法 reset 凭证;仅 SUPER_ADMIN 可
- **缓解**:
  - 上线 SOP 前置:PR-2B 上线前确认 SUPER_ADMIN 在职 + 可登录
  - 文档明示:此动作仅 SUPER_ADMIN(改 [`current-state.md`](current-state.md) / [`bootstrap-sop.md`](first-release-bootstrap-sop.md))
  - 紧急回滚:DB 直改 `INSERT INTO role_permissions (roleId, permissionId) VALUES (...)` grant `storage-setting.reset.credentials` 给 `ops-admin`;**必须**配合 `POST /api/v2/rbac/reload` 或重启 / 等 cache 自然失效
- **回滚**:若决议被推翻,改 seed 一行 + run seed(`ops-admin` 自动 grant 此条权限)

### 12.4 e2e 数量增长(~1294 → ~1339,~5%)

- **风险**:CI 时长增加;flaky 概率轻微提升
- **缓解**:
  - 沿 PR-1 #132 已经吸收 +5 用例的耗时;PR-2A 增 23 / PR-2B 增 22,与 PR-1 同量级
  - e2e 范式严格沿 fixture,无新增 fixture 文件 / 无新增 helper / 无新增并发(沿 [`test/setup/test-app.ts`](../test/setup/test-app.ts) 既有 sequential 范式)
- **回滚**:无回滚需求

### 12.5 OpenAPI breaking change(40300 → 30100;6 模块 48 端点)

- **风险**:前端若按 `code: 40300` 硬判 forbidden,会断
- **缓解**:
  - 前端联调起步包文档([`first-release-frontend-scope.md`](first-release-frontend-scope.md))已建议按 HTTP status 处理,而非 BizCode
  - PR-2A / PR-2B 收口时同步更新 [`first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md)(若未覆盖 30100 / 40300 双码语义,沿 PR-1 同款修订路径)
- **回滚**:仅 BizCode 替换,改 controller 装饰器还原即可

### 12.6 双轨期说明

- PR-2A merged → PR-2B 启动前的窗口期:
  - PR-2A 4 模块走 `rbac.can()`(`RBAC_FORBIDDEN=30100`)
  - PR-2B 4 controller 仍走 `@Roles`(`FORBIDDEN=40300`)
  - **不**算"破坏一致性",沿 PR-1 # 132 后双轨期同样存在(attachments + permissions 走 rbac.can,其余走 @Roles)
- 双轨期内运维 / 文档需明示:不同模块的 403 响应 BizCode 不一致是预期行为,且会随 PR-2B 收敛
- 双轨期最长不超过 1-2 周(PR-2A → PR-2B 串行节奏)

---

## §13 实施前 checklist(PR-2A / PR-2B 启动前逐项确认)

### 13.1 评审 / 决议前置

- [ ] 用户拍板 **D1**(ops-admin 绑定策略;沿 §5.1)
- [ ] 用户拍板 **D2**(凭证 reset 收紧;沿 §5.2)
- [ ] 用户拍板 **D3**(dict/org 软删放宽;沿 §5.3)
- [ ] 用户拍板 **D4**(member-department 命名;沿 §5.4)
- [ ] 用户确认 **PR-2A 先行 / PR-2B 单独评审**(沿 §11.1)
- [ ] 用户确认 permission code 命名清单(沿 §4;若 D4 拍板 B,字符串改 `update.assignment` 等)
- [ ] 用户确认 ops-admin grant 策略(沿 §6.2 + §12.1 上线 SOP 前置)

### 13.2 PR-2A 启动前技术前置

- [ ] grep [`permissions.module.ts`](../src/modules/permissions/permissions.module.ts) 确认 `RbacService` 已 exports;否则**先**改 module exports(此改动单独不算 PR-2A 范围,但是前置基建)
- [ ] grep 4 个目标 module 文件确认无循环依赖隐患(dict / org / member-dept / contrib-rule)
- [ ] 列出 4 个目标 service 现有方法签名,确认 `currentUser` 是否已注入(dict / org / member-dept 未注入需新增)

### 13.3 PR-2B 启动前技术前置(在 PR-2A merged 后)

- [ ] PR-2A merged 状态 + 验收全绿
- [ ] grep [`src/common/storage/storage.module.ts`](../src/common/storage/storage.module.ts) 确认 `PermissionsModule` 导入无循环依赖
- [ ] 确认 SUPER_ADMIN 在职 + 可登录(沿 §12.3 缓解)
- [ ] 4 个 attachment-configs / storage-settings 文件头注释清理清单(沿 §8.4)

### 13.4 PR-2A / PR-2B 各自启动后验收门槛(沿 [`CLAUDE.md §17.10`](../CLAUDE.md))

- [ ] `pnpm lint` 通过
- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test:e2e` 全部通过(含本评审稿 §9 新增 ~23 / ~22 用例)
- [ ] `pnpm build` 通过
- [ ] OpenAPI snapshot diff 仅 `403` enum 替换,**0** 路径 / DTO / tag 变化(沿 §10)
- [ ] contract spec 255 用例(或扩张后)全绿
- [ ] `pnpm db:seed` dev 跑一次确认 ops-admin 持有正确条数 permission(沿 §7.5)
- [ ] handoff / current-state 收口(归 PR-2A / PR-2B 各自的 docs 收口子 PR 或 v0.15.0 handoff;不在本评审稿范围)

---

## §14 不在本文范围 / 引用来源 / 文档元信息

### 14.1 不在本文范围

- 接口字段细节(回 [`v2-api-contract.md`](v2-api-contract.md))
- BizCode 全量翻译表(回 [`first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md))
- users / auth / audit-logs / 业务记录类 self/other 拆分(归独立 P0-F 后续 PR)
- 部门部长 / 副部长层级权限(归 Slow-3 业务方拍板)
- Slow-4 79 接口全量 RBAC(归 V2 Slow 通道)
- RBAC schema 变更(`User.role` 删除 / `Role` enum 变化 / 新增字段)
- `tokenVersion` / access token blacklist(沿 P0-E 评审稿 D-4 锁死本期不做)
- 代码落地细节(归 PR-2A / PR-2B 实施稿)
- [`CLAUDE.md`](../CLAUDE.md) / [`AGENTS.md`](../AGENTS.md) 铁律修订(若 D1-D4 拍板后确需,归独立 docs PR)
- 现有 [`readiness-plan`](first-release-readiness-plan.md) / [`frontend-scope`](first-release-frontend-scope.md) / [`bizcode-mapping`](first-release-bizcode-mapping.md) / [`bootstrap-sop`](first-release-bootstrap-sop.md) / [`current-state.md`](current-state.md) / [`security.md`](security.md) 的状态回填(归 PR-2A / PR-2B 各自的 docs 收口子 PR)

### 14.2 引用来源

| 文档 | 引用章节 |
|---|---|
| [`CLAUDE.md`](../CLAUDE.md) | §0 修改代码前必读 / §1 不解锁 / §17.10 验收门槛 |
| [`AGENTS.md`](../AGENTS.md) | 同 CLAUDE.md(双向对齐) |
| [`docs/srvf-foundation-baseline.md`](srvf-foundation-baseline.md) | §1.1 BizCode 段位 / §1.3 命名 / §3.2 排序 |
| [`docs/first-release-readiness-plan.md`](first-release-readiness-plan.md) | §3.1 P0-F / §5 PR 拆分 / §3.1 凭证 SA-only 暗示 |
| [`docs/first-release-bootstrap-sop.md`](first-release-bootstrap-sop.md) | 配置类接口现状 |
| [`docs/first-release-p0d-change-my-password-review.md`](first-release-p0d-change-my-password-review.md) | 评审稿章节范式(§0-§10) |
| [`docs/first-release-p0e-refresh-token-review.md`](first-release-p0e-refresh-token-review.md) | 评审稿章节范式 + D 档串行 PR 范式 + 决议 D-X 格式 |
| [`docs/first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md) | `RBAC_FORBIDDEN=30100` 翻译现状 |
| [`docs/first-release-frontend-scope.md`](first-release-frontend-scope.md) | 前端 BizCode 处理建议 |
| [`docs/current-state.md`](current-state.md) | §3 Slow-3 / §4 当前 @Roles 现状 |
| PR #132 commit `488b814` | P0-F PR-1 范本 + attachments F3/F5 v1.0 范本引用 |
| [PR #132 `permissions.controller.ts`](../src/modules/permissions/permissions.controller.ts) | controller 改造范本(§8.1) |
| [PR #132 `permissions.service.ts`](../src/modules/permissions/permissions.service.ts) | service 改造范本(§8.2)+ `assertCanOrThrow` 字面复制 |
| [PR #132 `test/fixtures/rbac.fixture.ts`](../test/fixtures/rbac.fixture.ts) | e2e fixture 复用范本(§7.3 + §9.5) |
| [PR #132 `test/e2e/permissions.e2e-spec.ts`](../test/e2e/permissions.e2e-spec.ts) | e2e 5 用例矩阵范本(§9.1) |

### 14.3 文档元信息

- **撰写日期**:2026-05-18
- **状态**:v1 评审稿,待用户拍板
- **作者**:Claude(P0-F PR-2 前置设计阶段产出)
- **基线 commit**:`488b814`(P0-F PR-1 merged 后)
- **下一步动作**:
  1. 用户 review 本评审稿
  2. 用户拍板 D1-D4 + PR 拆分确认
  3. (拍板后)启动 PR-2A 代码 PR
  4. PR-2A merged + 验收 → 启动 PR-2B 代码 PR(若 D1 部分 / D2 / F4 锁定撤销均确认)

### 14.4 撰写边界声明

本评审稿严格 docs-only:
- 仅新增 1 个文件 [`docs/first-release-p0f-pr2-config-rbac-review.md`](first-release-p0f-pr2-config-rbac-review.md)
- 不修改 src / prisma / test / 其它 docs
- 不创建 migration
- 不改 schema / seed
- 不启动 PR-2A / PR-2B 任何代码实施
- 全部决议项保留 A / B / C 三选择;§6 推荐拍板可被用户改动
- 命名命题保留可改路径(D4 命名拍板后可改 §4 列表)
- code 段位与已有 `rbac.*` / `attachment.*` 物理隔离

如本文与 [`ARCHITECTURE.md`](../ARCHITECTURE.md) / [`CLAUDE.md`](../CLAUDE.md) / [`AGENTS.md`](../AGENTS.md) / [`baseline`](srvf-foundation-baseline.md) 表述冲突,按 §0 优先级让步。
