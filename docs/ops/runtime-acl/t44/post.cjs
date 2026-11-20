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
 for (const actor of ['lab',member]) await req('settlement_workbench',actor,m+'/settlement');
 const list=await req('qr_before','lab',managed);
 assert.equal(list.data.length,1);
 const row=list.data[0];assert.equal(row.statusCode,'active');
 const retired=await http('lab','revoke_qr','POST',m+'/qr-credentials/'+row.credentialId+'/revoke',{operationKey:'t44-retire-'+id,reason:'Retire isolated T44 test credential'});
 assert.equal(retired.status,200);assert.equal(retired.code,0);assert.equal(retired.data.statusCode,'revoked');
 const after=await req('qr_after','lab',managed);
 assert.equal(after.data.length,1);assert.equal(after.data[0].statusCode,'revoked');
 console.log(JSON.stringify({step:'retire_assert',only_credential:'revoked'}));
}
act().catch(e=>{console.error(e.name,String(e.message).slice(0,100));process.exitCode=1});
