-- Companion REVOKE only. Do not execute unless rolling back the t340
-- organization_position_role_policies SELECT grant to srvf_activity_admission.
REVOKE SELECT ("id","positionId","roleId","scopeMode","conditionJson","status","deletedAt")
  ON TABLE public.organization_position_role_policies FROM "srvf_activity_admission";
