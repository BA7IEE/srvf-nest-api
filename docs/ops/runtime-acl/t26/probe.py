import urllib.request as u, urllib.error as e, json, pathlib, subprocess as sp,re
c=json.loads(pathlib.Path('/var/tmp/srvf-t16-fixtures/account.json').read_text());token=None
class NoRedirect(u.HTTPRedirectHandler):
 def redirect_request(self,*a):return None
client=u.build_opener(NoRedirect)
def api(path,data=None,method=None,expected=200,code=0):
 headers={'Content-Type':'application/json'}
 if token:headers['Authorization']='Bearer '+token
 try:r=client.open(u.Request('https://dp.srvf.team/api/'+path,headers=headers,method=method,data=None if data is None else json.dumps(data).encode()),timeout=15)
 except e.HTTPError as ex:r=ex
 body=json.load(r);print(json.dumps({'route':re.sub(r'/c[a-z0-9]{20,}', '/{id}',path),'http':r.status,'code':body.get('code')}),flush=True);assert r.status==expected and body['code']==code
 return body.get('data')



import secrets
def sql(q):
 r=sp.run(['docker','exec','-i','-u','postgres','srvf-dp-acceptance-pg-1','sh','-c','exec psql -XwAtq -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],input=q,text=True,capture_output=True)
 assert r.returncode==0
 return r.stdout.strip()

rev=sp.check_output(['docker','inspect','--format','{{index .Config.Labels "org.opencontainers.image.revision"}}','srvf-dp-acceptance-runtime-api-1'],text=True).strip()
if rev!='108feebb84b85c7e4955c5af8bbfc016702e4529':
 image=sp.check_output(['docker','inspect','--format','{{.Image}}','srvf-dp-acceptance-runtime-api-1'],text=True).strip()
 rev=sp.check_output(['docker','image','inspect','--format','{{index .Config.Labels "org.opencontainers.image.revision"}}',image],text=True).strip()
assert rev=='108feebb84b85c7e4955c5af8bbfc016702e4529'
print('revision',rev)
print('db',sql('select current_database()'))
print('org_total',sql('select count(*) from "Organization"'))
print('activity_total',sql('select count(*) from "Activity"'))
for table in ['Organization','Activity','organization_closure','member_organization_memberships','activity_publish_reviews']:
 print(table,sql("""select string_agg(p||'='||has_any_column_privilege('srvf_dp_acceptance_runtime','public."%s"',p),',') from unnest(array['SELECT','INSERT','UPDATE']) p"""%table))
auth=api('auth/v1/login',c);token=auth['accessToken']
try:
 for tc,tl,ts,ic,il,isort in [('node_type','组织节点类别',0,'group','组 / 工作组',8),('activity_type','活动类型',11,'training','训练',3)]:
  tid=sql("""select id from "DictType" where code='%s' and status='ACTIVE' and "deletedAt" is null"""%tc)
  if not tid:tid=api('system/v1/dict-types',{'code':tc,'label':tl,'sortOrder':ts},expected=201)['id']
  assert re.fullmatch('[a-zA-Z0-9_-]+',tid)
  q="""select count(*) from "DictItem" where "typeId"='%s' and code='%s' and status='ACTIVE' and "deletedAt" is null"""%(tid,ic)
  if sql(q)=='0':api('system/v1/dict-items',{'typeId':tid,'code':ic,'label':il,'sortOrder':isort},expected=201)
  assert sql(q)=='1'
  print('active_item',tc,ic)
finally:api('auth/v1/logout',{'refreshToken':auth['refreshToken']})
