import {
  D7CommitTiming,
  d7ObservedMethod,
  d7StatementKind,
  observeD7Span,
} from './d7-commit-timing';

const point = () => ({
  monoMs: 100,
  mainUserUs: 10,
  mainSystemUs: 2,
  processUserUs: 20,
  processSystemUs: 3,
  loopActiveMs: 5,
  loopIdleMs: 2,
});
const clock = () => ({ monoMs: 100, mainUserUs: 10, mainSystemUs: 2 });
const recorder = () => new D7CommitTiming(point, clock);

describe('D7 bounded timing controls without database operations', () => {
  it.each([
    ['INSERT INTO "CorrectionTimeAllocationBinding" VALUES ($1)', 'binding_insert'],
    ['INSERT INTO "public"."ParticipantTimeAllocationRevision" VALUES ($1)', 'allocation_insert'],
    ['INSERT INTO "ParticipantTimeAllocationSlice" VALUES ($1)', 'slice_insert'],
    [
      'INSERT INTO "ParticipantTimeAllocationCommandReceipt" VALUES ($1)',
      'allocation_receipt_insert',
    ],
    ['SELECT * FROM "CorrectionTimeSourceProof"', 'source_proof_read'],
    [
      'WITH unreversed_facts AS (SELECT * FROM "ParticipationLedgerEntry") SELECT 1',
      'ledger_shape_facts',
    ],
    ['SELECT * FROM "ParticipationLedgerEntry" GROUP BY "memberId"', 'ledger_day_deltas'],
    ['ROLLBACK', 'transaction_control'],
    ['SELECT private_value', 'other'],
  ])('retains only a fixed subtype %#', (sql, kind) => {
    expect(d7StatementKind(sql)).toBe(kind);
  });

  it('preserves this, argument references, invocation count and exact result', async () => {
    const r = recorder();
    const host = { marker: 17 };
    const arg = { marker: 19 };
    const value = { marker: 23 };
    const original = jest.fn(function (this: typeof host, received: typeof arg) {
      expect(this).toBe(host);
      expect(received).toBe(arg);
      return Promise.resolve(value);
    });
    const wrapped = d7ObservedMethod(r, 'readBatchDayDeltas', original);
    await expect(wrapped.call(host, arg)).resolves.toBe(value);
    expect(original).toHaveBeenCalledTimes(1);
    expect(r.report()).toMatchObject({ status: 'KNOWN', openPhases: 0 });
    expect(r.report().boundaries.map((b) => b.edge)).toEqual(['ENTERED', 'RETURNED']);
  });

  it.each(['return', 'sync_throw', 'reject'] as const)(
    'installs a spy on a real method while preserving %s and restoring the original',
    async (mode) => {
      const r = recorder();
      const argument = { marker: 31 };
      const result = { marker: 37 };
      const failure = new Error('original method failure');
      const calls = jest.fn();
      function original(this: object, arg: object): Promise<object> {
        calls();
        expect(this).toBe(host);
        expect(arg).toBe(argument);
        if (mode === 'sync_throw') throw failure;
        if (mode === 'reject') return Promise.reject(failure);
        return Promise.resolve(result);
      }
      const host = { readBatchDayDeltas: original };
      const saved = host.readBatchDayDeltas;
      const replacement = d7ObservedMethod(r, 'readBatchDayDeltas', saved);
      const spy = jest.spyOn(host, 'readBatchDayDeltas').mockImplementation(replacement);
      try {
        const promise = host.readBatchDayDeltas(argument);
        if (mode === 'return') await expect(promise).resolves.toBe(result);
        else await expect(promise).rejects.toBe(failure);
        expect(calls).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
      expect(host.readBatchDayDeltas).toBe(original);
      expect(r.report().status).toBe('KNOWN');
    },
  );

  it.each(['sync', 'async'] as const)(
    'preserves the original %s rejection object',
    async (mode) => {
      const r = recorder();
      const failure = new Error('private raw failure');
      const original = jest.fn((): Promise<never> => {
        if (mode === 'sync') throw failure;
        return Promise.reject(failure);
      });
      await expect(observeD7Span(r, 'assertPreparedSetConsistent', original)).rejects.toBe(failure);
      expect(original).toHaveBeenCalledTimes(1);
      expect(r.report().boundaries.map((b) => b.edge)).toEqual(['ENTERED', 'THREW']);
      expect(JSON.stringify(r.report())).not.toContain('private raw failure');
    },
  );

  it('keeps the previous listener and bounded receive sequence, with phase-at-receive semantics', async () => {
    const r = recorder();
    const prior = jest.fn();
    await observeD7Span(r, 'callback', async () => {
      r.query('SELECT private_parameter', 17, prior);
      await observeD7Span(r, 'readBatchDayDeltas', async () => {
        r.query('SELECT * FROM "ParticipationLedgerEntry" GROUP BY "memberId"', 84, prior);
      });
    });
    expect(prior).toHaveBeenCalledTimes(2);
    expect(r.report().receivedEvents.map((e) => [e.ordinal, e.phaseAtReceive, e.kind])).toEqual([
      [1, 'callback', 'other'],
      [2, 'readBatchDayDeltas', 'ledger_day_deltas'],
    ]);
    expect(JSON.stringify(r.report())).not.toContain('private_parameter');
    expect(r.report().recorderCosts).toMatchObject({
      queryListener: { calls: 2 },
      boundary: { calls: 4 },
    });
  });

  it('reports truncation as UNKNOWN and never truncates the existing listener', () => {
    const r = recorder();
    const prior = jest.fn();
    for (let i = 0; i < 100; i++) r.query('SELECT private', 1, prior);
    expect(prior).toHaveBeenCalledTimes(100);
    expect(r.report()).toMatchObject({
      status: 'UNKNOWN',
      totalEvents: 100,
      retainedEvents: 96,
      droppedEvents: 4,
    });
  });

  it('isolates sampler and cost-clock failures from original success and rejection', async () => {
    const fail = () => {
      throw new Error('private recorder detail');
    };
    const r = new D7CommitTiming(fail, fail);
    const value = { same: true };
    const failure = new Error('original business failure');
    await expect(observeD7Span(r, 'callback', async () => value)).resolves.toBe(value);
    await expect(
      observeD7Span(r, 'callback', async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    const prior = jest.fn();
    r.query('SELECT private', 1, prior);
    expect(prior).toHaveBeenCalledTimes(1);
    expect(r.report().status).toBe('UNKNOWN');
    expect(r.report().faults).toBeGreaterThan(0);
    expect(JSON.stringify(r.report())).not.toContain('private recorder detail');
  });

  it('marks open or unbalanced phases and invalid durations UNKNOWN', () => {
    const r = recorder();
    r.boundary('callback', 'ENTERED');
    expect(r.report().status).toBe('UNKNOWN');
    r.boundary('ledgerCommit', 'THREW');
    r.query('SELECT private', NaN, () => {});
    expect(r.report().status).toBe('UNKNOWN');
  });

  it('does not turn independent durations into a callback CPU or waiting partition', async () => {
    const r = recorder();
    r.query('BEGIN', 5, () => {});
    await observeD7Span(r, 'callback', async () => {
      r.query('ROLLBACK', 256, () => {});
    });
    expect(r.report().receivedEvents.map((e) => e.phaseAtReceive)).toEqual(['outside', 'callback']);
    expect(r.report().semantics).toContain('do not partition');
    expect(r.report()).not.toHaveProperty('applicationCpuFromDifferenceMs');
  });

  it('bounds boundary storage and reports overflow instead of silently losing intervals', async () => {
    const r = recorder();
    for (let i = 0; i < 20; i++) await observeD7Span(r, 'callback', async () => 1);
    expect(r.report()).toMatchObject({ status: 'UNKNOWN', droppedBoundaries: 8, openPhases: 0 });
    expect(r.report().boundaries).toHaveLength(32);
  });

  it('rejects regressing numeric samples and omits extra injected field names', () => {
    let call = 0;
    const r = new D7CommitTiming(
      () => ({ ...point(), monoMs: ++call === 1 ? 100 : 99, privateField: 17 }),
      clock,
    );
    r.query('SELECT private', 1, () => {});
    r.query('SELECT private', 1, () => {});
    expect(r.report().status).toBe('UNKNOWN');
    expect(JSON.stringify(r.report())).not.toContain('privateField');
  });

  it('retains original business success when the existing diagnostic listener throws', async () => {
    const r = recorder();
    const result = { unchanged: true };
    await expect(
      observeD7Span(r, 'callback', async () => {
        r.query('SELECT private', 1, () => {
          throw new Error('private logger failure');
        });
        return result;
      }),
    ).resolves.toBe(result);
    expect(r.report().status).toBe('UNKNOWN');
    expect(JSON.stringify(r.report())).not.toContain('private logger failure');
  });
});
