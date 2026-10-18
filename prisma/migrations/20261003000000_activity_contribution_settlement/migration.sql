-- E4: test-only native contribution evidence. No historical DML, roles, ACL, backfill or down migration.
BEGIN;
ALTER TABLE "AttendanceSettlementVersion" ADD COLUMN "contributionRegimeCode" TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE "AttendanceSettlementVersion" ADD CONSTRAINT e4_version_regime_check CHECK ("contributionRegimeCode" IN ('legacy','policy_v1'));

CREATE TABLE "ActivitySettlementContributionRevision" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activityId" TEXT NOT NULL,
    "settlementRunId" TEXT NOT NULL,
    "settlementVersionId" TEXT NOT NULL,
    "effectiveTimeSettlementVersionId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "kindCode" TEXT NOT NULL,
    "sourceKindCode" TEXT NOT NULL,
    "timeRevisionId" TEXT,
    "correctionApplicationId" TEXT,
    "correctionPostingBatchId" TEXT,
    "baseSettlementVersionId" TEXT,
    "correctionManifestId" TEXT,
    "correctionTimeSourceProofId" TEXT,
    "rootTimeManifestId" TEXT,
    "correctionSourceSetHash" TEXT,
    "previousContributionRevisionId" TEXT,
    "sourceDraftContributionRevisionId" TEXT,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "regimeCode" TEXT NOT NULL DEFAULT 'policy_v1',
    "evidenceSealId" TEXT NOT NULL,
    "evidenceRevision" INTEGER NOT NULL,
    "populationRevision" INTEGER NOT NULL,
    "workflowRevision" INTEGER NOT NULL,
    "draftContentHash" TEXT NOT NULL,
    "ruleSnapshotId" TEXT NOT NULL,
    "ruleSnapshotHash" TEXT NOT NULL,
    "selectionRevisionId" TEXT NOT NULL,
    "selectionRevisionHash" TEXT NOT NULL,
    "sourceSetHash" TEXT NOT NULL,
    "evaluationSetHash" TEXT NOT NULL,
    "recognizedPointsTotal" DECIMAL(18,2) NOT NULL,
    "evaluationCount" INTEGER NOT NULL,
    "operationKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,

    CONSTRAINT "ActivitySettlementContributionRevision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ParticipantContributionEvaluation" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contributionRevisionId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "settlementVersionId" TEXT NOT NULL,
    "participationIdentityId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "ruleSnapshotId" TEXT NOT NULL,
    "selectionItemId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "policyVersionId" TEXT NOT NULL,
    "definitionHash" TEXT NOT NULL,
    "evaluatorVersion" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,
    "attendanceRoleCode" TEXT NOT NULL,
    "timeCategoryCode" TEXT NOT NULL,
    "evaluationUnitKey" TEXT NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "sourceRefsJson" JSONB NOT NULL,
    "sourceFingerprint" TEXT NOT NULL,
    "calculatedPoints" DECIMAL(5,2) NOT NULL,
    "recognizedPoints" DECIMAL(5,2) NOT NULL,
    "explanationCode" TEXT NOT NULL,
    "beijingDayPointsJson" JSONB NOT NULL,
    "evaluationHash" TEXT NOT NULL,

    CONSTRAINT "ParticipantContributionEvaluation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "e4_snapshot_hash_anchor_key" ON "ActivityRuleSnapshot"("id", "activityId", "snapshotHash");

CREATE UNIQUE INDEX "e4_selection_hash_anchor_key" ON "ActivityContributionPolicySelectionRevision"("id", "activityId", "selectionHash");

CREATE UNIQUE INDEX "e4_selection_item_activity_key" ON "ActivityContributionPolicySelectionItem"("id", "activityId");

CREATE INDEX "e4_revision_version_kind_idx" ON "ActivitySettlementContributionRevision"("settlementVersionId", "kindCode", "revision");

CREATE INDEX "e4_revision_activity_created_idx" ON "ActivitySettlementContributionRevision"("activityId", "createdAt");

CREATE INDEX "e4_revision_time_idx" ON "ActivitySettlementContributionRevision"("timeRevisionId");

CREATE INDEX "e4_revision_application_idx" ON "ActivitySettlementContributionRevision"("correctionApplicationId");

CREATE UNIQUE INDEX "e4_revision_formal_version_key" ON "ActivitySettlementContributionRevision"("settlementVersionId")
  WHERE "kindCode" IN ('submitted', 'correction');

CREATE UNIQUE INDEX "e4_revision_run_revision_key" ON "ActivitySettlementContributionRevision"("settlementRunId", "revision");

CREATE UNIQUE INDEX "e4_revision_detail_anchor_key" ON "ActivitySettlementContributionRevision"("id", "activityId", "settlementVersionId");

CREATE UNIQUE INDEX "e4_revision_previous_anchor_key" ON "ActivitySettlementContributionRevision"("id", "activityId", "settlementVersionId", "settlementRunId");

CREATE UNIQUE INDEX "e4_revision_draft_anchor_key" ON "ActivitySettlementContributionRevision"("id", "activityId", "settlementRunId");

CREATE UNIQUE INDEX "e4_revision_actor_operation_key" ON "ActivitySettlementContributionRevision"("createdByUserId", "kindCode", "operationKey");

CREATE INDEX "e4_evaluation_revision_identity_idx" ON "ParticipantContributionEvaluation"("contributionRevisionId", "participationIdentityId");

CREATE INDEX "e4_evaluation_activity_version_idx" ON "ParticipantContributionEvaluation"("activityId", "settlementVersionId");

CREATE UNIQUE INDEX "e4_evaluation_unit_key" ON "ParticipantContributionEvaluation"("contributionRevisionId", "participationIdentityId", "evaluationUnitKey");

ALTER TABLE "ActivitySettlementContributionRevision" ADD CONSTRAINT "e4_revision_activity_fk" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ActivitySettlementContributionRevision" ADD CONSTRAINT "e4_revision_run_fk" FOREIGN KEY ("settlementRunId", "activityId") REFERENCES "AttendanceSettlementRun"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ActivitySettlementContributionRevision" ADD CONSTRAINT "e4_revision_version_fk" FOREIGN KEY ("settlementVersionId", "settlementRunId") REFERENCES "AttendanceSettlementVersion"("id", "settlementRunId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ActivitySettlementContributionRevision" ADD CONSTRAINT "e4_revision_effective_time_fk" FOREIGN KEY ("effectiveTimeSettlementVersionId", "settlementRunId") REFERENCES "AttendanceSettlementVersion"("id", "settlementRunId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ActivitySettlementContributionRevision" ADD CONSTRAINT "e4_revision_seal_fk" FOREIGN KEY ("evidenceSealId", "activityId", "evidenceRevision", "populationRevision", "workflowRevision") REFERENCES "EvidenceSeal"("id", "activityId", "evidenceRevision", "populationRevision", "workflowRevision") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ActivitySettlementContributionRevision" ADD CONSTRAINT "e4_revision_snapshot_fk" FOREIGN KEY ("ruleSnapshotId", "activityId", "ruleSnapshotHash") REFERENCES "ActivityRuleSnapshot"("id", "activityId", "snapshotHash") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ActivitySettlementContributionRevision" ADD CONSTRAINT "e4_revision_selection_fk" FOREIGN KEY ("selectionRevisionId", "activityId", "selectionRevisionHash") REFERENCES "ActivityContributionPolicySelectionRevision"("id", "activityId", "selectionHash") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ActivitySettlementContributionRevision" ADD CONSTRAINT "e4_revision_time_fk" FOREIGN KEY ("timeRevisionId", "settlementVersionId", "settlementRunId", "activityId") REFERENCES "ActivitySettlementTimeRevision"("id", "settlementVersionId", "settlementRunId", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ActivitySettlementContributionRevision" ADD CONSTRAINT "e4_revision_application_fk" FOREIGN KEY ("correctionApplicationId", "correctionPostingBatchId", "settlementVersionId") REFERENCES "CorrectionApplication"("id", "newPostingBatchId", "newSettlementVersionId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ActivitySettlementContributionRevision" ADD CONSTRAINT "e4_revision_manifest_fk" FOREIGN KEY ("correctionManifestId", "correctionPostingBatchId", "activityId", "settlementRunId", "baseSettlementVersionId", "settlementVersionId") REFERENCES "ParticipationTimeCorrectionManifest"("id", "postingBatchId", "activityId", "settlementRunId", "baseSettlementVersionId", "settlementVersionId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ActivitySettlementContributionRevision" ADD CONSTRAINT "e4_revision_time_proof_fk" FOREIGN KEY ("correctionTimeSourceProofId", "rootTimeManifestId", "activityId", "settlementRunId", "correctionSourceSetHash") REFERENCES "CorrectionTimeSourceProof"("id", "rootManifestId", "activityId", "settlementRunId", "sourceSetHash") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ActivitySettlementContributionRevision" ADD CONSTRAINT "e4_revision_previous_fk" FOREIGN KEY ("previousContributionRevisionId", "activityId", "baseSettlementVersionId", "settlementRunId") REFERENCES "ActivitySettlementContributionRevision"("id", "activityId", "settlementVersionId", "settlementRunId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ActivitySettlementContributionRevision" ADD CONSTRAINT "e4_revision_source_draft_fk" FOREIGN KEY ("sourceDraftContributionRevisionId", "activityId", "settlementRunId") REFERENCES "ActivitySettlementContributionRevision"("id", "activityId", "settlementRunId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ActivitySettlementContributionRevision" ADD CONSTRAINT "e4_revision_creator_fk" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ParticipantContributionEvaluation" ADD CONSTRAINT "e4_evaluation_revision_fk" FOREIGN KEY ("contributionRevisionId", "activityId", "settlementVersionId") REFERENCES "ActivitySettlementContributionRevision"("id", "activityId", "settlementVersionId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ParticipantContributionEvaluation" ADD CONSTRAINT "e4_evaluation_identity_fk" FOREIGN KEY ("participationIdentityId", "activityId", "sessionId", "memberId") REFERENCES "ActivityParticipationIdentity"("id", "activityId", "sessionId", "memberId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ParticipantContributionEvaluation" ADD CONSTRAINT "e4_evaluation_snapshot_fk" FOREIGN KEY ("ruleSnapshotId", "activityId") REFERENCES "ActivityRuleSnapshot"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ParticipantContributionEvaluation" ADD CONSTRAINT "e4_evaluation_selection_fk" FOREIGN KEY ("selectionItemId", "activityId") REFERENCES "ActivityContributionPolicySelectionItem"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ParticipantContributionEvaluation" ADD CONSTRAINT "e4_evaluation_policy_fk" FOREIGN KEY ("policyVersionId", "policyId", "definitionHash", "evaluatorVersion") REFERENCES "ContributionPolicyVersion"("id", "policyId", "definitionHash", "evaluatorVersion") ON DELETE RESTRICT ON UPDATE RESTRICT;


ALTER TABLE "ActivitySettlementContributionRevision" ADD CONSTRAINT e4_revision_shape_check CHECK (
  "schemaVersion" = 1 AND "regimeCode" = 'policy_v1' AND revision > 0
  AND "evaluationCount" BETWEEN 0 AND 50000 AND "recognizedPointsTotal" >= 0
  AND "evidenceRevision" >= 0 AND "populationRevision" >= 0 AND "workflowRevision" >= 0
  AND length("operationKey") BETWEEN 8 AND 128 AND btrim("operationKey") = "operationKey"
  AND "requestHash" ~ '^[0-9a-f]{64}$' AND "draftContentHash" ~ '^[0-9a-f]{64}$'
  AND "ruleSnapshotHash" ~ '^[0-9a-f]{64}$' AND "selectionRevisionHash" ~ '^[0-9a-f]{64}$'
  AND "sourceSetHash" ~ '^[0-9a-f]{64}$' AND "evaluationSetHash" ~ '^[0-9a-f]{64}$'
  AND (
    ("kindCode" IN ('draft','submitted') AND "sourceKindCode" = 'time_revision'
      AND "timeRevisionId" IS NOT NULL AND "effectiveTimeSettlementVersionId" = "settlementVersionId"
      AND "correctionApplicationId" IS NULL AND "correctionPostingBatchId" IS NULL
      AND "baseSettlementVersionId" IS NULL AND "previousContributionRevisionId" IS NULL
      AND "correctionManifestId" IS NULL AND "correctionTimeSourceProofId" IS NULL
      AND "rootTimeManifestId" IS NULL AND "correctionSourceSetHash" IS NULL
      AND (("kindCode" = 'draft' AND "sourceDraftContributionRevisionId" IS NULL)
        OR ("kindCode" = 'submitted' AND "sourceDraftContributionRevisionId" IS NOT NULL)))
    OR
    ("kindCode" = 'correction' AND "timeRevisionId" IS NULL
      AND "sourceDraftContributionRevisionId" IS NULL AND "previousContributionRevisionId" IS NOT NULL
      AND "correctionApplicationId" IS NOT NULL AND "correctionPostingBatchId" IS NOT NULL
      AND "baseSettlementVersionId" IS NOT NULL AND "baseSettlementVersionId" <> "settlementVersionId"
      AND (("sourceKindCode" = 'correction_time_proof' AND "correctionManifestId" IS NOT NULL
        AND "correctionTimeSourceProofId" IS NOT NULL AND "rootTimeManifestId" IS NOT NULL
        AND "effectiveTimeSettlementVersionId" = "settlementVersionId"
        AND "correctionSourceSetHash" ~ '^[0-9a-f]{64}$')
        OR ("sourceKindCode" = 'unchanged_time' AND "correctionManifestId" IS NULL
          AND "correctionTimeSourceProofId" IS NULL AND "rootTimeManifestId" IS NULL
          AND "correctionSourceSetHash" IS NULL AND "effectiveTimeSettlementVersionId" <> "settlementVersionId")))
  )
);
ALTER TABLE "ParticipantContributionEvaluation" ADD CONSTRAINT e4_evaluation_shape_check CHECK (
  mode = 'policy' AND "evaluatorVersion" = 1 AND "durationSeconds" >= 0
  AND "timeCategoryCode" IN ('volunteer_service','training','organization','non_creditable')
  AND length("attendanceRoleCode") BETWEEN 1 AND 64 AND btrim("attendanceRoleCode") = "attendanceRoleCode"
  AND length("explanationCode") BETWEEN 1 AND 64 AND btrim("explanationCode") = "explanationCode"
  AND "calculatedPoints" >= 0 AND "recognizedPoints" = "calculatedPoints"
  AND "definitionHash" ~ '^[0-9a-f]{64}$' AND "evaluationUnitKey" ~ '^[0-9a-f]{64}$'
  AND "sourceFingerprint" ~ '^[0-9a-f]{64}$' AND "evaluationHash" ~ '^[0-9a-f]{64}$'
  AND jsonb_typeof("sourceRefsJson") = 'array' AND jsonb_array_length("sourceRefsJson") BETWEEN 1 AND 50000
  AND jsonb_typeof("beijingDayPointsJson") = 'array'
);

CREATE FUNCTION e4_hash(value JSONB) RETURNS TEXT LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, public AS $$
  SELECT encode(sha256(convert_to(astr_canonical_json(value),'UTF8')),'hex')
$$;
CREATE FUNCTION e4_envelope_hash(value JSONB) RETURNS TEXT LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, public AS $$
  SELECT e4_hash(jsonb_build_object('schemaVersion',1,'definition',value))
$$;
CREATE FUNCTION e4_reject_mutation() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
BEGIN RAISE EXCEPTION 'contribution settlement evidence is append-only' USING ERRCODE='23514', CONSTRAINT='e4_immutable_guard'; END
$$;
CREATE TRIGGER e4_revision_no_mutation BEFORE UPDATE OR DELETE ON "ActivitySettlementContributionRevision"
FOR EACH ROW EXECUTE FUNCTION e4_reject_mutation();
CREATE TRIGGER e4_revision_no_truncate BEFORE TRUNCATE ON "ActivitySettlementContributionRevision"
FOR EACH STATEMENT EXECUTE FUNCTION e4_reject_mutation();
CREATE TRIGGER e4_evaluation_no_mutation BEFORE UPDATE OR DELETE ON "ParticipantContributionEvaluation"
FOR EACH ROW EXECUTE FUNCTION e4_reject_mutation();
CREATE TRIGGER e4_evaluation_no_truncate BEFORE TRUNCATE ON "ParticipantContributionEvaluation"
FOR EACH STATEMENT EXECUTE FUNCTION e4_reject_mutation();

CREATE FUNCTION e4_database_created_at() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
BEGIN NEW."createdAt" := CURRENT_TIMESTAMP; RETURN NEW; END
$$;
CREATE TRIGGER e4_revision_database_clock BEFORE INSERT ON "ActivitySettlementContributionRevision"
FOR EACH ROW EXECUTE FUNCTION e4_database_created_at();
CREATE TRIGGER e4_evaluation_database_clock BEFORE INSERT ON "ParticipantContributionEvaluation"
FOR EACH ROW EXECUTE FUNCTION e4_database_created_at();

CREATE FUNCTION e4_assert_frozen_selection(root "ActivitySettlementContributionRevision") RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE snapshot "ActivityRuleSnapshot"; selection "ActivityContributionPolicySelectionRevision";
  pointers JSONB; actual_items JSONB; actual_count BIGINT;
BEGIN
  SELECT * INTO STRICT snapshot FROM "ActivityRuleSnapshot" WHERE id=root."ruleSnapshotId"
    AND "activityId"=root."activityId" AND "snapshotHash"=root."ruleSnapshotHash";
  SELECT * INTO STRICT selection FROM "ActivityContributionPolicySelectionRevision"
    WHERE id=root."selectionRevisionId" AND "activityId"=root."activityId" AND "selectionHash"=root."selectionRevisionHash";
  pointers := snapshot."resolvedConfig"->'contributionPolicyPointers';
  IF snapshot."contributionPolicySelectionRevisionId" IS DISTINCT FROM selection.id
    OR snapshot."workflowRevision" <> root."workflowRevision"
    OR pointers->>'selectionRevisionId' IS DISTINCT FROM selection.id
    OR pointers->'selectionRevision' IS DISTINCT FROM to_jsonb(selection.revision)
    OR pointers->>'selectionHash' IS DISTINCT FROM selection."selectionHash"
    OR pointers->'selection' IS DISTINCT FROM selection."selectionJson"
    OR pointers->'schemaVersion' IS DISTINCT FROM '1'::JSONB
    OR jsonb_typeof(pointers->'resolved') IS DISTINCT FROM 'array'
    OR jsonb_array_length(pointers->'resolved') < 1
    OR csm_selection_hash_fn(selection."selectionJson",selection."schemaVersion") <> selection."selectionHash"
  THEN RAISE EXCEPTION 'contribution frozen selection mismatch' USING ERRCODE='23514', CONSTRAINT='e4_selection_guard'; END IF;

  SELECT count(*), jsonb_build_object('schemaVersion',1,'items',coalesce(jsonb_object_agg(
    i."layerCode" || ':' || coalesce(replace(encode(convert_to(i."sessionId",'UTF8'),'base64'),E'\n',''),'-')
      || ':' || coalesce(replace(encode(convert_to(i."positionId",'UTF8'),'base64'),E'\n',''),'-'),
    jsonb_build_object('scope',jsonb_build_object('layerCode',i."layerCode",'sessionId',i."sessionId",'positionId',i."positionId"),
      'selection',jsonb_build_object('mode',i.mode,'pointer',CASE WHEN i.mode='inherit' THEN NULL::JSONB ELSE
        jsonb_build_object('policyId',i."policyId",'versionId',i."versionId",'definitionHash',i."definitionHash",'evaluatorVersion',i."evaluatorVersion") END))
  ),'{}'::JSONB)) INTO actual_count,actual_items
  FROM "ActivityContributionPolicySelectionItem" i WHERE i."selectionRevisionId"=selection.id AND i."activityId"=root."activityId";
  IF actual_count <> selection."itemCount" OR actual_items IS DISTINCT FROM selection."selectionJson" THEN
    RAISE EXCEPTION 'contribution physical selection set mismatch' USING ERRCODE='23514',CONSTRAINT='e4_selection_guard';
  END IF;
  IF EXISTS (
    WITH policies AS MATERIALIZED (
      SELECT p.*, csm_policy_fingerprint_fn(p) AS verified_hash FROM "ContributionPolicyVersion" p
      WHERE p.id IN (SELECT r->'pointer'->>'versionId' FROM jsonb_array_elements(pointers->'resolved') r)
    )
    SELECT 1 FROM jsonb_array_elements(pointers->'resolved') r
    LEFT JOIN policies p ON p.id=r->'pointer'->>'versionId'
    WHERE p.id IS NULL OR p."policyId" IS DISTINCT FROM r->'pointer'->>'policyId'
      OR p."definitionHash" IS DISTINCT FROM r->'pointer'->>'definitionHash'
      OR to_jsonb(p."evaluatorVersion") IS DISTINCT FROM r->'pointer'->'evaluatorVersion'
      OR p."statusCode" NOT IN ('active','retired') OR p."activatedAt" IS NULL OR p."activatedByUserId" IS NULL
      OR p.verified_hash IS DISTINCT FROM p."definitionHash"
      OR to_char(p."effectiveFrom",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM r->>'effectiveFrom'
      OR to_char(p."effectiveUntil",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM r->>'effectiveUntil'
  ) THEN RAISE EXCEPTION 'contribution frozen policy unavailable' USING ERRCODE='23514',CONSTRAINT='e4_policy_guard'; END IF;
END $$;

-- One indexed collection per actual source domain. D7 sliceId is the frozen
-- allocation/ordinal key, not a fabricated ParticipantTimeAllocationSlice ID.
CREATE FUNCTION e4_source_rows(revision_id TEXT)
RETURNS TABLE(identity_id TEXT, member_id TEXT, session_id TEXT, snapshot_id TEXT,
  item_id TEXT, policy_id TEXT, policy_version_id TEXT, definition_hash TEXT, evaluator_version INTEGER,
  role_code TEXT, category_code TEXT, source_ref JSONB)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
WITH root AS MATERIALIZED (
  SELECT r.*, s."resolvedConfig" FROM "ActivitySettlementContributionRevision" r
  JOIN "ActivityRuleSnapshot" s ON s.id=r."ruleSnapshotId" AND s."activityId"=r."activityId"
  WHERE r.id=revision_id
), raw_sources AS MATERIALIZED (
  SELECT b.id AS bucket_key, b."recognizedSeconds" AS recognized_seconds,
    b."rawRecognizedMilliseconds" AS raw_ms,
    a."participationIdentityId" AS identity_id, a."memberId" AS member_id, a."sessionId" AS session_id,
    a."ruleSnapshotId" AS snapshot_id, a."ruleSnapshotHash" AS snapshot_hash, a."sourcePositionId" AS position_id,
    a.id AS allocation_id, a."allocationHash" AS allocation_hash,
    a."sourceSegmentId" AS segment_id, a."sourceSegmentRevision" AS segment_revision,
    s.id AS slice_key, s."categoryCode" AS category_code, s."startAt" AS starts_at, s."endAt" AS ends_at,
    NULL::JSONB AS correction_source
  FROM root r JOIN "ParticipantSettlementTimeBucket" b ON b."timeRevisionId"=r."timeRevisionId" AND b."activityId"=r."activityId"
  JOIN "ParticipantSettlementTimeBucketSource" bs ON bs."bucketId"=b.id AND bs."activityId"=b."activityId" AND bs."timeRevisionId"=b."timeRevisionId"
  JOIN "ParticipantTimeAllocationRevision" a ON a.id=bs."allocationRevisionId" AND a."activityId"=bs."activityId"
    AND a."participationIdentityId"=b."participationIdentityId" AND a."sourceSegmentId"=bs."sourceSegmentId" AND a."sourceSegmentRevision"=bs."sourceSegmentRevision"
  JOIN "ParticipantTimeAllocationSlice" s ON s."allocationRevisionId"=a.id AND s."activityId"=a."activityId" AND s."categoryCode"=b."categoryCode"
  JOIN "ParticipantSettlementResultRevision" rr ON rr."settlementVersionId"=r."settlementVersionId" AND rr."participationIdentityId"=a."participationIdentityId"
  WHERE r."sourceKindCode"='time_revision' AND rr."resultCode"='present'
  UNION ALL
  SELECT bucket->>'rootEntryId', (bucket->>'recognizedSeconds')::INTEGER,
    NULL::BIGINT, a."participationIdentityId", a."memberId", a."sessionId", a."ruleSnapshotId",a."ruleSnapshotHash",a."sourcePositionId",
    source->>'allocationRevisionId',source->>'allocationHash',source->>'sourceSegmentId',(source->>'sourceSegmentRevision')::INTEGER,
    (source->>'allocationRevisionId') || ':' || (slice->>'ordinal'),slice->>'categoryCode',
    (slice->>'startAt')::TIMESTAMPTZ AT TIME ZONE 'UTC',(slice->>'endAt')::TIMESTAMPTZ AT TIME ZONE 'UTC',
    jsonb_build_object('proofId',p.id,'pendingAllocationId',source->'pendingAllocationId','sourceHash',source->>'sourceHash','sliceOrdinal',slice->'ordinal')
  FROM root r JOIN "CorrectionTimeSourceProof" p ON p.id=r."correctionTimeSourceProofId"
  CROSS JOIN LATERAL jsonb_array_elements(p."sourceSnapshotJson") source
  JOIN "ParticipantTimeAllocationRevision" a ON a.id=source->>'baseAllocationRevisionId' AND a."activityId"=r."activityId"
    AND a."participationIdentityId"=source->>'participationIdentityId'
  CROSS JOIN LATERAL jsonb_array_elements(source->'slices') slice
  JOIN LATERAL jsonb_array_elements(p."calculatedBucketsJson") bucket ON bucket->>'participationIdentityId'=a."participationIdentityId"
    AND bucket->>'categoryCode'=slice->>'categoryCode'
  JOIN "ParticipantSettlementResultRevision" rr ON rr."settlementVersionId"=r."settlementVersionId" AND rr."participationIdentityId"=a."participationIdentityId"
  WHERE r."sourceKindCode"='correction_time_proof' AND rr."resultCode"='present'
), weighted AS MATERIALIZED (
  SELECT x.*, (extract(epoch FROM (ends_at-starts_at))*1000)::BIGINT AS milliseconds,
    row_number() OVER (PARTITION BY bucket_key ORDER BY allocation_id COLLATE "C",slice_key COLLATE "C") AS source_ordinal,
    sum((extract(epoch FROM (ends_at-starts_at))*1000)::BIGINT) OVER (PARTITION BY bucket_key) AS weight_sum
  FROM raw_sources x
), fractions AS MATERIALIZED (
  SELECT w.*, CASE WHEN weight_sum > 0 THEN (recognized_seconds::DOUBLE PRECISION * milliseconds::DOUBLE PRECISION)/weight_sum::DOUBLE PRECISION
    WHEN source_ordinal=1 THEN recognized_seconds::DOUBLE PRECISION ELSE 0::DOUBLE PRECISION END AS exact_seconds
  FROM weighted w
), split AS (
  SELECT f.*, floor(exact_seconds)::INTEGER
      + CASE WHEN row_number() OVER (PARTITION BY bucket_key ORDER BY exact_seconds-floor(exact_seconds) DESC,source_ordinal)
          <= recognized_seconds-sum(floor(exact_seconds)::INTEGER) OVER (PARTITION BY bucket_key) THEN 1 ELSE 0 END AS duration_seconds
  FROM fractions f
), pointers AS MATERIALIZED (
  SELECT r.id, p AS pointer FROM root r CROSS JOIN LATERAL jsonb_array_elements(r."resolvedConfig"->'contributionPolicyPointers'->'resolved') p
)
SELECT x.identity_id,x.member_id,x.session_id,x.snapshot_id,coalesce(position_item.id,activity_item.id),
  p.pointer->'pointer'->>'policyId',p.pointer->'pointer'->>'versionId',p.pointer->'pointer'->>'definitionHash',(p.pointer->'pointer'->>'evaluatorVersion')::INTEGER,
  CASE WHEN x.position_id IS NULL THEN 'member' ELSE role.value->>'attendanceRoleCode' END,
  x.category_code,
  jsonb_build_object('selectionItemId',coalesce(position_item.id,activity_item.id),'allocationRevisionId',x.allocation_id,'sliceId',x.slice_key,
    'sourceSegmentId',x.segment_id,'sourceSegmentRevision',x.segment_revision,'allocationHash',x.allocation_hash,
    'durationSeconds',x.duration_seconds,'startsAt',to_char(x.starts_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'endsAt',to_char(x.ends_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    || CASE WHEN x.correction_source IS NULL THEN '{}'::JSONB ELSE jsonb_build_object('correctionSource',x.correction_source) END
FROM split x CROSS JOIN root r
LEFT JOIN pointers p ON p.id=r.id AND (
  (x.position_id IS NULL AND p.pointer->'scope'->>'layerCode'='activity')
  OR (x.position_id IS NOT NULL AND p.pointer->'scope'->>'layerCode'='position'
    AND p.pointer->'scope'->>'sessionId'=x.session_id AND p.pointer->'scope'->>'positionId'=x.position_id))
LEFT JOIN "ActivityContributionPolicySelectionItem" activity_item ON activity_item."selectionRevisionId"=r."selectionRevisionId"
  AND activity_item."activityId"=r."activityId" AND activity_item."layerCode"='activity'
LEFT JOIN "ActivityContributionPolicySelectionItem" position_item ON position_item."selectionRevisionId"=r."selectionRevisionId"
  AND position_item."activityId"=r."activityId" AND position_item."layerCode"='position'
  AND position_item."sessionId"=x.session_id AND position_item."positionId"=x.position_id
LEFT JOIN LATERAL (
  SELECT pos.value FROM jsonb_array_elements(r."resolvedConfig"->'sessions') sess(value)
  CROSS JOIN LATERAL jsonb_array_elements(sess.value->'positions') pos(value)
  WHERE sess.value->>'sessionId'=x.session_id AND pos.value->>'positionId'=x.position_id LIMIT 1
) role ON TRUE
WHERE x.snapshot_id=r."ruleSnapshotId" AND x.snapshot_hash=r."ruleSnapshotHash"
$$;

CREATE FUNCTION e4_day_points(refs JSONB, hundredths INTEGER) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE result JSONB; single_day DATE; same_day BOOLEAN;
BEGIN
IF hundredths NOT BETWEEN 0 AND 99999 THEN RAISE EXCEPTION 'contribution day total overflow'
  USING ERRCODE='23514',CONSTRAINT='e4_day_guard'; END IF;
-- Prove the whole positive source set is one finite millisecond-precision Beijing day.
-- Unknown/noncanonical/cross-day inputs retain the original algorithm below, including errors.
IF hundredths IS NOT NULL THEN
  WITH parsed AS MATERIALIZED (
    SELECT (ref->>'durationSeconds')::DOUBLE PRECISION AS seconds,
      (ref->>'startsAt')::TIMESTAMPTZ AT TIME ZONE 'UTC' AS start_at,
      (ref->>'endsAt')::TIMESTAMPTZ AT TIME ZONE 'UTC' AS end_at,
      CASE
        WHEN pg_catalog.translate(ref->>'startsAt', '0123456789', '0000000000')
             COLLATE "C" = '0000-00-00T00:00:00.000Z' COLLATE "C"
        THEN TRUE
        ELSE (ref->>'startsAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
      END AS canonical_start,
      CASE
        WHEN pg_catalog.translate(ref->>'endsAt', '0123456789', '0000000000')
             COLLATE "C" = '0000-00-00T00:00:00.000Z' COLLATE "C"
        THEN TRUE
        ELSE (ref->>'endsAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
      END AS canonical_end
    FROM jsonb_array_elements(refs) WITH ORDINALITY x(ref,ordinal) WHERE (ref->>'durationSeconds')::INTEGER > 0
  ), proof AS MATERIALIZED (
    SELECT seconds,date_trunc('day',start_at+INTERVAL '8 hours') AS start_day,
      date_trunc('day',end_at+INTERVAL '8 hours'-INTERVAL '1 millisecond') AS end_day,
      CASE WHEN isfinite(start_at) AND isfinite(end_at)
        THEN end_at-start_at >= INTERVAL '1 millisecond' ELSE FALSE END
      AND canonical_start AND canonical_end AS valid
    FROM parsed
  ) SELECT min(start_day)::DATE,
      count(*) > 0 AND sum(seconds) BETWEEN 1 AND 2147483647
      AND min(start_day)=max(start_day)
      AND bool_and(coalesce(valid AND start_day=end_day,FALSE)) INTO single_day,same_day FROM proof;
  IF same_day IS TRUE THEN
    result=jsonb_build_array(jsonb_build_object('ledgerDate',to_char(single_day,'YYYY-MM-DD'),
      'recognizedPoints',to_char(hundredths::NUMERIC/100,'FM999999990.00')));
    IF (SELECT coalesce(sum((day->>'recognizedPoints')::NUMERIC*100),0) FROM jsonb_array_elements(result) day) <> hundredths THEN
      RAISE EXCEPTION 'contribution points require actual recognized dates' USING ERRCODE='23514',CONSTRAINT='e4_day_guard';
    END IF;
    RETURN result;
  END IF;
END IF;
WITH source AS MATERIALIZED (
  SELECT ref,(ref->>'durationSeconds')::DOUBLE PRECISION AS seconds,ordinal,
    (ref->>'startsAt')::TIMESTAMPTZ AT TIME ZONE 'UTC' AS start_at,
    (ref->>'endsAt')::TIMESTAMPTZ AT TIME ZONE 'UTC' AS end_at
  FROM jsonb_array_elements(refs) WITH ORDINALITY x(ref,ordinal) WHERE (ref->>'durationSeconds')::INTEGER > 0
), weights AS MATERIALIZED (
  SELECT d.day::DATE AS ledger_date,
    sum(seconds * ((extract(epoch FROM (least(s.end_at,d.day+INTERVAL '16 hours')-greatest(s.start_at,d.day-INTERVAL '8 hours')))*1000)::BIGINT::DOUBLE PRECISION
      / (extract(epoch FROM (s.end_at-s.start_at))*1000)::BIGINT::DOUBLE PRECISION) ORDER BY s.ordinal) AS weight
  FROM source s CROSS JOIN LATERAL generate_series(
    date_trunc('day',s.start_at+INTERVAL '8 hours'), date_trunc('day',s.end_at+INTERVAL '8 hours'-INTERVAL '1 millisecond'),INTERVAL '1 day'
  ) d(day) GROUP BY d.day::DATE
), fractions AS (
  SELECT ledger_date,(hundredths::DOUBLE PRECISION*weight)/sum(weight) OVER () AS exact FROM weights
), amounts AS (
  SELECT ledger_date,floor(exact)::INTEGER
    + CASE WHEN row_number() OVER (ORDER BY exact-floor(exact) DESC,ledger_date)
      <= hundredths-sum(floor(exact)::INTEGER) OVER () THEN 1 ELSE 0 END AS amount FROM fractions
)
SELECT coalesce(jsonb_agg(jsonb_build_object('ledgerDate',to_char(ledger_date,'YYYY-MM-DD'),
  'recognizedPoints',to_char(amount::NUMERIC/100,'FM999999990.00')) ORDER BY ledger_date),'[]'::JSONB) INTO result FROM amounts;
IF (SELECT coalesce(sum((day->>'recognizedPoints')::NUMERIC*100),0) FROM jsonb_array_elements(result) day) <> hundredths THEN
  RAISE EXCEPTION 'contribution points require actual recognized dates' USING ERRCODE='23514',CONSTRAINT='e4_day_guard';
END IF;
RETURN result;
END
$$;

CREATE FUNCTION e4_expected_evaluations(revision_id TEXT)
RETURNS TABLE(unit_canonical TEXT,evaluation JSONB)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
WITH revision_domain AS MATERIALIZED (
  SELECT astr_canonical_json(jsonb_build_object('domain',
    (SELECT "sourceKindCode" FROM "ActivitySettlementContributionRevision" WHERE id=revision_id))->'domain') AS canonical
), sources AS MATERIALIZED (
  SELECT source.*,astr_canonical_json(source_ref) AS source_canonical FROM e4_source_rows(revision_id) source
), groups AS MATERIALIZED (
  SELECT identity_id,member_id,session_id,snapshot_id,policy_id,policy_version_id,definition_hash,evaluator_version,role_code,category_code,
    min(item_id COLLATE "C") AS representative,
    sum((source_ref->>'durationSeconds')::BIGINT)::INTEGER AS seconds,
    jsonb_agg(source_ref ORDER BY source_canonical COLLATE "C") AS refs,
    '[' || string_agg(coalesce(source_canonical,'null'),',' ORDER BY source_canonical COLLATE "C") || ']' AS refs_canonical
  FROM sources GROUP BY identity_id,member_id,session_id,snapshot_id,policy_id,policy_version_id,definition_hash,evaluator_version,role_code,category_code
), policy_bands AS MATERIALIZED (
  SELECT p.id,role->>'attendanceRoleCode' AS role_code,category->>'timeCategoryCode' AS category_code,band,ordinal
  FROM "ContributionPolicyVersion" p
  CROSS JOIN LATERAL jsonb_array_elements(p."definitionJson"->'roleRules') role
  CROSS JOIN LATERAL jsonb_array_elements(role->'categoryRules') category
  CROSS JOIN LATERAL jsonb_array_elements(category->'durationBands') WITH ORDINALITY b(band,ordinal)
  WHERE p.id IN (SELECT DISTINCT policy_version_id FROM groups)
), selected AS MATERIALIZED (
  SELECT g.identity_id,g.member_id,g.session_id,g.snapshot_id,g.policy_id,g.policy_version_id,g.definition_hash,g.evaluator_version,g.role_code,g.category_code,
    g.representative,g.seconds,g.refs_canonical,resolved.result,
    astr_canonical_json(jsonb_build_object('participationIdentityId',g.identity_id,'sessionId',g.session_id,
      'mode','policy','policyId',g.policy_id,'policyVersionId',g.policy_version_id,'definitionHash',g.definition_hash,
      'evaluatorVersion',g.evaluator_version,'attendanceRoleCode',g.role_code,'timeCategoryCode',g.category_code)) AS unit,
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
      'evaluationUnitKey',e4_envelope_hash(jsonb_build_object('unit',unit)),'durationSeconds',seconds,
      'sourceFingerprint',encode(sha256(convert_to('{"definition":{"domain":' || (SELECT canonical FROM revision_domain)
        || ',"sources":' || refs_canonical || '},"schemaVersion":1}','UTF8')),'hex'),
      'calculatedPoints',result->>'recognizedPoints','recognizedPoints',result->>'recognizedPoints','explanationCode',result->>'explanationCode',
      'beijingDayPointsJson',day_points) AS metadata
  FROM selected
), canonical_documents AS NOT MATERIALIZED (
  SELECT unit,refs_canonical,metadata,
    (SELECT '{' || string_agg(to_jsonb(field_name)::TEXT || ':' || field_canonical,',' ORDER BY field_name COLLATE "C") || '}'
     FROM (
       SELECT key AS field_name,astr_canonical_json(value) AS field_canonical FROM jsonb_each(metadata)
       UNION ALL SELECT 'sourceRefsJson',refs_canonical
     ) field) AS document_canonical
  FROM documents
)
SELECT unit,metadata || jsonb_build_object('sourceRefsJson',refs_canonical::JSONB,
  'evaluationHash',encode(sha256(convert_to('{"definition":' || document_canonical || ',"schemaVersion":1}','UTF8')),'hex'))
FROM canonical_documents
$$;

-- Exact stored document; unknown source/day keys cannot survive comparison with recomputation.
CREATE FUNCTION e4_evaluation_document(evaluation_row "ParticipantContributionEvaluation") RETURNS JSONB
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('participationIdentityId',evaluation_row."participationIdentityId",'memberId',evaluation_row."memberId",'sessionId',evaluation_row."sessionId",
    'ruleSnapshotId',evaluation_row."ruleSnapshotId",'selectionItemId',evaluation_row."selectionItemId",'mode',evaluation_row.mode,'policyId',evaluation_row."policyId",
    'policyVersionId',evaluation_row."policyVersionId",'definitionHash',evaluation_row."definitionHash",'evaluatorVersion',evaluation_row."evaluatorVersion",
    'attendanceRoleCode',evaluation_row."attendanceRoleCode",'timeCategoryCode',evaluation_row."timeCategoryCode",'evaluationUnitKey',evaluation_row."evaluationUnitKey",
    'durationSeconds',evaluation_row."durationSeconds",'sourceRefsJson',evaluation_row."sourceRefsJson",'sourceFingerprint',evaluation_row."sourceFingerprint",
    'calculatedPoints',to_char(evaluation_row."calculatedPoints",'FM999990.00'),'recognizedPoints',to_char(evaluation_row."recognizedPoints",'FM999990.00'),
    'explanationCode',evaluation_row."explanationCode",'beijingDayPointsJson',evaluation_row."beijingDayPointsJson",'evaluationHash',evaluation_row."evaluationHash")
$$;

-- V1 is reconstructed from the actual newly frozen result rows. Historical V1/V2
-- functions and fingerprints are neither replaced nor rewritten by this migration.
CREATE FUNCTION e4_version_v1_hash(version_id TEXT) RETURNS TEXT
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
  SELECT e4_hash(jsonb_build_object('schemaVersion',1,'activityId',run."activityId",'settlementRunId',v."settlementRunId",
    'evidenceSealId',v."evidenceSealId",'sealRevision',s."sealRevision",'evidenceRevision',v."evidenceRevision",
    'populationRevision',v."populationRevision",'workflowRevision',v."workflowRevision",'personCount',v."personCount",
    'sessionParticipationCount',v."sessionParticipationCount",'serviceSegmentCount',v."serviceSegmentCount",'items',coalesce((
      SELECT jsonb_agg(jsonb_build_object('participationIdentityId',r."participationIdentityId",'resultCode',r."resultCode",
        'lateFlag',r."lateFlag",'earlyLeaveFlag',r."earlyLeaveFlag",'exceptionFlags',r."exceptionFlagsJson",
        'recognizedServiceHours',to_char(r."recognizedServiceHours",'FM999990.00'),
        'recognizedContributionPoints',to_char(r."recognizedContributionPoints",'FM999990.00'),
        'calculatedServiceHours',to_char(r."calculatedServiceHours",'FM999990.00'),
        'calculatedContributionPoints',to_char(r."calculatedContributionPoints",'FM999990.00'),'adjustmentReason',r."adjustmentReason")
        ORDER BY r."participationIdentityId" COLLATE "C") FROM "ParticipantSettlementResultRevision" r WHERE r."settlementVersionId"=v.id
    ),'[]'::JSONB))) FROM "AttendanceSettlementVersion" v JOIN "AttendanceSettlementRun" run ON run.id=v."settlementRunId"
    JOIN "EvidenceSeal" s ON s.id=v."evidenceSealId" WHERE v.id=version_id
$$;

CREATE FUNCTION e4_version_content_hash(revision_id TEXT) RETURNS TEXT
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN r."kindCode"='submitted' THEN e4_hash(jsonb_build_object(
    'domain','activity-contribution-settlement-content-v3','schemaVersion',3,'contributionRegimeCode','policy_v1',
    'originalContentHash',e4_version_v1_hash(r."settlementVersionId"),'bucketContentHash',t."bucketContentHash",'sourceSetHash',t."sourceSetHash",
    'contributionSelectionHash',r."selectionRevisionHash",'contributionSourceSetHash',r."sourceSetHash",'contributionEvaluationSetHash',r."evaluationSetHash"))
  WHEN r."kindCode"='correction' THEN e4_hash(jsonb_build_object(
    'domain','activity-contribution-correction-content-v3','schemaVersion',3,'contributionRegimeCode','policy_v1',
    'originalContentHash',e4_version_v1_hash(r."settlementVersionId"),'sourceKindCode',r."sourceKindCode",
    'correctionApplicationId',r."correctionApplicationId",'postingBatchId',r."correctionPostingBatchId",
    'baseSettlementVersionId',r."baseSettlementVersionId",'settlementVersionId',r."settlementVersionId",
    'previousContributionRevisionId',r."previousContributionRevisionId",'correctionSourceSetHash',r."correctionSourceSetHash",
    'effectiveTimeSettlementVersionId',r."effectiveTimeSettlementVersionId",
    'contributionSelectionHash',r."selectionRevisionHash",'contributionSourceSetHash',r."sourceSetHash",'contributionEvaluationSetHash',r."evaluationSetHash"))
  ELSE NULL END FROM "ActivitySettlementContributionRevision" r
  LEFT JOIN "ActivitySettlementTimeRevision" t ON t.id=r."timeRevisionId" WHERE r.id=revision_id
$$;

CREATE FUNCTION e4_assert_complete(revision_id TEXT, validate_version BOOLEAN DEFAULT TRUE) RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE root "ActivitySettlementContributionRevision"; version_row "AttendanceSettlementVersion";
  time_row "ActivitySettlementTimeRevision"; previous "ActivitySettlementContributionRevision";
  source_draft "ActivitySettlementContributionRevision"; application "CorrectionApplication";
  request_row "AttendanceCorrectionRequest"; manifest "ParticipationTimeCorrectionManifest";
  time_proof "CorrectionTimeSourceProof"; counts BIGINT; total NUMERIC; sources_hash TEXT; evaluations_hash TEXT;
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
    IF EXISTS (SELECT 1 FROM e4_source_rows(root.id) s WHERE identity_id IS NULL OR member_id IS NULL OR session_id IS NULL
      OR snapshot_id IS DISTINCT FROM root."ruleSnapshotId" OR item_id IS NULL OR policy_id IS NULL OR policy_version_id IS NULL
      OR definition_hash IS NULL OR evaluator_version IS DISTINCT FROM 1 OR role_code IS NULL
      OR category_code NOT IN ('volunteer_service','training','organization','non_creditable')
      OR (source_ref->>'durationSeconds')::INTEGER < 0 OR (source_ref->>'startsAt')::TIMESTAMPTZ >= (source_ref->>'endsAt')::TIMESTAMPTZ)
    THEN RAISE EXCEPTION 'contribution unresolved source' USING ERRCODE='23514',CONSTRAINT='e4_source_guard'; END IF;
    IF EXISTS (
      WITH expected AS NOT MATERIALIZED (
        SELECT evaluation->>'evaluationUnitKey' AS key,evaluation
        FROM e4_expected_evaluations(root.id)
      ), actual AS MATERIALIZED (
        SELECT e.id,e."evaluationUnitKey" AS key
        FROM "ParticipantContributionEvaluation" e
        WHERE e."contributionRevisionId"=root.id
      ), pairs AS MATERIALIZED (
        SELECT a.id AS actual_id,
          x.evaluation IS DISTINCT FROM
            CASE WHEN e.id IS NULL THEN NULL::JSONB
                 ELSE e4_evaluation_document(e) END AS is_mismatch
        FROM (expected x FULL JOIN actual a USING (key))
        LEFT JOIN "ParticipantContributionEvaluation" e
          ON e.id=a.id AND e."contributionRevisionId"=root.id
      )
      SELECT 1
      FROM pairs p
      WHERE p.is_mismatch
    ) THEN RAISE EXCEPTION 'contribution evaluation set mismatch' USING ERRCODE='23514',CONSTRAINT='e4_evaluation_guard'; END IF;
  END IF;
  WITH documents AS MATERIALIZED (
    SELECT e.*,astr_canonical_json(jsonb_build_object('participationIdentityId',e."participationIdentityId",'sessionId',e."sessionId",
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
END $$;

CREATE FUNCTION e4_assert_ledger_complete(revision_id TEXT, batch_id TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE root "ActivitySettlementContributionRevision"; batch "LedgerPostingBatch";
BEGIN
  SELECT * INTO STRICT root FROM "ActivitySettlementContributionRevision" WHERE id=revision_id;
  SELECT * INTO STRICT batch FROM "LedgerPostingBatch" WHERE id=batch_id;
  IF root."kindCode" NOT IN ('submitted','correction') OR batch."settlementVersionId" <> root."settlementVersionId"
    OR batch."settlementRunId" <> root."settlementRunId"
    OR (root."kindCode"='correction' AND batch.id <> root."correctionPostingBatchId")
  THEN RAISE EXCEPTION 'contribution posting batch mismatch' USING ERRCODE='23514',CONSTRAINT='e4_ledger_guard'; END IF;
  IF EXISTS (
    WITH expected AS MATERIALIZED (
      SELECT e."participationIdentityId",(day->>'ledgerDate')::DATE AS date,sum((day->>'recognizedPoints')::NUMERIC) AS amount
      FROM "ParticipantContributionEvaluation" e CROSS JOIN LATERAL jsonb_array_elements(e."beijingDayPointsJson") day
      WHERE e."contributionRevisionId"=root.id GROUP BY e."participationIdentityId",(day->>'ledgerDate')::DATE
    ), days AS MATERIALIZED (
      SELECT d.*,r."participationIdentityId",i."memberId" AS identity_member
      FROM "ParticipantSettlementDay" d JOIN "ParticipantSettlementResultRevision" r ON r.id=d."resultRevisionId"
      JOIN "ActivityParticipationIdentity" i ON i.id=r."participationIdentityId" WHERE r."settlementVersionId"=root."settlementVersionId"
    ) SELECT 1 FROM expected x FULL JOIN days d ON d."participationIdentityId"=x."participationIdentityId" AND d."ledgerDate"=x.date
    WHERE d.id IS NULL OR d."memberId" <> d.identity_member OR d."recognizedPoints" IS DISTINCT FROM coalesce(x.amount,0)
  ) OR EXISTS (
    WITH days AS MATERIALIZED (
      SELECT d.*,r."participationIdentityId",i."memberId" AS identity_member,i."sessionId" AS identity_session
      FROM "ParticipantSettlementDay" d JOIN "ParticipantSettlementResultRevision" r ON r.id=d."resultRevisionId"
      JOIN "ActivityParticipationIdentity" i ON i.id=r."participationIdentityId" WHERE r."settlementVersionId"=root."settlementVersionId"
    ), credits AS MATERIALIZED (
      SELECT * FROM "ParticipationLedgerEntry" WHERE "postingBatchId"=batch.id AND "entryTypeCode"='contribution_credit'
    ) SELECT 1 FROM days d FULL JOIN credits c ON c."resultRevisionId"=d."resultRevisionId" AND c."ledgerDate"=d."ledgerDate"
    WHERE d.id IS NULL OR c.id IS NULL OR c."activityId" <> root."activityId" OR c."memberId" <> d.identity_member
      OR c."sessionId" <> d.identity_session OR c."participationIdentityId" <> d."participationIdentityId"
      OR c."recognizedPointsDelta" <> d."recognizedPoints" OR c."creditedPointsDelta" <> d."creditedPoints"
      OR c."cappedOutPointsDelta" <> d."cappedOutPoints" OR c."serviceHoursDelta" <> 0
      OR c."recognizedPointsDelta" <> c."creditedPointsDelta"+c."cappedOutPointsDelta" OR c."reversesEntryId" IS NOT NULL
  ) OR EXISTS (
    SELECT 1 FROM "ParticipationLedgerEntry" e WHERE e."postingBatchId"=batch.id AND e."entryTypeCode"='service_credit'
      AND (e."recognizedPointsDelta" <> 0 OR e."creditedPointsDelta" <> 0 OR e."cappedOutPointsDelta" <> 0)
  ) THEN RAISE EXCEPTION 'contribution day/credit set mismatch' USING ERRCODE='23514',CONSTRAINT='e4_ledger_guard'; END IF;
END $$;

-- One set guard per inserted root, not one full scan per evaluation row.
CREATE FUNCTION e4_evaluation_set_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE root_id TEXT;
BEGIN
  FOR root_id IN SELECT DISTINCT "contributionRevisionId" FROM e4_inserted_evaluations LOOP
    PERFORM e4_assert_complete(root_id,FALSE);
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER e4_evaluation_set_guard AFTER INSERT ON "ParticipantContributionEvaluation"
  REFERENCING NEW TABLE AS e4_inserted_evaluations FOR EACH STATEMENT EXECUTE FUNCTION e4_evaluation_set_guard();

CREATE FUNCTION e4_revision_complete_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM e4_assert_complete(NEW.id);
  IF NEW."kindCode" IN ('draft','submitted') AND NOT EXISTS (
    SELECT 1 FROM "ActivitySettlementTimeCommandReceipt" WHERE "timeRevisionId"=NEW."timeRevisionId"
  ) THEN RAISE EXCEPTION 'contribution requires sealed D4 receipt' USING ERRCODE='23514',CONSTRAINT='e4_source_guard'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER e4_revision_complete_guard AFTER INSERT ON "ActivitySettlementContributionRevision"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION e4_revision_complete_guard();

CREATE FUNCTION e4_version_regime_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW."contributionRegimeCode" IS DISTINCT FROM OLD."contributionRegimeCode"
      OR (OLD."contributionRegimeCode"='policy_v1' AND NEW."settlementRunId" <> OLD."settlementRunId")
    THEN RAISE EXCEPTION 'contribution regime cannot change' USING ERRCODE='23514',CONSTRAINT='e4_regime_guard'; END IF;
  ELSIF EXISTS (SELECT 1 FROM "AttendanceSettlementVersion" v WHERE v."settlementRunId"=NEW."settlementRunId"
    AND v."contributionRegimeCode" <> NEW."contributionRegimeCode") THEN
    RAISE EXCEPTION 'contribution regime cannot switch within a historical run' USING ERRCODE='23514',CONSTRAINT='e4_regime_guard';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER e4_version_regime_guard BEFORE INSERT OR UPDATE ON "AttendanceSettlementVersion"
  FOR EACH ROW EXECUTE FUNCTION e4_version_regime_guard();

CREATE FUNCTION e4_native_version_complete_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE current_version "AttendanceSettlementVersion"; root_id TEXT;
BEGIN
  IF NEW."contributionRegimeCode"='legacy' THEN RETURN NULL; END IF;
  SELECT * INTO STRICT current_version FROM "AttendanceSettlementVersion" WHERE id=NEW.id;
  IF current_version."statusCode"='draft' THEN
    IF EXISTS (SELECT 1 FROM "ParticipantSettlementResultRevision" r WHERE r."settlementVersionId"=NEW.id
      AND (r."recognizedContributionPoints" <> 0 OR r."calculatedContributionPoints" <> 0)) THEN
      RAISE EXCEPTION 'native draft contribution remains pending' USING ERRCODE='23514',CONSTRAINT='e4_pending_guard';
    END IF;
  ELSE
    SELECT id INTO root_id FROM "ActivitySettlementContributionRevision" WHERE "settlementVersionId"=NEW.id
      AND "kindCode" IN ('submitted','correction') ORDER BY revision DESC LIMIT 1;
    IF root_id IS NULL THEN RAISE EXCEPTION 'native version requires own proof' USING ERRCODE='23514',CONSTRAINT='e4_version_guard'; END IF;
    PERFORM e4_assert_complete(root_id);
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER e4_native_version_complete_guard AFTER INSERT OR UPDATE ON "AttendanceSettlementVersion"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION e4_native_version_complete_guard();

CREATE FUNCTION e4_native_posting_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE root_id TEXT; regime TEXT;
BEGIN
  IF NEW."statusCode" NOT IN ('ready','committed') OR (TG_OP='UPDATE' AND NEW."statusCode"=OLD."statusCode") THEN RETURN NEW; END IF;
  SELECT "contributionRegimeCode" INTO STRICT regime FROM "AttendanceSettlementVersion" WHERE id=NEW."settlementVersionId";
  IF regime='legacy' THEN RETURN NEW; END IF;
  SELECT id INTO root_id FROM "ActivitySettlementContributionRevision" WHERE "settlementVersionId"=NEW."settlementVersionId"
    AND "kindCode" IN ('submitted','correction') ORDER BY revision DESC LIMIT 1;
  IF root_id IS NULL THEN RAISE EXCEPTION 'native posting requires own proof' USING ERRCODE='23514',CONSTRAINT='e4_ledger_guard'; END IF;
  PERFORM e4_assert_complete(root_id);
  PERFORM e4_assert_ledger_complete(root_id,NEW.id);
  -- Existing ptc/ctsp committed guards still execute after the original member/day
  -- locks. No E3 receipt shortcut exempts this independent contribution guard.
  RETURN NEW;
END $$;
CREATE TRIGGER e4_native_posting_guard BEFORE INSERT OR UPDATE OF "statusCode" ON "LedgerPostingBatch"
  FOR EACH ROW EXECUTE FUNCTION e4_native_posting_guard();

-- One immutable, committed native alias. No recursive history walk and no
-- synthetic D4/D7 proof at the unchanged business version.
CREATE FUNCTION e4_effective_time_base(version_id TEXT, activity_id TEXT, run_id TEXT)
RETURNS TABLE("effectiveVersionId" TEXT, "contributionRevisionId" TEXT)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
  SELECT own."effectiveTimeSettlementVersionId", own.id
  FROM "ActivitySettlementContributionRevision" own
  JOIN "AttendanceSettlementVersion" v ON v.id=own."settlementVersionId"
    AND v."settlementRunId"=own."settlementRunId" AND v."contributionRegimeCode"='policy_v1'
  JOIN "CorrectionApplication" a ON a.id=own."correctionApplicationId"
    AND a."newPostingBatchId"=own."correctionPostingBatchId" AND a."newSettlementVersionId"=own."settlementVersionId"
    AND a."statusCode"='committed'
  JOIN "LedgerPostingBatch" b ON b.id=own."correctionPostingBatchId"
    AND b."settlementVersionId"=own."settlementVersionId" AND b."settlementRunId"=own."settlementRunId"
    AND b."statusCode"='committed'
  JOIN "ActivitySettlementContributionRevision" prior ON prior.id=own."previousContributionRevisionId"
    AND prior."settlementVersionId"=own."baseSettlementVersionId"
    AND prior."settlementRunId"=own."settlementRunId" AND prior."activityId"=own."activityId"
    AND prior."kindCode" IN ('submitted','correction')
    AND prior."effectiveTimeSettlementVersionId"=own."effectiveTimeSettlementVersionId"
  WHERE own."settlementVersionId"=version_id AND own."activityId"=activity_id AND own."settlementRunId"=run_id
    AND own."kindCode"='correction' AND own."sourceKindCode"='unchanged_time' AND own."regimeCode"='policy_v1'
    AND own."effectiveTimeSettlementVersionId" <> version_id
$$;

-- The original checks remain for every legacy/direct base. Only a committed
-- E4 unchanged-time proof resolves the effective base used for time pairing;
-- the approved request and manifest still bind the CURRENT business base.
CREATE OR REPLACE FUNCTION ptcm_guard_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  root "ParticipationTimeLedgerManifest"%ROWTYPE;
  prior "ParticipationTimeCorrectionManifest"%ROWTYPE;
  batch_status TEXT;
  request_row RECORD;
  effective_base TEXT;
BEGIN
  SELECT "statusCode" INTO batch_status FROM "LedgerPostingBatch"
    WHERE "id" = NEW."postingBatchId" FOR UPDATE;
  IF batch_status IS DISTINCT FROM 'preparing' THEN
    RAISE EXCEPTION 'time correction batch is not preparing'
      USING ERRCODE = '23514', CONSTRAINT = 'ptcm_insert_guard';
  END IF;
  SELECT m.* INTO root FROM "ParticipationTimeLedgerManifest" m
    JOIN "LedgerPostingBatch" b ON b."id" = m."postingBatchId" AND b."statusCode" = 'committed'
    WHERE m."id" = NEW."rootManifestId" AND m."activityId" = NEW."activityId"
      AND m."settlementRunId" = NEW."settlementRunId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'time correction root is unavailable'
      USING ERRCODE = '23514', CONSTRAINT = 'ptcm_insert_guard';
  END IF;
  SELECT "effectiveVersionId" INTO effective_base FROM e4_effective_time_base(
    NEW."baseSettlementVersionId", NEW."activityId", NEW."settlementRunId");
  IF NOT FOUND THEN effective_base := NEW."baseSettlementVersionId"; END IF;
  IF NEW."predecessorManifestId" IS NULL THEN
    IF effective_base <> root."settlementVersionId"
      OR NEW."baseContentHash" <> root."contentHash" THEN
      RAISE EXCEPTION 'time correction initial anchor mismatch'
        USING ERRCODE = '23514', CONSTRAINT = 'ptcm_insert_guard';
    END IF;
  ELSE
    SELECT m.* INTO prior FROM "ParticipationTimeCorrectionManifest" m
      JOIN "ParticipationTimeCorrectionCommitReceipt" r
        ON r."manifestId" = m."id" AND r."contentHash" = m."contentHash"
      JOIN "LedgerPostingBatch" b ON b."id" = m."postingBatchId" AND b."statusCode" = 'committed'
      WHERE m."id" = NEW."predecessorManifestId";
    IF NOT FOUND OR prior."rootManifestId" <> NEW."rootManifestId"
      OR prior."settlementVersionId" <> effective_base
      OR prior."activityId" <> NEW."activityId"
      OR prior."settlementRunId" <> NEW."settlementRunId"
      OR prior."contentHash" <> NEW."baseContentHash" THEN
      RAISE EXCEPTION 'time correction predecessor mismatch'
        USING ERRCODE = '23514', CONSTRAINT = 'ptcm_insert_guard';
    END IF;
  END IF;
  SELECT "requestedChangeJson", "statusCode" INTO request_row
    FROM "AttendanceCorrectionRequest" WHERE "id" = NEW."correctionRequestId" FOR SHARE;
  IF NOT FOUND OR request_row."statusCode" NOT IN ('approved', 'applying')
    OR request_row."requestedChangeJson"->'timeCorrection'->>'baseSettlementVersionId'
      IS DISTINCT FROM NEW."baseSettlementVersionId"
    OR request_row."requestedChangeJson"->'timeCorrection'->>'baseTimeLedgerHash'
      IS DISTINCT FROM NEW."baseContentHash" THEN
    RAISE EXCEPTION 'time correction approved request mismatch'
      USING ERRCODE = '23514', CONSTRAINT = 'ptcm_insert_guard';
  END IF;
  IF request_row."requestedChangeJson"->'schemaVersion' = '2'::jsonb THEN
    IF request_row."requestedChangeJson"->'segments' IS DISTINCT FROM '[]'::jsonb THEN
      RAISE EXCEPTION 'legacy V2 correction must not contain segments'
        USING ERRCODE = '23514', CONSTRAINT = 'ptcm_insert_guard';
    END IF;
    IF prior.id IS NULL OR prior."sourceProofId" IS NULL THEN
      IF NEW."formatVersion" <> 1 OR NEW."sourceProofId" IS NOT NULL OR NEW."sourceProofHash" IS NOT NULL THEN
        RAISE EXCEPTION 'legacy V2 correction proof format is invalid'
          USING ERRCODE = '23514', CONSTRAINT = 'ptcm_insert_guard';
      END IF;
    ELSIF NEW."formatVersion" <> 2
      OR NEW."sourceProofId" IS DISTINCT FROM prior."sourceProofId"
      OR NEW."sourceProofHash" IS DISTINCT FROM prior."sourceProofHash" THEN
      RAISE EXCEPTION 'V2 successor must inherit its direct predecessor proof'
        USING ERRCODE = '23514', CONSTRAINT = 'ptcm_insert_guard';
    END IF;
  ELSIF request_row."requestedChangeJson"->'schemaVersion' = '3'::jsonb THEN
    IF NEW."formatVersion" <> 2
      OR NEW."sourceProofId" IS NULL
      OR NEW."sourceProofHash" IS NULL
      OR request_row."requestedChangeJson"->'segments' = '[]'::jsonb
      OR jsonb_typeof(request_row."requestedChangeJson"->'allocations') <> 'array' THEN
      RAISE EXCEPTION 'V3 correction source proof is required'
        USING ERRCODE = '23514', CONSTRAINT = 'ptcm_insert_guard';
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported correction schema version'
      USING ERRCODE = '23514', CONSTRAINT = 'ptcm_insert_guard';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
