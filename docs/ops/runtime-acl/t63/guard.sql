BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
SELECT pg_advisory_xact_lock(63630063);
SELECT set_config('t63.expected_cluster', :'cid', true);
DO $guard$
BEGIN
  IF current_database() <> 't63_lab' OR session_user <> 'postgres' OR current_user <> session_user
     OR current_setting('server_version_num')::integer NOT BETWEEN 160000 AND 169999
     OR (SELECT system_identifier::text FROM pg_control_system()) <> current_setting('t63.expected_cluster')
     OR (SELECT count(*) FROM public._prisma_migrations) <> 158
     OR (SELECT encode(sha256(convert_to(string_agg(migration_name || ':' || checksum, E'\n' ORDER BY migration_name), 'UTF8')), 'hex')
         FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)
         IS DISTINCT FROM '603ca96edde3fa72226e9d2c1c17ae4b0c450eba9b6f9cf597bc6d817913d46b'
  THEN RAISE EXCEPTION 'Unexpected target or runtime migrations'; END IF;
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('t63_api','t63_worker')) <> 2
     OR EXISTS (
       SELECT FROM pg_roles r WHERE r.rolname IN ('t63_api','t63_worker') AND
         (NOT r.rolcanlogin OR r.rolsuper OR r.rolinherit OR r.rolreplication OR r.rolbypassrls
          OR r.rolcreaterole OR r.rolcreatedb OR EXISTS (SELECT FROM pg_auth_members WHERE member=r.oid)
          OR EXISTS (SELECT FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
          OR has_database_privilege(r.oid,current_database(),'CREATE,TEMPORARY')
          OR has_schema_privilege(r.oid,'public','CREATE') OR NOT has_schema_privilege(r.oid,'public','USAGE')
          OR NOT has_database_privilege(r.oid,current_database(),'CONNECT')
          OR has_function_privilege(r.oid,'public.r5_correction_phase_deferred_registered(text)','EXECUTE')))
  THEN RAISE EXCEPTION 'Unsafe role, ownership, membership or protected function'; END IF;
END
$guard$;
CREATE TEMP TABLE desired (role_name text, tbl text, op text, col text, PRIMARY KEY(role_name,tbl,op,col)) ON COMMIT DROP;
