import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import {
  parseStorageOperationPayload,
  toStorageJson,
  type ManualStorageOperationPayload,
} from '../storage/storage-operation-payload';
import {
  STORAGE_OPERATION_PAYLOAD_VERSION,
  StorageConsistencyInvariantError,
  storageRequestHash,
} from '../storage/storage-consistency.types';
import type {
  PrepareManualStorageAttestAbsentInput,
  PrepareManualStorageRelocateInput,
} from './attachment-storage.types';

/*
 * 人工运维操作的**受理侧**(Phase 6-B 第四域第四刀):把一次人工重定位 / 人工缺失认定
 * 登记成一条待执行的 manual 操作。执行侧另有其类(relocate 见
 * `attachment-manual-relocate.service.ts`),两侧以「登记 → 领取执行」为界。
 *
 * 编排器保留同名 public 方法作为**薄委托** —— 它是本模块对外的入口与 kind 分发器,
 * 调用面(storage-consistency-worker 与 e2e)因此逐字不变。
 *
 * ⚠️ 锁序不变(编排器文件头的锁序台账是全局单点,此处不复制、只引用):
 * 本服务实现台账中 `prepareManualOperation | StorageObject -> original/event/active
 * Operations (sorted id)` 一行。它**自开事务、不接受外部 tx**,迁出前后都是事务起点,
 * 故迁移不改变任何加锁顺序。两条 FOR UPDATE 的先后与 ORDER BY "id" 均逐字保留 ——
 * 其中 operations 那条的 `ORDER BY "id"` 是**死锁防线**(同一对象上的并发受理按同一顺序取锁),
 * 不是为了输出有序,删掉它不会有任何测试变红。
 */
@Injectable()
export class AttachmentManualIntakeService {
  constructor(private readonly prisma: PrismaService) {}

  async prepareRelocate(input: PrepareManualStorageRelocateInput): Promise<string> {
    const payload: ManualStorageOperationPayload = {
      operatorUserId: input.operatorUserId,
      reviewerUserId: input.reviewerUserId,
      reasonCode: input.reasonCode,
      evidenceRef: input.evidenceRef,
      verifiedAt: input.verifiedAt.toISOString(),
      targetLocator: input.targetLocator,
    };
    parseStorageOperationPayload('manual_relocate', STORAGE_OPERATION_PAYLOAD_VERSION, payload);
    return this.prepare('manual_relocate', input.replayOperationId, payload);
  }

  async prepareAttestAbsent(input: PrepareManualStorageAttestAbsentInput): Promise<string> {
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
    return this.prepare('manual_attest_absent', input.replayOperationId, payload);
  }

  private async prepare(
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
}
