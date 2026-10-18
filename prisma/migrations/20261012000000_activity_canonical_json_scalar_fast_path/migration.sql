-- Preserve the existing signature, volatility, strictness, owner and ACL.
-- Scalar output is exactly the original ELSE branch; containers still recurse.
CREATE OR REPLACE FUNCTION astr_canonical_json(value JSONB) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE output TEXT;
BEGIN
  CASE jsonb_typeof(value)
  WHEN 'object' THEN
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
