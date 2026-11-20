-- Inputs: runtime_role, expected_database, contract (the shipped ledger-contract.json).
\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
WITH requested AS (
  SELECT item.key AS rel, col
  FROM jsonb_each(:'contract'::jsonb) item
  CROSS JOIN LATERAL jsonb_array_elements_text(item.value->'SELECT') AS fields(col)
), sampled AS (
  SELECT r.rel, r.col, c.oid AS relid, a.attnum,
         has_column_privilege(role.oid, c.oid, a.attnum, 'SELECT') AS effective,
         has_table_privilege(role.oid, c.oid, 'SELECT') AS full_table,
         pg_has_role(role.oid, c.relowner, 'USAGE') AS owns_or_inherits_owner,
         role.rolsuper OR role.rolbypassrls AS privileged_role,
         EXISTS (SELECT FROM aclexplode(a.attacl) g
                 WHERE g.grantee=role.oid AND g.privilege_type='SELECT') AS direct_column
  FROM requested r
  JOIN pg_roles role ON role.rolname=:'runtime_role'
  JOIN pg_class c ON c.relnamespace='public'::regnamespace AND c.relname=r.rel AND c.relkind IN ('r','p')
  JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname=r.col AND a.attnum>0 AND NOT a.attisdropped
), result AS (
  SELECT current_database()=:'expected_database' AND count(*)=15
         AND count(DISTINCT (relid,attnum))=15 AND bool_and(effective AND NOT owns_or_inherits_owner AND NOT privileged_role) AS ready,
         jsonb_build_object('database',current_database(),'role',:'runtime_role','column_count',count(*),
           'rows',coalesce(jsonb_agg(jsonb_build_object('table',rel,'column',col,'select',effective,
             'table_select',full_table,'direct_column_select',direct_column,'owner_access',owns_or_inherits_owner,
             'superuser_or_bypassrls',privileged_role) ORDER BY rel,col),'[]'::jsonb)) AS receipt
  FROM sampled
)
SELECT ready, receipt FROM result \gset
\echo :receipt
\if :ready
\else
DO $$ BEGIN RAISE EXCEPTION 'member ledger preflight failed: target, runtime identity, schema or SELECT projection'; END $$;
\endif
ROLLBACK;
