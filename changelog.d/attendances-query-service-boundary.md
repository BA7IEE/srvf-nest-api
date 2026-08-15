### Changed

- 考勤模块读侧抽出 `AttendanceSheetQueryService`(Phase 6-B 第二域第一刀,架构边界 §3.2):四条列表 surface(单活动单据列表 / 跨活动横扫 / 队员 360 考勤记录 / 队员自助记录)的 where 构造、分页、orderBy 与读侧 select 投影迁入该类;判权(`assertCanOrThrow` / `resolveVisibleOrganizationIds` 与 30100)仍留在 `AttendancesService`,算好的可见组织范围作为入参传入。零 endpoint、零 DTO、零 OpenAPI、零 BizCode、零权限码变更,对外行为逐字不变。
