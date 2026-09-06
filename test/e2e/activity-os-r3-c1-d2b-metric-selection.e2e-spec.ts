import type { INestApplication } from '@nestjs/common';
import { Role, type Activity, type Prisma } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityMetricSelectionAuditRecorder } from '../../src/modules/activities/activity-metric-selection-audit-recorder';
import { parseActivityMetricSelectionReceipt } from '../../src/modules/activities/activity-metric-selection';
import { parseMetricReceipt } from '../../src/modules/activities/activity-metric-command';
import { createTestUser } from '../fixtures/users.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertConnectedTestDatabase } from '../setup/test-db';

const selection = { metricRequirementCode: 'not_required', metricSetPointer: null } as const;
const ADMIN = '/api/admin/v1/activities';
const APP = '/api/app/v1/my/managed-activities';
const DEFS = '/api/admin/v1/activity-metric-definitions';
const SETS = '/api/admin/v1/activity-metric-sets';

describe('C1 D2b metric selection HTTP boundary and rollback', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let rootAuth: string;
  let rootId: string;
  let organizationId: string;
  let roleId: string;
  let sequence = 0;
  const key = () => `selection_${++sequence}`;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);
    await assertConnectedTestDatabase(prisma);
    await prisma.$executeRaw`TRUNCATE "ActivityMetricCommandReceipt", "ActivityMetricSetItem", "ActivityMetricSetVersion", "ActivityMetricDefinition" CASCADE`;
    const root = await createTestUser(app, { username: key(), role: Role.SUPER_ADMIN });
    rootId = root.id;
    rootAuth = (await loginAs(app, root.username)).authHeader;
    const parent = await prisma.organization.create({
      data: { name: key(), nodeTypeCode: 'root' },
    });
    const org = await prisma.organization.create({
      data: { name: key(), nodeTypeCode: 'team', parentId: parent.id },
    });
    organizationId = org.id;
    const permission = await prisma.permission.upsert({
      where: { code: 'activity.update.record' },
      update: {},
      create: {
        code: 'activity.update.record',
        module: 'activity',
        action: 'update',
        resourceType: 'record',
        description: 'test',
      },
    });
    const role = await prisma.rbacRole.create({
      data: { code: key(), displayName: '选择测试角色' },
    });
    roleId = role.id;
    await prisma.rolePermission.create({ data: { roleId, permissionId: permission.id } });
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await app?.close();
  });

  async function human(withMember = true, role: Role = Role.USER) {
    const user = await createTestUser(app, { username: key(), role });
    const member = withMember
      ? await prisma.member.create({
          data: { memberNo: key(), ...memberIdentityData('选择测试'), gradeCode: 'level-3' },
        })
      : null;
    if (member) await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    return {
      id: user.id,
      memberId: member?.id ?? null,
      auth: (await loginAs(app, user.username)).authHeader,
    };
  }
  function activity(
    memberId: string | null = null,
    data: Partial<Prisma.ActivityUncheckedCreateInput> = {},
  ) {
    return prisma.activity.create({
      data: {
        title: key(),
        activityTypeCode: 'training',
        allocationModeCode: 'first_come',
        organizationId,
        initiatorMemberId: memberId,
        startAt: new Date('2099-09-01'),
        endAt: new Date('2099-09-02'),
        location: '测试',
        statusCode: 'draft',
        ...data,
      },
    });
  }
  function grant(userId: string, activityId?: string) {
    return prisma.roleBinding.create({
      data: {
        principalType: 'USER',
        principalId: userId,
        roleId,
        scopeType: activityId ? 'ACTIVITY' : 'GLOBAL',
        scopeActivityId: activityId,
      },
    });
  }
  const read = (base: string, id: string, auth = rootAuth) =>
    request(httpServer(app)).get(`${base}/${id}/metric-selection`).set('Authorization', auth);
  const write = (base: string, id: string, body: object, auth = rootAuth) =>
    request(httpServer(app))
      .put(`${base}/${id}/metric-selection`)
      .set('Authorization', auth)
      .send(body);
  const command = (expectedRevision = 0) => ({
    operationKey: key(),
    expectedRevision,
    metricSelection: selection,
  });
  const post = (path: string, body: object) =>
    request(httpServer(app)).post(path).set('Authorization', rootAuth).send(body);
  async function unchanged(row: Activity) {
    expect(await prisma.activity.findUnique({ where: { id: row.id } })).toEqual(row);
    expect(await prisma.activityMetricCommandReceipt.count({ where: { activityId: row.id } })).toBe(
      0,
    );
    expect(
      await prisma.auditLog.count({
        where: { event: 'activity.metric-selection.command', resourceId: row.id },
      }),
    ).toBe(0);
  }
  async function catalogue() {
    const definition = parseMetricReceipt(
      (
        await post(DEFS, {
          operationKey: key(),
          definition: {
            schemaVersion: 1,
            code: key(),
            version: 1,
            name: '完成',
            configuration: { kindCode: 'boolean', unit: null },
          },
        }).expect(201)
      ).body.data,
    );
    await post(`${DEFS}/${definition.id}/activate`, {
      operationKey: key(),
      expectedDefinitionHash: definition.definitionHash,
    }).expect(200);
    const set = parseMetricReceipt(
      (
        await post(SETS, {
          operationKey: key(),
          definition: {
            schemaVersion: 1,
            code: key(),
            version: 1,
            name: '指标集',
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
        }).expect(201)
      ).body.data,
    );
    await post(`${SETS}/${set.id}/activate`, {
      operationKey: key(),
      expectedDefinitionHash: set.definitionHash,
    }).expect(200);
    return {
      definition,
      set,
      pointer: {
        id: set.id,
        code: set.code,
        version: set.version,
        schemaVersion: set.schemaVersion,
        definitionHash: set.definitionHash,
      },
    };
  }

  it('old Activity reads exactly six safe fields in the unconfigured state', async () => {
    const row = await activity();
    const result = await read(ADMIN, row.id).expect(200);
    expect(result.body).toEqual({
      code: 0,
      data: {
        activityId: row.id,
        metricRequirementCode: 'unconfigured',
        metricSetPointer: null,
        metricSelectionRevision: 0,
        metricSetName: null,
        selectable: false,
      },
      message: 'ok',
    });
    await unchanged(row);
  });
  it.each([ADMIN, APP])('%s requires a Human login', async (base) => {
    const row = await activity();
    expectBizError(
      await request(httpServer(app)).get(`${base}/${row.id}/metric-selection`),
      BizCode.UNAUTHORIZED,
    );
    expectBizError(
      await request(httpServer(app)).put(`${base}/${row.id}/metric-selection`).send(command()),
      BizCode.UNAUTHORIZED,
    );
    await unchanged(row);
  });
  it('App denies an otherwise privileged user without a current Member', async () => {
    const row = await activity();
    expectBizError(await read(APP, row.id), BizCode.FORBIDDEN);
    expectBizError(await write(APP, row.id, command()), BizCode.FORBIDDEN);
    await unchanged(row);
  });
  it('Admin privilege and catalogue management do not replace activity.update permission', async () => {
    const actor = await human(true, Role.ADMIN);
    const row = await activity(actor.memberId);
    const permission = await prisma.permission.upsert({
      where: { code: 'activity-template.manage.version' },
      update: {},
      create: {
        code: 'activity-template.manage.version',
        module: 'activity-template',
        action: 'manage',
        resourceType: 'version',
        description: 'test',
      },
    });
    const role = await prisma.rbacRole.create({ data: { code: key(), displayName: '模板角色' } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    await prisma.roleBinding.create({
      data: { principalType: 'USER', principalId: actor.id, roleId: role.id, scopeType: 'GLOBAL' },
    });
    expectBizError(await write(ADMIN, row.id, command(), actor.auth), BizCode.RBAC_FORBIDDEN);
    expectBizError(
      await write(ADMIN, 'missing_activity', command(), actor.auth),
      BizCode.RBAC_FORBIDDEN,
    );
    await unchanged(row);
  });
  it('scoped initiator can select through App, but not on another activity', async () => {
    const actor = await human();
    const row = await activity(actor.memberId);
    const other = await activity(actor.memberId);
    await grant(actor.id, row.id);
    const first = command();
    const result = await write(APP, row.id, first, actor.auth).expect(200);
    expect(result.body.data).toEqual({
      activityId: row.id,
      ...selection,
      metricSelectionRevision: 1,
    });
    expectBizError(await write(APP, other.id, command(), actor.auth), BizCode.RBAC_FORBIDDEN);
    await unchanged(other);
    const state = await read(APP, row.id, actor.auth).expect(200);
    expect(state.body.data).toEqual({
      activityId: row.id,
      ...selection,
      metricSelectionRevision: 1,
      metricSetName: null,
      selectable: true,
    });
  });
  it('read visibility remains Admin USER status filtering versus App managed relationship', async () => {
    const actor = await human();
    const own = await activity(actor.memberId);
    const unrelated = await activity();
    await read(APP, own.id, actor.auth).expect(200);
    expectBizError(await read(ADMIN, own.id, actor.auth), BizCode.ACTIVITY_NOT_FOUND);
    expectBizError(await read(APP, unrelated.id, actor.auth), BizCode.ACTIVITY_NOT_FOUND);
    const visible = await activity(null, { statusCode: 'published' });
    await read(ADMIN, visible.id, actor.auth).expect(200);
  });
  it('active collaborator may read but cannot edit a draft owned by another initiator', async () => {
    const actor = await human();
    const initiator = await human();
    const row = await activity(initiator.memberId);
    await grant(actor.id, row.id);
    await prisma.activityResponsibilityAssignment.create({
      data: {
        activityId: row.id,
        memberId: actor.memberId!,
        responsibilityType: 'collaborator',
        canManageRegistrations: true,
        canManageAttendance: false,
        assignedByUserId: rootId,
        source: 'admin',
      },
    });
    await read(APP, row.id, actor.auth).expect(200);
    expectBizError(await write(APP, row.id, command(), actor.auth), BizCode.ACTIVITY_NOT_FOUND);
    await unchanged(row);
  });
  it('new same-content command increments revision, replay returns original receipt without new audit', async () => {
    const row = await activity();
    const first = command();
    const one = parseActivityMetricSelectionReceipt(
      (await write(ADMIN, row.id, first).expect(200)).body.data,
      row.id,
    );
    const two = parseActivityMetricSelectionReceipt(
      (await write(ADMIN, row.id, command(1)).expect(200)).body.data,
      row.id,
    );
    expect(two).toEqual({ ...one, metricSelectionRevision: 2 });
    expect((await write(ADMIN, row.id, first).expect(200)).body.data).toEqual(one);
    expect(await prisma.activityMetricCommandReceipt.count({ where: { activityId: row.id } })).toBe(
      2,
    );
    const logs = await prisma.auditLog.findMany({
      where: { resourceId: row.id, event: 'activity.metric-selection.command' },
      orderBy: { createdAt: 'asc' },
    });
    expect(logs).toHaveLength(2);
    expect((logs[0].context as Prisma.JsonObject).extra).toEqual({
      operation: 'select_metric_set',
      source: 'admin',
      beforeMode: null,
      beforeRevision: 0,
      beforeHash: null,
      afterMode: 'not_required',
      afterRevision: 1,
      afterHash: null,
    });
    expect((logs[1].context as Prisma.JsonObject).extra).toEqual({
      operation: 'select_metric_set',
      source: 'admin',
      beforeMode: 'not_required',
      beforeRevision: 1,
      beforeHash: null,
      afterMode: 'not_required',
      afterRevision: 2,
      afterHash: null,
    });
  });
  it('same key with a different revision conflicts and a new stale key cannot write', async () => {
    const row = await activity();
    const first = command();
    await write(ADMIN, row.id, first).expect(200);
    expectBizError(
      await write(ADMIN, row.id, { ...first, expectedRevision: 1 }),
      BizCode.ACTIVITY_METRIC_SELECTION_COMMAND_CONFLICT,
    );
    expectBizError(await write(ADMIN, row.id, command()), BizCode.ACTIVITY_METRIC_SELECTION_STALE);
    expect(await prisma.activity.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      metricSelectionRevision: 1,
    });
    expect(await prisma.activityMetricCommandReceipt.count({ where: { activityId: row.id } })).toBe(
      1,
    );
  });
  it.each(['published', 'completed', 'cancelled', 'archived'])(
    'rejects %s without any writes',
    async (statusCode) => {
      const row = await activity(null, { statusCode });
      expectBizError(
        await write(ADMIN, row.id, command()),
        statusCode === 'published'
          ? BizCode.ACTIVITY_CHANGE_REVIEW_REQUIRED
          : BizCode.ACTIVITY_STATUS_INVALID,
      );
      await unchanged(row);
    },
  );
  it('pending publish review freezes selection including old-key replay', async () => {
    const row = await activity();
    const input = command();
    await write(ADMIN, row.id, input).expect(200);
    await prisma.activityPublishReview.create({
      data: {
        activityId: row.id,
        requestType: 'initial',
        requestVersion: 1,
        baseRevision: 0,
        status: 'pending',
        snapshot: {},
        submittedByUserId: rootId,
      },
    });
    expectBizError(await write(ADMIN, row.id, input), BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING);
    expectBizError(await write(ADMIN, row.id, command(1)), BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING);
    expect(await prisma.activityMetricCommandReceipt.count({ where: { activityId: row.id } })).toBe(
      1,
    );
  });
  it('retired set remains historically readable and replayable but cannot be newly selected', async () => {
    const row = await activity();
    const { set, pointer } = await catalogue();
    const input = {
      ...command(),
      metricSelection: { metricRequirementCode: 'required', metricSetPointer: pointer },
    };
    const first = await write(ADMIN, row.id, input).expect(200);
    await post(`${SETS}/${set.id}/retire`, {
      operationKey: key(),
      expectedDefinitionHash: set.definitionHash,
    }).expect(200);
    expect((await write(ADMIN, row.id, input).expect(200)).body.data).toEqual(first.body.data);
    const history = await read(ADMIN, row.id).expect(200);
    expect(history.body.data).toEqual({
      activityId: row.id,
      ...input.metricSelection,
      metricSelectionRevision: 1,
      metricSetName: '指标集',
      selectable: false,
    });
    expectBizError(
      await write(ADMIN, row.id, { ...input, operationKey: key(), expectedRevision: 1 }),
      BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE,
    );
    expect(await prisma.activityMetricCommandReceipt.count({ where: { activityId: row.id } })).toBe(
      1,
    );
  });
  it('a valid-looking wrong pointer hash is rejected before Activity, receipt or audit changes', async () => {
    const row = await activity();
    const { pointer } = await catalogue();
    expectBizError(
      await write(ADMIN, row.id, {
        ...command(),
        metricSelection: {
          metricRequirementCode: 'required',
          metricSetPointer: { ...pointer, definitionHash: 'a'.repeat(64) },
        },
      }),
      BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE,
    );
    await unchanged(row);
  });
  it.each([
    [
      { metricRequirementCode: 'unconfigured', metricSetPointer: null },
      'metricSelection.metricRequirementCode must be one of the following values: not_required, required',
    ],
    [
      { metricRequirementCode: 'not_required' },
      'metricSelection.metricSetPointer should not be null or undefined; metricSelection.metricSetPointer must be an object',
    ],
    [{ ...selection, resultValues: [] }, 'metricSelection.property resultValues should not exist'],
    [
      null,
      'metricSelection should not be null or undefined; metricSelection must be an object; nested property metricSelection must be either object or array',
    ],
  ] as const)('strict HTTP input rejects illegal selection %#', async (invalid, message) => {
    const row = await activity();
    const response = await write(ADMIN, row.id, { ...command(), metricSelection: invalid });
    expectBizError(response, BizCode.BAD_REQUEST, { strictMessage: false });
    expect(response.body.message).toBe(message);
    await unchanged(row);
  });
  it('domain validation rejects required with null pointer', async () => {
    const row = await activity();
    expectBizError(
      await write(ADMIN, row.id, {
        ...command(),
        metricSelection: { metricRequirementCode: 'required', metricSetPointer: null },
      }),
      BizCode.ACTIVITY_METRIC_SELECTION_INVALID,
    );
    await unchanged(row);
  });
  it('audit failure rolls back Activity and receipt together', async () => {
    const row = await activity();
    jest
      .spyOn(app.get(ActivityMetricSelectionAuditRecorder), 'log')
      .mockRejectedValueOnce(new BizException(BizCode.INTERNAL_ERROR));
    expectBizError(await write(ADMIN, row.id, command()), BizCode.INTERNAL_ERROR);
    await unchanged(row);
  });
});
