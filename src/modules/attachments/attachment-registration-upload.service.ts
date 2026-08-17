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
import type {
  RegistrationUploadFinalized,
  RegistrationUploadPrepared,
  RegistrationUploadValidated,
  RegistrationUploadVerified,
} from './attachment-storage.types';
import {} from './attachment-validation';
import {} from './attachments.dto';
import {
  AttachmentAccessService,
  REGISTRATION_UPLOAD_ALLOWED_MIME,
  REGISTRATION_UPLOAD_MAX_BYTES,
  RegistrationUploadAttachmentView,
  RegistrationUploadContextState,
  RegistrationUploadSubmissionBinding,
} from './attachment-access.service';

/*
 * 报名上传链路(trusted):校验 → 建账 → 直传并取证 → 落账 → 回执,
 * 外加提交期核查与表单答案消费。
 *
 * ⚠️ 三个 context 方法(issue / require / consume)是**阶段令牌**:
 * 它们保证四段调用按序发生且中途不被换掉。绕过它们直接调下一段,类型上仍合法。
 *
 * (Phase 6-B 第三域第七刀,§3.2;仅"搬家",判权 / 锁序 / 状态闸 / 审计逐字不变。)
 */
@Injectable()
export class AttachmentRegistrationUploadService {
  private readonly registrationUploadContexts = new WeakMap<
    object,
    RegistrationUploadContextState
  >();

  constructor(
    private readonly prisma: PrismaService,
    // 共享校验 / 判权 / 序列化 / key 生成:调用点仍在本类各方法体内。
    private readonly access: AttachmentAccessService,
    private readonly storageConsistency: AttachmentStorageOrchestrator,
    private readonly storageSettings: StorageSettingsService,
    @Inject(appConfig.KEY) private readonly cfg: ConfigType<typeof appConfig>,
  ) {}

  // ===== Registration upload-session trusted facade =====
  // The App route owns token/session authorization. This facade owns storage configuration,
  // filename PII, magic validation, durable intent and terminal attachment binding only.
  async validateRegistrationUploadOutsideTransactionTrusted(input: {
    sessionId: string;
    originalName: string;
    mime: string;
    size: number;
    body: Buffer;
    uploadedByUserId: string;
    user: CurrentUserPayload;
    expiresAt: Date;
  }): Promise<RegistrationUploadValidated> {
    if (
      !Number.isSafeInteger(input.size) ||
      input.size < 0 ||
      input.body.length !== input.size ||
      typeof input.mime !== 'string' ||
      input.mime.length === 0
    ) {
      throw new BizException(BizCode.ATTACHMENT_SIZE_EXCEEDED);
    }
    if (!REGISTRATION_UPLOAD_ALLOWED_MIME.has(input.mime)) {
      throw new BizException(BizCode.ATTACHMENT_MIME_NOT_ALLOWED);
    }
    if (input.size > REGISTRATION_UPLOAD_MAX_BYTES) {
      throw new BizException(BizCode.ATTACHMENT_SIZE_EXCEEDED);
    }
    const ownerType = 'registration-upload-session';
    const { ownerTable } = await this.access.assertOwnerTypeAllowed(ownerType);
    if (ownerTable !== 'registration_upload_sessions') {
      throw new BizException(BizCode.ATTACHMENT_OWNER_TYPE_INVALID);
    }
    await this.access.assertMimeAllowed(ownerType, input.mime);
    await this.access.assertSizeAllowed(ownerType, input.size);
    this.access.assertNoPii({ originalName: input.originalName });
    this.storageConsistency.validateUploadBufferOutsideTransaction(input.mime, input.body);

    const settings = await this.storageSettings.getActiveSettings();
    const key = this.access.generateAttachmentKey(settings?.envPrefix ?? this.cfg.env, input.mime);
    const locator = await this.storageConsistency.resolveUploadLocatorForTransaction(key);
    return this.issueRegistrationUploadContext({
      stage: 'validated',
      identity: {
        key,
        ownerType,
        ownerId: input.sessionId,
        originalName: input.originalName,
        mime: input.mime,
        size: input.size,
        uploadedByUserId: input.uploadedByUserId,
      },
      body: input.body,
      locator,
      expiresAt: input.expiresAt,
      user: { ...input.user },
    }) as RegistrationUploadValidated;
  }

  /** Caller holds Activity/session locks and has revalidated the one-time token binding. */
  async prepareRegistrationUploadInTransactionTrusted(
    tx: Prisma.TransactionClient,
    context: RegistrationUploadValidated,
  ): Promise<RegistrationUploadPrepared> {
    const state = this.consumeRegistrationUploadContext(context, 'validated');
    const prepared = await this.storageConsistency.prepareUploadInTransaction(
      tx,
      state.identity,
      'attachment_legacy',
      new Date(state.expiresAt.getTime() + STORAGE_UNBOUND_GRACE_MS),
      state.locator,
    );
    return this.issueRegistrationUploadContext({
      ...state,
      stage: 'prepared',
      prepared,
    }) as RegistrationUploadPrepared;
  }

  /** Provider put + pinned HEAD/signature proof; deliberately called between two short txs. */
  async putRegistrationUploadAndVerifyOutsideTransactionTrusted(
    context: RegistrationUploadPrepared,
  ): Promise<RegistrationUploadVerified> {
    const state = this.consumeRegistrationUploadContext(context, 'prepared');
    const head = await this.storageConsistency.putUploadObjectAtAndVerifyOutsideTransaction(
      state.identity,
      'attachment_legacy',
      state.prepared.locator,
      state.body,
    );
    return this.issueRegistrationUploadContext({
      ...state,
      stage: 'verified',
      head,
    }) as RegistrationUploadVerified;
  }

  /** Caller has acquired the same root/session locks again and revalidated its binding. */
  async finalizeRegistrationUploadInTransactionTrusted(
    tx: Prisma.TransactionClient,
    context: RegistrationUploadVerified,
    auditMeta: AuditMeta,
  ): Promise<RegistrationUploadFinalized> {
    const state = this.consumeRegistrationUploadContext(context, 'verified');
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
          etag: state.head.etag ?? null,
        },
        auditKind: 'legacy',
        actorRoleSnap: state.user.role,
        scope: null,
        ownerTable: 'registration_upload_sessions',
        auditMeta,
      },
      state.head,
    );
    return this.issueRegistrationUploadContext({
      ...state,
      stage: 'finalized',
      row,
    }) as RegistrationUploadFinalized;
  }

  registrationUploadResponseTrusted(
    context: RegistrationUploadFinalized,
  ): RegistrationUploadAttachmentView {
    const state = this.requireRegistrationUploadContext(context, 'finalized');
    return {
      attachmentId: state.row.id,
      originalName: state.row.originalName,
      mime: state.row.mime,
      size: state.row.size,
      createdAt: state.row.createdAt,
    };
  }

  /**
   * Revalidates every file answer against the currently locked submission aggregate.  The
   * returned IDs stay inside trusted services; neither this method nor its caller turns them into
   * a response, exception, audit field, log line, token, key, URL, or locator.
   */
  async inspectRegistrationUploadsForSubmissionInTransactionTrusted(
    tx: Prisma.TransactionClient,
    input: {
      activityId: string;
      memberId: string;
      formVersionId: string;
      sessionIds: readonly string[];
      now: Date;
    },
  ): Promise<RegistrationUploadSubmissionBinding[]> {
    if (input.sessionIds.length === 0) return [];
    if (new Set(input.sessionIds).size !== input.sessionIds.length) {
      throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    }
    const sessions = await tx.$queryRaw<
      Array<{
        id: string;
        activityId: string;
        memberId: string;
        formVersionId: string;
        statusCode: string;
        consumedAt: Date | null;
        expiresAt: Date;
      }>
    >(Prisma.sql`
      SELECT "id", "activityId", "memberId", "formVersionId", "statusCode", "consumedAt", "expiresAt"
      FROM "RegistrationUploadSession"
      WHERE "id" IN (${Prisma.join([...input.sessionIds])})
      ORDER BY "id" ASC
      FOR UPDATE
    `);
    if (sessions.length !== input.sessionIds.length) {
      throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    }
    for (const session of sessions) {
      if (
        session.activityId !== input.activityId ||
        session.memberId !== input.memberId ||
        session.formVersionId !== input.formVersionId ||
        session.statusCode !== 'active' ||
        session.consumedAt !== null ||
        session.expiresAt.getTime() <= input.now.getTime()
      ) {
        throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
      }
    }

    const attachments = await tx.attachment.findMany({
      where: {
        ownerType: 'registration-upload-session',
        ownerId: { in: [...input.sessionIds] },
      },
      select: { id: true, ownerId: true, key: true },
      orderBy: { id: 'asc' },
    });
    if (attachments.length !== sessions.length) {
      throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    }
    const attachmentBySession = new Map<string, { id: string; key: string }>();
    for (const attachment of attachments) {
      if (attachmentBySession.has(attachment.ownerId)) {
        throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
      }
      attachmentBySession.set(attachment.ownerId, { id: attachment.id, key: attachment.key });
    }
    if (attachmentBySession.size !== sessions.length) {
      throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    }

    const attachmentIds = attachments.map((attachment) => attachment.id);
    const availableObjects = await tx.storageObject.findMany({
      where: { key: { in: attachments.map((attachment) => attachment.key) }, state: 'available' },
      select: { key: true },
    });
    if (availableObjects.length !== attachments.length) {
      throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    }
    const alreadyBound = await tx.registrationFormAnswer.findFirst({
      where: { attachmentId: { in: attachmentIds } },
      select: { id: true },
    });
    if (alreadyBound) throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);

    return sessions.map((session) => ({
      sessionId: session.id,
      attachmentId: attachmentBySession.get(session.id)!.id,
    }));
  }

  /**
   * Finalizes the single-use upload state after answer rows exist.  Every guard is repeated in
   * the same transaction so an accidental caller/order change cannot attach a foreign, expired,
   * revoked, consumed, unavailable, or already-bound file.
   */
  async consumeRegistrationUploadsForFormAnswersInTransactionTrusted(
    tx: Prisma.TransactionClient,
    input: {
      activityId: string;
      memberId: string;
      formVersionId: string;
      bindings: readonly (RegistrationUploadSubmissionBinding & { answerId: string })[];
      now: Date;
    },
  ): Promise<void> {
    for (const binding of input.bindings) {
      const attachment = await tx.attachment.findFirst({
        where: {
          id: binding.attachmentId,
          ownerType: 'registration-upload-session',
          ownerId: binding.sessionId,
        },
        select: { id: true, key: true },
      });
      const session = await tx.registrationUploadSession.findFirst({
        where: {
          id: binding.sessionId,
          activityId: input.activityId,
          memberId: input.memberId,
          formVersionId: input.formVersionId,
          statusCode: 'active',
          consumedAt: null,
          expiresAt: { gt: input.now },
        },
        select: { id: true },
      });
      const available = attachment
        ? await tx.storageObject.findFirst({
            where: { key: attachment.key, state: 'available' },
            select: { key: true },
          })
        : null;
      const answer = await tx.registrationFormAnswer.findFirst({
        where: { id: binding.answerId, attachmentId: binding.attachmentId },
        select: { id: true },
      });
      const alreadyBound = await tx.registrationFormAnswer.findFirst({
        where: { attachmentId: binding.attachmentId, id: { not: binding.answerId } },
        select: { id: true },
      });
      if (!attachment || !session || !available || !answer || alreadyBound) {
        throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
      }
      const transferred = await tx.attachment.updateMany({
        where: {
          id: binding.attachmentId,
          ownerType: 'registration-upload-session',
          ownerId: binding.sessionId,
        },
        data: { ownerType: 'registration-form-answer', ownerId: binding.answerId },
      });
      const consumed = await tx.registrationUploadSession.updateMany({
        where: {
          id: binding.sessionId,
          activityId: input.activityId,
          memberId: input.memberId,
          formVersionId: input.formVersionId,
          statusCode: 'active',
          consumedAt: null,
          expiresAt: { gt: input.now },
        },
        data: { statusCode: 'consumed', consumedAt: input.now },
      });
      if (transferred.count !== 1 || consumed.count !== 1) {
        throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
      }
    }
  }

  private issueRegistrationUploadContext(state: RegistrationUploadContextState): object {
    const context = Object.freeze(Object.create(null)) as object;
    this.registrationUploadContexts.set(context, state);
    return context;
  }

  private requireRegistrationUploadContext<Stage extends RegistrationUploadContextState['stage']>(
    context: object,
    stage: Stage,
  ): Extract<RegistrationUploadContextState, { stage: Stage }> {
    const state = this.registrationUploadContexts.get(context);
    if (!state || state.stage !== stage) throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    return state as Extract<RegistrationUploadContextState, { stage: Stage }>;
  }

  private consumeRegistrationUploadContext<Stage extends RegistrationUploadContextState['stage']>(
    context: object,
    stage: Stage,
  ): Extract<RegistrationUploadContextState, { stage: Stage }> {
    const state = this.requireRegistrationUploadContext(context, stage);
    this.registrationUploadContexts.delete(context);
    return state;
  }
}
