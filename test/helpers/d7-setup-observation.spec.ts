import {
  D7SetupObservation,
  observeD7Setup,
  observeD7Receipt,
  preserveD7Prepare,
  safeD7Diagnostic,
  type D7SetupBatch,
} from './d7-setup-observation';

function recorder() {
  let tick = 10;
  return new D7SetupObservation(
    () => ++tick,
    () => ({ usedBytes: 64, limitBytes: 1024 }),
    () => ({ timeOriginUnixMs: 1000, beforeMs: 0, utcMs: 1000, afterMs: 0, uptimeMs: 0 }),
  );
}
const metadata: D7SetupBatch = {
  family: 'committedAllocations',
  offset: 5000,
  total: 9999,
  parents: 100,
  slices: 500,
  evidence: 0,
  receipts: 100,
};

describe('whole D7 setup diagnostic preserves business execution', () => {
  it('disabled observation preserves the original Promise and synchronous error', () => {
    const value = Promise.resolve({ count: 100 });
    expect(observeD7Setup(undefined, 'base', null, () => value)).toBe(value);
    const failure = new Error('original failure');
    expect(() =>
      observeD7Setup(undefined, 'base', null, () => {
        throw failure;
      }),
    ).toThrow(failure);
  });

  it('records nested stages with immediate single execution and preserves result identity', async () => {
    const trace = recorder();
    const result = { count: 100 };
    const order: string[] = [];
    const observed = observeD7Setup(trace, 'base', null, () => {
      order.push('base');
      return observeD7Setup(trace, 'capacity', null, () => {
        order.push('capacity');
        return Promise.resolve(result);
      });
    });
    expect(order).toEqual(['base', 'capacity']);
    expect(await observed).toBe(result);
    trace.stop();
    expect(trace.report()).toMatchObject({
      status: 'KNOWN',
      cpuEvidence: 'NOT_COLLECTED',
      openSpans: 0,
    });
    expect(trace.report().spans.map((s) => [s.label, s.parent, s.outcome])).toEqual([
      ['base', null, 'RETURNED'],
      ['capacity', 1, 'RETURNED'],
    ]);
  });

  it('retains the transaction options, tx object and original createMany argument objects', async () => {
    const trace = recorder();
    const options = { timeout: 30000 };
    const parents = { data: [{ sliceCount: 5 }] };
    const slices = { data: [{ ordinal: 0 }] };
    const received: unknown[] = [];
    const tx = {
      parent: {
        createMany: (args: typeof parents) => {
          received.push(args);
          return Promise.resolve({ count: 1 });
        },
      },
      slice: {
        createMany: (args: typeof slices) => {
          received.push(args);
          return Promise.resolve({ count: 1 });
        },
      },
    };
    const transaction = (body: (value: typeof tx) => PromiseLike<void>, opts: typeof options) => {
      expect(opts).toBe(options);
      return body(tx);
    };
    await observeD7Setup(trace, 'batchTransaction', metadata, () =>
      transaction(
        (value) =>
          observeD7Setup(trace, 'batchCallback', metadata, async () => {
            expect(value).toBe(tx);
            await observeD7Setup(trace, 'batchParents', metadata, () =>
              value.parent.createMany(parents),
            );
            await observeD7Setup(trace, 'batchSlices', metadata, () =>
              value.slice.createMany(slices),
            );
          }),
        options,
      ),
    );
    expect(received).toEqual([parents, slices]);
    expect(received[0]).toBe(parents);
    expect(received[1]).toBe(slices);
    trace.stop();
    expect(trace.report().status).toBe('KNOWN');
  });

  it('preserves a failed Slice error and does not fabricate subsequent receipt calls', async () => {
    const trace = recorder();
    const failure = new Error('private business error');
    const receipt = jest.fn(() => Promise.resolve(1));
    await expect(
      observeD7Setup(trace, 'batchTransaction', metadata, () =>
        observeD7Setup(trace, 'batchCallback', metadata, async () => {
          await observeD7Setup(trace, 'batchParents', metadata, () => Promise.resolve(100));
          await observeD7Setup(trace, 'batchSlices', metadata, () => Promise.reject(failure));
          await observeD7Setup(trace, 'batchReceipt', metadata, receipt);
        }),
      ),
    ).rejects.toBe(failure);
    trace.stop();
    expect(receipt).not.toHaveBeenCalled();
    expect(trace.report().completedToTarget).toBe(false);
    expect(
      trace
        .report()
        .spans.filter((s) => s.outcome === 'THREW')
        .map((s) => s.label),
    ).toEqual(['batchTransaction', 'batchCallback', 'batchSlices']);
    expect(JSON.stringify(trace.report())).not.toContain('private business error');
  });

  it('keeps original work when the monotonic sampler throws', async () => {
    const trace = new D7SetupObservation(() => {
      throw new Error('clock');
    });
    const result = { count: 1 };
    expect(await observeD7Setup(trace, 'base', null, () => Promise.resolve(result))).toBe(result);
    trace.stop();
    expect(trace.report().status).toBe('UNKNOWN');
    expect(trace.report().spans[0]).toMatchObject({
      enteredMs: null,
      settledMs: null,
      outcome: 'RETURNED',
    });
  });

  it('keeps a business rejection when heap sampling and output both fail', async () => {
    let tick = 0;
    const trace = new D7SetupObservation(
      () => ++tick,
      () => {
        throw new Error('heap sample');
      },
    );
    const failure = new Error('original');
    async function run() {
      try {
        return await observeD7Setup(trace, 'base', null, () => Promise.reject(failure));
      } finally {
        trace.emit(() => {
          throw new Error('output');
        });
      }
    }
    await expect(run()).rejects.toBe(failure);
    expect(trace.report().status).toBe('UNKNOWN');
  });

  it('does not store extra metadata even when work succeeds', async () => {
    const trace = recorder();
    const extra = Object.assign({}, metadata, { sql: 'private SQL' });
    expect(await observeD7Setup(trace, 'batchParents', extra, () => Promise.resolve(2))).toBe(2);
    trace.stop();
    expect(trace.report().status).toBe('UNKNOWN');
    expect(JSON.stringify(trace.report())).not.toContain('private SQL');
  });

  it('rejects regressed clocks without replacing results', async () => {
    let tick = 20;
    const trace = new D7SetupObservation(() => --tick);
    expect(await observeD7Setup(trace, 'base', null, () => Promise.resolve(4))).toBe(4);
    trace.stop();
    expect(trace.report().status).toBe('UNKNOWN');
  });

  it('stopping before an open span settles is UNKNOWN', async () => {
    const trace = recorder();
    let release: (value: number) => void = () => undefined;
    const pending = new Promise<number>((resolve) => {
      release = resolve;
    });
    const result = observeD7Setup(trace, 'base', null, () => pending);
    trace.stop();
    release(3);
    expect(await result).toBe(3);
    expect(trace.report().status).toBe('UNKNOWN');
  });

  it('stopped recording adds no observations to the target transaction', async () => {
    const trace = recorder();
    await observeD7Setup(trace, 'base', null, () => Promise.resolve(1));
    trace.complete();
    const target = Promise.resolve(2);
    expect(observeD7Setup(trace, 'humanPrepare', null, () => target)).toBe(target);
    expect(trace.report().spans).toHaveLength(1);
    expect(trace.report().completedToTarget).toBe(true);
  });

  it('an incomplete open setup cannot claim the target boundary', async () => {
    const trace = recorder();
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observed = observeD7Setup(trace, 'base', null, () => pending);
    trace.complete();
    release();
    await observed;
    expect(trace.report()).toMatchObject({ status: 'UNKNOWN', completedToTarget: false });
  });

  it('bounds retained spans and makes dropped records UNKNOWN', async () => {
    const trace = recorder();
    for (let i = 0; i < 4097; i++)
      await observeD7Setup(trace, 'batchParents', metadata, () => Promise.resolve(i));
    trace.stop();
    expect(trace.report()).toMatchObject({ status: 'UNKNOWN', dropped: 1, openSpans: 0 });
    expect(trace.report().spans).toHaveLength(4096);
    expect(Buffer.byteLength(JSON.stringify(trace.report()))).toBeLessThan(4 * 1024 * 1024);
  });

  it('copies report metadata and calibration without sharing mutable evidence', async () => {
    const trace = recorder();
    await observeD7Setup(trace, 'batchParents', metadata, () => Promise.resolve(1));
    trace.stop();
    const first = trace.report();
    first.spans.length = 0;
    if (first.calibration) first.calibration.utcMs = 0;
    expect(trace.report().spans).toHaveLength(1);
    expect(trace.report().calibration?.utcMs).toBe(1000);
    expect(trace.report().receiptSqlPlanEvidence).toBe('UNKNOWN_HISTORICAL_121_138_REFERENCE');
  });
});

describe('legacy observation failures preserve original business calls', () => {
  it('calls the original receipt exactly once even when observation and reporting both throw', async () => {
    const value = { revision: 1 };
    const original = jest.fn(() => Promise.resolve(value));
    const fault = jest.fn();
    expect(
      await observeD7Receipt(
        original,
        () => Promise.reject(new Error('observer')),
        () => {
          throw new Error('report');
        },
        fault,
      ),
    ).toBe(value);
    expect(original).toHaveBeenCalledTimes(1);
    expect(fault).toHaveBeenCalled();
  });

  it('preserves the original receipt rejection even when reporting throws', async () => {
    const failure = new Error('receipt failure');
    await expect(
      observeD7Receipt(
        () => Promise.reject(failure),
        () => Promise.reject(new Error('observer')),
        () => {
          throw new Error('report');
        },
      ),
    ).rejects.toBe(failure);
  });

  it('keeps a successful prepare value and does not run a rollback probe', async () => {
    const value = { revision: 1 };
    const eligible = jest.fn(() => Promise.resolve(true));
    const probe = jest.fn(() => Promise.resolve());
    expect(
      await preserveD7Prepare(
        () => Promise.resolve(value),
        eligible,
        probe,
        () => undefined,
      ),
    ).toBe(value);
    expect(eligible).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it('retains the prepare error if eligibility and reporting both fail', async () => {
    const failure = new Error('prepare failure');
    const probe = jest.fn(() => Promise.resolve());
    await expect(
      preserveD7Prepare(
        () => Promise.reject(failure),
        () => Promise.reject(new Error('eligibility')),
        probe,
        () => {
          throw new Error('report');
        },
      ),
    ).rejects.toBe(failure);
    expect(probe).not.toHaveBeenCalled();
  });

  it('retains the prepare error if an eligible rollback probe and reporting fail', async () => {
    const failure = new Error('prepare failure');
    const probe = jest.fn(() => Promise.reject(new Error('probe')));
    await expect(
      preserveD7Prepare(
        () => Promise.reject(failure),
        () => Promise.resolve(true),
        probe,
        () => {
          throw new Error('report');
        },
      ),
    ).rejects.toBe(failure);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('isolates serialization and console failures, including a failing fault reporter', () => {
    const value: { self?: unknown } = {};
    value.self = value;
    expect(
      safeD7Diagnostic(
        () => JSON.stringify(value),
        () => {
          throw new Error('fault');
        },
      ),
    ).toBe(false);
    expect(
      safeD7Diagnostic(() => {
        throw new Error('console');
      }),
    ).toBe(false);
    expect(safeD7Diagnostic(() => 1)).toBe(true);
  });
});
