import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  e4DiagnosticContext,
  installE4DiagnosticLimits,
  superviseE4DiagnosticChild,
  e4DiagnosticStageReceipt,
  e4DiagnosticErrorCategory,
  readE4DiagnosticStageReceipt,
  installE4DiagnosticFixtureGate,
} from '../helpers/e4-diagnostic-limits-client';
import { E4PreparePhaseDiagnostic } from '../helpers/e4-prepare-phase-diagnostic';
import { E4SameBackendPlanDiagnostic } from '../helpers/e4-same-backend-plan-diagnostic';
import {
  E4EngineRequestWaitDiagnostic,
  E4NativeRequestBoundaryDiagnostic,
} from '../helpers/e4-engine-request-wait-diagnostic';
import { observeTestEngineTransactions } from '../helpers/engine-transaction-observation';
import { ActivityTimeSettlementService } from '../../src/modules/activities/activity-time-settlement.service';
import { ActivityTimeSettlementQueryService } from '../../src/modules/activities/activity-time-settlement-query.service';
import { ActivityTimeSettlementAccessService } from '../../src/modules/activities/activity-time-settlement-access.service';
import { ActivityTimeSettlementAuditRecorder } from '../../src/modules/activities/activity-time-settlement-audit-recorder';
import { ActivityTimeAllocationService } from '../../src/modules/activities/activity-time-allocation.service';
import { ActivityContributionSettlementService } from '../../src/modules/activities/activity-contribution-settlement.service';
import { ActivityContributionSettlementQueryService } from '../../src/modules/activities/activity-contribution-settlement-query.service';
import { SettlementSubmitService } from '../../src/modules/activities/settlement-submit.service';
import { ParticipationSegmentFacade } from '../../src/modules/attendances/participation-segment.facade';
import { ActivityWorkflowGate } from '../../src/common/activity-workflow/activity-workflow.gate';
import type { E4Fixture } from '../helpers/activity-contribution-policy.fixture';
import { loadTestEnv } from '../setup/load-env';
import { assertConnectedTestDatabase } from '../setup/test-db';

class DiagnosticDatabase extends PrismaClient<Prisma.PrismaClientOptions, 'query'> {
  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}

export const E4_DIAGNOSTIC_PLAN = Object.freeze({
  schema: 'e4-prepare-cost/v1',
  purpose: 'DIAGNOSTIC_ONLY',
  acceptance: 'NOT_AN_ACCEPTANCE_RESULT',
  fixture: 'createMaximumE4Source',
  identities: 2000,
  segments: 10000,
  slices: 50000,
  units: 8000,
  transactionMs: 90000,
  processMs: 600000,
  productionTransactionMs: 30000,
  rounds: 1,
  scope: 'app_test_w98',
  guardFunctions: 'NOT_RUN',
  formal30: 'FAIL_UNCHANGED',
});
const oraclePath = resolve(
  __dirname,
  '../e2e/activity-os-r5-e4-contribution-settlement-scale.e2e-spec.ts',
);
const oracleHash = '50a090de9193d80ab659852c0420aed4e05290913be1050b5f5631da9cf17ed6';
const oracleNames = [
  'fixedE4RootAggregateSql',
  'assertFixedE4RootOracle',
  'assertE4SliceSourceDenominators',
  'assertFixedE4DayOracle',
  'assertFixedE4Oracle',
];

/** Read frozen functions as data; never import/register the original E2E suite. */
export function frozenE4OracleSource(source = readFileSync(oraclePath, 'utf8')) {
  if (createHash('sha256').update(source).digest('hex') !== oracleHash)
    throw new Error('E4 frozen oracle source refused');
  const ast = ts.createSourceFile(
    oraclePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const functions = ast.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && !!node.name && oracleNames.includes(node.name.text),
  );
  if (functions.length !== 5 || new Set(functions.map((node) => node.name!.text)).size !== 5)
    throw new Error('E4 oracle coverage refused');
  return functions.map((node) => node.getText(ast)).join('\n');
}
function frozenE4Oracle() {
  const code = ts.transpileModule(frozenE4OracleSource(), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return runInNewContext(code + '\nassertFixedE4Oracle;', {
    Prisma,
    createHash,
    readFileSync,
    resolve,
    __dirname: dirname(oraclePath),
    expect,
  }) as (db: PrismaClient, id: string, count: number) => Promise<void>;
}
export function requireDiagnosticEnvironment(env: NodeJS.ProcessEnv, head: string) {
  if (
    env.SRVF_E4_DIAGNOSTIC_PURPOSE !== 'DIAGNOSTIC_ONLY' ||
    env.APP_ENV !== 'test' ||
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_REPOSITORY !== 'BA7IEE/srvf-nest-api' ||
    env.GITHUB_REF !== 'refs/heads/codex/activity-os-r5-e4-github-validation' ||
    env.GITHUB_SHA !== head ||
    env.GITHUB_RUN_ATTEMPT !== '1' ||
    env.SRVF_E4_GITHUB_ISOLATED !== '1' ||
    env.SRVF_TEST_RUN_SCOPE !== 'app_test_w98' ||
    env.SRVF_E4_W98 !== '1' ||
    !/^[0-9a-f]{40}$/u.test(head) ||
    !/^\d+$/u.test(env.GITHUB_RUN_ID ?? '') ||
    [
      'SRVF_E4_N1_LIFECYCLE',
      'SRVF_E4_GUARD_FUNCTION_DIAGNOSTIC',
      'SRVF_E4_GUARD_PLAN_DIAGNOSTIC',
    ].some((key) => !!env[key])
  )
    throw new Error('E4 one-round isolated diagnostic environment refused');
}
type Report = typeof E4_DIAGNOSTIC_PLAN & {
  head: string;
  run: string;
  status: 'COMPLETE' | 'FAILED' | 'UNKNOWN' | 'TIMED_OUT';
  oracle: 'NOT_RUN' | 'COMPLETE';
  resources: 'UNKNOWN' | 'CLOSED';
  prepareMs?: number;
  errorCode?: string;
  phase?: unknown;
  boundary?: unknown;
  requests?: unknown;
  transaction?: unknown;
  limits?: unknown;
  internal?: unknown;
};
function writeBounded(path: string, value: unknown) {
  const json = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(json) > 65536) throw new Error('E4 diagnostic output limit');
  writeFileSync(path, json, { flag: 'wx', mode: 0o600 });
}
export function stageReceipt(privateDir: string, head: string, run: string) {
  return e4DiagnosticStageReceipt(head, run, (receipt) => {
    const json = JSON.stringify(receipt);
    if (Buffer.byteLength(json) > 4096) throw new Error('E4 stage receipt limit');
    const temporary = join(privateDir, 'stage.next');
    writeFileSync(temporary, json, { mode: 0o600 });
    renameSync(temporary, join(privateDir, 'stage.json'));
  });
}

/** This closed Jest child is registered only through an IPC-supervised parent. */
function registerDiagnosticChild() {
  const head = process.env.SRVF_E4_DIAGNOSTIC_HEAD ?? '';
  requireDiagnosticEnvironment(process.env, head);
  if (
    !process.connected ||
    typeof process.send !== 'function' ||
    process.env.SRVF_E4_DIAGNOSTIC_PARENT !== String(process.ppid) ||
    !/^[0-9a-f]{64}$/u.test(process.env.SRVF_E4_DIAGNOSTIC_TOKEN ?? '')
  )
    throw new Error('E4 parent watchdog required');
  const privateDir = process.env.SRVF_E4_DIAGNOSTIC_PRIVATE_DIR!;
  if (
    !privateDir ||
    resolve(privateDir) !== privateDir ||
    !privateDir.startsWith(join(tmpdir(), 'srvf-e4-prepare-cost-'))
  )
    throw new Error('E4 private output refused');
  const report: Report = {
    ...E4_DIAGNOSTIC_PLAN,
    head,
    run: process.env.GITHUB_RUN_ID!,
    status: 'UNKNOWN',
    oracle: 'NOT_RUN',
    resources: 'UNKNOWN',
  };
  const checkpoint = stageReceipt(privateDir, head, report.run);
  // Refuse synchronously before even registering a lease/lifecycle hook.
  checkpoint.start(
    'GUARD',
    () => {
      process.env.JEST_WORKER_ID = '98';
      loadTestEnv();
      e4DiagnosticContext({
        purpose: process.env.SRVF_E4_DIAGNOSTIC_PURPOSE!,
        scope: process.env.SRVF_TEST_RUN_SCOPE!,
        sourceHead: head,
        databaseUrl: process.env.DATABASE_URL ?? '',
        appEnv: process.env.APP_ENV ?? '',
      });
      frozenE4OracleSource();
    },
    'REFUSED',
  );
  checkpoint.mark('GUARD', 'COMPLETE');
  // Scope-sensitive fixture import must occur after the explicit child guard, before Jest collection ends.
  const fixture = checkpoint.start(
    'FIXTURE_BOOTSTRAP',
    () => {
      const loaded =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../helpers/activity-contribution-policy.fixture') as typeof import('../helpers/activity-contribution-policy.fixture');
      loaded.installE4ValidationDatabase();
      return loaded;
    },
    'INITIALIZATION_FAILED',
  );
  // Registered after existing DROP + lease release hooks. Parent also requires Jest exit0.
  afterAll(() => writeBounded(join(privateDir, 'child.json'), report));
  describe('E4 DIAGNOSTIC_ONLY one maximum prepare', () => {
    it('records original complete prepare and commit with the full frozen oracle', async () => {
      // The database installer has finished loading .env.test; capture the gate before Nest config.
      const context = e4DiagnosticContext({
        purpose: 'DIAGNOSTIC_ONLY',
        scope: 'app_test_w98',
        sourceHead: head,
        databaseUrl: process.env.DATABASE_URL ?? '',
        appEnv: process.env.APP_ENV ?? '',
      });
      const restoreGate = installE4DiagnosticFixtureGate(context);
      let f: E4Fixture | undefined, db: DiagnosticDatabase | undefined;
      try {
        f = await fixture.createE4Fixture();
        checkpoint.mark('FIXTURE_BOOTSTRAP', 'COMPLETE');
        checkpoint.mark('SOURCE_BUILD', 'ENTER');
        const source = await fixture.createMaximumE4Source(f);
        expect(
          await f.db.activityParticipationIdentity.count({
            where: { activityId: source.activityId },
          }),
        ).toBe(2000);
        expect(
          await f.db.participantTimeAllocationRevision.count({
            where: { activityId: source.activityId },
          }),
        ).toBe(10000);
        expect(
          await f.db.participantTimeAllocationSlice.count({
            where: { activityId: source.activityId },
          }),
        ).toBe(50000);
        checkpoint.mark('SOURCE_BUILD', 'COMPLETE');
        checkpoint.mark('PREPARE', 'ENTER');
        const measuredUrl = new URL(process.env.DATABASE_URL!);
        measuredUrl.searchParams.set('connection_limit', '1');
        db = new DiagnosticDatabase({
          datasources: { db: { url: measuredUrl.toString() } },
          log: [{ emit: 'event', level: 'query' }],
        });
        await assertConnectedTestDatabase(db);
        const limits = installE4DiagnosticLimits(db, context);
        const observer = f.db;
        const internal = new E4SameBackendPlanDiagnostic(limits.client, context, {
          observe: (sql, pid, scope) =>
            observer.$transaction(
              async (tx) => {
                await tx.$executeRaw`SET TRANSACTION READ ONLY`;
                return tx.$queryRawUnsafe(sql, pid, scope);
              },
              { timeout: 2000, maxWait: 1000 },
            ),
        });
        const contributions = f.app.get(ActivityContributionSettlementService),
          access = f.app.get(ActivityTimeSettlementAccessService),
          segments = f.app.get(ParticipationSegmentFacade);
        const reader = new ActivityTimeSettlementQueryService(
          internal.client,
          access,
          segments,
          f.app.get(ActivityContributionSettlementQueryService),
        );
        const measured = new ActivityTimeSettlementService(
          internal.client,
          access,
          reader,
          segments,
          f.app.get(ActivityTimeAllocationService),
          f.app.get(SettlementSubmitService),
          f.app.get(ActivityTimeSettlementAuditRecorder),
          f.app.get(ActivityWorkflowGate),
          contributions,
        );
        const engine: unknown = Reflect.get(db, '_engine');
        if (!engine || typeof engine !== 'object')
          throw new Error('E4 transaction observation unavailable');
        const transaction = observeTestEngineTransactions(engine);
        const requests = new E4EngineRequestWaitDiagnostic(engine);
        const native = new E4NativeRequestBoundaryDiagnostic(engine);
        const phase = new E4PreparePhaseDiagnostic([
          { phase: 'C3_PROOF', target: measured, method: 'lockedProof' },
          { phase: 'C3_SOURCE', target: measured, method: 'lockedSources' },
          { phase: 'C3_EVAL', target: reader, method: 'evaluateInTx' },
          { phase: 'C3_BUCKET_WRITE', target: measured, method: 'insertBuckets' },
          { phase: 'E4_PREPARE', target: contributions, method: 'prepareTimeInTx' },
          {
            phase: 'E4_EVAL',
            target: f.app.get(ActivityContributionSettlementQueryService),
            method: 'readTimeEvaluationInTx',
          },
          { phase: 'E4_EVAL_WRITE', target: contributions, method: 'insertEvaluations' },
          { phase: 'C3_RECEIPT', target: measured, method: 'receipt' },
        ]);
        db.$on('query', (event) => {
          native.queryEvent(event.query, event.duration);
          if (!/^\s*(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)\b/iu.test(event.query))
            phase.query(
              /^\s*(SELECT|WITH)\b/iu.test(event.query) ? 'READ' : 'WRITE',
              event.duration,
            );
        });
        const anchor = performance.now();
        phase.enableBoundaryTimeline(anchor);
        requests.begin();
        native.begin(anchor);
        phase.begin();
        let outcome: 'OK' | 'FAIL' = 'FAIL';
        let prepared: Awaited<ReturnType<ActivityTimeSettlementService['prepare']>>;
        try {
          prepared = await measured.prepare(
            source.activityId,
            {
              expectedDraftVersion: source.expectation.expectedDraftVersion,
              expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,
              operationKey: f.key('maximum_prepare'),
              expectedTimeRevision: 0,
            },
            fixture.e4Actor(f.creator, true),
            fixture.E4_META,
          );
          outcome = 'OK';
        } finally {
          report.prepareMs = performance.now() - anchor;
          native.finish();
          native.restore();
          requests.finish();
          requests.restore();
          phase.finish(outcome);
          phase.restore();
          transaction.restore();
          limits.restore();
          report.phase = phase.snapshot();
          report.boundary = { method: phase.boundarySnapshot(), native: native.snapshot() };
          report.requests = requests.snapshot();
          report.transaction = transaction.snapshot();
          report.limits = limits.snapshot();
          report.internal = internal.snapshot();
        }
        checkpoint.mark('PREPARE', 'COMPLETE');
        checkpoint.mark('ORACLE', 'ENTER');
        expect(prepared.bucketCount).toBe(8000);
        expect(prepared.sourceCount).toBe(40000);
        const proof = await f.db.activitySettlementContributionRevision.findFirstOrThrow({
          where: { settlementVersionId: prepared.settlementVersionId },
        });
        expect(proof.evaluationCount).toBe(8000);
        expect(proof.recognizedPointsTotal.toFixed(2)).toBe('1000.00');
        await frozenE4Oracle()(f.db, proof.id, 8000);
        checkpoint.mark('ORACLE', 'COMPLETE');
        report.oracle = 'COMPLETE';
        report.status = internal.snapshot().status === 'OBSERVED' ? 'COMPLETE' : 'UNKNOWN';
      } catch (error) {
        report.status = 'FAILED';
        checkpoint.mark(
          checkpoint.lastStage(),
          'FAILED',
          e4DiagnosticErrorCategory(
            error,
            checkpoint.lastStage() === 'FIXTURE_BOOTSTRAP' ? 'INITIALIZATION_FAILED' : 'UNKNOWN',
          ),
        );
        const code = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : 'other';
        report.errorCode = ['P2028', 'P2010', 'P2002', 'P2003'].includes(code) ? code : 'other';
        throw new Error('E4 diagnostic failed; see redacted counters');
      } finally {
        try {
          // All connections must close before the existing normal DROP and lease release.
          checkpoint.mark('CLEANUP', 'ENTER');
          try {
            try {
              await db?.$disconnect();
            } finally {
              await fixture.closeE13Fixture(f);
            }
            checkpoint.mark('CLEANUP', 'COMPLETE');
            report.resources = 'CLOSED';
          } catch (error) {
            report.status = 'FAILED';
            checkpoint.mark(
              'CLEANUP',
              'FAILED',
              e4DiagnosticErrorCategory(error, 'CLEANUP_FAILED'),
            );
          }
        } finally {
          restoreGate();
        }
      }
      if (report.resources !== 'CLOSED') throw new Error('E4 diagnostic cleanup failed');
    }, 300000);
  });
}

export async function runDiagnosticParent() {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  requireDiagnosticEnvironment(process.env, head);
  if (
    process.platform !== 'linux' ||
    execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
  )
    throw new Error('E4 clean Linux checkout required');
  frozenE4OracleSource();
  const output = resolve(process.cwd(), 'tmp/e4-prepare-cost-evidence/result.json');
  const privateDir = mkdtempSync(join(tmpdir(), 'srvf-e4-prepare-cost-'));
  const checkpoint = stageReceipt(privateDir, head, process.env.GITHUB_RUN_ID!);
  checkpoint.mark('GUARD', 'ENTER');
  let pid: number | undefined;
  let interrupted = false;
  const signal = (kind: 'SIGTERM' | 'SIGKILL') => {
    if (pid)
      try {
        process.kill(-pid, kind);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
  };
  const emergency = () => signal('SIGKILL');
  const interrupt = () => {
    interrupted = true;
    emergency();
  };
  process.once('exit', emergency);
  process.once('SIGTERM', interrupt);
  process.once('SIGINT', interrupt);
  try {
    const config = {
      rootDir: process.cwd(),
      testRegex: 'test/diagnostics/e4-prepare-cost\\.diagnostic-spec\\.ts$',
      moduleFileExtensions: ['ts', 'js', 'json'],
      transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/test/tsconfig.test.json' }] },
      testEnvironment: 'node',
    };
    const child = spawn(
      process.execPath,
      [
        require.resolve('jest/bin/jest'),
        '--config',
        JSON.stringify(config),
        '--runInBand',
        '--no-cache',
        '--silent',
        '--runTestsByPath',
        'test/diagnostics/e4-prepare-cost.diagnostic-spec.ts',
      ],
      {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: {
          ...process.env,
          SRVF_E4_DIAGNOSTIC_CHILD: '1',
          SRVF_E4_DIAGNOSTIC_HEAD: head,
          SRVF_E4_DIAGNOSTIC_PARENT: String(process.pid),
          SRVF_E4_DIAGNOSTIC_TOKEN: randomBytes(32).toString('hex'),
          SRVF_E4_DIAGNOSTIC_PRIVATE_DIR: privateDir,
        },
      },
    );
    pid = child.pid;
    let spawnFailed = false;
    child.once('error', () => {
      spawnFailed = true;
    });
    const processResult = await superviseE4DiagnosticChild({
      onClose: (callback) => child.once('close', callback),
      signal,
      groupAlive: () => {
        if (!pid) return false;
        try {
          process.kill(-pid, 0);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
          throw error;
        }
      },
    });
    let report: Report = {
      ...E4_DIAGNOSTIC_PLAN,
      head,
      run: process.env.GITHUB_RUN_ID!,
      status: 'UNKNOWN',
      oracle: 'NOT_RUN',
      resources: 'UNKNOWN',
    };
    try {
      const raw = readFileSync(join(privateDir, 'child.json'));
      if (raw.length > 65536) throw new Error('size');
      const data = JSON.parse(raw.toString()) as Report;
      if (
        data.schema !== E4_DIAGNOSTIC_PLAN.schema ||
        data.head !== head ||
        data.run !== report.run ||
        data.purpose !== 'DIAGNOSTIC_ONLY' ||
        data.acceptance !== 'NOT_AN_ACCEPTANCE_RESULT' ||
        data.transactionMs !== 90000 ||
        data.processMs !== 600000
      )
        throw new Error('binding');
      report = data;
    } catch {
      /* Missing/invalid evidence stays UNKNOWN. */
    }
    let stage = readE4DiagnosticStageReceipt(null, head, report.run, processResult.exitCode);
    try {
      const raw = readFileSync(join(privateDir, 'stage.json'));
      if (raw.length <= 4096)
        stage = readE4DiagnosticStageReceipt(
          JSON.parse(raw.toString()),
          head,
          report.run,
          processResult.exitCode,
          interrupted || processResult.stopped,
        );
    } catch {
      /* Fixed UNKNOWN receipt; never echo raw bytes or exceptions. */
    }
    if (interrupted || processResult.stopped) report.status = 'TIMED_OUT';
    else if (stage.receiptStatus === 'FAILED') report.status = 'FAILED';
    else if (
      spawnFailed ||
      processResult.exitCode !== 0 ||
      !processResult.cleanupConfirmed ||
      stage.receiptStatus !== 'OBSERVED' ||
      report.resources !== 'CLOSED' ||
      report.oracle !== 'COMPLETE'
    )
      report.status = 'UNKNOWN';
    mkdirSync(dirname(output), { recursive: true });
    writeBounded(output, {
      ...report,
      process: processResult,
      stage,
      interrupted,
      databaseCleanup:
        !interrupted &&
        !processResult.stopped &&
        processResult.exitCode === 0 &&
        processResult.cleanupConfirmed
          ? 'NORMAL_DROP_AND_LEASE_RELEASE'
          : 'UNKNOWN',
    });
    return report.status === 'COMPLETE' ? 0 : 1;
  } finally {
    emergency();
    process.removeListener('exit', emergency);
    process.removeListener('SIGTERM', interrupt);
    process.removeListener('SIGINT', interrupt);
    rmSync(privateDir, { recursive: true, force: true });
  }
}
if (process.env.SRVF_E4_DIAGNOSTIC_CHILD === '1') registerDiagnosticChild();
if (require.main === module) {
  if (process.argv.length === 3 && process.argv[2] === '--plan')
    console.info(JSON.stringify(E4_DIAGNOSTIC_PLAN, null, 2));
  else if (process.argv.length === 3 && process.argv[2] === '--execute')
    void runDiagnosticParent().then(
      (code) => {
        process.exitCode = code;
      },
      () => {
        console.error('E4 diagnostic refused or failed; no acceptance result');
        process.exitCode = 1;
      },
    );
  else {
    console.error('Use --plan or explicit supervised --execute');
    process.exitCode = 1;
  }
}
