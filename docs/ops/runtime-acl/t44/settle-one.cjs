const fs=require('fs'),assert=require('node:assert/strict');
(async()=>{
 const origin='http://probe:3000';const login=await fetch(origin+'/api/auth/v1/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'lab',password:fs.readFileSync('/fixture/password','utf8').trim()})});const b=await login.json();assert.equal(b.code,0);
 const resp=await fetch(origin+'/api/app/v1/my/managed-activities/'+process.env.ACTIVITY_ID+'/settlement',{headers:{Authorization:'Bearer '+b.data.accessToken}});const j=await resp.json();
 console.log(JSON.stringify({step:'diagnostic_workbench',status:resp.status,code:j.code,reqId:resp.headers.get('x-request-id')}));
 assert.equal(resp.status,500);assert.equal(j.code,50000);
})().catch(e=>{console.error(e.name);process.exitCode=1});
