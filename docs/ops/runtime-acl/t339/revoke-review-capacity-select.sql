-- Companion REVOKE only. Do not execute unless rolling back the t339
-- CapacityReservation SELECT grant to srvf_activity_review.
REVOKE SELECT ("bucketId", "status")
  ON TABLE public."CapacityReservation" FROM "srvf_activity_review";
