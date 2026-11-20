import pathlib,os,re,json,secrets,subprocess as sp,time
p=pathlib.Path(__file__).resolve().parent
import argparse,tempfile
cli=argparse.ArgumentParser()
cli.add_argument('--repo',type=pathlib.Path,required=True,help='checkout containing both pinned Git commits')
cli.add_argument('--dependencies',type=pathlib.Path,required=True,help='installed dependencies and matching generated Prisma Client')
cli.add_argument('--output',type=pathlib.Path,required=True,help='new local evidence directory')
args=cli.parse_args()
repo=args.repo.resolve()
output=args.output.resolve()
output.mkdir(mode=0o700,parents=True,exist_ok=False)
tmp=tempfile.TemporaryDirectory(prefix='srvf-trial-')
r=pathlib.Path(tmp.name)
source='108feebb84b85c7e4955c5af8bbfc016702e4529'
evidence='6371d8c55874277e1e47a544b2bffe501b495776'
def reference(name):
 return sp.check_output(['git','-C',str(repo),'show',f'{evidence}:docs/ops/runtime-acl/t29c/{name}'],text=True)
archive=r/'source.tar'
with archive.open('wb') as stream:
 sp.run(['git','-C',str(repo),'archive',source],stdout=stream,check=True)
sp.run(['tar','-xf',str(archive),'-C',str(r)],check=True)
(r/'node_modules').symlink_to(args.dependencies.resolve(strict=True),target_is_directory=True)
os.chdir(r)
(r/'lab.ts').write_bytes((p/'trial.ts').read_bytes())
pw=secrets.token_hex(32);env=dict(os.environ,POSTGRES_PASSWORD=pw)
def cmd(args,**kw):return sp.check_output(args,env=env,text=True,**kw).strip()
cid=cmd(['docker','run','-d','--rm','--tmpfs','/var/lib/postgresql/data','-p','127.0.0.1::5432','-e','POSTGRES_PASSWORD','-e','POSTGRES_DB=app_test','postgres:16-alpine'])
try:
 port=cmd(['docker','port',cid,'5432/tcp']).rsplit(':',1)[1]
 url=f'postgresql://postgres:{pw}@127.0.0.1:{port}/app_test'
 env.update(DATABASE_URL=url,LAB_OWNER=url,APP_ENV='test',ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED='true',TRACE=str(output/'trace.sql'))
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
 for t,priv,full,cols in map(json.loads,reference('acl.jsonl').splitlines()):
  if full or cols:grants.append('GRANT '+priv+('' if full else ' ('+','.join(map(quote,cols))+')')+' ON public.'+quote(t)+' TO srvf_dp_acceptance_runtime;')
 sql('\n'.join(grants))

 cluster=sql('SELECT system_identifier FROM pg_control_system()')
 env.pop('LAB_EXPECT_OFF', None)
 sql("\\set expected_cluster "+cluster+"\n"+reference('grant.sql'))
 env.update(DATABASE_URL=url.replace('://postgres:', '://srvf_dp_acceptance_runtime:'),ACTIVITY_V11_WORKFLOW_ENABLED='false',ACTIVITY_OS_CONTROL_PLANE_MODE='shadow',NODE_ENV='test')
 (output/'trace.sql').write_text('')
 proc=sp.run(['node','--env-file=.env.test','-r','ts-node/register/transpile-only','lab.ts'],env=env,capture_output=True,text=True)
 print((proc.stdout+proc.stderr).replace(pw,'[redacted]')[-3500:])
 if proc.returncode:raise SystemExit(proc.returncode)
 sql("\x5cset expected_cluster "+cluster+"\n"+reference('rollback.sql'))
 receipt=sql("SELECT coalesce(json_agg(a ORDER BY id)::text,'[]') FROM public.audit_logs a")
 (output/'isolated-audit.json').write_text(receipt)
 assert len(json.loads(receipt))>=5
 print('PASS exact DB permission withdrawal; synthetic audit exported before disposable volume retirement')
finally:
 cmd(['docker','stop',cid])
 tmp.cleanup()
