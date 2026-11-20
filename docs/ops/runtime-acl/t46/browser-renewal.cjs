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
 console.log(JSON.stringify({step,path,method:r.request().method(),http:r.status(),code}));});}
 const a=await ctx.newPage();observe(a);
 step='login-page';await a.goto(base); await a.locator('input[name=account]').waitFor();
 step='ordinary-login';await a.locator('input[name=account]').fill('t46-final');await a.locator('input[name=password]').fill(pw);
 await a.getByRole('button',{name:'登录',exact:true}).click();await a.waitForURL('**/#/activities');
 async function authenticated(p){await p.getByRole('heading',{name:'一起行动',exact:true}).first().waitFor(); assert(await p.evaluate(()=>!document.cookie.split(';').some(c=>c.trim().startsWith('__Host-srvf_h5_refresh='))));}
 await authenticated(a);
 step='access-expiry';await require('node:timers/promises').setTimeout(62000);
 const renewal=a.waitForResponse(r=>r.url().endsWith('/h5/refresh'));await a.goto(base+'#/my');assert.equal((await renewal).status(),200);
 await a.goto(base+'#/activities');await authenticated(a);
 step='reload'; await a.reload();await authenticated(a);
 const b=await ctx.newPage();observe(b);step='two-tabs-restore';await Promise.all([a.reload(),b.goto(base+'#/activities')]);await Promise.all([authenticated(a),authenticated(b)]);
 step='member-pages';await a.goto(base+'#/my/activities');await a.getByRole('heading',{name:'我的活动',exact:true}).first().waitFor();
 step='logout';await a.goto(base+'#/my');await a.getByRole('button',{name:/退出/}).first().click();await a.locator('.van-dialog__confirm').click();await Promise.all([a.waitForURL('**/login**'),b.waitForURL('**/login**')]);
 await b.reload();await b.locator('input[name=account]').waitFor();
 console.log(JSON.stringify({step:'end',tls:'verified',crossTabLogout:true,realBrowser:'Chromium Linux',exit:0}));
})().catch(e=>{console.log(JSON.stringify({step,error:e.name,reason:String(e.message).match(/net::[A-Z_]+|Timeout [0-9]+ms|strict mode violation/)?.[0]??'unclassified',exit:1}));process.exitCode=1}).finally(async()=>{await browser?.close()});
