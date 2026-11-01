import type { PrismaClient } from '@prisma/client';
import {
  classifyR5Backends,
  assertR5BackendBoundary,
  type R5BackendRow,
  type R5BoundaryReport,
} from './r5-setmat-backend-boundary';
const owner = { pid: 101, databaseOid: 1998913, backendStart: '2026-10-30 16:00:00+00' };
const row = (extra: Partial<R5BackendRow> = {}): R5BackendRow => ({
  ...owner,
  backendType: 'client backend',
  leaderPid: null,
  state: 'active',
  transactionStart: null,
  queryStart: null,
  stateChange: null,
  waitType: null,
  waitEvent: null,
  ...extra,
});
const report = (rows: R5BackendRow[]): R5BoundaryReport => ({
  observedAt: 'now',
  observerPid: 101,
  backends: rows,
  prepared: 0,
  leaseHeld: true,
});
describe('backend exclusion: default unchanged, proposed single maintenance exception (no DB)', () => {
  it('default refuses maintenance, approved policy retains its complete identity', () => {
    const maintenance = row({
        pid: 202,
        backendType: 'autovacuum worker',
        waitType: 'IO',
        waitEvent: 'DataFileRead',
      }),
      r = report([row(), maintenance]);
    expect(classifyR5Backends(r, [owner]).pass).toBe(false);
    expect(classifyR5Backends(r, [owner], 'CLONE_AUTOVACUUM_ONLY')).toEqual({
      block: [],
      maintenance: [maintenance],
      pass: true,
    });
  });
  it.each([
    'client backend',
    'parallel worker',
    'logical replication worker',
    'autovacuum launcher',
    'extension worker',
    null,
    'AUTOVACUUM WORKER',
  ])('blocks other/unknown backend %s, including idle clients', (backendType) => {
    const r = report([row(), row({ pid: 202, backendType, state: 'idle' })]);
    expect(classifyR5Backends(r, [owner], 'CLONE_AUTOVACUUM_ONLY').pass).toBe(false);
  });
  it.each([1713092, 1971161])(
    'always blocks protected database %s even for autovacuum',
    (databaseOid) => {
      expect(
        classifyR5Backends(
          report([row(), row({ pid: 202, databaseOid, backendType: 'autovacuum worker' })]),
          [owner],
          'CLONE_AUTOVACUUM_ONLY',
        ).pass,
      ).toBe(false);
    },
  );
  it.each([{ leaseHeld: false }, { prepared: 1 }])(
    'retains lease/prepared requirements %s',
    (change) => {
      expect(
        classifyR5Backends({ ...report([row()]), ...change }, [owner], 'CLONE_AUTOVACUUM_ONLY')
          .pass,
      ).toBe(false);
    },
  );
  it.each([
    { backendStart: 'reused-pid' },
    { backendType: 'autovacuum worker' },
    { databaseOid: 1971161 },
  ])('never exempts self on PID alone %s', (change) => {
    expect(() =>
      classifyR5Backends(report([row(change)]), [owner], 'CLONE_AUTOVACUUM_ONLY'),
    ).toThrow();
  });
  it('rejects missing/duplicate owner and unknown database', () => {
    expect(() => classifyR5Backends(report([]), [owner])).toThrow();
    expect(() => classifyR5Backends(report([row()]), [owner, owner])).toThrow();
    expect(() =>
      classifyR5Backends(report([row(), row({ pid: 202, databaseOid: 1 })]), [owner]),
    ).toThrow();
  });
  it('persists the failing PID/type before assertion, without SQL/user/token fields', async () => {
    const sample = report([row(), row({ pid: 202, state: 'idle' })]),
      saved: unknown[] = [];
    const query = jest.fn(async () => [sample]);
    const execute = jest.fn(async () => 0);
    const transaction = jest.fn(
      async (fn: (tx: unknown) => Promise<unknown>, _options: unknown) => (
        void _options,
        fn({ $queryRaw: query, $executeRaw: execute })
      ),
    );
    const observer = {
      $queryRaw: jest.fn(async () => [{ ...owner, backendType: 'client backend' }]),
      $transaction: transaction,
    };
    await expect(
      assertR5BackendBoundary(
        observer as unknown as PrismaClient,
        undefined,
        99,
        'CLONE_AUTOVACUUM_ONLY',
        (r) => {
          saved.push(r);
          return 'memory';
        },
        'negative',
      ),
    ).rejects.toThrow();
    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject({
      kind: 'R5_BACKEND_BOUNDARY_SAMPLE',
      rows: [{ backends: [{ pid: 101 }, { pid: 202, backendType: 'client backend' }] }],
    });
    expect(transaction.mock.calls[0][1]).toEqual({ timeout: 3000, maxWait: 1000 });
    const sql = String((query.mock.calls[0] as unknown[])[0]);
    expect(sql).toContain('AS MATERIALIZED');
    expect(sql).toContain('objsubid=1');
    expect(sql).toContain('SRVF:test:D3:app_test_w98');
    expect(JSON.stringify(saved)).not.toMatch(/queryText|usename|client_addr|password|token/i);
  });
});
