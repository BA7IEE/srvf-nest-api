-- Expand effective column rights including PUBLIC. Check separately for relation ACLs
-- so a table-wide privilege cannot silently satisfy an identical column projection.
CREATE TEMP VIEW actual AS
 SELECT r.rolname::text role_name,c.relname::text tbl,p.op,a.attname::text col
 FROM pg_roles r CROSS JOIN pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
 CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) p(op)
 WHERE r.rolname IN ('t63_api','t63_worker') AND c.relnamespace='public'::regnamespace
 AND c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped
 AND has_column_privilege(r.oid,c.oid,a.attnum,p.op);
CREATE FUNCTION pg_temp.validate_acl(mode text, after_change boolean) RETURNS void
LANGUAGE plpgsql AS $guard$
DECLARE exact_match boolean; empty_acl boolean;
BEGIN
  IF EXISTS (SELECT FROM pg_roles r CROSS JOIN pg_class c
      WHERE r.rolname IN ('t63_api','t63_worker') AND c.relnamespace='public'::regnamespace
        AND ((c.relkind IN ('r','p','v','m','f') AND has_table_privilege(r.oid,c.oid,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
          OR (c.relkind='S' AND has_sequence_privilege(r.oid,c.oid,'SELECT,USAGE,UPDATE'))))
     OR EXISTS (SELECT FROM actual a WHERE has_column_privilege(a.role_name,
         format('public.%I',a.tbl),a.col,a.op||' WITH GRANT OPTION'))
  THEN RAISE EXCEPTION 'Unexpected relation privilege, sequence privilege or grant option'; END IF;
  SELECT NOT EXISTS (TABLE actual EXCEPT TABLE desired) AND NOT EXISTS (TABLE desired EXCEPT TABLE actual),
         NOT EXISTS (TABLE actual) INTO exact_match,empty_acl;
  IF after_change OR mode='preflight' THEN
    IF (mode='rollback' AND NOT empty_acl) OR (mode<>'rollback' AND NOT exact_match)
    THEN RAISE EXCEPTION 'Effective column ACL does not match the required state'; END IF;
  ELSIF NOT (empty_acl OR exact_match) THEN
    RAISE EXCEPTION 'Partial or unrelated ACL already exists on these dedicated roles';
  END IF;
END
$guard$;
