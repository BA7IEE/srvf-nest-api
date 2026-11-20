const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const id=process.env.ACTIVITY_ID;
assert(/^[a-z0-9]+$/.test(id));
const root='/api/app/v1', own=root+'/my/registrations', activity=root+'/activities/'+id, register=activity+'/registrations';
const identities=['t44-user-a','t44-user-b'];
const token=new Map();
async function send(actor,method,path,body,expected,code=0,label){
 const result=await fetch('http://127.0.0.1:8080'+path,{method,redirect:'error',headers:{...(token.has(actor)?{Authorization:'Bearer '+token.get(actor)}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const json=await result.json();
 console.log(JSON.stringify({label,actor,method,path,status:result.status,code:json.code,reqId:result.headers.get('x-request-id')}));
 assert.equal(result.status,expected,label+' http');assert.equal(json.code,code,label+' code');
 return json.data;
}
async function act(){
 for(const actor of identities){
  const data=await send(actor,'POST','/api/auth/v1/login',{username:actor,password:readFileSync('/ordinary/'+actor,'utf8').trim()},200,0,'login');
  assert.equal(typeof data.accessToken,'string');token.set(actor,data.accessToken);
 }
 const mode=process.env.MODE,items=[];
 for(const actor of identities){
  const detail=await send(actor,'GET',activity,null,200,0,'activity');
  assert.equal(detail.id,id);assert.equal(detail.title,'T44 定向考勤');
  const [s]=detail.sessions,[p]=s.positions;
  const body={operationKey:'t43-member-'+id+'-'+actor,formVersion:null,answers:[],preferences:[{sessionId:s.id,positionIds:[p.id]}]};
  if(mode==='enroll'){
   const receipt=await send(actor,'POST',register,body,201,0,'enroll');
   assert(receipt.registrationId&&receipt.registrationRevisionId&&receipt.submittedAt);
   const replay=await send(actor,'POST',register,body,201,0,'exact_replay');assert.deepEqual(replay,receipt);
   await send(actor,'POST',register,{...body,preferences:[]},409,21003,'changed_payload');
   items.push({receipt});
  }else items.push({});
  const list=await send(actor,'GET',own,null,200,0,'own_list');
  const rows=list.items.filter(x=>x.activityId===id);assert.equal(rows.length,1);
  const header=await send(actor,'GET',own+'/'+rows[0].id,null,200,0,'own_detail');
  assert.equal(header.id,rows[0].id);assert.equal(header.activityId,id);
  assert.equal(header.statusCode,'pass');
  if(items.at(-1).receipt)assert.equal(header.id,items.at(-1).receipt.registrationId);
  items.at(-1).id=header.id;
 }
 assert.notEqual(items[0].id,items[1].id);
 for(const [i,actor] of identities.entries()){
  const other=own+'/'+items[1-i].id;
  await send(actor,'GET',other,null,404,21001,'cross_read');
  if(mode==='cancel')await send(actor,'PATCH',other+'/cancel',{cancelReason:'T43 synthetic'},404,21001,'cross_cancel');
 }
 if(mode==='cancel'){
  const actor=identities[0],single=own+'/'+items[0].id;
  const result=await send(actor,'PATCH',single+'/cancel',{cancelReason:'T43 synthetic'},200,0,'self_cancel');
  assert.equal(result.statusCode,'cancelled');
  const d=await send(actor,'GET',single,null,200,0,'cancel_readback');assert.equal(d.statusCode,'cancelled');
  await send(actor,'PATCH',single+'/cancel',{cancelReason:'T43 synthetic'},409,21030,'repeat_cancel');
  const other=await send(identities[1],'GET',own+'/'+items[1].id,null,200,0,'peer_unchanged');assert.equal(other.statusCode,'pass');
 }
 console.log('PASS mode='+mode+' two ordinary subjects');
}
act().catch(e=>{console.error(e.name, String(e.message).slice(0,180));process.exitCode=1});
