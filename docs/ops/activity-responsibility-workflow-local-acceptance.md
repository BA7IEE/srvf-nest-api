# 活动责任闭环本地验收与前端联调说明

> **本文件只用于专用本地联调数据库，不得复制命令操作正式环境。**
>
> 当前能力仍是 Unreleased 开发版。前端手工联调只使用按
> [`activity-responsibility-workflow-local-bootstrap.md`](activity-responsibility-workflow-local-bootstrap.md)
> 建立的 `app_local_frontend` / `app_local_frontend_<suffix>` 专用可销毁数据库；自动测试继续只用自动派生的
> `app_test_*`、CI 临时测试库或 Docker Smoke 临时库。它不是正式上线、部署或切换指令。

## 1. 现在能做什么

后端已经提供从“正式队员发起活动”到“发布审核、报名管理、考勤提交、独立两级审核、退回修改、负责人移交、活动完结”的完整开发版接口。当前本地验收的完成标志是：

- 活动为 `completed`；
- owner 已声明考勤全部提交；
- 没有 `pending`、`pending_final_review` 或 `returned` 的有效考勤单；
- 详情返回 `closure.status === 'closed'`；
- `closure.nextAction === null`。

`closure` 没有 `closed` 布尔字段。前端必须判断 `closure.status`，不要自行汇总考勤单推导闭环。

## 2. 本地测试账号

固定 17 个用户名、组织、等级、预置授权和可见性矩阵以
[`activity-responsibility-workflow-local-bootstrap.md §6`](activity-responsibility-workflow-local-bootstrap.md#6-固定账号矩阵)
为唯一准备清单。所有账号都只使用明显的 `local_fe_` / `LOCAL-FE-` 占位数据，不使用真实姓名、手机号、证件号、真实
`memberNo` 或真实组织关系；密码只从调用者提供的 `LOCAL_FRONTEND_FIXTURE_PASSWORD` 读取，任何文档、清单和日志都不记录密码。

A–I 会使用以下职责账号：

- `local_fe_owner`：普通正式队员、主流程发起人和发布后的初始 owner；
- `local_fe_publish_reviewer`：组织 A 的显式发布审核员，也单独验证本人活动直发；
- `local_fe_registration_collab` / `local_fe_attendance_collab`：发布后由 owner 通过业务接口委托；
- `local_fe_first_a` / `local_fe_first_b`：组织 A 的显式考勤一审员；
- `local_fe_final_a` / `local_fe_final_b`：组织 A 的显式考勤终审员；
- `local_fe_new_owner`：负责人移交目标；
- `local_fe_participant_a` / `local_fe_participant_b`：报名、GPS 签到签退和 approved-only 对账；
- `local_fe_unrelated_admin`：只有正常 `biz-admin`，没有 test-only legacy activity role；
- `local_fe_cross_org`：本人属于组织 A，只对组织 B 持有精确跨组织发起授权；
- `local_fe_org_b_owner`：组织 B 的正式队员和发布审核员，用于建立“组织 B 中别人负责”的活动；
- `local_fe_volunteer` / `local_fe_reserve` / `local_fe_no_grade`：三个发起准入负例。

本地正常验收中的发布审核员、考勤一审员和终审员必须使用显式 scoped RoleBinding，不能使用 SUPER_ADMIN 掩盖角色配置问题。实际系统中 SUPER_ADMIN 保留紧急兜底权限，但仍受考勤提交人不能审核自己、最近重提人不能审核自己、一审人不能终审同一张单等人员隔离规则约束，不应作为日常审核人员配置使用。

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

### 开始前：为主流程安排真实短时间窗

本流程不直接改数据库时间，也不通过 Prisma 伪造签到、owner、审核记录或业务状态。创建主流程活动时：

1. `startAt` 预留足够时间完成发布和两名参与者报名，例如从当前时间起 20～30 分钟后开始；
2. `endAt` 使用当天可实际等待结束的短时间窗；
3. `registrationDeadline` 早于 `endAt`，但要给前端操作保留足够时间；
4. `locationLongitude` / `locationLatitude` 填前端测试设备可实际到达的位置；
5. 活动开始后，由两名参与者走真实 GPS 签到、签退；首次签退至少在签到 36 秒后；
6. 活动自然到达 `endAt` 后再执行 I。若时间安排失误，重建一场本地活动，不得用 SQL、Prisma Studio 或手改系统时钟跳状态。

建议分别建立三场本地活动：A + C–I 共用的“普通送审主流程”、B 的“审核员本人直发”、H 的“跨组织授权边界”。不要把三类互斥角色关系硬塞进同一场活动。

### A. 普通正式队员发起并送审

1. `local_fe_owner` 登录 App。只有 `gradeCode ∈ level-1..level-7`、ACTIVE 且有 ACTIVE User 的正式队员才显示“发起活动”。
2. 先读 `GET /api/app/v1/my/managed-activities/organization-options`。组织选择器只使用返回项。
3. `POST /api/app/v1/my/managed-activities` 建草稿，再用 `PATCH` 编辑活动，用 `/positions` 子资源新增和编辑岗位。
4. 普通发起人显示“提交发布审核”，调用 `POST .../:activityId/submit-publish-review`。状态仍是 `draft`，公开活动详情不可见。
5. `local_fe_publish_reviewer` 在待发布审核列表打开申请并调用 `POST /api/admin/v1/activity-publish-reviews/:id/approve`。
6. 成功后活动为 `published`，发起人成为唯一 active owner，并生成 `activity-owner@ACTIVITY` RoleBinding；审核员不是 owner。

不应出现：普通发起人的“直接发布”、审核员的 owner 管理按钮、待审活动的公开报名入口。

### B. 有审核资格的发起人直接发布

`local_fe_publish_reviewer` 另建一场组织 A 活动。当发起人对活动所属组织有有效
`activity-publish-reviewer` grant 时，详情的 `publishReview.canDirectPublish` 才能驱动“直接发布”。调用
`POST .../:activityId/direct-publish` 后仍会生成完整 `ActivityPublishReview`，其中：

- `directPublish=true`；
- `submittedByUserId === reviewedByUserId`；
- 发起人仍是唯一 owner；
- 审计保留直发动作。

不要用“是管理员”“是队长”或 `publishedBy` 判断是否显示按钮。

### C. 报名审核责任

1. `local_fe_participant_a` 和 `local_fe_participant_b` 分别调 `POST /api/app/v1/my/registrations`，状态进入 `pending`。
2. owner 可在 `/:activityId/registrations` 审核通过。
3. `local_fe_unrelated_admin` 即使有通用管理角色也应收到 `30100`。
4. owner 通过真实协办接口把 `local_fe_registration_collab` 添加为
   `canManageRegistrations=true, canManageAttendance=false` 的协办人。
5. `local_fe_registration_collab` 可以管理报名，但访问考勤管理接口应收到 `30100`。

### D. 临时委托考勤

1. owner 通过真实协办接口把 `local_fe_attendance_collab` 添加为
   `canManageRegistrations=false, canManageAttendance=true` 的协办人。
2. 到主流程活动时间窗后，`local_fe_participant_a` / `local_fe_participant_b` 分别通过
   `POST /api/app/v1/my/activities/:activityId/check-in` 和 `check-out` 产生真实 GPS 证据；经纬度使用测试设备当前位置，
   不从数据库伪造，签到后至少 36 秒再首次签退。
3. `local_fe_attendance_collab` 从 `check-ins` 和 `attendance-sheet-draft` 整理草稿，再向
   `attendance-sheets` 提交。
4. 返回的 `submitterUserId`、`lastSubmittedByUserId` 应是真实协办用户；owner assignment 不变。
5. 报名协办人和无活动责任的通用管理员不能提交考勤。
6. 考勤提交按钮与审核按钮必须分开。拥有考勤协办责任不等于拥有一审或终审权限。

### E. 独立一审和终审

1. 有效考勤单从 `pending` 开始。
2. `local_fe_first_a` / `local_fe_first_b` 承担互相独立的一审轮次，通过后进入
   `pending_final_review`。
3. `local_fe_final_a` / `local_fe_final_b` 承担独立终审，通过后进入 `approved`。
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

`local_fe_owner` 把负责人移交给 `local_fe_new_owner`，调用 `POST .../:activityId/transfer-owner`：

- `initiatorMemberId` 永远保留原发起人；
- 旧 owner assignment 和它的 `activity-owner` binding 结束；
- 新 owner 获得新的 assignment 和 binding；
- `retainPreviousOwnerAsCollaborator=true` 时，旧 owner 转为同时管理报名和考勤的协办人；
- 历史 assignment、binding 和 transfer audit 不删除。

移交后只有新 owner 能声明考勤全部提交。

### H. 跨组织发起

- `local_fe_owner` 的 organization-options 只能包含组织 A，不能包含组织 B；
- `local_fe_cross_org` 属于组织 A，但 organization-options 还应包含组织 B，且该项
  `source='cross-org-grant'`；
- `local_fe_cross_org` 可在组织 B 建草稿；
- `local_fe_org_b_owner` 在组织 B 建立并发布另一场属于自己的活动；
- `local_fe_cross_org` 不能管理 `local_fe_org_b_owner` 的报名、考勤、移交或完结，越权动作返回
  `30100`；
- `ORGANIZATION` 精确授权：可在该组织发起；
- `ORGANIZATION_TREE`：可覆盖授权树下级；
- `GLOBAL` 也不能绕过停用组织或根组织禁令；
- `activity.create.cross-org` 只允许创建草稿。它不授予目标组织中别人活动的报名管理、考勤管理、移交或完结权限。

### I. 最终闭环

本地验收使用真实状态接口，顺序如下：

1. 等待主流程活动自然到达 `endAt`；不得直接修改数据库时间、Activity 状态、审核状态或 closure 字段。
2. 当前 owner `local_fe_new_owner` 调 `POST /api/admin/v1/activities/:id/complete`，活动从
   `published` 进入 `completed`。
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

## 6. 常见错误码与排查

| BizCode | HTTP | 大白话与本地排查 |
|---:|---:|---|
| `20019` | 403 | 当前队员不是可发起活动的正式级别。核对 `gradeCode`；`volunteer`、`reserve`、`null` 都是预期负例，不要给它们补权限绕过 |
| `20020` | 403 | 没有在目标组织发起活动的资格。先刷新 `organization-options`；本组织项应来自 `membership`，跨组织项应来自精确 `cross-org-grant`，前端不得提交 options 之外的组织 |
| `20021` | 400 | 发布审核退回时缺少原因 |
| `20022` | 409 | 发布审核快照无效，或已发布普通变更试图迁移组织 |
| `20030` | 409 | 活动当前状态不允许这个动作 |
| `20032` | 409 | 已有待处理发布审核，不能重复提交或直接改 |
| `20037` | 409 | 已发布活动不能直接改，要提交变更审核 |
| `20039` | 409 | 当前还不能声明考勤全部提交，或已经声明过 |
| `22074` | 403 | 考勤提交人或最近重提人不能终审自己的单。换用没有提交/重提过该单的显式终审员；SUPER_ADMIN 也不能绕过 |
| `22075` | 403 | 一审人不能终审同一张单。换用另一名显式终审员；SUPER_ADMIN 也不能绕过 |
| `22081` | 403 | 考勤提交人或最近重提人不能一审 |
| `22082` | 400 | 退回原因不能为空 |
| `22083` | 409 | 只有 `returned` 单据可以重提 |
| `30100` | 403 | 对这条具体活动、报名或考勤没有操作权限。先区分“工作台可见”和“资源可操作”，再核对 scoped reviewer grant、`myResponsibility`、Activity/Sheet 状态；不要给 `biz-admin` 或 unrelated admin 补 legacy 活动角色 |

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

前端手工联调必须先完整执行
[`activity-responsibility-workflow-local-bootstrap.md`](activity-responsibility-workflow-local-bootstrap.md)；
其中的数据库名、显式确认值、setup、verify、print、启动与重建步骤是一条完整链，不能只复制中间一条命令。

下面的命令仅供后端开发者回归自动聚合 E2E，不会创建可供前端长期登录的 17 个稳定账号，也不能替代 bootstrap：

```bash
pnpm agent:preflight --lane activity-workflow-v2-pr15-local-frontend-bootstrap
pnpm test:e2e -- test/e2e/activity-workflow-local-acceptance.e2e-spec.ts --runInBand
```

自动测试框架会从 worktree 名派生 `app_test_*` 数据库并由 `resetDb` 清空重建；前端手工联调则只使用经硬校验的
`app_local_frontend*`。两者不得互换，任何清理思路都不得用于日常开发库或正式环境。

## 10. 前端问题反馈模板

开始 A–I 前先跑 fixture verify。若问题发生在已经创建活动/责任/审核记录之后，保留现场，**不要**重跑只接受初始空业务态的
verify，也不要先 cleanup；先按下列模板采集最小复现证据，完成取证后再重建并 verify。严禁把 access token、refresh
token、密码、`DATABASE_URL`、数据库确认值或其他 secret 贴进 issue。

```markdown
### 活动责任闭环本地联调问题

- 页面：
- 当前账号职责（只写职责，不贴 token）：
- 请求方法和路径：
- 请求 body（已移除 secret）：
- HTTP status：
- BizCode：
- 响应 data（已移除 secret / L3 字段）：
- activity.statusCode：
- publishReview.status：
- myResponsibility：
- attendanceSheet.statusCode：
- closure.status：
- 预期行为：
- 实际行为：
- 可重复步骤：
- 是否每次必现：
```

## 11. 后端功能冻结

本地 bootstrap 合并后，活动责任闭环后端进入前端联调冻结。联调反馈先分类：

1. 后端已有，只是前端未使用；
2. 契约漏写；
3. 可重复复现的后端 Bug；
4. 新业务需求。

联调修复 PR 可以处理第 2、3 类，以及明确复现的权限、状态机、性能或安全问题。第 4 类必须回到产品确认，不能直接修改
业务角色、审核层级、活动主状态、谁发起谁负责、临时委托、一审/终审隔离、跨组织授权、贡献值/工时制度或已发布活动组织迁移规则。

## 12. 当前没有做什么

- 没有正式环境、正式用户、真实业务数据或正式 fleet；
- 没有执行正式环境 migration、seed、历史活动认领或真实 RoleBinding 配置；
- 没有修改正式环境变量，没有 drain、部署、恢复流量、release、tag 或版本号变更；
- 没有新增活动 endpoint、DTO 字段、BizCode、业务角色、Permission、schema、migration 或 cron；
- 没有预制 draft/published 活动、owner/collaborator 投影、发布审核、报名、考勤或闭环状态；
- 没有删除 gate=false 兼容分支；
- 未来正式上线必须按届时批准的 release tag 和不可变 image digest 重新验证，不能把本次 SHA 当作永久发布锚点。
