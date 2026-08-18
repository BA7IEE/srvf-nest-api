### Changed

- 抽出离线包链**审核族** `AttendanceOfflineReviewService`(异常回执列表读面与 approve / reject 决议),`AttendanceOfflinePackageService` 由 1068 降至 688 NCLOC,**跌破 700 阈值**。至此尺寸棘轮三条 WARN 全部清零(`0 FAIL, 0 WARN`,棘轮判定 PASS)。签发 / 作废 / 上传留在原服务;两侧共用既有准入层原语,事务所有权与锁序未变。
