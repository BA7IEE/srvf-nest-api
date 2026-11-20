"""Optional depth-write guard for a T43-compatible isolated trial."""
import argparse
import os
import re
import subprocess
from pathlib import Path

ROLE = 'srvf_dp_acceptance_runtime'
TABLE = 'public.organization_closure'
FN = 'public.srvf_trial_reject_closure_update'
TRIGGER = 'srvf_trial_closure_update_guard'
BODY = f"""BEGIN
  IF current_user = '{ROLE}' OR
     (NOT (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user)
      AND pg_catalog.pg_has_role(current_user, '{ROLE}', 'USAGE')) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'trial registration role cannot update organization closure';
  END IF;
  RETURN NULL;
END"""

def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('action', choices=('install','verify','withdraw'))
    cli.add_argument('--expected-cluster',required=True)
    args=cli.parse_args()
    root=Path.cwd().resolve()
    if root.parent!=Path('/var/tmp') or not re.fullmatch(r'srvf-t[0-9]+\.[A-Za-z0-9]{8}',root.name):
        raise SystemExit('expected a disposable server trial directory')
    name=root.name.replace('.','-')
    if (root/'name').read_text().strip()!=name:
        raise SystemExit('unexpected stack identity')
    subprocess.run(['python3','assemble.py','check','--expected-cluster',args.expected_cluster],check=True)
    cluster=args.expected_cluster
    if not re.fullmatch('[0-9]{1,20}',cluster): raise SystemExit('invalid cluster')
    common=f"""
IF current_database()<>'srvf_staging' OR (SELECT system_identifier::text FROM pg_control_system())<>'{cluster}' THEN RAISE EXCEPTION 'wrong trial'; END IF;
IF has_schema_privilege('{ROLE}','public','CREATE') OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname='{ROLE}' AND (rolcreaterole OR rolsuper)) THEN RAISE EXCEPTION 'unexpected runtime authority'; END IF;
"""
    verify=f"""
IF NOT EXISTS (
  SELECT FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
  WHERE t.tgrelid='{TABLE}'::regclass AND t.tgname='{TRIGGER}' AND t.tgtype=18
    AND t.tgenabled='A' AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgnargs=0
    AND p.oid=pg_catalog.to_regprocedure('{FN}()') AND NOT p.prosecdef
    AND p.proowner=(SELECT relowner FROM pg_class WHERE oid='{TABLE}'::regclass)
    AND p.prosrc=$expected${BODY}$expected$ AND p.proconfig=ARRAY['search_path=pg_catalog']
) THEN RAISE EXCEPTION 'guard changed or missing'; END IF;
"""
    absent=f"""pg_catalog.to_regprocedure('{FN}()') IS NULL AND NOT EXISTS
 (SELECT FROM pg_trigger WHERE tgrelid='{TABLE}'::regclass AND tgname='{TRIGGER}')"""
    no_update=f"""IF has_any_column_privilege('{ROLE}','{TABLE}','UPDATE') THEN RAISE EXCEPTION 'withdraw registration ACL first'; END IF;"""
    if args.action=='install':
        work=f"""IF {absent} THEN
 {no_update}
 EXECUTE $ddl$CREATE FUNCTION {FN}() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $body${BODY}$body$$ddl$;
 EXECUTE 'REVOKE ALL ON FUNCTION {FN}() FROM PUBLIC';
 EXECUTE 'CREATE TRIGGER {TRIGGER} BEFORE UPDATE ON {TABLE} FOR EACH STATEMENT EXECUTE FUNCTION {FN}()';
 EXECUTE 'ALTER TABLE {TABLE} ENABLE ALWAYS TRIGGER {TRIGGER}';
 END IF; {verify}"""
    elif args.action=='verify':work=verify
    else:
        work=f"""{no_update} IF NOT ({absent}) THEN {verify}
 EXECUTE 'DROP TRIGGER {TRIGGER} ON {TABLE}'; EXECUTE 'DROP FUNCTION {FN}()'; END IF;"""
    sql=f"BEGIN; SET LOCAL lock_timeout='4s'; LOCK TABLE {TABLE} IN ACCESS EXCLUSIVE MODE; DO $check$ BEGIN {common} {work} END $check$; COMMIT;"
    subprocess.run(['docker','exec','-i',name+'-pg','psql','-XqAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','srvf_staging'],input=sql,text=True,check=True)
    print('closure write guard',args.action,'OK')
if __name__=='__main__':
    os.umask(0o077)
    main()
