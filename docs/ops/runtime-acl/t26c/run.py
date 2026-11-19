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
 for t,priv,full,cols in json.loads((p/'chain-acl.json').read_text()):
  if full or cols:grants.append('GRANT '+priv+('' if full else ' ('+','.join(map(quote,cols))+')')+' ON public.'+quote(t)+' TO lab_runtime;')
 sql('\n'.join(grants))
 ins=next(line for line in (p/'grant.sql').read_text().splitlines() if line.startswith('GRANT INSERT')).replace('srvf_dp_acceptance_runtime','lab_runtime')
 sel='GRANT SELECT ("id","activityId","memberId","status","responsibilityType","canManageRegistrations","canManageAttendance") ON public.activity_responsibility_assignments TO lab_runtime'
 env.update(DATABASE_URL=url.replace('://postgres:', '://lab_runtime:'),INS=ins,SEL=sel,UNSEL=sel.replace('GRANT','REVOKE').replace(' TO ',' FROM '),UNINS=ins.replace('GRANT','REVOKE').replace(' TO ',' FROM '),NODE_ENV='test')
 (p/'trace.sql').write_text('')
 proc=sp.run(['node','--env-file=.env.test','-r','ts-node/register/transpile-only','lab.ts'],env=env,capture_output=True,text=True)
 print((proc.stdout+proc.stderr).replace(pw,'[redacted]')[-3500:])
 if proc.returncode: raise SystemExit(proc.returncode)
 # On this disposable server use the exact target names to test both guarded artifacts.
 sql("CREATE ROLE srvf_dp_acceptance_runtime; CREATE DATABASE srvf_staging TEMPLATE app_test;")
 def checkfile(name,expected):
  q=(p/name).read_text()
  r=sp.run(['docker','exec','-i',cid,'psql','-Xq','-v','ON_ERROR_STOP=1','-U','postgres','-d','srvf_staging'],input=q,capture_output=True,text=True)
  print(name,r.returncode);assert r.returncode==expected
 checkfile('grant.sql',0);checkfile('grant.sql',3);checkfile('rollback.sql',0);checkfile('rollback.sql',3)
finally:cmd(['docker','stop',cid])
