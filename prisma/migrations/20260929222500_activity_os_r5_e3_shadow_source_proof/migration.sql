-- Activity OS R5 / E3-2 D2 draft. Additive source proof only.
-- Keep the D1 comparison guard fail-closed until exact same-chain proof is validated.
BEGIN;

ALTER TABLE "audit_logs"
  ADD COLUMN "shadowProofRequired" BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE "ContributionShadowLegacySourceAnchor" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "windowId" TEXT NOT NULL,
  "auditLogId" TEXT NOT NULL,
  "sheetId" TEXT NOT NULL,
  "sheetVersion" INTEGER NOT NULL,
  "activityId" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "activityTypeCode" TEXT NOT NULL,
  "attendanceRoleCode" TEXT NOT NULL,
  "legacyServiceHours" DECIMAL(5,2) NOT NULL,
  "sourceKindCode" TEXT NOT NULL,
  "legacyRuleId" TEXT,
  "durationThreshold" DECIMAL(5,2),
  "pointsBelow" DECIMAL(5,2),
  "pointsAbove" DECIMAL(5,2),
  "legacyPoints" DECIMAL(5,2) NOT NULL,
  "hashAlgorithmCode" TEXT NOT NULL,
  "canonicalVersion" INTEGER NOT NULL,
  "legacySourceHash" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT cslsa_window_fk FOREIGN KEY ("windowId")
    REFERENCES "ContributionShadowObservationWindow"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT cslsa_audit_fk FOREIGN KEY ("auditLogId")
    REFERENCES "audit_logs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT cslsa_sheet_activity_fk FOREIGN KEY ("sheetId", "activityId")
    REFERENCES "AttendanceSheet"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT cslsa_record_chain_fk FOREIGN KEY ("recordId", "sheetId", "memberId")
    REFERENCES "AttendanceRecord"("id", "sheetId", "memberId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT cslsa_legacy_rule_fk FOREIGN KEY ("legacyRuleId")
    REFERENCES "ContributionRule"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT cslsa_source_group_check CHECK (
    ("sourceKindCode" = 'matched' AND "legacyRuleId" IS NOT NULL AND
      "pointsBelow" IS NOT NULL AND
      ("pointsAbove" IS NULL OR "durationThreshold" IS NOT NULL)) OR
    ("sourceKindCode" = 'no_match' AND "legacyRuleId" IS NULL AND
      "durationThreshold" IS NULL AND "pointsBelow" IS NULL AND
      "pointsAbove" IS NULL AND "legacyPoints" = 0.00)
  ),
  CONSTRAINT cslsa_value_check CHECK (
    "sheetVersion" >= 1 AND "legacyServiceHours" > 0 AND "legacyPoints" >= 0 AND
    ("durationThreshold" IS NULL OR "durationThreshold" >= 0) AND
    ("pointsBelow" IS NULL OR "pointsBelow" >= 0) AND
    ("pointsAbove" IS NULL OR "pointsAbove" >= 0)
  ),
  CONSTRAINT cslsa_digest_check CHECK (
    "hashAlgorithmCode" = 'sha256' AND "canonicalVersion" = 1 AND
    "legacySourceHash" ~ '^[a-f0-9]{64}$'
  )
);
CREATE UNIQUE INDEX "cslsa_audit_record_key"
  ON "ContributionShadowLegacySourceAnchor"("auditLogId", "recordId");
CREATE INDEX "cslsa_record_chain_idx"
  ON "ContributionShadowLegacySourceAnchor"("recordId", "sheetId", "memberId");

-- The old audit contract remains writable only while its proof bit stays false.
-- A proof-bearing audit row is immutable; false cannot be upgraded later.
CREATE FUNCTION cslsa_audit_immutable_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."shadowProofRequired" THEN
      RAISE EXCEPTION 'shadow proof audit is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."shadowProofRequired" OR NEW."shadowProofRequired" IS DISTINCT FROM OLD."shadowProofRequired" THEN
    RAISE EXCEPTION 'shadow proof audit flag is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cslsa_audit_immutable_guard
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION cslsa_audit_immutable_guard_fn();

-- Every field uses N for null or S<UTF-8 byte length>:<value>.
CREATE FUNCTION cslsa_canonical_field_fn(v TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN v IS NULL THEN 'N' ELSE 'S' || octet_length(convert_to(v, 'UTF8'))::TEXT || ':' || v END
$$;

CREATE FUNCTION cslsa_source_hash_fn(v "ContributionShadowLegacySourceAnchor") RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(
    'SRVF:E3-2:legacy-source:v1:' ||
    cslsa_canonical_field_fn(v."windowId") ||
    cslsa_canonical_field_fn(v."auditLogId") ||
    cslsa_canonical_field_fn(v."sheetId") ||
    cslsa_canonical_field_fn(v."sheetVersion"::TEXT) ||
    cslsa_canonical_field_fn(v."activityId") ||
    cslsa_canonical_field_fn(v."recordId") ||
    cslsa_canonical_field_fn(v."memberId") ||
    cslsa_canonical_field_fn(v."activityTypeCode") ||
    cslsa_canonical_field_fn(v."attendanceRoleCode") ||
    cslsa_canonical_field_fn(v."legacyServiceHours"::TEXT) ||
    cslsa_canonical_field_fn(v."sourceKindCode") ||
    cslsa_canonical_field_fn(v."legacyRuleId") ||
    cslsa_canonical_field_fn(v."durationThreshold"::TEXT) ||
    cslsa_canonical_field_fn(v."pointsBelow"::TEXT) ||
    cslsa_canonical_field_fn(v."pointsAbove"::TEXT) ||
    cslsa_canonical_field_fn(v."legacyPoints"::TEXT), 'UTF8')), 'hex')
$$;

CREATE FUNCTION cslsa_insert_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_audit "audit_logs"%ROWTYPE;
  v_window "ContributionShadowObservationWindow"%ROWTYPE;
  v_sheet "AttendanceSheet"%ROWTYPE;
  v_record "AttendanceRecord"%ROWTYPE;
  v_activity_type TEXT;
  v_rule "ContributionRule"%ROWTYPE;
  v_active_count INTEGER;
  v_fact JSONB;
  v_expected NUMERIC(5,2);
BEGIN
  SELECT * INTO v_audit FROM "audit_logs" WHERE "id" = NEW."auditLogId" FOR SHARE;
  SELECT * INTO v_window FROM "ContributionShadowObservationWindow" WHERE "id" = NEW."windowId" FOR SHARE;
  SELECT * INTO v_sheet FROM "AttendanceSheet" WHERE "id" = NEW."sheetId" FOR SHARE;
  SELECT * INTO v_record FROM "AttendanceRecord" WHERE "id" = NEW."recordId" FOR SHARE;
  IF v_audit."id" IS NULL OR v_window."id" IS NULL OR v_sheet."id" IS NULL OR v_record."id" IS NULL THEN
    RAISE EXCEPTION 'shadow source anchor missing' USING ERRCODE = '23514';
  END IF;
  IF v_audit."shadowProofRequired" IS DISTINCT FROM TRUE OR
     v_audit."success" IS DISTINCT FROM TRUE OR
     v_audit."resourceType" IS DISTINCT FROM 'attendance_sheet' OR
     v_audit."resourceId" IS DISTINCT FROM NEW."sheetId" OR
     ((v_audit."event" = 'attendance-sheet.submit' AND v_audit."context"->'extra'->>'operation' = 'submit') OR
      (v_audit."event" = 'attendance-sheet.edit' AND v_audit."context"->'extra'->>'operation' = 'edit')) IS NOT TRUE OR
     (v_audit."createdAt" AT TIME ZONE 'UTC') < v_window."startsAt" OR
     (v_audit."createdAt" AT TIME ZONE 'UTC') >= v_window."endsAt" OR
     v_sheet."activityId" IS DISTINCT FROM NEW."activityId" OR
     v_sheet."version" IS DISTINCT FROM NEW."sheetVersion" OR
     v_record."sheetId" IS DISTINCT FROM NEW."sheetId" OR
     v_record."memberId" IS DISTINCT FROM NEW."memberId" OR
     v_record."roleCode" IS DISTINCT FROM NEW."attendanceRoleCode" OR
     v_record."serviceHours" IS DISTINCT FROM NEW."legacyServiceHours" OR
     v_record."contributionPoints" IS DISTINCT FROM NEW."legacyPoints" OR
     v_record."deletedAt" IS NOT NULL OR
     v_audit."context"->'after'->'sheet'->>'activityId' IS DISTINCT FROM NEW."activityId" OR
     v_audit."context"->'after'->'sheet'->>'version' IS DISTINCT FROM NEW."sheetVersion"::TEXT THEN
    RAISE EXCEPTION 'shadow source chain mismatch' USING ERRCODE = '23514';
  END IF;
  SELECT "activityTypeCode" INTO v_activity_type FROM "Activity" WHERE "id" = NEW."activityId" FOR SHARE;
  IF v_activity_type IS DISTINCT FROM NEW."activityTypeCode" THEN
    RAISE EXCEPTION 'shadow activity type mismatch' USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(v_audit."context"->'after'->'records') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'shadow audit records are not an array' USING ERRCODE = '23514';
  END IF;
  SELECT e.value INTO v_fact
    FROM jsonb_array_elements(v_audit."context"->'after'->'records') AS e(value)
    WHERE e.value->>'id' = NEW."recordId";
  IF NOT FOUND OR v_fact->>'memberId' IS DISTINCT FROM NEW."memberId" OR
     v_fact->>'roleCode' IS DISTINCT FROM NEW."attendanceRoleCode" OR
     (CASE WHEN v_fact->>'serviceHours' ~ '^[0-9]+(\.[0-9]+)?$'
       THEN (v_fact->>'serviceHours')::NUMERIC ELSE NULL END) IS DISTINCT FROM NEW."legacyServiceHours" OR
     (CASE WHEN v_fact->>'contributionPoints' ~ '^[0-9]+(\.[0-9]+)?$'
       THEN (v_fact->>'contributionPoints')::NUMERIC ELSE NULL END) IS DISTINCT FROM NEW."legacyPoints" THEN
    RAISE EXCEPTION 'shadow source not in exact audit snapshot' USING ERRCODE = '23514';
  END IF;
  IF NEW."sourceKindCode" = 'matched' THEN
    v_active_count := 0;
    FOR v_rule IN SELECT * FROM "ContributionRule"
      WHERE "activityTypeCode" = NEW."activityTypeCode" AND
        "attendanceRoleCode" = NEW."attendanceRoleCode" AND
        "status" = 'ACTIVE' AND "deletedAt" IS NULL
      ORDER BY "id" FOR SHARE
    LOOP
      v_active_count := v_active_count + 1;
    END LOOP;
    IF v_active_count <> 1 OR v_rule."id" IS DISTINCT FROM NEW."legacyRuleId" THEN
      RAISE EXCEPTION 'shadow legacy active pair is not unique' USING ERRCODE = '23514';
    END IF;
    IF v_rule."durationThreshold" IS DISTINCT FROM NEW."durationThreshold" OR
       v_rule."pointsBelow" IS DISTINCT FROM NEW."pointsBelow" OR
       v_rule."pointsAbove" IS DISTINCT FROM NEW."pointsAbove" THEN
      RAISE EXCEPTION 'shadow legacy rule drift' USING ERRCODE = '23514';
    END IF;
    v_expected := CASE WHEN v_rule."durationThreshold" IS NULL OR
      NEW."legacyServiceHours" <= v_rule."durationThreshold"
      THEN v_rule."pointsBelow" ELSE coalesce(v_rule."pointsAbove", v_rule."pointsBelow") END;
    IF v_expected IS DISTINCT FROM NEW."legacyPoints" THEN
      RAISE EXCEPTION 'shadow legacy result mismatch' USING ERRCODE = '23514';
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM "ContributionRule" WHERE "activityTypeCode" = NEW."activityTypeCode"
      AND "attendanceRoleCode" = NEW."attendanceRoleCode" AND "status" = 'ACTIVE' AND "deletedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'shadow no_match observed active rule' USING ERRCODE = '23514';
  END IF;
  IF NEW."legacySourceHash" IS DISTINCT FROM cslsa_source_hash_fn(NEW) THEN
    RAISE EXCEPTION 'shadow source digest mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cslsa_insert_guard BEFORE INSERT ON "ContributionShadowLegacySourceAnchor"
  FOR EACH ROW EXECUTE FUNCTION cslsa_insert_guard_fn();

CREATE TRIGGER cslsa_immutable_guard BEFORE UPDATE OR DELETE ON "ContributionShadowLegacySourceAnchor"
  FOR EACH ROW EXECUTE FUNCTION cs_immutable_guard_fn();
CREATE TRIGGER cslsa_no_truncate BEFORE TRUNCATE ON "ContributionShadowLegacySourceAnchor"
  FOR EACH STATEMENT EXECUTE FUNCTION cs_immutable_guard_fn();

-- A proof-bearing audit can commit only with the exact complete anchor set.
CREATE FUNCTION cslsa_audit_complete_fn() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_records JSONB;
  v_expected BIGINT;
  v_actual BIGINT;
  v_distinct BIGINT;
BEGIN
  IF NOT NEW."shadowProofRequired" THEN RETURN NEW; END IF;
  v_records := NEW."context"->'after'->'records';
  IF jsonb_typeof(v_records) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'shadow audit record set missing' USING ERRCODE = '23514';
  END IF;
  v_expected := jsonb_array_length(v_records);
  SELECT count(DISTINCT e.value->>'id') INTO v_distinct FROM jsonb_array_elements(v_records) AS e(value);
  SELECT count(*) INTO v_actual FROM "ContributionShadowLegacySourceAnchor" WHERE "auditLogId" = NEW."id";
  IF v_expected = 0 OR v_expected <> v_distinct OR v_actual <> v_expected OR
     EXISTS (
       SELECT e.value->>'id' FROM jsonb_array_elements(v_records) AS e(value)
       EXCEPT
       SELECT a."recordId" FROM "ContributionShadowLegacySourceAnchor" a WHERE a."auditLogId" = NEW."id"
     ) OR EXISTS (
       SELECT a."recordId" FROM "ContributionShadowLegacySourceAnchor" a WHERE a."auditLogId" = NEW."id"
       EXCEPT
       SELECT e.value->>'id' FROM jsonb_array_elements(v_records) AS e(value)
     ) THEN
    RAISE EXCEPTION 'shadow audit source set incomplete' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER cslsa_audit_complete
  AFTER INSERT ON "audit_logs" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cslsa_audit_complete_fn();

COMMIT;
