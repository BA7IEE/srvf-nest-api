-- D7-2: immutable V3 fact corrections.  This migration is additive: legacy
-- requests/manifests remain V1/V2 and no historical business row is backfilled.
BEGIN;

-- Supporting composite anchors on existing immutable facts.  They do not add a
-- new business uniqueness rule; PostgreSQL requires the exact referenced key.
CREATE UNIQUE INDEX "tpv_id_hash_key" ON "TimePolicyVersion"("id", "definitionHash");
CREATE UNIQUE INDEX "ptar_id_activity_identity_segment_key"
  ON "ParticipantTimeAllocationRevision"("id", "activityId", "participationIdentityId", "segmentKey");
CREATE UNIQUE INDEX "cpsr_id_application_activity_identity_segment_key"
  ON "CorrectionPendingSegmentRevision"("id", "applicationId", "activityId", "participationIdentityId", "segmentKey");
CREATE UNIQUE INDEX "correction_application_id_batch_version_key"
  ON "CorrectionApplication"("id", "newPostingBatchId", "newSettlementVersionId");

-- Returned -> voided re-submission is a forward-only, same-activity/run link.
ALTER TABLE "AttendanceCorrectionRequest" ADD COLUMN "resubmittedFromRequestId" TEXT;
CREATE UNIQUE INDEX "acr_id_activity_run_key"
  ON "AttendanceCorrectionRequest"("id", "activityId", "settlementRunId");
CREATE UNIQUE INDEX "acr_resubmitted_from_request_key"
  ON "AttendanceCorrectionRequest"("resubmittedFromRequestId", "activityId", "settlementRunId");
ALTER TABLE "AttendanceCorrectionRequest"
  ADD CONSTRAINT "acr_resubmitted_from_fkey"
  FOREIGN KEY ("resubmittedFromRequestId", "activityId", "settlementRunId")
  REFERENCES "AttendanceCorrectionRequest"("id", "activityId", "settlementRunId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- V3 manifests point to a source proof; V2 format-1 rows retain both NULL.
ALTER TABLE "ParticipationTimeCorrectionManifest"
  ADD COLUMN "sourceProofId" TEXT,
  ADD COLUMN "sourceProofHash" TEXT;
CREATE UNIQUE INDEX "ptcm_source_proof_key"
  ON "ParticipationTimeCorrectionManifest"("sourceProofId");
CREATE UNIQUE INDEX "ptcm_source_proof_anchor_key"
  ON "ParticipationTimeCorrectionManifest"(
    "sourceProofId", "rootManifestId", "activityId", "settlementRunId", "sourceProofHash"
  );
ALTER TABLE "ParticipationTimeCorrectionManifest" DROP CONSTRAINT "ptcm_format_check";
ALTER TABLE "ParticipationTimeCorrectionManifest"
  ADD CONSTRAINT "ptcm_format_check" CHECK ((
    ("formatVersion" = 1 AND "sourceProofId" IS NULL AND "sourceProofHash" IS NULL)
    OR ("formatVersion" = 2
      AND length("sourceProofId") BETWEEN 1 AND 128
      AND "sourceProofHash" ~ '^[0-9a-f]{64}$')
  ) IS TRUE);

-- A materialized V3 allocation identifies the immutable pending fact that
-- authorized it.  Existing D3/D4 rows keep this column NULL.
ALTER TABLE "ParticipantTimeAllocationRevision"
  ADD COLUMN "correctionPendingAllocationId" TEXT;
CREATE UNIQUE INDEX "ptar_correction_pending_key"
  ON "ParticipantTimeAllocationRevision"("correctionPendingAllocationId", "activityId");
ALTER TABLE "ParticipantTimeAllocationRevision" DROP CONSTRAINT "ptar_settlement_proof_shape_check";
ALTER TABLE "ParticipantTimeAllocationRevision"
  ADD CONSTRAINT "ptar_settlement_proof_shape_check" CHECK ((
    (num_nonnulls("settlementDraftVersionId", "settlementEvidenceSealId",
      "settlementEvidenceRevision", "settlementPopulationRevision", "settlementWorkflowRevision",
      "settlementDraftContentHash") = 0
      OR (num_nonnulls("settlementDraftVersionId", "settlementEvidenceSealId",
        "settlementEvidenceRevision", "settlementPopulationRevision", "settlementWorkflowRevision",
        "settlementDraftContentHash") = 6
        AND "settlementEvidenceRevision" >= 0 AND "settlementPopulationRevision" >= 0
        AND "settlementWorkflowRevision" >= 0 AND "settlementDraftContentHash" ~ '^[0-9a-f]{64}$'))
    AND NOT (
      "correctionPendingAllocationId" IS NOT NULL
      AND num_nonnulls("settlementDraftVersionId", "settlementEvidenceSealId",
        "settlementEvidenceRevision", "settlementPopulationRevision", "settlementWorkflowRevision",
        "settlementDraftContentHash") <> 0
    )
  ) IS TRUE);
ALTER TABLE "ParticipantTimeAllocationRevision" DROP CONSTRAINT "ptar_shape_check";
ALTER TABLE "ParticipantTimeAllocationRevision"
  ADD CONSTRAINT "ptar_shape_check" CHECK ((
    "revision" > 0
    AND "sourceSegmentRevision" > 0
    AND "ruleSnapshotHash" ~ '^[0-9a-f]{64}$'
    AND "selectionHash" ~ '^[0-9a-f]{64}$'
    AND "definitionHash" ~ '^[0-9a-f]{64}$'
    AND "allocationHash" ~ '^[0-9a-f]{64}$'
    AND "evaluatorVersion" > 0
    AND (("correctionPendingAllocationId" IS NULL AND "sliceCount" BETWEEN 1 AND 500)
      OR ("correctionPendingAllocationId" IS NOT NULL AND "sliceCount" BETWEEN 0 AND 500))
    AND (("recognitionModeCode" = 'automatic' AND "manualReason" IS NULL)
      OR ("recognitionModeCode" = 'manual' AND length(btrim("manualReason")) BETWEEN 1 AND 1024
        AND "manualReason" !~ '[[:cntrl:]]'))
    AND jsonb_typeof("allocationJson") = 'object'
    AND "allocationJson" ?& ARRAY['schemaVersion', 'slices']
    AND "allocationJson" - ARRAY['schemaVersion', 'slices'] = '{}'::jsonb
    AND "allocationJson"->'schemaVersion' = '1'::jsonb
    AND jsonb_typeof("allocationJson"->'slices') = 'object'
  ) IS TRUE);

CREATE TABLE "CorrectionPendingTimeAllocation" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "applicationId" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "participationIdentityId" TEXT NOT NULL,
  "segmentKey" TEXT NOT NULL,
  "pendingSegmentId" TEXT NOT NULL,
  "baseAllocationRevisionId" TEXT NOT NULL,
  "targetAllocationRevisionId" TEXT NOT NULL,
  "targetSegmentRevisionId" TEXT NOT NULL,
  "targetAllocationRevision" INTEGER NOT NULL,
  "ruleSnapshotId" TEXT NOT NULL,
  "ruleSnapshotHash" TEXT NOT NULL,
  "timePolicySelectionRevisionId" TEXT NOT NULL,
  "selectionHash" TEXT NOT NULL,
  "policyVersionId" TEXT NOT NULL,
  "definitionHash" TEXT NOT NULL,
  "evaluatorVersion" INTEGER NOT NULL,
  "recognitionModeCode" TEXT NOT NULL,
  "manualReason" TEXT,
  "allocationJson" JSONB NOT NULL,
  "allocationHash" TEXT NOT NULL,
  "sliceCount" INTEGER NOT NULL,
  CONSTRAINT "CorrectionPendingTimeAllocation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cpta_shape_check" CHECK ((
    length("id") BETWEEN 1 AND 128
    AND length("applicationId") BETWEEN 1 AND 128
    AND length("activityId") BETWEEN 1 AND 128
    AND length("participationIdentityId") BETWEEN 1 AND 128
    AND length("segmentKey") BETWEEN 1 AND 128
    AND length("pendingSegmentId") BETWEEN 1 AND 128
    AND length("baseAllocationRevisionId") BETWEEN 1 AND 128
    AND length("targetAllocationRevisionId") BETWEEN 1 AND 128
    AND length("targetSegmentRevisionId") BETWEEN 1 AND 128
    AND "targetAllocationRevision" > 0
    AND "ruleSnapshotHash" ~ '^[0-9a-f]{64}$'
    AND "selectionHash" ~ '^[0-9a-f]{64}$'
    AND "definitionHash" ~ '^[0-9a-f]{64}$'
    AND "allocationHash" ~ '^[0-9a-f]{64}$'
    AND "evaluatorVersion" > 0 AND "sliceCount" BETWEEN 0 AND 500
    AND (("recognitionModeCode" = 'automatic' AND "manualReason" IS NULL)
      OR ("recognitionModeCode" = 'manual' AND length(btrim("manualReason")) BETWEEN 1 AND 1024
        AND "manualReason" !~ '[[:cntrl:]]'))
    AND jsonb_typeof("allocationJson") = 'object'
    AND "allocationJson" ?& ARRAY['schemaVersion', 'slices']
    AND "allocationJson" - ARRAY['schemaVersion', 'slices'] = '{}'::jsonb
    AND "allocationJson"->'schemaVersion' = '1'::jsonb
    AND jsonb_typeof("allocationJson"->'slices') = 'object'
  ) IS TRUE)
);
CREATE UNIQUE INDEX "cpta_application_identity_segment_key"
  ON "CorrectionPendingTimeAllocation"("applicationId", "participationIdentityId", "segmentKey");
CREATE UNIQUE INDEX "cpta_target_allocation_key"
  ON "CorrectionPendingTimeAllocation"("targetAllocationRevisionId");
CREATE UNIQUE INDEX "cpta_target_segment_key"
  ON "CorrectionPendingTimeAllocation"("targetSegmentRevisionId");
CREATE UNIQUE INDEX "cpta_id_activity_key"
  ON "CorrectionPendingTimeAllocation"("id", "activityId");
CREATE INDEX "cpta_application_idx" ON "CorrectionPendingTimeAllocation"("applicationId");
CREATE INDEX "cpta_base_allocation_idx" ON "CorrectionPendingTimeAllocation"("baseAllocationRevisionId");
CREATE INDEX "cpta_pending_segment_idx" ON "CorrectionPendingTimeAllocation"("pendingSegmentId");
CREATE INDEX "cpta_policy_version_idx" ON "CorrectionPendingTimeAllocation"("policyVersionId");

CREATE TABLE "CorrectionPendingTimeAllocationEvidence" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "pendingAllocationId" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "attachmentId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  CONSTRAINT "CorrectionPendingTimeAllocationEvidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cptae_shape_check" CHECK ((
    length("pendingAllocationId") BETWEEN 1 AND 128
    AND length("activityId") BETWEEN 1 AND 128
    AND length("attachmentId") BETWEEN 1 AND 128
    AND "ordinal" BETWEEN 0 AND 19
  ) IS TRUE)
);
CREATE UNIQUE INDEX "cptae_pending_attachment_key"
  ON "CorrectionPendingTimeAllocationEvidence"("pendingAllocationId", "attachmentId");
CREATE UNIQUE INDEX "cptae_pending_ordinal_key"
  ON "CorrectionPendingTimeAllocationEvidence"("pendingAllocationId", "ordinal");
CREATE INDEX "cptae_activity_idx" ON "CorrectionPendingTimeAllocationEvidence"("activityId");
CREATE INDEX "cptae_attachment_idx" ON "CorrectionPendingTimeAllocationEvidence"("attachmentId");

CREATE TABLE "CorrectionTimeSourceProof" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "applicationId" TEXT NOT NULL,
  "correctionManifestId" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "settlementRunId" TEXT NOT NULL,
  "rootManifestId" TEXT NOT NULL,
  "baseSettlementVersionId" TEXT NOT NULL,
  "settlementVersionId" TEXT NOT NULL,
  "postingBatchId" TEXT NOT NULL,
  "sourceSetHash" TEXT NOT NULL,
  "calculationHash" TEXT NOT NULL,
  "sourceSnapshotJson" JSONB NOT NULL,
  "calculatedBucketsJson" JSONB NOT NULL,
  "expectedSegmentCount" INTEGER NOT NULL,
  "expectedPendingCount" INTEGER NOT NULL,
  "expectedSliceCount" INTEGER NOT NULL,
  "expectedBindingCount" INTEGER NOT NULL,
  "formatVersion" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "CorrectionTimeSourceProof_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ctsp_shape_check" CHECK ((
    "formatVersion" = 1
    AND length("applicationId") BETWEEN 1 AND 128
    AND length("correctionManifestId") BETWEEN 1 AND 128
    AND length("activityId") BETWEEN 1 AND 128
    AND length("settlementRunId") BETWEEN 1 AND 128
    AND length("rootManifestId") BETWEEN 1 AND 128
    AND length("baseSettlementVersionId") BETWEEN 1 AND 128
    AND length("settlementVersionId") BETWEEN 1 AND 128
    AND length("postingBatchId") BETWEEN 1 AND 128
    AND "sourceSetHash" ~ '^[0-9a-f]{64}$'
    AND "calculationHash" ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof("sourceSnapshotJson") = 'array'
    AND jsonb_typeof("calculatedBucketsJson") = 'array'
    AND "expectedSegmentCount" BETWEEN 1 AND 10000
    AND "expectedPendingCount" BETWEEN 1 AND 10000
    AND "expectedSliceCount" BETWEEN 0 AND 50000
    AND "expectedBindingCount" BETWEEN 1 AND 10000
  ) IS TRUE)
);
CREATE UNIQUE INDEX "ctsp_application_key" ON "CorrectionTimeSourceProof"("applicationId");
CREATE UNIQUE INDEX "ctsp_application_anchor_key"
  ON "CorrectionTimeSourceProof"("applicationId", "postingBatchId", "settlementVersionId");
CREATE UNIQUE INDEX "ctsp_manifest_key" ON "CorrectionTimeSourceProof"("correctionManifestId");
CREATE UNIQUE INDEX "ctsp_manifest_anchor_ref_key" ON "CorrectionTimeSourceProof"(
  "correctionManifestId", "postingBatchId", "activityId", "settlementRunId",
  "baseSettlementVersionId", "settlementVersionId"
);
CREATE UNIQUE INDEX "ctsp_id_activity_key" ON "CorrectionTimeSourceProof"("id", "activityId");
CREATE UNIQUE INDEX "ctsp_manifest_anchor_key" ON "CorrectionTimeSourceProof"(
  "id", "rootManifestId", "activityId", "settlementRunId", "sourceSetHash"
);
CREATE INDEX "ctsp_batch_idx" ON "CorrectionTimeSourceProof"("postingBatchId");
CREATE INDEX "ctsp_root_idx" ON "CorrectionTimeSourceProof"("rootManifestId");

CREATE TABLE "CorrectionTimeAllocationBinding" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "proofId" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "participationIdentityId" TEXT NOT NULL,
  "segmentKey" TEXT NOT NULL,
  "allocationRevisionId" TEXT NOT NULL,
  "sourceSegmentId" TEXT NOT NULL,
  "sourceSegmentRevision" INTEGER NOT NULL,
  "pendingAllocationId" TEXT,
  "sourceHash" TEXT NOT NULL,
  CONSTRAINT "CorrectionTimeAllocationBinding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ctab_shape_check" CHECK ((
    length("proofId") BETWEEN 1 AND 128
    AND length("activityId") BETWEEN 1 AND 128
    AND length("participationIdentityId") BETWEEN 1 AND 128
    AND length("segmentKey") BETWEEN 1 AND 128
    AND length("allocationRevisionId") BETWEEN 1 AND 128
    AND length("sourceSegmentId") BETWEEN 1 AND 128
    AND "sourceSegmentRevision" > 0
    AND ("pendingAllocationId" IS NULL OR length("pendingAllocationId") BETWEEN 1 AND 128)
    AND "sourceHash" ~ '^[0-9a-f]{64}$'
  ) IS TRUE)
);
CREATE UNIQUE INDEX "ctab_proof_identity_segment_key"
  ON "CorrectionTimeAllocationBinding"("proofId", "participationIdentityId", "segmentKey");
CREATE INDEX "ctab_allocation_idx" ON "CorrectionTimeAllocationBinding"("allocationRevisionId");
CREATE INDEX "ctab_pending_idx" ON "CorrectionTimeAllocationBinding"("pendingAllocationId");
CREATE INDEX "ctab_source_segment_idx" ON "CorrectionTimeAllocationBinding"("sourceSegmentId");

ALTER TABLE "CorrectionPendingTimeAllocation"
  ADD CONSTRAINT "cpta_application_fkey" FOREIGN KEY ("applicationId")
    REFERENCES "CorrectionApplication"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "cpta_pending_segment_fkey" FOREIGN KEY (
    "pendingSegmentId", "applicationId", "activityId", "participationIdentityId", "segmentKey"
  ) REFERENCES "CorrectionPendingSegmentRevision"(
    "id", "applicationId", "activityId", "participationIdentityId", "segmentKey"
  ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "cpta_base_allocation_fkey" FOREIGN KEY (
    "baseAllocationRevisionId", "activityId", "participationIdentityId", "segmentKey"
  ) REFERENCES "ParticipantTimeAllocationRevision"(
    "id", "activityId", "participationIdentityId", "segmentKey"
  ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "cpta_snapshot_fkey" FOREIGN KEY ("ruleSnapshotId", "activityId")
    REFERENCES "ActivityRuleSnapshot"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "cpta_selection_fkey" FOREIGN KEY ("timePolicySelectionRevisionId", "activityId")
    REFERENCES "ActivityTimePolicySelectionRevision"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "cpta_policy_version_fkey" FOREIGN KEY ("policyVersionId", "definitionHash")
    REFERENCES "TimePolicyVersion"("id", "definitionHash") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "CorrectionPendingTimeAllocationEvidence"
  ADD CONSTRAINT "cptae_pending_fkey" FOREIGN KEY ("pendingAllocationId", "activityId")
    REFERENCES "CorrectionPendingTimeAllocation"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "cptae_attachment_fkey" FOREIGN KEY ("attachmentId")
    REFERENCES "attachments"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "CorrectionTimeSourceProof"
  ADD CONSTRAINT "ctsp_application_fkey" FOREIGN KEY (
    "applicationId", "postingBatchId", "settlementVersionId"
  ) REFERENCES "CorrectionApplication"("id", "newPostingBatchId", "newSettlementVersionId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ctsp_manifest_fkey" FOREIGN KEY (
    "correctionManifestId", "postingBatchId", "activityId", "settlementRunId",
    "baseSettlementVersionId", "settlementVersionId"
  ) REFERENCES "ParticipationTimeCorrectionManifest"(
    "id", "postingBatchId", "activityId", "settlementRunId",
    "baseSettlementVersionId", "settlementVersionId"
  ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ctsp_root_fkey" FOREIGN KEY ("rootManifestId", "activityId", "settlementRunId")
    REFERENCES "ParticipationTimeLedgerManifest"("id", "activityId", "settlementRunId")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ParticipationTimeCorrectionManifest"
  ADD CONSTRAINT "ptcm_source_proof_fkey" FOREIGN KEY (
    "sourceProofId", "rootManifestId", "activityId", "settlementRunId", "sourceProofHash"
  ) REFERENCES "CorrectionTimeSourceProof"(
    "id", "rootManifestId", "activityId", "settlementRunId", "sourceSetHash"
  ) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "ParticipantTimeAllocationRevision"
  ADD CONSTRAINT "ptar_correction_pending_fkey" FOREIGN KEY ("correctionPendingAllocationId", "activityId")
    REFERENCES "CorrectionPendingTimeAllocation"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "CorrectionTimeAllocationBinding"
  ADD CONSTRAINT "ctab_proof_fkey" FOREIGN KEY ("proofId", "activityId")
    REFERENCES "CorrectionTimeSourceProof"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ctab_allocation_fkey" FOREIGN KEY (
    "allocationRevisionId", "sourceSegmentId", "sourceSegmentRevision", "activityId"
  ) REFERENCES "ParticipantTimeAllocationRevision"(
    "id", "sourceSegmentId", "sourceSegmentRevision", "activityId"
  ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ctab_source_segment_fkey" FOREIGN KEY ("sourceSegmentId", "participationIdentityId")
    REFERENCES "ParticipantServiceSegmentRevision"("id", "participationIdentityId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ctab_pending_fkey" FOREIGN KEY ("pendingAllocationId", "activityId")
    REFERENCES "CorrectionPendingTimeAllocation"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Every new fact table is permanently retained.  In particular, a failed or
-- voided preparation still retains its evidence reference and source proof.
CREATE FUNCTION d7_2_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'D7-2 fact correction history is immutable'
    USING ERRCODE = '23514', CONSTRAINT = TG_NAME;
END;
$$;
CREATE TRIGGER cpta_immutable BEFORE UPDATE OR DELETE ON "CorrectionPendingTimeAllocation"
  FOR EACH ROW EXECUTE FUNCTION d7_2_reject_mutation();
CREATE TRIGGER cptae_immutable BEFORE UPDATE OR DELETE ON "CorrectionPendingTimeAllocationEvidence"
  FOR EACH ROW EXECUTE FUNCTION d7_2_reject_mutation();
CREATE TRIGGER ctsp_immutable BEFORE UPDATE OR DELETE ON "CorrectionTimeSourceProof"
  FOR EACH ROW EXECUTE FUNCTION d7_2_reject_mutation();
CREATE TRIGGER ctab_immutable BEFORE UPDATE OR DELETE ON "CorrectionTimeAllocationBinding"
  FOR EACH ROW EXECUTE FUNCTION d7_2_reject_mutation();
CREATE TRIGGER cpta_no_truncate BEFORE TRUNCATE ON "CorrectionPendingTimeAllocation"
  FOR EACH STATEMENT EXECUTE FUNCTION d7_2_reject_mutation();
CREATE TRIGGER cptae_no_truncate BEFORE TRUNCATE ON "CorrectionPendingTimeAllocationEvidence"
  FOR EACH STATEMENT EXECUTE FUNCTION d7_2_reject_mutation();
CREATE TRIGGER ctsp_no_truncate BEFORE TRUNCATE ON "CorrectionTimeSourceProof"
  FOR EACH STATEMENT EXECUTE FUNCTION d7_2_reject_mutation();
CREATE TRIGGER ctab_no_truncate BEFORE TRUNCATE ON "CorrectionTimeAllocationBinding"
  FOR EACH STATEMENT EXECUTE FUNCTION d7_2_reject_mutation();

-- Every pending allocation must be exactly tied to an approved V3 input and
-- one approved pending segment/base allocation pair.  IDs for the eventual
-- target rows are only preallocated strings here: no target fact exists yet.
CREATE FUNCTION cpta_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  app_row RECORD;
  pending_row RECORD;
  base_row RECORD;
  snapshot_row RECORD;
  selection_row RECORD;
  policy_row RECORD;
BEGIN
  SELECT a.*, q."requestedChangeJson", q."statusCode" AS request_status
    INTO app_row
    FROM "CorrectionApplication" a
    JOIN "AttendanceCorrectionRequest" q ON q.id = a."correctionRequestId"
    WHERE a.id = NEW."applicationId"
    FOR UPDATE OF a, q;
  IF NOT FOUND
    OR app_row."statusCode" <> 'preparing'
    OR app_row.request_status NOT IN ('approved', 'applying')
    OR app_row."requestedChangeJson"->'schemaVersion' IS DISTINCT FROM '3'::jsonb
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
    FROM jsonb_array_elements(app_row."requestedChangeJson"->'allocations') input
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
CREATE TRIGGER cpta_insert_guard BEFORE INSERT ON "CorrectionPendingTimeAllocation"
  FOR EACH ROW EXECUTE FUNCTION cpta_insert_guard();

CREATE FUNCTION cptae_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  app_status TEXT;
  request_status TEXT;
  attachment_row RECORD;
BEGIN
  SELECT a."statusCode", q."statusCode" INTO app_status, request_status
    FROM "CorrectionPendingTimeAllocation" p
    JOIN "CorrectionApplication" a ON a.id = p."applicationId"
    JOIN "AttendanceCorrectionRequest" q ON q.id = a."correctionRequestId"
    WHERE p.id = NEW."pendingAllocationId" AND p."activityId" = NEW."activityId"
    FOR SHARE OF p, a, q;
  SELECT * INTO attachment_row FROM "attachments"
    WHERE id = NEW."attachmentId" FOR SHARE;
  IF app_status IS DISTINCT FROM 'preparing' OR request_status NOT IN ('approved', 'applying')
    OR attachment_row.id IS NULL
    OR attachment_row."ownerType" IS DISTINCT FROM 'activity'
    OR attachment_row."ownerId" IS DISTINCT FROM NEW."activityId"
  THEN
    RAISE EXCEPTION 'pending allocation evidence is not an owned attachment'
      USING ERRCODE = '23514', CONSTRAINT = 'cptae_insert_guard';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cptae_insert_guard BEFORE INSERT ON "CorrectionPendingTimeAllocationEvidence"
  FOR EACH ROW EXECUTE FUNCTION cptae_insert_guard();

CREATE FUNCTION ctsp_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  manifest_row RECORD;
  application_row RECORD;
  request_row RECORD;
  batch_status TEXT;
BEGIN
  SELECT m.* INTO manifest_row FROM "ParticipationTimeCorrectionManifest" m
    WHERE m.id = NEW."correctionManifestId" AND m."postingBatchId" = NEW."postingBatchId"
      AND m."activityId" = NEW."activityId" AND m."settlementRunId" = NEW."settlementRunId"
      AND m."baseSettlementVersionId" = NEW."baseSettlementVersionId"
      AND m."settlementVersionId" = NEW."settlementVersionId" FOR SHARE;
  SELECT a.*, q."requestedChangeJson", q."statusCode" AS request_status INTO application_row
    FROM "CorrectionApplication" a JOIN "AttendanceCorrectionRequest" q ON q.id = a."correctionRequestId"
    WHERE a.id = NEW."applicationId" AND a."newPostingBatchId" = NEW."postingBatchId"
      AND a."newSettlementVersionId" = NEW."settlementVersionId" FOR UPDATE OF a, q;
  SELECT "statusCode" INTO batch_status FROM "LedgerPostingBatch"
    WHERE id = NEW."postingBatchId" FOR UPDATE;
  IF manifest_row.id IS NULL OR application_row.id IS NULL
    OR application_row."statusCode" <> 'preparing'
    OR application_row.request_status NOT IN ('approved', 'applying')
    OR application_row."requestedChangeJson"->'schemaVersion' IS DISTINCT FROM '3'::jsonb
    OR batch_status IS DISTINCT FROM 'preparing'
    OR manifest_row."formatVersion" <> 2
    OR manifest_row."sourceProofId" IS DISTINCT FROM NEW.id
    OR manifest_row."sourceProofHash" IS DISTINCT FROM NEW."sourceSetHash"
    OR jsonb_array_length(NEW."sourceSnapshotJson") <> NEW."expectedSegmentCount"
    -- The proof must freeze the entire effective base source set before any
    -- pending row is materialized.  A count-only check would accept a duplicate
    -- changed row while silently omitting an unchanged segment.
    OR EXISTS (
      SELECT 1
      FROM "ParticipantServiceSegmentRevision" segment
      JOIN "ActivityParticipationIdentity" identity
        ON identity.id = segment."participationIdentityId"
      WHERE identity."activityId" = NEW."activityId"
        AND segment."statusCode" = 'committed'
        AND segment."resultCode" = 'valid'
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(NEW."sourceSnapshotJson") source
          WHERE source->>'baseSegmentRevisionId' = segment.id
            AND source->>'baseSegmentRevision' = segment.revision::TEXT
            AND source->>'participationIdentityId' = segment."participationIdentityId"
            AND source->>'segmentKey' = segment."segmentKey"
        )
    )
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW."sourceSnapshotJson") source
      LEFT JOIN "ParticipantServiceSegmentRevision" segment
        ON segment.id = source->>'baseSegmentRevisionId'
          AND segment.revision::TEXT = source->>'baseSegmentRevision'
          AND segment."participationIdentityId" = source->>'participationIdentityId'
          AND segment."segmentKey" = source->>'segmentKey'
      LEFT JOIN "ActivityParticipationIdentity" identity
        ON identity.id = segment."participationIdentityId"
      WHERE segment.id IS NULL
        OR identity."activityId" IS DISTINCT FROM NEW."activityId"
        OR segment."statusCode" <> 'committed'
        OR segment."resultCode" <> 'valid'
    )
  THEN
    RAISE EXCEPTION 'source proof cannot be inserted for this correction application'
      USING ERRCODE = '23514', CONSTRAINT = 'ctsp_insert_guard';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ctsp_insert_guard BEFORE INSERT ON "CorrectionTimeSourceProof"
  FOR EACH ROW EXECUTE FUNCTION ctsp_insert_guard();

CREATE FUNCTION ctab_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  proof_row RECORD;
  allocation_row RECORD;
  pending_row RECORD;
BEGIN
  SELECT p.*, a."statusCode" AS application_status, q."statusCode" AS request_status,
         b."statusCode" AS batch_status
    INTO proof_row
    FROM "CorrectionTimeSourceProof" p
    JOIN "CorrectionApplication" a ON a.id = p."applicationId"
    JOIN "AttendanceCorrectionRequest" q ON q.id = a."correctionRequestId"
    JOIN "LedgerPostingBatch" b ON b.id = p."postingBatchId"
    WHERE p.id = NEW."proofId" AND p."activityId" = NEW."activityId"
    FOR SHARE OF p, a, q, b;
  SELECT * INTO allocation_row FROM "ParticipantTimeAllocationRevision"
    WHERE id = NEW."allocationRevisionId"
      AND "activityId" = NEW."activityId"
      AND "sourceSegmentId" = NEW."sourceSegmentId"
      AND "sourceSegmentRevision" = NEW."sourceSegmentRevision"
    FOR SHARE;
  IF proof_row.id IS NULL OR proof_row.application_status <> 'preparing'
    OR proof_row.request_status <> 'applying' OR proof_row.batch_status <> 'ready'
    OR allocation_row.id IS NULL
  THEN
    RAISE EXCEPTION 'time allocation binding is not ready for materialization'
      USING ERRCODE = '23514', CONSTRAINT = 'ctab_insert_guard';
  END IF;
  IF NEW."pendingAllocationId" IS NOT NULL THEN
    SELECT pending.*, segment."targetRevisionNumber" AS target_segment_revision
      INTO pending_row
      FROM "CorrectionPendingTimeAllocation" pending
      JOIN "CorrectionPendingSegmentRevision" segment
        ON segment.id = pending."pendingSegmentId"
          AND segment."applicationId" = pending."applicationId"
          AND segment."activityId" = pending."activityId"
          AND segment."participationIdentityId" = pending."participationIdentityId"
          AND segment."segmentKey" = pending."segmentKey"
      WHERE pending.id = NEW."pendingAllocationId" AND pending."activityId" = NEW."activityId"
        AND pending."applicationId" = proof_row."applicationId"
      FOR SHARE OF pending, segment;
    IF pending_row.id IS NULL
      OR pending_row."participationIdentityId" IS DISTINCT FROM NEW."participationIdentityId"
      OR pending_row."segmentKey" IS DISTINCT FROM NEW."segmentKey"
      OR pending_row."targetAllocationRevisionId" IS DISTINCT FROM NEW."allocationRevisionId"
      OR pending_row."targetSegmentRevisionId" IS DISTINCT FROM NEW."sourceSegmentId"
      OR pending_row."targetAllocationRevision" IS DISTINCT FROM allocation_row.revision
      OR pending_row.target_segment_revision IS DISTINCT FROM NEW."sourceSegmentRevision"
      OR allocation_row."correctionPendingAllocationId" IS DISTINCT FROM pending_row.id
    THEN
      RAISE EXCEPTION 'binding does not match its pending allocation fact'
        USING ERRCODE = '23514', CONSTRAINT = 'ctab_insert_guard';
    END IF;
  END IF;
  -- Source membership is deliberately checked as one exact set by
  -- ctsp_assert_complete(require_bindings) before the batch can receive its
  -- receipt or become committed.  Scanning the complete JSON proof once per
  -- binding is quadratic at the 10,000-source limit and expires the fixed
  -- commit transaction before that same fail-closed check can run.
  RETURN NEW;
END;
$$;
CREATE TRIGGER ctab_insert_guard BEFORE INSERT ON "CorrectionTimeAllocationBinding"
  FOR EACH ROW EXECUTE FUNCTION ctab_insert_guard();

-- This is deliberately a set check rather than an aggregation-only count: a
-- missing unchanged segment and a duplicate changed segment can have the same
-- total, but neither is the frozen source set the reviewer approved.
CREATE FUNCTION ctsp_assert_complete(batch_id TEXT, require_bindings BOOLEAN)
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
  SELECT count(*)::integer INTO source_count
    FROM jsonb_array_elements(proof_row."sourceSnapshotJson");
  IF pending_count <> proof_row."expectedPendingCount"
    OR source_count <> proof_row."expectedSegmentCount"
    OR proof_row."expectedBindingCount" <> proof_row."expectedSegmentCount"
    OR (SELECT coalesce(sum((source->>'sliceCount')::integer), 0)::integer
      FROM jsonb_array_elements(proof_row."sourceSnapshotJson") source)
      <> proof_row."expectedSliceCount"
    OR jsonb_array_length(proof_row."calculatedBucketsJson") <> proof_row.expected_root_count
    OR evidence_count > 2000
  THEN
    RAISE EXCEPTION 'V3 correction proof counts are incomplete'
      USING ERRCODE = '23514', CONSTRAINT = 'ctsp_complete_guard';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "CorrectionPendingTimeAllocation" p
    WHERE p."applicationId" = proof_row."applicationId"
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(proof_row."sourceSnapshotJson") source
        WHERE source->>'participationIdentityId' = p."participationIdentityId"
          AND source->>'segmentKey' = p."segmentKey"
          AND source->>'baseAllocationRevisionId' = p."baseAllocationRevisionId"
      )
  ) THEN
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

CREATE FUNCTION ctsp_lifecycle_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  batch_id TEXT;
  batch_status TEXT;
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
  PERFORM ctsp_assert_complete(batch_id, batch_status = 'committed');
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER cpta_lifecycle_guard AFTER INSERT ON "CorrectionPendingTimeAllocation"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ctsp_lifecycle_guard();
CREATE CONSTRAINT TRIGGER cptae_lifecycle_guard AFTER INSERT ON "CorrectionPendingTimeAllocationEvidence"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ctsp_lifecycle_guard();
CREATE CONSTRAINT TRIGGER ctsp_lifecycle_proof_guard AFTER INSERT ON "CorrectionTimeSourceProof"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ctsp_lifecycle_guard();
CREATE CONSTRAINT TRIGGER ctsp_lifecycle_batch_guard
  AFTER INSERT OR UPDATE OF "statusCode" ON "LedgerPostingBatch"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ctsp_lifecycle_guard();

-- The third allocation arm is deliberately separate from the D3 committed and
-- D4 sealed-draft arms below.  It can only materialize a target prepared from
-- the immutable V3 pending fact while the correction batch is ready.
CREATE FUNCTION ptar_assert_correction_proof(p "ParticipantTimeAllocationRevision")
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  pending_row RECORD;
  source_row RECORD;
  base_row RECORD;
  policy_row RECORD;
BEGIN
  IF p."correctionPendingAllocationId" IS NULL
    OR num_nonnulls(p."settlementDraftVersionId", p."settlementEvidenceSealId",
      p."settlementEvidenceRevision", p."settlementPopulationRevision",
      p."settlementWorkflowRevision", p."settlementDraftContentHash") <> 0
  THEN
    RAISE EXCEPTION 'correction allocation proof shape is invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'ptar_correction_proof_guard';
  END IF;
  SELECT pending.*, application."statusCode" AS application_status,
         request."statusCode" AS request_status,
         request."requestedChangeJson", batch."statusCode" AS batch_status,
         segment."baseRevisionId" AS pending_base_segment_id,
         segment."targetRevisionNumber" AS pending_target_segment_revision
    INTO pending_row
    FROM "CorrectionPendingTimeAllocation" pending
    JOIN "CorrectionApplication" application ON application.id = pending."applicationId"
    JOIN "AttendanceCorrectionRequest" request ON request.id = application."correctionRequestId"
    JOIN "LedgerPostingBatch" batch ON batch.id = application."newPostingBatchId"
    JOIN "CorrectionPendingSegmentRevision" segment ON segment.id = pending."pendingSegmentId"
      AND segment."applicationId" = pending."applicationId"
      AND segment."activityId" = pending."activityId"
      AND segment."participationIdentityId" = pending."participationIdentityId"
      AND segment."segmentKey" = pending."segmentKey"
    WHERE pending.id = p."correctionPendingAllocationId"
    FOR SHARE OF pending, application, request, batch, segment;
  IF NOT FOUND
    OR pending_row.application_status <> 'preparing'
    OR pending_row.request_status <> 'applying'
    OR pending_row.batch_status <> 'ready'
    OR pending_row."requestedChangeJson"->'schemaVersion' IS DISTINCT FROM '3'::jsonb
  THEN
    RAISE EXCEPTION 'correction allocation application is not ready'
      USING ERRCODE = '23514', CONSTRAINT = 'ptar_correction_proof_guard';
  END IF;
  SELECT * INTO source_row FROM "ParticipantServiceSegmentRevision"
    WHERE id = p."sourceSegmentId"
      AND "participationIdentityId" = p."participationIdentityId"
    FOR SHARE;
  SELECT * INTO base_row FROM "ParticipantTimeAllocationRevision"
    WHERE id = pending_row."baseAllocationRevisionId"
      AND "activityId" = p."activityId"
      AND "participationIdentityId" = p."participationIdentityId"
      AND "segmentKey" = p."segmentKey"
    FOR SHARE;
  SELECT * INTO policy_row FROM "TimePolicyVersion"
    WHERE id = pending_row."policyVersionId"
      AND "definitionHash" = pending_row."definitionHash"
    FOR SHARE;
  IF source_row.id IS NULL OR base_row.id IS NULL OR policy_row.id IS NULL
    OR source_row."statusCode" <> 'draft'
    OR source_row."segmentKey" IS DISTINCT FROM pending_row."segmentKey"
    OR source_row.revision IS DISTINCT FROM pending_row.pending_target_segment_revision
    OR source_row."baseRevisionId" IS DISTINCT FROM pending_row.pending_base_segment_id
    OR p.id IS DISTINCT FROM pending_row."targetAllocationRevisionId"
    OR p."sourceSegmentId" IS DISTINCT FROM pending_row."targetSegmentRevisionId"
    OR p."sourceSegmentRevision" IS DISTINCT FROM pending_row.pending_target_segment_revision
    OR p.revision IS DISTINCT FROM pending_row."targetAllocationRevision"
    OR p."previousAllocationRevisionId" IS DISTINCT FROM pending_row."baseAllocationRevisionId"
    OR p."activityId" IS DISTINCT FROM pending_row."activityId"
    OR p."participationIdentityId" IS DISTINCT FROM pending_row."participationIdentityId"
    OR p."segmentKey" IS DISTINCT FROM pending_row."segmentKey"
    OR p."sessionId" IS DISTINCT FROM base_row."sessionId"
    OR p."memberId" IS DISTINCT FROM base_row."memberId"
    OR p."sourcePositionId" IS DISTINCT FROM base_row."sourcePositionId"
    OR p."ruleSnapshotId" IS DISTINCT FROM pending_row."ruleSnapshotId"
    OR p."ruleSnapshotHash" IS DISTINCT FROM pending_row."ruleSnapshotHash"
    OR p."timePolicySelectionRevisionId" IS DISTINCT FROM pending_row."timePolicySelectionRevisionId"
    OR p."selectionHash" IS DISTINCT FROM pending_row."selectionHash"
    OR p."policyVersionId" IS DISTINCT FROM pending_row."policyVersionId"
    OR p."definitionHash" IS DISTINCT FROM pending_row."definitionHash"
    OR p."policyId" IS DISTINCT FROM policy_row."policyId"
    OR p."evaluatorVersion" IS DISTINCT FROM pending_row."evaluatorVersion"
    OR p."recognitionModeCode" IS DISTINCT FROM pending_row."recognitionModeCode"
    OR p."manualReason" IS DISTINCT FROM pending_row."manualReason"
    OR p."allocationJson" IS DISTINCT FROM pending_row."allocationJson"
    OR p."allocationHash" IS DISTINCT FROM pending_row."allocationHash"
    OR p."sliceCount" IS DISTINCT FROM pending_row."sliceCount"
  THEN
    RAISE EXCEPTION 'correction allocation differs from its pending fact'
      USING ERRCODE = '23514', CONSTRAINT = 'ptar_correction_proof_guard';
  END IF;
  IF source_row."resultCode" = 'valid' THEN
    IF source_row."checkOutAt" IS NULL OR source_row."checkOutAt" <= source_row."checkInAt"
      OR p."sliceCount" < 1 THEN
      RAISE EXCEPTION 'valid correction allocation requires non-empty source slices'
        USING ERRCODE = '23514', CONSTRAINT = 'ptar_correction_proof_guard';
    END IF;
  ELSIF source_row."resultCode" IN ('early_departure_zero', 'voided', 'replaced') THEN
    IF p."sliceCount" <> 0 OR p."recognitionModeCode" <> 'automatic' OR p."manualReason" IS NOT NULL THEN
      RAISE EXCEPTION 'zero correction source permits only empty automatic allocation'
        USING ERRCODE = '23514', CONSTRAINT = 'ptar_correction_proof_guard';
    END IF;
  ELSE
    RAISE EXCEPTION 'correction source result is unsupported'
      USING ERRCODE = '23514', CONSTRAINT = 'ptar_correction_proof_guard';
  END IF;
END;
$$;

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
  IF NEW."correctionPendingAllocationId" IS NOT NULL THEN
    PERFORM ptar_assert_correction_proof(NEW);
    RETURN NEW;
  END IF;
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
  IF jsonb_typeof(snapshot_row."resolvedConfig"->'sessions') <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_snapshot_target_guard',
      MESSAGE = 'time allocation snapshot has no historical session graph';
  END IF;
  IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(snapshot_row."resolvedConfig"->'sessions') AS snapshot_session
      WHERE snapshot_session->>'sessionId' = NEW."sessionId"
        AND (NEW."sourcePositionId" IS NULL OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(snapshot_session->'positions') = 'array'
              THEN snapshot_session->'positions' ELSE '[]'::jsonb END
          ) AS snapshot_position WHERE snapshot_position->>'positionId' = NEW."sourcePositionId"
        ))
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
  SELECT item."policyId", item."versionId", item."definitionHash" INTO pointer_row
    FROM "ActivityTimePolicySelectionItem" item
    WHERE item."selectionRevisionId" = NEW."timePolicySelectionRevisionId"
      AND item."activityId" = NEW."activityId" AND item.mode = 'explicit'
      AND ((item."layerCode" = 'position' AND NEW."sourcePositionId" IS NOT NULL
          AND item."sessionId" = NEW."sessionId" AND item."positionId" = NEW."sourcePositionId")
        OR (item."layerCode" = 'session' AND item."sessionId" = NEW."sessionId" AND item."positionId" IS NULL)
        OR (item."layerCode" = 'activity' AND item."sessionId" IS NULL AND item."positionId" IS NULL)
        OR (item."layerCode" = 'template' AND item."sessionId" IS NULL AND item."positionId" IS NULL))
    ORDER BY CASE item."layerCode"
      WHEN 'position' THEN 4 WHEN 'session' THEN 3 WHEN 'activity' THEN 2 WHEN 'template' THEN 1 END DESC
    LIMIT 1;
  IF NOT FOUND OR pointer_row."policyId" IS DISTINCT FROM NEW."policyId"
    OR pointer_row."versionId" IS DISTINCT FROM NEW."policyVersionId"
    OR pointer_row."definitionHash" IS DISTINCT FROM NEW."definitionHash" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_selection_pointer_guard',
      MESSAGE = 'time allocation policy does not match the frozen selection';
  END IF;
  SELECT * INTO version_row FROM "TimePolicyVersion"
    WHERE id = NEW."policyVersionId" AND "policyId" = NEW."policyId"
      AND "definitionHash" = NEW."definitionHash" FOR SHARE;
  IF NOT FOUND OR version_row."schemaVersion" <> 1 OR version_row."statusCode" NOT IN ('active', 'retired')
    OR version_row."evaluatorVersion" IS DISTINCT FROM NEW."evaluatorVersion"
    OR version_row."effectiveFrom" > source_row."checkInAt"
    OR (version_row."effectiveUntil" IS NOT NULL AND version_row."effectiveUntil" < source_row."checkOutAt")
    OR jsonb_typeof(version_row."definitionJson") <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_policy_anchor_guard',
      MESSAGE = 'time allocation policy is unavailable for the source interval';
  END IF;
  IF NEW."recognitionModeCode" = 'manual'
    AND (version_row."definitionJson"->'manualAdjustment'->>'enabled') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_manual_policy_guard',
      MESSAGE = 'manual time allocation is not enabled by the policy';
  END IF;
  IF NEW."recognitionModeCode" = 'automatic'
    AND ((version_row."definitionJson"->'evidence'->>'requireManualRecognition') = 'true'
      OR EXISTS (SELECT 1 FROM jsonb_each(version_row."definitionJson"->'specialIntervals') interval_item
        WHERE interval_item.value->>'mode' IS DISTINCT FROM 'exclude')) THEN
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
    SELECT * INTO previous_row FROM "ParticipantTimeAllocationRevision"
      WHERE id = NEW."previousAllocationRevisionId" FOR SHARE;
    IF NOT FOUND OR previous_row."participationIdentityId" IS DISTINCT FROM NEW."participationIdentityId"
      OR previous_row."segmentKey" IS DISTINCT FROM NEW."segmentKey"
      OR previous_row.revision <> NEW.revision - 1 THEN
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
    "operationCode" IN (
      'recognize_time_allocation',
      'recognize_settlement_time_allocation',
      'recognize_correction_time_allocation'
    )
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
    AND (("operationCode" = 'recognize_correction_time_allocation'
        AND "resultJson"->>'sliceCount' ~ '^(0|[1-9][0-9]{0,2})$')
      OR ("operationCode" <> 'recognize_correction_time_allocation'
        AND "resultJson"->>'sliceCount' ~ '^[1-9][0-9]{0,2}$'))
    AND jsonb_typeof("resultJson"->'evidenceCount') = 'number'
    AND "resultJson"->>'evidenceCount' ~ '^(0|[1-9][0-9]{0,2})$'
    AND jsonb_typeof("resultJson"->'createdAt') = 'string'
    AND "resultJson"->>'createdAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  ) IS TRUE);

CREATE OR REPLACE FUNCTION ptar_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_row "ParticipantTimeAllocationRevision"%ROWTYPE;
  source_row RECORD;
  version_row RECORD;
  slice_total INTEGER;
  evidence_total INTEGER;
  manifest_total INTEGER;
  allow_split BOOLEAN;
  requires_attachment BOOLEAN;
  manual_evidence_required BOOLEAN;
BEGIN
  SELECT * INTO parent_row FROM "ParticipantTimeAllocationRevision"
    WHERE id = NEW."allocationRevisionId" AND "activityId" = NEW."activityId" FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', CONSTRAINT = 'ptacr_parent_guard',
      MESSAGE = 'time allocation receipt parent is unavailable';
  END IF;
  IF (parent_row."correctionPendingAllocationId" IS NULL
      AND parent_row."settlementDraftVersionId" IS NULL
      AND NEW."operationCode" <> 'recognize_time_allocation')
    OR (parent_row."correctionPendingAllocationId" IS NULL
      AND parent_row."settlementDraftVersionId" IS NOT NULL
      AND NEW."operationCode" <> 'recognize_settlement_time_allocation')
    OR (parent_row."correctionPendingAllocationId" IS NOT NULL
      AND NEW."operationCode" <> 'recognize_correction_time_allocation')
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
  SELECT count(*) INTO slice_total FROM "ParticipantTimeAllocationSlice"
    WHERE "allocationRevisionId" = parent_row.id AND "activityId" = parent_row."activityId";
  SELECT count(*) INTO evidence_total FROM "ParticipantTimeAllocationEvidence"
    WHERE "allocationRevisionId" = parent_row.id AND "activityId" = parent_row."activityId";
  SELECT count(*) INTO manifest_total FROM jsonb_object_keys(parent_row."allocationJson"->'slices');
  IF slice_total <> parent_row."sliceCount"
    OR manifest_total <> parent_row."sliceCount"
    OR evidence_total > (CASE WHEN parent_row."correctionPendingAllocationId" IS NULL THEN 500 ELSE 20 END)
    OR NEW."resultJson"->>'evidenceCount' IS DISTINCT FROM evidence_total::TEXT
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptacr_complete_guard',
      MESSAGE = 'time allocation receipt has incomplete or excessive children';
  END IF;
  IF parent_row."correctionPendingAllocationId" IS NOT NULL THEN
    PERFORM ptar_assert_correction_proof(parent_row);
    RETURN NEW;
  END IF;
  SELECT * INTO source_row FROM "ParticipantServiceSegmentRevision"
    WHERE id = parent_row."sourceSegmentId"
      AND "participationIdentityId" = parent_row."participationIdentityId";
  SELECT * INTO version_row FROM "TimePolicyVersion"
    WHERE id = parent_row."policyVersionId" AND "policyId" = parent_row."policyId"
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
    WHERE "allocationRevisionId" = parent_row.id AND "activityId" = parent_row."activityId"
      AND "startAt" = source_row."checkInAt" AND "endAt" = source_row."checkOutAt"
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

-- Preserve the D7-1 V2 verifier byte-for-byte under an internal name.  The
-- new dispatcher gives V3 its additional immutable-proof branch without
-- changing legacy pairing semantics.
ALTER FUNCTION ptc_assert_complete(TEXT) RENAME TO ptc_assert_complete_v2;

CREATE OR REPLACE FUNCTION ptcm_guard_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  root "ParticipationTimeLedgerManifest"%ROWTYPE;
  prior "ParticipationTimeCorrectionManifest"%ROWTYPE;
  batch_status TEXT;
  request_row RECORD;
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
  IF NEW."predecessorManifestId" IS NULL THEN
    IF NEW."baseSettlementVersionId" <> root."settlementVersionId"
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
      OR prior."settlementVersionId" <> NEW."baseSettlementVersionId"
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

CREATE OR REPLACE FUNCTION ptc_assert_complete(batch_id TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  schema_version INTEGER;
  m "ParticipationTimeCorrectionManifest"%ROWTYPE;
  approved_items JSONB;
BEGIN
  SELECT (q."requestedChangeJson"->>'schemaVersion')::integer INTO schema_version
    FROM "CorrectionApplication" a
    JOIN "AttendanceCorrectionRequest" q ON q.id = a."correctionRequestId"
    WHERE a."newPostingBatchId" = batch_id;
  IF schema_version IS NULL THEN RETURN; END IF;
  IF schema_version = 1 THEN
    IF EXISTS (
      SELECT 1 FROM "ParticipationTimeCorrectionManifest" WHERE "postingBatchId" = batch_id
    ) THEN
      RAISE EXCEPTION 'legacy V1 correction must not contain a time correction manifest'
        USING ERRCODE = '23514', CONSTRAINT = 'ptc_visibility_guard';
    END IF;
    RETURN;
  END IF;
  IF schema_version = 2 THEN
    PERFORM ptc_assert_complete_v2(batch_id);
    RETURN;
  END IF;
  IF schema_version <> 3 THEN
    RAISE EXCEPTION 'unsupported correction schema version'
      USING ERRCODE = '23514', CONSTRAINT = 'ptc_visibility_guard';
  END IF;
  SELECT * INTO m FROM "ParticipationTimeCorrectionManifest" WHERE "postingBatchId" = batch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'time correction manifest missing'
      USING ERRCODE = '23514', CONSTRAINT = 'ptc_visibility_guard';
  END IF;
  IF m."formatVersion" <> 2
    OR NOT EXISTS (SELECT 1 FROM "CorrectionApplication" a
      WHERE a."newPostingBatchId" = batch_id
        AND a."newSettlementVersionId" = m."settlementVersionId"
        AND a."correctionRequestId" = m."correctionRequestId"
        AND a."statusCode" IN ('preparing', 'committed')) THEN
    RAISE EXCEPTION 'time correction application mismatch'
      USING ERRCODE = '23514', CONSTRAINT = 'ptc_visibility_guard';
  END IF;
  SELECT "requestedChangeJson"->'timeCorrection'->'items' INTO approved_items
    FROM "AttendanceCorrectionRequest" WHERE id = m."correctionRequestId";
  IF jsonb_typeof(approved_items) IS DISTINCT FROM 'array'
    OR (SELECT count(*) FROM "ParticipationTimeLedgerEntry" r WHERE r."manifestId" = m."rootManifestId") <> m."expectedRootCount"
    OR jsonb_array_length(approved_items) <> m."expectedRootCount"
    OR (SELECT count(*) FROM "ParticipationTimeCorrectionEntry" e WHERE e."manifestId" = m.id) <> m."expectedEntryCount"
    OR (SELECT COALESCE(sum(e."secondsDelta") FILTER (WHERE e."entryTypeCode" = 'reversal'), 0)
      FROM "ParticipationTimeCorrectionEntry" e WHERE e."manifestId" = m.id) <> m."reversalSecondsTotal"
    OR (SELECT COALESCE(sum(e."secondsDelta") FILTER (WHERE e."entryTypeCode" = 'credit'), 0)
      FROM "ParticipationTimeCorrectionEntry" e WHERE e."manifestId" = m.id) <> m."replacementSecondsTotal"
    OR EXISTS (
      -- Build one immutable root-id/value lookup.  The JSON recordset reports
      -- a fixed low cardinality estimate, so joining it directly can rescan
      -- all approved items for every root at the 8,000-root capacity limit.
      -- The surrounding equal-count invariant means a duplicate key also
      -- leaves another root missing; either case remains a fail-closed reject.
      WITH approved_by_root AS MATERIALIZED (
        SELECT jsonb_object_agg(item."rootEntryId", to_jsonb(item."recognizedSeconds"))
          AS values_by_root
        FROM jsonb_to_recordset(approved_items)
          AS item("rootEntryId" TEXT, "recognizedSeconds" BIGINT)
      )
      SELECT 1 FROM approved_by_root
      CROSS JOIN "ParticipationTimeLedgerEntry" root
      -- Each lookup covers every column of ptce_manifest_root_type_key.  Keep
      -- the dependent form so a generic trigger plan cannot scan one full
      -- 8,000-row type set and compare it with every root.
      LEFT JOIN LATERAL (
        SELECT e.id, e."secondsDelta", e."reversesCorrectionEntryId"
        FROM "ParticipationTimeCorrectionEntry" e
        WHERE e."manifestId" = m.id AND e."rootEntryId" = root.id
          AND e."entryTypeCode" = 'reversal'
        LIMIT 1
      ) reversal ON TRUE
      LEFT JOIN LATERAL (
        SELECT e.id, e."secondsDelta"
        FROM "ParticipationTimeCorrectionEntry" e
        WHERE e."manifestId" = m.id AND e."rootEntryId" = root.id
          AND e."entryTypeCode" = 'credit'
        LIMIT 1
      ) credit ON TRUE
      LEFT JOIN LATERAL (
        SELECT e.id, e."secondsDelta"
        FROM "ParticipationTimeCorrectionEntry" e
        WHERE e."manifestId" = m."predecessorManifestId" AND e."rootEntryId" = root.id
          AND e."entryTypeCode" = 'credit'
        LIMIT 1
      ) prior ON TRUE
      WHERE root."manifestId" = m."rootManifestId"
        AND (reversal.id IS NULL OR credit.id IS NULL
          OR credit."secondsDelta" IS DISTINCT FROM (values_by_root ->> root.id)::BIGINT
          OR (m."predecessorManifestId" IS NULL
            AND (reversal."reversesCorrectionEntryId" IS NOT NULL
              OR reversal."secondsDelta" <> -root."recognizedSeconds"))
          OR (m."predecessorManifestId" IS NOT NULL
            AND (prior.id IS NULL OR reversal."reversesCorrectionEntryId" IS DISTINCT FROM prior.id
              OR reversal."secondsDelta" <> -prior."secondsDelta")))
    )
  THEN
    RAISE EXCEPTION 'time correction paired contents incomplete'
      USING ERRCODE = '23514', CONSTRAINT = 'ptc_visibility_guard';
  END IF;
  PERFORM ctsp_assert_complete(batch_id, FALSE);
END;
$$;

CREATE OR REPLACE FUNCTION ptc_guard_visibility() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."statusCode" NOT IN ('ready', 'committed') THEN RETURN NEW; END IF;
  PERFORM ptc_assert_complete(NEW.id);
  IF NEW."statusCode" = 'committed' THEN
    PERFORM ctsp_assert_complete(NEW.id, TRUE);
  END IF;
  IF NEW."statusCode" = 'committed'
    AND EXISTS (SELECT 1 FROM "ParticipationTimeCorrectionManifest" m WHERE m."postingBatchId" = NEW.id)
    AND NOT EXISTS (
      SELECT 1 FROM "ParticipationTimeCorrectionCommitReceipt" r
      JOIN "ParticipationTimeCorrectionManifest" m
        ON m.id = r."manifestId" AND m."contentHash" = r."contentHash"
      WHERE r."postingBatchId" = NEW.id
    ) THEN
    RAISE EXCEPTION 'time correction commit receipt missing'
      USING ERRCODE = '23514', CONSTRAINT = 'ptc_visibility_guard';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION ptcr_guard_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch_status TEXT;
BEGIN
  SELECT "statusCode" INTO batch_status FROM "LedgerPostingBatch"
    WHERE id = NEW."postingBatchId" FOR UPDATE;
  IF batch_status IS DISTINCT FROM 'ready'
    OR NOT EXISTS (SELECT 1 FROM "ParticipationTimeCorrectionManifest" m
      WHERE m.id = NEW."manifestId" AND m."contentHash" = NEW."contentHash") THEN
    RAISE EXCEPTION 'time correction receipt anchor is not ready'
      USING ERRCODE = '23514', CONSTRAINT = 'ptcr_insert_guard';
  END IF;
  PERFORM ptc_assert_complete(NEW."postingBatchId");
  PERFORM ctsp_assert_complete(NEW."postingBatchId", TRUE);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION ptc_guard_commit_closure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  batch_id TEXT;
  m "ParticipationTimeCorrectionManifest"%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'LedgerPostingBatch' THEN batch_id := NEW.id;
  ELSE batch_id := NEW."postingBatchId"; END IF;
  SELECT * INTO m FROM "ParticipationTimeCorrectionManifest" WHERE "postingBatchId" = batch_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM "ParticipationTimeCorrectionCommitReceipt" WHERE "postingBatchId" = batch_id)
    OR EXISTS (SELECT 1 FROM "LedgerPostingBatch" WHERE id = batch_id AND "statusCode" = 'committed') THEN
    IF NOT EXISTS (SELECT 1 FROM "ParticipationTimeCorrectionCommitReceipt" r
      JOIN "LedgerPostingBatch" b ON b.id = r."postingBatchId" AND b."statusCode" = 'committed'
      JOIN "CorrectionApplication" a ON a."newPostingBatchId" = b.id
        AND a."newSettlementVersionId" = m."settlementVersionId"
        AND a."correctionRequestId" = m."correctionRequestId" AND a."statusCode" = 'committed'
      JOIN "AttendanceCorrectionRequest" q ON q.id = a."correctionRequestId" AND q."statusCode" = 'applied'
      WHERE r."manifestId" = m.id AND r."contentHash" = m."contentHash") THEN
      RAISE EXCEPTION 'time correction transaction is incomplete'
        USING ERRCODE = '23514', CONSTRAINT = 'ptc_commit_closure_guard';
    END IF;
    PERFORM ctsp_assert_complete(batch_id, TRUE);
  END IF;
  RETURN NULL;
END;
$$;

COMMIT;
