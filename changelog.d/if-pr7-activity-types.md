### 新增

- Integration 新增 `GET /api/integration/v1/reference/activity-types`：仅持有直接 GLOBAL
  `dict.read.item` 授权的 Service Principal 可分页读取 ACTIVE 活动类型的最小参考字段
  `code`、`label`、`sortOrder`。
- `dict.read.item` 成为首条精确开启的机器业务读取资格门；Delegated 保持关闭，未绑定、局部
  scope、失去资格门及 Human/Delegated bearer 均拒绝。

BREAKING: 无（新增独立 Integration 只读端点）
