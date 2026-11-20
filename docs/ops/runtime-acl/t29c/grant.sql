\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL search_path=pg_catalog,public;
SELECT set_config('srvf.expected_cluster', :'expected_cluster',true);
DO $$BEGIN IF current_database()<>'srvf_staging' OR (SELECT system_identifier::text FROM pg_control_system())<>current_setting('srvf.expected_cluster')
 OR to_regrole('srvf_dp_acceptance_runtime') IS NULL THEN RAISE EXCEPTION 'target mismatch'; END IF; END$$;
LOCK TABLE public."Activity" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public."ActivityRuleSnapshot" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public."activity_responsibility_assignments" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public."notification_outbox_intents" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public."role_bindings" IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF has_table_privilege('srvf_dp_acceptance_runtime','public."Activity"','INSERT') OR ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid='public."Activity"'::regclass AND attnum>0 AND NOT attisdropped AND has_column_privilege('srvf_dp_acceptance_runtime',attrelid,attnum,'INSERT') ORDER BY attname::text COLLATE "C") <> ARRAY[]::text[] THEN RAISE EXCEPTION 'baseline mismatch Activity INSERT'; END IF;
END $$;
GRANT INSERT ("activityTypeCode","allocationModeCode","archiveWaitingDays","capacity","contributionPolicySelectionRevision","createFromTemplateOperationKey","createFromTemplateRequestHash","createdAt","currentEvidenceRevision","currentPopulationRevision","endAt","galleryAttachmentIds","galleryImageKeys","id","initiatorMemberId","isPublicRegistration","location","metricRequirementCode","metricSelectionRevision","organizationId","requiresInsurance","selectedMetricSetDefinitionHash","selectedMetricSetVersionId","selectedTemplateVersionId","startAt","statusCode","timePolicySelectionRevision","title","updatedAt","workflowRevision") ON public."Activity" TO srvf_dp_acceptance_runtime;
DO $$ BEGIN
 IF has_table_privilege('srvf_dp_acceptance_runtime','public."Activity"','UPDATE') OR ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid='public."Activity"'::regclass AND attnum>0 AND NOT attisdropped AND has_column_privilege('srvf_dp_acceptance_runtime',attrelid,attnum,'UPDATE') ORDER BY attname::text COLLATE "C") <> ARRAY['id']::text[] THEN RAISE EXCEPTION 'baseline mismatch Activity UPDATE'; END IF;
END $$;
GRANT UPDATE ("activityTypeCode","allocationModeCode","archiveWaitingDays","capacity","content","currentPopulationRevision","defaultCheckInRadiusMeters","defaultLocationRequired","description","endAt","genderRequirementCode","isPublicRegistration","location","locationLatitude","locationLongitude","organizationId","publishedAt","publishedBy","registrationDeadline","registrationModeCode","registrationNotes","registrationSchema","requiresInsurance","startAt","statusCode","title","updatedAt","visibilityCode","workflowRevision") ON public."Activity" TO srvf_dp_acceptance_runtime;
DO $$ BEGIN
 IF has_table_privilege('srvf_dp_acceptance_runtime','public."ActivityRuleSnapshot"','INSERT') OR ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid='public."ActivityRuleSnapshot"'::regclass AND attnum>0 AND NOT attisdropped AND has_column_privilege('srvf_dp_acceptance_runtime',attrelid,attnum,'INSERT') ORDER BY attname::text COLLATE "C") <> ARRAY[]::text[] THEN RAISE EXCEPTION 'baseline mismatch ActivityRuleSnapshot INSERT'; END IF;
END $$;
GRANT INSERT ("activityId","contributionPolicySelectionRevisionId","createdAt","createdByReviewId","id","resolvedConfig","snapshotHash","templateVersionId","timePolicySelectionRevisionId","workflowRevision") ON public."ActivityRuleSnapshot" TO srvf_dp_acceptance_runtime;
DO $$ BEGIN
 IF has_table_privilege('srvf_dp_acceptance_runtime','public."ActivityRuleSnapshot"','SELECT') OR ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid='public."ActivityRuleSnapshot"'::regclass AND attnum>0 AND NOT attisdropped AND has_column_privilege('srvf_dp_acceptance_runtime',attrelid,attnum,'SELECT') ORDER BY attname::text COLLATE "C") <> ARRAY[]::text[] THEN RAISE EXCEPTION 'baseline mismatch ActivityRuleSnapshot SELECT'; END IF;
END $$;
GRANT SELECT ("activityId","contributionPolicySelectionRevisionId","createdAt","createdByReviewId","id","resolvedConfig","snapshotHash","templateVersionId","timePolicySelectionRevisionId","workflowRevision") ON public."ActivityRuleSnapshot" TO srvf_dp_acceptance_runtime;
DO $$ BEGIN
 IF has_table_privilege('srvf_dp_acceptance_runtime','public."activity_responsibility_assignments"','INSERT') OR ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid='public."activity_responsibility_assignments"'::regclass AND attnum>0 AND NOT attisdropped AND has_column_privilege('srvf_dp_acceptance_runtime',attrelid,attnum,'INSERT') ORDER BY attname::text COLLATE "C") <> ARRAY[]::text[] THEN RAISE EXCEPTION 'baseline mismatch activity_responsibility_assignments INSERT'; END IF;
END $$;
GRANT INSERT ("activityId","assignedByUserId","canManageAttendance","canManageRegistrations","createdAt","id","memberId","responsibilityType","source","startedAt","status","updatedAt") ON public."activity_responsibility_assignments" TO srvf_dp_acceptance_runtime;
DO $$ BEGIN
 IF has_table_privilege('srvf_dp_acceptance_runtime','public."activity_responsibility_assignments"','SELECT') OR ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid='public."activity_responsibility_assignments"'::regclass AND attnum>0 AND NOT attisdropped AND has_column_privilege('srvf_dp_acceptance_runtime',attrelid,attnum,'SELECT') ORDER BY attname::text COLLATE "C") <> ARRAY[]::text[] THEN RAISE EXCEPTION 'baseline mismatch activity_responsibility_assignments SELECT'; END IF;
END $$;
GRANT SELECT ("activityId","assignedByUserId","canManageAttendance","canManageRegistrations","endedAt","endedByUserId","id","memberId","reason","responsibilityType","source","startedAt","status") ON public."activity_responsibility_assignments" TO srvf_dp_acceptance_runtime;
DO $$ BEGIN
 IF has_table_privilege('srvf_dp_acceptance_runtime','public."notification_outbox_intents"','INSERT') OR ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid='public."notification_outbox_intents"'::regclass AND attnum>0 AND NOT attisdropped AND has_column_privilege('srvf_dp_acceptance_runtime',attrelid,attnum,'INSERT') ORDER BY attname::text COLLATE "C") <> ARRAY[]::text[] THEN RAISE EXCEPTION 'baseline mismatch notification_outbox_intents INSERT'; END IF;
END $$;
GRANT INSERT ("aggregateId","aggregateType","attempts","availableAt","createdAt","destinationRef","destinationType","eventKey","eventType","id","payload","payloadVersion","status","updatedAt") ON public."notification_outbox_intents" TO srvf_dp_acceptance_runtime;
DO $$ BEGIN
 IF has_table_privilege('srvf_dp_acceptance_runtime','public."role_bindings"','INSERT') OR ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid='public."role_bindings"'::regclass AND attnum>0 AND NOT attisdropped AND has_column_privilege('srvf_dp_acceptance_runtime',attrelid,attnum,'INSERT') ORDER BY attname::text COLLATE "C") <> ARRAY[]::text[] THEN RAISE EXCEPTION 'baseline mismatch role_bindings INSERT'; END IF;
END $$;
GRANT INSERT ("createdAt","createdByUserId","id","note","principalId","principalType","roleId","scopeActivityId","scopeType","startedAt","status","updatedAt") ON public."role_bindings" TO srvf_dp_acceptance_runtime;
COMMIT;
