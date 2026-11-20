const {chromium}=require('playwright-core'),fs=require('node:fs'),assert=require('node:assert/strict');
const base='https://h5.srvf.test/', id=process.env.TRIAL_ACTIVITY, slot=process.env.TRIAL_SLOT, activity='/api/app/v1/activities/'+id;
const file=x=>fs.readFileSync('/fixture/'+x,'utf8').trim();
let stage='start',browser,issuer,credentialId;
function receipt(label,r,b){console.log(JSON.stringify({step:label,status:r.status(),code:b?.code??null,reqId:r.headers()['x-request-id']??null}));}
async function req(as,method,path,data){
 const r=await fetch(base.slice(0,-1)+path,{method,headers:{...(as?{Authorization:'Bearer '+as}:{}),...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});
 const svg=r.headers.get('content-type')?.includes('image/svg+xml');
 const b=svg?{code:0,data:await r.text()}:await r.json();
 console.log(JSON.stringify({step:stage,status:r.status,code:b.code,reqId:r.headers.get('x-request-id')}));
 assert.equal(b.code,0);return b.data;
}
async function login(ctx,user,pw){
 const p=await ctx.newPage();p.setDefaultTimeout(10000);
 p.on('response',async r=>{const u=new URL(r.url()); if(!u.pathname.startsWith('/api/')||r.status()<400)return;
 try{const body=await r.json();receipt(u.pathname.replace(/c[a-z0-9]{24}/g,':id'),r,body)}catch{} });
 await p.goto(base);await p.locator('input[name=account]').fill(user);await p.locator('input[name=password]').fill(pw);
 await Promise.all([p.waitForURL('**/#/activities'),p.getByRole('button',{name:'登录',exact:true}).click()]);
 return p;
}
async function check(ctx){
 await ctx.addInitScript(()=>{
  window.__webStorageCalls=0;
  for(const key of ['localStorage','sessionStorage'])Object.defineProperty(window,key,{get(){window.__webStorageCalls++;throw Error('H5 forbids Web Storage')}});
 });
}
async function detail(p,eligible){
 const read=p.waitForResponse(r=>r.url().endsWith('/registration-insurance'));
 await p.goto(base+'#/activities/'+id);
 const r=await read,j=await r.json();receipt('own insurance '+eligible,r,j);assert.equal(r.status(),200);assert.deepEqual(j.data,{required:true,eligible});
}
function signupAction(p){return p.getByRole('button',{name:'报名参加'}).or(p.getByRole('link',{name:'报名参加'}));}
(async()=>{
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE});
 const c=await browser.newContext({viewport:{width:390,height:844}});await check(c);
 stage='uncovered';const denied=await login(c,'reviewer',file('password'));await detail(denied,false);
 await denied.getByText('本人保险未覆盖本次活动',{exact:true}).waitFor();
 assert(await signupAction(denied).evaluate(el=>el.classList.contains('van-button--disabled')||el.disabled||el.getAttribute('aria-disabled')==='true'));
 await c.close();
 const ctx=await browser.newContext({viewport:{width:390,height:844}});await check(ctx);
 stage='member login';const p=await login(ctx,'t47-member',file('member'));
 stage='reload and rotate';const refresh=p.waitForResponse(r=>r.url().endsWith('/h5/refresh'));await p.reload();const r=await refresh;assert.equal(r.status(),200);console.log(JSON.stringify({step:stage,http:200,reqId:r.headers()['x-request-id']}));
 await p.getByRole('heading',{name:'一起行动'}).first().waitFor();
 assert(await p.evaluate(()=>!document.cookie.split(';').some(s=>s.trim().startsWith('__Host-srvf_h5_refresh='))));
 stage='insured member';await detail(p,true);
 stage='signup';await signupAction(p).click();const group=p.locator('#registration-sessions fieldset').first();
 await group.locator('input[type=checkbox]').first().check();
 const positions=group.locator('input[type=checkbox]');if(await positions.count()>1)await positions.nth(1).check();
 await p.getByRole('button',{name:'核对并提交报名'}).click();
 const write=p.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/registrations'));
 await p.locator('.van-dialog__confirm').click();const reg=await write;const regBody=await reg.json();receipt('registered',reg,regBody);assert.equal(reg.status(),201);assert.equal(regBody.code,0);
 await p.getByRole('heading',{name:'报名与场次结果'}).waitFor();
 stage='attendance navigation';await detail(p,true);
 await p.getByRole('link',{name:'查看本场次考勤'}).first().click();
 await p.getByText('本场次不要求定位，不申请定位权限。',{exact:true}).waitFor();
 stage='issuer login';issuer=(await req(null,'POST','/api/auth/v1/login',{username:'lab',password:file('password')})).accessToken;
 const managed='/api/app/v1/my/managed-activities/'+id;
 stage='issue actual session QR';const issued=await req(issuer,'POST',managed+'/sessions/'+slot+'/qr-credentials/check-in/issue',{operationKey:'t47-check-'+id});credentialId=issued.credentialId;
 stage='render';const svg=await req(issuer,'POST',managed+'/qr-credentials/'+credentialId+'/render');
 const imagePage=await browser.newPage();
 const png=await imagePage.evaluate(async s=>{
  const img=new Image();img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(s);await img.decode();
  const canvas=document.createElement('canvas');canvas.width=canvas.height=1024;
  const g=canvas.getContext('2d');g.fillStyle='white';g.fillRect(0,0,1024,1024);g.drawImage(img,32,32,960,960);
  return canvas.toDataURL('image/png').split(',')[1];
 },svg);await imagePage.close();
 const delay=Date.parse(issued.validFrom)-Date.now()+400;
 assert(delay<8*60000);if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));
 assert(Date.now()<Date.parse(issued.validUntil));stage='H5 image decoder and check-in';
 await p.locator('input[type=file]').setInputFiles({name:'check-in.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
 const punched=p.waitForResponse(r=>r.url().endsWith('/punches/check-in'));const state=p.waitForResponse(r=>r.url().endsWith('/my-punch-state'));
 await p.locator('.van-dialog__confirm').click();const punch=await punched;const pj=await punch.json();receipt('H5 self QR',punch,pj);assert.equal(punch.status(),201);assert.equal(pj.code,0);
 const sr=await state,sj=await sr.json();assert.equal(sj.data.isPresent,true);receipt('present readback',sr,sj);
 await p.getByRole('heading',{name:'签到已记录'}).waitFor();
 stage='second tab and logout';const tab=await ctx.newPage();await tab.goto(base);await tab.getByRole('heading',{name:'一起行动'}).first().waitFor();
 await p.goto(base+'#/my');await p.getByRole('button',{name:/退出/}).first().click();await p.locator('.van-dialog__confirm').click();
 await Promise.all([p.waitForURL('**/login**'),tab.waitForURL('**/login**')]);
 await tab.reload();await tab.locator('input[name=account]').waitFor();
 assert.equal(await p.evaluate(()=>window.__webStorageCalls),0);
 console.log(JSON.stringify({exit:0,zeroWebStorage:true,independentOriginTLS:true,crossTabLogout:true,imagePicker:true}));
})().catch(e=>{console.log(JSON.stringify({stage,exit:1,error:e.name,reason:String(e.message).split('\n').slice(0,3).join(' ').slice(0,200)}));process.exitCode=1}).finally(async()=>{
 if(credentialId){stage='retire QR';await req(issuer,'POST','/api/app/v1/my/managed-activities/'+id+'/qr-credentials/'+credentialId+'/revoke',{operationKey:'t47-retire-'+id,reason:'本次隔离验收结束'});}
 await browser?.close();
});
