import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Role, UserStatus } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { CONTRIBUTION_POLICY_PERMISSION_SEED } from '../../src/modules/permissions/permission-catalog';
import { ActivityContributionPolicyAuditRecorder } from '../../src/modules/activities/activity-contribution-policy-audit-recorder';
import { IntegrationAuthGate } from '../../src/modules/integration-auth/integration-auth.gate';
import { ServiceTokenService } from '../../src/modules/integration-auth/service-token.service';
import { DelegatedTokenService } from '../../src/modules/integration-auth/delegated-token.service';
import { parseContributionPolicyReceipt } from '../../src/modules/activities/activity-contribution-policy-command';
import { createTestUser } from '../fixtures/users.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertConnectedTestDatabase, assertTestDatabaseUrl } from '../setup/test-db';

const ROOT = '/api/system/v1/contribution-policies';
const READ = 'contribution-policy.read.catalog';
const WRITE = 'contribution-policy.manage.version';
function version(operationKey: string) {
  return {
    operationKey,
    schemaVersion: 1,
    evaluatorVersion: 1,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveUntil: null,
    definition: {
      defaultResult: { recognizedPoints: '0.00', explanationCode: 'default_zero' },
      roleRules: [
        {
          attendanceRoleCode: 'service',
          categoryRules: [
            {
              timeCategoryCode: 'volunteer_service',
              durationBands: [
                {
                  maxSecondsInclusive: null,
                  recognizedPoints: '1.00',
                  explanationCode: 'service_credit',
                },
              ],
            },
          ],
        },
      ],
    },
  };
}
describe('E1-2 Human catalogue HTTP', () => {
  const previousSecret = process.env.INTEGRATION_JWT_SECRET;
  let app: INestApplication;
  let db: PrismaService;
  let auth: string;
  let sa: string;
  let n = 0;
  const prefix = 'cp_' + randomBytes(5).toString('hex');
  const key = () => prefix + '_' + ++n;
  beforeAll(async () => {
    process.env.INTEGRATION_JWT_SECRET = randomBytes(48).toString('hex');
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: process.env,
      stdio: 'pipe',
    });
    app = await createTestApp();
    db = app.get(PrismaService);
    await assertConnectedTestDatabase(db);
    await resetDb(app);
    for (const p of CONTRIBUTION_POLICY_PERMISSION_SEED)
      await db.permission.upsert({ where: { code: p.code }, create: { ...p }, update: {} });
    auth = (await human([READ, WRITE])).auth;
    sa = (await human([], Role.SUPER_ADMIN)).auth;
  }, 60000);
  afterAll(async () => {
    if (app) await app.close();
    if (previousSecret === undefined) delete process.env.INTEGRATION_JWT_SECRET;
    else process.env.INTEGRATION_JWT_SECRET = previousSecret;
  });
  async function human(codes: string[], role: Role = Role.USER) {
    const user = await createTestUser(app, { username: key(), role });
    let bindingId: string | null = null;
    if (codes.length) {
      const r = await db.rbacRole.create({
        data: { code: key(), displayName: '贡献政策测试角色' },
      });
      const permissions = await db.permission.findMany({ where: { code: { in: codes } } });
      expect(permissions).toHaveLength(codes.length);
      await db.rolePermission.createMany({
        data: permissions.map((p) => ({ roleId: r.id, permissionId: p.id })),
      });
      const b = await db.roleBinding.create({
        data: {
          principalType: 'USER',
          principalId: user.id,
          roleId: r.id,
          scopeType: 'GLOBAL',
        },
      });
      bindingId = b.id;
    }
    return { user, bindingId, auth: (await loginAs(app, user.username)).authHeader };
  }
  const post = (path: string, input: object, credential = auth) =>
    request(httpServer(app)).post(path).set('Authorization', credential).send(input);
  const get = (path: string, credential = auth) =>
    request(httpServer(app)).get(path).set('Authorization', credential);
  async function policy(credential = auth) {
    const input = {
      operationKey: key(),
      code: key(),
      name: '贡献政策',
      description: '用于 E1-2 目录验收',
    };
    const response = await post(ROOT, input, credential).expect(201);
    expect(response.body.code).toBe(0);
    return { input, receipt: parseContributionPolicyReceipt(response.body.data) };
  }
  async function draft(policyId: string) {
    const input = version(key());
    const response = await post(ROOT + '/' + policyId + '/versions', input).expect(201);
    return { input, receipt: parseContributionPolicyReceipt(response.body.data) };
  }
  it('requires authentication and does not let an ungranted SA read or write', async () => {
    expectBizError(await request(httpServer(app)).get(ROOT), BizCode.UNAUTHORIZED);
    expectBizError(await get(ROOT, sa), BizCode.RBAC_FORBIDDEN);
    expectBizError(
      await post(ROOT, { operationKey: key(), code: key(), name: 'Policy' }, sa),
      BizCode.RBAC_FORBIDDEN,
    );
  });
  it.each(['service', 'delegated'] as const)(
    'rejects signed %s credentials on all eight operations without enabling Gate',
    async (kind) => {
      const gate = app.get(IntegrationAuthGate);
      expect(gate.isEnabled()).toBe(false);
      const actor = await human([READ, WRITE]);
      const p = await policy();
      const v = await draft(p.receipt.policyId);
      const token = new JwtService({ secret: gate.jwtSecret }).sign(
        {
          tokenUse: kind,
          credentialId: key(),
          ...(kind === 'delegated' ? { delegationGrantId: key(), act: { sub: key() } } : {}),
        },
        {
          algorithm: 'HS256',
          subject: actor.user.id,
          issuer: gate.issuer,
          audience: gate.audience,
          jwtid: key(),
          expiresIn: 60,
        },
      );
      const verified =
        kind === 'service'
          ? app.get(ServiceTokenService).verifyToken(token)
          : app.get(DelegatedTokenService).verifyToken(token);
      expect(verified.tokenUse).toBe(kind);
      const credential = 'Bearer ' + token;
      const base = ROOT + '/' + p.receipt.policyId;
      const versionPath = base + '/versions/' + v.receipt.versionId;
      for (const path of [ROOT, base, base + '/versions', versionPath])
        expectBizError(await get(path, credential), BizCode.UNAUTHORIZED);
      for (const [path, body] of [
        [ROOT, { operationKey: key(), code: key(), name: 'Denied machine' }],
        [base + '/versions', version(key())],
        [
          versionPath + '/activate',
          {
            operationKey: key(),
            expectedDefinitionHash: v.receipt.definitionHash,
            expectedStatusCode: 'draft',
          },
        ],
        [
          versionPath + '/retire',
          {
            operationKey: key(),
            expectedDefinitionHash: v.receipt.definitionHash,
            expectedStatusCode: 'active',
          },
        ],
      ] as const)
        expectBizError(await post(path, body, credential), BizCode.UNAUTHORIZED);
      expect(gate.isEnabled()).toBe(false);
    },
  );
  it('read and write grants remain independent', async () => {
    const reader = await human([READ]);
    const writer = await human([WRITE]);
    await get(ROOT, reader.auth).expect(200);
    expectBizError(
      await post(ROOT, { operationKey: key(), code: key(), name: 'Policy' }, reader.auth),
      BizCode.RBAC_FORBIDDEN,
    );
    const p = await policy(writer.auth);
    expectBizError(await get(ROOT + '/' + p.receipt.policyId, writer.auth), BizCode.RBAC_FORBIDDEN);
  });
  it.each(['future', 'expired', 'inactive', 'deleted-role'] as const)(
    'rejects %s grants without changing policy state',
    async (mode) => {
      const actor = await human([READ, WRITE]);
      if (!actor.bindingId) throw new Error('binding fixture missing');
      const binding = await db.roleBinding.findUniqueOrThrow({ where: { id: actor.bindingId } });
      if (mode === 'deleted-role')
        await db.rbacRole.update({
          where: { id: binding.roleId },
          data: { deletedAt: new Date() },
        });
      else
        await db.roleBinding.update({
          where: { id: binding.id },
          data:
            mode === 'future'
              ? { startedAt: new Date('2099-01-01T00:00:00.000Z') }
              : mode === 'expired'
                ? { endedAt: new Date(0) }
                : { status: 'SUSPENDED' },
        });
      expectBizError(await get(ROOT, actor.auth), BizCode.RBAC_FORBIDDEN);
      const input = { operationKey: key(), code: key(), name: 'Denied policy' };
      expectBizError(await post(ROOT, input, actor.auth), BizCode.RBAC_FORBIDDEN);
      expect(await db.contributionPolicy.count({ where: { code: input.code } })).toBe(0);
    },
  );
  it('eight routes preserve immutable history and original receipts', async () => {
    const p = await policy();
    expect((await post(ROOT, p.input).expect(201)).body.data).toEqual(p.receipt);
    const v = await draft(p.receipt.policyId);
    const path = ROOT + '/' + p.receipt.policyId;
    const vpath = path + '/versions/' + v.receipt.versionId;
    const activation = {
      operationKey: key(),
      expectedDefinitionHash: v.receipt.definitionHash,
      expectedStatusCode: 'draft',
    };
    const active = parseContributionPolicyReceipt(
      (await post(vpath + '/activate', activation).expect(200)).body.data,
    );
    expect(active.resultStatusCode).toBe('active');
    const retired = parseContributionPolicyReceipt(
      (
        await post(vpath + '/retire', {
          operationKey: key(),
          expectedDefinitionHash: v.receipt.definitionHash,
          expectedStatusCode: 'active',
        }).expect(200)
      ).body.data,
    );
    expect(retired.resultStatusCode).toBe('retired');
    expect((await post(vpath + '/activate', activation).expect(200)).body.data).toEqual(active);
    expect((await post(path + '/versions', v.input).expect(201)).body.data).toEqual(v.receipt);
    const detail = await get(vpath).expect(200);
    expect(detail.body.data.statusCode).toBe('retired');
    expect(detail.body.data.definition).toEqual(v.input.definition);
    expect(detail.body.data).not.toHaveProperty('actorUserId');
    expect(detail.body.data).not.toHaveProperty('createdByUserId');
    expect(detail.body.data).not.toHaveProperty('operationKey');
    const policyDetail = (await get(path).expect(200)).body.data;
    expect(policyDetail.code).toBe(p.input.code);
    expect(policyDetail.description).toBe(p.input.description);
    const list = await get(ROOT + '?code=' + p.input.code).expect(200);
    expect(list.body.data.total).toBe(1);
    const versions = await get(path + '/versions?statusCode=retired').expect(200);
    expect(versions.body.data.total).toBe(1);
    expect(versions.body.data.items[0]).not.toHaveProperty('definition');
    expect(versions.body.data.items[0]).not.toHaveProperty('definitionJson');
    expect(
      await db.auditLog.count({
        where: {
          resourceId: p.receipt.policyId,
          event: 'activity.contribution-policy.command',
        },
      }),
    ).toBe(1);
    expect(
      await db.auditLog.count({
        where: {
          resourceId: v.receipt.versionId ?? '',
          event: 'activity.contribution-policy-version.command',
        },
      }),
    ).toBe(3);
    expect(
      await db.contributionPolicyCommandReceipt.count({ where: { policyId: p.receipt.policyId } }),
    ).toBe(4);
  });
  it('rejects code reuse, payload conflict, cross-policy IDs and stale expectations', async () => {
    const p = await policy();
    expectBizError(
      await post(ROOT, { ...p.input, operationKey: key() }),
      BizCode.ACTIVITY_CONTRIBUTION_POLICY_CODE_EXISTS,
    );
    expectBizError(
      await post(ROOT, { ...p.input, name: 'Changed' }),
      BizCode.ACTIVITY_CONTRIBUTION_POLICY_COMMAND_CONFLICT,
    );
    const v = await draft(p.receipt.policyId);
    const other = await policy();
    expectBizError(
      await get(ROOT + '/' + other.receipt.policyId + '/versions/' + v.receipt.versionId),
      BizCode.ACTIVITY_CONTRIBUTION_POLICY_NOT_FOUND,
    );
    expectBizError(
      await post(
        ROOT + '/' + p.receipt.policyId + '/versions/' + v.receipt.versionId + '/activate',
        {
          operationKey: key(),
          expectedDefinitionHash: 'a'.repeat(64),
          expectedStatusCode: 'draft',
        },
      ),
      BizCode.ACTIVITY_CONTRIBUTION_POLICY_STALE,
    );
    await request(httpServer(app))
      .delete(ROOT + '/' + p.receipt.policyId)
      .set('Authorization', auth)
      .expect(404);
  });
  it.each([
    { schemaVersion: 2 },
    { evaluatorVersion: 2 },
    { effectiveFrom: '2026-01-01' },
    { effectiveUntil: '2025-01-01T00:00:00.000Z' },
    { version: 4 },
  ])('rejects invalid version metadata %#', async (extra) => {
    const p = await policy();
    const response = await post(ROOT + '/' + p.receipt.policyId + '/versions', {
      ...version(key()),
      ...extra,
    });
    expect(response.status).toBe(400);
    expect(response.body.data).toBeNull();
    expect(
      await db.contributionPolicyVersion.count({ where: { policyId: p.receipt.policyId } }),
    ).toBe(0);
  });
  it('rejects duplicate roles and malformed duration bands', async () => {
    const p = await policy();
    const input = version(key());
    expectBizError(
      await post(ROOT + '/' + p.receipt.policyId + '/versions', {
        ...input,
        definition: {
          ...input.definition,
          roleRules: [input.definition.roleRules[0], input.definition.roleRules[0]],
        },
      }),
      BizCode.ACTIVITY_CONTRIBUTION_POLICY_INVALID,
    );
    expectBizError(
      await post(ROOT + '/' + p.receipt.policyId + '/versions', {
        ...input,
        definition: {
          ...input.definition,
          roleRules: [
            {
              ...input.definition.roleRules[0],
              categoryRules: [
                {
                  ...input.definition.roleRules[0].categoryRules[0],
                  durationBands: [
                    {
                      maxSecondsInclusive: 30,
                      recognizedPoints: '1.00',
                      explanationCode: 'missing_open_band',
                    },
                  ],
                },
              ],
            },
          ],
        },
      }),
      BizCode.ACTIVITY_CONTRIBUTION_POLICY_INVALID,
    );
  });
  it('rolls policy and receipt back if audit writing fails', async () => {
    const recorder = app.get(ActivityContributionPolicyAuditRecorder);
    const spy = jest.spyOn(recorder, 'log').mockRejectedValueOnce(new Error('test audit failure'));
    const input = { operationKey: key(), code: key(), name: 'Rollback' };
    try {
      await post(ROOT, input).expect(500);
    } finally {
      spy.mockRestore();
    }
    expect(await db.contributionPolicy.count({ where: { code: input.code } })).toBe(0);
    expect(
      await db.contributionPolicyCommandReceipt.count({
        where: { operationKey: input.operationKey },
      }),
    ).toBe(0);
  });
  it('revocation and account disablement deny previously successful replay', async () => {
    const actor = await human([WRITE]);
    const p = await policy(actor.auth);
    if (!actor.bindingId) throw new Error('fixture binding missing');
    await db.roleBinding.update({ where: { id: actor.bindingId }, data: { endedAt: new Date(0) } });
    expectBizError(await post(ROOT, p.input, actor.auth), BizCode.RBAC_FORBIDDEN);
    await db.user.update({ where: { id: actor.user.id }, data: { status: UserStatus.DISABLED } });
    expectBizError(await post(ROOT, p.input, actor.auth), BizCode.UNAUTHORIZED);
    expect(
      await db.contributionPolicyCommandReceipt.count({ where: { policyId: p.receipt.policyId } }),
    ).toBe(1);
  });
  it('pagination refuses null filters and out-of-budget page size', async () => {
    await get(ROOT + '?pageSize=101').expect(400);
    await get(ROOT + '?code=').expect(400);
    await get(ROOT + '/missing_id/versions').expect(404);
  });
});
