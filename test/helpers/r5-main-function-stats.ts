import { strict as assert } from 'node:assert';
import { performance } from 'node:perf_hooks';

// Fixed diagnostic SQL only. No request values, business DML, forced XID,
// counter reset/flush, persistent settings, role change, extension or log setup.
export const R5_FUNCTION_STATS_CONTROL_SQL = `SELECT jsonb_build_object(
  'database',current_database(),'databaseOid',(SELECT oid::BIGINT FROM pg_database WHERE datname=current_database()),
  'cluster',(SELECT system_identifier::TEXT FROM pg_control_system()),'pid',pg_backend_pid(),
  'xid',pg_current_xact_id_if_assigned()::TEXT,'role',current_user,'sessionUser',session_user,
  'trackFunctions',current_setting('track_functions'),'readOnly',current_setting('transaction_read_only'),
  'statementTimeout',current_setting('statement_timeout'),'lockTimeout',current_setting('lock_timeout'),
  'planCacheMode',current_setting('plan_cache_mode'),'workMem',current_setting('work_mem'),
  'rowDomainProof',1 / (EXISTS (
   SELECT 1 FROM pg_class c
   JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='id' AND a.attnotnull AND NOT a.attisdropped
   JOIN pg_constraint k ON k.conrelid=c.oid AND k.contype='p' AND k.convalidated AND NOT k.condeferrable
     AND k.conkey=ARRAY[a.attnum]::SMALLINT[]
   JOIN pg_index i ON i.indexrelid=k.conindid AND i.indisprimary AND i.indisunique AND i.indisvalid AND i.indisready AND i.indimmediate
   WHERE c.oid='public."ParticipantContributionEvaluation"'::REGCLASS AND c.relkind='r'
     AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
     AND NOT EXISTS (SELECT 1 FROM pg_inherits h WHERE h.inhparent=c.oid OR h.inhrelid=c.oid)
)::INTEGER),
  'canonicalOid','public.astr_canonical_json(jsonb)'::regprocedure::OID::BIGINT,
  'canonicalCalls',pg_stat_get_xact_function_calls('public.astr_canonical_json(jsonb)'::regprocedure)::TEXT
) AS observation`;

export const R5_FUNCTION_STATS_ENABLE_SQL =
  "SELECT pg_catalog.set_config('track_functions','all',true) AS enabled";
export const R5_FUNCTION_STATS_CALIBRATION_SQL = `SELECT public.astr_canonical_json(
  jsonb_build_object('r5_function_stats_probe',pg_backend_pid())) AS calibration`;

export const R5_FUNCTION_STATS_SNAPSHOT_SQL = `SELECT jsonb_build_object(
  'database',current_database(),'databaseOid',(SELECT oid::BIGINT FROM pg_database WHERE datname=current_database()),
  'cluster',(SELECT system_identifier::TEXT FROM pg_control_system()),'pid',pg_backend_pid(),
  'xid',pg_current_xact_id_if_assigned()::TEXT,'role',current_user,'sessionUser',session_user,
  'trackFunctions',current_setting('track_functions'),'readOnly',current_setting('transaction_read_only'),
  'at',clock_timestamp()::TEXT,
  'functions',(SELECT coalesce(jsonb_agg(jsonb_build_object(
    'oid',p.oid::BIGINT,'identity',p.oid::regprocedure::TEXT,'language',l.lanname,
    'hasConfig',p.proconfig IS NOT NULL,'recorded',s.funcid IS NOT NULL,
    'calls',s.calls::TEXT,'totalMs',s.total_time,'selfMs',s.self_time) ORDER BY p.oid),'[]'::JSONB)
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid=p.prolang
    LEFT JOIN pg_catalog.pg_stat_xact_user_functions s ON s.funcid=p.oid
    WHERE n.nspname='public' AND p.prokind='f')
) AS observation`;

export interface FunctionCounter {
  oid: number;
  identity: string;
  language: string;
  hasConfig: boolean;
  recorded: boolean;
  calls: string | null;
  totalMs: number | null;
  selfMs: number | null;
}
export interface Identity {
  database: string;
  databaseOid: number;
  cluster: string;
  pid: number;
  xid: string | null;
  role: string;
  sessionUser: string;
  trackFunctions: string;
  readOnly: string;
}
export interface Snapshot extends Identity {
  at: string;
  functions: FunctionCounter[];
}
export interface Segment {
  kind: 'EVALUATION_INSERT' | 'ORIGINAL_CONSTRAINT_BARRIER';
  fingerprint: string;
  before?: Snapshot;
  after?: Snapshot;
  outcome?: 'FULFILLED' | 'REJECTED';
  nativeElapsedMs?: number;
  error?: ReturnType<typeof summary>;
  observationError?: ReturnType<typeof summary>;
  deltas?: ReturnType<typeof functionCounterDeltas>;
}
function summary(error: unknown) {
  const code: unknown = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
  return {
    name: error instanceof Error ? error.name : typeof error,
    ...(typeof code === 'string' ? { code } : {}),
  };
}
function record(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'invalid stats record');
  return value as Record<string, unknown>;
}
function calls(value: unknown): bigint {
  assert(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value), 'invalid function count');
  return BigInt(value);
}
function time(value: unknown): number {
  assert(
    typeof value === 'number' && Number.isFinite(value) && value >= 0,
    'invalid function time',
  );
  return value;
}
function identity(value: unknown, requiredReadOnly: 'on' | 'off'): Identity {
  const row = record(value);
  assert.equal(row.database, 'app_test_r5_setmat_20261029_q1');
  assert.equal(row.databaseOid, 1998913);
  assert.equal(row.cluster, '7695840193603043362');
  assert.equal(row.role, 'postgres', 'observe the original MAIN role; never switch caller');
  assert.equal(row.sessionUser, 'postgres');
  assert.equal(row.readOnly, requiredReadOnly, 'unexpected observation transaction mode');
  assert(typeof row.pid === 'number' && Number.isSafeInteger(row.pid) && row.pid > 0);
  assert(row.xid === null || (typeof row.xid === 'string' && /^[1-9][0-9]*$/.test(row.xid)));
  assert(['none', 'pl', 'all'].includes(String(row.trackFunctions)));
  return row as unknown as Identity;
}
function snapshot(value: unknown, requiredReadOnly: 'on' | 'off'): Snapshot {
  const row = record(value);
  identity(row, requiredReadOnly);
  assert.equal(row.trackFunctions, 'all');
  assert(typeof row.at === 'string' && Array.isArray(row.functions) && row.functions.length > 0);
  const seen = new Set<number>();
  for (const value of row.functions) {
    const f = record(value);
    assert(
      typeof f.oid === 'number' && Number.isSafeInteger(f.oid) && f.oid > 0 && !seen.has(f.oid),
    );
    seen.add(f.oid);
    assert(typeof f.identity === 'string' && typeof f.language === 'string');
    assert(typeof f.hasConfig === 'boolean' && typeof f.recorded === 'boolean');
    if (f.recorded) {
      calls(f.calls);
      assert(time(f.totalMs) >= time(f.selfMs));
    } else assert(f.calls === null && f.totalMs === null && f.selfMs === null);
  }
  return row as unknown as Snapshot;
}

/** Missing tracked rows remain distinguishable from measured zero. */
export function functionCounterDeltas(before: FunctionCounter[], after: FunctionCounter[]) {
  const previous = new Map(before.map((f) => [f.oid, f]));
  const current = new Map(after.map((f) => [f.oid, f]));
  const oids = [...new Set([...previous.keys(), ...current.keys()])].sort((a, b) => a - b);
  return oids.map((oid) => {
    const a = previous.get(oid),
      b = current.get(oid);
    assert(
      a &&
        b &&
        a.identity === b.identity &&
        a.language === b.language &&
        a.hasConfig === b.hasConfig,
      'function catalog changed during observation',
    );
    if (!a.recorded && !b.recorded)
      return {
        oid,
        identity: b.identity,
        status: 'NOT_RECORDED',
        calls: null,
        totalMs: null,
        selfMs: null,
      };
    assert(b.recorded, 'local function counters disappeared/flushed; delta is unknown');
    const count = calls(b.calls) - (a.recorded ? calls(a.calls) : 0n);
    const totalMs = time(b.totalMs) - (a.recorded ? time(a.totalMs) : 0);
    const selfMs = time(b.selfMs) - (a.recorded ? time(a.selfMs) : 0);
    assert(
      count >= 0n && totalMs >= 0 && selfMs >= 0,
      'function counters decreased; delta is unknown',
    );
    return {
      oid,
      identity: b.identity,
      status: 'CAPTURED',
      beforeRecorded: a.recorded,
      afterRecorded: b.recorded,
      calls: count.toString(),
      totalMs,
      selfMs,
    };
  });
}

/** One opt-in original MAIN transaction. Counter collection precedes its first
 * business callback. Successful native SQL is never replaced or explained.
 */
function createFunctionStats(requiredReadOnly: 'on' | 'off') {
  let tx: object | undefined,
    setup: Record<string, unknown> | undefined,
    calibrated = false,
    setupError: ReturnType<typeof summary> | undefined,
    assignedXid: string | undefined;
  const segments: Segment[] = [];
  const reads: { purpose: string; elapsedMs: number; outcome: string }[] = [];
  const query = async (target: object, sql: string, purpose: string): Promise<unknown[]> => {
    const run: unknown = Reflect.get(target, '$queryRawUnsafe');
    assert(typeof run === 'function', 'original raw observation seam unavailable');
    const started = performance.now();
    try {
      const rows: unknown = await Reflect.apply(run, target, [sql]);
      assert(Array.isArray(rows));
      reads.push({ purpose, elapsedMs: performance.now() - started, outcome: 'FULFILLED' });
      return rows;
    } catch (error) {
      reads.push({ purpose, elapsedMs: performance.now() - started, outcome: 'REJECTED' });
      throw error;
    }
  };
  const take = async (target: object, purpose: string): Promise<Snapshot> => {
    assert.equal(target, tx, 'observation changed native transaction object');
    const rows = await query(target, R5_FUNCTION_STATS_SNAPSHOT_SQL, purpose);
    assert.equal(rows.length, 1);
    const value = snapshot(record(rows[0]).observation, requiredReadOnly);
    assert.equal(value.pid, setup?.pid);
    if (value.xid !== null) {
      assignedXid ??= value.xid;
      assert.equal(value.xid, assignedXid);
    } else assert(!assignedXid, 'native transaction XID disappeared');
    return value;
  };
  return {
    async enable(target: object) {
      assert(!tx, 'function stats allow one original MAIN transaction only');
      tx = target;
      try {
        const rows = await query(target, R5_FUNCTION_STATS_CONTROL_SQL, 'CONTROL_BEFORE_SET_LOCAL');
        assert.equal(rows.length, 1);
        setup = record(record(rows[0]).observation);
        identity(setup, requiredReadOnly);
        assert(typeof setup.canonicalOid === 'number' && Number.isSafeInteger(setup.canonicalOid));
        const before = setup.canonicalCalls === null ? 0n : calls(setup.canonicalCalls);
        const enabled = await query(
          target,
          R5_FUNCTION_STATS_ENABLE_SQL,
          'SET_LOCAL_TRACK_FUNCTIONS_ALL',
        );
        assert.equal(record(enabled[0]).enabled, 'all');
        await query(target, R5_FUNCTION_STATS_CALIBRATION_SQL, 'PURE_CANONICAL_CALIBRATION');
        const after = await take(target, 'CALIBRATION_SNAPSHOT');
        const canonical = after.functions.find((f) => f.oid === setup?.canonicalOid);
        assert(
          canonical?.recorded && calls(canonical.calls) - before === 1n,
          'tracking calibration failed; stop before native business callback',
        );
        calibrated = true;
      } catch (error) {
        setupError = summary(error);
        throw error;
      }
    },
    async observe<T>(
      target: object,
      kind: Segment['kind'],
      fingerprint: string,
      original: () => Promise<T>,
    ) {
      assert.equal(requiredReadOnly, 'off', 'the read-only preflight cannot dispatch native work');
      assert(calibrated && segments.length < 8, 'native function observation not armed/bounded');
      const entry: Segment = { kind, fingerprint };
      segments.push(entry);
      try {
        entry.before = await take(target, kind + '_BEFORE');
        assert(entry.before.xid !== null, 'original write path must already have assigned its XID');
      } catch (error) {
        entry.observationError = summary(error);
        throw error;
      }
      const started = performance.now();
      let result: T;
      try {
        result = await original();
        entry.outcome = 'FULFILLED';
      } catch (error) {
        entry.outcome = 'REJECTED';
        entry.error = summary(error);
        throw error; // Never query a failed/expired native transaction.
      } finally {
        entry.nativeElapsedMs = performance.now() - started;
      }
      try {
        entry.after = await take(target, kind + '_AFTER');
        entry.deltas = functionCounterDeltas(entry.before.functions, entry.after.functions);
      } catch (error) {
        entry.observationError = summary(error);
        throw error;
      }
      return result;
    },
    snapshot() {
      const coverageFor = (kind: Segment['kind']) => {
        const targets = segments.filter((s) => s.kind === kind);
        return {
          attempts: targets.length,
          status:
            targets.length === 0
              ? 'NOT_OBSERVED'
              : targets.every((s) => !!s.deltas && !s.observationError)
                ? 'CAPTURED'
                : 'UNKNOWN',
        };
      };
      const requiredTargets = {
        evaluationInsert: coverageFor('EVALUATION_INSERT'),
        originalConstraintBarrier: coverageFor('ORIGINAL_CONSTRAINT_BARRIER'),
      };
      return {
        schema: 'srvf-r5-native-function-stats/v1',
        setup,
        calibrated,
        setupError,
        reads,
        segments,
        requiredTargets,
        complete:
          calibrated &&
          !setupError &&
          Object.values(requiredTargets).every((t) => t.status === 'CAPTURED'),
        coverage: {
          scope:
            'same native MAIN backend/transaction; completed tracked public-function calls only',
          timing: 'inclusive wall and self wall, not CPU; do not add nested total times',
          absent:
            'NOT_RECORDED or a zero delta does not prove no execution; inline SQL and built-in FK work are not covered',
          rejectedNativeSql: 'before retained, after/delta UNKNOWN; never queried after failure',
          originalBudgetsUnchanged: true,
          observationOverheadInsideNativeBudget: true,
          calibrationWarmsCanonicalFunction: true,
          sharedCumulativeStatisticsMayNaturallyIncrease: true,
          historicalPlanOrInnerSqlCount: 'NOT_MEASURED',
        },
      };
    },
  };
}

export function createR5MainFunctionStats() {
  return createFunctionStats('off');
}

/** Call inside an explicitly READ ONLY observer transaction, before any NEW
 * source fixture is built. Uses the same SQL and calibration as the MAIN hook.
 */
export async function probeR5MainFunctionStatsReadOnly(tx: object) {
  const probe = createFunctionStats('on');
  await probe.enable(tx);
  return { kind: 'FUNCTION_STATS_READONLY_PREFLIGHT', ready: true, observation: probe.snapshot() };
}
