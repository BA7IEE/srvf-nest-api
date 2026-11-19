const fs=require('node:fs'),assert=require('node:assert/strict');
const origin='http://127.0.0.1:8080', id=process.env.ACTIVITY_ID, expected=process.env.EXPECT;
assert(/^[a-z0-9]+$/.test(id));assert(['baseline','success','observe'].includes(expected));
async function req(path,access,arg){
 const r=await fetch(origin+path,{method:arg?'POST':'GET',headers:{...(arg?{'content-type':'application/json'}:{}),...(access?{Authorization:'Bearer '+access}:{})},body:arg?JSON.stringify(arg):undefined});
 const b=await r.json();return {status:r.status,code:b.code,data:b.data,reqId:r.headers.get('x-request-id')};
}
(async()=>{let failures=0;const sessions=new Map();
 for(const [step,actor,path] of [
 ['summary','t45-user-b','/api/app/v1/my/participation-summary'],
 ['workbench','lab','/api/app/v1/my/managed-activities/'+id+'/settlement'],
 ['workbench_denied','t45-user-b','/api/app/v1/my/managed-activities/'+id+'/settlement']]){
 if(!sessions.has(actor)){
   const credentials={username:actor,password:fs.readFileSync(actor==='lab'?'/fixture/password':'/ordinary/'+actor,'utf8').trim()};
   let login=await req('/api/auth/v1/login',null,credentials);
   if(login.status===429){console.log(JSON.stringify({step:'login_rate_limit',actor,code:login.code,delaySeconds:61}));await new Promise(r=>setTimeout(r,61000));login=await req('/api/auth/v1/login',null,credentials);}
   assert.equal(login.code,0);sessions.set(actor,login.data.accessToken);
 }
 const {status,code,data,reqId}=await req(path,sessions.get(actor));let matched=true;let projection={};
 if(code===0 && step==='summary'){
 projection={totalServiceHours:data.totalServiceHours,activityCount:data.activityCount,recordCount:data.recordCount,contributionPoints:data.contributionPoints,ledgerTotals:data.ledgerTotals};
 matched=data.totalServiceHours==='0'&&data.activityCount===0&&data.recordCount===0&&data.contributionPoints==='0'&&Object.keys(data.ledgerTotals).length===4&&Object.values(data.ledgerTotals).every(x=>x==='0')&&!('memberId' in data);
 }else if(code===0 && step==='workbench'){
 const gaps=data.gaps.map(x=>x.gapCode).sort(); projection={sameActivity:data.activityId===id,emptyRun:data.run===null,emptyClosure:data.closure===null,gaps};
 matched=projection.sameActivity&&projection.emptyRun&&projection.emptyClosure&&['draft_missing','evidence_seal_missing','settlement_run_missing'].every(x=>gaps.includes(x));
 }
 console.log(JSON.stringify({step,actor,status,code,reqId,projection}));if(!reqId||!matched)failures++;
 if(step==='workbench_denied'){if(status!==403||code!==30100) failures++}
 else if(expected==='success'&&(status!==200||code!==0))failures++;
 else if(expected==='baseline'&&(status!==500||code!==50000))failures++;
 }assert.equal(failures,0);})().catch(e=>{console.error(e.name);process.exitCode=1});
