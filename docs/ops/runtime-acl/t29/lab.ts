import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { AppModule } from './src/app.module';
import { PrismaService } from './src/database/prisma.service';
import { AppManagedActivitiesService } from './src/modules/activities/app-managed-activities.service';
import { strict as assert } from 'node:assert';
import { appendFileSync } from 'node:fs';
async function run() {
 const root=new PrismaClient({datasourceUrl:process.env.LAB_OWNER});
 const db=new PrismaClient({log:[{emit:'event',level:'query'}]});
 db.$on('query', e=>appendFileSync(process.env.TRACE!,e.query+'\n'));
 const mod=await Test.createTestingModule({imports:[AppModule]}).overrideProvider(PrismaService).useValue(db).compile();
 try {
 const svc=mod.get(AppManagedActivitiesService);
 const rootOrg=await root.organization.create({data:{name:'Lab',nodeTypeCode:'group'}});
 const org=await root.organization.create({data:{name:'Lab team',nodeTypeCode:'group',parentId:rootOrg.id}});
 const m=await root.member.create({data:{memberNo:'lab',realName:'fixture',memberOriginCode:'manual',memberSinceDate:new Date(),gradeCode:'level-1'}});
 const u=await root.user.create({data:{username:'lab',passwordHash:'nonlogin',memberId:m.id}});
 await root.memberOrganizationMembership.create({data:{memberId:m.id,organizationId:org.id}});
 await root.dictType.create({data:{code:'activity_type',label:'Training',items:{create:{code:'training',label:'Training'}}}});
 const actor={id:u.id,memberId:m.id,role:'USER'} as any;
 const create=(title:string)=>svc.create({title,organizationId:org.id,activityTypeCode:'training',allocationModeCode:'first_come',startAt:'2099-01-01T00:00:00Z',endAt:'2099-01-02T00:00:00Z',location:'lab',isPublicRegistration:false},actor,{} as any);

 const result=await create('T27');
 const id=result.activity.id;
 const other=await root.member.create({data:{memberNo:'lab2',realName:'fixture2',memberOriginCode:'manual',memberSinceDate:new Date(),gradeCode:'level-1'}});
 const user2=await root.user.create({data:{username:'lab2',passwordHash:'nonlogin',memberId:other.id}});
 const actor2={id:user2.id,memberId:other.id,role:'USER'} as any;
 try {await svc.update(id,{title:'T27 no access'},actor2,{} as any);throw Error('unexpected update')}catch(e:any){console.log('other actor',e.constructor.name,e.biz?.code);assert(e.constructor.name==='BizException')}
 const changed=await svc.update(id,{title:'T27 changed'},actor,{} as any);
 assert.equal(changed.activity.title,'T27 changed');
 console.log('draft update PASS');
 const admin=await root.user.create({data:{username:'setup',role:'SUPER_ADMIN',passwordHash:'nonlogin'}});
 const factory=await Test.createTestingModule({imports:[AppModule]}).overrideProvider(PrismaService).useValue(root).compile();
 const bind=factory.get(require('./src/modules/role-bindings/role-bindings.service').RoleBindingsService);
 const setupActor={id:admin.id,role:'SUPER_ADMIN',memberId:null};
 for (const [roleCode,principalId] of [['activity-owner',u.id],['activity-publish-reviewer',user2.id]]) {
  const role=await root.rbacRole.findUniqueOrThrow({where:{code:roleCode}});
  try{
   await bind.create(setupActor,{roleId:role.id,principalType:'USER',principalId,scopeType:'ACTIVITY',scopeActivityId:id},{});
   console.log('scoped binding',roleCode,'created');
   assert(roleCode==='activity-publish-reviewer');
  }catch(e:any){console.log('scoped binding',roleCode,e.biz?.code||e.constructor.name);if(roleCode==='activity-owner')assert.equal(e.biz?.code,34006);else throw e}
 }
 await factory.close();
 const ctrl=mod.get(require('./src/modules/activities/controllers/app-managed-activities.controller').AppManagedActivitiesController);
 for(const [name,target,who] of [['missing','c000000000000000000000000',actor],['foreign-draft',id,actor2]] as const){
  try{await ctrl.submitChangeReview(who,{activityId:target},{activity:{}},{headers:{}});throw Error('unexpected success')}
  catch(e:any){console.log('change review',name,e.biz?.code);assert.equal(e.biz?.code,name==='missing'?20001:20030)}
 }
 const metric=mod.get(require('./src/modules/activities/activity-metric-selection.service').ActivityMetricSelectionService);
 try {await metric.select(id,{operationKey:'t27-select',expectedRevision:0,metricSelection:{metricRequirementCode:'not_required',metricSetPointer:null}},actor,'app',{});console.log('metric selection PASS')}
 catch(e:any){console.log('metric selection',e.biz?.code,e.constructor.name);assert.equal(e.biz?.code,30100)}
 try { const submitted=await svc.submitInitialProposal(id,{operationKey:'t27-initial',confirmation:true},actor,{} as any);
 throw Error('unexpected review '+submitted.status)}catch(e:any){console.log('submit',e.biz?.code,e.message);assert.equal(e.biz?.code,20174)}
 assert.equal(await root.activityPublishReview.count({where:{activityId:id}}),0);
 assert.equal((await root.activity.findUniqueOrThrow({where:{id}})).statusCode,'draft');
 await root.$executeRawUnsafe('REVOKE UPDATE ("title","updatedAt") ON public."Activity" FROM lab_runtime');
 try {await svc.update(id,{title:'after revoke'},actor,{} as any);throw Error('unexpected update after revoke')} catch(e){assert(String(e).includes('permission denied'))}
 assert.equal((await root.activity.findUniqueOrThrow({where:{id}})).title,'T27 changed');
 console.log('PASS zero review, draft retained, revoke blocks update without data loss');
 }finally{await db.$disconnect();await root.$disconnect();await mod.close()}
}
run().catch(e=>{console.error(String(e).replace(/postgresql:\/\/[^ ]+/g,'[redacted]').slice(-1200));process.exitCode=1});
