### Added

- 活动业务改造 v1.1 第 4 批接通 managed 报名 Form 的 canonical 定义、draft/active 版本、发布/变更审核/clone 与队员活动详情安全读面；新 schemaVersion 3 proposal 将 Form 纳入 stale guard，历史 v2 审批保持兼容。
- 新增一次性报名附件上传会话：token 仅创建响应明文一次、30 分钟有效，后端中转 multipart 仅接受 JPEG/PNG/WebP/PDF（10 MiB）并安全重放单会话单附件；不返回 provider signed upload URL 或内部存储字段。
