-- Companion REVOKE only. Do not execute unless rolling back the t339
-- RegistrationFormVersion INSERT grant to srvf_activity_review.
REVOKE INSERT (
  "id",
  "createdAt",
  "updatedAt",
  "activityId",
  "version",
  "statusCode",
  "workflowRevision",
  "schemaHash",
  "activatedAt"
) ON TABLE public."RegistrationFormVersion" FROM "srvf_activity_review";
