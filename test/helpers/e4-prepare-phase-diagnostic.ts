import { performance } from 'node:perf_hooks';

export const E4_PREPARE_PHASES = [
  'C3_PROOF',
  'C3_SOURCE',
  'C3_EVAL',
  'C3_BUCKET_WRITE',
  'E4_PREPARE',
  'E4_EVAL',
  'E4_EVAL_WRITE',
  'C3_RECEIPT',
] as const;
export type E4PreparePhase = (typeof E4_PREPARE_PHASES)[number];
export type E4PreparePhaseBinding = {
  phase: E4PreparePhase;
  target: object;
  method: string;
};

type Counters = {
  calls: number;
  pending: number;
  ok: number;
  failed: number;
  wallMs: number | null;
  queryCount: number;
  readMs: number;
  writeMs: number;
  largestMs: number;
};
type Installed = E4PreparePhaseBinding & {
  original: (...args: unknown[]) => unknown;
  descriptor: PropertyDescriptor | undefined;
  wrapper: (...args: unknown[]) => unknown;
};
type Frame = { phase: E4PreparePhase; started: number | null; settled: boolean };
const activeWrappers = new WeakSet<object>();
const MAX_CALLS = 32;
const MAX_BYTES = 4096;

function counters(): Counters {
  return {
    calls: 0,
    pending: 0,
    ok: 0,
    failed: 0,
    wallMs: 0,
    queryCount: 0,
    readMs: 0,
    writeMs: 0,
    largestMs: 0,
  };
}

/** Test-local method observers. Inputs and returned values are never retained or serialized. */
export class E4PreparePhaseDiagnostic {
  private readonly phases = new Map(E4_PREPARE_PHASES.map((phase) => [phase, counters()]));
  private readonly installed: Installed[] = [];
  private readonly frames: Frame[] = [];
  private readonly root = counters();
  private active = false;
  private begun = false;
  private stopped = false;
  private restored = false;
  private unknown = false;
  private lastTick: number | undefined;
  private rootStarted: number | null = null;

  constructor(
    bindings: readonly E4PreparePhaseBinding[],
    private readonly clock: () => number = () => performance.now(),
  ) {
    // Complete preflight before shadowing any instance method.
    try {
      const seen = new Set<E4PreparePhase>();
      const methods = new Map<object, Set<string>>();
      const prepared: Omit<Installed, 'wrapper'>[] = [];
      for (const binding of bindings) {
        if (
          !E4_PREPARE_PHASES.includes(binding.phase) ||
          seen.has(binding.phase) ||
          binding.target === null ||
          (typeof binding.target !== 'object' && typeof binding.target !== 'function') ||
          typeof binding.method !== 'string' ||
          methods.get(binding.target)?.has(binding.method)
        )
          throw new Error('Invalid fixed phase binding');
        const descriptor = Object.getOwnPropertyDescriptor(binding.target, binding.method);
        if (descriptor && (!('value' in descriptor) || descriptor.configurable === false))
          throw new Error('Phase method cannot be shadowed');
        const original: unknown = Reflect.get(binding.target, binding.method);
        if (typeof original !== 'function' || activeWrappers.has(original))
          throw new Error('Original phase method unavailable');
        seen.add(binding.phase);
        const owned = methods.get(binding.target) ?? new Set<string>();
        owned.add(binding.method);
        methods.set(binding.target, owned);
        prepared.push({
          ...binding,
          descriptor,
          original: original as (...args: unknown[]) => unknown,
        });
      }
      if (seen.size !== E4_PREPARE_PHASES.length)
        throw new Error('Fixed phase coverage unavailable');
      for (const item of prepared) {
        const invoke = (receiver: unknown, args: unknown[]) => this.invoke(item, receiver, args);
        const wrapper = function (this: unknown, ...args: unknown[]) {
          return invoke(this, args);
        };
        Object.defineProperty(item.target, item.method, {
          configurable: true,
          writable: true,
          enumerable: item.descriptor?.enumerable ?? false,
          value: wrapper,
        });
        activeWrappers.add(wrapper);
        this.installed.push({ ...item, wrapper });
      }
    } catch {
      this.unknown = true;
      this.restore();
    }
  }

  private tick(): number | null {
    try {
      const now = this.clock();
      if (
        !Number.isFinite(now) ||
        now < 0 ||
        (this.lastTick !== undefined && now < this.lastTick)
      ) {
        this.unknown = true;
        return null;
      }
      this.lastTick = now;
      return now;
    } catch {
      this.unknown = true;
      return null;
    }
  }

  private elapsed(start: number | null, end: number | null): number | null {
    if (start === null || end === null || !Number.isFinite(end - start) || end < start) {
      this.unknown = true;
      return null;
    }
    return end - start;
  }

  private invoke(item: Omit<Installed, 'wrapper'>, receiver: unknown, args: unknown[]): unknown {
    if (!this.active) return Reflect.apply(item.original, receiver, args);
    if (receiver !== item.target) {
      this.unknown = true;
      return Reflect.apply(item.original, receiver, args);
    }
    const row = this.phases.get(item.phase)!;
    if (row.calls >= MAX_CALLS || this.frames.length >= E4_PREPARE_PHASES.length) {
      this.unknown = true;
      return Reflect.apply(item.original, receiver, args);
    }
    const frame: Frame = { phase: item.phase, started: this.tick(), settled: false };
    row.calls++;
    row.pending++;
    this.frames.push(frame);
    let result: unknown;
    try {
      result = Reflect.apply(item.original, receiver, args);
    } catch (error) {
      this.settle(frame, false);
      throw error;
    }
    try {
      // Intrinsic subscription preserves the original Promise and ignores its payload/error.
      const subscribe = Reflect.get(Promise.prototype, 'then') as (
        this: void,
        ...args: unknown[]
      ) => unknown;
      void Reflect.apply(subscribe, result, [
        () => this.settle(frame, true),
        () => this.settle(frame, false),
      ]);
    } catch {
      this.unknown = true;
      this.settle(frame, null);
    }
    return result;
  }

  private settle(frame: Frame, ok: boolean | null): void {
    try {
      if (frame.settled) {
        this.unknown = true;
        return;
      }
      frame.settled = true;
      const index = this.frames.indexOf(frame);
      if (index !== this.frames.length - 1 || index < 0) this.unknown = true;
      if (index >= 0) this.frames.splice(index, 1);
      const row = this.phases.get(frame.phase)!;
      row.pending--;
      if (row.pending < 0) {
        this.unknown = true;
        row.pending = 0;
      }
      if (ok === null) this.unknown = true;
      else row[ok ? 'ok' : 'failed']++;
      const duration = this.elapsed(frame.started, this.tick());
      if (duration === null || row.wallMs === null || !Number.isFinite(row.wallMs + duration)) {
        this.unknown = true;
        row.wallMs = null;
      } else row.wallMs += duration;
    } catch {
      this.unknown = true;
    }
  }

  begin(): void {
    if (this.begun || this.restored) {
      this.unknown = true;
      return;
    }
    this.begun = true;
    this.active = true;
    this.root.calls = 1;
    this.root.pending = 1;
    this.rootStarted = this.tick();
  }

  /** Query counts describe event delivery windows; nested phase counters are inclusive. */
  query(kind: 'READ' | 'WRITE', durationMs: number): void {
    if (!this.active) return;
    if (!['READ', 'WRITE'].includes(kind) || !Number.isFinite(durationMs) || durationMs < 0) {
      this.unknown = true;
      return;
    }
    for (const row of [this.root, ...this.frames.map((frame) => this.phases.get(frame.phase)!)]) {
      if (
        row.queryCount >= Number.MAX_SAFE_INTEGER ||
        !Number.isFinite(row.readMs + durationMs) ||
        !Number.isFinite(row.writeMs + durationMs)
      ) {
        this.unknown = true;
        continue;
      }
      row.queryCount++;
      row[kind === 'READ' ? 'readMs' : 'writeMs'] += durationMs;
      row.largestMs = Math.max(row.largestMs, durationMs);
    }
  }

  finish(outcome: 'OK' | 'FAIL'): void {
    if (!this.active || this.stopped || !['OK', 'FAIL'].includes(outcome)) {
      this.unknown = true;
      return;
    }
    this.root.wallMs = this.elapsed(this.rootStarted, this.tick());
    this.root.pending = 0;
    this.root[outcome === 'OK' ? 'ok' : 'failed'] = 1;
    this.active = false;
    this.stopped = true;
    if (
      this.frames.length ||
      (outcome === 'OK' && E4_PREPARE_PHASES.some((phase) => this.phases.get(phase)!.calls === 0))
    )
      this.unknown = true;
  }

  restore(): void {
    if (this.restored) return;
    for (const item of [...this.installed].reverse()) {
      try {
        if (Reflect.get(item.target, item.method) !== item.wrapper)
          throw new Error('Phase observer lost method ownership');
        if (item.descriptor) Object.defineProperty(item.target, item.method, item.descriptor);
        else if (!Reflect.deleteProperty(item.target, item.method))
          throw new Error('Phase observer shadow could not be removed');
        if (Reflect.get(item.target, item.method) !== item.original)
          throw new Error('Original phase method was not restored');
        activeWrappers.delete(item.wrapper);
      } catch {
        this.unknown = true;
      }
    }
    this.restored = true;
    if (this.active || this.frames.length) this.unknown = true;
  }

  snapshot() {
    return {
      status:
        !this.unknown && this.begun && this.stopped && this.restored && !this.frames.length
          ? ('COMPLETE' as const)
          : ('UNKNOWN' as const),
      root: { ...this.root },
      phases: E4_PREPARE_PHASES.map((phase) => ({ phase, ...this.phases.get(phase)! })),
    };
  }

  emitTo(write: (safeJson: string) => void): boolean {
    try {
      const safeJson = JSON.stringify(this.snapshot());
      if (Buffer.byteLength(safeJson, 'utf8') > MAX_BYTES) {
        this.unknown = true;
        return false;
      }
      write(safeJson);
      return true;
    } catch {
      this.unknown = true;
      return false;
    }
  }
}
