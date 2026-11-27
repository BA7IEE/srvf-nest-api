-- Companion REVOKE for 20261128080001_review_registration_form_version_update.
-- Same six columns, same role only. Do not run against a live accept database
-- unless explicitly rolling back that grant.

REVOKE UPDATE (
  "statusCode",
  "workflowRevision",
  "schemaHash",
  "activatedAt",
  "retiredAt",
  "updatedAt"
) ON TABLE public."RegistrationFormVersion" FROM "srvf_activity_review";
