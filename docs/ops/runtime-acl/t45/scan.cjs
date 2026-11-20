const {chromium}=require('playwright-core');
const fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const origin='http://127.0.0.1:8080', id=process.env.ACTIVITY_ID, mode=process.env.PUNCH_ACTION;
assert(['check-in','check-out'].includes(mode));
async function run(){
 const actor='t45-user-b',tokens=new Map();
 async function req(as,step,method,path,body){
  const r=await fetch(origin+path,{method,headers:{...(tokens.has(as)?{Authorization:'Bearer '+tokens.get(as)}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const svg=r.headers.get('content-type')?.startsWith('image/svg+xml');
  const b=svg?{code:0,data:await r.text()}:await r.json();
  console.log(JSON.stringify({step,as,status:r.status,code:b.code,reqId:r.headers.get('x-request-id'),...(svg?{protected_no_store:r.headers.get('cache-control')?.includes('no-store')}:{})}));
  return {status:r.status,code:b.code,data:b.data};
 }
 for(const [as,file] of [['lab','/fixture/password'],[actor,'/ordinary/'+actor]]){
  const q=await req(as,'login','POST','/api/auth/v1/login',{username:as,password:fs.readFileSync(file,'utf8').trim()});assert.equal(q.code,0);tokens.set(as,q.data.accessToken);
 }
 const a='/api/app/v1/activities/'+id,m='/api/app/v1/my/managed-activities/'+id;
 const s=(await req(actor,'detail','GET',a)).data.sessions[0].id;
 const issued=await req('lab','issue','POST',m+'/sessions/'+s+'/qr-credentials/'+mode+'/issue',{operationKey:'t44-'+mode+'-'+id});
 assert.equal(issued.code,0);
 const svg=await req('lab','render','POST',m+'/qr-credentials/'+issued.data.credentialId+'/render');assert.equal(svg.code,0);
 const chrome=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE});
 try{
  const page=await chrome.newPage();
  await page.addScriptTag({path:'/trial/jsQR.js'});
  const milliseconds=Date.parse(issued.data.validFrom)-Date.now()+750;
  console.log(JSON.stringify({step:'real_clock',seconds_until_window:Math.ceil(milliseconds/1000),valid_until:issued.data.validUntil}));
  if(milliseconds>0&&milliseconds<480000)await new Promise(r=>setTimeout(r,milliseconds));
  if(Date.now()<Date.parse(issued.data.validFrom)||Date.now()>Date.parse(issued.data.validUntil))throw Error('outside actual credential window');
  const punchPath=a+'/sessions/'+s+'/punches/'+mode;
  await page.exposeFunction('consumeScannedCode',async scanned=>{
   const q=await req(actor,'self_'+mode,'POST',punchPath,{qrToken:scanned,eventKey:'t45-qr-'+id});
   if(q.code===0) console.log(JSON.stringify({step:'event',type:q.data.eventTypeCode,segment:q.data.segmentStatusCode,replayed:q.data.replayed}));
   return {status:q.status,code:q.code};
  });
  const decodeAndPunch=()=>page.evaluate(async rendered=>{
   const img=new Image();img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(rendered);await img.decode();
   const canvas=document.createElement('canvas');canvas.width=canvas.height=1024;
   const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,1024,1024);ctx.drawImage(img,32,32,960,960);
   const pixel=ctx.getImageData(0,0,1024,1024),found=window.jsQR(pixel.data,1024,1024); if(!found)throw Error('fixture QR unreadable');
   return window.consumeScannedCode(found.data);
  },svg.data);
  let result=await decodeAndPunch();
  if(result.status===500){
    console.log(JSON.stringify({step:'await_reviewed_trial_acl'}));
    const timeout=Math.min(Date.now()+9*60*1000,Date.parse(issued.data.validUntil));
    for(let attempt=1;attempt<=3&&result.status===500;attempt++){
      while(!fs.existsSync('/trial/grant-ready-'+attempt)&&Date.now()<timeout)await new Promise(r=>setTimeout(r,1000));
      if(!fs.existsSync('/trial/grant-ready-'+attempt))break;
      result=await decodeAndPunch();
    }
  }
  const state=await req(actor,'my_state','GET',a+'/sessions/'+s+'/my-punch-state');
  if(state.code===0)console.log(JSON.stringify({step:'state_after',isPresent:state.data.isPresent}));
  const revoke=await req('lab','revoke','POST',m+'/qr-credentials/'+issued.data.credentialId+'/revoke',{operationKey:'t45-retire-'+id,reason:'退役本次隔离签到二维码'});
  assert.equal(revoke.status,200);assert.equal(revoke.data.statusCode,'revoked');
  assert.equal(result.status,201,'expected actual punch');assert.equal(result.code,0);assert.equal(state.data.isPresent,mode==='check-in');
 }finally{await chrome.close();}
}
run().catch(e=>{console.error(e.name,e.message.slice(0,140));process.exitCode=1;});
