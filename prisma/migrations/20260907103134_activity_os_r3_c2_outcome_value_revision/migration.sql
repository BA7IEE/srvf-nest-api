-- C2 D1: additive data foundation, no backfill or runtime writer.
BEGIN;

-- CreateTable
CREATE TABLE "ActivityOutcomeRevision" (
    "id" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "metricSetVersionId" TEXT NOT NULL,
    "metricSetDefinitionHash" TEXT NOT NULL,
    "statusCode" TEXT NOT NULL,
    "priorRevisionId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityOutcomeRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityMetricValueRevision" (
    "id" TEXT NOT NULL,
    "outcomeRevisionId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "setVersionId" TEXT NOT NULL,
    "metricDefinitionId" TEXT NOT NULL,
    "valueJson" JSONB NOT NULL,
    "valueHash" TEXT NOT NULL,
    "sourceCode" TEXT NOT NULL,
    "sourceReference" TEXT,
    "calculatedByRuleVersion" TEXT,
    "confirmedByUserId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityMetricValueRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityMetricValueEvidence" (
    "id" TEXT NOT NULL,
    "valueRevisionId" TEXT NOT NULL,
    "outcomeRevisionId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "setVersionId" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityMetricValueEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActivityOutcomeRevision_metricSetVersionId_metricSetDefinit_idx" ON "ActivityOutcomeRevision"("metricSetVersionId", "metricSetDefinitionHash");

-- CreateIndex
CREATE INDEX "ActivityOutcomeRevision_priorRevisionId_activityId_idx" ON "ActivityOutcomeRevision"("priorRevisionId", "activityId");

-- CreateIndex
CREATE INDEX "ActivityOutcomeRevision_createdByUserId_idx" ON "ActivityOutcomeRevision"("createdByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "activity_outcome_revision_key" ON "ActivityOutcomeRevision"("activityId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "activity_outcome_activity_key" ON "ActivityOutcomeRevision"("id", "activityId");

-- CreateIndex
CREATE UNIQUE INDEX "activity_outcome_chain_key" ON "ActivityOutcomeRevision"("id", "activityId", "metricSetVersionId");

-- CreateIndex
CREATE INDEX "ActivityMetricValueRevision_setVersionId_metricDefinitionId_idx" ON "ActivityMetricValueRevision"("setVersionId", "metricDefinitionId");

-- CreateIndex
CREATE INDEX "ActivityMetricValueRevision_confirmedByUserId_idx" ON "ActivityMetricValueRevision"("confirmedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "activity_value_metric_key" ON "ActivityMetricValueRevision"("outcomeRevisionId", "metricDefinitionId");

-- CreateIndex
CREATE UNIQUE INDEX "activity_value_chain_key" ON "ActivityMetricValueRevision"("id", "outcomeRevisionId", "activityId", "setVersionId");

-- CreateIndex
CREATE INDEX "ActivityMetricValueEvidence_attachmentId_idx" ON "ActivityMetricValueEvidence"("attachmentId");

-- CreateIndex
CREATE UNIQUE INDEX "activity_value_evidence_attachment_key" ON "ActivityMetricValueEvidence"("valueRevisionId", "attachmentId");

-- CreateIndex
CREATE UNIQUE INDEX "activity_value_evidence_order_key" ON "ActivityMetricValueEvidence"("valueRevisionId", "sortOrder");

-- AddForeignKey
ALTER TABLE "ActivityOutcomeRevision" ADD CONSTRAINT "ActivityOutcomeRevision_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivityOutcomeRevision" ADD CONSTRAINT "activity_outcome_set_fk" FOREIGN KEY ("metricSetVersionId", "metricSetDefinitionHash") REFERENCES "ActivityMetricSetVersion"("id", "definitionHash") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivityOutcomeRevision" ADD CONSTRAINT "ActivityOutcomeRevision_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivityOutcomeRevision" ADD CONSTRAINT "activity_outcome_prior_fk" FOREIGN KEY ("priorRevisionId", "activityId") REFERENCES "ActivityOutcomeRevision"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivityMetricValueRevision" ADD CONSTRAINT "activity_value_outcome_fk" FOREIGN KEY ("outcomeRevisionId", "activityId", "setVersionId") REFERENCES "ActivityOutcomeRevision"("id", "activityId", "metricSetVersionId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivityMetricValueRevision" ADD CONSTRAINT "activity_value_set_item_fk" FOREIGN KEY ("setVersionId", "metricDefinitionId") REFERENCES "ActivityMetricSetItem"("setVersionId", "metricDefinitionId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivityMetricValueRevision" ADD CONSTRAINT "ActivityMetricValueRevision_confirmedByUserId_fkey" FOREIGN KEY ("confirmedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivityMetricValueEvidence" ADD CONSTRAINT "activity_value_evidence_chain_fk" FOREIGN KEY ("valueRevisionId", "outcomeRevisionId", "activityId", "setVersionId") REFERENCES "ActivityMetricValueRevision"("id", "outcomeRevisionId", "activityId", "setVersionId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivityMetricValueEvidence" ADD CONSTRAINT "ActivityMetricValueEvidence_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "attachments"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ActivityOutcomeRevision"
  ADD CONSTRAINT activity_outcome_revision_positive CHECK ("revision" > 0),
  ADD CONSTRAINT activity_outcome_status_closed CHECK ("statusCode" IN ('draft', 'confirmed', 'superseded')),
  ADD CONSTRAINT activity_outcome_hash_shape CHECK ("metricSetDefinitionHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT activity_outcome_prior_not_self CHECK ("priorRevisionId" IS DISTINCT FROM "id");

ALTER TABLE "ActivityMetricValueRevision"
  ADD CONSTRAINT activity_value_hash_shape CHECK ("valueHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT activity_value_scalar CHECK (jsonb_typeof("valueJson") IN ('number', 'string', 'boolean')),
  ADD CONSTRAINT activity_value_source_closed CHECK ("sourceCode" IN ('system', 'manual', 'import', 'ai_suggested_confirmed')),
  ADD CONSTRAINT activity_value_confirmation_pair CHECK (("confirmedByUserId" IS NULL) = ("confirmedAt" IS NULL)),
  ADD CONSTRAINT activity_value_confirmation_metadata CHECK (
    "confirmedAt" IS NULL OR ("sourceReference" IS NOT NULL AND "calculatedByRuleVersion" IS NOT NULL)
  ),
  ADD CONSTRAINT activity_value_source_reference_nonempty CHECK (
    "sourceReference" IS NULL OR (length(btrim("sourceReference")) > 0 AND "sourceReference" = btrim("sourceReference"))
  ),
  ADD CONSTRAINT activity_value_rule_nonempty CHECK (
    "calculatedByRuleVersion" IS NULL OR (length(btrim("calculatedByRuleVersion")) > 0 AND "calculatedByRuleVersion" = btrim("calculatedByRuleVersion"))
  );

ALTER TABLE "ActivityMetricValueEvidence"
  ADD CONSTRAINT activity_value_evidence_order_nonnegative CHECK ("sortOrder" >= 0);

-- Revision content cannot be overwritten. Lifecycle legality and confirmed
-- evidence completeness belong to the separately approved C3 transaction.
CREATE FUNCTION activity_outcome_content_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'activity outcome revision cannot be deleted';
  END IF;
  IF (to_jsonb(NEW) - 'statusCode') IS DISTINCT FROM (to_jsonb(OLD) - 'statusCode') THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'activity outcome revision content is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER activity_outcome_content_immutable
BEFORE UPDATE OR DELETE ON "ActivityOutcomeRevision"
FOR EACH ROW EXECUTE FUNCTION activity_outcome_content_guard();

CREATE FUNCTION activity_outcome_child_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'activity outcome value and evidence are append-only';
END;
$$;

CREATE TRIGGER activity_value_immutable
BEFORE UPDATE OR DELETE ON "ActivityMetricValueRevision"
FOR EACH ROW EXECUTE FUNCTION activity_outcome_child_immutable();

CREATE TRIGGER activity_value_evidence_immutable
BEFORE UPDATE OR DELETE ON "ActivityMetricValueEvidence"
FOR EACH ROW EXECUTE FUNCTION activity_outcome_child_immutable();

-- This guards metadata, not evidence completeness or attachment ownership.
-- Those remain C3 / D2 transaction responsibilities respectively.
CREATE FUNCTION activity_outcome_chain_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."priorRevisionId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "ActivityOutcomeRevision" p
    WHERE p.id = NEW."priorRevisionId" AND p."revision" >= NEW."revision"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'prior outcome revision must precede new revision';
  END IF;
  IF NEW."statusCode" = 'confirmed' AND EXISTS (
    SELECT 1 FROM "ActivityMetricValueRevision" v
    WHERE v."outcomeRevisionId" = NEW.id AND
      (v."confirmedByUserId" IS NULL OR v."confirmedAt" IS NULL OR
       v."sourceReference" IS NULL OR v."calculatedByRuleVersion" IS NULL)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'confirmed outcome requires value confirmation metadata';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER activity_outcome_chain_check
BEFORE INSERT OR UPDATE ON "ActivityOutcomeRevision"
FOR EACH ROW EXECUTE FUNCTION activity_outcome_chain_guard();

CREATE FUNCTION activity_value_confirmation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status TEXT;
BEGIN
  -- Serialize insertion against status changes so neither side can miss the other.
  SELECT "statusCode" INTO parent_status FROM "ActivityOutcomeRevision"
    WHERE id = NEW."outcomeRevisionId" FOR UPDATE;
  IF parent_status = 'confirmed' AND
    (NEW."confirmedByUserId" IS NULL OR NEW."confirmedAt" IS NULL OR
     NEW."sourceReference" IS NULL OR NEW."calculatedByRuleVersion" IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'confirmed outcome requires value confirmation metadata';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER activity_value_confirmation_check
BEFORE INSERT ON "ActivityMetricValueRevision"
FOR EACH ROW EXECUTE FUNCTION activity_value_confirmation_guard();

COMMIT;
