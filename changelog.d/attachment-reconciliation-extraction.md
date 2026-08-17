### Changed

- 附件存储对账与回填抽出独立服务(Phase 6-B 第四域第六刀,架构边界 §3.2):backfill 与 reconcile 两族共 8 个方法迁入 `attachment-reconciliation.service.ts`;定位器解析与回填候选判定迁入 `attachment-storage-locator.ts`(模块级纯函数);`assertHeadMatchesObject` 与 `activeOperations` 并入既有的 `attachment-storage-invariants.ts`。编排器保留 `reconcileRolloutAttachments` 薄委托,使 `storage-consistency.worker` 的调用面逐字不变。`AttachmentStorageOrchestrator` 由 1918 降至 1474 NCLOC。零 endpoint、零 DTO、零 OpenAPI、零 BizCode、零权限码变更,对外行为逐字不变。
