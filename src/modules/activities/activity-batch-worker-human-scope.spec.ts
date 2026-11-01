import { ActivityBatchWorker, ACTIVITY_BATCH_LEASE_MS } from './activity-batch.worker';
import { HUMAN_CORRECTION_JOB_TYPE } from './correction-background-job';

interface SqlView {
  sql: string;
  values: unknown[];
}
interface ScopeFixture {
  worker: Pick<ActivityBatchWorker, 'drainOnce' | 'run' | 'onModuleDestroy' | 'executionScope'>;
  query: jest.Mock<Promise<{ id: string }[]>, [SqlView]>;
  update: jest.Mock;
  updateMany: jest.Mock;
  execute: jest.Mock;
  transaction: jest.Mock;
  unrelated: jest.Mock;
  process: jest.Mock;
  assertClient: jest.Mock;
  qualify: jest.Mock;
  trace: string[];
  tx: unknown;
  items: unknown;
  prisma: {
    activityBatchJob: { updateMany: jest.Mock };
    ledgerPostingBatch: { findMany: jest.Mock };
  };
  reconciliation: {
    enqueueDueActivityStartExpiryJobs: jest.Mock;
    expireAtActivityStart: jest.Mock;
  };
}

/** Runs the production dispatcher/claim code. SQL is a pure model, not a PG
 * lock/rollback/qualification proof. The Human service's real callback and
 * protected epoch invariants are covered separately, without changing them. */
function fixture(bound = true, candidate: string | null = 'human'): ScopeFixture {
  const trace: string[] = [];
  const query = jest.fn((_sql: SqlView) => {
    void _sql;
    trace.push('claim-query');
    return Promise.resolve(candidate === null ? [] : [{ id: candidate }]);
  });
  const update = jest.fn().mockResolvedValue({
    id: 'human',
    activityId: 'activity',
    jobTypeCode: HUMAN_CORRECTION_JOB_TYPE,
    leaseGeneration: 8,
    payload: { action: 'human_correction_commit' },
  });
  const updateMany = jest.fn().mockResolvedValue({ count: 0 });
  const execute = jest.fn().mockResolvedValue(0);
  const tx = { $queryRaw: query, $executeRaw: execute, activityBatchJob: { update, updateMany } };
  const transaction = jest.fn(async (body: unknown): Promise<unknown> => {
    if (typeof body !== 'function') throw new Error('callback transaction required');
    const outcome: unknown = Reflect.apply(body, undefined, [tx]);
    return await Promise.resolve(outcome);
  });
  const unrelated = jest.fn(() => {
    throw new Error('no ActivitySession/ActivityInvitation permission');
  });
  const prisma = {
    $transaction: transaction,
    activityBatchJob: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    ledgerPostingBatch: {
      findMany: jest.fn((): Promise<unknown[]> => {
        unrelated();
        return Promise.resolve([]);
      }),
    },
    activityBatchJobItem: { findMany: unrelated },
    activitySession: { findMany: unrelated },
    activityInvitation: { findMany: unrelated },
  };
  const preparation = { ensurePrepareJob: unrelated, prepareChunk: unrelated, finalize: unrelated };
  const committer = { commitReadyBatch: unrelated };
  const reconciliation = {
    enqueueDueActivityStartExpiryJobs: jest.fn((_now: Date): Promise<number> => {
      void _now;
      unrelated();
      return Promise.resolve(0);
    }),
    expireAtActivityStart: unrelated,
  };
  const process = jest.fn(() => {
    trace.push('human-handler');
    return Promise.resolve(true);
  });
  const assertClient = jest.fn((actual: unknown) => {
    expect(actual).toBe(prisma);
    trace.push('client');
  });
  const qualify = jest.fn((actual: unknown) => {
    expect(actual).toBe(tx);
    trace.push('qualification');
    return Promise.resolve();
  });
  const items = { hasConnectionBinding: bound, assertClient, assertCallerInTx: qualify };
  const worker = new ActivityBatchWorker(
    prisma as never,
    preparation as never,
    committer as never,
    true,
    reconciliation as never,
    undefined,
    undefined,
    undefined,
    { process } as never,
    items as never,
  );
  return {
    worker,
    prisma,
    tx,
    query,
    update,
    updateMany,
    execute,
    transaction,
    unrelated,
    process,
    assertClient,
    qualify,
    trace,
    items,
    reconciliation,
  };
}

describe('production protected Human worker family', () => {
  it('keeps the300s lease and awaits its actual in-flight round on shutdown', async () => {
    const f = fixture();
    let release!: (value: boolean) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.process.mockImplementation(() => {
      started();
      return new Promise<boolean>((resolve) => {
        release = resolve;
      });
    });
    const running = f.worker.run();
    await entered;
    let closed = false;
    const stopping = f.worker.onModuleDestroy().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(ACTIVITY_BATCH_LEASE_MS).toBe(300000);
    release(true);
    await stopping;
    await running;
    expect(f.process).toHaveBeenCalledTimes(1);
  });
  it('claims only Human under the real drain entry, preserving lease and passing the exact fence to the original handler', async () => {
    const f = fixture(),
      now = new Date('2026-10-31T00:00:00Z');
    await expect(f.worker.drainOnce({ now })).resolves.toMatchObject({
      jobsEnqueued: 0,
      jobClaimed: true,
      jobId: 'human',
      itemsProcessed: 1,
      batchStatus: 'committed',
    });
    expect(f.worker.executionScope).toBe('human-correction');
    const sql = f.query.mock.calls[0][0];
    expect(sql.sql).toMatch(/WHERE\s*\(\s*"jobTypeCode"\s*=\s*\?\s*\)/);
    expect(sql.values[0]).toBe(HUMAN_CORRECTION_JOB_TYPE);
    const familyParameterCount = (sql.sql.split('AND NOT')[0].match(/\?/g) ?? []).length;
    expect(sql.values.slice(0, familyParameterCount)).toEqual([HUMAN_CORRECTION_JOB_TYPE]);
    expect(sql.sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql.sql).toContain('"availableAt" <=');
    expect(sql.sql).toContain('"leaseExpiresAt" <=');
    expect(f.trace).toEqual(['client', 'qualification', 'claim-query', 'human-handler']);
    expect(f.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          leaseGeneration: { increment: 1 },
          attempts: { increment: 1 },
          leaseExpiresAt: new Date(now.getTime() + ACTIVITY_BATCH_LEASE_MS),
        }) as unknown,
      }) as unknown,
    );
    expect(f.process).toHaveBeenCalledWith({
      jobId: 'human',
      activityId: 'activity',
      leaseOwner: expect.stringMatching(/^activity-batch-worker:/) as unknown,
      leaseGeneration: 8,
    });
    expect(f.unrelated).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.updateMany).not.toHaveBeenCalled();
  });
  it('the actual process run loop selects the same family without a test-only option', async () => {
    const f = fixture();
    f.process.mockImplementation(() => {
      void f.worker.onModuleDestroy();
      return Promise.resolve(true);
    });
    await f.worker.run();
    await f.worker.onModuleDestroy();
    expect(f.process).toHaveBeenCalledTimes(1);
    expect(f.unrelated).not.toHaveBeenCalled();
  });
  it('empty Human queue does not synthesize unrelated ledger or expiry jobs', async () => {
    const f = fixture(true, null);
    await expect(f.worker.drainOnce()).resolves.toMatchObject({
      jobsEnqueued: 0,
      jobClaimed: false,
      jobId: null,
    });
    expect(f.update).not.toHaveBeenCalled();
    expect(f.process).not.toHaveBeenCalled();
    expect(f.unrelated).not.toHaveBeenCalled();
  });
  it('does not report applied when the original Human handler reports unresolved/unapplied', async () => {
    const f = fixture();
    f.process.mockResolvedValue(false);
    await expect(f.worker.drainOnce()).resolves.toMatchObject({
      jobClaimed: true,
      itemsProcessed: 0,
      batchStatus: null,
    });
  });
  it('qualification failure aborts before candidate read/write rather than falling back to the generic worker', async () => {
    const f = fixture(),
      error = new Error('actual-source-unavailable');
    f.qualify.mockRejectedValue(error);
    await expect(f.worker.drainOnce()).rejects.toBe(error);
    expect(f.query).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
    expect(f.process).not.toHaveBeenCalled();
    expect(f.unrelated).not.toHaveBeenCalled();
  });
  it('a client mismatch cannot reach even the claim transaction', async () => {
    const f = fixture();
    f.assertClient.mockImplementation(() => {
      throw new Error('client mismatch');
    });
    await expect(f.worker.drainOnce()).rejects.toThrow('client mismatch');
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it('a cross-family returned row fails within the claim callback and never enters any handler', async () => {
    const f = fixture();
    f.update.mockResolvedValue({
      id: 'legacy',
      activityId: 'activity',
      jobTypeCode: 'reconciliation',
      leaseGeneration: 8,
      payload: { action: 'other' },
    });
    await expect(f.worker.drainOnce()).rejects.toThrow('ClaimScopeMismatch');
    expect(f.process).not.toHaveBeenCalled();
    expect(f.unrelated).not.toHaveBeenCalled();
  });
  it('unbound general identities do not claim Human while retaining ordinary sweep and reconciliation dispatch', async () => {
    const f = fixture(false, null);
    f.prisma.ledgerPostingBatch.findMany.mockResolvedValue([]);
    f.reconciliation.enqueueDueActivityStartExpiryJobs.mockResolvedValue(0);
    await expect(f.worker.drainOnce()).resolves.toMatchObject({
      jobClaimed: false,
      jobsEnqueued: 0,
    });
    expect(f.worker.executionScope).toBe('general');
    expect(f.query.mock.calls[0][0].values[0]).not.toBe(HUMAN_CORRECTION_JOB_TYPE);
    const sql = f.query.mock.calls[0][0];
    const familyParameterCount = (sql.sql.split('AND NOT')[0].match(/\?/g) ?? []).length;
    expect(sql.values.slice(0, familyParameterCount)).not.toContain(HUMAN_CORRECTION_JOB_TYPE);
    expect(f.query.mock.calls[0][0].sql).toContain('"jobTypeCode" IN');
    expect(f.reconciliation.enqueueDueActivityStartExpiryJobs).toHaveBeenCalledTimes(1);
    expect(f.execute).toHaveBeenCalled();
    expect(f.qualify).not.toHaveBeenCalled();
  });
});
