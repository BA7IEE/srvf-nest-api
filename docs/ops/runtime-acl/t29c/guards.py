import pathlib,json,re
p=pathlib.Path(__file__).resolve().parent
rows={(t,k):(full,cols) for t,k,full,cols in map(json.loads,(p/'acl.jsonl').read_text().splitlines())}
items=[]
for line in (p/'lab-grants.sql').read_text().splitlines():
 priv,cols,t=re.fullmatch(r'GRANT (\w+) \((.+)\) ON public\."(\w+)" TO lab_runtime;',line).groups()
 full,base=rows[t,priv]; assert not full
 items.append((t,priv,sorted(base),re.findall(r'"(\w+)"',cols)))
def arr(x):return 'ARRAY['+','.join("'"+v+"'" for v in sorted(x))+']::text[]'
for undo in (False,True):
 role='srvf_dp_acceptance_runtime'
 lines=[r'\set ON_ERROR_STOP on','BEGIN;',"""SET LOCAL lock_timeout='3s';
SET LOCAL search_path=pg_catalog,public;
SELECT set_config('srvf.expected_cluster', :'expected_cluster',true);
DO $$BEGIN IF current_database()<>'srvf_staging' OR (SELECT system_identifier::text FROM pg_control_system())<>current_setting('srvf.expected_cluster')
 OR to_regrole('srvf_dp_acceptance_runtime') IS NULL THEN RAISE EXCEPTION 'target mismatch'; END IF; END$$;"""]
 for t in sorted({i[0] for i in items}):lines.append(f'LOCK TABLE public."{t}" IN SHARE ROW EXCLUSIVE MODE;')
 for t,k,base,added in items:
  tb=f'public."{t}"'
  start=base+added if undo else base
  lines.append(f"""DO $$ BEGIN
 IF has_table_privilege('{role}','{tb}','{k}') OR ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid='{tb}'::regclass AND attnum>0 AND NOT attisdropped AND has_column_privilege('{role}',attrelid,attnum,'{k}') ORDER BY attname::text COLLATE "C") <> {arr(start)} THEN RAISE EXCEPTION 'baseline mismatch {t} {k}'; END IF;""")
  if undo:lines.append(f""" IF (SELECT count(*) FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attrelid='{tb}'::regclass AND a.attname=ANY({arr(added)}) AND x.grantee='{role}'::regrole AND x.grantor=current_user::regrole AND x.privilege_type='{k}' AND NOT x.is_grantable) <> {len(added)} THEN RAISE EXCEPTION 'grantor mismatch'; END IF;""")
  lines.append('END $$;')
  cols=','.join('"'+c+'"' for c in added)
  lines.append(f"{'REVOKE' if undo else 'GRANT'} {k} ({cols}) ON {tb} {'FROM' if undo else 'TO'} {role};")
 lines.append('COMMIT;')
 (p/('rollback.sql' if undo else 'grant.sql')).write_text('\n'.join(lines)+'\n')
