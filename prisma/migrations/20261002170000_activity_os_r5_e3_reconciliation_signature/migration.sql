-- E3-2 D3: additive evidence only. No historical backfill, role creation or activation.
BEGIN;

CREATE TABLE "ContributionShadowWindowRegistrationReceipt" (
  id TEXT PRIMARY KEY, "windowId" TEXT NOT NULL, "commandKey" TEXT NOT NULL,
  "manifestHash" TEXT NOT NULL, "authorityDigest" TEXT NOT NULL, "actorUserId" TEXT NOT NULL,
  "approvalReference" TEXT NOT NULL, "startsAt" TIMESTAMPTZ(3) NOT NULL,
  "endsAt" TIMESTAMPTZ(3) NOT NULL, "deploymentDigest" TEXT NOT NULL,
  "configDigest" TEXT NOT NULL, "signedMappingVersion" TEXT NOT NULL,
  "schemaVersion" INTEGER NOT NULL, "hashAlgorithmCode" TEXT NOT NULL,
  "canonicalVersion" INTEGER NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT cswr_window_fk FOREIGN KEY ("windowId") REFERENCES "ContributionShadowObservationWindow"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT cswr_actor_fk FOREIGN KEY ("actorUserId") REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT cswr_contract_check CHECK (
    "commandKey" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' AND
    "approvalReference" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' AND
    "signedMappingVersion" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' AND
    "manifestHash" ~ '^[a-f0-9]{64}$' AND "authorityDigest" ~ '^[a-f0-9]{64}$' AND
    "deploymentDigest" ~ '^[a-f0-9]{64}$' AND "configDigest" ~ '^[a-f0-9]{64}$' AND
    "endsAt" > "startsAt" AND "schemaVersion" = 1 AND "hashAlgorithmCode" = 'sha256' AND "canonicalVersion" = 1)
);
CREATE UNIQUE INDEX cswr_window_key ON "ContributionShadowWindowRegistrationReceipt"("windowId");
CREATE UNIQUE INDEX cswr_command_key ON "ContributionShadowWindowRegistrationReceipt"("commandKey");
CREATE INDEX cswr_created_idx ON "ContributionShadowWindowRegistrationReceipt"("createdAt",id);

CREATE TABLE "ContributionShadowDispositionApprovalReceipt" (
  id TEXT PRIMARY KEY, "commandKey" TEXT NOT NULL, "manifestHash" TEXT NOT NULL,
  "authorityDigest" TEXT NOT NULL, "windowId" TEXT NOT NULL, "auditLogId" TEXT NOT NULL,
  "attemptId" TEXT, revision INTEGER NOT NULL, "previousDispositionId" TEXT,
  "decisionCode" TEXT NOT NULL, "operationCode" TEXT NOT NULL, "basisCode" TEXT NOT NULL,
  "approvalReference" TEXT NOT NULL, "signedByUserId" TEXT NOT NULL,
  "candidateEvidence" JSONB NOT NULL, "candidateEvidenceHash" TEXT NOT NULL,
  "hashAlgorithmCode" TEXT NOT NULL, "canonicalVersion" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT csda_window_fk FOREIGN KEY ("windowId") REFERENCES "ContributionShadowObservationWindow"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT csda_audit_fk FOREIGN KEY ("auditLogId") REFERENCES audit_logs(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT csda_attempt_chain_fk FOREIGN KEY ("attemptId","windowId","auditLogId") REFERENCES "ContributionShadowAttemptReceipt"(id,"windowId","auditLogId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT csda_signer_fk FOREIGN KEY ("signedByUserId") REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT csda_previous_chain_fk FOREIGN KEY ("previousDispositionId","windowId","auditLogId") REFERENCES "ContributionShadowDispositionReceipt"(id,"windowId","auditLogId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT csda_contract_check CHECK (
    "commandKey" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' AND
    "approvalReference" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' AND
    "manifestHash" ~ '^[a-f0-9]{64}$' AND "authorityDigest" ~ '^[a-f0-9]{64}$' AND
    "candidateEvidenceHash" ~ '^[a-f0-9]{64}$' AND jsonb_typeof("candidateEvidence") = 'object' AND
    "operationCode" IN ('submit','edit','edit-no-records','resubmit') AND
    revision >= 1 AND ((revision = 1 AND "previousDispositionId" IS NULL) OR
      (revision > 1 AND "previousDispositionId" IS NOT NULL)) AND
    (("decisionCode" = 'unresolved' AND "basisCode" = 'withdraw_previous' AND "previousDispositionId" IS NOT NULL) OR
      ("decisionCode" = 'not_applicable' AND "basisCode" = 'outside_comparison_contract') OR
      ("decisionCode" = 'confirmed_gap' AND "basisCode" = 'observed_gap')) AND
    "hashAlgorithmCode" = 'sha256' AND "canonicalVersion" = 1)
);
CREATE UNIQUE INDEX csda_command_key ON "ContributionShadowDispositionApprovalReceipt"("commandKey");
CREATE UNIQUE INDEX csda_candidate_revision_key ON "ContributionShadowDispositionApprovalReceipt"("windowId","auditLogId",revision);
CREATE UNIQUE INDEX csda_disposition_anchor_key ON "ContributionShadowDispositionApprovalReceipt"(id,"windowId","auditLogId",revision,"decisionCode","signedByUserId","candidateEvidenceHash");
CREATE INDEX csda_attempt_chain_idx ON "ContributionShadowDispositionApprovalReceipt"("attemptId","windowId","auditLogId");
CREATE INDEX csda_audit_idx ON "ContributionShadowDispositionApprovalReceipt"("auditLogId");
ALTER TABLE "ContributionShadowDispositionReceipt" ADD COLUMN "approvalReceiptId" TEXT;
CREATE UNIQUE INDEX csdr_approval_key ON "ContributionShadowDispositionReceipt"("approvalReceiptId");
CREATE UNIQUE INDEX csdr_approval_anchor_key ON "ContributionShadowDispositionReceipt"("approvalReceiptId","windowId","auditLogId",revision,"decisionCode","signedByUserId","evidenceHash");
ALTER TABLE "ContributionShadowDispositionReceipt" ADD CONSTRAINT csdr_approval_chain_fk
  FOREIGN KEY ("approvalReceiptId","windowId","auditLogId",revision,"decisionCode","signedByUserId","evidenceHash")
  REFERENCES "ContributionShadowDispositionApprovalReceipt"(id,"windowId","auditLogId",revision,"decisionCode","signedByUserId","candidateEvidenceHash") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION csd3_hash_fn(domain TEXT, value JSONB) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT encode(sha256(convert_to(csm_manifest_canonical_fn(jsonb_build_object(
    'schemaVersion',1,'definition',jsonb_build_object('domain',domain,'manifest',value))),'UTF8')),'hex')
$$;

CREATE FUNCTION csd3_manifest_hash_fn(manifest JSONB) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE field TEXT; operation TEXT := manifest->>'operation'; revision_value NUMERIC;
BEGIN
  IF manifest->'schemaVersion' IS DISTINCT FROM '1'::JSONB OR NOT coalesce(csm_exact_keys_fn(manifest,
    CASE operation WHEN 'register_window' THEN ARRAY['schemaVersion','operation','commandKey','approvalReference',
      'windowId','startsAt','endsAt','deploymentDigest','configDigest','signedMappingVersion']
    WHEN 'sign_disposition' THEN ARRAY['schemaVersion','operation','commandKey','approvalReference','windowId',
      'auditLogId','expectedPreviousDispositionId','expectedRevision','decisionCode','basisCode','expectedCandidateEvidenceHash']
    ELSE ARRAY[]::TEXT[] END),FALSE) THEN
    RAISE EXCEPTION 'invalid reconciliation manifest shape' USING ERRCODE = '23514';
  END IF;
  FOREACH field IN ARRAY ARRAY['commandKey','approvalReference','windowId'] LOOP
    IF jsonb_typeof(manifest->field) IS DISTINCT FROM 'string' OR
      (manifest->>field) !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' THEN
      RAISE EXCEPTION 'invalid reconciliation identifier' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF operation = 'register_window' THEN
    IF NOT coalesce(csm_manifest_instant_fn(manifest->'startsAt'),FALSE) OR
      NOT coalesce(csm_manifest_instant_fn(manifest->'endsAt'),FALSE) OR
      (manifest->>'endsAt')::TIMESTAMPTZ <= (manifest->>'startsAt')::TIMESTAMPTZ OR
      jsonb_typeof(manifest->'signedMappingVersion') IS DISTINCT FROM 'string' OR
      manifest->>'signedMappingVersion' !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' THEN
      RAISE EXCEPTION 'invalid reconciliation window' USING ERRCODE = '23514';
    END IF;
    FOREACH field IN ARRAY ARRAY['deploymentDigest','configDigest'] LOOP
      IF jsonb_typeof(manifest->field) IS DISTINCT FROM 'string' OR manifest->>field !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION 'invalid reconciliation digest' USING ERRCODE = '23514';
      END IF;
    END LOOP;
  ELSE
    IF jsonb_typeof(manifest->'auditLogId') IS DISTINCT FROM 'string' OR
      manifest->>'auditLogId' !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' OR
      jsonb_typeof(manifest->'expectedCandidateEvidenceHash') IS DISTINCT FROM 'string' OR
      manifest->>'expectedCandidateEvidenceHash' !~ '^[a-f0-9]{64}$' OR
      jsonb_typeof(manifest->'expectedRevision') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'invalid reconciliation candidate' USING ERRCODE = '23514';
    END IF;
    revision_value := (manifest->>'expectedRevision')::NUMERIC;
    IF revision_value < 1 OR revision_value > 2147483647 OR trunc(revision_value) <> revision_value OR
      ((revision_value = 1) <> (manifest->'expectedPreviousDispositionId' = 'null'::JSONB)) OR
      (manifest->'expectedPreviousDispositionId' <> 'null'::JSONB AND
        (jsonb_typeof(manifest->'expectedPreviousDispositionId') IS DISTINCT FROM 'string' OR
        manifest->>'expectedPreviousDispositionId' !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$')) OR
      NOT coalesce((manifest->>'decisionCode' = 'unresolved' AND manifest->>'basisCode' = 'withdraw_previous' AND revision_value > 1) OR
        (manifest->>'decisionCode' = 'not_applicable' AND manifest->>'basisCode' = 'outside_comparison_contract') OR
        (manifest->>'decisionCode' = 'confirmed_gap' AND manifest->>'basisCode' = 'observed_gap'),FALSE) THEN
      RAISE EXCEPTION 'invalid reconciliation revision or basis' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN csd3_hash_fn('SRVF:E3-2:shadow-reconciliation:v1',manifest);
END $$;

-- Read-only evidence projection. Raw audit context, member identity and policy bodies
-- are never materialized. Decimal values are canonical strings, not JSON floats.
CREATE FUNCTION csd3_candidate_evidence_fn(window_id TEXT, audit_id TEXT) RETURNS JSONB
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp SET jit = off AS $$
  SELECT jsonb_build_object('schemaVersion',1,'hashAlgorithmCode','sha256','canonicalVersion',1,
    'audit',jsonb_build_object('id',a.id,'event',a.event,'operation',a.context->'extra'->>'operation',
      'success',a.success,'resourceType',a."resourceType",'resourceId',a."resourceId",
      'createdAt',to_char(a."createdAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    'window',jsonb_build_object('id',w.id,'registrationReceiptId',r.id,'manifestHash',r."manifestHash",
      'authorityDigest',r."authorityDigest",'deploymentDigest',w."deploymentDigest",'configDigest',w."configDigest",
      'signedMappingVersion',w."signedMappingVersion",'hashAlgorithmCode',w."hashAlgorithmCode",
      'canonicalVersion',w."canonicalVersion",'startsAt',to_char(w."startsAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'endsAt',to_char(w."endsAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    'attempt',CASE WHEN t.id IS NULL THEN NULL ELSE jsonb_build_object('id',t.id,'sheetId',t."sheetId",
      'activityId',t."activityId",'sheetVersion',t."sheetVersion",'signedMappingVersion',t."signedMappingVersion",
      'committedFactHash',t."committedFactHash",'expectedRecordCount',t."expectedRecordCount",
      'hashAlgorithmCode',t."hashAlgorithmCode",'canonicalVersion',t."canonicalVersion") END,
    'terminal',CASE WHEN z.id IS NULL THEN NULL ELSE jsonb_build_object('id',z.id,'statusCode',z."statusCode",
      'expectedRecordCount',z."expectedRecordCount",'writtenRecordCount',z."writtenRecordCount",'equalCount',z."equalCount",
      'mismatchCount',z."mismatchCount",'holdCount',z."holdCount",'errorCount',z."errorCount",'failureCode',z."failureCode") END,
    'comparisons',jsonb_build_object('count',c.count,'equal',c.equal_count,'mismatch',c.mismatch_count,
      'hold',c.hold_count,'error',c.error_count,'digest',c.digest),
    'missingStart',t.id IS NULL,'missingTerminal',t.id IS NOT NULL AND z.id IS NULL,
    'sourceAnomaly',NOT coalesce(
      ((a.event='attendance-sheet.submit' AND a.context#>>'{extra,operation}'='submit') OR
        (a.event='attendance-sheet.edit' AND a.context#>>'{extra,operation}'='edit')) AND
        jsonb_typeof(a.context#>'{after,sheet}')='object' AND jsonb_typeof(a.context#>'{after,records}')='array' AND
        nullif(a.context#>>'{after,sheet,activityId}','') IS NOT NULL AND a.context#>>'{after,sheet,version}' ~ '^[1-9][0-9]*$' OR
      (a.event='attendance-sheet.edit' AND a.context#>>'{extra,operation}' IN ('edit-no-records','resubmit')),FALSE) OR
      nullif(a."resourceId",'') IS NULL,
    'chainConflict',(t.id IS NOT NULL AND (t."sheetId" IS DISTINCT FROM a."resourceId" OR t."signedMappingVersion" IS DISTINCT FROM w."signedMappingVersion")) OR
      (z.id IS NOT NULL AND (z."expectedRecordCount" IS DISTINCT FROM t."expectedRecordCount" OR
        z."writtenRecordCount" IS DISTINCT FROM c.count OR z."equalCount" IS DISTINCT FROM c.equal_count OR
        z."mismatchCount" IS DISTINCT FROM c.mismatch_count OR z."holdCount" IS DISTINCT FROM c.hold_count OR
        z."errorCount" IS DISTINCT FROM c.error_count)))
  FROM "ContributionShadowObservationWindow" w
  JOIN audit_logs a ON a.id = audit_id AND a.success = TRUE AND a."resourceType" = 'attendance_sheet'
    AND a.event IN ('attendance-sheet.submit','attendance-sheet.edit')
    AND (a."createdAt" AT TIME ZONE 'UTC') >= w."startsAt" AND (a."createdAt" AT TIME ZONE 'UTC') < w."endsAt"
  LEFT JOIN "ContributionShadowWindowRegistrationReceipt" r ON r."windowId" = w.id
  LEFT JOIN "ContributionShadowAttemptReceipt" t ON t."windowId" = w.id AND t."auditLogId" = a.id
  LEFT JOIN "ContributionShadowTerminalReceipt" z ON z."attemptId" = t.id
  CROSS JOIN LATERAL (
    SELECT count(*)::INTEGER AS count,
      count(*) FILTER (WHERE x."classificationCode" = 'equal')::INTEGER AS equal_count,
      count(*) FILTER (WHERE x."classificationCode" = 'points_mismatch')::INTEGER AS mismatch_count,
      count(*) FILTER (WHERE x."classificationCode" NOT IN ('equal','points_mismatch','evaluation_error'))::INTEGER AS hold_count,
      count(*) FILTER (WHERE x."classificationCode" = 'evaluation_error')::INTEGER AS error_count,
      encode(sha256(convert_to(coalesce(string_agg(csd3_hash_fn('SRVF:E3-2:shadow-comparison:v1',
        jsonb_build_object('id',x.id,'recordId',x."recordId",'sheetId',x."sheetId",'activityId',x."activityId",
          'classificationCode',x."classificationCode",'comparable',x.comparable,'factHash',x."factHash",
          'legacySourceHash',x."legacySourceHash",'policySourceHash',x."policySourceHash",'legacyRuleId',x."legacyRuleId",
          'selectionRevisionId',x."selectionRevisionId",'selectionItemId',x."selectionItemId",
          'policyVersionId',x."policyVersionId",'policyId',x."policyId",'definitionHash',x."definitionHash",
          'evaluatorVersion',x."evaluatorVersion",'legacyServiceHours',x."legacyServiceHours"::TEXT,
          'durationSeconds',x."durationSeconds",'legacyPoints',x."legacyPoints"::TEXT,'policyPoints',x."policyPoints"::TEXT,
          'failureCode',x."failureCode",'hashAlgorithmCode',x."hashAlgorithmCode",'canonicalVersion',x."canonicalVersion",
          'mappingApplicationId',m.id,'mappingApprovalId',m."approvalId",'legacySourceAnchorId',m."legacySourceAnchorId")),
          '' ORDER BY x.id COLLATE "C"),''),'UTF8')),'hex') AS digest
    FROM "ContributionShadowComparisonReceipt" x
    LEFT JOIN "ContributionShadowMappingApplication" m ON m."auditLogId" = a.id AND m."recordId" = x."recordId"
      AND m."windowId" = w.id AND m."sheetId" = x."sheetId" AND m."activityId" = x."activityId"
    WHERE x."attemptId" = t.id
  ) c WHERE w.id = window_id
$$;

CREATE FUNCTION csd3_assert_human_fn(actor_id TEXT, permission_code TEXT) RETURNS "Role"
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor_role "Role"; checked_at TIMESTAMP(3);
BEGIN
  IF permission_code NOT IN ('contribution-shadow.read.evidence','contribution-shadow.register.window','contribution-shadow.sign.disposition') OR permission_code IS NULL THEN
    RAISE EXCEPTION 'invalid reconciliation permission' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM "User" WHERE id = actor_id FOR SHARE;
  PERFORM 1 FROM role_bindings b JOIN roles r ON r.id = b."roleId"
    JOIN role_permissions rp ON rp."roleId" = r.id JOIN permissions p ON p.id = rp."permissionId"
    WHERE b."principalType" = 'USER' AND b."principalId" = actor_id AND b."scopeType" = 'GLOBAL' AND p.code = permission_code
    ORDER BY b.id,r.id,rp.id,p.id FOR SHARE OF b,r,rp,p;
  checked_at := clock_timestamp() AT TIME ZONE 'UTC';
  SELECT role INTO actor_role FROM "User" WHERE id = actor_id AND status = 'ACTIVE' AND "deletedAt" IS NULL;
  IF actor_role IS NULL OR NOT EXISTS (
    SELECT 1 FROM role_bindings b JOIN roles r ON r.id = b."roleId"
      JOIN role_permissions rp ON rp."roleId" = r.id JOIN permissions p ON p.id = rp."permissionId"
    WHERE b."principalType" = 'USER' AND b."principalId" = actor_id AND b."scopeType" = 'GLOBAL' AND
      b.status = 'ACTIVE' AND b."deletedAt" IS NULL AND r."deletedAt" IS NULL AND
      b."startedAt" <= checked_at AND (b."endedAt" IS NULL OR b."endedAt" >= checked_at) AND
      p.code = permission_code AND NOT p."servicePrincipalAllowed" AND NOT p."delegatedAccessAllowed") THEN
    RAISE EXCEPTION 'reconciliation current Human grant unavailable' USING ERRCODE = '42501';
  END IF;
  RETURN actor_role;
END $$;

-- NULL until a maintainer binds exactly one reviewed command. Runtime settings
-- are never consumed as authority. The definer/login boundary is validated below.
CREATE FUNCTION csd3_authority_fn() RETURNS JSONB LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp AS $$ SELECT NULL::JSONB $$;
CREATE FUNCTION csd3_assert_authority_fn(manifest JSONB, actor_id TEXT) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE authority JSONB := csd3_authority_fn(); role_name TEXT;
BEGIN
  IF NOT coalesce(csm_exact_keys_fn(authority,ARRAY['databaseName','manifestHash','operation','actorUserId',
    'approvalReference','ownerRole','registrarRole','readerRole','loginRole','expiresAt','manifest']),FALSE) OR
    authority->>'databaseName' IS DISTINCT FROM current_database() OR
    authority->>'manifestHash' IS DISTINCT FROM csd3_manifest_hash_fn(manifest) OR
    authority->'manifest' IS DISTINCT FROM manifest OR authority->>'operation' IS DISTINCT FROM manifest->>'operation' OR
    authority->>'actorUserId' IS DISTINCT FROM actor_id OR
    authority->>'approvalReference' IS DISTINCT FROM manifest->>'approvalReference' OR
    authority->>'ownerRole' IS DISTINCT FROM current_user OR authority->>'loginRole' IS DISTINCT FROM session_user OR
    NOT coalesce(csm_manifest_instant_fn(authority->'expiresAt'),FALSE) OR
    (authority->>'expiresAt')::TIMESTAMPTZ <= clock_timestamp() OR
    (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(jsonb_build_array(authority->>'ownerRole',
      authority->>'registrarRole',authority->>'readerRole',authority->>'loginRole'))) <> 4 THEN
    RAISE EXCEPTION 'reconciliation exact authority unavailable' USING ERRCODE = '42501';
  END IF;
  FOREACH role_name IN ARRAY ARRAY[authority->>'ownerRole',authority->>'registrarRole',authority->>'readerRole',authority->>'loginRole'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name AND NOT rolsuper AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND
      rolcanlogin = (role_name = authority->>'loginRole')) THEN
      RAISE EXCEPTION 'reconciliation role attributes invalid' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  IF NOT pg_has_role(session_user,authority->>'registrarRole','MEMBER') OR
    pg_has_role(session_user,authority->>'ownerRole','MEMBER') OR pg_has_role(session_user,authority->>'readerRole','MEMBER') OR
    pg_has_role(authority->>'registrarRole',authority->>'ownerRole','MEMBER') OR
    pg_has_role(authority->>'readerRole',authority->>'ownerRole','MEMBER') OR
    pg_has_role(authority->>'readerRole',authority->>'registrarRole','MEMBER') OR
    pg_has_role(authority->>'registrarRole',authority->>'readerRole','MEMBER') THEN
    RAISE EXCEPTION 'reconciliation role isolation invalid' USING ERRCODE = '42501';
  END IF;
  RETURN authority;
END $$;

CREATE FUNCTION csd3_assert_decision_fn(evidence JSONB, decision_code TEXT) RETURNS VOID
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE anomaly BOOLEAN; operation TEXT := evidence->'audit'->>'operation';
BEGIN
  IF evidence IS NULL OR evidence->'window'->>'registrationReceiptId' IS NULL OR
    operation IS NULL OR operation NOT IN ('submit','edit','edit-no-records','resubmit') THEN
    RAISE EXCEPTION 'reconciliation official candidate unavailable' USING ERRCODE = '23514';
  END IF;
  anomaly := (evidence->>'sourceAnomaly')::BOOLEAN OR (evidence->>'chainConflict')::BOOLEAN OR
    (evidence->>'missingStart')::BOOLEAN OR (evidence->>'missingTerminal')::BOOLEAN OR
    evidence->'terminal'->>'statusCode' = 'failed' OR
    (evidence->'comparisons'->>'mismatch')::INTEGER > 0 OR
    (evidence->'comparisons'->>'hold')::INTEGER > 0 OR (evidence->'comparisons'->>'error')::INTEGER > 0;
  IF decision_code = 'not_applicable' AND (operation NOT IN ('edit-no-records','resubmit') OR
    evidence->>'sourceAnomaly' IS DISTINCT FROM 'false' OR evidence->>'chainConflict' IS DISTINCT FROM 'false' OR
    evidence->'terminal'->>'statusCode' = 'failed' OR
    (evidence->'comparisons'->>'mismatch')::INTEGER > 0 OR
    (evidence->'comparisons'->>'hold')::INTEGER > 0 OR (evidence->'comparisons'->>'error')::INTEGER > 0) THEN
    RAISE EXCEPTION 'reconciliation not-applicable forbidden' USING ERRCODE = '23514';
  END IF;
  IF decision_code = 'confirmed_gap' AND anomaly IS NOT TRUE THEN
    RAISE EXCEPTION 'reconciliation gap has no anomaly' USING ERRCODE = '23514';
  END IF;
END $$;

CREATE FUNCTION csd3_window_insert_guard_fn() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w "ContributionShadowObservationWindow"; authority JSONB; manifest JSONB;
BEGIN
  authority := csd3_authority_fn(); manifest := authority->'manifest';
  PERFORM csd3_assert_authority_fn(manifest,NEW."actorUserId");
  PERFORM csd3_assert_human_fn(NEW."actorUserId",'contribution-shadow.register.window');
  SELECT * INTO w FROM "ContributionShadowObservationWindow" WHERE id = NEW."windowId" FOR SHARE;
  IF manifest->>'operation' IS DISTINCT FROM 'register_window' OR w.id IS NULL OR
    w."registeredByUserId" IS DISTINCT FROM NEW."actorUserId" OR w."startsAt" IS DISTINCT FROM NEW."startsAt" OR
    w."endsAt" IS DISTINCT FROM NEW."endsAt" OR w."deploymentDigest" IS DISTINCT FROM NEW."deploymentDigest" OR
    w."configDigest" IS DISTINCT FROM NEW."configDigest" OR w."signedMappingVersion" IS DISTINCT FROM NEW."signedMappingVersion" OR
    NEW."manifestHash" IS DISTINCT FROM csd3_manifest_hash_fn(manifest) OR
    NEW."authorityDigest" IS DISTINCT FROM csd3_hash_fn('SRVF:E3-2:reconciliation-authority:v1',authority) OR
    NEW."commandKey" IS DISTINCT FROM manifest->>'commandKey' OR NEW."approvalReference" IS DISTINCT FROM manifest->>'approvalReference' OR
    NEW."windowId" IS DISTINCT FROM manifest->>'windowId' OR
    NEW."startsAt" IS DISTINCT FROM (manifest->>'startsAt')::TIMESTAMPTZ OR NEW."endsAt" IS DISTINCT FROM (manifest->>'endsAt')::TIMESTAMPTZ OR
    NEW."deploymentDigest" IS DISTINCT FROM manifest->>'deploymentDigest' OR NEW."configDigest" IS DISTINCT FROM manifest->>'configDigest' OR
    NEW."signedMappingVersion" IS DISTINCT FROM manifest->>'signedMappingVersion' THEN
    RAISE EXCEPTION 'reconciliation window receipt mismatch' USING ERRCODE = '23514';
  END IF;
  NEW."createdAt" := clock_timestamp();
  IF NEW."startsAt" <= NEW."createdAt" THEN
    RAISE EXCEPTION 'reconciliation window is not prospective' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION csd3_approval_insert_guard_fn() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp SET jit = off AS $$
DECLARE authority JSONB; manifest JSONB; evidence JSONB; last_disposition "ContributionShadowDispositionReceipt"; locked_attempt_id TEXT;
BEGIN
  authority := csd3_authority_fn(); manifest := authority->'manifest';
  PERFORM csd3_assert_authority_fn(manifest,NEW."signedByUserId");
  PERFORM csd3_assert_human_fn(NEW."signedByUserId",'contribution-shadow.sign.disposition');
  PERFORM pg_advisory_xact_lock(hashtextextended('SRVF:E3-2:disposition:' || NEW."windowId" || ':' || NEW."auditLogId",0));
  -- Existing comparison writers acquire attempt before audit. Preserve that
  -- order; never wait on an attempt while already owning the audit UPDATE lock.
  SELECT id INTO locked_attempt_id FROM "ContributionShadowAttemptReceipt"
    WHERE "windowId"=NEW."windowId" AND "auditLogId"=NEW."auditLogId" FOR SHARE;
  PERFORM 1 FROM audit_logs WHERE id = NEW."auditLogId" FOR UPDATE;
  IF (SELECT id FROM "ContributionShadowAttemptReceipt" WHERE "windowId"=NEW."windowId" AND "auditLogId"=NEW."auditLogId")
    IS DISTINCT FROM locked_attempt_id THEN
    RAISE EXCEPTION 'reconciliation attempt changed during locking' USING ERRCODE='23514';
  END IF;
  PERFORM 1 FROM "ContributionShadowObservationWindow" WHERE id = NEW."windowId" AND "endsAt" <= clock_timestamp() FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'reconciliation window not closed' USING ERRCODE = '23514'; END IF;
  SELECT * INTO last_disposition FROM "ContributionShadowDispositionReceipt"
    WHERE "windowId" = NEW."windowId" AND "auditLogId" = NEW."auditLogId" ORDER BY revision DESC LIMIT 1;
  evidence := csd3_candidate_evidence_fn(NEW."windowId",NEW."auditLogId");
  PERFORM csd3_assert_decision_fn(evidence,NEW."decisionCode");
  IF manifest->>'operation' IS DISTINCT FROM 'sign_disposition' OR
    NEW."manifestHash" IS DISTINCT FROM csd3_manifest_hash_fn(manifest) OR
    NEW."authorityDigest" IS DISTINCT FROM csd3_hash_fn('SRVF:E3-2:reconciliation-authority:v1',authority) OR
    NEW."commandKey" IS DISTINCT FROM manifest->>'commandKey' OR NEW."approvalReference" IS DISTINCT FROM manifest->>'approvalReference' OR
    NEW."windowId" IS DISTINCT FROM manifest->>'windowId' OR NEW."auditLogId" IS DISTINCT FROM manifest->>'auditLogId' OR
    NEW.revision IS DISTINCT FROM (manifest->>'expectedRevision')::INTEGER OR
    NEW."previousDispositionId" IS DISTINCT FROM manifest->>'expectedPreviousDispositionId' OR
    NEW."previousDispositionId" IS DISTINCT FROM last_disposition.id OR NEW.revision <> coalesce(last_disposition.revision,0)+1 OR
    NEW."decisionCode" IS DISTINCT FROM manifest->>'decisionCode' OR NEW."basisCode" IS DISTINCT FROM manifest->>'basisCode' OR
    NEW."operationCode" IS DISTINCT FROM evidence->'audit'->>'operation' OR
    NEW."attemptId" IS DISTINCT FROM evidence->'attempt'->>'id' OR NEW."candidateEvidence" IS DISTINCT FROM evidence OR
    NEW."candidateEvidenceHash" IS DISTINCT FROM csd3_hash_fn('SRVF:E3-2:shadow-candidate-evidence:v1',evidence) OR
    NEW."candidateEvidenceHash" IS DISTINCT FROM manifest->>'expectedCandidateEvidenceHash' THEN
    RAISE EXCEPTION 'reconciliation approval snapshot mismatch' USING ERRCODE = '23514';
  END IF;
  NEW."createdAt" := clock_timestamp();
  RETURN NEW;
END $$;

-- Only the signed branch extends the historical operation rule. The unsigned
-- branch retains the original two-operation, unresolved-only contract.
CREATE OR REPLACE FUNCTION csdr_insert_guard_fn() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a audit_logs; w "ContributionShadowObservationWindow";
  previous "ContributionShadowDispositionReceipt"; approval "ContributionShadowDispositionApprovalReceipt";
BEGIN
  SELECT * INTO a FROM audit_logs WHERE id = NEW."auditLogId" FOR UPDATE;
  SELECT * INTO w FROM "ContributionShadowObservationWindow" WHERE id = NEW."windowId" FOR SHARE;
  IF a.id IS NULL OR w.id IS NULL OR a.success IS DISTINCT FROM TRUE OR
    a."resourceType" IS DISTINCT FROM 'attendance_sheet' OR nullif(a."resourceId",'') IS NULL OR
    (a."createdAt" AT TIME ZONE 'UTC') < w."startsAt" OR (a."createdAt" AT TIME ZONE 'UTC') >= w."endsAt" THEN
    RAISE EXCEPTION 'shadow disposition candidate mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW."previousDispositionId" IS NOT NULL THEN
    SELECT * INTO previous FROM "ContributionShadowDispositionReceipt" WHERE id = NEW."previousDispositionId" FOR SHARE;
    IF previous.id IS NULL OR previous."windowId" IS DISTINCT FROM NEW."windowId" OR
      previous."auditLogId" IS DISTINCT FROM NEW."auditLogId" OR previous.revision + 1 IS DISTINCT FROM NEW.revision THEN
      RAISE EXCEPTION 'shadow disposition predecessor mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."approvalReceiptId" IS NULL THEN
    IF ((a.event = 'attendance-sheet.submit' AND a.context->'extra'->>'operation' = 'submit') OR
      (a.event = 'attendance-sheet.edit' AND a.context->'extra'->>'operation' = 'edit')) IS NOT TRUE OR
      NEW."decisionCode" IS DISTINCT FROM 'unresolved' THEN
      RAISE EXCEPTION 'shadow disposition requires signed decision proof' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO approval FROM "ContributionShadowDispositionApprovalReceipt" WHERE id = NEW."approvalReceiptId";
    IF approval.id IS NULL OR approval."windowId" IS DISTINCT FROM NEW."windowId" OR approval."auditLogId" IS DISTINCT FROM NEW."auditLogId" OR
      approval."attemptId" IS DISTINCT FROM NEW."attemptId" OR approval.revision IS DISTINCT FROM NEW.revision OR
      approval."previousDispositionId" IS DISTINCT FROM NEW."previousDispositionId" OR approval."decisionCode" IS DISTINCT FROM NEW."decisionCode" OR
      approval."signedByUserId" IS DISTINCT FROM NEW."signedByUserId" OR approval."candidateEvidenceHash" IS DISTINCT FROM NEW."evidenceHash" OR
      approval."hashAlgorithmCode" IS DISTINCT FROM NEW."hashAlgorithmCode" OR approval."canonicalVersion" IS DISTINCT FROM NEW."canonicalVersion" THEN
      RAISE EXCEPTION 'shadow disposition approval chain mismatch' USING ERRCODE = '23514';
    END IF;
    NEW."createdAt" := approval."createdAt";
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION csd3_approval_closure_fn() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "ContributionShadowDispositionReceipt" d WHERE d."approvalReceiptId" = NEW.id
    AND d."previousDispositionId" IS NOT DISTINCT FROM NEW."previousDispositionId"
    AND d."attemptId" IS NOT DISTINCT FROM NEW."attemptId") THEN
    RAISE EXCEPTION 'reconciliation approval lacks disposition' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER cswr_insert_guard BEFORE INSERT ON "ContributionShadowWindowRegistrationReceipt" FOR EACH ROW EXECUTE FUNCTION csd3_window_insert_guard_fn();
CREATE TRIGGER csda_insert_guard BEFORE INSERT ON "ContributionShadowDispositionApprovalReceipt" FOR EACH ROW EXECUTE FUNCTION csd3_approval_insert_guard_fn();
CREATE CONSTRAINT TRIGGER csda_disposition_closure AFTER INSERT ON "ContributionShadowDispositionApprovalReceipt"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION csd3_approval_closure_fn();
CREATE TRIGGER cswr_immutable_guard BEFORE UPDATE OR DELETE ON "ContributionShadowWindowRegistrationReceipt" FOR EACH ROW EXECUTE FUNCTION cs_immutable_guard_fn();
CREATE TRIGGER cswr_no_truncate BEFORE TRUNCATE ON "ContributionShadowWindowRegistrationReceipt" FOR EACH STATEMENT EXECUTE FUNCTION cs_immutable_guard_fn();
CREATE TRIGGER csda_immutable_guard BEFORE UPDATE OR DELETE ON "ContributionShadowDispositionApprovalReceipt" FOR EACH ROW EXECUTE FUNCTION cs_immutable_guard_fn();
CREATE TRIGGER csda_no_truncate BEFORE TRUNCATE ON "ContributionShadowDispositionApprovalReceipt" FOR EACH STATEMENT EXECUTE FUNCTION cs_immutable_guard_fn();

CREATE FUNCTION csd3_register_fn(manifest JSONB, actor_id TEXT, receipt_id TEXT, disposition_id TEXT, audit_id TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp SET jit = off AS $$
DECLARE authority JSONB; actor_role "Role"; permission_code TEXT; digest TEXT; authority_digest TEXT;
  existing_window "ContributionShadowWindowRegistrationReceipt";
  existing_approval "ContributionShadowDispositionApprovalReceipt";
  evidence JSONB; registered_at TIMESTAMPTZ(3); result JSONB; locked_attempt_id TEXT;
BEGIN
  authority := csd3_assert_authority_fn(manifest,actor_id);
  digest := csd3_manifest_hash_fn(manifest);
  authority_digest := csd3_hash_fn('SRVF:E3-2:reconciliation-authority:v1',authority);
  permission_code := CASE manifest->>'operation' WHEN 'register_window' THEN 'contribution-shadow.register.window'
    ELSE 'contribution-shadow.sign.disposition' END;
  actor_role := csd3_assert_human_fn(actor_id,permission_code);
  IF nullif(receipt_id,'') IS NULL OR nullif(audit_id,'') IS NULL THEN
    RAISE EXCEPTION 'reconciliation server receipt identifiers required' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('SRVF:E3-2:reconciliation-command:' || (manifest->>'commandKey'),0));
  PERFORM csd3_assert_authority_fn(manifest,actor_id);
  actor_role := csd3_assert_human_fn(actor_id,permission_code);
  -- Cross-operation command reuse is rejected, including independently bound inputs.
  SELECT * INTO existing_window FROM "ContributionShadowWindowRegistrationReceipt" WHERE "commandKey" = manifest->>'commandKey';
  SELECT * INTO existing_approval FROM "ContributionShadowDispositionApprovalReceipt" WHERE "commandKey" = manifest->>'commandKey';
  IF existing_window.id IS NOT NULL OR existing_approval.id IS NOT NULL THEN
    IF manifest->>'operation' = 'register_window' AND existing_window.id IS NOT NULL AND
      existing_approval.id IS NULL AND existing_window."manifestHash" = digest AND existing_window."actorUserId" = actor_id THEN
      RETURN jsonb_build_object('receiptId',existing_window.id,'windowId',existing_window."windowId",'replayed',TRUE);
    ELSIF manifest->>'operation' = 'sign_disposition' AND existing_approval.id IS NOT NULL AND
      existing_window.id IS NULL AND existing_approval."manifestHash" = digest AND existing_approval."signedByUserId" = actor_id THEN
      IF NOT EXISTS (SELECT 1 FROM "ContributionShadowDispositionReceipt" WHERE "approvalReceiptId" = existing_approval.id) THEN
        RAISE EXCEPTION 'reconciliation replay closure unavailable' USING ERRCODE = '23514';
      END IF;
      RETURN jsonb_build_object('receiptId',existing_approval.id,'windowId',existing_approval."windowId",
        'auditLogId',existing_approval."auditLogId",'revision',existing_approval.revision,'replayed',TRUE);
    END IF;
    RAISE EXCEPTION 'reconciliation command replay mismatch' USING ERRCODE = '23514';
  END IF;
  IF manifest->>'operation' = 'register_window' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('SRVF:E3-2:observation-window-registration',0));
    PERFORM csd3_assert_authority_fn(manifest,actor_id);
    actor_role := csd3_assert_human_fn(actor_id,permission_code);
    IF (manifest->>'startsAt')::TIMESTAMPTZ <= clock_timestamp() OR EXISTS (
      SELECT 1 FROM "ContributionShadowObservationWindow" WHERE "startsAt" < (manifest->>'endsAt')::TIMESTAMPTZ
        AND "endsAt" > (manifest->>'startsAt')::TIMESTAMPTZ) OR NOT EXISTS (
      SELECT 1 FROM "ContributionShadowMappingApproval" m WHERE m."mappingVersion" = manifest->>'signedMappingVersion'
        AND m."eventKindCode" IN ('approve','replace') AND NOT EXISTS (
          SELECT 1 FROM "ContributionShadowMappingApproval" successor WHERE successor."previousApprovalId" = m.id)) THEN
      RAISE EXCEPTION 'reconciliation prospective interval or signed mapping unavailable' USING ERRCODE = '23514';
    END IF;
    INSERT INTO "ContributionShadowObservationWindow" (id,"startsAt","endsAt","registeredByUserId",
      "deploymentDigest","configDigest","signedMappingVersion","hashAlgorithmCode","canonicalVersion")
      VALUES (manifest->>'windowId',(manifest->>'startsAt')::TIMESTAMPTZ,(manifest->>'endsAt')::TIMESTAMPTZ,
        actor_id,manifest->>'deploymentDigest',manifest->>'configDigest',manifest->>'signedMappingVersion','sha256',1);
    INSERT INTO "ContributionShadowWindowRegistrationReceipt" (id,"windowId","commandKey","manifestHash","authorityDigest",
      "actorUserId","approvalReference","startsAt","endsAt","deploymentDigest","configDigest","signedMappingVersion",
      "schemaVersion","hashAlgorithmCode","canonicalVersion") VALUES (receipt_id,manifest->>'windowId',manifest->>'commandKey',
      digest,authority_digest,actor_id,manifest->>'approvalReference',(manifest->>'startsAt')::TIMESTAMPTZ,
      (manifest->>'endsAt')::TIMESTAMPTZ,manifest->>'deploymentDigest',manifest->>'configDigest',manifest->>'signedMappingVersion',1,'sha256',1);
    result := jsonb_build_object('receiptId',receipt_id,'windowId',manifest->>'windowId','replayed',FALSE);
  ELSE
    IF nullif(disposition_id,'') IS NULL THEN
      RAISE EXCEPTION 'reconciliation server disposition identifier required' USING ERRCODE = '23514';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('SRVF:E3-2:disposition:' || (manifest->>'windowId') || ':' || (manifest->>'auditLogId'),0));
    SELECT id INTO locked_attempt_id FROM "ContributionShadowAttemptReceipt"
      WHERE "windowId"=manifest->>'windowId' AND "auditLogId"=manifest->>'auditLogId' FOR SHARE;
    PERFORM 1 FROM audit_logs WHERE id = manifest->>'auditLogId' FOR UPDATE;
    IF (SELECT id FROM "ContributionShadowAttemptReceipt" WHERE "windowId"=manifest->>'windowId' AND "auditLogId"=manifest->>'auditLogId')
      IS DISTINCT FROM locked_attempt_id THEN
      RAISE EXCEPTION 'reconciliation attempt changed during locking' USING ERRCODE='23514';
    END IF;
    PERFORM csd3_assert_authority_fn(manifest,actor_id);
    actor_role := csd3_assert_human_fn(actor_id,permission_code);
    evidence := csd3_candidate_evidence_fn(manifest->>'windowId',manifest->>'auditLogId');
    INSERT INTO "ContributionShadowDispositionApprovalReceipt" (id,"commandKey","manifestHash","authorityDigest",
      "windowId","auditLogId","attemptId",revision,"previousDispositionId","decisionCode","operationCode","basisCode",
      "approvalReference","signedByUserId","candidateEvidence","candidateEvidenceHash","hashAlgorithmCode","canonicalVersion")
      VALUES (receipt_id,manifest->>'commandKey',digest,authority_digest,manifest->>'windowId',manifest->>'auditLogId',
        evidence->'attempt'->>'id',(manifest->>'expectedRevision')::INTEGER,manifest->>'expectedPreviousDispositionId',
        manifest->>'decisionCode',evidence->'audit'->>'operation',manifest->>'basisCode',manifest->>'approvalReference',actor_id,
        evidence,csd3_hash_fn('SRVF:E3-2:shadow-candidate-evidence:v1',evidence),'sha256',1);
    INSERT INTO "ContributionShadowDispositionReceipt" (id,"windowId","auditLogId","attemptId",revision,"previousDispositionId",
      "decisionCode","evidenceHash","signedByUserId","hashAlgorithmCode","canonicalVersion","approvalReceiptId")
      VALUES (disposition_id,manifest->>'windowId',manifest->>'auditLogId',evidence->'attempt'->>'id',
        (manifest->>'expectedRevision')::INTEGER,manifest->>'expectedPreviousDispositionId',manifest->>'decisionCode',
        manifest->>'expectedCandidateEvidenceHash',actor_id,'sha256',1,receipt_id);
    result := jsonb_build_object('receiptId',receipt_id,'windowId',manifest->>'windowId','auditLogId',manifest->>'auditLogId',
      'revision',(manifest->>'expectedRevision')::INTEGER,'replayed',FALSE);
  END IF;
  -- Minimal structured audit, same transaction. A failed audit rolls back both rows.
  PERFORM csd3_assert_authority_fn(manifest,actor_id);
  actor_role := csd3_assert_human_fn(actor_id,permission_code);
  registered_at := clock_timestamp();
  INSERT INTO audit_logs (id,"createdAt","actorUserId","actorRoleSnap","resourceType","resourceId",event,context,success)
    VALUES (audit_id,registered_at AT TIME ZONE 'UTC',actor_id,actor_role,'contribution_shadow_reconciliation',receipt_id,
      CASE manifest->>'operation' WHEN 'register_window' THEN 'activity.contribution-shadow.window-register'
        ELSE 'activity.contribution-shadow.disposition-sign' END,
      jsonb_build_object('requestId','shadow-reconciliation:' || audit_id,'ip',NULL,'ua',NULL,'extra',
        jsonb_strip_nulls(jsonb_build_object('operation',manifest->>'operation','windowId',manifest->>'windowId',
          'auditLogId',manifest->>'auditLogId','revision',manifest->'expectedRevision','receiptId',receipt_id))),TRUE);
  RETURN result;
END $$;

-- One set aggregate for the entire window, not per-candidate comparison queries.
-- Only a signed candidate needs a current digest; unsigned candidates retain
-- raw gaps without inventing evidence. Return an allowlisted read projection.
CREATE FUNCTION csd3_read_candidates_fn(window_id TEXT) RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp SET jit = off AS $$
  WITH observation AS MATERIALIZED (
    SELECT w.*,r.id AS registration_id FROM "ContributionShadowObservationWindow" w
    LEFT JOIN "ContributionShadowWindowRegistrationReceipt" r ON r."windowId"=w.id WHERE w.id=window_id
  ), candidates AS MATERIALIZED (
    SELECT a.id,a."createdAt",a.event,a."resourceId",a.context#>>'{extra,operation}' AS operation,
      (nullif(a."resourceId",'') IS NOT NULL AND coalesce(
        (a.event='attendance-sheet.submit' AND a.context#>>'{extra,operation}'='submit' AND
          jsonb_typeof(a.context#>'{after,sheet}')='object' AND jsonb_typeof(a.context#>'{after,records}')='array' AND
          nullif(a.context#>>'{after,sheet,activityId}','') IS NOT NULL AND a.context#>>'{after,sheet,version}' ~ '^[1-9][0-9]*$') OR
        (a.event='attendance-sheet.edit' AND a.context#>>'{extra,operation}'='edit' AND
          jsonb_typeof(a.context#>'{after,sheet}')='object' AND jsonb_typeof(a.context#>'{after,records}')='array' AND
          nullif(a.context#>>'{after,sheet,activityId}','') IS NOT NULL AND a.context#>>'{after,sheet,version}' ~ '^[1-9][0-9]*$') OR
        (a.event='attendance-sheet.edit' AND a.context#>>'{extra,operation}' IN ('edit-no-records','resubmit')),FALSE)) AS source_valid
    FROM audit_logs a CROSS JOIN observation w WHERE a.success=TRUE AND a."resourceType"='attendance_sheet'
      AND a.event IN ('attendance-sheet.submit','attendance-sheet.edit')
      AND (a."createdAt" AT TIME ZONE 'UTC') >= w."startsAt" AND (a."createdAt" AT TIME ZONE 'UTC') < w."endsAt"
  ), counts AS MATERIALIZED (
    SELECT x."attemptId",count(*)::INTEGER AS total,
      count(*) FILTER (WHERE x."classificationCode"='equal')::INTEGER AS equal_count,
      count(*) FILTER (WHERE x."classificationCode"='points_mismatch')::INTEGER AS mismatch_count,
      count(*) FILTER (WHERE x."classificationCode" NOT IN ('equal','points_mismatch','evaluation_error'))::INTEGER AS hold_count,
      count(*) FILTER (WHERE x."classificationCode"='evaluation_error')::INTEGER AS error_count
    FROM "ContributionShadowComparisonReceipt" x JOIN "ContributionShadowAttemptReceipt" t ON t.id=x."attemptId" AND t."windowId"=window_id
    GROUP BY x."attemptId"
  ), latest AS MATERIALIZED (
    SELECT DISTINCT ON (d."auditLogId") d.* FROM "ContributionShadowDispositionReceipt" d WHERE d."windowId"=window_id
    ORDER BY d."auditLogId",d.revision DESC
  ), facts AS MATERIALIZED (
    SELECT a.*,w.registration_id,t.id AS attempt_id,t."activityId",t."sheetVersion",t."committedFactHash",
      t."expectedRecordCount",z.id AS terminal_id,z."statusCode",z."failureCode",
      coalesce(c.total,0) AS comparison_count,coalesce(c.equal_count,0) AS equal_count,
      coalesce(c.mismatch_count,0) AS mismatch_count,coalesce(c.hold_count,0) AS hold_count,coalesce(c.error_count,0) AS error_count,
      d.id AS disposition_id,d.revision,d."previousDispositionId",d."decisionCode",d."evidenceHash",d."approvalReceiptId",
      s."signedByUserId",s."approvalReference",s."basisCode",s."createdAt" AS signed_at,
      CASE WHEN s.id IS NULL THEN FALSE ELSE s."attemptId" IS NOT DISTINCT FROM t.id AND
        s."previousDispositionId" IS NOT DISTINCT FROM d."previousDispositionId" AND
        s."candidateEvidenceHash"=csd3_hash_fn('SRVF:E3-2:shadow-candidate-evidence:v1',csd3_candidate_evidence_fn(window_id,a.id)) END AS fresh_signature,
      NOT a.source_valid OR (t.id IS NOT NULL AND (t."sheetId" IS DISTINCT FROM a."resourceId" OR t."signedMappingVersion" IS DISTINCT FROM w."signedMappingVersion")) OR
        (z.id IS NOT NULL AND (z."expectedRecordCount" IS DISTINCT FROM t."expectedRecordCount" OR z."writtenRecordCount" IS DISTINCT FROM coalesce(c.total,0) OR
          z."equalCount" IS DISTINCT FROM coalesce(c.equal_count,0) OR z."mismatchCount" IS DISTINCT FROM coalesce(c.mismatch_count,0) OR
          z."holdCount" IS DISTINCT FROM coalesce(c.hold_count,0) OR z."errorCount" IS DISTINCT FROM coalesce(c.error_count,0))) AS source_or_chain_anomaly,
      w."endsAt" <= statement_timestamp() AS closed
    FROM candidates a CROSS JOIN observation w LEFT JOIN "ContributionShadowAttemptReceipt" t ON t."windowId"=window_id AND t."auditLogId"=a.id
    LEFT JOIN "ContributionShadowTerminalReceipt" z ON z."attemptId"=t.id LEFT JOIN counts c ON c."attemptId"=t.id
    LEFT JOIN latest d ON d."auditLogId"=a.id LEFT JOIN "ContributionShadowDispositionApprovalReceipt" s ON s.id=d."approvalReceiptId"
  ), classified AS (
    SELECT f.*,array_remove(ARRAY[
      CASE WHEN source_or_chain_anomaly THEN 'source_or_chain_anomaly' END,
      CASE WHEN attempt_id IS NULL THEN 'missing_start' END,
      CASE WHEN attempt_id IS NOT NULL AND terminal_id IS NULL THEN 'missing_terminal' END,
      CASE WHEN "statusCode"='failed' THEN 'failed' END,
      CASE WHEN error_count>0 THEN 'error' END,CASE WHEN hold_count>0 THEN 'hold' END,CASE WHEN mismatch_count>0 THEN 'mismatch' END],NULL) AS reasons,
      coalesce(registration_id IS NOT NULL AND fresh_signature AND "decisionCode"='not_applicable' AND closed AND
        operation IN ('edit-no-records','resubmit') AND NOT source_or_chain_anomaly AND "statusCode" IS DISTINCT FROM 'failed' AND
        mismatch_count=0 AND hold_count=0 AND error_count=0,FALSE) AS not_applicable
    FROM facts f
  ) SELECT jsonb_build_object('auditLogId',id,'createdAt',to_char("createdAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'event',event,'operation',operation,'sheetId',"resourceId",'activityId',"activityId",'sheetVersion',"sheetVersion",
    'attemptId',attempt_id,'terminalId',terminal_id,'terminalStatus',"statusCode",'failureCode',"failureCode",
    'expectedRecordCount',"expectedRecordCount",'comparisonCount',comparison_count,'equalCount',equal_count,
    'mismatchCount',mismatch_count,'holdCount',hold_count,'errorCount',error_count,'committedFactHash',"committedFactHash",
    'reasonCodes',to_jsonb(reasons),'primaryClassification',coalesce(reasons[1],'equal'),
    'rawUnresolved',cardinality(reasons)>0,'netUnresolved',cardinality(reasons)>0 AND NOT not_applicable,
    'missingStart',attempt_id IS NULL,'missingTerminal',attempt_id IS NOT NULL AND terminal_id IS NULL,
    'notApplicable',not_applicable,'dispositionId',disposition_id,'revision',revision,'previousDispositionId',"previousDispositionId",
    'decisionCode',"decisionCode",'approvalReceiptId',"approvalReceiptId",'signedByUserId',"signedByUserId",
    'approvalReference',"approvalReference",'basisCode',"basisCode",'evidenceHash',"evidenceHash",'candidateEvidenceHash',NULL,
    'signedAt',to_char(signed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'signatureStatus',CASE WHEN "approvalReceiptId" IS NULL THEN 'unsigned' WHEN fresh_signature IS TRUE THEN 'current' ELSE 'stale_evidence' END)
    FROM classified
$$;

-- Only the selected detail obtains the current signing anchor. No evidence body
-- is returned, and list/summary do not recalculate every unsigned snapshot.
CREATE FUNCTION csd3_read_candidate_fn(window_id TEXT,audit_id TEXT) RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp SET jit = off AS $$
  SELECT value || jsonb_build_object('candidateEvidenceHash',
    csd3_hash_fn('SRVF:E3-2:shadow-candidate-evidence:v1',csd3_candidate_evidence_fn(window_id,audit_id)))
  FROM csd3_read_candidates_fn(window_id) AS candidate(value) WHERE value->>'auditLogId'=audit_id
$$;

CREATE FUNCTION csd3_read_summary_fn(window_id TEXT) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp SET jit = off AS $$
  WITH candidates AS MATERIALIZED (SELECT value FROM csd3_read_candidates_fn(window_id) AS candidate(value))
  SELECT jsonb_build_object('candidateCount',count(*),'attemptCount',count(*) FILTER (WHERE value->>'attemptId' IS NOT NULL),
    'terminalCount',count(*) FILTER (WHERE value->>'terminalId' IS NOT NULL),
    'rawMissingStartCount',count(*) FILTER (WHERE value->>'missingStart'='true'),
    'rawMissingTerminalCount',count(*) FILTER (WHERE value->>'missingTerminal'='true'),
    'rawUnresolvedCount',count(*) FILTER (WHERE value->>'rawUnresolved'='true'),
    'notApplicableCount',count(*) FILTER (WHERE value->>'notApplicable'='true'),
    'netUnresolvedCount',count(*) FILTER (WHERE value->>'netUnresolved'='true'),
    'netMissingStartCount',count(*) FILTER (WHERE value->>'missingStart'='true' AND value->>'notApplicable'='false'),
    'netMissingTerminalCount',count(*) FILTER (WHERE value->>'missingTerminal'='true' AND value->>'notApplicable'='false'),
    'failedCount',count(*) FILTER (WHERE value->>'terminalStatus'='failed'),
    'mismatchCount',count(*) FILTER (WHERE (value->>'mismatchCount')::integer>0),
    'holdCount',count(*) FILTER (WHERE (value->>'holdCount')::integer>0),
    'errorCount',count(*) FILTER (WHERE (value->>'errorCount')::integer>0),
    'sourceOrChainAnomalyCount',count(*) FILTER (WHERE value->'reasonCodes' ? 'source_or_chain_anomaly'),
    'staleSignatureCount',count(*) FILTER (WHERE value->>'signatureStatus'='stale_evidence'),
    'anomalousReceiptCount',(SELECT count(*) FROM "ContributionShadowAttemptReceipt" t WHERE t."windowId"=window_id
      AND NOT EXISTS (SELECT 1 FROM candidates c WHERE c.value->>'auditLogId'=t."auditLogId"))) FROM candidates
$$;

-- Read qualification is separate from command authority and accepts only the
-- read code. The reader needs no direct private User/RBAC table lock privilege.
CREATE FUNCTION csd3_authorize_read_fn(actor_id TEXT) RETURNS "Role"
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT csd3_assert_human_fn(actor_id,'contribution-shadow.read.evidence')
$$;

REVOKE ALL ON FUNCTION csd3_authority_fn(), csd3_assert_authority_fn(JSONB,TEXT),
  csd3_assert_human_fn(TEXT,TEXT), csd3_window_insert_guard_fn(), csd3_approval_insert_guard_fn(),
  csd3_approval_closure_fn(), csd3_candidate_evidence_fn(TEXT,TEXT),csd3_register_fn(JSONB,TEXT,TEXT,TEXT,TEXT),
  csd3_read_candidates_fn(TEXT),csd3_read_candidate_fn(TEXT,TEXT),csd3_read_summary_fn(TEXT),csd3_authorize_read_fn(TEXT) FROM PUBLIC;

COMMIT;
