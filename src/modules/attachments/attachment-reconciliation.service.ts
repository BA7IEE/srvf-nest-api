import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type StorageObject } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { STORAGE_PROVIDER } from '../storage/storage.constants';
import type { StorageProvider } from '../storage/storage.interface';
import {
  StorageObjectLedgerService,
  storageFenceWhere,
} from '../storage/storage-object-ledger.service';
import { toStorageJson } from '../storage/storage-operation-payload';
import {
  STORAGE_OPERATION_PAYLOAD_VERSION,
  type ClaimedStorageOperationWithObject,
  StorageConsistencyInvariantError,
  StorageConsistencyLeaseLostError,
  bigintSize,
  storageRequestHash,
} from '../storage/storage-consistency.types';
import type { HeadObjectResult, StorageObjectLocator } from '../storage/storage.types';
import { AttachmentContentValidator } from './attachment-content-validator';
import {
  StorageProviderDeleteStillPresentError,
  assertHeadMatchesObject,
  requireSafeSize,
  requireString,
  terminalSucceededData,
} from './attachment-storage-invariants';
import {
  locatorForObject,
  locatorMatchesOrCompletesBackfill,
  pinnedProviderOf,
  storageLocatorData,
} from './attachment-storage-locator';

/*
 * 存储对账与回填(Phase 6-B 第四域第六刀)。
 *
 * 这一族回答的是同一个问题的不同分支:**账实是否相符,不符时往哪个终态收敛**。
 *   - backfill:历史对象没有固定 locator,探测到实体后把它固定下来(available)
 *   - reconcile:上传/删除留下的悬挂态(unbound / orphan)向 absent 收敛
 * 与 upload(建账)、delete(销账)是不同职责:那两族改变意图,本族只让事实与账目对齐。
 *
 * ⚠️ 每个 finalize* / promote* 都自开事务并在事务内 CAS ——
 * `updateMany({ where: { …当时读到的态 } })` 的 count 必须为 1,否则说明状态在读与写之间
 * 被别人改过,此时**必须放弃而不是重试写入**(重试会把别人的终态覆盖掉)。
 * 那些 `count !== 1 → throw` 不是防御性代码,是这一族的核心不变量。
 *
 * ⚠️ 本族被 upload 族跨族调用(executeUploadVerify → transitionUploadVerifyToOrphan /
 * finalizeUnboundAbsent):上传验证失败时把对象交给对账收敛。方向是单向的
 * (upload → reconciliation),不要反向引用 upload 族的任何东西。
 */
@Injectable()
export class AttachmentReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: StorageObjectLedgerService,
    private readonly contentValidator: AttachmentContentValidator,
    @Inject(STORAGE_PROVIDER) private readonly provider: StorageProvider,
  ) {}

  async reconcileRolloutAttachments(limit = 100): Promise<number> {
    if (this.ledger.isStrictMode()) return 0;
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        key: string;
        size: number;
        mime: string;
        etag: string | null;
        checksum: string | null;
        createdAt: Date;
      }>
    >(Prisma.sql`
      SELECT a."id", a."key", a."size", a."mime", a."etag", a."checksum", a."createdAt"
      FROM "attachments" a
      LEFT JOIN "storage_objects" o ON o."key" = a."key"
      WHERE o."id" IS NULL
      ORDER BY a."createdAt" ASC
      LIMIT ${Math.min(Math.max(limit, 1), 500)}
    `);
    if (rows.length === 0) return 0;
    for (const row of rows) await this.ledger.ensureRuntimeBackfill(row);
    return rows.length;
  }

  async executeBackfillVerify(operation: ClaimedStorageOperationWithObject): Promise<void> {
    const object = operation.storageObject;
    if (object.resourceType !== 'attachment' || !object.resourceId) {
      throw new StorageConsistencyInvariantError('backfill object has no Attachment link');
    }
    const attachment = await this.prisma.attachment.findUnique({
      where: { id: object.resourceId },
      select: { id: true, key: true },
    });
    if (!attachment || attachment.key !== object.key) {
      throw new StorageConsistencyInvariantError('backfill Attachment link is stale');
    }
    const locator = await locatorForObject(this.ledger, this.provider, object);
    const current = await this.ledger.renewLease(operation);
    let head: HeadObjectResult;
    try {
      head = await this.contentValidator.validateFromObjectAt(locator, {
        key: object.key,
        mime: requireString(object.expectedMime, 'expectedMime'),
        size: requireSafeSize(object.expectedSize),
      });
    } catch (error) {
      if (isAttachmentNotFound(error)) {
        await this.ledger.noteBackfillCandidateAbsentClaimed(current, error);
      } else {
        await this.ledger.noteBackfillReadFailureClaimed(current, error);
      }
      throw error;
    }
    await this.finalizeBackfillAvailable(current, locator, head);
  }

  async executeOrphanDelete(operation: ClaimedStorageOperationWithObject): Promise<void> {
    const object = operation.storageObject;
    if (
      (object.source !== 'attachment_signed_upload' && object.source !== 'attachment_legacy') ||
      object.resourceId !== null ||
      object.state !== 'delete_pending' ||
      !object.unboundExpiresAt ||
      object.unboundExpiresAt.getTime() > Date.now()
    ) {
      throw new StorageConsistencyInvariantError('orphan delete safety gate rejected');
    }
    const locator = await locatorForObject(this.ledger, this.provider, object);
    let current = await this.ledger.renewLease(operation);
    let head = await pinnedProviderOf(this.provider).headObjectAt(locator, object.key);
    if (!head.exists) {
      await this.finalizeOrphanAbsent(current);
      return;
    }
    await this.ledger.markEffectState(current, 'effect_started');
    let deleteError: unknown = null;
    try {
      await pinnedProviderOf(this.provider).deleteObjectAt(locator, object.key);
    } catch (error) {
      deleteError = error;
    }
    current = await this.ledger.renewLease(current);
    head = await pinnedProviderOf(this.provider).headObjectAt(locator, object.key);
    if (!head.exists) {
      await this.finalizeOrphanAbsent(current);
      return;
    }
    throw deleteError instanceof Error ? deleteError : new StorageProviderDeleteStillPresentError();
  }

  async transitionUploadVerifyToOrphan(
    operation: ClaimedStorageOperationWithObject,
  ): Promise<void> {
    const now = new Date();
    const requestHash = storageRequestHash({
      kind: 'orphan_delete',
      objectId: operation.storageObjectId,
    });
    await this.prisma.$transaction(async (tx) => {
      const current = await this.ledger.lockClaimedForUpdate(tx, operation, { now });
      if (
        current.kind !== 'attachment_upload_verify' ||
        current.storageObject.resourceId !== null ||
        current.storageObject.state !== 'present_unbound' ||
        !current.storageObject.unboundExpiresAt ||
        current.storageObject.unboundExpiresAt.getTime() > now.getTime()
      ) {
        throw new StorageConsistencyInvariantError('orphan transition locked state rejected');
      }
      const objectUpdated = await tx.storageObject.updateMany({
        where: {
          id: current.storageObjectId,
          state: 'present_unbound',
          resourceId: null,
        },
        data: {
          state: 'delete_pending',
          deleteRequestedAt: now,
          version: { increment: 1 },
        },
      });
      if (objectUpdated.count !== 1) {
        throw new StorageConsistencyInvariantError('orphan object transition lost');
      }
      const updated = await tx.storageObjectOperation.updateMany({
        where: {
          ...storageFenceWhere(current),
          leaseExpiresAt: { not: null, gt: now },
        },
        data: terminalSucceededData(now, 'provider_present'),
      });
      if (updated.count !== 1) {
        throw new StorageConsistencyLeaseLostError(current.id, current.leaseGeneration);
      }
      await tx.storageObjectOperation.create({
        data: {
          eventKey: `storage.orphan-delete:${current.storageObjectId}`,
          storageObjectId: current.storageObjectId,
          replayOfId: current.id,
          kind: 'orphan_delete',
          status: 'pending',
          effectState: 'not_started',
          payloadVersion: STORAGE_OPERATION_PAYLOAD_VERSION,
          payload: toStorageJson({}),
          requestHash,
          availableAt: now,
        },
      });
    });
  }

  async finalizeUnboundAbsent(operation: ClaimedStorageOperationWithObject): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const current = await this.ledger.lockClaimedForUpdate(tx, operation, { now });
      if (
        current.kind !== 'attachment_upload_verify' ||
        current.storageObject.resourceId !== null ||
        !['pending_upload', 'present_unbound', 'provider_unknown'].includes(
          current.storageObject.state,
        ) ||
        !current.storageObject.unboundExpiresAt ||
        current.storageObject.unboundExpiresAt.getTime() > now.getTime()
      ) {
        throw new StorageConsistencyInvariantError('unbound absent locked state rejected');
      }
      const objectUpdated = await tx.storageObject.updateMany({
        where: {
          id: current.storageObjectId,
          state: current.storageObject.state,
          resourceId: null,
        },
        data: {
          state: 'absent',
          absentAt: now,
          lastProviderCheckedAt: now,
          version: { increment: 1 },
        },
      });
      if (objectUpdated.count !== 1) {
        throw new StorageConsistencyInvariantError('unbound absent object CAS lost');
      }
      const operationUpdated = await tx.storageObjectOperation.updateMany({
        where: {
          ...storageFenceWhere(current),
          leaseExpiresAt: { not: null, gt: now },
        },
        data: terminalSucceededData(now, 'provider_absent'),
      });
      if (operationUpdated.count !== 1) {
        throw new StorageConsistencyLeaseLostError(current.id, current.leaseGeneration);
      }
    });
  }

  async finalizeBackfillAvailable(
    operation: ClaimedStorageOperationWithObject,
    locator: StorageObjectLocator,
    head: HeadObjectResult,
  ): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const current = await this.ledger.lockClaimedForUpdate(tx, operation, { now });
      if (
        current.kind !== 'backfill_verify' ||
        current.storageObject.source !== 'backfill' ||
        current.storageObject.resourceType !== 'attachment' ||
        current.storageObject.resourceId === null ||
        !['legacy_unverified', 'provider_unknown'].includes(current.storageObject.state) ||
        current.storageObject.deleteRequestedAt !== null ||
        !locatorMatchesOrCompletesBackfill(current.storageObject, locator)
      ) {
        throw new StorageConsistencyInvariantError('backfill available locked state rejected');
      }
      assertHeadMatchesObject(current.storageObject, head);
      const objectUpdated = await tx.storageObject.updateMany({
        where: {
          id: current.storageObjectId,
          state: current.storageObject.state,
          source: 'backfill',
          deleteRequestedAt: null,
        },
        data: {
          state: 'available',
          ...storageLocatorData(locator),
          actualSize: head.size === undefined ? undefined : bigintSize(head.size),
          actualMime: head.contentType,
          etag: head.etag,
          verifiedAt: now,
          presentAt: now,
          lastProviderCheckedAt: now,
          lastErrorCode: null,
          lastErrorClass: null,
          version: { increment: 1 },
        },
      });
      if (objectUpdated.count !== 1) {
        throw new StorageConsistencyInvariantError('backfill available object CAS lost');
      }
      const operationUpdated = await tx.storageObjectOperation.updateMany({
        where: {
          ...storageFenceWhere(current),
          leaseExpiresAt: { not: null, gt: now },
        },
        data: terminalSucceededData(now, 'provider_present'),
      });
      if (operationUpdated.count !== 1) {
        throw new StorageConsistencyLeaseLostError(current.id, current.leaseGeneration);
      }
    });
  }

  async finalizeOrphanAbsent(operation: ClaimedStorageOperationWithObject): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const current = await this.ledger.lockClaimedForUpdate(tx, operation, { now });
      if (
        current.kind !== 'orphan_delete' ||
        current.storageObject.resourceId !== null ||
        current.storageObject.state !== 'delete_pending' ||
        !current.storageObject.unboundExpiresAt ||
        current.storageObject.unboundExpiresAt.getTime() > now.getTime()
      ) {
        throw new StorageConsistencyInvariantError('orphan absent locked state rejected');
      }
      const objectUpdated = await tx.storageObject.updateMany({
        where: {
          id: current.storageObjectId,
          state: 'delete_pending',
          resourceId: null,
        },
        data: {
          state: 'absent',
          absentAt: now,
          lastProviderCheckedAt: now,
          lastErrorCode: null,
          lastErrorClass: null,
          version: { increment: 1 },
        },
      });
      if (objectUpdated.count !== 1) {
        throw new StorageConsistencyInvariantError('orphan absent object CAS lost');
      }
      const operationUpdated = await tx.storageObjectOperation.updateMany({
        where: {
          ...storageFenceWhere(current),
          leaseExpiresAt: { not: null, gt: now },
        },
        data: terminalSucceededData(now, 'effect_succeeded'),
      });
      if (operationUpdated.count !== 1) {
        throw new StorageConsistencyLeaseLostError(current.id, current.leaseGeneration);
      }
    });
  }

  async promoteBackfillAvailable(
    object: StorageObject,
    locator: StorageObjectLocator,
    head: HeadObjectResult,
  ): Promise<boolean> {
    if (object.resourceType !== 'attachment' || object.resourceId === null) {
      throw new StorageConsistencyInvariantError('candidate object has no Attachment resource');
    }
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "storage_objects"
        WHERE "id" = ${object.id}
        FOR UPDATE
      `);
      const current = await tx.storageObject.findUnique({ where: { id: object.id } });
      if (
        !current ||
        current.resourceType !== 'attachment' ||
        current.resourceId !== object.resourceId ||
        current.deleteRequestedAt !== null ||
        !['legacy_unverified', 'provider_unknown', 'available'].includes(current.state) ||
        !locatorMatchesOrCompletesBackfill(current, locator)
      ) {
        return false;
      }
      const activeOperations = await tx.$queryRaw<Array<{ id: string; kind: string }>>(Prisma.sql`
        SELECT "id", "kind" FROM "storage_object_operations"
        WHERE "storageObjectId" = ${current.id}
          AND "status" IN ('pending', 'processing')
        ORDER BY "id"
        FOR UPDATE
      `);
      if (activeOperations.length > 1) {
        throw new StorageConsistencyInvariantError('multiple active storage operations');
      }
      if (activeOperations[0] && activeOperations[0].kind !== 'backfill_verify') {
        return false;
      }
      assertHeadMatchesObject(current, head);
      if (current.state !== 'available') {
        const promoted = await tx.storageObject.updateMany({
          where: {
            id: current.id,
            state: { in: ['legacy_unverified', 'provider_unknown'] },
            deleteRequestedAt: null,
          },
          data: {
            state: 'available',
            ...storageLocatorData(locator),
            actualSize: head.size === undefined ? undefined : bigintSize(head.size),
            actualMime: head.contentType,
            etag: head.etag,
            verifiedAt: now,
            presentAt: now,
            lastProviderCheckedAt: now,
            lastErrorCode: null,
            lastErrorClass: null,
            version: { increment: 1 },
          },
        });
        if (promoted.count !== 1) return false;
      }
      if (activeOperations[0]) {
        const completed = await tx.storageObjectOperation.updateMany({
          where: {
            id: activeOperations[0].id,
            kind: 'backfill_verify',
            status: { in: ['pending', 'processing'] },
          },
          data: terminalSucceededData(now, 'provider_present'),
        });
        if (completed.count !== 1) {
          throw new StorageConsistencyInvariantError('active backfill completion lost');
        }
      }
      return true;
    });
  }
}

function isAttachmentNotFound(error: unknown): boolean {
  return error instanceof BizException && error.biz === BizCode.ATTACHMENT_NOT_FOUND;
}
