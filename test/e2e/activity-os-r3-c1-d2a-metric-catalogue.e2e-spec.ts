import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityMetricAuditRecorder } from '../../src/modules/activities/activity-metric-audit-recorder';
import { parseMetricReceipt } from '../../src/modules/activities/activity-metric-command';
import { ServiceTokenService } from '../../src/modules/integration-auth/service-token.service';
import { ServicePrincipalsService } from '../../src/modules/service-principals/service-principals.service';
import { ACTIVITY_METRIC_PERMISSION_SEED } from '../../src/modules/permissions/permission-catalog';
import { createTestUser } from '../fixtures/users.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertConnectedTestDatabase, assertTestDatabaseUrl } from '../setup/test-db';

const DEFS = '/api/admin/v1/activity-metric-definitions';
const SETS = '/api/admin/v1/activity-metric-sets';
const configuration = { kindCode: 'non_negative_integer', unit: '人', minimum: 0, maximum: 100 };
const definition = (code: string) => ({
  schemaVersion: 1,
  code,
  version: 1,
  name: '服务人数',
  configuration,
});
const setDefinition = (code: string, items: unknown[] = []) => ({
  schemaVersion: 1,
  code,
  version: 1,
  name: '指标集',
  items,
});

describe('C1 D2a catalogue HTTP and PostgreSQL', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: string;
  let plain: string;
  let plainUserId: string;
  let rootId: string;
  const previousIntegration = process.env.INTEGRATION_API_ENABLED;
  const previousSecret = process.env.INTEGRATION_JWT_SECRET;
  let sequence = 0;
  const key = () => 'metric_' + ++sequence;
  beforeAll(async () => {
    process.env.INTEGRATION_API_ENABLED = 'true';
    process.env.INTEGRATION_JWT_SECRET = randomBytes(32).toString('hex');
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    await assertConnectedTestDatabase(prisma);
    await prisma.$executeRaw`TRUNCATE "ActivityMetricCommandReceipt","ActivityMetricSetItem","ActivityMetricSetVersion","ActivityMetricDefinition"`;
    const root = await createTestUser(app, { username: 'c1_metric_root', role: Role.SUPER_ADMIN });
    rootId = root.id;
    const user = await createTestUser(app, { username: 'c1_metric_plain' });
    plainUserId = user.id;
    auth = (await loginAs(app, root.username)).authHeader;
    plain = (await loginAs(app, user.username)).authHeader;
  });
  afterAll(async () => {
    if (app) await app.close();
    if (previousIntegration === undefined) delete process.env.INTEGRATION_API_ENABLED;
    else process.env.INTEGRATION_API_ENABLED = previousIntegration;
    if (previousSecret === undefined) delete process.env.INTEGRATION_JWT_SECRET;
    else process.env.INTEGRATION_JWT_SECRET = previousSecret;
  });
  const post = (path: string, data: object, credential?: string) =>
    request(httpServer(app))
      .post(path)
      .set('Authorization', credential ?? auth)
      .send(data);
  async function create(path = DEFS) {
    const input = {
      operationKey: key(),
      definition: path === DEFS ? definition(key()) : setDefinition(key()),
    };
    const response = await post(path, input).expect(201);
    expect(response.body.code).toBe(0);
    return { input, receipt: parseMetricReceipt(response.body.data) };
  }

  it('requires Human JWT and explicit permission even for absent target', async () => {
    expectBizError(await request(httpServer(app)).get(DEFS), BizCode.UNAUTHORIZED);
    expectBizError(
      await request(httpServer(app))
        .get(DEFS + '/missing_id')
        .set('Authorization', plain),
      BizCode.RBAC_FORBIDDEN,
    );
    expectBizError(
      await post(DEFS, { operationKey: key(), definition: definition(key()) }, plain),
      BizCode.RBAC_FORBIDDEN,
    );
    expectBizError(
      await request(httpServer(app))
        .get(DEFS + '/missing_id')
        .set('Authorization', auth),
      BizCode.ACTIVITY_METRIC_DEFINITION_NOT_FOUND,
    );
  });

  it('valid machine token is still rejected by every Human catalogue route', async () => {
    const actor = await prisma.user.findUniqueOrThrow({ where: { id: rootId } });
    const meta = { requestId: 'metric-machine-boundary', ip: null, ua: null };
    const service = app.get(ServicePrincipalsService);
    const principal = await service.create({ name: '指标机器边界测试' }, actor, meta);
    const credential = await service.createCredential(principal.id, actor, meta);
    const tokens = app.get(ServiceTokenService);
    const issued = await tokens.issueToken(principal.clientId, credential.clientSecret);
    expect(tokens.verifyToken(issued.accessToken).tokenUse).toBe('service');
    const machine = 'Bearer ' + issued.accessToken;
    for (const path of [DEFS, SETS]) {
      expectBizError(
        await request(httpServer(app)).get(path).set('Authorization', machine),
        BizCode.UNAUTHORIZED,
      );
      expectBizError(
        await request(httpServer(app))
          .get(path + '/missing_id')
          .set('Authorization', machine),
        BizCode.UNAUTHORIZED,
      );
      expectBizError(await post(path, {}, machine), BizCode.UNAUTHORIZED);
      expectBizError(
        await request(httpServer(app))
          .put(path + '/missing_id/draft')
          .set('Authorization', machine)
          .send({}),
        BizCode.UNAUTHORIZED,
      );
      expectBizError(await post(path + '/missing_id/activate', {}, machine), BizCode.UNAUTHORIZED);
      expectBizError(await post(path + '/missing_id/retire', {}, machine), BizCode.UNAUTHORIZED);
    }
  });

  it.each([
    { kindCode: 'non_negative_integer', unit: '人', minimum: 0, maximum: 100 },
    { kindCode: 'non_negative_decimal', unit: '小时', scale: 2, minimum: '0', maximum: '100.25' },
    { kindCode: 'boolean', unit: null },
    { kindCode: 'short_text', unit: null, maxLength: 100 },
    { kindCode: 'single_choice', unit: null, options: [{ code: 'yes', label: '是' }] },
  ])('five-kind HTTP lifecycle: $kindCode', async (configuration) => {
    const document = { ...definition(key()), configuration };
    const created = parseMetricReceipt(
      (await post(DEFS, { operationKey: key(), definition: document }).expect(201)).body.data,
    );
    const changed = parseMetricReceipt(
      (
        await request(httpServer(app))
          .put(DEFS + '/' + created.id + '/draft')
          .set('Authorization', auth)
          .send({
            operationKey: key(),
            expectedDefinitionHash: created.definitionHash,
            definition: { ...document, name: '更新指标' },
          })
          .expect(200)
      ).body.data,
    );
    await post(DEFS + '/' + created.id + '/activate', {
      operationKey: key(),
      expectedDefinitionHash: changed.definitionHash,
    }).expect(200);
    await post(DEFS + '/' + created.id + '/retire', {
      operationKey: key(),
      expectedDefinitionHash: changed.definitionHash,
    }).expect(200);
    const detail = await request(httpServer(app))
      .get(DEFS + '/' + created.id)
      .set('Authorization', auth)
      .expect(200);
    expect(detail.body.data.definition.configuration).toEqual(configuration);
    expect(detail.body.data.statusCode).toBe('retired');
  });

  it('existing Human role APIs can assign all three codes; removing them denies replay', async () => {
    const editor = await createTestUser(app, { username: 'metric_manual_editor' });
    const editorAuth = (await loginAs(app, editor.username)).authHeader;
    for (const permission of ACTIVITY_METRIC_PERMISSION_SEED)
      await prisma.permission.upsert({
        where: { code: permission.code },
        update: {},
        create: { ...permission },
      });
    const roleCode = 'metric-manual-editor';
    await post('/api/system/v1/roles', { code: roleCode, displayName: '指标人工编辑' }).expect(201);
    const role = await prisma.rbacRole.findUniqueOrThrow({ where: { code: roleCode } });
    await request(httpServer(app))
      .put('/api/system/v1/roles/' + role.id + '/permissions')
      .set('Authorization', auth)
      .send({
        permissionCodes: ACTIVITY_METRIC_PERMISSION_SEED.map((p) => p.code),
        expectedRevision: role.permissionRevision,
      })
      .expect(200);
    await post('/api/system/v1/users/' + editor.id + '/roles', { roleCode }).expect(201);
    await request(httpServer(app)).get(DEFS).set('Authorization', editorAuth).expect(200);
    const input = { operationKey: key(), definition: definition(key()) };
    await post(DEFS, input, editorAuth).expect(201);
    await post(SETS, { operationKey: key(), definition: setDefinition(key()) }, editorAuth).expect(
      201,
    );
    const current = await prisma.rbacRole.findUniqueOrThrow({ where: { id: role.id } });
    await request(httpServer(app))
      .put('/api/system/v1/roles/' + role.id + '/permissions')
      .set('Authorization', auth)
      .send({ permissionCodes: [], expectedRevision: current.permissionRevision })
      .expect(200);
    expectBizError(await post(DEFS, input, editorAuth), BizCode.RBAC_FORBIDDEN);
  });

  it.each([DEFS, SETS])(
    'complete lifecycle, stable replay, no duplicate audit: %s',
    async (path) => {
      const { input, receipt } = await create(path);
      const updatedDefinition = { ...input.definition, name: '修改后的名称' };
      const update = await request(httpServer(app))
        .put(path + '/' + receipt.id + '/draft')
        .set('Authorization', auth)
        .send({
          operationKey: key(),
          expectedDefinitionHash: receipt.definitionHash,
          definition: updatedDefinition,
        })
        .expect(200);
      const draft = parseMetricReceipt(update.body.data);
      expect(draft.definitionHash).not.toBe(receipt.definitionHash);
      expectBizError(
        await post(path + '/' + receipt.id + '/activate', {
          operationKey: key(),
          expectedDefinitionHash: receipt.definitionHash,
        }),
        BizCode.ACTIVITY_METRIC_VERSION_STALE,
      );
      if (path === SETS) {
        expectBizError(
          await post(path + '/' + receipt.id + '/activate', {
            operationKey: key(),
            expectedDefinitionHash: draft.definitionHash,
          }),
          BizCode.ACTIVITY_METRIC_SET_INVALID,
        );
      } else {
        const active = await post(path + '/' + receipt.id + '/activate', {
          operationKey: key(),
          expectedDefinitionHash: draft.definitionHash,
        }).expect(200);
        expect(parseMetricReceipt(active.body.data).statusCode).toBe('active');
        expectBizError(
          await request(httpServer(app))
            .put(path + '/' + receipt.id + '/draft')
            .set('Authorization', auth)
            .send({
              operationKey: key(),
              expectedDefinitionHash: draft.definitionHash,
              definition: updatedDefinition,
            }),
          BizCode.ACTIVITY_METRIC_STATUS_INVALID,
        );
        const retired = await post(path + '/' + receipt.id + '/retire', {
          operationKey: key(),
          expectedDefinitionHash: draft.definitionHash,
        }).expect(200);
        expect(parseMetricReceipt(retired.body.data).statusCode).toBe('retired');
      }
      const before = await prisma.auditLog.count({ where: { resourceId: receipt.id } });
      const replay = await post(path, input).expect(201);
      expect(parseMetricReceipt(replay.body.data)).toEqual(receipt);
      expect(await prisma.auditLog.count({ where: { resourceId: receipt.id } })).toBe(before);
      expectBizError(
        await post(path, { ...input, definition: updatedDefinition }),
        BizCode.ACTIVITY_METRIC_COMMAND_CONFLICT,
      );
      expectBizError(
        await post(path, { ...input, operationKey: key() }),
        BizCode.ACTIVITY_METRIC_VERSION_ALREADY_EXISTS,
      );
      const detail = await request(httpServer(app))
        .get(path + '/' + receipt.id)
        .set('Authorization', auth)
        .expect(200);
      expect(detail.body.data.definition.name).toBe(updatedDefinition.name);
      expect(detail.body.data).not.toHaveProperty('actor');
    },
  );

  it('set activation verifies active exact references; retirement preserves history', async () => {
    const { receipt: metric } = await create();
    const input = {
      operationKey: key(),
      definition: setDefinition(key(), [
        {
          key: 'served',
          sortOrder: 0,
          required: true,
          metricDefinitionId: metric.id,
          definitionHash: metric.definitionHash,
        },
      ]),
    };
    const created = await post(SETS, input).expect(201);
    const set = parseMetricReceipt(created.body.data);
    expectBizError(
      await post(SETS + '/' + set.id + '/activate', {
        operationKey: key(),
        expectedDefinitionHash: set.definitionHash,
      }),
      BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE,
    );
    await post(DEFS + '/' + metric.id + '/activate', {
      operationKey: key(),
      expectedDefinitionHash: metric.definitionHash,
    }).expect(200);
    await post(SETS + '/' + set.id + '/activate', {
      operationKey: key(),
      expectedDefinitionHash: set.definitionHash,
    }).expect(200);
    await post(DEFS + '/' + metric.id + '/retire', {
      operationKey: key(),
      expectedDefinitionHash: metric.definitionHash,
    }).expect(200);
    const historical = await request(httpServer(app))
      .get(SETS + '/' + set.id)
      .set('Authorization', auth)
      .expect(200);
    expect(historical.body.data.definition.items).toEqual(input.definition.items);
    await post(SETS + '/' + set.id + '/retire', {
      operationKey: key(),
      expectedDefinitionHash: set.definitionHash,
    }).expect(200);
  });

  it('replacement draft items are atomic; target id is part of replay identity', async () => {
    const { receipt: a } = await create();
    const { receipt: b } = await create();
    const operationKey = key();
    const input = { operationKey, expectedDefinitionHash: a.definitionHash };
    await post(DEFS + '/' + a.id + '/activate', input).expect(200);
    expectBizError(
      await post(DEFS + '/' + b.id + '/activate', input),
      BizCode.ACTIVITY_METRIC_COMMAND_CONFLICT,
    );
    const { input: initial, receipt: set } = await create(SETS);
    const changed = {
      ...initial.definition,
      items: [
        {
          key: 'a',
          sortOrder: 0,
          required: true,
          metricDefinitionId: a.id,
          definitionHash: a.definitionHash,
        },
      ],
    };
    const updated = await request(httpServer(app))
      .put(SETS + '/' + set.id + '/draft')
      .set('Authorization', auth)
      .send({
        operationKey: key(),
        expectedDefinitionHash: set.definitionHash,
        definition: changed,
      })
      .expect(200);
    const hash = parseMetricReceipt(updated.body.data).definitionHash;
    expect(await prisma.activityMetricSetItem.count({ where: { setVersionId: set.id } })).toBe(1);
    expectBizError(
      await request(httpServer(app))
        .put(SETS + '/' + set.id + '/draft')
        .set('Authorization', auth)
        .send({
          operationKey: key(),
          expectedDefinitionHash: hash,
          definition: {
            ...changed,
            items: [{ ...changed.items[0], definitionHash: 'f'.repeat(64) }],
          },
        }),
      BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE,
    );
    expect(await prisma.activityMetricSetItem.count({ where: { setVersionId: set.id } })).toBe(1);
  });

  it('audit failure rolls back resource, items and receipt', async () => {
    const before = await prisma.activityMetricDefinition.count();
    const receiptCount = await prisma.activityMetricCommandReceipt.count();
    const spy = jest
      .spyOn(app.get(ActivityMetricAuditRecorder), 'log')
      .mockRejectedValueOnce(new Error('injected audit failure'));
    try {
      await post(DEFS, { operationKey: key(), definition: definition(key()) }).expect(500);
    } finally {
      spy.mockRestore();
    }
    expect(await prisma.activityMetricDefinition.count()).toBe(before);
    expect(await prisma.activityMetricCommandReceipt.count()).toBe(receiptCount);
  });

  it('GLOBAL write grant does not imply read or set write; revocation denies replay', async () => {
    const permission = await prisma.permission.upsert({
      where: { code: 'activity-metric.manage.definition' },
      update: {},
      create: {
        code: 'activity-metric.manage.definition',
        module: 'activity-metric',
        action: 'manage',
        resourceType: 'definition',
        description: 'test',
      },
    });
    const role = await prisma.rbacRole.create({
      data: { code: 'metric-editor', displayName: '指标编辑' },
    });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    const binding = await prisma.roleBinding.create({
      data: {
        principalType: 'USER',
        principalId: plainUserId,
        roleId: role.id,
        scopeType: 'GLOBAL',
      },
    });
    const input = { operationKey: key(), definition: definition(key()) };
    await post(DEFS, input, plain).expect(201);
    expectBizError(
      await request(httpServer(app)).get(DEFS).set('Authorization', plain),
      BizCode.RBAC_FORBIDDEN,
    );
    expectBizError(
      await post(SETS, { operationKey: key(), definition: setDefinition(key()) }, plain),
      BizCode.RBAC_FORBIDDEN,
    );
    await prisma.roleBinding.update({ where: { id: binding.id }, data: { deletedAt: new Date() } });
    expectBizError(await post(DEFS, input, plain), BizCode.RBAC_FORBIDDEN);
  });

  it('pagination is bounded, filters are exact, unknown fields and cross-kind fields rejected', async () => {
    const { input } = await create();
    const list = await request(httpServer(app))
      .get(DEFS)
      .query({ code: input.definition.code, pageSize: 1 })
      .set('Authorization', auth)
      .expect(200);
    expect(list.body.data.total).toBe(1);
    expect(list.body.data.items).toHaveLength(1);
    expect(list.body.data.page).toBe(1);
    expect(list.body.data.pageSize).toBe(1);
    await request(httpServer(app))
      .get(DEFS)
      .query({ pageSize: 101 })
      .set('Authorization', auth)
      .expect(400);
    await post(DEFS, {
      operationKey: key(),
      definition: { ...definition(key()), extra: true },
    }).expect(400);
    await post(DEFS, {
      operationKey: key(),
      definition: {
        ...definition(key()),
        configuration: { kindCode: 'boolean', unit: null, maximum: 10 },
      },
    }).expect(400);
    await post(DEFS, { operationKey: ' untrimmed ', definition: definition(key()) }).expect(400);
  });
});
