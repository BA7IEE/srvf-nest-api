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
 const snapshot=async()=>({row:await root.activity.findUniqueOrThrow({where:{id},select:{statusCode:true,metricRequirementCode:true,metricSelectionRevision:true}}),holders:await root.roleBinding.count(),reviews:await root.activityPublishReview.count({where:{activityId:id}})});
 const before=await snapshot();console.log('before metric',JSON.stringify(before));assert.equal(before.holders,0);
 const metric=mod.get(require('./src/modules/activities/activity-metric-selection.service').ActivityMetricSelectionService);
 await assert.rejects(async()=>{await metric.select(id,{operationKey:'t27-select',expectedRevision:0,metricSelection:{metricRequirementCode:'not_required',metricSetPointer:null}},actor,'app',{});}
 , (e:any)=>e.biz?.code===30100); console.log('metric PUT refused 30100');
 try { const submitted=await svc.submitInitialProposal(id,{operationKey:'t27-initial',confirmation:true},actor,{} as any);
 throw Error('unexpected review '+submitted.status)}catch(e:any){console.log('submit',e.biz?.code,e.message);assert.equal(e.biz?.code,20174)}
 assert.equal(await root.activityPublishReview.count({where:{activityId:id}}),0);
 assert.equal((await root.activity.findUniqueOrThrow({where:{id}})).statusCode,'draft');
 assert.deepEqual(await snapshot(),before); console.log("PASS no state transition or pending review");
 }finally{await db.$disconnect();await root.$disconnect();await mod.close()}
}
run().catch(e=>{console.error(String(e).replace(/postgresql:\/\/[^ ]+/g,'[redacted]').slice(-1200));process.exitCode=1});
