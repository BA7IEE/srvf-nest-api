### Changed

- 附件上传建账链路抽出独立服务(Phase 6-B 第四域第七刀,架构边界 §3.2):受理(`prepareUpload*`)、取证(`verifyUploadEvidence`)、落账(`finalizeUpload*`)共 13 个方法迁入 `attachment-upload.service.ts`;`SafeAttachment` 类型移入 `attachments.select.ts` 与 `attachmentSelect` 同源共享。`AttachmentStorageOrchestrator` 保留全部 10 个 public 的薄委托 —— `attachments.service` 对这些方法有约 100 处调用,编排器是本模块对外唯一入口,调用面因此逐字不变。编排器由 1549 降至 1107 NCLOC。零 endpoint、零 DTO、零 OpenAPI、零 BizCode、零权限码变更,对外行为逐字不变。
