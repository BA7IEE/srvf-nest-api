import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type StorageObject, type StorageObjectOperation } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { STORAGE_PROVIDER } from '../storage/storage.constants';
import { type StorageProvider } from '../storage/storage.interface';
import {
  storageFenceWhere,
  StorageObjectLedgerService,
} from '../storage/storage-object-ledger.service';
import {
  toStorageJson,
  parseStorageOperationPayload,
  sanitizeDeletePayloadAfterTerminal,
  type AttachmentDeleteOperationPayload,
  type AttachmentDeleteReplayResponse,
  type ManualStorageOperationPayload,
} from '../storage/storage-operation-payload';
import {
  storageOwnerUploadEventKeyPrefix,
  StorageConsistencyLeaseLostError,
  STORAGE_OPERATION_PAYLOAD_VERSION,
  STORAGE_ATTACHMENT_UPLOAD_EVENT_PREFIX,
  STORAGE_DELETE_REPLAY_TTL_MS,
  type ClaimedStorageOperationWithObject,
  StorageConsistencyInvariantError,
  storageLocatorFromObject,
  storageRequestHash,
  type StorageOperationKind,
} from '../storage/storage-consistency.types';
import type {
  HeadObjectResult,
  StorageObjectLocator,
  UploadUrlResult,
} from '../storage/storage.types';
import { AttachmentAuditRecorder } from './attachment-audit-recorder';
import { lockContentDeleteFinalizationBoundary } from './attachment-content-delete-boundary';
import { AttachmentReconciliationService } from './attachment-reconciliation.service';
import { AttachmentUploadService } from './attachment-upload.service';
import { locatorForObject, pinnedProviderOf } from './attachment-storage-locator';
import { AttachmentContentValidator } from './attachment-content-validator';
import { AttachmentManualAttestService } from './attachment-manual-attest.service';
import { AttachmentManualIntakeService } from './attachment-manual-intake.service';
import { AttachmentManualRelocateService } from './attachment-manual-relocate.service';
import {
  terminalSucceededData,
  assertHeadMatchesObject,
  activeOperations,
  StorageCandidateNotFoundError,
  StorageObjectIntegrityMismatchError,
  StorageProviderDeleteStillPresentError,
  safeNumber,
} from './attachment-storage-invariants';
import {
  deleteAuditEnvelope,
  type AttachmentDeleteReplay,
  type AttachmentUploadStorageIdentity,
  type ContentAttachmentReferenceBoundaryInput,
  type ContentPublishStorageBoundaryInput,
  type FinalizeAttachmentStorageUploadInput,
  type PrepareManualStorageAttestAbsentInput,
  type PrepareManualStorageRelocateInput,
  type PrepareAttachmentDeleteInput,
  type PreparedAttachmentStorageUpload,
} from './attachment-storage.types';
import { attachmentSelect, type SafeAttachment } from './attachments.select';

/*
 * Storage-consistency lock-order ledger (rows are lock/write order, never call order):
 *
 * | Methods | Required order |
 * | --- | --- |
 * | prepareUpload, ensureRuntimeBackfill | new StorageObject -> new Operation |
 * | verifyUpload/recordPresentUnbound, noteProviderUnknown | StorageObject -> Operation |
 * | finalizeUpload (legacy/confirm) | active Owner -> StorageObject -> upload Operation -> active orphan Operations -> new Attachment |
 * | prepareDelete | (Content root for content owners) -> Attachment -> StorageObject -> active Operations |
 * | AttachmentsService.update | Attachment -> StorageObject |
 * | finalizeAttachmentDelete | (Content root for content owners) -> Attachment -> StorageObject -> claimed delete Operation |
 * | prepareManualOperation | StorageObject -> original/event/active Operations (sorted id) |
 * | finalizeManualAttestedDelete | (Content root for content owners) -> Attachment -> StorageObject -> original/manual Operations |
 * | executeManualRelocate | StorageObject -> claimed manual Operation |
 * | transitionUploadVerifyToOrphan | StorageObject -> upload Operation -> new orphan Operation |
 * | finalizeUnboundAbsent/finalizeBackfillAvailable/finalizeOrphanAbsent | StorageObject -> Operation |
 * | refreshClaimed, recordPresentUnboundClaimed, backfill read/absent notes, nack, deadLetter | StorageObject -> Operation |
 * | promoteBackfillAvailable (download JIT) | StorageObject -> active Operations (sorted id) |
 * | claim exhausted-processing | all StorageObjects (sorted id) -> all Operations (sorted id) |
 * | claim normal, renewLease, markEffectState, ack, purge replay | Operation only |
 * | download final linearization, markMissing/markIntegrityMismatch, noteAvailableHead | StorageObject only |
 *
 * Claimed dual-table paths must use lockClaimedForUpdate and reread under these locks. A path
 * involving an existing Attachment must never acquire Attachment after Object/Operation.
 */
@Injectable()
export class AttachmentStorageOrchestrator {
  private readonly inlineWorkerId = `attachment-storage-http:${process.pid}:${randomUUID()}`;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: StorageObjectLedgerService,
    private readonly contentValidator: AttachmentContentValidator,
    private readonly auditRecorder: AttachmentAuditRecorder,
    private readonly manualRelocate: AttachmentManualRelocateService,
    private readonly manualIntake: AttachmentManualIntakeService,
    private readonly manualAttest: AttachmentManualAttestService,
    private readonly reconciliation: AttachmentReconciliationService,
    private readonly upload: AttachmentUploadService,
    @Inject(STORAGE_PROVIDER) private readonly provider: StorageProvider,
  ) {}

  /**
   * B6-only parser read. The caller cannot choose a key or a provider locator: both are derived
   * from the immutable internal attachment owner. `null` means the physical object no longer
   * matches its pinned metadata and must be mapped by the import contract to its mismatch code.
   */
  async readAttendanceImportPreviewBytesOutsideTransaction(input: {
    previewJobId: string;
    attachmentId: string;
    maxBytes: number;
  }): Promise<{ body: Buffer | null; actualSize: number | null }> {
    const attachment = await this.prisma.attachment.findFirst({
      where: {
        id: input.attachmentId,
        ownerType: 'attendance-import-preview',
        ownerId: input.previewJobId,
        mime: 'text/csv',
      },
      select: { id: true, key: true, size: true },
    });
    if (!attachment) throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    if (
      !Number.isSafeInteger(input.maxBytes) ||
      input.maxBytes < 0 ||
      attachment.size > input.maxBytes
    ) {
      return { body: null, actualSize: attachment.size };
    }
    const object = await this.prisma.storageObject.findUnique({ where: { key: attachment.key } });
    if (
      !object ||
      object.state !== 'available' ||
      object.resourceType !== 'attachment' ||
      object.resourceId !== attachment.id ||
      object.deleteRequestedAt !== null
    ) {
      throw new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING);
    }
    const objectSize = object.actualSize ?? object.expectedSize;
    const normalizedObjectSize = objectSize == null ? null : (safeNumber(objectSize) ?? null);
    if (normalizedObjectSize === null || normalizedObjectSize !== attachment.size) {
      return { body: null, actualSize: normalizedObjectSize };
    }
    const locator = await locatorForObject(this.ledger, this.provider, object);
    try {
      const head = await pinnedProviderOf(this.provider).headObjectAt(locator, attachment.key);
      if (!head.exists || head.size === undefined || head.size !== attachment.size) {
        return { body: null, actualSize: head.size ?? null };
      }
      const body = await pinnedProviderOf(this.provider).readObjectPrefixAt(
        locator,
        attachment.key,
        attachment.size,
      );
      if (body.length !== attachment.size) return { body: null, actualSize: body.length };
      return { body, actualSize: body.length };
    } catch {
      throw new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING);
    }
  }

  async lockContentPublishBoundary(
    tx: Prisma.TransactionClient,
    input: ContentPublishStorageBoundaryInput,
  ): Promise<void> {
    try {
      await this.lockContentPublishBoundaryUnsafe(tx, input);
    } catch (error) {
      if (
        error instanceof BizException &&
        error.biz === BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING
      ) {
        throw error;
      }
      // The public Content facade has one fail-closed storage contract. Raw invariant/Prisma
      // details must not escape or create a new externally observable error surface.
      throw new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING);
    }
  }

  /**
   * The caller holds the Content root. Lock only matching, currently owned Attachment rows and
   * reject a reference to an object whose durable delete lifecycle has started. Missing/foreign
   * placeholders remain ignored here so Content update keeps its historical draft semantics;
   * publish performs the complete binding validation.
   */
  async lockContentReferenceBoundary(
    tx: Prisma.TransactionClient,
    input: ContentAttachmentReferenceBoundaryInput,
  ): Promise<void> {
    const ids = [...new Set(input.referencedAttachmentIds)].sort();
    if (ids.length === 0) return;
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "attachments"
      WHERE "id" IN (${Prisma.join(ids)})
        AND "ownerId" = ${input.contentId}
        AND "ownerType" IN ('content-image', 'content-file')
      ORDER BY "id"
      FOR SHARE
    `);
    const attachments = await tx.attachment.findMany({
      where: {
        id: { in: ids },
        ownerId: input.contentId,
        ownerType: { in: ['content-image', 'content-file'] },
      },
      select: { id: true, key: true },
      orderBy: { id: 'asc' },
    });
    if (attachments.length === 0) return;
    const objects = await tx.storageObject.findMany({
      where: { key: { in: attachments.map((attachment) => attachment.key) } },
      select: {
        key: true,
        state: true,
        resourceType: true,
        resourceId: true,
        deleteRequestedAt: true,
      },
    });
    const objectByKey = new Map(objects.map((object) => [object.key, object]));
    for (const attachment of attachments) {
      const object = objectByKey.get(attachment.key);
      if (
        !object ||
        object.state !== 'available' ||
        object.resourceType !== 'attachment' ||
        object.resourceId !== attachment.id ||
        object.deleteRequestedAt !== null
      ) {
        throw new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING);
      }
    }
  }

  private async lockContentPublishBoundaryUnsafe(
    tx: Prisma.TransactionClient,
    input: ContentPublishStorageBoundaryInput,
  ): Promise<void> {
    const ownerPrefixes = [
      {
        ownerType: 'content-image',
        prefix: storageOwnerUploadEventKeyPrefix('content-image', input.contentId),
      },
      {
        ownerType: 'content-file',
        prefix: storageOwnerUploadEventKeyPrefix('content-file', input.contentId),
      },
    ] as const;
    const ownerless = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT op."id"
      FROM "storage_object_operations" op
      JOIN "storage_objects" obj ON obj."id" = op."storageObjectId"
      WHERE op."kind" = 'attachment_upload_verify'
        AND op."status" IN ('pending', 'processing', 'succeeded')
        AND obj."resourceId" IS NULL
        AND obj."state" IN ('pending_upload', 'present_unbound', 'provider_unknown')
        AND op."eventKey" LIKE ${`${STORAGE_ATTACHMENT_UPLOAD_EVENT_PREFIX}:%`}
        AND op."eventKey" NOT LIKE ${`${STORAGE_ATTACHMENT_UPLOAD_EVENT_PREFIX}:owner-v1:%`}
      LIMIT 1
    `);
    if (ownerless.length !== 0) throwStorageBoundaryUnsafe();

    const attachmentLocks = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "attachments"
      WHERE "ownerId" = ${input.contentId}
        AND "ownerType" IN ('content-image', 'content-file')
      ORDER BY "id"
      FOR UPDATE
    `);
    const attachmentIds = attachmentLocks.map((row) => row.id).sort();
    const attachments = await tx.attachment.findMany({
      where: {
        ownerId: input.contentId,
        ownerType: { in: ['content-image', 'content-file'] },
      },
      select: { id: true, key: true, ownerType: true, ownerId: true },
      orderBy: { id: 'asc' },
    });
    if (
      !sameSortedStrings(
        attachmentIds,
        attachments.map((row) => row.id),
      )
    ) {
      throwStorageBoundaryUnsafe();
    }

    const ownerIntentCandidates = await tx.storageObjectOperation.findMany({
      where: {
        kind: 'attachment_upload_verify',
        OR: ownerPrefixes.map(({ prefix }) => ({ eventKey: { startsWith: prefix } })),
      },
      select: { storageObjectId: true },
    });
    const attachmentKeys = attachments.map((row) => row.key);
    const candidateObjects = await tx.storageObject.findMany({
      where: {
        OR: [
          ...(attachmentKeys.length === 0 ? [] : [{ key: { in: attachmentKeys } }]),
          ...(ownerIntentCandidates.length === 0
            ? []
            : [
                {
                  id: {
                    in: ownerIntentCandidates.map((row) => row.storageObjectId),
                  },
                },
              ]),
        ],
      },
      select: { id: true },
    });
    const objectIds = [...new Set(candidateObjects.map((row) => row.id))].sort();
    if (objectIds.length > 0) {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "storage_objects"
        WHERE "id" IN (${Prisma.join(objectIds)})
        ORDER BY "id"
        FOR UPDATE
      `);
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "storage_object_operations"
        WHERE "storageObjectId" IN (${Prisma.join(objectIds)})
        ORDER BY "id"
        FOR UPDATE
      `);
    }

    const [currentAttachments, objects, operations, currentOwnerIntents] = await Promise.all([
      tx.attachment.findMany({
        where: {
          ownerId: input.contentId,
          ownerType: { in: ['content-image', 'content-file'] },
        },
        select: { id: true, key: true, ownerType: true, ownerId: true },
        orderBy: { id: 'asc' },
      }),
      objectIds.length === 0
        ? Promise.resolve([])
        : tx.storageObject.findMany({ where: { id: { in: objectIds } } }),
      objectIds.length === 0
        ? Promise.resolve([])
        : tx.storageObjectOperation.findMany({
            where: { storageObjectId: { in: objectIds } },
            orderBy: { id: 'asc' },
          }),
      tx.storageObjectOperation.findMany({
        where: {
          kind: 'attachment_upload_verify',
          OR: ownerPrefixes.map(({ prefix }) => ({ eventKey: { startsWith: prefix } })),
        },
        select: { id: true, storageObjectId: true },
      }),
    ]);
    if (
      !sameSortedStrings(
        attachmentIds,
        currentAttachments.map((row) => row.id),
      )
    ) {
      throwStorageBoundaryUnsafe();
    }
    if (currentOwnerIntents.some((operation) => !objectIds.includes(operation.storageObjectId))) {
      // A writer that did not serialize on the already-held Content root added a new intent after
      // candidate discovery. Fail closed; never acquire a late Object lock out of global order.
      throwStorageBoundaryUnsafe();
    }
    const lockedOperationIds = new Set(operations.map((operation) => operation.id));
    if (currentOwnerIntents.some((operation) => !lockedOperationIds.has(operation.id))) {
      // Do not trust an intent discovered after the related Operation lock set was frozen.
      throwStorageBoundaryUnsafe();
    }

    const objectByKey = new Map(objects.map((object) => [object.key, object]));
    const operationsByObject = new Map<string, StorageObjectOperation[]>();
    for (const operation of operations) {
      const rows = operationsByObject.get(operation.storageObjectId) ?? [];
      rows.push(operation);
      operationsByObject.set(operation.storageObjectId, rows);
    }
    const attachmentById = new Map(currentAttachments.map((row) => [row.id, row]));
    const attachmentByObjectId = new Map<string, (typeof currentAttachments)[number]>();
    for (const attachment of currentAttachments) {
      const object = objectByKey.get(attachment.key);
      if (
        !object ||
        object.state !== 'available' ||
        object.key !== attachment.key ||
        object.resourceType !== 'attachment' ||
        object.resourceId !== attachment.id ||
        object.deleteRequestedAt !== null
      ) {
        throwStorageBoundaryUnsafe();
      }
      if (activeOperations(operationsByObject.get(object.id) ?? []).length !== 0) {
        throwStorageBoundaryUnsafe();
      }
      attachmentByObjectId.set(object.id, attachment);
    }

    const referencedAttachmentIds = [...new Set(input.referencedAttachmentIds)].sort();
    for (const attachmentId of referencedAttachmentIds) {
      const attachment = attachmentById.get(attachmentId);
      if (!attachment || attachment.ownerType !== 'content-image') {
        throwStorageBoundaryUnsafe();
      }
    }
    const coverPairIsComplete =
      (input.coverAttachmentId === null) === (input.coverImageKey === null);
    if (!coverPairIsComplete) throwStorageBoundaryUnsafe();
    if (input.coverAttachmentId !== null && input.coverImageKey !== null) {
      const cover = attachmentById.get(input.coverAttachmentId);
      if (!cover || cover.ownerType !== 'content-image' || cover.key !== input.coverImageKey) {
        throwStorageBoundaryUnsafe();
      }
    }

    const now = new Date();
    for (const object of objects) {
      const objectOperations = operationsByObject.get(object.id) ?? [];
      const ownerUploadOperations = objectOperations.flatMap((operation) => {
        if (operation.kind !== 'attachment_upload_verify') return [];
        const owner = ownerPrefixes.find(({ prefix }) => operation.eventKey.startsWith(prefix));
        if (!owner) return [];
        if (operation.eventKey !== `${owner.prefix}${operation.requestHash}`) {
          throwStorageBoundaryUnsafe();
        }
        return [{ operation, ownerType: owner.ownerType }];
      });
      if (ownerUploadOperations.length === 0) continue;
      const boundAttachment = attachmentByObjectId.get(object.id);
      if (boundAttachment) {
        if (
          ownerUploadOperations.some(
            ({ ownerType, operation }) =>
              ownerType !== boundAttachment.ownerType ||
              operation.status !== 'succeeded' ||
              operation.effectState !== 'provider_present',
          )
        ) {
          throwStorageBoundaryUnsafe();
        }
        continue;
      }

      if (object.state === 'absent') {
        if (activeOperations(objectOperations).length !== 0) throwStorageBoundaryUnsafe();
        const finalizedAttachmentDelete = objectOperations.some(
          (operation) =>
            operation.kind === 'attachment_delete' &&
            operation.status === 'succeeded' &&
            operation.effectState === 'effect_succeeded',
        );
        const isOwnerlessReclaim = object.resourceType === null && object.resourceId === null;
        const isFinalizedAttachmentDelete =
          object.resourceType === 'attachment' &&
          object.resourceId !== null &&
          finalizedAttachmentDelete;
        if (!isOwnerlessReclaim && !isFinalizedAttachmentDelete) {
          throwStorageBoundaryUnsafe();
        }
        continue;
      }
      if (object.resourceType !== null || object.resourceId !== null) {
        throwStorageBoundaryUnsafe();
      }
      if (object.state === 'delete_pending') {
        const active = activeOperations(objectOperations);
        const orphan = active[0];
        const expectedOrphanRequestHash = storageRequestHash({
          kind: 'orphan_delete',
          objectId: object.id,
        });
        const replayedUpload = ownerUploadOperations.find(
          ({ operation }) => operation.id === orphan?.replayOfId,
        )?.operation;
        if (
          active.length !== 1 ||
          !orphan ||
          orphan.kind !== 'orphan_delete' ||
          orphan.eventKey !== `storage.orphan-delete:${object.id}` ||
          orphan.storageObjectId !== object.id ||
          orphan.requestHash !== expectedOrphanRequestHash ||
          !replayedUpload ||
          !['dead', 'succeeded'].includes(replayedUpload.status) ||
          !object.unboundExpiresAt ||
          orphan.availableAt.getTime() < object.unboundExpiresAt.getTime()
        ) {
          throwStorageBoundaryUnsafe();
        }
        parseStorageOperationPayload('orphan_delete', orphan.payloadVersion, orphan.payload);
        continue;
      }
      if (
        !['pending_upload', 'present_unbound', 'provider_unknown'].includes(object.state) ||
        object.deleteRequestedAt !== null ||
        !object.unboundExpiresAt ||
        (object.source !== 'attachment_signed_upload' && object.source !== 'attachment_legacy')
      ) {
        throwStorageBoundaryUnsafe();
      }
      const active = activeOperations(objectOperations);
      if (
        active.length !== 1 ||
        active[0]?.kind !== 'attachment_upload_verify' ||
        !ownerUploadOperations.some(({ operation }) => operation.id === active[0]?.id)
      ) {
        throwStorageBoundaryUnsafe();
      }
      const uploadOperation = active[0];
      const uploadPayload = parseStorageOperationPayload(
        'attachment_upload_verify',
        uploadOperation.payloadVersion,
        uploadOperation.payload,
      );
      if (!('source' in uploadPayload) || uploadPayload.source !== object.source) {
        throwStorageBoundaryUnsafe();
      }

      const objectUpdated = await tx.storageObject.updateMany({
        where: {
          id: object.id,
          state: object.state,
          resourceId: null,
          deleteRequestedAt: null,
        },
        data: {
          state: 'delete_pending',
          deleteRequestedAt: now,
          version: { increment: 1 },
        },
      });
      if (objectUpdated.count !== 1) throwStorageBoundaryUnsafe();
      const uploadUpdated = await tx.storageObjectOperation.updateMany({
        where: {
          id: uploadOperation.id,
          status: uploadOperation.status,
          storageObjectId: object.id,
          kind: 'attachment_upload_verify',
        },
        data: {
          status: 'dead',
          completedAt: now,
          deadAt: now,
          leaseOwner: null,
          leaseAcquiredAt: null,
          leaseRenewedAt: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          lastErrorClass: null,
        },
      });
      if (uploadUpdated.count !== 1) throwStorageBoundaryUnsafe();

      const orphanEventKey = `storage.orphan-delete:${object.id}`;
      const orphanRequestHash = storageRequestHash({
        kind: 'orphan_delete',
        objectId: object.id,
      });
      const availableAt =
        object.unboundExpiresAt.getTime() > now.getTime() ? object.unboundExpiresAt : now;
      const existingOrphan = objectOperations.find(
        (operation) => operation.eventKey === orphanEventKey,
      );
      if (existingOrphan) {
        if (
          existingOrphan.kind !== 'orphan_delete' ||
          existingOrphan.storageObjectId !== object.id ||
          existingOrphan.replayOfId !== uploadOperation.id ||
          existingOrphan.requestHash !== orphanRequestHash ||
          !['pending', 'processing'].includes(existingOrphan.status)
        ) {
          throwStorageBoundaryUnsafe();
        }
        if (existingOrphan.availableAt.getTime() < availableAt.getTime()) {
          await tx.storageObjectOperation.update({
            where: { id: existingOrphan.id },
            data: { availableAt },
          });
        }
      } else {
        await tx.storageObjectOperation.create({
          data: {
            eventKey: orphanEventKey,
            storageObjectId: object.id,
            replayOfId: uploadOperation.id,
            kind: 'orphan_delete',
            status: 'pending',
            effectState: 'not_started',
            payloadVersion: STORAGE_OPERATION_PAYLOAD_VERSION,
            payload: toStorageJson({}),
            requestHash: orphanRequestHash,
            availableAt,
          },
        });
      }
    }
  }

  async filterMetadataVisible<T extends { key: string }>(rows: readonly T[]): Promise<T[]> {
    if (rows.length === 0) return [];
    const keys = [...new Set(rows.map((row) => row.key))];
    const objects = await this.prisma.storageObject.findMany({ where: { key: { in: keys } } });
    const byKey = new Map(objects.map((object) => [object.key, object]));
    if (!this.ledger.isStrictMode()) {
      const missingKeys = keys.filter((key) => !byKey.has(key));
      if (missingKeys.length > 0) {
        const legacyRows = await this.prisma.attachment.findMany({
          where: { key: { in: missingKeys } },
          select: {
            id: true,
            key: true,
            size: true,
            mime: true,
            etag: true,
            checksum: true,
            createdAt: true,
          },
        });
        for (const row of legacyRows) {
          const object = await this.ledger.ensureRuntimeBackfill(row);
          if (object) byKey.set(row.key, object);
        }
      }
    }
    return rows.filter((row) => {
      const object = byKey.get(row.key);
      return object !== undefined && this.ledger.isReadableState(object.state);
    });
  }

  async isMetadataVisible(key: string): Promise<boolean> {
    return (await this.filterMetadataVisible([{ key }])).length === 1;
  }

  // 所有 Attachment resolver（含 content trusted key）统一先证明 Attachment 行 + ledger + HEAD。
  async resolveDownloadUrl(key: string, expiresIn: number): Promise<string | null> {
    const attachment = await this.prisma.attachment.findUnique({
      where: { key },
      select: {
        id: true,
        key: true,
        size: true,
        mime: true,
        etag: true,
        checksum: true,
        createdAt: true,
      },
    });
    if (!attachment) return null;
    let object = await this.ledger.findObjectByKey(key);
    if (!object) {
      if (this.ledger.isStrictMode()) return null;
      object = await this.ledger.ensureRuntimeBackfill(attachment);
    }
    if (!object || !this.ledger.isReadableState(object.state)) return null;

    let locator: StorageObjectLocator;
    try {
      locator = await locatorForObject(this.ledger, this.provider, object);
      const head = await pinnedProviderOf(this.provider).headObjectAt(locator, key);
      if (!head.exists) {
        if (object.state === 'available') await this.ledger.markMissing(object.id);
        else {
          await this.ledger.noteBackfillCandidateAbsent(
            object.id,
            null,
            new StorageCandidateNotFoundError(),
          );
        }
        return null;
      }
      assertHeadMatchesObject(object, head);
      if (object.state === 'available') {
        await this.ledger.noteAvailableHead(object.id, head);
      } else if (!(await this.reconciliation.promoteBackfillAvailable(object, locator, head))) {
        return null;
      }
      const result = await pinnedProviderOf(this.provider).generateDownloadUrlAt(locator, {
        key,
        expiresIn,
      });
      const linearized = await this.prisma.storageObject.updateMany({
        where: { id: object.id, state: 'available' },
        data: { lastProviderCheckedAt: new Date() },
      });
      if (linearized.count !== 1) return null;
      return result.url;
    } catch (error) {
      if (error instanceof StorageObjectIntegrityMismatchError && object.state === 'available') {
        await this.ledger.markIntegrityMismatch(object.id, error);
      } else {
        await this.ledger.noteReadFailure(object.id, error);
      }
      return null;
    }
  }

  async ensureAttachmentDeleteReady(attachmentId: string): Promise<void> {
    const attachment = await this.prisma.attachment.findUnique({
      where: { id: attachmentId },
      select: attachmentSelect,
    });
    if (!attachment) throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    const ensuredObject = await this.ensureLedgerForAttachment(attachment.id);
    try {
      // Delete never acts on a rollout candidate. Backfill must first prove presence and pin the
      // locator through its promotion transaction.
      storageLocatorFromObject(ensuredObject);
    } catch {
      throw new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING);
    }
  }

  async prepareDelete(input: PrepareAttachmentDeleteInput): Promise<string> {
    await this.ensureAttachmentDeleteReady(input.attachmentId);
    return this.prisma.$transaction((tx) => this.prepareDeleteInTransaction(tx, input));
  }

  async prepareDeleteInTransaction(
    tx: Prisma.TransactionClient,
    input: PrepareAttachmentDeleteInput,
  ): Promise<string> {
    // Global delete lock order: optional Content root (held by caller) -> Attachment ->
    // StorageObject -> involved Operations.
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "attachments" WHERE "id" = ${input.attachmentId} FOR UPDATE
    `);
    const current = await tx.attachment.findUnique({
      where: { id: input.attachmentId },
      select: attachmentSelect,
    });
    if (!current) {
      throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    }
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "storage_objects" WHERE "key" = ${current.key} FOR UPDATE
    `);
    const object = await tx.storageObject.findUnique({ where: { key: current.key } });
    if (!object || object.resourceType !== 'attachment' || object.resourceId !== current.id) {
      throw new StorageConsistencyInvariantError('delete object ledger disappeared or drifted');
    }
    try {
      storageLocatorFromObject(object);
    } catch {
      throw new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING);
    }
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "storage_object_operations"
      WHERE "storageObjectId" = ${object.id}
        AND "status" IN ('pending', 'processing')
      ORDER BY "id"
      FOR UPDATE
    `);
    const activeOperations = await tx.storageObjectOperation.findMany({
      where: { storageObjectId: object.id, status: { in: ['pending', 'processing'] } },
      orderBy: { id: 'asc' },
    });
    if (activeOperations.length > 1) {
      throw new StorageConsistencyInvariantError('multiple active delete operations');
    }
    const active = activeOperations[0];
    if (active) {
      if (active.kind !== 'attachment_delete') {
        throw new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING);
      }
      const activePayload = parseStorageOperationPayload(
        'attachment_delete',
        active.payloadVersion,
        active.payload,
      ) as AttachmentDeleteOperationPayload;
      if (activePayload.audit.actorUserId !== input.actorUserId && !input.allowAuthorizedJoin) {
        throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
      }
      return active.eventKey;
    }
    const now = new Date();
    const payload: AttachmentDeleteOperationPayload = {
      response: deleteReplayResponse(current),
      audit: deleteAuditEnvelope(input),
    };
    parseStorageOperationPayload('attachment_delete', STORAGE_OPERATION_PAYLOAD_VERSION, payload);
    const requestHash = storageRequestHash({
      kind: 'attachment_delete',
      payloadVersion: STORAGE_OPERATION_PAYLOAD_VERSION,
      attachmentId: current.id,
      storageObjectId: object.id,
      actorUserId: input.actorUserId,
    });
    const eventKey = `storage.attachment-delete:${requestHash}`;
    await tx.storageObject.update({
      where: { id: object.id },
      data: {
        state: 'delete_pending',
        deleteRequestedAt: now,
        lastErrorCode: null,
        lastErrorClass: null,
        version: { increment: 1 },
      },
    });
    await tx.storageObjectOperation.create({
      data: {
        eventKey,
        storageObjectId: object.id,
        kind: 'attachment_delete',
        status: 'pending',
        effectState: 'not_started',
        payloadVersion: STORAGE_OPERATION_PAYLOAD_VERSION,
        payload: toStorageJson(payload),
        requestHash,
        responseSnapshotExpiresAt: new Date(now.getTime() + STORAGE_DELETE_REPLAY_TTL_MS),
        createdAt: now,
        availableAt: now,
      },
    });
    return eventKey;
  }

  async getDeleteReplay(
    attachmentId: string,
    actorUserId: string,
    options: { allowAuthorizedJoin?: boolean } = {},
    now: Date = new Date(),
  ): Promise<AttachmentDeleteReplay | null> {
    const object = await this.ledger.findAttachmentObject(attachmentId);
    if (!object) return null;
    const operations = await this.prisma.storageObjectOperation.findMany({
      where: { storageObjectId: object.id, kind: 'attachment_delete' },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    for (const operation of operations) {
      const payload = parseStorageOperationPayload(
        'attachment_delete',
        operation.payloadVersion,
        operation.payload,
      ) as AttachmentDeleteOperationPayload;
      if (payload.audit.actorUserId !== actorUserId && !options.allowAuthorizedJoin) return null;
      if (
        operation.responseSnapshotExpiresAt === null ||
        operation.responseSnapshotExpiresAt.getTime() <= now.getTime() ||
        payload.response === null
      ) {
        return null;
      }
      if (operation.status === 'succeeded') {
        return { state: 'succeeded', eventKey: operation.eventKey, response: payload.response };
      }
      if (operation.status === 'dead') {
        return { state: 'dead', eventKey: operation.eventKey, response: null };
      }
      return { state: 'pending', eventKey: operation.eventKey, response: null };
    }
    return null;
  }

  // 上传链路薄委托:实现在 AttachmentUploadService。编排器是本模块对外唯一入口,
  // attachments.service 对这些方法有约 100 处调用,故保留同名 public 使调用面逐字不变。
  uploadRequestHash(
    identity: AttachmentUploadStorageIdentity,
    source: 'attachment_signed_upload' | 'attachment_legacy',
  ): string {
    return this.upload.uploadRequestHash(identity, source);
  }

  async prepareUpload(
    identity: AttachmentUploadStorageIdentity,
    source: 'attachment_signed_upload' | 'attachment_legacy',
    unboundExpiresAt: Date,
  ): Promise<PreparedAttachmentStorageUpload> {
    return this.upload.prepareUpload(identity, source, unboundExpiresAt);
  }

  async prepareUploadInTransaction(
    tx: Prisma.TransactionClient,
    identity: AttachmentUploadStorageIdentity,
    source: 'attachment_signed_upload' | 'attachment_legacy',
    unboundExpiresAt: Date,
    resolvedLocator?: StorageObjectLocator,
  ): Promise<PreparedAttachmentStorageUpload> {
    return this.upload.prepareUploadInTransaction(
      tx,
      identity,
      source,
      unboundExpiresAt,
      resolvedLocator,
    );
  }

  async resolveUploadLocatorForTransaction(key: string): Promise<StorageObjectLocator> {
    return this.upload.resolveUploadLocatorForTransaction(key);
  }

  validateUploadBufferOutsideTransaction(mime: string, buffer: Buffer): void {
    return this.upload.validateUploadBufferOutsideTransaction(mime, buffer);
  }

  async prepareUploadUrl(
    identity: AttachmentUploadStorageIdentity,
    unboundExpiresAt: Date,
    expiresIn: number,
  ): Promise<UploadUrlResult> {
    return this.upload.prepareUploadUrl(identity, unboundExpiresAt, expiresIn);
  }

  async verifyUploadEvidence(
    identity: AttachmentUploadStorageIdentity,
    source: 'attachment_signed_upload' | 'attachment_legacy',
  ): Promise<HeadObjectResult> {
    return this.upload.verifyUploadEvidence(identity, source);
  }

  async putUploadObjectAtAndVerifyOutsideTransaction(
    identity: AttachmentUploadStorageIdentity,
    source: 'attachment_legacy',
    locator: StorageObjectLocator,
    body: Buffer,
  ): Promise<HeadObjectResult> {
    return this.upload.putUploadObjectAtAndVerifyOutsideTransaction(
      identity,
      source,
      locator,
      body,
    );
  }

  async finalizeUpload(
    input: FinalizeAttachmentStorageUploadInput,
    head: HeadObjectResult,
  ): Promise<SafeAttachment> {
    return this.upload.finalizeUpload(input, head);
  }

  async finalizeUploadInTransaction(
    tx: Prisma.TransactionClient,
    input: FinalizeAttachmentStorageUploadInput,
    head: HeadObjectResult,
  ): Promise<SafeAttachment> {
    return this.upload.finalizeUploadInTransaction(tx, input, head);
  }

  // 对账侧薄委托:实现在 AttachmentReconciliationService。保留同名 public 方法,
  // 使 storage-consistency.worker 的调用面逐字不变(与 manual 族同一处理)。
  async reconcileRolloutAttachments(limit: number): Promise<number> {
    return this.reconciliation.reconcileRolloutAttachments(limit);
  }

  // 受理侧薄委托:实现在 AttachmentManualIntakeService。编排器保留同名 public 方法,
  // 因为它是本模块对外的入口与 kind 分发器 —— 调用面(storage-consistency-worker 与 e2e)因此不变。
  async prepareManualRelocate(input: PrepareManualStorageRelocateInput): Promise<string> {
    return this.manualIntake.prepareRelocate(input);
  }

  async prepareManualAttestAbsent(input: PrepareManualStorageAttestAbsentInput): Promise<string> {
    return this.manualIntake.prepareAttestAbsent(input);
  }

  async executeEventKey(eventKey: string): Promise<void> {
    const [operation] = await this.ledger.claim(this.inlineWorkerId, { limit: 1, eventKey });
    if (operation) await this.executeClaimed(operation);
  }

  async executeClaimed(operation: ClaimedStorageOperationWithObject): Promise<void> {
    let current: ClaimedStorageOperationWithObject;
    try {
      current = await this.ledger.refreshClaimed(operation);
    } catch (error) {
      if (error instanceof StorageConsistencyLeaseLostError) return;
      throw error;
    }
    let payload;
    try {
      payload = parseStorageOperationPayload(
        current.kind as StorageOperationKind,
        current.payloadVersion,
        current.payload,
      );
    } catch (error) {
      await this.ledger.deadLetter(current, error);
      return;
    }
    try {
      switch (current.kind) {
        case 'attachment_delete':
          await this.executeAttachmentDelete(current, payload as AttachmentDeleteOperationPayload);
          return;
        case 'attachment_upload_verify':
          await this.upload.executeUploadVerify(current);
          return;
        case 'backfill_verify':
          await this.reconciliation.executeBackfillVerify(current);
          return;
        case 'orphan_delete':
          await this.reconciliation.executeOrphanDelete(current);
          return;
        case 'manual_relocate':
          await this.manualRelocate.execute(current, payload as ManualStorageOperationPayload);
          return;
        case 'manual_attest_absent':
          await this.manualAttest.execute(current);
          return;
        default:
          await this.ledger.deadLetter(
            current,
            new StorageConsistencyInvariantError(`unsupported kind=${current.kind}`),
          );
      }
    } catch (error) {
      if (error instanceof StorageConsistencyLeaseLostError) return;
      await this.ledger.nack(current, error);
    }
  }

  private async executeAttachmentDelete(
    operation: ClaimedStorageOperationWithObject,
    payload: AttachmentDeleteOperationPayload,
  ): Promise<void> {
    const locator = await locatorForObject(this.ledger, this.provider, operation.storageObject);
    let current = await this.ledger.renewLease(operation);
    let head = await pinnedProviderOf(this.provider).headObjectAt(
      locator,
      operation.storageObject.key,
    );
    if (!head.exists) {
      await this.finalizeAttachmentDelete(current, payload);
      return;
    }

    await this.ledger.markEffectState(current, 'effect_started');
    let deleteError: unknown = null;
    try {
      await pinnedProviderOf(this.provider).deleteObjectAt(locator, operation.storageObject.key);
    } catch (error) {
      deleteError = error;
    }
    current = await this.ledger.renewLease(current);
    head = await pinnedProviderOf(this.provider).headObjectAt(locator, operation.storageObject.key);
    if (!head.exists) {
      await this.finalizeAttachmentDelete(current, payload);
      return;
    }
    throw deleteError instanceof Error ? deleteError : new StorageProviderDeleteStillPresentError();
  }

  private async finalizeAttachmentDelete(
    operation: ClaimedStorageOperationWithObject,
    payload: AttachmentDeleteOperationPayload,
  ): Promise<void> {
    const candidateAttachmentId = operation.storageObject.resourceId ?? payload.response?.id;
    if (!candidateAttachmentId || operation.storageObject.resourceType !== 'attachment') {
      throw new StorageConsistencyInvariantError('delete object has no Attachment resource');
    }
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      // 全局删除锁序：content owner 先 Content root，再 Attachment → StorageObject → Operations。
      await lockContentDeleteFinalizationBoundary(tx, payload.response, candidateAttachmentId);
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "attachments"
        WHERE "id" = ${candidateAttachmentId}
        FOR UPDATE
      `);
      const current = await this.ledger.lockClaimedForUpdate(tx, operation, { now });
      if (
        current.kind !== 'attachment_delete' ||
        current.storageObject.resourceType !== 'attachment' ||
        !['delete_pending', 'delete_failed'].includes(current.storageObject.state)
      ) {
        throw new StorageConsistencyInvariantError('delete finalize state rejected');
      }
      const currentPayload = parseStorageOperationPayload(
        'attachment_delete',
        current.payloadVersion,
        current.payload,
      ) as AttachmentDeleteOperationPayload;
      const attachmentId = current.storageObject.resourceId ?? currentPayload.response?.id;
      if (!attachmentId || attachmentId !== candidateAttachmentId) {
        throw new StorageConsistencyInvariantError('delete Attachment identity drifted');
      }
      const attachment = await tx.attachment.findUnique({
        where: { id: attachmentId },
        select: attachmentSelect,
      });
      if (!attachment || attachment.key !== current.storageObject.key) {
        throw new StorageConsistencyInvariantError('attachment disappeared before atomic finalize');
      }
      // eslint-disable-next-line no-restricted-syntax -- 上传失败回滚:附件记录尚未对外可见,物理删除是补偿事务的一部分,不留软删墓碑
      await tx.attachment.delete({ where: { id: attachment.id } });
      await this.auditRecorder.logDelete({
        attachmentId: attachment.id,
        before: attachment,
        actorUserId: currentPayload.audit.actorUserId,
        actorRoleSnap: currentPayload.audit.actorRoleSnap,
        scope: currentPayload.audit.scope,
        deletedByPath: currentPayload.audit.deletedByPath,
        auditMeta: {
          requestId: currentPayload.audit.requestId,
          ip: currentPayload.audit.ip,
          ua: currentPayload.audit.ua,
        },
        tx,
      });
      const objectUpdated = await tx.storageObject.updateMany({
        where: {
          id: current.storageObjectId,
          state: current.storageObject.state,
          resourceType: 'attachment',
          resourceId: attachment.id,
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
        throw new StorageConsistencyInvariantError('delete object finalize CAS lost');
      }
      const operationUpdated = await tx.storageObjectOperation.updateMany({
        where: {
          ...storageFenceWhere(current),
          leaseExpiresAt: { not: null, gt: now },
        },
        data: {
          ...terminalSucceededData(now, 'effect_succeeded'),
          payload: toStorageJson(sanitizeDeletePayloadAfterTerminal(currentPayload)),
        },
      });
      if (operationUpdated.count !== 1) {
        throw new StorageConsistencyLeaseLostError(current.id, current.leaseGeneration);
      }
    });
  }

  private async ensureLedgerForAttachment(attachmentId: string): Promise<StorageObject> {
    const existing = await this.ledger.findAttachmentObject(attachmentId);
    if (existing) return existing;
    if (this.ledger.isStrictMode()) {
      throw new StorageConsistencyInvariantError('STRICT Attachment missing storage ledger');
    }
    const attachment = await this.prisma.attachment.findUnique({
      where: { id: attachmentId },
      select: {
        id: true,
        key: true,
        size: true,
        mime: true,
        etag: true,
        checksum: true,
        createdAt: true,
      },
    });
    if (!attachment) throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    const object = await this.ledger.ensureRuntimeBackfill(attachment);
    if (!object) {
      throw new StorageConsistencyInvariantError('Attachment storage ledger could not be created');
    }
    return object;
  }
}

function sameSortedStrings(left: readonly string[], right: readonly string[]): boolean {
  const sortedRight = [...right].sort();
  return (
    left.length === sortedRight.length && left.every((value, index) => value === sortedRight[index])
  );
}

function throwStorageBoundaryUnsafe(): never {
  throw new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING);
}

function deleteReplayResponse(row: SafeAttachment): AttachmentDeleteReplayResponse {
  return {
    id: row.id,
    key: row.key,
    originalName: row.originalName,
    mime: row.mime,
    size: row.size,
    uploadedBy: row.uploadedBy,
    uploadedAt: row.uploadedAt.toISOString(),
    ownerType: row.ownerType,
    ownerId: row.ownerId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    description: null,
    accessLevel: null,
    tags: [],
    originalUploaderName: null,
    expireAt: null,
    accessUrl: null,
  };
}
