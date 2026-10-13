-- Unapproved candidate 142: only the exact closed nine-key scalar unit shape.
-- All other objects/arrays use the exact existing 138 recursion; complete guard body is untouched.
CREATE OR REPLACE FUNCTION astr_canonical_json(value JSONB) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE output TEXT;
BEGIN
  CASE jsonb_typeof(value)
  WHEN 'object' THEN
    IF value ?& ARRAY['attendanceRoleCode','definitionHash','evaluatorVersion','mode','participationIdentityId','policyId','policyVersionId','sessionId','timeCategoryCode']::TEXT[]
      AND value - ARRAY['attendanceRoleCode','definitionHash','evaluatorVersion','mode','participationIdentityId','policyId','policyVersionId','sessionId','timeCategoryCode']::TEXT[] = '{}'::JSONB
      AND NOT jsonb_path_exists(value,
        'strict $.* ? (@.type() == "object" || @.type() == "array")')
    THEN
      RETURN '{"attendanceRoleCode":' || (value->'attendanceRoleCode')::TEXT
        || ',"definitionHash":' || (value->'definitionHash')::TEXT
        || ',"evaluatorVersion":' || (value->'evaluatorVersion')::TEXT
        || ',"mode":' || (value->'mode')::TEXT
        || ',"participationIdentityId":' || (value->'participationIdentityId')::TEXT
        || ',"policyId":' || (value->'policyId')::TEXT
        || ',"policyVersionId":' || (value->'policyVersionId')::TEXT
        || ',"sessionId":' || (value->'sessionId')::TEXT
        || ',"timeCategoryCode":' || (value->'timeCategoryCode')::TEXT || '}';
    END IF;
    SELECT '{' || coalesce(string_agg(to_jsonb(key)::TEXT || ':' ||
      CASE WHEN jsonb_typeof(item) IN ('object','array')
        THEN astr_canonical_json(item) ELSE item::TEXT END, ','
      ORDER BY key COLLATE "C"), '') || '}'
      INTO output FROM jsonb_each(value) AS x(key, item);
  WHEN 'array' THEN
    SELECT '[' || coalesce(string_agg(
      CASE WHEN jsonb_typeof(item) IN ('object','array')
        THEN astr_canonical_json(item) ELSE item::TEXT END,
      ',' ORDER BY ordinal), '') || ']'
      INTO output FROM jsonb_array_elements(value) WITH ORDINALITY AS x(item, ordinal);
  ELSE output := value::TEXT;
  END CASE;
  RETURN output;
END;
$$;
