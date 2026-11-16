# activity-feedbacks — 本地边界

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md)；冻结行为读
> [`activity-feedback-t0-review.md`](../../../docs/archive/reviews/activity-feedback-t0-review.md)；
> participation 边界读
> [`participation-bounded-context.md`](../../../docs/participation-bounded-context.md)。

## 不变量

- 模块统一使用 `feedback` / `rating` 命名；禁止引入 `evaluation` 近义模块名。
- App 始终以 `AppIdentityResolver` 返回的 `member.id` 锁本人，绝不按后台角色扩大 scope。
- 评价资格只认最新 active `ActivitySettlementClosureRevision` 对应版本内的 committed `present`
  结果，以及该 closure 发布批次内正向 `service_credit` 服务账；报名或旧考勤状态本身不构成资格。
- 评价窗口基线是最新 active closure 的 `closedAt + ATTENDANCE_FEEDBACK_WINDOW_DAYS`，且
  Activity 必须 completed；无 active closure 的 App 本人 GET/PUT 均复用 35030。
- 本模块可直接只读 Activity / ClosureRevision / SettlementResult / ParticipationLedgerEntry；禁止 import
  `ActivitiesService` / `AttendancesService` / `ActivityRegistrationsService`，避免兄弟 service 环。
- 评价不写 AuditLog、不改贡献值 / 报名 / 候补 / 打卡 / 考勤 / 结算，不新增权限码、cron 或通知。
- App DTO 与 Admin DTO 物理分离，不用 extends / Pick / Omit / mapped type 派生。
- `(activityId, memberId) WHERE deletedAt IS NULL` 由 migration 手写 partial unique；P2002 必须转
  `ACTIVITY_FEEDBACK_ALREADY_EXISTS`，不得泄露 Prisma 错误。

## 当前事实

- Prisma model `ActivityFeedback` 映射物理表 `activity_feedbacks`；两条 FK 均 Restrict。
- F2 已注册 App PUT/GET 2 endpoint；两路只走 JwtAuthGuard + AppIdentityResolver。PUT 在自有事务内
  读取 Activity、最新 active closure、当前结算结果/服务账与本人 live feedback 后 create/update；
  GET 保留历史评价，最新关账纠错撤销当前资格时返回 `eligibilityCorrected=true`，新获资格可提交。
- F3 已注册 Admin feedbacks / feedback-summary 2 endpoint；复用 `attendance.read.sheet` + activity ref，
  列表固定 3 次业务读，member relation select 与固定五桶均无 N+1。
- `ActivityFeedbacksQueryService.aggregateForActivity()` 是 activity participation-summary 的单查询复用出口；Admin `feedbackRate` 仅使用当前 active closure 对应的评价资格成员与已提交 live feedback 成员的去重并集。分子、分母和 closure 在同一 repeatable-read 快照读取，历史评价在更正后保留；工作流关闭返回 20153/503，不查询旧考勤。
- F4 真实 DB E2E 锁定无当前结算资格者不可写、最新 closure 窗口、纠错增减资格与历史保留、
  DTO 边界、覆盖更新、本人 scope、Admin 实名与统计、跨汇总自洽、并发只留一条 live row，
  以及评价写入不产生 AuditLog。
