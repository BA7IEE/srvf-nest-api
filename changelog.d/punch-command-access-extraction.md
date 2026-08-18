### Changed

- 抽出打卡链**准入层** `AttendancePunchAccessService`(Activity / Session / 参与身份 / QR 凭证 / PunchEvent 行锁与托管考勤准入断言),并把 `PUNCH_EVENT_SELECT` 投影与三个共享行类型一并导出。`AttendancePunchCommandService` 由 1504 降至 1219 NCLOC,回到尺寸棘轮基线以内。该层以调用方 `tx` 为入参、不自持 `$transaction` —— 事务所有权仍在打卡命令服务,锁序未变。
