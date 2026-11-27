-- Persistent, reversible column-level SELECT for purpose role srvf_activity_review
-- on public."RegistrationFormField".
--
-- Why: @ActivityCommand('review') approve paths load the current registration
-- form via formVersionSelect, which includes formFieldSelect plus Prisma's id
-- and formVersionId. Official grant-review.sql already granted column-level
-- SELECT on public."RegistrationFormVersion" but never granted this child table,
-- so accept-env approve failed with SQLSTATE 42501 (permission denied for table
-- RegistrationFormField) while the same-second form PUT succeeded as srvf_t68_api
-- (no @ActivityCommand; table-level DML already present).
--
-- Scope of this migration:
--   - GRANT SELECT only, on the 21 columns actually selected by frozen 8a
--   - no GRANT OPTION, no INSERT/UPDATE/DELETE, no other tables, no PUBLIC
--   - does NOT grant srvf_activity_draft, even though form GET
--     (@ActivityCommand('draft')) hit the same 42501 on this table. That gap
--     is documented under docs/ops/runtime-acl/t335/ and must not be applied
--     automatically until separately authorized.
--
-- Idempotent: repeating GRANT SELECT of the same columns is a no-op in PostgreSQL.
-- Companion REVOKE (same column list, FROM srvf_activity_review only) is in
-- docs/ops/runtime-acl/t335/revoke-review-formfield-select.sql.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'srvf_activity_review') THEN
    RAISE EXCEPTION 'required role srvf_activity_review is missing';
  END IF;
  IF to_regclass('public."RegistrationFormField"') IS NULL THEN
    RAISE EXCEPTION 'required table public."RegistrationFormField" is missing';
  END IF;
END $$;

GRANT SELECT (
  "id",
  "fieldCode",
  "typeCode",
  "label",
  "helpText",
  "required",
  "visibilityCode",
  "exportable",
  "sortOrder",
  "minValue",
  "maxValue",
  "minLength",
  "maxLength",
  "maxSelections",
  "optionsJson",
  "purposeCode",
  "dataClassCode",
  "retentionPolicyCode",
  "maskingPolicyCode",
  "prefillSourceCode",
  "formVersionId"
) ON TABLE public."RegistrationFormField" TO "srvf_activity_review";
