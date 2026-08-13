### Changed

- （验证用探针 fragment，随本 PR 一起关闭，不会进入任何版本）

<!-- authz-downgrade
route: GET /api/admin/v1/me
reason: R14 门的一次性真触发验证 —— 证明降级会被拦、补申报后转为要求 Environment 审批
impact: 该端点原本要求登录，变异后任何人可读管理员本人身份摘要（仅存在于本探针分支）
migration: 无需迁移，本 PR 取证后关闭不合并；真实场景下的迁移方式应写在这一行
-->
