### Changed

- `RoleBindingsService` 按 D-7 边界拆为三个单元(Phase 6-B 第三域第六刀):读 surface 族 `RoleBindingQueryService`(281)、共享准入与序列化 `RoleBindingAccessService`(84),主 service 由 **827 → 585 NCLOC** 并跌破 700 阈值。主 service 仍是唯一对外入口,`list` / `page` / `findOne` 保留同名薄委托,controller 调用面逐字不变。零 endpoint / 零 DTO / 零 OpenAPI / 零 BizCode / 零权限码变更。
