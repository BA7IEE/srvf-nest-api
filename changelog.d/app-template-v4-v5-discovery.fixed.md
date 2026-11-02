### Fixed

- 修复普通成员模板目录遗漏已支持的 V4/V5 版本；在原授权和一致快照内验证时间／贡献政策的冻结引用，保留安全摘要与精确分页，并同步 OpenAPI 和客户端类型。
- 补充 canonical 报名经人工审批后接正式分配的 HTTP 回归，保留独立审核、资格与容量守卫。

<!-- contract-breaking
operation: GET /api/app/v1/my/managed-activities/template-version-options
reason: 普通成员目录原先只查询V1–V3，但正式from-template已支持V4/V5；本修复使可发现的版本与创建能力一致，响应schemaVersion因此增加4和5。
impact: 将schemaVersion穷举为1/2/3的旧客户端必须处理4/5，否则可能遗漏新模板或进入未覆盖分支；安全摘要字段、分页、授权与请求格式不变。
migration: 同步本PR生成的App客户端类型和OpenAPI，在消费者中支持V4/V5版本分支；模板仍以精确id交给原from-template入口，无业务数据迁移。
rollback: revert本PR的模板查询、DTO和相应生成物，恢复仅列V1–V3的原目录行为；不删除既存V4/V5定义、不改权限或已创建活动。
-->
