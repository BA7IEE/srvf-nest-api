-- 活动业务改造 v1.1 —— 第 4 批缺口⑤:分配、预留名额与志愿的 DB 合同收紧。
--
-- 仅增加 CHECK / 普通 unique / fallback 默认值；零业务 DML、零回填、零删除、
-- 零 DROP / RENAME / 列类型变化 / NOT NULL 收紧、零 runtime / endpoint / DTO。
-- 显式事务 + 稳定顺序写锁，使存量冲突或任一步约束失败时整笔回滚。

BEGIN;

-- 稳定顺序取得阻断 INSERT / UPDATE / DELETE 的表锁；普通 SELECT 仍可读。
LOCK TABLE "ActivityPositionPreference" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "ActivityAllocationCandidate" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "ActivityReservedQuotaGroup" IN SHARE ROW EXCLUSIVE MODE;

-- 先对存量 fail-closed。此段只有 SELECT / RAISE，不写、不清洗、不回填任何业务行。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ActivityPositionPreference"
    WHERE "preferenceOrder" < 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'activity allocation contract guard: existing preferenceOrder must be at least 1';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "ActivityAllocationCandidate"
    WHERE "resultCode" IS NOT NULL
      AND "resultCode" NOT IN ('allocated', 'waitlisted', 'not_selected')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'activity allocation contract guard: existing resultCode is outside the closed set';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "ActivityAllocationCandidate"
    GROUP BY "allocationBatchId", "participationIdentityId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'activity allocation contract guard: existing allocation batch and participation identity pair is duplicated';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "ActivityReservedQuotaGroup"
    WHERE "scopeTypeCode" NOT IN (
      'activity_person',
      'session_participation',
      'position_participation',
      'reserve_group'
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'activity allocation contract guard: existing scopeTypeCode is outside the closed set';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "ActivityReservedQuotaGroup"
    WHERE "fallbackMode" NOT IN ('release_to_public_pool', 'void_on_expiry')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'activity allocation contract guard: existing fallbackMode is outside the closed set';
  END IF;
END
$$;

ALTER TABLE "ActivityPositionPreference"
ADD CONSTRAINT "activity_position_preference_order_one_based_check"
CHECK ("preferenceOrder" >= 1);

ALTER TABLE "ActivityAllocationCandidate"
ADD CONSTRAINT "activity_allocation_candidate_result_code_check"
CHECK (
  "resultCode" IS NULL
  OR "resultCode" IN ('allocated', 'waitlisted', 'not_selected')
);

ALTER TABLE "ActivityAllocationCandidate"
ADD CONSTRAINT "activity_allocation_candidate_batch_identity_key"
UNIQUE ("allocationBatchId", "participationIdentityId");

ALTER TABLE "ActivityReservedQuotaGroup"
ADD CONSTRAINT "activity_reserved_quota_group_scope_type_code_check"
CHECK (
  "scopeTypeCode" IN (
    'activity_person',
    'session_participation',
    'position_participation',
    'reserve_group'
  )
);

ALTER TABLE "ActivityReservedQuotaGroup"
ADD CONSTRAINT "activity_reserved_quota_group_fallback_mode_check"
CHECK ("fallbackMode" IN ('release_to_public_pool', 'void_on_expiry'));

ALTER TABLE "ActivityReservedQuotaGroup"
ALTER COLUMN "fallbackMode" SET DEFAULT 'release_to_public_pool';

COMMIT;
