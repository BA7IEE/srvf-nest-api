-- Persistent, reversible column-level SELECT/UPDATE for purpose role
-- srvf_activity_review on public."RegistrationUploadSession".
--
-- Applied live in t338 (2026-11-28 07:56:29 Asia/Shanghai) after change-review
-- approve failed with SQLSTATE 42501 on:
--   UPDATE ... SET "statusCode", "updatedAt"
--   WHERE "formVersionId" = $3 AND "statusCode" = $4
-- Recorded here so Draft PR 1467 matches the official accept database.
--
-- Scope: SELECT (formVersionId, statusCode), UPDATE (statusCode, updatedAt).
-- No GRANT OPTION, no INSERT/DELETE, no PUBLIC, no draft role.
-- Idempotent. Companion REVOKE:
-- docs/ops/runtime-acl/t339/revoke-review-uploadsession-update.sql.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'srvf_activity_review') THEN
    RAISE EXCEPTION 'required role srvf_activity_review is missing';
  END IF;
  IF to_regclass('public."RegistrationUploadSession"') IS NULL THEN
    RAISE EXCEPTION 'required table public."RegistrationUploadSession" is missing';
  END IF;
END $$;

GRANT SELECT ("formVersionId", "statusCode"), UPDATE ("statusCode", "updatedAt")
  ON TABLE public."RegistrationUploadSession" TO "srvf_activity_review";
