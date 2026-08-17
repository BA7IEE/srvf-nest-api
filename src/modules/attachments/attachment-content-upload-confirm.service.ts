import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { STORAGE_UNBOUND_GRACE_MS } from '../storage/storage-consistency.types';
import { StorageSettingsService } from '../storage/storage-settings.service';
import type { StorageObjectLocator } from '../storage/storage.types';
import {
  UploadTokenExpiredError,
  UploadTokenInvalidError,
  verifyUploadToken,
  type UploadTokenClaims,
} from '../storage/upload-token.util';
import appConfig from '../../config/app.config';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { RbacService } from '../permissions/rbac.service';
import { AttachmentStorageOrchestrator } from './attachment-storage-orchestrator';
import type {
  AttachmentUploadStorageIdentity,
  ContentAttachmentOwnerType,
  ContentUploadConfirmExpectedOwner,
  ContentUploadConfirmFinalized,
  ContentUploadConfirmGuard,
  ContentUploadConfirmPrepared,
  ContentUploadConfirmVerified,
} from './attachment-storage.types';
import {} from './attachment-validation';
import { AttachmentResponseDto } from './attachments.dto';
import {
  AttachmentAccessService,
  UploadConfirmContextState,
  isInternalRegistrationAttachmentOwner,
  isContentAttachmentOwnerType,
  requireUploadTokenExpiry,
} from './attachment-access.service';

/*
 * 内容附件的**确认上传**链路(trusted):守卫 → 建账 → 取证 → 落账 → 回执,
 * 外加内容根的处女态锁与阶段令牌。
 *
 * ⚠️ lockVirginContentForUploadConfirm 只允许**尚未发布**的内容根接受新附件 ——
 * 放宽它等于允许给已发布内容偷加附件。
 *
 * (Phase 6-B 第三域第七刀,§3.2;仅"搬家",判权 / 锁序 / 状态闸 / 审计逐字不变。)
 */
@Injectable()
export class AttachmentContentUploadConfirmService {
  private readonly uploadConfirmContexts = new WeakMap<object, UploadConfirmContextState>();

  constructor(
    private readonly prisma: PrismaService,
    // 共享校验 / 判权 / 序列化 / key 生成:调用点仍在本类各方法体内。
    private readonly access: AttachmentAccessService,
    private readonly storageConsistency: AttachmentStorageOrchestrator,
    private readonly storageSettings: StorageSettingsService,
    @Inject(appConfig.KEY) private readonly cfg: ConfigType<typeof appConfig>,
    private readonly rbac: RbacService,
  ) {}

  /**
   * Content confirm early guard. This is intentionally the only public token decoder for a
   * Content wrapper: invalid/expired/foreign/non-content/route-mismatched claims all collapse to
   * 13001 before Content, storage ledger, Provider, or audit work. The returned handle is opaque
   * and is valid only on this service instance.
   */
  async guardContentUploadConfirm(
    dto: { uploadToken: string; checksum?: string | null },
    user: CurrentUserPayload,
    expectedOwner: ContentUploadConfirmExpectedOwner,
  ): Promise<ContentUploadConfirmGuard> {
    return this.issueUploadConfirmGuard(
      dto,
      user,
      expectedOwner,
    ) as Promise<ContentUploadConfirmGuard>;
  }

  /**
   * The caller already holds and has reread the expected Content root in `tx`. No Provider call
   * or nested transaction is permitted here. The owner-v1 intent must already exist after the
   * PR-A rollout; ownerless compatibility is read-only and remains gated before PR-B deployment.
   */
  async prepareContentUploadConfirmInTransactionTrusted(
    tx: Prisma.TransactionClient,
    context: ContentUploadConfirmGuard,
  ): Promise<ContentUploadConfirmPrepared> {
    return this.prepareUploadConfirmInTransaction(
      tx,
      context,
      undefined,
      true,
    ) as Promise<ContentUploadConfirmPrepared>;
  }

  /** Provider evidence only; callers must invoke this between, never inside, aggregate txs. */
  async verifyContentUploadConfirmEvidenceOutsideTransaction(
    context: ContentUploadConfirmPrepared,
  ): Promise<ContentUploadConfirmVerified> {
    return this.verifyUploadConfirmEvidence(context, true) as Promise<ContentUploadConfirmVerified>;
  }

  /**
   * Final bind/audit core for a caller-owned Content transaction. The verified handle binds the
   * exact token identity, request hash, Provider evidence, actor, and route owner; it cannot be
   * forged or reused through another AttachmentsService instance/owner.
   */
  async finalizeContentUploadConfirmInTransactionTrusted(
    tx: Prisma.TransactionClient,
    context: ContentUploadConfirmVerified,
    auditMeta: AuditMeta,
  ): Promise<ContentUploadConfirmFinalized> {
    return this.finalizeUploadConfirmInTransaction(
      tx,
      context,
      auditMeta,
      { ownerTable: 'contents', scope: null },
      true,
    ) as Promise<ContentUploadConfirmFinalized>;
  }

  /** Resolve the download URL only after the caller-owned transaction has committed. */
  async resolveContentUploadConfirmResponseTrusted(
    context: ContentUploadConfirmFinalized,
  ): Promise<AttachmentResponseDto> {
    const state = this.requireUploadConfirmContext(context, 'finalized', true);
    return this.access.toResponseDto(state.row);
  }

  async issueUploadConfirmGuard(
    dto: { uploadToken: string; checksum?: string | null },
    user: CurrentUserPayload,
    expectedOwner?: ContentUploadConfirmExpectedOwner,
  ): Promise<object> {
    let claims: UploadTokenClaims;
    try {
      claims = verifyUploadToken(dto.uploadToken, this.cfg.storage.encryptionKey);
    } catch (error) {
      if (error instanceof UploadTokenInvalidError || error instanceof UploadTokenExpiredError) {
        throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
      }
      throw error;
    }

    if (isInternalRegistrationAttachmentOwner(claims.ownerType)) {
      throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    }

    const contentOwner = isContentAttachmentOwnerType(claims.ownerType);
    if (expectedOwner) {
      const expectedOwnerTypes: readonly ContentAttachmentOwnerType[] = Array.isArray(
        expectedOwner.ownerType,
      )
        ? expectedOwner.ownerType
        : [expectedOwner.ownerType];
      if (
        !contentOwner ||
        claims.ownerId !== expectedOwner.ownerId ||
        !expectedOwnerTypes.includes(claims.ownerType as ContentAttachmentOwnerType)
      ) {
        // Route/token mismatch must not reach RBAC, Content, ledger, Provider, or audit.
        throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
      }
    }

    if (claims.uploadedByUserId !== user.id) {
      throw new BizException(contentOwner ? BizCode.ATTACHMENT_NOT_FOUND : BizCode.RBAC_FORBIDDEN);
    }
    if (contentOwner) {
      const allowed = await this.rbac.can(user, `attachment.upload.${claims.ownerType}`);
      if (!allowed) {
        throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
      }
    }

    const identity: AttachmentUploadStorageIdentity = {
      key: claims.key,
      ownerType: claims.ownerType,
      ownerId: claims.ownerId,
      originalName: claims.originalName,
      mime: claims.mime,
      size: claims.sizeBytes,
      uploadedByUserId: claims.uploadedByUserId,
      iat: claims.iat,
      exp: claims.exp,
    };
    return this.issueUploadConfirmContext({
      stage: 'guarded',
      identity,
      checksum: dto.checksum ?? null,
      user: { ...user },
      contentFacade: expectedOwner !== undefined,
    });
  }

  issueUploadConfirmContext(state: UploadConfirmContextState): object {
    const context = Object.freeze(Object.create(null)) as object;
    this.uploadConfirmContexts.set(context, state);
    return context;
  }

  requireUploadConfirmContext<Stage extends UploadConfirmContextState['stage']>(
    context: object,
    stage: Stage,
    contentFacade: boolean = false,
  ): Extract<UploadConfirmContextState, { stage: Stage }> {
    const state = this.uploadConfirmContexts.get(context);
    if (!state || state.stage !== stage || (contentFacade && !state.contentFacade)) {
      throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    }
    return state as Extract<UploadConfirmContextState, { stage: Stage }>;
  }

  consumeUploadConfirmContext<Stage extends UploadConfirmContextState['stage']>(
    context: object,
    stage: Stage,
    contentFacade: boolean = false,
  ): Extract<UploadConfirmContextState, { stage: Stage }> {
    const state = this.requireUploadConfirmContext(context, stage, contentFacade);
    // Consume synchronously before the transaction/Provider transition. A failed transition still
    // requires a freshly guarded HTTP retry, so an old capability can never replay an effect.
    this.uploadConfirmContexts.delete(context);
    return state;
  }

  async prepareUploadConfirmInTransaction(
    tx: Prisma.TransactionClient,
    context: object,
    resolvedLocator?: StorageObjectLocator,
    contentFacade: boolean = false,
  ): Promise<object> {
    const state = this.consumeUploadConfirmContext(context, 'guarded', contentFacade);
    const unboundExpiresAt = new Date(
      requireUploadTokenExpiry(state.identity) * 1000 + STORAGE_UNBOUND_GRACE_MS,
    );
    const prepared = resolvedLocator
      ? await this.storageConsistency.prepareUploadInTransaction(
          tx,
          state.identity,
          'attachment_signed_upload',
          unboundExpiresAt,
          resolvedLocator,
        )
      : await this.storageConsistency.prepareUploadInTransaction(
          tx,
          state.identity,
          'attachment_signed_upload',
          unboundExpiresAt,
        );
    return this.issueUploadConfirmContext({
      stage: 'prepared',
      identity: state.identity,
      checksum: state.checksum,
      user: state.user,
      contentFacade: state.contentFacade,
      prepared,
    });
  }

  async verifyUploadConfirmEvidence(
    context: object,
    contentFacade: boolean = false,
  ): Promise<object> {
    const state = this.consumeUploadConfirmContext(context, 'prepared', contentFacade);
    const head = await this.storageConsistency.verifyUploadEvidence(
      state.identity,
      'attachment_signed_upload',
    );
    return this.issueUploadConfirmContext({
      stage: 'verified',
      identity: state.identity,
      checksum: state.checksum,
      user: state.user,
      contentFacade: state.contentFacade,
      prepared: state.prepared,
      head,
    });
  }

  async finalizeUploadConfirmInTransaction(
    tx: Prisma.TransactionClient,
    context: object,
    auditMeta: AuditMeta,
    owner: { ownerTable: string; scope: 'self' | 'other' | null },
    contentFacade: boolean = false,
  ): Promise<object> {
    const state = this.consumeUploadConfirmContext(context, 'verified', contentFacade);
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
          checksum: state.checksum,
          etag: state.head.etag ?? null,
        },
        auditKind: 'confirmed',
        actorRoleSnap: state.user.role,
        scope: owner.scope,
        ownerTable: owner.ownerTable,
        auditMeta,
      },
      state.head,
    );
    return this.issueUploadConfirmContext({
      stage: 'finalized',
      identity: state.identity,
      checksum: state.checksum,
      user: state.user,
      contentFacade: state.contentFacade,
      prepared: state.prepared,
      head: state.head,
      row,
    });
  }

  async lockVirginContentForUploadConfirm(
    tx: Prisma.TransactionClient,
    contentId: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        deletedAt: Date | null;
        statusCode: string;
        publishedAt: Date | null;
      }>
    >(Prisma.sql`
      SELECT "id", "deletedAt", "statusCode", "publishedAt"
      FROM "contents"
      WHERE "id" = ${contentId}
      FOR UPDATE
    `);
    const content = rows[0];
    if (rows.length !== 1 || !content || content.deletedAt !== null) {
      throw new BizException(BizCode.ATTACHMENT_OWNER_NOT_FOUND);
    }
    if (content.statusCode !== 'draft' || content.publishedAt !== null) {
      throw new BizException(BizCode.CONTENT_INVALID_STATUS_TRANSITION);
    }
  }
}
