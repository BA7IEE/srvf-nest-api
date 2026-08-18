### Added

- B7 新增会员受众标签：`ActivityPublishReview.audienceTagCodes` 以 nullable JSONB 保留审核期受众，`MemberAudienceTagAssignment` 以撤标历史和 live partial unique 记录会员赋标；迁移只扩展 schema，既有 NULL 审核保持 legacy 广播。
- 管理端新增成员标签读取/全量替换与活动定向发布入口；标签字典固定为 `member_audience_tag`，非空标签按 OR 并集去重，`[]` 面向全部 ACTIVE 且未软删会员。

### Changed

- B7 受众在 Activity 根事务锁定后的真正发布/审核批准时匹配，并与 audit/outbox 同事务快照；后续赋标变化不改已生成收件人，取消通知范围不变。
- `ACTIVITY_AUDIENCE_TAGS_HTTP_ENABLED` 只接受严格 `true`/`false`；dev/test 缺省关闭，production/smoke 必须显式设置。关闭时，已登录且有权限的 B7 HTTP 调用返回既有 503 信封。
