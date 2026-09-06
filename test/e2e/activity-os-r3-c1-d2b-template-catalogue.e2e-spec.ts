import type { INestApplication } from '@nestjs/common';
import { Prisma, Role, type BindingScopeType } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import request, { type Response } from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityTemplateVersionAuditRecorder } from '../../src/modules/activities/activity-template-version-audit-recorder';
import { parseTemplateVersionReceipt } from '../../src/modules/activities/activity-template-version-command';
import { computeActivityTemplateDefinitionHash } from '../../src/modules/activities/activity-template-definition';
import { parseActivityTemplateDefinitionV2 } from '../../src/modules/activities/activity-template-definition-v2';
import { parseMetricReceipt } from '../../src/modules/activities/activity-metric-command';
import type { ActivityMetricSetPointer } from '../../src/modules/activities/activity-metric-selection';
import { ServiceTokenService } from '../../src/modules/integration-auth/service-token.service';
import { ServicePrincipalsService } from '../../src/modules/service-principals/service-principals.service';
import { ACTIVITY_TEMPLATE_PERMISSION_SEED } from '../../src/modules/permissions/permission-catalog';
import { createTestUser } from '../fixtures/users.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { waitFor } from '../helpers/wait-for';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertConnectedTestDatabase } from '../setup/test-db';

const ROOT = '/api/admin/v1/activity-template-versions';
const OPTIONS = '/api/app/v1/my/managed-activities';
describe('C1 D2b App options HTTP eligibility and exact pagination', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAuth: string;
  let memberAuth: string;
  let memberId: string;
  let organizationId: string;
  let otherOrganizationId: string;
  let n = 0;
  const key = () => `options_${++n}`;
  const names = ['metric-set-options', 'template-version-options'] as const;
  const v1 = { activity: { allocationModeCode: 'first_come' }, sessions: [] };
  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);
    await assertConnectedTestDatabase(prisma);
    const root = await prisma.organization.create({ data: { name: key(), nodeTypeCode: 'root' } });
    organizationId = (
      await prisma.organization.create({
        data: { name: key(), nodeTypeCode: 'team', parentId: root.id },
      })
    ).id;
    otherOrganizationId = (
      await prisma.organization.create({
        data: { name: key(), nodeTypeCode: 'team', parentId: root.id },
      })
    ).id;
    memberId = (
      await prisma.member.create({
        data: { memberNo: key(), ...memberIdentityData('选项目录测试'), gradeCode: 'level-3' },
      })
    ).id;
    const member = await createTestUser(app, { username: key(), role: Role.USER });
    await prisma.user.update({ where: { id: member.id }, data: { memberId } });
    await prisma.memberOrganizationMembership.create({ data: { memberId, organizationId } });
    memberAuth = (await loginAs(app, member.username)).authHeader;
    const admin = await createTestUser(app, { username: key(), role: Role.SUPER_ADMIN });
    adminAuth = (await loginAs(app, admin.username)).authHeader;
  });
  beforeEach(async () => {
    // Only the authorized worker database; each case starts with its own catalogue.
    await assertConnectedTestDatabase(prisma);
    await prisma.$executeRaw`TRUNCATE "ActivityMetricCommandReceipt", "ActivityMetricSetItem", "ActivityMetricSetVersion", "ActivityMetricDefinition", "ActivityTemplate", "ActivityTemplateFamily" CASCADE`;
  });
  afterAll(async () => {
    await app?.close();
  });
  const get = (
    name: (typeof names)[number],
    query: object = { organizationId },
    credential = memberAuth,
  ) =>
    request(httpServer(app))
      .get(`${OPTIONS}/${name}`)
      .set('Authorization', credential)
      .query(query);
  const post = (path: string, body: object) =>
    request(httpServer(app)).post(path).set('Authorization', adminAuth).send(body);
  async function storedTemplate(
    schemaVersion = 3,
    overrides: Partial<Prisma.ActivityTemplateUncheckedCreateInput> = {},
    familyOverrides: Partial<Prisma.ActivityTemplateFamilyUncheckedCreateInput> = {},
  ) {
    const family = await prisma.activityTemplateFamily.create({
      data: {
        code: key(),
        name: '全局族',
        categoryCode: 'training',
        scopeTypeCode: 'global',
        statusCode: 'active',
        ...familyOverrides,
      },
    });
    const definition = {
      ...v1,
      ...(schemaVersion > 1 ? { registrationForm: null } : {}),
      ...(schemaVersion === 3
        ? { metricSelection: { metricRequirementCode: 'not_required', metricSetPointer: null } }
        : {}),
    };
    const targetStatus = overrides.statusCode ?? 'active';
    const row = await prisma.activityTemplate.create({
      data: {
        familyId: family.id,
        code: family.code,
        name: key(),
        activityTypeCode: 'training',
        version: 1,
        schemaVersion,
        definitionJson: definition,
        definitionHash: computeActivityTemplateDefinitionHash({ schemaVersion, definition }),
        effectiveFrom: new Date('2200-01-01T00:00:00.000Z'),
        ...overrides,
        statusCode: 'draft',
      },
    });
    if (targetStatus === 'draft') return row;
    const active = await prisma.activityTemplate.update({
      where: { id: row.id },
      data: { statusCode: 'active' },
    });
    if (targetStatus === 'active') return active;
    return prisma.activityTemplate.update({
      where: { id: row.id },
      data: { statusCode: targetStatus },
    });
  }
  async function catalogue() {
    const defs = '/api/admin/v1/activity-metric-definitions';
    const sets = '/api/admin/v1/activity-metric-sets';
    const d = await post(defs, {
      operationKey: key(),
      definition: {
        schemaVersion: 1,
        code: key(),
        version: 1,
        name: '完成',
        configuration: { kindCode: 'boolean', unit: null },
      },
    }).expect(201);
    const metric = parseMetricReceipt(d.body.data);
    await post(`${defs}/${metric.id}/activate`, {
      operationKey: key(),
      expectedDefinitionHash: metric.definitionHash,
    }).expect(200);
    const s = await post(sets, {
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
            metricDefinitionId: metric.id,
            definitionHash: metric.definitionHash,
          },
        ],
      },
    }).expect(201);
    const set = parseMetricReceipt(s.body.data);
    await post(`${sets}/${set.id}/activate`, {
      operationKey: key(),
      expectedDefinitionHash: set.definitionHash,
    }).expect(200);
    const pointer: ActivityMetricSetPointer = {
      id: set.id,
      code: set.code,
      version: set.version,
      schemaVersion: 1,
      definitionHash: set.definitionHash,
    };
    return { pointer, metric, defs, sets };
  }
  it.each(names)(
    '%s resolves the static route for an eligible member without catalogue permissions',
    async (name) => {
      const response = await get(name).expect(200);
      expect(response.body).toEqual({
        code: 0,
        message: 'ok',
        data: { items: [], total: 0, page: 1, pageSize: 20 },
      });
      expect(await prisma.roleBinding.count()).toBe(0);
    },
  );
  it.each(names)(
    '%s enforces organization eligibility, active membership, and App admission on every request',
    async (name) => {
      expectBizError(
        await get(name, { organizationId: otherOrganizationId }),
        BizCode.ACTIVITY_INITIATION_ORG_FORBIDDEN,
      );
      expectBizError(await get(name, { organizationId }, adminAuth), BizCode.FORBIDDEN);
      await get(name).expect(200);
      await prisma.member.update({ where: { id: memberId }, data: { status: 'INACTIVE' } });
      try {
        expectBizError(await get(name), BizCode.FORBIDDEN);
      } finally {
        await prisma.member.update({ where: { id: memberId }, data: { status: 'ACTIVE' } });
      }
      expectBizError(
        await request(httpServer(app)).get(`${OPTIONS}/${name}`).query({ organizationId }),
        BizCode.UNAUTHORIZED,
      );
    },
  );
  it.each(names)(
    '%s validates required organization and standard page/pageSize only',
    async (name) => {
      for (const [query, field] of [
        [{}, 'organizationId'],
        [{ organizationId: 'x' }, 'organizationId'],
        [{ organizationId, page: 0 }, 'page'],
        [{ organizationId, pageSize: 101 }, 'pageSize'],
        [{ organizationId, limit: 20 }, 'limit'],
      ] as const) {
        const response = await get(name, query);
        expectBizError(response, BizCode.BAD_REQUEST, { strictMessage: false });
        expect(response.body.message).toContain(field);
      }
    },
  );
  it('filters retired metric definitions before count/pagination and preserves createdAt/id ordering', async () => {
    const older = await catalogue();
    const invalid = await catalogue();
    const newer = await catalogue();
    await post(`${invalid.defs}/${invalid.metric.id}/retire`, {
      operationKey: key(),
      expectedDefinitionHash: invalid.metric.definitionHash,
    }).expect(200);
    const first = await get('metric-set-options', { organizationId, page: 1, pageSize: 1 }).expect(
      200,
    );
    const second = await get('metric-set-options', { organizationId, page: 2, pageSize: 1 }).expect(
      200,
    );
    expect(first.body.data).toEqual({
      items: [{ ...newer.pointer, name: '指标集' }],
      total: 2,
      page: 1,
      pageSize: 1,
    });
    expect(second.body.data).toEqual({
      items: [{ ...older.pointer, name: '指标集' }],
      total: 2,
      page: 2,
      pageSize: 1,
    });
    const beyond = await get('metric-set-options', { organizationId, page: 3, pageSize: 1 }).expect(
      200,
    );
    expect(beyond.body.data).toEqual({ items: [], total: 2, page: 3, pageSize: 1 });
  });
  it('returns only valid global V1/V2/V3 summaries, with tie ordering and exact filtered total', async () => {
    const date = new Date('2200-02-01T00:00:00.000Z');
    const good = [];
    for (const schema of [1, 2, 3]) good.push(await storedTemplate(schema, { createdAt: date }));
    await storedTemplate(3, { statusCode: 'draft' });
    await storedTemplate(2, { statusCode: 'retired' });
    await storedTemplate(3, { definitionHash: 'a'.repeat(64) });
    await storedTemplate(
      2,
      {},
      { scopeTypeCode: 'organization', ownerOrganizationId: organizationId },
    );
    await storedTemplate(1, {}, { statusCode: 'retired' });
    const expected = good
      .map(({ id }) => id)
      .sort()
      .reverse();
    const response = await get('template-version-options', {
      organizationId,
      page: 2,
      pageSize: 1,
    }).expect(200);
    const result = response.body.data as Page;
    expect(result).toMatchObject({ items: [{ id: expected[1] }], total: 3, page: 2, pageSize: 1 });
    expect(Object.keys(result.items[0]).sort()).toEqual(summaryKeys);
    expect(Object.keys(result.items[0].family).sort()).toEqual([
      'categoryCode',
      'code',
      'id',
      'name',
    ]);
    const all = await get('template-version-options').expect(200);
    expect((all.body.data as Page).items.map(({ id }) => id)).toEqual(expected);
  });
  it('removes V3 options when its referenced set or definition retires, but keeps V1/V2 and explicit not_required', async () => {
    const { pointer, metric, defs } = await catalogue();
    const definition = {
      ...v1,
      registrationForm: null,
      metricSelection: { metricRequirementCode: 'required', metricSetPointer: { ...pointer } },
    };
    const required = await storedTemplate(3, {
      definitionJson: definition,
      definitionHash: computeActivityTemplateDefinitionHash({ schemaVersion: 3, definition }),
    });
    const independent = [await storedTemplate(1), await storedTemplate(2), await storedTemplate(3)];
    const before = await get('template-version-options').expect(200);
    expect((before.body.data as Page).items.map(({ id }) => id)).toContain(required.id);
    await post(`${defs}/${metric.id}/retire`, {
      operationKey: key(),
      expectedDefinitionHash: metric.definitionHash,
    }).expect(200);
    const after = await get('template-version-options').expect(200);
    expect((after.body.data as Page).total).toBe(3);
    expect((after.body.data as Page).items.map(({ id }) => id).sort()).toEqual(
      independent.map(({ id }) => id).sort(),
    );
  });
  it.each(names)(
    '%s returns the explicit overflow error for 1001 candidates, never a false partial total',
    async (name) => {
      if (name === 'metric-set-options') {
        const { metric } = await catalogue();
        const ids = Array.from({ length: 1000 }, () => key());
        await prisma.activityMetricSetVersion.createMany({
          data: ids.map((id) => ({
            id,
            code: key(),
            version: 1,
            name: '候选超限测试',
            schemaVersion: 1,
            statusCode: 'draft',
            definitionHash: 'a'.repeat(64),
          })),
        });
        await prisma.activityMetricSetItem.createMany({
          data: ids.map((setVersionId) => ({
            setVersionId,
            metricDefinitionId: metric.id,
            key: 'done',
            sortOrder: 0,
            required: true,
          })),
        });
        await prisma.activityMetricSetVersion.updateMany({
          where: { id: { in: ids } },
          data: { statusCode: 'active', activatedAt: new Date() },
        });
      } else {
        const family = await prisma.activityTemplateFamily.create({
          data: {
            code: key(),
            name: '超限测试',
            categoryCode: 'training',
            scopeTypeCode: 'global',
            statusCode: 'active',
          },
        });
        await prisma.activityTemplate.createMany({
          data: Array.from({ length: 1001 }, (_, i) => ({
            familyId: family.id,
            code: family.code,
            version: i + 1,
            name: '候选超限测试',
            activityTypeCode: 'training',
            schemaVersion: 1,
            statusCode: 'draft',
            effectiveFrom: new Date(),
            definitionJson: v1,
            definitionHash: computeActivityTemplateDefinitionHash({
              schemaVersion: 1,
              definition: v1,
            }),
          })),
        });
        await prisma.activityTemplate.updateMany({
          where: { familyId: family.id },
          data: { statusCode: 'active' },
        });
      }
      const before = {
        receipts: await prisma.activityMetricCommandReceipt.count(),
        audits: await prisma.auditLog.count(),
      };
      const response = await get(name);
      expect(response.status).toBe(409);
      expectBizError(response, BizCode.ACTIVITY_OPTIONS_CANDIDATE_LIMIT_EXCEEDED);
      expect(response.body.data).toBeNull();
      expect({
        receipts: await prisma.activityMetricCommandReceipt.count(),
        audits: await prisma.auditLog.count(),
      }).toEqual(before);
    },
  );
});
const selection = { metricRequirementCode: 'not_required', metricSetPointer: null } as const;
const definition = {
  activity: { allocationModeCode: 'first_come' },
  sessions: [],
  registrationForm: null,
  metricSelection: selection,
};
const form = {
  fields: [
    {
      fieldCode: 'note',
      typeCode: 'short_text',
      label: '备注',
      required: false,
      visibilityCode: 'self_only',
      exportable: false,
      sortOrder: 0,
      governance: {
        purposeCode: 'activity_specific_note',
        dataClassCode: 'ordinary',
        retentionPolicyCode: 'activity_lifecycle',
        maskingPolicyCode: 'none',
        prefillSourceCode: null,
      },
    },
  ],
};
const summaryKeys = [
  'id',
  'code',
  'name',
  'version',
  'schemaVersion',
  'definitionHash',
  'statusCode',
  'activityTypeCode',
  'family',
  'effectiveFrom',
  'effectiveTo',
  'createdAt',
  'updatedAt',
].sort();
type Version = {
  id: string;
  code: string;
  version: number;
  schemaVersion: number;
  definitionHash: string;
  statusCode: string;
  family: { id: string; code: string; name: string; categoryCode: string };
  definition: unknown;
};
type Page = { items: Version[]; total: number; page: number; pageSize: number };

describe('C1 D2b Human template catalogue HTTP contract', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: string;
  let rootUserId: string;
  let memberId: string;
  let organizationId: string;
  let n = 0;
  const key = () => `d2b_catalogue_${++n}`;
  const oldIntegration = process.env.INTEGRATION_API_ENABLED;
  const oldSecret = process.env.INTEGRATION_JWT_SECRET;
  const oldWorkflow = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
  const oldMode = process.env.ACTIVITY_OS_CONTROL_PLANE_MODE;
  beforeAll(async () => {
    process.env.INTEGRATION_API_ENABLED = 'true';
    process.env.INTEGRATION_JWT_SECRET = randomBytes(32).toString('hex');
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    process.env.ACTIVITY_OS_CONTROL_PLANE_MODE = 'active';
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);
    await assertConnectedTestDatabase(prisma);
    await prisma.$executeRaw`TRUNCATE "ActivityMetricCommandReceipt", "ActivityMetricSetItem", "ActivityMetricSetVersion", "ActivityMetricDefinition", "ActivityTemplate", "ActivityTemplateFamily" CASCADE`;
    const root = await prisma.organization.create({ data: { name: key(), nodeTypeCode: 'root' } });
    organizationId = (
      await prisma.organization.create({
        data: { name: key(), nodeTypeCode: 'team', parentId: root.id },
      })
    ).id;
    await prisma.organizationClosure.createMany({
      data: [
        { ancestorId: organizationId, descendantId: organizationId, depth: 0 },
        { ancestorId: root.id, descendantId: organizationId, depth: 1 },
      ],
    });
    memberId = (
      await prisma.member.create({
        data: { memberNo: key(), ...memberIdentityData('模板目录测试'), gradeCode: 'level-3' },
      })
    ).id;
    const actor = await createTestUser(app, { username: key(), role: Role.SUPER_ADMIN });
    rootUserId = actor.id;
    await prisma.user.update({ where: { id: actor.id }, data: { memberId } });
    await prisma.memberOrganizationMembership.create({ data: { memberId, organizationId } });
    auth = (await loginAs(app, actor.username)).authHeader;
    for (const code of ['activity_type', 'activity_category']) {
      const type = await prisma.dictType.create({ data: { code, label: code } });
      await prisma.dictItem.create({
        data: { typeId: type.id, code: 'catalogue_training', label: '测试分类' },
      });
    }
    for (const data of ACTIVITY_TEMPLATE_PERMISSION_SEED)
      await prisma.permission.upsert({ where: { code: data.code }, update: {}, create: data });
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await app?.close();
    if (oldIntegration === undefined) delete process.env.INTEGRATION_API_ENABLED;
    else process.env.INTEGRATION_API_ENABLED = oldIntegration;
    if (oldSecret === undefined) delete process.env.INTEGRATION_JWT_SECRET;
    else process.env.INTEGRATION_JWT_SECRET = oldSecret;
    if (oldWorkflow === undefined) delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
    else process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = oldWorkflow;
    if (oldMode === undefined) delete process.env.ACTIVITY_OS_CONTROL_PLANE_MODE;
    else process.env.ACTIVITY_OS_CONTROL_PLANE_MODE = oldMode;
  });
  const post = (path: string, body: object, credential = auth) =>
    request(httpServer(app)).post(path).set('Authorization', credential).send(body);
  const put = (id: string, body: object, credential = auth) =>
    request(httpServer(app)).put(`${ROOT}/${id}/draft`).set('Authorization', credential).send(body);
  const get = (path = ROOT, credential = auth) =>
    request(httpServer(app)).get(path).set('Authorization', credential);
  const createInput = (extra: object = {}) => ({
    operationKey: key(),
    code: key(),
    name: '全局模板',
    categoryCode: 'catalogue_training',
    activityTypeCode: 'catalogue_training',
    version: 1,
    effectiveFrom: '2000-01-01T00:00:00.000Z',
    definition,
    ...extra,
  });
  function data<T>(response: Response, status: number): T {
    expect(response.status).toBe(status);
    const body = response.body as { code: number; message: string; data: T };
    expect(Object.keys(body).sort()).toEqual(['code', 'data', 'message']);
    expect(body.code).toBe(0);
    expect(body.message).toBe('ok');
    return body.data;
  }
  async function create(extra: object = {}) {
    return parseTemplateVersionReceipt(data(await post(ROOT, createInput(extra)), 201));
  }
  async function human(
    codes: string[],
    role: Role = Role.USER,
    scope: BindingScopeType = 'GLOBAL',
  ) {
    const user = await createTestUser(app, { username: key(), role });
    if (codes.length) {
      const rbacRole = await prisma.rbacRole.create({
        data: { code: key(), displayName: '目录测试角色' },
      });
      const permissions = await prisma.permission.findMany({
        where: { code: { in: codes } },
        select: { id: true },
      });
      expect(permissions).toHaveLength(codes.length);
      await prisma.rolePermission.createMany({
        data: permissions.map((p) => ({ roleId: rbacRole.id, permissionId: p.id })),
      });
      await prisma.roleBinding.create({
        data: {
          principalType: 'USER',
          principalId: user.id,
          roleId: rbacRole.id,
          scopeType: scope,
          ...(scope === 'ORGANIZATION' ? { scopeOrgId: organizationId } : {}),
        },
      });
    }
    return { user, auth: (await loginAs(app, user.username)).authHeader };
  }
  async function state() {
    return {
      families: await prisma.activityTemplateFamily.findMany({ orderBy: { id: 'asc' } }),
      versions: await prisma.activityTemplate.findMany({ orderBy: { id: 'asc' } }),
      receipts: await prisma.activityMetricCommandReceipt.findMany({ orderBy: { id: 'asc' } }),
      audit: await prisma.auditLog.count(),
    };
  }
  async function legacy(schemaVersion: 1 | 2, scope = 'global', familyStatus = 'active') {
    const family = await prisma.activityTemplateFamily.create({
      data: {
        code: key(),
        name: '只读来源',
        categoryCode: 'catalogue_training',
        scopeTypeCode: scope,
        ownerOrganizationId: scope === 'global' ? null : organizationId,
        statusCode: familyStatus,
      },
    });
    const json = {
      activity: { allocationModeCode: 'first_come' },
      sessions: [],
      ...(schemaVersion === 2 ? { registrationForm: form } : {}),
    };
    const row = await prisma.activityTemplate.create({
      data: {
        code: family.code,
        name: family.name,
        familyId: family.id,
        version: 1,
        schemaVersion,
        statusCode: 'draft',
        activityTypeCode: 'catalogue_training',
        effectiveFrom: new Date('2000-01-01'),
        definitionJson: json,
        definitionHash: computeActivityTemplateDefinitionHash({ schemaVersion, definition: json }),
      },
    });
    return { row, json, family };
  }
  function copyInput(source: { id: string; definitionHash: string | null }, extra: object = {}) {
    return {
      operationKey: key(),
      code: key(),
      name: '复制目标',
      categoryCode: 'catalogue_training',
      activityTypeCode: 'catalogue_training',
      version: 1,
      effectiveFrom: '2000-01-01T00:00:00.000Z',
      copyFromVersionId: source.id,
      expectedSourceDefinitionHash: source.definitionHash,
      metricSelection: selection,
      ...extra,
    };
  }

  it.each(['list', 'get', 'create', 'update', 'activate', 'retire'] as const)(
    '%s requires a Human login before any target lookup or DTO handling',
    async (operation) => {
      const http = request(httpServer(app));
      const response =
        operation === 'list'
          ? await http.get(ROOT)
          : operation === 'get'
            ? await http.get(`${ROOT}/missing_id`)
            : operation === 'create'
              ? await http.post(ROOT).send({})
              : operation === 'update'
                ? await http.put(`${ROOT}/missing_id/draft`).send({})
                : await http.post(`${ROOT}/missing_id/${operation}`).send({});
      expectBizError(response, BizCode.UNAUTHORIZED);
    },
  );
  it.each([Role.USER, Role.ADMIN])(
    'bare %s has no implicit template catalogue authority',
    async (role) => {
      const actor = await human([], role);
      expectBizError(await get(ROOT, actor.auth), BizCode.RBAC_FORBIDDEN);
      expectBizError(await get(`${ROOT}/missing_id`, actor.auth), BizCode.RBAC_FORBIDDEN);
      expectBizError(await post(ROOT, createInput(), actor.auth), BizCode.RBAC_FORBIDDEN);
    },
  );
  it('read-only permission does not authorize writes, and write-only permission does not authorize reads', async () => {
    const reader = await human(['activity-template.read.catalog']);
    const writer = await human(['activity-template.manage.version']);
    const created = parseTemplateVersionReceipt(
      data(await post(ROOT, createInput(), writer.auth), 201),
    );
    expect(data<Version>(await get(`${ROOT}/${created.id}`, reader.auth), 200).id).toBe(created.id);
    expectBizError(await post(ROOT, createInput(), reader.auth), BizCode.RBAC_FORBIDDEN);
    expectBizError(await get(`${ROOT}/${created.id}`, writer.auth), BizCode.RBAC_FORBIDDEN);
    expectBizError(
      await get(`${ROOT}/missing_id`, reader.auth),
      BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_FOUND,
    );
  });
  it('an ORGANIZATION binding cannot grant either GLOBAL-only catalogue capability', async () => {
    const actor = await human(
      ACTIVITY_TEMPLATE_PERMISSION_SEED.map((p) => p.code),
      Role.USER,
      'ORGANIZATION',
    );
    expectBizError(await get(ROOT, actor.auth), BizCode.RBAC_FORBIDDEN);
    expectBizError(await post(ROOT, createInput(), actor.auth), BizCode.RBAC_FORBIDDEN);
  });
  it('a verified service token is rejected by all six Human routes', async () => {
    const actor = await prisma.user.findUniqueOrThrow({ where: { id: rootUserId } });
    const meta = { requestId: 'template-machine-boundary', ip: null, ua: null };
    const service = app.get(ServicePrincipalsService);
    const principal = await service.create({ name: '模板机器测试' }, actor, meta);
    const credential = await service.createCredential(principal.id, actor, meta);
    const tokens = app.get(ServiceTokenService);
    const issued = await tokens.issueToken(principal.clientId, credential.clientSecret);
    expect(tokens.verifyToken(issued.accessToken).tokenUse).toBe('service');
    const machine = 'Bearer ' + issued.accessToken;
    expectBizError(await get(ROOT, machine), BizCode.UNAUTHORIZED);
    expectBizError(await get(`${ROOT}/missing_id`, machine), BizCode.UNAUTHORIZED);
    expectBizError(await post(ROOT, {}, machine), BizCode.UNAUTHORIZED);
    expectBizError(await put('missing_id', {}, machine), BizCode.UNAUTHORIZED);
    expectBizError(await post(`${ROOT}/missing_id/activate`, {}, machine), BizCode.UNAUTHORIZED);
    expectBizError(await post(`${ROOT}/missing_id/retire`, {}, machine), BizCode.UNAUTHORIZED);
  });
  it('create → draft replacement → activate → retire retains original receipts and minimal audit', async () => {
    const input = createInput();
    const created = parseTemplateVersionReceipt(data(await post(ROOT, input), 201));
    const replacement = {
      ...definition,
      activity: { allocationModeCode: 'first_come', capacity: 12 },
    };
    const edit = {
      operationKey: key(),
      expectedDefinitionHash: created.definitionHash,
      definition: replacement,
    };
    const changed = parseTemplateVersionReceipt(data(await put(created.id, edit), 200));
    expect(changed.definitionHash).not.toBe(created.definitionHash);
    const activation = { operationKey: key(), expectedDefinitionHash: changed.definitionHash };
    const active = parseTemplateVersionReceipt(
      data(await post(`${ROOT}/${created.id}/activate`, activation), 200),
    );
    expect(active.statusCode).toBe('active');
    const retirement = { operationKey: key(), expectedDefinitionHash: active.definitionHash };
    const retired = parseTemplateVersionReceipt(
      data(await post(`${ROOT}/${created.id}/retire`, retirement), 200),
    );
    expect(retired.statusCode).toBe('retired');
    const before = await state();
    expect(data(await post(ROOT, input), 201)).toEqual(created);
    expect(data(await put(created.id, edit), 200)).toEqual(changed);
    expect(data(await post(`${ROOT}/${created.id}/activate`, activation), 200)).toEqual(active);
    expect(data(await post(`${ROOT}/${created.id}/retire`, retirement), 200)).toEqual(retired);
    expect(await state()).toEqual(before);
    const detail = data<Version>(await get(`${ROOT}/${created.id}`), 200);
    expect(Object.keys(detail).sort()).toEqual([...summaryKeys, 'definition'].sort());
    expect(Object.keys(detail.family).sort()).toEqual(['categoryCode', 'code', 'id', 'name']);
    expect(detail.definition).toEqual(replacement);
    const logs = await prisma.auditLog.findMany({
      where: { event: 'activity.template-version.command', resourceId: created.id },
    });
    expect(logs).toHaveLength(4);
    for (const log of logs) {
      expect(log.resourceType).toBe('activity-template-version');
      const extra = (log.context as Prisma.JsonObject).extra as Prisma.JsonObject;
      expect(Object.keys(extra).sort()).toEqual([
        'afterHash',
        'afterStatus',
        'beforeHash',
        'beforeStatus',
        'operation',
        'source',
        'version',
      ]);
    }
  });
  it('same key with different full definition is a conflict with no partial writes', async () => {
    const input = createInput();
    await post(ROOT, input).expect(201);
    const before = await state();
    expectBizError(
      await post(ROOT, {
        ...input,
        definition: { ...definition, activity: { allocationModeCode: 'first_come', capacity: 3 } },
      }),
      BizCode.ACTIVITY_TEMPLATE_COMMAND_CONFLICT,
    );
    expect(await state()).toEqual(before);
  });
  it('new key with a stale expected hash fails closed', async () => {
    const created = await create();
    const before = await state();
    expectBizError(
      await put(created.id, {
        operationKey: key(),
        expectedDefinitionHash: 'f'.repeat(64),
        definition,
      }),
      BizCode.ACTIVITY_TEMPLATE_VERSION_STALE,
    );
    expect(await state()).toEqual(before);
  });
  it('explicit versions permit gaps but reject duplicate Family/version and duplicate new Family code', async () => {
    const created = await create();
    const detail = data<Version>(await get(`${ROOT}/${created.id}`), 200);
    const input = {
      familyId: detail.family.id,
      activityTypeCode: 'catalogue_training',
      version: 7,
      effectiveFrom: '2000-01-01T00:00:00.000Z',
      operationKey: key(),
      definition,
    };
    const next = parseTemplateVersionReceipt(data(await post(ROOT, input), 201));
    expect(next.version).toBe(7);
    expect(next.code).toBe(created.code);
    const before = await state();
    expectBizError(
      await post(ROOT, { ...input, operationKey: key() }),
      BizCode.ACTIVITY_TEMPLATE_VERSION_ALREADY_EXISTS,
    );
    expectBizError(
      await post(ROOT, createInput({ code: created.code })),
      BizCode.ACTIVITY_TEMPLATE_VERSION_ALREADY_EXISTS,
    );
    expect(await state()).toEqual(before);
  });
  it.each([1, 2] as const)(
    'V%s stays read-only; copying preserves its body/form and does not touch source bytes',
    async (schemaVersion) => {
      const source = await legacy(schemaVersion);
      const shown = data<Version>(await get(`${ROOT}/${source.row.id}`), 200);
      expect(shown.schemaVersion).toBe(schemaVersion);
      expectBizError(
        await put(source.row.id, {
          operationKey: key(),
          expectedDefinitionHash: source.row.definitionHash,
          definition,
        }),
        BizCode.ACTIVITY_METRIC_STATUS_INVALID,
      );
      const copied = parseTemplateVersionReceipt(
        data(await post(ROOT, copyInput(source.row)), 201),
      );
      const detail = data<Version>(await get(`${ROOT}/${copied.id}`), 200);
      expect(detail.schemaVersion).toBe(3);
      expect(detail.definition).toEqual({
        activity: source.json.activity,
        sessions: [],
        registrationForm:
          schemaVersion === 1
            ? null
            : parseActivityTemplateDefinitionV2(source.json).registrationForm,
        metricSelection: selection,
      });
      expect(detail.definitionHash).not.toBe(source.row.definitionHash);
      expect(
        await prisma.activityTemplate.findUniqueOrThrow({ where: { id: source.row.id } }),
      ).toEqual(source.row);
    },
  );
  it('V3 copy preserves the governed form and the explicitly supplied selection', async () => {
    const source = await create({ definition: { ...definition, registrationForm: form } });
    const before = await prisma.activityTemplate.findUniqueOrThrow({ where: { id: source.id } });
    const copied = parseTemplateVersionReceipt(data(await post(ROOT, copyInput(source)), 201));
    expect(data<Version>(await get(`${ROOT}/${copied.id}`), 200).definition).toEqual(
      data<Version>(await get(`${ROOT}/${source.id}`), 200).definition,
    );
    expect(await prisma.activityTemplate.findUniqueOrThrow({ where: { id: source.id } })).toEqual(
      before,
    );
  });
  it.each(['organization', 'inactive-family', 'legacy'] as const)(
    'does not expose or copy %s sources',
    async (mode) => {
      const source = await legacy(
        1,
        mode === 'organization' ? 'organization' : 'global',
        mode === 'inactive-family' ? 'retired' : 'active',
      );
      const row =
        mode === 'legacy'
          ? await prisma.activityTemplate.create({
              data: {
                code: key(),
                name: '旧模板',
                activityTypeCode: 'catalogue_training',
                statusCode: 'draft',
                version: 1,
              },
            })
          : source.row;
      expectBizError(await get(`${ROOT}/${row.id}`), BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_FOUND);
      const before = await state();
      expectBizError(
        await post(
          ROOT,
          copyInput({ id: row.id, definitionHash: row.definitionHash ?? 'a'.repeat(64) }),
        ),
        BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_FOUND,
      );
      expect(await state()).toEqual(before);
      const listed = data<Page>(await get(`${ROOT}?familyId=${source.family.id}`), 200);
      if (mode !== 'legacy') expect(listed).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
    },
  );
  it('filters before pagination/count and deterministically orders equal timestamps', async () => {
    const first = await create();
    const familyId = data<Version>(await get(`${ROOT}/${first.id}`), 200).family.id;
    const second = parseTemplateVersionReceipt(
      data(
        await post(ROOT, {
          familyId,
          operationKey: key(),
          version: 2,
          activityTypeCode: 'catalogue_training',
          effectiveFrom: '2000-01-01T00:00:00.000Z',
          definition,
        }),
        201,
      ),
    );
    const third = parseTemplateVersionReceipt(
      data(
        await post(ROOT, {
          familyId,
          operationKey: key(),
          version: 3,
          activityTypeCode: 'catalogue_training',
          effectiveFrom: '2000-01-01T00:00:00.000Z',
          definition,
        }),
        201,
      ),
    );
    await prisma.activityTemplate.updateMany({
      where: { familyId },
      data: { createdAt: new Date('2020-01-01') },
    });
    await post(`${ROOT}/${third.id}/activate`, {
      operationKey: key(),
      expectedDefinitionHash: third.definitionHash,
    }).expect(200);
    const page = data<Page>(
      await get(`${ROOT}?familyId=${familyId}&statusCode=draft&schemaVersion=3&pageSize=1&page=2`),
      200,
    );
    expect(Object.keys(page).sort()).toEqual(['items', 'page', 'pageSize', 'total']);
    expect(page.total).toBe(2);
    expect(page.page).toBe(2);
    expect(page.pageSize).toBe(1);
    expect(page.items.map((i) => i.id)).toEqual(
      [...[first.id, second.id].sort().reverse()].slice(1),
    );
    expect(Object.keys(page.items[0]).sort()).toEqual(summaryKeys);
    expect(data<Page>(await get(`${ROOT}?familyId=${familyId}&statusCode=retired`), 200)).toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
  });
  it.each([
    'missing-both',
    'both-shapes',
    'source-without-selection',
    'moving-family',
    'window',
  ] as const)('rejects %s create shape without a partial Family', async (mode) => {
    const source = await create();
    const familyId = data<Version>(await get(`${ROOT}/${source.id}`), 200).family.id;
    const input =
      mode === 'missing-both'
        ? { ...createInput(), definition: undefined }
        : mode === 'both-shapes'
          ? { ...copyInput(source), definition }
          : mode === 'source-without-selection'
            ? { ...copyInput(source), metricSelection: undefined }
            : mode === 'moving-family'
              ? createInput({ familyId })
              : createInput({ effectiveTo: '1999-01-01T00:00:00.000Z' });
    const before = await state();
    expectBizError(await post(ROOT, input), BizCode.ACTIVITY_TEMPLATE_DEFINITION_INVALID);
    expect(await state()).toEqual(before);
  });
  it.each(['create', 'copy'] as const)(
    'sensitive form %s requires the existing per-question approval gate',
    async (mode) => {
      const sensitive = {
        fields: [
          {
            ...form.fields[0],
            governance: { ...form.fields[0].governance, dataClassCode: 'sensitive' },
          },
        ],
      };
      const source = await legacy(2);
      const json = { ...source.json, registrationForm: sensitive };
      const hash = computeActivityTemplateDefinitionHash({ schemaVersion: 2, definition: json });
      await prisma.activityTemplate.update({
        where: { id: source.row.id },
        data: { definitionJson: json, definitionHash: hash },
      });
      const input =
        mode === 'create'
          ? createInput({ definition: { ...definition, registrationForm: sensitive } })
          : copyInput({ id: source.row.id, definitionHash: hash });
      const before = await state();
      expectBizError(await post(ROOT, input), BizCode.ACTIVITY_TEMPLATE_DEFINITION_INVALID);
      expect(await state()).toEqual(before);
    },
  );
  it('a shape-valid but wrong stored hash is not accepted for detail, copy or activation', async () => {
    const created = await create();
    const wrong = 'a'.repeat(64);
    await prisma.activityTemplate.update({
      where: { id: created.id },
      data: { definitionHash: wrong },
    });
    const before = await state();
    expectBizError(
      await get(`${ROOT}/${created.id}`),
      BizCode.ACTIVITY_TEMPLATE_DEFINITION_INVALID,
    );
    expectBizError(
      await post(ROOT, copyInput({ id: created.id, definitionHash: wrong })),
      BizCode.ACTIVITY_TEMPLATE_DEFINITION_INVALID,
    );
    expectBizError(
      await post(`${ROOT}/${created.id}/activate`, {
        operationKey: key(),
        expectedDefinitionHash: wrong,
      }),
      BizCode.ACTIVITY_TEMPLATE_DEFINITION_INVALID,
    );
    expect(await state()).toEqual(before);
  });
  it.each(['create', 'update'] as const)(
    'audit failure rolls back %s, including its command receipt',
    async (mode) => {
      const created = await create();
      const before = await state();
      jest
        .spyOn(app.get(ActivityTemplateVersionAuditRecorder), 'log')
        .mockRejectedValueOnce(new BizException(BizCode.INTERNAL_ERROR));
      const response =
        mode === 'create'
          ? await post(ROOT, createInput())
          : await put(created.id, {
              operationKey: key(),
              expectedDefinitionHash: created.definitionHash,
              definition: {
                ...definition,
                activity: { allocationModeCode: 'first_come', capacity: 4 },
              },
            });
      expectBizError(response, BizCode.INTERNAL_ERROR);
      expect(await state()).toEqual(before);
    },
  );
  async function metricCatalogue() {
    const defs = '/api/admin/v1/activity-metric-definitions';
    const sets = '/api/admin/v1/activity-metric-sets';
    const metric = parseMetricReceipt(
      data(
        await post(defs, {
          operationKey: key(),
          definition: {
            schemaVersion: 1,
            code: key(),
            version: 1,
            name: '完成',
            configuration: { kindCode: 'boolean', unit: null },
          },
        }),
        201,
      ),
    );
    await post(`${defs}/${metric.id}/activate`, {
      operationKey: key(),
      expectedDefinitionHash: metric.definitionHash,
    }).expect(200);
    const set = parseMetricReceipt(
      data(
        await post(sets, {
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
                metricDefinitionId: metric.id,
                definitionHash: metric.definitionHash,
              },
            ],
          },
        }),
        201,
      ),
    );
    await post(`${sets}/${set.id}/activate`, {
      operationKey: key(),
      expectedDefinitionHash: set.definitionHash,
    }).expect(200);
    const pointer = {
      id: set.id,
      code: set.code,
      version: set.version,
      schemaVersion: set.schemaVersion,
      definitionHash: set.definitionHash,
    };
    const required = { metricRequirementCode: 'required', metricSetPointer: pointer };
    return { pointer, required, set };
  }
  it('real HTTP builds Definition → Set → Family/V3 → active template → quick Activity', async () => {
    const { pointer, required, set } = await metricCatalogue();
    const template = await create({
      definition: { ...definition, metricSelection: required },
      effectiveFrom: '2200-01-01T00:00:00.000Z',
    });
    await post(`${ROOT}/${template.id}/activate`, {
      operationKey: key(),
      expectedDefinitionHash: template.definitionHash,
    }).expect(200);
    const command = {
      templateVersionId: template.id,
      operationKey: key(),
      title: 'HTTP 完整创建链',
      organizationId,
      initiatorMemberId: memberId,
      startAt: '2099-09-01T08:00:00.000Z',
      endAt: '2099-09-01T10:00:00.000Z',
      location: '测试集合点',
      defaultPlaceVisibilityCode: 'staff',
    };
    const result = data<{ activity: { activityId: string } }>(
      await post('/api/app/v1/my/managed-activities/from-template', command),
      201,
    );
    expect(
      await prisma.activity.findUniqueOrThrow({
        where: { id: result.activity.activityId },
        select: {
          selectedTemplateVersionId: true,
          metricRequirementCode: true,
          selectedMetricSetVersionId: true,
          selectedMetricSetDefinitionHash: true,
          metricSelectionRevision: true,
        },
      }),
    ).toEqual({
      selectedTemplateVersionId: template.id,
      metricRequirementCode: 'required',
      selectedMetricSetVersionId: set.id,
      selectedMetricSetDefinitionHash: set.definitionHash,
      metricSelectionRevision: 1,
    });
    expect(
      data<{ metricSetPointer: unknown }>(
        await get(
          `/api/app/v1/my/managed-activities/${result.activity.activityId}/metric-selection`,
        ),
        200,
      ).metricSetPointer,
    ).toEqual(pointer);
  });
  it.each(['create-existing-family', 'copy', 'update', 'activate'] as const)(
    '%s rejects a Family that becomes unavailable while waiting for its metric-set lock',
    async (mode) => {
      const { required, set } = await metricCatalogue();
      const target = await create({
        definition: mode === 'activate' ? { ...definition, metricSelection: required } : definition,
      });
      const source = mode === 'copy' ? await legacy(1) : null;
      const targetDetail = data<Version>(await get(`${ROOT}/${target.id}`), 200);
      const familyId = source?.family.id ?? targetDetail.family.id;
      let ready!: (pid: number) => void;
      let unlock!: () => void;
      const holderReady = new Promise<number>((resolve) => {
        ready = resolve;
      });
      const released = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const held = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "ActivityMetricSetVersion" WHERE id = ${set.id} FOR UPDATE`;
          const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          ready(row.pid);
          await released;
        },
        { timeout: 10000 },
      );
      const pid = await Promise.race([
        holderReady,
        held.then(() => {
          throw new Error('holder ended before readiness');
        }),
      ]);
      const input = {
        operationKey: key(),
        expectedDefinitionHash: target.definitionHash,
        definition: { ...definition, metricSelection: required },
      };
      const pending =
        mode === 'create-existing-family'
          ? post(ROOT, {
              familyId,
              operationKey: key(),
              version: 2,
              activityTypeCode: 'catalogue_training',
              effectiveFrom: '2000-01-01T00:00:00.000Z',
              definition: input.definition,
            }).then((response) => response)
          : mode === 'copy'
            ? post(ROOT, copyInput(source!.row, { metricSelection: required })).then(
                (response) => response,
              )
            : mode === 'update'
              ? put(target.id, input).then((response) => response)
              : post(`${ROOT}/${target.id}/activate`, {
                  operationKey: input.operationKey,
                  expectedDefinitionHash: input.expectedDefinitionHash,
                }).then((response) => response);
      let before: Awaited<ReturnType<typeof state>>;
      try {
        await waitFor(
          async () => {
            const [row] = await prisma.$queryRaw<
              { waiting: boolean }[]
            >`SELECT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = current_database() AND a.wait_event_type = 'Lock' AND ${pid} = ANY(pg_blocking_pids(a.pid))) AS waiting`;
            return row.waiting;
          },
          { timeoutMs: 2500, message: 'template command did not wait on the intended set lock' },
        );
        await prisma.activityTemplateFamily.update({
          where: { id: familyId },
          data: { statusCode: 'retired' },
        });
        before = await state();
      } finally {
        unlock();
        await held;
      }
      expectBizError(await pending, BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_FOUND);
      expect(await state()).toEqual(before);
    },
  );
});
