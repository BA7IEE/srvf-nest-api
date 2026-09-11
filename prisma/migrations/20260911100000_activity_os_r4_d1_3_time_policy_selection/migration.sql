-- Activity OS R4 / D1-3: immutable four-level time-policy selection.
--
-- Purely additive: three empty retention tables, current pointers, source anchors and database
-- invariants.  No historical Activity/Snapshot backfill, no policy/role DML and no deletion.
-- This is migration 119; deploy only through the separately approved isolated test database.
BEGIN;

ALTER TABLE "Activity"
  ADD COLUMN "timePolicySelectionRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "currentTimePolicySelectionRevisionId" TEXT;

ALTER TABLE "ActivityRuleSnapshot"
  ADD COLUMN "timePolicySelectionRevisionId" TEXT;

-- Prisma needs every compound reference anchor represented in the schema as well.  The existing
-- source tables remain untouched; these keys only make their already-stored identity usable here.
CREATE UNIQUE INDEX "activity_template_id_definition_hash_key"
  ON "ActivityTemplate"("id", "definitionHash");
CREATE UNIQUE INDEX "atps_review_id_activity_key"
  ON "activity_publish_reviews"("id", "activityId");
CREATE UNIQUE INDEX "atps_occurrence_id_activity_key"
  ON "ActivitySeriesOccurrence"("id", "activityId");

CREATE TABLE "ActivityTimePolicySelectionRevision" (
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
  CONSTRAINT "ActivityTimePolicySelectionRevision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ActivityTimePolicySelectionItem" (
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
  CONSTRAINT "ActivityTimePolicySelectionItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ActivityTimePolicySelectionCommandReceipt" (
  "id" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "operationCode" TEXT NOT NULL,
  "operationKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "selectionRevisionId" TEXT NOT NULL,
  "resultJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ActivityTimePolicySelectionCommandReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "atps_revision_activity_revision_key"
  ON "ActivityTimePolicySelectionRevision"("activityId", "revision");
CREATE UNIQUE INDEX "atps_revision_id_activity_key"
  ON "ActivityTimePolicySelectionRevision"("id", "activityId");
CREATE UNIQUE INDEX "atps_revision_id_activity_revision_key"
  ON "ActivityTimePolicySelectionRevision"("id", "activityId", "revision");
CREATE INDEX "atps_revision_activity_created_idx"
  ON "ActivityTimePolicySelectionRevision"("activityId", "createdAt");
CREATE INDEX "atps_revision_template_idx"
  ON "ActivityTimePolicySelectionRevision"("templateId");
CREATE INDEX "atps_revision_review_idx"
  ON "ActivityTimePolicySelectionRevision"("publishReviewId");

CREATE UNIQUE INDEX "atps_item_template_key"
  ON "ActivityTimePolicySelectionItem"("selectionRevisionId")
  WHERE "layerCode" = 'template';
CREATE UNIQUE INDEX "atps_item_activity_key"
  ON "ActivityTimePolicySelectionItem"("selectionRevisionId")
  WHERE "layerCode" = 'activity';
CREATE UNIQUE INDEX "atps_item_session_key"
  ON "ActivityTimePolicySelectionItem"("selectionRevisionId", "sessionId")
  WHERE "layerCode" = 'session';
CREATE UNIQUE INDEX "atps_item_position_key"
  ON "ActivityTimePolicySelectionItem"("selectionRevisionId", "sessionId", "positionId")
  WHERE "layerCode" = 'position';
CREATE INDEX "atps_item_revision_idx"
  ON "ActivityTimePolicySelectionItem"("selectionRevisionId");
CREATE INDEX "atps_item_session_idx"
  ON "ActivityTimePolicySelectionItem"("activityId", "sessionId");
CREATE INDEX "atps_item_version_idx"
  ON "ActivityTimePolicySelectionItem"("versionId");

CREATE UNIQUE INDEX "atps_receipt_actor_operation_key"
  ON "ActivityTimePolicySelectionCommandReceipt"("actorUserId", "operationCode", "operationKey");
CREATE UNIQUE INDEX "atps_receipt_revision_activity_key"
  ON "ActivityTimePolicySelectionCommandReceipt"("selectionRevisionId", "activityId");
CREATE INDEX "atps_receipt_activity_created_idx"
  ON "ActivityTimePolicySelectionCommandReceipt"("activityId", "createdAt");
CREATE INDEX "atps_activity_current_revision_idx"
  ON "Activity"("currentTimePolicySelectionRevisionId");
CREATE INDEX "atps_snapshot_revision_idx"
  ON "ActivityRuleSnapshot"("timePolicySelectionRevisionId");

ALTER TABLE "ActivityTimePolicySelectionRevision"
  ADD CONSTRAINT "ActivityTimePolicySelectionRevision_activityId_fkey"
    FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ActivityTimePolicySelectionRevision_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "atps_revision_template_fkey"
    FOREIGN KEY ("templateId", "templateDefinitionHash")
    REFERENCES "ActivityTemplate"("id", "definitionHash") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "atps_revision_creation_fkey"
    FOREIGN KEY ("creationReceiptId", "activityId")
    REFERENCES "ActivityCreationCommandReceipt"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "atps_revision_occurrence_fkey"
    FOREIGN KEY ("seriesOccurrenceId", "activityId")
    REFERENCES "ActivitySeriesOccurrence"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "atps_revision_review_fkey"
    FOREIGN KEY ("publishReviewId", "activityId")
    REFERENCES "activity_publish_reviews"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "Activity"
  ADD CONSTRAINT "atps_current_revision_fkey"
    FOREIGN KEY ("currentTimePolicySelectionRevisionId", "id", "timePolicySelectionRevision")
    REFERENCES "ActivityTimePolicySelectionRevision"("id", "activityId", "revision")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ActivityTimePolicySelectionItem"
  ADD CONSTRAINT "atps_item_revision_fkey"
    FOREIGN KEY ("selectionRevisionId", "activityId")
    REFERENCES "ActivityTimePolicySelectionRevision"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "atps_item_session_fkey"
    FOREIGN KEY ("activityId", "sessionId")
    REFERENCES "ActivitySession"("activityId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "atps_item_position_fkey"
    FOREIGN KEY ("activityId", "sessionId", "positionId")
    REFERENCES "ActivitySessionPosition"("activityId", "sessionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "atps_item_policy_version_fkey"
    FOREIGN KEY ("versionId", "policyId", "definitionHash")
    REFERENCES "TimePolicyVersion"("id", "policyId", "definitionHash") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ActivityTimePolicySelectionCommandReceipt"
  ADD CONSTRAINT "atps_receipt_actor_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "atps_receipt_activity_fkey"
    FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "atps_receipt_revision_fkey"
    FOREIGN KEY ("selectionRevisionId", "activityId")
    REFERENCES "ActivityTimePolicySelectionRevision"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ActivityRuleSnapshot"
  ADD CONSTRAINT "atps_snapshot_revision_fkey"
    FOREIGN KEY ("timePolicySelectionRevisionId", "activityId")
    REFERENCES "ActivityTimePolicySelectionRevision"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "Activity"
  ADD CONSTRAINT "atps_current_shape_check" CHECK ((
    ("timePolicySelectionRevision" = 0 AND "currentTimePolicySelectionRevisionId" IS NULL)
    OR
    ("timePolicySelectionRevision" > 0 AND "currentTimePolicySelectionRevisionId" IS NOT NULL)
  ) IS TRUE);

ALTER TABLE "ActivityTimePolicySelectionRevision"
  ADD CONSTRAINT "atps_revision_shape_check" CHECK ((
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

ALTER TABLE "ActivityTimePolicySelectionItem"
  ADD CONSTRAINT "atps_item_shape_check" CHECK ((
    "layerCode" IN ('template', 'activity', 'session', 'position')
    AND (
      ("layerCode" IN ('template', 'activity') AND "sessionId" IS NULL AND "positionId" IS NULL)
      OR ("layerCode" = 'session' AND "sessionId" IS NOT NULL AND "positionId" IS NULL)
      OR ("layerCode" = 'position' AND "sessionId" IS NOT NULL AND "positionId" IS NOT NULL)
    )
    AND (
      ("mode" = 'inherit' AND "policyId" IS NULL AND "versionId" IS NULL AND "definitionHash" IS NULL)
      OR
      ("mode" = 'explicit' AND "policyId" IS NOT NULL AND "versionId" IS NOT NULL
        AND "definitionHash" ~ '^[0-9a-f]{64}$')
    )
  ) IS TRUE);

ALTER TABLE "ActivityTimePolicySelectionCommandReceipt"
  ADD CONSTRAINT "atps_receipt_shape_check" CHECK ((
    "operationCode" = 'patch_time_policy_selection'
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

-- No historical selection or receipt can be overwritten or removed.  New items are separately
-- checked against their parent's frozen manifest, so append-only is not enough on its own.
CREATE FUNCTION atps_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    CONSTRAINT = TG_NAME,
    MESSAGE = 'activity time-policy selection history is immutable';
END;
$$;

CREATE TRIGGER atps_revision_immutable
BEFORE UPDATE OR DELETE ON "ActivityTimePolicySelectionRevision"
FOR EACH ROW EXECUTE FUNCTION atps_reject_mutation();
CREATE TRIGGER atps_item_immutable
BEFORE UPDATE OR DELETE ON "ActivityTimePolicySelectionItem"
FOR EACH ROW EXECUTE FUNCTION atps_reject_mutation();
CREATE TRIGGER atps_receipt_immutable
BEFORE UPDATE OR DELETE ON "ActivityTimePolicySelectionCommandReceipt"
FOR EACH ROW EXECUTE FUNCTION atps_reject_mutation();

CREATE FUNCTION atps_check_item_manifest() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  manifest_item JSONB;
  expected_item JSONB;
  scope_key TEXT;
BEGIN
  scope_key := NEW."layerCode" || ':' ||
    CASE WHEN NEW."sessionId" IS NULL THEN '-' ELSE encode(convert_to(NEW."sessionId", 'UTF8'), 'base64') END || ':' ||
    CASE WHEN NEW."positionId" IS NULL THEN '-' ELSE encode(convert_to(NEW."positionId", 'UTF8'), 'base64') END;

  SELECT revision."selectionJson"->'items'->scope_key
    INTO manifest_item
    FROM "ActivityTimePolicySelectionRevision" revision
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
        'definitionHash', NEW."definitionHash"
      ) END
    )
  );

  IF manifest_item IS NULL OR manifest_item IS DISTINCT FROM expected_item THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'atps_item_manifest_guard',
      MESSAGE = 'selection item is absent from or differs from its immutable manifest';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER atps_item_manifest_guard
BEFORE INSERT ON "ActivityTimePolicySelectionItem"
FOR EACH ROW EXECUTE FUNCTION atps_check_item_manifest();

-- Current selection state is a strict append-only pointer.  The trigger is deliberately limited
-- to its two columns so ordinary Activity title/status updates never demand a selection revision.
CREATE FUNCTION atps_check_current_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (
    (OLD."timePolicySelectionRevision" = 0
      AND OLD."currentTimePolicySelectionRevisionId" IS NULL
      AND NEW."timePolicySelectionRevision" = 1
      AND NEW."currentTimePolicySelectionRevisionId" IS NOT NULL)
    OR
    (OLD."timePolicySelectionRevision" > 0
      AND NEW."timePolicySelectionRevision" = OLD."timePolicySelectionRevision" + 1
      AND NEW."currentTimePolicySelectionRevisionId" IS NOT NULL
      AND NEW."currentTimePolicySelectionRevisionId" IS DISTINCT FROM OLD."currentTimePolicySelectionRevisionId")
  ) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'atps_current_revision_guard',
      MESSAGE = 'current time-policy selection must advance by exactly one revision';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "ActivityTimePolicySelectionRevision" revision
    WHERE revision.id = NEW."currentTimePolicySelectionRevisionId"
      AND revision."activityId" = NEW.id
      AND revision.revision = NEW."timePolicySelectionRevision"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', CONSTRAINT = 'atps_current_revision_guard',
      MESSAGE = 'current time-policy selection must point to the same activity revision';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER atps_current_revision_guard
BEFORE UPDATE OF "timePolicySelectionRevision", "currentTimePolicySelectionRevisionId" ON "Activity"
FOR EACH ROW EXECUTE FUNCTION atps_check_current_revision();

-- This one deferred parent check runs once per new revision.  It makes a transaction containing
-- an incomplete manifest, an orphaned source or an un-switched current pointer fail at commit,
-- while leaving older historical revisions free to remain non-current after a later revision.
CREATE FUNCTION atps_check_revision_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actual_item_count INTEGER;
  manifest_item_count INTEGER;
  template_item_count INTEGER;
  activity_item_count INTEGER;
BEGIN
  SELECT count(*) INTO actual_item_count
    FROM "ActivityTimePolicySelectionItem" item
    WHERE item."selectionRevisionId" = NEW.id AND item."activityId" = NEW."activityId";
  SELECT count(*) INTO manifest_item_count
    FROM jsonb_object_keys(NEW."selectionJson"->'items');
  SELECT count(*) INTO template_item_count
    FROM "ActivityTimePolicySelectionItem" item
    WHERE item."selectionRevisionId" = NEW.id AND item."layerCode" = 'template';
  SELECT count(*) INTO activity_item_count
    FROM "ActivityTimePolicySelectionItem" item
    WHERE item."selectionRevisionId" = NEW.id AND item."layerCode" = 'activity';

  IF (
    actual_item_count = NEW."itemCount"
    AND manifest_item_count = NEW."itemCount"
    AND activity_item_count = 1
    AND (
      (NEW."templateId" IS NULL AND template_item_count = 0)
      OR (NEW."templateId" IS NOT NULL AND template_item_count = 1)
    )
    AND EXISTS (
      SELECT 1 FROM "Activity" activity
      WHERE activity.id = NEW."activityId"
        AND activity."timePolicySelectionRevision" = NEW.revision
        AND activity."currentTimePolicySelectionRevisionId" = NEW.id
    )
  ) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'atps_revision_complete_guard',
      MESSAGE = 'time-policy selection revision is incomplete or not current';
  END IF;

  IF NEW."originCode" = 'select' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "ActivityTimePolicySelectionCommandReceipt" receipt
      WHERE receipt."selectionRevisionId" = NEW.id
        AND receipt."activityId" = NEW."activityId"
        AND receipt."actorUserId" = NEW."createdByUserId"
        AND receipt."createdAt" = NEW."createdAt"
        AND receipt."resultJson"->'revision' = to_jsonb(NEW.revision)
        AND receipt."resultJson"->'selectionHash' = to_jsonb(NEW."selectionHash")
        AND receipt."resultJson"->'createdAt' = to_jsonb(to_char(NEW."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'atps_revision_complete_guard',
        MESSAGE = 'standalone selection lacks its matching immutable receipt';
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM "ActivityTimePolicySelectionCommandReceipt" receipt
    WHERE receipt."selectionRevisionId" = NEW.id AND receipt."activityId" = NEW."activityId"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'atps_revision_complete_guard',
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
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'atps_revision_complete_guard',
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
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'atps_revision_complete_guard',
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
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'atps_revision_complete_guard',
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
      AND review.snapshot->'timePolicyPointers'->'proposalSelectionHash' = to_jsonb(NEW."proposalSelectionHash")
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'atps_revision_complete_guard',
      MESSAGE = 'publish-review selection source is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER atps_revision_complete_guard
AFTER INSERT ON "ActivityTimePolicySelectionRevision"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION atps_check_revision_complete();

-- V8 snapshots must pin the exact immutable revision and carry the same safe summary in their
-- resolved JSON.  Older V2-V7 snapshots retain their null pointer and original hash unchanged.
CREATE FUNCTION atps_check_snapshot_reference() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  selection_revision "ActivityTimePolicySelectionRevision"%ROWTYPE;
  pointer_json JSONB;
BEGIN
  pointer_json := NEW."resolvedConfig"->'timePolicyPointers';
  IF NEW."timePolicySelectionRevisionId" IS NULL THEN
    IF jsonb_typeof(pointer_json) = 'object' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'atps_snapshot_reference_guard',
        MESSAGE = 'V8 snapshot time-policy config requires a revision pointer';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO selection_revision
    FROM "ActivityTimePolicySelectionRevision"
    WHERE id = NEW."timePolicySelectionRevisionId" AND "activityId" = NEW."activityId";
  IF NOT FOUND OR jsonb_typeof(pointer_json) <> 'object' OR NOT EXISTS (
    SELECT 1 FROM "activity_publish_reviews" review
    WHERE review.id = NEW."createdByReviewId" AND review."activityId" = NEW."activityId"
  ) OR (
    pointer_json->'selectionRevisionId' = to_jsonb(selection_revision.id)
    AND pointer_json->'selectionRevision' = to_jsonb(selection_revision.revision)
    AND pointer_json->'selectionHash' = to_jsonb(selection_revision."selectionHash")
    AND pointer_json->'selection' = selection_revision."selectionJson"
  ) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'atps_snapshot_reference_guard',
      MESSAGE = 'snapshot time-policy selection reference is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER atps_snapshot_reference_guard
AFTER INSERT ON "ActivityRuleSnapshot"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION atps_check_snapshot_reference();

-- V4 template receipts remain in the existing metric-command receipt table.  Preserve every
-- previous operation branch verbatim, widening only its template schemaVersion from V3 to V3/V4.
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
      AND "resultJson"->'schemaVersion' IN ('3'::jsonb, '4'::jsonb)
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

CREATE FUNCTION atps_check_template_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  template_schema_version INTEGER;
BEGIN
  IF NEW."operationCode" NOT IN (
    'create_template_version', 'update_template_version',
    'activate_template_version', 'retire_template_version'
  ) THEN
    RETURN NEW;
  END IF;
  -- Let the pre-existing CHECK remain the authoritative failure for malformed result envelopes,
  -- and let its existing target FK remain authoritative for a missing template. This trigger is
  -- the additional semantic guard only after both values are structurally valid and present.
  IF (NEW."resultJson"->'schemaVersion' IN ('3'::jsonb, '4'::jsonb)) IS NOT TRUE THEN
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

CREATE TRIGGER atps_template_receipt_guard
BEFORE INSERT ON "ActivityMetricCommandReceipt"
FOR EACH ROW EXECUTE FUNCTION atps_check_template_receipt();

COMMIT;
