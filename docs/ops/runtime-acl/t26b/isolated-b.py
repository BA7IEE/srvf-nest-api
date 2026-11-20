import os,secrets,subprocess,json,time,pathlib
def call(args,env=None,ok=True):
 p=subprocess.run(args,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 if ok and p.returncode:
  safe=(p.stderr+p.stdout)[-2200:].replace(globals().get('pw','x'),'[redacted]')
  print(safe); raise RuntimeError(f'{args[0:2]} exit {p.returncode}')
 return p.stdout.strip() if ok else p.returncode
base=pathlib.Path('/private/tmp/srvf-t15-workdir').read_text().strip();base=pathlib.Path(base);os.chdir(base/'review')
pw=secrets.token_hex(32);env=dict(os.environ,POSTGRES_PASSWORD=pw,XDG_CACHE_HOME=str(base/'cache'))
cid=call(['docker','run','-d','--rm','--tmpfs','/var/lib/postgresql/data','-p','127.0.0.1::5432','-e','POSTGRES_PASSWORD','-e','POSTGRES_DB=app_test','postgres:16-alpine'],env)
try:
 port=call(['docker','port',cid,'5432/tcp']).rsplit(':',1)[1]
 env.update(DATABASE_URL='postgresql://postgres:'+pw+'@127.0.0.1:'+port+'/app_test',APP_ENV='test',SUPER_ADMIN_USERNAME='accept_local_check',SUPER_ADMIN_PASSWORD=secrets.token_hex(24))
 for i in range(40):
  if call(['docker','exec',cid,'pg_isready','-h','127.0.0.1'],ok=False)==0:break
  time.sleep(.5)
 subprocess.run(['docker','exec','-i',cid,'psql','-v','ON_ERROR_STOP=1','-U','postgres','-d','app_test'],input=pathlib.Path('test/fixtures/r5-ci-sealed-roles.sql').read_bytes(),stdout=subprocess.DEVNULL,check=True)
 call(['pnpm','exec','prisma','migrate','deploy'],env)
 def sql(q):return call(['docker','exec',cid,'psql','-U','postgres','-d','app_test','-XAtqc',q])



 import re
 pack=pathlib.Path(__file__).parent
 line=(pack/'sql-b.log').read_text().splitlines()[1]
 cols=re.findall(r'"(\w+)"',line)[2:]
 assert len(cols)==26 and len(set(cols))==26
 quoted=','.join('"'+c+'"' for c in cols)
 # Same deployed column types, defaults and nullability. The fixture excludes foreign keys.
 sql('CREATE SCHEMA lab')
 sql('CREATE TABLE lab."Activity" (LIKE public."Activity" INCLUDING DEFAULTS)')
 sql('CREATE ROLE fixture_runtime')
 sql('GRANT USAGE ON SCHEMA lab TO fixture_runtime')
 sql('GRANT SELECT ("id") ON lab."Activity" TO fixture_runtime')
 targets={'isPublicRegistration','requiresInsurance','defaultLocationRequired'}
 values=[]
 for c in cols:
  if c in targets:v='false'
  elif c in ('createdAt','updatedAt','startAt','endAt'):v='now()'
  elif c.endswith('Revision') or c=='archiveWaitingDays':v='0'
  elif c in ('galleryImageKeys','galleryAttachmentIds'):v="ARRAY[]::text[]"
  else:v="'fixture'"
  values.append(v)
 def run(stmt,expected):
  r=subprocess.run(['docker','exec',cid,'psql','-v','ON_ERROR_STOP=1','-U','postgres','-d','app_test','-XAtqc','SET ROLE fixture_runtime; '+stmt],capture_output=True,text=True)
  print('exit',r.returncode,'expected',expected,'permission_denied', 'permission denied' in r.stderr,flush=True)
  if expected:assert 'permission denied' in r.stderr
  assert (r.returncode==0)==(expected==0),r.stderr[:400]
 stmt='INSERT INTO lab."Activity" ('+quoted+') VALUES ('+','.join(values)+') RETURNING id'
 run(stmt,1)
 sql('GRANT INSERT ('+quoted+') ON lab."Activity" TO fixture_runtime')
 run(stmt,0)
 assert sql("""SELECT count(*) FROM lab."Activity" WHERE id='fixture'""")=='1'
 run("""UPDATE lab."Activity" SET title='x'""",1)
 sql('REVOKE INSERT ('+quoted+') ON lab."Activity" FROM fixture_runtime')
 run(stmt,1)
 print('retained_rows',sql('SELECT count(*) FROM lab."Activity"'))
finally:call(['docker','stop',cid])
