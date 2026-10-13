import { performance } from 'node:perf_hooks';

const categories = ['READ', 'WRITE', 'MODEL', 'BATCH', 'BARRIER', 'UNKNOWN'] as const;
type Category = (typeof categories)[number];
type Counter = {
  calls: number;
  pending: number;
  ok: number;
  failed: number;
  wallMs: number;
  firstStartedMs: number | null;
  lastSettledMs: number | null;
};
const barrier =
  'SET CONSTRAINTS public.astr_parent_complete_guard, public.e4_revision_complete_guard IMMEDIATE';
function member(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined;
}
function isBarrier(query: unknown): boolean {
  const sql = member(member(member(query, 'query'), 'arguments'), 'query');
  return (
    member(query, 'action') === 'executeRaw' &&
    typeof sql === 'string' &&
    sql.trim().replace(/\s+/gu, ' ').replace(/;$/u, '') === barrier
  );
}
function classify(query: unknown, batch: boolean): Category {
  if (batch) return Array.isArray(query) && query.some(isBarrier) ? 'BARRIER' : 'BATCH';
  if (isBarrier(query)) return 'BARRIER';
  const action = member(query, 'action');
  if (action === 'queryRaw') return 'READ';
  if (action === 'executeRaw') return 'WRITE';
  return typeof action === 'string' ? 'MODEL' : 'UNKNOWN';
}
/** Observes existing engine request promises only; no query, parameters or result is retained. */
export class E4EngineRequestWaitDiagnostic {
  private readonly counters = new Map<Category, Counter>(
    categories.map((category) => [
      category,
      {
        calls: 0,
        pending: 0,
        ok: 0,
        failed: 0,
        wallMs: 0,
        firstStartedMs: null,
        lastSettledMs: null,
      },
    ]),
  );
  private readonly installed: {
    method: string;
    descriptor: PropertyDescriptor | undefined;
    original: (...args: unknown[]) => unknown;
    wrapper: (...args: unknown[]) => unknown;
  }[] = [];
  private active = false;
  private unknown = false;
  private restored = false;
  private started = 0;
  private last = 0;
  private stopped = 0;
  private pending = 0;
  private calls = 0;
  private insideMs = 0;
  private outsideMs = 0;

  constructor(
    private readonly engine: object,
    private readonly clock = () => performance.now(),
  ) {
    try {
      const prepared = ['request', 'requestBatch'].map((method) => {
        const original: unknown = Reflect.get(engine, method);
        const descriptor = Object.getOwnPropertyDescriptor(engine, method);
        if (
          typeof original !== 'function' ||
          (descriptor && (!('value' in descriptor) || descriptor.configurable === false))
        )
          throw new Error('Engine request bridge unavailable');
        return { method, original: original as (...args: unknown[]) => unknown, descriptor };
      });
      for (const item of prepared) {
        const invoke = (receiver: unknown, args: unknown[]) =>
          this.invoke(item.original, receiver, args, item.method === 'requestBatch');
        const wrapper = function (this: unknown, ...args: unknown[]) {
          return invoke(this, args);
        };
        Object.defineProperty(engine, item.method, {
          configurable: true,
          writable: true,
          enumerable: item.descriptor?.enumerable ?? false,
          value: wrapper,
        });
        this.installed.push({ ...item, wrapper });
      }
    } catch {
      this.unknown = true;
      this.restore();
    }
  }
  private tick(): number {
    try {
      const now = this.clock();
      if (!Number.isFinite(now) || now < this.last || now < 0) {
        this.unknown = true;
        return this.last;
      }
      this.last = now;
      return now;
    } catch {
      this.unknown = true;
      return this.last;
    }
  }
  private account(now: number, previous: number) {
    if (this.pending > 0) this.insideMs += now - previous;
    else this.outsideMs += now - previous;
  }
  begin() {
    if (this.active || this.calls || this.restored) {
      this.unknown = true;
      return;
    }
    this.started = this.tick();
    this.active = true;
  }
  private invoke(
    original: (...args: unknown[]) => unknown,
    receiver: unknown,
    args: unknown[],
    batch: boolean,
  ) {
    if (!this.active) return Reflect.apply(original, receiver, args);
    if (++this.calls > 400) {
      this.unknown = true;
      return Reflect.apply(original, receiver, args);
    }
    const previous = this.last;
    const started = this.tick();
    this.account(started, previous);
    let category: Category = 'UNKNOWN';
    try {
      category = classify(args[0], batch);
    } catch {
      this.unknown = true;
    }
    if (category === 'UNKNOWN') this.unknown = true;
    const counter = this.counters.get(category)!;
    counter.calls++;
    counter.pending++;
    counter.firstStartedMs ??= started - this.started;
    this.pending++;
    const settle = (ok: boolean) => {
      if (!this.active) {
        this.unknown = true;
        return;
      }
      const previous = this.last;
      const now = this.tick();
      this.account(now, previous);
      counter.pending--;
      this.pending--;
      if (ok) counter.ok++;
      else counter.failed++;
      counter.wallMs += now - started;
      counter.lastSettledMs = now - this.started;
    };
    let result: unknown;
    try {
      result = Reflect.apply(original, receiver, args);
    } catch (error) {
      settle(false);
      throw error;
    }
    if (!(result instanceof Promise)) {
      this.unknown = true;
      settle(true);
      return result;
    }
    // Side observer preserves the original Promise and its rejection identity.
    void result.then(
      () => {
        try {
          settle(true);
        } catch {
          this.unknown = true;
        }
      },
      () => {
        try {
          settle(false);
        } catch {
          this.unknown = true;
        }
      },
    );
    return result;
  }
  finish() {
    if (!this.active) {
      this.unknown = true;
      return;
    }
    const previous = this.last;
    this.stopped = this.tick();
    this.account(this.stopped, previous);
    this.active = false;
    if (this.pending) this.unknown = true;
  }
  restore() {
    if (this.restored) return;
    for (const item of this.installed) {
      try {
        if (Reflect.get(this.engine, item.method) !== item.wrapper) {
          this.unknown = true;
          continue;
        }
        if (item.descriptor) Object.defineProperty(this.engine, item.method, item.descriptor);
        else Reflect.deleteProperty(this.engine, item.method);
      } catch {
        this.unknown = true;
      }
    }
    this.restored = true;
  }
  snapshot() {
    return {
      status: this.unknown ? 'UNKNOWN' : 'COMPLETE',
      bridgeCalls: this.calls,
      pending: this.pending,
      wallMs: this.stopped - this.started,
      insideRequestMs: this.insideMs,
      outsideRequestMs: this.outsideMs,
      categories: categories.map((category) => ({ category, ...this.counters.get(category)! })),
    };
  }
}

const boundaryEvents = [
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SET_TRANSACTION',
  'EVAL_INSERT',
  'OTHER',
] as const;
type BoundaryEvent = (typeof boundaryEvents)[number];
type BoundaryEdge =
  | 'OUTER_ENTER'
  | 'OUTER_OK'
  | 'OUTER_ERROR'
  | 'NATIVE_ENTER'
  | 'NATIVE_OK'
  | 'NATIVE_ERROR';
type BoundaryFrame = { selected: boolean; nativeCalls: number };
type BoundarySnapshot = {
  status: 'NOT_RUN' | 'UNKNOWN' | 'COMPLETE';
  clock: 'SHARED_PREPARE_MONOTONIC';
  selectedCalls: number;
  nativeCalls: number;
  pendingOuter: number;
  pendingNative: number;
  trace: { edge: BoundaryEdge; atMs: number | null }[];
  events: {
    event: BoundaryEvent;
    calls: number;
    durationMs: number;
    largestMs: number;
    firstReceivedMs: number | null;
    lastReceivedMs: number | null;
  }[];
  reason?: 'OUTPUT_LIMIT';
};
type BoundaryInstalled = {
  target: object;
  method: string;
  descriptor: PropertyDescriptor | undefined;
  original: (...args: unknown[]) => unknown;
  wrapper: (...args: unknown[]) => unknown;
};

function evaluationInsert(sql: unknown): boolean {
  return (
    typeof sql === 'string' &&
    sql.length <= 16_384 &&
    /^\s*INSERT INTO "ParticipantContributionEvaluation"\s*\(/u.test(sql) &&
    /\bFROM jsonb_to_recordset\(/u.test(sql)
  );
}

/** Test-local boundaries. NATIVE_OK means Promise fulfillment, not SQL success; payloads are never decoded. */
export class E4NativeRequestBoundaryDiagnostic {
  private readonly installed: BoundaryInstalled[] = [];
  private readonly frames = new Set<BoundaryFrame>();
  private readonly trace: { edge: BoundaryEdge; atMs: number | null }[] = [];
  private readonly events = new Map<
    BoundaryEvent,
    {
      calls: number;
      durationMs: number;
      largestMs: number;
      firstReceivedMs: number | null;
      lastReceivedMs: number | null;
    }
  >(
    boundaryEvents.map((event) => [
      event,
      {
        calls: 0,
        durationMs: 0,
        largestMs: 0,
        firstReceivedMs: null,
        lastReceivedMs: null,
      },
    ]),
  );
  private active = false;
  private begun = false;
  private restored = false;
  private unknown = false;
  private anchor = 0;
  private last = 0;
  private calls = 0;
  private selectedCalls = 0;
  private nativeCalls = 0;
  private pendingNative = 0;
  private native: object | undefined;

  constructor(
    private readonly engine: object,
    private readonly clock = () => performance.now(),
  ) {
    try {
      const native: unknown = Reflect.get(engine, 'engine');
      if (Reflect.get(engine, 'name') !== 'LibraryEngine' || !native || typeof native !== 'object')
        throw new Error('Initialized native library bridge unavailable');
      this.native = native;
      const prepared = [
        { target: engine, method: 'request' },
        { target: engine, method: 'requestBatch' },
        { target: native, method: 'query' },
      ].map((item) => {
        const descriptor = Object.getOwnPropertyDescriptor(item.target, item.method);
        const original: unknown = Reflect.get(item.target, item.method);
        if (
          typeof original !== 'function' ||
          (descriptor && (!('value' in descriptor) || !descriptor.configurable))
        )
          throw new Error('Boundary bridge cannot be observed');
        return { ...item, descriptor, original: original as (...args: unknown[]) => unknown };
      });
      for (const item of prepared) {
        const invoke = (receiver: unknown, args: unknown[]) =>
          item.method === 'query'
            ? this.invokeNative(item.original, receiver, args)
            : this.invokeOuter(item.original, receiver, args, item.method === 'requestBatch');
        const wrapper = function (this: unknown, ...args: unknown[]) {
          return invoke(this, args);
        };
        Object.defineProperty(item.target, item.method, {
          configurable: true,
          writable: true,
          enumerable: item.descriptor?.enumerable ?? false,
          value: wrapper,
        });
        this.installed.push({ ...item, wrapper });
      }
    } catch {
      this.unknown = true;
      this.restore();
    }
  }

  private offset(): number | null {
    try {
      const now = this.clock();
      if (!Number.isFinite(now) || now < this.anchor || now < this.last)
        throw new Error('Invalid boundary clock');
      this.last = now;
      return now - this.anchor;
    } catch {
      this.unknown = true;
      return null;
    }
  }
  private record(edge: BoundaryEdge) {
    if (this.trace.length >= 8) {
      this.unknown = true;
      return;
    }
    this.trace.push({ edge, atMs: this.offset() });
  }
  private observe(result: unknown, settle: (ok: boolean) => void) {
    try {
      const subscribe: unknown = Reflect.get(Promise.prototype, 'then');
      if (typeof subscribe !== 'function') throw new Error('Promise subscription unavailable');
      void Reflect.apply(subscribe, result, [
        () => {
          try {
            settle(true);
          } catch {
            this.unknown = true;
          }
        },
        () => {
          try {
            settle(false);
          } catch {
            this.unknown = true;
          }
        },
      ]);
    } catch {
      this.unknown = true;
      settle(false);
    }
  }
  private invokeOuter(
    original: (...args: unknown[]) => unknown,
    receiver: unknown,
    args: unknown[],
    batch: boolean,
  ) {
    if (!this.active) return Reflect.apply(original, receiver, args);
    if (receiver !== this.engine || ++this.calls > 400 || this.frames.size >= 32) {
      this.unknown = true;
      return Reflect.apply(original, receiver, args);
    }
    let selected = false;
    try {
      const query = args[0];
      selected =
        !batch &&
        member(query, 'action') === 'executeRaw' &&
        evaluationInsert(member(member(member(query, 'query'), 'arguments'), 'query'));
    } catch {
      this.unknown = true;
    }
    const frame: BoundaryFrame = { selected, nativeCalls: 0 };
    this.frames.add(frame);
    if (selected) {
      this.selectedCalls++;
      this.record('OUTER_ENTER');
    }
    const settle = (ok: boolean) => {
      if (!this.active || !this.frames.delete(frame)) this.unknown = true;
      if (selected) {
        if (frame.nativeCalls !== 1) this.unknown = true;
        this.record(ok ? 'OUTER_OK' : 'OUTER_ERROR');
      }
    };
    let result: unknown;
    try {
      result = Reflect.apply(original, receiver, args);
    } catch (error) {
      settle(false);
      throw error;
    }
    this.observe(result, settle);
    return result;
  }
  private invokeNative(
    original: (...args: unknown[]) => unknown,
    receiver: unknown,
    args: unknown[],
  ) {
    if (!this.active) return Reflect.apply(original, receiver, args);
    const owners = [...this.frames];
    const frame = owners.length === 1 ? owners[0] : undefined;
    if (receiver !== this.native || (owners.length !== 1 && owners.some((owner) => owner.selected)))
      this.unknown = true;
    if (!frame?.selected || receiver !== this.native)
      return Reflect.apply(original, receiver, args);
    frame.nativeCalls++;
    this.nativeCalls++;
    this.pendingNative++;
    this.record('NATIVE_ENTER');
    const settle = (ok: boolean) => {
      if (!this.active) this.unknown = true;
      this.pendingNative--;
      this.record(ok ? 'NATIVE_OK' : 'NATIVE_ERROR');
    };
    let result: unknown;
    try {
      result = Reflect.apply(original, receiver, args);
    } catch (error) {
      settle(false);
      throw error;
    }
    this.observe(result, settle);
    return result;
  }

  begin(anchor: number) {
    if (this.begun || this.restored || !Number.isFinite(anchor) || anchor < 0) {
      this.unknown = true;
      return;
    }
    this.anchor = this.last = anchor;
    this.begun = this.active = true;
  }
  queryEvent(sql: string, durationMs: number) {
    if (!this.active) return;
    if (
      !Number.isFinite(durationMs) ||
      durationMs < 0 ||
      typeof sql !== 'string' ||
      sql.length > 16_384
    ) {
      this.unknown = true;
      return;
    }
    const control = sql.trim().replace(/;$/u, '');
    const event: BoundaryEvent =
      control === 'BEGIN'
        ? 'BEGIN'
        : control === 'COMMIT'
          ? 'COMMIT'
          : control === 'ROLLBACK'
            ? 'ROLLBACK'
            : /^SET TRANSACTION\b/u.test(control)
              ? 'SET_TRANSACTION'
              : evaluationInsert(sql)
                ? 'EVAL_INSERT'
                : 'OTHER';
    const row = this.events.get(event)!;
    if (row.calls >= 400 || !Number.isFinite(row.durationMs + durationMs)) {
      this.unknown = true;
      return;
    }
    const atMs = this.offset();
    row.calls++;
    row.durationMs += durationMs;
    row.largestMs = Math.max(row.largestMs, durationMs);
    row.firstReceivedMs ??= atMs;
    row.lastReceivedMs = atMs;
  }
  finish() {
    if (
      !this.active ||
      this.frames.size ||
      this.pendingNative ||
      this.selectedCalls !== 1 ||
      this.nativeCalls !== 1
    )
      this.unknown = true;
    this.active = false;
  }
  restore() {
    if (this.restored) return;
    for (const item of [...this.installed].reverse()) {
      try {
        if (Reflect.get(item.target, item.method) !== item.wrapper)
          throw new Error('Boundary observer lost ownership');
        if (item.descriptor) Object.defineProperty(item.target, item.method, item.descriptor);
        else Reflect.deleteProperty(item.target, item.method);
        if (Reflect.get(item.target, item.method) !== item.original)
          throw new Error('Boundary original was not restored');
      } catch {
        this.unknown = true;
      }
    }
    this.restored = true;
  }
  snapshot(): BoundarySnapshot {
    const value: BoundarySnapshot = {
      status:
        !this.begun && !this.unknown
          ? 'NOT_RUN'
          : this.unknown || this.active || !this.restored
            ? 'UNKNOWN'
            : 'COMPLETE',
      clock: 'SHARED_PREPARE_MONOTONIC',
      selectedCalls: this.selectedCalls,
      nativeCalls: this.nativeCalls,
      pendingOuter: this.frames.size,
      pendingNative: this.pendingNative,
      trace: this.trace.map((row) => ({ ...row })),
      events: boundaryEvents.map((event) => ({ event, ...this.events.get(event)! })),
    };
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 4096) {
      this.unknown = true;
      return { ...value, status: 'UNKNOWN', reason: 'OUTPUT_LIMIT', trace: [], events: [] };
    }
    return value;
  }
}
