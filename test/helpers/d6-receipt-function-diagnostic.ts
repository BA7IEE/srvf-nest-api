import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { deriveTestDbName } from '../setup/worktree-db';
import { functionCounterDeltas } from './r5-main-function-stats';

export const D6_RECEIPT_STATS_SQL = Object.freeze({
  save: 'SAVEPOINT d6_receipt_function_probe',
  rollback: 'ROLLBACK TO SAVEPOINT d6_receipt_function_probe',
  release: 'RELEASE SAVEPOINT d6_receipt_function_probe',
  enable: "SELECT pg_catalog.set_config('track_functions','all',true)='all' AS enabled",
  restore: "SELECT pg_catalog.set_config('track_functions','none',true)='none' AS restored",
  state: `WITH required(label,signature) AS (VALUES
    ('RECEIPT_GUARD','public.astr_receipt_complete_guard()'),
    ('SOURCE_DOCUMENT','public.astr_source_set_document(text,text)'),
    ('SOURCE_HASH','public.astr_source_set_hash(text,text)'),
    ('BUCKET_HASH','public.astr_bucket_content_hash(text)'),
    ('CANONICAL','public.astr_canonical_json(jsonb)'))
  SELECT pg_catalog.jsonb_build_object(
    'safeDatabase',current_database()=$1 AND NOT pg_catalog.pg_is_in_recovery(),
    'sameRole',current_user=session_user,
    'writable',current_setting('transaction_read_only')='off',
    'allowed',pg_catalog.has_parameter_privilege(current_user,'track_functions','SET'),
    'setting',current_setting('track_functions'),
    'backend',pg_catalog.pg_backend_pid(),
    'xact',pg_catalog.pg_current_xact_id_if_assigned()::TEXT,
    'functions',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'label',r.label,'oid',p.oid::BIGINT,'version',p.xmin::TEXT,'language',l.lanname,
      'recorded',s.funcid IS NOT NULL,'calls',s.calls::TEXT,
      'totalMs',s.total_time,'selfMs',s.self_time) ORDER BY r.label)
      FROM required r LEFT JOIN pg_catalog.pg_proc p
        ON p.oid=pg_catalog.to_regprocedure(r.signature) AND p.prokind='f'
      LEFT JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      LEFT JOIN pg_catalog.pg_stat_xact_user_functions s ON s.funcid=p.oid)
  ) AS observation`,
});

export type D6ReceiptFunctionLabel =
  | 'RECEIPT_GUARD'
  | 'SOURCE_DOCUMENT'
  | 'SOURCE_HASH'
  | 'BUCKET_HASH'
  | 'CANONICAL';

export type D6ReceiptFunctionRow = {
  label: D6ReceiptFunctionLabel;
  status: 'CAPTURED' | 'NOT_RECORDED';
  calls: string | null;
  totalMs: number | null;
  selfMs: number | null;
};

type Options = { env?: NodeJS.ProcessEnv; clock?: () => number };

const labels: D6ReceiptFunctionLabel[] = [
  'RECEIPT_GUARD',
  'SOURCE_DOCUMENT',
  'SOURCE_HASH',
  'BUCKET_HASH',
  'CANONICAL',
];
type Counter = D6ReceiptFunctionRow & {
  oid: number;
  version: string;
  language: string;
  recorded: boolean;
};
type State = {
  setting: 'none' | 'all';
  backend: number;
  xact: string;
  functions: Counter[];
};
type Reason =
  | 'NONE'
  | 'ENVIRONMENT'
  | 'INSTALL'
  | 'BEFORE_PROBE'
  | 'AFTER_PROBE'
  | 'COUNTERS'
  | 'NATIVE_ERROR'
  | 'DUPLICATE'
  | 'CLOCK'
  | 'OWNERSHIP'
  | 'OUTPUT';
const owners = new WeakMap<object, object>();
const preflightChecks = {
  safeDatabase: 'DATABASE_SCOPE',
  sameRole: 'ROLE',
  writable: 'WRITABLE',
  allowed: 'PERMISSION',
} as const;
type Checkpoint =
  | (typeof preflightChecks)[keyof typeof preflightChecks]
  | 'NOT_RUN'
  | 'STATE_SQL'
  | 'RESPONSE_SHAPE'
  | 'SETTING'
  | 'FUNCTION_SHAPE'
  | 'ENABLE'
  | 'BASELINE'
  | 'READY';

function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new Error('D6 receipt observation unavailable');
}
function own(value: unknown, key: string): unknown {
  requireValue(value && typeof value === 'object' && !types.isProxy(value));
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  requireValue(descriptor && 'value' in descriptor);
  return descriptor.value as unknown;
}
function array(value: unknown, length: number): unknown[] {
  requireValue(Array.isArray(value) && !types.isProxy(value) && value.length === length);
  return Array.from({ length }, (_, i) => own(value, String(i)));
}
function observation(rows: unknown): unknown {
  return own(array(rows, 1)[0], 'observation');
}
function decimal(value: unknown): string {
  requireValue(typeof value === 'string' && /^[1-9][0-9]{0,19}$/u.test(value));
  return value;
}
function positive(value: unknown): number {
  requireValue(typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
  return value;
}
function time(value: unknown): number {
  requireValue(
    typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= Number.MAX_SAFE_INTEGER,
  );
  return value;
}
function state(
  rows: unknown,
  setting: 'none' | 'all',
  checkpoint: (value: Checkpoint) => void = () => {},
): State {
  checkpoint('RESPONSE_SHAPE');
  const value = observation(rows);
  for (const key of ['safeDatabase', 'sameRole', 'writable', 'allowed'] as const) {
    checkpoint(preflightChecks[key]);
    requireValue(own(value, key) === true);
  }
  checkpoint('SETTING');
  requireValue(own(value, 'setting') === setting);
  checkpoint('FUNCTION_SHAPE');
  const counters = array(own(value, 'functions'), 5).map((row): Counter => {
    const label = own(row, 'label');
    requireValue(labels.includes(label as D6ReceiptFunctionLabel));
    const language = own(row, 'language');
    requireValue(language === 'sql' || language === 'plpgsql');
    const recorded = own(row, 'recorded');
    requireValue(typeof recorded === 'boolean');
    const calls = own(row, 'calls');
    const totalMs = own(row, 'totalMs');
    const selfMs = own(row, 'selfMs');
    if (recorded) {
      requireValue(
        typeof calls === 'string' &&
          /^(0|[1-9][0-9]{0,6})$/u.test(calls) &&
          BigInt(calls) <= 5000000n,
      );
      requireValue(time(totalMs) >= time(selfMs));
    } else requireValue(calls === null && totalMs === null && selfMs === null);
    return {
      label: label as D6ReceiptFunctionLabel,
      oid: positive(own(row, 'oid')),
      version: decimal(own(row, 'version')),
      language,
      recorded,
      status: recorded ? 'CAPTURED' : 'NOT_RECORDED',
      calls,
      totalMs: totalMs as number | null,
      selfMs: selfMs as number | null,
    };
  });
  requireValue(new Set(counters.map((v) => v.label)).size === 5);
  requireValue(new Set(counters.map((v) => v.oid)).size === 5);
  return {
    setting,
    backend: positive(own(value, 'backend')),
    xact: decimal(own(value, 'xact')),
    functions: labels.map((label) => counters.find((v) => v.label === label)!),
  };
}

/** CI-only async service instrumentation; this deliberately adds bounded diagnostic SQL. */
export class D6ReceiptFunctionDiagnostic {
  private status: 'DISABLED' | 'NOT_RUN' | 'OBSERVED' | 'UNKNOWN' = 'DISABLED';
  private reason: Reason = 'ENVIRONMENT';
  private nativeCalls = 0;
  private nativeOutcome: 'NOT_RUN' | 'OK' | 'ERROR' = 'NOT_RUN';
  private nativeReceiptMs: number | null = null;
  private diagnosticQueries = 0;
  private diagnosticMs: number | null = 0;
  private sameBackend: boolean | null = null;
  private sameTransaction: boolean | null = null;
  private settingRestored: boolean | null = null;
  private functions: D6ReceiptFunctionRow[] = [];
  private readonly clock: () => number;
  private readonly database?: string;
  private checkpoint: Checkpoint = 'NOT_RUN';
  private undo?: () => void;
  private lastTick = 0;

  constructor(target: object, options: Options = {}) {
    this.clock = options.clock ?? (() => performance.now());
    const env = options.env ?? process.env;
    const enabled =
      env.GITHUB_ACTIONS === 'true' &&
      env.GITHUB_WORKFLOW === 'CI' &&
      env.GITHUB_JOB === 'slow' &&
      env.GITHUB_EVENT_NAME === 'pull_request';
    if (!enabled) return;
    try {
      requireValue(!owners.has(target));
      requireValue(/^[1-9][0-9]?$/u.test(process.env.JEST_WORKER_ID ?? ''));
      this.database = deriveTestDbName();
      let prototype: object | null = target;
      let descriptor: PropertyDescriptor | undefined;
      for (let i = 0; prototype && !descriptor && i < 16; i++) {
        requireValue(!types.isProxy(prototype));
        descriptor = Object.getOwnPropertyDescriptor(prototype, 'receipt');
        prototype = Object.getPrototypeOf(prototype) as object | null;
      }
      requireValue(descriptor && 'value' in descriptor && typeof descriptor.value === 'function');
      const original = descriptor.value as (...args: unknown[]) => unknown;
      const previous = Object.getOwnPropertyDescriptor(target, 'receipt');
      requireValue(!previous || (previous.configurable && 'value' in previous));
      const observe = this.observe.bind(this);
      const wrapper = function (this: unknown, ...args: unknown[]) {
        return observe(original, this, args);
      };
      Object.defineProperty(target, 'receipt', {
        configurable: true,
        writable: true,
        enumerable: previous?.enumerable ?? false,
        value: wrapper,
      });
      owners.set(target, this);
      this.undo = () => {
        if (Object.getOwnPropertyDescriptor(target, 'receipt')?.value !== wrapper)
          this.unknown('OWNERSHIP');
        else if (previous) Object.defineProperty(target, 'receipt', previous);
        else Reflect.deleteProperty(target, 'receipt');
        if (owners.get(target) === this) owners.delete(target);
      };
      this.status = 'NOT_RUN';
      this.reason = 'NONE';
    } catch {
      this.unknown('INSTALL');
    }
  }
  private unknown(reason: Reason) {
    this.status = 'UNKNOWN';
    this.reason = reason;
    this.functions = [];
  }
  private tick() {
    try {
      const value = time(this.clock());
      requireValue(value >= this.lastTick);
      this.lastTick = value;
    } catch {
      this.unknown('CLOCK');
      this.diagnosticMs = null;
    }
    return this.lastTick;
  }
  private async observe(
    original: (...args: unknown[]) => unknown,
    receiver: unknown,
    args: unknown[],
  ): Promise<unknown> {
    if (this.nativeCalls) {
      this.nativeCalls = 2;
      this.unknown('DUPLICATE');
      return Reflect.apply(original, receiver, args);
    }
    this.nativeCalls = 1;
    let before: State | undefined;
    let query: ((sql: string) => Promise<unknown>) | undefined;
    let prepared = false;
    try {
      const tx = args[0] as object;
      const method: unknown = Reflect.get(tx, '$queryRawUnsafe');
      requireValue(typeof method === 'function');
      query = async (sql: string) => {
        this.diagnosticQueries++;
        const started = this.tick();
        try {
          return await Reflect.apply(
            method,
            tx,
            sql === D6_RECEIPT_STATS_SQL.state ? [sql, this.database] : [sql],
          );
        } finally {
          const elapsed = this.tick() - started;
          if (this.diagnosticMs !== null) this.diagnosticMs += elapsed;
        }
      };
      prepared = await this.probe(query, 'BEFORE_PROBE', async () => {
        this.checkpoint = 'STATE_SQL';
        const preflight = state(await query!(D6_RECEIPT_STATS_SQL.state), 'none', (value) => {
          this.checkpoint = value;
        });
        this.checkpoint = 'ENABLE';
        requireValue(
          own(array(await query!(D6_RECEIPT_STATS_SQL.enable), 1)[0], 'enabled') === true,
        );
        this.checkpoint = 'BASELINE';
        before = state(await query!(D6_RECEIPT_STATS_SQL.state), 'all');
        requireValue(before.backend === preflight.backend && before.xact === preflight.xact);
        this.checkpoint = 'READY';
      });
    } catch {
      this.unknown('BEFORE_PROBE');
    }

    let result: unknown;
    const started = this.tick();
    try {
      result = await Reflect.apply(original, receiver, args);
      this.nativeReceiptMs = this.tick() - started;
      this.nativeOutcome = 'OK';
    } catch (error) {
      this.nativeReceiptMs = this.tick() - started;
      this.nativeOutcome = 'ERROR';
      this.settingRestored = null;
      this.unknown('NATIVE_ERROR');
      // No observation SQL after a native failure. LOCAL settings follow its outer rollback.
      throw error;
    }
    if (!prepared || !query || !before) return result;

    let after: State | undefined;
    const collected = await this.probe(query, 'AFTER_PROBE', async () => {
      after = state(await query(D6_RECEIPT_STATS_SQL.state), 'all');
      requireValue(
        own(array(await query(D6_RECEIPT_STATS_SQL.restore), 1)[0], 'restored') === true,
      );
      this.settingRestored = true;
    });
    if (!collected) {
      this.settingRestored = await this.probe(query, 'AFTER_PROBE', async () => {
        requireValue(
          own(array(await query(D6_RECEIPT_STATS_SQL.restore), 1)[0], 'restored') === true,
        );
      });
      return result;
    }
    try {
      requireValue(after);
      const observed = after;
      this.sameBackend = before.backend === observed.backend;
      this.sameTransaction = before.xact === observed.xact;
      requireValue(this.sameBackend && this.sameTransaction);
      const convert = (row: Counter) => ({
        ...row,
        identity: row.label,
        hasConfig: false,
      });
      for (let i = 0; i < 5; i++)
        requireValue(
          before.functions[i].oid === observed.functions[i].oid &&
            before.functions[i].version === observed.functions[i].version &&
            before.functions[i].language === observed.functions[i].language,
        );
      const deltas = functionCounterDeltas(
        before.functions.map(convert),
        observed.functions.map(convert),
      );
      const rows = labels.map((label, index): D6ReceiptFunctionRow => {
        const row = deltas.find((v) => v.identity === label)!;
        requireValue(row.calls !== '0' || (row.totalMs === 0 && row.selfMs === 0));
        // A cached zero counter does not prove an SQL function was not inlined.
        if (observed.functions[index].language === 'sql' && row.calls === '0')
          return { label, status: 'NOT_RECORDED', calls: null, totalMs: null, selfMs: null };
        return {
          label,
          status: row.status as D6ReceiptFunctionRow['status'],
          calls: row.calls,
          totalMs: row.totalMs,
          selfMs: row.selfMs,
        };
      });
      requireValue(rows[0].status === 'CAPTURED' && rows[0].calls === '1');
      if (this.status !== 'UNKNOWN') {
        this.functions = rows;
        this.status = 'OBSERVED';
      }
    } catch {
      this.unknown('COUNTERS');
    }
    return result;
  }
  private async probe(
    query: (sql: string) => Promise<unknown>,
    reason: Reason,
    run: () => Promise<void>,
  ): Promise<boolean> {
    let saved = false;
    try {
      await query(D6_RECEIPT_STATS_SQL.save);
      saved = true;
      await run();
      await query(D6_RECEIPT_STATS_SQL.release);
      return true;
    } catch {
      this.unknown(reason);
      if (saved) {
        try {
          await query(D6_RECEIPT_STATS_SQL.rollback);
          await query(D6_RECEIPT_STATS_SQL.release);
        } catch {
          this.unknown(reason);
        }
      }
      return false;
    }
  }
  restore() {
    const undo = this.undo;
    this.undo = undefined;
    try {
      undo?.();
    } catch {
      this.unknown('OWNERSHIP');
    }
  }
  snapshot() {
    const value = {
      status: this.status,
      reason: this.reason,
      checkpoint: this.checkpoint,
      coverage:
        this.status !== 'OBSERVED'
          ? 'UNKNOWN'
          : this.functions.some((v) => v.status === 'NOT_RECORDED')
            ? 'PARTIAL'
            : 'COMPLETE',
      nativeCalls: this.nativeCalls,
      nativeOutcome: this.nativeOutcome,
      nativeReceiptMs: this.diagnosticMs === null ? null : this.nativeReceiptMs,
      diagnosticQueries: this.diagnosticQueries,
      diagnosticMs: this.diagnosticMs,
      sameBackend: this.sameBackend,
      sameTransaction: this.sameTransaction,
      settingRestored: this.settingRestored,
      functions: this.functions.map((v) => ({ ...v })),
      purpose: 'INSTRUMENTED_RECEIPT_NOT_PERFORMANCE_ACCEPTANCE',
      semantics: 'INCLUSIVE_TOTAL_SELF_NOT_CPU_DO_NOT_SUM_PARENT_CHILDREN',
      scope: 'CURRENT_TRANSACTION_ONLY_NO_GLOBAL_FUNCTION_STATS',
      settings: 'LOCAL_ONLY_NO_ROLE_OR_PERSISTENT_CHANGE',
      sqlZero: 'UNRESOLVED_ZERO_REPORTED_AS_NOT_RECORDED',
    };
    if (Buffer.byteLength(JSON.stringify(value)) > 4096) {
      this.unknown('OUTPUT');
      return { ...value, status: 'UNKNOWN', reason: 'OUTPUT', coverage: 'UNKNOWN', functions: [] };
    }
    return value;
  }
}
