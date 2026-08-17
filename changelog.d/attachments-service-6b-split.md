### Changed

- `AttachmentsService` 按 D-7 边界拆为六个单元(Phase 6-B 第三域第七刀):共享校验/判权/序列化 `AttachmentAccessService`(456)、报名上传链路 `AttachmentRegistrationUploadService`(417)、考勤导入预览上传 `AttachmentImportPreviewUploadService`(294)、内容确认上传 `AttachmentContentUploadConfirmService`(355)、写链路 `AttachmentWriteService`(474),主 service 由 **1781 → 387 NCLOC** 并跌破 700 阈值。主 service 仍是唯一对外入口,24 个方法保留同名薄委托(带显式 `ReturnType<>` 使签名逐字一致),视图与阶段类型在主 service re-export,全仓约 100 处调用面与类型面均不变。零 endpoint / 零 DTO / 零 OpenAPI / 零 BizCode / 零权限码变更。
