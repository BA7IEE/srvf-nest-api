-- Incomplete chain. Isolated review only. Rollback requires matching apply receipt and grantor.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout='3s';
DO $$BEGIN IF current_database()<>'srvf_staging' OR to_regrole('srvf_dp_acceptance_runtime') IS NULL THEN RAISE EXCEPTION 'target mismatch'; END IF; END$$;
LOCK TABLE public."Activity" IN SHARE ROW EXCLUSIVE MODE;
DO $$DECLARE actual text[]; BEGIN
 SELECT ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid='public."Activity"'::regclass AND attnum>0 AND NOT attisdropped AND has_column_privilege('srvf_dp_acceptance_runtime',attrelid,attnum,'INSERT') ORDER BY attname::text COLLATE "C") INTO actual;
 IF has_table_privilege('srvf_dp_acceptance_runtime','public."Activity"','INSERT') THEN RAISE EXCEPTION 'table privilege drift'; END IF;
 IF actual=ARRAY[]::text[] THEN RETURN; END IF;
 IF actual<>ARRAY['activityTypeCode','allocationModeCode','archiveWaitingDays','contributionPolicySelectionRevision','createdAt','currentEvidenceRevision','currentPopulationRevision','defaultLocationRequired','endAt','galleryAttachmentIds','galleryImageKeys','id','initiatorMemberId','isPublicRegistration','location','metricSelectionRevision','organizationId','registrationModeCode','requiresInsurance','startAt','statusCode','timePolicySelectionRevision','title','updatedAt','visibilityCode','workflowRevision']::text[] THEN RAISE EXCEPTION 'column baseline drift'; END IF;
 REVOKE INSERT ("id","createdAt","updatedAt","title","activityTypeCode","metricSelectionRevision","timePolicySelectionRevision","contributionPolicySelectionRevision","organizationId","startAt","endAt","location","statusCode","initiatorMemberId","workflowRevision","isPublicRegistration","requiresInsurance","allocationModeCode","galleryImageKeys","galleryAttachmentIds","registrationModeCode","visibilityCode","defaultLocationRequired","archiveWaitingDays","currentEvidenceRevision","currentPopulationRevision") ON public."Activity" FROM srvf_dp_acceptance_runtime;
 END$$;
LOCK TABLE public."activity_responsibility_assignments" IN SHARE ROW EXCLUSIVE MODE;
DO $$DECLARE actual text[]; BEGIN
 SELECT ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid='public."activity_responsibility_assignments"'::regclass AND attnum>0 AND NOT attisdropped AND has_column_privilege('srvf_dp_acceptance_runtime',attrelid,attnum,'SELECT') ORDER BY attname::text COLLATE "C") INTO actual;
 IF has_table_privilege('srvf_dp_acceptance_runtime','public."activity_responsibility_assignments"','SELECT') THEN RAISE EXCEPTION 'table privilege drift'; END IF;
 IF actual=ARRAY[]::text[] THEN RETURN; END IF;
 IF actual<>ARRAY['activityId','canManageAttendance','canManageRegistrations','id','memberId','responsibilityType','status']::text[] THEN RAISE EXCEPTION 'column baseline drift'; END IF;
 REVOKE SELECT ("activityId","canManageAttendance","canManageRegistrations","id","memberId","responsibilityType","status") ON public."activity_responsibility_assignments" FROM srvf_dp_acceptance_runtime;
 END$$;
LOCK TABLE public."Activity" IN SHARE ROW EXCLUSIVE MODE;
DO $$DECLARE actual text[]; BEGIN
 SELECT ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid='public."Activity"'::regclass AND attnum>0 AND NOT attisdropped AND has_column_privilege('srvf_dp_acceptance_runtime',attrelid,attnum,'UPDATE') ORDER BY attname::text COLLATE "C") INTO actual;
 IF has_table_privilege('srvf_dp_acceptance_runtime','public."Activity"','UPDATE') THEN RAISE EXCEPTION 'table privilege drift'; END IF;
 IF actual=ARRAY['id']::text[] THEN RETURN; END IF;
 IF actual<>ARRAY['id','title','updatedAt']::text[] THEN RAISE EXCEPTION 'column baseline drift'; END IF;
 REVOKE UPDATE ("title","updatedAt") ON public."Activity" FROM srvf_dp_acceptance_runtime;
 END$$;
COMMIT;
