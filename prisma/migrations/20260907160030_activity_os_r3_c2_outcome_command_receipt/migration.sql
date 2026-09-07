-- C2 D2: additive manual outcome receipts. No backfill, old receipt or outcome rewrite.
BEGIN;
CREATE TABLE "ActivityOutcomeCommandReceipt" (
  "id" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "operationCode" TEXT NOT NULL,
  "operationKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "outcomeRevisionId" TEXT NOT NULL,
  "resultJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ActivityOutcomeCommandReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "activity_outcome_receipt_actor_fk" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "activity_outcome_receipt_activity_fk" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "activity_outcome_receipt_outcome_fk" FOREIGN KEY ("outcomeRevisionId", "activityId") REFERENCES "ActivityOutcomeRevision"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "activity_outcome_receipt_operation_check" CHECK ("operationCode" = 'record_manual_outcome'),
  CONSTRAINT "activity_outcome_receipt_key_check" CHECK (length("operationKey") BETWEEN 1 AND 128 AND "operationKey" = btrim("operationKey")),
  CONSTRAINT "activity_outcome_receipt_hash_check" CHECK ("requestHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "activity_outcome_receipt_result_check" CHECK ((
    jsonb_typeof("resultJson") = 'object'
    AND "resultJson" ?& ARRAY['schemaVersion','activityId','outcomeRevisionId','revision','metricSetVersionId','metricSetDefinitionHash','createdStatusCode','sourceCode','valueCount','evidenceCount','createdAt']
    AND "resultJson" - ARRAY['schemaVersion','activityId','outcomeRevisionId','revision','metricSetVersionId','metricSetDefinitionHash','createdStatusCode','sourceCode','valueCount','evidenceCount','createdAt'] = '{}'::jsonb
    AND "resultJson"->'schemaVersion' = '1'::jsonb
    AND jsonb_typeof("resultJson"->'activityId') = 'string'
    AND "resultJson"->>'activityId' = "activityId"
    AND jsonb_typeof("resultJson"->'outcomeRevisionId') = 'string'
    AND "resultJson"->>'outcomeRevisionId' = "outcomeRevisionId"
    AND jsonb_typeof("resultJson"->'metricSetVersionId') = 'string'
    AND length("resultJson"->>'metricSetVersionId') BETWEEN 1 AND 64
    AND jsonb_typeof("resultJson"->'metricSetDefinitionHash') = 'string'
    AND "resultJson"->>'metricSetDefinitionHash' ~ '^[0-9a-f]{64}$'
    AND "resultJson"->'createdStatusCode' = '"draft"'::jsonb
    AND "resultJson"->'sourceCode' = '"manual"'::jsonb
    AND jsonb_typeof("resultJson"->'revision') = 'number'
    AND "resultJson"->>'revision' ~ '^[1-9][0-9]{0,9}$'
    AND jsonb_typeof("resultJson"->'valueCount') = 'number'
    AND "resultJson"->>'valueCount' ~ '^[1-9][0-9]{0,2}$'
    AND jsonb_typeof("resultJson"->'evidenceCount') = 'number'
    AND "resultJson"->>'evidenceCount' ~ '^(0|[1-9][0-9]{0,3})$'
    AND jsonb_typeof("resultJson"->'createdAt') = 'string'
    AND "resultJson"->>'createdAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  ) IS TRUE)
);
CREATE UNIQUE INDEX "activity_outcome_receipt_command_key" ON "ActivityOutcomeCommandReceipt"("actorUserId", "operationCode", "operationKey");
CREATE INDEX "activity_outcome_receipt_activity_idx" ON "ActivityOutcomeCommandReceipt"("activityId");
CREATE INDEX "activity_outcome_receipt_outcome_idx" ON "ActivityOutcomeCommandReceipt"("outcomeRevisionId", "activityId");

-- Validate numeric bounds and exact persisted creation facts independently of JSON CHECK order.
CREATE FUNCTION activity_outcome_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE outcome "ActivityOutcomeRevision"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'outcome receipts are append-only';
  END IF;
  SELECT * INTO outcome FROM "ActivityOutcomeRevision"
    WHERE id = NEW."outcomeRevisionId" AND "activityId" = NEW."activityId";
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'outcome receipt target unavailable';
  END IF;
  IF (
    NEW."resultJson"->'revision' = to_jsonb(outcome.revision)
    AND NEW."resultJson"->>'metricSetVersionId' = outcome."metricSetVersionId"
    AND NEW."resultJson"->>'metricSetDefinitionHash' = outcome."metricSetDefinitionHash"
    AND NEW."resultJson"->>'createdAt' = to_char(outcome."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    AND NEW."actorUserId" = outcome."createdByUserId"
    AND NEW."resultJson"->'valueCount' = to_jsonb((SELECT count(*) FROM "ActivityMetricValueRevision" WHERE "outcomeRevisionId" = outcome.id))
    AND NEW."resultJson"->'evidenceCount' = to_jsonb((SELECT count(*) FROM "ActivityMetricValueEvidence" WHERE "outcomeRevisionId" = outcome.id))
    AND (SELECT count(*) FROM "ActivityMetricValueRevision" WHERE "outcomeRevisionId" = outcome.id) BETWEEN 1 AND 100
    AND NOT EXISTS (SELECT 1 FROM "ActivityMetricValueRevision" v WHERE v."outcomeRevisionId" = outcome.id AND
      (v."sourceCode" <> 'manual' OR v."confirmedByUserId" IS NOT NULL OR v."confirmedAt" IS NOT NULL OR
       (SELECT count(*) FROM "ActivityMetricValueEvidence" e WHERE e."valueRevisionId" = v.id) > 20))
    AND outcome."statusCode" = 'draft'
  ) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'outcome receipt creation facts mismatch';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER activity_outcome_receipt_check
BEFORE INSERT OR UPDATE OR DELETE ON "ActivityOutcomeCommandReceipt"
FOR EACH ROW EXECUTE FUNCTION activity_outcome_receipt_guard();
COMMIT;
