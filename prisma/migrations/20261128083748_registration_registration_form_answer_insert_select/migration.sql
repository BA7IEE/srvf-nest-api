-- Persistent, reversible column-level INSERT/RETURNING SELECT for purpose role
-- srvf_activity_registration on public."RegistrationFormAnswer".
--
-- Why: formal member registration POST
--   /api/app/v1/activities/:id/registrations
-- failed with SQLSTATE 42501 (request cmwzok7nx8456902b55fc912b31381460).
-- Role srvf_activity_registration (oid 25228 on the official accept database)
-- inserted id, createdAt, registrationRevisionId, fieldId, valueText
-- and returned id, attachmentId.
--
-- Scope: GRANT INSERT on those five columns and SELECT on the two RETURNING
-- columns. No GRANT OPTION, no UPDATE/DELETE, no PUBLIC, no other roles.
-- Idempotent. Companion REVOKE:
-- docs/ops/runtime-acl/t340/revoke-registration-formanswer-insert.sql.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'srvf_activity_registration') THEN
    RAISE EXCEPTION 'required role srvf_activity_registration is missing';
  END IF;
  IF to_regclass('public."RegistrationFormAnswer"') IS NULL THEN
    RAISE EXCEPTION 'required table public."RegistrationFormAnswer" is missing';
  END IF;
END $$;

GRANT INSERT (
  "id",
  "createdAt",
  "registrationRevisionId",
  "fieldId",
  "valueText"
),
SELECT (
  "id",
  "attachmentId"
) ON TABLE public."RegistrationFormAnswer" TO "srvf_activity_registration";
