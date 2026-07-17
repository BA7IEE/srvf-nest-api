-- D-RULE-1:one ACTIVE ContributionRule slot per activity type × attendance role.
--
-- This migration intentionally performs no row-level DML, winner selection, deactivation,
-- soft delete, backfill, or AttendanceRecord recomputation. Existing conflicts must be
-- resolved manually before deployment; otherwise the migration aborts before replacing
-- the previous threshold-inclusive partial unique index.

BEGIN;

-- INSERT / UPDATE / DELETE take ROW EXCLUSIVE on the table. SHARE conflicts with it,
-- so no writer can enter between the conflict scan and the replacement index becoming
-- visible. The explicit transaction keeps this lock through DROP / CREATE.
LOCK TABLE "ContributionRule" IN SHARE MODE;

DO $$
DECLARE
  duplicate_pair_count INTEGER;
  duplicate_pair_sample TEXT;
BEGIN
  SELECT count(*)
  INTO duplicate_pair_count
  FROM (
    SELECT 1
    FROM "ContributionRule"
    WHERE "deletedAt" IS NULL
      AND "status" = 'ACTIVE'
    GROUP BY "activityTypeCode", "attendanceRoleCode"
    HAVING count(*) > 1
  ) AS duplicate_pairs;

  IF duplicate_pair_count > 0 THEN
    SELECT string_agg(
      format('(%L, %L): %s ACTIVE rows', "activityTypeCode", "attendanceRoleCode", active_count),
      '; '
      ORDER BY "activityTypeCode", "attendanceRoleCode"
    )
    INTO duplicate_pair_sample
    FROM (
      SELECT "activityTypeCode", "attendanceRoleCode", count(*) AS active_count
      FROM "ContributionRule"
      WHERE "deletedAt" IS NULL
        AND "status" = 'ACTIVE'
      GROUP BY "activityTypeCode", "attendanceRoleCode"
      HAVING count(*) > 1
      ORDER BY "activityTypeCode", "attendanceRoleCode"
      LIMIT 20
    ) AS conflicts;

    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = format(
        'Cannot enforce ContributionRule ACTIVE pair uniqueness: found %s conflicting activityTypeCode × attendanceRoleCode pair(s). Sample: %s. Resolve conflicts manually by explicitly choosing which rule remains ACTIVE and setting every surplus rule INACTIVE or soft-deleting it. Then mark migration 20260718160000_contribution_rule_active_pair_unique rolled back with prisma migrate resolve --rolled-back, rerun the read-only conflict preflight, and only then rerun migrate deploy. This migration made no data changes.',
        duplicate_pair_count,
        duplicate_pair_sample
      );
  END IF;
END
$$;

DROP INDEX "contribution_rules_activity_role_threshold_active_unique";

CREATE UNIQUE INDEX "contribution_rules_activity_role_active_unique"
ON "ContributionRule" ("activityTypeCode", "attendanceRoleCode")
WHERE "deletedAt" IS NULL AND "status" = 'ACTIVE';

COMMIT;
