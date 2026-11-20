const {chromium}=require('playwright-core');
const fs=require('node:fs');
const assert=require('node:assert/strict');
let step='start',browser;
(async()=>{
 const pw=fs.readFileSync('/fixture/password','utf8').trim();
 browser=await chromium.launch({executablePath:'/ms-playwright/chromium-1248/chrome-linux64/chrome'});
 const ctx=await browser.newContext({viewport:{width:390,height:844}});
 const base='https://h5.srvf.test/';
 function observe(page){page.on('response',async r=>{const u=new URL(r.url());if(!u.pathname.startsWith('/api/'))return;
 const path=u.pathname.replace(/\/c[a-z0-9]{20,}/g,'/:id');
 const code=await r.json().then(x=>Number.isInteger(x.code)?x.code:null).catch(()=>null);
 const rid=await r.headerValue('x-request-id');const meta={code,reqId:/^[a-zA-Z0-9_-]{8,80}$/.test(rid??'')?rid:null};
 console.log(JSON.stringify({step,path,method:r.request().method(),http:r.status(),...meta}));});}
 const a=await ctx.newPage();observe(a);
 step='login-page';await a.goto(base); await a.locator('input[name=account]').waitFor();
 step='ordinary-login';await a.locator('input[name=account]').fill('t46-final');await a.locator('input[name=password]').fill(pw);
 await a.getByRole('button',{name:'登录',exact:true}).click();await a.waitForURL('**/#/activities');
 async function authenticated(p){await p.getByRole('heading',{name:'一起行动',exact:true}).first().waitFor(); assert(await p.evaluate(()=>!document.cookie.split(';').some(c=>c.trim().startsWith('__Host-srvf_h5_refresh='))));}
 await authenticated(a);

 step='directory';await a.getByRole('heading',{name:'T46 H5 报名练习'}).click();
 step='activity-detail';await a.getByRole('button',{name:'报名参加'}).or(a.getByRole('link',{name:'报名参加'})).click();
 step='signup';await a.locator('#registration-sessions input[type=checkbox]').first().check();
 await a.getByRole('button',{name:'核对并提交报名'}).click();
 const write=a.waitForResponse(r=>r.request().method()==='POST' && r.url().endsWith('/registrations'));
 await a.locator('.van-dialog__confirm').click();const response=await write;assert.equal(response.status(),201);
 step='own-readback';await a.getByRole('heading',{name:'报名与场次结果'}).waitFor();
 await a.goto(base+'#/my/activities');await a.getByRole('heading',{name:'T46 H5 报名练习'}).waitFor();
 step='punch-state';const act=process.env.TRIAL_ACTIVITY, slot=process.env.TRIAL_SLOT;
 await a.goto(base+'#/activities/'+act+'/sessions/'+slot+'/attendance');
 await a.getByText('定位策略待确认',{exact:true}).waitFor();
 step='summary';await a.goto(base+'#/my/participation');await a.getByRole('heading',{name:'正式认定汇总'}).waitFor();
 console.log(JSON.stringify({step:'enrollment-and-summary-complete',exit:0}));
 const b=await ctx.newPage();observe(b);await b.goto(base+'#/activities');await authenticated(b);
 step='logout';await a.goto(base+'#/my');await a.getByRole('button',{name:/退出/}).first().click();await a.locator('.van-dialog__confirm').click();await Promise.all([a.waitForURL('**/login**'),b.waitForURL('**/login**')]);
 await b.reload();await b.locator('input[name=account]').waitFor();
 console.log(JSON.stringify({step:'end',tls:'verified',crossTabLogout:true,realBrowser:'Chromium Linux',exit:0}));
})().catch(e=>{console.log(JSON.stringify({step,error:e.name,reason:String(e.message).match(/net::[A-Z_]+|Timeout [0-9]+ms|strict mode violation/)?.[0]??'unclassified',exit:1}));process.exitCode=1}).finally(async()=>{await browser?.close()});
