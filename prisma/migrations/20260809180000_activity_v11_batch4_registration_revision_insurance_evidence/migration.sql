-- 活动改造 v1.1 第 4 批:保险资格证据按不可变报名修订冻结。
-- 本 migration 只铺兼容地基:旧 header-only evidence 原样保留且不回填；
-- producer / approval 仍保持既有行为；须先独立 drain deploy D82，再由 runtime C 整齐
-- 切换 currentRevision 读写，禁止新旧版本混跑。

BEGIN;

-- 一次拿最终锁级；锁序沿当前旧 writer 的 evidence -> revision，避免中途锁升级窗口。
LOCK TABLE "insurance_eligibility_evidences" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "ActivityRegistrationRevision" IN ACCESS EXCLUSIVE MODE;

ALTER TABLE "insurance_eligibility_evidences"
  ADD COLUMN "activityRegistrationRevisionId" TEXT;

-- 存量列刚加入时恒 NULL；仍按最终 legacy predicate 扫描，防同名旧 unique
-- 被人工漂移成非 unique 后夹入重复头。只计数并 fail-closed，不修数。
DO $insurance_evidence_revision_preflight$
DECLARE
  duplicate_legacy_group_count bigint;
BEGIN
  SELECT COUNT(*)
  INTO duplicate_legacy_group_count
  FROM (
    SELECT 1
    FROM "insurance_eligibility_evidences"
    WHERE "activityRegistrationId" IS NOT NULL
      AND "activityRegistrationRevisionId" IS NULL
    GROUP BY "activityRegistrationId"
    HAVING COUNT(*) > 1
  ) AS duplicate_legacy_groups;

  IF duplicate_legacy_group_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      CONSTRAINT = 'insurance_evidence_activity_registration_unique',
      MESSAGE = 'insurance evidence legacy owner preflight violation',
      DETAIL = format('duplicate_legacy_group_count=%s', duplicate_legacy_group_count);
  END IF;
END
$insurance_evidence_revision_preflight$;

ALTER TABLE "ActivityRegistrationRevision"
  ADD CONSTRAINT "activity_registration_revisions_registration_id_id_unique"
  UNIQUE ("registrationId", "id");

-- ownerKind 闭集不扩值。revisionId 只能附着在 activity_registration owner 上；
-- legacy activity_registration 行继续允许 revisionId=NULL，Team Join 恒为 NULL。
ALTER TABLE "insurance_eligibility_evidences"
  ADD CONSTRAINT "insurance_evidence_registration_revision_owner_ck"
  CHECK (
    "activityRegistrationRevisionId" IS NULL
    OR (
      "ownerKind" = 'activity_registration'
      AND "activityRegistrationId" IS NOT NULL
      AND "teamJoinApplicationId" IS NULL
    )
  );

-- MATCH SIMPLE 使旧 header-only NULL 行天然兼容；非 NULL 时复合键保证 revision
-- 必须真实存在且属于同一永久报名头。两端均 RESTRICT，证据历史不可被级联改写。
ALTER TABLE "insurance_eligibility_evidences"
  ADD CONSTRAINT "insurance_evidence_registration_revision_same_head_fkey"
  FOREIGN KEY ("activityRegistrationId", "activityRegistrationRevisionId")
  REFERENCES "ActivityRegistrationRevision" ("registrationId", "id")
  MATCH SIMPLE
  ON DELETE RESTRICT
  ON UPDATE RESTRICT;

-- 严格替换旧 index：旧 header-only 仍一头一条；revision-bound 改为一修订一条。
DROP INDEX "insurance_evidence_activity_registration_unique";

CREATE UNIQUE INDEX "insurance_evidence_activity_registration_unique"
  ON "insurance_eligibility_evidences" ("activityRegistrationId")
  WHERE "activityRegistrationId" IS NOT NULL
    AND "activityRegistrationRevisionId" IS NULL;

CREATE UNIQUE INDEX "insurance_evidence_activity_registration_revision_unique"
  ON "insurance_eligibility_evidences" ("activityRegistrationRevisionId")
  WHERE "activityRegistrationRevisionId" IS NOT NULL;

COMMIT;
