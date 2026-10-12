import { E4EngineRequestWaitDiagnostic } from './e4-engine-request-wait-diagnostic';

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
