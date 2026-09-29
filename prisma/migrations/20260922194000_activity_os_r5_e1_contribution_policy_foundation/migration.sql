BEGIN;

CREATE TABLE "ContributionPolicy" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT cp_code_check CHECK ("code" ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT cp_name_check CHECK (
    char_length("name") BETWEEN 1 AND 120 AND
    "name" !~ '^[[:space:]]|[[:space:]]$'
  ),
  CONSTRAINT cp_description_check CHECK (
    "description" IS NULL OR (
      char_length("description") BETWEEN 1 AND 500 AND
      "description" !~ '^[[:space:]]|[[:space:]]$'
    )
  )
);
CREATE UNIQUE INDEX cp_code_key ON "ContributionPolicy"("code");

CREATE TABLE "ContributionPolicyVersion" (
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
  "createdByUserId" TEXT NOT NULL,
  "activatedByUserId" TEXT,
  "retiredByUserId" TEXT,
  "activatedAt" TIMESTAMP(3),
  "retiredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT cpv_policy_fk FOREIGN KEY ("policyId") REFERENCES "ContributionPolicy"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT cpv_creator_fk FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT cpv_activator_fk FOREIGN KEY ("activatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT cpv_retirer_fk FOREIGN KEY ("retiredByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT cpv_version_check CHECK (
    "version" > 0 AND "schemaVersion" = 1 AND "evaluatorVersion" = 1
  ),
  CONSTRAINT cpv_hash_check CHECK ("definitionHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT cpv_interval_check CHECK (
    isfinite("effectiveFrom") AND (
      "effectiveUntil" IS NULL OR (
        isfinite("effectiveUntil") AND "effectiveUntil" > "effectiveFrom"
      )
    )
  ),
  CONSTRAINT cpv_status_check CHECK (
    (
      "statusCode" = 'draft' AND
      "activatedAt" IS NULL AND "activatedByUserId" IS NULL AND
      "retiredAt" IS NULL AND "retiredByUserId" IS NULL
    ) OR (
      "statusCode" = 'active' AND
      "activatedAt" IS NOT NULL AND isfinite("activatedAt") AND
      "activatedByUserId" IS NOT NULL AND
      "retiredAt" IS NULL AND "retiredByUserId" IS NULL
    ) OR (
      "statusCode" = 'retired' AND
      "activatedAt" IS NOT NULL AND isfinite("activatedAt") AND
      "activatedByUserId" IS NOT NULL AND
      "retiredAt" IS NOT NULL AND isfinite("retiredAt") AND
      "retiredByUserId" IS NOT NULL AND
      "retiredAt" >= "activatedAt"
    )
  ),
  CONSTRAINT cpv_definition_shape_check CHECK ((
    jsonb_typeof("definitionJson") = 'object' AND
    "definitionJson" ?& ARRAY['defaultResult','roleRules'] AND
    "definitionJson" - ARRAY['defaultResult','roleRules'] = '{}'::jsonb AND
    jsonb_typeof("definitionJson"->'defaultResult') = 'object' AND
    "definitionJson"->'defaultResult' ?& ARRAY['recognizedPoints','explanationCode'] AND
    ("definitionJson"->'defaultResult') - ARRAY['recognizedPoints','explanationCode'] = '{}'::jsonb AND
    jsonb_typeof("definitionJson"->'defaultResult'->'recognizedPoints') = 'string' AND
    "definitionJson"->'defaultResult'->>'recognizedPoints' ~ '^(0|[1-9][0-9]{0,2})\.[0-9]{2}$' AND
    jsonb_typeof("definitionJson"->'defaultResult'->'explanationCode') = 'string' AND
    "definitionJson"->'defaultResult'->>'explanationCode' ~ '^[a-z][a-z0-9_.-]{0,63}$' AND
    jsonb_typeof("definitionJson"->'roleRules') = 'array' AND
    jsonb_array_length("definitionJson"->'roleRules') <= 64
  ) IS TRUE)
);
CREATE UNIQUE INDEX cpv_policy_version_key ON "ContributionPolicyVersion"("policyId", "version");
CREATE UNIQUE INDEX cpv_exact_anchor_key ON "ContributionPolicyVersion"("id", "policyId", "definitionHash", "evaluatorVersion");
CREATE INDEX cpv_policy_status_idx ON "ContributionPolicyVersion"("policyId", "statusCode");
CREATE INDEX cpv_creator_idx ON "ContributionPolicyVersion"("createdByUserId");
CREATE INDEX cpv_activator_idx ON "ContributionPolicyVersion"("activatedByUserId");
CREATE INDEX cpv_retirer_idx ON "ContributionPolicyVersion"("retiredByUserId");

CREATE TABLE "ContributionPolicyCommandReceipt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "actorUserId" TEXT NOT NULL,
  "operationCode" TEXT NOT NULL,
  "operationKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "policyId" TEXT NOT NULL,
  "versionId" TEXT,
  "definitionHash" TEXT,
  "evaluatorVersion" INTEGER,
  "resultJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT cpr_actor_fk FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT cpr_policy_fk FOREIGN KEY ("policyId") REFERENCES "ContributionPolicy"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT cpr_version_anchor_fk FOREIGN KEY ("versionId", "policyId", "definitionHash", "evaluatorVersion") REFERENCES "ContributionPolicyVersion"("id", "policyId", "definitionHash", "evaluatorVersion") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT cpr_shape_check CHECK (
    char_length("operationKey") BETWEEN 1 AND 128 AND
    "operationKey" ~ '[^[:space:]]' AND
    "operationKey" !~ '[[:cntrl:]]' AND
    "requestHash" ~ '^[a-f0-9]{64}$' AND (
      (
        "operationCode" = 'create_policy' AND
        "versionId" IS NULL AND "definitionHash" IS NULL AND "evaluatorVersion" IS NULL
      ) OR (
        "operationCode" IN ('create_version','activate_version','retire_version') AND
        "versionId" IS NOT NULL AND
        "definitionHash" IS NOT NULL AND "definitionHash" ~ '^[a-f0-9]{64}$' AND
        "evaluatorVersion" = 1
      )
    )
  ),
  CONSTRAINT cpr_result_check CHECK ((
    jsonb_typeof("resultJson") = 'object' AND
    "resultJson" ?& ARRAY['schemaVersion','operationCode','policyId','versionId','definitionHash','evaluatorVersion','resultStatusCode','createdAt'] AND
    "resultJson" - ARRAY['schemaVersion','operationCode','policyId','versionId','definitionHash','evaluatorVersion','resultStatusCode','createdAt'] = '{}'::jsonb AND
    "resultJson"->'schemaVersion' = '1'::jsonb AND
    "resultJson"->'operationCode' = to_jsonb("operationCode") AND
    "resultJson"->'policyId' = to_jsonb("policyId") AND
    "resultJson"->'versionId' = COALESCE(to_jsonb("versionId"), 'null'::jsonb) AND
    "resultJson"->'definitionHash' = COALESCE(to_jsonb("definitionHash"), 'null'::jsonb) AND
    "resultJson"->'evaluatorVersion' = COALESCE(to_jsonb("evaluatorVersion"), 'null'::jsonb) AND
    "resultJson"->'resultStatusCode' = CASE "operationCode"
      WHEN 'create_policy' THEN 'null'::jsonb
      WHEN 'create_version' THEN '"draft"'::jsonb
      WHEN 'activate_version' THEN '"active"'::jsonb
      WHEN 'retire_version' THEN '"retired"'::jsonb
    END AND
    jsonb_typeof("resultJson"->'createdAt') = 'string' AND
    "resultJson"->>'createdAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  ) IS TRUE)
);
CREATE UNIQUE INDEX cpr_command_key ON "ContributionPolicyCommandReceipt"("actorUserId", "operationCode", "operationKey");
CREATE INDEX cpr_policy_idx ON "ContributionPolicyCommandReceipt"("policyId");
CREATE INDEX cpr_version_idx ON "ContributionPolicyCommandReceipt"("versionId");

CREATE FUNCTION cp_identity_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'contribution policy history is retained' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['name','description','updatedAt']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['name','description','updatedAt']) THEN
    RAISE EXCEPTION 'contribution policy identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cp_identity_guard BEFORE UPDATE OR DELETE ON "ContributionPolicy" FOR EACH ROW EXECUTE FUNCTION cp_identity_guard_fn();

CREATE FUNCTION cpv_immutable_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'contribution policy version is retained' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."statusCode" <> 'draft' THEN
      RAISE EXCEPTION 'contribution policy version starts draft' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['statusCode','activatedByUserId','retiredByUserId','activatedAt','retiredAt','updatedAt']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['statusCode','activatedByUserId','retiredByUserId','activatedAt','retiredAt','updatedAt']) THEN
    RAISE EXCEPTION 'contribution policy version semantics are immutable' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW."statusCode",NEW."activatedByUserId",NEW."retiredByUserId",NEW."activatedAt",NEW."retiredAt") IS NOT DISTINCT FROM
     ROW(OLD."statusCode",OLD."activatedByUserId",OLD."retiredByUserId",OLD."activatedAt",OLD."retiredAt") THEN
    RETURN NEW;
  END IF;
  IF OLD."statusCode" = 'draft' AND NEW."statusCode" = 'active' AND
     NEW."activatedAt" IS NOT NULL AND NEW."activatedByUserId" IS NOT NULL AND
     NEW."retiredAt" IS NULL AND NEW."retiredByUserId" IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD."statusCode" = 'active' AND NEW."statusCode" = 'retired' AND
     NEW."activatedAt" IS NOT DISTINCT FROM OLD."activatedAt" AND
     NEW."activatedByUserId" IS NOT DISTINCT FROM OLD."activatedByUserId" AND
     NEW."retiredAt" IS NOT NULL AND NEW."retiredByUserId" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid contribution policy version transition' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER cpv_immutable_guard BEFORE INSERT OR UPDATE OR DELETE ON "ContributionPolicyVersion" FOR EACH ROW EXECUTE FUNCTION cpv_immutable_guard_fn();

CREATE FUNCTION cpr_immutable_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parsed TIMESTAMPTZ;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'contribution policy receipt is immutable' USING ERRCODE = '23514';
  END IF;
  BEGIN
    parsed := (NEW."resultJson"->>'createdAt')::timestamptz;
    IF parsed IS NULL OR NOT isfinite(parsed) OR
       to_char(parsed AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM NEW."resultJson"->>'createdAt' THEN
      RAISE EXCEPTION 'invalid receipt timestamp';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'invalid contribution policy receipt timestamp' USING ERRCODE = '23514';
  END;
  RETURN NEW;
END $$;
CREATE TRIGGER cpr_immutable_guard BEFORE INSERT OR UPDATE OR DELETE ON "ContributionPolicyCommandReceipt" FOR EACH ROW EXECUTE FUNCTION cpr_immutable_guard_fn();

CREATE FUNCTION cp_reject_truncate_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'contribution policy facts cannot be truncated' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER cp_no_truncate BEFORE TRUNCATE ON "ContributionPolicy" FOR EACH STATEMENT EXECUTE FUNCTION cp_reject_truncate_fn();
CREATE TRIGGER cpv_no_truncate BEFORE TRUNCATE ON "ContributionPolicyVersion" FOR EACH STATEMENT EXECUTE FUNCTION cp_reject_truncate_fn();
CREATE TRIGGER cpr_no_truncate BEFORE TRUNCATE ON "ContributionPolicyCommandReceipt" FOR EACH STATEMENT EXECUTE FUNCTION cp_reject_truncate_fn();

COMMIT;
