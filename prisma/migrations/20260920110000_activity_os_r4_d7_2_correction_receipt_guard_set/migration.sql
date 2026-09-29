-- D7-2 #1337 P2028 repair: a correction allocation receipt is written in
-- bounded createMany statements after its immutable allocation fact has been
-- materialized.  The old BEFORE row trigger re-ran the entire correction proof
-- chain for every receipt.  Keep D3/D4's row guard unchanged and move only the
-- recognized correction-receipt arm to an AFTER statement guard.
--
-- This migration adds no tables, columns, indexes, permissions, DML, backfill
-- or deletion.  It preserves the fixed 7-second business transaction budget.

-- A receipt using the correction operation code is verified by the statement
-- guard below.  Every other operation still runs the historical D3/D4 row
-- guard byte-for-byte; a correction parent with a wrong operation remains on
-- that historical path and is rejected there.
DROP TRIGGER ptacr_receipt_guard ON "ParticipantTimeAllocationCommandReceipt";

CREATE TRIGGER ptacr_receipt_guard
BEFORE INSERT ON "ParticipantTimeAllocationCommandReceipt"
FOR EACH ROW
WHEN (NEW."operationCode" IS DISTINCT FROM 'recognize_correction_time_allocation')
EXECUTE FUNCTION ptar_receipt_guard();

CREATE FUNCTION ptacr_correction_receipt_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
      OR request."requestedChangeJson"->'schemaVersion' IS DISTINCT FROM '3'::jsonb
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
    LEFT JOIN "AttendanceCorrectionRequest" request
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

CREATE TRIGGER ptacr_correction_receipt_insert_guard
AFTER INSERT ON "ParticipantTimeAllocationCommandReceipt"
REFERENCING NEW TABLE AS ptacr_new_rows
FOR EACH STATEMENT EXECUTE FUNCTION ptacr_correction_receipt_insert_guard();
