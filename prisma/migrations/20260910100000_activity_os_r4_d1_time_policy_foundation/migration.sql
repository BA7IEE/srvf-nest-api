BEGIN;

CREATE TABLE "TimePolicy" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT tp_code_check CHECK ("code" ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT tp_name_check CHECK (char_length("name") BETWEEN 1 AND 120 AND "name" !~ '^[[:space:]]|[[:space:]]$')
);
CREATE UNIQUE INDEX tp_code_key ON "TimePolicy"("code");

CREATE TABLE "TimePolicyVersion" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "policyId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "schemaVersion" INTEGER NOT NULL,
  "definitionJson" JSONB NOT NULL,
  "definitionHash" TEXT NOT NULL,
  "evaluatorVersion" INTEGER NOT NULL,
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "effectiveUntil" TIMESTAMP(3),
  "statusCode" TEXT NOT NULL,
  "activatedAt" TIMESTAMP(3),
  "retiredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT tpv_policy_fk FOREIGN KEY ("policyId") REFERENCES "TimePolicy"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT tpv_version_check CHECK ("version" > 0 AND "schemaVersion" = 1 AND "evaluatorVersion" = 1),
  CONSTRAINT tpv_hash_check CHECK ("definitionHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT tpv_interval_check CHECK (isfinite("effectiveFrom") AND ("effectiveUntil" IS NULL OR (isfinite("effectiveUntil") AND "effectiveUntil" > "effectiveFrom"))),
  CONSTRAINT tpv_status_check CHECK (
    ("statusCode" = 'draft' AND "activatedAt" IS NULL AND "retiredAt" IS NULL) OR
    ("statusCode" = 'active' AND "activatedAt" IS NOT NULL AND isfinite("activatedAt") AND "retiredAt" IS NULL) OR
    ("statusCode" = 'retired' AND "activatedAt" IS NOT NULL AND "retiredAt" IS NOT NULL AND isfinite("activatedAt") AND isfinite("retiredAt") AND "retiredAt" >= "activatedAt")
  ),
  CONSTRAINT tpv_definition_shape_check CHECK ((
    jsonb_typeof("definitionJson") = 'object' AND
    "definitionJson" ?& ARRAY['defaultCategory','roleMappings','allowSplit','specialIntervals','rounding','evidence','manualAdjustment'] AND
    "definitionJson" - ARRAY['defaultCategory','roleMappings','allowSplit','specialIntervals','rounding','evidence','manualAdjustment'] = '{}'::jsonb AND
    jsonb_typeof("definitionJson"->'defaultCategory') = 'string' AND
    "definitionJson"->>'defaultCategory' IN ('volunteer_service','training','organization','non_creditable') AND
    jsonb_typeof("definitionJson"->'roleMappings') = 'array' AND
    jsonb_typeof("definitionJson"->'allowSplit') = 'boolean' AND
    jsonb_typeof("definitionJson"->'specialIntervals') = 'object' AND
    jsonb_typeof("definitionJson"->'rounding') = 'object' AND
    jsonb_typeof("definitionJson"->'evidence') = 'object' AND
    jsonb_typeof("definitionJson"->'manualAdjustment') = 'object'
  ) IS TRUE)
);
CREATE UNIQUE INDEX tpv_policy_version_key ON "TimePolicyVersion"("policyId", "version");
CREATE UNIQUE INDEX tpv_id_policy_hash_key ON "TimePolicyVersion"("id", "policyId", "definitionHash");
CREATE INDEX tpv_policy_status_idx ON "TimePolicyVersion"("policyId", "statusCode");

CREATE TABLE "TimePolicyCommandReceipt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "actorUserId" TEXT NOT NULL,
  "operationCode" TEXT NOT NULL,
  "operationKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "policyId" TEXT NOT NULL,
  "versionId" TEXT,
  "definitionHash" TEXT,
  "resultJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT tpr_actor_fk FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT tpr_policy_fk FOREIGN KEY ("policyId") REFERENCES "TimePolicy"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT tpr_version_anchor_fk FOREIGN KEY ("versionId", "policyId", "definitionHash") REFERENCES "TimePolicyVersion"("id", "policyId", "definitionHash") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT tpr_shape_check CHECK (
    char_length("operationKey") BETWEEN 1 AND 128 AND "operationKey" ~ '[^[:space:]]' AND "operationKey" !~ '[[:cntrl:]]' AND
    "requestHash" ~ '^[a-f0-9]{64}$' AND
    (("operationCode" = 'create_policy' AND "versionId" IS NULL AND "definitionHash" IS NULL) OR
     ("operationCode" IN ('create_version','activate_version','retire_version') AND "versionId" IS NOT NULL AND "definitionHash" IS NOT NULL AND "definitionHash" ~ '^[a-f0-9]{64}$'))
  ),
  CONSTRAINT tpr_result_check CHECK ((
    jsonb_typeof("resultJson") = 'object' AND
    "resultJson" ?& ARRAY['schemaVersion','operationCode','policyId','versionId','definitionHash','resultStatusCode','createdAt'] AND
    "resultJson" - ARRAY['schemaVersion','operationCode','policyId','versionId','definitionHash','resultStatusCode','createdAt'] = '{}'::jsonb AND
    "resultJson"->'schemaVersion' = '1'::jsonb AND
    "resultJson"->'operationCode' = to_jsonb("operationCode") AND
    "resultJson"->'policyId' = to_jsonb("policyId") AND
    "resultJson"->'versionId' = COALESCE(to_jsonb("versionId"), 'null'::jsonb) AND
    "resultJson"->'definitionHash' = COALESCE(to_jsonb("definitionHash"), 'null'::jsonb) AND
    "resultJson"->'resultStatusCode' = CASE "operationCode"
      WHEN 'create_policy' THEN 'null'::jsonb WHEN 'create_version' THEN '"draft"'::jsonb
      WHEN 'activate_version' THEN '"active"'::jsonb WHEN 'retire_version' THEN '"retired"'::jsonb END AND
    jsonb_typeof("resultJson"->'createdAt') = 'string' AND
    "resultJson"->>'createdAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  ) IS TRUE)
);
CREATE UNIQUE INDEX tpr_command_key ON "TimePolicyCommandReceipt"("actorUserId", "operationCode", "operationKey");
CREATE INDEX tpr_policy_idx ON "TimePolicyCommandReceipt"("policyId");
CREATE INDEX tpr_version_idx ON "TimePolicyCommandReceipt"("versionId");

CREATE FUNCTION tp_identity_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'time policy history is retained' USING ERRCODE = '23514'; END IF;
  IF ROW(NEW."id",NEW."code",NEW."createdAt") IS DISTINCT FROM ROW(OLD."id",OLD."code",OLD."createdAt") THEN
    RAISE EXCEPTION 'time policy identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tp_identity_guard BEFORE UPDATE OR DELETE ON "TimePolicy" FOR EACH ROW EXECUTE FUNCTION tp_identity_guard_fn();

CREATE FUNCTION tpv_immutable_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'time policy version is retained' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."statusCode" <> 'draft' THEN RAISE EXCEPTION 'time policy version starts draft' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['statusCode','activatedAt','retiredAt','updatedAt']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['statusCode','activatedAt','retiredAt','updatedAt']) THEN
    RAISE EXCEPTION 'time policy version semantics are immutable' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW."statusCode",NEW."activatedAt",NEW."retiredAt") IS NOT DISTINCT FROM ROW(OLD."statusCode",OLD."activatedAt",OLD."retiredAt") THEN RETURN NEW; END IF;
  IF OLD."statusCode" = 'draft' AND NEW."statusCode" = 'active' AND NEW."activatedAt" IS NOT NULL AND NEW."retiredAt" IS NULL THEN RETURN NEW; END IF;
  IF OLD."statusCode" = 'active' AND NEW."statusCode" = 'retired' AND NEW."activatedAt" IS NOT DISTINCT FROM OLD."activatedAt" AND NEW."retiredAt" IS NOT NULL THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid time policy version transition' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER tpv_immutable_guard BEFORE INSERT OR UPDATE OR DELETE ON "TimePolicyVersion" FOR EACH ROW EXECUTE FUNCTION tpv_immutable_guard_fn();

CREATE FUNCTION tpr_immutable_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parsed TIMESTAMP;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'time policy receipt is immutable' USING ERRCODE = '23514'; END IF;
  BEGIN
    parsed := (NEW."resultJson"->>'createdAt')::timestamp;
    IF parsed IS NULL OR NOT isfinite(parsed) OR to_char(parsed, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM NEW."resultJson"->>'createdAt' THEN
      RAISE EXCEPTION 'invalid receipt timestamp';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'invalid time policy receipt timestamp' USING ERRCODE = '23514';
  END;
  RETURN NEW;
END $$;
CREATE TRIGGER tpr_immutable_guard BEFORE INSERT OR UPDATE OR DELETE ON "TimePolicyCommandReceipt" FOR EACH ROW EXECUTE FUNCTION tpr_immutable_guard_fn();

COMMIT;
