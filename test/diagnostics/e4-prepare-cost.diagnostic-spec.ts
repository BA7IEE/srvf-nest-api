import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, renameSync } from 'node:fs';
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
type Report = Omit<typeof E4_DIAGNOSTIC_PLAN, 'internalSqlPlan'> & {
  internalSqlPlan: 'NOT_RUN' | 'OBSERVED';
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
    | 'PREPARE_ORACLE_AND_JOIN_KEY_ONLY';
  joinKeyCandidate?: unknown;
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

export function joinKeyProbeSql(revisionId: string, databaseName: string) {
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
  const candidateBody = body(joinKeyCandidateSource());
  const shadow = (input: string) =>
    input
      .replaceAll('"ParticipantContributionEvaluation"', 'pg_temp.e4_probe_evaluations')
      .replaceAll(
        'e4_evaluation_document(e)',
        'e4_evaluation_document(jsonb_populate_record(NULL::public."ParticipantContributionEvaluation",to_jsonb(e)))',
      );
  const create = (name: string, contents: string) =>
    `CREATE FUNCTION pg_temp.${name}(revision_id TEXT, validate_version BOOLEAN DEFAULT TRUE) RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $e4_copy$${contents}$e4_copy$;\n`;
  const guardDigest = `(SELECT md5(string_agg(to_jsonb(t)::text,',' ORDER BY t.oid)) FROM pg_trigger t
    WHERE t.tgrelid IN ('public."ParticipantContributionEvaluation"'::regclass,
      'public."ActivitySettlementContributionRevision"'::regclass,'public."AttendanceSettlementVersion"'::regclass))`;
  const settings = `SET LOCAL statement_timeout='30s';
SET LOCAL idle_in_transaction_session_timeout='30s';
SET LOCAL plan_cache_mode='force_custom_plan';\n`;
  let sql = `SET statement_timeout='30s';
LOAD 'auto_explain';
SET auto_explain.log_min_duration=-1;
SET client_min_messages='notice';
SET auto_explain.log_level='notice';
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
CREATE TEMP TABLE e4_probe_metadata AS SELECT pg_backend_pid() AS pid,${guardDigest} AS guards;
CREATE TEMP TABLE e4_probe_evaluations AS SELECT * FROM public."ParticipantContributionEvaluation" WHERE "contributionRevisionId"=:'root_id';
CREATE TEMP TABLE e4_probe_marks(label TEXT);
${create('e4_join_candidate', candidateBody)}
${create('e4_baseline_shadow', shadow(baselineBody))}
${create('e4_candidate_shadow', shadow(candidateBody))}
COMMIT;\n`;
  for (const [index, [phase, variant]] of JOIN_KEY_ORDER.entries()) {
    const callable =
      phase === 'SHADOW_CONTROL'
        ? variant === 'BASELINE'
          ? 'pg_temp.e4_baseline_shadow'
          : 'pg_temp.e4_candidate_shadow'
        : variant === 'BASELINE'
          ? 'public.e4_assert_complete'
          : 'pg_temp.e4_join_candidate';
    sql += `BEGIN READ ONLY;
${settings}
SET LOCAL auto_explain.log_min_duration=${phase === 'ACTUAL_PLAN' ? '1000' : '-1'};
DO $$ DECLARE root_id TEXT; started TIMESTAMPTZ; elapsed NUMERIC; BEGIN
 SELECT id INTO STRICT root_id FROM pg_temp.e4_probe_context;
 RAISE NOTICE 'E4_JOIN_KEY_BEGIN ${index}';
 started:=clock_timestamp();
 PERFORM ${callable}(root_id,FALSE);
 elapsed:=extract(epoch FROM clock_timestamp()-started)*1000;
 RAISE NOTICE 'E4_JOIN_KEY_SAMPLE %',json_build_object('index',${index},'phase','${phase}','variant','${variant}',
   'wallMs',elapsed,'returned',true,'completeDocumentAndRootGuard',true,
   'sameBackend',pg_backend_pid()=(SELECT pid FROM pg_temp.e4_probe_metadata),
   'readonly',current_setting('transaction_read_only')='on','workMemKb',pg_size_bytes(current_setting('work_mem'))/1024,
   'jitEnabled',current_setting('jit')='on','planCacheMode',current_setting('plan_cache_mode'))::text;
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
      SELECT (jsonb_populate_record(NULL::public."ParticipantContributionEvaluation",to_jsonb(e)||
        jsonb_build_object('id','e4_diag_extra_row','evaluationUnitKey',repeat('f',64)))).*
      FROM pg_temp.e4_probe_evaluations e ORDER BY id COLLATE "C" LIMIT 1`,
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
   ${mutation};
   GET DIAGNOSTICS affected=ROW_COUNT;
   IF affected<>1 THEN RAISE EXCEPTION 'E4 join key negative mutation refused'; END IF;
   PERFORM pg_temp.${callable}(root_id,FALSE);
   RAISE EXCEPTION 'E4 join key negative guard did not reject';
 EXCEPTION WHEN OTHERS THEN
   GET STACKED DIAGNOSTICS state=RETURNED_SQLSTATE,guard=CONSTRAINT_NAME,message=MESSAGE_TEXT;
   IF state<>'23514' OR guard<>'e4_evaluation_guard' OR message<>'contribution evaluation set mismatch'
     THEN RAISE NOTICE 'E4_JOIN_KEY_UNEXPECTED %',json_build_object('kind','${kind}','variant','${variant}',
       'state',state,'constraintMatches',guard='e4_evaluation_guard','messageMatches',message='contribution evaluation set mismatch')::text;
       RAISE EXCEPTION 'E4 join key negative outcome refused'; END IF;
 END;
 IF (SELECT count(*) FROM pg_temp.e4_probe_marks)<>0 OR (SELECT count(*) FROM pg_temp.e4_probe_evaluations)<>8000
   OR ${digest} IS DISTINCT FROM before_hash THEN RAISE EXCEPTION 'E4 join key negative rollback refused'; END IF;
 RAISE NOTICE 'E4_JOIN_KEY_NEGATIVE %',json_build_object('kind','${kind}','variant','${variant}',
   'sqlstate',state,'constraint',guard,'affected',affected,'rolledBack',true,'allShadowRowsRestored',true,'markerRestored',true)::text;
END $$;
ROLLBACK;\n`;
    }
  sql += `DO $$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.e4_assert_complete(text,boolean)'::regprocedure)<>'ade4d2af9aa0baf8400a79fc6b62c797'
 OR ${guardDigest} IS DISTINCT FROM (SELECT guards FROM pg_temp.e4_probe_metadata)
 THEN RAISE EXCEPTION 'E4 join key public catalog changed'; END IF;
 RAISE NOTICE 'E4_JOIN_KEY_COMPLETE %',json_build_object('catalogUnchanged',true,'guardsUnchanged',true,'sameBackend',
   pg_backend_pid()=(SELECT pid FROM pg_temp.e4_probe_metadata),'publicEvaluationCount',
   (SELECT count(*) FROM public."ParticipantContributionEvaluation" WHERE "contributionRevisionId"=(SELECT id FROM pg_temp.e4_probe_context)))::text;
END $$;
SELECT 'E4_JOIN_KEY_SUCCESS';\n`;
  return sql;
}

export function compactJoinKeyEvidence(raw: string) {
  if (Buffer.byteLength(raw) > 2097152) throw new Error('E4 join key capture limit');
  const samples = [...raw.matchAll(/NOTICE:\s+E4_JOIN_KEY_SAMPLE (\{[^\n]+\})/gu)].map(
    (match) => JSON.parse(match[1]) as Record<string, unknown>,
  );
  const negatives = [...raw.matchAll(/NOTICE:\s+E4_JOIN_KEY_NEGATIVE (\{[^\n]+\})/gu)].map(
    (match) => JSON.parse(match[1]) as Record<string, unknown>,
  );
  const complete = [...raw.matchAll(/NOTICE:\s+E4_JOIN_KEY_COMPLETE (\{[^\n]+\})/gu)].map(
    (match) => JSON.parse(match[1]) as Record<string, unknown>,
  );
  if (samples.length !== JOIN_KEY_ORDER.length || negatives.length !== 6 || complete.length !== 1)
    throw new Error('E4 join key evidence count refused');
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
  expect(complete[0]).toEqual({
    catalogUnchanged: true,
    guardsUnchanged: true,
    sameBackend: true,
    publicEvaluationCount: 8000,
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
    status: 'COMPLETE',
    purpose: 'DIAGNOSTIC_ONLY_NOT_ACCEPTANCE',
    order: 'ABBA_TWO_ACTUAL_PLANS_TWO_SHADOW_CONTROLS',
    sameFixture: true,
    sameBackend: true,
    session: { workMemKb: 4096, jitEnabled: true, planCacheMode: 'force_custom_plan' },
    statementMs: 30000,
    processMs: 240000,
    timings,
    plans,
    cases,
    catalogUnchanged: true,
    guardsUnchanged: true,
    negativeScope:
      'TEMP_SHADOW_FULL_SQL_NATIVE_EXCEPTION_AND_SUBTRANSACTION_ROLLBACK_NOT_PRODUCTION_TRIGGER_E2E',
    cacheLimit: 'FIXED_TWO_ORDERS_ONE_RUN_NO_CAUSAL_OR_PERCENTILE_CLAIM',
    versionSpecificChecks: 'NOT_PROFILED',
  };
}

async function probeJoinKeyCandidate(db: PrismaClient, report: Report) {
  report.joinKeyCandidate = { status: 'UNKNOWN', reason: 'PROOF' };
  const proof = privateDiagnosticProofs.get(report),
    databaseName = deriveTestDbName();
  if (!proof || report.oracle !== 'COMPLETE' || databaseName !== 'app_test_w98')
    throw new Error('E4 join key verified proof refused');
  await assertConnectedTestDatabase(db);
  await verifyDiagnosticDatabase(db);
  const owner = `e4_key_${report.head.slice(0, 12)}_${report.run}`;
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
      input: joinKeyProbeSql(proof.revisionId, databaseName),
      encoding: 'utf8',
      timeout: 240000,
      maxBuffer: 2097152,
    },
  );
  const stderr = proc.stderr ?? '';
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
    stdoutBytes: Buffer.byteLength(proc.stdout ?? ''),
    stderrBytes: Buffer.byteLength(proc.stderr ?? ''),
    progress: {
      lastPositiveIndex: positive.at(-1) ?? null,
      lastNegative: negative.at(-1) ?? null,
      completedPositive: (stderr.match(/NOTICE:\s+E4_JOIN_KEY_SAMPLE /gu) ?? []).length,
      completedNegative: (stderr.match(/NOTICE:\s+E4_JOIN_KEY_NEGATIVE /gu) ?? []).length,
      nativeErrors: [
        ...new Set(
          [...stderr.matchAll(/ERROR:\s+([A-Z0-9]{5})(?:\s|$)/gu)].map((match) => match[1]),
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
  if (
    proc.error ||
    proc.signal ||
    proc.status !== 0 ||
    !proc.stdout.includes('E4_JOIN_KEY_SUCCESS')
  )
    throw new Error('E4 join key process refused');
  report.joinKeyCandidate = { ...(report.joinKeyCandidate as object), reason: 'EVIDENCE' };
  report.joinKeyCandidate = {
    ...compactJoinKeyEvidence(proc.stderr),
    ownedBackendGone: true,
    tempObjectsLifetime: 'OWNED_BACKEND_DISCONNECTED',
  };
  report.internalSqlPlan = 'OBSERVED';
  await verifyDiagnosticDatabase(db);
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
    scenario: e4DiagnosticScenario(process.env.SRVF_E4_DIAGNOSTIC_SCENARIO),
    migration: 'NOT_VERIFIED',
    stages: [],
    coverage:
      process.env.SRVF_E4_JOIN_KEY_ONCE === '1'
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
      try {
        f = await fixture.createE4Fixture();
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
        const source = maximum
          ? await fixture.createMaximumE4Source(f)
          : await createDiagnosticE4Source(f, identities as 1 | 100 | 500, fixture.createE4Source);
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
        const limits = maximum ? installE4DiagnosticLimits(db, context) : undefined;
        const measuredClient = limits?.client ?? db;
        const observer = new PrismaClient();
        auxiliary.push(observer);
        await assertConnectedTestDatabase(observer);
        const [{ pid }] = await db.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        const command = {
          expectedDraftVersion: source.expectation.expectedDraftVersion,
          expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,
          operationKey: f.key('diagnostic_prepare'),
          expectedTimeRevision: 0,
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
        }
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
        await assertDiagnosticProof(
          observer,
          prepared!.settlementVersionId,
          units,
          maximum,
          report,
        );
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
        if (process.env.SRVF_E4_JOIN_KEY_ONCE === '1') {
          report.oracle = 'COMPLETE';
          report.substage = 'ORACLE_JOIN_KEY_CANDIDATE';
          await probeJoinKeyCandidate(db, report);
          expect(await diagnosticFacts(observer, source.activityId, command.operationKey)).toEqual(
            preparedFacts,
          );
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
        if (process.env.SRVF_E4_CANONICAL_FIRST32 === '1') {
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
          expect(
            report.stages.every(
              (stage) =>
                stage.transaction.status === 'COMPLETE' &&
                stage.transaction.transactions.length > 0,
            ),
          ).toBe(true);
          report.oracle = 'COMPLETE';
          report.budgetRecommendation = maximum
            ? 'ONE_SAMPLE_ONLY_KEEP_FORMAL_30_AND_DO_NOT_SELECT_NEW_BUDGET'
            : 'ORIGINAL_BUDGETS_OBSERVED_ONE_SAMPLE_NO_PERCENTILE_OR_HEADROOM_CLAIM';
          report.status = 'COMPLETE';
        }
      } catch (error) {
        report.status = 'FAILED';
        report.failureStage = checkpoint.lastStage();
        report.errorSubstage = report.substage;
        report.error = e4DiagnosticSafeError(error);
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

export async function runDiagnosticParent() {
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
      head,
      run: process.env.GITHUB_RUN_ID!,
      scenario: e4DiagnosticScenario(process.env.SRVF_E4_DIAGNOSTIC_SCENARIO),
      migration: 'NOT_VERIFIED',
      stages: [],
      coverage:
        process.env.SRVF_E4_JOIN_KEY_ONCE === '1'
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
