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

oid=sql("""select id from "Organization" where status='ACTIVE' and "deletedAt" is null and "parentId" is not null order by "sortOrder",id limit 1""")
assert re.fullmatch('[a-zA-Z0-9_-]{8,64}',oid)
auth=api('auth/v1/login',c);token=auth['accessToken']
import secrets,datetime
mark='t26_'+secrets.token_hex(6)
uid=link=a=None
try:
 m=api('admin/v1/members',{'memberNo':mark.replace('_','-'),'realName':'隔离测试成员','memberSinceDate':'2026-11-19','memberOriginCode':'manual','gradeCode':'level-1'},expected=201)
 mid=m['id'];base='admin/v1/members/'+mid
 creds={'username':mark,'password':'T8'+secrets.token_hex(24)}
 uid=api('admin/v1/users',{**creds,'role':'USER'},expected=201)['id']
 api(base+'/account/bind',{'userId':uid})
 link=api(base+'/memberships',{'organizationId':oid,'membershipType':'TEMPORARY','reason':'T26 隔离验收'},expected=201)['id']
 a=api('auth/v1/login',creds);token=a['accessToken']
 opts=api('app/v1/my/managed-activities/organization-options')
 assert any(o['organizationId']==oid and o['source']=='membership' for o in opts)
 print('ordinary_membership_scope_readback=true')
 start=datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=7)
 api('app/v1/my/managed-activities',{'organizationId':oid,'title':mark,'activityTypeCode':'training','allocationModeCode':'first_come','startAt':start.isoformat(),'endAt':(start+datetime.timedelta(hours=1)).isoformat(),'location':'隔离验收','isPublicRegistration':False},expected=201)
finally:
 if a:api('auth/v1/logout',{'refreshToken':a['refreshToken']})
 token=auth['accessToken']
 try:
  if link:api(base+'/memberships/'+link,method='DELETE')
 finally:
  if uid:api('admin/v1/users/'+uid+'/status',{'status':'DISABLED'},'PATCH')
  api('auth/v1/logout',{'refreshToken':auth['refreshToken']})
