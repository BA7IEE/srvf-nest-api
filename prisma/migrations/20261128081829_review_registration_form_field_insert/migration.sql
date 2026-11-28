-- Persistent, reversible column-level INSERT for purpose role srvf_activity_review
-- on public."RegistrationFormField".
--
-- Why: after RegistrationFormVersion INSERT was granted, change-review approve
-- inserted the new version's fields and failed with SQLSTATE 42501
-- (request cmwznvfm91a5277e87722d8ffec08149a). The STATEMENT listed every
-- column on the table (23 columns, two rows).
--
-- Scope: GRANT INSERT only on those STATEMENT columns. No GRANT OPTION,
-- no UPDATE/DELETE, no PUBLIC, no draft role.
-- Idempotent. Companion REVOKE: docs/ops/runtime-acl/t339/revoke-review-formfield-insert.sql.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'srvf_activity_review') THEN
    RAISE EXCEPTION 'required role srvf_activity_review is missing';
  END IF;
  IF to_regclass('public."RegistrationFormField"') IS NULL THEN
    RAISE EXCEPTION 'required table public."RegistrationFormField" is missing';
  END IF;
END $$;

GRANT INSERT (
  "id",
  "createdAt",
  "updatedAt",
  "formVersionId",
  "fieldCode",
  "label",
  "helpText",
  "typeCode",
  "required",
  "minValue",
  "maxValue",
  "minLength",
  "maxLength",
  "maxSelections",
  "optionsJson",
  "visibilityCode",
  "exportable",
  "sortOrder",
  "purposeCode",
  "dataClassCode",
  "retentionPolicyCode",
  "maskingPolicyCode",
  "prefillSourceCode"
) ON TABLE public."RegistrationFormField" TO "srvf_activity_review";
