import { performance } from 'node:perf_hooks';

/** Test-only actual transaction bridge observer. Does not retain arguments or results. */
export function observeTestEngineTransactions(engine: object, clock = () => performance.now()) {
  const original: unknown = Reflect.get(engine, 'transaction');
  const descriptor = Object.getOwnPropertyDescriptor(engine, 'transaction');
  if (
    typeof original !== 'function' ||
    (descriptor && (!('value' in descriptor) || !descriptor.configurable))
  )
    throw new Error('Test transaction bridge unavailable');
  const phases: { phase: string; elapsedMs: number; outcome: string }[] = [];
  let unknown = false;
  let pending = 0;
  const tick = (): number | null => {
    try {
      const value = clock();
      if (Number.isFinite(value) && value >= 0) return value;
    } catch {
      /* The original engine call must keep its result. */
    }
    unknown = true;
    return null;
  };
  const record = (phase: string, started: number | null, outcome: string) => {
    pending--;
    const ended = tick();
    if (started === null || ended === null) return;
    const elapsedMs = ended - started;
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || phases.length >= 32) {
      unknown = true;
      return;
    }
    phases.push({ phase, elapsedMs, outcome });
  };
  const wrapper = function (this: unknown, ...args: unknown[]) {
    const started = tick();
    pending++;
    const phase =
      typeof args[0] === 'string' && ['start', 'commit', 'rollback'].includes(args[0])
        ? args[0]
        : 'other';
    if (phase === 'other') unknown = true;
    let result: unknown;
    try {
      result = Reflect.apply(original, this, args);
    } catch (error) {
      record(phase, started, 'error');
      throw error;
    }
    if (!(result instanceof Promise)) {
      unknown = true;
      pending--;
      return result;
    }
    void result.then(
      () => {
        try {
          record(phase, started, 'ok');
        } catch {
          unknown = true;
        }
      },
      () => {
        try {
          record(phase, started, 'error');
        } catch {
          unknown = true;
        }
      },
    );
    return result;
  };
  Object.defineProperty(engine, 'transaction', {
    configurable: true,
    writable: true,
    enumerable: descriptor?.enumerable ?? false,
    value: wrapper,
  });
  let restored = false;
  return {
    snapshot: () => ({
      status: unknown || pending > 0 ? 'UNKNOWN' : 'COMPLETE',
      pending,
      phases: [...phases],
    }),
    restore: () => {
      if (restored) return;
      restored = true;
      if (Reflect.get(engine, 'transaction') !== wrapper) {
        unknown = true;
        return;
      }
      if (descriptor) Object.defineProperty(engine, 'transaction', descriptor);
      else Reflect.deleteProperty(engine, 'transaction');
    },
  };
}
