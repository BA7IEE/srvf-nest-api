# Participation Bounded Context Map

> **本文用途**:命名并描述当前 SRVF 仓库中"参与 / 履约 / 贡献"业务上下文的实际边界、状态链条、跨模块耦合、API surface 与 governance 规则。
>
> **本文不是**:重构计划、模块合并提案、代码迁移路线图。
>
> **当前 layout 仍是 model-as-module**([`src/modules/activities/`](../src/modules/activities/) / [`src/modules/activity-registrations/`](../src/modules/activity-registrations/) / [`src/modules/attendances/`](../src/modules/attendances/) / [`src/modules/contribution-rules/`](../src/modules/contribution-rules/) / [`src/modules/activity-feedbacks/`](../src/modules/activity-feedbacks/) / [`src/modules/certificates/`](../src/modules/certificates/) 各自独立目录)— 本文档**不**改变这一布局,只把已经存在的"边界"和"地图"显式化,供后续 PR review 与新会话理解业务链条参考。

---

## 1. Purpose

- 命名并描述当前 participation 业务上下文的边界范围。
- **不发起额外代码 / schema 重构、不合并模块、不改 API path**；本文随各已批准批次登记已经落地的事实。
- 把现有跨模块耦合(`attendances` → `Activity` / `ActivityRegistration` / `ContributionRule`)从"凭经验知道"提升为显式文档。
- 让后续 PR review 与新会话能在一页内理解 `Activity → ActivityPosition / ActivityRegistration → AttendanceSheet → AttendanceRecord + ContributionRule` 这一链条的状态语义与事务边界。
- 让"是否物理合并 5 模块、是否新建 `src/modules/participation/` 子树"的决策有一份明确基线可对照。

---

## 2. Scope

### 2.1 Included(participation context 当前认定范围)

| 模块 | Prisma 模型 | 角色 |
|---|---|---|
| [`src/modules/activities/`](../src/modules/activities/) | `Activity` / `ActivityPosition` | 流程发起点与活动内嵌岗位；岗位不新建 NestJS module，与组织职务 `organization_positions` 无关 |
| [`src/modules/activity-registrations/`](../src/modules/activity-registrations/) | `ActivityRegistration` | 报名 5 态(`pending/pass/reject/cancelled/waitlisted`);活动 ↔ 队员 关联 |
| [`src/modules/attendances/`](../src/modules/attendances/) | `AttendanceSheet` / `AttendanceRecord` / `ActivityCheckIn` | 考勤、终审、贡献值落地；`ActivityCheckIn` 是 append-only 打卡证据，F2 提供 canonical App self 写/读，F3 提供 canonical Admin 证据列表与只读考勤草稿 |
| [`src/modules/contribution-rules/`](../src/modules/contribution-rules/) | `ContributionRule` | 字典码键 lookup;配置实体而非流程实体 |
| [`src/modules/activity-feedbacks/`](../src/modules/activity-feedbacks/) | `ActivityFeedback` | 已完结活动评价；App 以 approved Sheet 下 live Record 判资格并锁本人；Admin 实名 list/summary；单次 aggregate 接入 activity participation-summary |

### 2.2 Explicitly excluded(明确不在 participation 范围内)

| 模块 | Prisma 模型 | 排除理由 |
|---|---|---|
| [`src/modules/certificates/`](../src/modules/certificates/) | `Certificate` | (1) FK 只到 `Member` + 自引用(`supersededByCertId`)+ `verifiedBy` Member 自校验链;**没有任何 FK** 指向 `Activity` / `ActivityRegistration` / `AttendanceSheet` / `AttendanceRecord` / `ContributionRule`。(2) `certificates.service.ts` 与 `app-my-certificates.service.ts` 完全**不读**上述任何表(grep 验证 0 命中)。(3) Certificate 的语义是**队员资格证书 / 外部资质**(潜水证 / 急救证),由管理员针对 Member 录入并 `verify`,**不是**参与活动后的产物。更接近一个独立的 `member-qualifications` / member credentials 上下文,本期保持独立。 |

> **例外触发条件(本文不开启,只列出)**:未来若新增"完成 X 次某类活动后系统颁发 Certificate"的发证规则,并且 `Certificate` 引入 FK 指向 `Activity` / `AttendanceSheet`,则需要重新评审是否纳入 participation。届时**必须**先开评审,**不**由 AI 自行扩边界。

---

## 3. Domain relationship map

```
Activity (statusCode: draft / published / completed / cancelled)
  ├─ ActivityPosition[]       [FK activityId → Activity.id, Restrict;
  │     │                      physical table activity_positions;
  │     │                      partial unique (activityId, name)
  │     │                      WHERE deletedAt IS NULL]
  │     └─ ActivityRegistration[] [nullable FK activityPositionId → ActivityPosition.id,
  │                                 Restrict;无岗位活动 / 存量报名为 null]
  ├─ ActivityRegistration[]   [FK activityId → Activity.id, Restrict;
  │     │                      statusCode: pending/pass/reject/cancelled/waitlisted;
  │     │                      partial unique (activityId, memberId)
  │     │                      WHERE deletedAt IS NULL AND statusCode != 'cancelled']
  │     └─ AttendanceRecord[]  [FK registrationId → ActivityRegistration.id,
  │                             NULLABLE, Restrict(Q-S21:不是 SetNull)]
  ├─ ActivityCheckIn[]         [FK activityId → Activity.id, Restrict;
  │     ├─ FK registrationId → ActivityRegistration.id, Restrict;
  │     │  partial unique registrationId WHERE deletedAt IS NULL
  │     └─ FK memberId → Member.id, Restrict;
  │        append-only evidence;F2 App create + 单向 checkout CAS;
  │        F3 Admin evidence list + read-only attendance draft]
  ├─ AttendanceSheet[]         [FK activityId → Activity.id, Restrict;
  │     │                      1 Activity 多 Sheet(D47 / R30)]
  │     └─ AttendanceRecord[]  [FK sheetId → AttendanceSheet.id, Restrict]
  │           └─ Member        [FK memberId → Member.id, Restrict]
  ├─ ActivityFeedback[]        [FK activityId → Activity.id, Restrict;
  │     └─ Member              [FK memberId → Member.id, Restrict;
  │                            partial unique (activityId, memberId)
  │                            WHERE deletedAt IS NULL;
  │                            F2 App self PUT/GET + F3 Admin list/summary]
  │
  └─ activityTypeCode ────┐
                          ├─ ContributionRule lookup
                          │   (NO FK;business-keyed by
                          │    activityTypeCode × attendanceRoleCode × durationThreshold)
                          │   consumed at AttendanceSheet.submit via
                          │   tx.contributionRule.findMany
AttendanceRecord.roleCode ┘

Certificate (不在 participation 图内)
  └─ FK memberId → Member.id
  └─ FK verifiedBy → Member.id(自校验链)
  └─ FK supersededByCertId → Certificate.id(自引用)
```

**关系类型对照**:

| 关系 | 类型 | onDelete | 备注 |
|---|---|---|---|
| `Activity` ← `ActivityPosition.activityId` | FK NOT NULL | Restrict | 岗位是 Activity 内嵌子资源；live `(activityId,name)` partial unique |
| `Activity` ← `ActivityRegistration.activityId` | FK NOT NULL | Restrict | 报名必须挂在 Activity 上 |
| `ActivityPosition` ← `ActivityRegistration.activityPositionId` | FK **NULLABLE** | Restrict | 无岗位活动与存量报名为 null；既有报名 active partial unique 不含该列且逐字不动 |
| `Activity` ← `ActivityCheckIn.activityId` | FK NOT NULL | Restrict | 打卡证据稳定锚定活动 |
| `ActivityRegistration` ← `ActivityCheckIn.registrationId` | FK NOT NULL | Restrict | live registrationId partial unique；取消旧报名后新报名可产生新证据 |
| `Member` ← `ActivityCheckIn.memberId` | FK NOT NULL | Restrict | 打卡证据稳定锚定队员 |
| `Activity` ← `AttendanceSheet.activityId` | FK NOT NULL | Restrict | 1 Activity 多 Sheet |
| `AttendanceSheet` ← `AttendanceRecord.sheetId` | FK NOT NULL | Restrict | 记录必须挂在 Sheet 上 |
| `ActivityRegistration` ← `AttendanceRecord.registrationId` | FK **NULLABLE** | Restrict(Q-S21 明确**不**是 SetNull) | 临时参加 / 非公开报名时为 null |
| `Activity` ← `ActivityFeedback.activityId` | FK NOT NULL | Restrict | 评价稳定锚定活动；不级联删除 |
| `Member` ← `ActivityFeedback.memberId` | FK NOT NULL | Restrict | 评价稳定锚定实名队员；live `(activityId,memberId)` partial unique |
| `ContributionRule` ↔ `AttendanceRecord` | **不是 FK** | — | 业务键 lookup,仅在 submit 事务内查表预填 `contributionPoints` |
| `Certificate` ↔ 上面任何实体 | **无关系** | — | 仅 `Member` 关联;不在本上下文 |

---

## 4. Lifecycle / state chain

| Stage | Module | State / action | Downstream effect |
|---|---|---|---|
| 1. 活动起草 | activities | `create` → `statusCode='draft'` | 仅创建,无下游 |
| 2. 活动发布 | activities | `publish` → `draft → published` | 解锁 Registration 创建与 AttendanceSheet 提交 |
| 3. 活动取消 | activities | `cancel` → `* → cancelled` | 同事务联动 live `pending + waitlisted → cancelled`(pass 保留历史审批结果);阻断所有下游写;attendances 在 `findActivityForSubmissionFull` 内会拒绝 `ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN` |
| 4. 报名(admin / app) | activity-registrations | `create` / `createMy` → `pending \| waitlisted` | 全部前置闸通过后，`capacity=null` 或未满落 pending，已满落 waitlisted；partial unique 防重复;**报名截止生效**(`registrationDeadline` 非 null 且 `now > deadline` → `ACTIVITY_REGISTRATION_DEADLINE_PASSED=20123`;approve 不加此闸) |
| 5. 报名审核 / 递补 | activity-registrations + activities | `approve: pending → pass`;`reject: pending\|waitlisted → reject`;`promote: waitlisted → pending` | promote 仅事务内 FIFO 引擎使用，不开手动端点，不开 waitlisted → pass 直通 |
| 6. 报名取消 | activity-registrations | `cancelAdmin` / `cancelMy`: `pending\|pass\|waitlisted → cancelled` | 取消 pass 同事务 FIFO 递补队首一人至 pending；取消 pending/waitlisted 不递补；partial unique 允许同人再次报名 |
| 7. 考勤表首次提交 | attendances | `submit` → `Sheet.statusCode='pending'` + 多条 `Record` 同事务建立 | **不再推动 Activity.completed**；**跨模块读**:`tx.contributionRule.findMany` 预填 `AttendanceRecord.contributionPoints`(D14 5.B;[`contribution-calculator.ts`](../src/modules/attendances/contribution-calculator.ts);2026-06-21 起预填回归原始规则分,**不再 per-record dailyCap 钳制**,见下 invariant「全局每日封顶」);**跨模块读**并批量校验 `registration.activityId/memberId/statusCode(pass)` 与 records 一致 |
| 8. APD 一级审核 | attendances | `approve` → `pending → pending_final_review`;`reject` → `pending → rejected` | **不**触发 `attendance.recorded`(沿 D-S7;触发点已移到 final-approve) |
| 9. APD 终审通过 | attendances | `finalApprove` → `pending_final_review → approved` | **`contributionPoints` 在此刻语义上生效**;同事务内 `eventPlaceholder('attendance.recorded')` 发出([`attendances.service.ts:1003`](../src/modules/attendances/attendances.service.ts:1003));未来 contribution-points 聚合器从此事件消费 |
| 10. APD 终审驳回 | attendances | `finalReject` → `pending_final_review → final_rejected` | 不触发 `attendance.recorded`;records 跟随软删 |
| 11. 撤回终审通过 | attendances | `reopen` → `approved → pending` | 保留 records / previousSnapshot / version,清空一审与终审责任字段;所有 approved-only 贡献读模型立即不再计入,重新 edit → approve → finalApprove 后恢复。撤回本身不发通知、不回滚历史报名准入 / 招新入队晋级结果;再次 finalApprove 复用既有通知。 |
| 12. 活动评价（F2 App） | activity-feedbacks | 本人 `PUT/GET feedback`；completed + `endAt + N 天` + approved AttendanceRecord 资格 | PUT 在模块自有事务内 create/update `ActivityFeedback`；GET 无评价恒 200/null；不改变 Attendance / Contribution / settlement 语义 |
| —. ContributionRule 维护 | contribution-rules | ops 后台 CRUD;`status: ACTIVE / INACTIVE` | **不是流程状态实体**;仅作为预填配置,在 Step 7 被读取;`active_unique (activityTypeCode, attendanceRoleCode, durationThreshold) WHERE deletedAt IS NULL AND status = 'ACTIVE'` 由 migration SQL 加 partial unique |

> **F2/F3 当前事实**:`ActivityCheckIn` 已提供 App 本人签到/签退/当前状态 3 个 canonical 端点，
> 以及 Admin 证据列表/只读考勤草稿 2 个 canonical 端点。写入仍仅为 App append-only create 与
> 同一行 `checkOutAt null → value` 单向 CAS；Admin 两端点不写 `ActivityCheckIn`、Sheet 或 Record。

**关键 invariant**:

- `AttendanceRecord.contributionPoints` 字段层可空;**业务**层在 Step 9(approved)之前或 Step 11 reopen 回 pending 后可由 APD 现场修订;仅 approved 时"语义生效"。
- **全局每日封顶在本 context 之外**(活动闭环硬化 2026-06-21;v0.48.0 上限调整):队员单个北京日历日的贡献值总分封顶 3(`GLOBAL_DAILY_CONTRIBUTION_CAP`),封顶**只**发生在 recruitment 侧 team-join `computeContribution`(按 `checkInAt` 北京日分组 → 每日封顶 → 加总),**不**在 participation 侧落库——`AttendanceRecord.contributionPoints` 仍存原始规则分。历史记录同样按当前上限读时实时重算;`ContributionRule.dailyCap` 列保留但已 deprecated、calculator 不再读。
- `attendance.recorded` 事件是 participation context **向外的唯一已锁定出口语义**;其它消费方(未来 contribution 聚合 / 仪表盘 / 队员个人贡献值汇总)应当订阅它,**不应**直接读 `AttendanceSheet` / `AttendanceRecord` 表。
- Activity → completed 的唯一通路是 activities 模块 `complete` action；attendances submit 不再执行该跨 aggregate 写。
- **终审/撤回授权现状(2026-07-02 scoped-authz;v0.47.0 F2)**:Step 9/10/11 的 `finalApprove` / `finalReject` / `reopen` 均由 service 层 `authz.explain(...,{type:'attendance_sheet',id})` 判权;权限只来自显式 `attendance-final-reviewer` scoped RoleBinding(通常绑定有效任职并覆盖组织树)或 SUPER_ADMIN 兜底。`biz-admin` 不持这 3 个动作码;角色另含 `attendance.read.sheet`,合计 4 码。只有 finalApprove 受自审 22074 / 一级同人 22075 约束,reopen 不复用这两条终审完整性约束。

---

## 5. Current code boundary

### 5.1 保留 5 个 module 目录

本期**保留** [`src/modules/activities/`](../src/modules/activities/) / [`src/modules/activity-registrations/`](../src/modules/activity-registrations/) / [`src/modules/attendances/`](../src/modules/attendances/) / [`src/modules/contribution-rules/`](../src/modules/contribution-rules/) / [`src/modules/activity-feedbacks/`](../src/modules/activity-feedbacks/) 五个独立目录;`ActivityPosition` 归 activities 模块 ownership，**不**新增第六个 module；**不**做 `src/modules/participation/<sub>/` 大合并(参见 §8 Deferred work)。

### 5.2 允许 / 禁止的跨模块访问形式

> **2026-07-15 当前规则**:本节取代本文件仍可能引用 D11/D-S10 的旧历史措辞；考勤提交不再推动 Activity.completed，活动完结唯一通路是 activities 模块 `complete` action。

| 行为 | 是否允许 | 说明 |
|---|---|---|
| `activities` 读 / 写 `ActivityPosition` | ✅ 自有表 | 模型 ownership 归 activities；岗位 CRUD 与 capacity 事务不得扩散到组织职务 `organization_positions` |
| `attendances` 在事务内读 `tx.activity.findFirst` | ✅ 允许 | `assertActivityExists` / `findActivityForSubmissionFull` 多处使用;Activity 是 attendances 的前置依赖 |
| `attendances` 在事务内**写** `Activity.statusCode` | ❌ 禁止 | D2-a:考勤提交只建 pending Sheet；Activity.completed 只能由 activities 模块 `complete` action 推进 |
| `attendances` 在事务内读 `tx.activityRegistration.findMany` | ✅ 允许 | 批量校验 `registration.activityId/memberId/statusCode(pass)` 与考勤记录一致 |
| `attendances` 读 / 写 `ActivityCheckIn` | ✅ 自有表 | 模型 ownership 归 attendances；F2 App production write 只允许 append-only create / 单向 checkout CAS；F3 Admin 只读 list/draft，不写 Sheet/Record；两者均不得借此写 Activity / ActivityRegistration |
| `attendances` 在事务内读 `tx.contributionRule.findMany` | ✅ 允许 | D14 5.B 系统预填;走 [`contribution-calculator.ts`](../src/modules/attendances/contribution-calculator.ts) |
| `activities` 在事务内读 / 写 `tx.attendanceSheet` / `tx.attendanceRecord` | ❌ 不允许 | Activity 是上游,不下探;若需要派生统计,通过 `attendance.recorded` 事件或独立 service |
| `activities` / `activity-registrations` 在调用方事务内执行 `promoteActivityWaitlist` | ✅ 限定例外 | 纯函数入口，固定 Activity → Registration 锁序，只写 waitlisted → pending + 同事务 `registration.review(action=promote)`；不引入兄弟 Service 依赖 |
| `activity-registrations` 在事务内读 / 写 `tx.attendanceSheet` / `tx.attendanceRecord` | ❌ 不允许 | 同上 |
| `contribution-rules` 在事务内读 / 写其它 participation 表 | ❌ 不允许 | ContributionRule 是配置实体,只被读,不读人 |
| `activity-feedbacks` 读取 `Activity` / `AttendanceSheet` / `AttendanceRecord` | ✅ 限定例外 | 只为 completed/window、approved-only 到场资格与 Admin 评价率分母；直接读 Prisma，不 import 三个兄弟 god-service |
| `activity-feedbacks` 写其它 participation 表 | ❌ 不允许 | 评价写只落 `ActivityFeedback`；不得改 Attendance / Contribution / settlement |
| `activities` 的 `ActivityParticipationQueryService` 调 `ActivityFeedbacksQueryService.aggregateForActivity` | ✅ 限定例外 | F0 冻结的单向只读聚合出口；`ActivitiesModule → ActivityFeedbacksModule`，恰好 1 次 aggregate、无写入、不成环 |
| 除上行外任一模块通过 `import { *Service } from '../<sibling>/...'` 调用兄弟 service | ❌ 不允许 | 不得借评价聚合例外扩散新的 participation service-to-service 调用；三个 god-service 仍保持零互调 |
| 任何 **非** participation 模块读写 `Activity` / `ActivityPosition` / `ActivityRegistration` / `ActivityCheckIn` / `AttendanceSheet` / `AttendanceRecord` / `ActivityFeedback` / `ContributionRule` 表 | ❌ 不允许 | 必须通过 participation 模块的 service 入口或 `attendance.recorded` 事件 |

### 5.3 Transaction boundary

- **岗位 capacity 更新**:事务内固定先锁 `Activity`，再重读 `ActivityPosition.capacity` 与同岗位 passCount；扩容递补只消费同 `activityPositionId` 候补队列，不增加第二把聚合行锁。
- **报名 approve / cancel / promote**:锁序固定 `Activity → ActivityRegistration`；capacity 与 FIFO 域均显式包含 `activityPositionId`（无岗位为 null），跨岗位不借位、不递补。
- **submit 路径**:Activity 检查 + ContributionRule 预填 + Sheet 创建 + N 条 Record 创建 + audit 写入,**全部在一个 `prisma.$transaction(...)` 内**；不写 Activity 状态。
- **finalApprove 路径**:Sheet 状态翻转 + Record 复查 + `attendance.recorded` 事件 + audit 写入,**全部在一个 `prisma.$transaction(...)` 内**。
- **ActivityCheckIn F2**:App 自助打卡写事务固定按 Activity → 当前 pass ActivityRegistration
  取共享锁并在锁后重跑状态/pass 闸，只写 attendances 自有的 `ActivityCheckIn`（create / 单向
  checkout CAS），不扩散任何 cross-aggregate write。
- **ActivityCheckIn F3**:Admin list/draft 只读 `Activity`、当前 pass `ActivityRegistration`、
  `ActivityCheckIn` 与 Member 摘要；两端点各固定 4 次业务查询（authz 查询分开计），不写
  `ActivityCheckIn`、Sheet、Record，也不扩散任何 cross-aggregate write。
- **ActivityFeedback F2**:App PUT 在模块自有事务内固定读 Activity → approved attendance exists →
  live feedback，再 create/update `ActivityFeedback`；GET 同样固定三读、零写。不得把评价逻辑混入
  activities / attendances / activity-registrations god-service。
- **ActivityFeedback F3**:Admin list 固定 3 读（Activity + items + count），summary 固定 4 读
  （Activity + aggregate + rating groupBy + approved distinct members）；activity participation-summary
  复用单次 aggregate，总业务查询固定 4 次。全部只读、无 N+1、无 audit。
- **候补递补**:取消 pass 或 capacity 调大/改 null 的主写、Activity `FOR UPDATE`、
  FIFO `registeredAt ASC,id ASC` 选队首、逐行 `claimAtStatus` CAS、waitlisted → pending
  与 `registration.review(action=promote)` audit 全在同一事务；通知在 commit 后通过既有
  `NotificationDispatcher` 派发。pass 取消与打卡写路径统一使用 Activity → Registration 锁序。
- 跨 aggregate 写**只允许在同事务内发生**;**禁止**用"先 attendances 改完,再回调 activities"的两阶段方式;**禁止**用 `setTimeout` / `Promise.then` 把后续写挪出事务。

### 5.4 ContributionRule 是配置,不是流程

- `contribution-rules` 没有 mobile / app surface,只在 ops 管理面([`v2/contribution-rules`](../src/modules/contribution-rules/contribution-rules.controller.ts))。
- 其状态 `ACTIVE / INACTIVE` 是**配置启停**,与 participation 业务流程的状态机**正交**。
- 当 ContributionRule 在 submit 时找不到匹配规则,**service 兜底默认值,不抛错**(沿 BizCode 注释段 `22048` 的设计;参见 [`biz-code.constant.ts`](../src/common/exceptions/biz-code.constant.ts))。

---

## 6. API surface boundary

> 本节只描述 participation 上下文与 [`api-surface-policy.md`](api-surface-policy.md) 三层 surface 的对应关系,不重复 surface policy 本身。

### 6.1 Admin / Ops surface

| Surface | 路径前缀 | 文件 |
|---|---|---|
| Admin Activities | `v2/activities` | [`activities.controller.ts`](../src/modules/activities/activities.controller.ts) |
| Admin Registrations | `v2/activities/:activityId/registrations` | [`activity-registrations.controller.ts`](../src/modules/activity-registrations/activity-registrations.controller.ts) |
| Admin Attendances | `v2/activities/:activityId/attendance-sheets` + `v2/attendance-sheets` | [`attendances.controller.ts`](../src/modules/attendances/attendances.controller.ts) |
| Admin ActivityCheckIns | `GET /api/admin/v1/activities/:activityId/check-ins` + `GET /api/admin/v1/activities/:activityId/attendance-sheet-draft`（`attendance.read.sheet` + activity ref；只读） | [`controllers/admin-activity-check-ins.controller.ts`](../src/modules/attendances/controllers/admin-activity-check-ins.controller.ts) |
| ActivityFeedbacks | App self PUT/GET + Admin `GET /api/admin/v1/activities/:activityId/{feedbacks,feedback-summary}` | [`src/modules/activity-feedbacks/`](../src/modules/activity-feedbacks/) |
| Ops ContributionRules | `v2/contribution-rules` | [`contribution-rules.controller.ts`](../src/modules/contribution-rules/contribution-rules.controller.ts) |

### 6.2 App surface(participation 视角的 mobile 路径)

| 路径 | 文件 |
|---|---|
| `app/v1/activities/available` / `app/v1/activities/:id` | [`controllers/app-activities.controller.ts`](../src/modules/activities/controllers/app-activities.controller.ts) |
| `app/v1/my/activities` / `app/v1/my/registrations` / `app/v1/my/registrations/:id` / `POST app/v1/my/registrations` / `PATCH app/v1/my/registrations/:id/cancel` | [`controllers/app-my-registrations.controller.ts`](../src/modules/activity-registrations/controllers/app-my-registrations.controller.ts) |
| `app/v1/my/attendance-records` | [`controllers/app-my-attendance-records.controller.ts`](../src/modules/attendances/controllers/app-my-attendance-records.controller.ts) |
| `POST app/v1/my/activities/:activityId/check-in` / `POST .../check-out` / `GET .../check-in` | [`controllers/app-activity-check-ins.controller.ts`](../src/modules/attendances/controllers/app-activity-check-ins.controller.ts) |
| `PUT / GET app/v1/my/activities/:activityId/feedback` | [`controllers/app-activity-feedbacks.controller.ts`](../src/modules/activity-feedbacks/controllers/app-activity-feedbacks.controller.ts) |

> 沿 [`api-surface-policy.md`](api-surface-policy.md) Mobile App 段,App API DTO 严格独立于 Admin DTO,以 `currentUser.memberId` 锁定本人;`scope = self`。

### 6.3 App 自助流(队员本人视角)

| 路径 | 文件 |
|---|---|
| `POST /api/app/v1/my/registrations` + `GET /api/app/v1/my/registrations*`(报名 / 查询 / 取消) | [`controllers/app-my-registrations.controller.ts`](../src/modules/activity-registrations/controllers/app-my-registrations.controller.ts) |
| `GET /api/app/v1/my/attendance-records` | [`controllers/app-my-attendance-records.controller.ts`](../src/modules/attendances/controllers/app-my-attendance-records.controller.ts) |
| `POST /api/app/v1/my/activities/:activityId/check-in` / `POST .../check-out` / `GET .../check-in`（当前 pass 报名打卡） | [`controllers/app-activity-check-ins.controller.ts`](../src/modules/attendances/controllers/app-activity-check-ins.controller.ts) |
| `PUT / GET /api/app/v1/my/activities/:activityId/feedback`（approved 到场者本人评价；无评价 GET 仍 200） | [`controllers/app-activity-feedbacks.controller.ts`](../src/modules/activity-feedbacks/controllers/app-activity-feedbacks.controller.ts) |

> 队员自助流统一落 App surface `/api/app/v1/my/*`,where 子句永远以 `currentUser.memberId` 锁本人(`scope = self`)。历史 `/v2/users/me/*` legacy controller 已于 **Route B Phase 4d2 删除**(原 legacy 与 app 双路径边界问题已收口);新移动端能力**只在** `/api/app/v1/*` 落地。

---

## 7. Governance rules

新增 participation 相关代码或规则时,**必须**逐条对照:

1. **判定归属**:新规则是属于某一个实体(Activity / ActivityPosition / Registration / CheckIn / Sheet / Record / Feedback / Rule),还是属于整体流程?
   - 如果属于单实体,落在对应模块的 service;
   - 如果属于流程(跨实体的状态决策 / 校验 / 计算),默认落在 `attendances/` 下并通过 `*-policy.ts` / `*-state-machine.ts` / `*-calculator.ts` 命名(沿现有 4 抽:[`time-overlap-policy.ts`](../src/modules/attendances/time-overlap-policy.ts) / [`attendance-sheet-state-machine.ts`](../src/modules/attendances/attendance-sheet-state-machine.ts) / [`contribution-calculator.ts`](../src/modules/attendances/contribution-calculator.ts) / [`attendance-audit-recorder.ts`](../src/modules/attendances/attendance-audit-recorder.ts))。

2. **禁止大搬目录**:**不**为了"统一上下文"把 5 模块挪到 `src/modules/participation/<sub>/`;**除非**先开 D 档评审并落 ADR,并由用户拍板。

3. **禁止扩 certificates 边界**:**不**把 [`certificates/`](../src/modules/certificates/) 模块纳入 participation;**除非**未来出现明确的"完成活动后系统颁发 Certificate"发证规则,且 `Certificate` 引入 FK 指向 `Activity` / `AttendanceSheet`。届时**必须**先开评审。

4. **新增跨表写**:**必须**在 PR 描述中明确说明 transaction boundary;**必须**说明是否扩散了 §5.2 的写边界。默认**不扩散**；当前 attendances submit 已不再写 Activity.completed。
   `attendances → ActivityCheckIn` 是模块自有 evidence 表写，不构成跨 aggregate 写；不得以此为由修改 Activity / Registration。

5. **新增 ContributionRule 消费方**:**必须**说明是否复用 `attendances` 现有的 `applyContributionRulePrefill` 语义;如果新消费方走自己的 lookup 路径,**必须**说明为什么不复用以及如何保持语义一致(档位 / cap / 默认值兜底)。

6. **新增 App `/my/*` 端点**:**必须**说明与 legacy `v2/users/me/*` 路径的关系(覆盖 / 并存 / 替代);默认沿 [`api-surface-policy.md`](api-surface-policy.md) "新移动端能力只在 `/api/app/v1/*` 落地"。

7. **状态机扩展**:对 `Activity` / `ActivityRegistration` / `AttendanceSheet` 任意一个 `statusCode` 集合做扩展时,**必须**同步更新本文 §4 表;BizCode 仍按现行段位(沿 [`biz-code.constant.ts`](../src/common/exceptions/biz-code.constant.ts) 与 [`docs/current-state.md`](current-state.md))。

---

## 8. Deferred work(本期不做)

明确**不**在本 PR 范围内,需要时各自单独立项:

- 不立即重组 5 个模块,**不**创建 `src/modules/participation/<sub>/` 目录树。
- 不删除 legacy `v2/users/me/*` / `v2/users/me/attendance-records`(沿 [`api-surface-policy.md`](api-surface-policy.md) "只维护兼容、不扩展")。
- 不抽 `participation/` 共享 module / 共享 service / 共享 DTO 基座。
- 不移动既有 Prisma model 在 [`prisma/schema.prisma`](../prisma/schema.prisma) 内的位置,不改既有 FK / 字段；`ActivityCheckIn`、`ActivityFeedback` 与本批 `ActivityPosition` / `ActivityRegistration.activityPositionId` 及各自 FK 是已冻结的 additive 例外。
- 不改 [`src/modules/permissions/`](../src/modules/permissions/) / RBAC 权限点(沿现行 P0-F 收紧范围)。
- 不改 BizCode 段位(沿现行 [`biz-code.constant.ts`](../src/common/exceptions/biz-code.constant.ts) 与 BizCode range index)。
- 不动 [`src/modules/certificates/`](../src/modules/certificates/) — 它是独立的 member-qualifications 上下文,本文只是把它从 participation 排除。
- 不引入新业务 event 主题;`attendance.recorded` 仍然是唯一对外事件出口。v0.47.0 F2 仅新增内部审计事件 `attendance-sheet.reopen`,与业务 event 分层。
- 不对 `app/v1/*` ↔ `v2/users/me/*` 两路径做合并或迁移。
- 不动 [`src/common/exceptions/biz-code.constant.ts`](../src/common/exceptions/biz-code.constant.ts) 中跨 participation 的共享 BizCode 命名(`ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN` / `ATTENDANCE_REGISTRATION_ACTIVITY_MISMATCH` / `CONTRIBUTION_RULE_*` 等)。

---

## 9. Source references

### 代码

- [`src/modules/activities/`](../src/modules/activities/)
- [`src/modules/activity-registrations/`](../src/modules/activity-registrations/)
- [`src/modules/attendances/`](../src/modules/attendances/) — 含 4 抽:[`contribution-calculator.ts`](../src/modules/attendances/contribution-calculator.ts) / [`time-overlap-policy.ts`](../src/modules/attendances/time-overlap-policy.ts) / [`attendance-sheet-state-machine.ts`](../src/modules/attendances/attendance-sheet-state-machine.ts) / [`attendance-audit-recorder.ts`](../src/modules/attendances/attendance-audit-recorder.ts)
- [`src/modules/contribution-rules/`](../src/modules/contribution-rules/)
- [`src/modules/activity-feedbacks/`](../src/modules/activity-feedbacks/) — App self 评价、Admin 实名列表/聚合与 activity summary 聚合出口
- [`src/modules/certificates/`](../src/modules/certificates/) — **明确排除**,作为对照引用
- [`src/common/exceptions/biz-code.constant.ts`](../src/common/exceptions/biz-code.constant.ts) — BizCode 来源(其中 `ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN` / `ATTENDANCE_REGISTRATION_ACTIVITY_MISMATCH` / `CONTRIBUTION_RULE_*` 等为跨模块共享词汇)

### Schema

- [`prisma/schema.prisma`](../prisma/schema.prisma)(`Activity` / `ActivityPosition` / `ActivityRegistration` / `ActivityCheckIn` / `AttendanceSheet` / `AttendanceRecord` / `ActivityFeedback` / `ContributionRule` / `Certificate` 段;后者为对照排除)

### 文档

- [`docs/current-state.md`](current-state.md) — 当前版本状态、已发能力、当前债务
- [`docs/api-surface-policy.md`](api-surface-policy.md) — App API / Admin Legacy / Root Legacy 三层 surface 长期边界
- [`docs/v2-api-contract.md`](v2-api-contract.md) — V2 第一阶段接口契约(完整字段 / 错误码 / 权限矩阵)
- [`docs/v2-data-model.md`](v2-data-model.md) — V2 第一阶段数据模型说明
- [`AGENTS.md`](../AGENTS.md) — 长期 AI 协作铁律主入口(命名 / 目录 / 错误码 / 软删除等)
