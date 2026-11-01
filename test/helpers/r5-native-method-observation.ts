import assert from 'node:assert/strict';

/** One existing client method, not a server-statement or trigger timer.
 * No arguments/results are recorded and the original rejection is preserved. */
export function observeR5BatchCommitUpdate(
  delegate: object,
  batchId: string,
  context: () => Record<string, unknown>,
  emit: (event: Record<string, unknown>) => void,
  errorView: (error: unknown) => unknown,
  clock = () => performance.now(),
) {
  const original: unknown = Reflect.get(delegate, 'update');
  assert(typeof original === 'function');
  const descriptor = Object.getOwnPropertyDescriptor(delegate, 'update');
  let restored = false;
  const tick = () => {
    try {
      const value = clock();
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  };
  const safe = (event: Record<string, unknown>) => {
    try {
      emit(event);
    } catch {
      /* Never replace business result or error. */
    }
  };
  const replacement = function (this: unknown, ...args: unknown[]) {
    const input = args[0];
    const where = input && typeof input === 'object' ? Reflect.get(input, 'where') : undefined;
    const data = input && typeof input === 'object' ? Reflect.get(input, 'data') : undefined;
    if (
      !where ||
      typeof where !== 'object' ||
      Reflect.get(where, 'id') !== batchId ||
      !data ||
      typeof data !== 'object' ||
      Reflect.get(data, 'statusCode') !== 'committed'
    )
      return Reflect.apply(original, this, args);
    const startedMs = tick(),
      correlation = context();
    safe({
      kind: 'ASYNC_NATIVE_CLIENT_METHOD',
      event: 'STARTED',
      method: 'LedgerPostingBatch.update(committed)',
      correlation,
      clientStartedMs: startedMs,
      serverTimingUnknown: true,
      argumentsCaptured: false,
    });
    const invokedMs = tick();
    const rejected = (error: unknown) => {
      let detail: unknown = { serialization: 'UNAVAILABLE' };
      try {
        detail = errorView(error);
      } catch {
        /* Preserve original exception. */
      }
      safe({
        kind: 'ASYNC_NATIVE_CLIENT_METHOD',
        event: 'REJECTED',
        method: 'LedgerPostingBatch.update(committed)',
        correlation,
        clientStartedMs: startedMs,
        clientInvokedMs: invokedMs,
        clientSettledMs: tick(),
        error: detail,
        serverTimingUnknown: true,
      });
      throw error;
    };
    let result: unknown;
    try {
      result = Reflect.apply(original, this, args);
    } catch (error) {
      return rejected(error);
    }
    return Promise.resolve(result).then((value) => {
      safe({
        kind: 'ASYNC_NATIVE_CLIENT_METHOD',
        event: 'FULFILLED',
        method: 'LedgerPostingBatch.update(committed)',
        correlation,
        clientStartedMs: startedMs,
        clientInvokedMs: invokedMs,
        clientSettledMs: tick(),
        serverTimingUnknown: true,
        resultCaptured: false,
      });
      return value;
    }, rejected);
  };
  assert(Reflect.set(delegate, 'update', replacement));
  assert.equal(
    Reflect.get(delegate, 'update'),
    replacement,
    'transaction delegate observation unavailable',
  );
  return () => {
    if (restored) return;
    assert.equal(
      Reflect.get(delegate, 'update'),
      replacement,
      'transaction delegate observation ownership changed',
    );
    if (descriptor && 'value' in descriptor && descriptor.value === original)
      Object.defineProperty(delegate, 'update', descriptor);
    else assert(Reflect.set(delegate, 'update', original));
    assert.equal(Reflect.get(delegate, 'update'), original);
    restored = true;
  };
}
