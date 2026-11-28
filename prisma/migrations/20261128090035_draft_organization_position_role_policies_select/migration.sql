-- Persistent, reversible column-level SELECT for purpose role
-- srvf_activity_draft on public.organization_position_role_policies.
--
-- Why: isolated draft create POST /api/app/v1/my/managed-activities
-- failed with SQLSTATE 42501 (request cmwzpdhm1374a1845969c78f1e3bd8bd2).
-- Role srvf_activity_draft (oid 25222 on the official accept database)
-- selected id, positionId, roleId, scopeMode, conditionJson, status
-- and filtered deletedAt IS NULL, joining public.roles (already granted).
--
-- Scope: GRANT SELECT only on those seven columns. No GRANT OPTION,
-- no INSERT/UPDATE/DELETE, no PUBLIC, no other roles.
-- Idempotent. Companion REVOKE:
-- docs/ops/runtime-acl/t342/revoke-draft-org-position-role-policies.sql.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'srvf_activity_draft') THEN
    RAISE EXCEPTION 'required role srvf_activity_draft is missing';
  END IF;
  IF to_regclass('public.organization_position_role_policies') IS NULL THEN
    RAISE EXCEPTION 'required table public.organization_position_role_policies is missing';
  END IF;
END $$;

GRANT SELECT (
  "id",
  "positionId",
  "roleId",
  "scopeMode",
  "conditionJson",
  "status",
  "deletedAt"
) ON TABLE public.organization_position_role_policies TO "srvf_activity_draft";
