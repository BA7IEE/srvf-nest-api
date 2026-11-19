BEGIN;
REVOKE SELECT ("id", "memberId", "deletedAt", "organizationId", "positionId", "status", "startedAt", "endedAt") ON public.organization_position_assignments FROM srvf_dp_acceptance_runtime;
REVOKE SELECT ("id", "supervisorMemberId", "deletedAt", "organizationId", "scopeMode", "status", "startedAt", "endedAt") ON public.organization_supervision_assignments FROM srvf_dp_acceptance_runtime;
COMMIT;
