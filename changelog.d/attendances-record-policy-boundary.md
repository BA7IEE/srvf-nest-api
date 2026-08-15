### Changed

- 考勤模块抽出 `attendance-record.policy.ts`(Phase 6-B 第二域第二刀,架构边界 §3.3):record 的域校验与 normalize(`normalizeRecord` / `spanHours` / 时间窗判定 / 岗位时段选择 / 报名归属判定 / 单条完整校验 / claim 锁后复判)迁入该文件,全部为纯函数 —— 3 次 IN 预取与锁后复读仍留在 `AttendancesService`,查询结果作为入参传入。submit/edit 的普通批校验与 claim 锁后复判改为共用同一份报名归属判定(原本是逐字重复的两段)。判定顺序与全部 BizCode 逐条不变,零 endpoint、零 DTO、零 OpenAPI、零权限码变更,对外行为逐字不变。
