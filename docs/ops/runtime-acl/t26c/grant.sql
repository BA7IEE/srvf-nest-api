\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN IF current_database() <> 'srvf_staging' OR to_regrole('srvf_dp_acceptance_runtime') IS NULL THEN RAISE EXCEPTION 'target mismatch'; END IF; END $$;
LOCK TABLE public."Activity" IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN IF has_table_privilege('srvf_dp_acceptance_runtime','public."Activity"','INSERT') OR
 ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid='public."Activity"'::regclass AND attnum>0 AND NOT attisdropped AND has_column_privilege('srvf_dp_acceptance_runtime',attrelid,attnum,'INSERT') ORDER BY attname::text COLLATE "C") <> ARRAY[]::text[]
 THEN RAISE EXCEPTION 'ACL baseline mismatch'; END IF; END $$;
GRANT INSERT ("id","createdAt","updatedAt","title","activityTypeCode","metricSelectionRevision","timePolicySelectionRevision","contributionPolicySelectionRevision","organizationId","startAt","endAt","location","statusCode","initiatorMemberId","workflowRevision","isPublicRegistration","requiresInsurance","allocationModeCode","galleryImageKeys","galleryAttachmentIds","registrationModeCode","visibilityCode","defaultLocationRequired","archiveWaitingDays","currentEvidenceRevision","currentPopulationRevision") ON public."Activity" TO srvf_dp_acceptance_runtime;
LOCK TABLE public."activity_responsibility_assignments" IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN IF has_table_privilege('srvf_dp_acceptance_runtime','public."activity_responsibility_assignments"','SELECT') OR
 ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid='public."activity_responsibility_assignments"'::regclass AND attnum>0 AND NOT attisdropped AND has_column_privilege('srvf_dp_acceptance_runtime',attrelid,attnum,'SELECT') ORDER BY attname::text COLLATE "C") <> ARRAY[]::text[]
 THEN RAISE EXCEPTION 'ACL baseline mismatch'; END IF; END $$;
GRANT SELECT ("activityId","canManageAttendance","canManageRegistrations","id","memberId","responsibilityType","status") ON public."activity_responsibility_assignments" TO srvf_dp_acceptance_runtime;
COMMIT;
