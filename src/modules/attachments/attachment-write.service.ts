import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { STORAGE_UNBOUND_GRACE_MS } from '../storage/storage-consistency.types';
import { extractAttachmentPlaceholderIds } from '../content/content.constants';
import { StorageSettingsService } from '../storage/storage-settings.service';
import { signUploadToken } from '../storage/upload-token.util';
import appConfig from '../../config/app.config';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AttachmentContentUploadConfirmService } from './attachment-content-upload-confirm.service';
import { AttachmentStorageOrchestrator } from './attachment-storage-orchestrator';
import type { AttachmentUploadStorageIdentity } from './attachment-storage.types';
import { AttachmentOwnerType } from './attachment-validation';
import {
  AttachmentResponseDto,
  ConfirmUploadDto,
  CreateAttachmentDto,
  GenerateUploadUrlDto,
  UpdateAttachmentDto,
  UploadUrlResponseDto,
} from './attachments.dto';
import { attachmentSelect } from './attachments.select';
import { isDerivedAttachmentKey } from './attachment-key-format';
import {
  AttachmentAccessService,
  SafeAttachment,
  isInternalRegistrationAttachmentOwner,
  isContentAttachmentOwnerType,
} from './attachment-access.service';

/*
 * 附件的**写链路**:create / update / delete(含内容附件的 trusted 删除与已解析删除)/
 * 签名上传 URL / 确认上传。
 *
 * ⚠️ deleteResolvedAttachment 是被调用方(调用方已持锁),自己不再取锁 ——
 * 挪动调用位置会静默破坏锁序,且不会有任何编译错或单测失败。
 *
 * (Phase 6-B 第三域第七刀,§3.2;仅"搬家",判权 / 锁序 / 状态闸 / 审计逐字不变。)
 */
@Injectable()
export class AttachmentWriteService {
  constructor(
    private readonly prisma: PrismaService,
    // 共享校验 / 判权 / 序列化 / key 生成:调用点仍在本类各方法体内。
    private readonly access: AttachmentAccessService,
    private readonly storageConsistency: AttachmentStorageOrchestrator,
    private readonly storageSettings: StorageSettingsService,
    @Inject(appConfig.KEY) private readonly cfg: ConfigType<typeof appConfig>,
    // 确认上传链路的实现持有者(write 的 confirmUpload 复用其四段)。
    private readonly confirms: AttachmentContentUploadConfirmService,
  ) {}

  // POST /api/admin/v1/attachments
  async create(
    dto: CreateAttachmentDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AttachmentResponseDto> {
    if (isInternalRegistrationAttachmentOwner(dto.ownerType)) {
      throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    }
    // 1. ownerType 双层校验(返 ownerTable;PR #6c 进 audit extra)
    const { ownerTable } = await this.access.assertOwnerTypeAllowed(dto.ownerType);

    // 2. ownerId 真实性校验
    await this.access.assertOwnerExists(dto.ownerType as AttachmentOwnerType, dto.ownerId);

    // 3. 构造 RBAC resource + scope(scope ∈ {'self', 'other', null};null=activity 粗粒度)
    const { resource, scope } = await this.access.buildRbacResourceAndScope(
      dto.ownerType as AttachmentOwnerType,
      dto.ownerId,
      user,
    );
    const action = `attachment.upload.${dto.ownerType}${scope ? '.' + scope : ''}`;

    // 4. RBAC 判权(F5 失败 → 30100)
    await this.access.assertRbacAllowed(user, action, resource);

    // 5. mime 白名单校验(13012)
    await this.access.assertMimeAllowed(dto.ownerType, dto.mime);

    // 6. size 上限校验(13013)
    await this.access.assertSizeAllowed(dto.ownerType, dto.size);

    // 7. PII 检测(13015)
    this.access.assertNoPii(dto);

    // 7.5. F2(#399):key 必须匹配服务端派生格式 + 当前 envPrefix 命名空间(13014)。
    //      模式 A 历史直收客户端 raw key → 可对命名空间外任意对象签 signed URL(IDOR);
    //      此处把 key 绑定到 attachments/<envPrefix>/yyyy/mm/dd/<base64url>.<ext>。
    //      envPrefix 与 generateAttachmentKey 同源(getActiveSettings ?? cfg.env)。
    //      残余(命名空间内、已知完整随机段的 key)= owner-绑定,留 P3(模式 A 弃用)。
    const keySettings = await this.storageSettings.getActiveSettings();
    const keyEnvPrefix = keySettings?.envPrefix ?? this.cfg.env;
    if (!isDerivedAttachmentKey(dto.key, keyEnvPrefix)) {
      throw new BizException(BizCode.ATTACHMENT_KEY_INVALID);
    }

    // 7.6. 旧 create 也必须先提交 durable intent，再按 pinned locator 证明对象存在。
    const identity: AttachmentUploadStorageIdentity = {
      key: dto.key,
      ownerType: dto.ownerType,
      ownerId: dto.ownerId,
      originalName: dto.originalName,
      mime: dto.mime,
      size: dto.size,
      uploadedByUserId: user.id,
    };
    const prepared = await this.storageConsistency.prepareUpload(
      identity,
      'attachment_legacy',
      new Date(Date.now() + STORAGE_UNBOUND_GRACE_MS),
    );
    const head = await this.storageConsistency.verifyUploadEvidence(identity, 'attachment_legacy');
    await this.access.assertOwnerExists(dto.ownerType as AttachmentOwnerType, dto.ownerId);

    // 8. Attachment + AVAILABLE + operation terminal + audit 同一事务；任一失败均可按 intent 重放。
    const row = await this.storageConsistency.finalizeUpload(
      {
        identity,
        requestHash: prepared.requestHash,
        data: {
          key: dto.key,
          originalName: dto.originalName,
          mime: dto.mime,
          size: dto.size,
          uploadedBy: user.id,
          ownerType: dto.ownerType,
          ownerId: dto.ownerId,
          description: dto.description,
          accessLevel: dto.accessLevel,
          tags: dto.tags ?? [],
          originalUploaderName: user.username,
          expireAt: dto.expireAt ? new Date(dto.expireAt) : undefined,
        },
        auditKind: 'legacy',
        actorRoleSnap: user.role,
        scope,
        ownerTable,
        auditMeta,
      },
      head,
    );
    return this.access.toResponseDto(row);
  }

  // PATCH /api/admin/v1/attachments/:id
  async update(
    id: string,
    dto: UpdateAttachmentDto,
    user: CurrentUserPayload,
  ): Promise<AttachmentResponseDto> {
    // 1. 查活跃记录(不存在 → 13001)
    const row = await this.access.findByIdOrThrow(id);
    if (!(await this.storageConsistency.isMetadataVisible(row.key))) {
      throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    }

    // 2. 判 update 权限(写路径;失败 → 30100 RBAC_FORBIDDEN)
    const { resource, scope } = await this.access.buildRbacResourceAndScope(
      row.ownerType as AttachmentOwnerType,
      row.ownerId,
      user,
    );
    const action = `attachment.update.${row.ownerType}${scope ? '.' + scope : ''}`;
    await this.access.assertRbacAllowed(user, action, resource);

    // 3. PII 检测(description / tags;13015)
    this.access.assertNoPii({
      description: dto.description,
      tags: dto.tags,
    });

    // 4. 全局写锁序 Attachment → StorageObject。锁内重读并只允许 identity-complete available
    //    对象进入 PATCH；delete intent 先赢或 ledger 不安全时绝不修改 tombstone。
    let updated: SafeAttachment;
    try {
      updated = await this.prisma.$transaction(async (tx) => {
        const attachmentLocks = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "attachments"
          WHERE "id" = ${id}
          FOR UPDATE
        `);
        if (attachmentLocks.length !== 1) {
          throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
        }
        const current = await tx.attachment.findUnique({
          where: { id },
          select: attachmentSelect,
        });
        if (!current) throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
        if (
          current.key !== row.key ||
          current.ownerType !== row.ownerType ||
          current.ownerId !== row.ownerId
        ) {
          throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
        }

        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "storage_objects"
          WHERE "key" = ${current.key}
          FOR UPDATE
        `);
        const object = await tx.storageObject.findUnique({ where: { key: current.key } });
        if (
          !object ||
          object.key !== current.key ||
          object.resourceType !== 'attachment' ||
          object.resourceId !== current.id
        ) {
          throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
        }
        if (object.state !== 'available' || object.deleteRequestedAt !== null) {
          throw new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING);
        }

        // 更新 4 字段(其余字段已经 DTO 白名单 + forbidNonWhitelisted 兜底);
        // expireAt:显式 null → 清空;undefined → 不动;字符串 → new Date()。
        return tx.attachment.update({
          where: { id: current.id },
          data: {
            description: dto.description,
            accessLevel: dto.accessLevel,
            tags: dto.tags,
            expireAt:
              dto.expireAt === null
                ? null
                : dto.expireAt !== undefined
                  ? new Date(dto.expireAt)
                  : undefined,
          },
          select: attachmentSelect,
        });
      });
    } catch (error) {
      // The row lock makes P2025 unreachable in normal PostgreSQL interleavings; retain a
      // defensive anti-enumeration mapping for client/fixture drift instead of surfacing 500.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
      }
      throw error;
    }
    return this.access.toResponseDto(updated);
  }

  // DELETE /api/admin/v1/attachments/:id(Q11 v1.0:物理删,不查跨表引用)。
  async delete(
    id: string,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AttachmentResponseDto> {
    // 1. 物理删除后仅原 actor 可在 24h 窗口内重放最小 terminal representation。
    const row = await this.prisma.attachment.findFirst({
      where: { id },
      select: attachmentSelect,
    });
    if (!row) {
      const replay = await this.storageConsistency.getDeleteReplay(id, user.id);
      if (replay?.state === 'succeeded' && replay.response) {
        return this.access.deleteReplayToResponseDto(replay.response);
      }
      throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    }
    if (isInternalRegistrationAttachmentOwner(row.ownerType)) {
      throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    }

    return this.deleteResolvedAttachment(row, user, auditMeta, BizCode.ATTACHMENT_NOT_FOUND);
  }

  /**
   * Content wrapper with route-owner anti-enumeration. Generic Attachment delete also enters the
   * same content lifecycle path, so this facade cannot be bypassed through another controller.
   */
  async deleteContentAttachmentTrusted(
    contentId: string,
    attachmentId: string,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AttachmentResponseDto> {
    const row = await this.prisma.attachment.findFirst({
      where: {
        id: attachmentId,
        ownerId: contentId,
        ownerType: { in: ['content-image', 'content-file'] },
      },
      select: attachmentSelect,
    });
    if (!row) throw new BizException(BizCode.CONTENT_NOT_FOUND);
    return this.deleteResolvedAttachment(row, user, auditMeta, BizCode.CONTENT_NOT_FOUND);
  }

  private async deleteResolvedAttachment(
    row: SafeAttachment,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
    missingContentBiz: typeof BizCode.CONTENT_NOT_FOUND | typeof BizCode.ATTACHMENT_NOT_FOUND,
  ): Promise<AttachmentResponseDto> {
    if (isInternalRegistrationAttachmentOwner(row.ownerType)) {
      throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    }
    // 判 delete 权限(写路径;失败 → 30100)
    const { resource, scope } = await this.access.buildRbacResourceAndScope(
      row.ownerType as AttachmentOwnerType,
      row.ownerId,
      user,
    );
    const action = `attachment.delete.${row.ownerType}${scope ? '.' + scope : ''}`;
    await this.access.assertRbacAllowed(user, action, resource);

    const deleteInput = {
      attachmentId: row.id,
      actorUserId: user.id,
      actorRoleSnap: user.role,
      allowAuthorizedJoin: true,
      scope,
      deletedByPath: user.id === row.uploadedBy ? 'owner' : 'admin',
      auditMeta,
    } as const;
    let eventKey: string;
    if (isContentAttachmentOwnerType(row.ownerType)) {
      // Content-owned deletion is an aggregate mutation: require both coarse permissions before
      // entering the root lock, then prepare the durable tombstone under the same transaction.
      await this.access.assertRbacAllowed(user, 'content.update.record', undefined);
      await this.storageConsistency.ensureAttachmentDeleteReady(row.id);
      eventKey = await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "contents" WHERE "id" = ${row.ownerId} FOR UPDATE
        `);
        if (locked.length !== 1) throw new BizException(missingContentBiz);
        const content = await tx.content.findUnique({
          where: { id: row.ownerId },
          select: {
            statusCode: true,
            body: true,
            coverAttachmentId: true,
            coverImageKey: true,
            deletedAt: true,
          },
        });
        if (!content || content.deletedAt !== null) {
          throw new BizException(missingContentBiz);
        }
        if (content.statusCode !== 'draft') {
          throw new BizException(BizCode.CONTENT_INVALID_STATUS_TRANSITION);
        }
        if (
          content.coverAttachmentId === row.id ||
          content.coverImageKey === row.key ||
          extractAttachmentPlaceholderIds(content.body).includes(row.id)
        ) {
          throw new BizException(BizCode.CONTENT_ATTACHMENT_IN_USE);
        }
        return this.storageConsistency.prepareDeleteInTransaction(tx, deleteInput);
      });
    } else {
      eventKey = await this.storageConsistency.prepareDelete(deleteInput);
    }

    // Provider effect runs after the root-locked intent commits. HEAD-absent finalization keeps
    // Attachment deletion, audit, object state and operation terminal state atomic.
    await this.storageConsistency.executeEventKey(eventKey);
    const replay = await this.storageConsistency.getDeleteReplay(row.id, user.id, {
      allowAuthorizedJoin: true,
    });
    if (replay?.state === 'succeeded' && replay.response) {
      return this.access.deleteReplayToResponseDto(replay.response);
    }
    throw new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING);
  }

  // POST /api/admin/v1/attachments/upload-url
  async createUploadUrl(
    dto: GenerateUploadUrlDto,
    user: CurrentUserPayload,
  ): Promise<UploadUrlResponseDto> {
    if (isInternalRegistrationAttachmentOwner(dto.ownerType)) {
      throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    }
    // === Step 1-7:沿现有 create() 校验链(§6.2 9 步) ===
    await this.access.assertOwnerTypeAllowed(dto.ownerType);
    await this.access.assertOwnerExists(dto.ownerType as AttachmentOwnerType, dto.ownerId);
    const { resource, scope } = await this.access.buildRbacResourceAndScope(
      dto.ownerType as AttachmentOwnerType,
      dto.ownerId,
      user,
    );
    const action = `attachment.upload.${dto.ownerType}${scope ? '.' + scope : ''}`;
    await this.access.assertRbacAllowed(user, action, resource);
    await this.access.assertMimeAllowed(dto.ownerType, dto.mime);
    await this.access.assertSizeAllowed(dto.ownerType, dto.sizeBytes);
    // PII 检测:upload-url 仅检 originalName(Q-10-5 不接受 description / tags)
    this.access.assertNoPii({ originalName: dto.originalName });

    // === Step 8:生成 key(沿 §6.4.2 + Q-10-3 + Q-10-4 + Q-10-15) ===
    const settings = await this.storageSettings.getActiveSettings();
    const envPrefix = settings?.envPrefix ?? this.cfg.env;
    const key = this.access.generateAttachmentKey(envPrefix, dto.mime);

    // === Step 9:生成 uploadToken(沿 §8.3.4 + Q-10-2 复用 STORAGE_ENCRYPTION_KEY) ===
    const uploadUrlTtlSeconds = settings?.uploadUrlTtlSeconds ?? 600;
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + uploadUrlTtlSeconds;
    const uploadToken = signUploadToken(
      {
        key,
        ownerType: dto.ownerType,
        ownerId: dto.ownerId,
        originalName: dto.originalName,
        mime: dto.mime,
        sizeBytes: dto.sizeBytes,
        uploadedByUserId: user.id,
        iat,
        exp,
      },
      this.cfg.storage.encryptionKey,
    );

    // === Step 10:先提交 durable intent，再按 pinned locator 生成 signed URL ===
    const identity: AttachmentUploadStorageIdentity = {
      key,
      ownerType: dto.ownerType,
      ownerId: dto.ownerId,
      originalName: dto.originalName,
      mime: dto.mime,
      size: dto.sizeBytes,
      uploadedByUserId: user.id,
      iat,
      exp,
    };
    const uploadResult = await this.storageConsistency.prepareUploadUrl(
      identity,
      new Date(exp * 1000 + STORAGE_UNBOUND_GRACE_MS),
      uploadUrlTtlSeconds,
    );

    return {
      key,
      uploadUrl: uploadResult.url,
      uploadHeaders: uploadResult.headers,
      uploadMethod: uploadResult.method,
      expiresAt: uploadResult.expiresAt,
      uploadToken,
    };
  }

  // POST /api/admin/v1/attachments/confirm-upload
  async confirmUpload(
    dto: ConfirmUploadDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AttachmentResponseDto> {
    // Generic direct-confirm remains a public wrapper, but it now shares the exact guard,
    // transaction-aware prepare, Provider evidence, and transaction-aware finalizer used by the
    // Content facade. Only this wrapper owns its two short transactions.
    const guarded = await this.confirms.issueUploadConfirmGuard(dto, user);
    const guardedState = this.confirms.requireUploadConfirmContext(guarded, 'guarded');
    let prepared: object;
    if (isContentAttachmentOwnerType(guardedState.identity.ownerType)) {
      prepared = await this.prisma.$transaction(async (tx) => {
        await this.confirms.lockVirginContentForUploadConfirm(tx, guardedState.identity.ownerId);
        return this.confirms.prepareUploadConfirmInTransaction(tx, guarded);
      });
    } else {
      const locator = await this.storageConsistency.resolveUploadLocatorForTransaction(
        guardedState.identity.key,
      );
      prepared = await this.prisma.$transaction((tx) =>
        this.confirms.prepareUploadConfirmInTransaction(tx, guarded, locator),
      );
    }
    const verified = await this.confirms.verifyUploadConfirmEvidence(prepared);
    const verifiedState = this.confirms.requireUploadConfirmContext(verified, 'verified');

    // === Step 7:PII 不重做(沿 §8.4 Q10 + Q-10-X) ===

    // === Step 7.5(F10 #399):owner 仍存活复校 —— upload-url 签发后 owner 可能软删,confirm 落库前
    //     与 create() / createUploadUrl() 对齐补 assertOwnerExists,杜绝 owner 软删窗口内落悬空附件行。 ===
    if (!isContentAttachmentOwnerType(verifiedState.identity.ownerType)) {
      await this.access.assertOwnerExists(
        verifiedState.identity.ownerType as AttachmentOwnerType,
        verifiedState.identity.ownerId,
      );
    }

    // === Step 8:落库 + audit(同事务 fail-fast;沿 §8.4.3 Step 5 + PR #6c F6) ===
    // 需要 ownerTable 进 audit extra(沿现有 create);重查 typeConfig 拿 ownerTable
    const { ownerTable } = await this.access.assertOwnerTypeAllowed(
      verifiedState.identity.ownerType,
    );
    // 重新 build scope 给 audit(沿 §8.4.3 Step 5 extra.scope)
    const { scope } = await this.access.buildRbacResourceAndScope(
      verifiedState.identity.ownerType as AttachmentOwnerType,
      verifiedState.identity.ownerId,
      user,
    );

    const finalized = await this.prisma.$transaction(async (tx) => {
      if (isContentAttachmentOwnerType(verifiedState.identity.ownerType)) {
        // The generic Attachment endpoint accepts Content tokens too. It must participate in the
        // same root-lock fence as the Content wrapper or it becomes a publish-vs-confirm bypass.
        await this.confirms.lockVirginContentForUploadConfirm(tx, verifiedState.identity.ownerId);
      }
      return this.confirms.finalizeUploadConfirmInTransaction(tx, verified, auditMeta, {
        ownerTable,
        scope,
      });
    });
    const finalizedState = this.confirms.requireUploadConfirmContext(finalized, 'finalized');

    // === Step 9-10:返完整 dto(toResponseDto 内已调 generateDownloadUrl 填 accessUrl;沿 PR #90) ===
    return this.access.toResponseDto(finalizedState.row);
  }
}
