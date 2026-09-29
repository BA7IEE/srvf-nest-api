-- Activity OS R5 / E3-2 D1: isolated-test candidate. Not signed under 3b.
-- Additive evidence foundation; no old business-row DML, backfill, or deletion.
BEGIN;

CREATE UNIQUE INDEX "attendance_sheet_id_activity_key"
  ON "AttendanceSheet"("id", "activityId");
CREATE UNIQUE INDEX "attendance_record_id_sheet_member_key"
  ON "AttendanceRecord"("id", "sheetId", "memberId");
CREATE UNIQUE INDEX "acps_item_id_revision_activity_key"
  ON "ActivityContributionPolicySelectionItem"("id", "selectionRevisionId", "activityId");

CREATE TABLE "ContributionShadowObservationWindow" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "startsAt" TIMESTAMPTZ(3) NOT NULL,
  "endsAt" TIMESTAMPTZ(3) NOT NULL,
  "registeredByUserId" TEXT NOT NULL,
  "deploymentDigest" TEXT NOT NULL,
  "configDigest" TEXT NOT NULL,
  "signedMappingVersion" TEXT NOT NULL,
  "hashAlgorithmCode" TEXT NOT NULL,
  "canonicalVersion" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT csow_registrar_fk FOREIGN KEY ("registeredByUserId")
    REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT csow_range_check CHECK ("startsAt" < "endsAt"),
  CONSTRAINT csow_digest_check CHECK (
    "deploymentDigest" ~ '^[a-f0-9]{64}$' AND
    "configDigest" ~ '^[a-f0-9]{64}$' AND
    length("signedMappingVersion") BETWEEN 1 AND 128 AND
    "hashAlgorithmCode" = 'sha256' AND "canonicalVersion" = 1
  ),
  CONSTRAINT csow_no_overlap EXCLUDE USING gist
    (tstzrange("startsAt", "endsAt", '[)') WITH &&)
);
CREATE INDEX "csow_range_idx" ON "ContributionShadowObservationWindow"("startsAt", "endsAt");

CREATE TABLE "ContributionShadowAttemptReceipt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "windowId" TEXT NOT NULL,
  "auditLogId" TEXT NOT NULL,
  "sheetId" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "sheetVersion" INTEGER NOT NULL,
  "replayKey" TEXT NOT NULL,
  "committedFactHash" TEXT NOT NULL,
  "signedMappingVersion" TEXT NOT NULL,
  "expectedRecordCount" INTEGER NOT NULL,
  "hashAlgorithmCode" TEXT NOT NULL,
  "canonicalVersion" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT csar_window_fk FOREIGN KEY ("windowId")
    REFERENCES "ContributionShadowObservationWindow"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT csar_audit_fk FOREIGN KEY ("auditLogId")
    REFERENCES "audit_logs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT csar_sheet_activity_fk FOREIGN KEY ("sheetId", "activityId")
    REFERENCES "AttendanceSheet"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT csar_count_check CHECK ("sheetVersion" >= 1 AND "expectedRecordCount" > 0),
  CONSTRAINT csar_digest_check CHECK (
    "replayKey" ~ '^[a-f0-9]{64}$' AND
    "committedFactHash" ~ '^[a-f0-9]{64}$' AND
    length("signedMappingVersion") BETWEEN 1 AND 128 AND
    "hashAlgorithmCode" = 'sha256' AND "canonicalVersion" = 1
  )
);
CREATE UNIQUE INDEX "csar_replay_key" ON "ContributionShadowAttemptReceipt"("replayKey");
CREATE UNIQUE INDEX "csar_audit_key" ON "ContributionShadowAttemptReceipt"("auditLogId");
CREATE UNIQUE INDEX "csar_window_audit_key" ON "ContributionShadowAttemptReceipt"("windowId", "auditLogId");
CREATE UNIQUE INDEX "csar_id_sheet_activity_key" ON "ContributionShadowAttemptReceipt"("id", "sheetId", "activityId");
CREATE UNIQUE INDEX "csar_id_window_audit_key" ON "ContributionShadowAttemptReceipt"("id", "windowId", "auditLogId");
CREATE INDEX "csar_sheet_activity_idx" ON "ContributionShadowAttemptReceipt"("sheetId", "activityId");

CREATE TABLE "ContributionShadowComparisonReceipt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "attemptId" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "sheetId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "classificationCode" TEXT NOT NULL,
  "comparable" BOOLEAN NOT NULL,
  "factHash" TEXT NOT NULL,
  "legacySourceHash" TEXT NOT NULL,
  "policySourceHash" TEXT,
  "legacyRuleId" TEXT,
  "selectionRevisionId" TEXT,
  "selectionItemId" TEXT,
  "policyVersionId" TEXT,
  "policyId" TEXT,
  "definitionHash" TEXT,
  "evaluatorVersion" INTEGER,
  "legacyServiceHours" DECIMAL(5,2),
  "durationSeconds" INTEGER,
  "legacyPoints" DECIMAL(5,2),
  "policyPoints" DECIMAL(5,2),
  "failureCode" TEXT,
  "hashAlgorithmCode" TEXT NOT NULL,
  "canonicalVersion" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT cscr_attempt_chain_fk FOREIGN KEY ("attemptId", "sheetId", "activityId")
    REFERENCES "ContributionShadowAttemptReceipt"("id", "sheetId", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT cscr_record_chain_fk FOREIGN KEY ("recordId", "sheetId", "memberId")
    REFERENCES "AttendanceRecord"("id", "sheetId", "memberId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT cscr_selection_chain_fk FOREIGN KEY ("selectionItemId", "selectionRevisionId", "activityId")
    REFERENCES "ActivityContributionPolicySelectionItem"("id", "selectionRevisionId", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT cscr_policy_version_fk FOREIGN KEY ("policyVersionId", "policyId", "definitionHash", "evaluatorVersion")
    REFERENCES "ContributionPolicyVersion"("id", "policyId", "definitionHash", "evaluatorVersion") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT cscr_legacy_rule_fk FOREIGN KEY ("legacyRuleId")
    REFERENCES "ContributionRule"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT cscr_source_group_check CHECK (
    (("selectionItemId" IS NULL AND "selectionRevisionId" IS NULL AND
      "policyVersionId" IS NULL AND "policyId" IS NULL AND
      "definitionHash" IS NULL AND "evaluatorVersion" IS NULL AND
      "policySourceHash" IS NULL) OR
     ("selectionItemId" IS NOT NULL AND "selectionRevisionId" IS NOT NULL AND
      "policyVersionId" IS NOT NULL AND "policyId" IS NOT NULL AND
      "definitionHash" IS NOT NULL AND "evaluatorVersion" IS NOT NULL AND
      "policySourceHash" IS NOT NULL))
  ),
  CONSTRAINT cscr_classification_check CHECK (
    "classificationCode" IN (
      'equal','points_mismatch','legacy_rule_missing','policy_version_missing_or_unapproved',
      'mapping_hold','input_source_mismatch','precision_boundary','source_drift',
      'duplicate_active_pair','evaluation_error'
    ) AND "comparable" = ("classificationCode" IN ('equal','points_mismatch'))
  ),
  CONSTRAINT cscr_value_check CHECK (
    ("durationSeconds" IS NULL OR "durationSeconds" >= 0) AND
    ("legacyServiceHours" IS NULL OR "legacyServiceHours" >= 0) AND
    ("legacyPoints" IS NULL OR "legacyPoints" >= 0) AND
    ("policyPoints" IS NULL OR "policyPoints" >= 0)
  ),
  CONSTRAINT cscr_digest_check CHECK (
    "factHash" ~ '^[a-f0-9]{64}$' AND
    "legacySourceHash" ~ '^[a-f0-9]{64}$' AND
    ("policySourceHash" IS NULL OR "policySourceHash" ~ '^[a-f0-9]{64}$') AND
    ("definitionHash" IS NULL OR "definitionHash" ~ '^[a-f0-9]{64}$') AND
    "hashAlgorithmCode" = 'sha256' AND "canonicalVersion" = 1
  )
);
CREATE UNIQUE INDEX "cscr_attempt_record_key" ON "ContributionShadowComparisonReceipt"("attemptId", "recordId");
CREATE INDEX "cscr_record_chain_idx" ON "ContributionShadowComparisonReceipt"("recordId", "sheetId", "memberId");
CREATE INDEX "cscr_selection_chain_idx" ON "ContributionShadowComparisonReceipt"("selectionItemId", "selectionRevisionId", "activityId");
CREATE INDEX "cscr_policy_version_idx" ON "ContributionShadowComparisonReceipt"("policyVersionId", "policyId", "definitionHash", "evaluatorVersion");

CREATE TABLE "ContributionShadowTerminalReceipt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "attemptId" TEXT NOT NULL,
  "statusCode" TEXT NOT NULL,
  "expectedRecordCount" INTEGER NOT NULL,
  "writtenRecordCount" INTEGER NOT NULL,
  "equalCount" INTEGER NOT NULL,
  "mismatchCount" INTEGER NOT NULL,
  "holdCount" INTEGER NOT NULL,
  "errorCount" INTEGER NOT NULL,
  "failureCode" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT cstr_attempt_fk FOREIGN KEY ("attemptId")
    REFERENCES "ContributionShadowAttemptReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT cstr_status_check CHECK (
    "statusCode" IN ('complete','failed') AND
    (("statusCode" = 'complete' AND "failureCode" IS NULL) OR
     ("statusCode" = 'failed' AND length("failureCode") BETWEEN 1 AND 128))
  ),
  CONSTRAINT cstr_counts_check CHECK (
    "expectedRecordCount" > 0 AND "writtenRecordCount" >= 0 AND
    "equalCount" >= 0 AND "mismatchCount" >= 0 AND
    "holdCount" >= 0 AND "errorCount" >= 0 AND
    "equalCount" + "mismatchCount" + "holdCount" + "errorCount" = "writtenRecordCount" AND
    "writtenRecordCount" <= "expectedRecordCount" AND
    ("statusCode" <> 'complete' OR "writtenRecordCount" = "expectedRecordCount")
  )
);
CREATE UNIQUE INDEX "cstr_attempt_key" ON "ContributionShadowTerminalReceipt"("attemptId");

CREATE TABLE "ContributionShadowDispositionReceipt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "windowId" TEXT NOT NULL,
  "auditLogId" TEXT NOT NULL,
  "attemptId" TEXT,
  "revision" INTEGER NOT NULL,
  "previousDispositionId" TEXT,
  "decisionCode" TEXT NOT NULL,
  "evidenceHash" TEXT NOT NULL,
  "signedByUserId" TEXT NOT NULL,
  "hashAlgorithmCode" TEXT NOT NULL,
  "canonicalVersion" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT csdr_window_fk FOREIGN KEY ("windowId")
    REFERENCES "ContributionShadowObservationWindow"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT csdr_audit_fk FOREIGN KEY ("auditLogId")
    REFERENCES "audit_logs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT csdr_attempt_chain_fk FOREIGN KEY ("attemptId", "windowId", "auditLogId")
    REFERENCES "ContributionShadowAttemptReceipt"("id", "windowId", "auditLogId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT csdr_signer_fk FOREIGN KEY ("signedByUserId")
    REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT csdr_previous_chain_fk FOREIGN KEY ("previousDispositionId", "windowId", "auditLogId")
    REFERENCES "ContributionShadowDispositionReceipt"("id", "windowId", "auditLogId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT csdr_revision_check CHECK ("revision" >= 1 AND
    (("revision" = 1 AND "previousDispositionId" IS NULL) OR
     ("revision" > 1 AND "previousDispositionId" IS NOT NULL))),
  CONSTRAINT csdr_id_candidate_key UNIQUE ("id", "windowId", "auditLogId"),
  CONSTRAINT csdr_decision_check CHECK ("decisionCode" IN ('unresolved','not_applicable','confirmed_gap')),
  CONSTRAINT csdr_digest_check CHECK (
    "evidenceHash" ~ '^[a-f0-9]{64}$' AND
    "hashAlgorithmCode" = 'sha256' AND "canonicalVersion" = 1
  )
);
CREATE UNIQUE INDEX "csdr_candidate_revision_key" ON "ContributionShadowDispositionReceipt"("windowId", "auditLogId", "revision");
CREATE INDEX "csdr_audit_idx" ON "ContributionShadowDispositionReceipt"("auditLogId");
CREATE INDEX "csdr_attempt_chain_idx" ON "ContributionShadowDispositionReceipt"("attemptId", "windowId", "auditLogId");

CREATE FUNCTION cs_immutable_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'contribution shadow evidence is append-only' USING ERRCODE = '23514';
END $$;

CREATE FUNCTION csow_insert_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."startsAt" <= clock_timestamp() THEN
    RAISE EXCEPTION 'observation window must be registered before start' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER csow_insert_guard BEFORE INSERT ON "ContributionShadowObservationWindow"
  FOR EACH ROW EXECUTE FUNCTION csow_insert_guard_fn();

CREATE FUNCTION csar_insert_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_window "ContributionShadowObservationWindow"%ROWTYPE;
  v_audit "audit_logs"%ROWTYPE;
  v_sheet "AttendanceSheet"%ROWTYPE;
  v_records JSONB;
  v_count INTEGER;
  v_distinct INTEGER;
  v_expected_replay TEXT;
  v_operation TEXT;
  v_declared_count TEXT;
BEGIN
  SELECT * INTO v_window FROM "ContributionShadowObservationWindow"
    WHERE "id" = NEW."windowId" FOR SHARE;
  SELECT * INTO v_audit FROM "audit_logs" WHERE "id" = NEW."auditLogId" FOR SHARE;
  SELECT * INTO v_sheet FROM "AttendanceSheet" WHERE "id" = NEW."sheetId" FOR SHARE;
  IF NOT FOUND OR v_window."id" IS NULL OR v_audit."id" IS NULL OR v_sheet."id" IS NULL THEN
    RAISE EXCEPTION 'missing shadow anchor' USING ERRCODE = '23514';
  END IF;
  v_operation := v_audit."context"->'extra'->>'operation';
  IF v_audit."success" IS DISTINCT FROM TRUE OR
     v_audit."resourceType" IS DISTINCT FROM 'attendance_sheet' OR
     v_audit."resourceId" IS DISTINCT FROM NEW."sheetId" OR
     ((v_audit."event" = 'attendance-sheet.submit' AND v_operation = 'submit') OR
      (v_audit."event" = 'attendance-sheet.edit' AND v_operation = 'edit')) IS NOT TRUE OR
     (v_audit."createdAt" AT TIME ZONE 'UTC') < v_window."startsAt" OR
     (v_audit."createdAt" AT TIME ZONE 'UTC') >= v_window."endsAt" OR
     v_sheet."activityId" IS DISTINCT FROM NEW."activityId" OR
     v_window."signedMappingVersion" IS DISTINCT FROM NEW."signedMappingVersion" THEN
    RAISE EXCEPTION 'shadow candidate is not eligible or same-chain' USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(v_audit."context"->'after'->'sheet') IS DISTINCT FROM 'object' OR
     jsonb_typeof(v_audit."context"->'after'->'records') IS DISTINCT FROM 'array' OR
     v_audit."context"->'after'->'sheet'->>'activityId' IS DISTINCT FROM NEW."activityId" OR
     coalesce(v_audit."context"->'after'->'sheet'->>'version', '') !~ '^[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'shadow audit snapshot is incomplete' USING ERRCODE = '23514';
  END IF;
  v_records := v_audit."context"->'after'->'records';
  v_count := jsonb_array_length(v_records);
  SELECT count(DISTINCT value->>'id') INTO v_distinct FROM jsonb_array_elements(v_records) AS e(value);
  IF v_count = 0 OR v_count <> v_distinct OR v_count <> NEW."expectedRecordCount" OR
     (v_audit."context"->'after'->'sheet'->>'version')::INTEGER <> NEW."sheetVersion" OR
     EXISTS (SELECT 1 FROM jsonb_array_elements(v_records) AS e(value)
             WHERE jsonb_typeof(value) IS DISTINCT FROM 'object' OR
                   nullif(value->>'id','') IS NULL OR nullif(value->>'memberId','') IS NULL) THEN
    RAISE EXCEPTION 'shadow audit record set does not match attempt' USING ERRCODE = '23514';
  END IF;
  v_declared_count := CASE WHEN v_operation = 'submit'
    THEN v_audit."context"->'extra'->>'recordsCount'
    ELSE v_audit."context"->'extra'->>'newRecordsCount' END;
  IF coalesce(v_declared_count, '') !~ '^[1-9][0-9]*$' OR
     v_declared_count::INTEGER <> v_count THEN
    RAISE EXCEPTION 'shadow audit declared count mismatch' USING ERRCODE = '23514';
  END IF;
  v_expected_replay := encode(sha256(convert_to(
    'e3-2-d1:v1:' || NEW."windowId" || ':' || NEW."auditLogId" || ':' || NEW."sheetVersion", 'UTF8')), 'hex');
  IF NEW."replayKey" <> v_expected_replay THEN
    RAISE EXCEPTION 'shadow replay key mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER csar_insert_guard BEFORE INSERT ON "ContributionShadowAttemptReceipt"
  FOR EACH ROW EXECUTE FUNCTION csar_insert_guard_fn();

CREATE FUNCTION cscr_insert_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_attempt "ContributionShadowAttemptReceipt"%ROWTYPE;
  v_audit "audit_logs"%ROWTYPE;
  v_item "ActivityContributionPolicySelectionItem"%ROWTYPE;
  v_found BOOLEAN;
  v_count BIGINT;
BEGIN
  SELECT * INTO v_attempt FROM "ContributionShadowAttemptReceipt"
    WHERE "id" = NEW."attemptId" FOR UPDATE;
  IF NOT FOUND OR v_attempt."sheetId" IS DISTINCT FROM NEW."sheetId" OR
     v_attempt."activityId" IS DISTINCT FROM NEW."activityId" THEN
    RAISE EXCEPTION 'shadow comparison attempt chain mismatch' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "ContributionShadowTerminalReceipt" WHERE "attemptId" = NEW."attemptId") THEN
    RAISE EXCEPTION 'shadow comparison after terminal' USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO v_count FROM "ContributionShadowComparisonReceipt"
    WHERE "attemptId" = NEW."attemptId";
  IF v_count >= v_attempt."expectedRecordCount" THEN
    RAISE EXCEPTION 'shadow comparison exceeds expected set' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_audit FROM "audit_logs" WHERE "id" = v_attempt."auditLogId" FOR SHARE;
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_audit."context"->'after'->'records') AS e(value)
    WHERE value->>'id' = NEW."recordId" AND value->>'memberId' = NEW."memberId"
  ) INTO v_found;
  IF NOT v_found THEN
    RAISE EXCEPTION 'shadow record not in exact audit snapshot' USING ERRCODE = '23514';
  END IF;
  IF NEW."selectionItemId" IS NOT NULL THEN
    SELECT * INTO v_item FROM "ActivityContributionPolicySelectionItem"
      WHERE "id" = NEW."selectionItemId" FOR SHARE;
    IF NOT FOUND OR v_item."selectionRevisionId" IS DISTINCT FROM NEW."selectionRevisionId" OR
       v_item."activityId" IS DISTINCT FROM NEW."activityId" OR
       v_item."policyId" IS DISTINCT FROM NEW."policyId" OR
       v_item."versionId" IS DISTINCT FROM NEW."policyVersionId" OR
       v_item."definitionHash" IS DISTINCT FROM NEW."definitionHash" OR
       v_item."evaluatorVersion" IS DISTINCT FROM NEW."evaluatorVersion" THEN
      RAISE EXCEPTION 'shadow policy selection/version mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."comparable" AND
     (NEW."selectionItemId" IS NULL OR NEW."legacyServiceHours" IS NULL OR
      NEW."durationSeconds" IS NULL OR NEW."legacyPoints" IS NULL OR
      NEW."policyPoints" IS NULL OR NEW."policySourceHash" IS NULL OR
      NEW."factHash" IS NULL) THEN
    RAISE EXCEPTION 'shadow comparable proof is incomplete' USING ERRCODE = '23514';
  END IF;
  -- D1 has no immutable legacy-source proof anchor. A mutable ContributionRule ID/hash
  -- cannot establish comparability; D2 must add an independently reviewed exact proof.
  IF NEW."comparable" THEN
    RAISE EXCEPTION 'shadow comparison requires immutable legacy-source proof' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cscr_insert_guard BEFORE INSERT ON "ContributionShadowComparisonReceipt"
  FOR EACH ROW EXECUTE FUNCTION cscr_insert_guard_fn();

CREATE FUNCTION cstr_insert_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_attempt "ContributionShadowAttemptReceipt"%ROWTYPE;
  v_total BIGINT;
  v_equal BIGINT;
  v_mismatch BIGINT;
  v_hold BIGINT;
  v_error BIGINT;
BEGIN
  SELECT * INTO v_attempt FROM "ContributionShadowAttemptReceipt"
    WHERE "id" = NEW."attemptId" FOR UPDATE;
  IF NOT FOUND OR NEW."expectedRecordCount" IS DISTINCT FROM v_attempt."expectedRecordCount" THEN
    RAISE EXCEPTION 'shadow terminal attempt/count mismatch' USING ERRCODE = '23514';
  END IF;
  SELECT count(*),
    count(*) FILTER (WHERE "classificationCode" = 'equal'),
    count(*) FILTER (WHERE "classificationCode" = 'points_mismatch'),
    count(*) FILTER (WHERE "classificationCode" NOT IN ('equal','points_mismatch','evaluation_error')),
    count(*) FILTER (WHERE "classificationCode" = 'evaluation_error')
    INTO v_total,v_equal,v_mismatch,v_hold,v_error
  FROM "ContributionShadowComparisonReceipt" WHERE "attemptId" = NEW."attemptId";
  IF NEW."writtenRecordCount" <> v_total OR NEW."equalCount" <> v_equal OR
     NEW."mismatchCount" <> v_mismatch OR NEW."holdCount" <> v_hold OR
     NEW."errorCount" <> v_error THEN
    RAISE EXCEPTION 'shadow terminal buckets mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cstr_insert_guard BEFORE INSERT ON "ContributionShadowTerminalReceipt"
  FOR EACH ROW EXECUTE FUNCTION cstr_insert_guard_fn();

CREATE FUNCTION csdr_insert_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_audit "audit_logs"%ROWTYPE;
  v_window "ContributionShadowObservationWindow"%ROWTYPE;
  v_previous "ContributionShadowDispositionReceipt"%ROWTYPE;
BEGIN
  SELECT * INTO v_audit FROM "audit_logs" WHERE "id" = NEW."auditLogId" FOR UPDATE;
  SELECT * INTO v_window FROM "ContributionShadowObservationWindow"
    WHERE "id" = NEW."windowId" FOR SHARE;
  IF v_audit."id" IS NULL OR v_window."id" IS NULL OR
     v_audit."success" IS DISTINCT FROM TRUE OR
     v_audit."resourceType" IS DISTINCT FROM 'attendance_sheet' OR
     nullif(v_audit."resourceId", '') IS NULL OR
     ((v_audit."event" = 'attendance-sheet.submit' AND
       v_audit."context"->'extra'->>'operation' = 'submit') OR
      (v_audit."event" = 'attendance-sheet.edit' AND
       v_audit."context"->'extra'->>'operation' = 'edit')) IS NOT TRUE OR
     (v_audit."createdAt" AT TIME ZONE 'UTC') < v_window."startsAt" OR
     (v_audit."createdAt" AT TIME ZONE 'UTC') >= v_window."endsAt" THEN
    RAISE EXCEPTION 'shadow disposition candidate mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW."previousDispositionId" IS NOT NULL THEN
    SELECT * INTO v_previous FROM "ContributionShadowDispositionReceipt"
      WHERE "id" = NEW."previousDispositionId" FOR SHARE;
    IF NOT FOUND OR v_previous."windowId" IS DISTINCT FROM NEW."windowId" OR
       v_previous."auditLogId" IS DISTINCT FROM NEW."auditLogId" OR
       v_previous."revision" + 1 IS DISTINCT FROM NEW."revision" THEN
      RAISE EXCEPTION 'shadow disposition predecessor mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- A free-form digest cannot establish a signed decision. D1 accepts only unresolved.
  IF NEW."decisionCode" IS DISTINCT FROM 'unresolved' THEN
    RAISE EXCEPTION 'shadow disposition requires signed decision proof' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER csdr_insert_guard BEFORE INSERT ON "ContributionShadowDispositionReceipt"
  FOR EACH ROW EXECUTE FUNCTION csdr_insert_guard_fn();

CREATE TRIGGER csow_immutable_guard BEFORE UPDATE OR DELETE ON "ContributionShadowObservationWindow"
  FOR EACH ROW EXECUTE FUNCTION cs_immutable_guard_fn();
CREATE TRIGGER csow_no_truncate BEFORE TRUNCATE ON "ContributionShadowObservationWindow"
  FOR EACH STATEMENT EXECUTE FUNCTION cs_immutable_guard_fn();
CREATE TRIGGER csar_immutable_guard BEFORE UPDATE OR DELETE ON "ContributionShadowAttemptReceipt"
  FOR EACH ROW EXECUTE FUNCTION cs_immutable_guard_fn();
CREATE TRIGGER csar_no_truncate BEFORE TRUNCATE ON "ContributionShadowAttemptReceipt"
  FOR EACH STATEMENT EXECUTE FUNCTION cs_immutable_guard_fn();
CREATE TRIGGER cscr_immutable_guard BEFORE UPDATE OR DELETE ON "ContributionShadowComparisonReceipt"
  FOR EACH ROW EXECUTE FUNCTION cs_immutable_guard_fn();
CREATE TRIGGER cscr_no_truncate BEFORE TRUNCATE ON "ContributionShadowComparisonReceipt"
  FOR EACH STATEMENT EXECUTE FUNCTION cs_immutable_guard_fn();
CREATE TRIGGER cstr_immutable_guard BEFORE UPDATE OR DELETE ON "ContributionShadowTerminalReceipt"
  FOR EACH ROW EXECUTE FUNCTION cs_immutable_guard_fn();
CREATE TRIGGER cstr_no_truncate BEFORE TRUNCATE ON "ContributionShadowTerminalReceipt"
  FOR EACH STATEMENT EXECUTE FUNCTION cs_immutable_guard_fn();
CREATE TRIGGER csdr_immutable_guard BEFORE UPDATE OR DELETE ON "ContributionShadowDispositionReceipt"
  FOR EACH ROW EXECUTE FUNCTION cs_immutable_guard_fn();
CREATE TRIGGER csdr_no_truncate BEFORE TRUNCATE ON "ContributionShadowDispositionReceipt"
  FOR EACH STATEMENT EXECUTE FUNCTION cs_immutable_guard_fn();

COMMIT;
