import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  AttachmentsService,
  type AttendanceImportPreviewAttachmentFinalized,
  type AttendanceImportPreviewAttachmentPrepared,
  type AttendanceImportPreviewAttachmentValidated,
  type AttendanceImportPreviewAttachmentVerified,
} from '../attachments/attachments.service';

/**
 * B6 CSV 的唯一附件门面。它不把 storage key、locator、下载 URL 或 body 交给 controller，
 * 只在 ImportPreview 聚合两次 Activity 根锁之间推进既有 durable-upload 四阶段句柄。
 */
@Injectable()
export class AttendanceImportAttachmentService {
  constructor(private readonly attachments: AttachmentsService) {}

  validateOutsideTransaction(input: {
    previewJobId: string;
    originalName: string;
    mime: string;
    size: number;
    body: Buffer;
    fileDigest: string;
    uploadedByUserId: string;
    user: CurrentUserPayload;
  }): Promise<AttendanceImportPreviewAttachmentValidated> {
    return this.attachments.validateAttendanceImportPreviewUploadOutsideTransactionTrusted(input);
  }

  prepareInTransaction(
    tx: Prisma.TransactionClient,
    context: AttendanceImportPreviewAttachmentValidated,
  ): Promise<AttendanceImportPreviewAttachmentPrepared> {
    return this.attachments.prepareAttendanceImportPreviewUploadInTransactionTrusted(tx, context);
  }

  putAndVerifyOutsideTransaction(
    context: AttendanceImportPreviewAttachmentPrepared,
  ): Promise<AttendanceImportPreviewAttachmentVerified> {
    return this.attachments.putAttendanceImportPreviewUploadAndVerifyOutsideTransactionTrusted(
      context,
    );
  }

  finalizeInTransaction(
    tx: Prisma.TransactionClient,
    context: AttendanceImportPreviewAttachmentVerified,
    auditMeta: AuditMeta,
  ): Promise<AttendanceImportPreviewAttachmentFinalized> {
    return this.attachments.finalizeAttendanceImportPreviewUploadInTransactionTrusted(
      tx,
      context,
      auditMeta,
    );
  }

  responseTrusted(context: AttendanceImportPreviewAttachmentFinalized): {
    attachmentId: string;
    fileDigest: string;
    size: number;
  } {
    return this.attachments.attendanceImportPreviewUploadResponseTrusted(context);
  }

  readForExecuteOutsideTransaction(input: {
    previewJobId: string;
    expectedFileDigest: string;
  }): Promise<Buffer | null> {
    return this.attachments.readAttendanceImportPreviewBytesOutsideTransactionTrusted(input);
  }
}
