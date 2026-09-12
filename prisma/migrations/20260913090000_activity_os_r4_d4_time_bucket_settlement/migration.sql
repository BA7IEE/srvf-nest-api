-- Activity OS R4 / D4, migration 121. Expand only; permanent retention.
-- Old D3 V1 remains committed-only. No historical SQL, business row or Gate is changed.
BEGIN;

-- AlterTable
ALTER TABLE "ParticipantTimeAllocationRevision" ADD COLUMN     "settlementDraftContentHash" TEXT,
ADD COLUMN     "settlementDraftVersionId" TEXT,
ADD COLUMN     "settlementEvidenceRevision" INTEGER,
ADD COLUMN     "settlementEvidenceSealId" TEXT,
ADD COLUMN     "settlementPopulationRevision" INTEGER,
ADD COLUMN     "settlementWorkflowRevision" INTEGER;

-- CreateTable
CREATE TABLE "ActivitySettlementTimeRevision" (
    "id" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "settlementRunId" TEXT NOT NULL,
    "settlementVersionId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "previousTimeRevisionId" TEXT,
    "kindCode" TEXT NOT NULL,
    "sourceDraftTimeRevisionId" TEXT,
    "evidenceSealId" TEXT NOT NULL,
    "evidenceRevision" INTEGER NOT NULL,
    "populationRevision" INTEGER NOT NULL,
    "workflowRevision" INTEGER NOT NULL,
    "draftContentHash" TEXT NOT NULL,
    "sourceSetHash" TEXT NOT NULL,
    "bucketContentHash" TEXT NOT NULL,
    "bucketCount" INTEGER NOT NULL,
    "sourceCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT NOT NULL,

    CONSTRAINT "ActivitySettlementTimeRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParticipantSettlementTimeBucket" (
    "id" TEXT NOT NULL,
    "timeRevisionId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "participationIdentityId" TEXT NOT NULL,
    "categoryCode" TEXT NOT NULL,
    "calculatedSeconds" INTEGER,
    "recognizedSeconds" INTEGER NOT NULL,
    "adjustmentReason" JSONB,
    "timePolicyVersionId" TEXT,
    "definitionHash" TEXT,
    "evaluatorVersion" INTEGER,
    "quantumSeconds" INTEGER,
    "rawCalculatedMilliseconds" BIGINT,
    "rawRecognizedMilliseconds" BIGINT NOT NULL,

    CONSTRAINT "ParticipantSettlementTimeBucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParticipantSettlementTimeBucketSource" (
    "id" TEXT NOT NULL,
    "bucketId" TEXT NOT NULL,
    "timeRevisionId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "allocationRevisionId" TEXT NOT NULL,
    "sourceSegmentId" TEXT NOT NULL,
    "sourceSegmentRevision" INTEGER NOT NULL,
    "rawCalculatedMilliseconds" BIGINT,
    "rawRecognizedMilliseconds" BIGINT NOT NULL,

    CONSTRAINT "ParticipantSettlementTimeBucketSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivitySettlementTimeCommandReceipt" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "operationCode" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "timeRevisionId" TEXT NOT NULL,
    "resultJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivitySettlementTimeCommandReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "astr_version_idx" ON "ActivitySettlementTimeRevision"("settlementVersionId");

-- CreateIndex
CREATE INDEX "astr_activity_created_idx" ON "ActivitySettlementTimeRevision"("activityId", "createdAt");

-- CreateIndex
CREATE INDEX "astr_source_draft_idx" ON "ActivitySettlementTimeRevision"("sourceDraftTimeRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "astr_run_revision_key" ON "ActivitySettlementTimeRevision"("settlementRunId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "astr_id_activity_key" ON "ActivitySettlementTimeRevision"("id", "activityId");

-- CreateIndex
CREATE UNIQUE INDEX "astr_id_run_activity_key" ON "ActivitySettlementTimeRevision"("id", "settlementRunId", "activityId");

-- CreateIndex
CREATE INDEX "pstb_activity_identity_idx" ON "ParticipantSettlementTimeBucket"("activityId", "participationIdentityId");

-- CreateIndex
CREATE UNIQUE INDEX "pstb_revision_identity_category_key" ON "ParticipantSettlementTimeBucket"("timeRevisionId", "participationIdentityId", "categoryCode");

-- CreateIndex
CREATE UNIQUE INDEX "pstb_id_revision_activity_key" ON "ParticipantSettlementTimeBucket"("id", "timeRevisionId", "activityId");

-- CreateIndex
CREATE INDEX "pstbs_revision_idx" ON "ParticipantSettlementTimeBucketSource"("timeRevisionId");

-- CreateIndex
CREATE INDEX "pstbs_allocation_idx" ON "ParticipantSettlementTimeBucketSource"("allocationRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "pstbs_bucket_allocation_key" ON "ParticipantSettlementTimeBucketSource"("bucketId", "allocationRevisionId");

-- CreateIndex
CREATE INDEX "astcr_activity_created_idx" ON "ActivitySettlementTimeCommandReceipt"("activityId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "astcr_actor_operation_key" ON "ActivitySettlementTimeCommandReceipt"("actorUserId", "operationCode", "operationKey");

-- CreateIndex
CREATE UNIQUE INDEX "astcr_revision_activity_key" ON "ActivitySettlementTimeCommandReceipt"("timeRevisionId", "activityId");

-- CreateIndex
CREATE UNIQUE INDEX "tpv_id_hash_evaluator_key" ON "TimePolicyVersion"("id", "definitionHash", "evaluatorVersion");

-- CreateIndex
CREATE INDEX "ptar_settlement_draft_idx" ON "ParticipantTimeAllocationRevision"("settlementDraftVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "ptar_id_source_revision_activity_key" ON "ParticipantTimeAllocationRevision"("id", "sourceSegmentId", "sourceSegmentRevision", "activityId");

-- CreateIndex
CREATE UNIQUE INDEX "api_id_activity_key" ON "ActivityParticipationIdentity"("id", "activityId");

-- CreateIndex
CREATE UNIQUE INDEX "seal_id_activity_revisions_key" ON "EvidenceSeal"("id", "activityId", "evidenceRevision", "populationRevision", "workflowRevision");

-- CreateIndex
CREATE UNIQUE INDEX "asr_id_activity_key" ON "AttendanceSettlementRun"("id", "activityId");

-- CreateIndex
CREATE UNIQUE INDEX "asv_id_run_key" ON "AttendanceSettlementVersion"("id", "settlementRunId");

-- CreateIndex
CREATE UNIQUE INDEX "asv_id_seal_revisions_hash_key" ON "AttendanceSettlementVersion"("id", "evidenceSealId", "evidenceRevision", "populationRevision", "workflowRevision", "contentHash");

-- AddForeignKey
ALTER TABLE "ParticipantTimeAllocationRevision" ADD CONSTRAINT "ptar_settlement_draft_fkey" FOREIGN KEY ("settlementDraftVersionId", "settlementEvidenceSealId", "settlementEvidenceRevision", "settlementPopulationRevision", "settlementWorkflowRevision", "settlementDraftContentHash") REFERENCES "AttendanceSettlementVersion"("id", "evidenceSealId", "evidenceRevision", "populationRevision", "workflowRevision", "contentHash") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ParticipantTimeAllocationRevision" ADD CONSTRAINT "ptar_settlement_seal_fkey" FOREIGN KEY ("settlementEvidenceSealId", "activityId", "settlementEvidenceRevision", "settlementPopulationRevision", "settlementWorkflowRevision") REFERENCES "EvidenceSeal"("id", "activityId", "evidenceRevision", "populationRevision", "workflowRevision") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivitySettlementTimeRevision" ADD CONSTRAINT "astr_activity_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivitySettlementTimeRevision" ADD CONSTRAINT "astr_run_fkey" FOREIGN KEY ("settlementRunId", "activityId") REFERENCES "AttendanceSettlementRun"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivitySettlementTimeRevision" ADD CONSTRAINT "astr_version_fkey" FOREIGN KEY ("settlementVersionId", "settlementRunId") REFERENCES "AttendanceSettlementVersion"("id", "settlementRunId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivitySettlementTimeRevision" ADD CONSTRAINT "astr_seal_fkey" FOREIGN KEY ("evidenceSealId", "activityId", "evidenceRevision", "populationRevision", "workflowRevision") REFERENCES "EvidenceSeal"("id", "activityId", "evidenceRevision", "populationRevision", "workflowRevision") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivitySettlementTimeRevision" ADD CONSTRAINT "astr_previous_fkey" FOREIGN KEY ("previousTimeRevisionId", "settlementRunId", "activityId") REFERENCES "ActivitySettlementTimeRevision"("id", "settlementRunId", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivitySettlementTimeRevision" ADD CONSTRAINT "astr_source_draft_fkey" FOREIGN KEY ("sourceDraftTimeRevisionId", "settlementRunId", "activityId") REFERENCES "ActivitySettlementTimeRevision"("id", "settlementRunId", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivitySettlementTimeRevision" ADD CONSTRAINT "astr_creator_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ParticipantSettlementTimeBucket" ADD CONSTRAINT "pstb_revision_fkey" FOREIGN KEY ("timeRevisionId", "activityId") REFERENCES "ActivitySettlementTimeRevision"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ParticipantSettlementTimeBucket" ADD CONSTRAINT "pstb_identity_fkey" FOREIGN KEY ("participationIdentityId", "activityId") REFERENCES "ActivityParticipationIdentity"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ParticipantSettlementTimeBucket" ADD CONSTRAINT "pstb_policy_fkey" FOREIGN KEY ("timePolicyVersionId", "definitionHash", "evaluatorVersion") REFERENCES "TimePolicyVersion"("id", "definitionHash", "evaluatorVersion") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ParticipantSettlementTimeBucketSource" ADD CONSTRAINT "pstbs_bucket_fkey" FOREIGN KEY ("bucketId", "timeRevisionId", "activityId") REFERENCES "ParticipantSettlementTimeBucket"("id", "timeRevisionId", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ParticipantSettlementTimeBucketSource" ADD CONSTRAINT "pstbs_allocation_source_fkey" FOREIGN KEY ("allocationRevisionId", "sourceSegmentId", "sourceSegmentRevision", "activityId") REFERENCES "ParticipantTimeAllocationRevision"("id", "sourceSegmentId", "sourceSegmentRevision", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivitySettlementTimeCommandReceipt" ADD CONSTRAINT "astcr_actor_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivitySettlementTimeCommandReceipt" ADD CONSTRAINT "astcr_activity_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivitySettlementTimeCommandReceipt" ADD CONSTRAINT "astcr_revision_fkey" FOREIGN KEY ("timeRevisionId", "activityId") REFERENCES "ActivitySettlementTimeRevision"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A nullable proof is not an optional bypass: either the original committed-only command has
-- no proof, or the new command has all six immutable anchors. Existing rows remain all NULL.
ALTER TABLE "ParticipantTimeAllocationRevision"
  ADD CONSTRAINT "ptar_settlement_proof_shape_check" CHECK ((
    num_nonnulls("settlementDraftVersionId", "settlementEvidenceSealId",
      "settlementEvidenceRevision", "settlementPopulationRevision", "settlementWorkflowRevision",
      "settlementDraftContentHash") = 0
    OR (num_nonnulls("settlementDraftVersionId", "settlementEvidenceSealId",
      "settlementEvidenceRevision", "settlementPopulationRevision", "settlementWorkflowRevision",
      "settlementDraftContentHash") = 6
      AND "settlementEvidenceRevision" >= 0 AND "settlementPopulationRevision" >= 0
      AND "settlementWorkflowRevision" >= 0 AND "settlementDraftContentHash" ~ '^[0-9a-f]{64}$')
  ) IS TRUE);

CREATE FUNCTION ptar_assert_settlement_proof(p "ParticipantTimeAllocationRevision")
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  run_row RECORD;
  draft_row RECORD;
  seal_row RECORD;
  current_workflow INTEGER;
  state_row RECORD;
BEGIN
  SELECT "workflowRevision" INTO current_workflow FROM "Activity"
    WHERE id = p."activityId" FOR UPDATE;
  SELECT * INTO run_row FROM "AttendanceSettlementRun"
    WHERE "activityId" = p."activityId" FOR UPDATE;
  SELECT * INTO draft_row FROM "AttendanceSettlementVersion"
    WHERE id = p."settlementDraftVersionId" FOR SHARE;
  IF NOT FOUND OR run_row.id IS NULL OR run_row."statusCode" <> 'drafting'
    OR draft_row."settlementRunId" IS DISTINCT FROM run_row.id
    OR draft_row."statusCode" <> 'draft'
    OR draft_row.version IS DISTINCT FROM run_row."currentDraftVersion"
    OR draft_row."evidenceSealId" IS DISTINCT FROM p."settlementEvidenceSealId"
    OR draft_row."evidenceRevision" IS DISTINCT FROM p."settlementEvidenceRevision"
    OR draft_row."populationRevision" IS DISTINCT FROM p."settlementPopulationRevision"
    OR draft_row."workflowRevision" IS DISTINCT FROM p."settlementWorkflowRevision"
    OR draft_row."contentHash" IS DISTINCT FROM p."settlementDraftContentHash"
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_settlement_draft_guard',
      MESSAGE = 'time allocation requires the current sealed settlement draft';
  END IF;
  SELECT * INTO seal_row FROM "EvidenceSeal" WHERE id = p."settlementEvidenceSealId" FOR SHARE;
  SELECT "evidenceRevision", "populationRevision" INTO state_row
    FROM "ActivityEvidenceState" WHERE "activityId" = p."activityId" FOR SHARE;
  IF seal_row.id IS NULL OR seal_row."statusCode" <> 'active'
    OR seal_row."activityId" IS DISTINCT FROM p."activityId"
    OR seal_row."evidenceRevision" IS DISTINCT FROM p."settlementEvidenceRevision"
    OR seal_row."populationRevision" IS DISTINCT FROM p."settlementPopulationRevision"
    OR seal_row."workflowRevision" IS DISTINCT FROM p."settlementWorkflowRevision"
    OR seal_row."evidenceRevision" IS DISTINCT FROM coalesce(state_row."evidenceRevision", 0)
    OR seal_row."populationRevision" IS DISTINCT FROM coalesce(state_row."populationRevision", 0)
    OR seal_row."workflowRevision" IS DISTINCT FROM current_workflow
    OR seal_row."openSegmentCount" <> 0 OR seal_row."manualReviewPendingCount" <> 0
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_settlement_seal_guard',
      MESSAGE = 'time allocation settlement seal is inactive or stale';
  END IF;
END;
$$;

-- The following V1 bodies retain every original test except the explicitly proved draft arm.
CREATE OR REPLACE FUNCTION ptar_parent_anchor_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_row RECORD;
  snapshot_row RECORD;
  selection_row RECORD;
  version_row RECORD;
  pointer_row RECORD;
  checkin_position_id TEXT;
  previous_row RECORD;
BEGIN
  IF NEW."settlementDraftVersionId" IS NOT NULL THEN
    PERFORM ptar_assert_settlement_proof(NEW);
  END IF;
  SELECT segment.*, identity."activityId", identity."sessionId", identity."memberId"
    INTO source_row
    FROM "ParticipantServiceSegmentRevision" segment
    JOIN "ActivityParticipationIdentity" identity ON identity.id = segment."participationIdentityId"
    WHERE segment.id = NEW."sourceSegmentId"
      AND segment."participationIdentityId" = NEW."participationIdentityId"
    FOR SHARE OF segment, identity;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', CONSTRAINT = 'ptar_source_anchor_guard',
      MESSAGE = 'time allocation source segment is unavailable';
  END IF;
  IF source_row."activityId" IS DISTINCT FROM NEW."activityId"
    OR source_row."sessionId" IS DISTINCT FROM NEW."sessionId"
    OR source_row."memberId" IS DISTINCT FROM NEW."memberId"
    OR source_row."segmentKey" IS DISTINCT FROM NEW."segmentKey"
    OR source_row.revision IS DISTINCT FROM NEW."sourceSegmentRevision"
    OR (NEW."settlementDraftVersionId" IS NULL AND source_row."statusCode" <> 'committed')
    OR (NEW."settlementDraftVersionId" IS NOT NULL AND source_row."statusCode" <> 'draft')
    OR source_row."resultCode" <> 'valid'
    OR source_row."checkOutAt" IS NULL
    OR source_row."checkOutAt" <= source_row."checkInAt"
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_source_anchor_guard',
      MESSAGE = 'time allocation source segment is not a closed valid current fact';
  END IF;

  SELECT "positionId" INTO checkin_position_id
    FROM "AttendancePunchEvent"
    WHERE id = source_row."sourceCheckInEventId";
  IF checkin_position_id IS DISTINCT FROM NEW."sourcePositionId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_source_position_guard',
      MESSAGE = 'time allocation source position differs from the source check-in';
  END IF;

  SELECT * INTO snapshot_row
    FROM "ActivityRuleSnapshot"
    WHERE id = NEW."ruleSnapshotId" AND "activityId" = NEW."activityId"
    FOR SHARE;
  IF NOT FOUND
    OR snapshot_row."timePolicySelectionRevisionId" IS NULL
    OR snapshot_row."timePolicySelectionRevisionId" IS DISTINCT FROM NEW."timePolicySelectionRevisionId"
    OR snapshot_row."snapshotHash" IS DISTINCT FROM NEW."ruleSnapshotHash"
    OR snapshot_row."createdAt" > source_row."checkInAt"
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_snapshot_guard',
      MESSAGE = 'time allocation requires a prior V8 rule snapshot';
  END IF;

  -- A selection pointer alone is not enough: it must be resolved against the same historical
  -- session/position graph that the snapshot froze.  Do not substitute today's SessionPosition
  -- rows here, because a later activity edit must not change the policy basis of this allocation.
  IF jsonb_typeof(snapshot_row."resolvedConfig"->'sessions') <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_snapshot_target_guard',
      MESSAGE = 'time allocation snapshot has no historical session graph';
  END IF;
  IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(snapshot_row."resolvedConfig"->'sessions') AS snapshot_session
      WHERE snapshot_session->>'sessionId' = NEW."sessionId"
        AND (
          NEW."sourcePositionId" IS NULL
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(snapshot_session->'positions') = 'array'
                THEN snapshot_session->'positions' ELSE '[]'::jsonb END
            ) AS snapshot_position
            WHERE snapshot_position->>'positionId' = NEW."sourcePositionId"
          )
        )
    ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_snapshot_target_guard',
      MESSAGE = 'time allocation source is absent from the frozen rule snapshot';
  END IF;

  SELECT * INTO selection_row
    FROM "ActivityTimePolicySelectionRevision"
    WHERE id = NEW."timePolicySelectionRevisionId" AND "activityId" = NEW."activityId"
    FOR SHARE;
  IF NOT FOUND OR selection_row."selectionHash" IS DISTINCT FROM NEW."selectionHash" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_selection_guard',
      MESSAGE = 'time allocation selection anchor mismatch';
  END IF;

  SELECT item."policyId", item."versionId", item."definitionHash"
    INTO pointer_row
    FROM "ActivityTimePolicySelectionItem" item
    WHERE item."selectionRevisionId" = NEW."timePolicySelectionRevisionId"
      AND item."activityId" = NEW."activityId"
      AND item.mode = 'explicit'
      AND (
        (item."layerCode" = 'position' AND NEW."sourcePositionId" IS NOT NULL
          AND item."sessionId" = NEW."sessionId" AND item."positionId" = NEW."sourcePositionId")
        OR (item."layerCode" = 'session' AND item."sessionId" = NEW."sessionId"
          AND item."positionId" IS NULL)
        OR (item."layerCode" = 'activity' AND item."sessionId" IS NULL
          AND item."positionId" IS NULL)
        OR (item."layerCode" = 'template' AND item."sessionId" IS NULL
          AND item."positionId" IS NULL)
      )
    ORDER BY CASE item."layerCode"
      WHEN 'position' THEN 4 WHEN 'session' THEN 3 WHEN 'activity' THEN 2 WHEN 'template' THEN 1 END DESC
    LIMIT 1;
  IF NOT FOUND
    OR pointer_row."policyId" IS DISTINCT FROM NEW."policyId"
    OR pointer_row."versionId" IS DISTINCT FROM NEW."policyVersionId"
    OR pointer_row."definitionHash" IS DISTINCT FROM NEW."definitionHash"
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_selection_pointer_guard',
      MESSAGE = 'time allocation policy does not match the frozen selection';
  END IF;

  SELECT * INTO version_row
    FROM "TimePolicyVersion"
    WHERE id = NEW."policyVersionId"
      AND "policyId" = NEW."policyId"
      AND "definitionHash" = NEW."definitionHash"
    FOR SHARE;
  IF NOT FOUND
    OR version_row."schemaVersion" <> 1
    OR version_row."statusCode" NOT IN ('active', 'retired')
    OR version_row."evaluatorVersion" IS DISTINCT FROM NEW."evaluatorVersion"
    OR version_row."effectiveFrom" > source_row."checkInAt"
    OR (version_row."effectiveUntil" IS NOT NULL
      AND version_row."effectiveUntil" < source_row."checkOutAt")
    OR jsonb_typeof(version_row."definitionJson") <> 'object'
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_policy_anchor_guard',
      MESSAGE = 'time allocation policy is unavailable for the source interval';
  END IF;
  IF NEW."recognitionModeCode" = 'manual'
    AND (version_row."definitionJson"->'manualAdjustment'->>'enabled') IS DISTINCT FROM 'true'
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_manual_policy_guard',
      MESSAGE = 'manual time allocation is not enabled by the policy';
  END IF;
  IF NEW."recognitionModeCode" = 'automatic'
    AND (
      (version_row."definitionJson"->'evidence'->>'requireManualRecognition') = 'true'
      OR EXISTS (
        SELECT 1
        FROM jsonb_each(version_row."definitionJson"->'specialIntervals') interval_item
        WHERE interval_item.value->>'mode' IS DISTINCT FROM 'exclude'
      )
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_automatic_policy_guard',
      MESSAGE = 'policy requires manual time allocation';
  END IF;

  IF NEW.revision = 1 THEN
    IF NEW."previousAllocationRevisionId" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_revision_chain_guard',
        MESSAGE = 'first time allocation revision cannot have a predecessor';
    END IF;
  ELSE
    IF NEW."previousAllocationRevisionId" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_revision_chain_guard',
        MESSAGE = 'later time allocation revision requires a predecessor';
    END IF;
    SELECT * INTO previous_row
      FROM "ParticipantTimeAllocationRevision"
      WHERE id = NEW."previousAllocationRevisionId"
      FOR SHARE;
    IF NOT FOUND
      OR previous_row."participationIdentityId" IS DISTINCT FROM NEW."participationIdentityId"
      OR previous_row."segmentKey" IS DISTINCT FROM NEW."segmentKey"
      OR previous_row.revision <> NEW.revision - 1
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_revision_chain_guard',
        MESSAGE = 'time allocation predecessor is not the immediately prior same segment revision';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE "ParticipantTimeAllocationCommandReceipt" DROP CONSTRAINT "ptacr_shape_check";
ALTER TABLE "ParticipantTimeAllocationCommandReceipt"
  ADD CONSTRAINT "ptacr_shape_check" CHECK ((
    "operationCode" IN ('recognize_time_allocation', 'recognize_settlement_time_allocation')
    AND length("operationKey") BETWEEN 8 AND 128
    AND "operationKey" ~ '[^[:space:]]'
    AND "operationKey" !~ '[[:cntrl:]]'
    AND "requestHash" ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof("resultJson") = 'object'
    AND "resultJson" ?& ARRAY[
      'schemaVersion', 'activityId', 'allocationRevisionId', 'revision',
      'sourceSegmentId', 'sourceSegmentRevision', 'recognitionModeCode',
      'allocationHash', 'sliceCount', 'evidenceCount', 'createdAt'
    ]
    AND "resultJson" - ARRAY[
      'schemaVersion', 'activityId', 'allocationRevisionId', 'revision',
      'sourceSegmentId', 'sourceSegmentRevision', 'recognitionModeCode',
      'allocationHash', 'sliceCount', 'evidenceCount', 'createdAt'
    ] = '{}'::jsonb
    AND "resultJson"->'schemaVersion' = '1'::jsonb
    AND jsonb_typeof("resultJson"->'activityId') = 'string'
    AND jsonb_typeof("resultJson"->'allocationRevisionId') = 'string'
    AND jsonb_typeof("resultJson"->'revision') = 'number'
    AND "resultJson"->>'revision' ~ '^[1-9][0-9]{0,9}$'
    AND jsonb_typeof("resultJson"->'sourceSegmentId') = 'string'
    AND jsonb_typeof("resultJson"->'sourceSegmentRevision') = 'number'
    AND "resultJson"->>'sourceSegmentRevision' ~ '^[1-9][0-9]{0,9}$'
    AND "resultJson"->>'recognitionModeCode' IN ('automatic', 'manual')
    AND "resultJson"->>'allocationHash' ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof("resultJson"->'sliceCount') = 'number'
    AND "resultJson"->>'sliceCount' ~ '^[1-9][0-9]{0,2}$'
    AND jsonb_typeof("resultJson"->'evidenceCount') = 'number'
    AND "resultJson"->>'evidenceCount' ~ '^(0|[1-9][0-9]{0,2})$'
    AND jsonb_typeof("resultJson"->'createdAt') = 'string'
    AND "resultJson"->>'createdAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  ) IS TRUE);

CREATE OR REPLACE FUNCTION ptar_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_row RECORD;
  source_row RECORD;
  version_row RECORD;
  slice_total INTEGER;
  evidence_total INTEGER;
  manifest_total INTEGER;
  allow_split BOOLEAN;
  requires_attachment BOOLEAN;
  manual_evidence_required BOOLEAN;
BEGIN
  SELECT * INTO parent_row
    FROM "ParticipantTimeAllocationRevision"
    WHERE id = NEW."allocationRevisionId" AND "activityId" = NEW."activityId"
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', CONSTRAINT = 'ptacr_parent_guard',
      MESSAGE = 'time allocation receipt parent is unavailable';
  END IF;
  IF (parent_row."settlementDraftVersionId" IS NULL AND NEW."operationCode" <> 'recognize_time_allocation')
    OR (parent_row."settlementDraftVersionId" IS NOT NULL AND NEW."operationCode" <> 'recognize_settlement_time_allocation')
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptacr_settlement_operation_guard',
      MESSAGE = 'time allocation proof and receipt operation do not match';
  END IF;
  IF parent_row."createdByUserId" IS DISTINCT FROM NEW."actorUserId"
    OR parent_row."createdAt" IS DISTINCT FROM NEW."createdAt"
    OR NEW."resultJson"->>'activityId' IS DISTINCT FROM NEW."activityId"
    OR NEW."resultJson"->>'allocationRevisionId' IS DISTINCT FROM NEW."allocationRevisionId"
    OR NEW."resultJson"->>'revision' IS DISTINCT FROM parent_row.revision::TEXT
    OR NEW."resultJson"->>'sourceSegmentId' IS DISTINCT FROM parent_row."sourceSegmentId"
    OR NEW."resultJson"->>'sourceSegmentRevision' IS DISTINCT FROM parent_row."sourceSegmentRevision"::TEXT
    OR NEW."resultJson"->>'recognitionModeCode' IS DISTINCT FROM parent_row."recognitionModeCode"
    OR NEW."resultJson"->>'allocationHash' IS DISTINCT FROM parent_row."allocationHash"
    OR NEW."resultJson"->>'sliceCount' IS DISTINCT FROM parent_row."sliceCount"::TEXT
    OR NEW."resultJson"->>'createdAt' IS DISTINCT FROM
      to_char(NEW."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptacr_result_guard',
      MESSAGE = 'time allocation receipt differs from its created revision';
  END IF;
  SELECT count(*) INTO slice_total
    FROM "ParticipantTimeAllocationSlice"
    WHERE "allocationRevisionId" = parent_row.id AND "activityId" = parent_row."activityId";
  SELECT count(*) INTO evidence_total
    FROM "ParticipantTimeAllocationEvidence"
    WHERE "allocationRevisionId" = parent_row.id AND "activityId" = parent_row."activityId";
  SELECT count(*) INTO manifest_total
    FROM jsonb_object_keys(parent_row."allocationJson"->'slices');
  IF slice_total <> parent_row."sliceCount"
    OR manifest_total <> parent_row."sliceCount"
    OR evidence_total > 500
    OR NEW."resultJson"->>'evidenceCount' IS DISTINCT FROM evidence_total::TEXT
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptacr_complete_guard',
      MESSAGE = 'time allocation receipt has incomplete or excessive children';
  END IF;
  SELECT * INTO source_row
    FROM "ParticipantServiceSegmentRevision"
    WHERE id = parent_row."sourceSegmentId"
      AND "participationIdentityId" = parent_row."participationIdentityId";
  SELECT * INTO version_row
    FROM "TimePolicyVersion"
    WHERE id = parent_row."policyVersionId"
      AND "policyId" = parent_row."policyId"
      AND "definitionHash" = parent_row."definitionHash";
  IF NOT FOUND OR source_row."checkOutAt" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptacr_complete_guard',
      MESSAGE = 'time allocation receipt anchors are unavailable';
  END IF;
  allow_split := (version_row."definitionJson"->>'allowSplit')::BOOLEAN;
  requires_attachment := (version_row."definitionJson"->'evidence'->'requiredSources') ? 'attachment';
  manual_evidence_required := parent_row."recognitionModeCode" = 'manual'
    AND (version_row."definitionJson"->'manualAdjustment'->>'evidenceRequired') = 'true';
  IF (requires_attachment OR manual_evidence_required) AND evidence_total < 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptacr_evidence_guard',
      MESSAGE = 'time allocation policy requires attachment evidence';
  END IF;
  IF NOT allow_split AND NOT EXISTS (
    SELECT 1 FROM "ParticipantTimeAllocationSlice"
    WHERE "allocationRevisionId" = parent_row.id
      AND "activityId" = parent_row."activityId"
      AND "startAt" = source_row."checkInAt"
      AND "endAt" = source_row."checkOutAt"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptacr_allow_split_guard',
      MESSAGE = 'non-split time allocation must cover the complete source interval';
  END IF;
  IF NOT allow_split AND slice_total <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptacr_allow_split_guard',
      MESSAGE = 'non-split time allocation must have exactly one slice';
  END IF;
  RETURN NEW;
END;
$$;
 
-- D4 shape, chain and permanently immutable records.
CREATE UNIQUE INDEX "astr_submitted_version_key" ON "ActivitySettlementTimeRevision"("settlementVersionId")
  WHERE "kindCode" = 'submitted';

ALTER TABLE "ActivitySettlementTimeRevision" ADD CONSTRAINT "astr_shape_check" CHECK ((
  revision > 0 AND "evidenceRevision" >= 0 AND "populationRevision" >= 0 AND "workflowRevision" >= 0
  AND "draftContentHash" ~ '^[0-9a-f]{64}$' AND "sourceSetHash" ~ '^[0-9a-f]{64}$'
  AND "bucketContentHash" ~ '^[0-9a-f]{64}$' AND "bucketCount" BETWEEN 0 AND 8000
  AND "bucketCount" % 4 = 0 AND "sourceCount" BETWEEN 0 AND 40000 AND "sourceCount" % 4 = 0
  AND (("kindCode" = 'draft' AND "sourceDraftTimeRevisionId" IS NULL)
    OR ("kindCode" = 'submitted' AND "sourceDraftTimeRevisionId" IS NOT NULL))
  AND ((revision = 1 AND "previousTimeRevisionId" IS NULL)
    OR (revision > 1 AND "previousTimeRevisionId" IS NOT NULL))
) IS TRUE);

ALTER TABLE "ParticipantSettlementTimeBucket" ADD CONSTRAINT "pstb_shape_check" CHECK ((
  "categoryCode" IN ('volunteer_service', 'training', 'organization', 'non_creditable')
  AND "recognizedSeconds" >= 0 AND ("calculatedSeconds" IS NULL OR "calculatedSeconds" >= 0)
  AND "rawRecognizedMilliseconds" >= 0
  AND ("rawCalculatedMilliseconds" IS NULL OR "rawCalculatedMilliseconds" >= 0)
  AND (("calculatedSeconds" IS NULL) = ("rawCalculatedMilliseconds" IS NULL))
  AND ("adjustmentReason" IS NULL OR (jsonb_typeof("adjustmentReason") = 'array'
    AND jsonb_array_length("adjustmentReason") BETWEEN 1 AND 10000))
  AND ((num_nonnulls("timePolicyVersionId", "definitionHash", "evaluatorVersion", "quantumSeconds") = 0
    AND "recognizedSeconds" = 0 AND "calculatedSeconds" = 0
    AND "rawRecognizedMilliseconds" = 0 AND "rawCalculatedMilliseconds" = 0
    AND "adjustmentReason" IS NULL)
  OR (num_nonnulls("timePolicyVersionId", "definitionHash", "evaluatorVersion", "quantumSeconds") = 4
    AND "definitionHash" ~ '^[0-9a-f]{64}$' AND "evaluatorVersion" > 0
    AND "quantumSeconds" BETWEEN 1 AND 3600
    AND "recognizedSeconds" = ("rawRecognizedMilliseconds" / ("quantumSeconds"::BIGINT * 1000)) * "quantumSeconds"
    AND ("rawCalculatedMilliseconds" IS NULL OR "calculatedSeconds" =
      ("rawCalculatedMilliseconds" / ("quantumSeconds"::BIGINT * 1000)) * "quantumSeconds")))
  AND (("rawCalculatedMilliseconds" IS NOT DISTINCT FROM "rawRecognizedMilliseconds")
    OR "adjustmentReason" IS NOT NULL)
) IS TRUE);

ALTER TABLE "ParticipantSettlementTimeBucketSource" ADD CONSTRAINT "pstbs_shape_check" CHECK ((
  "sourceSegmentRevision" > 0 AND "rawRecognizedMilliseconds" >= 0
  AND ("rawCalculatedMilliseconds" IS NULL OR "rawCalculatedMilliseconds" >= 0)
) IS TRUE);

ALTER TABLE "ActivitySettlementTimeCommandReceipt" ADD CONSTRAINT "astcr_shape_check" CHECK ((
  "operationCode" IN ('prepare_time_settlement', 'submit_time_settlement')
  AND length("operationKey") BETWEEN 8 AND 128 AND "operationKey" ~ '[^[:space:]]'
  AND "operationKey" !~ '[[:cntrl:]]' AND "requestHash" ~ '^[0-9a-f]{64}$'
  AND jsonb_typeof("resultJson") = 'object'
  AND "resultJson" ?& ARRAY['schemaVersion', 'activityId', 'timeRevisionId', 'revision', 'kindCode',
    'settlementRunId', 'settlementVersionId', 'settlementVersion', 'contentHash', 'bucketContentHash',
    'bucketCount', 'sourceCount', 'createdAt']
  AND "resultJson" - ARRAY['schemaVersion', 'activityId', 'timeRevisionId', 'revision', 'kindCode',
    'settlementRunId', 'settlementVersionId', 'settlementVersion', 'contentHash', 'bucketContentHash',
    'bucketCount', 'sourceCount', 'createdAt'] = '{}'::jsonb
  AND "resultJson"->'schemaVersion' = '1'::jsonb
) IS TRUE);

CREATE FUNCTION astr_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', CONSTRAINT = TG_NAME,
    MESSAGE = 'classified settlement history is permanently immutable';
END;
$$;
CREATE TRIGGER astr_immutable BEFORE UPDATE OR DELETE ON "ActivitySettlementTimeRevision"
  FOR EACH STATEMENT EXECUTE FUNCTION astr_reject_mutation();
CREATE TRIGGER pstb_immutable BEFORE UPDATE OR DELETE ON "ParticipantSettlementTimeBucket"
  FOR EACH STATEMENT EXECUTE FUNCTION astr_reject_mutation();
CREATE TRIGGER pstbs_immutable BEFORE UPDATE OR DELETE ON "ParticipantSettlementTimeBucketSource"
  FOR EACH STATEMENT EXECUTE FUNCTION astr_reject_mutation();
CREATE TRIGGER astcr_immutable BEFORE UPDATE OR DELETE ON "ActivitySettlementTimeCommandReceipt"
  FOR EACH STATEMENT EXECUTE FUNCTION astr_reject_mutation();

-- Canonical JSON for this closed schema only: sorted object keys, preserved arrays and no
-- floating point inputs. Duration BigInts are strings, exactly as in the TypeScript envelope.
CREATE FUNCTION astr_canonical_json(value JSONB) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE output TEXT;
BEGIN
  CASE jsonb_typeof(value)
  WHEN 'object' THEN
    SELECT '{' || coalesce(string_agg(to_jsonb(key)::TEXT || ':' || astr_canonical_json(item), ','
      ORDER BY key COLLATE "C"), '') || '}' INTO output FROM jsonb_each(value) AS x(key, item);
  WHEN 'array' THEN
    SELECT '[' || coalesce(string_agg(astr_canonical_json(item), ',' ORDER BY ordinal), '') || ']'
      INTO output FROM jsonb_array_elements(value) WITH ORDINALITY AS x(item, ordinal);
  ELSE output := value::TEXT;
  END CASE;
  RETURN output;
END;
$$;

CREATE FUNCTION astr_bucket_content_hash(revision_id TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(astr_canonical_json(jsonb_build_object(
    'domain', 'activity-time-settlement-buckets-v1', 'definition', coalesce(jsonb_agg(
      jsonb_build_object(
        'participationIdentityId', b."participationIdentityId", 'categoryCode', b."categoryCode",
        'calculatedSeconds', b."calculatedSeconds", 'recognizedSeconds', b."recognizedSeconds",
        'rawCalculatedMilliseconds', b."rawCalculatedMilliseconds"::TEXT,
        'rawRecognizedMilliseconds', b."rawRecognizedMilliseconds"::TEXT,
        'timePolicyVersionId', b."timePolicyVersionId", 'definitionHash', b."definitionHash",
        'evaluatorVersion', b."evaluatorVersion", 'quantumSeconds', b."quantumSeconds",
        'adjustmentReason', b."adjustmentReason",
        'emptyReasonCode', CASE WHEN b."timePolicyVersionId" IS NULL THEN 'no_valid_segment' ELSE NULL END,
        'sources', coalesce(s.items, '[]'::jsonb)
      ) ORDER BY b."participationIdentityId" COLLATE "C", CASE b."categoryCode"
        WHEN 'volunteer_service' THEN 1 WHEN 'training' THEN 2 WHEN 'organization' THEN 3 ELSE 4 END
    ), '[]'::jsonb)
  )), 'UTF8')), 'hex')
  FROM "ParticipantSettlementTimeBucket" b
  LEFT JOIN (
    SELECT "bucketId", jsonb_agg(jsonb_build_object(
      'allocationRevisionId', "allocationRevisionId", 'sourceSegmentId', "sourceSegmentId",
      'sourceSegmentRevision', "sourceSegmentRevision",
      'rawCalculatedMilliseconds', "rawCalculatedMilliseconds"::TEXT,
      'rawRecognizedMilliseconds', "rawRecognizedMilliseconds"::TEXT
    ) ORDER BY "allocationRevisionId" COLLATE "C") AS items
    FROM "ParticipantSettlementTimeBucketSource" WHERE "timeRevisionId" = revision_id GROUP BY "bucketId"
  ) s ON s."bucketId" = b.id WHERE b."timeRevisionId" = revision_id;
$$;

-- SQL independently reconstructs the same closed source envelope that the application builds
-- from the D2 facade. Excluded segments remain in the fingerprint; no old hours are read.
CREATE FUNCTION astr_source_set_document(activity_id TEXT, draft_id TEXT)
RETURNS JSONB LANGUAGE sql STABLE AS $$
  WITH latest AS (
    SELECT DISTINCT ON ("participationIdentityId", "segmentKey") *
    FROM "ParticipantTimeAllocationRevision" WHERE "activityId" = activity_id
    ORDER BY "participationIdentityId", "segmentKey", revision DESC
  ), population AS (
    SELECT jsonb_agg(jsonb_build_object(
      'participationIdentityId', i.id, 'memberId', i."memberId",
      'pending', NOT EXISTS (SELECT 1 FROM "ParticipantSettlementResultRevision" r
        WHERE r."settlementVersionId" = draft_id AND r."participationIdentityId" = i.id
          AND (CASE WHEN jsonb_typeof(r."exceptionFlagsJson"->'blockers') = 'array'
            THEN jsonb_array_length(r."exceptionFlagsJson"->'blockers') = 0 ELSE true END))
    ) ORDER BY i.id COLLATE "C") AS items FROM "ActivityParticipationIdentity" i
    WHERE i."activityId" = activity_id AND i."populationIncluded" = true
  ), segments AS (
    SELECT jsonb_agg(jsonb_build_object(
      'id', s.id, 'activityId', i."activityId", 'sessionId', i."sessionId",
      'participationIdentityId', i.id, 'memberId', i."memberId", 'sourcePositionId', e."positionId",
      'segmentKey', s."segmentKey", 'revision', s.revision,
      'sourceCheckInEventId', s."sourceCheckInEventId", 'sourceCloseEventId', s."sourceCloseEventId",
      'resultCode', s."resultCode", 'statusCode', s."statusCode",
      'checkInAt', to_char(s."checkInAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'checkOutAt', to_char(s."checkOutAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'lateFlag', s."lateFlag", 'earlyLeaveFlag', s."earlyLeaveFlag", 'exceptionFlagsJson', s."exceptionFlagsJson",
      'allocationRevisionId', a.id, 'allocationHash', a."allocationHash"
    ) ORDER BY s.id COLLATE "C") AS items
    FROM "ParticipantServiceSegmentRevision" s
    JOIN "ActivityParticipationIdentity" i ON i.id = s."participationIdentityId"
    JOIN "AttendancePunchEvent" e ON e.id = s."sourceCheckInEventId"
    LEFT JOIN latest a ON a."participationIdentityId" = i.id AND a."segmentKey" = s."segmentKey"
    WHERE i."activityId" = activity_id AND s."statusCode" <> 'superseded'
  )
  SELECT jsonb_build_object(
    'activityId', activity_id, 'settlementRunId', d."settlementRunId", 'settlementDraftVersionId', d.id,
    'evidenceSealId', d."evidenceSealId", 'evidenceRevision', d."evidenceRevision",
    'populationRevision', d."populationRevision", 'workflowRevision', d."workflowRevision",
    'draftContentHash', d."contentHash", 'population', coalesce(p.items, '[]'::jsonb),
    'segments', coalesce(s.items, '[]'::jsonb)
  ) FROM "AttendanceSettlementVersion" d CROSS JOIN population p CROSS JOIN segments s
  WHERE d.id = draft_id;
$$;

CREATE FUNCTION astr_source_set_hash(activity_id TEXT, draft_id TEXT)
RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(astr_canonical_json(jsonb_build_object(
    'domain', 'activity-time-settlement-sources-v1',
    'definition', astr_source_set_document(activity_id, draft_id)
  )), 'UTF8')), 'hex');
$$;

CREATE FUNCTION astr_parent_anchor_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  run_row RECORD;
  version_row RECORD;
  source_row RECORD;
  previous_row RECORD;
  seal_row RECORD;
  state_row RECORD;
  current_workflow INTEGER;
BEGIN
  SELECT "workflowRevision" INTO current_workflow FROM "Activity"
    WHERE id = NEW."activityId" FOR UPDATE;
  SELECT * INTO run_row FROM "AttendanceSettlementRun"
    WHERE id = NEW."settlementRunId" AND "activityId" = NEW."activityId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', CONSTRAINT = 'astr_run_guard',
      MESSAGE = 'classified settlement run is unavailable';
  END IF;
  SELECT * INTO version_row FROM "AttendanceSettlementVersion"
    WHERE id = NEW."settlementVersionId" AND "settlementRunId" = run_row.id FOR SHARE;
  IF NOT FOUND OR version_row."evidenceSealId" IS DISTINCT FROM NEW."evidenceSealId"
    OR version_row."evidenceRevision" IS DISTINCT FROM NEW."evidenceRevision"
    OR version_row."populationRevision" IS DISTINCT FROM NEW."populationRevision"
    OR version_row."workflowRevision" IS DISTINCT FROM NEW."workflowRevision"
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'astr_version_guard',
      MESSAGE = 'classified settlement version proof mismatch';
  END IF;
  SELECT * INTO previous_row FROM "ActivitySettlementTimeRevision"
    WHERE "settlementRunId" = run_row.id ORDER BY revision DESC LIMIT 1;
  IF NEW.revision IS DISTINCT FROM coalesce(previous_row.revision, 0) + 1
    OR NEW."previousTimeRevisionId" IS DISTINCT FROM previous_row.id
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'astr_previous_guard',
      MESSAGE = 'classified settlement predecessor must be the latest same-run revision';
  END IF;
  IF NEW."kindCode" = 'draft' THEN
    IF run_row."statusCode" <> 'drafting' OR version_row."statusCode" <> 'draft'
      OR version_row.version IS DISTINCT FROM run_row."currentDraftVersion"
      OR version_row."contentHash" IS DISTINCT FROM NEW."draftContentHash"
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'astr_current_draft_guard',
        MESSAGE = 'classified settlement requires the current draft';
    END IF;
  ELSE
    SELECT * INTO source_row FROM "ActivitySettlementTimeRevision"
      WHERE id = NEW."sourceDraftTimeRevisionId" AND "settlementRunId" = run_row.id
        AND "activityId" = NEW."activityId";
    IF NOT FOUND OR source_row."kindCode" <> 'draft'
      OR source_row.id IS DISTINCT FROM previous_row.id
      OR version_row."statusCode" <> 'submitted'
      OR source_row."settlementVersionId" = NEW."settlementVersionId"
      OR NEW."draftContentHash" IS DISTINCT FROM source_row."draftContentHash"
      OR NEW."sourceSetHash" IS DISTINCT FROM source_row."sourceSetHash"
      OR NEW."bucketContentHash" IS DISTINCT FROM source_row."bucketContentHash"
      OR NEW."bucketCount" IS DISTINCT FROM source_row."bucketCount"
      OR NEW."sourceCount" IS DISTINCT FROM source_row."sourceCount"
      OR NEW."evidenceSealId" IS DISTINCT FROM source_row."evidenceSealId"
      OR NEW."evidenceRevision" IS DISTINCT FROM source_row."evidenceRevision"
      OR NEW."populationRevision" IS DISTINCT FROM source_row."populationRevision"
      OR NEW."workflowRevision" IS DISTINCT FROM source_row."workflowRevision"
      OR NOT EXISTS (SELECT 1 FROM "AttendanceSettlementVersion" d
        WHERE d.id = source_row."settlementVersionId" AND d.version = run_row."currentDraftVersion"
          AND d."contentHash" = source_row."draftContentHash" AND d."statusCode" = 'draft')
      OR run_row."statusCode" NOT IN ('drafting', 'pending_first_review')
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'astr_submitted_copy_guard',
        MESSAGE = 'classified submission must copy the current prepared draft in the submit transaction';
    END IF;
  END IF;
  SELECT * INTO seal_row FROM "EvidenceSeal" WHERE id = NEW."evidenceSealId" FOR SHARE;
  SELECT * INTO state_row FROM "ActivityEvidenceState" WHERE "activityId" = NEW."activityId" FOR SHARE;
  IF seal_row.id IS NULL OR seal_row."statusCode" <> 'active'
    OR seal_row."evidenceRevision" IS DISTINCT FROM coalesce(state_row."evidenceRevision", 0)
    OR seal_row."populationRevision" IS DISTINCT FROM coalesce(state_row."populationRevision", 0)
    OR seal_row."workflowRevision" IS DISTINCT FROM current_workflow
    OR seal_row."openSegmentCount" <> 0 OR seal_row."manualReviewPendingCount" <> 0
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'astr_current_seal_guard',
      MESSAGE = 'classified settlement seal is not current and closed';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER astr_parent_anchor_guard BEFORE INSERT ON "ActivitySettlementTimeRevision"
  FOR EACH ROW EXECUTE FUNCTION astr_parent_anchor_guard();

-- Statement-level child seals keep 8,000/40,000-row inserts set based. A concurrent late append
-- waits for the parent, then checks the committed receipt; the final completeness guard is deferred.
CREATE FUNCTION astr_child_seal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM r.id FROM "ActivitySettlementTimeRevision" r
    WHERE r.id IN (SELECT "timeRevisionId" FROM inserted_rows)
    ORDER BY r.id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM inserted_rows n JOIN "ActivitySettlementTimeCommandReceipt" receipt
    ON receipt."timeRevisionId" = n."timeRevisionId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'astr_child_seal_guard',
      MESSAGE = 'classified settlement children cannot be appended after the receipt';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER pstb_child_seal_guard AFTER INSERT ON "ParticipantSettlementTimeBucket"
  REFERENCING NEW TABLE AS inserted_rows FOR EACH STATEMENT EXECUTE FUNCTION astr_child_seal_guard();
CREATE TRIGGER pstbs_child_seal_guard AFTER INSERT ON "ParticipantSettlementTimeBucketSource"
  REFERENCING NEW TABLE AS inserted_rows FOR EACH STATEMENT EXECUTE FUNCTION astr_child_seal_guard();

CREATE FUNCTION astr_receipt_complete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_row RECORD;
  version_row RECORD;
  draft_id TEXT;
  actual_buckets BIGINT;
  actual_sources BIGINT;
BEGIN
  SELECT * INTO parent_row FROM "ActivitySettlementTimeRevision"
    WHERE id = NEW."timeRevisionId" AND "activityId" = NEW."activityId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', CONSTRAINT = 'astcr_parent_guard',
      MESSAGE = 'classified settlement receipt parent is unavailable';
  END IF;
  SELECT * INTO version_row FROM "AttendanceSettlementVersion" WHERE id = parent_row."settlementVersionId";
  IF parent_row."createdByUserId" IS DISTINCT FROM NEW."actorUserId"
    OR parent_row."createdAt" IS DISTINCT FROM NEW."createdAt"
    OR (parent_row."kindCode" = 'draft' AND NEW."operationCode" <> 'prepare_time_settlement')
    OR (parent_row."kindCode" = 'submitted' AND NEW."operationCode" <> 'submit_time_settlement')
    OR NEW."resultJson" IS DISTINCT FROM jsonb_build_object(
      'schemaVersion', 1, 'activityId', parent_row."activityId", 'timeRevisionId', parent_row.id,
      'revision', parent_row.revision, 'kindCode', parent_row."kindCode",
      'settlementRunId', parent_row."settlementRunId", 'settlementVersionId', parent_row."settlementVersionId",
      'settlementVersion', version_row.version, 'contentHash', version_row."contentHash",
      'bucketContentHash', parent_row."bucketContentHash", 'bucketCount', parent_row."bucketCount",
      'sourceCount', parent_row."sourceCount",
      'createdAt', to_char(parent_row."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'astcr_result_guard',
      MESSAGE = 'classified settlement receipt operation or result does not match its parent';
  END IF;
  draft_id := parent_row."settlementVersionId";
  IF parent_row."kindCode" = 'submitted' THEN
    SELECT "settlementVersionId" INTO draft_id FROM "ActivitySettlementTimeRevision"
      WHERE id = parent_row."sourceDraftTimeRevisionId";
  END IF;
  SELECT count(*) INTO actual_buckets FROM "ParticipantSettlementTimeBucket" WHERE "timeRevisionId" = parent_row.id;
  SELECT count(*) INTO actual_sources FROM "ParticipantSettlementTimeBucketSource" WHERE "timeRevisionId" = parent_row.id;
  IF actual_buckets <> parent_row."bucketCount" OR actual_sources <> parent_row."sourceCount"
    OR parent_row."sourceSetHash" IS DISTINCT FROM astr_source_set_hash(parent_row."activityId", draft_id)
    OR parent_row."bucketContentHash" IS DISTINCT FROM astr_bucket_content_hash(parent_row.id)
    OR actual_buckets <> 4 * (SELECT count(*) FROM "ActivityParticipationIdentity"
      WHERE "activityId" = parent_row."activityId" AND "populationIncluded" = true)
    OR EXISTS (SELECT 1 FROM "ActivityParticipationIdentity" i
      WHERE i."activityId" = parent_row."activityId" AND i."populationIncluded" = true
      AND (4 <> (SELECT count(*) FROM "ParticipantSettlementTimeBucket" b
        WHERE b."timeRevisionId" = parent_row.id AND b."participationIdentityId" = i.id)
        OR NOT EXISTS (SELECT 1 FROM "ParticipantSettlementResultRevision" r
          WHERE r."settlementVersionId" = draft_id AND r."participationIdentityId" = i.id
          AND CASE WHEN jsonb_typeof(r."exceptionFlagsJson"->'blockers') = 'array'
            THEN jsonb_array_length(r."exceptionFlagsJson"->'blockers') = 0 ELSE true END)))
    OR EXISTS (SELECT 1 FROM "ParticipantSettlementTimeBucket" b
      JOIN "ActivityParticipationIdentity" i ON i.id = b."participationIdentityId"
      WHERE b."timeRevisionId" = parent_row.id AND i."populationIncluded" <> true)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'astcr_complete_guard',
      MESSAGE = 'classified settlement population, source fingerprint, child count or bucket hash mismatch';
  END IF;

  -- Every current population source must be closed. Excluded facts contribute no duration but
  -- were already included in sourceSetHash. Latest revision is checked by segment key, not by
  -- filtering old allocations until a convenient earlier proof happens to match.
  IF EXISTS (
    WITH source_counts AS MATERIALIZED (
      SELECT "allocationRevisionId", count(*) AS sources
      FROM "ParticipantSettlementTimeBucketSource"
      WHERE "timeRevisionId" = parent_row.id GROUP BY "allocationRevisionId"
    )
    SELECT 1 FROM "ParticipantServiceSegmentRevision" s
    JOIN "ActivityParticipationIdentity" i ON i.id = s."participationIdentityId"
    LEFT JOIN LATERAL (SELECT a.* FROM "ParticipantTimeAllocationRevision" a
      WHERE a."participationIdentityId" = i.id AND a."segmentKey" = s."segmentKey"
      ORDER BY a.revision DESC LIMIT 1) a ON true
    WHERE i."activityId" = parent_row."activityId" AND i."populationIncluded" = true
      AND s."statusCode" <> 'superseded'
      AND (s."checkOutAt" IS NULL OR s."statusCode" NOT IN ('draft', 'committed')
        OR s."resultCode" NOT IN ('valid', 'voided', 'replaced', 'early_departure_zero')
        OR (s."resultCode" = 'valid' AND (
          s."checkOutAt" <= s."checkInAt" OR a.id IS NULL OR a."sourceSegmentId" <> s.id
          OR a."sourceSegmentRevision" <> s.revision
          OR (s."statusCode" = 'draft' AND (
            a."settlementDraftVersionId" IS DISTINCT FROM draft_id
            OR a."settlementEvidenceSealId" IS DISTINCT FROM parent_row."evidenceSealId"
            OR a."settlementEvidenceRevision" IS DISTINCT FROM parent_row."evidenceRevision"
            OR a."settlementPopulationRevision" IS DISTINCT FROM parent_row."populationRevision"
            OR a."settlementWorkflowRevision" IS DISTINCT FROM parent_row."workflowRevision"
            OR a."settlementDraftContentHash" IS DISTINCT FROM parent_row."draftContentHash"))
          OR (s."statusCode" = 'committed' AND a."settlementDraftVersionId" IS NOT NULL)
          -- Allocation IDs are NOT NULL. Membership in this once-grouped set is exactly
          -- equivalent to the old correlated count = 4, including a missing source group.
          OR a.id NOT IN (SELECT "allocationRevisionId" FROM source_counts WHERE sources = 4)
        )))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'astcr_source_ready_guard',
      MESSAGE = 'classified settlement requires all latest applicable closed source allocations';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (SELECT i."memberId", s."checkInAt",
      max(s."checkOutAt") OVER (PARTITION BY i."memberId" ORDER BY s."checkInAt", s.id
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prior_end
      FROM "ParticipantServiceSegmentRevision" s
      JOIN "ActivityParticipationIdentity" i ON i.id = s."participationIdentityId"
      WHERE i."activityId" = parent_row."activityId" AND i."populationIncluded" = true
        AND s."statusCode" <> 'superseded' AND s."resultCode" = 'valid'
    ) intervals WHERE "checkInAt" < prior_end
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'astcr_overlap_guard',
      MESSAGE = 'classified settlement sources overlap for the same member';
  END IF;

  -- Derive each source's raw recognized interval sum and frozen automatic baseline independently
  -- of caller-supplied seconds. The allocation index bounds slice visits: the readiness guard
  -- requires exactly four sources per allocation, so at most four visits per applicable slice.
  -- Do not join an unindexed all-allocation aggregate back to every source on cold statistics.
  IF EXISTS (
    WITH source_facts AS (
      SELECT bs.*, b."participationIdentityId", b."categoryCode", b."timePolicyVersionId",
        b."definitionHash" AS bucket_hash, b."evaluatorVersion" AS bucket_evaluator, b."quantumSeconds",
        a."participationIdentityId" AS allocation_identity, a."policyVersionId", a."definitionHash",
        a."evaluatorVersion", a."sessionId", a."sourcePositionId", a."revision" AS allocation_revision,
        a."segmentKey", segment."statusCode", segment."resultCode", segment."checkInAt", segment."checkOutAt",
        policy."definitionJson",
        (SELECT coalesce(sum(extract(epoch FROM (slice."endAt" - slice."startAt")) * 1000), 0)
          FROM "ParticipantTimeAllocationSlice" slice
          WHERE slice."allocationRevisionId" = a.id AND slice."categoryCode" = b."categoryCode"
        ) AS expected_recognized,
        (SELECT position_item->>'attendanceRoleCode'
          FROM jsonb_array_elements(snapshot."resolvedConfig"->'sessions') session_item,
            jsonb_array_elements(session_item->'positions') position_item
          WHERE session_item->>'sessionId' = a."sessionId"
            AND position_item->>'positionId' = a."sourcePositionId") AS role_code
      FROM "ParticipantSettlementTimeBucketSource" bs
      JOIN "ParticipantSettlementTimeBucket" b ON b.id = bs."bucketId"
      JOIN "ParticipantTimeAllocationRevision" a ON a.id = bs."allocationRevisionId"
      JOIN "ParticipantServiceSegmentRevision" segment ON segment.id = a."sourceSegmentId"
      JOIN "TimePolicyVersion" policy ON policy.id = a."policyVersionId"
      JOIN "ActivityRuleSnapshot" snapshot ON snapshot.id = a."ruleSnapshotId"
      WHERE bs."timeRevisionId" = parent_row.id
    )
    SELECT 1 FROM source_facts f
    WHERE f."participationIdentityId" <> f.allocation_identity
      OR f."timePolicyVersionId" IS DISTINCT FROM f."policyVersionId"
      OR f.bucket_hash IS DISTINCT FROM f."definitionHash"
      OR f.bucket_evaluator IS DISTINCT FROM f."evaluatorVersion"
      OR f."quantumSeconds" IS DISTINCT FROM (f."definitionJson"->'rounding'->>'quantumSeconds')::INTEGER
      OR f."statusCode" = 'superseded' OR f."resultCode" <> 'valid' OR f."checkOutAt" IS NULL
      OR f."rawRecognizedMilliseconds" IS DISTINCT FROM f.expected_recognized
      OR f."rawCalculatedMilliseconds" IS DISTINCT FROM (
        CASE WHEN (f."definitionJson"->'evidence'->>'requireManualRecognition')::BOOLEAN
          OR EXISTS (SELECT 1 FROM jsonb_each(f."definitionJson"->'specialIntervals') item
            WHERE item.value->>'mode' IS DISTINCT FROM 'exclude') THEN NULL
        WHEN f."categoryCode" = coalesce((SELECT item->>'category'
          FROM jsonb_array_elements(f."definitionJson"->'roleMappings') item
          WHERE item->>'attendanceRoleCode' = f.role_code), f."definitionJson"->>'defaultCategory')
          THEN extract(epoch FROM (f."checkOutAt" - f."checkInAt")) * 1000
        ELSE 0 END)
      OR EXISTS (SELECT 1 FROM "ParticipantTimeAllocationRevision" newer
        WHERE newer."participationIdentityId" = f.allocation_identity
          AND newer."segmentKey" = f."segmentKey" AND newer.revision > f.allocation_revision)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'astcr_bucket_source_guard',
      MESSAGE = 'classified bucket source, frozen policy or derived duration mismatch';
  END IF;

  IF EXISTS (
    -- Keep this bounded aggregate single-evaluation even before fresh-table statistics exist.
    WITH totals AS MATERIALIZED (
      SELECT s."bucketId", count(*) AS sources,
        sum(s."rawRecognizedMilliseconds") AS recognized,
        CASE WHEN bool_or(s."rawCalculatedMilliseconds" IS NULL) THEN NULL
          ELSE sum(s."rawCalculatedMilliseconds") END AS calculated,
        jsonb_agg(jsonb_build_object('allocationRevisionId', a.id, 'manualReason', a."manualReason")
          ORDER BY a.id COLLATE "C") FILTER (WHERE a."recognitionModeCode" = 'manual') AS reasons
      FROM "ParticipantSettlementTimeBucketSource" s
      JOIN "ParticipantTimeAllocationRevision" a ON a.id = s."allocationRevisionId"
      WHERE s."timeRevisionId" = parent_row.id GROUP BY s."bucketId"
    ), expected AS (
      SELECT t."bucketId", true AS has_policy, t.recognized, t.calculated, t.reasons FROM totals t
      UNION ALL
      SELECT b.id, false, 0::NUMERIC, 0::NUMERIC, NULL::JSONB
      FROM "ParticipantSettlementTimeBucket" b
      WHERE b."timeRevisionId" = parent_row.id AND NOT EXISTS (
        SELECT 1 FROM "ParticipantSettlementTimeBucketSource" s WHERE s."bucketId" = b.id
      )
    )
    -- EXCEPT compares NULLs as equal, preserving the IS DISTINCT FROM checks above without
    -- repeatedly traversing an unindexed aggregate for every bucket. IDs make each row unique.
    SELECT b.id, b."timePolicyVersionId" IS NOT NULL,
      b."rawRecognizedMilliseconds"::NUMERIC, b."rawCalculatedMilliseconds"::NUMERIC,
      b."adjustmentReason"
    FROM "ParticipantSettlementTimeBucket" b WHERE b."timeRevisionId" = parent_row.id
    EXCEPT
    SELECT "bucketId", has_policy, recognized, calculated, reasons FROM expected
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'astcr_bucket_total_guard',
      MESSAGE = 'classified bucket totals or retained manual reasons mismatch';
  END IF;
  IF (SELECT count(*) FROM "ParticipantTimeAllocationSlice" WHERE "allocationRevisionId" IN
      (SELECT "allocationRevisionId" FROM "ParticipantSettlementTimeBucketSource" WHERE "timeRevisionId" = parent_row.id)) > 50000
    OR (SELECT count(*) FROM "ParticipantServiceSegmentRevision" s
      JOIN "ActivityParticipationIdentity" i ON i.id = s."participationIdentityId"
      WHERE i."activityId" = parent_row."activityId" AND s."statusCode" <> 'superseded') > 10000
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'astcr_scale_guard',
      MESSAGE = 'classified settlement source scale exceeds the approved bound';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER astcr_receipt_complete_guard BEFORE INSERT ON "ActivitySettlementTimeCommandReceipt"
  FOR EACH ROW EXECUTE FUNCTION astr_receipt_complete_guard();

CREATE FUNCTION astr_parent_complete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "ActivitySettlementTimeCommandReceipt"
    WHERE "timeRevisionId" = NEW.id AND "activityId" = NEW."activityId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'astr_complete_guard',
      MESSAGE = 'classified settlement revision requires its complete receipt';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER astr_parent_complete_guard AFTER INSERT ON "ActivitySettlementTimeRevision"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION astr_parent_complete_guard();

COMMIT;
