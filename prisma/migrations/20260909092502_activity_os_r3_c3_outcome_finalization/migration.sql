-- C3-2 implementation in progress: not approved for deployment.
-- Additive retained finalization facts. No backfill or business-data deletion.
BEGIN;

CREATE UNIQUE INDEX "candidate_value_outcome_origin_key" ON "ActivityMetricCandidateValue"("id", "activityId", "setVersionId", "definitionId");
CREATE UNIQUE INDEX "outcome_value_source_chain_key" ON "ActivityMetricValueRevision"("id", "outcomeRevisionId", "activityId", "setVersionId", "metricDefinitionId");
CREATE UNIQUE INDEX "outcome_value_origin_key" ON "ActivityMetricValueRevision"("id", "activityId", "setVersionId", "metricDefinitionId");

CREATE TABLE "ActivityOutcomeFinalizationReceipt" (
  "id" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "operationCode" TEXT NOT NULL,
  "operationKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "outcomeRevisionId" TEXT NOT NULL,
  "baseConfirmedRevisionId" TEXT,
  "resultJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ActivityOutcomeFinalizationReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outcome_finalization_actor_fk" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "outcome_finalization_outcome_fk" FOREIGN KEY ("outcomeRevisionId", "activityId") REFERENCES "ActivityOutcomeRevision"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "outcome_finalization_base_fk" FOREIGN KEY ("baseConfirmedRevisionId", "activityId") REFERENCES "ActivityOutcomeRevision"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "outcome_finalization_operation_check" CHECK (
    "operationCode" IN ('confirm_outcome', 'prepare_outcome_correction', 'cancel_outcome_correction')
    AND ("operationCode" = 'confirm_outcome' OR "baseConfirmedRevisionId" IS NOT NULL)
  ),
  CONSTRAINT "outcome_finalization_key_check" CHECK (length("operationKey") BETWEEN 1 AND 128 AND "operationKey" = btrim("operationKey")),
  CONSTRAINT "outcome_finalization_hash_check" CHECK ("requestHash" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "outcome_finalization_command_key" ON "ActivityOutcomeFinalizationReceipt"("actorUserId", "operationCode", "operationKey");
CREATE INDEX "outcome_finalization_outcome_idx" ON "ActivityOutcomeFinalizationReceipt"("outcomeRevisionId", "activityId");
CREATE INDEX "outcome_finalization_base_idx" ON "ActivityOutcomeFinalizationReceipt"("baseConfirmedRevisionId", "activityId");

CREATE TABLE "ActivityOutcomeValueSource" (
  "id" TEXT NOT NULL,
  "valueRevisionId" TEXT NOT NULL,
  "outcomeRevisionId" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "setVersionId" TEXT NOT NULL,
  "metricDefinitionId" TEXT NOT NULL,
  "sourceKind" TEXT NOT NULL,
  "manualValueRevisionId" TEXT,
  "candidateValueId" TEXT,
  "preparedAgainstRevision" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ActivityOutcomeValueSource_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outcome_source_value_fk" FOREIGN KEY ("valueRevisionId", "outcomeRevisionId", "activityId", "setVersionId", "metricDefinitionId") REFERENCES "ActivityMetricValueRevision"("id", "outcomeRevisionId", "activityId", "setVersionId", "metricDefinitionId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "outcome_source_manual_fk" FOREIGN KEY ("manualValueRevisionId", "activityId", "setVersionId", "metricDefinitionId") REFERENCES "ActivityMetricValueRevision"("id", "activityId", "setVersionId", "metricDefinitionId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "outcome_source_candidate_fk" FOREIGN KEY ("candidateValueId", "activityId", "setVersionId", "metricDefinitionId") REFERENCES "ActivityMetricCandidateValue"("id", "activityId", "setVersionId", "definitionId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "outcome_source_kind_check" CHECK ((
    ("sourceKind" = 'manual' AND "candidateValueId" IS NULL AND "preparedAgainstRevision" IS NULL)
    OR ("sourceKind" = 'system' AND "candidateValueId" IS NOT NULL AND "manualValueRevisionId" IS NULL AND "preparedAgainstRevision" >= 0)
  ) IS TRUE),
  CONSTRAINT "outcome_source_no_self_check" CHECK ("manualValueRevisionId" IS DISTINCT FROM "valueRevisionId")
);
CREATE UNIQUE INDEX "outcome_source_value_key" ON "ActivityOutcomeValueSource"("valueRevisionId");
CREATE INDEX "outcome_source_manual_idx" ON "ActivityOutcomeValueSource"("manualValueRevisionId", "activityId", "setVersionId", "metricDefinitionId");
CREATE INDEX "outcome_source_candidate_idx" ON "ActivityOutcomeValueSource"("candidateValueId", "activityId", "setVersionId", "metricDefinitionId");

CREATE FUNCTION outcome_finalization_retained_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'finalization facts are append-only';
END;
$$;
CREATE TRIGGER outcome_finalization_receipt_immutable
BEFORE UPDATE OR DELETE ON "ActivityOutcomeFinalizationReceipt"
FOR EACH ROW EXECUTE FUNCTION outcome_finalization_retained_immutable();
CREATE TRIGGER outcome_finalization_source_immutable
BEFORE UPDATE OR DELETE ON "ActivityOutcomeValueSource"
FOR EACH ROW EXECUTE FUNCTION outcome_finalization_retained_immutable();

-- Serialize child assembly with head transitions. Both old C2 and new C3
-- creation receipts seal a head; cancellation is not a creation receipt.
CREATE FUNCTION outcome_finalization_child_seal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target "ActivityOutcomeRevision"%ROWTYPE;
BEGIN
  SELECT * INTO target FROM "ActivityOutcomeRevision"
    WHERE id = NEW."outcomeRevisionId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'outcome parent unavailable';
  END IF;
  IF target."statusCode" = 'superseded' OR EXISTS (
    SELECT 1 FROM "ActivityOutcomeCommandReceipt" r WHERE r."outcomeRevisionId" = target.id
  ) OR EXISTS (
    SELECT 1 FROM "ActivityOutcomeFinalizationReceipt" r
    WHERE r."outcomeRevisionId" = target.id
      AND r."operationCode" IN ('confirm_outcome', 'prepare_outcome_correction')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'outcome facts are sealed';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER outcome_finalization_value_guard
BEFORE INSERT ON "ActivityMetricValueRevision"
FOR EACH ROW EXECUTE FUNCTION outcome_finalization_child_seal_guard();
CREATE TRIGGER outcome_finalization_evidence_guard
BEFORE INSERT ON "ActivityMetricValueEvidence"
FOR EACH ROW EXECUTE FUNCTION outcome_finalization_child_seal_guard();
CREATE TRIGGER outcome_finalization_source_seal_guard
BEFORE INSERT ON "ActivityOutcomeValueSource"
FOR EACH ROW EXECUTE FUNCTION outcome_finalization_child_seal_guard();

-- Historical confirmed heads deliberately receive no backfilled receipt. A
-- deferred child check seals them without preventing new head/value/evidence/
-- source/receipt assembly in one transaction. Do not infer age from timestamps.
CREATE FUNCTION outcome_finalization_formal_child_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ActivityOutcomeRevision" o
    WHERE o.id = NEW."outcomeRevisionId" AND o."statusCode" IN ('confirmed', 'superseded')
  ) AND NOT EXISTS (
    SELECT 1 FROM "ActivityOutcomeFinalizationReceipt" r
    WHERE r."outcomeRevisionId" = NEW."outcomeRevisionId"
      AND r."operationCode" IN ('confirm_outcome', 'prepare_outcome_correction')
  ) AND NOT EXISTS (
    SELECT 1 FROM "ActivityOutcomeCommandReceipt" r
    WHERE r."outcomeRevisionId" = NEW."outcomeRevisionId"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'historical formal outcome facts are sealed';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER outcome_formal_value_complete
AFTER INSERT ON "ActivityMetricValueRevision" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION outcome_finalization_formal_child_complete();
CREATE CONSTRAINT TRIGGER outcome_formal_evidence_complete
AFTER INSERT ON "ActivityMetricValueEvidence" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION outcome_finalization_formal_child_complete();
CREATE CONSTRAINT TRIGGER outcome_formal_source_complete
AFTER INSERT ON "ActivityOutcomeValueSource" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION outcome_finalization_formal_child_complete();

CREATE FUNCTION outcome_finalization_source_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target "ActivityMetricValueRevision"%ROWTYPE;
  prior "ActivityMetricValueRevision"%ROWTYPE;
  target_revision INTEGER;
  prior_revision INTEGER;
  candidate "ActivityMetricCandidateValue"%ROWTYPE;
BEGIN
  SELECT * INTO target FROM "ActivityMetricValueRevision" WHERE id = NEW."valueRevisionId";
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'source target unavailable';
  END IF;
  IF target."sourceCode" IS DISTINCT FROM NEW."sourceKind" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'source kind mismatch';
  END IF;
  IF NEW."sourceKind" = 'manual' AND NEW."manualValueRevisionId" IS NOT NULL THEN
    SELECT * INTO prior FROM "ActivityMetricValueRevision" WHERE id = NEW."manualValueRevisionId";
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'manual source unavailable';
    END IF;
    SELECT revision INTO target_revision FROM "ActivityOutcomeRevision" WHERE id = target."outcomeRevisionId";
    SELECT revision INTO prior_revision FROM "ActivityOutcomeRevision" WHERE id = prior."outcomeRevisionId";
    IF (prior."sourceCode" = 'manual' AND prior_revision < target_revision
      AND prior."valueJson" = target."valueJson" AND prior."valueHash" = target."valueHash") IS NOT TRUE THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'manual source must copy an earlier manual value';
    END IF;
  ELSIF NEW."sourceKind" = 'system' THEN
    SELECT * INTO candidate FROM "ActivityMetricCandidateValue" WHERE id = NEW."candidateValueId";
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'candidate source unavailable';
    END IF;
    IF (candidate."valueJson" = target."valueJson" AND candidate."valueHash" = target."valueHash") IS NOT TRUE THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'candidate value copy mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER outcome_finalization_source_guard
BEFORE INSERT ON "ActivityOutcomeValueSource"
FOR EACH ROW EXECUTE FUNCTION outcome_finalization_source_check();

-- Validate retained formal facts before adding stronger constraints. Fail the
-- whole migration rather than rewriting or discarding a historical result.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ActivityOutcomeRevision" o WHERE o."statusCode" = 'confirmed'
    AND (
      (SELECT count(*) FROM "ActivityMetricValueRevision" v WHERE v."outcomeRevisionId" = o.id) NOT BETWEEN 1 AND 100
      OR EXISTS (
        SELECT 1 FROM "ActivityMetricSetItem" i
        WHERE i."setVersionId" = o."metricSetVersionId" AND i.required
          AND NOT EXISTS (SELECT 1 FROM "ActivityMetricValueRevision" v WHERE v."outcomeRevisionId" = o.id AND v."metricDefinitionId" = i."metricDefinitionId")
      )
      OR EXISTS (
        SELECT 1 FROM "ActivityMetricValueRevision" v WHERE v."outcomeRevisionId" = o.id AND (
          v."confirmedByUserId" IS NULL OR v."confirmedAt" IS NULL
          OR v."sourceReference" IS NULL OR v."calculatedByRuleVersion" IS NULL
          OR v."sourceCode" NOT IN ('manual', 'system')
          OR (SELECT count(*) FROM "ActivityMetricValueEvidence" e WHERE e."valueRevisionId" = v.id) NOT BETWEEN 1 AND 20
        )
      )
      OR (SELECT count(DISTINCT v."confirmedByUserId") FROM "ActivityMetricValueRevision" v WHERE v."outcomeRevisionId" = o.id) <> 1
      OR (SELECT count(DISTINCT v."confirmedAt") FROM "ActivityMetricValueRevision" v WHERE v."outcomeRevisionId" = o.id) <> 1
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'retained formal outcome is incomplete';
  END IF;
END;
$$;
CREATE UNIQUE INDEX "outcome_one_confirmed_per_activity"
ON "ActivityOutcomeRevision"("activityId") WHERE "statusCode" = 'confirmed';

CREATE FUNCTION outcome_finalization_lifecycle_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."statusCode" NOT IN ('draft', 'confirmed') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'new outcome must be draft or confirmed';
    END IF;
  ELSIF NEW."statusCode" IS DISTINCT FROM OLD."statusCode" THEN
    IF OLD."statusCode" NOT IN ('draft', 'confirmed') OR NEW."statusCode" <> 'superseded' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'illegal outcome lifecycle transition';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER outcome_lifecycle_guard
BEFORE INSERT OR UPDATE ON "ActivityOutcomeRevision"
FOR EACH ROW EXECUTE FUNCTION outcome_finalization_lifecycle_check();

CREATE FUNCTION outcome_finalization_receipt_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target "ActivityOutcomeRevision"%ROWTYPE;
  expected_status TEXT;
BEGIN
  SELECT * INTO target FROM "ActivityOutcomeRevision"
    WHERE id = NEW."outcomeRevisionId" AND "activityId" = NEW."activityId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'finalization target unavailable';
  END IF;
  expected_status := CASE NEW."operationCode"
    WHEN 'confirm_outcome' THEN 'confirmed'
    WHEN 'prepare_outcome_correction' THEN 'draft'
    WHEN 'cancel_outcome_correction' THEN 'superseded' END;
  IF (
    jsonb_typeof(NEW."resultJson") = 'object'
    AND NEW."resultJson" ?& ARRAY['schemaVersion','activityId','outcomeRevisionId','revision','createdStatusCode','valueCount','evidenceCount','createdAt','operationCode']
    AND NEW."resultJson" - ARRAY['schemaVersion','activityId','outcomeRevisionId','revision','createdStatusCode','valueCount','evidenceCount','createdAt','operationCode'] = '{}'::jsonb
    AND NEW."resultJson"->'schemaVersion' = '1'::jsonb
    AND NEW."resultJson"->'activityId' = to_jsonb(NEW."activityId")
    AND NEW."resultJson"->'outcomeRevisionId' = to_jsonb(NEW."outcomeRevisionId")
    AND NEW."resultJson"->'revision' = to_jsonb(target.revision)
    AND NEW."resultJson"->'operationCode' = to_jsonb(NEW."operationCode")
    AND NEW."resultJson"->'createdStatusCode' = to_jsonb(expected_status)
    AND NEW."resultJson"->'createdAt' = to_jsonb(to_char(NEW."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    AND jsonb_typeof(NEW."resultJson"->'valueCount') = 'number'
    AND NEW."resultJson"->>'valueCount' ~ '^[1-9][0-9]{0,2}$'
    AND jsonb_typeof(NEW."resultJson"->'evidenceCount') = 'number'
    AND NEW."resultJson"->>'evidenceCount' ~ '^(0|[1-9][0-9]{0,3})$'
    AND target."statusCode" = expected_status
  ) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'finalization receipt shape mismatch';
  END IF;
  IF NEW."operationCode" <> 'cancel_outcome_correction' THEN
    IF target."createdByUserId" IS DISTINCT FROM NEW."actorUserId"
      OR target."createdAt" IS DISTINCT FROM NEW."createdAt"
      OR EXISTS (SELECT 1 FROM "ActivityOutcomeCommandReceipt" r WHERE r."outcomeRevisionId" = target.id)
      OR EXISTS (SELECT 1 FROM "ActivityOutcomeFinalizationReceipt" r WHERE r."outcomeRevisionId" = target.id AND r."operationCode" IN ('confirm_outcome','prepare_outcome_correction'))
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'finalization creation already sealed or mismatched';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM "ActivityOutcomeFinalizationReceipt" r
      WHERE r."outcomeRevisionId" = target.id AND r."operationCode" = 'prepare_outcome_correction'
        AND r."baseConfirmedRevisionId" = NEW."baseConfirmedRevisionId"
    ) OR EXISTS (
      SELECT 1 FROM "ActivityOutcomeFinalizationReceipt" r
      WHERE r."outcomeRevisionId" = target.id AND r."operationCode" = 'cancel_outcome_correction'
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'cancellation requires an uncancelled correction preparation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER outcome_finalization_receipt_guard
BEFORE INSERT ON "ActivityOutcomeFinalizationReceipt"
FOR EACH ROW EXECUTE FUNCTION outcome_finalization_receipt_check();

CREATE FUNCTION outcome_finalization_complete_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target "ActivityOutcomeRevision"%ROWTYPE;
  value_count BIGINT;
  evidence_count BIGINT;
BEGIN
  SELECT * INTO target FROM "ActivityOutcomeRevision" WHERE id = NEW."outcomeRevisionId";
  SELECT count(*) INTO value_count FROM "ActivityMetricValueRevision" WHERE "outcomeRevisionId" = target.id;
  SELECT count(*) INTO evidence_count FROM "ActivityMetricValueEvidence" WHERE "outcomeRevisionId" = target.id;
  IF value_count NOT BETWEEN 1 AND 100 OR evidence_count > value_count * 20
    OR NEW."resultJson"->'valueCount' IS DISTINCT FROM to_jsonb(value_count)
    OR NEW."resultJson"->'evidenceCount' IS DISTINCT FROM to_jsonb(evidence_count)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'finalization receipt aggregate mismatch';
  END IF;
  IF NEW."operationCode" = 'cancel_outcome_correction' THEN
    IF NOT EXISTS (SELECT 1 FROM "ActivityOutcomeRevision" b WHERE b.id = NEW."baseConfirmedRevisionId" AND b."statusCode" = 'confirmed')
      OR target."statusCode" <> 'superseded'
      OR EXISTS (SELECT 1 FROM "ActivityOutcomeRevision" later WHERE later."activityId" = target."activityId" AND later.revision > target.revision)
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'cancellation base or latest target mismatch';
    END IF;
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM "ActivityMetricValueRevision" v
    LEFT JOIN "ActivityOutcomeValueSource" s ON s."valueRevisionId" = v.id
    WHERE v."outcomeRevisionId" = target.id AND (
      s.id IS NULL OR s."createdAt" <> target."createdAt" OR v."createdAt" <> target."createdAt"
      OR (SELECT count(*) FROM "ActivityMetricValueEvidence" e WHERE e."valueRevisionId" = v.id) > 20
      OR EXISTS (SELECT 1 FROM "ActivityMetricValueEvidence" e WHERE e."valueRevisionId" = v.id AND e."createdAt" <> target."createdAt")
      OR (NEW."operationCode" = 'prepare_outcome_correction' AND (v."confirmedByUserId" IS NOT NULL OR v."confirmedAt" IS NOT NULL))
      OR (NEW."operationCode" = 'confirm_outcome' AND (
        v."confirmedByUserId" IS DISTINCT FROM NEW."actorUserId" OR v."confirmedAt" IS DISTINCT FROM NEW."createdAt"
        OR (SELECT count(*) FROM "ActivityMetricValueEvidence" e WHERE e."valueRevisionId" = v.id) < 1
        OR (s."sourceKind" = 'manual' AND (s."manualValueRevisionId" IS NULL OR NOT EXISTS (
          SELECT 1 FROM "ActivityMetricValueRevision" p WHERE p.id = s."manualValueRevisionId" AND p."outcomeRevisionId" = target."priorRevisionId"
        )))
      ))
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'finalization values or sources incomplete';
  END IF;
  IF NEW."operationCode" = 'confirm_outcome' AND EXISTS (
    SELECT 1 FROM "ActivityMetricSetItem" i WHERE i."setVersionId" = target."metricSetVersionId" AND i.required
      AND NOT EXISTS (SELECT 1 FROM "ActivityMetricValueRevision" v WHERE v."outcomeRevisionId" = target.id AND v."metricDefinitionId" = i."metricDefinitionId")
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'required formal metrics missing';
  END IF;
  IF NEW."baseConfirmedRevisionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "ActivityOutcomeRevision" b WHERE b.id = NEW."baseConfirmedRevisionId"
      AND b.revision < target.revision AND b."statusCode" = CASE NEW."operationCode" WHEN 'confirm_outcome' THEN 'superseded' ELSE 'confirmed' END
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'finalization base mismatch';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER outcome_finalization_complete_guard
AFTER INSERT ON "ActivityOutcomeFinalizationReceipt"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION outcome_finalization_complete_check();

-- The BEFORE/DEFERRED pair proves a matching receipt was added after this
-- transition began, without relying on timestamps, xmin or a mutable session flag.
CREATE FUNCTION outcome_finalization_has_successor(target_id TEXT, old_status TEXT) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "ActivityOutcomeRevision" successor
    JOIN "ActivityOutcomeCommandReceipt" receipt ON receipt."outcomeRevisionId" = successor.id
    WHERE old_status = 'draft' AND successor."priorRevisionId" = target_id
  ) OR EXISTS (
    SELECT 1 FROM "ActivityOutcomeRevision" successor
    JOIN "ActivityOutcomeFinalizationReceipt" receipt ON receipt."outcomeRevisionId" = successor.id
    WHERE (old_status = 'draft' AND successor."priorRevisionId" = target_id
      AND receipt."operationCode" IN ('confirm_outcome','prepare_outcome_correction'))
      OR (old_status = 'confirmed' AND receipt."baseConfirmedRevisionId" = target_id
        AND receipt."operationCode" = 'confirm_outcome')
  ) OR EXISTS (
    SELECT 1 FROM "ActivityOutcomeFinalizationReceipt" receipt
    WHERE old_status = 'draft' AND receipt."outcomeRevisionId" = target_id
      AND receipt."operationCode" = 'cancel_outcome_correction'
  );
$$;

CREATE FUNCTION outcome_finalization_transition_start() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."statusCode" IS DISTINCT FROM OLD."statusCode"
    AND outcome_finalization_has_successor(OLD.id, OLD."statusCode") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'old receipt cannot authorize a new outcome transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER outcome_finalization_transition_start_guard
BEFORE UPDATE ON "ActivityOutcomeRevision"
FOR EACH ROW EXECUTE FUNCTION outcome_finalization_transition_start();

CREATE FUNCTION outcome_finalization_head_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."statusCode" = 'confirmed' AND NOT EXISTS (
      SELECT 1 FROM "ActivityOutcomeFinalizationReceipt" receipt
      WHERE receipt."outcomeRevisionId" = NEW.id AND receipt."operationCode" = 'confirm_outcome'
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'new confirmed outcome requires finalization receipt';
    END IF;
  ELSIF NEW."statusCode" IS DISTINCT FROM OLD."statusCode" THEN
    IF NOT outcome_finalization_has_successor(OLD.id, OLD."statusCode") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'outcome transition lacks a new successor receipt';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER outcome_finalization_head_guard
AFTER INSERT OR UPDATE ON "ActivityOutcomeRevision"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION outcome_finalization_head_check();

-- Scalar/configuration validation only. Canonical SHA-256 remains the existing
-- TypeScript contract; PostgreSQL JSONB does not preserve JSON lexical spelling.
CREATE FUNCTION outcome_finalization_value_valid(value_json JSONB, config JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE text_value TEXT; scale_value INTEGER; numeric_value NUMERIC;
BEGIN
  CASE config->>'kindCode'
  WHEN 'non_negative_integer' THEN
    IF jsonb_typeof(value_json) <> 'number' THEN RETURN FALSE; END IF;
    numeric_value := (value_json #>> '{}')::numeric;
    RETURN coalesce(numeric_value = trunc(numeric_value)
      AND numeric_value BETWEEN 0 AND 9007199254740991
      AND numeric_value BETWEEN (config->>'minimum')::numeric AND (config->>'maximum')::numeric, FALSE);
  WHEN 'non_negative_decimal' THEN
    IF jsonb_typeof(value_json) <> 'string' THEN RETURN FALSE; END IF;
    text_value := value_json #>> '{}';
    scale_value := (config->>'scale')::integer;
    IF length(text_value) > 20 OR text_value !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
      OR length(split_part(text_value, '.', 1)) > 18 - scale_value
      OR length(split_part(text_value, '.', 2)) > scale_value THEN RETURN FALSE; END IF;
    RETURN coalesce(text_value::numeric BETWEEN (config->>'minimum')::numeric AND (config->>'maximum')::numeric, FALSE);
  WHEN 'boolean' THEN
    RETURN jsonb_typeof(value_json) = 'boolean';
  WHEN 'single_choice' THEN
    IF jsonb_typeof(value_json) <> 'string' THEN RETURN FALSE; END IF;
    RETURN EXISTS (SELECT 1 FROM jsonb_array_elements(config->'options') option WHERE option->'code' = value_json);
  ELSE
    RETURN FALSE;
  END CASE;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ActivityMetricValueRevision" value
    JOIN "ActivityOutcomeRevision" outcome ON outcome.id = value."outcomeRevisionId"
    JOIN "ActivityMetricDefinition" definition ON definition.id = value."metricDefinitionId"
    WHERE outcome."statusCode" = 'confirmed'
      AND outcome_finalization_value_valid(value."valueJson", definition."configurationJson") IS NOT TRUE
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'retained formal value violates its definition';
  END IF;
END;
$$;

CREATE FUNCTION outcome_finalization_definition_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."operationCode" <> 'cancel_outcome_correction' AND EXISTS (
    SELECT 1 FROM "ActivityMetricValueRevision" value
    JOIN "ActivityMetricDefinition" definition ON definition.id = value."metricDefinitionId"
    WHERE value."outcomeRevisionId" = NEW."outcomeRevisionId"
      AND outcome_finalization_value_valid(value."valueJson", definition."configurationJson") IS NOT TRUE
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'finalization value violates its definition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER outcome_finalization_definition_guard
AFTER INSERT ON "ActivityOutcomeFinalizationReceipt"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION outcome_finalization_definition_check();

CREATE FUNCTION outcome_finalization_creation_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target "ActivityOutcomeRevision"%ROWTYPE;
  prior "ActivityOutcomeRevision"%ROWTYPE;
  expected_source_revision INTEGER;
BEGIN
  IF NEW."operationCode" = 'cancel_outcome_correction' THEN RETURN NEW; END IF;
  SELECT * INTO target FROM "ActivityOutcomeRevision" WHERE id = NEW."outcomeRevisionId";
  SELECT * INTO prior FROM "ActivityOutcomeRevision" WHERE id = target."priorRevisionId";
  IF target.revision <> coalesce(prior.revision, 0) + 1
    OR EXISTS (SELECT 1 FROM "ActivityOutcomeRevision" later WHERE later."activityId" = target."activityId" AND later.revision > target.revision)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'finalization must append to the latest revision';
  END IF;
  expected_source_revision := coalesce(prior.revision, 0);
  IF NEW."operationCode" = 'confirm_outcome' AND NEW."baseConfirmedRevisionId" IS NOT NULL THEN
    IF prior."statusCode" IS DISTINCT FROM 'superseded' OR NOT EXISTS (
      SELECT 1 FROM "ActivityOutcomeFinalizationReceipt" preparation
      WHERE preparation."outcomeRevisionId" = prior.id AND preparation."operationCode" = 'prepare_outcome_correction'
        AND preparation."baseConfirmedRevisionId" = NEW."baseConfirmedRevisionId"
    ) OR EXISTS (
      SELECT 1 FROM "ActivityOutcomeFinalizationReceipt" cancelled
      WHERE cancelled."outcomeRevisionId" = prior.id AND cancelled."operationCode" = 'cancel_outcome_correction'
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'confirmation must use its uncancelled correction draft';
    END IF;
    SELECT revision INTO expected_source_revision FROM "ActivityOutcomeRevision" WHERE id = prior."priorRevisionId";
  ELSIF NEW."operationCode" = 'confirm_outcome' THEN
    IF (prior.id IS NOT NULL AND (prior."statusCode" <> 'superseded' OR NOT EXISTS (
      SELECT 1 FROM "ActivityOutcomeCommandReceipt" receipt WHERE receipt."outcomeRevisionId" = prior.id
    ))) OR EXISTS (
      SELECT 1 FROM "ActivityOutcomeRevision" historical
      JOIN "ActivityMetricValueRevision" value ON value."outcomeRevisionId" = historical.id
      WHERE historical."activityId" = target."activityId" AND historical.id <> target.id AND value."confirmedAt" IS NOT NULL
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'initial confirmation cannot replace a prior formal outcome';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM "ActivityOutcomeValueSource" source
    JOIN "ActivityMetricCandidateValue" candidate_value ON candidate_value.id = source."candidateValueId"
    JOIN "ActivityMetricCandidate" candidate ON candidate.id = candidate_value."candidateId"
    WHERE source."outcomeRevisionId" = target.id AND source."sourceKind" = 'system'
      AND (source."preparedAgainstRevision" IS DISTINCT FROM expected_source_revision
        OR candidate."expectedOutcomeRevision" IS DISTINCT FROM source."preparedAgainstRevision")
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'candidate preparation revision mismatch';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER outcome_finalization_creation_guard
AFTER INSERT ON "ActivityOutcomeFinalizationReceipt"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION outcome_finalization_creation_check();

-- Full upgrade and command-path tests remain in progress.
-- Do not deploy this work-in-progress file before those guards and upgrade tests are complete.
COMMIT;
