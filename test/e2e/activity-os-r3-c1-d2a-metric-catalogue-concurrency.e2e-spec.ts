import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityMetricDefinitionService } from '../../src/modules/activities/activity-metric-definition.service';
import { ActivityMetricSetService } from '../../src/modules/activities/activity-metric-set.service';
import { createTestUser } from '../fixtures/users.fixture';
import { waitFor } from '../helpers/wait-for';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertConnectedTestDatabase, assertTestDatabaseUrl } from '../setup/test-db';

const meta = { requestId: 'c1-d2a-concurrency', ip: '127.0.0.1', ua: 'jest' };
describe('C1 D2a real transaction races', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let definitions: ActivityMetricDefinitionService;
  let sets: ActivityMetricSetService;
  let user: CurrentUserPayload;
  let n = 0;
  const key = () => 'race_' + ++n;
  const document = () => ({
    schemaVersion: 1,
    code: key(),
    version: 1,
    name: '指标',
    configuration: { kindCode: 'boolean', unit: null },
  });
  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    definitions = app.get(ActivityMetricDefinitionService);
    sets = app.get(ActivityMetricSetService);
    await resetDb(app);
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    await assertConnectedTestDatabase(prisma);
    await prisma.$executeRaw`TRUNCATE "ActivityMetricCommandReceipt","ActivityMetricSetItem","ActivityMetricSetVersion","ActivityMetricDefinition"`;
    user = await createTestUser(app, { username: 'metric_race_root', role: Role.SUPER_ADMIN });
  });
  afterAll(async () => {
    if (app) await app.close();
  });

  it('same key concurrent create produces exactly one resource, receipt and audit', async () => {
    const input = { operationKey: key(), definition: document() };
    const results = await Promise.all(
      Array.from({ length: 4 }, () => definitions.execute('create', null, input, user, meta)),
    );
    expect(results).toEqual(Array(4).fill(results[0]));
    expect(
      await prisma.activityMetricDefinition.count({ where: { code: input.definition.code } }),
    ).toBe(1);
    expect(
      await prisma.activityMetricCommandReceipt.count({ where: { definitionId: results[0].id } }),
    ).toBe(1);
    expect(await prisma.auditLog.count({ where: { resourceId: results[0].id } })).toBe(1);
  });

  it('same identity different keys is a version conflict, not replay', async () => {
    const definition = document();
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        definitions.execute('create', null, { operationKey: key(), definition }, user, meta),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((r) => r.status === 'rejected');
    expect(failure).toMatchObject({
      status: 'rejected',
      reason: { biz: { code: 20168, httpStatus: 409 } },
    });
  });

  it.each(['disabled', 'deleted', 'demoted'] as const)(
    'identity %s while waiting on the command lock denies an existing receipt replay',
    async (change) => {
      const actor = await createTestUser(app, { username: key(), role: Role.SUPER_ADMIN });
      const input = { operationKey: key(), definition: document() };
      const row = await definitions.execute('create', null, input, actor, meta);
      const lockKey = JSON.stringify([
        'activity-metric',
        actor.id,
        'create_definition',
        input.operationKey,
      ]);
      let unlock!: () => void;
      let locked!: () => void;
      const ready = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const release = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const blocker = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text`;
          locked();
          await release;
        },
        { timeout: 10000 },
      );
      await ready;
      const pending = Promise.allSettled([definitions.execute('create', null, input, actor, meta)]);
      try {
        await waitFor(
          async () => {
            const [result] = await prisma.$queryRaw<
              { count: bigint }[]
            >`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%pg_advisory_xact_lock%'`;
            return result.count >= 1n;
          },
          { timeoutMs: 2500 },
        );
        await prisma.user.update({
          where: { id: actor.id },
          data:
            change === 'disabled'
              ? { status: UserStatus.DISABLED }
              : change === 'deleted'
                ? { deletedAt: new Date() }
                : { role: Role.USER },
        });
      } finally {
        unlock();
        await blocker;
      }
      expect(await pending).toMatchObject([
        {
          status: 'rejected',
          reason: {
            biz:
              change === 'demoted'
                ? { code: 30100, httpStatus: 403 }
                : { code: 40100, httpStatus: 401 },
          },
        },
      ]);
      expect(
        await prisma.activityMetricCommandReceipt.count({ where: { definitionId: row.id } }),
      ).toBe(1);
      expect(await prisma.auditLog.count({ where: { resourceId: row.id } })).toBe(1);
      expect(
        await prisma.activityMetricDefinition.findUnique({ where: { id: row.id } }),
      ).toMatchObject({
        statusCode: 'draft',
        definitionHash: row.definitionHash,
      });
    },
  );

  it('different keys on one draft serialize and stale second edit cannot overwrite first', async () => {
    const definition = document();
    const row = await definitions.execute(
      'create',
      null,
      { operationKey: key(), definition },
      user,
      meta,
    );
    let unlock!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const blocker = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "ActivityMetricDefinition" WHERE "id" = ${row.id} FOR UPDATE`;
        locked();
        await release;
      },
      { timeout: 10000 },
    );
    await ready;
    const pending = Promise.allSettled(
      ['first', 'second'].map((name) =>
        definitions.execute(
          'update',
          row.id,
          {
            operationKey: key(),
            expectedDefinitionHash: row.definitionHash,
            definition: { ...definition, name },
          },
          user,
          meta,
        ),
      ),
    );
    try {
      await waitFor(
        async () => {
          const [result] = await prisma.$queryRaw<
            { count: bigint }[]
          >`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%ActivityMetricDefinition%'`;
          return result.count >= 2n;
        },
        { timeoutMs: 2500 },
      );
    } finally {
      unlock();
      await blocker;
    }
    const results = await pending;
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { biz: { code: 20170, httpStatus: 409 } },
    });
    expect(await prisma.auditLog.count({ where: { resourceId: row.id } })).toBe(2);
  });

  it('permission revoked while waiting on a resource lock is rechecked before write', async () => {
    const editor = await createTestUser(app, { username: 'metric_race_editor' });
    const permission = await prisma.permission.create({
      data: {
        code: 'activity-metric.manage.definition',
        module: 'activity-metric',
        action: 'manage',
        resourceType: 'definition',
        description: 'test',
      },
    });
    const role = await prisma.rbacRole.create({
      data: { code: 'metric-race-editor', displayName: 'test' },
    });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    const binding = await prisma.roleBinding.create({
      data: { principalType: 'USER', principalId: editor.id, roleId: role.id, scopeType: 'GLOBAL' },
    });
    const definition = document();
    const row = await definitions.execute(
      'create',
      null,
      { operationKey: key(), definition },
      editor,
      meta,
    );
    let unlock!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const blocker = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "ActivityMetricDefinition" WHERE "id" = ${row.id} FOR UPDATE`;
        locked();
        await release;
      },
      { timeout: 10000 },
    );
    await ready;
    const pending = Promise.allSettled([
      definitions.execute(
        'activate',
        row.id,
        { operationKey: key(), expectedDefinitionHash: row.definitionHash },
        editor,
        meta,
      ),
    ]);
    try {
      await waitFor(
        async () => {
          const [result] = await prisma.$queryRaw<
            { count: bigint }[]
          >`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%ActivityMetricDefinition%'`;
          return result.count >= 1n;
        },
        { timeoutMs: 2500 },
      );
      await prisma.roleBinding.update({
        where: { id: binding.id },
        data: { deletedAt: new Date() },
      });
    } finally {
      unlock();
      await blocker;
    }
    expect(await pending).toMatchObject([
      { status: 'rejected', reason: { biz: { code: 30100, httpStatus: 403 } } },
    ]);
    expect(
      await prisma.activityMetricDefinition.findUnique({
        where: { id: row.id },
        select: { statusCode: true },
      }),
    ).toEqual({ statusCode: 'draft' });
  });

  it('reference retirement and set activation serialize without resurrecting definitions', async () => {
    const metric = await definitions.execute(
      'create',
      null,
      { operationKey: key(), definition: document() },
      user,
      meta,
    );
    await definitions.execute(
      'activate',
      metric.id,
      { operationKey: key(), expectedDefinitionHash: metric.definitionHash },
      user,
      meta,
    );
    const set = await sets.execute(
      'create',
      null,
      {
        operationKey: key(),
        definition: {
          schemaVersion: 1,
          code: key(),
          version: 1,
          name: '集',
          items: [
            {
              key: 'one',
              sortOrder: 0,
              required: true,
              metricDefinitionId: metric.id,
              definitionHash: metric.definitionHash,
            },
          ],
        },
      },
      user,
      meta,
    );
    const results = await Promise.allSettled([
      definitions.execute(
        'retire',
        metric.id,
        { operationKey: key(), expectedDefinitionHash: metric.definitionHash },
        user,
        meta,
      ),
      sets.execute(
        'activate',
        set.id,
        { operationKey: key(), expectedDefinitionHash: set.definitionHash },
        user,
        meta,
      ),
    ]);
    expect(results[0].status).toBe('fulfilled');
    if (results[1].status === 'rejected')
      expect(results[1].reason).toMatchObject({ biz: { code: 20172, httpStatus: 409 } });
    expect(
      await prisma.activityMetricDefinition.findUnique({
        where: { id: metric.id },
        select: { statusCode: true },
      }),
    ).toEqual({ statusCode: 'retired' });
  });
});
