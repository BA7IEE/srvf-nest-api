### Added

- 活动业务改造 v1.1 第 6 批接通工作人员短时成员凭证、staff scan、单人代理、可重放批量代签任务和 CSV 导入 preview/execute；所有正式在线 PunchEvent 复用 Activity 根事务、统一 PunchCommand 与服务段投影。
- CSV preview 固定附件归属、文件摘要、解析器版本、逐行摘要与 preview hash；execute 重读同一冻结对象并重新核验，替换文件或解析漂移零 PunchEvent。
- migration 88 新增 OfflinePackage、OfflinePackageParticipant、OfflinePunchReviewItem 及 AttendancePunchEvent 离线锚的字段、复合 FK、唯一键与状态/链 CHECK，未回填、未删除或重写既有行。

### Changed

- 考勤责任人的在线 staff/proxy/bulk/import 写入口均在 Activity 根事务内锁后重验 active `canManageAttendance=true`；bulk/import worker 每项都重验 lease/fence、责任、身份、窗口、segment 与 seal。
- 离线包/人工复核目前只交付经批准的数据库地基；未有精确 HTTP wire 前不暴露 issue、revoke、upload、review 或离线 PunchEvent writer。
