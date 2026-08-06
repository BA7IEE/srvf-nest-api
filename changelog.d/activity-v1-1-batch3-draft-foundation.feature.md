### Added

- 活动业务改造 v1.1 第 3 批第一刀新增发起人锚定的活动草稿、场次与新表 `ActivitySessionPosition` 岗位嵌套 CRUD；草稿直写只在 `draft` 阶段放行，已发布活动统一返回 change-review-required。

### Security

- 非发起人访问他人草稿不再暴露 RBAC 403，统一以 `ACTIVITY_NOT_FOUND` 作 404 式隐藏，防止按活动、场次或岗位 ID 枚举草稿归属。
