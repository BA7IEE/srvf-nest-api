-- Candidate 140: only three equivalent expression replacements in e4_expected_evaluations.
-- Unit keys are the existing closed nine SQL TEXT/INTEGER fields, including SQL NULL.
-- Metadata containers retain the original canonicalizer; scalar text is its exact ELSE branch.
-- Unit hash retains the original schemaVersion-1 definition envelope and UTF8 SHA256.
CREATE OR REPLACE FUNCTION e4_expected_evaluations(revision_id TEXT)
RETURNS TABLE(unit_canonical TEXT,evaluation JSONB)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
WITH revision_domain AS MATERIALIZED (
  SELECT astr_canonical_json(jsonb_build_object('domain',
    (SELECT "sourceKindCode" FROM "ActivitySettlementContributionRevision" WHERE id=revision_id))->'domain') AS canonical
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
    ELSE astr_canonical_json(source_ref) END AS source_canonical FROM e4_source_rows(revision_id) source
), groups AS MATERIALIZED (
  SELECT identity_id,member_id,session_id,snapshot_id,policy_id,policy_version_id,definition_hash,evaluator_version,role_code,category_code,
    min(item_id COLLATE "C") AS representative,
    sum((source_ref->>'durationSeconds')::BIGINT)::INTEGER AS seconds,
    jsonb_agg(source_ref ORDER BY source_canonical COLLATE "C") AS refs,
    '[' || string_agg(coalesce(source_canonical,'null'),',' ORDER BY source_canonical COLLATE "C") || ']' AS refs_canonical
  FROM sources GROUP BY identity_id,member_id,session_id,snapshot_id,policy_id,policy_version_id,definition_hash,evaluator_version,role_code,category_code
), policy_bands AS MATERIALIZED (
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
SELECT unit,metadata || jsonb_build_object('sourceRefsJson',refs_canonical::JSONB,
  'evaluationHash',encode(sha256(convert_to('{"definition":' || document_canonical || ',"schemaVersion":1}','UTF8')),'hex'))
FROM canonical_documents
$$;
