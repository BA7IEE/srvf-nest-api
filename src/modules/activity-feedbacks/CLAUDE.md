# activity-feedbacks — 本地边界

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md)；冻结行为读
> [`activity-feedback-t0-review.md`](../../../docs/archive/reviews/activity-feedback-t0-review.md)；
> participation 边界读
> [`participation-bounded-context.md`](../../../docs/participation-bounded-context.md)。

## 不变量

- 模块统一使用 `feedback` / `rating` 命名；禁止引入 `evaluation` 近义模块名。
- App 始终以 `AppIdentityResolver` 返回的 `member.id` 锁本人，绝不按后台角色扩大 scope。
- 评价资格只认 approved Sheet 内未软删 `AttendanceRecord`；报名状态本身不构成资格。
- 评价窗口基线是 `Activity.endAt + ATTENDANCE_FEEDBACK_WINDOW_DAYS`，且 Activity 必须 completed；
  不新增或模拟 `completedAt`。
- 本模块可直接只读 Activity / AttendanceSheet / AttendanceRecord；禁止 import
  `ActivitiesService` / `AttendancesService` / `ActivityRegistrationsService`，避免兄弟 service 环。
- 评价不写 AuditLog、不改贡献值 / 报名 / 候补 / 打卡 / 考勤 / 结算，不新增权限码、cron 或通知。
- App DTO 与 Admin DTO 物理分离，不用 extends / Pick / Omit / mapped type 派生。
- `(activityId, memberId) WHERE deletedAt IS NULL` 由 migration 手写 partial unique；P2002 必须转
  `ACTIVITY_FEEDBACK_ALREADY_EXISTS`，不得泄露 Prisma 错误。

## 当前事实

- Prisma model `ActivityFeedback` 映射物理表 `activity_feedbacks`；两条 FK 均 Restrict。
- F2 已注册 App PUT/GET 2 endpoint；两路只走 JwtAuthGuard + AppIdentityResolver，业务查询固定
  Activity + approved attendance exists + 本人 live feedback 三次，PUT 再写自有表一次。
- F3 已注册 Admin feedbacks / feedback-summary 2 endpoint；复用 `attendance.read.sheet` + activity ref，
  列表/汇总固定 3/4 次业务读，member relation select 与固定五桶均无 N+1。
- `ActivityFeedbacksQueryService.aggregateForActivity()` 作为唯一单查询聚合出口，被 activity
  participation-summary 复用；该端点总业务查询从 3 additive 增至 4，既有度量算法不变。
- F4 真实 DB E2E 锁定无到场/非 approved Sheet 无资格、窗口与 DTO 边界、覆盖更新、本人 scope、
  Admin 实名与统计、跨汇总自洽、并发只留一条 live row，以及评价写入不产生 AuditLog。
