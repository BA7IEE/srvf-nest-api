import { computeActivityTemplateDefinitionHash } from './src/modules/activities/activity-template-definition';
import { fingerprintTimePolicyVersion } from './src/modules/activities/activity-time-policy-definition';
import { fingerprintContributionPolicyVersion } from './src/modules/activities/activity-contribution-policy-definition';
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
 const create=(title:string)=>svc.create({title,organizationId:org.id,activityTypeCode:'training',allocationModeCode:'first_come',startAt:'2099-01-01T00:00:00Z',endAt:'2099-01-01T02:00:00Z',location:'lab',isPublicRegistration:false},actor,{} as any);


 const permission=await root.permission.create({data:{code:'activity.create.record',module:'activity',action:'create',resourceType:'record'}});
 const role=await root.rbacRole.create({data:{code:'lab-scope-create',displayName:'fixture',rolePermissions:{create:{permissionId:permission.id}}}});
 await root.roleBinding.create({data:{principalType:'USER',principalId:u.id,roleId:role.id,scopeType:'ORGANIZATION',scopeOrgId:org.id}});
 const key=(v:string)=>'t29b_'+v;
 await root.dictType.create({data:{code:'attendance_role',label:'role',items:{create:{code:'volunteer',label:'volunteer'}}}});
    const time = fingerprintTimePolicyVersion({
      schemaVersion: 1,
      evaluatorVersion: 1,
      effectiveFrom: '2098-01-01T00:00:00.000Z',
      effectiveUntil: '2101-01-01T00:00:00.000Z',
      definition: {
        defaultCategory: 'volunteer_service',
        roleMappings: [],
        allowSplit: false,
        specialIntervals: {
          preparation: { mode: 'exclude' },
          duty: { mode: 'exclude' },
          travel: { mode: 'exclude' },
        },
        rounding: { mode: 'floor', quantumSeconds: 1 },
        evidence: { requiredSources: [], requireManualRecognition: false },
        manualAdjustment: { enabled: false },
      },
    });
    const tp = await root.timePolicy.create({
      data: { code: key('time'), name: '合成批准时长政策' },
    });
    const tv = await root.timePolicyVersion.create({
      data: {
        policyId: tp.id,
        version: 1,
        schemaVersion: 1,
        definitionJson: time.definition as unknown as Prisma.InputJsonValue,
        definitionHash: time.definitionHash,
        evaluatorVersion: 1,
        effectiveFrom: new Date(time.effectiveFrom),
        effectiveUntil: new Date(time.effectiveUntil!),
        statusCode: 'draft',
      },
    });
    await root.timePolicyVersion.update({
      where: { id: tv.id },
      data: { statusCode: 'active', activatedAt: new Date() },
    });
    const contribution = fingerprintContributionPolicyVersion({
      schemaVersion: 1,
      evaluatorVersion: 1,
      effectiveFrom: '2098-01-01T00:00:00.000Z',
      effectiveUntil: '2101-01-01T00:00:00.000Z',
      definition: {
        defaultResult: { recognizedPoints: '0.00', explanationCode: 'test_default_zero' },
        roleRules: [],
      },
    });
    const cp = await root.contributionPolicy.create({
      data: { code: key('contribution'), name: '合成批准贡献政策' },
    });
    const cv = await root.contributionPolicyVersion.create({
      data: {
        policyId: cp.id,
        version: 1,
        schemaVersion: 1,
        definitionJson: contribution.definition as unknown as Prisma.InputJsonValue,
        definitionHash: contribution.definitionHash,
        evaluatorVersion: 1,
        effectiveFrom: new Date(contribution.effectiveFrom),
        effectiveUntil: new Date(contribution.effectiveUntil!),
        statusCode: 'draft',
        createdByUserId: u.id,
      },
    });
    await root.contributionPolicyVersion.update({
      where: { id: cv.id },
      data: { statusCode: 'active', activatedAt: new Date(), activatedByUserId: u.id },
    });
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
        name: '合成单场次 V5',
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
 const cmd={templateVersionId:template.id,title:'t29b',organizationId:org.id,startAt:'2099-01-01T00:00:00Z',endAt:'2099-01-01T02:00:00Z',location:'lab',operationKey:'t29b-create-01'};
 const access=mod.get(require('./src/modules/activities/activity-metric-selection-access').ActivityMetricSelectionAccess);
 const auth=await db.$transaction(tx=>access.authorizeSimpleCreation(tx,actor,org.id));assert.equal(auth.initiatorMemberId,m.id);
 console.log('PASS ordinary member organization-scoped creation authorization');
 const quick=mod.get(require('./src/modules/activities/activity-creation.service').ActivityCreationService);
 const simple=mod.get(require('./src/modules/activities/activity-simple-draft.service').ActivitySimpleDraftService);
 const legacy=mod.get(require('./src/modules/activities/activity-from-template.service').ActivityFromTemplateService);
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
 const approved=await reviews.approve(review.id,{requiresInsuranceConfirmed:true,operationKey:'t29b-approve'},reviewerActor,{});
 assert.equal(approved.status,'approved');assert.equal((await root.activity.findUniqueOrThrow({where:{id:row.id}})).statusCode,'published'); console.log('PASS independent reviewer published');
 const ctrl=mod.get(require('./src/modules/activities/controllers/app-managed-activities.controller').AppManagedActivitiesController);
 const dto={activity:{title:'t29b proposed'}};
 try{await ctrl.submitChangeReview(reviewerActor,{activityId:row.id},dto,{headers:{}});throw Error('unexpected cross-object success')}catch(e:any){assert(e.biz);console.log('cross-object',e.biz.code)}
 const proposed=await ctrl.submitChangeReview(actor,{activityId:row.id},dto,{headers:{}});
 assert.equal(proposed.requestType,'change');assert.equal(proposed.status,'pending');console.log('PASS published owner change review pending');
 }finally{await db.$disconnect();await root.$disconnect();await mod.close()}
}
run().catch(e=>{console.error(e.biz?.code, String(e.stack).split("\n").slice(0,7).join("\n"));process.exitCode=1});
