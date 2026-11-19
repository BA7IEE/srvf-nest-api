BEGIN;
SET LOCAL lock_timeout='2s';
LOCK TABLE public.organization_position_assignments,public.organization_supervision_assignments IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN IF current_database()<>'srvf_staging' OR EXISTS (SELECT FROM unnest(ARRAY['organization_position_assignments','organization_supervision_assignments']) t WHERE has_any_column_privilege('srvf_dp_acceptance_runtime','public.'||t,'SELECT')) THEN RAISE EXCEPTION 'baseline changed'; END IF; END $$;
GRANT SELECT ("id", "memberId", "deletedAt", "organizationId", "positionId", "status", "startedAt", "endedAt") ON public.organization_position_assignments TO srvf_dp_acceptance_runtime;
GRANT SELECT ("id", "supervisorMemberId", "deletedAt", "organizationId", "scopeMode", "status", "startedAt", "endedAt") ON public.organization_supervision_assignments TO srvf_dp_acceptance_runtime;
COMMIT;
