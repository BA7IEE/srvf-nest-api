### Changed

- 附件人工运维操作的受理侧抽出 `AttachmentManualIntakeService`(Phase 6-B 第四域第四刀,架构边界 §3.2):`prepareManualOperation` 的实现(登记一条待执行 manual 操作:围栏事务内两条 `FOR UPDATE` 取锁、eventKey 幂等复用、活跃操作互斥、按 kind 分别校验来源态)迁入该类,`AttachmentStorageOrchestrator` 保留 `prepareManualRelocate` / `prepareManualAttestAbsent` 两个同名 public 方法作为薄委托 —— 它是本模块对外入口与 kind 分发器,故调用面(`storage-consistency-worker` 与 e2e)逐字不变。锁序不变:该方法迁出前后都自开事务、不接受外部 tx,两条 `FOR UPDATE` 的先后与 `ORDER BY "id"` 逐字保留(后者是死锁防线而非排序需求)。零 endpoint、零 DTO、零 OpenAPI、零 BizCode、零权限码变更,对外行为逐字不变。
