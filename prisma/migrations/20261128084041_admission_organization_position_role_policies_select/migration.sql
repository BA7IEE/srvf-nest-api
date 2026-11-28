-- Persistent, reversible column-level SELECT for purpose role
-- srvf_activity_admission on public.organization_position_role_policies.
--
-- Why: owner list registrations GET
--   /api/app/v1/my/managed-activities/:id/registrations
-- failed with SQLSTATE 42501 (request cmwzomcw9c6089e56783cf2c1b1077be8).
-- Role srvf_activity_admission (oid 25225 on the official accept database)
-- selected id, positionId, roleId, scopeMode, conditionJson, status
-- and filtered deletedAt IS NULL, joining public.roles (already granted).
--
-- Scope: GRANT SELECT only on those seven columns. No GRANT OPTION,
-- no INSERT/UPDATE/DELETE, no PUBLIC, no other roles.
-- Idempotent. Companion REVOKE:
-- docs/ops/runtime-acl/t340/revoke-admission-org-position-role-policies.sql.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'srvf_activity_admission') THEN
    RAISE EXCEPTION 'required role srvf_activity_admission is missing';
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
) ON TABLE public.organization_position_role_policies TO "srvf_activity_admission";
