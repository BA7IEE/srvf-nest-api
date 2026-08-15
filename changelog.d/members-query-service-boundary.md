### Changed

- 队员模块读侧抽出 `MembersQueryService`(Phase 6-B 第一刀,架构边界 §3.2):`list` / `options` 的 where 构造、组织范围交集、分页与投影迁入该类;判权(`getVisibleOrganizationScope` 与 30100)仍留在 `MembersService`,可见范围作为入参传入。零 endpoint、零 DTO、零 OpenAPI、零权限码变更,对外行为逐字不变。
