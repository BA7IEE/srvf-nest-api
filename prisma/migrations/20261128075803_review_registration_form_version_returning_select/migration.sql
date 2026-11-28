-- Persistent, reversible column-level SELECT for purpose role srvf_activity_review
-- on public."RegistrationFormVersion" RETURNING columns that lacked SELECT
-- after the t337 UPDATE grant.
--
-- Applied live in t338 (2026-11-28 07:58:03 Asia/Shanghai) after change-review
-- approve retired the old version with
--   UPDATE ... SET "statusCode", "retiredAt", "updatedAt" ... RETURNING
--   id, createdAt, updatedAt, activityId, version, statusCode,
--   workflowRevision, schemaHash, activatedAt, retiredAt
-- and failed with SQLSTATE 42501 on missing SELECT for createdAt, updatedAt,
-- activatedAt and retiredAt.
--
-- Scope: GRANT SELECT only on those four columns. No GRANT OPTION, no PUBLIC.
-- Idempotent. Companion REVOKE:
-- docs/ops/runtime-acl/t339/revoke-review-formversion-returning-select.sql.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'srvf_activity_review') THEN
    RAISE EXCEPTION 'required role srvf_activity_review is missing';
  END IF;
  IF to_regclass('public."RegistrationFormVersion"') IS NULL THEN
    RAISE EXCEPTION 'required table public."RegistrationFormVersion" is missing';
  END IF;
END $$;

GRANT SELECT ("createdAt", "updatedAt", "activatedAt", "retiredAt")
  ON TABLE public."RegistrationFormVersion" TO "srvf_activity_review";
