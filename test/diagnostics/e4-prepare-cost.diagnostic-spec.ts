import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  renameSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  e4DiagnosticContext,
  e4DiagnosticScenario,
  E4_DIAGNOSTIC_SCENARIOS,
  observeE4DiagnosticTransactionLifetime,
  type E4DiagnosticScenario,
  installE4DiagnosticLimits,
  superviseE4DiagnosticChild,
  e4DiagnosticStageReceipt,
  e4DiagnosticErrorCategory,
  e4DiagnosticSafeError,
  readE4DiagnosticStageReceipt,
  installE4DiagnosticFixtureGate,
  e4DiagnosticCleanupReceipt,
  e4DiagnosticCleanupAllowance,
} from '../helpers/e4-diagnostic-limits-client';
import { E4PreparePhaseDiagnostic } from '../helpers/e4-prepare-phase-diagnostic';
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
import { SettlementReviewService } from '../../src/modules/activities/settlement-review.service';
import { LedgerPreparationService } from '../../src/modules/activities/ledger-preparation.service';
import { LedgerPostingService } from '../../src/modules/activities/ledger-posting.service';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import {
  buildActivityTimeAllocationManifest,
  type ActivityTimeAllocationSliceInput,
} from '../../src/modules/activities/activity-time-allocation-command';
import type { TimeSettlementReceiptResult } from '../../src/modules/activities/activity-time-settlement-command';
import type { E4Fixture } from '../helpers/activity-contribution-policy.fixture';
import { loadTestEnv } from '../setup/load-env';
import { assertConnectedTestDatabase } from '../setup/test-db';
import { deriveTestDbName } from '../setup/worktree-db';

class DiagnosticDatabase extends PrismaClient<Prisma.PrismaClientOptions, 'query'> {
  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}

export const E4_DIAGNOSTIC_PLAN = Object.freeze({
  schema: 'e4-prepare-cost/v2',
  purpose: 'DIAGNOSTIC_ONLY',
  acceptance: 'NOT_AN_ACCEPTANCE_RESULT',
  fixture: 'createMaximumE4Source',
  scenarios: E4_DIAGNOSTIC_SCENARIOS,
  migration143Sha256: 'c996a26fc7dca81e73a75843d9cdd792d895e5e66855899fd05a42ce7c02d819',
  completeFunctionMd5: 'ade4d2af9aa0baf8400a79fc6b62c797',
  internalSqlPlan: 'NOT_RUN',
  laterStageBudgets: 'ORIGINAL_UNCHANGED',
  shapeAppliesTo: 'maximum',
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
  formal30: 'NOT_REASSESSED',
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
export function oracleStageWrappers(maximum: boolean) {
  return `
const originalRootOracle = assertFixedE4RootOracle;
assertFixedE4RootOracle = function(...args) {
  oracleStep('ORACLE_ROOT_AGGREGATE');
  return originalRootOracle(...args).then(result => {
    oracleStep('ORACLE_CANONICAL_DOCUMENT');
    return result;
  });
};
${
  maximum
    ? `
const originalDenominators = assertE4SliceSourceDenominators;
assertE4SliceSourceDenominators = function(...args) {
  oracleStep('ORACLE_SOURCE_DENOMINATORS');
  return originalDenominators(...args).then(result => {
    oracleStep('ORACLE_DAY_POINTS');
    return result;
  });
};
const originalDayOracle = assertFixedE4DayOracle;
assertFixedE4DayOracle = function(...args) {
  oracleStep('ORACLE_DAY_POINTS');
  return originalDayOracle(...args);
};`
    : ''
}
`;
}
type OracleTransactionReceipt = {
  substage: string;
  timeoutMs: number | null;
  wallMs: number;
  outcome: 'PENDING' | 'RETURNED' | 'REJECTED';
  error?: ReturnType<typeof e4DiagnosticSafeError>;
};
/** Independent oracle instance adapter; callback, original Promise and budgets stay untouched. */
export function diagnosticOracleClient<T extends object>(
  client: T,
  evidence: { substage?: string; oracleTransactions?: OracleTransactionReceipt[] },
) {
  const original: unknown = Reflect.get(client, '$transaction');
  if (typeof original !== 'function') throw new Error('E4 oracle observation unavailable');
  const adapter = new Proxy(client, {
    get: (target, key) =>
      key !== '$transaction'
        ? Reflect.get(target, key, target)
        : function (this: unknown, ...args: unknown[]) {
            if (this !== adapter) throw new Error('E4 oracle adapter receiver refused');
            const started = performance.now();
            const options = args[1];
            const timeout: unknown =
              options && typeof options === 'object' ? Reflect.get(options, 'timeout') : undefined;
            evidence.oracleTransactions ??= [];
            if (evidence.oracleTransactions.length >= 32)
              throw new Error('E4 oracle observation limit');
            const result: unknown = Reflect.apply(original, client, args);
            const row: OracleTransactionReceipt = {
              substage: evidence.substage ?? 'ORACLE_PROOF_READ',
              timeoutMs: typeof timeout === 'number' && Number.isFinite(timeout) ? timeout : null,
              wallMs: 0,
              outcome: 'PENDING',
            };
            evidence.oracleTransactions.push(row);
            if (!(result instanceof Promise))
              throw new Error('E4 oracle original Promise required');
            void result.then(
              () => {
                row.wallMs = performance.now() - started;
                row.outcome = 'RETURNED';
              },
              (error) => {
                row.wallMs = performance.now() - started;
                row.outcome = 'REJECTED';
                row.error = e4DiagnosticSafeError(error);
              },
            );
            return result;
          },
  });
  return adapter;
}

type FirstCanonical32Evidence = {
  purpose: 'ISOLATED_FIRST_CANONICAL_NOT_PRODUCTION';
  attempts: 1;
  transactionMs: 30000;
  workMemKb: 32768;
  jit: 'DEFAULT_UNCHANGED';
  wallMs: number;
  outcome: 'ENTERED' | 'RETURNED' | 'REJECTED';
  effective?: { readonly: boolean; workMemKb: number; jitEnabled: boolean };
  fullComparisonValidated?: boolean;
  error?: ReturnType<typeof e4DiagnosticSafeError>;
};
/** Opt-in test instance: only the first canonical callback gets one transaction-local setting. */
export function firstCanonical32Client<T extends object>(
  client: T,
  evidence: { substage?: string; firstCanonical32?: FirstCanonical32Evidence },
) {
  const original: unknown = Reflect.get(client, '$transaction');
  if (typeof original !== 'function') throw new Error('E4 first canonical adapter unavailable');
  let used = false;
  const adapter = new Proxy(client, {
    get: (target, key) =>
      key !== '$transaction'
        ? Reflect.get(target, key, target)
        : function (this: unknown, ...args: unknown[]) {
            if (this !== adapter) throw new Error('E4 first canonical receiver refused');
            if (evidence.substage !== 'ORACLE_CANONICAL_DOCUMENT')
              return Reflect.apply(original, client, args);
            const options = args[1],
              callback = args[0];
            if (
              used ||
              args.length !== 2 ||
              typeof callback !== 'function' ||
              !options ||
              typeof options !== 'object' ||
              Reflect.get(options, 'timeout') !== 30000
            )
              throw new Error('E4 first canonical scope or budget refused');
            used = true;
            const row: FirstCanonical32Evidence = {
              purpose: 'ISOLATED_FIRST_CANONICAL_NOT_PRODUCTION',
              attempts: 1,
              transactionMs: 30000,
              workMemKb: 32768,
              jit: 'DEFAULT_UNCHANGED',
              wallMs: 0,
              outcome: 'ENTERED',
            };
            evidence.firstCanonical32 = row;
            const started = performance.now();
            const result: unknown = Reflect.apply(original, client, [
              async (tx: Prisma.TransactionClient) => {
                // SET LOCAL does not read/write business rows; the frozen callback retains READ ONLY and30s.
                await tx.$executeRaw`SET LOCAL work_mem='32MB'`;
                const value: unknown = await Reflect.apply(callback, undefined, [tx]);
                const [settings] = await tx.$queryRaw<
                  { readonly: boolean; workMemKb: number; jitEnabled: boolean }[]
                >`SELECT current_setting('transaction_read_only')='on' AS readonly,(pg_size_bytes(current_setting('work_mem'))/1024)::int AS "workMemKb",current_setting('jit')='on' AS "jitEnabled"`;
                expect(settings.readonly).toBe(true);
                expect(settings.workMemKb).toBe(32768);
                row.effective = settings;
                return value;
              },
              options,
            ]);
            if (!(result instanceof Promise))
              throw new Error('E4 first canonical Promise required');
            void result.then(
              () => {
                row.wallMs = performance.now() - started;
                row.outcome = 'RETURNED';
              },
              (error) => {
                row.wallMs = performance.now() - started;
                row.outcome = 'REJECTED';
                row.error = e4DiagnosticSafeError(error);
              },
            );
            return result;
          },
  });
  return adapter;
}

function frozenE4Oracle(report: Report) {
  const code = ts.transpileModule(frozenE4OracleSource(), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return runInNewContext(code + oracleStageWrappers(true) + '\nassertFixedE4Oracle;', {
    Prisma,
    createHash,
    readFileSync,
    resolve,
    __dirname: dirname(oraclePath),
    expect,
    oracleStep: (step: string) => {
      report.substage = step;
    },
  }) as (db: PrismaClient, id: string, count: number) => Promise<void>;
}
export function requireDiagnosticEnvironment(env: NodeJS.ProcessEnv, head: string) {
  e4DiagnosticScenario(env.SRVF_E4_DIAGNOSTIC_SCENARIO);
  if (
    env.SRVF_E4_REAL_STATISTICS &&
    (env.SRVF_E4_REAL_STATISTICS !== '1' ||
      env.SRVF_E4_DIAGNOSTIC_SCENARIO !== 'maximum' ||
      [
        'SRVF_E4_SOURCE_JOIN',
        'SRVF_E4_NATIVE_PREPARE_PLAN',
        'SRVF_E4_JOIN_KEY_ONCE',
        'SRVF_E4_JOIN_KEY_CALIBRATION',
        'SRVF_E4_FIXED_METADATA_MAX_ONCE',
        'SRVF_E4_SHARED_GUARD_ONCE',
        'SRVF_E4_CANONICAL_FIRST32',
        'SRVF_E4_CANONICAL_COST_ONLY',
        'SRVF_E4_CANONICAL_JIT_ABBA',
        'SRVF_E4_CANONICAL_MEMORY_PAIR',
      ].some((key) => !!env[key]))
  )
    throw new Error('E4 real statistics maximum scope refused');
  if (
    env.SRVF_E4_SOURCE_JOIN &&
    (!['small', 'ordinary-500', 'statistics-500'].includes(env.SRVF_E4_SOURCE_JOIN) ||
      env.SRVF_E4_DIAGNOSTIC_SCENARIO !==
        (env.SRVF_E4_SOURCE_JOIN === 'small' ? 'ordinary-1' : 'ordinary-500') ||
      [
        'SRVF_E4_NATIVE_PREPARE_PLAN',
        'SRVF_E4_JOIN_KEY_ONCE',
        'SRVF_E4_JOIN_KEY_CALIBRATION',
        'SRVF_E4_FIXED_METADATA_MAX_ONCE',
        'SRVF_E4_SHARED_GUARD_ONCE',
        'SRVF_E4_CANONICAL_FIRST32',
        'SRVF_E4_CANONICAL_COST_ONLY',
        'SRVF_E4_CANONICAL_JIT_ABBA',
        'SRVF_E4_CANONICAL_MEMORY_PAIR',
      ].some((key) => !!env[key]))
  )
    throw new Error('E4 source join scope refused');
  if (
    env.SRVF_E4_NATIVE_PREPARE_PLAN &&
    (env.SRVF_E4_NATIVE_PREPARE_PLAN !== '1' ||
      env.SRVF_E4_DIAGNOSTIC_SCENARIO !== 'ordinary-500' ||
      [
        'SRVF_E4_JOIN_KEY_ONCE',
        'SRVF_E4_JOIN_KEY_CALIBRATION',
        'SRVF_E4_FIXED_METADATA_MAX_ONCE',
        'SRVF_E4_SHARED_GUARD_ONCE',
        'SRVF_E4_CANONICAL_FIRST32',
        'SRVF_E4_CANONICAL_COST_ONLY',
        'SRVF_E4_CANONICAL_JIT_ABBA',
        'SRVF_E4_CANONICAL_MEMORY_PAIR',
      ].some((key) => !!env[key]))
  )
    throw new Error('E4 native prepare500 scope refused');
  if (
    env.SRVF_E4_FIXED_METADATA_MAX_ONCE &&
    (env.SRVF_E4_FIXED_METADATA_MAX_ONCE !== '1' ||
      env.SRVF_E4_DIAGNOSTIC_SCENARIO !== 'maximum' ||
      env.SRVF_E4_JOIN_KEY_ONCE !== '1' ||
      env.SRVF_E4_CANONICAL_FIRST32 !== '1' ||
      [
        'SRVF_E4_JOIN_KEY_CALIBRATION',
        'SRVF_E4_SHARED_GUARD_ONCE',
        'SRVF_E4_CANONICAL_COST_ONLY',
        'SRVF_E4_CANONICAL_JIT_ABBA',
        'SRVF_E4_CANONICAL_MEMORY_PAIR',
      ].some((key) => !!env[key]))
  )
    throw new Error('E4 fixed metadata maximum scope refused');
  if (
    env.SRVF_E4_JOIN_KEY_CALIBRATION &&
    (env.SRVF_E4_JOIN_KEY_CALIBRATION !== '1' ||
      env.SRVF_E4_DIAGNOSTIC_SCENARIO !== 'ordinary-1' ||
      [
        'SRVF_E4_JOIN_KEY_ONCE',
        'SRVF_E4_SHARED_GUARD_ONCE',
        'SRVF_E4_CANONICAL_FIRST32',
        'SRVF_E4_CANONICAL_COST_ONLY',
        'SRVF_E4_CANONICAL_JIT_ABBA',
        'SRVF_E4_CANONICAL_MEMORY_PAIR',
      ].some((key) => !!env[key]))
  )
    throw new Error('E4 small join key calibration scope refused');
  if (
    env.SRVF_E4_JOIN_KEY_ONCE &&
    (env.SRVF_E4_JOIN_KEY_ONCE !== '1' ||
      env.SRVF_E4_DIAGNOSTIC_SCENARIO !== 'maximum' ||
      env.SRVF_E4_CANONICAL_FIRST32 !== '1' ||
      !!env.SRVF_E4_SHARED_GUARD_ONCE)
  )
    throw new Error('E4 join key comparison scope refused');
  if (
    env.SRVF_E4_SHARED_GUARD_ONCE &&
    (env.SRVF_E4_SHARED_GUARD_ONCE !== '1' ||
      env.SRVF_E4_DIAGNOSTIC_SCENARIO !== 'maximum' ||
      env.SRVF_E4_CANONICAL_FIRST32 !== '1')
  )
    throw new Error('E4 shared guard scope refused');
  if (
    env.SRVF_E4_CANONICAL_COST_ONLY &&
    (env.SRVF_E4_CANONICAL_COST_ONLY !== '1' || env.SRVF_E4_DIAGNOSTIC_SCENARIO !== 'maximum')
  )
    throw new Error('E4 canonical cost-only scope refused');
  if (
    env.SRVF_E4_CANONICAL_JIT_ABBA &&
    (env.SRVF_E4_CANONICAL_JIT_ABBA !== '1' || env.SRVF_E4_CANONICAL_COST_ONLY !== '1')
  )
    throw new Error('E4 canonical JIT scope refused');
  if (
    env.SRVF_E4_CANONICAL_MEMORY_PAIR &&
    (env.SRVF_E4_CANONICAL_MEMORY_PAIR !== '1' ||
      env.SRVF_E4_CANONICAL_COST_ONLY !== '1' ||
      !!env.SRVF_E4_CANONICAL_JIT_ABBA)
  )
    throw new Error('E4 canonical memory scope refused');
  if (
    env.SRVF_E4_CANONICAL_FIRST32 &&
    (env.SRVF_E4_CANONICAL_FIRST32 !== '1' ||
      env.SRVF_E4_DIAGNOSTIC_SCENARIO !== 'maximum' ||
      [
        'SRVF_E4_CANONICAL_COST_ONLY',
        'SRVF_E4_CANONICAL_JIT_ABBA',
        'SRVF_E4_CANONICAL_MEMORY_PAIR',
      ].some((key) => !!env[key]))
  )
    throw new Error('E4 canonical first32 scope refused');
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
type Report = Omit<typeof E4_DIAGNOSTIC_PLAN, 'internalSqlPlan' | 'transactionMs'> & {
  transactionMs: 30000 | 90000;
  internalSqlPlan: 'NOT_RUN' | 'OBSERVED';
  head: string;
  run: string;
  status: 'COMPLETE' | 'FAILED' | 'UNKNOWN' | 'TIMED_OUT';
  oracle: 'NOT_RUN' | 'COMPLETE';
  resources: 'UNKNOWN' | 'CLOSED';
  prepareMs?: number;
  sourceBuildMs?: number;
  oracleMs?: number;
  errorCode?: string;
  phase?: unknown;
  boundary?: unknown;
  requests?: unknown;
  transaction?: unknown;
  limits?: unknown;
  internal?: unknown;
  scenario: E4DiagnosticScenario;
  migration: 'NOT_VERIFIED' | 'VERIFIED_143';
  stages: OperationReceipt[];
  lock?: unknown;
  recovery?: unknown;
  facts?: unknown;
  ledger?: unknown;
  failureStage?: string;
  substage?: string;
  errorSubstage?: string;
  error?: ReturnType<typeof e4DiagnosticSafeError>;
  oracleTransactions?: OracleTransactionReceipt[];
  coverage?:
    | 'FULL_SETTLEMENT'
    | 'PREPARE_AND_FIRST_ORACLE_ONLY'
    | 'PREPARE_ORACLE_AND_SHARED_GUARD_ONLY'
    | 'PREPARE_ORACLE_AND_JOIN_KEY_ONLY'
    | 'SMALL_JOIN_KEY_CALIBRATION_ONLY'
    | 'PREPARE_ORACLE_AND_FIXED_METADATA_ONLY'
    | 'PREPARE_NATIVE_PLAN_ONLY'
    | 'PREPARE_SOURCE_JOIN_ONLY';
  sourceJoinStats?: unknown;
  realStatistics?: unknown;
  sourceJoinComparison?: unknown;
  sourceJoinPostOracle?: 'ENTERED' | 'COMPLETE';
  nativePreparePlan?: unknown;
  metadataPostOracle?: {
    status: 'ENTERED' | 'COMPLETE' | 'FAILED';
    firstCanonical32?: FirstCanonical32Evidence;
  };
  joinKeyCandidate?: unknown;
  joinKeyPostFailureOracle?: unknown;
  joinKeyVerificationError?: ReturnType<typeof e4DiagnosticSafeError>;
  firstCanonical32?: FirstCanonical32Evidence;
  canonicalCost?: {
    purpose: 'READ_ONLY_COST_NOT_ACCEPTANCE';
    samples: CanonicalCostSample[];
    plan?: unknown;
    planError?: ReturnType<typeof e4DiagnosticSafeError>;
    jitComparison?: {
      baselineJit: boolean;
      settingsRestored?: boolean;
      samples: CanonicalJitSample[];
      actualPlan?: unknown;
      actualPlanError?: ReturnType<typeof e4DiagnosticSafeError>;
    };
    memoryComparison?: {
      baselineWorkMemKb: number;
      baselineJit: boolean;
      settingsRestored?: boolean;
      samples: CanonicalMemorySample[];
    };
  };
  scenarioShape?: { identities: number; segments: number; slices: number; units: number };
  budgetRecommendation?: string;
};
function writeBounded(path: string, value: unknown) {
  // Preserve every node from both actual plans within the existing64KiB envelope.
  const comparison =
    value &&
    typeof value === 'object' &&
    [
      'PREPARE_ORACLE_AND_JOIN_KEY_ONLY',
      'PREPARE_ORACLE_AND_FIXED_METADATA_ONLY',
      'PREPARE_NATIVE_PLAN_ONLY',
      'PREPARE_SOURCE_JOIN_ONLY',
    ].includes(String(Reflect.get(value, 'coverage')));
  const json = (comparison ? JSON.stringify(value) : JSON.stringify(value, null, 2)) + '\n';
  if (Buffer.byteLength(json) > 65536) throw new Error('E4 diagnostic output limit');
  writeFileSync(path, json, { flag: 'wx', mode: 0o600 });
}
export function writeRealStatisticsArtifact(directory: string, artifact: unknown) {
  const file = 'real-statistics.json';
  const path = join(directory, file);
  writeBounded(path, artifact);
  return { file, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
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

export async function createDiagnosticE4Source(
  f: E4Fixture,
  identities: 1 | 100 | 500,
  createE4Source: (typeof import('../helpers/activity-contribution-policy.fixture'))['createE4Source'],
) {
  const start = new Date('2020-03-01T08:00:00.000Z');
  const end = new Date('2020-03-01T09:00:00.000Z');
  const slicesFor = (startsAt: Date, endsAt: Date): ActivityTimeAllocationSliceInput[] =>
    (
      [
        'volunteer_service',
        'training',
        'organization',
        'non_creditable',
        'volunteer_service',
      ] as const
    ).map((categoryCode, index) => ({
      categoryCode,
      intervalKindCode: 'service_segment',
      startAt: new Date(
        startsAt.getTime() + ((endsAt.getTime() - startsAt.getTime()) * index) / 5,
      ).toISOString(),
      endAt: new Date(
        startsAt.getTime() + ((endsAt.getTime() - startsAt.getTime()) * (index + 1)) / 5,
      ).toISOString(),
    }));
  const p = await createE4Source(f, {
    startsAt: start,
    endsAt: end,
    batch: false,
    manualSlices: slicesFor(start, end),
    beforeSeal: async (draft) => {
      for (let offset = 0; offset < identities - 1; offset += 100) {
        const people = Array.from(
          { length: Math.min(100, identities - 1 - offset) },
          (_, index) => ({
            index: offset + index,
            memberId: f.key('capacity_member'),
            registrationId: f.key('capacity_registration'),
            identityId: f.key('capacity_identity'),
          }),
        );
        const events: Prisma.AttendancePunchEventCreateManyInput[] = [];
        const segments: Prisma.ParticipantServiceSegmentRevisionCreateManyInput[] = [];
        for (const person of people) {
          for (let index = 0; index < 1; index++) {
            const startsAt = new Date(start.getTime() + index * 3600001);
            const endsAt = new Date(startsAt.getTime() + 3600000);
            const eventIds = [f.key('capacity_in'), f.key('capacity_out')];
            for (const [eventIndex, occurredAt] of [startsAt, endsAt].entries()) {
              events.push({
                id: eventIds[eventIndex],
                activityId: draft.activityId,
                sessionId: draft.sessionId,
                positionId: draft.positionId,
                participationIdentityId: person.identityId,
                memberId: person.memberId,
                eventTypeCode: eventIndex === 0 ? 'check_in' : 'check_out',
                sourceCode: 'self_qr',
                occurredAt,
                receivedAt: occurredAt,
                operatorUserId: f.creator.id,
                eventKey: f.key('capacity_event'),
                requestHash: 'b'.repeat(64),
                evidenceRevision: 0,
              });
            }
            segments.push({
              id: f.key('capacity_segment'),
              participationIdentityId: person.identityId,
              segmentKey: String(index + 1).padStart(4, '0'),
              revision: 1,
              sourceCheckInEventId: eventIds[0],
              sourceCloseEventId: eventIds[1],
              resultCode: 'valid',
              statusCode: 'draft',
              checkInAt: startsAt,
              checkOutAt: endsAt,
              serviceHours: 1,
              lateFlag: false,
              earlyLeaveFlag: false,
            });
          }
        }
        await f.db.$transaction(
          async (tx) => {
            await tx.member.createMany({
              data: people.map((person) => ({
                id: person.memberId,
                memberNo: person.memberId,
                ...memberIdentityData('E4 ordinary diagnostic fixture'),
              })),
            });
            await tx.activityRegistration.createMany({
              data: people.map((person) => ({
                id: person.registrationId,
                activityId: draft.activityId,
                memberId: person.memberId,
                statusCode: 'pass',
              })),
            });
            await tx.activityParticipationIdentity.createMany({
              data: people.map((person) => ({
                id: person.identityId,
                activityId: draft.activityId,
                sessionId: draft.sessionId,
                registrationId: person.registrationId,
                memberId: person.memberId,
                currentStatusCode: 'pass',
                populationIncluded: true,
                currentPositionId: draft.positionId,
              })),
            });
            await tx.attendancePunchEvent.createMany({ data: events });
            await tx.participantServiceSegmentRevision.createMany({ data: segments });
          },
          { timeout: 30000 },
        );
      }
    },
  });
  const sources = await f.db.participantServiceSegmentRevision.findMany({
    where: {
      identity: { activityId: p.activityId },
      statusCode: 'draft',
      participationIdentityId: { not: p.identity.id },
    },
    include: { identity: { select: { memberId: true } } },
  });
  expect(sources).toHaveLength(identities - 1);
  const prototype = await f.db.participantTimeAllocationRevision.findFirstOrThrow({
    where: {
      sourceSegmentId: p.segment.id,
      settlementDraftVersionId: p.generated.settlementVersionId,
    },
  });
  const receipt = await f.db.participantTimeAllocationCommandReceipt.findFirstOrThrow({
    where: { allocationRevisionId: prototype.id },
  });
  for (let offset = 0; offset < sources.length; offset += 100) {
    const parents: Prisma.ParticipantTimeAllocationRevisionCreateManyInput[] = [];
    const slices: Prisma.ParticipantTimeAllocationSliceCreateManyInput[] = [];
    const receipts: Prisma.ParticipantTimeAllocationCommandReceiptCreateManyInput[] = [];
    for (const source of sources.slice(offset, offset + 100)) {
      if (!source.checkInAt || !source.checkOutAt)
        throw new Error('E4 current closed source required');
      const id = f.key('capacity_allocation');
      const input = slicesFor(source.checkInAt, source.checkOutAt);
      const { manifest, allocationHash } = buildActivityTimeAllocationManifest(input);
      parents.push({
        ...prototype,
        id,
        sliceCount: input.length,
        participationIdentityId: source.participationIdentityId,
        memberId: source.identity.memberId,
        segmentKey: source.segmentKey,
        sourceSegmentId: source.id,
        sourceSegmentRevision: source.revision,
        allocationJson: {
          schemaVersion: manifest.schemaVersion,
          slices: Object.fromEntries(
            Object.entries(manifest.slices).map(([key, value]) => [key, { ...value }]),
          ),
        },
        allocationHash,
      });
      input.forEach((slice, ordinal) =>
        slices.push({
          id: f.key('capacity_slice'),
          allocationRevisionId: id,
          activityId: p.activityId,
          ordinal,
          categoryCode: slice.categoryCode,
          intervalKindCode: slice.intervalKindCode,
          startAt: new Date(slice.startAt),
          endAt: new Date(slice.endAt),
        }),
      );
      receipts.push({
        ...receipt,
        id: f.key('capacity_receipt'),
        allocationRevisionId: id,
        operationKey: f.key('capacity_operation'),
        resultJson: {
          schemaVersion: 1,
          activityId: p.activityId,
          allocationRevisionId: id,
          revision: 1,
          sourceSegmentId: source.id,
          sourceSegmentRevision: source.revision,
          recognitionModeCode: 'manual',
          allocationHash,
          sliceCount: input.length,
          evidenceCount: 0,
          createdAt: prototype.createdAt.toISOString(),
        },
      });
    }
    await f.db.$transaction(
      async (tx) => {
        await tx.participantTimeAllocationRevision.createMany({ data: parents });
        await tx.participantTimeAllocationSlice.createMany({ data: slices });
        await tx.participantTimeAllocationCommandReceipt.createMany({ data: receipts });
      },
      { timeout: 30000 },
    );
  }
  return p;
}

type OperationReceipt = {
  stage: string;
  wallMs: number;
  outcome: 'COMPLETE' | 'FAILED';
  errorCategory: string;
  transaction: ReturnType<ReturnType<typeof observeE4DiagnosticTransactionLifetime>['snapshot']>;
};
export function diagnosticPopulation(scenario: E4DiagnosticScenario): 1 | 100 | 500 | 2000 {
  switch (scenario) {
    case 'ordinary-100':
      return 100;
    case 'ordinary-500':
      return 500;
    case 'maximum':
      return 2000;
    default:
      return 1;
  }
}
export function verifyDiagnosticMigrationSource(
  source = readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20261013000000_activity_contribution_assert_source_reuse/migration.sql',
    ),
  ),
) {
  if (createHash('sha256').update(source).digest('hex') !== E4_DIAGNOSTIC_PLAN.migration143Sha256)
    throw new Error('E4 current143 source pin refused');
}
export async function verifyDiagnosticDatabase(db: Pick<PrismaClient, '$queryRaw'>) {
  const [metadata] = await db.$queryRaw<
    { count: number; checksum: string | null; pin: string; enabled: string }[]
  >`
    SELECT (SELECT count(*)::int FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS count,
      (SELECT checksum FROM _prisma_migrations WHERE migration_name='20261013000000_activity_contribution_assert_source_reuse' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS checksum,
      (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.e4_assert_complete(text,boolean)'::regprocedure) AS pin,
      (SELECT tgenabled::text FROM pg_trigger WHERE tgname='e4_revision_complete_guard') AS enabled
  `;
  expect(metadata).toEqual({
    count: 143,
    checksum: E4_DIAGNOSTIC_PLAN.migration143Sha256,
    pin: E4_DIAGNOSTIC_PLAN.completeFunctionMd5,
    enabled: 'O',
  });
}

async function verifyDiagnosticGuards(db: PrismaClient) {
  const guards = await db.$queryRaw<{ name: string; enabled: string; deferred: boolean }[]>`
    SELECT tgname::text AS name,tgenabled::text AS enabled,tgdeferrable AND tginitdeferred AS deferred
    FROM pg_trigger WHERE
      (tgname='astr_parent_complete_guard' AND tgrelid='public."ActivitySettlementTimeRevision"'::regclass)
      OR (tgname='e4_revision_complete_guard' AND tgrelid='public."ActivitySettlementContributionRevision"'::regclass)
    ORDER BY tgname
  `;
  expect(guards).toEqual([
    { name: 'astr_parent_complete_guard', enabled: 'O', deferred: true },
    { name: 'e4_revision_complete_guard', enabled: 'O', deferred: true },
  ]);
}
const ordinaryOraclePath = resolve(
  __dirname,
  '../e2e/activity-os-r5-e4-contribution-settlement.e2e-spec.ts',
);
export function frozenOrdinaryOracleSource(source = readFileSync(ordinaryOraclePath, 'utf8')) {
  if (
    createHash('sha256').update(source).digest('hex') !==
    '46c31154bfa284f923ab34ca8be651573a8fe3a1f6d6035e1010265371a17e72'
  )
    throw new Error('E4 ordinary frozen oracle source refused');
  const ast = ts.createSourceFile(
    ordinaryOraclePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const names = ['fixedE4RootAggregateSql', 'assertFixedE4RootOracle', 'assertFixedE4Oracle'];
  const functions = ast.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && !!node.name && names.includes(node.name.text),
  );
  if (functions.length !== 3 || new Set(functions.map((node) => node.name!.text)).size !== 3)
    throw new Error('E4 ordinary oracle coverage refused');
  return functions.map((node) => node.getText(ast)).join('\n');
}
function frozenOrdinaryOracle(report: Report) {
  const code = ts.transpileModule(frozenOrdinaryOracleSource(), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return runInNewContext(code + oracleStageWrappers(false) + '\nassertFixedE4Oracle;', {
    Prisma,
    createHash,
    readFileSync,
    resolve,
    __dirname: dirname(ordinaryOraclePath),
    expect,
    oracleStep: (step: string) => {
      report.substage = step;
    },
  }) as (db: PrismaClient, id: string, count: number) => Promise<void>;
}
type PrivateDiagnosticProof = { revisionId: string; sourceKindCode: string; units: number };
const privateDiagnosticProofs = new WeakMap<Report, PrivateDiagnosticProof>();
type CanonicalCostSample = {
  component: 'OLD_FROZEN' | 'CANDIDATE' | 'STORED';
  transactionMs: 30000;
  statementMs: 30000;
  wallMs: number;
  outcome: 'COMPLETE' | 'FAILED';
  rows?: number;
  documentBytes?: number;
  keyBytes?: number;
  error?: ReturnType<typeof e4DiagnosticSafeError>;
};
export function canonicalCostQueries(revisionId: string, sourceKindCode: string) {
  const source = readFileSync(
    resolve(dirname(oraclePath), 'activity-os-r5-e4-contribution-settlement-migration.e2e-spec.ts'),
    'utf8',
  );
  const matches = [
    ...source.matchAll(/const E4_P_CANONICAL_ORACLE_SQL = String\.raw`([\s\S]*?)`;/gu),
  ];
  if (
    matches.length !== 1 ||
    createHash('sha256').update(matches[0][1]).digest('hex') !==
      '1aaf91d632713dddaeb106ad4095ac5650aa65416841f8c865d2fd0020fa465b'
  )
    throw new Error('E4 canonical cost frozen source refused');
  const parts = matches[0][1].split(/\brevision_id\b/u);
  if (parts.length !== 3) throw new Error('E4 canonical cost binding refused');
  const oracle = Prisma.join(
    parts.flatMap((part, index) =>
      index === parts.length - 1
        ? [Prisma.raw(part)]
        : [Prisma.raw(part), Prisma.sql`${revisionId}::text`],
    ),
    '',
  );
  const ast = ts.createSourceFile(
    'fixed-oracle.ts',
    frozenE4OracleSource(),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const templates: ts.TemplateExpression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isTaggedTemplateExpression(node) &&
      ts.isTemplateExpression(node.template) &&
      /WITH\s+oracle\(unit_canonical,evaluation\)\s+AS MATERIALIZED/u.test(node.template.head.text)
    )
      templates.push(node.template);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (templates.length !== 1) throw new Error('E4 canonical full comparison refused');
  const template = templates[0];
  const fullParts: Prisma.Sql[] = [Prisma.raw(template.head.text)];
  for (const span of template.templateSpans) {
    const name = span.expression.getText(ast);
    const binding =
      name === 'oracle'
        ? oracle
        : name === 'revisionId'
          ? Prisma.sql`${revisionId}`
          : name === 'root.sourceKindCode'
            ? Prisma.sql`${sourceKindCode}`
            : undefined;
    if (!binding) throw new Error('E4 canonical full comparison binding refused');
    fullParts.push(binding, Prisma.raw(span.literal.text));
  }
  const stats = (input: Prisma.Sql) => Prisma.sql`
    WITH docs(unit_canonical,evaluation) AS MATERIALIZED (${input})
    SELECT count(*)::int AS rows,coalesce(sum(pg_column_size(evaluation)),0)::text AS "documentBytes",
      coalesce(sum(octet_length(unit_canonical)),0)::text AS "keyBytes" FROM docs
  `;
  return {
    old: stats(oracle),
    candidate: stats(Prisma.sql`SELECT * FROM public.e4_expected_evaluations(${revisionId}::text)`),
    stored: stats(
      Prisma.sql`SELECT e."evaluationUnitKey",public.e4_evaluation_document(e) FROM "ParticipantContributionEvaluation" e WHERE e."contributionRevisionId"=${revisionId}`,
    ),
    comparison: Prisma.join(fullParts, ''),
  };
}
export function compactCanonicalCostPlan(value: unknown) {
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== 'object')
    throw new Error('E4 canonical estimate refused');
  const root: unknown = Reflect.get(value[0], 'Plan');
  const nodes: {
    type: string;
    rows: number | null;
    width: number | null;
    totalCost: number | null;
    cte?: string;
  }[] = [];
  const kinds = [
    'Aggregate',
    'Result',
    'Function Scan',
    'CTE Scan',
    'Seq Scan',
    'Index Scan',
    'Index Only Scan',
    'Bitmap Heap Scan',
    'Bitmap Index Scan',
    'Hash',
    'Hash Join',
    'Merge Join',
    'Nested Loop',
    'Sort',
    'Materialize',
    'Append',
    'Subquery Scan',
    'Limit',
  ];
  const number = (row: object, field: string) => {
    const x: unknown = Reflect.get(row, field);
    return typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null;
  };
  const visit = (row: unknown) => {
    if (!row || typeof row !== 'object' || nodes.length >= 64)
      throw new Error('E4 canonical estimate limit');
    const type: unknown = Reflect.get(row, 'Node Type');
    const cteName: unknown = Reflect.get(row, 'CTE Name');
    const subplanName: unknown = Reflect.get(row, 'Subplan Name');
    const cte =
      typeof cteName === 'string'
        ? cteName
        : typeof subplanName === 'string' && subplanName.startsWith('CTE ')
          ? subplanName.slice(4)
          : undefined;
    nodes.push({
      type: typeof type === 'string' && kinds.includes(type) ? type : 'OTHER',
      rows: number(row, 'Plan Rows'),
      width: number(row, 'Plan Width'),
      totalCost: number(row, 'Total Cost'),
      ...([
        'oracle',
        'candidate',
        'stored',
        'summary',
        'sources',
        'groups',
        'policy_bands',
      ].includes(cte ?? '')
        ? { cte }
        : {}),
    });
    const children: unknown = Reflect.get(row, 'Plans');
    if (children !== undefined) {
      if (!Array.isArray(children)) throw new Error('E4 canonical estimate children refused');
      children.forEach(visit);
    }
  };
  visit(root);
  return {
    mode: 'ESTIMATED_ONLY_NO_ANALYZE',
    costUnits: 'OPTIMIZER_UNITS_NOT_MILLISECONDS',
    nodes,
  };
}
export const CANONICAL_JIT_ORDER = [
  ['ON_OFF', 'on'],
  ['ON_OFF', 'off'],
  ['OFF_ON', 'off'],
  ['OFF_ON', 'on'],
] as const;
type CanonicalComparison = {
  oldCount: number;
  candidateCount: number;
  storedCount: number;
  candidateDifferences: number;
  storedDifferences: number;
  rootMatches: boolean;
};
type CanonicalJitSample = {
  order: 'ON_OFF' | 'OFF_ON';
  jit: 'on' | 'off';
  transactionMs: 30000;
  statementMs: 30000;
  wallMs: number;
  outcome: 'COMPLETE' | 'FAILED';
  sameBackend?: boolean;
  comparison?: CanonicalComparison;
  error?: ReturnType<typeof e4DiagnosticSafeError>;
};
export function assertCanonicalComparison(value: unknown, units: number) {
  expect(value).toEqual({
    oldCount: units,
    candidateCount: units,
    storedCount: units,
    candidateDifferences: 0,
    storedDifferences: 0,
    rootMatches: true,
  });
}
export function compactCanonicalActualPlan(value: unknown, operatorDetail = false) {
  const estimated = compactCanonicalCostPlan(value);
  const document = (value as Record<string, unknown>[])[0];
  const number = (row: Record<string, unknown>, key: string) => {
    const x = row[key];
    return typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null;
  };
  const root = document.Plan as Record<string, unknown>;
  const selected: {
    type: string;
    cte?: string;
    estimatedRows: number | null;
    actualRows: number | null;
    loops: number | null;
    tempRead: number | null;
    tempWritten: number | null;
    sortMethod?: string;
    sortSpaceType?: string;
    sortSpace?: number | null;
    peakMemory?: number | null;
    hashBatches?: number | null;
  }[] = [];
  let seen = 0;
  const visit = (row: Record<string, unknown>) => {
    const node = estimated.nodes[seen++];
    if (
      selected.length < (operatorDetail ? 32 : 12) &&
      (node.cte === 'policy_bands' ||
        node.type === 'Hash Join' ||
        node.type === 'Merge Join' ||
        node.type === 'Function Scan' ||
        (operatorDetail &&
          ['Sort', 'Materialize', 'Hash', 'Aggregate', 'CTE Scan'].includes(node.type)))
    )
      selected.push({
        type: node.type,
        ...(node.cte ? { cte: node.cte } : {}),
        estimatedRows: node.rows,
        actualRows: number(row, 'Actual Rows'),
        loops: number(row, 'Actual Loops'),
        tempRead: number(row, 'Temp Read Blocks'),
        tempWritten: number(row, 'Temp Written Blocks'),
        ...(operatorDetail
          ? {
              sortMethod: [
                'quicksort',
                'top-N heapsort',
                'external merge',
                'external sort',
                'heapsort',
              ].includes(String(row['Sort Method']))
                ? String(row['Sort Method'])
                : 'OTHER',
              sortSpaceType: ['Memory', 'Disk'].includes(String(row['Sort Space Type']))
                ? String(row['Sort Space Type'])
                : 'OTHER',
              sortSpace: number(row, 'Sort Space Used'),
              peakMemory: number(row, 'Peak Memory Usage'),
              hashBatches: number(row, 'Hash Batches'),
            }
          : {}),
      });
    const children = row.Plans as Record<string, unknown>[] | undefined;
    children?.forEach(visit);
  };
  visit(root);
  const jit =
    document.JIT && typeof document.JIT === 'object'
      ? (document.JIT as Record<string, unknown>)
      : null;
  const timing =
    jit?.Timing && typeof jit.Timing === 'object' ? (jit.Timing as Record<string, unknown>) : null;
  return {
    mode: 'ACTUAL_ANALYZE_BUFFERS_TIMING_OFF',
    executionMs: number(document, 'Execution Time'),
    planningMs: number(document, 'Planning Time'),
    rootTempRead: number(root, 'Temp Read Blocks'),
    rootTempWritten: number(root, 'Temp Written Blocks'),
    jit: jit
      ? { functions: number(jit, 'Functions'), totalMs: timing ? number(timing, 'Total') : null }
      : null,
    selected,
  };
}

/** Identify the actual SPI statement by pinned source bytes; never execute an extracted query. */
export function joinKeyCandidateSource() {
  verifyDiagnosticMigrationSource();
  const original = readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20261013000000_activity_contribution_assert_source_reuse/migration.sql',
    ),
    'utf8',
  );
  const edits = [
    [
      'expected_documents(unit_canonical,evaluation) AS NOT MATERIALIZED',
      'expected_documents(unit_canonical,evaluation_key,evaluation) AS NOT MATERIALIZED',
    ],
    [
      "SELECT unit,metadata || jsonb_build_object('sourceRefsJson'",
      "SELECT unit,metadata->>'evaluationUnitKey',metadata || jsonb_build_object('sourceRefsJson'",
    ],
    [
      "SELECT evaluation->>'evaluationUnitKey' AS key,evaluation",
      'SELECT evaluation_key AS key,evaluation',
    ],
  ];
  let candidate = original;
  for (const [before, after] of edits) {
    if (candidate.split(before).length !== 2) throw new Error('E4 join key unique edit refused');
    candidate = candidate.replace(before, after);
  }
  let restored = candidate;
  for (const [before, after] of [...edits].reverse()) restored = restored.replace(after, before);
  if (restored !== original) throw new Error('E4 join key reverse edit refused');
  return candidate;
}

// These nineteen keys are emitted unconditionally by the pinned documents CTE.
// sourceRefsJson is the twentieth field, already canonicalized by the source grouping.
export const E4_METADATA_FIELDS = Object.freeze([
  'attendanceRoleCode',
  'beijingDayPointsJson',
  'calculatedPoints',
  'definitionHash',
  'durationSeconds',
  'evaluationUnitKey',
  'evaluatorVersion',
  'explanationCode',
  'memberId',
  'mode',
  'participationIdentityId',
  'policyId',
  'policyVersionId',
  'recognizedPoints',
  'ruleSnapshotId',
  'selectionItemId',
  'sessionId',
  'sourceFingerprint',
  'timeCategoryCode',
]);
export const E4_METADATA_CASE_DIGEST =
  'cc6bdc63188e6990288063b06c8dd74459383240b3a20f835379c856f66c4203';
export const E4_FIXED_METADATA_CANDIDATE = Object.freeze({
  sourceHead: '20cbaf6d22429db19a1378d2c4bbf39889162f60',
  sqlSha256: '6962099f42c34335708c065423fb982f81bcfe110f05125b91089ecb426ce78f',
});
const metadataReferenceExpression = `(SELECT '{' || string_agg(to_jsonb(field_name)::TEXT || ':' || field_canonical,',' ORDER BY field_name COLLATE "C") || '}'
     FROM (
       SELECT key AS field_name,
          CASE WHEN jsonb_typeof(value) IN ('object','array') THEN astr_canonical_json(value)
            ELSE value::TEXT END AS field_canonical FROM jsonb_each(metadata)
       UNION ALL SELECT 'sourceRefsJson',refs_canonical
     ) field)`;

/** Preserve JSONB's own scalar spelling/escaping and the original recursive nested algorithm. */
export function metadataCanonicalExpression() {
  const fields = [...E4_METADATA_FIELDS, 'sourceRefsJson'].sort();
  return (
    "'{' || " +
    fields
      .map((key, index) => {
        const value =
          key === 'sourceRefsJson'
            ? 'refs_canonical'
            : key === 'beijingDayPointsJson'
              ? `CASE WHEN jsonb_typeof(metadata->'${key}') IN ('object','array')
                  THEN astr_canonical_json(metadata->'${key}') ELSE (metadata->'${key}')::TEXT END`
              : `(metadata->'${key}')::TEXT`;
        return `'${index === 0 ? '' : ','}"${key}":' || ${value}`;
      })
      .join(' ||\n    ') +
    " || '}'"
  );
}

/** Additional diagnostic edit only; both original complete guard invocations remain intact. */
export function metadataCanonicalCandidateSource() {
  const source = joinKeyCandidateSource();
  if (source.split(metadataReferenceExpression).length !== 2)
    throw new Error('E4 metadata canonical unique edit refused');
  const candidate = source.replace(metadataReferenceExpression, metadataCanonicalExpression());
  if (candidate.replace(metadataCanonicalExpression(), metadataReferenceExpression) !== source)
    throw new Error('E4 metadata canonical reverse edit refused');
  if (
    createHash('sha256').update(candidate).digest('hex') !== E4_FIXED_METADATA_CANDIDATE.sqlSha256
  )
    throw new Error('E4 fixed metadata20cbaf6d SQL identity refused');
  return candidate;
}

function metadataReferenceFunction(name: 'astr_canonical_json' | 'e4_day_points') {
  const path =
    name === 'astr_canonical_json'
      ? '../../prisma/migrations/20260913090000_activity_os_r4_d4_time_bucket_settlement/migration.sql'
      : '../../prisma/migrations/20261003000000_activity_contribution_settlement/migration.sql';
  const source = readFileSync(resolve(__dirname, path), 'utf8');
  const match = source.match(
    new RegExp(`CREATE FUNCTION ${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`, 'u'),
  );
  const expected =
    name === 'astr_canonical_json'
      ? '9f9bf45e972f24970c7000f317dfaf54089b33485ca6e003344f69e5a9aa187a'
      : '99aaa9c49322dc5ed58397001894b1ea189304974ba1dd29c4baec86d1635fe3';
  if (!match || createHash('sha256').update(match[0]).digest('hex') !== expected)
    throw new Error('E4 metadata reference function source refused');
  return { sql: match[0], bodyMd5: createHash('md5').update(match[1]).digest('hex') };
}

function metadataCurrentCanonicalFunction() {
  const source = readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20261012040000_activity_canonical_json_unit_fast_path/migration.sql',
    ),
    'utf8',
  );
  const match = source.match(
    /CREATE OR REPLACE FUNCTION astr_canonical_json\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/u,
  );
  if (
    !match ||
    createHash('sha256').update(match[0]).digest('hex') !==
      '614106b916b033ef2f6488ebef3735fed70024e14ae4e49f2e005d48cdbfd108'
  )
    throw new Error('E4 metadata current canonical source refused');
  return { sql: match[0], bodyMd5: createHash('md5').update(match[1]).digest('hex') };
}

function metadataLiteral(value: string) {
  return "'" + value.replaceAll("'", "''") + "'";
}

/** Synthetic inputs exercise serialization; they never become business rows. */
export function metadataCanonicalCases() {
  const base = Object.fromEntries(E4_METADATA_FIELDS.map((key) => [key, `${key}_value`])) as Record<
    string,
    unknown
  >;
  Object.assign(base, {
    durationSeconds: 1800,
    evaluatorVersion: 1,
    calculatedPoints: '1.01',
    recognizedPoints: '1.01',
    beijingDayPointsJson: [{ ledgerDate: '2026-01-01', recognizedPoints: '1.01' }],
  });
  const cases = [
    {
      label: 'ordinary',
      metadata: JSON.stringify(base),
      refs: '[]',
      dayRefs: null as string | null,
    },
  ];
  const add = (label: string, patch: Record<string, unknown>, refs = '[]') =>
    cases.push({ label, metadata: JSON.stringify({ ...base, ...patch }), refs, dayRefs: null });
  for (const key of E4_METADATA_FIELDS) add(`null_${key}`, { [key]: null });
  for (const [label, value] of [
    ['escaping', 'quote" backslash\\ slash/ tab\t line\n return\r back\b form\f apostrophe\''],
    ['unicode', '中文😀é e\u0301 \u2028\u2029'],
    ['empty', ''],
    ['json_words', 'null true false -0 1.00'],
  ])
    add(
      label,
      Object.fromEntries(
        E4_METADATA_FIELDS.filter((key) => typeof base[key] === 'string').map((key) => [
          key,
          value,
        ]),
      ),
    );
  add('nested_day_points', {
    beijingDayPointsJson: [
      {
        z: ['中文', null, true, { a: '\\"\n', b: -1.25 }],
        ledgerDate: '2026-01-01',
        recognizedPoints: '0.00',
      },
    ],
  });
  add('empty_day_points', { beijingDayPointsJson: [] });
  add('nested_sources', {}, '[{"z":[null,true,1.2500,{"中文":"😀\\n\\""}],"a":"\\\\"}]');
  for (const [label, numbers] of [
    [
      'zero',
      '{"durationSeconds":0,"evaluatorVersion":0,"recognizedPoints":"0.00","calculatedPoints":"0.00"}',
    ],
    [
      'integer_max',
      '{"durationSeconds":2147483647,"evaluatorVersion":1,"recognizedPoints":"999.99","calculatedPoints":"999.99"}',
    ],
    ['numeric_spelling', '{"durationSeconds":7.1200,"evaluatorVersion":-0.00}'],
    [
      'numeric_precision',
      '{"durationSeconds":123456789012345678901234567890.123456789,"evaluatorVersion":1e3}',
    ],
  ])
    cases.push({
      label,
      metadata: JSON.stringify(base).slice(0, -1) + ',' + numbers.slice(1),
      refs: '[]',
      dayRefs: null,
    });
  for (const [label, startsAt, endsAt] of [
    ['before_beijing_midnight', '2026-01-01T15:59:59.999Z', '2026-01-01T16:00:00.000Z'],
    ['at_beijing_midnight', '2026-01-01T16:00:00.000Z', '2026-01-01T16:00:00.001Z'],
    ['straddle_beijing_midnight', '2026-01-01T15:59:59.999Z', '2026-01-01T16:00:00.001Z'],
    ['utc_midnight', '2026-01-01T23:59:00.000Z', '2026-01-02T00:01:00.000Z'],
    ['year_boundary', '2025-12-31T15:59:00.000Z', '2025-12-31T16:01:00.000Z'],
    ['leap_day', '2024-02-29T15:59:00.000Z', '2024-02-29T16:01:00.000Z'],
  ]) {
    const refs = JSON.stringify([{ durationSeconds: 2, startsAt, endsAt }]);
    cases.push({ label, metadata: JSON.stringify(base), refs, dayRefs: refs });
  }
  return cases;
}

/** Small standalone PostgreSQL proof, or the same proof against the fixture's real public helpers. */
export function metadataCanonicalEquivalenceSql(publicHelpers = false) {
  const historical = metadataReferenceFunction('astr_canonical_json');
  const canonical = metadataCurrentCanonicalFunction();
  const day = metadataReferenceFunction('e4_day_points');
  const cases = metadataCanonicalCases();
  const qualify = (sql: string) =>
    publicHelpers
      ? sql.replaceAll('astr_canonical_json(', 'public.astr_canonical_json(')
      : sql.replaceAll('astr_canonical_json(', 'pg_temp.e4_metadata_current(');
  const rows = cases.map(({ label, metadata, refs, dayRefs }) => {
    const value =
      dayRefs === null
        ? `${metadataLiteral(metadata)}::JSONB`
        : `${metadataLiteral(metadata)}::JSONB || jsonb_build_object('beijingDayPointsJson',${publicHelpers ? 'public.e4_day_points' : 'pg_temp.e4_metadata_day_points'}(${metadataLiteral(dayRefs)}::JSONB,101))`;
    return `(${metadataLiteral(label)},${value},${qualify(`astr_canonical_json(${metadataLiteral(refs)}::JSONB)`)})`;
  });
  const setup = publicHelpers
    ? `BEGIN READ ONLY;
DO $$ DECLARE canonical_body TEXT; day_body TEXT; BEGIN
 SELECT md5(prosrc) INTO STRICT canonical_body FROM pg_proc WHERE oid='public.astr_canonical_json(jsonb)'::regprocedure;
 SELECT md5(prosrc) INTO STRICT day_body FROM pg_proc WHERE oid='public.e4_day_points(jsonb,integer)'::regprocedure;
 RAISE NOTICE 'E4_JOIN_KEY_METADATA_HELPERS %',json_build_object('canonicalBodyMd5',canonical_body,'dayBodyMd5',day_body);
 IF canonical_body<>'${canonical.bodyMd5}' OR day_body<>'${day.bodyMd5}'
 THEN RAISE EXCEPTION 'E4 metadata public helper pin refused'; END IF;
END $$;`
    : `BEGIN;
CREATE TEMP TABLE e4_metadata_scope_marker(value INTEGER);
${historical.sql.replace('CREATE FUNCTION astr_canonical_json(', 'CREATE FUNCTION pg_temp.e4_metadata_canonical(').replaceAll('astr_canonical_json(item)', 'pg_temp.e4_metadata_canonical(item)')}
${canonical.sql.replace('CREATE OR REPLACE FUNCTION astr_canonical_json(', 'CREATE FUNCTION pg_temp.e4_metadata_current(').replaceAll('astr_canonical_json(item)', 'pg_temp.e4_metadata_current(item)')}
${day.sql.replace('CREATE FUNCTION e4_day_points(', 'CREATE FUNCTION pg_temp.e4_metadata_day_points(')}`;
  return `${setup}
SET LOCAL statement_timeout='5s';
SET LOCAL search_path=pg_catalog,public;
DO $$ DECLARE r RECORD; seen INTEGER:=0; digest TEXT:=''; BEGIN
 IF current_setting('server_version_num')::INTEGER NOT BETWEEN 160000 AND 169999
 THEN RAISE EXCEPTION 'E4 metadata PostgreSQL16 refused'; END IF;
 FOR r IN WITH documents(label,metadata,refs_canonical) AS (VALUES ${rows.join(',\n')})
 SELECT label,${qualify(metadataReferenceExpression)} AS original,${qualify(metadataCanonicalExpression())} AS candidate,
 ${publicHelpers ? qualify(metadataReferenceExpression) : metadataReferenceExpression.replaceAll('astr_canonical_json(', 'pg_temp.e4_metadata_canonical(')} AS historical FROM documents ORDER BY label COLLATE "C"
 LOOP
   IF convert_to(r.original,'UTF8') IS DISTINCT FROM convert_to(r.historical,'UTF8')
     OR convert_to(r.original,'UTF8') IS DISTINCT FROM convert_to(r.candidate,'UTF8')
     OR sha256(convert_to('{"definition":'||r.original||',"schemaVersion":1}','UTF8')) IS DISTINCT FROM sha256(convert_to('{"definition":'||r.candidate||',"schemaVersion":1}','UTF8'))
   THEN RAISE NOTICE 'E4_JOIN_KEY_METADATA_MISMATCH %',json_build_object('case',r.label,'originalBytes',octet_length(r.original),'candidateBytes',octet_length(r.candidate));
     RAISE EXCEPTION 'E4 metadata byte/hash mismatch' USING ERRCODE='23514'; END IF;
   seen:=seen+1;
   digest:=digest||r.label||':'||encode(sha256(convert_to(r.original,'UTF8')),'hex')||';';
 END LOOP;
 IF seen<>${cases.length} THEN RAISE EXCEPTION 'E4 metadata case count refused'; END IF;
 RAISE NOTICE 'E4_JOIN_KEY_METADATA_EQUIVALENCE %',json_build_object('cases',seen,'bytesEqual',true,'hashesEqual',true,'publicHelpers',${publicHelpers},
   'caseDigest',encode(sha256(convert_to(digest,'UTF8')),'hex'),'candidateSha256','${createHash('sha256').update(metadataCanonicalCandidateSource()).digest('hex')}',
   'canonicalBodyMd5','${canonical.bodyMd5}','historicalCanonicalBodyMd5','${historical.bodyMd5}','dayBodyMd5','${day.bodyMd5}');
END $$;
ROLLBACK;
`;
}

export function compactMetadataCanonicalEvidence(raw: string, publicHelpers: boolean) {
  const notices = [
    ...joinKeyDiagnosticNotices(raw).matchAll(
      /NOTICE:\s+E4_JOIN_KEY_METADATA_EQUIVALENCE (\{[^\n]+\})/gu,
    ),
  ];
  if (notices.length !== 1) throw new Error('E4 metadata equivalence evidence refused');
  const value = JSON.parse(notices[0][1]) as Record<string, unknown>;
  if (
    value.cases !== metadataCanonicalCases().length ||
    value.bytesEqual !== true ||
    value.hashesEqual !== true ||
    value.publicHelpers !== publicHelpers ||
    value.candidateSha256 !==
      createHash('sha256').update(metadataCanonicalCandidateSource()).digest('hex') ||
    value.canonicalBodyMd5 !== metadataCurrentCanonicalFunction().bodyMd5 ||
    value.historicalCanonicalBodyMd5 !== metadataReferenceFunction('astr_canonical_json').bodyMd5 ||
    value.dayBodyMd5 !== metadataReferenceFunction('e4_day_points').bodyMd5 ||
    value.caseDigest !== E4_METADATA_CASE_DIGEST
  )
    throw new Error('E4 metadata equivalence binding refused');
  return {
    cases: value.cases,
    bytesEqual: true,
    hashesEqual: true,
    publicHelpers,
    caseDigest: value.caseDigest,
    candidateSha256: value.candidateSha256,
    canonicalBodyMd5: value.canonicalBodyMd5,
    historicalCanonicalBodyMd5: value.historicalCanonicalBodyMd5,
    dayBodyMd5: value.dayBodyMd5,
  };
}

function runMetadataCanonicalEquivalence() {
  const proc = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      'u-nest-api-postgres',
      'psql',
      '-X',
      '-q',
      '-A',
      '-t',
      '-v',
      'ON_ERROR_STOP=1',
      '-v',
      'VERBOSITY=verbose',
      '-U',
      'postgres',
      '-d',
      'postgres',
    ],
    {
      input: `DO $$ BEGIN IF current_database()<>'postgres' THEN RAISE EXCEPTION 'E4 metadata standalone scope refused'; END IF; END $$;\n${metadataCanonicalEquivalenceSql()}`,
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 65536,
    },
  );
  if (proc.error || proc.signal || proc.status !== 0) {
    const mismatch = joinKeyDiagnosticNotices(proc.stderr ?? '').match(
      /NOTICE:\s+E4_JOIN_KEY_METADATA_MISMATCH (\{[^\n]+\})/u,
    );
    if (mismatch) console.error('E4_METADATA_MISMATCH ' + mismatch[1]);
    throw new Error('E4 metadata standalone process failed');
  }
  console.info(
    'E4_METADATA_EQUIVALENCE ' +
      JSON.stringify(compactMetadataCanonicalEvidence(proc.stderr, false)),
  );
}

/** Retain closed failure location/identity even when no positive control has completed. */
export function compactMetadataProgress(raw: string) {
  const progress: {
    helperIdentity: { canonicalBodyMd5: string; dayBodyMd5: string } | null;
    lastPriority: { kind: string; variant: string } | null;
    unexpected: { sqlstate: string; constraintMatches: boolean; messageMatches: boolean } | null;
  } = { helperIdentity: null, lastPriority: null, unexpected: null };
  raw = joinKeyDiagnosticNotices(raw);
  try {
    const match = raw.match(/NOTICE:\s+E4_JOIN_KEY_METADATA_HELPERS (\{[^\n]+\})/u);
    const identity = match ? (JSON.parse(match[1]) as Record<string, unknown>) : null;
    if (
      identity &&
      typeof identity.canonicalBodyMd5 === 'string' &&
      /^[a-f0-9]{32}$/u.test(identity.canonicalBodyMd5) &&
      typeof identity.dayBodyMd5 === 'string' &&
      /^[a-f0-9]{32}$/u.test(identity.dayBodyMd5)
    )
      progress.helperIdentity = {
        canonicalBodyMd5: identity.canonicalBodyMd5,
        dayBodyMd5: identity.dayBodyMd5,
      };
    const priority = [
      ...raw.matchAll(
        /NOTICE:\s+E4_JOIN_KEY_METADATA_PRIORITY_BEGIN (SOURCE_EVALUATION_ROOT|EVALUATION_ROOT|ROOT) (BASELINE|CANDIDATE)/gu,
      ),
    ].at(-1);
    if (priority) progress.lastPriority = { kind: priority[1], variant: priority[2] };
    const failure = raw.match(/NOTICE:\s+E4_JOIN_KEY_METADATA_PRIORITY_UNEXPECTED (\{[^\n]+\})/u);
    const value = failure ? (JSON.parse(failure[1]) as Record<string, unknown>) : null;
    if (
      value &&
      typeof value.sqlstate === 'string' &&
      /^[A-Z0-9]{5}$/u.test(value.sqlstate) &&
      typeof value.constraintMatches === 'boolean' &&
      typeof value.messageMatches === 'boolean'
    )
      progress.unexpected = {
        sqlstate: value.sqlstate,
        constraintMatches: value.constraintMatches,
        messageMatches: value.messageMatches,
      };
  } catch {
    /* Unparseable metadata remains unknown; backend cleanup must still run. */
  }
  return progress;
}

export function sharedGuardStatement(variant: 'BASELINE' | 'CANDIDATE' = 'BASELINE') {
  if (!['BASELINE', 'CANDIDATE'].includes(variant)) throw new Error('E4 guard variant refused');
  verifyDiagnosticMigrationSource();
  const source =
    variant === 'CANDIDATE'
      ? joinKeyCandidateSource()
      : readFileSync(
          resolve(
            __dirname,
            '../../prisma/migrations/20261013000000_activity_contribution_assert_source_reuse/migration.sql',
          ),
          'utf8',
        );
  const matches = [
    ...source.matchAll(
      /WITH assertion_sources AS MATERIALIZED \([\s\S]*?FROM source_status status;/gu,
    ),
  ];
  if (matches.length !== 1) throw new Error('E4 shared guard statement refused');
  return matches[0][0];
}

/** Closed metadata only: no query text, parameters, expressions, fixture identifiers or raw notices. */
export function compactSharedGuardNotice(
  raw: string,
  variant: 'BASELINE' | 'CANDIDATE' = 'BASELINE',
) {
  if (Buffer.byteLength(raw) > 2097152) throw new Error('E4 shared guard capture limit');
  const normalize = (sql: string) =>
    sql
      .replace(/INTO source_invalid,evaluation_mismatch/gu, '')
      .replace(/\s+/gu, ' ')
      .trim()
      .replace(/;$/u, '');
  const expected = normalize(sharedGuardStatement(variant));
  const found: { durationMs: number; document: Record<string, unknown> }[] = [];
  let notices = 0;
  for (const match of raw.matchAll(/NOTICE:\s+duration:\s+([0-9.]+) ms\s+plan:\s*\n/gu)) {
    if (++notices > 16) throw new Error('E4 shared guard notice count');
    const start = match.index + match[0].length;
    let depth = 0,
      quoted = false,
      escaped = false,
      end = start;
    if (raw[start] !== '{') throw new Error('E4 shared guard JSON refused');
    for (; end < raw.length; end++) {
      const char = raw[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) break;
    }
    if (depth || quoted || end === raw.length) throw new Error('E4 shared guard incomplete JSON');
    const document: unknown = JSON.parse(raw.slice(start, end + 1));
    if (!document || typeof document !== 'object')
      throw new Error('E4 shared guard document refused');
    const query: unknown = Reflect.get(document, 'Query Text');
    if (typeof query === 'string' && normalize(query) === expected)
      found.push({ durationMs: +match[1], document: document as Record<string, unknown> });
  }
  if (found.length !== 1) throw new Error('E4 shared guard actual statement missing or repeated');
  const { durationMs, document } = found[0];
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 30000)
    throw new Error('E4 shared guard duration refused');
  const number = (row: object, field: string) => {
    const value: unknown = Reflect.get(row, field);
    if (value === undefined) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e15)
      throw new Error('E4 shared guard metric refused');
    return value;
  };
  const kinds = [
    'Aggregate',
    'Result',
    'Function Scan',
    'CTE Scan',
    'Seq Scan',
    'Index Scan',
    'Index Only Scan',
    'Bitmap Heap Scan',
    'Bitmap Index Scan',
    'Hash',
    'Hash Join',
    'Merge Join',
    'Nested Loop',
    'Sort',
    'Materialize',
    'Append',
    'Subquery Scan',
    'Limit',
  ];
  const ctes = [
    'assertion_sources',
    'source_status',
    'revision_domain',
    'sources',
    'groups',
    'policy_bands',
    'selected',
    'documents',
    'canonical_documents',
    'expected_documents',
    'expected',
    'actual',
    'pairs',
  ];
  const tables = [
    'ParticipantContributionEvaluation',
    'ContributionPolicyVersion',
    'ActivitySettlementContributionRevision',
  ];
  const nodes: Record<string, unknown>[] = [];
  const visit = (value: unknown, parent: number | null, depth: number) => {
    if (!value || typeof value !== 'object' || nodes.length >= 160 || depth > 32)
      throw new Error('E4 shared guard node limit');
    const id = nodes.length;
    const type: unknown = Reflect.get(value, 'Node Type');
    const cteName: unknown = Reflect.get(value, 'CTE Name');
    const subplanName: unknown = Reflect.get(value, 'Subplan Name');
    const cte =
      typeof cteName === 'string'
        ? cteName
        : typeof subplanName === 'string' && subplanName.startsWith('CTE ')
          ? subplanName.slice(4)
          : null;
    const table: unknown = Reflect.get(value, 'Relation Name');
    const functionName: unknown = Reflect.get(value, 'Function Name');
    const subplan = typeof subplanName === 'string' ? subplanName.match(/^SubPlan (\d+)$/u) : null;
    const loops = number(value, 'Actual Loops');
    const totalMs = number(value, 'Actual Total Time');
    const rows = number(value, 'Actual Rows');
    if (loops === null || rows === null || totalMs === null)
      throw new Error('E4 shared guard actual timing missing');
    nodes.push({
      id,
      parent,
      type: typeof type === 'string' && kinds.includes(type) ? type : 'OTHER',
      ...(ctes.includes(String(cte)) ? { cte } : {}),
      ...(typeof table === 'string' && tables.includes(table) ? { table } : {}),
      ...(typeof functionName === 'string' &&
      ['e4_source_rows', 'jsonb_each', 'jsonb_array_elements'].includes(functionName)
        ? { function: functionName }
        : {}),
      ...(subplan && +subplan[1] <= 160 ? { subplan: +subplan[1] } : {}),
      estimatedRows: number(value, 'Plan Rows'),
      width: number(value, 'Plan Width'),
      rows,
      loops,
      startupMs: number(value, 'Actual Startup Time'),
      totalMs,
      tempRead: number(value, 'Temp Read Blocks'),
      tempWritten: number(value, 'Temp Written Blocks'),
      ...(Reflect.has(value, 'Sort Method')
        ? {
            sort: [
              'quicksort',
              'top-N heapsort',
              'external merge',
              'external sort',
              'heapsort',
            ].includes(String(Reflect.get(value, 'Sort Method')))
              ? Reflect.get(value, 'Sort Method')
              : 'OTHER',
            sortSpace: ['Memory', 'Disk'].includes(String(Reflect.get(value, 'Sort Space Type')))
              ? Reflect.get(value, 'Sort Space Type')
              : 'OTHER',
            sortKb: number(value, 'Sort Space Used'),
          }
        : {}),
      ...(Reflect.has(value, 'Hash Batches')
        ? {
            hashBatches: number(value, 'Hash Batches'),
            peakMemoryKb: number(value, 'Peak Memory Usage'),
          }
        : {}),
    });
    const children: unknown = Reflect.get(value, 'Plans');
    if (children !== undefined) {
      if (!Array.isArray(children)) throw new Error('E4 shared guard children refused');
      for (const child of children) visit(child, id, depth + 1);
    }
  };
  visit(document.Plan, null, 0);
  if (
    !nodes.some(
      (node) => node.cte === 'assertion_sources' && node.rows === 50000 && node.loops === 1,
    ) ||
    !nodes.some((node) => node.cte === 'groups' && node.rows === 8000 && node.loops === 1) ||
    !nodes.some((node) => node.cte === 'pairs' && node.rows === 8000 && node.loops === 1)
  )
    throw new Error('E4 shared guard full dataset refused');
  const jit: unknown = document.JIT;
  const timing: unknown = jit && typeof jit === 'object' ? Reflect.get(jit, 'Timing') : undefined;
  return {
    status: 'OBSERVED',
    mode:
      variant === 'BASELINE'
        ? 'ACTUAL_PRODUCTION_FUNCTION_NESTED_STATEMENT'
        : 'ACTUAL_TEMP_CANDIDATE_FUNCTION_NESTED_STATEMENT',
    purpose: 'READ_ONLY_POST_PREPARE_NOT_ACCEPTANCE',
    statementSha256: createHash('sha256').update(expected).digest('hex'),
    durationMs,
    timing: 'NODE_AVERAGES_PER_LOOP_INCLUSIVE_DO_NOT_SUM',
    instrumentation: 'ANALYZE_BUFFERS_TIMING_ON_OVERHEAD',
    jitMs: timing && typeof timing === 'object' ? number(timing, 'Total') : null,
    nodes,
  };
}

/** One owned psql backend, one actual production function call, local settings and unconditional disconnect. */
export function sharedGuardProbeSql(revisionId: string, databaseName: string) {
  if (databaseName !== 'app_test_w98' || !/^[A-Za-z0-9_-]{1,160}$/u.test(revisionId))
    throw new Error('E4 shared guard probe scope refused');
  return `BEGIN READ ONLY;
SET LOCAL statement_timeout='30s';
SET LOCAL idle_in_transaction_session_timeout='30s';
SET LOCAL plan_cache_mode='force_custom_plan';
LOAD 'auto_explain';
DO $$ BEGIN
 IF current_database()<>'app_test_w98' OR current_setting('transaction_read_only')<>'on'
   OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.e4_assert_complete(text,boolean)'::regprocedure)<>'ade4d2af9aa0baf8400a79fc6b62c797'
 THEN RAISE EXCEPTION 'E4 shared guard connected scope refused'; END IF;
END $$;
SELECT 'E4_GUARD_META ' || json_build_object('database',current_database(),'readonly',current_setting('transaction_read_only')='on',
 'bodyMd5',(SELECT md5(prosrc) FROM pg_proc WHERE oid='public.e4_assert_complete(text,boolean)'::regprocedure),
 'kind',(SELECT "kindCode" FROM "ActivitySettlementContributionRevision" WHERE id=:'root_id'),
 'units',(SELECT count(*) FROM "ParticipantContributionEvaluation" WHERE "contributionRevisionId"=:'root_id'),
 'refs',(SELECT sum(jsonb_array_length("sourceRefsJson")) FROM "ParticipantContributionEvaluation" WHERE "contributionRevisionId"=:'root_id'),
 'workMemKb',pg_size_bytes(current_setting('work_mem'))/1024,'jitEnabled',current_setting('jit')='on',
 'planCacheMode',current_setting('plan_cache_mode'))::text;
SET LOCAL client_min_messages='notice';
SET LOCAL auto_explain.log_level='notice';
SET LOCAL auto_explain.log_min_duration='1000ms';
SET LOCAL auto_explain.log_nested_statements=on;
SET LOCAL auto_explain.log_analyze=on;
SET LOCAL auto_explain.log_timing=on;
SET LOCAL auto_explain.log_buffers=on;
SET LOCAL auto_explain.log_format='json';
SET LOCAL auto_explain.log_parameter_max_length=0;
SET LOCAL auto_explain.sample_rate=1;
SELECT public.e4_assert_complete(:'root_id',FALSE);
SET LOCAL auto_explain.log_min_duration=-1;
ROLLBACK;
SELECT 'E4_GUARD_COMPLETE';
`;
}

async function probeSharedGuard(db: PrismaClient, report: Report) {
  report.internal = { status: 'UNKNOWN', reason: 'VERIFIED_PROOF' };
  const proof = privateDiagnosticProofs.get(report);
  const databaseName = deriveTestDbName();
  if (!proof || report.oracle !== 'COMPLETE' || databaseName !== 'app_test_w98')
    throw new Error('E4 shared guard verified proof required');
  await assertConnectedTestDatabase(db);
  await verifyDiagnosticDatabase(db);
  const started = performance.now();
  const owner = `e4_guard_${report.head.slice(0, 12)}_${report.run}`;
  report.internal = { status: 'UNKNOWN', reason: 'PROCESS' };
  const proc = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      `PGAPPNAME=${owner}`,
      'u-nest-api-postgres',
      'psql',
      '-X',
      '-q',
      '-A',
      '-t',
      '-v',
      'ON_ERROR_STOP=1',
      '-v',
      `root_id=${proof.revisionId}`,
      '-U',
      'postgres',
      '-d',
      databaseName,
    ],
    {
      input: sharedGuardProbeSql(proof.revisionId, databaseName),
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 2097152,
    },
  );
  report.internal = {
    status: 'UNKNOWN',
    reason: 'BACKEND_CLEANUP',
    process: {
      exitCode: proc.status,
      signaled: proc.signal !== null,
      error: !!proc.error,
      stdoutBytes: Buffer.byteLength(proc.stdout ?? ''),
      stderrBytes: Buffer.byteLength(proc.stderr ?? ''),
    },
  };
  // A killed docker client need not kill psql: terminate only this exact owned session in this database.
  const owned = await db.$queryRaw<{ pid: number }[]>`
    SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name=${owner} AND pid<>pg_backend_pid()
  `;
  if (owned.length > 1) throw new Error('E4 shared guard backend ownership refused');
  for (const { pid } of owned)
    await db.$queryRaw`
      SELECT pg_terminate_backend(pid,1000) FROM pg_stat_activity
      WHERE datname=current_database() AND application_name=${owner} AND pid=${pid} AND pid<>pg_backend_pid()
    `;
  const [{ remaining }] = await db.$queryRaw<{ remaining: number }[]>`
    SELECT count(*)::int AS remaining FROM pg_stat_activity WHERE datname=current_database() AND application_name=${owner}
  `;
  if (remaining !== 0) throw new Error('E4 shared guard backend cleanup refused');
  report.internal = {
    ...(report.internal as object),
    reason: 'PROCESS_RECEIPT',
    ownedBackendGone: true,
  };
  if (
    proc.error ||
    proc.signal ||
    proc.status !== 0 ||
    !proc.stdout.includes('\nE4_GUARD_COMPLETE\n')
  )
    throw new Error('E4 shared guard process refused');
  report.internal = { ...(report.internal as object), reason: 'EFFECTIVE_METADATA' };
  const rows = proc.stdout.split('\n').filter((line) => line.startsWith('E4_GUARD_META '));
  if (rows.length !== 1) throw new Error('E4 shared guard metadata refused');
  const effective: unknown = JSON.parse(rows[0].slice('E4_GUARD_META '.length));
  expect(effective).toEqual({
    database: databaseName,
    readonly: true,
    bodyMd5: E4_DIAGNOSTIC_PLAN.completeFunctionMd5,
    kind: 'draft',
    units: 8000,
    refs: 50000,
    workMemKb: 4096,
    jitEnabled: true,
    planCacheMode: 'force_custom_plan',
  });
  report.internal = { ...(report.internal as object), reason: 'ACTUAL_PLAN_CAPTURE' };
  report.internal = {
    ...compactSharedGuardNotice(proc.stderr),
    attempts: 1,
    statementMs: 30000,
    processMs: 30000,
    wallMs: performance.now() - started,
    effective,
    settingsLifetime: 'LOCAL_ROLLBACK_BACKEND_DISCONNECTED',
    ownedBackendGone: true,
    validateVersion: false,
    versionSpecificChecks: 'NOT_PROFILED',
  };
  report.internalSqlPlan = 'OBSERVED';
}

export const JOIN_KEY_ORDER = [
  ['LATENCY', 'BASELINE'],
  ['LATENCY', 'CANDIDATE'],
  ['LATENCY', 'CANDIDATE'],
  ['LATENCY', 'BASELINE'],
  ['ACTUAL_PLAN', 'BASELINE'],
  ['ACTUAL_PLAN', 'CANDIDATE'],
  ['SHADOW_CONTROL', 'BASELINE'],
  ['SHADOW_CONTROL', 'CANDIDATE'],
] as const;

export const JOIN_KEY_CALIBRATION_ORDER = [
  ['CONTROL', 'BASELINE'],
  ['CONTROL', 'CANDIDATE'],
  ['SHADOW_CONTROL', 'BASELINE'],
  ['SHADOW_CONTROL', 'CANDIDATE'],
] as const;

// Reserve the unchanged240s for six negatives and six priority cases, rather than extra plan calls.
export const FIXED_METADATA_MAX_ORDER = [
  ['LATENCY', 'BASELINE'],
  ['LATENCY', 'CANDIDATE'],
  ['LATENCY', 'CANDIDATE'],
  ['LATENCY', 'BASELINE'],
  ['SHADOW_CONTROL', 'BASELINE'],
  ['SHADOW_CONTROL', 'CANDIDATE'],
] as const;
export const SOURCE_STATISTICS_ORDER = [
  ['PRE_ANALYZE', 'BASELINE'],
  ['ANALYZED', 'BASELINE'],
  ['ANALYZED', 'CANDIDATE'],
  ['ANALYZED', 'CANDIDATE'],
  ['ANALYZED', 'BASELINE'],
  ['SHADOW_CONTROL', 'BASELINE'],
  ['SHADOW_CONTROL', 'CANDIDATE'],
] as const;
function sourceJoinOrder(small: boolean, statistics = false) {
  return statistics
    ? SOURCE_STATISTICS_ORDER
    : small
      ? JOIN_KEY_CALIBRATION_ORDER
      : FIXED_METADATA_MAX_ORDER;
}

export function joinKeyProbeSql(
  revisionId: string,
  databaseName: string,
  units: 4 | 2000 | 8000 = 8000,
  fixedMetadataMaximum = false,
  sourceJoin = false,
  statisticsComparison = false,
) {
  if (units !== 4 && units !== 8000 && !(sourceJoin && units === 2000))
    throw new Error('E4 join key fixed shape refused');
  if (sourceJoin && (fixedMetadataMaximum || units === 8000))
    throw new Error('E4 source join shape refused');
  if (statisticsComparison && (!sourceJoin || units !== 2000 || fixedMetadataMaximum))
    throw new Error('E4 source statistics scope refused');
  if (fixedMetadataMaximum && units !== 8000) throw new Error('E4 metadata maximum shape refused');
  const fixedMetadata = !sourceJoin && (units === 4 || fixedMetadataMaximum);
  const typedSources = fixedMetadata || sourceJoin;
  sharedGuardProbeSql(revisionId, databaseName); // Reuse the exact scope/identifier refusal.
  const source = readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20261013000000_activity_contribution_assert_source_reuse/migration.sql',
    ),
    'utf8',
  );
  const body = (sql: string) => {
    const match = sql.match(/AS \$\$([\s\S]*?)\$\$;\s*COMMIT;/u);
    if (!match || match[1].includes('$e4_copy$'))
      throw new Error('E4 join key function body refused');
    return match[1];
  };
  const baselineBody = body(source);
  if (
    createHash('md5').update(baselineBody).digest('hex') !== E4_DIAGNOSTIC_PLAN.completeFunctionMd5
  )
    throw new Error('E4 join key baseline body pin refused');
  // The explicit maximum mode uses precisely the SQL proved at20cbaf6d; legacy modes stay distinct.
  const candidateBody = body(
    sourceJoin
      ? source.replace(
          'SELECT * FROM e4_source_rows(root.id)',
          'SELECT * FROM pg_temp.e4_sj_rows(root.id)',
        )
      : fixedMetadata
        ? metadataCanonicalCandidateSource()
        : joinKeyCandidateSource(),
  );
  const shadow = (input: string) =>
    (typedSources
      ? input
          .replaceAll(
            'FROM "ActivitySettlementContributionRevision"',
            'FROM pg_temp.e4_probe_roots',
          )
          .replace(
            'SELECT * FROM e4_source_rows(root.id)',
            'SELECT * FROM pg_temp.e4_probe_sources',
          )
          .replace(
            'SELECT * FROM pg_temp.e4_sj_rows(root.id)',
            'SELECT * FROM pg_temp.e4_probe_sources',
          )
      : input
    )
      .replaceAll('"ParticipantContributionEvaluation"', 'pg_temp.e4_probe_evaluations')
      .replaceAll(
        'e4_evaluation_document(e)',
        'e4_evaluation_document(ROW(e.*)::public."ParticipantContributionEvaluation")',
      );
  const create = (name: string, contents: string) =>
    `CREATE FUNCTION pg_temp.${name}(revision_id TEXT, validate_version BOOLEAN DEFAULT TRUE) RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $e4_copy$${contents}$e4_copy$;\n`;
  const guardDigest = `(SELECT md5(string_agg(to_jsonb(t)::text,',' ORDER BY t.oid)) FROM pg_trigger t
    WHERE t.tgrelid IN ('public."ParticipantContributionEvaluation"'::regclass,
      'public."ActivitySettlementContributionRevision"'::regclass,'public."AttendanceSettlementVersion"'::regclass))`;
  const settings = `SET LOCAL statement_timeout='30s';
SET LOCAL idle_in_transaction_session_timeout='30s';
${sourceJoin ? '' : "SET LOCAL plan_cache_mode='force_custom_plan';"}\n`;
  const sourceStatsDigest = sourceJoinStatsDigestSql(statisticsComparison);
  let sql = `${fixedMetadata ? metadataCanonicalEquivalenceSql(true) : ''}SET statement_timeout='30s';
LOAD 'auto_explain';
SET auto_explain.log_min_duration=-1;
SET client_min_messages='notice';
SET auto_explain.log_level='${sourceJoin ? 'log' : 'notice'}';
SET auto_explain.log_nested_statements=on;
SET auto_explain.log_analyze=on;
SET auto_explain.log_timing=on;
SET auto_explain.log_buffers=on;
SET auto_explain.log_format='json';
SET auto_explain.log_parameter_max_length=0;
SET auto_explain.sample_rate=1;
BEGIN;
DO $$ BEGIN
 IF current_database()<>'app_test_w98' OR
 (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.e4_assert_complete(text,boolean)'::regprocedure)<>'ade4d2af9aa0baf8400a79fc6b62c797'
 THEN RAISE EXCEPTION 'E4 join key connected scope refused'; END IF;
END $$;
CREATE TEMP TABLE e4_probe_context AS SELECT id FROM public."ActivitySettlementContributionRevision" WHERE id=:'root_id';
CREATE TEMP TABLE e4_probe_metadata AS SELECT pg_backend_pid() AS pid,${guardDigest} AS guards${sourceJoin ? `,${sourceStatsDigest} AS source_stats` : ''}${statisticsComparison ? `,${sourceSettingsDigestSql()} AS settings_digest,${sourceDataDigestSql()} AS data_digest` : ''};
CREATE TEMP TABLE e4_probe_evaluations AS SELECT * FROM public."ParticipantContributionEvaluation" WHERE "contributionRevisionId"=:'root_id';
CREATE TEMP TABLE e4_probe_marks(label TEXT);
${
  typedSources
    ? `CREATE TEMP TABLE e4_probe_roots AS SELECT * FROM public."ActivitySettlementContributionRevision" WHERE id=:'root_id';
CREATE TEMP TABLE e4_probe_sources AS SELECT * FROM public.e4_source_rows(:'root_id');`
    : ''
}
${sourceJoin ? sourceJoinSetupSql(units === 4) : ''}
${create('e4_join_candidate', candidateBody)}
${sourceJoin ? create('e4_sj_complete_baseline', baselineBody.replace('SELECT * FROM e4_source_rows(root.id)', 'SELECT * FROM pg_temp.e4_sj_original(root.id)')) : ''}
${create('e4_baseline_shadow', shadow(baselineBody))}
${create('e4_candidate_shadow', shadow(candidateBody))}
COMMIT;\n`;
  if (statisticsComparison) sql += sourceStatisticsStageSql('PRE_ANALYZE');
  const order = sourceJoin
    ? sourceJoinOrder(units === 4, statisticsComparison)
    : fixedMetadataMaximum
      ? FIXED_METADATA_MAX_ORDER
      : units === 4
        ? JOIN_KEY_CALIBRATION_ORDER
        : JOIN_KEY_ORDER;
  for (const [index, [phase, variant]] of order.entries()) {
    if (statisticsComparison && index === 1) sql += sourceStatisticsStageSql('ANALYZED');
    const callable =
      phase === 'SHADOW_CONTROL'
        ? variant === 'BASELINE'
          ? 'pg_temp.e4_baseline_shadow'
          : 'pg_temp.e4_candidate_shadow'
        : variant === 'BASELINE'
          ? sourceJoin
            ? 'pg_temp.e4_sj_complete_baseline'
            : 'public.e4_assert_complete'
          : 'pg_temp.e4_join_candidate';
    sql += `BEGIN READ ONLY;
${settings}
SET LOCAL auto_explain.log_min_duration=${sourceJoin && phase !== 'SHADOW_CONTROL' ? '50' : phase === 'ACTUAL_PLAN' ? '1000' : '-1'};
DO $$ DECLARE root_id TEXT; started TIMESTAMPTZ; elapsed NUMERIC; ${sourceJoin ? 'before_stats TEXT;after_stats TEXT;' : ''} BEGIN
 SELECT id INTO STRICT root_id FROM pg_temp.e4_probe_context;
 ${sourceJoin ? `before_stats:=${sourceStatsDigest};IF before_stats IS DISTINCT FROM (SELECT source_stats FROM pg_temp.e4_probe_metadata) THEN RAISE EXCEPTION 'E4 source join statistics changed before sample'; END IF;` : ''}
 ${statisticsComparison ? `IF ${sourceSettingsDigestSql()} IS DISTINCT FROM (SELECT settings_digest FROM pg_temp.e4_probe_metadata) THEN RAISE EXCEPTION 'E4 source statistics settings changed'; END IF;` : ''}
 RAISE NOTICE 'E4_JOIN_KEY_BEGIN ${index}';
 ${sourceJoin && phase !== 'SHADOW_CONTROL' ? `RAISE LOG 'E4_SOURCE_JOIN_PLAN_BEGIN ${index}';` : ''}
 started:=clock_timestamp();
 PERFORM ${callable}(root_id,FALSE);
 elapsed:=extract(epoch FROM clock_timestamp()-started)*1000;
 ${sourceJoin ? `after_stats:=${sourceStatsDigest};IF after_stats IS DISTINCT FROM before_stats THEN RAISE EXCEPTION 'E4 source join statistics changed during sample'; END IF;` : ''}
 ${statisticsComparison ? `IF ${sourceSettingsDigestSql()} IS DISTINCT FROM (SELECT settings_digest FROM pg_temp.e4_probe_metadata) THEN RAISE EXCEPTION 'E4 source statistics settings changed'; END IF;` : ''}
 ${sourceJoin && phase !== 'SHADOW_CONTROL' ? `RAISE LOG 'E4_SOURCE_JOIN_PLAN_END ${index}';` : ''}
 RAISE NOTICE 'E4_JOIN_KEY_SAMPLE %',json_build_object('index',${index},'phase','${phase}','variant','${variant}',
   'wallMs',elapsed,'returned',true,'completeDocumentAndRootGuard',true,
   'sameBackend',pg_backend_pid()=(SELECT pid FROM pg_temp.e4_probe_metadata),
   'readonly',current_setting('transaction_read_only')='on','workMemKb',pg_size_bytes(current_setting('work_mem'))/1024,
   'jitEnabled',current_setting('jit')='on','planCacheMode',current_setting('plan_cache_mode')${sourceJoin ? `, 'statisticsDigest',before_stats,'statisticsUnchanged',true` : ''}${statisticsComparison ? `, 'settingsDigest',(SELECT settings_digest FROM pg_temp.e4_probe_metadata)` : ''})::text;
END $$;
ROLLBACK;\n`;
  }
  const digest = `(SELECT md5(string_agg(md5(to_jsonb(e)::text),',' ORDER BY id COLLATE "C")) FROM pg_temp.e4_probe_evaluations e)`;
  const mutations = [
    [
      'MISSING',
      'DELETE FROM pg_temp.e4_probe_evaluations WHERE id=(SELECT min(id COLLATE "C") FROM pg_temp.e4_probe_evaluations)',
    ],
    [
      'EXTRA',
      `INSERT INTO pg_temp.e4_probe_evaluations
      SELECT altered.* FROM
        (SELECT * FROM pg_temp.e4_probe_evaluations ORDER BY id COLLATE "C" LIMIT 1) e
      CROSS JOIN LATERAL jsonb_populate_record(NULL::public."ParticipantContributionEvaluation",to_jsonb(e)||
        jsonb_build_object('id','e4_diag_extra_row','evaluationUnitKey',repeat('f',64))) altered`,
    ],
    [
      'TAMPERED',
      `UPDATE pg_temp.e4_probe_evaluations SET "explanationCode"='e4_diag_tampered'
      WHERE id=(SELECT min(id COLLATE "C") FROM pg_temp.e4_probe_evaluations)`,
    ],
  ];
  for (const [kind, mutation] of mutations)
    for (const variant of ['BASELINE', 'CANDIDATE']) {
      const callable = variant === 'BASELINE' ? 'e4_baseline_shadow' : 'e4_candidate_shadow';
      sql += `BEGIN;
${settings}
DO $$ DECLARE root_id TEXT; before_hash TEXT; state TEXT; guard TEXT; message TEXT; affected INTEGER; BEGIN
 RAISE NOTICE 'E4_JOIN_KEY_NEGATIVE_BEGIN ${kind} ${variant}';
 SELECT id INTO STRICT root_id FROM pg_temp.e4_probe_context;
 before_hash:=${digest};
 BEGIN
   INSERT INTO pg_temp.e4_probe_marks VALUES ('${kind}');
   RAISE NOTICE 'E4_JOIN_KEY_NEGATIVE_STEP ${kind} ${variant} MUTATION';
   ${mutation};
   GET DIAGNOSTICS affected=ROW_COUNT;
   IF affected<>1 THEN RAISE EXCEPTION 'E4 join key negative mutation refused'; END IF;
   RAISE NOTICE 'E4_JOIN_KEY_NEGATIVE_STEP ${kind} ${variant} GUARD';
   PERFORM pg_temp.${callable}(root_id,FALSE);
   RAISE EXCEPTION 'E4 join key negative guard did not reject';
 EXCEPTION WHEN OTHERS THEN
   GET STACKED DIAGNOSTICS state=RETURNED_SQLSTATE,guard=CONSTRAINT_NAME,message=MESSAGE_TEXT;
   IF state<>'23514' OR guard<>'e4_evaluation_guard' OR message<>'contribution evaluation set mismatch'
     THEN RAISE NOTICE 'E4_JOIN_KEY_UNEXPECTED %',json_build_object('kind','${kind}','variant','${variant}',
       'state',state,'constraintMatches',guard='e4_evaluation_guard','messageMatches',message='contribution evaluation set mismatch')::text;
       RAISE EXCEPTION 'E4 join key negative outcome refused'; END IF;
 END;
 RAISE NOTICE 'E4_JOIN_KEY_NEGATIVE_STEP ${kind} ${variant} ROLLBACK';
 IF (SELECT count(*) FROM pg_temp.e4_probe_marks)<>0 OR (SELECT count(*) FROM pg_temp.e4_probe_evaluations)<>${units}
   OR ${digest} IS DISTINCT FROM before_hash THEN RAISE EXCEPTION 'E4 join key negative rollback refused'; END IF;
 RAISE NOTICE 'E4_JOIN_KEY_NEGATIVE %',json_build_object('kind','${kind}','variant','${variant}',
   'sqlstate',state,'constraint',guard,'affected',affected,'rolledBack',true,'allShadowRowsRestored',true,'markerRestored',true)::text;
END $$;
ROLLBACK;\n`;
    }
  if (typedSources) {
    const allRowsDigest = `(SELECT md5(jsonb_build_object(
      'evaluations',${digest},
      'roots',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id COLLATE "C") FROM pg_temp.e4_probe_roots r),
      'sources',(SELECT md5(string_agg(fingerprint,',' ORDER BY fingerprint COLLATE "C")) FROM
        (SELECT encode(sha256(convert_to(to_jsonb(s)::TEXT,'UTF8')),'hex') AS fingerprint FROM pg_temp.e4_probe_sources s) fingerprints))::TEXT))`;
    const singleMutation = (statement: string) => `${statement}
      GET DIAGNOSTICS affected=ROW_COUNT;
      IF affected<>1 THEN RAISE EXCEPTION 'E4 metadata priority mutation refused'; END IF;
      changed:=changed+affected;\n`;
    const sourceMutation = singleMutation(
      `UPDATE pg_temp.e4_probe_sources SET item_id=NULL WHERE ctid=(SELECT ctid FROM pg_temp.e4_probe_sources ORDER BY ctid LIMIT 1);`,
    );
    const evaluationMutation = singleMutation(
      `UPDATE pg_temp.e4_probe_evaluations SET "explanationCode"='e4_diag_priority' WHERE id=(SELECT min(id COLLATE "C") FROM pg_temp.e4_probe_evaluations);`,
    );
    const rootMutation = singleMutation(
      `UPDATE pg_temp.e4_probe_roots SET "evaluationCount"="evaluationCount"+1;`,
    );
    for (const [kind, expected, message, mutation, mutations] of [
      [
        'SOURCE_EVALUATION_ROOT',
        'e4_source_guard',
        'contribution unresolved source',
        sourceMutation + evaluationMutation + rootMutation,
        3,
      ],
      [
        'EVALUATION_ROOT',
        'e4_evaluation_guard',
        'contribution evaluation set mismatch',
        evaluationMutation + rootMutation,
        2,
      ],
      ['ROOT', 'e4_complete_guard', 'contribution root count/hash/total mismatch', rootMutation, 1],
    ] as const)
      for (const variant of ['BASELINE', 'CANDIDATE']) {
        const callable = variant === 'BASELINE' ? 'e4_baseline_shadow' : 'e4_candidate_shadow';
        sql += `BEGIN;
${settings}
DO $$ DECLARE root_id TEXT; before_hash TEXT; state TEXT; guard TEXT; message TEXT; affected INTEGER; changed INTEGER:=0; BEGIN
 RAISE NOTICE 'E4_JOIN_KEY_METADATA_PRIORITY_BEGIN ${kind} ${variant}';
 SELECT id INTO STRICT root_id FROM pg_temp.e4_probe_context;
 before_hash:=${allRowsDigest};
 BEGIN
   INSERT INTO pg_temp.e4_probe_marks VALUES ('${kind}');
   ${mutation}
   PERFORM pg_temp.${callable}(root_id,FALSE);
   RAISE EXCEPTION 'E4 metadata priority did not reject';
 EXCEPTION WHEN OTHERS THEN
   GET STACKED DIAGNOSTICS state=RETURNED_SQLSTATE,guard=CONSTRAINT_NAME,message=MESSAGE_TEXT;
   IF state<>'23514' OR guard<>'${expected}' OR message<>'${message}'
   THEN RAISE NOTICE 'E4_JOIN_KEY_METADATA_PRIORITY_UNEXPECTED %',json_build_object('kind','${kind}','variant','${variant}','sqlstate',state,'constraintMatches',guard='${expected}','messageMatches',message='${message}');
     RAISE EXCEPTION 'E4 metadata priority outcome refused'; END IF;
 END;
 IF changed<>${mutations} OR (SELECT count(*) FROM pg_temp.e4_probe_marks)<>0 OR ${allRowsDigest} IS DISTINCT FROM before_hash
 THEN RAISE EXCEPTION 'E4 metadata priority rollback refused'; END IF;
 RAISE NOTICE 'E4_JOIN_KEY_METADATA_PRIORITY %',json_build_object('kind','${kind}','variant','${variant}',
   'sqlstate',state,'constraint',guard,'mutations',changed,'allShadowRowsRestored',true,'markerRestored',true);
END $$;
ROLLBACK;
`;
      }
  }
  sql += `DO $$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.e4_assert_complete(text,boolean)'::regprocedure)<>'ade4d2af9aa0baf8400a79fc6b62c797'
 OR ${guardDigest} IS DISTINCT FROM (SELECT guards FROM pg_temp.e4_probe_metadata)
 ${sourceJoin ? `OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.e4_source_rows(text)'::regprocedure)<>'d8934c5bf29f8b16f820ba6cd950698b'` : ''}
 THEN RAISE EXCEPTION 'E4 join key public catalog changed'; END IF;
 RAISE NOTICE 'E4_JOIN_KEY_COMPLETE %',json_build_object('catalogUnchanged',true,'guardsUnchanged',true,'sameBackend',
   pg_backend_pid()=(SELECT pid FROM pg_temp.e4_probe_metadata),'publicEvaluationCount',
   (SELECT count(*) FROM public."ParticipantContributionEvaluation" WHERE "contributionRevisionId"=(SELECT id FROM pg_temp.e4_probe_context)))::text;
END $$;
${
  statisticsComparison
    ? `DO $$ BEGIN
 IF ${sourceDataDigestSql()} IS DISTINCT FROM (SELECT data_digest FROM pg_temp.e4_probe_metadata)
 OR ${sourceSettingsDigestSql()} IS DISTINCT FROM (SELECT settings_digest FROM pg_temp.e4_probe_metadata)
 THEN RAISE EXCEPTION 'E4 source statistics final data/settings changed'; END IF;
 RAISE NOTICE 'E4_SOURCE_JOIN_STATS_COMPLETE %',json_build_object('dataUnchanged',true,'settingsUnchanged',true,'database',current_database(),'analyzedTables',5);
END $$;`
    : ''
}
SELECT 'E4_JOIN_KEY_SUCCESS';\n`;
  return sql;
}

export function compactJoinKeyPositiveEvidence(raw: string) {
  if (Buffer.byteLength(raw) > 2097152) throw new Error('E4 join key capture limit');
  const samples = [...raw.matchAll(/NOTICE:\s+E4_JOIN_KEY_SAMPLE (\{[^\n]+\})/gu)].map(
    (match) => JSON.parse(match[1]) as Record<string, unknown>,
  );
  if (samples.length !== JOIN_KEY_ORDER.length)
    throw new Error('E4 join key positive count refused');
  const timings = samples.map((sample, index) => {
    const [phase, variant] = JOIN_KEY_ORDER[index];
    if (
      sample.index !== index ||
      sample.phase !== phase ||
      sample.variant !== variant ||
      sample.returned !== true ||
      sample.completeDocumentAndRootGuard !== true ||
      sample.sameBackend !== true ||
      sample.readonly !== true ||
      sample.workMemKb !== 4096 ||
      sample.jitEnabled !== true ||
      sample.planCacheMode !== 'force_custom_plan' ||
      typeof sample.wallMs !== 'number' ||
      !Number.isFinite(sample.wallMs) ||
      sample.wallMs <= 0 ||
      sample.wallMs > 30000
    )
      throw new Error('E4 join key timing or settings refused');
    return {
      phase,
      variant,
      wallMs: sample.wallMs,
      returned: true,
      completeDocumentAndRootGuard: true,
    };
  });
  const plans = (['BASELINE', 'CANDIDATE'] as const).map((variant, i) => {
    const index = i + 4;
    const marker = new RegExp(`NOTICE:\\s+E4_JOIN_KEY_BEGIN ${index}\\s*\\n`, 'u').exec(raw);
    if (!marker) throw new Error('E4 join key plan marker refused');
    const start = marker.index + marker[0].length;
    const next = raw.indexOf('E4_JOIN_KEY_BEGIN ', start);
    return {
      variant,
      ...compactSharedGuardNotice(raw.slice(start, next < 0 ? raw.length : next), variant),
    };
  });
  return {
    status: 'PARTIAL',
    purpose: 'DIAGNOSTIC_ONLY_NOT_ACCEPTANCE',
    order: 'ABBA_TWO_ACTUAL_PLANS_TWO_SHADOW_CONTROLS',
    sameFixture: true,
    sameBackend: true,
    session: { workMemKb: 4096, jitEnabled: true, planCacheMode: 'force_custom_plan' },
    statementMs: 30000,
    processMs: 240000,
    timings,
    plans,
    negativeScope:
      'TEMP_SHADOW_FULL_SQL_NATIVE_EXCEPTION_AND_SUBTRANSACTION_ROLLBACK_NOT_PRODUCTION_TRIGGER_E2E',
    cacheLimit: 'FIXED_TWO_ORDERS_ONE_RUN_NO_CAUSAL_OR_PERCENTILE_CLAIM',
    versionSpecificChecks: 'NOT_PROFILED',
  };
}

function compactJoinKeyNegativeCases(raw: string) {
  const negatives = [...raw.matchAll(/NOTICE:\s+E4_JOIN_KEY_NEGATIVE (\{[^\n]+\})/gu)].map(
    (match) => JSON.parse(match[1]) as Record<string, unknown>,
  );
  if (negatives.length > 6) throw new Error('E4 join key negative count refused');
  const cases = negatives.map((value, index) => {
    const kind = ['MISSING', 'EXTRA', 'TAMPERED'][Math.floor(index / 2)],
      variant = index % 2 === 0 ? 'BASELINE' : 'CANDIDATE';
    if (
      value.kind !== kind ||
      value.variant !== variant ||
      value.sqlstate !== '23514' ||
      value.constraint !== 'e4_evaluation_guard' ||
      value.affected !== 1 ||
      value.rolledBack !== true ||
      value.allShadowRowsRestored !== true ||
      value.markerRestored !== true
    )
      throw new Error('E4 join key negative or rollback refused');
    return {
      kind,
      variant,
      sqlstate: '23514',
      constraint: 'e4_evaluation_guard',
      affected: 1,
      rolledBack: true,
      allShadowRowsRestored: true,
      markerRestored: true,
    };
  });
  return cases;
}

export function compactJoinKeyEvidence(raw: string) {
  const positive = compactJoinKeyPositiveEvidence(raw);
  const cases = compactJoinKeyNegativeCases(raw);
  const complete = [...raw.matchAll(/NOTICE:\s+E4_JOIN_KEY_COMPLETE (\{[^\n]+\})/gu)].map(
    (match) => JSON.parse(match[1]) as Record<string, unknown>,
  );
  if (cases.length !== 6 || complete.length !== 1)
    throw new Error('E4 join key evidence count refused');
  expect(complete[0]).toEqual({
    catalogUnchanged: true,
    guardsUnchanged: true,
    sameBackend: true,
    publicEvaluationCount: 8000,
  });
  return {
    ...positive,
    status: 'COMPLETE',
    cases,
    catalogUnchanged: true,
    guardsUnchanged: true,
  };
}

export function compactMetadataPriorityEvidence(raw: string, complete = true) {
  const entries = [
    ...joinKeyDiagnosticNotices(raw).matchAll(
      /NOTICE:\s+E4_JOIN_KEY_METADATA_PRIORITY (\{[^\n]+\})/gu,
    ),
  ];
  if (entries.length > 6 || (complete && entries.length !== 6))
    throw new Error('E4 metadata priority count refused');
  return entries.map((entry, index) => {
    const [kind, constraint, mutations] = [
      ['SOURCE_EVALUATION_ROOT', 'e4_source_guard', 3],
      ['EVALUATION_ROOT', 'e4_evaluation_guard', 2],
      ['ROOT', 'e4_complete_guard', 1],
    ][Math.floor(index / 2)];
    const variant = index % 2 === 0 ? 'BASELINE' : 'CANDIDATE';
    const expected = {
      kind,
      variant,
      sqlstate: '23514',
      constraint,
      mutations,
      allShadowRowsRestored: true,
      markerRestored: true,
    };
    expect(JSON.parse(entry[1])).toEqual(expected);
    return expected;
  });
}

/** One fixture/backend, uninstrumented ABBA; no cross-runner or percentile comparison. */
export function compactFixedMetadataMaximumEvidence(raw: string, complete = true) {
  raw = joinKeyDiagnosticNotices(raw);
  const samples = [...raw.matchAll(/NOTICE:\s+E4_JOIN_KEY_SAMPLE (\{[^\n]+\})/gu)];
  if (samples.length > FIXED_METADATA_MAX_ORDER.length || (complete && samples.length !== 6))
    throw new Error('E4 metadata maximum sample count refused');
  const timings = samples.map((match, index) => {
    const value = JSON.parse(match[1]) as Record<string, unknown>;
    const [phase, variant] = FIXED_METADATA_MAX_ORDER[index];
    if (
      value.index !== index ||
      value.phase !== phase ||
      value.variant !== variant ||
      value.returned !== true ||
      value.completeDocumentAndRootGuard !== true ||
      value.sameBackend !== true ||
      value.readonly !== true ||
      value.workMemKb !== 4096 ||
      value.jitEnabled !== true ||
      value.planCacheMode !== 'force_custom_plan' ||
      typeof value.wallMs !== 'number' ||
      !Number.isFinite(value.wallMs) ||
      value.wallMs <= 0 ||
      value.wallMs > 30000
    )
      throw new Error('E4 metadata maximum sample refused');
    return {
      phase,
      variant,
      wallMs: value.wallMs,
      returned: true,
      completeDocumentAndRootGuard: true,
    };
  });
  const cases = compactJoinKeyNegativeCases(raw);
  const priorityCases = compactMetadataPriorityEvidence(raw, complete);
  const metadataCanonical = complete ? compactMetadataCanonicalEvidence(raw, true) : undefined;
  if (complete) {
    const endings = [...raw.matchAll(/NOTICE:\s+E4_JOIN_KEY_COMPLETE (\{[^\n]+\})/gu)];
    if (cases.length !== 6 || endings.length !== 1)
      throw new Error('E4 metadata maximum completion refused');
    expect(JSON.parse(endings[0][1])).toEqual({
      catalogUnchanged: true,
      guardsUnchanged: true,
      sameBackend: true,
      publicEvaluationCount: 8000,
    });
  }
  return {
    status: complete ? ('COMPLETE' as const) : ('PARTIAL' as const),
    purpose: 'FIXED_METADATA_MAXIMUM_DIAGNOSTIC_NOT_ACCEPTANCE',
    order: 'ABBA_TWO_SHADOW_CONTROLS_NO_PLAN_OVERHEAD',
    units: 8000,
    candidate: E4_FIXED_METADATA_CANDIDATE,
    ...(timings.length ? { sameFixture: true, sameBackend: true } : {}),
    session: { workMemKb: 4096, jitEnabled: true, planCacheMode: 'force_custom_plan' },
    timings,
    cases,
    priorityCases,
    ...(metadataCanonical ? { metadataCanonical } : {}),
    statementMs: 30000,
    processMs: 240000,
    negativeScope:
      'TEMP_SHADOW_FULL_SQL_NATIVE_EXCEPTION_AND_SUBTRANSACTION_ROLLBACK_NOT_PRODUCTION_TRIGGER_E2E',
    versionSpecificChecks: 'NOT_PROFILED',
    cacheLimit: 'ONE_ABBA_RUN_NO_CAUSAL_OR_PERCENTILE_CLAIM',
    ...(complete
      ? { catalogUnchanged: true, guardsUnchanged: true, publicEvaluationCount: 8000 }
      : {}),
  };
}

/** Four controls, fixed-metadata byte proof, six native negatives and six priority/rollback cases. */
export function compactJoinKeyCalibrationEvidence(raw: string, complete = true) {
  raw = joinKeyDiagnosticNotices(raw);
  if (Buffer.byteLength(raw) > 2097152) throw new Error('E4 join key capture limit');
  const samples = [...raw.matchAll(/NOTICE:\s+E4_JOIN_KEY_SAMPLE (\{[^\n]+\})/gu)].map(
    (match) => JSON.parse(match[1]) as Record<string, unknown>,
  );
  if (samples.length > JOIN_KEY_CALIBRATION_ORDER.length)
    throw new Error('E4 calibration control count refused');
  const controls = samples.map((sample, index) => {
    const [phase, variant] = JOIN_KEY_CALIBRATION_ORDER[index];
    if (
      sample.index !== index ||
      sample.phase !== phase ||
      sample.variant !== variant ||
      sample.returned !== true ||
      sample.completeDocumentAndRootGuard !== true ||
      sample.sameBackend !== true ||
      sample.readonly !== true ||
      sample.workMemKb !== 4096 ||
      sample.jitEnabled !== true ||
      sample.planCacheMode !== 'force_custom_plan' ||
      typeof sample.wallMs !== 'number' ||
      !Number.isFinite(sample.wallMs) ||
      sample.wallMs <= 0 ||
      sample.wallMs > 30000
    )
      throw new Error('E4 calibration control refused');
    return { phase, variant, returned: true, completeDocumentAndRootGuard: true };
  });
  const cases = compactJoinKeyNegativeCases(raw);
  const metadataCanonical = complete ? compactMetadataCanonicalEvidence(raw, true) : undefined;
  const priorityCases = compactMetadataPriorityEvidence(raw, complete);
  if (complete) {
    const end = [...raw.matchAll(/NOTICE:\s+E4_JOIN_KEY_COMPLETE (\{[^\n]+\})/gu)];
    if (controls.length !== 4 || cases.length !== 6 || end.length !== 1)
      throw new Error('E4 calibration completion refused');
    expect(JSON.parse(end[0][1])).toEqual({
      catalogUnchanged: true,
      guardsUnchanged: true,
      sameBackend: true,
      publicEvaluationCount: 4,
    });
  }
  return {
    status: complete ? ('COMPLETE' as const) : ('PARTIAL' as const),
    purpose: 'SMALL_TOOL_CALIBRATION_NOT_MAXIMUM_OR_ACCEPTANCE',
    units: 4,
    controls,
    cases,
    ...(metadataCanonical ? { metadataCanonical } : {}),
    priorityCases,
    statementMs: 30000,
    processMs: 240000,
    negativeScope:
      'TEMP_SHADOW_FULL_SQL_NATIVE_EXCEPTION_AND_SUBTRANSACTION_ROLLBACK_NOT_PRODUCTION_TRIGGER_E2E',
    ...(complete
      ? { catalogUnchanged: true, guardsUnchanged: true, publicEvaluationCount: 4 }
      : {}),
  };
}

/** PostgreSQL verbose NOTICE adds its success SQLSTATE; leave ERROR codes and other text private. */
export function joinKeyDiagnosticNotices(raw: string) {
  if (Buffer.byteLength(raw) > 2097152) throw new Error('E4 join key capture limit');
  return raw.replace(
    /(^|\n)NOTICE:[ \t]+00000:[ \t]+(?=E4_(?:JOIN_KEY|SOURCE_JOIN)_)/gu,
    '$1NOTICE: ',
  );
}

export function joinKeyCalibrationGate(
  input: {
    scenario: E4DiagnosticScenario;
    coverage?: string;
    oracle: string;
    facts?: unknown;
    scenarioShape?: Report['scenarioShape'];
  },
  units: number,
) {
  if (
    input.scenario !== 'ordinary-1' ||
    input.coverage !== 'SMALL_JOIN_KEY_CALIBRATION_ONLY' ||
    input.oracle !== 'COMPLETE' ||
    units !== 4
  )
    throw new Error('E4 complete small oracle required');
  expect(input.scenarioShape).toEqual({ identities: 1, segments: 1, slices: 5, units: 4 });
  expect(input.facts).toEqual({
    roots: 1,
    evaluations: 4,
    timeRoots: 1,
    buckets: 4,
    sources: 4,
    receipts: 1,
    audits: 1,
  });
  return 'SMALL_COMPLETE_FROZEN_ORACLE';
}

export function compactJoinKeyFailure(raw: string) {
  if (Buffer.byteLength(raw) > 2097152) throw new Error('E4 join key capture limit');
  const step = [
    ...raw.matchAll(
      /NOTICE:\s+E4_JOIN_KEY_NEGATIVE_STEP (MISSING|EXTRA|TAMPERED) (BASELINE|CANDIDATE) (MUTATION|GUARD|ROLLBACK)/gu,
    ),
  ].at(-1);
  const unexpected = [...raw.matchAll(/NOTICE:\s+E4_JOIN_KEY_UNEXPECTED (\{[^\n]+\})/gu)].at(-1);
  let native: {
    kind: string;
    variant: string;
    state: string;
    constraintMatches: boolean;
    messageMatches: boolean;
  } | null = null;
  if (unexpected) {
    let value: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(unexpected[1]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        value = parsed as Record<string, unknown>;
    } catch {
      /* A malformed/truncated native-error receipt remains UNKNOWN. */
    }
    if (
      ['MISSING', 'EXTRA', 'TAMPERED'].includes(String(value.kind)) &&
      ['BASELINE', 'CANDIDATE'].includes(String(value.variant)) &&
      typeof value.state === 'string' &&
      /^[A-Z0-9]{5}$/u.test(value.state) &&
      typeof value.constraintMatches === 'boolean' &&
      typeof value.messageMatches === 'boolean'
    )
      native = {
        kind: String(value.kind),
        variant: String(value.variant),
        state: value.state,
        constraintMatches: value.constraintMatches,
        messageMatches: value.messageMatches,
      };
  }
  const classification =
    native?.state === '57014' || raw.includes('canceling statement due to statement timeout')
      ? 'STATEMENT_TIMEOUT'
      : native?.state === '42702' || /ERROR:[^\n]*column reference "id" is ambiguous/u.test(raw)
        ? 'AMBIGUOUS_ID'
        : raw.includes('E4 join key negative outcome refused')
          ? 'NEGATIVE_OUTCOME'
          : 'OTHER';
  let partialEvidence:
    | (ReturnType<typeof compactJoinKeyPositiveEvidence> & {
        cases: ReturnType<typeof compactJoinKeyNegativeCases>;
      })
    | null = null;
  try {
    partialEvidence = {
      ...compactJoinKeyPositiveEvidence(raw),
      cases: compactJoinKeyNegativeCases(raw),
    };
  } catch {
    /* An incomplete or invalid plan/settings receipt cannot become evidence. */
  }
  return {
    classification,
    lastNegativeStep: step ? { kind: step[1], variant: step[2], step: step[3] } : null,
    unexpected: native,
    partialEvidence,
  };
}

export function joinKeyOracleGate(input: {
  oracle: string;
  errorSubstage?: string;
  error?: ReturnType<typeof e4DiagnosticSafeError>;
  firstCanonical32?: Pick<
    FirstCanonical32Evidence,
    'outcome' | 'fullComparisonValidated' | 'error' | 'transactionMs' | 'workMemKb'
  >;
}) {
  const first = input.firstCanonical32;
  if (input.oracle === 'COMPLETE' && first?.fullComparisonValidated === true)
    return 'FIRST_ORACLE_COMPLETE';
  if (
    input.oracle === 'NOT_RUN' &&
    input.errorSubstage === 'ORACLE_CANONICAL_DOCUMENT' &&
    input.error?.className === 'PrismaClientKnownRequestError' &&
    input.error.category === 'P2028' &&
    input.error.timing?.timeoutMs === 30000 &&
    input.error.timing.elapsedMs > 30000 &&
    first?.outcome === 'REJECTED' &&
    first.transactionMs === 30000 &&
    first.workMemKb === 32768 &&
    first.error?.category === 'P2028' &&
    first.error.timing?.timeoutMs === 30000 &&
    first.error.timing.elapsedMs === input.error.timing.elapsedMs &&
    first.fullComparisonValidated !== true
  )
    return 'FIRST_CANONICAL_TIMEOUT_RETAINED';
  throw new Error('E4 join key oracle gate refused');
}

async function probeJoinKeyCandidate(db: PrismaClient, report: Report) {
  report.joinKeyCandidate = { status: 'UNKNOWN', reason: 'PROOF' };
  const proof = privateDiagnosticProofs.get(report),
    databaseName = deriveTestDbName();
  if (!proof || databaseName !== 'app_test_w98')
    throw new Error('E4 join key verified proof refused');
  const calibration = process.env.SRVF_E4_JOIN_KEY_CALIBRATION === '1';
  const fixedMetadataMaximum = process.env.SRVF_E4_FIXED_METADATA_MAX_ONCE === '1';
  const oracleGate = calibration
    ? joinKeyCalibrationGate(report, proof.units)
    : joinKeyOracleGate(report);
  if (fixedMetadataMaximum && (proof.units !== 8000 || oracleGate !== 'FIRST_ORACLE_COMPLETE'))
    throw new Error('E4 metadata maximum complete oracle required');
  await assertConnectedTestDatabase(db);
  await verifyDiagnosticDatabase(db);
  await verifyDiagnosticGuards(db);
  const owner = `e4_key_${report.head.slice(0, 12)}_${report.run}`;
  const processStarted = performance.now();
  const proc = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      `PGAPPNAME=${owner}`,
      'u-nest-api-postgres',
      'psql',
      '-X',
      '-q',
      '-A',
      '-t',
      '-v',
      'ON_ERROR_STOP=1',
      ...(calibration || fixedMetadataMaximum ? ['-v', 'VERBOSITY=verbose'] : []),
      '-v',
      `root_id=${proof.revisionId}`,
      '-U',
      'postgres',
      '-d',
      databaseName,
    ],
    {
      input: joinKeyProbeSql(
        proof.revisionId,
        databaseName,
        calibration ? 4 : 8000,
        fixedMetadataMaximum,
      ),
      encoding: 'utf8',
      timeout: 240000,
      maxBuffer: 2097152,
    },
  );
  const processWallMs = performance.now() - processStarted;
  const stderr = joinKeyDiagnosticNotices(proc.stderr ?? '');
  const positive = [...stderr.matchAll(/NOTICE:\s+E4_JOIN_KEY_BEGIN ([0-7])\s*\n/gu)].map(
    (match) => +match[1],
  );
  const negative = [
    ...stderr.matchAll(
      /NOTICE:\s+E4_JOIN_KEY_NEGATIVE_BEGIN (MISSING|EXTRA|TAMPERED) (BASELINE|CANDIDATE)/gu,
    ),
  ].map((match) => ({ kind: match[1], variant: match[2] }));
  report.joinKeyCandidate = {
    status: 'UNKNOWN',
    reason: 'PROCESS',
    exitCode: proc.status,
    signaled: proc.signal !== null,
    error: !!proc.error,
    wallMs: processWallMs,
    stdoutBytes: Buffer.byteLength(proc.stdout ?? ''),
    stderrBytes: Buffer.byteLength(proc.stderr ?? ''),
    progress: {
      metadata: calibration || fixedMetadataMaximum ? compactMetadataProgress(stderr) : undefined,
      lastPositiveIndex: positive.at(-1) ?? null,
      lastNegative: negative.at(-1) ?? null,
      completedPositive: (stderr.match(/NOTICE:\s+E4_JOIN_KEY_SAMPLE /gu) ?? []).length,
      completedNegative: (stderr.match(/NOTICE:\s+E4_JOIN_KEY_NEGATIVE /gu) ?? []).length,
      nativeErrors: [
        ...new Set(
          [...stderr.matchAll(/ERROR:\s+([A-Z0-9]{5})(?::|\s|$)/gu)].map((match) => match[1]),
        ),
      ].slice(0, 4),
    },
  };
  const owned = await db.$queryRaw<
    { pid: number }[]
  >`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name=${owner} AND pid<>pg_backend_pid()`;
  if (owned.length > 1) throw new Error('E4 join key backend ownership refused');
  for (const { pid } of owned)
    await db.$queryRaw`SELECT pg_terminate_backend(pid,1000) FROM pg_stat_activity WHERE datname=current_database() AND application_name=${owner} AND pid=${pid} AND pid<>pg_backend_pid()`;
  const [{ remaining }] = await db.$queryRaw<
    { remaining: number }[]
  >`SELECT count(*)::int AS remaining FROM pg_stat_activity WHERE datname=current_database() AND application_name=${owner}`;
  if (remaining !== 0) throw new Error('E4 join key backend cleanup refused');
  report.joinKeyCandidate = { ...(report.joinKeyCandidate as object), ownedBackendGone: true };
  report.joinKeyCandidate = {
    ...(report.joinKeyCandidate as object),
    ...compactJoinKeyFailure(stderr),
  };
  if (calibration || fixedMetadataMaximum) {
    try {
      report.joinKeyCandidate = {
        ...(report.joinKeyCandidate as object),
        partialEvidence: fixedMetadataMaximum
          ? compactFixedMetadataMaximumEvidence(stderr, false)
          : compactJoinKeyCalibrationEvidence(stderr, false),
      };
    } catch {
      /* Invalid or truncated controls cannot become evidence. */
    }
  }
  if (
    proc.error ||
    proc.signal ||
    proc.status !== 0 ||
    !proc.stdout.includes('E4_JOIN_KEY_SUCCESS')
  )
    throw new Error('E4 join key process refused');
  report.joinKeyCandidate = { ...(report.joinKeyCandidate as object), reason: 'EVIDENCE' };
  report.joinKeyCandidate = {
    ...(fixedMetadataMaximum
      ? compactFixedMetadataMaximumEvidence(stderr)
      : calibration
        ? compactJoinKeyCalibrationEvidence(stderr)
        : compactJoinKeyEvidence(stderr)),
    oracleGate,
    wallMs: processWallMs,
    ownedBackendGone: true,
    tempObjectsLifetime: 'OWNED_BACKEND_DISCONNECTED',
  };
  report.internalSqlPlan = 'OBSERVED';
  await verifyDiagnosticDatabase(db);
  await verifyDiagnosticGuards(db);
  if (calibration || fixedMetadataMaximum) {
    report.internalSqlPlan = 'NOT_RUN';
  }
}

async function joinKeyPostFailureOracle(db: PrismaClient, report: Report) {
  if (joinKeyOracleGate(report) !== 'FIRST_CANONICAL_TIMEOUT_RETAINED')
    throw new Error('E4 retained oracle timeout required');
  const proof = privateDiagnosticProofs.get(report);
  if (!proof) throw new Error('E4 retained oracle proof required');
  frozenE4OracleSource();
  const sql = canonicalCostQueries(proof.revisionId, proof.sourceKindCode).comparison;
  const started = performance.now();
  const common = {
    purpose: 'POST_FAILURE_IDENTICAL_FROZEN_QUERY_NOT_FIRST_OR_FORMAL_ACCEPTANCE',
    firstFailureRetained: true,
    frozenSourceSha256: oracleHash,
    transactionMs: 30000,
    statementMs: 30000,
    workMemKb: 32768,
  };
  report.joinKeyPostFailureOracle = { ...common, status: 'UNKNOWN' };
  try {
    const result = await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        await tx.$executeRaw`SET LOCAL statement_timeout='30s'`;
        await tx.$executeRaw`SET LOCAL work_mem='32MB'`;
        const [settings] = await tx.$queryRaw<
          { readonly: boolean; workMemKb: number; jitEnabled: boolean }[]
        >`
        SELECT current_setting('transaction_read_only')='on' AS readonly,
        (pg_size_bytes(current_setting('work_mem'))/1024)::int AS "workMemKb",current_setting('jit')='on' AS "jitEnabled"
      `;
        expect(settings).toEqual({ readonly: true, workMemKb: 32768, jitEnabled: true });
        const [comparison] = await tx.$queryRaw<CanonicalComparison[]>(sql);
        assertCanonicalComparison(comparison, proof.units);
        return comparison;
      },
      { timeout: 30000 },
    );
    report.joinKeyPostFailureOracle = {
      ...common,
      status: 'COMPLETE',
      wallMs: performance.now() - started,
      comparison: result,
    };
  } catch (error) {
    report.joinKeyPostFailureOracle = {
      ...common,
      status: 'FAILED',
      wallMs: performance.now() - started,
      error: e4DiagnosticSafeError(error),
    };
    throw error;
  }
}
async function probeCanonicalJit(
  db: PrismaClient,
  evidence: NonNullable<Report['canonicalCost']>,
  sql: Prisma.Sql,
  units: number,
) {
  const readSettings = async () =>
    db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return tx.$queryRaw<
          { pid: number; jitEnabled: boolean }[]
        >`SELECT pg_backend_pid() AS pid,current_setting('jit')='on' AS "jitEnabled"`;
      },
      { timeout: 30000 },
    );
  const [baseline] = await readSettings();
  const results: NonNullable<NonNullable<Report['canonicalCost']>['jitComparison']> = {
    baselineJit: baseline.jitEnabled,
    samples: [],
  };
  evidence.jitComparison = results;
  let analyzed = false;
  for (const [order, jit] of CANONICAL_JIT_ORDER) {
    const started = performance.now();
    const sample: CanonicalJitSample = {
      order,
      jit,
      transactionMs: 30000,
      statementMs: 30000,
      wallMs: 0,
      outcome: 'FAILED',
    };
    try {
      const row = await db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          await tx.$executeRaw`SET LOCAL statement_timeout='30s'`;
          if (jit === 'on') await tx.$executeRaw`SET LOCAL jit=on`;
          else await tx.$executeRaw`SET LOCAL jit=off`;
          const [identity] = await tx.$queryRaw<
            { pid: number; readonly: boolean; jitEnabled: boolean }[]
          >`SELECT pg_backend_pid() AS pid,current_setting('transaction_read_only')='on' AS readonly,current_setting('jit')='on' AS "jitEnabled"`;
          sample.sameBackend = identity.pid === baseline.pid;
          expect(identity).toEqual({ pid: baseline.pid, readonly: true, jitEnabled: jit === 'on' });
          const [comparison] = await tx.$queryRaw<CanonicalComparison[]>(sql);
          assertCanonicalComparison(comparison, units);
          return comparison;
        },
        { timeout: 30000 },
      );
      sample.comparison = row;
      sample.outcome = 'COMPLETE';
    } catch (error) {
      sample.error = e4DiagnosticSafeError(error);
    } finally {
      sample.wallMs = performance.now() - started;
      results.samples.push(sample);
    }
    if (!analyzed && jit === 'off' && sample.outcome === 'COMPLETE') {
      analyzed = true;
      try {
        const [plan] = await db.$transaction(
          async (tx) => {
            await tx.$executeRaw`SET TRANSACTION READ ONLY`;
            await tx.$executeRaw`SET LOCAL statement_timeout='30s'`;
            await tx.$executeRaw`SET LOCAL jit=off`;
            return tx.$queryRaw<{ 'QUERY PLAN': unknown }[]>(
              Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${sql}`,
            );
          },
          { timeout: 30000 },
        );
        results.actualPlan = compactCanonicalActualPlan(plan['QUERY PLAN']);
      } catch (error) {
        results.actualPlanError = e4DiagnosticSafeError(error);
      }
    }
  }
  const [restored] = await readSettings();
  results.settingsRestored =
    restored.pid === baseline.pid && restored.jitEnabled === baseline.jitEnabled;
}

type CanonicalMemorySample = {
  mode: 'BASELINE' | 'LOCAL_32MB';
  workMemKb: number;
  jit: 'off';
  transactionMs: 30000;
  statementMs: 30000;
  wallMs: number;
  outcome: 'COMPLETE' | 'FAILED';
  sameBackend?: boolean;
  comparison?: CanonicalComparison;
  error?: ReturnType<typeof e4DiagnosticSafeError>;
  actualPlan?: unknown;
  actualPlanError?: ReturnType<typeof e4DiagnosticSafeError>;
};
async function probeCanonicalMemory(
  db: PrismaClient,
  evidence: NonNullable<Report['canonicalCost']>,
  sql: Prisma.Sql,
  units: number,
) {
  const readSettings = () =>
    db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return tx.$queryRaw<
          { pid: number; jitEnabled: boolean; workMemKb: number }[]
        >`SELECT pg_backend_pid() AS pid,current_setting('jit')='on' AS "jitEnabled",(pg_size_bytes(current_setting('work_mem'))/1024)::int AS "workMemKb"`;
      },
      { timeout: 30000 },
    );
  const [baseline] = await readSettings();
  if (
    !Number.isInteger(baseline.workMemKb) ||
    baseline.workMemKb <= 0 ||
    baseline.workMemKb >= 32768
  )
    throw new Error('E4 memory baseline unsuitable for bounded pair');
  const results: NonNullable<NonNullable<Report['canonicalCost']>['memoryComparison']> = {
    baselineWorkMemKb: baseline.workMemKb,
    baselineJit: baseline.jitEnabled,
    samples: [],
  };
  evidence.memoryComparison = results;
  const initialize = async (tx: Prisma.TransactionClient, mode: 'BASELINE' | 'LOCAL_32MB') => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await tx.$executeRaw`SET LOCAL statement_timeout='30s'`;
    await tx.$executeRaw`SET LOCAL jit=off`;
    if (mode === 'LOCAL_32MB') await tx.$executeRaw`SET LOCAL work_mem='32MB'`;
    const [identity] = await tx.$queryRaw<
      { pid: number; readonly: boolean; jitEnabled: boolean; workMemKb: number }[]
    >`SELECT pg_backend_pid() AS pid,current_setting('transaction_read_only')='on' AS readonly,current_setting('jit')='on' AS "jitEnabled",(pg_size_bytes(current_setting('work_mem'))/1024)::int AS "workMemKb"`;
    expect(identity).toEqual({
      pid: baseline.pid,
      readonly: true,
      jitEnabled: false,
      workMemKb: mode === 'BASELINE' ? baseline.workMemKb : 32768,
    });
    return identity.pid === baseline.pid;
  };
  for (const mode of ['BASELINE', 'LOCAL_32MB'] as const) {
    const sample: CanonicalMemorySample = {
      mode,
      workMemKb: mode === 'BASELINE' ? baseline.workMemKb : 32768,
      jit: 'off',
      transactionMs: 30000,
      statementMs: 30000,
      wallMs: 0,
      outcome: 'FAILED',
    };
    const started = performance.now();
    try {
      sample.comparison = await db.$transaction(
        async (tx) => {
          sample.sameBackend = await initialize(tx, mode);
          const [row] = await tx.$queryRaw<CanonicalComparison[]>(sql);
          assertCanonicalComparison(row, units);
          return row;
        },
        { timeout: 30000 },
      );
      sample.outcome = 'COMPLETE';
    } catch (error) {
      sample.error = e4DiagnosticSafeError(error);
    } finally {
      sample.wallMs = performance.now() - started;
      results.samples.push(sample);
    }
    if (sample.outcome === 'COMPLETE') {
      try {
        const [plan] = await db.$transaction(
          async (tx) => {
            await initialize(tx, mode);
            return tx.$queryRaw<{ 'QUERY PLAN': unknown }[]>(
              Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${sql}`,
            );
          },
          { timeout: 30000 },
        );
        sample.actualPlan = compactCanonicalActualPlan(plan['QUERY PLAN'], true);
      } catch (error) {
        sample.actualPlanError = e4DiagnosticSafeError(error);
      }
    }
  }
  const [restored] = await readSettings();
  results.settingsRestored =
    restored.pid === baseline.pid &&
    restored.jitEnabled === baseline.jitEnabled &&
    restored.workMemKb === baseline.workMemKb;
}

async function probeCanonicalCosts(
  db: PrismaClient,
  report: Report,
  proof: PrivateDiagnosticProof,
) {
  report.canonicalCost = { purpose: 'READ_ONLY_COST_NOT_ACCEPTANCE', samples: [] };
  try {
    const sql = canonicalCostQueries(proof.revisionId, proof.sourceKindCode);
    for (const [component, query] of process.env.SRVF_E4_CANONICAL_JIT_ABBA === '1' ||
    process.env.SRVF_E4_CANONICAL_MEMORY_PAIR === '1'
      ? []
      : ([
          ['OLD_FROZEN', sql.old],
          ['CANDIDATE', sql.candidate],
          ['STORED', sql.stored],
        ] as const)) {
      const started = performance.now();
      const sample: CanonicalCostSample = {
        component,
        transactionMs: 30000,
        statementMs: 30000,
        wallMs: 0,
        outcome: 'FAILED',
      };
      try {
        const [row] = await db.$transaction(
          async (tx) => {
            await tx.$executeRaw`SET TRANSACTION READ ONLY`;
            await tx.$executeRaw`SET LOCAL statement_timeout='30s'`;
            return tx.$queryRaw<{ rows: number; documentBytes: string; keyBytes: string }[]>(query);
          },
          { timeout: 30000 },
        );
        const documentBytes = Number(row.documentBytes),
          keyBytes = Number(row.keyBytes);
        expect(row.rows).toBe(proof.units);
        if (![documentBytes, keyBytes].every((x) => Number.isSafeInteger(x) && x >= 0 && x <= 1e12))
          throw new Error('E4 canonical size evidence refused');
        Object.assign(sample, { outcome: 'COMPLETE', rows: row.rows, documentBytes, keyBytes });
      } catch (error) {
        sample.error = e4DiagnosticSafeError(error);
      } finally {
        sample.wallMs = performance.now() - started;
        report.canonicalCost.samples.push(sample);
      }
    }
    try {
      const [plan] = await db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          await tx.$executeRaw`SET LOCAL statement_timeout='30s'`;
          return tx.$queryRaw<{ 'QUERY PLAN': unknown }[]>(
            Prisma.sql`EXPLAIN (FORMAT JSON) ${sql.comparison}`,
          );
        },
        { timeout: 30000 },
      );
      report.canonicalCost.plan = compactCanonicalCostPlan(plan['QUERY PLAN']);
    } catch (error) {
      report.canonicalCost.planError = e4DiagnosticSafeError(error);
    }
    if (process.env.SRVF_E4_CANONICAL_JIT_ABBA === '1')
      await probeCanonicalJit(db, report.canonicalCost, sql.comparison, proof.units);
    if (process.env.SRVF_E4_CANONICAL_MEMORY_PAIR === '1')
      await probeCanonicalMemory(db, report.canonicalCost, sql.comparison, proof.units);
  } catch (error) {
    report.canonicalCost.planError = e4DiagnosticSafeError(error);
  }
}

export async function completeFixedMetadataPostOracle(
  report: Pick<Report, 'oracle' | 'firstCanonical32' | 'metadataPostOracle'>,
  verify: () => Promise<unknown>,
) {
  if (report.oracle !== 'COMPLETE' || report.firstCanonical32?.fullComparisonValidated !== true)
    throw new Error('E4 metadata pre-oracle incomplete');
  const first = report.firstCanonical32;
  report.oracle = 'NOT_RUN';
  report.metadataPostOracle = { status: 'ENTERED' };
  try {
    await verify();
    report.metadataPostOracle = { status: 'COMPLETE', firstCanonical32: report.firstCanonical32 };
    report.oracle = 'COMPLETE';
  } catch (error) {
    report.metadataPostOracle = { status: 'FAILED', firstCanonical32: report.firstCanonical32 };
    throw error;
  } finally {
    report.firstCanonical32 = first;
  }
}

async function assertDiagnosticProof(
  db: PrismaClient,
  versionId: string,
  units: number,
  maximum: boolean,
  report: Report,
) {
  const observedBase = diagnosticOracleClient(db, report);
  const observed =
    process.env.SRVF_E4_CANONICAL_FIRST32 === '1'
      ? firstCanonical32Client(observedBase, report)
      : observedBase;
  report.substage = 'ORACLE_PROOF_READ';
  const proof = await db.activitySettlementContributionRevision.findFirstOrThrow({
    where: { settlementVersionId: versionId },
    orderBy: { revision: 'desc' },
  });
  privateDiagnosticProofs.set(report, {
    revisionId: proof.id,
    sourceKindCode: proof.sourceKindCode,
    units,
  });
  expect(proof.evaluationCount).toBe(units);
  if (maximum) {
    expect(proof.recognizedPointsTotal.toFixed(2)).toBe('1000.00');
    await frozenE4Oracle(report)(observed, proof.id, units);
    if (report.firstCanonical32) report.firstCanonical32.fullComparisonValidated = true;
  } else {
    await frozenOrdinaryOracle(report)(observed, proof.id, units);
    report.substage = 'ORDINARY_DAY_POINTS';
    await assertOrdinaryDayOracle(observed, proof.id, units);
  }
  return proof;
}
// The full fixed 20251220 day oracle runs outside every measured business call.
async function assertOrdinaryDayOracle(db: PrismaClient, revisionId: string, units: number) {
  const source = readFileSync(
    resolve(
      dirname(ordinaryOraclePath),
      'activity-os-r5-e4-contribution-settlement-migration.e2e-spec.ts',
    ),
    'utf8',
  );
  const matches = [...source.matchAll(/const E4_P_DAY_ORACLE_SQL = String\.raw`([\s\S]*?)`;/gu)];
  expect(matches).toHaveLength(1);
  expect(createHash('sha256').update(matches[0][1]).digest('hex')).toBe(
    'a8cdf667c0632e832d10ea2912ebd510e84163097ddfc594f55d000746446274',
  );
  const rollback = new Error('E4 ordinary fixed day oracle rollback');
  let complete = false;
  try {
    await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout='30s'`;
        await tx.$executeRawUnsafe(
          matches[0][1].replace(
            'CREATE FUNCTION e4_day_points(',
            'CREATE FUNCTION pg_temp.e4_day_points_diagnostic_oracle(',
          ),
        );
        const [actual] = await tx.$queryRaw<
          {
            evaluations: number;
            refs: number;
            invalidAllocations: number;
            candidateDifferences: number;
            storedDifferences: number;
          }[]
        >`
        WITH actual AS MATERIALIZED (
          SELECT "sourceRefsJson",("recognizedPoints"*100)::integer AS hundredths,"beijingDayPointsJson"
          FROM "ParticipantContributionEvaluation" WHERE "contributionRevisionId"=${revisionId}
        ), refs AS MATERIALIZED (
          SELECT r.value->>'allocationRevisionId' AS allocation,r.value->>'sliceId' AS slice,e."timeCategoryCode" AS category
          FROM "ParticipantContributionEvaluation" e CROSS JOIN LATERAL jsonb_array_elements(e."sourceRefsJson") r(value)
          WHERE e."contributionRevisionId"=${revisionId}
        ), invalid AS (
          SELECT allocation FROM refs GROUP BY allocation HAVING count(*)<>5 OR count(DISTINCT slice)<>5
            OR count(*) FILTER (WHERE category='volunteer_service')<>2
            OR count(*) FILTER (WHERE category='training')<>1
            OR count(*) FILTER (WHERE category='organization')<>1
            OR count(*) FILTER (WHERE category='non_creditable')<>1
        ), comparisons AS (
          SELECT "beijingDayPointsJson" AS stored,pg_temp.e4_day_points_diagnostic_oracle("sourceRefsJson",hundredths) AS old,
            public.e4_day_points("sourceRefsJson",hundredths) AS candidate FROM actual
        ) SELECT count(*)::int AS evaluations,(SELECT count(*)::int FROM refs) AS refs,
          (SELECT count(*)::int FROM invalid) AS "invalidAllocations",
          count(*) FILTER (WHERE old IS DISTINCT FROM candidate)::int AS "candidateDifferences",
          count(*) FILTER (WHERE old IS DISTINCT FROM stored)::int AS "storedDifferences" FROM comparisons
      `;
        expect(actual).toEqual({
          evaluations: units,
          refs: (units / 4) * 5,
          invalidAllocations: 0,
          candidateDifferences: 0,
          storedDifferences: 0,
        });
        complete = true;
        throw rollback;
      },
      { timeout: 60000 },
    );
  } catch (error) {
    if (error !== rollback) throw error;
  }
  expect(complete).toBe(true);
  const [residue] = await db.$queryRaw<
    { count: number }[]
  >`SELECT count(*)::int AS count FROM pg_proc WHERE proname='e4_day_points_diagnostic_oracle'`;
  expect(residue.count).toBe(0);
}
const EMPTY_FACTS = {
  roots: 0,
  evaluations: 0,
  timeRoots: 0,
  buckets: 0,
  sources: 0,
  receipts: 0,
  audits: 0,
};
async function diagnosticFacts(observer: PrismaClient, activityId: string, operationKey: string) {
  const [facts] = await observer.$queryRaw<(typeof EMPTY_FACTS)[]>`
    WITH roots AS MATERIALIZED (SELECT id,"timeRevisionId" FROM "ActivitySettlementContributionRevision" WHERE "activityId"=${activityId} AND "operationKey"=${operationKey}),
    time_roots AS MATERIALIZED (SELECT id FROM "ActivitySettlementTimeRevision" WHERE "activityId"=${activityId})
    SELECT (SELECT count(*)::int FROM roots) AS roots,
      (SELECT count(*)::int FROM "ParticipantContributionEvaluation" WHERE "contributionRevisionId" IN (SELECT id FROM roots)) AS evaluations,
      (SELECT count(*)::int FROM time_roots) AS "timeRoots",
      (SELECT count(*)::int FROM "ParticipantSettlementTimeBucket" WHERE "timeRevisionId" IN (SELECT id FROM time_roots)) AS buckets,
      (SELECT count(*)::int FROM "ParticipantSettlementTimeBucketSource" WHERE "timeRevisionId" IN (SELECT id FROM time_roots)) AS sources,
      (SELECT count(*)::int FROM "ActivitySettlementTimeCommandReceipt" WHERE "activityId"=${activityId} AND "operationKey"=${operationKey} AND "operationCode"='prepare_time_settlement') AS receipts,
      (SELECT count(*)::int FROM audit_logs WHERE "resourceId"=${activityId} AND event='activity.time-settlement.command'
        AND context->'extra'->>'operationCode'='prepare_time_settlement' AND context->'extra'->>'replayed'='false'
        AND context->'extra'->>'timeRevisionId' IN (SELECT id FROM time_roots)) AS audits
  `;
  return facts;
}
async function measureOperation<T>(
  report: Report,
  stage: string,
  db: PrismaClient,
  work: () => Promise<T>,
): Promise<T> {
  if (report.stages.length >= 12) throw new Error('E4 bounded operation receipt refused');
  const engine: unknown = Reflect.get(db, '_engine');
  if (!engine || typeof engine !== 'object') throw new Error('E4 diagnostic engine unavailable');
  const observer = observeE4DiagnosticTransactionLifetime(engine);
  const anchor = performance.now();
  let outcome: 'COMPLETE' | 'FAILED' = 'FAILED',
    errorCategory = 'UNKNOWN';
  try {
    const result = await work();
    outcome = 'COMPLETE';
    errorCategory = 'NONE';
    return result;
  } catch (error) {
    errorCategory = e4DiagnosticErrorCategory(error);
    throw error;
  } finally {
    const wallMs = performance.now() - anchor;
    observer.restore();
    report.stages.push({ stage, wallMs, outcome, errorCategory, transaction: observer.snapshot() });
  }
}
async function holdDiagnosticActivityLock(db: PrismaClient, activityId: string) {
  let release!: () => void,
    acquired!: () => void,
    pid = 0,
    heldAt = 0,
    releasedAt = 0;
  const gate = new Promise<void>((resolve) => {
    release = () => {
      if (!releasedAt) releasedAt = performance.now();
      resolve();
    };
  });
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const done = db.$transaction(
    async (tx) => {
      const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      pid = backend.pid;
      await tx.$queryRaw`SELECT id FROM "Activity" WHERE id=${activityId} FOR UPDATE`;
      heldAt = performance.now();
      acquired();
      await gate;
    },
    { timeout: 15000 },
  );
  await Promise.race([
    ready,
    done.then(() => {
      throw new Error('E4 owned lock unavailable');
    }),
  ]);
  const fallback = setTimeout(release, 10000);
  void done.finally(() => clearTimeout(fallback)).catch(() => undefined);
  return { pid, release, done, heldMs: () => (releasedAt || performance.now()) - heldAt };
}
function observeDiagnosticLock(db: PrismaClient, pid: number, blockerPid?: number) {
  let stopped = false,
    failed = false,
    samples = 0,
    lockSamples = 0,
    blocked = false;
  let firstBlocked: number | undefined, lastBlocked: number | undefined;
  const started = performance.now();
  const loop = (async () => {
    while (!stopped && performance.now() - started < 100000 && samples < 1000) {
      try {
        const [row] = await db.$queryRaw<{ lockWait: boolean; ownedBlocker: boolean }[]>`
          SELECT wait_event_type='Lock' AS "lockWait",${blockerPid ?? -1}::int=ANY(pg_blocking_pids(pid)) AS "ownedBlocker"
          FROM pg_stat_activity WHERE pid=${pid} AND datname=current_database()
        `;
        if (!row) {
          failed = true;
          break;
        }
        samples++;
        if (row.lockWait) {
          lockSamples++;
          lastBlocked = performance.now();
          firstBlocked ??= lastBlocked;
          if (row.ownedBlocker) blocked = true;
        }
      } catch {
        failed = true;
        break;
      }
      if (!stopped) await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  })();
  return {
    releaseWhenBlocked: async (release: () => void) => {
      try {
        const deadline = performance.now() + 5000;
        while (!blocked && !failed && performance.now() < deadline)
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
        if (!blocked) throw new Error('E4 actual lock competition not observed');
        await new Promise<void>((resolve) => setTimeout(resolve, 2000));
      } finally {
        release();
      }
    },
    stop: async () => {
      stopped = true;
      await loop;
    },
    snapshot: () => ({
      status: failed || samples === 0 ? 'UNKNOWN' : 'OBSERVED',
      scope: 'EXACT_BACKEND_CURRENT_DATABASE',
      samples,
      lockSamples,
      blockedByOwnedBackend: blocked,
      sampledLockSpanMs:
        firstBlocked === undefined || lastBlocked === undefined ? null : lastBlocked - firstBlocked,
    }),
  };
}
async function completeDiagnosticSettlement(
  f: E4Fixture,
  source: Awaited<
    ReturnType<(typeof import('../helpers/activity-contribution-policy.fixture'))['createE4Source']>
  >,
  prepared: TimeSettlementReceiptResult,
  observer: PrismaClient,
  report: Report,
  checkpoint: ReturnType<typeof stageReceipt>,
  fixture: typeof import('../helpers/activity-contribution-policy.fixture'),
) {
  const units = diagnosticPopulation(report.scenario) * 4;
  const maximum = report.scenario === 'maximum';
  checkpoint.mark('SUBMIT', 'ENTER');
  report.substage = 'SUBMIT';
  const submitted = await measureOperation(report, 'SUBMIT', f.db, () =>
    fixture.submitE4Time(f, source, prepared),
  );
  const formalProof = await assertDiagnosticProof(
    observer,
    submitted.settlementVersionId,
    units,
    maximum,
    report,
  );

  checkpoint.mark('SUBMIT', 'COMPLETE');
  const version = await observer.attendanceSettlementVersion.findUniqueOrThrow({
    where: { id: submitted.settlementVersionId },
  });
  const expectation = {
    evidenceSealId: version.evidenceSealId,
    evidenceRevision: version.evidenceRevision,
    populationRevision: version.populationRevision,
    workflowRevision: version.workflowRevision,
    contentHash: version.contentHash,
  };
  const review = f.app.get(SettlementReviewService);
  checkpoint.mark('FIRST_REVIEW', 'ENTER');
  report.substage = 'FIRST_REVIEW';
  await measureOperation(report, 'FIRST_REVIEW', f.db, () =>
    review.firstReview(
      {
        activityId: submitted.activityId,
        actionCode: 'approve',
        expectation,
        operationKey: f.key('diagnostic_first'),
        requestHash: 'c'.repeat(64),
      },
      fixture.e4Actor(f.reviewer),
      fixture.E4_META,
    ),
  );
  expect(
    (await observer.attendanceSettlementVersion.findUniqueOrThrow({ where: { id: version.id } }))
      .statusCode,
  ).toBe('submitted');
  expect(
    (
      await observer.attendanceSettlementRun.findUniqueOrThrow({
        where: { id: version.settlementRunId },
      })
    ).statusCode,
  ).toBe('pending_final_review');
  await assertDiagnosticProof(observer, submitted.settlementVersionId, units, maximum, report);
  checkpoint.mark('FIRST_REVIEW', 'COMPLETE');
  checkpoint.mark('FINAL_REVIEW', 'ENTER');
  report.substage = 'FINAL_REVIEW';
  const final = await measureOperation(report, 'FINAL_REVIEW', f.db, () =>
    review.finalReview(
      {
        activityId: submitted.activityId,
        actionCode: 'approve',
        expectation,
        operationKey: f.key('diagnostic_final'),
        requestHash: 'd'.repeat(64),
      },
      fixture.e4Actor(f.finalReviewer),
      fixture.E4_META,
    ),
  );
  if (!final.ledgerPostingBatchId)
    throw new Error('E4 final review requires ledger preparation batch');
  await assertDiagnosticProof(observer, submitted.settlementVersionId, units, maximum, report);
  checkpoint.mark('FINAL_REVIEW', 'COMPLETE');
  checkpoint.mark('LEDGER', 'ENTER');
  report.substage = 'LEDGER';
  const preparation = f.app.get(LedgerPreparationService);
  const posting = f.app.get(LedgerPostingService);
  const batchId = final.ledgerPostingBatchId;
  const committed = await measureOperation(report, 'LEDGER', f.db, async () => {
    const job = await preparation.ensurePrepareJob(batchId);
    const items = await f.db.activityBatchJobItem.findMany({
      where: { jobId: job.jobId },
      orderBy: { itemKey: 'asc' },
    });
    for (const item of items) await preparation.prepareChunk(job.jobId, item.id);
    expect((await preparation.finalize(job.jobId)).batchStatus).toBe('ready');
    return posting.commitBatch(
      { postingBatchId: batchId, operationKey: f.key('diagnostic_ledger') },
      fixture.e4Actor(f.finalReviewer),
      fixture.E4_META,
    );
  });
  expect(committed.replayed).toBe(false);
  const credits = await observer.participationLedgerEntry.aggregate({
    where: { postingBatchId: batchId, entryTypeCode: 'contribution_credit' },
    _count: true,
    _sum: { recognizedPointsDelta: true },
  });
  expect(credits._count).toBe(diagnosticPopulation(report.scenario));
  expect(credits._sum.recognizedPointsDelta?.toFixed(2)).toBe(
    formalProof.recognizedPointsTotal.toFixed(2),
  );
  expect(
    (await observer.ledgerPostingBatch.findUniqueOrThrow({ where: { id: batchId } })).statusCode,
  ).toBe('committed');
  await assertDiagnosticProof(observer, submitted.settlementVersionId, units, maximum, report);
  report.ledger = { credits: credits._count, totalMatchesFrozenRoot: true, committed: true };
  checkpoint.mark('LEDGER', 'COMPLETE');
}

/** This closed Jest child is registered only through an IPC-supervised parent. */
function registerDiagnosticChild() {
  const head = process.env.SRVF_E4_DIAGNOSTIC_HEAD ?? '';
  const realStatistics = process.env.SRVF_E4_REAL_STATISTICS === '1';
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
    transactionMs: realStatistics ? 30000 : 90000,
    head,
    run: process.env.GITHUB_RUN_ID!,
    scenario: e4DiagnosticScenario(process.env.SRVF_E4_DIAGNOSTIC_SCENARIO),
    migration: 'NOT_VERIFIED',
    stages: [],
    coverage: process.env.SRVF_E4_SOURCE_JOIN
      ? 'PREPARE_SOURCE_JOIN_ONLY'
      : process.env.SRVF_E4_NATIVE_PREPARE_PLAN === '1'
        ? 'PREPARE_NATIVE_PLAN_ONLY'
        : process.env.SRVF_E4_FIXED_METADATA_MAX_ONCE === '1'
          ? 'PREPARE_ORACLE_AND_FIXED_METADATA_ONLY'
          : process.env.SRVF_E4_JOIN_KEY_CALIBRATION === '1'
            ? 'SMALL_JOIN_KEY_CALIBRATION_ONLY'
            : process.env.SRVF_E4_JOIN_KEY_ONCE === '1'
              ? 'PREPARE_ORACLE_AND_JOIN_KEY_ONLY'
              : process.env.SRVF_E4_SHARED_GUARD_ONCE === '1'
                ? 'PREPARE_ORACLE_AND_SHARED_GUARD_ONLY'
                : process.env.SRVF_E4_CANONICAL_FIRST32 === '1'
                  ? 'PREPARE_AND_FIRST_ORACLE_ONLY'
                  : 'FULL_SETTLEMENT',
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
        scenario: process.env.SRVF_E4_DIAGNOSTIC_SCENARIO,
      });
      frozenE4OracleSource();
      frozenOrdinaryOracleSource();
      verifyDiagnosticMigrationSource();
      if (process.env.SRVF_E4_NATIVE_PREPARE_PLAN === '1' || process.env.SRVF_E4_SOURCE_JOIN)
        readNativeCapability();
      if (['ordinary-500', 'statistics-500'].includes(process.env.SRVF_E4_SOURCE_JOIN ?? ''))
        readSourceJoinCalibration();
      if (process.env.SRVF_E4_FIXED_METADATA_MAX_ONCE === '1') metadataCanonicalCandidateSource();
      if (realStatistics) readRealStatisticsCapability();
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
  describe('E4 DIAGNOSTIC_ONLY one finite scenario', () => {
    it('records original complete prepare and commit with the full frozen oracle', async () => {
      // The database installer has finished loading .env.test; capture the gate before Nest config.
      const context = e4DiagnosticContext({
        purpose: 'DIAGNOSTIC_ONLY',
        scope: 'app_test_w98',
        sourceHead: head,
        databaseUrl: process.env.DATABASE_URL ?? '',
        appEnv: process.env.APP_ENV ?? '',
        scenario: process.env.SRVF_E4_DIAGNOSTIC_SCENARIO,
      });
      const restoreGate = installE4DiagnosticFixtureGate(context);
      let f: E4Fixture | undefined, db: DiagnosticDatabase | undefined;
      const auxiliary: PrismaClient[] = [];
      let releaseOwnedLock: (() => void) | undefined;
      let joinKeyFactsContext: { activityId: string; operationKey: string } | undefined;
      let statisticsControl: ReturnType<typeof installRealStatistics> | undefined;
      try {
        f = await fixture.createE4Fixture();
        if (realStatistics)
          statisticsControl = installRealStatistics(
            f.app.get(ActivityContributionSettlementService),
            f.app.get(ActivityTimeSettlementAuditRecorder),
          );
        checkpoint.mark('FIXTURE_BOOTSTRAP', 'COMPLETE');
        checkpoint.mark('SOURCE_BUILD', 'ENTER');
        report.substage = 'CATALOG_143';
        await verifyDiagnosticDatabase(f.db);
        report.migration = 'VERIFIED_143';
        const maximum = report.scenario === 'maximum';
        const identities = diagnosticPopulation(report.scenario);
        report.scenarioShape = {
          identities,
          segments: maximum ? 10000 : identities,
          slices: maximum ? 50000 : identities * 5,
          units: identities * 4,
        };
        report.substage = maximum ? 'MAXIMUM_SOURCE_ENTRY' : 'ORDINARY_SYNC_SOURCE_ENTRY';
        const sourceStarted = performance.now();
        const source = await (
          maximum
            ? fixture.createMaximumE4Source(f)
            : createDiagnosticE4Source(f, identities as 1 | 100 | 500, fixture.createE4Source)
        ).finally(() => {
          report.sourceBuildMs = performance.now() - sourceStarted;
        });
        if (statisticsControl) {
          report.substage = 'SOURCE_BUILD_STATISTICS';
          const statisticsStarted = performance.now();
          await f.db.$transaction((tx) => statisticsControl!.source(tx), { timeout: 30000 });
          report.sourceBuildMs! += performance.now() - statisticsStarted;
        }
        report.substage = 'SOURCE_SHAPE';
        expect(
          await f.db.activityParticipationIdentity.count({
            where: { activityId: source.activityId },
          }),
        ).toBe(identities);
        expect(
          await f.db.participantTimeAllocationRevision.count({
            where: { activityId: source.activityId },
          }),
        ).toBe(maximum ? 10000 : identities);
        expect(
          await f.db.participantTimeAllocationSlice.count({
            where: { activityId: source.activityId },
          }),
        ).toBe(maximum ? 50000 : identities * 5);
        checkpoint.mark('SOURCE_BUILD', 'COMPLETE');
        checkpoint.mark('PREPARE', 'ENTER');
        report.substage = 'PREPARE';
        const measuredUrl = new URL(process.env.DATABASE_URL!);
        measuredUrl.searchParams.set('connection_limit', '1');
        db = new DiagnosticDatabase({
          datasources: { db: { url: measuredUrl.toString() } },
          log: [{ emit: 'event', level: 'query' }],
        });
        await assertConnectedTestDatabase(db);
        const limits =
          maximum && !realStatistics ? installE4DiagnosticLimits(db, context) : undefined;
        const measuredClient = limits?.client ?? db;
        const observer = new PrismaClient();
        auxiliary.push(observer);
        await assertConnectedTestDatabase(observer);
        const [{ pid }] = await db.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        if (process.env.SRVF_E4_SOURCE_JOIN)
          report.sourceJoinStats = { beforePrepare: await sourceJoinStatistics(db) };
        const command = {
          expectedDraftVersion: source.expectation.expectedDraftVersion,
          expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,
          operationKey: f.key('diagnostic_prepare'),
          expectedTimeRevision: 0,
        };
        if (process.env.SRVF_E4_JOIN_KEY_ONCE === '1')
          joinKeyFactsContext = {
            activityId: source.activityId,
            operationKey: command.operationKey,
          };
        const beforeFacts = await diagnosticFacts(
          observer,
          source.activityId,
          command.operationKey,
        );
        expect(beforeFacts).toEqual(EMPTY_FACTS);
        const blocker =
          report.scenario === 'lock-contention'
            ? await holdDiagnosticActivityLock(f.db, source.activityId)
            : undefined;
        if (blocker) releaseOwnedLock = blocker.release;
        const lock = observeDiagnosticLock(observer, pid, blocker?.pid);
        const injected = new Error('E4 diagnostic controlled rollback after actual barrier');
        let barrierCompleted = false;
        let injection: jest.SpyInstance | undefined;
        if (report.scenario === 'failure-retry') {
          const recorder = f.app.get(ActivityTimeSettlementAuditRecorder);
          const originalLog = recorder.log.bind(recorder);
          injection = jest.spyOn(recorder, 'log').mockImplementationOnce(async (...args) => {
            await originalLog(...args);
            const tx = args[0];
            const execute = tx.$executeRaw.bind(tx);
            jest.spyOn(tx, '$executeRaw').mockImplementationOnce((query, ...values: unknown[]) => {
              const text = ('strings' in query ? query.strings : [...query])
                .join(' ')
                .replace(/\s+/gu, ' ')
                .trim();
              expect(text).toBe(
                'SET CONSTRAINTS public.astr_parent_complete_guard, public.e4_revision_complete_guard IMMEDIATE',
              );
              return execute(query, ...values).then(() => {
                barrierCompleted = true;
                throw injected;
              }) as never;
            });
          });
        }
        const contributions = f.app.get(ActivityContributionSettlementService),
          access = f.app.get(ActivityTimeSettlementAccessService),
          segments = f.app.get(ParticipationSegmentFacade);
        const reader = new ActivityTimeSettlementQueryService(
          measuredClient,
          access,
          segments,
          f.app.get(ActivityContributionSettlementQueryService),
        );
        const measured = new ActivityTimeSettlementService(
          measuredClient,
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
        let nativeCapture: NativePrepareCapture | undefined;
        const realPrepareQueries = { queries: 0, e4Queries: 0, evaluationInserts: 0, barriers: 0 };
        db.$on('query', (event) => {
          if (realStatistics) {
            if (!/^\s*(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)\b/iu.test(event.query))
              realPrepareQueries.queries++;
            if (
              /(?:ActivitySettlementContributionRevision|ParticipantContributionEvaluation|e4_assert_|e4_revision_complete_guard)/u.test(
                event.query,
              )
            )
              realPrepareQueries.e4Queries++;
            if (/^\s*INSERT INTO "ParticipantContributionEvaluation"/u.test(event.query))
              realPrepareQueries.evaluationInserts++;
            if (/^\s*SET CONSTRAINTS public\.astr_parent_complete_guard,/u.test(event.query))
              realPrepareQueries.barriers++;
          }
          nativeCapture?.event(event.query, event.duration);
          native.queryEvent(event.query, event.duration);
          if (!/^\s*(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)\b/iu.test(event.query))
            phase.query(
              /^\s*(SELECT|WITH)\b/iu.test(event.query) ? 'READ' : 'WRITE',
              event.duration,
            );
        });
        if (process.env.SRVF_E4_NATIVE_PREPARE_PLAN === '1') {
          report.substage = 'NATIVE_PLAN_SESSION';
          report.nativePreparePlan = { status: 'ENTERED' };
          try {
            nativeCapture = await startNativePrepareCapture(db, pid);
          } catch (error) {
            report.nativePreparePlan = {
              status: 'INCOMPLETE',
              reason: nativePlanFailureCategory(error),
            };
            throw error;
          }
          report.substage = 'PREPARE';
        }
        const anchor = performance.now();
        phase.enableBoundaryTimeline(anchor);
        requests.begin();
        native.begin(anchor);
        phase.begin();
        let outcome: 'OK' | 'FAIL' = 'FAIL';
        let nativeCaptureError: Error | undefined;
        let prepared: Awaited<ReturnType<ActivityTimeSettlementService['prepare']>> | undefined;
        try {
          const operation = measureOperation(report, 'PREPARE', db, () =>
            measured.prepare(
              source.activityId,
              command,
              fixture.e4Actor(f!.creator, true),
              fixture.E4_META,
            ),
          );
          // Observe the exact backend, then release the owned real row lock. No workload SQL is replayed.
          const releaseAfterObservation = blocker
            ? lock.releaseWhenBlocked(blocker.release)
            : Promise.resolve();
          void releaseAfterObservation.catch(() => undefined);
          try {
            prepared = await operation;
          } catch (error) {
            if (report.scenario !== 'failure-retry' || error !== injected || !barrierCompleted)
              throw error;
            checkpoint.mark('ROLLBACK', 'ENTER');
            const rolledBackFacts = await diagnosticFacts(
              observer,
              source.activityId,
              command.operationKey,
            );
            expect(rolledBackFacts).toEqual(beforeFacts);
            report.recovery = {
              barrierCompleted,
              expectedErrorIdentity: true,
              sevenFactsRolledBack: true,
            };
            checkpoint.mark('ROLLBACK', 'COMPLETE');
          } finally {
            injection?.mockRestore();
            try {
              await releaseAfterObservation;
            } finally {
              blocker?.release();
              try {
                await blocker?.done;
              } finally {
                await lock.stop();
                report.lock = { ...lock.snapshot(), heldMs: blocker?.heldMs() ?? null };
              }
            }
          }
          outcome = 'OK';
        } finally {
          report.prepareMs = report.stages.find((stage) => stage.stage === 'PREPARE')?.wallMs;
          native.finish();
          native.restore();
          requests.finish();
          requests.restore();
          phase.finish(outcome);
          phase.restore();
          transaction.restore();
          limits?.restore();
          report.phase = phase.snapshot();
          report.boundary = { method: phase.boundarySnapshot(), native: native.snapshot() };
          report.requests = requests.snapshot();
          report.transaction = transaction.snapshot();
          report.limits = limits?.snapshot() ?? {
            requestedTransactionMs: 30000,
            actualTransactionMs: 30000,
            calls: 0,
            restored: true,
          };
          report.internal = {
            status: 'NOT_RUN',
            reason: 'BUDGET_ASSESSMENT_NO_INTERNAL_PLAN_OBSERVER',
          };
          if (nativeCapture) {
            try {
              const captured = await nativeCapture.finish(outcome === 'OK');
              // Keep the full plan independently bounded: phase/request timelines must not
              // compete with native nodes for the original64KiB report envelope.
              const artifact = {
                head,
                run: report.run,
                scenario: report.scenario,
                purpose: 'DIAGNOSTIC_ONLY',
                coverage: 'PREPARE_NATIVE_PLAN_ONLY',
                nativePreparePlan: captured,
              };
              writeBounded(join(privateDir, 'native-plan.json'), artifact);
              const { plans, ...summary } = captured;
              report.nativePreparePlan = {
                ...summary,
                planArtifactSha256: createHash('sha256')
                  .update(JSON.stringify(artifact) + '\n')
                  .digest('hex'),
                planCounts: {
                  records: plans.records.length,
                  nodes: plans.records.reduce((sum, row) => sum + row.nodes.length, 0),
                  malformed: plans.malformed,
                },
              };
              report.internalSqlPlan = captured.status === 'COMPLETE' ? 'OBSERVED' : 'NOT_RUN';
              if (outcome === 'OK' && captured.status !== 'COMPLETE')
                nativeCaptureError = new Error('E4 native evidence incomplete');
            } catch (error) {
              if (
                !report.nativePreparePlan ||
                Reflect.get(report.nativePreparePlan, 'status') === 'ENTERED'
              )
                report.nativePreparePlan = {
                  ...nativeCapture.partial(),
                  reason: nativePlanFailureCategory(error),
                };
              if (outcome === 'OK')
                nativeCaptureError =
                  error instanceof Error ? error : new Error('E4 native capture failed');
            }
          }
        }
        if (nativeCaptureError) throw nativeCaptureError;
        if (realStatistics) {
          expect(report.prepareMs).toBeLessThan(30000);
          expect(realPrepareQueries.queries).toBeGreaterThan(0);
          expect(realPrepareQueries.queries).toBeLessThanOrEqual(400);
          expect(realPrepareQueries.e4Queries).toBeLessThanOrEqual(12);
          expect(realPrepareQueries.evaluationInserts).toBe(1);
          expect(realPrepareQueries.barriers).toBe(1);
          report.realStatistics = { prepareQueries: realPrepareQueries };
        }
        if (process.env.SRVF_E4_SOURCE_JOIN)
          report.sourceJoinStats = {
            ...(report.sourceJoinStats as object),
            afterPrepare: await sourceJoinStatistics(db),
          };
        checkpoint.mark('PREPARE', 'COMPLETE');
        if (report.scenario === 'lock-contention') {
          expect(lock.snapshot()).toMatchObject({
            status: 'OBSERVED',
            blockedByOwnedBackend: true,
          });
          expect(blocker!.heldMs()).toBeGreaterThanOrEqual(2000);
        }
        if (report.scenario === 'failure-retry') {
          checkpoint.mark('RETRY', 'ENTER');
          prepared = await measureOperation(report, 'RETRY', db, () =>
            measured.prepare(
              source.activityId,
              command,
              fixture.e4Actor(f!.creator, true),
              fixture.E4_META,
            ),
          );
          checkpoint.mark('RETRY', 'COMPLETE');
          const retryFacts = await diagnosticFacts(
            observer,
            source.activityId,
            command.operationKey,
          );
          checkpoint.mark('REPLAY', 'ENTER');
          const replay = await measureOperation(report, 'REPLAY', db, () =>
            measured.prepare(
              source.activityId,
              command,
              fixture.e4Actor(f!.creator, true),
              fixture.E4_META,
            ),
          );
          expect(replay).toEqual(prepared);
          expect(replay.timeRevisionId).toBe(prepared.timeRevisionId);
          expect(await diagnosticFacts(observer, source.activityId, command.operationKey)).toEqual(
            retryFacts,
          );
          report.recovery = {
            ...(report.recovery as object),
            retryCommitted: true,
            replayed: true,
            noDuplicateFacts: true,
          };
          checkpoint.mark('REPLAY', 'COMPLETE');
        }
        checkpoint.mark('ORACLE', 'ENTER');
        const units = identities * 4;
        expect(prepared!.bucketCount).toBe(units);
        expect(prepared!.sourceCount).toBe(maximum ? 40000 : identities * 4);
        const oracleStarted = performance.now();
        await assertDiagnosticProof(
          observer,
          prepared!.settlementVersionId,
          units,
          maximum,
          report,
        ).finally(() => {
          report.oracleMs = performance.now() - oracleStarted;
        });
        const preparedFacts = await diagnosticFacts(
          observer,
          source.activityId,
          command.operationKey,
        );
        expect(preparedFacts).toEqual({
          roots: 1,
          evaluations: units,
          timeRoots: 1,
          buckets: units,
          sources: maximum ? 40000 : units,
          receipts: 1,
          audits: 1,
        });
        report.facts = preparedFacts;
        if (process.env.SRVF_E4_SOURCE_JOIN) {
          report.oracle = 'COMPLETE';
          report.substage = 'SOURCE_JOIN_COMPARISON';
          await probeSourceJoin(db, report, privateDir);
          expect(await diagnosticFacts(observer, source.activityId, command.operationKey)).toEqual(
            preparedFacts,
          );
          report.substage = 'SOURCE_JOIN_POST_ORACLE';
          report.sourceJoinPostOracle = 'ENTERED';
          await assertDiagnosticProof(
            observer,
            prepared!.settlementVersionId,
            units,
            false,
            report,
          );
          report.sourceJoinPostOracle = 'COMPLETE';
        }
        if (
          process.env.SRVF_E4_JOIN_KEY_ONCE === '1' ||
          process.env.SRVF_E4_JOIN_KEY_CALIBRATION === '1'
        ) {
          report.oracle = 'COMPLETE';
          report.substage = 'ORACLE_JOIN_KEY_CANDIDATE';
          await probeJoinKeyCandidate(db, report);
          expect(await diagnosticFacts(observer, source.activityId, command.operationKey)).toEqual(
            preparedFacts,
          );
          if (process.env.SRVF_E4_JOIN_KEY_CALIBRATION === '1')
            await assertDiagnosticProof(observer, prepared!.settlementVersionId, 4, false, report);
          if (process.env.SRVF_E4_FIXED_METADATA_MAX_ONCE === '1') {
            await completeFixedMetadataPostOracle(report, () =>
              assertDiagnosticProof(observer, prepared!.settlementVersionId, 8000, true, report),
            );
          }
        }
        if (process.env.SRVF_E4_SHARED_GUARD_ONCE === '1') {
          report.oracle = 'COMPLETE';
          report.substage = 'ORACLE_SHARED_GUARD_ACTUAL_PLAN';
          await probeSharedGuard(db, report);
          expect(await diagnosticFacts(observer, source.activityId, command.operationKey)).toEqual(
            preparedFacts,
          );
        }
        checkpoint.mark('ORACLE', 'COMPLETE');
        if (process.env.SRVF_E4_SOURCE_JOIN) {
          expect(report.sourceJoinComparison).toMatchObject({
            status: 'COMPLETE',
            sameBackend: true,
            ownedBackendGone: true,
          });
          report.status = 'COMPLETE';
          report.oracle = 'COMPLETE';
          report.budgetRecommendation =
            process.env.SRVF_E4_SOURCE_JOIN === 'statistics-500'
              ? 'TEST_ONLY_ANALYZE_CONDITIONAL_RESULTS_NOT_COLD_START_ACCEPTANCE'
              : 'SINGLE_SOURCE_JOIN_VARIABLE_NO_METADATA_JIT_OR_BUDGET_CHANGE';
        } else if (process.env.SRVF_E4_NATIVE_PREPARE_PLAN === '1') {
          expect(report.nativePreparePlan).toMatchObject({
            status: 'COMPLETE',
            sameBackend: true,
            tracingDisabledAfter: true,
          });
          report.status = 'COMPLETE';
          report.oracle = 'COMPLETE';
          report.budgetRecommendation =
            'ONE_INSTRUMENTED_ORIGINAL500_PREPARE_ONLY_NO_MAXIMUM_OR_OPTIMIZATION_CLAIM';
        } else if (process.env.SRVF_E4_JOIN_KEY_CALIBRATION === '1') {
          report.status = 'COMPLETE';
          report.budgetRecommendation =
            'SMALL_TOOL_CALIBRATION_ONLY_NO_MAXIMUM_OR_PERFORMANCE_CLAIM';
        } else if (process.env.SRVF_E4_FIXED_METADATA_MAX_ONCE === '1') {
          expect(report.metadataPostOracle?.status).toBe('COMPLETE');
          report.oracle = 'COMPLETE';
          report.status = 'COMPLETE';
          report.budgetRecommendation =
            'ONE_FIXED_METADATA_ABBA_SAMPLE_NO_FULL_CHAIN_FORMAL_BUDGET_OR_PERCENTILE_CLAIM';
        } else if (process.env.SRVF_E4_CANONICAL_FIRST32 === '1') {
          expect(report.firstCanonical32?.fullComparisonValidated).toBe(true);
          report.oracle = 'COMPLETE';
          report.status = 'COMPLETE';
          report.budgetRecommendation = 'FIRST_ORACLE_ONLY_NO_FULL_CHAIN_OR_FORMAL_BUDGET_CLAIM';
        } else {
          await completeDiagnosticSettlement(
            f,
            source,
            prepared!,
            observer,
            report,
            checkpoint,
            fixture,
          );
          if (statisticsControl) {
            await verifyDiagnosticDatabase(observer);
            await verifyDiagnosticGuards(observer);
            statisticsControl.complete();
          }
          expect(
            report.stages.every(
              (stage) =>
                stage.transaction.status === 'COMPLETE' &&
                stage.transaction.transactions.length > 0,
            ),
          ).toBe(true);
          report.oracle = 'COMPLETE';
          report.budgetRecommendation = maximum
            ? realStatistics
              ? 'REAL_FULL_CHAIN_TEST_ONLY_STATISTICS_ORIGINAL_BUDGETS_NOT_COLD_START_ACCEPTANCE'
              : 'ONE_SAMPLE_ONLY_KEEP_FORMAL_30_AND_DO_NOT_SELECT_NEW_BUDGET'
            : 'ORIGINAL_BUDGETS_OBSERVED_ONE_SAMPLE_NO_PERCENTILE_OR_HEADROOM_CLAIM';
          report.status = 'COMPLETE';
        }
      } catch (error) {
        report.status = 'FAILED';
        report.failureStage = checkpoint.lastStage();
        report.errorSubstage = report.substage;
        report.error = e4DiagnosticSafeError(error);
        if (
          process.env.SRVF_E4_JOIN_KEY_ONCE === '1' &&
          process.env.SRVF_E4_FIXED_METADATA_MAX_ONCE !== '1' &&
          report.errorSubstage === 'ORACLE_CANONICAL_DOCUMENT' &&
          db &&
          f &&
          joinKeyFactsContext
        ) {
          try {
            joinKeyOracleGate(report);
            const before = await diagnosticFacts(
              f.db,
              joinKeyFactsContext.activityId,
              joinKeyFactsContext.operationKey,
            );
            expect(before).toEqual({
              roots: 1,
              evaluations: 8000,
              timeRoots: 1,
              buckets: 8000,
              sources: 40000,
              receipts: 1,
              audits: 1,
            });
            report.facts = before;
            await probeJoinKeyCandidate(db, report);
            expect(
              await diagnosticFacts(
                f.db,
                joinKeyFactsContext.activityId,
                joinKeyFactsContext.operationKey,
              ),
            ).toEqual(before);
            await joinKeyPostFailureOracle(db, report);
          } catch (verificationError) {
            report.joinKeyVerificationError = e4DiagnosticSafeError(verificationError);
          }
        }
        if (
          process.env.SRVF_E4_CANONICAL_COST_ONLY === '1' &&
          report.errorSubstage === 'ORACLE_CANONICAL_DOCUMENT'
        ) {
          const proof = privateDiagnosticProofs.get(report);
          if (proof) await probeCanonicalCosts(db ?? f!.db, report, proof);
        }
        report.budgetRecommendation = 'KEEP_FORMAL_BUDGETS_FAILURE_REQUIRES_STAGE_SPECIFIC_REVIEW';
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
          if (statisticsControl) {
            try {
              statisticsControl.restore();
              const artifact = {
                head,
                run: report.run,
                scenario: report.scenario,
                purpose: 'DIAGNOSTIC_ONLY',
                realStatistics: statisticsControl.snapshot(),
              };
              const reference = writeRealStatisticsArtifact(privateDir, artifact);
              report.realStatistics = {
                ...(report.realStatistics as object),
                status: artifact.realStatistics.status,
                lastPoint: artifact.realStatistics.lastPoint,
                restored: artifact.realStatistics.restored,
                conditionalOnly: true,
                ...reference,
              };
            } catch (error) {
              report.status = 'FAILED';
              report.realStatistics = {
                status: 'RESTORE_OR_EVIDENCE_FAILED',
                error: e4DiagnosticSafeError(error),
              };
            }
          }
          // All connections must close before the existing normal DROP and lease release.
          checkpoint.mark('CLEANUP', 'ENTER');
          try {
            try {
              releaseOwnedLock?.();
              await Promise.all(auxiliary.map((client) => client.$disconnect()));
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
    }, 550000);
  });
}

export function calibrationCleanupSql() {
  return `BEGIN READ ONLY;
SET LOCAL statement_timeout='5s';
WITH lease AS (
  SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted
    AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
    AND classid=((hashtextextended('SRVF:test:D3:app_test_w98',0)>>32)&4294967295)::oid
    AND objid=(hashtextextended('SRVF:test:D3:app_test_w98',0)&4294967295)::oid AND objsubid=1
)
SELECT json_build_object(
  'observer',EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=pg_backend_pid() AND datname=current_database()),
  'scope',current_database()='postgres' AND inet_server_addr() IS NULL,
  'pg16',current_setting('server_version_num')::int BETWEEN 160000 AND 169999,
  'databases',(SELECT count(*) FROM pg_database WHERE datname='app_test_w98'),
  'clients',(SELECT count(*) FROM pg_stat_activity WHERE datname='app_test_w98'),
  'leaseBackends',(SELECT count(DISTINCT pid) FROM lease),
  'leaseLocks',(SELECT count(*) FROM lease));
ROLLBACK;
`;
}

function observeDiagnosticCleanup(timeout: number) {
  if (timeout !== 10000) return e4DiagnosticCleanupReceipt(null);
  try {
    const raw = execFileSync(
      'docker',
      [
        'exec',
        'u-nest-api-postgres',
        'psql',
        '--no-psqlrc',
        '-qtA',
        '-U',
        'postgres',
        '-d',
        'postgres',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        calibrationCleanupSql(),
      ],
      { encoding: 'utf8', timeout, maxBuffer: 8192, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return e4DiagnosticCleanupReceipt(JSON.parse(raw));
  } catch {
    return e4DiagnosticCleanupReceipt(null);
  }
}

export async function runDiagnosticParent() {
  const parentStarted = performance.now();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  requireDiagnosticEnvironment(process.env, head);
  if (
    process.platform !== 'linux' ||
    execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
  )
    throw new Error('E4 clean Linux checkout required');
  frozenE4OracleSource();
  frozenOrdinaryOracleSource();
  verifyDiagnosticMigrationSource();
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
      transactionMs: process.env.SRVF_E4_REAL_STATISTICS === '1' ? 30000 : 90000,
      head,
      run: process.env.GITHUB_RUN_ID!,
      scenario: e4DiagnosticScenario(process.env.SRVF_E4_DIAGNOSTIC_SCENARIO),
      migration: 'NOT_VERIFIED',
      stages: [],
      coverage: process.env.SRVF_E4_SOURCE_JOIN
        ? 'PREPARE_SOURCE_JOIN_ONLY'
        : process.env.SRVF_E4_NATIVE_PREPARE_PLAN === '1'
          ? 'PREPARE_NATIVE_PLAN_ONLY'
          : process.env.SRVF_E4_FIXED_METADATA_MAX_ONCE === '1'
            ? 'PREPARE_ORACLE_AND_FIXED_METADATA_ONLY'
            : process.env.SRVF_E4_JOIN_KEY_CALIBRATION === '1'
              ? 'SMALL_JOIN_KEY_CALIBRATION_ONLY'
              : process.env.SRVF_E4_JOIN_KEY_ONCE === '1'
                ? 'PREPARE_ORACLE_AND_JOIN_KEY_ONLY'
                : process.env.SRVF_E4_SHARED_GUARD_ONCE === '1'
                  ? 'PREPARE_ORACLE_AND_SHARED_GUARD_ONLY'
                  : process.env.SRVF_E4_CANONICAL_FIRST32 === '1'
                    ? 'PREPARE_AND_FIRST_ORACLE_ONLY'
                    : 'FULL_SETTLEMENT',
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
        data.scenario !== report.scenario ||
        data.purpose !== 'DIAGNOSTIC_ONLY' ||
        data.acceptance !== 'NOT_AN_ACCEPTANCE_RESULT' ||
        data.transactionMs !== (process.env.SRVF_E4_REAL_STATISTICS === '1' ? 30000 : 90000) ||
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
    const cleanup =
      process.env.SRVF_E4_REAL_STATISTICS === '1' ||
      process.env.SRVF_E4_SOURCE_JOIN ||
      process.env.SRVF_E4_NATIVE_PREPARE_PLAN === '1' ||
      process.env.SRVF_E4_JOIN_KEY_CALIBRATION === '1' ||
      process.env.SRVF_E4_JOIN_KEY_ONCE === '1'
        ? observeDiagnosticCleanup(e4DiagnosticCleanupAllowance(performance.now() - parentStarted))
        : undefined;
    if (cleanup && cleanup.status !== 'OBSERVED_ABSENT' && report.status === 'COMPLETE')
      report.status = 'UNKNOWN';
    mkdirSync(dirname(output), { recursive: true });
    const closedReport = {
      ...report,
      process: processResult,
      stage,
      interrupted,
      ...(cleanup ? { independentCleanup: cleanup } : {}),
      databaseCleanup: cleanup
        ? cleanup.status
        : !interrupted &&
            !processResult.stopped &&
            processResult.exitCode === 0 &&
            processResult.cleanupConfirmed
          ? 'NORMAL_DROP_AND_LEASE_RELEASE'
          : 'UNKNOWN',
    };
    if (process.env.SRVF_E4_REAL_STATISTICS === '1') {
      const ref = report.realStatistics as
        | { file?: string; sha256?: string; status?: string; restored?: boolean }
        | undefined;
      try {
        if (ref?.file !== 'real-statistics.json') throw new Error('missing');
        const raw = readFileSync(join(privateDir, ref.file));
        if (raw.length > 65536 || createHash('sha256').update(raw).digest('hex') !== ref.sha256)
          throw new Error('hash');
        const artifact = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (
          artifact.head !== head ||
          artifact.run !== report.run ||
          artifact.scenario !== 'maximum'
        )
          throw new Error('binding');
        if (report.status === 'COMPLETE' && (ref.status !== 'COMPLETE' || ref.restored !== true))
          throw new Error('incomplete');
        writeBounded(join(dirname(output), ref.file), artifact);
      } catch {
        closedReport.status = 'FAILED';
      }
    }
    if (process.env.SRVF_E4_SOURCE_JOIN) {
      const comparison = report.sourceJoinComparison as
        | { plans?: { file: string; sha256: string }[] }
        | undefined;
      const refs = comparison?.plans ?? [];
      if (
        refs.length !==
          (process.env.SRVF_E4_SOURCE_JOIN === 'small'
            ? 2
            : process.env.SRVF_E4_SOURCE_JOIN === 'statistics-500'
              ? 5
              : 4) &&
        closedReport.status === 'COMPLETE'
      )
        closedReport.status = 'UNKNOWN';
      for (const [index, ref] of refs.entries()) {
        if (
          ref.file !== `source-join-plan-${index}.json` ||
          index >= (process.env.SRVF_E4_SOURCE_JOIN === 'statistics-500' ? 5 : 4)
        )
          throw new Error('E4 source join sidecar path refused');
        try {
          const raw = readFileSync(join(privateDir, ref.file));
          if (raw.length > 65536 || createHash('sha256').update(raw).digest('hex') !== ref.sha256)
            throw new Error('binding');
          const artifact = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (
            artifact.head !== head ||
            artifact.run !== report.run ||
            artifact.index !== index ||
            artifact.coverage !== 'PREPARE_SOURCE_JOIN_ONLY'
          )
            throw new Error('binding');
          writeBounded(join(dirname(output), ref.file), artifact);
        } catch {
          closedReport.status = 'FAILED';
        }
      }
    }
    if (process.env.SRVF_E4_NATIVE_PREPARE_PLAN === '1') {
      const file = join(privateDir, 'native-plan.json');
      try {
        const raw = readFileSync(file);
        if (raw.length > 65536) throw new Error('bound');
        const data = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (
          data.head !== head ||
          data.run !== report.run ||
          data.scenario !== report.scenario ||
          data.purpose !== 'DIAGNOSTIC_ONLY' ||
          data.coverage !== 'PREPARE_NATIVE_PLAN_ONLY'
        )
          throw new Error('binding');
        const expected =
          report.nativePreparePlan && Reflect.get(report.nativePreparePlan, 'planArtifactSha256');
        if (expected !== createHash('sha256').update(raw).digest('hex'))
          closedReport.status = 'UNKNOWN';
        writeBounded(join(dirname(output), 'native-plan.json'), data);
      } catch {
        closedReport.status = 'FAILED';
        writeBounded(join(dirname(output), 'native-plan.json'), {
          head,
          run: report.run,
          scenario: report.scenario,
          purpose: 'DIAGNOSTIC_ONLY',
          coverage: 'PREPARE_NATIVE_PLAN_ONLY',
          nativePreparePlan: report.nativePreparePlan ?? { status: 'NOT_CAPTURED' },
          reason: 'NATIVE_SIDECAR_UNAVAILABLE',
        });
      }
    }
    writeBounded(output, closedReport);
    return closedReport.status === 'COMPLETE' ? 0 : 1;
  } finally {
    emergency();
    process.removeListener('exit', emergency);
    process.removeListener('SIGTERM', interrupt);
    process.removeListener('SIGINT', interrupt);
    rmSync(privateDir, { recursive: true, force: true });
  }
}
export const SOURCE_JOIN_BASELINE_SHA =
  'fa1c0f752201ffd118b46e0dae80137584394d2b47b8ae59c9eb309709c91b3c';
export const SOURCE_JOIN_REUSABLE_SMALL = {
  run: '38648131761',
  head: '70b14e9cb539ab19de0904c508fdb79449ce96ef',
  resultSha256: '6349177a027dc4cbac0ff9e9796e439d9a7ee46eaa513c1c976090848c7a51fc',
  candidateSha256: '541f765f9f1357a1d0ea45d6ba91d3b39abb597207d1a40fbb1dbee4fc894860',
} as const;
export function validateSourceJoinCalibration(
  value: unknown,
  head: string,
  forRun: string,
  reused = false,
) {
  if (!value || typeof value !== 'object') throw new Error('E4 source join calibration missing');
  const r = value as Record<string, unknown>;
  if (
    r.head !== head ||
    r.forRun !== forRun ||
    r.status !== 'VERIFIED_SMALL' ||
    typeof r.smallRun !== 'string' ||
    !/^\d+$/u.test(r.smallRun) ||
    r.smallRun === forRun ||
    r.candidateSha256 !== createHash('sha256').update(sourceJoinFunction(true)).digest('hex') ||
    typeof r.resultSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(r.resultSha256)
  )
    throw new Error('E4 source join calibration binding refused');
  if (
    reused &&
    (r.calibrationHead !== SOURCE_JOIN_REUSABLE_SMALL.head ||
      r.smallRun !== SOURCE_JOIN_REUSABLE_SMALL.run ||
      r.resultSha256 !== SOURCE_JOIN_REUSABLE_SMALL.resultSha256 ||
      r.candidateSha256 !== SOURCE_JOIN_REUSABLE_SMALL.candidateSha256 ||
      r.sourceFunctionSha256 !== SOURCE_JOIN_BASELINE_SHA ||
      r.completeFunctionMd5 !== E4_DIAGNOSTIC_PLAN.completeFunctionMd5)
  )
    throw new Error('E4 source statistics reused proof refused');
  return {
    head,
    forRun,
    status: 'VERIFIED_SMALL',
    smallRun: r.smallRun,
    candidateSha256: r.candidateSha256,
    resultSha256: r.resultSha256,
    ...(reused
      ? {
          calibrationHead: SOURCE_JOIN_REUSABLE_SMALL.head,
          sourceFunctionSha256: SOURCE_JOIN_BASELINE_SHA,
          completeFunctionMd5: E4_DIAGNOSTIC_PLAN.completeFunctionMd5,
          reuseCondition: 'UNCHANGED_SOURCE_SQL_AND_ORIGINAL143',
        }
      : {}),
  };
}
function readSourceJoinCalibration() {
  const raw = readFileSync(
    resolve(process.cwd(), 'tmp/e4-prepare-cost-evidence/source-join-calibration.json'),
  );
  if (raw.length > 4096) throw new Error('E4 source join calibration bound refused');
  return validateSourceJoinCalibration(
    JSON.parse(raw.toString()),
    process.env.GITHUB_SHA!,
    process.env.GITHUB_RUN_ID!,
    process.env.SRVF_E4_SOURCE_JOIN === 'statistics-500',
  );
}
function verifySourceJoinCalibration() {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  requireDiagnosticEnvironment(process.env, head);
  const run = process.env.SRVF_E4_SOURCE_JOIN_SMALL_RUN;
  const reused = process.env.SRVF_E4_SOURCE_JOIN === 'statistics-500';
  const originHead = reused ? SOURCE_JOIN_REUSABLE_SMALL.head : head;
  if (
    !['ordinary-500', 'statistics-500'].includes(process.env.SRVF_E4_SOURCE_JOIN ?? '') ||
    !/^\d+$/u.test(run ?? '') ||
    run === process.env.GITHUB_RUN_ID
  )
    throw new Error('E4 source join calibration run refused');
  if (reused && run !== SOURCE_JOIN_REUSABLE_SMALL.run)
    throw new Error('E4 source statistics calibration identity refused');
  const metadata = JSON.parse(
    execFileSync('gh', ['api', `repos/BA7IEE/srvf-nest-api/actions/runs/${run}`], {
      encoding: 'utf8',
      timeout: 40000,
      maxBuffer: 65536,
    }),
  ) as Record<string, unknown>;
  if (
    metadata.head_sha !== originHead ||
    metadata.conclusion !== 'success' ||
    metadata.status !== 'completed' ||
    metadata.run_attempt !== 1 ||
    metadata.event !== 'workflow_dispatch' ||
    metadata.head_branch !== 'codex/activity-os-r5-e4-github-validation'
  )
    throw new Error('E4 source join calibration origin refused');
  const raw = execFileSync('gh', ['run', 'view', run!, '--repo', 'BA7IEE/srvf-nest-api', '--log'], {
    encoding: 'utf8',
    timeout: 40000,
    maxBuffer: 2097152,
  });
  const chunks = new Map<number, { index: number; total: number; data: string }>();
  for (const line of raw.split('\n')) {
    const marker = 'E4_NATIVE_PLAN_CHUNK ';
    if (!line.includes(marker)) continue;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line.slice(line.indexOf(marker) + marker.length)) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (r.artifact !== 'result.json') continue;
    if (
      r.head !== originHead ||
      r.run !== run ||
      typeof r.index !== 'number' ||
      !Number.isInteger(r.index) ||
      r.index < 0 ||
      r.index > 5 ||
      typeof r.total !== 'number' ||
      r.total < 1 ||
      r.total > 6 ||
      typeof r.data !== 'string' ||
      r.data.length > 12000 ||
      chunks.has(r.index)
    )
      throw new Error('E4 source join calibration chunk refused');
    chunks.set(r.index, { index: r.index, total: r.total, data: r.data });
  }
  const count = chunks.get(0)?.total;
  if (!count || chunks.size !== count) throw new Error('E4 source join calibration incomplete');
  let json = '';
  for (let i = 0; i < count; i++) {
    const part = chunks.get(i);
    if (!part || part.total !== count)
      throw new Error('E4 source join calibration sequence refused');
    json += part.data;
  }
  if (Buffer.byteLength(json) > 65536)
    throw new Error('E4 source join calibration report bound refused');
  const report = JSON.parse(json) as Report;
  const proof = report.sourceJoinComparison as {
    status: string;
    small: boolean;
    candidateSha256: string;
    sourceFunctionSha256: string;
    equivalence: unknown[];
    negatives: unknown[];
    priorities: unknown[];
    plans: unknown[];
  };
  const cleanup = Reflect.get(report, 'independentCleanup') as {
    status: string;
    databases: number;
    clients: number;
    leaseBackends: number;
    leaseLocks: number;
  };
  if (
    report.head !== originHead ||
    report.run !== run ||
    report.coverage !== 'PREPARE_SOURCE_JOIN_ONLY' ||
    report.scenario !== 'ordinary-1' ||
    report.status !== 'COMPLETE' ||
    report.oracle !== 'COMPLETE' ||
    report.sourceJoinPostOracle !== 'COMPLETE' ||
    report.resources !== 'CLOSED' ||
    proof?.status !== 'COMPLETE' ||
    proof.small !== true ||
    proof.candidateSha256 !== createHash('sha256').update(sourceJoinFunction(true)).digest('hex') ||
    (reused &&
      (proof.sourceFunctionSha256 !== SOURCE_JOIN_BASELINE_SHA ||
        report.completeFunctionMd5 !== E4_DIAGNOSTIC_PLAN.completeFunctionMd5 ||
        report.migration143Sha256 !== E4_DIAGNOSTIC_PLAN.migration143Sha256)) ||
    proof.equivalence.length !== 6 ||
    proof.negatives.length !== 6 ||
    proof.priorities.length !== 6 ||
    proof.plans.length !== 2 ||
    cleanup?.status !== 'OBSERVED_ABSENT' ||
    [cleanup.databases, cleanup.clients, cleanup.leaseBackends, cleanup.leaseLocks].some(
      (n) => n !== 0,
    )
  )
    throw new Error('E4 source join calibration proof refused');
  const evidence = validateSourceJoinCalibration(
    {
      head,
      forRun: process.env.GITHUB_RUN_ID,
      status: 'VERIFIED_SMALL',
      smallRun: run,
      candidateSha256: proof.candidateSha256,
      resultSha256: createHash('sha256')
        .update(json + '\n')
        .digest('hex'),
      ...(reused
        ? {
            calibrationHead: originHead,
            sourceFunctionSha256: proof.sourceFunctionSha256,
            completeFunctionMd5: report.completeFunctionMd5,
          }
        : {}),
    },
    head,
    process.env.GITHUB_RUN_ID!,
    reused,
  );
  const file = resolve(process.cwd(), 'tmp/e4-prepare-cost-evidence/source-join-calibration.json');
  mkdirSync(dirname(file), { recursive: true });
  writeBounded(file, evidence);
  console.info('E4_SOURCE_JOIN_CALIBRATION ' + JSON.stringify(evidence));
}
export function sourceJoinFunction(candidate = false) {
  const migration = readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20261003000000_activity_contribution_settlement/migration.sql',
    ),
    'utf8',
  );
  const original = migration.match(/CREATE FUNCTION e4_source_rows\([\s\S]*?\n\$\$;/u)?.[0];
  if (!original || createHash('sha256').update(original).digest('hex') !== SOURCE_JOIN_BASELINE_SHA)
    throw new Error('E4 source join original identity refused');
  if (!candidate) return original;
  const marker = '), raw_sources AS MATERIALIZED (\n';
  const begin = original.indexOf(marker),
    end = original.indexOf('  UNION ALL\n', begin);
  if (begin < 0 || end < 0 || original.indexOf(marker, begin + 1) >= 0)
    throw new Error('E4 source join unique rewrite refused');
  const edges = `), time_source_edges AS MATERIALIZED (
  SELECT b.id AS bucket_key, b."recognizedSeconds" AS recognized_seconds,
    b."rawRecognizedMilliseconds" AS raw_ms, b."activityId" AS activity_id, b."categoryCode" AS category_code,
    a."participationIdentityId" AS identity_id, a."memberId" AS member_id, a."sessionId" AS session_id,
    a."ruleSnapshotId" AS snapshot_id, a."ruleSnapshotHash" AS snapshot_hash, a."sourcePositionId" AS position_id,
    a.id AS allocation_id, a."allocationHash" AS allocation_hash,
    a."sourceSegmentId" AS segment_id, a."sourceSegmentRevision" AS segment_revision
  FROM root r JOIN "ParticipantSettlementTimeBucket" b ON b."timeRevisionId"=r."timeRevisionId" AND b."activityId"=r."activityId"
  JOIN "ParticipantSettlementTimeBucketSource" bs ON bs."bucketId"=b.id AND bs."activityId"=b."activityId" AND bs."timeRevisionId"=b."timeRevisionId"
  JOIN "ParticipantTimeAllocationRevision" a ON a.id=bs."allocationRevisionId" AND a."activityId"=bs."activityId"
    AND a."participationIdentityId"=b."participationIdentityId" AND a."sourceSegmentId"=bs."sourceSegmentId" AND a."sourceSegmentRevision"=bs."sourceSegmentRevision"
  JOIN "ParticipantSettlementResultRevision" rr ON rr."settlementVersionId"=r."settlementVersionId" AND rr."participationIdentityId"=a."participationIdentityId"
  WHERE r."sourceKindCode"='time_revision' AND rr."resultCode"='present'
), raw_sources AS MATERIALIZED (
  SELECT e.bucket_key,e.recognized_seconds,e.raw_ms,e.identity_id,e.member_id,e.session_id,
    e.snapshot_id,e.snapshot_hash,e.position_id,e.allocation_id,e.allocation_hash,e.segment_id,e.segment_revision,
    s.id AS slice_key,s."categoryCode" AS category_code,s."startAt" AS starts_at,s."endAt" AS ends_at,
    NULL::JSONB AS correction_source
  FROM time_source_edges e JOIN "ParticipantTimeAllocationSlice" s
    ON s."allocationRevisionId"=e.allocation_id AND s."activityId"=e.activity_id AND s."categoryCode"=e.category_code
`;
  return original.slice(0, begin) + edges + original.slice(end);
}
export const SOURCE_JOIN_INPUTS = [
  ['ParticipantSettlementTimeBucket', 'e4_sj_buckets'],
  ['ParticipantSettlementTimeBucketSource', 'e4_sj_links'],
  ['ParticipantTimeAllocationRevision', 'e4_sj_allocations'],
  ['ParticipantTimeAllocationSlice', 'e4_sj_slices'],
  ['ParticipantSettlementResultRevision', 'e4_sj_results'],
] as const;
type RealStatisticsStage = 'SOURCE_BUILD' | 'PREPARE' | 'SUBMIT';
type RealStatisticsClient = {
  $queryRawUnsafe(query: string): PromiseLike<unknown>;
  $executeRawUnsafe(query: string): PromiseLike<unknown>;
};
type RealStatisticsSnapshot = {
  pid: number;
  transaction: string;
  statisticsDigest: string;
  settingsDigest: string;
  workMemKb: number;
  jitEnabled: boolean;
  planCacheMode: string;
  statistics: { table: string; rows: number; tuples: number; statsColumns: number }[];
};
function isRealStatisticsClient(value: unknown): value is RealStatisticsClient {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof Reflect.get(value, '$queryRawUnsafe') === 'function' &&
    typeof Reflect.get(value, '$executeRawUnsafe') === 'function'
  );
}
export function realStatisticsAnalyzeCommands(stage: RealStatisticsStage) {
  return SOURCE_JOIN_INPUTS.filter((_, i) => stage !== 'SOURCE_BUILD' || i >= 2).map(
    ([name]) => `ANALYZE public."${name}"`,
  );
}
export function realStatisticsSnapshotSql() {
  return `SELECT current_database() AS database,pg_backend_pid() AS pid,txid_current()::TEXT AS transaction,
 current_setting('server_version_num')::INT AS server,
 current_setting('transaction_read_only')='off' AS writable,
 ${sourceStatisticsProjectionSql()} AS statistics,${sourceJoinStatsDigestSql(true)} AS "statisticsDigest",
 ${sourceSettingsDigestSql()} AS "settingsDigest",(pg_size_bytes(current_setting('work_mem'))/1024)::INT AS "workMemKb",
 current_setting('jit')='on' AS "jitEnabled",current_setting('plan_cache_mode') AS "planCacheMode"`;
}
async function readRealStatistics(tx: RealStatisticsClient): Promise<RealStatisticsSnapshot> {
  const rows = await tx.$queryRawUnsafe(realStatisticsSnapshotSql());
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('E4 real statistics row refused');
  const r = rows[0] as Record<string, unknown>;
  if (
    r.database !== 'app_test_w98' ||
    r.writable !== true ||
    typeof r.server !== 'number' ||
    r.server < 160000 ||
    r.server >= 170000 ||
    typeof r.pid !== 'number' ||
    !Number.isInteger(r.pid) ||
    r.pid < 1 ||
    typeof r.transaction !== 'string' ||
    !/^\d+$/u.test(r.transaction) ||
    typeof r.statisticsDigest !== 'string' ||
    !/^[a-f0-9]{32}$/u.test(r.statisticsDigest) ||
    typeof r.settingsDigest !== 'string' ||
    !/^[a-f0-9]{32}$/u.test(r.settingsDigest) ||
    r.workMemKb !== 4096 ||
    r.jitEnabled !== true ||
    !['auto', 'force_custom_plan'].includes(String(r.planCacheMode)) ||
    !Array.isArray(r.statistics) ||
    r.statistics.length !== 5
  )
    throw new Error('E4 real statistics scope/settings refused');
  const values = r.statistics as Record<string, unknown>[];
  const statistics = SOURCE_JOIN_INPUTS.map(([table]) => {
    const matches = values.filter((s) => s.table === table);
    if (matches.length !== 1) throw new Error('E4 real statistics table refused');
    const s = matches[0];
    for (const k of ['rows', 'tuples', 'statsColumns'])
      if (
        typeof s[k] !== 'number' ||
        !Number.isFinite(s[k]) ||
        s[k] < (k === 'tuples' ? -1 : 0) ||
        s[k] > 1e6
      )
        throw new Error('E4 real statistics count refused');
    return {
      table,
      rows: s.rows as number,
      tuples: s.tuples as number,
      statsColumns: s.statsColumns as number,
    };
  });
  return {
    pid: r.pid,
    transaction: r.transaction,
    statisticsDigest: r.statisticsDigest,
    settingsDigest: r.settingsDigest,
    workMemKb: 4096,
    jitEnabled: true,
    planCacheMode: String(r.planCacheMode),
    statistics,
  };
}
function closedRealStatistics(s: RealStatisticsSnapshot) {
  const { pid, transaction, ...closed } = s;
  void pid;
  void transaction;
  return closed;
}
/** Isolated test-instance hooks only. Every original call receives its original this/arguments/tx. */
export function installRealStatistics(target: object, audit: object) {
  const state: {
    status: string;
    restored: boolean;
    lastPoint?: string;
    stages: {
      stage: RealStatisticsStage;
      status: string;
      wallMs: number;
      commands: number;
      before?: ReturnType<typeof closedRealStatistics>;
      after?: ReturnType<typeof closedRealStatistics>;
    }[];
    checks: {
      stage: RealStatisticsStage;
      point: string;
      statisticsDigest: string;
      settingsDigest: string;
      planCacheMode: string;
      sameTransaction: boolean;
      statisticsUnchanged: boolean;
    }[];
  } = { status: 'ENTERED', restored: false, stages: [], checks: [] };
  const contexts = new WeakMap<
    object,
    { stage: RealStatisticsStage; baseline: RealStatisticsSnapshot; first?: RealStatisticsSnapshot }
  >();
  const installed: {
    target: object;
    method: string;
    original: unknown;
    descriptor?: PropertyDescriptor;
    wrapper: (...args: unknown[]) => unknown;
  }[] = [];
  const identity = (a: RealStatisticsSnapshot, b: RealStatisticsSnapshot) => {
    if (a.pid !== b.pid || a.transaction !== b.transaction)
      throw new Error('E4 real statistics transaction changed');
  };
  const check = async (tx: RealStatisticsClient, point: string) => {
    const context = contexts.get(tx);
    if (!context) throw new Error('E4 real statistics guard context absent');
    state.lastPoint = context.stage + ':' + point;
    const s = await readRealStatistics(tx);
    identity(context.baseline, s);
    if (s.statisticsDigest !== context.baseline.statisticsDigest)
      throw new Error('E4 real statistics drift refused');
    if (point === 'BEFORE_INSERT_GUARD') context.first = s;
    else if (!context.first || context.first.settingsDigest !== s.settingsDigest)
      throw new Error('E4 real statistics guard settings changed');
    state.checks.push({
      stage: context.stage,
      point,
      statisticsDigest: s.statisticsDigest,
      settingsDigest: s.settingsDigest,
      planCacheMode: s.planCacheMode,
      sameTransaction: true,
      statisticsUnchanged: true,
    });
    return s;
  };
  const analyze = async (tx: RealStatisticsClient, stage: RealStatisticsStage) => {
    if (state.stages.some((s) => s.stage === stage))
      throw new Error('E4 real statistics repeated stage refused');
    state.lastPoint = stage + ':ANALYZE';
    const receipt: (typeof state.stages)[number] = {
      stage,
      status: 'ENTERED',
      wallMs: 0,
      commands: 0,
    };
    state.stages.push(receipt);
    const started = performance.now();
    try {
      const before = await readRealStatistics(tx);
      receipt.before = closedRealStatistics(before);
      const expected =
        stage === 'SOURCE_BUILD'
          ? [0, 0, 10000, 50000, 2000]
          : stage === 'PREPARE'
            ? [8000, 40000, 10000, 50000, 2000]
            : [16000, 80000, 10000, 50000, 4000];
      if (before.statistics.some((s, i) => s.rows !== expected[i]))
        throw new Error('E4 real statistics fixed maximum shape refused');
      for (const sql of realStatisticsAnalyzeCommands(stage)) {
        await tx.$executeRawUnsafe(sql);
        receipt.commands++;
      }
      const after = await readRealStatistics(tx);
      receipt.after = closedRealStatistics(after);
      identity(before, after);
      if (
        before.settingsDigest !== after.settingsDigest ||
        after.statistics.some(
          (s, i) =>
            s.rows !== before.statistics[i].rows ||
            ((stage !== 'SOURCE_BUILD' || i >= 2) && (s.statsColumns < 1 || s.tuples < 0)),
        )
      )
        throw new Error('E4 real statistics analyze visibility/data/settings refused');
      if (stage !== 'SOURCE_BUILD') contexts.set(tx, { stage, baseline: after });
      receipt.status = 'COMPLETE';
    } finally {
      receipt.wallMs = performance.now() - started;
    }
  };
  const bind = (
    object: object,
    method: string,
    run: (args: unknown[], original: (...args: unknown[]) => unknown) => Promise<unknown>,
  ) => {
    const original: unknown = Reflect.get(object, method),
      descriptor = Object.getOwnPropertyDescriptor(object, method);
    if (typeof original !== 'function' || (descriptor && !descriptor.configurable))
      throw new Error('E4 real statistics method unavailable');
    const invoke = (...args: unknown[]) => Reflect.apply(original, object, args) as unknown;
    const wrapper = async function (this: unknown, ...args: unknown[]) {
      if (this !== object || state.restored || !isRealStatisticsClient(args[0]))
        throw new Error('E4 real statistics method/tx refused');
      return run(args, invoke);
    };
    Object.defineProperty(object, method, { configurable: true, writable: true, value: wrapper });
    installed.push({ target: object, method, original, descriptor, wrapper });
  };
  const restore = () => {
    if (state.restored) return;
    for (const item of [...installed].reverse()) {
      if (Reflect.get(item.target, item.method) !== item.wrapper)
        throw new Error('E4 real statistics restore ownership refused');
      if (item.descriptor) Object.defineProperty(item.target, item.method, item.descriptor);
      else Reflect.deleteProperty(item.target, item.method);
      if (Reflect.get(item.target, item.method) !== item.original)
        throw new Error('E4 real statistics original method not restored');
    }
    state.restored = true;
  };
  try {
    for (const [method, stage] of [
      ['prepareTimeInTx', 'PREPARE'],
      ['copySubmittedTimeInTx', 'SUBMIT'],
    ] as const)
      bind(target, method, async (args, original) => {
        const tx = args[0];
        if (!isRealStatisticsClient(tx)) throw new Error('E4 real statistics tx refused');
        await analyze(tx, stage);
        return original(...args);
      });
    for (const method of ['insertEvaluations', 'copyEvaluations'])
      bind(target, method, async (args, original) => {
        const tx = args[0];
        if (!isRealStatisticsClient(tx)) throw new Error('E4 real statistics tx refused');
        await check(tx, 'BEFORE_INSERT_GUARD');
        const result = await original(...args);
        await check(tx, 'AFTER_INSERT_GUARD');
        return result;
      });
    bind(audit, 'log', async (args, original) => {
      const result = await original(...args),
        tx = args[0];
      if (
        isRealStatisticsClient(tx) &&
        contexts.has(tx) &&
        ['prepare_time_settlement', 'submit_time_settlement'].includes(String(args[3]))
      )
        await check(tx, 'BEFORE_DEFERRED_GUARD');
      return result;
    });
  } catch (error) {
    restore();
    throw error;
  }
  return {
    source: (tx: RealStatisticsClient) => analyze(tx, 'SOURCE_BUILD'),
    restore,
    snapshot: () => ({
      ...state,
      status: state.status === 'COMPLETE' ? 'COMPLETE' : 'INCOMPLETE',
      conditionalOnly: true,
      statisticsScope: 'FIVE_TEST_TABLES_ONLY',
      prepareBudgetMs: 30000,
      inTransactionAnalyzeIncluded: true,
    }),
    complete: () => {
      if (
        state.stages.length !== 3 ||
        state.stages.some((s) => s.status !== 'COMPLETE') ||
        state.checks.length !== 6
      )
        throw new Error('E4 real statistics full chain evidence incomplete');
      for (const stage of ['PREPARE', 'SUBMIT'])
        for (const point of ['BEFORE_INSERT_GUARD', 'AFTER_INSERT_GUARD', 'BEFORE_DEFERRED_GUARD'])
          if (state.checks.filter((s) => s.stage === stage && s.point === point).length !== 1)
            throw new Error('E4 real statistics guard coverage refused');
      state.status = 'COMPLETE';
      delete state.lastPoint;
    },
  };
}

export function realStatisticsCapabilitySql() {
  const rebound = (sql: string) => {
    for (const [name] of SOURCE_JOIN_INPUTS)
      sql = sql.replaceAll(`public."${name}"`, `pg_temp."${name}"`);
    return sql.replaceAll(
      "schemaname='public'",
      'schemaname=(SELECT nspname FROM pg_namespace WHERE oid=pg_my_temp_schema())',
    );
  };
  return `BEGIN;
SET LOCAL statement_timeout='5s';
DO $$ BEGIN IF current_database()<>'postgres' OR inet_server_addr() IS NOT NULL OR current_setting('server_version_num')::INT NOT BETWEEN 160000 AND 169999 THEN RAISE EXCEPTION 'E4 real statistics capability scope refused'; END IF; END $$;
${SOURCE_JOIN_INPUTS.map(([name]) => `CREATE TEMP TABLE "${name}"(id TEXT,value INTEGER CHECK(value>=0)); INSERT INTO pg_temp."${name}" VALUES ('one',1),('two',2),('three',3);`).join('\n')}
CREATE TEMP TABLE e4_real_statistics_owner AS SELECT pg_backend_pid() AS pid,txid_current()::TEXT AS transaction;
${realStatisticsAnalyzeCommands('PREPARE')
  .map((s) => rebound(s) + ';')
  .join('\n')}
DO $$ DECLARE snapshot JSONB; rejected BOOLEAN:=false; BEGIN
 snapshot:=${rebound(sourceStatisticsProjectionSql())};
 IF jsonb_array_length(snapshot)<>5 OR EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot) s WHERE (s->>'rows')::INT<>3 OR (s->>'tuples')::FLOAT8<>3 OR (s->>'statsColumns')::INT<>2)
 OR pg_backend_pid()<>(SELECT pid FROM e4_real_statistics_owner) OR txid_current()::TEXT<>(SELECT transaction FROM e4_real_statistics_owner)
 THEN RAISE EXCEPTION 'E4 same transaction analyze unavailable'; END IF;
 BEGIN INSERT INTO pg_temp."ParticipantSettlementTimeBucket" VALUES ('invalid',-1);
 EXCEPTION WHEN check_violation THEN rejected:=true; END;
 IF NOT rejected OR (SELECT count(*) FROM pg_temp."ParticipantSettlementTimeBucket")<>3 THEN RAISE EXCEPTION 'E4 tiny rollback refused'; END IF;
END $$;
SELECT json_build_object('server',16,'sameTransaction',true,'tables',5,'rowsPerTable',3,'statisticsVisible',true,'negativeSqlstate','23514','negativeRolledBack',true,'businessFixtureExecuted',false);
ROLLBACK;
`;
}
export function validateRealStatisticsCapability(value: unknown, head: string, run: string) {
  if (!value || typeof value !== 'object') throw new Error('E4 real statistics capability refused');
  const r = value as Record<string, unknown>;
  if (
    r.head !== head ||
    r.run !== run ||
    r.status !== 'COMPLETE' ||
    r.server !== 16 ||
    r.sameTransaction !== true ||
    r.tables !== 5 ||
    r.rowsPerTable !== 3 ||
    r.statisticsVisible !== true ||
    r.negativeSqlstate !== '23514' ||
    r.negativeRolledBack !== true ||
    r.businessFixtureExecuted !== false
  )
    throw new Error('E4 real statistics capability refused');
  return {
    head,
    run,
    status: 'COMPLETE',
    server: 16,
    sameTransaction: true,
    tables: 5,
    rowsPerTable: 3,
    statisticsVisible: true,
    negativeSqlstate: '23514',
    negativeRolledBack: true,
    businessFixtureExecuted: false,
  };
}
function readRealStatisticsCapability() {
  const raw = readFileSync(
    resolve(process.cwd(), 'tmp/e4-prepare-cost-evidence/real-statistics-capability.json'),
  );
  if (raw.length > 4096) throw new Error('E4 real statistics capability bound refused');
  return validateRealStatisticsCapability(
    JSON.parse(raw.toString()),
    process.env.GITHUB_SHA!,
    process.env.GITHUB_RUN_ID!,
  );
}
function runRealStatisticsCapability() {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  requireDiagnosticEnvironment(process.env, head);
  if (process.env.SRVF_E4_REAL_STATISTICS !== '1')
    throw new Error('E4 real statistics mode required');
  const raw = execFileSync(
    'docker',
    [
      'exec',
      '-i',
      'u-nest-api-postgres',
      'psql',
      '-X',
      '-q',
      '-A',
      '-t',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'postgres',
    ],
    {
      input: realStatisticsCapabilitySql(),
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 8192,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const evidence = validateRealStatisticsCapability(
    { ...JSON.parse(raw.trim()), head, run: process.env.GITHUB_RUN_ID, status: 'COMPLETE' },
    head,
    process.env.GITHUB_RUN_ID!,
  );
  const file = resolve(
    process.cwd(),
    'tmp/e4-prepare-cost-evidence/real-statistics-capability.json',
  );
  mkdirSync(dirname(file), { recursive: true });
  writeBounded(file, evidence);
  console.info('E4_REAL_STATISTICS_CAPABILITY ' + JSON.stringify(evidence));
}
export function sourceJoinStatsDigestSql(plannerOnly = false) {
  if (plannerOnly) {
    const fields = [
      's.staattnum',
      's.stainherit',
      's.stanullfrac',
      's.stawidth',
      's.stadistinct',
      ...['stakind', 'staop', 'stacoll', 'stanumbers'].flatMap((prefix) =>
        Array.from({ length: 5 }, (_, i) => `s.${prefix}${i + 1}`),
      ),
      ...Array.from({ length: 5 }, (_, i) => `s.stavalues${i + 1}::TEXT`),
    ];
    return `(SELECT md5(string_agg(jsonb_build_array(c.relname,c.reltuples,c.relpages,
 (SELECT md5(string_agg(jsonb_build_array(${fields.join(',')})::TEXT,',' ORDER BY s.staattnum,s.stainherit)) FROM pg_statistic s WHERE s.starelid=c.oid))::TEXT,',' ORDER BY c.relname COLLATE "C"))
 FROM pg_class c WHERE c.oid IN (${SOURCE_JOIN_INPUTS.map(([name]) => `'public."${name}"'::regclass`).join(',')}))`;
  }
  return `(SELECT md5(string_agg(jsonb_build_array(c.relname,c.reltuples,c.relpages,s.last_analyze,s.last_autoanalyze)::TEXT,',' ORDER BY c.relname COLLATE "C"))
 FROM pg_class c JOIN pg_stat_all_tables s ON s.relid=c.oid WHERE c.oid IN (${SOURCE_JOIN_INPUTS.map(([name]) => `'public."${name}"'::regclass`).join(',')}))`;
}
export const SOURCE_STATISTICS_SETTINGS = [
  'work_mem',
  'jit',
  'plan_cache_mode',
  'enable_nestloop',
  'enable_hashjoin',
  'enable_mergejoin',
  'enable_seqscan',
  'enable_indexscan',
  'enable_indexonlyscan',
  'enable_bitmapscan',
  'enable_memoize',
  'join_collapse_limit',
  'from_collapse_limit',
  'jit_above_cost',
  'jit_inline_above_cost',
  'jit_optimize_above_cost',
  'default_statistics_target',
  'max_parallel_workers_per_gather',
  'random_page_cost',
  'seq_page_cost',
  'cpu_tuple_cost',
  'cpu_index_tuple_cost',
  'cpu_operator_cost',
  'effective_cache_size',
  'effective_io_concurrency',
] as const;
function sourceSettingsDigestSql() {
  return `(SELECT md5(string_agg(name||'='||setting,',' ORDER BY name COLLATE "C")) FROM pg_settings WHERE name IN (${SOURCE_STATISTICS_SETTINGS.map((name) => `'${name}'`).join(',')}))`;
}
function sourceDataDigestSql() {
  return `md5(jsonb_build_array(${SOURCE_JOIN_INPUTS.map(([name]) => `(SELECT md5(string_agg(md5(to_jsonb(t)::TEXT),',' ORDER BY id COLLATE "C")) FROM public."${name}" t)`).join(',')})::TEXT)`;
}
function sourceStatisticsProjectionSql() {
  return `(SELECT jsonb_agg(to_jsonb(t) ORDER BY t."table" COLLATE "C") FROM (${SOURCE_JOIN_INPUTS.map(
    ([
      name,
    ]) => `SELECT '${name}'::TEXT AS "table",c.reltuples::FLOAT8 AS tuples,c.relpages AS pages,
 (SELECT count(*)::INT FROM pg_stats WHERE schemaname='public' AND tablename='${name}') AS "statsColumns",
 s.last_analyze IS NOT NULL AS analyzed,s.last_autoanalyze IS NOT NULL AS autoanalyzed,(SELECT count(*)::INT FROM public."${name}") AS rows
 FROM pg_class c JOIN pg_stat_all_tables s ON s.relid=c.oid WHERE c.oid='public."${name}"'::regclass`,
  ).join(' UNION ALL ')}) t)`;
}
function sourceStatisticsStageSql(stage: 'PRE_ANALYZE' | 'ANALYZED') {
  return `BEGIN;
SET LOCAL statement_timeout='30s';SET LOCAL idle_in_transaction_session_timeout='30s';
DO $$ BEGIN IF current_database()<>'app_test_w98' OR inet_server_addr() IS NOT NULL
 OR current_setting('server_version_num')::INTEGER NOT BETWEEN 160000 AND 169999
 OR pg_backend_pid()<>(SELECT pid FROM pg_temp.e4_probe_metadata)
 THEN RAISE EXCEPTION 'E4 source statistics test-only scope refused'; END IF; END $$;
${stage === 'ANALYZED' ? SOURCE_JOIN_INPUTS.map(([name]) => `ANALYZE public."${name}";`).join('\n') : ''}
DO $$ DECLARE snapshot JSONB; data_equal BOOLEAN; stats_digest TEXT; BEGIN
 SELECT ${sourceStatisticsProjectionSql()},${sourceJoinStatsDigestSql(true)} INTO snapshot,stats_digest;
 IF jsonb_array_length(snapshot)<>5${stage === 'ANALYZED' ? ` OR EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot) item WHERE (item->>'statsColumns')::INT<1 OR (item->>'tuples')::FLOAT8<0)` : ''}
 THEN RAISE EXCEPTION 'E4 source statistics ${stage === 'PRE_ANALYZE' ? 'initial snapshot unavailable' : 'analyze not visible'}'; END IF;
 data_equal:=${sourceDataDigestSql()} IS NOT DISTINCT FROM (SELECT data_digest FROM pg_temp.e4_probe_metadata);
 IF NOT data_equal OR ${sourceSettingsDigestSql()} IS DISTINCT FROM (SELECT settings_digest FROM pg_temp.e4_probe_metadata)
 THEN RAISE EXCEPTION 'E4 source statistics data/settings changed'; END IF;
 UPDATE pg_temp.e4_probe_metadata SET source_stats=stats_digest;
 RAISE NOTICE 'E4_SOURCE_JOIN_STATS %',jsonb_build_object('stage','${stage}','database',current_database(),'statistics',snapshot,
 'statisticsDigest',stats_digest,'dataUnchanged',data_equal,'settingsDigest',${sourceSettingsDigestSql()});
 ${stage === 'PRE_ANALYZE' ? `RAISE NOTICE 'E4_SOURCE_JOIN_SETTINGS %',(SELECT jsonb_object_agg(name,setting) FROM pg_settings WHERE name IN (${SOURCE_STATISTICS_SETTINGS.map((name) => `'${name}'`).join(',')}));` : ''}
END $$;
COMMIT;\n`;
}
function sourceJoinSetupSql(small: boolean) {
  const renamed = (candidate: boolean, name: string, shadow = false) => {
    let source = sourceJoinFunction(candidate).replace(
      'CREATE FUNCTION e4_source_rows(',
      `CREATE FUNCTION pg_temp.${name}(`,
    );
    if (shadow)
      for (const [table, temp] of SOURCE_JOIN_INPUTS)
        source = source.replaceAll(`"${table}"`, `pg_temp.${temp}`);
    if (!shadow)
      source = source.replace(' AS $$', () => " SET auto_explain.log_min_duration='0' AS $$");
    return source;
  };
  const bagQuery = (
    a: string,
    b: string,
  ) => `WITH a AS MATERIALIZED (SELECT to_jsonb(s) AS value FROM ${a}((SELECT id FROM pg_temp.e4_probe_context)) s),
 b AS MATERIALIZED (SELECT to_jsonb(s) AS value FROM ${b}((SELECT id FROM pg_temp.e4_probe_context)) s)
 SELECT (SELECT count(*) FROM a),NOT EXISTS((SELECT * FROM a EXCEPT ALL SELECT * FROM b) UNION ALL (SELECT * FROM b EXCEPT ALL SELECT * FROM a)),
 (SELECT sha256(convert_to(coalesce(string_agg(value::TEXT,',' ORDER BY value::TEXT COLLATE "C"),''),'UTF8')) FROM a)
 IS NOT DISTINCT FROM (SELECT sha256(convert_to(coalesce(string_agg(value::TEXT,',' ORDER BY value::TEXT COLLATE "C"),''),'UTF8')) FROM b)
 INTO total,equal,hash_equal;`;
  const digest = `md5(jsonb_build_array(${SOURCE_JOIN_INPUTS.map(([, temp]) => `(SELECT jsonb_agg(value ORDER BY value::TEXT COLLATE "C") FROM (SELECT to_jsonb(t) AS value FROM pg_temp.${temp} t) rows)`).join(',')})::TEXT)`;
  let sql = `DO $$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.e4_source_rows(text)'::regprocedure)<>'d8934c5bf29f8b16f820ba6cd950698b' THEN RAISE EXCEPTION 'E4 source join public helper identity refused'; END IF; END $$;
${renamed(false, 'e4_sj_original')}
${renamed(true, 'e4_sj_rows')}
`;
  if (small) {
    for (const [table, temp] of SOURCE_JOIN_INPUTS)
      sql += `CREATE TEMP TABLE ${temp} AS SELECT t.* FROM public."${table}" t
 WHERE ${table === 'ParticipantSettlementResultRevision' ? `t."settlementVersionId"=(SELECT "settlementVersionId" FROM pg_temp.e4_probe_roots)` : `t."activityId"=(SELECT "activityId" FROM pg_temp.e4_probe_roots)`} ORDER BY id COLLATE "C" DESC;\n`;
    sql +=
      renamed(false, 'e4_sj_original_shadow', true) +
      '\n' +
      renamed(true, 'e4_sj_candidate_shadow', true) +
      '\n';
  }
  sql += `CREATE FUNCTION pg_temp.e4_sj_compare(mode INTEGER) RETURNS INTEGER LANGUAGE plpgsql AS $sj$
DECLARE total BIGINT; equal BOOLEAN; hash_equal BOOLEAN; BEGIN
 IF mode=0 THEN ${bagQuery('public.e4_source_rows', 'pg_temp.e4_sj_rows')}
 ${
   small
     ? `ELSIF mode=1 THEN ${bagQuery('public.e4_source_rows', 'pg_temp.e4_sj_original_shadow')}
 ELSE ${bagQuery('pg_temp.e4_sj_original_shadow', 'pg_temp.e4_sj_candidate_shadow')}`
     : ''
 }
 END IF;
 IF NOT equal OR NOT hash_equal OR total<1 THEN RAISE EXCEPTION 'E4 source join bag/hash equivalence refused'; END IF;
 RETURN total::INTEGER;
END $sj$;
DO $$ DECLARE total INTEGER; BEGIN total:=pg_temp.e4_sj_compare(0);
 RAISE NOTICE 'E4_SOURCE_JOIN_EQ %',json_build_object('case','PUBLIC','rows',total,'bagEqual',true,'hashEqual',true,'rolledBack',false,'mutation',false);
END $$;
`;
  if (small) {
    sql += `DO $$ DECLARE total INTEGER; BEGIN total:=pg_temp.e4_sj_compare(1);
 RAISE NOTICE 'E4_SOURCE_JOIN_EQ %',json_build_object('case','REVERSED_INPUT','rows',total,'bagEqual',true,'hashEqual',true,'rolledBack',false,'mutation',false);
END $$;\n`;
    for (const [label, mutation, direction] of [
      [
        'DUPLICATE_EDGE',
        'INSERT INTO pg_temp.e4_sj_links SELECT * FROM pg_temp.e4_sj_links ORDER BY id COLLATE "C" LIMIT 1',
        '>',
      ],
      [
        'NULL_LINK',
        'UPDATE pg_temp.e4_sj_links SET "allocationRevisionId"=NULL WHERE ctid=(SELECT ctid FROM pg_temp.e4_sj_links ORDER BY ctid LIMIT 1)',
        '<',
      ],
      [
        'MISSING_EDGE',
        'DELETE FROM pg_temp.e4_sj_links WHERE ctid=(SELECT ctid FROM pg_temp.e4_sj_links ORDER BY ctid LIMIT 1)',
        '<',
      ],
      [
        'NULL_MEMBER',
        'UPDATE pg_temp.e4_sj_allocations SET "memberId"=NULL WHERE ctid=(SELECT ctid FROM pg_temp.e4_sj_allocations ORDER BY ctid LIMIT 1)',
        '=',
      ],
    ])
      sql += `DO $$ DECLARE before_hash TEXT; base INTEGER; total INTEGER; affected INTEGER; BEGIN
 before_hash:=${digest};base:=pg_temp.e4_sj_compare(2);
 BEGIN
  INSERT INTO pg_temp.e4_probe_marks VALUES ('${label}');
  ${mutation};GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>1 THEN RAISE EXCEPTION 'E4 source join mutation cardinality refused'; END IF;
  total:=pg_temp.e4_sj_compare(2);
  IF NOT(total${direction}base) THEN RAISE EXCEPTION 'E4 source join non-vacuous case refused'; END IF;
  ${label === 'NULL_MEMBER' ? `IF NOT EXISTS(SELECT 1 FROM pg_temp.e4_sj_candidate_shadow((SELECT id FROM pg_temp.e4_probe_context)) WHERE member_id IS NULL) THEN RAISE EXCEPTION 'E4 source join NULL output refused'; END IF;` : ''}
  RAISE EXCEPTION 'E4 source join controlled rollback';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'E4 source join controlled rollback' THEN RAISE; END IF; END;
 IF ${digest} IS DISTINCT FROM before_hash OR EXISTS(SELECT 1 FROM pg_temp.e4_probe_marks) THEN RAISE EXCEPTION 'E4 source join rollback refused'; END IF;
 RAISE NOTICE 'E4_SOURCE_JOIN_EQ %',json_build_object('case','${label}','rows',total,'bagEqual',true,'hashEqual',true,'rolledBack',true,'mutation',true);
END $$;\n`;
  }
  return sql;
}

async function sourceJoinStatistics(db: PrismaClient) {
  const rows = [];
  for (const [table] of SOURCE_JOIN_INPUTS) {
    const [row] = await db.$queryRaw<
      {
        tuples: number;
        pages: number;
        statsColumns: number;
        analyzed: boolean;
        autoanalyzed: boolean;
        rows: number;
      }[]
    >(
      Prisma.raw(`SELECT c.reltuples::FLOAT8 AS tuples,c.relpages AS pages,
 (SELECT count(*)::INT FROM pg_stats WHERE schemaname='public' AND tablename='${table}') AS "statsColumns",
 s.last_analyze IS NOT NULL AS analyzed,s.last_autoanalyze IS NOT NULL AS autoanalyzed,
 (SELECT count(*)::INT FROM public."${table}") AS rows
 FROM pg_class c JOIN pg_stat_all_tables s ON s.relid=c.oid WHERE c.oid='public."${table}"'::regclass`),
    );
    if (
      !row ||
      Object.values(row).some(
        (v) => typeof v === 'number' && (!Number.isFinite(v) || v < -1 || v > 1e9),
      )
    )
      throw new Error('E4 source join statistics refused');
    rows.push({ table, ...row });
  }
  return rows;
}
export function compactSourceStatisticsEvidence(raw: string) {
  raw = joinKeyDiagnosticNotices(raw);
  const entries = [...raw.matchAll(/NOTICE:\s+E4_SOURCE_JOIN_STATS (\{[^\n]+\})/gu)];
  if (entries.length !== 2) throw new Error('E4 source statistics snapshot count refused');
  const snapshots = entries.map((m, index) => {
    const r = JSON.parse(m[1]) as Record<string, unknown>;
    const stage = index === 0 ? 'PRE_ANALYZE' : 'ANALYZED';
    if (
      r.stage !== stage ||
      r.database !== 'app_test_w98' ||
      r.dataUnchanged !== true ||
      typeof r.statisticsDigest !== 'string' ||
      !/^[a-f0-9]{32}$/u.test(r.statisticsDigest) ||
      typeof r.settingsDigest !== 'string' ||
      !/^[a-f0-9]{32}$/u.test(r.settingsDigest) ||
      !Array.isArray(r.statistics) ||
      r.statistics.length !== 5
    )
      throw new Error('E4 source statistics snapshot refused');
    const rows = r.statistics as Record<string, unknown>[];
    const statistics = SOURCE_JOIN_INPUTS.map(([table]) => {
      const found = rows.filter((v) => v.table === table);
      if (found.length !== 1) throw new Error('E4 source statistics table scope refused');
      const v = found[0];
      if (
        ['tuples', 'pages', 'statsColumns', 'rows'].some(
          (k) =>
            typeof v[k] !== 'number' ||
            !Number.isFinite(v[k]) ||
            v[k] < (k === 'tuples' ? -1 : 0) ||
            v[k] > 5000,
        ) ||
        typeof v.analyzed !== 'boolean' ||
        typeof v.autoanalyzed !== 'boolean' ||
        (v.rows as number) < 1 ||
        (index === 1 && ((v.tuples as number) < 0 || (v.statsColumns as number) < 1))
      )
        throw new Error('E4 source statistics visibility refused');
      return {
        table,
        tuples: v.tuples as number,
        pages: v.pages as number,
        statsColumns: v.statsColumns as number,
        rows: v.rows as number,
        analyzed: v.analyzed,
        autoanalyzed: v.autoanalyzed,
      };
    });
    return {
      stage,
      statistics,
      statisticsDigest: r.statisticsDigest,
      settingsDigest: r.settingsDigest,
      dataUnchanged: true,
    };
  });
  if (
    snapshots[0].settingsDigest !== snapshots[1].settingsDigest ||
    snapshots[0].statistics.some((s, i) => s.rows !== snapshots[1].statistics[i].rows)
  )
    throw new Error('E4 source statistics intervention proof refused');
  const settingsEntries = [...raw.matchAll(/NOTICE:\s+E4_SOURCE_JOIN_SETTINGS (\{[^\n]+\})/gu)];
  if (settingsEntries.length !== 1)
    throw new Error('E4 source statistics settings receipt refused');
  const values = JSON.parse(settingsEntries[0][1]) as Record<string, unknown>;
  if (
    Object.keys(values).length !== SOURCE_STATISTICS_SETTINGS.length ||
    SOURCE_STATISTICS_SETTINGS.some(
      (name) => typeof values[name] !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/u.test(values[name]),
    )
  )
    throw new Error('E4 source statistics settings projection refused');
  const settings = Object.fromEntries(
    SOURCE_STATISTICS_SETTINGS.map((name) => [name, values[name] as string]),
  );
  const settingsDigest = createHash('md5')
    .update(
      [...SOURCE_STATISTICS_SETTINGS]
        .sort()
        .map((name) => name + '=' + settings[name])
        .join(','),
    )
    .digest('hex');
  if (
    settingsDigest !== snapshots[0].settingsDigest ||
    settings.work_mem !== '4096' ||
    settings.jit !== 'on' ||
    settings.plan_cache_mode !== 'auto'
  )
    throw new Error('E4 source statistics effective settings refused');
  const end = [...raw.matchAll(/NOTICE:\s+E4_SOURCE_JOIN_STATS_COMPLETE (\{[^\n]+\})/gu)];
  if (end.length !== 1) throw new Error('E4 source statistics final receipt refused');
  expect(JSON.parse(end[0][1])).toEqual({
    dataUnchanged: true,
    settingsUnchanged: true,
    database: 'app_test_w98',
    analyzedTables: 5,
  });
  return {
    status: 'COMPLETE',
    intervention: 'ANALYZE_FIVE_TEST_TABLES_ONLY',
    initialStatistics: snapshots[0].statistics.every((s) => s.statsColumns === 0)
      ? 'NONE'
      : snapshots[0].statistics.every((s) => s.statsColumns > 0)
        ? 'PRESENT'
        : 'PARTIAL',
    statisticsChanged: snapshots[0].statisticsDigest !== snapshots[1].statisticsDigest,
    snapshots,
    settings,
    settingsDigest,
    businessDataUnchanged: true,
    conditionalOnly: true,
    coldGuarantee: 'NOT_ESTABLISHED_BY_ANALYZED_RESULTS',
  };
}
export function compactSourceJoinEvidence(
  raw: string,
  small: boolean,
  statisticsComparison = false,
) {
  raw = joinKeyDiagnosticNotices(raw);
  if (Buffer.byteLength(raw) > 2097152) throw new Error('E4 source join evidence bound refused');
  if (statisticsComparison && small) throw new Error('E4 source statistics shape refused');
  const statistics = statisticsComparison ? compactSourceStatisticsEvidence(raw) : undefined;
  const order = sourceJoinOrder(small, statisticsComparison);
  const matches = [...raw.matchAll(/NOTICE:\s+E4_JOIN_KEY_SAMPLE (\{[^\n]+\})/gu)];
  if (matches.length !== order.length) throw new Error('E4 source join sample count refused');
  const timings = matches.map((m, index) => {
    const r = JSON.parse(m[1]) as Record<string, unknown>;
    const [phase, variant] = order[index];
    if (
      r.index !== index ||
      r.phase !== phase ||
      r.variant !== variant ||
      r.returned !== true ||
      r.completeDocumentAndRootGuard !== true ||
      r.sameBackend !== true ||
      r.readonly !== true ||
      r.workMemKb !== 4096 ||
      r.jitEnabled !== true ||
      r.planCacheMode !== 'auto' ||
      r.statisticsUnchanged !== true ||
      typeof r.statisticsDigest !== 'string' ||
      !/^[a-f0-9]{32}$/u.test(r.statisticsDigest) ||
      r.statisticsDigest !==
        (statistics
          ? statistics.snapshots[phase === 'PRE_ANALYZE' ? 0 : 1].statisticsDigest
          : (JSON.parse(matches[0][1]) as Record<string, unknown>).statisticsDigest) ||
      (statistics && r.settingsDigest !== statistics.settingsDigest) ||
      typeof r.wallMs !== 'number' ||
      !Number.isFinite(r.wallMs) ||
      r.wallMs <= 0 ||
      r.wallMs > 30000
    )
      throw new Error('E4 source join sample/settings refused');
    return { index, phase, variant, wallMs: r.wallMs };
  });
  const names = small
    ? ['PUBLIC', 'REVERSED_INPUT', 'DUPLICATE_EDGE', 'NULL_LINK', 'MISSING_EDGE', 'NULL_MEMBER']
    : ['PUBLIC'];
  const eq = [...raw.matchAll(/NOTICE:\s+E4_SOURCE_JOIN_EQ (\{[^\n]+\})/gu)];
  if (eq.length !== names.length) throw new Error('E4 source join equivalence count refused');
  const equivalence = eq.map((m, i) => {
    const r = JSON.parse(m[1]) as Record<string, unknown>;
    const mutation = i >= 2;
    if (
      r.case !== names[i] ||
      r.bagEqual !== true ||
      r.hashEqual !== true ||
      r.mutation !== mutation ||
      r.rolledBack !== mutation ||
      typeof r.rows !== 'number' ||
      !Number.isInteger(r.rows) ||
      r.rows < 1 ||
      r.rows > 5000 ||
      (i < 2 && r.rows !== (small ? 5 : 2500)) ||
      (names[i] === 'DUPLICATE_EDGE' && r.rows <= 5) ||
      (['NULL_LINK', 'MISSING_EDGE'].includes(names[i]) && r.rows >= 5) ||
      (names[i] === 'NULL_MEMBER' && r.rows !== 5)
    )
      throw new Error('E4 source join equivalence refused');
    return {
      case: names[i],
      rows: r.rows,
      bagEqual: true,
      hashEqual: true,
      mutation,
      rolledBack: mutation,
    };
  });
  const negatives = compactJoinKeyNegativeCases(raw);
  if (negatives.length !== 6) throw new Error('E4 source join negative count refused');
  const priorities = compactMetadataPriorityEvidence(raw);
  const complete = [...raw.matchAll(/NOTICE:\s+E4_JOIN_KEY_COMPLETE (\{[^\n]+\})/gu)];
  if (complete.length !== 1) throw new Error('E4 source join catalog receipt refused');
  expect(JSON.parse(complete[0][1])).toEqual({
    catalogUnchanged: true,
    guardsUnchanged: true,
    sameBackend: true,
    publicEvaluationCount: small ? 4 : 2000,
  });
  return {
    timings,
    equivalence,
    negatives,
    priorities,
    catalogUnchanged: true,
    guardsUnchanged: true,
    sameBackend: true,
    settings: {
      workMemKb: 4096,
      jitEnabled: true,
      planCacheMode: 'auto',
      ...(statistics
        ? { statisticsControlledPerPhase: true, settingsDigest: statistics.settingsDigest }
        : {
            statisticsUnchanged: true,
            statisticsDigest: (JSON.parse(matches[0][1]) as Record<string, unknown>)
              .statisticsDigest,
          }),
    },
    ...(statistics ? { statisticsExperiment: statistics } : {}),
    statementMs: 30000,
    processMs: 240000,
  };
}
export function compactSourceJoinPlans(
  raw: string,
  pid: number,
  small: boolean,
  complete = true,
  statisticsComparison = false,
) {
  if (Buffer.byteLength(raw) > 2097152) throw new Error('E4 source join log bound refused');
  if (statisticsComparison && small) throw new Error('E4 source statistics shape refused');
  const result = [];
  const order = sourceJoinOrder(small, statisticsComparison).filter(
    ([phase]) => phase !== 'SHADOW_CONTROL',
  );
  for (let index = 0; index < order.length; index++) {
    const [phase, variant] = order[index];
    const begin = new RegExp(
      `^.*?\\[${pid}\\]\\s+LOG:\\s+E4_SOURCE_JOIN_PLAN_BEGIN ${index}\\s*$`,
      'mu',
    ).exec(raw);
    const end = new RegExp(
      `^.*?\\[${pid}\\]\\s+LOG:\\s+E4_SOURCE_JOIN_PLAN_END ${index}\\s*$`,
      'mu',
    ).exec(raw);
    if (!begin || !end) {
      if (!complete) break;
      throw new Error('E4 source join plan boundary refused');
    }
    if (end.index <= begin.index) throw new Error('E4 source join plan boundary refused');
    const plans = compactNativePrepareLog(
      raw.slice(begin.index + begin[0].length, end.index),
      pid,
      false,
      true,
    );
    const shared = plans.records.filter((r) => r.kind === 'E4_SHARED');
    const source = plans.records.filter((r) =>
      r.functions.some((i) =>
        ['e4_source_rows', 'e4_sj_original', 'e4_sj_rows'].includes(plans.dictionary[i]),
      ),
    );
    const completeCalls = plans.records.filter((r) => r.kind === 'E4_COMPLETE_CALL');
    if (
      !complete &&
      (plans.malformed || shared.length !== 1 || source.length !== 1 || completeCalls.length !== 1)
    ) {
      result.push({
        index,
        variant,
        sharedMs: shared[0]?.durationMs ?? null,
        sourceMs: source[0]?.durationMs ?? null,
        completeMs: completeCalls[0]?.durationMs ?? null,
        sourceProbeLoops: null,
        sourceRows: null,
        probes: [],
        jit: shared[0]?.jit ?? [],
        plans,
        coverageMissing: true,
        ...(statisticsComparison ? { statisticsStage: phase } : {}),
      });
      continue;
    }
    if (plans.malformed || shared.length !== 1 || source.length !== 1 || completeCalls.length !== 1)
      throw new Error('E4 source join nested coverage refused');
    const column = (name: string) => plans.nodeColumns.indexOf(name);
    const sourceNodes = source[0].nodes.filter(
      (n) =>
        plans.dictionary[n[column('relation')]!] === 'ParticipantSettlementTimeBucketSource' ||
        plans.dictionary[n[column('index')]!] === 'pstbs_bucket_allocation_key',
    );
    if (!sourceNodes.length) throw new Error('E4 source join source scan missing');
    const probes = sourceNodes.map((n) => ({
      type: plans.dictionary[n[column('type')]!],
      loops: n[column('loops')],
      rowsPerLoop: n[column('rows')],
      estimatedRows: n[column('estimatedRows')],
      rowsFilteredPerLoop: n[column('rowsRemovedFilter')],
    }));
    if (probes.some((n) => n.loops === null || n.rowsPerLoop === null || n.estimatedRows === null))
      throw new Error('E4 source join scan metrics missing');
    const sourceProbeLoops = Math.max(...probes.map((n) => n.loops!));
    const sourceRows = source[0].nodes[0][column('rows')];
    if (sourceRows !== (small ? 5 : 2500)) throw new Error('E4 source join actual shape refused');
    result.push({
      index,
      variant,
      sharedMs: shared[0].durationMs,
      sourceMs: source[0].durationMs,
      completeMs: completeCalls[0].durationMs,
      sourceProbeLoops,
      sourceRows,
      probes,
      jit: shared[0].jit,
      plans,
      coverageMissing: false,
      ...(statisticsComparison ? { statisticsStage: phase } : {}),
    });
  }
  return result;
}
export function sourceJoinSessionSql(
  revisionId: string,
  small: boolean,
  statisticsComparison = false,
) {
  return joinKeyProbeSql(
    revisionId,
    'app_test_w98',
    small ? 4 : 2000,
    false,
    true,
    statisticsComparison,
  ).replace(
    'BEGIN;\nDO $$ BEGIN',
    () =>
      `${nativeSettingsSql}\nBEGIN;\nCREATE TEMP TABLE e4_sj_session AS ${nativeClusterSql()};\nSELECT 'E4_SOURCE_JOIN_SESSION '||row_to_json(s)::TEXT FROM pg_temp.e4_sj_session s;\nDO $$ BEGIN`,
  );
}
async function probeSourceJoin(db: PrismaClient, report: Report, privateDir: string) {
  const small = process.env.SRVF_E4_SOURCE_JOIN === 'small',
    proof = privateDiagnosticProofs.get(report);
  const statisticsComparison = process.env.SRVF_E4_SOURCE_JOIN === 'statistics-500';
  if (!proof || report.oracle !== 'COMPLETE' || proof.units !== (small ? 4 : 2000))
    throw new Error('E4 source join frozen proof refused');
  const capability = readNativeCapability();
  const owner = `e4_sj_${report.head.slice(0, 12)}_${report.run}`;
  const started = performance.now(),
    since = new Date().toISOString();
  report.sourceJoinComparison = {
    status: 'ENTERED',
    candidateSha256: createHash('sha256').update(sourceJoinFunction(true)).digest('hex'),
  };
  const sql = sourceJoinSessionSql(proof.revisionId, small, statisticsComparison);
  const proc = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      `PGAPPNAME=${owner}`,
      'u-nest-api-postgres',
      'psql',
      '-X',
      '-q',
      '-A',
      '-t',
      '-v',
      'ON_ERROR_STOP=1',
      '-v',
      'VERBOSITY=verbose',
      '-v',
      `root_id=${proof.revisionId}`,
      '-U',
      'postgres',
      '-d',
      'app_test_w98',
    ],
    { input: sql, encoding: 'utf8', timeout: 240000, maxBuffer: 2097152 },
  );
  const stderr = joinKeyDiagnosticNotices(proc.stderr ?? '');
  const statisticsFailure = stderr.match(
    /(?:^|\n)ERROR:\s+(?:[A-Z0-9]{5}:\s+)?E4 source statistics ([^\n]+)/u,
  )?.[1];
  const owned = await db.$queryRaw<
    { pid: number }[]
  >`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name=${owner} AND pid<>pg_backend_pid()`;
  if (owned.length > 1) throw new Error('E4 source join backend ownership refused');
  for (const { pid } of owned)
    await db.$queryRaw`SELECT pg_terminate_backend(pid,1000) FROM pg_stat_activity WHERE datname=current_database() AND application_name=${owner} AND pid=${pid}`;
  const [{ remaining }] = await db.$queryRaw<
    { remaining: number }[]
  >`SELECT count(*)::INT AS remaining FROM pg_stat_activity WHERE datname=current_database() AND application_name=${owner}`;
  if (remaining !== 0) throw new Error('E4 source join backend cleanup refused');
  report.sourceJoinStats = {
    ...(report.sourceJoinStats as object),
    afterComparison: await sourceJoinStatistics(db),
  };
  report.sourceJoinComparison = {
    ...(report.sourceJoinComparison as object),
    status: 'INCOMPLETE',
    ownedBackendGone: true,
    exitCode: proc.status,
    signaled: proc.signal !== null,
    processError: !!proc.error,
    wallMs: performance.now() - started,
    nativeErrors: [
      ...new Set([...stderr.matchAll(/ERROR:\s+([A-Z0-9]{5})(?::|\s|$)/gu)].map((m) => m[1])),
    ].slice(0, 4),
    failure: compactJoinKeyFailure(stderr),
    failureReason:
      statisticsFailure === 'initial snapshot unavailable'
        ? 'INITIAL_STATISTICS_UNAVAILABLE'
        : statisticsFailure === 'analyze not visible'
          ? 'ANALYZE_NOT_VISIBLE'
          : statisticsFailure === 'test-only scope refused'
            ? 'TEST_SCOPE_REFUSED'
            : ['data/settings changed', 'final data/settings changed', 'settings changed'].includes(
                  statisticsFailure ?? '',
                )
              ? 'DATA_OR_SETTINGS_CHANGED'
              : stderr.includes('E4 source join statistics changed')
                ? 'STATISTICS_CHANGED'
                : stderr.includes('E4 source join bag/hash equivalence refused')
                  ? 'BAG_OR_HASH_MISMATCH'
                  : 'PROCESS_OR_NATIVE_EXCEPTION',
    priorityProgress: compactMetadataProgress(stderr),
    progress: {
      samples: (stderr.match(/NOTICE:\s+E4_JOIN_KEY_SAMPLE /gu) ?? []).length,
      equivalence: (stderr.match(/NOTICE:\s+E4_SOURCE_JOIN_EQ /gu) ?? []).length,
    },
  };
  const session = proc.stdout.match(/^E4_SOURCE_JOIN_SESSION (\{[^\n]+\})$/mu);
  if (!session) throw new Error('E4 source join backend receipt refused');
  const effective = JSON.parse(session[1]) as NativeSettings;
  validNativeSettings(effective, 'app_test_w98');
  if (effective.cluster !== capability.cluster)
    throw new Error('E4 source join cluster binding refused');
  const success =
    !proc.error && !proc.signal && proc.status === 0 && proc.stdout.includes('E4_JOIN_KEY_SUCCESS');
  const nativeRaw = nativeDockerLog(since, statisticsComparison ? 30000 : 20000);
  const collected = compactSourceJoinPlans(
    nativeRaw,
    effective.pid,
    small,
    false,
    statisticsComparison,
  );
  const plans = collected.map(({ plans, ...summary }) => {
    const artifact = {
      head: report.head,
      run: report.run,
      scenario: report.scenario,
      purpose: 'DIAGNOSTIC_ONLY',
      coverage: 'PREPARE_SOURCE_JOIN_ONLY',
      ...summary,
      plans,
    };
    const file = `source-join-plan-${summary.index}.json`;
    writeBounded(join(privateDir, file), artifact);
    return {
      ...summary,
      file,
      sha256: createHash('sha256')
        .update(JSON.stringify(artifact) + '\n')
        .digest('hex'),
    };
  });
  const baseline = plans.filter((p) => p.variant === 'BASELINE'),
    candidate = plans.filter((p) => p.variant === 'CANDIDATE');
  report.sourceJoinComparison = { ...(report.sourceJoinComparison as object), plans };
  if (!success) throw new Error('E4 source join process refused');
  compactSourceJoinPlans(nativeRaw, effective.pid, small, true, statisticsComparison);
  let evidence: ReturnType<typeof compactSourceJoinEvidence>;
  try {
    evidence = compactSourceJoinEvidence(stderr, small, statisticsComparison);
  } catch (error) {
    report.sourceJoinComparison = {
      ...(report.sourceJoinComparison as object),
      failureReason:
        error instanceof Error && error.message === 'E4 source join equivalence count refused'
          ? 'SOURCE_EQ_NOTICE_COUNT'
          : 'EVIDENCE_CONTRACT',
    };
    throw error;
  }
  report.sourceJoinComparison = {
    status: 'COMPLETE',
    small,
    ownedBackendGone: true,
    ...evidence,
    plans,
    wallMs: performance.now() - started,
    sourceFunctionSha256: SOURCE_JOIN_BASELINE_SHA,
    candidateSha256: createHash('sha256').update(sourceJoinFunction(true)).digest('hex'),
    calibration: small ? null : readSourceJoinCalibration(),
    probeReductionObserved:
      small || statisticsComparison
        ? null
        : Math.max(...candidate.map((p) => p.sourceProbeLoops ?? Infinity)) <= 4000 &&
          Math.min(...baseline.map((p) => p.sourceProbeLoops ?? 0)) > 4000,
    productionTriggerCoverage: 'ORIGINAL_PREPARE_UNCHANGED_COMPARISON_ONLY_TEMP_FUNCTIONS',
    observation: {
      sourceHelperMinimumMs: 0,
      outerMinimumMs: 50,
      symmetricTemporarySourceAndCompleteCopies: true,
    },
    physicalRowOrder: 'UNSPECIFIED_SQL_ORDER_WINDOW_AND_CANONICAL_ORDER_UNCHANGED',
    ...(statisticsComparison
      ? {
          comparisonDesign: 'ONE_OBSERVED_A_THEN_FIVE_TABLE_ANALYZE_THEN_ANALYZED_ABBA',
          catalogScope:
            'FUNCTION_BODIES_AND_TRIGGERS_UNCHANGED_PLANNER_STATISTICS_INTENTIONALLY_CHANGED',
          coldGuarantee: 'ANALYZED_RESULTS_ARE_CONDITIONAL_NOT_A_COLD_START_GUARANTEE',
        }
      : {}),
  };
  report.internalSqlPlan = 'OBSERVED';
  if (
    !small &&
    !statisticsComparison &&
    !(report.sourceJoinComparison as { probeReductionObserved: boolean }).probeReductionObserved
  )
    throw new Error('E4 source join probe reduction not observed');
  await verifyDiagnosticDatabase(db);
  await verifyDiagnosticGuards(db);
}

const NATIVE_PLAN_NODE_TYPES = [
  'Result',
  'ProjectSet',
  'ModifyTable',
  'Append',
  'Merge Append',
  'Recursive Union',
  'BitmapAnd',
  'BitmapOr',
  'Nested Loop',
  'Merge Join',
  'Hash Join',
  'Seq Scan',
  'Sample Scan',
  'Gather',
  'Gather Merge',
  'Index Scan',
  'Index Only Scan',
  'Bitmap Index Scan',
  'Bitmap Heap Scan',
  'Tid Scan',
  'Tid Range Scan',
  'Subquery Scan',
  'Function Scan',
  'Table Function Scan',
  'Values Scan',
  'CTE Scan',
  'Named Tuplestore Scan',
  'WorkTable Scan',
  'Foreign Scan',
  'Custom Scan',
  'Materialize',
  'Memoize',
  'Sort',
  'Incremental Sort',
  'Group',
  'Aggregate',
  'WindowAgg',
  'Unique',
  'SetOp',
  'LockRows',
  'Limit',
  'Hash',
];
const NATIVE_PLAN_COLUMNS = [
  'parent',
  'type',
  'relation',
  'index',
  'cte',
  'rows',
  'loops',
  'estimatedRows',
  'nodeInclusiveMsPerLoop',
  'tempRead',
  'tempWritten',
  'sharedHit',
  'sharedRead',
  'sort',
  'sortKb',
  'hashBatches',
  'walBytes',
  'rowsRemovedFilter',
  'function',
];
const NATIVE_CAP_OBJECTS = [
  'e4_native_cap_parent',
  'e4_native_cap_parent_pkey',
  'e4_native_cap_target',
  'e4_native_cap_target_parent_id_fkey',
  'e4_native_cap_trigger',
];
let nativeTrustedObjects: Set<string> | undefined;
function nativeObjects() {
  if (nativeTrustedObjects) return nativeTrustedObjects;
  const schema = readFileSync(resolve(__dirname, '../../prisma/schema.prisma'), 'utf8');
  const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gmu)].map((m) => m[1]);
  const root = resolve(__dirname, '../../prisma/migrations');
  const source = readdirSync(root)
    .filter((n) => /^\d{14}_/u.test(n))
    .sort()
    .map((n) => readFileSync(join(root, n, 'migration.sql'), 'utf8'))
    .join('\n');
  const identifiers = [
    ...source.matchAll(
      /(?:CONSTRAINT|(?:UNIQUE\s+)?INDEX|TRIGGER|FUNCTION)\s+(?:"([A-Za-z0-9_]+)"|([A-Za-z_][A-Za-z0-9_]*))/gu,
    ),
  ].map((m) => m[1] ?? m[2]);
  const ctes = [
    ...source.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s+AS\s+(?:(?:NOT\s+)?MATERIALIZED\s+)?\(/gu),
  ].map((m) => m[1]);
  nativeTrustedObjects = new Set([
    ...models,
    ...models.map((n) => n + '_pkey'),
    ...identifiers,
    ...ctes,
    ...NATIVE_CAP_OBJECTS,
    ...NATIVE_PLAN_NODE_TYPES,
    'FOREIGN_KEY',
    'time_source_edges',
    'e4_sj_rows',
    'e4_sj_original',
    'e4_sj_complete_baseline',
    'e4_join_candidate',
    'quicksort',
    'external merge',
    'top-N heapsort',
    'heapsort',
    'jsonb_array_elements',
    'jsonb_each',
    'jsonb_to_recordset',
    'generate_series',
  ]);
  return nativeTrustedObjects;
}
type NativePlanCategory = 'EVAL_INSERT' | 'RECEIPT' | 'BUCKETS' | 'SOURCES' | 'BARRIER' | 'OTHER';
type NativePlanEvent = { calls: number; durationMs: number; largestMs: number };
export function nativePlanCategory(sql: string): NativePlanCategory {
  const value = sql
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/;$/u, '')
    .replace(/^INSERT INTO "public"\./u, 'INSERT INTO ');
  if (
    value ===
    'SET CONSTRAINTS public.astr_parent_complete_guard, public.e4_revision_complete_guard IMMEDIATE'
  )
    return 'BARRIER';
  for (const [name, category] of [
    ['ParticipantContributionEvaluation', 'EVAL_INSERT'],
    ['ActivitySettlementTimeCommandReceipt', 'RECEIPT'],
    ['ParticipantSettlementTimeBucket', 'BUCKETS'],
    ['ParticipantSettlementTimeBucketSource', 'SOURCES'],
  ] as const)
    if (value.startsWith(`INSERT INTO "${name}"`)) return category;
  return 'OTHER';
}
/** Values, expressions, query text, parameter data and arbitrary identifiers are never projected. */
export function compactNativePrepareLog(
  raw: string,
  pid: number,
  capability = false,
  sourceJoin = false,
) {
  if (Buffer.byteLength(raw) > 2097152 || !Number.isInteger(pid) || pid < 1)
    throw new Error('E4 native log bound refused');
  const dictionary = ['OTHER'];
  const trusted = nativeObjects();
  const intern = (value: unknown) => {
    if (typeof value !== 'string' || !trusted.has(value)) return 0;
    let index = dictionary.indexOf(value);
    if (index < 0) {
      index = dictionary.length;
      dictionary.push(value);
    }
    return index;
  };
  const metric = (value: unknown): number | null => {
    if (value === undefined) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e15)
      throw new Error('E4 native metric refused');
    return value;
  };
  const normalize = (s: string) =>
    s
      .replace(/INTO source_invalid,evaluation_mismatch/gu, '')
      .replace(/\s+/gu, ' ')
      .trim()
      .replace(/;$/u, '');
  const shared = normalize(sharedGuardStatement());
  const sourceShared = sourceJoin
    ? normalize(
        sharedGuardStatement().replace(
          'SELECT * FROM e4_source_rows(root.id)',
          'SELECT * FROM pg_temp.e4_sj_rows(root.id)',
        ),
      )
    : null;
  const sourceBaselineShared = sourceJoin
    ? normalize(
        sharedGuardStatement().replace(
          'SELECT * FROM e4_source_rows(root.id)',
          'SELECT * FROM pg_temp.e4_sj_original(root.id)',
        ),
      )
    : null;
  type RecordRow = {
    kind: string;
    site: string;
    durationMs: number;
    functions: number[];
    nodes: (number | null)[][];
    triggers: (number | null)[][];
    jit: (number | null)[];
  };
  const records: RecordRow[] = [];
  let nodes = 0;
  let malformed = 0;
  let current: { pid: number; level: string; text: string } | undefined;
  let last: RecordRow | undefined;
  const consume = () => {
    if (!current || current.pid !== pid) return;
    if (current.level === 'CONTEXT' && last) {
      for (const m of current.text.matchAll(
        /(?:PL\/pgSQL function|SQL function)\s+"?([A-Za-z_][A-Za-z0-9_.]*)/gu,
      )) {
        const index = intern(m[1].split('.').at(-1));
        if (index && !last.functions.includes(index)) last.functions.push(index);
      }
      return;
    }
    last = undefined;
    const header = current.text.match(/^duration:\s+([0-9.]+) ms\s+plan:\s*\n/u);
    if (current.level !== 'LOG' || !header) return;
    if (records.length >= 64) throw new Error('E4 native plan count bound refused');
    try {
      const document = JSON.parse(current.text.slice(header[0].length).trim()) as Record<
        string,
        unknown
      >;
      if (!document.Plan || typeof document.Plan !== 'object') throw new Error('plan');
      const query = typeof document['Query Text'] === 'string' ? document['Query Text'] : '';
      const category = nativePlanCategory(query);
      const kind =
        normalize(query) === shared ||
        (sourceJoin && [sourceShared, sourceBaselineShared].includes(normalize(query)))
          ? 'E4_SHARED'
          : /^SELECT\s+(?:public\.)?e4_assert_complete\(/iu.test(query.trim()) ||
              (sourceJoin &&
                /^SELECT\s+pg_temp\.(?:e4_join_candidate|e4_sj_complete_baseline)\(/iu.test(
                  query.trim(),
                ))
            ? 'E4_COMPLETE_CALL'
            : capability && /^INSERT INTO e4_native_cap_target/u.test(query.trim())
              ? 'CAP_INSERT'
              : category === 'OTHER'
                ? 'NESTED'
                : category;
      const row: RecordRow = {
        kind,
        site: category === 'OTHER' ? 'UNKNOWN' : category,
        durationMs: metric(+header[1])!,
        functions: [],
        nodes: [],
        triggers: [],
        jit: [],
      };
      const walk = (input: unknown, parent: number | null, depth: number) => {
        if (
          !input ||
          typeof input !== 'object' ||
          Array.isArray(input) ||
          depth > 24 ||
          ++nodes > 512
        )
          throw new Error('E4 native node bound refused');
        const n = input as Record<string, unknown>;
        const id = row.nodes.length;
        row.nodes.push([
          parent,
          intern(n['Node Type']),
          intern(n['Relation Name']),
          intern(n['Index Name']),
          intern(n['CTE Name']),
          metric(n['Actual Rows']),
          metric(n['Actual Loops']),
          metric(n['Plan Rows']),
          metric(n['Actual Total Time']),
          metric(n['Temp Read Blocks']),
          metric(n['Temp Written Blocks']),
          metric(n['Shared Hit Blocks']),
          metric(n['Shared Read Blocks']),
          intern(n['Sort Method']),
          metric(n['Sort Space Used']),
          metric(n['Hash Batches']),
          metric(n['WAL Bytes']),
          metric(n['Rows Removed by Filter']),
          intern(n['Function Name']),
        ]);
        if (n.Plans !== undefined) {
          if (!Array.isArray(n.Plans)) throw new Error('children');
          for (const c of n.Plans) walk(c, id, depth + 1);
        }
      };
      walk(document.Plan, null, 0);
      if (document.JIT && typeof document.JIT === 'object') {
        const jit = document.JIT as Record<string, unknown>;
        const timing =
          jit.Timing && typeof jit.Timing === 'object'
            ? (jit.Timing as Record<string, unknown>)
            : {};
        row.jit = [
          metric(jit.Functions),
          ...['Generation', 'Inlining', 'Optimization', 'Emission', 'Total'].map((key) =>
            metric(timing[key]),
          ),
        ];
      }
      if (document.Triggers !== undefined) {
        if (!Array.isArray(document.Triggers)) throw new Error('triggers');
        for (const input of document.Triggers) {
          if (!input || typeof input !== 'object') throw new Error('trigger');
          const t = input as Record<string, unknown>;
          row.triggers.push([
            intern(
              typeof t['Trigger Name'] === 'string' &&
                /^RI_ConstraintTrigger_[ac]_\d+$/u.test(t['Trigger Name'])
                ? 'FOREIGN_KEY'
                : t['Trigger Name'],
            ),
            intern(t['Constraint Name']),
            intern(t.Relation),
            metric(t.Time),
            metric(t.Calls),
          ]);
        }
      }
      records.push(row);
      last = row;
    } catch (error) {
      if (error instanceof Error && /bound refused|metric refused/u.test(error.message))
        throw error;
      malformed++;
    }
  };
  for (const line of raw.split('\n')) {
    const h = line.match(/^\d{4}-\d\d-\d\d .*?\[(\d+)\]\s+([A-Z]+):\s*(.*)$/u);
    if (h) {
      consume();
      current = { pid: +h[1], level: h[2], text: h[3] };
    } else if (current) current.text += '\n' + line;
  }
  consume();
  for (const row of records) {
    const names = row.functions.map((i) => dictionary[i]);
    if (names.includes('e4_evaluation_set_guard')) row.site = 'EVAL_INSERT';
    else if (names.includes('e4_revision_complete_guard')) row.site = 'BARRIER';
    else if (names.includes('astr_receipt_complete_guard')) row.site = 'RECEIPT';
    else if (names.includes('e4_native_cap_trigger')) row.site = 'CAP_TRIGGER';
  }
  const result = {
    format: 'NATIVE_PG16_PLAN_V1',
    nodeColumns: NATIVE_PLAN_COLUMNS,
    triggerColumns: ['trigger', 'constraint', 'relation', 'timeMs', 'calls'],
    jitColumns: [
      'functions',
      'generationMs',
      'inliningMs',
      'optimizationMs',
      'emissionMs',
      'totalMs',
    ],
    dictionary,
    records,
    malformed,
    nodeTiming: 'INCLUSIVE_AVERAGE_PER_LOOP_DO_NOT_SUM',
    parameterData: 'OMITTED',
    rawBytes: Buffer.byteLength(raw),
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 49152)
    throw new Error('E4 native closed output bound refused');
  return result;
}

const nativeSettingsSql = `LOAD 'auto_explain';
SET auto_explain.log_min_duration=-1;
SET auto_explain.log_level='log'; SET auto_explain.log_format='json';
SET auto_explain.log_parameter_max_length=0; SET auto_explain.log_analyze=on;
SET auto_explain.log_buffers=on; SET auto_explain.log_wal=on; SET auto_explain.log_timing=on;
SET auto_explain.log_triggers=on; SET auto_explain.log_settings=on; SET auto_explain.log_nested_statements=on; SET auto_explain.sample_rate=1;`;
function nativeDockerLog(since: string, tail = 20000) {
  if (tail !== 20000 && tail !== 30000) throw new Error('E4 native log line bound refused');
  const r = spawnSync(
    'docker',
    ['logs', '--since', since, '--tail', String(tail), 'u-nest-api-postgres'],
    { encoding: 'utf8', timeout: 10000, maxBuffer: 2097152 },
  );
  if (r.error || r.signal || r.status !== 0)
    throw new Error('E4 native server log capture refused');
  const raw = r.stdout + r.stderr;
  if (Buffer.byteLength(raw) > 2097152) throw new Error('E4 native raw log bound refused');
  return raw;
}
function nativeClusterSql() {
  return `SELECT pg_backend_pid() AS pid,current_database() AS database,current_setting('server_version_num')::INT AS server,
  encode(sha256(convert_to((SELECT system_identifier::TEXT FROM pg_control_system()),'UTF8')),'hex') AS cluster,
  current_setting('auto_explain.log_parameter_max_length') AS parameters,current_setting('auto_explain.log_timing') AS timing,
  current_setting('auto_explain.log_triggers') AS triggers,current_setting('auto_explain.log_nested_statements') AS nested,
  position('%p' in current_setting('log_line_prefix'))>0 AS prefix,current_setting('log_timezone') AS timezone,
  current_setting('application_name') AS application,current_setting('auto_explain.log_min_duration') AS minimum`;
}
type NativeSettings = {
  pid: number;
  database: string;
  server: number;
  cluster: string;
  parameters: string;
  timing: string;
  triggers: string;
  nested: string;
  prefix: boolean;
  timezone: string;
  application: string;
  minimum: string;
};
function validNativeSettings(value: NativeSettings, database: string) {
  if (
    value.database !== database ||
    value.server < 160000 ||
    value.server >= 170000 ||
    value.parameters !== '0' ||
    value.timing !== 'on' ||
    value.triggers !== 'on' ||
    value.nested !== 'on' ||
    !value.prefix ||
    !['UTC', 'Etc/UTC'].includes(value.timezone) ||
    !/^[a-f0-9]{64}$/u.test(value.cluster)
  )
    throw new Error('E4 native effective settings refused');
}

export function validateNativeCapability(value: unknown, head: string, run: string) {
  if (!value || typeof value !== 'object') throw new Error('E4 native capability receipt refused');
  const r = value as Record<string, unknown>;
  if (
    r.head !== head ||
    r.run !== run ||
    r.status !== 'COMPLETE' ||
    r.server !== 16 ||
    r.triggerTiming !== true ||
    r.foreignKeyTiming !== true ||
    r.functionLocalSourcePlan !== true ||
    r.nested !== true ||
    r.redacted !== true ||
    typeof r.cluster !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(r.cluster)
  )
    throw new Error('E4 native capability binding refused');
  return {
    head,
    run,
    status: 'COMPLETE',
    server: 16,
    triggerTiming: true,
    foreignKeyTiming: true,
    functionLocalSourcePlan: true,
    nested: true,
    redacted: true,
    cluster: r.cluster,
  };
}
function readNativeCapability() {
  const file = resolve(process.cwd(), 'tmp/e4-prepare-cost-evidence/native-capability.json');
  const raw = readFileSync(file);
  if (raw.length > 4096) throw new Error('E4 native capability receipt bound refused');
  return validateNativeCapability(
    JSON.parse(raw.toString()),
    process.env.GITHUB_SHA!,
    process.env.GITHUB_RUN_ID!,
  );
}
function runNativeCapability() {
  if (process.env.GITHUB_ACTIONS === 'true') {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    requireDiagnosticEnvironment(process.env, head);
    if (process.env.SRVF_E4_NATIVE_PREPARE_PLAN !== '1' && !process.env.SRVF_E4_SOURCE_JOIN)
      throw new Error('E4 native capability scope refused');
  }
  const since = new Date().toISOString();
  const sql = `SET statement_timeout='5s'; SET idle_in_transaction_session_timeout='5s'; BEGIN;
CREATE TEMP TABLE e4_native_cap_parent(id INTEGER PRIMARY KEY);
CREATE TEMP TABLE e4_native_cap_target(parent_id INTEGER REFERENCES e4_native_cap_parent(id),payload TEXT);
INSERT INTO e4_native_cap_parent VALUES (1);
CREATE FUNCTION pg_temp.e4_native_cap_trigger() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN PERFORM count(*) FROM pg_temp.e4_native_cap_target; RETURN NULL; END $$;
CREATE TRIGGER e4_native_cap_trigger AFTER INSERT ON e4_native_cap_target FOR EACH STATEMENT EXECUTE FUNCTION pg_temp.e4_native_cap_trigger();
${nativeSettingsSql}
SET auto_explain.log_min_duration=0;
INSERT INTO e4_native_cap_target VALUES (1,'E4_PRIVATE_CANARY');
CREATE FUNCTION pg_temp.e4_sj_original() RETURNS BIGINT LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp SET auto_explain.log_min_duration='0' AS $$ SELECT count(*) FROM pg_temp.e4_native_cap_target $$;
SET auto_explain.log_min_duration='50ms'; SELECT pg_temp.e4_sj_original();
SET auto_explain.log_min_duration=-1;
SELECT row_to_json(s)::TEXT FROM (${nativeClusterSql()}) s; ROLLBACK;`;
  const r = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      'u-nest-api-postgres',
      'psql',
      '-X',
      '-q',
      '-A',
      '-t',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'postgres',
    ],
    { input: sql, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 },
  );
  if (r.error || r.signal || r.status !== 0) throw new Error('E4 native capability SQL refused');
  const effective = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as NativeSettings;
  validNativeSettings(effective, 'postgres');
  const { pid, cluster } = effective;
  const plan = compactNativePrepareLog(nativeDockerLog(since), pid, true);
  const insert = plan.records.find((p) => p.kind === 'CAP_INSERT');
  if (
    plan.malformed ||
    !insert ||
    !insert.triggers.some(
      (t) => plan.dictionary[t[0]!] === 'e4_native_cap_trigger' && t[3] !== null && t[4] === 1,
    ) ||
    !insert.triggers.some(
      (t) => plan.dictionary[t[0]!] === 'FOREIGN_KEY' && t[3] !== null && t[4] === 1,
    ) ||
    !plan.records.some((p) => p.site === 'CAP_TRIGGER') ||
    !plan.records.some((p) => p.functions.some((i) => plan.dictionary[i] === 'e4_sj_original')) ||
    JSON.stringify(plan).includes('E4_PRIVATE_CANARY')
  )
    throw new Error('E4 native capability evidence incomplete');
  const evidence = {
    head:
      process.env.GITHUB_SHA ??
      execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    run: process.env.GITHUB_RUN_ID ?? 'LOCAL_CAPABILITY',
    status: 'COMPLETE',
    server: 16,
    triggerTiming: true,
    foreignKeyTiming: true,
    functionLocalSourcePlan: true,
    nested: true,
    redacted: true,
    cluster,
    temporaryOnly: true,
  };
  if (process.env.GITHUB_ACTIONS === 'true') {
    const file = resolve(process.cwd(), 'tmp/e4-prepare-cost-evidence/native-capability.json');
    mkdirSync(dirname(file), { recursive: true });
    writeBounded(file, evidence);
  }
  console.info('E4_NATIVE_CAPABILITY ' + JSON.stringify(evidence));
}

export function nativePlanFailureCategory(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (!message.startsWith('E4 native ')) return 'UNCLASSIFIED';
  if (/bound/u.test(message)) return 'CAPTURE_BOUND';
  if (/settings|backend/u.test(message)) return 'SESSION_IDENTITY_OR_SETTINGS';
  if (/capability/u.test(message)) return 'CAPABILITY_INCOMPLETE';
  if (/evidence|missing/u.test(message)) return 'PLAN_EVIDENCE_INCOMPLETE';
  return 'CAPTURE_FAILED';
}
export function nativePrepareCompleteness(
  plans: ReturnType<typeof compactNativePrepareLog>,
  events: Record<NativePlanCategory, NativePlanEvent>,
  completed: boolean,
  invalid: number,
) {
  const missing: string[] = [];
  if (!completed) missing.push('PREPARE_FAILED');
  if (invalid) missing.push('INVALID_EVENT');
  if (plans.malformed) missing.push('MALFORMED_PLAN');
  for (const kind of ['EVAL_INSERT', 'RECEIPT', 'BARRIER'] as const)
    if (events[kind].calls !== 1) missing.push(kind + '_EVENT');
  for (const [kind, trigger] of [
    ['EVAL_INSERT', 'e4_evaluation_set_guard'],
    ['RECEIPT', 'astcr_receipt_complete_guard'],
  ]) {
    const rows = plans.records.filter((p) => p.kind === kind);
    const t = rows[0]?.triggers.find((t) => plans.dictionary[t[0]!] === trigger);
    if (rows.length !== 1 || !t || t[3] === null || t[4] !== 1)
      missing.push(kind + '_PLAN_OR_TRIGGER');
  }
  for (const site of ['EVAL_INSERT', 'BARRIER']) {
    if (plans.records.filter((p) => p.kind === 'E4_COMPLETE_CALL' && p.site === site).length !== 1)
      missing.push(site + '_COMPLETE_FUNCTION');
    if (plans.records.filter((p) => p.kind === 'E4_SHARED' && p.site === site).length !== 1)
      missing.push(site + '_SHARED_PLAN');
  }
  const evaluation = plans.records.find((p) => p.kind === 'EVAL_INSERT');
  const foreignKeys = evaluation?.triggers.filter((t) => plans.dictionary[t[0]!] === 'FOREIGN_KEY');
  if (!foreignKeys?.length || foreignKeys.some((t) => t[3] === null || t[4] === null || t[4] < 1))
    missing.push('EVAL_FOREIGN_KEY_TIMING');
  return { status: missing.length ? 'INCOMPLETE' : 'COMPLETE', missing };
}
type NativePrepareCapture = Awaited<ReturnType<typeof startNativePrepareCapture>>;
async function startNativePrepareCapture(db: PrismaClient, pid: number) {
  const capability = readNativeCapability();
  const [original] = await db.$queryRaw<
    { application: string }[]
  >`SELECT current_setting('application_name') AS application`;
  for (const sql of nativeSettingsSql
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean))
    await db.$executeRaw(Prisma.raw(sql));
  const application = `e4_native_${process.env.GITHUB_SHA!.slice(0, 12)}_${process.env.GITHUB_RUN_ID}`;
  await db.$queryRaw`SELECT set_config('application_name',${application},false)`;
  const [effective] = await db.$queryRaw<NativeSettings[]>(Prisma.raw(nativeClusterSql()));
  validNativeSettings(effective, 'app_test_w98');
  if (effective.pid !== pid || effective.cluster !== capability.cluster)
    throw new Error('E4 native backend binding refused');
  const events = Object.fromEntries(
    ['EVAL_INSERT', 'RECEIPT', 'BUCKETS', 'SOURCES', 'BARRIER', 'OTHER'].map((k) => [
      k,
      { calls: 0, durationMs: 0, largestMs: 0 },
    ]),
  ) as Record<NativePlanCategory, NativePlanEvent>;
  const since = new Date().toISOString();
  await db.$executeRaw`SET auto_explain.log_min_duration='50ms'`;
  const [enabled] = await db.$queryRaw<NativeSettings[]>(Prisma.raw(nativeClusterSql()));
  validNativeSettings(enabled, 'app_test_w98');
  if (enabled.pid !== pid || !/^50(?:ms)?$/u.test(enabled.minimum))
    throw new Error('E4 native settings enable refused');
  let active = true;
  let invalid = 0;
  return {
    event(sql: string, duration: number) {
      if (!active) return;
      if (!Number.isFinite(duration) || duration < 0 || duration > 90000) {
        invalid++;
        return;
      }
      const row = events[nativePlanCategory(sql)];
      row.calls++;
      row.durationMs += duration;
      row.largestMs = Math.max(row.largestMs, duration);
    },
    async finish(completed: boolean) {
      active = false;
      await db.$executeRaw`SET auto_explain.log_min_duration=-1`;
      const [after] = await db.$queryRaw<NativeSettings[]>(Prisma.raw(nativeClusterSql()));
      validNativeSettings(after, 'app_test_w98');
      await db.$queryRaw`SELECT set_config('application_name',${original.application},false)`;
      if (after.pid !== pid || after.cluster !== capability.cluster || after.minimum !== '-1')
        throw new Error('E4 native backend restore refused');
      const plans = compactNativePrepareLog(nativeDockerLog(since), pid);
      const evalPlan = plans.records.filter((p) => p.kind === 'EVAL_INSERT');
      const receiptPlan = plans.records.filter((p) => p.kind === 'RECEIPT');
      const e4Calls = plans.records.filter((p) => p.kind === 'E4_COMPLETE_CALL');
      const named = (row: (typeof plans.records)[number] | undefined, name: string) =>
        row?.triggers.find((t) => plans.dictionary[t[0]!] === name);
      const e4Trigger = named(evalPlan[0], 'e4_evaluation_set_guard');
      const receiptTrigger = named(receiptPlan[0], 'astcr_receipt_complete_guard');
      return {
        ...nativePrepareCompleteness(plans, events, completed, invalid),
        purpose: 'INSTRUMENTED_ORIGINAL500_PREPARE_NOT_ACCEPTANCE',
        sameBackend: true,
        server: 16,
        capability,
        parametersLogged: false,
        timingOn: true,
        minimumMs: 50,
        tracingDisabledAfter: true,
        statementEvents: events,
        invalidEvents: invalid,
        plans,
        breakdown: {
          evaluationStatementTriggerMs: e4Trigger?.[3] ?? null,
          receiptTriggerMs: receiptTrigger?.[3] ?? null,
          evaluationForeignKeyMs: (() => {
            const rows = evalPlan[0]?.triggers.filter(
              (t) => plans.dictionary[t[0]!] === 'FOREIGN_KEY',
            );
            return rows?.length && rows.every((t) => t[3] !== null)
              ? rows.reduce((sum, t) => sum + t[3]!, 0)
              : null;
          })(),
          barrierCompleteFunctionMs: e4Calls.find((p) => p.site === 'BARRIER')?.durationMs ?? null,
        },
        timingMeaning: 'TRIGGER_CUMULATIVE_AND_NODE_INCLUSIVE_DO_NOT_ADD_PARENTS_AND_CHILDREN',
      };
    },
    partial() {
      active = false;
      return {
        status: 'INCOMPLETE',
        purpose: 'INSTRUMENTED_ORIGINAL500_PREPARE_NOT_ACCEPTANCE',
        statementEvents: events,
        invalidEvents: invalid,
      };
    },
  };
}

if (process.env.SRVF_E4_DIAGNOSTIC_CHILD === '1') registerDiagnosticChild();
if (require.main === module) {
  if (process.argv.length === 3 && process.argv[2] === '--plan')
    console.info(JSON.stringify(E4_DIAGNOSTIC_PLAN, null, 2));
  else if (process.argv.length === 3 && process.argv[2] === '--real-statistics-capability') {
    try {
      runRealStatisticsCapability();
    } catch {
      const evidence = {
        head: process.env.GITHUB_SHA,
        run: process.env.GITHUB_RUN_ID,
        status: 'FAILED',
        businessFixtureExecuted: false,
      };
      if (process.env.GITHUB_ACTIONS === 'true') {
        const file = resolve(
          process.cwd(),
          'tmp/e4-prepare-cost-evidence/real-statistics-capability.json',
        );
        mkdirSync(dirname(file), { recursive: true });
        writeBounded(file, evidence);
      }
      console.error('E4_REAL_STATISTICS_CAPABILITY_FAILURE ' + JSON.stringify(evidence));
      process.exitCode = 1;
    }
  } else if (process.argv.length === 3 && process.argv[2] === '--native-plan-capability') {
    try {
      runNativeCapability();
    } catch (error) {
      const evidence = {
        head: process.env.GITHUB_SHA,
        run: process.env.GITHUB_RUN_ID,
        status: 'FAILED',
        category: nativePlanFailureCategory(error),
        businessFixtureExecuted: false,
      };
      if (process.env.GITHUB_ACTIONS === 'true') {
        const file = resolve(process.cwd(), 'tmp/e4-prepare-cost-evidence/native-capability.json');
        mkdirSync(dirname(file), { recursive: true });
        writeBounded(file, evidence);
      }
      console.error('E4_NATIVE_CAPABILITY_FAILURE ' + JSON.stringify(evidence));
      process.exitCode = 1;
    }
  } else if (process.argv.length === 3 && process.argv[2] === '--source-join-calibration') {
    try {
      verifySourceJoinCalibration();
    } catch {
      console.error(
        'E4_SOURCE_JOIN_CALIBRATION_FAILURE ' +
          JSON.stringify({ category: 'CALIBRATION_NOT_VERIFIED', businessFixtureExecuted: false }),
      );
      process.exitCode = 1;
    }
  } else if (process.argv.length === 3 && process.argv[2] === '--canonical-equivalence') {
    try {
      runMetadataCanonicalEquivalence();
    } catch {
      console.error('E4 metadata equivalence refused or failed; no fixture executed');
      process.exitCode = 1;
    }
  } else if (process.argv.length === 3 && process.argv[2] === '--execute')
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
    console.error('Use --plan, --canonical-equivalence or explicit supervised --execute');
    process.exitCode = 1;
  }
}
