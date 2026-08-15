### Changed

- 活动报名模块读侧抽出 `ActivityRegistrationQueryService`(Phase 6-B 第三域第一刀,架构边界 §3.2):四条列表 surface(单活动报名列表 / 跨活动横扫 / 队员 360 报名履历 / 队员自助列表)的 where 构造、分页、orderBy、读侧 select 投影,以及 CSV 导出的 where 构造与 500 行游标分页取数迁入该类;判权(`assertCanOrThrow` / `assertManagedRegistrationAccess` / `resolveVisibleOrganizationIds` 与 30100)仍留在 `ActivityRegistrationsService`,算好的可见组织范围作为入参传入,CSV 的 fail-closed 审计仍在返回 generator 之前落库。零 endpoint、零 DTO、零 OpenAPI、零 BizCode、零权限码变更,对外行为逐字不变。
