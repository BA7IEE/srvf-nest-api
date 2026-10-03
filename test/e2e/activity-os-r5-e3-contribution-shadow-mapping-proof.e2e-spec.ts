import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { loadTestEnv } from '../setup/load-env';
import { assertTestDatabaseUrl } from '../setup/test-db';
import { deriveTestDbName, deriveWorkerTestDbName } from '../setup/worktree-db';
import { createTestApp } from '../setup/test-app';
import { PrismaService } from '../../src/database/prisma.service';
import { truncateAuditLogsTestOnly } from '../helpers/audit-logs-cleanup';
import appConfig from '../../src/config/app.config';
import databaseConfig from '../../src/config/database.config';
import {
  timeLedgerFixtureTriggerSql,
  withTimeLedgerFixtureCleanup,
} from '../setup/time-ledger-fixture-cleanup';
import {
  evaluateContributionPolicy,
  fingerprintContributionPolicyVersion,
  prepareContributionPolicyVersion,
} from '../../src/modules/activities/activity-contribution-policy-definition';
import {
  parseShadowMappingRegistrationManifest,
  SHADOW_MAPPING_REGISTRATION_AUDIT_EVENT,
} from '../../src/modules/activities/activity-contribution-shadow-mapping-registration.service';
import { computeActivityTemplateDefinitionHash } from '../../src/modules/activities/activity-template-definition';
import { ActivityContributionShadowMappingProofQuery } from '../../src/modules/activities/activity-contribution-shadow-mapping-proof.query';
import {
  evaluateShadowFrozenSource,
  prepareShadowEvidence,
  prepareShadowAttempt,
  prepareShadowComparisonSet,
  ShadowComparisonBudget,
  ContributionShadowService,
  resolveShadowMappingAtSource,
  resolveShadowSelectionAtSource,
} from '../../src/modules/attendances/contribution-shadow.service';
import {
  activityContributionPolicySelectionHash,
  createActivityContributionPolicySelectionDocument,
} from '../../src/modules/activities/activity-contribution-policy-selection';
import {
  ContributionShadowEvidenceWriteService,
  hashLegacySource,
  type ShadowComparisonInput,
  type ShadowMappingApplicationInput,
} from '../../src/modules/attendances/contribution-shadow-evidence.write.service';

// Fixed pre-29.12 SQL reference; do not derive it from the candidate migration.
import { installScratchDatabaseLease } from '../helpers/scratch-database-lease';

const scratchLifecycle = installScratchDatabaseLease(process.env.SRVF_E3_D2_MAPPING_W98 === '1');

const SOURCE_HASH_REFERENCE_SQL = `CREATE FUNCTION pg_temp.reference_source_hash_fn(v "ContributionShadowLegacySourceAnchor") RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(
    'SRVF:E3-2:legacy-source:v1:' ||
    cslsa_canonical_field_fn(v."windowId") ||
    cslsa_canonical_field_fn(v."auditLogId") ||
    cslsa_canonical_field_fn(v."sheetId") ||
    cslsa_canonical_field_fn(v."sheetVersion"::TEXT) ||
    cslsa_canonical_field_fn(v."activityId") ||
    cslsa_canonical_field_fn(v."recordId") ||
    cslsa_canonical_field_fn(v."memberId") ||
    cslsa_canonical_field_fn(v."activityTypeCode") ||
    cslsa_canonical_field_fn(v."attendanceRoleCode") ||
    cslsa_canonical_field_fn(v."legacyServiceHours"::TEXT) ||
    cslsa_canonical_field_fn(v."sourceKindCode") ||
    cslsa_canonical_field_fn(v."legacyRuleId") ||
    cslsa_canonical_field_fn(v."durationThreshold"::TEXT) ||
    cslsa_canonical_field_fn(v."pointsBelow"::TEXT) ||
    cslsa_canonical_field_fn(v."pointsAbove"::TEXT) ||
    cslsa_canonical_field_fn(v."legacyPoints"::TEXT), 'UTF8')), 'hex')
$$;`;

type DiagnosticRow = { label: string; elapsedMs: number; outcome: string; code: string };
type MappingPlanDiagnostic = { label: string; elapsedMs: number; plan: unknown };
function redactMappingPlan(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactMappingPlan);
  if (!value || typeof value !== 'object') return value;
  const allowed = new Set([
    'Plan',
    'Plans',
    'Node Type',
    'Parent Relationship',
    'Join Type',
    'Relation Name',
    'Index Name',
    'Scan Direction',
    'Strategy',
    'Startup Cost',
    'Total Cost',
    'Plan Rows',
    'Plan Width',
    'JIT',
    'Functions',
    'Options',
    'Inlining',
    'Optimization',
    'Expressions',
    'Deforming',
  ]);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => allowed.has(key))
      .map(([key, child]) => [key, redactMappingPlan(child)]),
  );
}

async function collectMappingPlan(
  target: object,
  args: unknown[],
  label: string,
  plans: MappingPlanDiagnostic[],
  rows: DiagnosticRow[],
): Promise<void> {
  const began = performance.now();
  const head = args[0];
  if (!Array.isArray(head)) throw new Error('mapping plan expected original tagged query');
  const query = Prisma.sql(head as string[], ...args.slice(1));
  try {
    // Deliberately not ANALYZE: no second insert or trigger execution.
    const result = await (target as Prisma.TransactionClient).$queryRaw<
      Array<Record<string, unknown>>
    >(Prisma.sql`EXPLAIN (FORMAT JSON) ${query}`);
    const elapsedMs = performance.now() - began;
    plans.push({
      label,
      elapsedMs,
      plan: redactMappingPlan(result.map((row) => row['QUERY PLAN'])),
    });
    rows.push({ label: 'diagnostic.plan.' + label, elapsedMs, outcome: 'ok', code: '' });
  } catch (error) {
    rows.push({
      label: 'diagnostic.plan.' + label,
      elapsedMs: performance.now() - began,
      outcome: 'error',
      code: diagnosticCode(error),
    });
    throw error;
  }
}
function diagnosticCode(error: unknown): string {
  const kind =
    error instanceof Error &&
    [
      'Error',
      'TypeError',
      'RangeError',
      'BizException',
      'PrismaClientKnownRequestError',
      'PrismaClientUnknownRequestError',
      'PrismaClientValidationError',
      'PrismaClientInitializationError',
    ].includes(error.name)
      ? error.name
      : 'other';
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return kind;
  const prismaCode = ['P2028', 'P2010', 'P2002', 'P2003', 'P2024', 'P2034'].includes(error.code)
    ? error.code
    : 'other';
  const state = error.meta?.code;
  const sqlState =
    typeof state === 'string' &&
    [
      '57014',
      '55P03',
      '23503',
      '23505',
      '23514',
      '40001',
      '40P01',
      '53200',
      '53400',
      '08003',
      '08006',
      '57P01',
    ].includes(state)
      ? state
      : 'unavailable';
  return [kind, prismaCode, sqlState].join(':');
}
function diagnosticTx<T extends object>(
  target: T,
  rows: DiagnosticRow[],
  prefix = '',
  plans?: MappingPlanDiagnostic[],
): T {
  return new Proxy(target, {
    get(object, key) {
      const value: unknown = Reflect.get(object, key);
      if (typeof key !== 'string') return value;
      if (typeof value === 'object' && value !== null && !prefix && /^[a-z][a-zA-Z]+$/.test(key))
        return diagnosticTx(value, rows, key, plans);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        let label = prefix ? prefix + '.' + key : key;
        if (['$queryRaw', '$executeRaw', '$queryRawUnsafe', '$executeRawUnsafe'].includes(key)) {
          const first = args[0];
          const literal =
            typeof first === 'string'
              ? first
              : Array.isArray(first)
                ? first.filter((part) => typeof part === 'string').join(' ')
                : first &&
                    typeof first === 'object' &&
                    'strings' in first &&
                    Array.isArray(first.strings)
                  ? first.strings.filter((part) => typeof part === 'string').join(' ')
                  : '';
          const table = [
            'ContributionShadowMappingApplication',
            'ContributionShadowComparisonReceipt',
            'ParticipantSettlementTimeBucketSource',
            'ParticipantSettlementTimeBucket',
            'ParticipantTimeAllocationRevision',
            'ActivityParticipationIdentity',
            'ParticipantServiceSegmentRevision',
            'ActivityRuleSnapshot',
            'TimePolicyVersion',
            'AttendanceSettlementVersion',
            'EvidenceSeal',
            'ActivityEvidenceState',
            'AttendanceSettlementRun',
          ].find((name) => literal.includes('"' + name + '"'));
          label +=
            '.' + (table ?? (literal.includes('pg_advisory_xact_lock') ? 'advisoryLock' : 'other'));
        }
        const result: unknown = Reflect.apply(value, object, args);
        if (
          !result ||
          typeof result !== 'object' ||
          !('then' in result) ||
          typeof result.then !== 'function'
        )
          return result;
        return new Proxy(result, {
          get(promise, property) {
            if (property === 'then')
              return (
                fulfilled?: (output: unknown) => unknown,
                rejected?: (error: unknown) => unknown,
              ) => {
                const then: unknown = Reflect.get(promise, 'then');
                if (typeof then !== 'function') throw new Error('diagnostic promise contract');
                const consume = () => {
                  const began = performance.now();
                  return Reflect.apply(then, promise, [
                    (output: unknown) => {
                      rows.push({
                        label,
                        elapsedMs: performance.now() - began,
                        outcome: 'ok',
                        code: '',
                      });
                      return fulfilled ? fulfilled(output) : output;
                    },
                    (error: unknown) => {
                      rows.push({
                        label,
                        elapsedMs: performance.now() - began,
                        outcome: 'error',
                        code: diagnosticCode(error),
                      });
                      if (rejected) return rejected(error);
                      throw error;
                    },
                  ]);
                };
                if (
                  plans &&
                  !prefix &&
                  key === '$executeRaw' &&
                  (label.endsWith('.ContributionShadowMappingApplication') ||
                    label.endsWith('.ContributionShadowComparisonReceipt'))
                ) {
                  return collectMappingPlan(object, args, label, plans, rows).then(
                    consume,
                    (error: unknown) => {
                      if (rejected) return rejected(error);
                      throw error;
                    },
                  );
                }
                return consume();
              };
            const member: unknown = Reflect.get(promise, property);
            return typeof member === 'function' ? member.bind(promise) : member;
          },
        });
      };
    },
  });
}

function summarizeDiagnostics(rows: DiagnosticRow[]) {
  const grouped = new Map<
    string,
    {
      label: string;
      calls: number;
      totalMs: number;
      maxMs: number;
      failures: number;
      codes: Set<string>;
    }
  >();
  for (const row of rows) {
    const group = grouped.get(row.label) ?? {
      label: row.label,
      calls: 0,
      totalMs: 0,
      maxMs: 0,
      failures: 0,
      codes: new Set<string>(),
    };
    group.calls += 1;
    group.totalMs += row.elapsedMs;
    group.maxMs = Math.max(group.maxMs, row.elapsedMs);
    if (row.outcome === 'error') group.failures += 1;
    if (row.code) group.codes.add(row.code);
    grouped.set(row.label, group);
  }
  return [...grouped.values()].map((row) => ({
    ...row,
    totalMs: Math.round(row.totalMs * 1000) / 1000,
    maxMs: Math.round(row.maxMs * 1000) / 1000,
    codes: [...row.codes],
  }));
}

// Instrument positive controls never contact a database or log exception text.
async function assertDiagnosticObserver() {
  const rows: DiagnosticRow[] = [];
  let executed = 0;
  const failure = new Error('synthetic private detail must not be logged');
  const original = {
    value: 17,
    read() {
      const value = this.value;
      return {
        then(resolve: (value: number) => unknown) {
          executed += 1;
          return Promise.resolve(value).then(resolve);
        },
      };
    },
    fail() {
      return Promise.reject(failure);
    },
  };
  const observed = diagnosticTx(original, rows);
  const lazy = observed.read();
  expect(executed).toBe(0);
  expect(rows).toHaveLength(0);
  expect(await lazy).toBe(17);
  expect(executed).toBe(1);
  await expect(observed.fail()).rejects.toBe(failure);
  expect(rows.map(({ label, outcome, code }) => ({ label, outcome, code }))).toEqual([
    { label: 'read', outcome: 'ok', code: '' },
    { label: 'fail', outcome: 'error', code: 'Error' },
  ]);
  const databaseFailure = new Prisma.PrismaClientKnownRequestError('synthetic private detail', {
    code: 'P2010',
    clientVersion: 'diagnostic',
    meta: { code: '23514', message: 'not logged' },
  });
  expect(diagnosticCode(databaseFailure)).toBe('PrismaClientKnownRequestError:P2010:23514');
  const unknownFailure = new Prisma.PrismaClientKnownRequestError('not logged', {
    code: 'PRIVATE',
    clientVersion: 'diagnostic',
    meta: { code: 'PRIVATE' },
  });
  expect(diagnosticCode(unknownFailure)).toBe('PrismaClientKnownRequestError:other:unavailable');
}

function manifestFixture() {
  return {
    schemaVersion: 1,
    commandKey: 'fixture-command',
    approvalReference: 'isolated-fixture-only',
    approvals: [
      {
        approvalNumber: 'fixture-approval',
        mappingVersion: 'fixture-v1',
        activityId: 'fixture-activity',
        activityTypeCode: 'service',
        attendanceRoleCode: 'volunteer',
        sessionPositionId: 'fixture-position',
        policyRoleCode: 'volunteer',
        categoryCode: 'volunteer_service',
        policyVersionId: 'fixture-policy',
        policyDefinitionHash: 'a'.repeat(64),
        evaluatorVersion: 1,
        durationSourceCode: 'legacy_stored_hours_2',
        effectiveFrom: '2099-10-01T00:00:00.000Z',
        effectiveUntil: null as string | null,
        eventKindCode: 'approve',
        previousApprovalId: null as string | null,
      },
    ],
  };
}

function manifestSqlHash(value: unknown): string {
  return sql(
    `SELECT csm_manifest_hash_fn('${JSON.stringify(value).replaceAll("'", "''")}'::jsonb)`,
  );
}

function manifestApplicationHash(value: unknown): string {
  return computeActivityTemplateDefinitionHash({
    schemaVersion: 1,
    definition: {
      domain: 'SRVF:E3-2:shadow-mapping-registration:v1',
      manifest: parseShadowMappingRegistrationManifest(value),
    },
  });
}

function approvalRowFixture(value = manifestFixture()) {
  return {
    id: 'fixture-approval-id',
    ...value.approvals[0],
    manifestHash: manifestApplicationHash(value),
    approvalReference: value.approvalReference,
    approvedByUserId: 'fixture-human',
    registeredByUserId: 'fixture-human',
    approvedAt: '2099-09-01T00:00:00.000Z',
    createdAt: '2099-09-01T00:00:00.000Z',
  };
}

function approvalMatchesManifest(
  row: unknown,
  manifest = manifestFixture(),
  index = 0,
  actor: string | null = 'fixture-human',
  registrationTime: string | null = '2099-09-01T00:00:00.000Z',
): string {
  const literal = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
  const text = (value: string | null) =>
    value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`;
  return sql(`SELECT csm_approval_matches_manifest_fn(
    jsonb_populate_record(NULL::"ContributionShadowMappingApproval", ${literal(row)}),
    ${literal(manifest)}, ${index}, ${text(actor)}, ${text(registrationTime)}::timestamptz)`);
}

const dedicated = process.env.SRVF_E3_D2_MAPPING_W98 === '1';

function policyFixture() {
  return {
    defaultResult: { recognizedPoints: '0.00', explanationCode: 'default' },
    roleRules: [
      {
        attendanceRoleCode: 'member',
        categoryRules: [
          {
            timeCategoryCode: 'volunteer_service',
            durationBands: [
              { maxSecondsInclusive: 0, recognizedPoints: '0.00', explanationCode: 'zero' },
              { maxSecondsInclusive: 60, recognizedPoints: '1.25', explanationCode: 'short' },
              { maxSecondsInclusive: 3600, recognizedPoints: '10.00', explanationCode: 'hour' },
              { maxSecondsInclusive: null, recognizedPoints: '999.99', explanationCode: 'long' },
            ],
          },
        ],
      },
    ],
  };
}

function evaluateSql(
  definition: unknown,
  duration: number,
  role = 'member',
  category = 'volunteer_service',
) {
  const literal = JSON.stringify(definition).replaceAll("'", "''");
  return JSON.parse(
    sql(
      `SELECT csm_policy_evaluate_fn('${literal}'::jsonb, '${role.replaceAll("'", "''")}', '${category}', ${duration})`,
    ),
  ) as unknown;
}

// Fixed pre-29.17 reference from cb9d1309; never rebuild it from candidate SQL.
const MAPPING_INPUTS_REFERENCE_SQL = String.raw`CREATE FUNCTION pg_temp.reference_mapping_inputs_fn(
  approval "ContributionShadowMappingApproval", source "ContributionShadowLegacySourceAnchor",
  observation "ContributionShadowObservationWindow", policy "ContributionPolicyVersion",
  audit_time TIMESTAMPTZ
) RETURNS JSONB LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE
  duration NUMERIC; evaluated JSONB;
BEGIN
  IF audit_time IS NULL OR approval."approvedAt" IS NULL OR
    approval."approvedAt" > audit_time OR approval."effectiveFrom" IS NULL OR
    approval."effectiveFrom" > audit_time OR
    (approval."effectiveUntil" IS NOT NULL AND approval."effectiveUntil" <= audit_time) OR
    approval."eventKindCode" IS NULL OR approval."eventKindCode" NOT IN ('approve','replace') THEN
    RAISE EXCEPTION 'shadow mapping approval is not effective at source time' USING ERRCODE = '23514';
  END IF;
  IF source."windowId" IS NULL OR observation."id" IS DISTINCT FROM source."windowId" OR
    observation."signedMappingVersion" IS NULL OR
    approval."mappingVersion" IS DISTINCT FROM observation."signedMappingVersion" OR
    observation."startsAt" IS NULL OR observation."startsAt" > audit_time OR
    observation."endsAt" IS NULL OR observation."endsAt" <= audit_time THEN
    RAISE EXCEPTION 'shadow mapping observation mismatch' USING ERRCODE = '23514';
  END IF;
  IF source."activityId" IS NULL OR approval."activityId" IS DISTINCT FROM source."activityId" OR
    source."activityTypeCode" IS NULL OR approval."activityTypeCode" IS DISTINCT FROM source."activityTypeCode" OR
    source."attendanceRoleCode" IS NULL OR approval."attendanceRoleCode" IS DISTINCT FROM source."attendanceRoleCode" OR
    source."sourceKindCode" IS DISTINCT FROM 'matched' OR
    approval."durationSourceCode" IS DISTINCT FROM 'legacy_stored_hours_2' THEN
    RAISE EXCEPTION 'shadow mapping legacy source mismatch' USING ERRCODE = '23514';
  END IF;
  IF policy."id" IS NULL OR approval."policyVersionId" IS DISTINCT FROM policy."id" OR
    policy."definitionHash" IS NULL OR approval."policyDefinitionHash" IS DISTINCT FROM policy."definitionHash" OR
    policy."schemaVersion" IS DISTINCT FROM 1 OR policy."evaluatorVersion" IS DISTINCT FROM 1 OR
    approval."evaluatorVersion" IS DISTINCT FROM policy."evaluatorVersion" THEN
    RAISE EXCEPTION 'shadow mapping policy version mismatch' USING ERRCODE = '23514';
  END IF;
  IF policy."definitionHash" IS DISTINCT FROM csm_policy_fingerprint_fn(policy) THEN
    RAISE EXCEPTION 'shadow mapping policy definition hash mismatch' USING ERRCODE = '23514';
  END IF;
  IF source."legacyServiceHours" IS NULL OR source."legacyServiceHours" < 0 OR
    source."legacyServiceHours" > 999.99 THEN
    RAISE EXCEPTION 'shadow mapping duration source invalid' USING ERRCODE = '23514';
  END IF;
  -- Stored hundredths of an hour multiply by 36 per hundredth, without rounding.
  duration := source."legacyServiceHours" * 3600;
  IF trunc(duration) <> duration THEN
    RAISE EXCEPTION 'shadow mapping duration source invalid' USING ERRCODE = '23514';
  END IF;
  evaluated := csm_policy_evaluate_fn(policy."definitionJson", approval."policyRoleCode",
    approval."categoryCode", duration::BIGINT);
  -- Evaluator default is legitimate in E1 but cannot prove a signed E3 mapping.
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(policy."definitionJson"->'roleRules') AS r(value)
    CROSS JOIN LATERAL jsonb_array_elements(r.value->'categoryRules') AS c(value)
    WHERE r.value->>'attendanceRoleCode' = approval."policyRoleCode"
      AND c.value->>'timeCategoryCode' = approval."categoryCode"
  ) THEN
    RAISE EXCEPTION 'shadow mapping policy role or category missing' USING ERRCODE = '23514';
  END IF;
  RETURN jsonb_build_object('durationSeconds', duration::BIGINT,
    'recognizedPoints', evaluated->>'recognizedPoints', 'explanationCode', evaluated->>'explanationCode');
END $$;`;

function mappingInputsFixture() {
  const policy = fingerprintContributionPolicyVersion({
    schemaVersion: 1,
    evaluatorVersion: 1,
    definition: policyFixture(),
    effectiveFrom: '2099-01-01T00:00:00.000Z',
    effectiveUntil: null,
  });
  return {
    approval: {
      approvedAt: '2099-01-01T00:00:00.000Z',
      effectiveFrom: '2099-02-01T00:00:00.000Z',
      effectiveUntil: null as string | null,
      eventKindCode: 'approve',
      mappingVersion: 'mapping-1',
      activityId: 'activity-1',
      activityTypeCode: 'fixture',
      attendanceRoleCode: 'old_role',
      policyRoleCode: 'member',
      categoryCode: 'volunteer_service',
      durationSourceCode: 'legacy_stored_hours_2',
      policyVersionId: 'policy-1',
      policyDefinitionHash: policy.definitionHash,
      evaluatorVersion: 1,
    },
    source: {
      windowId: 'window-1',
      activityId: 'activity-1',
      activityTypeCode: 'fixture',
      attendanceRoleCode: 'old_role',
      sourceKindCode: 'matched',
      legacyServiceHours: '1.01',
    },
    observation: {
      id: 'window-1',
      signedMappingVersion: 'mapping-1',
      startsAt: '2099-01-01T00:00:00.000Z',
      endsAt: '2099-12-31T00:00:00.000Z',
    },
    policy: {
      id: 'policy-1',
      definitionHash: policy.definitionHash,
      schemaVersion: 1,
      evaluatorVersion: 1,
      definitionJson: policyFixture(),
      effectiveFrom: policy.effectiveFrom,
      effectiveUntil: policy.effectiveUntil,
    },
    auditTime: '2099-03-01T00:00:00.000Z',
  };
}

function evaluateMappingInputs(value: ReturnType<typeof mappingInputsFixture>): unknown {
  const row = (table: string, data: unknown) =>
    `jsonb_populate_record(NULL::"${table}", '${JSON.stringify(data).replaceAll("'", "''")}'::jsonb)`;
  return JSON.parse(
    sql(`SELECT csm_mapping_inputs_result_fn(
    ${row('ContributionShadowMappingApproval', value.approval)},
    ${row('ContributionShadowLegacySourceAnchor', value.source)},
    ${row('ContributionShadowObservationWindow', value.observation)},
    ${row('ContributionPolicyVersion', value.policy)},
    '${value.auditTime}'::timestamptz)`),
  ) as unknown;
}

function policyFingerprintSql(policy: unknown): string {
  const literal = JSON.stringify(policy).replaceAll("'", "''");
  return sql(
    `SELECT csm_policy_fingerprint_fn(jsonb_populate_record(NULL::"ContributionPolicyVersion", '${literal}'::jsonb))`,
  );
}

function registrationReferencesFixture(
  definitionInput: unknown = policyFixture(),
  policyRole = 'member',
  category = 'volunteer_service',
) {
  const manifest = manifestFixture();
  const item = manifest.approvals[0];
  item.activityId = 'ref-activity';
  item.activityTypeCode = 'service';
  item.sessionPositionId = 'ref-position';
  item.policyRoleCode = policyRole;
  item.categoryCode = category;
  item.policyVersionId = 'ref-version';
  const policy = fingerprintContributionPolicyVersion({
    schemaVersion: 1,
    evaluatorVersion: 1,
    definition: definitionInput,
    effectiveFrom: '2099-01-01T00:00:00.000Z',
    effectiveUntil: null,
  });
  item.policyDefinitionHash = policy.definitionHash;
  const definition = JSON.stringify(policy.definition).replaceAll("'", "''");
  const fixtureSql = `
    INSERT INTO "User" (id,username,"passwordHash","updatedAt") VALUES ('ref-user','ref-user','fixture',CURRENT_TIMESTAMP);
    INSERT INTO "Organization" (id,name,"nodeTypeCode","updatedAt") VALUES ('ref-org','Reference fixture','team',CURRENT_TIMESTAMP);
    INSERT INTO "Activity" (id,title,"activityTypeCode","organizationId","startAt","endAt",location,"statusCode","updatedAt") VALUES
      ('ref-activity','Reference fixture','service','ref-org','2099-10-01','2099-10-02','test','draft',CURRENT_TIMESTAMP),
      ('ref-other-activity','Other fixture','service','ref-org','2099-10-01','2099-10-02','test','draft',CURRENT_TIMESTAMP);
    INSERT INTO "ActivitySession" (id,"activityId",code,name,"startAt","endAt","locationText","checkInOpenAt","checkInCloseAt","checkOutOpenAt","checkOutCloseAt","locationRequired","locationPolicySourceCode","statusCode","updatedAt") VALUES
      ('ref-session','ref-activity','ref_session','Reference fixture','2099-10-01 01:00','2099-10-01 02:00','test','2099-10-01','2099-10-01 01:00','2099-10-01 02:00','2099-10-01 03:00',false,'activity','scheduled',CURRENT_TIMESTAMP);
    INSERT INTO "ActivitySessionPosition" (id,"activityId","sessionId",code,name,"attendanceRoleCode","updatedAt") VALUES
      ('ref-position','ref-activity','ref-session','ref_position','Reference fixture','${policyRole.replaceAll("'", "''")}',CURRENT_TIMESTAMP);
    INSERT INTO "ContributionPolicy" (id,code,name,"updatedAt") VALUES ('ref-policy','ref_policy','Reference fixture',CURRENT_TIMESTAMP);
    INSERT INTO "ContributionPolicyVersion" (id,"policyId",version,"schemaVersion","definitionJson","definitionHash","evaluatorVersion","effectiveFrom","statusCode","createdByUserId","updatedAt") VALUES
      ('ref-version','ref-policy',1,1,'${definition}'::jsonb,'${policy.definitionHash}',1,'2099-01-01','draft','ref-user',CURRENT_TIMESTAMP);`;
  return { manifest, fixtureSql };
}

function registrationHumanFixtureSql() {
  return `
    INSERT INTO roles (id,code,"displayName","updatedAt") VALUES ('ref-role','shadow-fixture','Isolated fixture',CURRENT_TIMESTAMP);
    INSERT INTO permissions (id,code,module,action,"resourceType","updatedAt") VALUES
      ('ref-permission','contribution-shadow-mapping.register.approval','contribution-shadow-mapping','register','approval',CURRENT_TIMESTAMP);
    INSERT INTO role_permissions (id,"roleId","permissionId") VALUES ('ref-role-permission','ref-role','ref-permission');
    INSERT INTO role_bindings (id,"principalType","principalId","roleId","scopeType","startedAt","updatedAt") VALUES
      ('ref-binding','USER','ref-user','ref-role','GLOBAL','2000-01-01',CURRENT_TIMESTAMP);`;
}

function actualSourceApprovalFixture(
  ambiguous = false,
  legacyPoints = 2,
  definitionInput: unknown = policyFixture(),
  policyRole = 'member',
  category = 'volunteer_service',
) {
  const { manifest, fixtureSql } = registrationReferencesFixture(
    definitionInput,
    policyRole,
    category,
  );
  if (ambiguous) {
    manifest.approvals.push({ ...manifest.approvals[0], approvalNumber: 'ref-second' });
  }
  const literal = JSON.stringify(manifest).replaceAll("'", "''");
  const ids = ambiguous ? '["ref-approval","ref-second-approval"]' : '["ref-approval"]';
  return fixtureStatement(`${fixtureSql} ${registrationHumanFixtureSql()}
    ${registrationAuthorityFixtureSql(manifest)}
    SET SESSION AUTHORIZATION srvf_shadow_registrar_w98_fixture;
    DO $fixture$ BEGIN
      PERFORM csm_register_mapping_fn('${literal}'::jsonb,'ref-user','ref-receipt','ref-register-audit','${ids}'::jsonb);
    END $fixture$;
    RESET SESSION AUTHORIZATION;
    INSERT INTO "Member" (id,"memberNo","realName","memberSinceDate","memberOriginCode","updatedAt")
      VALUES ('ref-member','REF135','Isolated fixture',CURRENT_TIMESTAMP,'manual',CURRENT_TIMESTAMP);
    INSERT INTO "AttendanceSheet" (id,"activityId","submitterUserId","statusCode","updatedAt",version)
      VALUES ('ref-sheet','ref-activity','ref-user','pending_review',CURRENT_TIMESTAMP,1);
    INSERT INTO "AttendanceRecord" (id,"sheetId","memberId","roleCode","checkInAt","checkOutAt","serviceHours","attendanceStatusCode","contributionPoints","updatedAt")
      VALUES ('ref-record','ref-sheet','ref-member','volunteer','2099-10-01','2099-10-01 01:00',1.00,'present',${legacyPoints},CURRENT_TIMESTAMP);
    INSERT INTO "ContributionRule" (id,"activityTypeCode","attendanceRoleCode","pointsBelow","updatedAt")
      VALUES ('ref-rule','service','volunteer',${legacyPoints},CURRENT_TIMESTAMP);
    INSERT INTO "ContributionShadowObservationWindow" (id,"startsAt","endsAt","registeredByUserId","deploymentDigest","configDigest","signedMappingVersion","hashAlgorithmCode","canonicalVersion")
      VALUES ('ref-window','2099-10-01','2099-10-03','ref-user',repeat('a',64),repeat('a',64),'fixture-v1','sha256',1);
    INSERT INTO audit_logs (id,"createdAt","resourceType","resourceId",event,context,"shadowProofRequired")
      VALUES ('ref-source-audit','2099-10-01 12:00','attendance_sheet','ref-sheet','attendance-sheet.submit',
        jsonb_build_object('after',jsonb_build_object('sheet',jsonb_build_object('activityId','ref-activity','version',1),
          'records',jsonb_build_array(jsonb_build_object('id','ref-record','memberId','ref-member','roleCode','volunteer','serviceHours','1','contributionPoints','${legacyPoints}'))),
          'extra',jsonb_build_object('operation','submit','recordsCount',1)),true);
    INSERT INTO "ContributionShadowLegacySourceAnchor" (id,"windowId","auditLogId","sheetId","sheetVersion","activityId","recordId","memberId","activityTypeCode","attendanceRoleCode","legacyServiceHours","sourceKindCode","legacyRuleId","pointsBelow","legacyPoints","hashAlgorithmCode","canonicalVersion","legacySourceHash")
      VALUES ('ref-source','ref-window','ref-source-audit','ref-sheet',1,'ref-activity','ref-record','ref-member','service','volunteer',1.00,'matched','ref-rule',${legacyPoints},${legacyPoints},'sha256',1,
        cslsa_source_hash_fn(jsonb_populate_record(NULL::"ContributionShadowLegacySourceAnchor",jsonb_build_object(
          'windowId','ref-window','auditLogId','ref-source-audit','sheetId','ref-sheet','sheetVersion',1,'activityId','ref-activity','recordId','ref-record','memberId','ref-member',
          'activityTypeCode','service','attendanceRoleCode','volunteer','legacyServiceHours',1.00,'sourceKindCode','matched','legacyRuleId','ref-rule','pointsBelow',${legacyPoints},'legacyPoints',${legacyPoints}))));`);
}

// Independent synthetic rows with distinct stored durations, not 2,000 copies
// of one calculation. All real source and deferred audit guards execute.
function setSourceFixtureSql(size: number, includeSources = true) {
  if (![1, 3, 10, 500, 2000].includes(size)) throw new Error('unexpected set fixture size');
  return `INSERT INTO "AttendanceSheet" (id,"activityId","submitterUserId","statusCode","updatedAt",version)
      VALUES ('set-sheet','ref-activity','ref-user','pending_review',CURRENT_TIMESTAMP,1);
    INSERT INTO "AttendanceRecord" (id,"sheetId","memberId","roleCode","checkInAt","checkOutAt",
      "serviceHours","attendanceStatusCode","contributionPoints","updatedAt")
      SELECT 'set-record-'||lpad(n::TEXT,4,'0'),'set-sheet','ref-member','volunteer',
        '2099-10-01'::TIMESTAMP+n*interval '1 hour','2099-10-01'::TIMESTAMP+(n+1)*interval '1 hour',
        n::NUMERIC/100,'present',2.00,CURRENT_TIMESTAMP FROM generate_series(1,${size}) n;
    INSERT INTO audit_logs (id,"createdAt","resourceType","resourceId",event,context,"shadowProofRequired")
      SELECT 'set-audit','2099-10-01 12:00','attendance_sheet','set-sheet','attendance-sheet.submit',
        jsonb_build_object('extra',jsonb_build_object('operation','submit','recordsCount',${size}),
          'after',jsonb_build_object('sheet',jsonb_build_object('activityId','ref-activity','version',1),
            'records',jsonb_agg(jsonb_build_object('id',id,'memberId',"memberId",'roleCode',"roleCode",
              'serviceHours',"serviceHours"::TEXT,'contributionPoints',"contributionPoints"::TEXT) ORDER BY id))),TRUE
      FROM "AttendanceRecord" WHERE "sheetId"='set-sheet';
    ${
      includeSources
        ? `INSERT INTO "ContributionShadowLegacySourceAnchor"
      SELECT (jsonb_populate_record(NULL::"ContributionShadowLegacySourceAnchor",
        to_jsonb(s)||jsonb_build_object('legacySourceHash',cslsa_source_hash_fn(s)))).*
      FROM (SELECT jsonb_populate_record(NULL::"ContributionShadowLegacySourceAnchor",jsonb_build_object(
        'id','set-source-'||r.id,'windowId','ref-window','auditLogId','set-audit','sheetId','set-sheet',
        'sheetVersion',1,'activityId','ref-activity','recordId',r.id,'memberId',r."memberId",'activityTypeCode','service',
        'attendanceRoleCode','volunteer','legacyServiceHours',r."serviceHours",'sourceKindCode','matched',
        'legacyRuleId','ref-rule','pointsBelow',2.00,'legacyPoints',2.00,'hashAlgorithmCode','sha256',
        'canonicalVersion',1,'createdAt',CURRENT_TIMESTAMP)) s FROM "AttendanceRecord" r WHERE "sheetId"='set-sheet') rows;`
        : ''
    }`;
}

function setApplicationInsertSql(from: number, through: number, badRecord = '') {
  const { manifest } = registrationReferencesFixture();
  const hash = manifest.approvals[0].policyDefinitionHash;
  const definition = JSON.stringify(policyFixture()).replaceAll("'", "''");
  return `WITH expected AS MATERIALIZED (
      SELECT s.*,csm_policy_evaluate_fn('${definition}'::JSONB,'member','volunteer_service',
        (s."legacyServiceHours"*3600)::BIGINT) evaluated FROM "ContributionShadowLegacySourceAnchor" s
      WHERE s."auditLogId"='set-audit' AND s."recordId" BETWEEN
        'set-record-${String(from).padStart(4, '0')}' AND 'set-record-${String(through).padStart(4, '0')}')
    INSERT INTO "ContributionShadowMappingApplication"
      (id,"approvalId","legacySourceAnchorId","windowId","auditLogId","sheetId","sheetVersion","recordId","memberId",
        "activityId","selectionItemId","policyVersionId","policyDefinitionHash","evaluatorVersion","durationSeconds","policyPoints","explanationCode")
      SELECT 'set-application-'||s."recordId",'ref-approval',s.id,s."windowId",s."auditLogId",s."sheetId",s."sheetVersion",
        s."recordId",s."memberId",s."activityId",'ref-selection-position','ref-version','${hash}',1,
        (s."legacyServiceHours"*3600)::INTEGER,
        CASE WHEN s."recordId"='${badRecord}' THEN 0.01 ELSE (s.evaluated->>'recognizedPoints')::NUMERIC END,
        s.evaluated->>'explanationCode' FROM expected s ORDER BY s."recordId";`;
}

function setAttemptSql(size: number) {
  return `INSERT INTO "ContributionShadowAttemptReceipt"
    (id,"windowId","auditLogId","sheetId","activityId","sheetVersion","replayKey","committedFactHash",
      "signedMappingVersion","expectedRecordCount","hashAlgorithmCode","canonicalVersion")
    VALUES ('set-attempt','ref-window','set-audit','set-sheet','ref-activity',1,
      encode(sha256(convert_to('e3-2-d1:v1:ref-window:set-audit:1','UTF8')),'hex'),repeat('a',64),'fixture-v1',${size},'sha256',1);`;
}

function setComparisonInsertSql(from: number, through: number, badRecord = '') {
  return `INSERT INTO "ContributionShadowComparisonReceipt"
    (id,"attemptId","recordId","sheetId","memberId","activityId","classificationCode",comparable,"factHash",
      "legacyRuleId","legacySourceHash","policySourceHash","selectionRevisionId","selectionItemId","policyId",
      "policyVersionId","definitionHash","evaluatorVersion","legacyServiceHours","durationSeconds","legacyPoints",
      "policyPoints","hashAlgorithmCode","canonicalVersion")
    SELECT 'set-comparison-'||s."recordId",'set-attempt',s."recordId",s."sheetId",s."memberId",s."activityId",
      CASE WHEN s."legacyPoints"=a."policyPoints" THEN 'equal' ELSE 'points_mismatch' END,TRUE,repeat('a',64),
      s."legacyRuleId",s."legacySourceHash",repeat('b',64),'ref-selection',a."selectionItemId",'ref-policy',
      a."policyVersionId",a."policyDefinitionHash",a."evaluatorVersion",s."legacyServiceHours",a."durationSeconds",
      s."legacyPoints",CASE WHEN s."recordId"='${badRecord}' THEN 0.01 ELSE a."policyPoints" END,'sha256',1
    FROM "ContributionShadowLegacySourceAnchor" s JOIN "ContributionShadowMappingApplication" a ON a."legacySourceAnchorId"=s.id
    WHERE s."auditLogId"='set-audit' AND s."recordId" BETWEEN
      'set-record-${String(from).padStart(4, '0')}' AND 'set-record-${String(through).padStart(4, '0')}' ORDER BY s."recordId";`;
}

function actualSelectionFixtureSql(
  createdAt = '2099-09-01T00:00:00.000Z',
  revision = 1,
  prefix = 'ref',
  definitionInput: unknown = policyFixture(),
  scope: 'position' | 'activity' | 'both' = 'position',
) {
  const { manifest } = registrationReferencesFixture(definitionInput);
  const pointer = {
    policyId: `${prefix}-policy`,
    versionId: `${prefix}-version`,
    definitionHash: manifest.approvals[0].policyDefinitionHash,
    evaluatorVersion: 1,
  };
  const document = createActivityContributionPolicySelectionDocument([
    {
      scope: { layerCode: 'activity', sessionId: null, positionId: null },
      selection:
        scope === 'position' ? { mode: 'inherit', pointer: null } : { mode: 'explicit', pointer },
    },
    {
      scope: {
        layerCode: 'position',
        sessionId: `${prefix}-session`,
        positionId: `${prefix}-position`,
      },
      selection:
        scope === 'activity' ? { mode: 'inherit', pointer: null } : { mode: 'explicit', pointer },
    },
  ]);
  const hash = activityContributionPolicySelectionHash(document);
  const selectionId = revision === 1 ? `${prefix}-selection` : `${prefix}-selection-${revision}`;
  const result = JSON.stringify({
    activityId: `${prefix}-activity`,
    selectionRevisionId: selectionId,
    revision,
    selectionHash: hash,
    createdAt,
  });
  return `INSERT INTO "ActivityContributionPolicySelectionRevision"
    (id,"activityId",revision,"schemaVersion","selectionHash","selectionJson","itemCount","originCode","createdAt","createdByUserId")
    VALUES ('${selectionId}','${prefix}-activity',${revision},1,'${hash}','${JSON.stringify(document).replaceAll("'", "''")}'::jsonb,2,'select','${createdAt}','${prefix}-user');
    INSERT INTO "ActivityContributionPolicySelectionItem"
    (id,"selectionRevisionId","activityId","layerCode","sessionId","positionId",mode,"policyId","versionId","definitionHash","evaluatorVersion") VALUES
    ('${selectionId}-root','${selectionId}','${prefix}-activity','activity',NULL,NULL,${scope === 'position' ? "'inherit',NULL,NULL,NULL,NULL" : `'explicit','${prefix}-policy','${prefix}-version','${pointer.definitionHash}',1`}),
    ('${selectionId}-position','${selectionId}','${prefix}-activity','position','${prefix}-session','${prefix}-position',${scope === 'activity' ? "'inherit',NULL,NULL,NULL,NULL" : `'explicit','${prefix}-policy','${prefix}-version','${pointer.definitionHash}',1`});
    UPDATE "Activity" SET "contributionPolicySelectionRevision"=${revision},"currentContributionPolicySelectionRevisionId"='${selectionId}' WHERE id='${prefix}-activity';
    INSERT INTO "ActivityContributionPolicySelectionCommandReceipt"
    (id,"actorUserId","activityId","operationCode","operationKey","requestHash","selectionRevisionId","resultJson","createdAt")
    VALUES ('${selectionId}-receipt','${prefix}-user','${prefix}-activity','patch_contribution_policy_selection','${selectionId}-key',repeat('a',64),'${selectionId}','${result}'::jsonb,'${createdAt}');`;
}

function secondMappingGroupSql(statement: string) {
  return statement
    .replaceAll('ref-', 'second-')
    .replaceAll('second-window', 'ref-window')
    .replaceAll('second-rule', 'ref-rule');
}

function twoActualMappingGroupsSql() {
  const { manifest, fixtureSql } = registrationReferencesFixture();
  manifest.commandKey = 'second-command';
  Object.assign(manifest.approvals[0], {
    approvalNumber: 'second-number',
    activityId: 'second-activity',
    sessionPositionId: 'second-position',
    policyVersionId: 'second-version',
  });
  const authority = JSON.stringify({
    databaseName: deriveTestDbName(),
    manifestHash: manifestApplicationHash(manifest),
    actorUserId: 'ref-user',
    approvalReference: manifest.approvalReference,
    ownerRole: fixtureRole('owner'),
    registrarRole: fixtureRole('registrar'),
    runtimeRole: fixtureRole('runtime'),
    manifest,
  }).replaceAll("'", "''");
  const script = readFileSync(
    join(process.cwd(), 'scripts/sql/contribution-shadow-registration-roles.sql'),
    'utf8',
  );
  // Only this fixture's SQL identifiers are renamed. Manifest and selection
  // digests are regenerated above/below, never mechanically edited.
  const sourceStart = actualSourceApprovalFixture().indexOf('    INSERT INTO "Member"');
  if (sourceStart < 0) throw new Error('source fixture marker missing');
  const secondSource = secondMappingGroupSql(actualSourceApprovalFixture().slice(sourceStart))
    .replaceAll("'REF135'", "'SECOND135'")
    // The legacy rule and non-overlapping observation window are global;
    // independent activity/audit/policy groups share these actual anchors.
    .replace(/ {4}INSERT INTO "ContributionRule"[^;]+;/, '')
    .replace(/ {4}INSERT INTO "ContributionShadowObservationWindow"[^;]+;/, '');
  const secondReferences = fixtureSql
    .replaceAll('ref-', 'second-')
    .replaceAll("'ref_policy'", "'second_policy'")
    .replaceAll("'ref_session'", "'second_session'")
    .replaceAll("'ref_position'", "'second_position'");
  return `${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
    ${secondReferences}
    SET LOCAL srvf.shadow_acl_database='${fixtureDatabase()}'; SET LOCAL srvf.shadow_acl_action='bind';
    SET LOCAL srvf.shadow_registration_authority='${authority}'; ${script}
    SET SESSION AUTHORIZATION srvf_shadow_registrar_w98_fixture;
    DO $register_second$ BEGIN PERFORM csm_register_mapping_fn(
      '${JSON.stringify(manifest).replaceAll("'", "''")}'::JSONB,'ref-user','second-receipt','second-register-audit','["second-approval"]'::JSONB);
    END $register_second$; RESET SESSION AUTHORIZATION;
    ${secondSource} ${actualSelectionFixtureSql(undefined, 1, 'second')}`;
}

function applicationInsertSql(change: Record<string, string | number> = {}) {
  const { manifest } = registrationReferencesFixture();
  const row: Record<string, string | number> = {
    id: 'ref-application',
    approvalId: 'ref-approval',
    legacySourceAnchorId: 'ref-source',
    windowId: 'ref-window',
    auditLogId: 'ref-source-audit',
    sheetId: 'ref-sheet',
    sheetVersion: 1,
    recordId: 'ref-record',
    memberId: 'ref-member',
    activityId: 'ref-activity',
    selectionItemId: 'ref-selection-position',
    policyVersionId: 'ref-version',
    policyDefinitionHash: manifest.approvals[0].policyDefinitionHash,
    evaluatorVersion: 1,
    durationSeconds: 3600,
    policyPoints: '10.00',
    explanationCode: 'hour',
    ...change,
  };
  return `INSERT INTO "ContributionShadowMappingApplication"
    (${Object.keys(row)
      .map((column) => `"${column}"`)
      .join(',')})
    VALUES (${Object.values(row)
      .map((value) => (typeof value === 'number' ? value : `'${value.replaceAll("'", "''")}'`))
      .join(',')});`;
}

function attemptInsertSql() {
  return `INSERT INTO "ContributionShadowAttemptReceipt"
    (id,"windowId","auditLogId","sheetId","activityId","sheetVersion","replayKey","committedFactHash","signedMappingVersion","expectedRecordCount","hashAlgorithmCode","canonicalVersion")
    VALUES ('ref-attempt','ref-window','ref-source-audit','ref-sheet','ref-activity',1,
      encode(sha256(convert_to('e3-2-d1:v1:ref-window:ref-source-audit:1','UTF8')),'hex'),
      repeat('a',64),'fixture-v1',1,'sha256',1);`;
}

function comparisonInsertSql(change: Record<string, string | number> = {}) {
  const { manifest } = registrationReferencesFixture();
  const row: Record<string, string | number> = {
    id: 'ref-comparison',
    attemptId: 'ref-attempt',
    recordId: 'ref-record',
    sheetId: 'ref-sheet',
    memberId: 'ref-member',
    activityId: 'ref-activity',
    classificationCode: 'points_mismatch',
    factHash: 'a'.repeat(64),
    legacyRuleId: 'ref-rule',
    policySourceHash: 'b'.repeat(64),
    selectionRevisionId: 'ref-selection',
    selectionItemId: 'ref-selection-position',
    policyVersionId: 'ref-version',
    policyId: 'ref-policy',
    definitionHash: manifest.approvals[0].policyDefinitionHash,
    evaluatorVersion: 1,
    legacyServiceHours: '1.00',
    durationSeconds: 3600,
    legacyPoints: '2.00',
    policyPoints: '10.00',
    hashAlgorithmCode: 'sha256',
    canonicalVersion: 1,
    ...change,
  };
  return `INSERT INTO "ContributionShadowComparisonReceipt"
    (${Object.keys(row)
      .map((column) => `"${column}"`)
      .join(',')},comparable,"legacySourceHash")
    VALUES (${Object.values(row)
      .map((value) => (typeof value === 'number' ? value : `'${value.replaceAll("'", "''")}'`))
      .join(',')},
      true,(SELECT "legacySourceHash" FROM "ContributionShadowLegacySourceAnchor" WHERE id='ref-source'));`;
}

// Most role/ACL probes roll back; the final cross-transaction persistence probe
// commits these exact fixtures and removes them after dropping only this worker. The
// separately authorized final probe temporarily enables only runtime LOGIN,
// verifies real authentication, then revokes it. No real mapping is registered.
function registrationAuthorityFixtureSql(
  manifest: ReturnType<typeof manifestFixture>,
  bootstrap = true,
) {
  const owner = 'srvf_shadow_owner_w98_fixture';
  const registrar = 'srvf_shadow_registrar_w98_fixture';
  const runtime = 'srvf_shadow_runtime_w98_fixture';
  const authority = JSON.stringify({
    databaseName: deriveTestDbName(),
    manifestHash: manifestApplicationHash(manifest),
    actorUserId: 'ref-user',
    approvalReference: manifest.approvalReference,
    ownerRole: owner,
    registrarRole: registrar,
    runtimeRole: runtime,
    manifest,
  }).replaceAll("'", "''");
  const script = readFileSync(
    join(process.cwd(), 'scripts/sql/contribution-shadow-registration-roles.sql'),
    'utf8',
  );
  return fixtureStatement(`SET LOCAL srvf.shadow_acl_database = 'app_test_w98';
    ${bootstrap ? `SET LOCAL srvf.shadow_acl_action = 'bootstrap'; ${script}` : ''}
    SET LOCAL srvf.shadow_registration_authority = '${authority}';
    SET LOCAL srvf.shadow_acl_action = 'bind'; ${script}`);
}

function checkRegistrationReferences(manifest: unknown, fixtureSql: string): string {
  return sql(`BEGIN; ${fixtureSql}
    SELECT csm_assert_registration_references_fn('${JSON.stringify(manifest).replaceAll("'", "''")}'::jsonb);
    SELECT 'references-checked'; ROLLBACK;`);
}

function sql(statement: string): string {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  if (!process.env.JEST_WORKER_ID) throw new Error('mapping proof requires an isolated worker');
  return execFileSync(
    'docker',
    [
      'exec',
      '-i',
      'u-nest-api-postgres',
      'psql',
      '--no-psqlrc',
      '-qtA',
      '-U',
      'postgres',
      '-d',
      deriveTestDbName(),
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { input: fixtureStatement(statement), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
}

// Instantiate only the fixed test SQL template. Never execute its production
// role branch on a worker database; all three names are unique to this worker.
function fixtureDatabase(): string {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  const database = deriveTestDbName();
  if (!process.env.JEST_WORKER_ID || !/^app_test(?:_[a-z0-9_]+)?_w[1-9][0-9]*$/.test(database)) {
    throw new Error('mapping fixture requires an exact derived worker database');
  }
  return database;
}

function fixtureSuffix(): string {
  const database = fixtureDatabase();
  return database === 'app_test_w98'
    ? 'w98'
    : createHash('sha256').update(database).digest('hex').slice(0, 16);
}

function fixtureRole(kind: 'owner' | 'registrar' | 'runtime'): string {
  return `srvf_shadow_${kind}_${fixtureSuffix()}_fixture`;
}

function fixtureStatement(statement: string): string {
  return statement
    .replaceAll('app_test_w98', fixtureDatabase())
    .replaceAll('_w98_fixture', `_${fixtureSuffix()}_fixture`);
}

describe('E3-2 D2 mapping schema construction', () => {
  const previous = { worker: process.env.JEST_WORKER_ID, url: process.env.DATABASE_URL };
  let committedAclFixture = false;
  beforeAll(async () => {
    if (dedicated) {
      process.env.JEST_WORKER_ID = '98';
      loadTestEnv();
      assertTestDatabaseUrl(process.env.DATABASE_URL);
      if (deriveTestDbName() !== deriveWorkerTestDbName(98))
        throw new Error('unexpected mapping proof target');
      await scratchLifecycle.drop('98');
      await scratchLifecycle.create(deriveTestDbName());
      execFileSync(
        'pnpm',
        ['exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
        { env: process.env, stdio: 'pipe' },
      );
    }
    assertTestDatabaseUrl(process.env.DATABASE_URL);
  }, 120_000);

  afterAll(async () => {
    if (!dedicated && !committedAclFixture) return;
    try {
      await scratchLifecycle.drop(process.env.JEST_WORKER_ID!);
      if (committedAclFixture) {
        // These three names were asserted absent before this suite created them.
        // This suite's fixture DB has now gone, so no owned object is cascaded
        // or reassigned. Do not use DROP OWNED or touch any real role/database.
        execFileSync(
          'docker',
          [
            'exec',
            '-i',
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
          ],
          {
            input: fixtureStatement(
              'DROP ROLE srvf_shadow_runtime_w98_fixture, srvf_shadow_registrar_w98_fixture, srvf_shadow_owner_w98_fixture;',
            ),
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
        committedAclFixture = false;
      }
      if (!dedicated) {
        await scratchLifecycle.create(fixtureDatabase());
        execFileSync(
          'pnpm',
          ['exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
          { env: process.env, stdio: 'pipe' },
        );
      }
    } finally {
      if (previous.worker === undefined) delete process.env.JEST_WORKER_ID;
      else process.env.JEST_WORKER_ID = previous.worker;
      if (previous.url === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous.url;
    }
  });

  it('matches two closed policy evaluators against independent database recomputation for 2,000 mixed inputs', () => {
    const definitions = [policyFixture(), policyFixture()];
    definitions[1].roleRules[0].categoryRules[0].durationBands[2].recognizedPoints = '11.00';
    const prepared = definitions.map((definition) =>
      prepareContributionPolicyVersion({
        schemaVersion: 1,
        evaluatorVersion: 1,
        definition,
        effectiveFrom: '2099-01-01T00:00:00.000Z',
        effectiveUntil: null,
      }),
    );
    const durations = [0, 1, 60, 61, 3599, 3600, 3601, 7200];
    const inputs = Array.from({ length: 2000 }, (_, index) => ({
      index,
      policy: index % 2,
      role: index % 11 === 0 ? 'missing' : 'member',
      duration: durations[Math.floor(index / 2) % durations.length],
    }));
    const payload = JSON.stringify({ definitions, inputs }).replaceAll("'", "''");
    const database: Array<{ index: number; result: unknown }> = JSON.parse(
      sql(`
      WITH fixture AS (SELECT '${payload}'::JSONB value)
      SELECT jsonb_agg(jsonb_build_object('index',(input->>'index')::INTEGER,
        'result',csm_policy_evaluate_fn(fixture.value->'definitions'->((input->>'policy')::INTEGER),
          input->>'role','volunteer_service',(input->>'duration')::BIGINT)) ORDER BY (input->>'index')::INTEGER)
      FROM fixture CROSS JOIN LATERAL jsonb_array_elements(fixture.value->'inputs') AS samples(input)`),
    );
    expect(database).toHaveLength(2000);
    inputs.forEach((input, index) => {
      const fact = {
        attendanceRoleCode: input.role,
        timeCategoryCode: 'volunteer_service',
        durationSeconds: input.duration,
      };
      const actual = prepared[input.policy].evaluate(fact);
      expect(actual).toEqual(evaluateContributionPolicy(definitions[input.policy], fact));
      expect(database[index]).toEqual({ index, result: actual });
    });
    expect(new Set(prepared.map((policy) => policy.definitionHash)).size).toBe(2);
  });

  it('matches pre-29.17 mapping results and exact exception priority on valid and ambiguous inputs', () => {
    const base = mappingInputsFixture();
    const cases: unknown[] = [base];
    for (const hours of [null, '-0.01', '0', '0.01', '1.00', '1.01', '999.99', 'NaN']) {
      for (const badHash of [false, true]) {
        const hash = badHash ? 'b'.repeat(64) : base.policy.definitionHash;
        cases.push({
          ...base,
          source: { ...base.source, legacyServiceHours: hours },
          policy: { ...base.policy, definitionHash: hash },
          approval: { ...base.approval, policyDefinitionHash: hash },
        });
      }
    }
    for (const role of ['member', 'missing', '', null])
      for (const category of ['volunteer_service', 'training', 'invalid', null])
        cases.push({
          ...base,
          approval: { ...base.approval, policyRoleCode: role, categoryCode: category },
        });
    const unseen = policyFixture();
    unseen.roleRules.push({
      attendanceRoleCode: 'unselected',
      categoryRules: [
        {
          timeCategoryCode: 'training',
          durationBands: [
            { maxSecondsInclusive: null, recognizedPoints: '1000.00', explanationCode: 'invalid' },
          ],
        },
      ],
    });
    for (const definitionJson of [null, {}, [], unseen, { ...policyFixture(), extra: true }])
      cases.push({
        ...base,
        source: { ...base.source, legacyServiceHours: null },
        policy: { ...base.policy, definitionJson },
      });
    for (const effectiveFrom of [null, 'infinity', '2099-01-01T00:00:00.001Z'])
      cases.push({ ...base, policy: { ...base.policy, effectiveFrom } });
    cases.push({
      ...base,
      approval: { ...base.approval, approvedAt: null },
      policy: { ...base.policy, definitionJson: null },
    });
    const payload = JSON.stringify(cases).replaceAll("'", "''");
    const results = JSON.parse(
      sql(`BEGIN; ${MAPPING_INPUTS_REFERENCE_SQL}
      CREATE FUNCTION pg_temp.mapping_differential(v JSONB) RETURNS JSONB LANGUAGE plpgsql AS $diff$
      DECLARE a "ContributionShadowMappingApproval"; s "ContributionShadowLegacySourceAnchor";
        o "ContributionShadowObservationWindow"; p "ContributionPolicyVersion"; t TIMESTAMPTZ;
        actual JSONB; reference JSONB; actual_error TEXT; reference_error TEXT;
      BEGIN
        a:=jsonb_populate_record(NULL::"ContributionShadowMappingApproval",v->'approval');
        s:=jsonb_populate_record(NULL::"ContributionShadowLegacySourceAnchor",v->'source');
        o:=jsonb_populate_record(NULL::"ContributionShadowObservationWindow",v->'observation');
        p:=jsonb_populate_record(NULL::"ContributionPolicyVersion",v->'policy'); t:=(v->>'auditTime')::TIMESTAMPTZ;
        BEGIN reference:=pg_temp.reference_mapping_inputs_fn(a,s,o,p,t);
        EXCEPTION WHEN OTHERS THEN reference_error:=SQLSTATE||':'||SQLERRM; END;
        BEGIN actual:=csm_mapping_inputs_result_fn(a,s,o,p,t);
        EXCEPTION WHEN OTHERS THEN actual_error:=SQLSTATE||':'||SQLERRM; END;
        RETURN jsonb_build_object('same',actual IS NOT DISTINCT FROM reference AND actual_error IS NOT DISTINCT FROM reference_error,
          'accepted',reference_error IS NULL,'error',reference_error);
      END $diff$;
      SELECT jsonb_agg(pg_temp.mapping_differential(value)) FROM jsonb_array_elements('${payload}'::jsonb);
      ROLLBACK;`),
    );
    expect(results).toHaveLength(cases.length);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accepted: true }),
        expect.objectContaining({ accepted: false }),
      ]),
    );
    expect(results.every((entry: { same: boolean }) => entry.same)).toBe(true);
  });

  it('matches fused policy proof to independent fingerprint and evaluator for complete E1 shapes', () => {
    const base = mappingInputsFixture().policy;
    const cases: unknown[] = [];
    for (const roleCount of [0, 1, 2, 64])
      for (const categoryCount of [0, 1, 4])
        for (const bandCount of [1, 2, 16]) {
          const definitionJson = {
            defaultResult: { recognizedPoints: '0.00', explanationCode: 'default' },
            roleRules: Array.from({ length: roleCount }, (_, r) => ({
              attendanceRoleCode: `role_${r}`,
              categoryRules: ['volunteer_service', 'training', 'organization', 'non_creditable']
                .slice(0, categoryCount)
                .reverse()
                .map((timeCategoryCode) => ({
                  timeCategoryCode,
                  durationBands: Array.from({ length: bandCount }, (_, b) => ({
                    maxSecondsInclusive:
                      b === bandCount - 1
                        ? null
                        : b === bandCount - 2
                          ? Number.MAX_SAFE_INTEGER
                          : b,
                    recognizedPoints: b % 2 === 0 ? '999.99' : '0.00',
                    explanationCode: `band_${b}`,
                  })),
                })),
            })).reverse(),
          };
          cases.push({ ...base, definitionJson });
        }
    for (const role of ['中文😀', 'quoted"role', 'slash\\role', 'e\u0301']) {
      const definitionJson = policyFixture();
      definitionJson.roleRules[0].attendanceRoleCode = role;
      cases.push({ ...base, definitionJson });
    }
    const payload = JSON.stringify(cases).replaceAll("'", "''");
    const result = JSON.parse(
      sql(`BEGIN;
      SELECT jsonb_build_object('cases',count(*),'matches',count(*) FILTER (WHERE
        proof->>'definitionHash'=csm_policy_fingerprint_fn(policy) AND
        proof->'evaluated'=csm_policy_evaluate_fn((policy)."definitionJson",role,'volunteer_service',36) AND
        proof->'explicitRule'=to_jsonb(EXISTS(SELECT 1 FROM jsonb_array_elements((policy)."definitionJson"->'roleRules') r(value)
          CROSS JOIN LATERAL jsonb_array_elements(r.value->'categoryRules') c(value)
          WHERE r.value->>'attendanceRoleCode'=role AND c.value->>'timeCategoryCode'='volunteer_service'))))
      FROM (SELECT jsonb_populate_record(NULL::"ContributionPolicyVersion",value) policy,
        coalesce(value->'definitionJson'->'roleRules'->0->>'attendanceRoleCode','no_role') role
        FROM jsonb_array_elements('${payload}'::jsonb)) inputs
      CROSS JOIN LATERAL (SELECT csm_policy_evaluation_proof_fn(policy,role,'volunteer_service',36) proof) evaluated;
      ROLLBACK;`),
    );
    expect(result).toEqual({ cases: cases.length, matches: cases.length });
  });

  it('matches selection hashes and fallback errors to the unchanged generic canonicalizer', () => {
    const item = (name: string, evaluatorVersion = 1) => ({
      scope: { layerCode: 'position', positionId: name, sessionId: null },
      selection: {
        mode: 'explicit',
        pointer: {
          policyId: name,
          versionId: 'v',
          definitionHash: 'a'.repeat(64),
          evaluatorVersion,
        },
      },
    });
    const documents: unknown[] = [
      null,
      [],
      {},
      true,
      'selection',
      1,
      { schemaVersion: 1, items: {} },
      { schemaVersion: 2, items: {} },
      {
        schemaVersion: 1,
        items: {
          activity: {
            scope: { layerCode: 'activity', positionId: null, sessionId: null },
            selection: { mode: 'inherit', pointer: null },
          },
        },
      },
    ];
    for (const evaluator of [1, -1, 0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 0.5])
      documents.push({ schemaVersion: 1, items: { position: item('test', evaluator) } });
    for (const name of ['a', '中文😀', 'quoted"key', 'slash\\key', "quote'key", 'e\u0301', '\n'])
      documents.push({
        schemaVersion: 1,
        items: { z: item(name), [name]: item(name), a: item('first') },
      });
    documents.push(
      { schemaVersion: 1, items: { x: { ...item('x'), extra: true } } },
      { schemaVersion: 1, items: { x: { scope: { layerCode: 'activity' }, selection: null } } },
      {
        schemaVersion: 1,
        items: {
          x: {
            ...item('x'),
            selection: { mode: 'explicit', pointer: { ...item('x').selection.pointer, extra: 1 } },
          },
        },
      },
      { schemaVersion: 1, items: [], extra: true },
    );
    const payload = JSON.stringify(documents).replaceAll("'", "''");
    const result = JSON.parse(
      sql(`BEGIN;
      CREATE FUNCTION pg_temp.selection_differential(doc JSONB,version INTEGER) RETURNS JSONB LANGUAGE plpgsql AS $diff$
      DECLARE actual TEXT; reference TEXT; actual_error TEXT; reference_error TEXT;
      BEGIN
        BEGIN reference:=encode(sha256(convert_to(csm_manifest_canonical_fn(jsonb_build_object('definition',doc,'schemaVersion',version)),'UTF8')),'hex');
        EXCEPTION WHEN OTHERS THEN reference_error:=SQLSTATE||':'||SQLERRM; END;
        BEGIN actual:=csm_selection_hash_fn(doc,version);
        EXCEPTION WHEN OTHERS THEN actual_error:=SQLSTATE||':'||SQLERRM; END;
        RETURN jsonb_build_object('same',actual IS NOT DISTINCT FROM reference AND actual_error IS NOT DISTINCT FROM reference_error,
          'accepted',reference_error IS NULL);
      END $diff$;
      SELECT jsonb_agg(pg_temp.selection_differential(value,version))
      FROM (SELECT value FROM jsonb_array_elements('${payload}'::jsonb) UNION ALL SELECT NULL::JSONB) docs
      CROSS JOIN unnest(ARRAY[1,2,NULL]::INTEGER[]) version;
      ROLLBACK;`),
    );
    expect(result).toHaveLength((documents.length + 1) * 3);
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accepted: true }),
        expect.objectContaining({ accepted: false }),
      ]),
    );
    expect(result.every((entry: { same: boolean }) => entry.same)).toBe(true);
  });

  it('measures old and optimized pure calculations with equal results and counts one policy validation', () => {
    const input = JSON.stringify(mappingInputsFixture()).replaceAll("'", "''");
    const rows: Array<{ variant: string; rows: number; elapsedMs: number }> = JSON.parse(
      sql(`BEGIN;
      ${MAPPING_INPUTS_REFERENCE_SQL}
      CREATE TEMP TABLE calculation_timing(variant TEXT,rows INTEGER,elapsed_ms NUMERIC);
      DO $timing$
      DECLARE v JSONB:='${input}'::JSONB; a "ContributionShadowMappingApproval"; s "ContributionShadowLegacySourceAnchor";
        o "ContributionShadowObservationWindow"; p "ContributionPolicyVersion"; t TIMESTAMPTZ;
        doc JSONB; old_result JSONB; actual JSONB; old_hash TEXT; actual_hash TEXT;
        variant TEXT; n INTEGER; started TIMESTAMPTZ;
      BEGIN
        a:=jsonb_populate_record(NULL::"ContributionShadowMappingApproval",v->'approval');
        s:=jsonb_populate_record(NULL::"ContributionShadowLegacySourceAnchor",v->'source');
        o:=jsonb_populate_record(NULL::"ContributionShadowObservationWindow",v->'observation');
        p:=jsonb_populate_record(NULL::"ContributionPolicyVersion",v->'policy'); t:=(v->>'auditTime')::TIMESTAMPTZ;
        doc:='{"schemaVersion":1,"items":{"activity":{"scope":{"layerCode":"activity","positionId":null,"sessionId":null},"selection":{"mode":"inherit","pointer":null}},"position:s:p":{"scope":{"layerCode":"position","sessionId":"s","positionId":"p"},"selection":{"mode":"explicit","pointer":{"policyId":"policy","versionId":"version","definitionHash":"hash","evaluatorVersion":1}}}}}'::JSONB;
        old_result:=pg_temp.reference_mapping_inputs_fn(a,s,o,p,t);
        old_hash:=encode(sha256(convert_to(csm_manifest_canonical_fn(jsonb_build_object('definition',doc,'schemaVersion',1)),'UTF8')),'hex');
        FOREACH variant IN ARRAY ARRAY['old_mapping','new_mapping','new_mapping','old_mapping','old_selection','new_selection','new_selection','old_selection'] LOOP
          started:=clock_timestamp();
          FOR n IN 1..2000 LOOP
            IF variant='old_mapping' THEN actual:=pg_temp.reference_mapping_inputs_fn(a,s,o,p,t);
            ELSIF variant='new_mapping' THEN actual:=csm_mapping_inputs_result_fn(a,s,o,p,t);
            ELSIF variant='old_selection' THEN actual_hash:=encode(sha256(convert_to(csm_manifest_canonical_fn(jsonb_build_object('definition',doc,'schemaVersion',1)),'UTF8')),'hex');
            ELSE actual_hash:=csm_selection_hash_fn(doc,1); END IF;
            IF (variant IN ('old_mapping','new_mapping') AND actual IS DISTINCT FROM old_result) OR
              (variant IN ('old_selection','new_selection') AND actual_hash IS DISTINCT FROM old_hash) THEN
              RAISE EXCEPTION 'pure calculation timing result mismatch';
            END IF;
          END LOOP;
          INSERT INTO calculation_timing VALUES(variant,2000,extract(epoch FROM clock_timestamp()-started)*1000);
        END LOOP;
      END $timing$;
      SELECT jsonb_agg(jsonb_build_object('variant',variant,'rows',rows,'elapsedMs',elapsed_ms)) FROM calculation_timing;
      ROLLBACK;`),
    );
    expect(rows.map(({ variant, rows }) => ({ variant, rows }))).toEqual(
      [
        'old_mapping',
        'new_mapping',
        'new_mapping',
        'old_mapping',
        'old_selection',
        'new_selection',
        'new_selection',
        'old_selection',
      ].map((variant) => ({ variant, rows: 2000 })),
    );
    expect(rows.every((row) => Number.isFinite(row.elapsedMs) && row.elapsedMs > 0)).toBe(true);
    console.info('[shadow-pure-calculation-timing]', JSON.stringify(rows));
    const calls = JSON.parse(
      sql(`BEGIN; SET LOCAL track_functions='all';
      DO $count$
      DECLARE v JSONB:='${input}'::JSONB;
      BEGIN
        PERFORM csm_mapping_inputs_result_fn(
          jsonb_populate_record(NULL::"ContributionShadowMappingApproval",v->'approval'),
          jsonb_populate_record(NULL::"ContributionShadowLegacySourceAnchor",v->'source'),
          jsonb_populate_record(NULL::"ContributionShadowObservationWindow",v->'observation'),
          jsonb_populate_record(NULL::"ContributionPolicyVersion",v->'policy'),(v->>'auditTime')::TIMESTAMPTZ);
      END $count$;
      SELECT coalesce(jsonb_object_agg(funcname,calls),'{}'::JSONB) FROM pg_stat_xact_user_functions
        WHERE funcname IN ('csm_mapping_inputs_result_fn','csm_policy_evaluation_proof_fn','csm_policy_evaluate_fn','csm_policy_fingerprint_fn');
      ROLLBACK;`),
    );
    expect(calls.csm_mapping_inputs_result_fn).toBe(1);
    expect(calls.csm_policy_evaluation_proof_fn).toBe(1);
    expect(calls.csm_policy_evaluate_fn).toBe(1);
    expect(calls.csm_policy_fingerprint_fn ?? 0).toBe(0);
  });

  it('keeps pure proof helpers invoker-only and rejects caller-computed forged application points', () => {
    expect(
      sql(`SELECT count(*) FROM pg_proc WHERE proname IN ('csm_policy_evaluation_proof_fn','csm_selection_hash_fn')
      AND pronamespace='public'::regnamespace AND NOT prosecdef AND provolatile='i'`),
    ).toBe('2');
    expect(() =>
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      SELECT csm_selection_hash_fn('{"schemaVersion":1,"items":{}}'::JSONB,1);
      ${applicationInsertSql({ policyPoints: 999.99 })} ROLLBACK;`),
    ).toThrow('shadow mapping application differs from database proof');
  });

  it('matches the fixed pre-optimization text validator across ASCII and Unicode boundaries', () => {
    const result = JSON.parse(
      sql(`BEGIN;
      CREATE FUNCTION pg_temp.old_text_limit(value JSONB, maximum_units INTEGER) RETURNS BOOLEAN
      LANGUAGE plpgsql IMMUTABLE AS $$
      DECLARE content TEXT; character_code INTEGER; units INTEGER := 0; i INTEGER;
        trim_codes INTEGER[] := ARRAY[9,10,11,12,13,32,160,5760,8192,8193,8194,8195,
          8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279];
      BEGIN
        IF value IS NULL OR jsonb_typeof(value) <> 'string' THEN RETURN FALSE; END IF;
        content := value #>> '{}';
        IF length(content) = 0 THEN RETURN FALSE; END IF;
        FOR i IN 1..length(content) LOOP
          character_code := ascii(substr(content, i, 1));
          IF character_code < 32 OR character_code BETWEEN 127 AND 159 THEN RETURN FALSE; END IF;
          IF (i = 1 OR i = length(content)) AND character_code = ANY(trim_codes) THEN RETURN FALSE; END IF;
          units := units + CASE WHEN character_code > 65535 THEN 2 ELSE 1 END;
        END LOOP;
        RETURN maximum_units IS NOT NULL AND maximum_units > 0 AND units <= maximum_units;
      END $$;
      WITH chars AS (
        SELECT chr(n) AS s FROM generate_series(1,159) n
        UNION ALL SELECT chr(n) FROM unnest(ARRAY[160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279,20013,65535,65536,128512]) n
      ), strings AS (
        SELECT s FROM chars UNION ALL SELECT s || 'x' FROM chars
        UNION ALL SELECT 'x' || s FROM chars UNION ALL SELECT 'x' || s || 'x' FROM chars
        UNION ALL SELECT repeat('a',n) FROM unnest(ARRAY[0,1,2,63,64,65,127,128,129,255,256,257]) n
        UNION ALL SELECT repeat(chr(128512),n) FROM unnest(ARRAY[1,31,32,33,63,64,65,127,128,129]) n
        UNION ALL SELECT 'e' || chr(769)
      ), values_to_check AS (
        SELECT to_jsonb(s) AS value FROM strings
        UNION ALL SELECT v FROM (VALUES (NULL::jsonb),('null'::jsonb),('1'::jsonb),('true'::jsonb),('[]'::jsonb),('{}'::jsonb)) extra(v)
      ), limits AS (SELECT n FROM unnest(ARRAY[NULL,-1,0,1,2,63,64,65,127,128,129,255,256,257]) n),
      checked AS (
        SELECT csm_text_limit_fn(value,n) AS actual, pg_temp.old_text_limit(value,n) AS expected
        FROM values_to_check CROSS JOIN limits
      ) SELECT jsonb_build_object('cases',count(*),'mismatches',count(*) FILTER (WHERE actual IS DISTINCT FROM expected),
        'accepted',count(*) FILTER (WHERE actual),'rejected',count(*) FILTER (WHERE NOT actual)) FROM checked;
      ROLLBACK;`),
    ) as { cases: number; mismatches: number; accepted: number; rejected: number };
    expect(result.cases).toBe(10598);
    expect(result.mismatches).toBe(0);
    expect(result.accepted).toBeGreaterThan(0);
    expect(result.rejected).toBeGreaterThan(0);
    expect(result.accepted + result.rejected).toBe(result.cases);
  });

  it('cold-replays 136 migrations and leaves all new evidence tables empty', () => {
    expect(
      sql(
        'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
      ),
    ).toBe('136');
    for (const table of [
      'ContributionShadowMappingApproval',
      'ContributionShadowMappingApplication',
      'ContributionShadowMappingRegistrationReceipt',
    ]) {
      expect(sql(`SELECT count(*) FROM "${table}"`)).toBe('0');
    }
  });

  it('leaves registration authority disabled and denies caller-supplied approval settings', () => {
    expect(sql('SELECT csm_registration_authority_fn() IS NULL')).toBe('t');
    const manifest = JSON.stringify(manifestFixture()).replaceAll("'", "''");
    expect(() =>
      sql(`BEGIN; SET LOCAL srvf.mapping_approved = 'true';
      SELECT csm_register_mapping_fn('${manifest}'::jsonb,'ref-user','ref-receipt','ref-audit','["ref-approval"]');
      ROLLBACK;`),
    ).toThrow('shadow mapping registration authority unavailable');
  });

  it('prereads actual registered approval and immutable legacy source, independently evaluating policy', () => {
    const actual = sql(`BEGIN; ${actualSourceApprovalFixture()}
      SELECT csm_source_approval_result_fn('ref-source','ref-approval'); ROLLBACK;`);
    expect(JSON.parse(actual)).toMatchObject({
      approvalId: 'ref-approval',
      legacySourceAnchorId: 'ref-source',
      activityId: 'ref-activity',
      recordId: 'ref-record',
      memberId: 'ref-member',
      sessionPositionId: 'ref-position',
      policyVersionId: 'ref-version',
      evaluatorVersion: 1,
      durationSeconds: 3600,
      recognizedPoints: '10.00',
      explanationCode: 'hour',
    });
    expect(sql('SELECT csm_registration_authority_fn() IS NULL')).toBe('t');
  });

  it.each([
    ['missing-source', 'ref-approval'],
    ['ref-source', 'missing-approval'],
  ])(
    'rejects missing real anchors rather than accepting supplied rows: %s / %s',
    (source, approval) => {
      expect(() =>
        sql(`BEGIN; ${actualSourceApprovalFixture()}
      SELECT csm_source_approval_result_fn('${source}','${approval}'); ROLLBACK;`),
      ).toThrow('shadow mapping source or approval unavailable');
    },
  );

  it('does not guess among multiple applicable approved mappings', () => {
    expect(() =>
      sql(`BEGIN; ${actualSourceApprovalFixture(true)}
      SELECT csm_source_approval_result_fn('ref-source','ref-approval'); ROLLBACK;`),
    ).toThrow('shadow mapping approval set is ambiguous or unavailable');
  });

  it('preserves historical approval evidence after operational registration authority is closed', () => {
    const script = readFileSync(
      join(process.cwd(), 'scripts/sql/contribution-shadow-registration-roles.sql'),
      'utf8',
    );
    expect(
      sql(`BEGIN; ${actualSourceApprovalFixture()}
      SET LOCAL srvf.shadow_acl_action = 'close'; ${script}
      SELECT csm_registration_authority_fn() IS NULL;
      SELECT csm_source_approval_result_fn('ref-source','ref-approval')->>'recognizedPoints'; ROLLBACK;`),
    ).toBe('t\n10.00');
  });

  it.each([
    `UPDATE "ActivitySessionPosition" SET "deletedAt" = CURRENT_TIMESTAMP WHERE id = 'ref-position'`,
    `UPDATE "ActivitySession" SET "deletedAt" = CURRENT_TIMESTAMP WHERE id = 'ref-session'`,
  ])(
    'rejects an unavailable real session/position despite unchanged approval content: %s',
    (change) => {
      expect(() =>
        sql(`BEGIN; ${actualSourceApprovalFixture()} ${change};
      SELECT csm_source_approval_result_fn('ref-source','ref-approval'); ROLLBACK;`),
      ).toThrow('shadow mapping actual position unavailable');
    },
  );

  it('does not resolve shadow source IDs against caller-created temporary tables', () => {
    expect(
      sql(`BEGIN; ${actualSourceApprovalFixture()}
      CREATE TEMP TABLE "ContributionShadowLegacySourceAnchor" (LIKE public."ContributionShadowLegacySourceAnchor");
      CREATE TEMP TABLE "ContributionShadowMappingApproval" (LIKE public."ContributionShadowMappingApproval");
      SELECT csm_source_approval_result_fn('ref-source','ref-approval')->>'recognizedPoints'; ROLLBACK;`),
    ).toBe('10.00');
  });

  it('materializes a legitimate application through the isolated nonowner runtime with locked SQL proof', () => {
    expect(
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      ${applicationInsertSql()}
      RESET SESSION AUTHORIZATION;
      SET CONSTRAINTS ALL IMMEDIATE;
      SELECT "policyPoints"::text || ':' || "durationSeconds"::text || ':' || "explanationCode"
        FROM "ContributionShadowMappingApplication" WHERE id='ref-application'; ROLLBACK;`),
    ).toBe('10.00:3600:hour');
  });

  it.each([2, 10])(
    'accepts only the database-proven classification and terminal buckets for old points %s',
    (legacyPoints) => {
      const equal = legacyPoints === 10;
      expect(
        sql(`BEGIN; ${actualSourceApprovalFixture(false, legacyPoints)} ${actualSelectionFixtureSql()}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture; ${applicationInsertSql()}
      ${attemptInsertSql()}
      ${comparisonInsertSql({ legacyPoints, classificationCode: equal ? 'equal' : 'points_mismatch' })}
      INSERT INTO "ContributionShadowTerminalReceipt"
        (id,"attemptId","statusCode","expectedRecordCount","writtenRecordCount","equalCount","mismatchCount","holdCount","errorCount")
        VALUES ('ref-terminal','ref-attempt','complete',1,1,${equal ? 1 : 0},${equal ? 0 : 1},0,0);
      RESET SESSION AUTHORIZATION;
      SET CONSTRAINTS ALL IMMEDIATE;
      SELECT "classificationCode" FROM "ContributionShadowComparisonReceipt" WHERE id='ref-comparison'; ROLLBACK;`),
      ).toBe(equal ? 'equal' : 'points_mismatch');
    },
  );

  it.each<Record<string, string | number>>([
    { policyPoints: '2.00', classificationCode: 'equal' },
    { legacyPoints: '10.00', classificationCode: 'equal' },
    { legacyServiceHours: '2.00' },
    { durationSeconds: 3599 },
    { legacyRuleId: 'other-rule' },
    { classificationCode: 'equal' },
  ])(
    'rejects forged comparison values despite valid 64-character auxiliary hashes: %p',
    (change) => {
      expect(() =>
        sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture; ${applicationInsertSql()}
      ${attemptInsertSql()} ${comparisonInsertSql(change)} ROLLBACK;`),
      ).toThrow('shadow comparison differs from immutable application proof');
    },
  );

  it('keeps comparable denied when only a source anchor and matching policy IDs exist without an application', () => {
    expect(() =>
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      ${attemptInsertSql()} ${comparisonInsertSql()} ROLLBACK;`),
    ).toThrow('shadow comparison requires immutable legacy-source proof');
  });

  it.each([1, 10, 500, 2000])(
    'set guards independently validate %i distinct stored durations with one policy fingerprint',
    (size) => {
      expect(
        sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()} ${setSourceFixtureSql(size)}
      SET CONSTRAINTS ALL IMMEDIATE;
      SET LOCAL track_functions='all';
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      DO $calls$
      DECLARE before_policy BIGINT; before_selection BIGINT; after_policy BIGINT; after_selection BIGINT;
      BEGIN
        SELECT coalesce(sum(calls),0) INTO before_policy FROM pg_stat_xact_user_functions WHERE schemaname='public' AND funcname='csm_policy_fingerprint_fn';
        SELECT coalesce(sum(calls),0) INTO before_selection FROM pg_stat_xact_user_functions WHERE schemaname='public' AND funcname='csm_selection_hash_fn';
        ${setApplicationInsertSql(1, size)}
        SELECT coalesce(sum(calls),0) INTO after_policy FROM pg_stat_xact_user_functions WHERE schemaname='public' AND funcname='csm_policy_fingerprint_fn';
        SELECT coalesce(sum(calls),0) INTO after_selection FROM pg_stat_xact_user_functions WHERE schemaname='public' AND funcname='csm_selection_hash_fn';
        IF after_policy-before_policy<>1 OR after_selection-before_selection<>1 THEN
          RAISE EXCEPTION 'policy or selection was not validated exactly once for this actual group';
        END IF;
      END $calls$;
      ${setAttemptSql(size)} ${setComparisonInsertSql(1, size)}
      RESET SESSION AUTHORIZATION;
      SELECT (SELECT count(*) FROM "ContributionShadowMappingApplication" WHERE "auditLogId"='set-audit')::TEXT||':'||
        (SELECT count(DISTINCT "durationSeconds") FROM "ContributionShadowMappingApplication" WHERE "auditLogId"='set-audit')::TEXT||':'||
        (SELECT count(*) FROM "ContributionShadowComparisonReceipt" WHERE "attemptId"='set-attempt')::TEXT;
      ROLLBACK;`),
      ).toBe(`${size}:${size}:${size}`);
    },
  );

  it.each(['set-record-0001', 'set-record-0002', 'set-record-0003'])(
    'set guards reject an entire application/comparison batch with a bad row at %s',
    (badRecord) => {
      expect(
        sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()} ${setSourceFixtureSql(3)}
        SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
        ${setAttemptSql(3)}
        DO $atomic$
        BEGIN
          BEGIN
            ${setApplicationInsertSql(1, 3, badRecord)}
            RAISE EXCEPTION 'bad application batch accepted';
          EXCEPTION WHEN check_violation THEN
            IF SQLERRM <> 'shadow mapping application differs from database proof' THEN RAISE; END IF;
          END;
          IF EXISTS (SELECT 1 FROM "ContributionShadowMappingApplication" WHERE "auditLogId"='set-audit') THEN
            RAISE EXCEPTION 'bad application batch left partial rows';
          END IF;
        END $atomic$;
        ${setApplicationInsertSql(1, 1)} ${setApplicationInsertSql(2, 3)}
        DO $atomic$
        BEGIN
          BEGIN
            ${setComparisonInsertSql(1, 3, badRecord)}
            RAISE EXCEPTION 'bad comparison batch accepted';
          EXCEPTION WHEN check_violation THEN
            IF SQLERRM <> 'shadow comparison differs from immutable application proof' THEN RAISE; END IF;
          END;
          IF EXISTS (SELECT 1 FROM "ContributionShadowComparisonReceipt" WHERE "attemptId"='set-attempt') THEN
            RAISE EXCEPTION 'bad comparison batch left partial rows';
          END IF;
        END $atomic$;
        ${setComparisonInsertSql(1, 1)} ${setComparisonInsertSql(2, 3)}
        SELECT (SELECT count(*) FROM "ContributionShadowComparisonReceipt" WHERE "attemptId"='set-attempt')::TEXT||':'||
          (SELECT count(*) FROM "ContributionShadowAttemptReceipt" WHERE id='set-attempt')::TEXT||':'||
          (SELECT count(*) FROM "ContributionShadowTerminalReceipt" WHERE "attemptId"='set-attempt')::TEXT;
        RESET SESSION AUTHORIZATION; SET CONSTRAINTS ALL IMMEDIATE; ROLLBACK;`),
      ).toBe('3:1:0');
    },
  );

  it.each(['valid', 'source', 'application', 'comparison'] as const)(
    'actual COPY executes all three set guards and rejects forged %s content',
    (variant) => {
      const digest = hashLegacySource({
        windowId: 'ref-window',
        auditLogId: 'set-audit',
        sheetId: 'set-sheet',
        sheetVersion: 1,
        activityId: 'ref-activity',
        recordId: 'set-record-0001',
        memberId: 'ref-member',
        activityTypeCode: 'service',
        attendanceRoleCode: 'volunteer',
        legacyServiceHours: new Prisma.Decimal('0.01'),
        legacyPoints: new Prisma.Decimal('2.00'),
        source: {
          sourceKindCode: 'matched',
          legacyRuleId: 'ref-rule',
          durationThreshold: null,
          pointsBelow: new Prisma.Decimal('2.00'),
          pointsAbove: null,
        },
      });
      const hash = registrationReferencesFixture().manifest.approvals[0].policyDefinitionHash;
      const statement = `BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()} ${setSourceFixtureSql(1, false)}
        COPY "ContributionShadowLegacySourceAnchor" (id,"windowId","auditLogId","sheetId","sheetVersion","activityId",
          "recordId","memberId","activityTypeCode","attendanceRoleCode","legacyServiceHours","sourceKindCode",
          "legacyRuleId","pointsBelow","legacyPoints","hashAlgorithmCode","canonicalVersion","legacySourceHash") FROM STDIN WITH (FORMAT csv);
set-copy-source,ref-window,set-audit,set-sheet,1,ref-activity,set-record-0001,ref-member,service,volunteer,0.01,matched,ref-rule,2.00,2.00,sha256,1,${variant === 'source' ? 'a'.repeat(64) : digest}
\\.
        SET CONSTRAINTS ALL IMMEDIATE;
        SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
        COPY "ContributionShadowMappingApplication" (id,"approvalId","legacySourceAnchorId","windowId","auditLogId",
          "sheetId","sheetVersion","recordId","memberId","activityId","selectionItemId","policyVersionId",
          "policyDefinitionHash","evaluatorVersion","durationSeconds","policyPoints","explanationCode") FROM STDIN WITH (FORMAT csv);
set-copy-application,ref-approval,set-copy-source,ref-window,set-audit,set-sheet,1,set-record-0001,ref-member,ref-activity,ref-selection-position,ref-version,${hash},1,36,${variant === 'application' ? '9.99' : '1.25'},short
\\.
        ${setAttemptSql(1)}
        COPY "ContributionShadowComparisonReceipt" (id,"attemptId","recordId","sheetId","memberId","activityId",
          "classificationCode",comparable,"factHash","legacyRuleId","legacySourceHash","policySourceHash",
          "selectionRevisionId","selectionItemId","policyId","policyVersionId","definitionHash","evaluatorVersion",
          "legacyServiceHours","durationSeconds","legacyPoints","policyPoints","hashAlgorithmCode","canonicalVersion") FROM STDIN WITH (FORMAT csv);
set-copy-comparison,set-attempt,set-record-0001,set-sheet,ref-member,ref-activity,points_mismatch,true,${'a'.repeat(64)},ref-rule,${digest},${'b'.repeat(64)},ref-selection,ref-selection-position,ref-policy,ref-version,${hash},1,0.01,36,2.00,${variant === 'comparison' ? '9.99' : '1.25'},sha256,1
\\.
        RESET SESSION AUTHORIZATION; SET CONSTRAINTS ALL IMMEDIATE;
        SELECT count(*) FROM "ContributionShadowComparisonReceipt" WHERE id='set-copy-comparison'; ROLLBACK;`;
      if (variant === 'valid') expect(sql(statement)).toBe('1');
      else
        expect(() => sql(statement)).toThrow(
          variant === 'source'
            ? 'shadow source digest mismatch'
            : variant === 'application'
              ? 'shadow mapping application differs from database proof'
              : 'shadow comparison differs from immutable application proof',
        );
      expect(
        sql(
          `SELECT count(*) FROM "ContributionShadowLegacySourceAnchor" WHERE "auditLogId"='set-audit'`,
        ),
      ).toBe('0');
    },
  );

  it('set guards enforce RETURNING, multi-write CTEs, empty INSERT and conflict-skip boundaries', () => {
    const app = (from: number, through: number, bad = '') =>
      setApplicationInsertSql(from, through, bad).trim().replace(/;$/, '');
    const comparison = (from: number, through: number, bad = '') =>
      setComparisonInsertSql(from, through, bad).trim().replace(/;$/, '');
    expect(
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()} ${setSourceFixtureSql(3)}
      INSERT INTO "ContributionShadowLegacySourceAnchor" SELECT * FROM "ContributionShadowLegacySourceAnchor" WHERE FALSE;
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      INSERT INTO "ContributionShadowMappingApplication" SELECT * FROM "ContributionShadowMappingApplication" WHERE FALSE;
      INSERT INTO "ContributionShadowComparisonReceipt" SELECT * FROM "ContributionShadowComparisonReceipt" WHERE FALSE;
      DO $variants$
      DECLARE wrote BIGINT;
      BEGIN
        BEGIN
          WITH inserted AS (${app(1, 3, 'set-record-0002')} RETURNING id) SELECT count(*) INTO wrote FROM inserted;
          RAISE EXCEPTION 'invalid RETURNING application accepted';
        EXCEPTION WHEN check_violation THEN
          IF SQLERRM <> 'shadow mapping application differs from database proof' THEN RAISE; END IF;
        END;
        IF EXISTS (SELECT 1 FROM "ContributionShadowMappingApplication" WHERE "auditLogId"='set-audit') THEN
          RAISE EXCEPTION 'failed RETURNING statement left application rows';
        END IF;
        ${app(1, 1)};
        -- A skipped, forged value is not inserted evidence; its basic chain and
        -- identity still pass BEFORE. New invalid rows must roll back the batch.
        ${app(1, 1, 'set-record-0001')} ON CONFLICT DO NOTHING;
        BEGIN
          ${app(1, 3, 'set-record-0002')} ON CONFLICT DO NOTHING;
          RAISE EXCEPTION 'mixed skipped/new bad application accepted';
        EXCEPTION WHEN check_violation THEN
          IF SQLERRM <> 'shadow mapping application differs from database proof' THEN RAISE; END IF;
        END;
        IF (SELECT count(*) FROM "ContributionShadowMappingApplication" WHERE "auditLogId"='set-audit')<>1 THEN
          RAISE EXCEPTION 'mixed conflict failure left partial applications';
        END IF;
        ${app(2, 3)};
        ${setAttemptSql(3)}
        WITH left_rows AS (${comparison(1, 1)} RETURNING id),
          right_rows AS (${comparison(2, 3)} RETURNING id)
          SELECT (SELECT count(*) FROM left_rows)+(SELECT count(*) FROM right_rows) INTO wrote;
        IF wrote<>3 THEN RAISE EXCEPTION 'multi-write CTE lost comparisons'; END IF;
        BEGIN
          ${comparison(1, 1)} ON CONFLICT DO NOTHING;
          RAISE EXCEPTION 'full conflict bypassed the retained BEFORE bound';
        EXCEPTION WHEN check_violation THEN
          IF SQLERRM <> 'shadow comparison exceeds expected set' THEN RAISE; END IF;
        END;
      END $variants$;
      RESET SESSION AUTHORIZATION; SET CONSTRAINTS ALL IMMEDIATE;
      SELECT count(*) FROM "ContributionShadowComparisonReceipt" WHERE "attemptId"='set-attempt'; ROLLBACK;`),
    ).toBe('3');
  });

  it('set guards use actual transition relations despite same-name temporary tables and caller settings', () => {
    expect(() =>
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      CREATE TEMP TABLE csmap_inserted_rows(id TEXT);
      CREATE TEMP TABLE cscr_inserted_rows(id TEXT);
      SET LOCAL srvf.shadow_verified='true';
      SET LOCAL search_path=pg_temp,public;
      ${applicationInsertSql({ policyPoints: '9.99' })} ROLLBACK;`),
    ).toThrow('shadow mapping application differs from database proof');
  });

  it('validates two actual audit/policy/revision groups even when policy hashes are identical', () => {
    const first = applicationInsertSql().trim().replace(/;$/, '');
    const second = secondMappingGroupSql(applicationInsertSql());
    const values = second.slice(second.indexOf('VALUES (') + 'VALUES '.length);
    expect(
      sql(`BEGIN; ${twoActualMappingGroupsSql()}
      SET CONSTRAINTS ALL IMMEDIATE; SET LOCAL track_functions='all';
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      DO $groups$
      DECLARE before_policy BIGINT; before_selection BIGINT; after_policy BIGINT; after_selection BIGINT;
      BEGIN
        SELECT coalesce(sum(calls),0) INTO before_policy FROM pg_stat_xact_user_functions WHERE schemaname='public' AND funcname='csm_policy_fingerprint_fn';
        SELECT coalesce(sum(calls),0) INTO before_selection FROM pg_stat_xact_user_functions WHERE schemaname='public' AND funcname='csm_selection_hash_fn';
        ${first},${values}
        SELECT coalesce(sum(calls),0) INTO after_policy FROM pg_stat_xact_user_functions WHERE schemaname='public' AND funcname='csm_policy_fingerprint_fn';
        SELECT coalesce(sum(calls),0) INTO after_selection FROM pg_stat_xact_user_functions WHERE schemaname='public' AND funcname='csm_selection_hash_fn';
        IF after_policy-before_policy<>2 OR after_selection-before_selection<>2 THEN
          RAISE EXCEPTION 'distinct actual versions or revisions collapsed by hash';
        END IF;
      END $groups$;
      ${attemptInsertSql()} ${secondMappingGroupSql(attemptInsertSql())}
      ${comparisonInsertSql()} ${secondMappingGroupSql(comparisonInsertSql())}
      RESET SESSION AUTHORIZATION; SET CONSTRAINTS ALL IMMEDIATE;
      SELECT count(DISTINCT "policyVersionId")::TEXT||':'||count(DISTINCT "policyDefinitionHash")::TEXT
        FROM "ContributionShadowMappingApplication"; ROLLBACK;`),
    ).toBe('2:1');
  });

  it.each(
    ['member', '队员😀'].flatMap((role) =>
      ['volunteer_service', 'training', 'organization', 'non_creditable'].map((category) => [
        role,
        category,
      ]),
    ),
  )('actual set evaluation preserves complete role/category rules: %s / %s', (role, category) => {
    const definition = {
      ...policyFixture(),
      roleRules: ['member', '队员😀'].map((attendanceRoleCode, roleIndex) => ({
        attendanceRoleCode,
        categoryRules: ['volunteer_service', 'training', 'organization', 'non_creditable'].map(
          (timeCategoryCode, categoryIndex) => ({
            timeCategoryCode,
            durationBands: policyFixture().roleRules[0].categoryRules[0].durationBands.map(
              (band, bandIndex) => ({
                ...band,
                recognizedPoints: `${roleIndex * 20 + categoryIndex * 4 + bandIndex}.00`,
              }),
            ),
          }),
        ),
      })),
    };
    const policy = fingerprintContributionPolicyVersion({
      schemaVersion: 1,
      evaluatorVersion: 1,
      definition,
      effectiveFrom: '2099-01-01T00:00:00.000Z',
      effectiveUntil: null,
    });
    const expected = evaluateContributionPolicy(policy.definition, {
      attendanceRoleCode: role,
      timeCategoryCode: category,
      durationSeconds: 3600,
    });
    expect(
      JSON.parse(
        sql(`BEGIN;
      ${actualSourceApprovalFixture(false, 2, definition, role, category)}
      ${actualSelectionFixtureSql(undefined, 1, 'ref', definition)}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      ${applicationInsertSql({
        policyDefinitionHash: policy.definitionHash,
        policyPoints: expected.recognizedPoints,
        explanationCode: expected.explanationCode,
      })}
      SELECT jsonb_build_object('recognizedPoints',"policyPoints"::TEXT,'explanationCode',"explanationCode")
        FROM "ContributionShadowMappingApplication" WHERE id='ref-application';
      RESET SESSION AUTHORIZATION; SET CONSTRAINTS ALL IMMEDIATE; ROLLBACK;`),
      ),
    ).toEqual(expected);
  });

  it.each(['position', 'activity', 'both'] as const)(
    'actual set selection preserves %s scope and override priority',
    (scope) => {
      const item = scope === 'activity' ? 'ref-selection-root' : 'ref-selection-position';
      expect(
        sql(`BEGIN; ${actualSourceApprovalFixture()}
      ${actualSelectionFixtureSql(undefined, 1, 'ref', policyFixture(), scope)}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      ${applicationInsertSql({ selectionItemId: item })}
      SELECT "selectionItemId" FROM "ContributionShadowMappingApplication";
      RESET SESSION AUTHORIZATION; SET CONSTRAINTS ALL IMMEDIATE; ROLLBACK;`),
      ).toBe(item);
      if (scope === 'both') {
        expect(() =>
          sql(`BEGIN; ${actualSourceApprovalFixture()}
        ${actualSelectionFixtureSql(undefined, 1, 'ref', policyFixture(), scope)}
        SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
        ${applicationInsertSql({ selectionItemId: 'ref-selection-root' })} ROLLBACK;`),
        ).toThrow('shadow mapping immutable selection mismatch');
      }
    },
  );

  it('chooses a qualification error before an earlier-ID selection error across actual groups', () => {
    const first = applicationInsertSql().trim().replace(/;$/, '');
    const second = secondMappingGroupSql(applicationInsertSql());
    const values = second.slice(second.indexOf('VALUES (') + 'VALUES '.length);
    expect(() =>
      sql(`BEGIN;
      ${twoActualMappingGroupsSql().replaceAll('2099-09-01T00:00:00.000Z', '2099-11-01T00:00:00.000Z')}
      UPDATE "ActivitySessionPosition" SET "deletedAt"=CURRENT_TIMESTAMP WHERE id='second-position';
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      ${first},${values} ROLLBACK;`),
    ).toThrow('shadow mapping actual position unavailable');
    expect(sql('SELECT count(*) FROM "ContributionShadowMappingApplication"')).toBe('0');
  });

  it.each(['set-record-0001', 'set-record-0002', 'set-record-0003'])(
    'source set failure at %s rolls back the complete batch and allows valid split writes',
    (badRecord) => {
      const full = setSourceFixtureSql(3);
      const insert = full.slice(
        full.lastIndexOf('INSERT INTO "ContributionShadowLegacySourceAnchor"'),
      );
      const bad = insert.replace(
        "'legacySourceHash',cslsa_source_hash_fn(s)",
        `'legacySourceHash',CASE WHEN (s)."recordId"='${badRecord}' THEN repeat('a',64) ELSE cslsa_source_hash_fn(s) END`,
      );
      expect(bad).not.toBe(insert);
      expect(
        sql(`BEGIN; ${actualSourceApprovalFixture()} ${setSourceFixtureSql(3, false)}
        DO $source_batch$ BEGIN
          BEGIN ${bad} RAISE EXCEPTION 'bad source batch accepted';
          EXCEPTION WHEN check_violation THEN
            IF SQLERRM <> 'shadow source digest mismatch' THEN RAISE; END IF;
          END;
          IF EXISTS(SELECT 1 FROM "ContributionShadowLegacySourceAnchor" WHERE "auditLogId"='set-audit') THEN
            RAISE EXCEPTION 'failed source batch left partial rows'; END IF;
        END $source_batch$;
        ${insert.replace(') rows;', ') rows WHERE (s)."recordId"=\'set-record-0001\';')}
        ${insert.replace(') rows;', ') rows WHERE (s)."recordId"<>\'set-record-0001\';')}
        SET CONSTRAINTS ALL IMMEDIATE;
        SELECT count(*) FROM "ContributionShadowLegacySourceAnchor" WHERE "auditLogId"='set-audit'; ROLLBACK;`),
      ).toBe('3');
    },
  );

  it('runtime cannot turn a conflicting INSERT into an immutable application UPDATE', () => {
    const conflict =
      applicationInsertSql().trim().replace(/;$/, '') +
      ' ON CONFLICT (id) DO UPDATE SET "policyPoints"=EXCLUDED."policyPoints";';
    expect(() =>
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      ${applicationInsertSql()} ${conflict} ROLLBACK;`),
    ).toThrow('permission denied for table ContributionShadowMappingApplication');
    expect(sql('SELECT count(*) FROM "ContributionShadowMappingApplication"')).toBe('0');
  });

  it.each(['revoke', 'replace'].flatMap((kind) => [false, true].map((later) => ({ kind, later }))))(
    'rechecks actual %p successor qualification between valid application batches',
    ({ kind, later }) => {
      const { manifest } = registrationReferencesFixture();
      manifest.commandKey = `successor-${kind}-${later}`;
      Object.assign(manifest.approvals[0], {
        approvalNumber: 'successor-number',
        eventKindCode: kind,
        previousApprovalId: 'ref-approval',
        effectiveFrom: later ? '2099-10-02T00:00:00.000Z' : '2099-10-01T00:00:00.000Z',
      });
      const next = setApplicationInsertSql(2, 3);
      expect(
        sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()} ${setSourceFixtureSql(3)}
        SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture; ${setApplicationInsertSql(1, 1)}
        RESET SESSION AUTHORIZATION;
        ${registrationAuthorityFixtureSql(manifest, false)}
        SET SESSION AUTHORIZATION srvf_shadow_registrar_w98_fixture;
        DO $successor$ BEGIN PERFORM csm_register_mapping_fn(
          '${JSON.stringify(manifest).replaceAll("'", "''")}'::JSONB,'ref-user','successor-receipt','successor-audit','["successor-approval"]'::JSONB);
        END $successor$;
        RESET SESSION AUTHORIZATION;
        SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
        ${
          later
            ? next
            : `DO $batch$ BEGIN BEGIN ${next}
          RAISE EXCEPTION 'superseded batch accepted';
          EXCEPTION WHEN check_violation THEN
            IF SQLERRM <> 'shadow mapping approval was superseded at source time' THEN RAISE; END IF;
          END; END $batch$;`
        }
        SELECT count(*) FROM "ContributionShadowMappingApplication" WHERE "auditLogId"='set-audit';
        RESET SESSION AUTHORIZATION; SET CONSTRAINTS ALL IMMEDIATE; ROLLBACK;`),
      ).toBe(later ? '3' : '1');
    },
  );

  it('scopes application set-guard JIT to the function and restores the caller on success and rejection', () => {
    expect(
      sql(`SELECT proconfig @> ARRAY['jit=off','search_path=pg_catalog, public, pg_temp']
        FROM pg_proc WHERE oid='csm_application_set_guard_fn()'::regprocedure`),
    ).toBe('t');
    expect(
      sql(`BEGIN; SET LOCAL jit=on;
        ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()} ${setSourceFixtureSql(3)}
        SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
        DO $rejected$ BEGIN
          BEGIN
            ${setApplicationInsertSql(1, 3, 'set-record-0002')}
            RAISE EXCEPTION 'invalid policy points accepted';
          EXCEPTION WHEN check_violation THEN
            IF SQLERRM <> 'shadow mapping application differs from database proof' THEN RAISE; END IF;
          END;
          IF current_setting('jit') <> 'on' THEN RAISE EXCEPTION 'JIT leaked after rejection'; END IF;
          IF EXISTS (SELECT 1 FROM "ContributionShadowMappingApplication" WHERE "auditLogId"='set-audit') THEN
            RAISE EXCEPTION 'rejected set left rows'; END IF;
        END $rejected$;
        ${setApplicationInsertSql(1, 3)}
        DO $accepted$ BEGIN
          IF current_setting('jit') <> 'on' THEN RAISE EXCEPTION 'JIT leaked after success'; END IF;
        END $accepted$;
        RESET SESSION AUTHORIZATION; SET CONSTRAINTS ALL IMMEDIATE;
        SELECT count(*) FROM "ContributionShadowMappingApplication" WHERE "auditLogId"='set-audit';
        ROLLBACK;`),
    ).toBe('3');
  });

  it('counts actual source/comparison JSON expansion per audit across two 500-row batches', () => {
    const before = sql(`SELECT md5(pg_get_functiondef('cslsa_insert_set_guard_fn()'::regprocedure)||
      pg_get_functiondef('cscr_insert_set_guard_fn()'::regprocedure))`);
    const full = setSourceFixtureSql(500);
    const insert = full
      .slice(full.lastIndexOf('INSERT INTO "ContributionShadowLegacySourceAnchor"'))
      .trim()
      .replace(/;$/, '');
    const comparison = setComparisonInsertSql(1, 500).trim().replace(/;$/, '');
    expect(
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      ${setSourceFixtureSql(500, false)} ${setSourceFixtureSql(500, false).replaceAll('set-', 'other-')}
      -- Isolated diagnostic only: wraps the actual expansion at its exact call
      -- site, preserving arguments and every guard. ROLLBACK restores both
      -- function definitions; budget tests never run this instrumented version.
      CREATE FUNCTION pg_temp.shadow_records_probe(value JSONB) RETURNS SETOF JSONB
        LANGUAGE plpgsql VOLATILE AS $probe$ BEGIN
          RETURN QUERY SELECT * FROM pg_catalog.jsonb_array_elements(value);
        END $probe$;
      DO $instrument$ DECLARE fn TEXT; original TEXT; changed TEXT; BEGIN
        FOREACH fn IN ARRAY ARRAY['cslsa_insert_set_guard_fn()','cscr_insert_set_guard_fn()'] LOOP
          original:=pg_get_functiondef(fn::regprocedure);
          IF (length(original)-length(replace(original,'jsonb_array_elements(','')))/length('jsonb_array_elements(')<>1 THEN
            RAISE EXCEPTION 'unexpected active expansion sites'; END IF;
          changed:=replace(original,'jsonb_array_elements(','pg_temp.shadow_records_probe(');
          EXECUTE changed;
        END LOOP;
      END $instrument$;
      SET LOCAL track_functions='all';
      DO $counts$ DECLARE baseline BIGINT; after_source BIGINT; after_comparison BIGINT; written BIGINT; BEGIN
        SELECT coalesce(sum(calls),0) INTO baseline FROM pg_stat_xact_user_functions WHERE funcid='pg_temp.shadow_records_probe(jsonb)'::regprocedure;
        WITH a AS (${insert} RETURNING id), b AS (${insert.replaceAll('set-', 'other-')} RETURNING id)
          SELECT (SELECT count(*) FROM a)+(SELECT count(*) FROM b) INTO written;
        IF written<>1000 THEN RAISE EXCEPTION 'mixed source batches lost rows'; END IF;
        SELECT coalesce(sum(calls),0) INTO after_source FROM pg_stat_xact_user_functions WHERE funcid='pg_temp.shadow_records_probe(jsonb)'::regprocedure;
        IF after_source-baseline<>2 THEN RAISE EXCEPTION 'source expansion was not per actual audit'; END IF;
        SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
        ${setApplicationInsertSql(1, 500)} ${setApplicationInsertSql(1, 500).replaceAll('set-', 'other-')}
        ${setAttemptSql(500)} ${setAttemptSql(500).replaceAll('set-', 'other-')}
        WITH a AS (${comparison} RETURNING id), b AS (${comparison.replaceAll('set-', 'other-')} RETURNING id)
          SELECT (SELECT count(*) FROM a)+(SELECT count(*) FROM b) INTO written;
        IF written<>1000 THEN RAISE EXCEPTION 'mixed comparison batches lost rows'; END IF;
        RESET SESSION AUTHORIZATION;
        SELECT coalesce(sum(calls),0) INTO after_comparison FROM pg_stat_xact_user_functions WHERE funcid='pg_temp.shadow_records_probe(jsonb)'::regprocedure;
        IF after_comparison-after_source<>2 THEN RAISE EXCEPTION 'comparison expansion was not per actual audit'; END IF;
      END $counts$;
      SET CONSTRAINTS ALL IMMEDIATE;
      SELECT count(*) FROM "ContributionShadowComparisonReceipt" WHERE "attemptId" IN ('set-attempt','other-attempt');
      ROLLBACK;`),
    ).toBe('1000');
    expect(
      sql(`SELECT md5(pg_get_functiondef('cslsa_insert_set_guard_fn()'::regprocedure)||
      pg_get_functiondef('cscr_insert_set_guard_fn()'::regprocedure))`),
    ).toBe(before);
  });

  it('retains the registration closure when explicitly made immediate before registration', () => {
    const { manifest, fixtureSql } = registrationReferencesFixture();
    const literal = JSON.stringify(manifest).replaceAll("'", "''");
    expect(() =>
      sql(`BEGIN; ${fixtureSql} ${registrationHumanFixtureSql()}
      ${registrationAuthorityFixtureSql(manifest)}
      SET CONSTRAINTS csma_receipt_closure IMMEDIATE;
      SET SESSION AUTHORIZATION srvf_shadow_registrar_w98_fixture;
      SELECT csm_register_mapping_fn('${literal}'::jsonb,'ref-user','ref-receipt','ref-register-audit','["ref-approval"]'::jsonb);
      ROLLBACK;`),
    ).toThrow('shadow mapping approval registration receipt missing');
  });

  it.each([
    [{ durationSeconds: -1 }, 'csmap_value_check'],
    [{ durationSeconds: -1, policyPoints: '9.99' }, 'csmap_value_check'],
    [{ policyPoints: '9.99' }, 'shadow mapping application differs from database proof'],
  ] as const)('records native CHECK versus set-guard rejection ordering: %p', (change, error) => {
    expect(() =>
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      ${applicationInsertSql(change)} ROLLBACK;`),
    ).toThrow(error);
  });

  it('set guards roll back invalid statements and retain immediate/deferred closure checks', () => {
    expect(
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET CONSTRAINTS ALL IMMEDIATE;
      SET CONSTRAINTS ALL DEFERRED;
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      DO $atomic$
      BEGIN
        BEGIN
          ${applicationInsertSql({ policyPoints: '9.99' })}
          RAISE EXCEPTION 'invalid application accepted';
        EXCEPTION WHEN check_violation THEN
          IF SQLERRM <> 'shadow mapping application differs from database proof' THEN RAISE; END IF;
        END;
        IF EXISTS (SELECT 1 FROM "ContributionShadowMappingApplication") THEN
          RAISE EXCEPTION 'invalid application left partial rows';
        END IF;
      END $atomic$;
      ${applicationInsertSql()} ${attemptInsertSql()}
      DO $atomic$
      BEGIN
        BEGIN
          ${comparisonInsertSql({ policyPoints: '9.99' })}
          RAISE EXCEPTION 'invalid comparison accepted';
        EXCEPTION WHEN check_violation THEN
          IF SQLERRM <> 'shadow comparison differs from immutable application proof' THEN RAISE; END IF;
        END;
        IF EXISTS (SELECT 1 FROM "ContributionShadowComparisonReceipt") THEN
          RAISE EXCEPTION 'invalid comparison left partial rows';
        END IF;
      END $atomic$;
      ${comparisonInsertSql()}
      RESET SESSION AUTHORIZATION; SET CONSTRAINTS ALL IMMEDIATE;
      SELECT (SELECT count(*) FROM "ContributionShadowMappingApplication")::TEXT || ':' ||
        (SELECT count(*) FROM "ContributionShadowComparisonReceipt")::TEXT;
      ROLLBACK;`),
    ).toBe('1:1');
  });

  it('retains the original comparison set bound after a legitimate comparison', () => {
    expect(() =>
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture; ${applicationInsertSql()}
      ${attemptInsertSql()} ${comparisonInsertSql()}
      ${comparisonInsertSql({ id: 'ref-extra' })} ROLLBACK;`),
    ).toThrow('shadow comparison exceeds expected set');
  });

  it('runtime appends a full evidence chain without old attendance writes or raw audit reads', () => {
    expect(
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      ${applicationInsertSql()} ${attemptInsertSql()} ${comparisonInsertSql()}
      INSERT INTO "ContributionShadowTerminalReceipt"
        (id,"attemptId","statusCode","expectedRecordCount","writtenRecordCount","equalCount","mismatchCount","holdCount","errorCount")
        VALUES ('ref-terminal','ref-attempt','complete',1,1,0,1,0,0);
      SELECT has_table_privilege(CURRENT_USER,'public."AttendanceSheet"','INSERT,UPDATE,DELETE')
        OR has_table_privilege(CURRENT_USER,'public."AttendanceRecord"','INSERT,UPDATE,DELETE')
        OR has_table_privilege(CURRENT_USER,'public.audit_logs','SELECT,INSERT,UPDATE,DELETE');
      SELECT count(*) FROM "ContributionShadowTerminalReceipt" WHERE "attemptId"='ref-attempt';
      RESET SESSION AUTHORIZATION; SET CONSTRAINTS ALL IMMEDIATE; ROLLBACK;`),
    ).toBe('f\n1');
  });

  it('generates application proof time in the database, never as an INSERT timestamp parameter', async () => {
    const field = Prisma.dmmf.datamodel.models
      .find((model) => model.name === 'ContributionShadowMappingApplication')
      ?.fields.find((item) => item.name === 'createdAt');
    expect(field?.default).toEqual({ name: 'dbgenerated', args: ['CURRENT_TIMESTAMP'] });
    const client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
    const inserts: string[] = [];
    client.$on('query', (event) => {
      if (event.query.startsWith('INSERT INTO "public"."ContributionShadowMappingApplication"'))
        inserts.push(event.query);
    });
    const rollback = new Error('rollback database clock fixture');
    const { manifest } = registrationReferencesFixture();
    try {
      await expect(
        client.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`DO $database_clock_fixture$ BEGIN
            ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
          END $database_clock_fixture$;`);
          await tx.$executeRawUnsafe(
            fixtureStatement('SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture'),
          );
          await tx.contributionShadowMappingApplication.createMany({
            data: [
              {
                id: 'ref-database-clock-application',
                approvalId: 'ref-approval',
                legacySourceAnchorId: 'ref-source',
                windowId: 'ref-window',
                auditLogId: 'ref-source-audit',
                sheetId: 'ref-sheet',
                sheetVersion: 1,
                recordId: 'ref-record',
                memberId: 'ref-member',
                activityId: 'ref-activity',
                selectionItemId: 'ref-selection-position',
                policyVersionId: 'ref-version',
                policyDefinitionHash: manifest.approvals[0].policyDefinitionHash,
                evaluatorVersion: 1,
                durationSeconds: 3600,
                policyPoints: '10.00',
                explanationCode: 'hour',
              },
            ],
          });
          const times = await tx.$queryRaw<Array<{ databaseClock: boolean }>>`
            SELECT "createdAt" = transaction_timestamp()::TIMESTAMPTZ(3) AS "databaseClock"
            FROM "ContributionShadowMappingApplication" WHERE id = 'ref-database-clock-application'
          `;
          expect(times).toEqual([{ databaseClock: true }]);
          expect(inserts).toHaveLength(1);
          expect(inserts[0]).not.toContain('"createdAt"');
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    } finally {
      await client.$disconnect();
    }
    expect(sql('SELECT count(*) FROM "ContributionShadowMappingApplication"')).toBe('0');
  });

  it.each([false, true])(
    'executes the real Prisma batch writer under the isolated session identity (forged=%s)',
    async (forged) => {
      const client = new PrismaClient();
      const rollback = new Error('rollback-only runtime writer fixture');
      const { manifest } = registrationReferencesFixture();
      const application: ShadowMappingApplicationInput = {
        approvalId: 'ref-approval',
        legacySourceAnchorId: 'ref-source',
        windowId: 'ref-window',
        auditLogId: 'ref-source-audit',
        sheetId: 'ref-sheet',
        sheetVersion: 1,
        recordId: 'ref-record',
        memberId: 'ref-member',
        activityId: 'ref-activity',
        selectionItemId: 'ref-selection-position',
        policyVersionId: 'ref-version',
        policyDefinitionHash: manifest.approvals[0].policyDefinitionHash,
        evaluatorVersion: 1,
        durationSeconds: 3600,
        policyPoints: '10.00',
        explanationCode: 'hour',
      };
      try {
        const operation = client.$transaction(
          async (tx) => {
            // A single trusted, static DO statement keeps fixture DDL and all three
            // NOLOGIN roles rollback-only. This is not a real LOGIN acceptance test.
            await tx.$executeRawUnsafe(`DO $runtime_writer_fixture$ BEGIN
          ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
          END $runtime_writer_fixture$;`);
            await tx.$executeRawUnsafe(
              fixtureStatement('SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture'),
            );
            const source = await tx.contributionShadowLegacySourceAnchor.findUniqueOrThrow({
              where: { id: 'ref-source' },
            });
            await tx.$executeRawUnsafe(attemptInsertSql());
            const comparison: ShadowComparisonInput = {
              recordId: 'ref-record',
              sheetId: 'ref-sheet',
              memberId: 'ref-member',
              activityId: 'ref-activity',
              classificationCode: forged ? 'equal' : 'points_mismatch',
              comparable: true,
              factHash: 'a'.repeat(64),
              legacySourceHash: source.legacySourceHash,
              policySourceHash: 'b'.repeat(64),
              legacyRuleId: 'ref-rule',
              selectionRevisionId: 'ref-selection',
              selectionItemId: 'ref-selection-position',
              policyVersionId: 'ref-version',
              policyId: 'ref-policy',
              definitionHash: application.policyDefinitionHash,
              evaluatorVersion: 1,
              legacyServiceHours: '1.00',
              durationSeconds: 3600,
              legacyPoints: '2.00',
              policyPoints: forged ? '2.00' : '10.00',
              failureCode: null,
              hashAlgorithmCode: 'sha256',
              canonicalVersion: 1,
            };
            const terminal =
              await new ContributionShadowEvidenceWriteService().writeCompleteComparisonSet(
                tx,
                {
                  id: 'ref-attempt',
                  windowId: 'ref-window',
                  auditLogId: 'ref-source-audit',
                  sheetId: 'ref-sheet',
                  sheetVersion: 1,
                  activityId: 'ref-activity',
                  expectedRecordCount: 1,
                },
                [application],
                [comparison],
              );
            expect(terminal).toMatchObject({
              statusCode: 'complete',
              writtenRecordCount: 1,
              equalCount: 0,
              mismatchCount: 1,
            });
            await tx.$executeRawUnsafe('RESET SESSION AUTHORIZATION');
            await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
            throw rollback;
          },
          { timeout: 5000 },
        );
        if (forged)
          await expect(operation).rejects.toThrow(
            'shadow comparison differs from immutable application proof',
          );
        else await expect(operation).rejects.toBe(rollback);
      } finally {
        await client.$disconnect();
      }
      expect(
        sql(`SELECT count(*) FROM "ContributionShadowMappingApplication";
      SELECT count(*) FROM "ContributionShadowComparisonReceipt";
      SELECT count(*) FROM "ContributionShadowTerminalReceipt";
      SELECT count(*) FROM pg_roles WHERE rolname IN ('srvf_shadow_owner_w98_fixture',
        'srvf_shadow_registrar_w98_fixture','srvf_shadow_runtime_w98_fixture');`),
      ).toBe('0\n0\n0\n0');
    },
  );

  it('trusted owner cannot impersonate runtime for comparable evidence after a real application exists', () => {
    expect(() =>
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture; ${applicationInsertSql()}
      RESET SESSION AUTHORIZATION; ${attemptInsertSql()} ${comparisonInsertSql()} ROLLBACK;`),
    ).toThrow('shadow mapping proof runtime is not yet verified');
  });

  it('registrar has no direct comparison receipt INSERT authority', () => {
    expect(() =>
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      ${applicationInsertSql()} ${attemptInsertSql()}
      RESET SESSION AUTHORIZATION; SET SESSION AUTHORIZATION srvf_shadow_registrar_w98_fixture;
      ${comparisonInsertSql()} ROLLBACK;`),
    ).toThrow('permission denied for table ContributionShadowComparisonReceipt');
  });

  it('retains exact terminal bucket checks through the nonowner runtime', () => {
    expect(() =>
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      ${applicationInsertSql()} ${attemptInsertSql()} ${comparisonInsertSql()}
      INSERT INTO "ContributionShadowTerminalReceipt"
        (id,"attemptId","statusCode","expectedRecordCount","writtenRecordCount","equalCount","mismatchCount","holdCount","errorCount")
        VALUES ('ref-terminal','ref-attempt','complete',1,1,1,0,0,0); ROLLBACK;`),
    ).toThrow('shadow terminal buckets mismatch');
  });

  it('retains comparison-after-terminal rejection through the nonowner runtime', () => {
    expect(() =>
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      ${applicationInsertSql()} ${attemptInsertSql()} ${comparisonInsertSql()}
      INSERT INTO "ContributionShadowTerminalReceipt"
        (id,"attemptId","statusCode","expectedRecordCount","writtenRecordCount","equalCount","mismatchCount","holdCount","errorCount")
        VALUES ('ref-terminal','ref-attempt','complete',1,1,0,1,0,0);
      ${comparisonInsertSql({ id: 'ref-late' })} ROLLBACK;`),
    ).toThrow('shadow comparison after terminal');
  });

  it('wires both actual set guards to isolated volatile NOLOGIN functions without direct EXECUTE', () => {
    expect(
      sql(`BEGIN; ${actualSourceApprovalFixture()}
      SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
      JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND
        ((t.tgname='csmap_insert_set_guard' AND p.proname='csm_application_set_guard_fn'
          AND t.tgrelid='public."ContributionShadowMappingApplication"'::regclass
          AND t.tgnewtable='csmap_inserted_rows') OR
         (t.tgname='cscr_insert_set_guard' AND p.proname='cscr_insert_set_guard_fn'
          AND t.tgrelid='public."ContributionShadowComparisonReceipt"'::regclass
          AND t.tgnewtable='cscr_inserted_rows'))
        AND t.tgtype=4 AND t.tgenabled='O' AND NOT t.tgdeferrable
        AND pg_get_userbyid(p.proowner)='srvf_shadow_owner_w98_fixture'
        AND NOT (SELECT rolcanlogin FROM pg_roles WHERE oid=p.proowner)
        AND p.prosecdef AND p.provolatile='v'
        AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']
        AND NOT has_function_privilege('srvf_shadow_runtime_w98_fixture',p.oid,'EXECUTE')
        AND NOT has_function_privilege('srvf_shadow_registrar_w98_fixture',p.oid,'EXECUTE');
      ROLLBACK;`),
    ).toBe('2');
  });

  it('owns protected trigger functions only with NOLOGIN owner, fixed search path and zero runtime direct EXECUTE', () => {
    expect(
      sql(`BEGIN; ${actualSourceApprovalFixture()}
      SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN ('csm_assert_runtime_fn','csm_application_insert_guard_fn',
        'csar_insert_guard_fn','cscr_insert_guard_fn','cstr_insert_guard_fn')
        AND pg_get_userbyid(p.proowner)='srvf_shadow_owner_w98_fixture' AND p.prosecdef
        AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']
        AND NOT has_function_privilege('srvf_shadow_runtime_w98_fixture',p.oid,'EXECUTE');
      ROLLBACK;`),
    ).toBe('5');
  });

  it.each<Record<string, string | number>>([
    { durationSeconds: 3601 },
    { policyPoints: '9.99' },
    { explanationCode: 'forged' },
    { memberId: 'forged-member' },
    { sheetVersion: 2 },
    { auditLogId: 'ref-register-audit' },
    { policyDefinitionHash: 'b'.repeat(64) },
    { evaluatorVersion: 2 },
    { createdAt: '2000-01-01T00:00:00Z' },
    { createdAt: '2099-01-01T00:00:00Z' },
  ])(
    'rejects directly forged application content using independently recomputed SQL proof: %p',
    (change) => {
      expect(() =>
        sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      ${applicationInsertSql(change)} ROLLBACK;`),
      ).toThrow('shadow mapping application differs from database proof');
    },
  );

  it.each(['ref-selection-root', 'missing-selection'])(
    'does not guess a pointer from missing or inherited selection %s',
    (item) => {
      expect(() =>
        sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      ${applicationInsertSql({ selectionItemId: item })} ROLLBACK;`),
      ).toThrow('shadow mapping immutable selection mismatch');
    },
  );

  it('rejects a selection revision created after the old source instant', () => {
    expect(() =>
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql('2099-11-01T00:00:00.000Z')}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      ${applicationInsertSql()} ROLLBACK;`),
    ).toThrow('shadow mapping immutable selection mismatch');
  });

  it('rejects a stale selection superseded before the exact old source instant', () => {
    expect(() =>
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
      ${actualSelectionFixtureSql('2099-09-15T00:00:00.000Z', 2)}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      ${applicationInsertSql()} ROLLBACK;`),
    ).toThrow('shadow mapping immutable selection mismatch');
  });

  it('records a failed terminal under the append-only runtime identity without fabricating comparisons or overwriting replay', async () => {
    const client = new PrismaClient();
    const rollback = new Error('rollback failed terminal fixture');
    try {
      await expect(
        client.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`DO $failed_terminal_fixture$ BEGIN
          ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
        END $failed_terminal_fixture$;`);
          const source = await tx.contributionShadowLegacySourceAnchor.findUniqueOrThrow({
            where: { id: 'ref-source' },
          });
          const input = prepareShadowAttempt(
            {
              windowId: source.windowId,
              auditLogId: source.auditLogId,
              sheetId: source.sheetId,
              activityId: source.activityId,
              sheetVersion: source.sheetVersion,
              signedMappingVersion: 'fixture-v1',
            },
            [source.recordId],
            [source],
          );
          await tx.$executeRawUnsafe(
            fixtureStatement('SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture'),
          );
          const writer = new ContributionShadowEvidenceWriteService();
          const started = await writer.readOrCreateAttempt(tx, input);
          const failed = await writer.writeFailedTerminal(tx, started.attempt);
          expect(failed.replayed).toBe(false);
          expect(failed.terminal).toMatchObject({
            statusCode: 'failed',
            expectedRecordCount: 1,
            writtenRecordCount: 0,
            equalCount: 0,
            mismatchCount: 0,
            holdCount: 0,
            errorCount: 0,
            failureCode: 'shadow_comparison_failed',
          });
          const replay = await writer.writeFailedTerminal(tx, started.attempt);
          expect(replay).toEqual({ terminal: failed.terminal, replayed: true });
          const reopened = await writer.readOrCreateAttempt(tx, input);
          expect(reopened.replayed).toBe(true);
          expect(reopened.attempt.terminal).toEqual(failed.terminal);
          expect(await tx.contributionShadowComparisonReceipt.count()).toBe(0);
          expect(await tx.contributionShadowTerminalReceipt.count()).toBe(1);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    } finally {
      await client.$disconnect();
    }
    expect(
      sql(
        `SELECT count(*) FROM "ContributionShadowAttemptReceipt" WHERE "auditLogId"='ref-source-audit'`,
      ),
    ).toBe('0');
  });

  it('prepares frozen-source comparison candidates from actual rows and agrees with independent database evaluation', async () => {
    const client = new PrismaClient();
    const rollback = new Error('rollback frozen evaluation fixture');
    try {
      await expect(
        client.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`DO $frozen_evaluation_fixture$ BEGIN
          ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
        END $frozen_evaluation_fixture$;`);
          const source = await tx.contributionShadowLegacySourceAnchor.findUniqueOrThrow({
            where: { id: 'ref-source' },
          });
          const audit = await tx.auditLog.findUniqueOrThrow({
            where: { id: source.auditLogId },
            select: { createdAt: true },
          });
          const query = new ActivityContributionShadowMappingProofQuery();
          const mappingHistory = await query.readComparisonMappingHistory(tx, {
            activityId: source.activityId,
            sourceTime: audit.createdAt,
          });
          const mapping = resolveShadowMappingAtSource(mappingHistory, {
            activityId: source.activityId,
            activityTypeCode: source.activityTypeCode,
            attendanceRoleCode: source.attendanceRoleCode,
            mappingVersion: 'fixture-v1',
            sourceTime: audit.createdAt,
          });
          expect(mapping).not.toBeNull();
          const positions = await query.readComparisonPositions(tx, {
            activityId: source.activityId,
            positionIds: [mapping!.sessionPositionId],
          });
          expect(positions).toHaveLength(1);
          const selectionRevision = await query.readSelectionAtSource(tx, {
            activityId: source.activityId,
            sourceTime: audit.createdAt,
          });
          const selection = resolveShadowSelectionAtSource(
            selectionRevision,
            positions[0],
            audit.createdAt,
          );
          const versions = await query.readComparisonPolicyVersions(tx, [
            {
              id: mapping!.policyVersionId,
              definitionHash: mapping!.policyDefinitionHash,
              evaluatorVersion: mapping!.evaluatorVersion,
            },
          ]);
          expect(versions).toHaveLength(1);
          const evaluated = evaluateShadowFrozenSource({
            source,
            sourceTime: audit.createdAt,
            signedMappingVersion: 'fixture-v1',
            mapping,
            selectionItem: selection,
            policyVersion: versions[0],
          });
          expect(evaluated).toEqual({
            classification: 'points_mismatch',
            comparable: true,
            legacyPoints: '2.00',
            policyPoints: '10.00',
            policyExplanationCode: 'hour',
            durationSeconds: 3600,
          });
          const database = await tx.$queryRaw<
            Array<{ points: string; explanation: string; seconds: number }>
          >`
          SELECT proof->>'recognizedPoints' AS points, proof->>'explanationCode' AS explanation,
            (proof->>'durationSeconds')::INTEGER AS seconds
          FROM (SELECT csm_application_result_fn(${source.id}, ${mapping!.id}, ${selection!.id}) AS proof) evaluated
        `;
          expect(database).toEqual([
            {
              points: evaluated.policyPoints,
              explanation: evaluated.policyExplanationCode,
              seconds: evaluated.durationSeconds,
            },
          ]);
          const prepared = prepareShadowEvidence({
            source,
            sourceTime: audit.createdAt,
            signedMappingVersion: 'fixture-v1',
            mapping,
            selectionItem: selection,
            policyVersion: versions[0],
          });
          expect(prepared.application).not.toBeNull();
          await tx.$executeRawUnsafe(
            fixtureStatement('SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture'),
          );
          const writer = new ContributionShadowEvidenceWriteService();
          const attemptInput = prepareShadowAttempt(
            {
              windowId: 'ref-window',
              auditLogId: 'ref-source-audit',
              sheetId: 'ref-sheet',
              sheetVersion: 1,
              activityId: 'ref-activity',
              signedMappingVersion: 'fixture-v1',
            },
            ['ref-record'],
            [source],
          );
          const batch = prepareShadowComparisonSet({
            context: {
              windowId: source.windowId,
              auditLogId: source.auditLogId,
              sheetId: source.sheetId,
              activityId: source.activityId,
              sheetVersion: source.sheetVersion,
              signedMappingVersion: 'fixture-v1',
            },
            expectedRecordIds: ['ref-record'],
            sources: [source],
            sourceTime: audit.createdAt,
            mappingHistory,
            selectionRevision,
            positions,
            policyVersions: versions,
          });
          expect(batch.attempt).toEqual(attemptInput);
          expect(batch.applications).toEqual([prepared.application]);
          expect(batch.comparisons).toEqual([prepared.comparison]);
          const started = await writer.readOrCreateAttempt(tx, attemptInput);
          expect(started.replayed).toBe(false);
          expect(started.attempt.terminal).toBeNull();
          const incompleteReplay = await writer.readOrCreateAttempt(tx, attemptInput);
          expect(incompleteReplay.replayed).toBe(true);
          expect(incompleteReplay.attempt.id).toBe(started.attempt.id);
          await expect(
            writer.readOrCreateAttempt(tx, { ...attemptInput, committedFactHash: 'f'.repeat(64) }),
          ).rejects.toThrow('shadow attempt evidence mismatch');
          const terminal = await writer.writeCompleteComparisonSet(
            tx,
            started.attempt,
            batch.applications,
            batch.comparisons,
          );
          expect(terminal).toMatchObject({
            statusCode: 'complete',
            writtenRecordCount: 1,
            mismatchCount: 1,
            equalCount: 0,
            holdCount: 0,
            errorCount: 0,
          });
          const completedReplay = await writer.readOrCreateAttempt(tx, attemptInput);
          expect(completedReplay.replayed).toBe(true);
          expect(completedReplay.attempt.terminal).toEqual(terminal);
          expect(await tx.contributionShadowAttemptReceipt.count()).toBe(1);
          expect(await tx.contributionShadowComparisonReceipt.count()).toBe(1);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    } finally {
      await client.$disconnect();
    }
    expect(
      sql(`SELECT count(*) FROM "ContributionShadowLegacySourceAnchor" WHERE id='ref-source'`),
    ).toBe('0');
  });

  it('reads approved position candidates through real Prisma only within the same actual activity', async () => {
    const client = new PrismaClient();
    const rollback = new Error('rollback comparison position read fixture');
    const { fixtureSql } = registrationReferencesFixture();
    try {
      await expect(
        client.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`DO $comparison_positions_read$ BEGIN
            ${fixtureSql}
          END $comparison_positions_read$;`);
          const query = new ActivityContributionShadowMappingProofQuery();
          expect(
            await query.readComparisonPositions(tx, {
              activityId: 'ref-activity',
              positionIds: Array.from({ length: 2000 }, () => 'ref-position'),
            }),
          ).toEqual([
            {
              id: 'ref-position',
              activityId: 'ref-activity',
              sessionId: 'ref-session',
              attendanceRoleCode: 'member',
              session: { id: 'ref-session', activityId: 'ref-activity' },
            },
          ]);
          expect(
            await query.readComparisonPositions(tx, {
              activityId: 'ref-other-activity',
              positionIds: ['ref-position'],
            }),
          ).toEqual([]);
          expect(
            await query.readComparisonPositions(tx, {
              activityId: 'ref-activity',
              positionIds: ['absent-position'],
            }),
          ).toEqual([]);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    } finally {
      await client.$disconnect();
    }
    expect(sql(`SELECT count(*) FROM "ActivitySessionPosition" WHERE id='ref-position'`)).toBe('0');
  });

  it('reads exact historical selection and policy references through the real Prisma query without using the current pointer', async () => {
    const client = new PrismaClient();
    const rollback = new Error('rollback historical selection read fixture');
    const { manifest, fixtureSql } = registrationReferencesFixture();
    try {
      await expect(
        client.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`DO $historical_selection_read$ BEGIN
            ${fixtureSql}
            ${actualSelectionFixtureSql()}
            SET CONSTRAINTS ALL IMMEDIATE;
            SET CONSTRAINTS ALL DEFERRED;
            ${actualSelectionFixtureSql('2099-11-01T00:00:00.000Z', 2)}
            SET CONSTRAINTS ALL IMMEDIATE;
          END $historical_selection_read$;`);
          const query = new ActivityContributionShadowMappingProofQuery();
          const selection = await query.readSelectionAtSource(tx, {
            activityId: 'ref-activity',
            sourceTime: new Date('2099-10-01T12:00:00.000Z'),
          });
          expect(selection?.id).toBe('ref-selection');
          expect(selection?.revision).toBe(1);
          expect(selection?.items.map((item) => item.mode).sort()).toEqual(['explicit', 'inherit']);
          expect(
            resolveShadowSelectionAtSource(
              selection,
              { id: 'ref-position', activityId: 'ref-activity', sessionId: 'ref-session' },
              new Date('2099-10-01T12:00:00.000Z'),
            )?.id,
          ).toBe('ref-selection-position');
          expect(
            await query.readSelectionAtSource(tx, {
              activityId: 'ref-activity',
              sourceTime: new Date('2099-08-31T23:59:59.999Z'),
            }),
          ).toBeNull();
          expect(
            (
              await query.readSelectionAtSource(tx, {
                activityId: 'ref-activity',
                sourceTime: new Date('2099-09-01T00:00:00.000Z'),
              })
            )?.id,
          ).toBe('ref-selection');
          expect(
            (
              await query.readSelectionAtSource(tx, {
                activityId: 'ref-activity',
                sourceTime: new Date('2099-11-01T00:00:00.000Z'),
              })
            )?.id,
          ).toBe('ref-selection-2');
          expect(
            await query.readSelectionAtSource(tx, {
              activityId: 'ref-other-activity',
              sourceTime: new Date('2099-10-01T12:00:00.000Z'),
            }),
          ).toBeNull();
          const pointer = {
            id: 'ref-version',
            definitionHash: manifest.approvals[0].policyDefinitionHash,
            evaluatorVersion: 1,
          };
          expect(
            (await query.readComparisonPolicyVersions(tx, [pointer, pointer])).map((p) => p.id),
          ).toEqual(['ref-version']);
          expect(
            await query.readComparisonPolicyVersions(tx, [
              { ...pointer, definitionHash: 'a'.repeat(64) },
            ]),
          ).toEqual([]);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    } finally {
      await client.$disconnect();
    }
    expect(
      sql(
        `SELECT count(*) FROM "ActivityContributionPolicySelectionRevision" WHERE "activityId"='ref-activity'`,
      ),
    ).toBe('0');
  });

  it('does not let a later selection rewrite the historical source-time choice', () => {
    expect(
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
      ${actualSelectionFixtureSql('2099-11-01T00:00:00.000Z', 2)}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture; ${applicationInsertSql()}
      RESET SESSION AUTHORIZATION; SET CONSTRAINTS ALL IMMEDIATE;
      SELECT "selectionItemId" FROM "ContributionShadowMappingApplication" WHERE id='ref-application'; ROLLBACK;`),
    ).toBe('ref-selection-position');
  });

  it.each([
    `UPDATE "ContributionShadowMappingApplication" SET "policyPoints"=0 WHERE id='ref-application'`,
    `DELETE FROM "ContributionShadowMappingApplication" WHERE id='ref-application'`,
  ])('keeps a materialized proof immutable even for the trusted test owner: %s', (mutation) => {
    expect(() =>
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      ${applicationInsertSql()}
      RESET SESSION AUTHORIZATION; ${mutation}; ROLLBACK;`),
    ).toThrow('shadow mapping evidence is immutable');
  });

  it('registrar cannot directly materialize application evidence or bypass its runtime identity', () => {
    expect(() =>
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET SESSION AUTHORIZATION srvf_shadow_registrar_w98_fixture;
      ${applicationInsertSql()} ROLLBACK;`),
    ).toThrow('permission denied for table ContributionShadowMappingApplication');
    expect(() =>
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      ${applicationInsertSql()} ROLLBACK;`),
    ).toThrow('shadow mapping proof runtime is not yet verified');
  });

  it('keeps runtime proof available after registrar EXECUTE is closed, without granting business writes', () => {
    const script = readFileSync(
      join(process.cwd(), 'scripts/sql/contribution-shadow-registration-roles.sql'),
      'utf8',
    );
    expect(
      sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()}
      SET LOCAL srvf.shadow_acl_action='close'; ${script}
      SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
      ${applicationInsertSql()}
      SELECT count(*) FROM "ContributionShadowMappingApplication";
      SELECT has_table_privilege(CURRENT_USER,'public."AttendanceRecord"','INSERT');
      RESET SESSION AUTHORIZATION; SET CONSTRAINTS ALL IMMEDIATE; ROLLBACK;`),
    ).toBe('1\nf');
  });

  it('database Human gate requires a real current GLOBAL grant without SUPER_ADMIN bypass', () => {
    const { fixtureSql } = registrationReferencesFixture();
    expect(
      sql(`BEGIN; ${fixtureSql} ${registrationHumanFixtureSql()}
      SELECT csm_assert_registration_human_fn('ref-user'); ROLLBACK;`),
    ).toBe('USER');
    expect(() =>
      sql(`BEGIN; ${fixtureSql}
      UPDATE "User" SET role = 'SUPER_ADMIN' WHERE id = 'ref-user';
      SELECT csm_assert_registration_human_fn('ref-user'); ROLLBACK;`),
    ).toThrow('shadow mapping registration Human grant unavailable');
  });

  it.each([
    `UPDATE "User" SET status = 'DISABLED' WHERE id = 'ref-user'`,
    `UPDATE "User" SET "deletedAt" = CURRENT_TIMESTAMP WHERE id = 'ref-user'`,
    `UPDATE role_bindings SET status = 'ENDED' WHERE id = 'ref-binding'`,
    `UPDATE role_bindings SET "deletedAt" = CURRENT_TIMESTAMP WHERE id = 'ref-binding'`,
    `UPDATE role_bindings SET "startedAt" = '2099-01-01' WHERE id = 'ref-binding'`,
    `UPDATE role_bindings SET "endedAt" = '2001-01-01' WHERE id = 'ref-binding'`,
    `UPDATE roles SET "deletedAt" = CURRENT_TIMESTAMP WHERE id = 'ref-role'`,
    `UPDATE permissions SET "servicePrincipalAllowed" = TRUE WHERE id = 'ref-permission'`,
  ])('database Human gate fails closed for current invalid identity or grant %s', (change) => {
    const { fixtureSql } = registrationReferencesFixture();
    expect(() =>
      sql(`BEGIN; ${fixtureSql} ${registrationHumanFixtureSql()} ${change};
      SELECT csm_assert_registration_human_fn('ref-user'); ROLLBACK;`),
    ).toThrow('shadow mapping registration Human grant unavailable');
  });

  it('registers synthetic approval, audit and immutable receipt atomically through a nonowner role', () => {
    const { manifest, fixtureSql } = registrationReferencesFixture();
    const literal = JSON.stringify(manifest).replaceAll("'", "''");
    expect(
      sql(`BEGIN; ${fixtureSql} ${registrationHumanFixtureSql()}
      ${registrationAuthorityFixtureSql(manifest)}
      SET SESSION AUTHORIZATION srvf_shadow_registrar_w98_fixture;
      SELECT (csm_register_mapping_fn('${literal}'::jsonb,'ref-user','ref-receipt','ref-register-audit','["ref-approval"]')->>'approvalCount')::INTEGER;
      RESET SESSION AUTHORIZATION;
      SET CONSTRAINTS ALL IMMEDIATE;
      SELECT count(*) FROM "ContributionShadowMappingApproval";
      SELECT count(*) FROM "ContributionShadowMappingRegistrationReceipt";
      SELECT count(*) FROM audit_logs WHERE event = 'activity.contribution-shadow.mapping-register';
      ROLLBACK;`),
    ).toBe('1\n1\n1\n1');
    expect(
      sql(`SELECT count(*) FROM pg_roles WHERE rolname IN
      ('srvf_shadow_owner_w98_fixture','srvf_shadow_registrar_w98_fixture','srvf_shadow_runtime_w98_fixture')`),
    ).toBe('0');
    expect(sql(`SELECT count(*) FROM "ContributionShadowMappingApproval"`)).toBe('0');
  });

  it('closes the typed registration audit with server requestId and null ip/ua in the same transaction', () => {
    expect(SHADOW_MAPPING_REGISTRATION_AUDIT_EVENT).toBe(
      'activity.contribution-shadow.mapping-register',
    );
    const actual = JSON.parse(
      sql(`BEGIN; ${actualSourceApprovalFixture()}
      SET CONSTRAINTS ALL IMMEDIATE;
      SELECT jsonb_build_object('event',event,'context',context)
        FROM audit_logs WHERE id='ref-register-audit'; ROLLBACK;`),
    );
    expect(actual).toEqual({
      event: SHADOW_MAPPING_REGISTRATION_AUDIT_EVENT,
      context: {
        requestId: 'shadow-mapping-registration:ref-register-audit',
        ip: null,
        ua: null,
        extra: {
          manifestHash: manifestApplicationHash(registrationReferencesFixture().manifest),
          approvalCount: 1,
        },
      },
    });
  });

  it('replays the exact command without another approval, audit or receipt', () => {
    const { manifest, fixtureSql } = registrationReferencesFixture();
    const literal = JSON.stringify(manifest).replaceAll("'", "''");
    expect(
      sql(`BEGIN; ${fixtureSql} ${registrationHumanFixtureSql()}
      ${registrationAuthorityFixtureSql(manifest)}
      SET SESSION AUTHORIZATION srvf_shadow_registrar_w98_fixture;
      SELECT csm_register_mapping_fn('${literal}'::jsonb,'ref-user','ref-receipt','ref-register-audit','["ref-approval"]')->>'id';
      SELECT csm_register_mapping_fn('${literal}'::jsonb,'ref-user','ignored-receipt','ignored-audit','["ignored-approval"]')->>'id';
      RESET SESSION AUTHORIZATION; SET CONSTRAINTS ALL IMMEDIATE;
      SELECT count(*) FROM "ContributionShadowMappingApproval";
      SELECT count(*) FROM audit_logs WHERE event = 'activity.contribution-shadow.mapping-register';
      ROLLBACK;`),
    ).toBe('ref-receipt\nref-receipt\n1\n1');
  });

  it.each([
    [
      'srvf_shadow_runtime_w98_fixture',
      `SELECT csm_register_mapping_fn('{}','ref-user','r','a','[]')`,
      'permission denied for function csm_register_mapping_fn',
    ],
    [
      'srvf_shadow_registrar_w98_fixture',
      `INSERT INTO "ContributionShadowMappingApproval" DEFAULT VALUES`,
      'permission denied for table ContributionShadowMappingApproval',
    ],
    [
      'srvf_shadow_runtime_w98_fixture',
      `SET ROLE srvf_shadow_registrar_w98_fixture`,
      'permission denied to set role',
    ],
    [
      'srvf_shadow_registrar_w98_fixture',
      `SET ROLE srvf_shadow_owner_w98_fixture`,
      'permission denied to set role',
    ],
  ])('keeps %s out of ungranted capability: %s', (role, statement, message) => {
    const { manifest, fixtureSql } = registrationReferencesFixture();
    expect(() =>
      sql(`BEGIN; ${fixtureSql} ${registrationHumanFixtureSql()}
      ${registrationAuthorityFixtureSql(manifest)}
      SET SESSION AUTHORIZATION ${role}; ${statement}; ROLLBACK;`),
    ).toThrow(message);
  });

  it('rejects a manifest substitution even when the registrar can execute the function', () => {
    const { manifest, fixtureSql } = registrationReferencesFixture();
    const changed = { ...manifest, approvalReference: 'not-approved' };
    const literal = JSON.stringify(changed).replaceAll("'", "''");
    expect(() =>
      sql(`BEGIN; ${fixtureSql} ${registrationHumanFixtureSql()}
      ${registrationAuthorityFixtureSql(manifest)}
      SET SESSION AUTHORIZATION srvf_shadow_registrar_w98_fixture;
      SELECT csm_register_mapping_fn('${literal}'::jsonb,'ref-user','r','a','["p"]');
      ROLLBACK;`),
    ).toThrow('shadow mapping registration authority unavailable');
  });

  it('rejects an actor substitution rather than trusting the SQL actor-id parameter', () => {
    const { manifest, fixtureSql } = registrationReferencesFixture();
    const literal = JSON.stringify(manifest).replaceAll("'", "''");
    expect(() =>
      sql(`BEGIN; ${fixtureSql} ${registrationHumanFixtureSql()}
      ${registrationAuthorityFixtureSql(manifest)}
      SET SESSION AUTHORIZATION srvf_shadow_registrar_w98_fixture;
      SELECT csm_register_mapping_fn('${literal}'::jsonb,'forged-user','r','a','["p"]');
      ROLLBACK;`),
    ).toThrow('shadow mapping registration authority unavailable');
  });

  it('freezes the registration audit rather than accepting later context edits', () => {
    const { manifest, fixtureSql } = registrationReferencesFixture();
    const literal = JSON.stringify(manifest).replaceAll("'", "''");
    expect(() =>
      sql(`BEGIN; ${fixtureSql} ${registrationHumanFixtureSql()}
      ${registrationAuthorityFixtureSql(manifest)}
      SET SESSION AUTHORIZATION srvf_shadow_registrar_w98_fixture;
      SELECT csm_register_mapping_fn('${literal}'::jsonb,'ref-user','r','a','["p"]');
      RESET SESSION AUTHORIZATION;
      UPDATE audit_logs SET context = '{}' WHERE id = 'a'; ROLLBACK;`),
    ).toThrow('shadow mapping evidence is immutable');
  });

  it('revokes PUBLIC execution on every authority or privileged registration helper', () => {
    expect(
      sql(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
      LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      WHERE n.nspname = 'public' AND p.proname IN ('csm_registration_authority_fn',
        'csm_assert_registration_authority_fn','csm_assert_registration_human_fn',
        'csm_register_mapping_fn','csm_pending_insert_guard_fn','csm_approval_receipt_closure_fn')
        AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'`),
    ).toBe('0');
  });

  it('ACL close withdraws the function grant and binding without deleting evidence', () => {
    const { manifest, fixtureSql } = registrationReferencesFixture();
    const literal = JSON.stringify(manifest).replaceAll("'", "''");
    const script = readFileSync(
      join(process.cwd(), 'scripts/sql/contribution-shadow-registration-roles.sql'),
      'utf8',
    );
    expect(
      sql(`BEGIN; ${fixtureSql} ${registrationHumanFixtureSql()}
      ${registrationAuthorityFixtureSql(manifest)}
      SET SESSION AUTHORIZATION srvf_shadow_registrar_w98_fixture;
      SELECT csm_register_mapping_fn('${literal}'::jsonb,'ref-user','r','a','["p"]')->>'id';
      RESET SESSION AUTHORIZATION; SET CONSTRAINTS ALL IMMEDIATE;
      SET LOCAL srvf.shadow_acl_action = 'close'; ${script}
      SELECT csm_registration_authority_fn() IS NULL;
      SELECT has_function_privilege('srvf_shadow_registrar_w98_fixture',
        'csm_register_mapping_fn(jsonb,text,text,text,jsonb)','EXECUTE');
      SELECT count(*) FROM "ContributionShadowMappingApproval";
      SELECT count(*) FROM "ContributionShadowMappingRegistrationReceipt";
      ROLLBACK;`),
    ).toBe('r\nt\nf\n1\n1');
  });

  it('ACL script refuses missing target before creating roles', () => {
    const script = readFileSync(
      join(process.cwd(), 'scripts/sql/contribution-shadow-registration-roles.sql'),
      'utf8',
    );
    expect(() =>
      sql(`BEGIN; SET LOCAL srvf.shadow_acl_action = 'bootstrap'; ${script} ROLLBACK;`),
    ).toThrow('shadow ACL explicit target and action required');
    expect(
      sql(`SELECT count(*) FROM pg_roles WHERE rolname LIKE 'srvf_shadow_%_w98_fixture'`),
    ).toBe('0');
  });

  it('ACL script refuses bootstrap reuse instead of replacing an existing role', () => {
    const script = readFileSync(
      join(process.cwd(), 'scripts/sql/contribution-shadow-registration-roles.sql'),
      'utf8',
    );
    expect(() =>
      sql(`BEGIN; SET LOCAL srvf.shadow_acl_database = 'app_test_w98';
      SET LOCAL srvf.shadow_acl_action = 'bootstrap';
      CREATE ROLE srvf_shadow_owner_w98_fixture NOLOGIN; ${script} ROLLBACK;`),
    ).toThrow('shadow ACL roles already exist; no implicit reuse or replacement');
  });

  it('registrar cannot reinstall authority with caller-controlled settings or the ACL script', () => {
    const { manifest, fixtureSql } = registrationReferencesFixture();
    const script = readFileSync(
      join(process.cwd(), 'scripts/sql/contribution-shadow-registration-roles.sql'),
      'utf8',
    );
    expect(() =>
      sql(`BEGIN; ${fixtureSql} ${registrationHumanFixtureSql()}
      ${registrationAuthorityFixtureSql(manifest)}
      SET SESSION AUTHORIZATION srvf_shadow_registrar_w98_fixture;
      SET LOCAL srvf.shadow_acl_action = 'bind'; ${script} ROLLBACK;`),
    ).toThrow('permission denied for function csm_assert_registration_human_fn');
  });

  it('registrar can read current identity but not password hashes or other user fields', () => {
    const { manifest, fixtureSql } = registrationReferencesFixture();
    expect(
      sql(`BEGIN; ${fixtureSql} ${registrationHumanFixtureSql()}
      ${registrationAuthorityFixtureSql(manifest)}
      SET SESSION AUTHORIZATION srvf_shadow_registrar_w98_fixture;
      SELECT id FROM "User" WHERE id = 'ref-user' AND "deletedAt" IS NULL AND status = 'ACTIVE';
      RESET SESSION AUTHORIZATION; ROLLBACK;`),
    ).toBe('ref-user');
    expect(() =>
      sql(`BEGIN; ${fixtureSql} ${registrationHumanFixtureSql()}
      ${registrationAuthorityFixtureSql(manifest)}
      SET SESSION AUTHORIZATION srvf_shadow_registrar_w98_fixture;
      SELECT "passwordHash" FROM "User"; ROLLBACK;`),
    ).toThrow('permission denied for table User');
  });

  it('bootstrap alone grants neither a binding nor registrar execution or login', () => {
    const script = readFileSync(
      join(process.cwd(), 'scripts/sql/contribution-shadow-registration-roles.sql'),
      'utf8',
    );
    expect(
      sql(`BEGIN; SET LOCAL srvf.shadow_acl_database = 'app_test_w98';
      SET LOCAL srvf.shadow_acl_action = 'bootstrap'; ${script}
      SELECT csm_registration_authority_fn() IS NULL;
      SELECT has_function_privilege('srvf_shadow_registrar_w98_fixture',
        'csm_register_mapping_fn(jsonb,text,text,text,jsonb)','EXECUTE');
      SELECT bool_and(NOT rolcanlogin) FROM pg_roles WHERE rolname LIKE 'srvf_shadow_%_w98_fixture';
      ROLLBACK;`),
    ).toBe('t\nf\nt');
  });

  // Digest equality proves content equality only, never Human approval or registrar authority.
  it('computes the same manifest digest independently in PostgreSQL and the application', () => {
    const value = manifestFixture();
    expect(manifestSqlHash(value)).toBe(manifestApplicationHash(value));
    value.approvalReference = '中文😀\\"单引号\'证据';
    value.approvals[0].attendanceRoleCode = '中文😀成员';
    expect(manifestSqlHash(value)).toBe(manifestApplicationHash(value));
    const reordered = Object.fromEntries(Object.entries(value).reverse());
    expect(manifestSqlHash(reordered)).toBe(manifestApplicationHash(value));
  });

  it.each(['revoke', 'replace'])('validates a %s manifest with an explicit predecessor', (kind) => {
    const value = manifestFixture();
    value.approvals[0].eventKindCode = kind;
    value.approvals[0].previousApprovalId = 'fixture-predecessor';
    value.approvals[0].effectiveUntil = '2100-01-01T00:00:00.000Z';
    expect(manifestSqlHash(value)).toBe(manifestApplicationHash(value));
  });

  it('preserves manifest array order and normalizes integral JSON numbers like the application', () => {
    const value = manifestFixture();
    value.approvals.push({ ...value.approvals[0], approvalNumber: 'fixture-second' });
    const first = manifestSqlHash(value);
    expect(first).toBe(manifestApplicationHash(value));
    value.approvals.reverse();
    expect(manifestSqlHash(value)).toBe(manifestApplicationHash(value));
    expect(manifestSqlHash(value)).not.toBe(first);
    const raw = JSON.stringify(value).replace('"schemaVersion":1', '"schemaVersion":1.0');
    expect(sql(`SELECT csm_manifest_hash_fn('${raw}'::jsonb)`)).toBe(
      manifestApplicationHash(value),
    );
  });

  it('accepts a real leap day without weakening strict UTC timestamps', () => {
    const value = manifestFixture();
    value.approvals[0].effectiveFrom = '2096-02-29T00:00:00.000Z';
    expect(manifestSqlHash(value)).toBe(manifestApplicationHash(value));
  });

  it('independently recomputes the complete policy envelope fingerprint, including UTC effective dates', () => {
    const value = mappingInputsFixture();
    expect(policyFingerprintSql(value.policy)).toBe(value.policy.definitionHash);
    const definition = policyFixture();
    definition.roleRules[0].attendanceRoleCode = '中文😀成员';
    const expected = fingerprintContributionPolicyVersion({
      schemaVersion: 1,
      evaluatorVersion: 1,
      definition,
      effectiveFrom: '2096-02-29T01:02:03.456Z',
      effectiveUntil: '2100-01-01T00:00:00.001Z',
    });
    const policy = {
      ...value.policy,
      definitionJson: definition,
      effectiveFrom: expected.effectiveFrom,
      effectiveUntil: expected.effectiveUntil,
    };
    expect(policyFingerprintSql(policy)).toBe(expected.definitionHash);
    const literal = JSON.stringify(policy).replaceAll("'", "''");
    expect(
      sql(`BEGIN; SET LOCAL TIME ZONE 'Asia/Shanghai';
      SELECT csm_policy_fingerprint_fn(jsonb_populate_record(NULL::"ContributionPolicyVersion", '${literal}'::jsonb)); ROLLBACK;`),
    ).toBe(expected.definitionHash);
  });

  it('preserves exact policy canonical bytes against the fixed pre-optimization reference', () => {
    const base = mappingInputsFixture().policy;
    const cases: Array<{ policy: unknown; valid: boolean; expectedHash?: string }> = [];
    const add = (definition: unknown, until: string | null = null) => {
      const expected = fingerprintContributionPolicyVersion({
        schemaVersion: 1,
        evaluatorVersion: 1,
        definition,
        effectiveFrom: '2096-02-29T01:02:03.456Z',
        effectiveUntil: until,
      });
      // The SQL contract fingerprints the stored array order, even when a valid
      // synthetic row is not in the normal E1 writer's normalized order.
      const expectedHash = computeActivityTemplateDefinitionHash({
        schemaVersion: 1,
        definition: {
          definition,
          evaluatorVersion: 1,
          effectiveFrom: expected.effectiveFrom,
          effectiveUntil: expected.effectiveUntil,
        },
      });
      cases.push({
        valid: true,
        expectedHash,
        policy: {
          ...base,
          definitionJson: definition,
          effectiveFrom: expected.effectiveFrom,
          effectiveUntil: expected.effectiveUntil,
        },
      });
    };
    const categories = ['volunteer_service', 'training', 'organization', 'non_creditable'];
    for (const roleCount of [0, 1, 2, 64]) {
      for (const categoryCount of [0, 1, 4]) {
        for (const bandCount of [1, 2, 16]) {
          add(
            {
              defaultResult: { recognizedPoints: '0.00', explanationCode: 'default' },
              roleRules: Array.from({ length: roleCount }, (_, role) => ({
                attendanceRoleCode: `role_${role}`,
                categoryRules: categories
                  .slice(0, categoryCount)
                  .reverse()
                  .map((timeCategoryCode) => ({
                    timeCategoryCode,
                    durationBands: Array.from({ length: bandCount }, (_, band) => ({
                      maxSecondsInclusive:
                        band === bandCount - 1
                          ? null
                          : band === bandCount - 2
                            ? Number.MAX_SAFE_INTEGER
                            : band,
                      recognizedPoints: band % 2 === 0 ? '999.99' : '0.00',
                      explanationCode: `band_${band}`,
                    })),
                  })),
              })).reverse(),
            },
            roleCount % 2 === 0 ? null : '2100-01-01T00:00:00.001Z',
          );
        }
      }
    }
    for (const role of [
      '中文😀成员',
      'member"quoted',
      'member\\slash',
      'e\u0301',
      'x'.repeat(64),
    ]) {
      const definition = policyFixture();
      definition.roleRules[0].attendanceRoleCode = role;
      add(definition);
    }
    const invalidDefinitions: unknown[] = [
      null,
      [],
      {},
      { ...policyFixture(), extra: true },
      { ...policyFixture(), defaultResult: { recognizedPoints: '0', explanationCode: 'default' } },
      { ...policyFixture(), roleRules: null },
      {
        ...policyFixture(),
        roleRules: Array.from({ length: 65 }, (_, i) => ({
          attendanceRoleCode: `role_${i}`,
          categoryRules: [],
        })),
      },
    ];
    const duplicate = policyFixture();
    duplicate.roleRules.push(structuredClone(duplicate.roleRules[0]));
    invalidDefinitions.push(duplicate);
    for (const maximum of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      const definition = policyFixture();
      definition.roleRules[0].categoryRules[0].durationBands[0].maxSecondsInclusive = maximum;
      invalidDefinitions.push(definition);
    }
    const unseen = policyFixture();
    unseen.roleRules.push({
      attendanceRoleCode: 'unselected',
      categoryRules: [
        {
          timeCategoryCode: 'training',
          durationBands: [
            { maxSecondsInclusive: null, recognizedPoints: '1000.00', explanationCode: 'invalid' },
          ],
        },
      ],
    });
    invalidDefinitions.push(unseen);
    for (const definitionJson of invalidDefinitions)
      cases.push({ valid: false, policy: { ...base, definitionJson } });
    for (const changes of [
      { schemaVersion: 2 },
      { evaluatorVersion: 2 },
      { effectiveFrom: null },
      { effectiveUntil: '2098-01-01T00:00:00.000Z' },
    ])
      cases.push({ valid: false, policy: { ...base, ...changes } });

    // Extract only the actual function's hash preimage for byte-for-byte comparison.
    // Neither its validation nor its canonical construction is copied into the reference.
    const actualDefinition = sql(`SELECT pg_get_functiondef(
      'csm_policy_fingerprint_fn("ContributionPolicyVersion")'::regprocedure)`);
    const returnPattern = /RETURN encode\(sha256\(convert_to\((.+),'UTF8'\)\),'hex'\);/u;
    expect(actualDefinition.match(returnPattern)).not.toBeNull();
    expect(actualDefinition.includes('public.csm_policy_fingerprint_fn(')).toBe(true);
    const actualCanonical = actualDefinition
      .replace('public.csm_policy_fingerprint_fn(', 'pg_temp.actual_policy_canonical(')
      .replace(returnPattern, 'RETURN $1;');
    const payload = JSON.stringify(cases).replaceAll("'", "''");
    const result = JSON.parse(
      sql(`BEGIN; SET LOCAL TIME ZONE 'Asia/Shanghai';
      CREATE FUNCTION pg_temp.reference_policy_canonical(policy "ContributionPolicyVersion") RETURNS TEXT
      LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $reference$
      DECLARE envelope JSONB;
      BEGIN
        IF policy."schemaVersion" IS DISTINCT FROM 1 OR policy."evaluatorVersion" IS DISTINCT FROM 1 OR
          policy."effectiveFrom" IS NULL OR
          (policy."effectiveUntil" IS NOT NULL AND policy."effectiveUntil" <= policy."effectiveFrom") THEN
          RAISE EXCEPTION 'invalid contribution policy metadata' USING ERRCODE='23514';
        END IF;
        PERFORM csm_policy_evaluate_fn(policy."definitionJson",'__schema_validation__','volunteer_service',0);
        envelope := jsonb_build_object('schemaVersion',1,'definition',jsonb_build_object(
          'definition',policy."definitionJson",'evaluatorVersion',policy."evaluatorVersion",
          'effectiveFrom',to_char(policy."effectiveFrom",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'effectiveUntil',to_char(policy."effectiveUntil",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
        IF NOT csm_manifest_instant_fn(envelope->'definition'->'effectiveFrom') OR
          (envelope->'definition'->'effectiveUntil'<>'null'::JSONB AND
            NOT csm_manifest_instant_fn(envelope->'definition'->'effectiveUntil')) THEN
          RAISE EXCEPTION 'invalid contribution policy metadata' USING ERRCODE='23514';
        END IF;
        RETURN csm_manifest_canonical_fn(envelope);
      END $reference$;
      ${actualCanonical};
      CREATE TEMP TABLE policy_diff_result(accepted INTEGER, rejected INTEGER, reference_ms NUMERIC, actual_ms NUMERIC);
      DO $diff$
      DECLARE item JSONB; policy "ContributionPolicyVersion"; actual TEXT; reference TEXT; actual_hash TEXT;
        actual_error TEXT; reference_error TEXT; accepted INTEGER:=0; rejected INTEGER:=0;
        started TIMESTAMPTZ; reference_ms NUMERIC; actual_ms NUMERIC; n INTEGER; reference_hash TEXT;
      BEGIN
        FOR item IN SELECT value FROM jsonb_array_elements('${payload}'::jsonb) LOOP
          policy := jsonb_populate_record(NULL::"ContributionPolicyVersion",item->'policy');
          actual := NULL; reference := NULL; actual_hash:=NULL; actual_error:=NULL; reference_error:=NULL;
          BEGIN reference := pg_temp.reference_policy_canonical(policy);
          EXCEPTION WHEN OTHERS THEN reference_error := SQLSTATE||':'||SQLERRM; END;
          BEGIN actual := pg_temp.actual_policy_canonical(policy); actual_hash := csm_policy_fingerprint_fn(policy);
          EXCEPTION WHEN OTHERS THEN actual_error := SQLSTATE||':'||SQLERRM; END;
          IF actual_error IS DISTINCT FROM reference_error OR actual IS DISTINCT FROM reference THEN
            RAISE EXCEPTION 'policy canonical differential mismatch';
          END IF;
          IF (item->>'valid')::BOOLEAN THEN
            IF actual_error IS NOT NULL OR actual IS NULL OR actual_hash IS DISTINCT FROM
              encode(sha256(convert_to(reference,'UTF8')),'hex') OR actual_hash IS DISTINCT FROM item->>'expectedHash' THEN
              RAISE EXCEPTION 'policy valid fixture/hash mismatch';
            END IF;
            accepted := accepted+1;
          ELSE
            IF actual_error IS NULL THEN RAISE EXCEPTION 'policy invalid fixture accepted'; END IF;
            rejected := rejected+1;
          END IF;
        END LOOP;
        policy := jsonb_populate_record(NULL::"ContributionPolicyVersion",'${JSON.stringify(base).replaceAll("'", "''")}'::jsonb);
        started := clock_timestamp();
        FOR n IN 1..2000 LOOP
          policy.id := n::TEXT;
          reference_hash := encode(sha256(convert_to(pg_temp.reference_policy_canonical(policy),'UTF8')),'hex');
        END LOOP;
        reference_ms := extract(epoch FROM clock_timestamp()-started)*1000;
        started := clock_timestamp();
        FOR n IN 1..2000 LOOP
          policy.id := n::TEXT;
          actual_hash := csm_policy_fingerprint_fn(policy);
          IF actual_hash IS DISTINCT FROM reference_hash THEN RAISE EXCEPTION 'policy benchmark hash mismatch'; END IF;
        END LOOP;
        actual_ms := extract(epoch FROM clock_timestamp()-started)*1000;
        INSERT INTO policy_diff_result VALUES(accepted,rejected,reference_ms,actual_ms);
      END $diff$;
      SELECT jsonb_build_object('accepted',accepted,'rejected',rejected,'referenceMs',reference_ms,'actualMs',actual_ms) FROM policy_diff_result;
      ROLLBACK;`),
    ) as { accepted: number; rejected: number; referenceMs: number; actualMs: number };
    expect(result.accepted).toBe(cases.filter((entry) => entry.valid).length);
    expect(result.rejected).toBe(cases.filter((entry) => !entry.valid).length);
    expect(result.accepted).toBeGreaterThan(0);
    expect(result.rejected).toBeGreaterThan(0);
    console.info('[shadow-policy-canonical-diff] ' + JSON.stringify(result));
  }, 120_000);

  it('rejects matching arbitrary hashes or changed policy content even when all supplied keys agree', () => {
    const value = mappingInputsFixture();
    value.policy.definitionHash = 'b'.repeat(64);
    value.approval.policyDefinitionHash = value.policy.definitionHash;
    expect(() => evaluateMappingInputs(value)).toThrow();
    const tampered = mappingInputsFixture();
    tampered.policy.definitionJson.roleRules[0].categoryRules[0].durationBands[2].recognizedPoints =
      '11.00';
    expect(() => evaluateMappingInputs(tampered)).toThrow();
    const changedInterval = mappingInputsFixture();
    changedInterval.policy.effectiveFrom = '2099-01-02T00:00:00.000Z';
    expect(() => evaluateMappingInputs(changedInterval)).toThrow();
  });

  it.each([
    { schemaVersion: 2 },
    { evaluatorVersion: 2 },
    { effectiveFrom: null },
    { effectiveUntil: '2099-01-01T00:00:00.000Z' },
  ])('rejects an invalid policy fingerprint envelope %p', (change) => {
    expect(() => policyFingerprintSql({ ...mappingInputsFixture().policy, ...change })).toThrow();
  });

  it('checks actual activity, position and policy rows without granting registration authority', () => {
    const { manifest, fixtureSql } = registrationReferencesFixture();
    expect(checkRegistrationReferences(manifest, fixtureSql)).toBe('references-checked');
    expect(sql('SELECT count(*) FROM "ContributionShadowMappingApproval"')).toBe('0');
    expect(sql('SELECT count(*) FROM "Activity" WHERE id = \'ref-activity\'')).toBe('0');
  });

  it.each([
    { activityId: 'missing-activity' },
    { activityId: 'ref-other-activity' },
    { activityTypeCode: 'wrong-type' },
    { sessionPositionId: 'missing-position' },
    { policyVersionId: 'missing-version' },
    { policyDefinitionHash: 'b'.repeat(64) },
    { policyRoleCode: 'missing-role' },
    { categoryCode: 'training' },
    { eventKindCode: 'replace', previousApprovalId: 'missing-predecessor' },
  ])('rejects a registration with unavailable or mismatched real references %p', (change) => {
    const { manifest, fixtureSql } = registrationReferencesFixture();
    const invalid = { ...manifest, approvals: [{ ...manifest.approvals[0], ...change }] };
    const expected =
      'policyVersionId' in change || 'policyDefinitionHash' in change
        ? 'shadow registration policy reference unavailable'
        : 'policyRoleCode' in change || 'categoryCode' in change
          ? 'shadow registration policy definition or rule unavailable'
          : 'previousApprovalId' in change
            ? 'shadow registration predecessor unavailable'
            : 'shadow registration activity or position reference unavailable';
    expect(() => checkRegistrationReferences(invalid, fixtureSql)).toThrow(expected);
    expect(sql('SELECT count(*) FROM "Activity" WHERE id = \'ref-activity\'')).toBe('0');
  });

  it.each([
    ['Activity', 'ref-activity'],
    ['ActivitySession', 'ref-session'],
    ['ActivitySessionPosition', 'ref-position'],
  ])('rejects a soft-deleted reference in %s using the actual reference guard', (table, id) => {
    const { manifest, fixtureSql } = registrationReferencesFixture();
    expect(() =>
      checkRegistrationReferences(
        manifest,
        `${fixtureSql}
      UPDATE "${table}" SET "deletedAt" = CURRENT_TIMESTAMP WHERE id = '${id}';`,
      ),
    ).toThrow('shadow registration activity or position reference unavailable');
  });

  it('rejects persisted policy content whose stored hash passes format checks but does not match', () => {
    const { manifest, fixtureSql } = registrationReferencesFixture();
    expect(fixtureSql).toContain('1.25');
    const tampered = fixtureSql.replace('1.25', '1.26');
    expect(() => checkRegistrationReferences(manifest, tampered)).toThrow(
      'shadow registration policy definition or rule unavailable',
    );
    expect(sql('SELECT count(*) FROM "ContributionPolicyVersion" WHERE id = \'ref-version\'')).toBe(
      '0',
    );
  });

  it('reads real public references even when a same-name temporary Activity table is present', () => {
    const { manifest, fixtureSql } = registrationReferencesFixture();
    const withTemp = `${fixtureSql}
      CREATE TEMP TABLE "Activity" (LIKE public."Activity" INCLUDING ALL);
      INSERT INTO pg_temp."Activity" SELECT * FROM public."Activity";
      UPDATE pg_temp."Activity" SET "activityTypeCode" = 'forged-type' WHERE id = 'ref-activity';`;
    expect(checkRegistrationReferences(manifest, withTemp)).toBe('references-checked');
    const forged = {
      ...manifest,
      approvals: [{ ...manifest.approvals[0], activityTypeCode: 'forged-type' }],
    };
    expect(() => checkRegistrationReferences(forged, withTemp)).toThrow(
      'shadow registration activity or position reference unavailable',
    );
  });

  it('matches every approval field, the independent digest, actor and database registration instant', () => {
    expect(approvalMatchesManifest(approvalRowFixture())).toBe('t');
    const manifest = manifestFixture();
    manifest.approvals[0].eventKindCode = 'replace';
    manifest.approvals[0].previousApprovalId = 'fixture-predecessor';
    manifest.approvals[0].effectiveUntil = '2100-01-01T00:00:00.000Z';
    expect(approvalMatchesManifest(approvalRowFixture(manifest), manifest)).toBe('t');
  });

  it.each([
    { approvalNumber: 'forged' },
    { mappingVersion: 'forged' },
    { activityId: 'other-activity' },
    { activityTypeCode: 'other-type' },
    { attendanceRoleCode: 'other-role' },
    { sessionPositionId: 'other-position' },
    { policyRoleCode: 'other-policy-role' },
    { categoryCode: 'training' },
    { policyVersionId: 'other-policy' },
    { policyDefinitionHash: 'b'.repeat(64) },
    { evaluatorVersion: 2 },
    { durationSourceCode: 'guessed_span' },
    { effectiveFrom: '2099-10-02T00:00:00.000Z' },
    { effectiveUntil: '2100-01-01T00:00:00.000Z' },
    { eventKindCode: 'revoke' },
    { previousApprovalId: 'forged' },
    { manifestHash: 'b'.repeat(64) },
    { approvalReference: 'forged' },
    { approvedByUserId: 'other-human' },
    { registeredByUserId: 'other-human' },
    { approvedAt: '2099-08-31T23:59:59.999Z' },
    { createdAt: '2099-09-01T00:00:00.001Z' },
    { manifestHash: null },
  ])(
    'rejects altered approval content without treating supplied rows as authority: %p',
    (change) => {
      expect(approvalMatchesManifest({ ...approvalRowFixture(), ...change })).toBe('f');
    },
  );

  it('rejects missing identity/time or an out-of-range manifest index', () => {
    const row = approvalRowFixture();
    expect(approvalMatchesManifest(row, manifestFixture(), -1)).toBe('f');
    expect(approvalMatchesManifest(row, manifestFixture(), 1)).toBe('f');
    expect(approvalMatchesManifest(row, manifestFixture(), 0, null)).toBe('f');
    expect(approvalMatchesManifest(row, manifestFixture(), 0, 'fixture-human', null)).toBe('f');
  });

  it.each([
    { evaluatorVersion: 2 },
    { durationSourceCode: 'guessed_span' },
    { categoryCode: 'unknown' },
    { eventKindCode: 'hold' },
    { eventKindCode: ['replace'], previousApprovalId: 'fixture-predecessor' },
    { previousApprovalId: 'forged-predecessor' },
    { eventKindCode: 'revoke' },
    { effectiveFrom: '2100-02-29T00:00:00.000Z' },
    { effectiveFrom: '2099-10-01T24:00:00.000Z' },
    { effectiveFrom: '2099-10-01T00:00:00Z' },
    { effectiveUntil: '2099-10-01T00:00:00.000Z' },
    { policyDefinitionHash: 'A'.repeat(64) },
    { approvedByUserId: 'forged' },
    { attendanceRoleCode: '😀'.repeat(33) },
    { attendanceRoleCode: ' padded' },
    { attendanceRoleCode: 'control\u0001' },
    { approvalNumber: 'x'.repeat(129) },
    { activityId: null },
  ])('rejects an invalid manifest item in both independent validators: %p', (change) => {
    const value = manifestFixture();
    const invalid = { ...value, approvals: [{ ...value.approvals[0], ...change }] };
    expect(() => parseShadowMappingRegistrationManifest(invalid)).toThrow();
    expect(() => manifestSqlHash(invalid)).toThrow();
  });

  it.each(['extra-field', 'empty-approvals', 'duplicate', 'wrong-version', 'bad-command'])(
    'rejects invalid manifest root: %s',
    (kind) => {
      const value = manifestFixture();
      let invalid: unknown = value;
      if (kind === 'extra-field') invalid = { ...value, approvedByUserId: 'forged' };
      if (kind === 'empty-approvals') invalid = { ...value, approvals: [] };
      if (kind === 'duplicate')
        invalid = { ...value, approvals: [value.approvals[0], value.approvals[0]] };
      if (kind === 'wrong-version') invalid = { ...value, schemaVersion: 2 };
      if (kind === 'bad-command') invalid = { ...value, commandKey: 'x'.repeat(129) };
      expect(() => parseShadowMappingRegistrationManifest(invalid)).toThrow();
      expect(() => manifestSqlHash(invalid)).toThrow();
    },
  );

  it('installs exact same-activity/source/version foreign keys', () => {
    const constraints = sql(
      "SELECT conname FROM pg_constraint WHERE conname IN ('csma_position_fk','csma_policy_fk','csma_previous_fk','csmap_approval_fk','csmap_source_fk','csmap_selection_fk','csmap_policy_fk','csmrr_registrar_fk','csmrr_audit_fk') AND contype='f' ORDER BY conname",
    ).split('\n');
    expect(constraints).toEqual([
      'csma_policy_fk',
      'csma_position_fk',
      'csma_previous_fk',
      'csmap_approval_fk',
      'csmap_policy_fk',
      'csmap_selection_fk',
      'csmap_source_fk',
      'csmrr_audit_fk',
      'csmrr_registrar_fk',
    ]);
    expect(
      sql("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='csmap_source_fk'"),
    ).toContain(
      'FOREIGN KEY ("legacySourceAnchorId", "windowId", "auditLogId", "sheetId", "sheetVersion", "recordId", "memberId", "activityId")',
    );
  });

  it.each([0, 1, 59, 60, 61, 3599, 3600, 3601, 9007199254740991])(
    'database evaluation matches the existing evaluator at %s seconds',
    (durationSeconds) => {
      const definition = policyFixture();
      expect(evaluateSql(definition, durationSeconds)).toEqual(
        evaluateContributionPolicy(definition, {
          attendanceRoleCode: 'member',
          timeCategoryCode: 'volunteer_service',
          durationSeconds,
        }),
      );
    },
  );

  it.each([
    ['missing', 'volunteer_service'],
    ['member', 'training'],
  ])('keeps default evaluation for an absent role/category (%s/%s)', (role, category) => {
    expect(evaluateSql(policyFixture(), 60, role, category)).toEqual({
      recognizedPoints: '0.00',
      explanationCode: 'default',
    });
  });

  it.each(['队员', '😀'.repeat(32)])('matches valid Unicode role %s', (role) => {
    const definition = policyFixture();
    definition.roleRules[0].attendanceRoleCode = role;
    expect(evaluateSql(definition, 61, role)).toEqual(
      evaluateContributionPolicy(definition, {
        attendanceRoleCode: role,
        timeCategoryCode: 'volunteer_service',
        durationSeconds: 61,
      }),
    );
  });

  it('compares the largest safe threshold without floating-point rounding', () => {
    const definition = policyFixture();
    definition.roleRules[0].categoryRules[0].durationBands[2].maxSecondsInclusive = 9007199254740991;
    expect(evaluateSql(definition, 9007199254740991)).toEqual(
      evaluateContributionPolicy(definition, {
        attendanceRoleCode: 'member',
        timeCategoryCode: 'volunteer_service',
        durationSeconds: 9007199254740991,
      }),
    );
  });

  it.each([
    [
      'extra root key',
      (value: ReturnType<typeof policyFixture>) => Object.assign(value, { extra: true }),
    ],
    [
      'duplicate role',
      (value: ReturnType<typeof policyFixture>) => value.roleRules.push(value.roleRules[0]),
    ],
    [
      'duplicate category',
      (value: ReturnType<typeof policyFixture>) =>
        value.roleRules[0].categoryRules.push(value.roleRules[0].categoryRules[0]),
    ],
    [
      'noncanonical points',
      (value: ReturnType<typeof policyFixture>) => {
        value.defaultResult.recognizedPoints = '01.00';
      },
    ],
    [
      'fractional threshold',
      (value: ReturnType<typeof policyFixture>) => {
        value.roleRules[0].categoryRules[0].durationBands[1].maxSecondsInclusive = 0.5;
      },
    ],
    [
      'unsafe threshold',
      (value: ReturnType<typeof policyFixture>) => {
        value.roleRules[0].categoryRules[0].durationBands[1].maxSecondsInclusive = 9007199254740992;
      },
    ],
    [
      'descending threshold',
      (value: ReturnType<typeof policyFixture>) => {
        value.roleRules[0].categoryRules[0].durationBands[2].maxSecondsInclusive = 60;
      },
    ],
    [
      'missing final null',
      (value: ReturnType<typeof policyFixture>) => {
        value.roleRules[0].categoryRules[0].durationBands[3].maxSecondsInclusive = 9999;
      },
    ],
    [
      'invalid unselected role',
      (value: ReturnType<typeof policyFixture>) => {
        value.roleRules.push({ attendanceRoleCode: ' unused', categoryRules: [] });
      },
    ],
    [
      'empty bands',
      (value: ReturnType<typeof policyFixture>) => {
        value.roleRules[0].categoryRules[0].durationBands.splice(0);
      },
    ],
    [
      'early null threshold',
      (value: ReturnType<typeof policyFixture>) => {
        value.roleRules[0].categoryRules[0].durationBands[1].maxSecondsInclusive = null;
      },
    ],
    [
      'negative threshold',
      (value: ReturnType<typeof policyFixture>) => {
        value.roleRules[0].categoryRules[0].durationBands[0].maxSecondsInclusive = -1;
      },
    ],
    [
      'invalid unselected band',
      (value: ReturnType<typeof policyFixture>) => {
        value.roleRules[0].categoryRules[0].durationBands[3].explanationCode = 'Bad-Code';
      },
    ],
    [
      'extra band key',
      (value: ReturnType<typeof policyFixture>) => {
        Object.assign(value.roleRules[0].categoryRules[0].durationBands[3], { extra: 1 });
      },
    ],
    [
      'too many bands',
      (value: ReturnType<typeof policyFixture>) => {
        value.roleRules[0].categoryRules[0].durationBands = Array.from(
          { length: 17 },
          (_, index) => ({
            maxSecondsInclusive: index === 16 ? null : index,
            recognizedPoints: '0.00',
            explanationCode: 'zero',
          }),
        );
      },
    ],
    [
      'too many roles',
      (value: ReturnType<typeof policyFixture>) => {
        value.roleRules = Array.from({ length: 65 }, (_, index) => ({
          attendanceRoleCode: `role_${index}`,
          categoryRules: [],
        }));
      },
    ],
    [
      'UTF-16 length overflow',
      (value: ReturnType<typeof policyFixture>) => {
        value.roleRules[0].attendanceRoleCode = '😀'.repeat(33);
      },
    ],
    [
      'Unicode edge whitespace',
      (value: ReturnType<typeof policyFixture>) => {
        value.roleRules[0].attendanceRoleCode = '\uFEFFmember';
      },
    ],
    [
      'control character',
      (value: ReturnType<typeof policyFixture>) => {
        value.roleRules[0].attendanceRoleCode = 'member\u0085x';
      },
    ],
  ] as const)('rejects complete-policy corruption: %s', (_name, corrupt) => {
    const definition = policyFixture();
    corrupt(definition);
    expect(() =>
      evaluateContributionPolicy(definition, {
        attendanceRoleCode: 'member',
        timeCategoryCode: 'volunteer_service',
        durationSeconds: 60,
      }),
    ).toThrow();
    let rejected = '';
    try {
      evaluateSql(definition, 60);
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('stderr' in error)) throw error;
      rejected = String(error.stderr);
    }
    expect(rejected).toContain('invalid contribution policy metadata');
  });

  // Synthetic composite rows exercise the pure contract, NOT registration authority or ACL.
  it.each([
    ['0.01', 36, '1.25', 'short'],
    ['1.00', 3600, '10.00', 'hour'],
    ['1.01', 3636, '999.99', 'long'],
    ['999.99', 3599964, '999.99', 'long'],
  ])(
    'derives seconds from proven stored hours %s, never from wall-clock spans',
    (hours, seconds, points, explanation) => {
      const value = mappingInputsFixture();
      value.source.legacyServiceHours = String(hours);
      expect(evaluateMappingInputs(value)).toEqual({
        durationSeconds: seconds,
        recognizedPoints: points,
        explanationCode: explanation,
      });
    },
  );

  it.each([
    [
      'approval after old write',
      'approval is not effective',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.approval.approvedAt = '2099-03-02T00:00:00.000Z';
      },
    ],
    [
      'not yet effective',
      'approval is not effective',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.approval.effectiveFrom = '2099-03-02T00:00:00.000Z';
      },
    ],
    [
      'right-open effective boundary',
      'approval is not effective',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.approval.effectiveUntil = v.auditTime;
      },
    ],
    [
      'revocation is not approval',
      'approval is not effective',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.approval.eventKindCode = 'revoke';
      },
    ],
    [
      'window ID mismatch',
      'observation mismatch',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.source.windowId = 'different';
      },
    ],
    [
      'window version mismatch',
      'observation mismatch',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.approval.mappingVersion = 'different';
      },
    ],
    [
      'right-open observation boundary',
      'observation mismatch',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.observation.endsAt = v.auditTime;
      },
    ],
    [
      'cross activity',
      'legacy source mismatch',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.approval.activityId = 'different';
      },
    ],
    [
      'cross type',
      'legacy source mismatch',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.approval.activityTypeCode = 'different';
      },
    ],
    [
      'cross legacy role',
      'legacy source mismatch',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.approval.attendanceRoleCode = 'different';
      },
    ],
    [
      'no-match source remains hold',
      'legacy source mismatch',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.source.sourceKindCode = 'no_match';
      },
    ],
    [
      'wall-clock duration substitution',
      'legacy source mismatch',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.approval.durationSourceCode = 'checkin_span';
      },
    ],
    [
      'policy version mismatch',
      'policy version mismatch',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.approval.policyVersionId = 'different';
      },
    ],
    [
      'policy hash mismatch',
      'policy version mismatch',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.approval.policyDefinitionHash = 'b'.repeat(64);
      },
    ],
    [
      'unfrozen evaluator',
      'policy version mismatch',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.policy.evaluatorVersion = 2;
      },
    ],
    [
      'missing policy role cannot use default',
      'policy role or category missing',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.approval.policyRoleCode = 'missing';
      },
    ],
    [
      'missing category cannot use default',
      'policy role or category missing',
      (v: ReturnType<typeof mappingInputsFixture>) => {
        v.approval.categoryCode = 'training';
      },
    ],
  ] as const)('rejects mapping input mismatch: %s', (_name, marker, corrupt) => {
    const value = mappingInputsFixture();
    corrupt(value);
    let rejected = '';
    try {
      evaluateMappingInputs(value);
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('stderr' in error)) throw error;
      rejected = String(error.stderr);
    }
    expect(rejected).toContain(marker);
  });

  // Construction-stage assertion only. Replace with the authorized real positive/negative
  // registration/evaluator suite when those guards are implemented; this is NOT D2 acceptance.
  it.each([
    'ContributionShadowMappingApproval',
    'ContributionShadowMappingApplication',
    'ContributionShadowMappingRegistrationReceipt',
  ])('currently rejects unfinished evidence writes to %s', (table) => {
    let rejected = '';
    try {
      sql(`INSERT INTO "${table}" ("id") VALUES ('isolated-construction-fixture')`);
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('stderr' in error)) throw error;
      rejected = String(error.stderr);
    }
    expect(rejected).toContain('shadow mapping proof runtime is not yet verified');
    expect(sql(`SELECT count(*) FROM "${table}"`)).toBe('0');
  });

  it.each([
    ['ContributionShadowMappingApproval', 'csma_no_truncate'],
    ['ContributionShadowMappingApplication', 'csmap_no_truncate'],
    ['ContributionShadowMappingRegistrationReceipt', 'csmrr_no_truncate'],
  ])('blocks unguarded table clearing of %s', (table, trigger) => {
    expect(
      sql(`SELECT t.tgenabled::text || ':' || pg_get_triggerdef(t.oid)
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      WHERE c.relname='${table}' AND t.tgname='${trigger}'`),
    ).toContain('BEFORE TRUNCATE');
    let rejected = '';
    try {
      sql(`BEGIN; TRUNCATE TABLE "${table}" CASCADE; ROLLBACK;`);
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('stderr' in error)) throw error;
      rejected = String(error.stderr);
    }
    expect(rejected).toContain('shadow mapping evidence is immutable');
  });

  function mappingTriggerStates() {
    return sql(`SELECT c.relname || ':' || t.tgenabled::text FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid WHERE t.tgname IN
      ('csma_no_truncate','csmap_no_truncate','csmrr_no_truncate') ORDER BY c.relname`);
  }
  const mappingTruncate =
    'TRUNCATE TABLE "ContributionShadowMappingApplication", "ContributionShadowMappingRegistrationReceipt", "ContributionShadowMappingApproval" RESTART IDENTITY';

  it.each(['ENABLE', 'DISABLE', 'ENABLE REPLICA', 'ENABLE ALWAYS'])(
    'audit cleanup preserves exact mapping trigger mode %s and clears all evidence children',
    async (clause) => {
      const app = await createTestApp();
      const before = mappingTriggerStates();
      try {
        sql(
          `ALTER TABLE "ContributionShadowMappingApplication" ${clause} TRIGGER "csmap_no_truncate";`,
        );
        const configured = mappingTriggerStates();
        await truncateAuditLogsTestOnly(app);
        expect(mappingTriggerStates()).toBe(configured);
        expect(
          sql(`SELECT (SELECT count(*) FROM audit_logs) +
          (SELECT count(*) FROM "ContributionShadowMappingApproval") +
          (SELECT count(*) FROM "ContributionShadowMappingApplication") +
          (SELECT count(*) FROM "ContributionShadowMappingRegistrationReceipt")`),
        ).toBe('0');
      } finally {
        sql(
          'ALTER TABLE "ContributionShadowMappingApplication" ENABLE TRIGGER "csmap_no_truncate";',
        );
        await app.close();
      }
      expect(mappingTriggerStates()).toBe(before);
    },
  );

  it('audit cleanup fails closed on a missing mapping guard and rolls back base guard changes', async () => {
    const states = () =>
      sql(`SELECT string_agg(t.tgname || ':' || t.tgenabled::text, ',' ORDER BY t.tgname)
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
      WHERE NOT t.tgisinternal AND t.tgname LIKE 'cs%_no_truncate'`);
    const before = states();
    const app = await createTestApp();
    const prisma = app.get(PrismaService);
    try {
      await prisma.$executeRawUnsafe(
        'ALTER TRIGGER "csmap_no_truncate" ON "ContributionShadowMappingApplication" RENAME TO "csmap_missing_fixture"',
      );
      const configured = states();
      await expect(truncateAuditLogsTestOnly(app)).rejects.toThrow(
        'Shadow fixture no-truncate trigger missing or invalid',
      );
      expect(states()).toBe(configured);
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TRIGGER "csmap_missing_fixture" ON "ContributionShadowMappingApplication" RENAME TO "csmap_no_truncate"',
      );
      await app.close();
    }
    expect(states()).toBe(before);
  });

  it('restores all mapping guards after raw SQL fixture cleanup', () => {
    const before = mappingTriggerStates();
    const guarded = timeLedgerFixtureTriggerSql();
    sql(`BEGIN; ${guarded.before} ${mappingTruncate}; ${guarded.after} COMMIT;`);
    expect(mappingTriggerStates()).toBe(before);
  });

  it.each([
    ['ENABLE', 'O'],
    ['DISABLE', 'D'],
    ['ENABLE REPLICA', 'R'],
    ['ENABLE ALWAYS', 'A'],
  ])('preserves the exact pre-cleanup trigger mode %s', (clause, mode) => {
    const before = mappingTriggerStates();
    const guarded = timeLedgerFixtureTriggerSql();
    expect(
      sql(`BEGIN;
      ALTER TABLE "ContributionShadowMappingApplication" ${clause} TRIGGER "csmap_no_truncate";
      ${guarded.before} ${mappingTruncate}; ${guarded.after}
      SELECT t.tgenabled::text FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
        WHERE c.relname='ContributionShadowMappingApplication' AND t.tgname='csmap_no_truncate';
      ROLLBACK;`),
    ).toBe(mode);
    expect(mappingTriggerStates()).toBe(before);
  });

  it('restores all mapping guards after transaction fixture cleanup', async () => {
    const before = mappingTriggerStates();
    const prisma = new PrismaClient();
    try {
      await prisma.$transaction(
        (tx) =>
          withTimeLedgerFixtureCleanup(tx, async (guarded) => {
            await guarded.$executeRawUnsafe(mappingTruncate);
          }),
        { timeout: 30_000 },
      );
      expect(mappingTriggerStates()).toBe(before);
    } finally {
      await prisma.$disconnect();
    }
  });

  it('rolls back temporary guard changes when fixture cleanup fails', async () => {
    const before = mappingTriggerStates();
    const prisma = new PrismaClient();
    try {
      await expect(
        prisma.$transaction(
          (tx) =>
            withTimeLedgerFixtureCleanup(tx, async () => {
              throw new Error('deliberate isolated fixture failure');
            }),
          { timeout: 30_000 },
        ),
      ).rejects.toThrow('deliberate isolated fixture failure');
      expect(mappingTriggerStates()).toBe(before);
    } finally {
      await prisma.$disconnect();
    }
  });

  it('rejects a present mapping table whose expected guard is missing', async () => {
    const before = mappingTriggerStates();
    const prisma = new PrismaClient();
    try {
      await expect(
        prisma.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe(
              'DROP TRIGGER "csmap_no_truncate" ON "ContributionShadowMappingApplication"',
            );
            await withTimeLedgerFixtureCleanup(tx, async () => undefined);
          },
          { timeout: 30_000 },
        ),
      ).rejects.toThrow('Expected fixture trigger is missing');
      expect(mappingTriggerStates()).toBe(before);
    } finally {
      await prisma.$disconnect();
    }
  });

  it('does not treat a partially present mapping family as an old schema', () => {
    const before = mappingTriggerStates();
    const guarded = timeLedgerFixtureTriggerSql();
    let rejected = '';
    try {
      sql(
        `BEGIN; ALTER TABLE "ContributionShadowMappingRegistrationReceipt" RENAME TO "isolated_missing_mapping_receipt"; ${guarded.before} ROLLBACK;`,
      );
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('stderr' in error)) throw error;
      rejected = String(error.stderr);
    }
    expect(rejected).toContain('Incomplete shadow mapping fixture tables');
    expect(mappingTriggerStates()).toBe(before);
  });

  it('preserves a nonempty source/audit/attendance chain across 134→135', async () => {
    if (!dedicated) return;
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    if (deriveTestDbName() !== deriveWorkerTestDbName(98))
      throw new Error('unexpected upgrade target');
    await scratchLifecycle.drop('98');
    await scratchLifecycle.create(deriveTestDbName());
    const temporary = mkdtempSync(join(tmpdir(), 'srvf-e3-d2-pre135-'));
    try {
      const root = join(process.cwd(), 'prisma');
      const predecessor = '20260929222500_activity_os_r5_e3_shadow_source_proof';
      mkdirSync(join(temporary, 'migrations'));
      copyFileSync(join(root, 'schema.prisma'), join(temporary, 'schema.prisma'));
      copyFileSync(
        join(root, 'migrations', 'migration_lock.toml'),
        join(temporary, 'migrations', 'migration_lock.toml'),
      );
      const names = readdirSync(join(root, 'migrations'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name <= predecessor)
        .map((entry) => entry.name)
        .sort();
      expect(names).toHaveLength(134);
      expect(names.at(-1)).toBe(predecessor);
      for (const name of names)
        cpSync(join(root, 'migrations', name), join(temporary, 'migrations', name), {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
      const deploy = () =>
        execFileSync(
          'pnpm',
          ['exec', 'prisma', 'migrate', 'deploy', '--schema', join(temporary, 'schema.prisma')],
          { env: process.env, stdio: 'pipe' },
        );
      deploy();
      sql(`BEGIN;
        INSERT INTO "User" (id,username,"passwordHash","updatedAt") VALUES ('up-user','up-user','fixture',CURRENT_TIMESTAMP);
        INSERT INTO "Organization" (id,name,"nodeTypeCode","updatedAt") VALUES ('up-org','Upgrade fixture','team',CURRENT_TIMESTAMP);
        INSERT INTO "Member" (id,"memberNo","realName","memberSinceDate","memberOriginCode","updatedAt")
          VALUES ('up-member','UP135','Upgrade fixture',CURRENT_TIMESTAMP,'manual',CURRENT_TIMESTAMP);
        INSERT INTO "Activity" (id,title,"activityTypeCode","organizationId","startAt","endAt",location,"statusCode","updatedAt")
          VALUES ('up-activity','Upgrade fixture','upgrade_fixture','up-org','2099-01-02','2099-01-03','test','draft',CURRENT_TIMESTAMP);
        INSERT INTO "AttendanceSheet" (id,"activityId","submitterUserId","statusCode","updatedAt",version)
          VALUES ('up-sheet','up-activity','up-user','pending_review',CURRENT_TIMESTAMP,1);
        INSERT INTO "AttendanceRecord" (id,"sheetId","memberId","roleCode","checkInAt","checkOutAt","serviceHours","attendanceStatusCode","contributionPoints","updatedAt")
          VALUES ('up-record','up-sheet','up-member','member','2099-01-02','2099-01-02 01:00',1.00,'present',2.00,CURRENT_TIMESTAMP);
        INSERT INTO "ContributionRule" (id,"activityTypeCode","attendanceRoleCode","pointsBelow","updatedAt")
          VALUES ('up-rule','upgrade_fixture','member',2.00,CURRENT_TIMESTAMP);
        INSERT INTO "ContributionShadowObservationWindow" (id,"startsAt","endsAt","registeredByUserId","deploymentDigest","configDigest","signedMappingVersion","hashAlgorithmCode","canonicalVersion")
          VALUES ('up-window','2099-01-01','2099-01-03','up-user',repeat('a',64),repeat('a',64),'up-mapping','sha256',1);
        INSERT INTO audit_logs (id,"createdAt","resourceType","resourceId",event,context,"shadowProofRequired")
          VALUES ('up-audit','2099-01-01 12:00','attendance_sheet','up-sheet','attendance-sheet.submit',
            jsonb_build_object('after',jsonb_build_object('sheet',jsonb_build_object('activityId','up-activity','version',1),
              'records',jsonb_build_array(jsonb_build_object('id','up-record','memberId','up-member','roleCode','member','serviceHours','1','contributionPoints','2'))),
              'extra',jsonb_build_object('operation','submit','recordsCount',1)),true);
        INSERT INTO "ContributionShadowLegacySourceAnchor" (id,"windowId","auditLogId","sheetId","sheetVersion","activityId","recordId","memberId","activityTypeCode","attendanceRoleCode","legacyServiceHours","sourceKindCode","legacyRuleId","pointsBelow","legacyPoints","hashAlgorithmCode","canonicalVersion","legacySourceHash")
          VALUES ('up-source','up-window','up-audit','up-sheet',1,'up-activity','up-record','up-member','upgrade_fixture','member',1.00,'matched','up-rule',2.00,2.00,'sha256',1,
            cslsa_source_hash_fn(jsonb_populate_record(NULL::"ContributionShadowLegacySourceAnchor", jsonb_build_object(
              'windowId','up-window','auditLogId','up-audit','sheetId','up-sheet','sheetVersion',1,'activityId','up-activity','recordId','up-record','memberId','up-member',
              'activityTypeCode','upgrade_fixture','attendanceRoleCode','member','legacyServiceHours',1.00,'sourceKindCode','matched','legacyRuleId','up-rule','pointsBelow',2.00,'legacyPoints',2.00))));
        COMMIT;`);
      const evidence = () =>
        sql(`SELECT jsonb_build_object(
        'source',(SELECT to_jsonb(s) FROM "ContributionShadowLegacySourceAnchor" s WHERE id='up-source'),
        'audit',(SELECT to_jsonb(a) FROM audit_logs a WHERE id='up-audit'),
        'record',(SELECT to_jsonb(r) FROM "AttendanceRecord" r WHERE id='up-record'),
        'sheet',(SELECT to_jsonb(s) FROM "AttendanceSheet" s WHERE id='up-sheet'))`);
      const before = evidence();
      const successor = '20260930120000_activity_os_r5_e3_shadow_mapping_proof';
      cpSync(join(root, 'migrations', successor), join(temporary, 'migrations', successor), {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
      deploy();
      expect(sql('SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL')).toBe(
        '135',
      );
      expect(evidence()).toBe(before);
      expect(sql('SELECT count(*) FROM "ContributionShadowMappingApproval"')).toBe('0');
      expect(sql('SELECT count(*) FROM "ContributionShadowMappingApplication"')).toBe('0');
      expect(sql('SELECT count(*) FROM "ContributionShadowMappingRegistrationReceipt"')).toBe('0');
      const client = new PrismaClient();
      try {
        const query = new ActivityContributionShadowMappingProofQuery();
        const manifest = manifestFixture();
        manifest.approvals[0].activityId = 'up-activity';
        manifest.approvals[0].activityTypeCode = 'upgrade_fixture';
        const references = await client.$transaction((tx) =>
          query.readRegistrationReferences(tx, manifest),
        );
        expect(references).toEqual({
          activities: [{ id: 'up-activity', activityTypeCode: 'upgrade_fixture' }],
          sessionPositions: [],
          policies: [],
          previousApprovals: [],
        });
        manifest.approvals[0].activityId = 'missing-activity';
        const missing = await client.$transaction((tx) =>
          query.readRegistrationReferences(tx, manifest),
        );
        expect(missing.activities).toEqual([]);
        expect(
          await client.$transaction((tx) =>
            query.readMappingEvents(tx, {
              activityId: 'up-activity',
              mappingVersion: 'up-mapping',
              sourceTime: new Date('2099-01-01T12:00:00.000Z'),
            }),
          ),
        ).toEqual([]);
        // Reading a registration reference never approves it or changes historical evidence.
        expect(evidence()).toBe(before);
      } finally {
        await client.$disconnect();
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 120_000);

  it('checks a string containment fast path against legacy text membership and measures the fixed 2,000-record JSON scan', () => {
    const evidence = JSON.parse(
      sql(`BEGIN;
      DO $membership_probe$
      DECLARE records jsonb; variants jsonb; item jsonb; wanted text; old_found boolean;
        fast_found boolean; mismatches integer := 0; began timestamptz;
        scan_ms numeric; contain_ms numeric; total integer := 0;
      BEGIN
        variants := '[[],[null],[1],["text"],[[{"id":"1","memberId":"member"}]],
          [{"id":"1","memberId":"member"}],[{"id":1,"memberId":"member"}],
          [{"id":true,"memberId":"member"}],[{"id":null,"memberId":"member"}],
          [{"id":"1"}],[{"id":"1","memberId":1}],
          [{"id":["1"],"memberId":"member"}],[{"id":"1","memberId":["member"]}],
          [{"id":["1"],"memberId":["member"]}],[{"id":{"a":1},"memberId":"member"}]]'::jsonb;
        FOR item IN SELECT value FROM jsonb_array_elements(variants) LOOP
          FOREACH wanted IN ARRAY ARRAY['1','true','missing'] LOOP
            SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(item) e(value)
              WHERE value->>'id'=wanted AND value->>'memberId'='member') INTO old_found;
            fast_found := item @> jsonb_build_array(jsonb_build_object('id',wanted,'memberId','member'));
            IF fast_found AND NOT old_found THEN mismatches := mismatches+1; END IF;
          END LOOP;
        END LOOP;
        SELECT jsonb_agg(jsonb_build_object('id','bulk-record-'||n,'memberId','bulk-member-'||n) ORDER BY n)
          INTO records FROM generate_series(1,2000) n;
        began := clock_timestamp();
        FOR i IN 1..2000 LOOP
          SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(records) e(value)
            WHERE value->>'id'='bulk-record-'||i AND value->>'memberId'='bulk-member-'||i) INTO old_found;
          IF old_found THEN total := total+1; END IF;
        END LOOP;
        scan_ms := extract(epoch FROM clock_timestamp()-began)*1000;
        IF total <> 2000 THEN RAISE EXCEPTION 'membership probe scan count mismatch'; END IF;
        total := 0;
        began := clock_timestamp();
        FOR i IN 1..2000 LOOP
          fast_found := records @> jsonb_build_array(jsonb_build_object('id','bulk-record-'||i,'memberId','bulk-member-'||i));
          IF fast_found THEN total := total+1; END IF;
        END LOOP;
        contain_ms := extract(epoch FROM clock_timestamp()-began)*1000;
        IF total <> 2000 THEN RAISE EXCEPTION 'membership probe containment count mismatch'; END IF;
        PERFORM set_config('srvf.shadow_fixture_membership_probe',jsonb_build_object(
          'unexpectedFastAccepts',mismatches,'matchedRecords',total,
          'scanMs',round(scan_ms),'containMs',round(contain_ms))::text,true);
      END $membership_probe$;
      SELECT current_setting('srvf.shadow_fixture_membership_probe'); ROLLBACK;`),
    ) as {
      unexpectedFastAccepts: number;
      matchedRecords: number;
      scanMs: number;
      containMs: number;
    };
    expect(evidence.unexpectedFastAccepts).toBe(0);
    expect(evidence.matchedRecords).toBe(2000);
    // Fixed fixture counts/times only, never SQL, parameters, raw audit or identity.
    console.info('[shadow-w98-json-membership] ' + JSON.stringify(evidence));
  });

  it.each([
    '[]',
    '[null]',
    '[1]',
    '["text"]',
    '[{"id":"1","memberId":"member"}]',
    '[{"id":1,"memberId":"member"}]',
    '[{"id":true,"memberId":"member"}]',
    '[{"id":"1","memberId":1}]',
    '[{"id":1,"memberId":1}]',
    '[{"id":"1"},{"memberId":"member"}]',
    '[[{"id":"1","memberId":"member"}]]',
    '[{"id":["1"],"memberId":["member"]}]',
    '[{"id":{"a":1},"memberId":"member"}]',
  ])('preserves original membership on fast hit or fallback for %s', (records) => {
    const result = sql(`SELECT bool_and(old_found IS NOT DISTINCT FROM new_found) FROM (
      SELECT EXISTS(SELECT 1 FROM jsonb_array_elements('${records}'::jsonb) e(value)
        WHERE value->>'id'=wanted_id AND value->>'memberId'=wanted_member) AS old_found,
        CASE WHEN jsonb_typeof('${records}'::jsonb)='array' AND '${records}'::jsonb @>
          jsonb_build_array(jsonb_build_object('id',wanted_id,'memberId',wanted_member))
          THEN TRUE ELSE EXISTS(SELECT 1 FROM jsonb_array_elements('${records}'::jsonb) e(value)
            WHERE value->>'id'=wanted_id AND value->>'memberId'=wanted_member) END AS new_found
      FROM unnest(ARRAY['1','true','missing']) wanted_id
        CROSS JOIN unnest(ARRAY['member','1','missing']) wanted_member) compared;`);
    expect(result).toBe('t');
  });

  it.each(['{}', '"scalar"', '1', 'null'])(
    'retains the original non-array error on %s',
    (records) => {
      expect(() =>
        sql(`SELECT CASE WHEN jsonb_typeof('${records}'::jsonb)='array' AND
      '${records}'::jsonb @> '[{"id":"1","memberId":"member"}]'::jsonb THEN TRUE ELSE
      EXISTS(SELECT 1 FROM jsonb_array_elements('${records}'::jsonb) e(value)
        WHERE value->>'id'='1' AND value->>'memberId'='member') END;`),
      ).toThrow();
    },
  );

  // Deliberately last: previous probes and 134→135 upgrade retain their original
  // rollback semantics. Only these authorized fixtures survive until afterAll.
  it('keeps a committed start after rollback, recovers read-only failed replay, and compares 2,000 frozen records within one budget', async () => {
    fixtureDatabase();
    expect(
      sql(`SELECT count(*) FROM pg_roles WHERE rolname IN (
      'srvf_shadow_runtime_w98_fixture','srvf_shadow_registrar_w98_fixture','srvf_shadow_owner_w98_fixture')`),
    ).toBe('0');
    sql(`BEGIN; ${actualSourceApprovalFixture()} ${actualSelectionFixtureSql()} COMMIT;`);
    committedAclFixture = true;
    const primary = new PrismaClient();
    const connection = new URL(process.env.DATABASE_URL ?? '');
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(connection.hostname) ||
      connection.pathname !== `/${fixtureDatabase()}`
    )
      throw new Error('LOGIN fixture requires exact local worker connection');
    const password = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
    connection.username = fixtureRole('runtime');
    connection.password = password;
    connection.searchParams.set('connect_timeout', '1');
    connection.searchParams.set('pool_timeout', '1');
    connection.searchParams.set('connection_limit', '1');
    const runtimeProvider = new ContributionShadowService(
      { ...appConfig(), contributionShadowMode: 'shadow' },
      { ...databaseConfig(), contributionShadowUrl: connection.toString() },
    );
    const runtime = await runtimeProvider.withRuntimeClient(async (client) => client);
    if (!runtime) throw new Error('isolated runtime provider unexpectedly disabled');
    const writer = new ContributionShadowEvidenceWriteService();
    const legacyEvidence = () =>
      sql(`SELECT jsonb_build_object(
      'source',(SELECT to_jsonb(s) FROM "ContributionShadowLegacySourceAnchor" s WHERE id='ref-source'),
      'audit',(SELECT to_jsonb(a) FROM audit_logs a WHERE id='ref-source-audit'),
      'record',(SELECT to_jsonb(r) FROM "AttendanceRecord" r WHERE id='ref-record'),
      'sheet',(SELECT to_jsonb(s) FROM "AttendanceSheet" s WHERE id='ref-sheet'))`);
    const before = legacyEvidence();
    const inRuntime = <T>(
      work: (tx: Prisma.TransactionClient) => Promise<T>,
      options?: ReturnType<ShadowComparisonBudget['transactionOptions']>,
    ) =>
      runtime.$transaction(async (tx) => {
        const identity = await tx.$queryRaw<
          Array<{ identity: string; oldWrite: boolean; auditRead: boolean }>
        >`
          SELECT SESSION_USER::TEXT AS identity,
            has_table_privilege(CURRENT_USER,'public."AttendanceRecord"','INSERT,UPDATE,DELETE') AS "oldWrite",
            has_table_privilege(CURRENT_USER,'public.audit_logs','SELECT') AS "auditRead"
        `;
        expect(identity).toEqual([
          { identity: fixtureRole('runtime'), oldWrite: false, auditRead: false },
        ]);
        return work(tx);
      }, options);
    try {
      await primary
        .$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('srvf.shadow_login_fixture_password',${password},TRUE)`;
          await tx.$executeRawUnsafe(
            fixtureStatement(`DO $fixture_login$ BEGIN
          EXECUTE format('ALTER ROLE srvf_shadow_runtime_w98_fixture LOGIN PASSWORD %L',
            current_setting('srvf.shadow_login_fixture_password'));
          GRANT CONNECT ON DATABASE app_test_w98 TO srvf_shadow_runtime_w98_fixture;
        END $fixture_login$;`),
          );
        })
        .catch(() => {
          throw new Error('isolated LOGIN fixture setup failed');
        });
      const invalidConnection = new URL(connection.toString());
      invalidConnection.password = randomUUID();
      const invalid = new PrismaClient({ datasourceUrl: invalidConnection.toString() });
      try {
        // A trust-authenticated socket is not proof of independent credentials.
        const wrongPasswordAccepted = await invalid.$connect().then(
          () => true,
          () => false,
        );
        expect(wrongPasswordAccepted).toBe(false);
      } finally {
        await invalid.$disconnect();
      }
      await runtime.$connect().catch(() => {
        throw new Error('isolated runtime LOGIN failed');
      });
      for (const statement of [
        'UPDATE public."AttendanceRecord" SET "roleCode"="roleCode" WHERE FALSE',
        'SELECT id FROM public.audit_logs LIMIT 0',
        'SELECT public.csm_application_set_guard_fn()',
        'SELECT public.cscr_insert_set_guard_fn()',
      ]) {
        const denied = await runtime.$executeRawUnsafe(statement).then(
          () => false,
          (error: unknown) =>
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2010' &&
            error.meta?.code === '42501',
        );
        expect(denied).toBe(true);
      }
      const prepared = await primary.$transaction(async (tx) => {
        const source = await tx.contributionShadowLegacySourceAnchor.findUniqueOrThrow({
          where: { id: 'ref-source' },
        });
        const audit = await tx.auditLog.findUniqueOrThrow({
          where: { id: source.auditLogId },
          select: { createdAt: true },
        });
        const query = new ActivityContributionShadowMappingProofQuery();
        const mappingHistory = await query.readComparisonMappingHistory(tx, {
          activityId: source.activityId,
          sourceTime: audit.createdAt,
        });
        const selectionRevision = await query.readSelectionAtSource(tx, {
          activityId: source.activityId,
          sourceTime: audit.createdAt,
        });
        const positions = await query.readComparisonPositions(tx, {
          activityId: source.activityId,
          positionIds: mappingHistory.map((event) => event.sessionPositionId),
        });
        const policyVersions = await query.readComparisonPolicyVersions(
          tx,
          mappingHistory.map((event) => ({
            id: event.policyVersionId,
            definitionHash: event.policyDefinitionHash,
            evaluatorVersion: event.evaluatorVersion,
          })),
        );
        return prepareShadowComparisonSet({
          context: {
            windowId: source.windowId,
            auditLogId: source.auditLogId,
            sheetId: source.sheetId,
            activityId: source.activityId,
            sheetVersion: source.sheetVersion,
            signedMappingVersion: 'fixture-v1',
          },
          expectedRecordIds: [source.recordId],
          sources: [source],
          sourceTime: audit.createdAt,
          mappingHistory,
          selectionRevision,
          positions,
          policyVersions,
        });
      });
      expect(prepared.comparisons).toHaveLength(1);
      expect(prepared.comparisons[0].classificationCode).toBe('points_mismatch');
      const started = await inRuntime((tx) => writer.readOrCreateAttempt(tx, prepared.attempt));
      expect(started.replayed).toBe(false);
      expect(started.attempt.terminal).toBeNull();
      expect(await primary.contributionShadowAttemptReceipt.count()).toBe(1);

      const injected = new Error('isolated fault before comparison commit');
      await expect(
        inRuntime(async (tx) => {
          const terminal = await writer.writeCompleteComparisonSet(
            tx,
            started.attempt,
            prepared.applications,
            prepared.comparisons,
          );
          expect(terminal).toMatchObject({
            statusCode: 'complete',
            writtenRecordCount: 1,
            mismatchCount: 1,
          });
          throw injected;
        }),
      ).rejects.toBe(injected);
      expect(await primary.contributionShadowAttemptReceipt.count()).toBe(1);
      expect(await primary.contributionShadowMappingApplication.count()).toBe(0);
      expect(await primary.contributionShadowComparisonReceipt.count()).toBe(0);
      expect(await primary.contributionShadowTerminalReceipt.count()).toBe(0);
      expect(legacyEvidence()).toBe(before);

      const failed = await inRuntime((tx) => writer.writeFailedTerminal(tx, started.attempt));
      expect(failed.replayed).toBe(false);
      expect(failed.terminal).toMatchObject({
        statusCode: 'failed',
        expectedRecordCount: 1,
        writtenRecordCount: 0,
        equalCount: 0,
        mismatchCount: 0,
        holdCount: 0,
        errorCount: 0,
        failureCode: 'shadow_comparison_failed',
      });
      const replay = await inRuntime((tx) => writer.readOrCreateAttempt(tx, prepared.attempt));
      expect(replay.replayed).toBe(true);
      expect(replay.attempt.id).toBe(started.attempt.id);
      expect(replay.attempt.terminal).toEqual(failed.terminal);
      const recoveryReplay = await inRuntime((tx) =>
        writer.writeFailedTerminal(tx, started.attempt),
      );
      expect(recoveryReplay).toEqual({ terminal: failed.terminal, replayed: true });
      expect(await primary.contributionShadowTerminalReceipt.count()).toBe(1);
      expect(legacyEvidence()).toBe(before);

      // Fresh synthetic old outcome, distinct audit/sheet/Record IDs. Every
      // record has its own member: this does not manufacture overlapping facts
      // for one person or replace missing source proof with a result hash.
      sql(`BEGIN;
        INSERT INTO "Member" (id,"memberNo","realName","memberSinceDate","memberOriginCode","updatedAt")
          SELECT 'bulk-member-'||n,'BULK135-'||n,'Isolated bulk fixture',CURRENT_TIMESTAMP,'manual',CURRENT_TIMESTAMP
          FROM generate_series(1,2000) n;
        INSERT INTO "AttendanceSheet" (id,"activityId","submitterUserId","statusCode","updatedAt",version)
          VALUES ('bulk-sheet','ref-activity','ref-user','pending_review',CURRENT_TIMESTAMP,1);
        INSERT INTO "AttendanceRecord" (id,"sheetId","memberId","roleCode","checkInAt","checkOutAt",
          "serviceHours","attendanceStatusCode","contributionPoints","updatedAt")
          SELECT 'bulk-record-'||n,'bulk-sheet','bulk-member-'||n,'volunteer','2099-10-01'::timestamptz,
            '2099-10-01 01:00'::timestamptz,1.00,'present',2.00,CURRENT_TIMESTAMP
          FROM generate_series(1,2000) n;
        INSERT INTO audit_logs (id,"createdAt","resourceType","resourceId",event,context,"shadowProofRequired")
          SELECT 'bulk-audit','2099-10-01 12:00','attendance_sheet','bulk-sheet','attendance-sheet.submit',
            jsonb_build_object('after',jsonb_build_object(
              'sheet',jsonb_build_object('activityId','ref-activity','version',1),
              'records',jsonb_agg(jsonb_build_object('id',id,'memberId',"memberId",'roleCode',"roleCode",
                'serviceHours','1','contributionPoints','2') ORDER BY id)),
              'extra',jsonb_build_object('operation','submit','recordsCount',2000)),true
          FROM "AttendanceRecord" WHERE "sheetId"='bulk-sheet';
        INSERT INTO "ContributionShadowLegacySourceAnchor" (id,"windowId","auditLogId","sheetId","sheetVersion",
          "activityId","recordId","memberId","activityTypeCode","attendanceRoleCode","legacyServiceHours",
          "sourceKindCode","legacyRuleId","pointsBelow","legacyPoints","hashAlgorithmCode","canonicalVersion","legacySourceHash")
          SELECT 'bulk-source-'||id,'ref-window','bulk-audit','bulk-sheet',1,'ref-activity',id,"memberId",
            'service','volunteer',1.00,'matched','ref-rule',2.00,2.00,'sha256',1,
            cslsa_source_hash_fn(jsonb_populate_record(NULL::"ContributionShadowLegacySourceAnchor",jsonb_build_object(
              'windowId','ref-window','auditLogId','bulk-audit','sheetId','bulk-sheet','sheetVersion',1,
              'activityId','ref-activity','recordId',id,'memberId',"memberId",'activityTypeCode','service',
              'attendanceRoleCode','volunteer','legacyServiceHours',1.00,'sourceKindCode','matched',
              'legacyRuleId','ref-rule','pointsBelow',2.00,'legacyPoints',2.00)))
          FROM "AttendanceRecord" WHERE "sheetId"='bulk-sheet';
        COMMIT;`);
      await assertDiagnosticObserver();
      const plannerStats = await primary.$queryRaw`
        SELECT c.relname AS table_name, c.reltuples::DOUBLE PRECISION AS estimated_rows,
          c.relpages, s.n_live_tup::DOUBLE PRECISION AS reported_live_rows,
          s.n_mod_since_analyze::DOUBLE PRECISION AS modified_since_analyze,
          s.last_analyze IS NOT NULL AS analyzed, s.last_autoanalyze IS NOT NULL AS autoanalyzed,
          current_setting('jit') AS jit, current_setting('jit_above_cost') AS jit_above_cost
        FROM pg_class c JOIN pg_stat_user_tables s ON s.relid=c.oid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname IN (
          'ContributionShadowLegacySourceAnchor','ContributionShadowMappingApproval',
          'ContributionShadowMappingApplication','ContributionShadowComparisonReceipt')
        ORDER BY c.relname
      `;
      // Cold runtime connection belongs to this one countdown, not fixture prep.
      await runtime.$disconnect();
      const budget = new ShadowComparisonBudget();
      const began = performance.now();
      let stage = 'prepare';
      const phaseTimes = { beforeComparisonMs: 0, comparisonTimeoutMs: 0, poolWaitMs: 0 };
      const diagnosticRows: DiagnosticRow[] = [];
      const plans: MappingPlanDiagnostic[] = [];
      let rollbackPlanProbe: (() => void) | undefined;
      try {
        const bulk = await primary.$transaction(async (originalTx) => {
          const tx = diagnosticTx(originalTx, diagnosticRows);
          const sources = await tx.contributionShadowLegacySourceAnchor.findMany({
            where: { auditLogId: 'bulk-audit' },
          });
          const audit = await tx.auditLog.findUniqueOrThrow({
            where: { id: 'bulk-audit' },
            select: { createdAt: true },
          });
          const query = new ActivityContributionShadowMappingProofQuery();
          const mappingHistory = await query.readComparisonMappingHistory(tx, {
            activityId: 'ref-activity',
            sourceTime: audit.createdAt,
          });
          const selectionRevision = await query.readSelectionAtSource(tx, {
            activityId: 'ref-activity',
            sourceTime: audit.createdAt,
          });
          const positions = await query.readComparisonPositions(tx, {
            activityId: 'ref-activity',
            positionIds: mappingHistory.map((event) => event.sessionPositionId),
          });
          const policyVersions = await query.readComparisonPolicyVersions(
            tx,
            mappingHistory.map((event) => ({
              id: event.policyVersionId,
              definitionHash: event.policyDefinitionHash,
              evaluatorVersion: event.evaluatorVersion,
            })),
          );
          const pureBegan = performance.now();
          const cpuBegan = process.cpuUsage();
          const preparedSet = prepareShadowComparisonSet({
            context: {
              windowId: 'ref-window',
              auditLogId: 'bulk-audit',
              sheetId: 'bulk-sheet',
              activityId: 'ref-activity',
              sheetVersion: 1,
              signedMappingVersion: 'fixture-v1',
            },
            expectedRecordIds: sources.map((source) => source.recordId),
            sources,
            sourceTime: audit.createdAt,
            mappingHistory,
            selectionRevision,
            positions,
            policyVersions,
          });
          const cpu = process.cpuUsage(cpuBegan);
          diagnosticRows.push({
            label: 'prepare.pure.wall',
            elapsedMs: performance.now() - pureBegan,
            outcome: 'ok',
            code: '',
          });
          diagnosticRows.push({
            label: 'prepare.pure.cpu',
            elapsedMs: (cpu.user + cpu.system) / 1000,
            outcome: 'ok',
            code: '',
          });
          return preparedSet;
        }, budget.transactionOptions());
        expect(bulk.applications).toHaveLength(2000);
        expect(bulk.comparisons).toHaveLength(2000);
        expect(bulk.comparisons.every((row) => row.classificationCode === 'points_mismatch')).toBe(
          true,
        );
        diagnosticRows.push({
          label: 'prepare.total',
          elapsedMs: performance.now() - began,
          outcome: 'ok',
          code: '',
        });
        stage = 'start';
        const startBegan = performance.now();
        const bulkStart = await runtimeProvider.withBoundedRuntimeClient(
          budget,
          (client, options) => {
            expect(client).toBe(runtime);
            return inRuntime((tx) => writer.readOrCreateAttempt(tx, bulk.attempt), options);
          },
        );
        if (!bulkStart) throw new Error('isolated runtime unexpectedly disabled');
        diagnosticRows.push({
          label: 'start.total',
          elapsedMs: performance.now() - startBegan,
          outcome: 'ok',
          code: '',
        });
        if (process.env.SRVF_E3_D2_BULK_EXPLAIN_W98 === '1') {
          rollbackPlanProbe = () => {
            const insert = (
              table: 'ContributionShadowMappingApplication' | 'ContributionShadowComparisonReceipt',
              rows: Array<Record<string, unknown>>,
            ) => {
              const columns = Object.keys(rows[0]);
              if (columns.some((column) => !/^[A-Za-z][A-Za-z0-9]*$/.test(column)))
                throw new Error('isolated plan probe column mismatch');
              const names = columns.map((column) => `"${column}"`).join(',');
              const projection = columns.map((column) => `r."${column}"`).join(',');
              const data = JSON.stringify(rows).replaceAll("'", "''");
              return `INSERT INTO "${table}" (${names}) SELECT ${projection}
                FROM jsonb_populate_recordset(NULL::"${table}",'${data}'::jsonb) r;`;
            };
            // Explicit opt-in, rollback-only SQL plan probe, not a retried
            // application command or a changed five-second business timeout.
            const plan = JSON.parse(
              sql(`BEGIN;
              SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
              ${insert(
                'ContributionShadowMappingApplication',
                bulk.applications.map((row) => ({ ...row, id: randomUUID() })),
              )}
              EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
              ${insert(
                'ContributionShadowComparisonReceipt',
                bulk.comparisons.map((row) => ({
                  ...row,
                  id: randomUUID(),
                  attemptId: bulkStart.attempt.id,
                })),
              )}
              ROLLBACK;`),
            ) as Array<{
              'Execution Time': number;
              Triggers?: Array<{ 'Trigger Name': string; Time: number; Calls: number }>;
            }>;
            console.info(
              '[shadow-w98-comparison-plan] ' +
                JSON.stringify({
                  executionMs: plan[0]['Execution Time'],
                  triggers: (plan[0].Triggers ?? []).map((trigger) => ({
                    name: trigger['Trigger Name'],
                    durationMs: trigger.Time,
                    calls: trigger.Calls,
                  })),
                }),
            );
            expect(
              sql(`SELECT count(*) FROM "ContributionShadowComparisonReceipt"
              WHERE "attemptId"='${bulkStart.attempt.id.replaceAll("'", "''")}'`),
            ).toBe('0');
            expect(
              sql(
                `SELECT count(*) FROM "ContributionShadowMappingApplication" WHERE "auditLogId"='bulk-audit'`,
              ),
            ).toBe('0');
          };
        }
        phaseTimes.beforeComparisonMs = Math.round(performance.now() - began);
        stage = 'comparison';
        const bulkTerminal = await runtimeProvider.withBoundedRuntimeClient(
          budget,
          (client, options) => {
            expect(client).toBe(runtime);
            phaseTimes.comparisonTimeoutMs = options.timeout;
            phaseTimes.poolWaitMs = options.maxWait;
            return inRuntime(
              (tx) =>
                writer.writeCompleteComparisonSet(
                  diagnosticTx(tx, diagnosticRows, '', plans),
                  bulkStart.attempt,
                  bulk.applications,
                  bulk.comparisons,
                ),
              options,
            );
          },
        );
        expect(bulkTerminal).toMatchObject({
          statusCode: 'complete',
          expectedRecordCount: 2000,
          writtenRecordCount: 2000,
          mismatchCount: 2000,
          equalCount: 0,
          holdCount: 0,
          errorCount: 0,
        });
        expect(performance.now() - began).toBeLessThan(5000);
        console.info(
          `[shadow-w98-bulk] status=complete elapsedMs=${Math.round(performance.now() - began)} records=2000`,
        );
        expect(legacyEvidence()).toBe(before);
        // Outside the unchanged business budget: fixed old SQL versus the actual
        // function on all 2,000 committed fixture anchors. Timing is evidence,
        // not a flaky performance assertion or a replacement for the five-second chain.
        const hashProbe: {
          records: number;
          matches: number;
          referenceMs: number;
          actualMs: number;
        } = JSON.parse(
          sql(`BEGIN;
          ${SOURCE_HASH_REFERENCE_SQL}
          CREATE TEMP TABLE source_hash_probe(records INTEGER,matches INTEGER,reference_ms NUMERIC,actual_ms NUMERIC);
          DO $probe$
          DECLARE s "ContributionShadowLegacySourceAnchor"; started TIMESTAMPTZ;
            reference_ms NUMERIC; actual_ms NUMERIC; checked INTEGER; matched INTEGER;
          BEGIN
            SELECT count(*),count(*) FILTER (WHERE cslsa_source_hash_fn(a) = pg_temp.reference_source_hash_fn(a))
              INTO checked,matched FROM "ContributionShadowLegacySourceAnchor" a WHERE "auditLogId"='bulk-audit';
            started:=clock_timestamp();
            FOR s IN SELECT * FROM "ContributionShadowLegacySourceAnchor" WHERE "auditLogId"='bulk-audit' ORDER BY id LOOP
              PERFORM pg_temp.reference_source_hash_fn(s);
            END LOOP;
            reference_ms:=extract(epoch FROM clock_timestamp()-started)*1000;
            started:=clock_timestamp();
            FOR s IN SELECT * FROM "ContributionShadowLegacySourceAnchor" WHERE "auditLogId"='bulk-audit' ORDER BY id LOOP
              PERFORM cslsa_source_hash_fn(s);
            END LOOP;
            actual_ms:=extract(epoch FROM clock_timestamp()-started)*1000;
            INSERT INTO source_hash_probe VALUES(checked,matched,reference_ms,actual_ms);
          END $probe$;
          SELECT jsonb_build_object('records',records,'matches',matches,'referenceMs',reference_ms,'actualMs',actual_ms)
            FROM source_hash_probe; ROLLBACK;`),
        );
        expect(hashProbe.records).toBe(2000);
        expect(hashProbe.matches).toBe(2000);
        console.info('[shadow-source-hash-diff] ' + JSON.stringify(hashProbe));
      } catch (error) {
        const code =
          error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2028'
            ? 'P2028'
            : 'other';
        console.info(
          `[shadow-w98-bulk] stage=${stage} elapsedMs=${Math.round(performance.now() - began)} class=${code}`,
        );
        console.info('[shadow-w98-bulk] phases=' + JSON.stringify(phaseTimes));
        console.info('[shadow-comparison-error] ' + diagnosticCode(error));
        rollbackPlanProbe?.();
        throw new Error('isolated 2,000-record shadow comparison failed its unchanged budget');
      } finally {
        console.info(
          '[shadow-comparison-diagnostic] ' +
            JSON.stringify({ plannerStats, plans, rows: summarizeDiagnostics(diagnosticRows) }),
        );
      }
      // Separate from (and after) the unchanged five-second budget above.
      // Use actual independent LOGIN connections, not an owner SET ROLE mock.
      const contender = new PrismaClient({ datasourceUrl: connection.toString() });
      const signal = () => {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => (resolve = done));
        return { promise, resolve };
      };
      const waitBlocked = async (pid: number) => {
        const deadline = performance.now() + 4000;
        while (performance.now() < deadline) {
          const rows = await primary.$queryRaw<Array<{ blocked: boolean }>>`
            SELECT cardinality(pg_blocking_pids(pid)) > 0 AS blocked
            FROM pg_stat_activity WHERE datname = current_database() AND pid = ${pid}
          `;
          if (rows[0]?.blocked) return;
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        throw new Error('isolated guard did not reach its real lock');
      };
      try {
        await contender.$connect().catch(() => {
          throw new Error('isolated contender LOGIN failed');
        });
        const identity = await contender.$queryRaw<Array<{ name: string }>>`
          SELECT SESSION_USER::TEXT AS name
        `;
        expect(identity).toEqual([{ name: fixtureRole('runtime') }]);
        const held = signal();
        const release = signal();
        const waiterReady = signal();
        let waiterPid = 0;
        const holder = primary.$transaction(async (tx) => {
          await tx.$executeRaw`UPDATE "ActivitySessionPosition" SET "deletedAt"=CURRENT_TIMESTAMP
            WHERE id='ref-position'`;
          held.resolve();
          await release.promise;
        });
        const holderResult = holder.then(
          () => null,
          (error: unknown) => error,
        );
        let waiterResult: Promise<unknown> | undefined;
        try {
          await Promise.race([held.promise, holder]);
          waiterResult = contender
            .$transaction(async (tx) => {
              [{ pid: waiterPid }] = await tx.$queryRaw<
                Array<{ pid: number }>
              >`SELECT pg_backend_pid() AS pid`;
              waiterReady.resolve();
              await tx.$executeRawUnsafe(applicationInsertSql());
            })
            .then(
              () => null,
              (error: unknown) => error,
            );
          await Promise.race([
            waiterReady.promise,
            waiterResult.then((error) => {
              if (error instanceof Error) throw error;
              throw new Error('isolated waiter ended before its lock probe');
            }),
          ]);
          await waitBlocked(waiterPid);
          release.resolve();
          expect(await holderResult).toBeNull();
          const rejected = await waiterResult;
          expect(rejected).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
          expect((rejected as Error).message).toContain(
            'shadow mapping actual position unavailable',
          );
          expect(
            await primary.contributionShadowMappingApplication.count({
              where: { id: 'ref-application' },
            }),
          ).toBe(0);
        } finally {
          release.resolve();
          await holderResult;
          await waiterResult;
          await primary.$executeRaw`UPDATE "ActivitySessionPosition" SET "deletedAt"=NULL WHERE id='ref-position'`;
        }

        // A separate synthetic source/attempt, leaving all earlier evidence and
        // assertions unchanged. Its first comparison commits while the second
        // connection is demonstrably waiting on that same attempt's real lock.
        sql(`BEGIN;
          INSERT INTO public.audit_logs SELECT (jsonb_populate_record(NULL::public.audit_logs,
            to_jsonb(a)||jsonb_build_object('id','set-lock-audit'))).* FROM public.audit_logs a WHERE id='ref-source-audit';
          INSERT INTO "ContributionShadowLegacySourceAnchor"
            SELECT (s).* FROM (SELECT jsonb_populate_record(NULL::"ContributionShadowLegacySourceAnchor",
              to_jsonb(a)||jsonb_build_object('id','set-lock-source','auditLogId','set-lock-audit',
                'legacySourceHash',cslsa_source_hash_fn(jsonb_populate_record(NULL::"ContributionShadowLegacySourceAnchor",
                  to_jsonb(a)||jsonb_build_object('id','set-lock-source','auditLogId','set-lock-audit'))))) s
              FROM "ContributionShadowLegacySourceAnchor" a WHERE id='ref-source') changed;
          SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
          ${applicationInsertSql({ id: 'set-lock-application', legacySourceAnchorId: 'set-lock-source', auditLogId: 'set-lock-audit' })}
          ${attemptInsertSql().replaceAll('ref-attempt', 'set-lock-attempt').replaceAll('ref-source-audit', 'set-lock-audit')}
          RESET SESSION AUTHORIZATION; SET CONSTRAINTS ALL IMMEDIATE; COMMIT;`);
        const firstInserted = signal();
        const commitFirst = signal();
        const secondReady = signal();
        let secondPid = 0;
        const comparison = (id: string) =>
          comparisonInsertSql({ id, attemptId: 'set-lock-attempt' }).replace(
            "WHERE id='ref-source'",
            "WHERE id='set-lock-source'",
          );
        const first = runtime.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(comparison('set-lock-first'));
          firstInserted.resolve();
          await commitFirst.promise;
        });
        const firstResult = first.then(
          () => null,
          (error: unknown) => error,
        );
        let secondResult: Promise<unknown> | undefined;
        try {
          await Promise.race([firstInserted.promise, first]);
          secondResult = contender
            .$transaction(async (tx) => {
              [{ pid: secondPid }] = await tx.$queryRaw<
                Array<{ pid: number }>
              >`SELECT pg_backend_pid() AS pid`;
              secondReady.resolve();
              await tx.$executeRawUnsafe(comparison('set-lock-second'));
            })
            .then(
              () => null,
              (error: unknown) => error,
            );
          await Promise.race([
            secondReady.promise,
            secondResult.then((error) => {
              if (error instanceof Error) throw error;
              throw new Error('isolated count waiter ended before its lock probe');
            }),
          ]);
          await waitBlocked(secondPid);
          commitFirst.resolve();
          expect(await firstResult).toBeNull();
          const rejected = await secondResult;
          expect(rejected).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
          expect((rejected as Error).message).toContain('shadow comparison exceeds expected set');
          expect(
            await primary.contributionShadowComparisonReceipt.count({
              where: { attemptId: 'set-lock-attempt' },
            }),
          ).toBe(1);
          expect(
            await primary.contributionShadowComparisonReceipt.count({
              where: { id: 'set-lock-second' },
            }),
          ).toBe(0);
          expect(
            await primary.contributionShadowTerminalReceipt.count({
              where: { attemptId: 'set-lock-attempt' },
            }),
          ).toBe(0);
          console.info(
            '[shadow-w98-set-locks] positionReread=pass attemptCountReread=pass realLogin=true',
          );
        } finally {
          commitFirst.resolve();
          await firstResult;
          await secondResult;
        }
        // Opposite attempt order is deliberately not reordered by the new
        // statement guard. Prove an actual deadlock abort is atomic, not retried.
        for (const side of ['left', 'right'] as const) {
          sql(`BEGIN;
            INSERT INTO public.audit_logs SELECT (jsonb_populate_record(NULL::public.audit_logs,
              to_jsonb(a)||jsonb_build_object('id','cross-${side}-audit'))).* FROM public.audit_logs a WHERE id='ref-source-audit';
            INSERT INTO "ContributionShadowLegacySourceAnchor"
              SELECT (s).* FROM (SELECT jsonb_populate_record(NULL::"ContributionShadowLegacySourceAnchor",
                to_jsonb(a)||jsonb_build_object('id','cross-${side}-source','auditLogId','cross-${side}-audit',
                  'legacySourceHash',cslsa_source_hash_fn(jsonb_populate_record(NULL::"ContributionShadowLegacySourceAnchor",
                    to_jsonb(a)||jsonb_build_object('auditLogId','cross-${side}-audit'))))) s
                FROM "ContributionShadowLegacySourceAnchor" a WHERE id='ref-source') changed;
            SET SESSION AUTHORIZATION srvf_shadow_runtime_w98_fixture;
            ${applicationInsertSql({ id: `cross-${side}-application`, legacySourceAnchorId: `cross-${side}-source`, auditLogId: `cross-${side}-audit` })}
            ${attemptInsertSql().replaceAll('ref-attempt', `cross-${side}-attempt`).replaceAll('ref-source-audit', `cross-${side}-audit`)}
            RESET SESSION AUTHORIZATION; SET CONSTRAINTS ALL IMMEDIATE; COMMIT;`);
        }
        const leftHeld = signal();
        const rightHeld = signal();
        const cross = signal();
        const crossInsert = (side: string, caller: string) =>
          comparisonInsertSql({
            id: `cross-${caller}-${side}`,
            attemptId: `cross-${side}-attempt`,
          }).replace("WHERE id='ref-source'", `WHERE id='cross-${side}-source'`);
        const left = runtime.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(crossInsert('left', 'one'));
          leftHeld.resolve();
          await cross.promise;
          await tx.$executeRawUnsafe(crossInsert('right', 'one'));
        });
        const right = contender.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(crossInsert('right', 'two'));
          rightHeld.resolve();
          await cross.promise;
          await tx.$executeRawUnsafe(crossInsert('left', 'two'));
        });
        const outcomes = Promise.allSettled([left, right]);
        try {
          await Promise.all([
            Promise.race([leftHeld.promise, left]),
            Promise.race([rightHeld.promise, right]),
          ]);
          cross.resolve();
          const result = await outcomes;
          expect(result.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
          const rejected = result.find((entry) => entry.status === 'rejected');
          expect(rejected?.status).toBe('rejected');
          if (!rejected || rejected.status !== 'rejected')
            throw new Error('cross-attempt conflict missing');
          const failure: unknown = rejected.reason;
          expect(failure).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
          expect((failure as Prisma.PrismaClientKnownRequestError).meta?.code).toBe('40P01');
          const loser = result[0].status === 'rejected' ? 'one' : 'two';
          expect(
            await primary.contributionShadowComparisonReceipt.count({
              where: {
                id: { in: [`cross-${loser}-left`, `cross-${loser}-right`] },
              },
            }),
          ).toBe(0);
          for (const side of ['left', 'right']) {
            expect(
              await primary.contributionShadowComparisonReceipt.count({
                where: { attemptId: `cross-${side}-attempt` },
              }),
            ).toBe(1);
            expect(
              await primary.contributionShadowTerminalReceipt.count({
                where: { attemptId: `cross-${side}-attempt` },
              }),
            ).toBe(0);
          }
          console.info(
            '[shadow-w98-cross-attempt] committed=1 aborted=1 sqlstate=40P01 loserRows=0 retries=0',
          );
        } finally {
          cross.resolve();
          await outcomes;
        }
      } finally {
        await contender.$disconnect();
      }
    } finally {
      await runtimeProvider.onModuleDestroy();
      await primary.$executeRawUnsafe(
        fixtureStatement('ALTER ROLE srvf_shadow_runtime_w98_fixture NOLOGIN PASSWORD NULL'),
      );
      await primary.$executeRawUnsafe(
        fixtureStatement(
          'REVOKE CONNECT ON DATABASE app_test_w98 FROM srvf_shadow_runtime_w98_fixture',
        ),
      );
      await primary.$disconnect();
    }
  }, 120_000);
});

scratchLifecycle.finish();
