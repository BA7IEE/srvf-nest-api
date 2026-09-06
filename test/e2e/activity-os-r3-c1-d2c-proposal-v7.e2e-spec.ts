import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, PrincipalType, Role } from '@prisma/client';
import request from 'supertest';

import { PrismaService } from '../../src/database/prisma.service';
import { parseMetricReceipt } from '../../src/modules/activities/activity-metric-command';
import type { ActivityMetricSetPointer } from '../../src/modules/activities/activity-metric-selection';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const APP = '/api/app/v1/my/managed-activities';
const ADMIN = '/api/admin/v1';
const DEFS = `${ADMIN}/activity-metric-definitions`;
const SETS = `${ADMIN}/activity-metric-sets`;

describe('C1 D2c V7 publish proposal', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let creatorAuth: string;
  let reviewerAuth: string;
  let organizationId: string;
  let sequence = 0;
  const previousGate = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
  const unique = (label: string): string => `c1-d2c-v7-${label}-${++sequence}`;
  const metricCode = (label: string): string => `c1d2c_${label}_${++sequence}`;

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
        ...memberIdentityData('C1 D2c V7 发起人'),
        gradeCode: 'level-3',
      },
    });
    const reviewerMember = await prisma.member.create({
      data: {
        memberNo: unique('reviewer-member'),
        ...memberIdentityData('C1 D2c V7 审核人'),
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
      data: { code: 'activity_type', label: 'C1 D2c V7 活动类型' },
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
      data: { code: unique('reviewer-role'), displayName: 'C1 D2c V7 审核角色' },
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

  async function createCatalogue(): Promise<ActivityMetricSetPointer> {
    const definition = await request(httpServer(app))
      .post(DEFS)
      .set('Authorization', creatorAuth)
      .send({
        operationKey: unique('definition-create'),
        definition: {
          schemaVersion: 1,
          code: metricCode('definition'),
          version: 1,
          name: '完成指标',
          configuration: { kindCode: 'boolean', unit: null },
        },
      })
      .expect(201);
    const definitionPointer = parseMetricReceipt(definition.body.data);
    await request(httpServer(app))
      .post(`${DEFS}/${definitionPointer.id}/activate`)
      .set('Authorization', creatorAuth)
      .send({
        operationKey: unique('definition-activate'),
        expectedDefinitionHash: definitionPointer.definitionHash,
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
          name: 'V7 精确指标集',
          items: [
            {
              key: 'completed',
              sortOrder: 0,
              required: true,
              metricDefinitionId: definitionPointer.id,
              definitionHash: definitionPointer.definitionHash,
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
    const created = await request(httpServer(app))
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
        location: 'C1 D2c V7 集合点',
        visibilityCode: 'internal',
        isPublicRegistration: true,
      })
      .expect(201);
    const activityId = created.body.data.id as string;
    await request(httpServer(app))
      .post(`${APP}/${activityId}/sessions`)
      .set('Authorization', creatorAuth)
      .send({
        code: unique('session'),
        name: 'V7 冻结场次',
        startAt: '2099-09-01T08:00:00.000Z',
        endAt: '2099-09-01T10:00:00.000Z',
        locationText: 'C1 D2c V7 集合点',
        checkInOpenAt: '2099-09-01T07:30:00.000Z',
        checkInCloseAt: '2099-09-01T08:30:00.000Z',
        checkOutOpenAt: '2099-09-01T09:00:00.000Z',
        checkOutCloseAt: '2099-09-01T10:00:00.000Z',
        locationRequired: false,
      })
      .expect(201);
    return activityId;
  }

  async function selectMetric(activityId: string, pointer: ActivityMetricSetPointer) {
    await request(httpServer(app))
      .put(`${APP}/${activityId}/metric-selection`)
      .set('Authorization', creatorAuth)
      .send({
        operationKey: unique('select'),
        expectedRevision: 0,
        metricSelection: { metricRequirementCode: 'required', metricSetPointer: pointer },
      })
      .expect(200);
  }

  function approve(reviewId: string) {
    return request(httpServer(app))
      .post(`${ADMIN}/activity-publish-reviews/${reviewId}/approve`)
      .set('Authorization', reviewerAuth)
      .send({ requiresInsuranceConfirmed: true, operationKey: unique('approve') });
  }

  it('freezes a Human-created required selection, applies it atomically, and exposes only safe V7 diff names', async () => {
    const pointer = await createCatalogue();
    const activityId = await createDraft();
    await selectMetric(activityId, pointer);

    const initial = await request(httpServer(app))
      .post(`${APP}/${activityId}/publish-reviews`)
      .set('Authorization', creatorAuth)
      .send({ operationKey: unique('initial'), confirmation: true })
      .expect(200);
    const initialSnapshot = initial.body.data.snapshot as Record<string, unknown>;
    expect(initialSnapshot).toMatchObject({
      schemaVersion: 7,
      metricSelectionExplicit: true,
      metricRequirementCode: 'required',
      metricSetPointer: pointer,
      metricSelectionRevision: 1,
      base: {
        metricRequirementCode: 'required',
        metricSetPointer: pointer,
        metricSelectionRevision: 1,
      },
    });
    await approve(initial.body.data.id as string).expect(200);

    const published = await prisma.activity.findUniqueOrThrow({
      where: { id: activityId },
      select: {
        statusCode: true,
        metricRequirementCode: true,
        selectedMetricSetVersionId: true,
        selectedMetricSetDefinitionHash: true,
        metricSelectionRevision: true,
      },
    });
    expect(published).toEqual({
      statusCode: 'published',
      metricRequirementCode: 'required',
      selectedMetricSetVersionId: pointer.id,
      selectedMetricSetDefinitionHash: pointer.definitionHash,
      metricSelectionRevision: 1,
    });
    expect(
      await prisma.auditLog.count({
        where: { resourceId: activityId, event: 'activity.metric-selection.command' },
      }),
    ).toBe(1);

    const change = await request(httpServer(app))
      .post(`${APP}/${activityId}/change-reviews`)
      .set('Authorization', creatorAuth)
      .send({
        operationKey: unique('change'),
        confirmation: true,
        activityPatch: { title: 'C1 D2c V7 已变更标题' },
        sessions: { create: [], update: [], cancel: [] },
        positions: { create: [], update: [], cancel: [] },
        metricSelection: { metricRequirementCode: 'not_required', metricSetPointer: null },
        expectedMetricSelectionRevision: 1,
      })
      .expect(200);
    const snapshot = change.body.data.snapshot as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      schemaVersion: 7,
      metricSelectionExplicit: true,
      metricRequirementCode: 'not_required',
      metricSetPointer: null,
      metricSelectionRevision: 2,
      base: {
        metricRequirementCode: 'required',
        metricSetPointer: pointer,
        metricSelectionRevision: 1,
      },
    });

    const detail = await request(httpServer(app))
      .get(`${ADMIN}/activity-publish-reviews/${change.body.data.id as string}`)
      .set('Authorization', reviewerAuth)
      .expect(200);
    expect(detail.body.data.changeDiff).toMatchObject({
      kind: 'proposal-v7',
      activityFields: ['title'],
      v7Fields: {
        changedFields: ['metricRequirementCode', 'metricSetPointer', 'metricSelectionRevision'],
      },
    });
    const safeDiff = JSON.stringify(detail.body.data.changeDiff);
    expect(safeDiff).not.toContain(pointer.definitionHash);
    expect(safeDiff).not.toContain(pointer.code);
    expect(safeDiff).not.toContain('V7 精确指标集');
    expect(safeDiff).not.toContain('completed');

    await approve(change.body.data.id as string).expect(200);
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
      metricSelectionRevision: 2,
    });
    expect(
      await prisma.auditLog.count({
        where: { resourceId: activityId, event: 'activity.metric-selection.command' },
      }),
    ).toBe(1);
  });
});
