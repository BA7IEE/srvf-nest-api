# 组织职务 + 分管关系 + scoped RBAC + 统一鉴权 — 终态架构评审稿

> 状态:**T0 冻结稿(frozen review)**。本文不写实现代码,只定终态架构与落地路径。
> 立项:2026-07-01 goal「结合现有代码,设计组织职务 + 分管关系 + scoped RBAC + 统一鉴权的终态架构」。
> 仓库实况:HEAD = origin/main = `fe4da85a`(v0.33.0),0 open PR,worktree fresh。
> 依据:真实任命公告《深圳市公益救援志愿者联合会 2026 年任命公告》(任期 2026-07-01 ~ 2027-06-30)。
> 权威源对齐:本稿一旦被采纳,需把它对 `AGENTS.md §8 / §19.7`、`docs/current-state.md §3`、`docs/ai-harness/RBAC_MAP.md §5/§6`、`docs/participation-bounded-context.md`、schema `MemberDepartment` 注释中"单部门 / 无任期 / 无职务"旧约束的废弃,在同一批 PR 内同步落账。
>
> 修订记录:**2026-07-01 v2** —— 经《2026 任命公告》全量反推验证(§12),采纳 R1–R8 并**折回正文** §2.2 / §2.3 / §3.0.1 / §3.2 / §3.3 / §3.4 / §3.7 / §5.2 / §8.3 / §8.4 / §10 / §11。最关键为 **R5 安全红线(副职不自动推导管理角色)**。
>
> 修订记录:**2026-07-01 v3** —— 4 个开放问题维护者拍板,写入 **§2.4「业务拍板结论」** 并贯穿 §5/§6/§8/§10/§11:**BD-1** 队长@root = 全组织业务管理(≠ SUPER_ADMIN);**BD-2** 终审中枢默认 APD 但由 `RoleBinding` 配置、绝不 hardcode;**BD-3** 分管 `org-supervisor` 只读码集定稿;**BD-4** 组长主归属落队/部/中心级、不强制组级。
>
> **归档戳:已全量落地:PR1–PR12 + v0.34.0 + 摘码微刀 #482,2026-07-03 归档;实现以 src/prisma 为准。**

---

## 0. 阅读指引(本稿与现状的关系)

- **这不是最小改动方案。** 按 goal 要求,只求长期正确、与真实组织一致、与现有代码兼容。
- **现有 RBAC 不被推翻。** `Permission / RbacRole / RolePermission` 全保留;`UserRole` 升级为 `RoleBinding` 的 `global` scope 特例;`RbacService.can()` 仍是底层判权,只是被 `AuthzService` 包住。
- **早期"一人一部门、无任期、无跨部门角色"被显式废弃。** 这些约束写在 schema `MemberDepartment` 注释(D-1)、`docs/participation-bounded-context.md:105`、`docs/handoff/admin-web.md:136`,**不在 `AGENTS.md` 铁律里**,因此可以在本 goal 授权下解除,不触动 `AGENTS.md` 永久红线。
- **本稿全程 D 档。** 任何改 `Role` enum / `Permission` seed / `RolePermission` / schema / migration 的动作都按 `docs/process.md §4` D 档降速,逐 PR 与维护者对齐(RBAC_MAP §6 rule 1)。

---

## 1. 当前代码亲核结论 [A]

> 每条结论均来自本次对 `prisma/schema.prisma`、`src/modules/{permissions,attendances,organizations,member-departments}`、`prisma/seed.ts`、`docs/*`、git history 的逐文件亲核。

### 1.1 Organization — 已能表达组织树,但只是邻接表,且实际被压成两层

| 维度 | 现状 | 终态可复用性 |
|---|---|---|
| 树结构 | `parentId` 自关联(`schema.prisma:165,173-174`,relation `"OrganizationTree"`,`onDelete: Restrict`)= **邻接表** | ✅ 可复用;树语义已在 |
| 路径/闭包/层级 | **无** `path` / `level` / closure 表 / materialized path(全模块 grep `recursive|closure|ancestor|descendant` 为空) | ❌ 缺口:scoped tree 判定需要补 closure |
| 节点类别 | `nodeTypeCode: String`(非 FK,指向 `node_type` 字典 8 值:`headquarters` / `professional-{mountain,water,urban,high}` / `rescue-team` / `functional-dept` / `volunteer`) | ✅ 复用;只需扩 `group` 一值,筹备组用 `establishmentStatusCode` 状态列表达(R1,非新 nodeType) |
| 重挂父级 | **不支持**:`UpdateOrganizationDto` 无 `parentId` 字段,创建后父级不可变(`organizations.service.ts:281-313`);`ORGANIZATION_PARENT_CYCLE`(`biz-code.constant.ts:330`)、`ORGANIZATION_PARENT_CHANGE_FORBIDDEN`(`:335`)**已声明但从未抛出**(死码,Swagger 占位) | ⚠️ 缺口:组级落位/调整需要 reparent,死 BizCode 正好预留 |
| 单根 | 硬上限:`assertNoExistingRoot`(`service.ts:136-141`)只允许一个根 | ✅ 保留 |
| 软删护栏 | `HAS_CHILDREN` / `HAS_MEMBERS` / `LAST_ROOT_ORGANIZATION_PROTECTED`(`service.ts:344-367`) | ✅ 保留 |
| seed | 1 根 `SRVF`(深圳公益救援队,`headquarters`)+ 15 部门全挂根 = **扁平两层**(`seed.ts:676-723`) | ✅ 复用;组级在其下加挂 |

**结论:Organization 已是合格的"组织节点表",但(a)缺高效上下级判定结构(closure),(b)实际只用了两层,(c)父级不可变。终态要补 closure + reparent + 组级节点类型,其余复用。**

### 1.2 Member — 无直接部门指针,归属只走 MemberDepartment

`Member`(`schema.prisma:197-247`):`id / memberNo(@unique) / displayName / gradeCode?(member_grade 字典)/ status / 软删`。**无 `primaryOrganizationId` / `organizationId` / `departmentId`**;部门归属唯一通过 `memberDepartments` 反向关系。`User.memberId @unique`(FK 在 User 侧,`onDelete: SetNull`)是 User↔Member 唯一链。`gradeCode`(级别,如 `volunteer` / `level-1`)≠ 职务,二者正交。

**结论:Member 干净,不需要塞业务字段;终态的"主归属"由新 Membership 表的 `PRIMARY` 行表达,不在 Member 上加列。**

### 1.3 MemberDepartment — 裸归属,无任期/主兼任/职务,单归属靠手写 partial unique

`MemberDepartment`(`schema.prisma:256-271`):`{ id, memberId, organizationId, createdAt, updatedAt, deletedAt }` + 两个 `onDelete: Restrict` FK。**无职务、无 startedAt/endedAt、无主/兼任 flag、无行级 status**——且 DTO 显式列了"绝对禁止字段"(`member-departments.dto.ts:8-12`:`isPrimary` / `joinedAt`/`endedAt` / 进出原因 / 跨部门角色等级)。单归属由 migration 末尾手写 partial unique 实现:

```sql
-- 20260507181930_v2_foundation/migration.sql:198-200
CREATE UNIQUE INDEX "MemberDepartment_memberId_active_key"
  ON "MemberDepartment"("memberId") WHERE "deletedAt" IS NULL;
```

`set`(`service.ts:106-154`)= reassign-replaces(改部门 = 软删旧行 + 建新行,同 org 幂等不变)。

**结论:MemberDepartment 是"一人一部门、无任期、无职务"旧约束的物理载体。终态必须升级为 `MemberOrganizationMembership`(主/兼/临时/支援 + 任期 + 状态),旧 partial unique 收窄为"一人至多一个 active PRIMARY"。**

### 1.4 RBAC(RbacRole / Permission / RolePermission / UserRole)— 收口完成,但纯全局、零 scope

- **已收口到 service 层 `rbac.can()`(单轨):** 全仓活跃 `@Roles` = 0(Slow-4 收口 #314-#318);controller 仅挂全局 `JwtAuthGuard`,判权全在 service `rbac.can()`,失败抛 `RBAC_FORBIDDEN(30100)`。`RbacService.can()` 是唯一判权出口。
- **`can()` 签名:** `can(user: CurrentUserPayload, action: string, resource?: RbacResource): Promise<boolean>`(`rbac.service.ts:110`)。`RbacResource = { ownerType?: 'user'|'member'; ownerId? }`(`:43-46`)——**仅供 `.self` ownership,完全没有 organization/scope 维度。**
- **判权逻辑** `judge()`(`:116-149`):① `user.role === SUPER_ADMIN` 短路 allow;② 权限码 `Set` 成员判定(无通配/无前缀层级);③ `action.endsWith('.self')` 时 `checkOwnership`(`ownerId === user.id` 或 `=== user.memberId`)。ADMIN 不特判(经 seed 绑 `biz-admin` 继承)。
- **`UserRole`(`schema.prisma:881-896`):** `{ userId, roleId, createdBy }`,`@@unique([userId, roleId])`,**无 scope/organizationId,无 deletedAt**。一次授予即全局生效。
- **Permission.code = `<module>.<action>.<resource_type>`(`schema.prisma:848`)** = "做什么",**不表达"在哪做"**。唯一带"scope 后缀"的是 16 个 `attachment.*.{member,certificate}.{self,other}`(4 段),`.self`/`.other` 是 ownership 不是 org-scope。
- **身份注入:** JWT payload 极简 `{ sub, username }`(`jwt.strategy.ts:14-17`),每请求查库得 `CurrentUserPayload = { id, username, role, status, memberId }`——**无 organizationId / 无 scope**。
- **缓存:** `RbacCacheService` 按 `userId` 缓存权限码集合(TTL 1800s),非 scope-aware。

**结论:判权出口已收口(终态 `AuthzService` 有干净的单一接入点),但 scope 维度为零。`UserRole` 天然就是 `RoleBinding(scopeType=global)` 的特例,可平滑升级。Permission code 已经是"做什么"的正确形态,不要动它的命名,scope 放到 RoleBinding。**

### 1.5 Attendance 终审 — 业务说"APD 部长/副部长",实现是纯全局管理权限,且无职责分离

- `AttendanceSheet`(`schema.prisma:602-639`):`activityId`(NOT NULL)/ `submitterUserId`(NOT NULL)/ `reviewerUserId?`(一级)/ `finalReviewerUserId?`(终审)/ `statusCode`。状态 5 态(`attendances.dto.ts:49-55`):`pending → pending_final_review → approved`(终审通过,贡献值生效)/ `rejected` / `final_rejected`。
- `finalApprove()`(`attendances.service.ts:1104-1193`):只查 `rbac.can(user, 'attendance.final-approve.sheet')`(`:1110`)+ 状态机 `pending_final_review → approved`。**写 `finalReviewerUserId = currentUser.id` 仅作审计。**
- **自审护栏不存在:** 全 service 无 `currentUser.id` vs `submitterUserId`/`reviewerUserId` 比较。一个持 `biz-admin` 的 ADMIN 可 submit→approve→final-approve **同一张表全程独走**。一级审批人与终审人**可同人**,无任何分离规则。
- **零组织 scope:** 四个审批方法从不加载 Activity;`Sheet→Activity→organizationId` 链**物理存在但只在 `reviewDetail()`(`:726-738`)展示用**,从不进授权。
- 四码(`attendance.{approve,reject,final-approve,final-reject}.sheet`)全绑 `biz-admin` → 每个 ADMIN 都能终审任意部门的表。代码注释多处自述缺口(`service.ts:65-66`:"终审业务角色为 'APD 部门部长/副部长',当前实装权限仍沿用管理权限")。
- 审计:`AttendanceAuditRecorder.logFinalReview()`,event `attendance-sheet.final-review`,`extra.operation='final-review'`,`extra.action='final-approve'|'final-reject'`。
- 终审通过后:提交后事务外 fire-and-forget 调 `NotificationDispatcher.dispatchTargeted`(architecture-boundary §3.6 首个真实 Effect),失败不回滚。

**结论:终审是"扁平全局管理权限 + 两步状态机",`Activity.organizationId` 资源归属链已具备但未接线。终态正是要把这条链接进授权,并补"自己不能终审自己"职责分离。这是 Slow-3 子议题(#277 方案 A 挂起)的正式解。**

### 1.6 Activity.organizationId 资源归属链 — 链已全通,只差授权接线

`Activity.organizationId: String`(NOT NULL,`schema.prisma:491`,FK Restrict,有索引)。`AttendanceSheet.activityId`(NOT NULL)、`ActivityRegistration.activityId`(NOT NULL)、`AttendanceRecord.sheetId→sheet.activityId`。→ **`AttendanceSheet/Registration/Record → Activity → organizationId` 全链可解析**,当前仅展示用。`Certificate.memberId→Member`、`TeamJoinApplication.memberId→Member` + `selectedOrganizationId`、`Notification.recipientMemberId` / `visibleOrganizationIds[]`、`Attachment.ownerType+ownerId`(多态)——**所有资源都能解析到 org 或 owner,ResourceResolver 不需要新外键,只需读现有列。**

### 1.7 AuditLog — 写入即不可改,字段够用,可承载授权审计

`AuditLog`(`schema.prisma:787-814`,`@@map("audit_logs")`):`actorUserId? / actorRoleSnap?(Role 快照)/ resourceType / resourceId? / event / context(Json,强约束 AuditContext)/ success`。无 updatedAt/deletedAt(R1 红线:写后不可改删)。3 复合索引。

**结论:授权相关审计(任命/撤销/分管/RoleBinding 变更、敏感读、authz deny)可直接复用本表,`resourceType` 扩 `position_assignment` / `supervision_assignment` / `role_binding` 等 String 值即可,无 schema 改动。**

### 1.8 Seed / Permission code 现状 — 163 码 / 3 内置角色,改动即 D 档

- **163 个 Permission code**(3 个 e2e snapshot spec 分块锁:`ALL`=68 + `ATTACHMENT`=20 + `BIZ`=75)。`EXPECTED_ROUTES`=260。
- **3 内置 RbacRole:** `ops-admin`(63 绑定,运营/配置面)、`member`(9,USER 占位,自助附件)、`biz-admin`(74,业务面;每个 ADMIN 幂等补挂)。**SUPER_ADMIN 不是 RbacRole**(enum,短路判权,独持 6 个 reserved 码)。
- **敏感分级先例:** `recruitment-application.read.record`(脱敏)vs `recruitment-application.read.sensitive`(明文证件号/手机 + signed-URL)。→ **"敏感资料不因部长自动放开"在现有体系里就是"另一个 permission code",终态沿用此先例,不需要新机制。**
- **唯一 scope 后缀码:** 16 个 `attachment.*.{self,other}`(ownership,非 org-scope)。**无 `.department` / `.all` 类码。**

**结论:权限码命名体系健康,终态零"按 scope 复制码";只为新增管理面(memberships/positions/assignments/supervision/role-bindings/authz-explain/org-move)平铺加约 25 个"做什么"码。**

### 1.9 历史决议与铁律边界(可改 vs 不可破)

| 项 | 出处 | 终态处置 |
|---|---|---|
| 单部门 / 无任期 / 无职务 | schema D-1 注释、`participation-bounded-context.md:105`、`handoff/admin-web.md:136` | **可废弃**(本 goal 授权;非 AGENTS 铁律) |
| 终审部门级细分(Slow-3 子议题) | `current-state.md §3`、`RBAC_MAP §5`、#277 | **本稿即其正式解** |
| 判权单轨 `rbac.can()`、0 `@Roles` | `AGENTS §8`、RBAC_MAP §1 | **不可破**:`AuthzService` 仍走 service 层,绝不重挂 `@Roles` |
| `SUPER_ADMIN > ADMIN > USER` 三档 + `users.policy.ts` 永久共存 | `AGENTS §19.7`、permissions/CLAUDE.md | **不可破**:`AuthzService` 包住不替换 |
| App 面 scope=self 由 `memberId` 驱动,禁用 `role` 短路 | `AGENTS §19.7 D-5/6/8` | **不可破**:App `self` = RoleBinding `SELF` scope 的特例 |
| 不建 `common/utils` / `shared-services` / `*.repository.ts` 杂物袋 | architecture-boundary §7 | **遵守**:`AuthzService`/`ResourceResolver` 落新模块 `authz/`,不进 `common/` |
| 改 Role/Permission/seed/Guard/JwtStrategy 必 D 档 | RBAC_MAP §6 | **遵守**:全程 D 档 |

---

## 2. 终态设计总览 [B]

### 2.1 核心分层:把"组织结构事实"与"授权"解耦成两条链

```
                      ┌─────────────── 组织结构事实(谁在哪、是什么职务、分管谁)───────────────┐
  Organization(树+closure) ── Membership ── PositionAssignment ── SupervisionAssignment
        │  组织节点               人↔组织归属        人在某组织任某职务        人分管某组织(范围)
        │  (队/部/中心/组/筹备组)  (主/兼/临时/支援)   (任期+历史)              (exact/tree)
        └──────────────────────────────────────────────────────────────────────────────────┘
                                          │ 经由(动态推导 / 显式绑定)
                                          ▼
                      ┌──────────────────── 授权(能不能做、在哪做)────────────────────┐
  RbacRole ── RolePermission ── Permission        RoleBinding(principal × role × scope × 任期)
   (权限包,保留)     (保留)        (做什么,保留)    PositionRolePolicy(职务→角色 的映射,scopeMode)
                                          │
                                          ▼
                       AuthzService.can(user, action, resourceRef)
                          ├─ RbacService(底层权限码判定,保留)
                          ├─ RoleBinding(直接 + 职务推导 + 分管推导 三源归一)
                          ├─ ResourceResolver(资源 → org/owner/activity/sensitivity)
                          └─ ActionConstraint(自审禁止、敏感分级等域不变量)
                                          │
                                          ▼
                       AuthzDecision { allow, reason, matchedGrant, resource }
```

**一句话:`Organization + Position + Assignment + Supervision` 描述"组织事实";`RbacRole/Permission/RolePermission` 描述"权限包";`RoleBinding + PositionRolePolicy` 把前者按 scope 绑到后者;`AuthzService` 综合判定并永远可解释。**

### 2.2 真实组织结构 → 模型归类(基于任命公告 + seed 实况)

| 公告实体 | 例子(seed code) | 是什么 | 备注 |
|---|---|---|---|
| 总队 | 深圳公益救援队 `SRVF`(`headquarters`) | **Organization**(根) | 全队 scope 的锚 |
| 专业救援队 | 山地 `SMRT` / 水上 `SWRT` / 城市 `SURT` / 高空 `STRT`(`professional-*`) | **Organization**(队) | `professional-*` 是 team-join 门槛承重 |
| 救援/职能队 | 医疗辅助 `SAMT` / 应急通讯 `SECT` / 特勤 `SSD` / 少辅 `STAT`(`rescue-team`) | **Organization**(队) | |
| 职能部门 | 信息指挥中心 `ICC` / 志愿者组织部 `VOD` / 行政外联部 `APD` / 技术培训部 `TTD` / 秘书处 `SEC` / 联合会 `THQ`(`functional-dept`) | **Organization**(部/中心) | APD = **默认**考勤终审中枢(BD-2;由 `RoleBinding` 配置、可换绑) |
| 信息指挥中心 | `ICC` | **Organization**(中心,`functional-dept`) | |
| 少年辅助队 | `STAT` | **Organization**(辅助队) | |
| 队/部/中心下级组 | 训练组 / 装备组 / 文书组 / 行动组 / 技术组 / 标准组 / 外展组 / 无人机组 | **Organization**(组,新 nodeType `group`)| 挂在队/部之下;**不是字符串**;组功能留口 `groupFunctionCode`(R3)|
| 筹备组 | 潜水组(筹)/ 炊事保障组(筹)| **Organization**(`group` + `establishmentStatusCode=provisional`,**不新增 nodeType**,R1)| 与普通组同构,只设立状态不同;转正 = 翻状态,任命/历史不丢 |
| 队长 / 副队长 | — | **OrganizationPosition**(`categoryCode=LEADER/DEPUTY`,`isLeadership=true`) | 职务定义,**不进 Organization** |
| 部长 / 副部长 | — | **OrganizationPosition** | |
| 组长 / 副组长 | — | **OrganizationPosition** | |
| 文书 / 装备 / 训练(在本会 = 组)| 文书组 / 装备组 / 训练组 | **Organization**(组)| **R4 订正:** 2026 公告里它们是"组"+ 组长,非个人职务;Position 目录 v1 不含 STAFF 干事(`categoryCode=STAFF` 留口未 seed)|
| 「X 在 Y 任 Z 职」 | 崔广庆 在 SECT 任队长 | **OrganizationPositionAssignment**(任期 2026-07-01~2027-06-30) | 任职 = 人×组织×职务×任期 |
| 分管队长分工 | 黄勇(副队长)分管 SECT、SSD | **OrganizationSupervisionAssignment**(`scopeMode=tree`) | **不混进副队长职务** |
| 把"职务/分管"换算成权限 | 队长→管理本队树、APD 部长→终审全树、分管→监督范围只读 | **RoleBinding**(直接)+ **PositionRolePolicy**(职务推导)+ 分管推导 | scope 在此体现 |

### 2.3 七条核心原则落地对照(goal 原则 1–10)

1. **不推翻 RBAC** → `Permission/RbacRole/RolePermission` 原样;`UserRole→RoleBinding(global)`。
2. **职务不进 Organization** → 队/部/中心/组/筹备组都是 Organization 节点;职务在 `OrganizationPosition`。
3. **职务不进 MemberDepartment** → `MemberDepartment`→`MemberOrganizationMembership`(主/兼/临时/支援 + 任期);职务在 Assignment。
4. **职务是一等模型** → `OrganizationPosition`(category/rank/isLeadership/allowMultiple/allowConcurrent);**目录 v1 收敛为 6 个领导职务**(队长/副队长/部长/副部长/组长/副组长),STAFF 干事类留口(R4);`PositionAssignment.isConcurrent` 表达"兼"(R2)。
5. **任职必有任期** → Assignment 有 `startedAt/endedAt/status` + 任命/撤销人 + 历史可追溯 + 审计。
6. **分管单独建模** → `OrganizationSupervisionAssignment`,与职务正交;**分管是独立授权源,scope 绝不从副职头衔推导**(R5)。
7. **权限码不带 scope** → 保留 `attendance.final-approve.sheet`;scope 进 `RoleBinding.scopeType`。
8. **业务服务不直接 `rbac.can()` 作终判** → 新增 `AuthzService`,内部调 `RbacService`,综合 role+position+supervision+scope+resource。
9. **必须有 ResourceResolver** → 资源 → `{ organizationId, ownerMemberId, activityId, sensitivityLevel, ... }`。
10. **业务约束** → 自审禁止、停用/过期不授权、敏感不自动放开、全局管理员 vs 组织管理员分清 → 见 §3 约束 + §5 ActionConstraint + §6 场景。

### 2.4 业务拍板结论(默认 policy;2026-07-01 维护者拍板)

> 以下 4 条把 §12 验证暴露的 4 个开放问题定稿,是**当前终态设计的默认 policy**(运营后台 / seed 可调,默认值即此),贯穿 §5 判权 / §6 场景 / §8 导入 / §10 风险 / §11 PR。

**BD-1 总队队长 = 全组织业务管理(方案 A),但 ≠ SUPER_ADMIN。**
- 正职"队长@root"经 `PositionRolePolicy` 默认映射 `org-admin` 角色,`scope=organization_tree(root)`,可做**全队业务管理**。
- **但不含**:系统权限配置(RBAC `Permission`/`Role`/`RolePermission`)、平台凭证(`*.reset.credentials`)、敏感资料明文(`*.read.sensitive`)、`user.update.role` 等;且仍受 ActionConstraint(自己不能终审自己等)约束。
- **副队长继续 R5**:不因副队长头衔自动获任何管理权,只能经 `SupervisionAssignment` 或显式 `RoleBinding` 获范围权限。

**BD-2 考勤终审中枢 = 默认 APD 部长/副部长,但由 `RoleBinding` 配置决定,绝不 hardcode。**
- 默认 seed:APD 部长/副部长任职 → **显式** `RoleBinding(principalType=POSITION_ASSIGNMENT, role=attendance-final-reviewer〔含 attendance.final-approve.sheet / attendance.final-reject.sheet〕, scopeType=ORGANIZATION_TREE, scopeId=root)`。
- **实现绝不能在代码里写死 "APD"**:终审中枢身份**完全由 `RoleBinding` 行决定**,未来可换绑 VOD / TTD / 总队办公室 / 其他专责组织 —— **只改绑定行、不改代码**。

**BD-3 分管监督(`org-supervisor`)= 默认只读,不含写/终审/敏感。**
- **默认含**:`member.read.record`、`activity.read.record`、`activity-registration.read.record`、`attendance.read.sheet`、`attendance-record.read.record`、`certificate.read.record`。
- **默认不含**:`member.update.*`、`attendance.approve.sheet`、`attendance.final-approve.sheet`、`*.read.sensitive`、user / role / permission 等系统权限。
- 分管人如需审批 / 终审,**必须另加显式 `RoleBinding`**。
- **实现注(BD-3 候选码,见 §4.3 表末🟡):** `activity.read.record` 与 `attendance-record.read.record` 当前**未 seed**(候选,实施时二次确认,不作既有事实)。两条出路:
  - **若不新增:** `org-supervisor` 的活动读取继续沿现状 login-only,考勤明细继续随 `attendance.read.sheet`。
  - **若新增:** 二者**只表达"做什么"**,scope 仍由 `RoleBinding` 控制。
  其余 4 码(`member.read.record` / `activity-registration.read.record` / `attendance.read.sheet` / `certificate.read.record`)已存在。

**BD-4 组长 Membership = 主归属落队/部/中心级,不强制落组级。**
- 组长/副组长等**组级身份由 `OrganizationPositionAssignment`(任职)表达**,不靠 membership。
- 默认 `PRIMARY` 归属在队/部/中心;**组级不建强制 membership**。
- 未来若需统计组内正式成员,可用 `SECONDARY` membership 补充,但**不作为任职前置硬要求**(R8 的 `requireMembership` 对组长校验"在本组织子树内有 active 归属"即可,队级归属已满足)。

---

## 3. 终态数据模型草案 [C]

> 命名沿仓内 PascalCase model + 字段 camelCase + `*Code` 字典风格;新建表用显式 `@@map("snake_case")`(沿 RBAC/audit_logs 近期惯例;旧无 @@map 表不动)。所有 partial unique(带 WHERE)Prisma DSL 至 6.x 不支持,统一在 migration.sql 末尾手写(沿 `MemberDepartment_memberId_active_key` / `activity_registrations_*_active_unique` 范式)。软删一律 `deletedAt`,禁物理删(AGENTS §10)。

### 3.0 枚举(集中声明)

```prisma
enum MembershipType   { PRIMARY  SECONDARY  TEMPORARY  SUPPORT }
enum MembershipStatus { ACTIVE   ENDED      SUSPENDED }
enum PositionCategory { LEADER   DEPUTY     STAFF }       // 正职 / 副职 / 干事
enum AssignmentStatus { ACTIVE   ENDED      REVOKED }
enum SupervisionScopeMode { EXACT  TREE }
enum SupervisionStatus { ACTIVE  ENDED  REVOKED }
enum PrincipalType   { USER  MEMBER  POSITION_ASSIGNMENT  SYSTEM }
enum BindingScopeType{ GLOBAL  ORGANIZATION  ORGANIZATION_TREE  ACTIVITY  RESOURCE  SELF }
enum BindingStatus   { ACTIVE  ENDED  SUSPENDED }
enum PolicyScopeMode { EXACT  TREE }
enum PolicyStatus    { ACTIVE  INACTIVE }
```

> 注:是否上 Prisma enum vs String 常量,沿仓内"状态机用 String、强约束闭集用 enum"的混合惯例。上表是建议;若维护者倾向 String 常量(如 statusCode 系列),可整体降为 String + 代码常量,不影响架构。

### 3.0.1 Organization 增列(R1 / R3;现有表 additive,不动主结构)

现有 `Organization`(邻接表 + `nodeTypeCode`)主结构不动,仅加两列(均可空、纯加列,沿仓内 additive 惯例;`*Code` String 字典风格):

```prisma
// Organization 增列(additive):
establishmentStatusCode String? // R1:设立状态字典 org_establishment_status —— 空/`formal`=正式;`provisional`=筹备组(潜水组/炊事保障组（筹）)
groupFunctionCode       String? // R3:组功能留口字典 group_function —— training/equipment/clerk/action/standard/...(v1 只占列、不写逻辑)
```

- **R1 筹备组 = 状态,不是新 nodeType:** "潜水组(筹)/ 炊事保障组(筹)" 与普通组同构(都有组长/副组长),只设立状态不同 → `nodeTypeCode='group'` + `establishmentStatusCode='provisional'`,**不新增 `preparatory-group` nodeType**。转正 = 把 `provisional` 改 `formal`(免改 nodeType、免复制该 nodeType 的 PositionRule、保任命与历史)。`node_type` 字典因此**只加 `group` 一值**。
- **R3 组功能留口:** ~26 种组功能(训练/装备/文书/外展/搜救犬/心理/行动/统筹/标准/无人机/物资/交通/炊事/文秘/传媒/外联/招新/宣导/荣誉/培训/教委/总务/导师/项目…)v1 只在 `name`;`groupFunctionCode` 预留列位,未来按组功能做差异化职务规则(如"文书组才可设文书干事""标准组有制标权")再启用,避免把功能塞进 `name` 后无法查询。

### 3.1 MemberOrganizationMembership(替代 MemberDepartment)

```prisma
model MemberOrganizationMembership {
  id             String           @id @default(cuid())
  memberId       String
  organizationId String
  membershipType MembershipType   @default(PRIMARY)
  status         MembershipStatus @default(ACTIVE)
  startedAt      DateTime         @default(now())
  endedAt        DateTime?
  reason         String?          // 编入/调出原因(自由短串)
  createdByUserId String?
  endedByUserId   String?
  createdAt      DateTime         @default(now())
  updatedAt      DateTime         @updatedAt
  deletedAt      DateTime?

  member       Member       @relation(fields: [memberId], references: [id], onDelete: Restrict)
  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Restrict)

  @@index([memberId])
  @@index([organizationId])
  @@index([memberId, status])
  @@index([deletedAt])
  @@index([createdAt])
  @@map("member_organization_memberships")
}
```

**Partial unique(手写 migration.sql):**
- 一人至多一个 active 主归属:`CREATE UNIQUE INDEX member_org_membership_primary_active_unique ON member_organization_memberships(memberId) WHERE deletedAt IS NULL AND status='ACTIVE' AND membershipType='PRIMARY';`
- 同一(人,组织,类型)不重复 active:`... (memberId, organizationId, membershipType) WHERE deletedAt IS NULL AND status='ACTIVE';`(P2002 → `MEMBERSHIP_ALREADY_EXISTS`)

**说明:** `PRIMARY` 唯一 = 旧"单部门"语义的升级(只约束主归属);`SECONDARY/TEMPORARY/SUPPORT` 可并存多条 = 跨部门/兼属/临时编入/支援。任期 `startedAt/endedAt` + `status` 可表达历史,软删行保留留痕。

### 3.2 OrganizationPosition(职务定义)

```prisma
model OrganizationPosition {
  id             String           @id @default(cuid())
  code           String           @unique          // kebab,如 team-leader / dept-deputy / group-leader / clerk
  name           String                            // 显示名:队长/副部长/组长/文书 …
  categoryCode   PositionCategory                  // LEADER / DEPUTY / STAFF
  rank           Int              @default(0)       // 层级排序(队长<副队长<部长…自定权重)
  isLeadership   Boolean          @default(false)   // 是否领导职务
  allowMultiple  Boolean          @default(false)   // 同组织同职务是否允许多人(如多个干事)
  allowConcurrent Boolean         @default(true)    // 是否允许一人兼任多职务
  sortOrder      Int              @default(0)
  status         PolicyStatus     @default(ACTIVE)
  description    String?
  createdAt      DateTime         @default(now())
  updatedAt      DateTime         @updatedAt
  deletedAt      DateTime?

  rules        OrganizationPositionRule[]
  assignments  OrganizationPositionAssignment[]
  rolePolicies OrganizationPositionRolePolicy[]

  @@index([categoryCode])
  @@index([status])
  @@index([deletedAt])
  @@map("organization_positions")
}
```

> 职务是**全局复用定义**(一个"部长"职务,不为每个部建一份);它在哪类组织可用,由 §3.3 规则约束;它换算成什么权限,由 §3.7 policy 决定。
>
> **R4 — 目录 v1 收敛为 6 个领导职务:** seed 只建 `team-leader / vice-captain / dept-leader / dept-deputy / group-leader / deputy-group-leader`(队长/副队长/部长/副部长/组长/副组长)。**`PositionCategory.STAFF`(文书/装备/训练等个人干事)保留为留口、本期不 seed** —— 2026 公告里"文书/装备/训练"是组(Organization)而非个人职务,人是该组组长。
>
> 上方 model 注释里的 `clerk` / `文书` **仅为 STAFF 留口示例,v1 不 seed,不对应本公告中的"文书组组长"**(后者是 `group-leader`@文书组节点)。

### 3.3 OrganizationPositionRule(某类组织可设哪些职务)

```prisma
model OrganizationPositionRule {
  id                String       @id @default(cuid())
  nodeTypeCode      String                          // 关联 node_type 字典:headquarters/rescue-team/functional-dept/group/...
  positionId        String
  required          Boolean      @default(false)    // 该类组织是否必须有此职务
  minCount          Int?                            // 最少在任人数
  maxCount          Int?                            // 最多在任人数(null=不限;与 position.allowMultiple 协同)
  requireMembership Boolean      @default(true)     // 任此职务是否要求先有该组织 active 归属
  allowConcurrent   Boolean      @default(true)     // 该类组织内是否允许兼任
  status            PolicyStatus @default(ACTIVE)
  createdAt         DateTime     @default(now())
  updatedAt         DateTime     @updatedAt
  deletedAt         DateTime?

  position OrganizationPosition @relation(fields: [positionId], references: [id], onDelete: Restrict)

  @@unique([nodeTypeCode, positionId])             // 同类组织对同职务一条规则
  @@index([positionId])
  @@index([deletedAt])
  @@map("organization_position_rules")
}
```

> `nodeTypeCode` 而非具体 org —— 规则按"组织类别"声明,运营自治。
>
> **R6 — 同一 nodeType 可登记多个领导称谓:** 一个 nodeType 允许挂多条领导职务规则(如 `rescue-team` 同时允许"队长"与"部长"—— SAMT/SECT 用队长、STAT 用部长),由实际任命择一;Rule 表达"可设哪些职务",**不**强制单一领导命名。
>
> **R8 — `requireMembership` 按(nodeType, position)可配:** 总队级领导(`headquarters` 的队长/副队长)规则设 `requireMembership=false` —— 总队长/副队长**不必"归属"于根**(其 PRIMARY 归属在本队);组长/副组长规则设 `requireMembership=true`(应在本组织子树内有 active 归属)。这落实"归属 / 任职 / 分管三轴独立"(黄勇、赵强、金洋:三者 org 各不相同)。

### 3.4 OrganizationPositionAssignment(任职)

```prisma
model OrganizationPositionAssignment {
  id               String          @id @default(cuid())
  organizationId   String
  positionId       String
  memberId         String
  status           AssignmentStatus @default(ACTIVE)
  startedAt        DateTime                          // 公告任期起(2026-07-01)
  endedAt          DateTime?                         // 公告任期止(2027-06-30)
  appointedByUserId String?                          // 任命人
  revokedByUserId   String?                          // 撤销人
  appointmentSource String?                          // 任命来源:announcement-2026 / manual / import
  isConcurrent      Boolean        @default(false)    // R2:兼任标记(回填公告"（兼）",如赵强兼 SAMT 队长;不影响授权,两条 PA 都生效)
  note             String?
  createdAt        DateTime        @default(now())
  updatedAt        DateTime        @updatedAt
  deletedAt        DateTime?

  organization Organization         @relation(fields: [organizationId], references: [id], onDelete: Restrict)
  position     OrganizationPosition @relation(fields: [positionId], references: [id], onDelete: Restrict)
  member       Member               @relation(fields: [memberId], references: [id], onDelete: Restrict)
  roleBindings RoleBinding[]        @relation("PositionAssignmentBinding") // principalType=POSITION_ASSIGNMENT 时

  @@index([organizationId])
  @@index([positionId])
  @@index([memberId])
  @@index([organizationId, status])
  @@index([status])
  @@index([deletedAt])
  @@map("organization_position_assignments")
}
```

**Partial unique(手写,仅当职务不允许多人):** 因 `allowMultiple` 是 position 上的属性、无法直接进部分索引,**单人独占由 service 层按 `position.allowMultiple` 校验**;再补一条防重底线:`... (organizationId, positionId, memberId) WHERE deletedAt IS NULL AND status='ACTIVE';`(同人同组织同职务不重复 active)。**任职历史 = 软删行 + ENDED/REVOKED 行全保留,可追溯。**

### 3.5 OrganizationSupervisionAssignment(分管关系)

```prisma
model OrganizationSupervisionAssignment {
  id                String              @id @default(cuid())
  supervisorMemberId String                            // 分管人(副队长/队长本人)
  organizationId    String                            // 被分管组织
  scopeMode         SupervisionScopeMode @default(TREE) // EXACT=仅该节点 / TREE=含下级
  status            SupervisionStatus    @default(ACTIVE)
  startedAt         DateTime
  endedAt           DateTime?
  appointedByUserId String?
  revokedByUserId   String?
  note              String?
  createdAt         DateTime            @default(now())
  updatedAt         DateTime            @updatedAt
  deletedAt         DateTime?

  supervisor   Member       @relation("MemberSupervision", fields: [supervisorMemberId], references: [id], onDelete: Restrict)
  organization Organization @relation("OrgSupervised", fields: [organizationId], references: [id], onDelete: Restrict)

  @@index([supervisorMemberId])
  @@index([organizationId])
  @@index([supervisorMemberId, status])
  @@index([deletedAt])
  @@map("organization_supervision_assignments")
}
```

**Partial unique(手写):** `... (supervisorMemberId, organizationId) WHERE deletedAt IS NULL AND status='ACTIVE';`(同人对同组织一条 active 分管)。**黄勇分管 SECT、SSD = 两行;与他的"副队长"职务(Assignment)正交。**

### 3.6 RoleBinding(带 scope 的角色绑定;终态替代/兼容 UserRole)

```prisma
model RoleBinding {
  id            String          @id @default(cuid())
  principalType PrincipalType                       // USER / MEMBER / POSITION_ASSIGNMENT / SYSTEM
  principalId   String?                             // SYSTEM 时可空
  roleId        String
  scopeType     BindingScopeType
  scopeOrgId    String?                             // ORGANIZATION / ORGANIZATION_TREE 时必填
  scopeActivityId String?                           // ACTIVITY 时必填
  scopeResourceType String?                         // RESOURCE 时必填(如 attendance_sheet)
  scopeResourceId   String?                         // RESOURCE 时必填
  status        BindingStatus   @default(ACTIVE)
  startedAt     DateTime        @default(now())
  endedAt       DateTime?                           // 临时授权可设;过期不授权
  createdByUserId String?
  note          String?
  createdAt     DateTime        @default(now())
  updatedAt     DateTime        @updatedAt
  deletedAt     DateTime?

  role               RbacRole                       @relation(fields: [roleId], references: [id], onDelete: Restrict)
  positionAssignment OrganizationPositionAssignment? @relation("PositionAssignmentBinding", fields: [principalId], references: [id], onDelete: Cascade, map: "rolebinding_posassign_fk")
  // 注:principalId 是多态(随 principalType 指向 user/member/position_assignment),
  //     上面这条 relation 仅在 POSITION_ASSIGNMENT 语义下有效;USER/MEMBER 不建 Prisma FK(多态,沿 Attachment.ownerId 范式),由 service 校验存在性。

  scopeOrganization  Organization?                  @relation("RoleBindingScopeOrg", fields: [scopeOrgId], references: [id], onDelete: Restrict)

  @@index([principalType, principalId])
  @@index([roleId])
  @@index([scopeType, scopeOrgId])
  @@index([scopeActivityId])
  @@index([status])
  @@index([deletedAt])
  @@map("role_bindings")
}
```

**Partial unique(手写):** `... (principalType, principalId, roleId, scopeType, scopeOrgId, scopeActivityId, scopeResourceType, scopeResourceId) WHERE deletedAt IS NULL AND status='ACTIVE';`(同一绑定不重复)。

> **设计要点:** `principalId` 多态(沿 `Attachment.ownerType/ownerId` 范式,不为 USER/MEMBER 建 FK,仅 POSITION_ASSIGNMENT 建可选 FK 以支持级联)。`UserRole` 迁移为 `RoleBinding(principalType=USER, scopeType=GLOBAL)`。`principalType=POSITION_ASSIGNMENT` 让"绑给某任职"成为可能(如 APD 部长这一任职 → 终审角色 + tree(root) scope),任职结束绑定随之失效。

### 3.7 OrganizationPositionRolePolicy(职务→角色 映射)

```prisma
model OrganizationPositionRolePolicy {
  id           String          @id @default(cuid())
  positionId   String
  roleId       String
  scopeMode    PolicyScopeMode @default(TREE)        // 相对"任职所在组织"的 EXACT / TREE
  conditionJson Json?                                // 可选条件(如 { orgCode: "APD" } / { nodeTypeCode: "functional-dept" })
  status       PolicyStatus    @default(ACTIVE)
  createdAt    DateTime        @default(now())
  updatedAt    DateTime        @updatedAt
  deletedAt    DateTime?

  position OrganizationPosition @relation(fields: [positionId], references: [id], onDelete: Restrict)
  role     RbacRole             @relation(fields: [roleId], references: [id], onDelete: Restrict)

  @@unique([positionId, roleId])
  @@index([positionId])
  @@index([roleId])
  @@index([deletedAt])
  @@map("organization_position_role_policies")
}
```

> **这是"职务不天然 = 管理员"的关键闸门:** 职务换算成什么角色、覆盖多大范围,全在此显式声明、可审计、可调。**只为正职映射管理角色:** `队长→team-manager@TREE`、`部长→dept-manager@TREE`、`组长→group-manager@EXACT/TREE`。
>
> **🔴 R5 安全红线 —— 副职默认不推导正职管理角色:** `副队长 / 副部长 / 副组长` 的 PositionRolePolicy **默认不映射任何管理角色**(至多映射到极薄只读角色)。副职的实际管辖权**只能**来自(a)对副队长的 `SupervisionAssignment`(分管),或(b)显式 `RoleBinding`。**严禁**让副职头衔自动推导出全局 / 全树管理 scope —— 否则总队 6 名副队长各得近全组织管理 = goal 明禁的"部长 = 管理员"。seed 默认 policy 只覆盖正职;CI 断言副职无管理 policy(见 §10.5)。
>
> APD 终审中枢这种"跨树中央职能"用 §3.6 的 `RoleBinding(principalType=POSITION_ASSIGNMENT, scopeType=ORGANIZATION_TREE, scopeId=root)` 显式绑定,**不**走通用 policy(避免任何"部长"误获全树终审)。

### 3.8 OrganizationClosure(高效上下级判定)

```prisma
model OrganizationClosure {
  ancestorId   String
  descendantId String
  depth        Int                                   // 0 = 自身;1 = 直接子;…

  ancestor   Organization @relation("ClosureAncestor",   fields: [ancestorId],   references: [id], onDelete: Cascade)
  descendant Organization @relation("ClosureDescendant", fields: [descendantId], references: [id], onDelete: Cascade)

  @@id([ancestorId, descendantId])
  @@index([descendantId])                            // 反查祖先链(resource.org 的 ancestor 集)
  @@index([ancestorId, depth])
  @@map("organization_closure")
}
```

**为什么 closure 而非 materialized path:** 组织树小(数百节点封顶)、变动罕见,两者皆可。选 closure 因(a)纯关系结构、无字符串解析,(b)子树判定 = 一条 join(`EXISTS closure(ancestor=scopeOrg, descendant=resourceOrg)`),(c)祖先集一次查得、与 Prisma 组合干净,(d)`depth` 顺带可用。维护:org create/move 事务内增量更新(小树成本可忽略);初次由现有 `parentId` 树回填。**materialized path 作为更轻替代保留选项**(可加 `Organization.path/depth` 冗余列),不阻塞架构。

### 3.9 Prisma DSL 不支持、需手写 migration.sql 的清单

| 表 | 约束 | 原因 |
|---|---|---|
| `member_organization_memberships` | 主归属 active 唯一 + (人,组织,类型) active 唯一 | 带 WHERE partial unique |
| `organization_position_assignments` | (org,position,member) active 唯一 | 带 WHERE partial unique;单人独占 service 层按 `allowMultiple` 判 |
| `organization_supervision_assignments` | (supervisor,org) active 唯一 | 带 WHERE partial unique |
| `role_bindings` | 全 scope 维度 active 唯一 | 带 WHERE partial unique |
| `organization_closure` | 初次回填 + create/move 维护 | 递归回填 SQL(`WITH RECURSIVE`)或 service 内构建 |

其余(普通 `@@unique` / `@@index` / FK)Prisma DSL 可表达。

---

## 4. 权限码策略 [F]

### 4.1 铁律:scope 不进权限码

- **保留全部 163 个"做什么"码**,命名不动(`<module>.<action>.<resource_type>`)。`attendance.final-approve.sheet` 原样;`.sheet` 是 resourceType 不是 scope。
- **绝不新增** `attendance.final-approve.department` / `.all` / `.self`(org-scope 版)这类按 scope 复制的码 —— scope 全部由 `RoleBinding.scopeType` 表达。
- **现有 16 个 `attachment.*.{self,other}`** 保留可用;终态语义上 `.self` 等价于 `RoleBinding scopeType=SELF`,但**不强制收敛**(改这 16 码 = 高风险 churn,无收益),让 `AuthzService` 对 `.self` 后缀沿用现 `checkOwnership` 即可向后兼容。

### 4.2 敏感分级:沿用"另一个 permission code"先例,不发明新机制

`member.read.record`(脱敏)与拟新增 `member.read.sensitive`(明文 PII)分离 —— 完全复刻 `recruitment-application.read.{record,sensitive}` 先例。**"部长不因职务自动看全部敏感资料" = 部长绑的角色含 `member.read.record` 但不含 `member.read.sensitive`**;敏感访问需另一个角色/绑定显式授予,且仍受 scope 约束。无需 ActionConstraint 特判,落在权限码粒度 + scope。

### 4.3 需新增的少量"做什么"码(管理新面,约 25 个确定;另 2 个 BD-3 候选未定,见表末;均非 scope 膨胀)

| 模块 | 新码 | 用途 |
|---|---|---|
| membership | `membership.{read,set,end,list}.record`(4) | 升级 `member-department.*`;旧 3 码保留为 deprecated 兼容/重映射 |
| position | `position.{read,create,update,delete}.definition`(4) | 职务定义 CRUD |
| position-rule | `position-rule.{read,create,update,delete}.record`(4) | 组织类别×职务规则 CRUD |
| position-assignment | `position-assignment.{read,create,revoke}.record` + `.read.history`(4) | 任职管理 + 历史 |
| supervision | `supervision-assignment.{read,create,update,revoke}.record`(4) | 分管管理 |
| role-binding | `role-binding.{read,create,update,delete}.record`(4) | scoped 绑定管理 |
| authz | `authz.explain.decision`(1) | 权限解释端点 |
| org | `org.move.node`(1) | reparent(新能力,复活死 BizCode 做 cycle 守卫) |
| member(敏感) | `member.read.sensitive`(1) | 敏感分级闸门 |
| 🟡 activity(BD-3 候选)| `activity.read.record`(1,**当前未 seed**)| org-supervisor 分管 scope 内读活动详情/列表;**实施时二次确认** |
| 🟡 attendance(BD-3 候选)| `attendance-record.read.record`(1,**当前未 seed**)| org-supervisor 分管 scope 内读考勤明细 record;**实施时二次确认** |

> **🟡 BD-3 可选候选码 —— 当前未 seed / 实施时二次确认(不作既有事实,不计入上表 ~25):**
> 1. **`activity.read.record`** —— **用途**:让 `org-supervisor` 在其分管 scope 内读取活动详情/列表。**当前状态**:活动读接口现状偏 login-only,无此权限码。**处理**:BD-3 候选新增码;若 PR7/PR12 决定把活动读纳入 scoped authz,则 seed。
> 2. **`attendance-record.read.record`** —— **用途**:让 `org-supervisor` 在其分管 scope 内读取考勤明细 record。**当前状态**:考勤记录读取主要随 `attendance.read.sheet` 覆盖,无独立 record 读码。**处理**:BD-3 候选新增码;若 PR7/PR12 决定将 sheet 与 record 粒度拆开,则 seed。
>
> 二者**只表达"做什么"**,scope 仍由 `RoleBinding` 控制;落地前需二次拍板,届时再并入总码数。

### 4.4 绝不新增

- ❌ 任何 `*.department` / `*.all` / `*.self`(新建 org-scope 版)后缀膨胀码。
- ❌ 不为"全局管理员 vs 组织管理员"造两套码 —— 同一码,不同 `RoleBinding.scope`(global vs organization_tree)。
- ❌ 不动 `Role` enum / 不给 RBAC 业务角色 SUPER_ADMIN 短路语义。

> 所有码增删/角色重绑 = D 档,逐 PR 同步 3 个 seed snapshot spec(`seed-rbac` / `seed-attachment-permissions` / `seed-biz-admin`)与 `EXPECTED_ROUTES`。

---

## 5. 鉴权链路 [D + E]

### 5.1 ResourceResolver(资源归属解析)[E]

**落位:** 新模块 `src/modules/authz/resource-resolver.service.ts`(不进 `common/`,遵 architecture-boundary §7)。按 `resourceType` 分发,只读现有列,无新外键。

**统一输出结构:**

```ts
interface ResolvedResource {
  resourceType: string;            // 'attendance_sheet' | 'member' | ...
  resourceId: string;
  organizationId: string | null;   // 资源归属组织(授权 scope 主键)
  organizationPath: string[] | null; // 祖先链(closure 反查;tree 判定用)
  ownerMemberId: string | null;    // 资源属主 member(self/owner 判定)
  ownerUserId: string | null;
  activityId: string | null;       // activity scope 判定
  statusCode: string | null;       // 业务状态(部分 ActionConstraint 用)
  sensitivityLevel: 'public' | 'internal' | 'sensitive' | null; // 敏感分级 hint
  // 域特定附加(自审等约束用,放 extra 不污染主结构):
  extra?: Record<string, unknown>; // 如 attendance_sheet: { submitterUserId, reviewerUserId }
}
```

**逐资源解析表:**

| resourceType | organizationId | ownerMemberId | activityId | 备注 |
|---|---|---|---|---|
| `activity` | `activity.organizationId` | — | `id` | 直接 |
| `attendance_sheet` | `sheet→activity.organizationId` | — | `sheet.activityId` | `extra.submitterUserId/reviewerUserId`(自审约束) |
| `attendance_record` | `record→sheet→activity.organizationId` | `record.memberId` | 同上 | |
| `activity_registration` | `reg→activity.organizationId` | `reg.memberId` | `reg.activityId` | |
| `member` | 该 member 的 active `PRIMARY` membership org | `member.id` | — | `ownerUserId = member.user?.id` |
| `member_profile` | 经 member | `profile.memberId` | — | `sensitivityLevel='sensitive'`(PII) |
| `certificate` | 经 member(`cert→member→PRIMARY membership`) | `cert.memberId` | — | |
| `team_join_application` | `app.selectedOrganizationId ?? null`(候选在 `targetOrganizationIds[]`) | `app.memberId` | — | 入队中央/VOD 面 |
| `recruitment_application` | `null`(D-R-1:无 Member FK、无 org)| `null` | — | 仅 global/中央(VOD/招新)绑定可达;`sensitivityLevel='sensitive'` |
| `notification` | directed: 经 `recipientMemberId`;department 广播: `visibleOrganizationIds[]`(任一覆盖即可) | `recipientMemberId` | — | feed 本人可见∪定向 |
| `attachment` | 按 `ownerType` 委派对应 resolver(`ownerId`) | 同被委派资源 | 同 | `sensitivityLevel ← attachment.accessLevel`(PUBLIC/INTERNAL/SENSITIVE) |

> 解析失败(资源不存在/已软删)→ 返回 `null` 资源,授权侧默认拒绝(fail-close)+ 防枚举(他人资源统一 404,沿仓内惯例)。

### 5.2 AuthzService(统一鉴权)[D]

**落位:** `src/modules/authz/authz.service.ts`,内部注入 `RbacService`(保留)+ `ResourceResolver` + closure 查询。**对外是新的终判出口**;业务 service 从 `rbac.can(user, code)` 迁到 `authz.can(user, action, resourceRef)`(逐模块,见 §11)。

> **🔴 安全默认(红线,R5)—— 优先于一切推导,任何实现不得违背:**
> 1. **副职不自动推导管理角色。** `vice-captain / dept-deputy / deputy-group-leader`(副队长/副部长/副组长)经 §3.7 policy **默认得不到任何管理角色**(至多极薄只读)。下方步骤 3b 的职务推导**只对正职**产出管理 grant。
> 2. **分管独立于职务,scope 不从头衔推导。** 全局 / 全树管辖**只能**来自显式 `RoleBinding`(3a)或 `SupervisionAssignment`(3c),**绝不**来自"副队长 / 副部长"头衔(3b)。副队长的可达范围 = 其 `SupervisionAssignment` 覆盖面,仅此而已。
> 3. **默认拒绝。** 无任何命中 grant → deny;头衔本身从不是 allow 依据。

**入参 DTO / 返回结构:**

```ts
interface ResourceRef { type: string; id: string; }            // 或 { type:'activity', id } 等
interface AuthzDecision {
  allow: boolean;
  reason: string;             // super_admin_pass / matched / no_permission / out_of_scope /
                              // out_of_supervised_scope / expired_grant / inactive_org /
                              // self_approval_forbidden / sensitive_denied / resource_not_found
  matchedGrant?: {            // 命中时:谁因哪条授权、在什么范围被允许(可解释性核心)
    source: 'super_admin' | 'role_binding' | 'position' | 'supervision';
    bindingId?: string; positionAssignmentId?: string; supervisionAssignmentId?: string;
    roleCode?: string; scopeType: string; scopeId?: string;
  };
  resource?: ResolvedResource;
}

can(user: CurrentUserPayload, action: string, ref?: ResourceRef): Promise<boolean>;       // 薄包装
explain(user: CurrentUserPayload, action: string, ref?: ResourceRef): Promise<AuthzDecision>; // 全解释
```

**判权伪代码(`explain` 主流程):**

```
explain(user, action, ref):
  # 0. 身份有效性已由 JwtStrategy 保证(ACTIVE + 未软删);此处不再查
  # 1. SUPER_ADMIN:全局判权短路(但不豁免域不变量,见步骤 6)
  if user.role == SUPER_ADMIN:
     decision = allow(super_admin_pass, matchedGrant={source:super_admin, scopeType:GLOBAL})
     return applyConstraints(decision, user, action, resource=resolve(ref))  # 自审等仍生效

  # 2. 解析资源
  resource = ref ? ResourceResolver.resolve(ref) : null
  if ref and resource == null: return deny(resource_not_found)

  # 3. 收集候选 grant(三源归一,全部带 scope + 有效期 + 状态过滤)
  grants = []
  ## 3a. 直接 RoleBinding(含 UserRole 迁移来的 global 行)
  grants += activeRoleBindings(user)                       # status=ACTIVE, now∈[startedAt,endedAt], 未软删
  ## 3b. 职务推导:每个 active PositionAssignment × 匹配的 PositionRolePolicy
  ##     🔴 R5:副职(vice-captain/dept-deputy/deputy-group-leader)默认无 management policy → 本步对副职不产出管理 grant
  for pa in activePositionAssignments(user.memberId):       # 任职有效期/状态/未软删
     for pol in activePoliciesFor(pa.positionId):           # 仅正职有管理 policy;conditionJson 命中(orgCode/nodeType)
        grants += virtualGrant(role=pol.roleId, scopeType=pol.scopeMode→ORG/ORG_TREE,
                               scopeOrgId=pa.organizationId, source=position, paId=pa.id)
  ## 3c. 分管推导:每个 active SupervisionAssignment → 监督角色(可配,默认 org-supervisor 只读)
  for sa in activeSupervisionAssignments(user.memberId):
     grants += virtualGrant(role=SUPERVISOR_ROLE, scopeType=sa.scopeMode→ORG/ORG_TREE,
                            scopeOrgId=sa.organizationId, source=supervision, saId=sa.id)

  # 4. 过滤出"角色含 action 权限码"的 grant
  candidates = [g for g in grants if RbacService.roleHasPermission(g.roleId, action)]
  if candidates is empty: return deny(no_permission)

  # 5. scope 覆盖判定(命中即 allow)
  for g in candidates (按 source 优先级/确定性排序):
     if covers(g, resource):                                # 见下
        decision = allow(matched, matchedGrant=g, resource)
        return applyConstraints(decision, user, action, resource)
  return deny(out_of_scope / out_of_supervised_scope, resource)   # 分管源专属 reason

covers(grant, resource):
  switch grant.scopeType:
    GLOBAL:            return true
    ORGANIZATION:      return resource.organizationId == grant.scopeOrgId
                              and orgActive(grant.scopeOrgId)
    ORGANIZATION_TREE: return orgActive(grant.scopeOrgId) and
                              EXISTS closure(ancestor=grant.scopeOrgId, descendant=resource.organizationId)
    ACTIVITY:          return resource.activityId == grant.scopeActivityId
    RESOURCE:          return resource.resourceType==grant.scopeResourceType and resource.resourceId==grant.scopeResourceId
    SELF:              return resource.ownerMemberId == user.memberId   # App self 的统一表达

applyConstraints(decision, user, action, resource):   # 域不变量层(对所有人含 SUPER_ADMIN 生效)
  for c in ActionConstraints[action]:                 # 注册表,按 action 命中
     veto = c(user, resource)                          # 如 self-approval / sensitive
     if veto: return deny(veto.reason)
  return decision
```

**关键设计回答(对 goal D 的逐条):**

- **如何调 RbacService:** 不替换,只复用 ——`RbacService.roleHasPermission(roleId, action)`(在现 `getUserPermissionCodes` 基础上加按 role 维度查;或预热角色→码集合缓存)判断"某角色是否含该码";SUPER_ADMIN 短路语义保留。
- **PositionAssignment → 虚拟 RoleBinding:** 不落库,decision 时由 `PositionRolePolicy` 动态推导,scope = 任职组织 + policy.scopeMode。**🔴 R5:仅正职有管理 policy;副职默认无,不产出管理 grant。** 正职默认映射(**BD-1**;同一 `team-leader` 职务按 `conditionJson.nodeTypeCode` 分流,避免每个队长都成 org-admin):`team-leader@headquarters → org-admin@TREE(root)`(全组织业务管理,**不含**平台/RBAC/`*.read.sensitive`)、`team-leader(非 root)/dept-leader → *-manager@TREE(本组织)`、`group-leader → group-manager@EXACT/TREE`。
- **考勤终审中枢(BD-2,可配不写死):** 默认 = APD 部长/副部长任职上的**显式** `RoleBinding(principalType=POSITION_ASSIGNMENT, role=attendance-final-reviewer, scopeType=ORGANIZATION_TREE, scopeId=root)`(落库、可审计)。**实现绝不 hardcode "APD"** —— 终审中枢身份只认 `RoleBinding` 行,可换绑 VOD/TTD/总队办公室,**只改绑定不改代码**。
- **SupervisionAssignment → 监督范围授权(BD-3):** 推导只读"监督角色" `org-supervisor`,**默认含** `member.read.record` / `activity.read.record` / `activity-registration.read.record` / `attendance.read.sheet` / `attendance-record.read.record` / `certificate.read.record`;**默认不含**任何写、`*.read.sensitive`、`attendance.approve/final-approve`、user/role/permission 系统权限。scope = 被分管组织(exact/tree)。需审批/终审 → **必须另加显式 `RoleBinding`**。
- **SUPER_ADMIN:** 全局短路 allow,但仍过 ActionConstraint(自审禁止对 SA 也成立 —— 它是数据完整性不变量,非权限)。
- **global scope:** `UserRole` 迁移来的 `RoleBinding(GLOBAL)`,covers 恒真 —— 完全保持现 `rbac.can` 全局语义,迁移期行为锁不破。
- **organization exact / tree / activity / self / resource:** 见 `covers()`。tree 用 closure;self = `ownerMemberId==memberId`(App 面统一收敛于此)。
- **assigned resource(RESOURCE scope):** 临时把某具体资源(如某张表)授给某人,covers 比对 type+id。

### 5.3 业务约束(ActionConstraint;域不变量层)

按 `action` 注册的小型否决器,在 scope 命中后、返回前执行,对所有人(含 SUPER_ADMIN)生效:

| action | 约束 | reason |
|---|---|---|
| `attendance.final-approve.sheet` | `resource.extra.submitterUserId != user.id`(自己不能终审自己提交) | `self_approval_forbidden` |
| `attendance.final-approve.sheet` | 可配:`reviewerUserId != user.id`(一级与终审是否允许同人;**默认禁止**,可由 config 放开) | `same_reviewer_forbidden` |
| `*.read.sensitive` | 需命中含 sensitive 码的 grant(其实落在 §4.2 权限码粒度;此处仅兜底:`resource.sensitivityLevel=='sensitive'` 且 grant 非 sensitive 码 → deny) | `sensitive_denied` |
| 任意写 | scope org / membership / assignment / supervision 任一过期或 inactive → 不产生授权(已在步骤 3 过滤,此处审计兜底) | `inactive_org` / `expired_grant` |

> **职责分离归属:** "自己不能终审自己"作为域不变量,既可放 ActionConstraint(authz 内,保证"一切授权可解释"),也可放 attendances 的 `PolicyService`(沿 `time-overlap-policy.ts` 范式)。**本稿推荐放 authz ActionConstraint**,使 `authz.explain` 能一站式输出"为何拒绝";attendances service 仍可叠加自己的状态机校验,二者不冲突。

---

## 6. 业务场景推演 [G](真实公告案例)

> 约定:`team-leader/dept-leader/group-leader` 等职务经 `PositionRolePolicy` 映射到管理角色;监督经分管推导到只读 `org-supervisor`;APD 终审经显式 `RoleBinding`。组织:`SECT`(应急通讯队)下挂 `SECT-行动组`(nodeType `group`)。

### 场景 1 — 应急通讯队队长崔广庆 能否管理 应急通讯队行动组 考勤?

- **入库:** `Org(SECT-行动组, parent=SECT, nodeType=group)`;`PositionAssignment(崔广庆, SECT, team-leader, 2026-07-01~2027-06-30, ACTIVE)`;`PositionRolePolicy(team-leader, conditionJson={nodeTypeCode≠'headquarters'} → team-manager@TREE)`(非总队队长走 team-manager;总队队长见场景 6),`team-manager` 含 `attendance.read.sheet` / `attendance.approve.sheet`(一级)、**不含** `attendance.final-approve.sheet`。
- **判断:** 资源 = 行动组某活动的 sheet → `organizationId=SECT-行动组`。崔的职务推导 grant scope=`TREE(SECT)`;closure 存在 `SECT→SECT-行动组` → **covers**。
- **结果:** `attendance.read/approve.sheet` → **ALLOW**(matchedGrant: position, SECT team-leader, TREE)。`attendance.final-approve.sheet` → **DENY(no_permission)**(队长角色无终审码;终审属 APD 中枢,除非运营显式给队长配终审 policy —— 这是配置杠杆,非架构限制)。

### 场景 2 — 行动组组长李鹏 能否管理 行动组 考勤?

- **入库:** `PositionAssignment(李鹏, SECT-行动组, group-leader, ...)`;`PositionRolePolicy(group-leader → group-manager@EXACT)`,`group-manager` 含 `attendance.read/approve.sheet`。
- **判断:** 资源 org=`SECT-行动组`;李的 grant scope=`EXACT(SECT-行动组)` → **covers**(叶子节点,EXACT=TREE)。
- **结果:** 一级 read/approve → **ALLOW**;final-approve → **DENY**。→ 与场景 1 一致:组长在本组范围内可管理一级考勤,终审上交。

### 场景 3 — 副队长黄勇(分管 SECT、SSD)能否查 SECT 数据?能否查 水上搜救队(SWRT)数据?

- **入库:** `PositionAssignment(黄勇, SRVF/队部, vice-captain, ...)`;`SupervisionAssignment(黄勇, SECT, TREE, ACTIVE)` + `SupervisionAssignment(黄勇, SSD, TREE, ACTIVE)`。分管推导 → `org-supervisor`(只读)over `TREE(SECT)` ∪ `TREE(SSD)`。
- **查 SECT 队员数据:** 资源 member 主归属 ∈ `TREE(SECT)` → **covers** → **ALLOW**(matchedGrant: supervision, SECT, TREE)。但 `org-supervisor` 仅 `member.read.record`(脱敏)→ 敏感 PII **masked**(`member.read.sensitive` 未授)。
- **查 SWRT 数据:** `SWRT ∉ {TREE(SECT) ∪ TREE(SSD)}` → 无覆盖 grant → **DENY(out_of_supervised_scope)**。
- **结论:** 分管把"副队长"从"全队可见"收敛为"仅分管范围可见",且只读 + 不破敏感闸门 —— 正是 goal 要的语义。`org-supervisor` 默认码集见 **BD-3**(只读 6 码);黄勇若要审批/终审 SECT 事务,须**另加显式 `RoleBinding`**,头衔与分管都不赋予写权。

### 场景 4 — APD 部长/副部长 能否执行考勤终审?

- **现状:** 仅靠 `biz-admin`(任意 ADMIN)可终审;APD 部长**作为职务**今天无任何特权(职务无模型)。
- **终态入库:** `PositionAssignment(X, APD, dept-leader)`;**显式** `RoleBinding(principalType=POSITION_ASSIGNMENT, principalId=该任职id, role=attendance-final-reviewer, scopeType=ORGANIZATION_TREE, scopeId=SRVF根, ACTIVE)`,`attendance-final-reviewer` 含 `attendance.final-approve.sheet`/`final-reject.sheet`/`read.sheet`。
- **判断:** 任意 sheet org ∈ `TREE(SRVF)`(全部活动挂根树下)→ **covers**。
- **结果:** **ALLOW** —— 但叠加 ActionConstraint:若 `sheet.submitterUserId == X.user.id` → **DENY(self_approval_forbidden)**。→ 这正式落地 Slow-3 挂起的"APD 部长/副部长终审"意图,且补上自审分离。副部长同法绑定(或同岗多 PositionAssignment)。
- **BD-2 —— 终审中枢默认 APD,但绝不写死:** 上面那条 `RoleBinding` 是**配置行**;把它换绑到 VOD / TTD / 总队办公室某任职,终审权即整体迁走,**代码零改**。实现层禁止任何 "APD" 字面量门控(§10.5 风险行 + CI 断言)。

### 场景 5 — 文书组组长 能否上传/维护本部门资料但不能终审?

- **入库:** `PositionAssignment(Y, 某部-文书组, group-leader)`;`group-manager@TREE(文书组)` 含 `attachment.upload.*` / `member-profile.read.record` / `content.*` 等本组管理码,**不含** `attendance.final-approve.sheet`。
- **上传本部门附件:** 资源 org ∈ `TREE(文书组)` → **ALLOW**。
- **终审考勤:** 角色无终审码 → **DENY(no_permission)**。→ 精确实现"管资料 ≠ 管终审"的非对称。

### 场景 6 — 总队队长 是否拥有全队范围?

- **入库:** `PositionAssignment(石欣, SRVF 根, team-leader)`(队长 = §3.2 六职务之一,**无单独 "captain" 职务**);`PositionRolePolicy(team-leader, conditionJson={nodeTypeCode:'headquarters'} → org-admin@TREE)`(BD-1:仅 root 队长映射 org-admin;非 root 队长走 team-manager,见场景 1);`org-admin` = 业务面广管理权限(≈ 现 biz-admin 集,但**排除**平台/RBAC/`*.read.sensitive`)。
- **判断:** scope=`TREE(SRVF根)` covers 全部组织 → 全队业务范围内 **ALLOW**。
- **但 ≠ SUPER_ADMIN(BD-1 采纳方案 A):** `org-admin` **不含**平台/基础设施码(`*.reset.credentials`、`user.update.role`、storage/sms/wechat/realname setting…)、**不含** RBAC 配置码、**不含** `*.read.sensitive`(敏感明文);这些 → **DENY**。且仍受 ActionConstraint(自己不能终审自己)约束。→ 总队长 = "全组织业务管理员",非平台主;正式区分"组织范围顶级管理员"与"平台全局管理员(SUPER_ADMIN)"。

### 场景 7 — 临时活动负责人 如何授权,不误建成长职务?

- **入库:** **不建 PositionAssignment**(那是长期结构职务)。改用 `RoleBinding(principalType=MEMBER, principalId=负责人memberId, role=activity-organizer, scopeType=ACTIVITY, scopeId=该活动id, endedAt=活动结束+宽限, ACTIVE)`。`activity-organizer` 含该活动相关的 `activity.update` / `activity-registration.approve` / `attendance.create.sheet` 等。
- **判断:** 仅当 `resource.activityId == 该活动id` → **covers** → **ALLOW**;其余活动 → **DENY**;到期 `endedAt` 后自动失效。
- **结论:** 活动级临时授权不污染组织结构、自动过期 —— 与"长职务"彻底分开。

---

## 7. API 草案 [H](路径 / 方法 / 职责;不写实现)

> 沿 `AGENTS §21` admin 面前缀 `/api/admin/v1/*` + 轴模型(handoff §5:嵌套子资源即 IA,**不拍平 + 手选父级**)。判权一律 R 模式(service 层 `authz.can`/`rbac.can`),0 `@Roles`。

### 7.1 组织归属(memberships)— 升级 member-departments,沿队员轴嵌套

| 方法 | 路径 | 职责 | 码 |
|---|---|---|---|
| GET | `/api/admin/v1/members/:memberId/memberships` | 列某队员全部归属(主/兼/临时/支援 + 任期) | `membership.list.record` |
| POST | `/api/admin/v1/members/:memberId/memberships` | 新增归属(指定 type) | `membership.set.record` |
| PATCH | `/api/admin/v1/members/:memberId/memberships/:id` | 改类型/任期 | `membership.set.record` |
| DELETE | `/api/admin/v1/members/:memberId/memberships/:id` | 结束/软删某归属 | `membership.end.record` |
| (兼容) | `GET/PUT/DELETE .../department` | 旧单部门端点保留一版,内部映射到 PRIMARY membership | 旧 3 码 deprecated |

### 7.2 职务定义(positions)/ 职务规则(position-rules)— 全局配置面

| 方法 | 路径 | 码 |
|---|---|---|
| GET/POST | `/api/admin/v1/positions` | `position.read/create.definition` |
| GET/PATCH/DELETE | `/api/admin/v1/positions/:id` | `position.read/update/delete.definition` |
| GET/POST | `/api/admin/v1/position-rules`(按 nodeTypeCode 过滤) | `position-rule.read/create.record` |
| PATCH/DELETE | `/api/admin/v1/position-rules/:id` | `position-rule.update/delete.record` |

### 7.3 任职管理(position-assignments)— 双轴:组织轴 + 队员轴

| 方法 | 路径 | 职责 | 码 |
|---|---|---|---|
| GET | `/api/admin/v1/organizations/:orgId/position-assignments` | 某组织在任职务列表 | `position-assignment.read.record` |
| POST | `/api/admin/v1/organizations/:orgId/position-assignments` | 任命(校验 rule/allowMultiple/任期) | `position-assignment.create.record` |
| GET | `/api/admin/v1/members/:memberId/position-assignments` | 某队员任职(含历史) | `position-assignment.read.record` |
| POST | `/api/admin/v1/position-assignments/:id/revoke` | 撤销(写 revokedBy + status=REVOKED) | `position-assignment.revoke.record` |
| GET | `/api/admin/v1/position-assignments/:id/history` | 任职变更/历史链 | `position-assignment.read.history` |

### 7.4 分管管理(supervision-assignments)

| 方法 | 路径 | 职责 | 码 |
|---|---|---|---|
| GET/POST | `/api/admin/v1/supervision-assignments` | 列/建分管(supervisor × org × scopeMode) | `supervision-assignment.read/create.record` |
| GET | `/api/admin/v1/members/:memberId/supervision-scope` | 某队长/副队长的分管范围(展开 tree) | `supervision-assignment.read.record` |
| GET | `/api/admin/v1/organizations/:orgId/supervisors` | 某组织被谁分管 | `supervision-assignment.read.record` |
| PATCH/POST | `/api/admin/v1/supervision-assignments/:id`(改)/`:id/revoke` | 改/撤 | `supervision-assignment.update/revoke.record` |

### 7.5 RoleBinding(scoped 绑定)

| 方法 | 路径 | 职责 | 码 |
|---|---|---|---|
| GET/POST | `/api/admin/v1/role-bindings` | 列/建(principal × role × scope × 任期;支持 user/member/position_assignment/resource/activity scope) | `role-binding.read/create.record` |
| PATCH/DELETE | `/api/admin/v1/role-bindings/:id` | 改任期/状态、软删 | `role-binding.update/delete.record` |

### 7.6 权限解释(authz/explain)— 可解释性出口

| 方法 | 路径 | 职责 | 码 |
|---|---|---|---|
| POST | `/api/admin/v1/authz/explain` | 入:`{ userId, action, resourceRef? }`;出:`AuthzDecision`(allow/deny + reason + matchedGrant + resolved resource)= "谁因哪个角色/职务/分管、在什么范围、对什么资源、被允许/拒绝" | `authz.explain.decision` |

---

## 8. 数据迁移策略 [I]

### 8.1 MemberDepartment → MemberOrganizationMembership

- **推荐:净新建表 + 回填 + 重指向(可逆、行为锁友好)。** 建 `member_organization_memberships`;把每条 active `MemberDepartment` 回填为 `membership(type=PRIMARY, startedAt=createdAt, status=ACTIVE)`;`member-departments` service 重指向新表读写,旧端点保留一版做 PRIMARY 兼容映射。一版后下线旧表。
- **备选:就地改名 + 加列 + 回填**(单 migration rename `MemberDepartment`→新表名 + 加列 + backfill PRIMARY)。更"终态干净"但 rename 破坏性大、与 e2e/契约耦合;视维护者风险偏好二选一。
- partial unique 由 `MemberDepartment_memberId_active_key` 升级为 `member_org_membership_primary_active_unique`(只约束 PRIMARY)。

### 8.2 UserRole → RoleBinding(scope=global)

- 建 `role_bindings`;每条 `UserRole` 回填为 `RoleBinding(principalType=USER, principalId=userId, roleId, scopeType=GLOBAL, status=ACTIVE)`。
- **`RbacService.getUserPermissionCodes` 重指向**读 `RoleBinding(scopeType=GLOBAL)`(等价替换 UserRole 读),**全局判权语义逐字不变**(行为锁);`UserRole` 双写保留一版后下线。
- `AuthzService` 读全量 `RoleBinding`(含 scope)。**迁移期 `authz.can` 对"无 resourceRef + global grant"退化为等同旧 `rbac.can`** —— 模块逐个切,不需一次性全切。

### 8.3 Organization 补组级节点 + closure + reparent

- `node_type` 字典**只加 `group` 一值**(R1);筹备组用 `Organization.establishmentStatusCode='provisional'` 表达,**不新增 `preparatory-group` nodeType**。另加字典 `org_establishment_status`(formal/provisional)+ 留口字典 `group_function`(R3);`Organization` 加 `establishmentStatusCode?` / `groupFunctionCode?` 两 additive 列(见 §3.0.1)。防误删守卫沿 dict 内置范式。
- 建 `organization_closure`,由现有 `parentId` 树 `WITH RECURSIVE` 一次性回填(含 depth-0 自身行)。
- 新增 `org.move.node`(reparent):复活死 BizCode `ORGANIZATION_PARENT_CYCLE` 做环检测、`ORGANIZATION_PARENT_CHANGE_FORBIDDEN` 做受限位置守卫;move 时事务内重算受影响子树 closure。
- 现有"扁平两层" seed 不动;组级由运营/导入在队/部下加挂。

### 8.4 导入 2026 任命公告(必须先生成待确认清单)

- **🔴 铁律(R7)双锚确认:人按 `memberNo`/`memberId`、组织按 `code`,绝不靠姓名自动落库。**
- **人员锚定:** 姓名仅作展示,确认键 = `memberNo` 唯一命中 active member。**同名/带编号(李翔 18130 vs 18131、李美玲 20065)**:仅当 staging 行带明确 `memberNo` 且唯一命中才可确认;姓名多义 → 阻断,标记"需人工指定 memberId"。
- **组织锚定(R7):** 公告用组织"名"且**自相矛盾**(特勤部/特殊勤务部、高空绳索技术队/高空救援队、志愿者管理部/志愿者组织部、少年辅助队/少辅队),故组织一律按 `Organization.code` 锚定;名称对不上 → 人工别名确认(或上线时把 `Organization.name` 运营改成公告口径)。可选 `Organization.aliases String[]` 辅助匹配,**绝不按 name 自动落组织**。
- **流程:** 解析公告 → 生成 staging 待确认行(人 `memberNo` + 组织 `code` + 职务/分管)→ 需新建的 ~50 个组先按"父队/部 code + 组名"建 `Organization`(`group`;筹备组带 `establishmentStatusCode='provisional'`)→ 人工逐条确认 → 确认后才落 `PositionAssignment`(+ 必要 `Membership`;**总队级领导 `requireMembership=false`,R8,不强制建 root 归属**)。
- **分管**单独一张 staging(supervisor `memberNo` × 被分管组织 `code` × scopeMode),人工确认后落 `SupervisionAssignment`;名称漂移(如"特殊勤务部"=SSD)同样按 `code` 解析。
- **终审中枢绑定(BD-2):** seed/导入末尾建一条**显式** `RoleBinding`(默认绑 APD 部长任职 → `attendance-final-reviewer`@tree(root))。**该行是终审中枢的唯一真相、可换绑**;代码层不得 hardcode 部门。
- **组长归属(BD-4):** 组长/副组长**只落 `PositionAssignment`**;主归属(`PRIMARY` membership)留队/部/中心级,**不为组级强建 membership**(组内正式成员统计如需,后续用 `SECONDARY` 补,不作任职前置)。
- 导入是受控 admin 工具(`appointmentSource='announcement-2026'` 标源),非自动批写;全程 AuditLog。

---

## 9. 测试矩阵 [J]

> 沿仓内 unit + e2e(runInBand)+ contract(OpenAPI snapshot)三层;判权改动必跑对应模块 e2e + characterization;改 DTO/路径/Swagger/错误码必跑 `test:contract`;改 seed 必同步 3 个 seed snapshot spec + `EXPECTED_ROUTES`。

| # | 维度 | 类型 | 断言要点 |
|---|---|---|---|
| 1 | 组织树 scope EXACT | unit(covers)+ e2e | EXACT 仅命中本节点,不命中子/兄弟 |
| 2 | 组织树 scope TREE | unit + e2e | TREE 命中本节点 + 全部后代(closure);不命中树外 |
| 3 | closure 正确性 | unit | reparent 后子树祖先链重算正确;环被 `ORGANIZATION_PARENT_CYCLE` 拦 |
| 4 | 任职有效期 | e2e | `now > endedAt` 的任职**不产生授权**(expired_grant) |
| 5 | 任职撤销 | e2e | `status=REVOKED` 后即刻不授权;历史可查 |
| 6 | 分管关系 | e2e | 分管 SECT/SSD → 命中;SWRT → out_of_supervised_scope |
| 7 | 分管只读 | e2e | 监督角色可 read 不可 write;敏感 masked |
| 8 | global RoleBinding | e2e + characterization | UserRole 迁移后全局判权逐字等同旧 `rbac.can`(行为锁) |
| 9 | position 推导 grant | e2e | 队长/组长经 policy 获本树管理权;policy 失活后立即收回 |
| 10 | 自己不能终审自己 | e2e | submitter==final-approver → `self_approval_forbidden`(SA 也拦) |
| 11 | 一级≠终审(默认) | e2e | reviewer==final-approver → `same_reviewer_forbidden`(可配开) |
| 12 | APD 终审规则 | e2e | APD 部长任职 + 显式 tree(root) 绑定 → 可终审任意部门;非 APD 部长无终审 |
| 13 | 文书不能终审 | e2e | 文书组长可上传资料,final-approve → no_permission |
| 14 | 副队长只能分管范围内可见 | e2e | 见 #6/#7 组合 |
| 15 | 过期/inactive 任职/分管/绑定 不生效 | e2e | 任一过期或 status≠ACTIVE → 不授权 |
| 16 | inactive organization 不生效 | e2e | scope org `INACTIVE` → covers 返 false(inactive_org) |
| 17 | 敏感不自动放开 | e2e | 部长(read.record)读敏感 → masked;另授 read.sensitive 才明文 |
| 18 | 全局 vs 组织管理员分清 | e2e | 总队长(org-admin@tree)不能调 `*.reset.credentials` / `user.update.role` |
| 19 | 活动级临时授权 | e2e | activity scope 仅该活动 ALLOW;到期失效;不污染组织结构 |
| 20 | authz/explain 稳定 | contract + e2e | 同输入 → 稳定 reason + matchedGrant 结构;deny 原因可解释 |
| 21 | SUPER_ADMIN 短路 | e2e | 任意 action allow,但自审约束仍生效 |
| 22 | seed 完整性 | e2e snapshot | 新增 ~25 码 + 新角色绑定与三个 snapshot spec 对账;`EXPECTED_ROUTES` 增量正确 |
| 23 | **副职零管理(R5 红线)** | unit + e2e | 副队长/副部长/副组长 PositionRolePolicy 管理角色集为空;仅持副职头衔(无分管/绑定)对管理 action → DENY |
| 24 | 兼任(R2)| e2e | 赵强 两条 active PA(SRVF 副队长 + SAMT 队长 `isConcurrent`)并存;授权按各自 scope 独立判,命中即记 matchedGrant |
| 25 | 总队级免归属(R8)| e2e | `headquarters` 队长/副队长 `requireMembership=false` 可任命且不强建 root 归属;组长 `requireMembership=true` 校验子树归属 |

---

## 10. 风险与取舍 [K]

### 10.1 必须做的终态能力(不做则架构不成立)

- 组织 closure + 组级节点(`group`)+ 筹备组状态(`establishmentStatusCode=provisional`,R1)+ reparent。
- `OrganizationPosition` / `PositionRule` / `PositionAssignment`(含任期/历史)。
- `OrganizationSupervisionAssignment`(与职务正交)。
- `RoleBinding`(scope + 任期)+ `PositionRolePolicy`。
- `AuthzService` + `ResourceResolver` + ActionConstraint(自审/敏感)。
- `MemberOrganizationMembership`(主/兼/临时/支援 + 任期)。

### 10.2 可后续做、但 schema 必须提前留口

- **ACTIVITY / RESOURCE scope:** 模型(`RoleBinding.scopeActivityId/scopeResourceType/scopeResourceId`)本稿即建,接线(临时活动负责人、资源级授权)可后切。
- **16 个 `attachment.*.self` 收敛为 SELF scope:** 留口不强收(避免 churn)。
- **QueryService 读 scope 下推**(把 tree scope 变成列表查询 where):架构边界标记为 deferred(architecture-boundary §3.2/§8),先做点判权(`can`),列表过滤后续接 `ScopeResolver + QueryService`(AGENTS D-7 触发器)。
- **监督角色可配化**(目前默认只读 org-supervisor;未来若需"分管可代签"等写权,经 policy 扩,不改架构)。
- **组功能 `groupFunctionCode` 留口(R3):** v1 只占列;未来按组功能差异化职务规则(文书干事、标准组制标权)再启用。

### 10.3 应废弃的旧设计限制

- 一人一部门(→ 主归属唯一 + 多兼属)。
- 无任期(→ Membership/Assignment/Supervision/RoleBinding 全有 startedAt/endedAt)。
- 无跨部门角色(→ SECONDARY/SUPPORT membership + SupervisionAssignment)。
- 同步更新:schema D-1 注释、`participation-bounded-context.md:105`、`handoff/admin-web.md:136`、`current-state.md §3`、`RBAC_MAP §5`。

### 10.4 绝不能破坏

- `SUPER_ADMIN > ADMIN > USER` 三档 + `users.policy.ts` 永久共存;`RbacService.can()` 全局语义(AuthzService 包住、迁移期行为锁)。
- 判权单轨 service 层、0 `@Roles`、controller 仅 `JwtAuthGuard`。
- **🔴 R5 副职不自动推导管理(本稿新增安全红线):** `副队长 / 副部长 / 副组长` 头衔默认零管理 scope;管辖只来自分管或显式绑定;**分管独立于职务,scope 绝不从头衔推导**(详见 §5.2 安全默认 / §3.7)。
- App 面 scope=self 由 `memberId` 驱动、禁 `role` 短路(SELF scope 即其表达)。
- 软删铁律、BizCode 段位、`AuditLog` 写后不可改、3 个 seed snapshot 行为锁。
- 不建 `common/utils`/`shared-services`/`*.repository.ts`;新类落 `authz/` 模块内。

### 10.5 权限扩大风险点(必须显式防御)

| 风险 | 触发 | 防御 |
|---|---|---|
| tree(root) 误成近全局 | 任何绑定误锚到根树 | 锚根树的绑定走显式审批 + 审计高亮;`authz/explain` 暴露 scopeId=root 告警 |
| **🔴 副职头衔自动得管理 scope(R5)** | 误给副队长/副部长/副组长配管理 policy | **副职默认零管理 policy**;管辖只经分管/显式绑定;**CI 断言副职 policy 集为空** |
| 部长误获全树终审 | 通用 `部长→admin@tree` policy | 终审属**显式 RoleBinding 到具体任职**,不进通用 policy;policy 只给本树管理,不含 final-approve |
| **终审中枢被 hardcode(BD-2)** | 代码写死"APD 终审" | 终审权**只认 `RoleBinding` 行**;**CI 断言代码无 "APD" 字面量门控**;换绑即迁移终审权 |
| **队长@root 过宽(BD-1)** | `org-admin` 角色误含平台/敏感码 | `org-admin` 码集**显式排除** `*.reset.credentials`/`user.update.role`/`*.read.sensitive`/RBAC 配置;**snapshot 锁该角色码集** |
| 分管获写权 | 监督角色含写码 | 默认监督角色严格只读;扩写权须单独 policy + 审计 |
| SELF 与 org scope 混淆 | resolver ownerMemberId 误填 | resolver 单测覆盖每类资源;fail-close |
| 兼属叠加越权 | 多 SECONDARY 叠加 scope | 每条 grant 独立判 scope,covers 命中即记 matchedGrant,可逐条审计 |

### 10.6 必须审计记录

- 每次 PositionAssignment / SupervisionAssignment / RoleBinding 的 create / update / revoke / 软删(`resourceType` 扩对应 String 值)。
- 公告导入的每条 staging 确认与落库(`appointmentSource` + actor)。
- 敏感读(`*.read.sensitive`)命中。
- 可选:`authz` deny 采样(便于排查"为什么不行")。

---

## 11. 建议落地 PR 拆分(仅参考,不为拆分牺牲终态)

> 每个 PR 均 D 档、characterization-first、行为锁迁移(先与旧语义对齐再开新能力)。顺序保证"任何时刻 main 可用、旧行为不破"。

| PR | 主题 | 关键交付 | 行为变化 |
|---|---|---|---|
| **T0** | 评审冻结 | 本稿 + 决策点拍板(goal 授权) | 0 |
| **PR1** | 组织基座 | `organization_closure` + 回填 + `org.move.node` reparent(复活死 BizCode)+ `node_type` 加 `group` + `Organization` 加 `establishmentStatusCode?`/`groupFunctionCode?`(R1/R3)| 加能力,旧不破 |
| **PR2** | Membership | `member_organization_memberships` + 回填 PRIMARY + member-departments 重指向(兼容旧端点) | 行为锁(PRIMARY=旧单部门) |
| **PR3** | 职务定义 | `OrganizationPosition` + `OrganizationPositionRule`(R6 一类多领导称谓 + R8 `requireMembership` 可配)+ seed **6 领导职务目录**(R4;STAFF 留口不 seed)+ CRUD | 加配置面 |
| **PR4** | 任职 | `OrganizationPositionAssignment`(含 `isConcurrent`,R2)+ CRUD + 历史端点 | 加数据面(未接授权) |
| **PR5** | 分管 | `OrganizationSupervisionAssignment` + CRUD | 加数据面(未接授权) |
| **PR6** | RoleBinding | `role_bindings` + 回填 UserRole→global + `RbacService` 重指向 global 读 | **行为锁**(全局判权逐字不变) |
| **PR7** | 职务→角色 policy | `OrganizationPositionRolePolicy` + seed 默认映射(**🔴 仅正职;副职零管理,R5** + CI 断言)+ seed `org-admin`(队长@root,BD-1,排除平台/敏感/RBAC 码)与 `org-supervisor`(BD-3 只读码集)角色 | 加配置(未接授权) |
| **PR8** | AuthzService | `authz/` 模块:`AuthzService` + `ResourceResolver`,先做到与 `rbac.can` global 等价 | **行为锁**(无 resource 时退化等旧) |
| **PR9** | 考勤终审切 scoped | 终审切 `authz.can` + 自审 ActionConstraint + **可配置终审中枢 `RoleBinding`(默认 APD,不 hardcode,BD-2;CI 断言无 "APD" 字面量)** | **首个真实 scoped 收紧**(Slow-3 正式解) |
| **PR10** | 可解释性 | `POST authz/explain` | 加端点 |
| **PR11** | 公告导入 | staging 待确认清单 + **org `code` + `memberNo` 双锚**落库工具(R7)+ 批量建组节点 | 加工具 |
| **PR12+** | 逐面迁移 | 其余模块 `rbac.can`→`authz.can`(scoped),按 surface 分批 | 逐面收紧 |

---

## 附:可解释性总纲(贯穿全稿的硬约束)

> 任一授权结果都能回答:**谁(principal:user/member)— 因哪条授权(RoleBinding / PositionAssignment+Policy / SupervisionAssignment / SUPER_ADMIN)— 在什么范围(scopeType + scopeId)— 对什么资源(resolved organizationId/owner/activity)— 被允许或拒绝(reason)**。这条由 `AuthzDecision.matchedGrant` + `authz/explain` 端点强制兑现 —— 是整套设计区别于"扁平 RBAC"的根本价值,也是运维/审计/前端工作台可信的地基。

---

## 12. 公告映射验证(2026 任命公告反推)

> 方法:把《深圳市公益救援志愿者联合会 2026 年任命公告》全文逐类拆解,反向映射到 §3 的六类模型对象(Organization / Position / PositionAssignment / SupervisionAssignment / RoleBinding / Membership),用真实样例压测模型,标出无法优雅表达处,并就发现的问题直接给修订建议(R1–R8)。**本章只验证与提修订,不改前文;修订经拍板后再折回 §2/§3/§5/§8。**

### 12.1 逐类拆解与规模统计

公告任命落在 **12 个领导组织 + 总队**;另有 **50± 个组(含 2 个筹备组)需新建为 Organization 节点**;另有 **12 条分管关系**。组织口径与 seed 的 code 对账(name 漂移见 R7):

| 公告组织(名)| seed code / name | 领导职务用词 | 正职 | 副职 | 下属组(组长数)| 筹备组 |
|---|---|---|---|---|---|---|
| 总队 | SRVF / 深圳公益救援队 | 队长/副队长 | 队长 ×1(石欣)| 副队长 ×6 | —(组挂各队/部下)| — |
| 山地救援队 | SMRT / 山地救援队 | 队长/副队长 | ×1 | ×2 | 训练(3)/装备(3)/文书(2)| — |
| 水上搜救队 | SWRT / 水上搜救队 | 队长/副队长 | ×1 | ×3 | 训练/装备/文书/外展 + **潜水组(筹)** | 1 |
| 城市搜救队 | SURT / 城市搜救队 | 队长/副队长 | ×1 | ×3 | 训练(**6**)/装备(3)/文书(2)/**搜救犬**(1)| — |
| 高空绳索技术队 | STRT / 高空救援队 ⚠名漂移 | 队长/副队长 | ×1 | ×3 | 训练/装备/文书/**飞辅**(含 李翔#18130)| — |
| 医疗辅助队 | SAMT / 医疗辅助队 | 队长/副队长 | ×1 **赵强(兼)**| ×3 | 训练(含 李翔#18131)/装备/文书/**心理**/**行动** | — |
| 应急通讯队 | SECT / 应急通讯队 | 队长/副队长 | ×1(崔广庆)| ×3 | 行动(1+3)/装备(1+3)/文书(1+3)/训练(1+3)| — |
| 信息指挥中心 | ICC / 信息指挥中心 | **部长/副部长** | ×1 | ×1 | 统筹/技术/标准/文书/**无人机** | — |
| 特勤部 | SSD / 特勤部 ⚠分管段称"特殊勤务部" | 部长/副部长 | ×1 | ×3 | 物资(6)/交通(5)/文书(5)+ **炊事保障组(筹)** | 1 |
| 行政外联部 | APD / 行政外联部 | 部长/副部长 | ×1(陈聪)| ×3 | **文秘**/传媒/外联 | — |
| 志愿者管理部 | VOD / 志愿者组织部 ⚠名漂移 | 部长/副部长 | ×1 | ×1 | 招新/宣导/荣誉 | — |
| 技术培训部 | TTD / 技术培训部 | 部长/副部长 | ×1 | ×3 | 培训/文书(含 李美玲#20065)/**教委执行** | — |
| 少年辅助队 | STAT / 少辅队 ⚠名漂移 | **部长/副部长**(队却用部长)| ×1 | ×1(海滨)| 总务/导师/文书/项目 | — |

**分管(12 条,7 人):** 石欣→STAT;陈媛→SURT、TTD;黄勇→SECT、SSD(称"特殊勤务部");金洋→STRT(称"高空救援队")、ICC;吴冰宁→SWRT;赵强→SAMT、SMRT;卓晓玲→APD、VOD。
**关键观察:** 公告把"队长/副队长"列为总队头衔(seniority),又**单列"分管队长分工"把每个具体管辖责任分配出去**——连总队队长石欣都另有一条"分管 STAT"。这说明真实组织里**头衔(rank)与管辖范围(scope)是解耦的**,管辖权主要由"分管"承载,而非头衔自动赋予 → 直接验证 §5 的"职务不天然 = 管理员",并引出 R5。

### 12.2 公告文本 → 模型对象 映射表

| 公告文本(代表句)| Organization | Position | PositionAssignment | SupervisionAssignment | RoleBinding(经 policy/显式)| Membership |
|---|---|---|---|---|---|---|
| 队长:石欣(总队)| SRVF(已存)| 队长 | (SRVF, 队长, 石欣, 任期)| 另见分管(石欣→STAT)| policy→org-admin@tree(root) **或薄(R5)** | 石欣 PRIMARY 在其本队;root 不强制归属(R8)|
| 副队长:陈媛…(总队 ×6)| SRVF | 副队长 | (SRVF, 副队长, 每人)×6 | 见分管段(各自分管)| **薄/无(R5)**;实际权来自分管 | 各自本队 |
| 山地救援队 队长:王志伟 | SMRT(已存,code 对齐)| 队长 | (SMRT, 队长, 王志伟)| — | team-manager@tree(SMRT)| 王志伟 PRIMARY=SMRT |
| 训练组组长:林敦锋、张姗姗、赵刚 | **SMRT-训练组(新建,group,parent=SMRT)** | 组长(allowMultiple)| (SMRT-训练组, 组长, ×3)| — | group-manager@tree(组)| 三人 membership 落 SMRT 子树 |
| 潜水组(筹)组长:蔡昌志 副组长:胡逸飞 | **SWRT-潜水组(新建,group + provisional 标记,R1)** | 组长 / 副组长 | (…,组长,蔡昌志)/(…,副组长,胡逸飞)| — | 组长 group-manager;副组长 薄(R5)| 子树 |
| 队长:赵强(兼)(SAMT)| SAMT | 队长 | (SAMT, 队长, 赵强, **isConcurrent=true**,R2)| 见分管(赵强→SAMT、SMRT)| team-manager@tree(SAMT)| 赵强 PRIMARY 可能在别处 |
| 飞辅组组长:姬颖、李翔(18130)| STRT-飞辅组(新建)| 组长 | (…,组长,姬颖)/(…,组长,**member#18130**)| — | group-manager | 子树 |
| 训练组组长:…李翔(18131)(SAMT)| SAMT-训练组(新建)| 组长 | (…,组长,**member#18131**)← 与 18130 异人 | — | group-manager | 子树 |
| 信息指挥中心 部长:杨洪杰 | ICC(已存)| **部长**(中心用部长)| (ICC, 部长, 杨洪杰)| — | dept-manager@tree(ICC)| PRIMARY=ICC |
| 少年辅助队 部长:黄哲刚 | STAT(已存,名漂移 R7)| **部长**(队却用部长,R6)| (STAT, 部长, 黄哲刚)| — | dept-manager@tree(STAT)| PRIMARY=STAT |
| 行政外联部 部长:陈聪 | APD | 部长 | (APD, 部长, 陈聪)| — | dept-manager@tree(APD) **+ 显式 attendance-final-reviewer@tree(root)**(APD 终审中枢)| PRIMARY=APD |
| 黄勇分管:应急通讯队、特殊勤务部 | —(SECT、SSD 已存)| — | — | (黄勇→SECT,tree)/(黄勇→SSD,tree)×2;"特殊勤务部"=SSD(R7)| org-supervisor 只读 @这两树 | — |

### 12.3 真实样例端到端验证(12 个)

> 每例:数据如何入库 → AuthzService 如何命中 → 结论。

1. **总队队长 石欣** — PA(SRVF, 队长)。policy 把"队长"映射为 `org-admin@tree(own org)`;own org=SRVF 根 ⇒ scope=tree(root) 覆盖全组织。⇒ 在全组织业务面 **ALLOW**(matchedGrant: position, root, tree),但不含平台码 ⇒ 平台/凭证类 **DENY**(= 组织顶级管理员 ≠ SUPER_ADMIN,场景 6)。**注:** 是否让"队长@root"自动得全组织管理,是 policy 选择(R5);公告同时给石欣"分管 STAT"显示真实意图更偏"管辖经分管下放"。
2. **副队长 黄勇** — PA(SRVF, 副队长)+ SA(SECT,tree)+ SA(SSD,tree)。副队长 policy = 薄/无(R5)⇒ 头衔不赋管辖。看 SECT 队员 → 命中 supervision(SECT,tree) **ALLOW(只读、敏感 masked)**;看 SWRT → 无覆盖 **DENY(out_of_supervised_scope)**。✅ 验证"副队长只能分管范围内可见"。
3. **专业队队长 王志伟(SMRT)** — PA(SMRT, 队长)→ team-manager@tree(SMRT)。管 SMRT-训练组考勤(组 ∈ SMRT 子树,closure)→ 一级 **ALLOW**;终审 → **DENY**(终审属 APD 中枢)。✅
4. **职能部门部长 陈聪(APD)** — PA(APD, 部长)→ dept-manager@tree(APD);**额外**显式 RoleBinding(principalType=POSITION_ASSIGNMENT, role=attendance-final-reviewer, scope=tree(root))。⇒ 可对**任意部门**考勤终审(场景 4),叠加自审约束(若自己是 submitter → DENY)。✅ **注:** "由 APD 承担全队终审"是 schema 现有注释口径;究竟哪个部门是终审中枢可换(模型用显式绑定,可改),非写死。
5. **组长 李鹏(SECT-行动组)** — PA(SECT-行动组, 组长)→ group-manager@tree(行动组,叶子=EXACT)。管本组考勤一级 **ALLOW**;终审 **DENY**。✅
6. **副组长 刘河北(SECT-行动组)** — PA(SECT-行动组, 副组长)→ 薄/只读(R5)。读本组 **ALLOW**;写/终审 **DENY**。✅ 验证副职不自动得管理权。
7. **筹备组 潜水组(筹)蔡昌志(SWRT)** — Org(SWRT-潜水组, group + **provisional**,R1, parent=SWRT)+ PA(组长)。授权与普通组一致;转正 = 清 provisional 标记,**任命/历史不丢**(R1 优于"独立 nodeType")。✅
8. **分管队长 金洋** — SA(STRT,tree)+ SA(ICC,tree),在这两组织**无任何 position**。看 STRT/ICC 数据 → 命中 supervision **ALLOW(只读)**;看其它 → **DENY**。✅ 验证分管是独立授权源、可跨"专业队 + 职能部门"。
9. **同名带编号 李翔(18130) vs 李翔(18131)** — 两个 Member(memberNo 18130 / 18131),各落不同 PA:(STRT-飞辅组, 组长, #18130)与(SAMT-训练组, 组长, #18131)。导入**必须按 memberNo 锚定**,姓名"李翔"绝不可自动落库。✅ 验证 §8.4 导入铁律;另 李美玲(20065)虽本公告只现一次也带号 ⇒ 说明编号是 membership 系统 memberNo、作者已预消歧。
10. **兼任 赵强(兼)** — 两条并存 PA:(SRVF, 副队长)+(SAMT, 队长, **isConcurrent=true**,R2);再加 SA(SAMT,tree)+ SA(SMRT,tree)。⇒ 同一人:1 个总队副职 + 1 个队正职(兼)+ 2 条分管。授权按每条独立判、命中即记 matchedGrant。✅ 验证 `allowConcurrent` + 职务/分管正交;`isConcurrent` 标记忠实回填"（兼）"。
11. **部长领衔的"队" 黄哲刚(STAT)** — STAT 是 rescue-team(队),却用"部长/副部长"。PA(STAT, 部长)。要求 OrganizationPositionRule(rescue-team) **同时允许 队长 与 部长**两种领导职务(R6),由实际任命择一。✅ 模型可表达,但 Rule 不能强制"一类组织唯一领导命名"。
12. **多人共职 SURT-训练组(6 组长)/ SSD-物资组(6 组长)** — Position(组长, allowMultiple=true, maxCount=null)。6 条 PA 并存合法。✅ 验证 allowMultiple + 不设上限默认。

**三轴独立的强验证(黄勇):** 他的"归属(Membership=某本队)/ 任职(Position@SRVF 根)/ 分管(Supervision@SECT、SSD)"三者组织全不同 —— 模型把"在哪里属于、领导什么、监督什么"三轴彻底解耦,这是真实公告反复出现的形态(石欣、赵强、金洋同理)。✅

### 12.4 模型经受住的验证点(无需改)

- **code 稳定、name 可漂移** → 12 组织全部按 code 命中,3 处 name 漂移不影响模型(只影响导入,见 R7)。
- **scope 锚在"任职所在组织"** → 同一个"队长"职务,石欣@root 得全组织、王志伟@SMRT 只得 SMRT 子树,无需为"总队长"单设职务。
- **三轴解耦(归属/任职/分管)** → 黄勇、赵强、金洋、石欣全部成立。
- **职务/分管正交** → 赵强既是 SAMT 队长又分管 SAMT(冗余但无冲突,两 grant 并存)。
- **allowMultiple / allowConcurrent / 任期 / 历史** → 6 组长、(兼)、任期 2026-07-01~2027-06-30 全部落位。
- **memberNo 消歧** → 李翔 18130/18131、李美玲 20065 正是 §8.4 设计的用例。

### 12.5 无法优雅表达 / 需注意之处

| # | 现象(公告证据)| 现设计的别扭 | 性质 |
|---|---|---|---|
| a | 筹备组 潜水组(筹)/炊事保障组(筹)| §3.8/§8.3 把"筹"做成独立 nodeType `preparatory-group`,与普通组结构全同,只设立状态不同;转正要改 nodeType 且需为该 nodeType 复制一份 group 的 PositionRule | 建模别扭 → **R1** |
| b | 赵强(兼)、潜在多兼任 | PositionAssignment 无"兼任"结构化标记,只能塞 `note` | 回填失真 → **R2** |
| c | 26± 种组功能(训练/装备/文书/外展/搜救犬/心理/行动/统筹/标准/无人机/物资/交通/炊事/文秘/传媒/外联/招新/宣导/荣誉/培训/教委/总务/导师/项目…)| 功能只在 `Organization.name`,无法按"组功能"做规则(如"文书组才可设文书干事")| 留口缺失 → **R3** |
| d | 公告无独立"文书/装备/训练"个人干事,全是"X 组 + 组长" | §2.2 把"文书/装备/训练"列为 Position,与真实数据不符(它们是组)| 目录冗余 → **R4** |
| e | 总队 6 副队长 + 各自分管;副组长成片 | 若副职 policy 推导管理角色,副队长@root 会各得近全组织管理 = 反模式 | **安全陷阱** → **R5** |
| f | STAT/ICC 用"部长"领衔,SAMT/SECT 用"队长" | 同 nodeType(rescue-team)领导命名不统一,Rule 需允许多领导职务 | 规则放宽 → **R6** |
| g | 高空绳索技术队/高空救援队、特勤部/特殊勤务部、志愿者管理部/志愿者组织部、少年辅助队/少辅队 | 公告用"名"且自相矛盾;导入只按名会错配 | 导入风险 → **R7** |
| h | 黄勇/石欣 任职 org ≠ 归属 org;总队级领导是否"归属"于根 | requireMembership 对总队级领导若强制=true 会逼出无意义的 root 归属 | 规则细化 → **R8** |

> 结论:**未发现"模型根本表达不了"的硬失败**;以上全部是可加列/可放宽规则/可补导入步骤的精修。模型主干(Organization+closure / Position / Assignment / Supervision / RoleBinding(scope) / Membership)在全量真实公告下成立。

### 12.6 修订建议 R1–R8(✅ 2026-07-01 已采纳并折回正文;以下保留为修订溯源)

> 注:下列各条的 `〔改 §X〕` 是**立项当时的建议锚点**;正文**权威落点以 §12.7 的"已折回"映射为准**(二者不冲突,§12.6 仅作修订溯源)。

- **R1〔改 §3.8/§8.3〕筹备组用状态标记,不用独立 nodeType。** `Organization` 加可空 `establishmentStatusCode`(字典:`formal` / `provisional`;或 `provisional Boolean @default(false)`),**nodeType 仍 `group`**。理由:筹备组结构 = 普通组,只设立状态不同;转正 = 翻标记(免改 nodeType、免复制 PositionRule、保任命与历史)。`node_type` 字典因此**只需加 `group` 一值**(撤回原"加 group + preparatory-group 两值")。
- **R2〔改 §3.4〕PositionAssignment 加 `isConcurrent Boolean @default(false)`。** 忠实回填"（兼）",支持"查谁兼任";不影响授权(并存 PA 都生效)。
- **R3〔留口,改 §3.0 注 + §10.2〕组功能留列位。** 预留可空 `Organization.groupFunctionCode`(字典 `group_function`:training/equipment/clerk/action/standard/...),v1 不写逻辑、只占列;未来按组功能做差异化规则(文书干事、标准组制标权)再启用。避免把功能塞进 name 后无法查询。
- **R4〔改 §2.2 表注 + §3.2 职务目录 seed〕职务目录 v1 收敛为 6 个领导职务。** 队长 / 副队长 / 部长 / 副部长 / 组长 / 副组长。`PositionCategory.STAFF`(文书/装备/训练个人干事)**保留为留口、本公告不 seed**(公告里它们是组,不是职务)。订正 §2.2 中"文书/装备/训练是 Position"的措辞为"在本会是组(Organization)"。
- **R5〔改 §3.7/§5.2/§5.3〕(最重要,安全)副职默认不推导管理角色。** `OrganizationPositionRolePolicy` 默认只为**正职**(队长/部长/组长)映射管理角色;**副职(副队长/副部长/副组长)默认映射到"无角色"或极薄只读角色**,其管辖权来自显式 `RoleBinding` 或(对副队长)`SupervisionAssignment`。否则总队 6 副队长各得近全组织管理 = goal 明禁的"部长=管理员"。同时把"头衔 ≠ 管辖范围(管辖经分管/显式绑定下放)"写成 §5 的判权默认。
- **R6〔改 §3.3 注〕一个 nodeType 可登记多个 allowed 领导职务。** OrganizationPositionRule 允许 rescue-team 同时挂"队长"与"部长"(STAT 用部长、SAMT 用队长),由实际任命择一;Rule 用于"可设哪些职务",不强制单一领导命名。
- **R7〔改 §8.4〕导入:组织也必须按 code 对齐,名称漂移走人工别名确认。** 公告自带名称矛盾(特勤部/特殊勤务部、高空绳索技术队/高空救援队、志愿者管理部/志愿者组织部、少年辅助队/少辅队)。导入 staging 除"人按 memberNo"外,**组织按 code 锚定**;名称对不上 → 人工别名确认(或上线时把 `Organization.name` 运营改成公告口径)。可选 `Organization.aliases String[]` 辅助模糊匹配,**绝不按 name 自动落组织**。
- **R8〔改 §3.3 注 + §2〕requireMembership 按(nodeType, position)可配;总队级领导可设 false。** 总队长/副队长不必"归属"于根(其 PRIMARY 在本队);组长/副组长则应要求在本组织子树内有 active 归属(一致性校验)。把"归属/任职/分管三轴独立"在 §2 显式强调(黄勇/赵强/金洋为证)。

### 12.7 验证结论

2026 任命公告**全量可被终态模型表达**,且公告里"头衔 + 单列分管"的结构**反向印证**了本设计的两大支柱——职务与分管分离、scope 由绑定/分管承载而非头衔自动赋予。需要的调整全是精修(R1 筹备组状态化、R2 兼任标记、R5 副职不推导管理为最关键),**无须推翻任何主干模型**。**R1–R8 已于 2026-07-01 全部折回正文对应章节** —— R1→§3.0.1/§8.3/§10.1;R2→§3.4/§2.3;R4→§2.2/§3.2;R5→§3.7/§5.2/§10.4/§10.5;R6/R8→§3.3;R7→§8.4;R3→§3.0.1/§10.2 —— §12 仅留作验证与修订溯源,T0 拍板即可据正文执行。
