-- Persistent, reversible column-level SELECT for purpose role srvf_activity_review
-- on public."CapacityReservation".
--
-- Why: after form-version/field INSERT grants, change-review approve counted
-- reservations with:
--   SELECT COUNT(*), "bucketId" ... WHERE "bucketId" IN (...) AND "status" = $4
--   GROUP BY "bucketId"
-- and failed with SQLSTATE 42501 (request cmwznxa6d5c4be6d98baf7949aeb32fb0).
--
-- Scope: GRANT SELECT only on bucketId and status. No GRANT OPTION,
-- no INSERT/UPDATE/DELETE, no PUBLIC, no draft role.
-- Idempotent. Companion REVOKE: docs/ops/runtime-acl/t339/revoke-review-capacity-select.sql.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'srvf_activity_review') THEN
    RAISE EXCEPTION 'required role srvf_activity_review is missing';
  END IF;
  IF to_regclass('public."CapacityReservation"') IS NULL THEN
    RAISE EXCEPTION 'required table public."CapacityReservation" is missing';
  END IF;
END $$;

GRANT SELECT ("bucketId", "status")
  ON TABLE public."CapacityReservation" TO "srvf_activity_review";
