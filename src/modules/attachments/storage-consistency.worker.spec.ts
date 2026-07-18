import type { StorageObjectLedgerService } from '../storage/storage-object-ledger.service';
import type { AttachmentStorageOrchestrator } from './attachment-storage-orchestrator';
import { StorageConsistencyWorker } from './storage-consistency.worker';

describe('StorageConsistencyWorker replay retention boundary', () => {
  it('does not purge delete replay snapshots during continuous or once drains', async () => {
    const purgeExpiredDeleteReplays = jest.fn();
    const ledger = {
      claim: jest.fn().mockResolvedValue([]),
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
    expect(reconcileRolloutAttachments).toHaveBeenCalledWith(100);
  });
});
