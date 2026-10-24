import { Prisma, PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { PrismaService } from '../../src/database/prisma.service';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { runMemberLinearizedTransaction } from '../../src/common/prisma/member-advisory-lock.util';
import { LedgerPostingService } from '../../src/modules/activities/ledger-posting.service';
import { LedgerPostingAuditRecorder } from '../../src/modules/activities/ledger-posting-audit-recorder';
import {
  closeE13Fixture,
  createE4Fixture,
  createE4Source,
  e4Actor,
  E4_META,
  installE4ValidationDatabase,
  prepareE4Time,
  prepareE4Ledger,
  submitE4Time,
  type E4Fixture,
} from '../helpers/activity-contribution-policy.fixture';
import { createDiagnosticE4Source } from '../diagnostics/e4-prepare-cost.diagnostic-spec';
import { assertConnectedTestDatabase } from '../setup/test-db';

let f: E4Fixture, monitor: PrismaClient;
let pending = 0,
  failed = false,
  appClosed = true,
  monitorClosed = true;
const outer = Reflect.get(globalThis, Symbol.for('srvf.ledger60.deadline'));
const deadline =
  performance.now() + (typeof outer === 'number' ? Math.max(0, outer - Date.now()) : 300_000);
function admit(responseMs = 5_000) {
  if (deadline - performance.now() < responseMs + 20_000)
    throw new Error('Ledger60 UNKNOWN: incomplete response and cleanup allowance');
}
async function owned<T>(work: () => Promise<T>): Promise<T> {
  if (failed || pending) throw new Error('Ledger60 prior FAIL/UNKNOWN; preserve database');
  pending++;
  try {
    return await work();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    pending--;
  }
}
installE4ValidationDatabase({
  allowInstallRetain: true,
  boundMigrationProcesses: true,
  assertReadyToFinalize: () => {
    if (failed || pending || !appClosed || !monitorClosed)
      throw new Error('Ledger60 FAIL/UNKNOWN; preserve database');
  },
});
async function snapshot() {
  admit();
  const tables = await monitor.$queryRaw<
    { name: string }[]
  >`SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND relname<>'_prisma_migrations' ORDER BY relname COLLATE "C"`;
  const hashes: string[] = [];
  for (const { name } of tables) {
    admit();
    const [row] = await monitor.$queryRawUnsafe<{ digest: string }[]>(
      'SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text COLLATE "C"),\'[]\'::jsonb)::text) AS digest FROM public."' +
        name.replaceAll('"', '""') +
        '" t',
    );
    hashes.push(row.digest);
  }
  return createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
}
type SourceOptions = NonNullable<Parameters<typeof createE4Source>[1]>;
function shiftTargetOptions(options: SourceOptions, ordinal: number): SourceOptions {
  const offset = ordinal * 86_400_000;
  if (!options.startsAt || !options.endsAt || !options.manualSlices)
    throw new Error('Complete explicit ledger boundary source times required');
  return {
    ...options,
    startsAt: new Date(options.startsAt.getTime() + offset),
    endsAt: new Date(options.endsAt.getTime() + offset),
    manualSlices: options.manualSlices.map((slice) => ({
      ...slice,
      startAt: new Date(Date.parse(slice.startAt) + offset).toISOString(),
      endAt: new Date(Date.parse(slice.endAt) + offset).toISOString(),
    })),
  };
}
let targetOrdinal = 0;
async function target() {
  admit(25_000);
  const ordinal = targetOrdinal++;
  const source = await createDiagnosticE4Source(f, 1, (fixture, options = {}) =>
    createE4Source(fixture, shiftTargetOptions(options, ordinal)),
  );
  const prepared = await prepareE4Time(f, source);
  const submitted = await submitE4Time(f, source, prepared);
  const posting = await prepareE4Ledger(f, submitted);
  return { ...posting, activityId: source.activityId, versionId: submitted.settlementVersionId };
}
type Target = Awaited<ReturnType<typeof target>>;
async function facts(t: Target) {
  admit();
  const [row] = await monitor.$queryRaw<
    {
      status: string;
      runStatus: string;
      visible: number;
      entries: number;
      audits: number;
      notifications: number;
      draftResults: number;
      committedResults: number;
    }[]
  >`SELECT b."statusCode" AS status,r."statusCode" AS "runStatus",
    (SELECT count(*)::int FROM "ParticipationLedgerEntry" e WHERE e."postingBatchId"=b.id AND b."statusCode"='committed') AS visible,
    (SELECT count(*)::int FROM "ParticipationLedgerEntry" e WHERE e."postingBatchId"=b.id) AS entries,
    (SELECT count(*)::int FROM audit_logs a WHERE a."resourceId"=${t.activityId} AND a.context->'extra' @> ${JSON.stringify({ operation: 'settlement-ledger-commit', operationKey: t.commitCommand.operationKey })}::jsonb) AS audits,
    (SELECT count(*)::int FROM notification_outbox_intents n WHERE n."eventKey"=${'settlement-ledger-commit:' + t.batchId}) AS notifications,
    (SELECT count(*)::int FROM "ParticipantSettlementResultRevision" x WHERE x."settlementVersionId"=b."settlementVersionId" AND x."statusCode"='draft') AS "draftResults",
    (SELECT count(*)::int FROM "ParticipantSettlementResultRevision" x WHERE x."settlementVersionId"=b."settlementVersionId" AND x."statusCode"='committed') AS "committedResults"
    FROM "LedgerPostingBatch" b JOIN "AttendanceSettlementRun" r ON r.id=b."settlementRunId" WHERE b.id=${t.batchId}`;
  if (!row) throw new Error('Actual ledger target absent');
  return row;
}
async function locksReleased(t: Target, pid: number) {
  admit();
  const [idle] = await monitor.$queryRaw<
    { transactions: number; locks: number }[]
  >`SELECT (SELECT count(*)::int FROM pg_stat_activity WHERE pid=CAST(${pid} AS integer) AND xact_start IS NOT NULL) AS transactions,(SELECT count(*)::int FROM pg_locks WHERE pid=CAST(${pid} AS integer)) AS locks`;
  expect(idle).toEqual({ transactions: 0, locks: 0 });
  await monitor.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL lock_timeout='1s'`;
    await tx.$queryRaw`SELECT id FROM "Activity" WHERE id=${t.activityId} FOR UPDATE NOWAIT`;
    await tx.$queryRaw`SELECT id FROM "AttendanceSettlementRun" WHERE "activityId"=${t.activityId} FOR UPDATE NOWAIT`;
    await tx.$queryRaw`SELECT id FROM "AttendanceSettlementVersion" WHERE id=${t.versionId} FOR UPDATE NOWAIT`;
    await tx.$queryRaw`SELECT id FROM "LedgerPostingBatch" WHERE id=${t.batchId} FOR UPDATE NOWAIT`;
  });
}

describe('ordinary E4 ledger named transaction resource boundary', () => {
  const gate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  beforeAll(
    () =>
      owned(async () => {
        admit(25_000);
        process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
        appClosed = false;
        f = await createE4Fixture();
        monitorClosed = false;
        monitor = new PrismaClient();
        await monitor.$connect();
        await assertConnectedTestDatabase(monitor);
        const [catalog] = await monitor.$queryRaw<
          { count: number; pin: string }[]
        >`SELECT (SELECT count(*)::int FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS count,(SELECT md5(prosrc) FROM pg_proc WHERE oid='public.e4_assert_complete(text,boolean)'::regprocedure) AS pin`;
        expect(catalog).toEqual({ count: 153, pin: '40b56bac5a571c56e589cbc549419bfa' });
      }),
    120_000,
  );
  afterAll(async () => {
    try {
      if (f) {
        await closeE13Fixture(f);
        appClosed = true;
      }
    } finally {
      try {
        if (monitor) {
          await monitor.$disconnect();
          monitorClosed = true;
        }
      } finally {
        if (gate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
        else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = gate;
      }
    }
  }, 30_000);

  for (const seconds of [61, 8] as const) {
    it(
      seconds + 's preserves full native validation, atomic visibility and retry/replay',
      () =>
        owned(async () => {
          admit(90_000);
          const t = await target(),
            before = await snapshot(),
            beforeFacts = await facts(t);
          expect(beforeFacts.status).toBe('ready');
          expect(beforeFacts.visible).toBe(0);
          expect(beforeFacts.entries).toBeGreaterThan(0);
          const audit = f.app.get(LedgerPostingAuditRecorder),
            original = audit.log.bind(audit);
          let injections = 0,
            pid: number | undefined;
          const delay = jest.spyOn(audit, 'log').mockImplementation(async (args) => {
            await original(args);
            if (args.operationKey === t.commitCommand.operationKey && !args.replayed) {
              injections++;
              const [binding] = await args.tx.$queryRaw<
                { pid: number }[]
              >`SELECT pg_backend_pid() AS pid`;
              pid = binding.pid;
              await args.tx
                .$queryRaw`SELECT true AS slept FROM pg_sleep(${seconds}::double precision)`;
            }
          });
          const transactions = jest.spyOn(f.app.get(PrismaService), '$transaction');
          const call = () => {
            admit(65_000);
            return f.app
              .get(LedgerPostingService)
              .commitBatch(t.commitCommand, e4Actor(f.finalReviewer), E4_META);
          };
          const start = performance.now();
          let failure: unknown;
          let result: Awaited<ReturnType<typeof call>> | undefined;
          try {
            result = await call();
          } catch (error) {
            failure = error;
          } finally {
            delay.mockRestore();
          }
          const wallMs = performance.now() - start;
          try {
            if (failure !== undefined) {
              const originalFailure =
                failure instanceof Error
                  ? failure
                  : new Error('Non-Error ledger failure', { cause: failure });
              // Keep the original error/cause before any secondary assertion can hide it.
              // inspect does not invoke custom inspectors or property getters.
              try {
                console.error(
                  'E4_LEDGER60_ORIGINAL_FAILURE',
                  inspect(failure, {
                    depth: null,
                    showHidden: true,
                    customInspect: false,
                    getters: false,
                    maxArrayLength: null,
                    maxStringLength: null,
                  }),
                );
              } catch {
                throw originalFailure;
              }
              if (seconds === 8) throw originalFailure;
            }
            expect(injections).toBe(1);
            expect(pid).toBeDefined();
            expect(transactions).toHaveBeenCalledTimes(1);
            expect(transactions.mock.calls[0][1]).toEqual({
              isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
              timeout: 60_000,
            });
            if (seconds === 61) {
              expect(failure).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
              expect((failure as Prisma.PrismaClientKnownRequestError).code).toBe('P2028');
              expect(await snapshot()).toBe(before);
              expect(await facts(t)).toEqual(beforeFacts);
              await locksReleased(t, pid!);
              const retry = await call();
              expect(retry.replayed).toBe(false);
              const posted = await facts(t);
              expect(posted.status).toBe('committed');
              expect(posted.runStatus).toBe('posted');
              expect(posted.visible).toBe(posted.entries);
              expect(posted.draftResults).toBe(0);
              expect(posted.committedResults).toBe(beforeFacts.draftResults);
              expect(posted.audits).toBe(1);
              expect(posted.notifications).toBe(1);
              const after = await snapshot();
              const replay = await call();
              expect(replay.replayed).toBe(true);
              expect(replay.postingBatchId).toBe(retry.postingBatchId);
              expect(await snapshot()).toBe(after);
              expect(await facts(t)).toEqual(posted);
            } else {
              expect(failure).toBeUndefined();
              expect(result?.replayed).toBe(false);
              expect(wallMs).toBeGreaterThanOrEqual(8_000);
              const posted = await facts(t);
              expect(posted.status).toBe('committed');
              expect(posted.visible).toBe(posted.entries);
              expect(posted.audits).toBe(1);
              expect(posted.notifications).toBe(1);
            }
            await locksReleased(t, pid!);
            console.info(
              'E4_LEDGER60_BOUNDARY',
              JSON.stringify({
                seconds,
                wallMs,
                timeout: 60_000,
                locksReleased: true,
                status: seconds === 61 ? 'ROLLED_BACK_RETRY_REPLAY_EXACT' : 'COMMITTED',
              }),
            );
          } finally {
            transactions.mockRestore();
          }
        }),
      110_000,
    );
  }

  it(
    'rejects stale root and standard-to-E4 classification before effects, including replay',
    () =>
      owned(async () => {
        const t = await target(),
          before = await snapshot();
        const prisma = f.app.get(PrismaService),
          original = prisma.ledgerPostingBatch.findUnique.bind(prisma.ledgerPostingBatch);
        for (const mode of ['wrong-root', 'missing-root'] as const) {
          const selector = jest
            .spyOn(
              prisma.ledgerPostingBatch as unknown as {
                findUnique: (...args: Parameters<typeof original>) => Promise<unknown>;
              },
              'findUnique',
            )
            .mockImplementation(async (...args) => {
              const value = await original(...args);
              if (!value) return value;
              // Simulate a stale unlocked selector. All locked reads and native business guards stay real.
              return {
                ...value,
                settlementVersion: {
                  contributionRegimeCode: 'policy_v1',
                  settlementContributionRevisions:
                    mode === 'wrong-root' ? [{ id: 'stale-root' }] : [],
                },
              };
            });
          try {
            await expect(
              f.app
                .get(LedgerPostingService)
                .commitBatch(t.commitCommand, e4Actor(f.finalReviewer), E4_META),
            ).rejects.toMatchObject<Partial<BizException>>({
              biz: BizCode.LEDGER_COMMIT_BATCH_STATUS_INVALID,
            });
            expect(await snapshot()).toBe(before);
          } finally {
            selector.mockRestore();
          }
        }
      }),
    45_000,
  );

  it.each([
    ['standard', 7_000],
    ['d7-human-correction-commit', 15_000],
  ] as const)('%s retains its original real database transaction profile', (profile, timeout) =>
    owned(async () => {
      admit();
      const prisma = f.app.get(PrismaService),
        transactions = jest.spyOn(prisma, '$transaction');
      try {
        const [row] = await runMemberLinearizedTransaction(
          prisma,
          async (tx) =>
            tx.$queryRaw<
              { isolation: string; lock: string }[]
            >`SELECT current_setting('transaction_isolation') AS isolation,current_setting('lock_timeout') AS lock`,
          profile,
        );
        expect(row).toEqual({ isolation: 'read committed', lock: '4s' });
        expect(transactions.mock.calls[0][1]).toEqual({
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          timeout,
        });
      } finally {
        transactions.mockRestore();
      }
    }),
  );
});
