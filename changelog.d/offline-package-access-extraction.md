### Changed

- 抽出离线包链**准入/原语层** `AttendanceOfflinePackageAccessService`(Activity / Session / OfflinePackage / Review / 参与人行锁,托管考勤准入、场次时间窗、冻结参与人时效校验,唯一键重放包装与理由归一),并导出两份查询投影与三个共享行类型。`AttendanceOfflinePackageService` 由 1373 降至 1068 NCLOC。该层以调用方 `tx` 为入参、不自持 `$transaction`,事务所有权与锁序未变。
