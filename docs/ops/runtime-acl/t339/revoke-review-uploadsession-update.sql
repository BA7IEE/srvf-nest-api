-- Companion REVOKE only. Do not execute unless rolling back the t338
-- RegistrationUploadSession SELECT/UPDATE grant to srvf_activity_review.
REVOKE SELECT ("formVersionId", "statusCode"), UPDATE ("statusCode", "updatedAt")
  ON TABLE public."RegistrationUploadSession" FROM "srvf_activity_review";
