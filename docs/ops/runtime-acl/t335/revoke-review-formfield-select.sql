-- Companion REVOKE for 20261128080000_review_registration_form_field_select.
-- Same column list, same role only. Do not run against a live accept database
-- unless explicitly rolling back that grant. Never add CASCADE here in a way
-- that would drop privileges other roles hold.
--
-- REVOKE SELECT (...) ON TABLE public."RegistrationFormField" FROM "srvf_activity_review";

REVOKE SELECT (
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
) ON TABLE public."RegistrationFormField" FROM "srvf_activity_review";
