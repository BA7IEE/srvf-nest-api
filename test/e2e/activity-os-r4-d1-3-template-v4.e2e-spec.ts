import { BindingScopeType, PrincipalType } from '@prisma/client';
import request from 'supertest';

import {
  ACTIVITY_TEMPLATE_PERMISSION_SEED,
  ACTIVITY_TIME_POLICY_PERMISSION_SEED,
} from '../../src/modules/permissions/permission-catalog';
import {
  closeD13Fixture,
  createD13ActivePolicy,
  createD13Fixture,
  D13_APP,
  type D13Fixture,
} from '../helpers/activity-time-policy.fixture';
import { httpServer } from '../helpers/http-server';

const TEMPLATE_ROOT = '/api/admin/v1/activity-template-versions';

describe('D1-3 V4 template time-policy materialization', () => {
  let fixture: D13Fixture;
  const previousResponsibilityWorkflow = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
  const previousControlPlaneMode = process.env.ACTIVITY_OS_CONTROL_PLANE_MODE;

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    process.env.ACTIVITY_OS_CONTROL_PLANE_MODE = 'active';
    fixture = await createD13Fixture();
    await grantGlobalCataloguePermissions(fixture);
    const category = await fixture.db.dictType.create({
      data: { code: 'activity_category', label: 'D1-3 活动分类' },
    });
    await fixture.db.dictItem.create({
      data: { typeId: category.id, code: 'd1_3_category', label: 'D1-3 分类' },
    });
  });

  afterAll(async () => {
    await closeD13Fixture(fixture);
    if (previousResponsibilityWorkflow === undefined) {
      delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
    } else {
      process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = previousResponsibilityWorkflow;
    }
    if (previousControlPlaneMode === undefined) {
      delete process.env.ACTIVITY_OS_CONTROL_PLANE_MODE;
    } else {
      process.env.ACTIVITY_OS_CONTROL_PLANE_MODE = previousControlPlaneMode;
    }
  });

  it('creates a V4 template through HTTP and freezes its four-layer selection into a new activity', async () => {
    const defaultPointer = await createD13ActivePolicy(fixture);
    const sessionPointer = await createD13ActivePolicy(fixture);
    const positionPointer = await createD13ActivePolicy(fixture);
    const definition = {
      activity: { allocationModeCode: 'first_come' },
      sessions: [
        {
          code: 'primary_session',
          name: 'D1-3 主场次',
          startOffsetMinutes: 0,
          endOffsetMinutes: 120,
          locationText: 'D1-3 集合点',
          checkInOpenOffsetMinutes: 0,
          checkInCloseOffsetMinutes: 30,
          checkOutOpenOffsetMinutes: -30,
          checkOutCloseOffsetMinutes: 0,
          positions: [
            {
              code: 'primary_position',
              name: 'D1-3 主岗位',
              attendanceRoleCode: 'service',
              capacity: 10,
              startOffsetMinutes: 30,
              endOffsetMinutes: 90,
            },
          ],
        },
      ],
      registrationForm: null,
      metricSelection: { metricRequirementCode: 'not_required', metricSetPointer: null },
      timePolicySelection: {
        default: { mode: 'explicit', pointer: defaultPointer },
        sessionOverrides: [
          {
            sessionCode: 'primary_session',
            selection: { mode: 'explicit', pointer: sessionPointer },
          },
        ],
        positionOverrides: [
          {
            sessionCode: 'primary_session',
            positionCode: 'primary_position',
            selection: { mode: 'explicit', pointer: positionPointer },
          },
        ],
      },
    };
    const createdTemplate = await request(httpServer(fixture.app))
      .post(TEMPLATE_ROOT)
      .set('Authorization', fixture.creator.auth)
      .send({
        operationKey: fixture.key('create_v4_template'),
        code: fixture.key('template_code'),
        name: 'D1-3 V4 模板',
        categoryCode: 'd1_3_category',
        activityTypeCode: 'event_support',
        version: 1,
        effectiveFrom: '2098-01-01T00:00:00.000Z',
        schemaVersion: 4,
        definition,
      })
      .expect(201);
    expect(createdTemplate.body.data).toMatchObject({ schemaVersion: 4, statusCode: 'draft' });

    await request(httpServer(fixture.app))
      .post(`${TEMPLATE_ROOT}/${createdTemplate.body.data.id as string}/activate`)
      .set('Authorization', fixture.creator.auth)
      .send({
        operationKey: fixture.key('activate_v4_template'),
        expectedDefinitionHash: createdTemplate.body.data.definitionHash,
        schemaVersion: 4,
      })
      .expect(200);

    const createdActivity = await request(httpServer(fixture.app))
      .post(`${D13_APP}/from-template`)
      .set('Authorization', fixture.creator.auth)
      .send({
        operationKey: fixture.key('create_from_v4_template'),
        title: 'D1-3 V4 模板活动',
        organizationId: fixture.organizationId,
        startAt: '2099-09-01T08:00:00.000Z',
        endAt: '2099-09-01T10:00:00.000Z',
        location: 'D1-3 集合点',
        templateVersionId: createdTemplate.body.data.id,
        defaultPlaceVisibilityCode: 'staff',
      })
      .expect(201);
    const activityId = createdActivity.body.data.activity.activityId as string;

    const selection = await request(httpServer(fixture.app))
      .get(`${D13_APP}/${activityId}/time-policy-selection?pageSize=10`)
      .set('Authorization', fixture.creator.auth)
      .expect(200);
    expect(selection.body.data).toMatchObject({
      activityId,
      revision: 1,
      total: 4,
      resolutionSummary: { targetCount: 3, resolvedTargetCount: 3, unresolvedTargetCount: 0 },
    });
    const items = selection.body.data.items as Array<{
      scope: { layerCode: string; sessionId: string | null; positionId: string | null };
      selection: { mode: string; pointer: unknown };
    }>;
    expect(items).toHaveLength(4);
    expect(items.find((item) => item.scope.layerCode === 'template')).toMatchObject({
      scope: { layerCode: 'template', sessionId: null, positionId: null },
      selection: { mode: 'explicit', pointer: defaultPointer },
    });
    expect(items.find((item) => item.scope.layerCode === 'activity')).toMatchObject({
      scope: { layerCode: 'activity', sessionId: null, positionId: null },
      selection: { mode: 'inherit', pointer: null },
    });
    expect(items.find((item) => item.scope.layerCode === 'session')).toMatchObject({
      selection: { mode: 'explicit', pointer: sessionPointer },
    });
    expect(items.find((item) => item.scope.layerCode === 'position')).toMatchObject({
      selection: { mode: 'explicit', pointer: positionPointer },
    });

    const stored = await fixture.db.activity.findUniqueOrThrow({
      where: { id: activityId },
      select: {
        selectedTemplateVersionId: true,
        timePolicySelectionRevision: true,
        currentTimePolicySelectionRevisionId: true,
        timePolicySelectionRevisions: {
          select: {
            id: true,
            revision: true,
            originCode: true,
            templateId: true,
            templateDefinitionHash: true,
          },
        },
      },
    });
    expect(stored.selectedTemplateVersionId).toBe(createdTemplate.body.data.id);
    expect(stored.timePolicySelectionRevision).toBe(1);
    expect(stored.timePolicySelectionRevisions).toHaveLength(1);
    expect(stored.timePolicySelectionRevisions[0]).toMatchObject({
      id: stored.currentTimePolicySelectionRevisionId,
      revision: 1,
      originCode: 'template_creation',
      templateId: createdTemplate.body.data.id,
      templateDefinitionHash: createdTemplate.body.data.definitionHash,
    });
  });
});

async function grantGlobalCataloguePermissions(fixture: D13Fixture): Promise<void> {
  const codes = ['activity-template.manage.version', 'activity-time-policy.read.catalog'] as const;
  const seeds = [...ACTIVITY_TEMPLATE_PERMISSION_SEED, ...ACTIVITY_TIME_POLICY_PERMISSION_SEED];
  for (const code of codes) {
    const seed = seeds.find((candidate) => candidate.code === code);
    if (!seed) throw new Error(`D1-3 catalogue permission seed is missing: ${code}`);
    await fixture.db.permission.upsert({ where: { code }, create: seed, update: {} });
  }
  const role = await fixture.db.rbacRole.create({
    data: { code: fixture.key('v4_catalogue_role'), displayName: 'D1-3 V4 目录测试角色' },
  });
  const permissions = await fixture.db.permission.findMany({
    where: { code: { in: [...codes] } },
    select: { id: true },
  });
  if (permissions.length !== codes.length)
    throw new Error('D1-3 catalogue permissions are incomplete');
  await fixture.db.rolePermission.createMany({
    data: permissions.map((permission) => ({ roleId: role.id, permissionId: permission.id })),
  });
  await fixture.db.roleBinding.create({
    data: {
      principalType: PrincipalType.USER,
      principalId: fixture.creator.id,
      roleId: role.id,
      scopeType: BindingScopeType.GLOBAL,
    },
  });
}
