import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Prisma } from '@prisma/client';
import type { E4DiagnosticContext } from './e4-diagnostic-limits-client';

const runFile = promisify(execFile);
const byteLimit = 2 * 1024 * 1024;
const nodeTypes = new Set([
  'Result',
  'Aggregate',
  'Seq Scan',
  'Index Scan',
  'Index Only Scan',
  'Bitmap Heap Scan',
  'Bitmap Index Scan',
  'BitmapAnd',
  'BitmapOr',
  'Nested Loop',
  'Hash Join',
  'Merge Join',
  'Hash',
  'Sort',
  'Incremental Sort',
  'Materialize',
  'Memoize',
  'CTE Scan',
  'Subquery Scan',
  'Function Scan',
  'ProjectSet',
  'Append',
  'Merge Append',
  'Gather',
  'Gather Merge',
  'Unique',
  'Limit',
  'WindowAgg',
  'SetOp',
  'Values Scan',
  'Group',
  'LockRows',
  'ModifyTable',
]);
const fields = [
  'Actual Rows',
  'Actual Loops',
  'Plan Rows',
  'Plan Width',
  'Shared Hit Blocks',
  'Shared Read Blocks',
  'Temp Read Blocks',
  'Temp Written Blocks',
  'Sort Space Used',
  'Hash Batches',
];
const settings = [
  'SET LOCAL auto_explain.log_parameter_max_length=0',
  'SET LOCAL auto_explain.log_analyze=on',
  'SET LOCAL auto_explain.log_buffers=on',
  'SET LOCAL auto_explain.log_timing=off',
  'SET LOCAL auto_explain.log_triggers=on',
  'SET LOCAL auto_explain.log_nested_statements=on',
  "SET LOCAL auto_explain.log_format='json'",
  "SET LOCAL auto_explain.log_min_duration='250ms'",
] as const;
const preflight = `SELECT pg_backend_pid() AS pid,current_database()=$1 AS scope,
  current_setting('server_version_num')::int BETWEEN 160000 AND 169999 AS version,
  (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS allowed,
  current_setting('log_line_prefix')='%m [%p] ' AND current_setting('log_destination')='stderr'
    AND current_setting('logging_collector')='off' AS logFormat,
  current_setting('track_activities')='on' AS activity,
  coalesce(current_setting('auto_explain.log_min_duration',true),'-1')='-1' AS disabled,
  (SELECT count(*)=1 AND bool_and(md5(p.prosrc)='21fe9ecf6df989a3f8fa5878df40b93c')
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='e4_assert_complete') AS catalog`;
const restoreCheck = `SELECT pg_backend_pid() AS pid,current_database()=$1 AS scope,
  current_setting('auto_explain.log_min_duration')='-1'
    AND current_setting('auto_explain.log_parameter_max_length')='-1'
    AND current_setting('auto_explain.log_analyze')='off'
    AND current_setting('auto_explain.log_buffers')='off'
    AND current_setting('auto_explain.log_timing')='on'
    AND current_setting('auto_explain.log_triggers')='off'
    AND current_setting('auto_explain.log_nested_statements')='off'
    AND current_setting('auto_explain.log_format')='text' AS restored`;
const configurationCheck = `SELECT pg_backend_pid() AS pid,current_database()=$1 AS scope,
  current_setting('auto_explain.log_parameter_max_length')='0'
    AND current_setting('auto_explain.log_min_duration')='250ms'
    AND current_setting('auto_explain.log_analyze')='on'
    AND current_setting('auto_explain.log_buffers')='on'
    AND current_setting('auto_explain.log_timing')='off'
    AND current_setting('auto_explain.log_triggers')='on'
    AND current_setting('auto_explain.log_nested_statements')='on'
    AND current_setting('auto_explain.log_format')='json'
    AND current_setting('auto_explain.log_level')='log'
    AND current_setting('auto_explain.sample_rate')='1' AS configured`;
const observerSql = `SELECT current_database()=$2 AS scope,a.state,
  coalesce(a.wait_event_type,'NONE') AS type,coalesce(a.wait_event,'NONE') AS event,
  cardinality(pg_blocking_pids(a.pid)) AS blockers,a.xact_start IS NULL AS noTransaction
  FROM pg_stat_activity a WHERE a.pid=$1 AND a.datname=$2`;
const waitTypes = [
  'NONE',
  'Lock',
  'LWLock',
  'IO',
  'Client',
  'IPC',
  'Timeout',
  'BufferPin',
  'Activity',
  'Extension',
] as const;
const waitEvents = [
  'NONE',
  'ClientRead',
  'ClientWrite',
  'transactionid',
  'tuple',
  'relation',
  'advisory',
  'DataFileRead',
  'DataFileWrite',
  'WALWrite',
  'WALSync',
  'BufferIO',
] as const;
type Plan = {
  role: string;
  durationMs: number;
  nodes: { parent: number | null; type: string; values: (number | null)[] }[];
  triggers: { role: string; calls: number; timeMs: number }[];
};

function number(value: unknown, max = 1e12): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max)
    throw new Error('E4_PLAN_NUMBER');
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('E4_PLAN_OBJECT');
  return value as Record<string, unknown>;
}
function role(text: unknown): string {
  if (typeof text !== 'string') throw new Error('E4_PLAN_QUERY_SHAPE');
  if (/^\s*WITH revision_domain AS MATERIALIZED/u.test(text)) return 'EXPECTED_BUILD';
  if (/^\s*WITH root AS MATERIALIZED/u.test(text)) return 'SOURCE_EXPANSION';
  if (/^\s*WITH documents AS MATERIALIZED/u.test(text)) return 'ROOT_HASH';
  if (/^\s*INSERT INTO "ParticipantContributionEvaluation"/u.test(text)) return 'EVALUATION_INSERT';
  if (/\be4_expected_evaluations\(/u.test(text)) return 'EXPECTED_COMPARE';
  if (/\be4_source_rows\(/u.test(text)) return 'SOURCE_CHECK';
  if (/\be4_assert_complete\(/u.test(text)) return 'COMPLETE_CALL';
  return 'OTHER';
}

/** PG16 logs an object, not the EXPLAIN result array. All text/expressions are discarded. */
export function projectE4NestedPlan(value: unknown, durationMs: number): Plan {
  const input = record(value),
    nodes: Plan['nodes'] = [];
  const visit = (raw: unknown, parent: number | null) => {
    const node = record(raw),
      index = nodes.length;
    if (index >= 256) throw new Error('E4_PLAN_NODES');
    number(node['Actual Rows']);
    number(node['Actual Loops']);
    nodes.push({
      parent,
      type:
        typeof node['Node Type'] === 'string' && nodeTypes.has(node['Node Type'])
          ? node['Node Type']
          : 'OTHER',
      values: fields.map((key) => (node[key] === undefined ? null : number(node[key]))),
    });
    if (node.Plans !== undefined) {
      if (!Array.isArray(node.Plans)) throw new Error('E4_PLAN_CHILDREN');
      for (const child of node.Plans) visit(child, index);
    }
  };
  visit(input.Plan, null);
  if (
    input.Triggers !== undefined &&
    (!Array.isArray(input.Triggers) || input.Triggers.length > 16)
  )
    throw new Error('E4_PLAN_TRIGGERS');
  const triggers = ((input.Triggers ?? []) as unknown[]).map((raw) => {
    const trigger = record(raw),
      name = trigger['Trigger Name'];
    return {
      role:
        name === 'e4_evaluation_set_guard'
          ? 'EVALUATION_SET'
          : name === 'e4_revision_complete_guard'
            ? 'REVISION_COMPLETE'
            : name === 'astr_parent_complete_guard'
              ? 'TIME_PARENT'
              : 'OTHER',
      calls: number(trigger.Calls),
      timeMs: number(trigger.Time, 600000),
    };
  });
  return {
    role: role(input['Query Text']),
    durationMs: number(durationMs, 600000),
    nodes,
    triggers,
  };
}

/** Bounded private log input. Same PID only; malformed matching records fail closed. */
export function projectE4ServerLogs(text: string, pid: number): Plan[] {
  if (!Number.isSafeInteger(pid) || pid <= 0 || Buffer.byteLength(text) > byteLimit)
    throw new Error('E4_LOG_INPUT');
  const plans: Plan[] = [];
  let payload = '',
    duration = 0,
    depth = 0,
    quoted = false,
    escaped = false,
    pending = false;
  for (const line of text.split('\n')) {
    const header = /^\d{4}-\d{2}-\d{2} [^\n]{1,50} \[(\d+)\] [A-Z]+: /u.exec(line);
    if (header && pending) throw new Error('E4_LOG_UNCLOSED');
    const match =
      /^\d{4}-\d{2}-\d{2} [^\n]{1,50} \[(\d+)\] LOG: {2}duration: ([0-9.]+) ms {2}plan:\s*$/u.exec(
        line,
      );
    if (match) {
      if (Number(match[1]) !== pid) continue;
      duration = number(Number(match[2]), 600000);
      pending = true;
      payload = '';
      depth = 0;
      quoted = false;
      escaped = false;
      continue;
    }
    if (!pending) continue;
    for (const char of line + '\n') {
      if (!payload && /\s/u.test(char)) continue;
      if (!payload && char !== '{') throw new Error('E4_LOG_JSON');
      payload += char;
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{' || char === '[') depth++;
      else if (char === '}' || char === ']') depth--;
      if (depth === 0) {
        plans.push(projectE4NestedPlan(JSON.parse(payload), duration));
        pending = false;
        if (
          plans.length > 32 ||
          plans.reduce((n, p) => n + p.nodes.length, 0) > 256 ||
          Buffer.byteLength(JSON.stringify(plans)) > 32768
        )
          throw new Error('E4_LOG_OUTPUT');
        break;
      }
    }
  }
  if (pending || plans.length === 0) throw new Error('E4_LOG_MISSING');
  return plans;
}

type Observation = {
  scope: boolean;
  state: string;
  type: string;
  event: string;
  blockers: number;
  noTransaction: boolean;
};
type Dependencies = {
  observe: (sql: string, pid: number, scope: string) => Promise<unknown>;
  logs?: (since: string, until: string) => Promise<string>;
  pause?: () => Promise<void>;
};
async function dockerLogs(since: string, until: string): Promise<string> {
  const result = await runFile(
    'docker',
    ['logs', '--since', since, '--until', until, 'u-nest-api-postgres'],
    { encoding: 'utf8', maxBuffer: byteLimit, timeout: 5000, killSignal: 'SIGKILL' },
  );
  if (result.stdout && result.stderr) throw new Error('E4_LOG_STREAM');
  const text = result.stderr || result.stdout;
  if (Buffer.byteLength(text) > byteLimit) throw new Error('E4_LOG_INPUT');
  return text;
}

/** Wraps one existing30 callback above the existing90 adapter. Never alters business SQL/options. */
export class E4SameBackendPlanDiagnostic<T extends object> {
  readonly client: T;
  private active = false;
  private attempted = false;
  private pid = 0;
  private status: 'NOT_RUN' | 'OBSERVED' | 'UNKNOWN' = 'NOT_RUN';
  private reason: 'NONE' | 'SETUP' | 'MONITOR' | 'RESTORE' | 'LOG' = 'NONE';
  private restored = false;
  private monitor: Promise<void> | undefined;
  private plans: Plan[] = [];
  private samples = 0;
  private maxBlockers = 0;
  private waitTypes = Object.fromEntries([...waitTypes, 'OTHER'].map((key) => [key, 0]));
  private waitEvents = Object.fromEntries([...waitEvents, 'OTHER'].map((key) => [key, 0]));
  private terminal: 'NOT_OBSERVED' | 'IDLE_NO_TX' = 'NOT_OBSERVED';
  private costs: {
    setupMs: number | null;
    callbackMs: number | null;
    transactionWallMs: number | null;
    collectionMs: number | null;
  } = { setupMs: null, callbackMs: null, transactionWallMs: null, collectionMs: null };
  constructor(
    private readonly target: T,
    private readonly context: E4DiagnosticContext,
    private readonly deps: Dependencies,
  ) {
    if (
      context.purpose !== 'DIAGNOSTIC_ONLY' ||
      context.scope !== 'app_test_w98' ||
      context.fixture !== 'createMaximumE4Source' ||
      !/^[a-f0-9]{40}$/u.test(context.sourceHead)
    )
      throw new Error('E4_PLAN_CONTEXT');
    const original: unknown = Reflect.get(target, '$transaction');
    if (typeof original !== 'function') throw new Error('E4_PLAN_TRANSACTION');
    const invoke = async (receiver: unknown, args: unknown[]) => {
      if (
        receiver !== this.client ||
        this.attempted ||
        args.length !== 2 ||
        typeof args[0] !== 'function' ||
        !args[1] ||
        typeof args[1] !== 'object' ||
        Reflect.get(args[1], 'timeout') !== 30000
      )
        throw new Error('E4_PLAN_ONCE');
      this.attempted = true;
      const work = args[0] as (tx: Prisma.TransactionClient) => Promise<unknown>;
      const since = new Date().toISOString();
      const transactionStarted = performance.now();
      try {
        return await Reflect.apply(original, target, [
          async (tx: Prisma.TransactionClient) => {
            const setupStarted = performance.now();
            try {
              const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
                preflight,
                context.scope,
              );
              if (
                rows.length !== 1 ||
                !Number.isSafeInteger(rows[0].pid) ||
                Number(rows[0].pid) <= 0 ||
                [
                  'scope',
                  'version',
                  'allowed',
                  'logFormat',
                  'activity',
                  'disabled',
                  'catalog',
                ].some((key) => rows[0][key] !== true)
              )
                throw new Error('E4_PLAN_PREFLIGHT');
              this.pid = Number(rows[0].pid);
              await tx.$executeRawUnsafe("LOAD 'auto_explain'");
              for (const statement of settings) await tx.$executeRawUnsafe(statement);
              const enabled = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
                configurationCheck,
                context.scope,
              );
              if (
                enabled.length !== 1 ||
                enabled[0].pid !== this.pid ||
                enabled[0].scope !== true ||
                enabled[0].configured !== true
              )
                throw new Error('E4_PLAN_SETTINGS');
              this.active = true;
              this.monitor = this.monitorLoop();
            } catch {
              this.unknown('SETUP');
              throw new Error('E4_SAME_BACKEND_DIAGNOSTIC_UNKNOWN');
            } finally {
              this.costs.setupMs = performance.now() - setupStarted;
            }
            const callbackStarted = performance.now();
            try {
              return await work(tx);
            } finally {
              this.costs.callbackMs = performance.now() - callbackStarted;
            }
          },
          args[1],
        ]);
      } finally {
        // Original Prisma promise has settled; subsequent telemetry is not business transaction time.
        this.costs.transactionWallMs = performance.now() - transactionStarted;
        const collectionStarted = performance.now();
        this.active = false;
        await this.monitor;
        if (this.pid && this.reason !== 'SETUP') await this.collect(since);
        this.costs.collectionMs = performance.now() - collectionStarted;
      }
    };
    const wrapper = function (this: unknown, ...args: unknown[]) {
      return invoke(this, args);
    };
    this.client = new Proxy(target, {
      get: (client, key) => (key === '$transaction' ? wrapper : Reflect.get(client, key, client)),
    });
  }
  private unknown(reason: typeof this.reason) {
    this.status = 'UNKNOWN';
    if (this.reason === 'NONE') this.reason = reason;
  }
  private async observe(): Promise<Observation> {
    const raw = await this.deps.observe(observerSql, this.pid, this.context.scope);
    if (!Array.isArray(raw) || raw.length !== 1) throw new Error('E4_MONITOR_SHAPE');
    const row = record(raw[0]);
    if (
      row.scope !== true ||
      !['active', 'idle', 'idle in transaction', 'idle in transaction (aborted)'].includes(
        String(row.state),
      ) ||
      typeof row.type !== 'string' ||
      typeof row.event !== 'string' ||
      typeof row.noTransaction !== 'boolean' ||
      !Number.isSafeInteger(row.blockers)
    )
      throw new Error('E4_MONITOR_SCOPE');
    number(row.blockers, 1000);
    return row as unknown as Observation;
  }
  private async monitorLoop() {
    try {
      while (this.active) {
        if (++this.samples > 500) throw new Error('E4_MONITOR_LIMIT');
        const row = await this.observe();
        const type = (waitTypes as readonly string[]).includes(row.type) ? row.type : 'OTHER';
        const event = (waitEvents as readonly string[]).includes(row.event) ? row.event : 'OTHER';
        this.waitTypes[type]++;
        this.waitEvents[event]++;
        this.maxBlockers = Math.max(this.maxBlockers, row.blockers);
        if (this.active)
          await (this.deps.pause?.() ?? new Promise<void>((resolve) => setTimeout(resolve, 200)));
      }
    } catch {
      this.unknown('MONITOR');
    }
  }
  private async collect(since: string) {
    try {
      const row = await this.observe();
      if (row.state !== 'idle' || row.noTransaction !== true) throw new Error('E4_TERMINAL');
      this.terminal = 'IDLE_NO_TX';
      const query: unknown = Reflect.get(this.target, '$queryRawUnsafe');
      if (typeof query !== 'function') throw new Error('E4_RESTORE_QUERY');
      const rows: unknown = await Reflect.apply(query, this.target, [
        restoreCheck,
        this.context.scope,
      ]);
      if (
        !Array.isArray(rows) ||
        rows.length !== 1 ||
        record(rows[0]).pid !== this.pid ||
        record(rows[0]).scope !== true ||
        record(rows[0]).restored !== true
      )
        throw new Error('E4_RESTORE');
      this.restored = true;
    } catch {
      this.unknown('RESTORE');
      return;
    }
    try {
      this.plans = projectE4ServerLogs(
        await (this.deps.logs ?? dockerLogs)(since, new Date().toISOString()),
        this.pid,
      );
      if (
        !this.plans.some((p) =>
          ['EXPECTED_BUILD', 'EXPECTED_COMPARE', 'SOURCE_EXPANSION', 'SOURCE_CHECK'].includes(
            p.role,
          ),
        )
      )
        throw new Error('E4_HOTSPOT_COVERAGE');
      if (this.reason === 'NONE') this.status = 'OBSERVED';
    } catch {
      this.unknown('LOG');
    }
  }
  snapshot() {
    return {
      schema: 'e4-same-backend-plan/v1',
      purpose: 'DIAGNOSTIC_ONLY',
      acceptance: 'NOT_AN_ACCEPTANCE_RESULT',
      status: this.status,
      reason: this.reason,
      sameBackendAndSettingsRestored: this.restored,
      terminal: this.terminal,
      logMinDurationMs: 250,
      planFields: fields,
      plans: this.plans,
      crossStatementParents: 'UNOBSERVED',
      nestedTotalsAdditive: false,
      waitSamples: this.samples,
      waitTypes: this.waitTypes,
      waitEvents: this.waitEvents,
      maxBlockers: this.maxBlockers,
      costs: { ...this.costs },
    };
  }
}
