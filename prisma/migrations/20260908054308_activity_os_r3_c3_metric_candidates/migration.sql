-- C3-1 additive immutable metric candidates. No backfill, deletes or Gate change.
BEGIN;
-- CreateTable
CREATE TABLE "ActivityMetricRuleBinding" (
    "id" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "metricDefinitionId" TEXT NOT NULL,
    "definitionHash" TEXT NOT NULL,
    "ruleCode" TEXT NOT NULL,
    "evaluatorVersion" INTEGER NOT NULL,
    "ruleDigest" TEXT NOT NULL,
    "unitCode" TEXT NOT NULL,
    "scale" INTEGER NOT NULL,
    "bindingHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT NOT NULL,

    CONSTRAINT "ActivityMetricRuleBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityMetricCandidate" (
    "id" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "activityId" TEXT NOT NULL,
    "candidateRevision" INTEGER NOT NULL,
    "priorCandidateId" TEXT,
    "metricSetVersionId" TEXT NOT NULL,
    "metricSetDefinitionHash" TEXT NOT NULL,
    "expectedOutcomeRevision" INTEGER NOT NULL,
    "sourceMode" TEXT NOT NULL,
    "providerVersion" INTEGER NOT NULL,
    "sourceDigest" TEXT NOT NULL,
    "bindingsDigest" TEXT NOT NULL,
    "valueCount" INTEGER NOT NULL,
    "sourceCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT NOT NULL,

    CONSTRAINT "ActivityMetricCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityMetricCandidateValue" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "setVersionId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "definitionHash" TEXT NOT NULL,
    "bindingId" TEXT NOT NULL,
    "valueJson" JSONB NOT NULL,
    "valueHash" TEXT NOT NULL,

    CONSTRAINT "ActivityMetricCandidateValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityMetricCandidateSource" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "sourceRevisionId" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "memberGroupOrdinal" INTEGER NOT NULL,
    "checkInAt" TIMESTAMP(3) NOT NULL,
    "checkOutAt" TIMESTAMP(3) NOT NULL,
    "resultCode" TEXT NOT NULL,
    "sourceFingerprint" TEXT NOT NULL,

    CONSTRAINT "ActivityMetricCandidateSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityMetricCandidateCommandReceipt" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "resultJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityMetricCandidateCommandReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityMetricRuleBindingCommandReceipt" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "bindingId" TEXT NOT NULL,
    "resultJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityMetricRuleBindingCommandReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActivityMetricRuleBinding_metricDefinitionId_idx" ON "ActivityMetricRuleBinding"("metricDefinitionId");

-- CreateIndex
CREATE UNIQUE INDEX "metric_rule_binding_hash_key" ON "ActivityMetricRuleBinding"("bindingHash");

-- CreateIndex
CREATE UNIQUE INDEX "metric_rule_binding_definition_key" ON "ActivityMetricRuleBinding"("id", "metricDefinitionId", "definitionHash");

-- CreateIndex
CREATE INDEX "ActivityMetricCandidate_metricSetVersionId_idx" ON "ActivityMetricCandidate"("metricSetVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "metric_candidate_revision_key" ON "ActivityMetricCandidate"("activityId", "candidateRevision");

-- CreateIndex
CREATE UNIQUE INDEX "metric_candidate_activity_key" ON "ActivityMetricCandidate"("id", "activityId");

-- CreateIndex
CREATE UNIQUE INDEX "metric_candidate_chain_key" ON "ActivityMetricCandidate"("id", "activityId", "metricSetVersionId");

-- CreateIndex
CREATE INDEX "ActivityMetricCandidateValue_bindingId_idx" ON "ActivityMetricCandidateValue"("bindingId");

-- CreateIndex
CREATE INDEX "ActivityMetricCandidateValue_setVersionId_definitionId_idx" ON "ActivityMetricCandidateValue"("setVersionId", "definitionId");

-- CreateIndex
CREATE UNIQUE INDEX "metric_candidate_value_definition_key" ON "ActivityMetricCandidateValue"("candidateId", "definitionId");

-- CreateIndex
CREATE INDEX "metric_candidate_source_segment_idx" ON "ActivityMetricCandidateSource"("sourceRevisionId", "identityId");

-- CreateIndex
CREATE INDEX "metric_candidate_source_identity_idx" ON "ActivityMetricCandidateSource"("identityId", "activityId", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "metric_candidate_source_ordinal_key" ON "ActivityMetricCandidateSource"("candidateId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "metric_candidate_source_revision_key" ON "ActivityMetricCandidateSource"("candidateId", "sourceRevisionId");

-- CreateIndex
CREATE INDEX "metric_candidate_receipt_candidate_idx" ON "ActivityMetricCandidateCommandReceipt"("candidateId", "activityId");

-- CreateIndex
CREATE UNIQUE INDEX "metric_candidate_receipt_operation_key" ON "ActivityMetricCandidateCommandReceipt"("actorId", "operation", "operationKey");

-- CreateIndex
CREATE INDEX "metric_binding_receipt_binding_idx" ON "ActivityMetricRuleBindingCommandReceipt"("bindingId");

-- CreateIndex
CREATE UNIQUE INDEX "metric_binding_receipt_operation_key" ON "ActivityMetricRuleBindingCommandReceipt"("actorId", "operation", "operationKey");

-- CreateIndex
CREATE UNIQUE INDEX "metric_definition_id_hash_key" ON "ActivityMetricDefinition"("id", "definitionHash");

-- CreateIndex
CREATE UNIQUE INDEX "metric_source_segment_identity_key" ON "ParticipantServiceSegmentRevision"("id", "participationIdentityId");

-- AddForeignKey
ALTER TABLE "ActivityMetricRuleBinding" ADD CONSTRAINT "metric_rule_binding_definition_fk" FOREIGN KEY ("metricDefinitionId", "definitionHash") REFERENCES "ActivityMetricDefinition"("id", "definitionHash") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivityMetricRuleBinding" ADD CONSTRAINT "ActivityMetricRuleBinding_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivityMetricCandidate" ADD CONSTRAINT "ActivityMetricCandidate_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivityMetricCandidate" ADD CONSTRAINT "metric_candidate_set_fk" FOREIGN KEY ("metricSetVersionId", "metricSetDefinitionHash") REFERENCES "ActivityMetricSetVersion"("id", "definitionHash") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivityMetricCandidate" ADD CONSTRAINT "ActivityMetricCandidate_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivityMetricCandidate" ADD CONSTRAINT "metric_candidate_prior_fk" FOREIGN KEY ("priorCandidateId", "activityId") REFERENCES "ActivityMetricCandidate"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivityMetricCandidateValue" ADD CONSTRAINT "metric_candidate_value_candidate_fk" FOREIGN KEY ("candidateId", "activityId", "setVersionId") REFERENCES "ActivityMetricCandidate"("id", "activityId", "metricSetVersionId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivityMetricCandidateValue" ADD CONSTRAINT "metric_candidate_value_set_item_fk" FOREIGN KEY ("setVersionId", "definitionId") REFERENCES "ActivityMetricSetItem"("setVersionId", "metricDefinitionId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivityMetricCandidateValue" ADD CONSTRAINT "metric_candidate_value_binding_fk" FOREIGN KEY ("bindingId", "definitionId", "definitionHash") REFERENCES "ActivityMetricRuleBinding"("id", "metricDefinitionId", "definitionHash") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivityMetricCandidateSource" ADD CONSTRAINT "metric_candidate_source_candidate_fk" FOREIGN KEY ("candidateId", "activityId") REFERENCES "ActivityMetricCandidate"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivityMetricCandidateSource" ADD CONSTRAINT "metric_candidate_source_identity_fk" FOREIGN KEY ("identityId", "activityId", "sessionId") REFERENCES "ActivityParticipationIdentity"("id", "activityId", "sessionId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivityMetricCandidateSource" ADD CONSTRAINT "metric_candidate_source_segment_fk" FOREIGN KEY ("sourceRevisionId", "identityId") REFERENCES "ParticipantServiceSegmentRevision"("id", "participationIdentityId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivityMetricCandidateCommandReceipt" ADD CONSTRAINT "ActivityMetricCandidateCommandReceipt_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivityMetricCandidateCommandReceipt" ADD CONSTRAINT "metric_candidate_receipt_candidate_fk" FOREIGN KEY ("candidateId", "activityId") REFERENCES "ActivityMetricCandidate"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivityMetricRuleBindingCommandReceipt" ADD CONSTRAINT "ActivityMetricRuleBindingCommandReceipt_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivityMetricRuleBindingCommandReceipt" ADD CONSTRAINT "metric_binding_receipt_binding_fk" FOREIGN KEY ("bindingId") REFERENCES "ActivityMetricRuleBinding"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


ALTER TABLE "ActivityMetricRuleBinding" ADD CONSTRAINT "metric_binding_shape_0" CHECK (("schemaVersion" = 1 AND "evaluatorVersion" = 1) IS TRUE);

ALTER TABLE "ActivityMetricRuleBinding" ADD CONSTRAINT "metric_binding_shape_1" CHECK ((("ruleCode" = 'actual_participant_count_v1' AND "unitCode" = 'count' AND "scale" = 0) OR ("ruleCode" = 'actual_participation_hours_v1' AND "unitCode" = 'hours' AND "scale" BETWEEN 0 AND 6)) IS TRUE);

ALTER TABLE "ActivityMetricRuleBinding" ADD CONSTRAINT "metric_binding_shape_2" CHECK (("definitionHash" ~ '^[0-9a-f]{64}$' AND "ruleDigest" ~ '^[0-9a-f]{64}$' AND "bindingHash" ~ '^[0-9a-f]{64}$') IS TRUE);

ALTER TABLE "ActivityMetricCandidate" ADD CONSTRAINT "metric_candidate_shape_0" CHECK (("schemaVersion" = 1 AND "providerVersion" = 1 AND "sourceMode" = 'participation_segments') IS TRUE);

ALTER TABLE "ActivityMetricCandidate" ADD CONSTRAINT "metric_candidate_shape_1" CHECK (("candidateRevision" > 0 AND "expectedOutcomeRevision" >= 0 AND "expectedOutcomeRevision" < 2147483647) IS TRUE);

ALTER TABLE "ActivityMetricCandidate" ADD CONSTRAINT "metric_candidate_shape_2" CHECK (("valueCount" BETWEEN 1 AND 100 AND "sourceCount" BETWEEN 0 AND 10000) IS TRUE);

ALTER TABLE "ActivityMetricCandidate" ADD CONSTRAINT "metric_candidate_shape_3" CHECK (("sourceDigest" ~ '^[0-9a-f]{64}$' AND "bindingsDigest" ~ '^[0-9a-f]{64}$' AND "metricSetDefinitionHash" ~ '^[0-9a-f]{64}$') IS TRUE);

ALTER TABLE "ActivityMetricCandidateValue" ADD CONSTRAINT "metric_candidate_value_shape_0" CHECK (("valueHash" ~ '^[0-9a-f]{64}$' AND "definitionHash" ~ '^[0-9a-f]{64}$') IS TRUE);

ALTER TABLE "ActivityMetricCandidateValue" ADD CONSTRAINT "metric_candidate_value_shape_1" CHECK ((CASE jsonb_typeof("valueJson")
  WHEN 'number' THEN "valueJson"::text ~ '^(0|[1-9][0-9]*)$' AND ("valueJson"::text)::numeric <= 9007199254740991
  WHEN 'string' THEN length("valueJson" #>> '{}') <= 20 AND ("valueJson" #>> '{}') ~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
  ELSE false END) IS TRUE);

ALTER TABLE "ActivityMetricCandidateSource" ADD CONSTRAINT "metric_candidate_source_shape_0" CHECK (("ordinal" BETWEEN 0 AND 9999 AND "memberGroupOrdinal" BETWEEN 0 AND 1999) IS TRUE);

ALTER TABLE "ActivityMetricCandidateSource" ADD CONSTRAINT "metric_candidate_source_shape_1" CHECK (("checkOutAt" > "checkInAt" AND "resultCode" IN ('valid','early_departure_zero')) IS TRUE);

ALTER TABLE "ActivityMetricCandidateSource" ADD CONSTRAINT "metric_candidate_source_shape_2" CHECK (("sourceFingerprint" ~ '^[0-9a-f]{64}$') IS TRUE);

ALTER TABLE "ActivityMetricCandidateCommandReceipt" ADD CONSTRAINT "metric_candidate_receipt_shape_0" CHECK (("operation" = 'calculate_metric_candidate') IS TRUE);

ALTER TABLE "ActivityMetricCandidateCommandReceipt" ADD CONSTRAINT "metric_candidate_receipt_shape_1" CHECK ((length("operationKey") BETWEEN 1 AND 128 AND "operationKey" = btrim("operationKey")) IS TRUE);

ALTER TABLE "ActivityMetricCandidateCommandReceipt" ADD CONSTRAINT "metric_candidate_receipt_shape_2" CHECK (("requestHash" ~ '^[0-9a-f]{64}$') IS TRUE);

ALTER TABLE "ActivityMetricCandidateCommandReceipt" ADD CONSTRAINT "metric_candidate_receipt_shape_3" CHECK ((jsonb_typeof("resultJson") = 'object' AND octet_length("resultJson"::text) <= 4096) IS TRUE);

ALTER TABLE "ActivityMetricRuleBindingCommandReceipt" ADD CONSTRAINT "metric_binding_receipt_shape_0" CHECK (("operation" = 'create_metric_rule_binding') IS TRUE);

ALTER TABLE "ActivityMetricRuleBindingCommandReceipt" ADD CONSTRAINT "metric_binding_receipt_shape_1" CHECK ((length("operationKey") BETWEEN 1 AND 128 AND "operationKey" = btrim("operationKey")) IS TRUE);

ALTER TABLE "ActivityMetricRuleBindingCommandReceipt" ADD CONSTRAINT "metric_binding_receipt_shape_2" CHECK (("requestHash" ~ '^[0-9a-f]{64}$') IS TRUE);

ALTER TABLE "ActivityMetricRuleBindingCommandReceipt" ADD CONSTRAINT "metric_binding_receipt_shape_3" CHECK ((jsonb_typeof("resultJson") = 'object' AND octet_length("resultJson"::text) <= 4096) IS TRUE);

CREATE FUNCTION metric_candidate_fact_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'metric candidate facts are immutable';
END;
$$;

CREATE FUNCTION metric_candidate_aggregate_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  candidate_id TEXT;
  c "ActivityMetricCandidate"%ROWTYPE;
  prior_revision INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'ActivityMetricCandidate' THEN candidate_id := NEW.id;
  ELSE candidate_id := NEW."candidateId"; END IF;
  SELECT * INTO STRICT c FROM "ActivityMetricCandidate" WHERE id = candidate_id;
  IF c."priorCandidateId" IS NULL THEN
    IF c."candidateRevision" <> 1 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid first candidate revision';
    END IF;
  ELSE
    SELECT "candidateRevision" INTO prior_revision FROM "ActivityMetricCandidate"
      WHERE id = c."priorCandidateId" AND "activityId" = c."activityId";
    IF prior_revision IS NULL OR prior_revision::bigint + 1 <> c."candidateRevision" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid candidate predecessor';
    END IF;
  END IF;
  IF
    (SELECT count(*) FROM "ActivityMetricCandidateValue" WHERE "candidateId" = c.id) <> c."valueCount"
    OR (SELECT count(*) FROM "ActivityMetricCandidateSource" WHERE "candidateId" = c.id) <> c."sourceCount"
    OR (SELECT count(*) FROM "ActivityMetricCandidateCommandReceipt" WHERE "candidateId" = c.id) <> 1
    OR EXISTS (SELECT 1 FROM "ActivityMetricCandidateSource" WHERE "candidateId" = c.id AND "ordinal" >= c."sourceCount")
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'incomplete candidate aggregate';
  END IF;
  -- Validate the stable pseudonymous grouping while original identity rows are locked
  -- by the command's Activity fence; historical replay will use only the retained ordinal.
  IF EXISTS (
    WITH partitioned AS (
      SELECT s.id, s."ordinal", s."memberGroupOrdinal", s."sourceRevisionId",
        min(s."sourceRevisionId" COLLATE "C") OVER (PARTITION BY i."memberId") AS group_key
      FROM "ActivityMetricCandidateSource" s
      JOIN "ActivityParticipationIdentity" i ON i.id = s."identityId"
      WHERE s."candidateId" = c.id
    ), ranked AS (
      SELECT *, dense_rank() OVER (ORDER BY group_key COLLATE "C") - 1 AS expected_group,
        row_number() OVER (ORDER BY group_key COLLATE "C", "sourceRevisionId" COLLATE "C") - 1 AS expected_ordinal
      FROM partitioned
    )
    SELECT 1 FROM ranked WHERE "memberGroupOrdinal" <> expected_group OR "ordinal" <> expected_ordinal
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid candidate source partition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION metric_candidate_source_snapshot_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source "ParticipantServiceSegmentRevision"%ROWTYPE;
BEGIN
  SELECT * INTO source FROM "ParticipantServiceSegmentRevision"
    WHERE id = NEW."sourceRevisionId" AND "participationIdentityId" = NEW."identityId";
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'candidate source anchor missing';
  END IF;
  IF (source."statusCode" IN ('draft','committed')
    AND source."resultCode" = NEW."resultCode"
    AND source."checkInAt" = NEW."checkInAt"
    AND source."checkOutAt" = NEW."checkOutAt") IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'candidate source snapshot mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION metric_candidate_receipt_shape_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c "ActivityMetricCandidate"%ROWTYPE; expected JSONB;
BEGIN
  SELECT * INTO c FROM "ActivityMetricCandidate"
    WHERE id = NEW."candidateId" AND "activityId" = NEW."activityId";
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'candidate receipt anchor missing';
  END IF;
  expected := jsonb_build_object(
    'schemaVersion', 1, 'candidateId', c.id, 'activityId', c."activityId",
    'revision', c."candidateRevision", 'metricSetVersionId', c."metricSetVersionId",
    'metricSetDefinitionHash', c."metricSetDefinitionHash",
    'createdStatusCode', 'candidate', 'sourceCode', 'system',
    'valueCount', c."valueCount", 'sourceCount', c."sourceCount",
    'createdAt', to_char(c."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  IF NEW."resultJson" IS DISTINCT FROM expected OR NEW."actorId" <> c."createdByUserId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'candidate receipt facts mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION metric_binding_receipt_shape_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b "ActivityMetricRuleBinding"%ROWTYPE; expected JSONB;
BEGIN
  SELECT * INTO b FROM "ActivityMetricRuleBinding" WHERE id = NEW."bindingId";
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'binding receipt anchor missing';
  END IF;
  expected := jsonb_build_object(
    'schemaVersion', 1, 'bindingId', b.id, 'bindingHash', b."bindingHash",
    'metricDefinitionId', b."metricDefinitionId", 'definitionHash', b."definitionHash",
    'ruleCode', b."ruleCode", 'evaluatorVersion', b."evaluatorVersion",
    'unitCode', b."unitCode", 'scale', b.scale,
    'createdAt', to_char(b."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  IF NEW."resultJson" IS DISTINCT FROM expected THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'binding receipt facts mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER metric_binding_immutable_trg BEFORE UPDATE OR DELETE ON "ActivityMetricRuleBinding" FOR EACH ROW EXECUTE FUNCTION metric_candidate_fact_immutable();

CREATE TRIGGER metric_candidate_immutable_trg BEFORE UPDATE OR DELETE ON "ActivityMetricCandidate" FOR EACH ROW EXECUTE FUNCTION metric_candidate_fact_immutable();

CREATE TRIGGER metric_candidate_value_immutable_trg BEFORE UPDATE OR DELETE ON "ActivityMetricCandidateValue" FOR EACH ROW EXECUTE FUNCTION metric_candidate_fact_immutable();

CREATE TRIGGER metric_candidate_source_immutable_trg BEFORE UPDATE OR DELETE ON "ActivityMetricCandidateSource" FOR EACH ROW EXECUTE FUNCTION metric_candidate_fact_immutable();

CREATE TRIGGER metric_candidate_receipt_immutable_trg BEFORE UPDATE OR DELETE ON "ActivityMetricCandidateCommandReceipt" FOR EACH ROW EXECUTE FUNCTION metric_candidate_fact_immutable();

CREATE TRIGGER metric_binding_receipt_immutable_trg BEFORE UPDATE OR DELETE ON "ActivityMetricRuleBindingCommandReceipt" FOR EACH ROW EXECUTE FUNCTION metric_candidate_fact_immutable();

CREATE CONSTRAINT TRIGGER metric_candidate_complete_trg AFTER INSERT ON "ActivityMetricCandidate" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION metric_candidate_aggregate_complete();

CREATE CONSTRAINT TRIGGER metric_candidate_value_complete_trg AFTER INSERT ON "ActivityMetricCandidateValue" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION metric_candidate_aggregate_complete();

CREATE CONSTRAINT TRIGGER metric_candidate_source_complete_trg AFTER INSERT ON "ActivityMetricCandidateSource" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION metric_candidate_aggregate_complete();

CREATE CONSTRAINT TRIGGER metric_candidate_receipt_complete_trg AFTER INSERT ON "ActivityMetricCandidateCommandReceipt" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION metric_candidate_aggregate_complete();

CREATE TRIGGER metric_candidate_source_insert_trg BEFORE INSERT ON "ActivityMetricCandidateSource" FOR EACH ROW EXECUTE FUNCTION metric_candidate_source_snapshot_check();

CREATE TRIGGER metric_candidate_receipt_insert_trg BEFORE INSERT ON "ActivityMetricCandidateCommandReceipt" FOR EACH ROW EXECUTE FUNCTION metric_candidate_receipt_shape_check();

CREATE TRIGGER metric_binding_receipt_insert_trg BEFORE INSERT ON "ActivityMetricRuleBindingCommandReceipt" FOR EACH ROW EXECUTE FUNCTION metric_binding_receipt_shape_check();

COMMIT;
