import type { PrismaClient } from '@prisma/client';
import {
  R5_SEPARATED_SCOPE,
  assertR5SeparatedComponent,
  r5RollbackObservationOptions,
  r5SeparatedClaimPath,
  type R5SeparatedComponent,
} from './r5-setmat-separated-policy';
import {
  R5_COMPONENT_ORIGIN as origin,
  r5ContinuationClaimPath,
} from './r5-setmat-component-continuation';
import { capacityClock, type CapacityConfig } from './r5-setmat-capacity.protocol';
import { measureR5SeparatedComponent, observedXid } from './r5-setmat-separated-component';
import {
  installR5CallerTransactions,
  R5_SETMAT_DATABASE,
  R5_SETMAT_CALLER,
} from './r5-setmat-observation';
import type { R5CapacityFixture } from './r5-setmat-capacity.fixture';
import * as projection from './r5-setmat-capacity-projection';
import * as durable from './r5-setmat-durable-receipt';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const separated = (): R5SeparatedComponent => ({
  schema: 'srvf-r5-separated-component-dispatch/v1',
  scope: R5_SEPARATED_SCOPE,
  authorization: { approved: true, reference: 'PURE_TEST_ONLY_NOT_REAL_APPROVAL' },
  originalEvidenceDirectory: '/original',
  failedEvidenceDirectory: '/failed',
});
describe('separated component approval and immutable budgets (PURE ONLY)', () => {
  it('atomically publishes complete control JSON and never overwrites a prior deadline', () => {
    const directory = mkdtempSync(join(tmpdir(), 'r5-control-'));
    try {
      const file = join(directory, 'control.json');
      durable.writeR5AtomicControlReceipt(file, { deadline: 123, body: 'x'.repeat(100000) });
      expect(JSON.parse(readFileSync(file, 'utf8')).deadline).toBe(123);
      expect(() => durable.writeR5AtomicControlReceipt(file, { deadline: 999 })).toThrow();
      expect(JSON.parse(readFileSync(file, 'utf8')).deadline).toBe(123);
      expect(readdirSync(directory)).toEqual(['control.json']);
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
  it('requires the exact additional diagnostic scope; native options stay the same object', () => {
    expect(() => assertR5SeparatedComponent(separated())).not.toThrow();
    const options = { timeout: 15000, isolationLevel: 'ReadCommitted', maxWait: 2000 };
    expect(
      r5RollbackObservationOptions(options, {
        kind: 'R5_SETMAT_CANDIDATE_15S',
        authorizationReference: 'test',
      }),
    ).toBe(options);
    expect(
      r5RollbackObservationOptions(options, {
        kind: 'R5_SETMAT_CORRECTNESS_120S',
        authorizationReference: 'test',
      }),
    ).toEqual({ ...options, timeout: 120000 });
    expect(options.timeout).toBe(15000);
  });
  it.each([
    'diagnosticTransactionMs',
    'diagnosticControlMs',
    'candidateTransactionMs',
    'candidateControlMs',
    'writeTransactions',
    'applicationId',
    'failedZipSha256',
    'realCommitAllowed',
    'prepareAllowed',
    'full10000Admission',
  ])('rejects changed %s', (key) => {
    const value = structuredClone(separated());
    Reflect.set(value.scope, key, 'changed');
    expect(() => assertR5SeparatedComponent(value)).toThrow();
  });
  it.each([false, null, undefined])('rejects missing/unapproved new scope %s', (approved) => {
    const value = separated();
    Reflect.set(value.authorization, 'approved', approved);
    expect(() => assertR5SeparatedComponent(value)).toThrow();
  });
  it.each([
    { timeout: 7000, isolationLevel: 'ReadCommitted' },
    { timeout: 120000, isolationLevel: 'ReadCommitted' },
    { timeout: 15000, isolationLevel: 'RepeatableRead' },
  ])('rejects a nonnative starting contract %s', (options) => {
    expect(() =>
      r5RollbackObservationOptions(options, {
        kind: 'R5_SETMAT_CORRECTNESS_120S',
        authorizationReference: 'test',
      }),
    ).toThrow();
  });
  it('uses a new fixed purpose claim, preserving the consumed prior application claim', () => {
    expect(r5SeparatedClaimPath()).not.toBe(r5ContinuationClaimPath());
    expect(r5SeparatedClaimPath()).toBe(
      origin.originalRuntimeDirectory +
        '/' +
        origin.applicationId +
        '.separated-component-b1270d88.attempt.json',
    );
  });
  it('keeps both closed campaigns closed and refuses full10000/old dispatch', () => {
    const now = Date.parse('2026-10-30T16:00:00Z');
    const c = {
      mode: 'component1000',
      separatedComponent: separated(),
      window: {
        id: 'test',
        dispatchReference: 'test',
        previousWindow: 'COMPONENT_COMPARISON_FAIL_ROLLBACK_PROVED',
        startedAt: new Date(now).toISOString(),
        deadline: new Date(now + 600000).toISOString(),
      },
    } as CapacityConfig;
    expect(() => capacityClock(c, now, 185000)).not.toThrow();
    expect(() => capacityClock({ ...c, mode: 'full10000' }, now)).toThrow();
    expect(() =>
      capacityClock(
        {
          ...c,
          window: { ...c.window, previousWindow: 'COMPONENT_NOT_REACHED_FAIL_PREPARE_COMMITTED' },
        },
        now,
      ),
    ).toThrow();
    expect(() => capacityClock(c, now + 600000)).toThrow();
  });
  it.each(['158897', '158922', 'bad'])(
    'rejects reused or malformed transaction identity %s',
    (xid) => {
      expect(() => observedXid({ server: [{ status: 'aborted', identity: { xid } }] })).toThrow();
    },
  );
});

describe('actual observer and separated orchestration with fake SQL/engine only', () => {
  afterEach(() => jest.restoreAllMocks());
  function fixture(
    options: {
      badBag?: boolean;
      unknownFirst?: boolean;
      changedSnapshot?: boolean;
      returnWithoutAudit?: boolean;
      failTimed?: boolean;
    } = {},
  ) {
    const now = Date.parse('2026-10-30T16:00:00Z');
    jest.spyOn(durable, 'writeR5AtomicControlReceipt').mockImplementation((file) => file);
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const config = {
      mode: 'component1000',
      outputDirectory: '/pure-only-no-files',
      separatedComponent: separated(),
      window: {
        id: 'test',
        dispatchReference: 'test',
        previousWindow: 'COMPONENT_COMPARISON_FAIL_ROLLBACK_PROVED',
        startedAt: new Date(now).toISOString(),
        deadline: new Date(now + 600000).toISOString(),
      },
    } as CapacityConfig;
    let state = 0,
      call = 0,
      reads = 0,
      projectionCalls = 0,
      currentXid = '';
    const events: string[] = [],
      receipts: unknown[] = [],
      transactionOptions: unknown[] = [];
    const engine = {
      transaction: jest.fn(async (phase: string) => {
        events.push('engine:' + phase);
      }),
    };
    const tx = {
      $executeRaw: jest.fn(async (sql: TemplateStringsArray) => {
        events.push('sql:' + sql.join('?'));
        if (sql.join('').includes('ROLLBACK TO')) state = 0;
        return 0;
      }),
      $queryRaw: jest.fn(async (sql: TemplateStringsArray) => {
        const text = sql.join('?');
        events.push('sql:' + text);
        return text.includes('current_database')
          ? [
              {
                database: R5_SETMAT_DATABASE,
                databaseOid: 1998913,
                role: R5_SETMAT_CALLER,
                pid: 11,
                xid: currentXid,
                sessionUser: 'test-login',
                roleOid: '1789091',
                isSuperuser: 'off',
              },
            ]
          : [{ state: 'MATERIALIZED' }];
      }),
    };
    const client = {
      _engine: engine,
      $transaction: async (body: (t: unknown) => Promise<unknown>, opts: unknown) => {
        transactionOptions.push(opts);
        call++;
        currentXid = String(200000 + call);
        await engine.transaction('start');
        try {
          const value = await body(tx);
          await engine.transaction('commit');
          return value;
        } catch (error) {
          state = 0;
          await engine.transaction('rollback');
          throw error;
        }
      },
    };
    const observer = {
      $queryRaw: jest.fn(async () => [
        {
          database: R5_SETMAT_DATABASE,
          databaseOid: 1998913,
          observerPid: 12,
          status: options.unknownFirst && call === 1 ? null : 'aborted',
        },
      ]),
    };
    const route = installR5CallerTransactions(client as unknown as PrismaClient, 1998913);
    const bags = () =>
      ['allocation', 'baseSegment', 'binding', 'evidence', 'receipt', 'slice', 'targetSegment'].map(
        (kind) => ({
          kind,
          count: kind === 'binding' ? '10000' : kind === 'slice' ? '5000' : '1000',
          hash: 'a'.repeat(64),
        }),
      );
    jest.spyOn(projection, 'capacityProjection').mockImplementation(async () => {
      events.push('projection');
      projectionCalls++;
      const rows = bags();
      if (options.badBag && projectionCalls === 2) rows[0].hash = 'b'.repeat(64);
      return rows;
    });
    jest.spyOn(projection, 'capacityCensus').mockImplementation(async () => {
      events.push('census');
      return ['allocation', 'binding', 'evidence', 'receipt', 'segment', 'slice'].map((kind) => ({
        kind,
        count: state * (kind === 'binding' ? 10000 : kind === 'slice' ? 5000 : 1000),
      }));
    });
    const nativeFailure = new Error('native failure');
    const audit = {
      logCommit: jest.fn(async () => {
        events.push('audit');
      }),
    };
    const corrections = {
      audit,
      materializeV3PendingSegments: jest.fn(async () => {
        events.push('reference');
        state = 1;
        return 1000;
      }),
      materializePendingSegments: jest.fn(async () => {
        events.push('candidate');
        if (call === 2 && options.failTimed) throw nativeFailure;
        state = 1;
        return 1000;
      }),
    };
    const commit = () =>
      client.$transaction(
        async () => {
          if (options.returnWithoutAudit) return 'unexpected replay';
          events.push('native-prelude');
          const method: unknown = Reflect.get(corrections, 'materializePendingSegments');
          if (typeof method !== 'function') throw new Error('missing');
          await Reflect.apply(method, corrections, [
            tx,
            origin.applicationId,
            origin.activityId,
            origin.postingBatchId,
            {},
            'B',
          ]);
          events.push('native-ledger-seal');
          const log: unknown = Reflect.get(audit, 'logCommit');
          if (typeof log !== 'function') throw new Error('missing');
          await Reflect.apply(log, audit, [{ correctionApplicationId: origin.applicationId }]);
        },
        { timeout: 15000, isolationLevel: 'ReadCommitted' },
      );
    let last: unknown;
    const f = {
      delta: 1000,
      applicationId: origin.applicationId,
      activityId: origin.activityId,
      postingBatchId: origin.postingBatchId,
      runId: 'test',
      corrections,
      commit,
      persist: (value: unknown) => {
        receipts.push(value);
        return 'fake-memory';
      },
      observe: async (
        label: string,
        work: () => Promise<unknown>,
        policy: import('./r5-setmat-separated-policy').R5RollbackObservationPolicy,
      ) =>
        route.observe(
          observer as unknown as PrismaClient,
          label,
          work,
          (r) => {
            last = r;
            receipts.push(r);
            return 'receipt';
          },
          policy,
        ),
      getLastObservation: () => last,
      checkpoint: () => {},
      verifyCatalog: async () => {
        events.push('catalog');
      },
      assertRetainedState: async () => {
        events.push('retained');
      },
      assertExclusiveBoundary: async () => {
        events.push('exclusive');
      },
      snapshot: async () => {
        events.push('snapshot');
        reads++;
        return {
          schemaSha256: 'schema',
          tables: ['fake'],
          rows: [{ name: 'fake', count: '1', hash: 'a' }],
          hash: options.changedSnapshot && reads === 3 ? 'drift' : 'same',
        };
      },
    } as unknown as R5CapacityFixture;
    return { f, config, events, transactionOptions, route, corrections, nativeFailure };
  }
  it('runs full parity once, restores all state, then invokes only the native candidate under15s', async () => {
    const f = fixture();
    try {
      const result = await measureR5SeparatedComponent(f.f, f.config);
      expect(result.outcome).toBe('PASS');
      expect(result.includedRealCommit).toBe(false);
      expect(result.full10000Admission).toBe(false);
      expect(f.transactionOptions).toEqual([
        { timeout: 120000, isolationLevel: 'ReadCommitted' },
        { timeout: 15000, isolationLevel: 'ReadCommitted' },
      ]);
      const second = f.events.lastIndexOf('engine:start'),
        end = f.events.lastIndexOf('engine:rollback');
      const timed = f.events.slice(second, end + 1);
      expect(timed).toContain('candidate');
      expect(timed).toContain('native-ledger-seal');
      expect(timed).toContain('audit');
      expect(timed).not.toContain('reference');
      expect(timed).not.toContain('census');
      expect(timed).not.toContain('projection');
      expect(timed).not.toContain('snapshot');
      expect(f.events.filter((x) => x === 'engine:commit')).toHaveLength(0);
      expect(f.corrections.materializeV3PendingSegments).toHaveBeenCalledTimes(1);
      expect(result.correctness.xid).not.toBe(result.candidate.xid);
    } finally {
      f.route.restore();
    }
  });
  it.each([{ badBag: true }, { unknownFirst: true }, { changedSnapshot: true }])(
    'does not start candidate timing after parity/outcome/state failure %s',
    async (options) => {
      const f = fixture(options);
      try {
        await expect(measureR5SeparatedComponent(f.f, f.config)).rejects.toThrow();
        expect(f.transactionOptions).toHaveLength(1);
      } finally {
        f.route.restore();
      }
    },
  );
  it('blocks accidental native COMMIT even when expected audit seam is never reached', async () => {
    const f = fixture({ returnWithoutAudit: true });
    try {
      await expect(measureR5SeparatedComponent(f.f, f.config)).rejects.toThrow();
      expect(f.events).not.toContain('engine:commit');
      expect(f.events).toContain('engine:rollback');
    } finally {
      f.route.restore();
    }
  });
  it('preserves native timed failure and never starts a third attempt', async () => {
    const f = fixture({ failTimed: true });
    try {
      await expect(measureR5SeparatedComponent(f.f, f.config)).rejects.toThrow();
      expect(f.transactionOptions).toHaveLength(2);
      expect(f.events).not.toContain('engine:commit');
    } finally {
      f.route.restore();
    }
  });
  it('retains the native rejection when the final control journal also fails', async () => {
    const f = fixture({ failTimed: true });
    jest.spyOn(durable, 'writeR5AtomicControlReceipt').mockImplementation((file) => {
      if (file.endsWith('control-candidate-settled.json')) throw new Error('journal unavailable');
      return file;
    });
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(measureR5SeparatedComponent(f.f, f.config)).rejects.toBe(f.nativeFailure);
      expect(f.transactionOptions).toHaveLength(2);
    } finally {
      f.route.restore();
    }
  });
});
