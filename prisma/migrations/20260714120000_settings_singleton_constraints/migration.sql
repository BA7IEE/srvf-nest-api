-- 第 49 migration:四张 provider settings 表由 DB 强制至多一行。
--
-- 数据安全:
-- - 加约束前仅在表内已有多行时去重；干净库/单行库删除数为 0。
-- - 保留 updatedAt 最新行；updatedAt 相同时保留 createdAt 最新行；id 仅作最终确定性 tiebreak。
-- - 每表通过 RAISE NOTICE 记录本次不可逆删除行数，部署前须先只读核对真实库重复数。
-- - 四表锁、去重、建索引置于同一事务，阻断“去重后、建索引前”并发插入窗口；任一步失败则全量回滚。

BEGIN;

LOCK TABLE
  "storage_settings",
  "sms_settings",
  "wechat_settings",
  "realname_verification_settings"
IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  removed_rows integer;
BEGIN
  WITH ranked AS (
    SELECT
      "id",
      ROW_NUMBER() OVER (
        ORDER BY "updatedAt" DESC, "createdAt" DESC, "id" DESC
      ) AS row_number
    FROM "storage_settings"
  )
  DELETE FROM "storage_settings" AS settings
  USING ranked
  WHERE settings."id" = ranked."id"
    AND ranked.row_number > 1;

  GET DIAGNOSTICS removed_rows = ROW_COUNT;
  RAISE NOTICE 'settings singleton dedup: storage_settings removed % row(s)', removed_rows;
END $$;

DO $$
DECLARE
  removed_rows integer;
BEGIN
  WITH ranked AS (
    SELECT
      "id",
      ROW_NUMBER() OVER (
        ORDER BY "updatedAt" DESC, "createdAt" DESC, "id" DESC
      ) AS row_number
    FROM "sms_settings"
  )
  DELETE FROM "sms_settings" AS settings
  USING ranked
  WHERE settings."id" = ranked."id"
    AND ranked.row_number > 1;

  GET DIAGNOSTICS removed_rows = ROW_COUNT;
  RAISE NOTICE 'settings singleton dedup: sms_settings removed % row(s)', removed_rows;
END $$;

DO $$
DECLARE
  removed_rows integer;
BEGIN
  WITH ranked AS (
    SELECT
      "id",
      ROW_NUMBER() OVER (
        ORDER BY "updatedAt" DESC, "createdAt" DESC, "id" DESC
      ) AS row_number
    FROM "wechat_settings"
  )
  DELETE FROM "wechat_settings" AS settings
  USING ranked
  WHERE settings."id" = ranked."id"
    AND ranked.row_number > 1;

  GET DIAGNOSTICS removed_rows = ROW_COUNT;
  RAISE NOTICE 'settings singleton dedup: wechat_settings removed % row(s)', removed_rows;
END $$;

DO $$
DECLARE
  removed_rows integer;
BEGIN
  WITH ranked AS (
    SELECT
      "id",
      ROW_NUMBER() OVER (
        ORDER BY "updatedAt" DESC, "createdAt" DESC, "id" DESC
      ) AS row_number
    FROM "realname_verification_settings"
  )
  DELETE FROM "realname_verification_settings" AS settings
  USING ranked
  WHERE settings."id" = ranked."id"
    AND ranked.row_number > 1;

  GET DIAGNOSTICS removed_rows = ROW_COUNT;
  RAISE NOTICE 'settings singleton dedup: realname_verification_settings removed % row(s)', removed_rows;
END $$;

CREATE UNIQUE INDEX "storage_settings_singleton_key"
ON "storage_settings" ((true));

CREATE UNIQUE INDEX "sms_settings_singleton_key"
ON "sms_settings" ((true));

CREATE UNIQUE INDEX "wechat_settings_singleton_key"
ON "wechat_settings" ((true));

CREATE UNIQUE INDEX "realname_verification_settings_singleton_key"
ON "realname_verification_settings" ((true));

COMMIT;
