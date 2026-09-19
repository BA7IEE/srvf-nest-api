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
  PERFORM 1
  FROM "CorrectionPendingTimeAllocation" pending
  JOIN "CorrectionApplication" application ON application.id = pending."applicationId"
  JOIN "AttendanceCorrectionRequest" request ON request.id = application."correctionRequestId"
  JOIN "LedgerPostingBatch" batch ON batch.id = application."newPostingBatchId"
  JOIN "CorrectionPendingSegmentRevision" segment ON segment.id = pending."pendingSegmentId"
    AND segment."applicationId" = pending."applicationId"
    AND segment."activityId" = pending."activityId"
    AND segment."participationIdentityId" = pending."participationIdentityId"
    AND segment."segmentKey" = pending."segmentKey"
  WHERE EXISTS (
    SELECT 1
    FROM ptar_new_rows allocation
    WHERE allocation."correctionPendingAllocationId" = pending.id
  )
  ORDER BY pending.id
  FOR SHARE OF pending, application, request, batch, segment;

  PERFORM 1
  FROM "ParticipantServiceSegmentRevision" source
  WHERE EXISTS (
    SELECT 1
    FROM ptar_new_rows allocation
    WHERE allocation."correctionPendingAllocationId" IS NOT NULL
      AND allocation."sourceSegmentId" = source.id
      AND allocation."participationIdentityId" = source."participationIdentityId"
  )
  ORDER BY source.id
  FOR SHARE OF source;

  PERFORM 1
  FROM "ParticipantTimeAllocationRevision" base
  WHERE EXISTS (
    SELECT 1
    FROM ptar_new_rows allocation
    JOIN "CorrectionPendingTimeAllocation" pending
      ON pending.id = allocation."correctionPendingAllocationId"
    WHERE allocation."correctionPendingAllocationId" IS NOT NULL
      AND base.id = pending."baseAllocationRevisionId"
      AND base."activityId" = allocation."activityId"
      AND base."participationIdentityId" = allocation."participationIdentityId"
      AND base."segmentKey" = allocation."segmentKey"
  )
  ORDER BY base.id
  FOR SHARE OF base;

  PERFORM 1
  FROM "TimePolicyVersion" policy
  WHERE EXISTS (
    SELECT 1
    FROM ptar_new_rows allocation
    JOIN "CorrectionPendingTimeAllocation" pending
      ON pending.id = allocation."correctionPendingAllocationId"
    WHERE allocation."correctionPendingAllocationId" IS NOT NULL
      AND policy.id = pending."policyVersionId"
      AND policy."definitionHash" = pending."definitionHash"
  )
  ORDER BY policy.id
  FOR SHARE OF policy;

  IF EXISTS (
    SELECT 1
    FROM ptar_new_rows allocation
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
    WHERE allocation."correctionPendingAllocationId" IS NOT NULL
      AND (
        pending.id IS NULL
        OR application.id IS NULL
        OR request.id IS NULL
        OR batch.id IS NULL
        OR segment.id IS NULL
        OR application."statusCode" IS DISTINCT FROM 'preparing'
        OR request."statusCode" IS DISTINCT FROM 'applying'
        OR batch."statusCode" IS DISTINCT FROM 'ready'
        OR request."requestedChangeJson"->'schemaVersion' IS DISTINCT FROM '3'::jsonb
      )
  ) THEN
    RAISE EXCEPTION 'correction allocation application is not ready'
      USING ERRCODE = '23514', CONSTRAINT = 'ptar_correction_proof_guard';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ptar_new_rows allocation
    JOIN "CorrectionPendingTimeAllocation" pending
      ON pending.id = allocation."correctionPendingAllocationId"
    JOIN "CorrectionPendingSegmentRevision" segment ON segment.id = pending."pendingSegmentId"
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
      AND policy."definitionHash" = pending."definitionHash"
    WHERE allocation."correctionPendingAllocationId" IS NOT NULL
      AND (
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
      )
  ) THEN
    RAISE EXCEPTION 'correction allocation differs from its pending fact'
      USING ERRCODE = '23514', CONSTRAINT = 'ptar_correction_proof_guard';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ptar_new_rows allocation
    JOIN "ParticipantServiceSegmentRevision" source
      ON source.id = allocation."sourceSegmentId"
      AND source."participationIdentityId" = allocation."participationIdentityId"
    WHERE allocation."correctionPendingAllocationId" IS NOT NULL
      AND source."resultCode" = 'valid'
      AND (
        source."checkOutAt" IS NULL
        OR source."checkOutAt" <= source."checkInAt"
        OR allocation."sliceCount" < 1
      )
  ) THEN
    RAISE EXCEPTION 'valid correction allocation requires non-empty source slices'
      USING ERRCODE = '23514', CONSTRAINT = 'ptar_correction_proof_guard';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ptar_new_rows allocation
    JOIN "ParticipantServiceSegmentRevision" source
      ON source.id = allocation."sourceSegmentId"
      AND source."participationIdentityId" = allocation."participationIdentityId"
    WHERE allocation."correctionPendingAllocationId" IS NOT NULL
      AND source."resultCode" IN ('early_departure_zero', 'voided', 'replaced')
      AND (
        allocation."sliceCount" <> 0
        OR allocation."recognitionModeCode" <> 'automatic'
        OR allocation."manualReason" IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'zero correction source permits only empty automatic allocation'
      USING ERRCODE = '23514', CONSTRAINT = 'ptar_correction_proof_guard';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ptar_new_rows allocation
    JOIN "ParticipantServiceSegmentRevision" source
      ON source.id = allocation."sourceSegmentId"
      AND source."participationIdentityId" = allocation."participationIdentityId"
    WHERE allocation."correctionPendingAllocationId" IS NOT NULL
      AND (
        source."resultCode" IS NULL
        OR source."resultCode" NOT IN ('valid', 'early_departure_zero', 'voided', 'replaced')
      )
  ) THEN
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
