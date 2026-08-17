### Changed

- `MembersService` 按 D-7 边界拆为三个单元(Phase 6-B 第三域第五刀):账号生命周期 `MemberAccountService`(435)、共享准入 `MemberAccessService`(122),主 service 由 **817 → 441 NCLOC** 并跌破 700 阈值。主 service 仍是唯一对外入口,六个账号方法保留同名薄委托,controller 与既有消费者调用面逐字不变。零 endpoint / 零 DTO / 零 OpenAPI / 零 BizCode / 零权限码变更。
