### Added

- 活动业务改造 v1.1 第 4 批前置微刀新增第 78 migration：`CapacityReservation` 增加 nullable `memberId` / `activityId`、两条 RESTRICT FK、空值安全的 active `activity_person` 双锚点 CHECK，以及同 member/activity 的 active partial unique。expand-only、零 default、零回填、零 endpoint、零运行时业务行为。
