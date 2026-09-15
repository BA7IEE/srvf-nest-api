BEGIN;

-- CreateTable
CREATE TABLE "ParticipationTimeCorrectionManifest" (
    "id" TEXT NOT NULL,
    "correctionRequestId" TEXT NOT NULL,
    "postingBatchId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "settlementRunId" TEXT NOT NULL,
    "baseSettlementVersionId" TEXT NOT NULL,
    "settlementVersionId" TEXT NOT NULL,
    "rootManifestId" TEXT NOT NULL,
    "predecessorManifestId" TEXT,
    "baseContentHash" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "expectedRootCount" INTEGER NOT NULL,
    "expectedEntryCount" INTEGER NOT NULL,
    "reversalSecondsTotal" BIGINT NOT NULL,
    "replacementSecondsTotal" BIGINT NOT NULL,
    "formatVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ParticipationTimeCorrectionManifest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParticipationTimeCorrectionEntry" (
    "id" TEXT NOT NULL,
    "manifestId" TEXT NOT NULL,
    "postingBatchId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "rootEntryId" TEXT NOT NULL,
    "participationIdentityId" TEXT NOT NULL,
    "categoryCode" TEXT NOT NULL,
    "entryTypeCode" TEXT NOT NULL,
    "secondsDelta" INTEGER NOT NULL,
    "reversesCorrectionEntryId" TEXT,
    "entryKey" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ParticipationTimeCorrectionEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParticipationTimeCorrectionCommitReceipt" (
    "id" TEXT NOT NULL,
    "manifestId" TEXT NOT NULL,
    "postingBatchId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "settlementRunId" TEXT NOT NULL,
    "baseSettlementVersionId" TEXT NOT NULL,
    "settlementVersionId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ParticipationTimeCorrectionCommitReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ptcm_batch_key" ON "ParticipationTimeCorrectionManifest"("postingBatchId");

-- CreateIndex
CREATE INDEX "ptcm_request_idx" ON "ParticipationTimeCorrectionManifest"("correctionRequestId");

-- CreateIndex
CREATE INDEX "ptcm_activity_version_idx" ON "ParticipationTimeCorrectionManifest"("activityId", "settlementVersionId");

-- CreateIndex
CREATE INDEX "ptcm_root_idx" ON "ParticipationTimeCorrectionManifest"("rootManifestId");

-- CreateIndex
CREATE INDEX "ptcm_predecessor_idx" ON "ParticipationTimeCorrectionManifest"("predecessorManifestId");

-- CreateIndex
CREATE UNIQUE INDEX "ptcm_id_batch_activity_key" ON "ParticipationTimeCorrectionManifest"("id", "postingBatchId", "activityId");

-- CreateIndex
CREATE UNIQUE INDEX "ptcm_receipt_anchor_key" ON "ParticipationTimeCorrectionManifest"("id", "postingBatchId", "activityId", "settlementRunId", "baseSettlementVersionId", "settlementVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "ptce_entry_key" ON "ParticipationTimeCorrectionEntry"("entryKey");

-- CreateIndex
CREATE INDEX "ptce_manifest_page_idx" ON "ParticipationTimeCorrectionEntry"("manifestId", "participationIdentityId", "categoryCode", "entryTypeCode", "id");

-- CreateIndex
CREATE INDEX "ptce_reverses_idx" ON "ParticipationTimeCorrectionEntry"("reversesCorrectionEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "ptce_id_root_activity_key" ON "ParticipationTimeCorrectionEntry"("id", "rootEntryId", "activityId");

-- CreateIndex
CREATE UNIQUE INDEX "ptce_manifest_root_type_key" ON "ParticipationTimeCorrectionEntry"("manifestId", "rootEntryId", "entryTypeCode");

-- CreateIndex
CREATE UNIQUE INDEX "ptcr_manifest_key" ON "ParticipationTimeCorrectionCommitReceipt"("manifestId");

-- CreateIndex
CREATE UNIQUE INDEX "ptcr_base_version_key" ON "ParticipationTimeCorrectionCommitReceipt"("baseSettlementVersionId");

-- CreateIndex
CREATE INDEX "ptcr_batch_idx" ON "ParticipationTimeCorrectionCommitReceipt"("postingBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "ptcr_manifest_anchor_key" ON "ParticipationTimeCorrectionCommitReceipt"("manifestId", "postingBatchId", "activityId", "settlementRunId", "baseSettlementVersionId", "settlementVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "ptlm_id_activity_run_key" ON "ParticipationTimeLedgerManifest"("id", "activityId", "settlementRunId");

-- CreateIndex
CREATE UNIQUE INDEX "ptle_id_identity_category_key" ON "ParticipationTimeLedgerEntry"("id", "participationIdentityId", "categoryCode");

-- CreateIndex
CREATE UNIQUE INDEX "acr_id_base_activity_run_key" ON "AttendanceCorrectionRequest"("id", "baseSettlementVersionId", "activityId", "settlementRunId");

-- AddForeignKey
ALTER TABLE "ParticipationTimeCorrectionManifest" ADD CONSTRAINT "ptcm_batch_fkey" FOREIGN KEY ("postingBatchId", "settlementVersionId", "settlementRunId") REFERENCES "LedgerPostingBatch"("id", "settlementVersionId", "settlementRunId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ParticipationTimeCorrectionManifest" ADD CONSTRAINT "ptcm_root_fkey" FOREIGN KEY ("rootManifestId", "activityId", "settlementRunId") REFERENCES "ParticipationTimeLedgerManifest"("id", "activityId", "settlementRunId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ParticipationTimeCorrectionManifest" ADD CONSTRAINT "ptcm_request_fkey" FOREIGN KEY ("correctionRequestId", "baseSettlementVersionId", "activityId", "settlementRunId") REFERENCES "AttendanceCorrectionRequest"("id", "baseSettlementVersionId", "activityId", "settlementRunId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ParticipationTimeCorrectionManifest" ADD CONSTRAINT "ptcm_predecessor_fkey" FOREIGN KEY ("predecessorManifestId") REFERENCES "ParticipationTimeCorrectionManifest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ParticipationTimeCorrectionEntry" ADD CONSTRAINT "ptce_manifest_fkey" FOREIGN KEY ("manifestId", "postingBatchId", "activityId") REFERENCES "ParticipationTimeCorrectionManifest"("id", "postingBatchId", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ParticipationTimeCorrectionEntry" ADD CONSTRAINT "ptce_root_fkey" FOREIGN KEY ("rootEntryId", "participationIdentityId", "categoryCode") REFERENCES "ParticipationTimeLedgerEntry"("id", "participationIdentityId", "categoryCode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ParticipationTimeCorrectionEntry" ADD CONSTRAINT "ptce_reverses_fkey" FOREIGN KEY ("reversesCorrectionEntryId", "rootEntryId", "activityId") REFERENCES "ParticipationTimeCorrectionEntry"("id", "rootEntryId", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ParticipationTimeCorrectionCommitReceipt" ADD CONSTRAINT "ptcr_manifest_fkey" FOREIGN KEY ("manifestId", "postingBatchId", "activityId", "settlementRunId", "baseSettlementVersionId", "settlementVersionId") REFERENCES "ParticipationTimeCorrectionManifest"("id", "postingBatchId", "activityId", "settlementRunId", "baseSettlementVersionId", "settlementVersionId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ParticipationTimeCorrectionManifest"
  ADD CONSTRAINT ptcm_format_check CHECK ("formatVersion" = 1),
  ADD CONSTRAINT ptcm_hash_check CHECK ("baseContentHash" ~ '^[a-f0-9]{64}$' AND "requestHash" ~ '^[a-f0-9]{64}$' AND "contentHash" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT ptcm_counts_check CHECK ("expectedRootCount" BETWEEN 1 AND 8000 AND "expectedEntryCount" = 2 * "expectedRootCount"),
  ADD CONSTRAINT ptcm_totals_check CHECK ("reversalSecondsTotal" <= 0 AND "replacementSecondsTotal" >= 0),
  ADD CONSTRAINT ptcm_versions_check CHECK ("baseSettlementVersionId" <> "settlementVersionId" AND "predecessorManifestId" IS DISTINCT FROM "id");
ALTER TABLE "ParticipationTimeCorrectionEntry"
  ADD CONSTRAINT ptce_category_check CHECK ("categoryCode" IN ('volunteer_service','training','organization','non_creditable')),
  ADD CONSTRAINT ptce_type_amount_check CHECK (("entryTypeCode" = 'credit' AND "secondsDelta" >= 0 AND "reversesCorrectionEntryId" IS NULL) OR ("entryTypeCode" = 'reversal' AND "secondsDelta" BETWEEN -2147483647 AND 0)),
  ADD CONSTRAINT ptce_hash_check CHECK ("entryKey" ~ '^[a-f0-9]{64}$' AND "contentHash" ~ '^[a-f0-9]{64}$');
ALTER TABLE "ParticipationTimeCorrectionCommitReceipt"
  ADD CONSTRAINT ptcr_hash_check CHECK ("contentHash" ~ '^[a-f0-9]{64}$');

CREATE FUNCTION ptc_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'time correction contents are append-only' USING ERRCODE = '23514', CONSTRAINT = TG_NAME;
END;
$$;
CREATE TRIGGER ptcm_immutable BEFORE UPDATE OR DELETE ON "ParticipationTimeCorrectionManifest" FOR EACH ROW EXECUTE FUNCTION ptc_reject_mutation();
CREATE TRIGGER ptce_immutable BEFORE UPDATE OR DELETE ON "ParticipationTimeCorrectionEntry" FOR EACH ROW EXECUTE FUNCTION ptc_reject_mutation();
CREATE TRIGGER ptcr_immutable BEFORE UPDATE OR DELETE ON "ParticipationTimeCorrectionCommitReceipt" FOR EACH ROW EXECUTE FUNCTION ptc_reject_mutation();
CREATE TRIGGER ptcm_no_truncate BEFORE TRUNCATE ON "ParticipationTimeCorrectionManifest" FOR EACH STATEMENT EXECUTE FUNCTION ptc_reject_mutation();
CREATE TRIGGER ptce_no_truncate BEFORE TRUNCATE ON "ParticipationTimeCorrectionEntry" FOR EACH STATEMENT EXECUTE FUNCTION ptc_reject_mutation();
CREATE TRIGGER ptcr_no_truncate BEFORE TRUNCATE ON "ParticipationTimeCorrectionCommitReceipt" FOR EACH STATEMENT EXECUTE FUNCTION ptc_reject_mutation();

CREATE FUNCTION ptcm_guard_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root "ParticipationTimeLedgerManifest"%ROWTYPE;
DECLARE prior "ParticipationTimeCorrectionManifest"%ROWTYPE;
DECLARE batch_status TEXT;
BEGIN
  SELECT "statusCode" INTO batch_status FROM "LedgerPostingBatch" WHERE "id" = NEW."postingBatchId" FOR UPDATE;
  IF batch_status IS DISTINCT FROM 'preparing' THEN
    RAISE EXCEPTION 'time correction batch is not preparing' USING ERRCODE = '23514', CONSTRAINT = 'ptcm_insert_guard';
  END IF;
  SELECT m.* INTO root FROM "ParticipationTimeLedgerManifest" m JOIN "LedgerPostingBatch" b ON b."id" = m."postingBatchId" AND b."statusCode" = 'committed'
    WHERE m."id" = NEW."rootManifestId" AND m."activityId" = NEW."activityId" AND m."settlementRunId" = NEW."settlementRunId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'time correction root is unavailable' USING ERRCODE = '23514', CONSTRAINT = 'ptcm_insert_guard';
  END IF;
  IF NEW."predecessorManifestId" IS NULL THEN
    IF NEW."baseSettlementVersionId" <> root."settlementVersionId" OR NEW."baseContentHash" <> root."contentHash" THEN
      RAISE EXCEPTION 'time correction initial anchor mismatch' USING ERRCODE = '23514', CONSTRAINT = 'ptcm_insert_guard';
    END IF;
  ELSE
    SELECT m.* INTO prior FROM "ParticipationTimeCorrectionManifest" m
      JOIN "ParticipationTimeCorrectionCommitReceipt" r ON r."manifestId" = m."id" AND r."contentHash" = m."contentHash"
      JOIN "LedgerPostingBatch" b ON b."id" = m."postingBatchId" AND b."statusCode" = 'committed'
      WHERE m."id" = NEW."predecessorManifestId";
    IF NOT FOUND OR prior."rootManifestId" <> NEW."rootManifestId" OR prior."settlementVersionId" <> NEW."baseSettlementVersionId"
      OR prior."activityId" <> NEW."activityId" OR prior."settlementRunId" <> NEW."settlementRunId" OR prior."contentHash" <> NEW."baseContentHash" THEN
      RAISE EXCEPTION 'time correction predecessor mismatch' USING ERRCODE = '23514', CONSTRAINT = 'ptcm_insert_guard';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "AttendanceCorrectionRequest" r
    WHERE r."id" = NEW."correctionRequestId" AND r."statusCode" IN ('approved', 'applying')
      AND r."requestedChangeJson"->'schemaVersion' = '2'::jsonb
      AND r."requestedChangeJson"->'segments' = '[]'::jsonb
      AND r."requestedChangeJson"->'timeCorrection'->>'baseSettlementVersionId' = NEW."baseSettlementVersionId"
      AND r."requestedChangeJson"->'timeCorrection'->>'baseTimeLedgerHash' = NEW."baseContentHash") THEN
    RAISE EXCEPTION 'time correction approved request mismatch' USING ERRCODE = '23514', CONSTRAINT = 'ptcm_insert_guard';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ptcm_insert_guard BEFORE INSERT ON "ParticipationTimeCorrectionManifest" FOR EACH ROW EXECUTE FUNCTION ptcm_guard_insert();

CREATE FUNCTION ptce_guard_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch_status TEXT;
BEGIN
  SELECT "statusCode" INTO batch_status FROM "LedgerPostingBatch" WHERE "id" = NEW."postingBatchId" FOR UPDATE;
  IF batch_status IS DISTINCT FROM 'preparing' THEN
    RAISE EXCEPTION 'time correction entry batch is not preparing' USING ERRCODE = '23514', CONSTRAINT = 'ptce_insert_guard';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ptce_insert_guard BEFORE INSERT ON "ParticipationTimeCorrectionEntry" FOR EACH ROW EXECUTE FUNCTION ptce_guard_insert();

-- Set validation is independent of the D6 trigger and runs even when an attacker
-- omits the entire manifest: the approved V2 application identifies required work.
CREATE FUNCTION ptc_assert_complete(batch_id TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
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
      LEFT JOIN "ParticipationTimeCorrectionEntry" reversal ON reversal."manifestId" = m."id" AND reversal."rootEntryId" = root."id" AND reversal."entryTypeCode" = 'reversal'
      LEFT JOIN "ParticipationTimeCorrectionEntry" credit ON credit."manifestId" = m."id" AND credit."rootEntryId" = root."id" AND credit."entryTypeCode" = 'credit'
      LEFT JOIN "ParticipationTimeCorrectionEntry" prior ON prior."manifestId" = m."predecessorManifestId" AND prior."rootEntryId" = root."id" AND prior."entryTypeCode" = 'credit'
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

CREATE FUNCTION ptc_guard_visibility() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."statusCode" NOT IN ('ready','committed') THEN RETURN NEW; END IF;
  PERFORM ptc_assert_complete(NEW."id");
  IF NEW."statusCode" = 'committed' AND EXISTS (SELECT 1 FROM "ParticipationTimeCorrectionManifest" m WHERE m."postingBatchId" = NEW."id")
    AND NOT EXISTS (SELECT 1 FROM "ParticipationTimeCorrectionCommitReceipt" r JOIN "ParticipationTimeCorrectionManifest" m ON m."id" = r."manifestId" AND m."contentHash" = r."contentHash" WHERE r."postingBatchId" = NEW."id") THEN
    RAISE EXCEPTION 'time correction commit receipt missing' USING ERRCODE = '23514', CONSTRAINT = 'ptc_visibility_guard';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ptc_visibility_guard BEFORE INSERT OR UPDATE OF "statusCode" ON "LedgerPostingBatch" FOR EACH ROW EXECUTE FUNCTION ptc_guard_visibility();

CREATE FUNCTION ptcr_guard_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch_status TEXT;
BEGIN
  SELECT "statusCode" INTO batch_status FROM "LedgerPostingBatch" WHERE "id" = NEW."postingBatchId" FOR UPDATE;
  IF batch_status IS DISTINCT FROM 'ready' OR NOT EXISTS (SELECT 1 FROM "ParticipationTimeCorrectionManifest" m WHERE m."id" = NEW."manifestId" AND m."contentHash" = NEW."contentHash") THEN
    RAISE EXCEPTION 'time correction receipt anchor is not ready' USING ERRCODE = '23514', CONSTRAINT = 'ptcr_insert_guard';
  END IF;
  PERFORM ptc_assert_complete(NEW."postingBatchId");
  RETURN NEW;
END;
$$;
CREATE TRIGGER ptcr_insert_guard BEFORE INSERT ON "ParticipationTimeCorrectionCommitReceipt" FOR EACH ROW EXECUTE FUNCTION ptcr_guard_insert();

-- Check final transaction state, not intermediate statement ordering. A receipt
-- alone or a direct batch commit cannot leave an unapplied correction visible.
CREATE FUNCTION ptc_guard_commit_closure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch_id TEXT;
DECLARE m "ParticipationTimeCorrectionManifest"%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'LedgerPostingBatch' THEN batch_id := NEW."id";
  ELSE batch_id := NEW."postingBatchId"; END IF;
  SELECT * INTO m FROM "ParticipationTimeCorrectionManifest" WHERE "postingBatchId" = batch_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM "ParticipationTimeCorrectionCommitReceipt" WHERE "postingBatchId" = batch_id)
    OR EXISTS (SELECT 1 FROM "LedgerPostingBatch" WHERE "id" = batch_id AND "statusCode" = 'committed') THEN
    IF NOT EXISTS (SELECT 1 FROM "ParticipationTimeCorrectionCommitReceipt" r
      JOIN "LedgerPostingBatch" b ON b."id" = r."postingBatchId" AND b."statusCode" = 'committed'
      JOIN "CorrectionApplication" a ON a."newPostingBatchId" = b."id" AND a."newSettlementVersionId" = m."settlementVersionId" AND a."correctionRequestId" = m."correctionRequestId" AND a."statusCode" = 'committed'
      JOIN "AttendanceCorrectionRequest" q ON q."id" = a."correctionRequestId" AND q."statusCode" = 'applied'
      WHERE r."manifestId" = m."id" AND r."contentHash" = m."contentHash") THEN
      RAISE EXCEPTION 'time correction transaction is incomplete' USING ERRCODE = '23514', CONSTRAINT = 'ptc_commit_closure_guard';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ptc_commit_closure_guard AFTER INSERT OR UPDATE ON "LedgerPostingBatch" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ptc_guard_commit_closure();
CREATE CONSTRAINT TRIGGER ptcr_commit_closure_guard AFTER INSERT ON "ParticipationTimeCorrectionCommitReceipt" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ptc_guard_commit_closure();

COMMIT;
