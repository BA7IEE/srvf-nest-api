BEGIN;

-- D8-1: one immutable database cutover fact and one immutable regime binding
-- for every ordinary classified root committed after it.  No existing row is
-- backfilled or reclassified by this migration.
CREATE UNIQUE INDEX "ptlm_cutover_anchor_key"
  ON "ParticipationTimeLedgerManifest"(
    "id", "postingBatchId", "activityId", "settlementRunId",
    "settlementVersionId", "contentHash"
  );

CREATE TABLE "ActivityTimeCutoverReceipt" (
  "id" TEXT NOT NULL,
  "operationKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "deployedMainSha" TEXT NOT NULL,
  "evidenceBundleHash" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "cutoverAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  "formatVersion" INTEGER NOT NULL DEFAULT 1,
  "contentHash" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT "ActivityTimeCutoverReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "atcr_singleton_check" CHECK ("id" = 'activity-time-v1'),
  CONSTRAINT "atcr_operation_key_check" CHECK (
    char_length("operationKey") BETWEEN 1 AND 128
    AND "operationKey" = btrim("operationKey")
    AND "operationKey" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT "atcr_request_hash_check" CHECK ("requestHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "atcr_main_sha_check" CHECK ("deployedMainSha" ~ '^[a-f0-9]{40}$'),
  CONSTRAINT "atcr_evidence_hash_check" CHECK ("evidenceBundleHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "atcr_format_check" CHECK ("formatVersion" = 1),
  CONSTRAINT "atcr_content_hash_check" CHECK ("contentHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "atcr_actor_fkey" FOREIGN KEY ("actorUserId")
    REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "atcr_operation_key" ON "ActivityTimeCutoverReceipt"("operationKey");
CREATE UNIQUE INDEX "atcr_id_format_key" ON "ActivityTimeCutoverReceipt"("id", "formatVersion");
CREATE INDEX "atcr_actor_idx" ON "ActivityTimeCutoverReceipt"("actorUserId");

CREATE TABLE "ParticipationTimeCutoverBinding" (
  "id" TEXT NOT NULL,
  "cutoverReceiptId" TEXT NOT NULL,
  "rootManifestId" TEXT NOT NULL,
  "postingBatchId" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "settlementRunId" TEXT NOT NULL,
  "settlementVersionId" TEXT NOT NULL,
  "rootContentHash" TEXT NOT NULL,
  "formatVersion" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT "ParticipationTimeCutoverBinding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ptcb_id_check" CHECK ("id" = 'ptcb:' || "rootManifestId"),
  CONSTRAINT "ptcb_format_check" CHECK ("formatVersion" = 1),
  CONSTRAINT "ptcb_hash_check" CHECK ("rootContentHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "ptcb_receipt_fkey" FOREIGN KEY ("cutoverReceiptId", "formatVersion")
    REFERENCES "ActivityTimeCutoverReceipt"("id", "formatVersion")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ptcb_root_manifest_fkey" FOREIGN KEY (
    "rootManifestId", "postingBatchId", "activityId", "settlementRunId",
    "settlementVersionId", "rootContentHash"
  ) REFERENCES "ParticipationTimeLedgerManifest"(
    "id", "postingBatchId", "activityId", "settlementRunId",
    "settlementVersionId", "contentHash"
  ) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "ptcb_root_manifest_key"
  ON "ParticipationTimeCutoverBinding"("rootManifestId");
CREATE UNIQUE INDEX "ptcb_posting_batch_key"
  ON "ParticipationTimeCutoverBinding"("postingBatchId");
CREATE UNIQUE INDEX "ptcb_root_anchor_key"
  ON "ParticipationTimeCutoverBinding"(
    "rootManifestId", "postingBatchId", "activityId", "settlementRunId",
    "settlementVersionId", "rootContentHash"
  );
CREATE INDEX "ptcb_receipt_idx"
  ON "ParticipationTimeCutoverBinding"("cutoverReceiptId");
CREATE INDEX "ptcb_activity_version_idx"
  ON "ParticipationTimeCutoverBinding"("activityId", "settlementVersionId");

-- The fixed lock domain linearizes ordinary batch birth/commit with the one
-- cutover insert.  Shared holders may proceed together; the cutover waits for
-- all earlier holders and blocks every later holder until its transaction ends.
CREATE FUNCTION atc_lock_key() RETURNS bigint
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT hashtextextended('activity-time-cutover-v1', 0);
$$;

CREATE FUNCTION atc_batch_fence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock_shared(atc_lock_key());
  ELSIF OLD."statusCode" = 'ready' AND NEW."statusCode" = 'committed' THEN
    PERFORM pg_advisory_xact_lock_shared(atc_lock_key());
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER atc_batch_fence
BEFORE INSERT OR UPDATE OF "statusCode" ON "LedgerPostingBatch"
FOR EACH ROW EXECUTE FUNCTION atc_batch_fence_guard();

-- Length-prefix every UTF-8 field so the payload is unambiguous without
-- depending on JSON object order.  The TypeScript verifier uses the same
-- domain, order and millisecond UTC instant.
CREATE FUNCTION atcr_content_payload(
  receipt_id text,
  operation_key text,
  request_hash text,
  deployed_main_sha text,
  evidence_bundle_hash text,
  actor_user_id text,
  cutover_at timestamptz,
  format_version integer
) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT 'activity-time-cutover-receipt-v1'
    || '|' || octet_length(convert_to(receipt_id, 'UTF8'))::text || ':' || receipt_id
    || '|' || octet_length(convert_to(operation_key, 'UTF8'))::text || ':' || operation_key
    || '|' || octet_length(convert_to(request_hash, 'UTF8'))::text || ':' || request_hash
    || '|' || octet_length(convert_to(deployed_main_sha, 'UTF8'))::text || ':' || deployed_main_sha
    || '|' || octet_length(convert_to(evidence_bundle_hash, 'UTF8'))::text || ':' || evidence_bundle_hash
    || '|' || octet_length(convert_to(actor_user_id, 'UTF8'))::text || ':' || actor_user_id
    || '|' || octet_length(convert_to(to_char(cutover_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'UTF8'))::text
      || ':' || to_char(cutover_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    || '|' || octet_length(convert_to(format_version::text, 'UTF8'))::text || ':' || format_version::text;
$$;

CREATE FUNCTION atcr_prepare_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  canonical_payload text;
BEGIN
  PERFORM pg_advisory_xact_lock(atc_lock_key());

  IF EXISTS (SELECT 1 FROM "ActivityTimeCutoverReceipt") THEN
    RAISE EXCEPTION 'activity time cutover receipt already exists'
      USING ERRCODE = '23505', CONSTRAINT = 'atcr_singleton_guard';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "LedgerPostingBatch"
    WHERE "statusCode" IN ('preparing', 'ready')
  ) THEN
    RAISE EXCEPTION 'activity time cutover has unfinished posting batches'
      USING ERRCODE = '23514', CONSTRAINT = 'atcr_open_batch_guard';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "ActivityBatchJob"
    WHERE "jobTypeCode" = 'settlement_prepare'
      AND "statusCode" IN ('pending', 'processing')
  ) THEN
    RAISE EXCEPTION 'activity time cutover has unfinished settlement prepare jobs'
      USING ERRCODE = '23514', CONSTRAINT = 'atcr_open_job_guard';
  END IF;

  -- Neither caller-supplied field is trusted.  Millisecond precision matches
  -- the column and the JavaScript ISO verifier exactly.
  NEW."cutoverAt" := date_trunc('milliseconds', clock_timestamp());
  NEW."formatVersion" := 1;
  canonical_payload := atcr_content_payload(
    NEW."id", NEW."operationKey", NEW."requestHash", NEW."deployedMainSha",
    NEW."evidenceBundleHash", NEW."actorUserId", NEW."cutoverAt", NEW."formatVersion"
  );
  NEW."contentHash" := encode(sha256(convert_to(canonical_payload, 'UTF8')), 'hex');
  RETURN NEW;
END;
$$;

CREATE TRIGGER atcr_insert_guard
BEFORE INSERT ON "ActivityTimeCutoverReceipt"
FOR EACH ROW EXECUTE FUNCTION atcr_prepare_insert();

CREATE FUNCTION atc_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'activity time cutover facts are immutable'
    USING ERRCODE = '23514', CONSTRAINT = TG_NAME;
END;
$$;

CREATE TRIGGER atcr_immutable
BEFORE UPDATE OR DELETE ON "ActivityTimeCutoverReceipt"
FOR EACH ROW EXECUTE FUNCTION atc_reject_mutation();
CREATE TRIGGER atcr_no_truncate
BEFORE TRUNCATE ON "ActivityTimeCutoverReceipt"
FOR EACH STATEMENT EXECUTE FUNCTION atc_reject_mutation();
CREATE TRIGGER ptcb_immutable
BEFORE UPDATE OR DELETE ON "ParticipationTimeCutoverBinding"
FOR EACH ROW EXECUTE FUNCTION atc_reject_mutation();
CREATE TRIGGER ptcb_no_truncate
BEFORE TRUNCATE ON "ParticipationTimeCutoverBinding"
FOR EACH STATEMENT EXECUTE FUNCTION atc_reject_mutation();

-- Bindings may only be born inside the LedgerPostingBatch commit trigger.  A
-- later direct INSERT would retroactively reclassify a legacy root, so even a
-- perfectly shaped row is rejected outside a nested trigger invocation.
CREATE FUNCTION ptcb_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'cutover bindings are created only by the posting commit guard'
      USING ERRCODE = '23514', CONSTRAINT = 'ptcb_insert_origin_guard';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "ActivityTimeCutoverReceipt" receipt
    JOIN "ParticipationTimeLedgerManifest" root
      ON root.id = NEW."rootManifestId"
      AND root."postingBatchId" = NEW."postingBatchId"
      AND root."activityId" = NEW."activityId"
      AND root."settlementRunId" = NEW."settlementRunId"
      AND root."settlementVersionId" = NEW."settlementVersionId"
      AND root."contentHash" = NEW."rootContentHash"
    JOIN "LedgerPostingBatch" batch
      ON batch.id = root."postingBatchId" AND batch."statusCode" = 'committed'
    WHERE receipt.id = NEW."cutoverReceiptId"
      AND receipt."formatVersion" = NEW."formatVersion"
      AND NOT EXISTS (
        SELECT 1 FROM "ParticipationTimeCorrectionManifest" correction
        WHERE correction."postingBatchId" = batch.id
      )
  ) THEN
    RAISE EXCEPTION 'cutover binding anchors are incomplete or inconsistent'
      USING ERRCODE = '23514', CONSTRAINT = 'ptcb_anchor_guard';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ptcb_insert_guard
BEFORE INSERT ON "ParticipationTimeCutoverBinding"
FOR EACH ROW EXECUTE FUNCTION ptcb_insert_guard();

CREATE FUNCTION atc_bind_committed_root() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  receipt "ActivityTimeCutoverReceipt"%ROWTYPE;
  root "ParticipationTimeLedgerManifest"%ROWTYPE;
BEGIN
  IF NEW."statusCode" <> 'committed'
     OR (TG_OP = 'UPDATE' AND OLD."statusCode" = 'committed') THEN
    RETURN NEW;
  END IF;

  SELECT * INTO receipt FROM "ActivityTimeCutoverReceipt" LIMIT 1;
  IF NOT FOUND THEN RETURN NEW; END IF;

  -- A correction inherits the root's regime and must never receive another
  -- binding for its own posting batch.
  IF EXISTS (
    SELECT 1 FROM "ParticipationTimeCorrectionManifest"
    WHERE "postingBatchId" = NEW.id
  ) THEN
    RETURN NEW;
  END IF;

  SELECT * INTO root
  FROM "ParticipationTimeLedgerManifest"
  WHERE "postingBatchId" = NEW.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'post-cutover ordinary batch has no classified root manifest'
      USING ERRCODE = '23514', CONSTRAINT = 'atc_post_cutover_manifest_guard';
  END IF;

  INSERT INTO "ParticipationTimeCutoverBinding" (
    "id", "cutoverReceiptId", "rootManifestId", "postingBatchId",
    "activityId", "settlementRunId", "settlementVersionId",
    "rootContentHash", "formatVersion"
  ) VALUES (
    'ptcb:' || root.id, receipt.id, root.id, root."postingBatchId",
    root."activityId", root."settlementRunId", root."settlementVersionId",
    root."contentHash", receipt."formatVersion"
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER atc_bind_committed_root
AFTER INSERT OR UPDATE OF "statusCode" ON "LedgerPostingBatch"
FOR EACH ROW EXECUTE FUNCTION atc_bind_committed_root();

COMMIT;
