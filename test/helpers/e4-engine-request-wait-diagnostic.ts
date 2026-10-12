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
