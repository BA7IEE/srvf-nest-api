import {
  D7FixtureTiming,
  observeD7FixtureAsync,
  observeD7FixtureSync,
  type D7FixturePhase,
  type D7FixturePoint,
} from './d7-fixture-timing';

function recorder(offset = 0, people = 100) {
  let tick = 100;
  const capture = (): D7FixturePoint => {
    const n = ++tick;
    return {
      monoBeforeMs: n,
      monoAfterMs: n + 0.1,
      mainUserUs: n,
      mainSystemUs: n,
      processUserUs: n,
      processSystemUs: n,
      loopActiveMs: n,
      loopIdleMs: n,
    };
  };
  return new D7FixtureTiming(offset, people, capture);
}
const phases = ['member', 'registration', 'identity', 'punch', 'segment'] as const;
const argsPhases = ['memberArgs', 'registrationArgs', 'identityArgs'] as const;

async function batch(
  timing: D7FixtureTiming,
  failAt?: D7FixturePhase,
  failure = new Error('control'),
) {
  const order: string[] = [];
  const result = await observeD7FixtureAsync(timing, 'transaction', () =>
    observeD7FixtureAsync(timing, 'callback', async () => {
      for (const [index, phase] of phases.entries()) {
        await observeD7FixtureAsync(timing, phase, () => {
          if (index < 3)
            observeD7FixtureSync(timing, argsPhases[index], () => {
              order.push(phase + ':args');
              if (failAt === argsPhases[index]) throw failure;
              return { date: new Date('2020-01-01'), optional: undefined };
            });
          order.push(phase + ':dispatch');
          if (failAt === phase) return Promise.reject(failure);
          return Promise.resolve({ count: index + 1 });
        });
      }
      return order;
    }),
  );
  return { result, order };
}

describe('D7 fixture timing preserves the original call chain', () => {
  it('records arguments before dispatch, all five calls in order and settled callback/transaction', async () => {
    const timing = recorder();
    const { result, order } = await batch(timing);
    expect(result).toBe(order);
    expect(order).toEqual([
      'member:args',
      'member:dispatch',
      'registration:args',
      'registration:dispatch',
      'identity:args',
      'identity:dispatch',
      'punch:dispatch',
      'segment:dispatch',
    ]);
    const report = timing.report();
    expect(report.status).toBe('KNOWN');
    expect(report.boundaries).toHaveLength(20);
    expect(report.boundaries.at(-1)).toMatchObject({ phase: 'transaction', edge: 'RETURNED' });
    expect(report.cpuValidity).toBe('UNVALIDATED');
    expect(report.batch).toEqual({
      offset: 0,
      ordinal: 1,
      people: 100,
      last: false,
      maximumBatches: 20,
    });
  });

  it('preserves the rejected Identity error and legal prefix without entering Punch/Segment', async () => {
    const timing = recorder();
    const failure = new Error('opaque sentinel');
    await expect(batch(timing, 'identity', failure)).rejects.toBe(failure);
    const report = timing.report();
    expect(report.status).toBe('KNOWN');
    expect(report.boundaries.filter((b) => b.edge === 'THREW').map((b) => b.phase)).toEqual([
      'identity',
      'callback',
      'transaction',
    ]);
    expect(report.boundaries.some((b) => b.phase === 'punch' || b.phase === 'segment')).toBe(false);
    expect(JSON.stringify(report)).not.toContain('opaque sentinel');
  });

  it('preserves synchronous map errors and propagates through the same call/callback/transaction', async () => {
    const timing = recorder();
    const failure = new Error('map failure');
    await expect(batch(timing, 'registrationArgs', failure)).rejects.toBe(failure);
    expect(timing.report().status).toBe('KNOWN');
    expect(
      timing
        .report()
        .boundaries.filter((b) => b.edge === 'THREW')
        .map((b) => b.phase),
    ).toEqual(['registrationArgs', 'registration', 'callback', 'transaction']);
    expect(timing.report().boundaries.some((b) => b.phase === 'identity')).toBe(false);
  });

  it('keeps a transaction start rejection distinguishable from entering its callback', async () => {
    const timing = recorder();
    const failure = new Error('begin rejected');
    await expect(
      observeD7FixtureAsync(timing, 'transaction', () => Promise.reject(failure)),
    ).rejects.toBe(failure);
    expect(timing.report().boundaries.map((b) => [b.phase, b.edge])).toEqual([
      ['transaction', 'ENTERED'],
      ['transaction', 'THREW'],
    ]);
    expect(timing.report().status).toBe('KNOWN');
  });

  it('keeps failure after callback return distinct from a callback throw', async () => {
    const timing = recorder();
    const failure = new Error('settlement rejected');
    await expect(
      observeD7FixtureAsync(timing, 'transaction', async () => {
        await observeD7FixtureAsync(timing, 'callback', () => Promise.resolve(1));
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(timing.report().boundaries.map((b) => [b.phase, b.edge])).toEqual([
      ['transaction', 'ENTERED'],
      ['callback', 'ENTERED'],
      ['callback', 'RETURNED'],
      ['transaction', 'THREW'],
    ]);
    expect(timing.report().status).toBe('KNOWN');
  });

  it('does not replace a business failure when the output sink throws', async () => {
    const timing = recorder();
    const failure = new Error('business failure');
    async function run() {
      try {
        return await batch(timing, 'member', failure);
      } finally {
        timing.emit(() => {
          throw new Error('output failed');
        });
      }
    }
    await expect(run()).rejects.toBe(failure);
    expect(timing.report().status).toBe('UNKNOWN');
  });

  it('preserves the original Promise, object, Date and throw identity when recording is disabled', async () => {
    const value = { date: new Date('2020-01-01') };
    const promise = Promise.resolve(value);
    expect(observeD7FixtureAsync(undefined, 'member', () => promise)).toBe(promise);
    expect(observeD7FixtureSync(undefined, 'memberArgs', () => value)).toBe(value);
    const failure = new Error('sync original');
    expect(() =>
      observeD7FixtureSync(undefined, 'memberArgs', () => {
        throw failure;
      }),
    ).toThrow(failure);
    await expect(promise).resolves.toBe(value);
  });

  it('never masks work when every point capture throws', async () => {
    const timing = new D7FixtureTiming(0, 100, () => {
      throw new Error('sampler');
    });
    expect(await observeD7FixtureAsync(timing, 'transaction', () => Promise.resolve(4))).toBe(4);
    expect(timing.report()).toMatchObject({ status: 'UNKNOWN', faults: 2, openPhases: 0 });
    expect(timing.report().boundaries.every((b) => b.point === null)).toBe(true);
  });

  it('marks a phase without a terminal edge UNKNOWN rather than treating it as a failed prefix', () => {
    const timing = recorder();
    timing.boundary('transaction', 'ENTERED');
    expect(timing.report()).toMatchObject({ status: 'UNKNOWN', openPhases: 1 });
  });

  it('marks out of order edges UNKNOWN', () => {
    const timing = recorder();
    timing.boundary('transaction', 'ENTERED');
    timing.boundary('callback', 'RETURNED');
    expect(timing.report().status).toBe('UNKNOWN');
  });

  it('caps stored boundaries and exposes dropped measurements', () => {
    const timing = recorder();
    for (let i = 0; i < 20; i++) observeD7FixtureSync(timing, 'memberArgs', () => i);
    expect(timing.report()).toMatchObject({
      status: 'UNKNOWN',
      droppedBoundaries: 8,
      openPhases: 0,
    });
    expect(timing.report().boundaries).toHaveLength(32);
    expect(JSON.stringify(timing.report()).length).toBeLessThan(16384);
  });

  it('labels the actual final99-person batch without modifying its inputs', async () => {
    const timing = recorder(1900, 99);
    await batch(timing);
    expect(timing.report()).toMatchObject({
      status: 'KNOWN',
      batch: { offset: 1900, ordinal: 20, people: 99, last: true },
    });
    const invalid = recorder(1900, 100);
    expect(invalid.report().status).toBe('UNKNOWN');
  });

  it('returns independent evidence copies', async () => {
    const timing = recorder();
    await batch(timing);
    const report = timing.report();
    report.boundaries.length = 0;
    report.batch.people = 0;
    expect(timing.report().boundaries).toHaveLength(20);
    expect(timing.report().batch.people).toBe(100);
  });
});
