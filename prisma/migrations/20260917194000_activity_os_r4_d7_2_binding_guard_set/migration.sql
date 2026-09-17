-- D7-2 materializes up to 10,000 immutable source bindings in one createMany.
-- The original row trigger repeated the same proof/application/allocation locks
-- for every row, exhausting the fixed commit transaction before the existing
-- exact source-set check could run.  This statement trigger takes those same
-- locks and validates every new row as one set.  An exception from an AFTER
-- statement trigger still rolls back the INSERT and its transaction.

DROP TRIGGER ctab_insert_guard ON "CorrectionTimeAllocationBinding";

CREATE OR REPLACE FUNCTION ctab_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Lock every affected immutable proof and its live commit anchors once.
  PERFORM 1
  FROM "CorrectionTimeSourceProof" proof
  JOIN "CorrectionApplication" application ON application.id = proof."applicationId"
  JOIN "AttendanceCorrectionRequest" request ON request.id = application."correctionRequestId"
  JOIN "LedgerPostingBatch" batch ON batch.id = proof."postingBatchId"
  WHERE EXISTS (
    SELECT 1
    FROM ctab_new_rows binding
    WHERE binding."proofId" = proof.id
      AND binding."activityId" = proof."activityId"
  )
  FOR SHARE OF proof, application, request, batch;

  -- Keep the composite allocation anchor under the same lock discipline as
  -- the previous per-row guard.
  PERFORM 1
  FROM "ParticipantTimeAllocationRevision" allocation
  WHERE EXISTS (
    SELECT 1
    FROM ctab_new_rows binding
    WHERE binding."allocationRevisionId" = allocation.id
      AND binding."activityId" = allocation."activityId"
      AND binding."sourceSegmentId" = allocation."sourceSegmentId"
      AND binding."sourceSegmentRevision" = allocation."sourceSegmentRevision"
  )
  FOR SHARE OF allocation;

  -- A non-null pending allocation must retain its application, identity,
  -- segment and target-allocation chain; lock each supplied pending row before
  -- checking those links below.
  PERFORM 1
  FROM "CorrectionPendingTimeAllocation" pending
  JOIN "CorrectionPendingSegmentRevision" segment
    ON segment.id = pending."pendingSegmentId"
      AND segment."applicationId" = pending."applicationId"
      AND segment."activityId" = pending."activityId"
      AND segment."participationIdentityId" = pending."participationIdentityId"
      AND segment."segmentKey" = pending."segmentKey"
  WHERE EXISTS (
    SELECT 1
    FROM ctab_new_rows binding
    WHERE binding."pendingAllocationId" = pending.id
      AND binding."activityId" = pending."activityId"
  )
  FOR SHARE OF pending, segment;

  IF EXISTS (
    SELECT 1
    FROM ctab_new_rows binding
    LEFT JOIN "CorrectionTimeSourceProof" proof
      ON proof.id = binding."proofId"
        AND proof."activityId" = binding."activityId"
    LEFT JOIN "CorrectionApplication" application ON application.id = proof."applicationId"
    LEFT JOIN "AttendanceCorrectionRequest" request
      ON request.id = application."correctionRequestId"
    LEFT JOIN "LedgerPostingBatch" batch ON batch.id = proof."postingBatchId"
    LEFT JOIN "ParticipantTimeAllocationRevision" allocation
      ON allocation.id = binding."allocationRevisionId"
        AND allocation."activityId" = binding."activityId"
        AND allocation."sourceSegmentId" = binding."sourceSegmentId"
        AND allocation."sourceSegmentRevision" = binding."sourceSegmentRevision"
    WHERE proof.id IS NULL
      OR application.id IS NULL
      OR request.id IS NULL
      OR batch.id IS NULL
      OR application."statusCode" IS DISTINCT FROM 'preparing'
      OR request."statusCode" IS DISTINCT FROM 'applying'
      OR batch."statusCode" IS DISTINCT FROM 'ready'
      OR allocation.id IS NULL
  ) THEN
    RAISE EXCEPTION 'time allocation binding is not ready for materialization'
      USING ERRCODE = '23514', CONSTRAINT = 'ctab_insert_guard';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ctab_new_rows binding
    JOIN "CorrectionTimeSourceProof" proof
      ON proof.id = binding."proofId"
        AND proof."activityId" = binding."activityId"
    JOIN "ParticipantTimeAllocationRevision" allocation
      ON allocation.id = binding."allocationRevisionId"
        AND allocation."activityId" = binding."activityId"
        AND allocation."sourceSegmentId" = binding."sourceSegmentId"
        AND allocation."sourceSegmentRevision" = binding."sourceSegmentRevision"
    LEFT JOIN "CorrectionPendingTimeAllocation" pending
      ON pending.id = binding."pendingAllocationId"
        AND pending."activityId" = binding."activityId"
        AND pending."applicationId" = proof."applicationId"
    LEFT JOIN "CorrectionPendingSegmentRevision" segment
      ON segment.id = pending."pendingSegmentId"
        AND segment."applicationId" = pending."applicationId"
        AND segment."activityId" = pending."activityId"
        AND segment."participationIdentityId" = pending."participationIdentityId"
        AND segment."segmentKey" = pending."segmentKey"
    WHERE binding."pendingAllocationId" IS NOT NULL
      AND (
        pending.id IS NULL
        OR pending."participationIdentityId" IS DISTINCT FROM binding."participationIdentityId"
        OR pending."segmentKey" IS DISTINCT FROM binding."segmentKey"
        OR pending."targetAllocationRevisionId" IS DISTINCT FROM binding."allocationRevisionId"
        OR pending."targetSegmentRevisionId" IS DISTINCT FROM binding."sourceSegmentId"
        OR pending."targetAllocationRevision" IS DISTINCT FROM allocation.revision
        OR segment."targetRevisionNumber" IS DISTINCT FROM binding."sourceSegmentRevision"
        OR allocation."correctionPendingAllocationId" IS DISTINCT FROM pending.id
      )
  ) THEN
    RAISE EXCEPTION 'binding does not match its pending allocation fact'
      USING ERRCODE = '23514', CONSTRAINT = 'ctab_insert_guard';
  END IF;

  -- Source membership remains the existing exact multiset check in
  -- ctsp_assert_complete(require_bindings), before receipt and commit.
  RETURN NULL;
END;
$$;

CREATE TRIGGER ctab_insert_guard
  AFTER INSERT ON "CorrectionTimeAllocationBinding"
  REFERENCING NEW TABLE AS ctab_new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION ctab_insert_guard();
