// Isolated diagnostics only. Preserve the service's result and rethrow its original error.
const {RegistrationCommandService}=require("/app/dist/modules/activity-registrations/registration-command.service.js");
const orig=RegistrationCommandService.prototype.submitInTransaction;
RegistrationCommandService.prototype.submitInTransaction=async function(input){
 const id=input.auditMeta.requestId;
 if(!/^[a-zA-Z0-9_-]{1,50}$/.test(id)) throw new Error("invalid diagnostic request id");
 const [who]=await input.tx.$queryRaw`SELECT set_config('application_name',${"t43."+id},true) AS label, current_user AS role, pg_backend_pid() AS pid`;
 const log=(more)=>console.log("T43APP "+JSON.stringify({id,role:who.role,pid:who.pid,...more}));
 log({phase:"enter"});
 try{const out=await orig.call(this,input);log({phase:"returned"});return out;}
 catch(e){const raw=String(e?.meta?.message||e?.meta?.database_error||e?.message||""); const m=raw.match(/permission denied for table ([A-Za-z0-9_]+)/);
 log({phase:"exception",prisma:/^P\d{4}$/.test(e.code)?e.code:null,sqlstate:/^[A-Z\d]{5}$/.test(e?.meta?.code)?e.meta.code:null,table:m?m[1]:null});throw e;}
}
