import type { StorageObjectLedgerService } from '../storage/storage-object-ledger.service';
import type { AttachmentStorageOrchestrator } from './attachment-storage-orchestrator';
import { StorageConsistencyWorker } from './storage-consistency.worker';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

const UNIT_TIMEOUT_MS = 2_000;

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${UNIT_TIMEOUT_MS}ms`)),
          UNIT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function operation(eventKey: string) {
  return { eventKey } as never;
}

describe('StorageConsistencyWorker JIT lease boundary', () => {
  it('does not purge delete replay snapshots during continuous or once drains', async () => {
    const purgeExpiredDeleteReplays = jest.fn();
    const claim = jest.fn().mockResolvedValue([]);
    const ledger = {
      claim,
      purgeExpiredDeleteReplays,
    } as unknown as StorageObjectLedgerService;
    const reconcileRolloutAttachments = jest.fn().mockResolvedValue(0);
    const orchestrator = {
      reconcileRolloutAttachments,
    } as unknown as AttachmentStorageOrchestrator;
    const worker = new StorageConsistencyWorker(ledger, orchestrator);

    await expect(worker.drainOnce()).resolves.toEqual({
      backfilled: 0,
      claimed: 0,
      succeeded: 0,
      pending: 0,
      dead: 0,
    });
    expect(purgeExpiredDeleteReplays).not.toHaveBeenCalled();
    expect(reconcileRolloutAttachments).toHaveBeenCalledTimes(1);
    expect(reconcileRolloutAttachments).toHaveBeenCalledWith(100);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledWith(expect.any(String), {
      limit: 1,
      objectKey: undefined,
      kind: undefined,
      manualOnly: undefined,
    });
  });

  it('claims the next operation only after the current Effect settles', async () => {
    const first = operation('first');
    const second = operation('second');
    const entered = deferred();
    const release = deferred();
    const claim = jest.fn().mockResolvedValueOnce([first]).mockResolvedValueOnce([second]);
    const findOperationByEventKey = jest
      .fn()
      .mockResolvedValueOnce({ status: 'succeeded' })
      .mockResolvedValueOnce({ status: 'pending' });
    const ledger = { claim, findOperationByEventKey } as unknown as StorageObjectLedgerService;
    const executeClaimed = jest.fn(async (claimed: { eventKey: string }) => {
      if (claimed.eventKey === 'first') {
        entered.resolve();
        await release.promise;
      }
    });
    const reconcileRolloutAttachments = jest.fn().mockResolvedValue(7);
    const orchestrator = {
      reconcileRolloutAttachments,
      executeClaimed,
    } as unknown as AttachmentStorageOrchestrator;
    const worker = new StorageConsistencyWorker(ledger, orchestrator);

    const draining = worker.drainOnce({
      limit: 2,
      objectKey: 'target-key',
      kind: 'backfill_verify',
      manualOnly: true,
    });
    try {
      await withTimeout(entered.promise, 'first Effect entry barrier');

      expect(claim).toHaveBeenCalledTimes(1);
      expect(executeClaimed).toHaveBeenCalledTimes(1);
      release.resolve();

      await expect(withTimeout(draining, 'two-operation drain')).resolves.toEqual({
        backfilled: 7,
        claimed: 2,
        succeeded: 1,
        pending: 1,
        dead: 0,
      });
      expect(claim).toHaveBeenCalledTimes(2);
      expect(claim).toHaveBeenNthCalledWith(1, expect.any(String), {
        limit: 1,
        objectKey: 'target-key',
        kind: 'backfill_verify',
        manualOnly: true,
      });
      expect(claim).toHaveBeenNthCalledWith(2, expect.any(String), {
        limit: 1,
        objectKey: 'target-key',
        kind: 'backfill_verify',
        manualOnly: true,
      });
      expect(reconcileRolloutAttachments).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await withTimeout(draining, 'two-operation cleanup drain').catch(() => undefined);
    }
  });

  it('counts succeeded, pending and dead outcomes and stops at the drain budget', async () => {
    const claim = jest
      .fn()
      .mockResolvedValueOnce([operation('succeeded')])
      .mockResolvedValueOnce([operation('pending')])
      .mockResolvedValueOnce([operation('dead')]);
    const findOperationByEventKey = jest
      .fn()
      .mockResolvedValueOnce({ status: 'succeeded' })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'dead' });
    const ledger = { claim, findOperationByEventKey } as unknown as StorageObjectLedgerService;
    const executeClaimed = jest.fn().mockResolvedValue(undefined);
    const reconcileRolloutAttachments = jest.fn().mockResolvedValue(0);
    const orchestrator = {
      reconcileRolloutAttachments,
      executeClaimed,
    } as unknown as AttachmentStorageOrchestrator;
    const worker = new StorageConsistencyWorker(ledger, orchestrator);

    await expect(worker.drainOnce({ limit: 3, runReconcile: false })).resolves.toEqual({
      backfilled: 0,
      claimed: 3,
      succeeded: 1,
      pending: 1,
      dead: 1,
    });
    expect(claim).toHaveBeenCalledTimes(3);
    expect(executeClaimed).toHaveBeenCalledTimes(3);
    expect(reconcileRolloutAttachments).not.toHaveBeenCalled();
  });

  it('does not claim another operation after shutdown begins during the current Effect', async () => {
    const first = operation('first');
    const entered = deferred();
    const release = deferred();
    const claim = jest.fn().mockResolvedValue([first]);
    const ledger = {
      claim,
      findOperationByEventKey: jest.fn().mockResolvedValue({ status: 'succeeded' }),
    } as unknown as StorageObjectLedgerService;
    const executeClaimed = jest.fn(async () => {
      entered.resolve();
      await release.promise;
    });
    const orchestrator = {
      reconcileRolloutAttachments: jest.fn().mockResolvedValue(0),
      executeClaimed,
    } as unknown as AttachmentStorageOrchestrator;
    const worker = new StorageConsistencyWorker(ledger, orchestrator);

    const draining = worker.drainOnce({ limit: 2 });
    try {
      await withTimeout(entered.promise, 'shutdown Effect entry barrier');
      worker.onApplicationShutdown();
      release.resolve();

      await expect(withTimeout(draining, 'shutdown drain')).resolves.toEqual({
        backfilled: 0,
        claimed: 1,
        succeeded: 1,
        pending: 0,
        dead: 0,
      });
      expect(claim).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await withTimeout(draining, 'shutdown cleanup drain').catch(() => undefined);
    }
  });

  it('finishes an operation returned by an in-flight claim after shutdown, then stops', async () => {
    const first = operation('in-flight-claim');
    const claimEntered = deferred();
    const claimRelease = deferred<unknown[]>();
    const claim = jest.fn(async () => {
      claimEntered.resolve();
      return claimRelease.promise;
    });
    const findOperationByEventKey = jest.fn().mockResolvedValue({ status: 'succeeded' });
    const ledger = { claim, findOperationByEventKey } as unknown as StorageObjectLedgerService;
    const executeClaimed = jest.fn().mockResolvedValue(undefined);
    const orchestrator = {
      reconcileRolloutAttachments: jest.fn().mockResolvedValue(0),
      executeClaimed,
    } as unknown as AttachmentStorageOrchestrator;
    const worker = new StorageConsistencyWorker(ledger, orchestrator);

    const draining = worker.drainOnce({ limit: 2 });
    try {
      await withTimeout(claimEntered.promise, 'claim entry barrier');
      worker.onApplicationShutdown();
      claimRelease.resolve([first]);

      await expect(withTimeout(draining, 'in-flight claim drain')).resolves.toEqual({
        backfilled: 0,
        claimed: 1,
        succeeded: 1,
        pending: 0,
        dead: 0,
      });
      expect(claim).toHaveBeenCalledTimes(1);
      expect(executeClaimed).toHaveBeenCalledTimes(1);
      expect(executeClaimed).toHaveBeenCalledWith(first);
      expect(findOperationByEventKey).toHaveBeenCalledWith('in-flight-claim');
    } finally {
      claimRelease.resolve([first]);
      await withTimeout(draining, 'in-flight claim cleanup drain').catch(() => undefined);
    }
  });
});
