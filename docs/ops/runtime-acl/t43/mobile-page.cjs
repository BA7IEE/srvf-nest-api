const {createServer}=require('node:http');
const path=require('node:path'),fs=require('node:fs');
const {chromium}=require('playwright-core');const assert=require('node:assert/strict');
async function run(){
 const server=createServer((req,res)=>{
  const u=new URL(req.url,'http://localhost').pathname;
  const f=path.resolve('/site','.'+(u==='/'?'/index.html':u));
  if(!f.startsWith('/site/')||!fs.existsSync(f)){res.writeHead(404).end();return}
  res.setHeader('Content-Type',({'.js':'application/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'})[path.extname(f)]||'application/octet-stream');fs.createReadStream(f).pipe(res);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE});
 try{
  const page=await browser.newPage(); let requests=0;
  page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/'))requests++});
  const u='http://127.0.0.1:'+server.address().port;
  await page.goto(u+'/#/activities/'+process.env.ACTIVITY_ID+'/register');
  await page.getByText('服务尚未接通',{exact:true}).waitFor({timeout:12000});
  assert(await page.getByText('当前为未接线版本。活动、保险、报名与考勤服务尚未开放。',{exact:true}).isVisible());
  assert.equal(requests,0);
  console.log(JSON.stringify({head:'ce14f84b5add85de11816136a0ef975a28ff7b7e',mode:JSON.parse(fs.readFileSync('/site/.source-stamp.json','utf8')).mode,observed:'服务尚未接通',route:new URL(page.url()).hash,api_requests:requests}));
 }finally{await browser.close();server.close();}
}
run().catch(e=>{console.error(e.name,e.message.slice(0,200));process.exitCode=1})
