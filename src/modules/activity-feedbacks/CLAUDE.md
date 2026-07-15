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

## F1 当前事实

- Prisma model `ActivityFeedback` 映射物理表 `activity_feedbacks`；两条 FK 均 Restrict。
- F1 只有 schema / migration 与模块骨架，0 endpoint；F2/F3 才注册运行时 controller/service。
