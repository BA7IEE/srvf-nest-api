-- Canonical-byte preserving singleton array and small single-key object fast paths.
-- Multi-item/other objects, unit specialization, scalar output, signature, volatility, strictness and ACL stay unchanged.
CREATE OR REPLACE FUNCTION astr_canonical_json(value JSONB) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE output TEXT; singleton_element JSONB; singleton_entries JSONB; singleton_member JSONB;
BEGIN
  CASE jsonb_typeof(value)
  WHEN 'object' THEN
    IF pg_column_size(value) <= 256 THEN
      singleton_entries := jsonb_path_query_array(value, 'strict $.keyvalue()');
      IF jsonb_array_length(singleton_entries) = 1 THEN
        singleton_member := singleton_entries->0;
        singleton_element := singleton_member->'value';
        RETURN '{' || (singleton_member->'key')::TEXT || ':'
          || CASE WHEN jsonb_typeof(singleton_element) IN ('object','array')
            THEN astr_canonical_json(singleton_element) ELSE singleton_element::TEXT END || '}';
      END IF;
    END IF;
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
    IF jsonb_array_length(value) = 1 THEN
      singleton_element := value->0;
      RETURN '[' || CASE WHEN jsonb_typeof(singleton_element) IN ('object','array')
        THEN astr_canonical_json(singleton_element) ELSE singleton_element::TEXT END || ']';
    END IF;
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
