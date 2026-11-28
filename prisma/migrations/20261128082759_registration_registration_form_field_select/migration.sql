-- Persistent, reversible column-level SELECT for purpose role
-- srvf_activity_registration on public."RegistrationFormField".
--
-- Why: Issue 8 stale registration POST
--   /api/app/v1/activities/:id/registrations
-- failed with SQLSTATE 42501 (request cmwzo7k05c256b1ba39e99933c0b21165).
-- Role srvf_activity_registration (oid 25228 on the official accept database)
-- selected id, fieldCode, typeCode, required, min/max value/length,
-- maxSelections, optionsJson, formVersionId, ordered by sortOrder, fieldCode.
--
-- Scope: GRANT SELECT only on those twelve columns (11 in the select list plus
-- sortOrder used in ORDER BY). No GRANT OPTION, no INSERT/UPDATE/DELETE,
-- no PUBLIC, no other roles.
-- Idempotent. Companion REVOKE:
-- docs/ops/runtime-acl/t339/revoke-registration-formfield-select.sql.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'srvf_activity_registration') THEN
    RAISE EXCEPTION 'required role srvf_activity_registration is missing';
  END IF;
  IF to_regclass('public."RegistrationFormField"') IS NULL THEN
    RAISE EXCEPTION 'required table public."RegistrationFormField" is missing';
  END IF;
END $$;

GRANT SELECT (
  "id",
  "fieldCode",
  "typeCode",
  "required",
  "minValue",
  "maxValue",
  "minLength",
  "maxLength",
  "maxSelections",
  "optionsJson",
  "formVersionId",
  "sortOrder"
) ON TABLE public."RegistrationFormField" TO "srvf_activity_registration";
