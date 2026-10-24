import {
  closeE5MatrixApp,
  markE5MatrixUnknown,
  e5ActiveMatrixOptions,
  assertE5MatrixMode,
  assertE5MatrixSettled,
  e5MatrixIt as it,
  e5MatrixBeforeEach as beforeEach,
} from '../helpers/e5-active-matrix';
import type { INestApplication } from '@nestjs/common';
import { MemberStatus, PrincipalType, Prisma, PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { assertE4PrepareAcceptanceV2 } from '../helpers/e4-maximum-stage-receipt';
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

installE4ValidationDatabase(e5ActiveMatrixOptions());
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
    assertE5MatrixMode(current.app);
    // A separate real application/pool; do not reset its shared worker database again.
    secondApp = await createTestApp();
    assertE5MatrixMode(secondApp);
    lockDb = new PrismaClient();
    await lockDb.$connect();
    await Promise.all([
      assertConnectedTestDatabase(current.db),
      assertConnectedTestDatabase(secondApp.get(PrismaService)),
      assertConnectedTestDatabase(lockDb),
    ]);
  }, 120_000);
  afterEach(async () => {
    assertE5MatrixSettled();
    jest.restoreAllMocks();
    const cleanup = await Promise.allSettled([
      lockDb?.$disconnect(),
      closeE5MatrixApp(secondApp),
      closeE5MatrixApp(current?.app),
    ]);
    current = undefined;
    secondApp = undefined;
    lockDb = undefined;
    if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
    const failures = cleanup.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    );
    if (failures.length) {
      markE5MatrixUnknown();
      throw new AggregateError(failures, 'E4 concurrency cleanup failed');
    }
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

  // C1-v2 boundary proofs are small cases, not maximum-capacity samples.
  async function c1V2BusinessSnapshot(db: PrismaClient) {
    const tables = await db.$queryRaw<{ name: string }[]>`
      SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename
    `;
    expect(tables.length).toBeGreaterThanOrEqual(196);
    expect(tables.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'ActivitySettlementTimeRevision',
        'ParticipantSettlementTimeBucket',
        'ParticipantSettlementTimeBucketSource',
        'ActivitySettlementContributionRevision',
        'ParticipantContributionEvaluation',
        'ActivitySettlementTimeCommandReceipt',
        'audit_logs',
        'notification_outbox_intents',
      ]),
    );
    const fragments = tables.map(
      ({ name }) => Prisma.sql`
      SELECT ${name}::text AS name,
        coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb)::text AS canonical
      FROM ${Prisma.raw('public."' + name.replaceAll('"', '""') + '"')} r
    `,
    );
    const rows = await db.$queryRaw<{ name: string; canonical: string }[]>(
      Prisma.join(fragments, ' UNION ALL '),
    );
    expect(rows).toHaveLength(tables.length);
    return rows
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((row) => ({
        table: row.name,
        digest: createHash('sha256').update(row.canonical).digest('hex'),
      }));
  }

  function c1V2DelayAfterActualGuards(f: E4Fixture, delayMs: 31_000 | 61_000) {
    const recorder = f.app.get(ActivityTimeSettlementAuditRecorder);
    const actualLog = recorder.log.bind(recorder);
    let delay: Promise<void> | undefined;
    let barriers = 0;
    let delaySettled = false;
    let restoreExecute: (() => void) | undefined;
    const audit = jest.spyOn(recorder, 'log').mockImplementationOnce(async (...args) => {
      await actualLog(...args);
      const [tx, , , operation] = args;
      expect(operation).toBe(TIME_SETTLEMENT_PREPARE_OPERATION);
      const actualExecute = tx.$executeRaw.bind(tx);
      const execute = jest
        .spyOn(tx, '$executeRaw')
        .mockImplementationOnce((query, ...values: unknown[]) => {
          const text = ('strings' in query ? query.strings : [...query])
            .join(' ')
            .replace(/\s+/gu, ' ')
            .trim();
          expect(text).toBe(
            'SET CONSTRAINTS public.astr_parent_complete_guard, public.e4_revision_complete_guard IMMEDIATE',
          );
          return actualExecute(query, ...values).then(async (result) => {
            barriers++;
            // Only this test callback waits; original PostgreSQL guards already ran.
            delay = new Promise<void>((resolve) => setTimeout(resolve, delayMs));
            await delay;
            delaySettled = true;
            return result;
          }) as never;
        });
      restoreExecute = () => execute.mockRestore();
    });
    return {
      wait: async () => {
        await delay;
      },
      facts: () => ({ barriers, delaySettled }),
      restore: () => {
        restoreExecute?.();
        audit.mockRestore();
      },
    };
  }

  async function c1V2AssertLocksReleased(f: E4Fixture, source: Source, command: PrepareCommand) {
    if (!lockDb) throw new Error('C1-v2 independent lock verifier missing');
    const key = JSON.stringify([
      'activity-time-settlement',
      f.creator.id,
      TIME_SETTLEMENT_PREPARE_OPERATION,
      command.operationKey,
    ]);
    await lockDb.$transaction(
      async (tx) => {
        const [advisory] = await tx.$queryRaw<{ acquired: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS acquired
      `;
        expect(advisory.acquired).toBe(true);
        const activity = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Activity" WHERE id=${source.activityId} FOR UPDATE NOWAIT
      `;
        const run = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "AttendanceSettlementRun" WHERE "activityId"=${source.activityId} FOR UPDATE NOWAIT
      `;
        expect(activity).toHaveLength(1);
        expect(run).toHaveLength(1);
      },
      { timeout: 5_000 },
    );
  }

  function c1V2ObserveEngine(f: E4Fixture) {
    const engine = Reflect.get(f.db, '_engine') as {
      transaction: (...args: unknown[]) => Promise<unknown>;
    };
    const spy = jest.spyOn(engine, 'transaction');
    let retainedCalls: typeof spy.mock.calls | undefined;
    let retainedResults: typeof spy.mock.results | undefined;
    const calls = () => retainedCalls ?? spy.mock.calls;
    const results = () => retainedResults ?? spy.mock.results;
    return {
      calls,
      restore: () => {
        retainedCalls = [...spy.mock.calls];
        retainedResults = [...spy.mock.results];
        spy.mockRestore();
      },
      assertStart: () => {
        const starts = calls().filter((args) => args[0] === 'start');
        expect(starts).toHaveLength(1);
        expect(starts[0][2]).toMatchObject({
          timeout: 60_000,
          maxWait: 2_000,
          isolationLevel: 'ReadCommitted',
        });
        return starts;
      },
      committed: async (methodWallMs: number) => {
        const phases = await Promise.all(
          results().map(async (result, index) => {
            const value: unknown = result.value;
            let outcome = 'error';
            if (result.type === 'return') {
              try {
                await value;
                outcome = 'ok';
              } catch {
                /* Preserve the actual outcome. */
              }
            }
            return { phase: String(calls()[index][0]), outcome };
          }),
        );
        return assertE4PrepareAcceptanceV2(
          {
            phases,
            starts: calls()
              .filter((args) => args[0] === 'start')
              .map((args) => {
                const options = args[2] as {
                  timeout: number;
                  maxWait: number;
                  isolationLevel: string;
                };
                return {
                  timeoutMs: options.timeout,
                  maxWaitMs: options.maxWait,
                  isolationLevel: options.isolationLevel,
                };
              }),
            pending: 0,
            unknown: false,
          },
          methodWallMs,
        );
      },
    };
  }

  it('C1-v2 prepare commits after 31s inside the real 60s transaction', async () => {
    const f = fixture();
    const source = await createE4Source(f);
    const command = prepareCommand(f, source);
    const delayed = c1V2DelayAfterActualGuards(f, 31_000);
    const engine = c1V2ObserveEngine(f);
    const started = performance.now();
    let result: TimeSettlementReceiptResult;
    let transaction: ReturnType<typeof assertE4PrepareAcceptanceV2>;
    try {
      result = await f.app
        .get(ActivityTimeSettlementService)
        .prepare(source.activityId, command, e4Actor(f.creator, true), E4_META);
      const methodWallMs = performance.now() - started;
      engine.assertStart();
      transaction = await engine.committed(methodWallMs);
      expect(methodWallMs).toBeGreaterThanOrEqual(31_000);
    } finally {
      await delayed.wait();
      delayed.restore();
      engine.restore();
    }
    expect(delayed.facts()).toEqual({ barriers: 1, delaySettled: true });
    await expectProofCounts(f, source, command, 1);
    const root = await f.db.activitySettlementContributionRevision.findFirstOrThrow({
      where: { activityId: source.activityId },
    });
    expect(root.evaluationCount).toBe(1);
    expect(root.recognizedPointsTotal.toFixed(2)).toBe('1.00');
    expect(result.bucketCount).toBe(4);
    expect(result.sourceCount).toBe(4);
    expect(
      await f.db.participantSettlementTimeBucket.count({
        where: { timeRevisionId: result.timeRevisionId },
      }),
    ).toBe(4);
    expect(
      await f.db.participantSettlementTimeBucketSource.count({
        where: { timeRevisionId: result.timeRevisionId },
      }),
    ).toBe(4);
    expect(await commandAudits(f, source)).toHaveLength(1);
    await c1V2AssertLocksReleased(f, source, command);
    console.info(
      'E4_C1_V2_BOUNDARY',
      JSON.stringify({
        kind: '31s_commit',
        ...transaction,
        completeWrites: true,
        locksReleased: true,
      }),
    );
  }, 120_000);

  it('C1-v2 prepare exceeding 60s rolls back, releases locks and retries once', async () => {
    const f = fixture();
    const source = await createE4Source(f);
    const command = prepareCommand(f, source);
    const before = await c1V2BusinessSnapshot(f.db);
    const delayed = c1V2DelayAfterActualGuards(f, 61_000);
    const engine = c1V2ObserveEngine(f);
    let failure: unknown;
    const started = performance.now();
    try {
      await f.app
        .get(ActivityTimeSettlementService)
        .prepare(source.activityId, command, e4Actor(f.creator, true), E4_META);
    } catch (error) {
      failure = error;
    } finally {
      await delayed.wait();
      delayed.restore();
      engine.restore();
    }
    const methodWallMs = performance.now() - started;
    engine.assertStart();
    expect(failure).toMatchObject({ code: 'P2028' });
    expect(methodWallMs).toBeGreaterThanOrEqual(60_000);
    expect(delayed.facts()).toEqual({ barriers: 1, delaySettled: true });
    expect(engine.calls().filter((args) => args[0] === 'commit')).toHaveLength(0);
    expect(await c1V2BusinessSnapshot(f.db)).toEqual(before);
    await expectProofCounts(f, source, command, 0);
    expect(await commandAudits(f, source)).toEqual([]);
    await c1V2AssertLocksReleased(f, source, command);
    const service = f.app.get(ActivityTimeSettlementService);
    const retry = await service.prepare(
      source.activityId,
      command,
      e4Actor(f.creator, true),
      E4_META,
    );
    const replay = await service.prepare(
      source.activityId,
      command,
      e4Actor(f.creator, true),
      E4_META,
    );
    expect(replay).toEqual(retry);
    await expectProofCounts(f, source, command, 1);
    const audits = await commandAudits(f, source);
    expect(audits).toHaveLength(2);
    expect(audits.map((row) => record(record(row.context).extra).replayed).sort()).toEqual([
      false,
      true,
    ]);
    await c1V2AssertLocksReleased(f, source, command);
    console.info(
      'E4_C1_V2_BOUNDARY',
      JSON.stringify({
        kind: '61s_timeout',
        methodWallMs,
        transactionTimeoutMs: 60_000,
        fullBusinessSnapshotEqual: true,
        auditReceiptOutboxRolledBack: true,
        locksReleased: true,
        retryAndReplayCount: 1,
      }),
    );
  }, 120_000);

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
