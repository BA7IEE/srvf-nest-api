import type { INestApplication } from '@nestjs/common';
import { Prisma, Role, UserStatus, MemberStatus, OrganizationStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode, type BizCodeEntry } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityMetricSelectionService } from '../../src/modules/activities/activity-metric-selection.service';
import { ActivityMetricDefinitionService } from '../../src/modules/activities/activity-metric-definition.service';
import { ActivityMetricSetService } from '../../src/modules/activities/activity-metric-set.service';
import { createTestUser } from '../fixtures/users.fixture';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { waitFor } from '../helpers/wait-for';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertConnectedTestDatabase } from '../setup/test-db';

const selection = { metricRequirementCode: 'not_required', metricSetPointer: null } as const;
const meta = { requestId: 'd2b-selection-race', ip: null, ua: null };

describe('C1 D2b real lock-wait selection races with independent pools', () => {
  let app: INestApplication;
  let peer: INestApplication;
  let prisma: PrismaService;
  let writer: ActivityMetricSelectionService;
  let otherWriter: ActivityMetricSelectionService;
  let administrator: CurrentUserPayload;
  let rootId: string;
  let n = 0;
  const key = () => `d2b_race_${++n}`;
  const command = () => ({ operationKey: key(), expectedRevision: 0, metricSelection: selection });

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);
    await assertConnectedTestDatabase(prisma);
    await prisma.$executeRaw`TRUNCATE "ActivityMetricCommandReceipt", "ActivityMetricSetItem", "ActivityMetricSetVersion", "ActivityMetricDefinition" CASCADE`;
    peer = await createTestApp();
    writer = app.get(ActivityMetricSelectionService);
    otherWriter = peer.get(ActivityMetricSelectionService);
    administrator = await createTestUser(app, { username: key(), role: Role.SUPER_ADMIN });
    rootId = (await prisma.organization.create({ data: { name: key(), nodeTypeCode: 'root' } })).id;
  });
  afterAll(async () => {
    await peer?.close();
    await app?.close();
  });

  async function fixture(role: Role = Role.SUPER_ADMIN) {
    const organization = await prisma.organization.create({
      data: { name: key(), nodeTypeCode: 'team', parentId: rootId },
    });
    await prisma.organizationClosure.createMany({
      data: [
        { ancestorId: organization.id, descendantId: organization.id, depth: 0 },
        { ancestorId: rootId, descendantId: organization.id, depth: 1 },
      ],
    });
    const member = await prisma.member.create({
      data: { memberNo: key(), ...memberIdentityData('并发测试'), gradeCode: 'level-3' },
    });
    const user = await createTestUser(app, { username: key(), role });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    const actor = {
      id: user.id,
      username: user.username,
      role,
      status: UserStatus.ACTIVE,
      memberId: member.id,
    };
    const activity = await prisma.activity.create({
      data: {
        title: key(),
        activityTypeCode: 'training',
        allocationModeCode: 'first_come',
        organizationId: organization.id,
        initiatorMemberId: member.id,
        startAt: new Date('2099-09-01'),
        endAt: new Date('2099-09-02'),
        location: '测试',
        statusCode: 'draft',
      },
    });
    return { actor, member, organization, activity };
  }
  async function permission(userId: string, organizationId: string) {
    const code = await prisma.permission.upsert({
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
      data: { code: key(), displayName: '并发测试角色' },
    });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: code.id } });
    const binding = await prisma.roleBinding.create({
      data: {
        principalType: 'USER',
        principalId: userId,
        roleId: role.id,
        scopeType: 'ORGANIZATION',
        scopeOrgId: organizationId,
      },
    });
    return { role, binding };
  }
  async function barrier(
    lock: Prisma.Sql,
    beforeCommit?: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) {
    let notify!: (pid: number) => void;
    let unlock!: () => void;
    const ready = new Promise<number>((resolve) => {
      notify = resolve;
    });
    const released = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const held = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw(lock);
        const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        notify(backend.pid);
        await released;
        if (beforeCommit) await beforeCommit(tx);
      },
      { timeout: 10000 },
    );
    const pid = await Promise.race([
      ready,
      held.then(() => {
        throw new Error('lock holder ended before readiness');
      }),
    ]);
    return {
      pid,
      release: async () => {
        unlock();
        await held;
      },
    };
  }
  async function waiting(pid: number, count = 1) {
    await waitFor(
      async () => {
        const [row] = await prisma.$queryRaw<{ count: bigint }[]>`
        WITH RECURSIVE waiters AS (
          SELECT a.pid, pg_blocking_pids(a.pid) AS blockers FROM pg_stat_activity AS a
          WHERE a.datname = current_database() AND a.wait_event_type = 'Lock'
        ), blocked_chain AS (
          SELECT pid FROM waiters WHERE ${pid} = ANY(blockers)
          UNION
          SELECT w.pid FROM waiters w JOIN blocked_chain b ON b.pid = ANY(w.blockers)
        ) SELECT count(*) FROM blocked_chain`;
        return row.count >= BigInt(count);
      },
      { timeoutMs: 2500, message: 'the intended database lock holder has no matching waiters' },
    );
  }
  async function state(activityId: string, revision: number, count: number) {
    expect(
      await prisma.activity.findUniqueOrThrow({
        where: { id: activityId },
        select: { metricSelectionRevision: true, metricRequirementCode: true },
      }),
    ).toEqual({
      metricSelectionRevision: revision,
      metricRequirementCode: revision ? 'not_required' : null,
    });
    expect(await prisma.activityMetricCommandReceipt.count({ where: { activityId } })).toBe(count);
    expect(
      await prisma.auditLog.count({
        where: { resourceId: activityId, event: 'activity.metric-selection.command' },
      }),
    ).toBe(count);
  }
  function denied(result: PromiseSettledResult<unknown>[], biz: BizCodeEntry) {
    expect(result).toMatchObject([
      { status: 'rejected', reason: { biz: { code: biz.code, httpStatus: biz.httpStatus } } },
    ]);
  }
  async function catalogue() {
    const definitions = app.get(ActivityMetricDefinitionService);
    const sets = app.get(ActivityMetricSetService);
    const definition = await definitions.execute(
      'create',
      null,
      {
        operationKey: key(),
        definition: {
          schemaVersion: 1,
          code: key(),
          version: 1,
          name: '完成',
          configuration: { kindCode: 'boolean', unit: null },
        },
      },
      administrator,
      meta,
    );
    await definitions.execute(
      'activate',
      definition.id,
      { operationKey: key(), expectedDefinitionHash: definition.definitionHash },
      administrator,
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
      },
      administrator,
      meta,
    );
    await sets.execute(
      'activate',
      set.id,
      { operationKey: key(), expectedDefinitionHash: set.definitionHash },
      administrator,
      meta,
    );
    return {
      definition,
      set,
      selection: {
        metricRequirementCode: 'required',
        metricSetPointer: {
          id: set.id,
          code: set.code,
          version: set.version,
          schemaVersion: set.schemaVersion,
          definitionHash: set.definitionHash,
        },
      } as const,
    };
  }

  it('same command across two pools produces one revision, receipt and audit', async () => {
    const { actor, activity } = await fixture();
    const input = command();
    const results = await Promise.all(
      [writer, otherWriter, writer, otherWriter].map((service) =>
        service.select(activity.id, input, actor, 'app', meta),
      ),
    );
    expect(results).toEqual(Array(4).fill(results[0]));
    await state(activity.id, 1, 1);
  });
  it('two new commands for revision zero serialize; exactly one loses as stale', async () => {
    const { actor, activity } = await fixture();
    const lock = await barrier(
      Prisma.sql`SELECT id FROM "Activity" WHERE id = ${activity.id} FOR UPDATE`,
    );
    const pending = Promise.allSettled(
      [writer, otherWriter].map((service) =>
        service.select(activity.id, command(), actor, 'app', meta),
      ),
    );
    try {
      await waiting(lock.pid, 2);
    } finally {
      await lock.release();
    }
    const result = await pending;
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    denied(
      result.filter((r) => r.status === 'rejected'),
      BizCode.ACTIVITY_METRIC_SELECTION_STALE,
    );
    await state(activity.id, 1, 1);
  });
  it.each(['disabled', 'deleted', 'demoted', 'member-disabled'] as const)(
    'advisory wait rechecks %s even on receipt replay',
    async (change) => {
      const { actor, activity, member } = await fixture();
      const input = command();
      await writer.select(activity.id, input, actor, 'app', meta);
      const lockKey = JSON.stringify([
        'activity-metric',
        actor.id,
        'select_metric_set',
        input.operationKey,
      ]);
      const lock = await barrier(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text`,
      );
      const pending = Promise.allSettled([
        otherWriter.select(activity.id, input, actor, 'app', meta),
      ]);
      try {
        await waiting(lock.pid);
        if (change === 'member-disabled')
          await prisma.member.update({
            where: { id: member.id },
            data: { status: MemberStatus.INACTIVE },
          });
        else
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
        await lock.release();
      }
      denied(
        await pending,
        change === 'member-disabled'
          ? BizCode.FORBIDDEN
          : change === 'demoted'
            ? BizCode.RBAC_FORBIDDEN
            : BizCode.UNAUTHORIZED,
      );
      await state(activity.id, 1, 1);
    },
  );
  it.each(['grant', 'role', 'organization', 'member', 'initiator'] as const)(
    'Activity lock wait rechecks current %s instead of lock-before snapshots',
    async (change) => {
      const { actor, activity, organization, member } = await fixture(Role.USER);
      const { binding, role } = await permission(actor.id, organization.id);
      const lock = await barrier(
        Prisma.sql`SELECT id FROM "Activity" WHERE id = ${activity.id} FOR UPDATE`,
        change === 'initiator'
          ? (tx) =>
              tx.activity.update({ where: { id: activity.id }, data: { initiatorMemberId: null } })
          : undefined,
      );
      const pending = Promise.allSettled([
        otherWriter.select(activity.id, command(), actor, 'app', meta),
      ]);
      try {
        await waiting(lock.pid);
        if (change === 'grant')
          await prisma.roleBinding.update({
            where: { id: binding.id },
            data: { deletedAt: new Date() },
          });
        if (change === 'role')
          await prisma.rbacRole.update({ where: { id: role.id }, data: { deletedAt: new Date() } });
        if (change === 'organization')
          await prisma.organization.update({
            where: { id: organization.id },
            data: { status: OrganizationStatus.INACTIVE },
          });
        if (change === 'member')
          await prisma.member.update({
            where: { id: member.id },
            data: { status: MemberStatus.INACTIVE },
          });
      } finally {
        await lock.release();
      }
      denied(
        await pending,
        change === 'member'
          ? BizCode.FORBIDDEN
          : change === 'initiator'
            ? BizCode.ACTIVITY_NOT_FOUND
            : BizCode.RBAC_FORBIDDEN,
      );
      await state(activity.id, 0, 0);
    },
  );
  it.each(['set', 'definition'] as const)(
    '%s retirement committed during reference-lock wait prevents a new selection',
    async (target) => {
      const { actor, activity } = await fixture();
      const metrics = await catalogue();
      const lock =
        target === 'set'
          ? await barrier(
              Prisma.sql`SELECT id FROM "ActivityMetricSetVersion" WHERE id = ${metrics.set.id} FOR UPDATE`,
              (tx) =>
                tx.activityMetricSetVersion.update({
                  where: { id: metrics.set.id },
                  data: { statusCode: 'retired', retiredAt: new Date() },
                }),
            )
          : await barrier(
              Prisma.sql`SELECT id FROM "ActivityMetricDefinition" WHERE id = ${metrics.definition.id} FOR UPDATE`,
              (tx) =>
                tx.activityMetricDefinition.update({
                  where: { id: metrics.definition.id },
                  data: { statusCode: 'retired', retiredAt: new Date() },
                }),
            );
      const pending = Promise.allSettled([
        otherWriter.select(
          activity.id,
          { ...command(), metricSelection: metrics.selection },
          actor,
          'app',
          meta,
        ),
      ]);
      try {
        await waiting(lock.pid);
      } finally {
        await lock.release();
      }
      denied(await pending, BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE);
      await state(activity.id, 0, 0);
    },
  );
  it.each(['set', 'definition'] as const)(
    'identity revocation during %s wait is checked after that exact lock',
    async (target) => {
      const { actor, activity } = await fixture();
      const metrics = await catalogue();
      const lock = await barrier(
        target === 'set'
          ? Prisma.sql`SELECT id FROM "ActivityMetricSetVersion" WHERE id = ${metrics.set.id} FOR UPDATE`
          : Prisma.sql`SELECT id FROM "ActivityMetricDefinition" WHERE id = ${metrics.definition.id} FOR UPDATE`,
      );
      const pending = Promise.allSettled([
        otherWriter.select(
          activity.id,
          { ...command(), metricSelection: metrics.selection },
          actor,
          'app',
          meta,
        ),
      ]);
      try {
        await waiting(lock.pid);
        await prisma.user.update({
          where: { id: actor.id },
          data: { status: UserStatus.DISABLED },
        });
      } finally {
        await lock.release();
      }
      denied(await pending, BizCode.UNAUTHORIZED);
      await state(activity.id, 0, 0);
    },
  );
});
