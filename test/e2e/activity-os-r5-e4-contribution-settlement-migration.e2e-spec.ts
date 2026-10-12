import { Prisma, PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
// E4_TERMINAL_REPLACE_CHILD_IMPORT_BEGIN
import { execFileSync, spawn } from 'node:child_process';
// E4_TERMINAL_REPLACE_CHILD_IMPORT_END
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
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
import { ActivityTimeSettlementService } from '../../src/modules/activities/activity-time-settlement.service';
import { ActivityContributionSettlementService } from '../../src/modules/activities/activity-contribution-settlement.service';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import {
  activityContributionPolicySelectionScopeKey,
  activityContributionPolicySelectionHash,
  createActivityContributionPolicySelectionDocument,
  parseActivityContributionPolicySelectionDocument,
  type ActivityContributionPolicySelectionItem,
} from '../../src/modules/activities/activity-contribution-policy-selection';
import { assertConnectedTestDatabase, assertTestDatabaseUrl } from '../setup/test-db';
import { deriveTestDbName } from '../setup/worktree-db';
import { timeLedgerFixtureTriggerSql } from '../setup/time-ledger-fixture-cleanup';
import { fingerprintMetricEnvelope } from '../../src/modules/activities/activity-metric-definition';
import { fingerprintTimePolicyVersion } from '../../src/modules/activities/activity-time-policy-definition';
import { buildActivityTimeAllocationManifest } from '../../src/modules/activities/activity-time-allocation-command';
import {
  activityTimePolicySelectionHash,
  createActivityTimePolicySelectionDocument,
} from '../../src/modules/activities/activity-time-policy-selection';
import {
  computeSettlementContentHash,
  computeTimeSettlementContentHash,
} from '../../src/modules/activities/settlement-content-hash';
import { buildParticipationTimeLedger } from '../../src/modules/activities/participation-time-ledger-policy';
import { hashCanonical } from '../../src/modules/activities/activity-publish-review-idempotency';

// E4_TERMINAL_HELPERS_BEGIN
import { e4NativeMeasurementDatabase } from '../helpers/e4-native-measurement-owner';
import {
  E4NativeMeasurementOwner,
  withE4NativeMeasurementBinding,
  type E4NativeMeasurementLease,
} from '../helpers/e4-native-measurement-owner';
import { E4_D1_SCOPE } from '../helpers/e4-d1-result-capture';
import { ScratchLeaseSession } from '../helpers/scratch-database-lease';
const S13_LOCAL_DB = E4_D1_SCOPE;
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

// E4_TERMINAL_G1_ADAPTER_BEGIN
/** Independent failed-run inner query, before the approved interface/key-list correction. */
const E4_TERMINAL_BAG_OPENING_SQL = String.raw`WITH old AS MATERIALIZED (SELECT * FROM pg_temp.e4_expected_evaluations_1234_opening($1::text)), candidate AS MATERIALIZED (SELECT * FROM public.e4_expected_evaluations($1::text)), difference AS ((SELECT * FROM old EXCEPT ALL SELECT * FROM candidate) UNION ALL (SELECT * FROM candidate EXCEPT ALL SELECT * FROM old)), stored AS MATERIALIZED (SELECT public.e4_evaluation_document(e) AS evaluation FROM public."ParticipantContributionEvaluation" e WHERE e."contributionRevisionId"=$1::text), stored_difference AS ((SELECT evaluation FROM candidate EXCEPT ALL SELECT evaluation FROM stored) UNION ALL (SELECT evaluation FROM stored EXCEPT ALL SELECT evaluation FROM candidate)) SELECT (SELECT count(*)::int FROM old) AS "oldCount", (SELECT count(*)::int FROM candidate) AS "candidateCount",(SELECT count(*)::int FROM stored) AS "storedCount", (SELECT count(*)::int FROM difference) AS differences,(SELECT count(*)::int FROM stored_difference) AS "storedDifferences", (SELECT bool_and((SELECT count(*) FROM jsonb_object_keys(evaluation))=23) FROM candidate) AS "completeFields", (SELECT count(*)::int FROM public.e4_expected_evaluations(NULL::text)) AS "nullRows"`;
const E4_TERMINAL_DOCUMENT_KEYS = [
  'attendanceRoleCode',
  'beijingDayPointsJson',
  'calculatedPoints',
  'definitionHash',
  'durationSeconds',
  'evaluationHash',
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
  'sourceRefsJson',
  'timeCategoryCode',
] as const;
function terminalBagSelect() {
  if (
    terminalHash(E4_TERMINAL_BAG_OPENING_SQL) !==
    '160c370b7c27f0f4ee1efea53c1be723753c5a67652acfe008955b9859d748d6'
  )
    throw new Error('Terminal original bag inner source mismatch');
  const beforeFields =
    '(SELECT bool_and((SELECT count(*) FROM jsonb_object_keys(evaluation))=23) FROM candidate) AS "completeFields"';
  const fields =
    '(SELECT bool_and((SELECT jsonb_agg(field ORDER BY field COLLATE "C") FROM jsonb_object_keys(evaluation) field)=$2::jsonb) FROM candidate) AS "completeFields"';
  const beforeNull =
    '(SELECT count(*)::int FROM public.e4_expected_evaluations(NULL::text)) AS "nullRows"';
  const nulls =
    beforeNull +
    ',(SELECT count(*)::int FROM pg_temp.e4_expected_evaluations_1234_opening(NULL::text)) AS "oldNullRows"';
  for (const part of [beforeFields, beforeNull])
    if (E4_TERMINAL_BAG_OPENING_SQL.split(part).length !== 2)
      throw new Error('Terminal exact new assertion correction ambiguous');
  const inner = E4_TERMINAL_BAG_OPENING_SQL.replace(beforeFields, () => fields).replace(
    beforeNull,
    () => nulls,
  );
  if (
    inner.replace(fields, () => beforeFields).replace(nulls, () => beforeNull) !==
    E4_TERMINAL_BAG_OPENING_SQL
  )
    throw new Error('Terminal bag inner correction full inverse mismatch');
  return 'SELECT * FROM (\n' + inner + '\n) AS e4_terminal_bag';
}
function terminalDocumentKeys(keys: string[]) {
  if (JSON.stringify(keys) !== JSON.stringify(E4_TERMINAL_DOCUMENT_KEYS))
    throw new Error('Terminal exact complete document keys differ');
  return keys;
}
// E4_TERMINAL_G1_ADAPTER_END

const E4_TERMINAL_OPENING_BINDINGS: TerminalOpeningBinding[] = [
  {
    kind: 'HISTORY',
    original:
      "function booleanCollectionHistorySource(source = rawS13MigrationSource()): string {\n  if (createHash('sha256').update(source).digest('hex') !== E4_BOOLEAN_MIGRATION_SHA)\n    throw new Error('E4 boolean collection actual full source mismatch');\n  const restored = restoreBooleanCollectionWindow(source);\n  if (createHash('sha256').update(restored).digest('hex') !== E4_BOOLEAN_OPENING_SHA)\n    throw new Error('E4 boolean collection opening full source mismatch');\n  return restored;\n}",
    candidateHash: 'c4ffa344729bbe7322041ad2bcff33728279d257861bff51a187efaee923bd0d',
  },
  {
    kind: 'HISTORIC_TEST_INPUT',
    original:
      "  it('reads the real complete new migration and restores exactly the opening whole source', () => {\n    const actual = rawS13MigrationSource();\n    expect(createHash('sha256').update(actual).digest('hex')).toBe(E4_BOOLEAN_MIGRATION_SHA);\n    expect(actualBooleanCollectionWindow(actual)).toBe(E4_COLLECTION_BOOLEAN_WINDOW_SQL);\n    expect(createHash('sha256').update(booleanCollectionHistorySource(actual)).digest('hex')).toBe(\n      E4_BOOLEAN_OPENING_SHA,\n    );\n  });",
    candidateHash: '1a8c3647f15f30d82a30f9eaec4f470edc7f8299da448e602ce29c65f0594dbf',
  },
  {
    kind: 'CHILD_IMPORT',
    original: "import { execFileSync } from 'node:child_process';",
    candidateHash: '962648d459b6f1a00237e3b7fa2dd3a9e710cf4fbf8e8e025261bfca0e689327',
  },
  {
    kind: 'N1_INSTALLER_MODE',
    original: '  installE4ValidationDatabase();',
    candidateHash: '00408329d5b2f7a1c38e617121b62486de54f0c3b9e05addbb4d502104e31d4d',
  },
];
function restoreTerminalMigrationOpening(source: string) {
  return restoreTerminalSource(
    source,
    E4_TERMINAL_OPENING_BINDINGS,
    ['HELPERS', 'FROZEN', 'OFFLINE', 'REAL', 'N1_ADMISSION', 'N1_INSTALL_STAGE'],
    '7682abceaaf185b1b54beaffdd1ecddc1fe30745193059cce3da5aeb3518282a',
  );
}
let terminalMigrationFailed = false;
let terminalMigrationPending = 0;
const terminalMigrationLease: { owner?: E4NativeMeasurementLease } = {};
let terminalMigrationNativeOwner: E4NativeMeasurementOwner | undefined;
function terminalMigrationDropAllowed() {
  return (
    !terminalMigrationFailed &&
    terminalMigrationPending === 0 &&
    pDayFailureGate.snapshot().status === 'open'
  );
}
function terminalObserveMigrationLease() {
  const prototype = ScratchLeaseSession.prototype;
  const acquire = Object.getOwnPropertyDescriptor(prototype, 'acquire')!;
  const drop = Object.getOwnPropertyDescriptor(prototype, 'dropDatabase')!;
  if (typeof acquire.value !== 'function' || typeof drop.value !== 'function')
    throw new Error('Terminal original lease methods unavailable');
  const originalAcquire = acquire.value as (
    this: ScratchLeaseSession,
    ...args: unknown[]
  ) => unknown;
  const originalDrop = drop.value as (this: ScratchLeaseSession, ...args: unknown[]) => unknown;
  Object.defineProperty(prototype, 'acquire', {
    ...acquire,
    value: function (this: ScratchLeaseSession, ...args: unknown[]) {
      terminalMigrationLease.owner = this; // Register the real owner before its async acquire.
      return Reflect.apply(originalAcquire, this, args);
    },
  });
  Object.defineProperty(prototype, 'dropDatabase', {
    ...drop,
    value: function (this: ScratchLeaseSession, ...args: unknown[]) {
      if (this !== terminalMigrationLease.owner || !terminalMigrationDropAllowed())
        return Promise.reject(
          new Error('Terminal migration ordinary DROP refused; evidence retained'),
        );
      this.assertHeld();
      return Reflect.apply(originalDrop, this, args);
    },
  });
  return () => {
    Object.defineProperty(prototype, 'acquire', acquire);
    Object.defineProperty(prototype, 'dropDatabase', drop);
    expect(Object.getOwnPropertyDescriptor(prototype, 'acquire')).toEqual(acquire);
    expect(Object.getOwnPropertyDescriptor(prototype, 'dropDatabase')).toEqual(drop);
  };
}
let restoreTerminalMigrationLease: (() => void) | undefined;
beforeAll(() => {
  if (process.env.SRVF_E4_W98 === '1')
    restoreTerminalMigrationLease = terminalObserveMigrationLease();
});
afterAll(() => restoreTerminalMigrationLease?.());
async function withTerminalNative<T>(
  db: PrismaClient,
  work: (
    client: S13ReadClient,
    deadline: number,
    identity: TerminalIdentity,
    catalog: ReturnType<typeof terminalValidateCatalog>,
  ) => Promise<T>,
  expectedFault?: Error,
) {
  const binding = terminalMigrationNativeOwner?.current();
  if (!binding || binding.owner !== terminalMigrationLease.owner)
    throw new Error('Terminal actual original lease owner missing');
  return withE4NativeMeasurementBinding(binding, async () => {
    // The exact runtime binding is validated above; preserve the frozen driver's bytes/type.
    const database = e4NativeMeasurementDatabase(S13_LOCAL_DB);
    const plan = new S13ReadClient(database as typeof S13_LOCAL_DB);
    const monitor = new S13ReadClient('postgres');
    const deadline = performance.now() + 30_000;
    // This single owner, both clients, and pending are registered before async connect/DDL.
    terminalMigrationLease.owner?.assertHeld();
    if (!terminalMigrationLease.owner)
      throw new Error('Terminal actual original lease owner missing');
    terminalMigrationPending++;
    let planOpened = false,
      monitorOpened = false;
    let identity: TerminalIdentity | undefined;
    let catalog: ReturnType<typeof terminalValidateCatalog> | undefined;
    let cleaned = false,
      closed = false;
    let primary: { value: unknown } | undefined;
    let completed: { value: T } | undefined;
    let cleanupFailure = false;
    const cleanTemporary = async () => {
      if (!identity || !catalog) throw new Error('Terminal partial install/catalog UNKNOWN');
      await terminalDropOpening(plan, monitor, deadline, identity, catalog.current);
      cleaned = true;
    };
    try {
      const business = await terminalBusinessPrincipal(db);
      monitorOpened = true;
      await monitor.connect(terminalRemaining(deadline));
      planOpened = true;
      await plan.connect(terminalRemaining(deadline));
      identity = await terminalNativeIdentity(plan, deadline);
      terminalAssertIdentity(identity, business);
      catalog = await terminalInstallOpening(plan, deadline, identity);
      completed = { value: await work(plan, deadline, identity, catalog) };
    } catch (error) {
      primary = { value: error };
      if (error !== expectedFault) terminalMigrationFailed = true;
    } finally {
      try {
        await cleanTemporary();
      } catch {
        terminalMigrationFailed = true;
        cleanupFailure = true;
      }
      for (const [client, opened] of [
        [plan, planOpened],
        [monitor, monitorOpened],
      ] as const) {
        if (!opened) continue;
        try {
          await client.end(performance.now() < deadline ? terminalRemaining(deadline) : 10_000);
        } catch {
          terminalMigrationFailed = true;
          cleanupFailure = true;
        }
      }
      closed = terminalCleanupKnown({
        pending: plan.terminalState().pending || monitor.terminalState().pending ? 1 : 0,
        idle: cleaned,
        cleaned,
        closed: !cleanupFailure && plan.terminalState().closed && monitor.terminalState().closed,
      });
      if (closed) terminalMigrationPending--;
      console.info(
        'E4_TERMINAL_SMALL_RESOURCES',
        JSON.stringify({
          temporary: cleaned ? 'ABSENT' : 'UNKNOWN',
          closed,
          pending: terminalMigrationPending,
          deadlinePassed: performance.now() >= deadline,
          cleanupFailure,
        }),
      );
    }
    if (cleanupFailure || performance.now() >= deadline) {
      terminalMigrationFailed = true;
      throw new Error('Terminal small execution/cleanup UNKNOWN or deadline exceeded');
    }
    if (primary) throw primary.value;
    if (!completed) throw new Error('Terminal small work terminal UNKNOWN');
    return completed.value;
  });
}
// E4_TERMINAL_RETAINED_DIAGNOSTIC_BEGIN
type E4D1CaptureTerminalState = import('../helpers/e4-d1-result-capture').E4D1TerminalState;
type E4D1CaptureFailedPhase = import('../helpers/e4-d1-result-capture').E4D1FailedPhase;
type E4D1CaptureFailureCode = import('../helpers/e4-d1-result-capture').E4D1FailureCode;
function terminalRetainedCaptureProofPhase(step: E4RetainedProofStep): E4D1CaptureFailedPhase {
  switch (step) {
    case 'old-current':
      return 'complete-proof-old-current';
    case 'body-current':
      return 'complete-proof-body-current';
    case 'current-stored':
      return 'complete-proof-current-stored';
    case 'document-hashes':
      return 'complete-proof-document-hashes';
    case 'source-hashes':
      return 'complete-proof-source-hashes';
    case 'root-hashes':
      return 'complete-proof-root-hashes';
    default:
      throw new Error('Retained fixed proof queue differs');
  }
}
function terminalRetainedFailure(error: unknown) {
  const known = [
    ['Terminal remaining request deadline refused', 'DEADLINE'],
    ['S13 read backend ended; terminal may be unknown', 'BACKEND_ENDED'],
    ['S13 read deadline; terminal unknown, DROP prohibited', 'REQUEST_DEADLINE'],
    ['Retained installed complete migration checksum differs', 'CHECKSUM'],
    ['Retained initial public catalog or temp residue UNKNOWN', 'PUBLIC_RESIDUE'],
    ['Retained complete initial public source or attributes differ', 'PUBLIC_SOURCE'],
    ['Retained complete public guard attributes differ', 'GUARD'],
    ['Retained unique submitted maximum root UNKNOWN', 'ROOT_COUNT'],
    ['Retained synthetic maximum same-chain proof UNKNOWN', 'ROOT_CHAIN'],
    ['Retained complete bag, key, hash or root proof differs', 'FULL_TRUTH'],
    ['Body diagnostic node type is not public-safe', 'PLAN_FIELDS'],
    ['Body diagnostic numeric field missing', 'PLAN_FIELDS'],
    ['Body diagnostic stage is unknown', 'PLAN_STAGE'],
    ['Body documents producer is ambiguous', 'DOCUMENTS_MULTIPLE'],
    ['Body documents consumer is ambiguous', 'DOCUMENTS_MULTIPLE'],
    ['Body diagnostic real full coverage differs', 'BODY_COVERAGE'],
    ['Body documents eligibility missing', 'ELIGIBILITY'],
    ['Retained actual resource/positive control UNKNOWN', 'RESOURCE'],
    ['Retained actual repeatable-read READ ONLY missing', 'SNAPSHOT'],
    ['Retained fixed proof queue differs', 'PROOF_QUEUE'],
    ['Retained proof statement duration differs', 'PROOF_DEADLINE'],
  ] as const;
  return error instanceof Error
    ? (known.find(([message]) => message === error.message)?.[1] ?? 'UNKNOWN')
    : 'UNKNOWN';
}
type E4RetainedPublic = TerminalCatalog & { source: string };
const E4_RETAINED_PUBLIC_SQL =
  'SELECT c.*,p.prosrc AS source FROM (' +
  E4_TERMINAL_CATALOG_SQL +
  ') c' +
  " JOIN pg_proc p ON p.oid=to_regprocedure('public.e4_expected_evaluations(text)')";
function terminalRetainedPublic(rows: E4RetainedPublic[], identity: TerminalIdentity) {
  terminalAssertIdentity(identity, identity);
  if (rows.length !== 1) throw new Error('Retained initial public catalog or temp residue UNKNOWN');
  const { source, ...row } = rows[0];
  const body = terminalExpectedDefinition(terminalActualSource()).body;
  if (
    source !== body ||
    terminalHash(source, 'md5') !== E4_TERMINAL_NEW_BODY_MD5 ||
    row.scope !== 'public' ||
    row.schema !== 'public' ||
    row.pid !== identity.pid ||
    row.body !== E4_TERMINAL_NEW_BODY_MD5 ||
    row.bytes !== Buffer.byteLength(body, 'utf8') ||
    row.ownerMatches !== true ||
    !Number.isSafeInteger(row.owner) ||
    row.owner <= 0 ||
    row.acl !== null ||
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
    row.temporary !== false
  )
    throw new Error('Retained complete initial public source or attributes differ');
  return row;
}
const E4_RETAINED_GUARD_SQL =
  'SELECT p.prosrc AS source,md5(p.prosrc) AS body,pg_get_userbyid(p.proowner)=current_user AS "ownerMatches",' +
  ' p.proowner::int AS owner,to_jsonb(p.proacl) AS acl,l.lanname::text AS language,' +
  ' p.provolatile::text AS volatility,p.proisstrict AS strict,NOT p.prosecdef AS invoker,' +
  ' p.proparallel::text AS parallel,p.procost::float8 AS cost,p.prorows::float8 AS rows,' +
  ' p.proconfig AS config,pg_get_function_arguments(p.oid) AS args,' +
  ' pg_get_function_result(p.oid) AS result,p.pronargdefaults AS defaults,' +
  ' pg_get_expr(p.proargdefaults,0) AS "defaultExpression"' +
  ' FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang' +
  " WHERE p.oid=to_regprocedure('public.e4_assert_complete(text,boolean)')";
type E4RetainedGuard = Omit<TerminalCatalog, 'scope' | 'schema' | 'pid' | 'bytes' | 'temporary'> & {
  source: string;
};
function terminalRetainedGuard(rows: E4RetainedGuard[]) {
  const matches = [
    ...terminalActualSource().matchAll(
      /CREATE FUNCTION e4_assert_complete\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/gu,
    ),
  ];
  if (matches.length !== 1 || rows.length !== 1)
    throw new Error('Retained complete public guard missing');
  const row = rows[0];
  if (
    row.source !== matches[0][1] ||
    row.body !== '21fe9ecf6df989a3f8fa5878df40b93c' ||
    terminalHash(row.source, 'md5') !== row.body ||
    row.ownerMatches !== true ||
    !Number.isSafeInteger(row.owner) ||
    row.owner <= 0 ||
    row.acl !== null ||
    row.language !== 'plpgsql' ||
    row.volatility !== 'v' ||
    row.strict !== false ||
    row.invoker !== true ||
    row.parallel !== 'u' ||
    row.cost !== 100 ||
    row.rows !== 0 ||
    JSON.stringify(row.config) !== JSON.stringify(['search_path=pg_catalog, public']) ||
    row.args !== 'revision_id text, validate_version boolean DEFAULT true' ||
    row.result !== 'void' ||
    row.defaults !== 1 ||
    row.defaultExpression !== 'true'
  )
    throw new Error('Retained complete public guard attributes differ');
  return row;
}
function terminalRetainedCleanupProof(
  remaining: TerminalCatalog[],
  initial: TerminalCatalog | undefined,
  residue: { count: number }[],
  finalGuard: E4RetainedGuard,
  initialGuard: E4RetainedGuard | undefined,
) {
  if (
    remaining.length !== 1 ||
    !initial ||
    JSON.stringify(remaining[0]) !== JSON.stringify(initial)
  )
    throw new Error('Retained public catalog/temp absence UNKNOWN');
  if (residue.length !== 1 || residue[0].count !== 0)
    throw new Error('Retained same-session temp absence UNKNOWN');
  if (!initialGuard || JSON.stringify(finalGuard) !== JSON.stringify(initialGuard))
    throw new Error('Retained complete public guard changed');
}
const E4_RETAINED_ROOT_SQL = String.raw`SELECT r.id,
  coalesce(a.title ~ '^e13_[a-f0-9]{10}_activity_[0-9]+$'
    AND r."operationKey" ~ '^e13_[a-f0-9]{10}_s13_submit_[0-9]+$'
    AND d."operationKey" ~ '^e13_[a-f0-9]{10}_s13_prepare_[0-9]+$'
    AND substring(a.title FROM '^e13_[a-f0-9]{10}') =
        substring(r."operationKey" FROM '^e13_[a-f0-9]{10}')
    AND substring(a.title FROM '^e13_[a-f0-9]{10}') =
        substring(d."operationKey" FROM '^e13_[a-f0-9]{10}'),FALSE) AS synthetic,
  coalesce(d."kindCode"='draft' AND d."regimeCode"='policy_v1'
    AND d."sourceKindCode"='time_revision' AND d."activityId"=r."activityId"
    AND d."settlementRunId"=r."settlementRunId"
    AND d."ruleSnapshotId"=r."ruleSnapshotId" AND d."ruleSnapshotHash"=r."ruleSnapshotHash"
    AND d."selectionRevisionId"=r."selectionRevisionId" AND d."selectionRevisionHash"=r."selectionRevisionHash"
    AND d."sourceSetHash"=r."sourceSetHash" AND d."evaluationSetHash"=r."evaluationSetHash"
    AND t."activityId"=r."activityId" AND t."settlementVersionId"=r."settlementVersionId"
    AND t."settlementRunId"=r."settlementRunId" AND t."kindCode"='submitted'
    AND t."sourceDraftTimeRevisionId"=d."timeRevisionId"
    AND r."effectiveTimeSettlementVersionId"=r."settlementVersionId"
    AND v."settlementRunId"=r."settlementRunId" AND v."contributionRegimeCode"='policy_v1'
    AND s."activityId"=r."activityId" AND s."snapshotHash"=r."ruleSnapshotHash"
    AND sel."activityId"=r."activityId" AND sel."selectionHash"=r."selectionRevisionHash"
    AND t."evidenceSealId"=r."evidenceSealId" AND t."evidenceRevision"=r."evidenceRevision"
    AND t."populationRevision"=r."populationRevision" AND t."workflowRevision"=r."workflowRevision"
    AND t."bucketCount"=8000 AND t."sourceCount"=40000,FALSE) AS chain,
  (SELECT count(*)::int FROM public."ActivityParticipationIdentity" i WHERE i."activityId"=r."activityId") AS identities,
  (SELECT count(*)::int FROM public."ParticipantTimeAllocationRevision" x WHERE x."activityId"=r."activityId") AS allocations,
  (SELECT count(*)::int FROM public."ParticipantTimeAllocationSlice" x WHERE x."activityId"=r."activityId") AS slices,
  r."recognizedPointsTotal"::text AS total
FROM public."ActivitySettlementContributionRevision" r
LEFT JOIN public."ActivitySettlementContributionRevision" d ON d.id=r."sourceDraftContributionRevisionId"
LEFT JOIN public."Activity" a ON a.id=r."activityId"
LEFT JOIN public."ActivitySettlementTimeRevision" t ON t.id=r."timeRevisionId"
LEFT JOIN public."AttendanceSettlementVersion" v ON v.id=r."settlementVersionId"
LEFT JOIN public."ActivityRuleSnapshot" s ON s.id=r."ruleSnapshotId"
LEFT JOIN public."ActivityContributionPolicySelectionRevision" sel ON sel.id=r."selectionRevisionId"
WHERE r."kindCode"='submitted' AND r."regimeCode"='policy_v1'
  AND r."sourceKindCode"='time_revision' AND r."evaluationCount"=8000`;
type E4RetainedRoot = {
  id: string;
  synthetic: boolean;
  chain: boolean;
  identities: number;
  allocations: number;
  slices: number;
  total: string;
};
function terminalRetainedRoot(rows: E4RetainedRoot[]) {
  if (rows.length !== 1) throw new Error('Retained unique submitted maximum root UNKNOWN');
  const row = rows[0];
  if (
    typeof row.id !== 'string' ||
    row.id.length === 0 ||
    row.synthetic !== true ||
    row.chain !== true ||
    row.identities !== 2000 ||
    row.allocations !== 10000 ||
    row.slices !== 50000 ||
    row.total !== '1000.00'
  )
    throw new Error('Retained synthetic maximum same-chain proof UNKNOWN');
  return row.id; // Private binding only. Never emit the record or this identifier.
}
function terminalRetainedBagColumns(sql: string) {
  if (
    !sql.startsWith('SELECT * FROM (\nWITH direct(unit_canonical,evaluation) AS MATERIALIZED (\n')
  )
    throw new Error('Retained direct bag result names differ');
  return sql;
}
function terminalRetainedBag(body: string) {
  if (body !== terminalBodyBinding(terminalActualSource()).body)
    throw new Error('Retained bag complete body pin differs');
  return terminalRetainedBagColumns(
    'SELECT * FROM (\nWITH direct(unit_canonical,evaluation) AS MATERIALIZED (\n' +
      body +
      String.raw`
), old AS MATERIALIZED (
  SELECT * FROM pg_temp.e4_expected_evaluations_1234_opening($1::text)
), current AS MATERIALIZED (
  SELECT * FROM public.e4_expected_evaluations($1::text)
), stored AS MATERIALIZED (
  SELECT public.e4_evaluation_document(e) AS evaluation
  FROM public."ParticipantContributionEvaluation" e WHERE e."contributionRevisionId"=$1::text
), old_difference AS (
  (SELECT * FROM old EXCEPT ALL SELECT * FROM current)
  UNION ALL (SELECT * FROM current EXCEPT ALL SELECT * FROM old)
), body_difference AS (
  (SELECT * FROM direct EXCEPT ALL SELECT * FROM current)
  UNION ALL (SELECT * FROM current EXCEPT ALL SELECT * FROM direct)
), stored_difference AS (
  (SELECT evaluation FROM direct EXCEPT ALL SELECT evaluation FROM stored)
  UNION ALL (SELECT evaluation FROM stored EXCEPT ALL SELECT evaluation FROM direct)
), checks AS (
  SELECT count(*)::int AS count,
    bool_and((SELECT jsonb_agg(field ORDER BY field COLLATE "C")
      FROM jsonb_object_keys(evaluation) field)=$2::jsonb) AS keys,
    bool_and(evaluation->>'evaluationHash'=public.e4_envelope_hash(evaluation-'evaluationHash')) AS hashes,
    bool_and(evaluation->>'sourceFingerprint'=public.e4_envelope_hash(jsonb_build_object(
      'domain','time_revision','sources',evaluation->'sourceRefsJson'))) AS sources,
    sum((evaluation->>'recognizedPoints')::NUMERIC) AS total,
    sum(jsonb_array_length(evaluation->'sourceRefsJson'))::int AS refs,
    public.e4_envelope_hash(jsonb_build_object('domain','time_revision','sources',
      jsonb_agg(jsonb_build_object('evaluationUnitKey',evaluation->'evaluationUnitKey',
        'sourceFingerprint',evaluation->'sourceFingerprint') ORDER BY unit_canonical COLLATE "C"))) AS source_hash,
    public.e4_envelope_hash(jsonb_build_object('evaluations',
      jsonb_agg(evaluation->'evaluationHash' ORDER BY unit_canonical COLLATE "C"))) AS evaluation_hash
  FROM direct
)
SELECT (SELECT count(*)::int FROM old) AS "oldCount",
  (SELECT count(*)::int FROM current) AS "currentCount",
  (SELECT count(*)::int FROM stored) AS "storedCount", c.count AS "directCount",
  (SELECT count(*)::int FROM old_difference) AS "oldDifferences",
  (SELECT count(*)::int FROM body_difference) AS "bodyDifferences",
  (SELECT count(*)::int FROM stored_difference) AS "storedDifferences",
  c.keys AS "completeKeys",c.hashes AS "evaluationHashes",c.sources AS "sourceHashes",
  c.refs AS "references", c.total=1000.00 AND c.total=r."recognizedPointsTotal" AS "rootTotal",
  c.source_hash=r."sourceSetHash" AS "rootSourceHash",
  c.evaluation_hash=r."evaluationSetHash" AS "rootEvaluationHash"
FROM checks c JOIN public."ActivitySettlementContributionRevision" r ON r.id=$1::text
) AS e4_retained_body_bag`,
  );
}
const E4_RETAINED_PROOF_STEPS = [
  'old-current',
  'body-current',
  'current-stored',
  'document-hashes',
  'source-hashes',
  'root-hashes',
] as const;
type E4RetainedProofStep = (typeof E4_RETAINED_PROOF_STEPS)[number];
type E4RetainedProof = { step: E4RetainedProofStep; sql: string };
type E4RetainedProofRow = Record<string, number | boolean>;
type E4RetainedProofResult = { step: E4RetainedProofStep; values: E4RetainedProofRow };
type E4RetainedProofFrame = {
  step: E4RetainedProofStep;
  durationMs: number;
  values: E4RetainedProofRow;
};
type E4RetainedProofPrivateRow = Record<string, number | boolean | string> & { rootId: string };
type E4RetainedSnapshot = { readonly: boolean; repeatable: boolean };
const E4_RETAINED_RR_BEGIN = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
const E4_RETAINED_SNAPSHOT_SQL =
  "SELECT current_setting('transaction_read_only')='on' AS readonly," +
  " current_setting('transaction_isolation')='repeatable read' AS repeatable";
function terminalRetainedSnapshot(rows: E4RetainedSnapshot[]) {
  if (
    rows.length !== 1 ||
    rows[0].readonly !== true ||
    rows[0].repeatable !== true ||
    Object.keys(rows[0]).sort().join(',') !== 'readonly,repeatable'
  )
    throw new Error('Retained actual repeatable-read READ ONLY missing');
  return rows[0];
}
function terminalRetainedProofs(body: string): E4RetainedProof[] {
  if (body !== terminalBodyBinding(terminalActualSource()).body)
    throw new Error('Retained bag complete body pin differs');
  const finish = (fields: string, from = '') =>
    '\nSELECT r.id AS "rootId",' +
    fields +
    from +
    '\nJOIN public."ActivitySettlementContributionRevision" r ON r.id=$1::text\n) AS e4_retained_proof';
  const stored = String.raw`stored AS MATERIALIZED (
  SELECT public.e4_evaluation_document(e) AS evaluation
  FROM public."ParticipantContributionEvaluation" e WHERE e."contributionRevisionId"=$1::text
)`;
  return [
    {
      step: 'old-current',
      sql:
        'SELECT * FROM (\nWITH ' +
        String.raw`old AS MATERIALIZED (
  SELECT * FROM pg_temp.e4_expected_evaluations_1234_opening($1::text)
), current AS MATERIALIZED (
  SELECT * FROM public.e4_expected_evaluations($1::text)
), left_difference AS (
  SELECT * FROM old EXCEPT ALL SELECT * FROM current
), right_difference AS (
  SELECT * FROM current EXCEPT ALL SELECT * FROM old
), checks AS (
  SELECT (SELECT count(*)::int FROM old) AS "oldCount",
    (SELECT count(*)::int FROM current) AS "currentCount",
    (SELECT count(*)::int FROM left_difference) AS "leftDifferences",
    (SELECT count(*)::int FROM right_difference) AS "rightDifferences"
)` +
        finish('c.*', ' FROM checks c'),
    },
    {
      step: 'body-current',
      sql: terminalRetainedBagColumns(
        'SELECT * FROM (\nWITH direct(unit_canonical,evaluation) AS MATERIALIZED (\n' +
          body +
          String.raw`
), current AS MATERIALIZED (
  SELECT * FROM public.e4_expected_evaluations($1::text)
), left_difference AS (
  SELECT * FROM direct EXCEPT ALL SELECT * FROM current
), right_difference AS (
  SELECT * FROM current EXCEPT ALL SELECT * FROM direct
), checks AS (
  SELECT (SELECT count(*)::int FROM direct) AS "directCount",
    (SELECT count(*)::int FROM current) AS "currentCount",
    (SELECT count(*)::int FROM left_difference) AS "leftDifferences",
    (SELECT count(*)::int FROM right_difference) AS "rightDifferences"
)` +
          finish('c.*', ' FROM checks c'),
      ),
    },
    {
      step: 'current-stored',
      sql:
        'SELECT * FROM (\nWITH current AS MATERIALIZED (' +
        '\n  SELECT evaluation FROM public.e4_expected_evaluations($1::text)\n), ' +
        stored +
        String.raw`, left_difference AS (
  SELECT evaluation FROM current EXCEPT ALL SELECT evaluation FROM stored
), right_difference AS (
  SELECT evaluation FROM stored EXCEPT ALL SELECT evaluation FROM current
), checks AS (
  SELECT (SELECT count(*)::int FROM current) AS "currentCount",
    (SELECT count(*)::int FROM stored) AS "storedCount",
    (SELECT count(*)::int FROM left_difference) AS "leftDifferences",
    (SELECT count(*)::int FROM right_difference) AS "rightDifferences"
)` +
        finish('c.*', ' FROM checks c'),
    },
    {
      step: 'document-hashes',
      sql:
        'SELECT * FROM (\nWITH ' +
        stored +
        String.raw`, checks AS (
  SELECT count(*)::int AS "storedCount",
    bool_and((SELECT jsonb_agg(field ORDER BY field COLLATE "C")
      FROM jsonb_object_keys(evaluation) field)=$2::jsonb) AS "completeKeys",
    bool_and(evaluation->>'evaluationHash'=public.e4_envelope_hash(evaluation-'evaluationHash')) AS "evaluationHashes"
  FROM stored
)` +
        finish('c.*', ' FROM checks c'),
    },
    {
      step: 'source-hashes',
      sql:
        'SELECT * FROM (\nWITH ' +
        stored +
        String.raw`, checks AS (
  SELECT count(*)::int AS "storedCount",
    bool_and(evaluation->>'sourceFingerprint'=public.e4_envelope_hash(jsonb_build_object(
      'domain','time_revision','sources',evaluation->'sourceRefsJson'))) AS "sourceHashes",
    sum(jsonb_array_length(evaluation->'sourceRefsJson'))::int AS "references"
  FROM stored
)` +
        finish('c.*', ' FROM checks c'),
    },
    {
      step: 'root-hashes',
      sql:
        'SELECT * FROM (\nWITH stored AS MATERIALIZED (' +
        String.raw`
  SELECT public.e4_evaluation_document(e) AS evaluation,
    public.astr_canonical_json(jsonb_build_object(
      'participationIdentityId',e."participationIdentityId",'sessionId',e."sessionId",
      'mode',e.mode,'policyId',e."policyId",'policyVersionId',e."policyVersionId",
      'definitionHash',e."definitionHash",'evaluatorVersion',e."evaluatorVersion",
      'attendanceRoleCode',e."attendanceRoleCode",'timeCategoryCode',e."timeCategoryCode")) AS unit_canonical
  FROM public."ParticipantContributionEvaluation" e WHERE e."contributionRevisionId"=$1::text
), checks AS (
  SELECT count(*)::int AS units,
    sum(jsonb_array_length(evaluation->'sourceRefsJson'))::int AS refs,
    sum((evaluation->>'recognizedPoints')::NUMERIC) AS total,
    public.e4_envelope_hash(jsonb_build_object('domain','time_revision','sources',
      jsonb_agg(jsonb_build_object('evaluationUnitKey',evaluation->'evaluationUnitKey',
        'sourceFingerprint',evaluation->'sourceFingerprint') ORDER BY unit_canonical COLLATE "C"))) AS source_hash,
    public.e4_envelope_hash(jsonb_build_object('evaluations',
      jsonb_agg(evaluation->'evaluationHash' ORDER BY unit_canonical COLLATE "C"))) AS evaluation_hash
  FROM stored
)` +
        finish(
          String.raw`c.units AS "rootUnits",c.refs AS "rootReferences",
  c.total=1000.00 AND c.total=r."recognizedPointsTotal" AS "rootTotal",
  c.source_hash=r."sourceSetHash" AS "rootSourceHash",
  c.evaluation_hash=r."evaluationSetHash" AS "rootEvaluationHash"`,
          ' FROM checks c',
        ),
    },
  ];
}
function terminalRetainedProofQueuePlan(proofs: E4RetainedProof[], body: string) {
  const expected = terminalRetainedProofs(body);
  if (
    proofs.length !== 6 ||
    proofs.some(
      (proof, index) =>
        proof.step !== expected[index].step ||
        proof.sql !== expected[index].sql ||
        Object.keys(proof).sort().join(',') !== 'sql,step',
    )
  )
    throw new Error('Retained fixed proof queue differs');
}
function terminalRetainedProofExpected(step: E4RetainedProofStep): E4RetainedProofRow {
  switch (step) {
    case 'old-current':
      return { oldCount: 8000, currentCount: 8000, leftDifferences: 0, rightDifferences: 0 };
    case 'body-current':
      return { directCount: 8000, currentCount: 8000, leftDifferences: 0, rightDifferences: 0 };
    case 'current-stored':
      return { currentCount: 8000, storedCount: 8000, leftDifferences: 0, rightDifferences: 0 };
    case 'document-hashes':
      return { storedCount: 8000, completeKeys: true, evaluationHashes: true };
    case 'source-hashes':
      return { storedCount: 8000, sourceHashes: true, references: 50000 };
    case 'root-hashes':
      return {
        rootUnits: 8000,
        rootReferences: 50000,
        rootTotal: true,
        rootSourceHash: true,
        rootEvaluationHash: true,
      };
    default:
      throw new Error('Retained fixed proof queue differs');
  }
}
function terminalRetainedProofValues(
  step: E4RetainedProofStep,
  rows: E4RetainedProofPrivateRow[],
  rootId: string,
): E4RetainedProofRow {
  if (
    rows.length !== 1 ||
    typeof rootId !== 'string' ||
    rootId.length === 0 ||
    rows[0].rootId !== rootId
  )
    throw new Error('Retained complete bag, key, hash or root proof differs');
  const { rootId: privateRoot, ...privateValues } = rows[0];
  const expected = terminalRetainedProofExpected(step);
  if (
    !privateRoot ||
    Object.keys(privateValues).sort().join(',') !== Object.keys(expected).sort().join(',')
  )
    throw new Error('Retained complete bag, key, hash or root proof differs');
  // Copy only the fixed numeric/boolean whitelist; never return the private root binding.
  const values: E4RetainedProofRow = {};
  for (const [key, value] of Object.entries(privateValues)) {
    if (typeof value !== 'number' && typeof value !== 'boolean')
      throw new Error('Retained complete bag, key, hash or root proof differs');
    values[key] = value;
  }
  return values;
}
function terminalRetainedRejectedProofFrame(
  step: E4RetainedProofStep,
  rows: E4RetainedProofPrivateRow[],
  rootId: string,
  durationMs: number,
): E4RetainedProofFrame | undefined {
  try {
    return { step, durationMs, values: terminalRetainedProofValues(step, rows, rootId) };
  } catch {
    return undefined;
  }
}
function terminalRetainedProofResult(
  step: E4RetainedProofStep,
  rows: E4RetainedProofPrivateRow[],
  rootId: string,
): E4RetainedProofResult {
  const values = terminalRetainedProofValues(step, rows, rootId);
  const expected = terminalRetainedProofExpected(step);
  if (Object.entries(expected).some(([key, value]) => values[key] !== value))
    throw new Error('Retained complete bag, key, hash or root proof differs');
  return { step, values };
}
function terminalRetainedProofTruth(results: E4RetainedProofResult[]) {
  if (
    results.length !== 6 ||
    results.some((result, index) => result.step !== E4_RETAINED_PROOF_STEPS[index])
  )
    throw new Error('Retained fixed proof queue differs');
  for (const result of results) {
    const expected = terminalRetainedProofExpected(result.step);
    if (
      Object.keys(result.values).sort().join(',') !== Object.keys(expected).sort().join(',') ||
      Object.entries(expected).some(([key, value]) => result.values[key] !== value)
    )
      throw new Error('Retained complete bag, key, hash or root proof differs');
  }
  const [old, body, stored, documents, sources, root] = results.map((result) => result.values);
  return {
    oldCount: old.oldCount,
    currentCount: old.currentCount,
    storedCount: stored.storedCount,
    directCount: body.directCount,
    oldDifferences: Number(old.leftDifferences) + Number(old.rightDifferences),
    bodyDifferences: Number(body.leftDifferences) + Number(body.rightDifferences),
    storedDifferences: Number(stored.leftDifferences) + Number(stored.rightDifferences),
    completeKeys: documents.completeKeys,
    evaluationHashes: documents.evaluationHashes,
    sourceHashes: sources.sourceHashes,
    references: sources.references,
    rootTotal: root.rootTotal,
    rootSourceHash: root.rootSourceHash,
    rootEvaluationHash: root.rootEvaluationHash,
  };
}
async function terminalRetainedRunProofs(
  body: string,
  rootId: string,
  snapshot: E4RetainedSnapshot,
  query: (
    proof: E4RetainedProof,
    values: string[],
  ) => Promise<{ rows: E4RetainedProofPrivateRow[] }>,
  emit: (outcome: 'PASS' | 'REJECTED', value: E4RetainedProofFrame) => void,
) {
  terminalRetainedSnapshot([snapshot]);
  const proofs = terminalRetainedProofs(body);
  terminalRetainedProofQueuePlan(proofs, body);
  const results: E4RetainedProofResult[] = [];
  for (const proof of proofs) {
    const started = performance.now();
    const result = await query(
      proof,
      proof.step === 'document-hashes'
        ? [rootId, JSON.stringify(E4_TERMINAL_DOCUMENT_KEYS)]
        : [rootId],
    );
    const durationMs = Number((performance.now() - started).toFixed(3));
    if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 30000)
      throw new Error('Retained proof statement duration differs');
    let validated: E4RetainedProofResult;
    try {
      validated = terminalRetainedProofResult(proof.step, result.rows, rootId);
    } catch (error) {
      const rejected = terminalRetainedRejectedProofFrame(
        proof.step,
        result.rows,
        rootId,
        durationMs,
      );
      if (rejected) emit('REJECTED', rejected);
      throw error;
    }
    results.push(validated);
    emit('PASS', { step: validated.step, durationMs, values: validated.values });
  }
  return terminalRetainedProofTruth(results);
}
// Independent top-level, local-only diagnostic. No installer, reset, app or business hook.
describe('E4 terminal expected retained function-body diagnostic', () => {
  (process.env.SRVF_E4_W98 === '1' ? it : it.skip)(
    'pins retained full source and captures the complete current body once',
    async () => {
      const capture = await import('../helpers/e4-d1-result-capture');
      const captureContext = capture.openE4D1CaptureContext(process.env);
      const deadline = terminalRetainedDeadline();
      // Register all resources and pending acquisition before the first asynchronous operation.
      const resources: {
        owner?: ScratchLeaseSession;
        acquiring: boolean;
        plan: S13ReadClient;
        observer: S13ReadClient;
        planOpened: boolean;
        observerOpened: boolean;
      } = {
        acquiring: true,
        plan: new S13ReadClient(S13_LOCAL_DB),
        observer: new S13ReadClient('postgres'),
        planOpened: false,
        observerOpened: false,
      };
      let identity: TerminalIdentity | undefined;
      let initialPublic: TerminalCatalog | undefined;
      let ownerPid = 0,
        publicBytes = 0;
      const emit = (
        label:
          | 'E4_RETAINED_NULL_BODY'
          | 'E4_RETAINED_PROOF_STEP'
          | 'E4_RETAINED_PROOF_REJECTED'
          | 'E4_RETAINED_FULL_BODY_TRUTH'
          | 'E4_RETAINED_CURRENT_BODY_PLAN'
          | 'E4_RETAINED_BODY_RESOURCES',
        value: unknown,
      ) => {
        publicBytes = terminalRetainedPublicBytes(publicBytes, value);
        console.info(label, JSON.stringify(value));
      };
      let catalog: ReturnType<typeof terminalValidateCatalog> | undefined;
      let guard: E4RetainedGuard | undefined;
      let baseline: { path: string; timeout: string } | undefined;
      let phase: E4D1CaptureFailedPhase = 'entry',
        primary: E4D1CaptureFailedPhase | undefined;
      let failureCode: E4D1CaptureFailureCode | null = null;
      let temporary: 'NOT_CREATED' | 'PRESENT' | 'ABSENT' | 'UNKNOWN' = 'NOT_CREATED';
      let before: E4RetainedResources | undefined, after: E4RetainedResources | undefined;
      let completed = false,
        releaseKnown = false,
        captureWritten = false,
        captureFallbackWritten = false;
      let nullCalibration: E4D1CaptureTerminalState['nullCalibration'] = {
        observed: false,
        eligibility: false,
        fullCoverageRejected: false,
      };
      let fullPlan: E4D1CaptureTerminalState['fullPlan'] = {
        observed: false,
        eligibility: false,
        nodeCount: 0,
        bodyEligibility: null,
        bodyRecognition: null,
      };
      const proofs: E4D1CaptureTerminalState['proofs'] = [];
      const state = {
        planClosed: false,
        observerClosed: false,
        pending: 1,
        idle: false,
        settingsRestored: false,
        publicUnchanged: false,
      };
      const previous = { worker: process.env.JEST_WORKER_ID, url: process.env.DATABASE_URL };
      const pending = async <T>(work: () => Promise<T>) => {
        state.pending++;
        try {
          return await work();
        } finally {
          state.pending--;
        }
      };
      const inspect = async (planPid: number, ownerPid: number) => {
        const result = await resources.observer.query<E4RetainedResources>(
          "SELECT (SELECT count(*)::int FROM pg_database WHERE datname='" +
            S13_LOCAL_DB +
            "') AS databases," +
            " (SELECT count(*)::int FROM pg_stat_activity WHERE datname='" +
            S13_LOCAL_DB +
            "') AS clients," +
            ' (SELECT count(*)::int FROM pg_stat_activity WHERE pid=$1 AND datname=\'postgres\') AS "ownerBackends",' +
            " (SELECT count(*)::int FROM pg_locks WHERE locktype='advisory' AND granted" +
            " AND classid=((hashtextextended('SRVF:test:D3:app_test_w98',0)>>32)&4294967295)::oid" +
            ' AND objid=(hashtextextended(\'SRVF:test:D3:app_test_w98\',0)&4294967295)::oid AND objsubid=1) AS "leaseLocks",' +
            " EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND granted" +
            " AND classid=((hashtextextended('SRVF:test:D3:app_test_w98',0)>>32)&4294967295)::oid" +
            ' AND objid=(hashtextextended(\'SRVF:test:D3:app_test_w98\',0)&4294967295)::oid AND objsubid=1) AS "leaseOwnerVisible",' +
            ' EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=pg_backend_pid() AND datname=\'postgres\') AS "observerVisible",' +
            " EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$2 AND datname='" +
            S13_LOCAL_DB +
            '\') AS "planVisible",' +
            ' current_database()=\'postgres\' AND inet_server_addr() IS NULL AS "exactScope",' +
            ' session_user=current_user AND ($1=0 OR NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND usename<>current_user))' +
            ' AND ($2=0 OR NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$2 AND usename<>current_user)) AS "samePrincipal",' +
            ' current_setting(\'server_version_num\')::int BETWEEN 160000 AND 169999 AS "sameServer"',
          [ownerPid, planPid],
          terminalRemaining(deadline),
        );
        if (result.rows.length !== 1) throw new Error('Retained metadata envelope UNKNOWN');
        return result.rows[0];
      };
      const settings = () =>
        resources.plan.query<{ path: string; timeout: string }>(
          "SELECT current_setting('search_path') AS path,current_setting('statement_timeout') AS timeout",
          [],
          terminalRemaining(deadline),
        );
      const rollback = async () => {
        await resources.plan.query('ROLLBACK', [], terminalRemaining(deadline));
        if (!identity || !baseline) throw new Error('Retained rollback identity UNKNOWN');
        await terminalIdle(resources.plan, resources.observer, deadline, identity);
        const restored = await settings();
        if (
          restored.rows.length !== 1 ||
          JSON.stringify(restored.rows[0]) !== JSON.stringify(baseline)
        )
          throw new Error('Retained caller settings restoration UNKNOWN');
        state.idle = true;
        state.settingsRestored = true;
      };
      const begin = async (repeatable = false) => {
        await resources.plan.query(
          repeatable ? E4_RETAINED_RR_BEGIN : 'BEGIN READ ONLY',
          [],
          terminalRemaining(deadline),
        );
        state.idle = false;
        state.settingsRestored = false;
        await terminalBoundedQuery(
          resources.plan,
          deadline,
          'SET LOCAL search_path=pg_catalog,public',
          [],
          true,
        );
        const proof = await resources.plan.query<E4RetainedSnapshot>(
          E4_RETAINED_SNAPSHOT_SQL,
          [],
          terminalRemaining(deadline),
        );
        if (proof.rows.length !== 1 || proof.rows[0].readonly !== true)
          throw new Error('Retained actual READ ONLY missing');
        if (repeatable) terminalRetainedSnapshot(proof.rows);
        return proof.rows[0];
      };
      try {
        const { loadTestEnv } = await import('../setup/load-env');
        process.env.JEST_WORKER_ID = '98';
        loadTestEnv();
        assertTestDatabaseUrl(process.env.DATABASE_URL);
        if (deriveTestDbName() !== S13_LOCAL_DB || process.env.SRVF_TEST_RUN_SCOPE !== S13_LOCAL_DB)
          throw new Error('Retained exact authorized database differs');
        const input = terminalBodyBinding(terminalActualSource());
        phase = 'lease';
        const { acquireScratchDatabaseLease } = await import('../helpers/scratch-database-lease');
        resources.owner = await acquireScratchDatabaseLease(terminalRemaining(deadline));
        resources.acquiring = false;
        state.pending--;
        resources.owner.assertHeld();
        ownerPid = resources.owner.backendPid ?? 0;
        if (!ownerPid) throw new Error('Retained original owner identity missing');
        phase = 'observer';
        resources.observerOpened = true;
        await pending(() => resources.observer.connect(terminalRemaining(deadline)));
        before = await inspect(0, ownerPid);
        terminalRetainedResources(before, { clients: 0, owner: 1, plan: false });
        phase = 'plan-connect';
        resources.planOpened = true;
        await pending(() => resources.plan.connect(terminalRemaining(deadline)));
        identity = await terminalNativeIdentity(resources.plan, deadline);
        terminalAssertIdentity(identity, identity);
        const principals = await resources.observer.query<{
          session: string;
          principal: string;
          server: string;
        }>(
          "SELECT session_user::text AS session,current_user::text AS principal,current_setting('server_version_num') AS server",
          [],
          terminalRemaining(deadline),
        );
        const planServer = await resources.plan.query<{ server: string }>(
          "SELECT current_setting('server_version_num') AS server",
          [],
          terminalRemaining(deadline),
        );
        if (
          principals.rows.length !== 1 ||
          planServer.rows.length !== 1 ||
          principals.rows[0].server !== planServer.rows[0].server
        )
          throw new Error('Retained actual PostgreSQL instance version differs');
        terminalAssertIdentity(identity, principals.rows[0]);
        terminalRetainedResources(await inspect(identity.pid, ownerPid), {
          clients: 1,
          owner: 1,
          plan: true,
        });
        const originalSettings = await settings();
        if (originalSettings.rows.length !== 1) throw new Error('Retained caller settings missing');
        baseline = originalSettings.rows[0];
        phase = 'source-catalog';
        await begin();
        const migrations = await terminalBoundedQuery<{
          count: number;
          checksum: string;
          failed: number;
        }>(
          resources.plan,
          deadline,
          'SELECT count(*)::int AS count,' +
            " max(checksum) FILTER (WHERE migration_name='20261003000000_activity_contribution_settlement') AS checksum," +
            ' count(*) FILTER (WHERE finished_at IS NULL)::int AS failed FROM public."_prisma_migrations" WHERE rolled_back_at IS NULL',
          [],
          true,
        );
        if (
          migrations.rows.length !== 1 ||
          migrations.rows[0].count !== 137 ||
          migrations.rows[0].checksum !== E4_TERMINAL_ACTUAL_SHA ||
          migrations.rows[0].failed !== 0
        )
          throw new Error('Retained installed complete migration checksum differs');
        const initial = await terminalBoundedQuery<E4RetainedPublic>(
          resources.plan,
          deadline,
          E4_RETAINED_PUBLIC_SQL,
          [],
          true,
        );
        initialPublic = terminalRetainedPublic(initial.rows, identity);
        guard = terminalRetainedGuard(
          (
            await terminalBoundedQuery<E4RetainedGuard>(
              resources.plan,
              deadline,
              E4_RETAINED_GUARD_SQL,
              [],
              true,
            )
          ).rows,
        );
        const roots = await terminalBoundedQuery<E4RetainedRoot>(
          resources.plan,
          deadline,
          E4_RETAINED_ROOT_SQL,
          [],
          true,
        );
        const rootId = terminalRetainedRoot(roots.rows);
        await rollback();
        phase = 'temporary-old-install';
        await resources.plan.query('BEGIN', [], terminalRemaining(deadline));
        state.idle = false;
        state.settingsRestored = false;
        temporary = 'UNKNOWN';
        await terminalBoundedQuery(
          resources.plan,
          deadline,
          terminalTemporaryDefinition(),
          [],
          true,
        );
        catalog = terminalValidateCatalog(
          (
            await terminalBoundedQuery<TerminalCatalog>(
              resources.plan,
              deadline,
              E4_TERMINAL_CATALOG_SQL,
              [],
              true,
            )
          ).rows,
          identity,
        );
        if (
          JSON.stringify(catalog.current) !== JSON.stringify(initialPublic) ||
          catalog.current.owner !== guard.owner
        )
          throw new Error('Retained public owner or attributes changed during install');
        await resources.plan.query('COMMIT', [], terminalRemaining(deadline));
        temporary = 'PRESENT';
        await rollback();
        phase = 'null-body-calibration';
        await begin();
        const nullPlan = await terminalBoundedQuery<{ 'QUERY PLAN': unknown }>(
          resources.plan,
          deadline,
          'EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, VERBOSE, FORMAT JSON)' +
            terminalBodyNull(input.body),
          [],
          true,
        );
        if (nullPlan.rows.length !== 1) throw new Error('Retained NULL direct plan missing');
        const calibrated = terminalBodyPlan(nullPlan.rows[0]['QUERY PLAN'], input, false);
        let rejected = false;
        try {
          terminalBodyPlan(nullPlan.rows[0]['QUERY PLAN'], input, true);
        } catch {
          rejected = true;
        }
        if (!rejected) throw new Error('Retained NULL full coverage was not refused');
        nullCalibration = {
          observed: true,
          eligibility: calibrated.eligibility,
          fullCoverageRejected: rejected,
        };
        emit('E4_RETAINED_NULL_BODY', calibrated);
        await rollback();
        phase = 'complete-proof-snapshot';
        const snapshot = await begin(true);
        const truth = await terminalRetainedRunProofs(
          input.body,
          rootId,
          snapshot,
          async (proof, values) => {
            phase = terminalRetainedCaptureProofPhase(proof.step);
            return terminalBoundedQuery<E4RetainedProofPrivateRow>(
              resources.plan,
              deadline,
              proof.sql,
              values,
              true,
            );
          },
          (outcome, value) => {
            proofs.push({ outcome, ...value });
            emit(
              outcome === 'PASS' ? 'E4_RETAINED_PROOF_STEP' : 'E4_RETAINED_PROOF_REJECTED',
              value,
            );
          },
        );
        emit('E4_RETAINED_FULL_BODY_TRUTH', truth);
        // The unique full body plan stays in the very same verified read-only RR snapshot.
        phase = 'complete-current-body-plan';
        const fullPlanQuery = await terminalBoundedQuery<{ 'QUERY PLAN': unknown }>(
          resources.plan,
          deadline,
          'EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, VERBOSE, FORMAT JSON)' + input.body,
          [rootId],
          true,
        );
        if (fullPlanQuery.rows.length !== 1)
          throw new Error('Retained complete direct plan missing');
        let projected: ReturnType<typeof terminalBodyPlan>;
        try {
          projected = terminalBodyPlan(fullPlanQuery.rows[0]['QUERY PLAN'], input, true);
        } catch (error) {
          if (error instanceof TerminalBodyEligibilityError) {
            fullPlan = {
              observed: true,
              eligibility: error.diagnostic.checks.eligible,
              nodeCount: error.recognition.nodeCount,
              bodyEligibility: error.diagnostic,
              bodyRecognition: error.recognition,
            };
          }
          throw error;
        }
        fullPlan = {
          observed: true,
          eligibility: projected.eligibility,
          nodeCount: projected.nodes.length,
          bodyEligibility: projected.bodyEligibility,
          bodyRecognition: projected.bodyRecognition,
        };
        emit('E4_RETAINED_CURRENT_BODY_PLAN', {
          inputSha: projected.inputSha,
          sourceSha: projected.sourceSha,
          diagnosticProjection: projected.diagnosticProjection,
          eligibility: projected.eligibility,
          bodyEligibility: projected.bodyEligibility,
          nodes: projected.nodes,
        });
        terminalAssertIdentity(await terminalNativeIdentity(resources.plan, deadline), identity);
        await rollback();
        completed = true;
      } catch (error) {
        primary = phase;
        failureCode = terminalRetainedFailure(error);
        terminalMigrationFailed = true;
      } finally {
        try {
          if (
            identity &&
            baseline &&
            resources.planOpened &&
            !resources.plan.terminalState().pending
          ) {
            await rollback();
            phase = 'temporary-old-cleanup';
            if (temporary === 'PRESENT') {
              await resources.plan.query('BEGIN', [], terminalRemaining(deadline));
              state.idle = false;
              state.settingsRestored = false;
              await terminalBoundedQuery(
                resources.plan,
                deadline,
                'DROP FUNCTION pg_temp.e4_expected_evaluations_1234_opening(text)',
                [],
                true,
              );
              await resources.plan.query('COMMIT', [], terminalRemaining(deadline));
              await rollback();
            }
            await begin();
            const remaining = await terminalBoundedQuery<TerminalCatalog>(
              resources.plan,
              deadline,
              E4_TERMINAL_CATALOG_SQL,
              [],
              true,
            );
            await rollback();
            const residue = await resources.plan.query<{ count: number }>(
              'SELECT count(*)::int AS count FROM pg_proc WHERE pronamespace=pg_my_temp_schema()' +
                " AND proname='e4_expected_evaluations_1234_opening'",
              [],
              terminalRemaining(deadline),
            );
            const finalGuard = terminalRetainedGuard(
              (
                await resources.plan.query<E4RetainedGuard>(
                  E4_RETAINED_GUARD_SQL,
                  [],
                  terminalRemaining(deadline),
                )
              ).rows,
            );
            terminalRetainedCleanupProof(
              remaining.rows,
              initialPublic,
              residue.rows,
              finalGuard,
              guard,
            );
            temporary = 'ABSENT';
            state.publicUnchanged = true;
          }
        } catch (error) {
          failureCode ??= terminalRetainedFailure(error);
          primary ??= phase;
          terminalMigrationFailed = true;
        }
        if (resources.planOpened) {
          try {
            await resources.plan.end(
              performance.now() < deadline ? terminalRemaining(deadline) : 10000,
            );
            state.planClosed =
              resources.plan.terminalState().closed && !resources.plan.terminalState().pending;
          } catch {
            primary ??= 'plan-close';
          }
        }
        if (resources.owner && !resources.acquiring) {
          try {
            await resources.owner.release();
            releaseKnown = true;
          } catch {
            primary ??= 'owner-release';
          }
        } else if (terminalMigrationLease.owner) {
          try {
            await terminalMigrationLease.owner.release();
            releaseKnown = true;
          } catch {
            primary ??= 'partial-owner-release';
          }
        }
        if (resources.observerOpened) {
          try {
            after = await inspect(identity?.pid ?? 0, ownerPid);
            terminalRetainedResources(after, { clients: 0, owner: 0, plan: false });
          } catch {
            primary ??= 'final-metadata';
          }
          try {
            await resources.observer.end(
              performance.now() < deadline ? terminalRemaining(deadline) : 10000,
            );
            state.observerClosed =
              resources.observer.terminalState().closed &&
              !resources.observer.terminalState().pending;
          } catch {
            primary ??= 'observer-close';
          }
        }
        if (state.planClosed && state.observerClosed && releaseKnown && !resources.acquiring)
          state.pending = 0;
        process.env.JEST_WORKER_ID = previous.worker;
        process.env.DATABASE_URL = previous.url;
        try {
          capture.writeE4D1SafeResult(captureContext, {
            completed,
            failedPhase: primary ?? null,
            failureCode,
            temporary,
            ...state,
            releaseKnown,
            deadlinePassed: performance.now() >= deadline,
            before: before ?? 'UNKNOWN',
            after: after ?? 'UNKNOWN',
            nullCalibration,
            fullPlan,
            proofs,
          });
          captureWritten = true;
        } catch {
          try {
            capture.writeE4D1FallbackUnknownResult(captureContext);
            captureFallbackWritten = true;
          } catch {
            // The outer test must preserve its original terminal path even when both safe writers fail.
          }
          terminalMigrationFailed = true;
        }
        emit('E4_RETAINED_BODY_RESOURCES', {
          completed,
          failedPhase: primary ?? null,
          failureCode,
          temporary,
          ...state,
          releaseKnown,
          deadlinePassed: performance.now() >= deadline,
          before: before ?? 'UNKNOWN',
          after: after ?? 'UNKNOWN',
        });
      }
      if (
        primary ||
        !completed ||
        temporary !== 'ABSENT' ||
        !state.planClosed ||
        !state.observerClosed ||
        state.pending !== 0 ||
        !state.publicUnchanged ||
        !state.settingsRestored ||
        !releaseKnown ||
        !captureWritten ||
        captureFallbackWritten ||
        performance.now() >= deadline
      )
        throw new Error(
          'Retained function-body diagnostic did not pass; subsequent stages prohibited',
        );
    },
    75_000,
  );
});
// E4_TERMINAL_RETAINED_DIAGNOSTIC_END

// E4_TERMINAL_HELPERS_END

// E4_TERMINAL_N1_ADMISSION_BEGIN
const E4_N1_ADMISSION_JEST_FULL_NAME =
  'E4 N1 candidate admission gate verifies the installed candidate before the D1 launcher can start';
type E4N1AdmissionState =
  | 'READY'
  | 'RESOURCE_BLOCKED'
  | 'INSTALL_REQUIRED'
  | 'CATALOG_INVALID'
  | 'FIXTURE_NOT_READY';
function terminalN1AdmissionDecision(input: {
  resourcesReady: boolean;
  migration: { count: number; checksum: string | null; failed: number };
  catalogReady: boolean;
  rootReady: boolean;
}): E4N1AdmissionState {
  if (!input.resourcesReady) return 'RESOURCE_BLOCKED';
  if (!terminalN1MigrationReady(input.migration)) return 'INSTALL_REQUIRED';
  if (!input.catalogReady) return 'CATALOG_INVALID';
  if (!input.rootReady) return 'FIXTURE_NOT_READY';
  return 'READY';
}
function terminalN1MigrationReady(migration: {
  count: number;
  checksum: string | null;
  failed: number;
}) {
  return (
    migration.count === 137 &&
    migration.checksum === E4_TERMINAL_ACTUAL_SHA &&
    migration.failed === 0
  );
}
async function assertTerminalN1InstalledCatalog(db: PrismaClient) {
  await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const identity = await tx.$queryRaw<TerminalIdentity[]>`
        SELECT current_database() AS db,pg_backend_pid() AS pid,
          session_user::text AS session,current_user::text AS principal
      `;
      if (identity.length !== 1) throw new Error('N1 installed catalog identity missing');
      terminalAssertIdentity(identity[0], identity[0]);
      const migrations = await tx.$queryRaw<
        { count: number; checksum: string | null; failed: number }[]
      >`
        SELECT count(*)::int AS count,
          max(checksum) FILTER (WHERE migration_name='20261003000000_activity_contribution_settlement') AS checksum,
          count(*) FILTER (WHERE finished_at IS NULL)::int AS failed
        FROM public."_prisma_migrations" WHERE rolled_back_at IS NULL
      `;
      const migration = migrations[0];
      if (migrations.length !== 1 || !migration || !terminalN1MigrationReady(migration))
        throw new Error('N1 installed migration checksum differs');
      const current = terminalRetainedPublic(
        await tx.$queryRawUnsafe<E4RetainedPublic[]>(E4_RETAINED_PUBLIC_SQL),
        identity[0],
      );
      const guard = terminalRetainedGuard(
        await tx.$queryRawUnsafe<E4RetainedGuard[]>(E4_RETAINED_GUARD_SQL),
      );
      if (current.owner !== guard.owner) throw new Error('N1 installed catalog owner differs');
    },
    { timeout: 30_000 },
  );
}
async function runTerminalN1Admission() {
  const deadline = performance.now() + 30_000;
  const resources: {
    owner?: ScratchLeaseSession;
    acquiring: boolean;
    plan: S13ReadClient;
    observer: S13ReadClient;
    planOpened: boolean;
    observerOpened: boolean;
  } = {
    acquiring: true,
    plan: new S13ReadClient(S13_LOCAL_DB),
    observer: new S13ReadClient('postgres'),
    planOpened: false,
    observerOpened: false,
  };
  let identity: TerminalIdentity | undefined;
  let ownerPid = 0;
  let baseline: { path: string; timeout: string } | undefined;
  let primary: unknown;
  let cleanupUnknown = false;
  const previous = { worker: process.env.JEST_WORKER_ID, url: process.env.DATABASE_URL };
  const inspect = async (planPid: number, leasePid: number) => {
    const result = await resources.observer.query<E4RetainedResources>(
      "SELECT (SELECT count(*)::int FROM pg_database WHERE datname='" +
        S13_LOCAL_DB +
        "') AS databases," +
        " (SELECT count(*)::int FROM pg_stat_activity WHERE datname='" +
        S13_LOCAL_DB +
        "') AS clients," +
        ' (SELECT count(*)::int FROM pg_stat_activity WHERE pid=$1 AND datname=\'postgres\') AS "ownerBackends",' +
        " (SELECT count(*)::int FROM pg_locks WHERE locktype='advisory' AND granted" +
        " AND classid=((hashtextextended('SRVF:test:D3:app_test_w98',0)>>32)&4294967295)::oid" +
        ' AND objid=(hashtextextended(\'SRVF:test:D3:app_test_w98\',0)&4294967295)::oid AND objsubid=1) AS "leaseLocks",' +
        " EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND granted" +
        " AND classid=((hashtextextended('SRVF:test:D3:app_test_w98',0)>>32)&4294967295)::oid" +
        ' AND objid=(hashtextextended(\'SRVF:test:D3:app_test_w98\',0)&4294967295)::oid AND objsubid=1) AS "leaseOwnerVisible",' +
        ' EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=pg_backend_pid() AND datname=\'postgres\') AS "observerVisible",' +
        " EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$2 AND datname='" +
        S13_LOCAL_DB +
        '\') AS "planVisible",' +
        ' current_database()=\'postgres\' AND inet_server_addr() IS NULL AS "exactScope",' +
        ' session_user=current_user AND ($1=0 OR NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND usename<>current_user))' +
        ' AND ($2=0 OR NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$2 AND usename<>current_user)) AS "samePrincipal",' +
        ' current_setting(\'server_version_num\')::int BETWEEN 160000 AND 169999 AS "sameServer"',
      [leasePid, planPid],
      terminalRemaining(deadline),
    );
    if (result.rows.length !== 1) throw new Error('N1 admission resource envelope UNKNOWN');
    return result.rows[0];
  };
  const settings = () =>
    resources.plan.query<{ path: string; timeout: string }>(
      "SELECT current_setting('search_path') AS path,current_setting('statement_timeout') AS timeout",
      [],
      terminalRemaining(deadline),
    );
  try {
    const { loadTestEnv } = await import('../setup/load-env');
    process.env.JEST_WORKER_ID = '98';
    loadTestEnv();
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    if (deriveTestDbName() !== S13_LOCAL_DB || process.env.SRVF_TEST_RUN_SCOPE !== S13_LOCAL_DB)
      throw new Error('N1 admission exact authorized database differs');
    const { acquireScratchDatabaseLease } = await import('../helpers/scratch-database-lease');
    resources.owner = await acquireScratchDatabaseLease(terminalRemaining(deadline));
    resources.acquiring = false;
    resources.owner.assertHeld();
    ownerPid = resources.owner.backendPid ?? 0;
    if (!ownerPid) throw new Error('N1 admission owner identity missing');
    resources.observerOpened = true;
    await resources.observer.connect(terminalRemaining(deadline));
    terminalRetainedResources(await inspect(0, ownerPid), { clients: 0, owner: 1, plan: false });
    resources.planOpened = true;
    await resources.plan.connect(terminalRemaining(deadline));
    identity = await terminalNativeIdentity(resources.plan, deadline);
    terminalAssertIdentity(identity, identity);
    const principals = await resources.observer.query<{
      session: string;
      principal: string;
      server: string;
    }>(
      "SELECT session_user::text AS session,current_user::text AS principal,current_setting('server_version_num') AS server",
      [],
      terminalRemaining(deadline),
    );
    const planServer = await resources.plan.query<{ server: string }>(
      "SELECT current_setting('server_version_num') AS server",
      [],
      terminalRemaining(deadline),
    );
    if (
      principals.rows.length !== 1 ||
      planServer.rows.length !== 1 ||
      principals.rows[0].server !== planServer.rows[0].server
    )
      throw new Error('N1 admission PostgreSQL instance version differs');
    terminalAssertIdentity(identity, principals.rows[0]);
    terminalRetainedResources(await inspect(identity.pid, ownerPid), {
      clients: 1,
      owner: 1,
      plan: true,
    });
    const original = await settings();
    if (original.rows.length !== 1) throw new Error('N1 admission caller settings missing');
    baseline = original.rows[0];
    await resources.plan.query(E4_RETAINED_RR_BEGIN, [], terminalRemaining(deadline));
    await terminalBoundedQuery(
      resources.plan,
      deadline,
      'SET LOCAL search_path=pg_catalog,public',
      [],
      true,
    );
    const snapshot = await resources.plan.query<E4RetainedSnapshot>(
      E4_RETAINED_SNAPSHOT_SQL,
      [],
      terminalRemaining(deadline),
    );
    terminalRetainedSnapshot(snapshot.rows);
    const migrations = await terminalBoundedQuery<{
      count: number;
      checksum: string | null;
      failed: number;
    }>(
      resources.plan,
      deadline,
      'SELECT count(*)::int AS count,' +
        " max(checksum) FILTER (WHERE migration_name='20261003000000_activity_contribution_settlement') AS checksum," +
        ' count(*) FILTER (WHERE finished_at IS NULL)::int AS failed FROM public."_prisma_migrations" WHERE rolled_back_at IS NULL',
      [],
      true,
    );
    const migration = migrations.rows[0];
    if (migrations.rows.length !== 1 || !migration || !terminalN1MigrationReady(migration))
      throw new Error('N1 candidate installation required');
    const current = terminalRetainedPublic(
      (
        await terminalBoundedQuery<E4RetainedPublic>(
          resources.plan,
          deadline,
          E4_RETAINED_PUBLIC_SQL,
          [],
          true,
        )
      ).rows,
      identity,
    );
    const guard = terminalRetainedGuard(
      (
        await terminalBoundedQuery<E4RetainedGuard>(
          resources.plan,
          deadline,
          E4_RETAINED_GUARD_SQL,
          [],
          true,
        )
      ).rows,
    );
    if (current.owner !== guard.owner) throw new Error('N1 admission public owner differs');
    terminalRetainedRoot(
      (
        await terminalBoundedQuery<E4RetainedRoot>(
          resources.plan,
          deadline,
          E4_RETAINED_ROOT_SQL,
          [],
          true,
        )
      ).rows,
    );
    if (
      terminalN1AdmissionDecision({
        resourcesReady: true,
        migration,
        catalogReady: true,
        rootReady: true,
      }) !== 'READY'
    )
      throw new Error('N1 candidate admission state differs');
  } catch (error) {
    primary = error;
  } finally {
    if (resources.planOpened) {
      try {
        await resources.plan.query('ROLLBACK', [], terminalRemaining(deadline));
        if (!identity || !baseline) cleanupUnknown = true;
        else {
          await terminalIdle(resources.plan, resources.observer, deadline, identity);
          const restored = await settings();
          if (
            restored.rows.length !== 1 ||
            JSON.stringify(restored.rows[0]) !== JSON.stringify(baseline)
          )
            cleanupUnknown = true;
        }
      } catch {
        cleanupUnknown = true;
      }
      try {
        await resources.plan.end(
          performance.now() < deadline ? terminalRemaining(deadline) : 10_000,
        );
      } catch {
        cleanupUnknown = true;
      }
    }
    if (resources.owner && !resources.acquiring) {
      try {
        await resources.owner.release();
      } catch {
        cleanupUnknown = true;
      }
    }
    if (resources.observerOpened) {
      try {
        terminalRetainedResources(await inspect(identity?.pid ?? 0, ownerPid), {
          clients: 0,
          owner: 0,
          plan: false,
        });
      } catch {
        cleanupUnknown = true;
      }
      try {
        await resources.observer.end(
          performance.now() < deadline ? terminalRemaining(deadline) : 10_000,
        );
      } catch {
        cleanupUnknown = true;
      }
    }
    if (previous.worker === undefined) delete process.env.JEST_WORKER_ID;
    else process.env.JEST_WORKER_ID = previous.worker;
    if (previous.url === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous.url;
  }
  if (cleanupUnknown) throw new Error('N1 admission cleanup UNKNOWN');
  if (primary)
    throw primary instanceof Error ? primary : new Error('N1 admission rejected without an error');
}
describe('E4 N1 candidate admission gate', () => {
  (process.env.SRVF_E4_W98 === '1' && process.env.SRVF_E4_N1_ADMISSION === '1' ? it : it.skip)(
    'verifies the installed candidate before the D1 launcher can start',
    async () => {
      const capture = await import('../helpers/e4-d1-result-capture');
      expect(capture.E4_N1_ADMISSION_JEST_FULL_NAME).toBe(E4_N1_ADMISSION_JEST_FULL_NAME);
      await runTerminalN1Admission();
    },
    30_000,
  );
});
// E4_TERMINAL_N1_ADMISSION_END

// E4_TERMINAL_FROZEN_BEGIN
// Independently frozen complete §12.34 opening, before changing the actual public SQL.
const E4_TERMINAL_EXPECTED_OPENING_SQL = String.raw`CREATE FUNCTION e4_expected_evaluations(revision_id TEXT)
RETURNS TABLE(unit_canonical TEXT,evaluation JSONB)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
WITH revision_domain AS MATERIALIZED (
  SELECT astr_canonical_json(jsonb_build_object('domain',
    (SELECT "sourceKindCode" FROM "ActivitySettlementContributionRevision" WHERE id=revision_id))->'domain') AS canonical
), sources AS MATERIALIZED (
  SELECT source.*,astr_canonical_json(source_ref) AS source_canonical FROM e4_source_rows(revision_id) source
), groups AS MATERIALIZED (
  SELECT identity_id,member_id,session_id,snapshot_id,policy_id,policy_version_id,definition_hash,evaluator_version,role_code,category_code,
    min(item_id COLLATE "C") AS representative,
    sum((source_ref->>'durationSeconds')::BIGINT)::INTEGER AS seconds,
    jsonb_agg(source_ref ORDER BY source_canonical COLLATE "C") AS refs,
    '[' || string_agg(coalesce(source_canonical,'null'),',' ORDER BY source_canonical COLLATE "C") || ']' AS refs_canonical
  FROM sources GROUP BY identity_id,member_id,session_id,snapshot_id,policy_id,policy_version_id,definition_hash,evaluator_version,role_code,category_code
), policy_bands AS MATERIALIZED (
  SELECT p.id,role->>'attendanceRoleCode' AS role_code,category->>'timeCategoryCode' AS category_code,band,ordinal
  FROM "ContributionPolicyVersion" p
  CROSS JOIN LATERAL jsonb_array_elements(p."definitionJson"->'roleRules') role
  CROSS JOIN LATERAL jsonb_array_elements(role->'categoryRules') category
  CROSS JOIN LATERAL jsonb_array_elements(category->'durationBands') WITH ORDINALITY b(band,ordinal)
  WHERE p.id IN (SELECT DISTINCT policy_version_id FROM groups)
), selected AS MATERIALIZED (
  SELECT g.*,coalesce(chosen.band,p."definitionJson"->'defaultResult') AS result,
    astr_canonical_json(jsonb_build_object('participationIdentityId',g.identity_id,'sessionId',g.session_id,
      'mode','policy','policyId',g.policy_id,'policyVersionId',g.policy_version_id,'definitionHash',g.definition_hash,
      'evaluatorVersion',g.evaluator_version,'attendanceRoleCode',g.role_code,'timeCategoryCode',g.category_code)) AS unit
  FROM groups g JOIN "ContributionPolicyVersion" p ON p.id=g.policy_version_id
  LEFT JOIN LATERAL (
    SELECT b.band FROM policy_bands b WHERE b.id=g.policy_version_id AND b.role_code=g.role_code AND b.category_code=g.category_code
      AND ((b.band->>'maxSecondsInclusive') IS NULL OR (b.band->>'maxSecondsInclusive')::BIGINT >= g.seconds)
    ORDER BY b.ordinal LIMIT 1
  ) chosen ON TRUE
), documents AS MATERIALIZED (
  SELECT unit,refs,refs_canonical,
    jsonb_build_object('participationIdentityId',identity_id,'memberId',member_id,'sessionId',session_id,'ruleSnapshotId',snapshot_id,
      'selectionItemId',representative,'mode','policy','policyId',policy_id,'policyVersionId',policy_version_id,'definitionHash',definition_hash,
      'evaluatorVersion',evaluator_version,'attendanceRoleCode',role_code,'timeCategoryCode',category_code,
      'evaluationUnitKey',e4_envelope_hash(jsonb_build_object('unit',unit)),'durationSeconds',seconds,
      'sourceFingerprint',encode(sha256(convert_to('{"definition":{"domain":' || (SELECT canonical FROM revision_domain)
        || ',"sources":' || refs_canonical || '},"schemaVersion":1}','UTF8')),'hex'),
      'calculatedPoints',result->>'recognizedPoints','recognizedPoints',result->>'recognizedPoints','explanationCode',result->>'explanationCode',
      'beijingDayPointsJson',e4_day_points(refs,((result->>'recognizedPoints')::NUMERIC*100)::INTEGER)) AS metadata
  FROM selected
), canonical_documents AS MATERIALIZED (
  SELECT unit,refs,metadata,
    (SELECT '{' || string_agg(to_jsonb(field_name)::TEXT || ':' || field_canonical,',' ORDER BY field_name COLLATE "C") || '}'
     FROM (
       SELECT key AS field_name,astr_canonical_json(value) AS field_canonical FROM jsonb_each(metadata)
       UNION ALL SELECT 'sourceRefsJson',refs_canonical
     ) field) AS document_canonical
  FROM documents
)
SELECT unit,metadata || jsonb_build_object('sourceRefsJson',refs,
  'evaluationHash',encode(sha256(convert_to('{"definition":' || document_canonical || ',"schemaVersion":1}','UTF8')),'hex'))
FROM canonical_documents
$$;
`;
// E4_TERMINAL_FROZEN_END

// Fixed complete pre-§12.22 window from 0d5def0a…; neither oracle nor pins come from the subject.
const E4_P_SET_OLD_WINDOW_SQL = String.raw`    IF EXISTS (
      WITH expected AS MATERIALIZED (SELECT evaluation->>'evaluationUnitKey' AS key,evaluation FROM e4_expected_evaluations(root.id)),
      actual AS MATERIALIZED (SELECT "evaluationUnitKey" AS key,e4_evaluation_document(e) AS evaluation
        FROM "ParticipantContributionEvaluation" e WHERE e."contributionRevisionId"=root.id)
      SELECT 1 FROM expected x FULL JOIN actual a USING (key) WHERE x.evaluation IS DISTINCT FROM a.evaluation
    ) THEN RAISE EXCEPTION 'contribution evaluation set mismatch' USING ERRCODE='23514',CONSTRAINT='e4_evaluation_guard'; END IF;
`;
const E4_P_SET_NEW_WINDOW_SQL = String.raw`    IF EXISTS (
      WITH expected AS MATERIALIZED (
        SELECT evaluation->>'evaluationUnitKey' AS key,evaluation
        FROM e4_expected_evaluations(root.id)
      ), actual AS MATERIALIZED (
        SELECT e.id,e."evaluationUnitKey" AS key
        FROM "ParticipantContributionEvaluation" e
        WHERE e."contributionRevisionId"=root.id
      )
      SELECT 1
      FROM (expected x FULL JOIN actual a USING (key))
      LEFT JOIN "ParticipantContributionEvaluation" e
        ON e.id=a.id AND e."contributionRevisionId"=root.id
      WHERE x.evaluation IS DISTINCT FROM
        CASE WHEN e.id IS NULL THEN NULL::JSONB
             ELSE e4_evaluation_document(e) END
    ) THEN RAISE EXCEPTION 'contribution evaluation set mismatch' USING ERRCODE='23514',CONSTRAINT='e4_evaluation_guard'; END IF;
`;
const E4_S13_WINDOW_SQL = String.raw`    IF EXISTS (
      WITH expected AS MATERIALIZED (
        SELECT row_number() OVER () AS expected_row_ordinal,
          evaluation->>'evaluationUnitKey' AS key,evaluation
        FROM e4_expected_evaluations(root.id)
      ), expected_keys AS MATERIALIZED (
        SELECT expected_row_ordinal,key FROM expected
      ), actual AS MATERIALIZED (
        SELECT e.id,e."evaluationUnitKey" AS key
        FROM "ParticipantContributionEvaluation" e
        WHERE e."contributionRevisionId"=root.id
      ), pairs AS MATERIALIZED (
        SELECT x.expected_row_ordinal,a.id AS actual_id
        FROM expected_keys x FULL JOIN actual a USING (key)
      )
      SELECT 1
      FROM pairs p
      LEFT JOIN expected x
        ON x.expected_row_ordinal=p.expected_row_ordinal
      LEFT JOIN "ParticipantContributionEvaluation" e
        ON e.id=p.actual_id AND e."contributionRevisionId"=root.id
      WHERE x.evaluation IS DISTINCT FROM
        CASE WHEN e.id IS NULL THEN NULL::JSONB
             ELSE e4_evaluation_document(e) END
    ) THEN RAISE EXCEPTION 'contribution evaluation set mismatch' USING ERRCODE='23514',CONSTRAINT='e4_evaluation_guard'; END IF;
`;
// Approved §12.30 candidate, separate from every fixed historical oracle above.
const E4_COLLECTION_PAIR_WINDOW_SQL = String.raw`    IF EXISTS (
      WITH expected AS MATERIALIZED (
        SELECT evaluation->>'evaluationUnitKey' AS key,evaluation
        FROM e4_expected_evaluations(root.id)
      ), actual AS MATERIALIZED (
        SELECT e.id,e."evaluationUnitKey" AS key
        FROM "ParticipantContributionEvaluation" e
        WHERE e."contributionRevisionId"=root.id
      ), pairs AS MATERIALIZED (
        SELECT x.evaluation AS expected_evaluation,a.id AS actual_id
        FROM expected x FULL JOIN actual a USING (key)
      )
      SELECT 1
      FROM pairs p
      LEFT JOIN "ParticipantContributionEvaluation" e
        ON e.id=p.actual_id AND e."contributionRevisionId"=root.id
      WHERE p.expected_evaluation IS DISTINCT FROM
        CASE WHEN e.id IS NULL THEN NULL::JSONB
             ELSE e4_evaluation_document(e) END
    ) THEN RAISE EXCEPTION 'contribution evaluation set mismatch' USING ERRCODE='23514',CONSTRAINT='e4_evaluation_guard'; END IF;
`;

// Approved §12.33: the actual input and historical projection are deliberately separate.
const E4_COLLECTION_BOOLEAN_WINDOW_SQL = String.raw`    IF EXISTS (
      WITH expected AS NOT MATERIALIZED (
        SELECT evaluation->>'evaluationUnitKey' AS key,evaluation
        FROM e4_expected_evaluations(root.id)
      ), actual AS MATERIALIZED (
        SELECT e.id,e."evaluationUnitKey" AS key
        FROM "ParticipantContributionEvaluation" e
        WHERE e."contributionRevisionId"=root.id
      ), pairs AS MATERIALIZED (
        SELECT a.id AS actual_id,
          x.evaluation IS DISTINCT FROM
            CASE WHEN e.id IS NULL THEN NULL::JSONB
                 ELSE e4_evaluation_document(e) END AS is_mismatch
        FROM (expected x FULL JOIN actual a USING (key))
        LEFT JOIN "ParticipantContributionEvaluation" e
          ON e.id=a.id AND e."contributionRevisionId"=root.id
      )
      SELECT 1
      FROM pairs p
      WHERE p.is_mismatch
    ) THEN RAISE EXCEPTION 'contribution evaluation set mismatch' USING ERRCODE='23514',CONSTRAINT='e4_evaluation_guard'; END IF;
`;
const E4_BOOLEAN_MIGRATION_SHA = '5dba9f0e34a1f8b94023c7ff8f1fcf4c72f164c6fe60e0268a12829632446f6a';
const E4_BOOLEAN_COMPLETE_MD5 = '21fe9ecf6df989a3f8fa5878df40b93c';
const E4_BOOLEAN_OPENING_SHA = 'abc898ef05148b521e17a0eda68f2b367ac0a88939086afc3948582acc5551cf';
function restoreBooleanCollectionWindow(source: string): string {
  const windows = [
    ...source.matchAll(
      / {4}IF EXISTS \(\n {6}WITH expected AS NOT MATERIALIZED \([\s\S]*?CONSTRAINT='e4_evaluation_guard'; END IF;\n/gu,
    ),
  ];
  if (windows.length !== 1 || windows[0][0] !== E4_COLLECTION_BOOLEAN_WINDOW_SQL)
    throw new Error('E4 boolean collection unique exact window mismatch');
  return source.replace(windows[0][0], () => E4_COLLECTION_PAIR_WINDOW_SQL);
}
// E4_TERMINAL_REPLACE_HISTORY_BEGIN
function booleanCollectionHistorySource(source = rawS13MigrationSource()): string {
  source = terminalHistoricalBooleanInput(source);
  if (createHash('sha256').update(source).digest('hex') !== E4_BOOLEAN_MIGRATION_SHA)
    throw new Error('E4 boolean collection actual full source mismatch');
  const restored = restoreBooleanCollectionWindow(source);
  if (createHash('sha256').update(restored).digest('hex') !== E4_BOOLEAN_OPENING_SHA)
    throw new Error('E4 boolean collection opening full source mismatch');
  return restored;
}
// E4_TERMINAL_REPLACE_HISTORY_END
function actualBooleanCollectionWindow(source = rawS13MigrationSource()): string {
  booleanCollectionHistorySource(source);
  return E4_COLLECTION_BOOLEAN_WINDOW_SQL;
}

function rawS13MigrationSource(): string {
  return readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20261003000000_activity_contribution_settlement/migration.sql',
    ),
    'utf8',
  );
}
function actualCollectionPairWindow(source = booleanCollectionHistorySource()): string {
  const matches = [
    ...source.matchAll(
      / {4}IF EXISTS \(\n {6}WITH expected AS MATERIALIZED \([\s\S]*?CONSTRAINT='e4_evaluation_guard'; END IF;\n/gu,
    ),
  ];
  expect(matches).toHaveLength(1);
  expect(matches[0][0]).toBe(E4_COLLECTION_PAIR_WINDOW_SQL);
  return matches[0][0];
}
// Window-only inverse also supports pg_get_functiondef; no live body supplies an oracle.
function restoreCollectionPairWindow(source: string): string {
  const window = actualCollectionPairWindow(source);
  return source.replace(window, () => E4_S13_WINDOW_SQL);
}
function assertCollectionPairOpeningClosure(source: string): string {
  const opening = source.includes('pg_catalog.translate(') ? formatProbeInverse(source) : source;
  const restored = restoreCollectionPairWindow(opening);
  expect(createHash('sha256').update(restored).digest('hex')).toBe(
    '96e4dfae0f00a3321b43d02ace0314442483f535673526a76fa043e03075b4b4',
  );
  return restored;
}
function historicalS13MigrationSource(): string {
  return assertCollectionPairOpeningClosure(booleanCollectionHistorySource());
}
function restoreS13Window(source: string): string {
  expect(source.split(E4_S13_WINDOW_SQL)).toHaveLength(2);
  return source.replace(E4_S13_WINDOW_SQL, () => E4_P_SET_NEW_WINDOW_SQL);
}
function legacyS13Input(source: string): string {
  if (source.includes('pairs AS MATERIALIZED') && !source.includes('expected_row_ordinal'))
    source = restoreCollectionPairWindow(source);
  return source.includes('expected_row_ordinal') ? restoreS13Window(source) : source;
}
function assertS13OpeningClosure(source: string): string {
  const restored = restoreS13Window(source);
  expect(createHash('sha256').update(restored).digest('hex')).toBe(
    '3f73112f745247fd5ce4762a1b8e8d3551e4648f48ec47e76eb9b54ad4fd8b02',
  );
  return restored;
}
function actualS13Window(source = historicalS13MigrationSource()): string {
  const matches = [
    ...source.matchAll(
      / {4}IF EXISTS \(\n {6}WITH expected AS MATERIALIZED \([\s\S]*?CONSTRAINT='e4_evaluation_guard'; END IF;\n/gu,
    ),
  ];
  expect(matches).toHaveLength(1);
  expect(matches[0][0]).toBe(E4_S13_WINDOW_SQL);
  return matches[0][0];
}

// Older byte-closure assertions receive only the fixed opening S13 window.
// Real candidate execution explicitly uses actualCollectionPairWindow(), never this adapter.
function pSetMigrationSource() {
  const source = booleanCollectionHistorySource();
  const opening = source.includes('pg_catalog.translate(') ? formatProbeInverse(source) : source;
  return legacyS13Input(opening);
}
function restoreFixedOldSet(source: string): string {
  source = legacyS13Input(source);
  expect(createHash('sha256').update(E4_P_SET_OLD_WINDOW_SQL).digest('hex')).toBe(
    '9eb03221a1fed4e126bcd6b8c37624f1d8e31072754a08eb1753346ddd0ee911',
  );
  expect(source.split(E4_P_SET_NEW_WINDOW_SQL)).toHaveLength(2);
  const restored = source.replace(E4_P_SET_NEW_WINDOW_SQL, () => E4_P_SET_OLD_WINDOW_SQL);
  // Normalize only the separately pinned §12.23 precheck; never update the older oracle pins.
  return restored.includes('CREATE FUNCTION e4_day_points(')
    ? restoreOpeningPDay(restored)
    : restored;
}
function actualPSetWindow(): string {
  const source = pSetMigrationSource();
  const matches = [
    ...source.matchAll(
      / {4}IF EXISTS \(\n {6}WITH expected AS MATERIALIZED \([\s\S]*?CONSTRAINT='e4_evaluation_guard'; END IF;\n/gu,
    ),
  ];
  expect(matches).toHaveLength(1);
  expect(matches[0][0]).toBe(E4_P_SET_NEW_WINDOW_SQL);
  return matches[0][0];
}
function pSetSelect(window: string): string {
  const prefix = '    IF EXISTS (\n';
  const suffix =
    "\n    ) THEN RAISE EXCEPTION 'contribution evaluation set mismatch' USING ERRCODE='23514',CONSTRAINT='e4_evaluation_guard'; END IF;\n";
  expect(window.startsWith(prefix)).toBe(true);
  expect(window.endsWith(suffix)).toBe(true);
  return window.slice(prefix.length, -suffix.length);
}
function replacePSetFixtureInput(source: string, from: string, to: string, count: number): string {
  expect(source.split(from)).toHaveLength(count + 1);
  return source.split(from).join(to);
}
// Only query-local data/row bindings change; real document builder and FULL JOIN predicate remain.
function virtualPSetSelect(window: string): Prisma.Sql {
  let sql = pSetSelect(window);
  sql = replacePSetFixtureInput(sql, 'e4_expected_evaluations(root.id)', 'pset_expected_input', 1);
  sql = replacePSetFixtureInput(
    sql,
    '"ParticipantContributionEvaluation"',
    'pset_actual_input',
    window === E4_P_SET_OLD_WINDOW_SQL ? 1 : 2,
  );
  sql = replacePSetFixtureInput(
    sql,
    'root.id',
    "'pset-root'::text",
    window === E4_P_SET_OLD_WINDOW_SQL ? 1 : 2,
  );
  sql = replacePSetFixtureInput(
    sql,
    'e4_evaluation_document(e)',
    'e4_evaluation_document(e.evaluation_row)',
    1,
  );
  return Prisma.raw(sql);
}

// Fixed complete pre-§12.20 day function, including its last LF; never derived from the candidate.
const E4_P_DAY_ORACLE_SQL = String.raw`CREATE FUNCTION e4_day_points(refs JSONB, hundredths INTEGER) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE result JSONB;
BEGIN
IF hundredths NOT BETWEEN 0 AND 99999 THEN RAISE EXCEPTION 'contribution day total overflow'
  USING ERRCODE='23514',CONSTRAINT='e4_day_guard'; END IF;
WITH source AS MATERIALIZED (
  SELECT ref,(ref->>'durationSeconds')::DOUBLE PRECISION AS seconds,ordinal,
    (ref->>'startsAt')::TIMESTAMPTZ AT TIME ZONE 'UTC' AS start_at,
    (ref->>'endsAt')::TIMESTAMPTZ AT TIME ZONE 'UTC' AS end_at
  FROM jsonb_array_elements(refs) WITH ORDINALITY x(ref,ordinal) WHERE (ref->>'durationSeconds')::INTEGER > 0
), weights AS MATERIALIZED (
  SELECT d.day::DATE AS ledger_date,
    sum(seconds * ((extract(epoch FROM (least(s.end_at,d.day+INTERVAL '16 hours')-greatest(s.start_at,d.day-INTERVAL '8 hours')))*1000)::BIGINT::DOUBLE PRECISION
      / (extract(epoch FROM (s.end_at-s.start_at))*1000)::BIGINT::DOUBLE PRECISION) ORDER BY s.ordinal) AS weight
  FROM source s CROSS JOIN LATERAL generate_series(
    date_trunc('day',s.start_at+INTERVAL '8 hours'), date_trunc('day',s.end_at+INTERVAL '8 hours'-INTERVAL '1 millisecond'),INTERVAL '1 day'
  ) d(day) GROUP BY d.day::DATE
), fractions AS (
  SELECT ledger_date,(hundredths::DOUBLE PRECISION*weight)/sum(weight) OVER () AS exact FROM weights
), amounts AS (
  SELECT ledger_date,floor(exact)::INTEGER
    + CASE WHEN row_number() OVER (ORDER BY exact-floor(exact) DESC,ledger_date)
      <= hundredths-sum(floor(exact)::INTEGER) OVER () THEN 1 ELSE 0 END AS amount FROM fractions
)
SELECT coalesce(jsonb_agg(jsonb_build_object('ledgerDate',to_char(ledger_date,'YYYY-MM-DD'),
  'recognizedPoints',to_char(amount::NUMERIC/100,'FM999999990.00')) ORDER BY ledger_date),'[]'::JSONB) INTO result FROM amounts;
IF (SELECT coalesce(sum((day->>'recognizedPoints')::NUMERIC*100),0) FROM jsonb_array_elements(result) day) <> hundredths THEN
  RAISE EXCEPTION 'contribution points require actual recognized dates' USING ERRCODE='23514',CONSTRAINT='e4_day_guard';
END IF;
RETURN result;
END
$$;
`;
const E4_P_DAY_FUNCTION_WINDOW =
  /CREATE FUNCTION e4_day_points\(refs JSONB, hundredths INTEGER\) RETURNS JSONB\nLANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, public AS \$\$\n[\s\S]*?\n\$\$;\n/gu;
function restoreFixedOldDay(source: string): string {
  expect(createHash('sha256').update(E4_P_DAY_ORACLE_SQL).digest('hex')).toBe(
    'a8cdf667c0632e832d10ea2912ebd510e84163097ddfc594f55d000746446274',
  );
  expect([...source.matchAll(E4_P_DAY_FUNCTION_WINDOW)]).toHaveLength(1);
  // A replacement string would turn SQL $$ into $, corrupting the independent old bytes.
  return source.replace(E4_P_DAY_FUNCTION_WINDOW, () => E4_P_DAY_ORACLE_SQL);
}

// Opening d405632f precheck, independent of the candidate and of the fixed old fallback.
const E4_P_DAY_OPENING_PRECHECK_SQL = String.raw`  WITH source AS MATERIALIZED (
    SELECT ref,(ref->>'durationSeconds')::DOUBLE PRECISION AS seconds,ordinal,
      (ref->>'startsAt')::TIMESTAMPTZ AT TIME ZONE 'UTC' AS start_at,
      (ref->>'endsAt')::TIMESTAMPTZ AT TIME ZONE 'UTC' AS end_at
    FROM jsonb_array_elements(refs) WITH ORDINALITY x(ref,ordinal) WHERE (ref->>'durationSeconds')::INTEGER > 0
  ) SELECT min(date_trunc('day',start_at+INTERVAL '8 hours'))::DATE,
      count(*) > 0 AND sum(seconds) BETWEEN 1 AND 2147483647
      AND min(date_trunc('day',start_at+INTERVAL '8 hours'))=max(date_trunc('day',start_at+INTERVAL '8 hours'))
      AND bool_and(coalesce(
        CASE WHEN isfinite(start_at) AND isfinite(end_at)
          THEN end_at-start_at >= INTERVAL '1 millisecond' ELSE FALSE END
        AND (ref->>'startsAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
        AND (ref->>'endsAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
        AND date_trunc('day',start_at+INTERVAL '8 hours')=date_trunc('day',end_at+INTERVAL '8 hours'-INTERVAL '1 millisecond'),
        FALSE)) INTO single_day,same_day FROM source;
`;
const E4_P_DAY_NEW_PRECHECK_SQL = String.raw`  WITH parsed AS MATERIALIZED (
    SELECT (ref->>'durationSeconds')::DOUBLE PRECISION AS seconds,
      (ref->>'startsAt')::TIMESTAMPTZ AT TIME ZONE 'UTC' AS start_at,
      (ref->>'endsAt')::TIMESTAMPTZ AT TIME ZONE 'UTC' AS end_at,
      (ref->>'startsAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' AS canonical_start,
      (ref->>'endsAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' AS canonical_end
    FROM jsonb_array_elements(refs) WITH ORDINALITY x(ref,ordinal) WHERE (ref->>'durationSeconds')::INTEGER > 0
  ), proof AS MATERIALIZED (
    SELECT seconds,date_trunc('day',start_at+INTERVAL '8 hours') AS start_day,
      date_trunc('day',end_at+INTERVAL '8 hours'-INTERVAL '1 millisecond') AS end_day,
      CASE WHEN isfinite(start_at) AND isfinite(end_at)
        THEN end_at-start_at >= INTERVAL '1 millisecond' ELSE FALSE END
      AND canonical_start AND canonical_end AS valid
    FROM parsed
  ) SELECT min(start_day)::DATE,
      count(*) > 0 AND sum(seconds) BETWEEN 1 AND 2147483647
      AND min(start_day)=max(start_day)
      AND bool_and(coalesce(valid AND start_day=end_day,FALSE)) INTO single_day,same_day FROM proof;
`;

const E4_FORMAT_OPENING_SHA = 'b056ad26a9fce4129c8e943c4d1e48b5ac1b95bce46cb4e3ba7542380ef63bd8';
const E4_FORMAT_PATTERN = String.raw`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$`;
const E4_FORMAT_TEMPLATE = '0000-00-00T00:00:00.000Z';
function formatRegex(key: 'startsAt' | 'endsAt') {
  return `(ref->>'${key}') ~ '${E4_FORMAT_PATTERN}'`;
}
function formatCase(key: 'startsAt' | 'endsAt') {
  return `CASE\n        WHEN pg_catalog.translate(ref->>'${key}', '0123456789', '0000000000')\n             COLLATE "C" = '${E4_FORMAT_TEMPLATE}' COLLATE "C"\n        THEN TRUE\n        ELSE ${formatRegex(key)}\n      END`;
}
function formatProbeSource(source: string): string {
  if (createHash('sha256').update(source).digest('hex') !== E4_FORMAT_OPENING_SHA)
    throw new Error('E4 format opening source mismatch');
  if ([...source.matchAll(E4_P_DAY_FUNCTION_WINDOW)].length !== 1)
    throw new Error('E4 format function window mismatch');
  let candidate = source;
  for (const key of ['startsAt', 'endsAt'] as const) {
    const from = `${formatRegex(key)} AS canonical_${key === 'startsAt' ? 'start' : 'end'}`;
    if (candidate.split(from).length !== 2) throw new Error('E4 format replacement count mismatch');
    candidate = candidate.replace(
      from,
      () => `${formatCase(key)} AS canonical_${key === 'startsAt' ? 'start' : 'end'}`,
    );
  }
  if (formatProbeInverse(candidate) !== source) throw new Error('E4 format inverse mismatch');
  return candidate;
}
function formatProbeInverse(source: string): string {
  let restored = source;
  for (const key of ['startsAt', 'endsAt'] as const) {
    const expression = formatCase(key);
    if (restored.split(expression).length !== 2)
      throw new Error('E4 format inverse count mismatch');
    restored = restored.replace(expression, () => formatRegex(key));
  }
  if (createHash('sha256').update(restored).digest('hex') !== E4_FORMAT_OPENING_SHA)
    throw new Error('E4 format inverse full source mismatch');
  return restored;
}
function formatTextMatrix(): unknown[] {
  const canonical = '2026-10-01T08:00:00.000Z';
  const values: unknown[] = [
    canonical,
    null,
    '',
    ' ' + canonical,
    canonical + ' ',
    canonical + '\n',
    canonical.replace('T', 't'),
    canonical.replace('Z', 'z'),
    canonical.replace('Z', '+08:00'),
    canonical.replace('.000', ''),
    canonical.replace('.000', '.0'),
    canonical.replace('.000', '.0000'),
    canonical.replace('2', '２'),
    123,
    true,
    {},
    [],
  ];
  for (let index = 0; index < canonical.length; index++) {
    values.push(canonical.slice(0, index) + 'x' + canonical.slice(index + 1));
    if (/[0-9]/u.test(canonical[index]))
      for (const digit of '0123456789')
        values.push(canonical.slice(0, index) + digit + canonical.slice(index + 1));
  }
  return values;
}
function formatDayMatrix() {
  const ref = (startsAt: unknown, endsAt: unknown, durationSeconds: unknown) => ({
    startsAt,
    endsAt,
    durationSeconds,
  });
  const same = ref('2026-10-01T08:00:00.000Z', '2026-10-01T09:00:00.000Z', 3600);
  return [
    { refs: [same], amount: 0 },
    { refs: [same], amount: 99999 },
    { refs: [same], amount: null },
    { refs: [ref('2026-10-01T15:59:00.000Z', '2026-10-01T16:00:00.000Z', 60)], amount: 1 },
    { refs: [ref('2026-10-01T15:59:00.000Z', '2026-10-01T16:01:00.000Z', 120)], amount: 101 },
    { refs: [same, ref('2026-10-02T08:00:00.000Z', '2026-10-02T09:00:00.000Z', 3600)], amount: 1 },
    { refs: [same, ref('bad', 'bad', 0), ref('bad', 'bad', -1)], amount: 101 },
    { refs: [], amount: 0 },
    { refs: [], amount: 1 },
    { refs: null, amount: 0 },
    { refs: [same], amount: 100000 },
    ...[
      'not-a-date',
      '2026-13-01T08:00:00.000Z',
      '2026-02-30T08:00:00.000Z',
      null,
      123,
      true,
      {},
      [],
    ].map((startsAt) => ({ refs: [ref(startsAt, '2026-10-01T09:00:00.000Z', 1)], amount: 1 })),
    { refs: [ref('2026-10-01T09:00:00.000Z', '2026-10-01T08:00:00.000Z', 1)], amount: 1 },
    { refs: [ref('2026-10-01T08:00:00.000Z', '2026-10-01T08:00:00.000Z', 1)], amount: 1 },
    { refs: [ref('2026-10-01T08:00:00.0001Z', '2026-10-01T08:00:00.0002Z', 1)], amount: 1 },
    {
      refs: [ref('2026-10-01T16:00:00.000+08:00', '2026-10-01T17:00:00.000+08:00', 3600)],
      amount: 101,
    },
    { refs: [ref('bad-start', 'bad-end', 'bad-duration')], amount: 100000 },
    { refs: [ref('bad-start', 'bad-end', 'bad-duration')], amount: 1 },
    { refs: [ref('bad-start', 'bad-end', '2147483648')], amount: 1 },
    { refs: [ref('bad-start', 'bad-end', 1), ref(null, null, 'bad-duration')], amount: 1 },
    { refs: [{ endsAt: '2026-10-01T09:00:00.000Z', durationSeconds: 1 }], amount: 1 },
    { refs: [{ startsAt: '2026-10-01T08:00:00.000Z', durationSeconds: 1 }], amount: 1 },
    { refs: [{ startsAt: 'bad', endsAt: 'bad' }], amount: 1 },
    { refs: [ref('bad-start', 'bad-end', 'bad-duration')], amount: null },
    { refs: [], amount: -1 },
    { refs: [ref('2026-10-01T08:00:00.000Z', '2026-10-01T09:00:00.000Z', '1.5')], amount: 1 },
    { refs: [same, { ...same, durationSeconds: 2147483647 }], amount: 99999 },
  ];
}
const E4_P_DAY_FORMAT_PRECHECK_SQL = E4_P_DAY_NEW_PRECHECK_SQL.replace(
  formatRegex('startsAt'),
  () => formatCase('startsAt'),
).replace(formatRegex('endsAt'), () => formatCase('endsAt'));

function actualPDayPrecheck(source: string): string {
  const functions = [...source.matchAll(E4_P_DAY_FUNCTION_WINDOW)];
  expect(functions).toHaveLength(1);
  const windows = [
    ...functions[0][0].matchAll(
      /\nIF hundredths IS NOT NULL THEN\n([\s\S]*?)(?= {2}IF same_day IS TRUE THEN\n)/gu,
    ),
  ];
  expect(windows).toHaveLength(1);
  expect([
    E4_P_DAY_OPENING_PRECHECK_SQL,
    E4_P_DAY_NEW_PRECHECK_SQL,
    E4_P_DAY_FORMAT_PRECHECK_SQL,
  ]).toContain(windows[0][1]);
  return windows[0][1];
}

function restoreOpeningPDay(source: string): string {
  source = legacyS13Input(source);
  const window = actualPDayPrecheck(source);
  expect(source.split(window)).toHaveLength(2);
  return source.replace(window, () => E4_P_DAY_OPENING_PRECHECK_SQL);
}

function diagnosticPDaySelect(source: string, original: boolean): string {
  if (!original) {
    const window = actualPDayPrecheck(source);
    expect(window.split(' INTO single_day,same_day ')).toHaveLength(2);
    return window.replace(' INTO single_day,same_day ', ' ').trim().replace(/;$/u, '');
  }
  const start = E4_P_DAY_ORACLE_SQL.indexOf('WITH source AS MATERIALIZED (');
  const end = E4_P_DAY_ORACLE_SQL.indexOf('\nIF (SELECT coalesce(sum(');
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const window = E4_P_DAY_ORACLE_SQL.slice(start, end);
  expect(window.split(' INTO result ')).toHaveLength(2);
  return window.replace(' INTO result ', ' ').trim().replace(/;$/u, '');
}

// §12.31: one predeclared batch, not retries or a cross-order average.
const E4_P_DAY_PROTOCOL_ID = 'E4-PDAY-PAIRED-6-V1';
const E4_P_DAY_PAIR_ORDERS = ['AB', 'BA', 'BA', 'AB', 'AB', 'BA'] as const;
type PDayOrder = (typeof E4_P_DAY_PAIR_ORDERS)[number];
type PDaySample = {
  pairIndex: number;
  order: PDayOrder;
  units: number;
  sources: number;
  completeJsonMatches: boolean;
  oldMs: number;
  candidateMs: number;
};

function validateFixedPDaySample(sample: PDaySample, pairIndex: number) {
  if (
    !Number.isInteger(pairIndex) ||
    pairIndex < 0 ||
    pairIndex >= E4_P_DAY_PAIR_ORDERS.length ||
    sample.pairIndex !== pairIndex ||
    sample.order !== E4_P_DAY_PAIR_ORDERS[pairIndex] ||
    sample.units !== 8000 ||
    sample.sources !== 40000 ||
    sample.completeJsonMatches !== true ||
    !Number.isFinite(sample.oldMs) ||
    !Number.isFinite(sample.candidateMs) ||
    sample.oldMs <= 0 ||
    sample.candidateMs <= 0
  )
    throw new Error('E4 P-Day fixed sample protocol mismatch');
  const relativeDelta = (sample.candidateMs - sample.oldMs) / sample.oldMs;
  if (!Number.isFinite(relativeDelta)) throw new Error('E4 P-Day relative delta is not finite');
  return {
    ...sample,
    protocolId: E4_P_DAY_PROTOCOL_ID,
    metric: 'query-promise-wall' as const,
    relativeDelta,
  };
}

function summarizeFixedPDaySamples(samples: readonly PDaySample[]) {
  if (samples.length !== E4_P_DAY_PAIR_ORDERS.length)
    throw new Error('E4 P-Day batch must contain exactly six fixed pairs');
  const validated = samples.map((sample, index) => validateFixedPDaySample(sample, index));
  const median = (order: PDayOrder) => {
    const values = validated
      .filter((sample) => sample.order === order)
      .map((sample) => sample.relativeDelta)
      .sort((a, b) => a - b);
    if (values.length !== 3) throw new Error('E4 P-Day order must contain exactly three pairs');
    return values[1];
  };
  const orderMedianRelativeDelta = { AB: median('AB'), BA: median('BA') };
  return {
    protocolId: E4_P_DAY_PROTOCOL_ID,
    metric: 'query-promise-wall' as const,
    samples: validated,
    orderMedianRelativeDelta,
    verdict:
      orderMedianRelativeDelta.AB < 0 && orderMedianRelativeDelta.BA < 0
        ? ('pass' as const)
        : ('fail' as const),
  };
}

function assertFixedPDayPerformance(summary: ReturnType<typeof summarizeFixedPDaySamples>) {
  expect(summary.orderMedianRelativeDelta.AB).toBeLessThan(0);
  expect(summary.orderMedianRelativeDelta.BA).toBeLessThan(0);
}

type PDayFailurePhase = 'oracle' | 'semantic' | 'metadata' | 'statement' | 'paired-performance';
function createPDayFailureGate() {
  let state:
    | { status: 'open' }
    | {
        status: 'failed';
        firstFailure: { phase: PDayFailurePhase | 'cleanup'; value: unknown };
        cleanupFailures: number;
      } = { status: 'open' };
  const recordFailure = (phase: PDayFailurePhase | 'cleanup', value: unknown) => {
    if (state.status === 'open')
      state = { status: 'failed', firstFailure: { phase, value }, cleanupFailures: 0 };
  };
  return {
    recordFailure,
    recordCleanupFailure(value: unknown) {
      recordFailure('cleanup', value);
      if (state.status === 'failed') state.cleanupFailures += 1;
    },
    snapshot() {
      return state.status === 'open'
        ? { ...state }
        : { ...state, firstFailure: { ...state.firstFailure } };
    },
    async run<T>(phase: PDayFailurePhase, work: () => Promise<T>): Promise<T> {
      // Explicit state also closes after throw undefined. Reject before any callback/SQL.
      if (state.status === 'failed') throw new Error('P-Day group stopped after first failure');
      try {
        return await work();
      } catch (error) {
        recordFailure(phase, error);
        throw error;
      }
    },
  };
}

async function runPDayWorkWithCleanup<T>(
  gate: ReturnType<typeof createPDayFailureGate>,
  phase: PDayFailurePhase,
  work: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  return gate.run(phase, async () => {
    let completed: { value: T } | undefined;
    let primary: { value: unknown } | undefined;
    try {
      completed = { value: await work() };
    } catch (error) {
      primary = { value: error };
      gate.recordFailure(phase, error);
    }
    // The original cleanup must still execute after the first error; do not mask it.
    try {
      await cleanup();
    } catch (error) {
      gate.recordCleanupFailure(error);
      primary ??= { value: error };
    }
    if (primary) throw primary.value;
    if (!completed) throw new Error('E4 P-Day work did not complete');
    return completed.value;
  });
}

const pDayFailureGate = createPDayFailureGate();
async function withFixedOldDayOracle<T>(
  db: PrismaClient,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  try {
    return await pDayFailureGate.run('oracle', () => runFixedOldDayOracle(db, work));
  } catch (error) {
    const state = pDayFailureGate.snapshot();
    if (state.status === 'failed' && state.cleanupFailures > 0)
      console.info(
        'E4_P_DAY_CLEANUP_FAILURE',
        JSON.stringify({
          classification: 'cleanup-failure',
          primaryPhase: state.firstFailure.phase,
          cleanupFailures: state.cleanupFailures,
          resources: 'UNKNOWN',
        }),
      );
    throw error;
  }
}

async function runFixedOldDayOracle<T>(
  db: PrismaClient,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const rollback = new Error('E4 P-Day test-only oracle rollback');
  let completed: { value: T } | undefined;
  return runPDayWorkWithCleanup(
    pDayFailureGate,
    'oracle',
    async () => {
      try {
        await db.$transaction(
          async (tx) => {
            await tx.$executeRaw`SET LOCAL statement_timeout='30s'`;
            await tx.$executeRawUnsafe(
              E4_P_DAY_ORACLE_SQL.replace(
                'CREATE FUNCTION e4_day_points(',
                'CREATE FUNCTION pg_temp.e4_day_points_1220_oracle(',
              ),
            );
            const [metadata] = await tx.$queryRaw<
              {
                temporary: boolean;
                ownerMatches: boolean;
                attributesMatch: boolean;
                invoker: boolean;
                immutable: boolean;
                nonStrict: boolean;
                unsafeParallel: boolean;
              }[]
            >`
        SELECT old.pronamespace=pg_my_temp_schema() AS temporary,
          old.proowner=live.proowner AND pg_get_userbyid(old.proowner)=current_user AS "ownerMatches",
          (old.proargtypes=live.proargtypes AND old.prorettype=live.prorettype
            AND old.proconfig IS NOT DISTINCT FROM live.proconfig
            AND old.proacl IS NOT DISTINCT FROM live.proacl) AS "attributesMatch",
          NOT live.prosecdef AND NOT old.prosecdef AS invoker,
          live.provolatile='i' AND old.provolatile='i' AS immutable,
          NOT live.proisstrict AND NOT old.proisstrict AS "nonStrict",
          live.proparallel='u' AND old.proparallel='u' AS "unsafeParallel"
        FROM pg_proc old CROSS JOIN pg_proc live
        WHERE old.oid='pg_temp.e4_day_points_1220_oracle(jsonb,integer)'::regprocedure
          AND live.oid='public.e4_day_points(jsonb,integer)'::regprocedure
      `;
            expect(metadata).toEqual({
              temporary: true,
              ownerMatches: true,
              attributesMatch: true,
              invoker: true,
              immutable: true,
              nonStrict: true,
              unsafeParallel: true,
            });
            completed = { value: await work(tx) };
            throw rollback;
          },
          { timeout: 60_000 },
        );
      } catch (error) {
        if (error !== rollback) throw error;
      }
      if (!completed) throw new Error('E4 P-Day oracle transaction did not complete');
      return completed.value;
    },
    async () => {
      const [residue] = await db.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE p.proname='e4_day_points_1220_oracle' AND n.nspname LIKE 'pg_temp_%'
    `;
      expect(residue.count).toBe(0);
    },
  );
}

// Fixed pre-optimization migration SHA: e70a5973588105bb6bad207cd0bfdc550937e7149b3e2031c0c62983144d71e6.
const E4_P_CANONICAL_ORACLE_SQL = String.raw`WITH sources AS MATERIALIZED (SELECT * FROM e4_source_rows(revision_id)),
groups AS MATERIALIZED (
  SELECT identity_id,member_id,session_id,snapshot_id,policy_id,policy_version_id,definition_hash,evaluator_version,role_code,category_code,
    min(item_id COLLATE "C") AS representative,
    sum((source_ref->>'durationSeconds')::BIGINT)::INTEGER AS seconds,
    jsonb_agg(source_ref ORDER BY astr_canonical_json(source_ref) COLLATE "C") AS refs
  FROM sources GROUP BY identity_id,member_id,session_id,snapshot_id,policy_id,policy_version_id,definition_hash,evaluator_version,role_code,category_code
), policy_bands AS MATERIALIZED (
  SELECT p.id,role->>'attendanceRoleCode' AS role_code,category->>'timeCategoryCode' AS category_code,band,ordinal
  FROM "ContributionPolicyVersion" p
  CROSS JOIN LATERAL jsonb_array_elements(p."definitionJson"->'roleRules') role
  CROSS JOIN LATERAL jsonb_array_elements(role->'categoryRules') category
  CROSS JOIN LATERAL jsonb_array_elements(category->'durationBands') WITH ORDINALITY b(band,ordinal)
  WHERE p.id IN (SELECT DISTINCT policy_version_id FROM groups)
), selected AS (
  SELECT g.*,coalesce(chosen.band,p."definitionJson"->'defaultResult') AS result,
    astr_canonical_json(jsonb_build_object('participationIdentityId',g.identity_id,'sessionId',g.session_id,
      'mode','policy','policyId',g.policy_id,'policyVersionId',g.policy_version_id,'definitionHash',g.definition_hash,
      'evaluatorVersion',g.evaluator_version,'attendanceRoleCode',g.role_code,'timeCategoryCode',g.category_code)) AS unit
  FROM groups g JOIN "ContributionPolicyVersion" p ON p.id=g.policy_version_id
  LEFT JOIN LATERAL (
    SELECT b.band FROM policy_bands b WHERE b.id=g.policy_version_id AND b.role_code=g.role_code AND b.category_code=g.category_code
      AND ((b.band->>'maxSecondsInclusive') IS NULL OR (b.band->>'maxSecondsInclusive')::BIGINT >= g.seconds)
    ORDER BY b.ordinal LIMIT 1
  ) chosen ON TRUE
), documents AS (
  SELECT unit, jsonb_build_object('participationIdentityId',identity_id,'memberId',member_id,'sessionId',session_id,'ruleSnapshotId',snapshot_id,
    'selectionItemId',representative,'mode','policy','policyId',policy_id,'policyVersionId',policy_version_id,'definitionHash',definition_hash,
    'evaluatorVersion',evaluator_version,'attendanceRoleCode',role_code,'timeCategoryCode',category_code,
    'evaluationUnitKey',e4_envelope_hash(jsonb_build_object('unit',unit)),'durationSeconds',seconds,'sourceRefsJson',refs,
    'sourceFingerprint',e4_envelope_hash(jsonb_build_object('domain',(SELECT "sourceKindCode" FROM "ActivitySettlementContributionRevision" WHERE id=revision_id),'sources',refs)),
    'calculatedPoints',result->>'recognizedPoints','recognizedPoints',result->>'recognizedPoints','explanationCode',result->>'explanationCode',
    'beijingDayPointsJson',e4_day_points(refs,((result->>'recognizedPoints')::NUMERIC*100)::INTEGER)) AS document
  FROM selected
)
SELECT unit,document || jsonb_build_object('evaluationHash',e4_envelope_hash(document)) FROM documents`;
// Fixed abc aggregate before P-Root; never regenerated from the candidate.
const E4_P_ROOT_ORACLE_SQL = String.raw`  WITH documents AS MATERIALIZED (
    SELECT e.*,astr_canonical_json(jsonb_build_object('participationIdentityId',e."participationIdentityId",'sessionId',e."sessionId",
      'mode',e.mode,'policyId',e."policyId",'policyVersionId',e."policyVersionId",'definitionHash',e."definitionHash",
      'evaluatorVersion',e."evaluatorVersion",'attendanceRoleCode',e."attendanceRoleCode",'timeCategoryCode',e."timeCategoryCode")) AS unit
    FROM "ParticipantContributionEvaluation" e WHERE e."contributionRevisionId"=root.id
  ) SELECT count(*),coalesce(sum("recognizedPoints"),0),
    e4_envelope_hash(jsonb_build_object('domain',root."sourceKindCode",'sources',coalesce(jsonb_agg(
      jsonb_build_object('evaluationUnitKey',"evaluationUnitKey",'sourceFingerprint',"sourceFingerprint") ORDER BY unit COLLATE "C"),'[]'::JSONB))),
    e4_envelope_hash(jsonb_build_object('evaluations',coalesce(jsonb_agg("evaluationHash" ORDER BY unit COLLATE "C"),'[]'::JSONB)))
    INTO counts,total,sources_hash,evaluations_hash FROM documents;`;
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
// This file is read as data, never imported: importing an E2E spec would register its lifecycle.
async function assertFixedE4Oracle(db: PrismaClient, revisionId: string, expectedCount?: number) {
  const root = await db.activitySettlementContributionRevision.findUniqueOrThrow({
    where: { id: revisionId },
  });
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

// E4_TERMINAL_OFFLINE_BEGIN
describe('E4 terminal expected source offline', () => {
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
    expect(terminalHash(restoreTerminalMigrationOpening(local))).toBe(
      '7682abceaaf185b1b54beaffdd1ecddc1fe30745193059cce3da5aeb3518282a',
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
      expect(() => restoreTerminalMigrationOpening(invalid)).toThrow();
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

  it('keeps the complete failed inner query while adapting only its SELECT interface and approved exact field/NULL checks', () => {
    const query = terminalBagSelect();
    expect(query.startsWith('SELECT * FROM (\nWITH old AS MATERIALIZED')).toBe(true);
    expect(query.endsWith('\n) AS e4_terminal_bag')).toBe(true);
    expect(query.split('$1::text')).toHaveLength(
      E4_TERMINAL_BAG_OPENING_SQL.split('$1::text').length,
    );
    expect(query.split('EXCEPT ALL')).toHaveLength(
      E4_TERMINAL_BAG_OPENING_SQL.split('EXCEPT ALL').length,
    );
    expect(query).toContain('jsonb_agg(field ORDER BY field COLLATE "C")');
    expect(query).toContain('$2::jsonb');
    expect(query).toContain('public.e4_expected_evaluations(NULL::text)');
    expect(query).toContain('pg_temp.e4_expected_evaluations_1234_opening(NULL::text)');
  });
  it('pins all 21 independent document names and refuses missing, extra or same-count wrong names', () => {
    expect(E4_TERMINAL_DOCUMENT_KEYS).toHaveLength(21);
    expect(terminalDocumentKeys([...E4_TERMINAL_DOCUMENT_KEYS])).toEqual(E4_TERMINAL_DOCUMENT_KEYS);
    for (const changed of [
      E4_TERMINAL_DOCUMENT_KEYS.slice(1),
      [...E4_TERMINAL_DOCUMENT_KEYS, 'unexpected'],
      [...E4_TERMINAL_DOCUMENT_KEYS.slice(1), 'unexpected'],
      [...E4_TERMINAL_DOCUMENT_KEYS].reverse(),
    ])
      expect(() => terminalDocumentKeys(changed)).toThrow('document keys differ');
  });
  it('reproduces the WITH row-interface refusal and parses the adapted rows along the untouched native query implementation', async () => {
    const client = new S13ReadClient(S13_LOCAL_DB);
    const request = jest
      .fn<Promise<string>, [string, number?]>()
      .mockResolvedValue('1|1|1|0|0|t|0');
    Reflect.set(client, 'request', request);
    await expect(
      client.query(E4_TERMINAL_BAG_OPENING_SQL, ['synthetic-root'], 1000),
    ).rejects.toThrow('S13 command returned unexpected data');
    const row = {
      oldCount: 1,
      candidateCount: 1,
      storedCount: 1,
      differences: 0,
      storedDifferences: 0,
      completeFields: true,
      nullRows: 0,
      oldNullRows: 0,
    };
    request.mockResolvedValue(JSON.stringify([row]));
    await expect(
      client.query(
        terminalBagSelect(),
        ['synthetic-root', JSON.stringify(E4_TERMINAL_DOCUMENT_KEYS)],
        1000,
      ),
    ).resolves.toEqual({ rows: [row] });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][0]).toContain('WITH old AS MATERIALIZED');
    expect(request.mock.calls[1][0]).toMatch(/^SELECT coalesce\(json_agg\(s13_row\)/u);
    expect(request.mock.calls[1][0]).toContain('SELECT * FROM (\nWITH old AS MATERIALIZED');
    expect(request.mock.calls[1][1]).toBe(1000);
    request.mockResolvedValue('{"notRows":true}');
    await expect(
      client.query(
        terminalBagSelect(),
        ['synthetic-root', JSON.stringify(E4_TERMINAL_DOCUMENT_KEYS)],
        1000,
      ),
    ).rejects.toThrow('S13 read envelope missing');
  });

  it('uses the declared independent frozen constant rather than the subject', () => {
    expect(terminalFrozenExpected().definition + '\n').toBe(E4_TERMINAL_EXPECTED_OPENING_SQL);
  });
});
// E4_TERMINAL_REFS_BODY_OFFLINE_BEGIN
const e4D1EvidenceModules = async () => {
  const [fs, os, path] = await Promise.all([
    import('node:fs'),
    import('node:os'),
    import('node:path'),
  ]);
  return { fs, os, path };
};
describe('E4 terminal source projection offline', () => {
  it('restores both complete current test openings and the unchanged native driver', () => {
    for (const kind of ['migration', 'scale'] as const) {
      const source = readFileSync(
        resolve(__dirname, 'activity-os-r5-e4-contribution-settlement-' + kind + '.e2e-spec.ts'),
        'utf8',
      );
      expect(terminalRefsTestOpening(source, kind)).not.toBe(source);
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
    expect(publicFrame.bodyEligibility).toEqual({
      producerMatches: 1,
      consumerMatches: 1,
      producer: { actualRows: 8000, loops: 1, tempRead: 0, tempWritten: 10 },
      consumer: { actualRows: 8000, loops: 1, tempRead: 10, tempWritten: 0 },
      checks: {
        producerExactlyOne: true,
        consumerExactlyOne: true,
        producerRows: true,
        consumerRows: true,
        producerLoops: true,
        consumerLoops: true,
        temporaryWritten: true,
        eligible: true,
      },
      rejected: [],
    });
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
  it('projects a bounded nested recognition graph without names, aliases or raw plan fields', () => {
    const input = terminalBodyBinding(terminalActualSource());
    const value = frame();
    const consumer = value[0].Plan.Plans[1];
    Reflect.set(value[0].Plan.Plans, 1, {
      'Node Type': 'Nested Loop',
      'Actual Rows': 8000,
      'Actual Loops': 1,
      'Plan Width': 160,
      'Temp Read Blocks': 0,
      'Temp Written Blocks': 0,
      Alias: 'synthetic-private-parent',
      Plans: [consumer],
    });
    const projection = terminalBodyPlan(value, input, true);
    expect(projection.bodyEligibility.checks.eligible).toBe(true);
    expect(projection.bodyRecognition).toMatchObject({
      nodeCount: 4,
      nodeTypeCounts: { Result: 2, 'Nested Loop': 1, 'CTE Scan': 1, OTHER: 0 },
      nodes: [
        {
          ordinal: 0,
          parentOrdinal: null,
          nodeType: 'Result',
          role: 'root',
          ctePresent: false,
          subplanPresent: false,
        },
        {
          ordinal: 1,
          parentOrdinal: 0,
          nodeType: 'Result',
          role: 'producer',
          subplanPresent: true,
          subplanTargetExact: true,
          subplanTargetPrefix: true,
        },
        {
          ordinal: 2,
          parentOrdinal: 0,
          nodeType: 'Nested Loop',
          role: 'node',
        },
        {
          ordinal: 3,
          parentOrdinal: 2,
          nodeType: 'CTE Scan',
          role: 'consumer',
          ctePresent: true,
          cteTargetExact: true,
          cteTargetPrefix: true,
        },
      ],
    });
    expect(JSON.stringify(projection.bodyRecognition)).not.toMatch(
      /documents|synthetic-private|Alias|Output|Filter|Schema/u,
    );
  });
  it('keeps the recognition node-type allowlist exactly aligned with the capture schema', async () => {
    const capture = await import('../helpers/e4-d1-result-capture');
    expect(capture.E4_D1_BODY_RECOGNITION_NODE_TYPES).toEqual([...E4_BODY_NODE_TYPES, 'OTHER']);
  });
  it('rejects a target-prefix CTE name through the original body eligibility only', () => {
    const value = frame();
    Reflect.set(value[0].Plan.Plans[1], 'CTE Name', 'documents_shadow');
    let thrown: unknown;
    try {
      terminalBodyPlan(value, terminalBodyBinding(terminalActualSource()), true);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TerminalBodyEligibilityError);
    if (!(thrown instanceof TerminalBodyEligibilityError))
      throw new Error('fixed eligibility diagnostic unavailable');
    expect(thrown.diagnostic).toMatchObject({
      producerMatches: 1,
      consumerMatches: 0,
      checks: { eligible: false, consumerExactlyOne: false },
    });
    expect(thrown.recognition).toMatchObject({
      nodeCount: 3,
      nodes: [
        expect.anything(),
        expect.anything(),
        {
          nodeType: 'CTE Scan',
          role: 'consumer',
          ctePresent: true,
          cteTargetExact: false,
          cteTargetPrefix: true,
        },
      ],
    });
    expect(JSON.stringify(thrown.recognition)).not.toContain('documents_shadow');
  });
  it('records an unknown node type as OTHER without expanding body eligibility', () => {
    const value = frame();
    Reflect.set(value[0].Plan, 'Plans', [
      ...value[0].Plan.Plans,
      {
        'Node Type': 'synthetic-private-node',
        Alias: 'synthetic-private-alias',
        Filter: 'synthetic-private-filter',
      },
    ]);
    const projection = terminalBodyPlan(value, terminalBodyBinding(terminalActualSource()), true);
    expect(projection.bodyEligibility.checks.eligible).toBe(true);
    expect(projection.bodyRecognition).toMatchObject({
      nodeCount: 4,
      nodeTypeCounts: { Result: 2, 'CTE Scan': 1, OTHER: 1 },
      nodes: [
        expect.anything(),
        expect.anything(),
        expect.anything(),
        {
          nodeType: 'OTHER',
          role: 'node',
          ctePresent: false,
          subplanPresent: false,
        },
      ],
    });
    expect(JSON.stringify(projection.bodyRecognition)).not.toMatch(
      /synthetic-private|Alias|Filter/u,
    );
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
    {
      name: 'missing producer',
      mutate: (value: ReturnType<typeof frame>) => value[0].Plan.Plans.shift(),
      producerMatches: 0,
      consumerMatches: 1,
      rejected: ['PRODUCER_MATCH_COUNT', 'PRODUCER_ROWS', 'PRODUCER_LOOPS', 'TEMP_WRITTEN'],
    },
    {
      name: 'duplicate producer',
      mutate: (value: ReturnType<typeof frame>) =>
        value[0].Plan.Plans.push({ ...value[0].Plan.Plans[0] }),
      producerMatches: 2,
      consumerMatches: 1,
      rejected: ['PRODUCER_MATCH_COUNT', 'PRODUCER_ROWS', 'PRODUCER_LOOPS', 'TEMP_WRITTEN'],
    },
    {
      name: 'missing consumer',
      mutate: (value: ReturnType<typeof frame>) => value[0].Plan.Plans.pop(),
      producerMatches: 1,
      consumerMatches: 0,
      rejected: ['CONSUMER_MATCH_COUNT', 'CONSUMER_ROWS', 'CONSUMER_LOOPS'],
    },
    {
      name: 'duplicate consumer',
      mutate: (value: ReturnType<typeof frame>) =>
        value[0].Plan.Plans.push({ ...value[0].Plan.Plans[1] }),
      producerMatches: 1,
      consumerMatches: 2,
      rejected: ['CONSUMER_MATCH_COUNT', 'CONSUMER_ROWS', 'CONSUMER_LOOPS'],
    },
    {
      name: 'producer rows',
      mutate: (value: ReturnType<typeof frame>) => (value[0].Plan.Plans[0]['Actual Rows'] = 7999),
      producerMatches: 1,
      consumerMatches: 1,
      rejected: ['PRODUCER_ROWS'],
    },
    {
      name: 'consumer rows',
      mutate: (value: ReturnType<typeof frame>) => (value[0].Plan.Plans[1]['Actual Rows'] = 7999),
      producerMatches: 1,
      consumerMatches: 1,
      rejected: ['CONSUMER_ROWS'],
    },
    {
      name: 'producer loops',
      mutate: (value: ReturnType<typeof frame>) => (value[0].Plan.Plans[0]['Actual Loops'] = 2),
      producerMatches: 1,
      consumerMatches: 1,
      rejected: ['PRODUCER_LOOPS'],
    },
    {
      name: 'consumer loops',
      mutate: (value: ReturnType<typeof frame>) => (value[0].Plan.Plans[1]['Actual Loops'] = 2),
      producerMatches: 1,
      consumerMatches: 1,
      rejected: ['CONSUMER_LOOPS'],
    },
    {
      name: 'temporary write',
      mutate: (value: ReturnType<typeof frame>) => {
        value[0].Plan.Plans[0]['Temp Written Blocks'] = 0;
        value[0].Plan.Plans[1]['Temp Written Blocks'] = 0;
      },
      producerMatches: 1,
      consumerMatches: 1,
      rejected: ['TEMP_WRITTEN'],
    },
  ] as const)(
    'publishes every fixed documents eligibility rejection branch for %s',
    ({ mutate, producerMatches, consumerMatches, rejected }) => {
      const value = frame();
      mutate(value);
      let thrown: unknown;
      try {
        terminalBodyPlan(value, terminalBodyBinding(terminalActualSource()), true);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TerminalBodyEligibilityError);
      if (!(thrown instanceof TerminalBodyEligibilityError))
        throw new Error('fixed eligibility diagnostic unavailable');
      expect(thrown.diagnostic).toMatchObject({
        producerMatches,
        consumerMatches,
        checks: { eligible: false },
        rejected,
      });
      expect(JSON.stringify(thrown.diagnostic)).not.toMatch(
        /Node Type|Subplan Name|CTE Name|Output|Filter|Alias|private/iu,
      );
      expect(thrown.recognition.nodeCount).toBeGreaterThan(0);
      expect(JSON.stringify(thrown.recognition)).not.toMatch(
        /documents|Node Type|Subplan Name|CTE Name|Output|Filter|Alias|private/iu,
      );
    },
  );
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
describe('E4 terminal body diagnostic offline', () => {
  const root = (): E4RetainedRoot => ({
    id: 'private-synthetic-root',
    synthetic: true,
    chain: true,
    identities: 2000,
    allocations: 10000,
    slices: 50000,
    total: '1000.00',
  });
  it('requires a unique complete synthetic submitted root, never a latest or first row', () => {
    expect(terminalRetainedRoot([root()])).toBe('private-synthetic-root');
    expect(() => terminalRetainedRoot([])).toThrow();
    expect(() => terminalRetainedRoot([root(), root()])).toThrow();
  });
  it.each(['id', 'synthetic', 'chain', 'identities', 'allocations', 'slices', 'total'] as const)(
    'refuses missing or mismatched %s synthetic retained proof',
    (key) => {
      const absent = root();
      Reflect.deleteProperty(absent, key);
      expect(() => terminalRetainedRoot([absent])).toThrow();
      const forged = root();
      Reflect.set(
        forged,
        key,
        typeof forged[key] === 'boolean' ? false : typeof forged[key] === 'number' ? 1 : '',
      );
      expect(() => terminalRetainedRoot([forged])).toThrow();
    },
  );
  it('keeps the exact top-level group outside installer/app hooks and CI selection', () => {
    const source = readFileSync(__filename, 'utf8');
    const from = source.indexOf('// E4_TERMINAL_RETAINED_DIAGNOSTIC_BEGIN\n');
    const to = source.indexOf('// E4_TERMINAL_RETAINED_DIAGNOSTIC_END\n', from);
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const block = source.slice(from, to);
    expect(block).toContain("describe('E4 terminal expected retained function-body diagnostic'");
    expect(block).toContain("process.env.SRVF_E4_W98 === '1' ? it : it.skip");
    expect(block).toContain('await acquireScratchDatabaseLease(terminalRemaining(deadline))');
    for (const forbidden of [
      'installE4ValidationDatabase(',
      'createE4Fixture(',
      'resetDb(',
      '.dropDatabase(',
      '.createDatabase(',
      'migrate',
      'SET ROLE',
      'FORCE',
    ])
      expect(block).not.toContain(forbidden);
    expect(to).toBeLessThan(source.indexOf("describe('E4 migration dedicated lease envelope'"));
  });
  it('wraps the full SELECT interface with three complete bidirectional bags and fixed keys', () => {
    const body = terminalBodyBinding(terminalActualSource()).body;
    const sql = terminalRetainedBag(body);
    expect(
      sql.startsWith('SELECT * FROM (\nWITH direct(unit_canonical,evaluation) AS MATERIALIZED (\n'),
    ).toBe(true);
    expect(sql).toContain(body);
    expect(sql.match(/EXCEPT ALL/gu)).toHaveLength(6);
    expect(sql).toContain('jsonb_object_keys(evaluation)');
    expect(sql).toContain('$2::jsonb');
    expect(sql).toContain('e4_evaluation_document(e)');
    expect(sql).toContain('c.refs AS "references"');
    expect(() => terminalRetainedBag(body + ' ')).toThrow();
  });
  it('keeps both public return names outside the complete pinned direct function body', () => {
    const body = terminalBodyBinding(terminalActualSource()).body;
    const sql = terminalRetainedBag(body);
    expect(terminalExpectedDefinition(terminalActualSource()).definition).toContain(
      'RETURNS TABLE(unit_canonical TEXT,evaluation JSONB)',
    );
    expect(terminalRetainedBagColumns(sql)).toBe(sql);
    expect(sql.match(/WITH direct\(unit_canonical,evaluation\) AS MATERIALIZED \(/gu)).toHaveLength(
      1,
    );
    const beginning = 'SELECT * FROM (\nWITH direct(unit_canonical,evaluation) AS MATERIALIZED (\n';
    expect(sql.slice(beginning.length, beginning.length + body.length)).toBe(body);
  });
  it.each([
    'direct',
    'direct(unit_canonical)',
    'direct(evaluation)',
    'direct(evaluation,unit_canonical)',
    'direct(unit_canonical,evaluation,extra)',
  ])('refuses the new direct output declaration %s', (declaration) => {
    const sql = terminalRetainedBag(terminalBodyBinding(terminalActualSource()).body);
    const invalid = sql.replace('direct(unit_canonical,evaluation)', declaration);
    expect(() => terminalRetainedBagColumns(invalid)).toThrow(
      'Retained direct bag result names differ',
    );
  });
});
describe('E4 terminal body diagnostic offline', () => {
  const identity: TerminalIdentity = {
    db: S13_LOCAL_DB,
    pid: 17,
    session: 'synthetic',
    principal: 'synthetic',
  };
  it('publishes only closed failure categories, never an arbitrary exception', () => {
    expect(terminalRetainedFailure(new Error('Body documents eligibility missing'))).toBe(
      'ELIGIBILITY',
    );
    expect(terminalRetainedFailure(new Error('private SQL or fixture payload'))).toBe('UNKNOWN');
    expect(terminalRetainedFailure(undefined)).toBe('UNKNOWN');
  });
  const current = (): E4RetainedPublic => ({
    source: terminalExpectedDefinition(terminalActualSource()).body,
    scope: 'public',
    schema: 'public',
    pid: 17,
    body: E4_TERMINAL_NEW_BODY_MD5,
    bytes: E4_TERMINAL_NEW_BODY_BYTES,
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
    temporary: false,
  });
  it('pins the complete public source and all attributes before temporary DDL', () => {
    const { source, ...expected } = current();
    expect(terminalRetainedPublic([current()], identity)).toEqual(expected);
    expect(() => terminalRetainedPublic([], identity)).toThrow();
    expect(() => terminalRetainedPublic([current(), current()], identity)).toThrow();
    expect(() => terminalRetainedPublic([current()], { ...identity, pid: 18 })).toThrow();
    expect(source).toBe(terminalExpectedDefinition(terminalActualSource()).body);
  });
  it('does not backfill an unknown exit with a later zero or incomplete guard', () => {
    const catalog = terminalRetainedPublic([current()], identity);
    const guard = { source: 'synthetic', body: 'synthetic' } as E4RetainedGuard;
    expect(() =>
      terminalRetainedCleanupProof([catalog], catalog, [{ count: 0 }], guard, guard),
    ).not.toThrow();
    expect(() =>
      terminalRetainedCleanupProof([catalog], undefined, [{ count: 0 }], guard, guard),
    ).toThrow();
    expect(() =>
      terminalRetainedCleanupProof(
        [{ ...catalog, body: 'changed' }],
        catalog,
        [{ count: 0 }],
        guard,
        guard,
      ),
    ).toThrow();
    expect(() => terminalRetainedCleanupProof([catalog], catalog, [], guard, guard)).toThrow();
    expect(() =>
      terminalRetainedCleanupProof([catalog], catalog, [{ count: 1 }], guard, guard),
    ).toThrow();
    expect(() =>
      terminalRetainedCleanupProof([catalog], catalog, [{ count: 0 }], guard, undefined),
    ).toThrow();
    expect(() =>
      terminalRetainedCleanupProof(
        [catalog],
        catalog,
        [{ count: 0 }],
        { ...guard, body: 'changed' },
        guard,
      ),
    ).toThrow();
  });
  it.each([
    'source',
    'scope',
    'schema',
    'pid',
    'body',
    'bytes',
    'ownerMatches',
    'owner',
    'acl',
    'language',
    'volatility',
    'strict',
    'invoker',
    'parallel',
    'cost',
    'rows',
    'config',
    'args',
    'result',
    'defaults',
    'defaultExpression',
    'temporary',
  ] as const)('refuses missing or forged initial %s', (key) => {
    const absent = current();
    Reflect.deleteProperty(absent, key);
    expect(() => terminalRetainedPublic([absent], identity)).toThrow();
    const forged = current();
    Reflect.set(
      forged,
      key,
      typeof forged[key] === 'boolean' ? !forged[key] : typeof forged[key] === 'number' ? -1 : '',
    );
    expect(() => terminalRetainedPublic([forged], identity)).toThrow();
  });
});
describe('E4 terminal body diagnostic offline', () => {
  const rootId = 'private-complete-proof-root';
  const snapshot = { readonly: true, repeatable: true };
  // Independent fixed fixtures, not seeded from the validator's own expected values.
  const facts: { step: E4RetainedProofStep; values: E4RetainedProofRow }[] = [
    {
      step: 'old-current',
      values: { oldCount: 8000, currentCount: 8000, leftDifferences: 0, rightDifferences: 0 },
    },
    {
      step: 'body-current',
      values: { directCount: 8000, currentCount: 8000, leftDifferences: 0, rightDifferences: 0 },
    },
    {
      step: 'current-stored',
      values: { currentCount: 8000, storedCount: 8000, leftDifferences: 0, rightDifferences: 0 },
    },
    {
      step: 'document-hashes',
      values: { storedCount: 8000, completeKeys: true, evaluationHashes: true },
    },
    { step: 'source-hashes', values: { storedCount: 8000, sourceHashes: true, references: 50000 } },
    {
      step: 'root-hashes',
      values: {
        rootUnits: 8000,
        rootReferences: 50000,
        rootTotal: true,
        rootSourceHash: true,
        rootEvaluationHash: true,
      },
    },
  ];
  const body = () => terminalBodyBinding(terminalActualSource()).body;
  const fullTruth = {
    oldCount: 8000,
    currentCount: 8000,
    storedCount: 8000,
    directCount: 8000,
    oldDifferences: 0,
    bodyDifferences: 0,
    storedDifferences: 0,
    completeKeys: true,
    evaluationHashes: true,
    sourceHashes: true,
    references: 50000,
    rootTotal: true,
    rootSourceHash: true,
    rootEvaluationHash: true,
  };
  it('runs exactly six full statements in fixed order and strips every private root', async () => {
    const calls: { step: E4RetainedProofStep; values: string[] }[] = [];
    const frames: { outcome: 'PASS' | 'REJECTED'; frame: E4RetainedProofFrame }[] = [];
    const result = await terminalRetainedRunProofs(
      body(),
      rootId,
      snapshot,
      async (proof, values) => {
        const index = calls.length;
        calls.push({ step: proof.step, values });
        return { rows: [{ rootId, ...facts[index].values }] };
      },
      (outcome, frame) => frames.push({ outcome, frame }),
    );
    expect(calls.map((call) => call.step)).toEqual([
      'old-current',
      'body-current',
      'current-stored',
      'document-hashes',
      'source-hashes',
      'root-hashes',
    ]);
    for (const call of calls)
      expect(call.values).toEqual(
        call.step === 'document-hashes'
          ? [rootId, JSON.stringify(E4_TERMINAL_DOCUMENT_KEYS)]
          : [rootId],
      );
    expect(frames).toHaveLength(6);
    for (let index = 0; index < 6; index++) {
      expect(frames[index]).toEqual({
        outcome: 'PASS',
        frame: {
          step: facts[index].step,
          durationMs: expect.any(Number),
          values: facts[index].values,
        },
      });
    }
    expect(JSON.stringify(frames)).not.toMatch(/private|rootId|SQL|sourceRefsJson/u);
    expect(result).toEqual(fullTruth);
    expect(terminalRetainedProofTruth(facts)).toEqual(fullTruth);
  });
  it('keeps the 40,000 D4 associations distinct from 50,000 full source references', () => {
    expect(E4_RETAINED_ROOT_SQL).toContain('t."bucketCount"=8000 AND t."sourceCount"=40000');
    expect(
      terminalRetainedRoot([
        {
          id: 'private-complete-proof-root',
          synthetic: true,
          chain: true,
          identities: 2000,
          allocations: 10000,
          slices: 50000,
          total: '1000.00',
        },
      ]),
    ).toBe(rootId);
    expect(terminalRetainedProofExpected('source-hashes')).toEqual({
      storedCount: 8000,
      sourceHashes: true,
      references: 50000,
    });
    expect(terminalRetainedProofExpected('root-hashes')).toMatchObject({
      rootUnits: 8000,
      rootReferences: 50000,
    });
  });
  it.each([40000, 49999, 50001])(
    'rejects %i instead of the required 50,000 source references',
    (references) => {
      const source = facts.find((item) => item.step === 'source-hashes')!.values;
      const root = facts.find((item) => item.step === 'root-hashes')!.values;
      expect(() =>
        terminalRetainedProofResult('source-hashes', [{ rootId, ...source, references }], rootId),
      ).toThrow('Retained complete bag, key, hash or root proof differs');
      expect(() =>
        terminalRetainedProofResult(
          'root-hashes',
          [{ rootId, ...root, rootReferences: references }],
          rootId,
        ),
      ).toThrow('Retained complete bag, key, hash or root proof differs');
    },
  );
  it('publishes only a whitelist-safe rejected source proof frame', async () => {
    const calls: E4RetainedProofStep[] = [];
    const emitted: { outcome: 'PASS' | 'REJECTED'; frame: E4RetainedProofFrame }[] = [];
    await expect(
      terminalRetainedRunProofs(
        body(),
        rootId,
        snapshot,
        async (proof) => {
          calls.push(proof.step);
          const values = facts.find((item) => item.step === proof.step)!.values;
          return {
            rows: [
              {
                rootId,
                ...values,
                ...(proof.step === 'source-hashes' ? { references: 40000 } : {}),
              },
            ],
          };
        },
        (outcome, frame) => emitted.push({ outcome, frame }),
      ),
    ).rejects.toThrow('Retained complete bag, key, hash or root proof differs');
    expect(calls).toEqual(E4_RETAINED_PROOF_STEPS.slice(0, 5));
    expect(emitted.filter((entry) => entry.outcome === 'PASS')).toHaveLength(4);
    expect(emitted.filter((entry) => entry.outcome === 'REJECTED')).toEqual([
      {
        outcome: 'REJECTED',
        frame: {
          step: 'source-hashes',
          durationMs: expect.any(Number),
          values: { storedCount: 8000, sourceHashes: true, references: 40000 },
        },
      },
    ]);
    expect(JSON.stringify(emitted)).not.toMatch(/private|rootId|sourceRefsJson|SQL/u);
  });
  it('does not publish a rejected frame when the whitelist is not closed', async () => {
    const emitted: { outcome: 'PASS' | 'REJECTED'; frame: E4RetainedProofFrame }[] = [];
    await expect(
      terminalRetainedRunProofs(
        body(),
        rootId,
        snapshot,
        async (proof) => {
          const values = facts.find((item) => item.step === proof.step)!.values;
          return {
            rows: [
              {
                rootId,
                ...values,
                ...(proof.step === 'source-hashes'
                  ? { rejectedSourcePayload: 'not-allowlisted' }
                  : {}),
              },
            ],
          };
        },
        (outcome, frame) => emitted.push({ outcome, frame }),
      ),
    ).rejects.toThrow('Retained complete bag, key, hash or root proof differs');
    expect(emitted.filter((entry) => entry.outcome === 'PASS')).toHaveLength(4);
    expect(emitted.filter((entry) => entry.outcome === 'REJECTED')).toEqual([]);
    expect(JSON.stringify(emitted)).not.toContain('not-allowlisted');
  });
  it.each([0, 1, 2])('uses a complete two-way EXCEPT ALL bag in step %i', (index) => {
    const sql = terminalRetainedProofs(body())[index].sql;
    expect(sql.startsWith('SELECT * FROM (\nWITH ')).toBe(true);
    expect(sql.match(/EXCEPT ALL/gu)).toHaveLength(2);
    if (index === 0) {
      expect(sql).toContain('SELECT * FROM old EXCEPT ALL SELECT * FROM current');
      expect(sql).toContain('SELECT * FROM current EXCEPT ALL SELECT * FROM old');
      expect(sql).toContain('pg_temp.e4_expected_evaluations_1234_opening($1::text)');
    } else if (index === 1) {
      expect(sql).toContain('SELECT * FROM direct EXCEPT ALL SELECT * FROM current');
      expect(sql).toContain('SELECT * FROM current EXCEPT ALL SELECT * FROM direct');
      const prefix = 'SELECT * FROM (\nWITH direct(unit_canonical,evaluation) AS MATERIALIZED (\n';
      expect(sql.slice(prefix.length, prefix.length + body().length)).toBe(body());
    } else {
      expect(sql).toContain(
        'SELECT evaluation FROM current EXCEPT ALL SELECT evaluation FROM stored',
      );
      expect(sql).toContain(
        'SELECT evaluation FROM stored EXCEPT ALL SELECT evaluation FROM current',
      );
      expect(sql).toContain('SELECT evaluation FROM public.e4_expected_evaluations($1::text)');
      expect(sql).toContain('public.e4_evaluation_document(e)');
    }
  });
  it('checks all 21 keys and recomputes every evaluation hash only after full bags', () => {
    const proof = terminalRetainedProofs(body())[3];
    expect(proof.step).toBe('document-hashes');
    expect(E4_TERMINAL_DOCUMENT_KEYS).toEqual([
      'attendanceRoleCode',
      'beijingDayPointsJson',
      'calculatedPoints',
      'definitionHash',
      'durationSeconds',
      'evaluationHash',
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
      'sourceRefsJson',
      'timeCategoryCode',
    ]);
    expect(proof.sql).toContain('jsonb_object_keys(evaluation)');
    expect(proof.sql).toContain('jsonb_agg(field ORDER BY field COLLATE "C")');
    expect(proof.sql).toContain(')=$2::jsonb');
    expect(proof.sql).toContain(
      "evaluation->>'evaluationHash'=public.e4_envelope_hash(evaluation-'evaluationHash')",
    );
    expect(proof.sql).toContain('FROM stored');
    expect(proof.sql).not.toContain('e4_expected_evaluations');
  });
  it('recomputes all complete source arrays rather than recycling compared fingerprints', () => {
    const proof = terminalRetainedProofs(body())[4];
    expect(proof.step).toBe('source-hashes');
    expect(proof.sql).toContain(
      "evaluation->>'sourceFingerprint'=public.e4_envelope_hash(jsonb_build_object(",
    );
    expect(proof.sql).toContain("'domain','time_revision','sources',evaluation->'sourceRefsJson'");
    expect(proof.sql).toContain("sum(jsonb_array_length(evaluation->'sourceRefsJson'))");
    expect(proof.sql).not.toContain('e4_expected_evaluations');
  });
  it('rebuilds full unit and root envelopes with C sorting and exact total', () => {
    const sql = terminalRetainedProofs(body())[5].sql;
    expect(sql).toContain('public.astr_canonical_json(jsonb_build_object(');
    for (const key of [
      'participationIdentityId',
      'sessionId',
      'mode',
      'policyId',
      'policyVersionId',
      'definitionHash',
      'evaluatorVersion',
      'attendanceRoleCode',
      'timeCategoryCode',
    ])
      expect(sql).toContain("'" + key + "'");
    expect(sql.match(/ORDER BY unit_canonical COLLATE "C"/gu)).toHaveLength(2);
    expect(sql).toContain("'domain','time_revision','sources'");
    expect(sql).toContain("jsonb_build_object('evaluationUnitKey',evaluation->'evaluationUnitKey'");
    expect(sql).toContain("'sourceFingerprint',evaluation->'sourceFingerprint'");
    expect(sql).toContain("jsonb_build_object('evaluations'");
    expect(sql).toContain("jsonb_agg(evaluation->'evaluationHash'");
    expect(sql).toContain('c.total=1000.00 AND c.total=r."recognizedPointsTotal"');
    expect(sql).toContain('c.source_hash=r."sourceSetHash"');
    expect(sql).toContain('c.evaluation_hash=r."evaluationSetHash"');
    expect(sql).toContain('r.id=$1::text');
  });
  it.each([
    'missing',
    'extra',
    'reordered',
    'sample',
    'distinct',
    'hash-only',
    'body-slice',
  ] as const)(
    'refuses the %s queue instead of changing the approved evidence method',
    (variant) => {
      const input = body();
      const proofs = terminalRetainedProofs(input);
      if (variant === 'missing') proofs.pop();
      if (variant === 'extra') proofs.push({ ...proofs[0] });
      if (variant === 'reordered') [proofs[0], proofs[1]] = [proofs[1], proofs[0]];
      if (variant === 'sample') proofs[4].sql += ' LIMIT 1';
      if (variant === 'distinct') proofs[0].sql = proofs[0].sql.replaceAll('EXCEPT ALL', 'EXCEPT');
      if (variant === 'hash-only')
        proofs[2].sql = proofs[2].sql.replaceAll(
          'SELECT evaluation',
          "SELECT evaluation->>'evaluationHash'",
        );
      if (variant === 'body-slice')
        proofs[1].sql = proofs[1].sql.replace(input, 'SELECT NULL,NULL');
      expect(() => terminalRetainedProofQueuePlan(proofs, input)).toThrow(
        'fixed proof queue differs',
      );
    },
  );
  it.each(E4_RETAINED_PROOF_STEPS)('does not execute any step after %s fails', async (step) => {
    const calls: E4RetainedProofStep[] = [];
    const published: unknown[] = [];
    await expect(
      terminalRetainedRunProofs(
        body(),
        rootId,
        snapshot,
        async (proof) => {
          calls.push(proof.step);
          if (proof.step === step) throw new Error('synthetic fail-closed query');
          return { rows: [{ rootId, ...facts[calls.length - 1].values }] };
        },
        (_outcome, value) => published.push(value),
      ),
    ).rejects.toThrow('synthetic fail-closed query');
    expect(calls).toEqual(
      E4_RETAINED_PROOF_STEPS.slice(0, E4_RETAINED_PROOF_STEPS.indexOf(step) + 1),
    );
    expect(published).toHaveLength(calls.length - 1);
  });
  it.each(E4_RETAINED_PROOF_STEPS)('rejects empty, duplicated or wrong-root %s results', (step) => {
    const values = facts.find((item) => item.step === step)!.values;
    expect(() => terminalRetainedProofResult(step, [], rootId)).toThrow();
    expect(() =>
      terminalRetainedProofResult(
        step,
        [
          { rootId, ...values },
          { rootId, ...values },
        ],
        rootId,
      ),
    ).toThrow();
    expect(() =>
      terminalRetainedProofResult(step, [{ rootId: 'wrong-private-root', ...values }], rootId),
    ).toThrow();
    expect(() => terminalRetainedProofResult(step, [{ rootId, ...values }], '')).toThrow();
  });
  it.each(
    facts.flatMap(({ step, values }) => Object.keys(values).map((key) => ({ step, key, values }))),
  )('refuses missing or forged $step.$key proof', ({ step, key, values }) => {
    const absent = { rootId, ...values };
    Reflect.deleteProperty(absent, key);
    expect(() => terminalRetainedProofResult(step, [absent], rootId)).toThrow();
    const forged = { rootId, ...values };
    Reflect.set(
      forged,
      key,
      typeof values[key] === 'boolean' ? false : values[key] === 0 ? 1 : 7999,
    );
    expect(() => terminalRetainedProofResult(step, [forged], rootId)).toThrow();
    expect(() =>
      terminalRetainedProofResult(step, [{ rootId, ...values, extra: true }], rootId),
    ).toThrow();
  });
  it.each(E4_RETAINED_PROOF_STEPS)(
    'refuses missing %s complete truth, not default true',
    (step) => {
      expect(() =>
        terminalRetainedProofTruth(facts.filter((item) => item.step !== step)),
      ).toThrow();
      const forged = facts.map((item) => ({ ...item, values: { ...item.values } }));
      const index = forged.findIndex((item) => item.step === step);
      Reflect.deleteProperty(forged[index].values, Object.keys(forged[index].values)[0]);
      expect(() => terminalRetainedProofTruth(forged)).toThrow();
    },
  );
  it('requires actual repeatable-read and READ ONLY in the same transaction as the full plan', () => {
    expect(E4_RETAINED_RR_BEGIN).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(E4_RETAINED_SNAPSHOT_SQL).toContain("current_setting('transaction_read_only')='on'");
    expect(E4_RETAINED_SNAPSHOT_SQL).toContain(
      "current_setting('transaction_isolation')='repeatable read'",
    );
    expect(terminalRetainedSnapshot([snapshot])).toEqual(snapshot);
    const source = readFileSync(__filename, 'utf8');
    const from = source.indexOf("        phase = 'complete-proof-snapshot';");
    const to = source.indexOf('        completed = true;', from);
    const block = source.slice(from, to);
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    expect(block.match(/await begin\(true\)/gu)).toHaveLength(1);
    expect(block).toContain('await terminalRetainedRunProofs(');
    expect(block).toContain('snapshot,');
    expect(block).toContain('E4_RETAINED_CURRENT_BODY_PLAN');
    expect(block.match(/await rollback\(\)/gu)).toHaveLength(1);
    expect(block.indexOf('await rollback()')).toBeGreaterThan(block.indexOf('terminalBodyPlan('));
  });
  it.each(['readonly', 'repeatable'] as const)(
    'blocks the queue when actual %s is false or missing',
    async (key) => {
      const absent = { ...snapshot };
      Reflect.deleteProperty(absent, key);
      expect(() => terminalRetainedSnapshot([absent])).toThrow();
      const forged = { ...snapshot, [key]: false };
      const query = jest.fn();
      await expect(
        terminalRetainedRunProofs(body(), rootId, forged, query, jest.fn()),
      ).rejects.toThrow('actual repeatable-read READ ONLY missing');
      expect(query).not.toHaveBeenCalled();
      expect(() => terminalRetainedSnapshot([])).toThrow();
      expect(() => terminalRetainedSnapshot([snapshot, snapshot])).toThrow();
      const extra = { ...snapshot, extra: true };
      expect(() => terminalRetainedSnapshot([extra])).toThrow();
    },
  );
});
describe('E4 terminal D1 result capture offline', () => {
  const capture = () => import('../helpers/e4-d1-result-capture');
  const e4D1Scope = E4_D1_SCOPE;
  const e4D1CaptureFailedPhases = [
    'entry',
    'lease',
    'observer',
    'plan-connect',
    'source-catalog',
    'temporary-old-install',
    'null-body-calibration',
    'complete-proof-snapshot',
    'complete-proof-old-current',
    'complete-proof-body-current',
    'complete-proof-current-stored',
    'complete-proof-document-hashes',
    'complete-proof-source-hashes',
    'complete-proof-root-hashes',
    'complete-current-body-plan',
    'temporary-old-cleanup',
    'plan-close',
    'owner-release',
    'partial-owner-release',
    'final-metadata',
    'observer-close',
  ] as const;
  const e4D1CaptureProofSteps = [
    'old-current',
    'body-current',
    'current-stored',
    'document-hashes',
    'source-hashes',
    'root-hashes',
  ] as const;
  const e4D1BodyEligibilityRejections = [
    'PRODUCER_MATCH_COUNT',
    'CONSUMER_MATCH_COUNT',
    'PRODUCER_ROWS',
    'CONSUMER_ROWS',
    'PRODUCER_LOOPS',
    'CONSUMER_LOOPS',
    'TEMP_WRITTEN',
  ] as const;
  const terminalKeys = [
    'completed',
    'failedPhase',
    'failureCode',
    'temporary',
    'planClosed',
    'observerClosed',
    'pending',
    'idle',
    'settingsRestored',
    'publicUnchanged',
    'releaseKnown',
    'deadlinePassed',
    'before',
    'after',
    'nullCalibration',
    'fullPlan',
    'proofs',
  ] as const;
  const e4D1BodyRecognition = (
    helper: Awaited<ReturnType<typeof capture>>,
  ): NonNullable<E4D1CaptureTerminalState['fullPlan']['bodyRecognition']> => {
    const nodeTypeCounts = Object.fromEntries(
      helper.E4_D1_BODY_RECOGNITION_NODE_TYPES.map((nodeType) => [nodeType, 0]),
    ) as Record<(typeof helper.E4_D1_BODY_RECOGNITION_NODE_TYPES)[number], number>;
    nodeTypeCounts.Result = 2;
    nodeTypeCounts['CTE Scan'] = 1;
    return {
      nodeCount: 3,
      nodeTypeCounts,
      nodes: [
        {
          ordinal: 0,
          parentOrdinal: null,
          nodeType: 'Result',
          role: 'root',
          ctePresent: false,
          cteTargetExact: false,
          cteTargetPrefix: false,
          subplanPresent: false,
          subplanTargetExact: false,
          subplanTargetPrefix: false,
        },
        {
          ordinal: 1,
          parentOrdinal: 0,
          nodeType: 'Result',
          role: 'producer',
          ctePresent: false,
          cteTargetExact: false,
          cteTargetPrefix: false,
          subplanPresent: true,
          subplanTargetExact: true,
          subplanTargetPrefix: true,
        },
        {
          ordinal: 2,
          parentOrdinal: 0,
          nodeType: 'CTE Scan',
          role: 'consumer',
          ctePresent: true,
          cteTargetExact: true,
          cteTargetPrefix: true,
          subplanPresent: false,
          subplanTargetExact: false,
          subplanTargetPrefix: false,
        },
      ],
    };
  };
  const terminal = async (): Promise<E4D1CaptureTerminalState> => {
    const helper = await capture();
    const before = {
      databases: 1,
      clients: 0,
      ownerBackends: 1,
      leaseLocks: 1,
      leaseOwnerVisible: true,
      observerVisible: true,
      planVisible: false,
      exactScope: true,
      samePrincipal: true,
      sameServer: true,
    };
    const after = {
      ...before,
      ownerBackends: 0,
      leaseLocks: 0,
      leaseOwnerVisible: false,
    };
    return {
      completed: true,
      failedPhase: null,
      failureCode: null,
      temporary: 'ABSENT' as const,
      planClosed: true,
      observerClosed: true,
      pending: 0,
      idle: true,
      settingsRestored: true,
      publicUnchanged: true,
      releaseKnown: true,
      deadlinePassed: false,
      before,
      after,
      nullCalibration: { observed: true, eligibility: false, fullCoverageRejected: true },
      fullPlan: {
        observed: true,
        eligibility: true,
        nodeCount: 3,
        bodyEligibility: {
          producerMatches: 1,
          consumerMatches: 1,
          producer: { actualRows: 8000, loops: 1, tempRead: 0, tempWritten: 10 },
          consumer: { actualRows: 8000, loops: 1, tempRead: 10, tempWritten: 0 },
          checks: {
            producerExactlyOne: true,
            consumerExactlyOne: true,
            producerRows: true,
            consumerRows: true,
            producerLoops: true,
            consumerLoops: true,
            temporaryWritten: true,
            eligible: true,
          },
          rejected: [],
        },
        bodyRecognition: e4D1BodyRecognition(helper),
      },
      proofs: helper.E4_D1_PROOF_STEPS.map((step) => ({
        outcome: 'PASS' as const,
        step,
        durationMs: 1.234,
        values: { ...helper.E4_D1_PROOF_EXPECTED[step] },
      })),
    };
  };
  const jestPass = async (): Promise<{
    success: boolean;
    numTotalTests: number;
    numPassedTests: number;
    numFailedTests: number;
    numPendingTests: number;
    numTodoTests: number;
    numTotalTestSuites: number;
    numPassedTestSuites: number;
    numFailedTestSuites: number;
    testResults: {
      failureMessage: string | null;
      assertionResults: { fullName: string; status: string }[];
    }[];
  }> => {
    const helper = await capture();
    return {
      success: true,
      numTotalTests: 564,
      numPassedTests: 1,
      numFailedTests: 0,
      numPendingTests: 563,
      numTodoTests: 0,
      numTotalTestSuites: 1,
      numPassedTestSuites: 1,
      numFailedTestSuites: 0,
      testResults: [
        {
          failureMessage: null,
          assertionResults: [{ fullName: helper.E4_D1_JEST_FULL_NAME, status: 'passed' }],
        },
      ],
    };
  };
  const jestFailure = async () => {
    const raw = await jestPass();
    raw.success = false;
    raw.numPassedTests = 0;
    raw.numFailedTests = 1;
    raw.numPassedTestSuites = 0;
    raw.numFailedTestSuites = 1;
    raw.testResults[0].assertionResults[0].status = 'failed';
    return raw;
  };
  const streams = {
    stdout: { bytes: 0, exceeded: false },
    stderr: { bytes: 0, exceeded: false },
  };
  type E4D1SafeDiagnosticView = {
    failedPhase: string | null;
    failureCode: string | null;
    proofs: {
      step: string;
      observed: boolean;
      outcome: string | null;
      values: Record<string, number | boolean> | null;
    }[];
    cleanup: {
      temporary: string;
      planClosed: boolean;
      pendingClear: boolean;
      deadlinePassed: boolean;
    };
    bodyEligibility?: {
      producerMatches: number;
      consumerMatches: number;
      producer: { actualRows: number; loops: number; tempRead: number; tempWritten: number } | null;
      consumer: { actualRows: number; loops: number; tempRead: number; tempWritten: number } | null;
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
      rejected: string[];
    } | null;
    bodyRecognition?: {
      nodeCount: number;
      nodeTypeCounts: Record<string, number>;
      nodes: {
        ordinal: number;
        parentOrdinal: number | null;
        nodeType: string;
        role: string;
        ctePresent: boolean;
        cteTargetExact: boolean;
        cteTargetPrefix: boolean;
        subplanPresent: boolean;
        subplanTargetExact: boolean;
        subplanTargetPrefix: boolean;
      }[];
    } | null;
  };
  const expectOfflineScenarioDiagnostic = (
    scenario: string,
    diagnostic: E4D1SafeDiagnosticView | null | undefined,
  ) => {
    if (
      scenario !== 'success' &&
      scenario !== 'assertion-failure' &&
      scenario !== 'proof-missing' &&
      scenario !== 'eligibility-all-branches' &&
      scenario !== 'cleanup-unknown-terminal'
    )
      return;
    if (diagnostic === null || diagnostic === undefined)
      throw new Error('fixed safe diagnostic unavailable');
    if (scenario === 'success') {
      expect(diagnostic).toMatchObject({
        failedPhase: null,
        failureCode: null,
        cleanup: { temporary: 'ABSENT', pendingClear: true, deadlinePassed: false },
        bodyEligibility: { checks: { eligible: true }, rejected: [] },
        bodyRecognition: {
          nodeCount: 3,
          nodeTypeCounts: { Result: 2, 'CTE Scan': 1, OTHER: 0 },
        },
      });
      return;
    }
    if (scenario === 'cleanup-unknown-terminal') {
      expect(diagnostic).toMatchObject({
        failedPhase: 'plan-close',
        failureCode: null,
        cleanup: { planClosed: false },
      });
      return;
    }
    if (scenario === 'eligibility-all-branches') {
      expect(diagnostic).toMatchObject({
        failedPhase: 'complete-current-body-plan',
        failureCode: 'ELIGIBILITY',
        bodyRecognition: {
          nodeCount: 3,
          nodeTypeCounts: { Result: 2, 'CTE Scan': 1, OTHER: 0 },
        },
      });
      expect(diagnostic.bodyEligibility).toEqual({
        producerMatches: 2,
        consumerMatches: 2,
        producer: null,
        consumer: null,
        checks: {
          producerExactlyOne: false,
          consumerExactlyOne: false,
          producerRows: false,
          consumerRows: false,
          producerLoops: false,
          consumerLoops: false,
          temporaryWritten: false,
          eligible: false,
        },
        rejected: [...e4D1BodyEligibilityRejections],
      });
      return;
    }
    expect(diagnostic).toMatchObject({
      failedPhase: 'complete-proof-source-hashes',
      failureCode: 'FULL_TRUTH',
    });
    if (scenario === 'assertion-failure') {
      expect(diagnostic.proofs.find((proof) => proof.step === 'source-hashes')).toMatchObject({
        step: 'source-hashes',
        observed: true,
        values: { references: 49999 },
      });
      return;
    }
    expect(diagnostic.proofs.find((proof) => proof.step === 'source-hashes')).toEqual({
      step: 'source-hashes',
      observed: false,
      outcome: null,
      values: null,
    });
    expect(diagnostic.proofs.find((proof) => proof.step === 'root-hashes')).toEqual({
      step: 'root-hashes',
      observed: false,
      outcome: null,
      values: null,
    });
  };
  it('atomically binds the complete production-shaped safe result to this scope and token', async () => {
    const helper = await capture();
    const session = helper.createE4D1CaptureSession();
    try {
      const expected = helper.writeE4D1SafeResult(session.context, await terminal());
      expect(helper.readE4D1SafeResult(session.context)).toEqual(expected);
      expect(expected.terminalStatus).toBe('PASS');
      expect(Object.keys(expected.terminal).sort()).toEqual([...terminalKeys].sort());
      expect(expected.terminal.proofs).toEqual(
        helper.E4_D1_PROOF_STEPS.map((step) => ({
          outcome: 'PASS',
          step,
          durationMs: 1.234,
          values: helper.E4_D1_PROOF_EXPECTED[step],
        })),
      );
      expect(() =>
        helper.openE4D1CaptureContext({
          SRVF_E4_D1_CAPTURE_DIR: session.context.captureDir,
          SRVF_E4_D1_RESULT_FILE: session.context.resultFile,
          SRVF_E4_D1_CAPTURE_TOKEN: '0'.repeat(48),
          SRVF_TEST_RUN_SCOPE: helper.E4_D1_SCOPE,
        }),
      ).toThrow();
    } finally {
      session.dispose();
    }
  });
  it('treats OTHER as a safe recognition class instead of a new terminal rejection', async () => {
    const helper = await capture();
    const safeTerminal = await terminal();
    const recognition = safeTerminal.fullPlan.bodyRecognition;
    if (recognition === null) throw new Error('fixed body recognition unavailable');
    recognition.nodeCount = 4;
    recognition.nodeTypeCounts.OTHER = 1;
    recognition.nodes.push({
      ordinal: 3,
      parentOrdinal: 0,
      nodeType: 'OTHER',
      role: 'node',
      ctePresent: false,
      cteTargetExact: false,
      cteTargetPrefix: false,
      subplanPresent: false,
      subplanTargetExact: false,
      subplanTargetPrefix: false,
    });
    safeTerminal.fullPlan.nodeCount = 4;
    expect(helper.e4D1TerminalStatus(safeTerminal)).toBe('PASS');
  });
  it.each(terminalKeys)('rejects an omitted production terminal field: %s', async (key) => {
    const helper = await capture();
    const session = helper.createE4D1CaptureSession();
    try {
      const invalid = await terminal();
      Reflect.deleteProperty(invalid, key);
      expect(() => helper.writeE4D1SafeResult(session.context, invalid)).toThrow();
    } finally {
      session.dispose();
    }
  });
  it.each([
    ['negative', -0.001],
    ['not-a-number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['above-maximum', 30_000.001],
    ['more-than-three-decimal-places', 1.2345],
    ['near-thousandth-overprecision', 1.2340000001],
  ])('rejects %s proof duration milliseconds', async (_name, durationMs) => {
    const helper = await capture();
    const session = helper.createE4D1CaptureSession();
    try {
      const invalid = await terminal();
      invalid.proofs[0].durationMs = durationMs;
      expect(() => helper.writeE4D1SafeResult(session.context, invalid)).toThrow();
    } finally {
      session.dispose();
    }
  });
  it('refuses unknown proof keys instead of widening the persisted whitelist', async () => {
    const helper = await capture();
    const session = helper.createE4D1CaptureSession();
    try {
      const unknownTerminal = await terminal();
      Reflect.set(unknownTerminal, 'unexpected', true);
      expect(() => helper.writeE4D1SafeResult(session.context, unknownTerminal)).toThrow();
      const invalid = await terminal();
      Reflect.set(invalid.proofs[0].values, 'unexpected', true);
      expect(() => helper.writeE4D1SafeResult(session.context, invalid)).toThrow();
      const result = helper.createE4D1SafeResult(session.context, await terminal());
      Reflect.set(result.terminal.proofs[0].values, 'unexpected', true);
      const summary = helper.summarizeE4D1Capture({
        process: { exitCode: 0, signaled: false, spawnError: false },
        streams,
        jest: await jestPass(),
        capture: result,
        context: session.context,
      });
      expect(summary).toMatchObject({ status: 'UNKNOWN', reason: 'CAPTURE_INVALID' });
      expect(JSON.stringify(summary)).not.toContain('unexpected');
    } finally {
      session.dispose();
    }
  });
  it('marks missing finally evidence, interrupted execution and capped streams UNKNOWN', async () => {
    const helper = await capture();
    const session = helper.createE4D1CaptureSession();
    try {
      const complete = helper.createE4D1SafeResult(session.context, await terminal());
      const missing = helper.summarizeE4D1Capture({
        process: { exitCode: 0, signaled: false, spawnError: false },
        streams,
        jest: await jestPass(),
        capture: undefined,
        context: session.context,
        captureMissing: true,
      });
      expect(missing).toMatchObject({ status: 'UNKNOWN', reason: 'CAPTURE_MISSING' });
      const interrupted = helper.summarizeE4D1Capture({
        process: { exitCode: null, signaled: true, spawnError: false },
        streams,
        jest: await jestPass(),
        capture: complete,
        context: session.context,
      });
      expect(interrupted).toMatchObject({ status: 'UNKNOWN', reason: 'PROCESS_INTERRUPTED' });
      const capped = helper.summarizeE4D1Capture({
        process: { exitCode: 0, signaled: false, spawnError: false },
        streams: { ...streams, stderr: { bytes: 65537, exceeded: true } },
        jest: await jestPass(),
        capture: complete,
        context: session.context,
      });
      expect(capped).toMatchObject({ status: 'UNKNOWN', reason: 'STREAM_LIMIT' });
    } finally {
      session.dispose();
    }
  });
  it('does not let a passing Jest JSON override a nonzero process exit or token mismatch', async () => {
    const helper = await capture();
    const session = helper.createE4D1CaptureSession();
    try {
      const complete = helper.createE4D1SafeResult(session.context, await terminal());
      const exitMismatch = helper.summarizeE4D1Capture({
        process: { exitCode: 1, signaled: false, spawnError: false },
        streams,
        jest: await jestPass(),
        capture: complete,
        context: session.context,
      });
      expect(exitMismatch).toMatchObject({ status: 'UNKNOWN', reason: 'EXIT_JEST_MISMATCH' });
      const mismatched = { ...complete, token: '0'.repeat(48) };
      const tokenMismatch = helper.summarizeE4D1Capture({
        process: { exitCode: 0, signaled: false, spawnError: false },
        streams,
        jest: await jestPass(),
        capture: mismatched,
        context: session.context,
      });
      expect(tokenMismatch).toMatchObject({ status: 'UNKNOWN', reason: 'CAPTURE_INVALID' });
    } finally {
      session.dispose();
    }
  });
  it('withholds Jest failure text and only reports a fixed UNKNOWN reason', async () => {
    const helper = await capture();
    const session = helper.createE4D1CaptureSession();
    try {
      const complete = helper.createE4D1SafeResult(session.context, await terminal());
      const raw = await jestPass();
      raw.success = false;
      raw.numPassedTests = 0;
      raw.numFailedTests = 1;
      raw.numPassedTestSuites = 0;
      raw.numFailedTestSuites = 1;
      raw.testResults[0].failureMessage = 'sensitive-value-must-not-leave-private-jest-json';
      raw.testResults[0].assertionResults[0].status = 'failed';
      const summary = helper.summarizeE4D1Capture({
        process: { exitCode: 1, signaled: false, spawnError: false },
        streams,
        jest: raw,
        capture: complete,
        context: session.context,
      });
      expect(summary).toMatchObject({ status: 'UNKNOWN', reason: 'JEST_PRIVATE_DIAGNOSTICS' });
      expect(JSON.stringify(summary)).not.toContain('sensitive-value');
    } finally {
      session.dispose();
    }
  });
  it('requires both complete closure and complete evidence before it can ever record PASS', async () => {
    const helper = await capture();
    const session = helper.createE4D1CaptureSession();
    try {
      const incomplete = await terminal();
      incomplete.pending = 1;
      expect(helper.createE4D1SafeResult(session.context, incomplete).terminalStatus).toBe(
        'UNKNOWN',
      );
      const cleanupUnknown = await terminal();
      cleanupUnknown.completed = false;
      cleanupUnknown.failedPhase = 'plan-close';
      cleanupUnknown.planClosed = false;
      cleanupUnknown.failureCode = null;
      expect(helper.createE4D1SafeResult(session.context, cleanupUnknown).terminalStatus).toBe(
        'UNKNOWN',
      );
      const knownFailure = await terminal();
      knownFailure.completed = false;
      knownFailure.failedPhase = 'complete-proof-source-hashes';
      knownFailure.failureCode = 'FULL_TRUTH';
      knownFailure.proofs = knownFailure.proofs.slice(0, 4);
      const failure = helper.createE4D1SafeResult(session.context, knownFailure);
      expect(failure.terminalStatus).toBe('FAIL');
      const raw = await jestPass();
      raw.success = false;
      raw.numPassedTests = 0;
      raw.numFailedTests = 1;
      raw.numPassedTestSuites = 0;
      raw.numFailedTestSuites = 1;
      raw.testResults[0].assertionResults[0].status = 'failed';
      expect(
        helper.summarizeE4D1Capture({
          process: { exitCode: 1, signaled: false, spawnError: false },
          streams,
          jest: raw,
          capture: failure,
          context: session.context,
        }),
      ).toMatchObject({ status: 'FAIL', reason: 'JEST_FAILED' });
    } finally {
      session.dispose();
    }
  });
  it('continues draining capped stdout without retaining its contents', async () => {
    const helper = await capture();
    const { PassThrough } = await import('node:stream');
    const stream = new PassThrough();
    const drained = helper.drainE4D1Stream(stream, 3);
    stream.end('abcdef');
    await expect(drained).resolves.toEqual({ bytes: 6, exceeded: true });
  });
  it('persists the existing primary and cleanup terminal combinations without hiding cleanup UNKNOWN', async () => {
    const helper = await capture();
    const cleanup = new Set([
      'plan-close',
      'owner-release',
      'partial-owner-release',
      'final-metadata',
      'observer-close',
    ]);
    for (const phase of helper.E4_D1_FAILED_PHASES) {
      const session = helper.createE4D1CaptureSession();
      try {
        const failed = await terminal();
        failed.completed = false;
        failed.failedPhase = phase;
        if (cleanup.has(phase)) {
          failed.failureCode = null;
          if (phase === 'plan-close') failed.planClosed = false;
          if (phase === 'observer-close') failed.observerClosed = false;
          if (phase === 'owner-release' || phase === 'partial-owner-release')
            failed.releaseKnown = false;
          if (phase === 'final-metadata') failed.after = 'UNKNOWN';
        } else failed.failureCode = 'FULL_TRUTH';
        const written = helper.writeE4D1SafeResult(session.context, failed);
        expect(helper.readE4D1SafeResult(session.context)).toEqual(written);
        expect(written.terminalStatus).toBe(cleanup.has(phase) ? 'UNKNOWN' : 'FAIL');
      } finally {
        session.dispose();
      }
    }
    const inverse = await terminal();
    inverse.completed = false;
    inverse.failedPhase = null;
    inverse.failureCode = 'FULL_TRUTH';
    const session = helper.createE4D1CaptureSession();
    try {
      expect(() => helper.createE4D1SafeResult(session.context, inverse)).toThrow();
    } finally {
      session.dispose();
    }
  });
  it('keeps local offline parameter tables equal to the helper enumerations', async () => {
    const helper = await capture();
    expect(e4D1CaptureFailedPhases).toEqual(helper.E4_D1_FAILED_PHASES);
    expect(e4D1CaptureProofSteps).toEqual(helper.E4_D1_PROOF_STEPS);
    expect(e4D1BodyEligibilityRejections).toEqual(helper.E4_D1_BODY_ELIGIBILITY_REJECTIONS);
  });
  it.each(e4D1CaptureFailedPhases)(
    'projects fixed first-red diagnostics for failure phase %s without upgrading it to PASS',
    async (phase) => {
      const helper = await capture();
      const session = helper.createE4D1CaptureSession();
      try {
        const failed = await terminal();
        const cleanup = new Set([
          'plan-close',
          'owner-release',
          'partial-owner-release',
          'final-metadata',
          'observer-close',
        ]);
        failed.completed = false;
        failed.failedPhase = phase;
        if (cleanup.has(phase)) {
          failed.failureCode = null;
          if (phase === 'plan-close') failed.planClosed = false;
          if (phase === 'observer-close') failed.observerClosed = false;
          if (phase === 'owner-release' || phase === 'partial-owner-release')
            failed.releaseKnown = false;
          if (phase === 'final-metadata') failed.after = 'UNKNOWN';
        } else failed.failureCode = 'FULL_TRUTH';
        const summary = helper.summarizeE4D1Capture({
          process: { exitCode: 1, signaled: false, spawnError: false },
          streams,
          jest: await jestFailure(),
          capture: helper.createE4D1SafeResult(session.context, failed),
          context: session.context,
        });
        expect(summary.schema).toBe(helper.E4_D1_CAPTURE_SUMMARY_SCHEMA);
        if (summary.schema !== helper.E4_D1_CAPTURE_SUMMARY_SCHEMA)
          throw new Error('diagnostic summary version differs');
        expect(summary.capture.diagnostic).toMatchObject({
          failedPhase: phase,
          failureCode: cleanup.has(phase) ? null : 'FULL_TRUTH',
        });
        expect(summary.status).not.toBe('PASS');
      } finally {
        session.dispose();
      }
    },
  );
  it.each(e4D1CaptureProofSteps)(
    'projects missing fixed proof %s as absent rather than a passing value',
    async (step) => {
      const helper = await capture();
      const session = helper.createE4D1CaptureSession();
      try {
        const failed = await terminal();
        failed.completed = false;
        failed.failedPhase = 'complete-proof-source-hashes';
        failed.failureCode = 'FULL_TRUTH';
        failed.proofs = failed.proofs.filter((proof) => proof.step !== step);
        const summary = helper.summarizeE4D1Capture({
          process: { exitCode: 1, signaled: false, spawnError: false },
          streams,
          jest: await jestFailure(),
          capture: helper.createE4D1SafeResult(session.context, failed),
          context: session.context,
        });
        if (summary.schema !== helper.E4_D1_CAPTURE_SUMMARY_SCHEMA)
          throw new Error('diagnostic summary version differs');
        expect(summary.capture.diagnostic?.proofs).toContainEqual({
          step,
          observed: false,
          outcome: null,
          values: null,
        });
        expect(summary.status).not.toBe('PASS');
      } finally {
        session.dispose();
      }
    },
  );
  it.each([
    ['old-current', 'leftDifferences', 1],
    ['body-current', 'leftDifferences', 1],
    ['current-stored', 'leftDifferences', 1],
    ['document-hashes', 'storedCount', 7999],
    ['source-hashes', 'references', 49999],
    ['root-hashes', 'rootReferences', 49999],
  ] as const)(
    'projects nonconforming fixed proof value for %s.%s without reporting PASS',
    async (step, key, value) => {
      const helper = await capture();
      const session = helper.createE4D1CaptureSession();
      try {
        const failed = await terminal();
        failed.completed = false;
        failed.failedPhase = 'complete-proof-source-hashes';
        failed.failureCode = 'FULL_TRUTH';
        const proof = failed.proofs.find((candidate) => candidate.step === step);
        if (!proof) throw new Error('production-shaped proof differs');
        proof.values[key] = value;
        const summary = helper.summarizeE4D1Capture({
          process: { exitCode: 1, signaled: false, spawnError: false },
          streams,
          jest: await jestFailure(),
          capture: helper.createE4D1SafeResult(session.context, failed),
          context: session.context,
        });
        if (summary.schema !== helper.E4_D1_CAPTURE_SUMMARY_SCHEMA)
          throw new Error('diagnostic summary version differs');
        const projected = summary.capture.diagnostic?.proofs.find(
          (candidate) => candidate.step === step,
        );
        expect(projected).toMatchObject({ step, observed: true, values: { [key]: value } });
        expect(summary.status).not.toBe('PASS');
        expect(JSON.stringify(summary)).not.toContain('durationMs');
      } finally {
        session.dispose();
      }
    },
  );
  const runOfflineCaptureCli = (scenario: string) =>
    new Promise<{
      exitCode: number | null;
      signaled: boolean;
      stdout: string;
      stdoutExceeded: boolean;
    }>((resolveResult) => {
      const child = spawn(
        'pnpm',
        ['exec', 'tsx', 'test/helpers/e4-d1-result-capture.ts', '--offline-scenario', scenario],
        {
          cwd: resolve(__dirname, '../..'),
          env: { ...process.env, SRVF_E4_W98: '0' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stdoutBytes = 0;
      let stdoutExceeded = false;
      let settled = false;
      const finish = (exitCode: number | null, signaled: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveResult({ exitCode, signaled, stdout, stdoutExceeded });
      };
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(null, true);
      }, 30_000);
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > 64 * 1024) {
          stdoutExceeded = true;
          stdout = '';
        } else if (!stdoutExceeded) stdout += chunk.toString();
      });
      child.stderr.resume();
      child.once('error', () => finish(null, false));
      child.once('close', (code, signal) => finish(code, signal !== null));
    });
  it.each([
    {
      scenario: 'success',
      exitCode: 0,
      summary: {
        status: 'PASS',
        reason: 'PASS',
        process: { exitCode: 0, signaled: false, interrupted: false },
        jest: { artifact: 'PARSED', valid: true },
        capture: {
          valid: true,
          terminalStatus: 'PASS',
          source: 'TERMINAL',
        },
      },
    },
    {
      scenario: 'assertion-failure',
      exitCode: 2,
      summary: {
        status: 'UNKNOWN',
        reason: 'JEST_MISSING',
        process: { exitCode: 1, signaled: false, interrupted: false },
        jest: { artifact: 'MISSING', valid: false },
        capture: {
          valid: true,
          terminalStatus: 'FAIL',
          source: 'TERMINAL',
        },
      },
    },
    {
      scenario: 'proof-missing',
      exitCode: 2,
      summary: {
        status: 'UNKNOWN',
        reason: 'JEST_MISSING',
        process: { exitCode: 1, signaled: false, interrupted: false },
        jest: { artifact: 'MISSING', valid: false },
        capture: {
          valid: true,
          terminalStatus: 'FAIL',
          source: 'TERMINAL',
        },
      },
    },
    {
      scenario: 'cleanup-unknown-terminal',
      exitCode: 2,
      summary: {
        status: 'UNKNOWN',
        reason: 'JEST_MISSING',
        process: { exitCode: 1, signaled: false, interrupted: false },
        jest: { artifact: 'MISSING', valid: false },
        capture: {
          valid: true,
          terminalStatus: 'UNKNOWN',
          source: 'TERMINAL',
        },
      },
    },
    {
      scenario: 'cleanup-unknown',
      exitCode: 2,
      summary: {
        status: 'UNKNOWN',
        reason: 'JEST_MISSING',
        process: { exitCode: 1, signaled: false, interrupted: false },
        jest: { artifact: 'MISSING', valid: false },
        capture: { valid: true, terminalStatus: 'UNKNOWN', source: 'FALLBACK' },
      },
    },
    {
      scenario: 'timeout',
      exitCode: 2,
      summary: {
        status: 'UNKNOWN',
        reason: 'CAPTURE_MISSING',
        process: { exitCode: 1, signaled: false, interrupted: false },
        jest: { artifact: 'MISSING', valid: false },
        capture: { valid: false, terminalStatus: null, source: null },
      },
    },
    {
      scenario: 'interrupted',
      exitCode: 2,
      summary: {
        status: 'UNKNOWN',
        reason: 'PROCESS_INTERRUPTED',
        process: { exitCode: null, signaled: true, interrupted: true },
        jest: { artifact: 'MISSING', valid: false },
        capture: { valid: false, terminalStatus: null, source: null },
      },
    },
    {
      scenario: 'jest-unavailable',
      exitCode: 2,
      summary: {
        status: 'UNKNOWN',
        reason: 'CAPTURE_MISSING',
        process: { exitCode: 1, signaled: false, interrupted: false },
        jest: { artifact: 'PARSED', valid: true },
        capture: { valid: false, terminalStatus: null, source: null },
      },
    },
  ])(
    'runs the real CLI/Jest capture chain safely for $scenario',
    async ({ exitCode, scenario, summary }) => {
      const result = await runOfflineCaptureCli(scenario);
      expect(result).toMatchObject({ exitCode, signaled: false, stdoutExceeded: false });
      const safe = JSON.parse(result.stdout) as {
        capture?: { diagnostic?: E4D1SafeDiagnosticView | null };
      };
      expect(safe).toMatchObject(summary);
      expectOfflineScenarioDiagnostic(scenario, safe.capture?.diagnostic);
      expect(JSON.stringify(safe)).not.toMatch(
        /synthetic assertion must remain private|synthetic missing proof must remain private|synthetic cleanup unknown must remain private|synthetic original terminal failure/iu,
      );
    },
    30_000,
  );
  const createEvidenceRoot = async () => {
    const { fs, os, path } = await e4D1EvidenceModules();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'srvf-e4-d1-evidence-test-'));
    fs.chmodSync(root, 0o700);
    return root;
  };
  const runEvidenceLauncherCli = (args: string[], evidenceRoot: string) =>
    new Promise<{
      exitCode: number | null;
      signaled: boolean;
      stdout: string;
      stdoutExceeded: boolean;
    }>((resolveResult) => {
      const child = spawn(
        'pnpm',
        ['exec', 'tsx', 'test/helpers/e4-d1-evidence-launcher.ts', ...args],
        {
          cwd: resolve(__dirname, '../..'),
          env: {
            ...process.env,
            SRVF_E4_W98: '0',
            SRVF_E4_D1_EVIDENCE_ROOT: evidenceRoot,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stdoutBytes = 0;
      let stdoutExceeded = false;
      let settled = false;
      const finish = (exitCode: number | null, signaled: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveResult({ exitCode, signaled, stdout, stdoutExceeded });
      };
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(null, true);
      }, 60_000);
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > 64 * 1024) {
          stdoutExceeded = true;
          stdout = '';
        } else if (!stdoutExceeded) stdout += chunk.toString();
      });
      child.stderr.resume();
      child.once('error', () => finish(null, false));
      child.once('close', (code, signal) => finish(code, signal !== null));
    });
  const parseEvidenceReport = (stdout: string) =>
    JSON.parse(stdout) as {
      runId: string | null;
      status: 'PASS' | 'FAIL' | 'UNKNOWN';
      reason: string;
      child: { exitCode: number | null; signaled: boolean; spawnError: boolean } | null;
      summary: {
        schema: string;
        status: 'PASS' | 'FAIL' | 'UNKNOWN';
        reason: string;
        process: { signaled: boolean };
        capture: {
          source: 'TERMINAL' | 'FALLBACK' | null;
          terminalStatus: string | null;
          diagnostic?: {
            failedPhase: string | null;
            failureCode: string | null;
            proofs: {
              step: string;
              observed: boolean;
              outcome: string | null;
              values: Record<string, number | boolean> | null;
            }[];
            cleanup: {
              temporary: string;
              planClosed: boolean;
              observerClosed: boolean;
              pendingClear: boolean;
              idle: boolean;
              settingsRestored: boolean;
              publicUnchanged: boolean;
              releaseKnown: boolean;
              deadlinePassed: boolean;
            };
          } | null;
        };
        binding: { runId: string | null; scopeHash: string; tokenHash: string | null };
      } | null;
      currentInputsMatch: boolean | null;
    };
  const readEvidenceRun = (root: string, runId: string) =>
    runEvidenceLauncherCli(['--read-run', runId, '--scope', e4D1Scope], root);
  it('persists fractional production-shaped success through an independently invoked reader when outer stdout is dropped', async () => {
    const helper = await capture();
    const { fs } = await e4D1EvidenceModules();
    const root = await createEvidenceRoot();
    try {
      const started = await runEvidenceLauncherCli(
        ['--offline-scenario', 'success', '--drop-stdout'],
        root,
      );
      expect(started).toEqual({ exitCode: 0, signaled: false, stdout: '', stdoutExceeded: false });
      const read = await runEvidenceLauncherCli(['--read-latest', '--scope', e4D1Scope], root);
      expect(read).toMatchObject({ exitCode: 0, signaled: false, stdoutExceeded: false });
      const evidence = parseEvidenceReport(read.stdout);
      expect(evidence).toMatchObject({
        status: 'PASS',
        reason: 'PASS',
        child: { exitCode: 0, signaled: false, spawnError: false },
        summary: {
          schema: helper.E4_D1_CAPTURE_SUMMARY_SCHEMA,
          status: 'PASS',
          capture: {
            source: 'TERMINAL',
            terminalStatus: 'PASS',
            diagnostic: {
              failedPhase: null,
              failureCode: null,
              cleanup: { temporary: 'ABSENT', pendingClear: true, deadlinePassed: false },
              bodyRecognition: {
                nodeCount: 3,
                nodeTypeCounts: { Result: 2, 'CTE Scan': 1, OTHER: 0 },
              },
            },
          },
          binding: { scopeHash: createHash('sha256').update(helper.E4_D1_SCOPE).digest('hex') },
        },
        currentInputsMatch: true,
      });
      expect(evidence.runId).toMatch(/^[a-f0-9]{32}$/u);
      expect(evidence.summary?.binding).toMatchObject({
        runId: evidence.runId,
        tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      expect(fs.readdirSync(root).sort()).toEqual(['latest.json', 'run-' + evidence.runId]);
      expect(JSON.stringify(evidence)).not.toMatch(
        /synthetic assertion must remain private|synthetic missing proof must remain private|synthetic cleanup unknown must remain private|synthetic original terminal failure|documents|CTE Name|Subplan Name|Alias/iu,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
  it.each([
    {
      scenario: 'assertion-failure',
      summary: {
        source: 'TERMINAL',
        terminalStatus: 'FAIL',
        signaled: false,
      },
    },
    {
      scenario: 'proof-missing',
      summary: {
        source: 'TERMINAL',
        terminalStatus: 'FAIL',
        signaled: false,
      },
    },
    {
      scenario: 'eligibility-all-branches',
      summary: {
        source: 'TERMINAL',
        terminalStatus: 'FAIL',
        signaled: false,
      },
    },
    {
      scenario: 'cleanup-unknown-terminal',
      summary: {
        source: 'TERMINAL',
        terminalStatus: 'UNKNOWN',
        signaled: false,
      },
    },
    {
      scenario: 'cleanup-unknown',
      summary: { source: 'FALLBACK', terminalStatus: 'UNKNOWN', signaled: false },
    },
    {
      scenario: 'timeout',
      summary: { source: null, terminalStatus: null, signaled: false },
    },
    {
      scenario: 'interrupted',
      summary: { source: null, terminalStatus: null, signaled: true },
    },
    {
      scenario: 'jest-unavailable',
      summary: { source: null, terminalStatus: null, signaled: false },
    },
  ] as const)(
    'persists the real offline $scenario chain without upgrading a nonzero or interrupted child to PASS',
    async ({ scenario, summary }) => {
      const { fs, path } = await e4D1EvidenceModules();
      const root = await createEvidenceRoot();
      try {
        const started = await runEvidenceLauncherCli(['--offline-scenario', scenario], root);
        expect(started).toMatchObject({ exitCode: 2, signaled: false, stdoutExceeded: false });
        const startReport = parseEvidenceReport(started.stdout);
        expect(startReport).toMatchObject({ status: 'UNKNOWN', child: { exitCode: 2 } });
        const runDirectory = path.join(root, 'run-' + startReport.runId);
        const persistedFiles = fs.readdirSync(runDirectory).sort();
        expect(persistedFiles).toEqual([
          'attestation.json',
          'exit.json',
          'final.json',
          'summary.json',
        ]);
        const persisted = persistedFiles
          .map((name) => fs.readFileSync(path.join(runDirectory, name), 'utf8'))
          .join('\n');
        expect(persisted).not.toMatch(
          /synthetic assertion must remain private|synthetic missing proof must remain private|synthetic cleanup unknown must remain private|synthetic original terminal failure|documents|CTE Name|Subplan Name|Alias/iu,
        );
        expect(persisted).not.toMatch(/"token":/u);
        const read = await runEvidenceLauncherCli(['--read-latest', '--scope', e4D1Scope], root);
        expect(read).toMatchObject({ exitCode: 2, signaled: false, stdoutExceeded: false });
        const evidence = parseEvidenceReport(read.stdout);
        const captureExpectation: Record<string, unknown> = {
          source: summary.source,
          terminalStatus: summary.terminalStatus,
        };
        expect(evidence).toMatchObject({
          status: 'UNKNOWN',
          child: { exitCode: 2, signaled: false, spawnError: false },
          summary: {
            status: 'UNKNOWN',
            process: { signaled: summary.signaled },
            capture: captureExpectation,
          },
        });
        expectOfflineScenarioDiagnostic(scenario, evidence.summary?.capture.diagnostic);
        expect(evidence.status).not.toBe('PASS');
        expect(JSON.stringify(evidence)).not.toContain('durationMs');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    90_000,
  );
  it('reads historical v1/v2/v3 summaries strictly and rejects incomplete v4', async () => {
    const helper = await capture();
    const { fs, path } = await e4D1EvidenceModules();
    const root = await createEvidenceRoot();
    const rewriteSummary = (
      runId: string,
      rewrite: (value: { schema: string; capture: Record<string, unknown> }) => void,
    ) => {
      const directory = path.join(root, 'run-' + runId);
      const summaryFile = path.join(directory, 'summary.json');
      const finalFile = path.join(directory, 'final.json');
      const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8')) as {
        schema: string;
        capture: Record<string, unknown>;
      };
      rewrite(summary);
      const text = JSON.stringify(summary);
      fs.writeFileSync(summaryFile, text, 'utf8');
      const final = JSON.parse(fs.readFileSync(finalFile, 'utf8')) as {
        summarySha256: string | null;
      };
      if (final.summarySha256 === null) throw new Error('summary hash unexpectedly absent');
      final.summarySha256 = createHash('sha256').update(text).digest('hex');
      fs.writeFileSync(finalFile, JSON.stringify(final), 'utf8');
    };
    try {
      const legacyStart = await runEvidenceLauncherCli(['--offline-scenario', 'success'], root);
      const legacyRunId = parseEvidenceReport(legacyStart.stdout).runId;
      if (legacyRunId === null) throw new Error('legacy run identifier unavailable');
      rewriteSummary(legacyRunId, (summary) => {
        summary.schema = helper.E4_D1_CAPTURE_SUMMARY_SCHEMA_V1;
        Reflect.deleteProperty(summary.capture, 'diagnostic');
      });
      const legacyRead = await readEvidenceRun(root, legacyRunId);
      expect(legacyRead).toMatchObject({ exitCode: 0, signaled: false, stdoutExceeded: false });
      const legacy = parseEvidenceReport(legacyRead.stdout);
      expect(legacy).toMatchObject({
        status: 'PASS',
        summary: {
          schema: helper.E4_D1_CAPTURE_SUMMARY_SCHEMA_V1,
          capture: { source: 'TERMINAL', terminalStatus: 'PASS' },
        },
      });
      expect(Object.hasOwn(legacy.summary!.capture, 'diagnostic')).toBe(false);

      const v2Start = await runEvidenceLauncherCli(['--offline-scenario', 'success'], root);
      const v2RunId = parseEvidenceReport(v2Start.stdout).runId;
      if (v2RunId === null) throw new Error('v2 run identifier unavailable');
      rewriteSummary(v2RunId, (summary) => {
        summary.schema = helper.E4_D1_CAPTURE_SUMMARY_SCHEMA_V2;
        const diagnostic = summary.capture.diagnostic;
        if (!diagnostic || typeof diagnostic !== 'object')
          throw new Error('v4 diagnostic unavailable');
        Reflect.deleteProperty(diagnostic, 'bodyEligibility');
        Reflect.deleteProperty(diagnostic, 'bodyRecognition');
      });
      const v2Read = await readEvidenceRun(root, v2RunId);
      expect(v2Read).toMatchObject({ exitCode: 0, signaled: false, stdoutExceeded: false });
      const v2 = parseEvidenceReport(v2Read.stdout);
      expect(v2).toMatchObject({
        status: 'PASS',
        summary: {
          schema: helper.E4_D1_CAPTURE_SUMMARY_SCHEMA_V2,
          capture: { source: 'TERMINAL', terminalStatus: 'PASS' },
        },
      });
      expect(Object.hasOwn(v2.summary!.capture.diagnostic!, 'bodyEligibility')).toBe(false);

      const v3Start = await runEvidenceLauncherCli(['--offline-scenario', 'success'], root);
      const v3RunId = parseEvidenceReport(v3Start.stdout).runId;
      if (v3RunId === null) throw new Error('v3 run identifier unavailable');
      rewriteSummary(v3RunId, (summary) => {
        summary.schema = helper.E4_D1_CAPTURE_SUMMARY_SCHEMA_V3;
        const diagnostic = summary.capture.diagnostic;
        if (!diagnostic || typeof diagnostic !== 'object')
          throw new Error('v4 diagnostic unavailable');
        Reflect.deleteProperty(diagnostic, 'bodyRecognition');
      });
      const v3Read = await readEvidenceRun(root, v3RunId);
      expect(v3Read).toMatchObject({ exitCode: 0, signaled: false, stdoutExceeded: false });
      const v3 = parseEvidenceReport(v3Read.stdout);
      expect(v3).toMatchObject({
        status: 'PASS',
        summary: {
          schema: helper.E4_D1_CAPTURE_SUMMARY_SCHEMA_V3,
          capture: { source: 'TERMINAL', terminalStatus: 'PASS' },
        },
      });
      expect(Object.hasOwn(v3.summary!.capture.diagnostic!, 'bodyRecognition')).toBe(false);

      const incompleteStart = await runEvidenceLauncherCli(['--offline-scenario', 'success'], root);
      const incompleteRunId = parseEvidenceReport(incompleteStart.stdout).runId;
      if (incompleteRunId === null) throw new Error('v4 run identifier unavailable');
      rewriteSummary(incompleteRunId, (summary) => {
        Reflect.deleteProperty(summary.capture, 'diagnostic');
      });
      const incompleteRead = await readEvidenceRun(root, incompleteRunId);
      expect(parseEvidenceReport(incompleteRead.stdout)).toMatchObject({
        status: 'UNKNOWN',
        reason: 'SUMMARY_INVALID',
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
  it('rejects wrong, missing, tampered and oversized durable records and cannot promote fallback to PASS', async () => {
    const { fs, path } = await e4D1EvidenceModules();
    const root = await createEvidenceRoot();
    const startSuccess = async () => {
      const started = await runEvidenceLauncherCli(['--offline-scenario', 'success'], root);
      expect(started).toMatchObject({ exitCode: 0, signaled: false, stdoutExceeded: false });
      const result = parseEvidenceReport(started.stdout);
      expect(result.runId).toMatch(/^[a-f0-9]{32}$/u);
      return result.runId!;
    };
    try {
      const wrong = await readEvidenceRun(root, '0'.repeat(32));
      expect(parseEvidenceReport(wrong.stdout)).toMatchObject({
        status: 'UNKNOWN',
        reason: 'RUN_NOT_FOUND',
      });

      const missingRun = await startSuccess();
      fs.unlinkSync(path.join(root, 'run-' + missingRun, 'summary.json'));
      const missing = await readEvidenceRun(root, missingRun);
      expect(parseEvidenceReport(missing.stdout)).toMatchObject({
        status: 'UNKNOWN',
        reason: 'SUMMARY_MISSING',
      });

      const tamperedRun = await startSuccess();
      const tamperedFile = path.join(root, 'run-' + tamperedRun, 'summary.json');
      const tampered = JSON.parse(fs.readFileSync(tamperedFile, 'utf8')) as {
        status: string;
        reason: string;
      };
      tampered.status = 'FAIL';
      tampered.reason = 'JEST_FAILED';
      fs.writeFileSync(tamperedFile, JSON.stringify(tampered), 'utf8');
      const tamperRead = await readEvidenceRun(root, tamperedRun);
      expect(parseEvidenceReport(tamperRead.stdout)).toMatchObject({
        status: 'UNKNOWN',
        reason: 'HASH_MISMATCH',
      });

      const oversizedRun = await startSuccess();
      fs.writeFileSync(
        path.join(root, 'run-' + oversizedRun, 'summary.json'),
        '0'.repeat(64 * 1024 + 1),
        'utf8',
      );
      const oversized = await readEvidenceRun(root, oversizedRun);
      expect(parseEvidenceReport(oversized.stdout)).toMatchObject({
        status: 'UNKNOWN',
        reason: 'FILE_OVERSIZE',
      });

      const cleanup = await runEvidenceLauncherCli(['--offline-scenario', 'cleanup-unknown'], root);
      expect(cleanup).toMatchObject({ exitCode: 2, signaled: false });
      const cleanupRun = parseEvidenceReport(cleanup.stdout).runId!;
      const finalFile = path.join(root, 'run-' + cleanupRun, 'final.json');
      const forgedFinal = JSON.parse(readFileSync(finalFile, 'utf8')) as {
        status: string;
        reason: string;
      };
      forgedFinal.status = 'PASS';
      forgedFinal.reason = 'PASS';
      fs.writeFileSync(finalFile, JSON.stringify(forgedFinal), 'utf8');
      const fallbackRead = await readEvidenceRun(root, cleanupRun);
      expect(parseEvidenceReport(fallbackRead.stdout)).toMatchObject({
        status: 'UNKNOWN',
        reason: 'FINAL_MISMATCH',
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
// E4_TERMINAL_REFS_BODY_OFFLINE_END

// E4_TERMINAL_N1_LIFECYCLE_OFFLINE_BEGIN
describe('E4 N1 admission and retained install offline', () => {
  it('keeps the historical local scope and refuses every incomplete GitHub opt-in', async () => {
    const { resolveE4ValidationScope } = await import('../helpers/e4-d1-result-capture');
    const env = {
      SRVF_E4_GITHUB_ISOLATED: '1',
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'BA7IEE/srvf-nest-api',
      GITHUB_REF: 'refs/heads/codex/activity-os-r5-e4-github-validation',
      SRVF_TEST_RUN_SCOPE: 'app_test_w98',
    };
    expect(resolveE4ValidationScope({}, false)).toBe(
      'app_test_srvf_nest_api_delivery_flow_pilot_f59fbc_w98',
    );
    expect(resolveE4ValidationScope(env, true)).toBe('app_test_w98');
    expect(() => resolveE4ValidationScope(env, false)).toThrow('scope refused');
    for (const key of Object.keys(env)) {
      if (key === 'SRVF_E4_GITHUB_ISOLATED') continue;
      expect(() => resolveE4ValidationScope({ ...env, [key]: 'wrong' }, true)).toThrow(
        'scope refused',
      );
    }
    expect(() =>
      resolveE4ValidationScope({ ...env, SRVF_E4_GITHUB_ISOLATED: 'wrong' }, true),
    ).toThrow('scope refused');
  });

  it('keeps retained installation explicitly opt-in while preserving the original lease release', async () => {
    const lifecycle = await import('../helpers/activity-contribution-policy.fixture');
    expect(lifecycle.resolveE4ValidationLifecycleMode(undefined, false)).toBe('NORMAL');
    expect(lifecycle.resolveE4ValidationLifecycleMode('', true)).toBe('NORMAL');
    expect(() => lifecycle.resolveE4ValidationLifecycleMode('install-retain', false)).toThrow(
      'dedicated local w98 scope',
    );
    expect(() => lifecycle.resolveE4ValidationLifecycleMode('unknown', true)).toThrow(
      'dedicated local w98 scope',
    );
    expect(lifecycle.resolveE4ValidationLifecycleMode('install-retain', true)).toBe(
      'INSTALL_RETAIN',
    );
    expect(lifecycle.e4ValidationLifecycleModeForInstall(false, 'install-retain', true)).toBe(
      'NORMAL',
    );
    expect(lifecycle.e4ValidationLifecycleModeForInstall(true, 'install-retain', true)).toBe(
      'INSTALL_RETAIN',
    );
    expect(lifecycle.e4ValidationLifecyclePlan('NORMAL')).toEqual({
      initialize: 'RECREATE',
      databaseFinalizer: 'DROP',
      leaseFinalizer: 'RELEASE',
    });
    expect(lifecycle.e4ValidationLifecyclePlan('INSTALL_RETAIN')).toEqual({
      initialize: 'RECREATE',
      databaseFinalizer: 'RETAIN',
      leaseFinalizer: 'RELEASE',
    });
    const fixtureSource = readFileSync(
      resolve(__dirname, '../helpers/activity-contribution-policy.fixture.ts'),
      'utf8',
    );
    expect(fixtureSource).toContain("lifecyclePlan.databaseFinalizer === 'DROP'");
    expect(fixtureSource.indexOf("lifecyclePlan.databaseFinalizer === 'DROP'")).toBeLessThan(
      fixtureSource.indexOf('lifecycle.finish();'),
    );
  });

  it('scopes the v1.1 fixture gate to retained install and emits only fixed failure diagnostics', async () => {
    const lifecycle = await import('../helpers/activity-contribution-policy.fixture');
    const scoped = {
      SRVF_E4_W98: '1',
      SRVF_E4_N1_LIFECYCLE: 'install-retain',
      ACTIVITY_WORKFLOW_READONLY: 'true',
    } as NodeJS.ProcessEnv;
    await expect(
      lifecycle.withE4N1InstallRetainFixtureGate(async () => {
        expect(scoped.ACTIVITY_V11_WORKFLOW_ENABLED).toBe('true');
        expect(scoped.ACTIVITY_WORKFLOW_READONLY).toBe('true');
        return 'fixture-only';
      }, scoped),
    ).resolves.toBe('fixture-only');
    expect(scoped.ACTIVITY_V11_WORKFLOW_ENABLED).toBeUndefined();
    expect(scoped.ACTIVITY_WORKFLOW_READONLY).toBe('true');

    const restored = {
      SRVF_E4_W98: '1',
      SRVF_E4_N1_LIFECYCLE: 'install-retain',
      ACTIVITY_V11_WORKFLOW_ENABLED: 'false',
    } as NodeJS.ProcessEnv;
    await expect(
      lifecycle.withE4N1InstallRetainFixtureGate(async () => {
        throw new Error('untrusted fixture exception detail');
      }, restored),
    ).rejects.toThrow('untrusted fixture exception detail');
    expect(restored.ACTIVITY_V11_WORKFLOW_ENABLED).toBe('false');
    await expect(
      lifecycle.withE4N1InstallRetainFixtureGate(async () => undefined, {}),
    ).rejects.toThrow('dedicated local w98 retained lifecycle');

    expect(
      lifecycle.e4N1InstallRetainFailure('MAXIMUM_SOURCE', {
        biz: { code: BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED.code },
      }),
    ).toEqual({
      phase: 'MAXIMUM_SOURCE',
      reason: 'V11_DISABLED',
      message: 'E4_N1_INSTALL_STAGE_FAILURE phase=MAXIMUM_SOURCE reason=V11_DISABLED',
    });
    const unknown = lifecycle.e4N1InstallRetainFailure(
      'SUBMIT',
      new Error('untrusted fixture exception detail'),
    );
    expect(unknown).toEqual({
      phase: 'SUBMIT',
      reason: 'UNKNOWN',
      message: 'E4_N1_INSTALL_STAGE_FAILURE phase=SUBMIT reason=UNKNOWN',
    });
    expect(unknown.message).not.toContain('untrusted fixture exception detail');
  });

  it('requires an installed N1 candidate, intact catalog and exact retained root before D1', () => {
    const migration = { count: 137, checksum: E4_TERMINAL_ACTUAL_SHA, failed: 0 };
    expect(
      terminalN1AdmissionDecision({
        resourcesReady: true,
        migration,
        catalogReady: true,
        rootReady: true,
      }),
    ).toBe('READY');
    expect(
      terminalN1AdmissionDecision({
        resourcesReady: true,
        migration: { ...migration, checksum: 'e992' },
        catalogReady: true,
        rootReady: true,
      }),
    ).toBe('INSTALL_REQUIRED');
    expect(
      terminalN1AdmissionDecision({
        resourcesReady: false,
        migration,
        catalogReady: true,
        rootReady: true,
      }),
    ).toBe('RESOURCE_BLOCKED');
    expect(
      terminalN1AdmissionDecision({
        resourcesReady: true,
        migration,
        catalogReady: false,
        rootReady: true,
      }),
    ).toBe('CATALOG_INVALID');
    expect(
      terminalN1AdmissionDecision({
        resourcesReady: true,
        migration,
        catalogReady: true,
        rootReady: false,
      }),
    ).toBe('FIXTURE_NOT_READY');
  });

  it('does not start a D1 child when admission rejects or is unknown', async () => {
    const { gateE4D1Execution } = await import('../helpers/e4-d1-evidence-launcher');
    const admission = (status: 'READY' | 'REJECTED' | 'UNKNOWN') => ({
      schema: 'srvf-e4-n1-admission/v1' as const,
      status,
      process: { exitCode: status === 'READY' ? 0 : 1, signaled: false, spawnError: false },
      streams: {
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutExceeded: false,
        stderrExceeded: false,
      },
      jest: {
        artifact: 'PARSED' as const,
        valid: true,
        success: status === 'READY',
        total: 1,
        passed: status === 'READY' ? 1 : 0,
        failed: status === 'READY' ? 0 : 1,
        pending: 0,
        todo: 0,
        totalSuites: 1,
        passedSuites: status === 'READY' ? 1 : 0,
        failedSuites: status === 'READY' ? 0 : 1,
        privateDiagnostics: false,
        targetPassed: status === 'READY',
      },
    });
    for (const status of ['REJECTED', 'UNKNOWN'] as const) {
      let starts = 0;
      const result = await gateE4D1Execution(
        async () => admission(status),
        async () => {
          starts++;
          return 'must not run';
        },
      );
      expect(result).toMatchObject({ admission: { status }, d1Started: false, value: null });
      expect(starts).toBe(0);
    }
    let starts = 0;
    const ready = await gateE4D1Execution(
      async () => admission('READY'),
      async () => {
        starts++;
        return 'started once';
      },
    );
    expect(ready).toMatchObject({ admission: { status: 'READY' }, d1Started: true });
    expect(ready.value).toBe('started once');
    expect(starts).toBe(1);
  });

  it('keeps the admission child read-only and the retained install stage separately opt-in', () => {
    const source = readFileSync(__filename, 'utf8');
    const admissionStart = source.indexOf('// E4_TERMINAL_N1_ADMISSION_BEGIN\n');
    const admissionEnd = source.indexOf('// E4_TERMINAL_N1_ADMISSION_END\n', admissionStart);
    const stageStart = source.indexOf('// E4_TERMINAL_N1_INSTALL_STAGE_BEGIN\n');
    const stageEnd = source.indexOf('// E4_TERMINAL_N1_INSTALL_STAGE_END\n', stageStart);
    expect(admissionStart).toBeGreaterThan(0);
    expect(admissionEnd).toBeGreaterThan(admissionStart);
    expect(stageStart).toBeGreaterThan(0);
    expect(stageEnd).toBeGreaterThan(stageStart);
    const admissionBlock = source.slice(admissionStart, admissionEnd);
    const stageBlock = source.slice(stageStart, stageEnd);
    expect(admissionBlock).toContain("SRVF_E4_N1_ADMISSION === '1'");
    expect(admissionBlock).toContain('resources.plan.query(E4_RETAINED_RR_BEGIN');
    expect(E4_RETAINED_RR_BEGIN).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    for (const forbidden of [
      'installE4ValidationDatabase(',
      'createE4Fixture(',
      '.dropDatabase(',
      '.createDatabase(',
      'migrate deploy',
    ])
      expect(admissionBlock).not.toContain(forbidden);
    expect(stageBlock).toContain("SRVF_E4_N1_LIFECYCLE === 'install-retain'");
    expect(stageBlock).toContain('withE4N1InstallRetainFixtureGate');
    expect(stageBlock).toContain('createMaximumE4Source');
    expect(stageBlock).toContain("phase = 'RETAINED_ROOT'");
    expect(stageBlock).toContain('terminalRetainedRoot');
    expect(stageBlock).toContain('e4N1InstallRetainFailure');
    expect(stageBlock).not.toContain("process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true'");
  });
});
// E4_TERMINAL_N1_LIFECYCLE_OFFLINE_END

// E4_TERMINAL_OFFLINE_END

describe('E4 P-Canonical offline byte closure and independent old oracle', () => {
  it('pins the original e70 oracle and only changes the current expected-evaluation function body', () => {
    expect(createHash('sha256').update(E4_P_CANONICAL_ORACLE_SQL).digest('hex')).toBe(
      '1aaf91d632713dddaeb106ad4095ac5650aa65416841f8c865d2fd0020fa465b',
    );
    const source = booleanCollectionHistorySource();
    const expectedFunction =
      /(CREATE FUNCTION e4_expected_evaluations\(revision_id TEXT\)\nRETURNS TABLE\(unit_canonical TEXT,evaluation JSONB\)\nLANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS \$\$\n)[\s\S]*?(\n\$\$;)/gu;
    expect([...source.matchAll(expectedFunction)]).toHaveLength(1);
    // Preserve the earlier expected-function closure against its fixed pre-P-Root input.
    const aggregates = [
      ...source.matchAll(
        / {2}WITH documents AS MATERIALIZED \(\n[\s\S]*? {4}INTO counts,total,sources_hash,evaluations_hash FROM documents;/gu,
      ),
    ];
    expect(aggregates).toHaveLength(1);
    const outsideBody = restoreFixedOldDay(restoreFixedOldSet(source))
      .replace(aggregates[0][0], E4_P_ROOT_ORACLE_SQL)
      .replace(expectedFunction, '$1<EXPECTED_BODY>$2');
    expect(createHash('sha256').update(outsideBody).digest('hex')).toBe(
      'd968834bff34451180c82fda50cb0a8373bab05223f033b9eeeef3f282941de3',
    );
    const migrations = readdirSync(resolve(__dirname, '../../prisma/migrations'))
      .filter((name) => /^[0-9]{14}_/u.test(name))
      .sort();
    expect(migrations).toHaveLength(137);
    expect(migrations[136]).toBe('20261003000000_activity_contribution_settlement');
    for (const migration of migrations.slice(0, 136)) {
      const tracked = execFileSync(
        'git',
        ['show', 'HEAD:prisma/migrations/' + migration + '/migration.sql'],
        { cwd: resolve(__dirname, '../..'), encoding: 'utf8' },
      );
      expect(
        readFileSync(
          resolve(__dirname, '../../prisma/migrations', migration, 'migration.sql'),
          'utf8',
        ),
      ).toBe(tracked);
    }
  });
  it('pins the separate abc root oracle and changes no bytes outside that single aggregate', () => {
    expect(createHash('sha256').update(E4_P_ROOT_ORACLE_SQL).digest('hex')).toBe(
      'be771b78933b36e6d47e8fe81aa92bb626ac6b07423f6ae878988e85ee5af4af',
    );
    const source = booleanCollectionHistorySource();
    const aggregates = [
      ...source.matchAll(
        / {2}WITH documents AS MATERIALIZED \(\n[\s\S]*? {4}INTO counts,total,sources_hash,evaluations_hash FROM documents;/gu,
      ),
    ];
    expect(aggregates).toHaveLength(1);
    expect(
      createHash('sha256')
        .update(
          restoreFixedOldDay(restoreFixedOldSet(source)).replace(
            aggregates[0][0],
            E4_P_ROOT_ORACLE_SQL,
          ),
        )
        .digest('hex'),
    ).toBe('abc419738f2c80b1e51e2e9c2b385e0fc5f2a3fc7b5a5697aea958bf9fcea000');
    expect(aggregates[0][0]).toContain('ORDER BY unit COLLATE "C"');
    expect(aggregates[0][0]).not.toContain('e4_expected_evaluations');
  });
});

describe('E4 P-Day fixed paired acceptance offline calibration', () => {
  const samples = (deltas: readonly number[] = [-0.1, -0.1, -0.2, -0.2, -0.3, -0.3]) =>
    E4_P_DAY_PAIR_ORDERS.map((order, pairIndex) => ({
      pairIndex,
      order,
      units: 8000,
      sources: 40000,
      completeJsonMatches: true,
      oldMs: 100,
      candidateMs: 100 + 100 * deltas[pairIndex],
    }));
  it('uses the fixed AB/BA/BA/AB/AB/BA order and retains all six raw samples', () => {
    const input = samples();
    const result = summarizeFixedPDaySamples(input);
    expect(result.samples.map((sample) => sample.order)).toEqual([
      'AB',
      'BA',
      'BA',
      'AB',
      'AB',
      'BA',
    ]);
    expect(result.samples.map((sample) => sample.pairIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(result.samples.map(({ oldMs, candidateMs }) => ({ oldMs, candidateMs }))).toEqual(
      input.map(({ oldMs, candidateMs }) => ({ oldMs, candidateMs })),
    );
    expect(result.protocolId).toBe('E4-PDAY-PAIRED-6-V1');
    expect(result.metric).toBe('query-promise-wall');
  });
  it('rejects a missing pair', () => {
    expect(() => summarizeFixedPDaySamples(samples().slice(0, 5))).toThrow();
  });
  it('rejects a seventh pair instead of selecting the best six', () => {
    const input = samples();
    expect(() => summarizeFixedPDaySamples([...input, { ...input[0], pairIndex: 6 }])).toThrow();
  });
  it('rejects reordered pairs', () => {
    const input = samples();
    [input[0], input[1]] = [input[1], input[0]];
    expect(() => summarizeFixedPDaySamples(input)).toThrow();
  });
  it('rejects order drift even when pair indexes are unchanged', () => {
    const input = samples();
    input[0] = { ...input[0], order: 'BA' };
    expect(() => summarizeFixedPDaySamples(input)).toThrow();
  });
  it('rejects duplicate pair indexes', () => {
    const input = samples();
    input[1] = { ...input[1], pairIndex: 0 };
    expect(() => summarizeFixedPDaySamples(input)).toThrow();
  });
  it.each(['units', 'sources'] as const)('rejects changed %s', (field) => {
    const input = samples();
    input[0] = { ...input[0], [field]: input[0][field] - 1 };
    expect(() => summarizeFixedPDaySamples(input)).toThrow();
  });
  it('rejects incomplete JSON comparison instead of accepting performance alone', () => {
    const input = samples();
    input[0] = { ...input[0], completeJsonMatches: false };
    expect(() => summarizeFixedPDaySamples(input)).toThrow();
  });
  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['negative', -1],
    ['zero', 0],
  ] as const)('rejects %s timing in either member of a pair', (_label, value) => {
    for (const field of ['oldMs', 'candidateMs'] as const) {
      const input = samples();
      input[0] = { ...input[0], [field]: value };
      expect(() => summarizeFixedPDaySamples(input)).toThrow();
    }
  });
  it('rejects overflow in a relative delta', () => {
    const input = samples();
    input[0] = { ...input[0], oldMs: Number.MIN_VALUE, candidateMs: Number.MAX_VALUE };
    expect(() => summarizeFixedPDaySamples(input)).toThrow();
  });
  it('requires strictly negative medians in both orders', () => {
    const result = summarizeFixedPDaySamples(samples());
    expect(result.orderMedianRelativeDelta).toEqual({ AB: -0.2, BA: -0.2 });
    expect(result.verdict).toBe('pass');
    assertFixedPDayPerformance(result);
  });
  it('rejects AB gain with BA loss without cross-order averaging', () => {
    const result = summarizeFixedPDaySamples(samples([-0.9, 0.01, 0.02, -0.8, -0.7, 0.03]));
    expect(result.verdict).toBe('fail');
    expect(() => assertFixedPDayPerformance(result)).toThrow();
  });
  it('rejects BA gain with AB loss', () => {
    const result = summarizeFixedPDaySamples(samples([0.01, -0.9, -0.8, 0.02, 0.03, -0.7]));
    expect(result.verdict).toBe('fail');
    expect(() => assertFixedPDayPerformance(result)).toThrow();
  });
  it.each(['AB', 'BA'] as const)('rejects a zero median in %s', (order) => {
    const input = samples();
    for (const sample of input) if (sample.order === order) sample.candidateMs = sample.oldMs;
    const result = summarizeFixedPDaySamples(input);
    expect(result.orderMedianRelativeDelta[order]).toBe(0);
    expect(result.verdict).toBe('fail');
    expect(() => assertFixedPDayPerformance(result)).toThrow();
  });
  it('keeps an individual loser visible but accepts two negative order medians', () => {
    const result = summarizeFixedPDaySamples(samples([0.5, -0.1, -0.2, -0.2, -0.3, -0.3]));
    expect(result.samples[0].relativeDelta).toBe(0.5);
    expect(result.orderMedianRelativeDelta).toEqual({ AB: -0.2, BA: -0.2 });
    expect(result.verdict).toBe('pass');
    assertFixedPDayPerformance(result);
  });
  it('uses all three relative deltas rather than an absolute-time median', () => {
    const input = samples();
    input[0] = { ...input[0], oldMs: 1000, candidateMs: 900 };
    input[3] = { ...input[3], oldMs: 10, candidateMs: 11 };
    input[4] = { ...input[4], oldMs: 20, candidateMs: 22 };
    const result = summarizeFixedPDaySamples(input);
    expect(result.orderMedianRelativeDelta.AB).toBe(0.1);
    expect(result.verdict).toBe('fail');
  });
  it('rejects a majority of losers even with one arbitrarily large gain', () => {
    const result = summarizeFixedPDaySamples(samples([-0.99, -0.1, -0.2, 0.01, 0.02, -0.3]));
    expect(result.orderMedianRelativeDelta.AB).toBe(0.01);
    expect(result.verdict).toBe('fail');
  });
  it.each(['semantic', 'metadata', 'statement', 'paired-performance'] as const)(
    'latches a %s red and refuses later callbacks and SQL',
    async (phase) => {
      const gate = createPDayFailureGate();
      const first = new Error('synthetic first red');
      await expect(
        gate.run(phase, async () => {
          throw first;
        }),
      ).rejects.toBe(first);
      const sql = jest.fn(async () => 1);
      const callback = jest.fn(async () => sql());
      await expect(gate.run('oracle', callback)).rejects.toThrow('stopped after first failure');
      expect(callback).not.toHaveBeenCalled();
      expect(sql).not.toHaveBeenCalled();
      expect(gate.snapshot()).toEqual({
        status: 'failed',
        firstFailure: { phase, value: first },
        cleanupFailures: 0,
      });
    },
  );
  it('latches the real final median assertion outside an oracle callback', async () => {
    const gate = createPDayFailureGate();
    const failedSummary = summarizeFixedPDaySamples(samples([-0.1, 0.01, 0.02, -0.2, -0.3, 0.03]));
    await expect(
      gate.run('paired-performance', async () => assertFixedPDayPerformance(failedSummary)),
    ).rejects.toThrow();
    const nextOracle = jest.fn(async () => 1);
    await expect(gate.run('oracle', nextOracle)).rejects.toThrow('stopped after first failure');
    expect(nextOracle).not.toHaveBeenCalled();
    expect(gate.snapshot().status).toBe('failed');
  });
  it('latches throw undefined without using the error value as the state flag', async () => {
    const gate = createPDayFailureGate();
    const fail = jest.fn<Promise<void>, []>().mockRejectedValueOnce(undefined);
    let caught: { value: unknown } | undefined;
    try {
      await gate.run('semantic', fail);
    } catch (value) {
      caught = { value };
    }
    expect(caught).toEqual({ value: undefined });
    const callback = jest.fn(async () => 1);
    await expect(gate.run('oracle', callback)).rejects.toThrow('stopped after first failure');
    expect(callback).not.toHaveBeenCalled();
    expect(gate.snapshot()).toEqual({
      status: 'failed',
      firstFailure: { phase: 'semantic', value: undefined },
      cleanupFailures: 0,
    });
  });
  it('records the primary error before cleanup and still executes cleanup', async () => {
    const gate = createPDayFailureGate();
    const first = new Error('synthetic semantic red');
    const cleanup = jest.fn(async () => {
      expect(gate.snapshot()).toEqual({
        status: 'failed',
        firstFailure: { phase: 'semantic', value: first },
        cleanupFailures: 0,
      });
    });
    await expect(
      runPDayWorkWithCleanup(
        gate,
        'semantic',
        async () => {
          throw first;
        },
        cleanup,
      ),
    ).rejects.toBe(first);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
  it('keeps primary identity while separately recording a secondary cleanup failure', async () => {
    const gate = createPDayFailureGate();
    const first = new Error('synthetic primary');
    const secondary = new Error('synthetic cleanup');
    const cleanup = jest.fn(async () => {
      throw secondary;
    });
    await expect(
      runPDayWorkWithCleanup(
        gate,
        'oracle',
        async () => {
          throw first;
        },
        cleanup,
      ),
    ).rejects.toBe(first);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(gate.snapshot()).toEqual({
      status: 'failed',
      firstFailure: { phase: 'oracle', value: first },
      cleanupFailures: 1,
    });
    gate.recordFailure('statement', new Error('later failure'));
    expect(gate.snapshot()).toEqual({
      status: 'failed',
      firstFailure: { phase: 'oracle', value: first },
      cleanupFailures: 1,
    });
  });
  it('preserves throw undefined even when cleanup also fails', async () => {
    const gate = createPDayFailureGate();
    const fail = jest.fn<Promise<void>, []>().mockRejectedValueOnce(undefined);
    let caught: { value: unknown } | undefined;
    try {
      await runPDayWorkWithCleanup(gate, 'semantic', fail, async () => {
        throw new Error('synthetic cleanup');
      });
    } catch (value) {
      caught = { value };
    }
    expect(caught).toEqual({ value: undefined });
    expect(gate.snapshot()).toEqual({
      status: 'failed',
      firstFailure: { phase: 'semantic', value: undefined },
      cleanupFailures: 1,
    });
  });
  it('makes a cleanup-only failure the primary red', async () => {
    const gate = createPDayFailureGate();
    const first = new Error('synthetic cleanup-only');
    await expect(
      runPDayWorkWithCleanup(
        gate,
        'oracle',
        async () => 1,
        async () => {
          throw first;
        },
      ),
    ).rejects.toBe(first);
    expect(gate.snapshot()).toEqual({
      status: 'failed',
      firstFailure: { phase: 'cleanup', value: first },
      cleanupFailures: 1,
    });
  });
  it('refuses work and cleanup callbacks after the group is already failed', async () => {
    const gate = createPDayFailureGate();
    gate.recordFailure('semantic', new Error('synthetic first red'));
    const work = jest.fn(async () => 1);
    const cleanup = jest.fn(async () => undefined);
    await expect(runPDayWorkWithCleanup(gate, 'oracle', work, cleanup)).rejects.toThrow(
      'stopped after first failure',
    );
    expect(work).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });
  it('isolates calibration factories from each other and the real suite gate', async () => {
    const failed = createPDayFailureGate();
    failed.recordFailure('semantic', new Error('synthetic first red'));
    const clean = createPDayFailureGate();
    const cleanup = jest.fn(async () => undefined);
    await expect(
      runPDayWorkWithCleanup(clean, 'oracle', async () => undefined, cleanup),
    ).resolves.toBeUndefined();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(clean.snapshot()).toEqual({ status: 'open' });
    expect(pDayFailureGate.snapshot()).toEqual({ status: 'open' });
  });
});

describe('E4 boolean collection source offline', () => {
  // E4_TERMINAL_REPLACE_HISTORIC_TEST_INPUT_BEGIN
  it('reads the real complete new migration and restores exactly the opening whole source', () => {
    const actual = terminalOpeningMigrationSource(rawS13MigrationSource());
    expect(createHash('sha256').update(actual).digest('hex')).toBe(E4_BOOLEAN_MIGRATION_SHA);
    expect(actualBooleanCollectionWindow(actual)).toBe(E4_COLLECTION_BOOLEAN_WINDOW_SQL);
    expect(createHash('sha256').update(booleanCollectionHistorySource(actual)).digest('hex')).toBe(
      E4_BOOLEAN_OPENING_SHA,
    );
  });
  // E4_TERMINAL_REPLACE_HISTORIC_TEST_INPUT_END
  it.each(['missing', 'duplicate', 'changed', 'adjacent', 'outside'] as const)(
    'refuses %s input before any historical projection',
    (variant) => {
      const actual = rawS13MigrationSource();
      const changed =
        variant === 'missing'
          ? actual.replace(E4_COLLECTION_BOOLEAN_WINDOW_SQL, '')
          : variant === 'duplicate'
            ? actual + E4_COLLECTION_BOOLEAN_WINDOW_SQL
            : variant === 'changed'
              ? actual.replace('WHERE p.is_mismatch', 'WHERE NOT p.is_mismatch')
              : variant === 'adjacent'
                ? actual.replace('  -- Unchanged-time evidence', ' -- Unchanged-time evidence')
                : actual + '\n';
      expect(changed).not.toBe(actual);
      expect(() => booleanCollectionHistorySource(changed)).toThrow();
      expect(() => actualBooleanCollectionWindow(changed)).toThrow();
    },
  );
  it('refuses an unknown opening rather than accepting a current/historical fallback', () => {
    expect(() => booleanCollectionHistorySource(booleanCollectionHistorySource() + '\n')).toThrow();
    expect(() => actualBooleanCollectionWindow(booleanCollectionHistorySource())).toThrow();
  });
  it('retains the complete existing format, S13 and P-Set historical chain', () => {
    const opening = booleanCollectionHistorySource();
    expect(createHash('sha256').update(formatProbeInverse(opening)).digest('hex')).toBe(
      'b056ad26a9fce4129c8e943c4d1e48b5ac1b95bce46cb4e3ba7542380ef63bd8',
    );
    expect(
      createHash('sha256').update(assertCollectionPairOpeningClosure(opening)).digest('hex'),
    ).toBe('96e4dfae0f00a3321b43d02ace0314442483f535673526a76fa043e03075b4b4');
    expect(createHash('sha256').update(pSetMigrationSource()).digest('hex')).toBe(
      '3f73112f745247fd5ce4762a1b8e8d3551e4648f48ec47e76eb9b54ad4fd8b02',
    );
  });
  it('pins the full real prosrc, while the inverse exactly restores the old full body', () => {
    const body = (source: string) => {
      const definitions = [
        ...source.matchAll(/CREATE FUNCTION e4_assert_complete\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/gu),
      ];
      expect(definitions).toHaveLength(1);
      return definitions[0][1];
    };
    expect(createHash('md5').update(body(rawS13MigrationSource())).digest('hex')).toBe(
      E4_BOOLEAN_COMPLETE_MD5,
    );
    expect(createHash('md5').update(body(booleanCollectionHistorySource())).digest('hex')).toBe(
      'c8d601c56770af301ea5b61d60244887',
    );
  });
  it('materializes only the actual identifier and NULL-safe full-document comparison', () => {
    const actual = actualBooleanCollectionWindow();
    expect(actual.split('root.id')).toHaveLength(4);
    expect(actual).toContain('WITH expected AS NOT MATERIALIZED');
    expect(actual).toContain('actual AS MATERIALIZED');
    expect(actual).toContain('pairs AS MATERIALIZED');
    expect(actual).toContain('ON e.id=a.id AND e."contributionRevisionId"=root.id');
    expect(actual).toContain(
      'x.evaluation IS DISTINCT FROM\n            CASE WHEN e.id IS NULL THEN NULL::JSONB',
    );
    expect(actual).toContain('ELSE e4_evaluation_document(e) END AS is_mismatch');
    expect(actual).not.toMatch(
      /\bexpected_evaluation\b|expected_row_ordinal|expected_keys|GROUP BY|SELECT DISTINCT|LIMIT|e4_hash/gu,
    );
  });
  it('binds the raw actual SQL without altering the inner complete-document comparison', () => {
    const query = virtualPSetSelect(actualBooleanCollectionWindow()).text;
    expect(query).toContain('WITH expected AS NOT MATERIALIZED');
    expect(query).toContain('x.evaluation IS DISTINCT FROM');
    expect(query).toContain('e4_evaluation_document(e.evaluation_row)');
    expect(query.split('\n      WHERE p.is_mismatch')).toHaveLength(2);
    const unfiltered = query.split('\n      WHERE p.is_mismatch')[0];
    expect(unfiltered).toContain('AS is_mismatch');
    expect(unfiltered).toContain('FROM pairs p');
    expect(query).not.toMatch(/root\.id|"ParticipantContributionEvaluation" e/gu);
  });
});

describe('E4 P-Day format fast-path offline actual SQL and fixed historical inverse', () => {
  it('reads the actual two CASEs and reverses exactly the full fixed opening migration', () => {
    const actual = booleanCollectionHistorySource();
    const opening = formatProbeInverse(actual);
    expect(formatProbeSource(opening)).toBe(actual);
    expect([...actual.matchAll(/pg_catalog\.translate\(/gu)]).toHaveLength(2);
    expect(actualPDayPrecheck(actual)).toBe(E4_P_DAY_FORMAT_PRECHECK_SQL);
    const originalFallback = E4_P_DAY_ORACLE_SQL.slice(E4_P_DAY_ORACLE_SQL.indexOf('WITH source'));
    expect([...actual.matchAll(E4_P_DAY_FUNCTION_WINDOW)][0][0]).toContain(originalFallback);
  });
  it.each(['missing', 'duplicated', 'adjacent', 'outside'] as const)(
    'rejects %s actual source mutation',
    (variant) => {
      const actual = booleanCollectionHistorySource();
      const invalid =
        variant === 'missing'
          ? actual.replace(formatCase('startsAt'), '')
          : variant === 'duplicated'
            ? actual + formatCase('startsAt')
            : variant === 'adjacent'
              ? actual.replace('AS canonical_start', 'AS canonical_other')
              : actual + '\n';
      expect(() => formatProbeInverse(invalid)).toThrow();
    },
  );
  it('binds the actual new precheck while keeping the original two named constants', () => {
    const actual = booleanCollectionHistorySource();
    expect(diagnosticPDaySelect(actual, false) + ';\n').toBe(
      E4_P_DAY_FORMAT_PRECHECK_SQL.replace(' INTO single_day,same_day ', ' ').trimStart(),
    );
    expect(actualPDayPrecheck(formatProbeInverse(actual))).toBe(E4_P_DAY_NEW_PRECHECK_SQL);
    expect(E4_P_DAY_NEW_PRECHECK_SQL).not.toContain('translate');
    expect(E4_P_DAY_OPENING_PRECHECK_SQL).not.toContain('translate');
  });
  it('proves every positive template fixture belongs to the old ASCII regex', () => {
    const regex = new RegExp(E4_FORMAT_PATTERN, 'u');
    let positives = 0;
    for (const value of formatTextMatrix()) {
      if (typeof value === 'string' && value.replace(/[0-9]/gu, '0') === E4_FORMAT_TEMPLATE) {
        positives++;
        expect(regex.test(value)).toBe(true);
      }
    }
    expect(positives).toBe(171);
  });
  it.each([true, false, null])('keeps the fallback result %s without coalescing', (result) => {
    const evaluate = (positive: boolean | null, fallback: boolean | null) =>
      positive === true ? true : fallback;
    expect(evaluate(false, result)).toBe(result);
    expect(evaluate(null, result)).toBe(result);
    expect(evaluate(true, result)).toBe(true);
    for (const key of ['startsAt', 'endsAt'] as const)
      expect(formatCase(key)).toContain('ELSE ' + formatRegex(key));
  });
});

describe('E4 P-Day offline fixed old function and exact single-window closure', () => {
  function migrationSource() {
    const source = readFileSync(
      resolve(
        __dirname,
        '../../prisma/migrations/20261003000000_activity_contribution_settlement/migration.sql',
      ),
      'utf8',
    );
    // Historical byte assertions keep their original pins; actual new SQL is tested separately.
    return formatProbeInverse(booleanCollectionHistorySource(source));
  }
  it('restores only the day window to the complete fixed pre-§12.20 migration', () => {
    const source = migrationSource();
    expect(
      createHash('sha256')
        .update(restoreFixedOldDay(restoreFixedOldSet(source)))
        .digest('hex'),
    ).toBe('a9677297f6f3b1b13df37ad8fb73957cd61609fdf1c9eec8299d77782e4096c7');
    const originalFallback = E4_P_DAY_ORACLE_SQL.slice(E4_P_DAY_ORACLE_SQL.indexOf('WITH source'));
    expect([...source.matchAll(E4_P_DAY_FUNCTION_WINDOW)][0][0]).toContain(originalFallback);
  });
  it('rejects a byte changed outside the authorized day function window', () => {
    const source = migrationSource();
    const mutated = source.replace(
      'CREATE FUNCTION e4_envelope_hash',
      'CREATE FUNCTION e4_envelope_hash_changed',
    );
    expect(mutated).not.toBe(source);
    expect(
      createHash('sha256')
        .update(restoreFixedOldDay(restoreFixedOldSet(mutated)))
        .digest('hex'),
    ).not.toBe('a9677297f6f3b1b13df37ad8fb73957cd61609fdf1c9eec8299d77782e4096c7');
  });
  it('binds the actual precheck and independent fallback without changing either SELECT', () => {
    const source = migrationSource();
    expect(actualPDayPrecheck(source)).toBe(E4_P_DAY_NEW_PRECHECK_SQL);
    expect(diagnosticPDaySelect(source, false) + ';\n').toBe(
      E4_P_DAY_NEW_PRECHECK_SQL.replace(' INTO single_day,same_day ', ' ').trimStart(),
    );
    const fallback = diagnosticPDaySelect(source, true);
    expect(fallback).toContain('ORDER BY s.ordinal');
    expect(E4_P_DAY_ORACLE_SQL).toContain(
      fallback.replace(' FROM amounts', ' INTO result FROM amounts'),
    );
  });
  it('refuses missing or duplicated actual precheck extraction windows', () => {
    const source = migrationSource();
    expect(() => actualPDayPrecheck(source.replace(E4_P_DAY_NEW_PRECHECK_SQL, ''))).toThrow();
    expect(() =>
      actualPDayPrecheck(source + [...source.matchAll(E4_P_DAY_FUNCTION_WINDOW)][0][0]),
    ).toThrow();
  });
  it('restores exactly the complete opening d405632f migration from one narrow precheck', () => {
    const source = migrationSource();
    expect(source.split(E4_P_DAY_NEW_PRECHECK_SQL)).toHaveLength(2);
    expect(createHash('sha256').update(restoreOpeningPDay(source)).digest('hex')).toBe(
      'd405632fe17fc1c52233613fbecaf5a50799efab51fb778ac664b09e271bb280',
    );
  });
  it('rejects a missing, repeated or mutated narrow precheck', () => {
    const source = migrationSource();
    expect(() => restoreOpeningPDay(source.replace(E4_P_DAY_NEW_PRECHECK_SQL, ''))).toThrow();
    expect(() => restoreOpeningPDay(source + E4_P_DAY_NEW_PRECHECK_SQL)).toThrow();
    expect(() =>
      restoreOpeningPDay(
        source.replace(
          'AND canonical_start AND canonical_end AS valid',
          'AND canonical_start AS valid',
        ),
      ),
    ).toThrow();
  });
  it('detects adjacent and other-function mutations after only the narrow precheck is restored', () => {
    const source = migrationSource();
    for (const [from, to] of [
      ['    result=jsonb_build_array(', '    result= jsonb_build_array('],
      ['CREATE FUNCTION e4_envelope_hash', 'CREATE FUNCTION e4_envelope_hash_changed'],
    ]) {
      const changed = source.replace(from, to);
      expect(changed).not.toBe(source);
      expect(createHash('sha256').update(restoreOpeningPDay(changed)).digest('hex')).not.toBe(
        'd405632fe17fc1c52233613fbecaf5a50799efab51fb778ac664b09e271bb280',
      );
    }
  });
});

describe('E4 P-Set offline fixed oracle and single-window byte closure', () => {
  it('restores exactly the complete fixed 0d5def0a migration', () => {
    expect(actualPSetWindow()).toBe(E4_P_SET_NEW_WINDOW_SQL);
    expect(
      createHash('sha256').update(restoreFixedOldSet(pSetMigrationSource())).digest('hex'),
    ).toBe('0d5def0a4e7a0a6e464a7d78ee8a9553bd216eab0e8507e8395145e83d7416b4');
  });
  it('rejects zero authorized-window matches', () => {
    expect(() => restoreFixedOldSet(E4_P_SET_OLD_WINDOW_SQL)).toThrow();
  });
  it('rejects two authorized-window matches', () => {
    expect(() => restoreFixedOldSet(pSetMigrationSource() + E4_P_SET_NEW_WINDOW_SQL)).toThrow();
  });
  it('detects a byte changed immediately outside the window', () => {
    const source = pSetMigrationSource();
    const changed = source.replace(
      '  -- Unchanged-time evidence',
      '  -- changed Unchanged-time evidence',
    );
    expect(changed).not.toBe(source);
    expect(createHash('sha256').update(restoreFixedOldSet(changed)).digest('hex')).not.toBe(
      '0d5def0a4e7a0a6e464a7d78ee8a9553bd216eab0e8507e8395145e83d7416b4',
    );
  });
  it('detects a change in a different function', () => {
    const source = pSetMigrationSource();
    const changed = source.replace(
      'CREATE FUNCTION e4_envelope_hash',
      'CREATE FUNCTION e4_envelope_hash_changed',
    );
    expect(changed).not.toBe(source);
    expect(createHash('sha256').update(restoreFixedOldSet(changed)).digest('hex')).not.toBe(
      '0d5def0a4e7a0a6e464a7d78ee8a9553bd216eab0e8507e8395145e83d7416b4',
    );
  });
  it('binds only explicit virtual sources/rows and rejects a missing substitution', () => {
    expect(virtualPSetSelect(E4_P_SET_OLD_WINDOW_SQL).sql).toContain('FULL JOIN');
    expect(virtualPSetSelect(actualPSetWindow()).sql).toContain('NULL::JSONB');
    expect(() => replacePSetFixtureInput('missing', 'root.id', 'bound', 1)).toThrow();
  });
});

describe('E4 S13 offline historical exact opening closure and thin-key full-document shape', () => {
  it('restores the fixed complete opening 137 using only one S13 window', () => {
    expect(actualS13Window()).toBe(E4_S13_WINDOW_SQL);
    expect(assertS13OpeningClosure(historicalS13MigrationSource())).toBe(pSetMigrationSource());
  });
  it('rejects zero S13 windows', () => {
    expect(() => restoreS13Window(E4_P_SET_NEW_WINDOW_SQL)).toThrow();
  });
  it('rejects two S13 windows', () => {
    expect(() => restoreS13Window(historicalS13MigrationSource() + E4_S13_WINDOW_SQL)).toThrow();
  });
  it('rejects an adjacent byte mutation after the exact window restore', () => {
    const source = historicalS13MigrationSource();
    const changed = source.replace(
      '  -- Unchanged-time evidence',
      '  -- changed Unchanged-time evidence',
    );
    expect(changed).not.toBe(source);
    expect(() => assertS13OpeningClosure(changed)).toThrow();
  });
  it('rejects a changed function outside S13 without accepting a new opening pin', () => {
    const source = historicalS13MigrationSource();
    const changed = source.replace(
      'CREATE FUNCTION e4_envelope_hash',
      'CREATE FUNCTION e4_envelope_hash_changed',
    );
    expect(changed).not.toBe(source);
    expect(() => assertS13OpeningClosure(changed)).toThrow();
  });
  it('refuses a malformed actual new window rather than normalizing it into a passing oracle', () => {
    const changed = historicalS13MigrationSource().replace(
      'ON x.expected_row_ordinal=p.expected_row_ordinal',
      'ON x.expected_row_ordinal=1',
    );
    expect(() => actualS13Window(changed)).toThrow();
    expect(() => legacyS13Input(changed)).toThrow();
  });
  it('materializes only row identifiers at matching and retains exact full-doc and same-root backjoins', () => {
    const actual = actualS13Window();
    const keys = [...actual.matchAll(/expected_keys AS MATERIALIZED \(([\s\S]*?)\n {6}\)/gu)];
    const pairs = [...actual.matchAll(/pairs AS MATERIALIZED \(([\s\S]*?)\n {6}\)/gu)];
    expect(keys).toHaveLength(1);
    expect(pairs).toHaveLength(1);
    expect(keys[0][1].trim()).toBe('SELECT expected_row_ordinal,key FROM expected');
    expect(pairs[0][1].trim()).toBe(
      'SELECT x.expected_row_ordinal,a.id AS actual_id\n        FROM expected_keys x FULL JOIN actual a USING (key)',
    );
    expect(actual.split('root.id')).toHaveLength(4);
    expect(actual).toContain('row_number() OVER () AS expected_row_ordinal');
    expect(actual).toContain('ON x.expected_row_ordinal=p.expected_row_ordinal');
    expect(actual).toContain('ON e.id=p.actual_id AND e."contributionRevisionId"=root.id');
    expect(actual).toContain(
      'WHERE x.evaluation IS DISTINCT FROM\n        CASE WHEN e.id IS NULL THEN NULL::JSONB\n             ELSE e4_evaluation_document(e) END',
    );
    expect(actual).not.toMatch(/SELECT DISTINCT|GROUP BY|jsonb_build_object|e4_hash/gu);
  });
  it('binds the fixed historical S13 window to virtual inputs with no root or table leaks', () => {
    const sql = virtualPSetSelect(actualS13Window()).sql;
    expect(sql).toContain('expected_row_ordinal');
    expect(sql).toContain('pairs AS MATERIALIZED');
    expect(sql).toContain('e4_evaluation_document(e.evaluation_row)');
    expect(sql).not.toContain('root.id');
    expect(sql).not.toContain('"ParticipantContributionEvaluation" e');
  });
});
describe('E4 collection pair offline actual window and exact §12.30 closure', () => {
  it('extracts the actual candidate and restores exactly the complete fixed S13 migration', () => {
    expect(actualCollectionPairWindow()).toBe(E4_COLLECTION_PAIR_WINDOW_SQL);
    expect(assertCollectionPairOpeningClosure(booleanCollectionHistorySource())).toBe(
      historicalS13MigrationSource(),
    );
    expect(assertS13OpeningClosure(historicalS13MigrationSource())).toBe(pSetMigrationSource());
  });
  it('rejects zero actual candidate windows', () => {
    expect(() => restoreCollectionPairWindow(E4_S13_WINDOW_SQL)).toThrow();
  });
  it('rejects two actual candidate windows', () => {
    expect(() =>
      restoreCollectionPairWindow(booleanCollectionHistorySource() + E4_COLLECTION_PAIR_WINDOW_SQL),
    ).toThrow();
  });
  it.each([
    ['  -- Unchanged-time evidence', '  -- changed Unchanged-time evidence'],
    ['CREATE FUNCTION e4_envelope_hash', 'CREATE FUNCTION e4_envelope_hash_changed'],
    ['LANGUAGE plpgsql SECURITY INVOKER', 'LANGUAGE plpgsql SECURITY DEFINER'],
  ])('rejects a byte mutation outside the sole candidate window (%#)', (from, to) => {
    const source = booleanCollectionHistorySource();
    const changed = source.replace(from, to);
    expect(changed).not.toBe(source);
    expect(() => assertCollectionPairOpeningClosure(changed)).toThrow();
  });
  it('rejects a changed candidate rather than routing it into a historical pass', () => {
    const changed = booleanCollectionHistorySource().replace(
      'ON e.id=p.actual_id AND e."contributionRevisionId"=root.id',
      'ON e.id=p.actual_id',
    );
    expect(() => actualCollectionPairWindow(changed)).toThrow();
    expect(() => legacyS13Input(changed)).toThrow();
  });
  it('carries the exact expected document through the FULL JOIN and retains the same-root PK backjoin', () => {
    const actual = actualCollectionPairWindow();
    const pairs = [...actual.matchAll(/pairs AS MATERIALIZED \(([\s\S]*?)\n {6}\)/gu)];
    expect(pairs).toHaveLength(1);
    expect(pairs[0][1].trim()).toBe(
      'SELECT x.evaluation AS expected_evaluation,a.id AS actual_id\n        FROM expected x FULL JOIN actual a USING (key)',
    );
    expect(actual.split('root.id')).toHaveLength(4);
    expect(actual).toContain('ON e.id=p.actual_id AND e."contributionRevisionId"=root.id');
    expect(actual).toContain(
      'WHERE p.expected_evaluation IS DISTINCT FROM\n        CASE WHEN e.id IS NULL THEN NULL::JSONB\n             ELSE e4_evaluation_document(e) END',
    );
    expect(actual).not.toMatch(
      /expected_keys|expected_row_ordinal|LEFT JOIN expected|SELECT DISTINCT|GROUP BY|jsonb_build_object|e4_hash/gu,
    );
  });
  it('binds only the actual unnormalized candidate to virtual sources and full documents', () => {
    const sql = virtualPSetSelect(actualCollectionPairWindow()).sql;
    expect(sql).toContain('pset_expected_input');
    expect(sql).toContain('FROM pairs p');
    expect(sql).toContain('WHERE p.expected_evaluation IS DISTINCT FROM');
    expect(sql).toContain('e4_evaluation_document(e.evaluation_row)');
    expect(sql).not.toMatch(/expected_keys|expected_row_ordinal|LEFT JOIN expected/gu);
    expect(sql).not.toContain('root.id');
    expect(sql).not.toContain('"ParticipantContributionEvaluation" e');
  });
});
// This upgrade fixture is deliberately built from fixed 136-era facts, never current E4 services.
const E4_OLD_AT = '2099-09-02T00:00:00.000Z';
const E4_OLD_SELECTION_AT = '2099-08-01T00:00:00.000Z';
const E4_OLD_START = '2099-09-01T08:45:00.000Z';
const E4_OLD_END = '2099-09-01T09:45:00.000Z';
const E4_OLD_CATEGORIES = [
  'volunteer_service',
  'training',
  'organization',
  'non_creditable',
] as const;
const e4OldId = (version: 1 | 2, label: string) => `e4-136-v${version}-${label}`;
const e4OldQuote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
function e4OldIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z_0-9]*$/u.test(value)) throw new Error('Invalid fixed fixture identifier');
  return '"' + value + '"';
}
function e4OldInsert(table: string, row: Record<string, unknown>): string {
  const values = Object.values(row).map((value) => {
    if (value === null) return 'NULL';
    if (typeof value === 'string') return e4OldQuote(value);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('Invalid fixture number');
      return String(value);
    }
    if (typeof value === 'bigint' || typeof value === 'boolean') return String(value);
    return e4OldQuote(JSON.stringify(value)) + '::jsonb';
  });
  return `INSERT INTO ${e4OldIdentifier(table)} (${Object.keys(row).map(e4OldIdentifier).join(',')}) VALUES (${values.join(',')});`;
}
function e4OldSql(statement: string): string {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  const database = deriveTestDbName();
  if (!process.env.DATABASE_URL || new URL(process.env.DATABASE_URL).pathname !== '/' + database)
    throw new Error('Nonempty upgrade database mismatch');
  try {
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
        database,
        '-v',
        'ON_ERROR_STOP=1',
        '-v',
        'VERBOSITY=verbose',
      ],
      {
        input: statement,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ).trim();
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
    // Fixed local fixture only; no SQL, row values, connection strings or detail contents.
    const safe = stderr
      .split('\n')
      .filter((line) => /^(?:ERROR:|CONSTRAINT NAME:|SCHEMA NAME:|TABLE NAME:)/u.test(line))
      .join('\n');
    throw new Error('E4 nonempty upgrade SQL failed: ' + (safe || 'classification unavailable'));
  }
}
function e4OldChain(version: 1 | 2) {
  const id = (label: string) => e4OldId(version, label);
  const hash = (label: string) => createHash('sha256').update(id(label)).digest('hex');
  const statements: string[] = [];
  const add = (table: string, row: Record<string, unknown>) =>
    statements.push(e4OldInsert(table, row));
  const mutable = { createdAt: E4_OLD_AT, updatedAt: E4_OLD_AT };
  for (const role of ['author', 'first', 'final'])
    add('User', { id: id(role), username: id(role), passwordHash: 'fixture', ...mutable });
  add('Organization', { id: id('org'), name: '非空升级组织', nodeTypeCode: 'team', ...mutable });
  add('Member', {
    id: id('member'),
    memberNo: id('member'),
    realName: '升级夹具',
    memberSinceDate: '2099-01-01',
    memberOriginCode: 'fixture',
    ...mutable,
  });
  add('Activity', {
    id: id('activity'),
    title: '136 nonempty fixture',
    activityTypeCode: 'fixture',
    organizationId: id('org'),
    startAt: E4_OLD_START,
    endAt: E4_OLD_END,
    location: 'fixture',
    statusCode: 'draft',
    initiatorMemberId: id('member'),
    ...mutable,
  });
  add('ActivitySession', {
    id: id('session'),
    activityId: id('activity'),
    code: id('session'),
    name: 'fixture',
    startAt: E4_OLD_START,
    endAt: E4_OLD_END,
    locationText: 'fixture',
    checkInOpenAt: E4_OLD_START,
    checkInCloseAt: E4_OLD_END,
    checkOutOpenAt: E4_OLD_START,
    checkOutCloseAt: E4_OLD_END,
    locationRequired: false,
    locationPolicySourceCode: 'session',
    statusCode: 'scheduled',
    ...mutable,
  });
  add('ActivitySessionPosition', {
    id: id('position'),
    activityId: id('activity'),
    sessionId: id('session'),
    code: id('position'),
    name: 'fixture',
    attendanceRoleCode: 'service',
    ...mutable,
  });
  add('ActivityRegistration', {
    id: id('registration'),
    activityId: id('activity'),
    memberId: id('member'),
    statusCode: 'pass',
    ...mutable,
  });
  add('ActivityParticipationIdentity', {
    id: id('identity'),
    activityId: id('activity'),
    sessionId: id('session'),
    registrationId: id('registration'),
    memberId: id('member'),
    currentStatusCode: 'pass',
    currentPositionId: id('position'),
    populationIncluded: true,
    ...mutable,
  });
  for (const [label, eventTypeCode, occurredAt, positionId] of [
    ['check-in', 'check_in', E4_OLD_START, id('position')],
    ['check-out', 'check_out', E4_OLD_END, null],
  ] as const)
    add('AttendancePunchEvent', {
      id: id(label),
      createdAt: occurredAt,
      activityId: id('activity'),
      sessionId: id('session'),
      positionId,
      participationIdentityId: id('identity'),
      memberId: id('member'),
      eventTypeCode,
      sourceCode: 'self_qr',
      occurredAt,
      receivedAt: occurredAt,
      operatorUserId: id('author'),
      eventKey: id(label + '-key'),
      requestHash: hash(label),
      evidenceRevision: 0,
    });
  add('ParticipantServiceSegmentRevision', {
    id: id('segment'),
    participationIdentityId: id('identity'),
    segmentKey: id('segment-key'),
    revision: 1,
    sourceCheckInEventId: id('check-in'),
    sourceCloseEventId: id('check-out'),
    resultCode: 'valid',
    statusCode: 'committed',
    checkInAt: E4_OLD_START,
    checkOutAt: E4_OLD_END,
    serviceHours: '1.00',
    lateFlag: false,
    earlyLeaveFlag: false,
    exceptionFlagsJson: null,
    ...mutable,
  });
  add('EvidenceSeal', {
    id: id('seal'),
    createdAt: E4_OLD_AT,
    updatedAt: E4_OLD_AT,
    activityId: id('activity'),
    sealRevision: 1,
    evidenceRevision: 0,
    populationRevision: 0,
    workflowRevision: 0,
    allWindowsClosedAt: E4_OLD_END,
    openSegmentCount: 0,
    manualReviewPendingCount: 0,
    populationCountDistinct: 1,
    populationCountBySession: { [id('session')]: 1 },
    contentHash: createHash('sha256')
      .update(
        JSON.stringify({
          activityId: id('activity'),
          sealRevision: 1,
          evidenceRevision: 0,
          populationRevision: 0,
          workflowRevision: 0,
          allWindowsClosedAt: E4_OLD_END,
          openSegmentCount: 0,
          manualReviewPendingCount: 0,
          populationCountDistinct: 1,
          populationCountBySession: { [id('session')]: 1 },
        }),
      )
      .digest('hex'),
    statusCode: 'active',
    sealedByUserId: id('author'),
    sealedAt: E4_OLD_AT,
  });
  add('AttendanceSettlementRun', {
    id: id('run'),
    activityId: id('activity'),
    statusCode: 'drafting',
    currentDraftVersion: 1,
    ...mutable,
  });
  const resultContents = {
    participationIdentityId: id('identity'),
    resultCode: 'present',
    lateFlag: false,
    earlyLeaveFlag: false,
    exceptionFlags: null,
    recognizedServiceHours: '1.00',
    recognizedContributionPoints: '1.00',
    calculatedServiceHours: '1.00',
    calculatedContributionPoints: '1.00',
    adjustmentReason: null,
  };
  const v1Document = {
    schemaVersion: 1,
    activityId: id('activity'),
    settlementRunId: id('run'),
    evidenceSealId: id('seal'),
    sealRevision: 1,
    evidenceRevision: 0,
    populationRevision: 0,
    workflowRevision: 0,
    personCount: 1,
    sessionParticipationCount: 1,
    serviceSegmentCount: 1,
    items: [resultContents],
  };
  const originalContentHash = computeSettlementContentHash(v1Document);
  const addVersion = (label: string, number: number, statusCode: string, contentHash: string) => {
    add('AttendanceSettlementVersion', {
      id: id(label),
      settlementRunId: id('run'),
      version: number,
      evidenceSealId: id('seal'),
      evidenceRevision: 0,
      populationRevision: 0,
      workflowRevision: 0,
      contentHash,
      personCount: 1,
      sessionParticipationCount: 1,
      serviceSegmentCount: 1,
      createdByUserId: id('author'),
      submittedAt: statusCode === 'submitted' ? E4_OLD_AT : null,
      statusCode,
      priorVersionId: number === 2 ? id('draft') : null,
      operationKey: id(label + '-operation'),
      requestHash: hash(label),
      ...mutable,
    });
    const { exceptionFlags, ...result } = resultContents;
    add('ParticipantSettlementResultRevision', {
      id: id(label + '-result'),
      settlementVersionId: id(label),
      revision: 0,
      ...result,
      exceptionFlagsJson: exceptionFlags,
      statusCode: 'draft',
      ...mutable,
    });
  };
  addVersion(
    version === 2 ? 'draft' : 'submitted',
    1,
    version === 2 ? 'draft' : 'submitted',
    originalContentHash,
  );
  let sourceSetHash: string | null = null;
  let bucketContentHash: string | null = null;
  let submittedContentHash = originalContentHash;
  if (version === 2) {
    const policy = fingerprintTimePolicyVersion({
      schemaVersion: 1,
      evaluatorVersion: 1,
      effectiveFrom: '2098-01-01T00:00:00.000Z',
      effectiveUntil: '2101-01-01T00:00:00.000Z',
      definition: {
        defaultCategory: 'volunteer_service',
        roleMappings: [],
        allowSplit: false,
        specialIntervals: {
          preparation: { mode: 'exclude' },
          duty: { mode: 'exclude' },
          travel: { mode: 'exclude' },
        },
        rounding: { mode: 'floor', quantumSeconds: 1 },
        evidence: { requiredSources: [], requireManualRecognition: false },
        manualAdjustment: { enabled: false },
      },
    });
    const selection = createActivityTimePolicySelectionDocument([
      {
        scope: { layerCode: 'activity', sessionId: null, positionId: null },
        selection: {
          mode: 'explicit',
          pointer: {
            policyId: id('policy'),
            versionId: id('policy-version'),
            definitionHash: policy.definitionHash,
          },
        },
      },
    ]);
    const selectionHash = activityTimePolicySelectionHash(selection);
    const snapshotConfig = {
      sessions: [
        {
          sessionId: id('session'),
          positions: [{ positionId: id('position'), attendanceRoleCode: 'service' }],
        },
      ],
      timePolicyPointers: {
        selectionRevisionId: id('selection'),
        selectionRevision: 1,
        selectionHash,
        selection,
      },
    };
    const snapshotHash = hashCanonical({ schemaVersion: 8, resolvedConfig: snapshotConfig });
    add('TimePolicy', {
      id: id('policy'),
      code: 'e4_upgrade_policy',
      name: '136 policy',
      ...mutable,
    });
    add('TimePolicyVersion', {
      id: id('policy-version'),
      policyId: id('policy'),
      version: 1,
      schemaVersion: 1,
      definitionJson: policy.definition,
      definitionHash: policy.definitionHash,
      evaluatorVersion: 1,
      effectiveFrom: '2098-01-01T00:00:00.000Z',
      effectiveUntil: '2101-01-01T00:00:00.000Z',
      statusCode: 'draft',
      ...mutable,
    });
    add('TimePolicyCommandReceipt', {
      id: id('policy-receipt'),
      actorUserId: id('author'),
      operationCode: 'create_version',
      operationKey: id('policy-create'),
      requestHash: hash('policy-create'),
      policyId: id('policy'),
      versionId: id('policy-version'),
      definitionHash: policy.definitionHash,
      resultJson: {
        schemaVersion: 1,
        operationCode: 'create_version',
        policyId: id('policy'),
        versionId: id('policy-version'),
        definitionHash: policy.definitionHash,
        resultStatusCode: 'draft',
        createdAt: E4_OLD_SELECTION_AT,
      },
      createdAt: E4_OLD_SELECTION_AT,
    });
    statements.push(
      `UPDATE "TimePolicyVersion" SET "statusCode"='active', "activatedAt"=${e4OldQuote(E4_OLD_SELECTION_AT)} WHERE id=${e4OldQuote(id('policy-version'))};`,
    );
    add('ActivityTimePolicySelectionRevision', {
      id: id('selection'),
      activityId: id('activity'),
      revision: 1,
      schemaVersion: 1,
      selectionHash,
      selectionJson: selection,
      itemCount: 1,
      templateId: null,
      templateDefinitionHash: null,
      originCode: 'select',
      createdAt: E4_OLD_SELECTION_AT,
      createdByUserId: id('author'),
    });
    add('ActivityTimePolicySelectionItem', {
      id: id('selection-item'),
      selectionRevisionId: id('selection'),
      activityId: id('activity'),
      layerCode: 'activity',
      sessionId: null,
      positionId: null,
      mode: 'explicit',
      policyId: id('policy'),
      versionId: id('policy-version'),
      definitionHash: policy.definitionHash,
    });
    statements.push(
      `UPDATE "Activity" SET "timePolicySelectionRevision"=1, "currentTimePolicySelectionRevisionId"=${e4OldQuote(id('selection'))} WHERE id=${e4OldQuote(id('activity'))};`,
    );
    add('ActivityTimePolicySelectionCommandReceipt', {
      id: id('selection-receipt'),
      actorUserId: id('author'),
      activityId: id('activity'),
      operationCode: 'patch_time_policy_selection',
      operationKey: id('selection-write'),
      requestHash: hash('selection-write'),
      selectionRevisionId: id('selection'),
      resultJson: {
        activityId: id('activity'),
        selectionRevisionId: id('selection'),
        revision: 1,
        selectionHash,
        createdAt: E4_OLD_SELECTION_AT,
      },
      createdAt: E4_OLD_SELECTION_AT,
    });
    add('activity_publish_reviews', {
      id: id('publish-review'),
      activityId: id('activity'),
      requestType: 'initial',
      requestVersion: 1,
      baseRevision: 0,
      status: 'approved',
      snapshot: {},
      directPublish: false,
      submittedByUserId: id('author'),
      submittedAt: E4_OLD_SELECTION_AT,
      reviewedByUserId: id('first'),
      reviewedAt: E4_OLD_SELECTION_AT,
      ...mutable,
    });
    add('ActivityRuleSnapshot', {
      id: id('snapshot'),
      createdAt: E4_OLD_SELECTION_AT,
      activityId: id('activity'),
      workflowRevision: 0,
      timePolicySelectionRevisionId: id('selection'),
      resolvedConfig: snapshotConfig,
      snapshotHash,
      createdByReviewId: id('publish-review'),
    });
    statements.push(
      `INSERT INTO attachments (id,"createdAt","updatedAt",key,"originalName",mime,size,"uploadedBy","ownerType","ownerId",tags) VALUES (${e4OldQuote(id('attachment'))},${e4OldQuote(E4_OLD_AT)},${e4OldQuote(E4_OLD_AT)},'e4-upgrade/evidence','fixture.txt','text/plain',1,${e4OldQuote(id('author'))},'activity',${e4OldQuote(id('activity'))},ARRAY[]::text[]);`,
    );
    const slice = {
      categoryCode: 'volunteer_service' as const,
      intervalKindCode: 'service_segment' as const,
      startAt: E4_OLD_START,
      endAt: E4_OLD_END,
    };
    const allocation = buildActivityTimeAllocationManifest([slice]);
    add('ParticipantTimeAllocationRevision', {
      id: id('allocation'),
      createdAt: E4_OLD_AT,
      activityId: id('activity'),
      sessionId: id('session'),
      memberId: id('member'),
      participationIdentityId: id('identity'),
      segmentKey: id('segment-key'),
      revision: 1,
      sourceSegmentId: id('segment'),
      sourceSegmentRevision: 1,
      sourcePositionId: id('position'),
      ruleSnapshotId: id('snapshot'),
      ruleSnapshotHash: snapshotHash,
      timePolicySelectionRevisionId: id('selection'),
      selectionHash,
      policyId: id('policy'),
      policyVersionId: id('policy-version'),
      definitionHash: policy.definitionHash,
      evaluatorVersion: 1,
      recognitionModeCode: 'automatic',
      allocationJson: allocation.manifest,
      allocationHash: allocation.allocationHash,
      sliceCount: 1,
      createdByUserId: id('author'),
    });
    add('ParticipantTimeAllocationSlice', {
      id: id('slice'),
      allocationRevisionId: id('allocation'),
      activityId: id('activity'),
      ordinal: 0,
      ...slice,
    });
    add('ParticipantTimeAllocationEvidence', {
      id: id('allocation-evidence'),
      allocationRevisionId: id('allocation'),
      activityId: id('activity'),
      attachmentId: id('attachment'),
      ordinal: 0,
    });
    add('ParticipantTimeAllocationCommandReceipt', {
      id: id('allocation-receipt'),
      actorUserId: id('author'),
      activityId: id('activity'),
      operationCode: 'recognize_time_allocation',
      operationKey: id('allocation-write'),
      requestHash: hash('allocation-write'),
      allocationRevisionId: id('allocation'),
      createdAt: E4_OLD_AT,
      resultJson: {
        schemaVersion: 1,
        activityId: id('activity'),
        allocationRevisionId: id('allocation'),
        revision: 1,
        sourceSegmentId: id('segment'),
        sourceSegmentRevision: 1,
        recognitionModeCode: 'automatic',
        allocationHash: allocation.allocationHash,
        sliceCount: 1,
        evidenceCount: 1,
        createdAt: E4_OLD_AT,
      },
    });
    const sourceDocument = {
      activityId: id('activity'),
      settlementRunId: id('run'),
      settlementDraftVersionId: id('draft'),
      evidenceSealId: id('seal'),
      evidenceRevision: 0,
      populationRevision: 0,
      workflowRevision: 0,
      draftContentHash: originalContentHash,
      population: [
        { participationIdentityId: id('identity'), memberId: id('member'), pending: false },
      ],
      segments: [
        {
          id: id('segment'),
          activityId: id('activity'),
          sessionId: id('session'),
          participationIdentityId: id('identity'),
          memberId: id('member'),
          sourcePositionId: id('position'),
          segmentKey: id('segment-key'),
          revision: 1,
          sourceCheckInEventId: id('check-in'),
          sourceCloseEventId: id('check-out'),
          resultCode: 'valid',
          statusCode: 'committed',
          checkInAt: E4_OLD_START,
          checkOutAt: E4_OLD_END,
          lateFlag: false,
          earlyLeaveFlag: false,
          exceptionFlagsJson: null,
          allocationRevisionId: id('allocation'),
          allocationHash: allocation.allocationHash,
        },
      ],
    };
    sourceSetHash = fingerprintMetricEnvelope(
      'activity-time-settlement-sources-v1',
      sourceDocument,
    ).definitionHash;
    const bucketDocuments = E4_OLD_CATEGORIES.map((categoryCode) => {
      const seconds = categoryCode === 'volunteer_service' ? 3600 : 0;
      return {
        participationIdentityId: id('identity'),
        categoryCode,
        calculatedSeconds: seconds,
        recognizedSeconds: seconds,
        rawCalculatedMilliseconds: String(seconds * 1000),
        rawRecognizedMilliseconds: String(seconds * 1000),
        timePolicyVersionId: id('policy-version'),
        definitionHash: policy.definitionHash,
        evaluatorVersion: 1,
        quantumSeconds: 1,
        adjustmentReason: null,
        emptyReasonCode: null,
        sources: [
          {
            allocationRevisionId: id('allocation'),
            sourceSegmentId: id('segment'),
            sourceSegmentRevision: 1,
            rawCalculatedMilliseconds: String(seconds * 1000),
            rawRecognizedMilliseconds: String(seconds * 1000),
          },
        ],
      };
    });
    bucketContentHash = fingerprintMetricEnvelope(
      'activity-time-settlement-buckets-v1',
      bucketDocuments,
    ).definitionHash;
    submittedContentHash = computeTimeSettlementContentHash({
      originalContentHash,
      sourceSetHash,
      bucketContentHash,
    });
    for (const [kindCode, number] of [
      ['draft', 1],
      ['submitted', 2],
    ] as const) {
      if (kindCode === 'submitted') addVersion('submitted', 2, 'submitted', submittedContentHash);
      const rootId = id(kindCode + '-time');
      add('ActivitySettlementTimeRevision', {
        id: rootId,
        activityId: id('activity'),
        settlementRunId: id('run'),
        settlementVersionId: id(kindCode),
        revision: number,
        previousTimeRevisionId: kindCode === 'draft' ? null : id('draft-time'),
        kindCode,
        sourceDraftTimeRevisionId: kindCode === 'draft' ? null : id('draft-time'),
        evidenceSealId: id('seal'),
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        draftContentHash: originalContentHash,
        sourceSetHash,
        bucketContentHash,
        bucketCount: 4,
        sourceCount: 4,
        createdAt: E4_OLD_AT,
        createdByUserId: id('author'),
      });
      for (const document of bucketDocuments) {
        const { sources, emptyReasonCode, ...bucket } = document;
        expect(emptyReasonCode).toBeNull();
        add('ParticipantSettlementTimeBucket', {
          id: id(kindCode + '-' + document.categoryCode),
          timeRevisionId: rootId,
          activityId: id('activity'),
          ...bucket,
        });
        add('ParticipantSettlementTimeBucketSource', {
          id: id(kindCode + '-' + document.categoryCode + '-source'),
          bucketId: id(kindCode + '-' + document.categoryCode),
          timeRevisionId: rootId,
          activityId: id('activity'),
          ...sources[0],
        });
      }
      add('ActivitySettlementTimeCommandReceipt', {
        id: id(kindCode + '-time-receipt'),
        actorUserId: id('author'),
        activityId: id('activity'),
        operationCode: kindCode === 'draft' ? 'prepare_time_settlement' : 'submit_time_settlement',
        operationKey: id(kindCode + '-time-command'),
        requestHash: hash(kindCode + '-time-command'),
        timeRevisionId: rootId,
        createdAt: E4_OLD_AT,
        resultJson: {
          schemaVersion: 1,
          activityId: id('activity'),
          timeRevisionId: rootId,
          revision: number,
          kindCode,
          settlementRunId: id('run'),
          settlementVersionId: id(kindCode),
          settlementVersion: number,
          contentHash: kindCode === 'draft' ? originalContentHash : submittedContentHash,
          bucketContentHash,
          bucketCount: 4,
          sourceCount: 4,
          createdAt: E4_OLD_AT,
        },
      });
    }
  }
  statements.push(
    `UPDATE "AttendanceSettlementRun" SET "statusCode"='pending_first_review', "currentSubmittedVersion"=${version} WHERE id=${e4OldQuote(id('run'))};`,
  );
  for (const stageCode of ['first', 'final']) {
    add('SettlementReviewAction', {
      id: id(stageCode + '-review'),
      createdAt: E4_OLD_AT,
      settlementVersionId: id('submitted'),
      stageCode,
      actionCode: 'approve',
      actorUserId: id(stageCode),
      actedAt: E4_OLD_AT,
      note: '历史审核 "quoted" 中文',
      operationKey: id(stageCode + '-approve'),
      requestHash: hash(stageCode),
    });
    statements.push(
      `UPDATE "AttendanceSettlementRun" SET "statusCode"=${e4OldQuote(stageCode === 'first' ? 'pending_final_review' : 'posting')} WHERE id=${e4OldQuote(id('run'))};`,
    );
  }
  statements.push(
    `UPDATE "AttendanceSettlementVersion" SET "statusCode"='approved' WHERE id=${e4OldQuote(id('submitted'))};`,
  );
  add('LedgerPostingBatch', {
    id: id('batch'),
    settlementRunId: id('run'),
    settlementVersionId: id('submitted'),
    batchRevision: 1,
    statusCode: 'preparing',
    requestKey: id('post'),
    requestHash: hash('post'),
    totalCount: 1,
    preparedCount: 0,
    preparedByUserId: id('author'),
    ...mutable,
  });
  if (version === 2 && bucketContentHash && sourceSetHash) {
    const ledger = buildParticipationTimeLedger(
      {
        postingBatchId: id('batch'),
        activityId: id('activity'),
        settlementRunId: id('run'),
        settlementVersionId: id('submitted'),
        timeRevisionId: id('submitted-time'),
        bucketContentHash,
        sourceSetHash,
      },
      E4_OLD_CATEGORIES.map((categoryCode) => ({
        id: id('submitted-' + categoryCode),
        participationIdentityId: id('identity'),
        categoryCode,
        recognizedSeconds: categoryCode === 'volunteer_service' ? 3600 : 0,
      })),
    );
    add('ParticipationTimeLedgerManifest', {
      id: id('manifest'),
      ...ledger.manifest,
      createdAt: E4_OLD_AT,
    });
    for (const entry of ledger.entries)
      add('ParticipationTimeLedgerEntry', {
        id: id('entry-' + entry.categoryCode),
        manifestId: id('manifest'),
        ...entry,
        createdAt: E4_OLD_AT,
      });
  }
  for (const entryTypeCode of ['service_credit', 'contribution_credit'])
    add('ParticipationLedgerEntry', {
      id: id(entryTypeCode),
      createdAt: E4_OLD_AT,
      postingBatchId: id('batch'),
      entryKey: id(entryTypeCode + '-entry'),
      operationKey: id(entryTypeCode + '-operation'),
      memberId: id('member'),
      activityId: id('activity'),
      sessionId: id('session'),
      participationIdentityId: id('identity'),
      resultRevisionId: id('submitted-result'),
      ledgerDate: '2099-09-01',
      entryTypeCode,
      serviceHoursDelta: entryTypeCode === 'service_credit' ? '1.00' : '0.00',
      recognizedPointsDelta: entryTypeCode === 'contribution_credit' ? '1.00' : '0.00',
      creditedPointsDelta: entryTypeCode === 'contribution_credit' ? '1.00' : '0.00',
      cappedOutPointsDelta: '0.00',
    });
  add('MemberContributionDayState', {
    id: id('day'),
    memberId: id('member'),
    ledgerDate: '2099-09-01',
    committedCreditedPoints: '1.00',
    latestBatchId: id('batch'),
    ...mutable,
  });
  statements.push(
    `UPDATE "LedgerPostingBatch" SET "statusCode"='ready', "preparedCount"=1, "preparedAt"=${e4OldQuote(E4_OLD_AT)} WHERE id=${e4OldQuote(id('batch'))};`,
  );
  statements.push(
    `UPDATE "LedgerPostingBatch" SET "statusCode"='committed', "committedAt"=${e4OldQuote(E4_OLD_AT)}, "committedByUserId"=${e4OldQuote(id('final'))} WHERE id=${e4OldQuote(id('batch'))};`,
  );
  statements.push(
    `UPDATE "ParticipantSettlementResultRevision" SET "statusCode"='committed' WHERE id=${e4OldQuote(id('submitted-result'))};`,
  );
  statements.push(
    `UPDATE "AttendanceSettlementRun" SET "statusCode"='posted', "currentPostedVersion"=${version} WHERE id=${e4OldQuote(id('run'))};`,
  );
  add('audit_logs', {
    id: id('audit'),
    createdAt: E4_OLD_AT,
    actorUserId: id('final'),
    resourceType: 'activity',
    resourceId: id('activity'),
    event: 'activity.ledger.committed',
    context: {
      postingBatchId: id('batch'),
      settlementVersionId: id('submitted'),
      schemaVersion: version,
    },
    success: true,
    shadowProofRequired: false,
  });
  return {
    sql: statements.join('\n'),
    originalContentHash,
    submittedContentHash,
    sourceSetHash,
    bucketContentHash,
    v1Document,
  };
}

describe('E4 nonempty 136 to 137 upgrade', () => {
  const owner = installE4ValidationDatabase({ baselineMigrationCount: 136 });
  it('preserves two committed historical chains, full old columns and checksums through upgrade and no-op', async () => {
    const migrations = () =>
      e4OldSql(
        'SELECT jsonb_agg(to_jsonb(m) ORDER BY migration_name)::text FROM "_prisma_migrations" m WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
      );
    const count = (table: string) =>
      Number(e4OldSql('SELECT count(*) FROM ' + e4OldIdentifier(table)));
    const oldMigrations: { migration_name: string; checksum: string }[] = JSON.parse(migrations());
    expect(oldMigrations).toHaveLength(136);
    expect(
      e4OldSql(
        `SELECT (to_regclass('public."ActivitySettlementContributionRevision"') IS NULL AND to_regclass('public."ParticipantContributionEvaluation"') IS NULL AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='AttendanceSettlementVersion' AND column_name='contributionRegimeCode'))::text`,
      ),
    ).toBe('true');
    const v1 = e4OldChain(1);
    const v2 = e4OldChain(2);
    // Actual deferred checks and COMMIT: a rolled-back or empty fixture cannot prove an upgrade.
    e4OldSql('BEGIN;\n' + v1.sql + '\n' + v2.sql + '\nSET CONSTRAINTS ALL IMMEDIATE;\nCOMMIT;');
    const denominators = {
      User: 6,
      Organization: 2,
      Member: 2,
      Activity: 2,
      ActivitySession: 2,
      ActivitySessionPosition: 2,
      ActivityRegistration: 2,
      ActivityParticipationIdentity: 2,
      AttendancePunchEvent: 4,
      ParticipantServiceSegmentRevision: 2,
      EvidenceSeal: 2,
      AttendanceSettlementRun: 2,
      AttendanceSettlementVersion: 3,
      ParticipantSettlementResultRevision: 3,
      SettlementReviewAction: 4,
      LedgerPostingBatch: 2,
      ParticipationLedgerEntry: 4,
      MemberContributionDayState: 2,
      audit_logs: 2,
      TimePolicy: 1,
      TimePolicyVersion: 1,
      TimePolicyCommandReceipt: 1,
      ActivityTimePolicySelectionRevision: 1,
      ActivityTimePolicySelectionItem: 1,
      ActivityTimePolicySelectionCommandReceipt: 1,
      activity_publish_reviews: 1,
      ActivityRuleSnapshot: 1,
      attachments: 1,
      ParticipantTimeAllocationRevision: 1,
      ParticipantTimeAllocationSlice: 1,
      ParticipantTimeAllocationEvidence: 1,
      ParticipantTimeAllocationCommandReceipt: 1,
      ActivitySettlementTimeRevision: 2,
      ParticipantSettlementTimeBucket: 8,
      ParticipantSettlementTimeBucketSource: 8,
      ActivitySettlementTimeCommandReceipt: 2,
      ParticipationTimeLedgerManifest: 1,
      ParticipationTimeLedgerEntry: 4,
    };
    for (const [table, expected] of Object.entries(denominators))
      expect({ table, count: count(table) }).toEqual({ table, count: expected });
    expect(e4OldSql('SELECT sum("recognizedSeconds") FROM "ParticipationTimeLedgerEntry"')).toBe(
      '3600',
    );
    expect(
      e4OldSql(
        `SELECT count(*) FROM "ActivitySettlementTimeRevision" WHERE "activityId"=${e4OldQuote(e4OldId(1, 'activity'))}`,
      ),
    ).toBe('0');
    const proveHashes = () => {
      for (const [version, chain] of [
        [1, v1],
        [2, v2],
      ] as const) {
        expect(computeSettlementContentHash(chain.v1Document)).toBe(chain.originalContentHash);
        expect(
          e4OldSql(
            `SELECT "contentHash" FROM "AttendanceSettlementVersion" WHERE id=${e4OldQuote(e4OldId(version, 'submitted'))}`,
          ),
        ).toBe(chain.submittedContentHash);
      }
      expect(
        e4OldSql(
          `SELECT astr_source_set_hash(${e4OldQuote(e4OldId(2, 'activity'))},${e4OldQuote(e4OldId(2, 'draft'))})`,
        ),
      ).toBe(v2.sourceSetHash);
      for (const kind of ['draft', 'submitted'])
        expect(
          e4OldSql(`SELECT astr_bucket_content_hash(${e4OldQuote(e4OldId(2, kind + '-time'))})`),
        ).toBe(v2.bucketContentHash);
      expect(
        e4OldSql('SELECT sum("recognizedPointsDelta")::text FROM "ParticipationLedgerEntry"'),
      ).toBe('2.00');
      expect(
        e4OldSql('SELECT count(*) FROM "LedgerPostingBatch" WHERE "statusCode"=\'committed\''),
      ).toBe('2');
    };
    proveHashes();
    // Capture only independently selected 136 column lists; additions cannot silently disappear.
    const columns: Record<string, string[]> = {};
    for (const table of Object.keys(denominators))
      columns[table] = e4OldSql(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=${e4OldQuote(table)} ORDER BY ordinal_position`,
      ).split('\n');
    expect(columns.AttendanceSettlementVersion).toEqual([
      'id',
      'createdAt',
      'updatedAt',
      'settlementRunId',
      'version',
      'evidenceSealId',
      'evidenceRevision',
      'populationRevision',
      'workflowRevision',
      'contentHash',
      'personCount',
      'sessionParticipationCount',
      'serviceSegmentCount',
      'createdByUserId',
      'submittedAt',
      'statusCode',
      'priorVersionId',
      'returnFromStage',
      'returnReason',
      'operationKey',
      'requestHash',
    ]);
    const snapshot = () =>
      Object.fromEntries(
        Object.entries(columns).map(([table, names]) => [
          table,
          e4OldSql(
            `SELECT jsonb_agg(to_jsonb(old_row) ORDER BY id)::text FROM (SELECT ${names.map(e4OldIdentifier).join(',')} FROM ${e4OldIdentifier(table)}) old_row`,
          ),
        ]),
      );
    const before = snapshot();
    owner.deployCurrentMigrations();
    const upgradedMigrations: { migration_name: string; checksum: string }[] =
      JSON.parse(migrations());
    expect(upgradedMigrations).toHaveLength(137);
    expect(upgradedMigrations.slice(0, 136)).toEqual(oldMigrations);
    expect(snapshot()).toEqual(before);
    for (const table of [
      'ActivitySettlementContributionRevision',
      'ParticipantContributionEvaluation',
    ])
      expect(count(table)).toBe(0);
    expect(
      e4OldSql(
        'SELECT count(*) FROM "AttendanceSettlementVersion" WHERE "contributionRegimeCode"=\'legacy\'',
      ),
    ).toBe('3');
    proveHashes();
    const afterMigration = migrations();
    owner.deployCurrentMigrations();
    expect(migrations()).toBe(afterMigration);
    expect(snapshot()).toEqual(before);
    proveHashes();
    // Cleanup helpers deliberately clear fixtures. Verify them only after completing the
    // nonempty proof, in a fresh current schema owned by the same lifecycle/lease.
    await owner.recreateCurrentMigrations();
    for (const table of Object.keys(denominators)) expect(count(table)).toBe(0);
    const cleanupBefore = snapshot();
    const triggers = () =>
      e4OldSql(
        `SELECT tgname||':'||tgenabled::text FROM pg_trigger WHERE tgname IN ('e4_revision_no_truncate','e4_evaluation_no_truncate') ORDER BY tgname`,
      );
    const expectedTriggers = 'e4_evaluation_no_truncate:O\ne4_revision_no_truncate:O';
    expect(triggers()).toBe(expectedTriggers);
    // Both guards are reached with FK-complete TRUNCATE sets; each real error rolls its block back.
    for (const [table, guard] of [
      ['ParticipantContributionEvaluation', 'e4_evaluation_no_truncate'],
      ['ActivitySettlementContributionRevision', 'e4_revision_no_truncate'],
    ] as const) {
      const disableOther =
        guard === 'e4_revision_no_truncate'
          ? 'ALTER TABLE "ParticipantContributionEvaluation" DISABLE TRIGGER e4_evaluation_no_truncate;'
          : '';
      const truncate =
        table === 'ParticipantContributionEvaluation'
          ? 'TRUNCATE "ParticipantContributionEvaluation";'
          : 'TRUNCATE "ParticipantContributionEvaluation", "ActivitySettlementContributionRevision";';
      e4OldSql(
        `DO $guard$ DECLARE c text; BEGIN BEGIN ${disableOther} ${truncate} RAISE EXCEPTION 'Expected truncate refusal missing'; EXCEPTION WHEN check_violation THEN GET STACKED DIAGNOSTICS c=CONSTRAINT_NAME; IF c IS DISTINCT FROM 'e4_immutable_guard' THEN RAISE EXCEPTION 'Wrong truncate constraint'; END IF; END; END $guard$;`,
      );
      expect(triggers()).toBe(expectedTriggers);
    }
    const cleanup = timeLedgerFixtureTriggerSql();
    e4OldSql('BEGIN; ' + cleanup.before + cleanup.after + ' COMMIT;');
    expect(triggers()).toBe(expectedTriggers);
    for (const partial of [
      'DROP TRIGGER e4_evaluation_no_truncate ON "ParticipantContributionEvaluation";',
      'ALTER TABLE "ParticipantContributionEvaluation" RENAME TO "e4_fixture_hidden_evaluation";',
    ]) {
      expect(() => e4OldSql('BEGIN; ' + partial + cleanup.before + ' ROLLBACK;')).toThrow(
        /Expected fixture trigger missing|Incomplete native contribution fixture tables/u,
      );
      expect(triggers()).toBe(expectedTriggers);
    }
    expect(() =>
      e4OldSql(
        'BEGIN; ' +
          cleanup.before +
          "DO $$ BEGIN RAISE EXCEPTION 'fixture controlled rollback'; END $$; COMMIT;",
      ),
    ).toThrow('fixture controlled rollback');
    expect(triggers()).toBe(expectedTriggers);
    expect(snapshot()).toEqual(cleanupBefore);
  }, 180_000);
});

describe('E4 migration dedicated lease envelope', () => {
  // Nested lifecycle lets the offline closure run without creating or connecting a database.
  // E4_TERMINAL_REPLACE_N1_INSTALLER_MODE_BEGIN
  installE4ValidationDatabase({ allowInstallRetain: true });
  // E4_TERMINAL_REPLACE_N1_INSTALLER_MODE_END
  // E4_TERMINAL_N1_INSTALL_STAGE_BEGIN
  const runN1InstallRetain =
    process.env.SRVF_E4_W98 === '1' && process.env.SRVF_E4_N1_LIFECYCLE === 'install-retain';
  (runN1InstallRetain ? it : it.skip)(
    'E4 N1 install-retain stage builds the sole full synthetic root for D1 admission',
    async () => {
      let fixture: E4Fixture | undefined;
      let phase: import('../helpers/activity-contribution-policy.fixture').E4N1InstallRetainStage =
        'INSTALLED_CATALOG';
      let primary: unknown;
      try {
        const installed = new PrismaClient();
        try {
          await assertConnectedTestDatabase(installed);
          await assertTerminalN1InstalledCatalog(installed);
        } finally {
          await installed.$disconnect();
        }
        const { createMaximumE4Source, withE4N1InstallRetainFixtureGate } =
          await import('../helpers/activity-contribution-policy.fixture');
        phase = 'FIXTURE';
        await withE4N1InstallRetainFixtureGate(async () => {
          try {
            fixture = await createE4Fixture();
            phase = 'MAXIMUM_SOURCE';
            const source = await createMaximumE4Source(fixture);
            phase = 'PREPARE';
            const prepared = await prepareE4Time(fixture, source, 's13_prepare');
            phase = 'SUBMIT';
            await submitE4Time(fixture, source, prepared, 's13_submit');
            phase = 'RETAINED_ROOT';
            terminalRetainedRoot(
              await fixture.db.$queryRawUnsafe<E4RetainedRoot[]>(E4_RETAINED_ROOT_SQL),
            );
            phase = 'FINAL_CATALOG';
            await assertTerminalN1InstalledCatalog(fixture.db);
          } catch (error) {
            primary = error;
          } finally {
            try {
              await closeE13Fixture(fixture);
            } catch (error) {
              if (primary === undefined) {
                phase = 'FIXTURE_CLOSE';
                primary = error;
              }
            }
          }
          if (primary !== undefined) {
            if (primary instanceof Error) throw primary;
            throw new Error('E4 N1 retained stage raised a non-error failure');
          }
        });
      } catch (error) {
        // Keep the failed retained candidate for the explicit admission gate;
        // the original lease finalizer still releases ownership after this suite.
        terminalMigrationFailed = true;
        const { e4N1InstallRetainFailure } =
          await import('../helpers/activity-contribution-policy.fixture');
        const failure = e4N1InstallRetainFailure(phase, error);
        console.info(
          'E4_N1_INSTALL_STAGE',
          JSON.stringify({ status: 'FAILED', phase: failure.phase, reason: failure.reason }),
        );
        throw new Error(failure.message);
      }
    },
    600_000,
  );
  // E4_TERMINAL_N1_INSTALL_STAGE_END

  describe('E4 migration real PostgreSQL cold replay and closed proof functions', () => {
    let db: PrismaClient;
    beforeAll(async () => {
      assertTestDatabaseUrl(process.env.DATABASE_URL);
      db = new PrismaClient();
      await assertConnectedTestDatabase(db);
    });
    afterAll(async () => {
      await db?.$disconnect();
    });
    const pSetDocument: Record<string, unknown> = {
      participationIdentityId: 'pset-identity-a',
      memberId: 'pset-member-a',
      sessionId: 'pset-session',
      ruleSnapshotId: 'pset-snapshot',
      selectionItemId: 'pset-selection',
      mode: 'policy',
      policyId: 'pset-policy',
      policyVersionId: 'pset-version',
      definitionHash: 'a'.repeat(64),
      evaluatorVersion: 1,
      attendanceRoleCode: 'service',
      timeCategoryCode: 'volunteer_service',
      evaluationUnitKey: 'pset-key',
      durationSeconds: 3600,
      sourceFingerprint: 'b'.repeat(64),
      sourceRefsJson: [
        { source: 'one', seconds: 1800 },
        { source: 'two', seconds: 1800 },
      ],
      calculatedPoints: '1.00',
      recognizedPoints: '1.00',
      explanationCode: 'credited',
      beijingDayPointsJson: [
        { ledgerDate: '2026-10-01', recognizedPoints: '0.50' },
        { ledgerDate: '2026-10-02', recognizedPoints: '0.50' },
      ],
      evaluationHash: 'c'.repeat(64),
    };
    type PSetExpectedInput = { document: Record<string, unknown> | null; sqlNull?: boolean };
    type PSetActualInput = PSetExpectedInput & { key: string | null };
    let firstPSetFailure: unknown;
    async function comparePSetInputs(
      expected: PSetExpectedInput[],
      actual: PSetActualInput[],
      differences: number,
      pairs: number,
    ) {
      const old = virtualPSetSelect(E4_P_SET_OLD_WINDOW_SQL);
      const candidate = virtualPSetSelect(actualBooleanCollectionWindow());
      const differencePredicate = '\n      WHERE p.is_mismatch';
      expect(candidate.text.split(differencePredicate)).toHaveLength(2);
      // Run the candidate's actual FULL JOIN and same-root PK backjoin without filtering bad documents.
      const candidatePairs = Prisma.raw(candidate.text.split(differencePredicate)[0]);
      const [row] = await db.$queryRaw<
        {
          oldDifferences: number;
          candidateDifferences: number;
          pairs: number;
          candidatePairs: number;
          expectedDocuments: unknown;
          actualDocuments: unknown;
        }[]
      >`
        WITH pset_expected_input AS MATERIALIZED (
          SELECT CASE WHEN coalesce((r->>'sqlNull')::boolean,false) THEN NULL::jsonb ELSE r->'document' END AS evaluation
          FROM jsonb_array_elements(${JSON.stringify(expected)}::jsonb) r
        ), pset_actual_input AS MATERIALIZED (
          SELECT ordinal::text AS id,'pset-root'::text AS "contributionRevisionId",
            r->>'key' AS "evaluationUnitKey",
            CASE WHEN coalesce((r->>'sqlNull')::boolean,false) THEN NULL::public."ParticipantContributionEvaluation"
              ELSE jsonb_populate_record(NULL::public."ParticipantContributionEvaluation",r->'document') END AS evaluation_row
          FROM jsonb_array_elements(${JSON.stringify(actual)}::jsonb) WITH ORDINALITY input(r,ordinal)
        ), old_differences AS MATERIALIZED (${old}), candidate_differences AS MATERIALIZED (${candidate}),
        candidate_pairs AS MATERIALIZED (${candidatePairs}),
        bag AS MATERIALIZED (
          SELECT 1 FROM (SELECT evaluation->>'evaluationUnitKey' AS key FROM pset_expected_input) x
          FULL JOIN (SELECT "evaluationUnitKey" AS key FROM pset_actual_input) a USING (key)
        )
        SELECT (SELECT count(*)::int FROM old_differences) AS "oldDifferences",
          (SELECT count(*)::int FROM candidate_differences) AS "candidateDifferences",
          (SELECT count(*)::int FROM bag) AS pairs,
          (SELECT count(*)::int FROM candidate_pairs) AS "candidatePairs",
          (SELECT coalesce(jsonb_agg(jsonb_build_object('sqlNull',evaluation IS NULL,'document',evaluation)),'[]'::jsonb)
            FROM pset_expected_input) AS "expectedDocuments",
          (SELECT coalesce(jsonb_agg(jsonb_build_object('sqlNull',evaluation_row IS NOT DISTINCT FROM NULL::public."ParticipantContributionEvaluation",
            'document',e4_evaluation_document(evaluation_row)) ORDER BY id::int),'[]'::jsonb)
            FROM pset_actual_input) AS "actualDocuments"
      `;
      expect(row.oldDifferences).toBe(differences);
      expect(row.candidateDifferences).toBe(differences);
      expect(row.pairs).toBe(pairs);
      expect(row.candidatePairs).toBe(pairs);
      expect(row.expectedDocuments).toEqual(
        expected.map((input) => ({ sqlNull: input.sqlNull === true, document: input.document })),
      );
      expect(row.actualDocuments).toEqual(
        actual.map((input) => ({ sqlNull: input.sqlNull === true, document: input.document })),
      );
    }
    describe('P-Set actual PostgreSQL query-level bag / NULL and full-document truth table', () => {
      beforeEach(() => {
        // --bail stops suites, not individual cases. Never issue more SQL after this group's first red.
        if (firstPSetFailure !== undefined)
          throw new Error('P-Set group stopped after first failure');
      });
      const compare = async (...args: Parameters<typeof comparePSetInputs>) => {
        try {
          await comparePSetInputs(...args);
        } catch (error) {
          firstPSetFailure = error;
          throw error;
        }
      };
      // These nullable virtual composite rows are query-level proof, not permitted persisted evidence.
      it('accepts equal complete documents', async () => {
        await compare(
          [{ document: pSetDocument }],
          [{ key: 'pset-key', document: pSetDocument }],
          0,
          1,
        );
      });
      it('accepts two empty sets', async () => {
        await compare([], [], 0, 0);
      });
      it('rejects a missing actual row', async () => {
        await compare([{ document: pSetDocument }], [], 1, 1);
      });
      it('rejects an extra actual row', async () => {
        await compare([], [{ key: 'pset-key', document: pSetDocument }], 1, 1);
      });
      it('retains four equal Cartesian pairs for two duplicate keys per side', async () => {
        await compare(
          [{ document: pSetDocument }, { document: pSetDocument }],
          [
            { key: 'pset-key', document: pSetDocument },
            { key: 'pset-key', document: pSetDocument },
          ],
          0,
          4,
        );
      });
      it('does not assume key uniqueness across different identities', async () => {
        const other = { ...pSetDocument, participationIdentityId: 'pset-identity-b' };
        await compare(
          [{ document: pSetDocument }, { document: other }],
          [
            { key: 'pset-key', document: pSetDocument },
            { key: 'pset-key', document: other },
          ],
          2,
          4,
        );
      });
      it('retains unmatchable NULL keys, even with equal full documents', async () => {
        const document = { ...pSetDocument, evaluationUnitKey: null };
        await compare([{ document }], [{ key: null, document }], 2, 2);
      });
      it('retains the old SQL-NULL / SQL-NULL non-difference on unmatched NULL keys', async () => {
        await compare(
          [{ document: null, sqlNull: true }],
          [{ key: null, document: null, sqlNull: true }],
          0,
          2,
        );
      });
      it('does not equate JSON null with SQL NULL', async () => {
        await compare([{ document: null }], [{ key: null, document: null, sqlNull: true }], 1, 2);
      });
      it('retains SQL-NULL actual rows versus missing expected rows', async () => {
        await compare([], [{ key: 'pset-key', document: null, sqlNull: true }], 0, 1);
      });
      it.each([
        ['participationIdentityId', 'different-identity'],
        ['memberId', 'different-member'],
        ['sessionId', 'different-session'],
        ['ruleSnapshotId', 'different-snapshot'],
        ['selectionItemId', 'different-selection'],
        ['policyId', 'different-policy'],
        ['policyVersionId', 'different-version'],
        ['definitionHash', 'd'.repeat(64)],
        ['evaluatorVersion', 2],
        ['attendanceRoleCode', 'participant'],
        ['timeCategoryCode', 'training'],
        ['durationSeconds', 3601],
        ['calculatedPoints', '1.01'],
        ['recognizedPoints', '1.01'],
        ['explanationCode', 'different-explanation'],
        ['sourceFingerprint', 'e'.repeat(64)],
        ['evaluationHash', 'f'.repeat(64)],
        [
          'sourceRefsJson',
          [
            { source: 'one', seconds: 1800, unknown: 'retained' },
            { source: 'two', seconds: 1800 },
          ],
        ],
        [
          'sourceRefsJson',
          [
            { source: 'two', seconds: 1800 },
            { source: 'one', seconds: 1800 },
          ],
        ],
        [
          'beijingDayPointsJson',
          [
            { ledgerDate: '2026-10-01', recognizedPoints: '0.50', unknown: 'retained' },
            { ledgerDate: '2026-10-02', recognizedPoints: '0.50' },
          ],
        ],
        [
          'beijingDayPointsJson',
          [
            { ledgerDate: '2026-10-02', recognizedPoints: '0.50' },
            { ledgerDate: '2026-10-01', recognizedPoints: '0.50' },
          ],
        ],
      ])('rejects a full-document mutation in %s (%#)', async (field, value) => {
        await compare(
          [{ document: pSetDocument }],
          [{ key: 'pset-key', document: { ...pSetDocument, [String(field)]: value } }],
          1,
          1,
        );
      });
      it('rejects different keys as missing plus extra rather than matching their documents', async () => {
        const document = { ...pSetDocument, evaluationUnitKey: 'different-key' };
        await compare([{ document: pSetDocument }], [{ key: 'different-key', document }], 2, 2);
      });
      it('S13 retains all six two-by-three mixed duplicate pairs and their full-document differences', async () => {
        const other = { ...pSetDocument, participationIdentityId: 'pset-other' };
        await compare(
          [{ document: pSetDocument }, { document: other }],
          [
            { key: 'pset-key', document: pSetDocument },
            { key: 'pset-key', document: pSetDocument },
            { key: 'pset-key', document: other },
          ],
          3,
          6,
        );
      });
      it.each(['', 'PSÉT-键', 'pset-key ', 'pset-key\u0301'])(
        'S13 retains a literal key without normalization (%#)',
        async (key) => {
          const document = { ...pSetDocument, evaluationUnitKey: key };
          await compare([{ document }], [{ key, document }], 0, 1);
          await compare([{ document: pSetDocument }], [{ key, document }], 2, 2);
        },
      );
    });
    // E4_TERMINAL_REAL_BEGIN
    describe('E4 terminal expected small real proof', () => {
      // Bind the actual owner before child fixtures; do not move or skip native proofs.
      const nativeMeasurementOwner = new E4NativeMeasurementOwner(
        process.env.SRVF_E4_W98 === '1',
        () => terminalMigrationLease.owner,
        S13_LOCAL_DB,
      );
      beforeAll(async () => {
        await nativeMeasurementOwner.start();
        terminalMigrationNativeOwner = nativeMeasurementOwner;
        terminalMigrationLease.owner = nativeMeasurementOwner.current().owner;
      }, 120_000);
      afterAll(async () => {
        try {
          await nativeMeasurementOwner.finish();
        } finally {
          terminalMigrationNativeOwner = undefined;
          if (process.env.SRVF_E4_W98 !== '1') terminalMigrationLease.owner = undefined;
        }
      }, 120_000);
      // Child resources close before the lease envelope's ordinary DROP and release hooks.
      beforeEach(() => {
        if (terminalMigrationFailed)
          throw new Error('Terminal small group stopped after first red');
      });
      describe('P-Set actual PostgreSQL query-level bag / NULL and full-document truth table', () => {
        beforeEach(() => {
          // --bail stops suites, not individual cases. Never issue more SQL after this group's first red.
          if (firstPSetFailure !== undefined)
            throw new Error('P-Set group stopped after first failure');
        });
        const compare = async (...args: Parameters<typeof comparePSetInputs>) => {
          try {
            await comparePSetInputs(...args);
          } catch (error) {
            terminalMigrationFailed = true;
            firstPSetFailure = error;
            throw error;
          }
        };
        // These nullable virtual composite rows are query-level proof, not permitted persisted evidence.
        it('accepts equal complete documents', async () => {
          await compare(
            [{ document: pSetDocument }],
            [{ key: 'pset-key', document: pSetDocument }],
            0,
            1,
          );
        });
        it('accepts two empty sets', async () => {
          await compare([], [], 0, 0);
        });
        it('rejects a missing actual row', async () => {
          await compare([{ document: pSetDocument }], [], 1, 1);
        });
        it('rejects an extra actual row', async () => {
          await compare([], [{ key: 'pset-key', document: pSetDocument }], 1, 1);
        });
        it('retains four equal Cartesian pairs for two duplicate keys per side', async () => {
          await compare(
            [{ document: pSetDocument }, { document: pSetDocument }],
            [
              { key: 'pset-key', document: pSetDocument },
              { key: 'pset-key', document: pSetDocument },
            ],
            0,
            4,
          );
        });
        it('does not assume key uniqueness across different identities', async () => {
          const other = { ...pSetDocument, participationIdentityId: 'pset-identity-b' };
          await compare(
            [{ document: pSetDocument }, { document: other }],
            [
              { key: 'pset-key', document: pSetDocument },
              { key: 'pset-key', document: other },
            ],
            2,
            4,
          );
        });
        it('retains unmatchable NULL keys, even with equal full documents', async () => {
          const document = { ...pSetDocument, evaluationUnitKey: null };
          await compare([{ document }], [{ key: null, document }], 2, 2);
        });
        it('retains the old SQL-NULL / SQL-NULL non-difference on unmatched NULL keys', async () => {
          await compare(
            [{ document: null, sqlNull: true }],
            [{ key: null, document: null, sqlNull: true }],
            0,
            2,
          );
        });
        it('does not equate JSON null with SQL NULL', async () => {
          await compare([{ document: null }], [{ key: null, document: null, sqlNull: true }], 1, 2);
        });
        it('retains SQL-NULL actual rows versus missing expected rows', async () => {
          await compare([], [{ key: 'pset-key', document: null, sqlNull: true }], 0, 1);
        });
        it.each([
          ['participationIdentityId', 'different-identity'],
          ['memberId', 'different-member'],
          ['sessionId', 'different-session'],
          ['ruleSnapshotId', 'different-snapshot'],
          ['selectionItemId', 'different-selection'],
          ['policyId', 'different-policy'],
          ['policyVersionId', 'different-version'],
          ['definitionHash', 'd'.repeat(64)],
          ['evaluatorVersion', 2],
          ['attendanceRoleCode', 'participant'],
          ['timeCategoryCode', 'training'],
          ['durationSeconds', 3601],
          ['calculatedPoints', '1.01'],
          ['recognizedPoints', '1.01'],
          ['explanationCode', 'different-explanation'],
          ['sourceFingerprint', 'e'.repeat(64)],
          ['evaluationHash', 'f'.repeat(64)],
          [
            'sourceRefsJson',
            [
              { source: 'one', seconds: 1800, unknown: 'retained' },
              { source: 'two', seconds: 1800 },
            ],
          ],
          [
            'sourceRefsJson',
            [
              { source: 'two', seconds: 1800 },
              { source: 'one', seconds: 1800 },
            ],
          ],
          [
            'beijingDayPointsJson',
            [
              { ledgerDate: '2026-10-01', recognizedPoints: '0.50', unknown: 'retained' },
              { ledgerDate: '2026-10-02', recognizedPoints: '0.50' },
            ],
          ],
          [
            'beijingDayPointsJson',
            [
              { ledgerDate: '2026-10-02', recognizedPoints: '0.50' },
              { ledgerDate: '2026-10-01', recognizedPoints: '0.50' },
            ],
          ],
        ])('rejects a full-document mutation in %s (%#)', async (field, value) => {
          await compare(
            [{ document: pSetDocument }],
            [{ key: 'pset-key', document: { ...pSetDocument, [String(field)]: value } }],
            1,
            1,
          );
        });
        it('rejects different keys as missing plus extra rather than matching their documents', async () => {
          const document = { ...pSetDocument, evaluationUnitKey: 'different-key' };
          await compare([{ document: pSetDocument }], [{ key: 'different-key', document }], 2, 2);
        });
        it('S13 retains all six two-by-three mixed duplicate pairs and their full-document differences', async () => {
          const other = { ...pSetDocument, participationIdentityId: 'pset-other' };
          await compare(
            [{ document: pSetDocument }, { document: other }],
            [
              { key: 'pset-key', document: pSetDocument },
              { key: 'pset-key', document: pSetDocument },
              { key: 'pset-key', document: other },
            ],
            3,
            6,
          );
        });
        it.each(['', 'PSÉT-键', 'pset-key ', 'pset-key\u0301'])(
          'S13 retains a literal key without normalization (%#)',
          async (key) => {
            const document = { ...pSetDocument, evaluationUnitKey: key };
            await compare([{ document }], [{ key, document }], 0, 1);
            await compare([{ document: pSetDocument }], [{ key, document }], 2, 2);
          },
        );
      });
      describe('E4 boolean collection small real proof', () => {
        let firstFailure: unknown;
        const prove = async (work: () => Promise<void>) => {
          if (firstFailure !== undefined || firstPSetFailure !== undefined)
            throw new Error('Boolean collection small proof stopped after first red');
          try {
            await work();
          } catch (error) {
            terminalMigrationFailed = true;
            firstFailure = error;
            throw error;
          }
        };
        type AnchoredActual = PSetActualInput & { root?: string };
        async function compareThree(
          expected: PSetExpectedInput[],
          actual: AnchoredActual[],
          differences: number,
          pairs: number,
        ) {
          const old = virtualPSetSelect(E4_P_SET_OLD_WINDOW_SQL);
          const opening = virtualPSetSelect(E4_COLLECTION_PAIR_WINDOW_SQL);
          const candidate = virtualPSetSelect(actualBooleanCollectionWindow());
          const removeFilter = (query: Prisma.Sql, filter: string) => {
            expect(query.text.split(filter)).toHaveLength(2);
            return Prisma.raw(query.text.split(filter)[0]);
          };
          const oldPairs = removeFilter(old, ' WHERE x.evaluation IS DISTINCT FROM a.evaluation');
          const openingPairs = removeFilter(
            opening,
            '\n      WHERE p.expected_evaluation IS DISTINCT FROM\n',
          );
          const candidatePairs = removeFilter(candidate, '\n      WHERE p.is_mismatch');
          const [row] = await db.$queryRaw<
            {
              oldDifferences: number;
              openingDifferences: number;
              candidateDifferences: number;
              oldPairs: number;
              openingPairs: number;
              candidatePairs: number;
            }[]
          >`
          WITH pset_expected_input AS MATERIALIZED (
            SELECT CASE WHEN coalesce((r->>'sqlNull')::boolean,false)
              THEN NULL::jsonb ELSE r->'document' END AS evaluation
            FROM jsonb_array_elements(${JSON.stringify(expected)}::jsonb) r
          ), pset_actual_input AS MATERIALIZED (
            SELECT ordinal::text AS id,coalesce(r->>'root','pset-root') AS "contributionRevisionId",
              r->>'key' AS "evaluationUnitKey",
              CASE WHEN coalesce((r->>'sqlNull')::boolean,false)
                THEN NULL::public."ParticipantContributionEvaluation"
                ELSE jsonb_populate_record(NULL::public."ParticipantContributionEvaluation",r->'document')
              END AS evaluation_row
            FROM jsonb_array_elements(${JSON.stringify(actual)}::jsonb) WITH ORDINALITY input(r,ordinal)
          )
          SELECT
            (SELECT count(*)::int FROM (${old}) d) AS "oldDifferences",
            (SELECT count(*)::int FROM (${opening}) d) AS "openingDifferences",
            (SELECT count(*)::int FROM (${candidate}) d) AS "candidateDifferences",
            (SELECT count(*)::int FROM (${oldPairs}) d) AS "oldPairs",
            (SELECT count(*)::int FROM (${openingPairs}) d) AS "openingPairs",
            (SELECT count(*)::int FROM (${candidatePairs}) d) AS "candidatePairs"
        `;
          expect(row).toEqual({
            oldDifferences: differences,
            openingDifferences: differences,
            candidateDifferences: differences,
            oldPairs: pairs,
            openingPairs: pairs,
            candidatePairs: pairs,
          });
        }
        const expected = [{ document: pSetDocument }];
        const actual = [{ key: 'pset-key', document: pSetDocument }];
        it('compares three versions on equal full documents', () =>
          prove(async () => {
            await compareThree(expected, actual, 0, 1);
          }));
        it('compares three empty bags', () =>
          prove(async () => {
            await compareThree([], [], 0, 0);
          }));
        it('retains missing rows in all three versions', () =>
          prove(async () => {
            await compareThree(expected, [], 1, 1);
          }));
        it('retains extra rows in all three versions', () =>
          prove(async () => {
            await compareThree([], actual, 1, 1);
          }));
        it('retains all six Cartesian rows for a two-by-three equal duplicate bag', () =>
          prove(async () => {
            await compareThree([...expected, ...expected], [...actual, ...actual, ...actual], 0, 6);
          }));
        it('retains cross-identity differences for the same virtual key', () =>
          prove(async () => {
            const other = { ...pSetDocument, participationIdentityId: 'pset-other' };
            await compareThree(
              [...expected, { document: other }],
              [...actual, { key: 'pset-key', document: other }],
              2,
              4,
            );
          }));
        it('does not match NULL keys', () =>
          prove(async () => {
            const document = { ...pSetDocument, evaluationUnitKey: null };
            await compareThree([{ document }], [{ key: null, document }], 2, 2);
          }));
        it('keeps SQL NULL versus SQL NULL as a non-difference', () =>
          prove(async () => {
            await compareThree(
              [{ document: null, sqlNull: true }],
              [{ key: null, document: null, sqlNull: true }],
              0,
              2,
            );
          }));
        it('distinguishes JSON null from SQL NULL', () =>
          prove(async () => {
            await compareThree(
              [{ document: null }],
              [{ key: null, document: null, sqlNull: true }],
              1,
              2,
            );
          }));
        it('retains a SQL NULL actual document with no expected document', () =>
          prove(async () => {
            await compareThree([], [{ key: 'pset-key', document: null, sqlNull: true }], 0, 1);
          }));
        it('filters a cross-root same-key actual row before matching', () =>
          prove(async () => {
            await compareThree(expected, [{ ...actual[0], root: 'pset-other-root' }], 1, 1);
          }));
        it.each(Object.keys(pSetDocument))(
          'compares the entire %s field in all three versions',
          (field) =>
            prove(async () => {
              const value: unknown = pSetDocument[field];
              const changed: unknown =
                typeof value === 'number'
                  ? value + 1
                  : Array.isArray(value)
                    ? [...value, { unexpected: 'retained' }]
                    : field === 'calculatedPoints' || field === 'recognizedPoints'
                      ? '1.01'
                      : String(value) + ' changed';
              await compareThree(
                expected,
                [{ key: 'pset-key', document: { ...pSetDocument, [field]: changed } }],
                1,
                1,
              );
            }),
        );
        it.each(['sourceRefsJson', 'beijingDayPointsJson'] as const)(
          'retains %s array order, unknown keys, JSON null and empty arrays',
          (field) =>
            prove(async () => {
              const values = pSetDocument[field] as Record<string, unknown>[];
              for (const changed of [
                [...values].reverse(),
                values.map((row, index) => (index === 0 ? { ...row, unknown: 'retained' } : row)),
                [],
                null,
              ])
                await compareThree(
                  expected,
                  [{ key: 'pset-key', document: { ...pSetDocument, [field]: changed } }],
                  1,
                  1,
                );
            }),
        );
        it.each([' 中文雪', ' ', '\t', '\u00a0'])(
          'retains Unicode and whitespace in the full document (%#)',
          (suffix) =>
            prove(async () => {
              await compareThree(
                expected,
                [
                  {
                    key: 'pset-key',
                    document: { ...pSetDocument, explanationCode: 'credited' + suffix },
                  },
                ],
                1,
                1,
              );
            }),
        );
        describe('actual guard and catalog', () => {
          let fixture: E4Fixture | undefined;
          let draftId: string;
          let submittedId: string;
          const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
          const catalog = (tx: Prisma.TransactionClient) => tx.$queryRaw<
            {
              body: string;
              md5: string;
              ownerMatches: boolean;
              invoker: boolean;
              config: string[];
              defaults: number;
              defaultExpression: string;
              aclDefault: boolean;
            }[]
          >`
          SELECT prosrc AS body,md5(prosrc) AS md5,pg_get_userbyid(proowner)=current_user AS "ownerMatches",
            NOT prosecdef AS invoker,proconfig AS config,pronargdefaults AS defaults,
            pg_get_expr(proargdefaults,0) AS "defaultExpression",proacl IS NULL AS "aclDefault"
          FROM pg_proc WHERE oid='public.e4_assert_complete(text,boolean)'::regprocedure
        `;
          beforeAll(async () => {
            if (firstFailure !== undefined || firstPSetFailure !== undefined)
              throw new Error('Boolean collection catalog setup stopped after first red');
            process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
            try {
              fixture = await createE4Fixture();
              const source = await createE4Source(fixture);
              const prepared = await prepareE4Time(fixture, source);
              const draft =
                await fixture.db.activitySettlementContributionRevision.findFirstOrThrow({
                  where: {
                    timeRevisionId: prepared.timeRevisionId,
                    settlementRunId: prepared.settlementRunId,
                    settlementVersionId: prepared.settlementVersionId,
                    kindCode: 'draft',
                  },
                });
              draftId = draft.id;
              const submitted = await submitE4Time(fixture, source, prepared);
              const proof =
                await fixture.db.activitySettlementContributionRevision.findFirstOrThrow({
                  where: {
                    settlementVersionId: submitted.settlementVersionId,
                    kindCode: 'submitted',
                  },
                });
              submittedId = proof.id;
            } catch (error) {
              terminalMigrationFailed = true;
              firstFailure = error;
              throw error;
            }
          }, 120_000);
          afterAll(async () => {
            try {
              await closeE13Fixture(fixture);
            } finally {
              if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
              else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
            }
          });

          it('compares three genuine revision bags, symmetric NULL input and all 21 exact fields on the native measurement session', () =>
            prove(async () => {
              if (!fixture) throw new Error('Terminal genuine small fixture missing');
              const f = fixture;
              const source = await createE4Source(f);
              const third = await prepareE4Time(f, source);
              const thirdRoot = await f.db.activitySettlementContributionRevision.findFirstOrThrow({
                where: { settlementVersionId: third.settlementVersionId, kindCode: 'draft' },
              });
              for (const rootId of [draftId, submittedId, thirdRoot.id])
                await assertFixedE4Oracle(f.db, rootId);
              await withTerminalNative(f.db, async (client, deadline, identity) => {
                const before = await terminalNativeIdentity(client, deadline);
                terminalAssertIdentity(before, identity);
                await client.query('BEGIN READ ONLY', [], terminalRemaining(deadline));
                const readonly = await client.query<{ readonly: boolean }>(
                  "SELECT current_setting('transaction_read_only')='on' AS readonly",
                  [],
                  terminalRemaining(deadline),
                );
                expect(readonly.rows).toEqual([{ readonly: true }]);
                for (const rootId of [draftId, submittedId, thirdRoot.id]) {
                  const root = await f.db.activitySettlementContributionRevision.findUniqueOrThrow({
                    where: { id: rootId },
                  });
                  const result = await terminalBoundedQuery<{
                    oldCount: number;
                    candidateCount: number;
                    storedCount: number;
                    differences: number;
                    storedDifferences: number;
                    completeFields: boolean;
                    nullRows: number;
                    oldNullRows: number;
                  }>(
                    client,
                    deadline,
                    terminalBagSelect(),
                    [rootId, JSON.stringify(E4_TERMINAL_DOCUMENT_KEYS)],
                    true,
                  );
                  expect(result.rows).toEqual([
                    {
                      oldCount: root.evaluationCount,
                      candidateCount: root.evaluationCount,
                      storedCount: root.evaluationCount,
                      differences: 0,
                      storedDifferences: 0,
                      completeFields: true,
                      nullRows: 0,
                      oldNullRows: 0,
                    },
                  ]);
                  expect(root.evaluationCount).toBeGreaterThan(0);
                  terminalAssertIdentity(await terminalNativeIdentity(client, deadline), identity);
                }
                // The paid deadline rejects before sending SQL; it is not a cancellation claim.
                const query = jest.spyOn(client, 'query');
                await expect(
                  terminalBoundedQuery(client, performance.now() - 1, 'SELECT 0'),
                ).rejects.toThrow();
                expect(query).not.toHaveBeenCalled();
                query.mockRestore();
                await client.query('ROLLBACK', [], terminalRemaining(deadline));
              });
            }));
          it('proves raw PG16 temporary/public NULL plans on the actual native session without accepting zero-row coverage', () =>
            prove(async () => {
              if (!fixture) throw new Error('Terminal genuine fixture missing');
              await withTerminalNative(fixture.db, async (client, deadline, identity, catalog) => {
                terminalAssertIdentity(await terminalNativeIdentity(client, deadline), identity);
                await client.query('BEGIN READ ONLY', [], terminalRemaining(deadline));
                const readonly = await client.query<{ readonly: boolean }>(
                  "SELECT current_setting('transaction_read_only')='on' AS readonly",
                  [],
                  terminalRemaining(deadline),
                );
                expect(readonly.rows).toEqual([{ readonly: true }]);
                for (const kind of ['old', 'candidate'] as const) {
                  const name =
                    kind === 'old'
                      ? 'e4_expected_evaluations_1234_opening'
                      : 'e4_expected_evaluations';
                  const schema = kind === 'old' ? 'pg_temp' : 'public';
                  const result = await terminalBoundedQuery<{ 'QUERY PLAN': unknown }>(
                    client,
                    deadline,
                    'EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, VERBOSE, FORMAT JSON) SELECT * FROM ' +
                      schema +
                      '.' +
                      name +
                      '(NULL::text)',
                    [],
                    true,
                  );
                  expect(result.rows).toHaveLength(1);
                  const raw = result.rows[0]['QUERY PLAN'];
                  const producer = terminalPlanProducer(raw, kind, catalog, identity);
                  expect(Reflect.get(producer, 'Function Name')).toBe(name);
                  expect(Reflect.get(producer, 'Schema')).toBe(schema);
                  expect(Reflect.get(producer, 'Actual Rows')).toBe(0);
                  expect(Reflect.get(producer, 'Actual Loops')).toBe(1);
                  expect(() => terminalPlanProvenance(raw, kind, catalog, identity)).toThrow(
                    'coverage mismatch',
                  );
                  terminalAssertIdentity(await terminalNativeIdentity(client, deadline), identity);
                  console.info(
                    'E4_TERMINAL_NULL_PLAN_SOURCE',
                    JSON.stringify({
                      kind,
                      functionName: Reflect.get(producer, 'Function Name'),
                      schema: Reflect.get(producer, 'Schema'),
                      rows: Reflect.get(producer, 'Actual Rows'),
                      loops: Reflect.get(producer, 'Actual Loops'),
                      sameBackend: true,
                      completeCatalog: true,
                      fullCoverageRejected: true,
                    }),
                  );
                }
                await client.query('ROLLBACK', [], terminalRemaining(deadline));
              });
            }));
          it('closes a real read-only transaction and installed temporary object after a controlled post-DDL failure', () =>
            prove(async () => {
              if (!fixture) throw new Error('Terminal genuine fixture missing');
              const f = fixture;
              const expected = new Error('Terminal controlled post-DDL failure');
              // Catch only the prescribed fault after real ROLLBACK/drop/close has succeeded.
              await expect(
                withTerminalNative(
                  f.db,
                  async (client, deadline) => {
                    await client.query('BEGIN READ ONLY', [], terminalRemaining(deadline));
                    throw expected;
                  },
                  expected,
                ),
              ).rejects.toBe(expected);
              // The deliberate callback fault was fully closed, not a test failure or UNKNOWN.
              if (terminalMigrationPending !== 0)
                throw new Error('Terminal expected fault cleanup still pending');
              expect(terminalMigrationFailed).toBe(false);
            }));

          it('executes the actual complete guard and proves exact full prosrc and catalog properties', () =>
            prove(async () => {
              if (!fixture) throw new Error('Boolean collection real fixture missing');
              await fixture.db.$queryRaw`SELECT public.e4_assert_complete(${draftId},FALSE)::text`;
              await fixture.db
                .$queryRaw`SELECT public.e4_assert_complete(${submittedId},TRUE)::text`;
              const rows = await catalog(fixture.db);
              expect(rows).toHaveLength(1);
              const body = [
                ...rawS13MigrationSource().matchAll(
                  /CREATE FUNCTION e4_assert_complete\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/gu,
                ),
              ][0][1];
              expect(rows[0]).toEqual({
                body,
                md5: E4_BOOLEAN_COMPLETE_MD5,
                ownerMatches: true,
                invoker: true,
                config: ['search_path=pg_catalog, public'],
                defaults: 1,
                defaultExpression: 'true',
                aclDefault: true,
              });
              expect(restoreBooleanCollectionWindow(rows[0].body)).toContain(
                E4_COLLECTION_PAIR_WINDOW_SQL,
              );
              for (const name of ['e4_expected_evaluations', 'e4_evaluation_document'] as const) {
                const signature =
                  name === 'e4_expected_evaluations'
                    ? 'public.e4_expected_evaluations(text)'
                    : 'public.e4_evaluation_document(public."ParticipantContributionEvaluation")';
                const definitions = [
                  ...rawS13MigrationSource().matchAll(
                    new RegExp(
                      'CREATE FUNCTION ' + name + '\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;',
                      'gu',
                    ),
                  ),
                ];
                expect(definitions).toHaveLength(1);
                const [builder] = await fixture.db.$queryRaw<
                  {
                    body: string;
                    ownerMatches: boolean;
                    invoker: boolean;
                    volatility: string;
                    strict: boolean;
                    config: string[];
                    aclDefault: boolean;
                  }[]
                >`
                SELECT prosrc AS body,pg_get_userbyid(proowner)=current_user AS "ownerMatches",
                  NOT prosecdef AS invoker,provolatile::text AS volatility,proisstrict AS strict,
                  proconfig AS config,proacl IS NULL AS "aclDefault"
                FROM pg_proc WHERE oid=to_regprocedure(${signature})
              `;
                expect(builder).toEqual({
                  body: definitions[0][1],
                  ownerMatches: true,
                  invoker: true,
                  volatility: name === 'e4_expected_evaluations' ? 's' : 'i',
                  strict: name === 'e4_evaluation_document',
                  config: ['search_path=pg_catalog, public'],
                  aclDefault: true,
                });
              }
            }));
          it.each([
            'historical_body',
            'same_name_fake_body',
            'security_definer',
            'changed_search_path',
          ] as const)(
            'rejects %s for a genuine submitted anchor and restores the catalog by rollback',
            (point) =>
              prove(async () => {
                if (!fixture) throw new Error('Boolean collection real fixture missing');
                const f = fixture;
                const contributions = f.app.get(ActivityContributionSettlementService);
                const proof = await f.db.activitySettlementContributionRevision.findUniqueOrThrow({
                  where: { id: submittedId },
                });
                const anchor = {
                  activityId: proof.activityId,
                  settlementRunId: proof.settlementRunId,
                  settlementVersionId: proof.settlementVersionId,
                  evidenceSealId: proof.evidenceSealId,
                  evidenceRevision: proof.evidenceRevision,
                  populationRevision: proof.populationRevision,
                  workflowRevision: proof.workflowRevision,
                };
                const before = await catalog(f.db);
                const rollback = new Error('Boolean collection controlled catalog rollback');
                await expect(
                  f.db.$transaction(async (tx) => {
                    expect(
                      await contributions.readFirstReviewBarrierCandidateInTx(tx, anchor),
                    ).not.toBeNull();
                    if (point === 'historical_body' || point === 'same_name_fake_body') {
                      const definitions = [
                        ...rawS13MigrationSource().matchAll(
                          /CREATE FUNCTION e4_assert_complete\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/gu,
                        ),
                      ];
                      expect(definitions).toHaveLength(1);
                      let definition = definitions[0][0];
                      if (point === 'historical_body')
                        definition = restoreCollectionPairWindow(
                          restoreBooleanCollectionWindow(definition),
                        );
                      else
                        definition = definition.replace(
                          definitions[0][1],
                          () => '\nBEGIN RETURN; END;\n',
                        );
                      await tx.$executeRaw(
                        Prisma.raw(
                          definition.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'),
                        ),
                      );
                      const changed = await catalog(tx);
                      expect(changed[0].md5).not.toBe(E4_BOOLEAN_COMPLETE_MD5);
                      if (point === 'historical_body')
                        expect(changed[0].md5).toBe('edd162a44264b0d073d0009d3e592d0e');
                    } else if (point === 'security_definer') {
                      await tx.$executeRaw`ALTER FUNCTION public.e4_assert_complete(text,boolean) SECURITY DEFINER`;
                    } else {
                      await tx.$executeRaw`ALTER FUNCTION public.e4_assert_complete(text,boolean) SET search_path = public, pg_catalog`;
                    }
                    await expect(
                      contributions.readFirstReviewBarrierCandidateInTx(tx, anchor),
                    ).rejects.toMatchObject({
                      biz: BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY,
                    });
                    throw rollback;
                  }),
                ).rejects.toBe(rollback);
                expect(await catalog(f.db)).toEqual(before);
              }),
          );
          it.each([
            ['wrong document', { explanationCode: 'tampered' }, '23514', 'e4_evaluation_guard'],
            [
              'FK before mismatch',
              { definitionHash: '0'.repeat(64), explanationCode: 'tampered' },
              '23503',
              'e4_evaluation_policy_fk',
            ],
            [
              'shape before FK and mismatch',
              { evaluatorVersion: 2, definitionHash: '0'.repeat(64), explanationCode: 'tampered' },
              '23514',
              'e4_evaluation_shape_check',
            ],
          ] as const)(
            'keeps the exact first rejection and zero partial facts: %s',
            (_label, mutation, state, constraint) =>
              prove(async () => {
                if (!fixture) throw new Error('Boolean collection real fixture missing');
                const f = fixture;
                const counts = async () => ({
                  roots: await f.db.activitySettlementContributionRevision.count(),
                  evaluations: await f.db.participantContributionEvaluation.count(),
                  receipts: await f.db.activitySettlementTimeCommandReceipt.count(),
                  audits: await f.db.auditLog.count(),
                });
                const before = await counts();
                const rollback = new Error('Boolean collection real negative rollback');
                await expect(
                  f.db.$transaction(async (tx) => {
                    const original =
                      await tx.activitySettlementContributionRevision.findUniqueOrThrow({
                        where: { id: draftId },
                      });
                    const latest = await tx.activitySettlementContributionRevision.findFirstOrThrow(
                      {
                        where: { settlementRunId: original.settlementRunId },
                        orderBy: { revision: 'desc' },
                      },
                    );
                    const data = Object.fromEntries(
                      Object.entries(original).filter(
                        ([key]) => !['id', 'createdAt', 'updatedAt'].includes(key),
                      ),
                    ) as Omit<typeof original, 'id' | 'createdAt' | 'updatedAt'>;
                    const copy = await tx.activitySettlementContributionRevision.create({
                      data: {
                        ...data,
                        revision: latest.revision + 1,
                        operationKey: f.key('bool_negative'),
                      },
                    });
                    const row = await tx.participantContributionEvaluation.findFirstOrThrow({
                      where: { contributionRevisionId: draftId },
                    });
                    const [quoted] = await tx.$queryRaw<
                      { copy: string; root: string; first: string; mutation: string }[]
                    >`
                SELECT quote_nullable(${copy.id}::text) AS copy,quote_nullable(${draftId}::text) AS root,
                  quote_nullable(${row.id}::text) AS first,quote_nullable(${JSON.stringify(mutation)}::jsonb) AS mutation
              `;
                    await tx.$executeRawUnsafe(`DO $boolean_negative$
                DECLARE actual_state TEXT='00000'; actual_constraint TEXT='';
                BEGIN
                  BEGIN
                    INSERT INTO "ParticipantContributionEvaluation"
                    SELECT changed.* FROM "ParticipantContributionEvaluation" e
                    CROSS JOIN LATERAL jsonb_populate_record(NULL::"ParticipantContributionEvaluation",
                      to_jsonb(e)||jsonb_build_object('id',${quoted.copy}::text||':'||e.id,
                        'contributionRevisionId',${quoted.copy}::text)||
                      CASE WHEN e.id=${quoted.first}::text THEN ${quoted.mutation}::jsonb ELSE '{}'::jsonb END) changed
                    WHERE e."contributionRevisionId"=${quoted.root}::text;
                    PERFORM e4_assert_complete(${quoted.copy}::text,FALSE);
                  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS
                    actual_state=RETURNED_SQLSTATE,actual_constraint=CONSTRAINT_NAME;
                  END;
                  IF actual_state<>'${String(state)}' OR actual_constraint<>'${String(constraint)}' THEN
                    RAISE EXCEPTION 'Boolean collection exact first rejection differs' USING ERRCODE='23514';
                  END IF;
                END $boolean_negative$;`);
                    throw rollback;
                  }),
                ).rejects.toBe(rollback);
                expect(await counts()).toEqual(before);
              }),
          );
        });
      });
      it('P-Day actual format CASE retains real prosrc, properties, SQL three values and complete old outcomes', async () => {
        await withFixedOldDayOracle(db, async (tx) => {
          const actual = rawS13MigrationSource();
          formatProbeInverse(booleanCollectionHistorySource(actual));
          const window = [...actual.matchAll(E4_P_DAY_FUNCTION_WINDOW)][0][0];
          const body = window.slice(window.indexOf(' AS $$\n') + ' AS $$'.length, -'$$;\n'.length);
          const [metadata] = await tx.$queryRaw<
            {
              body: string;
              ownerMatches: boolean;
              invoker: boolean;
              immutable: boolean;
              nonStrict: boolean;
              unsafeParallel: boolean;
              config: string[];
              aclDefault: boolean;
            }[]
          >`
          SELECT prosrc AS body,pg_get_userbyid(proowner)=current_user AS "ownerMatches",
            NOT prosecdef AS invoker,provolatile='i' AS immutable,NOT proisstrict AS "nonStrict",
            proparallel='u' AS "unsafeParallel",proconfig AS config,proacl IS NULL AS "aclDefault"
          FROM pg_proc WHERE oid='public.e4_day_points(jsonb,integer)'::regprocedure
        `;
          expect(metadata).toEqual({
            body,
            ownerMatches: true,
            invoker: true,
            immutable: true,
            nonStrict: true,
            unsafeParallel: true,
            config: ['search_path=pg_catalog, public'],
            aclDefault: true,
          });
          const payload = JSON.stringify([
            ...formatTextMatrix().map((value) => ({ startsAt: value })),
            {},
          ]);
          const [truth] = await tx.$queryRaw<
            { count: number; matches: boolean; nulls: number; positives: number }[]
          >`
          WITH format_values AS MATERIALIZED (SELECT value AS ref FROM jsonb_array_elements(${payload}::jsonb)),
          compared AS MATERIALIZED (SELECT ${Prisma.raw(formatRegex('startsAt'))} AS old,
            ${Prisma.raw(formatCase('startsAt'))} AS candidate,
            pg_catalog.translate(ref->>'startsAt','0123456789','0000000000') COLLATE "C"
              = ${E4_FORMAT_TEMPLATE} COLLATE "C" AS positive FROM format_values)
          SELECT count(*)::int AS count,bool_and(old IS NOT DISTINCT FROM candidate) AS matches,
            count(*) FILTER(WHERE old IS NULL)::int AS nulls,count(*) FILTER(WHERE positive IS TRUE)::int AS positives FROM compared
        `;
          expect(truth).toEqual({
            count: formatTextMatrix().length + 1,
            matches: true,
            nulls: 2,
            positives: 171,
          });
          const [quoted] = await tx.$queryRaw<
            { matrix: string }[]
          >`SELECT quote_nullable(${JSON.stringify(formatDayMatrix())}::jsonb) AS matrix`;
          await tx.$executeRawUnsafe(`DO $e4_actual_format_compare$
          DECLARE item jsonb; refs jsonb; amount integer; fn text; outcome jsonb; opening jsonb;
            result jsonb; state text; con text; msg text; detail text;
          BEGIN
            FOR item IN SELECT value FROM jsonb_array_elements(${quoted.matrix}::jsonb) LOOP
              refs=CASE WHEN item->'refs'='null'::jsonb THEN NULL ELSE item->'refs' END;
              amount=(item->>'amount')::integer; opening=NULL;
              FOREACH fn IN ARRAY ARRAY['pg_temp.e4_day_points_1220_oracle','public.e4_day_points'] LOOP
                result=NULL; state='00000'; con=''; msg=''; detail='';
                BEGIN EXECUTE format('SELECT %s($1,$2)',fn) INTO result USING refs,amount;
                EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS state=RETURNED_SQLSTATE,
                  con=CONSTRAINT_NAME,msg=MESSAGE_TEXT,detail=PG_EXCEPTION_DETAIL; END;
                outcome=jsonb_build_object('result',result,'state',state,'constraint',con,'message',msg,'detail',detail);
                IF opening IS NULL THEN opening=outcome;
                ELSIF opening IS DISTINCT FROM outcome THEN
                  RAISE EXCEPTION 'E4 actual format full oracle outcome mismatch' USING ERRCODE='23514';
                END IF;
              END LOOP;
            END LOOP;
          END $e4_actual_format_compare$;`);
        });
      });
    });
    // E4_TERMINAL_REAL_END

    describe('E4 boolean collection small real proof', () => {
      let firstFailure: unknown;
      const prove = async (work: () => Promise<void>) => {
        if (firstFailure !== undefined || firstPSetFailure !== undefined)
          throw new Error('Boolean collection small proof stopped after first red');
        try {
          await work();
        } catch (error) {
          firstFailure = error;
          throw error;
        }
      };
      type AnchoredActual = PSetActualInput & { root?: string };
      async function compareThree(
        expected: PSetExpectedInput[],
        actual: AnchoredActual[],
        differences: number,
        pairs: number,
      ) {
        const old = virtualPSetSelect(E4_P_SET_OLD_WINDOW_SQL);
        const opening = virtualPSetSelect(E4_COLLECTION_PAIR_WINDOW_SQL);
        const candidate = virtualPSetSelect(actualBooleanCollectionWindow());
        const removeFilter = (query: Prisma.Sql, filter: string) => {
          expect(query.text.split(filter)).toHaveLength(2);
          return Prisma.raw(query.text.split(filter)[0]);
        };
        const oldPairs = removeFilter(old, ' WHERE x.evaluation IS DISTINCT FROM a.evaluation');
        const openingPairs = removeFilter(
          opening,
          '\n      WHERE p.expected_evaluation IS DISTINCT FROM\n',
        );
        const candidatePairs = removeFilter(candidate, '\n      WHERE p.is_mismatch');
        const [row] = await db.$queryRaw<
          {
            oldDifferences: number;
            openingDifferences: number;
            candidateDifferences: number;
            oldPairs: number;
            openingPairs: number;
            candidatePairs: number;
          }[]
        >`
          WITH pset_expected_input AS MATERIALIZED (
            SELECT CASE WHEN coalesce((r->>'sqlNull')::boolean,false)
              THEN NULL::jsonb ELSE r->'document' END AS evaluation
            FROM jsonb_array_elements(${JSON.stringify(expected)}::jsonb) r
          ), pset_actual_input AS MATERIALIZED (
            SELECT ordinal::text AS id,coalesce(r->>'root','pset-root') AS "contributionRevisionId",
              r->>'key' AS "evaluationUnitKey",
              CASE WHEN coalesce((r->>'sqlNull')::boolean,false)
                THEN NULL::public."ParticipantContributionEvaluation"
                ELSE jsonb_populate_record(NULL::public."ParticipantContributionEvaluation",r->'document')
              END AS evaluation_row
            FROM jsonb_array_elements(${JSON.stringify(actual)}::jsonb) WITH ORDINALITY input(r,ordinal)
          )
          SELECT
            (SELECT count(*)::int FROM (${old}) d) AS "oldDifferences",
            (SELECT count(*)::int FROM (${opening}) d) AS "openingDifferences",
            (SELECT count(*)::int FROM (${candidate}) d) AS "candidateDifferences",
            (SELECT count(*)::int FROM (${oldPairs}) d) AS "oldPairs",
            (SELECT count(*)::int FROM (${openingPairs}) d) AS "openingPairs",
            (SELECT count(*)::int FROM (${candidatePairs}) d) AS "candidatePairs"
        `;
        expect(row).toEqual({
          oldDifferences: differences,
          openingDifferences: differences,
          candidateDifferences: differences,
          oldPairs: pairs,
          openingPairs: pairs,
          candidatePairs: pairs,
        });
      }
      const expected = [{ document: pSetDocument }];
      const actual = [{ key: 'pset-key', document: pSetDocument }];
      it('compares three versions on equal full documents', () =>
        prove(async () => {
          await compareThree(expected, actual, 0, 1);
        }));
      it('compares three empty bags', () =>
        prove(async () => {
          await compareThree([], [], 0, 0);
        }));
      it('retains missing rows in all three versions', () =>
        prove(async () => {
          await compareThree(expected, [], 1, 1);
        }));
      it('retains extra rows in all three versions', () =>
        prove(async () => {
          await compareThree([], actual, 1, 1);
        }));
      it('retains all six Cartesian rows for a two-by-three equal duplicate bag', () =>
        prove(async () => {
          await compareThree([...expected, ...expected], [...actual, ...actual, ...actual], 0, 6);
        }));
      it('retains cross-identity differences for the same virtual key', () =>
        prove(async () => {
          const other = { ...pSetDocument, participationIdentityId: 'pset-other' };
          await compareThree(
            [...expected, { document: other }],
            [...actual, { key: 'pset-key', document: other }],
            2,
            4,
          );
        }));
      it('does not match NULL keys', () =>
        prove(async () => {
          const document = { ...pSetDocument, evaluationUnitKey: null };
          await compareThree([{ document }], [{ key: null, document }], 2, 2);
        }));
      it('keeps SQL NULL versus SQL NULL as a non-difference', () =>
        prove(async () => {
          await compareThree(
            [{ document: null, sqlNull: true }],
            [{ key: null, document: null, sqlNull: true }],
            0,
            2,
          );
        }));
      it('distinguishes JSON null from SQL NULL', () =>
        prove(async () => {
          await compareThree(
            [{ document: null }],
            [{ key: null, document: null, sqlNull: true }],
            1,
            2,
          );
        }));
      it('retains a SQL NULL actual document with no expected document', () =>
        prove(async () => {
          await compareThree([], [{ key: 'pset-key', document: null, sqlNull: true }], 0, 1);
        }));
      it('filters a cross-root same-key actual row before matching', () =>
        prove(async () => {
          await compareThree(expected, [{ ...actual[0], root: 'pset-other-root' }], 1, 1);
        }));
      it.each(Object.keys(pSetDocument))(
        'compares the entire %s field in all three versions',
        (field) =>
          prove(async () => {
            const value: unknown = pSetDocument[field];
            const changed: unknown =
              typeof value === 'number'
                ? value + 1
                : Array.isArray(value)
                  ? [...value, { unexpected: 'retained' }]
                  : field === 'calculatedPoints' || field === 'recognizedPoints'
                    ? '1.01'
                    : String(value) + ' changed';
            await compareThree(
              expected,
              [{ key: 'pset-key', document: { ...pSetDocument, [field]: changed } }],
              1,
              1,
            );
          }),
      );
      it.each(['sourceRefsJson', 'beijingDayPointsJson'] as const)(
        'retains %s array order, unknown keys, JSON null and empty arrays',
        (field) =>
          prove(async () => {
            const values = pSetDocument[field] as Record<string, unknown>[];
            for (const changed of [
              [...values].reverse(),
              values.map((row, index) => (index === 0 ? { ...row, unknown: 'retained' } : row)),
              [],
              null,
            ])
              await compareThree(
                expected,
                [{ key: 'pset-key', document: { ...pSetDocument, [field]: changed } }],
                1,
                1,
              );
          }),
      );
      it.each([' 中文雪', ' ', '\t', '\u00a0'])(
        'retains Unicode and whitespace in the full document (%#)',
        (suffix) =>
          prove(async () => {
            await compareThree(
              expected,
              [
                {
                  key: 'pset-key',
                  document: { ...pSetDocument, explanationCode: 'credited' + suffix },
                },
              ],
              1,
              1,
            );
          }),
      );
      describe('actual guard and catalog', () => {
        let fixture: E4Fixture | undefined;
        let draftId: string;
        let submittedId: string;
        const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
        const catalog = (tx: Prisma.TransactionClient) => tx.$queryRaw<
          {
            body: string;
            md5: string;
            ownerMatches: boolean;
            invoker: boolean;
            config: string[];
            defaults: number;
            defaultExpression: string;
            aclDefault: boolean;
          }[]
        >`
          SELECT prosrc AS body,md5(prosrc) AS md5,pg_get_userbyid(proowner)=current_user AS "ownerMatches",
            NOT prosecdef AS invoker,proconfig AS config,pronargdefaults AS defaults,
            pg_get_expr(proargdefaults,0) AS "defaultExpression",proacl IS NULL AS "aclDefault"
          FROM pg_proc WHERE oid='public.e4_assert_complete(text,boolean)'::regprocedure
        `;
        beforeAll(async () => {
          if (firstFailure !== undefined || firstPSetFailure !== undefined)
            throw new Error('Boolean collection catalog setup stopped after first red');
          process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
          try {
            fixture = await createE4Fixture();
            const source = await createE4Source(fixture);
            const prepared = await prepareE4Time(fixture, source);
            const draft = await fixture.db.activitySettlementContributionRevision.findFirstOrThrow({
              where: {
                timeRevisionId: prepared.timeRevisionId,
                settlementRunId: prepared.settlementRunId,
                settlementVersionId: prepared.settlementVersionId,
                kindCode: 'draft',
              },
            });
            draftId = draft.id;
            const submitted = await submitE4Time(fixture, source, prepared);
            const proof = await fixture.db.activitySettlementContributionRevision.findFirstOrThrow({
              where: { settlementVersionId: submitted.settlementVersionId, kindCode: 'submitted' },
            });
            submittedId = proof.id;
          } catch (error) {
            firstFailure = error;
            throw error;
          }
        }, 120_000);
        afterAll(async () => {
          try {
            await closeE13Fixture(fixture);
          } finally {
            if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
            else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
          }
        });
        it('executes the actual complete guard and proves exact full prosrc and catalog properties', () =>
          prove(async () => {
            if (!fixture) throw new Error('Boolean collection real fixture missing');
            await fixture.db.$queryRaw`SELECT public.e4_assert_complete(${draftId},FALSE)::text`;
            await fixture.db.$queryRaw`SELECT public.e4_assert_complete(${submittedId},TRUE)::text`;
            const rows = await catalog(fixture.db);
            expect(rows).toHaveLength(1);
            const body = [
              ...rawS13MigrationSource().matchAll(
                /CREATE FUNCTION e4_assert_complete\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/gu,
              ),
            ][0][1];
            expect(rows[0]).toEqual({
              body,
              md5: E4_BOOLEAN_COMPLETE_MD5,
              ownerMatches: true,
              invoker: true,
              config: ['search_path=pg_catalog, public'],
              defaults: 1,
              defaultExpression: 'true',
              aclDefault: true,
            });
            expect(restoreBooleanCollectionWindow(rows[0].body)).toContain(
              E4_COLLECTION_PAIR_WINDOW_SQL,
            );
            for (const name of ['e4_expected_evaluations', 'e4_evaluation_document'] as const) {
              const signature =
                name === 'e4_expected_evaluations'
                  ? 'public.e4_expected_evaluations(text)'
                  : 'public.e4_evaluation_document(public."ParticipantContributionEvaluation")';
              const definitions = [
                ...rawS13MigrationSource().matchAll(
                  new RegExp(
                    'CREATE FUNCTION ' + name + '\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;',
                    'gu',
                  ),
                ),
              ];
              expect(definitions).toHaveLength(1);
              const [builder] = await fixture.db.$queryRaw<
                {
                  body: string;
                  ownerMatches: boolean;
                  invoker: boolean;
                  volatility: string;
                  strict: boolean;
                  config: string[];
                  aclDefault: boolean;
                }[]
              >`
                SELECT prosrc AS body,pg_get_userbyid(proowner)=current_user AS "ownerMatches",
                  NOT prosecdef AS invoker,provolatile::text AS volatility,proisstrict AS strict,
                  proconfig AS config,proacl IS NULL AS "aclDefault"
                FROM pg_proc WHERE oid=to_regprocedure(${signature})
              `;
              expect(builder).toEqual({
                body: definitions[0][1],
                ownerMatches: true,
                invoker: true,
                volatility: name === 'e4_expected_evaluations' ? 's' : 'i',
                strict: name === 'e4_evaluation_document',
                config: ['search_path=pg_catalog, public'],
                aclDefault: true,
              });
            }
          }));
        it.each([
          'historical_body',
          'same_name_fake_body',
          'security_definer',
          'changed_search_path',
        ] as const)(
          'rejects %s for a genuine submitted anchor and restores the catalog by rollback',
          (point) =>
            prove(async () => {
              if (!fixture) throw new Error('Boolean collection real fixture missing');
              const f = fixture;
              const contributions = f.app.get(ActivityContributionSettlementService);
              const proof = await f.db.activitySettlementContributionRevision.findUniqueOrThrow({
                where: { id: submittedId },
              });
              const anchor = {
                activityId: proof.activityId,
                settlementRunId: proof.settlementRunId,
                settlementVersionId: proof.settlementVersionId,
                evidenceSealId: proof.evidenceSealId,
                evidenceRevision: proof.evidenceRevision,
                populationRevision: proof.populationRevision,
                workflowRevision: proof.workflowRevision,
              };
              const before = await catalog(f.db);
              const rollback = new Error('Boolean collection controlled catalog rollback');
              await expect(
                f.db.$transaction(async (tx) => {
                  expect(
                    await contributions.readFirstReviewBarrierCandidateInTx(tx, anchor),
                  ).not.toBeNull();
                  if (point === 'historical_body' || point === 'same_name_fake_body') {
                    const definitions = [
                      ...rawS13MigrationSource().matchAll(
                        /CREATE FUNCTION e4_assert_complete\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/gu,
                      ),
                    ];
                    expect(definitions).toHaveLength(1);
                    let definition = definitions[0][0];
                    if (point === 'historical_body')
                      definition = restoreCollectionPairWindow(
                        restoreBooleanCollectionWindow(definition),
                      );
                    else
                      definition = definition.replace(
                        definitions[0][1],
                        () => '\nBEGIN RETURN; END;\n',
                      );
                    await tx.$executeRaw(
                      Prisma.raw(
                        definition.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'),
                      ),
                    );
                    const changed = await catalog(tx);
                    expect(changed[0].md5).not.toBe(E4_BOOLEAN_COMPLETE_MD5);
                    if (point === 'historical_body')
                      expect(changed[0].md5).toBe('edd162a44264b0d073d0009d3e592d0e');
                  } else if (point === 'security_definer') {
                    await tx.$executeRaw`ALTER FUNCTION public.e4_assert_complete(text,boolean) SECURITY DEFINER`;
                  } else {
                    await tx.$executeRaw`ALTER FUNCTION public.e4_assert_complete(text,boolean) SET search_path = public, pg_catalog`;
                  }
                  await expect(
                    contributions.readFirstReviewBarrierCandidateInTx(tx, anchor),
                  ).rejects.toMatchObject({
                    biz: BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY,
                  });
                  throw rollback;
                }),
              ).rejects.toBe(rollback);
              expect(await catalog(f.db)).toEqual(before);
            }),
        );
        it.each([
          ['wrong document', { explanationCode: 'tampered' }, '23514', 'e4_evaluation_guard'],
          [
            'FK before mismatch',
            { definitionHash: '0'.repeat(64), explanationCode: 'tampered' },
            '23503',
            'e4_evaluation_policy_fk',
          ],
          [
            'shape before FK and mismatch',
            { evaluatorVersion: 2, definitionHash: '0'.repeat(64), explanationCode: 'tampered' },
            '23514',
            'e4_evaluation_shape_check',
          ],
        ] as const)(
          'keeps the exact first rejection and zero partial facts: %s',
          (_label, mutation, state, constraint) =>
            prove(async () => {
              if (!fixture) throw new Error('Boolean collection real fixture missing');
              const f = fixture;
              const counts = async () => ({
                roots: await f.db.activitySettlementContributionRevision.count(),
                evaluations: await f.db.participantContributionEvaluation.count(),
                receipts: await f.db.activitySettlementTimeCommandReceipt.count(),
                audits: await f.db.auditLog.count(),
              });
              const before = await counts();
              const rollback = new Error('Boolean collection real negative rollback');
              await expect(
                f.db.$transaction(async (tx) => {
                  const original =
                    await tx.activitySettlementContributionRevision.findUniqueOrThrow({
                      where: { id: draftId },
                    });
                  const latest = await tx.activitySettlementContributionRevision.findFirstOrThrow({
                    where: { settlementRunId: original.settlementRunId },
                    orderBy: { revision: 'desc' },
                  });
                  const data = Object.fromEntries(
                    Object.entries(original).filter(
                      ([key]) => !['id', 'createdAt', 'updatedAt'].includes(key),
                    ),
                  ) as Omit<typeof original, 'id' | 'createdAt' | 'updatedAt'>;
                  const copy = await tx.activitySettlementContributionRevision.create({
                    data: {
                      ...data,
                      revision: latest.revision + 1,
                      operationKey: f.key('bool_negative'),
                    },
                  });
                  const row = await tx.participantContributionEvaluation.findFirstOrThrow({
                    where: { contributionRevisionId: draftId },
                  });
                  const [quoted] = await tx.$queryRaw<
                    { copy: string; root: string; first: string; mutation: string }[]
                  >`
                SELECT quote_nullable(${copy.id}::text) AS copy,quote_nullable(${draftId}::text) AS root,
                  quote_nullable(${row.id}::text) AS first,quote_nullable(${JSON.stringify(mutation)}::jsonb) AS mutation
              `;
                  await tx.$executeRawUnsafe(`DO $boolean_negative$
                DECLARE actual_state TEXT='00000'; actual_constraint TEXT='';
                BEGIN
                  BEGIN
                    INSERT INTO "ParticipantContributionEvaluation"
                    SELECT changed.* FROM "ParticipantContributionEvaluation" e
                    CROSS JOIN LATERAL jsonb_populate_record(NULL::"ParticipantContributionEvaluation",
                      to_jsonb(e)||jsonb_build_object('id',${quoted.copy}::text||':'||e.id,
                        'contributionRevisionId',${quoted.copy}::text)||
                      CASE WHEN e.id=${quoted.first}::text THEN ${quoted.mutation}::jsonb ELSE '{}'::jsonb END) changed
                    WHERE e."contributionRevisionId"=${quoted.root}::text;
                    PERFORM e4_assert_complete(${quoted.copy}::text,FALSE);
                  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS
                    actual_state=RETURNED_SQLSTATE,actual_constraint=CONSTRAINT_NAME;
                  END;
                  IF actual_state<>'${String(state)}' OR actual_constraint<>'${String(constraint)}' THEN
                    RAISE EXCEPTION 'Boolean collection exact first rejection differs' USING ERRCODE='23514';
                  END IF;
                END $boolean_negative$;`);
                  throw rollback;
                }),
              ).rejects.toBe(rollback);
              expect(await counts()).toEqual(before);
            }),
        );
      });
    });
    it('P-Set retains real PK / identity-scoped key, complete document attributes and invoker metadata', async () => {
      const [builder] = await db.$queryRaw<
        {
          ownerMatches: boolean;
          strict: boolean;
          immutable: boolean;
          invoker: boolean;
          config: string[];
          aclDefault: boolean;
          body: string;
        }[]
      >`
        SELECT pg_get_userbyid(proowner)=current_user AS "ownerMatches",proisstrict AS strict,
          provolatile='i' AS immutable,NOT prosecdef AS invoker,proconfig AS config,
          proacl IS NULL AS "aclDefault",pg_get_functiondef(oid) AS body
        FROM pg_proc WHERE oid='public.e4_evaluation_document(public."ParticipantContributionEvaluation")'::regprocedure
      `;
      expect(builder).toMatchObject({
        ownerMatches: true,
        strict: true,
        immutable: true,
        invoker: true,
        config: ['search_path=pg_catalog, public'],
        aclDefault: true,
      });
      const [actualStoredGuard] = await db.$queryRaw<{ invoker: boolean; body: string }[]>`
        SELECT NOT prosecdef AS invoker,pg_get_functiondef(oid) AS body
        FROM pg_proc WHERE oid='public.e4_assert_complete(text,boolean)'::regprocedure
      `;
      const storedGuard = {
        ...actualStoredGuard,
        body: restoreBooleanCollectionWindow(actualStoredGuard.body),
      };
      expect(storedGuard.body).toContain(actualCollectionPairWindow());
      const guard = {
        ...storedGuard,
        body: restoreS13Window(restoreCollectionPairWindow(storedGuard.body)),
      };
      expect(guard.invoker).toBe(true);
      expect(guard.body).toContain(actualPSetWindow());
      const keys = await db.$queryRaw<{ name: string; unique: boolean; columns: string[] }[]>`
        SELECT c.relname AS name,i.indisunique AS unique,array_agg(a.attname::text ORDER BY k.ordinality) AS columns
        FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
        CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
        WHERE c.relnamespace='public'::regnamespace AND c.relname IN ('ParticipantContributionEvaluation_pkey','e4_evaluation_unit_key')
        GROUP BY c.relname,i.indisunique ORDER BY c.relname
      `;
      expect(keys).toEqual([
        { name: 'ParticipantContributionEvaluation_pkey', unique: true, columns: ['id'] },
        {
          name: 'e4_evaluation_unit_key',
          unique: true,
          columns: ['contributionRevisionId', 'participationIdentityId', 'evaluationUnitKey'],
        },
      ]);
    });
    it('P-Day actual format CASE retains real prosrc, properties, SQL three values and complete old outcomes', async () => {
      await withFixedOldDayOracle(db, async (tx) => {
        const actual = rawS13MigrationSource();
        formatProbeInverse(booleanCollectionHistorySource(actual));
        const window = [...actual.matchAll(E4_P_DAY_FUNCTION_WINDOW)][0][0];
        const body = window.slice(window.indexOf(' AS $$\n') + ' AS $$'.length, -'$$;\n'.length);
        const [metadata] = await tx.$queryRaw<
          {
            body: string;
            ownerMatches: boolean;
            invoker: boolean;
            immutable: boolean;
            nonStrict: boolean;
            unsafeParallel: boolean;
            config: string[];
            aclDefault: boolean;
          }[]
        >`
          SELECT prosrc AS body,pg_get_userbyid(proowner)=current_user AS "ownerMatches",
            NOT prosecdef AS invoker,provolatile='i' AS immutable,NOT proisstrict AS "nonStrict",
            proparallel='u' AS "unsafeParallel",proconfig AS config,proacl IS NULL AS "aclDefault"
          FROM pg_proc WHERE oid='public.e4_day_points(jsonb,integer)'::regprocedure
        `;
        expect(metadata).toEqual({
          body,
          ownerMatches: true,
          invoker: true,
          immutable: true,
          nonStrict: true,
          unsafeParallel: true,
          config: ['search_path=pg_catalog, public'],
          aclDefault: true,
        });
        const payload = JSON.stringify([
          ...formatTextMatrix().map((value) => ({ startsAt: value })),
          {},
        ]);
        const [truth] = await tx.$queryRaw<
          { count: number; matches: boolean; nulls: number; positives: number }[]
        >`
          WITH format_values AS MATERIALIZED (SELECT value AS ref FROM jsonb_array_elements(${payload}::jsonb)),
          compared AS MATERIALIZED (SELECT ${Prisma.raw(formatRegex('startsAt'))} AS old,
            ${Prisma.raw(formatCase('startsAt'))} AS candidate,
            pg_catalog.translate(ref->>'startsAt','0123456789','0000000000') COLLATE "C"
              = ${E4_FORMAT_TEMPLATE} COLLATE "C" AS positive FROM format_values)
          SELECT count(*)::int AS count,bool_and(old IS NOT DISTINCT FROM candidate) AS matches,
            count(*) FILTER(WHERE old IS NULL)::int AS nulls,count(*) FILTER(WHERE positive IS TRUE)::int AS positives FROM compared
        `;
        expect(truth).toEqual({
          count: formatTextMatrix().length + 1,
          matches: true,
          nulls: 2,
          positives: 171,
        });
        const [quoted] = await tx.$queryRaw<
          { matrix: string }[]
        >`SELECT quote_nullable(${JSON.stringify(formatDayMatrix())}::jsonb) AS matrix`;
        await tx.$executeRawUnsafe(`DO $e4_actual_format_compare$
          DECLARE item jsonb; refs jsonb; amount integer; fn text; outcome jsonb; opening jsonb;
            result jsonb; state text; con text; msg text; detail text;
          BEGIN
            FOR item IN SELECT value FROM jsonb_array_elements(${quoted.matrix}::jsonb) LOOP
              refs=CASE WHEN item->'refs'='null'::jsonb THEN NULL ELSE item->'refs' END;
              amount=(item->>'amount')::integer; opening=NULL;
              FOREACH fn IN ARRAY ARRAY['pg_temp.e4_day_points_1220_oracle','public.e4_day_points'] LOOP
                result=NULL; state='00000'; con=''; msg=''; detail='';
                BEGIN EXECUTE format('SELECT %s($1,$2)',fn) INTO result USING refs,amount;
                EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS state=RETURNED_SQLSTATE,
                  con=CONSTRAINT_NAME,msg=MESSAGE_TEXT,detail=PG_EXCEPTION_DETAIL; END;
                outcome=jsonb_build_object('result',result,'state',state,'constraint',con,'message',msg,'detail',detail);
                IF opening IS NULL THEN opening=outcome;
                ELSIF opening IS DISTINCT FROM outcome THEN
                  RAISE EXCEPTION 'E4 actual format full oracle outcome mismatch' USING ERRCODE='23514';
                END IF;
              END LOOP;
            END LOOP;
          END $e4_actual_format_compare$;`);
      });
    });
    function dayRef(
      startsAt: string | null,
      endsAt: string | null,
      durationSeconds: number | string,
    ) {
      return { startsAt, endsAt, durationSeconds };
    }
    const sameDayRef = dayRef('2026-10-01T08:00:00.000Z', '2026-10-01T09:00:00.000Z', 3600);
    it.each([
      ['same day zero', [sameDayRef], 0],
      ['same day maximum', [sameDayRef], 99999],
      [
        'cross-midnight remainder',
        [dayRef('2026-10-01T15:59:00.000Z', '2026-10-01T16:01:00.000Z', 120)],
        101,
      ],
      [
        'exact exclusive midnight',
        [dayRef('2026-10-01T15:59:00.000Z', '2026-10-01T16:00:00.000Z', 60)],
        1,
      ],
      [
        'different positive days',
        [sameDayRef, dayRef('2026-10-02T08:00:00.000Z', '2026-10-02T09:00:00.000Z', 3600)],
        1,
      ],
      ['excluded malformed zero', [sameDayRef, dayRef('not-a-date', 'not-a-date', 0)], 101],
      ['excluded malformed negative', [sameDayRef, dayRef('not-a-date', 'not-a-date', -1)], 101],
      ['empty zero', [], 0],
      ['empty positive', [], 1],
      ['null refs', null, 0],
      ['null amount', [sameDayRef], null],
      ['overflow', [sameDayRef], 100000],
      ['invalid positive date', [dayRef('not-a-date', '2026-10-01T09:00:00.000Z', 1)], 1],
      ['missing positive date', [dayRef(null, '2026-10-01T09:00:00.000Z', 1)], 1],
      ['reversed date', [dayRef('2026-10-01T09:00:00.000Z', '2026-10-01T08:00:00.000Z', 1)], 1],
      ['zero length', [dayRef('2026-10-01T08:00:00.000Z', '2026-10-01T08:00:00.000Z', 1)], 1],
      ['submillisecond', [dayRef('2026-10-01T08:00:00.0001Z', '2026-10-01T08:00:00.0002Z', 1)], 1],
      [
        'non-UTC spelling',
        [dayRef('2026-10-01T16:00:00.000+08:00', '2026-10-01T17:00:00.000+08:00', 3600)],
        101,
      ],
      [
        'noninteger duration',
        [dayRef('2026-10-01T08:00:00.000Z', '2026-10-01T09:00:00.000Z', '1.5')],
        1,
      ],
      [
        'weight bound fallback',
        [sameDayRef, { ...sameDayRef, durationSeconds: 2147483647 }],
        99999,
      ],
    ])(
      'P-Day independent complete result / SQLSTATE / constraint: %s',
      async (_label, refs, hundredths) => {
        await withFixedOldDayOracle(db, async (tx) => {
          // Only server-quoted, fixed test inputs enter the anonymous block. The block can
          // capture exact constraint diagnostics without aborting the enclosing rollback.
          const [quoted] = await tx.$queryRaw<{ refs: string; amount: string }[]>`
          SELECT quote_nullable(${refs === null ? null : JSON.stringify(refs)}::jsonb) AS refs,
            quote_nullable(${hundredths}::integer) AS amount
        `;
          await tx.$executeRawUnsafe(`DO $compare_day$
          DECLARE old_value jsonb; candidate_value jsonb;
            old_state text='00000'; candidate_state text='00000';
            old_constraint text=''; candidate_constraint text='';
          BEGIN
            BEGIN old_value=pg_temp.e4_day_points_1220_oracle(${quoted.refs}::jsonb,${quoted.amount}::integer);
            EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS
              old_state=RETURNED_SQLSTATE,old_constraint=CONSTRAINT_NAME; END;
            BEGIN candidate_value=public.e4_day_points(${quoted.refs}::jsonb,${quoted.amount}::integer);
            EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS
              candidate_state=RETURNED_SQLSTATE,candidate_constraint=CONSTRAINT_NAME; END;
            IF old_value IS DISTINCT FROM candidate_value OR old_state IS DISTINCT FROM candidate_state
              OR old_constraint IS DISTINCT FROM candidate_constraint THEN
              RAISE EXCEPTION 'E4 P-Day independent oracle mismatch' USING ERRCODE='23514';
            END IF;
          END $compare_day$;`);
        });
      },
    );

    it.each([
      [
        'amount before malformed duration/date',
        [dayRef('not-a-start', 'not-an-end', 'bad-duration')],
        100000,
      ],
      ['duration before malformed dates', [dayRef('not-a-start', 'not-an-end', 'bad-duration')], 1],
      [
        'duration overflow before malformed dates',
        [dayRef('not-a-start', 'not-an-end', '2147483648')],
        1,
      ],
      ['start date before end date', [dayRef('not-a-start', 'not-an-end', 1)], 1],
      [
        'row order before later duration failure',
        [dayRef('not-a-start', 'not-an-end', 1), dayRef(null, null, 'bad-duration')],
        1,
      ],
      [
        'positive filter before excluded malformed dates',
        [
          dayRef('not-a-start', 'not-an-end', 0),
          dayRef('bad-positive-start', 'bad-positive-end', 1),
        ],
        1,
      ],
      [
        'null amount keeps duration/date failures',
        [dayRef('not-a-start', 'not-an-end', 'bad-duration')],
        null,
      ],
      ['invalid amount keeps original empty-source guard', [], -1],
    ])(
      'P-Day compound first-error order and complete diagnostics: %s',
      async (_label, refs, hundredths) => {
        await withFixedOldDayOracle(db, async (tx) => {
          const [quoted] = await tx.$queryRaw<{ refs: string; amount: string }[]>`
          SELECT quote_nullable(${JSON.stringify(refs)}::jsonb) AS refs,
            quote_nullable(${hundredths}::integer) AS amount
        `;
          // Compare full server diagnostics internally, without printing inputs, messages or detail.
          await tx.$executeRawUnsafe(`DO $compare_compound_day$
          DECLARE old_value jsonb; candidate_value jsonb;
            old_state text='00000'; candidate_state text='00000';
            old_constraint text=''; candidate_constraint text='';
            old_message text=''; candidate_message text='';
            old_detail text=''; candidate_detail text='';
          BEGIN
            BEGIN old_value=pg_temp.e4_day_points_1220_oracle(${quoted.refs}::jsonb,${quoted.amount}::integer);
            EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS
              old_state=RETURNED_SQLSTATE,old_constraint=CONSTRAINT_NAME,
              old_message=MESSAGE_TEXT,old_detail=PG_EXCEPTION_DETAIL; END;
            BEGIN candidate_value=public.e4_day_points(${quoted.refs}::jsonb,${quoted.amount}::integer);
            EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS
              candidate_state=RETURNED_SQLSTATE,candidate_constraint=CONSTRAINT_NAME,
              candidate_message=MESSAGE_TEXT,candidate_detail=PG_EXCEPTION_DETAIL; END;
            IF old_value IS DISTINCT FROM candidate_value OR old_state IS DISTINCT FROM candidate_state
              OR old_constraint IS DISTINCT FROM candidate_constraint
              OR old_message IS DISTINCT FROM candidate_message OR old_detail IS DISTINCT FROM candidate_detail THEN
              RAISE EXCEPTION 'E4 P-Day compound first-error diagnostics differ' USING ERRCODE='23514';
            END IF;
          END $compare_compound_day$;`);
        });
      },
    );

    it('P-Day non-finite spans retain the old bounded statement cancellation', async () => {
      await withFixedOldDayOracle(db, async (tx) => {
        // A non-finite series has no finite result in the old function. Compare its
        // actual per-statement cancellation separately, not in an OTHERS block
        // (PostgreSQL deliberately excludes QUERY_CANCELED from OTHERS).
        await tx.$executeRaw`SET LOCAL statement_timeout='100ms'`;
        const refs = JSON.stringify([dayRef('-infinity', 'infinity', 1)]);
        async function cancellation(fn: Prisma.Sql) {
          await tx.$executeRaw`SAVEPOINT e4_day_nonfinite`;
          try {
            await tx.$queryRaw`SELECT ${fn}(${refs}::jsonb,1)`;
            return '00000';
          } catch (error) {
            if (!(error instanceof Prisma.PrismaClientKnownRequestError)) throw error;
            if (error.code !== 'P2010' || typeof error.meta?.code !== 'string') throw error;
            return error.meta.code;
          } finally {
            await tx.$executeRaw`ROLLBACK TO SAVEPOINT e4_day_nonfinite`;
          }
        }
        const original = await cancellation(Prisma.raw('pg_temp.e4_day_points_1220_oracle'));
        const candidate = await cancellation(Prisma.raw('public.e4_day_points'));
        expect(original).toBe('57014');
        expect(candidate).toBe(original);
        await tx.$executeRaw`SET LOCAL statement_timeout='30s'`;
      });
    });

    it('P-Day fixed 8000-unit / 40000-ref AB and BA probes consume complete results', async () => {
      const inputs = Array.from({ length: 8000 }, (_, unit) => ({
        unit,
        hundredths: unit,
        refs: Array.from({ length: 5 }, (_, index) => ({
          ...sameDayRef,
          allocationRevisionId: `pday-unit-${unit}`,
          sliceId: `pday-slice-${unit}-${index}`,
        })),
      }));
      const payload = JSON.stringify(inputs);
      type Result = { unit: number; sources: number; value: unknown };
      const probe = async (tx: Prisma.TransactionClient, original: boolean) => {
        const fn = original
          ? Prisma.raw('pg_temp.e4_day_points_1220_oracle')
          : Prisma.raw('public.e4_day_points');
        const started = performance.now();
        const results = await tx.$queryRaw<Result[]>`
          WITH inputs AS MATERIALIZED (
            SELECT (value->>'unit')::int AS unit,(value->>'hundredths')::int AS hundredths,value->'refs' AS refs
            FROM jsonb_array_elements(${payload}::jsonb)
          ), computed AS MATERIALIZED (
            SELECT unit,jsonb_array_length(refs) AS sources,${fn}(refs,hundredths) AS value FROM inputs
          ) SELECT unit,sources,value FROM computed ORDER BY unit
        `;
        const elapsedMs = performance.now() - started;
        expect(results).toHaveLength(8000);
        expect(results.reduce((sum, row) => sum + row.sources, 0)).toBe(40000);
        expect(results.map((row) => row.unit)).toEqual(inputs.map((row) => row.unit));
        return { elapsedMs, results };
      };
      await pDayFailureGate.run('paired-performance', async () => {
        const samples: PDaySample[] = [];
        for (const [pairIndex, order] of E4_P_DAY_PAIR_ORDERS.entries()) {
          const evidence = await withFixedOldDayOracle(db, async (tx) => {
            const first = await probe(tx, order === 'AB');
            const second = await probe(tx, order === 'BA');
            expect(second.results).toEqual(first.results);
            return {
              pairIndex,
              order,
              units: 8000,
              sources: 40000,
              completeJsonMatches: true,
              oldMs: order === 'AB' ? first.elapsedMs : second.elapsedMs,
              candidateMs: order === 'AB' ? second.elapsedMs : first.elapsedMs,
            };
          });
          const validated = validateFixedPDaySample(evidence, pairIndex);
          samples.push(validated);
          console.info('E4_P_DAY_PROBE', JSON.stringify(validated));
        }
        const summary = summarizeFixedPDaySamples(samples);
        console.info('E4_P_DAY_BATCH', JSON.stringify(summary));
        assertFixedPDayPerformance(summary);
      });
    }, 180_000);
    it('replays all 137 migrations and introduces two tables without historical business DML or DB roles', async () => {
      const migrations = readdirSync(resolve(__dirname, '../../prisma/migrations')).filter((name) =>
        /^[0-9]{14}_/u.test(name),
      );
      expect(migrations).toHaveLength(137);
      const [row] = await db.$queryRaw<
        { count: bigint }[]
      >`SELECT count(*) AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
      expect(row.count).toBe(137n);
      const names = await db.$queryRaw<{ name: string; count: number }[]>`
      SELECT conname AS name,count(*)::int AS count FROM pg_constraint
      WHERE connamespace='public'::regnamespace
        AND conname IN ('astr_parent_complete_guard','e4_revision_complete_guard')
      GROUP BY conname ORDER BY conname
    `;
      expect(names).toEqual([
        { name: 'astr_parent_complete_guard', count: 1 },
        { name: 'e4_revision_complete_guard', count: 1 },
      ]);
      const barriers = await db.$queryRaw<
        {
          name: string;
          table: string;
          deferrable: boolean;
          deferred: boolean;
          constraintDeferrable: boolean;
          constraintDeferred: boolean;
          enabled: string;
        }[]
      >`
      SELECT t.tgname AS name,c.relname AS table,t.tgdeferrable AS deferrable,
        t.tginitdeferred AS deferred,k.condeferrable AS "constraintDeferrable",
        k.condeferred AS "constraintDeferred",t.tgenabled::text AS enabled
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_constraint k ON k.oid=t.tgconstraint
      WHERE c.relnamespace='public'::regnamespace
        AND t.tgname IN ('astr_parent_complete_guard','e4_revision_complete_guard')
      ORDER BY t.tgname
    `;
      expect(barriers).toEqual([
        {
          name: 'astr_parent_complete_guard',
          table: 'ActivitySettlementTimeRevision',
          deferrable: true,
          deferred: true,
          constraintDeferrable: true,
          constraintDeferred: true,
          enabled: 'O',
        },
        {
          name: 'e4_revision_complete_guard',
          table: 'ActivitySettlementContributionRevision',
          deferrable: true,
          deferred: true,
          constraintDeferrable: true,
          constraintDeferred: true,
          enabled: 'O',
        },
      ]);
      const source = readFileSync(
        resolve(
          __dirname,
          '../../prisma/migrations/20261003000000_activity_contribution_settlement/migration.sql',
        ),
        'utf8',
      );
      expect(source).not.toMatch(
        /^\s*(?:UPDATE|DELETE|INSERT|TRUNCATE|CREATE\s+ROLE|GRANT|REVOKE)\s/im,
      );
      expect(source).not.toContain('SECURITY DEFINER');
      const tables = await db.$queryRaw<
        { name: string }[]
      >`SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('ActivitySettlementContributionRevision','ParticipantContributionEvaluation') ORDER BY relname`;
      expect(tables.map((row) => row.name)).toEqual([
        'ActivitySettlementContributionRevision',
        'ParticipantContributionEvaluation',
      ]);
    });
    it('has non-null policy four-tuples and all four immutable guards enabled', async () => {
      const nullable = await db.$queryRaw<
        { name: string }[]
      >`SELECT column_name AS name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='ParticipantContributionEvaluation'
      AND column_name IN ('policyId','policyVersionId','definitionHash','evaluatorVersion') AND is_nullable='YES'`;
      expect(nullable).toEqual([]);
      const triggers = await db.$queryRaw<
        { name: string; enabled: string }[]
      >`SELECT tgname AS name,tgenabled::text AS enabled FROM pg_trigger
      WHERE tgname IN ('e4_revision_no_mutation','e4_revision_no_truncate','e4_evaluation_no_mutation','e4_evaluation_no_truncate') ORDER BY tgname`;
      expect(triggers).toHaveLength(4);
      expect(triggers.every((row) => row.enabled === 'O')).toBe(true);
    });
    it('uses actual Beijing coverage, conserving a single fixed award across days', async () => {
      const refs = [
        {
          startsAt: '2020-03-01T15:00:00.000Z',
          endsAt: '2020-03-01T17:00:00.000Z',
          durationSeconds: 7200,
        },
      ];
      const [row] = await db.$queryRaw<
        { days: unknown }[]
      >`SELECT e4_day_points(${JSON.stringify(refs)}::jsonb, 101) AS days`;
      expect(row.days).toEqual([
        { ledgerDate: '2020-03-01', recognizedPoints: '0.51' },
        { ledgerDate: '2020-03-02', recognizedPoints: '0.50' },
      ]);
    });
    it('fixes the effective time anchor as non-null and keeps the native formal-version and invoker boundary', async () => {
      const [column] = await db.$queryRaw<{ nullable: string }[]>`
      SELECT is_nullable AS nullable FROM information_schema.columns
      WHERE table_schema='public' AND table_name='ActivitySettlementContributionRevision'
        AND column_name='effectiveTimeSettlementVersionId'
    `;
      expect(column.nullable).toBe('NO');
      const [index] = await db.$queryRaw<{ unique: boolean; predicate: string }[]>`
      SELECT i.indisunique AS unique, pg_get_expr(i.indpred, i.indrelid) AS predicate
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='e4_revision_formal_version_key'
    `;
      expect(index.unique).toBe(true);
      expect(index.predicate).toContain('submitted');
      expect(index.predicate).toContain('correction');
      const functions = await db.$queryRaw<{ name: string; definer: boolean }[]>`
      SELECT proname AS name, prosecdef AS definer FROM pg_proc
      WHERE pronamespace='public'::regnamespace AND proname IN ('e4_effective_time_base','ptcm_guard_insert')
    `;
      expect(functions).toHaveLength(2);
      expect(functions.every((fn) => !fn.definer)).toBe(true);
      const aliases = await db.$queryRaw`
      SELECT * FROM e4_effective_time_base('missing-version','missing-activity','missing-run')
    `;
      expect(aliases).toEqual([]);
    });
    it('keeps empty zero distinct from missing-date positive points and refuses overflow', async () => {
      const [row] = await db.$queryRaw<
        { days: unknown }[]
      >`SELECT e4_day_points('[]'::jsonb, 0) AS days`;
      expect(row.days).toEqual([]);
      await expect(db.$queryRaw`SELECT e4_day_points('[]'::jsonb, 1)`).rejects.toThrow();
      await expect(db.$queryRaw`SELECT e4_day_points('[]'::jsonb, 100000)`).rejects.toThrow();
    });
    it('P-Canonical keeps C ordering, duplicates, escapes, controls and missing versus null byte-exact', async () => {
      const documents = [
        { text: '中文"\\\n\t\u0001', optional: null },
        { text: '中文"\\\n\t\u0001' },
        { text: '中文"\\\n\t\u0001', optional: null },
        null,
        { Z: 1, a: [], nested: { b: null, a: '尾\\' } },
      ];
      for (const refs of [documents, [...documents].reverse(), []]) {
        const [row] = await db.$queryRaw<{ equal: boolean; length: number }[]>`
        WITH sources AS MATERIALIZED (
          SELECT value AS ref,astr_canonical_json(value) AS canonical
          FROM jsonb_array_elements(${JSON.stringify(refs)}::jsonb)
        ), packed AS (
          SELECT coalesce(jsonb_agg(ref ORDER BY canonical COLLATE "C"),'[]'::jsonb) AS refs,
            '[' || coalesce(string_agg(coalesce(canonical,'null'),',' ORDER BY canonical COLLATE "C"),'') || ']' AS canonical,
            count(*)::int AS count FROM sources
        )
        SELECT e4_envelope_hash(jsonb_build_object('domain','time_revision','sources',refs)) =
          encode(sha256(convert_to('{"definition":{"domain":"time_revision","sources":' ||
            canonical || '},"schemaVersion":1}','UTF8')),'hex') AS equal,
          count AS length FROM packed
      `;
        expect(row).toEqual({ equal: true, length: refs.length });
      }
      const [distinction] = await db.$queryRaw<{ distinct: boolean }[]>`
      SELECT astr_canonical_json(${JSON.stringify(documents[0])}::jsonb) IS DISTINCT FROM
        astr_canonical_json(${JSON.stringify(documents[1])}::jsonb) AS distinct
    `;
      expect(distinction.distinct).toBe(true);
    });

    it('cannot truncate either evidence table even when empty', async () => {
      await expect(
        db.$executeRaw`TRUNCATE TABLE "ParticipantContributionEvaluation"`,
      ).rejects.toThrow();
      await expect(
        db.$executeRaw`TRUNCATE TABLE "ParticipantContributionEvaluation", "ActivitySettlementContributionRevision"`,
      ).rejects.toThrow();
    });

    it('P-Root matches the separate frozen aggregate for text boundaries, C ordering and an empty set', async () => {
      // Query-local text samples only: these do not claim to be lawful persisted business rows.
      const base = {
        sessionId: '场次',
        mode: 'policy',
        policyId: '政策',
        policyVersionId: '版本',
        definitionHash: 'a'.repeat(64),
        evaluatorVersion: 1,
        attendanceRoleCode: 'service',
        timeCategoryCode: 'volunteer_service',
      };
      const samples = [
        {
          ...base,
          participationIdentityId: '中文"\\\n\t\u0001',
          evaluationUnitKey: 'K"\\\n\t',
          sourceFingerprint: 'F中文"\\\u0001',
          evaluationHash: 'H"\\\n',
          recognizedPoints: '0.10',
        },
        {
          ...base,
          participationIdentityId: 'Z',
          sessionId: null,
          evaluationUnitKey: 'KZ',
          sourceFingerprint: 'FZ',
          evaluationHash: 'HZ',
          recognizedPoints: '0.20',
        },
        {
          ...base,
          participationIdentityId: 'a',
          evaluationUnitKey: 'Ka',
          sourceFingerprint: 'Fa',
          evaluationHash: 'Ha',
          recognizedPoints: '0.30',
        },
      ];
      const sql = fixedE4RootAggregateSql('canonical-root', 'time_revision');
      let first: unknown;
      for (const rows of [samples, [...samples].reverse(), []]) {
        const [comparison] = await db.$queryRaw<
          {
            count: number;
            total: string;
            equal: boolean;
            sourceHash: string;
            evaluationHash: string;
          }[]
        >`
        WITH "ParticipantContributionEvaluation" AS MATERIALIZED (
          SELECT 'canonical-root'::text AS "contributionRevisionId",r.*
          FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS r(
            "participationIdentityId" text,"sessionId" text,mode text,"policyId" text,
            "policyVersionId" text,"definitionHash" text,"evaluatorVersion" integer,
            "attendanceRoleCode" text,"timeCategoryCode" text,"evaluationUnitKey" text,
            "sourceFingerprint" text,"evaluationHash" text,"recognizedPoints" numeric)
        ), old_root(counts,total,sources_hash,evaluations_hash) AS MATERIALIZED (${sql.old}),
        candidate_root(counts,total,sources_hash,evaluations_hash) AS MATERIALIZED (${sql.candidate})
        SELECT o.counts::int AS count,o.total::text AS total,
          (o.counts=c.counts AND o.total=c.total AND o.sources_hash=c.sources_hash
            AND o.evaluations_hash=c.evaluations_hash) AS equal,
          c.sources_hash AS "sourceHash",c.evaluations_hash AS "evaluationHash"
        FROM old_root o CROSS JOIN candidate_root c
      `;
        expect(comparison).toMatchObject({ count: rows.length, equal: true });
        expect(Number(comparison.total)).toBe(rows.length ? 0.6 : 0);
        if (rows === samples) first = comparison;
        else if (rows.length) expect(comparison).toEqual(first);
        else {
          expect(comparison.sourceHash).toBe(
            createHash('sha256')
              .update('{"definition":{"domain":"time_revision","sources":[]},"schemaVersion":1}')
              .digest('hex'),
          );
          expect(comparison.evaluationHash).toBe(
            createHash('sha256')
              .update('{"definition":{"evaluations":[]},"schemaVersion":1}')
              .digest('hex'),
          );
        }
      }
    });

    describe('activity-level policy inheritance keeps its actual database scope guards', () => {
      let fixture: E4Fixture;
      let proofId: string;
      let selectionItemId: string;
      let wrongRevisionItemId: string;
      let wrongScopeItemId: string;
      let foreignItemId: string;
      const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;

      function fixtureCopy<T extends object>(row: T): Omit<T, 'id' | 'createdAt' | 'updatedAt'> {
        return Object.fromEntries(
          Object.entries(row).filter(([key]) => !['id', 'createdAt', 'updatedAt'].includes(key)),
        ) as Omit<T, 'id' | 'createdAt' | 'updatedAt'>;
      }

      async function appendCompleteSelection(
        tx: Prisma.TransactionClient,
        originalId: string,
        extra?: ActivityContributionPolicySelectionItem,
      ) {
        const original = await tx.activityContributionPolicySelectionRevision.findUniqueOrThrow({
          where: { id: originalId },
        });
        const document = parseActivityContributionPolicySelectionDocument(original.selectionJson);
        const selection = createActivityContributionPolicySelectionDocument([
          ...Object.values(document.items),
          ...(extra ? [extra] : []),
        ]);
        const data = fixtureCopy(original);
        const revision = await tx.activityContributionPolicySelectionRevision.create({
          data: {
            ...data,
            revision: original.revision + 1,
            selectionJson: selection as unknown as Prisma.InputJsonValue,
            selectionHash: activityContributionPolicySelectionHash(selection),
            itemCount: Object.keys(selection.items).length,
          },
        });
        await tx.activityContributionPolicySelectionItem.createMany({
          data: Object.values(selection.items).map(({ scope, selection: value }) => ({
            activityId: original.activityId,
            selectionRevisionId: revision.id,
            ...scope,
            mode: value.mode,
            policyId: value.pointer?.policyId ?? null,
            versionId: value.pointer?.versionId ?? null,
            definitionHash: value.pointer?.definitionHash ?? null,
            evaluatorVersion: value.pointer?.evaluatorVersion ?? null,
          })),
        });
        await tx.activityContributionPolicySelectionCommandReceipt.create({
          data: {
            actorUserId: original.createdByUserId,
            activityId: original.activityId,
            operationCode: 'patch_contribution_policy_selection',
            operationKey: fixture.key('scope_selection'),
            requestHash: 'd'.repeat(64),
            selectionRevisionId: revision.id,
            createdAt: revision.createdAt,
            resultJson: {
              activityId: original.activityId,
              selectionRevisionId: revision.id,
              revision: revision.revision,
              selectionHash: revision.selectionHash,
              createdAt: revision.createdAt.toISOString(),
            },
          },
        });
        await tx.activity.update({
          where: { id: original.activityId },
          data: {
            contributionPolicySelectionRevision: revision.revision,
            currentContributionPolicySelectionRevisionId: revision.id,
          },
        });
        return revision;
      }

      beforeAll(async () => {
        process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
        fixture = await createE4Fixture();
        let secondSegmentId = '';
        const source = await createE4Source(fixture, {
          beforeSeal: async (draft) => {
            // Controlled historical publish fixture, before any seal/allocation:
            // append a second real session and a new immutable workflow snapshot.
            // Never rewrite the earlier snapshot or disable a guard.
            await fixture.db.$transaction(async (tx) => {
              const firstSession = await tx.activitySession.findUniqueOrThrow({
                where: { id: draft.sessionId },
              });
              const sessionData = fixtureCopy(firstSession);
              const session = await tx.activitySession.create({
                data: {
                  ...sessionData,
                  code: fixture.key('scope_session'),
                  name: fixture.key('scope_session_name'),
                },
              });
              const registration = await tx.activityRegistration.create({
                data: {
                  activityId: draft.activityId,
                  memberId: fixture.reviewer.memberId,
                  statusCode: 'pass',
                },
              });
              const identity = await tx.activityParticipationIdentity.create({
                data: {
                  activityId: draft.activityId,
                  sessionId: session.id,
                  memberId: fixture.reviewer.memberId,
                  registrationId: registration.id,
                  currentStatusCode: 'pass',
                  currentPositionId: null,
                  populationIncluded: true,
                },
              });
              const events: string[] = [];
              for (const [eventTypeCode, occurredAt] of [
                ['check_in', firstSession.startAt],
                ['check_out', firstSession.endAt],
              ] as const) {
                const event = await tx.attendancePunchEvent.create({
                  data: {
                    activityId: draft.activityId,
                    sessionId: session.id,
                    positionId: null,
                    participationIdentityId: identity.id,
                    memberId: identity.memberId,
                    eventTypeCode,
                    sourceCode: 'self_qr',
                    occurredAt,
                    receivedAt: occurredAt,
                    operatorUserId: fixture.creator.id,
                    eventKey: fixture.key('scope_event'),
                    requestHash: 'b'.repeat(64),
                    evidenceRevision: 0,
                  },
                });
                events.push(event.id);
              }
              const segment = await tx.participantServiceSegmentRevision.create({
                data: {
                  participationIdentityId: identity.id,
                  segmentKey: '0001',
                  revision: 1,
                  sourceCheckInEventId: events[0],
                  sourceCloseEventId: events[1],
                  resultCode: 'valid',
                  statusCode: 'draft',
                  checkInAt: firstSession.startAt,
                  checkOutAt: firstSession.endAt,
                  serviceHours: 1,
                  lateFlag: false,
                  earlyLeaveFlag: false,
                },
              });
              secondSegmentId = segment.id;
              const snapshot = await tx.activityRuleSnapshot.findUniqueOrThrow({
                where: {
                  activityId_workflowRevision: {
                    activityId: draft.activityId,
                    workflowRevision: 0,
                  },
                },
              });
              const config = snapshot.resolvedConfig as Prisma.JsonObject;
              if (!Array.isArray(config.sessions)) throw new Error('real frozen sessions required');
              if (!snapshot.contributionPolicySelectionRevisionId)
                throw new Error('real frozen selection required');
              const firstPosition = await tx.activitySessionPosition.findUniqueOrThrow({
                where: { id: draft.positionId },
              });
              const positionData = fixtureCopy(firstPosition);
              const unusedPosition = await tx.activitySessionPosition.create({
                data: {
                  ...positionData,
                  code: fixture.key('scope_position'),
                  name: fixture.key('scope_position_name'),
                },
              });
              const document = parseActivityContributionPolicySelectionDocument(
                (
                  await tx.activityContributionPolicySelectionRevision.findUniqueOrThrow({
                    where: { id: snapshot.contributionPolicySelectionRevisionId },
                  })
                ).selectionJson,
              );
              const activityItem = Object.values(document.items).find(
                (entry) => entry.scope.layerCode === 'activity',
              );
              if (!activityItem || activityItem.selection.mode !== 'explicit')
                throw new Error('real explicit activity policy required');
              const scope = {
                layerCode: 'position' as const,
                sessionId: draft.sessionId,
                positionId: unusedPosition.id,
              };
              const selected = await appendCompleteSelection(
                tx,
                snapshot.contributionPolicySelectionRevisionId,
                { scope, selection: activityItem.selection },
              );
              const pointers = config.contributionPolicyPointers as Prisma.JsonObject;
              if (!Array.isArray(pointers.resolved))
                throw new Error('real resolved policies required');
              const snapshotData = fixtureCopy(snapshot);
              await tx.activityRuleSnapshot.create({
                data: {
                  ...snapshotData,
                  workflowRevision: 1,
                  createdAt: new Date('2019-12-02T00:00:00.000Z'),
                  contributionPolicySelectionRevisionId: selected.id,
                  resolvedConfig: {
                    ...config,
                    sessions: [
                      ...(config.sessions as Prisma.JsonObject[]).map((entry) => ({
                        ...entry,
                        positions: [
                          ...(entry.positions as Prisma.JsonArray),
                          { positionId: unusedPosition.id, attendanceRoleCode: 'service' },
                        ],
                      })),
                      { sessionId: session.id, positions: [] },
                    ],
                    contributionPolicyPointers: {
                      ...pointers,
                      selectionRevisionId: selected.id,
                      selectionRevision: selected.revision,
                      selectionHash: selected.selectionHash,
                      proposalSelectionHash: selected.selectionHash,
                      selection: selected.selectionJson,
                      referenceKinds: {
                        ...(pointers.referenceKinds as Prisma.JsonObject),
                        [activityContributionPolicySelectionScopeKey(scope)]: {
                          sessionRefKind: 'id',
                          positionRefKind: 'id',
                        },
                      },
                      resolved: [
                        ...pointers.resolved,
                        {
                          scope,
                          pointer: activityItem.selection.pointer,
                          sourceLayerCode: 'position',
                          effectiveFrom: '1900-01-01T00:00:00.000Z',
                          effectiveUntil: '2101-01-01T00:00:00.000Z',
                        },
                      ],
                    },
                  } as Prisma.InputJsonValue,
                  snapshotHash: 'c'.repeat(64),
                },
              });
              await tx.activity.update({
                where: { id: draft.activityId },
                data: { workflowRevision: 1 },
              });
            });
          },
        });
        expect(secondSegmentId).not.toBe('');
        await fixture.app.get(ActivityTimeSettlementService).allocate(
          source.activityId,
          {
            ...source.expectation,
            operationKey: fixture.key('scope_allocate'),
            sourceSegmentId: secondSegmentId,
            expectedRevision: 0,
            recognitionModeCode: 'automatic',
            evidenceAttachmentIds: [],
          },
          e4Actor(fixture.creator, true),
          E4_META,
        );
        const prepared = await prepareE4Time(fixture, source);
        const root = await fixture.db.activitySettlementContributionRevision.findFirstOrThrow({
          where: { settlementVersionId: prepared.settlementVersionId },
        });
        proofId = root.id;
        const item = await fixture.db.activityContributionPolicySelectionItem.findFirstOrThrow({
          where: { selectionRevisionId: root.selectionRevisionId, layerCode: 'activity' },
        });
        selectionItemId = item.id;
        const positionItem =
          await fixture.db.activityContributionPolicySelectionItem.findFirstOrThrow({
            where: { selectionRevisionId: root.selectionRevisionId, layerCode: 'position' },
          });
        wrongScopeItemId = positionItem.id;

        // A second immutable selection with the same approved policy is still a
        // wrong evidence revision for this frozen root; no policy/guard is mocked.
        const alternative = await fixture.db.$transaction((tx) =>
          appendCompleteSelection(tx, root.selectionRevisionId),
        );
        const wrongItem = await fixture.db.activityContributionPolicySelectionItem.findFirstOrThrow(
          {
            where: { selectionRevisionId: alternative.id, layerCode: 'activity' },
          },
        );
        wrongRevisionItemId = wrongItem.id;
        const other = await createE4Source(fixture);
        const foreign = await fixture.db.activityContributionPolicySelectionItem.findFirstOrThrow({
          where: { activityId: other.activityId, layerCode: 'activity' },
        });
        foreignItemId = foreign.id;
      }, 120_000);

      afterAll(async () => {
        await closeE13Fixture(fixture);
        if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
        else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
      });

      async function insertTamperedProof(itemId: string) {
        return fixture.db.$transaction(async (tx) => {
          const original = await tx.activitySettlementContributionRevision.findUniqueOrThrow({
            where: { id: proofId },
          });
          const latest = await tx.activitySettlementContributionRevision.findFirstOrThrow({
            where: { settlementRunId: original.settlementRunId },
            orderBy: { revision: 'desc' },
          });
          const data = fixtureCopy(original);
          const copy = await tx.activitySettlementContributionRevision.create({
            data: {
              ...data,
              revision: latest.revision + 1,
              operationKey: fixture.key('scope_tamper'),
            },
          });
          await tx.$executeRaw`
          INSERT INTO "ParticipantContributionEvaluation"
          SELECT changed.* FROM "ParticipantContributionEvaluation" original
          CROSS JOIN LATERAL jsonb_populate_record(NULL::"ParticipantContributionEvaluation",
            to_jsonb(original) || jsonb_build_object('id', ${copy.id}::text || ':' || original.id,
              'contributionRevisionId', ${copy.id}::text, 'selectionItemId', ${itemId}::text)) changed
          WHERE original."contributionRevisionId" = ${proofId}
        `;
        });
      }

      it('accepts one real activity-level item in two actual sessions under the full guard', async () => {
        const item = await fixture.db.activityContributionPolicySelectionItem.findUniqueOrThrow({
          where: { id: selectionItemId },
        });
        const evaluations = await fixture.db.participantContributionEvaluation.findMany({
          where: { contributionRevisionId: proofId },
        });
        expect(item.sessionId).toBeNull();
        expect(evaluations).toHaveLength(2);
        expect(new Set(evaluations.map((row) => row.sessionId)).size).toBe(2);
        expect(
          evaluations.every(
            (row) => row.selectionItemId === item.id && row.activityId === item.activityId,
          ),
        ).toBe(true);
        await fixture.db.$queryRaw`SELECT e4_assert_complete(${proofId})::text`;
        await assertFixedE4Oracle(fixture.db, proofId, 2);
      });

      it('rejects a same-activity wrong selection revision and rolls back the entire proof', async () => {
        const before = await fixture.db.activitySettlementContributionRevision.count();
        await expect(insertTamperedProof(wrongRevisionItemId)).rejects.toMatchObject({
          code: 'P2010',
          meta: {
            code: '23514',
            message: expect.stringContaining('contribution evaluation set mismatch'),
          },
        });
        expect(await fixture.db.activitySettlementContributionRevision.count()).toBe(before);
      });

      it('rejects a foreign-activity selection FK and rolls back the entire proof', async () => {
        const before = await fixture.db.activitySettlementContributionRevision.count();
        await expect(insertTamperedProof(foreignItemId)).rejects.toMatchObject({
          code: 'P2010',
          meta: { code: '23503', message: expect.stringContaining('e4_evaluation_selection_fk') },
        });
        expect(await fixture.db.activitySettlementContributionRevision.count()).toBe(before);
      });

      it('rejects a wrong position scope from the exact frozen revision and rolls back', async () => {
        const root = await fixture.db.activitySettlementContributionRevision.findUniqueOrThrow({
          where: { id: proofId },
        });
        const wrong = await fixture.db.activityContributionPolicySelectionItem.findUniqueOrThrow({
          where: { id: wrongScopeItemId },
        });
        expect(wrong.selectionRevisionId).toBe(root.selectionRevisionId);
        expect(wrong.sessionId).not.toBeNull();
        expect(wrong.positionId).not.toBeNull();
        const before = await fixture.db.activitySettlementContributionRevision.count();
        await expect(insertTamperedProof(wrongScopeItemId)).rejects.toMatchObject({
          code: 'P2010',
          meta: {
            code: '23514',
            message: expect.stringContaining('contribution evaluation set mismatch'),
          },
        });
        expect(await fixture.db.activitySettlementContributionRevision.count()).toBe(before);
      });

      it('P-Canonical preserves independent single-cause SQL rejection and zero partial facts', async () => {
        const original = await fixture.db.participantContributionEvaluation.findFirstOrThrow({
          where: { contributionRevisionId: proofId },
        });
        const sourceRefs = original.sourceRefsJson as Prisma.JsonArray;
        const firstRef = sourceRefs[0] as Prisma.JsonObject;
        const missing = { ...firstRef };
        delete missing.allocationHash;
        const alteredSources = [
          [{ ...firstRef, extra: '中文"\\\n\t' }, ...sourceRefs.slice(1)],
          [{ ...firstRef, allocationHash: null }, ...sourceRefs.slice(1)],
          [missing, ...sourceRefs.slice(1)],
          [...sourceRefs, firstRef],
        ];
        // Change one semantic field at a time. All other row fields and the actual root are copied.
        const mutations: Record<string, Prisma.JsonValue>[] = [
          ...alteredSources.map((refs) => ({ sourceRefsJson: refs })),
          { sourceFingerprint: '0'.repeat(64) },
          { evaluationHash: '0'.repeat(64) },
          { definitionHash: '0'.repeat(64) },
          { beijingDayPointsJson: [{ ledgerDate: '2020-03-02', recognizedPoints: '1.00' }] },
          { calculatedPoints: '0.99', recognizedPoints: '0.99' },
        ];
        const counts = async () => ({
          roots: await fixture.db.activitySettlementContributionRevision.count(),
          evaluations: await fixture.db.participantContributionEvaluation.count(),
          receipts: await fixture.db.activitySettlementTimeCommandReceipt.count(),
          audits: await fixture.db.auditLog.count(),
        });
        const before = await counts();
        for (const mutation of mutations) {
          const expectedMeta = Object.hasOwn(mutation, 'definitionHash')
            ? { code: '23503', message: expect.stringContaining('e4_evaluation_policy_fk') }
            : { code: '23514' };
          await expect(
            fixture.db.$transaction(async (tx) => {
              const root = await tx.activitySettlementContributionRevision.findUniqueOrThrow({
                where: { id: proofId },
              });
              const latest = await tx.activitySettlementContributionRevision.findFirstOrThrow({
                where: { settlementRunId: root.settlementRunId },
                orderBy: { revision: 'desc' },
              });
              const copy = await tx.activitySettlementContributionRevision.create({
                data: {
                  ...fixtureCopy(root),
                  revision: latest.revision + 1,
                  operationKey: fixture.key('canonical_single_cause'),
                },
              });
              await tx.$executeRaw`
            INSERT INTO "ParticipantContributionEvaluation"
            SELECT changed.* FROM "ParticipantContributionEvaluation" e
            CROSS JOIN LATERAL jsonb_populate_record(NULL::"ParticipantContributionEvaluation",
              to_jsonb(e) || jsonb_build_object('id', ${copy.id}::text || ':' || e.id,
                'contributionRevisionId', ${copy.id}::text) ||
              CASE WHEN e.id=${original.id} THEN ${JSON.stringify(mutation)}::jsonb ELSE '{}'::jsonb END) changed
            WHERE e."contributionRevisionId"=${proofId}
          `;
            }),
          ).rejects.toMatchObject({ code: 'P2010', meta: expectedMeta });
          expect(await counts()).toEqual(before);
        }
        await assertFixedE4Oracle(fixture.db, proofId, 2);
      });
      it.each([
        ['missing row', 'missing', {}, '23514', 'e4_evaluation_guard'],
        ['extra distinct key', 'extra', {}, '23514', 'e4_evaluation_guard'],
        [
          'same-key content',
          'mutation',
          { explanationCode: 'tampered' },
          '23514',
          'e4_evaluation_guard',
        ],
        [
          'unknown day key',
          'mutation',
          {
            beijingDayPointsJson: [
              { ledgerDate: '2020-03-01', recognizedPoints: '1.00', unknown: 'retained' },
            ],
          },
          '23514',
          'e4_evaluation_guard',
        ],
        [
          'FK before full-document mismatch',
          'mutation',
          { definitionHash: '0'.repeat(64), explanationCode: 'tampered' },
          '23503',
          'e4_evaluation_policy_fk',
        ],
        [
          'shape before FK and full-document mismatch',
          'mutation',
          { evaluatorVersion: 2, definitionHash: '0'.repeat(64), explanationCode: 'tampered' },
          '23514',
          'e4_evaluation_shape_check',
        ],
      ])(
        'P-Set real guard and exact first SQLSTATE / constraint: %s',
        async (_label, kind, mutation, state, constraint) => {
          const counts = async () => ({
            roots: await fixture.db.activitySettlementContributionRevision.count(),
            evaluations: await fixture.db.participantContributionEvaluation.count(),
            receipts: await fixture.db.activitySettlementTimeCommandReceipt.count(),
            audits: await fixture.db.auditLog.count(),
          });
          const before = await counts();
          const rollback = new Error('P-Set real negative rollback');
          let verified = false;
          try {
            await fixture.db.$transaction(async (tx) => {
              const root = await tx.activitySettlementContributionRevision.findUniqueOrThrow({
                where: { id: proofId },
              });
              const latest = await tx.activitySettlementContributionRevision.findFirstOrThrow({
                where: { settlementRunId: root.settlementRunId },
                orderBy: { revision: 'desc' },
              });
              const original = await tx.participantContributionEvaluation.findFirstOrThrow({
                where: { contributionRevisionId: proofId },
                orderBy: { id: 'asc' },
              });
              const copy = await tx.activitySettlementContributionRevision.create({
                data: {
                  ...fixtureCopy(root),
                  revision: latest.revision + 1,
                  operationKey: fixture.key('pset_negative'),
                },
              });
              // Server-quoted test values only, never raw interpolation of business input.
              const [quoted] = await tx.$queryRaw<
                { copy: string; root: string; first: string; mutation: string }[]
              >`
              SELECT quote_nullable(${copy.id}::text) AS copy,quote_nullable(${proofId}::text) AS root,
                quote_nullable(${original.id}::text) AS first,quote_nullable(${JSON.stringify(mutation)}::jsonb) AS mutation
            `;
              const inserted = `INSERT INTO "ParticipantContributionEvaluation"
              SELECT changed.* FROM "ParticipantContributionEvaluation" e
              CROSS JOIN LATERAL jsonb_populate_record(NULL::"ParticipantContributionEvaluation",
                to_jsonb(e)||jsonb_build_object('id',${quoted.copy}::text||':'||e.id,'contributionRevisionId',${quoted.copy}::text)||
                CASE WHEN e.id=${quoted.first}::text THEN ${quoted.mutation}::jsonb ELSE '{}'::jsonb END) changed
              WHERE e."contributionRevisionId"=${quoted.root}::text`;
              const rows =
                kind === 'missing'
                  ? inserted + ` AND e.id<>${quoted.first}::text`
                  : kind === 'extra'
                    ? inserted +
                      ` UNION ALL
                SELECT changed.* FROM "ParticipantContributionEvaluation" e
                CROSS JOIN LATERAL jsonb_populate_record(NULL::"ParticipantContributionEvaluation",
                  to_jsonb(e)||jsonb_build_object('id',${quoted.copy}::text||':extra:'||e.id,
                    'contributionRevisionId',${quoted.copy}::text,'evaluationUnitKey',repeat('f',64))) changed
                WHERE e.id=${quoted.first}::text AND e."contributionRevisionId"=${quoted.root}::text`
                    : inserted;
              // The actual trigger rejects inside a subtransaction. GET STACKED DIAGNOSTICS
              // checks constraint identity (not just a Prisma message). The outer proof is then rolled back.
              await tx.$executeRawUnsafe(`DO $pset_negative$
              DECLARE actual_state TEXT='00000'; actual_constraint TEXT='';
              BEGIN
                BEGIN
                  ${rows};
                  PERFORM e4_assert_complete(${quoted.copy}::text,FALSE);
                EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS
                  actual_state=RETURNED_SQLSTATE,actual_constraint=CONSTRAINT_NAME;
                END;
                IF actual_state<>'${String(state)}' OR actual_constraint<>'${String(constraint)}' THEN
                  RAISE EXCEPTION 'P-Set exact first rejection differs' USING ERRCODE='23514';
                END IF;
              END $pset_negative$;`);
              verified = true;
              throw rollback;
            });
          } catch (error) {
            if (error !== rollback) throw error;
          }
          expect(verified).toBe(true);
          expect(await counts()).toEqual(before);
        },
      );
    });
  });
});
