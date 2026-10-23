-- Project only the fields consumed by the two source-proof checks.
-- The earlier array-length statement retains non-array/NULL behavior; mixed
-- arrays retain the original jsonb_array_elements branch. No checks are skipped.

CREATE OR REPLACE FUNCTION ctsp_assert_complete(batch_id TEXT, require_bindings BOOLEAN)
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
    ELSE EXISTS (
    SELECT 1 FROM "CorrectionPendingTimeAllocation" p
    WHERE p."applicationId" = proof_row."applicationId"
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_to_recordset(proof_row."sourceSnapshotJson")
          AS source("participationIdentityId" TEXT, "segmentKey" TEXT, "baseAllocationRevisionId" TEXT)
        WHERE source."participationIdentityId" = p."participationIdentityId"
          AND source."segmentKey" = p."segmentKey"
          AND source."baseAllocationRevisionId" = p."baseAllocationRevisionId"
      )
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
