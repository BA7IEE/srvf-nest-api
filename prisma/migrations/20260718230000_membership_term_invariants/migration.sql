BEGIN;

-- Block concurrent membership writes across the audit-to-constraint window.
LOCK TABLE "member_organization_memberships" IN SHARE ROW EXCLUSIVE MODE;

-- Fail fast on legacy drift. This migration never repairs or rewrites business rows.
DO $$
DECLARE
  invalid_range_count BIGINT;
  ended_without_time_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO invalid_range_count
  FROM "member_organization_memberships"
  WHERE "endedAt" IS NOT NULL AND "endedAt" < "startedAt";

  SELECT COUNT(*) INTO ended_without_time_count
  FROM "member_organization_memberships"
  WHERE "status" = 'ENDED' AND "endedAt" IS NULL;

  IF invalid_range_count > 0 OR ended_without_time_count > 0 THEN
    RAISE EXCEPTION
      'membership term invariant violation: invalid_range=%, ended_without_time=%',
      invalid_range_count,
      ended_without_time_count;
  END IF;
END $$;

ALTER TABLE "member_organization_memberships"
  ADD CONSTRAINT "member_org_membership_term_range_check"
  CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt"),
  ADD CONSTRAINT "member_org_membership_ended_time_check"
  CHECK ("status" <> 'ENDED' OR "endedAt" IS NOT NULL);

COMMIT;
