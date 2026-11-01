-- R5 set materialization installation (migration155).
-- Prerequisite: the five source-model roles already exist, NOLOGIN, with no
-- superuser/create/replication/bypass flags; this migration creates no roles,
-- credentials, memberships or authentication rules. No legacy data backfill.
-- Only the previously source-qualified definitions/ACL are installed.
-- Runtime catalog preflight remains NULL: installation never enables writes.
-- Bind the independently reviewed installation/authentication record before
-- enabling the ordinary trusted HTTP/Human-worker bootstrap.
BEGIN;
DO $prerequisites$ DECLARE missing text[]; BEGIN
 IF EXISTS(SELECT 1 FROM public."AttendanceCorrectionRequest")
 OR to_regclass('public."CorrectionWritePhase"') IS NOT NULL
 OR to_regclass('public."CorrectionApprovedInputItem"') IS NOT NULL
 THEN RAISE EXCEPTION 'empty correction request baseline and uninstalled phase objects required; no backfill' USING ERRCODE='42501'; END IF;
 SELECT array_agg(name) INTO missing FROM(VALUES
 ('r5_boundary_owner_h7c6'),('r5_boundary_caller_h7c6'),('r5_mat_writer_20261029_q1'),
 ('r5_human_queue_login_20261030_q1'),('r5_untrusted_caller_login_20261030_q1')) required(name)
 WHERE to_regrole(name) IS NULL;
 IF missing IS NOT NULL THEN RAISE EXCEPTION 'existing approved roles required: %',missing USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('r5_boundary_owner_h7c6','r5_boundary_caller_h7c6',
 'r5_mat_writer_20261029_q1','r5_human_queue_login_20261030_q1','r5_untrusted_caller_login_20261030_q1')
 AND(rolsuper OR rolcanlogin OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication))
 THEN RAISE EXCEPTION 'requires existing sealed least privilege identities' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('r5_boundary_owner_h7c6','r5_boundary_caller_h7c6',
 'r5_mat_writer_20261029_q1','r5_human_queue_login_20261030_q1','r5_untrusted_caller_login_20261030_q1')
 AND rolinherit<>(rolname='r5_human_queue_login_20261030_q1'))
 THEN RAISE EXCEPTION 'source role inheritance model required' USING ERRCODE='42501'; END IF;
 IF (SELECT count(*) FROM pg_auth_members WHERE roleid IN(SELECT oid FROM pg_roles WHERE rolname IN(
 'r5_boundary_owner_h7c6','r5_boundary_caller_h7c6','r5_mat_writer_20261029_q1',
 'r5_human_queue_login_20261030_q1','r5_untrusted_caller_login_20261030_q1'))
 OR member IN(SELECT oid FROM pg_roles WHERE rolname IN('r5_boundary_owner_h7c6','r5_boundary_caller_h7c6',
 'r5_mat_writer_20261029_q1','r5_human_queue_login_20261030_q1','r5_untrusted_caller_login_20261030_q1')))<>2
 OR NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid='r5_boundary_caller_h7c6'::regrole
 AND member='r5_human_queue_login_20261030_q1'::regrole AND set_option AND inherit_option AND NOT admin_option)
 OR NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid='r5_boundary_caller_h7c6'::regrole
 AND member='r5_untrusted_caller_login_20261030_q1'::regrole AND set_option AND NOT inherit_option AND NOT admin_option)
 THEN RAISE EXCEPTION 'exact source role memberships required; no extra role reachability' USING ERRCODE='42501'; END IF;
END $prerequisites$;
SET LOCAL search_path=pg_catalog;
SET LOCAL lock_timeout='4s';
ALTER TABLE public."AttendanceCorrectionRequest" ADD COLUMN r5_source_revision bigint NOT NULL;

CREATE TABLE public."CorrectionApprovedInputItem" (
    request_id text NOT NULL,
    source_revision bigint NOT NULL,
    kind text NOT NULL,
    ordinal integer NOT NULL,
    complete boolean NOT NULL,
    safe boolean NOT NULL,
    raw_item jsonb,
    schema_version jsonb,
    item_count integer,
    pid text,
    skey text,
    result text,
    CONSTRAINT "CorrectionApprovedInputItem_kind_check" CHECK ((kind = ANY (ARRAY['segments'::text, 'allocations'::text])))
);

ALTER TABLE public."CorrectionApprovedInputItem" OWNER TO r5_boundary_owner_h7c6;

CREATE TABLE public."CorrectionWritePhase" (
    "applicationId" text NOT NULL,
    phase text NOT NULL,
    state text DEFAULT 'OPEN'::text NOT NULL,
    "batchId" text NOT NULL,
    "requestId" text NOT NULL,
    "sourceRevision" bigint NOT NULL,
    "transactionId" xid8 NOT NULL,
    "actorOid" oid NOT NULL,
    CONSTRAINT "CorrectionWritePhase_phase_check" CHECK ((phase = ANY (ARRAY['prepare'::text, 'commit'::text]))),
    CONSTRAINT "CorrectionWritePhase_state_check" CHECK ((state = ANY (ARRAY['OPEN'::text, 'SEALED'::text])))
);

ALTER TABLE public."CorrectionWritePhase" OWNER TO r5_boundary_owner_h7c6;

CREATE SEQUENCE public.r5_approved_input_revision
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.r5_approved_input_revision OWNER TO r5_boundary_owner_h7c6;

ALTER TABLE ONLY public."CorrectionApprovedInputItem"
    ADD CONSTRAINT "CorrectionApprovedInputItem_pkey" PRIMARY KEY (request_id, kind, ordinal);

ALTER TABLE ONLY public."CorrectionWritePhase"
    ADD CONSTRAINT "CorrectionWritePhase_pkey" PRIMARY KEY ("applicationId", phase);

CREATE INDEX r5_approved_input_match ON public."CorrectionApprovedInputItem" USING btree (request_id, source_revision, kind, pid, skey, result);

ALTER TABLE ONLY public."CorrectionWritePhase"
    ADD CONSTRAINT "CorrectionWritePhase_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES public."CorrectionApplication"(id) ON DELETE RESTRICT;

ALTER TABLE public."CorrectionApprovedInputItem" ENABLE ROW LEVEL SECURITY;

ALTER TABLE public."CorrectionWritePhase" ENABLE ROW LEVEL SECURITY;

ALTER TABLE public."CorrectionWritePhase" ADD COLUMN "materializedByUserId" text,
 ADD COLUMN "materializedAt" timestamp(3) without time zone;
ALTER TABLE public."CorrectionWritePhase" DROP CONSTRAINT "CorrectionWritePhase_state_check";
ALTER TABLE public."CorrectionWritePhase" ADD CONSTRAINT "CorrectionWritePhase_state_check"
 CHECK(state IN('OPEN','MATERIALIZED','SEALED'));

CREATE OR REPLACE FUNCTION public.correction_pending_segment_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE approved JSONB; app_status TEXT; request_status TEXT; indexed_match BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'pending segment is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public."CorrectionSegmentCleanupReceipt" WHERE "applicationId" = OLD."applicationId") THEN
      RAISE EXCEPTION 'pending deletion requires cleanup receipt' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  BEGIN
  SELECT r."requestedChangeJson", a."statusCode", r."statusCode",
    CASE WHEN h.complete AND h.safe THEN EXISTS(
      SELECT 1 FROM public."CorrectionApprovedInputItem" x
      WHERE x.request_id=r.id AND x.source_revision=r.r5_source_revision AND x.kind='segments' AND x.ordinal>0
        AND x.pid=NEW."participationIdentityId" AND x.skey=NEW."segmentKey" AND x.result=NEW."resultCode"
        AND x.raw_item->>'participationIdentityId'=NEW."participationIdentityId"
        AND x.raw_item->>'segmentKey'=NEW."segmentKey" AND x.raw_item->>'resultCode'=NEW."resultCode"
        AND (x.raw_item->>'serviceHours')::numeric=NEW."serviceHours"
        AND (x.raw_item->>'checkInAt')::timestamptz=NEW."checkInAt" AT TIME ZONE 'UTC'
        AND (x.raw_item->>'checkOutAt')::timestamptz=NEW."checkOutAt" AT TIME ZONE 'UTC')
    ELSE NULL END
    INTO approved, app_status, request_status,indexed_match
    FROM public."CorrectionApplication" a JOIN public."AttendanceCorrectionRequest" r ON r.id = a."correctionRequestId"
    JOIN public."ActivityParticipationIdentity" i ON i.id = NEW."participationIdentityId" AND i."activityId" = r."activityId"
    JOIN public."ParticipantServiceSegmentRevision" b ON b.id = NEW."baseRevisionId"
      AND b."participationIdentityId" = i.id AND b."segmentKey" = NEW."segmentKey"
      AND b.revision = NEW."baseRevisionNumber" AND b."statusCode" = 'committed'
      AND b."sourceCheckInEventId" = NEW."sourceCheckInEventId"
    JOIN public."AttendancePunchEvent" e ON e.id = NEW."sourceCheckInEventId"
      AND e."participationIdentityId" = i.id AND e."activityId" = r."activityId"
    LEFT JOIN public."CorrectionApprovedInputItem" h ON h.request_id=r.id AND h.source_revision=r.r5_source_revision AND h.kind='segments' AND h.ordinal=0
    WHERE a.id = NEW."applicationId" AND r."activityId" = NEW."activityId";
  EXCEPTION WHEN insufficient_privilege THEN
  SELECT r."requestedChangeJson", a."statusCode", r."statusCode"
    INTO approved, app_status, request_status
    FROM public."CorrectionApplication" a JOIN public."AttendanceCorrectionRequest" r ON r.id = a."correctionRequestId"
    JOIN public."ActivityParticipationIdentity" i ON i.id = NEW."participationIdentityId" AND i."activityId" = r."activityId"
    JOIN public."ParticipantServiceSegmentRevision" b ON b.id = NEW."baseRevisionId"
      AND b."participationIdentityId" = i.id AND b."segmentKey" = NEW."segmentKey"
      AND b.revision = NEW."baseRevisionNumber" AND b."statusCode" = 'committed'
      AND b."sourceCheckInEventId" = NEW."sourceCheckInEventId"
    JOIN public."AttendancePunchEvent" e ON e.id = NEW."sourceCheckInEventId"
      AND e."participationIdentityId" = i.id AND e."activityId" = r."activityId"
    WHERE a.id = NEW."applicationId" AND r."activityId" = NEW."activityId";
    indexed_match:=NULL;
  END;
  IF NOT FOUND OR app_status <> 'preparing' OR request_status NOT IN ('approved', 'applying')
     OR EXISTS (SELECT 1 FROM public."CorrectionSegmentCleanupReceipt" WHERE "applicationId" = NEW."applicationId") THEN
    RAISE EXCEPTION 'invalid pending segment chain or lifecycle' USING ERRCODE = '23514';
  END IF;
  IF NOT COALESCE(indexed_match,EXISTS (
    SELECT 1 FROM jsonb_array_elements(approved->'segments') c
    WHERE c->>'participationIdentityId' = NEW."participationIdentityId"
      AND c->>'segmentKey' = NEW."segmentKey" AND c->>'resultCode' = NEW."resultCode"
      AND (c->>'serviceHours')::numeric = NEW."serviceHours"
      AND (c->>'checkInAt')::timestamptz = NEW."checkInAt" AT TIME ZONE 'UTC'
      AND (c->>'checkOutAt')::timestamptz = NEW."checkOutAt" AT TIME ZONE 'UTC'
  )) THEN
    RAISE EXCEPTION 'pending segment differs from approved input' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.correction_segment_lifecycle_check() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE app_id TEXT; prepared INTEGER; remaining INTEGER; cleaned INTEGER; expected INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'CorrectionApplication' THEN app_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN app_id := OLD."applicationId";
  ELSE app_id := NEW."applicationId"; END IF;
  IF public.r5_correction_phase_deferred_registered(app_id) THEN RETURN NULL; END IF;
  SELECT "preparedSegmentCount" INTO prepared FROM "CorrectionSegmentPreparationReceipt" WHERE "applicationId" = app_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'new application requires preparation receipt' USING ERRCODE = '23514'; END IF;
  SELECT jsonb_array_length(r."requestedChangeJson"->'segments') INTO expected
    FROM "CorrectionApplication" a JOIN "AttendanceCorrectionRequest" r ON r.id = a."correctionRequestId" WHERE a.id = app_id;
  SELECT count(*) INTO remaining FROM "CorrectionPendingSegmentRevision" WHERE "applicationId" = app_id;
  SELECT "deletedSegmentCount" INTO cleaned FROM "CorrectionSegmentCleanupReceipt" WHERE "applicationId" = app_id;
  IF prepared IS DISTINCT FROM expected OR
     (cleaned IS NULL AND remaining <> prepared) OR
     (cleaned IS NOT NULL AND (cleaned <> prepared OR remaining <> 0)) THEN
    RAISE EXCEPTION 'inconsistent pending segment lifecycle counts' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.cpta_insert_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE
  app_row RECORD;
  pending_row RECORD;
  base_row RECORD;
  snapshot_row RECORD;
  selection_row RECORD;
  policy_row RECORD;
BEGIN
  -- The historical lookup is search_path-sensitive. A shadow source must
  -- keep that historical lookup and cannot consume public-source derivation.
  IF pg_catalog.to_regclass('"AttendanceCorrectionRequest"')
      IS DISTINCT FROM 'public."AttendanceCorrectionRequest"'::pg_catalog.regclass THEN
    SELECT a.*, q."requestedChangeJson", q."statusCode" AS request_status,
      false AS proto_use_index, NULL::jsonb AS proto_schema_version,
      NULL::jsonb AS proto_candidates
      INTO app_row
      FROM "CorrectionApplication" a
      JOIN "AttendanceCorrectionRequest" q ON q.id = a."correctionRequestId"
      WHERE a.id = NEW."applicationId"
      FOR UPDATE OF a, q;
  ELSE
  BEGIN
    SELECT a.*, q."requestedChangeJson", q."statusCode" AS request_status,
      COALESCE(h.complete AND h.safe, false) AS proto_use_index,
      h.schema_version AS proto_schema_version,
      CASE WHEN h.complete AND h.safe THEN (
        SELECT pg_catalog.jsonb_agg(x.raw_item ORDER BY x.ordinal)
        FROM public."CorrectionApprovedInputItem" x
        WHERE x.request_id=q.id AND x.source_revision=q.r5_source_revision
          AND x.kind='allocations' AND x.ordinal>0
          AND x.pid=NEW."participationIdentityId" AND x.skey=NEW."segmentKey"
      ) ELSE NULL::jsonb END AS proto_candidates
      INTO app_row
      FROM "CorrectionApplication" a
      JOIN public."AttendanceCorrectionRequest" q ON q.id = a."correctionRequestId"
      LEFT JOIN public."CorrectionApprovedInputItem" h
        ON h.request_id=q.id AND h.source_revision=q.r5_source_revision
          AND h.kind='allocations' AND h.ordinal=0
      WHERE a.id = NEW."applicationId"
      FOR UPDATE OF a, q;
  EXCEPTION WHEN insufficient_privilege THEN
    -- Preserve original source ACL/RLS and locks on denied index access.
    SELECT a.*, q."requestedChangeJson", q."statusCode" AS request_status,
      false AS proto_use_index, NULL::jsonb AS proto_schema_version,
      NULL::jsonb AS proto_candidates
      INTO app_row
      FROM "CorrectionApplication" a
      JOIN "AttendanceCorrectionRequest" q ON q.id = a."correctionRequestId"
      WHERE a.id = NEW."applicationId"
      FOR UPDATE OF a, q;
  END;
  END IF;
  IF NOT FOUND
    OR app_row."statusCode" <> 'preparing'
    OR app_row.request_status NOT IN ('approved', 'applying')
    OR (CASE WHEN app_row.proto_use_index THEN app_row.proto_schema_version
      ELSE app_row."requestedChangeJson"->'schemaVersion' END) IS DISTINCT FROM '3'::jsonb
  THEN
    RAISE EXCEPTION 'pending allocation requires an approved V3 application'
      USING ERRCODE = '23514', CONSTRAINT = 'cpta_insert_guard';
  END IF;

  SELECT * INTO pending_row
    FROM "CorrectionPendingSegmentRevision"
    WHERE id = NEW."pendingSegmentId"
      AND "applicationId" = NEW."applicationId"
      AND "activityId" = NEW."activityId"
      AND "participationIdentityId" = NEW."participationIdentityId"
      AND "segmentKey" = NEW."segmentKey"
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pending allocation segment anchor is unavailable'
      USING ERRCODE = '23503', CONSTRAINT = 'cpta_pending_segment_fkey';
  END IF;

  SELECT allocation.* INTO base_row
    FROM "ParticipantTimeAllocationRevision" allocation
    JOIN "ParticipantServiceSegmentRevision" segment
      ON segment.id = allocation."sourceSegmentId"
      AND segment."participationIdentityId" = allocation."participationIdentityId"
    WHERE allocation.id = NEW."baseAllocationRevisionId"
      AND allocation."activityId" = NEW."activityId"
      AND allocation."participationIdentityId" = NEW."participationIdentityId"
      AND allocation."segmentKey" = NEW."segmentKey"
      AND allocation."sourceSegmentId" = pending_row."baseRevisionId"
      AND allocation."sourceSegmentRevision" = pending_row."baseRevisionNumber"
      AND segment."statusCode" = 'committed'
    FOR SHARE OF allocation, segment;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pending allocation base source is unavailable'
      USING ERRCODE = '23514', CONSTRAINT = 'cpta_insert_guard';
  END IF;

  SELECT * INTO snapshot_row FROM "ActivityRuleSnapshot"
    WHERE id = NEW."ruleSnapshotId" AND "activityId" = NEW."activityId" FOR SHARE;
  SELECT * INTO selection_row FROM "ActivityTimePolicySelectionRevision"
    WHERE id = NEW."timePolicySelectionRevisionId" AND "activityId" = NEW."activityId" FOR SHARE;
  SELECT * INTO policy_row FROM "TimePolicyVersion"
    WHERE id = NEW."policyVersionId" AND "definitionHash" = NEW."definitionHash" FOR SHARE;
  IF snapshot_row.id IS NULL OR selection_row.id IS NULL OR policy_row.id IS NULL
    OR snapshot_row."snapshotHash" IS DISTINCT FROM NEW."ruleSnapshotHash"
    OR snapshot_row."timePolicySelectionRevisionId" IS DISTINCT FROM NEW."timePolicySelectionRevisionId"
    OR selection_row."selectionHash" IS DISTINCT FROM NEW."selectionHash"
    OR policy_row."evaluatorVersion" IS DISTINCT FROM NEW."evaluatorVersion"
    OR policy_row."statusCode" NOT IN ('active', 'retired')
  THEN
    RAISE EXCEPTION 'pending allocation policy anchors are unavailable'
      USING ERRCODE = '23514', CONSTRAINT = 'cpta_insert_guard';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      CASE WHEN app_row.proto_use_index
        THEN COALESCE(app_row.proto_candidates, '[]'::jsonb)
        ELSE app_row."requestedChangeJson"->'allocations' END
    ) input
    WHERE input->>'participationIdentityId' = NEW."participationIdentityId"
      AND input->>'segmentKey' = NEW."segmentKey"
      AND input->>'baseSegmentRevisionId' = pending_row."baseRevisionId"
      AND input->>'baseAllocationRevisionId' = NEW."baseAllocationRevisionId"
      AND input->>'recognitionModeCode' = NEW."recognitionModeCode"
      AND input->'manualReason' IS NOT DISTINCT FROM COALESCE(to_jsonb(NEW."manualReason"), 'null'::jsonb)
      AND jsonb_typeof(input->'slices') = 'array'
      AND (
        (NEW."recognitionModeCode" = 'automatic'
          AND jsonb_array_length(input->'slices') = 0)
        OR (NEW."recognitionModeCode" = 'manual'
          AND jsonb_array_length(input->'slices') = NEW."sliceCount")
      )
  ) THEN
    RAISE EXCEPTION 'pending allocation differs from the approved V3 input'
      USING ERRCODE = '23514', CONSTRAINT = 'cpta_insert_guard';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(NEW."allocationJson"->'slices')) <> NEW."sliceCount" THEN
    RAISE EXCEPTION 'pending allocation slice count is inconsistent'
      USING ERRCODE = '23514', CONSTRAINT = 'cpta_insert_guard';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.ctsp_lifecycle_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE
  batch_id TEXT;
  batch_status TEXT;
  application_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'LedgerPostingBatch' THEN
    batch_id := NEW.id;
    batch_status := NEW."statusCode";
  ELSIF TG_TABLE_NAME = 'CorrectionTimeSourceProof' THEN
    batch_id := NEW."postingBatchId";
  ELSIF TG_TABLE_NAME = 'CorrectionTimeAllocationBinding' THEN
    SELECT "postingBatchId" INTO batch_id FROM "CorrectionTimeSourceProof" WHERE id = NEW."proofId";
  ELSIF TG_TABLE_NAME = 'CorrectionPendingTimeAllocation' THEN
    SELECT a."newPostingBatchId" INTO batch_id FROM "CorrectionApplication" a WHERE a.id = NEW."applicationId";
  ELSE
    SELECT a."newPostingBatchId" INTO batch_id
      FROM "CorrectionPendingTimeAllocation" p JOIN "CorrectionApplication" a ON a.id = p."applicationId"
      WHERE p.id = NEW."pendingAllocationId";
  END IF;
  IF batch_id IS NULL THEN RETURN NULL; END IF;
  IF batch_status IS NULL THEN
    SELECT "statusCode" INTO batch_status FROM "LedgerPostingBatch" WHERE id = batch_id;
  END IF;
  SELECT id INTO application_id FROM public."CorrectionApplication" WHERE "newPostingBatchId"=batch_id;
  IF application_id IS NOT NULL AND public.r5_correction_phase_deferred_registered(application_id) THEN RETURN NULL; END IF;
  PERFORM ctsp_assert_complete(batch_id, batch_status = 'committed');
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.e4_assert_complete(revision_id text, validate_version boolean DEFAULT true)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE root "ActivitySettlementContributionRevision"; version_row "AttendanceSettlementVersion";
  time_row "ActivitySettlementTimeRevision"; previous "ActivitySettlementContributionRevision";
  source_draft "ActivitySettlementContributionRevision"; application "CorrectionApplication";
  request_row "AttendanceCorrectionRequest"; manifest "ParticipationTimeCorrectionManifest";
  time_proof "CorrectionTimeSourceProof"; counts BIGINT; total NUMERIC; sources_hash TEXT; evaluations_hash TEXT;
  source_invalid BOOLEAN; evaluation_mismatch BOOLEAN;
BEGIN
  SELECT * INTO STRICT root FROM "ActivitySettlementContributionRevision" WHERE id=revision_id;
  SELECT * INTO STRICT version_row FROM "AttendanceSettlementVersion" WHERE id=root."settlementVersionId";
  IF version_row."contributionRegimeCode" <> 'policy_v1'
    OR version_row."settlementRunId" <> root."settlementRunId"
    OR version_row."evidenceSealId" <> root."evidenceSealId"
    OR version_row."evidenceRevision" <> root."evidenceRevision"
    OR version_row."populationRevision" <> root."populationRevision"
    OR version_row."workflowRevision" <> root."workflowRevision"
  THEN RAISE EXCEPTION 'contribution version/seal mismatch' USING ERRCODE='23514',CONSTRAINT='e4_version_guard'; END IF;
  PERFORM e4_assert_frozen_selection(root);

  IF root."kindCode" IN ('draft','submitted') THEN
    SELECT * INTO STRICT time_row FROM "ActivitySettlementTimeRevision" WHERE id=root."timeRevisionId";
    IF time_row."kindCode" <> root."kindCode" OR time_row."draftContentHash" <> root."draftContentHash"
      OR time_row."evidenceSealId" <> root."evidenceSealId" OR time_row."evidenceRevision" <> root."evidenceRevision"
      OR time_row."populationRevision" <> root."populationRevision" OR time_row."workflowRevision" <> root."workflowRevision"
      OR time_row."bucketContentHash" IS DISTINCT FROM astr_bucket_content_hash(time_row.id)
      OR time_row."bucketCount" <> (SELECT count(*) FROM "ParticipantSettlementTimeBucket" WHERE "timeRevisionId"=time_row.id)
      OR time_row."sourceCount" <> (SELECT count(*) FROM "ParticipantSettlementTimeBucketSource" WHERE "timeRevisionId"=time_row.id)
    THEN RAISE EXCEPTION 'contribution time revision mismatch' USING ERRCODE='23514',CONSTRAINT='e4_source_guard'; END IF;
    -- Do not filter malformed sources out and then accept a convenient empty proof.
    IF EXISTS (
      SELECT 1 FROM "ParticipantSettlementTimeBucketSource" bs JOIN "ParticipantTimeAllocationRevision" a ON a.id=bs."allocationRevisionId"
      WHERE bs."timeRevisionId"=time_row.id AND (a."ruleSnapshotId" <> root."ruleSnapshotId"
        OR a."ruleSnapshotHash" <> root."ruleSnapshotHash" OR a."activityId" <> root."activityId")
    ) OR EXISTS (
      SELECT 1 FROM "ParticipantSettlementTimeBucket" b LEFT JOIN "ParticipantSettlementResultRevision" rr
        ON rr."settlementVersionId"=root."settlementVersionId" AND rr."participationIdentityId"=b."participationIdentityId"
      WHERE b."timeRevisionId"=time_row.id AND (rr.id IS NULL OR (rr."resultCode" <> 'present' AND b."recognizedSeconds" <> 0))
    ) THEN RAISE EXCEPTION 'contribution source population mismatch' USING ERRCODE='23514',CONSTRAINT='e4_source_guard'; END IF;
    IF root."kindCode"='submitted' THEN
      SELECT * INTO STRICT source_draft FROM "ActivitySettlementContributionRevision" WHERE id=root."sourceDraftContributionRevisionId";
      IF source_draft."kindCode" <> 'draft' OR source_draft."sourceKindCode" <> 'time_revision'
        OR source_draft."settlementRunId" <> root."settlementRunId" OR source_draft."activityId" <> root."activityId"
        OR source_draft."draftContentHash" <> root."draftContentHash" OR source_draft."evidenceSealId" <> root."evidenceSealId"
        OR source_draft."evidenceRevision" <> root."evidenceRevision" OR source_draft."populationRevision" <> root."populationRevision"
        OR source_draft."workflowRevision" <> root."workflowRevision" OR source_draft."ruleSnapshotId" <> root."ruleSnapshotId"
        OR source_draft."selectionRevisionHash" <> root."selectionRevisionHash" OR source_draft."sourceSetHash" <> root."sourceSetHash"
        OR source_draft."evaluationSetHash" <> root."evaluationSetHash" OR source_draft."evaluationCount" <> root."evaluationCount"
        OR source_draft."recognizedPointsTotal" <> root."recognizedPointsTotal"
        OR NOT EXISTS (SELECT 1 FROM "ActivitySettlementTimeRevision" d WHERE d.id=source_draft."timeRevisionId"
          AND d."settlementVersionId"=source_draft."settlementVersionId" AND d."bucketContentHash"=time_row."bucketContentHash"
          AND d."sourceSetHash"=time_row."sourceSetHash")
      THEN RAISE EXCEPTION 'contribution submitted draft mismatch' USING ERRCODE='23514',CONSTRAINT='e4_copy_guard'; END IF;
    END IF;
  ELSE
    SELECT * INTO STRICT previous FROM "ActivitySettlementContributionRevision" WHERE id=root."previousContributionRevisionId";
    SELECT * INTO STRICT application FROM "CorrectionApplication" WHERE id=root."correctionApplicationId";
    SELECT * INTO STRICT request_row FROM "AttendanceCorrectionRequest" WHERE id=application."correctionRequestId";
    IF previous."kindCode" NOT IN ('submitted','correction') OR previous."settlementVersionId" <> root."baseSettlementVersionId"
      OR NOT EXISTS (SELECT 1 FROM "LedgerPostingBatch" b WHERE b."settlementVersionId"=previous."settlementVersionId"
        AND b."settlementRunId"=previous."settlementRunId" AND b."statusCode"='committed')
      OR request_row."baseSettlementVersionId" <> root."baseSettlementVersionId" OR request_row."activityId" <> root."activityId"
      OR request_row."settlementRunId" <> root."settlementRunId" OR application."newSettlementVersionId" <> root."settlementVersionId"
      OR application."newPostingBatchId" <> root."correctionPostingBatchId" OR version_row."priorVersionId" IS DISTINCT FROM previous."settlementVersionId"
      OR previous."evidenceSealId" <> root."evidenceSealId" OR previous."evidenceRevision" <> root."evidenceRevision"
      OR previous."populationRevision" <> root."populationRevision" OR previous."workflowRevision" <> root."workflowRevision"
      OR previous."draftContentHash" <> root."draftContentHash" OR previous."ruleSnapshotId" <> root."ruleSnapshotId"
      OR previous."ruleSnapshotHash" <> root."ruleSnapshotHash" OR previous."selectionRevisionId" <> root."selectionRevisionId"
      OR previous."selectionRevisionHash" <> root."selectionRevisionHash"
    THEN RAISE EXCEPTION 'contribution correction ancestry mismatch' USING ERRCODE='23514',CONSTRAINT='e4_correction_guard'; END IF;
    IF root."sourceKindCode"='unchanged_time' THEN
      IF root."effectiveTimeSettlementVersionId" IS DISTINCT FROM previous."effectiveTimeSettlementVersionId"
        OR request_row."requestedChangeJson"->'schemaVersion' IS DISTINCT FROM '1'::JSONB
        OR (request_row."requestedChangeJson"->'timeCorrection' IS NOT NULL AND request_row."requestedChangeJson"->'timeCorrection' <> 'null'::JSONB)
        OR coalesce(jsonb_array_length(request_row."requestedChangeJson"->'segments'),0) <> 0
        OR coalesce(jsonb_array_length(request_row."requestedChangeJson"->'allocations'),0) <> 0
        OR EXISTS (SELECT 1 FROM "CorrectionTimeSourceProof" WHERE "applicationId"=application.id)
        OR EXISTS (SELECT 1 FROM "ParticipationTimeCorrectionManifest" WHERE "postingBatchId"=root."correctionPostingBatchId")
        OR previous."sourceSetHash" <> root."sourceSetHash" OR previous."evaluationSetHash" <> root."evaluationSetHash"
        OR previous."evaluationCount" <> root."evaluationCount" OR previous."recognizedPointsTotal" <> root."recognizedPointsTotal"
        OR EXISTS (
          WITH prior_results AS MATERIALIZED (SELECT r."participationIdentityId",i."memberId",i."sessionId",i."activityId",r."resultCode",r."recognizedServiceHours"
            FROM "ParticipantSettlementResultRevision" r LEFT JOIN "ActivityParticipationIdentity" i ON i.id=r."participationIdentityId"
            WHERE r."settlementVersionId"=previous."settlementVersionId"),
          current_results AS MATERIALIZED (SELECT r."participationIdentityId",i."memberId",i."sessionId",i."activityId",r."resultCode",r."recognizedServiceHours"
            FROM "ParticipantSettlementResultRevision" r LEFT JOIN "ActivityParticipationIdentity" i ON i.id=r."participationIdentityId"
            WHERE r."settlementVersionId"=root."settlementVersionId")
          SELECT 1 FROM prior_results p FULL JOIN current_results c USING ("participationIdentityId")
          WHERE p."participationIdentityId" IS NULL OR c."participationIdentityId" IS NULL
            OR p."activityId" IS DISTINCT FROM root."activityId" OR c."activityId" IS DISTINCT FROM root."activityId"
            OR p."memberId" IS DISTINCT FROM c."memberId" OR p."sessionId" IS DISTINCT FROM c."sessionId"
            OR p."resultCode" IS DISTINCT FROM c."resultCode"
            OR p."recognizedServiceHours" IS DISTINCT FROM c."recognizedServiceHours"
        )
        OR EXISTS (
          WITH prior AS MATERIALIZED (SELECT "evaluationUnitKey",e4_evaluation_document(e) AS document
            FROM "ParticipantContributionEvaluation" e WHERE "contributionRevisionId"=previous.id),
          current_set AS MATERIALIZED (SELECT "evaluationUnitKey",e4_evaluation_document(e) AS document
            FROM "ParticipantContributionEvaluation" e WHERE "contributionRevisionId"=root.id)
          SELECT 1 FROM prior p FULL JOIN current_set c USING ("evaluationUnitKey") WHERE p.document IS DISTINCT FROM c.document
        )
      THEN RAISE EXCEPTION 'contribution unchanged source mismatch' USING ERRCODE='23514',CONSTRAINT='e4_copy_guard'; END IF;
    ELSE
      SELECT * INTO STRICT manifest FROM "ParticipationTimeCorrectionManifest" WHERE id=root."correctionManifestId";
      SELECT * INTO STRICT time_proof FROM "CorrectionTimeSourceProof" WHERE id=root."correctionTimeSourceProofId";
      IF request_row."requestedChangeJson"->'schemaVersion' IS DISTINCT FROM '3'::JSONB
        OR request_row."requestedChangeJson"->'timeCorrection' IS NULL OR request_row."requestedChangeJson"->'timeCorrection'='null'::JSONB
        OR time_proof."applicationId" <> application.id OR time_proof."correctionManifestId" <> manifest.id
        OR time_proof."postingBatchId" <> root."correctionPostingBatchId" OR time_proof."activityId" <> root."activityId"
        OR time_proof."settlementRunId" <> root."settlementRunId" OR time_proof."baseSettlementVersionId" <> root."baseSettlementVersionId"
        OR time_proof."settlementVersionId" <> root."settlementVersionId" OR time_proof."rootManifestId" <> root."rootTimeManifestId"
        OR time_proof."sourceSetHash" <> root."correctionSourceSetHash" OR manifest."formatVersion" <> 2
        OR manifest."sourceProofId" IS DISTINCT FROM time_proof.id OR manifest."sourceProofHash" IS DISTINCT FROM time_proof."sourceSetHash"
        OR manifest."correctionRequestId" <> request_row.id OR manifest."rootManifestId" <> time_proof."rootManifestId"
        OR time_proof."sourceSetHash" IS DISTINCT FROM e4_hash(jsonb_build_object('domain','correction-time-source-set-v1','definition',time_proof."sourceSnapshotJson"))
        OR time_proof."calculationHash" IS DISTINCT FROM e4_hash(jsonb_build_object('domain','correction-time-calculation-buckets-v1','definition',time_proof."calculatedBucketsJson"))
        OR time_proof."expectedSegmentCount" <> jsonb_array_length(time_proof."sourceSnapshotJson")
        OR time_proof."expectedSliceCount" <> (SELECT coalesce(sum(jsonb_array_length(s->'slices')),0) FROM jsonb_array_elements(time_proof."sourceSnapshotJson") s)
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(time_proof."sourceSnapshotJson") s
          LEFT JOIN "ParticipantTimeAllocationRevision" a ON a.id=s->>'baseAllocationRevisionId' AND a."activityId"=root."activityId"
          WHERE a.id IS NULL OR a."ruleSnapshotId" <> root."ruleSnapshotId" OR a."ruleSnapshotHash" <> root."ruleSnapshotHash"
            OR a."participationIdentityId" IS DISTINCT FROM s->>'participationIdentityId'
        )
      THEN RAISE EXCEPTION 'contribution current D7 proof mismatch' USING ERRCODE='23514',CONSTRAINT='e4_correction_guard'; END IF;
    END IF;
  END IF;

  -- Unchanged-time evidence is an exact set copy of the immutable predecessor,
  -- not a recursive walk/re-evaluation of all earlier correction generations.
  IF root."sourceKindCode" <> 'unchanged_time' THEN
    -- One source expansion per invocation; independent trigger calls remain independent.
    WITH assertion_sources AS MATERIALIZED (
      SELECT * FROM e4_source_rows(root.id)
    ), source_status AS MATERIALIZED (
      SELECT EXISTS (SELECT 1 FROM assertion_sources s WHERE identity_id IS NULL OR member_id IS NULL OR session_id IS NULL
      OR snapshot_id IS DISTINCT FROM root."ruleSnapshotId" OR item_id IS NULL OR policy_id IS NULL OR policy_version_id IS NULL
      OR definition_hash IS NULL OR evaluator_version IS DISTINCT FROM 1 OR role_code IS NULL
      OR category_code NOT IN ('volunteer_service','training','organization','non_creditable')
      OR (source_ref->>'durationSeconds')::INTEGER < 0 OR (source_ref->>'startsAt')::TIMESTAMPTZ >= (source_ref->>'endsAt')::TIMESTAMPTZ) AS invalid
    ), revision_domain AS MATERIALIZED (
  SELECT astr_canonical_json(jsonb_build_object('domain',
    (SELECT "sourceKindCode" FROM "ActivitySettlementContributionRevision" WHERE id=root.id))->'domain') AS canonical
), sources AS MATERIALIZED (
  SELECT source.*,CASE WHEN jsonb_typeof(source_ref)='object' THEN
      CASE WHEN source_ref ?& ARRAY['allocationHash','allocationRevisionId','durationSeconds','endsAt','selectionItemId','sliceId','sourceSegmentId','sourceSegmentRevision','startsAt']::TEXT[]
        AND source_ref - ARRAY['allocationHash','allocationRevisionId','durationSeconds','endsAt','selectionItemId','sliceId','sourceSegmentId','sourceSegmentRevision','startsAt']::TEXT[] = '{}'::JSONB
        AND NOT jsonb_path_exists(source_ref,
          'strict $.* ? (@.type() == "object" || @.type() == "array")')
      THEN
      '{"allocationHash":' || (source_ref->'allocationHash')::TEXT ||
      ',"allocationRevisionId":' || (source_ref->'allocationRevisionId')::TEXT ||
      ',"durationSeconds":' || (source_ref->'durationSeconds')::TEXT ||
      ',"endsAt":' || (source_ref->'endsAt')::TEXT ||
      ',"selectionItemId":' || (source_ref->'selectionItemId')::TEXT ||
      ',"sliceId":' || (source_ref->'sliceId')::TEXT ||
      ',"sourceSegmentId":' || (source_ref->'sourceSegmentId')::TEXT ||
      ',"sourceSegmentRevision":' || (source_ref->'sourceSegmentRevision')::TEXT ||
      ',"startsAt":' || (source_ref->'startsAt')::TEXT || '}'
      ELSE astr_canonical_json(source_ref) END
    ELSE astr_canonical_json(source_ref) END AS source_canonical FROM assertion_sources source
    WHERE NOT (SELECT invalid FROM source_status)
), groups AS MATERIALIZED (
  SELECT identity_id,member_id,session_id,snapshot_id,policy_id,policy_version_id,definition_hash,evaluator_version,role_code,category_code,
    min(item_id COLLATE "C") AS representative,
    sum((source_ref->>'durationSeconds')::BIGINT)::INTEGER AS seconds,
    jsonb_agg(source_ref ORDER BY source_canonical COLLATE "C") AS refs,
    '[' || string_agg(coalesce(source_canonical,'null'),',' ORDER BY source_canonical COLLATE "C") || ']' AS refs_canonical
  FROM sources GROUP BY identity_id,member_id,session_id,snapshot_id,policy_id,policy_version_id,definition_hash,evaluator_version,role_code,category_code
), policy_bands AS NOT MATERIALIZED (
  SELECT p.id,role->>'attendanceRoleCode' AS role_code,category->>'timeCategoryCode' AS category_code,band,ordinal
  FROM "ContributionPolicyVersion" p
  CROSS JOIN LATERAL jsonb_array_elements(p."definitionJson"->'roleRules') role
  CROSS JOIN LATERAL jsonb_array_elements(role->'categoryRules') category
  CROSS JOIN LATERAL jsonb_array_elements(category->'durationBands') WITH ORDINALITY b(band,ordinal)
  WHERE p.id IN (SELECT DISTINCT policy_version_id FROM groups)
), selected AS MATERIALIZED (
  SELECT g.identity_id,g.member_id,g.session_id,g.snapshot_id,g.policy_id,g.policy_version_id,g.definition_hash,g.evaluator_version,g.role_code,g.category_code,
    g.representative,g.seconds,g.refs_canonical,resolved.result,
    '{"attendanceRoleCode":' || coalesce(to_jsonb(g.role_code)::TEXT,'null') ||
    ',"definitionHash":' || coalesce(to_jsonb(g.definition_hash)::TEXT,'null') ||
    ',"evaluatorVersion":' || coalesce(to_jsonb(g.evaluator_version)::TEXT,'null') ||
    ',"mode":"policy","participationIdentityId":' || coalesce(to_jsonb(g.identity_id)::TEXT,'null') ||
    ',"policyId":' || coalesce(to_jsonb(g.policy_id)::TEXT,'null') ||
    ',"policyVersionId":' || coalesce(to_jsonb(g.policy_version_id)::TEXT,'null') ||
    ',"sessionId":' || coalesce(to_jsonb(g.session_id)::TEXT,'null') ||
    ',"timeCategoryCode":' || coalesce(to_jsonb(g.category_code)::TEXT,'null') || '}' AS unit,
    e4_day_points(g.refs,((resolved.result->>'recognizedPoints')::NUMERIC*100)::INTEGER) AS day_points
  FROM groups g JOIN "ContributionPolicyVersion" p ON p.id=g.policy_version_id
  LEFT JOIN LATERAL (
    SELECT b.band FROM policy_bands b WHERE b.id=g.policy_version_id AND b.role_code=g.role_code AND b.category_code=g.category_code
      AND ((b.band->>'maxSecondsInclusive') IS NULL OR (b.band->>'maxSecondsInclusive')::BIGINT >= g.seconds)
    ORDER BY b.ordinal LIMIT 1
  ) chosen ON TRUE
  CROSS JOIN LATERAL (VALUES (coalesce(chosen.band,p."definitionJson"->'defaultResult'))) resolved(result)
), documents AS MATERIALIZED (
  SELECT unit,refs_canonical,
    jsonb_build_object('participationIdentityId',identity_id,'memberId',member_id,'sessionId',session_id,'ruleSnapshotId',snapshot_id,
      'selectionItemId',representative,'mode','policy','policyId',policy_id,'policyVersionId',policy_version_id,'definitionHash',definition_hash,
      'evaluatorVersion',evaluator_version,'attendanceRoleCode',role_code,'timeCategoryCode',category_code,
      'evaluationUnitKey',encode(sha256(convert_to('{"definition":{"unit":' || coalesce(to_jsonb(unit)::TEXT,'null') || '},"schemaVersion":1}','UTF8')),'hex'),'durationSeconds',seconds,
      'sourceFingerprint',encode(sha256(convert_to('{"definition":{"domain":' || (SELECT canonical FROM revision_domain)
        || ',"sources":' || refs_canonical || '},"schemaVersion":1}','UTF8')),'hex'),
      'calculatedPoints',result->>'recognizedPoints','recognizedPoints',result->>'recognizedPoints','explanationCode',result->>'explanationCode',
      'beijingDayPointsJson',day_points) AS metadata
  FROM selected
), canonical_documents AS NOT MATERIALIZED (
  SELECT unit,refs_canonical,metadata,
    (SELECT '{' || string_agg(to_jsonb(field_name)::TEXT || ':' || field_canonical,',' ORDER BY field_name COLLATE "C") || '}'
     FROM (
       SELECT key AS field_name,
          CASE WHEN jsonb_typeof(value) IN ('object','array') THEN astr_canonical_json(value)
            ELSE value::TEXT END AS field_canonical FROM jsonb_each(metadata)
       UNION ALL SELECT 'sourceRefsJson',refs_canonical
     ) field) AS document_canonical
  FROM documents
)
    , expected_documents(unit_canonical,evaluation_key,evaluation) AS NOT MATERIALIZED (
      SELECT unit,metadata->>'evaluationUnitKey',metadata || jsonb_build_object('sourceRefsJson',refs_canonical::JSONB,
        'evaluationHash',encode(sha256(convert_to('{"definition":' || document_canonical || ',"schemaVersion":1}','UTF8')),'hex'))
      FROM canonical_documents
    ), expected AS NOT MATERIALIZED (
      SELECT evaluation_key AS key,evaluation
      FROM expected_documents
    ), actual AS MATERIALIZED (
        SELECT e.id,e."evaluationUnitKey" AS key,e AS evaluation_row
        FROM "ParticipantContributionEvaluation" e
        WHERE e."contributionRevisionId"=root.id
      ), pairs AS MATERIALIZED (
        SELECT a.id AS actual_id,
          x.evaluation IS DISTINCT FROM
            CASE WHEN a.id IS NULL THEN NULL::JSONB
                 ELSE e4_evaluation_document(a.evaluation_row) END AS is_mismatch
        FROM (expected x FULL JOIN actual a USING (key))
      )
    SELECT status.invalid,
      CASE WHEN status.invalid THEN FALSE ELSE EXISTS (
        SELECT 1 FROM pairs p WHERE p.is_mismatch
      ) END
      INTO source_invalid,evaluation_mismatch
    FROM source_status status;
    IF source_invalid THEN RAISE EXCEPTION 'contribution unresolved source' USING ERRCODE='23514',CONSTRAINT='e4_source_guard'; END IF;
    IF evaluation_mismatch THEN RAISE EXCEPTION 'contribution evaluation set mismatch' USING ERRCODE='23514',CONSTRAINT='e4_evaluation_guard'; END IF;
  END IF;
  WITH documents AS MATERIALIZED (
    SELECT e."recognizedPoints",astr_canonical_json(jsonb_build_object('participationIdentityId',e."participationIdentityId",'sessionId',e."sessionId",
      'mode',e.mode,'policyId',e."policyId",'policyVersionId',e."policyVersionId",'definitionHash',e."definitionHash",
      'evaluatorVersion',e."evaluatorVersion",'attendanceRoleCode',e."attendanceRoleCode",'timeCategoryCode',e."timeCategoryCode")) AS unit,
      astr_canonical_json(to_jsonb(e."evaluationUnitKey")) AS unit_key_json,
      astr_canonical_json(to_jsonb(e."sourceFingerprint")) AS source_fingerprint_json,
      astr_canonical_json(to_jsonb(e."evaluationHash")) AS evaluation_hash_json
    FROM "ParticipantContributionEvaluation" e WHERE e."contributionRevisionId"=root.id
  ) SELECT count(*),coalesce(sum("recognizedPoints"),0),
    encode(sha256(convert_to('{"definition":{"domain":'||astr_canonical_json(to_jsonb(root."sourceKindCode"))||',"sources":['||
      coalesce(string_agg('{"evaluationUnitKey":'||unit_key_json||',"sourceFingerprint":'||source_fingerprint_json||'}',
        ',' ORDER BY unit COLLATE "C"),'')||']},"schemaVersion":1}','UTF8')),'hex'),
    encode(sha256(convert_to('{"definition":{"evaluations":['||
      coalesce(string_agg(evaluation_hash_json,',' ORDER BY unit COLLATE "C"),'')||']},"schemaVersion":1}','UTF8')),'hex')
    INTO counts,total,sources_hash,evaluations_hash FROM documents;
  IF counts <> root."evaluationCount" OR total <> root."recognizedPointsTotal"
    OR (root."sourceKindCode" <> 'unchanged_time' AND sources_hash <> root."sourceSetHash") OR evaluations_hash <> root."evaluationSetHash"
    OR (SELECT count(DISTINCT "participationIdentityId") FROM "ParticipantContributionEvaluation" WHERE "contributionRevisionId"=root.id) > 2000
    OR (SELECT coalesce(sum(jsonb_array_length("sourceRefsJson")),0) FROM "ParticipantContributionEvaluation" WHERE "contributionRevisionId"=root.id) > 50000
    OR EXISTS (SELECT 1 FROM "ParticipantContributionEvaluation" WHERE "contributionRevisionId"=root.id
      GROUP BY "participationIdentityId" HAVING sum("recognizedPoints") > 999.99)
  THEN RAISE EXCEPTION 'contribution root count/hash/total mismatch' USING ERRCODE='23514',CONSTRAINT='e4_complete_guard'; END IF;
  IF validate_version AND root."kindCode" <> 'draft' THEN
    IF version_row."contentHash" IS DISTINCT FROM e4_version_content_hash(root.id)
      OR version_row."sessionParticipationCount" <> (SELECT count(*) FROM "ParticipantSettlementResultRevision" WHERE "settlementVersionId"=version_row.id)
      OR EXISTS (
        WITH amounts AS MATERIALIZED (SELECT "participationIdentityId",sum("recognizedPoints") AS amount
          FROM "ParticipantContributionEvaluation" WHERE "contributionRevisionId"=root.id GROUP BY "participationIdentityId")
        SELECT 1 FROM "ParticipantSettlementResultRevision" rr JOIN "ActivityParticipationIdentity" i ON i.id=rr."participationIdentityId"
        LEFT JOIN amounts e ON e."participationIdentityId"=rr."participationIdentityId"
        WHERE rr."settlementVersionId"=version_row.id AND (i."activityId" <> root."activityId"
          OR rr."recognizedContributionPoints" <> coalesce(e.amount,0) OR rr."calculatedContributionPoints" <> coalesce(e.amount,0)
          OR (rr."resultCode" <> 'present' AND coalesce(e.amount,0) <> 0))
      ) OR EXISTS (SELECT 1 FROM "ParticipantContributionEvaluation" e WHERE e."contributionRevisionId"=root.id
        AND NOT EXISTS (SELECT 1 FROM "ParticipantSettlementResultRevision" rr
          WHERE rr."settlementVersionId"=version_row.id AND rr."participationIdentityId"=e."participationIdentityId" AND rr."resultCode"='present'))
    THEN RAISE EXCEPTION 'contribution frozen result/V3 hash mismatch' USING ERRCODE='23514',CONSTRAINT='e4_result_guard'; END IF;
  END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.ptar_slice_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  parent_row RECORD;
  source_row RECORD;
  manifest_slice JSONB;
  expected_slice JSONB;
  total_seconds NUMERIC;
BEGIN

  -- This function remains INVOKER with its original inherited search_path.
  -- Under M it inherits the fixed path of the sole trusted writer. Ordinary
  -- callers execute the original body below without any rewritten condition.
  IF current_user='r5_mat_writer_20261029_q1' THEN
    IF TG_RELID<>'public."ParticipantTimeAllocationSlice"'::regclass OR TG_NAME<>'ptas_manifest_guard'
      OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR pg_catalog.pg_trigger_depth()<>2 THEN
      RAISE EXCEPTION 'unexpected controlled slice call' USING ERRCODE='42501'; END IF;
    IF NEW."allocationRevisionId" IS NULL OR NEW."activityId" IS NULL OR NEW.ordinal IS NULL
      OR NEW.ordinal<0 OR NEW.ordinal>=500 OR NEW."startAt" IS NULL OR NEW."endAt" IS NULL
      OR NEW."startAt">=NEW."endAt" OR NEW."intervalKindCode" IS DISTINCT FROM 'service_segment'
      OR NEW."categoryCode" IS NULL OR NEW."categoryCode" NOT IN
        ('volunteer_service','training','organization','non_creditable') THEN
      RAISE EXCEPTION 'unexpected controlled slice input' USING ERRCODE='55000'; END IF;
    -- Complete invoker validation covers the exact parent, seal, ordinal,
    -- range, overlap, total and manifest equality for every generated attempt.
    -- Parent and source rows are the writer's own fresh INSERTs; ordinary
    -- append/conflict attempts never obtain this branch.
    RETURN NEW;
  END IF;
  SELECT * INTO parent_row
    FROM "ParticipantTimeAllocationRevision"
    WHERE id = NEW."allocationRevisionId" AND "activityId" = NEW."activityId"
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', CONSTRAINT = 'ptas_parent_guard',
      MESSAGE = 'time allocation parent is unavailable';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "ParticipantTimeAllocationCommandReceipt"
    WHERE "allocationRevisionId" = parent_row.id AND "activityId" = parent_row."activityId"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptas_parent_sealed_guard',
      MESSAGE = 'cannot append time allocation slices to a sealed revision';
  END IF;
  IF NEW.ordinal >= parent_row."sliceCount" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptas_manifest_guard',
      MESSAGE = 'time allocation slice ordinal exceeds the parent manifest';
  END IF;
  SELECT * INTO source_row
    FROM "ParticipantServiceSegmentRevision"
    WHERE id = parent_row."sourceSegmentId"
      AND "participationIdentityId" = parent_row."participationIdentityId"
    FOR SHARE;
  IF NOT FOUND
    OR NEW."startAt" < source_row."checkInAt"
    OR NEW."endAt" > source_row."checkOutAt"
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptas_source_interval_guard',
      MESSAGE = 'time allocation slice lies outside the source segment';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "ParticipantTimeAllocationSlice" existing
    WHERE existing."allocationRevisionId" = NEW."allocationRevisionId"
      AND tsrange(existing."startAt", existing."endAt", '[)') &&
          tsrange(NEW."startAt", NEW."endAt", '[)')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptas_overlap_guard',
      MESSAGE = 'time allocation slices overlap';
  END IF;
  SELECT COALESCE(sum(EXTRACT(EPOCH FROM ("endAt" - "startAt"))), 0) INTO total_seconds
    FROM "ParticipantTimeAllocationSlice"
    WHERE "allocationRevisionId" = NEW."allocationRevisionId";
  IF total_seconds + EXTRACT(EPOCH FROM (NEW."endAt" - NEW."startAt")) >
      EXTRACT(EPOCH FROM (source_row."checkOutAt" - source_row."checkInAt"))
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptas_total_guard',
      MESSAGE = 'time allocation slices exceed the source segment duration';
  END IF;
  manifest_slice := parent_row."allocationJson"->'slices'->(NEW.ordinal::TEXT);
  expected_slice := jsonb_build_object(
    'categoryCode', NEW."categoryCode",
    'endAt', to_char(NEW."endAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'intervalKindCode', NEW."intervalKindCode",
    'ordinal', NEW.ordinal,
    'startAt', to_char(NEW."startAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
  IF manifest_slice IS NULL OR manifest_slice IS DISTINCT FROM expected_slice THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptas_manifest_guard',
      MESSAGE = 'time allocation slice differs from the immutable manifest';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.r5_assign_approved_input_revision() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
 IF TG_RELID<>'public."AttendanceCorrectionRequest"'::regclass OR TG_OP NOT IN('INSERT','UPDATE') THEN
  RAISE EXCEPTION 'wrong source relation' USING ERRCODE='42501';END IF;
 IF TG_OP='UPDATE' AND OLD.id IS NOT DISTINCT FROM NEW.id
    AND OLD."requestedChangeJson" IS NOT DISTINCT FROM NEW."requestedChangeJson" THEN
   NEW.r5_source_revision:=OLD.r5_source_revision; RETURN NEW;
 END IF;
 NEW.r5_source_revision:=nextval('public.r5_approved_input_revision'::regclass);
 RETURN NEW;
END;$$;

CREATE OR REPLACE FUNCTION public.r5_correction_assert_pending_lifecycle(app_id text) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE prepared integer; expected integer; remaining integer; cleaned integer;
BEGIN
  SELECT "preparedSegmentCount" INTO prepared FROM public."CorrectionSegmentPreparationReceipt" WHERE "applicationId"=app_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'new application requires preparation receipt' USING ERRCODE='23514'; END IF;
  SELECT jsonb_array_length(q."requestedChangeJson"->'segments') INTO expected
    FROM public."CorrectionApplication" a JOIN public."AttendanceCorrectionRequest" q ON q.id=a."correctionRequestId" WHERE a.id=app_id;
  SELECT count(*) INTO remaining FROM public."CorrectionPendingSegmentRevision" WHERE "applicationId"=app_id;
  SELECT "deletedSegmentCount" INTO cleaned FROM public."CorrectionSegmentCleanupReceipt" WHERE "applicationId"=app_id;
  IF prepared IS DISTINCT FROM expected OR (cleaned IS NULL AND remaining<>prepared)
    OR (cleaned IS NOT NULL AND (cleaned<>prepared OR remaining<>0)) THEN
    RAISE EXCEPTION 'inconsistent pending segment lifecycle counts' USING ERRCODE='23514';
  END IF;
END;$$;

CREATE OR REPLACE FUNCTION public.r5_correction_begin_phase(app_id text, wanted_phase text) RETURNS TABLE("applicationId" text, phase text, "batchId" text, state text, "protocolVersion" integer)
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
  PERFORM public.r5_correction_boundary_preflight();
  -- The table trigger enforces the canonical lock order for this and direct SQL.
  RETURN QUERY INSERT INTO public."CorrectionWritePhase" AS p ("applicationId",phase)
    VALUES(app_id,wanted_phase)
    RETURNING p."applicationId",p.phase,p."batchId",p.state,1;
END;$$;

CREATE OR REPLACE FUNCTION public.r5_correction_boundary_preflight() RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE actor oid; owner_oid oid; expected_names text[]; fact_relations regclass[]; actual_count integer;
  m_oid oid; writer_oid oid; caller_oid oid; db_oid oid; observed_catalog jsonb;
  relation record; attribute record; allowed_insert text[]; allowed_update text[];
  -- This literal is bound ONLY after authorized installation/source validation.
  -- NULL is an intentional hard stop, not an allow-all or caller input.
  expected_catalog CONSTANT jsonb := NULL; -- R5_COMPILED_CATALOG_LITERAL
  insert_columns CONSTANT jsonb := '{"ParticipantServiceSegmentRevision":["id","updatedAt","participationIdentityId","segmentKey","revision","sourceCheckInEventId","resultCode","statusCode","checkInAt","checkOutAt","serviceHours","baseRevisionId"],"ParticipantTimeAllocationRevision":["id","createdAt","activityId","sessionId","memberId","participationIdentityId","segmentKey","revision","previousAllocationRevisionId","sourceSegmentId","sourceSegmentRevision","sourcePositionId","ruleSnapshotId","ruleSnapshotHash","timePolicySelectionRevisionId","selectionHash","policyId","policyVersionId","definitionHash","evaluatorVersion","recognitionModeCode","manualReason","allocationJson","allocationHash","sliceCount","createdByUserId","settlementDraftContentHash","settlementDraftVersionId","settlementEvidenceRevision","settlementEvidenceSealId","settlementPopulationRevision","settlementWorkflowRevision","correctionPendingAllocationId"],"ParticipantTimeAllocationSlice":["id","allocationRevisionId","activityId","ordinal","categoryCode","intervalKindCode","startAt","endAt"],"ParticipantTimeAllocationEvidence":["id","allocationRevisionId","activityId","attachmentId","ordinal"],"ParticipantTimeAllocationCommandReceipt":["id","actorUserId","activityId","operationCode","operationKey","requestHash","allocationRevisionId","resultJson","createdAt"],"CorrectionTimeAllocationBinding":["id","proofId","activityId","participationIdentityId","segmentKey","allocationRevisionId","sourceSegmentId","sourceSegmentRevision","pendingAllocationId","sourceHash"]}'::jsonb;

BEGIN

  IF expected_catalog IS NULL OR jsonb_typeof(expected_catalog)<>'object' THEN
    RAISE EXCEPTION 'materialization catalog pins are not bound' USING ERRCODE='55000'; END IF;
  IF current_database()<>'app_test_r5_setmat_20261029_q1'
     OR current_user<>'r5_boundary_caller_h7c6' THEN
    RAISE EXCEPTION 'unexpected experiment database or runtime role' USING ERRCODE='42501'; END IF;
  caller_oid:=current_user::regrole::oid;
  m_oid:=to_regrole('r5_mat_writer_20261029_q1')::oid;
  writer_oid:=to_regprocedure('public.r5_correction_materialize_facts()')::oid;
  SELECT oid INTO STRICT db_oid FROM pg_database WHERE datname=current_database();
  IF m_oid IS NULL OR writer_oid IS NULL OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE oid=m_oid
      AND NOT(rolsuper OR rolcanlogin OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls))
    OR EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid=m_oid OR member=m_oid)
    OR (SELECT count(*) FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=m_oid AND deptype='o')<>1
    OR NOT EXISTS(SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=m_oid
      AND deptype='o' AND dbid=db_oid AND classid='pg_proc'::regclass AND objid=writer_oid)
  THEN RAISE EXCEPTION 'materializer role has unapproved capabilities or ownership' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=writer_oid
      AND p.proowner=m_oid AND p.prosecdef AND p.prorettype='trigger'::regtype AND l.lanname='plpgsql'
      AND cardinality(p.proconfig)=1 AND replace(p.proconfig[1],' ','')='search_path=pg_catalog,public,pg_temp')
    OR has_function_privilege(caller_oid,writer_oid,'EXECUTE')
    OR EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid=writer_oid AND a.grantee=0 AND a.privilege_type='EXECUTE')
    OR (SELECT count(*) FROM pg_trigger WHERE tgfoid=writer_oid)<>1
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgfoid=writer_oid AND tgrelid='public."CorrectionWritePhase"'::regclass
      AND tgname='r5_phase_materialize_facts' AND tgenabled='O' AND tgtype=17)
  THEN RAISE EXCEPTION 'materializer function is not a closed trigger entry' USING ERRCODE='42501'; END IF;
  -- Public is not trusted just because it appears before pg_temp. Check actual
  -- effective CREATE, including PUBLIC and non-inherited SET-able membership.
  IF NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='public'
      AND pg_get_userbyid(nspowner) IN ('pg_database_owner','postgres','r5_boundary_owner_h7c6'))
    OR EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL
      aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a
      WHERE n.nspname='public' AND a.privilege_type='CREATE' AND
        (a.grantee=0 OR pg_get_userbyid(a.grantee) NOT IN ('postgres','pg_database_owner','r5_boundary_owner_h7c6')))
    OR EXISTS(SELECT 1 FROM pg_roles r WHERE has_schema_privilege(r.oid,'public','CREATE') AND
      (r.oid IN(caller_oid,m_oid) OR pg_has_role(caller_oid,r.oid,'MEMBER') OR
       (NOT r.rolsuper AND r.rolname NOT IN ('pg_database_owner','r5_boundary_owner_h7c6'))))
  THEN RAISE EXCEPTION 'public schema is writable by an unapproved subject' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
    AND p.proname IN ('r5_correction_boundary_preflight','r5_correction_phase_row_guard',
      'r5_correction_phase_write_guard','ptar_slice_guard','r5_correction_materialize_phase',
      'r5_correction_assert_materialization_set') AND (p.prosecdef OR pg_has_role(caller_oid,p.proowner,'MEMBER')))
  THEN RAISE EXCEPTION 'caller qualification cannot be proved under a definer identity' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY(ARRAY['AttendanceCorrectionRequest','CorrectionApplication','CorrectionPendingSegmentRevision','CorrectionPendingTimeAllocation','CorrectionPendingTimeAllocationEvidence','CorrectionTimeSourceProof','LedgerPostingBatch','ParticipantServiceSegmentRevision','ParticipantTimeAllocationRevision','ParticipantTimeAllocationSlice','ParticipantTimeAllocationEvidence','ParticipantTimeAllocationCommandReceipt','CorrectionTimeAllocationBinding','TimePolicyVersion','attachments']) AND
     (c.relkind<>'r' OR c.relrowsecurity OR c.relforcerowsecurity))
  THEN RAISE EXCEPTION 'unexpected materializer source visibility' USING ERRCODE='42501'; END IF;
  FOR relation IN SELECT c.oid,c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f','S') LOOP
    IF relation.relkind='S' THEN
      IF has_sequence_privilege(m_oid,relation.oid,'USAGE,SELECT,UPDATE') THEN
        RAISE EXCEPTION 'materializer has unapproved sequence privileges' USING ERRCODE='42501'; END IF;
      CONTINUE;
    END IF;
    IF NOT relation.relname=ANY(ARRAY['AttendanceCorrectionRequest','CorrectionApplication','CorrectionPendingSegmentRevision','CorrectionPendingTimeAllocation','CorrectionPendingTimeAllocationEvidence','CorrectionTimeSourceProof','LedgerPostingBatch','ParticipantServiceSegmentRevision','ParticipantTimeAllocationRevision','ParticipantTimeAllocationSlice','ParticipantTimeAllocationEvidence','ParticipantTimeAllocationCommandReceipt','CorrectionTimeAllocationBinding','TimePolicyVersion','attachments']) THEN
      IF has_any_column_privilege(m_oid,relation.oid,'SELECT,INSERT,UPDATE,REFERENCES')
        OR has_table_privilege(m_oid,relation.oid,'DELETE,TRUNCATE,TRIGGER') THEN
        RAISE EXCEPTION 'materializer has privileges outside the exact table set' USING ERRCODE='42501'; END IF;
      CONTINUE;
    END IF;
    IF NOT has_table_privilege(m_oid,relation.oid,'SELECT')
      OR has_table_privilege(m_oid,relation.oid,'DELETE,TRUNCATE,TRIGGER') THEN
      RAISE EXCEPTION 'materializer table privileges differ' USING ERRCODE='42501'; END IF;
    SELECT COALESCE(array_agg(v),'{}'::text[]) INTO allowed_insert
      FROM jsonb_array_elements_text(COALESCE(insert_columns->relation.relname,'[]'::jsonb)) x(v);
    allowed_update:=CASE WHEN relation.relname='ParticipantServiceSegmentRevision' THEN ARRAY['statusCode','updatedAt']
      WHEN relation.relname=ANY(ARRAY['AttendanceCorrectionRequest','CorrectionApplication','CorrectionPendingSegmentRevision','CorrectionPendingTimeAllocation','CorrectionTimeSourceProof','LedgerPostingBatch','ParticipantTimeAllocationRevision','TimePolicyVersion','attachments']) THEN ARRAY['id'] ELSE '{}'::text[] END;
    FOR attribute IN SELECT attname,attnum FROM pg_attribute WHERE attrelid=relation.oid AND attnum>0 AND NOT attisdropped LOOP
      IF has_column_privilege(m_oid,relation.oid,attribute.attnum,'INSERT') IS DISTINCT FROM (attribute.attname=ANY(allowed_insert))
        OR has_column_privilege(m_oid,relation.oid,attribute.attnum,'UPDATE') IS DISTINCT FROM (attribute.attname=ANY(allowed_update))
        OR has_column_privilege(m_oid,relation.oid,attribute.attnum,'REFERENCES') THEN
        RAISE EXCEPTION 'materializer column privileges differ' USING ERRCODE='42501'; END IF;
    END LOOP;
  END LOOP;
  WITH relations AS (
 SELECT c.* FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname=ANY(ARRAY['Activity','ActivityParticipationIdentity','AttendanceCorrectionRequest','AttendanceSettlementRun','CorrectionApplication','CorrectionApprovedInputItem','CorrectionPendingSegmentRevision','CorrectionPendingTimeAllocation','CorrectionPendingTimeAllocationEvidence','CorrectionSegmentCleanupReceipt','CorrectionSegmentPreparationReceipt','CorrectionTimeAllocationBinding','CorrectionTimeSourceProof','CorrectionWritePhase','LedgerPostingBatch','ParticipantServiceSegmentRevision','ParticipantTimeAllocationCommandReceipt','ParticipantTimeAllocationEvidence','ParticipantTimeAllocationRevision','ParticipantTimeAllocationSlice','ParticipationTimeCorrectionManifest','TimePolicyVersion','attachments'])
), f AS (
 SELECT p.* FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.prokind IN ('f','p','w')
), table_rows AS (
 SELECT c.relname,jsonb_build_object(
  'name',c.relname,'kind',c.relkind,'owner',pg_catalog.pg_get_userbyid(c.relowner),
  'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,'acl',c.relacl::text,
  'columns',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'number',a.attnum,'name',a.attname,'type',a.atttypid::regtype::text,'typmod',a.atttypmod,
    'notNull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,
    'collation',a.attcollation::regcollation::text,'acl',a.attacl::text,
    'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid,false)) ORDER BY a.attnum)
    FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'[]'::jsonb),
  'constraints',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'name',k.conname,'type',k.contype,'validated',k.convalidated,
    'deferrable',k.condeferrable,'initiallyDeferred',k.condeferred,
    'definition',pg_catalog.pg_get_constraintdef(k.oid,false)) ORDER BY k.conname)
    FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid),'[]'::jsonb),
  'triggers',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'name',t.tgname,'enabled',t.tgenabled,'function',t.tgfoid::regprocedure::text,
    'type',t.tgtype,'deferrable',t.tgdeferrable,'initiallyDeferred',t.tginitdeferred,
    'definition',pg_catalog.pg_get_triggerdef(t.oid,false)) ORDER BY t.tgname)
    FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),'[]'::jsonb),
  'rules',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'name',r.rulename,'enabled',r.ev_enabled,'definition',pg_catalog.pg_get_ruledef(r.oid,false)) ORDER BY r.rulename)
    FROM pg_catalog.pg_rewrite r WHERE r.ev_class=c.oid),'[]'::jsonb),
  'indexes',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'name',ic.relname,'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,
    'unique',i.indisunique,'expression',pg_catalog.pg_get_expr(i.indexprs,i.indrelid,false),
    'predicate',pg_catalog.pg_get_expr(i.indpred,i.indrelid,false),
    'definition',pg_catalog.pg_get_indexdef(i.indexrelid,0,false)) ORDER BY ic.relname)
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid
    WHERE i.indrelid=c.oid),'[]'::jsonb),
  'policies',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,
    'roles',p.polroles::text,'using',pg_catalog.pg_get_expr(p.polqual,p.polrelid,false),
    'check',pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid,false)) ORDER BY p.polname)
    FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid),'[]'::jsonb)
 ) value FROM relations c
), function_rows AS (
 SELECT p.oid::regprocedure::text signature,jsonb_build_object(
  'signature',p.oid::regprocedure::text,'owner',pg_catalog.pg_get_userbyid(p.proowner),
  'language',l.lanname,'kind',p.prokind,'definer',p.prosecdef,'config',p.proconfig,
  'acl',p.proacl::text,'volatility',p.provolatile,'strict',p.proisstrict,
  'leakproof',p.proleakproof,'parallel',p.proparallel,'set',p.proretset,
  'returnType',p.prorettype::regtype::text,'argNames',p.proargnames,'argModes',p.proargmodes,
  'allArgTypes',p.proallargtypes::text,'defaults',pg_catalog.pg_get_function_arguments(p.oid),
  -- Avoid a self-referential hash. Preflight ownership and INVOKER attributes
  -- are checked independently; its exact offline source is an installer pin.
  'bodyHash',CASE WHEN p.proname='r5_correction_boundary_preflight' THEN 'INSTALLER_SOURCE_PIN'
    ELSE pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc,'UTF8')),'hex') END,
  'sqlBody',p.prosqlbody::text) value FROM f p JOIN pg_catalog.pg_language l ON l.oid=p.prolang
)
SELECT jsonb_build_object(
 'database',current_database(),'databaseOid',(SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=current_database()),
 'namespace',(SELECT jsonb_build_object('owner',pg_catalog.pg_get_userbyid(nspowner),'acl',nspacl::text)
   FROM pg_catalog.pg_namespace WHERE nspname='public'),
 'tables',(SELECT jsonb_agg(value ORDER BY relname) FROM table_rows),
 'functions',(SELECT jsonb_agg(value ORDER BY signature) FROM function_rows),
 'enumTypes',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',t.oid::regtype::text,
   'owner',pg_catalog.pg_get_userbyid(t.typowner),'labels',(SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder)
   FROM pg_catalog.pg_enum e WHERE e.enumtypid=t.oid)) ORDER BY t.typname)
   FROM pg_catalog.pg_type t WHERE t.typtype='e' AND t.oid IN
    (SELECT a.atttypid FROM pg_catalog.pg_attribute a JOIN relations r ON r.oid=a.attrelid
      WHERE a.attnum>0 AND NOT a.attisdropped)),'[]'::jsonb)) INTO observed_catalog;
  IF observed_catalog IS DISTINCT FROM expected_catalog THEN
    RAISE EXCEPTION 'materialization dependency catalog differs from fixed source pins' USING ERRCODE='55000'; END IF;

  actor := current_user::regrole::oid;
  SELECT relowner INTO STRICT owner_oid FROM pg_class
    WHERE oid='public."CorrectionWritePhase"'::regclass;
  fact_relations := ARRAY[
    'public."CorrectionApplication"'::regclass,
    'public."AttendanceCorrectionRequest"'::regclass,
    'public."CorrectionPendingSegmentRevision"'::regclass,
    'public."CorrectionSegmentPreparationReceipt"'::regclass,
    'public."CorrectionSegmentCleanupReceipt"'::regclass,
    'public."CorrectionPendingTimeAllocation"'::regclass,
    'public."CorrectionPendingTimeAllocationEvidence"'::regclass,
    'public."CorrectionTimeSourceProof"'::regclass,
    'public."CorrectionTimeAllocationBinding"'::regclass,
    'public."ParticipationTimeCorrectionManifest"'::regclass,
    'public."LedgerPostingBatch"'::regclass,
    'public."ParticipantServiceSegmentRevision"'::regclass,
    'public."ParticipantTimeAllocationRevision"'::regclass,
    'public."ParticipantTimeAllocationCommandReceipt"'::regclass];
  IF EXISTS (SELECT 1 FROM pg_roles WHERE oid=actor AND
      (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolreplication))
    OR pg_has_role(actor,owner_oid,'MEMBER')
    OR has_schema_privilege(actor,'public','CREATE')
    OR EXISTS (SELECT 1 FROM pg_database WHERE datname=current_database()
      AND pg_has_role(actor,datdba,'MEMBER'))
    OR EXISTS (SELECT 1 FROM pg_class WHERE oid=ANY(fact_relations) AND (
        pg_has_role(actor,relowner,'MEMBER') OR has_table_privilege(actor,oid,'TRUNCATE,TRIGGER')))
    OR has_table_privilege(actor,'public."CorrectionApprovedInputItem"','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
    OR has_any_column_privilege(actor,'public."CorrectionApprovedInputItem"','INSERT,UPDATE')
  THEN
    RAISE EXCEPTION 'runtime role may not own or alter correction enforcement objects'
      USING ERRCODE='42501';
  END IF;
  expected_names := ARRAY[
    'correction_application_preparation_receipt_required','correction_pending_lifecycle_check',
    'correction_preparation_lifecycle_check','correction_cleanup_lifecycle_check',
    'cpta_lifecycle_guard','cptae_lifecycle_guard','ctsp_lifecycle_proof_guard','ctsp_lifecycle_batch_guard'];
  SELECT count(*) INTO actual_count FROM pg_trigger
    WHERE tgrelid='public."CorrectionWritePhase"'::regclass AND tgname=ANY(expected_names)
      AND tgenabled='O' AND tgdeferrable AND tginitdeferred
      AND tgfoid='public.r5_correction_phase_terminal()'::regprocedure;
  IF actual_count<>8 OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid='public."CorrectionWritePhase"'::regclass
      AND tgname='r5_phase_row_guard' AND tgenabled='O'
      AND tgfoid='public.r5_correction_phase_row_guard()'::regprocedure
  ) THEN RAISE EXCEPTION 'correction boundary protocol is incomplete' USING ERRCODE='55000'; END IF;
  SELECT count(*) INTO actual_count FROM pg_trigger
    WHERE tgrelid=ANY(fact_relations) AND tgname='aa_r5_phase_write_gate'
      AND tgenabled='O' AND tgtype=31
      AND tgfoid='public.r5_correction_phase_write_guard()'::regprocedure;
  IF actual_count<>cardinality(fact_relations) THEN
    RAISE EXCEPTION 'correction write entrypoint guard is missing' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid=ANY(ARRAY[
      'public."CorrectionWritePhase"'::regclass,'public."CorrectionApprovedInputItem"'::regclass])
      AND NOT relrowsecurity) THEN
    RAISE EXCEPTION 'correction boundary row policies are missing' USING ERRCODE='55000';
  END IF;
END;$$;

CREATE OR REPLACE FUNCTION public.r5_correction_phase_deferred_registered(app_id text) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE b record; wanted text;
BEGIN
  SELECT a."newPostingBatchId",COALESCE((SELECT x.schema_version
      FROM public."CorrectionApprovedInputItem" x
      WHERE x.request_id=q.id AND x.source_revision=q.r5_source_revision
        AND x.kind='segments' AND x.ordinal=0 AND x.complete),
      q."requestedChangeJson"->'schemaVersion') AS schema_version, p."statusCode"
    INTO b FROM public."CorrectionApplication" a
    JOIN public."AttendanceCorrectionRequest" q ON q.id=a."correctionRequestId"
    JOIN public."LedgerPostingBatch" p ON p.id=a."newPostingBatchId" WHERE a.id=app_id;
  IF NOT FOUND OR b.schema_version IS DISTINCT FROM '3'::jsonb THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public."CorrectionSegmentCleanupReceipt" WHERE "applicationId"=app_id) THEN RETURN false; END IF;
  wanted:=CASE WHEN b."statusCode"='committed' THEN 'commit' ELSE 'prepare' END;
  IF NOT EXISTS (SELECT 1 FROM public."CorrectionWritePhase" p WHERE p."applicationId"=app_id
      AND p.phase=wanted AND p.state='SEALED' AND p."transactionId"=pg_current_xact_id()
      AND p."actorOid"=current_user::regrole::oid) THEN
    RAISE EXCEPTION 'V3 detail has no sealed phase terminal obligation' USING ERRCODE='23514';
  END IF;
  -- Registration is not a saved validation verdict. Root constraints execute
  -- complete checks independently, including each explicit IMMEDIATE flush.
  RETURN true;
END;$$;

CREATE OR REPLACE FUNCTION public.r5_correction_phase_row_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a record; q record; b record;
BEGIN
  IF TG_RELID<>'public."CorrectionWritePhase"'::regclass OR TG_OP NOT IN ('INSERT','UPDATE') THEN
    RAISE EXCEPTION 'phase mutation is not permitted' USING ERRCODE='23514';
  END IF;
  PERFORM public.r5_correction_boundary_preflight();
  SELECT id,"correctionRequestId","newPostingBatchId","statusCode" INTO STRICT a
    FROM public."CorrectionApplication" WHERE id=NEW."applicationId";
  SELECT id,"activityId","settlementRunId","statusCode","requestedChangeJson",r5_source_revision INTO STRICT q
    FROM public."AttendanceCorrectionRequest" WHERE id=a."correctionRequestId";
  -- Enforced here as well as through the service: direct INSERT cannot skip locks.
  PERFORM 1 FROM public."Activity" WHERE id=q."activityId" FOR UPDATE;
  PERFORM 1 FROM public."AttendanceSettlementRun" WHERE id=q."settlementRunId" FOR UPDATE;
  SELECT id,"activityId","settlementRunId","statusCode","requestedChangeJson",r5_source_revision INTO STRICT q
    FROM public."AttendanceCorrectionRequest" WHERE id=a."correctionRequestId" FOR UPDATE;
  SELECT id,"correctionRequestId","newPostingBatchId","statusCode" INTO STRICT a
    FROM public."CorrectionApplication" WHERE id=NEW."applicationId" FOR UPDATE;
  SELECT id,"statusCode" INTO STRICT b FROM public."LedgerPostingBatch" WHERE id=a."newPostingBatchId";
  IF q."requestedChangeJson"->'schemaVersion' IS DISTINCT FROM '3'::jsonb THEN
    RAISE EXCEPTION 'phase requires an actual V3 application' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.phase NOT IN ('prepare','commit') OR NEW.state<>'OPEN'
      OR a."statusCode"<>'preparing'
      OR (NEW.phase='prepare' AND (b."statusCode"<>'preparing' OR q."statusCode" NOT IN ('approved','applying')))
      OR (NEW.phase='commit' AND (b."statusCode"<>'ready' OR q."statusCode"<>'applying' OR NOT EXISTS (
        SELECT 1 FROM public."CorrectionWritePhase" p WHERE p."applicationId"=a.id
          AND p.phase='prepare' AND p.state='SEALED' AND p."sourceRevision"=q.r5_source_revision)))
    THEN RAISE EXCEPTION 'phase does not match the database lifecycle' USING ERRCODE='23514'; END IF;
    NEW."batchId":=a."newPostingBatchId"; NEW."requestId":=q.id;
    NEW."sourceRevision":=q.r5_source_revision;
    NEW."transactionId":=pg_current_xact_id(); NEW."actorOid":=current_user::regrole::oid;
    NEW."materializedByUserId":=NULL; NEW."materializedAt":=NULL;
  ELSE
    -- Identity/root bindings remain immutable in every transition.
    IF ROW(NEW."applicationId",NEW.phase,NEW."batchId",NEW."requestId",NEW."sourceRevision",NEW."transactionId",NEW."actorOid")
      IS DISTINCT FROM ROW(OLD."applicationId",OLD.phase,OLD."batchId",OLD."requestId",OLD."sourceRevision",OLD."transactionId",OLD."actorOid")
      OR OLD."transactionId"<>pg_current_xact_id() OR OLD."actorOid"<>current_user::regrole::oid
      OR OLD."sourceRevision" IS DISTINCT FROM q.r5_source_revision
    THEN RAISE EXCEPTION 'phase cannot be reopened, rebound or sealed early' USING ERRCODE='23514'; END IF;
    IF OLD.state='OPEN' AND NEW.state='MATERIALIZED' THEN
      IF NEW.phase<>'commit' OR a."statusCode"<>'preparing'
        OR b."statusCode"<>'ready' OR q."statusCode"<>'applying'
        OR OLD."materializedByUserId" IS NOT NULL OR OLD."materializedAt" IS NOT NULL
        OR NEW."materializedByUserId" IS NULL OR NEW."materializedByUserId"=''
      THEN RAISE EXCEPTION 'phase is not ready for materialization' USING ERRCODE='23514'; END IF;
      -- No caller-supplied time or success flag. The row remains OPEN in the
      -- table during this BEFORE invocation, so the strict original phase
      -- requirement is still used by the fresh whole-set validator.
      NEW."materializedAt":=date_trunc('milliseconds',clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3);
      PERFORM public.r5_correction_assert_materialization_set(
        NEW."applicationId",NEW."materializedByUserId",NEW."materializedAt");
    ELSIF NEW.state='SEALED' AND (OLD.state='OPEN' OR (OLD.state='MATERIALIZED' AND NEW.phase='commit')) THEN
      IF ROW(NEW."materializedByUserId",NEW."materializedAt")
          IS DISTINCT FROM ROW(OLD."materializedByUserId",OLD."materializedAt")
        OR (OLD.state='OPEN' AND (OLD."materializedByUserId" IS NOT NULL OR OLD."materializedAt" IS NOT NULL))
        OR (OLD.state='MATERIALIZED' AND (OLD."materializedByUserId" IS NULL OR OLD."materializedAt" IS NULL))
        OR (NEW.phase='prepare' AND (a."statusCode"<>'preparing' OR b."statusCode"<>'ready' OR q."statusCode"<>'applying'))
        OR (NEW.phase='commit' AND (a."statusCode"<>'committed' OR b."statusCode"<>'committed' OR q."statusCode"<>'applied'))
      THEN RAISE EXCEPTION 'phase cannot be reopened, rebound or sealed early' USING ERRCODE='23514'; END IF;
    ELSE
      RAISE EXCEPTION 'phase cannot be reopened, rebound or sealed early' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;$$;

CREATE OR REPLACE FUNCTION public.r5_correction_phase_terminal() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE p record; a record; q record; b record;
BEGIN
  SELECT * INTO STRICT p FROM public."CorrectionWritePhase"
    WHERE "applicationId"=NEW."applicationId" AND phase=NEW.phase;
  SELECT id,"correctionRequestId","newPostingBatchId","statusCode" INTO STRICT a
    FROM public."CorrectionApplication" WHERE id=p."applicationId";
  SELECT id,"statusCode",r5_source_revision INTO STRICT q
    FROM public."AttendanceCorrectionRequest" WHERE id=a."correctionRequestId";
  SELECT id,"statusCode" INTO STRICT b FROM public."LedgerPostingBatch" WHERE id=a."newPostingBatchId";
  IF p.state<>'SEALED' OR p."transactionId"<>pg_current_xact_id() OR p."actorOid"<>current_user::regrole::oid
    OR p."sourceRevision" IS DISTINCT FROM q.r5_source_revision OR p."batchId"<>b.id OR p."requestId"<>q.id
    OR (p.phase='prepare' AND (a."statusCode"<>'preparing' OR b."statusCode"<>'ready' OR q."statusCode"<>'applying'))
    OR (p.phase='commit' AND (a."statusCode"<>'committed' OR b."statusCode"<>'committed' OR q."statusCode"<>'applied')) THEN
    RAISE EXCEPTION 'incomplete correction phase cannot commit' USING ERRCODE='23514';
  END IF;
  IF TG_NAME LIKE 'correction_%' THEN
    PERFORM public.r5_correction_assert_pending_lifecycle(p."applicationId");
  ELSE
    PERFORM public.ctsp_assert_complete(p."batchId",p.phase='commit');
  END IF;
  RETURN NULL;
END;$$;

CREATE OR REPLACE FUNCTION public.r5_correction_phase_write_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE app_id text; req_id text; batch_id text; wanted text:='prepare'; schema_version jsonb; replacement_count integer; schema_from_unique_replacement boolean:=false; materialized record;
BEGIN

  -- This is INVOKER. The trusted phase BEFORE/preflight runs as the ORIGINAL
  -- caller and fixes the sole M-owned trigger, its bindings and dependencies.
  -- Merely putting SECURITY DEFINER on this guard would invalidate preflight;
  -- current_user=M here is necessary runtime identity, never its own proof.
  IF current_user='r5_mat_writer_20261029_q1' THEN
    IF TG_NAME<>'aa_r5_phase_write_gate' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW'
       OR pg_catalog.pg_trigger_depth()<>2 THEN
      RAISE EXCEPTION 'unexpected controlled fact call' USING ERRCODE='42501';
    END IF;
    IF TG_RELID='public."ParticipantServiceSegmentRevision"'::regclass THEN
      IF TG_OP='UPDATE' THEN
        IF OLD."statusCode" IS DISTINCT FROM 'committed' OR NEW."statusCode" IS DISTINCT FROM 'superseded'
          OR (to_jsonb(NEW)-ARRAY['statusCode','updatedAt']) IS DISTINCT FROM
             (to_jsonb(OLD)-ARRAY['statusCode','updatedAt']) THEN
          RAISE EXCEPTION 'unexpected controlled supersede' USING ERRCODE='55000';
        END IF;
      ELSIF TG_OP='INSERT' THEN
        IF NEW."statusCode" IS DISTINCT FROM 'draft' OR NEW."effectiveBatchId" IS NOT NULL
          OR NEW."baseRevisionId" IS NULL THEN
          RAISE EXCEPTION 'unexpected controlled segment input' USING ERRCODE='55000';
        END IF;
      ELSE RAISE EXCEPTION 'unexpected controlled segment operation' USING ERRCODE='42501'; END IF;
    ELSIF TG_RELID='public."ParticipantTimeAllocationRevision"'::regclass THEN
      IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'unexpected controlled allocation operation' USING ERRCODE='42501'; END IF;
      IF NEW."correctionPendingAllocationId" IS NULL OR NEW."settlementDraftContentHash" IS NOT NULL
        OR NEW."settlementDraftVersionId" IS NOT NULL OR NEW."settlementEvidenceRevision" IS NOT NULL
        OR NEW."settlementEvidenceSealId" IS NOT NULL OR NEW."settlementPopulationRevision" IS NOT NULL
        OR NEW."settlementWorkflowRevision" IS NOT NULL THEN
        RAISE EXCEPTION 'unexpected controlled allocation input' USING ERRCODE='55000'; END IF;
    ELSIF TG_RELID='public."ParticipantTimeAllocationCommandReceipt"'::regclass THEN
      IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'unexpected controlled receipt operation' USING ERRCODE='42501'; END IF;
      IF NEW."operationCode" IS DISTINCT FROM 'recognize_correction_time_allocation' THEN
        RAISE EXCEPTION 'unexpected controlled receipt input' USING ERRCODE='55000'; END IF;
    ELSIF TG_RELID='public."CorrectionTimeAllocationBinding"'::regclass THEN
      IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'unexpected controlled binding operation' USING ERRCODE='42501'; END IF;
    ELSE RAISE EXCEPTION 'unexpected controlled fact relation' USING ERRCODE='42501'; END IF;
    -- The only producer is the fixed writer; full prospective-set validation
    -- preceded it. Existing statement/FK/immutable/final guards still execute.
    RETURN NEW;
  END IF;
  IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'phase facts cannot be truncated' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='CorrectionApplication' THEN
    IF TG_OP='INSERT' THEN RETURN NEW; END IF;
    app_id:=OLD.id;
    IF TG_OP='UPDATE' AND NEW."statusCode"='committed' THEN wanted:='commit'; END IF;
  ELSIF TG_TABLE_NAME='AttendanceCorrectionRequest' THEN
    IF TG_OP='INSERT' THEN RETURN NEW; END IF;
    req_id:=OLD.id;
    SELECT id INTO app_id FROM public."CorrectionApplication" WHERE "correctionRequestId"=req_id
      ORDER BY "createdAt" DESC,id LIMIT 1;
    IF TG_OP='UPDATE' AND NEW."statusCode"='applied' THEN wanted:='commit'; END IF;
  ELSIF TG_TABLE_NAME='LedgerPostingBatch' THEN
    IF TG_OP='INSERT' THEN RETURN NEW; END IF;
    batch_id:=OLD.id;
    SELECT id INTO app_id FROM public."CorrectionApplication" WHERE "newPostingBatchId"=batch_id;
    IF TG_OP='UPDATE' AND NEW."statusCode"='committed' THEN wanted:='commit'; END IF;
  ELSIF TG_TABLE_NAME IN ('CorrectionPendingSegmentRevision','CorrectionSegmentPreparationReceipt','CorrectionSegmentCleanupReceipt','CorrectionPendingTimeAllocation','CorrectionTimeSourceProof') THEN
    IF TG_OP='DELETE' THEN app_id:=OLD."applicationId"; ELSE app_id:=NEW."applicationId"; END IF;
  ELSIF TG_TABLE_NAME='CorrectionPendingTimeAllocationEvidence' THEN
    SELECT "applicationId" INTO app_id FROM public."CorrectionPendingTimeAllocation"
      WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD."pendingAllocationId" ELSE NEW."pendingAllocationId" END;
  ELSIF TG_TABLE_NAME='CorrectionTimeAllocationBinding' THEN
    SELECT "applicationId" INTO app_id FROM public."CorrectionTimeSourceProof"
      WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD."proofId" ELSE NEW."proofId" END;
    wanted:='commit';
  ELSIF TG_TABLE_NAME='ParticipationTimeCorrectionManifest' THEN
    SELECT id INTO app_id FROM public."CorrectionApplication"
      WHERE "newPostingBatchId"=CASE WHEN TG_OP='DELETE' THEN OLD."postingBatchId" ELSE NEW."postingBatchId" END;
  ELSIF TG_TABLE_NAME='ParticipantServiceSegmentRevision' THEN
    -- Materialized draft rows do not have effectiveBatchId yet. Bind them by
    -- the UNIQUE targetSegmentRevisionId reserved by the pending allocation.
    IF TG_OP='UPDATE' AND OLD."statusCode"='committed' AND NEW."statusCode"='superseded' THEN
      -- Superseding an old V3 result belongs to the NEW replacement phase,
      -- never to the sealed historical phase which originally produced it.
      SELECT count(*),min(a.id) INTO replacement_count,app_id
        FROM public."CorrectionPendingSegmentRevision" p
        JOIN public."CorrectionApplication" a ON a.id=p."applicationId"
        JOIN public."AttendanceCorrectionRequest" q ON q.id=a."correctionRequestId"
        WHERE p."baseRevisionId"=OLD.id AND a."statusCode"='preparing'
          AND COALESCE((SELECT x.schema_version FROM public."CorrectionApprovedInputItem" x
            WHERE x.request_id=q.id AND x.source_revision=q.r5_source_revision
              AND x.kind='segments' AND x.ordinal=0 AND x.complete),
            q."requestedChangeJson"->'schemaVersion')='3'::jsonb;
      IF replacement_count>1 THEN
        RAISE EXCEPTION 'ambiguous active V3 replacement' USING ERRCODE='23514';
      END IF;
      -- Per-invocation context only: the identical raw schema predicate above
      -- has already selected the one replacement. The real phase helper below
      -- is still invoked; there is no saved cross-call validation result.
      IF replacement_count=1 THEN
        schema_version:='3'::jsonb; schema_from_unique_replacement:=true;
      END IF;
    ELSE
      SELECT "applicationId" INTO app_id FROM public."CorrectionPendingTimeAllocation"
        WHERE "targetSegmentRevisionId"=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
    END IF;
    wanted:='commit';
  ELSIF TG_TABLE_NAME='ParticipantTimeAllocationRevision' THEN
    SELECT "applicationId" INTO app_id FROM public."CorrectionPendingTimeAllocation"
      WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD."correctionPendingAllocationId" ELSE NEW."correctionPendingAllocationId" END;
    wanted:='commit';
  ELSIF TG_TABLE_NAME='ParticipantTimeAllocationCommandReceipt' THEN
    SELECT p."applicationId" INTO app_id FROM public."ParticipantTimeAllocationRevision" a
      JOIN public."CorrectionPendingTimeAllocation" p ON p.id=a."correctionPendingAllocationId"
      WHERE a.id=CASE WHEN TG_OP='DELETE' THEN OLD."allocationRevisionId" ELSE NEW."allocationRevisionId" END;
    wanted:='commit';
  ELSE RAISE EXCEPTION 'unexpected phase guard relation' USING ERRCODE='55000'; END IF;
  IF app_id IS NULL THEN
    -- Original FK/chain guards still reject malformed or invisible anchors.
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  -- The protected source header carries raw schemaVersion from the same source
  -- revision. Do not reparse the whole approved document per attempted row.
  -- Missing/invisible/incomplete projection keeps the original source fallback.
  IF NOT schema_from_unique_replacement THEN
  SELECT COALESCE((SELECT x.schema_version FROM public."CorrectionApprovedInputItem" x
      WHERE x.request_id=q.id AND x.source_revision=q.r5_source_revision
        AND x.kind='segments' AND x.ordinal=0 AND x.complete),
      q."requestedChangeJson"->'schemaVersion') INTO schema_version
    FROM public."CorrectionApplication" a JOIN public."AttendanceCorrectionRequest" q ON q.id=a."correctionRequestId"
    WHERE a.id=app_id;
  END IF;
  IF schema_version IS DISTINCT FROM '3'::jsonb THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  -- Separate statements are necessary: each trigger relation has a different
  -- RECORD shape. Boolean short-circuiting does not provide a field binding.
  IF TG_OP='UPDATE' THEN
    IF TG_TABLE_NAME='CorrectionApplication' THEN
      IF ROW(NEW.id,NEW."correctionRequestId",NEW."newPostingBatchId",NEW."newSettlementVersionId",NEW."newResultRevisionIds")
        IS DISTINCT FROM ROW(OLD.id,OLD."correctionRequestId",OLD."newPostingBatchId",OLD."newSettlementVersionId",OLD."newResultRevisionIds") THEN
        RAISE EXCEPTION 'V3 application anchors are immutable' USING ERRCODE='23514';
      END IF;
    ELSIF TG_TABLE_NAME='AttendanceCorrectionRequest' THEN
      IF ROW(NEW.id,NEW."requestedChangeJson") IS DISTINCT FROM ROW(OLD.id,OLD."requestedChangeJson") THEN
        RAISE EXCEPTION 'existing V3 application cannot be given different approved input' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  IF TG_TABLE_NAME='CorrectionSegmentCleanupReceipt' OR
    (TG_TABLE_NAME='CorrectionPendingSegmentRevision' AND TG_OP='DELETE' AND EXISTS (
      SELECT 1 FROM public."CorrectionSegmentCleanupReceipt" WHERE "applicationId"=app_id)) THEN
    -- The original operator routine, exact receipt check and 2000 limit stay active.
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  -- A MATERIALIZED phase admits only the four original terminal UPDATEs.
  -- The OPEN-only helper below remains unchanged for every other write.
  IF TG_OP='UPDATE' AND wanted='commit' THEN
    SELECT p.* INTO materialized FROM public."CorrectionWritePhase" p
      JOIN public."CorrectionApplication" a ON a.id=p."applicationId" AND a."newPostingBatchId"=p."batchId"
      JOIN public."AttendanceCorrectionRequest" q ON q.id=a."correctionRequestId" AND q.id=p."requestId"
      WHERE p."applicationId"=app_id AND p.phase='commit' AND p.state='MATERIALIZED'
        AND p."transactionId"=pg_current_xact_id() AND p."actorOid"=current_user::regrole::oid
        AND p."sourceRevision"=q.r5_source_revision
        AND p."materializedAt" IS NOT NULL AND p."materializedByUserId" IS NOT NULL;
    IF FOUND THEN
      IF TG_RELID='public."ParticipantServiceSegmentRevision"'::regclass THEN
        IF OLD."statusCode" IS DISTINCT FROM 'draft' OR NEW."statusCode" IS DISTINCT FROM 'committed'
          OR OLD."effectiveBatchId" IS NOT NULL OR NEW."effectiveBatchId" IS DISTINCT FROM materialized."batchId"
          OR (to_jsonb(NEW)-ARRAY['statusCode','effectiveBatchId','updatedAt']) IS DISTINCT FROM
             (to_jsonb(OLD)-ARRAY['statusCode','effectiveBatchId','updatedAt'])
          OR NOT EXISTS (SELECT 1 FROM public."CorrectionPendingTimeAllocation" p
            WHERE p."applicationId"=app_id AND p."targetSegmentRevisionId"=NEW.id)
        THEN RAISE EXCEPTION 'invalid materialized segment publication' USING ERRCODE='23514'; END IF;
      ELSIF TG_RELID='public."LedgerPostingBatch"'::regclass THEN
        IF NEW.id IS DISTINCT FROM materialized."batchId" OR OLD."statusCode" IS DISTINCT FROM 'ready'
          OR NEW."statusCode" IS DISTINCT FROM 'committed' OR NEW."committedAt" IS NULL
          OR NEW."committedByUserId" IS DISTINCT FROM materialized."materializedByUserId"
          OR NEW.version IS DISTINCT FROM OLD.version+1
          OR (to_jsonb(NEW)-ARRAY['statusCode','committedAt','committedByUserId','version','updatedAt']) IS DISTINCT FROM
             (to_jsonb(OLD)-ARRAY['statusCode','committedAt','committedByUserId','version','updatedAt'])
        THEN RAISE EXCEPTION 'invalid materialized batch publication' USING ERRCODE='23514'; END IF;
      ELSIF TG_RELID='public."CorrectionApplication"'::regclass THEN
        IF NEW.id IS DISTINCT FROM materialized."applicationId" OR OLD."statusCode" IS DISTINCT FROM 'preparing'
          OR NEW."statusCode" IS DISTINCT FROM 'committed'
          OR (to_jsonb(NEW)-ARRAY['statusCode','updatedAt']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['statusCode','updatedAt'])
        THEN RAISE EXCEPTION 'invalid materialized application publication' USING ERRCODE='23514'; END IF;
      ELSIF TG_RELID='public."AttendanceCorrectionRequest"'::regclass THEN
        IF NEW.id IS DISTINCT FROM materialized."requestId" OR OLD."statusCode" IS DISTINCT FROM 'applying'
          OR NEW."statusCode" IS DISTINCT FROM 'applied' OR NEW.version IS DISTINCT FROM OLD.version+1
          OR (to_jsonb(NEW)-ARRAY['statusCode','version','updatedAt']) IS DISTINCT FROM
             (to_jsonb(OLD)-ARRAY['statusCode','version','updatedAt'])
        THEN RAISE EXCEPTION 'invalid materialized request publication' USING ERRCODE='23514'; END IF;
      ELSE RAISE EXCEPTION 'materialized phase permits no new facts' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END IF;
  END IF;

  PERFORM public.r5_correction_require_open_phase(app_id,wanted);
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;$$;

CREATE OR REPLACE FUNCTION public.r5_correction_require_open_phase(app_id text, wanted_phase text) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."CorrectionWritePhase" p
    JOIN public."CorrectionApplication" a ON a.id=p."applicationId" AND a."newPostingBatchId"=p."batchId"
    JOIN public."AttendanceCorrectionRequest" q ON q.id=a."correctionRequestId" AND q.id=p."requestId"
    WHERE p."applicationId"=app_id AND p.phase=wanted_phase AND p.state='OPEN'
      AND p."transactionId"=pg_current_xact_id() AND p."actorOid"=current_user::regrole::oid
      AND p."sourceRevision"=q.r5_source_revision)
  THEN RAISE EXCEPTION 'write requires this transaction and actor open phase' USING ERRCODE='23514'; END IF;
END;$$;

CREATE OR REPLACE FUNCTION public.r5_correction_seal_phase(app_id text, wanted_phase text)
RETURNS TABLE("applicationId" text,phase text,"batchId" text,state text,"protocolVersion" integer)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  PERFORM public.r5_correction_boundary_preflight();
  RETURN QUERY UPDATE public."CorrectionWritePhase" AS p SET state='SEALED'
    WHERE p."applicationId"=app_id AND p.phase=wanted_phase
      AND (p.state='OPEN' OR (wanted_phase='commit' AND p.state='MATERIALIZED'))
      AND p."transactionId"=pg_current_xact_id() AND p."actorOid"=current_user::regrole::oid
    RETURNING p."applicationId",p.phase,p."batchId",p.state,1;
  IF NOT FOUND THEN RAISE EXCEPTION 'no current open correction phase' USING ERRCODE='23514'; END IF;
END;$$;

CREATE OR REPLACE FUNCTION public.r5_sync_approved_input_items() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
DECLARE eligible boolean; member_kind text;
BEGIN
 IF TG_RELID<>'public."AttendanceCorrectionRequest"'::regclass OR TG_OP NOT IN('INSERT','UPDATE','DELETE') THEN
  RAISE EXCEPTION 'wrong source relation' USING ERRCODE='42501';END IF;
 BEGIN
  IF TG_OP='UPDATE' AND OLD.id IS NOT DISTINCT FROM NEW.id
    AND OLD.r5_source_revision IS NOT DISTINCT FROM NEW.r5_source_revision THEN RETURN NULL; END IF;
  IF TG_OP='DELETE' THEN
   DELETE FROM public."CorrectionApprovedInputItem" WHERE request_id=OLD.id;RETURN NULL;END IF;
  IF TG_OP='UPDATE' AND OLD.id IS DISTINCT FROM NEW.id THEN
   DELETE FROM public."CorrectionApprovedInputItem" WHERE request_id=OLD.id;END IF;
  DELETE FROM public."CorrectionApprovedInputItem" WHERE request_id=NEW.id;
  FOREACH member_kind IN ARRAY ARRAY['segments','allocations']::text[] LOOP
   INSERT INTO public."CorrectionApprovedInputItem"(request_id,source_revision,kind,ordinal,complete,safe,schema_version,item_count)
    VALUES(NEW.id,NEW.r5_source_revision,member_kind,0,false,false,NEW."requestedChangeJson"->'schemaVersion',NULL);
   IF jsonb_typeof(NEW."requestedChangeJson"->member_kind) IS DISTINCT FROM 'array' THEN
    UPDATE public."CorrectionApprovedInputItem" SET complete=true WHERE request_id=NEW.id AND kind=member_kind AND ordinal=0;
    CONTINUE;
   END IF;
   INSERT INTO public."CorrectionApprovedInputItem"(request_id,source_revision,kind,ordinal,complete,safe,raw_item)
    SELECT NEW.id,NEW.r5_source_revision,member_kind,n::integer,false,false,c
    FROM jsonb_array_elements(NEW."requestedChangeJson"->member_kind) WITH ORDINALITY s(c,n);
   UPDATE public."CorrectionApprovedInputItem" SET item_count=jsonb_array_length(NEW."requestedChangeJson"->member_kind)
    WHERE request_id=NEW.id AND kind=member_kind AND ordinal=0;
   IF member_kind='segments' THEN
  SELECT bool_and(coalesce(
   jsonb_typeof(c)='object'
   AND jsonb_typeof(c->'participationIdentityId')='string'
   AND jsonb_typeof(c->'segmentKey')='string'
   AND jsonb_typeof(c->'resultCode')='string'
   AND jsonb_typeof(c->'serviceHours')='string'
   AND jsonb_typeof(c->'checkInAt')='string'
   AND jsonb_typeof(c->'checkOutAt')='string'
   AND octet_length(c->>'participationIdentityId')<=256
   AND octet_length(c->>'segmentKey')<=256 AND octet_length(c->>'resultCode')<=256
   AND (c->>'serviceHours') ~ '^[+-]?[0-9]+([.][0-9]+)?$'
   AND (c->>'checkInAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?Z$'
   AND (c->>'checkOutAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?Z$'
   AND pg_input_is_valid(c->>'serviceHours','numeric')
   AND pg_input_is_valid(c->>'checkInAt','timestamp with time zone')
   AND pg_input_is_valid(c->>'checkOutAt','timestamp with time zone'),false)) INTO eligible
   FROM public."CorrectionApprovedInputItem" x CROSS JOIN LATERAL(SELECT x.raw_item AS c) raw
   WHERE x.request_id=NEW.id AND x.kind=member_kind AND x.ordinal>0;

   ELSE
    SELECT bool_and(coalesce(jsonb_typeof(x.raw_item)='object'
      AND jsonb_typeof(x.raw_item->'participationIdentityId')='string'
      AND jsonb_typeof(x.raw_item->'segmentKey')='string'
      AND octet_length(x.raw_item->>'participationIdentityId')<=256
      AND octet_length(x.raw_item->>'segmentKey')<=256
      AND jsonb_typeof(x.raw_item->'slices')='array',false)) INTO eligible
     FROM public."CorrectionApprovedInputItem" x
     WHERE x.request_id=NEW.id AND x.kind=member_kind AND x.ordinal>0;
   END IF;
   IF eligible IS FALSE THEN
    DELETE FROM public."CorrectionApprovedInputItem" WHERE request_id=NEW.id AND kind=member_kind AND ordinal>0;
    UPDATE public."CorrectionApprovedInputItem" SET complete=true,safe=false WHERE request_id=NEW.id AND kind=member_kind AND ordinal=0;
    CONTINUE;
   END IF;
   UPDATE public."CorrectionApprovedInputItem" SET pid=raw_item->>'participationIdentityId',
    skey=raw_item->>'segmentKey',result=CASE WHEN member_kind='segments' THEN raw_item->>'resultCode' ELSE NULL END
    WHERE request_id=NEW.id AND kind=member_kind AND ordinal>0;
   UPDATE public."CorrectionApprovedInputItem" SET complete=true,safe=true
    WHERE request_id=NEW.id AND kind=member_kind AND ordinal=0;
  END LOOP;
 EXCEPTION WHEN OTHERS THEN
  -- Same prior recoverable storage-failure behavior: revision mismatch or
  -- missing header leaves the original matcher authoritative.
  RETURN NULL;
 END;
 RETURN NULL;
END;$_$;

CREATE OR REPLACE FUNCTION public.r5_correction_assert_materialization_set(
  application_id text, actor_user_id text, materialized_at timestamp without time zone
) RETURNS void LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $assert_set$
DECLARE a record; q record; proof record; n integer; delta integer; expected_slices integer;
  -- Exact half of the smallest positive IEEE754 double; ties round to zero.
  js_zero_half CONSTANT numeric := 2.4703282292062327208828439643411068618252990130716238221279284125033775363510437593264991818081799618989828234772285886546332835517796989819938739800539093906315035659515570226392290858392449105184435931802849936536152500319370457678249219365623669863658480757001585769269903706311928279558551332927834338409351978015531246597263579574622766465272827220056374006485499977096599470454020828166226237857393450736339007967761930577506740176324673600968951340535537458516661134223766678604162159680461914467291840300530057530849048765391711386591646239524912623653881879636239373280423891018672348497668235089863388587925628302755995657524455507255189313690836254779186948667994968324049705821028513185451396213837722826145437693412532098591327667236328125E-324;
BEGIN
  PERFORM public.r5_correction_boundary_preflight();
  PERFORM public.r5_correction_require_open_phase(application_id,'commit');
  -- No new early FOR SHARE locks: original root locks are already held by the
  -- phase BEFORE guard. Allocation/receipt/binding anchors retain their own
  -- original statement-guard lock order after the first supersede UPDATE.
  SELECT * INTO STRICT a FROM public."CorrectionApplication" WHERE id=application_id;
  SELECT * INTO STRICT q FROM public."AttendanceCorrectionRequest" WHERE id=a."correctionRequestId";
  SELECT * INTO proof FROM public."CorrectionTimeSourceProof" WHERE "applicationId"=application_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'V3 correction source proof is missing' USING ERRCODE='P5C01'; END IF;
  IF actor_user_id IS NULL OR materialized_at IS NULL
    OR a."statusCode"<>'preparing' OR q."statusCode"<>'applying'
    OR q."requestedChangeJson"->'schemaVersion' IS DISTINCT FROM '3'::jsonb
    OR proof."activityId" IS DISTINCT FROM q."activityId"
    OR proof."postingBatchId" IS DISTINCT FROM a."newPostingBatchId"
  THEN RAISE EXCEPTION 'invalid materialization anchors' USING ERRCODE='P5C01'; END IF;
  -- actor_user_id is data from the existing authenticated service. PostgreSQL
  -- does not turn this identifier into a business permission or end-user login.
  IF pg_catalog.jsonb_typeof(proof."sourceSnapshotJson") IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_typeof(q."requestedChangeJson"->'segments') IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_typeof(q."requestedChangeJson"->'allocations') IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'source or approved input is not an array' USING ERRCODE='P5C01'; END IF;

  -- Strict source parsing BEFORE conversions. AND is not used as a cast guard;
  -- conversion-bearing predicates use explicit CASE expressions.
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(proof."sourceSnapshotJson") s(raw)
    WHERE NOT (CASE WHEN pg_catalog.jsonb_typeof(s.raw)='object' THEN
      (pg_catalog.jsonb_typeof(s.raw)='object' AND s.raw ?& ARRAY['participationIdentityId','segmentKey','baseSegmentRevisionId','baseSegmentRevision','sourceSegmentId','sourceSegmentRevision','baseAllocationRevisionId','allocationRevisionId','allocationRevision','pendingAllocationId','ruleSnapshotId','ruleSnapshotHash','timePolicySelectionRevisionId','selectionHash','policyId','policyVersionId','definitionHash','evaluatorVersion','recognitionModeCode','manualReason','allocationHash','sliceCount','slices','sourceHash'] AND (s.raw-ARRAY['participationIdentityId','segmentKey','baseSegmentRevisionId','baseSegmentRevision','sourceSegmentId','sourceSegmentRevision','baseAllocationRevisionId','allocationRevisionId','allocationRevision','pendingAllocationId','ruleSnapshotId','ruleSnapshotHash','timePolicySelectionRevisionId','selectionHash','policyId','policyVersionId','definitionHash','evaluatorVersion','recognitionModeCode','manualReason','allocationHash','sliceCount','slices','sourceHash'])='{}'::jsonb)
      AND (CASE WHEN pg_catalog.jsonb_typeof((s.raw->'participationIdentityId'))='string' THEN pg_catalog.btrim((s.raw->'participationIdentityId')#>>'{}',U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')<>'' AND pg_catalog.length((s.raw->'participationIdentityId')#>>'{}')+pg_catalog.regexp_count((s.raw->'participationIdentityId')#>>'{}',U&'[\+010000-\+10FFFF]')<=128 ELSE false END)
      AND (CASE WHEN pg_catalog.jsonb_typeof((s.raw->'segmentKey'))='string' THEN pg_catalog.btrim((s.raw->'segmentKey')#>>'{}',U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')<>'' AND pg_catalog.length((s.raw->'segmentKey')#>>'{}')+pg_catalog.regexp_count((s.raw->'segmentKey')#>>'{}',U&'[\+010000-\+10FFFF]')<=128 ELSE false END)
      AND (CASE WHEN pg_catalog.jsonb_typeof((s.raw->'baseSegmentRevisionId'))='string' THEN pg_catalog.btrim((s.raw->'baseSegmentRevisionId')#>>'{}',U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')<>'' AND pg_catalog.length((s.raw->'baseSegmentRevisionId')#>>'{}')+pg_catalog.regexp_count((s.raw->'baseSegmentRevisionId')#>>'{}',U&'[\+010000-\+10FFFF]')<=128 ELSE false END)
      AND (CASE WHEN pg_catalog.jsonb_typeof((s.raw->'sourceSegmentId'))='string' THEN pg_catalog.btrim((s.raw->'sourceSegmentId')#>>'{}',U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')<>'' AND pg_catalog.length((s.raw->'sourceSegmentId')#>>'{}')+pg_catalog.regexp_count((s.raw->'sourceSegmentId')#>>'{}',U&'[\+010000-\+10FFFF]')<=128 ELSE false END)
      AND (CASE WHEN pg_catalog.jsonb_typeof((s.raw->'baseAllocationRevisionId'))='string' THEN pg_catalog.btrim((s.raw->'baseAllocationRevisionId')#>>'{}',U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')<>'' AND pg_catalog.length((s.raw->'baseAllocationRevisionId')#>>'{}')+pg_catalog.regexp_count((s.raw->'baseAllocationRevisionId')#>>'{}',U&'[\+010000-\+10FFFF]')<=128 ELSE false END)
      AND (CASE WHEN pg_catalog.jsonb_typeof((s.raw->'allocationRevisionId'))='string' THEN pg_catalog.btrim((s.raw->'allocationRevisionId')#>>'{}',U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')<>'' AND pg_catalog.length((s.raw->'allocationRevisionId')#>>'{}')+pg_catalog.regexp_count((s.raw->'allocationRevisionId')#>>'{}',U&'[\+010000-\+10FFFF]')<=128 ELSE false END)
      AND (CASE WHEN pg_catalog.jsonb_typeof((s.raw->'ruleSnapshotId'))='string' THEN pg_catalog.btrim((s.raw->'ruleSnapshotId')#>>'{}',U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')<>'' AND pg_catalog.length((s.raw->'ruleSnapshotId')#>>'{}')+pg_catalog.regexp_count((s.raw->'ruleSnapshotId')#>>'{}',U&'[\+010000-\+10FFFF]')<=128 ELSE false END)
      AND (CASE WHEN pg_catalog.jsonb_typeof((s.raw->'timePolicySelectionRevisionId'))='string' THEN pg_catalog.btrim((s.raw->'timePolicySelectionRevisionId')#>>'{}',U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')<>'' AND pg_catalog.length((s.raw->'timePolicySelectionRevisionId')#>>'{}')+pg_catalog.regexp_count((s.raw->'timePolicySelectionRevisionId')#>>'{}',U&'[\+010000-\+10FFFF]')<=128 ELSE false END)
      AND (CASE WHEN pg_catalog.jsonb_typeof((s.raw->'policyId'))='string' THEN pg_catalog.btrim((s.raw->'policyId')#>>'{}',U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')<>'' AND pg_catalog.length((s.raw->'policyId')#>>'{}')+pg_catalog.regexp_count((s.raw->'policyId')#>>'{}',U&'[\+010000-\+10FFFF]')<=128 ELSE false END)
      AND (CASE WHEN pg_catalog.jsonb_typeof((s.raw->'policyVersionId'))='string' THEN pg_catalog.btrim((s.raw->'policyVersionId')#>>'{}',U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')<>'' AND pg_catalog.length((s.raw->'policyVersionId')#>>'{}')+pg_catalog.regexp_count((s.raw->'policyVersionId')#>>'{}',U&'[\+010000-\+10FFFF]')<=128 ELSE false END)
      AND (CASE WHEN pg_catalog.jsonb_typeof(s.raw->'ruleSnapshotHash')='string' THEN (s.raw->>'ruleSnapshotHash') ~ '^[a-f0-9]{64}$' ELSE false END)
      AND (CASE WHEN pg_catalog.jsonb_typeof(s.raw->'selectionHash')='string' THEN (s.raw->>'selectionHash') ~ '^[a-f0-9]{64}$' ELSE false END)
      AND (CASE WHEN pg_catalog.jsonb_typeof(s.raw->'definitionHash')='string' THEN (s.raw->>'definitionHash') ~ '^[a-f0-9]{64}$' ELSE false END)
      AND (CASE WHEN pg_catalog.jsonb_typeof(s.raw->'allocationHash')='string' THEN (s.raw->>'allocationHash') ~ '^[a-f0-9]{64}$' ELSE false END)
      AND (CASE WHEN pg_catalog.jsonb_typeof(s.raw->'sourceHash')='string' THEN (s.raw->>'sourceHash') ~ '^[a-f0-9]{64}$' ELSE false END)
      AND (CASE WHEN pg_catalog.jsonb_typeof((s.raw->'baseSegmentRevision'))='number' THEN CASE WHEN pg_catalog.abs(((s.raw->'baseSegmentRevision')#>>'{}')::numeric)<=js_zero_half THEN 0 BETWEEN 1 AND 2147483647 WHEN pg_catalog.abs(((s.raw->'baseSegmentRevision')#>>'{}')::numeric)<0.5 THEN false WHEN ((s.raw->'baseSegmentRevision')#>>'{}')::numeric BETWEEN 0 AND 2147483648 THEN (CASE WHEN pg_catalog.abs(((s.raw->'baseSegmentRevision')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((s.raw->'baseSegmentRevision')#>>'{}')::numeric)::double precision END) BETWEEN 1 AND 2147483647 AND pg_catalog.trunc((CASE WHEN pg_catalog.abs(((s.raw->'baseSegmentRevision')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((s.raw->'baseSegmentRevision')#>>'{}')::numeric)::double precision END))=(CASE WHEN pg_catalog.abs(((s.raw->'baseSegmentRevision')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((s.raw->'baseSegmentRevision')#>>'{}')::numeric)::double precision END) ELSE false END ELSE false END)
      AND (CASE WHEN pg_catalog.jsonb_typeof((s.raw->'sourceSegmentRevision'))='number' THEN CASE WHEN pg_catalog.abs(((s.raw->'sourceSegmentRevision')#>>'{}')::numeric)<=js_zero_half THEN 0 BETWEEN 1 AND 2147483647 WHEN pg_catalog.abs(((s.raw->'sourceSegmentRevision')#>>'{}')::numeric)<0.5 THEN false WHEN ((s.raw->'sourceSegmentRevision')#>>'{}')::numeric BETWEEN 0 AND 2147483648 THEN (CASE WHEN pg_catalog.abs(((s.raw->'sourceSegmentRevision')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((s.raw->'sourceSegmentRevision')#>>'{}')::numeric)::double precision END) BETWEEN 1 AND 2147483647 AND pg_catalog.trunc((CASE WHEN pg_catalog.abs(((s.raw->'sourceSegmentRevision')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((s.raw->'sourceSegmentRevision')#>>'{}')::numeric)::double precision END))=(CASE WHEN pg_catalog.abs(((s.raw->'sourceSegmentRevision')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((s.raw->'sourceSegmentRevision')#>>'{}')::numeric)::double precision END) ELSE false END ELSE false END)
      AND (CASE WHEN pg_catalog.jsonb_typeof((s.raw->'allocationRevision'))='number' THEN CASE WHEN pg_catalog.abs(((s.raw->'allocationRevision')#>>'{}')::numeric)<=js_zero_half THEN 0 BETWEEN 0 AND 2147483647 WHEN pg_catalog.abs(((s.raw->'allocationRevision')#>>'{}')::numeric)<0.5 THEN false WHEN ((s.raw->'allocationRevision')#>>'{}')::numeric BETWEEN -1 AND 2147483648 THEN (CASE WHEN pg_catalog.abs(((s.raw->'allocationRevision')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((s.raw->'allocationRevision')#>>'{}')::numeric)::double precision END) BETWEEN 0 AND 2147483647 AND pg_catalog.trunc((CASE WHEN pg_catalog.abs(((s.raw->'allocationRevision')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((s.raw->'allocationRevision')#>>'{}')::numeric)::double precision END))=(CASE WHEN pg_catalog.abs(((s.raw->'allocationRevision')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((s.raw->'allocationRevision')#>>'{}')::numeric)::double precision END) ELSE false END ELSE false END)
      AND (CASE WHEN pg_catalog.jsonb_typeof((s.raw->'evaluatorVersion'))='number' THEN CASE WHEN pg_catalog.abs(((s.raw->'evaluatorVersion')#>>'{}')::numeric)<=js_zero_half THEN 0 BETWEEN 0 AND 2147483647 WHEN pg_catalog.abs(((s.raw->'evaluatorVersion')#>>'{}')::numeric)<0.5 THEN false WHEN ((s.raw->'evaluatorVersion')#>>'{}')::numeric BETWEEN -1 AND 2147483648 THEN (CASE WHEN pg_catalog.abs(((s.raw->'evaluatorVersion')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((s.raw->'evaluatorVersion')#>>'{}')::numeric)::double precision END) BETWEEN 0 AND 2147483647 AND pg_catalog.trunc((CASE WHEN pg_catalog.abs(((s.raw->'evaluatorVersion')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((s.raw->'evaluatorVersion')#>>'{}')::numeric)::double precision END))=(CASE WHEN pg_catalog.abs(((s.raw->'evaluatorVersion')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((s.raw->'evaluatorVersion')#>>'{}')::numeric)::double precision END) ELSE false END ELSE false END)
      AND (CASE WHEN pg_catalog.jsonb_typeof((s.raw->'sliceCount'))='number' THEN CASE WHEN pg_catalog.abs(((s.raw->'sliceCount')#>>'{}')::numeric)<=js_zero_half THEN 0 BETWEEN 0 AND 500 WHEN pg_catalog.abs(((s.raw->'sliceCount')#>>'{}')::numeric)<0.5 THEN false WHEN ((s.raw->'sliceCount')#>>'{}')::numeric BETWEEN -1 AND 501 THEN (CASE WHEN pg_catalog.abs(((s.raw->'sliceCount')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((s.raw->'sliceCount')#>>'{}')::numeric)::double precision END) BETWEEN 0 AND 500 AND pg_catalog.trunc((CASE WHEN pg_catalog.abs(((s.raw->'sliceCount')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((s.raw->'sliceCount')#>>'{}')::numeric)::double precision END))=(CASE WHEN pg_catalog.abs(((s.raw->'sliceCount')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((s.raw->'sliceCount')#>>'{}')::numeric)::double precision END) ELSE false END ELSE false END)
      AND ((s.raw->'pendingAllocationId'='null'::jsonb OR (CASE WHEN pg_catalog.jsonb_typeof((s.raw->'pendingAllocationId'))='string' THEN pg_catalog.btrim((s.raw->'pendingAllocationId')#>>'{}',U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')<>'' AND pg_catalog.length((s.raw->'pendingAllocationId')#>>'{}')+pg_catalog.regexp_count((s.raw->'pendingAllocationId')#>>'{}',U&'[\+010000-\+10FFFF]')<=128 ELSE false END)))
      AND (s.raw->>'recognitionModeCode' IN ('automatic','manual') AND pg_catalog.jsonb_typeof(s.raw->'recognitionModeCode')='string')
      AND (pg_catalog.jsonb_typeof(s.raw->'manualReason') IN ('null','string'))
      AND (CASE WHEN pg_catalog.jsonb_typeof(s.raw->'slices')='array' THEN pg_catalog.jsonb_array_length(s.raw->'slices')<=500 AND (CASE WHEN (CASE WHEN pg_catalog.jsonb_typeof((s.raw->'sliceCount'))='number' THEN CASE WHEN pg_catalog.abs(((s.raw->'sliceCount')#>>'{}')::numeric)<=js_zero_half THEN 0 BETWEEN 0 AND 500 WHEN pg_catalog.abs(((s.raw->'sliceCount')#>>'{}')::numeric)<0.5 THEN false WHEN ((s.raw->'sliceCount')#>>'{}')::numeric BETWEEN -1 AND 501 THEN (CASE WHEN pg_catalog.abs(((s.raw->'sliceCount')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((s.raw->'sliceCount')#>>'{}')::numeric)::double precision END) BETWEEN 0 AND 500 AND pg_catalog.trunc((CASE WHEN pg_catalog.abs(((s.raw->'sliceCount')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((s.raw->'sliceCount')#>>'{}')::numeric)::double precision END))=(CASE WHEN pg_catalog.abs(((s.raw->'sliceCount')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((s.raw->'sliceCount')#>>'{}')::numeric)::double precision END) ELSE false END ELSE false END) THEN ((CASE WHEN pg_catalog.abs(((s.raw->'sliceCount')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((s.raw->'sliceCount')#>>'{}')::numeric)::double precision END))::integer=(pg_catalog.jsonb_array_length(s.raw->'slices')) ELSE false END) ELSE false END) ELSE false END) IS TRUE)
  THEN RAISE EXCEPTION 'invalid complete source shape' USING ERRCODE='P5C01'; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(proof."sourceSnapshotJson") s(raw)
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(s.raw->'slices') WITH ORDINALITY z(raw,ord)
    WHERE NOT (CASE WHEN pg_catalog.jsonb_typeof(z.raw)='object' THEN
      (pg_catalog.jsonb_typeof(z.raw)='object' AND z.raw ?& ARRAY['ordinal','categoryCode','intervalKindCode','startAt','endAt'] AND (z.raw-ARRAY['ordinal','categoryCode','intervalKindCode','startAt','endAt'])='{}'::jsonb)
      AND (CASE WHEN pg_catalog.jsonb_typeof((z.raw->'ordinal'))='number' THEN CASE WHEN pg_catalog.abs(((z.raw->'ordinal')#>>'{}')::numeric)<=js_zero_half THEN 0 BETWEEN 0 AND 500 WHEN pg_catalog.abs(((z.raw->'ordinal')#>>'{}')::numeric)<0.5 THEN false WHEN ((z.raw->'ordinal')#>>'{}')::numeric BETWEEN -1 AND 501 THEN (CASE WHEN pg_catalog.abs(((z.raw->'ordinal')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((z.raw->'ordinal')#>>'{}')::numeric)::double precision END) BETWEEN 0 AND 500 AND pg_catalog.trunc((CASE WHEN pg_catalog.abs(((z.raw->'ordinal')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((z.raw->'ordinal')#>>'{}')::numeric)::double precision END))=(CASE WHEN pg_catalog.abs(((z.raw->'ordinal')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((z.raw->'ordinal')#>>'{}')::numeric)::double precision END) ELSE false END ELSE false END)
      AND (CASE WHEN (CASE WHEN pg_catalog.jsonb_typeof((z.raw->'ordinal'))='number' THEN CASE WHEN pg_catalog.abs(((z.raw->'ordinal')#>>'{}')::numeric)<=js_zero_half THEN 0 BETWEEN 0 AND 500 WHEN pg_catalog.abs(((z.raw->'ordinal')#>>'{}')::numeric)<0.5 THEN false WHEN ((z.raw->'ordinal')#>>'{}')::numeric BETWEEN -1 AND 501 THEN (CASE WHEN pg_catalog.abs(((z.raw->'ordinal')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((z.raw->'ordinal')#>>'{}')::numeric)::double precision END) BETWEEN 0 AND 500 AND pg_catalog.trunc((CASE WHEN pg_catalog.abs(((z.raw->'ordinal')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((z.raw->'ordinal')#>>'{}')::numeric)::double precision END))=(CASE WHEN pg_catalog.abs(((z.raw->'ordinal')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((z.raw->'ordinal')#>>'{}')::numeric)::double precision END) ELSE false END ELSE false END) THEN ((CASE WHEN pg_catalog.abs(((z.raw->'ordinal')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((z.raw->'ordinal')#>>'{}')::numeric)::double precision END))::integer=(z.ord-1) ELSE false END)
      AND (z.raw->>'categoryCode' IN ('volunteer_service','training','organization','non_creditable'))
      AND (z.raw->'intervalKindCode'='"service_segment"'::jsonb)
      AND (CASE WHEN pg_catalog.jsonb_typeof((z.raw->'startAt'))='string' AND ((z.raw->'startAt')#>>'{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN pg_catalog.substr(((z.raw->'startAt')#>>'{}'),6,2)::integer BETWEEN 1 AND 12 AND pg_catalog.substr(((z.raw->'startAt')#>>'{}'),9,2)::integer BETWEEN 1 AND (CASE pg_catalog.substr(((z.raw->'startAt')#>>'{}'),6,2)::integer WHEN 2 THEN CASE WHEN (pg_catalog.substr(((z.raw->'startAt')#>>'{}'),1,4)::integer%4=0 AND (pg_catalog.substr(((z.raw->'startAt')#>>'{}'),1,4)::integer%100<>0 OR pg_catalog.substr(((z.raw->'startAt')#>>'{}'),1,4)::integer%400=0)) THEN 29 ELSE 28 END WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30 WHEN 11 THEN 30 ELSE 31 END) AND pg_catalog.substr(((z.raw->'startAt')#>>'{}'),12,2)::integer BETWEEN 0 AND 23 AND pg_catalog.substr(((z.raw->'startAt')#>>'{}'),15,2)::integer BETWEEN 0 AND 59 AND pg_catalog.substr(((z.raw->'startAt')#>>'{}'),18,2)::integer BETWEEN 0 AND 59 ELSE false END)
      AND (CASE WHEN pg_catalog.jsonb_typeof((z.raw->'endAt'))='string' AND ((z.raw->'endAt')#>>'{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN pg_catalog.substr(((z.raw->'endAt')#>>'{}'),6,2)::integer BETWEEN 1 AND 12 AND pg_catalog.substr(((z.raw->'endAt')#>>'{}'),9,2)::integer BETWEEN 1 AND (CASE pg_catalog.substr(((z.raw->'endAt')#>>'{}'),6,2)::integer WHEN 2 THEN CASE WHEN (pg_catalog.substr(((z.raw->'endAt')#>>'{}'),1,4)::integer%4=0 AND (pg_catalog.substr(((z.raw->'endAt')#>>'{}'),1,4)::integer%100<>0 OR pg_catalog.substr(((z.raw->'endAt')#>>'{}'),1,4)::integer%400=0)) THEN 29 ELSE 28 END WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30 WHEN 11 THEN 30 ELSE 31 END) AND pg_catalog.substr(((z.raw->'endAt')#>>'{}'),12,2)::integer BETWEEN 0 AND 23 AND pg_catalog.substr(((z.raw->'endAt')#>>'{}'),15,2)::integer BETWEEN 0 AND 59 AND pg_catalog.substr(((z.raw->'endAt')#>>'{}'),18,2)::integer BETWEEN 0 AND 59 ELSE false END)
      AND ((z.raw->>'startAt') COLLATE "C" < (z.raw->>'endAt') COLLATE "C") ELSE false END) IS TRUE)
  THEN RAISE EXCEPTION 'invalid complete source slices' USING ERRCODE='P5C01'; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(proof."sourceSnapshotJson") s(raw)
    WHERE (s.raw->>'sourceHash') IS DISTINCT FROM pg_catalog.encode(pg_catalog.sha256(
      pg_catalog.convert_to('{"definition":'||('{' || '"allocationHash":' || (s.raw->'allocationHash')::text || ',"allocationRevision":' || ((CASE WHEN pg_catalog.abs(((s.raw->'allocationRevision')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((s.raw->'allocationRevision')#>>'{}')::numeric)::double precision END))::integer::text || ',"allocationRevisionId":' || (s.raw->'allocationRevisionId')::text || ',"baseAllocationRevisionId":' || (s.raw->'baseAllocationRevisionId')::text || ',"baseSegmentRevision":' || ((CASE WHEN pg_catalog.abs(((s.raw->'baseSegmentRevision')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((s.raw->'baseSegmentRevision')#>>'{}')::numeric)::double precision END))::integer::text || ',"baseSegmentRevisionId":' || (s.raw->'baseSegmentRevisionId')::text || ',"definitionHash":' || (s.raw->'definitionHash')::text || ',"evaluatorVersion":' || ((CASE WHEN pg_catalog.abs(((s.raw->'evaluatorVersion')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((s.raw->'evaluatorVersion')#>>'{}')::numeric)::double precision END))::integer::text || ',"manualReason":' || (s.raw->'manualReason')::text || ',"participationIdentityId":' || (s.raw->'participationIdentityId')::text || ',"pendingAllocationId":' || (s.raw->'pendingAllocationId')::text || ',"policyId":' || (s.raw->'policyId')::text || ',"policyVersionId":' || (s.raw->'policyVersionId')::text || ',"recognitionModeCode":' || (s.raw->'recognitionModeCode')::text || ',"ruleSnapshotHash":' || (s.raw->'ruleSnapshotHash')::text || ',"ruleSnapshotId":' || (s.raw->'ruleSnapshotId')::text || ',"segmentKey":' || (s.raw->'segmentKey')::text || ',"selectionHash":' || (s.raw->'selectionHash')::text || ',"sliceCount":' || ((CASE WHEN pg_catalog.abs(((s.raw->'sliceCount')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((s.raw->'sliceCount')#>>'{}')::numeric)::double precision END))::integer::text || ',"slices":' || ('[' || COALESCE((SELECT pg_catalog.string_agg('{' || '"categoryCode":' || (z.raw->'categoryCode')::text || ',"endAt":' || (z.raw->'endAt')::text || ',"intervalKindCode":' || (z.raw->'intervalKindCode')::text || ',"ordinal":' || ((CASE WHEN pg_catalog.abs(((z.raw->'ordinal')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((z.raw->'ordinal')#>>'{}')::numeric)::double precision END))::integer::text || ',"startAt":' || (z.raw->'startAt')::text || '}',',' ORDER BY z.ord) FROM pg_catalog.jsonb_array_elements(s.raw->'slices') WITH ORDINALITY z(raw,ord)),'') || ']') || ',"sourceSegmentId":' || (s.raw->'sourceSegmentId')::text || ',"sourceSegmentRevision":' || ((CASE WHEN pg_catalog.abs(((s.raw->'sourceSegmentRevision')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((s.raw->'sourceSegmentRevision')#>>'{}')::numeric)::double precision END))::integer::text || ',"timePolicySelectionRevisionId":' || (s.raw->'timePolicySelectionRevisionId')::text || '}')||
        ',"domain":"correction-time-source-row-v1"}','UTF8')),'hex'))
  THEN RAISE EXCEPTION 'source row digest differs' USING ERRCODE='P5C01'; END IF;

  -- Compare UTF-16BE code units, not UTF-8 database collation. The original
  -- key is identity + U+0000 + segmentKey. PostgreSQL text cannot store NUL;
  -- the separator is represented only in bytea, preserving exact JS ordering.
  IF EXISTS (
    WITH source AS MATERIALIZED (
      SELECT raw,ord FROM pg_catalog.jsonb_array_elements(proof."sourceSnapshotJson") WITH ORDINALITY s(raw,ord)
    ), keys AS (
      SELECT s.ord,pg_catalog.decode(
        (SELECT pg_catalog.string_agg(CASE WHEN pg_catalog.ascii(c.ch)<=65535
          THEN pg_catalog.lpad(pg_catalog.to_hex(pg_catalog.ascii(c.ch)),4,'0')
          ELSE pg_catalog.lpad(pg_catalog.to_hex(55296+(pg_catalog.ascii(c.ch)-65536)/1024),4,'0')||
               pg_catalog.lpad(pg_catalog.to_hex(56320+(pg_catalog.ascii(c.ch)-65536)%1024),4,'0') END,
          '' ORDER BY c.ord) FROM pg_catalog.regexp_split_to_table(s.raw->>'participationIdentityId','') WITH ORDINALITY c(ch,ord))
        ||'0000'||
        (SELECT pg_catalog.string_agg(CASE WHEN pg_catalog.ascii(c.ch)<=65535
          THEN pg_catalog.lpad(pg_catalog.to_hex(pg_catalog.ascii(c.ch)),4,'0')
          ELSE pg_catalog.lpad(pg_catalog.to_hex(55296+(pg_catalog.ascii(c.ch)-65536)/1024),4,'0')||
               pg_catalog.lpad(pg_catalog.to_hex(56320+(pg_catalog.ascii(c.ch)-65536)%1024),4,'0') END,
          '' ORDER BY c.ord) FROM pg_catalog.regexp_split_to_table(s.raw->>'segmentKey','') WITH ORDINALITY c(ch,ord)),
        'hex') AS key FROM source s
    ), ordered AS (SELECT key,pg_catalog.lag(key) OVER(ORDER BY ord) previous FROM keys)
    SELECT 1 FROM ordered WHERE previous>=key)
  THEN RAISE EXCEPTION 'source keys duplicate or out of order' USING ERRCODE='P5C01'; END IF;

  SELECT count(*)::integer INTO delta FROM public."CorrectionPendingSegmentRevision" WHERE "applicationId"=application_id;
  n:=pg_catalog.jsonb_array_length(proof."sourceSnapshotJson");
  IF delta<1 OR n<1 OR delta<>proof."expectedPendingCount" OR n<>proof."expectedSegmentCount"
    OR n<>proof."expectedBindingCount"
    OR delta<>pg_catalog.jsonb_array_length(q."requestedChangeJson"->'segments')
    OR delta<>pg_catalog.jsonb_array_length(q."requestedChangeJson"->'allocations')
    OR delta<>(SELECT count(*) FROM public."CorrectionPendingTimeAllocation" WHERE "applicationId"=application_id)
    OR proof."expectedSliceCount"<>(SELECT COALESCE(sum(((CASE WHEN pg_catalog.abs(((s.raw->'sliceCount')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((s.raw->'sliceCount')#>>'{}')::numeric)::double precision END))::integer),0)
      FROM pg_catalog.jsonb_array_elements(proof."sourceSnapshotJson") s(raw))
  THEN RAISE EXCEPTION 'complete source cardinality mismatch' USING ERRCODE='P5C01'; END IF;

  -- The existing service has already parsed the closed approved change set.
  -- Recheck its entire segment multiset, not a WHERE-valid subset of pending.
  IF EXISTS (
    WITH expected AS MATERIALIZED (
      SELECT raw->>'participationIdentityId' pid,raw->>'segmentKey' skey,
        (CASE WHEN pg_catalog.left((raw->>'checkInAt'),4)='0000' THEN pg_catalog.make_timestamp(-1,pg_catalog.substr((raw->>'checkInAt'),6,2)::integer,pg_catalog.substr((raw->>'checkInAt'),9,2)::integer,pg_catalog.substr((raw->>'checkInAt'),12,2)::integer,pg_catalog.substr((raw->>'checkInAt'),15,2)::integer,pg_catalog.substr((raw->>'checkInAt'),18,6)::double precision) ELSE ((raw->>'checkInAt'))::timestamptz AT TIME ZONE 'UTC' END) ci,
        (CASE WHEN pg_catalog.left((raw->>'checkOutAt'),4)='0000' THEN pg_catalog.make_timestamp(-1,pg_catalog.substr((raw->>'checkOutAt'),6,2)::integer,pg_catalog.substr((raw->>'checkOutAt'),9,2)::integer,pg_catalog.substr((raw->>'checkOutAt'),12,2)::integer,pg_catalog.substr((raw->>'checkOutAt'),15,2)::integer,pg_catalog.substr((raw->>'checkOutAt'),18,6)::double precision) ELSE ((raw->>'checkOutAt'))::timestamptz AT TIME ZONE 'UTC' END) co,
        raw->>'resultCode' result,(raw->>'serviceHours')::numeric hours
      FROM pg_catalog.jsonb_array_elements(q."requestedChangeJson"->'segments') s(raw)
    ), actual AS MATERIALIZED (
      SELECT "participationIdentityId","segmentKey","checkInAt","checkOutAt","resultCode","serviceHours"
      FROM public."CorrectionPendingSegmentRevision" WHERE "applicationId"=application_id
    ), difference AS (
      (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
      UNION ALL (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected))
    SELECT 1 FROM difference)
    OR EXISTS (SELECT 1 FROM public."CorrectionPendingSegmentRevision" p
      WHERE p."applicationId"=application_id AND (p."activityId" IS DISTINCT FROM q."activityId"
        OR p."payloadHash" IS DISTINCT FROM pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          '{"checkInAt":'||pg_catalog.to_jsonb((CASE WHEN EXTRACT(YEAR FROM p."checkInAt")=-1 THEN '0000-'||pg_catalog.to_char(p."checkInAt",'MM-DD"T"HH24:MI:SS.MS"Z"') ELSE pg_catalog.to_char(p."checkInAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END))::text||
          ',"checkOutAt":'||pg_catalog.to_jsonb((CASE WHEN EXTRACT(YEAR FROM p."checkOutAt")=-1 THEN '0000-'||pg_catalog.to_char(p."checkOutAt",'MM-DD"T"HH24:MI:SS.MS"Z"') ELSE pg_catalog.to_char(p."checkOutAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END))::text||
          ',"participationIdentityId":'||pg_catalog.to_jsonb(p."participationIdentityId")::text||
          ',"resultCode":'||pg_catalog.to_jsonb(p."resultCode")::text||
          ',"segmentKey":'||pg_catalog.to_jsonb(p."segmentKey")::text||
          ',"serviceHours":'||pg_catalog.to_jsonb(p."serviceHours"::numeric(5,2)::text)::text||'}','UTF8')),'hex')))
  THEN RAISE EXCEPTION 'approved segment multiset mismatch' USING ERRCODE='P5C01'; END IF;
  IF EXISTS (SELECT 1 FROM public."CorrectionPendingSegmentRevision" p
    LEFT JOIN public."ParticipantServiceSegmentRevision" b ON b.id=p."baseRevisionId"
    LEFT JOIN public."ActivityParticipationIdentity" i ON i.id=b."participationIdentityId"
    WHERE p."applicationId"=application_id AND (b.id IS NULL OR i."activityId" IS DISTINCT FROM q."activityId"
      OR b."statusCode" IS DISTINCT FROM 'committed' OR b."participationIdentityId" IS DISTINCT FROM p."participationIdentityId"
      OR b."segmentKey" IS DISTINCT FROM p."segmentKey" OR b.revision IS DISTINCT FROM p."baseRevisionNumber"
      OR b."sourceCheckInEventId" IS DISTINCT FROM p."sourceCheckInEventId"
      OR p."targetRevisionNumber" IS DISTINCT FROM p."baseRevisionNumber"+1))
  THEN RAISE EXCEPTION 'base segment set changed' USING ERRCODE='P5B01'; END IF;

  IF EXISTS (SELECT 1 FROM public."CorrectionPendingTimeAllocation" p
    WHERE p."applicationId"=application_id GROUP BY p."participationIdentityId",p."segmentKey" HAVING count(*)<>1)
    OR EXISTS (SELECT 1 FROM public."CorrectionPendingTimeAllocation" p
      WHERE p."applicationId"=application_id GROUP BY p."pendingSegmentId" HAVING count(*)<>1)
    OR EXISTS (SELECT 1 FROM public."CorrectionPendingTimeAllocation" p
      WHERE p."applicationId"=application_id GROUP BY p."targetSegmentRevisionId" HAVING count(*)<>1)
    OR EXISTS (SELECT 1 FROM public."CorrectionPendingTimeAllocation" p
      WHERE p."applicationId"=application_id GROUP BY p."targetAllocationRevisionId" HAVING count(*)<>1)
  THEN RAISE EXCEPTION 'duplicate pending target key' USING ERRCODE='P5C01'; END IF;
  IF EXISTS (
    WITH sources AS MATERIALIZED (SELECT * FROM pg_catalog.jsonb_to_recordset(proof."sourceSnapshotJson") AS s(
      "participationIdentityId" text,"segmentKey" text,"pendingAllocationId" text,
      "baseAllocationRevisionId" text,"allocationRevisionId" text,"sourceSegmentId" text,"sourceSegmentRevision" numeric))
    SELECT 1 FROM public."CorrectionPendingTimeAllocation" p
    LEFT JOIN sources s ON s."participationIdentityId"=p."participationIdentityId" AND s."segmentKey"=p."segmentKey"
    LEFT JOIN public."CorrectionPendingSegmentRevision" ps ON ps.id=p."pendingSegmentId"
    LEFT JOIN public."ParticipantTimeAllocationRevision" b ON b.id=p."baseAllocationRevisionId"
    WHERE p."applicationId"=application_id AND (s."pendingAllocationId" IS DISTINCT FROM p.id
      OR s."baseAllocationRevisionId" IS DISTINCT FROM p."baseAllocationRevisionId"
      OR s."allocationRevisionId" IS DISTINCT FROM p."targetAllocationRevisionId"
      OR s."sourceSegmentId" IS DISTINCT FROM p."targetSegmentRevisionId"
      OR s."sourceSegmentRevision"::double precision::integer IS DISTINCT FROM ps."targetRevisionNumber"
      OR ps."applicationId" IS DISTINCT FROM application_id OR ps."activityId" IS DISTINCT FROM p."activityId"
      OR ps."participationIdentityId" IS DISTINCT FROM p."participationIdentityId" OR ps."segmentKey" IS DISTINCT FROM p."segmentKey"
      OR p."activityId" IS DISTINCT FROM q."activityId" OR b."activityId" IS DISTINCT FROM q."activityId"
      OR b."participationIdentityId" IS DISTINCT FROM p."participationIdentityId" OR b."segmentKey" IS DISTINCT FROM p."segmentKey"))
  THEN RAISE EXCEPTION 'pending allocation source linkage mismatch' USING ERRCODE='P5C01'; END IF;
  IF EXISTS (
    WITH sources AS MATERIALIZED (SELECT * FROM pg_catalog.jsonb_to_recordset(proof."sourceSnapshotJson") AS s(
      "participationIdentityId" text,"segmentKey" text,"pendingAllocationId" text,
      "allocationRevisionId" text,"sourceSegmentId" text)),
    actual AS MATERIALIZED (SELECT * FROM public."CorrectionPendingTimeAllocation" WHERE "applicationId"=application_id)
    SELECT 1 FROM sources s LEFT JOIN actual p ON p.id=s."pendingAllocationId"
    WHERE CASE WHEN s."pendingAllocationId" IS NULL THEN EXISTS(SELECT 1 FROM actual x
      WHERE x."participationIdentityId"=s."participationIdentityId" AND x."segmentKey"=s."segmentKey")
    ELSE p.id IS NULL OR p."participationIdentityId" IS DISTINCT FROM s."participationIdentityId"
      OR p."segmentKey" IS DISTINCT FROM s."segmentKey" OR p."targetAllocationRevisionId" IS DISTINCT FROM s."allocationRevisionId"
      OR p."targetSegmentRevisionId" IS DISTINCT FROM s."sourceSegmentId" END)
  THEN RAISE EXCEPTION 'source multiset does not identify the pending set' USING ERRCODE='P5C01'; END IF;

  IF EXISTS (SELECT 1 FROM public."CorrectionPendingTimeAllocation" p WHERE p."applicationId"=application_id
    AND NOT (CASE WHEN pg_catalog.jsonb_typeof(p."allocationJson")='object' THEN
      p."allocationJson" ?& ARRAY['schemaVersion','slices']
      AND p."allocationJson"-ARRAY['schemaVersion','slices']='{}'::jsonb
      AND (CASE WHEN (CASE WHEN pg_catalog.jsonb_typeof((p."allocationJson"->'schemaVersion'))='number' THEN CASE WHEN pg_catalog.abs(((p."allocationJson"->'schemaVersion')#>>'{}')::numeric)<=js_zero_half THEN 0 BETWEEN 1 AND 1 WHEN pg_catalog.abs(((p."allocationJson"->'schemaVersion')#>>'{}')::numeric)<0.5 THEN false WHEN ((p."allocationJson"->'schemaVersion')#>>'{}')::numeric BETWEEN 0 AND 2 THEN (CASE WHEN pg_catalog.abs(((p."allocationJson"->'schemaVersion')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((p."allocationJson"->'schemaVersion')#>>'{}')::numeric)::double precision END) BETWEEN 1 AND 1 AND pg_catalog.trunc((CASE WHEN pg_catalog.abs(((p."allocationJson"->'schemaVersion')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((p."allocationJson"->'schemaVersion')#>>'{}')::numeric)::double precision END))=(CASE WHEN pg_catalog.abs(((p."allocationJson"->'schemaVersion')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((p."allocationJson"->'schemaVersion')#>>'{}')::numeric)::double precision END) ELSE false END ELSE false END) THEN ((CASE WHEN pg_catalog.abs(((p."allocationJson"->'schemaVersion')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((p."allocationJson"->'schemaVersion')#>>'{}')::numeric)::double precision END))::integer=(1) ELSE false END)
      AND pg_catalog.jsonb_typeof(p."allocationJson"->'slices')='object' ELSE false END) IS TRUE)
  THEN RAISE EXCEPTION 'invalid allocation manifest shape' USING ERRCODE='P5C01'; END IF;
  IF EXISTS (SELECT 1 FROM public."CorrectionPendingTimeAllocation" p
    CROSS JOIN LATERAL pg_catalog.jsonb_each(p."allocationJson"->'slices') j
    WHERE p."applicationId"=application_id AND NOT(CASE WHEN pg_catalog.jsonb_typeof(j.value)='object' THEN
      (pg_catalog.jsonb_typeof(j.value)='object' AND j.value ?& ARRAY['ordinal','categoryCode','intervalKindCode','startAt','endAt'] AND (j.value-ARRAY['ordinal','categoryCode','intervalKindCode','startAt','endAt'])='{}'::jsonb)
      AND (j.key ~ '^(0|[1-9][0-9]{0,2})$')
      AND (CASE WHEN pg_catalog.jsonb_typeof((j.value->'ordinal'))='number' THEN CASE WHEN pg_catalog.abs(((j.value->'ordinal')#>>'{}')::numeric)<=js_zero_half THEN 0 BETWEEN 0 AND 500 WHEN pg_catalog.abs(((j.value->'ordinal')#>>'{}')::numeric)<0.5 THEN false WHEN ((j.value->'ordinal')#>>'{}')::numeric BETWEEN -1 AND 501 THEN (CASE WHEN pg_catalog.abs(((j.value->'ordinal')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((j.value->'ordinal')#>>'{}')::numeric)::double precision END) BETWEEN 0 AND 500 AND pg_catalog.trunc((CASE WHEN pg_catalog.abs(((j.value->'ordinal')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((j.value->'ordinal')#>>'{}')::numeric)::double precision END))=(CASE WHEN pg_catalog.abs(((j.value->'ordinal')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((j.value->'ordinal')#>>'{}')::numeric)::double precision END) ELSE false END ELSE false END)
      AND (CASE WHEN (CASE WHEN pg_catalog.jsonb_typeof((j.value->'ordinal'))='number' THEN CASE WHEN pg_catalog.abs(((j.value->'ordinal')#>>'{}')::numeric)<=js_zero_half THEN 0 BETWEEN 0 AND 500 WHEN pg_catalog.abs(((j.value->'ordinal')#>>'{}')::numeric)<0.5 THEN false WHEN ((j.value->'ordinal')#>>'{}')::numeric BETWEEN -1 AND 501 THEN (CASE WHEN pg_catalog.abs(((j.value->'ordinal')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((j.value->'ordinal')#>>'{}')::numeric)::double precision END) BETWEEN 0 AND 500 AND pg_catalog.trunc((CASE WHEN pg_catalog.abs(((j.value->'ordinal')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((j.value->'ordinal')#>>'{}')::numeric)::double precision END))=(CASE WHEN pg_catalog.abs(((j.value->'ordinal')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((j.value->'ordinal')#>>'{}')::numeric)::double precision END) ELSE false END ELSE false END) THEN ((CASE WHEN pg_catalog.abs(((j.value->'ordinal')#>>'{}')::numeric)<=js_zero_half THEN 0::double precision ELSE (((j.value->'ordinal')#>>'{}')::numeric)::double precision END))::integer::text=j.key ELSE false END)
      AND (j.value->>'categoryCode' IN ('volunteer_service','training','organization','non_creditable'))
      AND (j.value->'intervalKindCode'='"service_segment"'::jsonb)
      AND (CASE WHEN pg_catalog.jsonb_typeof((j.value->'startAt'))='string' AND ((j.value->'startAt')#>>'{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN pg_catalog.substr(((j.value->'startAt')#>>'{}'),6,2)::integer BETWEEN 1 AND 12 AND pg_catalog.substr(((j.value->'startAt')#>>'{}'),9,2)::integer BETWEEN 1 AND (CASE pg_catalog.substr(((j.value->'startAt')#>>'{}'),6,2)::integer WHEN 2 THEN CASE WHEN (pg_catalog.substr(((j.value->'startAt')#>>'{}'),1,4)::integer%4=0 AND (pg_catalog.substr(((j.value->'startAt')#>>'{}'),1,4)::integer%100<>0 OR pg_catalog.substr(((j.value->'startAt')#>>'{}'),1,4)::integer%400=0)) THEN 29 ELSE 28 END WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30 WHEN 11 THEN 30 ELSE 31 END) AND pg_catalog.substr(((j.value->'startAt')#>>'{}'),12,2)::integer BETWEEN 0 AND 23 AND pg_catalog.substr(((j.value->'startAt')#>>'{}'),15,2)::integer BETWEEN 0 AND 59 AND pg_catalog.substr(((j.value->'startAt')#>>'{}'),18,2)::integer BETWEEN 0 AND 59 ELSE false END)
      AND (CASE WHEN pg_catalog.jsonb_typeof((j.value->'endAt'))='string' AND ((j.value->'endAt')#>>'{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN pg_catalog.substr(((j.value->'endAt')#>>'{}'),6,2)::integer BETWEEN 1 AND 12 AND pg_catalog.substr(((j.value->'endAt')#>>'{}'),9,2)::integer BETWEEN 1 AND (CASE pg_catalog.substr(((j.value->'endAt')#>>'{}'),6,2)::integer WHEN 2 THEN CASE WHEN (pg_catalog.substr(((j.value->'endAt')#>>'{}'),1,4)::integer%4=0 AND (pg_catalog.substr(((j.value->'endAt')#>>'{}'),1,4)::integer%100<>0 OR pg_catalog.substr(((j.value->'endAt')#>>'{}'),1,4)::integer%400=0)) THEN 29 ELSE 28 END WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30 WHEN 11 THEN 30 ELSE 31 END) AND pg_catalog.substr(((j.value->'endAt')#>>'{}'),12,2)::integer BETWEEN 0 AND 23 AND pg_catalog.substr(((j.value->'endAt')#>>'{}'),15,2)::integer BETWEEN 0 AND 59 AND pg_catalog.substr(((j.value->'endAt')#>>'{}'),18,2)::integer BETWEEN 0 AND 59 ELSE false END)
      AND ((j.value->>'startAt') COLLATE "C" < (j.value->>'endAt') COLLATE "C") ELSE false END) IS TRUE)
  THEN RAISE EXCEPTION 'invalid allocation slice manifest' USING ERRCODE='P5C01'; END IF;
  IF EXISTS (SELECT 1 FROM public."CorrectionPendingTimeAllocation" p WHERE p."applicationId"=application_id
      AND (p."sliceCount">500 OR p."sliceCount"<>(SELECT count(*) FROM pg_catalog.jsonb_each(p."allocationJson"->'slices'))
        OR (SELECT count(*) FROM public."CorrectionPendingTimeAllocationEvidence" e WHERE e."pendingAllocationId"=p.id)>20))
    OR EXISTS (SELECT 1 FROM public."CorrectionPendingTimeAllocationEvidence" e
      JOIN public."CorrectionPendingTimeAllocation" p ON p.id=e."pendingAllocationId"
      WHERE p."applicationId"=application_id AND e."activityId" IS DISTINCT FROM p."activityId")
  THEN RAISE EXCEPTION 'manifest or evidence count mismatch' USING ERRCODE='P5C01'; END IF;
  IF EXISTS (SELECT 1 FROM public."CorrectionPendingTimeAllocation" p
    CROSS JOIN LATERAL pg_catalog.jsonb_each(p."allocationJson"->'slices') j
    WHERE p."applicationId"=application_id AND j.key::integer>=p."sliceCount")
  THEN RAISE EXCEPTION 'time allocation slice differs from the immutable manifest'
    USING ERRCODE='23514',CONSTRAINT='ptas_manifest_guard'; END IF;

  -- Preserve the ORIGINAL BEFORE manifest equality after the original Prisma
  -- numeric JSON roundtrip. In particular ISO0000 parses as a JS date but the
  -- original PostgreSQL YYYY formatter does not print astronomical year0000;
  -- mapping the timestamp alone must not accidentally accept that manifest.
  IF EXISTS (SELECT 1 FROM public."CorrectionPendingTimeAllocation" p
    CROSS JOIN LATERAL pg_catalog.jsonb_each(p."allocationJson"->'slices') j
    WHERE p."applicationId"=application_id AND
      (j.value||pg_catalog.jsonb_build_object('ordinal',j.key::integer)) IS DISTINCT FROM
      pg_catalog.jsonb_build_object('categoryCode',j.value->>'categoryCode',
        'endAt',pg_catalog.to_char((CASE WHEN pg_catalog.left((j.value->>'endAt'),4)='0000' THEN pg_catalog.make_timestamp(-1,pg_catalog.substr((j.value->>'endAt'),6,2)::integer,pg_catalog.substr((j.value->>'endAt'),9,2)::integer,pg_catalog.substr((j.value->>'endAt'),12,2)::integer,pg_catalog.substr((j.value->>'endAt'),15,2)::integer,pg_catalog.substr((j.value->>'endAt'),18,6)::double precision) ELSE ((j.value->>'endAt'))::timestamptz AT TIME ZONE 'UTC' END),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'intervalKindCode',j.value->>'intervalKindCode','ordinal',j.key::integer,
        'startAt',pg_catalog.to_char((CASE WHEN pg_catalog.left((j.value->>'startAt'),4)='0000' THEN pg_catalog.make_timestamp(-1,pg_catalog.substr((j.value->>'startAt'),6,2)::integer,pg_catalog.substr((j.value->>'startAt'),9,2)::integer,pg_catalog.substr((j.value->>'startAt'),12,2)::integer,pg_catalog.substr((j.value->>'startAt'),15,2)::integer,pg_catalog.substr((j.value->>'startAt'),18,6)::double precision) ELSE ((j.value->>'startAt'))::timestamptz AT TIME ZONE 'UTC' END),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
  THEN RAISE EXCEPTION 'time allocation slice differs from the immutable manifest'
    USING ERRCODE='23514',CONSTRAINT='ptas_manifest_guard'; END IF;

  -- Each old BEFORE slice invariant applies to the complete generated set.
  -- Include any already stored rows, even though normal fresh targets have none.
  IF EXISTS (SELECT 1 FROM public."CorrectionPendingTimeAllocation" p
    JOIN public."ParticipantTimeAllocationCommandReceipt" r ON r."allocationRevisionId"=p."targetAllocationRevisionId"
    WHERE p."applicationId"=application_id AND r."activityId"=p."activityId")
  THEN RAISE EXCEPTION 'cannot append time allocation slices to a sealed revision'
    USING ERRCODE='23514',CONSTRAINT='ptas_parent_sealed_guard'; END IF;
  IF EXISTS (
    WITH pending AS MATERIALIZED (SELECT p.*,s."checkInAt",s."checkOutAt" FROM public."CorrectionPendingTimeAllocation" p
      JOIN public."CorrectionPendingSegmentRevision" s ON s.id=p."pendingSegmentId" WHERE p."applicationId"=application_id),
    prospective AS MATERIALIZED (SELECT p."targetAllocationRevisionId" aid,j.key::integer ordinal,
      (CASE WHEN pg_catalog.left((j.value->>'startAt'),4)='0000' THEN pg_catalog.make_timestamp(-1,pg_catalog.substr((j.value->>'startAt'),6,2)::integer,pg_catalog.substr((j.value->>'startAt'),9,2)::integer,pg_catalog.substr((j.value->>'startAt'),12,2)::integer,pg_catalog.substr((j.value->>'startAt'),15,2)::integer,pg_catalog.substr((j.value->>'startAt'),18,6)::double precision) ELSE ((j.value->>'startAt'))::timestamptz AT TIME ZONE 'UTC' END) start_at,
      (CASE WHEN pg_catalog.left((j.value->>'endAt'),4)='0000' THEN pg_catalog.make_timestamp(-1,pg_catalog.substr((j.value->>'endAt'),6,2)::integer,pg_catalog.substr((j.value->>'endAt'),9,2)::integer,pg_catalog.substr((j.value->>'endAt'),12,2)::integer,pg_catalog.substr((j.value->>'endAt'),15,2)::integer,pg_catalog.substr((j.value->>'endAt'),18,6)::double precision) ELSE ((j.value->>'endAt'))::timestamptz AT TIME ZONE 'UTC' END) end_at,p."checkInAt",p."checkOutAt"
      FROM pending p CROSS JOIN LATERAL pg_catalog.jsonb_each(p."allocationJson"->'slices') j)
    SELECT 1 FROM prospective WHERE start_at<"checkInAt" OR end_at>"checkOutAt")
  THEN RAISE EXCEPTION 'time allocation slice lies outside the source segment'
    USING ERRCODE='23514',CONSTRAINT='ptas_source_interval_guard'; END IF;
  IF EXISTS (
    WITH pending AS MATERIALIZED (SELECT * FROM public."CorrectionPendingTimeAllocation" WHERE "applicationId"=application_id),
    all_slices AS MATERIALIZED (
      SELECT p."targetAllocationRevisionId" aid,(CASE WHEN pg_catalog.left((j.value->>'startAt'),4)='0000' THEN pg_catalog.make_timestamp(-1,pg_catalog.substr((j.value->>'startAt'),6,2)::integer,pg_catalog.substr((j.value->>'startAt'),9,2)::integer,pg_catalog.substr((j.value->>'startAt'),12,2)::integer,pg_catalog.substr((j.value->>'startAt'),15,2)::integer,pg_catalog.substr((j.value->>'startAt'),18,6)::double precision) ELSE ((j.value->>'startAt'))::timestamptz AT TIME ZONE 'UTC' END) start_at,
        (CASE WHEN pg_catalog.left((j.value->>'endAt'),4)='0000' THEN pg_catalog.make_timestamp(-1,pg_catalog.substr((j.value->>'endAt'),6,2)::integer,pg_catalog.substr((j.value->>'endAt'),9,2)::integer,pg_catalog.substr((j.value->>'endAt'),12,2)::integer,pg_catalog.substr((j.value->>'endAt'),15,2)::integer,pg_catalog.substr((j.value->>'endAt'),18,6)::double precision) ELSE ((j.value->>'endAt'))::timestamptz AT TIME ZONE 'UTC' END) end_at
      FROM pending p CROSS JOIN LATERAL pg_catalog.jsonb_each(p."allocationJson"->'slices') j
      UNION ALL SELECT e."allocationRevisionId",e."startAt",e."endAt" FROM public."ParticipantTimeAllocationSlice" e
        JOIN pending p ON p."targetAllocationRevisionId"=e."allocationRevisionId"),
    ordered AS (SELECT *,max(end_at) OVER(PARTITION BY aid ORDER BY start_at,end_at
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) previous_max_end FROM all_slices)
    SELECT 1 FROM ordered WHERE start_at<previous_max_end)
  THEN RAISE EXCEPTION 'time allocation slices overlap'
    USING ERRCODE='23514',CONSTRAINT='ptas_overlap_guard'; END IF;
  IF EXISTS (
    WITH pending AS MATERIALIZED (SELECT p.*,s."checkInAt",s."checkOutAt" FROM public."CorrectionPendingTimeAllocation" p
      JOIN public."CorrectionPendingSegmentRevision" s ON s.id=p."pendingSegmentId" WHERE p."applicationId"=application_id),
    totals AS (SELECT p.id,COALESCE((SELECT sum(extract(epoch FROM (
        (CASE WHEN pg_catalog.left((j.value->>'endAt'),4)='0000' THEN pg_catalog.make_timestamp(-1,pg_catalog.substr((j.value->>'endAt'),6,2)::integer,pg_catalog.substr((j.value->>'endAt'),9,2)::integer,pg_catalog.substr((j.value->>'endAt'),12,2)::integer,pg_catalog.substr((j.value->>'endAt'),15,2)::integer,pg_catalog.substr((j.value->>'endAt'),18,6)::double precision) ELSE ((j.value->>'endAt'))::timestamptz AT TIME ZONE 'UTC' END)-(CASE WHEN pg_catalog.left((j.value->>'startAt'),4)='0000' THEN pg_catalog.make_timestamp(-1,pg_catalog.substr((j.value->>'startAt'),6,2)::integer,pg_catalog.substr((j.value->>'startAt'),9,2)::integer,pg_catalog.substr((j.value->>'startAt'),12,2)::integer,pg_catalog.substr((j.value->>'startAt'),15,2)::integer,pg_catalog.substr((j.value->>'startAt'),18,6)::double precision) ELSE ((j.value->>'startAt'))::timestamptz AT TIME ZONE 'UTC' END))))
      FROM pg_catalog.jsonb_each(p."allocationJson"->'slices') j),0)+COALESCE((SELECT sum(extract(epoch FROM (e."endAt"-e."startAt")))
      FROM public."ParticipantTimeAllocationSlice" e WHERE e."allocationRevisionId"=p."targetAllocationRevisionId"),0) seconds,
      extract(epoch FROM(p."checkOutAt"-p."checkInAt")) maximum FROM pending p)
    SELECT 1 FROM totals WHERE seconds>maximum)
  THEN RAISE EXCEPTION 'time allocation slices exceed the source segment duration'
    USING ERRCODE='23514',CONSTRAINT='ptas_total_guard'; END IF;
  -- Existing FK/checks and allocation/evidence/receipt/binding guards execute
  -- on every generated statement, then the eight original full final checks.
END;
$assert_set$;

CREATE OR REPLACE FUNCTION public.r5_correction_materialize_facts()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $writer$
DECLARE
  application_row record;
  request_row record;
  proof_row record;
  expected_delta integer;
  expected_slices integer;
  expected_evidence integer;
  actual_count bigint;
BEGIN
  -- No freely callable privileged helper, client mode flag, supplied rowset,
  -- saved validation verdict, dynamic SQL, COMMIT, or catch-and-continue.
  -- The BEFORE phase trigger runs as the original caller. It validates the
  -- complete input and pins the unique trigger call graph before reaching here.
  IF TG_RELID <> 'public."CorrectionWritePhase"'::regclass
     OR TG_NAME <> 'r5_phase_materialize_facts'
     OR TG_OP <> 'UPDATE' OR TG_WHEN <> 'AFTER' OR TG_LEVEL <> 'ROW'
     OR pg_catalog.pg_trigger_depth() <> 1
     OR current_user <> 'r5_mat_writer_20261029_q1'
  THEN RAISE EXCEPTION 'unexpected materialization entry' USING ERRCODE='42501'; END IF;
  IF OLD.phase <> 'commit' OR NEW.phase <> 'commit'
     OR OLD.state <> 'OPEN' OR NEW.state <> 'MATERIALIZED'
     OR ROW(NEW."applicationId",NEW."batchId",NEW."requestId",NEW."sourceRevision",NEW."transactionId",NEW."actorOid")
        IS DISTINCT FROM ROW(OLD."applicationId",OLD."batchId",OLD."requestId",OLD."sourceRevision",OLD."transactionId",OLD."actorOid")
     OR NEW."transactionId" <> pg_catalog.pg_current_xact_id()
     OR NEW."materializedByUserId" IS NULL OR NEW."materializedAt" IS NULL
  THEN RAISE EXCEPTION 'invalid materialization transition' USING ERRCODE='55000'; END IF;

  SELECT a.id,a."correctionRequestId",a."newPostingBatchId",a."statusCode"
    INTO STRICT application_row FROM public."CorrectionApplication" a
    WHERE a.id=NEW."applicationId";
  SELECT q.id,q."activityId",q."statusCode",q.r5_source_revision
    INTO STRICT request_row FROM public."AttendanceCorrectionRequest" q
    WHERE q.id=application_row."correctionRequestId";
  SELECT p.id,p."activityId",p."postingBatchId",p."sourceSnapshotJson",
         p."expectedPendingCount",p."expectedBindingCount",p."expectedSegmentCount"
    INTO STRICT proof_row FROM public."CorrectionTimeSourceProof" p
    WHERE p."applicationId"=application_row.id;
  IF application_row."statusCode" IS DISTINCT FROM 'preparing'
    OR request_row."statusCode" IS DISTINCT FROM 'applying'
    OR request_row.id IS DISTINCT FROM NEW."requestId"
    OR request_row.r5_source_revision IS DISTINCT FROM NEW."sourceRevision"
    OR application_row."newPostingBatchId" IS DISTINCT FROM NEW."batchId"
    OR proof_row."postingBatchId" IS DISTINCT FROM NEW."batchId"
    OR proof_row."activityId" IS DISTINCT FROM request_row."activityId"
    OR NOT EXISTS (SELECT 1 FROM public."LedgerPostingBatch" b
      WHERE b.id=NEW."batchId" AND b."statusCode"='ready')
  THEN RAISE EXCEPTION 'materialization protocol anchors changed' USING ERRCODE='55000'; END IF;

  SELECT count(*)::integer,COALESCE(sum(p."sliceCount"),0)::integer
    INTO expected_delta,expected_slices
    FROM public."CorrectionPendingTimeAllocation" p WHERE p."applicationId"=application_row.id;
  SELECT count(*)::integer INTO expected_evidence
    FROM public."CorrectionPendingTimeAllocationEvidence" e
    JOIN public."CorrectionPendingTimeAllocation" p ON p.id=e."pendingAllocationId"
    WHERE p."applicationId"=application_row.id;
  IF expected_delta<1 OR expected_delta IS DISTINCT FROM proof_row."expectedPendingCount"
     OR proof_row."expectedBindingCount" IS DISTINCT FROM proof_row."expectedSegmentCount"
  THEN RAISE EXCEPTION 'materialization cardinality changed' USING ERRCODE='P5C01'; END IF;

  -- First UPDATE remains before materialization. This does NOT publish the new
  -- draft segment; the second UPDATE remains in the original ledger committer.
  UPDATE public."ParticipantServiceSegmentRevision" b
    SET "statusCode"='superseded',"updatedAt"=NEW."materializedAt"
    FROM public."CorrectionPendingSegmentRevision" p
    WHERE p."applicationId"=application_row.id AND b.id=p."baseRevisionId"
      AND b."statusCode"='committed';
  GET DIAGNOSTICS actual_count=ROW_COUNT;
  IF actual_count<>expected_delta THEN
    RAISE EXCEPTION 'base segment set changed' USING ERRCODE='P5B01'; END IF;

  -- createdAt deliberately omitted: preserve the original database default.
  INSERT INTO public."ParticipantServiceSegmentRevision" (
    "id","updatedAt","participationIdentityId","segmentKey","revision",
    "sourceCheckInEventId","resultCode","statusCode","checkInAt","checkOutAt",
    "serviceHours","baseRevisionId")
  SELECT p."targetSegmentRevisionId",NEW."materializedAt",s."participationIdentityId",
    s."segmentKey",s."targetRevisionNumber",s."sourceCheckInEventId",s."resultCode",'draft',
    s."checkInAt",s."checkOutAt",s."serviceHours",s."baseRevisionId"
  FROM public."CorrectionPendingSegmentRevision" s
  JOIN public."CorrectionPendingTimeAllocation" p ON p."pendingSegmentId"=s.id
    AND p."applicationId"=s."applicationId" AND p."activityId"=s."activityId"
    AND p."participationIdentityId"=s."participationIdentityId" AND p."segmentKey"=s."segmentKey"
  WHERE s."applicationId"=application_row.id
  ORDER BY s."participationIdentityId",s."segmentKey";
  GET DIAGNOSTICS actual_count=ROW_COUNT;
  IF actual_count<>expected_delta THEN
    RAISE EXCEPTION 'target segment set incomplete' USING ERRCODE='P5B01'; END IF;

  -- Existing allocation statement guard retains its full anchor/lock sequence.
  INSERT INTO public."ParticipantTimeAllocationRevision" (
    "id","createdAt","activityId","sessionId","memberId","participationIdentityId",
    "segmentKey","revision","previousAllocationRevisionId","sourceSegmentId",
    "sourceSegmentRevision","sourcePositionId","ruleSnapshotId","ruleSnapshotHash",
    "timePolicySelectionRevisionId","selectionHash","policyId","policyVersionId",
    "definitionHash","evaluatorVersion","recognitionModeCode","manualReason",
    "allocationJson","allocationHash","sliceCount","createdByUserId",
    "settlementDraftContentHash","settlementDraftVersionId","settlementEvidenceRevision",
    "settlementEvidenceSealId","settlementPopulationRevision","settlementWorkflowRevision",
    "correctionPendingAllocationId")
  SELECT p."targetAllocationRevisionId",NEW."materializedAt",request_row."activityId",
    b."sessionId",b."memberId",p."participationIdentityId",p."segmentKey",
    p."targetAllocationRevision",b.id,p."targetSegmentRevisionId",s."targetRevisionNumber",
    b."sourcePositionId",p."ruleSnapshotId",p."ruleSnapshotHash",p."timePolicySelectionRevisionId",
    p."selectionHash",b."policyId",p."policyVersionId",p."definitionHash",p."evaluatorVersion",
    p."recognitionModeCode",p."manualReason",
    -- Match the old Prisma JSON Number roundtrip. The unchanged allocation
    -- statement guard still compares this entire JSON with pending raw JSON,
    -- rejecting inexact values (for example ordinal1e-400 -> 0).
    pg_catalog.jsonb_build_object('schemaVersion',1,'slices',COALESCE((
      SELECT pg_catalog.jsonb_object_agg(j.key,j.value||pg_catalog.jsonb_build_object('ordinal',j.key::integer))
      FROM pg_catalog.jsonb_each(p."allocationJson"->'slices') j),'{}'::jsonb)),
    p."allocationHash",p."sliceCount",
    NEW."materializedByUserId",NULL,NULL,NULL,NULL,NULL,NULL,p.id
  FROM public."CorrectionPendingTimeAllocation" p
  JOIN public."CorrectionPendingSegmentRevision" s ON s.id=p."pendingSegmentId"
    AND s."applicationId"=p."applicationId" AND s."activityId"=p."activityId"
    AND s."participationIdentityId"=p."participationIdentityId" AND s."segmentKey"=p."segmentKey"
  JOIN public."ParticipantTimeAllocationRevision" b ON b.id=p."baseAllocationRevisionId"
    AND b."activityId"=p."activityId" AND b."participationIdentityId"=p."participationIdentityId"
    AND b."segmentKey"=p."segmentKey"
  WHERE p."applicationId"=application_row.id
  ORDER BY p."participationIdentityId",p."segmentKey";
  GET DIAGNOSTICS actual_count=ROW_COUNT;
  IF actual_count<>expected_delta THEN
    RAISE EXCEPTION 'allocation set incomplete' USING ERRCODE='P5C01'; END IF;

  -- The invoker assertion has checked EVERY manifest and its exact ordinal set,
  -- existing+attempted overlap/range/duration, without filtering invalid items.
  -- The private row branch is only reachable from this pinned producer. Plain
  -- INSERT retains all uniqueness/FK/check failures; no ON CONFLICT is used.
  INSERT INTO public."ParticipantTimeAllocationSlice" (
    "id","allocationRevisionId","activityId","ordinal","categoryCode",
    "intervalKindCode","startAt","endAt")
  SELECT pg_catalog.gen_random_uuid()::text,p."targetAllocationRevisionId",request_row."activityId",
    j.key::integer,j.value->>'categoryCode',j.value->>'intervalKindCode',
    CASE WHEN pg_catalog.left(j.value->>'startAt',4)='0000' THEN
      pg_catalog.make_timestamp(-1,pg_catalog.substr(j.value->>'startAt',6,2)::integer,
        pg_catalog.substr(j.value->>'startAt',9,2)::integer,pg_catalog.substr(j.value->>'startAt',12,2)::integer,
        pg_catalog.substr(j.value->>'startAt',15,2)::integer,pg_catalog.substr(j.value->>'startAt',18,6)::double precision)
      ELSE (j.value->>'startAt')::timestamptz AT TIME ZONE 'UTC' END,
    CASE WHEN pg_catalog.left(j.value->>'endAt',4)='0000' THEN
      pg_catalog.make_timestamp(-1,pg_catalog.substr(j.value->>'endAt',6,2)::integer,
        pg_catalog.substr(j.value->>'endAt',9,2)::integer,pg_catalog.substr(j.value->>'endAt',12,2)::integer,
        pg_catalog.substr(j.value->>'endAt',15,2)::integer,pg_catalog.substr(j.value->>'endAt',18,6)::double precision)
      ELSE (j.value->>'endAt')::timestamptz AT TIME ZONE 'UTC' END
  FROM public."CorrectionPendingTimeAllocation" p
  CROSS JOIN LATERAL pg_catalog.jsonb_each(p."allocationJson"->'slices') j
  WHERE p."applicationId"=application_row.id
  ORDER BY p."participationIdentityId",p."segmentKey",j.key::integer;
  GET DIAGNOSTICS actual_count=ROW_COUNT;
  IF actual_count<>expected_slices THEN
    RAISE EXCEPTION 'slice set incomplete' USING ERRCODE='P5C01'; END IF;

  -- Original evidence BEFORE owner/seal guard remains enabled and unchanged.
  INSERT INTO public."ParticipantTimeAllocationEvidence" (
    "id","allocationRevisionId","activityId","attachmentId","ordinal")
  SELECT pg_catalog.gen_random_uuid()::text,p."targetAllocationRevisionId",request_row."activityId",
    e."attachmentId",e.ordinal
  FROM public."CorrectionPendingTimeAllocationEvidence" e
  JOIN public."CorrectionPendingTimeAllocation" p ON p.id=e."pendingAllocationId"
    AND p."activityId"=e."activityId"
  WHERE p."applicationId"=application_row.id
  ORDER BY p."participationIdentityId",p."segmentKey",e.ordinal;
  GET DIAGNOSTICS actual_count=ROW_COUNT;
  IF actual_count<>expected_evidence THEN
    RAISE EXCEPTION 'evidence set incomplete' USING ERRCODE='P5C01'; END IF;

  INSERT INTO public."ParticipantTimeAllocationCommandReceipt" (
    "id","actorUserId","activityId","operationCode","operationKey","requestHash",
    "allocationRevisionId","resultJson","createdAt")
  SELECT pg_catalog.gen_random_uuid()::text,NEW."materializedByUserId",request_row."activityId",
    'recognize_correction_time_allocation','correction-time-allocation:'||application_row.id||':'||p.id,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      '{"definition":{"allocationHash":'||pg_catalog.to_jsonb(p."allocationHash")::text||
      ',"applicationId":'||pg_catalog.to_jsonb(application_row.id)::text||
      ',"pendingAllocationId":'||pg_catalog.to_jsonb(p.id)::text||
      '},"domain":"correction-time-allocation-receipt-v1"}','UTF8')),'hex'),
    p."targetAllocationRevisionId",pg_catalog.jsonb_build_object(
      'schemaVersion',1,'activityId',request_row."activityId",
      'allocationRevisionId',p."targetAllocationRevisionId",'revision',p."targetAllocationRevision",
      'sourceSegmentId',p."targetSegmentRevisionId",'sourceSegmentRevision',s."targetRevisionNumber",
      'recognitionModeCode',p."recognitionModeCode",'allocationHash',p."allocationHash",
      'sliceCount',p."sliceCount",'evidenceCount',e.n,
      'createdAt',pg_catalog.to_char(NEW."materializedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    NEW."materializedAt"
  FROM public."CorrectionPendingTimeAllocation" p
  JOIN public."CorrectionPendingSegmentRevision" s ON s.id=p."pendingSegmentId"
    AND s."applicationId"=p."applicationId" AND s."activityId"=p."activityId"
    AND s."participationIdentityId"=p."participationIdentityId" AND s."segmentKey"=p."segmentKey"
  CROSS JOIN LATERAL (SELECT count(*)::integer n FROM public."CorrectionPendingTimeAllocationEvidence" e
    WHERE e."pendingAllocationId"=p.id AND e."activityId"=p."activityId") e
  WHERE p."applicationId"=application_row.id
  ORDER BY p."participationIdentityId",p."segmentKey";
  GET DIAGNOSTICS actual_count=ROW_COUNT;
  IF actual_count<>expected_delta THEN
    RAISE EXCEPTION 'receipt set incomplete' USING ERRCODE='P5C01'; END IF;

  -- ALL N sources, not only delta. The strict original-shape validation occurs
  -- before any cast here. Do not filter by pendingAllocationId/non-NULL/valid.
  -- createdAt omitted exactly as the original one-JSON binding INSERT.
  INSERT INTO public."CorrectionTimeAllocationBinding" (
    "id","proofId","activityId","participationIdentityId","segmentKey",
    "allocationRevisionId","sourceSegmentId","sourceSegmentRevision","pendingAllocationId","sourceHash")
  SELECT pg_catalog.gen_random_uuid()::text,proof_row.id,request_row."activityId",
    s."participationIdentityId",s."segmentKey",s."allocationRevisionId",s."sourceSegmentId",
    s."sourceSegmentRevision"::double precision::integer,s."pendingAllocationId",s."sourceHash"
  FROM pg_catalog.jsonb_to_recordset(proof_row."sourceSnapshotJson") AS s(
    "participationIdentityId" text,"segmentKey" text,"allocationRevisionId" text,
    "sourceSegmentId" text,"sourceSegmentRevision" numeric,"pendingAllocationId" text,"sourceHash" text);
  GET DIAGNOSTICS actual_count=ROW_COUNT;
  IF actual_count<>proof_row."expectedBindingCount" THEN
    RAISE EXCEPTION 'complete source binding set incomplete' USING ERRCODE='P5C01'; END IF;

  -- No draft->committed UPDATE, ledger/audit effect or privilege persistence.
  -- Caller resumes the original receipt/ledger/authorization/final UPDATE/seal
  -- sequence. All eight final obligations remain caller-owned full rechecks.
  RETURN NEW;
END;
$writer$;

CREATE OR REPLACE FUNCTION public.r5_correction_materialize_phase(app_id text, actor_user_id text)
RETURNS TABLE(application_id text,batch_id text,source_count integer,segment_count integer,
  allocation_count integer,slice_count integer,evidence_count integer,receipt_count integer,
  binding_count integer,state text)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $entry$
DECLARE phase_batch text; rows_changed bigint;
BEGIN
  PERFORM public.r5_correction_boundary_preflight();
  -- This UPDATE cannot certify itself. The INVOKER BEFORE guard must perform
  -- full live source/prospective-set checks; the exact AFTER trigger performs
  -- the six writes under its dedicated identity. Any error aborts this call.
  UPDATE public."CorrectionWritePhase" p
    SET state='MATERIALIZED',"materializedByUserId"=actor_user_id
    WHERE p."applicationId"=app_id AND p.phase='commit' AND p.state='OPEN'
      AND p."transactionId"=pg_catalog.pg_current_xact_id()
      AND p."actorOid"=current_user::regrole::oid
    RETURNING p."batchId" INTO phase_batch;
  GET DIAGNOSTICS rows_changed=ROW_COUNT;
  IF rows_changed<>1 THEN
    RAISE EXCEPTION 'no current caller open materialization phase' USING ERRCODE='55000'; END IF;
  -- Read actual child counts after the completed trigger. Proof N remains
  -- separate from delta. The service checks this receipt; later original DB
  -- obligations independently re-read complete facts, not this receipt.
  RETURN QUERY
    WITH pending AS MATERIALIZED (
      SELECT p.id,p."targetSegmentRevisionId",p."targetAllocationRevisionId"
      FROM public."CorrectionPendingTimeAllocation" p WHERE p."applicationId"=app_id
    ), proof AS MATERIALIZED (
      SELECT p.id,p."sourceSnapshotJson" FROM public."CorrectionTimeSourceProof" p
      WHERE p."applicationId"=app_id
    )
    SELECT app_id,phase_batch,
      (SELECT pg_catalog.jsonb_array_length(p."sourceSnapshotJson") FROM proof p),
      (SELECT count(*)::integer FROM pending p JOIN public."ParticipantServiceSegmentRevision" s
        ON s.id=p."targetSegmentRevisionId" AND s."statusCode"='draft'),
      (SELECT count(*)::integer FROM pending p JOIN public."ParticipantTimeAllocationRevision" a
        ON a.id=p."targetAllocationRevisionId"),
      (SELECT count(*)::integer FROM pending p JOIN public."ParticipantTimeAllocationSlice" s
        ON s."allocationRevisionId"=p."targetAllocationRevisionId"),
      (SELECT count(*)::integer FROM pending p JOIN public."ParticipantTimeAllocationEvidence" e
        ON e."allocationRevisionId"=p."targetAllocationRevisionId"),
      (SELECT count(*)::integer FROM pending p JOIN public."ParticipantTimeAllocationCommandReceipt" r
        ON r."allocationRevisionId"=p."targetAllocationRevisionId"),
      (SELECT count(*)::integer FROM proof p JOIN public."CorrectionTimeAllocationBinding" b ON b."proofId"=p.id),
      'MATERIALIZED'::text;
END;
$entry$;

CREATE TRIGGER aa_r5_phase_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public."AttendanceCorrectionRequest" FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_write_guard();

CREATE TRIGGER aa_r5_phase_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public."CorrectionApplication" FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_write_guard();

CREATE TRIGGER aa_r5_phase_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public."CorrectionPendingSegmentRevision" FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_write_guard();

CREATE TRIGGER aa_r5_phase_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public."CorrectionPendingTimeAllocation" FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_write_guard();

CREATE TRIGGER aa_r5_phase_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public."CorrectionPendingTimeAllocationEvidence" FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_write_guard();

CREATE TRIGGER aa_r5_phase_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public."CorrectionSegmentCleanupReceipt" FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_write_guard();

CREATE TRIGGER aa_r5_phase_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public."CorrectionSegmentPreparationReceipt" FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_write_guard();

CREATE TRIGGER aa_r5_phase_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public."CorrectionTimeAllocationBinding" FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_write_guard();

CREATE TRIGGER aa_r5_phase_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public."CorrectionTimeSourceProof" FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_write_guard();

CREATE TRIGGER aa_r5_phase_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public."LedgerPostingBatch" FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_write_guard();

CREATE TRIGGER aa_r5_phase_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public."ParticipantServiceSegmentRevision" FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_write_guard();

CREATE TRIGGER aa_r5_phase_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public."ParticipantTimeAllocationCommandReceipt" FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_write_guard();

CREATE TRIGGER aa_r5_phase_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public."ParticipantTimeAllocationRevision" FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_write_guard();

CREATE TRIGGER aa_r5_phase_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public."ParticipationTimeCorrectionManifest" FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_write_guard();

CREATE CONSTRAINT TRIGGER correction_application_preparation_receipt_required AFTER INSERT ON public."CorrectionWritePhase" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_terminal();

CREATE CONSTRAINT TRIGGER correction_cleanup_lifecycle_check AFTER INSERT ON public."CorrectionWritePhase" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_terminal();

CREATE CONSTRAINT TRIGGER correction_pending_lifecycle_check AFTER INSERT ON public."CorrectionWritePhase" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_terminal();

CREATE CONSTRAINT TRIGGER correction_preparation_lifecycle_check AFTER INSERT ON public."CorrectionWritePhase" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_terminal();

CREATE CONSTRAINT TRIGGER cpta_lifecycle_guard AFTER INSERT ON public."CorrectionWritePhase" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_terminal();

CREATE CONSTRAINT TRIGGER cptae_lifecycle_guard AFTER INSERT ON public."CorrectionWritePhase" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_terminal();

CREATE CONSTRAINT TRIGGER ctsp_lifecycle_batch_guard AFTER INSERT ON public."CorrectionWritePhase" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_terminal();

CREATE CONSTRAINT TRIGGER ctsp_lifecycle_proof_guard AFTER INSERT ON public."CorrectionWritePhase" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_terminal();

CREATE TRIGGER r5_assign_approved_input_revision BEFORE INSERT OR UPDATE ON public."AttendanceCorrectionRequest" FOR EACH ROW EXECUTE FUNCTION public.r5_assign_approved_input_revision();

CREATE TRIGGER r5_phase_no_truncate BEFORE TRUNCATE ON public."CorrectionWritePhase" FOR EACH STATEMENT EXECUTE FUNCTION public.r5_correction_phase_row_guard();

CREATE TRIGGER r5_phase_row_guard BEFORE INSERT OR DELETE OR UPDATE ON public."CorrectionWritePhase" FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_row_guard();

CREATE TRIGGER zz_r5_sync_approved_input_items AFTER INSERT OR DELETE OR UPDATE ON public."AttendanceCorrectionRequest" FOR EACH ROW EXECUTE FUNCTION public.r5_sync_approved_input_items();

CREATE POLICY r5_approved_input_source_visibility ON public."CorrectionApprovedInputItem" FOR SELECT TO r5_boundary_caller_h7c6 USING ((has_column_privilege(CURRENT_USER, 'public."AttendanceCorrectionRequest"'::text, 'requestedChangeJson'::text, 'SELECT'::text) AND (EXISTS ( SELECT 1
   FROM public."AttendanceCorrectionRequest" s
  WHERE ((s.id = "CorrectionApprovedInputItem".request_id) AND (s.r5_source_revision = "CorrectionApprovedInputItem".source_revision))))));

CREATE POLICY r5_phase_source_visibility ON public."CorrectionWritePhase" TO r5_boundary_caller_h7c6 USING ((EXISTS ( SELECT 1
   FROM (public."CorrectionApplication" a
     JOIN public."AttendanceCorrectionRequest" q ON ((q.id = a."correctionRequestId")))
  WHERE (a.id = "CorrectionWritePhase"."applicationId")))) WITH CHECK ((EXISTS ( SELECT 1
   FROM (public."CorrectionApplication" a
     JOIN public."AttendanceCorrectionRequest" q ON ((q.id = a."correctionRequestId")))
  WHERE (a.id = "CorrectionWritePhase"."applicationId"))));

CREATE TRIGGER r5_phase_materialize_facts AFTER UPDATE OF state ON public."CorrectionWritePhase"
FOR EACH ROW WHEN(OLD.state='OPEN' AND NEW.state='MATERIALIZED' AND NEW.phase='commit')
EXECUTE FUNCTION public.r5_correction_materialize_facts();

GRANT USAGE ON SCHEMA public TO r5_boundary_caller_h7c6;

GRANT USAGE ON SCHEMA public TO r5_boundary_owner_h7c6;

GRANT SELECT ON TABLE public."ContributionShadowLegacySourceAnchor" TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public."ContributionPolicyVersion" TO r5_boundary_caller_h7c6;

GRANT SELECT,INSERT,UPDATE ON TABLE public."ActivitySettlementContributionRevision" TO r5_boundary_caller_h7c6;

GRANT SELECT,INSERT,UPDATE ON TABLE public."ParticipantContributionEvaluation" TO r5_boundary_caller_h7c6;

GRANT SELECT,INSERT ON TABLE public."ParticipantTimeAllocationRevision" TO r5_boundary_caller_h7c6;

GRANT UPDATE(id) ON TABLE public."ParticipantTimeAllocationRevision" TO r5_boundary_caller_h7c6;

REVOKE ALL ON FUNCTION public.r5_assign_approved_input_revision() FROM PUBLIC;

REVOKE ALL ON FUNCTION public.r5_correction_assert_pending_lifecycle(app_id text) FROM PUBLIC;

GRANT ALL ON FUNCTION public.r5_correction_assert_pending_lifecycle(app_id text) TO r5_boundary_caller_h7c6;

REVOKE ALL ON FUNCTION public.r5_correction_begin_phase(app_id text, wanted_phase text) FROM PUBLIC;

GRANT ALL ON FUNCTION public.r5_correction_begin_phase(app_id text, wanted_phase text) TO r5_boundary_caller_h7c6;

REVOKE ALL ON FUNCTION public.r5_correction_boundary_preflight() FROM PUBLIC;

GRANT ALL ON FUNCTION public.r5_correction_boundary_preflight() TO r5_boundary_caller_h7c6;

REVOKE ALL ON FUNCTION public.r5_correction_phase_deferred_registered(app_id text) FROM PUBLIC;

GRANT ALL ON FUNCTION public.r5_correction_phase_deferred_registered(app_id text) TO r5_boundary_caller_h7c6;

REVOKE ALL ON FUNCTION public.r5_correction_phase_row_guard() FROM PUBLIC;

GRANT ALL ON FUNCTION public.r5_correction_phase_row_guard() TO r5_boundary_caller_h7c6;

REVOKE ALL ON FUNCTION public.r5_correction_phase_terminal() FROM PUBLIC;

GRANT ALL ON FUNCTION public.r5_correction_phase_terminal() TO r5_boundary_caller_h7c6;

REVOKE ALL ON FUNCTION public.r5_correction_phase_write_guard() FROM PUBLIC;

GRANT ALL ON FUNCTION public.r5_correction_phase_write_guard() TO r5_boundary_caller_h7c6;

REVOKE ALL ON FUNCTION public.r5_correction_require_open_phase(app_id text, wanted_phase text) FROM PUBLIC;

GRANT ALL ON FUNCTION public.r5_correction_require_open_phase(app_id text, wanted_phase text) TO r5_boundary_caller_h7c6;

REVOKE ALL ON FUNCTION public.r5_correction_seal_phase(app_id text, wanted_phase text) FROM PUBLIC;

GRANT ALL ON FUNCTION public.r5_correction_seal_phase(app_id text, wanted_phase text) TO r5_boundary_caller_h7c6;

REVOKE ALL ON FUNCTION public.r5_sync_approved_input_items() FROM PUBLIC;

GRANT SELECT,INSERT,UPDATE ON TABLE public."Activity" TO r5_boundary_caller_h7c6;

GRANT SELECT,INSERT,UPDATE ON TABLE public."ActivityBatchJob" TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public."ActivityContributionPolicySelectionItem" TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public."ActivityContributionPolicySelectionRevision" TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public."ActivityEvidenceState" TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public."ActivityParticipationIdentity" TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public."ActivityRuleSnapshot" TO r5_boundary_caller_h7c6;

GRANT UPDATE(id) ON TABLE public."ActivityRuleSnapshot" TO r5_boundary_caller_h7c6;

GRANT SELECT,UPDATE ON TABLE public."ActivitySettlementClosureRevision" TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public."ActivitySettlementTimeCommandReceipt" TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public."ActivitySettlementTimeRevision" TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public."ActivityTimeCutoverReceipt" TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public."ActivityTimePolicySelectionItem" TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public."ActivityTimePolicySelectionRevision" TO r5_boundary_caller_h7c6;

GRANT UPDATE(id) ON TABLE public."ActivityTimePolicySelectionRevision" TO r5_boundary_caller_h7c6;

GRANT SELECT,INSERT,UPDATE ON TABLE public."AttendanceCorrectionRequest" TO r5_boundary_caller_h7c6;

GRANT SELECT(r5_source_revision) ON TABLE public."AttendanceCorrectionRequest" TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public."AttendancePunchEvent" TO r5_boundary_caller_h7c6;

GRANT SELECT,INSERT,UPDATE ON TABLE public."AttendanceSettlementRun" TO r5_boundary_caller_h7c6;

GRANT SELECT,INSERT,UPDATE ON TABLE public."AttendanceSettlementVersion" TO r5_boundary_caller_h7c6;

GRANT SELECT,INSERT,UPDATE ON TABLE public."CorrectionApplication" TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public."CorrectionApprovedInputItem" TO r5_boundary_caller_h7c6;

GRANT SELECT,INSERT,UPDATE ON TABLE public."CorrectionPendingSegmentRevision" TO r5_boundary_caller_h7c6;

GRANT SELECT,INSERT,UPDATE ON TABLE public."CorrectionPendingTimeAllocation" TO r5_boundary_caller_h7c6;

GRANT SELECT,INSERT,UPDATE ON TABLE public."CorrectionPendingTimeAllocationEvidence" TO r5_boundary_caller_h7c6;

GRANT SELECT,INSERT,UPDATE ON TABLE public."CorrectionSegmentCleanupReceipt" TO r5_boundary_caller_h7c6;

GRANT SELECT,INSERT,UPDATE ON TABLE public."CorrectionSegmentPreparationReceipt" TO r5_boundary_caller_h7c6;

GRANT SELECT,INSERT,UPDATE ON TABLE public."CorrectionTimeAllocationBinding" TO r5_boundary_caller_h7c6;

GRANT SELECT,INSERT ON TABLE public."CorrectionTimeSourceProof" TO r5_boundary_caller_h7c6;

GRANT UPDATE(id) ON TABLE public."CorrectionTimeSourceProof" TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public."CorrectionWritePhase" TO r5_boundary_caller_h7c6;

GRANT INSERT("applicationId") ON TABLE public."CorrectionWritePhase" TO r5_boundary_caller_h7c6;

GRANT INSERT(phase) ON TABLE public."CorrectionWritePhase" TO r5_boundary_caller_h7c6;

GRANT UPDATE(state) ON TABLE public."CorrectionWritePhase" TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public."EvidenceSeal" TO r5_boundary_caller_h7c6;

GRANT SELECT,INSERT,UPDATE ON TABLE public."LedgerEntryReversalClaim" TO r5_boundary_caller_h7c6;

GRANT SELECT,INSERT,UPDATE ON TABLE public."LedgerPostingBatch" TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public."Member" TO r5_boundary_caller_h7c6;

GRANT SELECT,INSERT,UPDATE ON TABLE public."MemberContributionDayState" TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public."Organization" TO r5_boundary_caller_h7c6;

GRANT SELECT,INSERT,UPDATE ON TABLE public."ParticipantServiceSegmentRevision" TO r5_boundary_caller_h7c6;

GRANT SELECT,INSERT,UPDATE ON TABLE public."ParticipantSettlementDay" TO r5_boundary_caller_h7c6;

GRANT SELECT,INSERT,UPDATE ON TABLE public."ParticipantSettlementResultRevision" TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public."ParticipantSettlementTimeBucket" TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public."ParticipantSettlementTimeBucketSource" TO r5_boundary_caller_h7c6;

GRANT SELECT,INSERT,UPDATE ON TABLE public."ParticipantTimeAllocationCommandReceipt" TO r5_boundary_caller_h7c6;

GRANT SELECT,INSERT,UPDATE ON TABLE public."ParticipantTimeAllocationEvidence" TO r5_boundary_caller_h7c6;

GRANT SELECT,INSERT ON TABLE public."ParticipantTimeAllocationSlice" TO r5_boundary_caller_h7c6;

GRANT SELECT,INSERT,UPDATE ON TABLE public."ParticipationLedgerEntry" TO r5_boundary_caller_h7c6;

GRANT SELECT,INSERT,UPDATE ON TABLE public."ParticipationTimeCorrectionCommitReceipt" TO r5_boundary_caller_h7c6;

GRANT SELECT,INSERT ON TABLE public."ParticipationTimeCorrectionEntry" TO r5_boundary_caller_h7c6;

GRANT SELECT,INSERT ON TABLE public."ParticipationTimeCorrectionManifest" TO r5_boundary_caller_h7c6;

GRANT UPDATE(id) ON TABLE public."ParticipationTimeCorrectionManifest" TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public."ParticipationTimeCutoverBinding" TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public."ParticipationTimeLedgerEntry" TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public."ParticipationTimeLedgerManifest" TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public."SettlementReviewAction" TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public."TimePolicyVersion" TO r5_boundary_caller_h7c6;

GRANT UPDATE(id) ON TABLE public."TimePolicyVersion" TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public."User" TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public.activity_responsibility_assignments TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public.attachments TO r5_boundary_caller_h7c6;

GRANT UPDATE(id) ON TABLE public.attachments TO r5_boundary_caller_h7c6;

GRANT SELECT,INSERT,UPDATE ON TABLE public.audit_logs TO r5_boundary_caller_h7c6;

GRANT SELECT,INSERT,UPDATE ON TABLE public.notification_outbox_intents TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public.organization_closure TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public.organization_position_assignments TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public.organization_supervision_assignments TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public.permissions TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public.role_bindings TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public.role_permissions TO r5_boundary_caller_h7c6;

GRANT SELECT ON TABLE public.roles TO r5_boundary_caller_h7c6;

GRANT INSERT,SELECT,UPDATE ON TABLE public."Activity" TO "r5_boundary_caller_h7c6";

GRANT SELECT ON TABLE public."ActivityParticipationIdentity" TO "r5_boundary_caller_h7c6";

GRANT INSERT,SELECT,UPDATE ON TABLE public."AttendanceCorrectionRequest" TO "r5_boundary_caller_h7c6";

GRANT SELECT ON TABLE public."AttendanceCorrectionRequest" TO "r5_mat_writer_20261029_q1";

GRANT UPDATE ("id") ON TABLE public."AttendanceCorrectionRequest" TO "r5_mat_writer_20261029_q1";

GRANT SELECT ("r5_source_revision") ON TABLE public."AttendanceCorrectionRequest" TO "r5_boundary_caller_h7c6";

GRANT INSERT,SELECT,UPDATE ON TABLE public."AttendanceSettlementRun" TO "r5_boundary_caller_h7c6";

GRANT INSERT,SELECT,UPDATE ON TABLE public."CorrectionApplication" TO "r5_boundary_caller_h7c6";

GRANT SELECT ON TABLE public."CorrectionApplication" TO "r5_mat_writer_20261029_q1";

GRANT UPDATE ("id") ON TABLE public."CorrectionApplication" TO "r5_mat_writer_20261029_q1";

GRANT INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public."CorrectionApprovedInputItem" TO "r5_boundary_owner_h7c6";

GRANT SELECT ON TABLE public."CorrectionApprovedInputItem" TO "r5_boundary_caller_h7c6";

GRANT INSERT,SELECT,UPDATE ON TABLE public."CorrectionPendingSegmentRevision" TO "r5_boundary_caller_h7c6";

GRANT SELECT ON TABLE public."CorrectionPendingSegmentRevision" TO "r5_mat_writer_20261029_q1";

GRANT UPDATE ("id") ON TABLE public."CorrectionPendingSegmentRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT,SELECT,UPDATE ON TABLE public."CorrectionPendingTimeAllocation" TO "r5_boundary_caller_h7c6";

GRANT SELECT ON TABLE public."CorrectionPendingTimeAllocation" TO "r5_mat_writer_20261029_q1";

GRANT UPDATE ("id") ON TABLE public."CorrectionPendingTimeAllocation" TO "r5_mat_writer_20261029_q1";

GRANT INSERT,SELECT,UPDATE ON TABLE public."CorrectionPendingTimeAllocationEvidence" TO "r5_boundary_caller_h7c6";

GRANT SELECT ON TABLE public."CorrectionPendingTimeAllocationEvidence" TO "r5_mat_writer_20261029_q1";

GRANT INSERT,SELECT,UPDATE ON TABLE public."CorrectionSegmentCleanupReceipt" TO "r5_boundary_caller_h7c6";

GRANT INSERT,SELECT,UPDATE ON TABLE public."CorrectionSegmentPreparationReceipt" TO "r5_boundary_caller_h7c6";

GRANT INSERT,SELECT,UPDATE ON TABLE public."CorrectionTimeAllocationBinding" TO "r5_boundary_caller_h7c6";

GRANT SELECT ON TABLE public."CorrectionTimeAllocationBinding" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("id") ON TABLE public."CorrectionTimeAllocationBinding" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("proofId") ON TABLE public."CorrectionTimeAllocationBinding" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("activityId") ON TABLE public."CorrectionTimeAllocationBinding" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("participationIdentityId") ON TABLE public."CorrectionTimeAllocationBinding" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("segmentKey") ON TABLE public."CorrectionTimeAllocationBinding" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("allocationRevisionId") ON TABLE public."CorrectionTimeAllocationBinding" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("sourceSegmentId") ON TABLE public."CorrectionTimeAllocationBinding" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("sourceSegmentRevision") ON TABLE public."CorrectionTimeAllocationBinding" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("pendingAllocationId") ON TABLE public."CorrectionTimeAllocationBinding" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("sourceHash") ON TABLE public."CorrectionTimeAllocationBinding" TO "r5_mat_writer_20261029_q1";

GRANT INSERT,SELECT ON TABLE public."CorrectionTimeSourceProof" TO "r5_boundary_caller_h7c6";

GRANT SELECT ON TABLE public."CorrectionTimeSourceProof" TO "r5_mat_writer_20261029_q1";

GRANT UPDATE ("id") ON TABLE public."CorrectionTimeSourceProof" TO "r5_boundary_caller_h7c6";

GRANT UPDATE ("id") ON TABLE public."CorrectionTimeSourceProof" TO "r5_mat_writer_20261029_q1";

GRANT INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public."CorrectionWritePhase" TO "r5_boundary_owner_h7c6";

GRANT SELECT ON TABLE public."CorrectionWritePhase" TO "r5_boundary_caller_h7c6";

GRANT INSERT ("applicationId") ON TABLE public."CorrectionWritePhase" TO "r5_boundary_caller_h7c6";

GRANT INSERT ("phase") ON TABLE public."CorrectionWritePhase" TO "r5_boundary_caller_h7c6";

GRANT UPDATE ("state") ON TABLE public."CorrectionWritePhase" TO "r5_boundary_caller_h7c6";

GRANT UPDATE ("materializedByUserId") ON TABLE public."CorrectionWritePhase" TO "r5_boundary_caller_h7c6";

GRANT INSERT,SELECT,UPDATE ON TABLE public."LedgerPostingBatch" TO "r5_boundary_caller_h7c6";

GRANT SELECT ON TABLE public."LedgerPostingBatch" TO "r5_mat_writer_20261029_q1";

GRANT UPDATE ("id") ON TABLE public."LedgerPostingBatch" TO "r5_mat_writer_20261029_q1";

GRANT INSERT,SELECT,UPDATE ON TABLE public."ParticipantServiceSegmentRevision" TO "r5_boundary_caller_h7c6";

GRANT SELECT ON TABLE public."ParticipantServiceSegmentRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("id") ON TABLE public."ParticipantServiceSegmentRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("updatedAt"),UPDATE ("updatedAt") ON TABLE public."ParticipantServiceSegmentRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("participationIdentityId") ON TABLE public."ParticipantServiceSegmentRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("segmentKey") ON TABLE public."ParticipantServiceSegmentRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("revision") ON TABLE public."ParticipantServiceSegmentRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("sourceCheckInEventId") ON TABLE public."ParticipantServiceSegmentRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("resultCode") ON TABLE public."ParticipantServiceSegmentRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("statusCode"),UPDATE ("statusCode") ON TABLE public."ParticipantServiceSegmentRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("checkInAt") ON TABLE public."ParticipantServiceSegmentRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("checkOutAt") ON TABLE public."ParticipantServiceSegmentRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("serviceHours") ON TABLE public."ParticipantServiceSegmentRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("baseRevisionId") ON TABLE public."ParticipantServiceSegmentRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT,SELECT,UPDATE ON TABLE public."ParticipantTimeAllocationCommandReceipt" TO "r5_boundary_caller_h7c6";

GRANT SELECT ON TABLE public."ParticipantTimeAllocationCommandReceipt" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("id") ON TABLE public."ParticipantTimeAllocationCommandReceipt" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("actorUserId") ON TABLE public."ParticipantTimeAllocationCommandReceipt" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("activityId") ON TABLE public."ParticipantTimeAllocationCommandReceipt" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("operationCode") ON TABLE public."ParticipantTimeAllocationCommandReceipt" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("operationKey") ON TABLE public."ParticipantTimeAllocationCommandReceipt" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("requestHash") ON TABLE public."ParticipantTimeAllocationCommandReceipt" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("allocationRevisionId") ON TABLE public."ParticipantTimeAllocationCommandReceipt" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("resultJson") ON TABLE public."ParticipantTimeAllocationCommandReceipt" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("createdAt") ON TABLE public."ParticipantTimeAllocationCommandReceipt" TO "r5_mat_writer_20261029_q1";

GRANT INSERT,SELECT,UPDATE ON TABLE public."ParticipantTimeAllocationEvidence" TO "r5_boundary_caller_h7c6";

GRANT SELECT ON TABLE public."ParticipantTimeAllocationEvidence" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("id") ON TABLE public."ParticipantTimeAllocationEvidence" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("allocationRevisionId") ON TABLE public."ParticipantTimeAllocationEvidence" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("activityId") ON TABLE public."ParticipantTimeAllocationEvidence" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("attachmentId") ON TABLE public."ParticipantTimeAllocationEvidence" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("ordinal") ON TABLE public."ParticipantTimeAllocationEvidence" TO "r5_mat_writer_20261029_q1";

GRANT INSERT,SELECT ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_boundary_caller_h7c6";

GRANT SELECT ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT UPDATE ("id") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_boundary_caller_h7c6";

GRANT INSERT ("id"),UPDATE ("id") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("createdAt") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("activityId") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("sessionId") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("memberId") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("participationIdentityId") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("segmentKey") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("revision") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("previousAllocationRevisionId") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("sourceSegmentId") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("sourceSegmentRevision") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("sourcePositionId") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("ruleSnapshotId") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("ruleSnapshotHash") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("timePolicySelectionRevisionId") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("selectionHash") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("policyId") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("policyVersionId") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("definitionHash") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("evaluatorVersion") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("recognitionModeCode") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("manualReason") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("allocationJson") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("allocationHash") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("sliceCount") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("createdByUserId") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("settlementDraftContentHash") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("settlementDraftVersionId") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("settlementEvidenceRevision") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("settlementEvidenceSealId") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("settlementPopulationRevision") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("settlementWorkflowRevision") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("correctionPendingAllocationId") ON TABLE public."ParticipantTimeAllocationRevision" TO "r5_mat_writer_20261029_q1";

GRANT INSERT,SELECT ON TABLE public."ParticipantTimeAllocationSlice" TO "r5_boundary_caller_h7c6";

GRANT SELECT ON TABLE public."ParticipantTimeAllocationSlice" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("id") ON TABLE public."ParticipantTimeAllocationSlice" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("allocationRevisionId") ON TABLE public."ParticipantTimeAllocationSlice" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("activityId") ON TABLE public."ParticipantTimeAllocationSlice" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("ordinal") ON TABLE public."ParticipantTimeAllocationSlice" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("categoryCode") ON TABLE public."ParticipantTimeAllocationSlice" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("intervalKindCode") ON TABLE public."ParticipantTimeAllocationSlice" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("startAt") ON TABLE public."ParticipantTimeAllocationSlice" TO "r5_mat_writer_20261029_q1";

GRANT INSERT ("endAt") ON TABLE public."ParticipantTimeAllocationSlice" TO "r5_mat_writer_20261029_q1";

GRANT INSERT,SELECT ON TABLE public."ParticipationTimeCorrectionManifest" TO "r5_boundary_caller_h7c6";

GRANT UPDATE ("id") ON TABLE public."ParticipationTimeCorrectionManifest" TO "r5_boundary_caller_h7c6";

GRANT SELECT ON TABLE public."TimePolicyVersion" TO "r5_boundary_caller_h7c6";

GRANT SELECT ON TABLE public."TimePolicyVersion" TO "r5_mat_writer_20261029_q1";

GRANT UPDATE ("id") ON TABLE public."TimePolicyVersion" TO "r5_boundary_caller_h7c6";

GRANT UPDATE ("id") ON TABLE public."TimePolicyVersion" TO "r5_mat_writer_20261029_q1";

GRANT SELECT ON TABLE public."User" TO "r5_boundary_caller_h7c6";

GRANT SELECT ON TABLE public."attachments" TO "r5_boundary_caller_h7c6";

GRANT SELECT ON TABLE public."attachments" TO "r5_mat_writer_20261029_q1";

GRANT UPDATE ("id") ON TABLE public."attachments" TO "r5_boundary_caller_h7c6";

GRANT UPDATE ("id") ON TABLE public."attachments" TO "r5_mat_writer_20261029_q1";

GRANT SELECT ON TABLE public."organization_position_assignments" TO "r5_boundary_caller_h7c6";

GRANT SELECT ("id") ON TABLE public."storage_objects" TO "r5_boundary_caller_h7c6";

GRANT SELECT ("key") ON TABLE public."storage_objects" TO "r5_boundary_caller_h7c6";

GRANT SELECT ("state") ON TABLE public."storage_objects" TO "r5_boundary_caller_h7c6";

GRANT SELECT ("resourceType") ON TABLE public."storage_objects" TO "r5_boundary_caller_h7c6";

GRANT SELECT ("resourceId") ON TABLE public."storage_objects" TO "r5_boundary_caller_h7c6";

GRANT SELECT ("deleteRequestedAt") ON TABLE public."storage_objects" TO "r5_boundary_caller_h7c6";

GRANT INSERT,SELECT,UPDATE ON TABLE public."ActivityBatchJob" TO "r5_boundary_caller_h7c6";

GRANT INSERT ("id"),SELECT ("id") ON TABLE public."ActivityBatchJobItem" TO "r5_human_queue_login_20261030_q1";

GRANT INSERT ("createdAt"),SELECT ("createdAt") ON TABLE public."ActivityBatchJobItem" TO "r5_human_queue_login_20261030_q1";

GRANT INSERT ("updatedAt"),SELECT ("updatedAt"),UPDATE ("updatedAt") ON TABLE public."ActivityBatchJobItem" TO "r5_human_queue_login_20261030_q1";

GRANT INSERT ("jobId"),SELECT ("jobId") ON TABLE public."ActivityBatchJobItem" TO "r5_human_queue_login_20261030_q1";

GRANT INSERT ("itemKey"),SELECT ("itemKey") ON TABLE public."ActivityBatchJobItem" TO "r5_human_queue_login_20261030_q1";

GRANT INSERT ("statusCode"),SELECT ("statusCode"),UPDATE ("statusCode") ON TABLE public."ActivityBatchJobItem" TO "r5_human_queue_login_20261030_q1";

GRANT INSERT ("attempts"),SELECT ("attempts"),UPDATE ("attempts") ON TABLE public."ActivityBatchJobItem" TO "r5_human_queue_login_20261030_q1";

GRANT SELECT ("lastErrorCode"),UPDATE ("lastErrorCode") ON TABLE public."ActivityBatchJobItem" TO "r5_human_queue_login_20261030_q1";

GRANT SELECT ("safeMessage"),UPDATE ("safeMessage") ON TABLE public."ActivityBatchJobItem" TO "r5_human_queue_login_20261030_q1";

GRANT INSERT ("resourceType"),SELECT ("resourceType") ON TABLE public."ActivityBatchJobItem" TO "r5_human_queue_login_20261030_q1";

GRANT INSERT ("resourceId"),SELECT ("resourceId") ON TABLE public."ActivityBatchJobItem" TO "r5_human_queue_login_20261030_q1";

GRANT INSERT ("payloadHash"),SELECT ("payloadHash") ON TABLE public."ActivityBatchJobItem" TO "r5_human_queue_login_20261030_q1";

GRANT INSERT ("resultReference"),SELECT ("resultReference"),UPDATE ("resultReference") ON TABLE public."ActivityBatchJobItem" TO "r5_human_queue_login_20261030_q1";

GRANT USAGE ON SCHEMA public TO r5_mat_writer_20261029_q1;

GRANT SELECT ON TABLE public."AttendanceCorrectionRequest" TO r5_mat_writer_20261029_q1;

GRANT SELECT ON TABLE public."CorrectionApplication" TO r5_mat_writer_20261029_q1;

GRANT SELECT ON TABLE public."CorrectionPendingSegmentRevision" TO r5_mat_writer_20261029_q1;

GRANT SELECT ON TABLE public."CorrectionPendingTimeAllocation" TO r5_mat_writer_20261029_q1;

GRANT SELECT ON TABLE public."CorrectionPendingTimeAllocationEvidence" TO r5_mat_writer_20261029_q1;

GRANT SELECT ON TABLE public."CorrectionTimeSourceProof" TO r5_mat_writer_20261029_q1;

GRANT SELECT ON TABLE public."LedgerPostingBatch" TO r5_mat_writer_20261029_q1;

GRANT SELECT ON TABLE public."ParticipantServiceSegmentRevision" TO r5_mat_writer_20261029_q1;

GRANT SELECT ON TABLE public."ParticipantTimeAllocationRevision" TO r5_mat_writer_20261029_q1;

GRANT SELECT ON TABLE public."ParticipantTimeAllocationSlice" TO r5_mat_writer_20261029_q1;

GRANT SELECT ON TABLE public."ParticipantTimeAllocationEvidence" TO r5_mat_writer_20261029_q1;

GRANT SELECT ON TABLE public."ParticipantTimeAllocationCommandReceipt" TO r5_mat_writer_20261029_q1;

GRANT SELECT ON TABLE public."CorrectionTimeAllocationBinding" TO r5_mat_writer_20261029_q1;

GRANT SELECT ON TABLE public."TimePolicyVersion" TO r5_mat_writer_20261029_q1;

GRANT SELECT ON TABLE public.attachments TO r5_mat_writer_20261029_q1;

GRANT INSERT (id, "updatedAt", "participationIdentityId", "segmentKey", revision, "sourceCheckInEventId", "resultCode", "statusCode", "checkInAt", "checkOutAt", "serviceHours", "baseRevisionId") ON TABLE public."ParticipantServiceSegmentRevision" TO r5_mat_writer_20261029_q1;

GRANT INSERT (id, "createdAt", "activityId", "sessionId", "memberId", "participationIdentityId", "segmentKey", revision, "previousAllocationRevisionId", "sourceSegmentId", "sourceSegmentRevision", "sourcePositionId", "ruleSnapshotId", "ruleSnapshotHash", "timePolicySelectionRevisionId", "selectionHash", "policyId", "policyVersionId", "definitionHash", "evaluatorVersion", "recognitionModeCode", "manualReason", "allocationJson", "allocationHash", "sliceCount", "createdByUserId", "settlementDraftContentHash", "settlementDraftVersionId", "settlementEvidenceRevision", "settlementEvidenceSealId", "settlementPopulationRevision", "settlementWorkflowRevision", "correctionPendingAllocationId") ON TABLE public."ParticipantTimeAllocationRevision" TO r5_mat_writer_20261029_q1;

GRANT INSERT (id, "allocationRevisionId", "activityId", ordinal, "categoryCode", "intervalKindCode", "startAt", "endAt") ON TABLE public."ParticipantTimeAllocationSlice" TO r5_mat_writer_20261029_q1;

GRANT INSERT (id, "allocationRevisionId", "activityId", "attachmentId", ordinal) ON TABLE public."ParticipantTimeAllocationEvidence" TO r5_mat_writer_20261029_q1;

GRANT INSERT (id, "actorUserId", "activityId", "operationCode", "operationKey", "requestHash", "allocationRevisionId", "resultJson", "createdAt") ON TABLE public."ParticipantTimeAllocationCommandReceipt" TO r5_mat_writer_20261029_q1;

GRANT INSERT (id, "proofId", "activityId", "participationIdentityId", "segmentKey", "allocationRevisionId", "sourceSegmentId", "sourceSegmentRevision", "pendingAllocationId", "sourceHash") ON TABLE public."CorrectionTimeAllocationBinding" TO r5_mat_writer_20261029_q1;

GRANT UPDATE ("statusCode", "updatedAt") ON TABLE public."ParticipantServiceSegmentRevision" TO r5_mat_writer_20261029_q1;

GRANT UPDATE (id) ON TABLE public."AttendanceCorrectionRequest" TO r5_mat_writer_20261029_q1;

GRANT UPDATE (id) ON TABLE public."CorrectionApplication" TO r5_mat_writer_20261029_q1;

GRANT UPDATE (id) ON TABLE public."CorrectionPendingSegmentRevision" TO r5_mat_writer_20261029_q1;

GRANT UPDATE (id) ON TABLE public."CorrectionPendingTimeAllocation" TO r5_mat_writer_20261029_q1;

GRANT UPDATE (id) ON TABLE public."CorrectionTimeSourceProof" TO r5_mat_writer_20261029_q1;

GRANT UPDATE (id) ON TABLE public."LedgerPostingBatch" TO r5_mat_writer_20261029_q1;

GRANT UPDATE (id) ON TABLE public."ParticipantTimeAllocationRevision" TO r5_mat_writer_20261029_q1;

GRANT UPDATE (id) ON TABLE public."TimePolicyVersion" TO r5_mat_writer_20261029_q1;

GRANT UPDATE (id) ON TABLE public.attachments TO r5_mat_writer_20261029_q1;

GRANT EXECUTE ON FUNCTION public.r5_correction_phase_write_guard () TO r5_mat_writer_20261029_q1;

GRANT EXECUTE ON FUNCTION public.ptar_correction_insert_guard () TO r5_mat_writer_20261029_q1;

GRANT EXECUTE ON FUNCTION public.ptar_slice_guard () TO r5_mat_writer_20261029_q1;

GRANT EXECUTE ON FUNCTION public.ptar_evidence_guard () TO r5_mat_writer_20261029_q1;

GRANT EXECUTE ON FUNCTION public.ptacr_correction_receipt_insert_guard () TO r5_mat_writer_20261029_q1;

GRANT EXECUTE ON FUNCTION public.ctab_insert_guard () TO r5_mat_writer_20261029_q1;

GRANT EXECUTE ON FUNCTION public.ptar_parent_complete_guard () TO r5_mat_writer_20261029_q1;

REVOKE ALL PRIVILEGES ON FUNCTION public.r5_correction_materialize_facts () FROM PUBLIC, r5_boundary_caller_h7c6;

ALTER FUNCTION public.r5_correction_materialize_facts () OWNER TO r5_mat_writer_20261029_q1;

REVOKE ALL PRIVILEGES ON FUNCTION public.r5_correction_materialize_phase (text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.r5_correction_materialize_phase (text, text) TO r5_boundary_caller_h7c6;

REVOKE ALL PRIVILEGES ON FUNCTION public.r5_correction_assert_materialization_set (text, text, timestamp) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.r5_correction_assert_materialization_set (text, text, timestamp) TO r5_boundary_caller_h7c6;

GRANT UPDATE ("materializedByUserId") ON TABLE public."CorrectionWritePhase" TO r5_boundary_caller_h7c6;

ALTER FUNCTION public.correction_pending_segment_guard() OWNER TO "postgres";

ALTER FUNCTION public.correction_segment_lifecycle_check() OWNER TO "postgres";

ALTER FUNCTION public.cpta_insert_guard() OWNER TO "postgres";

ALTER FUNCTION public.ctsp_lifecycle_guard() OWNER TO "postgres";

ALTER FUNCTION public.e4_assert_complete(text,boolean) OWNER TO "postgres";

ALTER FUNCTION public.ptar_slice_guard() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.ptar_slice_guard() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.ptar_slice_guard() TO PUBLIC;

GRANT EXECUTE ON FUNCTION public.ptar_slice_guard() TO "r5_mat_writer_20261029_q1";

ALTER FUNCTION public.r5_assign_approved_input_revision() OWNER TO "r5_boundary_owner_h7c6";

ALTER FUNCTION public.r5_correction_assert_pending_lifecycle(text) OWNER TO "r5_boundary_owner_h7c6";

REVOKE ALL ON FUNCTION public.r5_correction_assert_pending_lifecycle(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.r5_correction_assert_pending_lifecycle(text) TO "r5_boundary_caller_h7c6";

ALTER FUNCTION public.r5_correction_begin_phase(text,text) OWNER TO "r5_boundary_owner_h7c6";

REVOKE ALL ON FUNCTION public.r5_correction_begin_phase(text,text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.r5_correction_begin_phase(text,text) TO "r5_boundary_caller_h7c6";

ALTER FUNCTION public.r5_correction_boundary_preflight() OWNER TO "r5_boundary_owner_h7c6";

GRANT EXECUTE ON FUNCTION public.r5_correction_boundary_preflight() TO "r5_boundary_caller_h7c6";

ALTER FUNCTION public.r5_correction_phase_deferred_registered(text) OWNER TO "r5_boundary_owner_h7c6";

REVOKE ALL ON FUNCTION public.r5_correction_phase_deferred_registered(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.r5_correction_phase_deferred_registered(text) TO "r5_boundary_caller_h7c6";

ALTER FUNCTION public.r5_correction_phase_row_guard() OWNER TO "r5_boundary_owner_h7c6";

GRANT EXECUTE ON FUNCTION public.r5_correction_phase_row_guard() TO "r5_boundary_caller_h7c6";

ALTER FUNCTION public.r5_correction_phase_terminal() OWNER TO "r5_boundary_owner_h7c6";

GRANT EXECUTE ON FUNCTION public.r5_correction_phase_terminal() TO "r5_boundary_caller_h7c6";

ALTER FUNCTION public.r5_correction_phase_write_guard() OWNER TO "r5_boundary_owner_h7c6";

GRANT EXECUTE ON FUNCTION public.r5_correction_phase_write_guard() TO "r5_boundary_caller_h7c6";

GRANT EXECUTE ON FUNCTION public.r5_correction_phase_write_guard() TO "r5_mat_writer_20261029_q1";

ALTER FUNCTION public.r5_correction_require_open_phase(text,text) OWNER TO "r5_boundary_owner_h7c6";

REVOKE ALL ON FUNCTION public.r5_correction_require_open_phase(text,text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.r5_correction_require_open_phase(text,text) TO "r5_boundary_caller_h7c6";

ALTER FUNCTION public.r5_correction_seal_phase(text,text) OWNER TO "r5_boundary_owner_h7c6";

REVOKE ALL ON FUNCTION public.r5_correction_seal_phase(text,text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.r5_correction_seal_phase(text,text) TO "r5_boundary_caller_h7c6";

ALTER FUNCTION public.r5_sync_approved_input_items() OWNER TO "r5_boundary_owner_h7c6";

ALTER FUNCTION public.r5_correction_assert_materialization_set(text,text,timestamp without time zone) OWNER TO "r5_boundary_owner_h7c6";

REVOKE ALL ON FUNCTION public.r5_correction_assert_materialization_set(text,text,timestamp without time zone) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.r5_correction_assert_materialization_set(text,text,timestamp without time zone) TO "r5_boundary_caller_h7c6";

ALTER FUNCTION public.r5_correction_materialize_facts() OWNER TO "r5_mat_writer_20261029_q1";

REVOKE ALL ON FUNCTION public.r5_correction_materialize_facts() FROM PUBLIC;

ALTER FUNCTION public.r5_correction_materialize_phase(text,text) OWNER TO "r5_boundary_owner_h7c6";

REVOKE ALL ON FUNCTION public.r5_correction_materialize_phase(text,text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.r5_correction_materialize_phase(text,text) TO "r5_boundary_caller_h7c6";

COMMIT;
