import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type StorageObject, type StorageObjectOperation } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { STORAGE_PROVIDER } from '../storage/storage.constants';
import {
  isPinnedStorageProvider,
  StoragePinnedLocatorError,
  type PinnedStorageProvider,
  type StorageProvider,
} from '../storage/storage.interface';
import {
  StorageObjectLedgerService,
  storageFenceWhere,
} from '../storage/storage-object-ledger.service';
import {
  parseStorageOperationPayload,
  sanitizeDeletePayloadAfterTerminal,
  toStorageJson,
  type AttachmentDeleteOperationPayload,
  type AttachmentDeleteReplayResponse,
  type ManualStorageOperationPayload,
} from '../storage/storage-operation-payload';
import {
  STORAGE_DELETE_REPLAY_TTL_MS,
  STORAGE_OPERATION_LEASE_MS,
  STORAGE_OPERATION_PAYLOAD_VERSION,
  type ClaimedStorageOperationWithObject,
  StorageConsistencyInvariantError,
  StorageConsistencyLeaseLostError,
  bigintSize,
  sameStorageLocator,
  storageLocatorFromObject,
  storageRequestHash,
  type StorageOperationKind,
} from '../storage/storage-consistency.types';
import type {
  HeadObjectResult,
  StorageObjectLocator,
  StorageObjectSha256Result,
  UploadUrlResult,
} from '../storage/storage.types';
import { AttachmentAuditRecorder } from './attachment-audit-recorder';
import { AttachmentContentValidator } from './attachment-content-validator';
import {
  deleteAuditEnvelope,
  type AttachmentDeleteReplay,
  type AttachmentUploadStorageIdentity,
  type FinalizeAttachmentStorageUploadInput,
  type PrepareManualStorageAttestAbsentInput,
  type PrepareManualStorageRelocateInput,
  type PrepareAttachmentDeleteInput,
  type PreparedAttachmentStorageUpload,
} from './attachment-storage.types';
import { attachmentSelect } from './attachments.select';

type SafeAttachment = Prisma.AttachmentGetPayload<{ select: typeof attachmentSelect }>;

interface ManualRelocationEvidence {
  key: string;
  head: HeadObjectResult;
  hash: StorageObjectSha256Result | null;
}

/*
 * Storage-consistency lock-order ledger (rows are lock/write order, never call order):
 *
 * | Methods | Required order |
 * | --- | --- |
 * | prepareUpload, ensureRuntimeBackfill | new StorageObject -> new Operation |
 * | verifyUpload/recordPresentUnbound, noteProviderUnknown | StorageObject -> Operation |
 * | finalizeUpload (legacy/confirm) | active Owner -> StorageObject -> upload Operation -> active orphan Operations -> new Attachment |
 * | prepareDelete | Attachment -> StorageObject -> active Operations |
 * | AttachmentsService.update | Attachment -> StorageObject |
 * | finalizeAttachmentDelete | Attachment -> StorageObject -> claimed delete Operation |
 * | prepareManualOperation | StorageObject -> original/event/active Operations (sorted id) |
 * | finalizeManualAttestedDelete | Attachment -> StorageObject -> original/manual Operations |
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
    @Inject(STORAGE_PROVIDER) private readonly provider: StorageProvider,
  ) {}

  uploadRequestHash(
    identity: AttachmentUploadStorageIdentity,
    source: 'attachment_signed_upload' | 'attachment_legacy',
  ): string {
    return storageRequestHash({ source, ...identity });
  }

  async prepareUpload(
    identity: AttachmentUploadStorageIdentity,
    source: 'attachment_signed_upload' | 'attachment_legacy',
    unboundExpiresAt: Date,
  ): Promise<PreparedAttachmentStorageUpload> {
    let locator: StorageObjectLocator;
    try {
      const existing = await this.ledger.findObjectByKey(identity.key);
      locator = existing
        ? storageLocatorFromObject(existing)
        : await this.pinnedProvider().getCurrentLocator();
    } catch {
      throw new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING);
    }
    const requestHash = this.uploadRequestHash(identity, source);
    const eventKey = `storage.attachment-upload-verify:${requestHash}`;
    const prepared = await this.ledger.prepareUpload({
      key: identity.key,
      source,
      locator,
      expectedSize: identity.size,
      expectedMime: identity.mime,
      unboundExpiresAt,
      eventKey,
      requestHash,
    });
    return {
      objectId: prepared.object.id,
      operationId: prepared.operation.id,
      eventKey,
      requestHash,
      locator,
    };
  }

  async prepareUploadUrl(
    identity: AttachmentUploadStorageIdentity,
    unboundExpiresAt: Date,
    expiresIn: number,
  ): Promise<UploadUrlResult> {
    const prepared = await this.prepareUpload(
      identity,
      'attachment_signed_upload',
      unboundExpiresAt,
    );
    try {
      return await this.pinnedProvider().generateUploadUrlAt(prepared.locator, {
        key: identity.key,
        contentType: identity.mime,
        sizeBytes: identity.size,
        expiresIn,
      });
    } catch {
      throw new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING);
    }
  }

  async verifyUpload(
    identity: AttachmentUploadStorageIdentity,
    source: 'attachment_signed_upload' | 'attachment_legacy',
  ): Promise<{ object: StorageObject; operation: StorageObjectOperation; head: HeadObjectResult }> {
    const requestHash = this.uploadRequestHash(identity, source);
    const object = await this.ledger.findObjectByKey(identity.key);
    if (!object || object.source !== source) throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    const operation = await this.prisma.storageObjectOperation.findFirst({
      where: {
        storageObjectId: object.id,
        kind: 'attachment_upload_verify',
        requestHash,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!operation) throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    parseStorageOperationPayload(
      'attachment_upload_verify',
      operation.payloadVersion,
      operation.payload,
    );

    if (object.state === 'available' && object.resourceId) {
      return {
        object,
        operation,
        head: {
          exists: true,
          size: safeNumber(object.actualSize ?? object.expectedSize),
          etag: object.etag ?? undefined,
          contentType: object.actualMime ?? object.expectedMime ?? undefined,
        },
      };
    }
    if (!['pending_upload', 'present_unbound', 'provider_unknown'].includes(object.state)) {
      throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    }
    const locator = await this.locatorForObject(object);
    try {
      const head = await this.contentValidator.validateFromObjectAt(locator, {
        key: identity.key,
        mime: identity.mime,
        size: identity.size,
      });
      await this.ledger.recordPresentUnbound(object.id, operation.id, head);
      return { object: await this.requireObject(object.id), operation, head };
    } catch (error) {
      if (!(error instanceof BizException)) {
        await this.ledger.noteProviderUnknown(object.id, operation.id, error);
        throw new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING);
      }
      throw error;
    }
  }

  async finalizeUpload(input: FinalizeAttachmentStorageUploadInput): Promise<SafeAttachment> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      // Polymorphic owner rows cannot be represented by a single FK. Lock the allowlisted owner
      // before the storage ledger so an owner soft-delete and Attachment bind have one order.
      await this.lockActiveUploadOwner(
        tx,
        input.identity.ownerType,
        input.ownerTable,
        input.identity.ownerId,
      );
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "storage_objects"
        WHERE "key" = ${input.identity.key}
        FOR UPDATE
      `);
      const object = await tx.storageObject.findUnique({ where: { key: input.identity.key } });
      if (!object) throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
      const operation = await tx.storageObjectOperation.findFirst({
        where: {
          storageObjectId: object.id,
          kind: 'attachment_upload_verify',
          requestHash: input.requestHash,
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!operation) throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "storage_object_operations"
        WHERE "id" = ${operation.id}
        FOR UPDATE
      `);
      const currentOperation = await tx.storageObjectOperation.findUnique({
        where: { id: operation.id },
      });
      if (
        !currentOperation ||
        currentOperation.kind !== 'attachment_upload_verify' ||
        currentOperation.storageObjectId !== object.id ||
        currentOperation.requestHash !== input.requestHash
      ) {
        throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
      }
      const currentUploadPayload = parseStorageOperationPayload(
        'attachment_upload_verify',
        currentOperation.payloadVersion,
        currentOperation.payload,
      );
      if (!('source' in currentUploadPayload) || currentUploadPayload.source !== object.source) {
        throw new StorageConsistencyInvariantError('upload operation source drifted');
      }
      const activeOrphans = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "storage_object_operations"
        WHERE "storageObjectId" = ${object.id}
          AND "kind" = 'orphan_delete'
          AND "status" IN ('pending', 'processing')
        ORDER BY "id"
        FOR UPDATE
      `);
      if (activeOrphans.length !== 0) {
        throw new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING);
      }

      if (
        object.state === 'available' &&
        object.resourceType === 'attachment' &&
        object.resourceId
      ) {
        if (
          currentOperation.status !== 'succeeded' ||
          currentOperation.effectState !== 'provider_present'
        ) {
          throw new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING);
        }
        const existing = await tx.attachment.findUnique({
          where: { id: object.resourceId },
          select: attachmentSelect,
        });
        if (!existing || !sameUploadIdentity(existing, input.identity)) {
          throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
        }
        return existing;
      }
      if (
        ['delete_pending', 'delete_failed', 'provider_unknown', 'integrity_mismatch'].includes(
          object.state,
        )
      ) {
        throw new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING);
      }
      if (currentOperation.status === 'dead') {
        throw new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING);
      }
      if (currentOperation.effectState !== 'provider_present') {
        throw new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING);
      }
      if (object.state !== 'present_unbound' || object.resourceId !== null) {
        throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
      }
      if (
        input.data.key !== input.identity.key ||
        input.data.ownerType !== input.identity.ownerType ||
        input.data.ownerId !== input.identity.ownerId ||
        input.data.originalName !== input.identity.originalName ||
        input.data.mime !== input.identity.mime ||
        input.data.size !== input.identity.size ||
        input.data.uploadedBy !== input.identity.uploadedByUserId
      ) {
        throw new StorageConsistencyInvariantError('Attachment create identity drifted');
      }

      const created = await tx.attachment.create({
        data: input.data,
        select: attachmentSelect,
      });
      await tx.storageObject.update({
        where: { id: object.id },
        data: {
          state: 'available',
          resourceType: 'attachment',
          resourceId: created.id,
          verifiedAt: now,
          presentAt: object.presentAt ?? now,
          checksum: typeof input.data.checksum === 'string' ? input.data.checksum : object.checksum,
          lastProviderCheckedAt: now,
          lastErrorCode: null,
          lastErrorClass: null,
          version: { increment: 1 },
        },
      });
      await tx.storageObjectOperation.update({
        where: { id: currentOperation.id },
        data: {
          status: 'succeeded',
          effectState: 'provider_present',
          completedAt: now,
          deadAt: null,
          leaseOwner: null,
          leaseAcquiredAt: null,
          leaseRenewedAt: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          lastErrorClass: null,
        },
      });
      const auditArgs = {
        created,
        actorUserId: input.identity.uploadedByUserId,
        actorRoleSnap: input.actorRoleSnap,
        scope: input.scope,
        ownerTable: input.ownerTable,
        auditMeta: input.auditMeta,
        tx,
      };
      if (input.auditKind === 'confirmed') {
        await this.auditRecorder.logUploadConfirmed(auditArgs);
      } else {
        await this.auditRecorder.logUpload(auditArgs);
      }
      return created;
    });
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
      locator = await this.locatorForObject(object);
      const head = await this.pinnedProvider().headObjectAt(locator, key);
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
      this.assertHeadMatchesObject(object, head);
      if (object.state === 'available') {
        await this.ledger.noteAvailableHead(object.id, head);
      } else if (!(await this.promoteBackfillAvailable(object, locator, head))) {
        return null;
      }
      const result = await this.pinnedProvider().generateDownloadUrlAt(locator, { key, expiresIn });
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

  async prepareDelete(input: PrepareAttachmentDeleteInput): Promise<string> {
    const attachment = await this.prisma.attachment.findUnique({
      where: { id: input.attachmentId },
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
    return this.prisma.$transaction(async (tx) => {
      // Global delete lock order: Attachment -> StorageObject -> involved Operations.
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "attachments" WHERE "id" = ${attachment.id} FOR UPDATE
      `);
      const current = await tx.attachment.findUnique({
        where: { id: attachment.id },
        select: attachmentSelect,
      });
      if (!current || current.key !== attachment.key) {
        throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
      }
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "storage_objects" WHERE "key" = ${attachment.key} FOR UPDATE
      `);
      const object = await tx.storageObject.findUnique({ where: { key: attachment.key } });
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
    });
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

  async prepareManualRelocate(input: PrepareManualStorageRelocateInput): Promise<string> {
    const payload: ManualStorageOperationPayload = {
      operatorUserId: input.operatorUserId,
      reviewerUserId: input.reviewerUserId,
      reasonCode: input.reasonCode,
      evidenceRef: input.evidenceRef,
      verifiedAt: input.verifiedAt.toISOString(),
      targetLocator: input.targetLocator,
    };
    parseStorageOperationPayload('manual_relocate', STORAGE_OPERATION_PAYLOAD_VERSION, payload);
    return this.prepareManualOperation('manual_relocate', input.replayOperationId, payload);
  }

  async prepareManualAttestAbsent(input: PrepareManualStorageAttestAbsentInput): Promise<string> {
    const payload: ManualStorageOperationPayload = {
      operatorUserId: input.operatorUserId,
      reviewerUserId: input.reviewerUserId,
      reasonCode: input.reasonCode,
      evidenceRef: input.evidenceRef,
      verifiedAt: input.verifiedAt.toISOString(),
    };
    parseStorageOperationPayload(
      'manual_attest_absent',
      STORAGE_OPERATION_PAYLOAD_VERSION,
      payload,
    );
    return this.prepareManualOperation('manual_attest_absent', input.replayOperationId, payload);
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
          await this.executeUploadVerify(current);
          return;
        case 'backfill_verify':
          await this.executeBackfillVerify(current);
          return;
        case 'orphan_delete':
          await this.executeOrphanDelete(current);
          return;
        case 'manual_relocate':
          await this.executeManualRelocate(current, payload as ManualStorageOperationPayload);
          return;
        case 'manual_attest_absent':
          await this.executeManualAttestAbsent(current);
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

  private async prepareManualOperation(
    kind: 'manual_relocate' | 'manual_attest_absent',
    replayOperationId: string,
    payload: ManualStorageOperationPayload,
  ): Promise<string> {
    const original = await this.prisma.storageObjectOperation.findUnique({
      where: { id: replayOperationId },
      include: { storageObject: true },
    });
    if (!original) throw new StorageConsistencyInvariantError('manual replay target not found');
    const requestHash = storageRequestHash({
      kind,
      payloadVersion: STORAGE_OPERATION_PAYLOAD_VERSION,
      storageObjectId: original.storageObjectId,
      replayOperationId,
      payload,
    });
    const eventKey = `storage.${kind.replaceAll('_', '-')}:${requestHash}`;

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "storage_objects"
        WHERE "id" = ${original.storageObjectId}
        FOR UPDATE
      `);
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "storage_object_operations"
        WHERE "storageObjectId" = ${original.storageObjectId}
          AND (
            "id" = ${replayOperationId}
            OR "eventKey" = ${eventKey}
            OR "status" IN ('pending', 'processing')
          )
        ORDER BY "id"
        FOR UPDATE
      `);
      const existing = await tx.storageObjectOperation.findUnique({ where: { eventKey } });
      if (existing) {
        if (
          existing.kind !== kind ||
          existing.storageObjectId !== original.storageObjectId ||
          existing.requestHash !== requestHash
        ) {
          throw new StorageConsistencyInvariantError('manual eventKey identity mismatch');
        }
        return existing.eventKey;
      }
      const currentOriginal = await tx.storageObjectOperation.findUnique({
        where: { id: replayOperationId },
      });
      const object = await tx.storageObject.findUnique({
        where: { id: original.storageObjectId },
      });
      if (!currentOriginal || !object || currentOriginal.storageObjectId !== object.id) {
        throw new StorageConsistencyInvariantError('manual replay target disappeared');
      }
      const activeOperations = await tx.storageObjectOperation.findMany({
        where: { storageObjectId: object.id, status: { in: ['pending', 'processing'] } },
        orderBy: { id: 'asc' },
      });
      if (activeOperations.length > 1) {
        throw new StorageConsistencyInvariantError('multiple active manual operations');
      }
      const active = activeOperations[0];
      if (active) throw new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING);

      if (kind === 'manual_relocate') {
        if (
          !['legacy_unverified', 'provider_unknown', 'missing', 'integrity_mismatch'].includes(
            object.state,
          ) ||
          object.deleteRequestedAt !== null ||
          !['backfill_verify', 'attachment_upload_verify', 'manual_relocate'].includes(
            currentOriginal.kind,
          ) ||
          !['succeeded', 'dead'].includes(currentOriginal.status)
        ) {
          throw new StorageConsistencyInvariantError('manual relocate target rejected');
        }
      } else if (
        currentOriginal.kind !== 'attachment_delete' ||
        currentOriginal.status !== 'dead' ||
        !['delete_pending', 'delete_failed'].includes(object.state)
      ) {
        throw new StorageConsistencyInvariantError('manual attest target rejected');
      }

      await tx.storageObjectOperation.create({
        data: {
          eventKey,
          storageObjectId: object.id,
          replayOfId: currentOriginal.id,
          kind,
          status: 'pending',
          effectState: 'not_started',
          payloadVersion: STORAGE_OPERATION_PAYLOAD_VERSION,
          payload: toStorageJson(payload),
          requestHash,
          availableAt: new Date(),
        },
      });
      return eventKey;
    });
  }

  private async executeAttachmentDelete(
    operation: ClaimedStorageOperationWithObject,
    payload: AttachmentDeleteOperationPayload,
  ): Promise<void> {
    const locator = await this.locatorForObject(operation.storageObject);
    let current = await this.ledger.renewLease(operation);
    let head = await this.pinnedProvider().headObjectAt(locator, operation.storageObject.key);
    if (!head.exists) {
      await this.finalizeAttachmentDelete(current, payload);
      return;
    }

    await this.ledger.markEffectState(current, 'effect_started');
    let deleteError: unknown = null;
    try {
      await this.pinnedProvider().deleteObjectAt(locator, operation.storageObject.key);
    } catch (error) {
      deleteError = error;
    }
    current = await this.ledger.renewLease(current);
    head = await this.pinnedProvider().headObjectAt(locator, operation.storageObject.key);
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
      // 全局删除锁序：Attachment → StorageObject → involved Operations。
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

  private async executeUploadVerify(operation: ClaimedStorageOperationWithObject): Promise<void> {
    const object = operation.storageObject;
    if (object.resourceId !== null || object.state === 'available') {
      await this.ledger.ack(operation, 'provider_present');
      return;
    }
    const locator = await this.locatorForObject(object);
    const current = await this.ledger.renewLease(operation);
    try {
      const head = await this.contentValidator.validateFromObjectAt(locator, {
        key: object.key,
        mime: requireString(object.expectedMime, 'expectedMime'),
        size: requireSafeSize(object.expectedSize),
      });
      await this.ledger.recordPresentUnboundClaimed(current, head);
      if (object.unboundExpiresAt && object.unboundExpiresAt.getTime() <= Date.now()) {
        await this.transitionUploadVerifyToOrphan(current);
      } else {
        await this.ledger.nack(
          current,
          new StorageAwaitingConfirmError(),
          new Date(),
          'provider_present',
        );
      }
    } catch (error) {
      if (
        error instanceof BizException &&
        error.biz === BizCode.ATTACHMENT_NOT_FOUND &&
        object.unboundExpiresAt &&
        object.unboundExpiresAt.getTime() <= Date.now()
      ) {
        await this.finalizeUnboundAbsent(current);
        return;
      }
      throw error;
    }
  }

  private async executeBackfillVerify(operation: ClaimedStorageOperationWithObject): Promise<void> {
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
    const locator = await this.locatorForObject(object);
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

  private async executeOrphanDelete(operation: ClaimedStorageOperationWithObject): Promise<void> {
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
    const locator = await this.locatorForObject(object);
    let current = await this.ledger.renewLease(operation);
    let head = await this.pinnedProvider().headObjectAt(locator, object.key);
    if (!head.exists) {
      await this.finalizeOrphanAbsent(current);
      return;
    }
    await this.ledger.markEffectState(current, 'effect_started');
    let deleteError: unknown = null;
    try {
      await this.pinnedProvider().deleteObjectAt(locator, object.key);
    } catch (error) {
      deleteError = error;
    }
    current = await this.ledger.renewLease(current);
    head = await this.pinnedProvider().headObjectAt(locator, object.key);
    if (!head.exists) {
      await this.finalizeOrphanAbsent(current);
      return;
    }
    throw deleteError instanceof Error ? deleteError : new StorageProviderDeleteStillPresentError();
  }

  private async executeManualRelocate(
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
    const evidence = await this.collectManualRelocationEvidence(
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
      this.assertManualRelocationEvidence(locked.storageObject, evidence);
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

  private async executeManualAttestAbsent(
    operation: ClaimedStorageOperationWithObject,
  ): Promise<void> {
    if (
      !operation.replayOfId ||
      !['delete_pending', 'delete_failed'].includes(operation.storageObject.state)
    ) {
      throw new StorageConsistencyInvariantError('manual attest absent safety gate rejected');
    }
    const original = await this.prisma.storageObjectOperation.findUnique({
      where: { id: operation.replayOfId },
    });
    if (!original || original.kind !== 'attachment_delete') {
      throw new StorageConsistencyInvariantError('manual attest replay target rejected');
    }
    const payload = parseStorageOperationPayload(
      'attachment_delete',
      original.payloadVersion,
      original.payload,
    ) as AttachmentDeleteOperationPayload;
    await this.finalizeManualAttestedDelete(operation, original, payload);
  }

  private async finalizeManualAttestedDelete(
    manual: ClaimedStorageOperationWithObject,
    original: StorageObjectOperation,
    payload: AttachmentDeleteOperationPayload,
  ): Promise<void> {
    const candidateAttachmentId = manual.storageObject.resourceId ?? payload.response?.id;
    if (!candidateAttachmentId || manual.storageObject.resourceType !== 'attachment') {
      throw new StorageConsistencyInvariantError('manual attest object has no Attachment resource');
    }
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "attachments"
        WHERE "id" = ${candidateAttachmentId}
        FOR UPDATE
      `);
      const currentManual = await this.ledger.lockClaimedForUpdate(tx, manual, {
        now,
        relatedOperationIds: [original.id],
      });
      if (
        currentManual.kind !== 'manual_attest_absent' ||
        currentManual.replayOfId !== original.id ||
        currentManual.storageObject.resourceType !== 'attachment' ||
        !['delete_pending', 'delete_failed'].includes(currentManual.storageObject.state)
      ) {
        throw new StorageConsistencyInvariantError('manual attest locked state rejected');
      }
      const currentOriginal = await tx.storageObjectOperation.findUnique({
        where: { id: original.id },
      });
      if (
        !currentOriginal ||
        currentOriginal.kind !== 'attachment_delete' ||
        currentOriginal.storageObjectId !== currentManual.storageObjectId ||
        currentOriginal.status !== 'dead'
      ) {
        throw new StorageConsistencyInvariantError('manual attest original operation disappeared');
      }
      const currentPayload = parseStorageOperationPayload(
        'attachment_delete',
        currentOriginal.payloadVersion,
        currentOriginal.payload,
      ) as AttachmentDeleteOperationPayload;
      const attachmentId = currentManual.storageObject.resourceId ?? currentPayload.response?.id;
      if (!attachmentId || attachmentId !== candidateAttachmentId) {
        throw new StorageConsistencyInvariantError('manual attest Attachment identity drifted');
      }
      const attachment = await tx.attachment.findUnique({
        where: { id: attachmentId },
        select: attachmentSelect,
      });
      if (!attachment || attachment.key !== currentManual.storageObject.key) {
        throw new StorageConsistencyInvariantError('manual attest Attachment link rejected');
      }
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
          id: currentManual.storageObjectId,
          state: currentManual.storageObject.state,
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
        throw new StorageConsistencyInvariantError('manual attest object CAS lost');
      }
      const originalUpdated = await tx.storageObjectOperation.updateMany({
        where: { id: currentOriginal.id, status: 'dead' },
        data: {
          ...terminalSucceededData(now, 'provider_absent'),
          payload: toStorageJson(sanitizeDeletePayloadAfterTerminal(currentPayload)),
        },
      });
      if (originalUpdated.count !== 1) {
        throw new StorageConsistencyInvariantError('manual attest original completion lost');
      }
      const manualUpdated = await tx.storageObjectOperation.updateMany({
        where: {
          ...storageFenceWhere(currentManual),
          leaseExpiresAt: { not: null, gt: now },
        },
        data: terminalSucceededData(now, 'provider_absent'),
      });
      if (manualUpdated.count !== 1) {
        throw new StorageConsistencyLeaseLostError(currentManual.id, currentManual.leaseGeneration);
      }
    });
  }

  private async transitionUploadVerifyToOrphan(
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

  private async finalizeUnboundAbsent(operation: ClaimedStorageOperationWithObject): Promise<void> {
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

  private async finalizeBackfillAvailable(
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
      this.assertHeadMatchesObject(current.storageObject, head);
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

  private async finalizeOrphanAbsent(operation: ClaimedStorageOperationWithObject): Promise<void> {
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

  private async promoteBackfillAvailable(
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
      this.assertHeadMatchesObject(current, head);
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

  private async lockActiveUploadOwner(
    tx: Prisma.TransactionClient,
    ownerType: string,
    ownerTable: string,
    ownerId: string,
  ): Promise<void> {
    let rows: Array<{ id: string; deletedAt: Date | null }>;
    switch (`${ownerType}:${ownerTable}`) {
      case 'member:member':
        rows = await tx.$queryRaw(Prisma.sql`
          SELECT "id", "deletedAt" FROM "Member" WHERE "id" = ${ownerId} FOR UPDATE
        `);
        break;
      case 'certificate:certificate':
        rows = await tx.$queryRaw(Prisma.sql`
          SELECT "id", "deletedAt" FROM "Certificate" WHERE "id" = ${ownerId} FOR UPDATE
        `);
        break;
      case 'activity:activity':
        rows = await tx.$queryRaw(Prisma.sql`
          SELECT "id", "deletedAt" FROM "Activity" WHERE "id" = ${ownerId} FOR UPDATE
        `);
        break;
      case 'content-image:contents':
      case 'content-file:contents':
        rows = await tx.$queryRaw(Prisma.sql`
          SELECT "id", "deletedAt" FROM "contents" WHERE "id" = ${ownerId} FOR UPDATE
        `);
        break;
      default:
        throw new BizException(BizCode.ATTACHMENT_OWNER_NOT_FOUND);
    }
    if (rows.length !== 1 || rows[0]?.deletedAt !== null) {
      throw new BizException(BizCode.ATTACHMENT_OWNER_NOT_FOUND);
    }
  }

  private async locatorForObject(object: StorageObject): Promise<StorageObjectLocator> {
    try {
      return storageLocatorFromObject(object);
    } catch (error) {
      if (this.ledger.isStrictMode() || !hasUnpinnedBackfillCandidateShape(object)) throw error;
      const current = await this.pinnedProvider().getCurrentLocator();
      storageLocatorFromObject(current);
      if (!canUseCurrentLocatorAsBackfillCandidate(object, current)) throw error;
      // A rollout candidate is evidence for this HEAD only. The locator remains unpinned until
      // finalizeBackfillAvailable/promoteBackfillAvailable locks and promotes the same object.
      return current;
    }
  }

  private assertHeadMatchesObject(object: StorageObject, head: HeadObjectResult): void {
    assertExpectedSizeMatchesHead(object, head);
    if (object.etag !== null && head.etag === undefined) {
      throw new StorageConsistencyInvariantError('provider HEAD lacks expected etag evidence');
    }
    if (object.etag !== null && head.etag !== object.etag) {
      throw new StorageObjectIntegrityMismatchError('provider HEAD etag mismatch');
    }
  }

  private async collectManualRelocationEvidence(
    object: StorageObject,
    locator: StorageObjectLocator,
    onProgress: () => Promise<void>,
  ): Promise<ManualRelocationEvidence> {
    const firstHead = await this.pinnedProvider().headObjectAt(locator, object.key);
    if (!firstHead.exists) throw new StorageCandidateNotFoundError();
    assertExpectedSizeMatchesHead(object, firstHead);

    if (object.checksum === null) {
      const evidence = { key: object.key, head: firstHead, hash: null };
      this.assertManualRelocationEvidence(object, evidence);
      return evidence;
    }
    requireSha256Hex(object.checksum, 'stored checksum');
    const hash = await this.pinnedProvider().hashObjectSha256At(locator, object.key, onProgress);
    const finalHead = await this.pinnedProvider().headObjectAt(locator, object.key);
    if (!finalHead.exists) throw new StorageCandidateNotFoundError();
    const evidence = { key: object.key, head: finalHead, hash };
    this.assertManualRelocationEvidence(object, evidence);
    return evidence;
  }

  private assertManualRelocationEvidence(
    object: StorageObject,
    evidence: ManualRelocationEvidence,
  ): void {
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

  private async requireObject(id: string): Promise<StorageObject> {
    const object = await this.prisma.storageObject.findUnique({ where: { id } });
    if (!object) throw new StorageConsistencyInvariantError(`object=${id} disappeared`);
    return object;
  }
}

function storageLocatorData(locator: StorageObjectLocator): {
  providerType: 'LOCAL' | 'COS';
  bucket: string | null;
  region: string | null;
  localNamespace: string | null;
} {
  return {
    providerType: locator.providerType,
    bucket: locator.bucket,
    region: locator.region,
    localNamespace: locator.localNamespace,
  };
}

function locatorMatchesOrCompletesBackfill(
  object: StorageObject,
  locator: StorageObjectLocator,
): boolean {
  try {
    return sameStorageLocator(storageLocatorFromObject(object), locator);
  } catch {
    return canUseCurrentLocatorAsBackfillCandidate(object, locator);
  }
}

export function canUseCurrentLocatorAsBackfillCandidate(
  object: Pick<
    StorageObject,
    'source' | 'state' | 'providerType' | 'bucket' | 'region' | 'localNamespace'
  >,
  locator: StorageObjectLocator,
): boolean {
  if (!hasUnpinnedBackfillCandidateShape(object)) return false;
  if (object.providerType === null) return true;
  return object.providerType === 'LOCAL' && locator.providerType === 'LOCAL';
}

function hasUnpinnedBackfillCandidateShape(
  object: Pick<
    StorageObject,
    'source' | 'state' | 'providerType' | 'bucket' | 'region' | 'localNamespace'
  >,
): boolean {
  return (
    object.source === 'backfill' &&
    object.state === 'provider_unknown' &&
    object.bucket === null &&
    object.region === null &&
    object.localNamespace === null &&
    (object.providerType === null || object.providerType === 'LOCAL')
  );
}

function sameUploadIdentity(
  attachment: SafeAttachment,
  identity: AttachmentUploadStorageIdentity,
): boolean {
  return (
    attachment.key === identity.key &&
    attachment.ownerType === identity.ownerType &&
    attachment.ownerId === identity.ownerId &&
    attachment.originalName === identity.originalName &&
    attachment.mime === identity.mime &&
    attachment.size === identity.size &&
    attachment.uploadedBy === identity.uploadedByUserId
  );
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

function terminalSucceededData(
  now: Date,
  effectState: 'provider_present' | 'provider_absent' | 'effect_succeeded',
): Prisma.StorageObjectOperationUpdateInput {
  return {
    status: 'succeeded',
    effectState,
    effectCompletedAt: effectState === 'effect_succeeded' ? now : undefined,
    completedAt: now,
    deadAt: null,
    leaseOwner: null,
    leaseAcquiredAt: null,
    leaseRenewedAt: null,
    leaseExpiresAt: null,
    lastErrorCode: null,
    lastErrorClass: null,
  };
}

function requireString(value: string | null, field: string): string {
  if (!value) throw new StorageConsistencyInvariantError(`${field} is missing`);
  return value;
}

function requireSafeSize(value: bigint | null): number {
  const size = safeNumber(value);
  if (size === undefined) throw new StorageConsistencyInvariantError('expectedSize is missing');
  return size;
}

function requireHeadSize(head: HeadObjectResult): number {
  if (head.size === undefined) {
    throw new StorageConsistencyInvariantError('provider HEAD lacks expected size evidence');
  }
  return head.size;
}

function assertExpectedSizeMatchesHead(
  object: Pick<StorageObject, 'expectedSize'>,
  head: HeadObjectResult,
): void {
  if (object.expectedSize === null) {
    throw new StorageConsistencyInvariantError('storage object lacks expected size evidence');
  }
  if (object.expectedSize !== bigintSize(requireHeadSize(head))) {
    throw new StorageObjectIntegrityMismatchError('provider HEAD size mismatch');
  }
}

function requireSha256Hex(value: string, field: string): string {
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new StorageConsistencyInvariantError(`${field} is not SHA-256 hex`);
  }
  return value.toLowerCase();
}

function safeNumber(value: bigint | null): number | undefined {
  if (value === null) return undefined;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new StorageConsistencyInvariantError(`unsafe bigint size=${value.toString()}`);
  }
  return result;
}

class StorageAwaitingConfirmError extends Error {
  constructor() {
    super('STORAGE_AWAITING_ATTACHMENT_CONFIRM');
    this.name = 'StorageAwaitingConfirmError';
  }
}

class StorageCandidateNotFoundError extends Error {
  constructor() {
    super('STORAGE_CANDIDATE_NOT_FOUND');
    this.name = 'StorageCandidateNotFoundError';
  }
}

class StorageObjectIntegrityMismatchError extends Error {
  readonly code = 'STORAGE_OBJECT_INTEGRITY_MISMATCH';

  constructor(reason: string) {
    super(reason);
    this.name = 'StorageObjectIntegrityMismatchError';
  }
}

function isAttachmentNotFound(error: unknown): boolean {
  return error instanceof BizException && error.biz === BizCode.ATTACHMENT_NOT_FOUND;
}

class StorageProviderDeleteStillPresentError extends Error {
  constructor() {
    super('STORAGE_PROVIDER_DELETE_STILL_PRESENT');
    this.name = 'StorageProviderDeleteStillPresentError';
  }
}
