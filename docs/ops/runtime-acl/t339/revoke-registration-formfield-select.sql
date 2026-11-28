-- Companion REVOKE only. Do not execute unless rolling back the t339
-- RegistrationFormField SELECT grant to srvf_activity_registration.
REVOKE SELECT (
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
) ON TABLE public."RegistrationFormField" FROM "srvf_activity_registration";
