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
 dbname="app_test"
 def sql(query):
  return cmd(['docker','exec','-i',cid,'psql','-XAtq','-v','ON_ERROR_STOP=1','-U','postgres','-d',dbname],input=query)
 for _ in range(40):
  if sp.run(['docker','exec',cid,'pg_isready','-h','127.0.0.1'],stdout=sp.DEVNULL).returncode==0:break
  time.sleep(.3)
 sql(pathlib.Path('test/fixtures/r5-ci-sealed-roles.sql').read_text())
 cmd(['pnpm','exec','prisma','migrate','deploy'])
 sql('CREATE DATABASE srvf_staging TEMPLATE app_test')
 dbname='srvf_staging'
 url=url.rsplit('/',1)[0]+'/'+dbname
 env.update(LAB_OWNER=url)
 sql(f"CREATE ROLE srvf_dp_acceptance_runtime LOGIN PASSWORD '{pw}'")
 def quote(s):return '"'+s.replace('"','""')+'"'
 grants=[]
 for t,priv,full,cols in map(json.loads,(p/'acl.jsonl').read_text().splitlines()):
  if full or cols:grants.append('GRANT '+priv+('' if full else ' ('+','.join(map(quote,cols))+')')+' ON public.'+quote(t)+' TO srvf_dp_acceptance_runtime;')
 sql('\n'.join(grants))

 cluster=sql('SELECT system_identifier FROM pg_control_system()')
 env.update(CONTAINER=cid,EXPECTED_CLUSTER=cluster,REVOKER=str(p/'withdraw.py'))
 sql("\\set expected_cluster "+cluster+"\n"+(p/'grant.sql').read_text())
 env.update(DATABASE_URL=url.replace('://postgres:', '://srvf_dp_acceptance_runtime:'),ACTIVITY_V11_WORKFLOW_ENABLED='false',ACTIVITY_OS_CONTROL_PLANE_MODE='shadow',NODE_ENV='test')
 (p/'trace.sql').write_text('')
 proc=sp.run(['node','--env-file=.env.test','-r','ts-node/register/transpile-only','lab.ts'],env=env,capture_output=True,text=True)
 print((proc.stdout+proc.stderr).replace(pw,'[redacted]')[-3500:])
 if proc.returncode:raise SystemExit(proc.returncode)
finally:cmd(['docker','stop',cid])
