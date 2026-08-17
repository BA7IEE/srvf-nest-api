### Changed

- 内容发布/引用边界锁抽出独立模块(Phase 6-B 第四域第八刀,架构边界 §3.2):`lockContentPublishBoundary` / `lockContentPublishBoundaryUnsafe` / `lockContentReferenceBoundary` 三个方法与两个仅本族使用的辅助迁入 `attachment-content-boundary.ts`,均为模块级纯函数(实测零 `this` 依赖,只吃调用方传入的 tx),不进 DI 图、两个 module 均无需改注册。编排器保留两个 public 薄委托,`attachments.service` 的 6 处调用逐字不变。`AttachmentStorageOrchestrator` 由 1107 降至 677 NCLOC,**跌破 700 阈值并从尺寸基线中移除**。零 endpoint、零 DTO、零 OpenAPI、零 BizCode、零权限码变更,对外行为逐字不变。
