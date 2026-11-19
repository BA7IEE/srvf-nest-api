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
 const correction=mod.get(require('./src/modules/activities/activity-time-correction-background.service').ActivityTimeCorrectionBackgroundService);
 try {await correction.detail(id,'lab-request','lab-job',actor);throw Error('unexpected detail')}catch(e:any){console.log('C',e.constructor.name,e.getStatus?.());assert(e.constructor.name.includes('AuthorityUnavailable'))}
 const other=await root.member.create({data:{memberNo:'lab2',realName:'fixture2',memberOriginCode:'manual',memberSinceDate:new Date(),gradeCode:'level-1'}});
 const user2=await root.user.create({data:{username:'lab2',passwordHash:'nonlogin',memberId:other.id}});
 const actor2={id:user2.id,memberId:other.id,role:'USER'} as any;
 try {await svc.update(id,{title:'T27 no access'},actor2,{} as any);throw Error('unexpected update')}catch(e:any){console.log('other actor',e.constructor.name,e.biz?.code);assert(e.constructor.name==='BizException')}
 const changed=await svc.update(id,{title:'T27 changed'},actor,{} as any);
 assert.equal(changed.activity.title,'T27 changed');
 console.log('draft update PASS');
 const metric=mod.get(require('./src/modules/activities/activity-metric-selection.service').ActivityMetricSelectionService);
 try {await metric.select(id,{operationKey:'t27-select',expectedRevision:0,metricSelection:{metricRequirementCode:'not_required',metricSetPointer:null}},actor,'app',{});console.log('metric selection PASS')}
 catch(e:any){console.log('metric selection',e.biz?.code,e.constructor.name);if(!e.biz)throw e}
 try { const submitted=await svc.submitInitialProposal(id,{operationKey:'t27-initial',confirmation:true},actor,{} as any);
 throw Error('unexpected review '+submitted.status)}catch(e:any){console.log('submit',e.biz?.code,e.message);assert(e.biz && e.message.includes('指标选择'))}
 assert.equal(await root.activityPublishReview.count({where:{activityId:id}}),0);
 assert.equal((await root.activity.findUniqueOrThrow({where:{id}})).statusCode,'draft');
 await root.$executeRawUnsafe('REVOKE UPDATE ("title","updatedAt") ON public."Activity" FROM lab_runtime');
 try {await svc.update(id,{title:'after revoke'},actor,{} as any);throw Error('unexpected update after revoke')} catch(e){assert(String(e).includes('permission denied'))}
 assert.equal((await root.activity.findUniqueOrThrow({where:{id}})).title,'T27 changed');
 console.log('PASS zero review, draft retained, revoke blocks update without data loss');
 }finally{await db.$disconnect();await root.$disconnect();await mod.close()}
}
run().catch(e=>{console.error(String(e).replace(/postgresql:\/\/[^ ]+/g,'[redacted]').slice(-1200));process.exitCode=1});
