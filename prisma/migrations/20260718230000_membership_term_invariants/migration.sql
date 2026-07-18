BEGIN;

-- Block concurrent membership writes across the audit-to-constraint window.
LOCK TABLE "member_organization_memberships" IN SHARE ROW EXCLUSIVE MODE;

-- Fail fast on legacy drift. This migration never repairs or rewrites business rows.
DO $$
DECLARE
  invalid_range_count BIGINT;
  status_time_mismatch_count BIGINT;
  active_future_start_count BIGINT;
  ended_future_end_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO invalid_range_count
  FROM "member_organization_memberships"
  WHERE "endedAt" IS NOT NULL AND "endedAt" < "startedAt";

  SELECT COUNT(*) INTO status_time_mismatch_count
  FROM "member_organization_memberships"
  WHERE ("status" = 'ENDED') <> ("endedAt" IS NOT NULL);

  SELECT COUNT(*) INTO active_future_start_count
  FROM "member_organization_memberships"
  WHERE "status" = 'ACTIVE' AND "startedAt" > CURRENT_TIMESTAMP;

  SELECT COUNT(*) INTO ended_future_end_count
  FROM "member_organization_memberships"
  WHERE "status" = 'ENDED' AND "endedAt" > CURRENT_TIMESTAMP;

  IF invalid_range_count > 0
     OR status_time_mismatch_count > 0
     OR active_future_start_count > 0
     OR ended_future_end_count > 0 THEN
    RAISE EXCEPTION
      'membership term invariant violation: invalid_range=%, status_time_mismatch=%, active_future_start=%, ended_future_end=%',
      invalid_range_count,
      status_time_mismatch_count,
      active_future_start_count,
      ended_future_end_count;
  END IF;
END $$;

ALTER TABLE "member_organization_memberships"
  ADD CONSTRAINT "member_org_membership_term_range_check"
  CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt"),
  ADD CONSTRAINT "member_org_membership_status_time_check"
  CHECK (("status" = 'ENDED') = ("endedAt" IS NOT NULL));

COMMIT;
