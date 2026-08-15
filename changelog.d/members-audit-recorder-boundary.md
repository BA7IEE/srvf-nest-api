### Changed

- 队员模块抽出 `MemberAuditRecorder`(Phase 6-B 第二刀,架构边界 §3.5):账号开通/绑定/解绑/重开/启停与离队 6 个事件的 audit payload 组装迁入该类,`tx` 仍由调用方在原事务内透传,事务边界与调用顺序不变。事件名、`before`/`after`/`extra` 字段集逐字不变,零 endpoint、零 DTO、零 BizCode 变更。
