const {chromium}=require('playwright-core'),fs=require('fs'),assert=require('node:assert/strict');
const url='https://h5.srvf.test/';let b,step='start';
async function login(p,u,f){
 await p.locator('input[name=account]').fill(u);
 await p.locator('input[name=password]').fill(fs.readFileSync('/fixture/'+f,'utf8').trim());
 await Promise.all([p.waitForURL('**/#/activities'),p.getByRole('button',{name:'登录',exact:true}).click()]);
}
(async()=>{
 b=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE});
 const c=await b.newContext(),a=await c.newPage(),second=await c.newPage();
 await a.goto(url);await login(a,'t47-member','member');
 step='concurrent restoration';
 const pages=[a,second];const waits=pages.map(p=>p.waitForResponse(r=>r.url().endsWith('/h5/refresh')));
 await Promise.all([a.reload(),second.goto(url+'#/activities')]);
 const rr=await Promise.all(waits);assert(rr.every(r=>r.status()===200));
 await Promise.all(pages.map(p=>p.getByRole('heading',{name:'一起行动'}).first().waitFor()));
 console.log(JSON.stringify({step,results:rr.map(r=>({status:r.status(),reqId:r.headers()['x-request-id']}))}));
 step='other tab logout';await second.goto(url+'#/my');await second.getByRole('button',{name:/退出/}).first().click();await second.locator('.van-dialog__confirm').click();
 await Promise.all(pages.map(p=>p.waitForURL('**/login**')));
 step='switch ordinary account';await login(second,'lab','password');
 assert(a.url().includes('/login'));
 const own=second.waitForResponse(r=>r.url().includes('/api/app/v1/my/registrations'));
 await second.goto(url+'#/my/activities');const r=await own,j=await r.json();assert.equal(r.status(),200);assert.equal(j.data.total,0);
 console.log(JSON.stringify({step,oldTab:'login',newAccountRows:j.data.total,code:j.code,reqId:r.headers()['x-request-id'],exit:0}));
})().catch(e=>{console.log(JSON.stringify({step,error:e.name,exit:1,reason:String(e.message).split('\n')[0].slice(0,90)}));process.exitCode=1}).finally(()=>b?.close());
