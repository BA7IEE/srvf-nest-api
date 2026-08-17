import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { STORAGE_UNBOUND_GRACE_MS } from '../storage/storage-consistency.types';
import { StorageSettingsService } from '../storage/storage-settings.service';
import {} from '../storage/upload-token.util';
import appConfig from '../../config/app.config';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AttachmentStorageOrchestrator } from './attachment-storage-orchestrator';
import type {} from './attachment-storage.types';
import {} from './attachment-validation';
import {} from './attachments.dto';
import {
  AttachmentAccessService,
  ATTENDANCE_IMPORT_PREVIEW_MAX_BYTES,
  ATTENDANCE_IMPORT_PREVIEW_MIME,
  ATTENDANCE_IMPORT_PREVIEW_OWNER_TYPE,
  AttendanceImportPreviewAttachmentFinalized,
  AttendanceImportPreviewAttachmentPrepared,
  AttendanceImportPreviewAttachmentValidated,
  AttendanceImportPreviewAttachmentVerified,
  AttendanceImportPreviewAttachmentView,
  AttendanceImportPreviewUploadContextState,
} from './attachment-access.service';

/*
 * 考勤导入预览上传链路(trusted):与报名上传同构的四段,外加按 key 读回字节。
 *
 * ⚠️ 与报名上传刻意**不合并**:两者的属主表、状态闸与回执形状都不同,
 * 合并会让「哪条链路」变成读代码时的猜测。
 *
 * (Phase 6-B 第三域第七刀,§3.2;仅"搬家",判权 / 锁序 / 状态闸 / 审计逐字不变。)
 */
@Injectable()
export class AttachmentImportPreviewUploadService {
  private readonly attendanceImportPreviewUploadContexts = new WeakMap<
    object,
    AttendanceImportPreviewUploadContextState
  >();

  constructor(
    private readonly prisma: PrismaService,
    // 共享校验 / 判权 / 序列化 / key 生成:调用点仍在本类各方法体内。
    private readonly access: AttachmentAccessService,
    private readonly storageConsistency: AttachmentStorageOrchestrator,
    private readonly storageSettings: StorageSettingsService,
    @Inject(appConfig.KEY) private readonly cfg: ConfigType<typeof appConfig>,
  ) {}

  // ===== B6 attendance-import-preview trusted facade =====
  // CSV 只能经这个内部 owner 写入。它不依赖可运营的 AttachmentTypeConfig，避免把 B6
  // 导入能力错误暴露到 generic attachment API；泛化入口仍会按 internal owner fail-closed。
  async validateAttendanceImportPreviewUploadOutsideTransactionTrusted(input: {
    previewJobId: string;
    originalName: string;
    mime: string;
    size: number;
    body: Buffer;
    fileDigest: string;
    uploadedByUserId: string;
    user: CurrentUserPayload;
  }): Promise<AttendanceImportPreviewAttachmentValidated> {
    if (
      input.mime !== ATTENDANCE_IMPORT_PREVIEW_MIME ||
      !Number.isSafeInteger(input.size) ||
      input.size < 0 ||
      input.body.length !== input.size ||
      input.size > ATTENDANCE_IMPORT_PREVIEW_MAX_BYTES
    ) {
      throw new BizException(
        input.mime !== ATTENDANCE_IMPORT_PREVIEW_MIME
          ? BizCode.ATTACHMENT_MIME_NOT_ALLOWED
          : BizCode.ATTACHMENT_SIZE_EXCEEDED,
      );
    }
    if (
      !/^[0-9a-f]{64}$/u.test(input.fileDigest) ||
      createHash('sha256').update(input.body).digest('hex') !== input.fileDigest
    ) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
    this.access.assertNoPii({ originalName: input.originalName });
    this.storageConsistency.validateUploadBufferOutsideTransaction(input.mime, input.body);

    const settings = await this.storageSettings.getActiveSettings();
    const key = this.access.generateAttachmentKey(settings?.envPrefix ?? this.cfg.env, input.mime);
    const locator = await this.storageConsistency.resolveUploadLocatorForTransaction(key);
    return this.issueAttendanceImportPreviewUploadContext({
      stage: 'validated',
      identity: {
        key,
        ownerType: ATTENDANCE_IMPORT_PREVIEW_OWNER_TYPE,
        ownerId: input.previewJobId,
        originalName: input.originalName,
        mime: input.mime,
        size: input.size,
        uploadedByUserId: input.uploadedByUserId,
      },
      body: input.body,
      locator,
      user: { ...input.user },
      fileDigest: input.fileDigest,
    }) as AttendanceImportPreviewAttachmentValidated;
  }

  /** Caller holds Activity root then its import-preview job row. */
  async prepareAttendanceImportPreviewUploadInTransactionTrusted(
    tx: Prisma.TransactionClient,
    context: AttendanceImportPreviewAttachmentValidated,
  ): Promise<AttendanceImportPreviewAttachmentPrepared> {
    const state = this.consumeAttendanceImportPreviewUploadContext(context, 'validated');
    const prepared = await this.storageConsistency.prepareUploadInTransaction(
      tx,
      state.identity,
      'attachment_legacy',
      new Date(Date.now() + STORAGE_UNBOUND_GRACE_MS),
      state.locator,
    );
    return this.issueAttendanceImportPreviewUploadContext({
      ...state,
      stage: 'prepared',
      prepared,
    }) as AttendanceImportPreviewAttachmentPrepared;
  }

  /** Provider put + pinned HEAD proof; deliberately outside every activity transaction. */
  async putAttendanceImportPreviewUploadAndVerifyOutsideTransactionTrusted(
    context: AttendanceImportPreviewAttachmentPrepared,
  ): Promise<AttendanceImportPreviewAttachmentVerified> {
    const state = this.consumeAttendanceImportPreviewUploadContext(context, 'prepared');
    const head = await this.storageConsistency.putUploadObjectAtAndVerifyOutsideTransaction(
      state.identity,
      'attachment_legacy',
      state.locator,
      state.body,
    );
    return this.issueAttendanceImportPreviewUploadContext({
      ...state,
      stage: 'verified',
      head,
    }) as AttendanceImportPreviewAttachmentVerified;
  }

  /** Caller still holds the exact Activity root and preview job, so attachment/job/audit commit together. */
  async finalizeAttendanceImportPreviewUploadInTransactionTrusted(
    tx: Prisma.TransactionClient,
    context: AttendanceImportPreviewAttachmentVerified,
    auditMeta: AuditMeta,
  ): Promise<AttendanceImportPreviewAttachmentFinalized> {
    const state = this.consumeAttendanceImportPreviewUploadContext(context, 'verified');
    const row = await this.storageConsistency.finalizeUploadInTransaction(
      tx,
      {
        identity: state.identity,
        requestHash: state.prepared.requestHash,
        data: {
          key: state.identity.key,
          originalName: state.identity.originalName,
          mime: state.identity.mime,
          size: state.identity.size,
          uploadedBy: state.identity.uploadedByUserId,
          ownerType: state.identity.ownerType,
          ownerId: state.identity.ownerId,
          originalUploaderName: state.user.username,
          checksum: state.fileDigest,
          etag: state.head.etag ?? null,
        },
        auditKind: 'legacy',
        actorRoleSnap: state.user.role,
        scope: null,
        ownerTable: 'activity_batch_jobs',
        auditMeta,
      },
      state.head,
    );
    return this.issueAttendanceImportPreviewUploadContext({
      ...state,
      stage: 'finalized',
      row,
    }) as AttendanceImportPreviewAttachmentFinalized;
  }

  attendanceImportPreviewUploadResponseTrusted(
    context: AttendanceImportPreviewAttachmentFinalized,
  ): AttendanceImportPreviewAttachmentView {
    const state = this.requireAttendanceImportPreviewUploadContext(context, 'finalized');
    return {
      attachmentId: state.row.id,
      fileDigest: state.fileDigest,
      size: state.row.size,
    };
  }

  /**
   * B6 execute-only read capability. It resolves a single internal owner, verifies its persisted
   * digest/size before asking the storage facade for the exact bounded object bytes, and never
   * returns a key, locator, URL, or generic download stream.
   */
  async readAttendanceImportPreviewBytesOutsideTransactionTrusted(input: {
    previewJobId: string;
    expectedFileDigest: string;
  }): Promise<Buffer | null> {
    if (!/^[0-9a-f]{64}$/u.test(input.expectedFileDigest)) return null;
    const attachments = await this.prisma.attachment.findMany({
      where: {
        ownerType: ATTENDANCE_IMPORT_PREVIEW_OWNER_TYPE,
        ownerId: input.previewJobId,
        mime: ATTENDANCE_IMPORT_PREVIEW_MIME,
      },
      select: { id: true, size: true, checksum: true },
      orderBy: { id: 'asc' },
      take: 2,
    });
    const attachment = attachments[0];
    if (
      attachments.length !== 1 ||
      attachment === undefined ||
      attachment.size < 0 ||
      attachment.size > ATTENDANCE_IMPORT_PREVIEW_MAX_BYTES ||
      attachment.checksum !== input.expectedFileDigest
    ) {
      return null;
    }
    const read = await this.storageConsistency.readAttendanceImportPreviewBytesOutsideTransaction({
      previewJobId: input.previewJobId,
      attachmentId: attachment.id,
      maxBytes: ATTENDANCE_IMPORT_PREVIEW_MAX_BYTES,
    });
    if (read.body === null || read.actualSize !== attachment.size) return null;
    return read.body;
  }

  private issueAttendanceImportPreviewUploadContext(
    state: AttendanceImportPreviewUploadContextState,
  ): object {
    const context = Object.freeze(Object.create(null)) as object;
    this.attendanceImportPreviewUploadContexts.set(context, state);
    return context;
  }

  consumeAttendanceImportPreviewUploadContext<
    Stage extends AttendanceImportPreviewUploadContextState['stage'],
  >(
    context: object,
    stage: Stage,
  ): Extract<AttendanceImportPreviewUploadContextState, { stage: Stage }> {
    const state = this.requireAttendanceImportPreviewUploadContext(context, stage);
    this.attendanceImportPreviewUploadContexts.delete(context);
    return state;
  }

  requireAttendanceImportPreviewUploadContext<
    Stage extends AttendanceImportPreviewUploadContextState['stage'],
  >(
    context: object,
    stage: Stage,
  ): Extract<AttendanceImportPreviewUploadContextState, { stage: Stage }> {
    const state = this.attendanceImportPreviewUploadContexts.get(context);
    if (!state || state.stage !== stage) throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    return state as Extract<AttendanceImportPreviewUploadContextState, { stage: Stage }>;
  }
}
