-- Persistent, reversible column-level INSERT for purpose role srvf_activity_review
-- on public."RegistrationFormVersion".
--
-- Why: change-review approve activates a new form version with
--   INSERT (...) VALUES (...) RETURNING id
-- after retiring the previous version. Live accept-env failed with SQLSTATE 42501
-- (request cmwzn6v3if5b2c75e108c08f1af0575f9) once UPDATE/RETURNING SELECT were in place.
--
-- Scope: GRANT INSERT only on the nine STATEMENT columns
-- (id, createdAt, updatedAt, activityId, version, statusCode, workflowRevision,
-- schemaHash, activatedAt). No retiredAt, no GRANT OPTION, no DELETE, no PUBLIC.
-- Idempotent. Companion REVOKE: docs/ops/runtime-acl/t339/revoke-review-formversion-insert.sql.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'srvf_activity_review') THEN
    RAISE EXCEPTION 'required role srvf_activity_review is missing';
  END IF;
  IF to_regclass('public."RegistrationFormVersion"') IS NULL THEN
    RAISE EXCEPTION 'required table public."RegistrationFormVersion" is missing';
  END IF;
END $$;

GRANT INSERT (
  "id",
  "createdAt",
  "updatedAt",
  "activityId",
  "version",
  "statusCode",
  "workflowRevision",
  "schemaHash",
  "activatedAt"
) ON TABLE public."RegistrationFormVersion" TO "srvf_activity_review";
