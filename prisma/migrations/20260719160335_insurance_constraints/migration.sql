-- D-INSURANCE v3 PR4:database constraints closeout.
-- Preconditions are fail-fast only: this migration never deletes, repairs, or rewrites business rows.

BEGIN;

-- The rollout prerequisite is mandatory:stop every evidence producer and drain existing
-- transactions before deploy. Take the final ALTER/trigger lock level up front on both tables
-- that receive DDL; this removes the SHARE ROW EXCLUSIVE -> ACCESS EXCLUSIVE upgrade window
-- (and its possible 40P01 cycle) between the integrity scan and constraint installation.
LOCK TABLE "insurance_eligibility_evidences" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "member_insurances" IN ACCESS EXCLUSIVE MODE;

-- Freeze writes to every remaining source/owner table across the scan-to-constraint window.
LOCK TABLE "team_insurance_policies" IN SHARE MODE;
LOCK TABLE "team_insurance_coverages" IN SHARE MODE;
LOCK TABLE "ActivityRegistration" IN SHARE MODE;
LOCK TABLE "team_join_applications" IN SHARE MODE;

-- Complete integrity preflight. Any non-zero count aborts the transaction before DDL.
DO $insurance_constraints_preflight$
DECLARE
  member_version_count BIGINT;
  member_review_snapshot_count BIGINT;
  evidence_exactly_one_source_count BIGINT;
  evidence_source_kind_count BIGINT;
  evidence_exactly_one_owner_count BIGINT;
  evidence_owner_kind_count BIGINT;
  evidence_required_interval_count BIGINT;
  evidence_source_interval_count BIGINT;
  evidence_review_snapshot_count BIGINT;
  duplicate_registration_owner_count BIGINT;
  duplicate_join_owner_count BIGINT;
  self_registration_mismatch_count BIGINT;
  team_registration_mismatch_count BIGINT;
  self_join_mismatch_count BIGINT;
  team_join_mismatch_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO member_version_count
  FROM "member_insurances"
  WHERE "version" < 0;

  SELECT COUNT(*) INTO member_review_snapshot_count
  FROM "member_insurances"
  WHERE (
    (
      "reviewStatusCode" = 'pending'
      AND "reviewedByUserId" IS NULL
      AND "reviewedAt" IS NULL
    )
    OR
    (
      "reviewStatusCode" IN ('verified', 'rejected')
      AND "reviewedByUserId" IS NOT NULL
      AND "reviewedAt" IS NOT NULL
    )
  ) IS NOT TRUE;

  SELECT COUNT(*) INTO evidence_exactly_one_source_count
  FROM "insurance_eligibility_evidences"
  WHERE num_nonnulls("memberInsuranceId", "teamInsuranceCoverageId") <> 1;

  SELECT COUNT(*) INTO evidence_source_kind_count
  FROM "insurance_eligibility_evidences"
  WHERE (
    (
      "sourceKind" = 'member_insurance'
      AND "memberInsuranceId" IS NOT NULL
      AND "teamInsuranceCoverageId" IS NULL
    )
    OR
    (
      "sourceKind" = 'team_insurance_coverage'
      AND "memberInsuranceId" IS NULL
      AND "teamInsuranceCoverageId" IS NOT NULL
    )
  ) IS NOT TRUE;

  SELECT COUNT(*) INTO evidence_exactly_one_owner_count
  FROM "insurance_eligibility_evidences"
  WHERE num_nonnulls("activityRegistrationId", "teamJoinApplicationId") <> 1;

  SELECT COUNT(*) INTO evidence_owner_kind_count
  FROM "insurance_eligibility_evidences"
  WHERE (
    (
      "ownerKind" = 'activity_registration'
      AND "activityRegistrationId" IS NOT NULL
      AND "teamJoinApplicationId" IS NULL
    )
    OR
    (
      "ownerKind" = 'team_join_application'
      AND "activityRegistrationId" IS NULL
      AND "teamJoinApplicationId" IS NOT NULL
    )
  ) IS NOT TRUE;

  SELECT COUNT(*) INTO evidence_required_interval_count
  FROM "insurance_eligibility_evidences"
  WHERE (
    "requiredFrom" IS NOT NULL
    AND "requiredThrough" IS NOT NULL
    AND "requiredFrom" <= "requiredThrough"
  ) IS NOT TRUE;

  SELECT COUNT(*) INTO evidence_source_interval_count
  FROM "insurance_eligibility_evidences"
  WHERE (
    ("sourceCoverageStart" IS NULL OR "sourceCoverageStart" <= "requiredFrom")
    AND "sourceCoverageEnd" IS NOT NULL
    AND "sourceCoverageEnd" >= "requiredThrough"
  ) IS NOT TRUE;

  SELECT COUNT(*) INTO evidence_review_snapshot_count
  FROM "insurance_eligibility_evidences"
  WHERE (
    (
      "sourceKind" = 'member_insurance'
      AND "sourceRevision" IS NOT NULL
      AND "sourceReviewedByUserId" IS NOT NULL
      AND "sourceReviewedAt" IS NOT NULL
    )
    OR
    (
      "sourceKind" = 'team_insurance_coverage'
      AND "sourceRevision" IS NULL
      AND "sourceReviewedByUserId" IS NULL
      AND "sourceReviewedAt" IS NULL
    )
  ) IS NOT TRUE;

  SELECT COUNT(*) INTO duplicate_registration_owner_count
  FROM (
    SELECT "activityRegistrationId"
    FROM "insurance_eligibility_evidences"
    WHERE "activityRegistrationId" IS NOT NULL
    GROUP BY "activityRegistrationId"
    HAVING COUNT(*) > 1
  ) duplicate_registration_owners;

  SELECT COUNT(*) INTO duplicate_join_owner_count
  FROM (
    SELECT "teamJoinApplicationId"
    FROM "insurance_eligibility_evidences"
    WHERE "teamJoinApplicationId" IS NOT NULL
    GROUP BY "teamJoinApplicationId"
    HAVING COUNT(*) > 1
  ) duplicate_join_owners;

  SELECT COUNT(*) INTO self_registration_mismatch_count
  FROM "insurance_eligibility_evidences" evidence
  INNER JOIN "member_insurances" source
    ON source."id" = evidence."memberInsuranceId"
  INNER JOIN "ActivityRegistration" owner
    ON owner."id" = evidence."activityRegistrationId"
  WHERE evidence."sourceKind" = 'member_insurance'
    AND evidence."memberInsuranceId" IS NOT NULL
    AND evidence."teamInsuranceCoverageId" IS NULL
    AND evidence."ownerKind" = 'activity_registration'
    AND evidence."activityRegistrationId" IS NOT NULL
    AND evidence."teamJoinApplicationId" IS NULL
    AND source."memberId" <> owner."memberId";

  SELECT COUNT(*) INTO team_registration_mismatch_count
  FROM "insurance_eligibility_evidences" evidence
  INNER JOIN "team_insurance_coverages" source
    ON source."id" = evidence."teamInsuranceCoverageId"
  INNER JOIN "ActivityRegistration" owner
    ON owner."id" = evidence."activityRegistrationId"
  WHERE evidence."sourceKind" = 'team_insurance_coverage'
    AND evidence."memberInsuranceId" IS NULL
    AND evidence."teamInsuranceCoverageId" IS NOT NULL
    AND evidence."ownerKind" = 'activity_registration'
    AND evidence."activityRegistrationId" IS NOT NULL
    AND evidence."teamJoinApplicationId" IS NULL
    AND source."memberId" <> owner."memberId";

  SELECT COUNT(*) INTO self_join_mismatch_count
  FROM "insurance_eligibility_evidences" evidence
  INNER JOIN "member_insurances" source
    ON source."id" = evidence."memberInsuranceId"
  INNER JOIN "team_join_applications" owner
    ON owner."id" = evidence."teamJoinApplicationId"
  WHERE evidence."sourceKind" = 'member_insurance'
    AND evidence."memberInsuranceId" IS NOT NULL
    AND evidence."teamInsuranceCoverageId" IS NULL
    AND evidence."ownerKind" = 'team_join_application'
    AND evidence."activityRegistrationId" IS NULL
    AND evidence."teamJoinApplicationId" IS NOT NULL
    AND source."memberId" <> owner."memberId";

  SELECT COUNT(*) INTO team_join_mismatch_count
  FROM "insurance_eligibility_evidences" evidence
  INNER JOIN "team_insurance_coverages" source
    ON source."id" = evidence."teamInsuranceCoverageId"
  INNER JOIN "team_join_applications" owner
    ON owner."id" = evidence."teamJoinApplicationId"
  WHERE evidence."sourceKind" = 'team_insurance_coverage'
    AND evidence."memberInsuranceId" IS NULL
    AND evidence."teamInsuranceCoverageId" IS NOT NULL
    AND evidence."ownerKind" = 'team_join_application'
    AND evidence."activityRegistrationId" IS NULL
    AND evidence."teamJoinApplicationId" IS NOT NULL
    AND source."memberId" <> owner."memberId";

  IF member_version_count > 0
     OR member_review_snapshot_count > 0
     OR evidence_exactly_one_source_count > 0
     OR evidence_source_kind_count > 0
     OR evidence_exactly_one_owner_count > 0
     OR evidence_owner_kind_count > 0
     OR evidence_required_interval_count > 0
     OR evidence_source_interval_count > 0
     OR evidence_review_snapshot_count > 0
     OR duplicate_registration_owner_count > 0
     OR duplicate_join_owner_count > 0
     OR self_registration_mismatch_count > 0
     OR team_registration_mismatch_count > 0
     OR self_join_mismatch_count > 0
     OR team_join_mismatch_count > 0 THEN
    RAISE EXCEPTION USING MESSAGE = format(
      'insurance constraints preflight violation: member_version=%s, member_review_snapshot=%s, evidence_exactly_one_source=%s, evidence_source_kind=%s, evidence_exactly_one_owner=%s, evidence_owner_kind=%s, evidence_required_interval=%s, evidence_source_interval=%s, evidence_review_snapshot=%s, duplicate_registration_owner=%s, duplicate_join_owner=%s, self_registration_mismatch=%s, team_registration_mismatch=%s, self_join_mismatch=%s, team_join_mismatch=%s',
      member_version_count,
      member_review_snapshot_count,
      evidence_exactly_one_source_count,
      evidence_source_kind_count,
      evidence_exactly_one_owner_count,
      evidence_owner_kind_count,
      evidence_required_interval_count,
      evidence_source_interval_count,
      evidence_review_snapshot_count,
      duplicate_registration_owner_count,
      duplicate_join_owner_count,
      self_registration_mismatch_count,
      team_registration_mismatch_count,
      self_join_mismatch_count,
      team_join_mismatch_count
    );
  END IF;
END;
$insurance_constraints_preflight$;

ALTER TABLE "member_insurances"
  ADD CONSTRAINT "member_insurances_version_nonnegative_ck"
    CHECK ("version" >= 0),
  ADD CONSTRAINT "member_insurances_review_snapshot_ck"
    CHECK (
      (
        "reviewStatusCode" = 'pending'
        AND "reviewedByUserId" IS NULL
        AND "reviewedAt" IS NULL
      )
      OR
      (
        "reviewStatusCode" IN ('verified', 'rejected')
        AND "reviewedByUserId" IS NOT NULL
        AND "reviewedAt" IS NOT NULL
      )
    );

ALTER TABLE "insurance_eligibility_evidences"
  ALTER COLUMN "sourceKind" SET NOT NULL,
  ALTER COLUMN "ownerKind" SET NOT NULL,
  ALTER COLUMN "requiredFrom" SET NOT NULL,
  ALTER COLUMN "requiredThrough" SET NOT NULL,
  ALTER COLUMN "sourceCoverageEnd" SET NOT NULL;

ALTER TABLE "insurance_eligibility_evidences"
  ADD CONSTRAINT "insurance_evidence_exactly_one_source_ck"
    CHECK (num_nonnulls("memberInsuranceId", "teamInsuranceCoverageId") = 1),
  ADD CONSTRAINT "insurance_evidence_source_kind_ck"
    CHECK (
      (
        "sourceKind" = 'member_insurance'
        AND "memberInsuranceId" IS NOT NULL
        AND "teamInsuranceCoverageId" IS NULL
      )
      OR
      (
        "sourceKind" = 'team_insurance_coverage'
        AND "memberInsuranceId" IS NULL
        AND "teamInsuranceCoverageId" IS NOT NULL
      )
    ),
  ADD CONSTRAINT "insurance_evidence_exactly_one_owner_ck"
    CHECK (num_nonnulls("activityRegistrationId", "teamJoinApplicationId") = 1),
  ADD CONSTRAINT "insurance_evidence_owner_kind_ck"
    CHECK (
      (
        "ownerKind" = 'activity_registration'
        AND "activityRegistrationId" IS NOT NULL
        AND "teamJoinApplicationId" IS NULL
      )
      OR
      (
        "ownerKind" = 'team_join_application'
        AND "activityRegistrationId" IS NULL
        AND "teamJoinApplicationId" IS NOT NULL
      )
    ),
  ADD CONSTRAINT "insurance_evidence_required_interval_ck"
    CHECK ("requiredFrom" <= "requiredThrough"),
  ADD CONSTRAINT "insurance_evidence_source_interval_ck"
    CHECK (
      ("sourceCoverageStart" IS NULL OR "sourceCoverageStart" <= "requiredFrom")
      AND "sourceCoverageEnd" >= "requiredThrough"
    ),
  ADD CONSTRAINT "insurance_evidence_review_snapshot_ck"
    CHECK (
      (
        "sourceKind" = 'member_insurance'
        AND "sourceRevision" IS NOT NULL
        AND "sourceReviewedByUserId" IS NOT NULL
        AND "sourceReviewedAt" IS NOT NULL
      )
      OR
      (
        "sourceKind" = 'team_insurance_coverage'
        AND "sourceRevision" IS NULL
        AND "sourceReviewedByUserId" IS NULL
        AND "sourceReviewedAt" IS NULL
      )
    );

CREATE UNIQUE INDEX "insurance_evidence_activity_registration_unique"
ON "insurance_eligibility_evidences" ("activityRegistrationId")
WHERE "activityRegistrationId" IS NOT NULL;

CREATE UNIQUE INDEX "insurance_evidence_team_join_application_unique"
ON "insurance_eligibility_evidences" ("teamJoinApplicationId")
WHERE "teamJoinApplicationId" IS NOT NULL;

CREATE FUNCTION insurance_evidence_member_match_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $insurance_evidence_member_match$
DECLARE
  source_member_id TEXT;
  owner_member_id TEXT;
  observed_policy_id TEXT;
  locked_policy_id TEXT;
BEGIN
  -- Invalid row shape is deliberately returned unchanged. INSERT then reaches the table CHECK;
  -- UPDATE reaches the alphabetically later immutable trigger.
  IF num_nonnulls(NEW."memberInsuranceId", NEW."teamInsuranceCoverageId") <> 1
     OR num_nonnulls(NEW."activityRegistrationId", NEW."teamJoinApplicationId") <> 1 THEN
    RETURN NEW;
  END IF;

  IF NOT COALESCE(
    (
      NEW."sourceKind" = 'member_insurance'
      AND NEW."memberInsuranceId" IS NOT NULL
      AND NEW."teamInsuranceCoverageId" IS NULL
    )
    OR
    (
      NEW."sourceKind" = 'team_insurance_coverage'
      AND NEW."memberInsuranceId" IS NULL
      AND NEW."teamInsuranceCoverageId" IS NOT NULL
    ),
    false
  ) THEN
    RETURN NEW;
  END IF;

  IF NOT COALESCE(
    (
      NEW."ownerKind" = 'activity_registration'
      AND NEW."activityRegistrationId" IS NOT NULL
      AND NEW."teamJoinApplicationId" IS NULL
    )
    OR
    (
      NEW."ownerKind" = 'team_join_application'
      AND NEW."activityRegistrationId" IS NULL
      AND NEW."teamJoinApplicationId" IS NOT NULL
    ),
    false
  ) THEN
    RETURN NEW;
  END IF;

  -- Existence probes never raise the custom mismatch error. Missing targets are left to FK on
  -- INSERT, while UPDATE continues to the immutable trigger.
  IF NEW."sourceKind" = 'member_insurance' THEN
    PERFORM 1
    FROM "member_insurances"
    WHERE "id" = NEW."memberInsuranceId";
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
  ELSE
    SELECT "policyId" INTO observed_policy_id
    FROM "team_insurance_coverages"
    WHERE "id" = NEW."teamInsuranceCoverageId";
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
  END IF;

  IF NEW."ownerKind" = 'activity_registration' THEN
    PERFORM 1
    FROM "ActivityRegistration"
    WHERE "id" = NEW."activityRegistrationId";
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
  ELSE
    PERFORM 1
    FROM "team_join_applications"
    WHERE "id" = NEW."teamJoinApplicationId";
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
  END IF;

  IF NEW."sourceKind" = 'member_insurance'
     AND NEW."ownerKind" = 'activity_registration' THEN
    SELECT "memberId" INTO source_member_id
    FROM "member_insurances"
    WHERE "id" = NEW."memberInsuranceId"
    FOR SHARE;
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;

    SELECT "memberId" INTO owner_member_id
    FROM "ActivityRegistration"
    WHERE "id" = NEW."activityRegistrationId"
    FOR SHARE;
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
  ELSIF NEW."sourceKind" = 'team_insurance_coverage'
        AND NEW."ownerKind" = 'activity_registration' THEN
    SELECT "id" INTO locked_policy_id
    FROM "team_insurance_policies"
    WHERE "id" = observed_policy_id
    FOR SHARE;
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;

    SELECT "memberId" INTO source_member_id
    FROM "team_insurance_coverages"
    WHERE "id" = NEW."teamInsuranceCoverageId"
      AND "policyId" = locked_policy_id
    FOR SHARE;
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;

    SELECT "memberId" INTO owner_member_id
    FROM "ActivityRegistration"
    WHERE "id" = NEW."activityRegistrationId"
    FOR SHARE;
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
  ELSIF NEW."sourceKind" = 'member_insurance'
        AND NEW."ownerKind" = 'team_join_application' THEN
    SELECT "memberId" INTO owner_member_id
    FROM "team_join_applications"
    WHERE "id" = NEW."teamJoinApplicationId"
    FOR SHARE;
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;

    SELECT "memberId" INTO source_member_id
    FROM "member_insurances"
    WHERE "id" = NEW."memberInsuranceId"
    FOR SHARE;
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
  ELSE
    SELECT "memberId" INTO owner_member_id
    FROM "team_join_applications"
    WHERE "id" = NEW."teamJoinApplicationId"
    FOR SHARE;
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;

    SELECT "id" INTO locked_policy_id
    FROM "team_insurance_policies"
    WHERE "id" = observed_policy_id
    FOR SHARE;
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;

    SELECT "memberId" INTO source_member_id
    FROM "team_insurance_coverages"
    WHERE "id" = NEW."teamInsuranceCoverageId"
      AND "policyId" = locked_policy_id
    FOR SHARE;
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
  END IF;

  IF source_member_id IS DISTINCT FROM owner_member_id THEN
    RAISE EXCEPTION 'insurance evidence source and owner member mismatch'
    USING
      ERRCODE = '23514',
      CONSTRAINT = 'insurance_evidence_member_match';
  END IF;

  RETURN NEW;
END;
$insurance_evidence_member_match$;

CREATE FUNCTION insurance_evidence_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $insurance_evidence_immutable$
BEGIN
  RAISE EXCEPTION 'insurance eligibility evidence is immutable'
  USING
    ERRCODE = '55000',
    CONSTRAINT = 'insurance_evidence_immutable';
  RETURN NULL;
END;
$insurance_evidence_immutable$;

-- Names order only these two BEFORE triggers relative to one another. CHECK/FK/unique ordering is
-- deliberately not claimed; invalid/missing INSERTs are returned for PostgreSQL to enforce.
CREATE TRIGGER trg_insurance_evidence_10_member_match
BEFORE INSERT OR UPDATE ON "insurance_eligibility_evidences"
FOR EACH ROW EXECUTE FUNCTION insurance_evidence_member_match_guard();

CREATE TRIGGER trg_insurance_evidence_20_immutable
BEFORE UPDATE OR DELETE ON "insurance_eligibility_evidences"
FOR EACH ROW EXECUTE FUNCTION insurance_evidence_immutable_guard();

COMMIT;
