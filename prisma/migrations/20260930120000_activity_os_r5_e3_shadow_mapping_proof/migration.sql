-- E3-2 D2 mapping proof draft. No business backfill, role creation or legacy SQL edits.
-- Registration/evaluation runtime and ACL tests must be completed before 3b signature.
BEGIN;

CREATE UNIQUE INDEX "csm_policy_exact_key" ON "ContributionPolicyVersion"("id", "definitionHash", "evaluatorVersion");
CREATE UNIQUE INDEX "csm_selection_exact_key" ON "ActivityContributionPolicySelectionItem"("id", "activityId", "versionId", "definitionHash", "evaluatorVersion");
CREATE UNIQUE INDEX "csm_position_activity_key" ON "ActivitySessionPosition"("activityId", "id");
CREATE UNIQUE INDEX "csm_source_exact_key" ON "ContributionShadowLegacySourceAnchor"("id", "windowId", "auditLogId", "sheetId", "sheetVersion", "recordId", "memberId", "activityId");

CREATE TABLE "ContributionShadowMappingApproval" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "approvalNumber" TEXT NOT NULL,
  "mappingVersion" TEXT NOT NULL,
  "manifestHash" TEXT NOT NULL,
  "approvalReference" TEXT NOT NULL,
  "approvedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approvedByUserId" TEXT NOT NULL,
  "registeredByUserId" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "activityTypeCode" TEXT NOT NULL,
  "attendanceRoleCode" TEXT NOT NULL,
  "sessionPositionId" TEXT NOT NULL,
  "policyRoleCode" TEXT NOT NULL,
  "categoryCode" TEXT NOT NULL,
  "policyVersionId" TEXT NOT NULL,
  "policyDefinitionHash" TEXT NOT NULL,
  "evaluatorVersion" INTEGER NOT NULL,
  "durationSourceCode" TEXT NOT NULL,
  "effectiveFrom" TIMESTAMPTZ(3) NOT NULL,
  "effectiveUntil" TIMESTAMPTZ(3),
  "eventKindCode" TEXT NOT NULL,
  "previousApprovalId" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "csma_approval_number_key" UNIQUE ("approvalNumber"),
  CONSTRAINT "csma_id_activity_key" UNIQUE ("id", "activityId"),
  CONSTRAINT "csma_approver_fk" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "csma_registrar_fk" FOREIGN KEY ("registeredByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "csma_position_fk" FOREIGN KEY ("activityId", "sessionPositionId") REFERENCES "ActivitySessionPosition"("activityId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "csma_policy_fk" FOREIGN KEY ("policyVersionId", "policyDefinitionHash", "evaluatorVersion") REFERENCES "ContributionPolicyVersion"("id", "definitionHash", "evaluatorVersion") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "csma_previous_fk" FOREIGN KEY ("previousApprovalId", "activityId") REFERENCES "ContributionShadowMappingApproval"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "csma_contract_check" CHECK (
    "evaluatorVersion" = 1 AND "durationSourceCode" = 'legacy_stored_hours_2' AND
    "categoryCode" IN ('volunteer_service', 'training', 'organization', 'non_creditable') AND
    "eventKindCode" IN ('approve', 'revoke', 'replace') AND
    (("eventKindCode" = 'approve' AND "previousApprovalId" IS NULL) OR
      ("eventKindCode" IN ('revoke', 'replace') AND "previousApprovalId" IS NOT NULL)) AND
    ("effectiveUntil" IS NULL OR "effectiveUntil" > "effectiveFrom") AND
    "manifestHash" ~ '^[a-f0-9]{64}$' AND "policyDefinitionHash" ~ '^[a-f0-9]{64}$'
  )
);
CREATE INDEX "csma_lookup_idx" ON "ContributionShadowMappingApproval"("activityId", "attendanceRoleCode", "effectiveFrom");

CREATE TABLE "ContributionShadowMappingApplication" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "approvalId" TEXT NOT NULL,
  "legacySourceAnchorId" TEXT NOT NULL,
  "windowId" TEXT NOT NULL,
  "auditLogId" TEXT NOT NULL,
  "sheetId" TEXT NOT NULL,
  "sheetVersion" INTEGER NOT NULL,
  "recordId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "selectionItemId" TEXT NOT NULL,
  "policyVersionId" TEXT NOT NULL,
  "policyDefinitionHash" TEXT NOT NULL,
  "evaluatorVersion" INTEGER NOT NULL,
  "durationSeconds" INTEGER NOT NULL,
  "policyPoints" DECIMAL(5,2) NOT NULL,
  "explanationCode" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "csmap_audit_record_key" UNIQUE ("auditLogId", "recordId"),
  CONSTRAINT "csmap_approval_fk" FOREIGN KEY ("approvalId", "activityId") REFERENCES "ContributionShadowMappingApproval"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "csmap_source_fk" FOREIGN KEY ("legacySourceAnchorId", "windowId", "auditLogId", "sheetId", "sheetVersion", "recordId", "memberId", "activityId") REFERENCES "ContributionShadowLegacySourceAnchor"("id", "windowId", "auditLogId", "sheetId", "sheetVersion", "recordId", "memberId", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "csmap_selection_fk" FOREIGN KEY ("selectionItemId", "activityId", "policyVersionId", "policyDefinitionHash", "evaluatorVersion") REFERENCES "ActivityContributionPolicySelectionItem"("id", "activityId", "versionId", "definitionHash", "evaluatorVersion") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "csmap_policy_fk" FOREIGN KEY ("policyVersionId", "policyDefinitionHash", "evaluatorVersion") REFERENCES "ContributionPolicyVersion"("id", "definitionHash", "evaluatorVersion") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "csmap_value_check" CHECK ("sheetVersion" > 0 AND "durationSeconds" >= 0 AND "policyPoints" >= 0 AND "evaluatorVersion" = 1 AND "explanationCode" <> '')
);
CREATE INDEX "csmap_approval_idx" ON "ContributionShadowMappingApplication"("approvalId", "activityId");

CREATE TABLE "ContributionShadowMappingRegistrationReceipt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "commandKey" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "manifestHash" TEXT NOT NULL,
  "registeredByUserId" TEXT NOT NULL,
  "approvalCount" INTEGER NOT NULL,
  "approvalIdsCanonical" JSONB NOT NULL,
  "auditLogId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "csmrr_command_key" UNIQUE ("commandKey"),
  CONSTRAINT "csmrr_audit_key" UNIQUE ("auditLogId"),
  CONSTRAINT "csmrr_registrar_fk" FOREIGN KEY ("registeredByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "csmrr_audit_fk" FOREIGN KEY ("auditLogId") REFERENCES "audit_logs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "csmrr_contract_check" CHECK (
    "approvalCount" > 0 AND "payloadHash" ~ '^[a-f0-9]{64}$' AND
    "manifestHash" ~ '^[a-f0-9]{64}$' AND jsonb_typeof("approvalIdsCanonical") = 'array'
  )
);

-- Validate the complete policy, including unselected rules, before evaluating it.
-- Numeric comparisons deliberately use NUMERIC (not floating point).
CREATE FUNCTION csm_exact_keys_fn(value JSONB, keys TEXT[]) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
BEGIN
  IF value IS NULL OR jsonb_typeof(value) <> 'object' THEN RETURN FALSE; END IF;
  RETURN (SELECT count(*) = cardinality(keys) AND bool_and(key = ANY(keys))
          FROM jsonb_object_keys(value) AS key);
END $$;

CREATE FUNCTION csm_text_limit_fn(value JSONB, maximum_units INTEGER) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE
  content TEXT; character_code INTEGER; units INTEGER := 0; i INTEGER;
  trim_codes INTEGER[] := ARRAY[9,10,11,12,13,32,160,5760,8192,8193,8194,8195,
    8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279];
BEGIN
  IF value IS NULL OR jsonb_typeof(value) <> 'string' THEN RETURN FALSE; END IF;
  content := value #>> '{}';
  IF length(content) = 0 THEN RETURN FALSE; END IF;
  FOR i IN 1..length(content) LOOP
    character_code := ascii(substr(content, i, 1));
    IF character_code < 32 OR character_code BETWEEN 127 AND 159 THEN RETURN FALSE; END IF;
    IF (i = 1 OR i = length(content)) AND character_code = ANY(trim_codes) THEN RETURN FALSE; END IF;
    units := units + CASE WHEN character_code > 65535 THEN 2 ELSE 1 END;
  END LOOP;
  RETURN maximum_units IS NOT NULL AND maximum_units > 0 AND units <= maximum_units;
END $$;

CREATE FUNCTION csm_text_valid_fn(value JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT csm_text_limit_fn(value, 64)
$$;

CREATE FUNCTION csm_manifest_instant_fn(value JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE
  content TEXT; y INTEGER; m INTEGER; d INTEGER; last_day INTEGER;
BEGIN
  IF value IS NULL OR jsonb_typeof(value) <> 'string' THEN RETURN FALSE; END IF;
  content := value #>> '{}';
  IF content !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN RETURN FALSE; END IF;
  y := substr(content,1,4)::INTEGER; m := substr(content,6,2)::INTEGER; d := substr(content,9,2)::INTEGER;
  IF m < 1 OR m > 12 OR substr(content,12,2)::INTEGER > 23 OR
    substr(content,15,2)::INTEGER > 59 OR substr(content,18,2)::INTEGER > 59 THEN RETURN FALSE; END IF;
  last_day := CASE m WHEN 2 THEN CASE WHEN y % 400 = 0 OR (y % 4 = 0 AND y % 100 <> 0) THEN 29 ELSE 28 END
    WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30 WHEN 11 THEN 30 ELSE 31 END;
  RETURN d BETWEEN 1 AND last_day;
END $$;

-- Only used after the fixed ASCII-key manifest contract below is validated.
-- This is not a general arbitrary-Unicode-object-key canonical JSON API.
CREATE FUNCTION csm_manifest_canonical_fn(value JSONB) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE content TEXT; number_value NUMERIC;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT '{' || coalesce(string_agg(to_jsonb(key)::TEXT || ':' || csm_manifest_canonical_fn(val), ',' ORDER BY key COLLATE "C"), '') || '}'
        INTO content FROM jsonb_each(value) AS item(key,val);
    WHEN 'array' THEN
      SELECT '[' || coalesce(string_agg(csm_manifest_canonical_fn(val), ',' ORDER BY ordinal), '') || ']'
        INTO content FROM jsonb_array_elements(value) WITH ORDINALITY AS item(val,ordinal);
    WHEN 'number' THEN
      number_value := value::TEXT::NUMERIC;
      IF trunc(number_value) <> number_value OR abs(number_value) > 9007199254740991 THEN
        RAISE EXCEPTION 'invalid mapping registration manifest' USING ERRCODE = '23514';
      END IF;
      content := number_value::BIGINT::TEXT;
    WHEN 'string' THEN content := value::TEXT;
    WHEN 'null' THEN content := 'null';
    WHEN 'boolean' THEN content := value::TEXT;
    ELSE RAISE EXCEPTION 'invalid mapping registration manifest' USING ERRCODE = '23514';
  END CASE;
  RETURN content;
END $$;

CREATE FUNCTION csm_manifest_hash_fn(manifest JSONB) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE
  item JSONB; field_name TEXT; approval_numbers TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF NOT csm_exact_keys_fn(manifest, ARRAY['schemaVersion','commandKey','approvalReference','approvals']) OR
    manifest->'schemaVersion' IS DISTINCT FROM '1'::JSONB OR
    NOT csm_text_limit_fn(manifest->'commandKey',128) OR
    NOT csm_text_limit_fn(manifest->'approvalReference',256) OR
    jsonb_typeof(manifest->'approvals') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid mapping registration manifest' USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(manifest->'approvals') = 0 THEN
    RAISE EXCEPTION 'invalid mapping registration manifest' USING ERRCODE = '23514';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(manifest->'approvals') LOOP
    IF NOT csm_exact_keys_fn(item, ARRAY['approvalNumber','mappingVersion','activityId','activityTypeCode',
      'attendanceRoleCode','sessionPositionId','policyRoleCode','categoryCode','policyVersionId',
      'policyDefinitionHash','evaluatorVersion','durationSourceCode','effectiveFrom','effectiveUntil',
      'eventKindCode','previousApprovalId']) THEN
      RAISE EXCEPTION 'invalid mapping registration manifest' USING ERRCODE = '23514';
    END IF;
    FOREACH field_name IN ARRAY ARRAY['approvalNumber','mappingVersion','activityId','sessionPositionId','policyVersionId'] LOOP
      IF NOT csm_text_limit_fn(item->field_name,128) THEN
        RAISE EXCEPTION 'invalid mapping registration manifest' USING ERRCODE = '23514';
      END IF;
    END LOOP;
    FOREACH field_name IN ARRAY ARRAY['activityTypeCode','attendanceRoleCode','policyRoleCode'] LOOP
      IF NOT csm_text_valid_fn(item->field_name) THEN
        RAISE EXCEPTION 'invalid mapping registration manifest' USING ERRCODE = '23514';
      END IF;
    END LOOP;
    IF item->>'approvalNumber' = ANY(approval_numbers) OR
      NOT csm_text_valid_fn(item->'policyDefinitionHash') OR
      (item->>'policyDefinitionHash') !~ '^[a-f0-9]{64}$' OR
      item->'evaluatorVersion' IS DISTINCT FROM '1'::JSONB OR
      item->'durationSourceCode' IS DISTINCT FROM '"legacy_stored_hours_2"'::JSONB OR
      jsonb_typeof(item->'categoryCode') IS DISTINCT FROM 'string' OR
      (item->>'categoryCode') NOT IN ('volunteer_service','training','organization','non_creditable') OR
      jsonb_typeof(item->'eventKindCode') IS DISTINCT FROM 'string' OR
      (item->>'eventKindCode') NOT IN ('approve','revoke','replace') OR
      NOT csm_manifest_instant_fn(item->'effectiveFrom') OR
      (item->'effectiveUntil' <> 'null'::JSONB AND (NOT csm_manifest_instant_fn(item->'effectiveUntil') OR
        (item->>'effectiveUntil') COLLATE "C" <= (item->>'effectiveFrom') COLLATE "C")) OR
      ((item->>'eventKindCode' = 'approve') IS DISTINCT FROM (item->'previousApprovalId' = 'null'::JSONB)) OR
      (item->'previousApprovalId' <> 'null'::JSONB AND NOT csm_text_limit_fn(item->'previousApprovalId',128)) THEN
      RAISE EXCEPTION 'invalid mapping registration manifest' USING ERRCODE = '23514';
    END IF;
    approval_numbers := array_append(approval_numbers,item->>'approvalNumber');
  END LOOP;
  RETURN encode(sha256(convert_to(csm_manifest_canonical_fn(jsonb_build_object(
    'definition', jsonb_build_object('domain','SRVF:E3-2:shadow-mapping-registration:v1','manifest',manifest),
    'schemaVersion',1)), 'UTF8')), 'hex');
END $$;

-- Pure content check for the registrar's eventual deferred receipt closure.
-- It neither authenticates the caller nor authorizes inserts; the final registrar
-- must supply the independently authenticated actor and database registration time.
CREATE FUNCTION csm_approval_matches_manifest_fn(
  approval "ContributionShadowMappingApproval", manifest JSONB, item_index INTEGER,
  actor_id TEXT, registration_time TIMESTAMPTZ
) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE item JSONB; digest TEXT; actual_item JSONB;
BEGIN
  digest := csm_manifest_hash_fn(manifest);
  IF item_index IS NULL OR item_index < 0 OR item_index >= jsonb_array_length(manifest->'approvals') OR
    NOT csm_text_limit_fn(to_jsonb(actor_id),128) OR registration_time IS NULL THEN RETURN FALSE; END IF;
  item := manifest->'approvals'->item_index;
  actual_item := jsonb_build_object(
    'approvalNumber', approval."approvalNumber", 'mappingVersion', approval."mappingVersion",
    'activityId', approval."activityId", 'activityTypeCode', approval."activityTypeCode",
    'attendanceRoleCode', approval."attendanceRoleCode", 'sessionPositionId', approval."sessionPositionId",
    'policyRoleCode', approval."policyRoleCode", 'categoryCode', approval."categoryCode",
    'policyVersionId', approval."policyVersionId", 'policyDefinitionHash', approval."policyDefinitionHash",
    'evaluatorVersion', approval."evaluatorVersion", 'durationSourceCode', approval."durationSourceCode",
    'effectiveFrom', to_char(approval."effectiveFrom" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'effectiveUntil', to_char(approval."effectiveUntil" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'eventKindCode', approval."eventKindCode", 'previousApprovalId', approval."previousApprovalId"
  );
  RETURN coalesce(actual_item = item AND
    approval."manifestHash" = digest AND approval."approvalReference" = manifest->>'approvalReference' AND
    approval."approvedByUserId" = actor_id AND approval."registeredByUserId" = actor_id AND
    approval."approvedAt" = registration_time AND approval."createdAt" = registration_time, FALSE);
END $$;

CREATE FUNCTION csm_result_valid_fn(value JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT COALESCE(
    jsonb_typeof(value->'recognizedPoints') = 'string' AND
    (value->>'recognizedPoints') ~ '^(0|[1-9][0-9]{0,2})\.[0-9]{2}$' AND
    jsonb_typeof(value->'explanationCode') = 'string' AND
    (value->>'explanationCode') ~ '^[a-z][a-z0-9_.-]{0,63}$', FALSE)
$$;

CREATE FUNCTION csm_policy_evaluate_fn(definition JSONB, role_code TEXT,
  category_code TEXT, duration_seconds BIGINT) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE
  role_item JSONB; category_item JSONB; band JSONB;
  roles_seen TEXT[] := ARRAY[]::TEXT[]; categories_seen TEXT[];
  maximum NUMERIC; previous_maximum NUMERIC; ordinal INTEGER; band_count INTEGER;
  selected JSONB; policy_role_code TEXT; current_category TEXT; category_matched BOOLEAN;
BEGIN
  IF NOT csm_text_valid_fn(to_jsonb(role_code)) OR category_code IS NULL OR
    category_code NOT IN ('volunteer_service','training','organization','non_creditable') OR
    duration_seconds IS NULL OR duration_seconds < 0 OR duration_seconds > 9007199254740991 OR
    NOT csm_exact_keys_fn(definition, ARRAY['defaultResult','roleRules']) THEN
    RAISE EXCEPTION 'invalid contribution policy metadata' USING ERRCODE = '23514';
  END IF;
  IF NOT csm_exact_keys_fn(definition->'defaultResult', ARRAY['recognizedPoints','explanationCode']) OR
    NOT csm_result_valid_fn(definition->'defaultResult') OR
    jsonb_typeof(definition->'roleRules') <> 'array' THEN
    RAISE EXCEPTION 'invalid contribution policy metadata' USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(definition->'roleRules') > 64 THEN
    RAISE EXCEPTION 'invalid contribution policy metadata' USING ERRCODE = '23514';
  END IF;
  selected := definition->'defaultResult';
  FOR role_item IN SELECT value FROM jsonb_array_elements(definition->'roleRules') LOOP
    IF NOT csm_exact_keys_fn(role_item, ARRAY['attendanceRoleCode','categoryRules']) OR
      NOT csm_text_valid_fn(role_item->'attendanceRoleCode') OR
      jsonb_typeof(role_item->'categoryRules') <> 'array' THEN
      RAISE EXCEPTION 'invalid contribution policy metadata' USING ERRCODE = '23514';
    END IF;
    policy_role_code := role_item->>'attendanceRoleCode';
    IF policy_role_code = ANY(roles_seen) OR jsonb_array_length(role_item->'categoryRules') > 4 THEN
      RAISE EXCEPTION 'invalid contribution policy metadata' USING ERRCODE = '23514';
    END IF;
    roles_seen := array_append(roles_seen, policy_role_code);
    categories_seen := ARRAY[]::TEXT[];
    FOR category_item IN SELECT value FROM jsonb_array_elements(role_item->'categoryRules') LOOP
      IF NOT csm_exact_keys_fn(category_item, ARRAY['timeCategoryCode','durationBands']) OR
        jsonb_typeof(category_item->'timeCategoryCode') <> 'string' OR
        (category_item->>'timeCategoryCode') NOT IN ('volunteer_service','training','organization','non_creditable') OR
        jsonb_typeof(category_item->'durationBands') <> 'array' THEN
        RAISE EXCEPTION 'invalid contribution policy metadata' USING ERRCODE = '23514';
      END IF;
      current_category := category_item->>'timeCategoryCode';
      band_count := jsonb_array_length(category_item->'durationBands');
      IF current_category = ANY(categories_seen) OR band_count < 1 OR band_count > 16 THEN
        RAISE EXCEPTION 'invalid contribution policy metadata' USING ERRCODE = '23514';
      END IF;
      categories_seen := array_append(categories_seen, current_category);
      previous_maximum := -1;
      category_matched := FALSE;
      FOR band, ordinal IN SELECT value, ordinality::INTEGER
        FROM jsonb_array_elements(category_item->'durationBands') WITH ORDINALITY LOOP
        IF NOT csm_exact_keys_fn(band, ARRAY['maxSecondsInclusive','recognizedPoints','explanationCode']) OR
          NOT csm_result_valid_fn(band) THEN
          RAISE EXCEPTION 'invalid contribution policy metadata' USING ERRCODE = '23514';
        END IF;
        IF ordinal = band_count THEN
          IF jsonb_typeof(band->'maxSecondsInclusive') <> 'null' THEN
            RAISE EXCEPTION 'invalid contribution policy metadata' USING ERRCODE = '23514';
          END IF;
          maximum := NULL;
        ELSE
          IF jsonb_typeof(band->'maxSecondsInclusive') <> 'number' THEN
            RAISE EXCEPTION 'invalid contribution policy metadata' USING ERRCODE = '23514';
          END IF;
          maximum := (band->>'maxSecondsInclusive')::NUMERIC;
          IF maximum < 0 OR maximum > 9007199254740991 OR trunc(maximum) <> maximum OR
            maximum <= previous_maximum THEN
            RAISE EXCEPTION 'invalid contribution policy metadata' USING ERRCODE = '23514';
          END IF;
          previous_maximum := maximum;
        END IF;
        IF policy_role_code = role_code AND current_category = category_code AND NOT category_matched THEN
          -- Select the first matching band; never replace an earlier match.
          IF maximum IS NULL OR duration_seconds <= maximum THEN
            selected := jsonb_build_object('recognizedPoints',band->>'recognizedPoints',
              'explanationCode',band->>'explanationCode');
            category_matched := TRUE;
          END IF;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  RETURN selected;
END $$;

-- Pure contract validation. This function does NOT confer registration authority:
-- the final application trigger must load these immutable rows itself.
CREATE FUNCTION csm_policy_fingerprint_fn(policy "ContributionPolicyVersion") RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE envelope JSONB;
BEGIN
  IF policy."schemaVersion" IS DISTINCT FROM 1 OR policy."evaluatorVersion" IS DISTINCT FROM 1 OR
    policy."effectiveFrom" IS NULL OR
    (policy."effectiveUntil" IS NOT NULL AND policy."effectiveUntil" <= policy."effectiveFrom") THEN
    RAISE EXCEPTION 'invalid contribution policy metadata' USING ERRCODE = '23514';
  END IF;
  -- Validate every nested rule first, including unselected/default-only definitions.
  PERFORM csm_policy_evaluate_fn(policy."definitionJson", '__schema_validation__', 'volunteer_service', 0);
  envelope := jsonb_build_object('schemaVersion',1,'definition',jsonb_build_object(
    'definition',policy."definitionJson", 'evaluatorVersion',policy."evaluatorVersion",
    'effectiveFrom',to_char(policy."effectiveFrom",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'effectiveUntil',to_char(policy."effectiveUntil",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  IF NOT csm_manifest_instant_fn(envelope->'definition'->'effectiveFrom') OR
    (envelope->'definition'->'effectiveUntil' <> 'null'::JSONB AND
      NOT csm_manifest_instant_fn(envelope->'definition'->'effectiveUntil')) THEN
    RAISE EXCEPTION 'invalid contribution policy metadata' USING ERRCODE = '23514';
  END IF;
  RETURN encode(sha256(convert_to(csm_manifest_canonical_fn(envelope),'UTF8')),'hex');
END $$;

-- Reference prevalidation against real activity-owned rows. This is NOT an
-- authentication/approval gate: the registrar must still hold its ordered locks
-- and recheck Human access before writing any approval or receipt.
CREATE FUNCTION csm_assert_registration_references_fn(manifest JSONB) RETURNS VOID
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE item JSONB; policy "ContributionPolicyVersion";
BEGIN
  PERFORM csm_manifest_hash_fn(manifest);
  FOR item IN SELECT value FROM jsonb_array_elements(manifest->'approvals') LOOP
    IF NOT EXISTS (SELECT 1 FROM "Activity" a
      WHERE a."id" = item->>'activityId' AND a."deletedAt" IS NULL
        AND a."activityTypeCode" = item->>'activityTypeCode') OR
      NOT EXISTS (SELECT 1 FROM "ActivitySessionPosition" p
        JOIN "ActivitySession" s ON s."id" = p."sessionId" AND s."activityId" = p."activityId"
        WHERE p."id" = item->>'sessionPositionId' AND p."activityId" = item->>'activityId'
          AND p."deletedAt" IS NULL AND s."deletedAt" IS NULL) THEN
      RAISE EXCEPTION 'shadow registration activity or position reference unavailable' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO policy FROM "ContributionPolicyVersion"
      WHERE "id" = item->>'policyVersionId' AND "definitionHash" = item->>'policyDefinitionHash'
        AND "evaluatorVersion" = (item->>'evaluatorVersion')::INTEGER;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'shadow registration policy reference unavailable' USING ERRCODE = '23514';
    END IF;
    IF policy."definitionHash" IS DISTINCT FROM csm_policy_fingerprint_fn(policy) OR
      NOT EXISTS (SELECT 1 FROM jsonb_array_elements(policy."definitionJson"->'roleRules') AS r(value)
        CROSS JOIN LATERAL jsonb_array_elements(r.value->'categoryRules') AS c(value)
        WHERE r.value->>'attendanceRoleCode' = item->>'policyRoleCode'
          AND c.value->>'timeCategoryCode' = item->>'categoryCode') THEN
      RAISE EXCEPTION 'shadow registration policy definition or rule unavailable' USING ERRCODE = '23514';
    END IF;
    IF item->'previousApprovalId' <> 'null'::JSONB AND NOT EXISTS (
      SELECT 1 FROM "ContributionShadowMappingApproval" old
      WHERE old."id" = item->>'previousApprovalId' AND old."activityId" = item->>'activityId'
        AND old."eventKindCode" IN ('approve','replace')
    ) THEN
      RAISE EXCEPTION 'shadow registration predecessor unavailable' USING ERRCODE = '23514';
    END IF;
  END LOOP;
END $$;

CREATE FUNCTION csm_mapping_inputs_result_fn(
  approval "ContributionShadowMappingApproval", source "ContributionShadowLegacySourceAnchor",
  observation "ContributionShadowObservationWindow", policy "ContributionPolicyVersion",
  audit_time TIMESTAMPTZ
) RETURNS JSONB LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE
  duration NUMERIC; evaluated JSONB;
BEGIN
  IF audit_time IS NULL OR approval."approvedAt" IS NULL OR
    approval."approvedAt" > audit_time OR approval."effectiveFrom" IS NULL OR
    approval."effectiveFrom" > audit_time OR
    (approval."effectiveUntil" IS NOT NULL AND approval."effectiveUntil" <= audit_time) OR
    approval."eventKindCode" IS NULL OR approval."eventKindCode" NOT IN ('approve','replace') THEN
    RAISE EXCEPTION 'shadow mapping approval is not effective at source time' USING ERRCODE = '23514';
  END IF;
  IF source."windowId" IS NULL OR observation."id" IS DISTINCT FROM source."windowId" OR
    observation."signedMappingVersion" IS NULL OR
    approval."mappingVersion" IS DISTINCT FROM observation."signedMappingVersion" OR
    observation."startsAt" IS NULL OR observation."startsAt" > audit_time OR
    observation."endsAt" IS NULL OR observation."endsAt" <= audit_time THEN
    RAISE EXCEPTION 'shadow mapping observation mismatch' USING ERRCODE = '23514';
  END IF;
  IF source."activityId" IS NULL OR approval."activityId" IS DISTINCT FROM source."activityId" OR
    source."activityTypeCode" IS NULL OR approval."activityTypeCode" IS DISTINCT FROM source."activityTypeCode" OR
    source."attendanceRoleCode" IS NULL OR approval."attendanceRoleCode" IS DISTINCT FROM source."attendanceRoleCode" OR
    source."sourceKindCode" IS DISTINCT FROM 'matched' OR
    approval."durationSourceCode" IS DISTINCT FROM 'legacy_stored_hours_2' THEN
    RAISE EXCEPTION 'shadow mapping legacy source mismatch' USING ERRCODE = '23514';
  END IF;
  IF policy."id" IS NULL OR approval."policyVersionId" IS DISTINCT FROM policy."id" OR
    policy."definitionHash" IS NULL OR approval."policyDefinitionHash" IS DISTINCT FROM policy."definitionHash" OR
    policy."schemaVersion" IS DISTINCT FROM 1 OR policy."evaluatorVersion" IS DISTINCT FROM 1 OR
    approval."evaluatorVersion" IS DISTINCT FROM policy."evaluatorVersion" THEN
    RAISE EXCEPTION 'shadow mapping policy version mismatch' USING ERRCODE = '23514';
  END IF;
  IF policy."definitionHash" IS DISTINCT FROM csm_policy_fingerprint_fn(policy) THEN
    RAISE EXCEPTION 'shadow mapping policy definition hash mismatch' USING ERRCODE = '23514';
  END IF;
  IF source."legacyServiceHours" IS NULL OR source."legacyServiceHours" < 0 OR
    source."legacyServiceHours" > 999.99 THEN
    RAISE EXCEPTION 'shadow mapping duration source invalid' USING ERRCODE = '23514';
  END IF;
  -- Stored hundredths of an hour multiply by 36 per hundredth, without rounding.
  duration := source."legacyServiceHours" * 3600;
  IF trunc(duration) <> duration THEN
    RAISE EXCEPTION 'shadow mapping duration source invalid' USING ERRCODE = '23514';
  END IF;
  evaluated := csm_policy_evaluate_fn(policy."definitionJson", approval."policyRoleCode",
    approval."categoryCode", duration::BIGINT);
  -- Evaluator default is legitimate in E1 but cannot prove a signed E3 mapping.
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(policy."definitionJson"->'roleRules') AS r(value)
    CROSS JOIN LATERAL jsonb_array_elements(r.value->'categoryRules') AS c(value)
    WHERE r.value->>'attendanceRoleCode' = approval."policyRoleCode"
      AND c.value->>'timeCategoryCode' = approval."categoryCode"
  ) THEN
    RAISE EXCEPTION 'shadow mapping policy role or category missing' USING ERRCODE = '23514';
  END IF;
  RETURN jsonb_build_object('durationSeconds', duration::BIGINT,
    'recognizedPoints', evaluated->>'recognizedPoints', 'explanationCode', evaluated->>'explanationCode');
END $$;

-- Read actual immutable anchors, never caller-supplied composite rows. This
-- preread does not grant runtime INSERT or replace the final locked write guard.
CREATE FUNCTION csm_source_approval_result_fn(source_id TEXT, approval_id TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  source "ContributionShadowLegacySourceAnchor";
  approval "ContributionShadowMappingApproval";
  observation "ContributionShadowObservationWindow";
  policy "ContributionPolicyVersion";
  audit_row audit_logs;
  position "ActivitySessionPosition";
  source_time TIMESTAMPTZ;
  evaluated JSONB;
BEGIN
  SELECT * INTO source FROM "ContributionShadowLegacySourceAnchor" WHERE id = source_id;
  SELECT * INTO approval FROM "ContributionShadowMappingApproval" WHERE id = approval_id;
  IF source.id IS NULL OR approval.id IS NULL THEN
    RAISE EXCEPTION 'shadow mapping source or approval unavailable' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO audit_row FROM audit_logs WHERE id = source."auditLogId";
  SELECT * INTO observation FROM "ContributionShadowObservationWindow" WHERE id = source."windowId";
  source_time := audit_row."createdAt" AT TIME ZONE 'UTC';
  IF audit_row.id IS NULL OR audit_row."shadowProofRequired" IS DISTINCT FROM TRUE OR
    audit_row.success IS DISTINCT FROM TRUE OR audit_row."resourceType" IS DISTINCT FROM 'attendance_sheet' OR
    audit_row."resourceId" IS DISTINCT FROM source."sheetId" OR
    ((audit_row.event = 'attendance-sheet.submit' AND audit_row.context->'extra'->>'operation' = 'submit') OR
      (audit_row.event = 'attendance-sheet.edit' AND audit_row.context->'extra'->>'operation' = 'edit')) IS NOT TRUE OR
    source."legacySourceHash" IS DISTINCT FROM cslsa_source_hash_fn(source) THEN
    RAISE EXCEPTION 'shadow mapping source audit or fingerprint mismatch' USING ERRCODE = '23514';
  END IF;
  -- Closed registration evidence remains valid after operational EXECUTE is
  -- withdrawn; a current mutable authority setting is not historical approval.
  IF NOT EXISTS (SELECT 1 FROM "ContributionShadowMappingRegistrationReceipt" receipt
    WHERE receipt."manifestHash" = approval."manifestHash"
      AND receipt."registeredByUserId" = approval."registeredByUserId"
      AND receipt."createdAt" = approval."approvedAt"
      AND receipt."approvalIdsCanonical" @> jsonb_build_array(approval.id)) THEN
    RAISE EXCEPTION 'shadow mapping approval has no closed registration' USING ERRCODE = '23514';
  END IF;
  -- A later effective revoke/replace removes this predecessor from future use,
  -- never from historical evidence. More than one applicable mapping is hold.
  IF EXISTS (SELECT 1 FROM "ContributionShadowMappingApproval" successor
    WHERE successor."previousApprovalId" = approval.id
      AND successor."approvedAt" <= source_time AND successor."effectiveFrom" <= source_time
      AND successor."eventKindCode" IN ('revoke','replace')) THEN
    RAISE EXCEPTION 'shadow mapping approval was superseded at source time' USING ERRCODE = '23514';
  END IF;
  IF (SELECT count(*) FROM "ContributionShadowMappingApproval" candidate
    WHERE candidate."activityId" = source."activityId"
      AND candidate."activityTypeCode" = source."activityTypeCode"
      AND candidate."attendanceRoleCode" = source."attendanceRoleCode"
      AND candidate."mappingVersion" = observation."signedMappingVersion"
      AND candidate."eventKindCode" IN ('approve','replace')
      AND candidate."approvedAt" <= source_time AND candidate."effectiveFrom" <= source_time
      AND (candidate."effectiveUntil" IS NULL OR candidate."effectiveUntil" > source_time)
      AND NOT EXISTS (SELECT 1 FROM "ContributionShadowMappingApproval" successor
        WHERE successor."previousApprovalId" = candidate.id
          AND successor."approvedAt" <= source_time AND successor."effectiveFrom" <= source_time
          AND successor."eventKindCode" IN ('revoke','replace'))) <> 1 THEN
    RAISE EXCEPTION 'shadow mapping approval set is ambiguous or unavailable' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO position FROM "ActivitySessionPosition" WHERE id = approval."sessionPositionId";
  IF position.id IS NULL OR position."activityId" IS DISTINCT FROM source."activityId" OR
    position."attendanceRoleCode" IS DISTINCT FROM approval."policyRoleCode" OR position."deletedAt" IS NOT NULL OR
    NOT EXISTS (SELECT 1 FROM "ActivitySession" session WHERE session.id = position."sessionId"
      AND session."activityId" = source."activityId" AND session."deletedAt" IS NULL) THEN
    RAISE EXCEPTION 'shadow mapping actual position unavailable' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO policy FROM "ContributionPolicyVersion" WHERE id = approval."policyVersionId";
  IF policy.id IS NULL OR policy."effectiveFrom" > source_time OR
    (policy."effectiveUntil" IS NOT NULL AND policy."effectiveUntil" <= source_time) THEN
    RAISE EXCEPTION 'shadow mapping policy interval unavailable' USING ERRCODE = '23514';
  END IF;
  evaluated := csm_mapping_inputs_result_fn(approval,source,observation,policy,source_time);
  RETURN evaluated || jsonb_build_object('approvalId',approval.id,'legacySourceAnchorId',source.id,
    'activityId',source."activityId",'recordId',source."recordId",'memberId',source."memberId",
    'sessionPositionId',position.id,'policyVersionId',policy.id,
    'policyDefinitionHash',policy."definitionHash",'evaluatorVersion',policy."evaluatorVersion");
END $$;

CREATE FUNCTION csm_immutable_guard_fn() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'shadow mapping evidence is immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER csma_immutable_guard BEFORE UPDATE OR DELETE ON "ContributionShadowMappingApproval"
  FOR EACH ROW EXECUTE FUNCTION csm_immutable_guard_fn();
CREATE TRIGGER csmap_immutable_guard BEFORE UPDATE OR DELETE ON "ContributionShadowMappingApplication"
  FOR EACH ROW EXECUTE FUNCTION csm_immutable_guard_fn();
CREATE TRIGGER csmrr_immutable_guard BEFORE UPDATE OR DELETE ON "ContributionShadowMappingRegistrationReceipt"
  FOR EACH ROW EXECUTE FUNCTION csm_immutable_guard_fn();
CREATE TRIGGER csma_no_truncate BEFORE TRUNCATE ON "ContributionShadowMappingApproval"
  FOR EACH STATEMENT EXECUTE FUNCTION csm_immutable_guard_fn();
CREATE TRIGGER csmap_no_truncate BEFORE TRUNCATE ON "ContributionShadowMappingApplication"
  FOR EACH STATEMENT EXECUTE FUNCTION csm_immutable_guard_fn();
CREATE TRIGGER csmrr_no_truncate BEFORE TRUNCATE ON "ContributionShadowMappingRegistrationReceipt"
  FOR EACH STATEMENT EXECUTE FUNCTION csm_immutable_guard_fn();

-- Until registration and database evaluation guards are implemented and verified,
-- every new evidence write is rejected. This scaffold is NOT the completed D2 contract.
CREATE FUNCTION csm_pending_insert_guard_fn() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'shadow mapping proof runtime is not yet verified' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER csma_pending_insert_guard BEFORE INSERT ON "ContributionShadowMappingApproval"
  FOR EACH ROW EXECUTE FUNCTION csm_pending_insert_guard_fn();
CREATE TRIGGER csmap_pending_insert_guard BEFORE INSERT ON "ContributionShadowMappingApplication"
  FOR EACH ROW EXECUTE FUNCTION csm_pending_insert_guard_fn();
CREATE TRIGGER csmrr_pending_insert_guard BEFORE INSERT ON "ContributionShadowMappingRegistrationReceipt"
  FOR EACH ROW EXECUTE FUNCTION csm_pending_insert_guard_fn();

-- The deployment operator must bind exactly one reviewed manifest and Human actor
-- through the separate ACL script. Migration alone never grants registration.
-- Caller-controlled GUCs, supplied hashes and database usernames are not approval.
CREATE FUNCTION csm_registration_authority_fn() RETURNS JSONB
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT NULL::JSONB
$$;
REVOKE ALL ON FUNCTION csm_registration_authority_fn() FROM PUBLIC;

CREATE FUNCTION csm_assert_registration_authority_fn(manifest JSONB, actor_id TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE authority JSONB; role_row RECORD;
BEGIN
  authority := csm_registration_authority_fn();
  IF NOT coalesce(csm_exact_keys_fn(authority, ARRAY['databaseName','manifestHash','actorUserId',
    'approvalReference','ownerRole','registrarRole','runtimeRole','manifest']),FALSE) OR
    authority->>'databaseName' IS DISTINCT FROM current_database() OR
    authority->>'manifestHash' IS DISTINCT FROM csm_manifest_hash_fn(manifest) OR
    authority->'manifest' IS DISTINCT FROM manifest OR
    authority->>'actorUserId' IS DISTINCT FROM actor_id OR
    authority->>'approvalReference' IS DISTINCT FROM manifest->>'approvalReference' OR
    authority->>'ownerRole' IS DISTINCT FROM current_user::TEXT OR
    authority->>'registrarRole' IS DISTINCT FROM session_user::TEXT OR
    authority->>'ownerRole' = authority->>'registrarRole' OR
    authority->>'ownerRole' = authority->>'runtimeRole' OR
    authority->>'registrarRole' = authority->>'runtimeRole' THEN
    RAISE EXCEPTION 'shadow mapping registration authority unavailable' USING ERRCODE = '42501';
  END IF;
  FOR role_row IN SELECT * FROM pg_roles WHERE rolname = ANY(ARRAY[
    authority->>'ownerRole',authority->>'registrarRole',authority->>'runtimeRole']) LOOP
    IF role_row.rolsuper OR role_row.rolcreaterole OR role_row.rolcreatedb OR
      role_row.rolreplication OR role_row.rolbypassrls OR
      (role_row.rolname = authority->>'ownerRole' AND role_row.rolcanlogin) THEN
      RAISE EXCEPTION 'shadow mapping registration role isolation invalid' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_roles WHERE rolname = ANY(ARRAY[
      authority->>'ownerRole',authority->>'registrarRole',authority->>'runtimeRole'])) <> 3 OR
    pg_has_role(authority->>'registrarRole',authority->>'ownerRole','MEMBER') OR
    pg_has_role(authority->>'runtimeRole',authority->>'ownerRole','MEMBER') OR
    pg_has_role(authority->>'runtimeRole',authority->>'registrarRole','MEMBER') OR
    pg_has_role(authority->>'registrarRole',authority->>'runtimeRole','MEMBER') THEN
    RAISE EXCEPTION 'shadow mapping registration role isolation invalid' USING ERRCODE = '42501';
  END IF;
  RETURN authority;
END $$;
REVOKE ALL ON FUNCTION csm_assert_registration_authority_fn(JSONB,TEXT) FROM PUBLIC;

-- Independent database check; never substitutes for full JWT verification in the
-- Human command service. Clock is re-read after locks, not transaction start time.
CREATE FUNCTION csm_assert_registration_human_fn(actor_id TEXT) RETURNS "Role"
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor_role "Role"; checked_at TIMESTAMP(3);
BEGIN
  PERFORM 1 FROM "User" WHERE id = actor_id FOR SHARE;
  PERFORM 1 FROM role_bindings b JOIN roles r ON r.id = b."roleId"
    JOIN role_permissions rp ON rp."roleId" = r.id
    JOIN permissions p ON p.id = rp."permissionId"
    WHERE b."principalType" = 'USER' AND b."principalId" = actor_id AND
      b."scopeType" = 'GLOBAL' AND p.code = 'contribution-shadow-mapping.register.approval'
    ORDER BY b.id, r.id, rp.id, p.id FOR SHARE OF b,r,rp,p;
  checked_at := clock_timestamp() AT TIME ZONE 'UTC';
  SELECT role INTO actor_role FROM "User" WHERE id = actor_id AND status = 'ACTIVE' AND "deletedAt" IS NULL;
  IF actor_role IS NULL OR NOT EXISTS (
    SELECT 1 FROM role_bindings b JOIN roles r ON r.id = b."roleId"
      JOIN role_permissions rp ON rp."roleId" = r.id JOIN permissions p ON p.id = rp."permissionId"
    WHERE b."principalType" = 'USER' AND b."principalId" = actor_id AND b."scopeType" = 'GLOBAL' AND
      b.status = 'ACTIVE' AND b."deletedAt" IS NULL AND r."deletedAt" IS NULL AND
      b."startedAt" <= checked_at AND (b."endedAt" IS NULL OR b."endedAt" >= checked_at) AND
      p.code = 'contribution-shadow-mapping.register.approval' AND
      NOT p."servicePrincipalAllowed" AND NOT p."delegatedAccessAllowed"
  ) THEN
    RAISE EXCEPTION 'shadow mapping registration Human grant unavailable' USING ERRCODE = '42501';
  END IF;
  RETURN actor_role;
END $$;
REVOKE ALL ON FUNCTION csm_assert_registration_human_fn(TEXT) FROM PUBLIC;

-- Single atomic registrar. It remains unusable until trusted ACL configuration;
-- registrar has EXECUTE only, never raw INSERT on approval or receipt tables.
CREATE FUNCTION csm_register_mapping_fn(manifest JSONB, actor_id TEXT,
  receipt_id TEXT, audit_id TEXT, approval_ids JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE digest TEXT; payload_hash TEXT; actor_role "Role"; registered_at TIMESTAMPTZ(3);
  existing "ContributionShadowMappingRegistrationReceipt"; item JSONB; ordinal INTEGER;
BEGIN
  PERFORM csm_assert_registration_authority_fn(manifest,actor_id);
  actor_role := csm_assert_registration_human_fn(actor_id);
  digest := csm_manifest_hash_fn(manifest);
  payload_hash := encode(sha256(convert_to(csm_manifest_canonical_fn(jsonb_build_object(
    'manifestHash',digest,'registeredByUserId',actor_id)), 'UTF8')), 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('SRVF:E3-2:mapping-registration:' ||
    (manifest->>'commandKey'),0));
  -- Authenticated service also re-verifies the credential after obtaining this
  -- lock; the database independently checks current authority and real grant.
  PERFORM csm_assert_registration_authority_fn(manifest,actor_id);
  actor_role := csm_assert_registration_human_fn(actor_id);
  SELECT * INTO existing FROM "ContributionShadowMappingRegistrationReceipt"
    WHERE "commandKey" = manifest->>'commandKey';
  IF FOUND THEN
    IF existing."payloadHash" <> payload_hash OR existing."manifestHash" <> digest OR
      existing."registeredByUserId" <> actor_id THEN
      RAISE EXCEPTION 'shadow mapping registration replay mismatch' USING ERRCODE = '23514';
    END IF;
    RETURN to_jsonb(existing);
  END IF;
  IF NOT csm_text_limit_fn(to_jsonb(receipt_id),128) OR NOT csm_text_limit_fn(to_jsonb(audit_id),128) OR
    jsonb_typeof(approval_ids) IS DISTINCT FROM 'array' OR
    jsonb_array_length(approval_ids) <> jsonb_array_length(manifest->'approvals') OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(approval_ids) v WHERE NOT csm_text_limit_fn(v,128)) OR
    (SELECT count(DISTINCT v) FROM jsonb_array_elements(approval_ids) v) <> jsonb_array_length(approval_ids) THEN
    RAISE EXCEPTION 'invalid shadow mapping registration ids' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM "Activity" a WHERE a.id IN (
    SELECT v->>'activityId' FROM jsonb_array_elements(manifest->'approvals') v)
    ORDER BY a.id FOR SHARE;
  PERFORM 1 FROM "ActivitySession" s JOIN "ActivitySessionPosition" p ON p."sessionId" = s.id
    WHERE p.id IN (SELECT v->>'sessionPositionId' FROM jsonb_array_elements(manifest->'approvals') v)
    ORDER BY s.id,p.id FOR SHARE OF s,p;
  PERFORM 1 FROM "ContributionPolicyVersion" p WHERE p.id IN (
    SELECT v->>'policyVersionId' FROM jsonb_array_elements(manifest->'approvals') v)
    ORDER BY p.id FOR SHARE;
  PERFORM 1 FROM "ContributionShadowMappingApproval" a WHERE a.id IN (
    SELECT v->>'previousApprovalId' FROM jsonb_array_elements(manifest->'approvals') v)
    ORDER BY a.id FOR SHARE;
  PERFORM csm_assert_registration_authority_fn(manifest,actor_id);
  actor_role := csm_assert_registration_human_fn(actor_id);
  PERFORM csm_assert_registration_references_fn(manifest);
  registered_at := clock_timestamp();
  FOR item,ordinal IN SELECT value,(ordinality - 1)::INTEGER
    FROM jsonb_array_elements(manifest->'approvals') WITH ORDINALITY LOOP
    INSERT INTO "ContributionShadowMappingApproval" (id,"approvalNumber","mappingVersion","manifestHash",
      "approvalReference","approvedAt","approvedByUserId","registeredByUserId","activityId","activityTypeCode",
      "attendanceRoleCode","sessionPositionId","policyRoleCode","categoryCode","policyVersionId","policyDefinitionHash",
      "evaluatorVersion","durationSourceCode","effectiveFrom","effectiveUntil","eventKindCode","previousApprovalId","createdAt")
    VALUES (approval_ids->>ordinal,item->>'approvalNumber',item->>'mappingVersion',digest,
      manifest->>'approvalReference',registered_at,actor_id,actor_id,item->>'activityId',item->>'activityTypeCode',
      item->>'attendanceRoleCode',item->>'sessionPositionId',item->>'policyRoleCode',item->>'categoryCode',
      item->>'policyVersionId',item->>'policyDefinitionHash',1,'legacy_stored_hours_2',
      (item->>'effectiveFrom')::TIMESTAMPTZ,(item->>'effectiveUntil')::TIMESTAMPTZ,item->>'eventKindCode',
      item->>'previousApprovalId',registered_at);
  END LOOP;
  INSERT INTO audit_logs (id,"createdAt","actorUserId","actorRoleSnap","resourceType","resourceId",event,context,success)
    VALUES (audit_id,registered_at AT TIME ZONE 'UTC',actor_id,actor_role,'contribution_shadow_mapping_registration',receipt_id,
      'activity.contribution-shadow.mapping-register',jsonb_build_object(
        'requestId','shadow-mapping-registration:' || audit_id,'ip',NULL,'ua',NULL,'extra',jsonb_build_object(
        'manifestHash',digest,'approvalCount',jsonb_array_length(approval_ids))),TRUE);
  INSERT INTO "ContributionShadowMappingRegistrationReceipt" (id,"commandKey","payloadHash","manifestHash",
    "registeredByUserId","approvalCount","approvalIdsCanonical","auditLogId","createdAt")
    VALUES (receipt_id,manifest->>'commandKey',payload_hash,digest,actor_id,
      jsonb_array_length(approval_ids),approval_ids,audit_id,registered_at) RETURNING * INTO existing;
  RETURN to_jsonb(existing);
END $$;
REVOKE ALL ON FUNCTION csm_register_mapping_fn(JSONB,TEXT,TEXT,TEXT,JSONB) FROM PUBLIC;

CREATE OR REPLACE FUNCTION csm_pending_insert_guard_fn() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE authority JSONB; manifest JSONB; ordinal INTEGER; approval "ContributionShadowMappingApproval";
  receipt "ContributionShadowMappingRegistrationReceipt"; audit_row audit_logs; expected_payload TEXT;
BEGIN
  authority := csm_registration_authority_fn();
  IF TG_TABLE_NAME = 'ContributionShadowMappingApplication' OR authority IS NULL THEN
    RAISE EXCEPTION 'shadow mapping proof runtime is not yet verified' USING ERRCODE = '23514';
  END IF;
  manifest := authority->'manifest';
  PERFORM csm_assert_registration_authority_fn(manifest,authority->>'actorUserId');
  PERFORM csm_assert_registration_human_fn(authority->>'actorUserId');
  IF TG_TABLE_NAME = 'ContributionShadowMappingApproval' THEN
    SELECT (ordinality - 1)::INTEGER INTO ordinal
      FROM jsonb_array_elements(manifest->'approvals') WITH ORDINALITY
      WHERE value->>'approvalNumber' = NEW."approvalNumber";
    IF ordinal IS NULL OR NOT csm_approval_matches_manifest_fn(NEW,manifest,ordinal,
      authority->>'actorUserId',NEW."approvedAt") OR
      NEW."approvedAt" < transaction_timestamp()::TIMESTAMPTZ(3) OR
      NEW."approvedAt" > clock_timestamp()::TIMESTAMPTZ(3) THEN
      RAISE EXCEPTION 'shadow mapping approval differs from trusted manifest' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  receipt := NEW;
  expected_payload := encode(sha256(convert_to(csm_manifest_canonical_fn(jsonb_build_object(
    'manifestHash',authority->>'manifestHash','registeredByUserId',authority->>'actorUserId')), 'UTF8')), 'hex');
  IF receipt."commandKey" IS DISTINCT FROM manifest->>'commandKey' OR
    receipt."manifestHash" IS DISTINCT FROM authority->>'manifestHash' OR
    receipt."registeredByUserId" IS DISTINCT FROM authority->>'actorUserId' OR
    receipt."payloadHash" IS DISTINCT FROM expected_payload OR
    receipt."approvalCount" IS DISTINCT FROM jsonb_array_length(manifest->'approvals') OR
    jsonb_typeof(receipt."approvalIdsCanonical") IS DISTINCT FROM 'array' OR
    jsonb_array_length(receipt."approvalIdsCanonical") IS DISTINCT FROM receipt."approvalCount" OR
    (SELECT count(DISTINCT value) FROM jsonb_array_elements(receipt."approvalIdsCanonical")) <> receipt."approvalCount" THEN
    RAISE EXCEPTION 'shadow mapping registration receipt incomplete' USING ERRCODE = '23514';
  END IF;
  FOR ordinal IN 0 .. receipt."approvalCount" - 1 LOOP
    SELECT * INTO approval FROM "ContributionShadowMappingApproval"
      WHERE id = receipt."approvalIdsCanonical"->>ordinal;
    IF NOT FOUND OR NOT csm_approval_matches_manifest_fn(approval,manifest,ordinal,
      receipt."registeredByUserId",receipt."createdAt") THEN
      RAISE EXCEPTION 'shadow mapping registration receipt incomplete' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  SELECT * INTO audit_row FROM audit_logs WHERE id = receipt."auditLogId";
  IF NOT FOUND OR audit_row.event <> 'activity.contribution-shadow.mapping-register' OR
    audit_row."actorUserId" IS DISTINCT FROM receipt."registeredByUserId" OR
    audit_row."actorServicePrincipalId" IS NOT NULL OR audit_row."actorCredentialId" IS NOT NULL OR
    audit_row."onBehalfOfUserId" IS NOT NULL OR audit_row."onBehalfOfRoleSnap" IS NOT NULL OR
    audit_row."createdAt" IS DISTINCT FROM (receipt."createdAt" AT TIME ZONE 'UTC') OR
    audit_row."resourceType" <> 'contribution_shadow_mapping_registration' OR
    audit_row."resourceId" IS DISTINCT FROM receipt.id OR NOT audit_row.success OR audit_row."shadowProofRequired" OR
    audit_row.context IS DISTINCT FROM jsonb_build_object(
      'requestId','shadow-mapping-registration:' || receipt."auditLogId",'ip',NULL,'ua',NULL,'extra',jsonb_build_object(
      'manifestHash',receipt."manifestHash",'approvalCount',receipt."approvalCount")) THEN
    RAISE EXCEPTION 'shadow mapping registration audit incomplete' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION csm_pending_insert_guard_fn() FROM PUBLIC;

CREATE FUNCTION csm_approval_receipt_closure_fn() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "ContributionShadowMappingRegistrationReceipt" r
    WHERE r."manifestHash" = NEW."manifestHash" AND r."registeredByUserId" = NEW."registeredByUserId" AND
      r."createdAt" = NEW."createdAt" AND r."approvalIdsCanonical" @> jsonb_build_array(NEW.id)) THEN
    RAISE EXCEPTION 'shadow mapping approval registration receipt missing' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION csm_approval_receipt_closure_fn() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER csma_receipt_closure AFTER INSERT ON "ContributionShadowMappingApproval"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION csm_approval_receipt_closure_fn();

CREATE TRIGGER csm_registration_audit_immutable BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW WHEN (OLD.event = 'activity.contribution-shadow.mapping-register')
  EXECUTE FUNCTION csm_immutable_guard_fn();

-- Separate runtime identity, installed only by the reviewed ACL bootstrap. It
-- carries no manifest approval and cannot be set by an application GUC.
CREATE FUNCTION csm_runtime_authority_fn() RETURNS JSONB
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$ SELECT NULL::JSONB $$;
REVOKE ALL ON FUNCTION csm_runtime_authority_fn() FROM PUBLIC;

CREATE FUNCTION csm_application_result_fn(source_id TEXT, approval_id TEXT, item_id TEXT)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  result JSONB; source "ContributionShadowLegacySourceAnchor";
  approval "ContributionShadowMappingApproval"; item "ActivityContributionPolicySelectionItem";
  revision "ActivityContributionPolicySelectionRevision"; position "ActivitySessionPosition";
  source_time TIMESTAMPTZ; selection_hash TEXT;
BEGIN
  SELECT * INTO source FROM "ContributionShadowLegacySourceAnchor" WHERE id = source_id;
  SELECT * INTO approval FROM "ContributionShadowMappingApproval" WHERE id = approval_id;
  IF source.id IS NULL OR approval.id IS NULL THEN
    RAISE EXCEPTION 'shadow mapping source or approval unavailable' USING ERRCODE = '23514';
  END IF;
  -- The mutable reference lock order is Activity -> Session -> Position. Each
  -- read after waiting uses a fresh READ COMMITTED snapshot; no preread cache.
  PERFORM 1 FROM "Activity" WHERE id = source."activityId" AND "deletedAt" IS NULL FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shadow mapping actual activity unavailable' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO position FROM "ActivitySessionPosition" WHERE id = approval."sessionPositionId";
  PERFORM 1 FROM "ActivitySession" WHERE id = position."sessionId" FOR SHARE;
  PERFORM 1 FROM "ActivitySessionPosition" WHERE id = position.id FOR SHARE;
  SELECT * INTO position FROM "ActivitySessionPosition" WHERE id = approval."sessionPositionId";
  result := csm_source_approval_result_fn(source_id,approval_id);
  SELECT * INTO item FROM "ActivityContributionPolicySelectionItem" WHERE id = item_id;
  SELECT * INTO revision FROM "ActivityContributionPolicySelectionRevision" WHERE id = item."selectionRevisionId";
  SELECT "createdAt" AT TIME ZONE 'UTC' INTO source_time FROM audit_logs WHERE id = source."auditLogId";
  selection_hash := encode(sha256(convert_to(csm_manifest_canonical_fn(jsonb_build_object(
    'definition',revision."selectionJson",'schemaVersion',revision."schemaVersion")), 'UTF8')), 'hex');
  IF item.id IS NULL OR revision.id IS NULL OR item.mode IS DISTINCT FROM 'explicit' OR
    item."activityId" IS DISTINCT FROM source."activityId" OR revision."activityId" IS DISTINCT FROM source."activityId" OR
    revision."schemaVersion" IS DISTINCT FROM 1 OR revision."selectionHash" IS DISTINCT FROM selection_hash OR
    (revision."createdAt" AT TIME ZONE 'UTC') > source_time OR
    EXISTS (SELECT 1 FROM "ActivityContributionPolicySelectionRevision" newer
      WHERE newer."activityId" = source."activityId" AND newer.revision > revision.revision
        AND (newer."createdAt" AT TIME ZONE 'UTC') <= source_time) OR
    item."versionId" IS DISTINCT FROM approval."policyVersionId" OR
    item."definitionHash" IS DISTINCT FROM approval."policyDefinitionHash" OR
    item."evaluatorVersion" IS DISTINCT FROM approval."evaluatorVersion" OR
    ((item."layerCode" = 'position' AND item."positionId" = position.id AND item."sessionId" = position."sessionId") OR
      (item."layerCode" = 'activity' AND item."positionId" IS NULL AND item."sessionId" IS NULL AND
        NOT EXISTS (SELECT 1 FROM "ActivityContributionPolicySelectionItem" override_item
          WHERE override_item."selectionRevisionId" = revision.id AND override_item."layerCode" = 'position'
            AND override_item."positionId" = position.id AND override_item.mode = 'explicit'))) IS NOT TRUE THEN
    RAISE EXCEPTION 'shadow mapping immutable selection mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN result || jsonb_build_object('selectionItemId',item.id,'selectionRevisionId',revision.id,
    'policyId',item."policyId",'windowId',source."windowId",'auditLogId',source."auditLogId",
    'sheetId',source."sheetId",'sheetVersion',source."sheetVersion");
END $$;

CREATE FUNCTION csm_assert_runtime_fn() RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE authority JSONB;
BEGIN
  authority := csm_runtime_authority_fn();
  IF authority IS NULL OR NOT coalesce(csm_exact_keys_fn(authority,
    ARRAY['databaseName','ownerRole','registrarRole','runtimeRole']),FALSE) OR
    authority->>'databaseName' IS DISTINCT FROM current_database() OR
    authority->>'ownerRole' IS DISTINCT FROM CURRENT_USER OR authority->>'runtimeRole' IS DISTINCT FROM SESSION_USER OR
    (SELECT count(*) FROM pg_roles WHERE rolname = ANY(ARRAY[authority->>'ownerRole',authority->>'registrarRole',authority->>'runtimeRole'])) <> 3 OR
    EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ANY(ARRAY[authority->>'ownerRole',authority->>'registrarRole',authority->>'runtimeRole'])
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) OR
    (SELECT rolcanlogin FROM pg_roles WHERE rolname = authority->>'ownerRole') OR
    pg_has_role(SESSION_USER,authority->>'ownerRole','MEMBER') OR
    pg_has_role(SESSION_USER,authority->>'registrarRole','MEMBER') THEN
    RAISE EXCEPTION 'shadow mapping proof runtime is not yet verified' USING ERRCODE = '23514';
  END IF;
END $$;
REVOKE ALL ON FUNCTION csm_assert_runtime_fn() FROM PUBLIC;

CREATE FUNCTION csm_application_insert_guard_fn() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE result JSONB;
BEGIN
  PERFORM csm_assert_runtime_fn();
  result := csm_application_result_fn(NEW."legacySourceAnchorId",NEW."approvalId",NEW."selectionItemId");
  IF NEW."windowId" IS DISTINCT FROM result->>'windowId' OR NEW."auditLogId" IS DISTINCT FROM result->>'auditLogId' OR
    NEW."sheetId" IS DISTINCT FROM result->>'sheetId' OR NEW."sheetVersion" IS DISTINCT FROM (result->>'sheetVersion')::INTEGER OR
    NEW."recordId" IS DISTINCT FROM result->>'recordId' OR NEW."memberId" IS DISTINCT FROM result->>'memberId' OR
    NEW."activityId" IS DISTINCT FROM result->>'activityId' OR NEW."policyVersionId" IS DISTINCT FROM result->>'policyVersionId' OR
    NEW."policyDefinitionHash" IS DISTINCT FROM result->>'policyDefinitionHash' OR
    NEW."evaluatorVersion" IS DISTINCT FROM (result->>'evaluatorVersion')::INTEGER OR
    NEW."durationSeconds" IS DISTINCT FROM (result->>'durationSeconds')::INTEGER OR
    NEW."policyPoints" IS DISTINCT FROM (result->>'recognizedPoints')::NUMERIC OR
    NEW."explanationCode" IS DISTINCT FROM result->>'explanationCode' OR
    NEW."createdAt" < transaction_timestamp()::TIMESTAMPTZ(3) OR NEW."createdAt" > clock_timestamp()::TIMESTAMPTZ(3) THEN
    RAISE EXCEPTION 'shadow mapping application differs from database proof' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION csm_application_insert_guard_fn() FROM PUBLIC;
DROP TRIGGER csmap_pending_insert_guard ON "ContributionShadowMappingApplication";
CREATE TRIGGER csmap_pending_insert_guard BEFORE INSERT ON "ContributionShadowMappingApplication"
  FOR EACH ROW EXECUTE FUNCTION csm_application_insert_guard_fn();

-- Additive replacement of D1's comparison guard. Retain every original attempt,
-- terminal, set and audit check. Only an existing, immutable application produced
-- by the isolated runtime guard supplies comparable policy values; hashes alone
-- remain auxiliary references, never independent proof.
CREATE OR REPLACE FUNCTION cscr_insert_guard_fn() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_attempt "ContributionShadowAttemptReceipt";
  v_audit "audit_logs";
  v_item "ActivityContributionPolicySelectionItem";
  v_application "ContributionShadowMappingApplication";
  v_source "ContributionShadowLegacySourceAnchor";
  v_found BOOLEAN; v_count BIGINT;
BEGIN
  SELECT * INTO v_attempt FROM "ContributionShadowAttemptReceipt"
    WHERE id = NEW."attemptId" FOR UPDATE;
  IF NOT FOUND OR v_attempt."sheetId" IS DISTINCT FROM NEW."sheetId" OR
    v_attempt."activityId" IS DISTINCT FROM NEW."activityId" THEN
    RAISE EXCEPTION 'shadow comparison attempt chain mismatch' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "ContributionShadowTerminalReceipt" WHERE "attemptId" = NEW."attemptId") THEN
    RAISE EXCEPTION 'shadow comparison after terminal' USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO v_count FROM "ContributionShadowComparisonReceipt" WHERE "attemptId" = NEW."attemptId";
  IF v_count >= v_attempt."expectedRecordCount" THEN
    RAISE EXCEPTION 'shadow comparison exceeds expected set' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_audit FROM audit_logs WHERE id = v_attempt."auditLogId" FOR SHARE;
  -- Positive string-object containment is the same-object membership witness.
  -- Misses retain the original text-coercion scan, including malformed-array
  -- errors and legacy numeric/boolean text matches. No negative shortcut.
  IF jsonb_typeof(v_audit.context->'after'->'records') = 'array' AND
    (v_audit.context->'after'->'records') @> jsonb_build_array(
      jsonb_build_object('id',NEW."recordId",'memberId',NEW."memberId")) THEN
    v_found := TRUE;
  ELSE
    SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(v_audit.context->'after'->'records') AS e(value)
      WHERE value->>'id' = NEW."recordId" AND value->>'memberId' = NEW."memberId") INTO v_found;
  END IF;
  IF NOT v_found THEN
    RAISE EXCEPTION 'shadow record not in exact audit snapshot' USING ERRCODE = '23514';
  END IF;
  IF NEW."selectionItemId" IS NOT NULL THEN
    SELECT * INTO v_item FROM "ActivityContributionPolicySelectionItem" WHERE id = NEW."selectionItemId" FOR SHARE;
    IF NOT FOUND OR v_item."selectionRevisionId" IS DISTINCT FROM NEW."selectionRevisionId" OR
      v_item."activityId" IS DISTINCT FROM NEW."activityId" OR v_item."policyId" IS DISTINCT FROM NEW."policyId" OR
      v_item."versionId" IS DISTINCT FROM NEW."policyVersionId" OR
      v_item."definitionHash" IS DISTINCT FROM NEW."definitionHash" OR
      v_item."evaluatorVersion" IS DISTINCT FROM NEW."evaluatorVersion" THEN
      RAISE EXCEPTION 'shadow policy selection/version mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.comparable AND (NEW."selectionItemId" IS NULL OR NEW."legacyServiceHours" IS NULL OR
    NEW."durationSeconds" IS NULL OR NEW."legacyPoints" IS NULL OR NEW."policyPoints" IS NULL OR
    NEW."policySourceHash" IS NULL OR NEW."factHash" IS NULL) THEN
    RAISE EXCEPTION 'shadow comparable proof is incomplete' USING ERRCODE = '23514';
  END IF;
  IF NEW.comparable THEN
    SELECT * INTO v_application FROM "ContributionShadowMappingApplication"
      WHERE "auditLogId" = v_attempt."auditLogId" AND "recordId" = NEW."recordId";
    SELECT * INTO v_source FROM "ContributionShadowLegacySourceAnchor" WHERE id = v_application."legacySourceAnchorId";
    IF v_application.id IS NULL OR v_source.id IS NULL THEN
      RAISE EXCEPTION 'shadow comparison requires immutable legacy-source proof' USING ERRCODE = '23514';
    END IF;
    PERFORM csm_assert_runtime_fn();
    IF v_audit."shadowProofRequired" IS DISTINCT FROM TRUE OR
      v_source."legacySourceHash" IS DISTINCT FROM cslsa_source_hash_fn(v_source) OR
      v_application."windowId" IS DISTINCT FROM v_attempt."windowId" OR
      v_application."sheetVersion" IS DISTINCT FROM v_attempt."sheetVersion" OR
      v_application."sheetId" IS DISTINCT FROM NEW."sheetId" OR
      v_application."memberId" IS DISTINCT FROM NEW."memberId" OR
      v_application."activityId" IS DISTINCT FROM NEW."activityId" OR
      v_application."selectionItemId" IS DISTINCT FROM NEW."selectionItemId" OR
      v_application."policyVersionId" IS DISTINCT FROM NEW."policyVersionId" OR
      v_application."policyDefinitionHash" IS DISTINCT FROM NEW."definitionHash" OR
      v_application."evaluatorVersion" IS DISTINCT FROM NEW."evaluatorVersion" OR
      v_application."durationSeconds" IS DISTINCT FROM NEW."durationSeconds" OR
      v_application."policyPoints" IS DISTINCT FROM NEW."policyPoints" OR
      v_source."legacyServiceHours" IS DISTINCT FROM NEW."legacyServiceHours" OR
      v_source."legacyPoints" IS DISTINCT FROM NEW."legacyPoints" OR
      v_source."legacyRuleId" IS DISTINCT FROM NEW."legacyRuleId" OR
      v_source."legacySourceHash" IS DISTINCT FROM NEW."legacySourceHash" OR
      NEW."classificationCode" IS DISTINCT FROM (CASE WHEN v_source."legacyPoints" = v_application."policyPoints"
        THEN 'equal' ELSE 'points_mismatch' END) OR NEW."failureCode" IS NOT NULL THEN
      RAISE EXCEPTION 'shadow comparison differs from immutable application proof' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION cscr_insert_guard_fn() FROM PUBLIC;

-- Preserve D1 guard bodies and their complete validation semantics. The
-- NOLOGIN definer reads/locks their anchor rows; a runtime login receives no
-- AuditLog snapshot read or UPDATE privilege on old attendance business tables.
ALTER FUNCTION csar_insert_guard_fn() SECURITY DEFINER;
ALTER FUNCTION csar_insert_guard_fn() SET search_path = pg_catalog, public, pg_temp;
REVOKE ALL ON FUNCTION csar_insert_guard_fn() FROM PUBLIC;
ALTER FUNCTION cstr_insert_guard_fn() SECURITY DEFINER;
ALTER FUNCTION cstr_insert_guard_fn() SET search_path = pg_catalog, public, pg_temp;
REVOKE ALL ON FUNCTION cstr_insert_guard_fn() FROM PUBLIC;

COMMIT;
