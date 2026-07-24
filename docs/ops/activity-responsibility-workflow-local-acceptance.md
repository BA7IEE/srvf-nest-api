# 活动责任闭环本地验收与前端联调说明

> **本文件只用于本地开发和联调，不得直接照此操作生产环境。**
>
> 当前能力是 Unreleased 开发版，只允许在自动派生的 `app_test_*`、CI 临时测试库或可销毁的 Docker Smoke 临时库中验证。它不是正式上线、部署或切换指令。

## 1. 现在能做什么

后端已经提供从“正式队员发起活动”到“发布审核、报名管理、考勤提交、独立两级审核、退回修改、负责人移交、活动完结”的完整开发版接口。当前本地验收的完成标志是：

- 活动为 `completed`；
- owner 已声明考勤全部提交；
- 没有 `pending`、`pending_final_review` 或 `returned` 的有效考勤单；
- 详情返回 `closure.status === 'closed'`；
- `closure.nextAction === null`。

`closure` 没有 `closed` 布尔字段。前端必须判断 `closure.status`，不要自行汇总考勤单推导闭环。

## 2. 本地测试账号

只创建明显的占位数据，不使用真实姓名、手机号、证件号、账号、`memberNo` 或组织关系。

| 占位账号 | 本地职责 | 主要动作 |
|---|---|---|
| Local Activity Owner | 正式队员、活动发起人和初始 owner | 建草稿、送审、报名审核、委托、移交 |
| Local Publish Reviewer | 显式配置的发布审核员 | 审核发布申请，不因此成为 owner |
| Local Registration Collaborator | 只管理报名的协办人 | 查看和审核本活动报名 |
| Local Attendance Collaborator | 只管理考勤的协办人 | 整理、编辑、提交本活动考勤 |
| Local First Reviewer A/B | 显式配置的考勤一审员 | 一审通过、拒绝或退回 |
| Local Final Reviewer A/B | 显式配置的考勤终审员 | 终审通过、拒绝或退回 |
| Local New Activity Owner | 移交后的新 owner | 完结活动、声明考勤提交完成 |
| Local Participant | 普通参与队员 | 报名；终审通过后查看本人工时和贡献 |
| Local Unrelated Administrator | 有通用管理角色但无本活动责任 | 用于验证报名、考勤写操作均被拒绝 |
| Local Cross Organization Initiator | 只有跨组织发起资格 | 可在授权组织建草稿，但不能管理别人活动 |

这些角色只在隔离测试库中用 fixture 建立。发布、一审、终审必须是显式 scoped RoleBinding；通用管理员身份、页面可见性或 `SUPER_ADMIN` 不能代替正常责任边界。

## 3. 前端的五个入口

| 用户要做的事 | 前端入口 | 后端数据源 |
|---|---|---|
| 看我参加过或报名的活动 | 我参与的活动 | `GET /api/app/v1/my/activities` |
| 看我发起、主责或协办的活动 | 我发起或负责的活动 | `GET /api/app/v1/my/managed-activities` |
| 审核活动发布 | 待发布审核 | `GET /api/admin/v1/activity-publish-reviews?status=pending` |
| 审核考勤一审 | 待一审 | `GET /api/admin/v1/attendance-sheets?statusCode=pending` |
| 审核考勤终审 | 待终审 | `GET /api/admin/v1/attendance-sheets?statusCode=pending_final_review` |

后三项是 Admin 审批面，不要塞进 App 的“我参与的活动”。能看到列表也不等于能操作某条资源。

## 4. 从创建到闭环怎么验

### A. 普通正式队员发起并送审

1. Local Activity Owner 登录 App。只有 `gradeCode ∈ level-1..level-7`、ACTIVE 且有 ACTIVE User 的正式队员才显示“发起活动”。
2. 先读 `GET /api/app/v1/my/managed-activities/organization-options`。组织选择器只使用返回项。
3. `POST /api/app/v1/my/managed-activities` 建草稿，再用 `PATCH` 编辑活动，用 `/positions` 子资源新增和编辑岗位。
4. 普通发起人显示“提交发布审核”，调用 `POST .../:activityId/submit-publish-review`。状态仍是 `draft`，公开活动详情不可见。
5. Local Publish Reviewer 在待发布审核列表打开申请并调用 `POST /api/admin/v1/activity-publish-reviews/:id/approve`。
6. 成功后活动为 `published`，发起人成为唯一 active owner，并生成 `activity-owner@ACTIVITY` RoleBinding；审核员不是 owner。

不应出现：普通发起人的“直接发布”、审核员的 owner 管理按钮、待审活动的公开报名入口。

### B. 有审核资格的发起人直接发布

当发起人对活动所属组织有有效 `activity-publish-reviewer` grant 时，详情的 `publishReview.canDirectPublish` 才能驱动“直接发布”。调用 `POST .../:activityId/direct-publish` 后仍会生成完整 `ActivityPublishReview`，其中：

- `directPublish=true`；
- `submittedByUserId === reviewedByUserId`；
- 发起人仍是唯一 owner；
- 审计保留直发动作。

不要用“是管理员”“是队长”或 `publishedBy` 判断是否显示按钮。

### C. 报名审核责任

1. Local Participant 调 `POST /api/app/v1/my/registrations`，状态进入 `pending`。
2. owner 可在 `/:activityId/registrations` 审核通过。
3. Local Unrelated Administrator 即使有通用管理角色也应收到 `30100`。
4. owner 添加 `canManageRegistrations=true, canManageAttendance=false` 的协办人。
5. 报名协办人可以管理报名，但访问考勤管理接口应收到 `30100`。

### D. 临时委托考勤

1. owner 添加 `canManageRegistrations=false, canManageAttendance=true` 的协办人。
2. 考勤协办人从 `check-ins` 和 `attendance-sheet-draft` 整理草稿，再向 `attendance-sheets` 提交。
3. 返回的 `submitterUserId`、`lastSubmittedByUserId` 应是真实协办用户；owner assignment 不变。
4. 报名协办人和无活动责任的通用管理员不能提交考勤。
5. 考勤提交按钮与审核按钮必须分开。拥有考勤协办责任不等于拥有一审或终审权限。

### E. 独立一审和终审

1. 有效考勤单从 `pending` 开始。
2. 独立一审员通过后进入 `pending_final_review`。
3. 独立终审员通过后进入 `approved`。
4. 原提交人或最近重提人不能一审、不能终审；一审人不能终审同一张单。
5. 上述人员隔离对 `SUPER_ADMIN` 同样生效。
6. 只有终审通过后，`/api/app/v1/my/attendance-records` 和 `/api/app/v1/my/participation-summary` 才计入工时、记录数和贡献值。

### F. 一审、终审退回修改

一审退回和终审退回都要实际走一遍：

1. 审核员必须填写退回原因；单据进入 `returned`。
2. 前端展示退回原因、“修改”和“重新提交”，原 records 必须仍可读取。
3. owner 或考勤协办人先 `PATCH` 编辑，再 `POST .../:sheetId/resubmit`。
4. 重提后回到 `pending`，当前审核人、终审人、退回人、退回原因和退回阶段字段按契约清空，历史由审计保留。
5. 最近重提人不能审核自己的单据。
6. 重新从一审开始，由另一名一审员和独立终审员最终通过。

`22082` 表示退回原因缺失，`22083` 表示当前状态不能重提。

### G. 负责人移交

owner 调 `POST .../:activityId/transfer-owner`：

- `initiatorMemberId` 永远保留原发起人；
- 旧 owner assignment 和它的 `activity-owner` binding 结束；
- 新 owner 获得新的 assignment 和 binding；
- `retainPreviousOwnerAsCollaborator=true` 时，旧 owner 转为同时管理报名和考勤的协办人；
- 历史 assignment、binding 和 transfer audit 不删除。

移交后只有新 owner 能声明考勤全部提交。

### H. 跨组织发起

- 无授权：不能选择其他组织；
- `ORGANIZATION` 精确授权：可在该组织发起；
- `ORGANIZATION_TREE`：可覆盖授权树下级；
- `GLOBAL` 也不能绕过停用组织或根组织禁令；
- `activity.create.cross-org` 只允许创建草稿。它不授予目标组织中别人活动的报名管理、考勤管理、移交或完结权限。

### I. 最终闭环

本地验收使用真实状态接口，顺序如下：

1. 通过测试 fixture 只推进活动时间到已结束；不直接修改业务状态。
2. 当前 owner 调 `POST /api/admin/v1/activities/:id/complete`，活动从 `published` 进入 `completed`。
3. 当前 owner 调 `POST /api/app/v1/my/managed-activities/:id/declare-attendance-complete`。
4. 所有 `returned` 单修改重提，所有 `pending` 完成一审，所有 `pending_final_review` 完成终审。
5. 重新读取 managed detail，确认 `closure.status='closed'`、`closure.nextAction=null`、`counts.unresolvedAttendanceSheets=0`。

代码也允许在活动已结束但仍为 `published` 时先声明、后完结；前端不用推导顺序，按 detail 的 `closure.nextAction` 引导即可。`rejected`、`final_rejected` 和软删除单属于已解决历史，不阻挡闭环。

## 5. 按钮显示规则

| 按钮 | 显示依据 | 不应仅依据 |
|---|---|---|
| 发起活动 | `/me/capabilities.activities.canInitiateActivity` + `organization-options` 非空 | ADMIN、队长头衔 |
| 直接发布 | 详情 `publishReview.canDirectPublish=true` 且活动状态允许 | `publishedBy`、页面可见 |
| 提交发布审核 | 本人是 initiator、活动为可提交 draft、无 pending review | capability 单独为 true |
| 管理报名 | `myResponsibility.canManageRegistrations=true` + 报名状态允许 | 通用管理员 |
| 管理考勤 | `myResponsibility.canManageAttendance=true` + 单据状态允许 | 管理报名能力 |
| 一审 | Admin action/resource 判权通过 + `statusCode=pending` + 非提交/重提人 | 能看考勤页 |
| 终审 | Admin action/resource 判权通过 + `statusCode=pending_final_review` + 人员隔离通过 | 一审资格或 SUPER_ADMIN |
| 修改、重提 | `statusCode=returned` + 本活动考勤责任 | 任意管理员 |
| 声明考勤完成 | 当前 `myResponsibility.responsibilityType='owner'` + `closure.nextAction` 对应 | initiator、旧 owner、`publishedBy` |

`GET /api/app/v1/me/capabilities` 是产品入口提示，不是某一活动的最终授权证明。按钮还必须结合 resource-specific responsibility 和状态；服务端每次请求的判定才是最终结果。

## 6. 常见错误码

| BizCode | 大白话 |
|---:|---|
| `20019` | 当前队员不是可发起活动的正式级别 |
| `20020` | 没有在目标组织发起活动的资格 |
| `20021` | 发布审核退回时缺少原因 |
| `20022` | 发布审核快照无效，或已发布普通变更试图迁移组织 |
| `20030` | 活动当前状态不允许这个动作 |
| `20032` | 已有待处理发布审核，不能重复提交或直接改 |
| `20037` | 已发布活动不能直接改，要提交变更审核 |
| `20039` | 当前还不能声明考勤全部提交，或已经声明过 |
| `22074` | 考勤提交人不能终审自己的单 |
| `22075` | 一审人不能终审同一张单 |
| `22081` | 考勤提交人或最近重提人不能一审 |
| `22082` | 退回原因不能为空 |
| `22083` | 只有 `returned` 单据可以重提 |
| `30100` | 对这条具体活动、报名或考勤没有操作权限 |

前端按 `HTTP status + BizCode` 处理，不要只比对 message 文案。

## 7. 主要接口

- App 发起与管理：`/api/app/v1/my/managed-activities`
- App 岗位：`/api/app/v1/my/managed-activities/:activityId/positions`
- App 责任：`responsibilities`、`collaborators`、`transfer-owner`
- App 报名管理：`/:activityId/registrations`
- App 考勤管理：`check-ins`、`attendance-sheet-draft`、`attendance-sheets`
- App 本人报名：`/api/app/v1/my/registrations`
- Admin 发布审核：`/api/admin/v1/activity-publish-reviews`
- Admin 考勤一审/终审/退回/重提：`/api/admin/v1/attendance-sheets`
- Admin 活动完结：`POST /api/admin/v1/activities/:id/complete`
- App 本人工时/贡献：`/api/app/v1/my/attendance-records`、`participation-summary`

字段和响应形状以同一提交的 `docs/handoff/openapi.json`、contract snapshot 和实际 `/api/docs-json` 为准。

## 8. 30 条业务规则与现有测试

聚合验收只补零散用例没有串起来的接缝；已有稳定矩阵不复制。

| # | 规则 | 主要现有测试锚点 |
|---:|---|---|
| 1 | 正式队员发起 | `activity-initiation-policy.spec.ts` — `accepts formal grade...`；`app-managed-activities.e2e-spec.ts` — `keeps /my/activities separate...` |
| 2 | volunteer/reserve/null 不能发起 | `activity-initiation-policy.spec.ts` — `rejects non-formal grade...`；`app-managed-activities.e2e-spec.ts` — `rejects non-formal members...` |
| 3 | 本组织发起 | 同上 initiation policy 与 managed activities E2E |
| 4 | 跨组织 EXACT | `app-managed-activities.e2e-spec.ts` — `allows a draft move with an EXACT...` |
| 5 | 跨组织 TREE | `app-managed-activities.e2e-spec.ts` — `allows a draft move with an ORGANIZATION_TREE...` |
| 6 | 无跨组织权限拒绝 | `app-managed-activities.e2e-spec.ts` — `rejects an A-member moving a draft to B...` |
| 7 | 停用/根组织拒绝 | `activity-initiation-policy.spec.ts` — `rejects ... target organization...`；managed activities root/inactive cases |
| 8 | 普通发起人送审 | `app-managed-activities.e2e-spec.ts` — draft CRUD/submit/withdraw；本地聚合 E2E 第一条 |
| 9 | 发布审核通过 | `activity-publish-review.e2e-spec.ts` — reviewer return then approve；本地聚合 E2E 第一条 |
| 10 | 发布审核退回 | `activity-publish-review.e2e-spec.ts` — reviewer returns then approves v2 |
| 11 | 持审核资格直发 | `activity-publish-review.e2e-spec.ts` — `legacy publish direct-publishes...`；本地聚合 E2E 第二条 |
| 12 | 发布后发起人成 owner | `activity-publish-review.e2e-spec.ts`；本地聚合 E2E |
| 13 | owner 投影 RoleBinding | `activity-publish-review-concurrency.e2e-spec.ts`；本地聚合 E2E |
| 14 | 报名仅 owner/报名协办管理 | `app-managed-activity-registrations.e2e-spec.ts`；本地聚合自助报名→审核链 |
| 15 | 考勤仅 owner/考勤协办提交 | `app-managed-activity-attendances.e2e-spec.ts`；本地聚合 E2E |
| 16 | 临时协办 | registration/attendance 两个 managed E2E；本地聚合 E2E |
| 17 | 负责人移交 | `activity-responsibilities.e2e-spec.ts`；本地聚合 E2E 的 retain/history/binding/audit |
| 18 | 一审独立配置 | `seed-position-role-policies.e2e-spec.ts`；`participation-scoped-authz.e2e-spec.ts` |
| 19 | 终审独立配置 | `seed-position-role-policies.e2e-spec.ts`；`attendances-final-review-authz.e2e-spec.ts` |
| 20 | 提交人不能一审 | `action-constraints.spec.ts`；`attendances-final-review-authz.e2e-spec.ts` |
| 21 | 提交人不能终审 | 同上 |
| 22 | 一审人不能终审 | 同上 same-reviewer cases |
| 23 | 一审退回修改 | `attendance-return-resubmit.e2e-spec.ts`；本地聚合真实 PATCH+resubmit |
| 24 | 终审退回修改 | `attendance-return-resubmit.e2e-spec.ts`；本地聚合真实 PATCH+resubmit |
| 25 | 重提后从一审开始 | `attendance-sheet-state-machine.spec.ts`；本地聚合换人复审 |
| 26 | 终审后工时/贡献生效 | `attendances.e2e-spec.ts` approved-only cases；本地聚合前后 summary 对账 |
| 27 | 活动责任闭环状态 | `activity-closure-policy.spec.ts`；本地聚合真实 complete/declare/review HTTP 链 |
| 28 | 离队结束责任/投影 | `activity-responsibilities.e2e-spec.ts` — `member offboard revokes...` |
| 29 | 已发布普通变更不能迁组织 | `app-managed-activities.e2e-spec.ts` — `rejects a published change proposal...` |
| 30 | 发布审核快照篡改拒绝 | `activity-publish-review.e2e-spec.ts` — snapshot tamper cases |

新增的 `test/e2e/activity-workflow-local-acceptance.e2e-spec.ts` 有三条聚合用例：

1. App 普通送审 → 独立发布审核 → 公开可见 → 唯一 owner/binding；
2. 无 test-only legacy role 的直发 → 自助报名 → 责任审核 → 考勤协办提交 → 一审退回/编辑/重提 → 终审退回/编辑/重提 → owner 移交 → complete/declare → approved-only 生效 → closed；
3. 跨组织发起 grant 对别人活动的报名、考勤和完结管理不外溢。

## 9. 本地执行与清理

在仓库派生 worktree 中先跑 preflight，再使用仓库 E2E 入口。测试框架会从 worktree 名自动派生 `app_test_*` 数据库：

```bash
pnpm agent:preflight --lane activity-workflow-v2-pr14-local-acceptance
pnpm test:e2e -- test/e2e/activity-workflow-local-acceptance.e2e-spec.ts --runInBand
```

完整聚焦队列和最终验证结果记录在本 PR。测试数据由 `resetDb` 清空并重建；需要彻底清理时，只能处理明确识别为本 lane 自动派生、可销毁的 `app_test_*` 库或 Docker Smoke 临时库。不要清理日常开发库，不要把此处任何清理思路用于正式环境。

## 10. 当前没有做什么

- 没有正式环境、正式用户、真实业务数据或正式 fleet；
- 没有执行正式环境 migration、seed、历史活动认领或真实 RoleBinding 配置；
- 没有修改正式环境变量，没有 drain、部署、恢复流量、release、tag 或版本号变更；
- 没有删除 gate=false 兼容分支；
- 未来正式上线必须按届时批准的 release tag 和不可变 image digest 重新验证，不能把本次 SHA 当作永久发布锚点。
