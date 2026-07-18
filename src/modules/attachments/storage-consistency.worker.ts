import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { StorageObjectLedgerService } from '../storage/storage-object-ledger.service';
import {
  STORAGE_OPERATION_CLAIM_BATCH,
  type StorageOperationKind,
} from '../storage/storage-consistency.types';
import { AttachmentStorageOrchestrator } from './attachment-storage-orchestrator';

export interface StorageConsistencyDrainOptions {
  objectKey?: string;
  kind?: StorageOperationKind;
  manualOnly?: boolean;
  limit?: number;
  runReconcile?: boolean;
}

export interface StorageConsistencyDrainResult {
  backfilled: number;
  claimed: number;
  succeeded: number;
  pending: number;
  dead: number;
}

@Injectable()
export class StorageConsistencyWorker implements OnApplicationShutdown {
  private readonly logger = new Logger(StorageConsistencyWorker.name);
  private readonly workerId = `storage-consistency:${process.pid}:${randomUUID()}`;
  private stopping = false;
  private nextReconcileAt = 0;

  constructor(
    private readonly ledger: StorageObjectLedgerService,
    private readonly orchestrator: AttachmentStorageOrchestrator,
  ) {}

  onApplicationShutdown(): void {
    this.stopping = true;
  }

  async run(): Promise<void> {
    this.logger.log('storage consistency worker started');
    while (!this.stopping) {
      const now = Date.now();
      const result = await this.drainOnce({ runReconcile: now >= this.nextReconcileAt });
      if (now >= this.nextReconcileAt) this.nextReconcileAt = now + 30_000;
      if (result.claimed === 0) await delay(500);
    }
  }

  async drainOnce(
    options: StorageConsistencyDrainOptions = {},
  ): Promise<StorageConsistencyDrainResult> {
    const runReconcile = options.runReconcile ?? true;
    const backfilled = runReconcile ? await this.orchestrator.reconcileRolloutAttachments(100) : 0;
    const claimed = await this.ledger.claim(this.workerId, {
      limit: options.limit ?? STORAGE_OPERATION_CLAIM_BATCH,
      objectKey: options.objectKey,
      kind: options.kind,
      manualOnly: options.manualOnly,
    });
    const result: StorageConsistencyDrainResult = {
      backfilled,
      claimed: claimed.length,
      succeeded: 0,
      pending: 0,
      dead: 0,
    };

    for (const operation of claimed) {
      await this.orchestrator.executeClaimed(operation);
      const current = await this.ledger.findOperationByEventKey(operation.eventKey);
      if (current?.status === 'succeeded') result.succeeded += 1;
      else if (current?.status === 'dead') result.dead += 1;
      else result.pending += 1;
    }
    return result;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
