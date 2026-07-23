# SRVF 活动发起、发布审核、责任闭环与考勤独立双审
## 后端落地开发规格（业务定版 / v0.61.0 基线）

> **文档状态：业务已定版，可进入后端实施。**
> **仓库：** `BA7IEE/srvf-nest-api`
> **分析基线：** `v0.61.0`，按 `main@087fb00d59f405577be72bef4d3e73d36e3868d2` 读取；本次发布代码候选为 `1bd0dc8f0cef7cd06456104bdbf3c2db49fb7243`。
> **变更等级：D 档。** 涉及 schema、migration、Permission、内置 Role、RolePermission 映射、Authz ResourceResolver、状态机、接口、DTO、审计行为、通知和旧权限收口，必须按仓库 D 档流程分 PR 实施。
> **本文优先级：** 用户本轮业务定版 > 当前历史评审稿；但实施仍须遵守 `AGENTS.md`、`docs/current-state.md`、`docs/process.md` 和各模块 `CLAUDE.md` 的工程铁律。

---

# 0. 给执行 AI 的开工指令

实施前必须依次阅读：

1. `AGENTS.md`
2. `docs/current-state.md`
3. `docs/process.md` §2、§3、§4
4. `docs/api-surface-policy.md`
5. `docs/architecture-boundary.md`
6. `docs/participation-bounded-context.md`
7. `CODEMAP.md`
8. `src/modules/activities/CLAUDE.md`
9. `src/modules/activity-registrations/CLAUDE.md`
10. `src/modules/attendances/CLAUDE.md`
11. `src/modules/authz/CLAUDE.md`
12. `src/modules/permissions/CLAUDE.md`
13. `docs/ai-harness/RBAC_MAP.md`
14. `prisma/schema.prisma`
15. `prisma/seed.ts`

开工命令：

```bash
pnpm agent:preflight --lane activity-workflow-v2
pnpm install --frozen-lockfile
pnpm prisma:generate
```

实施约束：

- 不允许一次性做成一个巨型 PR。
- 不允许跳过评审稿冻结、风险表、迁移预检和全量测试。
- 不允许自动执行生产 migration、seed 或数据修复。
- 不允许新增第三个 cron。
- 不允许引入 Redis、BullMQ、通用 queue、repository 抽象层或新的权限 DSL。
- 不允许把 App DTO 从 Admin DTO 通过 `extends`、`Pick`、`Omit`、`PartialType` 等方式派生。
- 不允许新建 Mixed Controller。
- 不允许直接在大 service 内继续堆一整套状态机、权限规则和审计组装；新逻辑须按现有架构边界拆成 Policy、StateMachine、QueryService、Presenter、AuditRecorder。
- 每一个改变接口、DTO、Permission、Role、BizCode、schema、migration 的 PR，都必须更新对应契约和派生文档。
- 每个 D 档 PR 至少执行：

```bash
pnpm agent:check:full
pnpm docs:codemap:check
pnpm docs:rbacmap:check
pnpm docs:counts:check
```

---

# 1. 最终业务规则：先说人话

## 1.1 谁能发起活动

只有同时满足以下条件的人可以成为活动业务发起人：

- 登录账号有效；
- 账号已经绑定队员；
- 队员状态为 `ACTIVE`；
- 队员未软删除；
- 队员级别属于：
  - `level-1`
  - `level-2`
  - `level-3`
  - `level-4`
  - `level-5`
  - `level-6`
  - `level-7`

以下人员不能成为活动发起人：

- `volunteer`
- `reserve`
- `gradeCode = null`
- 队员已停用或离队
- 只有后台账号、没有绑定队员的人

**管理员身份不代替正式队员身份。**

如果超级管理员需要代建活动，他只能“代某个符合条件的正式队员创建”，业务发起人仍必须是正式队员；不能把没有队员身份的超级管理员自己写成活动发起人。

---

## 1.2 默认能给哪些组织发起活动

正式队员默认只能为自己当前有效归属的组织发起活动。

“当前有效归属”固定按以下条件判断：

- `deletedAt = null`
- `status = ACTIVE`
- `startedAt <= 当前时间`
- `endedAt = null`
- 所属组织 `ACTIVE`
- 所属组织未软删除
- 组织不是根节点

第一版把当前系统四类有效归属都视为“当前所属组织”：

- `PRIMARY`
- `SECONDARY`
- `TEMPORARY`
- `SUPPORT`

如果业务以后要收紧某一类型，应单独立项，不能在本次实现中自行改成只认 `PRIMARY`。

---

## 1.3 怎么给别的部门发活动

需要为别的组织发活动时，不授予对方整个部门的管理权限，而是给本人一条独立的“跨组织活动发起资格”。

该资格：

- 可绑定到某一个组织；
- 可绑定到某个组织及全部下级；
- 可以有开始时间和结束时间；
- 推荐绑定 `MEMBER` 主体，避免账号重开后授权丢失；
- 只允许发起活动，不允许管理目标组织的队员、档案、考勤审核或其他活动。

---

## 1.4 活动怎么发布

活动发布审核员必须独立配置，不能因为某人是以下身份就自动获得：

- `ADMIN`
- `biz-admin`
- 队长
- 部长
- 组长
- 副职
- 分管人
- `org-admin`
- `group-manager`

普通正式队员：

1. 创建草稿；
2. 编辑活动和岗位；
3. 提交发布审核；
4. 独立发布审核员通过后，活动才公开。

如果活动发起人本人也拥有覆盖该活动所属组织的发布审核权限：

- 可以直接发布自己的活动；
- 系统仍然要生成完整审核记录；
- 记录发起人、审核人、实际发布人三种身份；
- 三者可以是同一个人。

活动发布审核不像考勤审核，不强制“自己不能审核自己”。

超级管理员可以兜底审核，但必须正常留痕。

---

## 1.5 谁负责发布后的事情

活动发布以后，发起人自动成为该活动主负责人。

主负责人负责：

- 报名审核；
- 候补和报名异常处理；
- 活动现场跟进；
- GPS 打卡复核；
- 考勤整理；
- 考勤提交；
- 一审或终审退回后的整改；
- 一直跟进到所有有效考勤完成终审。

活动发布审核人只负责把关，不自动接管活动。

---

## 1.6 临时委托和负责人移交

主负责人可以临时指定协办人：

- 只协助报名；
- 只协助考勤；
- 报名和考勤都协助。

协办人不能因此获得：

- 活动发布审核权；
- 考勤一审权；
- 考勤终审权；
- 其他活动的权限。

协办对象必须是账号、队员均有效的人，并至少满足以下一项：

- 是该活动 `pass` 报名参与者；
- 是该活动所属组织的当前有效成员。

协办人不要求必须是正式等级，允许现场实际参与的志愿者协助；但“主负责人移交”的新负责人必须是 `level-1` 至 `level-7` 的正式队员。

负责人正式移交时：

- 发起人不变；
- 原负责人结束；
- 新负责人接管；
- 必须填写移交原因；
- 保留完整历史；
- 是否把原负责人保留为协办人，由调用方显式选择，默认不保留。

---

## 1.7 考勤一审和终审

考勤一审员、终审员都必须独立配置。

普通管理员及组织角色不自动拥有一审、终审权限。

权限规则：

- 一审员：查看、一审通过、一审退回修改、一级作废驳回；
- 终审员：查看、终审通过、终审退回修改、终审作废驳回、撤回错误终审；
- 超级管理员拥有权限兜底；
- 但人员隔离规则对超级管理员也生效。

同一张考勤单：

1. 初次提交人不能做一审；
2. 最近一次重提人不能做一审；
3. 初次提交人不能做终审；
4. 最近一次重提人不能做终审；
5. 一审人不能再做终审；
6. 上述限制同时适用于通过、退回、作废驳回，不允许只限制“通过”。

---

## 1.8 退回修改与作废驳回必须分开

“退回修改”：

- 保留原考勤明细；
- 主负责人或考勤协办人可编辑；
- 修改后重新提交；
- 重新从一审开始；
- 一审、终审责任字段重置；
- 保留审计历史。

“作废驳回”：

- 继续沿用当前 `rejected`、`final_rejected`；
- 原明细软删除；
- 原单不能继续编辑；
- 需要处理时重新创建新单。

---

## 1.9 活动什么时候算责任闭环

活动主状态仍然只有：

- `draft`
- `published`
- `cancelled`
- `completed`

不能把“待发布审核”“考勤退回”等状态硬塞进 `Activity.statusCode`。

责任闭环是派生状态。满足以下条件才算完成：

- 活动已经 `completed`；
- 主负责人已经声明“考勤全部提交”；
- 没有 `pending` 考勤单；
- 没有 `pending_final_review` 考勤单；
- 没有 `returned` 考勤单；
- 所有仍然有效的考勤单均为 `approved`；
- `rejected`、`final_rejected` 和已软删除单据不算有效考勤，不阻挡闭环。

第一版闭环状态实时计算，不自动撤销负责人权限，避免终审撤回后无人整改。活动级 scoped 权限保留，业务状态机继续限制非法动作。

---

# 2. 当前 v0.61.0 的实际情况与缺口

## 2.1 当前已经有的能力

当前系统已经具备：

- Activity 四态状态机；
- 活动草稿、发布、取消、手动完结；
- 报名五态、候补、自动递补、审核；
- GPS 签到、签退和考勤草稿；
- 考勤提交、一审、终审、终审撤回；
- scoped RoleBinding：
  - `GLOBAL`
  - `ORGANIZATION`
  - `ORGANIZATION_TREE`
  - `ACTIVITY`
  - `RESOURCE`
  - `SELF`
- Authz 三源授权：
  - 显式 RoleBinding
  - 职务 policy
  - 分管推导
- 独立 `attendance-final-reviewer` 角色；
- App self-scope；
- Admin 跨活动审核工作台；
- 审计日志；
- 站内通知；
- OpenAPI 契约锁和完整 e2e 基线。

这些能力全部复用，不另造第二套权限平台、第二套活动表或第二套考勤模块。

---

## 2.2 当前没有的能力

当前 `Activity` 没有：

- 发起人；
- 当前主负责人；
- 协办人；
- 委托范围；
- 负责人移交历史；
- 发布审核申请；
- 发布退回原因；
- 发布审核人；
- 跨组织发起资格；
- 考勤全部提交声明；
- 责任闭环状态。

当前权限实际是：

> 谁持有活动、报名、考勤权限，谁都能做。

不是：

> 谁发起，谁负责；协办按活动授权。

当前一审仍在通用角色中；当前终审只有 `final-approve` 执行自审和同人限制，`final-reject` 没有限制。

当前一审、终审的“驳回”会软删除 records，不能用于普通整改退回。

---

## 2.3 必须顺手修正的陈旧注释

代码中存在少量陈旧注释，实施 AI 不得把注释误当当前事实：

1. `activity.complete.record` 的 seed 描述仍写有“考勤首提亦自动完结”，但当前实际代码明确是：
   - 考勤提交不修改 Activity；
   - 只有 `POST /activities/:id/complete` 可使 `published -> completed`。
2. 一些历史注释仍写 `biz-admin` 保留终审权限，但当前 seed 已把：
   - `attendance.final-approve.sheet`
   - `attendance.final-reject.sheet`
   - `attendance.reopen.sheet`

   从 `biz-admin` 摘除。

本次修改相关文件时，应同步修正文案，但不得改变已锁定的真实行为。

---

# 3. 不可自行改变的设计决议

| 编号 | 决议 |
|---|---|
| D-01 | 业务发起人必须是 `level-1..level-7` 正式队员。 |
| D-02 | App 发起活动默认组织范围为本人全部当前有效 membership。 |
| D-03 | 跨组织发起通过 scoped RoleBinding 明确授权，不通过组织职务隐式放大。 |
| D-04 | 发布审核员独立配置，普通管理角色不自动拥有。 |
| D-05 | 发起人本人若有覆盖目标组织的发布审核权，可以直接发布。 |
| D-06 | 发布审核允许自己审自己；考勤审核不允许。 |
| D-07 | 发布通过后，发起人自动成为主负责人。 |
| D-08 | 主负责人负责报名、考勤提交和退回整改，不包含考勤审核。 |
| D-09 | 协办权限按报名、考勤两维拆分，可同时拥有。 |
| D-10 | 负责人移交必须留痕，发起人永久不变。 |
| D-11 | 考勤一审员、终审员都独立配置。 |
| D-12 | 通用 `biz-admin`、`org-admin`、`group-manager` 不再自动拥有考勤一审。 |
| D-13 | 提交人、最近重提人、一审人隔离规则覆盖通过、退回和作废驳回。 |
| D-14 | `ATTENDANCE_ALLOW_SAME_REVIEWER` 不再能放开同人终审；保留配置字段兼容，但运行时忽略并标 deprecated。 |
| D-15 | 新增 `returned` 考勤状态；终态 `rejected/final_rejected` 保持。 |
| D-16 | 退回修改后必须重走一审，不能直接回终审。 |
| D-17 | Activity 四态不扩展，发布审核另表承载。 |
| D-18 | Activity 已发布后的任何业务字段或岗位变化都必须提交变更审核；不允许直接改 live 数据。 |
| D-19 | `publishedBy` 继续表示实际执行发布的 User，不代表发起人或负责人。 |
| D-20 | 活动负责人和协办人的业务事实放责任表；其实际操作权限投影成 ACTIVITY scoped RoleBinding。 |
| D-21 | 自动投影角色禁止人工通过 role-bindings API 分配。 |
| D-22 | 老接口保留，先做兼容入口，不直接删除或改 path。 |
| D-23 | 旧活动不根据 `publishedBy` 猜发起人；非终态旧活动上线前人工认领。 |
| D-24 | 不新增第三个 cron、不新增 Redis 或通用队列。 |
| D-25 | 新功能先 expand、配置、演练，再 contract 摘除通用角色旧权限。 |

---

# 4. 目标数据模型

## 4.1 `Activity` 新增字段

在 `prisma/schema.prisma` 的 `Activity` 增加：

```prisma
initiatorMemberId String?
workflowRevision Int @default(0)

attendanceDeclaredCompleteAt DateTime?
attendanceDeclaredCompleteByUserId String?

initiator Member? @relation("ActivityInitiator", fields: [initiatorMemberId], references: [id], onDelete: Restrict)
attendanceDeclaredCompleteBy User? @relation(
  "ActivityAttendanceDeclaration",
  fields: [attendanceDeclaredCompleteByUserId],
  references: [id],
  onDelete: Restrict
)

publishReviews ActivityPublishReview[]
responsibilityAssignments ActivityResponsibilityAssignment[]

@@index([initiatorMemberId])
@@index([attendanceDeclaredCompleteAt])
```

解释：

- `initiatorMemberId`：业务发起人，发布审核人改变不影响它；
- `workflowRevision`：初次发布或每次审核通过的活动变更都 `+1`；
- `attendanceDeclaredCompleteAt`：负责人声明所有考勤已提交；
- `attendanceDeclaredCompleteByUserId`：实际点击声明的人；
- 对旧数据全部可空，保证旧 binary 写入兼容。

`Member` 增加反向关系：

```prisma
activitiesInitiated Activity[] @relation("ActivityInitiator")
activityResponsibilities ActivityResponsibilityAssignment[]
```

`User` 增加对应反向关系。

---

## 4.2 新表：`ActivityPublishReview`

```prisma
model ActivityPublishReview {
  id             String   @id @default(cuid())
  activityId     String
  requestType    String   // initial | change
  requestVersion Int
  baseRevision   Int
  status         String   // pending | approved | returned | withdrawn | cancelled
  snapshot       Json
  directPublish  Boolean  @default(false)

  submittedByUserId String
  submittedAt       DateTime @default(now())
  reviewedByUserId  String?
  reviewedAt        DateTime?
  reviewNote        String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  activity    Activity @relation(fields: [activityId], references: [id], onDelete: Restrict)
  submittedBy User @relation("ActivityPublishReviewSubmitter", fields: [submittedByUserId], references: [id], onDelete: Restrict)
  reviewedBy  User? @relation("ActivityPublishReviewReviewer", fields: [reviewedByUserId], references: [id], onDelete: Restrict)

  @@unique([activityId, requestVersion])
  @@index([activityId, status])
  @@index([status, submittedAt])
  @@index([submittedByUserId])
  @@index([reviewedByUserId])
  @@map("activity_publish_reviews")
}
```

手写 partial unique：

```sql
CREATE UNIQUE INDEX activity_publish_reviews_one_pending_unique
ON activity_publish_reviews ("activityId")
WHERE status = 'pending';
```

固定规则：

- 每个活动同时最多一个待审请求；
- `initial` 只允许 Activity 为 `draft`；
- `change` 只允许 Activity 为 `published`；
- `directPublish=true` 时：
  - 状态必须直接为 `approved`；
  - 提交人和审核人必须是同一个 User；
- `returned` 必须有 `reviewNote`；
- 已通过、退回、撤回的请求不可再次变更结论；
- 新一轮重提创建新 requestVersion，不覆盖旧记录。

---

## 4.3 发布审核快照格式

`snapshot` 固定为：

```json
{
  "schemaVersion": 1,
  "activity": {
    "title": "活动名称",
    "activityTypeCode": "training",
    "organizationId": "org-id",
    "startAt": "ISO8601",
    "endAt": "ISO8601",
    "location": "地点",
    "description": null,
    "capacity": 30,
    "genderRequirementCode": null,
    "registrationDeadline": null,
    "registrationNotes": null,
    "isPublicRegistration": true,
    "requiresInsurance": false,
    "registrationSchema": null,
    "coverImageUrl": null,
    "galleryImageUrls": null,
    "content": null,
    "locationLongitude": null,
    "locationLatitude": null
  },
  "positions": [
    {
      "activityPositionId": "existing-id-or-null",
      "clientRef": "new-row-client-ref-or-null",
      "name": "后勤",
      "attendanceRoleCode": "member",
      "capacity": 10,
      "startAt": null,
      "endAt": null,
      "genderRequirementCode": null,
      "description": null,
      "sortOrder": 0
    }
  ]
}
```

要求：

- positions 固定按 `sortOrder, createdAt, id` 或 `clientRef` 稳定排序；
- change request 中：
  - 带本活动现有 `activityPositionId` 表示更新；
  - 无 ID、带 `clientRef` 表示新建；
  - 原岗位未出现在快照中表示软删除；
- 严禁接受其他活动的 position id；
- 不允许 snapshot 写入系统状态、审核人、审计时间或任何敏感字段；
- approve 前必须重新用服务端规则校验完整快照，不能相信提交时已校验。

---

## 4.4 新表：`ActivityResponsibilityAssignment`

```prisma
model ActivityResponsibilityAssignment {
  id         String @id @default(cuid())
  activityId String
  memberId   String

  responsibilityType String // owner | collaborator
  canManageRegistrations Boolean
  canManageAttendance  Boolean
  status String @default("active") // active | ended | revoked

  startedAt DateTime @default(now())
  endedAt   DateTime?

  assignedByUserId String
  endedByUserId    String?
  source String // publish | delegation | transfer | legacy-claim | admin
  reason String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  activity Activity @relation(fields: [activityId], references: [id], onDelete: Restrict)
  member   Member   @relation(fields: [memberId], references: [id], onDelete: Restrict)
  assignedBy User @relation("ActivityResponsibilityAssigner", fields: [assignedByUserId], references: [id], onDelete: Restrict)
  endedBy   User? @relation("ActivityResponsibilityEnder", fields: [endedByUserId], references: [id], onDelete: Restrict)

  @@index([activityId, status])
  @@index([memberId, status])
  @@index([assignedByUserId])
  @@map("activity_responsibility_assignments")
}
```

手写 partial unique：

```sql
CREATE UNIQUE INDEX activity_responsibility_one_active_owner_unique
ON activity_responsibility_assignments ("activityId")
WHERE "responsibilityType" = 'owner' AND status = 'active';

CREATE UNIQUE INDEX activity_responsibility_member_active_unique
ON activity_responsibility_assignments ("activityId", "memberId")
WHERE status = 'active';
```

数据库和服务端不变量：

- owner 必须：
  - `canManageRegistrations = true`
  - `canManageAttendance = true`
- collaborator 至少一个能力为 true；
- active 时 `endedAt = null`；
- ended/revoked 时 `endedAt != null`；
- 不提供删除接口；
- 结束一条记录只改状态和 endedAt，历史永久保留。

---

## 4.5 `AttendanceSheet` 新增字段

```prisma
lastSubmittedByUserId String?
lastSubmittedAt DateTime?

returnedByUserId String?
returnedAt DateTime?
returnNote String?
returnedFromStageCode String? // first | final

lastSubmitter User? @relation(
  "AttendanceSheetLastSubmitter",
  fields: [lastSubmittedByUserId],
  references: [id],
  onDelete: Restrict
)
returnedBy User? @relation(
  "AttendanceSheetReturner",
  fields: [returnedByUserId],
  references: [id],
  onDelete: Restrict
)

@@index([lastSubmittedByUserId])
@@index([returnedByUserId])
@@index([returnedAt])
```

expand migration：

- 新列先 nullable；
- 存量行回填：
  - `lastSubmittedByUserId = submitterUserId`
  - `lastSubmittedAt = submittedAt`
- runtime 全部稳定后，另一个 contract migration 再决定是否收为 NOT NULL；
- 第一刀不得直接把存量列改成 NOT NULL。

attendance_sheet_status 字典新增：

```text
returned = 退回修改
```

---

# 5. 状态机

## 5.1 Activity 主状态不变

| 动作 | 原状态 | 新状态 |
|---|---|---|
| create | 无 | draft |
| publish-review approve | draft | published |
| cancel | draft / published | cancelled |
| complete | published | completed |

考勤提交仍然不能自动 complete。

---

## 5.2 发布审核状态机

新建 `activity-publish-review-state-machine.ts`。

| 动作 | 当前请求状态 | 结果 |
|---|---|---|
| submit | 无 pending | pending |
| directPublish | 无 pending | approved |
| approve | pending | approved |
| return | pending | returned |
| withdraw | pending | withdrawn |
| activityCancel | pending | cancelled |

额外业务闸：

- `initial approve` 要求 Activity 仍为 draft；
- `change approve` 要求 Activity 仍为 published；
- `baseRevision` 必须等于 Activity.workflowRevision；
- 初次发布活动结束时间必须晚于 now；
- 报名截止时间不得已过；
- 审核通过时再次校验保险确认；
- 已有 pending 请求时禁止再次提交；
- pending 期间禁止直接改 Activity 和岗位；
- Activity 取消时，同事务把 pending review 置 cancelled；
- Activity complete 时如有 pending change review，拒绝 complete。

---

## 5.3 已发布活动变更

Activity 为 `published` 后：

- `PATCH /activities/:id` 不再直接修改 live 业务字段；
- ActivityPosition 写接口不再直接改 live 岗位；
- 主负责人提交一份 `change` review snapshot；
- 审核通过后，在一个事务内：
  1. 锁 Activity；
  2. 锁 review；
  3. 检查 baseRevision；
  4. 校验完整 proposal；
  5. 更新 Activity；
  6. 对 positions 做 create/update/soft-delete diff；
  7. 执行容量与候补递补逻辑；
  8. `workflowRevision + 1`；
  9. 记录审核；
  10. 提交后发送既有变更通知。

`cancelled`、`completed` 继续沿当前只允许展示字段修改的旧规则，不进入新 change review。

---

## 5.4 考勤状态机

`AttendanceSheetStatusCode` 增加 `returned`。

动作矩阵：

| 动作 | 原状态 | 新状态 | records |
|---|---|---|---|
| edit | pending | pending | 替换 |
| edit | returned | returned | 替换 |
| firstApprove | pending | pending_final_review | 保留 |
| firstReturn | pending | returned | 保留 |
| firstReject | pending | rejected | 软删除 |
| resubmit | returned | pending | 保留 |
| finalApprove | pending_final_review | approved | 保留并生效 |
| finalReturn | pending_final_review | returned | 保留 |
| finalReject | pending_final_review | final_rejected | 软删除 |
| reopen | approved | pending | 保留 |

resubmit：

- `lastSubmittedByUserId = 当前操作 User`
- `lastSubmittedAt = now`
- 清空：
  - reviewerUserId / reviewedAt / reviewNote
  - finalReviewerUserId / finalReviewedAt / finalReviewNote
  - returnedByUserId / returnedAt / returnNote / returnedFromStageCode
- version `+1`
- 重新进入一审。

---

# 6. 权限与角色

## 6.1 新增 Permission

建议新增 6 个 Permission：

| code | 用途 |
|---|---|
| `activity.create.cross-org` | 为本人非当前归属组织发起活动 |
| `activity-review.read.request` | 查看活动发布审核请求 |
| `activity-review.return.request` | 退回活动发布审核请求 |
| `activity-responsibility.override.record` | 管理旧活动认领、管理员强制移交 |
| `attendance.return.sheet` | 考勤一审退回修改 |
| `attendance.final-return.sheet` | 考勤终审退回修改 |

审核通过继续复用：

- `activity.publish.record`

一审、终审通过和作废驳回继续复用现有码。

---

## 6.2 新增内置角色

新增 6 个内置角色：

### 1. `activity-publish-reviewer`

手工配置，零默认持有人：

- `activity-review.read.request`
- `activity.publish.record`
- `activity-review.return.request`

### 2. `activity-cross-org-initiator`

手工配置，零默认持有人：

- `activity.create.cross-org`

### 3. `attendance-first-reviewer`

手工配置，零默认持有人：

- `attendance.read.sheet`
- `attendance.approve.sheet`
- `attendance.reject.sheet`
- `attendance.return.sheet`

### 4. `activity-owner`

系统自动投影，禁止人工绑定：

- `activity.update.record`
- `activity.cancel.record`
- `activity.complete.record`
- `activity-registration.read.record`
- `activity-registration.create.record`
- `activity-registration.approve.record`
- `activity-registration.reject.record`
- `activity-registration.cancel.record`
- `activity-registration.reopen.record`
- `attendance.read.sheet`
- `attendance.create.sheet`
- `attendance.update.sheet`
- `attendance.delete.sheet`

### 5. `activity-registration-collaborator`

系统自动投影，禁止人工绑定：

- `activity-registration.read.record`
- `activity-registration.create.record`
- `activity-registration.approve.record`
- `activity-registration.reject.record`
- `activity-registration.cancel.record`
- `activity-registration.reopen.record`

### 6. `activity-attendance-collaborator`

系统自动投影，禁止人工绑定：

- `attendance.read.sheet`
- `attendance.create.sheet`
- `attendance.update.sheet`
- `attendance.delete.sheet`

现有 `attendance-final-reviewer` 增加：

- `attendance.final-return.sheet`

全部新角色加入：

- `prisma/seed.ts`
- `PROTECTED_ROLE_CODES`
- `RBAC_MAP.md`
- seed e2e 漂移检查

内置角色数预计由 9 增加到 15，最终数量以 `pnpm docs:counts` 自动生成结果为准，禁止手改数字。

---

## 6.3 系统自动角色禁止手工授予

新增：

```ts
SYSTEM_MANAGED_ROLE_CODES = new Set([
  'activity-owner',
  'activity-registration-collaborator',
  'activity-attendance-collaborator',
]);
```

在以下入口统一拒绝手工授予、恢复、扩任期、撤销：

- role-bindings create
- role-bindings preview
- role-bindings batch
- role-bindings update
- legacy users/:userId/roles assign/revoke

新增 BizCode：

```text
ROLE_BINDING_SYSTEM_MANAGED_ROLE_FORBIDDEN = 34006
“该角色由业务流程自动维护，不能手工分配或撤销”
```

只有 `ActivityResponsibilityGrantProjector` 可以在业务事务中直写这三类 RoleBinding。

---

## 6.4 责任表到 RoleBinding 的投影

owner 发布生效时：

```text
principalType = MEMBER
principalId = owner.memberId
role = activity-owner
scopeType = ACTIVITY
scopeActivityId = activity.id
status = ACTIVE
```

协办：

- 报名协办 → `activity-registration-collaborator`
- 考勤协办 → `activity-attendance-collaborator`
- 两项都选 → 建两条 binding

结束、撤销、移交时：

- 同事务结束责任 assignment；
- 同事务软结束对应 RoleBinding；
- 不允许只改其中一边。

自动 binding note 固定：

```text
system:activity-responsibility:{assignmentId}
```

RoleBinding 和 assignment 不做双向 FK，以 deterministic key 查询：

```text
principalType=MEMBER
principalId=memberId
roleId=系统角色
scopeType=ACTIVITY
scopeActivityId=activityId
```

---

## 6.5 通用角色摘权

expand 阶段先保留旧权限，完成配置和演练后，contract 阶段从通用角色摘除。

从 `biz-admin` / 由它派生的 `org-admin` 摘除：

```text
activity.publish.record
activity.update.record
activity.cancel.record
activity.complete.record

activity-registration.create.record
activity-registration.approve.record
activity-registration.reject.record
activity-registration.cancel.record
activity-registration.reopen.record

attendance.create.sheet
attendance.update.sheet
attendance.delete.sheet
attendance.approve.sheet
attendance.reject.sheet
attendance.return.sheet
attendance.final-return.sheet
```

继续保留通用只读：

```text
activity-registration.read.record
attendance.read.sheet
```

继续保留：

- `activity.delete.record`：后台清理；
- `activity.create.record`：老 Admin 创建入口存在，但业务发起人仍必须经过正式队员校验。

从 `group-manager` 显式权限列表摘除：

```text
attendance.approve.sheet
attendance.reject.sheet
```

保留：

```text
attendance.read.sheet
activity-registration.read.record
```

`activity-publish-reviewer`、`attendance-first-reviewer`、`attendance-final-reviewer` 均不写入 PositionRolePolicy，必须由 RoleBinding 显式配置。

---

## 6.6 reviewer 配置方式

推荐标准形态：

### 发布审核员

```json
{
  "principalType": "POSITION_ASSIGNMENT",
  "principalId": "任职ID",
  "roleId": "activity-publish-reviewer角色ID",
  "scopeType": "ORGANIZATION_TREE",
  "scopeOrgId": "组织ID"
}
```

### 一审员

```json
{
  "principalType": "USER",
  "principalId": "用户ID",
  "roleId": "attendance-first-reviewer角色ID",
  "scopeType": "ORGANIZATION_TREE",
  "scopeOrgId": "组织ID"
}
```

### 终审员

沿现有 `attendance-final-reviewer`。

### 跨组织发起人

推荐 MEMBER 主体：

```json
{
  "principalType": "MEMBER",
  "principalId": "队员ID",
  "roleId": "activity-cross-org-initiator角色ID",
  "scopeType": "ORGANIZATION",
  "scopeOrgId": "目标组织ID",
  "startedAt": "ISO8601",
  "endedAt": "ISO8601"
}
```

---

# 7. Authz 修改

## 7.1 ResourceResolver 新增两类资源

### `organization`

解析：

```text
resourceType = organization
resourceId = org.id
organizationId = org.id
organizationPath = closure 祖先链，含自身
activityId = null
statusCode = org.status
```

用于：

- `activity.create.cross-org`

### `activity_publish_review`

解析：

```text
resourceType = activity_publish_review
resourceId = review.id
organizationId = review.activity.organizationId
organizationPath = 组织祖先链
activityId = review.activityId
statusCode = review.status
extra = {
  requestType,
  submittedByUserId,
  directPublish
}
```

用于：

- review detail
- approve
- return
- 权限解释

同步更新：

- `EXPLAINABLE_RESOURCE_TYPES`
- `AuthzReason` 契约不新增值
- authz DTO
- authz resolver e2e
- authz explain 枚举完备锁

---

## 7.2 ActionConstraint 扩展

保留 reason：

- `self_approval_forbidden`
- `same_reviewer_forbidden`

不新增 reason，避免 explain 11 值扩容。

`attendance_sheet` resolver extra 增加：

```text
submitterUserId
lastSubmittedByUserId
reviewerUserId
```

约束：

### 提交人禁止审核

注册到：

```text
attendance.approve.sheet
attendance.reject.sheet
attendance.return.sheet
attendance.final-approve.sheet
attendance.final-reject.sheet
attendance.final-return.sheet
```

当 actor 等于 `submitterUserId` 或 `lastSubmittedByUserId` 时否决。

### 一审人禁止终审

注册到：

```text
attendance.final-approve.sheet
attendance.final-reject.sheet
attendance.final-return.sheet
```

当 actor 等于 `reviewerUserId` 时否决。

`ATTENDANCE_ALLOW_SAME_REVIEWER`：

- 配置解析继续保留，避免环境变量兼容问题；
- 运行时不再读取它放开约束；
- 文档标记 deprecated；
- 测试固定断言 true/false 都不能让同一人一审后终审。

---

## 7.3 BizCode 映射

新增前必须再次 grep 数字，以下为冻结建议位：

### activities 20xxx

| 常量 | code | 文案 |
|---|---:|---|
| `ACTIVITY_PUBLISH_REVIEW_NOT_FOUND` | 20004 | 活动发布审核记录不存在 |
| `ACTIVITY_RESPONSIBILITY_NOT_FOUND` | 20005 | 活动责任记录不存在 |
| `ACTIVITY_INITIATOR_NOT_FORMAL` | 20019 | 只有正式队员可以发起活动 |
| `ACTIVITY_INITIATION_ORG_FORBIDDEN` | 20020 | 无权为该组织发起活动 |
| `ACTIVITY_PUBLISH_REVIEW_NOTE_REQUIRED` | 20021 | 退回发布审核必须填写原因 |
| `ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID` | 20022 | 活动审核快照无效或已过期 |
| `ACTIVITY_PUBLISH_REVIEW_PENDING` | 20032 | 活动已有待处理的发布审核 |
| `ACTIVITY_PUBLISH_REVIEW_STATUS_INVALID` | 20033 | 发布审核当前状态不允许此操作 |
| `ACTIVITY_RESPONSIBILITY_ALREADY_EXISTS` | 20034 | 该人员已承担此活动责任 |
| `ACTIVITY_RESPONSIBILITY_TARGET_INVALID` | 20035 | 责任人或协办人不符合条件 |
| `ACTIVITY_CHANGE_REVIEW_REQUIRED` | 20037 | 已发布活动修改需先提交审核 |
| `ACTIVITY_LEGACY_OWNER_REQUIRED` | 20038 | 历史活动尚未指定负责人 |
| `ACTIVITY_ATTENDANCE_DECLARATION_INVALID` | 20039 | 当前活动不能声明考勤已全部提交 |

### attendances 22xxx

| 常量 | code | 文案 |
|---|---:|---|
| `ATTENDANCE_SELF_FIRST_REVIEW_FORBIDDEN` | 22081 | 不能一审自己提交或重提的考勤单 |
| `ATTENDANCE_RETURN_NOTE_REQUIRED` | 22082 | 退回修改必须填写原因 |
| `ATTENDANCE_SHEET_RESUBMIT_STATUS_INVALID` | 22083 | 只有退回修改的考勤单可以重新提交 |

继续使用：

- 22074：不能终审自己提交的考勤；
- 22075：一审人不能终审同一张考勤。

### role-binding 34xxx

| 常量 | code | 文案 |
|---|---:|---|
| `ROLE_BINDING_SYSTEM_MANAGED_ROLE_FORBIDDEN` | 34006 | 该角色由业务流程自动维护，不能手工分配或撤销 |

权限不足继续统一 30100，不新增模块 forbidden 码。

---

# 8. 服务与文件结构

不得把全部逻辑继续塞进 `activities.service.ts`。

建议在 `src/modules/activities/` 新增：

```text
activity-initiation-policy.ts
activity-publish-review-state-machine.ts
activity-publish-review.service.ts
activity-publish-review-query.service.ts
activity-publish-review-presenter.ts
activity-publish-review-audit-recorder.ts

activity-responsibility.service.ts
activity-responsibility-policy.ts
activity-responsibility-grant-projector.ts
activity-responsibility-query.service.ts
activity-responsibility-presenter.ts

activity-proposal-validator.ts
activity-proposal-applier.ts
activity-workflow-query.service.ts
activity-closure-policy.ts
```

职责：

- `ActivityInitiationPolicy`
  - 正式等级校验；
  - membership 组织范围；
  - cross-org grant；
  - 非根、ACTIVE 组织。
- `ActivityPublishReviewService`
  - submit、direct publish、approve、return、withdraw；
  - 持有 review 事务。
- `ActivityPublishReviewStateMachine`
  - 纯状态决策。
- `ActivityProposalValidator`
  - 复用当前日期、字典、组织、岗位、容量、保险校验。
- `ActivityProposalApplier`
  - 在调用方事务中应用 Activity + positions diff；
  - 不自行开事务。
- `ActivityResponsibilityService`
  - 协办、结束、移交、旧活动认领；
  - 持有责任变更事务。
- `ActivityResponsibilityGrantProjector`
  - 同事务维护系统 RoleBinding。
- `ActivityWorkflowQueryService`
  - managed list/detail、nextAction、closureStatus、统计。
- Presenter 只做出参。
- AuditRecorder 只组装审计，不写业务表。

`ActivitiesModule`：

- 不新建 `ParticipationModule`；
- 不 import `RoleBindingsModule`；
- projector 直接使用 Prisma；
- 导出：
  - `ActivityResponsibilityPolicy`
  - 必要的 workflow query/service，供报名和考勤薄壳复用。

---

# 9. API 设计

所有成功响应继续统一：

```json
{
  "code": 0,
  "message": "ok",
  "data": {}
}
```

## 9.1 现有 Admin 路径兼容

以下路径保留：

```text
POST   /api/admin/v1/activities
PATCH  /api/admin/v1/activities/:id
PATCH  /api/admin/v1/activities/:id/publish
PATCH  /api/admin/v1/activities/:id/cancel
POST   /api/admin/v1/activities/:id/complete
```

新行为：

### `POST /admin/v1/activities`

Admin DTO additive 增加：

```ts
initiatorMemberId?: string
```

- 不传：
  - 当前 User 必须绑定正式队员；
  - 当前队员为 initiator。
- 传：
  - 仅 SUPER_ADMIN 或持 `activity-responsibility.override.record`；
  - 目标必须是正式队员；
  - 当前 User 为代建操作人，目标 Member 为 initiator。

### `PATCH /activities/:id/publish`

workflow gate 开启后作为兼容入口：

1. 有当前 pending initial review，且调用者有覆盖范围的 `activity.publish.record`：
   - approve 当前 review；
2. 没有 pending review，调用者就是 initiator，且本人有发布审核权：
   - direct publish；
3. 其他情况：
   - 返回 `ACTIVITY_CHANGE_REVIEW_REQUIRED` 或 `RBAC_FORBIDDEN`。

不得继续让普通 biz-admin 直接发布。

### `PATCH /activities/:id`

- draft 且无 pending review：
  - initiator、SUPER_ADMIN 或 override 可改；
- pending review：
  - 拒绝；
- published：
  - 返回 `ACTIVITY_CHANGE_REVIEW_REQUIRED`；
- completed/cancelled：
  - 沿当前终态展示字段白名单。

ActivityPosition 现有写路由采用同样规则。

---

## 9.2 Admin 发布审核工作台

新 controller：

```text
GET  /api/admin/v1/activity-publish-reviews
GET  /api/admin/v1/activity-publish-reviews/:id
POST /api/admin/v1/activity-publish-reviews/:id/approve
POST /api/admin/v1/activity-publish-reviews/:id/return
```

### List query

```text
page
pageSize
status
requestType
organizationId
includeDescendants
initiatorQ
activityQ
submittedFrom
submittedTo
```

范围：

- `AuthzService.getVisibleOrganizationScope(user, 'activity-review.read.request')`
- 与显式 organization 过滤取交集
- 无权限 30100
- 有码但范围空返回空分页

### Approve body

```json
{
  "reviewNote": "可选",
  "requiresInsuranceConfirmed": true
}
```

### Return body

```json
{
  "reviewNote": "必填，1~500 字"
}
```

---

## 9.3 Admin 责任配置与旧活动认领

```text
GET    /api/admin/v1/activities/:activityId/responsibilities
POST   /api/admin/v1/activities/:activityId/responsibilities/collaborators
DELETE /api/admin/v1/activities/:activityId/responsibilities/collaborators/:assignmentId
POST   /api/admin/v1/activities/:activityId/responsibilities/transfer
POST   /api/admin/v1/activities/:activityId/responsibilities/claim
POST   /api/admin/v1/activities/:activityId/responsibilities/assign-initiator
```

`claim`、`assign-initiator`：

- 只用于 legacy 行；
- SUPER_ADMIN 或 `activity-responsibility.override.record`；
- 必须填 reason。

---

## 9.4 App：我负责的活动

新路径不能复用现有 `/api/app/v1/my/activities`。

现有 `/my/activities` 的语义是“我已经建立报名关系的活动”，必须保持。

新 base：

```text
/api/app/v1/my/managed-activities
```

### 核心

```text
GET    /organization-options
GET    /
POST   /
GET    /:activityId
PATCH  /:activityId
DELETE /:activityId
POST   /:activityId/submit-publish-review
POST   /:activityId/direct-publish
POST   /:activityId/submit-change-review
POST   /:activityId/withdraw-publish-review
POST   /:activityId/declare-attendance-complete
```

### 岗位

```text
GET    /:activityId/positions
POST   /:activityId/positions
PATCH  /:activityId/positions/:activityPositionId
DELETE /:activityId/positions/:activityPositionId
```

### 责任和协办

```text
GET    /:activityId/responsibilities
GET    /:activityId/collaborator-options
POST   /:activityId/collaborators
DELETE /:activityId/collaborators/:assignmentId
POST   /:activityId/transfer-owner
```

### 报名管理

```text
GET   /:activityId/registrations
PATCH /:activityId/registrations/:registrationId/approve
PATCH /:activityId/registrations/:registrationId/reject
PATCH /:activityId/registrations/:registrationId/cancel
POST  /:activityId/registrations/:registrationId/reopen
PATCH /:activityId/registrations/bulk-approve
PATCH /:activityId/registrations/bulk-reject
```

### 考勤管理

```text
GET    /:activityId/check-ins
GET    /:activityId/attendance-sheet-draft
GET    /:activityId/attendance-sheets
POST   /:activityId/attendance-sheets
GET    /:activityId/attendance-sheets/:sheetId
PATCH  /:activityId/attendance-sheets/:sheetId
DELETE /:activityId/attendance-sheets/:sheetId
POST   /:activityId/attendance-sheets/:sheetId/resubmit
```

App controllers 必须分别建立：

```text
AppManagedActivitiesController
AppManagedActivityPositionsController
AppManagedActivityResponsibilitiesController
AppManagedActivityRegistrationsController
AppManagedActivityAttendancesController
```

每个 class 一个 ApiTag，不做 Mixed Controller。

App DTO 全部放：

```text
src/modules/**/dto/app/
```

薄壳必须显式重组 safe DTO，不透传 raw body。

---

## 9.5 考勤退回与重提 Admin 路由

新增：

```text
POST /api/admin/v1/attendance-sheets/:id/return
POST /api/admin/v1/attendance-sheets/:id/final-return
POST /api/admin/v1/attendance-sheets/:id/resubmit
```

### first return body

```json
{
  "returnNote": "必填"
}
```

### final return body

```json
{
  "returnNote": "必填"
}
```

### resubmit body

无业务字段，可为空对象；真实内容先走 PATCH edit。

App owner的 resubmit 路由使用前述 managed activity 路径。

---

# 10. 关键 DTO

## 10.1 发起组织 options

```ts
interface AppActivityInitiationOrganizationOption {
  organizationId: string;
  name: string;
  pathLabel: string;
  source: 'membership' | 'cross-org-grant';
  membershipType: 'PRIMARY' | 'SECONDARY' | 'TEMPORARY' | 'SUPPORT' | null;
}
```

响应只返回当前可用组织，不返回原始 RoleBinding id。

---

## 10.2 Managed Activity 详情

在 App 专用 DTO 中返回：

```ts
interface ManagedActivityDetail {
  activity: AppManagedActivityProjection;
  initiator: MemberSummary | null;
  owner: MemberSummary | null;
  myResponsibility: {
    responsibilityType: 'owner' | 'collaborator';
    canManageRegistrations: boolean;
    canManageAttendance: boolean;
  } | null;
  publishReview: {
    latestRequestId: string | null;
    requestType: 'initial' | 'change' | null;
    status: 'pending' | 'approved' | 'returned' | 'withdrawn' | 'cancelled' | null;
    reviewNote: string | null;
    canDirectPublish: boolean;
  };
  counts: {
    pendingRegistrations: number;
    waitlistedRegistrations: number;
    attendanceSheets: number;
    unresolvedAttendanceSheets: number;
  };
  closure: {
    attendanceDeclaredCompleteAt: string | null;
    status:
      | 'draft'
      | 'publish-review-pending'
      | 'published'
      | 'waiting-attendance-declaration'
      | 'attendance-first-review'
      | 'attendance-returned'
      | 'attendance-final-review'
      | 'closed';
    nextAction: string | null;
  };
}
```

---

## 10.3 协办

```json
{
  "memberId": "member-id",
  "canManageRegistrations": true,
  "canManageAttendance": false,
  "reason": "A 临时无法到场",
  "endedAt": null
}
```

至少一个 canManage 为 true。

---

## 10.4 负责人移交

```json
{
  "newOwnerMemberId": "member-id",
  "reason": "原负责人长期无法跟进",
  "retainPreviousOwnerAsCollaborator": false
}
```

---

# 11. 关键事务伪代码

## 11.1 创建活动草稿

```text
resolve current App identity
assert User/Member active
assert gradeCode ∈ level-1..level-7
load target organization
assert active + non-root

load initiator effective memberships
if target org not in memberships:
    authz.explain(activity.create.cross-org, organization ref)
    deny -> 20020

transaction:
    create Activity(
      status=draft,
      initiatorMemberId=member.id,
      workflowRevision=0
    )
    write existing activity.publish audit(operation=create)
commit
```

初次创建不建立 owner assignment；发起人通过 `initiatorMemberId` 管理 draft。

---

## 11.2 提交初次发布审核

```text
assert current member == activity.initiatorMemberId
transaction:
    lock Activity FOR UPDATE
    assert status=draft
    assert no pending review
    assert activity/positions mutable
    validate current activity and positions
    snapshot = stable snapshot
    version = max(requestVersion)+1
    create review(pending, initial, baseRevision=workflowRevision)
    audit(operation=publish-review-submit)
commit
notify reviewer workbench
```

---

## 11.3 发起人直接发布

```text
assert current member == initiator
authz.explain(activity.publish.record, activity ref)
deny -> 30100

transaction:
    lock Activity
    assert draft
    assert no pending review
    validate snapshot
    create review(
      initial,
      approved,
      directPublish=true,
      submittedBy=currentUser,
      reviewedBy=currentUser
    )
    Activity draft -> published
    workflowRevision += 1
    publishedBy = currentUser.id
    create owner assignment
    project activity-owner RoleBinding
    audit review + publish
commit
dispatch existing activity published notification
```

---

## 11.4 审核员通过

固定锁序：

```text
Activity -> ActivityPublishReview -> positions/registrations as needed
```

```text
authz.explain(
  activity.publish.record,
  activity_publish_review ref
)

transaction:
    lock Activity FOR UPDATE
    claim review status=pending FOR NO KEY UPDATE
    re-read review
    assert review.baseRevision == Activity.workflowRevision
    validate snapshot again

    if initial:
        assert Activity=draft
        apply Activity + positions
        Activity -> published
        create owner assignment for initiator
        project owner binding

    if change:
        assert Activity=published
        apply proposal diff
        execute capacity/waitlist logic

    workflowRevision += 1
    review -> approved
    reviewedBy=currentUser
    audit
commit

dispatch publish/change notifications after commit
```

---

## 11.5 增加协办人

锁序：

```text
Activity -> target Member -> responsibility rows -> RoleBinding
```

```text
assert actor is active owner OR SUPER_ADMIN/override
transaction:
    lock Activity
    lock target Member
    validate target active User + Member
    validate target is pass participant OR effective member of activity org
    assert no active assignment for target
    create collaborator assignment
    create one or two scoped system RoleBindings
    audit
commit
notify collaborator
```

---

## 11.6 负责人移交

```text
assert actor is current owner OR SUPER_ADMIN/override
transaction:
    lock Activity
    lock old/new Member by sorted memberId
    lock current owner assignment
    assert new owner formal level-1..7
    assert new owner valid
    end old owner assignment + owner binding
    if new owner has collaborator assignment:
        end it + collaborator bindings
    create new owner assignment + owner binding
    optional: create old owner collaborator
    audit
commit
notify old/new owner
```

---

## 11.7 考勤一审退回

```text
authz.explain(attendance.return.sheet, sheet ref)
map self_approval_forbidden -> 22081

transaction:
    claim sheet expected=pending
    re-read
    stateMachine.firstReturn -> returned
    preserve records
    set:
      reviewerUserId=currentUser
      reviewedAt=now
      returnedByUserId=currentUser
      returnedAt=now
      returnNote
      returnedFromStageCode=first
    audit attendance-sheet.review(action=return)
commit

notify owner + attendance collaborators + submitter/lastSubmitter
```

---

## 11.8 考勤终审退回

```text
authz.explain(attendance.final-return.sheet, sheet ref)
self -> 22074
same first reviewer -> 22075

transaction:
    claim expected=pending_final_review
    stateMachine.finalReturn -> returned
    preserve records
    set finalReviewer + returned fields
    audit attendance-sheet.final-review(action=final-return)
commit
notify responsible parties
```

---

## 11.9 重新提交

```text
authorization:
    activity-owner or attendance collaborator scoped to sheet.activity
    OR SUPER_ADMIN

transaction:
    claim sheet expected=returned
    stateMachine.resubmit -> pending
    preserve records
    clear first/final/return fields
    lastSubmittedByUserId=currentUser.id
    lastSubmittedAt=now
    version += 1
    audit attendance-sheet.edit(operation=resubmit)
commit
```

---

# 12. 并发和锁

必须新增以下并发测试并锁定行为。

## 12.1 发布审核

- 两人同时 approve 同一 request：
  - 只允许一人成功；
  - 败者返回 review status invalid；
  - 不重复发布、不重复通知、不重复 owner assignment。
- submit review 与 draft update 并发：
  - Activity root lock 后串行；
  - snapshot 必须来自锁后版本。
- direct publish 与普通 approve 并发：
  - 只允许一个 publish winner。
- change approve 与 cancel 并发：
  - Activity lock串行；
  - cancel winner 后 review 自动 cancelled；
  - change approve winner 后 cancel按最新 Activity执行。
- 两个 change request 并发：
  - partial unique 保证只有一个 pending。

## 12.2 责任

- 两人同时成为 owner：
  - partial unique 保证一个；
  - P2002 映射 20034。
- transfer 与 offboard 同时：
  - target Member 行锁确保不会给正在离队的人新授权。
- delegate 与 offboard 同时：
  - assignment 和 RoleBinding 不能出现一边成功一边失败。
- 重复请求：
  - 相同 active collaborator 返回 already-exists；
  - 不创建重复 RoleBinding。

## 12.3 考勤

- first approve 与 first return 同时：
  - claimAtStatus 只允许一个 winner。
- final approve 与 final return 同时：
  - 只允许一个。
- returned edit 与 resubmit 并发：
  - edit 和 resubmit 都必须走 claim；
  - 不能让 resubmit 后仍写入旧版本 records。
- resubmit 与 terminal reject 并发：
  - 状态机和 claim 收敛。
- 人员隔离使用锁后稳定字段。

---

# 13. 审计

不新增 AuditLogEvent 字符串，复用现有 umbrella events。

## 13.1 Activity

复用：

```text
activity.publish
```

`extra.operation` 新值：

```text
publish-review-submit
publish-review-direct
publish-review-approve
publish-review-return
publish-review-withdraw
change-review-submit
change-review-approve
responsibility-owner-create
responsibility-collaborator-create
responsibility-collaborator-end
responsibility-transfer
responsibility-legacy-claim
attendance-declare-complete
```

允许 extra：

```text
reviewId
requestVersion
requestType
directPublish
assignmentId
targetMemberId
canManageRegistrations
canManageAttendance
source
```

禁止写：

- 完整敏感资料；
- RoleBinding 原始 payload；
- 手机号、证件号；
- 通知正文；
- signed URL。

---

## 13.2 Attendance

复用：

```text
attendance-sheet.review
attendance-sheet.final-review
attendance-sheet.edit
```

新增 action/operation：

```text
return
final-return
resubmit
```

return audit 必须包含：

- before Sheet；
- recordsCount；
- return stage；
- reason；
- after Sheet；
- 不软删除 records。

---

# 14. 通知和工作台

第一版不新增 notification_type，内部工作流通知统一使用现有 `general`，避免新增字典分支。

必须发送：

| 事件 | 收件人 |
|---|---|
| 发布审核退回 | initiator |
| 发布审核通过 | initiator / current owner |
| 被指定协办 | collaborator |
| 协办被结束 | collaborator |
| 负责人移交 | old owner / new owner |
| 考勤一审退回 | owner、考勤协办、初次/最近提交人 |
| 考勤终审退回 | owner、考勤协办、初次/最近提交人 |
| 考勤终审通过 | 继续沿当前参与者通知；额外通知 owner |
| 活动取消 | 继续沿当前报名者通知 |

通知发送继续遵守现有 participation best-effort 口径：

- 主事务先 commit；
- 通知失败只记录日志；
- 不回滚业务事务；
- 不新增 cron。

工作台：

### 发布审核员

复用新 `/activity-publish-reviews?status=pending`。

### 一审员

复用当前：

```text
GET /api/admin/v1/attendance-sheets?statusCode=pending
```

权限范围由 `attendance-first-reviewer` 的 RoleBinding 决定。

### 终审员

复用：

```text
GET /api/admin/v1/attendance-sheets?statusCode=pending_final_review
```

### 主负责人

`GET /app/v1/my/managed-activities` 每行返回 `nextAction` 和未处理数量。

可 additive 扩展 `meta/dashboard-summary`：

```text
activityPublishReviews.pending
attendanceSheets.pendingFirstReview
attendanceSheets.pendingFinalReview
```

无对应权限时静默省略，沿当前 dashboard-summary 规则。

---

# 15. App capability

扩展 product-level capability，不能返回 raw Permission。

`activities` 增加：

```text
canInitiateActivity
canDirectPublishOwnActivity
```

`managed` 改为：

```text
canViewManagedActivities
canManageManagedRegistrations
canSubmitManagedAttendance
canReviewActivityPublication
canFirstReviewAttendance
canFinalReviewAttendance
```

判断：

- canInitiateActivity：正式等级；
- canDirectPublishOwnActivity：至少有一条有效 publish reviewer grant，仅是入口提示；
- managed registration/attendance：存在 active responsibility assignment；
- reviewer capability：有效 reviewer role；
- 所有写端点仍必须服务端重新判权，capability 不是授权证明。

---

# 16. 历史数据和迁移

## 16.1 禁止自动猜发起人

不得直接做：

```text
initiatorMemberId = publishedBy 对应 memberId
```

原因：

- `publishedBy` 只是点发布按钮的人；
- 可能是代发布管理员；
- 无法证明是业务发起人。

expand migration：

- 只加 nullable 列和新空表；
- 不自动创建责任记录；
- 不改历史 Activity。

---

## 16.2 历史活动分类

### completed / cancelled

- 保持 initiator、owner 可空；
- 只读展示 `legacyUnassigned=true`；
- 不强制认领。

### draft / published 非终态

workflow cutover 前必须完成认领：

- draft：
  - `assign-initiator`
  - 目标必须正式队员；
- published：
  - `claim`
  - 指定当前 owner；
  - initiator 可保持 null，因为历史事实未知；
  - 创建 owner assignment + owner RoleBinding。

上线预检必须确保：

```text
draft/published 且无 initiator/owner 的数量 = 0
```

否则禁止摘除通用旧权限。

---

# 17. Rollout gate

新增：

```text
ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED
```

配置规则：

- dev/test 默认 false，可测试覆盖 true；
- production/smoke 必须显式配置；
- 同一 fleet 禁止 true/false 混跑；
- 切 true 前 drain 旧 server 和旧事务。

## false

- 旧 Admin 行为保持；
- 新表可写测试数据；
- 新角色和新接口可配置但不接生产入口；
- 不摘旧角色权限。

## true

- 正式队员发起规则生效；
- 发布审核生效；
- 负责人/协办授权生效；
- 一审、终审独立角色生效；
- 退回修改生效；
- 老 publish 路由进入兼容 workflow；
- 通用角色摘权必须已完成或同一发布完成。

稳定一版后，另立 cleanup goal 删除 false 分支；本轮不要边上线边删除兼容路径。

---

# 18. 分 PR 实施计划

## PR-0：冻结评审与 characterization

性质：docs/test only。

- 把本文转存到仓库 `docs/archive/reviews/`；
- 补当前行为 characterization：
  - Admin 直接发布；
  - biz-admin 一审；
  - final-reject 当前无隔离；
  - ActivityPosition published 可直接改；
  - reject 软删除 records；
- 写风险表；
- 不改 runtime。

---

## PR-1：Schema expand

- Activity nullable 字段；
- `ActivityPublishReview`；
- `ActivityResponsibilityAssignment`；
- Attendance nullable return/lastSubmit 字段；
- 新 indexes；
- migration 只 additive；
- Prisma generate；
- 不接 runtime。

---

## PR-2：Permission / Role expand

- 新 6 Permission；
- 新 6 Role；
- final reviewer + final-return；
- protected roles；
- system-managed role guard；
- 不从旧角色摘权；
- seed e2e；
- RBAC_MAP true-up。

---

## PR-3：Authz expand

- organization resolver；
- activity_publish_review resolver；
- explain DTO 枚举；
- attendance constraints 扩展；
- strict same reviewer；
- new BizCode；
- authz 四件套 e2e。

---

## PR-4：活动发起与发布审核核心

- InitiationPolicy；
- review state machine；
- review service/query/presenter/audit；
- Admin review endpoints；
- legacy publish compatibility；
- gate=false 旧行为不变；
- review concurrency tests。

---

## PR-5：负责人、协办与 RoleBinding 投影

- responsibility service/table runtime；
- system role projector；
- owner/协办/移交/认领接口；
- Members offboard 结束 active responsibility rows；
- projection invariant tests。

---

## PR-6：App managed activities core

- organization options；
- create/list/detail/update/delete；
- initial review/direct publish/change review；
- positions；
- capabilities；
- App DTO 独立；
- App contract tests。

---

## PR-7：报名责任闭环

- owner/registration collaborator 自动 binding 生效；
- App managed registration endpoints；
- bulk wrapper；
- 通用业务逻辑继续复用 existing service；
- 不拆报名 god-service；
- scoped authz e2e。

---

## PR-8：考勤退回、重提与独立一审

- returned 状态；
- state machine；
- first/final return；
- resubmit；
- edit returned；
- last submitter；
- first/final reviewer role；
- App managed attendance endpoints；
- audit/notification；
- concurrency tests。

---

## PR-9：闭环读模型和工作台

- declare attendance complete；
- closureStatus / nextAction；
- managed list counts；
- dashboard summary additive；
- reviewer workbench查询优化；
- 禁 N+1。

---

## PR-10：历史认领和上线 runbook

- legacy gap 查询；
- claim 演练；
- RoleBinding 配置样例；
- 只读 SQL；
- production checklist；
- 不自动修数。

---

## PR-11：Contract 摘权与切换

- 从 biz-admin/org-admin/group-manager 摘除旧动作权限；
- gate true；
- drain 旧 fleet；
- 所有 reviewer/owner 配置非空；
- full e2e；
- OpenAPI snapshot；
- docs counts/RBAC/CODEMAP；
- 发布说明。

---

# 19. 测试清单

## 19.1 Unit

新增：

```text
activity-initiation-policy.spec.ts
activity-publish-review-state-machine.spec.ts
activity-responsibility-policy.spec.ts
activity-responsibility-grant-projector.spec.ts
activity-closure-policy.spec.ts
attendance-sheet-state-machine.spec.ts
action-constraints.spec.ts
```

至少覆盖：

- 7 个正式 grade；
- volunteer/reserve/null；
- 四种 membership；
- expired/suspended membership；
- cross-org exact/tree/global；
- direct publish；
- review transitions；
- responsibility flags；
- first/final isolation；
- returned/resubmit；
- strict same reviewer env ignored。

---

## 19.2 E2E

新增或扩展：

```text
activity-initiation-workflow.e2e-spec.ts
activity-cross-org-initiation.e2e-spec.ts
activity-publish-review.e2e-spec.ts
activity-publish-review-concurrency.e2e-spec.ts
activity-responsibility.e2e-spec.ts
activity-responsibility-concurrency.e2e-spec.ts
app-managed-activities.e2e-spec.ts
app-managed-activity-registrations.e2e-spec.ts
app-managed-activity-attendances.e2e-spec.ts
attendance-independent-reviewers.e2e-spec.ts
attendance-return-resubmit.e2e-spec.ts
```

必须更新：

```text
authz-rbac-equivalence
authz-three-source
authz-resource-resolver
authz-explain
participation-scoped-authz
attendances-final-review-authz
seed-rbac
role-bindings
members-offboard
openapi.contract-spec
OpenAPI snapshots
```

---

## 19.3 核心验收用例

1. volunteer 不能发起。
2. reserve 不能发起。
3. null grade 不能发起。
4. level-1..7 都能发起。
5. 管理员无正式 member 不能把自己作为发起人。
6. 超管可代正式队员创建，initiator 是目标 member。
7. 默认组织 options 只含当前有效 membership。
8. 跨组织无 grant 拒绝。
9. exact grant 只允许一个组织。
10. tree grant 允许后代。
11. 普通发起人只能提交审核，不能直接发布。
12. 发起人同时为 reviewer 可直接发布。
13. reviewer scope 不覆盖目标组织时不能直发。
14. 普通 biz-admin 不再天然发布。
15. 审核通过后 initiator 成 owner。
16. 审核人不变成 owner。
17. owner 可审核报名、提交考勤。
18. 无责任关系的人不能操作。
19. 报名协办不能提交考勤。
20. 考勤协办不能审核报名。
21. full 协办两者都能。
22. 协办撤销后立即失权。
23. 负责人移交后旧 owner 立即失权。
24. activity-owner RoleBinding 不能通过通用 API 手工分配。
25. first reviewer 必须独立绑定。
26. final reviewer 必须独立绑定。
27. 普通 admin/队长/部长/组长不自动一审。
28. 初次提交人不能一审。
29. 最近重提人不能一审。
30. 提交人不能 final approve、final return、final reject。
31. 一审人不能 final approve、final return、final reject。
32. SUPER_ADMIN 也受人员隔离。
33. first return 保留 records。
34. final return 保留 records。
35. returned 可编辑。
36. resubmit 回 pending 并清审核责任字段。
37. resubmit 后必须重新一审。
38. reject/finalReject 仍软删除 records。
39. Activity status 不因 review pending 改变。
40. published 活动直接 PATCH 返回 change-review-required。
41. change review approve 才修改 live Activity。
42. 两人并发 approve 只有一人成功。
43. owner/RoleBinding 双写事务任一失败整体回滚。
44. legacy 非终态活动未认领时禁止 cutover。
45. 原 `/app/v1/my/activities` 语义完全不变。
46. 考勤提交仍不自动 complete Activity。

---

# 20. 文件级修改清单

## Prisma

```text
prisma/schema.prisma
prisma/migrations/<expand>/
prisma/migrations/<contract-optional>/
prisma/seed.ts
```

## Activities

```text
src/modules/activities/activities.module.ts
src/modules/activities/activities.controller.ts
src/modules/activities/activities.service.ts
src/modules/activities/activities.dto.ts
src/modules/activities/activity-state-machine.ts
src/modules/activities/activity-audit-recorder.ts
src/modules/activities/activity-positions.service.ts
src/modules/activities/activity-positions.dto.ts
src/modules/activities/<new workflow files>
src/modules/activities/controllers/app-managed-*.controller.ts
src/modules/activities/controllers/admin-activity-publish-reviews.controller.ts
src/modules/activities/controllers/admin-activity-responsibilities.controller.ts
src/modules/activities/dto/app/*
```

## Registrations

```text
src/modules/activity-registrations/activity-registrations.module.ts
src/modules/activity-registrations/activity-registrations.service.ts
src/modules/activity-registrations/controllers/app-managed-activity-registrations.controller.ts
src/modules/activity-registrations/dto/app/*
```

## Attendances

```text
src/modules/attendances/attendances.module.ts
src/modules/attendances/attendances.controller.ts
src/modules/attendances/attendances.service.ts
src/modules/attendances/attendances.dto.ts
src/modules/attendances/attendance-sheet-state-machine.ts
src/modules/attendances/attendance-presenter.ts
src/modules/attendances/attendance-audit-recorder.ts
src/modules/attendances/attendance-correction.service.ts
src/modules/attendances/controllers/admin-attendance-sheet-corrections.controller.ts
src/modules/attendances/controllers/app-managed-activity-attendances.controller.ts
src/modules/attendances/dto/app/*
```

## Authz / Permissions

```text
src/modules/authz/resource-resolver.service.ts
src/modules/authz/authz.types.ts
src/modules/authz/authz.dto.ts
src/modules/authz/action-constraints.ts
src/modules/authz/action-state-checks.ts
src/modules/permissions/protected-role-codes.ts
src/modules/permissions/system-managed-role-codes.ts
src/modules/permissions/role-delegation.policy.ts
src/modules/role-bindings/*
src/common/exceptions/biz-code.constant.ts
```

## Users / Members / Meta / Notifications

```text
src/modules/users/app-capability.service.ts
src/modules/users/dto/app/app-capability-response.dto.ts
src/modules/members/members.service.ts
src/modules/meta/*
src/modules/notifications/*
```

## Tests / Docs

```text
test/unit/*
test/e2e/*
test/contract/openapi.contract-spec.ts
test/contract/__snapshots__/*
CODEMAP.md
docs/current-state.md
docs/ai-harness/RBAC_MAP.md
docs/handoff/admin-web.md
docs/handoff/miniapp.md
CHANGELOG.md
```

---

# 21. 禁止事项

执行 AI 不得：

- 把 `publishedBy` 当活动负责人；
- 用 publishedBy 自动回填历史 initiator；
- 让普通 biz-admin 继续绕过发布审核；
- 让 org-admin/group-manager 自动拥有一审；
- 把 activity reviewer 写进职务自动 policy；
- 把 first reviewer 写进职务自动 policy；
- 允许系统自动角色被手工 RoleBinding；
- 让协办权限扩到其他活动；
- 让 activity review 自审规则照搬考勤严格隔离；
- 让考勤 final-reject 绕过人员隔离；
- 继续使用 `ATTENDANCE_ALLOW_SAME_REVIEWER=true` 放开同人终审；
- 把退回修改实现成 records 软删除；
- 让终审退回后直接回 pending_final_review；
- 让考勤提交自动 complete Activity；
- 修改现有 `/api/app/v1/my/activities` 语义；
- 在 App 返回 raw Permission、RoleBinding id、敏感资料；
- 在主业务事务内调用外部通知 provider；
- 引入第三个 cron、Redis、BullMQ 或通用 event bus；
- 为了“代码整洁”顺手大拆现有 god-service；
- 跳过 OpenAPI snapshot、RBAC map 或 counts 更新；
- 把 migration、seed、生产配置切换混在一次不可审查的大提交中。

---

# 22. Definition of Done

只有以下全部满足，才算完成：

- [ ] 正式队员发起资格按 `level-1..7` 实装；
- [ ] 当前 membership 与跨组织 grant 均实装；
- [ ] 独立发布审核员角色实装；
- [ ] 发起人 reviewer 直发实装；
- [ ] 发布审核历史和变更审核实装；
- [ ] 主负责人、协办、移交及历史实装；
- [ ] 自动 Activity scoped RoleBinding 投影实装；
- [ ] 系统自动角色手工授予保护实装；
- [ ] 通用角色活动动作权限完成 contract 摘除；
- [ ] 独立一审角色实装；
- [ ] final reviewer 增加 final-return；
- [ ] 所有考勤审核动作完成人员隔离；
- [ ] returned 状态、编辑、重提实装；
- [ ] reject/finalReject 终态语义不变；
- [ ] App managed activity 全链路接口实装；
- [ ] Admin review、责任配置、历史认领实装；
- [ ] capability、workbench、nextAction 实装；
- [ ] 审计 fail-closed；
- [ ] 通知 commit 后执行；
- [ ] 旧非终态活动认领完成；
- [ ] rollout gate 演练完成；
- [ ] `pnpm agent:check:full` 全绿；
- [ ] `docs:codemap:check` 0 FAIL；
- [ ] `docs:rbacmap:check` 0 FAIL / 0 WARN；
- [ ] `docs:counts:check` 全绿；
- [ ] contract snapshot 的每一处变化均在 PR 中解释；
- [ ] 当前 366 个旧接口除明确 additive/兼容行为外无意外漂移；
- [ ] 生产切换前确认全 fleet 同一 gate 档位。

---

# 23. 最终业务验收话术

完成后，系统应当能用下面这段大白话解释：

> 只有正式队员可以发起活动。默认只能选择自己当前所属的组织；需要给别的部门发活动时，要先获得明确的跨部门发起资格。普通队员提交活动后，由单独指定的活动发布审核员把关；发起人本人如果也是该组织的发布审核员，可以直接发布。
>
> 活动发布后，发起人就是主负责人，负责报名审核、现场跟进、考勤提交和被退回后的整改。临时有事可以找参与人员或本组织成员协办，也可以正式移交负责人，但所有委托和移交都必须留痕。
>
> 考勤提交以后，进入独立的一审和终审。管理员、队长、部长、组长不会因为身份自动获得审核权。提交人不能审核自己的单，一审人不能再终审同一张单，超级管理员也不能绕过这些人员隔离。
>
> 普通错误要退回修改，原数据保留，修改后重新从一审开始；只有真正无效的考勤才作废驳回。活动完成、考勤全部提交且所有有效考勤终审通过后，责任闭环才算完成。

---

# 24. 仓库冻结附录（PR-0）

> 冻结时间：2026-07-23
> 仓库锚点：`main@087fb00d59f405577be72bef4d3e73d36e3868d2`
> 原始业务定版：`srvf-api_v0.61.0_活动责任闭环落地开发规格.md`
> 本附录只登记实施入口、风险与 characterization 证据，不改变前述业务决议。

## 24.1 开工探针

`pnpm agent:preflight --lane activity-workflow-v2` 在上述锚点通过：

- 工作树 clean；
- open PR 为 0；
- 本地 `main` 不落后 `origin/main`；
- `package.json`、Swagger 与最新 tag 均为 `v0.61.0`；
- 当前仓库只有主 worktree。

因此本项目按本文 PR-0 至 PR-11 串行实施。schema lane 同一时刻只允许一条；每一刀均以独立写集、独立验证和独立 PR 交付。

## 24.2 当前行为 characterization 探针

本文 PR-0 要求冻结的五项旧行为，在 `v0.61.0` 已有可执行测试覆盖。为避免重复造同义 E2E，本刀登记既有权威用例，不新增重复测试：

| 旧行为 | 当前可执行证据 | 后续切换要求 |
|---|---|---|
| 持 `biz-admin` 的 Admin 可直接发布 draft | `test/e2e/activities-rbac-boundary.e2e-spec.ts` 的 publish 权限矩阵断言 Admin+biz-admin 返回 200 | PR-4 gate=false 必须保持；gate=true 才切发布审核 |
| `biz-admin` 仍可做考勤一审 | `test/e2e/attendances-final-review-authz.e2e-spec.ts` 的“其余 6 考勤动作仍 ALLOW”断言包含 `attendance.approve.sheet` / `attendance.reject.sheet` | PR-2 expand 不摘权；PR-11 contract 才摘权 |
| `final-reject` 当前没有自审/一级同人隔离 | `test/e2e/attendances-final-review-authz.e2e-spec.ts` 的“SA submitter 自 reject → 200”用例 | PR-3 扩 ActionConstraint 后翻面，且覆盖 SUPER_ADMIN |
| published 活动岗位当前可直接新增、更新、删除 | `test/e2e/activity-positions-http.e2e-spec.ts` 在 published fixture 上锁定 Admin 创建、更新、软删全链 | PR-4/PR-6 gate=true 才改为 change review |
| 一级 reject / finalReject 当前软删除 records | `test/e2e/attendances-reject-transition.e2e-spec.ts` 与 `test/e2e/attendances-state-transition.e2e-spec.ts` 分别锁定两级驳回的 `records.deletedAt` | PR-8 新增 return 保留 records，既有 reject/finalReject 终态语义不变 |

若后续实现需要改动这些既有断言，必须能逐项对应本文 D-12 至 D-18；任何未在本文拍板的翻面都视为契约外变更并停止。

## 24.3 D 档风险表

| 风险 | 影响面 | 最坏情况 | 预防 / 回退条件 |
|---|---|---|---|
| expand migration 与旧 binary 不兼容 | `Activity`、`AttendanceSheet`、两张新表 | 混跑期间旧实例写入失败或新实例读取空历史误判 | PR-1 只加 nullable/default 字段和空表；不回填 initiator/owner；若 migration 预检不满足即不部署 |
| 活动、责任表与 RoleBinding 双写漂移 | activities、role-bindings、members offboard | assignment 已生效但权限未生效，或撤责后仍有权限 | 同一事务投影；固定 deterministic key；投影 invariant/concurrency E2E；失败整单回滚 |
| 发布审核与活动/岗位并发丢更新 | activities、positions、waitlist | 审核应用旧快照覆盖新数据，或重复发布/重复 owner | 固定 Activity → review → positions/registrations 锁序；baseRevision + partial unique；真实 PostgreSQL 并发测试 |
| 考勤 return/resubmit 与 approve/reject 竞态 | attendances、records | 已重提的数据被旧审核覆盖，或 records 被误删 | 复用 `claimAtStatus`；锁后重读稳定字段；return 保留 records，terminal reject 仍软删 |
| 人员隔离只覆盖部分审核动作 | authz、attendances | 提交人或一审人通过 return/reject 绕过隔离 | 六个审核动作统一注册约束；SUPER_ADMIN 不豁免；true/false env 均锁严格语义 |
| 通用角色过早摘权 | seed、RolePermission、生产配置 | 发布/一审工作台出现权限真空 | PR-2 只 expand；PR-10 完成只读 gap/配置演练；PR-11 才 contract 摘权；gap 非零禁止切换 |
| 历史活动被错误归因 | activities、成员、审计 | 把代发布人错误写成发起人/负责人 | 禁止从 `publishedBy` 猜测；旧 draft/published 通过显式 assign/claim；终态允许 null |
| gate 混档 | app config、fleet、所有新入口 | 同一请求在不同实例呈现两套授权/状态语义 | production/smoke 显式配置；切 true 前 drain 旧实例和旧事务；同一 fleet 禁止 true/false 混跑 |
| 审计或通知破坏主事务语义 | audit-logs、notifications | 无审计业务成功，或 provider 故障回滚业务 | audit 与业务同事务 fail-closed；通知仅 commit 后 best-effort；不新增 event/type/cron |
| API/snapshot 大面积漂移 | 5 个新 App controller、Admin 工作台、DTO | 366 个既有接口发生非预期变更或 App 泄露 L3/raw RBAC | App/Admin DTO 物理分离；老路径兼容；每 PR 逐行解释 snapshot；最终全量 contract/e2e |

## 24.4 方案对比与冻结选择

### 方案 A：expand → runtime 分刀 → 配置/认领演练 → contract（采用）

- 按本文 PR-0 至 PR-11 串行；
- gate=false 保留旧行为，先建立 schema、权限、Authz 与 workflow；
- 历史 gap、reviewer 绑定、owner 投影均完成演练后，最后一刀摘除通用角色旧权限并切 gate；
- 任一刀可在未进入 contract 前回退到旧入口，新增 nullable 数据保留但不参与旧流程。

### 方案 B：单 PR 同时改 schema、权限、runtime、历史数据和 gate（拒绝）

- diff 无法独立审查；
- 旧 binary 与新 schema/权限混跑风险不可隔离；
- 出现权限真空或历史归因错误时无法只回退某一层；
- 违反 `docs/process.md` 的 D 档分 PR 与本文禁止巨型 PR 的硬约束。

冻结结论：采用方案 A。生产 migration、seed、历史认领、配置切换和数据修复均不由 AI 自动执行；本项目只交付代码、migration source、只读预检、演练证据和切换 runbook。
