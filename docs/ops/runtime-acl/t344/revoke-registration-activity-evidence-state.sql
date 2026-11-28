-- Companion REVOKE only. Do not execute unless rolling back the t344
-- ActivityEvidenceState UPDATE/SELECT grants to srvf_activity_registration.
-- Do not revoke the pre-existing UPDATE("updatedAt") privilege.
REVOKE UPDATE ("populationRevision","version","lastPopulationAt"),
       SELECT ("populationRevision")
  ON TABLE public."ActivityEvidenceState" FROM "srvf_activity_registration";
