### Changed

- `RecruitmentApplicationsService` 按 D-7 边界拆为四个单元(Phase 6-B 第三域第四刀):OCR 识别与裁剪图存取 `RecruitmentOcrService`(202)、进度查询 `RecruitmentApplicationProgressService`(94)、开放周期查找与容量预检 `RecruitmentCycleAccessService`(32),主 service 由 **763 → 508 NCLOC** 并跌破 700 阈值。主 service 仍是唯一对外入口,`recognize` / `query` 保留同名薄委托,controller 调用面逐字不变。零 endpoint / 零 DTO / 零 OpenAPI / 零 BizCode / 零权限码变更。
