import {
  E4EngineRequestWaitDiagnostic,
  E4NativeRequestBoundaryDiagnostic,
} from './e4-engine-request-wait-diagnostic';

const barrier = {
  action: 'executeRaw',
  query: {
    arguments: {
      query:
        'SET CONSTRAINTS public.astr_parent_complete_guard,\n public.e4_revision_complete_guard IMMEDIATE',
    },
  },
};
function engine(request: (...args: unknown[]) => unknown = () => Promise.resolve('ok')) {
  return { request, requestBatch: request };
}
describe('E4 existing engine request wait observer', () => {
  it('preserves receiver, arguments, options and the original Promise', async () => {
    const promise = Promise.resolve('value');
    const fn = jest.fn(function (this: unknown, ...args: unknown[]) {
      expect(this).toBe(db);
      expect(args[0]).toBe(barrier);
      expect(args[1]).toBe(options);
      return promise;
    });
    const db = engine(fn),
      options = { transaction: 'synthetic' };
    let now = 10;
    const original = Object.getOwnPropertyDescriptor(db, 'request');
    const observer = new E4EngineRequestWaitDiagnostic(db, () => now);
    observer.begin();
    now = 15;
    const result = db.request(barrier, options);
    expect(result).toBe(promise);
    now = 25;
    await result;
    now = 30;
    observer.finish();
    observer.restore();
    expect(Object.getOwnPropertyDescriptor(db, 'request')).toEqual(original);
    expect(observer.snapshot()).toMatchObject({
      status: 'COMPLETE',
      bridgeCalls: 1,
      pending: 0,
      wallMs: 20,
      insideRequestMs: 10,
      outsideRequestMs: 10,
    });
    expect(observer.snapshot().categories.find((c) => c.category === 'BARRIER')).toEqual({
      category: 'BARRIER',
      calls: 1,
      pending: 0,
      ok: 1,
      failed: 0,
      wallMs: 10,
      firstStartedMs: 5,
      lastSettledMs: 15,
    });
  });
  it('preserves asynchronous rejection identity and measures the failed barrier', async () => {
    const error = new Error('synthetic');
    const original = Promise.reject(error);
    const db = engine(() => original),
      observer = new E4EngineRequestWaitDiagnostic(db);
    observer.begin();
    expect(db.request(barrier)).toBe(original);
    await expect(original).rejects.toBe(error);
    observer.finish();
    observer.restore();
    expect(observer.snapshot().categories.find((c) => c.category === 'BARRIER')).toMatchObject({
      failed: 1,
      pending: 0,
    });
  });
  it('preserves synchronous failure identity', () => {
    const error = new Error('synthetic'),
      db = engine(() => {
        throw error;
      });
    const observer = new E4EngineRequestWaitDiagnostic(db);
    observer.begin();
    expect(() => db.request(barrier)).toThrow(error);
    observer.finish();
    observer.restore();
    expect(observer.snapshot()).toMatchObject({ status: 'COMPLETE', pending: 0 });
  });
  it('uses request union time for overlap rather than summing inclusive intervals', async () => {
    let resolveA!: () => void, resolveB!: () => void;
    const a = new Promise<void>((resolve) => {
      resolveA = resolve;
    });
    const b = new Promise<void>((resolve) => {
      resolveB = resolve;
    });
    const fn = jest.fn().mockReturnValueOnce(a).mockReturnValueOnce(b);
    const db = engine(fn);
    let now = 0;
    const observer = new E4EngineRequestWaitDiagnostic(db, () => now);
    observer.begin();
    now = 2;
    db.request({ action: 'queryRaw' });
    now = 4;
    db.requestBatch([{ action: 'findUnique' }]);
    now = 6;
    resolveA();
    await a;
    now = 8;
    resolveB();
    await b;
    now = 10;
    observer.finish();
    observer.restore();
    expect(observer.snapshot()).toMatchObject({
      status: 'COMPLETE',
      insideRequestMs: 6,
      outsideRequestMs: 4,
    });
    expect(observer.snapshot().categories.find((c) => c.category === 'BATCH')).toMatchObject({
      calls: 1,
      wallMs: 4,
    });
  });
  it('does not touch parameter payloads or serialize results', async () => {
    const argumentsValue = {
      query: 'SELECT 1',
      get parameters() {
        throw new Error('must not read');
      },
    };
    const payload = {
      toJSON() {
        throw new Error('must not serialize');
      },
    };
    const db = engine(() => Promise.resolve(payload)),
      observer = new E4EngineRequestWaitDiagnostic(db);
    observer.begin();
    await db.request({ action: 'queryRaw', query: { arguments: argumentsValue } });
    observer.finish();
    observer.restore();
    expect(JSON.stringify(observer.snapshot())).not.toContain('SELECT');
    expect(observer.snapshot().status).toBe('COMPLETE');
  });
  it('recognizes only the exact existing two-guard barrier', async () => {
    const db = engine(),
      observer = new E4EngineRequestWaitDiagnostic(db);
    observer.begin();
    await db.request({
      action: 'executeRaw',
      query: { arguments: { query: 'SET CONSTRAINTS ALL IMMEDIATE' } },
    });
    await db.request(barrier);
    observer.finish();
    observer.restore();
    expect(observer.snapshot().categories.find((c) => c.category === 'BARRIER')?.calls).toBe(1);
    expect(observer.snapshot().categories.find((c) => c.category === 'WRITE')?.calls).toBe(1);
  });
  it('delegates inactive requests without recording them', async () => {
    const db = engine(),
      observer = new E4EngineRequestWaitDiagnostic(db);
    await db.request(barrier);
    observer.restore();
    expect(observer.snapshot().bridgeCalls).toBe(0);
  });
  it('marks unsettled work UNKNOWN without changing its promise', async () => {
    let done!: () => void;
    const promise = new Promise<void>((resolve) => {
      done = resolve;
    });
    const db = engine(() => promise),
      observer = new E4EngineRequestWaitDiagnostic(db);
    observer.begin();
    expect(db.request(barrier)).toBe(promise);
    observer.finish();
    observer.restore();
    expect(observer.snapshot()).toMatchObject({ status: 'UNKNOWN', pending: 1 });
    done();
    await promise;
  });
  it('marks a backwards clock UNKNOWN and preserves the original call', async () => {
    let now = 10;
    const db = engine(),
      observer = new E4EngineRequestWaitDiagnostic(db, () => now);
    observer.begin();
    now = 9;
    await db.request(barrier);
    observer.finish();
    observer.restore();
    expect(observer.snapshot().status).toBe('UNKNOWN');
  });
  it('does not install a partial wrapper when another bridge is unavailable', () => {
    const fn = () => Promise.resolve('ok');
    const db = { request: fn },
      observer = new E4EngineRequestWaitDiagnostic(db);
    expect(db.request).toBe(fn);
    expect(observer.snapshot().status).toBe('UNKNOWN');
  });
  it('caps recording at 400 and delegates every original request', async () => {
    const fn = jest.fn(() => Promise.resolve('ok')),
      db = engine(fn);
    const observer = new E4EngineRequestWaitDiagnostic(db);
    observer.begin();
    for (let i = 0; i < 401; i++) await db.request(barrier);
    observer.finish();
    observer.restore();
    expect(fn).toHaveBeenCalledTimes(401);
    expect(observer.snapshot().status).toBe('UNKNOWN');
    expect(observer.snapshot().categories.find((c) => c.category === 'BARRIER')?.calls).toBe(400);
  });
});

const evaluationRequest = {
  action: 'executeRaw',
  query: {
    arguments: {
      query:
        '\n INSERT INTO "ParticipantContributionEvaluation" (id) SELECT id FROM jsonb_to_recordset($1::jsonb) AS e(id text)',
      get parameters() {
        throw new Error('Parameter payload must not be inspected');
      },
    },
  },
};
function nativeFixture(
  query: (...args: unknown[]) => Promise<unknown> = () => Promise.resolve(undefined),
) {
  const native = { query };
  return {
    name: 'LibraryEngine',
    engine: native,
    request: (...args: unknown[]) => native.query(...args),
    requestBatch: (...args: unknown[]) => native.query(...args),
  };
}
describe('E4 explicit native request boundary observer', () => {
  it('separates encoding before native entry from native promise time and preserves all identities', async () => {
    let now = 100;
    let done!: (value: unknown) => void;
    const payload = {
      toJSON() {
        throw new Error('Result must not be serialized');
      },
    };
    const nativeArgument = {
      toJSON() {
        throw new Error('Native body must not be serialized');
      },
    };
    const options = Object.freeze({ opaque: Symbol('native option') });
    const promise = new Promise<unknown>((resolve) => {
      done = resolve;
    });
    const db = nativeFixture(function (this: unknown, ...args) {
      expect(this).toBe(db.engine);
      expect(args).toEqual([nativeArgument, options]);
      return promise;
    });
    db.request = function (this: unknown, ...args) {
      expect(this).toBe(db);
      expect(args).toEqual([evaluationRequest, options]);
      now = 120;
      return db.engine.query(nativeArgument, options);
    };
    const outerDescriptor = Object.getOwnPropertyDescriptor(db, 'request');
    const nativeDescriptor = Object.getOwnPropertyDescriptor(db.engine, 'query');
    const observer = new E4NativeRequestBoundaryDiagnostic(db, () => now);
    observer.begin(100);
    expect(db.request(evaluationRequest, options)).toBe(promise);
    now = 150;
    done(payload);
    await promise;
    observer.queryEvent('BEGIN', 1);
    observer.queryEvent('ROLLBACK', 12_087);
    observer.finish();
    observer.restore();
    expect(observer.snapshot()).toMatchObject({
      status: 'COMPLETE',
      selectedCalls: 1,
      nativeCalls: 1,
      trace: [
        { edge: 'OUTER_ENTER', atMs: 0 },
        { edge: 'NATIVE_ENTER', atMs: 20 },
        { edge: 'NATIVE_OK', atMs: 50 },
        { edge: 'OUTER_OK', atMs: 50 },
      ],
    });
    expect(observer.snapshot().events.find((row) => row.event === 'ROLLBACK')).toMatchObject({
      calls: 1,
      durationMs: 12_087,
      firstReceivedMs: 50,
      lastReceivedMs: 50,
    });
    expect(observer.snapshot().events.find((row) => row.event === 'EVAL_INSERT')?.calls).toBe(0);
    expect(Object.getOwnPropertyDescriptor(db, 'request')).toEqual(outerDescriptor);
    expect(Object.getOwnPropertyDescriptor(db.engine, 'query')).toEqual(nativeDescriptor);
    expect(JSON.stringify(observer.snapshot())).not.toMatch(
      /ParticipantContributionEvaluation|Parameter|Native body|Result/,
    );
    expect(Buffer.byteLength(JSON.stringify(observer.snapshot()))).toBeLessThanOrEqual(4096);
  });

  it('records a native rejection even without a completed SQL event and preserves the same error', async () => {
    const error = new Error('opaque original failure');
    const promise = Promise.reject(error);
    const db = nativeFixture(() => promise);
    const observer = new E4NativeRequestBoundaryDiagnostic(db);
    observer.begin(0);
    expect(db.request(evaluationRequest)).toBe(promise);
    await expect(promise).rejects.toBe(error);
    observer.finish();
    observer.restore();
    expect(observer.snapshot()).toMatchObject({
      status: 'COMPLETE',
      pendingNative: 0,
      trace: [
        { edge: 'OUTER_ENTER' },
        { edge: 'NATIVE_ENTER' },
        { edge: 'NATIVE_ERROR' },
        { edge: 'OUTER_ERROR' },
      ],
    });
    expect(observer.snapshot().events.find((row) => row.event === 'EVAL_INSERT')?.calls).toBe(0);
    expect(JSON.stringify(observer.snapshot())).not.toContain(error.message);
  });

  it('preserves a synchronous native failure', () => {
    const error = new Error('opaque synchronous failure');
    const db = nativeFixture(() => {
      throw error;
    });
    const observer = new E4NativeRequestBoundaryDiagnostic(db);
    observer.begin(0);
    expect(() => db.request(evaluationRequest)).toThrow(error);
    observer.finish();
    observer.restore();
    expect(observer.snapshot()).toMatchObject({
      status: 'COMPLETE',
      pendingOuter: 0,
      pendingNative: 0,
    });
  });

  it('keeps native fulfillment distinct from an outer rejected error envelope', async () => {
    const error = new Error('opaque outer error');
    const response = {
      toJSON() {
        throw new Error('Do not decode native response');
      },
    };
    const db = nativeFixture(() => Promise.resolve(response));
    let outer: Promise<unknown> | undefined;
    db.request = (...args) => {
      outer = db.engine.query(...args).then(() => {
        throw error;
      });
      return outer;
    };
    const observer = new E4NativeRequestBoundaryDiagnostic(db);
    observer.begin(0);
    const returned = db.request(evaluationRequest);
    expect(returned).toBe(outer);
    await expect(returned).rejects.toBe(error);
    observer.finish();
    observer.restore();
    expect(observer.snapshot()).toMatchObject({
      status: 'COMPLETE',
      trace: [
        { edge: 'OUTER_ENTER' },
        { edge: 'NATIVE_ENTER' },
        { edge: 'NATIVE_OK' },
        { edge: 'OUTER_ERROR' },
      ],
    });
    expect(observer.snapshot().events.find((row) => row.event === 'EVAL_INSERT')?.calls).toBe(0);
  });

  it('coexists with the existing outer wait observer and restores wrappers in reverse order', async () => {
    const db = nativeFixture();
    const descriptor = Object.getOwnPropertyDescriptor(db, 'request');
    const existing = new E4EngineRequestWaitDiagnostic(db);
    const boundary = new E4NativeRequestBoundaryDiagnostic(db);
    existing.begin();
    boundary.begin(0);
    await db.request(evaluationRequest);
    boundary.finish();
    boundary.restore();
    existing.finish();
    existing.restore();
    expect(boundary.snapshot().status).toBe('COMPLETE');
    expect(existing.snapshot()).toMatchObject({ status: 'COMPLETE', bridgeCalls: 1 });
    expect(existing.snapshot().categories.find((row) => row.category === 'WRITE')?.calls).toBe(1);
    expect(Object.getOwnPropertyDescriptor(db, 'request')).toEqual(descriptor);
  });

  it('does not install partial wrappers when the initialized native bridge is missing or protected', () => {
    const request = jest.fn(() => Promise.resolve(undefined));
    const db = { name: 'LibraryEngine', request, requestBatch: request };
    const observer = new E4NativeRequestBoundaryDiagnostic(db);
    expect(db.request).toBe(request);
    expect(observer.snapshot().status).toBe('UNKNOWN');
    const protectedDb = nativeFixture();
    const original = protectedDb.request;
    Object.defineProperty(protectedDb.engine, 'query', { configurable: false });
    const protectedObserver = new E4NativeRequestBoundaryDiagnostic(protectedDb);
    expect(protectedDb.request).toBe(original);
    expect(protectedObserver.snapshot().status).toBe('UNKNOWN');
  });

  it('rejects ambiguous pending ownership instead of pairing native calls by order', async () => {
    let done!: () => void;
    const promise = new Promise<void>((resolve) => {
      done = resolve;
    });
    const native = jest.fn(() => Promise.resolve(undefined));
    const db = nativeFixture(native);
    db.request = () => promise;
    const observer = new E4NativeRequestBoundaryDiagnostic(db);
    observer.begin(0);
    expect(db.request(evaluationRequest)).toBe(promise);
    expect(db.request({ action: 'findUnique' })).toBe(promise);
    await db.engine.query(Symbol('opaque native input'));
    done();
    await promise;
    observer.finish();
    observer.restore();
    expect(native).toHaveBeenCalledTimes(1);
    expect(observer.snapshot()).toMatchObject({ status: 'UNKNOWN', nativeCalls: 0 });
  });

  it('marks a selected outer request with no native invocation UNKNOWN', async () => {
    const db = nativeFixture();
    db.request = () => Promise.resolve(undefined);
    const observer = new E4NativeRequestBoundaryDiagnostic(db);
    observer.begin(0);
    await db.request(evaluationRequest);
    observer.finish();
    observer.restore();
    expect(observer.snapshot()).toMatchObject({
      status: 'UNKNOWN',
      selectedCalls: 1,
      nativeCalls: 0,
    });
  });

  it('classifies named control events separately and does not match a copy INSERT or SQL in parameters', async () => {
    const db = nativeFixture();
    const observer = new E4NativeRequestBoundaryDiagnostic(db);
    observer.begin(0);
    await db.request(evaluationRequest);
    observer.queryEvent('BEGIN;', 1);
    observer.queryEvent('SET TRANSACTION ISOLATION LEVEL READ COMMITTED', 2);
    observer.queryEvent('COMMIT', 3);
    observer.queryEvent(evaluationRequest.query.arguments.query, 4);
    observer.queryEvent(
      'INSERT INTO "ParticipantContributionEvaluation" (id) SELECT id FROM copied',
      5,
    );
    observer.queryEvent('SELECT 1', 6);
    observer.finish();
    observer.restore();
    expect(observer.snapshot().status).toBe('COMPLETE');
    expect(observer.snapshot().events.find((row) => row.event === 'SET_TRANSACTION')).toMatchObject(
      { calls: 1, durationMs: 2 },
    );
    expect(observer.snapshot().events.find((row) => row.event === 'EVAL_INSERT')).toMatchObject({
      calls: 1,
      durationMs: 4,
    });
    expect(observer.snapshot().events.find((row) => row.event === 'OTHER')).toMatchObject({
      calls: 2,
      durationMs: 11,
    });
    expect(JSON.stringify(observer.snapshot())).not.toContain('copied');
  });

  it('marks an invalid clock UNKNOWN without changing the request result', async () => {
    let now = 10;
    const promise = Promise.resolve('value');
    const db = nativeFixture(() => promise);
    const observer = new E4NativeRequestBoundaryDiagnostic(db, () => now);
    observer.begin(10);
    now = 9;
    expect(db.request(evaluationRequest)).toBe(promise);
    await promise;
    observer.finish();
    observer.restore();
    expect(observer.snapshot().status).toBe('UNKNOWN');
    expect(observer.snapshot().trace.every((row) => row.atMs === null)).toBe(true);
  });

  it('caps trace and event storage while every original call still runs', async () => {
    const native = jest.fn(() => Promise.resolve(undefined));
    const db = nativeFixture(native);
    db.request = (...args) => {
      for (let i = 0; i < 5; i++) void db.engine.query(...args);
      return Promise.resolve(undefined);
    };
    const observer = new E4NativeRequestBoundaryDiagnostic(db);
    observer.begin(0);
    await db.request(evaluationRequest);
    for (let i = 0; i < 401; i++) observer.queryEvent('BEGIN', 1);
    observer.finish();
    observer.restore();
    expect(native).toHaveBeenCalledTimes(5);
    expect(observer.snapshot().status).toBe('UNKNOWN');
    expect(observer.snapshot().trace.length).toBeLessThanOrEqual(8);
    expect(observer.snapshot().events.find((row) => row.event === 'BEGIN')?.calls).toBe(400);
    expect(Buffer.byteLength(JSON.stringify(observer.snapshot()))).toBeLessThanOrEqual(4096);
  });

  it('does not overwrite a native wrapper installed by another owner', () => {
    const db = nativeFixture();
    const observer = new E4NativeRequestBoundaryDiagnostic(db);
    const replacement = () => Promise.resolve(undefined);
    db.engine.query = replacement;
    observer.restore();
    expect(db.engine.query).toBe(replacement);
    expect(observer.snapshot().status).toBe('UNKNOWN');
  });
});
