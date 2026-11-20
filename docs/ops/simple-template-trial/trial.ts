import { computeActivityTemplateDefinitionHash } from './src/modules/activities/activity-template-definition';
const baseDefinition = {
  activity: { allocationModeCode: 'first_come', capacity: 2, requiresInsurance: true },
  sessions: [
    {
      code: 'main',
      name: '唯一场次',
      startOffsetMinutes: 0,
      endOffsetMinutes: 120,
      locationText: '集合点',
      capacity: 2,
      checkInOpenOffsetMinutes: 0,
      checkInCloseOffsetMinutes: 20,
      checkOutOpenOffsetMinutes: -20,
      checkOutCloseOffsetMinutes: 0,
      locationRequired: false,
      lateGraceMinutes: 5,
      earlyLeaveThresholdMinutes: 5,
      sortOrder: 0,
      positions: [
        {
          code: 'participant',
          name: '默认参与',
          attendanceRoleCode: 'volunteer',
          capacity: 2,
          sortOrder: 0,
        },
      ],
    },
  ],
};

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


 const createDefinition=require('./src/modules/permissions/permission-catalog').ACTIVITY_PERMISSION_SEED.find(entry=>entry.code==='activity.create.record');
 assert(createDefinition);
 const permission=await root.permission.create({data:createDefinition});
 const role=await root.rbacRole.create({data:{code:'lab-scope-create',displayName:'fixture',rolePermissions:{create:{permissionId:permission.id}}}});
 await root.roleBinding.create({data:{principalType:'USER',principalId:u.id,roleId:role.id,scopeType:'ORGANIZATION',scopeOrgId:org.id}});
 const key=(v:string)=>'t29b_'+v;
 await root.dictType.create({data:{code:'attendance_role',label:'role',items:{create:{code:'volunteer',label:'volunteer'}}}});
    const definition = {
      ...baseDefinition,
      registrationForm: null,
      metricSelection: { metricRequirementCode: 'not_required', metricSetPointer: null },
    };
    const family = await root.activityTemplateFamily.create({
      data: {
        code: key('family'),
        name: '合成常规活动',
        categoryCode: 'training',
        scopeTypeCode: 'global',
        statusCode: 'active',
      },
    });
    const template = await root.activityTemplate.create({
      data: {
        code: key('template'),
        name: 'T34 单场次 V3',
        activityTypeCode: 'training',
        version: 1,
        familyId: family.id,
        statusCode: 'draft',
        schemaVersion: 3,
        definitionJson: definition,
        definitionHash: computeActivityTemplateDefinitionHash({ schemaVersion: 3, definition }),
        effectiveFrom: new Date('2098-01-01T00:00:00Z'),
      },
    });
    await root.activityTemplate.update({
      where: { id: template.id },
      data: { statusCode: 'active' },
    });
 assert.equal(template.definitionHash,'0d2438eabcd7e6e872b054c401879dec0be6eb97368b04ceb4bb52951a73781d');
 console.log('V3 version/hash',template.version,template.definitionHash);
 assert.equal(await root.roleBinding.count({where:{scopeType:'ACTIVITY'}}),0);
 const cmd={templateVersionId:template.id,title:'t29b',organizationId:org.id,startAt:'2099-01-01T00:00:00Z',endAt:'2099-01-01T02:00:00Z',location:'lab',operationKey:'t29b-create-01'};
 const access=mod.get(require('./src/modules/activities/activity-metric-selection-access').ActivityMetricSelectionAccess);
 const auth=await db.$transaction(tx=>access.authorizeSimpleCreation(tx,actor,org.id));assert.equal(auth.initiatorMemberId,m.id);
 console.log('PASS ordinary member organization-scoped creation authorization');
 const simple=mod.get(require('./src/modules/activities/activity-simple-draft.service').ActivitySimpleDraftService);
 const ident=await db.$queryRawUnsafe("SELECT current_user AS role, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS super, (SELECT relowner=current_user::regrole FROM pg_class WHERE oid='public.\"Activity\"'::regclass) AS owner");
 assert.deepEqual(ident,[{role:'srvf_dp_acceptance_runtime',super:false,owner:false}]);
 if(process.env.LAB_EXPECT_OFF==='1'){
   await assert.rejects(()=>simple.create({...cmd,confirmedCapacity:2,defaultPlaceVisibilityCode:'staff'},actor,{}),(e:any)=>e.biz?.code===20163);
   assert.equal(await root.activity.count(),0);assert.equal(await root.notificationOutboxIntent.count(),0);
   console.log('PASS candidate flags off, ordinary V3 rejected 20163, zero activities and intents');return;
 }
 const result=await simple.create({...cmd,confirmedCapacity:2,defaultPlaceVisibilityCode:'staff'},actor,{});
 const row=await root.activity.findUniqueOrThrow({where:{id:result.activityId}});
 assert.equal(row.initiatorMemberId,m.id);assert.equal(row.metricRequirementCode,'not_required');assert.equal(row.metricSelectionRevision,1);
 console.log('PASS template initialized metric; actor and organization',row.organizationId===org.id);
 const review=await svc.submitInitialProposal(row.id,{operationKey:'t29b-initial-review',confirmation:true},actor,{});
 assert.equal(review.status,'pending');console.log('initial review',review.status);
 const {seedActivityResponsibilitySystemRoles}=require('./test/fixtures/activity-responsibility.fixture');
 await seedActivityResponsibilitySystemRoles({get:()=>root});
 const reviewerMember=await root.member.create({data:{memberNo:'lab-review',realName:'fixture',memberOriginCode:'manual',memberSinceDate:new Date(),gradeCode:'level-1'}});
 const reviewer=await root.user.create({data:{username:'reviewer',passwordHash:'nonlogin',memberId:reviewerMember.id}});
 await root.memberOrganizationMembership.create({data:{organizationId:org.id,memberId:reviewerMember.id}});
 const catalog=require('./prisma/seed').RBAC_SEED_CATALOG;
 const roleSpec=catalog.roles.activityResponsibility.find((r:any)=>r.code==='activity-publish-reviewer');
 const defs=Object.values(catalog.permissions).flat() as any[];
 const reviewerRole=await root.rbacRole.create({data:{code:roleSpec.code,displayName:'活动发布审核员'}});
 for(const code of roleSpec.permissionCodes){
  const def=defs.find((x:any)=>x.code===code);assert(def);
  const perm=await root.permission.upsert({where:{code},create:def,update:{}});
  await root.rolePermission.create({data:{roleId:reviewerRole.id,permissionId:perm.id}});
 }
 await root.roleBinding.create({data:{principalType:'USER',principalId:reviewer.id,roleId:reviewerRole.id,scopeType:'ORGANIZATION',scopeOrgId:org.id}});
 const reviewerActor={id:reviewer.id,memberId:reviewerMember.id,role:'USER'} as any;
 const reviews=mod.get(require('./src/modules/activities/activity-publish-review.service').ActivityPublishReviewService);
 const approve=()=>reviews.approve(review.id,{requiresInsuranceConfirmed:true,operationKey:'t29b-approve'},reviewerActor,{});
 const state=async()=>({bindings:await root.roleBinding.count(),outbox:await root.notificationOutboxIntent.count(),audits:await root.auditLog.count(),status:(await root.activity.findUniqueOrThrow({where:{id:row.id}})).statusCode,review:(await root.activityPublishReview.findUniqueOrThrow({where:{id:review.id}})).status});
 const before=await state();
 await root.$executeRawUnsafe("CREATE FUNCTION lab_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 't30-audit-fault'; END $$");
 await root.$executeRawUnsafe("CREATE TRIGGER lab_abort BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION lab_abort()");
 await assert.rejects(approve,/t30-audit-fault/);assert.deepEqual(await state(),before);
 await root.$executeRawUnsafe("DROP TRIGGER lab_abort ON public.audit_logs");
 console.log('PASS injected publish audit failure leaves counts and workflow intact');
 assert.equal(await root.roleBinding.count({where:{scopeType:'ACTIVITY'}}),0);
 const approved=await approve();
 const completed=await state();
 const replay=async(label,fn)=>{try{await fn();console.log(label,'replayed')}catch(e){assert(e.biz);console.log(label,'rejected',e.biz.code)} assert.deepEqual(await state(),completed);};
 await replay('publish retry',approve);
 await replay('create retry',()=>simple.create({...cmd,confirmedCapacity:2,defaultPlaceVisibilityCode:'staff'},actor,{}));
 assert.equal(approved.status,'approved');assert.equal((await root.activity.findUniqueOrThrow({where:{id:row.id}})).statusCode,'published'); console.log('PASS independent reviewer published');
 const ctrl=mod.get(require('./src/modules/activities/controllers/app-managed-activities.controller').AppManagedActivitiesController);
 const dto={activity:{title:'t29b proposed'}};
 try{await ctrl.submitChangeReview(reviewerActor,{activityId:row.id},dto,{headers:{}});throw Error('unexpected cross-object success')}catch(e:any){assert(e.biz);assert.equal(e.biz.code,30100);console.log('cross-object',e.biz.code)}
 const proposed=await ctrl.submitChangeReview(actor,{activityId:row.id},dto,{headers:{}});
 assert.equal(proposed.requestType,'change');assert.equal(proposed.status,'pending');console.log('PASS published owner change review pending');
 const bindings=await root.roleBinding.findMany({where:{scopeActivityId:row.id},include:{role:true}});
 const intents=await root.notificationOutboxIntent.findMany();
 assert.equal(intents.length,2);
 assert(intents.every(i=>(i.aggregateId===row.id || i.aggregateId===review.id || i.aggregateId===proposed.id) && i.attempts===0 && i.leaseOwner===null && i.sentAt===null));
 assert(bindings.length>0 && intents.length>0);
 console.log('generated bindings',JSON.stringify(bindings.map(b=>[b.role.code,b.scopeType,b.principalType,b.status])));
 console.log('intents',JSON.stringify(intents.map(i=>[i.eventType,i.aggregateType,i.destinationType,i.status])));
 const audit=()=>root.auditLog.findMany({orderBy:{id:'asc'}});const retained=await audit();
 const out=new (require('./src/modules/notifications/notification-outbox.service').NotificationOutboxService)(root);
 for(const i of intents){assert.equal(i.status,'pending');const [claim]=await out.claim('t30-lab',{eventKey:i.eventKey,limit:1});assert.equal(claim.id,i.id);await out.deadLetter(claim,Error('isolated fixture retired'));assert.deepEqual(await out.claim('t30-lab',{eventKey:i.eventKey}),[])}
 const end=await root.roleBinding.updateMany({where:{scopeActivityId:row.id,id:{in:bindings.map(b=>b.id)},status:'ACTIVE'},data:{status:'ENDED',endedAt:new Date()}});
 assert.equal(end.count,bindings.length);assert.equal(await root.roleBinding.count({where:{scopeActivityId:row.id,status:'ACTIVE'}}),0);
 assert.deepEqual(await audit(),retained);assert.equal(await root.notificationOutboxIntent.count({where:{status:'dead',sentAt:null}}),intents.length);
 console.log('PASS isolated retirement; ended bindings, fenced dead unsent intents, retained audit rows',end.count,intents.length,retained.length);
 // This retirement transaction is restricted to the disposable DB and the fixture IDs.
 const retire=()=>root.$transaction(async tx=>{
   const endBindings=await tx.roleBinding.updateMany({where:{scopeOrgId:org.id,principalId:{in:[u.id,reviewer.id]},status:'ACTIVE'},data:{status:'ENDED',endedAt:new Date()}});
   const disable=await tx.user.updateMany({where:{id:{in:[u.id,reviewer.id]},status:'ACTIVE'},data:{status:'DISABLED'}});
   const retireTemplate=await tx.activityTemplate.updateMany({where:{id:template.id,statusCode:'active'},data:{statusCode:'retired'}});
   return [endBindings.count,disable.count,retireTemplate.count];
 });
 assert.deepEqual(await retire(),[2,2,1]);assert.deepEqual(await retire(),[0,0,0]);
 assert.deepEqual(await audit(),retained);
 assert.equal(await root.roleBinding.count({where:{status:'ACTIVE'}}),0);
 console.log('PASS retired two organization bindings, two fixture accounts, one template; repeat delta zero. Published activity and pending proposal retained until isolated stack retirement.');
 }finally{await db.$disconnect();await root.$disconnect();await mod.close()}
}
run().catch(e=>{console.error(e.biz?.code, String(e.stack).split("\n").slice(0,7).join("\n"));process.exitCode=1});
