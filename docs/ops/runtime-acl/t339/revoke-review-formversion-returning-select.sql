-- Companion REVOKE only. Do not execute unless rolling back the t338
-- RegistrationFormVersion RETURNING SELECT grant to srvf_activity_review.
REVOKE SELECT ("createdAt", "updatedAt", "activatedAt", "retiredAt")
  ON TABLE public."RegistrationFormVersion" FROM "srvf_activity_review";
