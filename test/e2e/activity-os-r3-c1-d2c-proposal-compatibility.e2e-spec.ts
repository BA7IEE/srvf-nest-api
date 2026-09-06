import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, PrincipalType, Role } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { parseMetricReceipt } from '../../src/modules/activities/activity-metric-command';
import type { ActivityMetricSetPointer } from '../../src/modules/activities/activity-metric-selection';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const APP = '/api/app/v1/my/managed-activities';
const ADMIN = '/api/admin/v1';
const DEFS = `${ADMIN}/activity-metric-definitions`;
const SETS = `${ADMIN}/activity-metric-sets`;

describe('C1 D2c V7 proposal compatibility', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let creatorAuth: string;
  let reviewerAuth: string;
  let organizationId: string;
  let sequence = 0;
  const previousGate = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
  const unique = (label: string): string => `c1-d2c-compat-${label}-${++sequence}`;
  const metricCode = (label: string): string => `c1d2c_compat_${label}_${++sequence}`;

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const creator = await createTestUser(app, {
      username: unique('creator'),
      role: Role.SUPER_ADMIN,
    });
    const reviewer = await createTestUser(app, { username: unique('reviewer'), role: Role.USER });
    const creatorMember = await prisma.member.create({
      data: {
        memberNo: unique('creator-member'),
        ...memberIdentityData('C1 D2c 兼容发起人'),
        gradeCode: 'level-3',
      },
    });
    const reviewerMember = await prisma.member.create({
      data: {
        memberNo: unique('reviewer-member'),
        ...memberIdentityData('C1 D2c 兼容审核人'),
        gradeCode: 'level-3',
      },
    });
    await prisma.user.update({ where: { id: creator.id }, data: { memberId: creatorMember.id } });
    await prisma.user.update({ where: { id: reviewer.id }, data: { memberId: reviewerMember.id } });

    const bizAdmin = await seedBizAdminPermissionsAndRole(app);
    await seedActivityResponsibilitySystemRoles(app);
    await grantBizAdminToUser(app, creator.id, bizAdmin.bizAdminRoleId);
    const root = await prisma.organization.create({
      data: { name: unique('root'), nodeTypeCode: unique('root-type') },
    });
    const organization = await prisma.organization.create({
      data: { name: unique('organization'), nodeTypeCode: unique('team-type'), parentId: root.id },
    });
    organizationId = organization.id;
    await prisma.organizationClosure.createMany({
      data: [
        { ancestorId: root.id, descendantId: root.id, depth: 0 },
        { ancestorId: root.id, descendantId: organization.id, depth: 1 },
        { ancestorId: organization.id, descendantId: organization.id, depth: 0 },
      ],
    });
    await prisma.memberOrganizationMembership.create({
      data: { memberId: creatorMember.id, organizationId },
    });
    const type = await prisma.dictType.create({
      data: { code: 'activity_type', label: 'C1 D2c 兼容活动类型' },
    });
    await prisma.dictItem.create({
      data: { typeId: type.id, code: 'event_support', label: '活动保障' },
    });

    await prisma.permission.createMany({
      data: [
        {
          code: 'activity-review.read.request',
          module: 'activity-review',
          action: 'read',
          resourceType: 'request',
        },
        {
          code: 'activity-review.return.request',
          module: 'activity-review',
          action: 'return',
          resourceType: 'request',
        },
      ],
      skipDuplicates: true,
    });
    const reviewerRole = await prisma.rbacRole.create({
      data: { code: unique('reviewer-role'), displayName: 'C1 D2c 兼容审核角色' },
    });
    const permissions = await prisma.permission.findMany({
      where: {
        code: {
          in: [
            'activity-review.read.request',
            'activity-review.return.request',
            'activity.publish.record',
          ],
        },
      },
      select: { id: true },
    });
    await prisma.rolePermission.createMany({
      data: permissions.map((permission) => ({
        roleId: reviewerRole.id,
        permissionId: permission.id,
      })),
    });
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: reviewer.id,
        roleId: reviewerRole.id,
        scopeType: BindingScopeType.ORGANIZATION,
        scopeOrgId: organizationId,
      },
    });
    creatorAuth = (await loginAs(app, creator.username)).authHeader;
    reviewerAuth = (await loginAs(app, reviewer.username)).authHeader;
  });

  afterAll(async () => {
    await app?.close();
    if (previousGate === undefined) delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
    else process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = previousGate;
  });

  async function catalogue(): Promise<ActivityMetricSetPointer> {
    const definition = await request(httpServer(app))
      .post(DEFS)
      .set('Authorization', creatorAuth)
      .send({
        operationKey: unique('definition-create'),
        definition: {
          schemaVersion: 1,
          code: metricCode('definition'),
          version: 1,
          name: '兼容性指标定义',
          configuration: { kindCode: 'boolean', unit: null },
        },
      })
      .expect(201);
    const definitionReceipt = parseMetricReceipt(definition.body.data);
    await request(httpServer(app))
      .post(`${DEFS}/${definitionReceipt.id}/activate`)
      .set('Authorization', creatorAuth)
      .send({
        operationKey: unique('definition-activate'),
        expectedDefinitionHash: definitionReceipt.definitionHash,
      })
      .expect(200);
    const set = await request(httpServer(app))
      .post(SETS)
      .set('Authorization', creatorAuth)
      .send({
        operationKey: unique('set-create'),
        definition: {
          schemaVersion: 1,
          code: metricCode('set'),
          version: 1,
          name: '兼容性指标集',
          items: [
            {
              key: 'completed',
              sortOrder: 0,
              required: true,
              metricDefinitionId: definitionReceipt.id,
              definitionHash: definitionReceipt.definitionHash,
            },
          ],
        },
      })
      .expect(201);
    const setReceipt = parseMetricReceipt(set.body.data);
    await request(httpServer(app))
      .post(`${SETS}/${setReceipt.id}/activate`)
      .set('Authorization', creatorAuth)
      .send({
        operationKey: unique('set-activate'),
        expectedDefinitionHash: setReceipt.definitionHash,
      })
      .expect(200);
    return {
      id: setReceipt.id,
      code: setReceipt.code,
      version: setReceipt.version,
      schemaVersion: setReceipt.schemaVersion,
      definitionHash: setReceipt.definitionHash,
    };
  }

  async function createDraft(): Promise<string> {
    const response = await request(httpServer(app))
      .post(`${ADMIN}/activities`)
      .set('Authorization', creatorAuth)
      .send({
        title: unique('activity'),
        activityTypeCode: 'event_support',
        allocationModeCode: 'first_come',
        organizationId,
        startAt: '2099-09-01T08:00:00.000Z',
        endAt: '2099-09-01T10:00:00.000Z',
        registrationDeadline: '2099-08-31T12:00:00.000Z',
        location: 'C1 D2c 兼容集合点',
        visibilityCode: 'internal',
        isPublicRegistration: true,
      })
      .expect(201);
    const activityId = response.body.data.id as string;
    await request(httpServer(app))
      .post(`${APP}/${activityId}/sessions`)
      .set('Authorization', creatorAuth)
      .send({
        code: unique('session'),
        name: '兼容测试场次',
        startAt: '2099-09-01T08:00:00.000Z',
        endAt: '2099-09-01T10:00:00.000Z',
        locationText: 'C1 D2c 兼容集合点',
        checkInOpenAt: '2099-09-01T07:30:00.000Z',
        checkInCloseAt: '2099-09-01T08:30:00.000Z',
        checkOutOpenAt: '2099-09-01T09:00:00.000Z',
        checkOutCloseAt: '2099-09-01T10:00:00.000Z',
        locationRequired: false,
      })
      .expect(201);
    return activityId;
  }

  async function select(
    activityId: string,
    selection:
      | { metricRequirementCode: 'not_required'; metricSetPointer: null }
      | {
          metricRequirementCode: 'required';
          metricSetPointer: ActivityMetricSetPointer;
        },
  ) {
    await request(httpServer(app))
      .put(`${APP}/${activityId}/metric-selection`)
      .set('Authorization', creatorAuth)
      .send({ operationKey: unique('selection'), expectedRevision: 0, metricSelection: selection })
      .expect(200);
  }

  async function publish(activityId: string) {
    const review = await request(httpServer(app))
      .post(`${APP}/${activityId}/publish-reviews`)
      .set('Authorization', creatorAuth)
      .send({ operationKey: unique('initial'), confirmation: true })
      .expect(200);
    await request(httpServer(app))
      .post(`${ADMIN}/activity-publish-reviews/${review.body.data.id as string}/approve`)
      .set('Authorization', reviewerAuth)
      .send({ requiresInsuranceConfirmed: true, operationKey: unique('initial-approve') })
      .expect(200);
  }

  function change(
    activityId: string,
    title: string,
    metric?: {
      metricSelection:
        | { metricRequirementCode: 'not_required'; metricSetPointer: null }
        | {
            metricRequirementCode: 'required';
            metricSetPointer: ActivityMetricSetPointer;
          };
      expectedMetricSelectionRevision: number;
    },
  ) {
    return request(httpServer(app))
      .post(`${APP}/${activityId}/change-reviews`)
      .set('Authorization', creatorAuth)
      .send({
        operationKey: unique('change'),
        confirmation: true,
        activityPatch: { title },
        sessions: { create: [], update: [], cancel: [] },
        positions: { create: [], update: [], cancel: [] },
        ...metric,
      });
  }

  function approve(reviewId: string) {
    return request(httpServer(app))
      .post(`${ADMIN}/activity-publish-reviews/${reviewId}/approve`)
      .set('Authorization', reviewerAuth)
      .send({ requiresInsuranceConfirmed: true, operationKey: unique('approve') });
  }

  it('requires explicit same-pointer requests to remain newly selectable, while omitted changes retain historical pointers', async () => {
    const pointer = await catalogue();
    const noOpActivityId = await createDraft();
    await select(noOpActivityId, { metricRequirementCode: 'required', metricSetPointer: pointer });
    await publish(noOpActivityId);
    const noOp = await request(httpServer(app))
      .post(`${APP}/${noOpActivityId}/change-reviews`)
      .set('Authorization', creatorAuth)
      .send({
        operationKey: unique('same-only'),
        confirmation: true,
        activityPatch: {},
        sessions: { create: [], update: [], cancel: [] },
        positions: { create: [], update: [], cancel: [] },
        metricSelection: { metricRequirementCode: 'required', metricSetPointer: pointer },
        expectedMetricSelectionRevision: 1,
      });
    expectBizError(noOp, BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);

    const explicitActivityId = await createDraft();
    const retainedActivityId = await createDraft();
    await select(explicitActivityId, {
      metricRequirementCode: 'required',
      metricSetPointer: pointer,
    });
    await select(retainedActivityId, {
      metricRequirementCode: 'required',
      metricSetPointer: pointer,
    });
    await publish(explicitActivityId);
    await publish(retainedActivityId);
    expectBizError(
      await change(explicitActivityId, '过期前的显式同指针', {
        metricSelection: { metricRequirementCode: 'not_required', metricSetPointer: null },
        expectedMetricSelectionRevision: 0,
      }),
      BizCode.ACTIVITY_METRIC_SELECTION_STALE,
    );
    const explicit = await change(explicitActivityId, '显式同指针变更', {
      metricSelection: { metricRequirementCode: 'required', metricSetPointer: pointer },
      expectedMetricSelectionRevision: 1,
    }).expect(200);
    expect(explicit.body.data.snapshot).toMatchObject({
      metricSelectionExplicit: true,
      metricSelectionRevision: 1,
      base: { metricSelectionRevision: 1 },
    });
    const retained = await change(retainedActivityId, '保留历史指针变更').expect(200);
    expect(retained.body.data.snapshot).toMatchObject({
      metricSelectionExplicit: false,
      metricSelectionRevision: 1,
      base: { metricSelectionRevision: 1 },
    });

    await request(httpServer(app))
      .post(`${SETS}/${pointer.id}/retire`)
      .set('Authorization', creatorAuth)
      .send({ operationKey: unique('retire'), expectedDefinitionHash: pointer.definitionHash })
      .expect(200);
    expectBizError(
      await approve(explicit.body.data.id as string),
      BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE,
    );
    await approve(retained.body.data.id as string).expect(200);
    expect(
      await prisma.activity.findUniqueOrThrow({
        where: { id: retainedActivityId },
        select: {
          metricRequirementCode: true,
          selectedMetricSetVersionId: true,
          selectedMetricSetDefinitionHash: true,
          metricSelectionRevision: true,
        },
      }),
    ).toEqual({
      metricRequirementCode: 'required',
      selectedMetricSetVersionId: pointer.id,
      selectedMetricSetDefinitionHash: pointer.definitionHash,
      metricSelectionRevision: 1,
    });
  });

  it('lets legacy unconfigured published activities retain old columns, then explicitly migrate from revision zero', async () => {
    const activityId = await createDraft();
    await select(activityId, { metricRequirementCode: 'not_required', metricSetPointer: null });
    await publish(activityId);
    // This is a fixed historical fixture, not a new command: old published rows legitimately
    // predate D2b and must remain changeable when a legacy client omits V7 fields.
    await prisma.activity.update({
      where: { id: activityId },
      data: {
        metricRequirementCode: null,
        selectedMetricSetVersionId: null,
        selectedMetricSetDefinitionHash: null,
        metricSelectionRevision: 0,
      },
    });

    const retained = await change(activityId, '旧客户端省略指标字段').expect(200);
    expect(retained.body.data.snapshot).toMatchObject({
      schemaVersion: 7,
      metricSelectionExplicit: false,
      metricRequirementCode: null,
      metricSetPointer: null,
      metricSelectionRevision: 0,
      base: {
        metricRequirementCode: null,
        metricSetPointer: null,
        metricSelectionRevision: 0,
      },
    });
    await approve(retained.body.data.id as string).expect(200);
    expect(
      await prisma.activity.findUniqueOrThrow({
        where: { id: activityId },
        select: {
          metricRequirementCode: true,
          selectedMetricSetVersionId: true,
          selectedMetricSetDefinitionHash: true,
          metricSelectionRevision: true,
        },
      }),
    ).toEqual({
      metricRequirementCode: null,
      selectedMetricSetVersionId: null,
      selectedMetricSetDefinitionHash: null,
      metricSelectionRevision: 0,
    });

    const invalidPair = await request(httpServer(app))
      .post(`${APP}/${activityId}/change-reviews`)
      .set('Authorization', creatorAuth)
      .send({
        operationKey: unique('invalid-pair'),
        confirmation: true,
        activityPatch: { title: '无配对 revision' },
        sessions: { create: [], update: [], cancel: [] },
        positions: { create: [], update: [], cancel: [] },
        expectedMetricSelectionRevision: 0,
      });
    expectBizError(invalidPair, BizCode.BAD_REQUEST, { strictMessage: false });

    const migrated = await change(activityId, '从历史零版本显式迁移', {
      metricSelection: { metricRequirementCode: 'not_required', metricSetPointer: null },
      expectedMetricSelectionRevision: 0,
    }).expect(200);
    expect(migrated.body.data.snapshot).toMatchObject({
      metricSelectionExplicit: true,
      metricRequirementCode: 'not_required',
      metricSetPointer: null,
      metricSelectionRevision: 1,
      base: { metricRequirementCode: null, metricSelectionRevision: 0 },
    });
    await approve(migrated.body.data.id as string).expect(200);
    expect(
      await prisma.activity.findUniqueOrThrow({
        where: { id: activityId },
        select: {
          metricRequirementCode: true,
          selectedMetricSetVersionId: true,
          selectedMetricSetDefinitionHash: true,
          metricSelectionRevision: true,
        },
      }),
    ).toEqual({
      metricRequirementCode: 'not_required',
      selectedMetricSetVersionId: null,
      selectedMetricSetDefinitionHash: null,
      metricSelectionRevision: 1,
    });
  });
});
