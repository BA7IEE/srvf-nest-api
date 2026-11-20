const assert=require('node:assert/strict');
(async()=>{
 const result=[];
 for(const [test,url,headers] of [
  ['http peer','http://api:3000/api/auth/v1/h5/logout',{Host:'h5.srvf.test',Origin:'https://h5.srvf.test'}],
  ['second origin','https://h5.srvf.test/api/auth/v1/h5/logout',{Origin:'https://admin.srvf.test'}],
  ['same-origin HTTPS','https://h5.srvf.test/api/auth/v1/h5/logout',{Origin:'https://h5.srvf.test'}],
 ]){
  const r=await fetch(url,{method:'POST',headers,redirect:'error'});const j=await r.json();
  result.push({test,http:r.status,code:j.code,requestId:r.headers.get('x-request-id'),noStore:r.headers.get('cache-control')==='no-store'});
 }
 console.log(JSON.stringify(result));assert.deepEqual(result.map(x=>[x.http,x.code]),[[403,40300],[403,40300],[200,0]]);
})().catch(e=>{console.log(e.name);process.exitCode=1});
