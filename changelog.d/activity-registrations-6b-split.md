### Changed

- `ActivityRegistrationsService` 按 D-7 边界拆为四个单元(Phase 6-B 第三域第二刀):共享准入 `ActivityRegistrationAccessService`(229)、建单族 `ActivityRegistrationCreateService`(514)、审批族 `ActivityRegistrationReviewService`(583),主 service 由 **1470 → 391 NCLOC** 并跌破 700 阈值。主 service 仍是本模块唯一对外入口,六个方法保留同名薄委托,controller 与既有消费者调用面逐字不变(`RegistrationAuthorization` 在主 service re-export,类型面亦不变)。零 endpoint / 零 DTO / 零 OpenAPI / 零 BizCode / 零权限码变更。
