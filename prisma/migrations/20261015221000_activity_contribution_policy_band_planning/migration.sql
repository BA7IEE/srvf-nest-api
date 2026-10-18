-- Migration146: inline policy bands to avoid the materialized JSON expansion estimate.
-- Preserve the complete frozen validation, JSON/FULL JOIN/root and both native guards.
BEGIN;

CREATE OR REPLACE FUNCTION e4_assert_complete(revision_id TEXT, validate_version BOOLEAN DEFAULT TRUE) RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE root "ActivitySettlementContributionRevision"; version_row "AttendanceSettlementVersion";
  time_row "ActivitySettlementTimeRevision"; previous "ActivitySettlementContributionRevision";
  source_draft "ActivitySettlementContributionRevision"; application "CorrectionApplication";
  request_row "AttendanceCorrectionRequest"; manifest "ParticipationTimeCorrectionManifest";
  time_proof "CorrectionTimeSourceProof"; counts BIGINT; total NUMERIC; sources_hash TEXT; evaluations_hash TEXT;
  source_invalid BOOLEAN; evaluation_mismatch BOOLEAN;
BEGIN
  SELECT * INTO STRICT root FROM "ActivitySettlementContributionRevision" WHERE id=revision_id;
  SELECT * INTO STRICT version_row FROM "AttendanceSettlementVersion" WHERE id=root."settlementVersionId";
  IF version_row."contributionRegimeCode" <> 'policy_v1'
    OR version_row."settlementRunId" <> root."settlementRunId"
    OR version_row."evidenceSealId" <> root."evidenceSealId"
    OR version_row."evidenceRevision" <> root."evidenceRevision"
    OR version_row."populationRevision" <> root."populationRevision"
    OR version_row."workflowRevision" <> root."workflowRevision"
  THEN RAISE EXCEPTION 'contribution version/seal mismatch' USING ERRCODE='23514',CONSTRAINT='e4_version_guard'; END IF;
  PERFORM e4_assert_frozen_selection(root);

  IF root."kindCode" IN ('draft','submitted') THEN
    SELECT * INTO STRICT time_row FROM "ActivitySettlementTimeRevision" WHERE id=root."timeRevisionId";
    IF time_row."kindCode" <> root."kindCode" OR time_row."draftContentHash" <> root."draftContentHash"
      OR time_row."evidenceSealId" <> root."evidenceSealId" OR time_row."evidenceRevision" <> root."evidenceRevision"
      OR time_row."populationRevision" <> root."populationRevision" OR time_row."workflowRevision" <> root."workflowRevision"
      OR time_row."bucketContentHash" IS DISTINCT FROM astr_bucket_content_hash(time_row.id)
      OR time_row."bucketCount" <> (SELECT count(*) FROM "ParticipantSettlementTimeBucket" WHERE "timeRevisionId"=time_row.id)
      OR time_row."sourceCount" <> (SELECT count(*) FROM "ParticipantSettlementTimeBucketSource" WHERE "timeRevisionId"=time_row.id)
    THEN RAISE EXCEPTION 'contribution time revision mismatch' USING ERRCODE='23514',CONSTRAINT='e4_source_guard'; END IF;
    -- Do not filter malformed sources out and then accept a convenient empty proof.
    IF EXISTS (
      SELECT 1 FROM "ParticipantSettlementTimeBucketSource" bs JOIN "ParticipantTimeAllocationRevision" a ON a.id=bs."allocationRevisionId"
      WHERE bs."timeRevisionId"=time_row.id AND (a."ruleSnapshotId" <> root."ruleSnapshotId"
        OR a."ruleSnapshotHash" <> root."ruleSnapshotHash" OR a."activityId" <> root."activityId")
    ) OR EXISTS (
      SELECT 1 FROM "ParticipantSettlementTimeBucket" b LEFT JOIN "ParticipantSettlementResultRevision" rr
        ON rr."settlementVersionId"=root."settlementVersionId" AND rr."participationIdentityId"=b."participationIdentityId"
      WHERE b."timeRevisionId"=time_row.id AND (rr.id IS NULL OR (rr."resultCode" <> 'present' AND b."recognizedSeconds" <> 0))
    ) THEN RAISE EXCEPTION 'contribution source population mismatch' USING ERRCODE='23514',CONSTRAINT='e4_source_guard'; END IF;
    IF root."kindCode"='submitted' THEN
      SELECT * INTO STRICT source_draft FROM "ActivitySettlementContributionRevision" WHERE id=root."sourceDraftContributionRevisionId";
      IF source_draft."kindCode" <> 'draft' OR source_draft."sourceKindCode" <> 'time_revision'
        OR source_draft."settlementRunId" <> root."settlementRunId" OR source_draft."activityId" <> root."activityId"
        OR source_draft."draftContentHash" <> root."draftContentHash" OR source_draft."evidenceSealId" <> root."evidenceSealId"
        OR source_draft."evidenceRevision" <> root."evidenceRevision" OR source_draft."populationRevision" <> root."populationRevision"
        OR source_draft."workflowRevision" <> root."workflowRevision" OR source_draft."ruleSnapshotId" <> root."ruleSnapshotId"
        OR source_draft."selectionRevisionHash" <> root."selectionRevisionHash" OR source_draft."sourceSetHash" <> root."sourceSetHash"
        OR source_draft."evaluationSetHash" <> root."evaluationSetHash" OR source_draft."evaluationCount" <> root."evaluationCount"
        OR source_draft."recognizedPointsTotal" <> root."recognizedPointsTotal"
        OR NOT EXISTS (SELECT 1 FROM "ActivitySettlementTimeRevision" d WHERE d.id=source_draft."timeRevisionId"
          AND d."settlementVersionId"=source_draft."settlementVersionId" AND d."bucketContentHash"=time_row."bucketContentHash"
          AND d."sourceSetHash"=time_row."sourceSetHash")
      THEN RAISE EXCEPTION 'contribution submitted draft mismatch' USING ERRCODE='23514',CONSTRAINT='e4_copy_guard'; END IF;
    END IF;
  ELSE
    SELECT * INTO STRICT previous FROM "ActivitySettlementContributionRevision" WHERE id=root."previousContributionRevisionId";
    SELECT * INTO STRICT application FROM "CorrectionApplication" WHERE id=root."correctionApplicationId";
    SELECT * INTO STRICT request_row FROM "AttendanceCorrectionRequest" WHERE id=application."correctionRequestId";
    IF previous."kindCode" NOT IN ('submitted','correction') OR previous."settlementVersionId" <> root."baseSettlementVersionId"
      OR NOT EXISTS (SELECT 1 FROM "LedgerPostingBatch" b WHERE b."settlementVersionId"=previous."settlementVersionId"
        AND b."settlementRunId"=previous."settlementRunId" AND b."statusCode"='committed')
      OR request_row."baseSettlementVersionId" <> root."baseSettlementVersionId" OR request_row."activityId" <> root."activityId"
      OR request_row."settlementRunId" <> root."settlementRunId" OR application."newSettlementVersionId" <> root."settlementVersionId"
      OR application."newPostingBatchId" <> root."correctionPostingBatchId" OR version_row."priorVersionId" IS DISTINCT FROM previous."settlementVersionId"
      OR previous."evidenceSealId" <> root."evidenceSealId" OR previous."evidenceRevision" <> root."evidenceRevision"
      OR previous."populationRevision" <> root."populationRevision" OR previous."workflowRevision" <> root."workflowRevision"
      OR previous."draftContentHash" <> root."draftContentHash" OR previous."ruleSnapshotId" <> root."ruleSnapshotId"
      OR previous."ruleSnapshotHash" <> root."ruleSnapshotHash" OR previous."selectionRevisionId" <> root."selectionRevisionId"
      OR previous."selectionRevisionHash" <> root."selectionRevisionHash"
    THEN RAISE EXCEPTION 'contribution correction ancestry mismatch' USING ERRCODE='23514',CONSTRAINT='e4_correction_guard'; END IF;
    IF root."sourceKindCode"='unchanged_time' THEN
      IF root."effectiveTimeSettlementVersionId" IS DISTINCT FROM previous."effectiveTimeSettlementVersionId"
        OR request_row."requestedChangeJson"->'schemaVersion' IS DISTINCT FROM '1'::JSONB
        OR (request_row."requestedChangeJson"->'timeCorrection' IS NOT NULL AND request_row."requestedChangeJson"->'timeCorrection' <> 'null'::JSONB)
        OR coalesce(jsonb_array_length(request_row."requestedChangeJson"->'segments'),0) <> 0
        OR coalesce(jsonb_array_length(request_row."requestedChangeJson"->'allocations'),0) <> 0
        OR EXISTS (SELECT 1 FROM "CorrectionTimeSourceProof" WHERE "applicationId"=application.id)
        OR EXISTS (SELECT 1 FROM "ParticipationTimeCorrectionManifest" WHERE "postingBatchId"=root."correctionPostingBatchId")
        OR previous."sourceSetHash" <> root."sourceSetHash" OR previous."evaluationSetHash" <> root."evaluationSetHash"
        OR previous."evaluationCount" <> root."evaluationCount" OR previous."recognizedPointsTotal" <> root."recognizedPointsTotal"
        OR EXISTS (
          WITH prior_results AS MATERIALIZED (SELECT r."participationIdentityId",i."memberId",i."sessionId",i."activityId",r."resultCode",r."recognizedServiceHours"
            FROM "ParticipantSettlementResultRevision" r LEFT JOIN "ActivityParticipationIdentity" i ON i.id=r."participationIdentityId"
            WHERE r."settlementVersionId"=previous."settlementVersionId"),
          current_results AS MATERIALIZED (SELECT r."participationIdentityId",i."memberId",i."sessionId",i."activityId",r."resultCode",r."recognizedServiceHours"
            FROM "ParticipantSettlementResultRevision" r LEFT JOIN "ActivityParticipationIdentity" i ON i.id=r."participationIdentityId"
            WHERE r."settlementVersionId"=root."settlementVersionId")
          SELECT 1 FROM prior_results p FULL JOIN current_results c USING ("participationIdentityId")
          WHERE p."participationIdentityId" IS NULL OR c."participationIdentityId" IS NULL
            OR p."activityId" IS DISTINCT FROM root."activityId" OR c."activityId" IS DISTINCT FROM root."activityId"
            OR p."memberId" IS DISTINCT FROM c."memberId" OR p."sessionId" IS DISTINCT FROM c."sessionId"
            OR p."resultCode" IS DISTINCT FROM c."resultCode"
            OR p."recognizedServiceHours" IS DISTINCT FROM c."recognizedServiceHours"
        )
        OR EXISTS (
          WITH prior AS MATERIALIZED (SELECT "evaluationUnitKey",e4_evaluation_document(e) AS document
            FROM "ParticipantContributionEvaluation" e WHERE "contributionRevisionId"=previous.id),
          current_set AS MATERIALIZED (SELECT "evaluationUnitKey",e4_evaluation_document(e) AS document
            FROM "ParticipantContributionEvaluation" e WHERE "contributionRevisionId"=root.id)
          SELECT 1 FROM prior p FULL JOIN current_set c USING ("evaluationUnitKey") WHERE p.document IS DISTINCT FROM c.document
        )
      THEN RAISE EXCEPTION 'contribution unchanged source mismatch' USING ERRCODE='23514',CONSTRAINT='e4_copy_guard'; END IF;
    ELSE
      SELECT * INTO STRICT manifest FROM "ParticipationTimeCorrectionManifest" WHERE id=root."correctionManifestId";
      SELECT * INTO STRICT time_proof FROM "CorrectionTimeSourceProof" WHERE id=root."correctionTimeSourceProofId";
      IF request_row."requestedChangeJson"->'schemaVersion' IS DISTINCT FROM '3'::JSONB
        OR request_row."requestedChangeJson"->'timeCorrection' IS NULL OR request_row."requestedChangeJson"->'timeCorrection'='null'::JSONB
        OR time_proof."applicationId" <> application.id OR time_proof."correctionManifestId" <> manifest.id
        OR time_proof."postingBatchId" <> root."correctionPostingBatchId" OR time_proof."activityId" <> root."activityId"
        OR time_proof."settlementRunId" <> root."settlementRunId" OR time_proof."baseSettlementVersionId" <> root."baseSettlementVersionId"
        OR time_proof."settlementVersionId" <> root."settlementVersionId" OR time_proof."rootManifestId" <> root."rootTimeManifestId"
        OR time_proof."sourceSetHash" <> root."correctionSourceSetHash" OR manifest."formatVersion" <> 2
        OR manifest."sourceProofId" IS DISTINCT FROM time_proof.id OR manifest."sourceProofHash" IS DISTINCT FROM time_proof."sourceSetHash"
        OR manifest."correctionRequestId" <> request_row.id OR manifest."rootManifestId" <> time_proof."rootManifestId"
        OR time_proof."sourceSetHash" IS DISTINCT FROM e4_hash(jsonb_build_object('domain','correction-time-source-set-v1','definition',time_proof."sourceSnapshotJson"))
        OR time_proof."calculationHash" IS DISTINCT FROM e4_hash(jsonb_build_object('domain','correction-time-calculation-buckets-v1','definition',time_proof."calculatedBucketsJson"))
        OR time_proof."expectedSegmentCount" <> jsonb_array_length(time_proof."sourceSnapshotJson")
        OR time_proof."expectedSliceCount" <> (SELECT coalesce(sum(jsonb_array_length(s->'slices')),0) FROM jsonb_array_elements(time_proof."sourceSnapshotJson") s)
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(time_proof."sourceSnapshotJson") s
          LEFT JOIN "ParticipantTimeAllocationRevision" a ON a.id=s->>'baseAllocationRevisionId' AND a."activityId"=root."activityId"
          WHERE a.id IS NULL OR a."ruleSnapshotId" <> root."ruleSnapshotId" OR a."ruleSnapshotHash" <> root."ruleSnapshotHash"
            OR a."participationIdentityId" IS DISTINCT FROM s->>'participationIdentityId'
        )
      THEN RAISE EXCEPTION 'contribution current D7 proof mismatch' USING ERRCODE='23514',CONSTRAINT='e4_correction_guard'; END IF;
    END IF;
  END IF;

  -- Unchanged-time evidence is an exact set copy of the immutable predecessor,
  -- not a recursive walk/re-evaluation of all earlier correction generations.
  IF root."sourceKindCode" <> 'unchanged_time' THEN
    -- One source expansion per invocation; independent trigger calls remain independent.
    WITH assertion_sources AS MATERIALIZED (
      SELECT * FROM e4_source_rows(root.id)
    ), source_status AS MATERIALIZED (
      SELECT EXISTS (SELECT 1 FROM assertion_sources s WHERE identity_id IS NULL OR member_id IS NULL OR session_id IS NULL
      OR snapshot_id IS DISTINCT FROM root."ruleSnapshotId" OR item_id IS NULL OR policy_id IS NULL OR policy_version_id IS NULL
      OR definition_hash IS NULL OR evaluator_version IS DISTINCT FROM 1 OR role_code IS NULL
      OR category_code NOT IN ('volunteer_service','training','organization','non_creditable')
      OR (source_ref->>'durationSeconds')::INTEGER < 0 OR (source_ref->>'startsAt')::TIMESTAMPTZ >= (source_ref->>'endsAt')::TIMESTAMPTZ) AS invalid
    ), revision_domain AS MATERIALIZED (
  SELECT astr_canonical_json(jsonb_build_object('domain',
    (SELECT "sourceKindCode" FROM "ActivitySettlementContributionRevision" WHERE id=root.id))->'domain') AS canonical
), sources AS MATERIALIZED (
  SELECT source.*,CASE WHEN jsonb_typeof(source_ref)='object' THEN
      CASE WHEN source_ref ?& ARRAY['allocationHash','allocationRevisionId','durationSeconds','endsAt','selectionItemId','sliceId','sourceSegmentId','sourceSegmentRevision','startsAt']::TEXT[]
        AND source_ref - ARRAY['allocationHash','allocationRevisionId','durationSeconds','endsAt','selectionItemId','sliceId','sourceSegmentId','sourceSegmentRevision','startsAt']::TEXT[] = '{}'::JSONB
        AND NOT jsonb_path_exists(source_ref,
          'strict $.* ? (@.type() == "object" || @.type() == "array")')
      THEN
      '{"allocationHash":' || (source_ref->'allocationHash')::TEXT ||
      ',"allocationRevisionId":' || (source_ref->'allocationRevisionId')::TEXT ||
      ',"durationSeconds":' || (source_ref->'durationSeconds')::TEXT ||
      ',"endsAt":' || (source_ref->'endsAt')::TEXT ||
      ',"selectionItemId":' || (source_ref->'selectionItemId')::TEXT ||
      ',"sliceId":' || (source_ref->'sliceId')::TEXT ||
      ',"sourceSegmentId":' || (source_ref->'sourceSegmentId')::TEXT ||
      ',"sourceSegmentRevision":' || (source_ref->'sourceSegmentRevision')::TEXT ||
      ',"startsAt":' || (source_ref->'startsAt')::TEXT || '}'
      ELSE astr_canonical_json(source_ref) END
    ELSE astr_canonical_json(source_ref) END AS source_canonical FROM assertion_sources source
    WHERE NOT (SELECT invalid FROM source_status)
), groups AS MATERIALIZED (
  SELECT identity_id,member_id,session_id,snapshot_id,policy_id,policy_version_id,definition_hash,evaluator_version,role_code,category_code,
    min(item_id COLLATE "C") AS representative,
    sum((source_ref->>'durationSeconds')::BIGINT)::INTEGER AS seconds,
    jsonb_agg(source_ref ORDER BY source_canonical COLLATE "C") AS refs,
    '[' || string_agg(coalesce(source_canonical,'null'),',' ORDER BY source_canonical COLLATE "C") || ']' AS refs_canonical
  FROM sources GROUP BY identity_id,member_id,session_id,snapshot_id,policy_id,policy_version_id,definition_hash,evaluator_version,role_code,category_code
), policy_bands AS NOT MATERIALIZED (
  SELECT p.id,role->>'attendanceRoleCode' AS role_code,category->>'timeCategoryCode' AS category_code,band,ordinal
  FROM "ContributionPolicyVersion" p
  CROSS JOIN LATERAL jsonb_array_elements(p."definitionJson"->'roleRules') role
  CROSS JOIN LATERAL jsonb_array_elements(role->'categoryRules') category
  CROSS JOIN LATERAL jsonb_array_elements(category->'durationBands') WITH ORDINALITY b(band,ordinal)
  WHERE p.id IN (SELECT DISTINCT policy_version_id FROM groups)
), selected AS MATERIALIZED (
  SELECT g.identity_id,g.member_id,g.session_id,g.snapshot_id,g.policy_id,g.policy_version_id,g.definition_hash,g.evaluator_version,g.role_code,g.category_code,
    g.representative,g.seconds,g.refs_canonical,resolved.result,
    '{"attendanceRoleCode":' || coalesce(to_jsonb(g.role_code)::TEXT,'null') ||
    ',"definitionHash":' || coalesce(to_jsonb(g.definition_hash)::TEXT,'null') ||
    ',"evaluatorVersion":' || coalesce(to_jsonb(g.evaluator_version)::TEXT,'null') ||
    ',"mode":"policy","participationIdentityId":' || coalesce(to_jsonb(g.identity_id)::TEXT,'null') ||
    ',"policyId":' || coalesce(to_jsonb(g.policy_id)::TEXT,'null') ||
    ',"policyVersionId":' || coalesce(to_jsonb(g.policy_version_id)::TEXT,'null') ||
    ',"sessionId":' || coalesce(to_jsonb(g.session_id)::TEXT,'null') ||
    ',"timeCategoryCode":' || coalesce(to_jsonb(g.category_code)::TEXT,'null') || '}' AS unit,
    e4_day_points(g.refs,((resolved.result->>'recognizedPoints')::NUMERIC*100)::INTEGER) AS day_points
  FROM groups g JOIN "ContributionPolicyVersion" p ON p.id=g.policy_version_id
  LEFT JOIN LATERAL (
    SELECT b.band FROM policy_bands b WHERE b.id=g.policy_version_id AND b.role_code=g.role_code AND b.category_code=g.category_code
      AND ((b.band->>'maxSecondsInclusive') IS NULL OR (b.band->>'maxSecondsInclusive')::BIGINT >= g.seconds)
    ORDER BY b.ordinal LIMIT 1
  ) chosen ON TRUE
  CROSS JOIN LATERAL (VALUES (coalesce(chosen.band,p."definitionJson"->'defaultResult'))) resolved(result)
), documents AS MATERIALIZED (
  SELECT unit,refs_canonical,
    jsonb_build_object('participationIdentityId',identity_id,'memberId',member_id,'sessionId',session_id,'ruleSnapshotId',snapshot_id,
      'selectionItemId',representative,'mode','policy','policyId',policy_id,'policyVersionId',policy_version_id,'definitionHash',definition_hash,
      'evaluatorVersion',evaluator_version,'attendanceRoleCode',role_code,'timeCategoryCode',category_code,
      'evaluationUnitKey',encode(sha256(convert_to('{"definition":{"unit":' || coalesce(to_jsonb(unit)::TEXT,'null') || '},"schemaVersion":1}','UTF8')),'hex'),'durationSeconds',seconds,
      'sourceFingerprint',encode(sha256(convert_to('{"definition":{"domain":' || (SELECT canonical FROM revision_domain)
        || ',"sources":' || refs_canonical || '},"schemaVersion":1}','UTF8')),'hex'),
      'calculatedPoints',result->>'recognizedPoints','recognizedPoints',result->>'recognizedPoints','explanationCode',result->>'explanationCode',
      'beijingDayPointsJson',day_points) AS metadata
  FROM selected
), canonical_documents AS NOT MATERIALIZED (
  SELECT unit,refs_canonical,metadata,
    (SELECT '{' || string_agg(to_jsonb(field_name)::TEXT || ':' || field_canonical,',' ORDER BY field_name COLLATE "C") || '}'
     FROM (
       SELECT key AS field_name,
          CASE WHEN jsonb_typeof(value) IN ('object','array') THEN astr_canonical_json(value)
            ELSE value::TEXT END AS field_canonical FROM jsonb_each(metadata)
       UNION ALL SELECT 'sourceRefsJson',refs_canonical
     ) field) AS document_canonical
  FROM documents
)
    , expected_documents(unit_canonical,evaluation_key,evaluation) AS NOT MATERIALIZED (
      SELECT unit,metadata->>'evaluationUnitKey',metadata || jsonb_build_object('sourceRefsJson',refs_canonical::JSONB,
        'evaluationHash',encode(sha256(convert_to('{"definition":' || document_canonical || ',"schemaVersion":1}','UTF8')),'hex'))
      FROM canonical_documents
    ), expected AS NOT MATERIALIZED (
      SELECT evaluation_key AS key,evaluation
      FROM expected_documents
    ), actual AS MATERIALIZED (
        SELECT e.id,e."evaluationUnitKey" AS key
        FROM "ParticipantContributionEvaluation" e
        WHERE e."contributionRevisionId"=root.id
      ), pairs AS MATERIALIZED (
        SELECT a.id AS actual_id,
          x.evaluation IS DISTINCT FROM
            CASE WHEN e.id IS NULL THEN NULL::JSONB
                 ELSE e4_evaluation_document(e) END AS is_mismatch
        FROM (expected x FULL JOIN actual a USING (key))
        LEFT JOIN "ParticipantContributionEvaluation" e
          ON e.id=a.id AND e."contributionRevisionId"=root.id
      )
    SELECT status.invalid,
      CASE WHEN status.invalid THEN FALSE ELSE EXISTS (
        SELECT 1 FROM pairs p WHERE p.is_mismatch
      ) END
      INTO source_invalid,evaluation_mismatch
    FROM source_status status;
    IF source_invalid THEN RAISE EXCEPTION 'contribution unresolved source' USING ERRCODE='23514',CONSTRAINT='e4_source_guard'; END IF;
    IF evaluation_mismatch THEN RAISE EXCEPTION 'contribution evaluation set mismatch' USING ERRCODE='23514',CONSTRAINT='e4_evaluation_guard'; END IF;
  END IF;
  WITH documents AS MATERIALIZED (
    SELECT e."recognizedPoints",astr_canonical_json(jsonb_build_object('participationIdentityId',e."participationIdentityId",'sessionId',e."sessionId",
      'mode',e.mode,'policyId',e."policyId",'policyVersionId',e."policyVersionId",'definitionHash',e."definitionHash",
      'evaluatorVersion',e."evaluatorVersion",'attendanceRoleCode',e."attendanceRoleCode",'timeCategoryCode',e."timeCategoryCode")) AS unit,
      astr_canonical_json(to_jsonb(e."evaluationUnitKey")) AS unit_key_json,
      astr_canonical_json(to_jsonb(e."sourceFingerprint")) AS source_fingerprint_json,
      astr_canonical_json(to_jsonb(e."evaluationHash")) AS evaluation_hash_json
    FROM "ParticipantContributionEvaluation" e WHERE e."contributionRevisionId"=root.id
  ) SELECT count(*),coalesce(sum("recognizedPoints"),0),
    encode(sha256(convert_to('{"definition":{"domain":'||astr_canonical_json(to_jsonb(root."sourceKindCode"))||',"sources":['||
      coalesce(string_agg('{"evaluationUnitKey":'||unit_key_json||',"sourceFingerprint":'||source_fingerprint_json||'}',
        ',' ORDER BY unit COLLATE "C"),'')||']},"schemaVersion":1}','UTF8')),'hex'),
    encode(sha256(convert_to('{"definition":{"evaluations":['||
      coalesce(string_agg(evaluation_hash_json,',' ORDER BY unit COLLATE "C"),'')||']},"schemaVersion":1}','UTF8')),'hex')
    INTO counts,total,sources_hash,evaluations_hash FROM documents;
  IF counts <> root."evaluationCount" OR total <> root."recognizedPointsTotal"
    OR (root."sourceKindCode" <> 'unchanged_time' AND sources_hash <> root."sourceSetHash") OR evaluations_hash <> root."evaluationSetHash"
    OR (SELECT count(DISTINCT "participationIdentityId") FROM "ParticipantContributionEvaluation" WHERE "contributionRevisionId"=root.id) > 2000
    OR (SELECT coalesce(sum(jsonb_array_length("sourceRefsJson")),0) FROM "ParticipantContributionEvaluation" WHERE "contributionRevisionId"=root.id) > 50000
    OR EXISTS (SELECT 1 FROM "ParticipantContributionEvaluation" WHERE "contributionRevisionId"=root.id
      GROUP BY "participationIdentityId" HAVING sum("recognizedPoints") > 999.99)
  THEN RAISE EXCEPTION 'contribution root count/hash/total mismatch' USING ERRCODE='23514',CONSTRAINT='e4_complete_guard'; END IF;
  IF validate_version AND root."kindCode" <> 'draft' THEN
    IF version_row."contentHash" IS DISTINCT FROM e4_version_content_hash(root.id)
      OR version_row."sessionParticipationCount" <> (SELECT count(*) FROM "ParticipantSettlementResultRevision" WHERE "settlementVersionId"=version_row.id)
      OR EXISTS (
        WITH amounts AS MATERIALIZED (SELECT "participationIdentityId",sum("recognizedPoints") AS amount
          FROM "ParticipantContributionEvaluation" WHERE "contributionRevisionId"=root.id GROUP BY "participationIdentityId")
        SELECT 1 FROM "ParticipantSettlementResultRevision" rr JOIN "ActivityParticipationIdentity" i ON i.id=rr."participationIdentityId"
        LEFT JOIN amounts e ON e."participationIdentityId"=rr."participationIdentityId"
        WHERE rr."settlementVersionId"=version_row.id AND (i."activityId" <> root."activityId"
          OR rr."recognizedContributionPoints" <> coalesce(e.amount,0) OR rr."calculatedContributionPoints" <> coalesce(e.amount,0)
          OR (rr."resultCode" <> 'present' AND coalesce(e.amount,0) <> 0))
      ) OR EXISTS (SELECT 1 FROM "ParticipantContributionEvaluation" e WHERE e."contributionRevisionId"=root.id
        AND NOT EXISTS (SELECT 1 FROM "ParticipantSettlementResultRevision" rr
          WHERE rr."settlementVersionId"=version_row.id AND rr."participationIdentityId"=e."participationIdentityId" AND rr."resultCode"='present'))
    THEN RAISE EXCEPTION 'contribution frozen result/V3 hash mismatch' USING ERRCODE='23514',CONSTRAINT='e4_result_guard'; END IF;
  END IF;
END $$;

COMMIT;
