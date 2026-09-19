-- D7-2 #1337 P2028 repair: correction allocations may be materialized in one
-- createMany statement.  The old BEFORE row trigger invoked the immutable V3
-- proof verifier once per inserted row.  Keep that verifier for the receipt
-- seal, keep the D3/D4 parent trigger body unchanged, and move only the
-- correction-allocation insert branch to an equivalent set guard.
--
-- This migration adds no tables, columns, indexes, permissions, DML, backfill
-- or deletion.  It preserves the fixed 7-second business transaction budget.

-- The historical parent function still owns every D3/D4 allocation row.  A
-- correction row is now checked below, after its whole INSERT statement is
-- visible through the transition table.  This avoids running the same anchor
-- lookup and lock sequence repeatedly for a batch while retaining fail-closed
-- validation before the enclosing transaction can commit.
DROP TRIGGER ptar_parent_anchor_guard ON "ParticipantTimeAllocationRevision";

CREATE TRIGGER ptar_parent_anchor_guard
BEFORE INSERT ON "ParticipantTimeAllocationRevision"
FOR EACH ROW
WHEN (NEW."correctionPendingAllocationId" IS NULL)
EXECUTE FUNCTION ptar_parent_anchor_guard();

CREATE FUNCTION ptar_correction_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  application_not_ready boolean;
  correction_mismatch boolean;
  valid_nonempty_violation boolean;
  zero_source_violation boolean;
  unsupported_source_violation boolean;
BEGIN
  -- The transition table also contains ordinary D3/D4 rows.  They remain under
  -- ptar_parent_anchor_guard and are intentionally outside this V3-only arm.
  IF NOT EXISTS (
    SELECT 1
    FROM ptar_new_rows allocation
    WHERE allocation."correctionPendingAllocationId" IS NOT NULL
  ) THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ptar_new_rows allocation
    WHERE allocation."correctionPendingAllocationId" IS NOT NULL
      AND num_nonnulls(
        allocation."settlementDraftVersionId",
        allocation."settlementEvidenceSealId",
        allocation."settlementEvidenceRevision",
        allocation."settlementPopulationRevision",
        allocation."settlementWorkflowRevision",
        allocation."settlementDraftContentHash"
      ) <> 0
  ) THEN
    RAISE EXCEPTION 'correction allocation proof shape is invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'ptar_correction_proof_guard';
  END IF;

  -- Preserve the legacy lock sequence, but acquire every relevant immutable
  -- anchor once for the statement rather than once for each inserted row.
  -- The distinct input relations only remove duplicate transition rows; they
  -- do not broaden a lock predicate or omit any immutable anchor.
  PERFORM 1
  FROM (
    SELECT DISTINCT allocation."correctionPendingAllocationId" AS pending_id
    FROM ptar_new_rows allocation
    WHERE allocation."correctionPendingAllocationId" IS NOT NULL
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
    SELECT DISTINCT
      allocation."sourceSegmentId",
      allocation."participationIdentityId"
    FROM ptar_new_rows allocation
    WHERE allocation."correctionPendingAllocationId" IS NOT NULL
  ) input
  JOIN "ParticipantServiceSegmentRevision" source
    ON source.id = input."sourceSegmentId"
   AND source."participationIdentityId" = input."participationIdentityId"
  ORDER BY source.id
  FOR SHARE OF source;

  PERFORM 1
  FROM (
    SELECT DISTINCT
      pending."baseAllocationRevisionId",
      allocation."activityId",
      allocation."participationIdentityId",
      allocation."segmentKey"
    FROM ptar_new_rows allocation
    JOIN "CorrectionPendingTimeAllocation" pending
      ON pending.id = allocation."correctionPendingAllocationId"
    WHERE allocation."correctionPendingAllocationId" IS NOT NULL
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
    SELECT DISTINCT
      pending."policyVersionId",
      pending."definitionHash"
    FROM ptar_new_rows allocation
    JOIN "CorrectionPendingTimeAllocation" pending
      ON pending.id = allocation."correctionPendingAllocationId"
    WHERE allocation."correctionPendingAllocationId" IS NOT NULL
  ) input
  JOIN "TimePolicyVersion" policy
    ON policy.id = input."policyVersionId"
   AND policy."definitionHash" = input."definitionHash"
  ORDER BY policy.id
  FOR SHARE OF policy;

  -- All five existing fail-closed decisions read the same immutable chain.
  -- Evaluate that chain once per statement, then preserve its original error
  -- priority below.  A failed early category still wins over later categories.
  WITH correction_allocations AS MATERIALIZED (
    SELECT *
    FROM ptar_new_rows allocation
    WHERE allocation."correctionPendingAllocationId" IS NOT NULL
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

CREATE TRIGGER ptar_correction_insert_guard
AFTER INSERT ON "ParticipantTimeAllocationRevision"
REFERENCING NEW TABLE AS ptar_new_rows
FOR EACH STATEMENT EXECUTE FUNCTION ptar_correction_insert_guard();
