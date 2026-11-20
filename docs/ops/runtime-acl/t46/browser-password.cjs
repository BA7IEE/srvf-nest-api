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

 const independent=await browser.newContext();
 const other=await independent.newPage();observe(other);
 async function login(page){
  await page.goto(base+'#/login');await page.locator('input[name=account]').fill('lab');
  await page.locator('input[name=password]').fill(pw);await page.getByRole('button',{name:'登录',exact:true}).click();await page.waitForURL('**/#/activities');
 }
 step='independent-families';await login(a);await login(other);
 step='change-password';await a.goto(base+'#/my');await a.getByRole('button',{name:'账户设置'}).click();
 const inputs=a.locator('form input[type=password]');const updated='T46a'+require('crypto').randomBytes(20).toString('hex');
 await inputs.nth(0).fill(pw);await inputs.nth(1).fill(updated);await inputs.nth(2).fill(updated);
 const ack=a.waitForResponse(r=>r.url().endsWith('/api/app/v1/me/password'));await a.getByRole('button',{name:'修改密码',exact:true}).click();
 assert.equal((await ack).status(),200);await a.waitForURL('**/login**');
 step='other-family-refresh-rejected';const rejected=other.waitForResponse(r=>r.url().endsWith('/h5/refresh'));
 await other.reload();const r=await rejected;assert.equal(r.status(),401);assert.equal((await r.json()).code,10007);
 await other.locator('input[name=account]').waitFor();
 console.log(JSON.stringify({step:'changed-password-revoked-independent-family',exit:0}));
})().catch(e=>{console.log(JSON.stringify({step,error:e.name,reason:String(e.message).match(/net::[A-Z_]+|Timeout [0-9]+ms|strict mode violation/)?.[0]??'unclassified',exit:1}));process.exitCode=1}).finally(async()=>{await browser?.close()});
