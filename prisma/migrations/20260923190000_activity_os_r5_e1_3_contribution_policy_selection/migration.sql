-- Activity OS R5 / E1-3: immutable three-layer contribution-policy selection.
--
-- Additive DDL only: three empty retention tables, nullable/current pointers, exact anchors and
-- fail-closed guards. No historical row is backfilled, converted, deleted or reinterpreted.
BEGIN;

ALTER TABLE "Activity"
  ADD COLUMN "contributionPolicySelectionRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "currentContributionPolicySelectionRevisionId" TEXT;

ALTER TABLE "ActivityRuleSnapshot"
  ADD COLUMN "contributionPolicySelectionRevisionId" TEXT;

CREATE TABLE "ActivityContributionPolicySelectionRevision" (
  "id" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "selectionHash" TEXT NOT NULL,
  "selectionJson" JSONB NOT NULL,
  "itemCount" INTEGER NOT NULL,
  "templateId" TEXT,
  "templateDefinitionHash" TEXT,
  "originCode" TEXT NOT NULL,
  "creationReceiptId" TEXT,
  "seriesOccurrenceId" TEXT,
  "publishReviewId" TEXT,
  "proposalSelectionHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdByUserId" TEXT NOT NULL,
  CONSTRAINT "ActivityContributionPolicySelectionRevision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ActivityContributionPolicySelectionItem" (
  "id" TEXT NOT NULL,
  "selectionRevisionId" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "layerCode" TEXT NOT NULL,
  "sessionId" TEXT,
  "positionId" TEXT,
  "mode" TEXT NOT NULL,
  "policyId" TEXT,
  "versionId" TEXT,
  "definitionHash" TEXT,
  "evaluatorVersion" INTEGER,
  CONSTRAINT "ActivityContributionPolicySelectionItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ActivityContributionPolicySelectionCommandReceipt" (
  "id" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "operationCode" TEXT NOT NULL,
  "operationKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "selectionRevisionId" TEXT NOT NULL,
  "resultJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ActivityContributionPolicySelectionCommandReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "acps_revision_activity_revision_key"
  ON "ActivityContributionPolicySelectionRevision"("activityId", "revision");
CREATE UNIQUE INDEX "acps_revision_id_activity_key"
  ON "ActivityContributionPolicySelectionRevision"("id", "activityId");
CREATE UNIQUE INDEX "acps_revision_id_activity_revision_key"
  ON "ActivityContributionPolicySelectionRevision"("id", "activityId", "revision");
CREATE INDEX "acps_revision_activity_created_idx"
  ON "ActivityContributionPolicySelectionRevision"("activityId", "createdAt");
CREATE INDEX "acps_revision_template_idx"
  ON "ActivityContributionPolicySelectionRevision"("templateId");
CREATE INDEX "acps_revision_review_idx"
  ON "ActivityContributionPolicySelectionRevision"("publishReviewId");

CREATE UNIQUE INDEX "acps_item_activity_key"
  ON "ActivityContributionPolicySelectionItem"("selectionRevisionId")
  WHERE "layerCode" = 'activity';
CREATE UNIQUE INDEX "acps_item_position_key"
  ON "ActivityContributionPolicySelectionItem"("selectionRevisionId", "sessionId", "positionId")
  WHERE "layerCode" = 'position';
CREATE INDEX "acps_item_revision_idx"
  ON "ActivityContributionPolicySelectionItem"("selectionRevisionId");
CREATE INDEX "acps_item_session_idx"
  ON "ActivityContributionPolicySelectionItem"("activityId", "sessionId");
CREATE INDEX "acps_item_version_idx"
  ON "ActivityContributionPolicySelectionItem"("versionId");

CREATE UNIQUE INDEX "acps_receipt_actor_operation_key"
  ON "ActivityContributionPolicySelectionCommandReceipt"("actorUserId", "operationCode", "operationKey");
CREATE UNIQUE INDEX "acps_receipt_revision_activity_key"
  ON "ActivityContributionPolicySelectionCommandReceipt"("selectionRevisionId", "activityId");
CREATE INDEX "acps_receipt_activity_created_idx"
  ON "ActivityContributionPolicySelectionCommandReceipt"("activityId", "createdAt");
CREATE INDEX "acps_activity_current_revision_idx"
  ON "Activity"("currentContributionPolicySelectionRevisionId");
CREATE INDEX "acps_snapshot_revision_idx"
  ON "ActivityRuleSnapshot"("contributionPolicySelectionRevisionId");

ALTER TABLE "ActivityContributionPolicySelectionRevision"
  ADD CONSTRAINT "ActivityContributionPolicySelectionRevision_activityId_fkey"
    FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ActivityContributionPolicySelectionRevision_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "acps_revision_template_fkey"
    FOREIGN KEY ("templateId", "templateDefinitionHash")
    REFERENCES "ActivityTemplate"("id", "definitionHash") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "acps_revision_creation_fkey"
    FOREIGN KEY ("creationReceiptId", "activityId")
    REFERENCES "ActivityCreationCommandReceipt"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "acps_revision_occurrence_fkey"
    FOREIGN KEY ("seriesOccurrenceId", "activityId")
    REFERENCES "ActivitySeriesOccurrence"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "acps_revision_review_fkey"
    FOREIGN KEY ("publishReviewId", "activityId")
    REFERENCES "activity_publish_reviews"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "Activity"
  ADD CONSTRAINT "acps_current_revision_fkey"
    FOREIGN KEY ("currentContributionPolicySelectionRevisionId", "id", "contributionPolicySelectionRevision")
    REFERENCES "ActivityContributionPolicySelectionRevision"("id", "activityId", "revision")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ActivityContributionPolicySelectionItem"
  ADD CONSTRAINT "acps_item_revision_fkey"
    FOREIGN KEY ("selectionRevisionId", "activityId")
    REFERENCES "ActivityContributionPolicySelectionRevision"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "acps_item_position_fkey"
    FOREIGN KEY ("activityId", "sessionId", "positionId")
    REFERENCES "ActivitySessionPosition"("activityId", "sessionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "acps_item_policy_version_fkey"
    FOREIGN KEY ("versionId", "policyId", "definitionHash", "evaluatorVersion")
    REFERENCES "ContributionPolicyVersion"("id", "policyId", "definitionHash", "evaluatorVersion") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ActivityContributionPolicySelectionCommandReceipt"
  ADD CONSTRAINT "acps_receipt_actor_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "acps_receipt_activity_fkey"
    FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "acps_receipt_revision_fkey"
    FOREIGN KEY ("selectionRevisionId", "activityId")
    REFERENCES "ActivityContributionPolicySelectionRevision"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ActivityRuleSnapshot"
  ADD CONSTRAINT "acps_snapshot_revision_fkey"
    FOREIGN KEY ("contributionPolicySelectionRevisionId", "activityId")
    REFERENCES "ActivityContributionPolicySelectionRevision"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "Activity"
  ADD CONSTRAINT "acps_current_shape_check" CHECK ((
    ("contributionPolicySelectionRevision" = 0 AND "currentContributionPolicySelectionRevisionId" IS NULL)
    OR
    ("contributionPolicySelectionRevision" > 0 AND "currentContributionPolicySelectionRevisionId" IS NOT NULL)
  ) IS TRUE);

ALTER TABLE "ActivityContributionPolicySelectionRevision"
  ADD CONSTRAINT "acps_revision_shape_check" CHECK ((
    "revision" > 0
    AND "schemaVersion" = 1
    AND "selectionHash" ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof("selectionJson") = 'object'
    AND "selectionJson" ?& ARRAY['schemaVersion', 'items']
    AND "selectionJson" - ARRAY['schemaVersion', 'items'] = '{}'::jsonb
    AND "selectionJson"->'schemaVersion' = '1'::jsonb
    AND jsonb_typeof("selectionJson"->'items') = 'object'
    AND "itemCount" >= 1
    AND (
      ("templateId" IS NULL AND "templateDefinitionHash" IS NULL)
      OR
      ("templateId" IS NOT NULL AND "templateDefinitionHash" ~ '^[0-9a-f]{64}$')
    )
    AND (
      ("originCode" = 'select'
        AND "creationReceiptId" IS NULL AND "seriesOccurrenceId" IS NULL AND "publishReviewId" IS NULL
        AND "proposalSelectionHash" IS NULL)
      OR
      ("originCode" = 'creation_receipt'
        AND "creationReceiptId" IS NOT NULL AND "seriesOccurrenceId" IS NULL AND "publishReviewId" IS NULL
        AND "proposalSelectionHash" IS NULL)
      OR
      ("originCode" = 'template_creation'
        AND "creationReceiptId" IS NULL AND "seriesOccurrenceId" IS NULL AND "publishReviewId" IS NULL
        AND "proposalSelectionHash" IS NULL AND "templateId" IS NOT NULL AND "templateDefinitionHash" IS NOT NULL)
      OR
      ("originCode" = 'series_occurrence'
        AND "creationReceiptId" IS NULL AND "seriesOccurrenceId" IS NOT NULL AND "publishReviewId" IS NULL
        AND "proposalSelectionHash" IS NULL AND "templateId" IS NOT NULL AND "templateDefinitionHash" IS NOT NULL)
      OR
      ("originCode" = 'publish_review'
        AND "creationReceiptId" IS NULL AND "seriesOccurrenceId" IS NULL AND "publishReviewId" IS NOT NULL
        AND "proposalSelectionHash" ~ '^[0-9a-f]{64}$')
    )
  ) IS TRUE);

ALTER TABLE "ActivityContributionPolicySelectionItem"
  ADD CONSTRAINT "acps_item_shape_check" CHECK ((
    "layerCode" IN ('activity', 'position')
    AND (
      ("layerCode" = 'activity' AND "sessionId" IS NULL AND "positionId" IS NULL)
      OR
      ("layerCode" = 'position' AND "sessionId" IS NOT NULL AND "positionId" IS NOT NULL)
    )
    AND (
      ("mode" = 'inherit' AND "policyId" IS NULL AND "versionId" IS NULL
        AND "definitionHash" IS NULL AND "evaluatorVersion" IS NULL)
      OR
      ("mode" = 'explicit' AND "policyId" IS NOT NULL AND "versionId" IS NOT NULL
        AND "definitionHash" ~ '^[0-9a-f]{64}$' AND "evaluatorVersion" = 1)
    )
  ) IS TRUE);

ALTER TABLE "ActivityContributionPolicySelectionCommandReceipt"
  ADD CONSTRAINT "acps_receipt_shape_check" CHECK ((
    "operationCode" = 'patch_contribution_policy_selection'
    AND length("operationKey") BETWEEN 8 AND 128
    AND "operationKey" ~ '[^[:space:]]'
    AND "operationKey" !~ '[[:cntrl:]]'
    AND "requestHash" ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof("resultJson") = 'object'
    AND "resultJson" ?& ARRAY['activityId', 'selectionRevisionId', 'revision', 'selectionHash', 'createdAt']
    AND "resultJson" - ARRAY['activityId', 'selectionRevisionId', 'revision', 'selectionHash', 'createdAt'] = '{}'::jsonb
    AND jsonb_typeof("resultJson"->'activityId') = 'string'
    AND "resultJson"->>'activityId' = "activityId"
    AND jsonb_typeof("resultJson"->'selectionRevisionId') = 'string'
    AND "resultJson"->>'selectionRevisionId' = "selectionRevisionId"
    AND jsonb_typeof("resultJson"->'revision') = 'number'
    AND "resultJson"->>'revision' ~ '^[1-9][0-9]{0,9}$'
    AND jsonb_typeof("resultJson"->'selectionHash') = 'string'
    AND "resultJson"->>'selectionHash' ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof("resultJson"->'createdAt') = 'string'
    AND "resultJson"->>'createdAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  ) IS TRUE);

CREATE FUNCTION acps_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    CONSTRAINT = TG_NAME,
    MESSAGE = 'activity contribution-policy selection history is immutable';
END;
$$;

CREATE TRIGGER acps_revision_immutable
BEFORE UPDATE OR DELETE ON "ActivityContributionPolicySelectionRevision"
FOR EACH ROW EXECUTE FUNCTION acps_reject_mutation();
CREATE TRIGGER acps_item_immutable
BEFORE UPDATE OR DELETE ON "ActivityContributionPolicySelectionItem"
FOR EACH ROW EXECUTE FUNCTION acps_reject_mutation();
CREATE TRIGGER acps_receipt_immutable
BEFORE UPDATE OR DELETE ON "ActivityContributionPolicySelectionCommandReceipt"
FOR EACH ROW EXECUTE FUNCTION acps_reject_mutation();
CREATE TRIGGER acps_revision_no_truncate
BEFORE TRUNCATE ON "ActivityContributionPolicySelectionRevision"
FOR EACH STATEMENT EXECUTE FUNCTION acps_reject_mutation();
CREATE TRIGGER acps_item_no_truncate
BEFORE TRUNCATE ON "ActivityContributionPolicySelectionItem"
FOR EACH STATEMENT EXECUTE FUNCTION acps_reject_mutation();
CREATE TRIGGER acps_receipt_no_truncate
BEFORE TRUNCATE ON "ActivityContributionPolicySelectionCommandReceipt"
FOR EACH STATEMENT EXECUTE FUNCTION acps_reject_mutation();

CREATE FUNCTION acps_check_item_manifest() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  manifest_item JSONB;
  expected_item JSONB;
  scope_key TEXT;
BEGIN
  scope_key := NEW."layerCode" || ':' ||
    CASE WHEN NEW."sessionId" IS NULL THEN '-' ELSE replace(encode(convert_to(NEW."sessionId", 'UTF8'), 'base64'), E'\n', '') END || ':' ||
    CASE WHEN NEW."positionId" IS NULL THEN '-' ELSE replace(encode(convert_to(NEW."positionId", 'UTF8'), 'base64'), E'\n', '') END;

  SELECT revision."selectionJson"->'items'->scope_key
    INTO manifest_item
    FROM "ActivityContributionPolicySelectionRevision" revision
    WHERE revision.id = NEW."selectionRevisionId" AND revision."activityId" = NEW."activityId";

  expected_item := jsonb_build_object(
    'scope', jsonb_build_object(
      'layerCode', NEW."layerCode",
      'sessionId', COALESCE(to_jsonb(NEW."sessionId"), 'null'::jsonb),
      'positionId', COALESCE(to_jsonb(NEW."positionId"), 'null'::jsonb)
    ),
    'selection', jsonb_build_object(
      'mode', NEW."mode",
      'pointer', CASE WHEN NEW."mode" = 'inherit' THEN 'null'::jsonb ELSE jsonb_build_object(
        'policyId', NEW."policyId",
        'versionId', NEW."versionId",
        'definitionHash', NEW."definitionHash",
        'evaluatorVersion', NEW."evaluatorVersion"
      ) END
    )
  );

  IF manifest_item IS NULL OR manifest_item IS DISTINCT FROM expected_item THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'acps_item_manifest_guard',
      MESSAGE = 'selection item is absent from or differs from its immutable manifest';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER acps_item_manifest_guard
BEFORE INSERT ON "ActivityContributionPolicySelectionItem"
FOR EACH ROW EXECUTE FUNCTION acps_check_item_manifest();

CREATE FUNCTION acps_check_current_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (
    (OLD."contributionPolicySelectionRevision" = 0
      AND OLD."currentContributionPolicySelectionRevisionId" IS NULL
      AND NEW."contributionPolicySelectionRevision" = 1
      AND NEW."currentContributionPolicySelectionRevisionId" IS NOT NULL)
    OR
    (OLD."contributionPolicySelectionRevision" > 0
      AND NEW."contributionPolicySelectionRevision" = OLD."contributionPolicySelectionRevision" + 1
      AND NEW."currentContributionPolicySelectionRevisionId" IS NOT NULL
      AND NEW."currentContributionPolicySelectionRevisionId" IS DISTINCT FROM OLD."currentContributionPolicySelectionRevisionId")
  ) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'acps_current_revision_guard',
      MESSAGE = 'current contribution-policy selection must advance by exactly one revision';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "ActivityContributionPolicySelectionRevision" revision
    WHERE revision.id = NEW."currentContributionPolicySelectionRevisionId"
      AND revision."activityId" = NEW.id
      AND revision.revision = NEW."contributionPolicySelectionRevision"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', CONSTRAINT = 'acps_current_revision_guard',
      MESSAGE = 'current contribution-policy selection must point to the same activity revision';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER acps_current_revision_guard
BEFORE UPDATE OF "contributionPolicySelectionRevision", "currentContributionPolicySelectionRevisionId" ON "Activity"
FOR EACH ROW EXECUTE FUNCTION acps_check_current_revision();

CREATE FUNCTION acps_check_revision_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actual_item_count INTEGER;
  manifest_item_count INTEGER;
  activity_item_count INTEGER;
BEGIN
  SELECT count(*) INTO actual_item_count
    FROM "ActivityContributionPolicySelectionItem" item
    WHERE item."selectionRevisionId" = NEW.id AND item."activityId" = NEW."activityId";
  SELECT count(*) INTO manifest_item_count
    FROM jsonb_object_keys(NEW."selectionJson"->'items');
  SELECT count(*) INTO activity_item_count
    FROM "ActivityContributionPolicySelectionItem" item
    WHERE item."selectionRevisionId" = NEW.id AND item."layerCode" = 'activity';

  IF (
    actual_item_count = NEW."itemCount"
    AND manifest_item_count = NEW."itemCount"
    AND activity_item_count = 1
    AND EXISTS (
      SELECT 1 FROM "Activity" activity
      WHERE activity.id = NEW."activityId"
        AND activity."contributionPolicySelectionRevision" = NEW.revision
        AND activity."currentContributionPolicySelectionRevisionId" = NEW.id
    )
  ) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'acps_revision_complete_guard',
      MESSAGE = 'contribution-policy selection revision is incomplete or not current';
  END IF;

  IF NEW."templateId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "ActivityTemplate" template
    WHERE template.id = NEW."templateId"
      AND template."definitionHash" = NEW."templateDefinitionHash"
      AND template."schemaVersion" = 5
      AND jsonb_typeof(template."definitionJson"->'contributionPolicySelection') = 'object'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'acps_revision_complete_guard',
      MESSAGE = 'selection template anchor is not a V5 contribution-policy template';
  END IF;

  IF NEW."originCode" = 'select' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "ActivityContributionPolicySelectionCommandReceipt" receipt
      WHERE receipt."selectionRevisionId" = NEW.id
        AND receipt."activityId" = NEW."activityId"
        AND receipt."actorUserId" = NEW."createdByUserId"
        AND receipt."createdAt" = NEW."createdAt"
        AND receipt."resultJson"->'revision' = to_jsonb(NEW.revision)
        AND receipt."resultJson"->'selectionHash' = to_jsonb(NEW."selectionHash")
        AND receipt."resultJson"->'createdAt' = to_jsonb(to_char(NEW."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'acps_revision_complete_guard',
        MESSAGE = 'standalone selection lacks its matching immutable receipt';
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM "ActivityContributionPolicySelectionCommandReceipt" receipt
    WHERE receipt."selectionRevisionId" = NEW.id AND receipt."activityId" = NEW."activityId"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'acps_revision_complete_guard',
      MESSAGE = 'non-standalone selection must retain its outer command source only';
  END IF;

  IF NEW."originCode" = 'creation_receipt' AND (
    NEW.revision <> 1 OR NOT EXISTS (
      SELECT 1 FROM "ActivityCreationCommandReceipt" receipt
      WHERE receipt.id = NEW."creationReceiptId"
        AND receipt."activityId" = NEW."activityId"
        AND receipt."actorUserId" = NEW."createdByUserId"
        AND receipt."commandCode" IN ('create_professional', 'create_emergency')
        AND receipt."requestHash" ~ '^[0-9a-f]{64}$'
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'acps_revision_complete_guard',
      MESSAGE = 'creation selection source is invalid';
  END IF;

  IF NEW."originCode" = 'template_creation' AND (
    NEW.revision <> 1 OR NOT EXISTS (
      SELECT 1 FROM "Activity" activity
      WHERE activity.id = NEW."activityId"
        AND activity."selectedTemplateVersionId" = NEW."templateId"
        AND activity."createFromTemplateOperationKey" IS NOT NULL
        AND activity."createFromTemplateOperationKey" ~ '[^[:space:]]'
        AND activity."createFromTemplateRequestHash" ~ '^[0-9a-f]{64}$'
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'acps_revision_complete_guard',
      MESSAGE = 'template-copy selection source is invalid';
  END IF;

  IF NEW."originCode" = 'series_occurrence' AND (
    NEW.revision <> 1 OR NOT EXISTS (
      SELECT 1
      FROM "ActivitySeriesOccurrence" occurrence
      JOIN "ActivitySeriesRevision" series_revision
        ON series_revision.id = occurrence."revisionId" AND series_revision."seriesId" = occurrence."seriesId"
      WHERE occurrence.id = NEW."seriesOccurrenceId"
        AND occurrence."activityId" = NEW."activityId"
        AND series_revision."templateVersionId" = NEW."templateId"
        AND series_revision."templateDefinitionHash" = NEW."templateDefinitionHash"
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'acps_revision_complete_guard',
      MESSAGE = 'series selection source is invalid';
  END IF;

  IF NEW."originCode" = 'publish_review' AND NOT EXISTS (
    SELECT 1 FROM "activity_publish_reviews" review
    WHERE review.id = NEW."publishReviewId"
      AND review."activityId" = NEW."activityId"
      AND review.status = 'approved'
      AND review."reviewedByUserId" = NEW."createdByUserId"
      AND review."reviewOperationKey" ~ '[^[:space:]]'
      AND review."reviewRequestHash" ~ '^[0-9a-f]{64}$'
      AND review.snapshot->'contributionPolicyPointers'->'proposalSelectionHash' = to_jsonb(NEW."proposalSelectionHash")
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'acps_revision_complete_guard',
      MESSAGE = 'publish-review selection source is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER acps_revision_complete_guard
AFTER INSERT ON "ActivityContributionPolicySelectionRevision"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION acps_check_revision_complete();

CREATE FUNCTION acps_check_snapshot_reference() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  selection_revision "ActivityContributionPolicySelectionRevision"%ROWTYPE;
  pointer_json JSONB;
BEGIN
  pointer_json := NEW."resolvedConfig"->'contributionPolicyPointers';
  IF NEW."contributionPolicySelectionRevisionId" IS NULL THEN
    IF jsonb_typeof(pointer_json) = 'object' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'acps_snapshot_reference_guard',
        MESSAGE = 'V9 snapshot contribution-policy config requires a revision pointer';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO selection_revision
    FROM "ActivityContributionPolicySelectionRevision"
    WHERE id = NEW."contributionPolicySelectionRevisionId" AND "activityId" = NEW."activityId";
  IF NOT FOUND OR jsonb_typeof(pointer_json) <> 'object' OR NOT EXISTS (
    SELECT 1 FROM "activity_publish_reviews" review
    WHERE review.id = NEW."createdByReviewId" AND review."activityId" = NEW."activityId"
  ) OR (
    pointer_json->'selectionRevisionId' = to_jsonb(selection_revision.id)
    AND pointer_json->'selectionRevision' = to_jsonb(selection_revision.revision)
    AND pointer_json->'selectionHash' = to_jsonb(selection_revision."selectionHash")
    AND pointer_json->'selection' = selection_revision."selectionJson"
  ) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'acps_snapshot_reference_guard',
      MESSAGE = 'snapshot contribution-policy selection reference is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER acps_snapshot_reference_guard
AFTER INSERT ON "ActivityRuleSnapshot"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION acps_check_snapshot_reference();

-- V5 template receipts remain in the existing governed receipt table. Preserve every prior
-- operation branch and widen only the template schemaVersion closure from V3/V4 to V3/V4/V5.
ALTER TABLE "ActivityMetricCommandReceipt"
  DROP CONSTRAINT "activity_metric_receipt_result_check",
  ADD CONSTRAINT "activity_metric_receipt_result_check" CHECK ((
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
      AND "resultJson"->'schemaVersion' IN ('3'::jsonb, '4'::jsonb, '5'::jsonb)
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
          AND "resultJson"#>'{metricSetPointer,schemaVersion}' = '1'::jsonb
          AND jsonb_typeof("resultJson"#>'{metricSetPointer,definitionHash}') = 'string'
          AND "resultJson"#>>'{metricSetPointer,definitionHash}' ~ '^[0-9a-f]{64}$')
      )
    ))
  ) IS TRUE);

CREATE OR REPLACE FUNCTION atps_check_template_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  template_schema_version INTEGER;
BEGIN
  IF NEW."operationCode" NOT IN (
    'create_template_version', 'update_template_version',
    'activate_template_version', 'retire_template_version'
  ) THEN
    RETURN NEW;
  END IF;
  IF (NEW."resultJson"->'schemaVersion' IN ('3'::jsonb, '4'::jsonb, '5'::jsonb)) IS NOT TRUE THEN
    RETURN NEW;
  END IF;
  SELECT "schemaVersion" INTO template_schema_version
    FROM "ActivityTemplate" WHERE id = NEW."templateVersionId";
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF NEW."resultJson"->'schemaVersion' IS DISTINCT FROM to_jsonb(template_schema_version) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'atps_template_receipt_guard',
      MESSAGE = 'template receipt schemaVersion must equal its immutable template version';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
