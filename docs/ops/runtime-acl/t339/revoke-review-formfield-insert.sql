-- Companion REVOKE only. Do not execute unless rolling back the t339
-- RegistrationFormField INSERT grant to srvf_activity_review.
REVOKE INSERT (
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
) ON TABLE public."RegistrationFormField" FROM "srvf_activity_review";
