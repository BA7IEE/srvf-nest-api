import { Prisma, PrismaClient, type ActivitySettlementContributionRevision } from '@prisma/client';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PrismaService } from '../../src/database/prisma.service';
import { SettlementReviewAuditRecorder } from '../../src/modules/activities/settlement-review-audit-recorder';
import {
  SettlementReviewService,
  SETTLEMENT_REVIEW_TX_TIMEOUT_MS,
  type SettlementReviewInput,
} from '../../src/modules/activities/settlement-review.service';
import {
  closeE13Fixture,
  createE4Fixture,
  createE4Source,
  e4Actor,
  E4_META,
  installE4ValidationDatabase,
  prepareE4Time,
  submitE4Time,
  type E4Fixture,
} from '../helpers/activity-contribution-policy.fixture';
import { createDiagnosticE4Source } from '../diagnostics/e4-prepare-cost.diagnostic-spec';
import { assertConnectedTestDatabase } from '../setup/test-db';
import { deriveTestDbName } from '../setup/worktree-db';

type Stage = 'first' | 'final';
let f: E4Fixture, monitor: PrismaClient, draft: ActivitySettlementContributionRevision;
let pending = 0,
  failed = false,
  appClosed = true,
  monitorClosed = true;
const outer = Reflect.get(globalThis, Symbol.for('srvf.review60.deadline'));
const deadline =
  performance.now() + (typeof outer === 'number' ? Math.max(0, outer - Date.now()) : 300_000);
function admit(responseMs = 5_000) {
  if (deadline - performance.now() < responseMs + 20_000)
    throw new Error('Review60 UNKNOWN: insufficient complete response and cleanup allowance');
}
async function owned<T>(work: () => Promise<T>): Promise<T> {
  if (failed || pending) throw new Error('Review60 prior FAIL/UNKNOWN; preserve database');
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
      throw new Error('Review60 FAIL/UNKNOWN; preserve database');
  },
});
const q = (s: string) => "'" + s.replaceAll("'", "''") + "'";
const db = () => f.db;
async function snapshot(client: PrismaClient) {
  admit();
  const tables = await client.$queryRaw<
    { name: string }[]
  >`SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND relname<>'_prisma_migrations' ORDER BY relname COLLATE "C"`;
  const hashes: string[] = [];
  for (const { name } of tables) {
    admit();
    const [row] = await client.$queryRawUnsafe<{ digest: string }[]>(
      'SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text COLLATE "C"),\'[]\'::jsonb)::text) AS digest FROM public."' +
        name.replaceAll('"', '""') +
        '" t',
    );
    hashes.push(row.digest);
  }
  return createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
}
function nativeQuery(sql: string, database: string, oid: number) {
  admit(35_000);
  const binding =
    'SELECT current_database()=' +
    q(database) +
    ' AND oid=' +
    String(oid) +
    " AS valid FROM pg_database WHERE datname=current_database() \\gset\n\\if :valid\n\\else\n\\quit 7\n\\endif\nSELECT 'REVIEW60_DATABASE '||current_database()||' '||oid::text FROM pg_database WHERE datname=current_database();\n";
  // The repository's CI and local environment use this same named PG container.
  const result = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      'u-nest-api-postgres',
      'psql',
      '-X',
      '-qAt',
      '-v',
      'VERBOSITY=verbose',
      '-U',
      'postgres',
      '-d',
      database,
    ],
    { input: binding + sql, timeout: 35_000, encoding: 'utf8' },
  );
  if (result.error) throw result.error;
  expect(result.stdout).toContain('REVIEW60_DATABASE ' + database + ' ' + oid);
  return result;
}
async function facts(input: SettlementReviewInput, stage: Stage) {
  admit();
  const [row] = await monitor.$queryRaw<
    {
      runStatus: string;
      versionStatus: string;
      decisions: number;
      exactDecisions: number;
      notifications: number;
      freshAudits: number;
      replayAudits: number;
      batches: number;
      preparingBatches: number;
      entries: number;
    }[]
  >`SELECT r."statusCode" AS "runStatus",v."statusCode" AS "versionStatus",
    (SELECT count(*)::int FROM "SettlementReviewAction" a WHERE a."settlementVersionId"=v.id AND a."stageCode"=${stage}) AS decisions,
    (SELECT count(*)::int FROM "SettlementReviewAction" a WHERE a."settlementVersionId"=v.id AND a."stageCode"=${stage} AND a."operationKey"=${input.operationKey} AND a."requestHash"=${input.requestHash}) AS "exactDecisions",
    (SELECT count(*)::int FROM notification_outbox_intents n WHERE n."eventKey"=${'settlement-review:' + input.expectedSettlementVersionId + ':' + stage}) AS notifications,
    (SELECT count(*)::int FROM audit_logs a WHERE a.event='activity.publish' AND a."resourceId"=${input.activityId} AND a.context->'extra' @> ${JSON.stringify({ operationKey: input.operationKey, replayed: false })}::jsonb) AS "freshAudits",
    (SELECT count(*)::int FROM audit_logs a WHERE a.event='activity.publish' AND a."resourceId"=${input.activityId} AND a.context->'extra' @> ${JSON.stringify({ operationKey: input.operationKey, replayed: true })}::jsonb) AS "replayAudits",
    (SELECT count(*)::int FROM "LedgerPostingBatch" b WHERE b."settlementVersionId"=v.id) AS batches,
    (SELECT count(*)::int FROM "LedgerPostingBatch" b WHERE b."settlementVersionId"=v.id AND b."statusCode"='preparing') AS "preparingBatches",
    (SELECT count(*)::int FROM "ParticipationLedgerEntry" e JOIN "LedgerPostingBatch" b ON b.id=e."postingBatchId" WHERE b."settlementVersionId"=v.id) AS entries
    FROM "AttendanceSettlementVersion" v JOIN "AttendanceSettlementRun" r ON r.id=v."settlementRunId" WHERE v.id=${input.expectedSettlementVersionId}`;
  if (!row) throw new Error('Actual review target absent');
  return row;
}
function expected(stage: Stage, committed: boolean, replayed = false) {
  return {
    runStatus: committed
      ? stage === 'first'
        ? 'pending_final_review'
        : 'posting'
      : stage === 'first'
        ? 'pending_first_review'
        : 'pending_final_review',
    versionStatus: committed && stage === 'final' ? 'approved' : 'submitted',
    decisions: committed ? 1 : 0,
    exactDecisions: committed ? 1 : 0,
    notifications: committed ? 1 : 0,
    freshAudits: committed ? 1 : 0,
    replayAudits: replayed ? 1 : 0,
    batches: committed && stage === 'final' ? 1 : 0,
    preparingBatches: committed && stage === 'final' ? 1 : 0,
    entries: 0,
  };
}
async function locksReleased(input: SettlementReviewInput, pid: number) {
  admit();
  const [idle] = await monitor.$queryRaw<
    { transactions: number; locks: number }[]
  >`SELECT (SELECT count(*)::int FROM pg_stat_activity WHERE pid=CAST(${pid} AS integer) AND xact_start IS NOT NULL) AS transactions,(SELECT count(*)::int FROM pg_locks WHERE pid=CAST(${pid} AS integer)) AS locks`;
  expect(idle).toEqual({ transactions: 0, locks: 0 });
  await monitor.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL lock_timeout='1s'`;
    expect(
      await tx.$queryRaw`SELECT id FROM "Activity" WHERE id=${input.activityId} FOR UPDATE NOWAIT`,
    ).toHaveLength(1);
    expect(
      await tx.$queryRaw`SELECT id FROM "AttendanceSettlementRun" WHERE "activityId"=${input.activityId} FOR UPDATE NOWAIT`,
    ).toHaveLength(1);
    expect(
      await tx.$queryRaw`SELECT id FROM "AttendanceSettlementVersion" WHERE id=${input.expectedSettlementVersionId} FOR UPDATE NOWAIT`,
    ).toHaveLength(1);
  });
}
async function target(stage: Stage) {
  admit(20_000);
  const source = await createDiagnosticE4Source(f, 1, createE4Source),
    prepared = await prepareE4Time(f, source),
    submitted = await submitE4Time(f, source, prepared);
  const version = await f.db.attendanceSettlementVersion.findUniqueOrThrow({
    where: { id: submitted.settlementVersionId },
  });
  const input: SettlementReviewInput = {
    activityId: submitted.activityId,
    expectedSettlementVersionId: version.id,
    actionCode: 'approve',
    operationKey: f.key('review60_' + stage),
    requestHash: (stage === 'first' ? 'c' : 'd').repeat(64),
    expectation: {
      evidenceSealId: version.evidenceSealId,
      evidenceRevision: version.evidenceRevision,
      populationRevision: version.populationRevision,
      workflowRevision: version.workflowRevision,
      contentHash: version.contentHash,
    },
  };
  const review = f.app.get(SettlementReviewService);
  if (stage === 'final') {
    admit(65_000);
    await review.firstReview(
      { ...input, operationKey: f.key('review60_setup_first') },
      e4Actor(f.reviewer),
      E4_META,
    );
  }
  expect(await facts(input, stage)).toEqual(expected(stage, false));
  return { input, review };
}

describe('current153 review transaction resource boundary', () => {
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
        const source = await createDiagnosticE4Source(f, 1, createE4Source),
          prepared = await prepareE4Time(f, source);
        draft = await f.db.activitySettlementContributionRevision.findFirstOrThrow({
          where: { settlementVersionId: prepared.settlementVersionId },
        });
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
  // Complete both long rollback/retry cases before the short commit cases,
  // so every late dispatch still has its complete paid response window.
  for (const seconds of [61, 16] as const)
    for (const stage of ['first', 'final'] as const) {
      it(
        stage + ' ' + seconds + 's keeps real guards, atomic effects and retry semantics',
        () =>
          owned(async () => {
            admit(seconds * 1000 + 25_000);
            const { input, review } = await target(stage),
              before = await snapshot(monitor);
            const audit = f.app.get(SettlementReviewAuditRecorder),
              original = audit.log.bind(audit);
            let injections = 0,
              pid: number | undefined;
            // Delay only after the REAL audit write inside the REAL service transaction.
            // Full contributions, native triggers, locks, authorization and outbox stay live.
            const delay = jest.spyOn(audit, 'log').mockImplementation(async (args) => {
              await original(args);
              if (args.operationKey === input.operationKey && !args.replayed) {
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
              return stage === 'first'
                ? review.firstReview(input, e4Actor(f.reviewer), E4_META)
                : review.finalReview(input, e4Actor(f.finalReviewer), E4_META);
            };
            const start = performance.now();
            let failure: unknown, result: Awaited<ReturnType<typeof call>> | undefined;
            try {
              result = await call();
            } catch (error) {
              failure = error;
            } finally {
              delay.mockRestore();
            }
            const wallMs = performance.now() - start;
            try {
              expect(injections).toBe(1);
              expect(pid).toBeDefined();
              expect(SETTLEMENT_REVIEW_TX_TIMEOUT_MS).toBe(60_000);
              expect(transactions).toHaveBeenCalledTimes(1);
              expect(transactions.mock.calls[0][1]).toEqual({ timeout: 60_000 });
              if (seconds === 16) {
                expect(failure).toBeUndefined();
                expect(result?.replayed).toBe(false);
                expect(wallMs).toBeGreaterThanOrEqual(16_000);
                expect(await facts(input, stage)).toEqual(expected(stage, true));
              } else {
                expect(failure).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
                expect((failure as Prisma.PrismaClientKnownRequestError).code).toBe('P2028');
                expect(await snapshot(monitor)).toBe(before);
                expect(await facts(input, stage)).toEqual(expected(stage, false));
                await locksReleased(input, pid!);
                const retried = await call();
                expect(retried.replayed).toBe(false);
                expect(await facts(input, stage)).toEqual(expected(stage, true));
                const replay = await call();
                expect(replay.replayed).toBe(true);
                expect(replay.reviewActionId).toBe(retried.reviewActionId);
                expect(replay.ledgerPostingBatchId).toBe(retried.ledgerPostingBatchId);
                expect(await facts(input, stage)).toEqual(expected(stage, true, true));
              }
              await locksReleased(input, pid!);
              console.info(
                'E4_REVIEW60_BOUNDARY',
                JSON.stringify({
                  stage,
                  seconds,
                  wallMs,
                  transactionTimeoutMs: 60_000,
                  status: seconds === 16 ? 'COMMITTED' : 'ROLLED_BACK_RETRY_REPLAY_EXACT',
                  locksReleased: true,
                  fullBusinessRollback: seconds === 61,
                }),
              );
            } finally {
              transactions.mockRestore();
            }
          }),
        100_000,
      );
    }
  it(
    'retains actual INSERT rejection and later deferred COMMIT rejection atomically',
    async () =>
      owned(async () => {
        admit(35_000);
        const before = await snapshot(db());
        const [identity] = await db().$queryRaw<
          { name: string; oid: number; unix: boolean }[]
        >`SELECT current_database() AS name,(SELECT oid::int FROM pg_database WHERE datname=current_database()) AS oid,inet_server_addr() IS NULL AS unix`;
        expect(identity.name).toBe(deriveTestDbName());
        expect(identity.unix).toBe(false);
        const nativeLogs = mkdtempSync(resolve(tmpdir(), 'srvf-review60-native-'));
        const row = (id: string, revision: number) =>
          `(jsonb_populate_record(NULL::public."ActivitySettlementContributionRevision",to_jsonb(p)||jsonb_build_object('id',${q(id)},'revision',${revision},'operationKey',${q(id)},'requestHash',repeat('c',64)))).*`;
        const rootId = f!.key('review60_native'),
          badId = f!.key('review60_incomplete');
        const insert = (id: string, revision: number) =>
          'INSERT INTO public."ActivitySettlementContributionRevision" SELECT ' +
          row(id, revision) +
          ' FROM public."ActivitySettlementContributionRevision" p WHERE id=' +
          q(draft.id) +
          ';';
        const evaluations = (id: string, missing: boolean) =>
          'INSERT INTO public."ParticipantContributionEvaluation" SELECT (jsonb_populate_record(NULL::public."ParticipantContributionEvaluation",to_jsonb(e)||jsonb_build_object(\'id\',md5(' +
          q(id) +
          "||e.id),'contributionRevisionId'," +
          q(id) +
          '))).* FROM public."ParticipantContributionEvaluation" e WHERE "contributionRevisionId"=' +
          q(draft.id) +
          (missing
            ? ' AND id<>(SELECT min(id COLLATE "C") FROM public."ParticipantContributionEvaluation" WHERE "contributionRevisionId"=' +
              q(draft.id) +
              ')'
            : '') +
          ';';
        for (const phase of ['INSERT', 'COMMIT']) {
          admit(35_000);
          const sql = `\\set ON_ERROR_STOP off\nBEGIN; SET LOCAL statement_timeout='30s';\n${insert(rootId, draft.revision + 10)}\n\\echo REVIEW60_ROOT_STATE :SQLSTATE\n${evaluations(rootId, phase === 'INSERT')}\n\\echo REVIEW60_EVAL_STATE :SQLSTATE\n${phase === 'COMMIT' ? insert(badId, draft.revision + 11) + '\n\\echo REVIEW60_BAD_ROOT_STATE :SQLSTATE\nCOMMIT;' : ''}\n\\set result_state :SQLSTATE\n\\echo REVIEW60_NATIVE_STATE :result_state\n\\errverbose\nROLLBACK;\n`;
          const result = nativeQuery(sql, identity.name, identity.oid);
          writeFileSync(resolve(nativeLogs, phase + '.stdout'), result.stdout ?? '');
          writeFileSync(resolve(nativeLogs, phase + '.stderr'), result.stderr ?? '');
          if (result.error) throw result.error;
          expect(result.status).toBe(0);
          expect(result.stdout).toMatch(/REVIEW60_ROOT_STATE 00000/u);
          expect(result.stdout).toMatch(
            phase === 'INSERT' ? /REVIEW60_EVAL_STATE 23514/u : /REVIEW60_EVAL_STATE 00000/u,
          );
          if (phase === 'COMMIT') expect(result.stdout).toMatch(/REVIEW60_BAD_ROOT_STATE 00000/u);
          expect(result.stdout).toMatch(/REVIEW60_NATIVE_STATE 23514/u);
          expect(result.stderr).toContain('e4_evaluation_guard');
          expect(await snapshot(db())).toBe(before);
          console.info(
            'E4_REVIEW60_NATIVE_REJECTION',
            JSON.stringify({ phase, sqlstate: '23514', rollback: true }),
          );
        }
        await assertConnectedTestDatabase(db());
      }),
    120_000,
  );
});
