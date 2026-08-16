### Changed

- 附件删除终态化时的内容根边界锁抽出 `attachment-content-delete-boundary.ts`(Phase 6-B 第四域第三刀,架构边界 §3.2):`lockContentDeleteFinalizationBoundary` 由 `AttachmentStorageOrchestrator` 的私有方法改为模块级纯函数,delete 族(`finalizeAttachmentDelete`)与 manual 族(`finalizeManualAttestedDelete`)各自 import,互不依赖。该原语实测零 `this.` 引用(只吃传入的 `tx`),故不做 `@Injectable` —— 不进 DI 图,两个 module 均无需改注册。锁序不变:它实现的仍是全局锁序台账中「Content root → Attachment → …」的第一段,调用点与调用时机逐字未动;文件头写明「必须在尚未持有 Attachment / StorageObject 行锁前调用」,因为挪位置不会有任何编译或测试报错。零 endpoint、零 DTO、零 OpenAPI、零 BizCode、零权限码变更,对外行为逐字不变。
