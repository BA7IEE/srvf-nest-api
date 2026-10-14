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
async function assertDiagnosticProof(
  db: PrismaClient,
  versionId: string,
  units: number,
  maximum: boolean,
  report: Report,
) {
  const observed = diagnosticOracleClient(db, report);
  report.substage = 'ORACLE_PROOF_READ';
  const proof = await db.activitySettlementContributionRevision.findFirstOrThrow({
    where: { settlementVersionId: versionId },
    orderBy: { revision: 'desc' },
  });
  expect(proof.evaluationCount).toBe(units);
  if (maximum) {
    expect(proof.recognizedPointsTotal.toFixed(2)).toBe('1000.00');
    await frozenE4Oracle(report)(observed, proof.id, units);
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
        checkpoint.mark('ORACLE', 'COMPLETE');
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
              stage.transaction.status === 'COMPLETE' && stage.transaction.transactions.length > 0,
          ),
        ).toBe(true);
        report.oracle = 'COMPLETE';
        report.budgetRecommendation = maximum
          ? 'ONE_SAMPLE_ONLY_KEEP_FORMAL_30_AND_DO_NOT_SELECT_NEW_BUDGET'
          : 'ORIGINAL_BUDGETS_OBSERVED_ONE_SAMPLE_NO_PERCENTILE_OR_HEADROOM_CLAIM';
        report.status = 'COMPLETE';
      } catch (error) {
        report.status = 'FAILED';
        report.failureStage = checkpoint.lastStage();
        report.errorSubstage = report.substage;
        report.error = e4DiagnosticSafeError(error);
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
