### Added

- 活动 v1.1 两条规模可用性缺口(#1089 逐条判定时推翻起草方初判查出的**真能力缺口**):
  - **AC-030**：`GET /api/app/v1/my/managed-activities/:activityId/collaborator-options` 新增 `q` 模糊搜索与 `page` / `pageSize` 分页，取消 `take: 200` 硬截（合同追踪矩阵 E07 本期实现项）。过滤与排序全部下沉到 SQL，`eligibilitySource` 改用当前页批量 IN 取，不再把整场次 pass 报名拉进应用内存（开发文档 §11.4）；查询次数恒为 3 次，与候选人数、页大小、命中条数均无关。不传新参数时 `items` 与改造前逐位相同。
  - **AC-068**：`POST .../onsite/sessions/:sessionId/bulk-punch-jobs` 新增 `selection` 选择条件入口（`mode: session-all`，可按 `statusCodes` / `positionId` 收窄），服务端用一条 `INSERT ... SELECT` 把整场次展开成任务项 —— 绑定参数与人数无关、零 identity id 进应用内存。2000 人一次入队实测 43.7ms（生产事务预算 5000ms）。既有 500 条 id 列表入口与 `@ArrayMaxSize(500)` 按合同追踪矩阵 I55「当前合理，保留现有正确方向」原样不动，二者恰好二选一。

### Changed

- `AppCollaboratorOptionsResponseDto` 增加 `total` / `page` / `pageSize` 三个分页元字段（`items` 不变）。`AppManagedBulkPunchJobDto.participationIdentityIds` 由必填改为「与 `selection` 恰好二选一」，两个都给或都不给一律 400。
