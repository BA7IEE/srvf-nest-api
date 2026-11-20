const {AllExceptionsFilter}=require('/app/dist/common/filters/all-exceptions.filter.js');
const orig=AllExceptionsFilter.prototype.catch;
AllExceptionsFilter.prototype.catch=function(error, host){
 const req=host.switchToHttp().getRequest();
 if(req?.url?.split('?')[0].match(/^\/api\/app\/v1\/my\/managed-activities\/[a-z0-9]+\/settlement$/)){
   const meta=error?.meta, text=String(error?.message||'')+' '+String(meta?.message||'')+' '+String(meta?.database_error||'');
   const able=/permission denied for (?:table|relation) (\w+)/i.exec(text);
   const table=able?.[1]??null;
   console.log('T44ERR '+JSON.stringify({id:req.id,prisma:/^P\d{4}$/.test(error?.code)?error.code:null,sqlstate:/^[A-Z0-9]{5}$/.test(meta?.code)?meta.code:null,table,model:/^[a-zA-Z_]\w*$/.test(meta?.modelName||'')?meta.modelName:null}));
 }
 return orig.call(this,error,host);
}
