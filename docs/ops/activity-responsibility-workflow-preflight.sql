\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- v0.61.0 activity responsibility workflow rollout preflight.
-- This file is deliberately read-only: PostgreSQL itself rejects any accidental write.
BEGIN TRANSACTION READ ONLY;

WITH
legacy_draft_gaps AS (
  SELECT a.id
  FROM "Activity" AS a
  WHERE a."deletedAt" IS NULL
    AND a."statusCode" = 'draft'
    AND a."initiatorMemberId" IS NULL
),
legacy_published_owner_gaps AS (
  SELECT a.id
  FROM "Activity" AS a
  WHERE a."deletedAt" IS NULL
    AND a."statusCode" = 'published'
    AND NOT EXISTS (
      SELECT 1
      FROM activity_responsibility_assignments AS ara
      WHERE ara."activityId" = a.id
        AND ara."responsibilityType" = 'owner'
        AND ara.status = 'active'
        AND ara."endedAt" IS NULL
    )
),
owner_projection_gaps AS (
  SELECT ara.id
  FROM activity_responsibility_assignments AS ara
  WHERE ara."responsibilityType" = 'owner'
    AND ara.status = 'active'
    AND ara."endedAt" IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM role_bindings AS rb
      JOIN roles AS role ON role.id = rb."roleId"
      WHERE rb."principalType" = 'MEMBER'
        AND rb."principalId" = ara."memberId"
        AND rb."scopeType" = 'ACTIVITY'
        AND rb."scopeActivityId" = ara."activityId"
        AND rb.status = 'ACTIVE'
        AND rb."deletedAt" IS NULL
        AND rb."startedAt" <= clock_timestamp()
        AND (rb."endedAt" IS NULL OR rb."endedAt" >= clock_timestamp())
        AND role.code = 'activity-owner'
        AND role."deletedAt" IS NULL
        AND rb.note = 'system:activity-responsibility:' || ara.id
    )
),
required_reviewer_permissions(role_code, permission_code) AS (
  VALUES
    ('activity-publish-reviewer', 'activity-review.read.request'),
    ('activity-publish-reviewer', 'activity.publish.record'),
    ('activity-publish-reviewer', 'activity-review.return.request'),
    ('attendance-first-reviewer', 'attendance.read.sheet'),
    ('attendance-first-reviewer', 'attendance.approve.sheet'),
    ('attendance-first-reviewer', 'attendance.reject.sheet'),
    ('attendance-first-reviewer', 'attendance.return.sheet'),
    ('attendance-final-reviewer', 'attendance.read.sheet'),
    ('attendance-final-reviewer', 'attendance.final-approve.sheet'),
    ('attendance-final-reviewer', 'attendance.final-reject.sheet'),
    ('attendance-final-reviewer', 'attendance.reopen.sheet'),
    ('attendance-final-reviewer', 'attendance.final-return.sheet')
),
effective_reviewer_bindings AS (
  SELECT role.code, rb.id
  FROM role_bindings AS rb
  JOIN roles AS role ON role.id = rb."roleId"
  LEFT JOIN "Organization" AS scope_org ON scope_org.id = rb."scopeOrgId"
  WHERE role.code IN (
      'activity-publish-reviewer',
      'attendance-first-reviewer',
      'attendance-final-reviewer'
    )
    AND role."deletedAt" IS NULL
    AND rb.status = 'ACTIVE'
    AND rb."deletedAt" IS NULL
    AND rb."startedAt" <= clock_timestamp()
    AND (rb."endedAt" IS NULL OR rb."endedAt" >= clock_timestamp())
    AND rb."scopeType" IN ('GLOBAL', 'ORGANIZATION', 'ORGANIZATION_TREE')
    AND (
      (rb."scopeType" = 'GLOBAL' AND rb."scopeOrgId" IS NULL)
      OR
      (
        rb."scopeType" IN ('ORGANIZATION', 'ORGANIZATION_TREE')
        AND rb."scopeOrgId" IS NOT NULL
        AND scope_org.status = 'ACTIVE'
        AND scope_org."deletedAt" IS NULL
      )
    )
    -- A binding is not operational unless the seeded reviewer role still carries every
    -- permission required by that workflow stage.
    AND NOT EXISTS (
      SELECT 1
      FROM required_reviewer_permissions AS required
      WHERE required.role_code = role.code
        AND NOT EXISTS (
          SELECT 1
          FROM role_permissions AS rp
          JOIN permissions AS permission ON permission.id = rp."permissionId"
          WHERE rp."roleId" = role.id
            AND permission.code = required.permission_code
        )
    )
    AND (
      (
        rb."principalType" = 'USER'
        AND EXISTS (
          SELECT 1
          FROM "User" AS u
          WHERE u.id = rb."principalId"
            AND u.status = 'ACTIVE'
            AND u."deletedAt" IS NULL
        )
      )
      OR
      (
        -- Deliberately stricter than Authz's MEMBER lookup: requiring an active Member
        -- can only create a safe false negative in this production-entry probe.
        rb."principalType" = 'MEMBER'
        AND EXISTS (
          SELECT 1
          FROM "Member" AS m
          JOIN "User" AS u ON u."memberId" = m.id
          WHERE m.id = rb."principalId"
            AND m.status = 'ACTIVE'
            AND m."deletedAt" IS NULL
            AND u.status = 'ACTIVE'
            AND u."deletedAt" IS NULL
        )
      )
      OR
      (
        rb."principalType" = 'POSITION_ASSIGNMENT'
        AND EXISTS (
          SELECT 1
          FROM organization_position_assignments AS opa
          JOIN "Member" AS m ON m.id = opa."memberId"
          JOIN "User" AS u ON u."memberId" = m.id
          WHERE opa.id = rb."principalId"
            AND opa.status = 'ACTIVE'
            AND opa."deletedAt" IS NULL
            AND opa."startedAt" <= clock_timestamp()
            AND (opa."endedAt" IS NULL OR opa."endedAt" >= clock_timestamp())
            AND m.status = 'ACTIVE'
            AND m."deletedAt" IS NULL
            AND u.status = 'ACTIVE'
            AND u."deletedAt" IS NULL
        )
      )
    )
),
summary AS (
  SELECT
    (SELECT count(*)::int FROM legacy_draft_gaps) AS "legacyDraftWithoutInitiator",
    (SELECT count(*)::int FROM legacy_published_owner_gaps) AS "legacyPublishedWithoutOwner",
    (SELECT count(*)::int FROM owner_projection_gaps) AS "activeOwnerProjectionGaps",
    (
      SELECT count(*)::int
      FROM effective_reviewer_bindings
      WHERE code = 'activity-publish-reviewer'
    ) AS "activityPublishReviewerBindings",
    (
      SELECT count(*)::int
      FROM effective_reviewer_bindings
      WHERE code = 'attendance-first-reviewer'
    ) AS "attendanceFirstReviewerBindings",
    (
      SELECT count(*)::int
      FROM effective_reviewer_bindings
      WHERE code = 'attendance-final-reviewer'
    ) AS "attendanceFinalReviewerBindings"
)
SELECT 'summary|' || json_build_object(
  'legacyDraftWithoutInitiator', "legacyDraftWithoutInitiator",
  'legacyPublishedWithoutOwner', "legacyPublishedWithoutOwner",
  'activeOwnerProjectionGaps', "activeOwnerProjectionGaps",
  'activityPublishReviewerBindings', "activityPublishReviewerBindings",
  'attendanceFirstReviewerBindings', "attendanceFirstReviewerBindings",
  'attendanceFinalReviewerBindings', "attendanceFinalReviewerBindings",
  'dataReadyForContract',
    "legacyDraftWithoutInitiator" = 0
    AND "legacyPublishedWithoutOwner" = 0
    AND "activeOwnerProjectionGaps" = 0
    AND "activityPublishReviewerBindings" > 0
    AND "attendanceFirstReviewerBindings" > 0
    AND "attendanceFinalReviewerBindings" > 0
)::text
FROM summary;

SELECT 'legacy-gap|' || json_build_object(
  'activityId', a.id,
  'organizationId', a."organizationId",
  'statusCode', a."statusCode",
  'requiredAction',
    CASE
      WHEN a."statusCode" = 'draft' THEN 'assign-initiator'
      WHEN EXISTS (
        SELECT 1
        FROM activity_responsibility_assignments AS ara
        WHERE ara."activityId" = a.id
          AND ara.status = 'active'
          AND ara."endedAt" IS NULL
      ) THEN 'manual-review-active-responsibility'
      ELSE 'claim'
    END
)::text
FROM "Activity" AS a
WHERE a."deletedAt" IS NULL
  AND (
    (
      a."statusCode" = 'draft'
      AND a."initiatorMemberId" IS NULL
    )
    OR
    (
      a."statusCode" = 'published'
      AND NOT EXISTS (
        SELECT 1
        FROM activity_responsibility_assignments AS ara
        WHERE ara."activityId" = a.id
          AND ara."responsibilityType" = 'owner'
          AND ara.status = 'active'
          AND ara."endedAt" IS NULL
      )
    )
  )
ORDER BY a."statusCode", a.id;

ROLLBACK;
