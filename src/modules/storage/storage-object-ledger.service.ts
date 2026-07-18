import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Prisma, type StorageObject, type StorageObjectOperation } from '@prisma/client';

import appConfig from '../../config/app.config';
import { PrismaService } from '../../database/prisma.service';
import {
  STORAGE_EFFECT_STATES,
  STORAGE_OPERATION_CLAIM_BATCH,
  STORAGE_DELETE_REPLAY_PHYSICAL_LIMIT_MS,
  STORAGE_OPERATION_LEASE_MS,
  STORAGE_OPERATION_MAX_ATTEMPTS,
  STORAGE_OPERATION_PAYLOAD_VERSION,
  StorageConsistencyInvariantError,
  StorageConsistencyLeaseLostError,
  StorageUploadIdentityConflictError,
  normalizeStorageError,
  storageLocatorFromObject,
  storageRequestHash,
  storageRetryDelayMs,
  type ClaimedStorageObjectOperation,
  type ClaimedStorageOperationWithObject,
  type StorageEffectState,
  type StorageObjectSource,
  type StorageObjectState,
  type StorageOperationKind,
} from './storage-consistency.types';
import {
  parseStorageOperationPayload,
  purgeDeletePayload,
  sanitizeDeletePayloadAfterTerminal,
  toStorageJson,
  type AttachmentDeleteOperationPayload,
} from './storage-operation-payload';
import type { HeadObjectResult, StorageObjectLocator } from './storage.types';

type LedgerClient = PrismaService | Prisma.TransactionClient;

export interface PreparedStorageUpload {
  object: StorageObject;
  operation: StorageObjectOperation;
}

export interface PrepareStorageUploadInput {
  key: string;
  source: Exclude<StorageObjectSource, 'backfill'>;
  locator: StorageObjectLocator;
  expectedSize: number;
  expectedMime: string;
  unboundExpiresAt: Date;
  requestHash: string;
  eventKey: string;
}

export interface RuntimeBackfillAttachment {
  id: string;
  key: string;
  size: number;
  mime: string;
  checksum: string | null;
  etag: string | null;
  createdAt: Date;
}

@Injectable()
export class StorageObjectLedgerService implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(appConfig.KEY)
    private readonly cfg: ConfigType<typeof appConfig>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // The dedicated worker is also the manual recovery/purge entrypoint. Applying the HTTP
    // service start gate while constructing that context would make an unsafe row or an overdue
    // replay prevent the very command that repairs it. Worker gating is explicit --strict-gate.
    if (isStorageConsistencyWorkerEntrypoint()) return;
    if (this.cfg.env !== 'production' || this.cfg.storage.consistencyMode !== 'STRICT') return;
    await this.assertStrictStartGate();
  }

  readableStates(): StorageObjectState[] {
    return this.cfg.storage.consistencyMode === 'STRICT'
      ? ['available']
      : ['available', 'legacy_unverified', 'provider_unknown'];
  }

  isReadableState(state: string): boolean {
    return this.readableStates().some((candidate) => candidate === state);
  }

  isStrictMode(): boolean {
    return this.cfg.storage.consistencyMode === 'STRICT';
  }

  async assertStrictStartGate(now: Date = new Date()): Promise<void> {
    const physicalDeadline = new Date(now.getTime() - STORAGE_DELETE_REPLAY_PHYSICAL_LIMIT_MS);
    const [
      unsafeObjectStates,
      unsafeBackfillOperations,
      overdueReplayPayloads,
      invalidAttachmentObjects,
      invalidAvailableObjects,
    ] = await this.prisma.$transaction([
      this.prisma.storageObject.count({
        where: {
          state: {
            in: ['legacy_unverified', 'provider_unknown', 'missing', 'integrity_mismatch'],
          },
        },
      }),
      this.prisma.storageObjectOperation.count({
        where: {
          kind: 'backfill_verify',
          OR: [
            { status: { in: ['pending', 'processing'] } },
            {
              status: 'dead',
              storageObject: {
                state: {
                  in: ['legacy_unverified', 'provider_unknown', 'missing', 'integrity_mismatch'],
                },
              },
            },
          ],
        },
      }),
      this.prisma.storageObjectOperation.count({
        where: {
          kind: 'attachment_delete',
          responsePurgedAt: null,
          createdAt: { lt: physicalDeadline },
        },
      }),
      this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
          SELECT COUNT(*)::BIGINT AS "count"
          FROM "attachments" a
          LEFT JOIN "storage_objects" o ON o."key" = a."key"
          WHERE o."id" IS NULL
             OR o."resourceType" IS DISTINCT FROM 'attachment'
             OR o."resourceId" IS DISTINCT FROM a."id"
             OR (
               o."state" <> 'available'
               AND NOT (
                 o."state" IN ('delete_pending', 'delete_failed')
                 AND EXISTS (
                   SELECT 1
                   FROM "storage_object_operations" op
                   WHERE op."storageObjectId" = o."id"
                     AND op."kind" = 'attachment_delete'
                     AND op."status" IN ('pending', 'processing')
                 )
               )
             )
        `),
      this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
          SELECT COUNT(*)::BIGINT AS "count"
          FROM "storage_objects" o
          LEFT JOIN "attachments" a
            ON a."id" = o."resourceId"
           AND a."key" = o."key"
          WHERE o."state" = 'available'
            AND (
              o."resourceType" IS DISTINCT FROM 'attachment'
              OR a."id" IS NULL
            )
        `),
    ]);
    const invalidAttachmentObjectCount = Number(invalidAttachmentObjects[0]?.count ?? 0n);
    const invalidAvailableObjectCount = Number(invalidAvailableObjects[0]?.count ?? 0n);
    if (
      unsafeObjectStates !== 0 ||
      unsafeBackfillOperations !== 0 ||
      overdueReplayPayloads !== 0 ||
      invalidAttachmentObjectCount !== 0 ||
      invalidAvailableObjectCount !== 0
    ) {
      throw new Error(
        'production STRICT fail-fast: storage consistency gates not zero ' +
          `(unsafeObjects=${unsafeObjectStates}, backfillOps=${unsafeBackfillOperations}, ` +
          `overdueReplayPayloads=${overdueReplayPayloads}, ` +
          `invalidAttachmentObjects=${invalidAttachmentObjectCount}, ` +
          `invalidAvailableObjects=${invalidAvailableObjectCount})`,
      );
    }
  }

  async prepareUpload(input: PrepareStorageUploadInput): Promise<PreparedStorageUpload> {
    validateHash(input.requestHash);
    const payload = { source: input.source } as const;
    parseStorageOperationPayload(
      'attachment_upload_verify',
      STORAGE_OPERATION_PAYLOAD_VERSION,
      payload,
    );
    return this.prisma.$transaction(async (tx) => {
      await tx.storageObject.createMany({
        data: [
          {
            key: input.key,
            state: 'pending_upload',
            source: input.source,
            ...locatorData(input.locator),
            expectedSize: BigInt(input.expectedSize),
            expectedMime: input.expectedMime,
            unboundExpiresAt: input.unboundExpiresAt,
          },
        ],
        skipDuplicates: true,
      });
      const candidate = await tx.storageObject.findUnique({ where: { key: input.key } });
      if (!candidate) {
        throw new StorageConsistencyInvariantError(`prepared object disappeared key=${input.key}`);
      }
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "storage_objects"
        WHERE "id" = ${candidate.id}
        FOR UPDATE
      `);
      const object = await tx.storageObject.findUnique({ where: { key: input.key } });
      if (!object || object.id !== candidate.id) {
        throw new StorageConsistencyInvariantError(`prepared object disappeared key=${input.key}`);
      }

      if (
        object.state === 'available' &&
        object.resourceType !== null &&
        object.resourceId !== null
      ) {
        const replay = await tx.storageObjectOperation.findFirst({
          where: {
            eventKey: input.eventKey,
            storageObjectId: object.id,
            kind: 'attachment_upload_verify',
            requestHash: input.requestHash,
            status: 'succeeded',
            effectState: 'provider_present',
          },
          orderBy: { createdAt: 'desc' },
        });
        if (!replay) throw new StorageUploadIdentityConflictError();
        assertPreparedObjectMatches(object, input);
        const replayPayload = parseStorageOperationPayload(
          'attachment_upload_verify',
          replay.payloadVersion,
          replay.payload,
        );
        if (!('source' in replayPayload) || replayPayload.source !== object.source) {
          throw new StorageConsistencyInvariantError('upload replay source drifted');
        }
        return { object, operation: replay };
      }
      assertPreparedObjectMatches(object, input);

      await tx.storageObjectOperation.createMany({
        data: [
          {
            eventKey: input.eventKey,
            storageObjectId: object.id,
            kind: 'attachment_upload_verify',
            status: 'pending',
            effectState: 'not_started',
            payloadVersion: STORAGE_OPERATION_PAYLOAD_VERSION,
            payload,
            requestHash: input.requestHash,
          },
        ],
        skipDuplicates: true,
      });
      const operation = await tx.storageObjectOperation.findUnique({
        where: { eventKey: input.eventKey },
      });
      if (!operation || operation.storageObjectId !== object.id) {
        throw new StorageConsistencyInvariantError(
          `prepared operation disappeared key=${input.key}`,
        );
      }
      if (
        operation.kind !== 'attachment_upload_verify' ||
        operation.requestHash !== input.requestHash
      ) {
        throw new StorageConsistencyInvariantError(
          `eventKey reused with different upload identity`,
        );
      }
      parseStorageOperationPayload(operation.kind, operation.payloadVersion, operation.payload);
      return { object, operation };
    });
  }

  async ensureRuntimeBackfill(
    attachment: RuntimeBackfillAttachment,
  ): Promise<StorageObject | null> {
    const existing = await this.prisma.storageObject.findUnique({
      where: { key: attachment.key },
    });
    if (existing) return existing;
    if (this.cfg.storage.consistencyMode === 'STRICT') return null;

    const requestHash = storageRequestHash({
      kind: 'runtime_backfill',
      attachmentId: attachment.id,
      key: attachment.key,
    });
    const eventKey = `storage.runtime-backfill:${attachment.id}`;
    const payload = { attachmentId: attachment.id };
    parseStorageOperationPayload('backfill_verify', STORAGE_OPERATION_PAYLOAD_VERSION, payload);

    return this.prisma.$transaction(async (tx) => {
      await tx.storageObject.createMany({
        data: [
          {
            key: attachment.key,
            // Current settings are only a JIT HEAD candidate. Runtime reconciliation must not
            // persist them as a locator before positive provider evidence.
            state: 'provider_unknown',
            source: 'backfill',
            expectedSize: BigInt(attachment.size),
            expectedMime: attachment.mime,
            checksum: attachment.checksum,
            etag: attachment.etag,
            resourceType: 'attachment',
            resourceId: attachment.id,
            createdAt: attachment.createdAt,
          },
        ],
        skipDuplicates: true,
      });
      const object = await tx.storageObject.findUnique({ where: { key: attachment.key } });
      if (!object)
        throw new StorageConsistencyInvariantError('runtime backfill object disappeared');
      const active = await tx.storageObjectOperation.findFirst({
        where: { storageObjectId: object.id, status: { in: ['pending', 'processing'] } },
      });
      if (!active) {
        await tx.storageObjectOperation.createMany({
          data: [
            {
              eventKey,
              storageObjectId: object.id,
              kind: 'backfill_verify',
              status: 'pending',
              effectState: 'not_started',
              payloadVersion: STORAGE_OPERATION_PAYLOAD_VERSION,
              payload,
              requestHash,
            },
          ],
          skipDuplicates: true,
        });
      }
      return object;
    });
  }

  async findObjectByKey(
    key: string,
    client: LedgerClient = this.prisma,
  ): Promise<StorageObject | null> {
    return client.storageObject.findUnique({ where: { key } });
  }

  async findAttachmentObject(attachmentId: string): Promise<StorageObject | null> {
    return this.prisma.storageObject.findFirst({
      where: { resourceType: 'attachment', resourceId: attachmentId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findUploadContext(key: string, requestHash: string): Promise<PreparedStorageUpload> {
    const object = await this.prisma.storageObject.findUnique({ where: { key } });
    if (!object) throw new StorageConsistencyInvariantError(`upload object missing key=${key}`);
    const operation = await this.prisma.storageObjectOperation.findFirst({
      where: { storageObjectId: object.id, kind: 'attachment_upload_verify', requestHash },
      orderBy: { createdAt: 'desc' },
    });
    if (!operation) throw new StorageConsistencyInvariantError('upload requestHash mismatch');
    parseStorageOperationPayload(
      'attachment_upload_verify',
      operation.payloadVersion,
      operation.payload,
    );
    return { object, operation };
  }

  async recordPresentUnbound(
    objectId: string,
    operationId: string,
    head: HeadObjectResult,
    now: Date = new Date(),
  ): Promise<void> {
    if (!head.exists) throw new StorageConsistencyInvariantError('cannot record absent as present');
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "storage_objects" WHERE "id" = ${objectId} FOR UPDATE
      `);
      const object = await tx.storageObject.findUnique({ where: { id: objectId } });
      if (!object) {
        throw new StorageConsistencyInvariantError(`present object disappeared id=${objectId}`);
      }
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "storage_object_operations"
        WHERE "id" = ${operationId}
        FOR UPDATE
      `);
      const operation = await tx.storageObjectOperation.findUnique({
        where: { id: operationId },
      });
      if (
        !operation ||
        operation.storageObjectId !== object.id ||
        operation.kind !== 'attachment_upload_verify' ||
        operation.status === 'dead'
      ) {
        throw new StorageConsistencyInvariantError('present upload operation drifted');
      }
      parseStorageOperationPayload(
        'attachment_upload_verify',
        operation.payloadVersion,
        operation.payload,
      );
      if (object.state === 'available' && object.resourceId !== null) return;
      if (
        !['pending_upload', 'present_unbound', 'provider_unknown'].includes(object.state) ||
        object.resourceId !== null
      ) {
        throw new StorageConsistencyInvariantError(
          `present transition rejected object=${objectId}`,
        );
      }
      const updated = await tx.storageObject.updateMany({
        where: {
          id: objectId,
          state: object.state,
          resourceId: null,
        },
        data: {
          state: 'present_unbound',
          actualSize: head.size === undefined ? undefined : BigInt(head.size),
          actualMime: head.contentType,
          etag: head.etag,
          presentAt: now,
          lastProviderCheckedAt: now,
          lastErrorCode: null,
          lastErrorClass: null,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new StorageConsistencyInvariantError(
          `present transition rejected object=${objectId}`,
        );
      }
      if (operation.status === 'pending' || operation.status === 'processing') {
        await tx.storageObjectOperation.update({
          where: { id: operation.id },
          data: {
            effectState: 'provider_present',
            lastErrorCode: null,
            lastErrorClass: null,
          },
        });
      }
    });
  }

  async recordPresentUnboundClaimed(
    operation: ClaimedStorageOperationWithObject,
    head: HeadObjectResult,
    now: Date = new Date(),
  ): Promise<void> {
    if (!head.exists) {
      throw new StorageConsistencyInvariantError('cannot record absent HEAD as present');
    }
    await this.prisma.$transaction(async (tx) => {
      const current = await this.lockClaimedForUpdate(tx, operation, { now });
      if (
        !['pending_upload', 'present_unbound', 'provider_unknown'].includes(
          current.storageObject.state,
        ) ||
        current.storageObject.resourceId !== null
      ) {
        throw new StorageConsistencyInvariantError(
          `claimed present transition rejected object=${operation.storageObjectId}`,
        );
      }
      const updated = await tx.storageObject.updateMany({
        where: {
          id: current.storageObjectId,
          state: current.storageObject.state,
          resourceId: null,
        },
        data: {
          state: 'present_unbound',
          actualSize: head.size === undefined ? undefined : BigInt(head.size),
          actualMime: head.contentType,
          etag: head.etag,
          presentAt: now,
          lastProviderCheckedAt: now,
          lastErrorCode: null,
          lastErrorClass: null,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new StorageConsistencyInvariantError(
          `claimed present transition rejected object=${operation.storageObjectId}`,
        );
      }
      const fenced = await tx.storageObjectOperation.updateMany({
        where: {
          ...storageFenceWhere(current),
          leaseExpiresAt: { not: null, gt: now },
        },
        data: {
          effectState: 'provider_present',
          lastErrorCode: null,
          lastErrorClass: null,
        },
      });
      if (fenced.count !== 1) {
        throw new StorageConsistencyLeaseLostError(current.id, current.leaseGeneration);
      }
    });
  }

  async noteProviderUnknown(
    objectId: string,
    operationId: string | null,
    error: unknown,
    now: Date = new Date(),
  ): Promise<void> {
    const normalized = normalizeStorageError(error);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "storage_objects" WHERE "id" = ${objectId} FOR UPDATE
      `);
      const object = await tx.storageObject.findUnique({ where: { id: objectId } });
      if (!object) {
        throw new StorageConsistencyInvariantError(`unknown object disappeared id=${objectId}`);
      }
      if (
        ['delete_pending', 'delete_failed', 'absent', 'missing', 'integrity_mismatch'].includes(
          object.state,
        )
      )
        return;
      if (object.state === 'available') {
        await tx.storageObject.updateMany({
          where: { id: object.id, state: 'available' },
          data: {
            lastProviderCheckedAt: now,
            lastErrorCode: normalized.code,
            lastErrorClass: normalized.errorClass,
            version: { increment: 1 },
          },
        });
        return;
      }
      let operation: StorageObjectOperation | null = null;
      if (operationId) {
        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "storage_object_operations"
          WHERE "id" = ${operationId}
          FOR UPDATE
        `);
        operation = await tx.storageObjectOperation.findUnique({ where: { id: operationId } });
        if (!operation || operation.storageObjectId !== object.id) {
          throw new StorageConsistencyInvariantError('unknown operation drifted');
        }
        if (operation.status !== 'pending' && operation.status !== 'processing') return;
      }
      await tx.storageObject.updateMany({
        where: {
          id: objectId,
          state: object.state,
        },
        data: {
          state: 'provider_unknown',
          lastProviderCheckedAt: now,
          lastErrorCode: normalized.code,
          lastErrorClass: normalized.errorClass,
          version: { increment: 1 },
        },
      });
      if (operation) {
        await tx.storageObjectOperation.updateMany({
          where: { id: operation.id, status: operation.status },
          data: {
            effectState: 'provider_unknown',
            lastErrorCode: normalized.code,
            lastErrorClass: normalized.errorClass,
          },
        });
      }
    });
  }

  async noteReadFailure(objectId: string, error: unknown, now: Date = new Date()): Promise<void> {
    const normalized = normalizeStorageError(error);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "storage_objects" WHERE "id" = ${objectId} FOR UPDATE
      `);
      const object = await tx.storageObject.findUnique({ where: { id: objectId } });
      if (!object) {
        throw new StorageConsistencyInvariantError(
          `read-failure object disappeared id=${objectId}`,
        );
      }
      if (
        ['delete_pending', 'delete_failed', 'absent', 'missing', 'integrity_mismatch'].includes(
          object.state,
        )
      )
        return;
      const updated = await tx.storageObject.updateMany({
        where: { id: object.id, state: object.state },
        data: {
          lastProviderCheckedAt: now,
          lastErrorCode: normalized.code,
          lastErrorClass: normalized.errorClass,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new StorageConsistencyInvariantError('read-failure object CAS lost');
      }
    });
  }

  async noteBackfillReadFailureClaimed(
    operation: ClaimedStorageOperationWithObject,
    error: unknown,
    now: Date = new Date(),
  ): Promise<void> {
    const normalized = normalizeStorageError(error);
    await this.prisma.$transaction(async (tx) => {
      const current = await this.lockClaimedForUpdate(tx, operation, { now });
      if (
        current.kind !== 'backfill_verify' ||
        current.storageObject.source !== 'backfill' ||
        !['legacy_unverified', 'provider_unknown'].includes(current.storageObject.state)
      ) {
        throw new StorageConsistencyInvariantError('backfill read failure state rejected');
      }
      const objectUpdated = await tx.storageObject.updateMany({
        where: {
          id: current.storageObjectId,
          state: current.storageObject.state,
          source: 'backfill',
        },
        data: {
          lastProviderCheckedAt: now,
          lastErrorCode: normalized.code,
          lastErrorClass: normalized.errorClass,
          version: { increment: 1 },
        },
      });
      if (objectUpdated.count !== 1) {
        throw new StorageConsistencyInvariantError('backfill read-failure object CAS lost');
      }
      const fenced = await tx.storageObjectOperation.updateMany({
        where: {
          ...storageFenceWhere(current),
          leaseExpiresAt: { not: null, gt: now },
        },
        data: {
          lastErrorCode: normalized.code,
          lastErrorClass: normalized.errorClass,
        },
      });
      if (fenced.count !== 1) {
        throw new StorageConsistencyLeaseLostError(current.id, current.leaseGeneration);
      }
    });
  }

  async noteBackfillCandidateAbsent(
    objectId: string,
    operationId: string | null,
    error: unknown,
    now: Date = new Date(),
  ): Promise<void> {
    const normalized = normalizeStorageError(error);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "storage_objects" WHERE "id" = ${objectId} FOR UPDATE
      `);
      const object = await tx.storageObject.findUnique({ where: { id: objectId } });
      if (!object) {
        throw new StorageConsistencyInvariantError(`absent candidate disappeared id=${objectId}`);
      }
      if (
        object.source !== 'backfill' ||
        !['legacy_unverified', 'provider_unknown'].includes(object.state)
      ) {
        throw new StorageConsistencyInvariantError('absent backfill candidate state rejected');
      }
      let operation: StorageObjectOperation | null = null;
      if (operationId) {
        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "storage_object_operations"
          WHERE "id" = ${operationId}
          FOR UPDATE
        `);
        operation = await tx.storageObjectOperation.findUnique({ where: { id: operationId } });
        if (
          !operation ||
          operation.storageObjectId !== object.id ||
          operation.kind !== 'backfill_verify'
        ) {
          throw new StorageConsistencyInvariantError('absent candidate operation drifted');
        }
      }
      const objectUpdated = await tx.storageObject.updateMany({
        where: { id: object.id, source: 'backfill', state: object.state },
        data: {
          state: 'provider_unknown',
          ...unverifiedLocatorAfterAbsent(object),
          lastProviderCheckedAt: now,
          lastErrorCode: normalized.code,
          lastErrorClass: normalized.errorClass,
          version: { increment: 1 },
        },
      });
      if (objectUpdated.count !== 1) {
        throw new StorageConsistencyInvariantError('absent candidate object CAS lost');
      }
      if (operation && ['pending', 'processing'].includes(operation.status)) {
        const operationUpdated = await tx.storageObjectOperation.updateMany({
          where: { id: operation.id, status: operation.status },
          data: {
            effectState: 'provider_unknown',
            lastErrorCode: normalized.code,
            lastErrorClass: normalized.errorClass,
          },
        });
        if (operationUpdated.count !== 1) {
          throw new StorageConsistencyInvariantError('absent candidate operation CAS lost');
        }
      }
    });
  }

  async noteBackfillCandidateAbsentClaimed(
    operation: ClaimedStorageOperationWithObject,
    error: unknown,
    now: Date = new Date(),
  ): Promise<void> {
    const normalized = normalizeStorageError(error);
    await this.prisma.$transaction(async (tx) => {
      const current = await this.lockClaimedForUpdate(tx, operation, { now });
      if (
        current.kind !== 'backfill_verify' ||
        current.storageObject.source !== 'backfill' ||
        !['legacy_unverified', 'provider_unknown'].includes(current.storageObject.state)
      ) {
        throw new StorageConsistencyInvariantError('absent claimed candidate state rejected');
      }
      const objectUpdated = await tx.storageObject.updateMany({
        where: {
          id: current.storageObjectId,
          state: current.storageObject.state,
          source: 'backfill',
        },
        data: {
          state: 'provider_unknown',
          ...unverifiedLocatorAfterAbsent(current.storageObject),
          lastProviderCheckedAt: now,
          lastErrorCode: normalized.code,
          lastErrorClass: normalized.errorClass,
          version: { increment: 1 },
        },
      });
      if (objectUpdated.count !== 1) {
        throw new StorageConsistencyInvariantError('absent claimed candidate object CAS lost');
      }
      const fenced = await tx.storageObjectOperation.updateMany({
        where: {
          ...storageFenceWhere(current),
          leaseExpiresAt: { not: null, gt: now },
        },
        data: {
          effectState: 'provider_unknown',
          lastErrorCode: normalized.code,
          lastErrorClass: normalized.errorClass,
        },
      });
      if (fenced.count !== 1) {
        throw new StorageConsistencyLeaseLostError(current.id, current.leaseGeneration);
      }
    });
  }

  // 跨 Attachment/storage worker 的固定锁序：StorageObject → involved Operations。
  // 所有会同时写 object + operation 的终态都必须经本入口锁后重读；调用方传入的
  // claimed snapshot 只用于定位与 fencing，不得继续充当状态真相。
  async lockClaimedForUpdate(
    tx: Prisma.TransactionClient,
    operation: ClaimedStorageOperationWithObject,
    options: { now?: Date; relatedOperationIds?: readonly string[] } = {},
  ): Promise<ClaimedStorageOperationWithObject> {
    const now = options.now ?? new Date();
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "storage_objects"
      WHERE "id" = ${operation.storageObjectId}
      FOR UPDATE
    `);
    const object = await tx.storageObject.findUnique({
      where: { id: operation.storageObjectId },
    });
    if (!object) {
      throw new StorageConsistencyInvariantError(
        `claimed object disappeared id=${operation.storageObjectId}`,
      );
    }

    const operationIds = [
      ...new Set([operation.id, ...(options.relatedOperationIds ?? [])]),
    ].sort();
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "storage_object_operations"
      WHERE "id" IN (${Prisma.join(operationIds)})
      ORDER BY "id"
      FOR UPDATE
    `);
    const current = await tx.storageObjectOperation.findFirst({
      where: {
        ...storageFenceWhere(operation),
        leaseExpiresAt: { not: null, gt: now },
      },
    });
    if (!current || !hasFence(current)) {
      throw new StorageConsistencyLeaseLostError(operation.id, operation.leaseGeneration);
    }
    const active = await tx.storageObjectOperation.findMany({
      where: {
        storageObjectId: operation.storageObjectId,
        status: { in: ['pending', 'processing'] },
      },
      select: { id: true },
    });
    if (active.length !== 1 || active[0]?.id !== current.id) {
      throw new StorageConsistencyLeaseLostError(operation.id, operation.leaseGeneration);
    }
    return { ...current, storageObject: object };
  }

  async refreshClaimed(
    operation: ClaimedStorageOperationWithObject,
    now: Date = new Date(),
  ): Promise<ClaimedStorageOperationWithObject> {
    return this.prisma.$transaction((tx) => this.lockClaimedForUpdate(tx, operation, { now }));
  }

  async markMissing(objectId: string, now: Date = new Date()): Promise<void> {
    await this.prisma.storageObject.updateMany({
      where: { id: objectId, state: 'available' },
      data: {
        state: 'missing',
        missingAt: now,
        lastProviderCheckedAt: now,
        lastErrorCode: 'PROVIDER_OBJECT_NOT_FOUND',
        lastErrorClass: 'StorageObjectMissing',
        version: { increment: 1 },
      },
    });
  }

  async markIntegrityMismatch(
    objectId: string,
    error: unknown,
    now: Date = new Date(),
  ): Promise<boolean> {
    const normalized = normalizeStorageError(error);
    const updated = await this.prisma.storageObject.updateMany({
      where: { id: objectId, state: 'available' },
      data: {
        state: 'integrity_mismatch',
        lastProviderCheckedAt: now,
        lastErrorCode: normalized.code,
        lastErrorClass: normalized.errorClass,
        version: { increment: 1 },
      },
    });
    return updated.count === 1;
  }

  async noteAvailableHead(
    objectId: string,
    head: HeadObjectResult,
    now: Date = new Date(),
  ): Promise<void> {
    if (!head.exists) {
      throw new StorageConsistencyInvariantError('cannot record absent HEAD as available');
    }
    await this.prisma.storageObject.updateMany({
      where: { id: objectId, state: 'available' },
      data: {
        actualSize: head.size === undefined ? undefined : BigInt(head.size),
        actualMime: head.contentType,
        etag: head.etag,
        presentAt: now,
        lastProviderCheckedAt: now,
        lastErrorCode: null,
        lastErrorClass: null,
        version: { increment: 1 },
      },
    });
  }

  async claim(
    leaseOwner: string,
    options: {
      now?: Date;
      limit?: number;
      leaseMs?: number;
      eventKey?: string;
      objectKey?: string;
      kind?: StorageOperationKind;
      manualOnly?: boolean;
    } = {},
  ): Promise<ClaimedStorageOperationWithObject[]> {
    const now = options.now ?? new Date();
    const limit = Math.min(Math.max(options.limit ?? STORAGE_OPERATION_CLAIM_BATCH, 1), 100);
    const leaseExpiresAt = new Date(
      now.getTime() + (options.leaseMs ?? STORAGE_OPERATION_LEASE_MS),
    );
    return this.prisma.$transaction(async (tx) => {
      const exhaustedWhere = exhaustedClaimWhere(options, now);
      const exhaustedCandidates = await tx.storageObjectOperation.findMany({
        where: exhaustedWhere,
        select: { id: true, storageObjectId: true, kind: true },
      });
      if (exhaustedCandidates.length > 0) {
        const objectIds = [
          ...new Set(exhaustedCandidates.map((row) => row.storageObjectId)),
        ].sort();
        const operationIds = exhaustedCandidates.map((row) => row.id).sort();
        // exhausted 归档也遵循 Object → Operation；否则会和 confirm/JIT promote
        // 的 Object → Operation 形成 operation-first 死锁环。
        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "storage_objects"
          WHERE "id" IN (${Prisma.join(objectIds)})
          ORDER BY "id"
          FOR UPDATE
        `);
        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "storage_object_operations"
          WHERE "id" IN (${Prisma.join(operationIds)})
          ORDER BY "id"
          FOR UPDATE
        `);
      }
      // 锁等待期间目标可能已续租/终结；必须在锁内完整重放 eventKey/objectKey/
      // kind/manualOnly scope，绝不沿用锁前 candidate 或误杀无关 processing 行。
      const exhausted =
        exhaustedCandidates.length === 0
          ? []
          : await tx.storageObjectOperation.findMany({
              where: exhaustedWhere,
              select: { id: true, storageObjectId: true, kind: true },
            });
      if (exhausted.length > 0) {
        const failedDeleteObjectIds = exhausted
          .filter((row) => row.kind === 'attachment_delete' || row.kind === 'orphan_delete')
          .map((row) => row.storageObjectId);
        if (failedDeleteObjectIds.length > 0) {
          await tx.storageObject.updateMany({
            where: { id: { in: failedDeleteObjectIds }, state: 'delete_pending' },
            data: { state: 'delete_failed', version: { increment: 1 } },
          });
        }
        await tx.storageObjectOperation.updateMany({
          where: { id: { in: exhausted.map((row) => row.id) } },
          data: {
            status: 'dead',
            deadAt: now,
            completedAt: now,
            leaseOwner: null,
            leaseAcquiredAt: null,
            leaseRenewedAt: null,
            leaseExpiresAt: null,
            lastErrorCode: 'MAX_ATTEMPTS_EXHAUSTED',
            lastErrorClass: 'StorageConsistencyMaxAttempts',
          },
        });
      }

      const eventFilter = options.eventKey
        ? Prisma.sql`AND op."eventKey" = ${options.eventKey}`
        : Prisma.empty;
      const keyFilter = options.objectKey
        ? Prisma.sql`AND obj."key" = ${options.objectKey}`
        : Prisma.empty;
      const kindFilter = options.kind ? Prisma.sql`AND op."kind" = ${options.kind}` : Prisma.empty;
      const manualFilter = options.manualOnly
        ? Prisma.sql`AND op."kind" IN ('manual_relocate', 'manual_attest_absent')`
        : Prisma.empty;
      const candidates = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT op."id"
        FROM "storage_object_operations" op
        JOIN "storage_objects" obj ON obj."id" = op."storageObjectId"
        WHERE (
          (op."status" = 'pending' AND op."availableAt" <= ${now})
          OR (
            op."status" = 'processing'
            AND op."leaseExpiresAt" IS NOT NULL
            AND op."leaseExpiresAt" <= ${now}
          )
        )
        AND op."attempts" < ${STORAGE_OPERATION_MAX_ATTEMPTS}
        ${eventFilter}
        ${keyFilter}
        ${kindFilter}
        ${manualFilter}
        ORDER BY op."availableAt" ASC, op."createdAt" ASC
        FOR UPDATE OF op SKIP LOCKED
        LIMIT ${limit}
      `);
      if (candidates.length === 0) return [];
      const ids = candidates.map((row) => row.id);
      await tx.storageObjectOperation.updateMany({
        where: { id: { in: ids } },
        data: {
          status: 'processing',
          attempts: { increment: 1 },
          leaseOwner,
          leaseGeneration: { increment: 1 },
          leaseAcquiredAt: now,
          leaseRenewedAt: null,
          leaseExpiresAt,
          lastErrorCode: null,
          lastErrorClass: null,
        },
      });
      const rows = await tx.storageObjectOperation.findMany({
        where: { id: { in: ids }, leaseOwner, leaseAcquiredAt: now },
        include: { storageObject: true },
        orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }],
      });
      return rows.filter(hasCompleteFence);
    });
  }

  async renewLease(
    operation: ClaimedStorageOperationWithObject,
    now: Date = new Date(),
    leaseMs: number = STORAGE_OPERATION_LEASE_MS,
  ): Promise<ClaimedStorageOperationWithObject> {
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const updated = await this.prisma.storageObjectOperation.updateMany({
      where: { ...storageFenceWhere(operation), leaseExpiresAt: { not: null, gt: now } },
      data: { leaseRenewedAt: now, leaseExpiresAt },
    });
    if (updated.count !== 1) {
      throw new StorageConsistencyLeaseLostError(operation.id, operation.leaseGeneration);
    }
    const row = await this.prisma.storageObjectOperation.findUniqueOrThrow({
      where: { id: operation.id },
    });
    if (!hasFence(row)) {
      throw new StorageConsistencyLeaseLostError(operation.id, operation.leaseGeneration);
    }
    return { ...row, storageObject: operation.storageObject };
  }

  async markEffectState(
    operation: ClaimedStorageOperationWithObject,
    effectState: StorageEffectState,
    now: Date = new Date(),
  ): Promise<void> {
    if (!STORAGE_EFFECT_STATES.includes(effectState)) {
      throw new StorageConsistencyInvariantError(`invalid effectState=${effectState}`);
    }
    const updated = await this.prisma.storageObjectOperation.updateMany({
      where: { ...storageFenceWhere(operation), leaseExpiresAt: { not: null, gt: now } },
      data: {
        effectState,
        ...(effectState === 'effect_started' ? { effectStartedAt: now } : {}),
        ...(effectState === 'effect_succeeded' ? { effectCompletedAt: now } : {}),
      },
    });
    if (updated.count !== 1) {
      throw new StorageConsistencyLeaseLostError(operation.id, operation.leaseGeneration);
    }
  }

  async ack(
    operation: ClaimedStorageOperationWithObject,
    effectState: StorageEffectState,
    now: Date = new Date(),
  ): Promise<void> {
    const updated = await this.prisma.storageObjectOperation.updateMany({
      where: { ...storageFenceWhere(operation), leaseExpiresAt: { not: null, gt: now } },
      data: {
        status: 'succeeded',
        effectState,
        completedAt: now,
        ...(effectState === 'effect_succeeded' ? { effectCompletedAt: now } : {}),
        leaseOwner: null,
        leaseAcquiredAt: null,
        leaseRenewedAt: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        lastErrorClass: null,
      },
    });
    if (updated.count !== 1) {
      throw new StorageConsistencyLeaseLostError(operation.id, operation.leaseGeneration);
    }
  }

  async nack(
    operation: ClaimedStorageOperationWithObject,
    error: unknown,
    now: Date = new Date(),
    effectState?: StorageEffectState,
  ): Promise<'pending' | 'dead'> {
    const normalized = normalizeStorageError(error);
    return this.prisma.$transaction(async (tx) => {
      const current = await this.lockClaimedForUpdate(tx, operation, { now });
      const dead = current.attempts >= STORAGE_OPERATION_MAX_ATTEMPTS;
      if (dead && (current.kind === 'attachment_delete' || current.kind === 'orphan_delete')) {
        await tx.storageObject.updateMany({
          where: { id: current.storageObjectId, state: 'delete_pending' },
          data: { state: 'delete_failed', version: { increment: 1 } },
        });
      }
      const updated = await tx.storageObjectOperation.updateMany({
        where: {
          ...storageFenceWhere(current),
          leaseExpiresAt: { not: null, gt: now },
        },
        data: dead
          ? {
              status: 'dead',
              deadAt: now,
              completedAt: now,
              leaseOwner: null,
              leaseAcquiredAt: null,
              leaseRenewedAt: null,
              leaseExpiresAt: null,
              effectState,
              lastErrorCode: normalized.code,
              lastErrorClass: normalized.errorClass,
            }
          : {
              status: 'pending',
              effectState,
              availableAt: new Date(now.getTime() + storageRetryDelayMs(operation.attempts)),
              leaseOwner: null,
              leaseAcquiredAt: null,
              leaseRenewedAt: null,
              leaseExpiresAt: null,
              lastErrorCode: normalized.code,
              lastErrorClass: normalized.errorClass,
            },
      });
      if (updated.count !== 1) {
        throw new StorageConsistencyLeaseLostError(current.id, current.leaseGeneration);
      }
      return dead ? 'dead' : 'pending';
    });
  }

  async deadLetter(
    operation: ClaimedStorageOperationWithObject,
    error: unknown,
    now: Date = new Date(),
  ): Promise<void> {
    const normalized = normalizeStorageError(error);
    await this.prisma.$transaction(async (tx) => {
      const current = await this.lockClaimedForUpdate(tx, operation, { now });
      if (current.kind === 'attachment_delete' || current.kind === 'orphan_delete') {
        await tx.storageObject.updateMany({
          where: { id: current.storageObjectId, state: 'delete_pending' },
          data: { state: 'delete_failed', version: { increment: 1 } },
        });
      }
      const updated = await tx.storageObjectOperation.updateMany({
        where: {
          ...storageFenceWhere(current),
          leaseExpiresAt: { not: null, gt: now },
        },
        data: {
          status: 'dead',
          completedAt: now,
          deadAt: now,
          leaseOwner: null,
          leaseAcquiredAt: null,
          leaseRenewedAt: null,
          leaseExpiresAt: null,
          lastErrorCode: normalized.code,
          lastErrorClass: normalized.errorClass,
        },
      });
      if (updated.count !== 1) {
        throw new StorageConsistencyLeaseLostError(current.id, current.leaseGeneration);
      }
    });
  }

  async assertFence(
    tx: Prisma.TransactionClient,
    operation: ClaimedStorageOperationWithObject,
    now: Date = new Date(),
  ): Promise<void> {
    const row = await tx.storageObjectOperation.findFirst({
      where: { ...storageFenceWhere(operation), leaseExpiresAt: { not: null, gt: now } },
      select: { id: true },
    });
    if (!row) {
      throw new StorageConsistencyLeaseLostError(operation.id, operation.leaseGeneration);
    }
  }

  async completeClaimed(
    tx: Prisma.TransactionClient,
    operation: ClaimedStorageOperationWithObject,
    effectState: StorageEffectState,
    options: { payload?: Prisma.InputJsonValue; now?: Date } = {},
  ): Promise<void> {
    const now = options.now ?? new Date();
    const updated = await tx.storageObjectOperation.updateMany({
      where: { ...storageFenceWhere(operation), leaseExpiresAt: { not: null, gt: now } },
      data: {
        status: 'succeeded',
        effectState,
        payload: options.payload,
        completedAt: now,
        effectCompletedAt: effectState === 'effect_succeeded' ? now : undefined,
        leaseOwner: null,
        leaseAcquiredAt: null,
        leaseRenewedAt: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        lastErrorClass: null,
      },
    });
    if (updated.count !== 1) {
      throw new StorageConsistencyLeaseLostError(operation.id, operation.leaseGeneration);
    }
  }

  async findOperationByEventKey(eventKey: string): Promise<StorageObjectOperation | null> {
    return this.prisma.storageObjectOperation.findUnique({ where: { eventKey } });
  }

  async loadOperationObject(operation: StorageObjectOperation): Promise<StorageObject> {
    return this.prisma.storageObject.findUniqueOrThrow({
      where: { id: operation.storageObjectId },
    });
  }

  async purgeExpiredDeleteReplays(now: Date = new Date(), limit = 500): Promise<number> {
    const rows = await this.prisma.storageObjectOperation.findMany({
      where: {
        kind: 'attachment_delete',
        responsePurgedAt: null,
        responseSnapshotExpiresAt: { not: null, lte: now },
      },
      orderBy: { responseSnapshotExpiresAt: 'asc' },
      take: Math.min(Math.max(limit, 1), 2_000),
    });
    let purged = 0;
    for (const row of rows) {
      purged += await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "storage_object_operations"
          WHERE "id" = ${row.id}
          FOR UPDATE
        `);
        const current = await tx.storageObjectOperation.findUnique({ where: { id: row.id } });
        if (
          !current ||
          current.responsePurgedAt !== null ||
          current.responseSnapshotExpiresAt === null ||
          current.responseSnapshotExpiresAt.getTime() > now.getTime()
        ) {
          return 0;
        }
        const parsed = parseStorageOperationPayload(
          'attachment_delete',
          current.payloadVersion,
          current.payload,
        ) as AttachmentDeleteOperationPayload;
        await tx.storageObjectOperation.update({
          where: { id: current.id },
          data: {
            payload: toStorageJson(purgeDeletePayload(parsed)),
            responsePurgedAt: now,
          },
        });
        return 1;
      });
    }
    return purged;
  }

  terminalDeletePayload(payload: AttachmentDeleteOperationPayload): Prisma.InputJsonValue {
    return toStorageJson(sanitizeDeletePayloadAfterTerminal(payload));
  }

  locatorFor(object: StorageObject): StorageObjectLocator {
    return storageLocatorFromObject(object);
  }
}

function unverifiedLocatorAfterAbsent(object: StorageObject): {
  providerType: 'LOCAL' | null;
  bucket: null;
  region: null;
  localNamespace: null;
} {
  // Migration may retain LOCAL as a provider hint while its namespace is unknown. Preserve that
  // restriction after a failed current-LOCAL candidate; a fully pinned legacy candidate was not
  // verified, so all of its locator fields are discarded before the next JIT candidate attempt.
  const retainsLocalHint =
    object.state === 'provider_unknown' &&
    object.providerType === 'LOCAL' &&
    object.bucket === null &&
    object.region === null &&
    object.localNamespace === null;
  return {
    providerType: retainsLocalHint ? 'LOCAL' : null,
    bucket: null,
    region: null,
    localNamespace: null,
  };
}

export function isStorageConsistencyWorkerEntrypoint(
  argv: readonly string[] = process.argv,
): boolean {
  return argv.some((argument) =>
    /(?:^|[/\\])storage-consistency-worker(?:\.[cm]?[jt]s)?$/.test(argument),
  );
}

function hasFence(row: StorageObjectOperation): row is ClaimedStorageObjectOperation {
  return (
    row.status === 'processing' &&
    row.leaseOwner !== null &&
    row.leaseGeneration > 0 &&
    row.leaseAcquiredAt !== null &&
    row.leaseExpiresAt !== null
  );
}

function exhaustedClaimWhere(
  options: {
    eventKey?: string;
    objectKey?: string;
    kind?: StorageOperationKind;
    manualOnly?: boolean;
  },
  now: Date,
): Prisma.StorageObjectOperationWhereInput {
  const scope: Prisma.StorageObjectOperationWhereInput[] = [];
  if (options.eventKey) scope.push({ eventKey: options.eventKey });
  if (options.objectKey) scope.push({ storageObject: { key: options.objectKey } });
  if (options.kind) scope.push({ kind: options.kind });
  if (options.manualOnly) {
    scope.push({ kind: { in: ['manual_relocate', 'manual_attest_absent'] } });
  }
  return {
    status: 'processing',
    attempts: { gte: STORAGE_OPERATION_MAX_ATTEMPTS },
    leaseExpiresAt: { not: null, lte: now },
    ...(scope.length > 0 ? { AND: scope } : {}),
  };
}

function hasCompleteFence(
  row: StorageObjectOperation & { storageObject: StorageObject },
): row is ClaimedStorageOperationWithObject {
  return hasFence(row);
}

export function storageFenceWhere(
  operation: ClaimedStorageObjectOperation,
): Prisma.StorageObjectOperationWhereInput {
  return {
    id: operation.id,
    status: 'processing',
    leaseOwner: operation.leaseOwner,
    leaseGeneration: operation.leaseGeneration,
  };
}

function locatorData(locator: StorageObjectLocator): {
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

function assertPreparedObjectMatches(
  object: StorageObject,
  input: PrepareStorageUploadInput,
): void {
  if (
    object.source !== input.source ||
    object.expectedSize !== BigInt(input.expectedSize) ||
    object.expectedMime !== input.expectedMime ||
    object.providerType !== input.locator.providerType ||
    object.bucket !== input.locator.bucket ||
    object.region !== input.locator.region ||
    object.localNamespace !== input.locator.localNamespace
  ) {
    throw new StorageConsistencyInvariantError(`key reused with different object identity`);
  }
}

function validateHash(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new StorageConsistencyInvariantError('requestHash must be sha256 hex');
  }
}
