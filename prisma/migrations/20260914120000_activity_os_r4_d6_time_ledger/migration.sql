BEGIN;

CREATE UNIQUE INDEX "lpb_id_version_run_key" ON "LedgerPostingBatch"("id", "settlementVersionId", "settlementRunId");
CREATE UNIQUE INDEX "astr_id_version_run_activity_key" ON "ActivitySettlementTimeRevision"("id", "settlementVersionId", "settlementRunId", "activityId");
CREATE UNIQUE INDEX "pstb_id_rev_activity_identity_category_seconds_key" ON "ParticipantSettlementTimeBucket"("id", "timeRevisionId", "activityId", "participationIdentityId", "categoryCode", "recognizedSeconds");

CREATE TABLE "ParticipationTimeLedgerManifest" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "postingBatchId" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "settlementRunId" TEXT NOT NULL,
  "settlementVersionId" TEXT NOT NULL,
  "timeRevisionId" TEXT NOT NULL,
  "bucketContentHash" TEXT NOT NULL,
  "sourceSetHash" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "expectedEntryCount" INTEGER NOT NULL,
  "recognizedSecondsTotal" BIGINT NOT NULL,
  "formatVersion" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ptlm_shape_check" CHECK ("formatVersion" = 1 AND "expectedEntryCount" BETWEEN 0 AND 8000 AND "recognizedSecondsTotal" >= 0),
  CONSTRAINT "ptlm_hash_check" CHECK ("bucketContentHash" ~ '^[a-f0-9]{64}$' AND "sourceSetHash" ~ '^[a-f0-9]{64}$' AND "contentHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "ptlm_batch_fkey" FOREIGN KEY ("postingBatchId", "settlementVersionId", "settlementRunId") REFERENCES "LedgerPostingBatch"("id", "settlementVersionId", "settlementRunId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ptlm_revision_fkey" FOREIGN KEY ("timeRevisionId", "settlementVersionId", "settlementRunId", "activityId") REFERENCES "ActivitySettlementTimeRevision"("id", "settlementVersionId", "settlementRunId", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "ptlm_batch_key" ON "ParticipationTimeLedgerManifest"("postingBatchId");
CREATE UNIQUE INDEX "ptlm_id_batch_revision_activity_key" ON "ParticipationTimeLedgerManifest"("id", "postingBatchId", "timeRevisionId", "activityId");
CREATE INDEX "ptlm_revision_idx" ON "ParticipationTimeLedgerManifest"("timeRevisionId", "postingBatchId");

CREATE TABLE "ParticipationTimeLedgerEntry" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "manifestId" TEXT NOT NULL,
  "postingBatchId" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "timeRevisionId" TEXT NOT NULL,
  "bucketId" TEXT NOT NULL,
  "participationIdentityId" TEXT NOT NULL,
  "categoryCode" TEXT NOT NULL,
  "recognizedSeconds" INTEGER NOT NULL,
  "entryKey" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ptle_shape_check" CHECK ("categoryCode" IN ('volunteer_service', 'training', 'organization', 'non_creditable') AND "recognizedSeconds" >= 0),
  CONSTRAINT "ptle_hash_check" CHECK ("entryKey" ~ '^[a-f0-9]{64}$' AND "contentHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "ptle_manifest_fkey" FOREIGN KEY ("manifestId", "postingBatchId", "timeRevisionId", "activityId") REFERENCES "ParticipationTimeLedgerManifest"("id", "postingBatchId", "timeRevisionId", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ptle_bucket_fkey" FOREIGN KEY ("bucketId", "timeRevisionId", "activityId", "participationIdentityId", "categoryCode", "recognizedSeconds") REFERENCES "ParticipantSettlementTimeBucket"("id", "timeRevisionId", "activityId", "participationIdentityId", "categoryCode", "recognizedSeconds") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "ptle_manifest_bucket_key" ON "ParticipationTimeLedgerEntry"("manifestId", "bucketId");
CREATE UNIQUE INDEX "ptle_entry_key" ON "ParticipationTimeLedgerEntry"("entryKey");
CREATE INDEX "ptle_manifest_identity_category_idx" ON "ParticipationTimeLedgerEntry"("manifestId", "participationIdentityId", "categoryCode", "id");

CREATE FUNCTION ptl_deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'classified time ledger is immutable' USING ERRCODE = '23514', CONSTRAINT = TG_NAME;
END;
$$;
CREATE TRIGGER ptlm_immutable BEFORE UPDATE OR DELETE ON "ParticipationTimeLedgerManifest" FOR EACH ROW EXECUTE FUNCTION ptl_deny_mutation();
CREATE TRIGGER ptle_immutable BEFORE UPDATE OR DELETE ON "ParticipationTimeLedgerEntry" FOR EACH ROW EXECUTE FUNCTION ptl_deny_mutation();
CREATE TRIGGER ptlm_no_truncate BEFORE TRUNCATE ON "ParticipationTimeLedgerManifest" FOR EACH STATEMENT EXECUTE FUNCTION ptl_deny_mutation();
CREATE TRIGGER ptle_no_truncate BEFORE TRUNCATE ON "ParticipationTimeLedgerEntry" FOR EACH STATEMENT EXECUTE FUNCTION ptl_deny_mutation();

CREATE FUNCTION ptl_manifest_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM b."id" FROM "LedgerPostingBatch" b
    JOIN (SELECT DISTINCT "postingBatchId" FROM ptl_new_manifests) n ON n."postingBatchId" = b."id"
    ORDER BY b."id" FOR UPDATE OF b;
  IF EXISTS (
    SELECT 1 FROM ptl_new_manifests m
    JOIN "LedgerPostingBatch" b ON b."id" = m."postingBatchId"
    JOIN "ActivitySettlementTimeRevision" r ON r."id" = m."timeRevisionId"
    WHERE b."statusCode" <> 'preparing' OR r."kindCode" <> 'submitted'
      OR r."bucketContentHash" <> m."bucketContentHash" OR r."sourceSetHash" <> m."sourceSetHash"
      OR r."bucketCount" <> m."expectedEntryCount"
      OR (SELECT count(*) FROM "ParticipantSettlementTimeBucket" s WHERE s."timeRevisionId" = r."id") <> m."expectedEntryCount"
      OR (SELECT COALESCE(sum(s."recognizedSeconds"), 0) FROM "ParticipantSettlementTimeBucket" s WHERE s."timeRevisionId" = r."id") <> m."recognizedSecondsTotal"
  ) THEN
    RAISE EXCEPTION 'invalid classified time ledger source' USING ERRCODE = '23514', CONSTRAINT = 'ptlm_source_guard';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER ptlm_insert_guard AFTER INSERT ON "ParticipationTimeLedgerManifest"
  REFERENCING NEW TABLE AS ptl_new_manifests FOR EACH STATEMENT EXECUTE FUNCTION ptl_manifest_insert_guard();

CREATE FUNCTION ptl_entry_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM b."id" FROM "LedgerPostingBatch" b
    JOIN (SELECT DISTINCT "postingBatchId" FROM ptl_new_entries) n ON n."postingBatchId" = b."id"
    ORDER BY b."id" FOR UPDATE OF b;
  IF EXISTS (SELECT 1 FROM ptl_new_entries e JOIN "LedgerPostingBatch" b ON b."id" = e."postingBatchId" WHERE b."statusCode" <> 'preparing') THEN
    RAISE EXCEPTION 'classified time ledger batch is not preparing' USING ERRCODE = '23514', CONSTRAINT = 'ptle_batch_guard';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER ptle_insert_guard AFTER INSERT ON "ParticipationTimeLedgerEntry"
  REFERENCING NEW TABLE AS ptl_new_entries FOR EACH STATEMENT EXECUTE FUNCTION ptl_entry_insert_guard();

CREATE FUNCTION ptl_batch_visibility_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m "ParticipationTimeLedgerManifest"%ROWTYPE;
BEGIN
  IF NEW."statusCode" NOT IN ('ready', 'committed') THEN RETURN NEW; END IF;
  SELECT * INTO m FROM "ParticipationTimeLedgerManifest" WHERE "postingBatchId" = NEW."id";
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM "ActivitySettlementTimeRevision" r WHERE r."settlementVersionId" = NEW."settlementVersionId" AND r."kindCode" = 'submitted') THEN
      RAISE EXCEPTION 'classified time ledger manifest missing' USING ERRCODE = '23514', CONSTRAINT = 'ptl_visibility_guard';
    END IF;
    RETURN NEW;
  END IF;
  IF (SELECT count(*) FROM "ParticipationTimeLedgerEntry" e WHERE e."manifestId" = m."id") <> m."expectedEntryCount"
    OR (SELECT COALESCE(sum(e."recognizedSeconds"), 0) FROM "ParticipationTimeLedgerEntry" e WHERE e."manifestId" = m."id") <> m."recognizedSecondsTotal"
    OR EXISTS (
      SELECT s."id" FROM "ParticipantSettlementTimeBucket" s WHERE s."timeRevisionId" = m."timeRevisionId"
      EXCEPT
      SELECT e."bucketId" FROM "ParticipationTimeLedgerEntry" e WHERE e."manifestId" = m."id"
    )
    OR EXISTS (
      SELECT e."bucketId" FROM "ParticipationTimeLedgerEntry" e WHERE e."manifestId" = m."id"
      EXCEPT
      SELECT s."id" FROM "ParticipantSettlementTimeBucket" s WHERE s."timeRevisionId" = m."timeRevisionId"
    ) THEN
    RAISE EXCEPTION 'classified time ledger entries incomplete' USING ERRCODE = '23514', CONSTRAINT = 'ptl_visibility_guard';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ptl_visibility_guard BEFORE UPDATE OF "statusCode" ON "LedgerPostingBatch"
  FOR EACH ROW EXECUTE FUNCTION ptl_batch_visibility_guard();

COMMIT;
