-- v0.61.0 PR-C ops-admin 任期与常驻兜底只读预检。
-- 仅统计当前已提交事实；不锁表、不修改、修复或延长任何 RoleBinding 任期。
-- Prisma DateTime 落物理 TIMESTAMP(3)，故显式以 UTC 生成同型单一 now，避免会话时区漂移。
WITH params AS (
  SELECT (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS now
),
current_effective_ops_admins AS (
  SELECT rb."principalId", rb."endedAt"
  FROM role_bindings AS rb
  JOIN roles AS role
    ON role.id = rb."roleId"
  JOIN "User" AS holder
    ON holder.id = rb."principalId"
  CROSS JOIN params
  WHERE rb."principalType" = 'USER'
    AND rb."principalId" IS NOT NULL
    AND rb."scopeType" = 'GLOBAL'
    AND rb.status = 'ACTIVE'
    AND rb."deletedAt" IS NULL
    AND rb."startedAt" <= params.now
    AND (rb."endedAt" IS NULL OR rb."endedAt" >= params.now)
    AND role.code = 'ops-admin'
    AND role."deletedAt" IS NULL
    AND holder.status = 'ACTIVE'
    AND holder."deletedAt" IS NULL
)
SELECT
  COUNT(DISTINCT "principalId")::bigint AS "currentEffectiveOpsAdminCount",
  COUNT(DISTINCT "principalId") FILTER (WHERE "endedAt" IS NULL)::bigint
    AS "currentPermanentOpsAdminCount",
  COUNT(DISTINCT "principalId") >= 1
    AND COUNT(DISTINCT "principalId") FILTER (WHERE "endedAt" IS NULL) >= 1
    AS "invariantSatisfied"
FROM current_effective_ops_admins;
