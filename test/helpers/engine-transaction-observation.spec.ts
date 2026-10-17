import { observeTestEngineTransactions } from './engine-transaction-observation';

describe('actual test engine transaction bridge observation', () => {
  it('preserves the original promise, receiver, arguments and descriptor', async () => {
    const promise = Promise.resolve('started'),
      options = { timeout: 30000 };
    const fn = jest.fn(function (this: unknown, ...args: unknown[]) {
      expect(this).toBe(engine);
      expect(args).toEqual(['start', options]);
      return promise;
    });
    const engine = { transaction: fn };
    let now = 10;
    const descriptor = Object.getOwnPropertyDescriptor(engine, 'transaction');
    const observation = observeTestEngineTransactions(engine, () => now);
    expect(engine.transaction('start', options)).toBe(promise);
    now = 15;
    await promise;
    observation.restore();
    expect(Object.getOwnPropertyDescriptor(engine, 'transaction')).toEqual(descriptor);
    expect(observation.snapshot()).toEqual({
      status: 'COMPLETE',
      pending: 0,
      phases: [{ phase: 'start', elapsedMs: 5, outcome: 'ok' }],
    });
  });
  it('records failed COMMIT while preserving its rejection identity', async () => {
    const error = new Error('synthetic'),
      promise = Promise.reject(error);
    const engine = {
      transaction: (...args: unknown[]) => {
        expect(args).toEqual(['commit']);
        return promise;
      },
    };
    const observation = observeTestEngineTransactions(engine);
    expect(engine.transaction('commit')).toBe(promise);
    await expect(promise).rejects.toBe(error);
    observation.restore();
    expect(observation.snapshot()).toMatchObject({
      status: 'COMPLETE',
      pending: 0,
      phases: [{ phase: 'commit', outcome: 'error' }],
    });
  });
  it('preserves synchronous failure and does not let an unavailable clock change the result', () => {
    const error = new Error('synthetic');
    const engine = {
      transaction: (...args: unknown[]) => {
        expect(args).toEqual(['rollback']);
        throw error;
      },
    };
    const observation = observeTestEngineTransactions(engine, () => {
      throw new Error('clock');
    });
    expect(() => engine.transaction('rollback')).toThrow(error);
    observation.restore();
    expect(observation.snapshot()).toMatchObject({ status: 'UNKNOWN', pending: 0 });
  });
  it('marks an unsettled transaction UNKNOWN and leaves the original promise intact', async () => {
    let finish!: () => void;
    const promise = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const engine = {
      transaction: (...args: unknown[]) => {
        expect(args).toEqual(['commit']);
        return promise;
      },
    };
    const observation = observeTestEngineTransactions(engine);
    expect(engine.transaction('commit')).toBe(promise);
    expect(observation.snapshot()).toMatchObject({ status: 'UNKNOWN', pending: 1 });
    finish();
    await promise;
    observation.restore();
    expect(observation.snapshot().pending).toBe(0);
  });
});
