import type { INestApplication } from '@nestjs/common';
import { Prisma, Role, UserStatus, MemberStatus, OrganizationStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityOutcomeService } from '../../src/modules/activities/activity-outcome.service';
import { ActivityOutcomeAuditRecorder } from '../../src/modules/activities/activity-outcome-audit-recorder';
import { AttachmentStorageOrchestrator } from '../../src/modules/attachments/attachment-storage-orchestrator';
import { ActivityMetricDefinitionService } from '../../src/modules/activities/activity-metric-definition.service';
import { ActivityMetricSetService } from '../../src/modules/activities/activity-metric-set.service';
import { createTestUser } from '../fixtures/users.fixture';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { waitFor } from '../helpers/wait-for';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertConnectedTestDatabase } from '../setup/test-db';

const meta = { requestId: 'c2-outcome-race', ip: null, ua: null };
describe('C2 D2 outcome real lock waits across independent pools', () => {
  let app: INestApplication;
  let peer: INestApplication;
  let prisma: PrismaService;
  let writer: ActivityOutcomeService;
  let otherWriter: ActivityOutcomeService;
  let admin: CurrentUserPayload;
  let rootId: string;
  let definitionId: string;
  let setId: string;
  let setHash: string;
  let sequence = 0;
  const key = () => `c2_race_${++sequence}`;
  const command = () => ({
    operationKey: key(),
    expectedRevision: 0,
    metricSetVersionId: setId,
    metricSetDefinitionHash: setHash,
    values: [
      { metricDefinitionId: definitionId, value: true, evidenceAttachmentIds: [] as string[] },
    ],
  });
  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await assertConnectedTestDatabase(prisma);
    await resetDb(app);
    peer = await createTestApp();
    writer = app.get(ActivityOutcomeService);
    otherWriter = peer.get(ActivityOutcomeService);
    admin = await createTestUser(app, { username: key(), role: Role.SUPER_ADMIN });
    rootId = (await prisma.organization.create({ data: { name: key(), nodeTypeCode: 'root' } })).id;
    const definitions = app.get(ActivityMetricDefinitionService);
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
      admin,
      meta,
    );
    definitionId = definition.id;
    await definitions.execute(
      'activate',
      definitionId,
      { operationKey: key(), expectedDefinitionHash: definition.definitionHash },
      admin,
      meta,
    );
    const sets = app.get(ActivityMetricSetService);
    const set = await sets.execute(
      'create',
      null,
      {
        operationKey: key(),
        definition: {
          schemaVersion: 1,
          code: key(),
          version: 1,
          name: '成果',
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
      },
      admin,
      meta,
    );
    setId = set.id;
    setHash = set.definitionHash;
    await sets.execute(
      'activate',
      setId,
      { operationKey: key(), expectedDefinitionHash: setHash },
      admin,
      meta,
    );
  });
  afterAll(async () => {
    await peer?.close();
    await app?.close();
  });

  async function fixture() {
    const organization = await prisma.organization.create({
      data: { name: key(), nodeTypeCode: 'team', parentId: rootId },
    });
    const member = await prisma.member.create({
      data: { memberNo: key(), ...memberIdentityData('成果竞争'), gradeCode: 'level-3' },
    });
    const user = await createTestUser(app, { username: key(), role: Role.USER });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    const actor: CurrentUserPayload = { ...user, memberId: member.id };
    const permission = await prisma.permission.upsert({
      where: { code: 'activity.outcome.record' },
      update: {},
      create: {
        code: 'activity.outcome.record',
        module: 'activity',
        action: 'outcome',
        resourceType: 'record',
        description: 'test',
      },
    });
    const role = await prisma.rbacRole.create({
      data: { code: key(), displayName: '成果竞争授权' },
    });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    const binding = await prisma.roleBinding.create({
      data: { principalType: 'USER', principalId: user.id, roleId: role.id, scopeType: 'GLOBAL' },
    });
    const activity = await prisma.activity.create({
      data: {
        title: key(),
        activityTypeCode: 'training',
        allocationModeCode: 'first_come',
        organizationId: organization.id,
        initiatorMemberId: member.id,
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
    return { actor, activity, binding, organization, member };
  }
  async function attachmentFixture(activityId: string, actor: CurrentUserPayload) {
    const attachment = await prisma.attachment.create({
      data: {
        key: `attachments/c2-race/${key()}.txt`,
        originalName: 'evidence.txt',
        mime: 'text/plain',
        size: 7,
        uploadedBy: actor.id,
        ownerType: 'activity',
        ownerId: activityId,
      },
    });
    const object = await prisma.storageObject.create({
      data: {
        key: attachment.key,
        state: 'available',
        source: 'attachment_signed_upload',
        providerType: 'LOCAL',
        localNamespace: 'c2-outcome-race-test',
        expectedSize: 7n,
        actualSize: 7n,
        expectedMime: 'text/plain',
        resourceType: 'attachment',
        resourceId: attachment.id,
        verifiedAt: new Date(),
        presentAt: new Date(),
        lastProviderCheckedAt: new Date(),
      },
    });
    const deletion = {
      attachmentId: attachment.id,
      actorUserId: actor.id,
      actorRoleSnap: actor.role,
      allowAuthorizedJoin: false,
      scope: 'self' as const,
      deletedByPath: 'owner' as const,
      auditMeta: meta,
    };
    return { attachment, object, deletion };
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
          UNION SELECT w.pid FROM waiters w JOIN blocked_chain b ON b.pid = ANY(w.blockers)
        ) SELECT count(*) FROM blocked_chain`;
        return row.count >= BigInt(count);
      },
      { timeoutMs: 2500, message: 'outcome writer did not reach the intended database lock' },
    );
  }
  async function state(activityId: string, count: number) {
    expect(await prisma.activityOutcomeRevision.count({ where: { activityId } })).toBe(count);
    expect(await prisma.activityMetricValueRevision.count({ where: { activityId } })).toBe(count);
    expect(await prisma.activityOutcomeCommandReceipt.count({ where: { activityId } })).toBe(count);
    expect(
      await prisma.auditLog.count({
        where: { event: 'activity.outcome.command', resourceId: activityId },
      }),
    ).toBe(count);
  }
  it('rejects an outcome when delete intent commits while its attachment lock is waiting', async () => {
    const { actor, activity } = await fixture();
    const { attachment, object, deletion } = await attachmentFixture(activity.id, actor);
    const storage = app.get(AttachmentStorageOrchestrator);
    const lock = await barrier(
      Prisma.sql`SELECT id FROM "attachments" WHERE id = ${attachment.id} FOR UPDATE`,
      (tx) => storage.prepareDeleteInTransaction(tx, deletion),
    );
    const input = command();
    input.values[0].evidenceAttachmentIds.push(attachment.id);
    const pending = Promise.allSettled([otherWriter.record(activity.id, input, actor, meta)]);
    try {
      await waiting(lock.pid);
    } finally {
      await lock.release();
    }
    expect(await pending).toMatchObject([
      { status: 'rejected', reason: { biz: BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING } },
    ]);
    await state(activity.id, 0);
    expect(
      await prisma.activityMetricValueEvidence.count({ where: { attachmentId: attachment.id } }),
    ).toBe(0);
    expect(
      await prisma.storageObjectOperation.count({
        where: { storageObjectId: object.id, kind: 'attachment_delete' },
      }),
    ).toBe(1);
    expect(await prisma.attachment.findUnique({ where: { id: attachment.id } })).not.toBeNull();
  });

  it('blocks delete intent until a winning outcome commits, then protects its evidence', async () => {
    const { actor, activity } = await fixture();
    const { attachment, object, deletion } = await attachmentFixture(activity.id, actor);
    const audit = app.get(ActivityOutcomeAuditRecorder);
    const original = audit.log.bind(audit);
    let notify!: (pid: number) => void;
    let release!: () => void;
    const ready = new Promise<number>((resolve) => {
      notify = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = jest.spyOn(audit, 'log').mockImplementationOnce(async (...args) => {
      const [backend] = await args[0].$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      notify(backend.pid);
      await released;
      await original(...args);
    });
    const input = command();
    input.values[0].evidenceAttachmentIds.push(attachment.id);
    const outcome = writer.record(activity.id, input, actor, meta);
    let pending: Promise<PromiseSettledResult<string>[]> | undefined;
    try {
      const pid = await Promise.race([
        ready,
        outcome.then(() => {
          throw new Error('outcome ended before evidence barrier');
        }),
      ]);
      pending = Promise.allSettled([
        peer.get(AttachmentStorageOrchestrator).prepareDelete(deletion),
      ]);
      await waiting(pid);
    } finally {
      release();
      spy.mockRestore();
    }
    await outcome;
    expect(await pending).toMatchObject([
      { status: 'rejected', reason: { biz: BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING } },
    ]);
    await state(activity.id, 1);
    expect(
      await prisma.activityMetricValueEvidence.count({ where: { attachmentId: attachment.id } }),
    ).toBe(1);
    expect(
      await prisma.storageObjectOperation.count({ where: { storageObjectId: object.id } }),
    ).toBe(0);
    expect(
      await prisma.storageObject.findUnique({
        where: { id: object.id },
        select: { state: true, deleteRequestedAt: true },
      }),
    ).toEqual({ state: 'available', deleteRequestedAt: null });
  });

  it('same key across pools commits exactly one outcome and replays identically', async () => {
    const { actor, activity } = await fixture();
    const input = command();
    const lock = await barrier(
      Prisma.sql`SELECT id FROM "Activity" WHERE id = ${activity.id} FOR UPDATE`,
    );
    const pending = Promise.all(
      [writer, otherWriter].map((service) => service.record(activity.id, input, actor, meta)),
    );
    try {
      await waiting(lock.pid, 2);
    } finally {
      await lock.release();
    }
    const result = await pending;
    expect(result[1]).toEqual(result[0]);
    await state(activity.id, 1);
  });
  it('different keys at the same revision allow exactly one winner', async () => {
    const { actor, activity } = await fixture();
    const lock = await barrier(
      Prisma.sql`SELECT id FROM "Activity" WHERE id = ${activity.id} FOR UPDATE`,
    );
    const pending = Promise.allSettled(
      [writer, otherWriter].map((service) => service.record(activity.id, command(), actor, meta)),
    );
    try {
      await waiting(lock.pid, 2);
    } finally {
      await lock.release();
    }
    const result = await pending;
    expect(result.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(result.filter((item) => item.status === 'rejected')).toMatchObject([
      { status: 'rejected', reason: { biz: BizCode.ACTIVITY_OUTCOME_STALE } },
    ]);
    await state(activity.id, 1);
  });
  it('rechecks current owner after waiting on the Activity lock', async () => {
    const { actor, activity } = await fixture();
    await prisma.activity.update({ where: { id: activity.id }, data: { statusCode: 'published' } });
    const owner = await prisma.activityResponsibilityAssignment.create({
      data: {
        activityId: activity.id,
        memberId: actor.memberId!,
        responsibilityType: 'owner',
        canManageRegistrations: true,
        canManageAttendance: true,
        status: 'active',
        assignedByUserId: actor.id,
        source: 'publish',
      },
    });
    const lock = await barrier(
      Prisma.sql`SELECT id FROM "Activity" WHERE id = ${activity.id} FOR UPDATE`,
    );
    const pending = Promise.allSettled([otherWriter.record(activity.id, command(), actor, meta)]);
    try {
      await waiting(lock.pid);
      await prisma.activityResponsibilityAssignment.update({
        where: { id: owner.id },
        data: { status: 'ended', endedAt: new Date() },
      });
    } finally {
      await lock.release();
    }
    expect(await pending).toMatchObject([
      { status: 'rejected', reason: { biz: BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE } },
    ]);
    await state(activity.id, 0);
  });

  it.each(['selection', 'cancelled'] as const)(
    'uses lock-after %s state for a new write',
    async (change) => {
      const { actor, activity } = await fixture();
      const lock = await barrier(
        Prisma.sql`SELECT id FROM "Activity" WHERE id = ${activity.id} FOR UPDATE`,
        (tx) =>
          tx.activity.update({
            where: { id: activity.id },
            data:
              change === 'cancelled'
                ? { statusCode: 'cancelled' }
                : {
                    metricRequirementCode: 'not_required',
                    selectedMetricSetVersionId: null,
                    selectedMetricSetDefinitionHash: null,
                    metricSelectionRevision: 2,
                  },
          }),
      );
      const pending = Promise.allSettled([otherWriter.record(activity.id, command(), actor, meta)]);
      try {
        await waiting(lock.pid);
      } finally {
        await lock.release();
      }
      // Cancelled activities still require the post-draft current owner for access.
      expect(await pending).toMatchObject([
        {
          status: 'rejected',
          reason: {
            biz:
              change === 'selection'
                ? BizCode.ACTIVITY_OUTCOME_STALE
                : BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE,
          },
        },
      ]);
      await state(activity.id, 0);
    },
  );

  it.each(['grant', 'user', 'member', 'organization'] as const)(
    'rejects replay after %s revocation during advisory wait',
    async (change) => {
      const { actor, activity, binding, member, organization } = await fixture();
      const input = command();
      await writer.record(activity.id, input, actor, meta);
      const lockKey = JSON.stringify([
        'activity-outcome',
        actor.id,
        'record_manual_outcome',
        input.operationKey,
      ]);
      const lock = await barrier(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text`,
      );
      const pending = Promise.allSettled([otherWriter.record(activity.id, input, actor, meta)]);
      try {
        await waiting(lock.pid);
        if (change === 'grant')
          await prisma.roleBinding.update({
            where: { id: binding.id },
            data: { deletedAt: new Date() },
          });
        if (change === 'user')
          await prisma.user.update({
            where: { id: actor.id },
            data: { status: UserStatus.DISABLED },
          });
        if (change === 'member')
          await prisma.member.update({
            where: { id: member.id },
            data: { status: MemberStatus.INACTIVE },
          });
        if (change === 'organization')
          await prisma.organization.update({
            where: { id: organization.id },
            data: { status: OrganizationStatus.INACTIVE },
          });
      } finally {
        await lock.release();
      }
      const expected =
        change === 'user'
          ? BizCode.UNAUTHORIZED
          : change === 'member'
            ? BizCode.FORBIDDEN
            : BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE;
      expect(await pending).toMatchObject([{ status: 'rejected', reason: { biz: expected } }]);
      await state(activity.id, 1);
    },
  );
});
