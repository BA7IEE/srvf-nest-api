import { Inject, Injectable } from '@nestjs/common';
import { type StorageObject } from '@prisma/client';

import { PrismaService } from '../../database/prisma.service';
import { STORAGE_PROVIDER } from '../storage/storage.constants';
import {
  isPinnedStorageProvider,
  StoragePinnedLocatorError,
  type PinnedStorageProvider,
  type StoragePinnedOperationOptions,
  type StorageProvider,
} from '../storage/storage.interface';
import {
  StorageObjectLedgerService,
  storageFenceWhere,
} from '../storage/storage-object-ledger.service';
import {
  parseStorageOperationPayload,
  type ManualStorageOperationPayload,
} from '../storage/storage-operation-payload';
import {
  STORAGE_OPERATION_LEASE_MS,
  type ClaimedStorageOperationWithObject,
  StorageConsistencyInvariantError,
  StorageConsistencyLeaseLostError,
  bigintSize,
  sameStorageLocator,
} from '../storage/storage-consistency.types';
import type {
  HeadObjectResult,
  StorageObjectLocator,
  StorageObjectSha256Result,
} from '../storage/storage.types';
import {
  StorageCandidateNotFoundError,
  StorageObjectIntegrityMismatchError,
  assertExpectedSizeMatchesHead,
  requireHeadSize,
  requireSha256Hex,
  terminalSucceededData,
} from './attachment-storage-invariants';

/*
 * 人工重定位(manual_relocate)的执行侧(Phase 6-B 第四域第二刀)。
 *
 * 从 `AttachmentStorageOrchestrator` 迁出的完整不变量族:取证 → 校验 → 围栏事务内落库。
 * 编排器保留分发(`executeClaimed` 按 kind 路由)与本操作的**受理侧**
 * (`prepareManualRelocate` / `prepareManualOperation`),两者以 kind 为界,互不重叠。
 *
 * ⚠️ 锁序不变(编排器文件头的锁序台账是**全局单点**,不得复制到此):
 * 本服务沿用 `executeManualRelocate | StorageObject -> claimed manual Operation` 一行,
 * 且仍由本服务**自开事务**(迁出前后都是事务起点,不接受外部 tx)——
 * 故迁移不改变任何加锁顺序。任何后续改动若需调整锁序,改的是台账那一行,不是这里。
 */
@Injectable()
export class AttachmentManualRelocateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: StorageObjectLedgerService,
    @Inject(STORAGE_PROVIDER) private readonly provider: StorageProvider,
  ) {}

  async execute(
    operation: ClaimedStorageOperationWithObject,
    payload: ManualStorageOperationPayload,
  ): Promise<void> {
    const targetLocator = payload.targetLocator;
    if (!targetLocator) throw new StorageConsistencyInvariantError('target locator missing');
    if (
      !['legacy_unverified', 'provider_unknown', 'missing', 'integrity_mismatch'].includes(
        operation.storageObject.state,
      )
    ) {
      throw new StorageConsistencyInvariantError('manual relocate source state rejected');
    }
    if (operation.storageObject.deleteRequestedAt !== null) {
      throw new StorageConsistencyInvariantError('manual relocate cannot cross active delete');
    }
    let current = await this.ledger.renewLease(operation);
    let lastLeaseRenewedAt = Date.now();
    const evidence = await this.collectEvidence(
      operation.storageObject,
      targetLocator,
      async () => {
        const now = Date.now();
        if (now - lastLeaseRenewedAt < STORAGE_OPERATION_LEASE_MS / 3) return;
        current = await this.ledger.renewLease(current);
        lastLeaseRenewedAt = now;
      },
    );
    // A 5GB streaming verification can outlive the original claim. Refresh once more before
    // entering the fenced final transaction even when no progress interval elapsed.
    current = await this.ledger.renewLease(current);
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const locked = await this.ledger.lockClaimedForUpdate(tx, current, { now });
      const currentPayload = parseStorageOperationPayload(
        'manual_relocate',
        locked.payloadVersion,
        locked.payload,
      ) as ManualStorageOperationPayload;
      if (
        locked.kind !== 'manual_relocate' ||
        !currentPayload.targetLocator ||
        !sameStorageLocator(currentPayload.targetLocator, targetLocator) ||
        !['legacy_unverified', 'provider_unknown', 'missing', 'integrity_mismatch'].includes(
          locked.storageObject.state,
        ) ||
        locked.storageObject.deleteRequestedAt !== null
      ) {
        throw new StorageConsistencyInvariantError('manual relocate locked state rejected');
      }
      this.assertEvidence(locked.storageObject, evidence);
      const objectUpdated = await tx.storageObject.updateMany({
        where: {
          id: locked.storageObjectId,
          state: locked.storageObject.state,
          deleteRequestedAt: null,
        },
        data: {
          state: 'available',
          providerType: targetLocator.providerType,
          bucket: targetLocator.bucket,
          region: targetLocator.region,
          localNamespace: targetLocator.localNamespace,
          actualSize: bigintSize(evidence.hash?.size ?? requireHeadSize(evidence.head)),
          actualMime: evidence.head.contentType ?? null,
          etag: evidence.head.etag ?? null,
          verifiedAt: now,
          presentAt: now,
          missingAt: null,
          lastProviderCheckedAt: now,
          lastErrorCode: null,
          lastErrorClass: null,
          version: { increment: 1 },
        },
      });
      if (objectUpdated.count !== 1) {
        throw new StorageConsistencyInvariantError('manual relocate object CAS lost');
      }
      const operationUpdated = await tx.storageObjectOperation.updateMany({
        where: {
          ...storageFenceWhere(locked),
          leaseExpiresAt: { not: null, gt: now },
        },
        data: terminalSucceededData(now, 'provider_present'),
      });
      if (operationUpdated.count !== 1) {
        throw new StorageConsistencyLeaseLostError(locked.id, locked.leaseGeneration);
      }
    });
  }

  private async collectEvidence(
    object: StorageObject,
    locator: StorageObjectLocator,
    onProgress: () => Promise<void>,
  ): Promise<ManualRelocationEvidence> {
    const firstHead = await this.pinnedProvider().headObjectAt(
      locator,
      object.key,
      MANUAL_STORAGE_MAINTENANCE,
    );
    if (!firstHead.exists) throw new StorageCandidateNotFoundError();
    assertExpectedSizeMatchesHead(object, firstHead);

    if (object.checksum === null) {
      const evidence = { key: object.key, head: firstHead, hash: null };
      this.assertEvidence(object, evidence);
      return evidence;
    }
    requireSha256Hex(object.checksum, 'stored checksum');
    const hash = await this.pinnedProvider().hashObjectSha256At(
      locator,
      object.key,
      onProgress,
      MANUAL_STORAGE_MAINTENANCE,
    );
    const finalHead = await this.pinnedProvider().headObjectAt(
      locator,
      object.key,
      MANUAL_STORAGE_MAINTENANCE,
    );
    if (!finalHead.exists) throw new StorageCandidateNotFoundError();
    const evidence = { key: object.key, head: finalHead, hash };
    this.assertEvidence(object, evidence);
    return evidence;
  }

  private assertEvidence(object: StorageObject, evidence: ManualRelocationEvidence): void {
    if (evidence.key !== object.key || !evidence.head.exists) {
      throw new StorageConsistencyInvariantError('manual relocate evidence identity drifted');
    }
    assertExpectedSizeMatchesHead(object, evidence.head);
    if (object.checksum !== null) {
      const expectedChecksum = requireSha256Hex(object.checksum, 'stored checksum');
      if (!evidence.hash) {
        throw new StorageConsistencyInvariantError('manual relocate lacks streamed checksum');
      }
      const actualChecksum = requireSha256Hex(evidence.hash.checksum, 'provider checksum');
      if (object.expectedSize !== bigintSize(evidence.hash.size)) {
        throw new StorageObjectIntegrityMismatchError('streamed object size mismatch');
      }
      if (actualChecksum !== expectedChecksum) {
        throw new StorageObjectIntegrityMismatchError('streamed object checksum mismatch');
      }
      if (
        evidence.hash.etag !== undefined &&
        evidence.head.etag !== undefined &&
        evidence.hash.etag !== evidence.head.etag
      ) {
        throw new StorageObjectIntegrityMismatchError(
          'object changed during streamed verification',
        );
      }
      // A trusted SHA-256 digest is content identity. ETag may legitimately change across a
      // reviewed locator copy and is used only as a same-read race check above.
      return;
    }
    if (object.etag === null) {
      throw new StorageConsistencyInvariantError(
        'manual relocate requires a trusted checksum or stored etag',
      );
    }
    if (evidence.head.etag === undefined) {
      throw new StorageConsistencyInvariantError('manual relocate target lacks etag evidence');
    }
    if (evidence.head.etag !== object.etag) {
      throw new StorageObjectIntegrityMismatchError('manual relocate target etag mismatch');
    }
  }

  private pinnedProvider(): PinnedStorageProvider {
    if (!isPinnedStorageProvider(this.provider)) {
      throw new StoragePinnedLocatorError('STORAGE_PROVIDER 未实现 pinned locator methods');
    }
    return this.provider;
  }
}

interface ManualRelocationEvidence {
  key: string;
  head: HeadObjectResult;
  hash: StorageObjectSha256Result | null;
}

const MANUAL_STORAGE_MAINTENANCE: StoragePinnedOperationOptions = {
  maintenance: true,
};
