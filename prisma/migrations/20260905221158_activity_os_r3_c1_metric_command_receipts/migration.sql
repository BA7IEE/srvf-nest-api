-- C1 D2a: additive catalogue command receipts; no catalogue seed or existing-row rewrite.
CREATE TABLE "ActivityMetricCommandReceipt" (
  "id" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "operationCode" TEXT NOT NULL,
  "operationKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "resultJson" JSONB NOT NULL,
  "definitionId" TEXT,
  "setVersionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ActivityMetricCommandReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "activity_metric_receipt_actor_fk" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "activity_metric_receipt_definition_fk" FOREIGN KEY ("definitionId") REFERENCES "ActivityMetricDefinition"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "activity_metric_receipt_set_fk" FOREIGN KEY ("setVersionId") REFERENCES "ActivityMetricSetVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "activity_metric_receipt_target_check" CHECK (
    ("operationCode" IN ('create_definition', 'update_definition', 'activate_definition', 'retire_definition') AND "definitionId" IS NOT NULL AND "setVersionId" IS NULL)
    OR
    ("operationCode" IN ('create_set', 'update_set', 'activate_set', 'retire_set') AND "setVersionId" IS NOT NULL AND "definitionId" IS NULL)
  ),
  CONSTRAINT "activity_metric_receipt_key_check" CHECK (
    length("operationKey") BETWEEN 1 AND 128 AND "operationKey" = btrim("operationKey")
  ),
  CONSTRAINT "activity_metric_receipt_hash_check" CHECK ("requestHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "activity_metric_receipt_result_check" CHECK ((
    jsonb_typeof("resultJson") = 'object'
    AND "resultJson" ?& ARRAY['id','code','version','schemaVersion','statusCode','definitionHash']
    AND "resultJson" - ARRAY['id','code','version','schemaVersion','statusCode','definitionHash'] = '{}'::jsonb
    AND jsonb_typeof("resultJson"->'id') = 'string'
    AND "resultJson"->>'id' = COALESCE("definitionId", "setVersionId")
    AND jsonb_typeof("resultJson"->'code') = 'string'
    AND "resultJson"->>'code' ~ '^[a-z][a-z0-9_]{0,63}$'
    AND jsonb_typeof("resultJson"->'version') = 'number'
    AND "resultJson"->>'version' ~ '^[1-9][0-9]*$'
    AND "resultJson"->'schemaVersion' = '1'::jsonb
    AND "resultJson"->>'statusCode' = CASE
      WHEN "operationCode" IN ('activate_definition','activate_set') THEN 'active'
      WHEN "operationCode" IN ('retire_definition','retire_set') THEN 'retired'
      ELSE 'draft' END
    AND jsonb_typeof("resultJson"->'definitionHash') = 'string'
    AND "resultJson"->>'definitionHash' ~ '^[0-9a-f]{64}$'
  ) IS TRUE)
);

CREATE UNIQUE INDEX "activity_metric_receipt_command_key" ON "ActivityMetricCommandReceipt"("actorUserId", "operationCode", "operationKey");
CREATE INDEX "activity_metric_receipt_definition_idx" ON "ActivityMetricCommandReceipt"("definitionId");
CREATE INDEX "activity_metric_receipt_set_idx" ON "ActivityMetricCommandReceipt"("setVersionId");

CREATE FUNCTION activity_metric_receipt_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'activity metric command receipts are append-only'
    USING ERRCODE = '23514', CONSTRAINT = 'activity_metric_receipt_append_only';
END;
$$;

CREATE TRIGGER activity_metric_receipt_append_only
BEFORE UPDATE OR DELETE ON "ActivityMetricCommandReceipt"
FOR EACH ROW EXECUTE FUNCTION activity_metric_receipt_append_only();
