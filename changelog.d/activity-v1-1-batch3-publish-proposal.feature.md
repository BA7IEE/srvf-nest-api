### Added

- 活动业务改造 v1.1 第 3 批第二刀新增 canonical 初次发布/关键变更 proposal、本人撤回和模板最终解析读面；审核通过会进行锁后 stale CAS、写入不可变 RuleSnapshot，并支持审核动作幂等重放。

### Changed

- **前端适配提示：**既有 `direct-publish` 兼容端点不再直接发布活动，只会创建 pending 审核；新客户端应使用 `POST /api/app/v1/my/managed-activities/:activityId/publish-reviews`（携带 `operationKey` 与 `confirmation: true`），已发布活动的关键修改改用 `change-reviews`，审核通过/退回也携带独立 `operationKey` 并处理 409 stale/幂等键冲突。
