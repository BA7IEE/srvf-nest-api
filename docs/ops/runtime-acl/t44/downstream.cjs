const assert=require('node:assert/strict');
const fs=require('node:fs');
const id=process.env.ACTIVITY_ID, mode=process.env.MODE;
assert(/^[a-z0-9]+$/.test(id));
const a='/api/app/v1/activities/'+id;
const m='/api/app/v1/my/managed-activities/'+id;
const token=new Map();
async function http(actor,step,method,path,body){
 const resp=await fetch('http://127.0.0.1:8080'+path,{method,redirect:'error',headers:{...(body?{'Content-Type':'application/json'}:{}),...(token.has(actor)?{Authorization:'Bearer '+token.get(actor)}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const result=await resp.json();
 const safe={step,actor,status:resp.status,code:result.code,reqId:resp.headers.get('x-request-id')};
 if(step==='state'&&result.code===0)safe.isPresent=result.data.isPresent;
 if(step==='attendance_records'&&result.code===0)safe.items=result.data.items.length;
 if(step==='list_qr'&&result.code===0)safe.count=result.data.length;
 if(step==='issue'&&result.code===0){safe.version=result.data.credentialVersion;safe.state=result.data.statusCode;}
 console.log(JSON.stringify(safe));
 return {status:resp.status, ...result};
}
async function act(){
 for(const actor of ['lab','t44-user-b']){
  const secret=fs.readFileSync(actor==='lab'?'/fixture/password':'/ordinary/'+actor,'utf8').trim();
  const login=await http(actor,'login','POST','/api/auth/v1/login',{username:actor,password:secret});assert.equal(login.code,0);token.set(actor,login.data.accessToken);
 }
 const member='t44-user-b';
 const detail=await http(member,'activity','GET',a);
 assert.equal(detail.data.id,id);const sid=detail.data.sessions[0].id;
 const managed=m+'/sessions/'+sid+'/qr-credentials';
 const req=(step,actor,route)=>http(actor,step,'GET',route);
 await req('state',member,a+'/sessions/'+sid+'/my-punch-state');
 await req('attendance_records',member,'/api/app/v1/my/attendance-records');
 await req('participation_summary',member,'/api/app/v1/my/participation-summary');
 const no=await req('ordinary_qr',member,managed);assert.equal(no.status,403);assert.equal(no.code,30100);
 await req('list_qr','lab',managed);
 await http('lab','issue','POST',managed+'/check-in/issue',{operationKey:'t44-check-in-'+id});
 for(const actor of ['lab',member])await req('settlement',actor,m+'/time-settlement');
}
act().catch(e=>{console.error(e.name, String(e.message).slice(0,150));process.exitCode=1});
