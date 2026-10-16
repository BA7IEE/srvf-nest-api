import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { writeSync } from 'node:fs';
import { promisify } from 'node:util';
import type { PrismaClient } from '@prisma/client';
import { assertTestDatabaseUrl } from '../setup/test-db';
import { assertNamedTestDatabaseScope } from '../setup/test-run-scope';

export const E4_SLICE_SQL_SHA256 =
  '8558d7eaceacebb98f37c7d7879c0c2e7b7d6bfa60464a0005c2c6d1bac3b262';
export const E4_SLICE_PREFIX_MD5 = '26a76ae33c01abd6a7905880ac47b10d';
export const E4_EVAL_INSERT_SQL_SHA256 =
  'bbd5c19bba6466dbe309e151bc636b25ffc02c4ce9e6688066d443fe62cc4c68';
export const E4_EVAL_INSERT_PREFIX_MD5 = 'ce70b3dfc579c6fb38bd21b2e9633918';
export const E4_GUARD_BARRIER_SQL_SHA256 =
  '7d38ece065b155bfade0c09b8a1da4dc01d5ff800f859af04046648fd17323c1';
export const E4_GUARD_BARRIER_SQL_MD5 = 'cd601bbd0540014c7af41e1b5e4879eb';
export const E4_OBSERVATION_PHASES = [
  'SLICE_READ',
  'EVAL_INSERT',
  'RECEIPT_INSERT',
  'GUARD_BARRIER',
] as const;
type Phase = (typeof E4_OBSERVATION_PHASES)[number];
const runFile = promisify(execFile);
const normalize = (sql: string) => sql.trim().replace(/\s+/gu, ' ');
const hash = (sql: string) => createHash('sha256').update(normalize(sql)).digest('hex');
const member = (v: unknown, key: string): unknown =>
  v !== null && typeof v === 'object' ? Reflect.get(v, key) : undefined;
const integer = (v: unknown, max = 2147483647): v is number =>
  Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= max;
const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('E4_SLICE_SHAPE');
  return v as Record<string, unknown>;
};
const states = ['active', 'idle', 'idle in transaction', 'idle in transaction (aborted)'];
const waits = ['NONE', 'Lock', 'LWLock', 'IO', 'Client', 'IPC', 'Timeout', 'BufferPin', 'Activity'];
const events = [
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
];
const allowed = (v: unknown, values: string[]) =>
  typeof v === 'string' && values.includes(v) ? v : 'OTHER';

// A unique application_name and exactly one live transaction bind the actual request's PID.
// No query text, bound values, usernames, relation names or lock-object identifiers leave SQL.
export const E4_SLICE_OBSERVER_SQL = `WITH RECURSIVE candidates AS MATERIALIZED (
 SELECT a.* FROM pg_stat_activity a WHERE a.datname=current_database()
 AND a.application_name=$2 AND a.usename=current_user AND a.xact_start IS NOT NULL
), chosen AS MATERIALIZED (SELECT * FROM candidates WHERE (SELECT count(*) FROM candidates)=1),
chain(pid,parent,depth,path) AS (
 SELECT pid,NULL::int,0,ARRAY[pid] FROM chosen
 UNION ALL SELECT b.pid,c.pid,c.depth+1,c.path||b.pid FROM chain c
 CROSS JOIN LATERAL (SELECT p FROM unnest(pg_blocking_pids(c.pid)) p LIMIT 8) x
 JOIN pg_stat_activity b ON b.pid=x.p AND b.datname=current_database()
 WHERE c.depth<2 AND NOT b.pid=ANY(c.path)
)
SELECT current_database()=$1 AS scope,pg_backend_pid() AS "observerPid",
 current_setting('track_activities')='on' AS "activityOn",
 pg_size_bytes(current_setting('track_activity_query_size'))::int AS "activityBytes",
 (SELECT count(*)::int FROM candidates) AS "targetCount",
 (SELECT jsonb_agg(jsonb_build_object('pid',pid,'epoch',backend_start::text,'transaction',xact_start::text,'state',state,
 'type',coalesce(wait_event_type,'NONE'),'event',coalesce(wait_event,'NONE'),
 'slicePrefixMatches',md5(left(btrim(regexp_replace(query,'\\s+',' ','g')),128))=$3,
 'statement',CASE
 WHEN md5(left(btrim(regexp_replace(query,'\\s+',' ','g')),128))=$3 THEN 'SLICE_READ'
 WHEN md5(left(btrim(regexp_replace(query,'\\s+',' ','g')),128))=$4 THEN 'EVAL_INSERT'
 WHEN md5(btrim(regexp_replace(query,'\\s+',' ','g')))=$5 THEN 'GUARD_BARRIER'
 WHEN btrim(regexp_replace(query,'\\s+',' ','g')) ~ '^INSERT INTO ("public"\\.)?"ActivitySettlementTimeCommandReceipt" ' THEN 'RECEIPT_INSERT'
 WHEN btrim(query)='ROLLBACK' THEN 'ROLLBACK'
 WHEN btrim(query)='COMMIT' THEN 'COMMIT' ELSE 'OTHER' END,
 'queryMayBeTruncated',octet_length(query)>=pg_size_bytes(current_setting('track_activity_query_size'))-1,
 'blockers',cardinality(pg_blocking_pids(pid)))) FROM chosen) AS target,
 (SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) FROM (
 SELECT c.pid,c.parent,c.depth,a.state,coalesce(a.wait_event_type,'NONE') AS type,
 coalesce(a.wait_event,'NONE') AS event,cardinality(pg_blocking_pids(c.pid)) AS blockers
 FROM chain c JOIN pg_stat_activity a ON a.pid=c.pid AND a.datname=current_database()
 ORDER BY c.depth,c.pid LIMIT 24) x) AS chain`;

export function e4SliceReadOptions(url = process.env.DATABASE_URL) {
  try {
    assertTestDatabaseUrl(url);
    const parsed = new URL(url!);
    const applicationName = 'e4slice_' + randomBytes(8).toString('hex');
    parsed.searchParams.set('application_name', applicationName);
    return {
      scope: decodeURIComponent(parsed.pathname).slice(1),
      applicationName,
      clientOptions: { datasourceUrl: parsed.toString() },
    };
  } catch {
    throw new Error('E4_SLICE_TEST_SCOPE');
  }
}

type Binding = {
  scope: string;
  applicationName: string;
  deadlineMs?: number;
  dedicatedLease?: boolean;
};
async function observeSlice(monitor: PrismaClient, binding: Binding) {
  return monitor.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout='500ms'");
      return tx.$queryRawUnsafe(
        E4_SLICE_OBSERVER_SQL,
        binding.scope,
        binding.applicationName,
        E4_SLICE_PREFIX_MD5,
        E4_EVAL_INSERT_PREFIX_MD5,
        E4_GUARD_BARRIER_SQL_MD5,
      );
    },
    { timeout: 1000, maxWait: 500 },
  );
}

/** Fail before the expensive maximum source fixture if the actual observer SQL/scope cannot work. */
export async function preflightE4SliceReadDiagnostic(monitor: PrismaClient, binding: Binding) {
  try {
    assertNamedTestDatabaseScope([binding.scope]);
    const raw = await observeSlice(monitor, binding);
    if (!Array.isArray(raw) || raw.length !== 1) throw new Error('SHAPE');
    const row = record(raw[0]);
    if (
      row.scope !== true ||
      row.targetCount !== 0 ||
      row.activityOn !== true ||
      !integer(row.activityBytes) ||
      row.activityBytes < 256 ||
      !integer(row.observerPid) ||
      row.observerPid < 1
    )
      throw new Error('SCOPE');
  } catch {
    throw new Error('E4_SLICE_OBSERVER_PREFLIGHT_FAILED_BEFORE_MAXIMUM_FIXTURE');
  }
}
type Dependencies = {
  observe?: (phase: Phase) => Promise<unknown>;
  maintenance?: (sql: string) => Promise<unknown>;
  pause?: () => Promise<void>;
  now?: () => number;
  selfNow?: () => number;
  emit?: (event: object) => void;
};
type Sample = {
  atMs: number;
  readStartedAtMs: number;
  requestPendingAtSample: boolean;
  statement: string;
  statementMatchesWindow: boolean;
  executingWindow: boolean;
  pid: number | null;
  state: string;
  type: string;
  event: string;
  slicePrefixMatches: true | null;
  activityBytes: number;
  queryMayBeTruncated: boolean;
  blockers: number;
  chain: {
    pid: number;
    parent: number | null;
    depth: number;
    state: string;
    type: string;
    event: string;
    blockers: number;
  }[];
};
type Window = {
  phase: Phase;
  started: number;
  pending: boolean;
  outcome: 'PENDING' | 'OK' | 'FAIL';
  durationMs: number | null;
  queryEventMs: number | null;
  queryEventCalls: number;
  samples: Sample[];
};
type SelfCost = { calls: number; wallMs: number; processCpuUs: number };
type Hook = {
  target: object;
  key: string;
  original: (...args: unknown[]) => unknown;
  descriptor: PropertyDescriptor | undefined;
  wrapper: (...args: unknown[]) => unknown;
  restored: boolean;
};

/** One maximum-case observer. Never changes business SQL, transaction options or request Promises.
 * Independent sampling has a cost; observations are diagnostic evidence, not acceptance results. */
export class E4SliceReadDiagnostic {
  private readonly hooks: Hook[] = [];
  private readonly reasons = new Set<string>();
  private readonly windows = new Map<Phase, Window>();
  private readonly selfCost: Record<string, SelfCost> = {};
  private readonly observerRoundTrip = { calls: 0, failures: 0, totalMs: 0, maxMs: 0 };
  private readonly observerPids = new Set<number>();
  private readonly clock: () => number;
  private readonly deadline: number;
  private armed = false;
  private pid: number | null = null;
  private epoch = '';
  private transaction = '';
  private monitoring: Promise<void> | undefined;
  private stopped = false;
  private outputEvents = 0;
  private outputBytes = 0;
  private observedClose = 'NOT_RUN';
  private appClose = 'NOT_RUN';
  private cleanup: object | null = null;
  constructor(
    target: object,
    private readonly monitor: PrismaClient,
    app: object,
    private readonly binding: Binding,
    private readonly deps: Dependencies = {},
  ) {
    if (
      !/^[a-z0-9_]{1,63}$/u.test(binding.scope) ||
      !/^e4slice_[a-f0-9]{16}$/u.test(binding.applicationName)
    )
      throw new Error('E4_SLICE_BINDING');
    assertNamedTestDatabaseScope([binding.scope]);
    this.clock = deps.now ?? (() => performance.now());
    this.deadline = binding.deadlineMs ?? this.clock() + 600000;
    const engine: unknown = Reflect.get(target, '_engine');
    if (!engine || typeof engine !== 'object') throw new Error('E4_SLICE_ENGINE');
    try {
      this.hook(engine, 'request', (original, receiver, args) =>
        this.request(original, receiver, args),
      );
      this.hook(target, '$disconnect', (original, receiver, args) =>
        this.close('observed', original, receiver, args),
      );
      this.hook(app, 'close', (original, receiver, args) =>
        this.close('app', original, receiver, args),
      );
    } catch {
      for (const hook of this.hooks.slice().reverse()) this.restore(hook);
      throw new Error('E4_SLICE_INSTALL');
    }
  }
  private unknown(reason: string) {
    this.reasons.add(reason);
  }
  // Disjoint synchronous leaf scopes only. Never wrap the original request or an await.
  private cost<T>(scope: string, work: () => T): T {
    const now = this.deps.selfNow ?? (() => performance.now());
    let start: number, cpu: NodeJS.CpuUsage;
    try {
      start = now();
      cpu = process.cpuUsage();
    } catch {
      this.unknown('SELF_COST');
      return work();
    }
    try {
      return work();
    } finally {
      try {
        const wallMs = now() - start,
          used = process.cpuUsage(cpu);
        if (!Number.isFinite(wallMs) || wallMs < 0) this.unknown('SELF_COST');
        else {
          const value = (this.selfCost[scope] ??= { calls: 0, wallMs: 0, processCpuUs: 0 });
          value.calls++;
          value.wallMs += wallMs;
          value.processCpuUs += used.user + used.system;
        }
      } catch {
        this.unknown('SELF_COST');
      }
    }
  }
  private emit(stage: string, window?: Window) {
    this.cost('EMIT', () => {
      try {
        if (++this.outputEvents > 40) throw new Error('BOUND');
        const snapshot = this.snapshot();
        // One full record per window, after the last issued read returns. Avoid duplicate arrays.
        const full = stage === 'WINDOW_DRAINED';
        const event = {
          schema: 'e4-slice-read/v2',
          stage,
          phase: window?.phase ?? null,
          purpose: 'DIAGNOSTIC_ONLY',
          acceptance: 'NOT_AN_ACCEPTANCE_RESULT',
          ...snapshot,
          samples: [],
          windows: snapshot.windows.map((w) => ({
            ...w,
            samples: full && w.phase === window?.phase ? w.samples : [],
          })),
          plan: full ? snapshot.plan : null,
        };
        const serialized = JSON.stringify(event),
          bytes = Buffer.byteLength(serialized);
        if (bytes > 65536 || this.outputBytes + bytes > 524288) throw new Error('BOUND');
        this.outputBytes += bytes;
        if (this.deps.emit) this.deps.emit(event);
        else writeSync(2, 'E4_SLICE_READ ' + serialized + '\n');
      } catch {
        this.unknown('OUTPUT');
      }
    });
  }
  private hook(
    target: object,
    key: string,
    invoke: (fn: Hook['original'], receiver: unknown, args: unknown[]) => unknown,
  ) {
    const original: unknown = Reflect.get(target, key);
    if (typeof original !== 'function') throw new Error('E4_SLICE_METHOD');
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    const fn = original as Hook['original'];
    const wrapper = function (this: unknown, ...args: unknown[]) {
      return invoke(fn, this, args);
    };
    Object.defineProperty(target, key, { configurable: true, writable: true, value: wrapper });
    this.hooks.push({ target, key, original: fn, descriptor, wrapper, restored: false });
  }
  private restore(hook: Hook) {
    if (hook.restored) return;
    try {
      if (Reflect.get(hook.target, hook.key) !== hook.wrapper) {
        this.unknown('RESTORE_OWNERSHIP');
        return;
      }
      if (hook.descriptor)
        Object.defineProperty(
          hook.target,
          hook.key,
          typeof hook.descriptor.value !== 'function' && !hook.descriptor.get
            ? { ...hook.descriptor, value: hook.original, writable: true }
            : hook.descriptor,
        );
      else if (!Reflect.deleteProperty(hook.target, hook.key)) throw new Error('RESTORE');
      if (Reflect.get(hook.target, hook.key) !== hook.original) throw new Error('RESTORE');
      hook.restored = true;
    } catch {
      this.unknown('RESTORE');
    }
  }
  arm() {
    if (this.armed || this.windows.size) this.unknown('REPEATED_ARM');
    else this.armed = true;
  }
  restoreEngine() {
    this.armed = false;
    this.cost('RESTORE', () => this.restore(this.hooks[0]));
  }
  private phase(message: unknown): Phase | undefined {
    const action = member(message, 'action');
    if (
      action === 'createOne' &&
      member(message, 'modelName') === 'ActivitySettlementTimeCommandReceipt'
    )
      return 'RECEIPT_INSERT';
    if (action !== 'queryRaw' && action !== 'executeRaw') return;
    const sql = member(member(member(message, 'query'), 'arguments'), 'query');
    if (typeof sql !== 'string' || sql.length > 16384) return;
    const digest = hash(sql);
    if (action === 'queryRaw' && digest === E4_SLICE_SQL_SHA256) return 'SLICE_READ';
    if (action === 'executeRaw' && digest === E4_EVAL_INSERT_SQL_SHA256) return 'EVAL_INSERT';
    if (action === 'executeRaw' && digest === E4_GUARD_BARRIER_SQL_SHA256) return 'GUARD_BARRIER';
  }
  private request(original: Hook['original'], receiver: unknown, args: unknown[]) {
    let window: Window | undefined;
    try {
      this.cost('SELECT', () => {
        const phase = this.armed ? this.phase(args[0]) : undefined;
        if (!phase) return;
        if (this.windows.has(phase)) {
          this.unknown('REPEATED_' + phase);
          return;
        }
        if ([...this.windows.values()].some((w) => w.pending)) this.unknown('OVERLAPPING_REQUESTS');
        window = {
          phase,
          started: this.clock(),
          pending: true,
          outcome: 'PENDING',
          durationMs: null,
          queryEventMs: null,
          queryEventCalls: 0,
          samples: [],
        };
        this.windows.set(phase, window);
      });
      if (window) this.emit('REQUEST_ENTER', window);
    } catch {
      this.unknown('REQUEST_SHAPE');
    }
    let result: unknown;
    try {
      result = Reflect.apply(original, receiver, args);
    } catch (error) {
      if (window) this.settle(window, false);
      throw error;
    }
    if (window) {
      const selected = window;
      if (!(result instanceof Promise)) this.unknown('PROMISE_SHAPE');
      else {
        this.cost('SUBSCRIBE', () => {
          void result.then(
            () => this.settle(selected, true),
            () => this.settle(selected, false),
          );
        });
        const previous = this.monitoring;
        const observe = async () => {
          await this.monitorLoop(selected);
          this.emit('WINDOW_DRAINED', selected);
        };
        // Only independent reads wait for their predecessor; never delay the original request.
        this.monitoring = previous ? previous.then(observe) : observe();
      }
    }
    return result;
  }
  private settle(window: Window, ok: boolean) {
    this.cost('SETTLE', () => {
      window.pending = false;
      window.outcome = ok ? 'OK' : 'FAIL';
      try {
        const elapsed = this.clock() - window.started;
        if (!Number.isFinite(elapsed) || elapsed < 0) this.unknown('CLOCK');
        else window.durationMs = elapsed;
      } catch {
        this.unknown('CLOCK');
      }
    });
    this.emit('REQUEST_TERMINAL', window);
  }
  queryEvent(sql: string, durationMs: number) {
    // Original submit/review phases can reuse the same INSERT/barrier SQL after prepare.
    if (!this.armed) return;
    this.cost('QUERY_EVENT', () => {
      if (sql.length > 16384) return;
      const digest = hash(sql),
        normalized = normalize(sql);
      const phase =
        digest === E4_SLICE_SQL_SHA256
          ? 'SLICE_READ'
          : digest === E4_EVAL_INSERT_SQL_SHA256
            ? 'EVAL_INSERT'
            : digest === E4_GUARD_BARRIER_SQL_SHA256
              ? 'GUARD_BARRIER'
              : /^INSERT INTO ("public"\.)?"ActivitySettlementTimeCommandReceipt" /u.test(
                    normalized,
                  )
                ? 'RECEIPT_INSERT'
                : undefined;
      const window = phase ? this.windows.get(phase) : undefined;
      if (!window) return;
      if (!Number.isFinite(durationMs) || durationMs < 0 || ++window.queryEventCalls > 1)
        this.unknown('QUERY_EVENT');
      else window.queryEventMs = durationMs;
    });
  }
  private async read(window: Window) {
    const now = () => performance.now(),
      start = now();
    this.observerRoundTrip.calls++;
    try {
      return await (this.deps.observe?.(window.phase) ?? observeSlice(this.monitor, this.binding));
    } catch (error) {
      this.observerRoundTrip.failures++;
      throw error;
    } finally {
      const elapsed = now() - start;
      this.observerRoundTrip.totalMs += elapsed;
      this.observerRoundTrip.maxMs = Math.max(this.observerRoundTrip.maxMs, elapsed);
    }
  }
  private async monitorLoop(window: Window) {
    try {
      while (window.pending && !this.stopped) {
        if (
          window.samples.length >= 180 ||
          this.clock() - window.started > 40000 ||
          this.clock() > this.deadline - 2000
        )
          throw new Error('BOUND');
        const readStartedAtMs = this.clock() - window.started;
        const raw = await this.read(window);
        let first = false;
        this.cost('SAMPLE_PROJECT', () => {
          if (!Array.isArray(raw) || raw.length !== 1) throw new Error('SHAPE');
          const row = record(raw[0]);
          if (
            row.scope !== true ||
            row.activityOn !== true ||
            !integer(row.activityBytes) ||
            row.activityBytes < 256 ||
            !integer(row.observerPid) ||
            row.observerPid < 1 ||
            !integer(row.targetCount) ||
            row.targetCount > 1
          )
            throw new Error('BINDING');
          this.observerPids.add(row.observerPid);
          if (row.targetCount === 0)
            window.samples.push({
              atMs: this.clock() - window.started,
              readStartedAtMs,
              requestPendingAtSample: window.pending,
              statement: 'NO_TRANSACTION',
              statementMatchesWindow: false,
              executingWindow: false,
              pid: null,
              state: 'NO_TRANSACTION',
              type: 'NONE',
              event: 'NONE',
              slicePrefixMatches: null,
              activityBytes: row.activityBytes,
              queryMayBeTruncated: false,
              blockers: 0,
              chain: [],
            });
          else {
            if (
              !Array.isArray(row.target) ||
              row.target.length !== 1 ||
              !Array.isArray(row.chain) ||
              row.chain.length > 24
            )
              throw new Error('SHAPE');
            const t = record(row.target[0]);
            if (
              !integer(t.pid) ||
              t.pid < 1 ||
              t.pid === row.observerPid ||
              typeof t.epoch !== 'string' ||
              t.epoch.length > 64 ||
              typeof t.transaction !== 'string' ||
              t.transaction.length > 64 ||
              typeof t.slicePrefixMatches !== 'boolean' ||
              typeof t.statement !== 'string' ||
              typeof t.queryMayBeTruncated !== 'boolean' ||
              !integer(t.blockers, 8)
            )
              throw new Error('PID');
            if (
              this.pid !== null &&
              (this.pid !== t.pid || this.epoch !== t.epoch || this.transaction !== t.transaction)
            )
              throw new Error('PID_CHANGED');
            first = this.pid === null;
            this.pid = t.pid;
            this.epoch = t.epoch;
            this.transaction = t.transaction;
            const chain = row.chain.map((value: unknown) => {
              const n = record(value);
              if (
                !integer(n.pid) ||
                n.pid < 1 ||
                (n.parent !== null && (!integer(n.parent) || n.parent < 1)) ||
                !integer(n.depth, 2) ||
                !integer(n.blockers, 8)
              )
                throw new Error('CHAIN');
              return {
                pid: n.pid,
                parent: n.parent,
                depth: n.depth,
                state: allowed(n.state, states),
                type: allowed(n.type, waits),
                event: allowed(n.event, events),
                blockers: n.blockers,
              };
            });
            const statement = allowed(t.statement, [
              ...E4_OBSERVATION_PHASES,
              'ROLLBACK',
              'COMMIT',
              'OTHER',
            ]);
            window.samples.push({
              readStartedAtMs,
              requestPendingAtSample: window.pending,
              statement,
              statementMatchesWindow: statement === window.phase,
              executingWindow: window.pending && t.state === 'active' && statement === window.phase,
              atMs: this.clock() - window.started,
              pid: t.pid,
              state: allowed(t.state, states),
              type: allowed(t.type, waits),
              event: allowed(t.event, events),
              slicePrefixMatches: t.slicePrefixMatches ? true : null,
              activityBytes: row.activityBytes,
              queryMayBeTruncated: t.queryMayBeTruncated,
              blockers: t.blockers,
              chain,
            });
          }
          if (Buffer.byteLength(JSON.stringify(window.samples)) > 48000) {
            window.samples.pop();
            throw new Error('BOUND');
          }
        });
        if (first) this.emit('BACKEND_BOUND', window);
        if (window.pending && !this.stopped)
          await (this.deps.pause?.() ?? new Promise<void>((resolve) => setTimeout(resolve, 200)));
      }
    } catch {
      this.unknown('MONITOR');
      this.emit('MONITOR_UNKNOWN', window);
    }
  }
  private close(
    kind: 'observed' | 'app',
    original: Hook['original'],
    receiver: unknown,
    args: unknown[],
  ) {
    const set = (status: string) => {
      if (kind === 'app') this.appClose = status;
      else this.observedClose = status;
      this.emit((kind === 'app' ? 'APP_CLOSE_' : 'OBSERVED_CLOSE_') + status);
    };
    set('PENDING');
    let result: unknown;
    try {
      result = Reflect.apply(original, receiver, args);
    } catch (error) {
      set('FAIL');
      this.unknown('CLOSE');
      throw error;
    }
    if (!(result instanceof Promise)) {
      this.unknown('CLOSE_PROMISE');
      return result;
    }
    void result.then(
      () => {
        set('COMPLETE');
      },
      () => {
        set('FAIL');
        this.unknown('CLOSE');
      },
    );
    return result;
  }
  // Drain the already-issued read. Never issue EXPLAIN or copy bound values to another session.
  async finishObservation() {
    this.stopped = true;
    await this.monitoring;
    if ([...this.windows.values()].some((w) => w.pending)) this.unknown('PENDING_AT_COLLECTION');
    if (this.pid === null && this.windows.size) this.unknown('NO_BACKEND');
    this.emit('OBSERVATION_DRAINED');
  }
  // Called after the fixture app and its independent review client have actually closed.
  async collectCleanup() {
    this.stopped = true;
    if (
      [...this.windows.values()].some((w) => w.pending) ||
      this.appClose !== 'COMPLETE' ||
      this.observedClose !== 'COMPLETE'
    )
      this.unknown('CLEANUP_LIFECYCLE');
    const pids = [this.pid, ...this.observerPids].filter((v): v is number => v !== null);
    const sql = `SELECT json_build_object('databases',(SELECT count(*) FROM pg_database WHERE datname='${this.binding.scope}'),'clients',(SELECT count(*) FROM pg_stat_activity WHERE datname='${this.binding.scope}'),'capturedBackends',(SELECT count(*) FROM pg_stat_activity WHERE datname='${this.binding.scope}' AND pid=ANY(ARRAY[${pids.join(',')}]::int[])))::text`;
    try {
      const raw = this.deps.maintenance
        ? await this.deps.maintenance(sql)
        : JSON.parse(
            (
              await runFile(
                'docker',
                [
                  'exec',
                  'u-nest-api-postgres',
                  'psql',
                  '-U',
                  'postgres',
                  '-d',
                  'postgres',
                  '-XAt',
                  '-v',
                  'ON_ERROR_STOP=1',
                  '-c',
                  sql,
                ],
                { timeout: 5000, maxBuffer: 4096 },
              )
            ).stdout.trim(),
          );
      const r = raw as Record<string, unknown>;
      if (
        !r ||
        !integer(r.databases, 1) ||
        !integer(r.clients, 10000) ||
        !integer(r.capturedBackends, 10000)
      )
        throw new Error('SHAPE');
      this.cleanup = {
        databases: r.databases,
        clients: r.clients,
        capturedBackends: r.capturedBackends,
        workerFinalizer:
          r.databases === 1
            ? this.binding.dedicatedLease
              ? 'RETAINED_FOR_DEDICATED_OWNER_FINALIZER'
              : 'RETAINED_FOR_GLOBAL_TEARDOWN'
            : 'ABSENT',
        postGlobalDrop: 'UNOBSERVED',
        container: 'RETAINED_TEST_SERVICE',
        dedicatedLease: this.binding.dedicatedLease ? 'UNOBSERVED' : 'NOT_APPLICABLE',
      };
      if (r.clients !== 0 || r.capturedBackends !== 0) this.unknown('REMAINING_BACKENDS');
    } catch {
      this.unknown('CLEANUP_READ');
    }
    this.cost('RESTORE', () => {
      for (const hook of this.hooks.slice().reverse()) this.restore(hook);
    });
    this.emit('INDEPENDENT_CLEANUP');
  }
  snapshot() {
    const slice = this.windows.get('SLICE_READ');
    const windows = E4_OBSERVATION_PHASES.map((phase) => {
      const w = this.windows.get(phase);
      return {
        phase,
        requestOutcome: w?.outcome ?? 'NOT_RUN',
        requestDurationMs: w?.durationMs ?? null,
        sampleCoverage: !w
          ? 'NOT_RUN'
          : !w.samples.length
            ? 'NOT_CAPTURED'
            : w.samples.some((s) => s.executingWindow)
              ? 'MATCHING_ACTIVE_SAMPLES_ONLY'
              : 'NO_MATCHING_ACTIVE_SAMPLE_NOT_PROOF_OF_ABSENCE',
        queryEvent: {
          calls: w?.queryEventCalls ?? 0,
          durationMs: w?.queryEventMs ?? null,
          meaning: 'PRISMA_QUERY_EVENT_NOT_PURE_SERVER_TIME',
        },
        samples: (w?.samples ?? []).map((s) => ({ ...s, chain: s.chain.map((n) => ({ ...n })) })),
        clientIdentity:
          phase === 'RECEIPT_INSERT'
            ? 'MODEL_NAME_AND_CREATE_ONE_ACTION'
            : 'FULL_NORMALIZED_SQL_SHA256',
        serverIdentity:
          phase === 'GUARD_BARRIER'
            ? 'FULL_NORMALIZED_SQL_MD5'
            : phase === 'RECEIPT_INSERT'
              ? 'TABLE_INSERT_PREFIX_ONLY'
              : 'NORMALIZED_PREFIX_128_CHARS_ONLY',
        backendIdentity: 'PID_BACKEND_START_XACT_START_STICKY_ACROSS_WINDOWS',
      };
    });
    return {
      status: this.reasons.size
        ? 'UNKNOWN'
        : this.windows.size === 0
          ? 'NOT_RUN'
          : [...this.windows.values()].some((w) => w.pending)
            ? 'PENDING'
            : 'OBSERVED',
      reasons: [...this.reasons],
      requestOutcome: slice?.outcome ?? 'NOT_RUN',
      requestDurationMs: slice?.durationMs ?? null,
      backendPid: this.pid,
      samples: windows[0].samples,
      windows,
      observationMeaning:
        'BOUNDED_POINT_SAMPLES_NOT_CONTINUOUS_SERVER_EXECUTION_OR_LOCK_ABSENCE_PROOF',
      observerCost: {
        synchronousScopes: Object.fromEntries(
          Object.entries(this.selfCost).map(([k, v]) => [k, { ...v }]),
        ),
        synchronousTotalWallMs: Object.values(this.selfCost).reduce((n, v) => n + v.wallMs, 0),
        processCpuMeaning:
          'PROCESS_WIDE_THREADS_DURING_DISJOINT_SYNC_SCOPES_NOT_ISOLATED_OBSERVER_CPU',
        snapshotBoundary: 'BEFORE_CURRENT_EMIT_RECORD_INCLUDING_ITS_WRITE',
        observerRoundTrip: { ...this.observerRoundTrip },
        roundTripMeaning: 'INDEPENDENT_READ_ONLY_TRANSACTION_RTT_NOT_ADDED_BUSINESS_LATENCY',
        exclusions: 'BUSINESS_REQUEST_AND_AWAITS_PAUSE_AND_ASYNC_SCHEDULING',
        coverage: 'INSTRUMENTED_SYNC_SCOPES_ONLY_NOT_TOTAL_INCREMENTAL_BUSINESS_OVERHEAD',
        acceptance: 'NEVER_SUBTRACT_COST_TO_ACCEPT_30_SECOND_BUDGET',
      },
      outputBound: {
        frames: this.outputEvents,
        bytes: this.outputBytes,
        maxFrames: 40,
        maxBytes: 524288,
      },
      queryIdentity: {
        client: 'FULL_NORMALIZED_SQL_SHA256',
        server: 'NORMALIZED_PREFIX_128_CHARS_ONLY',
        unmatchedPrefix: 'UNKNOWN_NOT_PROOF_OF_ABSENCE',
        fullServerQueryMatch: 'UNAVAILABLE',
      },
      lockChainBound: { depth: 2, fanout: 8, rows: 24, completeGraph: false },
      queryEvent: {
        calls: slice?.queryEventCalls ?? 0,
        durationMs: slice?.queryEventMs ?? null,
        meaning: 'PRISMA_QUERY_EVENT_NOT_PURE_SERVER_TIME',
      },
      planStatus: 'UNAVAILABLE',
      actualSameTransactionPlan: 'UNAVAILABLE',
      planVisibility: 'No actual transaction plan was captured; no external EXPLAIN was issued',
      plan: null,
      observedClose: this.observedClose,
      appClose: this.appClose,
      cleanup: this.cleanup,
    };
  }
}
