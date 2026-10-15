import {
  createE4MaximumStageReceipt,
  restoreE4MaximumStageOpening,
  restoreE4HistoricalCatalogOpening,
} from '../helpers/e4-maximum-stage-receipt';
import { PrismaClient, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { ScratchLeaseSession } from '../helpers/scratch-database-lease';
import { E4PreparePhaseDiagnostic } from '../helpers/e4-prepare-phase-diagnostic';
import { E4EngineRequestWaitDiagnostic } from '../helpers/e4-engine-request-wait-diagnostic';
// E4_GUARD_PLAN_IMPORT_BEGIN
import {
  E4GuardPlanDiagnostic,
  guardPlanDiagnosticEnabled,
} from '../helpers/e4-guard-plan-diagnostic';
// E4_GUARD_PLAN_IMPORT_END
// E4_GUARD_FUNCTION_IMPORT_BEGIN
import {
  E4GuardFunctionDiagnostic,
  guardFunctionDiagnosticEnabled,
} from '../helpers/e4-guard-function-diagnostic';
// E4_GUARD_FUNCTION_IMPORT_END
import {
  closeE13Fixture,
  createE4Fixture,
  createMaximumE4Source,
  e4Actor,
  E4_META,
  installE4ValidationDatabase,
  postE4Ledger,
  type E4Fixture,
} from '../helpers/activity-contribution-policy.fixture';
import { assertConnectedTestDatabase, assertTestDatabaseUrl } from '../setup/test-db';
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
import {
  SettlementReviewService,
  type SettlementReviewInput,
} from '../../src/modules/activities/settlement-review.service';
import {
  TIME_SETTLEMENT_PREPARE_OPERATION,
  timeSettlementPrepareRequestHash,
} from '../../src/modules/activities/activity-time-settlement-command';

/** Observe the actual instance bridge; preserve this, all arguments, options and the original Promise. */
function observeEngineTransactions(db: PrismaClient) {
  const engine: unknown = Reflect.get(db, '_engine');
  if (engine === null || typeof engine !== 'object')
    throw new Error('Actual Prisma engine missing');
  const original: unknown = Reflect.get(engine, 'transaction');
  if (typeof original !== 'function') throw new Error('Actual engine transaction bridge missing');
  const descriptor = Object.getOwnPropertyDescriptor(engine, 'transaction');
  const phases: { phase: string; elapsedMs: number; outcome: string }[] = [];
  Object.defineProperty(engine, 'transaction', {
    configurable: true,
    writable: true,
    value: function (this: object, ...args: unknown[]) {
      const started = performance.now();
      const result = Reflect.apply(original, this, args) as Promise<unknown>;
      const phase = ['start', 'commit', 'rollback'].includes(String(args[0]))
        ? String(args[0])
        : 'other';
      void result.then(
        () => {
          phases.push({ phase, elapsedMs: performance.now() - started, outcome: 'ok' });
        },
        () => {
          phases.push({ phase, elapsedMs: performance.now() - started, outcome: 'error' });
        },
      );
      return result;
    },
  });
  return {
    phases,
    restore: () => {
      if (descriptor) Object.defineProperty(engine, 'transaction', descriptor);
      else Reflect.deleteProperty(engine, 'transaction');
      expect(Reflect.get(engine, 'transaction')).toBe(original);
    },
  };
}

class ObservedE4Database extends PrismaClient<Prisma.PrismaClientOptions, 'query'> {
  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}

// E4_TERMINAL_HELPERS_BEGIN
import { e4NativeMeasurementDatabase } from '../helpers/e4-native-measurement-owner';
import { E4_D1_SCOPE } from '../helpers/e4-d1-result-capture';
function terminalHash(source: string, algorithm: 'sha256' | 'md5' = 'sha256') {
  return createHash(algorithm).update(source).digest('hex');
}
const E4_TERMINAL_BASE_SHA = '0451639ac145d3350e2774ae6b47f900ae021700581fdb645e7cd53787a679e3';
const E4_TERMINAL_REFS_SHA = 'e992dd2ea197be9695d0ac58074d697fc503749314d8eddb27da2c7cb5268cea';
const E4_TERMINAL_ACTUAL_SHA = '90f09f61ef65753a00b885cd960e9f85ee8d9ed9ff39f2c55c2f7d5942fb0e61';
const E4_TERMINAL_OPENING_SHA = '5dba9f0e34a1f8b94023c7ff8f1fcf4c72f164c6fe60e0268a12829632446f6a';
const E4_TERMINAL_OLD_FUNCTION_SHA =
  '83e4ca6eb3e7d29e38f8e7849a742fa64bf946a946a165fe8b3f0d7e3444bc77';
const E4_TERMINAL_BASE_FUNCTION_SHA =
  '8bf4c94277847cefce1419473e1bd885474388b07ab6d5c53db15094b847c493';
const E4_TERMINAL_REFS_FUNCTION_SHA =
  'e6a6a7598ab1bce4ea2c6c671526068e7abbcc69e586c40196a258ae0b4e1ca1';
const E4_TERMINAL_NEW_FUNCTION_SHA =
  '47bbe7aae8da7e51619533ff683a429121f42f0ee4c041bbc7c77d94ea53ddf0';
const E4_TERMINAL_OLD_BODY_MD5 = 'eece3521b68d7ba6c67809866443c3ff';
const E4_TERMINAL_BASE_BODY_MD5 = 'bf0d83d19b83f9297717db6d0e4bbb66';
const E4_TERMINAL_REFS_BODY_MD5 = 'ed1cfd1c84d844d8151401404a32f174';
const E4_TERMINAL_NEW_BODY_MD5 = '96c7319edc1e1a6c5695d1e649acd87a';
const E4_TERMINAL_REFS_BODY_BYTES = 4070;
const E4_TERMINAL_NEW_BODY_BYTES = 4362;
function terminalExpectedDefinition(source: string) {
  const matches = [
    ...source.matchAll(
      /CREATE FUNCTION e4_expected_evaluations\(revision_id TEXT\)\nRETURNS TABLE\(unit_canonical TEXT,evaluation JSONB\)\nLANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS \$\$([\s\S]*?)\$\$;(?=\n)/gu,
    ),
  ];
  if (matches.length !== 1) throw new Error('Terminal expected definition missing or ambiguous');
  return { definition: matches[0][0], body: matches[0][1] };
}
function terminalFrozenExpected() {
  const fixture = readFileSync(
    resolve(__dirname, 'activity-os-r5-e4-contribution-settlement-migration.e2e-spec.ts'),
    'utf8',
  );
  const matches = [
    ...fixture.matchAll(
      /const E4_TERMINAL_EXPECTED_OPENING_SQL = String\.raw\x60([\s\S]*?)\x60;/gu,
    ),
  ];
  if (matches.length !== 1) throw new Error('Terminal fixed complete opening missing');
  const frozen = terminalExpectedDefinition(matches[0][1]);
  if (
    terminalHash(frozen.definition) !== E4_TERMINAL_OLD_FUNCTION_SHA ||
    terminalHash(frozen.body, 'md5') !== E4_TERMINAL_OLD_BODY_MD5 ||
    Buffer.byteLength(frozen.body, 'utf8') !== 4044
  )
    throw new Error('Terminal complete opening bytes mismatch');
  return frozen;
}
function terminalOpeningBaseMigrationSource(source: string): string {
  if (terminalHash(source) !== E4_TERMINAL_BASE_SHA)
    throw new Error('Terminal actual complete migration mismatch');
  const current = terminalExpectedDefinition(source);
  if (
    terminalHash(current.definition) !== E4_TERMINAL_BASE_FUNCTION_SHA ||
    terminalHash(current.body, 'md5') !== E4_TERMINAL_BASE_BODY_MD5 ||
    Buffer.byteLength(current.body, 'utf8') !== 4048
  )
    throw new Error('Terminal actual complete function mismatch');
  const token = '), canonical_documents AS NOT MATERIALIZED (';
  if (current.definition.split(token).length !== 2)
    throw new Error('Terminal terminal-only token not unique');
  const opening = current.definition.replace(
    token,
    () => '), canonical_documents AS MATERIALIZED (',
  );
  if (opening !== terminalFrozenExpected().definition)
    throw new Error('Terminal independent complete opening inverse mismatch');
  const restored = source.replace(current.definition, () => opening);
  if (terminalHash(restored) !== E4_TERMINAL_OPENING_SHA)
    throw new Error('Terminal whole migration inverse mismatch');
  return restored;
}
/** Explicit historic input projection; it does not claim the old SHA is the new public SQL. */
function terminalHistoricalBooleanInput(source: string): string {
  if (terminalHash(source) === E4_TERMINAL_OPENING_SHA) {
    if (terminalExpectedDefinition(source).definition !== terminalFrozenExpected().definition)
      throw new Error('Terminal fixed historical input mismatch');
    return source;
  }
  return terminalOpeningMigrationSource(source);
}
function terminalActualSource() {
  return readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20261003000000_activity_contribution_settlement/migration.sql',
    ),
    'utf8',
  );
}
function terminalTemporaryDefinition() {
  const opening = terminalFrozenExpected().definition;
  const from = 'CREATE FUNCTION e4_expected_evaluations(';
  const to = 'CREATE FUNCTION pg_temp.e4_expected_evaluations_1234_opening(';
  if (opening.split(from).length !== 2) throw new Error('Terminal fixed create target ambiguous');
  const temporary = opening.replace(from, () => to);
  if (
    temporary.replace(to, () => from) !== opening ||
    terminalHash(temporary.replace(to, () => from)) !== E4_TERMINAL_OLD_FUNCTION_SHA
  )
    throw new Error('Terminal temporary full definition inverse mismatch');
  return temporary;
}
function terminalQualifyQuery(query: string, kind: 'old' | 'candidate', roots: 2 | 3): string {
  const from = 'e4_expected_evaluations($1::text)';
  const to =
    kind === 'old'
      ? 'pg_temp.e4_expected_evaluations_1234_opening($1::text)'
      : 'public.e4_expected_evaluations($1::text)';
  if (
    query.split(from).length !== 2 ||
    [...query.matchAll(/(?<![\w.])e4_expected_evaluations\(\$1::text\)/gu)].length !== 1 ||
    query.split('$1::text').length !== roots + 1
  )
    throw new Error('Terminal unique function/root input mismatch');
  const qualified = query.replace(from, () => to);
  if (
    qualified.replace(to, () => from) !== query ||
    qualified.split('$1::text').length !== roots + 1
  )
    throw new Error('Terminal qualified input full inverse mismatch');
  return qualified;
}
function terminalRequestBudget(ms: number) {
  if (!Number.isInteger(ms) || ms < 1 || ms > 30_000)
    throw new Error('Terminal remaining request deadline refused');
  return ms;
}
function terminalRemaining(deadline: number, now = performance.now()) {
  if (!Number.isFinite(deadline) || !Number.isFinite(now))
    throw new Error('Terminal actual deadline unavailable');
  return terminalRequestBudget(Math.min(30_000, Math.floor(deadline - now)));
}
type TerminalIdentity = { db: string; pid: number; session: string; principal: string };
type TerminalCatalog = {
  scope: 'public' | 'temporary';
  schema: string;
  pid: number;
  body: string;
  bytes: number;
  ownerMatches: boolean;
  owner: number;
  acl: unknown;
  language: string;
  volatility: string;
  strict: boolean;
  invoker: boolean;
  parallel: string;
  cost: number;
  rows: number;
  config: string[];
  args: string;
  result: string;
  defaults: number;
  defaultExpression: string | null;
  temporary: boolean;
};
const E4_TERMINAL_CATALOG_SQL =
  "SELECT CASE WHEN p.pronamespace=pg_my_temp_schema() THEN 'temporary' ELSE 'public' END AS scope," +
  ' n.nspname::text AS schema,pg_backend_pid() AS pid,md5(p.prosrc) AS body,octet_length(p.prosrc)::int AS bytes,' +
  ' pg_get_userbyid(p.proowner)=current_user AS "ownerMatches",p.proowner::int AS owner,to_jsonb(p.proacl) AS acl,' +
  ' l.lanname::text AS language,p.provolatile::text AS volatility,p.proisstrict AS strict,NOT p.prosecdef AS invoker,' +
  ' p.proparallel::text AS parallel,p.procost::float8 AS cost,p.prorows::float8 AS rows,p.proconfig AS config,' +
  ' pg_get_function_arguments(p.oid) AS args,pg_get_function_result(p.oid) AS result,' +
  ' p.pronargdefaults AS defaults,pg_get_expr(p.proargdefaults,0) AS "defaultExpression",' +
  ' p.pronamespace=pg_my_temp_schema() AS temporary FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace' +
  ' JOIN pg_language l ON l.oid=p.prolang WHERE p.oid IN (' +
  " to_regprocedure('public.e4_expected_evaluations(text)')," +
  " to_regprocedure('pg_temp.e4_expected_evaluations_1234_opening(text)')) ORDER BY scope";
function terminalAssertIdentity(
  actual: TerminalIdentity,
  expected: TerminalIdentity | Pick<TerminalIdentity, 'session' | 'principal'>,
) {
  if (
    actual.db !== e4NativeMeasurementDatabase(S13_LOCAL_DB) ||
    !Number.isInteger(actual.pid) ||
    actual.pid <= 0 ||
    typeof actual.session !== 'string' ||
    actual.session.length === 0 ||
    typeof actual.principal !== 'string' ||
    actual.principal.length === 0 ||
    actual.session !== expected.session ||
    actual.principal !== expected.principal ||
    actual.session !== actual.principal ||
    ('pid' in expected && actual.pid !== expected.pid)
  )
    throw new Error('Terminal actual scope/PID/principal mismatch');
}
function terminalValidateCatalog(rows: TerminalCatalog[], identity: TerminalIdentity) {
  if (rows.length !== 2) throw new Error('Terminal actual catalog missing or ambiguous');
  const current = rows.find((row) => row.scope === 'public');
  const opening = rows.find((row) => row.scope === 'temporary');
  if (
    !current ||
    !opening ||
    current.schema !== 'public' ||
    typeof opening.schema !== 'string' ||
    !/^pg_temp_[0-9]+$/u.test(opening.schema) ||
    current.temporary !== false ||
    opening.temporary !== true
  )
    throw new Error('Terminal actual catalog namespace mismatch');
  for (const [row, body, bytes] of [
    [current, E4_TERMINAL_NEW_BODY_MD5, E4_TERMINAL_NEW_BODY_BYTES],
    [opening, E4_TERMINAL_OLD_BODY_MD5, 4044],
  ] as const) {
    if (
      row.pid !== identity.pid ||
      row.body !== body ||
      row.bytes !== bytes ||
      row.ownerMatches !== true ||
      !Number.isInteger(row.owner) ||
      row.owner <= 0 ||
      row.language !== 'sql' ||
      row.volatility !== 's' ||
      row.strict !== false ||
      row.invoker !== true ||
      row.parallel !== 'u' ||
      row.cost !== 100 ||
      row.rows !== 1000 ||
      JSON.stringify(row.config) !== JSON.stringify(['search_path=pg_catalog, public']) ||
      row.args !== 'revision_id text' ||
      row.result !== 'TABLE(unit_canonical text, evaluation jsonb)' ||
      row.defaults !== 0 ||
      row.defaultExpression !== null ||
      row.acl !== null
    )
      throw new Error('Terminal complete actual catalog properties mismatch');
  }
  if (current.owner !== opening.owner) throw new Error('Terminal current owner differs');
  return { current, opening };
}
async function terminalBusinessPrincipal(db: PrismaClient) {
  const rows = await db.$queryRawUnsafe<{ db: string; session: string; principal: string }[]>(
    'SELECT current_database() AS db,session_user::text AS session,current_user::text AS principal',
  );
  if (
    rows.length !== 1 ||
    rows[0].db !== e4NativeMeasurementDatabase(S13_LOCAL_DB) ||
    rows[0].session !== rows[0].principal ||
    !rows[0].session ||
    !rows[0].principal
  )
    throw new Error('Terminal actual business identity unavailable');
  return rows[0];
}
async function terminalNativeIdentity(client: S13ReadClient, deadline: number) {
  const result = await client.query<TerminalIdentity>(
    'SELECT current_database() AS db,pg_backend_pid() AS pid,session_user::text AS session,current_user::text AS principal',
    [],
    terminalRemaining(deadline),
  );
  if (result.rows.length !== 1) throw new Error('Terminal native identity missing');
  return result.rows[0];
}
async function terminalBoundedQuery<T = never>(
  client: S13ReadClient,
  deadline: number,
  sql: string,
  values: (string | number | undefined)[] = [],
  local = false,
) {
  await client.query(
    'SET ' +
      (local ? 'LOCAL ' : '') +
      "statement_timeout='" +
      Math.min(15_000, terminalRemaining(deadline)) +
      "ms'",
    [],
    terminalRemaining(deadline),
  );
  return client.query<T>(sql, values, terminalRemaining(deadline));
}
async function terminalInstallOpening(
  client: S13ReadClient,
  deadline: number,
  identity: TerminalIdentity,
) {
  await terminalBoundedQuery(client, deadline, terminalTemporaryDefinition());
  const catalog = await terminalBoundedQuery<TerminalCatalog>(
    client,
    deadline,
    E4_TERMINAL_CATALOG_SQL,
  );
  return terminalValidateCatalog(catalog.rows, identity);
}
async function terminalIdle(
  client: S13ReadClient,
  monitor: S13ReadClient,
  deadline: number,
  identity: TerminalIdentity,
) {
  if (client.terminalState().pending) throw new Error('Terminal pending request not settled');
  const result = await monitor.query<{ idle: boolean }>(
    "SELECT state='idle' AND xact_start IS NULL AS idle FROM pg_stat_activity WHERE pid=$1 AND datname=$2",
    [identity.pid, e4NativeMeasurementDatabase(S13_LOCAL_DB)],
    terminalRemaining(deadline),
  );
  if (result.rows.length !== 1 || result.rows[0].idle !== true)
    throw new Error('Terminal actual rollback/idle unavailable');
}
async function terminalDropOpening(
  client: S13ReadClient,
  monitor: S13ReadClient,
  deadline: number,
  identity: TerminalIdentity,
  current: TerminalCatalog,
) {
  await client.query('ROLLBACK', [], terminalRemaining(deadline));
  await terminalIdle(client, monitor, deadline, identity);
  await terminalBoundedQuery(
    client,
    deadline,
    'DROP FUNCTION pg_temp.e4_expected_evaluations_1234_opening(text)',
  );
  const remaining = await terminalBoundedQuery<TerminalCatalog>(
    client,
    deadline,
    E4_TERMINAL_CATALOG_SQL,
  );
  if (remaining.rows.length !== 1 || JSON.stringify(remaining.rows[0]) !== JSON.stringify(current))
    throw new Error('Terminal temporary residue or public properties changed');
  const residue = await client.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM pg_proc WHERE pronamespace=pg_my_temp_schema() AND proname='e4_expected_evaluations_1234_opening'",
    [],
    terminalRemaining(deadline),
  );
  if (residue.rows.length !== 1 || residue.rows[0].count !== 0)
    throw new Error('Terminal actual temporary zero not proved');
}
function terminalPlanProducer(
  value: unknown,
  kind: 'old' | 'candidate',
  catalog: ReturnType<typeof terminalValidateCatalog> | undefined,
  identity: TerminalIdentity | undefined,
) {
  if (!identity || !catalog?.current || !catalog.opening)
    throw new Error('Terminal producer identity/catalog proof missing');
  terminalAssertIdentity(identity, identity);
  terminalValidateCatalog([catalog.current, catalog.opening], identity);
  // PostgreSQL 16 renders the proved current-backend temporary namespace as pg_temp.
  // The numbered catalog namespace is identity evidence, never an EXPLAIN label.
  const schema = kind === 'old' ? 'pg_temp' : 'public';
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== 'object')
    throw new Error('Terminal provenance envelope missing');
  let nodes = 0;
  const matches: object[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object' || Array.isArray(node) || ++nodes > 256)
      throw new Error('Terminal provenance node/bound missing');
    if (Reflect.get(node, 'Node Type') === 'Function Scan') {
      const name: unknown = Reflect.get(node, 'Function Name');
      if (name === 'e4_expected_evaluations' || name === 'e4_expected_evaluations_1234_opening')
        matches.push(node);
    }
    const children: unknown = Reflect.get(node, 'Plans');
    if (children !== undefined) {
      if (!Array.isArray(children)) throw new Error('Terminal provenance children missing');
      children.forEach(walk);
    }
  };
  walk(Reflect.get(value[0], 'Plan'));
  if (
    matches.length !== 1 ||
    Reflect.get(matches[0], 'Function Name') !==
      (kind === 'old' ? 'e4_expected_evaluations_1234_opening' : 'e4_expected_evaluations') ||
    Reflect.get(matches[0], 'Schema') !== schema
  )
    throw new Error('Terminal real producer source/schema mismatch');
  return matches[0];
}
function terminalPlanProvenance(
  value: unknown,
  kind: 'old' | 'candidate',
  catalog: ReturnType<typeof terminalValidateCatalog> | undefined,
  identity: TerminalIdentity | undefined,
) {
  const producer = terminalPlanProducer(value, kind, catalog, identity);
  if (Reflect.get(producer, 'Actual Rows') !== 8000 || Reflect.get(producer, 'Actual Loops') !== 1)
    throw new Error('Terminal real producer coverage mismatch');
}

// E4_TERMINAL_REFS_BODY_HELPERS_BEGIN
// New diagnostic input only. No candidate is written before the retained-body gate.
const E4_REFS_ANCHORS = [
  [
    '), documents AS MATERIALIZED (\n  SELECT unit,refs,refs_canonical,',
    '), documents AS MATERIALIZED (\n  SELECT unit,refs_canonical,',
  ],
  [
    '), canonical_documents AS NOT MATERIALIZED (\n  SELECT unit,refs,metadata,',
    '), canonical_documents AS NOT MATERIALIZED (\n  SELECT unit,refs_canonical,metadata,',
  ],
  [
    "SELECT unit,metadata || jsonb_build_object('sourceRefsJson',refs,\n",
    "SELECT unit,metadata || jsonb_build_object('sourceRefsJson',refs_canonical::JSONB,\n",
  ],
] as const;
function terminalRefsRestore(source: string) {
  if (terminalHash(source) !== E4_TERMINAL_REFS_SHA)
    throw new Error('Refs complete candidate migration pin differs');
  const current = terminalExpectedDefinition(source);
  if (
    terminalHash(current.definition) !== E4_TERMINAL_REFS_FUNCTION_SHA ||
    terminalHash(current.body, 'md5') !== E4_TERMINAL_REFS_BODY_MD5 ||
    Buffer.byteLength(current.body, 'utf8') !== E4_TERMINAL_REFS_BODY_BYTES
  )
    throw new Error('Refs complete candidate function pin differs');
  let restored = source;
  for (const [opening, candidate] of E4_REFS_ANCHORS) {
    if (restored.split(candidate).length !== 2)
      throw new Error('Refs exact candidate anchor absent or ambiguous');
    restored = restored.replace(candidate, () => opening);
  }
  terminalOpeningBaseMigrationSource(restored);
  return restored;
}
function terminalRefsProjection(source: string) {
  terminalOpeningBaseMigrationSource(source);
  let projected = source;
  for (const [opening, candidate] of E4_REFS_ANCHORS) {
    if (projected.split(opening).length !== 2)
      throw new Error('Refs exact opening anchor absent or ambiguous');
    projected = projected.replace(opening, () => candidate);
  }
  if (terminalRefsRestore(projected) !== source)
    throw new Error('Refs complete candidate inverse mismatch');
  return projected;
}
const E4_N1_ANCHORS = [
  [
    '  SELECT g.*,coalesce(chosen.band,p."definitionJson"->\'defaultResult\') AS result,\n' +
      "    astr_canonical_json(jsonb_build_object('participationIdentityId',g.identity_id,'sessionId',g.session_id,\n" +
      "      'mode','policy','policyId',g.policy_id,'policyVersionId',g.policy_version_id,'definitionHash',g.definition_hash,\n" +
      "      'evaluatorVersion',g.evaluator_version,'attendanceRoleCode',g.role_code,'timeCategoryCode',g.category_code)) AS unit\n",
    '  SELECT g.identity_id,g.member_id,g.session_id,g.snapshot_id,g.policy_id,g.policy_version_id,g.definition_hash,g.evaluator_version,g.role_code,g.category_code,\n' +
      '    g.representative,g.seconds,g.refs_canonical,resolved.result,\n' +
      "    astr_canonical_json(jsonb_build_object('participationIdentityId',g.identity_id,'sessionId',g.session_id,\n" +
      "      'mode','policy','policyId',g.policy_id,'policyVersionId',g.policy_version_id,'definitionHash',g.definition_hash,\n" +
      "      'evaluatorVersion',g.evaluator_version,'attendanceRoleCode',g.role_code,'timeCategoryCode',g.category_code)) AS unit,\n" +
      "    e4_day_points(g.refs,((resolved.result->>'recognizedPoints')::NUMERIC*100)::INTEGER) AS day_points\n",
  ],
  [
    '  ) chosen ON TRUE\n',
    '  ) chosen ON TRUE\n' +
      '  CROSS JOIN LATERAL (VALUES (coalesce(chosen.band,p."definitionJson"->\'defaultResult\'))) resolved(result)\n',
  ],
  [
    "      'beijingDayPointsJson',e4_day_points(refs,((result->>'recognizedPoints')::NUMERIC*100)::INTEGER)) AS metadata",
    "      'beijingDayPointsJson',day_points) AS metadata",
  ],
] as const;
function terminalN1Restore(source: string) {
  if (terminalHash(source) !== E4_TERMINAL_ACTUAL_SHA)
    throw new Error('N1 complete candidate migration pin differs');
  const current = terminalExpectedDefinition(source);
  if (
    terminalHash(current.definition) !== E4_TERMINAL_NEW_FUNCTION_SHA ||
    terminalHash(current.body, 'md5') !== E4_TERMINAL_NEW_BODY_MD5 ||
    Buffer.byteLength(current.body, 'utf8') !== E4_TERMINAL_NEW_BODY_BYTES
  )
    throw new Error('N1 complete candidate function pin differs');
  let restored = source;
  for (const [opening, candidate] of E4_N1_ANCHORS) {
    if (restored.split(candidate).length !== 2)
      throw new Error('N1 exact candidate anchor absent or ambiguous');
    restored = restored.replace(candidate, () => opening);
  }
  if (terminalHash(restored) !== E4_TERMINAL_REFS_SHA)
    throw new Error('N1 complete candidate inverse differs');
  terminalRefsRestore(restored);
  return restored;
}
function terminalN1Projection(source: string) {
  terminalRefsRestore(source);
  let projected = source;
  for (const [opening, candidate] of E4_N1_ANCHORS) {
    if (projected.split(opening).length !== 2)
      throw new Error('N1 exact opening anchor absent or ambiguous');
    projected = projected.replace(opening, () => candidate);
  }
  if (terminalN1Restore(projected) !== source)
    throw new Error('N1 complete candidate inverse mismatch');
  return projected;
}
function terminalOpeningMigrationSource(source: string): string {
  return terminalOpeningBaseMigrationSource(terminalRefsRestore(terminalN1Restore(source)));
}
function terminalN1Structure(definition: string) {
  const selected = definition
    .split('), selected AS MATERIALIZED (\n')[1]
    ?.split('), documents AS MATERIALIZED (\n')[0];
  const docs = definition
    .split('), documents AS MATERIALIZED (\n')[1]
    ?.split('), canonical_documents AS NOT MATERIALIZED (\n')[0];
  if (
    !selected?.startsWith(
      '  SELECT g.identity_id,g.member_id,g.session_id,g.snapshot_id,g.policy_id,g.policy_version_id,g.definition_hash,g.evaluator_version',
    ) ||
    selected.includes('g.*') ||
    selected.match(/\bg\.refs\b/gu)?.length !== 1 ||
    selected.match(/\be4_day_points\(/gu)?.length !== 1 ||
    !selected.includes(
      "e4_day_points(g.refs,((resolved.result->>'recognizedPoints')::NUMERIC*100)::INTEGER) AS day_points",
    ) ||
    !selected.includes(
      'CROSS JOIN LATERAL (VALUES (coalesce(chosen.band,p."definitionJson"->\'defaultResult\'))) resolved(result)',
    ) ||
    !docs?.startsWith('  SELECT unit,refs_canonical,') ||
    docs.startsWith('  SELECT unit,refs,refs_canonical,') ||
    docs.includes('e4_day_points(') ||
    !docs.includes("'beijingDayPointsJson',day_points") ||
    docs.includes("'sourceRefsJson'")
  )
    throw new Error('N1 selected/day allocation source eligibility differs');
  return { selected, docs };
}
/** Lexical positions, never matching strings, quoted identifiers, comments or dollar bodies. */
function terminalBodyParameterPositions(body: string) {
  const positions: number[] = [];
  for (let at = 0; at < body.length; ) {
    if (body.startsWith('--', at)) {
      const end = body.indexOf('\n', at + 2);
      at = end < 0 ? body.length : end + 1;
    } else if (body.startsWith('/*', at)) {
      let depth = 1;
      at += 2;
      while (depth && at < body.length) {
        if (body.startsWith('/*', at)) {
          depth++;
          at += 2;
        } else if (body.startsWith('*/', at)) {
          depth--;
          at += 2;
        } else at++;
      }
      if (depth) throw new Error('Body comment is not closed');
    } else if (body[at] === "'" || body[at] === '"') {
      const quote = body[at++];
      let closed = false;
      while (at < body.length) {
        if (body[at++] !== quote) continue;
        if (body[at] === quote) {
          at++;
          continue;
        }
        closed = true;
        break;
      }
      if (!closed) throw new Error('Body quotation is not closed');
    } else {
      const dollar = body.slice(at).match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/u)?.[0];
      if (dollar) {
        const end = body.indexOf(dollar, at + dollar.length);
        if (end < 0) throw new Error('Body dollar quotation is not closed');
        at = end + dollar.length;
      } else {
        const token = body.slice(at).match(/^[A-Za-z_][A-Za-z_0-9$]*/u)?.[0];
        if (token) {
          if (token === 'revision_id') positions.push(at);
          at += token.length;
        } else at++;
      }
    }
  }
  return positions;
}
function terminalBodyBinding(source: string) {
  terminalOpeningMigrationSource(source);
  const { body } = terminalExpectedDefinition(source);
  const positions = terminalBodyParameterPositions(body);
  const contexts = ['WHERE id=revision_id', 'e4_source_rows(revision_id)'];
  if (positions.length !== 2 || contexts.some((context) => body.split(context).length !== 2))
    throw new Error('Body two exact parameter contexts differ');
  let bound = body;
  for (const at of [...positions].reverse())
    bound = bound.slice(0, at) + '$1::text' + bound.slice(at + 'revision_id'.length);
  if (bound.split('$1::text').length !== 3 || bound.replaceAll('$1::text', 'revision_id') !== body)
    throw new Error('Body complete parameter inverse differs');
  return { body: bound, inputSha: terminalHash(body), sourceSha: terminalHash(source) };
}
function terminalBodyNull(body: string) {
  if (body.split('$1::text').length !== 3)
    throw new Error('Body NULL calibration requires both parameters');
  const query = body.replaceAll('$1::text', 'NULL::text');
  if (query.replaceAll('NULL::text', '$1::text') !== body)
    throw new Error('Body NULL calibration inverse differs');
  return query;
}
const E4_BODY_STAGES = [
  'revision_domain',
  'sources',
  'groups',
  'policy_bands',
  'selected',
  'documents',
  'canonical_documents',
  'root',
] as const;
type E4BodyStage = (typeof E4_BODY_STAGES)[number];
const E4_BODY_NODE_TYPES = [
  'Result',
  'CTE Scan',
  'Function Scan',
  'Seq Scan',
  'Index Scan',
  'Index Only Scan',
  'Bitmap Heap Scan',
  'Bitmap Index Scan',
  'BitmapAnd',
  'BitmapOr',
  'Append',
  'Merge Append',
  'Aggregate',
  'Group',
  'Sort',
  'Incremental Sort',
  'Unique',
  'Limit',
  'Hash',
  'Hash Join',
  'Merge Join',
  'Nested Loop',
  'Materialize',
  'Memoize',
  'Subquery Scan',
  'WindowAgg',
  'SetOp',
  'Gather',
  'Gather Merge',
  'Values Scan',
  'ProjectSet',
  'LockRows',
] as const;
const E4_BODY_RECOGNITION_NODE_TYPES = [...E4_BODY_NODE_TYPES, 'OTHER'] as const;
type E4BodyNode = {
  stage: E4BodyStage;
  role: 'root' | 'producer' | 'consumer' | 'node';
  nodeType: (typeof E4_BODY_NODE_TYPES)[number];
  rows: number;
  loops: number;
  width: number;
  tempRead: number;
  tempWritten: number;
  sortSpace?: number;
  hashBatches?: number;
  hashBuckets?: number;
  peakMemory?: number;
};
type E4D1BodyRecognitionNodeType = (typeof E4_BODY_RECOGNITION_NODE_TYPES)[number];
type E4D1BodyRecognitionNode = {
  ordinal: number;
  parentOrdinal: number | null;
  nodeType: E4D1BodyRecognitionNodeType;
  role: E4BodyNode['role'];
  ctePresent: boolean;
  cteTargetExact: boolean;
  cteTargetPrefix: boolean;
  subplanPresent: boolean;
  subplanTargetExact: boolean;
  subplanTargetPrefix: boolean;
};
type E4D1BodyRecognitionDiagnostic = {
  nodeCount: number;
  nodeTypeCounts: Record<E4D1BodyRecognitionNodeType, number>;
  nodes: E4D1BodyRecognitionNode[];
};

type E4D1BodyEligibilityRejection =
  | 'PRODUCER_MATCH_COUNT'
  | 'CONSUMER_MATCH_COUNT'
  | 'PRODUCER_ROWS'
  | 'CONSUMER_ROWS'
  | 'PRODUCER_LOOPS'
  | 'CONSUMER_LOOPS'
  | 'TEMP_WRITTEN';
type E4D1BodyEligibilityNode = {
  actualRows: number;
  loops: number;
  tempRead: number;
  tempWritten: number;
};
type E4D1BodyEligibilityDiagnostic = {
  producerMatches: number;
  consumerMatches: number;
  producer: E4D1BodyEligibilityNode | null;
  consumer: E4D1BodyEligibilityNode | null;
  checks: {
    producerExactlyOne: boolean;
    consumerExactlyOne: boolean;
    producerRows: boolean;
    consumerRows: boolean;
    producerLoops: boolean;
    consumerLoops: boolean;
    temporaryWritten: boolean;
    eligible: boolean;
  };
  rejected: E4D1BodyEligibilityRejection[];
};

class TerminalBodyEligibilityError extends Error {
  constructor(
    readonly diagnostic: E4D1BodyEligibilityDiagnostic,
    readonly recognition: E4D1BodyRecognitionDiagnostic,
  ) {
    super('Body documents eligibility missing');
  }
}

function terminalBodyEligibility(
  producers: E4BodyNode[],
  consumers: E4BodyNode[],
): E4D1BodyEligibilityDiagnostic {
  const project = (node: E4BodyNode | undefined): E4D1BodyEligibilityNode | null =>
    node === undefined
      ? null
      : {
          actualRows: node.rows,
          loops: node.loops,
          tempRead: node.tempRead,
          tempWritten: node.tempWritten,
        };
  const producer = producers.length === 1 ? project(producers[0]) : null;
  const consumer = consumers.length === 1 ? project(consumers[0]) : null;
  const checks = {
    producerExactlyOne: producers.length === 1,
    consumerExactlyOne: consumers.length === 1,
    producerRows: producer?.actualRows === 8000,
    consumerRows: consumer?.actualRows === 8000,
    producerLoops: producer?.loops === 1,
    consumerLoops: consumer?.loops === 1,
    temporaryWritten: (producer?.tempWritten ?? 0) > 0 || (consumer?.tempWritten ?? 0) > 0,
    eligible: false,
  };
  const rejected: E4D1BodyEligibilityRejection[] = [
    ...(checks.producerExactlyOne ? [] : ['PRODUCER_MATCH_COUNT' as const]),
    ...(checks.consumerExactlyOne ? [] : ['CONSUMER_MATCH_COUNT' as const]),
    ...(checks.producerRows ? [] : ['PRODUCER_ROWS' as const]),
    ...(checks.consumerRows ? [] : ['CONSUMER_ROWS' as const]),
    ...(checks.producerLoops ? [] : ['PRODUCER_LOOPS' as const]),
    ...(checks.consumerLoops ? [] : ['CONSUMER_LOOPS' as const]),
    ...(checks.temporaryWritten ? [] : ['TEMP_WRITTEN' as const]),
  ];
  checks.eligible = rejected.length === 0;
  return {
    producerMatches: producers.length,
    consumerMatches: consumers.length,
    producer,
    consumer,
    checks,
    rejected,
  };
}

function terminalBodyPlan(
  value: unknown,
  input: ReturnType<typeof terminalBodyBinding>,
  requireFull: boolean,
) {
  // Prove complete original body independently; this is not a Function Scan source gate.
  const pinned = terminalBodyBinding(terminalActualSource());
  if (
    input.body !== pinned.body ||
    input.inputSha !== pinned.inputSha ||
    input.sourceSha !== E4_TERMINAL_ACTUAL_SHA
  )
    throw new Error('Body diagnostic complete input pin differs');
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== 'object')
    throw new Error('Body diagnostic plan envelope missing');
  const output: E4BodyNode[] = [];
  const recognitionNodes: E4D1BodyRecognitionNode[] = [];
  const nodeTypeCounts = Object.fromEntries(
    E4_BODY_RECOGNITION_NODE_TYPES.map((nodeType) => [nodeType, 0]),
  ) as Record<E4D1BodyRecognitionNodeType, number>;
  let root: E4BodyNode | undefined;
  const producers: E4BodyNode[] = [];
  const consumers: E4BodyNode[] = [];
  const number = (node: object, key: string, integer = false) => {
    const n: unknown = Reflect.get(node, key);
    if (
      typeof n !== 'number' ||
      !Number.isFinite(n) ||
      n < 0 ||
      (integer && !Number.isSafeInteger(n))
    )
      throw new Error('Body diagnostic numeric field missing');
    return n;
  };
  const walk = (
    node: unknown,
    inherited: E4BodyStage,
    parentOrdinal: number | null,
    isRoot = false,
  ) => {
    if (!node || typeof node !== 'object' || Array.isArray(node) || recognitionNodes.length >= 256)
      throw new Error('Body diagnostic complete tree bound missing');
    const type: unknown = Reflect.get(node, 'Node Type');
    const knownType = E4_BODY_NODE_TYPES.some((known) => known === type);
    const nodeType: E4D1BodyRecognitionNodeType = knownType
      ? (type as E4BodyNode['nodeType'])
      : 'OTHER';
    const subplan: unknown = Reflect.get(node, 'Subplan Name');
    const cte: unknown = Reflect.get(node, 'CTE Name');
    const ctePresent = Reflect.has(node, 'CTE Name');
    const subplanPresent = Reflect.has(node, 'Subplan Name');
    const cteText = typeof cte === 'string';
    const subplanText = typeof subplan === 'string';
    const producerStage = subplanText && subplan.startsWith('CTE ') ? subplan.slice(4) : undefined;
    const stageName = producerStage ?? cte;
    const knownStage =
      stageName === undefined || E4_BODY_STAGES.some((known) => known === stageName);
    const role: E4BodyNode['role'] = isRoot
      ? 'root'
      : producerStage
        ? 'producer'
        : cteText
          ? 'consumer'
          : 'node';
    const rootExactDocumentsConsumer =
      isRoot && type === 'CTE Scan' && cte === 'documents' && !subplanPresent;
    const ordinal = recognitionNodes.length;
    recognitionNodes.push({
      ordinal,
      parentOrdinal,
      nodeType,
      role,
      ctePresent,
      cteTargetExact: cte === 'documents',
      cteTargetPrefix: cteText && cte.startsWith('documents'),
      subplanPresent,
      subplanTargetExact: subplan === 'CTE documents',
      subplanTargetPrefix: subplanText && subplan.startsWith('CTE documents'),
    });
    nodeTypeCounts[nodeType]++;
    const stage = (knownStage ? (stageName ?? inherited) : inherited) as E4BodyStage;
    if (knownType && knownStage) {
      const compact: E4BodyNode = {
        stage,
        role,
        nodeType: type as E4BodyNode['nodeType'],
        rows: number(node, 'Actual Rows', true),
        loops: number(node, 'Actual Loops', true),
        width: number(node, 'Plan Width', true),
        tempRead: number(node, 'Temp Read Blocks', true),
        tempWritten: number(node, 'Temp Written Blocks', true),
      };
      for (const [from, to] of [
        ['Sort Space Used', 'sortSpace'],
        ['Hash Batches', 'hashBatches'],
        ['Hash Buckets', 'hashBuckets'],
        ['Peak Memory Usage', 'peakMemory'],
      ] as const)
        if (Reflect.has(node, from)) compact[to] = number(node, from, true);
      output.push(compact);
      if (isRoot) root = compact;
      if (stage === 'documents' && compact.role === 'producer') producers.push(compact);
      if (stage === 'documents' && (compact.role === 'consumer' || rootExactDocumentsConsumer))
        consumers.push(compact);
    }
    const plans: unknown = Reflect.get(node, 'Plans');
    if (plans !== undefined) {
      if (!Array.isArray(plans)) throw new Error('Body diagnostic children missing');
      for (const child of plans) walk(child, stage, ordinal);
    }
  };
  walk(Reflect.get(value[0], 'Plan'), 'root', null, true);
  const bodyRecognition: E4D1BodyRecognitionDiagnostic = {
    nodeCount: recognitionNodes.length,
    nodeTypeCounts,
    nodes: recognitionNodes,
  };
  if (Buffer.byteLength(JSON.stringify(bodyRecognition), 'utf8') > 48 * 1024)
    throw new Error('Body recognition public projection bound exceeded');
  const bodyEligibility = terminalBodyEligibility(producers, consumers);
  if (!root || root.loops !== 1 || root.rows !== (requireFull ? 8000 : 0))
    throw new Error('Body diagnostic real full coverage differs');
  if (requireFull && !bodyEligibility.checks.eligible)
    throw new TerminalBodyEligibilityError(bodyEligibility, bodyRecognition);
  const definition = terminalExpectedDefinition(terminalActualSource()).definition;
  terminalN1Structure(definition);
  const projection = {
    inputSha: input.inputSha,
    sourceSha: input.sourceSha,
    diagnosticProjection: true,
    eligibility: requireFull,
    bodyEligibility,
    bodyRecognition,
    nodes: output,
  };
  const publicProjection = {
    inputSha: projection.inputSha,
    sourceSha: projection.sourceSha,
    diagnosticProjection: projection.diagnosticProjection,
    eligibility: projection.eligibility,
    bodyEligibility: projection.bodyEligibility,
    nodes: projection.nodes,
  };
  if (Buffer.byteLength(JSON.stringify(publicProjection), 'utf8') > 32 * 1024)
    throw new Error('Body public projection bound exceeded');
  return projection;
}
type E4RetainedResources = {
  databases: number;
  clients: number;
  ownerBackends: number;
  leaseLocks: number;
  leaseOwnerVisible: boolean;
  observerVisible: boolean;
  planVisible: boolean;
  exactScope: boolean;
  samePrincipal: boolean;
  sameServer: boolean;
};
function terminalRetainedResources(
  facts: E4RetainedResources,
  expected: { clients: 0 | 1; owner: 0 | 1; plan: boolean },
) {
  if (
    facts.databases !== 1 ||
    facts.clients !== expected.clients ||
    facts.ownerBackends !== expected.owner ||
    facts.leaseLocks !== expected.owner ||
    facts.leaseOwnerVisible !== (expected.owner === 1) ||
    facts.observerVisible !== true ||
    facts.planVisible !== expected.plan ||
    facts.exactScope !== true ||
    facts.samePrincipal !== true ||
    facts.sameServer !== true
  )
    throw new Error('Retained actual resource/positive control UNKNOWN');
}
function terminalRetainedDeadline(now = performance.now()) {
  if (!Number.isFinite(now)) throw new Error('Retained actual start time unavailable');
  return now + 75_000;
}
function terminalRetainedPublicBytes(total: number, value: unknown) {
  if (!Number.isSafeInteger(total) || total < 0 || total > 32 * 1024)
    throw new Error('Retained cumulative public bound unavailable');
  const next = total + Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (next > 32 * 1024) throw new Error('Retained cumulative public bound exceeded');
  return next;
}
function terminalNativeWorkerOpening(source: string): string {
  const migration = /^function restoreTerminalMigrationOpening\(/gmu;
  const scale = /^function restoreTerminalScaleOpening\(/gmu;
  const migrationCount = [...source.matchAll(migration)].length;
  const scaleCount = [...source.matchAll(scale)].length;
  if (migrationCount + scaleCount !== 1)
    throw new Error('Native worker opening source kind differs');
  const bindings = {
    migration: [
      {
        candidate:
          "import { e4HistoricalMigrationPrefix } from '../helpers/e4-migration-prefix';\n",
        candidateHash: '58b4d89228d9b5e39855abf83fd17299e44049ebde45170e4de308fa95718eb4',
        opening: '',
      },
      {
        candidate:
          '  installE4ValidationDatabase({ allowInstallRetain: true, historicalMigration137: true });\n',
        candidateHash: '83e155eaa7a492d78d4963ae2cf02c46d848eb778382badd324a7c9a904a414f',
        opening: '  installE4ValidationDatabase({ allowInstallRetain: true });\n',
      },
      {
        candidate:
          "    const migrations = e4HistoricalMigrationPrefix(\n      readdirSync(resolve(__dirname, '../../prisma/migrations')).filter((name) =>\n        /^[0-9]{14}_/u.test(name),\n      ),\n    );",
        candidateHash: 'e09a4664b71b48e244d438fdf871311cd5d3b4501948d56029284f2f01717c9b',
        opening:
          "    const migrations = readdirSync(resolve(__dirname, '../../prisma/migrations'))\n      .filter((name) => /^[0-9]{14}_/u.test(name))\n      .sort();",
      },
      {
        candidate:
          "      const migrations = e4HistoricalMigrationPrefix(\n        readdirSync(resolve(__dirname, '../../prisma/migrations')).filter((name) =>\n          /^[0-9]{14}_/u.test(name),\n        ),\n      );",
        candidateHash: 'f831c8e4c88b04629c017af2ad21e71ebe1d2e688e2b8a55ace591dfb683a487',
        opening:
          "      const migrations = readdirSync(resolve(__dirname, '../../prisma/migrations')).filter((name) =>\n        /^[0-9]{14}_/u.test(name),\n      );",
      },

      {
        candidate:
          "import { hashCanonical } from '../../src/modules/activities/activity-publish-review-idempotency';\n\n// E4_TERMINAL_HELPERS_BEGIN\nimport { e4NativeMeasurementDatabase } from '../helpers/e4-native-measurement-owner';\nimport {\n  E4NativeMeasurementOwner,\n  withE4NativeMeasurementBinding,\n  type E4NativeMeasurementLease,\n} from '../helpers/e4-native-measurement-owner';\nimport { E4_D1_SCOPE } from '../helpers/e4-d1-result-capture';\nimport { ScratchLeaseSession } from '../helpers/scratch-database-lease';\nconst S13_LOCAL_DB = E4_D1_SCOPE;\n",
        candidateHash: '12a73b42a07396f0f0d5ba21f1ed3b7f5437de099e627b656eefa60f455ad788',
        opening:
          "import { hashCanonical } from '../../src/modules/activities/activity-publish-review-idempotency';\n\n// E4_TERMINAL_HELPERS_BEGIN\nimport { E4_D1_SCOPE } from '../helpers/e4-d1-result-capture';\nimport { ScratchLeaseSession } from '../helpers/scratch-database-lease';\nconst S13_LOCAL_DB = E4_D1_SCOPE;\n",
      },
      {
        candidate:
          "  expected: TerminalIdentity | Pick<TerminalIdentity, 'session' | 'principal'>,\n) {\n  if (\n    actual.db !== e4NativeMeasurementDatabase(S13_LOCAL_DB) ||\n    !Number.isInteger(actual.pid) ||\n    actual.pid <= 0 ||\n    typeof actual.session !== 'string' ||\n",
        candidateHash: '746567ac1248ed00c458ca295e157ffcc36ecbbe1dcb82b9319ddbb3f0e2c823',
        opening:
          "  expected: TerminalIdentity | Pick<TerminalIdentity, 'session' | 'principal'>,\n) {\n  if (\n    actual.db !== S13_LOCAL_DB ||\n    !Number.isInteger(actual.pid) ||\n    actual.pid <= 0 ||\n    typeof actual.session !== 'string' ||\n",
      },
      {
        candidate:
          "  if (client.terminalState().pending) throw new Error('Terminal pending request not settled');\n  const result = await monitor.query<{ idle: boolean }>(\n    \"SELECT state='idle' AND xact_start IS NULL AS idle FROM pg_stat_activity WHERE pid=$1 AND datname=$2\",\n    [identity.pid, e4NativeMeasurementDatabase(S13_LOCAL_DB)],\n    terminalRemaining(deadline),\n  );\n  if (result.rows.length !== 1 || result.rows[0].idle !== true)\n",
        candidateHash: '9ec69755204978179430b9fc7a877c908d25d5279754a72d356beba4df7c4e00',
        opening:
          "  if (client.terminalState().pending) throw new Error('Terminal pending request not settled');\n  const result = await monitor.query<{ idle: boolean }>(\n    \"SELECT state='idle' AND xact_start IS NULL AS idle FROM pg_stat_activity WHERE pid=$1 AND datname=$2\",\n    [identity.pid, S13_LOCAL_DB],\n    terminalRemaining(deadline),\n  );\n  if (result.rows.length !== 1 || result.rows[0].idle !== true)\n",
      },
      {
        candidate:
          "  return { current, opening };\n}\nasync function terminalBusinessPrincipal(db: PrismaClient) {\n  const rows = await db.$queryRawUnsafe<{ db: string; session: string; principal: string }[]>(\n    'SELECT current_database() AS db,session_user::text AS session,current_user::text AS principal',\n  );\n  if (\n    rows.length !== 1 ||\n    rows[0].db !== e4NativeMeasurementDatabase(S13_LOCAL_DB) ||\n    rows[0].session !== rows[0].principal ||\n    !rows[0].session ||\n    !rows[0].principal\n",
        candidateHash: 'b11e1e56ba72f0230d96ef477e79acefe2f58ee481ffe409b325d0d37892704a',
        opening:
          "  return { current, opening };\n}\nasync function terminalBusinessPrincipal(db: PrismaClient) {\n  const rows = await db.$queryRawUnsafe<{ session: string; principal: string }[]>(\n    'SELECT session_user::text AS session,current_user::text AS principal',\n  );\n  if (\n    rows.length !== 1 ||\n    rows[0].session !== rows[0].principal ||\n    !rows[0].session ||\n    !rows[0].principal\n",
      },
      {
        candidate:
          '}\nlet terminalMigrationFailed = false;\nlet terminalMigrationPending = 0;\nconst terminalMigrationLease: { owner?: E4NativeMeasurementLease } = {};\nlet terminalMigrationNativeOwner: E4NativeMeasurementOwner | undefined;\nfunction terminalMigrationDropAllowed() {\n  return (\n    !terminalMigrationFailed &&\n',
        candidateHash: '6aa20a9bf7f2e91d26ba14d939be38c93936f2c47c17eac65230aae317144a69',
        opening:
          '}\nlet terminalMigrationFailed = false;\nlet terminalMigrationPending = 0;\nconst terminalMigrationLease: { owner?: ScratchLeaseSession } = {};\nfunction terminalMigrationDropAllowed() {\n  return (\n    !terminalMigrationFailed &&\n',
      },
      {
        candidate:
          "  ) => Promise<T>,\n  expectedFault?: Error,\n) {\n  const binding = terminalMigrationNativeOwner?.current();\n  if (!binding || binding.owner !== terminalMigrationLease.owner)\n    throw new Error('Terminal actual original lease owner missing');\n  return withE4NativeMeasurementBinding(binding, async () => {\n    // The exact runtime binding is validated above; preserve the frozen driver's bytes/type.\n    const database = e4NativeMeasurementDatabase(S13_LOCAL_DB);\n    const plan = new S13ReadClient(database as typeof S13_LOCAL_DB);\n    const monitor = new S13ReadClient('postgres');\n    const deadline = performance.now() + 30_000;\n    // This single owner, both clients, and pending are registered before async connect/DDL.\n    terminalMigrationLease.owner?.assertHeld();\n    if (!terminalMigrationLease.owner)\n      throw new Error('Terminal actual original lease owner missing');\n    terminalMigrationPending++;\n    let planOpened = false,\n      monitorOpened = false;\n    let identity: TerminalIdentity | undefined;\n    let catalog: ReturnType<typeof terminalValidateCatalog> | undefined;\n    let cleaned = false,\n      closed = false;\n    let primary: { value: unknown } | undefined;\n    let completed: { value: T } | undefined;\n    let cleanupFailure = false;\n    const cleanTemporary = async () => {\n      if (!identity || !catalog) throw new Error('Terminal partial install/catalog UNKNOWN');\n      await terminalDropOpening(plan, monitor, deadline, identity, catalog.current);\n      cleaned = true;\n    };\n    try {\n      const business = await terminalBusinessPrincipal(db);\n      monitorOpened = true;\n      await monitor.connect(terminalRemaining(deadline));\n      planOpened = true;\n      await plan.connect(terminalRemaining(deadline));\n      identity = await terminalNativeIdentity(plan, deadline);\n      terminalAssertIdentity(identity, business);\n      catalog = await terminalInstallOpening(plan, deadline, identity);\n      completed = { value: await work(plan, deadline, identity, catalog) };\n    } catch (error) {\n      primary = { value: error };\n      if (error !== expectedFault) terminalMigrationFailed = true;\n    } finally {\n      try {\n        await cleanTemporary();\n      } catch {\n        terminalMigrationFailed = true;\n        cleanupFailure = true;\n      }\n      for (const [client, opened] of [\n        [plan, planOpened],\n        [monitor, monitorOpened],\n      ] as const) {\n        if (!opened) continue;\n        try {\n          await client.end(performance.now() < deadline ? terminalRemaining(deadline) : 10_000);\n        } catch {\n          terminalMigrationFailed = true;\n          cleanupFailure = true;\n        }\n      }\n      closed = terminalCleanupKnown({\n        pending: plan.terminalState().pending || monitor.terminalState().pending ? 1 : 0,\n        idle: cleaned,\n        cleaned,\n        closed: !cleanupFailure && plan.terminalState().closed && monitor.terminalState().closed,\n      });\n      if (closed) terminalMigrationPending--;\n      console.info(\n        'E4_TERMINAL_SMALL_RESOURCES',\n        JSON.stringify({\n          temporary: cleaned ? 'ABSENT' : 'UNKNOWN',\n          closed,\n          pending: terminalMigrationPending,\n          deadlinePassed: performance.now() >= deadline,\n          cleanupFailure,\n        }),\n      );\n    }\n    if (cleanupFailure || performance.now() >= deadline) {\n      terminalMigrationFailed = true;\n      throw new Error('Terminal small execution/cleanup UNKNOWN or deadline exceeded');\n    }\n    if (primary) throw primary.value;\n    if (!completed) throw new Error('Terminal small work terminal UNKNOWN');\n    return completed.value;\n  });\n}\n// E4_TERMINAL_RETAINED_DIAGNOSTIC_BEGIN\ntype E4D1CaptureTerminalState = import('../helpers/e4-d1-result-capture').E4D1TerminalState;\n",
        candidateHash: 'fd04fa263ae4ff1925ecf0e88352d29e99d8da22124556c4ad8c1f2dc9f303eb',
        opening:
          "  ) => Promise<T>,\n  expectedFault?: Error,\n) {\n  const plan = new S13ReadClient(S13_LOCAL_DB);\n  const monitor = new S13ReadClient('postgres');\n  const deadline = performance.now() + 30_000;\n  // This single owner, both clients, and pending are registered before async connect/DDL.\n  terminalMigrationLease.owner?.assertHeld();\n  if (!terminalMigrationLease.owner)\n    throw new Error('Terminal actual original lease owner missing');\n  terminalMigrationPending++;\n  let planOpened = false,\n    monitorOpened = false;\n  let identity: TerminalIdentity | undefined;\n  let catalog: ReturnType<typeof terminalValidateCatalog> | undefined;\n  let cleaned = false,\n    closed = false;\n  let primary: { value: unknown } | undefined;\n  let completed: { value: T } | undefined;\n  let cleanupFailure = false;\n  const cleanTemporary = async () => {\n    if (!identity || !catalog) throw new Error('Terminal partial install/catalog UNKNOWN');\n    await terminalDropOpening(plan, monitor, deadline, identity, catalog.current);\n    cleaned = true;\n  };\n  try {\n    const business = await terminalBusinessPrincipal(db);\n    monitorOpened = true;\n    await monitor.connect(terminalRemaining(deadline));\n    planOpened = true;\n    await plan.connect(terminalRemaining(deadline));\n    identity = await terminalNativeIdentity(plan, deadline);\n    terminalAssertIdentity(identity, business);\n    catalog = await terminalInstallOpening(plan, deadline, identity);\n    completed = { value: await work(plan, deadline, identity, catalog) };\n  } catch (error) {\n    primary = { value: error };\n    if (error !== expectedFault) terminalMigrationFailed = true;\n  } finally {\n    try {\n      await cleanTemporary();\n    } catch {\n      terminalMigrationFailed = true;\n      cleanupFailure = true;\n    }\n    for (const [client, opened] of [\n      [plan, planOpened],\n      [monitor, monitorOpened],\n    ] as const) {\n      if (!opened) continue;\n      try {\n        await client.end(performance.now() < deadline ? terminalRemaining(deadline) : 10_000);\n      } catch {\n        terminalMigrationFailed = true;\n        cleanupFailure = true;\n      }\n    }\n    closed = terminalCleanupKnown({\n      pending: plan.terminalState().pending || monitor.terminalState().pending ? 1 : 0,\n      idle: cleaned,\n      cleaned,\n      closed: !cleanupFailure && plan.terminalState().closed && monitor.terminalState().closed,\n    });\n    if (closed) terminalMigrationPending--;\n    console.info(\n      'E4_TERMINAL_SMALL_RESOURCES',\n      JSON.stringify({\n        temporary: cleaned ? 'ABSENT' : 'UNKNOWN',\n        closed,\n        pending: terminalMigrationPending,\n        deadlinePassed: performance.now() >= deadline,\n        cleanupFailure,\n      }),\n    );\n  }\n  if (cleanupFailure || performance.now() >= deadline) {\n    terminalMigrationFailed = true;\n    throw new Error('Terminal small execution/cleanup UNKNOWN or deadline exceeded');\n  }\n  if (primary) throw primary.value;\n  if (!completed) throw new Error('Terminal small work terminal UNKNOWN');\n  return completed.value;\n}\n// E4_TERMINAL_RETAINED_DIAGNOSTIC_BEGIN\ntype E4D1CaptureTerminalState = import('../helpers/e4-d1-result-capture').E4D1TerminalState;\n",
      },
      {
        candidate:
          "  // E4_TERMINAL_REPLACE_N1_INSTALLER_MODE_BEGIN\n  installE4ValidationDatabase({ allowInstallRetain: true });\n  // E4_TERMINAL_REPLACE_N1_INSTALLER_MODE_END\n  // E4_TERMINAL_N1_INSTALL_STAGE_BEGIN\n  const runN1InstallRetain =\n    process.env.SRVF_E4_W98 === '1' && process.env.SRVF_E4_N1_LIFECYCLE === 'install-retain';\n",
        candidateHash: '35fc8e60bb654c32b0b663a9d8ad3bdf9a853f76a31bb0d3694de33257c32e36',
        opening:
          "  // E4_TERMINAL_REPLACE_N1_INSTALLER_MODE_BEGIN\n  installE4ValidationDatabase({ allowInstallRetain: true });\n  // E4_TERMINAL_REPLACE_N1_INSTALLER_MODE_END\n  // Child resources close before the lease envelope's ordinary DROP and release hooks.\n  // E4_TERMINAL_N1_INSTALL_STAGE_BEGIN\n  const runN1InstallRetain =\n    process.env.SRVF_E4_W98 === '1' && process.env.SRVF_E4_N1_LIFECYCLE === 'install-retain';\n",
      },
      {
        candidate:
          "    });\n    // E4_TERMINAL_REAL_BEGIN\n    describe('E4 terminal expected small real proof', () => {\n      // Bind the actual owner before child fixtures; do not move or skip native proofs.\n      const nativeMeasurementOwner = new E4NativeMeasurementOwner(\n        process.env.SRVF_E4_W98 === '1',\n        () => terminalMigrationLease.owner,\n        S13_LOCAL_DB,\n      );\n      beforeAll(async () => {\n        await nativeMeasurementOwner.start();\n        terminalMigrationNativeOwner = nativeMeasurementOwner;\n        terminalMigrationLease.owner = nativeMeasurementOwner.current().owner;\n      }, 120_000);\n      afterAll(async () => {\n        try {\n          await nativeMeasurementOwner.finish();\n        } finally {\n          terminalMigrationNativeOwner = undefined;\n          if (process.env.SRVF_E4_W98 !== '1') terminalMigrationLease.owner = undefined;\n        }\n      }, 120_000);\n      // Child resources close before the lease envelope's ordinary DROP and release hooks.\n      beforeEach(() => {\n        if (terminalMigrationFailed)\n          throw new Error('Terminal small group stopped after first red');\n",
        candidateHash: 'd697fb4a00baf1f18ca1fcb04c36783fdf84bbd5cefc1cf358b29708678aa9e9',
        opening:
          "    });\n    // E4_TERMINAL_REAL_BEGIN\n    describe('E4 terminal expected small real proof', () => {\n      beforeEach(() => {\n        if (terminalMigrationFailed)\n          throw new Error('Terminal small group stopped after first red');\n",
      },
    ],
    scale: [
      {
        candidate:
          "      if (engineRequests.snapshot().status !== 'COMPLETE')\n        throw new Error('E4 engine request waits UNKNOWN; stop before next stage');\n",
        candidateHash: 'f8c3d99bca5bc93a38871d42ba61c1938df1a84f615ef8ebd351ffefbc0ba991',
        opening: '',
      },
      {
        candidate:
          "import { E4EngineRequestWaitDiagnostic } from '../helpers/e4-engine-request-wait-diagnostic';\n",
        candidateHash: '65cef7579ec83f1ca88961d5dab768ba2394dc3e253535d407df3fc13ba978bf',
        opening: '',
      },
      {
        candidate:
          "    const engineRequests = new E4EngineRequestWaitDiagnostic(\n      Reflect.get(observed, '_engine') as object,\n    );\n",
        candidateHash: '57ae6349d240986e6a4d141defabc270b5c5c3d1ae04d7c93065fb4a00f62307',
        opening: '',
      },
      {
        candidate: '        engineRequests.begin();\n',
        candidateHash: 'aff2c0bae0bb4ff49e6b400f3082dcd8308c3c24c3b0c338e538c3800610dec4',
        opening: '',
      },
      {
        candidate:
          "          engineRequests.finish();\n          engineRequests.restore();\n          console.info(\n            'E4 maximum engine request waits (fixed counters)',\n            JSON.stringify(engineRequests.snapshot()),\n          );\n",
        candidateHash: '9bdde4d1708c2e9600ac0d2fd8d35ab97864b652d85812d93d0f393bfb3825f2',
        opening: '',
      },
      {
        candidate: '      engineRequests.restore();\n',
        candidateHash: '4074b8a2544dea6fd74d58c72134135bc34e46dbb0c1ecd42a2a2c1006919251',
        opening: '',
      },

      {
        candidate:
          "// E4_GUARD_FUNCTION_IMPORT_BEGIN\nimport {\n  E4GuardFunctionDiagnostic,\n  guardFunctionDiagnosticEnabled,\n} from '../helpers/e4-guard-function-diagnostic';\n// E4_GUARD_FUNCTION_IMPORT_END\n",
        candidateHash: '6fc81b7055704aa6033d92834487bf0d1137e528f357df8683444b8798f0c8e8',
        opening: '',
      },
      {
        candidate:
          "      // E4_GUARD_FUNCTION_INSTANCE_BEGIN\n      const guardFunctionDiagnostic = guardFunctionDiagnosticEnabled()\n        ? new E4GuardFunctionDiagnostic(\n            contributions,\n            resolve(process.cwd(), 'tmp/e4-guard-functions-evidence/functions.json'),\n          )\n        : undefined;\n      // E4_GUARD_FUNCTION_INSTANCE_END\n",
        candidateHash: 'dca24ac247f9dd82b185df0bd8a55a80751e316039126252748621022e0b0381',
        opening: '',
      },
      {
        candidate:
          '          // E4_GUARD_FUNCTION_RESTORE_BEGIN\n          guardFunctionDiagnostic?.restore();\n          await guardFunctionDiagnostic?.collect(observed);\n          guardFunctionDiagnostic?.emit();\n          // E4_GUARD_FUNCTION_RESTORE_END\n',
        candidateHash: '3dd50e4a9f5ca0f3313f479ba834d1eabc2bc68583bbe80da0c9d1262171305a',
        opening: '',
      },
      {
        candidate:
          "// E4_GUARD_PLAN_IMPORT_BEGIN\nimport {\n  E4GuardPlanDiagnostic,\n  guardPlanDiagnosticEnabled,\n} from '../helpers/e4-guard-plan-diagnostic';\n// E4_GUARD_PLAN_IMPORT_END\n",
        candidateHash: '2ada5932382737b25498cebe1e4ac8b63f841ca85bcc98194d47fa2c0324773c',
        opening: '',
      },
      {
        candidate:
          "      // E4_GUARD_PLAN_INSTANCE_BEGIN\n      const guardPlanDiagnostic = guardPlanDiagnosticEnabled()\n        ? new E4GuardPlanDiagnostic(\n            contributions,\n            resolve(process.cwd(), 'tmp/e4-guard-plan-evidence/guard-plan.json'),\n          )\n        : undefined;\n      // E4_GUARD_PLAN_INSTANCE_END\n",
        candidateHash: 'c3629e917b505c0fbd90be80fd02e804b00d406e4ecd75caa0a86bf45a48b9f7',
        opening: '',
      },
      {
        candidate:
          '          // E4_GUARD_PLAN_RESTORE_BEGIN\n          guardPlanDiagnostic?.restore();\n          guardPlanDiagnostic?.emit();\n          // E4_GUARD_PLAN_RESTORE_END\n',
        candidateHash: '1ee548ed77e5a4b737af9aa9785ec237d0c603ca28e494982a4f2237699b6525',
        opening: '',
      },
      {
        candidate:
          "}\n\n// E4_TERMINAL_HELPERS_BEGIN\nimport { e4NativeMeasurementDatabase } from '../helpers/e4-native-measurement-owner';\nimport { E4_D1_SCOPE } from '../helpers/e4-d1-result-capture';\nfunction terminalHash(source: string, algorithm: 'sha256' | 'md5' = 'sha256') {\n  return createHash(algorithm).update(source).digest('hex');\n",
        candidateHash: '76667f95ba211c5db92e03c656eccb9504e97025cfb3a3c7d876711516e94b8d',
        opening:
          "}\n\n// E4_TERMINAL_HELPERS_BEGIN\nimport { E4_D1_SCOPE } from '../helpers/e4-d1-result-capture';\nfunction terminalHash(source: string, algorithm: 'sha256' | 'md5' = 'sha256') {\n  return createHash(algorithm).update(source).digest('hex');\n",
      },
      {
        candidate:
          "  expected: TerminalIdentity | Pick<TerminalIdentity, 'session' | 'principal'>,\n) {\n  if (\n    actual.db !== e4NativeMeasurementDatabase(S13_LOCAL_DB) ||\n    !Number.isInteger(actual.pid) ||\n    actual.pid <= 0 ||\n    typeof actual.session !== 'string' ||\n",
        candidateHash: '746567ac1248ed00c458ca295e157ffcc36ecbbe1dcb82b9319ddbb3f0e2c823',
        opening:
          "  expected: TerminalIdentity | Pick<TerminalIdentity, 'session' | 'principal'>,\n) {\n  if (\n    actual.db !== S13_LOCAL_DB ||\n    !Number.isInteger(actual.pid) ||\n    actual.pid <= 0 ||\n    typeof actual.session !== 'string' ||\n",
      },
      {
        candidate:
          "  if (client.terminalState().pending) throw new Error('Terminal pending request not settled');\n  const result = await monitor.query<{ idle: boolean }>(\n    \"SELECT state='idle' AND xact_start IS NULL AS idle FROM pg_stat_activity WHERE pid=$1 AND datname=$2\",\n    [identity.pid, e4NativeMeasurementDatabase(S13_LOCAL_DB)],\n    terminalRemaining(deadline),\n  );\n  if (result.rows.length !== 1 || result.rows[0].idle !== true)\n",
        candidateHash: '9ec69755204978179430b9fc7a877c908d25d5279754a72d356beba4df7c4e00',
        opening:
          "  if (client.terminalState().pending) throw new Error('Terminal pending request not settled');\n  const result = await monitor.query<{ idle: boolean }>(\n    \"SELECT state='idle' AND xact_start IS NULL AS idle FROM pg_stat_activity WHERE pid=$1 AND datname=$2\",\n    [identity.pid, S13_LOCAL_DB],\n    terminalRemaining(deadline),\n  );\n  if (result.rows.length !== 1 || result.rows[0].idle !== true)\n",
      },
      {
        candidate:
          "  return { current, opening };\n}\nasync function terminalBusinessPrincipal(db: PrismaClient) {\n  const rows = await db.$queryRawUnsafe<{ db: string; session: string; principal: string }[]>(\n    'SELECT current_database() AS db,session_user::text AS session,current_user::text AS principal',\n  );\n  if (\n    rows.length !== 1 ||\n    rows[0].db !== e4NativeMeasurementDatabase(S13_LOCAL_DB) ||\n    rows[0].session !== rows[0].principal ||\n    !rows[0].session ||\n    !rows[0].principal\n",
        candidateHash: 'b11e1e56ba72f0230d96ef477e79acefe2f58ee481ffe409b325d0d37892704a',
        opening:
          "  return { current, opening };\n}\nasync function terminalBusinessPrincipal(db: PrismaClient) {\n  const rows = await db.$queryRawUnsafe<{ session: string; principal: string }[]>(\n    'SELECT session_user::text AS session,current_user::text AS principal',\n  );\n  if (\n    rows.length !== 1 ||\n    rows[0].session !== rows[0].principal ||\n    !rows[0].session ||\n    !rows[0].principal\n",
      },
      {
        candidate:
          "import { E4PreparePhaseDiagnostic } from '../helpers/e4-prepare-phase-diagnostic';\n",
        candidateHash: 'd9cd8b34976e5272eae3ce03d94247bc7f9d75da2cc658ce2520f367de80bee0',
        opening: '',
      },
      {
        candidate:
          "    const timing = { readMs: 0, writeMs: 0, largestMs: 0 };\n    let preparePhaseDiagnostic: E4PreparePhaseDiagnostic | undefined;\n    observed.$on('query', (event) => {\n      if (!/^\\s*(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)\\b/iu.test(event.query)) {\n        queries++;\n        preparePhaseDiagnostic?.query(\n          /^\\s*(SELECT|WITH)\\b/iu.test(event.query) ? 'READ' : 'WRITE',\n          event.duration,\n        );\n      }\n      if (\n        /(?:ActivitySettlementContributionRevision|ParticipantContributionEvaluation|e4_assert_|e4_revision_complete_guard)/u.test(\n          event.query,\n        )\n      )\n        e4Queries++;\n      if (/^\\s*SET CONSTRAINTS public\\.astr_parent_complete_guard,/u.test(event.query))\n        barrierQueries++;\n      if (/^\\s*(SELECT|WITH)\\b/iu.test(event.query)) timing.readMs += event.duration;\n      else timing.writeMs += event.duration;\n      timing.largestMs = Math.max(timing.largestMs, event.duration);\n    });\n",
        candidateHash: 'fd8dfc19e8145a07ed846615487248f161cb3d4adfdad3ebc2b3a57b127af100',
        opening:
          "    const timing = { readMs: 0, writeMs: 0, largestMs: 0 };\n    observed.$on('query', (event) => {\n      if (!/^\\s*(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)\\b/iu.test(event.query)) queries++;\n      if (\n        /(?:ActivitySettlementContributionRevision|ParticipantContributionEvaluation|e4_assert_|e4_revision_complete_guard)/u.test(\n          event.query,\n        )\n      )\n        e4Queries++;\n      if (/^\\s*SET CONSTRAINTS public\\.astr_parent_complete_guard,/u.test(event.query))\n        barrierQueries++;\n      if (/^\\s*(SELECT|WITH)\\b/iu.test(event.query)) timing.readMs += event.duration;\n      else timing.writeMs += event.duration;\n      timing.largestMs = Math.max(timing.largestMs, event.duration);\n    });\n",
      },
      {
        candidate:
          "      let prepared;\n      const phaseDiagnostic = new E4PreparePhaseDiagnostic([\n        { phase: 'C3_PROOF', target: measured, method: 'lockedProof' },\n        { phase: 'C3_SOURCE', target: measured, method: 'lockedSources' },\n        { phase: 'C3_EVAL', target: reader, method: 'evaluateInTx' },\n        { phase: 'C3_BUCKET_WRITE', target: measured, method: 'insertBuckets' },\n        { phase: 'E4_PREPARE', target: contributions, method: 'prepareTimeInTx' },\n        {\n          phase: 'E4_EVAL',\n          target: f.app.get(ActivityContributionSettlementQueryService),\n          method: 'readTimeEvaluationInTx',\n        },\n        { phase: 'E4_EVAL_WRITE', target: contributions, method: 'insertEvaluations' },\n        { phase: 'C3_RECEIPT', target: measured, method: 'receipt' },\n      ]);\n      preparePhaseDiagnostic = phaseDiagnostic;\n      try {\n        phaseDiagnostic.begin();\n        let prepareOutcome: 'OK' | 'FAIL' = 'FAIL';\n        try {\n          prepared = await measured.prepare(\n            source.activityId,\n            prepareCommand,\n            e4Actor(f.creator, true),\n            E4_META,\n          );\n          prepareOutcome = 'OK';\n        } finally {\n          phaseDiagnostic.finish(prepareOutcome);\n          phaseDiagnostic.restore();\n          preparePhaseDiagnostic = undefined;\n          phaseDiagnostic.emitTo((safeJson) =>\n            console.info('E4 maximum prepare phases (fixed counters)', safeJson),\n          );\n        }\n      }",
        candidateHash: '9ab998936440952a18cb34926d0435ac69b94136bd4d032a1f32687e6b00a621',
        opening:
          '      let prepared;\n      try {\n        prepared = await measured.prepare(\n          source.activityId,\n          prepareCommand,\n          e4Actor(f.creator, true),\n          E4_META,\n        );\n      }',
      },
      {
        candidate: "\n      expect(phaseDiagnostic.snapshot().status).toBe('COMPLETE');",
        candidateHash: 'dd506dba73f442acfb8a2b370bfc9c63d2832db02e2f3e623fb6863297a56485',
        opening: '',
      },
    ],
  } as const;
  for (const { candidate, candidateHash, opening } of bindings[
    migrationCount === 1 ? 'migration' : 'scale'
  ]) {
    if (source.split(candidate).length !== 2 || terminalHash(candidate) !== candidateHash)
      throw new Error('Native worker exact opening binding differs');
    source = source.replace(candidate, () => opening);
  }
  const calls = /^ {2}source = terminalNativeWorkerOpening\(source\);\n/gmu;
  if ([...source.matchAll(calls)].length !== 2)
    throw new Error('Native worker opening inverse call differs');
  return source.replace(calls, '');
}
function terminalGithubScopeOpening(source: string): string {
  const clientType =
    /^ {2}constructor\(private readonly database: 'postgres' \| typeof S13_LOCAL_DB\) \{\}$/gmu;
  if ([...source.matchAll(clientType)].length !== 1)
    throw new Error('E4 GitHub scope opening client type differs');
  const addedImport = "import { E4_D1_SCOPE } from '../helpers/e4-d1-result-capture';\n";
  const binding = /^const S13_LOCAL_DB = E4_D1_SCOPE;$/gmu;
  if (source.split(addedImport).length !== 2 || [...source.matchAll(binding)].length !== 1)
    throw new Error('E4 GitHub scope opening binding differs');
  const calls = /^ {2}source = terminalGithubScopeOpening\(source\);\n/gmu;
  if ([...source.matchAll(calls)].length !== 2)
    throw new Error('E4 GitHub scope opening inverse differs');
  return source
    .replace(addedImport, '')
    .replace(
      binding,
      "const S13_LOCAL_DB = 'app_test_srvf_nest_api_delivery_flow_pilot_f59fbc_w98';",
    )
    .replace(calls, '');
}
function terminalN1LifecycleOpening(source: string): string {
  const additions = [
    ['N1_ADMISSION', 'e7d377a51359f467fe806c2c5fc0aeb62fc7dbadedc5b5539b785a7d197ee60f'],
    ['N1_INSTALL_STAGE', '4502968f50cad3dfb6222f979bba1a95c587f88527bc3edb913e996e3360ae4d'],
    ['N1_LIFECYCLE_OFFLINE', '1f5c0d7fa1464accc2217e88ea3ce6e6d100e2fe2479a384b16d7356a58ae78c'],
  ] as const;
  for (const [name, expected] of additions) {
    const pattern = new RegExp(
      '^ *// E4_TERMINAL_' + name + '_BEGIN\n[\\s\\S]*?^ *// E4_TERMINAL_' + name + '_END\n\n',
      'gmu',
    );
    const matches = [...source.matchAll(pattern)];
    if (matches.length !== 1 || terminalHash(matches[0][0]) !== expected)
      throw new Error('N1 lifecycle opening addition bytes differ');
    source = source.replace(pattern, '');
  }
  const mode =
    /^ {2}\/\/ E4_TERMINAL_REPLACE_N1_INSTALLER_MODE_BEGIN\n[\s\S]*?^ {2}\/\/ E4_TERMINAL_REPLACE_N1_INSTALLER_MODE_END/gmu;
  const metadata = / {2}\{\n {4}kind: 'N1_INSTALLER_MODE',[\s\S]*?\n {2}\},\n/gu;
  for (const [pattern, expected, replacement] of [
    [
      mode,
      '0d562a2a6c897a017f4ba6614339963221ff7d8c85e546e2acdbe1a2af2b9d50',
      '  installE4ValidationDatabase();',
    ],
    [metadata, 'db920eb604fb4a5b6c38b9d4675d0b7522575ba4b5ec7aeefc9d9723ff5565ad', ''],
  ] as const) {
    const matches = [...source.matchAll(pattern)];
    if (matches.length !== 1 || terminalHash(matches[0][0]) !== expected)
      throw new Error('N1 lifecycle opening binding bytes differ');
    source = source.replace(pattern, () => replacement);
  }
  const added =
    "\n    ['HELPERS', 'FROZEN', 'OFFLINE', 'REAL', 'N1_ADMISSION', 'N1_INSTALL_STAGE'],\n";
  if (source.split(added).length !== 2)
    throw new Error('N1 lifecycle opening inverse list differs');
  return source.replace(added, "\n    ['HELPERS', 'FROZEN', 'OFFLINE', 'REAL'],\n");
}
function terminalRefsTestOpening(source: string, kind: 'migration' | 'scale') {
  source = terminalNativeWorkerOpening(source);
  source = terminalGithubScopeOpening(source);
  if (kind === 'migration') source = terminalN1LifecycleOpening(source);
  for (const name of [
    'REFS_BODY_HELPERS',
    'REFS_BODY_OFFLINE',
    ...(kind === 'migration' ? ['RETAINED_DIAGNOSTIC'] : []),
  ]) {
    const pattern = new RegExp(
      '^// E4_TERMINAL_' + name + '_BEGIN\\n[\\s\\S]*?^// E4_TERMINAL_' + name + '_END\\n\\n*',
      'gmu',
    );
    if ([...source.matchAll(pattern)].length !== 1)
      throw new Error('Refs instrument addition boundary absent or ambiguous');
    source = source.replace(pattern, '');
  }
  const pin =
    kind === 'migration'
      ? '9ceb1068138f4d6eb41867f84f95bb1146a24f8a343306f6ca36764f79c1644e'
      : '45320d17251c2b273f67086aa7b669fb47baf4f51b189ec4abe885de36d4a2ac';
  if (terminalHash(source) !== pin) throw new Error('Refs full opening test byte inverse differs');
  return source;
}
// E4_TERMINAL_REFS_BODY_HELPERS_END

type TerminalOpeningBinding = { kind: string; original: string; candidateHash: string };
function restoreTerminalSource(
  source: string,
  bindings: TerminalOpeningBinding[],
  additions: string[],
  expected: string,
) {
  source = terminalNativeWorkerOpening(source);
  source = terminalGithubScopeOpening(source);
  for (const kind of additions) {
    const start = '// E4_TERMINAL_' + kind + '_BEGIN';
    const end = '// E4_TERMINAL_' + kind + '_END';
    const find = (marker: string) => [
      ...source.matchAll(new RegExp('^ *' + marker + '\\n', 'gmu')),
    ];
    const starts = find(start),
      ends = find(end);
    if (starts.length !== 1 || ends.length !== 1 || ends[0].index <= starts[0].index)
      throw new Error('Terminal addition boundary missing or ambiguous');
    const finish = ends[0].index + ends[0][0].length;
    if (source[finish] !== '\n') throw new Error('Terminal addition separator differs');
    source = source.slice(0, starts[0].index) + source.slice(finish + 1);
  }
  for (const binding of bindings) {
    const from = '// E4_TERMINAL_REPLACE_' + binding.kind + '_BEGIN';
    const to = '// E4_TERMINAL_REPLACE_' + binding.kind + '_END';
    const starts = [...source.matchAll(new RegExp('^ *' + from + '\\n', 'gmu'))];
    const ends = [...source.matchAll(new RegExp('^ *' + to + '(?=\\n)', 'gmu'))];
    if (starts.length !== 1 || ends.length !== 1 || ends[0].index <= starts[0].index)
      throw new Error('Terminal input binding boundary missing or ambiguous');
    const bodyStart = starts[0].index + starts[0][0].length;
    const current = source.slice(bodyStart, ends[0].index).replace(/\n$/u, '');
    if (terminalHash(current) !== binding.candidateHash)
      throw new Error('Terminal actual replacement bytes differ');
    source =
      source.slice(0, starts[0].index) +
      binding.original +
      source.slice(ends[0].index + ends[0][0].length);
  }
  if (terminalHash(source) !== expected)
    throw new Error('Terminal complete original test source inverse mismatch');
  return source;
}
function terminalCleanupKnown(state: {
  pending: number;
  idle: boolean;
  cleaned: boolean;
  closed: boolean;
}) {
  return (
    state.pending === 0 && state.idle === true && state.cleaned === true && state.closed === true
  );
}

const E4_TERMINAL_OPENING_BINDINGS: TerminalOpeningBinding[] = [
  {
    kind: 'HISTORY',
    original:
      "function booleanScaleHistorySource(source: string): string {\n  if (\n    createHash('sha256').update(source).digest('hex') !==\n    '5dba9f0e34a1f8b94023c7ff8f1fcf4c72f164c6fe60e0268a12829632446f6a'\n  )\n    throw new Error('Boolean collection actual whole source mismatch');\n  const candidate = readBooleanWindowConstant('E4_COLLECTION_BOOLEAN_WINDOW_SQL');\n  const windows = [\n    ...source.matchAll(\n      / {4}IF EXISTS \\(\\n {6}WITH expected AS NOT MATERIALIZED \\([\\s\\S]*?CONSTRAINT='e4_evaluation_guard'; END IF;\\n/gu,\n    ),\n  ];\n  if (windows.length !== 1 || windows[0][0] !== candidate)\n    throw new Error('Boolean collection exact actual window mismatch');\n  const restored = source.replace(candidate, () =>\n    readBooleanWindowConstant('E4_COLLECTION_PAIR_WINDOW_SQL'),\n  );\n  if (\n    createHash('sha256').update(restored).digest('hex') !==\n    'abc898ef05148b521e17a0eda68f2b367ac0a88939086afc3948582acc5551cf'\n  )\n    throw new Error('Boolean collection whole opening mismatch');\n  return restored;\n}",
    candidateHash: 'd930d33a73c039c5fe5b3b265efd39a8f26486d49f17fe1c717d8629749352ef',
  },
  {
    kind: 'INVERSE',
    original:
      "function restoreBooleanScaleOpening(source: string): string {\n  for (const kind of ['HELPER', 'OFFLINE']) {\n    const startMarker = '// E4_BOOLEAN_COLLECTION_' + kind + '_BEGIN\\n';\n    const endMarker = '// E4_BOOLEAN_COLLECTION_' + kind + '_END\\n\\n';\n    if (source.split(startMarker).length !== 2 || source.split(endMarker).length !== 2)\n      throw new Error('Boolean scale addition boundary mismatch');\n    const start = source.indexOf(startMarker);\n    const end = source.indexOf(endMarker, start);\n    if (end <= start) throw new Error('Boolean scale addition order mismatch');\n    source = source.slice(0, start) + source.slice(end + endMarker.length);\n  }\n  const bindings: {\n    from: string;\n    to: string;\n    count: number;\n    scopeStart: string;\n    scopeEnd: string;\n  }[] = [\n    {\n      from: \"  );\\n  const current = [\\n    ...migration.matchAll(\\n      / {4}IF EXISTS \\\\(\\\\n {6}WITH expected AS MATERIALIZED \\\\([\\\\s\\\\S]*?CONSTRAINT='e4_evaluation_guard'; END IF;\\\\n/gu,\\n    ),\",\n      to: \"  );\\n  booleanScaleHistorySource(migration);\\n  const current = [\\n    ...migration.matchAll(\\n      / {4}IF EXISTS \\\\(\\\\n {6}WITH expected AS NOT MATERIALIZED \\\\([\\\\s\\\\S]*?CONSTRAINT='e4_evaluation_guard'; END IF;\\\\n/gu,\\n    ),\",\n      count: 1,\n      scopeStart: '',\n      scopeEnd: '',\n    },\n    {\n      from: '  const candidates = [\\n    ...tests.matchAll(/const E4_COLLECTION_PAIR_WINDOW_SQL = String\\\\.raw`([\\\\s\\\\S]*?)`;/gu),\\n  ];',\n      to: '  const candidates = [\\n    ...tests.matchAll(/const E4_COLLECTION_BOOLEAN_WINDOW_SQL = String\\\\.raw`([\\\\s\\\\S]*?)`;/gu),\\n  ];',\n      count: 1,\n      scopeStart: '',\n      scopeEnd: '',\n    },\n    {\n      from: \"            wallMs,\\n            ...compactPSetPlan(rows[0]['QUERY PLAN']),\\n          };\",\n      to: \"            wallMs,\\n            ...(kind === 'candidate'\\n              ? compactBooleanCollectionPlan(rows[0]['QUERY PLAN'])\\n              : compactPSetPlan(rows[0]['QUERY PLAN'])),\\n          };\",\n      count: 1,\n      scopeStart: '',\n      scopeEnd: '',\n    },\n    {\n      from: \"  );\\n  const migration = restoreS13FormatOpening(actualMigration);\\n  const windows = [\\n    ...actualMigration.matchAll(\\n      / {4}IF EXISTS \\\\(\\\\n {6}WITH expected AS MATERIALIZED \\\\([\\\\s\\\\S]*?CONSTRAINT='e4_evaluation_guard'; END IF;\\\\n/gu,\\n    ),\",\n      to: \"  );\\n  const migration = restoreS13FormatOpening(booleanScaleHistorySource(actualMigration));\\n  const windows = [\\n    ...actualMigration.matchAll(\\n      / {4}IF EXISTS \\\\(\\\\n {6}WITH expected AS NOT MATERIALIZED \\\\([\\\\s\\\\S]*?CONSTRAINT='e4_evaluation_guard'; END IF;\\\\n/gu,\\n    ),\",\n      count: 1,\n      scopeStart: '',\n      scopeEnd: '',\n    },\n    {\n      from: '  const candidates = [\\n    ...testSource.matchAll(/const E4_COLLECTION_PAIR_WINDOW_SQL = String\\\\.raw`([\\\\s\\\\S]*?)`;/gu),\\n  ];',\n      to: '  const candidates = [\\n    ...testSource.matchAll(/const E4_COLLECTION_BOOLEAN_WINDOW_SQL = String\\\\.raw`([\\\\s\\\\S]*?)`;/gu),\\n  ];',\n      count: 1,\n      scopeStart: '',\n      scopeEnd: '',\n    },\n    {\n      from: \"    createHash('sha256')\\n      .update(migration.replace(windows[0][0], () => historical[0][1]))\\n      .digest('hex'),\\n  ).toBe('96e4dfae0f00a3321b43d02ace0314442483f535673526a76fa043e03075b4b4');\\n  const restored = migration.replace(windows[0][0], () => openings[0][1]);\\n  expect(createHash('sha256').update(restored).digest('hex')).toBe(\",\n      to: \"    createHash('sha256')\\n      .update(\\n        migration.replace(\\n          readBooleanWindowConstant('E4_COLLECTION_PAIR_WINDOW_SQL'),\\n          () => historical[0][1],\\n        ),\\n      )\\n      .digest('hex'),\\n  ).toBe('96e4dfae0f00a3321b43d02ace0314442483f535673526a76fa043e03075b4b4');\\n  const restored = migration.replace(\\n    readBooleanWindowConstant('E4_COLLECTION_PAIR_WINDOW_SQL'),\\n    () => openings[0][1],\\n  );\\n  expect(createHash('sha256').update(restored).digest('hex')).toBe(\",\n      count: 1,\n      scopeStart: '',\n      scopeEnd: '',\n    },\n    {\n      from: \"            kind === 'candidate'\\n              ? compactS13Plan(result.rows[0]['QUERY PLAN'])\\n              : compactPSetPlan(result.rows[0]['QUERY PLAN']);\",\n      to: \"            kind === 'candidate'\\n              ? compactBooleanCollectionPlan(result.rows[0]['QUERY PLAN'])\\n              : compactPSetPlan(result.rows[0]['QUERY PLAN']);\",\n      count: 1,\n      scopeStart: '',\n      scopeEnd: '',\n    },\n    {\n      from: \"  const actualSource = () =>\\n    readFileSync(\\n      resolve(\\n        __dirname,\\n        '../../prisma/migrations/20261003000000_activity_contribution_settlement/migration.sql',\\n      ),\\n      'utf8',\\n    );\",\n      to: \"  const actualSource = () =>\\n    booleanScaleHistorySource(\\n      readFileSync(\\n        resolve(\\n          __dirname,\\n          '../../prisma/migrations/20261003000000_activity_contribution_settlement/migration.sql',\\n        ),\\n        'utf8',\\n      ),\\n    );\",\n      count: 1,\n      scopeStart: '',\n      scopeEnd: '',\n    },\n    {\n      from: \"  it('restores the entire scale opening after removing only the approved additions', () => {\\n    let source = readFileSync(__filename, 'utf8');\\n    for (const kind of ['HELPER', 'OFFLINE']) {\",\n      to: \"  it('restores the entire scale opening after removing only the approved additions', () => {\\n    let source = restoreBooleanScaleOpening(readFileSync(__filename, 'utf8'));\\n    for (const kind of ['HELPER', 'OFFLINE']) {\",\n      count: 1,\n      scopeStart: '',\n      scopeEnd: '',\n    },\n  ];\n  for (const binding of bindings) {\n    const start = binding.scopeStart ? source.indexOf(binding.scopeStart) : 0;\n    const end = binding.scopeEnd ? source.indexOf(binding.scopeEnd, start) : source.length;\n    if (start < 0 || end < start) throw new Error('Boolean scale binding scope missing');\n    const selected = source.slice(start, end);\n    if (selected.split(binding.to).length !== binding.count + 1)\n      throw new Error('Boolean scale exact input binding mismatch');\n    source =\n      source.slice(0, start) + selected.split(binding.to).join(binding.from) + source.slice(end);\n  }\n  if (\n    createHash('sha256').update(source).digest('hex') !==\n    '15160a214f3a6bbc3d998061acb39444844463baa7c5e1f2a395a94c9d6337a1'\n  )\n    throw new Error('Boolean scale whole opening source mismatch');\n  return source;\n}",
    candidateHash: '2ebda4dcfba03c8bf8e4e5a21ca0bf8a4f2261aae81f3b7ff7acfbde584b6996',
  },
  {
    kind: 'POST_INPUT',
    original:
      "function fixedPSetQueries() {\n  const tests = readFileSync(\n    resolve(__dirname, 'activity-os-r5-e4-contribution-settlement-migration.e2e-spec.ts'),\n    'utf8',\n  );\n  const fixed = [...tests.matchAll(/const E4_P_SET_OLD_WINDOW_SQL = String\\.raw`([\\s\\S]*?)`;/gu)];\n  expect(fixed).toHaveLength(1);\n  expect(createHash('sha256').update(fixed[0][1]).digest('hex')).toBe(\n    '9eb03221a1fed4e126bcd6b8c37624f1d8e31072754a08eb1753346ddd0ee911',\n  );\n  const migration = readFileSync(\n    resolve(\n      __dirname,\n      '../../prisma/migrations/20261003000000_activity_contribution_settlement/migration.sql',\n    ),\n    'utf8',\n  );\n  booleanScaleHistorySource(migration);\n  const current = [\n    ...migration.matchAll(\n      / {4}IF EXISTS \\(\\n {6}WITH expected AS NOT MATERIALIZED \\([\\s\\S]*?CONSTRAINT='e4_evaluation_guard'; END IF;\\n/gu,\n    ),\n  ];\n  expect(current).toHaveLength(1);\n  const candidates = [\n    ...tests.matchAll(/const E4_COLLECTION_BOOLEAN_WINDOW_SQL = String\\.raw`([\\s\\S]*?)`;/gu),\n  ];\n  expect(candidates).toHaveLength(1);\n  expect(current[0][0]).toBe(candidates[0][1]);\n  const bind = (window: string, rootOccurrences: number) => {\n    const prefix = '    IF EXISTS (\\n';\n    const suffix =\n      \"\\n    ) THEN RAISE EXCEPTION 'contribution evaluation set mismatch' USING ERRCODE='23514',CONSTRAINT='e4_evaluation_guard'; END IF;\\n\";\n    expect(window.startsWith(prefix)).toBe(true);\n    expect(window.endsWith(suffix)).toBe(true);\n    const query = window.slice(prefix.length, -suffix.length);\n    expect(query.split('root.id')).toHaveLength(rootOccurrences + 1);\n    return query.split('root.id').join('$1::text');\n  };\n  return { old: bind(fixed[0][1], 2), candidate: bind(current[0][0], 3) };\n}",
    candidateHash: 'a6bce47d8b1377ab02153ee7bcce72013ecf8ba9dac685c18c7e705c21e4aa04',
  },
  {
    kind: 'S13_INPUT',
    original:
      "function s13FixedOpeningQueries() {\n  const testSource = readFileSync(\n    resolve(__dirname, 'activity-os-r5-e4-contribution-settlement-migration.e2e-spec.ts'),\n    'utf8',\n  );\n  const openings = [\n    ...testSource.matchAll(/const E4_P_SET_NEW_WINDOW_SQL = String\\.raw`([\\s\\S]*?)`;/gu),\n  ];\n  expect(openings).toHaveLength(1);\n  const actualMigration = readFileSync(\n    resolve(\n      __dirname,\n      '../../prisma/migrations/20261003000000_activity_contribution_settlement/migration.sql',\n    ),\n    'utf8',\n  );\n  const migration = restoreS13FormatOpening(booleanScaleHistorySource(actualMigration));\n  const windows = [\n    ...actualMigration.matchAll(\n      / {4}IF EXISTS \\(\\n {6}WITH expected AS NOT MATERIALIZED \\([\\s\\S]*?CONSTRAINT='e4_evaluation_guard'; END IF;\\n/gu,\n    ),\n  ];\n  expect(windows).toHaveLength(1);\n  const candidates = [\n    ...testSource.matchAll(/const E4_COLLECTION_BOOLEAN_WINDOW_SQL = String\\.raw`([\\s\\S]*?)`;/gu),\n  ];\n  const historical = [\n    ...testSource.matchAll(/const E4_S13_WINDOW_SQL = String\\.raw`([\\s\\S]*?)`;/gu),\n  ];\n  expect(candidates).toHaveLength(1);\n  expect(historical).toHaveLength(1);\n  expect(windows[0][0]).toBe(candidates[0][1]);\n  expect(\n    createHash('sha256')\n      .update(\n        migration.replace(\n          readBooleanWindowConstant('E4_COLLECTION_PAIR_WINDOW_SQL'),\n          () => historical[0][1],\n        ),\n      )\n      .digest('hex'),\n  ).toBe('96e4dfae0f00a3321b43d02ace0314442483f535673526a76fa043e03075b4b4');\n  const restored = migration.replace(\n    readBooleanWindowConstant('E4_COLLECTION_PAIR_WINDOW_SQL'),\n    () => openings[0][1],\n  );\n  expect(createHash('sha256').update(restored).digest('hex')).toBe(\n    '3f73112f745247fd5ce4762a1b8e8d3551e4648f48ec47e76eb9b54ad4fd8b02',\n  );\n  const bind = (window: string) => {\n    const prefix = '    IF EXISTS (\\n';\n    const suffix =\n      \"\\n    ) THEN RAISE EXCEPTION 'contribution evaluation set mismatch' USING ERRCODE='23514',CONSTRAINT='e4_evaluation_guard'; END IF;\\n\";\n    expect(window.startsWith(prefix)).toBe(true);\n    expect(window.endsWith(suffix)).toBe(true);\n    const query = window.slice(prefix.length, -suffix.length);\n    expect(query.split('root.id')).toHaveLength(4);\n    return query.split('root.id').join('$1::text');\n  };\n  return { old: bind(openings[0][1]), candidate: bind(windows[0][0]) };\n}",
    candidateHash: 'edc8cb24622c1aa0250d0a2c0fb4e5533730aaf9470f1245887289cd811b2fa2',
  },
  {
    kind: 'CLIENT',
    original:
      "class S13ReadClient {\n  private child?: ReturnType<typeof spawn>;\n  private sequence = 0;\n  private buffer = '';\n  private closed = false;\n  private pending?: {\n    marker: string;\n    lines: string[];\n    resolve: (v: string) => void;\n    reject: (e: Error) => void;\n    timer: ReturnType<typeof setTimeout>;\n  };\n  constructor(private readonly database: 'postgres' | typeof S13_LOCAL_DB) {}\n  async connect() {\n    if (this.child || this.closed) throw new Error('S13 client cannot reconnect');\n    this.child = spawn(\n      'docker',\n      [\n        'exec',\n        '-i',\n        'u-nest-api-postgres',\n        'psql',\n        '--no-psqlrc',\n        '-qtA',\n        '-U',\n        'postgres',\n        '-d',\n        this.database,\n        '-v',\n        'ON_ERROR_STOP=1',\n      ],\n      { stdio: ['pipe', 'pipe', 'pipe'] },\n    );\n    const invalidate = () => {\n      this.closed = true;\n      if (this.pending) {\n        clearTimeout(this.pending.timer);\n        this.pending.reject(new Error('S13 read backend ended; terminal may be unknown'));\n        this.pending = undefined;\n      }\n    };\n    this.child.stderr!.resume();\n    this.child.once('exit', invalidate);\n    this.child.once('error', invalidate);\n    this.child.stdin!.once('error', invalidate);\n    this.child.stdout!.on('data', (part: Buffer) => {\n      this.buffer += part.toString();\n      if (this.buffer.length > 2 * 1024 * 1024) {\n        invalidate();\n        return;\n      }\n      let end: number;\n      while ((end = this.buffer.indexOf('\\n')) >= 0) {\n        const line = this.buffer.slice(0, end).replace(/\\r$/u, '');\n        this.buffer = this.buffer.slice(end + 1);\n        const pending = this.pending;\n        if (!pending) continue;\n        if (line === pending.marker) {\n          clearTimeout(pending.timer);\n          this.pending = undefined;\n          pending.resolve(pending.lines.join('\\n').trim());\n        } else {\n          pending.lines.push(line);\n          if (pending.lines.join('\\n').length > 2 * 1024 * 1024) {\n            invalidate();\n            return;\n          }\n        }\n      }\n    });\n    const identity = await this.query<{ db: string }>('SELECT current_database() AS db');\n    expect(identity.rows).toEqual([{ db: this.database }]);\n  }\n  private request(sql: string) {\n    if (this.closed || !this.child || !this.child.stdin!.writable || this.pending)\n      return Promise.reject(new Error('S13 pending/closed backend refused'));\n    return new Promise<string>((resolve, reject) => {\n      const marker = 'SRVF_S13_' + ++this.sequence;\n      const timer = setTimeout(() => {\n        this.closed = true;\n        this.pending = undefined;\n        reject(new Error('S13 read deadline; terminal unknown, DROP prohibited'));\n      }, 30_000);\n      this.pending = { marker, lines: [], resolve, reject, timer };\n      this.child!.stdin!.write(sql + ';\\n\\\\echo ' + marker + '\\n');\n    });\n  }\n  async query<T = never>(\n    sql: string,\n    values: (string | number | undefined)[] = [],\n  ): Promise<{ rows: T[] }> {\n    const bind = sql.replace(/\\$([12])\\b/gu, (_match, position: string) => {\n      const value = values[Number(position) - 1];\n      if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);\n      if (typeof value !== 'string') throw new Error('S13 fixed parameter missing');\n      return \"'\" + value.replaceAll(\"'\", \"''\") + \"'\";\n    });\n    if (/^SELECT\\b/u.test(bind)) {\n      const text = await this.request(\n        \"SELECT coalesce(json_agg(s13_row),'[]'::json)::text FROM (\" + bind + ') s13_row',\n      );\n      const rows: unknown = JSON.parse(text);\n      if (!Array.isArray(rows)) throw new Error('S13 read envelope missing');\n      return { rows: rows as T[] };\n    }\n    const text = await this.request(bind);\n    if (/^EXPLAIN\\b/u.test(bind)) {\n      const plan: unknown = JSON.parse(text);\n      return { rows: [{ 'QUERY PLAN': plan }] as T[] };\n    }\n    if (text !== '') throw new Error('S13 command returned unexpected data');\n    return { rows: [] };\n  }\n  async end() {\n    const child = this.child;\n    if (!child) return;\n    if (this.pending) throw new Error('S13 pending backend cannot be reported closed');\n    if (child.exitCode !== null) {\n      if (child.exitCode !== 0) throw new Error('S13 backend exit failed');\n      return;\n    }\n    await new Promise<void>((resolve, reject) => {\n      const timer = setTimeout(() => reject(new Error('S13 backend close unknown')), 10_000);\n      child.once('exit', (code) => {\n        clearTimeout(timer);\n        if (code === 0) resolve();\n        else reject(new Error('S13 backend close failed'));\n      });\n      child.stdin!.end('\\\\q\\n');\n    });\n    this.closed = true;\n  }\n}",
    candidateHash: '3de18b91ead77dbdf7f843b2d287c69ec54ce290d863b4c5fcf72f31ada508e7',
  },
  {
    kind: 'POST',
    original:
      "async function assertPostBusinessPSetProbe(db: PrismaClient, rootId: string) {\n  const sql = fixedPSetQueries();\n  const retained: unknown[] = [];\n  for (const order of ['AB', 'BA'] as const) {\n    const pair = await db.$transaction(\n      async (tx) => {\n        await tx.$executeRaw`SET TRANSACTION READ ONLY`;\n        const run = async (kind: 'old' | 'candidate') => {\n          const started = performance.now();\n          const rows = await tx.$queryRawUnsafe<{ 'QUERY PLAN': unknown }[]>(\n            `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${sql[kind]}`,\n            rootId,\n          );\n          const wallMs = performance.now() - started;\n          expect(rows).toHaveLength(1);\n          return {\n            order,\n            kind,\n            evaluations: 8000,\n            sources: 50000,\n            wallMs,\n            ...(kind === 'candidate'\n              ? compactBooleanCollectionPlan(rows[0]['QUERY PLAN'])\n              : compactPSetPlan(rows[0]['QUERY PLAN'])),\n          };\n        };\n        const first = await run(order === 'AB' ? 'old' : 'candidate');\n        const second = await run(order === 'AB' ? 'candidate' : 'old');\n        return { old: order === 'AB' ? first : second, candidate: order === 'AB' ? second : first };\n      },\n      { timeout: 30_000 },\n    );\n    retained.push(pair);\n    const text = JSON.stringify(retained);\n    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(32 * 1024);\n    console.info('E4_P_SET_POST_BUSINESS_PROBE', JSON.stringify(pair));\n    // Two independent orders; do not average, choose a winner, warm again or weaken the original budgets.\n    expect(pair.candidate.wallMs).toBeLessThan(pair.old.wallMs);\n    expect(pair.candidate.executionMs).toBeLessThan(pair.old.executionMs);\n    if (pair.old.tempWritten > 0)\n      expect(pair.candidate.tempWritten).toBeLessThan(pair.old.tempWritten);\n  }\n}",
    candidateHash: '4bb657fd33524b3f47eadab4932073ed203a339708d6c64e66fed692a89d62f2',
  },
  {
    kind: 'S13_RUN',
    original:
      "async function runS13IndependentProbe() {\n  if (!s13Probe.businessPassed || !s13Probe.appClosed || !s13Probe.measuredClosed)\n    throw new Error('S13 original business clients were not confirmed closed');\n  const url = new URL(process.env.DATABASE_URL!);\n  assertTestDatabaseUrl(url.toString());\n  if (url.pathname !== '/' + S13_LOCAL_DB) throw new Error('S13 exact isolated database mismatch');\n  const monitor = new S13ReadClient('postgres');\n  const plan = new S13ReadClient(S13_LOCAL_DB);\n  // Pending/resources are registered before either asynchronous connection is opened.\n  s13Probe.monitor = monitor;\n  s13Probe.pending++;\n  const deadline = performance.now() + 75_000;\n  const timer = setTimeout(() => {\n    s13Probe.expired = true;\n  }, 75_000);\n  let planConnected = false;\n  let transactionLive = false;\n  let planPid: number | undefined;\n  const retained: unknown[] = [];\n  try {\n    await monitor.connect();\n    const scoped = await s13ScopedFacts(monitor);\n    expect(scoped).toMatchObject({ databases: 1, clients: 0, ownerBackends: 1, leaseLocks: 1 });\n    await plan.connect();\n    planConnected = true;\n    const identity = await plan.query<{ db: string; pid: number }>(\n      'SELECT current_database() AS db,pg_backend_pid() AS pid',\n    );\n    expect(identity.rows).toHaveLength(1);\n    expect(identity.rows[0].db).toBe(S13_LOCAL_DB);\n    planPid = identity.rows[0].pid;\n    if (planPid === undefined || !Number.isInteger(planPid) || planPid <= 0)\n      throw new Error('S13 actual plan PID missing');\n    const queries = s13FixedOpeningQueries();\n    for (const order of ['AB', 'BA'] as const) {\n      if (s13Probe.expired || performance.now() >= deadline)\n        throw new Error('S13 deadline unknown');\n      const pairStarted = performance.now();\n      const run = async (kind: 'old' | 'candidate') => {\n        await plan.query('BEGIN READ ONLY');\n        transactionLive = true;\n        await plan.query(\"SET LOCAL statement_timeout='15s'\");\n        try {\n          const started = performance.now();\n          const result = await plan.query<{ 'QUERY PLAN': unknown }>(\n            'EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ' + queries[kind],\n            [s13Probe.rootId],\n          );\n          const wallMs = performance.now() - started;\n          expect(result.rows).toHaveLength(1);\n          const compact =\n            kind === 'candidate'\n              ? compactBooleanCollectionPlan(result.rows[0]['QUERY PLAN'])\n              : compactPSetPlan(result.rows[0]['QUERY PLAN']);\n          return { kind, wallMs, ...compact };\n        } finally {\n          await plan.query('ROLLBACK');\n          transactionLive = false;\n          const terminal = await monitor.query<{ idle: boolean }>(\n            \"SELECT state='idle' AND xact_start IS NULL AS idle FROM pg_stat_activity WHERE pid=$1 AND datname=$2\",\n            [planPid, S13_LOCAL_DB],\n          );\n          expect(terminal.rows).toEqual([{ idle: true }]);\n        }\n      };\n      const first = await run(order === 'AB' ? 'old' : 'candidate');\n      const second = await run(order === 'AB' ? 'candidate' : 'old');\n      expect(performance.now() - pairStarted).toBeLessThan(30_000);\n      const pair = {\n        order,\n        old: order === 'AB' ? first : second,\n        candidate: order === 'AB' ? second : first,\n      };\n      retained.push(pair);\n      const report = JSON.stringify(retained);\n      expect(Buffer.byteLength(report, 'utf8')).toBeLessThanOrEqual(32 * 1024);\n      console.info('E4_S13_EXACT_FULL_DOC_PROBE', JSON.stringify(pair));\n      expect(pair.candidate.executionMs).toBeLessThan(pair.old.executionMs);\n      expect(pair.candidate.wallMs).toBeLessThan(pair.old.wallMs);\n      if (pair.old.tempWritten > 0)\n        expect(pair.candidate.tempWritten).toBeLessThan(pair.old.tempWritten);\n    }\n    expect(s13Probe.expired).toBe(false);\n    await plan.end();\n    planConnected = false;\n    s13Probe.planClosed = true;\n    const beforeDrop = await s13ScopedFacts(monitor);\n    expect(beforeDrop).toEqual({ databases: 1, clients: 0, ownerBackends: 1, leaseLocks: 1 });\n    s13Probe.beforeDrop = { ...beforeDrop, readAt: performance.now() };\n  } catch (error) {\n    s13Probe.failed = true;\n    throw error;\n  } finally {\n    clearTimeout(timer);\n    if (transactionLive) {\n      try {\n        await plan.query('ROLLBACK');\n        transactionLive = false;\n      } catch {\n        s13Probe.expired = true;\n      }\n    }\n    if (planConnected && !transactionLive) {\n      try {\n        await plan.end();\n        s13Probe.planClosed = true;\n      } catch {\n        s13Probe.expired = true;\n      }\n    }\n    s13Probe.pending--;\n  }\n}",
    candidateHash: 'cf814bc5d192bf715a15d08fb737003a2aa33eb0c803272b4644339e752b5cbc',
  },
  {
    kind: 'LIFECYCLE',
    original:
      "function observeS13Lifecycle() {\n  const prototype = ScratchLeaseSession.prototype;\n  const acquire: unknown = Reflect.get(prototype, 'acquire');\n  const drop: unknown = Reflect.get(prototype, 'dropDatabase');\n  if (typeof acquire !== 'function' || typeof drop !== 'function')\n    throw new Error('S13 original lifecycle method missing');\n  const acquireDescriptor = Object.getOwnPropertyDescriptor(prototype, 'acquire')!;\n  const dropDescriptor = Object.getOwnPropertyDescriptor(prototype, 'dropDatabase')!;\n  Object.defineProperty(prototype, 'acquire', {\n    ...acquireDescriptor,\n    value: function (this: ScratchLeaseSession, ...args: unknown[]) {\n      const promise = Reflect.apply(acquire, this, args) as Promise<void>;\n      void promise.then(\n        () => {\n          if (s13Probe.owner && s13Probe.owner !== this) s13Probe.failed = true;\n          s13Probe.owner = this;\n        },\n        () => {\n          s13Probe.failed = true;\n        },\n      );\n      return promise;\n    },\n  });\n  Object.defineProperty(prototype, 'dropDatabase', {\n    ...dropDescriptor,\n    value: s13DropGate(\n      function (this: object, ...args: unknown[]) {\n        return Reflect.apply(drop, this, args) as Promise<void>;\n      },\n      (receiver) => {\n        const held = s13Probe.owner;\n        if (!held) return false;\n        try {\n          held.assertHeld();\n        } catch {\n          return false;\n        }\n        return s13DropAllowed(s13Probe, receiver, performance.now());\n      },\n    ),\n  });\n  return () => {\n    Object.defineProperty(prototype, 'acquire', acquireDescriptor);\n    Object.defineProperty(prototype, 'dropDatabase', dropDescriptor);\n    expect(Reflect.get(prototype, 'acquire')).toBe(acquire);\n    expect(Reflect.get(prototype, 'dropDatabase')).toBe(drop);\n  };\n}",
    candidateHash: '0e538dc82ccaa400ae202178fbc2a947e390a0e33d2717ba0798c41e6c61166c',
  },
  {
    kind: 'S13_PRINCIPAL',
    original: '      let observedForClose: ObservedE4Database | undefined;',
    candidateHash: 'a6f5101cb4d9d5310612fb5333f2f5a9e17a33be92a86632f304fb23ce3da105',
  },
  {
    kind: 'HISTORIC_TEST_INPUT',
    original:
      "  it('pins the actual complete SQL and proves the whole fixed opening inverse', () => {\n    const actual = readBooleanScaleActualSource();\n    expect(createHash('sha256').update(actual).digest('hex')).toBe(\n      '5dba9f0e34a1f8b94023c7ff8f1fcf4c72f164c6fe60e0268a12829632446f6a',\n    );\n    expect(createHash('sha256').update(booleanScaleHistorySource(actual)).digest('hex')).toBe(\n      'abc898ef05148b521e17a0eda68f2b367ac0a88939086afc3948582acc5551cf',\n    );\n  });",
    candidateHash: 'da6d6c18b057a2e461036c5ffb50f7131ef5b45443b6c501f981bcafa926aa13',
  },
];
function restoreTerminalScaleOpening(source: string) {
  source = restoreE4MaximumStageOpening(source);
  return restoreTerminalSource(
    source,
    E4_TERMINAL_OPENING_BINDINGS,
    ['HELPERS', 'OFFLINE'],
    '155d9385d922da97aea0181073b6e4e653ad0b86ef4344609655b115f30046a3',
  );
}
let terminalS13Principal: Pick<TerminalIdentity, 'session' | 'principal'> | undefined;
const terminalPostState = {
  active: false,
  failed: false,
  expired: false,
  pending: 0,
  closed: false,
};
function terminalPostDropAllowed() {
  return (
    !terminalPostState.active ||
    (!terminalPostState.failed &&
      !terminalPostState.expired &&
      terminalPostState.pending === 0 &&
      terminalPostState.closed)
  );
}
type TerminalPostTx = {
  $executeRaw: (sql: TemplateStringsArray) => Promise<number>;
  $queryRawUnsafe: <T>(sql: string, rootId: string) => Promise<T>;
};
class TerminalPostMeasurement {
  private readonly plan = new S13ReadClient(S13_LOCAL_DB);
  private readonly monitor = new S13ReadClient('postgres');
  private identity?: TerminalIdentity;
  private catalog?: ReturnType<typeof terminalValidateCatalog>;
  private deadline?: number;
  private pair = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private connected = false;
  private monitorConnected = false;
  private transactionLive = false;
  private cleaned = false;
  constructor(
    private readonly business: PrismaClient,
    private readonly queries: { old: string; candidate: string },
  ) {
    if (terminalPostState.active) throw new Error('Terminal post measurement already registered');
    terminalPostState.active = true;
    terminalPostState.pending++;
  }
  private remaining() {
    if (this.deadline === undefined) throw new Error('Terminal pair deadline not registered');
    return terminalRemaining(this.deadline);
  }
  private async clientFacts() {
    const result = await this.monitor.query<{ pid: number; idle: boolean }>(
      "SELECT pid,state='idle' AND xact_start IS NULL AS idle FROM pg_stat_activity WHERE datname=$1 ORDER BY pid",
      [S13_LOCAL_DB],
      this.remaining(),
    );
    for (const row of result.rows)
      if (!Number.isInteger(row.pid) || row.pid <= 0 || row.idle !== true)
        throw new Error('Terminal registered business client not idle');
    return result.rows.map((row) => row.pid);
  }
  async transaction<T>(work: (tx: TerminalPostTx) => Promise<T>, options: { timeout: number }) {
    if (
      options.timeout !== 30_000 ||
      this.pair >= 2 ||
      terminalPostState.failed ||
      terminalPostState.expired
    )
      throw new Error('Terminal fixed pair count/budget refused');
    const started = performance.now();
    this.deadline = started + options.timeout;
    this.timer = setTimeout(() => {
      terminalPostState.expired = true;
      terminalPostState.failed = true;
    }, options.timeout);
    try {
      if (this.pair === 0) {
        // All resources were registered synchronously in the constructor, before any connection.
        const businessIdentity = await terminalBusinessPrincipal(this.business);
        this.monitorConnected = true;
        await this.monitor.connect(this.remaining());
        const existing = await this.clientFacts();
        if (existing.length === 0) throw new Error('Terminal live business clients unavailable');
        this.connected = true;
        await this.plan.connect(this.remaining());
        this.identity = await terminalNativeIdentity(this.plan, this.deadline);
        terminalAssertIdentity(this.identity, businessIdentity);
        const registered = await this.clientFacts();
        if (
          JSON.stringify(registered) !==
          JSON.stringify([...existing, this.identity.pid].sort((a, b) => a - b))
        )
          throw new Error('Terminal actual client registration differs');
        this.catalog = await terminalInstallOpening(this.plan, this.deadline, this.identity);
      }
      if (!this.identity || !this.catalog)
        throw new Error('Terminal same-session catalog unavailable');
      terminalAssertIdentity(await terminalNativeIdentity(this.plan, this.deadline), this.identity);
      await this.plan.query('BEGIN READ ONLY', [], this.remaining());
      this.transactionLive = true;
      const tx: TerminalPostTx = {
        $executeRaw: async (parts) => {
          if (parts.length !== 1 || parts[0] !== 'SET TRANSACTION READ ONLY')
            throw new Error('Terminal fixed read-only command mismatch');
          await this.plan.query('SET TRANSACTION READ ONLY', [], this.remaining());
          return 0;
        },
        $queryRawUnsafe: async <R>(sql: string, rootId: string): Promise<R> => {
          const prefix = 'EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ';
          if (!sql.startsWith(prefix)) throw new Error('Terminal fixed explain command mismatch');
          const input = sql.slice(prefix.length);
          const kind =
            input === this.queries.old
              ? 'old'
              : input === this.queries.candidate
                ? 'candidate'
                : undefined;
          if (!kind) throw new Error('Terminal exact bound explain input differs');
          const result = await terminalBoundedQuery<{ 'QUERY PLAN': unknown }>(
            this.plan,
            this.deadline!,
            'EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, VERBOSE, FORMAT JSON) ' + input,
            [rootId],
            true,
          );
          if (result.rows.length !== 1) throw new Error('Terminal actual plan missing');
          terminalPlanProvenance(result.rows[0]['QUERY PLAN'], kind, this.catalog, this.identity);
          return result.rows as R;
        },
      };
      const result = await work(tx);
      await this.plan.query('ROLLBACK', [], this.remaining());
      this.transactionLive = false;
      await terminalIdle(this.plan, this.monitor, this.deadline, this.identity);
      this.pair++;
      if (this.pair === 2) await this.close();
      if (terminalPostState.expired || performance.now() - started >= options.timeout)
        throw new Error('Terminal actual thirty-second pair deadline exceeded');
      return result;
    } catch (error) {
      terminalPostState.failed = true;
      if (performance.now() >= this.deadline) terminalPostState.expired = true;
      throw error;
    } finally {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
  async close() {
    if (terminalPostState.closed) return;
    let failure: { value: unknown } | undefined;
    try {
      if (this.connected && this.identity && this.catalog && this.deadline !== undefined) {
        await terminalDropOpening(
          this.plan,
          this.monitor,
          this.deadline,
          this.identity,
          this.catalog.current,
        );
        this.transactionLive = false;
        this.cleaned = true;
      } else if (this.connected) {
        throw new Error('Terminal partial DDL/catalog state unknown');
      }
    } catch (error) {
      failure = { value: error };
      terminalPostState.failed = true;
      terminalPostState.expired = true;
    }
    // Ordinary client close is the only fallback; no FORCE, cancellation claims or database DROP.
    for (const [client, opened] of [
      [this.plan, this.connected],
      [this.monitor, this.monitorConnected],
    ] as const) {
      if (!opened) continue;
      try {
        await client.end(
          this.deadline !== undefined && performance.now() < this.deadline
            ? this.remaining()
            : 10_000,
        );
      } catch (error) {
        failure ??= { value: error };
        terminalPostState.failed = true;
        terminalPostState.expired = true;
      }
    }
    if (
      terminalCleanupKnown({
        pending: this.plan.terminalState().pending || this.monitor.terminalState().pending ? 1 : 0,
        idle: !this.transactionLive,
        cleaned: this.cleaned,
        closed: !failure && this.plan.terminalState().closed && this.monitor.terminalState().closed,
      })
    ) {
      terminalPostState.closed = true;
      terminalPostState.pending--;
    }
    console.info(
      'E4_TERMINAL_POST_RESOURCES',
      JSON.stringify({
        temporary: this.cleaned ? 'ABSENT' : 'UNKNOWN',
        closed: terminalPostState.closed,
        pending: terminalPostState.pending,
        failed: terminalPostState.failed,
        deadlineExpired: terminalPostState.expired,
      }),
    );
    if (failure)
      throw new Error('Terminal post cleanup/terminal UNKNOWN; database DROP prohibited');
  }
}
// E4_TERMINAL_HELPERS_END

// E4_BOOLEAN_COLLECTION_HELPER_BEGIN
function readBooleanWindowConstant(
  name: 'E4_COLLECTION_BOOLEAN_WINDOW_SQL' | 'E4_COLLECTION_PAIR_WINDOW_SQL',
): string {
  const source = readFileSync(
    resolve(__dirname, 'activity-os-r5-e4-contribution-settlement-migration.e2e-spec.ts'),
    'utf8',
  );
  const matches = [
    ...source.matchAll(new RegExp('const ' + name + ' = String.raw`([\\s\\S]*?)`;', 'gu')),
  ];
  if (matches.length !== 1) throw new Error('Boolean collection fixed window missing');
  return matches[0][1];
}
function readBooleanScaleActualSource(): string {
  return readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20261003000000_activity_contribution_settlement/migration.sql',
    ),
    'utf8',
  );
}
// E4_TERMINAL_REPLACE_HISTORY_BEGIN
function booleanScaleHistorySource(source: string): string {
  source = terminalHistoricalBooleanInput(source);
  if (
    createHash('sha256').update(source).digest('hex') !==
    '5dba9f0e34a1f8b94023c7ff8f1fcf4c72f164c6fe60e0268a12829632446f6a'
  )
    throw new Error('Boolean collection actual whole source mismatch');
  const candidate = readBooleanWindowConstant('E4_COLLECTION_BOOLEAN_WINDOW_SQL');
  const windows = [
    ...source.matchAll(
      / {4}IF EXISTS \(\n {6}WITH expected AS NOT MATERIALIZED \([\s\S]*?CONSTRAINT='e4_evaluation_guard'; END IF;\n/gu,
    ),
  ];
  if (windows.length !== 1 || windows[0][0] !== candidate)
    throw new Error('Boolean collection exact actual window mismatch');
  const restored = source.replace(candidate, () =>
    readBooleanWindowConstant('E4_COLLECTION_PAIR_WINDOW_SQL'),
  );
  if (
    createHash('sha256').update(restored).digest('hex') !==
    'abc898ef05148b521e17a0eda68f2b367ac0a88939086afc3948582acc5551cf'
  )
    throw new Error('Boolean collection whole opening mismatch');
  return restored;
}
// E4_TERMINAL_REPLACE_HISTORY_END
// E4_TERMINAL_REPLACE_INVERSE_BEGIN
function restoreBooleanScaleOpening(source: string): string {
  source = restoreTerminalScaleOpening(source);
  for (const kind of ['HELPER', 'OFFLINE']) {
    const startMarker = '// E4_BOOLEAN_COLLECTION_' + kind + '_BEGIN\n';
    const endMarker = '// E4_BOOLEAN_COLLECTION_' + kind + '_END\n\n';
    if (source.split(startMarker).length !== 2 || source.split(endMarker).length !== 2)
      throw new Error('Boolean scale addition boundary mismatch');
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    if (end <= start) throw new Error('Boolean scale addition order mismatch');
    source = source.slice(0, start) + source.slice(end + endMarker.length);
  }
  const bindings: {
    from: string;
    to: string;
    count: number;
    scopeStart: string;
    scopeEnd: string;
  }[] = [
    {
      from: "  );\n  const current = [\n    ...migration.matchAll(\n      / {4}IF EXISTS \\(\\n {6}WITH expected AS MATERIALIZED \\([\\s\\S]*?CONSTRAINT='e4_evaluation_guard'; END IF;\\n/gu,\n    ),",
      to: "  );\n  booleanScaleHistorySource(migration);\n  const current = [\n    ...migration.matchAll(\n      / {4}IF EXISTS \\(\\n {6}WITH expected AS NOT MATERIALIZED \\([\\s\\S]*?CONSTRAINT='e4_evaluation_guard'; END IF;\\n/gu,\n    ),",
      count: 1,
      scopeStart: '',
      scopeEnd: '',
    },
    {
      from: '  const candidates = [\n    ...tests.matchAll(/const E4_COLLECTION_PAIR_WINDOW_SQL = String\\.raw`([\\s\\S]*?)`;/gu),\n  ];',
      to: '  const candidates = [\n    ...tests.matchAll(/const E4_COLLECTION_BOOLEAN_WINDOW_SQL = String\\.raw`([\\s\\S]*?)`;/gu),\n  ];',
      count: 1,
      scopeStart: '',
      scopeEnd: '',
    },
    {
      from: "            wallMs,\n            ...compactPSetPlan(rows[0]['QUERY PLAN']),\n          };",
      to: "            wallMs,\n            ...(kind === 'candidate'\n              ? compactBooleanCollectionPlan(rows[0]['QUERY PLAN'])\n              : compactPSetPlan(rows[0]['QUERY PLAN'])),\n          };",
      count: 1,
      scopeStart: '',
      scopeEnd: '',
    },
    {
      from: "  );\n  const migration = restoreS13FormatOpening(actualMigration);\n  const windows = [\n    ...actualMigration.matchAll(\n      / {4}IF EXISTS \\(\\n {6}WITH expected AS MATERIALIZED \\([\\s\\S]*?CONSTRAINT='e4_evaluation_guard'; END IF;\\n/gu,\n    ),",
      to: "  );\n  const migration = restoreS13FormatOpening(booleanScaleHistorySource(actualMigration));\n  const windows = [\n    ...actualMigration.matchAll(\n      / {4}IF EXISTS \\(\\n {6}WITH expected AS NOT MATERIALIZED \\([\\s\\S]*?CONSTRAINT='e4_evaluation_guard'; END IF;\\n/gu,\n    ),",
      count: 1,
      scopeStart: '',
      scopeEnd: '',
    },
    {
      from: '  const candidates = [\n    ...testSource.matchAll(/const E4_COLLECTION_PAIR_WINDOW_SQL = String\\.raw`([\\s\\S]*?)`;/gu),\n  ];',
      to: '  const candidates = [\n    ...testSource.matchAll(/const E4_COLLECTION_BOOLEAN_WINDOW_SQL = String\\.raw`([\\s\\S]*?)`;/gu),\n  ];',
      count: 1,
      scopeStart: '',
      scopeEnd: '',
    },
    {
      from: "    createHash('sha256')\n      .update(migration.replace(windows[0][0], () => historical[0][1]))\n      .digest('hex'),\n  ).toBe('96e4dfae0f00a3321b43d02ace0314442483f535673526a76fa043e03075b4b4');\n  const restored = migration.replace(windows[0][0], () => openings[0][1]);\n  expect(createHash('sha256').update(restored).digest('hex')).toBe(",
      to: "    createHash('sha256')\n      .update(\n        migration.replace(\n          readBooleanWindowConstant('E4_COLLECTION_PAIR_WINDOW_SQL'),\n          () => historical[0][1],\n        ),\n      )\n      .digest('hex'),\n  ).toBe('96e4dfae0f00a3321b43d02ace0314442483f535673526a76fa043e03075b4b4');\n  const restored = migration.replace(\n    readBooleanWindowConstant('E4_COLLECTION_PAIR_WINDOW_SQL'),\n    () => openings[0][1],\n  );\n  expect(createHash('sha256').update(restored).digest('hex')).toBe(",
      count: 1,
      scopeStart: '',
      scopeEnd: '',
    },
    {
      from: "            kind === 'candidate'\n              ? compactS13Plan(result.rows[0]['QUERY PLAN'])\n              : compactPSetPlan(result.rows[0]['QUERY PLAN']);",
      to: "            kind === 'candidate'\n              ? compactBooleanCollectionPlan(result.rows[0]['QUERY PLAN'])\n              : compactPSetPlan(result.rows[0]['QUERY PLAN']);",
      count: 1,
      scopeStart: '',
      scopeEnd: '',
    },
    {
      from: "  const actualSource = () =>\n    readFileSync(\n      resolve(\n        __dirname,\n        '../../prisma/migrations/20261003000000_activity_contribution_settlement/migration.sql',\n      ),\n      'utf8',\n    );",
      to: "  const actualSource = () =>\n    booleanScaleHistorySource(\n      readFileSync(\n        resolve(\n          __dirname,\n          '../../prisma/migrations/20261003000000_activity_contribution_settlement/migration.sql',\n        ),\n        'utf8',\n      ),\n    );",
      count: 1,
      scopeStart: '',
      scopeEnd: '',
    },
    {
      from: "  it('restores the entire scale opening after removing only the approved additions', () => {\n    let source = readFileSync(__filename, 'utf8');\n    for (const kind of ['HELPER', 'OFFLINE']) {",
      to: "  it('restores the entire scale opening after removing only the approved additions', () => {\n    let source = restoreBooleanScaleOpening(readFileSync(__filename, 'utf8'));\n    for (const kind of ['HELPER', 'OFFLINE']) {",
      count: 1,
      scopeStart: '',
      scopeEnd: '',
    },
  ];
  for (const binding of bindings) {
    const start = binding.scopeStart ? source.indexOf(binding.scopeStart) : 0;
    const end = binding.scopeEnd ? source.indexOf(binding.scopeEnd, start) : source.length;
    if (start < 0 || end < start) throw new Error('Boolean scale binding scope missing');
    const selected = source.slice(start, end);
    if (selected.split(binding.to).length !== binding.count + 1)
      throw new Error('Boolean scale exact input binding mismatch');
    source =
      source.slice(0, start) + selected.split(binding.to).join(binding.from) + source.slice(end);
  }
  if (
    createHash('sha256').update(source).digest('hex') !==
    '15160a214f3a6bbc3d998061acb39444844463baa7c5e1f2a395a94c9d6337a1'
  )
    throw new Error('Boolean scale whole opening source mismatch');
  return source;
}
// E4_TERMINAL_REPLACE_INVERSE_END
/** No expected CTE fallback: evidence must come from the real producer inside pairs. */
function compactBooleanCollectionPlan(value: unknown) {
  if (!Array.isArray(value) || value.length !== 1)
    throw new Error('Boolean collection plan envelope missing');
  const document: unknown = value[0];
  if (document === null || typeof document !== 'object')
    throw new Error('Boolean collection document missing');
  const number = (object: object, key: string, integer = false, optional = false): number => {
    const result: unknown = Reflect.get(object, key);
    if (optional && result === undefined) return 0;
    if (
      typeof result !== 'number' ||
      !Number.isFinite(result) ||
      result < 0 ||
      (integer && !Number.isInteger(result))
    )
      throw new Error('Boolean collection numeric evidence missing');
    return result;
  };
  const nodes: {
    type: string;
    rows: number;
    loops: number;
    width: number;
    tempRead: number;
    tempWritten: number;
  }[] = [];
  const actual: { rows: number; loops: number }[] = [];
  const pairs: { rows: number; loops: number }[] = [];
  const expected: { rows: number; loops: number }[] = [];
  const full: { rows: number; loops: number }[] = [];
  let misplacedExpected = false;
  const walk = (node: unknown, inPairs = false, inActual = false): void => {
    if (node === null || typeof node !== 'object' || Array.isArray(node))
      throw new Error('Boolean collection plan node missing');
    const type: unknown = Reflect.get(node, 'Node Type');
    if (typeof type !== 'string' || !/^[A-Za-z ]{1,40}$/u.test(type))
      throw new Error('Boolean collection node type outside whitelist');
    const rows = number(node, 'Actual Rows', true);
    const loops = number(node, 'Actual Loops', true);
    const subplan: unknown = Reflect.get(node, 'Subplan Name');
    inPairs = inPairs || subplan === 'CTE pairs';
    inActual = inActual || subplan === 'CTE actual';
    if (subplan === 'CTE pairs') pairs.push({ rows, loops });
    if (subplan === 'CTE actual') actual.push({ rows, loops });
    if (
      type === 'Function Scan' &&
      Reflect.get(node, 'Function Name') === 'e4_expected_evaluations'
    ) {
      if (inPairs && !inActual) expected.push({ rows, loops });
      else misplacedExpected = true;
    }
    if (
      inPairs &&
      !inActual &&
      Reflect.get(node, 'Relation Name') === 'ParticipantContributionEvaluation'
    )
      full.push({ rows, loops });
    nodes.push({
      type,
      rows,
      loops,
      width: number(node, 'Plan Width', true),
      tempRead: number(node, 'Temp Read Blocks', true, true),
      tempWritten: number(node, 'Temp Written Blocks', true, true),
    });
    if (nodes.length > 256) throw new Error('Boolean collection node bound exceeded');
    const children: unknown = Reflect.get(node, 'Plans');
    if (children !== undefined) {
      if (!Array.isArray(children)) throw new Error('Boolean collection children missing');
      for (const child of children) walk(child, inPairs, inActual);
    }
  };
  const root: unknown = Reflect.get(document, 'Plan');
  walk(root);
  if (root === null || typeof root !== 'object') throw new Error('Boolean collection root missing');
  const requireWholeProducer = (values: { rows: number; loops: number }[]): number => {
    if (values.length !== 1 || values[0].rows !== 8000 || values[0].loops !== 1)
      throw new Error('Boolean collection whole producer ambiguous');
    return values[0].rows;
  };
  const expectedRows = requireWholeProducer(expected);
  const actualRows = requireWholeProducer(actual);
  const pairRows = requireWholeProducer(pairs);
  if (misplacedExpected || full.length !== 1 || full[0].rows * full[0].loops !== 8000)
    throw new Error('Boolean collection real full-document coverage ambiguous');
  if (number(root, 'Actual Rows', true) !== 0 || number(root, 'Actual Loops', true) !== 1)
    throw new Error('Boolean collection difference root mismatch');
  const compact = {
    executionMs: number(document, 'Execution Time'),
    differences: number(root, 'Actual Rows', true),
    expectedRows,
    actualRows,
    pairs: pairRows,
    fullRows: full[0].rows * full[0].loops,
    tempRead: number(root, 'Temp Read Blocks', true),
    tempWritten: number(root, 'Temp Written Blocks', true),
    nodes,
  };
  if (Buffer.byteLength(JSON.stringify(compact), 'utf8') > 32 * 1024)
    throw new Error('Boolean collection compact report bound exceeded');
  return compact;
}
// E4_BOOLEAN_COLLECTION_HELPER_END

// E4_TERMINAL_REPLACE_POST_INPUT_BEGIN
function fixedPSetQueries() {
  const tests = readFileSync(
    resolve(__dirname, 'activity-os-r5-e4-contribution-settlement-migration.e2e-spec.ts'),
    'utf8',
  );
  const fixed = [...tests.matchAll(/const E4_P_SET_OLD_WINDOW_SQL = String\.raw`([\s\S]*?)`;/gu)];
  expect(fixed).toHaveLength(1);
  expect(createHash('sha256').update(fixed[0][1]).digest('hex')).toBe(
    '9eb03221a1fed4e126bcd6b8c37624f1d8e31072754a08eb1753346ddd0ee911',
  );
  const migration = readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20261003000000_activity_contribution_settlement/migration.sql',
    ),
    'utf8',
  );
  booleanScaleHistorySource(migration);
  const current = [
    ...migration.matchAll(
      / {4}IF EXISTS \(\n {6}WITH expected AS NOT MATERIALIZED \([\s\S]*?CONSTRAINT='e4_evaluation_guard'; END IF;\n/gu,
    ),
  ];
  expect(current).toHaveLength(1);
  const candidates = [
    ...tests.matchAll(/const E4_COLLECTION_BOOLEAN_WINDOW_SQL = String\.raw`([\s\S]*?)`;/gu),
  ];
  expect(candidates).toHaveLength(1);
  expect(current[0][0]).toBe(candidates[0][1]);
  const bind = (window: string, rootOccurrences: number) => {
    const prefix = '    IF EXISTS (\n';
    const suffix =
      "\n    ) THEN RAISE EXCEPTION 'contribution evaluation set mismatch' USING ERRCODE='23514',CONSTRAINT='e4_evaluation_guard'; END IF;\n";
    expect(window.startsWith(prefix)).toBe(true);
    expect(window.endsWith(suffix)).toBe(true);
    const query = window.slice(prefix.length, -suffix.length);
    expect(query.split('root.id')).toHaveLength(rootOccurrences + 1);
    return query.split('root.id').join('$1::text');
  };
  return {
    old: terminalQualifyQuery(bind(fixed[0][1], 2), 'old', 2),
    candidate: terminalQualifyQuery(bind(current[0][0], 3), 'candidate', 3),
  };
}
// E4_TERMINAL_REPLACE_POST_INPUT_END

/** Only the approved numeric plan whitelist leaves the test; never expressions, SQL, parameters or IDs. */
function compactPSetPlan(value: unknown) {
  if (!Array.isArray(value) || value.length !== 1) throw new Error('P-Set plan envelope missing');
  const document: unknown = value[0];
  if (document === null || typeof document !== 'object')
    throw new Error('P-Set plan document missing');
  const number = (object: object, key: string, optional = false) => {
    const result: unknown = Reflect.get(object, key);
    if (optional && result === undefined) return 0;
    if (typeof result !== 'number' || !Number.isFinite(result) || result < 0)
      throw new Error('P-Set numeric plan field missing');
    return result;
  };
  const nodes: {
    type: string;
    rows: number;
    loops: number;
    width: number;
    tempRead: number;
    tempWritten: number;
  }[] = [];
  const cteRows: { expected?: number; actual?: number } = {};
  const walk = (node: unknown) => {
    if (node === null || typeof node !== 'object') throw new Error('P-Set plan node missing');
    const type: unknown = Reflect.get(node, 'Node Type');
    if (typeof type !== 'string' || !/^[A-Za-z ]{1,40}$/u.test(type))
      throw new Error('P-Set node type outside whitelist');
    const rows = number(node, 'Actual Rows'),
      loops = number(node, 'Actual Loops');
    nodes.push({
      type,
      rows,
      loops,
      width: number(node, 'Plan Width'),
      tempRead: number(node, 'Temp Read Blocks', true),
      tempWritten: number(node, 'Temp Written Blocks', true),
    });
    if (nodes.length > 256) throw new Error('P-Set compact plan exceeds fixed node bound');
    const subplan: unknown = Reflect.get(node, 'Subplan Name');
    for (const name of ['expected', 'actual'] as const)
      if (subplan === `CTE ${name}`) {
        if (cteRows[name] !== undefined || loops !== 1)
          throw new Error('P-Set CTE evidence ambiguous');
        cteRows[name] = rows;
      }
    const children: unknown = Reflect.get(node, 'Plans');
    if (children !== undefined) {
      if (!Array.isArray(children)) throw new Error('P-Set plan children missing');
      children.forEach(walk);
    }
  };
  const root: unknown = Reflect.get(document, 'Plan');
  walk(root);
  if (root === null || typeof root !== 'object') throw new Error('P-Set root missing');
  expect(cteRows).toEqual({ expected: 8000, actual: 8000 });
  expect(number(root, 'Actual Rows')).toBe(0);
  expect(number(root, 'Actual Loops')).toBe(1);
  return {
    executionMs: number(document, 'Execution Time'),
    differences: 0,
    expectedRows: cteRows.expected,
    actualRows: cteRows.actual,
    tempRead: number(root, 'Temp Read Blocks', true),
    tempWritten: number(root, 'Temp Written Blocks', true),
    nodes,
  };
}

// E4_TERMINAL_REPLACE_POST_BEGIN
async function assertPostBusinessPSetProbe(db: PrismaClient, rootId: string) {
  const sql = fixedPSetQueries();
  const retained: unknown[] = [];
  const terminal = new TerminalPostMeasurement(db, sql);
  let terminalPrimary: { value: unknown } | undefined;
  let terminalCleanupFailure: { value: unknown } | undefined;
  try {
    for (const order of ['AB', 'BA'] as const) {
      const pair = await terminal.transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          const run = async (kind: 'old' | 'candidate') => {
            const started = performance.now();
            const rows = await tx.$queryRawUnsafe<{ 'QUERY PLAN': unknown }[]>(
              `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${sql[kind]}`,
              rootId,
            );
            const wallMs = performance.now() - started;
            expect(rows).toHaveLength(1);
            return {
              order,
              kind,
              evaluations: 8000,
              sources: 50000,
              wallMs,
              ...(kind === 'candidate'
                ? compactBooleanCollectionPlan(rows[0]['QUERY PLAN'])
                : compactPSetPlan(rows[0]['QUERY PLAN'])),
            };
          };
          const first = await run(order === 'AB' ? 'old' : 'candidate');
          const second = await run(order === 'AB' ? 'candidate' : 'old');
          return {
            old: order === 'AB' ? first : second,
            candidate: order === 'AB' ? second : first,
          };
        },
        { timeout: 30_000 },
      );
      retained.push(pair);
      const text = JSON.stringify(retained);
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(32 * 1024);
      console.info('E4_P_SET_POST_BUSINESS_PROBE', JSON.stringify(pair));
      // Two independent orders; do not average, choose a winner, warm again or weaken the original budgets.
      expect(pair.candidate.wallMs).toBeLessThan(pair.old.wallMs);
      expect(pair.candidate.executionMs).toBeLessThan(pair.old.executionMs);
      if (pair.old.tempWritten > 0)
        expect(pair.candidate.tempWritten).toBeLessThan(pair.old.tempWritten);
    }
  } catch (error) {
    terminalPostState.failed = true;
    terminalPrimary = { value: error };
  } finally {
    try {
      await terminal.close();
    } catch (error) {
      terminalCleanupFailure = { value: error };
    }
  }
  if (terminalCleanupFailure) {
    if (terminalPrimary)
      throw new AggregateError(
        [terminalPrimary.value, terminalCleanupFailure.value],
        'Terminal post primary failure plus cleanup UNKNOWN',
      );
    throw terminalCleanupFailure.value;
  }
  if (terminalPrimary) throw terminalPrimary.value;
}
// E4_TERMINAL_REPLACE_POST_END

function fixedE4RootAggregateSql(revisionId: string, sourceKindCode: string) {
  const oracleSource = readFileSync(
    resolve(__dirname, 'activity-os-r5-e4-contribution-settlement-migration.e2e-spec.ts'),
    'utf8',
  );
  const fixed = [
    ...oracleSource.matchAll(/const E4_P_ROOT_ORACLE_SQL = String\.raw`([\s\S]*?)`;/gu),
  ];
  expect(fixed).toHaveLength(1);
  const oldAggregate = fixed[0][1];
  expect(createHash('sha256').update(oldAggregate).digest('hex')).toBe(
    'be771b78933b36e6d47e8fe81aa92bb626ac6b07423f6ae878988e85ee5af4af',
  );
  const migration = readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20261003000000_activity_contribution_settlement/migration.sql',
    ),
    'utf8',
  );
  const current = [
    ...migration.matchAll(
      / {2}WITH documents AS MATERIALIZED \(\n[\s\S]*? {4}INTO counts,total,sources_hash,evaluations_hash FROM documents;/gu,
    ),
  ];
  expect(current).toHaveLength(1);
  const bind = (aggregate: string) => {
    const suffix = '    INTO counts,total,sources_hash,evaluations_hash FROM documents;';
    expect(aggregate.endsWith(suffix)).toBe(true);
    const parts = aggregate
      .replace(suffix, '    FROM documents')
      .split(/(root\.id|root\."sourceKindCode")/gu);
    expect(parts).toHaveLength(5);
    return Prisma.join(
      parts.map((part) =>
        part === 'root.id'
          ? Prisma.sql`${revisionId}::text`
          : part === 'root."sourceKindCode"'
            ? Prisma.sql`${sourceKindCode}::text`
            : Prisma.raw(part),
      ),
      '',
    );
  };
  return { old: bind(oldAggregate), candidate: bind(current[0][0]) };
}

// The fixed abc aggregate and the candidate both read actual stored rows, not expected rows.
async function assertFixedE4RootOracle(
  db: PrismaClient,
  revisionId: string,
  expectedCount?: number,
) {
  const root = await db.activitySettlementContributionRevision.findUniqueOrThrow({
    where: { id: revisionId },
  });
  const sql = fixedE4RootAggregateSql(revisionId, root.sourceKindCode);
  const [comparison] = await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$executeRaw`SET LOCAL statement_timeout='30s'`;
      return tx.$queryRaw<
        {
          oldCount: number;
          candidateCount: number;
          totalMatches: boolean;
          sourceMatches: boolean;
          evaluationMatches: boolean;
          storedMatches: boolean;
        }[]
      >`
      WITH old_root(counts,total,sources_hash,evaluations_hash) AS MATERIALIZED (${sql.old}),
      candidate_root(counts,total,sources_hash,evaluations_hash) AS MATERIALIZED (${sql.candidate})
      SELECT o.counts::int AS "oldCount",c.counts::int AS "candidateCount",
        o.total IS NOT DISTINCT FROM c.total AS "totalMatches",
        o.sources_hash IS NOT DISTINCT FROM c.sources_hash AS "sourceMatches",
        o.evaluations_hash IS NOT DISTINCT FROM c.evaluations_hash AS "evaluationMatches",
        (o.counts=r."evaluationCount" AND o.total=r."recognizedPointsTotal"
          AND (r."sourceKindCode"='unchanged_time' OR o.sources_hash=r."sourceSetHash")
          AND o.evaluations_hash=r."evaluationSetHash") AS "storedMatches"
      FROM old_root o CROSS JOIN candidate_root c
      CROSS JOIN "ActivitySettlementContributionRevision" r WHERE r.id=${revisionId}
    `;
    },
    { timeout: 30_000 },
  );
  expect(comparison).toEqual({
    oldCount: expectedCount ?? root.evaluationCount,
    candidateCount: expectedCount ?? root.evaluationCount,
    totalMatches: true,
    sourceMatches: true,
    evaluationMatches: true,
    storedMatches: true,
  });
}
async function assertE4SliceSourceDenominators(db: PrismaClient, revisionId: string) {
  // Outside every measured business command. The independent fixed fixture has
  // five slices per allocation, including two volunteer slices and a zero-point
  // non-creditable slice; D4 still has four allocation/category associations.
  const [actual] = await db.$queryRaw<
    {
      sources: number;
      slices: number;
      allocations: number;
      volunteer: number;
      training: number;
      organization: number;
      nonCredit: number;
      invalidReferences: number;
      invalidAllocations: number;
    }[]
  >`
    WITH refs AS MATERIALIZED (
      SELECT e."timeCategoryCode" AS category,
        r.value->>'allocationRevisionId' AS allocation,
        r.value->>'sliceId' AS slice
      FROM "ParticipantContributionEvaluation" e
      CROSS JOIN LATERAL jsonb_array_elements(e."sourceRefsJson") r(value)
      WHERE e."contributionRevisionId"=${revisionId}
    ), invalid_allocations AS (
      SELECT allocation FROM refs GROUP BY allocation
      HAVING count(*)<>5 OR count(DISTINCT slice)<>5
        OR count(*) FILTER (WHERE category='volunteer_service')<>2
        OR count(*) FILTER (WHERE category='training')<>1
        OR count(*) FILTER (WHERE category='organization')<>1
        OR count(*) FILTER (WHERE category='non_creditable')<>1
    )
    SELECT count(*)::int AS sources, count(DISTINCT slice)::int AS slices,
      count(DISTINCT allocation)::int AS allocations,
      count(*) FILTER (WHERE category='volunteer_service')::int AS volunteer,
      count(*) FILTER (WHERE category='training')::int AS training,
      count(*) FILTER (WHERE category='organization')::int AS organization,
      count(*) FILTER (WHERE category='non_creditable')::int AS "nonCredit",
      count(*) FILTER (WHERE allocation IS NULL OR slice IS NULL
        OR category NOT IN ('volunteer_service','training','organization','non_creditable'))::int
        AS "invalidReferences",
      (SELECT count(*)::int FROM invalid_allocations) AS "invalidAllocations"
    FROM refs
  `;
  expect(actual).toEqual({
    sources: 50000,
    slices: 50000,
    allocations: 10000,
    volunteer: 20000,
    training: 10000,
    organization: 10000,
    nonCredit: 10000,
    invalidReferences: 0,
    invalidAllocations: 0,
  });
}

async function assertFixedE4DayOracle(db: PrismaClient, revisionId: string, expectedCount: number) {
  await assertE4SliceSourceDenominators(db, revisionId);
  const source = readFileSync(
    resolve(__dirname, 'activity-os-r5-e4-contribution-settlement-migration.e2e-spec.ts'),
    'utf8',
  );
  const fixed = [...source.matchAll(/const E4_P_DAY_ORACLE_SQL = String\.raw`([\s\S]*?)`;/gu)];
  expect(fixed).toHaveLength(1);
  expect(createHash('sha256').update(fixed[0][1]).digest('hex')).toBe(
    'a8cdf667c0632e832d10ea2912ebd510e84163097ddfc594f55d000746446274',
  );
  const rollback = new Error('E4 complete actual day oracle rollback');
  let completed = false;
  try {
    // Test-only DDL is deliberately separate from the existing READ ONLY full-document oracle.
    await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout='30s'`;
        await tx.$executeRawUnsafe(
          fixed[0][1].replace(
            'CREATE FUNCTION e4_day_points(',
            'CREATE FUNCTION pg_temp.e4_day_points_1220_oracle(',
          ),
        );
        const [namespace] = await tx.$queryRaw<{ temporary: boolean }[]>`
        SELECT p.pronamespace=pg_my_temp_schema() AS temporary FROM pg_proc p
        WHERE p.oid='pg_temp.e4_day_points_1220_oracle(jsonb,integer)'::regprocedure
      `;
        expect(namespace.temporary).toBe(true);
        const [comparison] = await tx.$queryRaw<
          {
            evaluations: number;
            sources: number;
            candidateDifferences: number;
            storedDifferences: number;
          }[]
        >`
        WITH actual AS MATERIALIZED (
          SELECT "sourceRefsJson",("recognizedPoints"*100)::integer AS hundredths,"beijingDayPointsJson"
          FROM "ParticipantContributionEvaluation" WHERE "contributionRevisionId"=${revisionId}
        ), results AS MATERIALIZED (
          SELECT jsonb_array_length("sourceRefsJson") AS sources,"beijingDayPointsJson" AS stored,
            pg_temp.e4_day_points_1220_oracle("sourceRefsJson",hundredths) AS old_day,
            public.e4_day_points("sourceRefsJson",hundredths) AS candidate_day FROM actual
        ) SELECT count(*)::int AS evaluations,coalesce(sum(sources),0)::int AS sources,
          count(*) FILTER (WHERE old_day IS DISTINCT FROM candidate_day)::int AS "candidateDifferences",
          count(*) FILTER (WHERE old_day IS DISTINCT FROM stored)::int AS "storedDifferences" FROM results
      `;
        expect(comparison).toEqual({
          evaluations: expectedCount,
          sources: 50000,
          candidateDifferences: 0,
          storedDifferences: 0,
        });
        completed = true;
        throw rollback;
      },
      { timeout: 60_000 },
    );
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    const [residue] = await db.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE p.proname='e4_day_points_1220_oracle' AND n.nspname LIKE 'pg_temp_%'
    `;
    expect(residue.count).toBe(0);
  }
  expect(completed).toBe(true);
}

// This file is read as data, never imported: importing an E2E spec would register its lifecycle.
async function assertFixedE4Oracle(db: PrismaClient, revisionId: string, expectedCount?: number) {
  const root = await db.activitySettlementContributionRevision.findUniqueOrThrow({
    where: { id: revisionId },
  });
  await assertFixedE4DayOracle(db, revisionId, expectedCount ?? root.evaluationCount);
  await assertFixedE4RootOracle(db, revisionId, expectedCount);
  if (root.sourceKindCode === 'unchanged_time') {
    expect(root.previousContributionRevisionId).not.toBeNull();
    const previous = await db.activitySettlementContributionRevision.findUniqueOrThrow({
      where: { id: root.previousContributionRevisionId! },
    });
    expect(root).toMatchObject({
      sourceSetHash: previous.sourceSetHash,
      evaluationSetHash: previous.evaluationSetHash,
      evaluationCount: previous.evaluationCount,
      recognizedPointsTotal: previous.recognizedPointsTotal,
    });
    const [copy] = await db.$queryRaw<{ equal: boolean }[]>`
      SELECT (
        SELECT coalesce(jsonb_agg(e4_evaluation_document(e) ORDER BY e."evaluationUnitKey" COLLATE "C"),'[]'::jsonb)
        FROM "ParticipantContributionEvaluation" e WHERE e."contributionRevisionId"=${root.id}
      ) IS NOT DISTINCT FROM (
        SELECT coalesce(jsonb_agg(e4_evaluation_document(e) ORDER BY e."evaluationUnitKey" COLLATE "C"),'[]'::jsonb)
        FROM "ParticipantContributionEvaluation" e WHERE e."contributionRevisionId"=${previous.id}
      ) AS equal
    `;
    expect(copy.equal).toBe(true);
    await assertFixedE4Oracle(db, previous.id, expectedCount);
    return;
  }
  const oracleSource = readFileSync(
    resolve(__dirname, 'activity-os-r5-e4-contribution-settlement-migration.e2e-spec.ts'),
    'utf8',
  );
  const matches = [
    ...oracleSource.matchAll(/const E4_P_CANONICAL_ORACLE_SQL = String\.raw`([\s\S]*?)`;/gu),
  ];
  expect(matches).toHaveLength(1);
  const oldSql = matches[0][1];
  expect(createHash('sha256').update(oldSql).digest('hex')).toBe(
    '1aaf91d632713dddaeb106ad4095ac5650aa65416841f8c865d2fd0020fa465b',
  );
  const parts = oldSql.split(/\brevision_id\b/u);
  expect(parts).toHaveLength(3);
  // Only the fixed old SQL is raw. Identifiers are bound values, never string interpolation.
  const oracle = Prisma.join(
    parts.flatMap((part, index) =>
      index === parts.length - 1
        ? [Prisma.raw(part)]
        : [Prisma.raw(part), Prisma.sql`${revisionId}::text`],
    ),
    '',
  );
  const [comparison] = await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$executeRaw`SET LOCAL statement_timeout='30s'`;
      return tx.$queryRaw<
        {
          oldCount: number;
          candidateCount: number;
          storedCount: number;
          candidateDifferences: number;
          storedDifferences: number;
          rootMatches: boolean;
        }[]
      >`
        WITH oracle(unit_canonical,evaluation) AS MATERIALIZED (${oracle}),
        candidate AS MATERIALIZED (SELECT * FROM e4_expected_evaluations(${revisionId})),
        stored AS MATERIALIZED (
          SELECT e4_evaluation_document(e) AS evaluation FROM "ParticipantContributionEvaluation" e
          WHERE e."contributionRevisionId"=${revisionId}
        ), summary AS (
          SELECT count(*)::int AS count,coalesce(sum((evaluation->>'recognizedPoints')::numeric),0) AS points,
            e4_envelope_hash(jsonb_build_object('domain',${root.sourceKindCode}::text,'sources',
              coalesce(jsonb_agg(jsonb_build_object('evaluationUnitKey',evaluation->>'evaluationUnitKey',
                'sourceFingerprint',evaluation->>'sourceFingerprint') ORDER BY unit_canonical COLLATE "C"),'[]'::jsonb))) AS source_hash,
            e4_envelope_hash(jsonb_build_object('evaluations',
              coalesce(jsonb_agg(evaluation->>'evaluationHash' ORDER BY unit_canonical COLLATE "C"),'[]'::jsonb))) AS evaluation_hash
          FROM oracle
        )
        SELECT (SELECT count(*)::int FROM oracle) AS "oldCount",
          (SELECT count(*)::int FROM candidate) AS "candidateCount",
          (SELECT count(*)::int FROM stored) AS "storedCount",
          (SELECT count(*)::int FROM oracle o FULL JOIN candidate c USING (unit_canonical)
            WHERE o.unit_canonical IS NULL OR c.unit_canonical IS NULL OR o.evaluation IS DISTINCT FROM c.evaluation) AS "candidateDifferences",
          (SELECT count(*)::int FROM oracle o FULL JOIN stored s
            ON o.evaluation->>'evaluationUnitKey'=s.evaluation->>'evaluationUnitKey'
            WHERE o.evaluation IS DISTINCT FROM s.evaluation) AS "storedDifferences",
          (SELECT s.count=r."evaluationCount" AND s.points=r."recognizedPointsTotal"
             AND s.source_hash=r."sourceSetHash" AND s.evaluation_hash=r."evaluationSetHash"
           FROM summary s CROSS JOIN "ActivitySettlementContributionRevision" r WHERE r.id=${revisionId}) AS "rootMatches"
      `;
    },
    { timeout: 30_000 },
  );
  expect(comparison).toEqual({
    oldCount: expectedCount ?? root.evaluationCount,
    candidateCount: expectedCount ?? root.evaluationCount,
    storedCount: expectedCount ?? root.evaluationCount,
    candidateDifferences: 0,
    storedDifferences: 0,
    rootMatches: true,
  });
}

const S13_LOCAL_DB = E4_D1_SCOPE;

/** One existing local psql backend per client; stdout stays private until numeric projection. */
// E4_TERMINAL_REPLACE_CLIENT_BEGIN
class S13ReadClient {
  private child?: ReturnType<typeof spawn>;
  private sequence = 0;
  private buffer = '';
  private closed = false;
  private pending?: {
    marker: string;
    lines: string[];
    resolve: (v: string) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  constructor(private readonly database: 'postgres' | typeof S13_LOCAL_DB) {}
  async connect(timeoutMs = 30_000) {
    if (this.child || this.closed) throw new Error('S13 client cannot reconnect');
    this.child = spawn(
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
        this.database,
        '-v',
        'ON_ERROR_STOP=1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const invalidate = () => {
      this.closed = true;
      if (this.pending) {
        clearTimeout(this.pending.timer);
        this.pending.reject(new Error('S13 read backend ended; terminal may be unknown'));
        this.pending = undefined;
      }
    };
    this.child.stderr!.resume();
    this.child.once('exit', invalidate);
    this.child.once('error', invalidate);
    this.child.stdin!.once('error', invalidate);
    this.child.stdout!.on('data', (part: Buffer) => {
      this.buffer += part.toString();
      if (this.buffer.length > 2 * 1024 * 1024) {
        invalidate();
        return;
      }
      let end: number;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end).replace(/\r$/u, '');
        this.buffer = this.buffer.slice(end + 1);
        const pending = this.pending;
        if (!pending) continue;
        if (line === pending.marker) {
          clearTimeout(pending.timer);
          this.pending = undefined;
          pending.resolve(pending.lines.join('\n').trim());
        } else {
          pending.lines.push(line);
          if (pending.lines.join('\n').length > 2 * 1024 * 1024) {
            invalidate();
            return;
          }
        }
      }
    });
    const identity = await this.query<{ db: string }>(
      'SELECT current_database() AS db',
      [],
      timeoutMs,
    );
    expect(identity.rows).toEqual([{ db: this.database }]);
  }
  private request(sql: string, timeoutMs = 30_000) {
    terminalRequestBudget(timeoutMs);
    if (this.closed || !this.child || !this.child.stdin!.writable || this.pending)
      return Promise.reject(new Error('S13 pending/closed backend refused'));
    return new Promise<string>((resolve, reject) => {
      const marker = 'SRVF_S13_' + ++this.sequence;
      const timer = setTimeout(() => {
        this.closed = true;
        this.pending = undefined;
        reject(new Error('S13 read deadline; terminal unknown, DROP prohibited'));
      }, timeoutMs);
      this.pending = { marker, lines: [], resolve, reject, timer };
      this.child!.stdin!.write(sql + ';\n\\echo ' + marker + '\n');
    });
  }
  async query<T = never>(
    sql: string,
    values: (string | number | undefined)[] = [],
    timeoutMs = 30_000,
  ): Promise<{ rows: T[] }> {
    const bind = sql.replace(/\$([12])\b/gu, (_match, position: string) => {
      const value = values[Number(position) - 1];
      if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
      if (typeof value !== 'string') throw new Error('S13 fixed parameter missing');
      return "'" + value.replaceAll("'", "''") + "'";
    });
    if (/^SELECT\b/u.test(bind)) {
      const text = await this.request(
        "SELECT coalesce(json_agg(s13_row),'[]'::json)::text FROM (" + bind + ') s13_row',
        timeoutMs,
      );
      const rows: unknown = JSON.parse(text);
      if (!Array.isArray(rows)) throw new Error('S13 read envelope missing');
      return { rows: rows as T[] };
    }
    const text = await this.request(bind, timeoutMs);
    if (/^EXPLAIN\b/u.test(bind)) {
      const plan: unknown = JSON.parse(text);
      return { rows: [{ 'QUERY PLAN': plan }] as T[] };
    }
    if (text !== '') throw new Error('S13 command returned unexpected data');
    return { rows: [] };
  }
  terminalState() {
    return { pending: this.pending !== undefined, closed: this.closed };
  }
  async end(timeoutMs = 10_000) {
    terminalRequestBudget(timeoutMs);
    const child = this.child;
    if (!child) return;
    if (this.pending) throw new Error('S13 pending backend cannot be reported closed');
    if (child.exitCode !== null) {
      if (child.exitCode !== 0) throw new Error('S13 backend exit failed');
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('S13 backend close unknown')),
        Math.min(timeoutMs, 10_000),
      );
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error('S13 backend close failed'));
      });
      child.stdin!.end('\\q\n');
    });
    this.closed = true;
  }
}
// E4_TERMINAL_REPLACE_CLIENT_END
type S13DropFacts = {
  databases: number;
  clients: number;
  ownerBackends: number;
  leaseLocks: number;
};
type S13ProbeState = {
  active: boolean;
  failed: boolean;
  expired: boolean;
  businessPassed: boolean;
  appClosed: boolean;
  measuredClosed: boolean;
  planClosed: boolean;
  pending: number;
  owner?: ScratchLeaseSession;
  beforeDrop?: S13DropFacts & { readAt: number };
  monitor?: S13ReadClient;
  rootId?: string;
  restoreApp?: () => void;
};
const s13Probe: S13ProbeState = {
  active: false,
  failed: false,
  expired: false,
  businessPassed: false,
  appClosed: false,
  measuredClosed: false,
  planClosed: false,
  pending: 0,
};
function s13DropAllowed(state: S13ProbeState, receiver: unknown, now: number): boolean {
  if (receiver !== state.owner) return false;
  if (!state.active) return true; // Only the original installer's pre-fixture DROP.
  const facts = state.beforeDrop;
  return (
    !state.failed &&
    !state.expired &&
    state.businessPassed &&
    state.appClosed &&
    state.measuredClosed &&
    state.planClosed &&
    state.pending === 0 &&
    facts !== undefined &&
    now - facts.readAt >= 0 &&
    now - facts.readAt <= 1000 &&
    facts.databases === 1 &&
    facts.clients === 0 &&
    facts.ownerBackends === 1 &&
    facts.leaseLocks === 1
  );
}
function s13DropGate(
  original: (this: object, ...args: unknown[]) => Promise<void>,
  allowed: (receiver: object) => boolean,
) {
  return function (this: object, ...args: unknown[]) {
    if (!allowed(this))
      return Promise.reject(new Error('S13 ordinary DROP refused; evidence retained'));
    return Reflect.apply(original, this, args);
  };
}
function calibrateS13DropGate() {
  const owner = {},
    foreign = {};
  const originalPromise = Promise.resolve();
  const calls: { receiver: object; args: unknown[] }[] = [];
  const original = function (this: object, ...args: unknown[]) {
    calls.push({ receiver: this, args });
    return originalPromise;
  };
  const baseline = {
    ...s13Probe,
    owner: owner as ScratchLeaseSession,
    active: true,
    businessPassed: true,
    appClosed: true,
    measuredClosed: true,
    planClosed: true,
    beforeDrop: { databases: 1, clients: 0, ownerBackends: 1, leaseLocks: 1, readAt: 100 },
  };
  const allowed = s13DropGate(original, (receiver) => s13DropAllowed(baseline, receiver, 101));
  const sentinel = {};
  expect(allowed.call(owner, sentinel)).toBe(originalPromise);
  expect(calls).toEqual([{ receiver: owner, args: [sentinel] }]);
  // Calibrate the same decision function, not a separate mock copy of the guard.
  expect(s13DropAllowed(baseline, foreign, 101)).toBe(false);
  for (const variation of [
    { failed: true },
    { expired: true },
    { pending: 1 },
    { planClosed: false },
    { appClosed: false },
    { measuredClosed: false },
    { beforeDrop: undefined },
    { beforeDrop: { ...baseline.beforeDrop, clients: 1 } },
    { beforeDrop: { ...baseline.beforeDrop, ownerBackends: 0 } },
    { beforeDrop: { ...baseline.beforeDrop, leaseLocks: 0 } },
  ])
    expect(s13DropAllowed({ ...baseline, ...variation }, owner, 101)).toBe(false);
  expect(s13DropAllowed(baseline, owner, 1101)).toBe(false);
  expect(s13DropAllowed({ ...baseline, active: false }, owner, 101)).toBe(true);
}
calibrateS13DropGate();

// E4_TERMINAL_REPLACE_LIFECYCLE_BEGIN
function observeS13Lifecycle() {
  const prototype = ScratchLeaseSession.prototype;
  const acquire: unknown = Reflect.get(prototype, 'acquire');
  const drop: unknown = Reflect.get(prototype, 'dropDatabase');
  if (typeof acquire !== 'function' || typeof drop !== 'function')
    throw new Error('S13 original lifecycle method missing');
  const acquireDescriptor = Object.getOwnPropertyDescriptor(prototype, 'acquire')!;
  const dropDescriptor = Object.getOwnPropertyDescriptor(prototype, 'dropDatabase')!;
  Object.defineProperty(prototype, 'acquire', {
    ...acquireDescriptor,
    value: function (this: ScratchLeaseSession, ...args: unknown[]) {
      const promise = Reflect.apply(acquire, this, args) as Promise<void>;
      void promise.then(
        () => {
          if (s13Probe.owner && s13Probe.owner !== this) s13Probe.failed = true;
          s13Probe.owner = this;
        },
        () => {
          s13Probe.failed = true;
        },
      );
      return promise;
    },
  });
  Object.defineProperty(prototype, 'dropDatabase', {
    ...dropDescriptor,
    value: s13DropGate(
      function (this: object, ...args: unknown[]) {
        return Reflect.apply(drop, this, args) as Promise<void>;
      },
      (receiver) => {
        if (!terminalPostDropAllowed()) return false;
        const held = s13Probe.owner;
        if (!held) return false;
        try {
          held.assertHeld();
        } catch {
          return false;
        }
        return s13DropAllowed(s13Probe, receiver, performance.now());
      },
    ),
  });
  return () => {
    Object.defineProperty(prototype, 'acquire', acquireDescriptor);
    Object.defineProperty(prototype, 'dropDatabase', dropDescriptor);
    expect(Reflect.get(prototype, 'acquire')).toBe(acquire);
    expect(Reflect.get(prototype, 'dropDatabase')).toBe(drop);
  };
}
// E4_TERMINAL_REPLACE_LIFECYCLE_END

// E4_S13_FORMAT_SOURCE_HELPER_BEGIN
const E4_S13_FORMAT_OPENING_SHA =
  'b056ad26a9fce4129c8e943c4d1e48b5ac1b95bce46cb4e3ba7542380ef63bd8';
const E4_S13_FORMAT_PATTERN = '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$';
function s13FormatRegex(key: 'startsAt' | 'endsAt') {
  return "(ref->>'" + key + "') ~ '" + E4_S13_FORMAT_PATTERN + "'";
}
function s13FormatCase(key: 'startsAt' | 'endsAt') {
  return [
    'CASE',
    "        WHEN pg_catalog.translate(ref->>'" + key + "', '0123456789', '0000000000')",
    '             COLLATE "C" = \'0000-00-00T00:00:00.000Z\' COLLATE "C"',
    '        THEN TRUE',
    '        ELSE ' + s13FormatRegex(key),
    '      END',
  ].join('\n');
}
/** Historical input only; actual candidate queries always use the independently read SQL. */
function restoreS13FormatOpening(source: string): string {
  if (createHash('sha256').update(source).digest('hex') === E4_S13_FORMAT_OPENING_SHA)
    return source;
  let restored = source;
  for (const key of ['startsAt', 'endsAt'] as const) {
    const expression = s13FormatCase(key);
    if (restored.split(expression).length !== 2)
      throw new Error('S13 historical format inverse count mismatch');
    restored = restored.replace(expression, () => s13FormatRegex(key));
  }
  if (createHash('sha256').update(restored).digest('hex') !== E4_S13_FORMAT_OPENING_SHA)
    throw new Error('S13 historical format inverse full source mismatch');
  return restored;
}
// E4_S13_FORMAT_SOURCE_HELPER_END

// E4_TERMINAL_REPLACE_S13_INPUT_BEGIN
function s13FixedOpeningQueries() {
  const testSource = readFileSync(
    resolve(__dirname, 'activity-os-r5-e4-contribution-settlement-migration.e2e-spec.ts'),
    'utf8',
  );
  const openings = [
    ...testSource.matchAll(/const E4_P_SET_NEW_WINDOW_SQL = String\.raw`([\s\S]*?)`;/gu),
  ];
  expect(openings).toHaveLength(1);
  const actualMigration = readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20261003000000_activity_contribution_settlement/migration.sql',
    ),
    'utf8',
  );
  const migration = restoreS13FormatOpening(booleanScaleHistorySource(actualMigration));
  const windows = [
    ...actualMigration.matchAll(
      / {4}IF EXISTS \(\n {6}WITH expected AS NOT MATERIALIZED \([\s\S]*?CONSTRAINT='e4_evaluation_guard'; END IF;\n/gu,
    ),
  ];
  expect(windows).toHaveLength(1);
  const candidates = [
    ...testSource.matchAll(/const E4_COLLECTION_BOOLEAN_WINDOW_SQL = String\.raw`([\s\S]*?)`;/gu),
  ];
  const historical = [
    ...testSource.matchAll(/const E4_S13_WINDOW_SQL = String\.raw`([\s\S]*?)`;/gu),
  ];
  expect(candidates).toHaveLength(1);
  expect(historical).toHaveLength(1);
  expect(windows[0][0]).toBe(candidates[0][1]);
  expect(
    createHash('sha256')
      .update(
        migration.replace(
          readBooleanWindowConstant('E4_COLLECTION_PAIR_WINDOW_SQL'),
          () => historical[0][1],
        ),
      )
      .digest('hex'),
  ).toBe('96e4dfae0f00a3321b43d02ace0314442483f535673526a76fa043e03075b4b4');
  const restored = migration.replace(
    readBooleanWindowConstant('E4_COLLECTION_PAIR_WINDOW_SQL'),
    () => openings[0][1],
  );
  expect(createHash('sha256').update(restored).digest('hex')).toBe(
    '3f73112f745247fd5ce4762a1b8e8d3551e4648f48ec47e76eb9b54ad4fd8b02',
  );
  const bind = (window: string) => {
    const prefix = '    IF EXISTS (\n';
    const suffix =
      "\n    ) THEN RAISE EXCEPTION 'contribution evaluation set mismatch' USING ERRCODE='23514',CONSTRAINT='e4_evaluation_guard'; END IF;\n";
    expect(window.startsWith(prefix)).toBe(true);
    expect(window.endsWith(suffix)).toBe(true);
    const query = window.slice(prefix.length, -suffix.length);
    expect(query.split('root.id')).toHaveLength(4);
    return query.split('root.id').join('$1::text');
  };
  return {
    old: terminalQualifyQuery(bind(openings[0][1]), 'old', 3),
    candidate: terminalQualifyQuery(bind(windows[0][0]), 'candidate', 3),
  };
}
// E4_TERMINAL_REPLACE_S13_INPUT_END

async function s13ScopedFacts(monitor: S13ReadClient): Promise<S13DropFacts> {
  const pid = s13Probe.owner?.backendPid;
  if (!pid) throw new Error('S13 original owner backend unknown');
  const result = await monitor.query<S13DropFacts>(
    `SELECT
      (SELECT count(*)::int FROM pg_database WHERE datname=$1) AS databases,
      (SELECT count(*)::int FROM pg_stat_activity WHERE datname=$1) AS clients,
      (SELECT count(*)::int FROM pg_stat_activity WHERE pid=$2 AND datname='postgres') AS "ownerBackends",
      (SELECT count(*)::int FROM pg_locks WHERE pid=$2 AND locktype='advisory' AND granted
        AND classid=((hashtextextended('SRVF:test:D3:app_test_w98',0)>>32)&4294967295)::oid
        AND objid=(hashtextextended('SRVF:test:D3:app_test_w98',0)&4294967295)::oid
        AND objsubid=1) AS "leaseLocks"`,
    [S13_LOCAL_DB, pid],
  );
  expect(result.rows).toHaveLength(1);
  for (const value of Object.values(result.rows[0]))
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
      throw new Error('S13 scoped resource count unavailable');
  return result.rows[0];
}

function compactS13Plan(value: unknown) {
  const compact = compactPSetPlan(value);
  const envelope = value as { Plan: object }[];
  let pairRows: number | undefined;
  let matchedRows: number | undefined;
  const walk = (node: object, actualCte = false) => {
    actualCte = actualCte || Reflect.get(node, 'Subplan Name') === 'CTE actual';
    const rows: unknown = Reflect.get(node, 'Actual Rows');
    const loops: unknown = Reflect.get(node, 'Actual Loops');
    if (Reflect.get(node, 'Subplan Name') === 'CTE pairs') {
      if (pairRows !== undefined || loops !== 1) throw new Error('S13 pairs coverage ambiguous');
      if (typeof rows !== 'number' || !Number.isFinite(rows)) throw new Error('S13 pairs missing');
      pairRows = rows;
    }
    if (!actualCte && Reflect.get(node, 'Relation Name') === 'ParticipantContributionEvaluation') {
      if (matchedRows !== undefined) throw new Error('S13 back-join coverage ambiguous');
      if (
        typeof rows !== 'number' ||
        !Number.isFinite(rows) ||
        rows < 0 ||
        typeof loops !== 'number' ||
        !Number.isFinite(loops) ||
        loops < 0
      )
        throw new Error('S13 back-join missing');
      matchedRows = rows * loops;
    }
    const children: unknown = Reflect.get(node, 'Plans');
    if (children !== undefined) {
      if (!Array.isArray(children)) throw new Error('S13 plan children missing');
      for (const child of children as unknown[]) {
        if (!child || typeof child !== 'object') throw new Error('S13 child missing');
        walk(child, actualCte);
      }
    }
  };
  walk(envelope[0].Plan);
  expect(pairRows).toBe(8000);
  // The actual CTE and its full-document back-join both scan this one root's entire stored bag.
  expect(matchedRows).toBe(8000);
  return { ...compact, pairs: pairRows, fullRows: matchedRows };
}

function calibrateS13PlanCoverage() {
  const node = (name: string, rows: number, loops = 1) => ({
    'Node Type': 'Result',
    'Actual Rows': rows,
    'Actual Loops': loops,
    'Plan Width': 16,
    'Subplan Name': name,
  });
  const envelope = () => [
    {
      'Execution Time': 1,
      Plan: {
        ...node('', 0),
        Plans: [
          node('CTE expected', 8000),
          {
            ...node('CTE actual', 8000),
            Plans: [{ ...node('', 8000), 'Relation Name': 'ParticipantContributionEvaluation' }],
          },
          node('CTE pairs', 8000),
          { ...node('', 8000), 'Relation Name': 'ParticipantContributionEvaluation' },
        ],
      },
    },
  ];
  expect(compactS13Plan(envelope())).toMatchObject({ pairs: 8000, fullRows: 8000 });
  const nested = envelope();
  nested[0].Plan.Plans[3]['Actual Rows'] = 1;
  nested[0].Plan.Plans[3]['Actual Loops'] = 8000;
  expect(compactS13Plan(nested).fullRows).toBe(8000);
  const missing = envelope();
  missing[0].Plan.Plans.pop();
  expect(() => compactS13Plan(missing)).toThrow();
  const shortPairs = envelope();
  shortPairs[0].Plan.Plans[2]['Actual Rows'] = 7999;
  expect(() => compactS13Plan(shortPairs)).toThrow();
  const duplicate = envelope();
  duplicate[0].Plan.Plans.push(node('CTE pairs', 8000));
  expect(() => compactS13Plan(duplicate)).toThrow();
  const absentNumeric = envelope();
  Reflect.deleteProperty(absentNumeric[0].Plan, 'Actual Loops');
  expect(() => compactS13Plan(absentNumeric)).toThrow();
  const tooMany = envelope();
  tooMany[0].Plan.Plans.push(...Array.from({ length: 257 }, () => node('', 0)));
  expect(() => compactS13Plan(tooMany)).toThrow();
}
calibrateS13PlanCoverage();

// E4_TERMINAL_REPLACE_S13_RUN_BEGIN
async function runS13IndependentProbe() {
  if (!s13Probe.businessPassed || !s13Probe.appClosed || !s13Probe.measuredClosed)
    throw new Error('S13 original business clients were not confirmed closed');
  const url = new URL(process.env.DATABASE_URL!);
  assertTestDatabaseUrl(url.toString());
  if (url.pathname !== '/' + S13_LOCAL_DB) throw new Error('S13 exact isolated database mismatch');
  const monitor = new S13ReadClient('postgres');
  const plan = new S13ReadClient(S13_LOCAL_DB);
  // Pending/resources are registered before either asynchronous connection is opened.
  s13Probe.monitor = monitor;
  s13Probe.pending++;
  const deadline = performance.now() + 75_000;
  const timer = setTimeout(() => {
    s13Probe.expired = true;
  }, 75_000);
  let planConnected = false;
  let transactionLive = false;
  let planPid: number | undefined;
  let terminalIdentity: TerminalIdentity | undefined;
  let terminalCatalog: ReturnType<typeof terminalValidateCatalog> | undefined;
  let terminalCleaned = false;
  const retained: unknown[] = [];
  try {
    await monitor.connect(terminalRemaining(deadline));
    const scoped = await s13ScopedFacts(monitor);
    expect(scoped).toMatchObject({ databases: 1, clients: 0, ownerBackends: 1, leaseLocks: 1 });
    planConnected = true;
    await plan.connect(terminalRemaining(deadline));
    const identity = await plan.query<{ db: string; pid: number }>(
      'SELECT current_database() AS db,pg_backend_pid() AS pid',
    );
    expect(identity.rows).toHaveLength(1);
    expect(identity.rows[0].db).toBe(S13_LOCAL_DB);
    planPid = identity.rows[0].pid;
    if (planPid === undefined || !Number.isInteger(planPid) || planPid <= 0)
      throw new Error('S13 actual plan PID missing');
    terminalIdentity = await terminalNativeIdentity(plan, deadline);
    if (!terminalS13Principal) throw new Error('Terminal actual business principal missing');
    terminalAssertIdentity(terminalIdentity, terminalS13Principal);
    if (terminalIdentity.pid !== planPid)
      throw new Error('Terminal physical plan identity changed');
    terminalCatalog = await terminalInstallOpening(plan, deadline, terminalIdentity);
    const queries = s13FixedOpeningQueries();
    for (const order of ['AB', 'BA'] as const) {
      if (s13Probe.expired || performance.now() >= deadline)
        throw new Error('S13 deadline unknown');
      const pairStarted = performance.now();
      const pairDeadline = Math.min(deadline, pairStarted + 30_000);
      const run = async (kind: 'old' | 'candidate') => {
        await plan.query('BEGIN READ ONLY', [], terminalRemaining(pairDeadline));
        transactionLive = true;
        await plan.query(
          "SET LOCAL statement_timeout='" +
            Math.min(15_000, terminalRemaining(pairDeadline)) +
            "ms'",
          [],
          terminalRemaining(pairDeadline),
        );
        try {
          const started = performance.now();
          const result = await plan.query<{ 'QUERY PLAN': unknown }>(
            'EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, VERBOSE, FORMAT JSON) ' + queries[kind],
            [s13Probe.rootId],
            terminalRemaining(pairDeadline),
          );
          const wallMs = performance.now() - started;
          expect(result.rows).toHaveLength(1);
          terminalPlanProvenance(
            result.rows[0]['QUERY PLAN'],
            kind,
            terminalCatalog,
            terminalIdentity,
          );
          const compact =
            kind === 'candidate'
              ? compactBooleanCollectionPlan(result.rows[0]['QUERY PLAN'])
              : compactPSetPlan(result.rows[0]['QUERY PLAN']);
          return { kind, wallMs, ...compact };
        } finally {
          await plan.query('ROLLBACK', [], terminalRemaining(pairDeadline));
          transactionLive = false;
          const terminal = await monitor.query<{ idle: boolean }>(
            "SELECT state='idle' AND xact_start IS NULL AS idle FROM pg_stat_activity WHERE pid=$1 AND datname=$2",
            [planPid, S13_LOCAL_DB],
            terminalRemaining(pairDeadline),
          );
          expect(terminal.rows).toEqual([{ idle: true }]);
        }
      };
      const first = await run(order === 'AB' ? 'old' : 'candidate');
      const second = await run(order === 'AB' ? 'candidate' : 'old');
      expect(performance.now() - pairStarted).toBeLessThan(30_000);
      const pair = {
        order,
        old: order === 'AB' ? first : second,
        candidate: order === 'AB' ? second : first,
      };
      retained.push(pair);
      const report = JSON.stringify(retained);
      expect(Buffer.byteLength(report, 'utf8')).toBeLessThanOrEqual(32 * 1024);
      console.info('E4_S13_EXACT_FULL_DOC_PROBE', JSON.stringify(pair));
      expect(pair.candidate.executionMs).toBeLessThan(pair.old.executionMs);
      expect(pair.candidate.wallMs).toBeLessThan(pair.old.wallMs);
      if (pair.old.tempWritten > 0)
        expect(pair.candidate.tempWritten).toBeLessThan(pair.old.tempWritten);
    }
    expect(s13Probe.expired).toBe(false);
    await terminalDropOpening(plan, monitor, deadline, terminalIdentity, terminalCatalog.current);
    terminalCleaned = true;
    await plan.end(terminalRemaining(deadline));
    expect(performance.now()).toBeLessThan(deadline);
    planConnected = false;
    s13Probe.planClosed = true;
    const beforeDrop = await s13ScopedFacts(monitor);
    expect(beforeDrop).toEqual({ databases: 1, clients: 0, ownerBackends: 1, leaseLocks: 1 });
    s13Probe.beforeDrop = { ...beforeDrop, readAt: performance.now() };
  } catch (error) {
    s13Probe.failed = true;
    throw error;
  } finally {
    clearTimeout(timer);
    if (transactionLive) {
      try {
        await plan.query('ROLLBACK');
        transactionLive = false;
      } catch {
        s13Probe.expired = true;
      }
    }
    if (planConnected && !transactionLive) {
      try {
        if (!terminalCleaned && terminalIdentity && terminalCatalog && !s13Probe.expired) {
          await terminalDropOpening(
            plan,
            monitor,
            deadline,
            terminalIdentity,
            terminalCatalog.current,
          );
          terminalCleaned = true;
        }
        await plan.end();
        s13Probe.planClosed = true;
      } catch {
        s13Probe.expired = true;
      }
    }
    if (s13Probe.planClosed && terminalCleaned) s13Probe.pending--;
    else s13Probe.expired = true;
    console.info(
      'E4_TERMINAL_S13_RESOURCES',
      JSON.stringify({
        temporary: terminalCleaned ? 'ABSENT' : 'UNKNOWN',
        planClosed: s13Probe.planClosed,
        pending: s13Probe.pending,
        deadlineExpired: s13Probe.expired,
      }),
    );
  }
}
// E4_TERMINAL_REPLACE_S13_RUN_END

// E4_TERMINAL_OFFLINE_BEGIN
describe('E4 terminal expected measurement offline', () => {
  it('pins the independent frozen full function and actual one-word migration', () => {
    const frozen = terminalFrozenExpected();
    const actual = terminalActualSource();
    expect(terminalHash(actual)).toBe(E4_TERMINAL_ACTUAL_SHA);
    expect(terminalHash(frozen.definition)).toBe(E4_TERMINAL_OLD_FUNCTION_SHA);
    expect(terminalHash(frozen.body)).toBe(
      '1d970802eb5e3694fa99bd9f18f202d052cf226cca3fee272939edc16a3b8f86',
    );
    expect(terminalHash(terminalExpectedDefinition(actual).body)).toBe(
      'a6867ae83b56106b2507276252972d1aa37fbbfa64b8da33dbee33f9ebf5e6b6',
    );
    expect(terminalHash(terminalOpeningMigrationSource(actual))).toBe(E4_TERMINAL_OPENING_SHA);
    expect(
      terminalTemporaryDefinition().replace(
        'CREATE FUNCTION pg_temp.e4_expected_evaluations_1234_opening(',
        () => 'CREATE FUNCTION e4_expected_evaluations(',
      ),
    ).toBe(frozen.definition);
    expect(terminalTemporaryDefinition().split('$$')).toHaveLength(3);
  });
  it('demonstrates the dollar-delimiter replacement trap without using it to produce SQL', () => {
    const frozen = terminalFrozenExpected().definition;
    const input = '<FUNCTION>';
    expect(input.replace('<FUNCTION>', frozen)).not.toBe(frozen);
    expect(input.replace('<FUNCTION>', () => frozen)).toBe(frozen);
  });
  it.each(['missing', 'duplicate', 'changed', 'adjacent', 'outside'] as const)(
    'refuses %s actual complete function input',
    (variant) => {
      const source = terminalActualSource();
      const fn = terminalExpectedDefinition(source).definition;
      const invalid =
        variant === 'missing'
          ? source.replace(fn, '')
          : variant === 'duplicate'
            ? source + fn
            : variant === 'changed'
              ? source.replace(
                  '), canonical_documents AS NOT MATERIALIZED (',
                  '), canonical_documents AS MATERIALIZED (',
                )
              : variant === 'adjacent'
                ? source.replace('FROM canonical_documents', 'FROM canonical_documents ')
                : source + '\n';
      expect(invalid).not.toBe(source);
      expect(() => terminalOpeningMigrationSource(invalid)).toThrow();
    },
  );
  it('closes both test files, all original assertions, and the exact shared native implementation', () => {
    const migration = readFileSync(
      resolve(__dirname, 'activity-os-r5-e4-contribution-settlement-migration.e2e-spec.ts'),
      'utf8',
    );
    const scale = readFileSync(
      resolve(__dirname, 'activity-os-r5-e4-contribution-settlement-scale.e2e-spec.ts'),
      'utf8',
    );
    const local = readFileSync(__filename, 'utf8');
    expect(terminalHash(restoreTerminalScaleOpening(local))).toBe(
      '155d9385d922da97aea0181073b6e4e653ad0b86ef4344609655b115f30046a3',
    );
    const classes = (source: string) => {
      const matches = [...source.matchAll(/^class S13ReadClient \{[\s\S]*?^\}/gmu)];
      expect(matches).toHaveLength(1);
      return matches[0][0];
    };
    expect(classes(migration)).toBe(classes(scale));
    const helpers = (source: string) => {
      const from = source.indexOf('\nfunction terminalHash(');
      const to = source.indexOf('\ntype TerminalOpeningBinding', from);
      expect(from).toBeGreaterThan(0);
      expect(to).toBeGreaterThan(from);
      return source.slice(from, to);
    };
    expect(helpers(migration)).toBe(helpers(scale));
  });
  it.each(['missing', 'duplicate', 'outside', 'replacement'] as const)(
    'refuses %s test-source byte damage',
    (kind) => {
      const source = readFileSync(__filename, 'utf8');
      const marker = '// E4_TERMINAL_HELPERS_BEGIN\n';
      const invalid =
        kind === 'missing'
          ? source.replace(marker, '')
          : kind === 'duplicate'
            ? source + marker
            : kind === 'outside'
              ? source + '\n'
              : source.replace(
                  'source = terminalHistoricalBooleanInput(source);',
                  'source = terminalHistoricalBooleanInput(source + " ");',
                );
      expect(invalid).not.toBe(source);
      expect(() => restoreTerminalScaleOpening(invalid)).toThrow();
    },
  );
  it('retains two-root and three-root fixed query bindings with a sole explicit old/public call', () => {
    for (const [name, roots] of [
      ['E4_P_SET_OLD_WINDOW_SQL', 2],
      ['E4_P_SET_NEW_WINDOW_SQL', 3],
      ['E4_COLLECTION_BOOLEAN_WINDOW_SQL', 3],
    ] as const) {
      const source = readFileSync(
        resolve(__dirname, 'activity-os-r5-e4-contribution-settlement-migration.e2e-spec.ts'),
        'utf8',
      );
      const constants = [
        ...source.matchAll(
          new RegExp('const ' + name + ' = String.raw\\x60([\\s\\S]*?)\\x60;', 'gu'),
        ),
      ];
      expect(constants).toHaveLength(1);
      const query = constants[0][1]
        .slice('    IF EXISTS (\n'.length)
        .split('\n    ) THEN RAISE EXCEPTION')[0]
        .split('root.id')
        .join('$1::text');
      const kind = name === 'E4_COLLECTION_BOOLEAN_WINDOW_SQL' ? 'candidate' : 'old';
      const qualified = terminalQualifyQuery(query, kind, roots);
      const target =
        kind === 'old'
          ? 'pg_temp.e4_expected_evaluations_1234_opening($1::text)'
          : 'public.e4_expected_evaluations($1::text)';
      expect(qualified.split(target)).toHaveLength(2);
      expect(qualified.split('$1::text')).toHaveLength(roots + 1);
      expect(qualified.replace(target, () => 'e4_expected_evaluations($1::text)')).toBe(query);
      expect(() => terminalQualifyQuery(qualified, kind, roots)).toThrow();
      expect(() => terminalQualifyQuery(query + '\n' + query, kind, roots)).toThrow();
      expect(() => terminalQualifyQuery(query, kind, roots === 2 ? 3 : 2)).toThrow();
    }
  });
  const identity: TerminalIdentity = {
    db: S13_LOCAL_DB,
    pid: 17,
    session: 'synthetic',
    principal: 'synthetic',
  };
  const catalog = (): TerminalCatalog[] => {
    const base = {
      pid: 17,
      ownerMatches: true,
      owner: 1,
      acl: null,
      language: 'sql',
      volatility: 's',
      strict: false,
      invoker: true,
      parallel: 'u',
      cost: 100,
      rows: 1000,
      config: ['search_path=pg_catalog, public'],
      args: 'revision_id text',
      result: 'TABLE(unit_canonical text, evaluation jsonb)',
      defaults: 0,
      defaultExpression: null,
    };
    return [
      {
        ...base,
        scope: 'public',
        schema: 'public',
        body: E4_TERMINAL_NEW_BODY_MD5,
        bytes: E4_TERMINAL_NEW_BODY_BYTES,
        temporary: false,
      },
      {
        ...base,
        scope: 'temporary',
        schema: 'pg_temp_7',
        body: E4_TERMINAL_OLD_BODY_MD5,
        bytes: 4044,
        temporary: true,
      },
    ];
  };
  it('requires the actual full catalog, not a guessed default or a body-only hash', () => {
    expect(terminalValidateCatalog(catalog(), identity).opening.body).toBe(
      E4_TERMINAL_OLD_BODY_MD5,
    );
    expect(() => terminalValidateCatalog([], identity)).toThrow();
    expect(() => terminalValidateCatalog([catalog()[0]], identity)).toThrow();
    expect(() => terminalValidateCatalog([...catalog(), catalog()[0]], identity)).toThrow();
  });
  it.each([
    ['scope', 'public'],
    ['schema', 'public'],
    ['pid', 18],
    ['body', 'missing'],
    ['bytes', 4043],
    ['ownerMatches', false],
    ['owner', 2],
    ['acl', []],
    ['language', 'plpgsql'],
    ['volatility', 'v'],
    ['strict', true],
    ['invoker', false],
    ['parallel', 's'],
    ['cost', 99],
    ['rows', 999],
    ['config', ['search_path=public, pg_catalog']],
    ['args', 'text'],
    ['result', 'jsonb'],
    ['defaults', 1],
    ['defaultExpression', 'null'],
    ['temporary', false],
  ])('refuses forged or missing %s catalog evidence', (key, value) => {
    const rows = catalog();
    Reflect.set(rows[1], String(key), value);
    expect(() => terminalValidateCatalog(rows, identity)).toThrow();
    const missing = catalog();
    Reflect.deleteProperty(missing[1], String(key));
    expect(() => terminalValidateCatalog(missing, identity)).toThrow();
  });
  it.each([
    { db: 'postgres' },
    { pid: 0 },
    { pid: 18 },
    { session: 'other' },
    { principal: 'other' },
  ])('refuses scope/PID/principal mismatch (%#)', (change) => {
    expect(() => terminalAssertIdentity({ ...identity, ...change }, identity)).toThrow();
  });
  it.each([0, -1, 30_001, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'does not extend or guess the native request ceiling (%#)',
    (ms) => {
      expect(() => terminalRequestBudget(ms)).toThrow();
    },
  );
  it('uses the paid remaining deadline and refuses the exact expiry boundary', () => {
    expect(terminalRemaining(31_000, 1000)).toBe(30_000);
    expect(terminalRemaining(1010.9, 1000)).toBe(10);
    expect(() => terminalRemaining(1000, 1000)).toThrow();
    expect(() => terminalRemaining(1000, 1001)).toThrow();
  });
  it('does not send even a SET or DDL after the deadline', async () => {
    const client = new S13ReadClient(S13_LOCAL_DB);
    const query = jest.spyOn(client, 'query');
    await expect(
      terminalBoundedQuery(client, performance.now() - 1, terminalTemporaryDefinition()),
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
  it('keeps fifteen seconds as a cap and clips it to the real remaining pair window', async () => {
    const client = new S13ReadClient(S13_LOCAL_DB);
    const query = jest.spyOn(client, 'query').mockResolvedValue({ rows: [] });
    await terminalBoundedQuery(client, performance.now() + 1000, 'ROLLBACK');
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toMatch(/^SET statement_timeout='[0-9]{1,4}ms'$/u);
    for (const call of query.mock.calls) expect(call[2]).toBeLessThanOrEqual(1000);
  });
  it('marks an active request expiry UNKNOWN rather than pretending it was canceled', async () => {
    jest.useFakeTimers();
    try {
      const client = new S13ReadClient(S13_LOCAL_DB);
      const write = jest.fn();
      Reflect.set(client, 'child', { stdin: { writable: true, write }, exitCode: null });
      const request = client.query('ROLLBACK', [], 7);
      const rejection = expect(request).rejects.toThrow('terminal unknown');
      jest.advanceTimersByTime(7);
      await rejection;
      expect(write).toHaveBeenCalledTimes(1);
      expect(client.terminalState()).toEqual({ pending: false, closed: true });
      await expect(client.query('ROLLBACK')).rejects.toThrow('pending/closed');
    } finally {
      jest.useRealTimers();
    }
  });
  it('does not turn a pending request, unproved rollback, residue or unknown close into cleanup success', () => {
    const known = { pending: 0, idle: true, cleaned: true, closed: true };
    expect(terminalCleanupKnown(known)).toBe(true);
    for (const change of [{ pending: 1 }, { idle: false }, { cleaned: false }, { closed: false }])
      expect(terminalCleanupKnown({ ...known, ...change })).toBe(false);
  });
  it('refuses normal close while a real request is pending', async () => {
    const client = new S13ReadClient(S13_LOCAL_DB);
    Reflect.set(client, 'child', { stdin: { writable: true }, exitCode: null });
    Reflect.set(client, 'pending', {});
    await expect(client.end()).rejects.toThrow('pending backend');
  });
  const producerTree = (kind: 'old' | 'candidate') => [
    {
      Plan: {
        'Node Type': 'Function Scan',
        'Function Name':
          kind === 'old' ? 'e4_expected_evaluations_1234_opening' : 'e4_expected_evaluations',
        Schema: kind === 'old' ? 'pg_temp' : 'public',
        'Actual Rows': 8000,
        'Actual Loops': 1,
      },
    },
  ];
  const producerCatalog = () => terminalValidateCatalog(catalog(), identity);
  it.each(['old', 'candidate'] as const)(
    'requires the exact PG16 display label and complete actual identity/catalog for %s',
    (kind) => {
      expect(() =>
        terminalPlanProvenance(producerTree(kind), kind, producerCatalog(), identity),
      ).not.toThrow();
    },
  );
  it.each([
    ['old', 'pg_temp_7'],
    ['old', 'pg_temp_77'],
    ['old', 'pg_temp_fake'],
    ['old', 'public'],
    ['candidate', 'pg_temp'],
    ['candidate', 'pg_temp_7'],
    ['candidate', 'another'],
  ] as const)(
    'refuses the wrong plan namespace %s / %s rather than normalizing it',
    (kind, schema) => {
      const tree = producerTree(kind);
      tree[0].Plan.Schema = schema;
      expect(() => terminalPlanProvenance(tree, kind, producerCatalog(), identity)).toThrow();
    },
  );
  it.each(['old', 'candidate'] as const)('refuses wrong or dual actual producer for %s', (kind) => {
    const other = kind === 'old' ? 'candidate' : 'old';
    expect(() =>
      terminalPlanProvenance(producerTree(other), kind, producerCatalog(), identity),
    ).toThrow();
    const duplicate = producerTree(kind);
    Reflect.set(
      duplicate[0].Plan,
      'Plans',
      producerTree(other).map((row) => row.Plan),
    );
    expect(() => terminalPlanProvenance(duplicate, kind, producerCatalog(), identity)).toThrow();
  });
  it.each(['Node Type', 'Schema', 'Function Name', 'Actual Rows', 'Actual Loops'])(
    'rejects a missing real producer %s field on each side',
    (key) => {
      for (const kind of ['old', 'candidate'] as const) {
        const tree = producerTree(kind);
        Reflect.deleteProperty(tree[0].Plan, key);
        expect(() => terminalPlanProvenance(tree, kind, producerCatalog(), identity)).toThrow();
      }
    },
  );
  it.each([
    ['Node Type', 'Seq Scan'],
    ['Function Name', 'another'],
    ['Actual Rows', 0],
    ['Actual Rows', 7999],
    ['Actual Loops', 0],
    ['Actual Loops', 2],
  ])('rejects wrong real producer %s=%s on each side', (key, value) => {
    for (const kind of ['old', 'candidate'] as const) {
      const tree = producerTree(kind);
      Reflect.set(tree[0].Plan, String(key), value);
      expect(() => terminalPlanProvenance(tree, kind, producerCatalog(), identity)).toThrow();
    }
  });
  it('refuses an absent actual identity before mapping the plan display', () => {
    expect(() =>
      terminalPlanProvenance(producerTree('old'), 'old', producerCatalog(), undefined),
    ).toThrow();
  });
  it.each(['db', 'pid', 'session', 'principal'])(
    'refuses a missing %s identity at the provenance gate',
    (key) => {
      const actual = { ...identity };
      Reflect.deleteProperty(actual, key);
      expect(() =>
        terminalPlanProvenance(producerTree('old'), 'old', producerCatalog(), actual),
      ).toThrow();
    },
  );
  it.each([
    { db: 'postgres' },
    { pid: 18 },
    { session: 'other' },
    { principal: 'other' },
    { session: '', principal: '' },
  ])('refuses wrong identity at the provenance gate (%#)', (change) => {
    expect(() =>
      terminalPlanProvenance(producerTree('old'), 'old', producerCatalog(), {
        ...identity,
        ...change,
      }),
    ).toThrow();
  });
  it('refuses an absent complete catalog before mapping the plan display', () => {
    expect(() => terminalPlanProvenance(producerTree('old'), 'old', undefined, identity)).toThrow();
  });
  it.each(['current', 'opening'])('refuses missing %s catalog at the provenance gate', (key) => {
    const proof = producerCatalog();
    Reflect.deleteProperty(proof, key);
    expect(() => terminalPlanProvenance(producerTree('old'), 'old', proof, identity)).toThrow();
  });
  it.each([
    ['schema', 'pg_temp'],
    ['schema', 'pg_temp_fake'],
    ['schema', 'pg_temp_7_other'],
    ['pid', 18],
    ['body', 'missing'],
    ['owner', 2],
    ['ownerMatches', false],
    ['acl', []],
    ['temporary', false],
  ])('revalidates complete catalog %s at the provenance gate', (key, value) => {
    const proof = producerCatalog();
    Reflect.set(proof.opening, String(key), value);
    expect(() => terminalPlanProvenance(producerTree('old'), 'old', proof, identity)).toThrow();
  });
});
// E4_TERMINAL_REFS_BODY_OFFLINE_BEGIN
describe('E4 terminal source projection offline', () => {
  it('restores both complete current test openings and the unchanged native driver', () => {
    for (const kind of ['migration', 'scale'] as const) {
      const source = readFileSync(
        resolve(__dirname, 'activity-os-r5-e4-contribution-settlement-' + kind + '.e2e-spec.ts'),
        'utf8',
      );
      const opening =
        kind === 'scale'
          ? restoreE4MaximumStageOpening(source)
          : restoreE4HistoricalCatalogOpening(source);
      expect(terminalRefsTestOpening(opening, kind)).not.toBe(opening);
      expect(() => terminalRefsTestOpening(source + '\n', kind)).toThrow();
      const driver = [...source.matchAll(/^class S13ReadClient \{[\s\S]*?^\}/gmu)];
      expect(driver).toHaveLength(1);
      expect(terminalHash(driver[0][0])).toBe(
        '3de18b91ead77dbdf7f843b2d287c69ec54ce290d863b4c5fcf72f31ada508e7',
      );
    }
  });
  it('projects the D2 and N1 anchors and restores all complete SQL inputs', () => {
    const candidate = terminalActualSource();
    const refs = terminalN1Restore(candidate);
    const source = terminalRefsRestore(refs);
    expect(candidate).not.toBe(refs);
    expect(refs).not.toBe(source);
    expect(terminalN1Projection(refs)).toBe(candidate);
    expect(terminalRefsProjection(source)).toBe(refs);
    expect(terminalHash(terminalOpeningBaseMigrationSource(source))).toBe(E4_TERMINAL_OPENING_SHA);
    expect(E4_REFS_ANCHORS).toHaveLength(3);
    for (const [before, after] of E4_REFS_ANCHORS) {
      expect(source.split(before)).toHaveLength(2);
      expect(refs.split(after)).toHaveLength(2);
    }
    expect(E4_N1_ANCHORS).toHaveLength(3);
    for (const [before, after] of E4_N1_ANCHORS) {
      expect(refs.split(before)).toHaveLength(2);
      expect(candidate.split(after)).toHaveLength(2);
    }
  });
  it.each(['missing', 'duplicate', 'adjacent', 'outside', 'unknown'] as const)(
    'refuses %s source instead of weakening the frozen migration pin',
    (variant) => {
      const candidate = terminalActualSource();
      const refs = terminalN1Restore(candidate);
      const source = terminalRefsRestore(refs);
      const anchor = E4_N1_ANCHORS[0][1];
      const changed =
        variant === 'missing'
          ? candidate.replace(anchor, '')
          : variant === 'duplicate'
            ? candidate + anchor
            : variant === 'adjacent'
              ? candidate.replace('FROM canonical_documents', 'FROM canonical_documents ')
              : variant === 'outside'
                ? candidate + '\n'
                : source;
      expect(changed).not.toBe(candidate);
      expect(() => terminalN1Restore(changed)).toThrow();
    },
  );
  it('keeps source grouping, canonical hash and CTE choices while narrowing selected', () => {
    const candidate = terminalActualSource();
    const refs = terminalN1Restore(candidate);
    const source = terminalRefsRestore(refs);
    const { selected, docs } = terminalN1Structure(
      terminalExpectedDefinition(candidate).definition,
    );
    expect(selected).toContain('g.refs_canonical,resolved.result,');
    expect(selected.match(/\bg\.refs\b/gu)).toHaveLength(1);
    expect(selected.match(/\be4_day_points\(/gu)).toHaveLength(1);
    expect(docs).toContain("'beijingDayPointsJson',day_points");
    expect(docs).not.toContain('e4_day_points(');
    expect(candidate).toContain('jsonb_agg(source_ref ORDER BY source_canonical COLLATE "C")');
    expect(candidate).toContain(
      "string_agg(coalesce(source_canonical,'null'),',' ORDER BY source_canonical COLLATE \"C\")",
    );
    expect(candidate).toContain("UNION ALL SELECT 'sourceRefsJson',refs_canonical");
    expect(candidate).toContain("'sourceRefsJson',refs_canonical::JSONB,");
    expect(candidate.match(/AS (?:NOT )?MATERIALIZED \(/gu)).toEqual(
      source.match(/AS (?:NOT )?MATERIALIZED \(/gu),
    );
    const definition = terminalExpectedDefinition(candidate).definition;
    const refsDefinition = terminalExpectedDefinition(refs).definition;
    expect(candidate.replace(definition, () => refsDefinition)).toBe(refs);
    expect(terminalRefsRestore(refs)).toBe(source);
  });
});
describe('E4 terminal body diagnostic offline', () => {
  const frame = () => [
    {
      Plan: {
        'Node Type': 'Result',
        'Actual Rows': 8000,
        'Actual Loops': 1,
        'Plan Width': 64,
        'Temp Read Blocks': 20,
        'Temp Written Blocks': 20,
        Output: ['private material must never leave this object'],
        Plans: [
          {
            'Node Type': 'Result',
            'Subplan Name': 'CTE documents',
            'Actual Rows': 8000,
            'Actual Loops': 1,
            'Plan Width': 160,
            'Temp Read Blocks': 0,
            'Temp Written Blocks': 10,
          },
          {
            'Node Type': 'CTE Scan',
            'CTE Name': 'documents',
            'Actual Rows': 8000,
            'Actual Loops': 1,
            'Plan Width': 160,
            'Temp Read Blocks': 10,
            'Temp Written Blocks': 0,
            Filter: 'synthetic-private-id',
            Alias: 'synthetic-private-id',
          },
        ],
      },
    },
  ];
  const rootDocumentsConsumerFrame = () => {
    const value = frame();
    const root = value[0].Plan;
    root['Node Type'] = 'CTE Scan';
    Reflect.set(root, 'CTE Name', 'documents');
    root.Plans = [root.Plans[0]];
    return value;
  };
  const rootConsumerError = (value: ReturnType<typeof frame>) => {
    let thrown: unknown;
    try {
      terminalBodyPlan(value, terminalBodyBinding(terminalActualSource()), true);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) throw new Error('fixed root-consumer rejection unavailable');
    return thrown;
  };
  const rootConsumerRejection = (value: ReturnType<typeof frame>) => {
    const thrown = rootConsumerError(value);
    expect(thrown).toBeInstanceOf(TerminalBodyEligibilityError);
    if (!(thrown instanceof TerminalBodyEligibilityError))
      throw new Error('fixed root-consumer eligibility diagnostic unavailable');
    return thrown.diagnostic;
  };
  it('binds exactly two unquoted complete-body parameters and reverses every byte', () => {
    const source = terminalActualSource();
    const input = terminalBodyBinding(source);
    expect(input.body.split('$1::text')).toHaveLength(3);
    expect(input.body.replaceAll('$1::text', 'revision_id')).toBe(
      terminalExpectedDefinition(source).body,
    );
    expect(input.body).toContain('WHERE id=$1::text');
    expect(input.body).toContain('e4_source_rows($1::text)');
    expect(input.sourceSha).toBe(E4_TERMINAL_ACTUAL_SHA);
    expect(terminalBodyNull(input.body).replaceAll('NULL::text', '$1::text')).toBe(input.body);
  });
  it('skips quoted, escaped, dollar-quoted and nested-comment parameter lookalikes', () => {
    const prefix =
      "'revision_id''revision_id' \"revision_id\" $$revision_id$$ " +
      '$tag$revision_id$tag$ /* revision_id /* revision_id */ */ -- revision_id\n';
    expect(terminalBodyParameterPositions(prefix + 'revision_id')).toEqual([prefix.length]);
    expect(terminalBodyParameterPositions('xrevision_id revision_id2')).toEqual([]);
  });
  it.each(["'revision_id", '"revision_id', '/* revision_id', '$$revision_id'])(
    'refuses an unclosed SQL lexical region (%#)',
    (body) => {
      expect(() => terminalBodyParameterPositions(body)).toThrow();
    },
  );
  it.each(['missing', 'extra', 'changed', 'outside'] as const)(
    'refuses %s full diagnostic body input',
    (kind) => {
      const source = terminalActualSource();
      const changed =
        kind === 'missing'
          ? source.replace('WHERE id=revision_id', 'WHERE id=NULL')
          : kind === 'extra'
            ? source.replace('WHERE id=revision_id', 'WHERE id=revision_id OR id=revision_id')
            : kind === 'changed'
              ? source.replace('e4_source_rows(revision_id)', 'e4_source_rows(NULL)')
              : source + '\n';
      expect(() => terminalBodyBinding(changed)).toThrow();
    },
  );
  it('projects only safe numeric stage fields from the complete private plan', () => {
    const input = terminalBodyBinding(terminalActualSource());
    const privateFrame = frame();
    const publicFrame = terminalBodyPlan(privateFrame, input, true);
    expect(publicFrame.eligibility).toBe(true);
    expect(publicFrame.nodes).toHaveLength(3);
    expect(publicFrame.nodes.map((node) => node.role)).toEqual(['root', 'producer', 'consumer']);
    expect(JSON.stringify(publicFrame)).not.toMatch(
      /private|Filter|Output|Alias|Function Name|Schema/u,
    );
    expect(privateFrame[0].Plan.Output).toEqual(['private material must never leave this object']);
  });
  it('accepts one exact root documents CTE Scan without a subplan as the consumer', () => {
    const projection = terminalBodyPlan(
      rootDocumentsConsumerFrame(),
      terminalBodyBinding(terminalActualSource()),
      true,
    );
    expect(projection.bodyEligibility).toMatchObject({
      producerMatches: 1,
      consumerMatches: 1,
      checks: { eligible: true },
      rejected: [],
    });
    expect(projection.nodes.map((node) => node.role)).toEqual(['root', 'producer']);
    expect(projection.bodyRecognition.nodes[0]).toMatchObject({
      nodeType: 'CTE Scan',
      role: 'root',
      ctePresent: true,
      cteTargetExact: true,
      cteTargetPrefix: true,
      subplanPresent: false,
    });
  });
  it('rejects a root documents-prefix CTE Scan', () => {
    const value = rootDocumentsConsumerFrame();
    Reflect.set(value[0].Plan, 'CTE Name', 'documents_shadow');
    expect(rootConsumerError(value)).toMatchObject({
      message: 'Body diagnostic real full coverage differs',
    });
  });
  it('rejects a root documents CTE Scan with a subplan', () => {
    const value = rootDocumentsConsumerFrame();
    Reflect.set(value[0].Plan, 'Subplan Name', 'CTE documents');
    expect(rootConsumerRejection(value)).toMatchObject({
      producerMatches: 1,
      consumerMatches: 0,
      rejected: ['CONSUMER_MATCH_COUNT', 'CONSUMER_ROWS', 'CONSUMER_LOOPS'],
    });
  });
  it('rejects a non-CTE-Scan root even when its CTE target is exact', () => {
    const value = rootDocumentsConsumerFrame();
    value[0].Plan['Node Type'] = 'Result';
    expect(rootConsumerRejection(value)).toMatchObject({
      producerMatches: 1,
      consumerMatches: 0,
      rejected: ['CONSUMER_MATCH_COUNT', 'CONSUMER_ROWS', 'CONSUMER_LOOPS'],
    });
  });
  it('rejects an exact root consumer plus an ordinary exact consumer as a duplicate', () => {
    const value = rootDocumentsConsumerFrame();
    value[0].Plan.Plans.push(frame()[0].Plan.Plans[1]);
    expect(rootConsumerRejection(value)).toMatchObject({
      producerMatches: 1,
      consumerMatches: 2,
      rejected: ['CONSUMER_MATCH_COUNT', 'CONSUMER_ROWS', 'CONSUMER_LOOPS'],
    });
  });
  it.each([
    {
      name: '8000-row proof',
      mutate: (value: ReturnType<typeof frame>) => (value[0].Plan['Actual Rows'] = 7999),
      expected: { kind: 'coverage' },
    },
    {
      name: 'single-loop proof',
      mutate: (value: ReturnType<typeof frame>) => (value[0].Plan['Actual Loops'] = 2),
      expected: { kind: 'coverage' },
    },
    {
      name: 'temporary-write proof',
      mutate: (value: ReturnType<typeof frame>) => {
        value[0].Plan['Temp Written Blocks'] = 0;
        value[0].Plan.Plans[0]['Temp Written Blocks'] = 0;
      },
      expected: { kind: 'eligibility', rejected: ['TEMP_WRITTEN'] },
    },
  ] as const)('retains the root consumer $name rejection', ({ mutate, expected }) => {
    const value = rootDocumentsConsumerFrame();
    mutate(value);
    if (expected.kind === 'coverage') {
      expect(rootConsumerError(value)).toMatchObject({
        message: 'Body diagnostic real full coverage differs',
      });
      return;
    }
    expect(rootConsumerRejection(value)).toMatchObject({
      producerMatches: 1,
      consumerMatches: 1,
      rejected: expected.rejected,
    });
  });
  it('retains the existing exact non-root documents CTE Scan consumer', () => {
    const projection = terminalBodyPlan(frame(), terminalBodyBinding(terminalActualSource()), true);
    expect(projection.bodyEligibility.checks.eligible).toBe(true);
    expect(projection.bodyRecognition.nodes[2]).toMatchObject({
      nodeType: 'CTE Scan',
      role: 'consumer',
      cteTargetExact: true,
      subplanPresent: false,
    });
  });
  it.each([
    'Node Type',
    'Actual Rows',
    'Actual Loops',
    'Plan Width',
    'Temp Read Blocks',
    'Temp Written Blocks',
  ])('refuses missing %s instead of reporting a tidy zero', (key) => {
    const value = frame();
    Reflect.deleteProperty(value[0].Plan, key);
    expect(() =>
      terminalBodyPlan(value, terminalBodyBinding(terminalActualSource()), true),
    ).toThrow();
  });
  it.each([
    'fewer',
    'loops',
    'zero-temp',
    'missing-producer',
    'missing-consumer',
    'duplicate',
    'unknown-stage',
  ] as const)('refuses %s documents eligibility', (variant) => {
    const value = frame();
    if (variant === 'fewer') value[0].Plan.Plans[1]['Actual Rows'] = 7999;
    if (variant === 'loops') value[0].Plan.Plans[1]['Actual Loops'] = 2;
    if (variant === 'zero-temp') value[0].Plan.Plans[0]['Temp Written Blocks'] = 0;
    if (variant === 'missing-producer') value[0].Plan.Plans.shift();
    if (variant === 'missing-consumer') value[0].Plan.Plans.pop();
    if (variant === 'duplicate') value[0].Plan.Plans.push({ ...value[0].Plan.Plans[0] });
    if (variant === 'unknown-stage')
      Reflect.set(value[0].Plan.Plans[0], 'Subplan Name', 'CTE private');
    expect(() =>
      terminalBodyPlan(value, terminalBodyBinding(terminalActualSource()), true),
    ).toThrow();
  });
  it('does not treat the exterior Function Scan totals as documents evidence', () => {
    const value = frame();
    value[0].Plan.Plans = [];
    value[0].Plan['Node Type'] = 'Function Scan';
    expect(() =>
      terminalBodyPlan(value, terminalBodyBinding(terminalActualSource()), true),
    ).toThrow('eligibility missing');
  });
  it('recognizes zero-row NULL calibration but refuses the 8000-row gate', () => {
    const value = frame();
    value[0].Plan['Actual Rows'] = 0;
    value[0].Plan.Plans = [];
    const input = terminalBodyBinding(terminalActualSource());
    expect(terminalBodyPlan(value, input, false).eligibility).toBe(false);
    expect(() => terminalBodyPlan(value, input, true)).toThrow('coverage differs');
  });
  it('rejects unknown body pins even when the numbers look right', () => {
    const input = terminalBodyBinding(terminalActualSource());
    expect(() => terminalBodyPlan(frame(), { ...input, body: input.body + ' ' }, true)).toThrow();
    expect(() => terminalBodyPlan(frame(), { ...input, inputSha: '0'.repeat(64) }, true)).toThrow();
    expect(() =>
      terminalBodyPlan(frame(), { ...input, sourceSha: '0'.repeat(64) }, true),
    ).toThrow();
  });
  it('bounds complete-tree traversal without pruning child evidence', () => {
    const value = frame();
    const leaf = { ...value[0].Plan.Plans[0] };
    Reflect.deleteProperty(leaf, 'Subplan Name');
    value[0].Plan.Plans = Array.from({ length: 256 }, () => ({ ...leaf }));
    expect(() =>
      terminalBodyPlan(value, terminalBodyBinding(terminalActualSource()), true),
    ).toThrow();
  });
  const facts = (): E4RetainedResources => ({
    databases: 1,
    clients: 1,
    ownerBackends: 1,
    leaseLocks: 1,
    leaseOwnerVisible: true,
    observerVisible: true,
    planVisible: true,
    exactScope: true,
    samePrincipal: true,
    sameServer: true,
  });
  it('requires actual observer, owner, plan and lease positive controls', () => {
    expect(() =>
      terminalRetainedResources(facts(), { clients: 1, owner: 1, plan: true }),
    ).not.toThrow();
    expect(() =>
      terminalRetainedResources(
        {
          ...facts(),
          clients: 0,
          ownerBackends: 0,
          leaseLocks: 0,
          leaseOwnerVisible: false,
          planVisible: false,
        },
        { clients: 0, owner: 0, plan: false },
      ),
    ).not.toThrow();
  });
  it.each([
    'databases',
    'clients',
    'ownerBackends',
    'leaseLocks',
    'leaseOwnerVisible',
    'observerVisible',
    'planVisible',
    'exactScope',
    'samePrincipal',
    'sameServer',
  ] as const)('refuses missing or forged %s resource evidence', (key) => {
    const absent = facts();
    Reflect.deleteProperty(absent, key);
    expect(() => terminalRetainedResources(absent, { clients: 1, owner: 1, plan: true })).toThrow();
    const forged = facts();
    Reflect.set(forged, key, typeof forged[key] === 'boolean' ? false : 3);
    expect(() => terminalRetainedResources(forged, { clients: 1, owner: 1, plan: true })).toThrow();
  });
  it('caps cumulative public frames rather than each frame alone', () => {
    const first = 'x'.repeat(16000);
    const bytes = terminalRetainedPublicBytes(0, first);
    expect(bytes).toBe(16002);
    expect(terminalRetainedPublicBytes(bytes, first)).toBe(32004);
    expect(() => terminalRetainedPublicBytes(32004, first)).toThrow();
    expect(() => terminalRetainedPublicBytes(-1, first)).toThrow();
    expect(() => terminalRetainedPublicBytes(Number.NaN, first)).toThrow();
  });
  it('sets a paid 75-second whole diagnostic with the unchanged 30-second request cap', () => {
    expect(terminalRetainedDeadline(10)).toBe(75010);
    expect(terminalRemaining(terminalRetainedDeadline(10), 10)).toBe(30000);
    expect(() => terminalRemaining(75010, 75010)).toThrow();
    expect(() => terminalRetainedDeadline(Number.NaN)).toThrow();
  });
});
// E4_TERMINAL_REFS_BODY_OFFLINE_END

// E4_TERMINAL_OFFLINE_END

// E4_BOOLEAN_COLLECTION_OFFLINE_BEGIN
describe('E4 boolean collection source offline', () => {
  // E4_TERMINAL_REPLACE_HISTORIC_TEST_INPUT_BEGIN
  it('pins the actual complete SQL and proves the whole fixed opening inverse', () => {
    const actual = terminalOpeningMigrationSource(readBooleanScaleActualSource());
    expect(createHash('sha256').update(actual).digest('hex')).toBe(
      '5dba9f0e34a1f8b94023c7ff8f1fcf4c72f164c6fe60e0268a12829632446f6a',
    );
    expect(createHash('sha256').update(booleanScaleHistorySource(actual)).digest('hex')).toBe(
      'abc898ef05148b521e17a0eda68f2b367ac0a88939086afc3948582acc5551cf',
    );
  });
  // E4_TERMINAL_REPLACE_HISTORIC_TEST_INPUT_END
  it.each(['missing', 'duplicate', 'changed', 'adjacent', 'outside'] as const)(
    'refuses %s actual source rather than turning it into a historical baseline',
    (variant) => {
      const actual = readBooleanScaleActualSource();
      const window = readBooleanWindowConstant('E4_COLLECTION_BOOLEAN_WINDOW_SQL');
      const mutation =
        variant === 'missing'
          ? actual.replace(window, '')
          : variant === 'duplicate'
            ? actual + window
            : variant === 'changed'
              ? actual.replace('WHERE p.is_mismatch', 'WHERE NOT p.is_mismatch')
              : variant === 'adjacent'
                ? actual.replace('  -- Unchanged-time evidence', ' -- Unchanged-time evidence')
                : actual + '\n';
      expect(mutation).not.toBe(actual);
      expect(() => booleanScaleHistorySource(mutation)).toThrow();
    },
  );
  it('closes the whole original scale source, including all unchanged assertions', () => {
    const restored = restoreBooleanScaleOpening(readFileSync(__filename, 'utf8'));
    expect(createHash('sha256').update(restored).digest('hex')).toBe(
      '15160a214f3a6bbc3d998061acb39444844463baa7c5e1f2a395a94c9d6337a1',
    );
  });
  it.each(['missing', 'duplicate', 'outside', 'binding'] as const)(
    'refuses %s scale source instead of deleting an old byte proof',
    (variant) => {
      const source = readFileSync(__filename, 'utf8');
      const mutation =
        variant === 'missing'
          ? source.replace('// E4_BOOLEAN_COLLECTION_HELPER_BEGIN\n', '')
          : variant === 'duplicate'
            ? source + '// E4_BOOLEAN_COLLECTION_HELPER_BEGIN\n'
            : variant === 'outside'
              ? source + '\n'
              : (() => {
                  const start = source.indexOf('\nasync function runS13IndependentProbe() {');
                  expect(start).toBeGreaterThan(0);
                  return (
                    source.slice(0, start) +
                    source
                      .slice(start)
                      .replace(
                        '? compactBooleanCollectionPlan(result.rows[0]',
                        '? compactPSetPlan(result.rows[0]',
                      )
                  );
                })();
      expect(mutation).not.toBe(source);
      expect(() => restoreBooleanScaleOpening(mutation)).toThrow();
    },
  );
  it('binds exactly three actual root parameters while retaining both fixed old inputs', () => {
    for (const queries of [fixedPSetQueries(), s13FixedOpeningQueries()]) {
      expect(queries.candidate).toContain('WITH expected AS NOT MATERIALIZED');
      expect(queries.candidate).toContain('WHERE p.is_mismatch');
      expect(queries.candidate.split('$1::text')).toHaveLength(4);
      expect(queries.candidate).not.toContain('root.id');
      expect(queries.candidate).not.toContain('AS expected_evaluation');
      expect(queries.old).toContain('WITH expected AS MATERIALIZED');
      expect(queries.old).not.toContain('is_mismatch');
    }
  });
});

type BooleanPlanNode = Record<string, unknown> & { Plans?: BooleanPlanNode[] };
type BooleanPlanEnvelope = { 'Execution Time': number; Plan: BooleanPlanNode }[];
function booleanPlanNode(
  rows: number,
  loops = 1,
  extra: Record<string, unknown> = {},
): BooleanPlanNode {
  return {
    'Node Type': 'Result',
    'Actual Rows': rows,
    'Actual Loops': loops,
    'Plan Width': 16,
    ...extra,
  };
}
function booleanPlanCalibration(): BooleanPlanEnvelope {
  return [
    {
      'Execution Time': 1,
      Plan: booleanPlanNode(0, 1, {
        'Temp Read Blocks': 10,
        'Temp Written Blocks': 20,
        Plans: [
          booleanPlanNode(8000, 1, {
            'Subplan Name': 'CTE actual',
            Plans: [
              booleanPlanNode(8000, 1, {
                'Relation Name': 'ParticipantContributionEvaluation',
              }),
            ],
          }),
          booleanPlanNode(8000, 1, {
            'Subplan Name': 'CTE pairs',
            Plans: [
              booleanPlanNode(8000, 1, {
                'Node Type': 'Function Scan',
                'Function Name': 'e4_expected_evaluations',
              }),
              booleanPlanNode(8000, 1, {
                'Node Type': 'Index Scan',
                'Relation Name': 'ParticipantContributionEvaluation',
              }),
            ],
          }),
        ],
      }),
    },
  ];
}
function booleanCalibrationParts(value: BooleanPlanEnvelope) {
  const root = value[0].Plan;
  const actual = root.Plans![0];
  const pairs = root.Plans![1];
  return { root, actual, pairs, expected: pairs.Plans![0], full: pairs.Plans![1] };
}
describe('E4 boolean collection plan offline', () => {
  it('measures every real producer from the legal full tree, not estimated rows', () => {
    expect(compactBooleanCollectionPlan(booleanPlanCalibration())).toMatchObject({
      differences: 0,
      expectedRows: 8000,
      actualRows: 8000,
      pairs: 8000,
      fullRows: 8000,
      tempRead: 10,
      tempWritten: 20,
      executionMs: 1,
    });
  });
  it('retains the legal one-row by 8,000-loop full-document backjoin', () => {
    const value = booleanPlanCalibration();
    const { full } = booleanCalibrationParts(value);
    full['Actual Rows'] = 1;
    full['Actual Loops'] = 8000;
    expect(compactBooleanCollectionPlan(value).fullRows).toBe(8000);
  });
  it('still executes the unchanged historical parser calibration', () => {
    expect(() => calibrateS13PlanCoverage()).not.toThrow();
  });
  const mutations: [string, (value: BooleanPlanEnvelope) => void][] = [
    [
      'missing expected function',
      (v) => {
        booleanCalibrationParts(v).pairs.Plans!.shift();
      },
    ],
    [
      'wrong function name',
      (v) => {
        booleanCalibrationParts(v).expected['Function Name'] = 'wrong';
      },
    ],
    [
      'duplicate expected function',
      (v) => {
        const { pairs, expected } = booleanCalibrationParts(v);
        pairs.Plans!.push({ ...expected });
      },
    ],
    [
      'expected producer in the wrong subtree',
      (v) => {
        const { root, pairs } = booleanCalibrationParts(v);
        root.Plans!.push(pairs.Plans!.shift()!);
      },
    ],
    [
      'missing actual CTE',
      (v) => {
        booleanCalibrationParts(v).root.Plans!.shift();
      },
    ],
    [
      'duplicate actual CTE',
      (v) => {
        const { root, actual } = booleanCalibrationParts(v);
        root.Plans!.push({ ...actual });
      },
    ],
    [
      'missing pairs CTE',
      (v) => {
        booleanCalibrationParts(v).root.Plans!.pop();
      },
    ],
    [
      'duplicate pairs CTE',
      (v) => {
        const { root, pairs } = booleanCalibrationParts(v);
        root.Plans!.push({ ...pairs });
      },
    ],
    [
      'short expected bag',
      (v) => {
        booleanCalibrationParts(v).expected['Actual Rows'] = 7999;
      },
    ],
    [
      'repeated expected evaluation',
      (v) => {
        booleanCalibrationParts(v).expected['Actual Loops'] = 2;
      },
    ],
    [
      'short actual bag',
      (v) => {
        booleanCalibrationParts(v).actual['Actual Rows'] = 7999;
      },
    ],
    [
      'repeated actual scan',
      (v) => {
        booleanCalibrationParts(v).actual['Actual Loops'] = 2;
      },
    ],
    [
      'short pairs bag',
      (v) => {
        booleanCalibrationParts(v).pairs['Actual Rows'] = 7999;
      },
    ],
    [
      'repeated pairs materialization',
      (v) => {
        booleanCalibrationParts(v).pairs['Actual Loops'] = 2;
      },
    ],
    [
      'missing full-document backjoin',
      (v) => {
        booleanCalibrationParts(v).pairs.Plans!.pop();
      },
    ],
    [
      'duplicate full-document backjoin',
      (v) => {
        const { pairs, full } = booleanCalibrationParts(v);
        pairs.Plans!.push({ ...full });
      },
    ],
    [
      'short full-document scan',
      (v) => {
        booleanCalibrationParts(v).full['Actual Rows'] = 7999;
      },
    ],
    [
      'backjoin placed outside pairs',
      (v) => {
        const { root, pairs } = booleanCalibrationParts(v);
        root.Plans!.push(pairs.Plans!.pop()!);
      },
    ],
    [
      'missing root loop',
      (v) => {
        Reflect.deleteProperty(v[0].Plan, 'Actual Loops');
      },
    ],
    [
      'missing root rows',
      (v) => {
        Reflect.deleteProperty(v[0].Plan, 'Actual Rows');
      },
    ],
    [
      'nonzero differences',
      (v) => {
        v[0].Plan['Actual Rows'] = 1;
      },
    ],
    [
      'repeated root',
      (v) => {
        v[0].Plan['Actual Loops'] = 2;
      },
    ],
    [
      'missing root temporary reads',
      (v) => {
        Reflect.deleteProperty(v[0].Plan, 'Temp Read Blocks');
      },
    ],
    [
      'missing root temporary writes',
      (v) => {
        Reflect.deleteProperty(v[0].Plan, 'Temp Written Blocks');
      },
    ],
    [
      'NaN rows',
      (v) => {
        booleanCalibrationParts(v).expected['Actual Rows'] = Number.NaN;
      },
    ],
    [
      'negative rows',
      (v) => {
        booleanCalibrationParts(v).expected['Actual Rows'] = -1;
      },
    ],
    [
      'fractional rows',
      (v) => {
        booleanCalibrationParts(v).expected['Actual Rows'] = 8000.5;
      },
    ],
    [
      'infinite duration',
      (v) => {
        v[0]['Execution Time'] = Number.POSITIVE_INFINITY;
      },
    ],
    [
      'negative temporary writes',
      (v) => {
        v[0].Plan['Temp Written Blocks'] = -1;
      },
    ],
    [
      'fractional loop',
      (v) => {
        booleanCalibrationParts(v).full['Actual Loops'] = 1.5;
      },
    ],
    [
      'truncated children',
      (v) => {
        Reflect.set(booleanCalibrationParts(v).pairs, 'Plans', {});
      },
    ],
    [
      'null child',
      (v) => {
        Reflect.set(booleanCalibrationParts(v).pairs, 'Plans', [null]);
      },
    ],
    [
      'invalid node type',
      (v) => {
        booleanCalibrationParts(v).expected['Node Type'] = 'bad\nname';
      },
    ],
    [
      'more than 256 nodes',
      (v) => {
        v[0].Plan.Plans!.push(...Array.from({ length: 257 }, () => booleanPlanNode(0)));
      },
    ],
    [
      'over 32 KiB sanitized report',
      (v) => {
        v[0].Plan.Plans!.push(
          ...Array.from({ length: 240 }, () =>
            booleanPlanNode(0, 1, {
              'Node Type': 'A'.repeat(40),
              'Plan Width': Number.MAX_SAFE_INTEGER,
              'Temp Read Blocks': Number.MAX_SAFE_INTEGER,
              'Temp Written Blocks': Number.MAX_SAFE_INTEGER,
            }),
          ),
        );
      },
    ],
  ];
  it.each(mutations)('refuses %s without a fake 8,000 or zero default', (_label, mutate) => {
    const value = booleanPlanCalibration();
    mutate(value);
    expect(() => compactBooleanCollectionPlan(value)).toThrow();
  });
  it.each([null, [], [{ Plan: null }], [null], [{}, {}]])(
    'refuses a missing or ambiguous envelope (%#)',
    (value) => {
      expect(() => compactBooleanCollectionPlan(value)).toThrow();
    },
  );
  it('does not leak function names, SQL, filters, relations, IDs or source parameters', () => {
    const value = booleanPlanCalibration();
    const { expected } = booleanCalibrationParts(value);
    expected.Filter = 'synthetic private expression';
    expected.Alias = 'synthetic private identifier';
    const report = JSON.stringify(compactBooleanCollectionPlan(value));
    expect(report).not.toMatch(
      /private|Filter|Alias|Function Name|Relation Name|e4_expected_evaluations/gu,
    );
  });
});
// E4_BOOLEAN_COLLECTION_OFFLINE_END

// E4_S13_FORMAT_SOURCE_OFFLINE_BEGIN
describe('E4 S13 historical format source offline', () => {
  const actualSource = () =>
    booleanScaleHistorySource(
      readFileSync(
        resolve(
          __dirname,
          '../../prisma/migrations/20261003000000_activity_contribution_settlement/migration.sql',
        ),
        'utf8',
      ),
    );
  const fixtureConstant = (
    name: 'E4_COLLECTION_PAIR_WINDOW_SQL' | 'E4_S13_WINDOW_SQL' | 'E4_P_SET_NEW_WINDOW_SQL',
  ) => {
    const fixture = readFileSync(
      resolve(__dirname, 'activity-os-r5-e4-contribution-settlement-migration.e2e-spec.ts'),
      'utf8',
    );
    const matches = [
      ...fixture.matchAll(new RegExp('const ' + name + ' = String.raw`([\\s\\S]*?)`;', 'gu')),
    ];
    expect(matches).toHaveLength(1);
    return matches[0][1];
  };
  const actualWindow = () => {
    const matches = [
      ...actualSource().matchAll(
        / {4}IF EXISTS \(\n {6}WITH expected AS MATERIALIZED \([\s\S]*?CONSTRAINT='e4_evaluation_guard'; END IF;\n/gu,
      ),
    ];
    expect(matches).toHaveLength(1);
    return matches[0][0];
  };
  it('pins the actual SQL independently from the historical opening', () => {
    expect(createHash('sha256').update(actualSource()).digest('hex')).toBe(
      'abc898ef05148b521e17a0eda68f2b367ac0a88939086afc3948582acc5551cf',
    );
    expect(actualWindow()).toBe(fixtureConstant('E4_COLLECTION_PAIR_WINDOW_SQL'));
  });
  it('inverts exactly two prescribed CASE expressions to the complete fixed opening', () => {
    const source = actualSource();
    for (const key of ['startsAt', 'endsAt'] as const)
      expect(source.split(s13FormatCase(key))).toHaveLength(2);
    const opening = restoreS13FormatOpening(source);
    expect(createHash('sha256').update(opening).digest('hex')).toBe(E4_S13_FORMAT_OPENING_SHA);
    expect(opening).not.toContain('pg_catalog.translate(');
    expect(restoreS13FormatOpening(opening)).toBe(opening);
  });
  it('retains the original S13 historical whole-source pin', () => {
    const opening = restoreS13FormatOpening(actualSource());
    const historical = opening.replace(actualWindow(), () => fixtureConstant('E4_S13_WINDOW_SQL'));
    expect(createHash('sha256').update(historical).digest('hex')).toBe(
      '96e4dfae0f00a3321b43d02ace0314442483f535673526a76fa043e03075b4b4',
    );
  });
  it('retains the original P-Set opening whole-source pin', () => {
    const opening = restoreS13FormatOpening(actualSource());
    const historical = opening.replace(actualWindow(), () =>
      fixtureConstant('E4_P_SET_NEW_WINDOW_SQL'),
    );
    expect(createHash('sha256').update(historical).digest('hex')).toBe(
      '3f73112f745247fd5ce4762a1b8e8d3551e4648f48ec47e76eb9b54ad4fd8b02',
    );
  });
  it('rejects a missing prescribed CASE expression', () => {
    const source = actualSource().replace(s13FormatCase('startsAt'), () =>
      s13FormatRegex('startsAt'),
    );
    expect(() => restoreS13FormatOpening(source)).toThrow('inverse count mismatch');
  });
  it('rejects a duplicate prescribed CASE expression', () => {
    const source = actualSource() + '\n' + s13FormatCase('startsAt');
    expect(() => restoreS13FormatOpening(source)).toThrow('inverse count mismatch');
  });
  it('rejects an adjacent change outside the two expressions', () => {
    const source = actualSource().replace(' AS canonical_start', ' AS canonical_start ');
    expect(() => restoreS13FormatOpening(source)).toThrow('inverse full source mismatch');
  });
  it('rejects a change outside the function window', () => {
    expect(() => restoreS13FormatOpening(actualSource() + '\n')).toThrow(
      'inverse full source mismatch',
    );
  });
  it('rejects an unknown historical whole source', () => {
    const opening = restoreS13FormatOpening(actualSource());
    expect(() => restoreS13FormatOpening(opening + '\n')).toThrow('inverse count mismatch');
  });
  it('restores the entire scale opening after removing only the approved additions', () => {
    let source = restoreBooleanScaleOpening(readFileSync(__filename, 'utf8'));
    for (const kind of ['HELPER', 'OFFLINE']) {
      const startMarker = '// E4_S13_FORMAT_SOURCE_' + kind + '_BEGIN\n';
      const endMarker = '// E4_S13_FORMAT_SOURCE_' + kind + '_END\n\n';
      expect(source.split(startMarker)).toHaveLength(2);
      expect(source.split(endMarker)).toHaveLength(2);
      const start = source.indexOf(startMarker);
      const end = source.indexOf(endMarker, start) + endMarker.length;
      source = source.slice(0, start) + source.slice(end);
    }
    const start = source.indexOf('function s13FixedOpeningQueries() {');
    const end = source.indexOf('\nasync function s13ScopedFacts', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    let body = source.slice(start, end);
    expect(body.split('  const actualMigration = readFileSync(')).toHaveLength(2);
    expect(
      body.split('  const migration = restoreS13FormatOpening(actualMigration);\n'),
    ).toHaveLength(2);
    expect(body.split('    ...actualMigration.matchAll(')).toHaveLength(2);
    body = body
      .replace('  const actualMigration = readFileSync(', '  const migration = readFileSync(')
      .replace('  const migration = restoreS13FormatOpening(actualMigration);\n', '')
      .replace('    ...actualMigration.matchAll(', '    ...migration.matchAll(');
    const restored = source.slice(0, start) + body + source.slice(end);
    expect(createHash('sha256').update(restored).digest('hex')).toBe(
      '2244af8da866971c9eb67fd28b645510a089c2640bceed2da5e26a6d0bbbe811',
    );
  });
  it('keeps parameterized old and actual candidate query shapes', () => {
    const queries = s13FixedOpeningQueries();
    expect(queries.old).toContain('WITH expected AS MATERIALIZED');
    expect(queries.candidate).toContain('pairs AS MATERIALIZED');
    expect(queries.old.split('$1::text')).toHaveLength(4);
    expect(queries.candidate.split('$1::text')).toHaveLength(4);
    expect(queries.old).not.toContain('root.id');
    expect(queries.candidate).not.toContain('root.id');
  });
});
// E4_S13_FORMAT_SOURCE_OFFLINE_END

let restoreS13Lifecycle: (() => void) | undefined;
beforeAll(() => {
  if (process.env.SRVF_E4_W98 === '1') restoreS13Lifecycle = observeS13Lifecycle();
});
installE4ValidationDatabase();
afterAll(async () => {
  try {
    if (s13Probe.monitor) {
      const facts = await s13ScopedFacts(s13Probe.monitor);
      console.info('E4_S13_SCOPED_FINAL_RESOURCES', JSON.stringify(facts));
      if (!s13Probe.failed && s13Probe.active)
        expect(facts).toEqual({ databases: 0, clients: 0, ownerBackends: 0, leaseLocks: 0 });
    }
  } finally {
    try {
      await s13Probe.monitor?.end();
    } finally {
      s13Probe.restoreApp?.();
      restoreS13Lifecycle?.();
    }
  }
}, 75_000);
describe('E4 maximum real sources with unchanged transaction and query budgets', () => {
  let f: E4Fixture;
  let firstReviewOracle:
    | {
        db: PrismaClient;
        input: SettlementReviewInput;
        runId: string;
        outcome: 'pending' | 'fulfilled' | 'rejected';
      }
    | undefined;

  // Budget-external, independent connection. Identifiers and request hashes never enter logs.
  async function firstReviewFacts() {
    const oracle = firstReviewOracle;
    if (!oracle) throw new Error('Actual first-review request was not captured');
    const [facts] = await oracle.db.$queryRaw<
      {
        decisions: number;
        exactDecisions: number;
        notifications: number;
        audits: number;
        freshAudits: number;
        runStatus: string;
        versionStatus: string;
      }[]
    >`
      SELECT r."statusCode" AS "runStatus",v."statusCode" AS "versionStatus",
        (SELECT count(*)::int FROM "SettlementReviewAction" a
          WHERE a."settlementVersionId"=v.id AND a."stageCode"='first') AS decisions,
        (SELECT count(*)::int FROM "SettlementReviewAction" a
          WHERE a."settlementVersionId"=v.id AND a."stageCode"='first' AND a."actionCode"='approve'
            AND a."actorUserId"=${f.reviewer.id} AND a."operationKey"=${oracle.input.operationKey}
            AND a."requestHash"=${oracle.input.requestHash}) AS "exactDecisions",
        (SELECT count(*)::int FROM notification_outbox_intents n
          WHERE n."eventKey"=${'settlement-review:' + oracle.input.expectedSettlementVersionId + ':first'}
            AND n."aggregateType"='activity' AND n."aggregateId"=${oracle.input.activityId}) AS notifications,
        (SELECT count(*)::int FROM audit_logs a WHERE a.event='activity.publish'
          AND a."resourceType"='activity' AND a."resourceId"=${oracle.input.activityId}
          AND a."actorUserId"=${f.reviewer.id}
          AND a.context->'extra' @> ${JSON.stringify({
            operation: 'settlement-first-review',
            stageCode: 'first',
            actionCode: 'approve',
            settlementRunId: oracle.runId,
            settlementVersionId: oracle.input.expectedSettlementVersionId,
            operationKey: oracle.input.operationKey,
            requestHash: oracle.input.requestHash,
          })}::jsonb) AS audits,
        (SELECT count(*)::int FROM audit_logs a WHERE a.event='activity.publish'
          AND a."resourceType"='activity' AND a."resourceId"=${oracle.input.activityId}
          AND a."actorUserId"=${f.reviewer.id}
          AND a.context->'extra' @> ${JSON.stringify({
            operation: 'settlement-first-review',
            stageCode: 'first',
            actionCode: 'approve',
            settlementRunId: oracle.runId,
            settlementVersionId: oracle.input.expectedSettlementVersionId,
            operationKey: oracle.input.operationKey,
            requestHash: oracle.input.requestHash,
            replayed: false,
          })}::jsonb) AS "freshAudits"
      FROM "AttendanceSettlementVersion" v JOIN "AttendanceSettlementRun" r
        ON r.id=v."settlementRunId"
      WHERE v.id=${oracle.input.expectedSettlementVersionId} AND r."activityId"=${oracle.input.activityId}
        AND r.id=${oracle.runId}
    `;
    if (!facts) throw new Error('Actual review scope was not found');
    return facts;
  }

  function assertReviewCounts(facts: Awaited<ReturnType<typeof firstReviewFacts>>, count: 0 | 1) {
    expect({
      decisions: facts.decisions,
      exactDecisions: facts.exactDecisions,
      notifications: facts.notifications,
      audits: facts.audits,
      freshAudits: facts.freshAudits,
    }).toEqual({
      decisions: count,
      exactDecisions: count,
      notifications: count,
      audits: count,
      freshAudits: count,
    });
  }
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  beforeAll(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    f = await createE4Fixture();
  }, 120_000);
  afterAll(async () => {
    await closeE13Fixture(f);
    if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
  });
  // Runs after the original app.close(), before the installer's ordinary DROP/lease release.
  // This independent 75-second read-only hook is outside every original business budget.
  afterAll(async () => {
    if (!firstReviewOracle) return;
    try {
      const facts = await firstReviewFacts();
      console.info(
        'E4 first-review after app close',
        JSON.stringify({ outcome: firstReviewOracle.outcome, ...facts }),
      );
      if (firstReviewOracle.outcome === 'pending')
        throw new Error('First-review response terminal is unknown');
      assertReviewCounts(facts, firstReviewOracle.outcome === 'fulfilled' ? 1 : 0);
    } finally {
      await firstReviewOracle.db.$disconnect();
    }
  }, 75_000);

  // This owner-bound diagnostic is explicitly local-only; CI still runs the unchanged original full chain.
  (process.env.SRVF_E4_W98 === '1' ? it : it.skip)(
    'E4 S13 thin-key exact full-doc probe',
    async () => {
      s13Probe.active = true;
      const originalClose: unknown = Reflect.get(f.app, 'close');
      if (typeof originalClose !== 'function') throw new Error('S13 original app close missing');
      const descriptor = Object.getOwnPropertyDescriptor(f.app, 'close');
      Object.defineProperty(f.app, 'close', {
        configurable: true,
        writable: true,
        value: function (this: object, ...args: unknown[]) {
          const promise = Reflect.apply(originalClose, this, args) as Promise<void>;
          void promise.then(
            () => {
              s13Probe.appClosed = true;
            },
            () => {
              s13Probe.failed = true;
            },
          );
          return promise;
        },
      });
      s13Probe.restoreApp = () => {
        if (descriptor) Object.defineProperty(f.app, 'close', descriptor);
        else Reflect.deleteProperty(f.app, 'close');
        expect(Reflect.get(f.app, 'close')).toBe(originalClose);
      };
      // E4_TERMINAL_REPLACE_S13_PRINCIPAL_BEGIN
      terminalS13Principal = await terminalBusinessPrincipal(f.db);
      let observedForClose: ObservedE4Database | undefined;
      // E4_TERMINAL_REPLACE_S13_PRINCIPAL_END
      let restoreEngine: (() => void) | undefined;
      try {
        const source = await createMaximumE4Source(f);
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
        const observed = new ObservedE4Database({ log: [{ emit: 'event', level: 'query' }] });
        const engineObserver = observeEngineTransactions(observed);
        let queries = 0;
        let e4Queries = 0;
        let barrierQueries = 0;
        const timing = { readMs: 0, writeMs: 0, largestMs: 0 };
        observed.$on('query', (event) => {
          if (!/^\s*(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)\b/iu.test(event.query)) queries++;
          if (
            /(?:ActivitySettlementContributionRevision|ParticipantContributionEvaluation|e4_assert_|e4_revision_complete_guard)/u.test(
              event.query,
            )
          )
            e4Queries++;
          if (/^\s*SET CONSTRAINTS public\.astr_parent_complete_guard,/u.test(event.query))
            barrierQueries++;
          if (/^\s*(SELECT|WITH)\b/iu.test(event.query)) timing.readMs += event.duration;
          else timing.writeMs += event.duration;
          timing.largestMs = Math.max(timing.largestMs, event.duration);
        });
        const reset = () => {
          queries = 0;
          e4Queries = 0;
          barrierQueries = 0;
          timing.readMs = 0;
          timing.writeMs = 0;
          timing.largestMs = 0;
          engineObserver.phases.length = 0;
        };
        const contributions = f.app.get(ActivityContributionSettlementService);
        const access = f.app.get(ActivityTimeSettlementAccessService);
        const segments = f.app.get(ParticipationSegmentFacade);
        const reader = new ActivityTimeSettlementQueryService(
          observed,
          access,
          segments,
          f.app.get(ActivityContributionSettlementQueryService),
        );
        const measured = new ActivityTimeSettlementService(
          observed,
          access,
          reader,
          segments,
          f.app.get(ActivityTimeAllocationService),
          f.app.get(SettlementSubmitService),
          f.app.get(ActivityTimeSettlementAuditRecorder),
          f.app.get(ActivityWorkflowGate),
          contributions,
        );

        observedForClose = observed;
        restoreEngine = engineObserver.restore;
        await assertConnectedTestDatabase(observed);
        reset();
        const started = performance.now();
        const prepared = await measured.prepare(
          source.activityId,
          {
            expectedDraftVersion: source.expectation.expectedDraftVersion,
            expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,
            operationKey: f.key('s13_prepare'),
            expectedTimeRevision: 0,
          },
          e4Actor(f.creator, true),
          E4_META,
        );
        const prepareMs = performance.now() - started;
        console.info(
          'E4_S13_FRESH_PREPARE',
          JSON.stringify({
            prepareMs,
            queries,
            e4Queries,
            barrierQueries,
            ...timing,
            enginePhases: engineObserver.phases,
          }),
        );
        expect(prepareMs).toBeLessThan(30_000);
        expect(queries).toBeGreaterThan(0);
        expect(queries).toBeLessThanOrEqual(400);
        expect(e4Queries).toBeLessThanOrEqual(12);
        expect(barrierQueries).toBe(1);
        expect(prepared.bucketCount).toBe(8000);
        expect(prepared.sourceCount).toBe(40000);
        const proof = await f.db.activitySettlementContributionRevision.findFirstOrThrow({
          where: { settlementVersionId: prepared.settlementVersionId },
        });
        expect(proof.evaluationCount).toBe(8000);
        expect(proof.recognizedPointsTotal.toFixed(2)).toBe('1000.00');
        await assertFixedE4Oracle(f.db, proof.id, 8000);
        reset();
        const submitted = await measured.submit(
          source.activityId,
          {
            expectedDraftVersion: source.expectation.expectedDraftVersion,
            expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,
            operationKey: f.key('s13_submit'),
            timeRevisionId: prepared.timeRevisionId,
            expectedBucketContentHash: prepared.bucketContentHash,
          },
          e4Actor(f.creator, true),
          E4_META,
        );
        console.info(
          'E4_S13_FRESH_SUBMIT',
          JSON.stringify({
            queries,
            e4Queries,
            ...timing,
            enginePhases: engineObserver.phases,
          }),
        );
        expect(queries).toBeGreaterThan(0);
        expect(queries).toBeLessThanOrEqual(950);
        expect(e4Queries).toBeLessThanOrEqual(12);
        expect(submitted.kindCode).toBe('submitted');
        const submittedProofs = await f.db.activitySettlementContributionRevision.findMany({
          where: {
            activityId: source.activityId,
            settlementRunId: submitted.settlementRunId,
            settlementVersionId: submitted.settlementVersionId,
            timeRevisionId: submitted.timeRevisionId,
            kindCode: 'submitted',
            sourceKindCode: 'time_revision',
            sourceDraftContributionRevisionId: proof.id,
          },
          take: 2,
        });
        expect(submittedProofs).toHaveLength(1);
        const submittedProof = submittedProofs[0];
        expect(submittedProof.evaluationCount).toBe(8000);
        expect(submittedProof.recognizedPointsTotal.toFixed(2)).toBe('1000.00');
        await assertFixedE4Oracle(f.db, submittedProof.id, 8000);
        s13Probe.rootId = submittedProof.id;
        s13Probe.businessPassed = true;
      } catch (error) {
        s13Probe.failed = true;
        throw error;
      } finally {
        restoreEngine?.();
        if (observedForClose) {
          try {
            await observedForClose.$disconnect();
            s13Probe.measuredClosed = true;
          } catch {
            s13Probe.failed = true;
            s13Probe.expired = true;
          }
        }
      }
    },
    600_000,
  );
  afterAll(async () => {
    if (!s13Probe.active) return;
    if (s13Probe.failed)
      throw new Error('S13 business first red; no plan rerun or cleanup allowed');
    await runS13IndependentProbe();
  }, 75_000);

  it('2,000 identities / 10,000 segments / 50,000 slices yield 8,000 policy units without repeated awards', async () => {
    const stages = createE4MaximumStageReceipt();
    const source = await stages.run('FIXTURE', () => createMaximumE4Source(f));
    stages.enter('FIXTURE_CHECKS');
    expect(
      await f.db.activityParticipationIdentity.count({ where: { activityId: source.activityId } }),
    ).toBe(2000);
    expect(
      await f.db.participantTimeAllocationRevision.count({
        where: { activityId: source.activityId },
      }),
    ).toBe(10000);
    expect(
      await f.db.participantTimeAllocationSlice.count({ where: { activityId: source.activityId } }),
    ).toBe(50000);
    stages.complete('FIXTURE_CHECKS');
    stages.enter('PREPARE_SETUP');
    const observed = new ObservedE4Database({ log: [{ emit: 'event', level: 'query' }] });
    const engineObserver = observeEngineTransactions(observed);
    const engineRequests = new E4EngineRequestWaitDiagnostic(
      Reflect.get(observed, '_engine') as object,
    );
    let queries = 0;
    let e4Queries = 0;
    let barrierQueries = 0;
    const timing = { readMs: 0, writeMs: 0, largestMs: 0 };
    let preparePhaseDiagnostic: E4PreparePhaseDiagnostic | undefined;
    observed.$on('query', (event) => {
      if (!/^\s*(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)\b/iu.test(event.query)) {
        queries++;
        preparePhaseDiagnostic?.query(
          /^\s*(SELECT|WITH)\b/iu.test(event.query) ? 'READ' : 'WRITE',
          event.duration,
        );
      }
      if (
        /(?:ActivitySettlementContributionRevision|ParticipantContributionEvaluation|e4_assert_|e4_revision_complete_guard)/u.test(
          event.query,
        )
      )
        e4Queries++;
      if (/^\s*SET CONSTRAINTS public\.astr_parent_complete_guard,/u.test(event.query))
        barrierQueries++;
      if (/^\s*(SELECT|WITH)\b/iu.test(event.query)) timing.readMs += event.duration;
      else timing.writeMs += event.duration;
      timing.largestMs = Math.max(timing.largestMs, event.duration);
    });
    const reset = () => {
      queries = 0;
      e4Queries = 0;
      barrierQueries = 0;
      timing.readMs = 0;
      timing.writeMs = 0;
      timing.largestMs = 0;
      engineObserver.phases.length = 0;
    };
    const contributions = f.app.get(ActivityContributionSettlementService);
    const access = f.app.get(ActivityTimeSettlementAccessService);
    const segments = f.app.get(ParticipationSegmentFacade);
    const reader = new ActivityTimeSettlementQueryService(
      observed,
      access,
      segments,
      f.app.get(ActivityContributionSettlementQueryService),
    );
    const measured = new ActivityTimeSettlementService(
      observed,
      access,
      reader,
      segments,
      f.app.get(ActivityTimeAllocationService),
      f.app.get(SettlementSubmitService),
      f.app.get(ActivityTimeSettlementAuditRecorder),
      f.app.get(ActivityWorkflowGate),
      contributions,
    );
    try {
      await assertConnectedTestDatabase(observed);
      const prepareCommand = {
        expectedDraftVersion: source.expectation.expectedDraftVersion,
        expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,
        operationKey: f.key('maximum_prepare'),
        expectedTimeRevision: 0,
      };
      const prepareRequestHash = timeSettlementPrepareRequestHash(
        source.activityId,
        f.creator.id,
        prepareCommand,
      );
      reset();
      const started = Date.now();
      // E4_GUARD_FUNCTION_INSTANCE_BEGIN
      const guardFunctionDiagnostic = guardFunctionDiagnosticEnabled()
        ? new E4GuardFunctionDiagnostic(
            contributions,
            resolve(process.cwd(), 'tmp/e4-guard-functions-evidence/functions.json'),
          )
        : undefined;
      // E4_GUARD_FUNCTION_INSTANCE_END
      // E4_GUARD_PLAN_INSTANCE_BEGIN
      const guardPlanDiagnostic = guardPlanDiagnosticEnabled()
        ? new E4GuardPlanDiagnostic(
            contributions,
            resolve(process.cwd(), 'tmp/e4-guard-plan-evidence/guard-plan.json'),
          )
        : undefined;
      // E4_GUARD_PLAN_INSTANCE_END
      let prepared;
      const phaseDiagnostic = new E4PreparePhaseDiagnostic([
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
      preparePhaseDiagnostic = phaseDiagnostic;
      let prepareBusinessFailure: { error: unknown } | undefined;
      try {
        engineRequests.begin();
        phaseDiagnostic.begin();
        stages.complete('PREPARE_SETUP');
        let prepareOutcome: 'OK' | 'FAIL' = 'FAIL';
        try {
          prepared = await stages.run('PREPARE', async () => {
            try {
              const result = await measured.prepare(
                source.activityId,
                prepareCommand,
                e4Actor(f.creator, true),
                E4_META,
              );
              prepareOutcome = 'OK';
              return result;
            } catch (error) {
              prepareBusinessFailure = { error };
              throw error;
            }
          });
          stages.enter('PREPARE_RECEIPT');
        } finally {
          engineRequests.finish();
          engineRequests.restore();
          console.info(
            'E4 maximum engine request waits (fixed counters)',
            JSON.stringify(engineRequests.snapshot()),
          );
          phaseDiagnostic.finish(prepareOutcome);
          phaseDiagnostic.restore();
          // E4_GUARD_FUNCTION_RESTORE_BEGIN
          guardFunctionDiagnostic?.restore();
          await guardFunctionDiagnostic?.collect(observed);
          guardFunctionDiagnostic?.emit();
          // E4_GUARD_FUNCTION_RESTORE_END
          // E4_GUARD_PLAN_RESTORE_BEGIN
          guardPlanDiagnostic?.restore();
          guardPlanDiagnostic?.emit();
          // E4_GUARD_PLAN_RESTORE_END
          preparePhaseDiagnostic = undefined;
          phaseDiagnostic.emitTo((safeJson) =>
            console.info('E4 maximum prepare phases (fixed counters)', safeJson),
          );
        }
      } catch (error) {
        // A receipt failure after COMMIT must not enter business rollback diagnostics.
        if (!prepareBusinessFailure || !Object.is(prepareBusinessFailure.error, error)) throw error;
        const prismaCode =
          error instanceof Prisma.PrismaClientKnownRequestError ? error.code : 'other';
        console.info(
          'E4 maximum prepare failure (fixed redacted counters)',
          JSON.stringify({
            elapsedMs: Date.now() - started,
            queries,
            e4Queries,
            barrierQueries,
            ...timing,
            enginePhases: engineObserver.phases,
            prismaCode: ['P2028', 'P2010', 'P2002', 'P2003'].includes(prismaCode)
              ? prismaCode
              : 'other',
          }),
        );
        // Independent connection, exact original actor/command/hash/version anchors; counters only.
        const [sameCommandFacts] = await f.db.$queryRaw<
          {
            roots: number;
            evaluations: number;
            timeRoots: number;
            buckets: number;
            sources: number;
            receipts: number;
            audits: number;
          }[]
        >`
          WITH roots AS MATERIALIZED (
            SELECT id,"timeRevisionId" FROM "ActivitySettlementContributionRevision"
            WHERE "activityId"=${source.activityId}
              AND "settlementRunId"=${source.generated.settlementRunId}
              AND "settlementVersionId"=${source.generated.settlementVersionId}
              AND "createdByUserId"=${f.creator.id}
              AND "operationKey"=${prepareCommand.operationKey}
              AND "requestHash"=${prepareRequestHash}
          ), time_roots AS MATERIALIZED (
            SELECT id FROM "ActivitySettlementTimeRevision"
            WHERE "activityId"=${source.activityId}
              AND "settlementRunId"=${source.generated.settlementRunId}
              AND "settlementVersionId"=${source.generated.settlementVersionId}
              AND "createdByUserId"=${f.creator.id}
          )
          SELECT (SELECT count(*)::int FROM roots) AS roots,
            (SELECT count(*)::int FROM "ParticipantContributionEvaluation"
              WHERE "contributionRevisionId" IN (SELECT id FROM roots)) AS evaluations,
            (SELECT count(*)::int FROM time_roots) AS "timeRoots",
            (SELECT count(*)::int FROM "ParticipantSettlementTimeBucket"
              WHERE "timeRevisionId" IN (SELECT id FROM time_roots)) AS buckets,
            (SELECT count(*)::int FROM "ParticipantSettlementTimeBucketSource"
              WHERE "timeRevisionId" IN (SELECT id FROM time_roots)) AS sources,
            (SELECT count(*)::int FROM "ActivitySettlementTimeCommandReceipt"
              WHERE "activityId"=${source.activityId} AND "actorUserId"=${f.creator.id}
                AND "operationCode"=${TIME_SETTLEMENT_PREPARE_OPERATION}
                AND "operationKey"=${prepareCommand.operationKey}
                AND "requestHash"=${prepareRequestHash}
                AND "timeRevisionId" IN (SELECT id FROM time_roots)) AS receipts,
            (SELECT count(*)::int FROM audit_logs
              WHERE "actorUserId"=${f.creator.id} AND "resourceId"=${source.activityId}
                AND event='activity.time-settlement.command'
                AND context->'extra'->>'operationCode'=${TIME_SETTLEMENT_PREPARE_OPERATION}
                AND context->'extra'->>'timeRevisionId' IN (SELECT id FROM time_roots)
                AND context->'extra'->>'contributionRevisionId' IN (SELECT id FROM roots)) AS audits
        `;
        console.info(
          'E4 maximum failure exact same-command facts',
          JSON.stringify(sameCommandFacts),
        );
        if (sameCommandFacts.roots === 1) {
          const roots = await f.db.activitySettlementContributionRevision.findMany({
            where: {
              activityId: source.activityId,
              settlementRunId: source.generated.settlementRunId,
              settlementVersionId: source.generated.settlementVersionId,
              createdByUserId: f.creator.id,
              operationKey: prepareCommand.operationKey,
              requestHash: prepareRequestHash,
            },
            select: { id: true, sourceKindCode: true },
            take: 2,
          });
          expect(roots).toHaveLength(1);
          const actualRoot = roots[0];
          const candidate = fixedE4RootAggregateSql(
            actualRoot.id,
            actualRoot.sourceKindCode,
          ).candidate;
          const probes = [
            {
              name: 'actual_complete_false',
              sql: Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT e4_assert_complete(${actualRoot.id},FALSE)`,
            },
            {
              name: 'actual_root_aggregate',
              sql: Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${candidate}`,
            },
          ];
          // At most two plans on this same failed root. READ ONLY and explicit rollback;
          // never reproduce INSERT/COMMIT, create a new root or alter the business budget.
          for (const probe of probes) {
            let plan: unknown;
            const rollback = new Error('E4 authorized read-only plan rollback');
            try {
              await f.db.$transaction(
                async (tx) => {
                  await tx.$executeRaw`SET TRANSACTION READ ONLY`;
                  await tx.$executeRaw`SET LOCAL statement_timeout='30s'`;
                  plan = await tx.$queryRaw(probe.sql);
                  throw rollback;
                },
                { timeout: 35_000 },
              );
            } catch (diagnosticError) {
              if (diagnosticError !== rollback) {
                const code =
                  diagnosticError instanceof Prisma.PrismaClientKnownRequestError
                    ? diagnosticError.code
                    : 'other';
                console.info(
                  'E4 bounded same-root plan not completed',
                  JSON.stringify({
                    name: probe.name,
                    code: ['P2028', 'P2010'].includes(code) ? code : 'other',
                  }),
                );
                continue;
              }
              const rows = Array.isArray(plan) ? plan : [];
              const row = rows[0] as Record<string, unknown> | undefined;
              const documents = row?.['QUERY PLAN'];
              const document = Array.isArray(documents)
                ? (documents[0] as Record<string, unknown> | undefined)
                : undefined;
              const rootPlan = document?.Plan as Record<string, unknown> | undefined;
              // Fixed numeric fields only, not SQL text, parameter values or arbitrary plan strings.
              const numeric = (value: unknown) =>
                typeof value === 'number' && Number.isFinite(value) ? value : null;
              console.info(
                'E4 bounded same-root rollback plan',
                JSON.stringify({
                  name: probe.name,
                  planningMs: numeric(document?.['Planning Time']),
                  executionMs: numeric(document?.['Execution Time']),
                  actualTotalMs: numeric(rootPlan?.['Actual Total Time']),
                  rows: numeric(rootPlan?.['Actual Rows']),
                  loops: numeric(rootPlan?.['Actual Loops']),
                  sharedHit: numeric(rootPlan?.['Shared Hit Blocks']),
                  sharedRead: numeric(rootPlan?.['Shared Read Blocks']),
                  tempRead: numeric(rootPlan?.['Temp Read Blocks']),
                  tempWritten: numeric(rootPlan?.['Temp Written Blocks']),
                }),
              );
            }
          }
        }
        expect(
          await f.db.activitySettlementContributionRevision.count({
            where: { activityId: source.activityId },
          }),
        ).toBe(0);
        expect(
          await f.db.activitySettlementTimeRevision.count({
            where: { activityId: source.activityId },
          }),
        ).toBe(0);
        throw error;
      }
      expect(phaseDiagnostic.snapshot().status).toBe('COMPLETE');
      if (engineRequests.snapshot().status !== 'COMPLETE')
        throw new Error('E4 engine request waits UNKNOWN; stop before next stage');
      const prepareMs = Date.now() - started;
      console.info(
        'E4 maximum prepare',
        JSON.stringify({
          prepareMs,
          queries,
          e4Queries,
          barrierQueries,
          ...timing,
          enginePhases: engineObserver.phases,
        }),
      );
      stages.complete('PREPARE_RECEIPT');
      stages.enter('PREPARE_CHECKS');
      expect(prepareMs).toBeLessThan(30_000);
      expect(queries).toBeGreaterThan(0);
      expect(queries).toBeLessThanOrEqual(400);
      expect(e4Queries).toBeLessThanOrEqual(12);
      expect(barrierQueries).toBe(1);
      expect(prepared.bucketCount).toBe(8000);
      expect(prepared.sourceCount).toBe(40000);
      stages.complete('PREPARE_CHECKS');
      const proof = await stages.run('PROOF_READ', () =>
        f.db.activitySettlementContributionRevision.findFirstOrThrow({
          where: { settlementVersionId: prepared.settlementVersionId },
        }),
      );
      stages.enter('PROOF_CHECKS');
      expect(proof.evaluationCount).toBe(8000);
      expect(proof.recognizedPointsTotal.toFixed(2)).toBe('1000.00');
      // Full old expected documents and the independent abc actual-row root oracle,
      // before any submit/review/ledger stage. These reads are outside the measured command.
      stages.complete('PROOF_CHECKS');
      await stages.run('ORACLE', () => assertFixedE4Oracle(f.db, proof.id, 8000));
      reset();
      const submitted = await stages.run('SUBMIT', () =>
        measured.submit(
          source.activityId,
          {
            expectedDraftVersion: source.expectation.expectedDraftVersion,
            expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,
            operationKey: f.key('maximum_submit'),
            timeRevisionId: prepared.timeRevisionId,
            expectedBucketContentHash: prepared.bucketContentHash,
          },
          e4Actor(f.creator, true),
          E4_META,
        ),
      );
      stages.enter('SUBMIT_CHECKS');
      console.info('E4 maximum submit', JSON.stringify({ queries, e4Queries, ...timing }));
      expect(queries).toBeGreaterThan(0);
      expect(queries).toBeLessThanOrEqual(950);
      expect(e4Queries).toBeLessThanOrEqual(12);
      expect(submitted.kindCode).toBe('submitted');
      const review = f.app.get(SettlementReviewService);
      const originalFirstReview = review.firstReview.bind(review);
      const capture = jest.spyOn(review, 'firstReview').mockImplementation(async function (
        this: SettlementReviewService,
        ...args
      ) {
        const [originalInput] = args;
        // Capture the actual helper-generated key; never call f.key a second time.
        const input = {
          ...originalInput,
          expectedSettlementVersionId: submitted.settlementVersionId,
        };
        const db = new PrismaClient();
        firstReviewOracle = { db, input, runId: submitted.settlementRunId, outcome: 'pending' };
        await assertConnectedTestDatabase(db);
        const before = await firstReviewFacts();
        console.info('E4 first-review before request', JSON.stringify(before));
        assertReviewCounts(before, 0);
        expect(before.runStatus).toBe('pending_first_review');
        const started = performance.now();
        try {
          // Original this/arguments/options; the original service owns its unchanged 15s tx.
          expect(this).toBe(review);
          const result = await originalFirstReview(...args);
          firstReviewOracle.outcome = 'fulfilled';
          console.info(
            'E4 first-review response',
            JSON.stringify({ outcome: 'fulfilled', elapsedMs: performance.now() - started }),
          );
          const after = await firstReviewFacts();
          console.info('E4 first-review after response', JSON.stringify(after));
          assertReviewCounts(after, 1);
          expect(after.runStatus).toBe('pending_final_review');
          expect(after.versionStatus).toBe('submitted');
          return result;
        } catch (error) {
          // Do not convert a failed transaction to success; independently retain its real facts.
          if (firstReviewOracle.outcome !== 'fulfilled') firstReviewOracle.outcome = 'rejected';
          const code = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : 'other';
          console.info(
            'E4 first-review response',
            JSON.stringify({
              outcome: firstReviewOracle.outcome,
              elapsedMs: performance.now() - started,
              code: ['P2028', 'P2010', 'P2004'].includes(code) ? code : 'other',
            }),
          );
          console.info('E4 first-review after response', JSON.stringify(await firstReviewFacts()));
          throw error;
        }
      });
      stages.complete('SUBMIT_CHECKS');
      let posted: Awaited<ReturnType<typeof postE4Ledger>>;
      try {
        posted = await stages.run('LEDGER', () => postE4Ledger(f, submitted));
      } finally {
        capture.mockRestore();
      }
      stages.enter('LEDGER_CHECKS');
      expect(posted.committed.replayed).toBe(false);
      expect(
        await f.db.participationLedgerEntry.count({
          where: { postingBatchId: posted.batchId, entryTypeCode: 'contribution_credit' },
        }),
      ).toBe(2000);
      const total = await f.db.participationLedgerEntry.aggregate({
        where: { postingBatchId: posted.batchId, entryTypeCode: 'contribution_credit' },
        _sum: { recognizedPointsDelta: true },
      });
      expect(total._sum.recognizedPointsDelta?.toFixed(2)).toBe('1000.00');
      reset();
      stages.complete('LEDGER_CHECKS');
      const summary = await stages.run('SUMMARY', () =>
        observed.$transaction((tx) =>
          f.app
            .get(ActivityContributionSettlementQueryService)
            .readSummaryInTx(tx, submitted.settlementVersionId),
        ),
      );
      stages.enter('SUMMARY_CHECKS');
      console.info('E4 maximum formal summary', JSON.stringify({ queries, e4Queries }));
      expect(queries).toBeGreaterThan(0);
      expect(queries).toBeLessThanOrEqual(3);
      expect(summary).toMatchObject({
        evaluationCount: 8000,
        recognizedPointsTotal: '1000.00',
        hasMore: true,
      });
      stages.complete('SUMMARY_CHECKS');
      const formalProof = await stages.run('FORMAL_PROOF_READ', () =>
        f.db.activitySettlementContributionRevision.findFirstOrThrow({
          where: { settlementVersionId: submitted.settlementVersionId },
        }),
      );
      // Outside all measured business operations; compares every complete JSON, not a sample.
      await stages.run('FINAL_ORACLE_DRAFT', () => assertFixedE4Oracle(f.db, proof.id, 8000));
      await stages.run('FINAL_ORACLE_FORMAL', () =>
        assertFixedE4Oracle(f.db, formalProof.id, 8000),
      );
      console.info(
        'E4 maximum independent old/new oracle',
        JSON.stringify({ evaluations: 8000, differences: 0 }),
      );
      // Only after every original business budget and full draft/formal oracle has passed.
      // Reuses this exact immutable root; no extra fixture, prepare, INSERT or pre-business warming.
      await stages.run('POST_BUSINESS_PROBE', () => assertPostBusinessPSetProbe(f.db, proof.id));
    } finally {
      engineRequests.restore();
      engineObserver.restore();
      await stages.cleanup(() => observed.$disconnect());
    }
    stages.assertReliable();
  }, 600_000);
});
