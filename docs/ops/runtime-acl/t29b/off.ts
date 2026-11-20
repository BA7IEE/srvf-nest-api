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
 const create=(title:string)=>svc.create({title,organizationId:org.id,activityTypeCode:'training',allocationModeCode:'first_come',startAt:'2099-01-01T00:00:00Z',endAt:'2099-01-02T00:00:00Z',location:'lab',isPublicRegistration:false},actor,{} as any);


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
      timePolicySelection: {
        default: {
          mode: 'explicit',
          pointer: { policyId: tp.id, versionId: tv.id, definitionHash: tv.definitionHash },
        },
        sessionOverrides: [],
        positionOverrides: [],
      },
      contributionPolicySelection: {
        activityDefault: {
          mode: 'explicit',
          pointer: {
            policyId: cp.id,
            versionId: cv.id,
            definitionHash: cv.definitionHash,
            evaluatorVersion: 1,
          },
        },
        positionOverrides: [],
      },
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
        schemaVersion: 5,
        definitionJson: definition,
        definitionHash: computeActivityTemplateDefinitionHash({ schemaVersion: 5, definition }),
        effectiveFrom: new Date('2098-01-01T00:00:00Z'),
      },
    });
    await root.activityTemplate.update({
      where: { id: template.id },
      data: { statusCode: 'active' },
    });
 const cmd={templateVersionId:template.id,title:'t29b',organizationId:org.id,startAt:'2099-01-01T00:00:00Z',endAt:'2099-01-02T00:00:00Z',location:'lab',operationKey:'t29b-create-01'};
 const access=mod.get(require('./src/modules/activities/activity-metric-selection-access').ActivityMetricSelectionAccess);
 const auth=await db.$transaction(tx=>access.authorizeSimpleCreation(tx,actor,org.id));assert.equal(auth.initiatorMemberId,m.id);
 console.log('PASS ordinary member organization-scoped creation authorization');
 const quick=mod.get(require('./src/modules/activities/activity-creation.service').ActivityCreationService);
 const simple=mod.get(require('./src/modules/activities/activity-simple-draft.service').ActivitySimpleDraftService);
 const legacy=mod.get(require('./src/modules/activities/activity-from-template.service').ActivityFromTemplateService);
 for(const [name,invoke] of [['simple',()=>simple.create({...cmd,confirmedCapacity:2,defaultPlaceVisibilityCode:'public'},actor,{})],['quick',()=>quick.createQuick({template:cmd},actor,{})],['from-template',()=>legacy.createFromTemplate(cmd,actor,{})]] as const){
  try{await invoke();throw Error(name+' unexpected create')}catch(e:any){assert.equal(e.biz?.code,name==='simple'?20163:30100);console.log(name,e.biz.code,e.biz.message)}
 }
 assert.equal(await root.activity.count(),0);assert.equal(await root.activityPublishReview.count(),0);console.log('resulting activity rows',await root.activity.count());
 console.log('initial reviews',await root.activityPublishReview.count());
 }finally{await db.$disconnect();await root.$disconnect();await mod.close()}
}
run().catch(e=>{console.error(String(e).slice(-1200));process.exitCode=1});
