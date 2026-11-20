const fs=require('fs'),assert=require('node:assert/strict');
(async()=>{
 const origin='http://probe:3000';const login=await fetch(origin+'/api/auth/v1/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'t44-user-b',password:fs.readFileSync('/ordinary/t44-user-b','utf8').trim()})});const b=await login.json();assert.equal(b.code,0);
 const resp=await fetch(origin+'/api/app/v1/my/participation-summary',{headers:{Authorization:'Bearer '+b.data.accessToken}});const j=await resp.json();
 console.log(JSON.stringify({step:'diagnostic_summary',status:resp.status,code:j.code,reqId:resp.headers.get('x-request-id')}));
 assert.equal(resp.status,500);assert.equal(j.code,50000);
})().catch(e=>{console.error(e.name);process.exitCode=1});
