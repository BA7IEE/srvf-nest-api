const { chromium } = require('./playwright-core');
const { strict: assert } = require('node:assert');
const fs = require('node:fs');
const base = 'http://localhost:8080';
const password = fs.readFileSync('/fixture/password','utf8').trim();
const metric = process.env.METRIC || 'not_required';
const title = 'T36 '+metric;
function record(actor, path, status, body, requestId) {
  console.log(JSON.stringify({actor,path,status,code:body.code,reqId:requestId||body.requestId}));
}
async function login(browser, user) {
  const ctx=await browser.newContext();
  const p=await ctx.newPage();
  p.setDefaultTimeout(9000);
  p.on('response',async r=>{
    const path=new URL(r.url()).pathname;
    if (!path.startsWith('/api/')) return;
    try { record(user,path,r.status(),await r.json(),r.headers()['x-request-id']); } catch {}
  });
  await p.goto(base);
  await p.getByPlaceholder('账号').fill(user);
  await p.locator('input[type=password]').fill(password);
  await Promise.all([p.waitForURL(u=>!u.hash.startsWith('#/login')),p.getByRole('button',{name:/登.*录/}).click()]);
  return p;
}
async function observe(p,suffix,click,expected){
  const [res]=await Promise.all([p.waitForResponse(r=>r.request().method()==='POST' && new URL(r.url()).pathname.endsWith(suffix),{timeout:12000}),click()]);
  const body=await res.json();
  assert.equal(res.status(),expected);
  assert.equal(body.code,0);
  return body.data;
}
async function apiSession(user){
  const r=await fetch(base+'/api/auth/v1/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:user,password})});
  const b=await r.json();assert.equal(b.code,0);
  return async(path,input,status,code) => {
    const r2=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+b.data.accessToken},body:JSON.stringify(input)});
    const val=await r2.json();record(user,path,r2.status,val,r2.headers.get('x-request-id'));assert.equal(r2.status,status);assert.equal(val.code,code);return val.data;
  };
}
(async()=>{
 const b=await chromium.launch({executablePath:'/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell'});
 try{
  const p=await login(b,'lab');
  await p.goto(base+'/#/srvf/activities-domain/activities');
  await p.getByRole('button',{name:'筹备单场次活动'}).click();
  const item=t=>p.locator('.el-form-item').filter({has:p.locator('label',{hasText:t})});
  const choose=async(t,name)=>{await item(t).locator('.el-select').click();await p.getByRole('option',{name}).first().click()};
  await choose('承办组织',/Lab team/);
  await choose('活动模板版本',metric==='required'?/T36 指标/:/T34 单场次/);
  for(const [label,value] of [['活动标题',title],['开始时间','2026-12-01 09:00'],['结束时间','2026-12-01 11:00'],['活动地点','T36 场地']]){
    const i=item(label).locator('input').first();await i.fill(value);await i.press('Tab');
  }
  await choose('地点对谁可见','录取后可见');
  const result=await observe(p,'/from-template',()=>p.getByRole('button',{name:'创建草稿并核对场次'}).click(),201);
  const id=result.activityId;assert(id);
  const call=await apiSession('lab');
  await call('/api/admin/v1/activities/'+id+'/publish-reviews',{operationKey:'t36-stale-'+id,confirmation:true,expectedDraftHash:'0'.repeat(64)},409,20255);
  await p.getByRole('button',{name:'核对并提交审核'}).click();
  await p.locator('label.el-checkbox').filter({hasText:'我已核对'}).click();
  const [res]=await Promise.all([p.waitForResponse(r=>r.request().method()==='POST' && r.url().endsWith('/publish-reviews')),p.getByRole('button',{name:'确认提交发布审核'}).click()]);
  assert.match(res.request().postDataJSON().expectedDraftHash,/^[a-f0-9]{64}$/);const pending=await res.json();assert.equal(res.status(),200);assert.equal(pending.data.status,'pending');
  console.log('PASS confirmed version',id,pending.data.id);
  const second=await login(b,'reviewer');
  await second.goto(base+'/#/srvf/workbench/publish-reviews/'+pending.data.id);
  const approve=second.getByRole('button',{name:'通过并发布',exact:true});
  await approve.waitFor();
  if(!await approve.isEnabled()){
    const issues=await second.locator('.el-alert').allTextContents();
    console.log('approval blocked',issues.map(t=>t.replace(/\s+/g,' ').slice(0,220)));
  }
  await approve.click();
  await second.locator('label.el-checkbox').filter({hasText:'我已核对'}).click();
  const approved=await observe(second,'/approve',()=>second.getByRole('button',{name:'确认通过并发布',exact:true}).click(),200);assert.equal(approved.status,'approved');
  const path='/api/app/v1/my/managed-activities/'+id+'/submit-change-review';
  const other=await apiSession('reviewer');
  await other(path,{activity:{title:title+' 变更'}},403,30100);
  const change=await call(path,{activity:{title:title+' 变更'}},200,0);
  assert.equal(change.requestType,'change');assert.equal(change.status,'pending');console.log('PASS change pending',change.id);
 }finally{await b.close();}
})().catch(e=>{console.log(e.name,String(e.message).slice(0,350));process.exitCode=1});
