-- Persistent, reversible column-level UPDATE + SELECT for purpose role
-- srvf_activity_registration on public."ActivityEvidenceState".
--
-- Why: WAVE89 self registration POST /api/app/v1/activities/:id/registrations
-- failed with SQLSTATE 42501 (requests cmwzpv2fl6bcf3ad9dec9c41fa26fdf0b,
-- cmwzpv2osf970d194c1f52ad87e0c62a9). Role srvf_activity_registration
-- (oid 25228 on the official accept database) needed to bump
-- populationRevision/version/lastPopulationAt. The increment expression
-- also reads populationRevision. updatedAt already had UPDATE.
--
-- Scope: GRANT UPDATE on those three columns and SELECT on
-- populationRevision. No GRANT OPTION, no DELETE/TRUNCATE, no PUBLIC,
-- no other roles. Idempotent. Companion REVOKE:
-- docs/ops/runtime-acl/t344/revoke-registration-activity-evidence-state.sql.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'srvf_activity_registration') THEN
    RAISE EXCEPTION 'required role srvf_activity_registration is missing';
  END IF;
  IF to_regclass('public."ActivityEvidenceState"') IS NULL THEN
    RAISE EXCEPTION 'required table public."ActivityEvidenceState" is missing';
  END IF;
END $$;

GRANT UPDATE ("populationRevision", "version", "lastPopulationAt"),
      SELECT ("populationRevision")
  ON TABLE public."ActivityEvidenceState" TO "srvf_activity_registration";
