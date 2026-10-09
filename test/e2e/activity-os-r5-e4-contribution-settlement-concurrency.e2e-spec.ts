import type { INestApplication } from '@nestjs/common';
import { MemberStatus, PrincipalType, PrismaClient } from '@prisma/client';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityTimeSettlementAuditRecorder } from '../../src/modules/activities/activity-time-settlement-audit-recorder';
import {
  TIME_SETTLEMENT_PREPARE_OPERATION,
  type TimeSettlementReceiptResult,
} from '../../src/modules/activities/activity-time-settlement-command';
import { ActivityTimeSettlementService } from '../../src/modules/activities/activity-time-settlement.service';
import {
  E4_META,
  closeE13Fixture,
  createE4Fixture,
  createE4Source,
  e4Actor,
  installE4ValidationDatabase,
  type E4Fixture,
} from '../helpers/activity-contribution-policy.fixture';
import { assertConnectedTestDatabase } from '../setup/test-db';
import { createTestApp } from '../setup/test-app';

type Source = Awaited<ReturnType<typeof createE4Source>>;
type PrepareCommand = ReturnType<typeof prepareCommand>;
type PrepareResult = PromiseSettledResult<TimeSettlementReceiptResult>;

function prepareCommand(f: E4Fixture, source: Source) {
  return {
    expectedDraftVersion: source.expectation.expectedDraftVersion,
    expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,
    operationKey: f.key('concurrent_prepare'),
    expectedTimeRevision: 0,
  };
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected the stored audit metadata object');
  return value as Record<string, unknown>;
}

installE4ValidationDatabase();
describe('E4 contribution concurrency: actual PostgreSQL barriers and atomic proof receipts', () => {
  let current: E4Fixture | undefined;
  let secondApp: INestApplication | undefined;
  let lockDb: PrismaClient | undefined;
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;

  function fixture(): E4Fixture {
    if (!current) throw new Error('E4 concurrency fixture is not initialized');
    return current;
  }

  function secondService(): ActivityTimeSettlementService {
    if (!secondApp) throw new Error('The second actual application is not initialized');
    return secondApp.get(ActivityTimeSettlementService);
  }

  beforeEach(async () => {
    current = undefined;
    secondApp = undefined;
    lockDb = undefined;
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    current = await createE4Fixture();
    // A separate real application/pool; do not reset its shared worker database again.
    secondApp = await createTestApp();
    lockDb = new PrismaClient();
    await lockDb.$connect();
    await Promise.all([
      assertConnectedTestDatabase(current.db),
      assertConnectedTestDatabase(secondApp.get(PrismaService)),
      assertConnectedTestDatabase(lockDb),
    ]);
  }, 120_000);
  afterEach(async () => {
    jest.restoreAllMocks();
    const cleanup = await Promise.allSettled([
      lockDb?.$disconnect(),
      secondApp?.close(),
      closeE13Fixture(current),
    ]);
    current = undefined;
    secondApp = undefined;
    lockDb = undefined;
    if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
    const failures = cleanup.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    );
    if (failures.length) throw new AggregateError(failures, 'E4 concurrency cleanup failed');
  });

  async function holdCommandLock(f: E4Fixture, command: PrepareCommand) {
    if (!lockDb) throw new Error('The independent lock connection is not initialized');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markAcquired: (pid: number) => void = () => undefined;
    let rejectAcquired: (error: unknown) => void = () => undefined;
    const acquired = new Promise<number>((resolve, reject) => {
      markAcquired = resolve;
      rejectAcquired = reject;
    });
    const lockKey = JSON.stringify([
      'activity-time-settlement',
      f.creator.id,
      TIME_SETTLEMENT_PREPARE_OPERATION,
      command.operationKey,
    ]);
    const done = lockDb.$transaction(
      async (tx) => {
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text`;
        markAcquired(pid);
        await gate;
      },
      // Fixture lock only. The actual prepare still uses its unchanged 30-second budget.
      { timeout: 20_000 },
    );
    void done.catch(rejectAcquired);
    try {
      return { pid: await acquired, release, done };
    } catch (error) {
      release();
      await Promise.allSettled([done]);
      throw error;
    }
  }

  async function waitForBlockedCommands(f: E4Fixture, holderPid: number, expected: number) {
    const deadline = performance.now() + 5_000;
    while (performance.now() < deadline) {
      // Both views are instance-wide. Bind the known holder AND restrict the actual database;
      // another worker's equal relation OID or advisory key must never satisfy this barrier.
      const [{ blocked }] = await f.db.$queryRaw<{ blocked: number }[]>`
        SELECT count(DISTINCT activity.pid)::int AS blocked
        FROM pg_stat_activity activity
        JOIN pg_locks waiting ON waiting.pid = activity.pid
        WHERE activity.datname = current_database()
          AND waiting.database = (
            SELECT oid FROM pg_database WHERE datname = current_database()
          )
          AND waiting.locktype = 'advisory' AND NOT waiting.granted
          AND ${holderPid} = ANY(pg_blocking_pids(activity.pid))
      `;
      if (blocked === expected) return;
      if (blocked > expected) throw new Error('Unexpected contender at the E4 command barrier');
      await nextTurn();
    }
    throw new Error('Actual E4 command lock wait was not observed within the fixture barrier');
  }

  async function whileCommandBlocked(
    f: E4Fixture,
    command: PrepareCommand,
    requests: readonly (() => Promise<TimeSettlementReceiptResult>)[],
    duringWait?: () => Promise<void>,
  ): Promise<PrepareResult[]> {
    const holder = await holdCommandLock(f, command);
    // Attach rejection handlers immediately, including a failure before the barrier is observed.
    const outcomes = Promise.allSettled(requests.map((run) => run()));
    let holderFailure: PromiseRejectedResult | undefined;
    try {
      await waitForBlockedCommands(f, holder.pid, requests.length);
      if (duringWait) await duringWait();
    } finally {
      holder.release();
      // Drain all contenders even if observation/mutation fails; no leaked work in the next test.
      const cleanup = await Promise.allSettled([holder.done, outcomes]);
      if (cleanup[0].status === 'rejected') holderFailure = cleanup[0];
    }
    if (holderFailure) throw holderFailure.reason;
    return await outcomes;
  }

  async function expectProofCounts(
    f: E4Fixture,
    source: Source,
    command: PrepareCommand,
    count: 0 | 1,
  ) {
    expect(
      await f.db.activitySettlementTimeRevision.count({ where: { activityId: source.activityId } }),
    ).toBe(count);
    expect(
      await f.db.activitySettlementContributionRevision.count({
        where: { activityId: source.activityId },
      }),
    ).toBe(count);
    expect(
      await f.db.participantContributionEvaluation.count({
        where: { contributionRevision: { activityId: source.activityId } },
      }),
    ).toBe(count);
    expect(
      await f.db.activitySettlementTimeCommandReceipt.count({
        where: {
          actorUserId: f.creator.id,
          activityId: source.activityId,
          operationCode: TIME_SETTLEMENT_PREPARE_OPERATION,
          operationKey: command.operationKey,
        },
      }),
    ).toBe(count);
  }

  async function commandAudits(f: E4Fixture, source: Source) {
    return f.db.auditLog.findMany({
      where: {
        actorUserId: f.creator.id,
        event: 'activity.time-settlement.command',
        resourceType: 'activity',
        resourceId: source.activityId,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  it('serializes two actual same-key requests into one immutable proof and receipt, auditing the replay', async () => {
    const f = fixture();
    const source = await createE4Source(f);
    const command = prepareCommand(f, source);
    const first = f.app.get(ActivityTimeSettlementService);
    const second = secondService();
    const outcomes = await whileCommandBlocked(f, command, [
      () => first.prepare(source.activityId, command, e4Actor(f.creator, true), E4_META),
      () => second.prepare(source.activityId, command, e4Actor(f.creator, true), E4_META),
    ]);
    expect(outcomes.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    if (outcomes[0].status !== 'fulfilled' || outcomes[1].status !== 'fulfilled')
      throw new Error('Both actual E4 commands must finish successfully');
    expect(outcomes[0].value).toEqual(outcomes[1].value);
    await expectProofCounts(f, source, command, 1);
    const root = await f.db.activitySettlementContributionRevision.findFirstOrThrow({
      where: { activityId: source.activityId },
    });
    expect(root.recognizedPointsTotal.toFixed(2)).toBe('1.00');
    const audits = await commandAudits(f, source);
    expect(audits).toHaveLength(2);
    expect(audits.map((row) => record(record(row.context).extra).replayed).sort()).toEqual([
      false,
      true,
    ]);
    for (const row of audits)
      expect(record(record(row.context).extra).timeRevisionId).toBe(
        outcomes[0].value.timeRevisionId,
      );
  }, 120_000);

  it('rejects a different payload at the same stored command key without changing the proof or adding a receipt', async () => {
    const f = fixture();
    const source = await createE4Source(f);
    const command = prepareCommand(f, source);
    const first = f.app.get(ActivityTimeSettlementService);
    const original = await first.prepare(
      source.activityId,
      command,
      e4Actor(f.creator, true),
      E4_META,
    );
    const second = secondService();
    const outcomes = await whileCommandBlocked(f, command, [
      () => first.prepare(source.activityId, command, e4Actor(f.creator, true), E4_META),
      () =>
        second.prepare(
          source.activityId,
          { ...command, expectedTimeRevision: 1 },
          e4Actor(f.creator, true),
          E4_META,
        ),
    ]);
    expect(outcomes[0]).toEqual({ status: 'fulfilled', value: original });
    expect(outcomes[1]).toMatchObject({
      status: 'rejected',
      reason: { biz: BizCode.ACTIVITY_TIME_SETTLEMENT_COMMAND_CONFLICT },
    });
    await expectProofCounts(f, source, command, 1);
    const audits = await commandAudits(f, source);
    expect(audits).toHaveLength(2); // Original success and authorized replay; rejected payload adds none.
    expect(
      audits.filter((row) => record(record(row.context).extra).replayed === true),
    ).toHaveLength(1);
  }, 120_000);

  it('rereads revoked explicit grants after an observed real lock wait and creates no proof or receipt', async () => {
    const f = fixture();
    const source = await createE4Source(f);
    const command = prepareCommand(f, source);
    const service = f.app.get(ActivityTimeSettlementService);
    const outcomes = await whileCommandBlocked(
      f,
      command,
      [() => service.prepare(source.activityId, command, e4Actor(f.creator, true), E4_META)],
      async () => {
        const revoked = await f.db.roleBinding.updateMany({
          where: {
            principalType: PrincipalType.USER,
            principalId: f.creator.id,
            deletedAt: null,
          },
          data: { deletedAt: new Date() },
        });
        expect(revoked.count).toBeGreaterThan(0);
      },
    );
    expect(outcomes).toMatchObject([
      {
        status: 'rejected',
        reason: { biz: BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE },
      },
    ]);
    await expectProofCounts(f, source, command, 0);
    expect(await commandAudits(f, source)).toEqual([]);
  }, 120_000);

  it('rereads inactive member status after the actual lock wait rather than trusting the initial actor', async () => {
    const f = fixture();
    const source = await createE4Source(f);
    const command = prepareCommand(f, source);
    const service = f.app.get(ActivityTimeSettlementService);
    const outcomes = await whileCommandBlocked(
      f,
      command,
      [() => service.prepare(source.activityId, command, e4Actor(f.creator, true), E4_META)],
      async () => {
        await f.db.member.update({
          where: { id: f.creator.memberId },
          data: { status: MemberStatus.INACTIVE },
        });
      },
    );
    expect(outcomes).toMatchObject([{ status: 'rejected', reason: { biz: BizCode.FORBIDDEN } }]);
    await expectProofCounts(f, source, command, 0);
    expect(await commandAudits(f, source)).toEqual([]);
  }, 120_000);

  it('rolls back actual time/proof/evaluation/receipt writes if the final transactional audit fails', async () => {
    const f = fixture();
    const source = await createE4Source(f);
    const command = prepareCommand(f, source);
    const failure = new Error('E4 controlled final audit failure');
    let observedWrites = false;
    const audit = jest
      .spyOn(f.app.get(ActivityTimeSettlementAuditRecorder), 'log')
      .mockImplementationOnce(async (tx, _actor, _meta, operation, result, replayed, proof) => {
        expect(operation).toBe(TIME_SETTLEMENT_PREPARE_OPERATION);
        expect(replayed).toBe(false);
        expect(proof?.id).toEqual(expect.any(String));
        expect(
          await tx.activitySettlementTimeCommandReceipt.count({
            where: { timeRevisionId: result.timeRevisionId, operationKey: command.operationKey },
          }),
        ).toBe(1);
        expect(
          await tx.participantContributionEvaluation.count({
            where: { contributionRevisionId: proof?.id },
          }),
        ).toBe(1);
        observedWrites = true;
        throw failure;
      });
    await expect(
      f.app
        .get(ActivityTimeSettlementService)
        .prepare(source.activityId, command, e4Actor(f.creator, true), E4_META),
    ).rejects.toBe(failure);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(observedWrites).toBe(true);
    await expectProofCounts(f, source, command, 0);
    expect(await commandAudits(f, source)).toEqual([]);
  }, 120_000);
});
