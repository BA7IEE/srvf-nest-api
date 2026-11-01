-- ISOLATED CANDIDATE — authorized test database only; not a formal migration.
-- No CREATE ROLE, no production migration, no cached validation verdict.
-- A future approved installer must explicitly bind this exact scratch identity
-- and two already approved roles. No role or environment value is inferred.
\set ON_ERROR_STOP on
\if :{?boundary_database}
\else
DO $$ BEGIN RAISE EXCEPTION 'boundary_database is required' USING ERRCODE='22023'; END; $$;
\endif
\if :{?boundary_oid}
\else
DO $$ BEGIN RAISE EXCEPTION 'boundary_oid is required' USING ERRCODE='22023'; END; $$;
\endif
\if :{?boundary_owner}
\else
DO $$ BEGIN RAISE EXCEPTION 'boundary_owner is required' USING ERRCODE='22023'; END; $$;
\endif
\if :{?boundary_caller}
\else
DO $$ BEGIN RAISE EXCEPTION 'boundary_caller is required' USING ERRCODE='22023'; END; $$;
\endif
BEGIN;
SELECT set_config('r5_candidate.database', :'boundary_database', true),
       set_config('r5_candidate.oid', :'boundary_oid', true),
       set_config('r5_candidate.owner', :'boundary_owner', true),
       set_config('r5_candidate.caller', :'boundary_caller', true);
DO $install$
DECLARE owner_oid oid; caller_oid oid;
BEGIN
 IF current_database() IS DISTINCT FROM current_setting('r5_candidate.database')
   OR current_database() NOT LIKE 'app_test_%'
   OR (SELECT oid::text FROM pg_database WHERE datname=current_database())
       IS DISTINCT FROM current_setting('r5_candidate.oid')
   OR current_setting('r5_candidate.oid')='1713092'
 THEN RAISE EXCEPTION 'candidate scratch database identity mismatch' USING ERRCODE='42501';END IF;
 owner_oid:=to_regrole(current_setting('r5_candidate.owner'));
 caller_oid:=to_regrole(current_setting('r5_candidate.caller'));
 IF owner_oid IS NULL OR caller_oid IS NULL OR owner_oid=caller_oid
   OR EXISTS(SELECT 1 FROM pg_roles WHERE oid=ANY(ARRAY[owner_oid,caller_oid])
      AND (rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolreplication))
   OR pg_has_role(caller_oid,owner_oid,'MEMBER') THEN
   RAISE EXCEPTION 'requires two separate approved NOLOGIN least privilege roles' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM public."AttendanceCorrectionRequest") THEN
   RAISE EXCEPTION 'local candidate requires a fresh scratch baseline; no backfill authorized' USING ERRCODE='55000';END IF;
END;$install$;


-- Isolated experiment only; not a formal migration.
ALTER TABLE public."AttendanceCorrectionRequest" ADD COLUMN r5_source_revision bigint;
CREATE SEQUENCE public.r5_approved_input_revision AS bigint NO CYCLE;
ALTER SEQUENCE public.r5_approved_input_revision OWNER TO :"boundary_owner";
REVOKE ALL ON SEQUENCE public.r5_approved_input_revision FROM PUBLIC;

CREATE TABLE public."CorrectionApprovedInputItem" (
  request_id text NOT NULL,
  source_revision bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('segments','allocations')),
  ordinal integer NOT NULL,
  complete boolean NOT NULL,
  safe boolean NOT NULL,
  raw_item jsonb,
  schema_version jsonb,
  item_count integer,
  pid text,
  skey text,
  result text,
  PRIMARY KEY(request_id,kind,ordinal)
);
CREATE INDEX r5_approved_input_match ON public."CorrectionApprovedInputItem"
  (request_id,source_revision,kind,pid,skey,result);
ALTER TABLE public."CorrectionApprovedInputItem" OWNER TO :"boundary_owner";
REVOKE ALL ON public."CorrectionApprovedInputItem" FROM PUBLIC;
GRANT SELECT ON public."CorrectionApprovedInputItem" TO :"boundary_caller";
ALTER TABLE public."CorrectionApprovedInputItem" ENABLE ROW LEVEL SECURITY;
CREATE POLICY r5_approved_input_source_visibility ON public."CorrectionApprovedInputItem" FOR SELECT
 TO :"boundary_caller" USING (
 pg_catalog.has_column_privilege(current_user,'public."AttendanceCorrectionRequest"','requestedChangeJson','SELECT')
 AND EXISTS(SELECT 1 FROM public."AttendanceCorrectionRequest" s
  WHERE s.id=request_id AND s.r5_source_revision=source_revision)
);

CREATE FUNCTION public.r5_assign_approved_input_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
BEGIN
 IF TG_RELID<>'public."AttendanceCorrectionRequest"'::regclass OR TG_OP NOT IN('INSERT','UPDATE') THEN
  RAISE EXCEPTION 'wrong source relation' USING ERRCODE='42501';END IF;
 IF TG_OP='UPDATE' AND OLD.id IS NOT DISTINCT FROM NEW.id
    AND OLD."requestedChangeJson" IS NOT DISTINCT FROM NEW."requestedChangeJson" THEN
   NEW.r5_source_revision:=OLD.r5_source_revision; RETURN NEW;
 END IF;
 NEW.r5_source_revision:=nextval('public.r5_approved_input_revision'::regclass);
 RETURN NEW;
END;$f$;
ALTER FUNCTION public.r5_assign_approved_input_revision() OWNER TO :"boundary_owner";
REVOKE ALL ON FUNCTION public.r5_assign_approved_input_revision() FROM PUBLIC;
CREATE TRIGGER r5_assign_approved_input_revision BEFORE INSERT OR UPDATE ON public."AttendanceCorrectionRequest"
 FOR EACH ROW EXECUTE FUNCTION public.r5_assign_approved_input_revision();
ALTER TABLE public."AttendanceCorrectionRequest" ALTER COLUMN r5_source_revision SET NOT NULL;

CREATE FUNCTION public.r5_sync_approved_input_items() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
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
END;$f$;
ALTER FUNCTION public.r5_sync_approved_input_items() OWNER TO :"boundary_owner";
REVOKE ALL ON FUNCTION public.r5_sync_approved_input_items() FROM PUBLIC;
CREATE TRIGGER zz_r5_sync_approved_input_items AFTER INSERT OR UPDATE OR DELETE ON public."AttendanceCorrectionRequest"
 FOR EACH ROW EXECUTE FUNCTION public.r5_sync_approved_input_items();

GRANT SELECT(r5_source_revision) ON public."AttendanceCorrectionRequest" TO :"boundary_caller";


-- UNINSTALLED LOCAL CANDIDATE. Neither a migration nor permission to execute.
-- The offline assembly adds the frozen source-index and original guard bodies.
-- No validation result is cached. Every phase constraint reads current facts.

CREATE TABLE public."CorrectionWritePhase" (
  "applicationId" text NOT NULL REFERENCES public."CorrectionApplication"(id) ON DELETE RESTRICT,
  phase text NOT NULL CHECK (phase IN ('prepare','commit')),
  state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','SEALED')),
  "batchId" text NOT NULL,
  "requestId" text NOT NULL,
  "sourceRevision" bigint NOT NULL,
  "transactionId" xid8 NOT NULL,
  "actorOid" oid NOT NULL,
  PRIMARY KEY ("applicationId",phase)
);
ALTER TABLE public."CorrectionWritePhase" OWNER TO :"boundary_owner";
REVOKE ALL ON public."CorrectionWritePhase" FROM PUBLIC;
GRANT SELECT ON public."CorrectionWritePhase" TO :"boundary_caller";
GRANT INSERT ("applicationId",phase), UPDATE(state)
  ON public."CorrectionWritePhase" TO :"boundary_caller";
ALTER TABLE public."CorrectionWritePhase" ENABLE ROW LEVEL SECURITY;
CREATE POLICY r5_phase_source_visibility ON public."CorrectionWritePhase"
FOR ALL TO :"boundary_caller" USING (
  EXISTS (SELECT 1 FROM public."CorrectionApplication" a
    JOIN public."AttendanceCorrectionRequest" q ON q.id=a."correctionRequestId"
    WHERE a.id="applicationId")
) WITH CHECK (
  EXISTS (SELECT 1 FROM public."CorrectionApplication" a
    JOIN public."AttendanceCorrectionRequest" q ON q.id=a."correctionRequestId"
    WHERE a.id="applicationId")
);

CREATE FUNCTION public.r5_correction_boundary_preflight() RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor oid; owner_oid oid; expected_names text[]; fact_relations regclass[]; actual_count integer;
BEGIN
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

CREATE FUNCTION public.r5_correction_phase_row_guard() RETURNS trigger
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
  ELSE
    IF ROW(NEW."applicationId",NEW.phase,NEW."batchId",NEW."requestId",NEW."sourceRevision",NEW."transactionId",NEW."actorOid")
      IS DISTINCT FROM ROW(OLD."applicationId",OLD.phase,OLD."batchId",OLD."requestId",OLD."sourceRevision",OLD."transactionId",OLD."actorOid")
      OR OLD.state<>'OPEN' OR NEW.state<>'SEALED'
      OR OLD."transactionId"<>pg_current_xact_id() OR OLD."actorOid"<>current_user::regrole::oid
      OR OLD."sourceRevision" IS DISTINCT FROM q.r5_source_revision
      OR (NEW.phase='prepare' AND (a."statusCode"<>'preparing' OR b."statusCode"<>'ready' OR q."statusCode"<>'applying'))
      OR (NEW.phase='commit' AND (a."statusCode"<>'committed' OR b."statusCode"<>'committed' OR q."statusCode"<>'applied'))
    THEN RAISE EXCEPTION 'phase cannot be reopened, rebound or sealed early' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END;$$;
CREATE TRIGGER r5_phase_row_guard BEFORE INSERT OR UPDATE OR DELETE
ON public."CorrectionWritePhase" FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_row_guard();
CREATE TRIGGER r5_phase_no_truncate BEFORE TRUNCATE
ON public."CorrectionWritePhase" FOR EACH STATEMENT EXECUTE FUNCTION public.r5_correction_phase_row_guard();

CREATE FUNCTION public.r5_correction_require_open_phase(app_id text, wanted_phase text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."CorrectionWritePhase" p
    JOIN public."CorrectionApplication" a ON a.id=p."applicationId" AND a."newPostingBatchId"=p."batchId"
    JOIN public."AttendanceCorrectionRequest" q ON q.id=a."correctionRequestId" AND q.id=p."requestId"
    WHERE p."applicationId"=app_id AND p.phase=wanted_phase AND p.state='OPEN'
      AND p."transactionId"=pg_current_xact_id() AND p."actorOid"=current_user::regrole::oid
      AND p."sourceRevision"=q.r5_source_revision)
  THEN RAISE EXCEPTION 'write requires this transaction and actor open phase' USING ERRCODE='23514'; END IF;
END;$$;

CREATE FUNCTION public.r5_correction_phase_write_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE app_id text; req_id text; batch_id text; wanted text:='prepare'; schema_version jsonb; replacement_count integer; schema_from_unique_replacement boolean:=false;
BEGIN
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
  PERFORM public.r5_correction_require_open_phase(app_id,wanted);
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;$$;

CREATE FUNCTION public.r5_correction_phase_deferred_registered(app_id text) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
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

CREATE FUNCTION public.r5_correction_assert_pending_lifecycle(app_id text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
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

-- Same complete checks and trigger count; only the normal-array membership
-- lookup uses a set difference. NULL pending keys still fail equality matching.
-- Project only the fields consumed by the two source-proof checks.
-- The earlier array-length statement retains non-array/NULL behavior; mixed
-- arrays retain the original jsonb_array_elements branch. No checks are skipped.

CREATE OR REPLACE FUNCTION public.ctsp_assert_complete(batch_id TEXT, require_bindings BOOLEAN)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  proof_row RECORD;
  application_row RECORD;
  pending_count INTEGER;
  evidence_count INTEGER;
  binding_count INTEGER;
  source_count INTEGER;
BEGIN
  SELECT p.*, a."statusCode" AS application_status, q."statusCode" AS request_status,
         q."requestedChangeJson", m."id" AS manifest_id, m."formatVersion" AS manifest_format,
         m."sourceProofHash" AS manifest_proof_hash, m."expectedRootCount" AS expected_root_count
    INTO proof_row
    FROM "CorrectionTimeSourceProof" p
    JOIN "CorrectionApplication" a ON a.id = p."applicationId"
    JOIN "AttendanceCorrectionRequest" q ON q.id = a."correctionRequestId"
    JOIN "ParticipationTimeCorrectionManifest" m ON m.id = p."correctionManifestId"
    WHERE p."postingBatchId" = batch_id;
  SELECT a.*, q."requestedChangeJson", q."statusCode" AS request_status
    INTO application_row
    FROM "CorrectionApplication" a
    JOIN "AttendanceCorrectionRequest" q ON q.id = a."correctionRequestId"
    WHERE a."newPostingBatchId" = batch_id;
  IF application_row.id IS NULL
    OR application_row."requestedChangeJson"->'schemaVersion' IS DISTINCT FROM '3'::jsonb THEN
    RETURN;
  END IF;
  IF proof_row.id IS NULL THEN
    RAISE EXCEPTION 'V3 correction source proof is missing'
      USING ERRCODE = '23514', CONSTRAINT = 'ctsp_complete_guard';
  END IF;
  IF proof_row.application_status NOT IN ('preparing', 'committed')
    OR proof_row.request_status NOT IN ('applying', 'applied')
    OR proof_row.manifest_format <> 2
    OR proof_row.manifest_proof_hash IS DISTINCT FROM proof_row."sourceSetHash"
    OR proof_row."applicationId" IS DISTINCT FROM application_row.id
  THEN
    RAISE EXCEPTION 'V3 correction proof/application anchors are inconsistent'
      USING ERRCODE = '23514', CONSTRAINT = 'ctsp_complete_guard';
  END IF;
  SELECT count(*)::integer INTO pending_count FROM "CorrectionPendingTimeAllocation"
    WHERE "applicationId" = proof_row."applicationId";
  SELECT count(*)::integer INTO evidence_count FROM "CorrectionPendingTimeAllocationEvidence" e
    JOIN "CorrectionPendingTimeAllocation" p ON p.id = e."pendingAllocationId"
    WHERE p."applicationId" = proof_row."applicationId";
  SELECT coalesce(jsonb_array_length(proof_row."sourceSnapshotJson"), 0)
    INTO source_count;
  IF pending_count <> proof_row."expectedPendingCount"
    OR source_count <> proof_row."expectedSegmentCount"
    OR proof_row."expectedBindingCount" <> proof_row."expectedSegmentCount"
    OR (CASE
      WHEN jsonb_path_exists(proof_row."sourceSnapshotJson", 'strict $[*] ? (@.type() != "object")')
      THEN (SELECT coalesce(sum((source->>'sliceCount')::integer), 0)::integer
      FROM jsonb_array_elements(proof_row."sourceSnapshotJson") source)
      ELSE (SELECT coalesce(sum(source."sliceCount"::integer), 0)::integer
        FROM jsonb_to_recordset(proof_row."sourceSnapshotJson") AS source("sliceCount" TEXT))
    END)
      <> proof_row."expectedSliceCount"
    OR jsonb_array_length(proof_row."calculatedBucketsJson") <> proof_row.expected_root_count
    OR evidence_count > 2000
  THEN
    RAISE EXCEPTION 'V3 correction proof counts are incomplete'
      USING ERRCODE = '23514', CONSTRAINT = 'ctsp_complete_guard';
  END IF;
  IF (CASE
    WHEN jsonb_path_exists(proof_row."sourceSnapshotJson", 'strict $[*] ? (@.type() != "object")')
    THEN EXISTS (
    SELECT 1 FROM "CorrectionPendingTimeAllocation" p
    WHERE p."applicationId" = proof_row."applicationId"
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(proof_row."sourceSnapshotJson") source
        WHERE source->>'participationIdentityId' = p."participationIdentityId"
          AND source->>'segmentKey' = p."segmentKey"
          AND source->>'baseAllocationRevisionId' = p."baseAllocationRevisionId"
      )
  )
    ELSE (
WITH pending_keys AS MATERIALIZED (
 SELECT "participationIdentityId","segmentKey","baseAllocationRevisionId"
 FROM "CorrectionPendingTimeAllocation" WHERE "applicationId"=proof_row."applicationId"
), source_keys AS MATERIALIZED (
 SELECT "participationIdentityId","segmentKey","baseAllocationRevisionId"
 FROM jsonb_to_recordset(proof_row."sourceSnapshotJson")
 AS source("participationIdentityId" TEXT,"segmentKey" TEXT,"baseAllocationRevisionId" TEXT)
), missing_keys AS (
 SELECT * FROM pending_keys EXCEPT SELECT * FROM source_keys
) SELECT EXISTS(SELECT 1 FROM pending_keys WHERE "participationIdentityId" IS NULL
 OR "segmentKey" IS NULL OR "baseAllocationRevisionId" IS NULL)
 OR EXISTS(SELECT 1 FROM missing_keys)
    )
  END) THEN
    RAISE EXCEPTION 'V3 correction proof omits an approved pending allocation'
      USING ERRCODE = '23514', CONSTRAINT = 'ctsp_complete_guard';
  END IF;
  IF require_bindings THEN
    SELECT count(*)::integer INTO binding_count FROM "CorrectionTimeAllocationBinding"
      WHERE "proofId" = proof_row.id;
    IF binding_count <> proof_row."expectedBindingCount"
      OR EXISTS (
        SELECT 1 FROM "CorrectionPendingTimeAllocation" p
        WHERE p."applicationId" = proof_row."applicationId"
          AND NOT EXISTS (
            SELECT 1 FROM "CorrectionTimeAllocationBinding" b
            WHERE b."proofId" = proof_row.id AND b."pendingAllocationId" = p.id
              AND b."allocationRevisionId" = p."targetAllocationRevisionId"
              AND b."sourceSegmentId" = p."targetSegmentRevisionId"
          )
      )
      -- Compare the two frozen sets as multisets.  EXCEPT ALL has the same
      -- NULL-equality as the former IS NOT DISTINCT FROM join and catches
      -- duplicate/missing rows in either direction, but it parses the proof
      -- only once and avoids a 10,000 x 10,000 nested-loop comparison.
      OR EXISTS (
        WITH source_rows AS MATERIALIZED (
          SELECT
            source."participationIdentityId",
            source."segmentKey",
            source."sourceSegmentId",
            source."sourceSegmentRevision",
            source."allocationRevisionId",
            source."pendingAllocationId",
            source."sourceHash"
          FROM jsonb_to_recordset(proof_row."sourceSnapshotJson")
            AS source(
              "participationIdentityId" TEXT,
              "segmentKey" TEXT,
              "sourceSegmentId" TEXT,
              "sourceSegmentRevision" INTEGER,
              "allocationRevisionId" TEXT,
              "pendingAllocationId" TEXT,
              "sourceHash" TEXT
            )
        ), binding_rows AS MATERIALIZED (
          SELECT
            b."participationIdentityId",
            b."segmentKey",
            b."sourceSegmentId",
            b."sourceSegmentRevision",
            b."allocationRevisionId",
            b."pendingAllocationId",
            b."sourceHash"
          FROM "CorrectionTimeAllocationBinding" b
          WHERE b."proofId" = proof_row.id
        ), mismatches AS (
          (SELECT * FROM source_rows EXCEPT ALL SELECT * FROM binding_rows)
          UNION ALL
          (SELECT * FROM binding_rows EXCEPT ALL SELECT * FROM source_rows)
        )
        SELECT 1 FROM mismatches
      )
    THEN
      RAISE EXCEPTION 'V3 correction proof bindings are incomplete or mismatched'
        USING ERRCODE = '23514', CONSTRAINT = 'ctsp_complete_guard';
    END IF;
  END IF;
END;
$$;

CREATE FUNCTION public.r5_correction_phase_terminal() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
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

CREATE FUNCTION public.r5_correction_begin_phase(app_id text, wanted_phase text)
RETURNS TABLE("applicationId" text,phase text,"batchId" text,state text,"protocolVersion" integer)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  PERFORM public.r5_correction_boundary_preflight();
  -- The table trigger enforces the canonical lock order for this and direct SQL.
  RETURN QUERY INSERT INTO public."CorrectionWritePhase" AS p ("applicationId",phase)
    VALUES(app_id,wanted_phase)
    RETURNING p."applicationId",p.phase,p."batchId",p.state,1;
END;$$;

CREATE FUNCTION public.r5_correction_seal_phase(app_id text, wanted_phase text)
RETURNS TABLE("applicationId" text,phase text,"batchId" text,state text,"protocolVersion" integer)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  PERFORM public.r5_correction_boundary_preflight();
  RETURN QUERY UPDATE public."CorrectionWritePhase" AS p SET state='SEALED'
    WHERE p."applicationId"=app_id AND p.phase=wanted_phase AND p.state='OPEN'
      AND p."transactionId"=pg_current_xact_id() AND p."actorOid"=current_user::regrole::oid
    RETURNING p."applicationId",p.phase,p."batchId",p.state,1;
  IF NOT FOUND THEN RAISE EXCEPTION 'no current open correction phase' USING ERRCODE='23514'; END IF;
END;$$;


CREATE OR REPLACE FUNCTION public.correction_pending_segment_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
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


-- OFFLINE DESIGN ONLY. Not installed, SQL compilation/runtime not yet tested.
-- Requires the reviewed same-table kind/header extension. No formal migration.
CREATE OR REPLACE FUNCTION public.cpta_insert_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
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


CREATE OR REPLACE FUNCTION public.correction_segment_lifecycle_check() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
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

CREATE OR REPLACE FUNCTION public.ctsp_lifecycle_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
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

CREATE CONSTRAINT TRIGGER correction_application_preparation_receipt_required AFTER INSERT ON public."CorrectionWritePhase"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_terminal();
CREATE CONSTRAINT TRIGGER correction_pending_lifecycle_check AFTER INSERT ON public."CorrectionWritePhase"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_terminal();
CREATE CONSTRAINT TRIGGER correction_preparation_lifecycle_check AFTER INSERT ON public."CorrectionWritePhase"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_terminal();
CREATE CONSTRAINT TRIGGER correction_cleanup_lifecycle_check AFTER INSERT ON public."CorrectionWritePhase"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_terminal();
CREATE CONSTRAINT TRIGGER cpta_lifecycle_guard AFTER INSERT ON public."CorrectionWritePhase"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_terminal();
CREATE CONSTRAINT TRIGGER cptae_lifecycle_guard AFTER INSERT ON public."CorrectionWritePhase"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_terminal();
CREATE CONSTRAINT TRIGGER ctsp_lifecycle_proof_guard AFTER INSERT ON public."CorrectionWritePhase"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_terminal();
CREATE CONSTRAINT TRIGGER ctsp_lifecycle_batch_guard AFTER INSERT ON public."CorrectionWritePhase"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_terminal();
CREATE TRIGGER aa_r5_phase_write_gate BEFORE INSERT OR UPDATE OR DELETE ON public."CorrectionApplication"
  FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_write_guard();
CREATE TRIGGER aa_r5_phase_write_gate BEFORE INSERT OR UPDATE OR DELETE ON public."AttendanceCorrectionRequest"
  FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_write_guard();
CREATE TRIGGER aa_r5_phase_write_gate BEFORE INSERT OR UPDATE OR DELETE ON public."CorrectionPendingSegmentRevision"
  FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_write_guard();
CREATE TRIGGER aa_r5_phase_write_gate BEFORE INSERT OR UPDATE OR DELETE ON public."CorrectionSegmentPreparationReceipt"
  FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_write_guard();
CREATE TRIGGER aa_r5_phase_write_gate BEFORE INSERT OR UPDATE OR DELETE ON public."CorrectionSegmentCleanupReceipt"
  FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_write_guard();
CREATE TRIGGER aa_r5_phase_write_gate BEFORE INSERT OR UPDATE OR DELETE ON public."CorrectionPendingTimeAllocation"
  FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_write_guard();
CREATE TRIGGER aa_r5_phase_write_gate BEFORE INSERT OR UPDATE OR DELETE ON public."CorrectionPendingTimeAllocationEvidence"
  FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_write_guard();
CREATE TRIGGER aa_r5_phase_write_gate BEFORE INSERT OR UPDATE OR DELETE ON public."CorrectionTimeSourceProof"
  FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_write_guard();
CREATE TRIGGER aa_r5_phase_write_gate BEFORE INSERT OR UPDATE OR DELETE ON public."CorrectionTimeAllocationBinding"
  FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_write_guard();
CREATE TRIGGER aa_r5_phase_write_gate BEFORE INSERT OR UPDATE OR DELETE ON public."ParticipationTimeCorrectionManifest"
  FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_write_guard();
CREATE TRIGGER aa_r5_phase_write_gate BEFORE INSERT OR UPDATE OR DELETE ON public."LedgerPostingBatch"
  FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_write_guard();
CREATE TRIGGER aa_r5_phase_write_gate BEFORE INSERT OR UPDATE OR DELETE ON public."ParticipantServiceSegmentRevision"
  FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_write_guard();
CREATE TRIGGER aa_r5_phase_write_gate BEFORE INSERT OR UPDATE OR DELETE ON public."ParticipantTimeAllocationRevision"
  FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_write_guard();
CREATE TRIGGER aa_r5_phase_write_gate BEFORE INSERT OR UPDATE OR DELETE ON public."ParticipantTimeAllocationCommandReceipt"
  FOR EACH ROW EXECUTE FUNCTION public.r5_correction_phase_write_guard();

ALTER FUNCTION public.r5_correction_boundary_preflight() OWNER TO :"boundary_owner";
REVOKE ALL ON FUNCTION public.r5_correction_boundary_preflight() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.r5_correction_boundary_preflight() TO :"boundary_caller";
ALTER FUNCTION public.r5_correction_phase_row_guard() OWNER TO :"boundary_owner";
REVOKE ALL ON FUNCTION public.r5_correction_phase_row_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.r5_correction_phase_row_guard() TO :"boundary_caller";
ALTER FUNCTION public.r5_correction_require_open_phase(text,text) OWNER TO :"boundary_owner";
REVOKE ALL ON FUNCTION public.r5_correction_require_open_phase(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.r5_correction_require_open_phase(text,text) TO :"boundary_caller";
ALTER FUNCTION public.r5_correction_phase_write_guard() OWNER TO :"boundary_owner";
REVOKE ALL ON FUNCTION public.r5_correction_phase_write_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.r5_correction_phase_write_guard() TO :"boundary_caller";
ALTER FUNCTION public.r5_correction_phase_deferred_registered(text) OWNER TO :"boundary_owner";
REVOKE ALL ON FUNCTION public.r5_correction_phase_deferred_registered(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.r5_correction_phase_deferred_registered(text) TO :"boundary_caller";
ALTER FUNCTION public.r5_correction_assert_pending_lifecycle(text) OWNER TO :"boundary_owner";
REVOKE ALL ON FUNCTION public.r5_correction_assert_pending_lifecycle(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.r5_correction_assert_pending_lifecycle(text) TO :"boundary_caller";
ALTER FUNCTION public.r5_correction_phase_terminal() OWNER TO :"boundary_owner";
REVOKE ALL ON FUNCTION public.r5_correction_phase_terminal() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.r5_correction_phase_terminal() TO :"boundary_caller";
ALTER FUNCTION public.r5_correction_begin_phase(text,text) OWNER TO :"boundary_owner";
REVOKE ALL ON FUNCTION public.r5_correction_begin_phase(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.r5_correction_begin_phase(text,text) TO :"boundary_caller";
ALTER FUNCTION public.r5_correction_seal_phase(text,text) OWNER TO :"boundary_owner";
REVOKE ALL ON FUNCTION public.r5_correction_seal_phase(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.r5_correction_seal_phase(text,text) TO :"boundary_caller";


-- Equivalent correction-receipt child-count plan; ordinary role/trigger timing
-- is unchanged. Non-object manifests retain the complete original query.
CREATE OR REPLACE FUNCTION ptacr_correction_receipt_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  application_not_ready boolean;
  correction_mismatch boolean;
  valid_nonempty_violation boolean;
  zero_source_violation boolean;
  unsupported_source_violation boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM ptacr_new_rows receipt
    WHERE receipt."operationCode" = 'recognize_correction_time_allocation'
  ) THEN
    RETURN NULL;
  END IF;

  -- Preserve the historical receipt-guard priority: parent existence precedes
  -- operation, receipt-content, child-completeness and immutable-proof checks.
  IF EXISTS (
    SELECT 1
    FROM ptacr_new_rows receipt
    LEFT JOIN "ParticipantTimeAllocationRevision" parent
      ON parent.id = receipt."allocationRevisionId"
      AND parent."activityId" = receipt."activityId"
    WHERE receipt."operationCode" = 'recognize_correction_time_allocation'
      AND parent.id IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', CONSTRAINT = 'ptacr_parent_guard',
      MESSAGE = 'time allocation receipt parent is unavailable';
  END IF;

  -- Parent rows are the first shared locks acquired by the historical receipt
  -- guard.  Lock the same de-duplicated set before making any mutable-fact
  -- decision, in deterministic parent-id order.
  PERFORM 1
  FROM (
    SELECT DISTINCT receipt."allocationRevisionId", receipt."activityId"
    FROM ptacr_new_rows receipt
    WHERE receipt."operationCode" = 'recognize_correction_time_allocation'
  ) input
  JOIN "ParticipantTimeAllocationRevision" parent
    ON parent.id = input."allocationRevisionId"
    AND parent."activityId" = input."activityId"
  ORDER BY parent.id
  FOR SHARE OF parent;

  IF EXISTS (
    SELECT 1
    FROM ptacr_new_rows receipt
    JOIN "ParticipantTimeAllocationRevision" parent
      ON parent.id = receipt."allocationRevisionId"
      AND parent."activityId" = receipt."activityId"
    WHERE receipt."operationCode" = 'recognize_correction_time_allocation'
      AND parent."correctionPendingAllocationId" IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptacr_settlement_operation_guard',
      MESSAGE = 'time allocation proof and receipt operation do not match';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ptacr_new_rows receipt
    JOIN "ParticipantTimeAllocationRevision" parent
      ON parent.id = receipt."allocationRevisionId"
      AND parent."activityId" = receipt."activityId"
    WHERE receipt."operationCode" = 'recognize_correction_time_allocation'
      AND (
        parent."createdByUserId" IS DISTINCT FROM receipt."actorUserId"
        OR parent."createdAt" IS DISTINCT FROM receipt."createdAt"
        OR receipt."resultJson"->>'activityId' IS DISTINCT FROM receipt."activityId"
        OR receipt."resultJson"->>'allocationRevisionId' IS DISTINCT FROM receipt."allocationRevisionId"
        OR receipt."resultJson"->>'revision' IS DISTINCT FROM parent.revision::TEXT
        OR receipt."resultJson"->>'sourceSegmentId' IS DISTINCT FROM parent."sourceSegmentId"
        OR receipt."resultJson"->>'sourceSegmentRevision' IS DISTINCT FROM parent."sourceSegmentRevision"::TEXT
        OR receipt."resultJson"->>'recognitionModeCode' IS DISTINCT FROM parent."recognitionModeCode"
        OR receipt."resultJson"->>'allocationHash' IS DISTINCT FROM parent."allocationHash"
        OR receipt."resultJson"->>'sliceCount' IS DISTINCT FROM parent."sliceCount"::TEXT
        OR receipt."resultJson"->>'createdAt' IS DISTINCT FROM
          to_char(receipt."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptacr_result_guard',
      MESSAGE = 'time allocation receipt differs from its created revision';
  END IF;

  -- Preserve legacy JSON-error/violation precedence for every non-object input.
  -- Parent rows already hold their original FOR SHARE locks; no verdict is cached.
  IF EXISTS (SELECT 1 FROM ptacr_new_rows receipt
    JOIN "ParticipantTimeAllocationRevision" parent
      ON parent.id=receipt."allocationRevisionId"
      AND parent."activityId"=receipt."activityId"
    WHERE receipt."operationCode"='recognize_correction_time_allocation'
      AND jsonb_typeof(parent."allocationJson"->'slices') IS DISTINCT FROM 'object' ) THEN
  WITH correction_receipts AS MATERIALIZED (
    SELECT receipt.id AS receipt_id,
           receipt."allocationRevisionId",
           receipt."activityId",
           receipt."resultJson",
           parent."allocationJson",
           parent."sliceCount"
    FROM ptacr_new_rows receipt
    JOIN "ParticipantTimeAllocationRevision" parent
      ON parent.id = receipt."allocationRevisionId"
      AND parent."activityId" = receipt."activityId"
    WHERE receipt."operationCode" = 'recognize_correction_time_allocation'
  ),
  parent_keys AS (
    SELECT DISTINCT receipt."allocationRevisionId", receipt."activityId"
    FROM correction_receipts receipt
  ),
  slice_counts AS (
    SELECT key."allocationRevisionId",
           key."activityId",
           count(slice.id)::int AS slice_total
    FROM parent_keys key
    LEFT JOIN "ParticipantTimeAllocationSlice" slice
      ON slice."allocationRevisionId" = key."allocationRevisionId"
      AND slice."activityId" = key."activityId"
    GROUP BY key."allocationRevisionId", key."activityId"
  ),
  evidence_counts AS (
    SELECT key."allocationRevisionId",
           key."activityId",
           count(evidence.id)::int AS evidence_total
    FROM parent_keys key
    LEFT JOIN "ParticipantTimeAllocationEvidence" evidence
      ON evidence."allocationRevisionId" = key."allocationRevisionId"
      AND evidence."activityId" = key."activityId"
    GROUP BY key."allocationRevisionId", key."activityId"
  )
  SELECT EXISTS (
    SELECT 1
    FROM correction_receipts receipt
    JOIN slice_counts slices
      ON slices."allocationRevisionId" = receipt."allocationRevisionId"
      AND slices."activityId" = receipt."activityId"
    JOIN evidence_counts evidence
      ON evidence."allocationRevisionId" = receipt."allocationRevisionId"
      AND evidence."activityId" = receipt."activityId"
    WHERE slices.slice_total <> receipt."sliceCount"
      OR (SELECT count(*) FROM jsonb_object_keys(receipt."allocationJson"->'slices'))
          <> receipt."sliceCount"
      OR evidence.evidence_total > 20
      OR receipt."resultJson"->>'evidenceCount' IS DISTINCT FROM evidence.evidence_total::TEXT
  ) INTO correction_mismatch;
  ELSE
  WITH correction_receipts AS MATERIALIZED (
    SELECT receipt.id AS receipt_id,
           receipt."allocationRevisionId",
           receipt."activityId",
           receipt."resultJson",
           parent."allocationJson",
           parent."sliceCount"
    FROM ptacr_new_rows receipt
    JOIN "ParticipantTimeAllocationRevision" parent
      ON parent.id = receipt."allocationRevisionId"
      AND parent."activityId" = receipt."activityId"
    WHERE receipt."operationCode" = 'recognize_correction_time_allocation'
  )
  SELECT EXISTS (
    SELECT 1
    FROM correction_receipts receipt
    CROSS JOIN LATERAL (
      SELECT count(slice.id)::int AS slice_total
      FROM "ParticipantTimeAllocationSlice" slice
      WHERE slice."allocationRevisionId"=receipt."allocationRevisionId"
        AND slice."activityId"=receipt."activityId"
      OFFSET 0
    ) slices
    CROSS JOIN LATERAL (
      SELECT count(evidence.id)::int AS evidence_total
      FROM "ParticipantTimeAllocationEvidence" evidence
      WHERE evidence."allocationRevisionId"=receipt."allocationRevisionId"
        AND evidence."activityId"=receipt."activityId"
      OFFSET 0
    ) evidence
    WHERE slices.slice_total <> receipt."sliceCount"
      OR (SELECT count(*) FROM jsonb_object_keys(receipt."allocationJson"->'slices'))
          <> receipt."sliceCount"
      OR evidence.evidence_total > 20
      OR receipt."resultJson"->>'evidenceCount' IS DISTINCT FROM evidence.evidence_total::TEXT
  ) INTO correction_mismatch;
  END IF;

  IF correction_mismatch THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptacr_complete_guard',
      MESSAGE = 'time allocation receipt has incomplete or excessive children';
  END IF;

  -- The allocation INSERT guard already proves this chain once.  Receipt
  -- insertion still rechecks it after child writes, but does so as the same
  -- statement-level immutable set rather than once per receipt row.
  IF EXISTS (
    SELECT 1
    FROM ptacr_new_rows receipt
    JOIN "ParticipantTimeAllocationRevision" parent
      ON parent.id = receipt."allocationRevisionId"
      AND parent."activityId" = receipt."activityId"
    WHERE receipt."operationCode" = 'recognize_correction_time_allocation'
      AND num_nonnulls(
        parent."settlementDraftVersionId",
        parent."settlementEvidenceSealId",
        parent."settlementEvidenceRevision",
        parent."settlementPopulationRevision",
        parent."settlementWorkflowRevision",
        parent."settlementDraftContentHash"
      ) <> 0
  ) THEN
    RAISE EXCEPTION 'correction allocation proof shape is invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'ptar_correction_proof_guard';
  END IF;

  -- Preserve the correction-proof lock sequence after the receipt parent lock:
  -- pending/application/request/batch/segment, then source, base and policy.
  PERFORM 1
  FROM (
    SELECT DISTINCT parent."correctionPendingAllocationId" AS pending_id
    FROM ptacr_new_rows receipt
    JOIN "ParticipantTimeAllocationRevision" parent
      ON parent.id = receipt."allocationRevisionId"
      AND parent."activityId" = receipt."activityId"
    WHERE receipt."operationCode" = 'recognize_correction_time_allocation'
  ) input
  JOIN "CorrectionPendingTimeAllocation" pending ON pending.id = input.pending_id
  JOIN "CorrectionApplication" application ON application.id = pending."applicationId"
  JOIN "AttendanceCorrectionRequest" request ON request.id = application."correctionRequestId"
  JOIN "LedgerPostingBatch" batch ON batch.id = application."newPostingBatchId"
  JOIN "CorrectionPendingSegmentRevision" segment ON segment.id = pending."pendingSegmentId"
    AND segment."applicationId" = pending."applicationId"
    AND segment."activityId" = pending."activityId"
    AND segment."participationIdentityId" = pending."participationIdentityId"
    AND segment."segmentKey" = pending."segmentKey"
  ORDER BY pending.id
  FOR SHARE OF pending, application, request, batch, segment;

  PERFORM 1
  FROM (
    SELECT DISTINCT parent."sourceSegmentId", parent."participationIdentityId"
    FROM ptacr_new_rows receipt
    JOIN "ParticipantTimeAllocationRevision" parent
      ON parent.id = receipt."allocationRevisionId"
      AND parent."activityId" = receipt."activityId"
    WHERE receipt."operationCode" = 'recognize_correction_time_allocation'
  ) input
  JOIN "ParticipantServiceSegmentRevision" source
    ON source.id = input."sourceSegmentId"
    AND source."participationIdentityId" = input."participationIdentityId"
  ORDER BY source.id
  FOR SHARE OF source;

  PERFORM 1
  FROM (
    SELECT DISTINCT pending."baseAllocationRevisionId",
           parent."activityId",
           parent."participationIdentityId",
           parent."segmentKey"
    FROM ptacr_new_rows receipt
    JOIN "ParticipantTimeAllocationRevision" parent
      ON parent.id = receipt."allocationRevisionId"
      AND parent."activityId" = receipt."activityId"
    JOIN "CorrectionPendingTimeAllocation" pending
      ON pending.id = parent."correctionPendingAllocationId"
    WHERE receipt."operationCode" = 'recognize_correction_time_allocation'
  ) input
  JOIN "ParticipantTimeAllocationRevision" base
    ON base.id = input."baseAllocationRevisionId"
    AND base."activityId" = input."activityId"
    AND base."participationIdentityId" = input."participationIdentityId"
    AND base."segmentKey" = input."segmentKey"
  ORDER BY base.id
  FOR SHARE OF base;

  PERFORM 1
  FROM (
    SELECT DISTINCT pending."policyVersionId", pending."definitionHash"
    FROM ptacr_new_rows receipt
    JOIN "ParticipantTimeAllocationRevision" parent
      ON parent.id = receipt."allocationRevisionId"
      AND parent."activityId" = receipt."activityId"
    JOIN "CorrectionPendingTimeAllocation" pending
      ON pending.id = parent."correctionPendingAllocationId"
    WHERE receipt."operationCode" = 'recognize_correction_time_allocation'
  ) input
  JOIN "TimePolicyVersion" policy
    ON policy.id = input."policyVersionId"
    AND policy."definitionHash" = input."definitionHash"
  ORDER BY policy.id
  FOR SHARE OF policy;

  WITH correction_allocations AS MATERIALIZED (
    SELECT parent.*
    FROM ptacr_new_rows receipt
    JOIN "ParticipantTimeAllocationRevision" parent
      ON parent.id = receipt."allocationRevisionId"
      AND parent."activityId" = receipt."activityId"
    WHERE receipt."operationCode" = 'recognize_correction_time_allocation'
  ), relevant_request_ids AS MATERIALIZED (
    SELECT DISTINCT application."correctionRequestId" AS id
    FROM correction_allocations allocation
    JOIN "CorrectionPendingTimeAllocation" pending ON pending.id = allocation."correctionPendingAllocationId"
    JOIN "CorrectionApplication" application ON application.id = pending."applicationId"
  ), request_headers AS MATERIALIZED (
    SELECT request.id, request."statusCode", request."requestedChangeJson"->'schemaVersion' AS schema_version
    FROM "AttendanceCorrectionRequest" request
    JOIN relevant_request_ids input ON input.id = request.id
  )
  SELECT
    COALESCE(bool_or(
      pending.id IS NULL
      OR application.id IS NULL
      OR request.id IS NULL
      OR batch.id IS NULL
      OR segment.id IS NULL
      OR application."statusCode" IS DISTINCT FROM 'preparing'
      OR request."statusCode" IS DISTINCT FROM 'applying'
      OR batch."statusCode" IS DISTINCT FROM 'ready'
      OR request.schema_version IS DISTINCT FROM '3'::jsonb
    ), false),
    COALESCE(bool_or(
      source.id IS NULL
      OR base.id IS NULL
      OR policy.id IS NULL
      OR source."statusCode" IS DISTINCT FROM 'draft'
      OR source."segmentKey" IS DISTINCT FROM pending."segmentKey"
      OR source.revision IS DISTINCT FROM segment."targetRevisionNumber"
      OR source."baseRevisionId" IS DISTINCT FROM segment."baseRevisionId"
      OR allocation.id IS DISTINCT FROM pending."targetAllocationRevisionId"
      OR allocation."sourceSegmentId" IS DISTINCT FROM pending."targetSegmentRevisionId"
      OR allocation."sourceSegmentRevision" IS DISTINCT FROM segment."targetRevisionNumber"
      OR allocation.revision IS DISTINCT FROM pending."targetAllocationRevision"
      OR allocation."previousAllocationRevisionId" IS DISTINCT FROM pending."baseAllocationRevisionId"
      OR allocation."activityId" IS DISTINCT FROM pending."activityId"
      OR allocation."participationIdentityId" IS DISTINCT FROM pending."participationIdentityId"
      OR allocation."segmentKey" IS DISTINCT FROM pending."segmentKey"
      OR allocation."sessionId" IS DISTINCT FROM base."sessionId"
      OR allocation."memberId" IS DISTINCT FROM base."memberId"
      OR allocation."sourcePositionId" IS DISTINCT FROM base."sourcePositionId"
      OR allocation."ruleSnapshotId" IS DISTINCT FROM pending."ruleSnapshotId"
      OR allocation."ruleSnapshotHash" IS DISTINCT FROM pending."ruleSnapshotHash"
      OR allocation."timePolicySelectionRevisionId" IS DISTINCT FROM pending."timePolicySelectionRevisionId"
      OR allocation."selectionHash" IS DISTINCT FROM pending."selectionHash"
      OR allocation."policyVersionId" IS DISTINCT FROM pending."policyVersionId"
      OR allocation."definitionHash" IS DISTINCT FROM pending."definitionHash"
      OR allocation."policyId" IS DISTINCT FROM policy."policyId"
      OR allocation."evaluatorVersion" IS DISTINCT FROM pending."evaluatorVersion"
      OR allocation."recognitionModeCode" IS DISTINCT FROM pending."recognitionModeCode"
      OR allocation."manualReason" IS DISTINCT FROM pending."manualReason"
      OR allocation."allocationJson" IS DISTINCT FROM pending."allocationJson"
      OR allocation."allocationHash" IS DISTINCT FROM pending."allocationHash"
      OR allocation."sliceCount" IS DISTINCT FROM pending."sliceCount"
    ), false),
    COALESCE(bool_or(
      source."resultCode" = 'valid'
      AND (
        source."checkOutAt" IS NULL
        OR source."checkOutAt" <= source."checkInAt"
        OR allocation."sliceCount" < 1
      )
    ), false),
    COALESCE(bool_or(
      source."resultCode" IN ('early_departure_zero', 'voided', 'replaced')
      AND (
        allocation."sliceCount" <> 0
        OR allocation."recognitionModeCode" <> 'automatic'
        OR allocation."manualReason" IS NOT NULL
      )
    ), false),
    COALESCE(bool_or(
      source."resultCode" IS NULL
      OR source."resultCode" NOT IN ('valid', 'early_departure_zero', 'voided', 'replaced')
    ), false)
  INTO application_not_ready,
       correction_mismatch,
       valid_nonempty_violation,
       zero_source_violation,
       unsupported_source_violation
  FROM correction_allocations allocation
    LEFT JOIN "CorrectionPendingTimeAllocation" pending
      ON pending.id = allocation."correctionPendingAllocationId"
    LEFT JOIN "CorrectionApplication" application ON application.id = pending."applicationId"
    LEFT JOIN request_headers request
      ON request.id = application."correctionRequestId"
    LEFT JOIN "LedgerPostingBatch" batch ON batch.id = application."newPostingBatchId"
    LEFT JOIN "CorrectionPendingSegmentRevision" segment ON segment.id = pending."pendingSegmentId"
      AND segment."applicationId" = pending."applicationId"
      AND segment."activityId" = pending."activityId"
      AND segment."participationIdentityId" = pending."participationIdentityId"
      AND segment."segmentKey" = pending."segmentKey"
    LEFT JOIN "ParticipantServiceSegmentRevision" source
      ON source.id = allocation."sourceSegmentId"
      AND source."participationIdentityId" = allocation."participationIdentityId"
    LEFT JOIN "ParticipantTimeAllocationRevision" base
      ON base.id = pending."baseAllocationRevisionId"
      AND base."activityId" = allocation."activityId"
      AND base."participationIdentityId" = allocation."participationIdentityId"
      AND base."segmentKey" = allocation."segmentKey"
    LEFT JOIN "TimePolicyVersion" policy
      ON policy.id = pending."policyVersionId"
      AND policy."definitionHash" = pending."definitionHash";

  IF application_not_ready THEN
    RAISE EXCEPTION 'correction allocation application is not ready'
      USING ERRCODE = '23514', CONSTRAINT = 'ptar_correction_proof_guard';
  END IF;

  IF correction_mismatch THEN
    RAISE EXCEPTION 'correction allocation differs from its pending fact'
      USING ERRCODE = '23514', CONSTRAINT = 'ptar_correction_proof_guard';
  END IF;

  IF valid_nonempty_violation THEN
    RAISE EXCEPTION 'valid correction allocation requires non-empty source slices'
      USING ERRCODE = '23514', CONSTRAINT = 'ptar_correction_proof_guard';
  END IF;

  IF zero_source_violation THEN
    RAISE EXCEPTION 'zero correction source permits only empty automatic allocation'
      USING ERRCODE = '23514', CONSTRAINT = 'ptar_correction_proof_guard';
  END IF;

  IF unsupported_source_violation THEN
    RAISE EXCEPTION 'correction source result is unsupported'
      USING ERRCODE = '23514', CONSTRAINT = 'ptar_correction_proof_guard';
  END IF;

  RETURN NULL;
END;
$$;

COMMIT;
