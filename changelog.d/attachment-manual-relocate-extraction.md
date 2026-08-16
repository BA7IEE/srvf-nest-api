### Changed

- 附件存储的人工重定位执行侧抽出 `AttachmentManualRelocateService`(Phase 6-B 第四域第二刀,架构边界 §3.2):`executeManualRelocate` / `collectManualRelocationEvidence` / `assertManualRelocationEvidence` 三个方法连同 `ManualRelocationEvidence` 类型与 `MANUAL_STORAGE_MAINTENANCE` 常量迁入该类,`AttachmentStorageOrchestrator` 保留 `executeClaimed` 按 kind 的分发与本操作的受理侧(`prepareManualRelocate` / `prepareManualOperation`),两者以操作 kind 为界互不重叠。锁序不变:该方法迁出前后都**自开事务**、不接受外部 tx,编排器文件头的锁序台账(全局单点)一行未动。零 endpoint、零 DTO、零 OpenAPI、零 BizCode、零权限码变更,对外行为逐字不变;补齐迁出前**零单测覆盖**的证据校验分支(12 例,覆盖身份漂移 / HEAD 尺寸 / 流式摘要缺失与不符 / 同读竞态 etag 变化 / 无凭据重定位拒绝)。
