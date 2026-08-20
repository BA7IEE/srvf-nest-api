> **归档冻结件**(2026-08-20 入仓)。原件由维护者于 2026-08-20 提供,**逐字搬运,未改一字**。
>
> **性质**:终态设计方案,**非实施记录**。本文描述的 8 个 PR 中,
> **仅「授撤对称收口」一条已抽出实施**(第六轮评审 E-B1 的同族缺陷,见下方「入仓时的实况标注」);
> 其余 7 条**尚未实施**,排期见 [`docs/ai-harness/NEXT_TASKS.md`](../../ai-harness/NEXT_TASKS.md) P1-32。
>
> ⚠️ **归档区冻结不回改**:本文此后不再更新。方案与代码实况若有出入,**以代码为准**;
> 实施过程中的偏离记在对应 PR 与 `NEXT_TASKS`,不回改本文。

---

## 入仓时的实况标注(2026-08-20,主会话复核)

方案 §0 列的 8 条缺陷,主会话抽验其中三条,**全部属实**:

| 方案说 | 复核读数 |
|---|---|
| `Permission` 可运行时物理删除 | ✅ `permissions.controller.ts:112` `@Delete(':id')` |
| `RolePermission` 无全量原子替换 | ✅ 只有 `@Post` + `@Delete(:permissionId)`,**无 `@Put`** |
| 授码有分级闸、撤码没有 | ✅ `role-permissions.service.ts` —— `assign:109` 于 `:123` 调 `assertNoControlPlaneCodesOrThrow`;**`revoke:160` 一个闸都没有** |

⭐ **第三条已抽出单独实施**:它是 8 条里**唯一「现在就存在的、可被利用的安全缺口」**
(非 SUPER_ADMIN 授不了控制面码,**但可以撤**),其余七条属「做得更好」。
与刚修完的 E-B1(#1115)是同一家族:**一侧有闸、另一侧没有**。

📌 顺带修正方案的一处措辞:`revoke` 的实际方法名是 `revoke` 而非 `remove`。

---

# SRVF-DP 权限目录与角色权限管理终态落地技术方案

> 文档版本：v1.0  
> 研究对象：`BA7IEE/srvf-nest-api`  
> 代码基线：`main@d83599f16a7dc3e4e1db6ed641c8f6def2052832`  
> 研究日期：2026-08-21  
> 文档性质：技术设计与实施计划，不包含本次代码改动  
> 核心范围：Permission Catalog、系统/自定义角色、角色权限集原子变更、影响预览、并发控制、审计、RoleBinding 范围兼容、Admin Web 交互与迁移切换

---

## 0. 执行结论

当前 SRVF 权限底座本身并不弱：

- 已有 `Permission → RbacRole → RolePermission → RoleBinding`；
- 已有 GLOBAL 与 scoped Authz 双轨；
- 已有职务、分管、直接 RoleBinding 三种授权来源；
- 已有 `authz/explain` 和 `authz/explain-batch`；
- 已有审计、末位管理员保护、系统托管角色、控制面权限防委派；
- 判权每请求读取 PostgreSQL 当前事实，不依赖本地缓存。

真正缺失的是**授权管理产品层**。目前管理员在后台面对的是机器权限码，而不是人类可理解、可安全操作的权限目录；同时，现有控制面还存在几项终态前必须收口的结构性问题：

1. `Permission` 仍可在运行时创建、修改说明、物理删除；
2. 内置角色目前主要只有“禁止删除”，并未普遍禁止人工修改其权限集合；
3. RolePermission 只有“增量添加”和“单条删除”，没有全量原子替换；
4. 添加控制面权限有分级闸，撤销路径却没有对称策略；
5. 角色权限集没有 revision，并发编辑可能互相覆盖；
6. 修改角色前看不到受影响人员、范围和授权来源；
7. 权限中文说明散落在 seed 的技术 description 中，不是正式、人类可读的权限目录；
8. `Permission` 的代码事实散落在 `prisma/seed.ts` 与 `rbac-seed-facts.ts`，运行时无法直接安全消费完整元数据。

因此，终态不能只做：

> 给 Permission 增加一个中文字段，前端显示出来。

正确终态应当是：

```text
开发版本定义 Permission Catalog
           │
           ▼
系统内置角色（版本管理、只读）
自定义角色（管理员组合普通权限）
           │
           ▼
RoleBinding 决定谁、在哪个范围、哪段任期持有角色
           │
           ▼
RbacService / AuthzService 每次请求重新判定
           │
           ▼
ALLOW / DENY + 可解释来源
```

本方案建议拆成 **8 个连续 PR/Goal** 落地，不能一次性把 schema、236 条权限元数据、控制面策略、API、前端和旧接口删除塞进一个 PR。

---

# 1. 实际代码现状

## 1.1 当前规模

基线代码当前包含：

- 236 条权限码；
- 15 个受保护的内置角色；
- 101 个 Controller；
- 544 个 Endpoint；
- 91 个 Migration；
- GLOBAL RBAC 与 scoped Authz 两套有意并存的判权入口。

权限码的事实源目前由以下闭包共同承担：

```text
prisma/seed.ts
src/modules/permissions/rbac-seed-facts.ts
```

派生地图由：

```text
scripts/generate-rbac-map.ts
scripts/check-rbac-map.ts
docs/ai-harness/RBAC_MAP.md
```

共同守护。

## 1.2 Permission 当前模型

当前 Prisma 模型核心字段：

```prisma
model Permission {
  id           String   @id @default(cuid())
  code         String   @unique
  module       String
  action       String
  resourceType String
  description  String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  rolePermissions RolePermission[]

  @@index([module])
  @@index([resourceType])
  @@map("permissions")
}
```

现状含义：

- `code` 是机器合同；
- `module/action/resourceType` 用于技术分类；
- `description` 混合了中文业务含义、状态机、历史决策和技术注释；
- 没有 `displayName`；
- 没有正式业务分类；
- 没有风险等级；
- 没有可授予策略；
- 没有 UI 可见性；
- 没有生命周期状态；
- 没有替代权限；
- Permission 采用物理删除。

## 1.3 Permission 当前 API

现有接口：

```text
GET    /api/system/v1/permissions
POST   /api/system/v1/permissions
PATCH  /api/system/v1/permissions/:id
DELETE /api/system/v1/permissions/:id
```

实际行为：

- GET：分页，按 `module/resourceType` 过滤；
- POST：管理员可以创建任意格式合法的权限码；
- PATCH：只能修改 description；
- DELETE：物理删除 Permission；
- 删除时 RolePermission 外键 Cascade 自动删除关联。

这套 API 适合早期 RBAC 配置工具，但不适合成熟业务系统终态。因为 Permission 是代码中的安全合同，不是普通运营数据。

## 1.4 RbacRole 当前模型

当前角色模型核心字段：

```prisma
model RbacRole {
  id          String    @id @default(cuid())
  code        String    @unique
  displayName String
  description String?
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  deletedAt   DateTime?

  rolePermissions RolePermission[]
  roleBindings    RoleBinding[]
  rolePolicies    OrganizationPositionRolePolicy[]

  @@map("roles")
}
```

当前缺少：

- 系统角色/自定义角色类型；
- 权限集合管理模式；
- 绑定管理模式；
- 权限 revision；
- 风险标识；
- 建议/允许的 Binding Scope；
- 是否允许人工授予；
- 是否允许复制；
- 是否允许人工修改权限集合。

## 1.5 当前内置角色

`protected-role-codes.ts` 保护了 15 个角色：

```text
ops-admin
member
biz-admin
org-admin
org-readonly
group-manager
group-readonly
org-supervisor
attendance-final-reviewer
activity-publish-reviewer
activity-cross-org-initiator
attendance-first-reviewer
activity-owner
activity-registration-collaborator
activity-attendance-collaborator
```

当前保护主要是：

> 不允许通过 API 软删这些角色。

其中只有三个角色在 `system-managed-role-codes.ts` 中被明确标记为“只能由活动责任投影器维护绑定”：

```text
activity-owner
activity-registration-collaborator
activity-attendance-collaborator
```

但当前 RolePermission 写入口并没有统一阻止人工修改这些角色的权限集合。

这意味着“绑定由系统维护”和“角色本身包含哪些权限”目前是两个未完全合拢的边界。

## 1.6 RolePermission 当前写模型

当前接口：

```text
POST   /api/system/v1/roles/:id/permissions
DELETE /api/system/v1/roles/:id/permissions/:permissionId
```

POST：

- 入参 `permissionCodes[]`；
- 最多 100 条；
- 去重；
- `createMany(skipDuplicates)`；
- 已存在关系幂等跳过；
- 任一 code 不存在则整批拒绝；
- 非 SUPER_ADMIN 不能添加六条保留码、`rbac.*`、`role-binding.*`。

DELETE：

- 按 `permissionId` 删除单条关联；
- 不存在返回 `ROLE_PERMISSION_NOT_FOUND`；
- 写审计；
- 当前没有与 POST 对称的控制面撤权限制；
- 当前没有系统角色权限集只读限制；
- 当前没有 revision；
- 当前没有影响预览；
- 当前没有全量原子替换。

## 1.7 RoleBinding 当前能力

RoleBinding 已支持：

```text
Principal:
USER / MEMBER / POSITION_ASSIGNMENT / SYSTEM

Scope:
GLOBAL
ORGANIZATION
ORGANIZATION_TREE
ACTIVITY
RESOURCE
SELF

Term:
startedAt / endedAt

Status:
ACTIVE / ENDED / SUSPENDED
```

管理接口已经具备：

- 普通列表；
- 分页列表；
- role/principal 展开；
- dry-run preview；
- 单条创建；
- 批量创建；
- 更新；
- 软删；
- 作用范围和任期校验；
- 角色委派分级；
- 系统托管角色拒绝人工绑定；
- 末位 ops-admin 保护。

这套 preview + create 复用同一校验器的范式，应直接复用于新的角色权限集管理。

## 1.8 Authz 当前能力

AuthzService 当前授权来源：

```text
1. 直接 RoleBinding
2. 职务 → OrganizationPositionRolePolicy → Role
3. 分管 → org-supervisor Role
4. SUPER_ADMIN 短路
```

`authz/explain` 已能返回：

- allow/deny；
- reason；
- 命中的授权来源；
- roleCode；
- bindingId / positionAssignmentId / supervisionAssignmentId；
- scopeType / scopeId；
- 解析后的资源归属。

这意味着终态不需要另造一套“权限解释引擎”，只需把现有 explain 能力接进权限运营后台。

---

# 2. 第一性原理与不可破坏的边界

## 2.1 Permission Code 是程序合同，不是管理员文案

`attendance.final-approve.sheet` 的职责是：

- 被 Controller/Service 字面引用；
- 被 seed 注册；
- 被 RolePermission 关联；
- 被 RbacService/AuthzService 精确匹配；
- 被 RBAC_MAP、OpenAPI 和检查脚本验证。

它必须：

- 稳定；
- 唯一；
- 不因中文文案变化而变化；
- 不由普通管理员创建；
- 不由普通管理员删除；
- 不由前端翻译规则推导。

## 2.2 管理员操作的是“能力”，不是“字符串”

后台主显示：

```text
考勤终审
```

辅助显示：

```text
attendance.final-approve.sheet
```

详情显示：

```text
对考勤单执行最终审核。审核通过后，结果进入正式生效流程。
```

权限码应当降级为技术辅助信息。

## 2.3 Role 只回答“能做什么”

角色不应该编码组织名：

```text
错误：
山地救援队活动管理员
水上搜救队活动管理员
```

应当是：

```text
活动管理员
```

然后由 RoleBinding 表达：

```text
张三 + 活动管理员 + ORGANIZATION_TREE:山地救援队
```

## 2.4 Scope 继续独立于 Permission Code

现有架构已经明确：

```text
Permission = 能力
RoleBinding Scope = 范围
```

不得改造成：

```text
member.update.record.shrt
member.update.record.swrt
```

也不得为了 UI 方便，把组织范围重新塞进角色 code。

## 2.5 系统内置角色由版本维护

成熟终态中：

- 内置角色：程序版本定义、权限集只读；
- 自定义角色：管理员组合可授予权限；
- 系统托管角色：权限集只读，绑定也由业务投影器维护；
- 自定义角色不得伪装成系统角色。

这和成熟 IAM 的“预定义角色 + 自定义角色”边界一致。

## 2.6 判权真相仍在 PostgreSQL

权限目录可以静态加载，因为它只是元数据；但：

- 用户当前拥有哪些角色；
- RoleBinding 是否在期；
- 组织是否有效；
- 角色当前包含哪些 Permission；
- 资源是否属于作用范围；

仍必须在请求时读取数据库事实。

不得为这次 UI 改造引入：

- Redis；
- 权限缓存；
- Map/TTL；
- invalidate 链；
- 本地多实例一致性假设。

## 2.7 所有角色权限变更必须原子

角色权限集合从：

```text
A B C
```

改为：

```text
A D E
```

必须是一笔事务：

```text
删除 B/C + 新增 D/E + revision+1 + audit
```

不能由前端发四个独立请求拼出来。

## 2.8 预览不是授权证明

Preview 只回答：

> 按当前数据库事实，这次变更预计是否可行、影响什么。

实际 PUT 时必须：

- 重新判权；
- 重新加载角色；
- 重新检查 revision；
- 重新计算 diff；
- 重新执行所有策略；
- 重新检查 step-up proof；
- 在事务内完成写入。

---

# 3. 目标架构

```text
┌──────────────────────────────────────────┐
│ Permission Catalog（代码唯一真相）       │
│                                          │
│ 中文名 / 业务说明 / 分类 / 风险 / 授予策略│
│ 技术 code / 生命周期 / UI 可见性          │
└─────────────────────┬────────────────────┘
                      │ code
                      ▼
┌──────────────────────────────────────────┐
│ permissions 表（运行时关系锚点）          │
│ code / module / action / resourceType     │
└─────────────────────┬────────────────────┘
                      │ RolePermission
                      ▼
┌──────────────────────────────────────────┐
│ RbacRole                                 │
│ 系统角色：只读                           │
│ 自定义角色：管理员可编辑                 │
│ permissionRevision：并发控制             │
└─────────────────────┬────────────────────┘
                      │ RoleBinding
                      ▼
┌──────────────────────────────────────────┐
│ Principal + Scope + Term                 │
│ 谁 + 在哪里 + 什么任期                   │
└─────────────────────┬────────────────────┘
                      ▼
┌──────────────────────────────────────────┐
│ RbacService / AuthzService               │
│ DB-backed / default deny / explainable   │
└──────────────────────────────────────────┘
```

---

# 4. Permission Catalog 设计

## 4.1 为什么目录元数据应由代码管理

不建议把 `displayName/riskLevel/grantPolicy` 继续交给管理员在数据库里维护，原因：

1. 名称错误会诱导授权错误；
2. 风险等级被改低会弱化 UI 提示；
3. grantPolicy 被篡改会破坏安全边界；
4. 多环境会漂移；
5. 文案与代码版本难以追踪；
6. seed 当前大量使用 `update: {}`，不能保证线上数据自动对齐；
7. Permission 本质上由代码中是否调用该 code 决定。

因此：

> 权限目录是版本化的静态安全合同，数据库只保存运行时关系。

## 4.2 推荐类型

```ts
export const PERMISSION_RISK_LEVELS = [
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
] as const;

export const PERMISSION_GRANT_POLICIES = [
  'CUSTOM_ROLE_ALLOWED',
  'SUPER_ADMIN_ONLY',
  'ROLE_ALLOWLIST_ONLY',
  'SYSTEM_ROLE_ONLY',
] as const;

export const PERMISSION_CATALOG_STATUSES = [
  'ACTIVE',
  'DEPRECATED',
  'INTERNAL',
] as const;

export const PERMISSION_UI_VISIBILITIES = [
  'DEFAULT',
  'ADVANCED',
  'HIDDEN',
] as const;

export const PERMISSION_RISK_TAGS = [
  'READ',
  'WRITE',
  'DESTRUCTIVE',
  'SENSITIVE_DATA',
  'ACCOUNT_SECURITY',
  'CREDENTIAL',
  'CONTROL_PLANE',
  'FINAL_APPROVAL',
  'MASS_EFFECT',
  'LEDGER',
  'WORKFLOW_INTERNAL',
] as const;

export interface PermissionCatalogEntry {
  readonly code: string;

  // 机器结构
  readonly module: string;
  readonly action: string;
  readonly resourceType: string;

  // 人类展示
  readonly displayName: string;
  readonly businessDescription: string;
  readonly technicalDescription?: string;

  // 信息架构
  readonly sectionCode: string;
  readonly groupCode: string;
  readonly sortOrder: number;

  // 安全元数据
  readonly riskLevel: PermissionRiskLevel;
  readonly riskTags: readonly PermissionRiskTag[];
  readonly grantPolicy: PermissionGrantPolicy;

  // ROLE_ALLOWLIST_ONLY / SYSTEM_ROLE_ONLY 时使用
  readonly allowedRoleCodes?: readonly string[];

  // 生命周期
  readonly status: PermissionCatalogStatus;
  readonly replacementCodes?: readonly string[];
  readonly uiVisibility: PermissionUiVisibility;

  // 第一阶段仅用于提示，后续才强校验
  readonly scopeProfile?: PermissionScopeProfile;
}
```

## 4.3 分类结构

目录不应只按技术 module 分组。建议两级业务信息架构：

```ts
export interface PermissionCatalogSection {
  code: string;
  displayName: string;
  sortOrder: number;
}

export interface PermissionCatalogGroup {
  code: string;
  sectionCode: string;
  displayName: string;
  sortOrder: number;
}
```

建议首版业务区：

```text
01 组织与人员
02 活动与参与
03 证书与资质
04 招新与入队
05 保险
06 内容与通知
07 附件与存储
08 系统与安全
09 基础数据
```

示例分组：

```text
组织与人员
├─ 组织架构
├─ 队员
├─ 队员档案
├─ 紧急联系人
├─ 组织归属
├─ 职务
├─ 任职
├─ 分管
└─ 标准照

活动与参与
├─ 活动
├─ 发布审核
├─ 活动责任
├─ 报名
├─ 考勤
└─ 活动结算

系统与安全
├─ 用户账号
├─ 角色
├─ 权限点
├─ 角色绑定
├─ 权限诊断
├─ 审计
├─ 短信
├─ 微信/企业微信
├─ 实名核验
└─ 存储设置
```

## 4.4 权限目录示例

```ts
{
  code: 'attendance.final-approve.sheet',
  module: 'attendance',
  action: 'final-approve',
  resourceType: 'sheet',

  displayName: '考勤终审通过',
  businessDescription:
    '对考勤单执行最终审核。审核通过后，考勤结果进入正式生效流程。',
  technicalDescription:
    'pending_final_review → approved；后续贡献值或账本流程按当前业务版本执行。',

  sectionCode: 'activity-participation',
  groupCode: 'attendance-review',
  sortOrder: 710,

  riskLevel: 'CRITICAL',
  riskTags: ['FINAL_APPROVAL', 'MASS_EFFECT'],
  grantPolicy: 'ROLE_ALLOWLIST_ONLY',
  allowedRoleCodes: ['attendance-final-reviewer'],

  status: 'ACTIVE',
  uiVisibility: 'DEFAULT',
}
```

```ts
{
  code: 'member-profile.read.sensitive',
  module: 'member-profile',
  action: 'read',
  resourceType: 'sensitive',

  displayName: '查看队员敏感档案',
  businessDescription:
    '查看队员档案中的完整证件号码、手机号等敏感信息。',
  sectionCode: 'organization-people',
  groupCode: 'member-profile',
  sortOrder: 340,

  riskLevel: 'HIGH',
  riskTags: ['READ', 'SENSITIVE_DATA'],
  grantPolicy: 'CUSTOM_ROLE_ALLOWED',

  status: 'ACTIVE',
  uiVisibility: 'DEFAULT',
}
```

```ts
{
  code: 'rbac.role-permission.create',
  module: 'rbac',
  action: 'create',
  resourceType: 'role-permission',

  displayName: '给角色增加权限',
  businessDescription:
    '修改角色的权限集合。该操作会影响所有当前或未来持有该角色的主体。',
  sectionCode: 'system-security',
  groupCode: 'rbac-control-plane',
  sortOrder: 900,

  riskLevel: 'CRITICAL',
  riskTags: ['CONTROL_PLANE', 'MASS_EFFECT'],
  grantPolicy: 'SUPER_ADMIN_ONLY',

  status: 'ACTIVE',
  uiVisibility: 'ADVANCED',
}
```

## 4.5 风险等级不能通过字符串自动推断

不能简单写：

```ts
if (action === 'delete') risk = HIGH;
```

原因：

- `delete` 可能是软删、撤销或彻底删除；
- `read.sensitive` 比部分写操作更敏感；
- `final-approve` 会产生大范围业务后果；
- `reset.credentials` 是凭证控制面；
- `publish` 可能触达大量人员；
- `settlement-close` 涉及账本/关账。

风险必须逐条显式评审。

自动规则只能做检查器提示：

```text
发现 delete/reset/final/publish/sensitive 等动词，但 riskLevel 低于建议值 → CI WARN/FAIL
```

不能自动成为真相。

---

# 5. 权限事实源重构

## 5.1 推荐文件结构

```text
src/modules/permissions/
├─ permission-catalog.ts
├─ permission-catalog.types.ts
├─ permission-catalog.sections.ts
├─ permission-catalog.integrity.ts
├─ permission-catalog.presenter.ts
├─ builtin-role-catalog.ts
├─ rbac-seed-facts.ts
└─ ...
```

考虑当前脚本依赖“字面量扫描”，首版不建议把 236 条权限再拆成几十个文件。推荐：

```text
permission-catalog.ts
```

作为全部 Permission 条目的单一纯数据文件。

它必须：

- 不访问数据库；
- 不注入 Nest 服务；
- 不读取环境变量；
- 不依赖 `prisma/seed.ts`；
- 所有 code 保持 `code: '<literal>'`；
- Object.freeze；
- 可被生产代码、seed、测试和脚本共同消费。

## 5.2 `rbac-seed-facts.ts` 的处理

当前方向锁是：

```text
prisma/seed.ts → src/modules/permissions/rbac-seed-facts.ts
```

不得反向。

建议将 `rbac-seed-facts.ts` 改为兼容聚合层：

```ts
import { PERMISSION_CATALOG } from './permission-catalog';

export const RBAC_SEED_FACTS = Object.freeze({
  permissions: {
    rbac: PERMISSION_CATALOG.filter((p) => p.module === 'rbac'),
  },
  contract: {
    reservedSuperAdminOnlyPermissionCodes: ...
  },
});
```

但要注意：当前 RBAC Map 生成器依赖文本正则，而不是执行 import。若 code 全部搬走，必须同步修改：

```text
scripts/docs-counts.ts
scripts/generate-rbac-map.ts
scripts/check-rbac-map.ts
相关 selftest
```

推荐将权限码扫描闭包改成：

```text
src/modules/permissions/permission-catalog.ts
```

并保留 `rbac-seed-facts.ts` 作为运行时/seed 兼容出口。

## 5.3 `prisma/seed.ts` 的重构原则

现有业务权限数组应逐步替换为：

```ts
const ACTIVITY_PERMISSION_SEED = pickPermissionCatalogByCodes([
  'activity.create.record',
  'activity.update.record',
  ...
]);
```

角色权限映射使用 code 数组，不再复制完整 Permission 对象。

目标：

```text
Permission 定义只出现一次；
角色映射只声明“这个角色拿哪些 code”。
```

## 5.4 内置角色精确映射

当前 seed 大量采用 upsert，只会补缺，不会自动删除历史遗留 RolePermission；部分业务变更使用 targeted cleanup。

终态内置角色既然是版本管理，就必须有精确映射能力：

```ts
reconcileBuiltinRolePermissionSet(
  tx,
  roleCode,
  expectedPermissionCodes,
)
```

逻辑：

1. 校验全部 expected code 已存在；
2. 查当前映射；
3. 计算 added/removed；
4. 删除不再属于该系统角色的映射；
5. 创建缺失映射；
6. 输出差异；
7. 自定义角色绝不触碰。

但不能在第一刀直接开启“全角色自动删差异”。正确顺序：

```text
先做只读 drift check
→ 清点线上真实差异
→ 维护者确认
→ 再启用精确 reconcile
```

---

# 6. 角色分类终态

## 6.1 角色类型

```ts
type RoleKind = 'SYSTEM' | 'CUSTOM';

type PermissionManagementMode =
  | 'RELEASE_MANAGED'
  | 'ADMIN_EDITABLE';

type BindingManagementMode =
  | 'SYSTEM_ONLY'
  | 'MANUAL_ALLOWED'
  | 'POLICY_DERIVED';
```

## 6.2 当前 15 个内置角色建议

所有 `PROTECTED_ROLE_CODES`：

```text
kind = SYSTEM
permissionManagementMode = RELEASE_MANAGED
```

理由：

- 代码、seed、职位策略、活动责任投影、评审工作流依赖它们的稳定语义；
- 只禁止删除但允许随意改权限，仍会让系统行为漂移；
- 管理员有定制需求时，应创建自定义角色，而不是改写系统角色。

三个活动责任角色：

```text
activity-owner
activity-registration-collaborator
activity-attendance-collaborator
```

同时：

```text
bindingManagementMode = SYSTEM_ONLY
```

其他系统角色根据实际来源分别是：

```text
MANUAL_ALLOWED
POLICY_DERIVED
或二者并存
```

## 6.3 不必立即给 Role 表增加 kind 字段

首版可以由代码目录推导：

```ts
const roleDefinition = BUILTIN_ROLE_CATALOG.get(role.code);

kind = roleDefinition ? 'SYSTEM' : 'CUSTOM';
```

好处：

- 不需要为系统/自定义分类额外 migration；
- 不会出现 DB 字段被改成 CUSTOM 逃逸保护；
- 系统角色名单仍是代码真相。

## 6.4 自定义角色创建

不建议普通管理员手填技术 code。

新增一个 additive API：

```text
POST /api/system/v1/roles/custom
```

入参：

```json
{
  "displayName": "ICC 考勤审核员",
  "description": "负责信息指挥中心考勤单一级审核"
}
```

后端生成不可变 code，例如：

```text
custom-<cuid-short>
```

现有：

```text
POST /api/system/v1/roles
```

先保留兼容，后续仅 SUPER_ADMIN/迁移工具可用，Admin Web 不再调用。

---

# 7. 授予策略模型

## 7.1 为什么不能只分“普通/高风险”

需要同时回答：

1. 这个权限本身风险多高；
2. 哪类角色允许持有；
3. 哪类操作者可以修改这种映射。

因此 `riskLevel` 与 `grantPolicy` 必须分开。

## 7.2 建议四类 Grant Policy

### `CUSTOM_ROLE_ALLOWED`

普通业务能力。

非 SUPER_ADMIN 仍必须：

- 持 `rbac.role-permission.create/delete`；
- 是当前有效 GLOBAL `ops-admin`；
- 目标是可编辑的自定义角色；
- 通过所有 RoleDelegation 相关检查。

### `SUPER_ADMIN_ONLY`

只有 SUPER_ADMIN 能把该权限加入或移出角色。

适用于：

```text
rbac.*
role-binding.*
六条 reserved code
其他控制面权限
```

注意：当前代码允许 SUPER_ADMIN 将这些码授给角色。是否进一步收紧为“永远不允许角色持有”，属于新的安全决策，不能在本项目中偷偷改变。

本方案默认保持兼容：

```text
SUPER_ADMIN_ONLY = 只有 SA 能改映射
```

### `ROLE_ALLOWLIST_ONLY`

只有指定系统角色可以持有。

例如：

- 考勤终审类权限；
- 活动发布审核类权限；
- 活动责任工作流权限；
- 活动 owner/collaborator 专属权限。

即使 SUPER_ADMIN 也不能把它放进任意自定义角色，除非修改代码目录并发版。

### `SYSTEM_ROLE_ONLY`

只允许系统内置角色持有，且运行时 API 完全不可修改。

用于严格工作流投影角色。

## 7.3 现有安全谓词继续复用

当前：

```ts
isControlPlanePermissionCode(code)
```

已经合并：

```text
reserved six
rbac.*
role-binding.*
```

新 `RolePermissionMutationPolicy` 应复用这一谓词，不能另造第二份控制面清单。

---

# 8. RolePermission 写路径重构

## 8.1 新增统一策略

建议新建：

```text
src/modules/permissions/role-permission-mutation.policy.ts
```

职责：

```ts
assertActorMayEditRolePermissionSet(...)
assertTargetRoleEditable(...)
assertPermissionMayBeAdded(...)
assertPermissionMayBeRemoved(...)
evaluateDesiredPermissionSet(...)
```

不得把所有策略继续散在 `RolePermissionsService.assign()`。

## 8.2 统一写路径

现有：

```text
assign()
revoke()
```

最终都必须委托同一个内部原语：

```ts
replacePermissionSetInternal(...)
```

即使保留旧 API，也转换成：

```text
POST add:
currentCodes ∪ requestedCodes → replace

DELETE single:
currentCodes - targetCode → replace
```

这样：

- 系统角色锁；
- 控制面策略；
- revision；
- audit；
- 并发；
- no-op；
- 角色锁；

不会在多个入口漂移。

## 8.3 修复添加/撤销不对称

当前添加路径会阻止非 SA 添加控制面权限，但撤销路径没有对称守卫。

终态规则：

```text
任何对受控 Permission 的映射变化，无论增加还是移除，都由同一 grantPolicy 判断。
```

原因：

- 撤销 `rbac.role-permission.create` 可能破坏控制面；
- 撤销 ops-admin 核心权限可能造成运营锁死；
- 修改系统角色的业务权限会改变工作流边界；
- “撤权一定安全”是错误假设。

---

# 9. 新 API 设计

## 9.1 权限目录

```text
GET /api/system/v1/permissions/catalog
```

授权：

```text
rbac.permission.read
```

返回完整目录，不分页。236 条规模适合一次加载。

建议响应：

```ts
class PermissionCatalogResponseDto {
  catalogVersion: number;
  catalogHash: string;
  sections: PermissionCatalogSectionDto[];
}
```

```ts
class PermissionCatalogItemDto {
  code: string;
  displayName: string;
  businessDescription: string;
  technicalDescription?: string;

  module: string;
  action: string;
  resourceType: string;

  sectionCode: string;
  groupCode: string;
  sortOrder: number;

  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  riskTags: string[];
  grantPolicy: string;

  status: 'ACTIVE' | 'DEPRECATED' | 'INTERNAL';
  replacementCodes: string[];
  uiVisibility: string;
}
```

`catalogHash` 对目录对象 canonical JSON 做 SHA-256，供：

- 前端识别版本；
- preview/save 绑定版本；
- 审计记录；
- 排查“页面目录和后端版本不一致”。

## 9.2 获取角色当前权限集

在现有 Controller 上增加：

```text
GET /api/system/v1/roles/:id/permissions
```

当前该路径只有 POST，因此 GET 是 additive。

返回：

```json
{
  "role": {
    "id": "...",
    "code": "custom-xxx",
    "displayName": "ICC 考勤审核员",
    "kind": "CUSTOM",
    "permissionManagementMode": "ADMIN_EDITABLE",
    "bindingManagementMode": "MANUAL_ALLOWED"
  },
  "permissionRevision": 7,
  "permissionCodes": [
    "attendance.read.sheet",
    "attendance.approve.sheet"
  ],
  "editPolicy": {
    "canEdit": true,
    "readOnlyReason": null,
    "addBlocked": [],
    "removeBlocked": []
  },
  "catalogHash": "sha256:..."
}
```

对系统角色：

```json
{
  "editPolicy": {
    "canEdit": false,
    "readOnlyReason": "SYSTEM_ROLE_PERMISSION_SET_RELEASE_MANAGED"
  }
}
```

## 9.3 变更预览

```text
POST /api/system/v1/roles/:id/permissions/preview
```

入参：

```json
{
  "permissionCodes": [
    "attendance.read.sheet",
    "attendance.approve.sheet"
  ],
  "expectedRevision": 7,
  "catalogHash": "sha256:...",
  "reason": "调整 ICC 考勤审核职责"
}
```

规则：

- `permissionCodes` 允许空数组；
- 上限建议 500，覆盖当前 236 条和未来增长；
- 服务端排序、去重；
- code 不存在或不在 Catalog，preview 返回 blocking issue；
- preview 零写入；
- deny/blocked 作为 200 数据返回；
- 角色不存在、调用者未登录等仍走正常 BizCode。

响应：

```json
{
  "valid": true,
  "noOp": false,
  "currentRevision": 7,
  "expectedRevision": 7,
  "nextRevision": 8,
  "catalogHash": "sha256:...",

  "diff": {
    "added": [
      {
        "code": "attendance.approve.sheet",
        "displayName": "考勤一审通过",
        "riskLevel": "HIGH"
      }
    ],
    "removed": [],
    "unchangedCount": 1
  },

  "blockingIssues": [],
  "warnings": [
    {
      "type": "MASS_EFFECT",
      "message": "保存后，当前持有该角色的主体将在下一次请求立即获得新增能力。"
    }
  ],

  "impact": {
    "activeDirectBindingCount": 3,
    "activeDerivedGrantCount": 2,
    "estimatedAffectedUserCount": 5,
    "scopeBreakdown": {
      "GLOBAL": 0,
      "ORGANIZATION": 1,
      "ORGANIZATION_TREE": 4,
      "ACTIVITY": 0,
      "RESOURCE": 0,
      "SELF": 0
    },
    "sources": {
      "roleBinding": 3,
      "positionPolicy": 2,
      "supervision": 0
    }
  },

  "requiresStepUp": true
}
```

## 9.4 原子替换

```text
PUT /api/system/v1/roles/:id/permissions
```

入参与 preview 相同，增加 step-up proof 头或字段，遵循仓内现有 step-up 契约。

成功：

```json
{
  "roleId": "...",
  "permissionRevision": 8,
  "permissionCodes": [...],
  "diff": {...},
  "noOp": false,
  "catalogHash": "sha256:..."
}
```

---

# 10. 并发与事务设计

## 10.1 Schema

建议给 `RbacRole` 增加：

```prisma
permissionRevision Int @default(0)
```

建议列名用 `permissionRevision`，而不是泛化 `revision`：

- 角色名称/描述修改不必让权限编辑页冲突；
- 明确它只保护 RolePermission 集合；
- 避免未来其他配置共享一个模糊版本号。

可增加 DB CHECK：

```sql
ALTER TABLE "roles"
ADD CONSTRAINT "roles_permission_revision_nonnegative"
CHECK ("permissionRevision" >= 0);
```

## 10.2 Migration

additive migration：

```sql
ALTER TABLE "roles"
ADD COLUMN "permissionRevision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "roles"
ADD CONSTRAINT "roles_permission_revision_nonnegative"
CHECK ("permissionRevision" >= 0);
```

特点：

- 不需要业务回填；
- 既有角色全部 revision=0；
- 不改 RolePermission 数据；
- 可在非空库执行；
- 回滚只涉及删除新列，但正式上线后不建议回滚到不识别新契约的旧应用。

## 10.3 锁顺序

所有 RolePermission 写入口统一：

```text
1. 开事务
2. SELECT roles.id FOR UPDATE
3. 锁内重读角色、deletedAt、permissionRevision
4. 读取当前 RolePermission 集
5. 计算 desired/diff
6. 执行策略检查
7. deleteMany removed
8. createMany added
9. update roles.permissionRevision + 1
10. 写 audit
11. COMMIT
```

新建共享 helper：

```text
src/modules/permissions/rbac-role-lock.ts
```

示意：

```ts
export async function lockRbacRole(
  tx: Prisma.TransactionClient,
  roleId: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT "id"
    FROM "roles"
    WHERE "id" = ${roleId}
    FOR UPDATE
  `;
}
```

所有写入口，包括旧 assign/revoke，都必须走同一个锁。

## 10.4 revision 校验顺序

建议：

```text
先判断 desired 是否与 current 完全相同
→ 相同则 no-op 成功，不 bump revision
→ 不同才比较 expectedRevision
→ 不一致返回 revision conflict
```

好处：

- PUT 网络重试安全；
- 第一次已成功但响应丢失，客户端重发不会产生假冲突；
- 真正的陈旧写仍然被拦截。

## 10.5 并发用例

必须覆盖：

```text
A、B 同时从 revision=7 编辑

A:
desired = X
提交成功 → revision=8

B:
desired = Y
锁后发现 current revision=8
且 desired != current
→ 409 revision conflict
→ 零写入
```

还要覆盖：

```text
A 成功但客户端没收到响应
A 重试相同 desired + expectedRevision=7
锁后 desired == current
→ no-op 200
```

---

# 11. 角色权限变更影响预览

## 11.1 为什么必须做

RolePermission 是多对多配置，但修改效果不是只影响一行：

```text
角色增加一个权限
→ 所有直接 RoleBinding 主体下一请求生效
→ 所有职务 policy 推导主体下一请求生效
→ 分管推导主体下一请求生效
```

当前系统没有权限缓存，因此变更提交后其他实例下一请求即看到结果。

## 11.2 新增查询服务

```text
src/modules/permissions/role-permission-impact.query.service.ts
```

只读，禁止写数据库。

## 11.3 统计来源

### 直接 RoleBinding

按当前有效性谓词统计：

- ACTIVE；
- 未软删；
- startedAt <= now；
- endedAt null 或 >= now；
- role 未软删。

分别统计：

- USER；
- MEMBER；
- POSITION_ASSIGNMENT；
- SYSTEM；
- Scope breakdown。

### 职务推导

查询：

```text
OrganizationPositionRolePolicy.roleId = targetRoleId
```

再计算：

- 当前有效 policy；
- 当前有效 PositionAssignment；
- 对应 ACTIVE Member；
- 对应 ACTIVE/未软删 User；
- 去重 userId。

### 分管推导

当前 Authz 固定将有效分管推导为：

```text
org-supervisor
```

因此只有编辑 `org-supervisor` 时需要计算：

- 当前有效 SupervisionAssignment；
- supervisorMemberId 对应 ACTIVE User；
- 去重 userId。

## 11.4 输出“估算”还是“精确”

建议首版在能正确映射 User 的情况下输出：

```text
estimatedAffectedUserCount
```

同时返回：

```text
impactCompleteness: EXACT | PARTIAL
```

只有所有来源都能映射时才能标 EXACT。

不要为了显示一个好看的数字而把不确定结果写成事实。

---

# 12. Step-up 设计

## 12.1 触发条件

建议以下差异要求 step-up：

- 增加或移除 `CRITICAL` 权限；
- 涉及 `CONTROL_PLANE`；
- 涉及 `CREDENTIAL`；
- 涉及 `FINAL_APPROVAL`；
- 涉及 `LEDGER`；
- 修改 SUPER_ADMIN_ONLY 权限映射；
- 修改拥有大量当前有效绑定的角色，可先作为警告，阈值需业务拍板后再决定是否强制。

## 12.2 Proof 必须绑定具体变更

Proof 不能只证明：

```text
“刚刚做过一次二次验证”
```

它应绑定：

```text
action = RBAC_ROLE_PERMISSION_SET_REPLACE
roleId
expectedRevision
desiredPermissionCodesHash
catalogHash
```

避免：

- 为角色 A 申请的 proof 用到角色 B；
- 为低风险差异申请的 proof 换成高风险 payload；
- 目录版本改变后复用旧 proof；
- revision 变化后复用。

实际接入必须沿用 auth 模块现有 step-up 机制，新增 action/snapshot 属红区改动，应单独授权。

---

# 13. Permission CRUD 的终态

## 13.1 最终行为

```text
GET /permissions
```

可以保留为技术列表或兼容接口。

以下接口最终退出普通运营面：

```text
POST   /permissions
PATCH  /permissions/:id
DELETE /permissions/:id
```

因为 Permission 由版本 Catalog 定义。

## 13.2 不能一步删除

分阶段：

### 阶段 A

- 新增 Catalog；
- 旧 CRUD 保持；
- Admin Web 改走 Catalog；
- 记录调用情况。

### 阶段 B

- Catalog-owned Permission 的 POST/PATCH/DELETE 拒绝；
- 未知 legacy Permission 仅 SUPER_ADMIN 可清理；
- 返回新的明确 BizCode，例如 `PERMISSION_CATALOG_MANAGED`。

### 阶段 C

- 生产确认零调用；
- OpenAPI 标 deprecated；
- 前端零依赖；
- 再评审是否物理删除路由。

## 13.3 扩展模块的未来能力

未来外部模块如需注册权限，不应恢复“管理员随便创建字符串”，而应采用：

```text
Extension Permission Manifest
```

同样具备：

- code；
- 中文名；
- 风险；
- grantPolicy；
- 生命周期；
- 所属扩展版本。

本期不实现插件注册，但目录模型应预留：

```ts
source: 'CORE' | 'EXTENSION'
sourceModule?: string
```

---

# 14. 内置角色权限集锁

## 14.1 终态规则

所有 15 个 `PROTECTED_ROLE_CODES`：

```text
PermissionManagementMode = RELEASE_MANAGED
```

运行时 RolePermission API：

```text
任何身份，包括 SUPER_ADMIN，都不能修改其权限集。
```

原因：

- 系统角色语义必须由版本保证；
- SUPER_ADMIN 有身份短路，不需要通过运行时改系统角色救场；
- 临时需求可以创建自定义角色；
- 程序升级才能让 seed、文档、测试、角色映射一起变化。

## 14.2 角色名称和描述

建议首版：

- 系统角色 code：不可改；
- 系统角色 displayName：不可改；
- 系统角色 description：不可改；
- 自定义角色 displayName/description：可改。

否则管理员可能把：

```text
activity-owner
```

改显示成完全不同的业务含义，造成误判。

---

# 15. Scope 兼容策略

## 15.1 为什么不能首刀直接强校验

现有 236 条权限没有完整、显式的 scope 目录；历史角色和 RoleBinding 已运行在当前 Authz 语义下。

如果立即根据 code 名称猜测并阻止 Scope：

- 容易误伤合法历史绑定；
- 可能改变现有授权行为；
- 违反“不能凭印象改契约”。

## 15.2 两阶段策略

### 第一阶段：提示

Catalog 增加：

```ts
scopeProfile:
  | 'GLOBAL_ONLY'
  | 'RESOURCE_SCOPED'
  | 'SELF_ONLY'
  | 'MULTI_SCOPE'
  | 'UNREVIEWED'
```

RoleBinding preview 返回：

```text
WARNING:
该角色包含若干 GLOBAL_ONLY 权限，绑定到 ORGANIZATION_TREE 后这些权限可能不产生实际作用。
```

不阻断。

### 第二阶段：强校验

完成 236 条人工审计和 characterization 后，才在：

```text
RoleBindingsService.preview/create/update
```

加入明确的角色 Scope 兼容校验。

不能用“角色全部权限 scope 取交集”这种粗暴算法直接上线。应由系统角色目录/自定义角色 scope profile 明确决定。

---

# 16. Admin Web 页面设计

## 16.1 页面结构

```text
系统管理
├─ 权限目录
├─ 角色管理
├─ 角色绑定
└─ 权限诊断
```

## 16.2 权限目录页

只读。

顶部：

```text
搜索中文名称 / 权限码
业务分类
风险等级
只看敏感
只看系统控制面
只看已弃用
```

卡片：

```text
考勤终审通过                         [关键] [最终审核]

对考勤单执行最终审核。审核通过后，结果进入正式生效流程。

技术信息
attendance.final-approve.sheet
```

## 16.3 角色列表

系统角色：

```text
业务管理员
系统内置 · 版本管理
71 项权限
[查看]
```

自定义角色：

```text
ICC 考勤审核员
自定义角色
8 项权限 · 5 个当前有效主体
[编辑] [绑定] [复制] [删除]
```

## 16.4 角色权限编辑器

默认采用分组清单，不强行把所有权限塞成 CRUD 矩阵。

```text
活动与参与 / 考勤审核                         已选 2/6

☑ 查看考勤单
  查看活动考勤单及审核详情
  attendance.read.sheet

☑ 考勤一审通过                         [高风险]
  对待审核考勤单执行一级通过
  attendance.approve.sheet

☐ 考勤终审通过                         [关键] [限定角色]
  仅考勤终审角色可以持有
  attendance.final-approve.sheet
```

功能：

- 中文搜索；
- code 搜索；
- 按业务区分组；
- 只看已选；
- 只看本次变更；
- 风险筛选；
- 分组全选；
- 全选只作用于当前用户可授予项；
- 锁定项不被批量操作修改；
- 系统角色整页只读；
- 技术 code 默认折叠。

## 16.5 保存流程

```text
点击保存
→ POST preview
→ 展示新增/移除
→ 展示影响人数和范围
→ 展示风险
→ 如需则完成 step-up
→ PUT replace
→ 刷新 role permission set
```

确认弹窗示例：

```text
将修改角色：ICC 考勤审核员

新增 1 项：
+ 考勤一审通过 [高风险]

移除 2 项：
- 修改考勤单
- 删除考勤单

预计影响：
5 名当前有效用户
3 条直接角色绑定
2 条职务派生授权

保存后将在下一次请求立即生效。
```

## 16.6 并发冲突

收到 revision conflict：

```text
该角色已被其他管理员修改。

当前页面版本：7
服务器版本：8

[重新加载最新配置]
```

不提供“强制覆盖”按钮。

## 16.7 系统角色

```text
活动负责人
系统托管角色

权限集合由活动责任工作流和系统版本维护，不支持人工修改。
```

只能：

- 查看权限；
- 查看使用情况；
- 进入权限诊断。

---

# 17. 审计设计

## 17.1 新事件

建议新增：

```text
role-permission.replace
```

比同时写 grant/revoke 两条更完整。

若审核不允许新增事件，可暂时写两条，但最终推荐单一事务对应单一配置变更事件。

## 17.2 Audit Context

```json
{
  "requestId": "...",
  "ip": "...",
  "ua": "...",

  "before": {
    "permissionRevision": 7,
    "permissionCodes": ["..."]
  },

  "after": {
    "permissionRevision": 8,
    "permissionCodes": ["..."]
  },

  "extra": {
    "addedCodes": ["..."],
    "removedCodes": ["..."],
    "reason": "调整 ICC 审核职责",
    "catalogHash": "sha256:...",
    "affectedUserCount": 5,
    "stepUpAction": "RBAC_ROLE_PERMISSION_SET_REPLACE"
  }
}
```

权限码不是 PII，可以记录完整集合。

严禁在审计中加入：

- 用户密码；
- token；
- credential；
- 手机/证件号；
- proof 原文；
- SecretId/SecretKey；
- signed URL。

## 17.3 RolePermission.createdBy

新建映射时应填写：

```text
createdBy = actor.id
```

当前 `createMany` 未显式写该字段，应在新统一写路径补齐。

---

# 18. BizCode 设计

优先复用：

```text
PERMISSION_NOT_FOUND
ROLE_NOT_FOUND
ROLE_DELETED
RBAC_FORBIDDEN
PERMISSION_RESERVED_SUPER_ADMIN_ONLY
PROTECTED_ROLE_DELETE_FORBIDDEN
```

建议新增的语义：

```text
ROLE_PERMISSION_SET_IMMUTABLE
系统内置角色权限集合由版本维护，不允许人工修改

ROLE_PERMISSION_REVISION_CONFLICT
角色权限已被其他操作修改，请刷新后重试

ROLE_PERMISSION_CATALOG_MISMATCH
权限目录版本不一致，请刷新页面

ROLE_PERMISSION_POLICY_FORBIDDEN
该权限不能授予此角色

PERMISSION_CATALOG_MANAGED
权限点由系统版本管理，不允许在运行时创建、修改或删除
```

具体数字不得在设计稿里直接锁死。实施前必须：

```text
grep 当前 300xx/301xx 占用
核对 baseline 号段
更新 BizCode 计数与契约
```

---

# 19. 数据完整性与预检

## 19.1 新增只读命令

```text
pnpm rbac:catalog:check
```

职责：

```text
Catalog codes - DB codes
DB codes - Catalog codes
重复 code
缺 displayName
缺 businessDescription
缺 riskLevel
缺 grantPolicy
非法 group/section
DEPRECATED replacement 不存在
replacement 循环
系统角色映射漂移
自定义角色持有受限权限
系统角色被人工改写
```

模式：

```text
--static        只检查代码
--database      连接 DB 只读对照
--json          输出机器可读报告
--strict        有任何结构性漂移即非零退出
```

禁止该命令自动修复数据库。

## 19.2 上线前必须回答

```text
DB 是否存在 Catalog 外 Permission？
Catalog 是否存在 DB 缺失 Permission？
15 个系统角色当前映射是否和目录一致？
自定义角色是否持有 ROLE_ALLOWLIST_ONLY 权限？
是否存在系统角色权限被人工改过？
旧 Permission CRUD 是否仍有真实调用？
```

---

# 20. 测试方案

## 20.1 Catalog 单元测试

必须覆盖：

- 236 条 code 与 seed 事实闭包逐项相等；
- code 唯一；
- displayName 非空；
- businessDescription 非空；
- section/group 存在；
- sortOrder 确定；
- riskLevel 完整；
- grantPolicy 完整；
- allowlist role 全部存在；
- status=DEPRECATED 时 replacementCodes 非空；
- replacement 不形成环；
- INTERNAL/HIDDEN 权限不会进入普通自定义角色选择；
- reserved six 分类与当前 SoT 一致；
- `rbac.*`、`role-binding.*` 全部至少 SUPER_ADMIN_ONLY；
- 系统工作流权限全部有 allowlist/system role policy。

## 20.2 Role Catalog 单元测试

- 15 个 protected role 全部被 catalog 覆盖；
- 三个 system-managed role 的 binding mode 为 SYSTEM_ONLY；
- 所有系统角色 permission mode 为 RELEASE_MANAGED；
- 自定义角色推导不误判；
- 角色 code 不重复；
- 系统角色目录与 seed 实际角色集合一致。

## 20.3 Mutation Policy 单元测试

矩阵至少覆盖：

```text
Actor:
SUPER_ADMIN
current ops-admin
普通 ADMIN
普通 USER
DISABLED/软删 actor

Target:
系统角色
系统托管角色
普通自定义角色
特权自定义角色
软删角色

Permission:
普通
敏感
控制面
reserved
allowlist-only
system-only
deprecated
unknown

Operation:
add
remove
replace
no-op
```

## 20.4 E2E

### Catalog

- GET 未登录 401；
- USER 无码 30100；
- ops-admin 成功；
- 236 条完整返回；
- 中文名/分类/风险存在；
- catalogHash 稳定；
- 目录排序稳定。

### 系统角色

- 系统角色 GET 可看；
- POST add 拒绝；
- DELETE revoke 拒绝；
- PUT replace 拒绝；
- SUPER_ADMIN 同样拒绝；
- DB 零变化；
- audit 不写假成功。

### 自定义角色

- 创建不要求输入 code；
- 后端 code 唯一；
- 增加普通权限成功；
- 移除普通权限成功；
- 空集合成功；
- unknown code 整体拒绝；
- allowlist-only 拒绝；
- 非 SA 控制面 add/remove 对称拒绝；
- SA 控制面按当前兼容决策处理。

### 原子性

- added/removed 同事务；
- 中途异常全部回滚；
- audit 失败全部回滚；
- revision 只在真实变化时 +1；
- no-op 不 +1；
- RolePermission.createdBy 正确。

### 并发

- 两客户端同 revision 只一方成功；
- 另一方 409；
- 同 desired 重试 no-op 成功；
- legacy POST/DELETE 与 PUT 并发也受同一角色锁保护；
- 角色软删与权限修改并发不产生半状态。

### 影响预览

- direct USER binding；
- MEMBER binding；
- POSITION_ASSIGNMENT binding；
- position policy；
- supervision；
- 多来源同一用户去重；
- 过期/未来/ENDED/SUSPENDED/软删绑定排除；
- inactive org 按现有有效性口径处理。

### Authz 回归

- `RbacService.getUserPermissionCodes` 语义不变；
- SUPER_ADMIN 短路不变；
- `.self` ownership 不变；
- `authz-rbac-equivalence` 全绿；
- position/supervision/direct grants 行为不变；
- RolePermission 变更后下一请求立即收敛。

## 20.5 现有检查

每个跨权限 PR 至少运行：

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm test:contract
pnpm test:e2e
pnpm docs:openapi:check
pnpm docs:feclient:check
pnpm docs:rbacmap:check
pnpm docs:authz:check
pnpm gate:authz:semantic
pnpm gate:authz:graph:check
pnpm agent:check:full
```

涉及 schema/migration/seed：

- 干净库从零重放；
- 非空库 migration；
- seed 连跑两次；
- seed 前后自定义角色零变化；
- system role exact mapping drift report；
- contract snapshot 逐行解释。

---

# 21. 分批实施计划

## Goal/PR 0：决策锁与目录审计

性质：

```text
设计/文档，不改运行行为
```

产出：

- 本方案冻结版；
- 236 条权限人工目录清单；
- 15 个系统角色分类；
- grantPolicy 拍板；
- reserved six 是否允许 SA 授给角色的明确决策；
- Scope 首版只提示还是强校验；
- step-up action 拍板；
- 旧 CRUD 退役时间线。

DoD：

- 每条权限都有中文名、说明、分类、风险、授予策略；
- 没有“以后再说”的未分类 active 权限；
- 所有决策有维护者签字/Issue/Goal 记录。

---

## PR 1：Permission Catalog 单一事实源

目标：

```text
只重构事实位置，不改 API 行为，不改角色映射。
```

写集：

```text
src/modules/permissions/permission-catalog*
src/modules/permissions/rbac-seed-facts.ts
prisma/seed.ts
scripts/*rbac*
scripts/docs-counts.ts
相关 selftest / unit
docs/ai-harness/RBAC_MAP.md 生成段
```

关键措施：

- 236 code 集合前后完全一致；
- seed 角色映射前后完全一致；
- Permission 表数量一致；
- RolePermission 映射集合一致；
- 所有代码保持 literal shape；
- 不启用 exact cleanup；
- 不改 endpoint。

DoD：

```text
beforeCodes == afterCodes
beforeBuiltinRoleMappings == afterBuiltinRoleMappings
docs:rbacmap:check PASS
seed 二跑幂等
```

---

## PR 2：Catalog 只读 API 与角色分类

目标：

- 新增 `/permissions/catalog`；
- 角色响应增加 additive：
  - kind；
  - permissionManagementMode；
  - bindingManagementMode；
- 现有接口 wire 不删不改；
- Admin Web 可开始接入目录。

写集：

```text
permissions.dto/controller/service/module
rbac-roles.dto/service/select
permission-catalog presenter/service
OpenAPI contract
docs/handoff/admin-web.md
```

DoD：

- 目录中文可用；
- 系统角色只读状态可被前端识别；
- 旧前端不受影响。

---

## PR 3：控制面安全收口

目标：

- 新建 `RolePermissionMutationPolicy`；
- 15 个系统角色运行时权限集只读；
- assign/revoke 策略对称；
- 系统托管角色权限不可改；
- Catalog-owned Permission 禁止运行时增删改；
- 旧 API 继续存在但走新策略。

这是安全行为变更，必须有明确评审。

DoD：

- ops-admin 不能破坏系统角色；
- 非 SA 不能通过撤销路径操作控制面映射；
- Permission 不能再被物理删除破坏控制面；
- 现有正常自定义角色授权仍可用；
- 全量 RBAC/seed/authz 回归通过。

---

## PR 4：permissionRevision + 原子 PUT

目标：

- additive migration；
- GET permission set；
- preview；
- PUT replace；
- 角色行锁；
- no-op；
- revision conflict；
- 统一 audit；
- 旧 POST/DELETE 内部改走 replace 原语。

DoD：

- 不存在部分提交；
- 并发覆盖被阻断；
- 网络重试安全；
- audit 与写同事务；
- 旧 endpoint contract 保留。

---

## PR 5：影响预览与 Step-up

目标：

- direct/position/supervision 影响统计；
- 高风险变更 step-up；
- proof 绑定 payload hash；
- 前端确认信息完整。

DoD：

- 影响数有明确 exact/partial；
- step-up proof 不能跨角色/跨 revision/跨 payload 复用；
- 低风险普通变更不被无意义加重。

---

## PR 6：Scope 兼容提示

目标：

- Catalog scopeProfile；
- RoleBinding preview 返回 warning；
- 不改现有 allow/deny。

DoD：

- 历史绑定行为零变化；
- UI 能提示“该角色绑定在这个范围可能无效”。

强制拦截另立 PR，需完成 236 条 scope characterization 后再做。

---

## PR 7：Admin Web 完整接入

目标：

- 权限目录页；
- 角色列表分类；
- 系统角色只读详情；
- 自定义角色创建；
- 权限编辑器；
- preview/confirm/step-up/PUT；
- revision conflict；
- 角色使用情况；
- explain 入口。

DoD：

- 普通管理员无需理解英文 code；
- 不可授予项提前置灰且给出原因；
- 保存前看到差异和影响；
- 系统角色无编辑入口；
- 旧增删调用归零。

---

## PR 8：旧接口退役

前提：

- 生产访问日志确认零调用；
- 前端已切；
- OpenAPI 已 deprecated 至少一个发布周期；
- 无外部调用方依赖；
- 回滚方案通过。

目标：

- 删除或永久封闭 Permission 写 CRUD；
- 删除 RolePermission 增量旧写接口，或保留为内部兼容；
- 清理废弃 DTO/BizCode/测试；
- 更新 contract。

这是对外契约破坏，必须单独发版。

---

# 22. 文件级改动矩阵

| 文件/目录 | 计划 |
|---|---|
| `prisma/schema.prisma` | 给 `RbacRole` 增加 `permissionRevision` |
| `prisma/migrations/*` | additive migration + 非负 CHECK |
| `prisma/seed.ts` | Permission 定义改为消费 Catalog；后续内置角色精确 reconcile |
| `src/modules/permissions/permission-catalog.ts` | 新增 236 条完整目录 |
| `src/modules/permissions/permission-catalog.types.ts` | 目录类型与枚举 |
| `src/modules/permissions/permission-catalog.sections.ts` | 业务分类 |
| `src/modules/permissions/permission-catalog.integrity.ts` | 完整性校验 |
| `src/modules/permissions/builtin-role-catalog.ts` | 15 个系统角色终态元数据 |
| `src/modules/permissions/rbac-seed-facts.ts` | 兼容聚合层 |
| `permissions.dto.ts` | 新 Catalog DTO；旧 DTO 保留 |
| `permissions.controller.ts` | 新增 catalog 只读端点；旧写端点逐阶段封闭 |
| `permissions.service.ts` | Catalog-owned 写保护 |
| `permissions.select.ts` | 继续只负责 Prisma DB 字段，不混入静态元数据 |
| `rbac-roles.dto.ts` | additive kind/managementMode/permissionRevision |
| `rbac-roles.service.ts` | 角色分类、custom create、系统角色更新锁 |
| `role-permissions.dto.ts` | GET/preview/PUT DTO |
| `role-permissions.controller.ts` | 新增 GET/preview/PUT |
| `role-permissions.service.ts` | 统一 replace 原语 |
| `role-permission-mutation.policy.ts` | 新增安全策略 |
| `role-permission-impact.query.service.ts` | 新增影响查询 |
| `rbac-role-lock.ts` | 新增角色行锁 |
| `protected-role-codes.ts` | 最终从 BuiltinRoleCatalog 派生/兼容导出 |
| `system-managed-role-codes.ts` | 最终从 BuiltinRoleCatalog 派生/兼容导出 |
| `role-delegation.policy.ts` | 复用目录策略，不复制控制面清单 |
| `role-bindings.service.ts` | 后续 scope compatibility warning/check |
| `audit-logs.types.ts` | 新增或明确复用角色权限集变更事件 |
| `biz-code.constant.ts` | 新增 immutable/revision/catalog policy 等语义 |
| `scripts/generate-rbac-map.ts` | 权限事实闭包改读 Catalog |
| `scripts/check-rbac-map.ts` | 同步闭包与目录完整性检查 |
| `scripts/docs-counts.ts` | 计数改读 Catalog |
| `scripts/permission-catalog-check.ts` | 新增静态/DB 预检 |
| `test/e2e/role-permissions.e2e-spec.ts` | 扩展原子、并发、系统角色锁 |
| `test/e2e/seed-rbac*.spec.ts` | 目录/角色映射漂移哨兵 |
| `test/e2e/authz-rbac-equivalence.e2e-spec.ts` | 行为不变 characterization |
| `docs/ai-harness/RBAC_MAP.md` | 生成物更新 |
| `docs/handoff/admin-web.md` | 前端契约与页面任务图 |
| `docs/current-state.md` | 仅按当前仓规则登记真实能力/债务，不写机器可查细节 |

---

# 23. 发布与回滚

## 23.1 发布顺序

```text
1. Catalog 事实源
2. Catalog 只读 API
3. 前端只读展示
4. 安全策略收口
5. permissionRevision migration
6. preview/PUT
7. 前端编辑器切换
8. 观察旧接口调用
9. 旧接口退役
```

## 23.2 不能反过来

不能先：

```text
删除旧 API
→ 再让前端适配
```

也不能：

```text
先让系统角色只读
→ 却没有自定义角色可用编辑器
```

## 23.3 回滚边界

Catalog API 和 additive DTO 可安全回滚。

一旦：

- 系统角色权限映射发生版本变更；
- 新 PUT 已改写角色权限；
- permissionRevision 被新客户端依赖；
- 旧写接口被删除；

就不能简单回滚到旧二进制。必须确保旧版本仍能容忍新列和新映射，或按 runbook 明确停止写入后回滚。

---

# 24. 最终验收标准

## 24.1 人类可用性

- 管理员默认只看中文名；
- 技术 code 可展开查看；
- 236 条 active 权限全部有中文名和业务说明；
- 权限按业务任务分类；
- 搜索中文即可找到；
- 高风险/敏感/控制面清晰标识；
- 不可授予项明确说明原因。

## 24.2 安全

- Permission 不能被普通运行时 CRUD 破坏；
- 15 个系统角色权限集只读；
- 三个系统托管角色绑定继续只由业务投影维护；
- 添加与撤销使用同一策略；
- 非 SA 不能操作控制面映射；
- allowlist 权限不能进入任意自定义角色；
- 实际 PUT 重做全部校验；
- 前端不是安全边界。

## 24.3 正确性

- 全量替换单事务；
- 并发编辑不会静默覆盖；
- no-op 重试安全；
- audit 与配置同事务；
- 多实例下一请求收敛；
- GLOBAL/scoped Authz 现有语义不变；
- RoleBinding 既有任期/范围不变量不变。

## 24.4 可运维性

- 修改前有 diff；
- 修改前有影响预览；
- 有 catalogHash；
- 有 revision；
- 有完整审计；
- 有权限诊断入口；
- 有 Catalog/DB drift 检查；
- 内置角色映射可以被精确验证。

---

# 25. 必须由维护者明确拍板的事项

## 决策 1：15 个系统角色是否全部权限集只读

推荐：

```text
是。
```

定制需求全部通过自定义角色解决。

## 决策 2：六条 reserved code 是否允许 SUPER_ADMIN 授给角色

当前代码允许 SA 操作。

两个选项：

```text
A. 保持兼容：SA 可以授予，必须 step-up + 关键风险提示
B. 收紧终态：任何角色都不能持有，只允许 SA 身份短路
```

本方案不替维护者擅自拍板，默认按 A 兼容实施。

## 决策 3：Permission 写 CRUD 退役节奏

推荐：

```text
先 deprecated 一个发布周期
→ 调用归零
→ 再 contract 删除
```

## 决策 4：Scope 首版是否只告警

推荐：

```text
先告警，不阻断。
```

完成 236 条 scope 人工审计和行为 characterization 后再强校验。

## 决策 5：高风险角色权限变更是否强制 step-up

推荐：

```text
CRITICAL / CONTROL_PLANE / CREDENTIAL / FINAL_APPROVAL 强制。
```

## 决策 6：自定义角色 code 是否完全由后端生成

推荐：

```text
普通管理员不填写；后端生成。
```

---

# 26. 最优实施优先级

从安全和价值排序：

```text
第一优先：
Permission Catalog 单一真相
系统角色权限集只读
Permission 运行时写保护
RolePermission add/remove 策略对称

第二优先：
原子 PUT
revision
审计 diff
并发保护

第三优先：
影响预览
step-up
Admin Web 完整编辑器

第四优先：
scope compatibility
旧 API contract 清理
扩展模块 manifest
```

只做中文展示而不做第一优先级，会让“更好用的后台”反而更容易把现有控制面改坏。

---

# 27. 本次未做

本文件只完成：

- 现状研究；
- 终态设计；
- API/数据/并发/审计/前端方案；
- 分批实施计划；
- 验收标准。

本次没有：

- 修改仓库代码；
- 新建 migration；
- 改 Permission seed；
- 改角色权限映射；
- 改 OpenAPI；
- 改 Admin Web；
- 执行生产数据库预检；
- 运行测试。

正式开工前，必须按仓库规则建立 Goal，明确红区授权、决策锁、写集和探针队列。

---

# 附录 A：备选方案与否决理由

## A.1 只在前端维护中文映射

方案：

```ts
const labels = {
  'activity.publish.record': '发布活动',
};
```

否决理由：

- 后端新增权限后前端不会自动知道；
- 多个前端会各自复制一份；
- 风险、授予策略和生命周期无法成为后端安全真相；
- 前端文案可以被绕过，不能承担授权边界；
- 无法给 seed、脚本、审计和扩展模块共同消费。

可接受用途：

- 仅作为短期热修；
- 不应成为终态。

## A.2 只给 Permission 表增加 displayName

优点：

- 改动小；
- API 直接返回；
- 前端容易接。

否决为终态的理由：

- 管理员仍能在数据库/CRUD 中改变安全语义；
- 多环境可能漂移；
- 风险、allowlist、system-only 等策略仍无代码真相；
- seed 当前 `update: {}` 不能保证文案和元数据更新；
- Permission 是代码合同，不应成为普通运营配置。

可接受用途：

- 可以把 DB 字段作为只读镜像；
- 但权威源仍必须是代码 Catalog。

## A.3 根据 code 自动翻译

例如：

```text
attendance.final-approve.sheet
→ attendance=考勤
→ final-approve=终审通过
→ sheet=单据
```

否决理由：

- 同一 action 在不同业务域含义不同；
- 无法表达业务后果；
- 无法表达敏感数据、账本、凭证等风险；
- 无法表达限定角色；
- 会把错误的自动翻译包装成官方语义。

自动拆词只能作为开发辅助，不得直接成为管理员文案。

## A.4 直接显示现有 description

否决理由：

当前 description 大量包含：

- 状态机代码；
- 评审稿编号；
- 历史决策；
- seed 绑定说明；
- 技术实现细节。

它适合开发者排查，不适合作为权限名称。

正确做法是分开：

```text
displayName
businessDescription
technicalDescription
```

## A.5 把菜单权限和 API 权限合并

否决理由：

- 菜单可见不等于后端允许；
- 一个页面可能调用多个 Permission；
- 一个 Permission 可能被多个页面/自动任务使用；
- App capability 已经和 raw Permission 有明确边界；
- 菜单配置不能替代 Service 层判权。

终态继续保持：

```text
前端菜单/按钮 = 产品投影
Permission = 后端安全合同
```

---

# 附录 B：主要风险登记

| 风险 | 后果 | 缓解措施 |
|---|---|---|
| 236 条目录迁移漏码 | endpoint 引用的 code 未注册 | code 集合前后精确对拍；RBAC_MAP/check/counts 同步 |
| 系统角色权限集冻结后运营无法临时调整 | 业务受阻 | 自定义角色；SA 紧急流程；系统角色变更走版本发布 |
| Catalog 与 DB 漂移 | UI 与实际 RolePermission 不一致 | `rbac:catalog:check --database --strict`；上线前硬门 |
| exact reconcile 误删历史映射 | 权限突降 | 第一阶段只 dry-run；人工确认差异；再启用写入 |
| impact 查询过重 | 编辑页慢 | 只在 preview 执行；批量查询；不做页面实时轮询 |
| 前后端 Catalog 版本不一致 | 选择过期权限 | catalogHash；PUT 校验；不一致要求刷新 |
| 旧 POST/DELETE 与新 PUT 并发 | 权限集被覆盖 | 所有入口共用角色行锁和 revision |
| Scope 元数据判断错误 | 合法绑定被拒 | 第一阶段只 warning；characterization 完成后再阻断 |
| 非 SA 通过撤销破坏控制面 | ops-admin/系统角色失能 | add/remove 对称 MutationPolicy；系统角色只读 |
| Permission 物理删除 | RolePermission Cascade、控制面断裂 | Catalog-owned Permission 写保护；逐步退役 CRUD |
| 高风险权限误勾选 | 敏感数据或终审能力扩散 | 显式风险标签、影响预览、step-up、审计 |
| 预览后数据变化 | 预览结论失效 | PUT 事务内重算；expectedRevision；preview 不作证明 |
| 自定义角色混入工作流专属权限 | 绕过责任/审核模型 | ROLE_ALLOWLIST_ONLY / SYSTEM_ROLE_ONLY |
| 系统角色 label 被改写 | 管理员误解真实职责 | 系统角色 code/name/description 全部版本管理 |

---

# 附录 C：实际代码证据索引

本方案基于以下实际文件和符号，而不是抽象设想：

| 事实 | 代码证据 |
|---|---|
| Permission 只有 code/module/action/resourceType/description | `prisma/schema.prisma` → `model Permission` |
| Permission 可创建、改 description、物理删除 | `src/modules/permissions/permissions.service.ts` → `create/update/delete` |
| Permission DTO 没有 displayName/风险/分类 | `src/modules/permissions/permissions.dto.ts` → `PermissionResponseDto` |
| Role detail 已返回完整 permissions | `src/modules/permissions/rbac-roles.service.ts` → `findOne` |
| RolePermission 目前是批量 add + 单条 delete | `role-permissions.controller.ts/service.ts` |
| add 有控制面分级，delete 未走同一策略 | `RolePermissionsService.assign/revoke` |
| 15 个角色只有 API 删除保护 | `protected-role-codes.ts` |
| 三个活动责任角色绑定由系统托管 | `system-managed-role-codes.ts` |
| 控制面单一谓词包含 reserved + rbac.* + role-binding.* | `role-delegation.policy.ts` |
| 六条 reserved code 来自单一事实源 | `reserved-super-admin-permission-codes.ts`、`rbac-seed-facts.ts` |
| RbacService 只读有效 USER×GLOBAL RoleBinding | `rbac.service.ts`、`role-binding-validity.ts` |
| scoped Authz 聚合 direct/position/supervision | `src/modules/authz/authz.service.ts` |
| explain 返回 matchedGrant 与 scope | `authz.controller.ts`、`authz.dto.ts` |
| RoleBinding 已有 preview 范式 | `role-bindings.controller.ts/dto.ts/service.ts` |
| 配置审计要求同事务 | `config-audit.util.ts` |
| Permission/Role/seed/schema 属红区或高风险变更 | `AGENTS.md`、`docs/current-state.md` |
| 权限码计数和地图由脚本派生 | `generate-rbac-map.ts`、`check-rbac-map.ts`、`RBAC_MAP.md` |

---

# 附录 D：开工前 Goal 建议模板

## Goal 名称

```text
RBAC 权限目录与角色权限管理终态升级
```

## DoD

```text
1. Permission Catalog 覆盖全部现有 code，前后集合零漂移；
2. 系统角色权限集由版本管理，运行时不可人工修改；
3. 自定义角色支持中文可视化配置；
4. 角色权限集支持 preview + 原子 replace + revision；
5. 高风险变更有影响预览、step-up 和完整审计；
6. RbacService/AuthzService 判权语义零漂移；
7. Admin Web 不再要求管理员理解权限码；
8. 旧接口按兼容周期退役。
```

## 探针队列

```text
P1 code-set exact equality
P2 built-in role mapping equality
P3 permission catalog static integrity
P4 add/remove policy symmetry
P5 system role immutable matrix
P6 atomic rollback
P7 concurrent revision conflict
P8 no-op retry
P9 audit atomicity
P10 direct/position/supervision impact
P11 authz-rbac equivalence
P12 clean DB migration replay
P13 non-empty DB migration
P14 seed second-run idempotency
P15 OpenAPI/FE client/RBAC map/authz manifest
```

## 主要禁止域

```text
不改业务模块实际判权语义
不把 scope 塞进 permission code
不引入缓存/Redis/queue
不把前端置灰当安全边界
不自动清理未知 Permission
不自动改写自定义角色
不在同一 PR 删除旧 API
不在未审计完成前强制 Scope compatibility
```

## 建议写集分割

```text
Lane A：Catalog/seed/scripts/静态测试
Lane B：Permission/Role API 与 DTO
Lane C：RolePermission mutation/revision/audit

Schema-touching lane 同时只能一条；最终串行集成。
```
