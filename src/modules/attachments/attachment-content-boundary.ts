import { Prisma, type StorageObjectOperation } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  STORAGE_ATTACHMENT_UPLOAD_EVENT_PREFIX,
  STORAGE_OPERATION_PAYLOAD_VERSION,
  storageOwnerUploadEventKeyPrefix,
  storageRequestHash,
} from '../storage/storage-consistency.types';
import { parseStorageOperationPayload, toStorageJson } from '../storage/storage-operation-payload';
import { activeOperations } from './attachment-storage-invariants';
import type {
  ContentAttachmentReferenceBoundaryInput,
  ContentPublishStorageBoundaryInput,
  OwnerAttachmentLookupInput,
  OwnerAttachmentReferenceBoundaryInput,
} from './attachment-storage.types';

/*
 * 内容发布/引用与附件之间的**边界锁**(Phase 6-B 第四域第八刀)。
 *
 * 内容(Content)与附件(Attachment)分属两条生命周期,却必须在两个时点对齐:
 *   发布时:正文引用的每个附件都必须存在、属于本文、且已就绪 —— 否则发出去就是死链
 *   引用变更时:被移除引用的附件才可以走删除,仍被引用的必须拦下
 * 这两件事都要在**内容根的行锁之下**做,否则并发的发布与删除会互相看不见对方。
 *
 * 做成模块级纯函数而非 @Injectable:三个函数实测**零 `this` 依赖** ——
 * 只吃调用方传入的 tx。不进 DI 图,两个 module 都无需改注册。
 *
 * ⚠️ 锁序:与 attachment-content-delete-boundary 一样,本层是**被调用方**而非事务起点,
 * **调用顺序即锁顺序**。调用方必须在尚未持有 Attachment / StorageObject 行锁之前调用 ——
 * 全局次序见编排器文件头的锁序台账(单点),此处不复制。
 * 把调用挪到链路更晚处会静默破坏锁序,且**不会有任何编译错或测试失败**。
 *
 * ⚠️ 已知债务:lockContentPublishBoundaryUnsafe 单个函数 364 行,
 * 是全仓最大的单体方法。本刀是**纯迁移**,不拆其方法体 —— 拆分是行为变更,应另立一刀,
 * 且必须先有覆盖其分支的测试(当前该函数零单测覆盖)。
 */

export async function lockContentPublishBoundary(
  tx: Prisma.TransactionClient,
  input: ContentPublishStorageBoundaryInput,
): Promise<void> {
  try {
    await lockContentPublishBoundaryUnsafe(tx, input);
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

export async function lockContentPublishBoundaryUnsafe(
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
  const coverPairIsComplete = (input.coverAttachmentId === null) === (input.coverImageKey === null);
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

/**
 * Content-shaped entry point. Kept as a wrapper with its call signature literally unchanged so the
 * Content module's ~2 call sites and this file's existing spec block keep observing the same
 * function they always did — the generic body below is what both owners now share.
 */
export async function lockContentReferenceBoundary(
  tx: Prisma.TransactionClient,
  input: ContentAttachmentReferenceBoundaryInput,
): Promise<void> {
  return lockOwnerReferenceBoundary(tx, {
    ownerId: input.contentId,
    ownerTypes: CONTENT_REFERENCE_OWNER_TYPES,
    referencedAttachmentIds: input.referencedAttachmentIds,
  });
}

const CONTENT_REFERENCE_OWNER_TYPES = ['content-image', 'content-file'] as const;

/*
 * Owner-generic writer fence (P2-14). The caller holds its aggregate root; matching owned
 * Attachment rows are share-locked so a concurrent delete either waits and sees the new reference
 * or has already committed a tombstone that this function rejects.
 *
 * ⚠️ ownerTypes 只接受 AttachmentOwnerType —— 它是编译期闭集,不是调用方传进来的任意字符串,
 * 故下面的 `Prisma.join` 拼的是受控值,不构成注入面。
 *
 * ⚠️ 「id 不存在 / 属于别的 owner」在这里**静默跳过**而不是抛错 —— 这是 Content 既有语义
 * (外来 id 在正文里保留成占位符)。调用方若要求「必须属于本记录」,那条判定归调用方,
 * 本函数只负责「凡是属于本记录的,必须处于可引用状态」。活动封面 / 图集的归属校验
 * 因此仍留在 ActivityCoverService 里(与 ContentService.setCover 同一处置)。
 */
/**
 * Owner-scoped ownership lookup (P2-14). Resolves the requested attachment ids **only** when every
 * one of them belongs to `(ownerTypes, ownerId)`; returns `null` as soon as one does not.
 *
 * 为什么它必须住在 attachments 模块里,而不是由调用方自己 `tx.attachment.findMany`:
 * 「什么算属于本记录的合法附件」是附件域的事实。调用方各自查一遍就是跨域直读
 * (架构债棘轮会当场判 `cross-domain-fact-read-candidate`),而且两处对
 * ownerType / 软删 / 顺序的理解迟早漂移 —— 漂移时没有症状。
 *
 * 返回顺序**与入参一致**(不是 DB 顺序):活动图集的顺序就是展示顺序。
 * 入参里的重复 id 会被折叠后按原位置展开。
 */
export async function findOwnedAttachments(
  tx: Prisma.TransactionClient,
  input: OwnerAttachmentLookupInput,
): Promise<Array<{ id: string; key: string }> | null> {
  const requested = [...input.attachmentIds];
  if (requested.length === 0) return [];
  const ownerTypes = [...input.ownerTypes];
  if (ownerTypes.length === 0) return null;

  const unique = [...new Set(requested)];
  const rows = await tx.attachment.findMany({
    where: {
      id: { in: unique },
      ownerType: { in: ownerTypes },
      ownerId: input.ownerId,
    },
    select: { id: true, key: true },
  });
  // 「少了一个」与「一个都不属于本记录」是同一种失败:请求里含不属于本记录的附件。
  if (rows.length !== unique.length) return null;

  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered: Array<{ id: string; key: string }> = [];
  for (const id of requested) {
    const row = byId.get(id);
    /* istanbul ignore next -- 上面的等长判定已排除 */
    if (row === undefined) return null;
    ordered.push(row);
  }
  return ordered;
}

export async function lockOwnerReferenceBoundary(
  tx: Prisma.TransactionClient,
  input: OwnerAttachmentReferenceBoundaryInput,
): Promise<void> {
  const ids = [...new Set(input.referencedAttachmentIds)].sort();
  if (ids.length === 0) return;
  const ownerTypes = [...input.ownerTypes];
  if (ownerTypes.length === 0) return;
  await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "attachments"
      WHERE "id" IN (${Prisma.join(ids)})
        AND "ownerId" = ${input.ownerId}
        AND "ownerType" IN (${Prisma.join(ownerTypes)})
      ORDER BY "id"
      FOR SHARE
    `);
  const attachments = await tx.attachment.findMany({
    where: {
      id: { in: ids },
      ownerId: input.ownerId,
      ownerType: { in: ownerTypes },
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

function sameSortedStrings(left: readonly string[], right: readonly string[]): boolean {
  const sortedRight = [...right].sort();
  return (
    left.length === sortedRight.length && left.every((value, index) => value === sortedRight[index])
  );
}

function throwStorageBoundaryUnsafe(): never {
  throw new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING);
}
