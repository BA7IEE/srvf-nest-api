-- Activity OS R1 / A3：Template Version canonical/hash/lifecycle guard。
--
-- 只治理 A2 后新增的 Family Version（familyId IS NOT NULL）。legacy ActivityTemplate 继续按
-- 原 statusCode / resolver 工作，不能被本 migration 追溯解释或锁住。没有 writer/API 的 A3
-- 也不引入 pgcrypto：hash 与 definition 的内容一致性由未来 writer 在入库前调用
-- activity-template-definition.ts 校验；本 migration 只兜底存储形状与不可变生命周期。

BEGIN;

-- A2 没有任何 Family Version writer。若有人在 A3 前越过合同手写过 familyId，本刀不能猜
-- 它的 definition / lifecycle 是否有效，必须整笔 fail-closed，而不是把未知历史行静默锁死。
DO $activity_template_family_version_preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM "ActivityTemplate" WHERE "familyId" IS NOT NULL) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      CONSTRAINT = 'activity_template_family_version_preflight',
      MESSAGE = 'activity_template_family_version_preflight: existing family version rows require an explicit migration plan';
  END IF;
END;
$activity_template_family_version_preflight$;

-- Future Family Version 的 definition 是 JSON object；schemaVersion / hash 不能缺、不能是
-- 伪 hash。CHECK 对 familyId 为 NULL 的旧行完全短路，保持旧 resolver 的兼容面不变。
ALTER TABLE "ActivityTemplate"
  ADD CONSTRAINT "activity_template_family_version_required_fields"
  CHECK (
    "familyId" IS NULL
    OR (
      "version" > 0
      AND "schemaVersion" IS NOT NULL
      AND "schemaVersion" > 0
      AND "definitionJson" IS NOT NULL
      AND jsonb_typeof("definitionJson") = 'object'
      AND "definitionHash" IS NOT NULL
      AND "definitionHash" ~ '^[0-9a-f]{64}$'
    )
  ),
  ADD CONSTRAINT "activity_template_family_version_effective_period"
  CHECK (
    "familyId" IS NULL
    OR (
      "statusCode" IN ('draft', 'active', 'retired')
      AND ("statusCode" = 'draft' OR "effectiveFrom" IS NOT NULL)
      AND (
        "effectiveTo" IS NULL
        OR ("effectiveFrom" IS NOT NULL AND "effectiveTo" > "effectiveFrom")
      )
    )
  );

CREATE FUNCTION activity_template_family_version_freeze_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $activity_template_family_version_freeze_guard$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- 没有 backfill；新 Version 必须从 draft 起步，不能绕过可审计的 draft → active 边。
    IF NEW."familyId" IS NOT NULL AND NEW."statusCode" <> 'draft' THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        CONSTRAINT = 'activity_template_family_version_lifecycle',
        MESSAGE = 'activity_template_family_version_lifecycle: family version must be created as draft';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD."familyId" IS NOT NULL AND OLD."statusCode" IN ('active', 'retired') THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        CONSTRAINT = 'activity_template_family_version_frozen',
        MESSAGE = 'activity_template_family_version_frozen: active or retired family version cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  -- legacy row 不承担 A3 lifecycle，但一旦被创建为 legacy 就不得在 update 中偷换为
  -- Family Version；这既防止回填，也不让现有 resolver 在无 A4 指针前被意外改语义。
  IF OLD."familyId" IS NULL THEN
    IF NEW."familyId" IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        CONSTRAINT = 'activity_template_family_version_legacy_boundary',
        MESSAGE = 'activity_template_family_version_legacy_boundary: legacy template cannot be converted into a family version';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."familyId" IS DISTINCT FROM OLD."familyId" THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      CONSTRAINT = 'activity_template_family_version_legacy_boundary',
      MESSAGE = 'activity_template_family_version_legacy_boundary: family version identity cannot change';
  END IF;

  IF OLD."statusCode" = 'retired' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      CONSTRAINT = 'activity_template_family_version_frozen',
      MESSAGE = 'activity_template_family_version_frozen: retired family version is immutable';
  END IF;

  IF OLD."statusCode" = 'draft' THEN
    IF NEW."statusCode" NOT IN ('draft', 'active') THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        CONSTRAINT = 'activity_template_family_version_lifecycle',
        MESSAGE = 'activity_template_family_version_lifecycle: draft family version may remain draft or become active';
    END IF;
    RETURN NEW;
  END IF;

  -- active 唯一合法写入是 statusCode 改为 retired。定义、版本身份、默认配置、有效期和
  -- createdAt 都属于冻结对象；updatedAt 是技术元数据，允许 ORM 自动刷新。
  IF OLD."statusCode" = 'active'
     AND (
       NEW."statusCode" IS DISTINCT FROM 'retired'
       OR NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
       OR NEW."code" IS DISTINCT FROM OLD."code"
       OR NEW."name" IS DISTINCT FROM OLD."name"
       OR NEW."activityTypeCode" IS DISTINCT FROM OLD."activityTypeCode"
       OR NEW."version" IS DISTINCT FROM OLD."version"
       OR NEW."schemaVersion" IS DISTINCT FROM OLD."schemaVersion"
       OR NEW."definitionJson" IS DISTINCT FROM OLD."definitionJson"
       OR NEW."definitionHash" IS DISTINCT FROM OLD."definitionHash"
       OR NEW."effectiveFrom" IS DISTINCT FROM OLD."effectiveFrom"
       OR NEW."effectiveTo" IS DISTINCT FROM OLD."effectiveTo"
       OR NEW."defaultRegistrationModeCode" IS DISTINCT FROM OLD."defaultRegistrationModeCode"
       OR NEW."defaultLocationRequired" IS DISTINCT FROM OLD."defaultLocationRequired"
       OR NEW."defaultCheckInRadiusMeters" IS DISTINCT FROM OLD."defaultCheckInRadiusMeters"
       OR NEW."checkInOpenOffsetMinutes" IS DISTINCT FROM OLD."checkInOpenOffsetMinutes"
       OR NEW."checkInCloseOffsetMinutes" IS DISTINCT FROM OLD."checkInCloseOffsetMinutes"
       OR NEW."checkOutOpenOffsetMinutes" IS DISTINCT FROM OLD."checkOutOpenOffsetMinutes"
       OR NEW."checkOutCloseOffsetMinutes" IS DISTINCT FROM OLD."checkOutCloseOffsetMinutes"
       OR NEW."defaultLateGraceMinutes" IS DISTINCT FROM OLD."defaultLateGraceMinutes"
       OR NEW."defaultEarlyLeaveThresholdMinutes" IS DISTINCT FROM OLD."defaultEarlyLeaveThresholdMinutes"
       OR NEW."defaultArchiveWaitingDays" IS DISTINCT FROM OLD."defaultArchiveWaitingDays"
       OR NEW."commonPositionTemplates" IS DISTINCT FROM OLD."commonPositionTemplates"
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      CONSTRAINT = 'activity_template_family_version_frozen',
      MESSAGE = 'activity_template_family_version_frozen: active family version only permits retirement';
  END IF;

  IF OLD."statusCode" = 'active' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '55000',
    CONSTRAINT = 'activity_template_family_version_lifecycle',
    MESSAGE = 'activity_template_family_version_lifecycle: family version has an invalid persisted status';
END;
$activity_template_family_version_freeze_guard$;

CREATE TRIGGER trg_activity_template_10_family_version_freeze
BEFORE INSERT OR UPDATE OR DELETE ON "ActivityTemplate"
FOR EACH ROW EXECUTE FUNCTION activity_template_family_version_freeze_guard();

COMMIT;
