-- 活动改造 v1.1 第 4 批第九刀:ActivityRegistration 永久报名头。
-- 本 migration 只做结构切换:全历史重复直接 23505 fail-closed，绝不删数、合并或修数。
-- 取消/重报的同头 runtime 复用留给后续刀；本文件不得据此推导任何业务写入。

BEGIN;

LOCK TABLE "ActivityRegistration" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  duplicate_group_count bigint;
BEGIN
  -- 不带 deletedAt / statusCode 谓词：cancelled 与软删历史同样占用永久报名头。
  SELECT COUNT(*)
  INTO duplicate_group_count
  FROM (
    SELECT 1
    FROM "ActivityRegistration"
    GROUP BY "activityId", "memberId"
    HAVING COUNT(*) > 1
  ) AS duplicate_groups;

  IF duplicate_group_count > 0 THEN
    -- 将受控重复写入事务内临时表的 deferred unique。这样 COMMIT 本身报告 23505，
    -- 不会被 migration runner 的 aborted-transaction 噪声覆盖；失败后临时表和其中
    -- 的两行都随整个事务回滚，持久数据与 index 均不变。诊断只包含重复组数。
    CREATE TEMPORARY TABLE activity_registration_permanent_unique_probe (
      duplicate_group_count bigint NOT NULL,
      CONSTRAINT activity_registration_duplicate_group_count_key
        UNIQUE (duplicate_group_count) DEFERRABLE INITIALLY DEFERRED
    ) ON COMMIT DROP;

    EXECUTE
      'INSERT INTO activity_registration_permanent_unique_probe (duplicate_group_count)
       VALUES ($1), ($1)'
    USING duplicate_group_count;
    RETURN;
  END IF;

  -- 只有全历史无重复时才进入结构切换。
  EXECUTE 'DROP INDEX "activity_registrations_activity_member_active_unique"';
  EXECUTE
    'CREATE UNIQUE INDEX "activity_registrations_activity_member_permanent_unique"
     ON "ActivityRegistration" ("activityId", "memberId")';
END
$$;

COMMIT;
