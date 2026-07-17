# PostgreSQL throttler bucket 手动 retention SOP

> 适用表：`throttler_buckets`。本 SOP 只清理已经远离任何 TTL / block 语义的过期桶；不新增 cron、队列或常驻 worker。

## 1. 边界与前提

- `retentionAt` 由每次原子 increment 更新为该行当前 `windowExpiresAt`、最后一个 hit expiry、`blockedUntil` 的最大值。
- 清理线固定为 `retentionAt < clock_timestamp() - interval '24 hours'`，并再次确认没有未过期 hit / block；24 小时是状态到期后的额外安全缓冲，不改变任何限流窗口。
- 只允许维护者在低流量维护窗手动执行。为消除“旧桶被删除的同时恰有新 hit”窄竞态，执行删除批次前应先 drain/停止应用流量；无法 drain 时只做只读盘点，不删除。
- 生产执行前先确认备份/PITR 可用、目标数据库名称正确。禁止对默认开发库、测试库或未知连接串照抄执行。

## 2. 只读盘点

```sql
SELECT current_database() AS database_name,
       COUNT(*) AS total_rows,
       MIN("retentionAt") AS oldest_retention_at,
       MAX("retentionAt") AS newest_retention_at
FROM "throttler_buckets";

SELECT COUNT(*) AS deletable_rows
FROM "throttler_buckets"
WHERE "retentionAt" < clock_timestamp() - interval '24 hours'
  AND ("blockedUntil" IS NULL OR "blockedUntil" <= clock_timestamp())
  AND NOT EXISTS (
    SELECT 1
    FROM unnest("hitExpiresAt") AS hit("expiresAt")
    WHERE hit."expiresAt" > clock_timestamp()
  );
```

任一条件不满足时停止：库名不符、仍有应用流量、备份状态未知、候选数异常放大。

## 3. 小批删除

每批最多 10,000 行；每批独立提交并观察锁等待、数据库 CPU、应用 5xx。重复执行直到 `deleted_rows = 0`。

```sql
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

WITH candidates AS (
  SELECT bucket."id"
  FROM "throttler_buckets" AS bucket
  WHERE bucket."retentionAt" < clock_timestamp() - interval '24 hours'
    AND (bucket."blockedUntil" IS NULL OR bucket."blockedUntil" <= clock_timestamp())
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(bucket."hitExpiresAt") AS hit("expiresAt")
      WHERE hit."expiresAt" > clock_timestamp()
    )
  ORDER BY bucket."retentionAt"
  LIMIT 10000
  FOR UPDATE SKIP LOCKED
), deleted AS (
  DELETE FROM "throttler_buckets" AS bucket
  USING candidates
  WHERE bucket."id" = candidates."id"
  RETURNING bucket."id"
)
SELECT COUNT(*) AS deleted_rows FROM deleted;

COMMIT;
```

出现 lock timeout、statement timeout、连接池压力或异常 5xx 时立即 `ROLLBACK` 当前批次并停止，不提高 timeout 强顶。

## 4. 收尾与回退

- 重跑 §2，记录删除前后总行数、候选数、实际删除数、最老 `retentionAt`。
- 恢复应用流量后观察 throttler increment latency、row-lock wait、HTTP 429/500 比例与连接池至少一个完整高峰窗口。
- 删除的是已过期派生状态，不做数据回填；如误删仍在语义期内的行，恢复动作不是手写额度，而是从备份恢复目标行或保持 fail-closed 并升级维护者处理。
- `throttler_buckets` 是 additive 表。代码回退时保留表，不 `DROP`，不在运行中切换本地 Map fallback。
