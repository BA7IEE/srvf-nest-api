# Notification outbox 手动 retention SOP

> 适用表：`notification_outbox_intents`。只清理已完成的 terminal intent；不新增 cron、Redis、queue 或第二套常驻清理进程。

## 1. 保留规则与边界

- `status='succeeded' AND completedAt < clock_timestamp() - interval '30 days'` 才可清理成功 intent。
- `status='dead' AND deadAt < clock_timestamp() - interval '90 days'` 才可清理死信。90 天内先完成原因核对、业务补偿或明确接受。
- `pending` / `processing` 无论多旧都禁止删除；它们仍可能等待 retry 或 lease 回收。
- 只允许维护者在低流量维护窗手工小批执行。生产前先确认目标库名、备份/PITR 和死信处置记录；任一未知即只读盘点。

## 2. 只读盘点

```sql
SELECT current_database() AS database_name,
       "status",
       COUNT(*) AS rows,
       MIN("createdAt") AS oldest_created_at,
       MIN("completedAt") AS oldest_completed_at
FROM "notification_outbox_intents"
GROUP BY "status"
ORDER BY "status";

SELECT "eventType", "lastErrorClass", "lastErrorCode", COUNT(*) AS rows
FROM "notification_outbox_intents"
WHERE "status" = 'dead'
GROUP BY "eventType", "lastErrorClass", "lastErrorCode"
ORDER BY rows DESC;

SELECT COUNT(*) AS deletable_succeeded
FROM "notification_outbox_intents"
WHERE "status" = 'succeeded'
  AND "completedAt" < clock_timestamp() - interval '30 days';

SELECT COUNT(*) AS deletable_dead
FROM "notification_outbox_intents"
WHERE "status" = 'dead'
  AND "deadAt" < clock_timestamp() - interval '90 days';
```

`dead` 分组出现未知 event/version、持续 provider/DB 故障或业务聚集时先停止，保留证据并处理根因，不能用删除掩盖积压。

## 3. 小批删除

每批最多 5,000 行，每批独立提交；`FOR UPDATE SKIP LOCKED` 避开仍被观察或并发处置的行。

```sql
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

WITH candidates AS (
  SELECT "id"
  FROM "notification_outbox_intents"
  WHERE (
      "status" = 'succeeded'
      AND "completedAt" < clock_timestamp() - interval '30 days'
    ) OR (
      "status" = 'dead'
      AND "deadAt" < clock_timestamp() - interval '90 days'
    )
  ORDER BY COALESCE("completedAt", "deadAt"), "id"
  LIMIT 5000
  FOR UPDATE SKIP LOCKED
), deleted AS (
  DELETE FROM "notification_outbox_intents" AS intent
  USING candidates
  WHERE intent."id" = candidates."id"
  RETURNING intent."status"
)
SELECT "status", COUNT(*) AS deleted_rows
FROM deleted
GROUP BY "status";

COMMIT;
```

出现 lock/statement timeout、异常 5xx、worker claim latency 或 DB CPU/连接池升高时立即回滚当前批次并停止，不提高 timeout 强顶。

## 4. 收尾与回退

- 重跑 §2，记录删除前后总数、候选数、实际删除数和死信分组。
- 观察 worker claim/ack/nack、oldest pending age、dead 增长率、provider 成功率至少一个完整业务高峰。
- 误删 terminal intent 不得手写伪造状态；从备份恢复目标行，或按业务事实重新生成一个新 eventKey 的补偿 intent并留下维护记录。
- 回退应用版本时保留 additive outbox 表，不执行 down migration、不 `DROP`。
