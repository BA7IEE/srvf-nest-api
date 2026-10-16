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
  observe?: () => Promise<unknown>;
  maintenance?: (sql: string) => Promise<unknown>;
  pause?: () => Promise<void>;
  now?: () => number;
  emit?: (event: object) => void;
};
type Sample = {
  atMs: number;
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
  private readonly samples: Sample[] = [];
  private readonly observerPids = new Set<number>();
  private readonly clock: () => number;
  private readonly deadline: number;
  private armed = false;
  private started: number | undefined;
  private pending = false;
  private terminal: 'NOT_RUN' | 'PENDING' | 'OK' | 'FAIL' = 'NOT_RUN';
  private durationMs: number | null = null;
  private pid: number | null = null;
  private epoch = '';
  private transaction = '';
  private monitoring: Promise<void> | undefined;
  private stopped = false;
  private outputEvents = 0;
  private queryEventMs: number | null = null;
  private queryEventCalls = 0;
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
  private emit(stage: string) {
    try {
      if (++this.outputEvents > 16) throw new Error('BOUND');
      const snapshot = this.snapshot();
      const full = [
        'REQUEST_TERMINAL',
        'OBSERVATION_DRAINED',
        'MONITOR_UNKNOWN',
        'INDEPENDENT_CLEANUP',
      ].includes(stage);
      const event = {
        schema: 'e4-slice-read/v1',
        stage,
        purpose: 'DIAGNOSTIC_ONLY',
        acceptance: 'NOT_AN_ACCEPTANCE_RESULT',
        ...snapshot,
        samples: full ? snapshot.samples : [],
        plan: full ? snapshot.plan : null,
      };
      if (Buffer.byteLength(JSON.stringify(event)) > 65536) throw new Error('BOUND');
      if (this.deps.emit) this.deps.emit(event);
      else writeSync(2, 'E4_SLICE_READ ' + JSON.stringify(event) + '\n');
    } catch {
      this.unknown('OUTPUT');
    }
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
    if (this.armed || this.started !== undefined) this.unknown('REPEATED_ARM');
    else this.armed = true;
  }
  restoreEngine() {
    this.restore(this.hooks[0]);
  }
  private request(original: Hook['original'], receiver: unknown, args: unknown[]) {
    let selected = false;
    try {
      const message = args[0],
        argument = member(member(message, 'query'), 'arguments');
      const sql = member(argument, 'query');
      selected =
        this.armed &&
        member(message, 'action') === 'queryRaw' &&
        typeof sql === 'string' &&
        sql.length <= 16384 &&
        hash(sql) === E4_SLICE_SQL_SHA256;
      if (selected) {
        if (this.started !== undefined) {
          this.unknown('REPEATED_SLICE');
          selected = false;
        } else {
          this.started = this.clock();
          this.pending = true;
          this.terminal = 'PENDING';
          this.emit('REQUEST_ENTER');
        }
      }
    } catch {
      this.unknown('REQUEST_SHAPE');
    }
    let result: unknown;
    try {
      result = Reflect.apply(original, receiver, args);
    } catch (error) {
      if (selected) this.settle(false);
      throw error;
    }
    if (selected) {
      if (!(result instanceof Promise)) this.unknown('PROMISE_SHAPE');
      else {
        this.monitoring = this.monitorLoop();
        void result.then(
          () => this.settle(true),
          () => this.settle(false),
        );
      }
    }
    return result;
  }
  private settle(ok: boolean) {
    this.pending = false;
    this.armed = false;
    this.terminal = ok ? 'OK' : 'FAIL';
    try {
      const elapsed = this.clock() - this.started!;
      if (!Number.isFinite(elapsed) || elapsed < 0) this.unknown('CLOCK');
      else this.durationMs = elapsed;
    } catch {
      this.unknown('CLOCK');
    }
    this.emit('REQUEST_TERMINAL');
  }
  queryEvent(sql: string, durationMs: number) {
    if (this.started === undefined || sql.length > 16384 || hash(sql) !== E4_SLICE_SQL_SHA256)
      return;
    if (!Number.isFinite(durationMs) || durationMs < 0 || ++this.queryEventCalls > 1)
      this.unknown('QUERY_EVENT');
    else this.queryEventMs = durationMs;
  }
  private async read() {
    return this.deps.observe?.() ?? observeSlice(this.monitor, this.binding);
  }
  private async monitorLoop() {
    try {
      while (this.pending && !this.stopped) {
        if (
          this.samples.length >= 180 ||
          this.clock() - this.started! > 40000 ||
          this.clock() > this.deadline - 2000
        )
          throw new Error('BOUND');
        const raw = await this.read();
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
          this.samples.push({
            atMs: this.clock() - this.started!,
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
            typeof t.queryMayBeTruncated !== 'boolean' ||
            !integer(t.blockers, 8)
          )
            throw new Error('PID');
          if (
            this.pid !== null &&
            (this.pid !== t.pid || this.epoch !== t.epoch || this.transaction !== t.transaction)
          )
            throw new Error('PID_CHANGED');
          const first = this.pid === null;
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
          this.samples.push({
            atMs: this.clock() - this.started!,
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
          if (first) this.emit('BACKEND_BOUND');
        }
        if (Buffer.byteLength(JSON.stringify(this.samples)) > 48000) throw new Error('BOUND');
        if (this.pending && !this.stopped)
          await (this.deps.pause?.() ?? new Promise<void>((resolve) => setTimeout(resolve, 200)));
      }
    } catch {
      this.unknown('MONITOR');
      this.emit('MONITOR_UNKNOWN');
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
    if (this.pending) this.unknown('PENDING_AT_COLLECTION');
    if (this.pid === null && this.started !== undefined) this.unknown('NO_BACKEND');
    this.emit('OBSERVATION_DRAINED');
  }
  // Called after the fixture app and its independent review client have actually closed.
  async collectCleanup() {
    this.stopped = true;
    if (this.pending || this.appClose !== 'COMPLETE' || this.observedClose !== 'COMPLETE')
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
    for (const hook of this.hooks.slice().reverse()) this.restore(hook);
    this.emit('INDEPENDENT_CLEANUP');
  }
  snapshot() {
    return {
      status: this.reasons.size
        ? 'UNKNOWN'
        : this.terminal === 'NOT_RUN'
          ? 'NOT_RUN'
          : this.pending
            ? 'PENDING'
            : 'OBSERVED',
      reasons: [...this.reasons],
      requestOutcome: this.terminal,
      requestDurationMs: this.durationMs,
      backendPid: this.pid,
      samples: this.samples.map((s) => ({ ...s, chain: s.chain.map((n) => ({ ...n })) })),
      queryIdentity: {
        client: 'FULL_NORMALIZED_SQL_SHA256',
        server: 'NORMALIZED_PREFIX_128_CHARS_ONLY',
        unmatchedPrefix: 'UNKNOWN_NOT_PROOF_OF_ABSENCE',
        fullServerQueryMatch: 'UNAVAILABLE',
      },
      lockChainBound: { depth: 2, fanout: 8, rows: 24, completeGraph: false },
      queryEvent: {
        calls: this.queryEventCalls,
        durationMs: this.queryEventMs,
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
