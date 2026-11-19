import pathlib,os,re,json,secrets,subprocess as sp,time
p=pathlib.Path(__file__).resolve().parent
r=pathlib.Path((p/'srcpath').read_text().strip())
os.chdir(r)
(r/'lab.ts').write_bytes((p/'lab.ts').read_bytes())
pw=secrets.token_hex(32);env=dict(os.environ,POSTGRES_PASSWORD=pw)
def cmd(args,**kw):return sp.check_output(args,env=env,text=True,**kw).strip()
cid=cmd(['docker','run','-d','--rm','--tmpfs','/var/lib/postgresql/data','-p','127.0.0.1::5432','-e','POSTGRES_PASSWORD','-e','POSTGRES_DB=app_test','postgres:16-alpine'])
try:
 port=cmd(['docker','port',cid,'5432/tcp']).rsplit(':',1)[1]
 url=f'postgresql://postgres:{pw}@127.0.0.1:{port}/app_test'
 env.update(DATABASE_URL=url,LAB_OWNER=url,APP_ENV='test',ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED='true',TRACE=str(p/'trace.sql'))
 def sql(query):
  return cmd(['docker','exec','-i',cid,'psql','-XAtq','-v','ON_ERROR_STOP=1','-U','postgres','-d','app_test'],input=query)
 for _ in range(40):
  if sp.run(['docker','exec',cid,'pg_isready','-h','127.0.0.1'],stdout=sp.DEVNULL).returncode==0:break
  time.sleep(.3)
 sql(pathlib.Path('test/fixtures/r5-ci-sealed-roles.sql').read_text())
 cmd(['pnpm','exec','prisma','migrate','deploy'])
 sql(f"CREATE ROLE lab_runtime LOGIN PASSWORD '{pw}'")
 def quote(s):return '"'+s.replace('"','""')+'"'
 grants=[]
 for t,priv,full,cols in map(json.loads,(p/'acl.jsonl').read_text().splitlines()):
  if full or cols:grants.append('GRANT '+priv+('' if full else ' ('+','.join(map(quote,cols))+')')+' ON public.'+quote(t)+' TO lab_runtime;')
 sql('\n'.join(grants))

 for stmt in (p/'lab-grants.sql').read_text().splitlines():
  if stmt.strip():sql(stmt)

 cluster=sql('select system_identifier from pg_control_system()')
 script=(p/'reconcile.sql').read_text()
 def apply(op='apply',expected=0,db='app_test'):
  args=['docker','exec','-i',cid,'psql','-XqAt','-U','postgres','-d','app_test','-v','target_db='+db,'-v','cluster_id='+cluster,'-v','operation='+op]
  proc=sp.run(args,input=script,text=True,capture_output=True)
  print(op,db,'exit',proc.returncode,flush=True)
  assert proc.returncode==expected,proc.stderr[-1200:]
 apply(expected=3,db='wrong')
 sql("BEGIN; UPDATE _prisma_migrations SET checksum='test' WHERE migration_name=(SELECT min(migration_name) FROM _prisma_migrations); COMMIT;")
 apply(expected=3)
 manifest=sorted(pathlib.Path('prisma/migrations').glob('*/migration.sql'))[0]
 import hashlib
 sql("UPDATE _prisma_migrations SET checksum='%s' WHERE migration_name='%s'"%(hashlib.sha256(manifest.read_bytes()).hexdigest(),manifest.parent.name))
 sql("CREATE FUNCTION reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$; CREATE TRIGGER reject_receipt BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_receipt();")
 apply(expected=3)
 assert sql('select count(*) from role_permissions')=='0' and sql('select count(*) from permissions')=='0'
 sql('drop trigger reject_receipt on audit_logs')
 apply('preview')
 assert sql('select count(*) from permissions')=='0' and sql('select count(*) from roles')=='0'
 from concurrent.futures import ThreadPoolExecutor
 with ThreadPoolExecutor(2) as ex:list(ex.map(lambda _:apply(),range(2)))
 assert sql('select count(*) from role_permissions')=='3' and sql('select count(*) from audit_logs')=='3'
 assert sql('select count(*) from role_bindings')=='0'
 sql("update roles set description='conflict' where code='activity-owner'")
 apply(expected=3)
 sql("update roles set description='由 ActivityResponsibilityGrantProjector 按活动责任自动投影；禁止通用角色接口人工维护。' where code='activity-owner'")
 apply('withdraw')
 assert sql('select count(*) from role_permissions')=='0' and sql('select count(*) from permissions')=='3'
 apply()
 print('PASS retained catalog, restored partial mapping, preserved audit; zero automatic holders')
 env.update(DATABASE_URL=url.replace('://postgres:', '://lab_runtime:'),ACTIVITY_V11_WORKFLOW_ENABLED='false',NODE_ENV='test')
 (p/'trace.sql').write_text('')
 proc=sp.run(['node','--env-file=.env.test','-r','ts-node/register/transpile-only','lab.ts'],env=env,capture_output=True,text=True)
 print((proc.stdout+proc.stderr).replace(pw,'[redacted]')[-3500:])
 if proc.returncode:raise SystemExit(proc.returncode)
 count=sql('select count(*) from role_bindings')
 apply('withdraw',expected=3)
 assert sql('select count(*) from role_permissions')=='3' and sql('select count(*) from role_bindings')==count
 print('PASS withdrawal refused with existing reviewer binding; all three mappings intact')

finally:cmd(['docker','stop',cid])
