-- C1 D1 additive catalogue foundation. Three EMPTY tables; no seed, backfill or existing DML.
-- Rollback: stop new catalogue consumers and run the previous application, retaining these tables.
-- Never DROP populated versions to roll back. Production deploy is separately approved.
-- DB validates shape/lifecycle/references; canonical/hash recomputation belongs to the future writer.
BEGIN;

CREATE TABLE "ActivityMetricDefinition" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "kindCode" TEXT NOT NULL,
  "unit" TEXT,
  "configurationJson" JSONB NOT NULL,
  "schemaVersion" INTEGER NOT NULL,
  "definitionHash" TEXT NOT NULL,
  "statusCode" TEXT NOT NULL,
  "activatedAt" TIMESTAMP(3),
  "retiredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ActivityMetricDefinition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "activity_metric_definition_shape_check" CHECK (
    "code" ~ '^[a-z][a-z0-9_]{0,63}$' AND "version" > 0 AND "schemaVersion" = 1
    AND char_length("name") BETWEEN 1 AND 100 AND "name" = btrim("name")
    AND "definitionHash" ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof("configurationJson") = 'object'
    AND "kindCode" IN ('non_negative_integer','non_negative_decimal','boolean','short_text','single_choice')
    AND CASE WHEN "kindCode" IN ('non_negative_integer','non_negative_decimal')
      THEN "unit" IS NOT NULL AND char_length("unit") BETWEEN 1 AND 32 AND "unit" = btrim("unit")
      ELSE "unit" IS NULL END
  ),
  CONSTRAINT "activity_metric_definition_lifecycle_check" CHECK (
    ("statusCode" = 'draft' AND "activatedAt" IS NULL AND "retiredAt" IS NULL)
    OR ("statusCode" = 'active' AND "activatedAt" IS NOT NULL AND "retiredAt" IS NULL)
    OR ("statusCode" = 'retired' AND "activatedAt" IS NOT NULL AND "retiredAt" IS NOT NULL AND "retiredAt" >= "activatedAt")
  )
);

CREATE TABLE "ActivityMetricSetVersion" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "schemaVersion" INTEGER NOT NULL,
  "definitionHash" TEXT NOT NULL,
  "statusCode" TEXT NOT NULL,
  "activatedAt" TIMESTAMP(3),
  "retiredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ActivityMetricSetVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "activity_metric_set_shape_check" CHECK (
    "code" ~ '^[a-z][a-z0-9_]{0,63}$' AND "version" > 0 AND "schemaVersion" = 1
    AND char_length("name") BETWEEN 1 AND 100 AND "name" = btrim("name")
    AND "definitionHash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "activity_metric_set_lifecycle_check" CHECK (
    ("statusCode" = 'draft' AND "activatedAt" IS NULL AND "retiredAt" IS NULL)
    OR ("statusCode" = 'active' AND "activatedAt" IS NOT NULL AND "retiredAt" IS NULL)
    OR ("statusCode" = 'retired' AND "activatedAt" IS NOT NULL AND "retiredAt" IS NOT NULL AND "retiredAt" >= "activatedAt")
  )
);

CREATE TABLE "ActivityMetricSetItem" (
  "id" TEXT NOT NULL,
  "setVersionId" TEXT NOT NULL,
  "metricDefinitionId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL,
  "required" BOOLEAN NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ActivityMetricSetItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "activity_metric_set_item_shape_check" CHECK (
    "key" ~ '^[a-z][a-z0-9_]{0,63}$' AND "sortOrder" BETWEEN 0 AND 99
  ),
  CONSTRAINT "ActivityMetricSetItem_setVersionId_fkey" FOREIGN KEY ("setVersionId")
    REFERENCES "ActivityMetricSetVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ActivityMetricSetItem_metricDefinitionId_fkey" FOREIGN KEY ("metricDefinitionId")
    REFERENCES "ActivityMetricDefinition"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "ActivityMetricDefinition_code_version_key" ON "ActivityMetricDefinition"("code", "version");
CREATE INDEX "ActivityMetricDefinition_statusCode_idx" ON "ActivityMetricDefinition"("statusCode");
CREATE UNIQUE INDEX "ActivityMetricSetVersion_code_version_key" ON "ActivityMetricSetVersion"("code", "version");
CREATE INDEX "ActivityMetricSetVersion_statusCode_idx" ON "ActivityMetricSetVersion"("statusCode");
CREATE UNIQUE INDEX "ActivityMetricSetItem_setVersionId_key_key" ON "ActivityMetricSetItem"("setVersionId", "key");
CREATE UNIQUE INDEX "ActivityMetricSetItem_setVersionId_metricDefinitionId_key" ON "ActivityMetricSetItem"("setVersionId", "metricDefinitionId");
CREATE UNIQUE INDEX "ActivityMetricSetItem_setVersionId_sortOrder_key" ON "ActivityMetricSetItem"("setVersionId", "sortOrder");
CREATE INDEX "ActivityMetricSetItem_metricDefinitionId_idx" ON "ActivityMetricSetItem"("metricDefinitionId");

CREATE FUNCTION activity_metric_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'metric versions cannot be deleted' USING ERRCODE = '23514', CONSTRAINT = 'activity_metric_version_frozen';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."statusCode" <> 'draft' THEN
      RAISE EXCEPTION 'metric versions must start as draft' USING ERRCODE = '23514', CONSTRAINT = 'activity_metric_version_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW."id", NEW."code", NEW."version", NEW."createdAt") IS DISTINCT FROM
     ROW(OLD."id", OLD."code", OLD."version", OLD."createdAt") THEN
    RAISE EXCEPTION 'metric identity cannot change' USING ERRCODE = '23514', CONSTRAINT = 'activity_metric_version_identity';
  END IF;
  IF NOT (NEW."statusCode" = OLD."statusCode"
    OR (OLD."statusCode" = 'draft' AND NEW."statusCode" = 'active')
    OR (OLD."statusCode" = 'active' AND NEW."statusCode" = 'retired')) THEN
    RAISE EXCEPTION 'invalid metric transition' USING ERRCODE = '23514', CONSTRAINT = 'activity_metric_version_transition';
  END IF;
  IF OLD."statusCode" <> 'draft' AND (
    (to_jsonb(NEW) - ARRAY['statusCode','retiredAt','updatedAt']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['statusCode','retiredAt','updatedAt'])
    OR (OLD."statusCode" = 'retired' AND NEW."retiredAt" IS DISTINCT FROM OLD."retiredAt")
  ) THEN
    RAISE EXCEPTION 'activated metric semantics are frozen' USING ERRCODE = '23514', CONSTRAINT = 'activity_metric_version_frozen';
  END IF;
  IF TG_TABLE_NAME = 'ActivityMetricSetVersion' AND OLD."statusCode" = 'draft' AND NEW."statusCode" = 'active' THEN
    -- The UPDATE already owns the set row. Item mutations also write this row, so they cannot
    -- slip into activation; their tuple write forces RR/SERIALIZABLE stale readers to abort.
    PERFORM d."id" FROM "ActivityMetricDefinition" d
      JOIN "ActivityMetricSetItem" i ON i."metricDefinitionId" = d."id"
      WHERE i."setVersionId" = NEW."id" ORDER BY d."id" FOR SHARE OF d;
    IF NOT EXISTS (SELECT 1 FROM "ActivityMetricSetItem" WHERE "setVersionId" = NEW."id")
      OR EXISTS (SELECT 1 FROM "ActivityMetricSetItem" i JOIN "ActivityMetricDefinition" d ON d."id" = i."metricDefinitionId"
        WHERE i."setVersionId" = NEW."id" AND d."statusCode" <> 'active') THEN
      RAISE EXCEPTION 'metric set requires active definitions' USING ERRCODE = '23514', CONSTRAINT = 'activity_metric_set_activation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER activity_metric_definition_guard BEFORE INSERT OR UPDATE OR DELETE ON "ActivityMetricDefinition"
  FOR EACH ROW EXECUTE FUNCTION activity_metric_version_guard();
CREATE TRIGGER activity_metric_set_version_guard BEFORE INSERT OR UPDATE OR DELETE ON "ActivityMetricSetVersion"
  FOR EACH ROW EXECUTE FUNCTION activity_metric_version_guard();

CREATE FUNCTION activity_metric_set_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_id TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW."id", NEW."setVersionId", NEW."createdAt") IS DISTINCT FROM
    ROW(OLD."id", OLD."setVersionId", OLD."createdAt") THEN
    RAISE EXCEPTION 'metric set item cannot move or change identity' USING ERRCODE = '23514', CONSTRAINT = 'activity_metric_set_item_identity';
  END IF;
  IF TG_OP = 'DELETE' THEN parent_id := OLD."setVersionId"; ELSE parent_id := NEW."setVersionId"; END IF;
  UPDATE "ActivityMetricSetVersion" SET "updatedAt" = clock_timestamp()
    WHERE "id" = parent_id AND "statusCode" = 'draft';
  IF NOT FOUND THEN
    IF NOT EXISTS (SELECT 1 FROM "ActivityMetricSetVersion" WHERE "id" = parent_id) THEN
      RAISE EXCEPTION 'missing metric set' USING ERRCODE = '23503', CONSTRAINT = 'ActivityMetricSetItem_setVersionId_fkey';
    END IF;
    RAISE EXCEPTION 'activated set items are frozen' USING ERRCODE = '23514', CONSTRAINT = 'activity_metric_set_item_frozen';
  END IF;
  IF TG_OP = 'INSERT' AND (SELECT count(*) FROM "ActivityMetricSetItem" WHERE "setVersionId" = parent_id) >= 100 THEN
    RAISE EXCEPTION 'metric set exceeds 100 items' USING ERRCODE = '23514', CONSTRAINT = 'activity_metric_set_item_limit';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER activity_metric_set_item_guard BEFORE INSERT OR UPDATE OR DELETE ON "ActivityMetricSetItem"
  FOR EACH ROW EXECUTE FUNCTION activity_metric_set_item_guard();

COMMIT;
