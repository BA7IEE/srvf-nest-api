-- Persistent, reversible column-level UPDATE for purpose role srvf_activity_review
-- on public."RegistrationFormVersion".
--
-- Why: after SELECT on RegistrationFormField was granted, initial approve
-- proceeded to apply() and failed with SQLSTATE 42501 (permission denied for
-- table RegistrationFormVersion) on:
--   UPDATE ... SET "statusCode", "workflowRevision", "schemaHash",
--   "activatedAt", "retiredAt", "updatedAt"
--   RETURNING "id", "version", "schemaHash"
-- Official grant-review.sql only granted column-level SELECT on this table.
--
-- Scope:
--   - GRANT UPDATE only on the six columns in that STATEMENT
--   - no GRANT OPTION, no INSERT/DELETE, no other tables, no PUBLIC
--   - does NOT grant srvf_activity_draft
--
-- Idempotent. Companion REVOKE is in
-- docs/ops/runtime-acl/t335/revoke-review-formversion-update.sql.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'srvf_activity_review') THEN
    RAISE EXCEPTION 'required role srvf_activity_review is missing';
  END IF;
  IF to_regclass('public."RegistrationFormVersion"') IS NULL THEN
    RAISE EXCEPTION 'required table public."RegistrationFormVersion" is missing';
  END IF;
END $$;

GRANT UPDATE (
  "statusCode",
  "workflowRevision",
  "schemaHash",
  "activatedAt",
  "retiredAt",
  "updatedAt"
) ON TABLE public."RegistrationFormVersion" TO "srvf_activity_review";
