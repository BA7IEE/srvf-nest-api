import { Injectable } from '@nestjs/common';
import { Prisma, type StorageObjectOperation } from '@prisma/client';

import { PrismaService } from '../../database/prisma.service';
import {
  StorageObjectLedgerService,
  storageFenceWhere,
} from '../storage/storage-object-ledger.service';
import {
  parseStorageOperationPayload,
  sanitizeDeletePayloadAfterTerminal,
  toStorageJson,
  type AttachmentDeleteOperationPayload,
} from '../storage/storage-operation-payload';
import {
  type ClaimedStorageOperationWithObject,
  StorageConsistencyInvariantError,
  StorageConsistencyLeaseLostError,
} from '../storage/storage-consistency.types';
import { AttachmentAuditRecorder } from './attachment-audit-recorder';
import { lockContentDeleteFinalizationBoundary } from './attachment-content-delete-boundary';
import { terminalSucceededData } from './attachment-storage-invariants';
import { attachmentSelect } from './attachments.select';

/*
 * 人工缺失认定(manual_attest_absent)的执行侧(Phase 6-B 第四域第五刀 —— manual 族收官)。
 *
 * 语义:一条 attachment_delete 操作已 dead(供应商侧删除反复失败),运维人工核实对象
 * 确实不存在后,用本操作把系统状态推到终态 —— 物理删 Attachment 行、对象置 absent、
 * 原始 delete 操作与本 manual 操作双双置 succeeded。**这是不可逆补偿**,故围栏条件极密。
 *
 * ⚠️ 锁序不变(编排器文件头的锁序台账是全局单点,此处不复制、只引用):
 * 本服务实现台账中
 *   `finalizeManualAttestedDelete | (Content root for content owners) -> Attachment
 *    -> StorageObject -> original/manual Operations`
 * 一行。四段的**先后逐字保留**:先 `lockContentDeleteFinalizationBoundary`(内容根)、
 * 再 attachments 行锁、再 `lockClaimedForUpdate`(对象 + 操作)、最后两次 updateMany。
 * 台账原文:「A path involving an existing Attachment must never acquire Attachment after
 * Object/Operation」—— 把内容根或 Attachment 锁挪到 lockClaimedForUpdate 之后会静默
 * 破坏全局锁序,且**不会有任何编译错或测试失败**。
 *
 * 本服务自开事务、不接受外部 tx,迁出前后都是事务起点,故迁移不改变任何加锁顺序。
 */
@Injectable()
export class AttachmentManualAttestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: StorageObjectLedgerService,
    private readonly auditRecorder: AttachmentAuditRecorder,
  ) {}

  async execute(operation: ClaimedStorageOperationWithObject): Promise<void> {
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
    await this.finalize(operation, original, payload);
  }

  private async finalize(
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
      await lockContentDeleteFinalizationBoundary(tx, payload.response, candidateAttachmentId);
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
}
