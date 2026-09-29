import { BindingScopeType, PrincipalType } from '@prisma/client';
import request from 'supertest';

import {
  ACTIVITY_TEMPLATE_PERMISSION_SEED,
  ACTIVITY_CONTRIBUTION_POLICY_PERMISSION_SEED,
  ACTIVITY_TIME_POLICY_PERMISSION_SEED,
  CONTRIBUTION_POLICY_PERMISSION_SEED,
} from '../../src/modules/permissions/permission-catalog';
import {
  closeE13Fixture,
  createE13ActivePolicy,
  createE13Fixture,
  E13_APP,
  type E13Fixture,
} from '../helpers/activity-contribution-policy.fixture';
import { httpServer } from '../helpers/http-server';

const TEMPLATE_ROOT = '/api/admin/v1/activity-template-versions';

describe('E1-3 V5 template contribution-policy materialization', () => {
  let fixture: E13Fixture;
  const previousResponsibilityWorkflow = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
  const previousControlPlaneMode = process.env.ACTIVITY_OS_CONTROL_PLANE_MODE;

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    process.env.ACTIVITY_OS_CONTROL_PLANE_MODE = 'active';
    fixture = await createE13Fixture();
    await grantGlobalCataloguePermissions(fixture);
    const category = await fixture.db.dictType.create({
      data: { code: 'activity_category', label: 'E1-3 活动分类' },
    });
    await fixture.db.dictItem.create({
      data: { typeId: category.id, code: 'd1_3_category', label: 'E1-3 分类' },
    });
  });

  afterAll(async () => {
    await closeE13Fixture(fixture);
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

  it('creates a V5 template through HTTP and resolves its three-layer selection in a new activity', async () => {
    const defaultPointer = await createE13ActivePolicy(fixture);
    const positionPointer = await createE13ActivePolicy(fixture);
    const definition = {
      activity: { allocationModeCode: 'first_come' },
      sessions: [
        {
          code: 'primary_session',
          name: 'E1-3 主场次',
          startOffsetMinutes: 0,
          endOffsetMinutes: 120,
          locationText: 'E1-3 集合点',
          checkInOpenOffsetMinutes: 0,
          checkInCloseOffsetMinutes: 30,
          checkOutOpenOffsetMinutes: -30,
          checkOutCloseOffsetMinutes: 0,
          positions: [
            {
              code: 'primary_position',
              name: 'E1-3 主岗位',
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
        default: { mode: 'inherit', pointer: null },
        sessionOverrides: [],
        positionOverrides: [],
      },
      contributionPolicySelection: {
        activityDefault: { mode: 'explicit', pointer: defaultPointer },
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
        operationKey: fixture.key('create_v5_template'),
        code: fixture.key('template_code'),
        name: 'E1-3 V5 模板',
        categoryCode: 'd1_3_category',
        activityTypeCode: 'event_support',
        version: 1,
        effectiveFrom: '2098-01-01T00:00:00.000Z',
        schemaVersion: 5,
        definition,
      })
      .expect(201);
    expect(createdTemplate.body.data).toMatchObject({ schemaVersion: 5, statusCode: 'draft' });

    await request(httpServer(fixture.app))
      .post(`${TEMPLATE_ROOT}/${createdTemplate.body.data.id as string}/activate`)
      .set('Authorization', fixture.creator.auth)
      .send({
        operationKey: fixture.key('activate_v5_template'),
        expectedDefinitionHash: createdTemplate.body.data.definitionHash,
        schemaVersion: 5,
      })
      .expect(200);

    const createdActivity = await request(httpServer(fixture.app))
      .post(`${E13_APP}/from-template`)
      .set('Authorization', fixture.creator.auth)
      .send({
        operationKey: fixture.key('create_from_v5_template'),
        title: 'E1-3 V5 模板活动',
        organizationId: fixture.organizationId,
        startAt: '2099-09-01T08:00:00.000Z',
        endAt: '2099-09-01T10:00:00.000Z',
        location: 'E1-3 集合点',
        templateVersionId: createdTemplate.body.data.id,
        defaultPlaceVisibilityCode: 'staff',
      });
    if (createdActivity.status !== 201) {
      throw new Error(
        `E1-3 V5 activity creation failed: status=${createdActivity.status} code=${String(createdActivity.body?.code)}`,
      );
    }
    const activityId = createdActivity.body.data.activity.activityId as string;

    const selection = await request(httpServer(fixture.app))
      .get(`${E13_APP}/${activityId}/contribution-policy-selection?pageSize=10`)
      .set('Authorization', fixture.creator.auth)
      .expect(200);
    expect(selection.body.data).toMatchObject({
      activityId,
      revision: 1,
      total: 1,
      resolutionSummary: { targetCount: 2, resolvedTargetCount: 2, unresolvedTargetCount: 0 },
    });
    const items = selection.body.data.items as Array<{
      scope: { layerCode: string; sessionId: string | null; positionId: string | null };
      selection: { mode: string; pointer: unknown };
    }>;
    expect(items).toHaveLength(1);
    expect(items.find((item) => item.scope.layerCode === 'activity')).toMatchObject({
      scope: { layerCode: 'activity', sessionId: null, positionId: null },
      selection: { mode: 'inherit', pointer: null },
    });
    expect(selection.body.data.resolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: { layerCode: 'activity', sessionId: null, positionId: null },
          pointer: defaultPointer,
          sourceLayerCode: 'template',
        }),
        expect.objectContaining({
          scope: expect.objectContaining({ layerCode: 'position' }),
          pointer: positionPointer,
          sourceLayerCode: 'template',
        }),
      ]),
    );

    const stored = await fixture.db.activity.findUniqueOrThrow({
      where: { id: activityId },
      select: {
        selectedTemplateVersionId: true,
        contributionPolicySelectionRevision: true,
        currentContributionPolicySelectionRevisionId: true,
        contributionPolicySelectionRevisions: {
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
    expect(stored.contributionPolicySelectionRevision).toBe(1);
    expect(stored.contributionPolicySelectionRevisions).toHaveLength(1);
    expect(stored.contributionPolicySelectionRevisions[0]).toMatchObject({
      id: stored.currentContributionPolicySelectionRevisionId,
      revision: 1,
      originCode: 'template_creation',
      templateId: createdTemplate.body.data.id,
      templateDefinitionHash: createdTemplate.body.data.definitionHash,
    });
  });
});

async function grantGlobalCataloguePermissions(fixture: E13Fixture): Promise<void> {
  const codes = [
    'activity-template.manage.version',
    'activity.time-policy.select',
    'contribution-policy.read.catalog',
  ] as const;
  const seeds = [
    ...ACTIVITY_TEMPLATE_PERMISSION_SEED,
    ...ACTIVITY_TIME_POLICY_PERMISSION_SEED,
    ...CONTRIBUTION_POLICY_PERMISSION_SEED,
    ...ACTIVITY_CONTRIBUTION_POLICY_PERMISSION_SEED,
  ];
  for (const code of codes) {
    const seed = seeds.find((candidate) => candidate.code === code);
    if (!seed) throw new Error(`E1-3 catalogue permission seed is missing: ${code}`);
    await fixture.db.permission.upsert({ where: { code }, create: seed, update: {} });
  }
  const role = await fixture.db.rbacRole.create({
    data: { code: fixture.key('v5_catalogue_role'), displayName: 'E1-3 V5 目录测试角色' },
  });
  const permissions = await fixture.db.permission.findMany({
    where: { code: { in: [...codes] } },
    select: { id: true },
  });
  if (permissions.length !== codes.length)
    throw new Error('E1-3 catalogue permissions are incomplete');
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
