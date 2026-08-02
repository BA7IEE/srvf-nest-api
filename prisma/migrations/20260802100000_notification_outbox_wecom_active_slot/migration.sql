-- 企业微信接入 T5B —— WeCom 消息通道 active-slot(第 69 migration)
--
-- 冻结稿:docs/archive/reviews/wecom-integration-t0-terminal-review.md §10.3(2026-07-29 冻结)。
--
-- 本 migration 做什么:
--   在 `notification_outbox_intents` 上新增**一条** partial unique index,
--   让同一通知同一收件人的企业微信 child 在任意时刻至多有一个 active attempt。
--
-- 本 migration **不**做什么:
--   零新表、零新列、零 enum、零 default 变更、零回填、零删数、零 DROP、零不可逆操作。
--   谓词只认 `eventType = 'notification.wecom-delivery'` —— 该值本次之前从未写入过任何一行,
--   故建索引时命中集必然为空,不可能因存量数据冲突失败。
--
-- ⚠️ **为什么必须是独立索引,不能复用微信那条**(§10.3 逐字):
--   既有 `notification_outbox_wechat_delivery_active_unique` 的键是
--   ("eventType", "aggregateId", "destinationRef"),谓词写死 `eventType = 'notification.wechat-delivery'`。
--   若改成一条**不含 eventType 谓词**的通用索引去覆盖两个渠道,键里的 eventType 会被谓词放开,
--   同一通知同一人的 wechat child 与 wecom child 就会互相占用同一个槽位 ——
--   结果是"同一条通知,同一个人,微信小程序和企业微信只能收到其中一个"。
--   两条渠道各一条谓词互斥的索引,才是"两渠道并行、各自单 active"的执行位。
--
-- 形状逐字沿第一条(第 18 migration 的 wechat / admin-sms 两条),连列顺序都不改:
-- 三条索引形状一致,运维读 `pg_indexes` 时能一眼看出它们是同一个模式的三个实例。
--
-- 回滚:DROP INDEX "notification_outbox_wecom_delivery_active_unique";
-- 回滚后果仅为"失去单 active 槽位保证",不丢任何数据。但请注意 D-WC-24 的回滚顺序:
-- **先关 messageEnabled、用新 worker 排空或终结所有 WeCom intent**,再考虑动这条索引;
-- 不得让旧 worker 接触 `notification.wecom-*` 事件(§10.8),详见
-- docs/ops/wecom-message-channel-rollout.md。

-- 同一 notification/member 的企业微信 child 同时至多一个 active attempt;terminal 后释放,
-- 允许后续真实 re-publish 以新 generation 重试。eventType 收窄避免影响其它 outbox 类型。
CREATE UNIQUE INDEX "notification_outbox_wecom_delivery_active_unique"
ON "notification_outbox_intents"("eventType", "aggregateId", "destinationRef")
WHERE "eventType" = 'notification.wecom-delivery'
  AND "status" IN ('pending', 'processing');
