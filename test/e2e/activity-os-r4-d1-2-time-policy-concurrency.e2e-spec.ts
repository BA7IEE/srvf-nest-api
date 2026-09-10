import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus, Prisma, PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityTimePolicyService } from '../../src/modules/activities/activity-time-policy.service';
import { ActivityTimePolicyCommand } from '../../src/modules/activities/activity-time-policy-command';
import { ActivityTimePolicyCatalogueQueryService } from '../../src/modules/activities/activity-time-policy-catalogue-query.service';
import { ActivityTimePolicyAuditRecorder } from '../../src/modules/activities/activity-time-policy-audit-recorder';
import { RbacService } from '../../src/modules/permissions/rbac.service';
import { ACTIVITY_TIME_POLICY_PERMISSION_SEED } from '../../src/modules/permissions/permission-catalog';
import { createTestUser } from '../fixtures/users.fixture';
import { waitFor } from '../helpers/wait-for';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertConnectedTestDatabase, assertTestDatabaseUrl } from '../setup/test-db';

const meta = { requestId: 'time-policy-race', ip: null, ua: null };
class ObservedPolicyDatabase extends PrismaClient<Prisma.PrismaClientOptions, 'query'> {
  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
describe('D1-2 real PostgreSQL command races', () => {
  let app: INestApplication;
  let db: PrismaService;
  let service: ActivityTimePolicyService;
  let user: CurrentUserPayload;
  let n = 0;
  const prefix = 'tpr_' + randomBytes(5).toString('hex');
  const key = () => prefix + '_' + ++n;
  const input = () => ({ operationKey: key(), code: key(), name: 'Race policy' });
  const version = () => ({
    operationKey: key(),
    schemaVersion: 1,
    evaluatorVersion: 1,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveUntil: null,
    definition: {
      defaultCategory: 'volunteer_service',
      roleMappings: [],
      allowSplit: false,
      specialIntervals: {
        preparation: { mode: 'exclude' },
        duty: { mode: 'exclude' },
        travel: { mode: 'exclude' },
      },
      rounding: { mode: 'floor', quantumSeconds: 1 },
      evidence: { requiredSources: [], requireManualRecognition: false },
      manualAdjustment: { enabled: false },
    },
  });
  async function human() {
    const actor = await createTestUser(app, { username: key(), role: Role.USER });
    const r = await db.rbacRole.create({ data: { code: key(), displayName: 'Race policy role' } });
    const p = await db.permission.findUniqueOrThrow({
      where: { code: 'activity-time-policy.manage.version' },
    });
    await db.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } });
    const binding = await db.roleBinding.create({
      data: {
        principalType: 'USER',
        principalId: actor.id,
        roleId: r.id,
        scopeType: 'GLOBAL',
      },
    });
    return { actor, binding };
  }
  beforeAll(async () => {
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: process.env,
      stdio: 'pipe',
    });
    app = await createTestApp();
    db = app.get(PrismaService);
    service = app.get(ActivityTimePolicyService);
    await assertConnectedTestDatabase(db);
    await resetDb(app);
    for (const p of ACTIVITY_TIME_POLICY_PERMISSION_SEED)
      await db.permission.upsert({ where: { code: p.code }, create: { ...p }, update: {} });
    user = (await human()).actor;
  }, 60000);
  afterAll(async () => {
    if (app) await app.close();
  });

  it('measures real application SQL against the approved budget', async () => {
    const reader = await db.permission.findUniqueOrThrow({
      where: { code: 'activity-time-policy.read.catalog' },
    });
    const binding = await db.roleBinding.findFirstOrThrow({ where: { principalId: user.id } });
    await db.rolePermission.create({ data: { roleId: binding.roleId, permissionId: reader.id } });
    const observed = new ObservedPolicyDatabase({ log: [{ emit: 'event', level: 'query' }] });
    const statements: string[] = [];
    observed.$on('query', (event) => {
      if (!/^\s*(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)\b/i.test(event.query))
        statements.push(event.query);
    });
    try {
      await assertConnectedTestDatabase(observed);
      const commands = new ActivityTimePolicyCommand(observed, new RbacService(observed));
      const measured = new ActivityTimePolicyService(
        commands,
        app.get(ActivityTimePolicyAuditRecorder),
      );
      const query = new ActivityTimePolicyCatalogueQueryService(observed, commands);
      const counts: Record<string, number> = {};
      statements.length = 0;
      const p = await measured.createPolicy(input(), user, meta);
      counts.createPolicy = statements.length;
      statements.length = 0;
      const v = await measured.createVersion(p.policyId, version(), user, meta);
      counts.createVersion = statements.length;
      if (!v.versionId) throw new Error('measured version missing');
      statements.length = 0;
      await measured.transition(
        'activate',
        p.policyId,
        v.versionId,
        {
          operationKey: key(),
          expectedDefinitionHash: v.definitionHash,
          expectedStatusCode: 'draft',
        },
        user,
        meta,
      );
      counts.activate = statements.length;
      statements.length = 0;
      await query.list({ page: 1, pageSize: 20 }, user);
      counts.list = statements.length;
      statements.length = 0;
      await query.listVersions(p.policyId, { page: 1, pageSize: 20 }, user);
      counts.listVersions = statements.length;
      statements.length = 0;
      await query.getVersion(p.policyId, v.versionId, user);
      counts.detail = statements.length;
      console.info('D1-2 measured application SQL', counts);
      expect(Object.values(counts).every((n) => n > 0)).toBe(true);
      expect(counts.createPolicy).toBeLessThanOrEqual(50);
      expect(counts.createVersion).toBeLessThanOrEqual(50);
      expect(counts.activate).toBeLessThanOrEqual(50);
      expect(counts.list).toBeLessThanOrEqual(12);
      expect(counts.listVersions).toBeLessThanOrEqual(12);
      expect(counts.detail).toBeLessThanOrEqual(11);
    } finally {
      await observed.$disconnect();
    }
  });

  it('same key concurrent creation is one policy, receipt and audit', async () => {
    const command = input();
    const results = await Promise.all(
      [1, 2, 3].map(() => service.createPolicy(command, user, meta)),
    );
    expect(results).toEqual([results[0], results[0], results[0]]);
    expect(await db.timePolicy.count({ where: { code: command.code } })).toBe(1);
    expect(
      await db.timePolicyCommandReceipt.count({ where: { policyId: results[0].policyId } }),
    ).toBe(1);
    expect(await db.auditLog.count({ where: { resourceId: results[0].policyId } })).toBe(1);
  });
  it('rolls back an expired transaction without an automatic retry', async () => {
    const recorder = app.get(ActivityTimePolicyAuditRecorder);
    const original = recorder.log.bind(recorder);
    const delayed = jest.spyOn(recorder, 'log').mockImplementationOnce(async (...args) => {
      // Deliberately exceed the real 5000ms transaction deadline after the policy insert.
      // This is a deterministic timeout fixture, not a guessed concurrency rendezvous.
      await args[0].$queryRaw`SELECT pg_sleep(5.2)::text`;
      return original(...args);
    });
    const command = input();
    try {
      await expect(service.createPolicy(command, user, meta)).rejects.toMatchObject({
        code: 'P2028',
      });
      expect(delayed).toHaveBeenCalledTimes(1);
      expect(await db.timePolicy.count({ where: { code: command.code } })).toBe(0);
      expect(
        await db.timePolicyCommandReceipt.count({
          where: { actorUserId: user.id, operationKey: command.operationKey },
        }),
      ).toBe(0);
    } finally {
      delayed.mockRestore();
    }
    const result = await service.createPolicy(command, user, meta);
    expect(await db.auditLog.count({ where: { resourceId: result.policyId } })).toBe(1);
  });
  it('same key different input has exactly one winner', async () => {
    const command = input();
    const results = await Promise.allSettled([
      service.createPolicy(command, user, meta),
      service.createPolicy({ ...command, name: 'Different' }, user, meta),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { biz: BizCode.ACTIVITY_TIME_POLICY_COMMAND_CONFLICT },
    });
  });
  it('different keys cannot reuse the stable policy code', async () => {
    const command = input();
    const results = await Promise.allSettled([
      service.createPolicy(command, user, meta),
      service.createPolicy({ ...command, operationKey: key() }, user, meta),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { biz: BizCode.ACTIVITY_TIME_POLICY_CODE_EXISTS },
    });
  });
  it('different keys allocate monotone distinct versions under the policy row lock', async () => {
    const p = await service.createPolicy(input(), user, meta);
    const results = await Promise.all(
      [1, 2, 3].map(() => service.createVersion(p.policyId, version(), user, meta)),
    );
    expect(new Set(results.map((r) => r.versionId)).size).toBe(3);
    expect(
      await db.timePolicyVersion.findMany({
        where: { policyId: p.policyId },
        orderBy: { version: 'asc' },
        select: { version: true },
      }),
    ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
  });
  it('concurrent activation cannot emit two transitions or audits', async () => {
    const p = await service.createPolicy(input(), user, meta);
    const v = await service.createVersion(p.policyId, version(), user, meta);
    if (!v.versionId) throw new Error('version fixture missing');
    const vid = v.versionId;
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        service.transition(
          'activate',
          p.policyId,
          vid,
          {
            operationKey: key(),
            expectedDefinitionHash: v.definitionHash,
            expectedStatusCode: 'draft',
          },
          user,
          meta,
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { biz: BizCode.ACTIVITY_TIME_POLICY_STALE },
    });
    expect(await db.auditLog.count({ where: { resourceId: p.policyId } })).toBe(3);
  });

  it.each(['command-revoke', 'command-disable', 'policy-revoke', 'version-revoke'] as const)(
    'rechecks current access after %s lock wait',
    async (mode) => {
      const { actor, binding } = await human();
      const command = input();
      const p = await service.createPolicy(command, actor, meta);
      const vi = version();
      const v = await service.createVersion(p.policyId, vi, actor, meta);
      if (!v.versionId) throw new Error('version fixture missing');
      const vid = v.versionId;
      const lockKey = JSON.stringify([
        'activity-time-policy',
        actor.id,
        'create_policy',
        command.operationKey,
      ]);
      let locked!: () => void;
      let unlock!: () => void;
      const ready = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const release = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const blocker = db.$transaction(
        async (tx) => {
          if (mode.startsWith('command'))
            await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text`;
          else if (mode === 'policy-revoke')
            await tx.$queryRaw(
              Prisma.sql`SELECT "id" FROM "TimePolicy" WHERE "id" = ${p.policyId} FOR UPDATE`,
            );
          else
            await tx.$queryRaw(
              Prisma.sql`SELECT "id" FROM "TimePolicyVersion" WHERE "id" = ${vid} FOR UPDATE`,
            );
          locked();
          await release;
        },
        { timeout: 10000 },
      );
      await ready;
      const pending = Promise.allSettled([
        mode.startsWith('command')
          ? service.createPolicy(command, actor, meta)
          : mode === 'policy-revoke'
            ? service.createVersion(p.policyId, version(), actor, meta)
            : service.transition(
                'activate',
                p.policyId,
                vid,
                {
                  operationKey: key(),
                  expectedDefinitionHash: v.definitionHash,
                  expectedStatusCode: 'draft',
                },
                actor,
                meta,
              ),
      ]);
      try {
        await waitFor(
          async () => {
            const rows = await db.$queryRaw<
              { count: bigint }[]
            >`SELECT count(*) FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND pid <> pg_backend_pid()
            AND (query LIKE '%pg_advisory_xact_lock%' OR query LIKE '%TimePolicy%FOR UPDATE%')`;
            return rows[0].count >= 1n;
          },
          { timeoutMs: 2500 },
        );
        if (mode === 'command-disable')
          await db.user.update({ where: { id: actor.id }, data: { status: UserStatus.DISABLED } });
        else
          await db.roleBinding.update({
            where: { id: binding.id },
            data: { endedAt: new Date(0) },
          });
      } finally {
        unlock();
        await blocker;
      }
      expect(await pending).toMatchObject([
        {
          status: 'rejected',
          reason: {
            biz: mode === 'command-disable' ? BizCode.UNAUTHORIZED : BizCode.RBAC_FORBIDDEN,
          },
        },
      ]);
      expect(await db.timePolicyVersion.count({ where: { policyId: p.policyId } })).toBe(1);
      expect(await db.timePolicyCommandReceipt.count({ where: { policyId: p.policyId } })).toBe(2);
      expect(await db.auditLog.count({ where: { resourceId: p.policyId } })).toBe(2);
      expect(
        (await db.timePolicyVersion.findUniqueOrThrow({ where: { id: vid } })).statusCode,
      ).toBe('draft');
    },
  );
});
