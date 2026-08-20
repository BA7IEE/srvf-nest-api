import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type StorageObject } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { STORAGE_PROVIDER } from '../storage/storage.constants';
import type { StorageProvider } from '../storage/storage.interface';
import {
  StorageObjectLedgerService,
  type PreparedStorageUpload,
} from '../storage/storage-object-ledger.service';
import { parseStorageOperationPayload } from '../storage/storage-operation-payload';
import {
  type ClaimedStorageOperationWithObject,
  StorageConsistencyInvariantError,
  StorageUploadIdentityConflictError,
  bigintSize,
  storageLocatorFromObject,
  storageOwnerlessUploadEventKey,
  storageOwnerUploadEventKey,
  storageRequestHash,
} from '../storage/storage-consistency.types';
import type {
  HeadObjectResult,
  StorageObjectLocator,
  UploadUrlResult,
} from '../storage/storage.types';
import { AttachmentAuditRecorder } from './attachment-audit-recorder';
import { AttachmentContentValidator } from './attachment-content-validator';
import { AttachmentReconciliationService } from './attachment-reconciliation.service';
import {
  StorageAwaitingConfirmError,
  assertExpectedSizeMatchesHead,
  requireHeadSize,
  requireSafeSize,
  safeNumber,
  requireString,
} from './attachment-storage-invariants';
import { locatorForObject, pinnedProviderOf } from './attachment-storage-locator';
import type {
  AttachmentUploadStorageIdentity,
  FinalizeAttachmentStorageUploadInput,
  PreparedAttachmentStorageUpload,
} from './attachment-storage.types';
import { attachmentSelect, type SafeAttachment } from './attachments.select';

/*
 * 附件上传的建账链路(Phase 6-B 第四域第七刀)。
 *
 * 一次上传跨越三个阶段,彼此之间隔着 HTTP 往返与供应商 IO:
 *   受理 prepareUpload*      建 StorageObject + upload_verify 操作,发签名 URL
 *   取证 verifyUploadEvidence 供应商侧 HEAD/校验,确认字节确实落地
 *   落账 finalizeUpload*     建 Attachment 行、对象转 available、操作置终态
 * 每一步都必须能独立重入 —— 客户端可能在任意阶段断线重试,故 eventKey 幂等与
 * lockActiveUploadOwner 的所有权锁是这条链的骨架,不是可选的加固。
 *
 * ⚠️ 与 reconciliation 的方向是**单向**:上传验证失败时把对象交给对账收敛
 * (executeUploadVerify → transitionUploadVerifyToOrphan / finalizeUnboundAbsent)。
 * 不要反向引用 —— 对账族不认识上传意图,它只让事实与账目对齐。
 *
 * ⚠️ 编排器保留全部 10 个 public 的薄委托:attachments.service 对这些方法有约 100 处调用,
 * 编排器是本模块对外的唯一入口,调用面因此逐字不变。
 */
@Injectable()
export class AttachmentUploadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: StorageObjectLedgerService,
    private readonly contentValidator: AttachmentContentValidator,
    private readonly auditRecorder: AttachmentAuditRecorder,
    private readonly reconciliation: AttachmentReconciliationService,
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
    const locator = await this.resolveUploadLocatorForTransaction(identity.key);
    return this.prisma.$transaction((tx) =>
      this.prepareUploadWithLocatorInTransaction(tx, identity, source, unboundExpiresAt, locator),
    );
  }

  async prepareUploadInTransaction(
    tx: Prisma.TransactionClient,
    identity: AttachmentUploadStorageIdentity,
    source: 'attachment_signed_upload' | 'attachment_legacy',
    unboundExpiresAt: Date,
    resolvedLocator?: StorageObjectLocator,
  ): Promise<PreparedAttachmentStorageUpload> {
    // A caller-owned root transaction must never consult a Provider. Returned upload tokens from
    // the current/legacy ledger binaries already have a durable Object; a missing Object is an
    // invalid storage identity and is not recreated in a second side channel.
    let locator = resolvedLocator ?? null;
    if (!locator) {
      let existing: StorageObject | null;
      try {
        existing = await this.ledger.findObjectByKey(identity.key, tx);
        locator = existing ? storageLocatorFromObject(existing) : null;
      } catch {
        throw new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING);
      }
      if (!existing || !locator) throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    }
    return this.prepareUploadWithLocatorInTransaction(
      tx,
      identity,
      source,
      unboundExpiresAt,
      locator,
    );
  }

  async prepareUploadWithLocatorInTransaction(
    tx: Prisma.TransactionClient,
    identity: AttachmentUploadStorageIdentity,
    source: 'attachment_signed_upload' | 'attachment_legacy',
    unboundExpiresAt: Date,
    locator: StorageObjectLocator,
  ): Promise<PreparedAttachmentStorageUpload> {
    const requestHash = this.uploadRequestHash(identity, source);
    const eventKey = storageOwnerUploadEventKey(identity.ownerType, identity.ownerId, requestHash);
    let prepared: PreparedStorageUpload;
    try {
      prepared = await this.ledger.prepareUploadInTransaction(tx, {
        key: identity.key,
        source,
        locator,
        expectedSize: identity.size,
        expectedMime: identity.mime,
        unboundExpiresAt,
        eventKey,
        requestHash,
      });
    } catch (error) {
      if (error instanceof StorageUploadIdentityConflictError) {
        throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
      }
      throw error;
    }
    return {
      objectId: prepared.object.id,
      operationId: prepared.operation.id,
      eventKey: prepared.operation.eventKey,
      requestHash,
      locator,
    };
  }

  async resolveUploadLocatorForTransaction(key: string): Promise<StorageObjectLocator> {
    try {
      const existing = await this.ledger.findObjectByKey(key);
      return existing
        ? storageLocatorFromObject(existing)
        : await pinnedProviderOf(this.provider).getCurrentLocator();
    } catch {
      throw new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING);
    }
  }

  validateUploadBufferOutsideTransaction(mime: string, buffer: Buffer): void {
    this.contentValidator.validateFromBuffer({ mime, buffer });
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
      return await pinnedProviderOf(this.provider).generateUploadUrlAt(prepared.locator, {
        key: identity.key,
        contentType: identity.mime,
        sizeBytes: identity.size,
        expiresIn,
      });
    } catch {
      throw new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING);
    }
  }

  async verifyUploadEvidence(
    identity: AttachmentUploadStorageIdentity,
    source: 'attachment_signed_upload' | 'attachment_legacy',
  ): Promise<HeadObjectResult> {
    const requestHash = this.uploadRequestHash(identity, source);
    let context: PreparedStorageUpload;
    try {
      context = await this.ledger.findUploadContext(identity.key, requestHash);
    } catch {
      throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    }
    const { object, operation } = context;
    if (object.source !== source) throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    const ownerEventKey = storageOwnerUploadEventKey(
      identity.ownerType,
      identity.ownerId,
      requestHash,
    );
    if (
      operation.eventKey !== ownerEventKey &&
      operation.eventKey !== storageOwnerlessUploadEventKey(requestHash)
    ) {
      // requestHash is already owner-bound; the explicit key check additionally prevents a
      // corrupted/malformed owner-v1 operation from being attributed to this Content owner.
      throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    }
    parseStorageOperationPayload(
      'attachment_upload_verify',
      operation.payloadVersion,
      operation.payload,
    );

    if (object.state === 'available' && object.resourceId) {
      return {
        exists: true,
        size: safeNumber(object.actualSize ?? object.expectedSize),
        etag: object.etag ?? undefined,
        contentType: object.actualMime ?? object.expectedMime ?? undefined,
      };
    }
    const publishCancelledContentIntent =
      isContentAttachmentOwnerType(identity.ownerType) && object.state === 'delete_pending';
    if (
      !publishCancelledContentIntent &&
      !['pending_upload', 'present_unbound', 'provider_unknown'].includes(object.state)
    ) {
      throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    }
    const locator = await locatorForObject(this.ledger, this.provider, object);
    try {
      return await this.contentValidator.validateFromObjectAt(locator, {
        key: identity.key,
        mime: identity.mime,
        size: identity.size,
      });
    } catch (error) {
      if (!(error instanceof BizException)) {
        // Provider/network uncertainty is durable evidence, not a transient HTTP-only error.
        // This intentionally runs outside the caller's aggregate transaction, after Provider
        // evidence failed, preserving #704 diagnostics and worker retry semantics.
        await this.ledger.noteProviderUnknown(object.id, operation.id, error);
        throw new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING);
      }
      throw error;
    }
  }

  async putUploadObjectAtAndVerifyOutsideTransaction(
    identity: AttachmentUploadStorageIdentity,
    source: 'attachment_legacy',
    locator: StorageObjectLocator,
    body: Buffer,
  ): Promise<HeadObjectResult> {
    try {
      await pinnedProviderOf(this.provider).putObjectAt(locator, {
        key: identity.key,
        body,
        contentType: identity.mime,
      });
    } catch {
      throw new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING);
    }
    return this.verifyUploadEvidence(identity, source);
  }

  async finalizeUpload(
    input: FinalizeAttachmentStorageUploadInput,
    head: HeadObjectResult,
  ): Promise<SafeAttachment> {
    return this.prisma.$transaction((tx) => this.finalizeUploadInTransaction(tx, input, head));
  }

  async finalizeUploadInTransaction(
    tx: Prisma.TransactionClient,
    input: FinalizeAttachmentStorageUploadInput,
    head: HeadObjectResult,
  ): Promise<SafeAttachment> {
    const now = new Date();
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
    // Lock every operation for this object in the global id order, then reread the upload and
    // orphan state. This is shared by the public wrapper and parent-transaction callers.
    await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "storage_object_operations"
        WHERE "storageObjectId" = ${object.id}
        ORDER BY "id"
        FOR UPDATE
      `);
    const currentOperation = await tx.storageObjectOperation.findFirst({
      where: {
        storageObjectId: object.id,
        kind: 'attachment_upload_verify',
        requestHash: input.requestHash,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (
      !currentOperation ||
      currentOperation.kind !== 'attachment_upload_verify' ||
      currentOperation.storageObjectId !== object.id ||
      currentOperation.requestHash !== input.requestHash
    ) {
      throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    }
    const ownerEventKey = storageOwnerUploadEventKey(
      input.identity.ownerType,
      input.identity.ownerId,
      input.requestHash,
    );
    if (
      currentOperation.eventKey !== ownerEventKey &&
      currentOperation.eventKey !== storageOwnerlessUploadEventKey(input.requestHash)
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
    const activeOrphans = await tx.storageObjectOperation.findMany({
      where: {
        storageObjectId: object.id,
        kind: 'orphan_delete',
        status: { in: ['pending', 'processing'] },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    if (activeOrphans.length !== 0) {
      throw new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING);
    }

    if (object.state === 'available' && object.resourceType === 'attachment' && object.resourceId) {
      if (
        currentOperation.status !== 'succeeded' ||
        currentOperation.effectState !== 'provider_present'
      ) {
        throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
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
    if (['delete_pending', 'delete_failed', 'integrity_mismatch'].includes(object.state)) {
      throw new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING);
    }
    if (currentOperation.status === 'dead') {
      throw new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING);
    }
    if (
      !['pending_upload', 'present_unbound', 'provider_unknown'].includes(object.state) ||
      object.resourceId !== null
    ) {
      throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    }
    if (!head.exists) throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    assertExpectedSizeMatchesHead(object, head);
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
        actualSize: bigintSize(requireHeadSize(head)),
        actualMime: head.contentType,
        etag: head.etag,
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
  }

  async executeUploadVerify(operation: ClaimedStorageOperationWithObject): Promise<void> {
    const object = operation.storageObject;
    if (object.resourceId !== null || object.state === 'available') {
      await this.ledger.ack(operation, 'provider_present');
      return;
    }
    const locator = await locatorForObject(this.ledger, this.provider, object);
    const current = await this.ledger.renewLease(operation);
    try {
      const head = await this.contentValidator.validateFromObjectAt(locator, {
        key: object.key,
        mime: requireString(object.expectedMime, 'expectedMime'),
        size: requireSafeSize(object.expectedSize),
      });
      await this.ledger.recordPresentUnboundClaimed(current, head);
      if (object.unboundExpiresAt && object.unboundExpiresAt.getTime() <= Date.now()) {
        await this.reconciliation.transitionUploadVerifyToOrphan(current);
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
        await this.reconciliation.finalizeUnboundAbsent(current);
        return;
      }
      throw error;
    }
  }

  async lockActiveUploadOwner(
    tx: Prisma.TransactionClient,
    ownerType: string,
    ownerTable: string,
    ownerId: string,
  ): Promise<void> {
    if (
      (ownerType === 'content-image' || ownerType === 'content-file') &&
      ownerTable === 'contents'
    ) {
      const contentRows = await tx.$queryRaw<
        Array<{
          id: string;
          deletedAt: Date | null;
          statusCode: string;
          publishedAt: Date | null;
        }>
      >(Prisma.sql`
        SELECT "id", "deletedAt", "statusCode", "publishedAt"
        FROM "contents"
        WHERE "id" = ${ownerId}
        FOR UPDATE
      `);
      const content = contentRows[0];
      if (contentRows.length !== 1 || !content || content.deletedAt !== null) {
        throw new BizException(BizCode.ATTACHMENT_OWNER_NOT_FOUND);
      }
      if (content.statusCode !== 'draft' || content.publishedAt !== null) {
        throw new BizException(BizCode.CONTENT_INVALID_STATUS_TRANSITION);
      }
      return;
    }
    if (
      ownerType === 'registration-upload-session' &&
      ownerTable === 'registration_upload_sessions'
    ) {
      const sessionRows = await tx.$queryRaw<Array<{ id: string; statusCode: string }>>(Prisma.sql`
        SELECT "id", "statusCode" FROM "RegistrationUploadSession"
        WHERE "id" = ${ownerId}
        FOR UPDATE
      `);
      if (sessionRows.length !== 1 || sessionRows[0]?.statusCode !== 'active') {
        throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
      }
      return;
    }
    if (ownerType === 'attendance-import-preview' && ownerTable === 'activity_batch_jobs') {
      const jobRows = await tx.$queryRaw<
        Array<{ id: string; jobTypeCode: string; statusCode: string; action: string | null }>
      >(Prisma.sql`
        SELECT "id", "jobTypeCode", "statusCode", "payload"->>'action' AS "action"
        FROM "ActivityBatchJob"
        WHERE "id" = ${ownerId}
        FOR UPDATE
      `);
      const job = jobRows[0];
      if (
        jobRows.length !== 1 ||
        job === undefined ||
        job.jobTypeCode !== 'import_preview' ||
        job.statusCode !== 'pending' ||
        job.action !== 'onsite_import_preview'
      ) {
        throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
      }
      return;
    }
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
      // issue #1055 T2:视觉身份两个 owner。表名首字母大写是因为 `User` / `Member`
      // 两个 model **没有 `@@map`**,物理表名就是 model 名。
      //
      // ⚠️ 本 switch 是又一份**手写清单**:不在列的 ownerType 一律落到 default 抛
      // OWNER_NOT_FOUND。它没有任何编译期约束 —— 新增 owner type 时漏掉这里,
      // 前三个阶段全部正常,**只在 finalize 那一步失败**,而错误信息说的是
      // 「owner 不存在」(owner 明明存在)。本刀就是这么发现它的:Storage E2E 跑到
      // 阶段 ④ 才炸,前面三阶段一路绿。
      //
      // 调用方(T3 users / T4 members)此刻已持有同一行的聚合根锁;同事务内重复
      // FOR UPDATE 同一行是可重入的,不构成新的锁序边。
      case 'user-avatar:User':
        rows = await tx.$queryRaw(Prisma.sql`
          SELECT "id", "deletedAt" FROM "User" WHERE "id" = ${ownerId} FOR UPDATE
        `);
        break;
      case 'member-official-portrait:Member':
        rows = await tx.$queryRaw(Prisma.sql`
          SELECT "id", "deletedAt" FROM "Member" WHERE "id" = ${ownerId} FOR UPDATE
        `);
        break;
      default:
        throw new BizException(BizCode.ATTACHMENT_OWNER_NOT_FOUND);
    }
    if (rows.length !== 1 || rows[0]?.deletedAt !== null) {
      throw new BizException(BizCode.ATTACHMENT_OWNER_NOT_FOUND);
    }
  }
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

function isContentAttachmentOwnerType(ownerType: string): boolean {
  return ownerType === 'content-image' || ownerType === 'content-file';
}
