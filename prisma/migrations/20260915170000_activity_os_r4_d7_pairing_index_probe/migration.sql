-- D7-1: preserve the complete-key parameterized probes even with cold statistics.
-- OFFSET 0 is an optimizer boundary, not a row limit; all guards remain unchanged.
CREATE OR REPLACE FUNCTION ptc_assert_complete(batch_id TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE m "ParticipationTimeCorrectionManifest"%ROWTYPE;
DECLARE required BOOLEAN;
DECLARE approved_items JSONB;
BEGIN
  SELECT EXISTS (SELECT 1 FROM "CorrectionApplication" a JOIN "AttendanceCorrectionRequest" r ON r."id" = a."correctionRequestId"
    WHERE a."newPostingBatchId" = batch_id AND r."requestedChangeJson"->'schemaVersion' = '2'::jsonb) INTO required;
  SELECT * INTO m FROM "ParticipationTimeCorrectionManifest" WHERE "postingBatchId" = batch_id;
  IF NOT FOUND THEN
    IF required THEN RAISE EXCEPTION 'time correction manifest missing' USING ERRCODE = '23514', CONSTRAINT = 'ptc_visibility_guard'; END IF;
    RETURN;
  END IF;
  IF NOT required OR NOT EXISTS (SELECT 1 FROM "CorrectionApplication" a
    WHERE a."newPostingBatchId" = batch_id AND a."newSettlementVersionId" = m."settlementVersionId" AND a."correctionRequestId" = m."correctionRequestId"
      AND a."statusCode" IN ('preparing','committed')) THEN
    RAISE EXCEPTION 'time correction application mismatch' USING ERRCODE = '23514', CONSTRAINT = 'ptc_visibility_guard';
  END IF;
  SELECT "requestedChangeJson"->'timeCorrection'->'items' INTO approved_items FROM "AttendanceCorrectionRequest" WHERE "id" = m."correctionRequestId";
  IF jsonb_typeof(approved_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'time correction approved items missing' USING ERRCODE = '23514', CONSTRAINT = 'ptc_visibility_guard';
  END IF;
  IF (SELECT count(*) FROM "ParticipationTimeLedgerEntry" r WHERE r."manifestId" = m."rootManifestId") <> m."expectedRootCount"
    OR jsonb_array_length(approved_items) <> m."expectedRootCount"
    OR (SELECT count(*) FROM "ParticipationTimeCorrectionEntry" e WHERE e."manifestId" = m."id") <> m."expectedEntryCount"
    OR (SELECT COALESCE(sum(e."secondsDelta") FILTER (WHERE e."entryTypeCode" = 'reversal'),0) FROM "ParticipationTimeCorrectionEntry" e WHERE e."manifestId" = m."id") <> m."reversalSecondsTotal"
    OR (SELECT COALESCE(sum(e."secondsDelta") FILTER (WHERE e."entryTypeCode" = 'credit'),0) FROM "ParticipationTimeCorrectionEntry" e WHERE e."manifestId" = m."id") <> m."replacementSecondsTotal"
    OR EXISTS (
      -- Materialize the complete pairing before looking for a mismatch. Otherwise
      -- EXISTS's first-row estimate can rescan all approved items for every root.
      WITH paired AS MATERIALIZED (
      SELECT reversal."id" AS reversal_id, credit."id" AS credit_id,
        credit."secondsDelta" AS credit_seconds, approved."recognizedSeconds" AS approved_seconds,
        reversal."reversesCorrectionEntryId" AS reverses_id,
        reversal."secondsDelta" AS reversal_seconds, root."recognizedSeconds" AS root_seconds,
        prior."id" AS prior_id, prior."secondsDelta" AS prior_seconds
      FROM "ParticipationTimeLedgerEntry" root
      LEFT JOIN LATERAL (
        SELECT e.* FROM "ParticipationTimeCorrectionEntry" e
        WHERE e."manifestId" = m."id" AND e."rootEntryId" = root."id" AND e."entryTypeCode" = 'reversal'
        OFFSET 0
      ) reversal ON TRUE
      LEFT JOIN LATERAL (
        SELECT e.* FROM "ParticipationTimeCorrectionEntry" e
        WHERE e."manifestId" = m."id" AND e."rootEntryId" = root."id" AND e."entryTypeCode" = 'credit'
        OFFSET 0
      ) credit ON TRUE
      LEFT JOIN LATERAL (
        SELECT e.* FROM "ParticipationTimeCorrectionEntry" e
        WHERE e."manifestId" = m."predecessorManifestId" AND e."rootEntryId" = root."id" AND e."entryTypeCode" = 'credit'
        OFFSET 0
      ) prior ON TRUE
      LEFT JOIN jsonb_to_recordset(approved_items) AS approved("rootEntryId" TEXT, "recognizedSeconds" BIGINT) ON approved."rootEntryId" = root."id"
      WHERE root."manifestId" = m."rootManifestId"
      ) SELECT 1 FROM paired WHERE
        reversal_id IS NULL OR credit_id IS NULL
        OR credit_seconds IS DISTINCT FROM approved_seconds
        OR (m."predecessorManifestId" IS NULL AND (reverses_id IS NOT NULL OR reversal_seconds <> -root_seconds))
        OR (m."predecessorManifestId" IS NOT NULL AND (prior_id IS NULL OR reverses_id IS DISTINCT FROM prior_id OR reversal_seconds <> -prior_seconds))
    )
    OR EXISTS (SELECT 1 FROM "ParticipationTimeCorrectionEntry" e JOIN "ParticipationTimeLedgerEntry" r ON r."id" = e."rootEntryId"
      WHERE e."manifestId" = m."id" AND r."manifestId" <> m."rootManifestId") THEN
    RAISE EXCEPTION 'time correction paired contents incomplete' USING ERRCODE = '23514', CONSTRAINT = 'ptc_visibility_guard';
  END IF;
END;
$$;
