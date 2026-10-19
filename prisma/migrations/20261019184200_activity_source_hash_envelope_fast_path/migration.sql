-- Preserve the original source document and current recursive canonical bytes.
-- Render only the function-owned fixed definition/domain envelope directly.
-- No data, ownership, privileges, guards, query predicates or budgets change.
CREATE OR REPLACE FUNCTION astr_source_set_hash(activity_id TEXT,draft_id TEXT)
RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(
    '{"definition":' || coalesce(
      astr_canonical_json(astr_source_set_document(activity_id,draft_id)), 'null'
    ) || ',"domain":"activity-time-settlement-sources-v1"}',
    'UTF8'
  )), 'hex');
$$;
