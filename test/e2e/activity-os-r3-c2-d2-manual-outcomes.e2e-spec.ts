import type { INestApplication } from '@nestjs/common';
import { Role, type Prisma } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../../src/database/prisma.service';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { ActivityOutcomeAuditRecorder } from '../../src/modules/activities/activity-outcome-audit-recorder';
import { parseMetricReceipt } from '../../src/modules/activities/activity-metric-command';
import { parseActivityOutcomeReceipt } from '../../src/modules/activities/activity-outcome-command';
import { createTestUser } from '../fixtures/users.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertConnectedTestDatabase } from '../setup/test-db';

describe('C2 D2 manual outcome HTTP closure', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: string;
  let actorId: string;
  let memberId: string;
  let organizationId: string;
  let setId: string;
  let setHash: string;
  let definitionId: string;
  let sequence = 0;
  const key = () => `outcome_http_${++sequence}`;
  const base = (id: string) => `/api/app/v1/my/managed-activities/${id}/outcomes`;
  const post = (path: string, body: object, authorization = auth) =>
    request(httpServer(app)).post(path).set('Authorization', authorization).send(body);
  const get = (path: string, authorization = auth) =>
    request(httpServer(app)).get(path).set('Authorization', authorization);
  const command = (expectedRevision = 0) => ({
    operationKey: key(),
    expectedRevision,
    metricSetVersionId: setId,
    metricSetDefinitionHash: setHash,
    values: [{ metricDefinitionId: definitionId, value: true, evidenceAttachmentIds: [] }],
  });
  const activity = () =>
    prisma.activity.create({
      data: {
        title: key(),
        activityTypeCode: 'training',
        allocationModeCode: 'first_come',
        organizationId,
        initiatorMemberId: memberId,
        statusCode: 'draft',
        startAt: new Date('2099-09-01'),
        endAt: new Date('2099-09-02'),
        location: '测试',
        metricRequirementCode: 'required',
        selectedMetricSetVersionId: setId,
        selectedMetricSetDefinitionHash: setHash,
        metricSelectionRevision: 1,
      },
    });
  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await assertConnectedTestDatabase(prisma);
    await resetDb(app);
    const actor = await createTestUser(app, { username: key(), role: Role.SUPER_ADMIN });
    actorId = actor.id;
    const member = await prisma.member.create({
      data: { memberNo: key(), ...memberIdentityData('成果测试'), gradeCode: 'level-3' },
    });
    memberId = member.id;
    await prisma.user.update({ where: { id: actorId }, data: { memberId } });
    auth = (await loginAs(app, actor.username)).authHeader;
    const parent = await prisma.organization.create({
      data: { name: key(), nodeTypeCode: 'root' },
    });
    organizationId = (
      await prisma.organization.create({
        data: { name: key(), nodeTypeCode: 'team', parentId: parent.id },
      })
    ).id;
    const definition = parseMetricReceipt(
      (
        await post('/api/admin/v1/activity-metric-definitions', {
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
    definitionId = definition.id;
    await post(`/api/admin/v1/activity-metric-definitions/${definitionId}/activate`, {
      operationKey: key(),
      expectedDefinitionHash: definition.definitionHash,
    }).expect(200);
    const set = parseMetricReceipt(
      (
        await post('/api/admin/v1/activity-metric-sets', {
          operationKey: key(),
          definition: {
            schemaVersion: 1,
            code: key(),
            version: 1,
            name: '成果集',
            items: [
              {
                key: 'done',
                sortOrder: 0,
                required: true,
                metricDefinitionId: definitionId,
                definitionHash: definition.definitionHash,
              },
            ],
          },
        }).expect(201)
      ).body.data,
    );
    setId = set.id;
    setHash = set.definitionHash;
    await post(`/api/admin/v1/activity-metric-sets/${setId}/activate`, {
      operationKey: key(),
      expectedDefinitionHash: setHash,
    }).expect(200);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('denies even a SUPER_ADMIN initiator without explicit outcome grants', async () => {
    const row = await activity();
    expectBizError(
      await post(base(row.id), command()),
      BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE,
    );
    expectBizError(await get(base(row.id)), BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE);
    expect(await prisma.activityOutcomeRevision.count({ where: { activityId: row.id } })).toBe(0);
  });

  async function grant(userId: string) {
    const role = await prisma.rbacRole.create({
      data: { code: key(), displayName: '成果显式授权' },
    });
    for (const action of ['read', 'record']) {
      const code = `activity.outcome.${action}`;
      const permission = await prisma.permission.upsert({
        where: { code },
        update: {},
        create: {
          code,
          module: 'activity',
          action: 'outcome',
          resourceType: action,
          description: 'test',
          servicePrincipalAllowed: false,
          delegatedAccessAllowed: false,
        },
      });
      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionId: permission.id },
      });
    }
    await prisma.roleBinding.create({
      data: { principalType: 'USER', principalId: userId, roleId: role.id, scopeType: 'GLOBAL' },
    });
  }

  it('records, replays, appends a full snapshot and reads history with explicit grants', async () => {
    await grant(actorId);
    const row = await activity();
    const first = command();
    const response = await post(base(row.id), first).expect(201);
    expect(response.body.code).toBe(0);
    expect(response.body.message).toBe('ok');
    const result = parseActivityOutcomeReceipt(
      response.body.data,
      row.id,
      response.body.data.outcomeRevisionId as string,
    );
    expect(result.revision).toBe(1);
    expect((await post(base(row.id), first).expect(201)).body).toEqual(response.body);
    expectBizError(
      await post(base(row.id), { ...first, values: [{ ...first.values[0], value: false }] }),
      BizCode.ACTIVITY_OUTCOME_COMMAND_CONFLICT,
    );
    const secondResponse = await post(base(row.id), command(1)).expect(201);
    expect(secondResponse.body.data.revision).toBe(2);
    const history = await get(`${base(row.id)}?page=1&pageSize=1`).expect(200);
    expect(history.body).toMatchObject({
      code: 0,
      message: 'ok',
      data: { total: 2, page: 1, pageSize: 1 },
    });
    expect(history.body.data.items).toHaveLength(1);
    expect(history.body.data.items[0]).not.toHaveProperty('values');
    const detail = await get(`${base(row.id)}/${result.outcomeRevisionId}`).expect(200);
    expect(detail.body.data).toMatchObject({
      statusCode: 'superseded',
      metricSetVersionId: setId,
      values: [{ value: true, sourceCode: 'manual', evidence: [] }],
    });
    expect(Object.keys(detail.body.data.values[0] as object).sort()).toEqual([
      'definition',
      'evidence',
      'metricDefinitionId',
      'sourceCode',
      'value',
      'valueRevisionId',
    ]);
    expect((await post(base(row.id), first).expect(201)).body).toEqual(response.body);
    expect(await prisma.activity.findUnique({ where: { id: row.id } })).toEqual(row);
    expect(
      await prisma.activityOutcomeCommandReceipt.count({ where: { activityId: row.id } }),
    ).toBe(2);
    const audits = await prisma.auditLog.findMany({
      where: { event: 'activity.outcome.command', resourceId: row.id },
    });
    expect(audits).toHaveLength(2);
    for (const audit of audits)
      expect(Object.keys((audit.context as Prisma.JsonObject).extra as object).sort()).toEqual([
        'afterStatus',
        'evidenceCount',
        'operation',
        'outcomeRevisionId',
        'priorAfterStatus',
        'priorRevisionId',
        'revision',
        'sourceCode',
        'valueCount',
      ]);
    const other = await activity();
    expectBizError(
      await get(`${base(other.id)}/${result.outcomeRevisionId}`),
      BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE,
    );
  });

  it('rejects unknown fields, null evidence and malformed values without writing', async () => {
    await grant(actorId);
    const row = await activity();
    expectBizError(
      await post(base(row.id), { ...command(), statusCode: 'confirmed' }),
      BizCode.BAD_REQUEST,
      { strictMessage: false },
    );
    const input = command();
    expectBizError(
      await post(base(row.id), {
        ...input,
        values: [{ ...input.values[0], evidenceAttachmentIds: null }],
      }),
      BizCode.BAD_REQUEST,
      { strictMessage: false },
    );
    expectBizError(
      await post(base(row.id), { ...input, values: [{ ...input.values[0], value: 'true' }] }),
      BizCode.ACTIVITY_OUTCOME_INVALID,
    );
    expect(await prisma.activityOutcomeRevision.count({ where: { activityId: row.id } })).toBe(0);
  });

  it('lets an explicitly authorized ordinary member record with omitted evidence', async () => {
    const user = await createTestUser(app, { username: key(), role: Role.USER });
    const member = await prisma.member.create({
      data: { memberNo: key(), ...memberIdentityData('普通成果测试'), gradeCode: 'level-3' },
    });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    await grant(user.id);
    const authorization = (await loginAs(app, user.username)).authHeader;
    const original = await activity();
    const row = await prisma.activity.update({
      where: { id: original.id },
      data: { initiatorMemberId: member.id },
    });
    const input = { ...command(), values: [{ metricDefinitionId: definitionId, value: false }] };
    const result = await post(base(row.id), input, authorization).expect(201);
    expect(result.body.data).toMatchObject({
      valueCount: 1,
      evidenceCount: 0,
      sourceCode: 'manual',
    });
    const detail = await get(
      `${base(row.id)}/${result.body.data.outcomeRevisionId as string}`,
      authorization,
    ).expect(200);
    expect(detail.body.data.values[0]).toMatchObject({ value: false, evidence: [] });
  });

  it('preserves the prior draft and its content if an appended revision fails at audit', async () => {
    await grant(actorId);
    const row = await activity();
    await post(base(row.id), command()).expect(201);
    const before = await prisma.activityOutcomeRevision.findMany({
      where: { activityId: row.id },
      include: { values: true },
    });
    const spy = jest
      .spyOn(app.get(ActivityOutcomeAuditRecorder), 'log')
      .mockRejectedValueOnce(new BizException(BizCode.ACTIVITY_OUTCOME_INVALID));
    try {
      expectBizError(await post(base(row.id), command(1)), BizCode.ACTIVITY_OUTCOME_INVALID);
    } finally {
      spy.mockRestore();
    }
    expect(
      await prisma.activityOutcomeRevision.findMany({
        where: { activityId: row.id },
        include: { values: true },
      }),
    ).toEqual(before);
    expect(before[0].statusCode).toBe('draft');
    expect(
      await prisma.activityOutcomeCommandReceipt.count({ where: { activityId: row.id } }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { event: 'activity.outcome.command', resourceId: row.id },
      }),
    ).toBe(1);
  });

  it('rolls back every outcome write and receipt when the same-transaction audit fails', async () => {
    await grant(actorId);
    const row = await activity();
    const spy = jest
      .spyOn(app.get(ActivityOutcomeAuditRecorder), 'log')
      .mockRejectedValueOnce(new BizException(BizCode.ACTIVITY_OUTCOME_INVALID));
    try {
      expectBizError(await post(base(row.id), command()), BizCode.ACTIVITY_OUTCOME_INVALID);
    } finally {
      spy.mockRestore();
    }
    expect(await prisma.activityOutcomeRevision.count({ where: { activityId: row.id } })).toBe(0);
    expect(await prisma.activityMetricValueRevision.count({ where: { activityId: row.id } })).toBe(
      0,
    );
    expect(await prisma.activityMetricValueEvidence.count({ where: { activityId: row.id } })).toBe(
      0,
    );
    expect(
      await prisma.activityOutcomeCommandReceipt.count({ where: { activityId: row.id } }),
    ).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: { event: 'activity.outcome.command', resourceId: row.id },
      }),
    ).toBe(0);
  });
});
