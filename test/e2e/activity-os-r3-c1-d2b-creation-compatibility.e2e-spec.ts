import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityFromTemplateService } from '../../src/modules/activities/activity-from-template.service';
import { ActivityCreationService } from '../../src/modules/activities/activity-creation.service';
import { mapQuickCreation } from '../../src/modules/activities/activity-creation-command';
import { ActivitySeriesService } from '../../src/modules/activities/activity-series.service';
import { ActivityMetricSelectionAuditRecorder } from '../../src/modules/activities/activity-metric-selection-audit-recorder';
import type {
  ActivityMetricSelection,
  ActivityMetricSetPointer,
} from '../../src/modules/activities/activity-metric-selection';
import { computeActivityTemplateDefinitionHash } from '../../src/modules/activities/activity-template-definition';
import { createTestUser } from '../fixtures/users.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const ROOT = '/api/app/v1/my/managed-activities';
const START = '2099-09-01T08:00:00.000Z';
const END = '2099-09-01T10:00:00.000Z';
const META = { requestId: 'c1-d2b-creation', ip: null, ua: null };
type CreationBody = {
  code: number;
  data: {
    activity: { activityId: string; createdAt: string; createdStatusCode: string };
    mode: string;
    replayed: boolean;
    followUpItems?: unknown[];
  };
};
const notRequired: ActivityMetricSelection = {
  metricRequirementCode: 'not_required',
  metricSetPointer: null,
};

describe('C1 D2b five materialization chains and legacy compatibility', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let actor: CurrentUserPayload;
  let auth: string;
  let organizationId: string;
  let memberId: string;
  let sequence = 0;
  const unique = (label: string) => `d2b_${label}_${++sequence}`;
  const oldWorkflow = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
  const oldMode = process.env.ACTIVITY_OS_CONTROL_PLANE_MODE;

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    process.env.ACTIVITY_OS_CONTROL_PLANE_MODE = 'active';
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ActivityMetricCommandReceipt", "ActivityMetricSetItem", "ActivityMetricSetVersion", "ActivityMetricDefinition", "ActivityTemplate", "ActivityTemplateFamily", "ActivitySeriesCommandReceipt", "ActivitySeriesOccurrence", "ActivitySeriesRevision", "ActivitySeries" RESTART IDENTITY CASCADE',
    );
    const root = await prisma.organization.create({
      data: { name: unique('root'), nodeTypeCode: 'root' },
    });
    const org = await prisma.organization.create({
      data: { name: unique('org'), nodeTypeCode: 'team', parentId: root.id },
    });
    organizationId = org.id;
    await prisma.organizationClosure.createMany({
      data: [
        { ancestorId: org.id, descendantId: org.id, depth: 0 },
        { ancestorId: root.id, descendantId: org.id, depth: 1 },
      ],
    });
    const member = await prisma.member.create({
      data: {
        memberNo: unique('member'),
        ...memberIdentityData('指标选择测试'),
        gradeCode: 'level-3',
      },
    });
    memberId = member.id;
    const user = await createTestUser(app, { username: unique('actor'), role: Role.SUPER_ADMIN });
    await prisma.user.update({ where: { id: user.id }, data: { memberId } });
    actor = {
      id: user.id,
      username: user.username,
      role: Role.SUPER_ADMIN,
      status: 'ACTIVE',
      memberId,
    };
    await prisma.memberOrganizationMembership.create({ data: { memberId, organizationId } });
    auth = (await loginAs(app, user.username)).authHeader;
    for (const typeCode of ['activity_type', 'activity_category']) {
      const type = await prisma.dictType.create({ data: { code: typeCode, label: typeCode } });
      await prisma.dictItem.create({
        data: { typeId: type.id, code: 'd2b_training', label: '测试训练' },
      });
    }
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await app?.close();
    if (oldWorkflow === undefined) delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
    else process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = oldWorkflow;
    if (oldMode === undefined) delete process.env.ACTIVITY_OS_CONTROL_PLANE_MODE;
    else process.env.ACTIVITY_OS_CONTROL_PLANE_MODE = oldMode;
  });

  const send = (path: string, body: object) =>
    request(httpServer(app)).post(path).set('Authorization', auth).send(body);
  function base() {
    return {
      operationKey: unique('command'),
      title: '指标创建测试',
      organizationId,
      initiatorMemberId: memberId,
      startAt: START,
      endAt: END,
      location: '集合点',
    };
  }
  function input(mode: 'professional' | 'emergency', metricSelection?: ActivityMetricSelection) {
    return {
      ...base(),
      activityTypeCode: 'd2b_training',
      allocationModeCode: 'first_come',
      ...(mode === 'emergency'
        ? { memberIds: [memberId] }
        : {
            sessions: [
              {
                session: {
                  code: 'morning',
                  name: '上午',
                  startAt: START,
                  endAt: END,
                  locationText: '集合点',
                  checkInOpenAt: START,
                  checkInCloseAt: START,
                  checkOutOpenAt: END,
                  checkOutCloseAt: END,
                  locationRequired: false,
                },
                positions: [],
              },
            ],
          }),
      ...(metricSelection === undefined ? {} : { metricSelection }),
    };
  }
  async function catalogue(): Promise<ActivityMetricSetPointer> {
    const defs = '/api/admin/v1/activity-metric-definitions';
    const sets = '/api/admin/v1/activity-metric-sets';
    const d = await send(defs, {
      operationKey: unique('d'),
      definition: {
        schemaVersion: 1,
        code: unique('def'),
        version: 1,
        name: '完成指标',
        configuration: { kindCode: 'boolean', unit: null },
      },
    }).expect(201);
    const definition = d.body.data as ActivityMetricSetPointer;
    await send(`${defs}/${definition.id}/activate`, {
      operationKey: unique('da'),
      expectedDefinitionHash: definition.definitionHash,
    }).expect(200);
    const s = await send(sets, {
      operationKey: unique('s'),
      definition: {
        schemaVersion: 1,
        code: unique('set'),
        version: 1,
        name: '测试指标集',
        items: [
          {
            key: 'done',
            sortOrder: 0,
            required: true,
            metricDefinitionId: definition.id,
            definitionHash: definition.definitionHash,
          },
        ],
      },
    }).expect(201);
    const set = s.body.data as ActivityMetricSetPointer;
    await send(`${sets}/${set.id}/activate`, {
      operationKey: unique('sa'),
      expectedDefinitionHash: set.definitionHash,
    }).expect(200);
    return {
      id: set.id,
      code: set.code,
      version: set.version,
      schemaVersion: 1,
      definitionHash: set.definitionHash,
    };
  }
  async function template(selection: ActivityMetricSelection) {
    const root = '/api/admin/v1/activity-template-versions';
    const created = await send(root, {
      operationKey: unique('t'),
      code: unique('template'),
      name: '测试模板',
      categoryCode: 'd2b_training',
      activityTypeCode: 'd2b_training',
      version: 1,
      effectiveFrom: '2000-01-01T00:00:00.000Z',
      definition: {
        activity: { allocationModeCode: 'first_come' },
        sessions: [],
        registrationForm: null,
        metricSelection: selection,
      },
    }).expect((response) =>
      expect({ status: response.status, body: response.body as unknown }).toEqual({
        status: 201,
        body: expect.objectContaining({ code: 0 }),
      }),
    );
    const row = created.body.data as { id: string; definitionHash: string };
    await send(`${root}/${row.id}/activate`, {
      operationKey: unique('ta'),
      expectedDefinitionHash: row.definitionHash,
    }).expect(200);
    return row;
  }
  async function assertSelection(id: string, selection: ActivityMetricSelection | null) {
    const row = await prisma.activity.findUniqueOrThrow({
      where: { id },
      select: {
        metricRequirementCode: true,
        selectedMetricSetVersionId: true,
        selectedMetricSetDefinitionHash: true,
        metricSelectionRevision: true,
      },
    });
    expect(row).toEqual({
      metricRequirementCode: selection?.metricRequirementCode ?? null,
      selectedMetricSetVersionId: selection?.metricSetPointer?.id ?? null,
      selectedMetricSetDefinitionHash: selection?.metricSetPointer?.definitionHash ?? null,
      metricSelectionRevision: selection ? 1 : 0,
    });
  }

  it.each(['professional', 'emergency'] as const)(
    '%s optional selection is absent for old requests and explicit on new commands',
    async (mode) => {
      for (const selection of [
        undefined,
        notRequired,
        { metricRequirementCode: 'required', metricSetPointer: await catalogue() } as const,
      ]) {
        const command = input(mode, selection);
        const first = (await send(`${ROOT}/${mode}`, command).expect(201)).body as CreationBody;
        const id = first.data.activity.activityId;
        await assertSelection(id, selection ?? null);
        const audits = await prisma.auditLog.count({
          where: { resourceId: id, event: 'activity.metric-selection.command' },
        });
        expect(audits).toBe(selection ? 1 : 0);
        const replay = (await send(`${ROOT}/${mode}`, command).expect(201)).body as CreationBody;
        expect(replay.data).toEqual({ ...first.data, replayed: true });
        await assertSelection(id, selection ?? null);
        expect(
          await prisma.auditLog.count({
            where: { resourceId: id, event: 'activity.metric-selection.command' },
          }),
        ).toBe(audits);
      }
    },
  );
  it('quick V3 forwards the current authorized actor to its creation audit', async () => {
    const selected = await template(notRequired);
    const permission = await prisma.permission.upsert({
      where: { code: 'activity.create.record' },
      update: {},
      create: {
        code: 'activity.create.record',
        module: 'activity',
        action: 'create',
        resourceType: 'record',
        description: 'test',
      },
    });
    const role = await prisma.rbacRole.create({
      data: { code: unique('role'), displayName: '创建测试' },
    });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    await prisma.roleBinding.create({
      data: { principalType: 'USER', principalId: actor.id, roleId: role.id, scopeType: 'GLOBAL' },
    });
    await prisma.user.update({ where: { id: actor.id }, data: { role: Role.ADMIN } });
    try {
      const result = await app.get(ActivityCreationService).createQuick(
        mapQuickCreation({
          ...base(),
          templateVersionId: selected.id,
          defaultPlaceVisibilityCode: 'staff',
        }),
        actor, // Deliberately stale SUPER_ADMIN request identity.
        META,
      );
      const logs = await prisma.auditLog.findMany({
        where: {
          resourceId: result.activity.activityId,
          event: 'activity.publish',
        },
        select: { actorRoleSnap: true },
      });
      expect(logs).toHaveLength(1);
      expect(logs).toEqual([{ actorRoleSnap: Role.ADMIN }]);
    } finally {
      await prisma.user.update({ where: { id: actor.id }, data: { role: Role.SUPER_ADMIN } });
    }
  });
  it.each([1, 2] as const)(
    'quick V%s keeps the old unconfigured state and response after replay',
    async (schemaVersion) => {
      const family = await prisma.activityTemplateFamily.create({
        data: {
          code: unique('legacy'),
          name: '历史模板',
          categoryCode: 'd2b_training',
          scopeTypeCode: 'global',
          statusCode: 'active',
        },
      });
      const definition = {
        activity: { allocationModeCode: 'first_come' },
        sessions: [],
        ...(schemaVersion === 2 ? { registrationForm: null } : {}),
      };
      const row = await prisma.activityTemplate.create({
        data: {
          familyId: family.id,
          code: family.code,
          name: family.name,
          activityTypeCode: 'd2b_training',
          version: 1,
          schemaVersion,
          statusCode: 'draft',
          effectiveFrom: new Date('2000-01-01'),
          definitionJson: definition,
          definitionHash: computeActivityTemplateDefinitionHash({ schemaVersion, definition }),
        },
      });
      await prisma.activityTemplate.update({
        where: { id: row.id },
        data: { statusCode: 'active' },
      });
      const command = { ...base(), templateVersionId: row.id, defaultPlaceVisibilityCode: 'staff' };
      const first = (await send(`${ROOT}/from-template`, command).expect(201)).body as CreationBody;
      await assertSelection(first.data.activity.activityId, null);
      const replay = (await send(`${ROOT}/from-template`, command).expect(201))
        .body as CreationBody;
      expect(replay.data).toEqual({ ...first.data, replayed: true });
    },
  );
  it('A6 and quick V3 materialize exact selections and keep the selected template pointer', async () => {
    const selection = {
      metricRequirementCode: 'required',
      metricSetPointer: await catalogue(),
    } as const;
    const row = await template(selection);
    const direct = await app
      .get(ActivityFromTemplateService)
      .createFromTemplate({ ...base(), templateVersionId: row.id }, actor, META);
    await assertSelection(direct.id, selection);
    const command = { ...base(), templateVersionId: row.id, defaultPlaceVisibilityCode: 'staff' };
    const first = (await send(`${ROOT}/from-template`, command).expect(201)).body as CreationBody;
    await assertSelection(first.data.activity.activityId, selection);
    expect(
      (await prisma.activity.findUniqueOrThrow({ where: { id: first.data.activity.activityId } }))
        .selectedTemplateVersionId,
    ).toBe(row.id);
    await send(`/api/admin/v1/activity-metric-sets/${selection.metricSetPointer.id}/retire`, {
      operationKey: unique('retire'),
      expectedDefinitionHash: selection.metricSetPointer.definitionHash,
    }).expect(200);
    const replay = (await send(`${ROOT}/from-template`, command).expect(201)).body as CreationBody;
    expect(replay.data).toEqual({ ...first.data, replayed: true });
    const before = await prisma.activity.count();
    expectBizError(
      await send(`${ROOT}/from-template`, { ...command, operationKey: unique('new') }),
      BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE,
    );
    expect(await prisma.activity.count()).toBe(before);
  });
  it('clone copies configured selection at revision 1 without copying source command receipts', async () => {
    const selection = {
      metricRequirementCode: 'required',
      metricSetPointer: await catalogue(),
    } as const;
    const first = (await send(`${ROOT}/professional`, input('professional', selection)).expect(201))
      .body as CreationBody;
    const result = await send(`${ROOT}/${first.data.activity.activityId}/clone`, {
      title: '复制测试',
    }).expect(201);
    const id = (result.body.data as { activityId: string }).activityId;
    await assertSelection(id, selection);
    expect(await prisma.activityCreationCommandReceipt.count({ where: { activityId: id } })).toBe(
      0,
    );
    expect(await prisma.activityMetricCommandReceipt.count({ where: { activityId: id } })).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: { resourceId: id, event: 'activity.metric-selection.command' },
      }),
    ).toBe(1);
  });
  it('Series V3 freezes each new instance while leaving its initiator empty and replay unchanged', async () => {
    const row = await template(notRequired);
    const service = app.get(ActivitySeriesService);
    const series = await service.create(
      {
        code: unique('series').replaceAll('_', '-'),
        templateVersionId: row.id,
        frequencyCode: 'daily',
        interval: 1,
        timeZone: 'Asia/Shanghai',
        localStartDate: '2099-01-01',
        localStartMinute: 540,
        durationMinutes: 120,
        title: '周期测试',
        organizationId,
        location: '集合点',
        registrationDeadlineOffsetMinutes: 60,
        effectiveFromLocalDate: '2099-01-01',
        effectiveToLocalDate: '2099-03-31',
        generationWindowDays: 31,
        operationKey: unique('series_create'),
      },
      actor,
      META,
    );
    const command = {
      seriesId: series.seriesId,
      revision: 1,
      fromLocalDate: '2099-01-01',
      count: 2,
      operationKey: unique('generate'),
    };
    const result = await service.generate(command, actor, META);
    for (const id of result.activityIds) {
      await assertSelection(id, notRequired);
      expect(
        (await prisma.activity.findUniqueOrThrow({ where: { id } })).initiatorMemberId,
      ).toBeNull();
    }
    expect(await service.generate(command, actor, META)).toEqual(result);
  });
  it('initial selection audit failure rolls back Activity, creation receipt and all children', async () => {
    const before = await prisma.activity.count();
    const receipts = await prisma.activityCreationCommandReceipt.count();
    jest
      .spyOn(app.get(ActivityMetricSelectionAuditRecorder), 'log')
      .mockRejectedValueOnce(new BizException(BizCode.INTERNAL_ERROR));
    expectBizError(
      await send(`${ROOT}/professional`, input('professional', notRequired)),
      BizCode.INTERNAL_ERROR,
    );
    expect(await prisma.activity.count()).toBe(before);
    expect(await prisma.activityCreationCommandReceipt.count()).toBe(receipts);
  });
});
