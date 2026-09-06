-- C1 D2b: additive selection and typed receipts. No UPDATE, backfill or historical SQL changes.
BEGIN;

ALTER TABLE "Activity"
  ADD COLUMN "metricRequirementCode" TEXT,
  ADD COLUMN "selectedMetricSetVersionId" TEXT,
  ADD COLUMN "selectedMetricSetDefinitionHash" TEXT,
  ADD COLUMN "metricSelectionRevision" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "activity_metric_set_id_hash_key"
  ON "ActivityMetricSetVersion"("id", "definitionHash");
CREATE INDEX "activity_selected_metric_set_idx"
  ON "Activity"("selectedMetricSetVersionId", "selectedMetricSetDefinitionHash");
ALTER TABLE "Activity"
  ADD CONSTRAINT "activity_selected_metric_set_fk"
    FOREIGN KEY ("selectedMetricSetVersionId", "selectedMetricSetDefinitionHash")
    REFERENCES "ActivityMetricSetVersion"("id", "definitionHash") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "activity_metric_selection_shape_check" CHECK ((
    ("metricRequirementCode" IS NULL AND "selectedMetricSetVersionId" IS NULL
      AND "selectedMetricSetDefinitionHash" IS NULL AND "metricSelectionRevision" = 0)
    OR ("metricRequirementCode" = 'not_required' AND "selectedMetricSetVersionId" IS NULL
      AND "selectedMetricSetDefinitionHash" IS NULL AND "metricSelectionRevision" >= 1)
    OR ("metricRequirementCode" = 'required' AND "selectedMetricSetVersionId" IS NOT NULL
      AND "selectedMetricSetDefinitionHash" ~ '^[0-9a-f]{64}$' AND "metricSelectionRevision" >= 1)
  ) IS TRUE);

ALTER TABLE "ActivityMetricCommandReceipt"
  ADD COLUMN "templateVersionId" TEXT,
  ADD COLUMN "activityId" TEXT,
  ADD CONSTRAINT "activity_metric_receipt_template_fk" FOREIGN KEY ("templateVersionId")
    REFERENCES "ActivityTemplate"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "activity_metric_receipt_activity_fk" FOREIGN KEY ("activityId")
    REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX "activity_metric_receipt_template_idx" ON "ActivityMetricCommandReceipt"("templateVersionId");
CREATE INDEX "activity_metric_receipt_activity_idx" ON "ActivityMetricCommandReceipt"("activityId");

ALTER TABLE "ActivityMetricCommandReceipt"
  DROP CONSTRAINT "activity_metric_receipt_target_check",
  DROP CONSTRAINT "activity_metric_receipt_result_check",
  ADD CONSTRAINT "activity_metric_receipt_target_check" CHECK ((
    ("templateVersionId" IS NULL AND "activityId" IS NULL AND (
      ("operationCode" IN ('create_definition', 'update_definition', 'activate_definition', 'retire_definition') AND "definitionId" IS NOT NULL AND "setVersionId" IS NULL)
      OR
      ("operationCode" IN ('create_set', 'update_set', 'activate_set', 'retire_set') AND "setVersionId" IS NOT NULL AND "definitionId" IS NULL)
    ))
    OR ("operationCode" IN ('create_template_version','update_template_version','activate_template_version','retire_template_version')
      AND "templateVersionId" IS NOT NULL AND "activityId" IS NULL AND "definitionId" IS NULL AND "setVersionId" IS NULL)
    OR ("operationCode" = 'select_metric_set' AND "activityId" IS NOT NULL
      AND "templateVersionId" IS NULL AND "definitionId" IS NULL AND "setVersionId" IS NULL)
  ) IS TRUE),
  ADD CONSTRAINT "activity_metric_receipt_result_check" CHECK ((
    -- The complete D2a six-field predicate remains exclusive to its original eight operations.
    ("operationCode" IN ('create_definition','update_definition','activate_definition','retire_definition',
      'create_set','update_set','activate_set','retire_set') AND (
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
    ))
    OR ("operationCode" IN ('create_template_version','update_template_version','activate_template_version','retire_template_version') AND (
      jsonb_typeof("resultJson") = 'object'
      AND "resultJson" ?& ARRAY['id','code','version','schemaVersion','statusCode','definitionHash']
      AND "resultJson" - ARRAY['id','code','version','schemaVersion','statusCode','definitionHash'] = '{}'::jsonb
      AND jsonb_typeof("resultJson"->'id') = 'string' AND "resultJson"->>'id' = "templateVersionId"
      AND jsonb_typeof("resultJson"->'code') = 'string'
      AND length("resultJson"->>'code') BETWEEN 1 AND 64
      AND "resultJson"->>'code' = btrim("resultJson"->>'code')
      AND jsonb_typeof("resultJson"->'version') = 'number'
      AND "resultJson"->>'version' ~ '^[1-9][0-9]*$'
      AND "resultJson"->'version' <= '2147483647'::jsonb
      AND "resultJson"->'schemaVersion' = '3'::jsonb
      AND jsonb_typeof("resultJson"->'statusCode') = 'string'
      AND "resultJson"->>'statusCode' = CASE
        WHEN "operationCode" = 'activate_template_version' THEN 'active'
        WHEN "operationCode" = 'retire_template_version' THEN 'retired' ELSE 'draft' END
      AND jsonb_typeof("resultJson"->'definitionHash') = 'string'
      AND "resultJson"->>'definitionHash' ~ '^[0-9a-f]{64}$'
    ))
    OR ("operationCode" = 'select_metric_set' AND (
      jsonb_typeof("resultJson") = 'object'
      AND "resultJson" ?& ARRAY['activityId','metricRequirementCode','metricSetPointer','metricSelectionRevision']
      AND "resultJson" - ARRAY['activityId','metricRequirementCode','metricSetPointer','metricSelectionRevision'] = '{}'::jsonb
      AND jsonb_typeof("resultJson"->'activityId') = 'string' AND "resultJson"->>'activityId' = "activityId"
      AND jsonb_typeof("resultJson"->'metricSelectionRevision') = 'number'
      AND "resultJson"->>'metricSelectionRevision' ~ '^[1-9][0-9]*$'
      AND "resultJson"->'metricSelectionRevision' <= '2147483647'::jsonb
      AND jsonb_typeof("resultJson"->'metricRequirementCode') = 'string'
      AND (
        ("resultJson"->>'metricRequirementCode' = 'not_required' AND "resultJson"->'metricSetPointer' = 'null'::jsonb)
        OR ("resultJson"->>'metricRequirementCode' = 'required'
          AND jsonb_typeof("resultJson"->'metricSetPointer') = 'object'
          AND ("resultJson"->'metricSetPointer') ?& ARRAY['id','code','version','schemaVersion','definitionHash']
          AND ("resultJson"->'metricSetPointer') - ARRAY['id','code','version','schemaVersion','definitionHash'] = '{}'::jsonb
          AND jsonb_typeof("resultJson"#>'{metricSetPointer,id}') = 'string'
          AND length("resultJson"#>>'{metricSetPointer,id}') BETWEEN 1 AND 64
          AND "resultJson"#>>'{metricSetPointer,id}' = btrim("resultJson"#>>'{metricSetPointer,id}')
          AND jsonb_typeof("resultJson"#>'{metricSetPointer,code}') = 'string'
          AND "resultJson"#>>'{metricSetPointer,code}' ~ '^[a-z][a-z0-9_]{0,63}$'
          AND jsonb_typeof("resultJson"#>'{metricSetPointer,version}') = 'number'
          AND "resultJson"#>>'{metricSetPointer,version}' ~ '^[1-9][0-9]*$'
          AND "resultJson"#>'{metricSetPointer,version}' <= '2147483647'::jsonb
          AND "resultJson"#>'{metricSetPointer,schemaVersion}' = '1'::jsonb
          AND jsonb_typeof("resultJson"#>'{metricSetPointer,definitionHash}') = 'string'
          AND "resultJson"#>>'{metricSetPointer,definitionHash}' ~ '^[0-9a-f]{64}$')
      )
    ))
  ) IS TRUE);

COMMIT;
