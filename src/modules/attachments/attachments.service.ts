import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { AttachmentMimeConfigStatus, AttachmentTypeConfigStatus, Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto, PaginationQueryDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { STORAGE_UNBOUND_GRACE_MS } from '../storage/storage-consistency.types';
import type { AttachmentDeleteReplayResponse } from '../storage/storage-operation-payload';
import { StorageSettingsService } from '../storage/storage-settings.service';
import type { HeadObjectResult, StorageObjectLocator } from '../storage/storage.types';
import {
  signUploadToken,
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
  ContentPublishStorageBoundaryInput,
  ContentUploadConfirmExpectedOwner,
  ContentUploadConfirmFinalized,
  ContentUploadConfirmGuard,
  ContentUploadConfirmPrepared,
  ContentUploadConfirmVerified,
  PreparedAttachmentStorageUpload,
} from './attachment-storage.types';
import {
  ATTACHMENT_OWNER_TYPES,
  AttachmentOwnerType,
  detectPii,
  isKnownAttachmentOwnerType,
  isMimeBlocked,
} from './attachment-validation';
import {
  AttachmentResponseDto,
  ConfirmUploadDto,
  CreateAttachmentDto,
  GenerateUploadUrlDto,
  ListAttachmentsByOwnerQueryDto,
  ListAttachmentsQueryDto,
  UpdateAttachmentDto,
  UploadUrlResponseDto,
} from './attachments.dto';
import { attachmentSelect } from './attachments.select';
import { isDerivedAttachmentKey } from './attachment-key-format';
import { mimeToExt } from './mime-to-ext';

// V2.x C-7 attachments 实施 PR #6b / #6c:attachments 主模块业务逻辑。
//
// 沿 D7-attachments v1.0 §5 / §6 / §7 + 用户 PR #6b 14 项 Q + PR #6c 8 项 Q 拍板:
// - F3 v1.0:Controller 入口仅 @UseGuards JwtAuthGuard;**所有判权在 Service 层** rbac.can()
// - F5 v1.0:RBAC 失败统一抛 BizException(BizCode.RBAC_FORBIDDEN)(30100)
// - Q1 v1.0:ownerType 双层校验 — 先查 attachment_type_configs(权威);enum 兜底
// - Q5 v1.0:Update 仅 description / accessLevel / tags / expireAt 四字段
// - Q8 v1.0:detail / update / delete 软删 / 不存在 / 无权统一返 13001(沿 v1 §10 信息泄漏防御)
// - Q11 v1.0:DELETE 物理删,不查跨表引用(不抛 IN_USE 13030)
// - Q13 v1.0:RBAC 写失败复用 30100;读路径用 13001 信息泄漏防御
// - Q14 v1.0:accessUrl 占位恒返 null(Provider 接通前;沿 D7 §5.5 / §5.6)
//
// **PR #6c audit_logs 集成**(沿 D7 §7.1 / §7.2 + 用户 Q1-Q8 拍板):
// - 仅接入 2 个写端点:POST create → 'attachment.upload' / DELETE delete → 'attachment.delete'
// - 不审计 PATCH metadata(Q7 v0.2 锁:沿"只审高价值写操作")
// - 不审计 view / list(沿 D6 R4)
// - 不审计失败操作(沿 D6 F6 fail-fast:RBAC / mime / size / PII 拒绝时事务未开,自然无 audit)
// - 同事务 wrap:校验链留事务外(Q7 PR #6c);事务内只 tx.attachment.{create,delete} + auditLogs.log({ tx })
// - 配置三表 'attachment.config.change' **不在本 PR**(留 PR #6d)

// 全局兜底:无 mime 配置 + type 无 defaultMimeWhitelist 时,**不允许**任何 mime
// (fail-close;沿 v1 §10 / baseline 安全默认拒绝;由 13012 命中)

type SafeAttachment = Prisma.AttachmentGetPayload<{ select: typeof attachmentSelect }>;

// CMS(content-module-review §5.2 / §5.4;α 决议):content 读取面用的「可信附件视图」——已签名下载
// URL;调用方(content)负责在取此视图**之前**完成文章可见级校验,本视图**不**经 attachment.view RBAC
//(公开读者零权限亦可见,附件继承文章可见级)。仅 content 模块消费;其余 owner 读仍走 RBAC。
export interface OwnerAttachmentView {
  id: string;
  ownerType: string;
  mime: string;
  originalName: string;
  size: number;
  createdAt: Date;
  accessUrl: string | null;
}

interface UploadConfirmContextBase {
  identity: AttachmentUploadStorageIdentity;
  checksum: string | null;
  user: CurrentUserPayload;
  contentFacade: boolean;
}

type UploadConfirmContextState =
  | (UploadConfirmContextBase & { stage: 'guarded' })
  | (UploadConfirmContextBase & {
      stage: 'prepared';
      prepared: PreparedAttachmentStorageUpload;
    })
  | (UploadConfirmContextBase & {
      stage: 'verified';
      prepared: PreparedAttachmentStorageUpload;
      head: HeadObjectResult;
    })
  | (UploadConfirmContextBase & {
      stage: 'finalized';
      prepared: PreparedAttachmentStorageUpload;
      head: HeadObjectResult;
      row: SafeAttachment;
    });

@Injectable()
export class AttachmentsService {
  private readonly uploadConfirmContexts = new WeakMap<object, UploadConfirmContextState>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly storageConsistency: AttachmentStorageOrchestrator,
    private readonly storageSettings: StorageSettingsService,
    @Inject(appConfig.KEY)
    private readonly cfg: ConfigType<typeof appConfig>,
  ) {}

  // accessUrl 只能经 durable ledger 的 pinned locator + HEAD 证明后生成；失败降级 null。
  private async toResponseDto(row: SafeAttachment): Promise<AttachmentResponseDto> {
    const accessUrl = await this.resolveAccessUrl(row.key, row.expireAt);
    return { ...row, accessUrl };
  }

  private deleteReplayToResponseDto(
    response: AttachmentDeleteReplayResponse,
  ): AttachmentResponseDto {
    return {
      ...response,
      uploadedAt: new Date(response.uploadedAt),
      createdAt: new Date(response.createdAt),
      updatedAt: new Date(response.updatedAt),
    };
  }

  // expireAt 在本单点生效；调用方只给 key 时补查 Attachment 行。
  private async resolveAccessUrl(key: string, expireAt?: Date | null): Promise<string | null> {
    const effectiveExpireAt =
      expireAt === undefined
        ? ((
            await this.prisma.attachment.findUnique({
              where: { key },
              select: { expireAt: true },
            })
          )?.expireAt ?? null)
        : expireAt;
    if (effectiveExpireAt !== null && effectiveExpireAt.getTime() <= Date.now()) {
      return null;
    }
    const settings = await this.storageSettings.getActiveSettings();
    return this.storageConsistency.resolveDownloadUrl(key, settings?.downloadUrlTtlSeconds ?? 300);
  }

  // ===== CMS 内容模块可信只读(content-module-review §5.4;α 决议)=====
  // content 读取面在**文章可见级校验通过后**调用,取某 owner 的全部附件(已签 URL),**不**走
  // attachment.view RBAC(公开读者亦可见,附件随文章可见级)。
  // **仅限 content-* owner**(content-image / content-file):本方法无 RBAC,若被误用于 member /
  // certificate / activity 等 owner,将无鉴权签出(含 PII 的)附件下载 URL。故方法体开头加运行时护栏
  // 限定 content-* owner(元核验加固,2026-06-21 维护者);其余 owner 的读**必须**走 attachment.view
  // RBAC(getById / list)。resolveSignedUrlTrusted 只签传入 key、无 owner 上下文,风险低,不加此栏。
  async listOwnerAttachmentsTrusted(
    ownerType: AttachmentOwnerType,
    ownerId: string,
  ): Promise<OwnerAttachmentView[]> {
    if (ownerType !== 'content-image' && ownerType !== 'content-file') {
      throw new Error(
        'listOwnerAttachmentsTrusted: content-* owner types only (no-RBAC trusted view)',
      );
    }
    const rows = await this.prisma.attachment.findMany({
      where: { ownerType, ownerId },
      select: {
        id: true,
        ownerType: true,
        mime: true,
        originalName: true,
        size: true,
        key: true,
        createdAt: true,
        expireAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    const readable = await this.storageConsistency.filterMetadataVisible(
      rows.filter((row) => row.expireAt === null || row.expireAt.getTime() > Date.now()),
    );
    return Promise.all(
      readable.map(async (row) => ({
        id: row.id,
        ownerType: row.ownerType,
        mime: row.mime,
        originalName: row.originalName,
        size: row.size,
        createdAt: row.createdAt,
        accessUrl: await this.resolveAccessUrl(row.key, row.expireAt),
      })),
    );
  }

  // 给 storage key 直接签下载 URL(列表封面缩略图反范式 key 直签,免 per-row Attachment 查询;
  // key null → null)。可信语义同上:调用方先做可见级校验。
  async resolveSignedUrlTrusted(key: string | null): Promise<string | null> {
    if (!key) return null;
    return this.resolveAccessUrl(key);
  }

  /**
   * Content-only storage facade. The caller must already hold the Content root FOR UPDATE lock and
   * must have completed its scoped authorization. This method performs no Provider or audit work.
   */
  async lockContentPublishStorageBoundaryTrusted(
    tx: Prisma.TransactionClient,
    input: ContentPublishStorageBoundaryInput,
  ): Promise<void> {
    return this.storageConsistency.lockContentPublishBoundary(tx, input);
  }

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
    return this.toResponseDto(state.row);
  }

  // ============ helpers:校验链(沿 D7 v1.0 §6.2 9 步)============

  // 1. ownerType 双层校验(Q1 v1.0):
  //    - 配置表先(权威;查 ACTIVE + 未软删的 AttachmentTypeConfig.code)
  //    - 业务层 enum 兜底(代码防错)
  //    失败抛 13010 ATTACHMENT_OWNER_TYPE_INVALID
  private async assertOwnerTypeAllowed(ownerType: string): Promise<{ ownerTable: string }> {
    // 业务层 enum 兜底先检(避免误配置表)
    if (!isKnownAttachmentOwnerType(ownerType)) {
      throw new BizException(BizCode.ATTACHMENT_OWNER_TYPE_INVALID);
    }

    const config = await this.prisma.attachmentTypeConfig.findFirst({
      where: notDeletedWhere({
        code: ownerType,
        status: AttachmentTypeConfigStatus.ACTIVE,
      }),
      select: { ownerTable: true },
    });
    if (!config) {
      throw new BizException(BizCode.ATTACHMENT_OWNER_TYPE_INVALID);
    }
    return { ownerTable: config.ownerTable };
  }

  // 2. ownerId 真实性校验(Q2 v1.0):
  //    按 ownerType 查对应业务表的活跃记录(未软删);失败抛 13011。
  //    activity / certificate / member 各自查对应表。
  private async assertOwnerExists(ownerType: AttachmentOwnerType, ownerId: string): Promise<void> {
    let found: { id: string } | null = null;
    if (ownerType === 'member') {
      found = await this.prisma.member.findFirst({
        where: notDeletedWhere({ id: ownerId }),
        select: { id: true },
      });
    } else if (ownerType === 'certificate') {
      found = await this.prisma.certificate.findFirst({
        where: notDeletedWhere({ id: ownerId }),
        select: { id: true },
      });
    } else if (ownerType === 'activity') {
      found = await this.prisma.activity.findFirst({
        where: notDeletedWhere({ id: ownerId }),
        select: { id: true },
      });
    } else if (ownerType === 'content-image' || ownerType === 'content-file') {
      // CMS(评审稿 §5.1):content-image / content-file 两 owner 均指向 contents 表(未软删)
      found = await this.prisma.content.findFirst({
        where: notDeletedWhere({ id: ownerId }),
        select: { id: true },
      });
    }
    if (!found) {
      throw new BizException(BizCode.ATTACHMENT_OWNER_NOT_FOUND);
    }
  }

  // 3. 构造 RbacResource(沿 D7 §6.3):member / certificate 都映射到 RBAC 'member';
  //    activity 无需 resource(不触发 .self)。
  //    certificate 需先查 Certificate.memberId,再构造 resource。
  private async buildRbacResourceAndScope(
    ownerType: AttachmentOwnerType,
    ownerId: string,
    user: CurrentUserPayload,
    certificateMemberById?: ReadonlyMap<string, string>,
  ): Promise<{
    resource: { ownerType: 'member'; ownerId: string } | undefined;
    scope: 'self' | 'other' | null;
  }> {
    if (ownerType === 'activity' || ownerType === 'content-image' || ownerType === 'content-file') {
      // activity / CMS content-* 粗粒度判权,无 self/other 区分(Q10 v1.0 锁;content 评审稿 §5.2)
      return { resource: undefined, scope: null };
    }

    let rbacMemberId: string;
    if (ownerType === 'member') {
      rbacMemberId = ownerId;
    } else if (certificateMemberById !== undefined) {
      const memberId = certificateMemberById.get(ownerId);
      if (memberId === undefined) {
        throw new BizException(BizCode.ATTACHMENT_OWNER_NOT_FOUND);
      }
      rbacMemberId = memberId;
    } else {
      // certificate:先查 Certificate.memberId
      const cert = await this.prisma.certificate.findFirst({
        where: notDeletedWhere({ id: ownerId }),
        select: { memberId: true },
      });
      if (!cert) {
        throw new BizException(BizCode.ATTACHMENT_OWNER_NOT_FOUND);
      }
      rbacMemberId = cert.memberId;
    }

    const isSelf = user.memberId !== null && user.memberId === rbacMemberId;
    return {
      resource: { ownerType: 'member', ownerId: rbacMemberId },
      scope: isSelf ? 'self' : 'other',
    };
  }

  // finding #11:list/listByOwner 的 certificate scope 映射一次批量取齐,避免每行 findFirst。
  private async loadCertificateMemberMap(
    certificateIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const ids = [...new Set(certificateIds)];
    if (ids.length === 0) return new Map();
    const certificates = await this.prisma.certificate.findMany({
      where: notDeletedWhere({ id: { in: ids } }),
      select: { id: true, memberId: true },
    });
    return new Map(certificates.map((certificate) => [certificate.id, certificate.memberId]));
  }

  // 4. mime 白名单校验(D7 §6.2 step 6):
  //    - 先检系统级黑名单(沿 §6.6;命中即 fail-close,**任何配置都不能放行**;失败抛 13033;沿 V2.x L-1)
  //    - 查 attachment_mime_configs(typeConfigId × mime 复合;ACTIVE + 未软删);若有 → 通过
  //    - 否则走 typeConfig.defaultMimeWhitelist 兜底
  //    - 全部未命中 → 抛 13012 ATTACHMENT_MIME_NOT_ALLOWED
  // V2.x L-1(2026-05-16):系统级黑名单与白名单未命中拆码,前端 / 运营可精确区分两种拒绝。
  private async assertMimeAllowed(ownerType: string, mime: string): Promise<void> {
    if (isMimeBlocked(mime)) {
      // 沿 D7 §6.6 + Q3 v1.0:系统级黑名单永久禁;Service 层显式兜底。
      // V2.x L-1:从复用 13012 拆为 13033 ATTACHMENT_SYSTEM_MIME_BLOCKED(沿 L-1 方案 A;
      // 评审稿 §8.1 原设计 13031,因 PR #99 占用顺延至 13033)。
      throw new BizException(BizCode.ATTACHMENT_SYSTEM_MIME_BLOCKED);
    }

    const typeConfig = await this.prisma.attachmentTypeConfig.findFirst({
      where: notDeletedWhere({
        code: ownerType,
        status: AttachmentTypeConfigStatus.ACTIVE,
      }),
      select: { id: true, defaultMimeWhitelist: true },
    });
    if (!typeConfig) {
      // 与 assertOwnerTypeAllowed 一致兜底(理论上 assertOwnerTypeAllowed 已先校验,
      // 但 mime 校验独立调用时仍需自洽)
      throw new BizException(BizCode.ATTACHMENT_OWNER_TYPE_INVALID);
    }

    // 查 mime override(ACTIVE + 未软删)
    const override = await this.prisma.attachmentMimeConfig.findFirst({
      where: notDeletedWhere({
        typeConfigId: typeConfig.id,
        mime,
        status: AttachmentMimeConfigStatus.ACTIVE,
      }),
      select: { id: true },
    });
    if (override) return;

    // 走 typeConfig.defaultMimeWhitelist 兜底
    if (typeConfig.defaultMimeWhitelist.includes(mime)) return;

    throw new BizException(BizCode.ATTACHMENT_MIME_NOT_ALLOWED);
  }

  // 5. size 上限校验(D7 §6.2 step 7):
  //    - 优先取 attachment_size_limit_configs(1:1 with typeConfig;未软删)
  //    - 否则走 typeConfig.defaultMaxSizeBytes
  //    - 两者都 null → 不限大小(fail-open 仅对 size;mime 是 fail-close)
  //    失败抛 13013 ATTACHMENT_SIZE_EXCEEDED
  private async assertSizeAllowed(ownerType: string, size: number): Promise<void> {
    const typeConfig = await this.prisma.attachmentTypeConfig.findFirst({
      where: notDeletedWhere({
        code: ownerType,
        status: AttachmentTypeConfigStatus.ACTIVE,
      }),
      select: { id: true, defaultMaxSizeBytes: true },
    });
    if (!typeConfig) {
      throw new BizException(BizCode.ATTACHMENT_OWNER_TYPE_INVALID);
    }

    const override = await this.prisma.attachmentSizeLimitConfig.findFirst({
      where: notDeletedWhere({ typeConfigId: typeConfig.id }),
      select: { maxSizeBytes: true },
    });

    const limit = override?.maxSizeBytes ?? typeConfig.defaultMaxSizeBytes ?? null;
    if (limit === null) return; // 无配置上限 → 不限
    if (size > limit) {
      throw new BizException(BizCode.ATTACHMENT_SIZE_EXCEEDED);
    }
  }

  // 6. PII 检测(Q4 v1.0;沿 D7 §9.4):
  //    检测 originalName / description / tags 是否含身份证号字符串;命中抛 13015
  //    **不**调用 OCR;**不**入库身份证号字符串
  private assertNoPii(dto: {
    originalName?: string;
    description?: string | null;
    tags?: readonly string[];
  }): void {
    if (
      detectPii({
        originalName: dto.originalName,
        description: dto.description,
        tags: dto.tags,
      })
    ) {
      throw new BizException(BizCode.ATTACHMENT_PII_DETECTED);
    }
  }

  // 7. 详情活跃记录查询:不存在统一返 13001(沿 v1 §10 信息泄漏防御;Q8 v1.0)。
  private async findByIdOrThrow(id: string): Promise<SafeAttachment> {
    const found = await this.prisma.attachment.findFirst({
      where: { id },
      select: attachmentSelect,
    });
    if (!found) throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    return found;
  }

  // 8. 通用 rbac.can() 失败抛 30100;沿 F5 v1.0
  private async assertRbacAllowed(
    user: CurrentUserPayload,
    action: string,
    resource: { ownerType: 'member'; ownerId: string } | undefined,
  ): Promise<void> {
    const allowed = await this.rbac.can(user, action, resource);
    if (!allowed) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  // 9. 读路径 RBAC 失败统一返 13001 ATTACHMENT_NOT_FOUND(Q13 v1.0:信息泄漏防御;
  //    避免攻击者通过 403 vs 404 探测附件存在性)。
  //    写路径(update / delete)沿 30100 RBAC_FORBIDDEN(已知附件存在,前置 detail 已通过)。
  private async assertReadAllowedOrThrowNotFound(
    user: CurrentUserPayload,
    action: string,
    resource: { ownerType: 'member'; ownerId: string } | undefined,
  ): Promise<void> {
    const allowed = await this.rbac.can(user, action, resource);
    if (!allowed) {
      // 不存在 + 无权统一返 13001(Q13)
      throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    }
  }

  private async issueUploadConfirmGuard(
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

  private issueUploadConfirmContext(state: UploadConfirmContextState): object {
    const context = Object.freeze(Object.create(null)) as object;
    this.uploadConfirmContexts.set(context, state);
    return context;
  }

  private requireUploadConfirmContext<Stage extends UploadConfirmContextState['stage']>(
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

  private consumeUploadConfirmContext<Stage extends UploadConfirmContextState['stage']>(
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

  private async prepareUploadConfirmInTransaction(
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

  private async verifyUploadConfirmEvidence(
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

  private async finalizeUploadConfirmInTransaction(
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

  private async lockVirginContentForUploadConfirm(
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

  // ============ 7 端点业务逻辑 ============

  // POST /api/admin/v1/attachments
  async create(
    dto: CreateAttachmentDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AttachmentResponseDto> {
    // 1. ownerType 双层校验(返 ownerTable;PR #6c 进 audit extra)
    const { ownerTable } = await this.assertOwnerTypeAllowed(dto.ownerType);

    // 2. ownerId 真实性校验
    await this.assertOwnerExists(dto.ownerType as AttachmentOwnerType, dto.ownerId);

    // 3. 构造 RBAC resource + scope(scope ∈ {'self', 'other', null};null=activity 粗粒度)
    const { resource, scope } = await this.buildRbacResourceAndScope(
      dto.ownerType as AttachmentOwnerType,
      dto.ownerId,
      user,
    );
    const action = `attachment.upload.${dto.ownerType}${scope ? '.' + scope : ''}`;

    // 4. RBAC 判权(F5 失败 → 30100)
    await this.assertRbacAllowed(user, action, resource);

    // 5. mime 白名单校验(13012)
    await this.assertMimeAllowed(dto.ownerType, dto.mime);

    // 6. size 上限校验(13013)
    await this.assertSizeAllowed(dto.ownerType, dto.size);

    // 7. PII 检测(13015)
    this.assertNoPii(dto);

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
    await this.assertOwnerExists(dto.ownerType as AttachmentOwnerType, dto.ownerId);

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
    return this.toResponseDto(row);
  }

  // GET /api/admin/v1/attachments(管理后台列表;按入参 query 过滤;逐条 ownership 过滤)。
  async list(
    query: ListAttachmentsQueryDto,
    user: CurrentUserPayload,
  ): Promise<PageResultDto<AttachmentResponseDto>> {
    const { page, pageSize, ownerType, ownerId, uploadedBy, mime, accessLevel, tags } = query;

    const where: Prisma.AttachmentWhereInput = {
      ...(ownerType !== undefined ? { ownerType } : {}),
      ...(ownerId !== undefined ? { ownerId } : {}),
      ...(uploadedBy !== undefined ? { uploadedBy } : {}),
      ...(mime !== undefined ? { mime } : {}),
      ...(accessLevel !== undefined ? { accessLevel } : {}),
      ...(tags !== undefined && tags.length > 0 ? { tags: { hasSome: tags } } : {}),
    };

    // 先取全部命中行(沿 D7 v1.0 §6.x:逐条 ownership 过滤后再分页;
    // 用户拍板 Q12:total 按"过滤后可见数量"返,避免泄露不可见资源数量)。
    // 性能边界:finding #11 certificate scope 已批量映射;#10 全量扫描+内存分页按现规模接受。
    const allRows = await this.prisma.attachment.findMany({
      where,
      select: attachmentSelect,
      orderBy: { createdAt: 'desc' },
    });
    const readableRows = await this.storageConsistency.filterMetadataVisible(allRows);
    const certificateMemberById = await this.loadCertificateMemberMap(
      readableRows.filter((row) => row.ownerType === 'certificate').map((row) => row.ownerId),
    );

    const visible: SafeAttachment[] = [];
    for (const row of readableRows) {
      if (await this.canViewAttachment(user, row, certificateMemberById)) {
        visible.push(row);
      }
    }
    const total = visible.length;
    const start = (page - 1) * pageSize;
    const items = await Promise.all(
      visible.slice(start, start + pageSize).map((row) => this.toResponseDto(row)),
    );
    return { items, total, page, pageSize };
  }

  // GET /api/admin/v1/attachments/:id
  async getById(id: string, user: CurrentUserPayload): Promise<AttachmentResponseDto> {
    // 1. 查活跃记录(不存在 → 13001)
    const row = await this.findByIdOrThrow(id);
    if (!(await this.storageConsistency.isMetadataVisible(row.key))) {
      throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    }

    // 2. 判 view 权限(Q13:不存在 + 无权统一返 13001)
    const { resource, scope } = await this.buildRbacResourceAndScope(
      row.ownerType as AttachmentOwnerType,
      row.ownerId,
      user,
    );
    const action = `attachment.view.${row.ownerType}${scope ? '.' + scope : ''}`;
    await this.assertReadAllowedOrThrowNotFound(user, action, resource);

    return this.toResponseDto(row);
  }

  // PATCH /api/admin/v1/attachments/:id
  async update(
    id: string,
    dto: UpdateAttachmentDto,
    user: CurrentUserPayload,
  ): Promise<AttachmentResponseDto> {
    // 1. 查活跃记录(不存在 → 13001)
    const row = await this.findByIdOrThrow(id);
    if (!(await this.storageConsistency.isMetadataVisible(row.key))) {
      throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    }

    // 2. 判 update 权限(写路径;失败 → 30100 RBAC_FORBIDDEN)
    const { resource, scope } = await this.buildRbacResourceAndScope(
      row.ownerType as AttachmentOwnerType,
      row.ownerId,
      user,
    );
    const action = `attachment.update.${row.ownerType}${scope ? '.' + scope : ''}`;
    await this.assertRbacAllowed(user, action, resource);

    // 3. PII 检测(description / tags;13015)
    this.assertNoPii({
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
    return this.toResponseDto(updated);
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
        return this.deleteReplayToResponseDto(replay.response);
      }
      throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    }

    // 2. 判 delete 权限(写路径;失败 → 30100)
    const { resource, scope } = await this.buildRbacResourceAndScope(
      row.ownerType as AttachmentOwnerType,
      row.ownerId,
      user,
    );
    const action = `attachment.delete.${row.ownerType}${scope ? '.' + scope : ''}`;
    await this.assertRbacAllowed(user, action, resource);

    // 3. DB intent 先提交；Provider effect 后以 HEAD absent 证明，再将 Attachment 硬删、audit、
    //    object absent 与 operation succeeded 同事务提交。任何不确定态都返回 13034。
    const eventKey = await this.storageConsistency.prepareDelete({
      attachmentId: row.id,
      actorUserId: user.id,
      actorRoleSnap: user.role,
      allowAuthorizedJoin: true,
      scope,
      deletedByPath: user.id === row.uploadedBy ? 'owner' : 'admin',
      auditMeta,
    });
    await this.storageConsistency.executeEventKey(eventKey);
    const replay = await this.storageConsistency.getDeleteReplay(row.id, user.id, {
      allowAuthorizedJoin: true,
    });
    if (replay?.state === 'succeeded' && replay.response) {
      return this.deleteReplayToResponseDto(replay.response);
    }
    throw new BizException(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING);
  }

  // GET /api/admin/v1/attachments/by-owner?ownerType=&ownerId=
  // 逐条 ownership 过滤;total 按可见数量返(沿 list 范式)。
  async listByOwner(
    query: ListAttachmentsByOwnerQueryDto,
    user: CurrentUserPayload,
  ): Promise<PageResultDto<AttachmentResponseDto>> {
    // 1. ownerType 双层校验(避免 enum 之外的字符串被传)
    await this.assertOwnerTypeAllowed(query.ownerType);

    // 2. ownerId 真实性校验(避免无效 cuid 返空列表泄露语义)。certificate 同批量映射查询合并。
    const certificateMemberById =
      query.ownerType === 'certificate'
        ? await this.loadCertificateMemberMap([query.ownerId])
        : undefined;
    if (query.ownerType === 'certificate') {
      if (!certificateMemberById?.has(query.ownerId)) {
        throw new BizException(BizCode.ATTACHMENT_OWNER_NOT_FOUND);
      }
    } else {
      await this.assertOwnerExists(query.ownerType as AttachmentOwnerType, query.ownerId);
    }

    // 3. 拉全部归属附件,逐条 ownership 过滤
    const allRows = await this.prisma.attachment.findMany({
      where: { ownerType: query.ownerType, ownerId: query.ownerId },
      select: attachmentSelect,
      orderBy: { createdAt: 'desc' },
    });
    const readableRows = await this.storageConsistency.filterMetadataVisible(allRows);
    const visible: SafeAttachment[] = [];
    for (const row of readableRows) {
      if (await this.canViewAttachment(user, row, certificateMemberById)) {
        visible.push(row);
      }
    }
    const total = visible.length;
    const start = (query.page - 1) * query.pageSize;
    const items = await Promise.all(
      visible.slice(start, start + query.pageSize).map((row) => this.toResponseDto(row)),
    );
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  // listMyUploaded — 本人上传列表(uploadedBy = currentUser.id;沿 D7 §5.1 端点 7:
  // **自动按 uploadedBy 筛**,不需要 RBAC,本人查自己豁免)。原 `GET /me/uploaded` 路由已于
  // Route B Phase 4e 删除,本方法暂无 live route,保留为未来 `app/v1/my/attachments` building block。
  async listMyUploaded(
    query: PaginationQueryDto,
    user: CurrentUserPayload,
  ): Promise<PageResultDto<AttachmentResponseDto>> {
    const { page, pageSize } = query;
    const where: Prisma.AttachmentWhereInput = { uploadedBy: user.id };

    const rows = await this.prisma.attachment.findMany({
      where,
      select: attachmentSelect,
      orderBy: { createdAt: 'desc' },
    });
    const readable = await this.storageConsistency.filterMetadataVisible(rows);
    const total = readable.length;
    const start = (page - 1) * pageSize;
    const items = await Promise.all(
      readable.slice(start, start + pageSize).map((row) => this.toResponseDto(row)),
    );
    return {
      items,
      total,
      page,
      pageSize,
    };
  }

  // ============ 内部:list / by-owner 共用 view ownership 判定 ============

  // 给定一条 attachment 行,判当前用户能否 view(走 .self / .other / 粗粒度 RBAC)。
  private async canViewAttachment(
    user: CurrentUserPayload,
    row: SafeAttachment,
    certificateMemberById?: ReadonlyMap<string, string>,
  ): Promise<boolean> {
    if (!ATTACHMENT_OWNER_TYPES.includes(row.ownerType as AttachmentOwnerType)) {
      // 数据库行 ownerType 不在 enum 内(理论上不该发生;防御性返 false)
      return false;
    }
    const { resource, scope } = await this.buildRbacResourceAndScope(
      row.ownerType as AttachmentOwnerType,
      row.ownerId,
      user,
      certificateMemberById,
    );
    const action = `attachment.view.${row.ownerType}${scope ? '.' + scope : ''}`;
    return this.rbac.can(user, action, resource);
  }

  // ============ V2.x C-7.5 PR #10:upload-url + confirm-upload ============
  //
  // 沿评审 §8.3 + §8.4 + Q-10-1 到 Q-10-15 拍板:
  // - upload-url:校验 owner/RBAC/mime/size/PII → 预写 durable storage intent → 生成 key + signed
  //   URL + uploadToken;尚不创建 Attachment / 不写业务 audit
  // - confirm-upload:验 token + headObject + size + 受支持 MIME 魔数一致 → 落库 + audit `attachment.upload`
  // - v0.44.0 finding #23 唯一新增 13016(内容与声明 MIME 不符);其余继续复用既有码
  // - 0 新 AuditLogEvent(沿 B4)
  // - 0 新 RBAC 权限点(沿 B3;复用 attachment.upload.<type>.<scope>)

  // POST /api/admin/v1/attachments/upload-url
  async createUploadUrl(
    dto: GenerateUploadUrlDto,
    user: CurrentUserPayload,
  ): Promise<UploadUrlResponseDto> {
    // === Step 1-7:沿现有 create() 校验链(§6.2 9 步) ===
    await this.assertOwnerTypeAllowed(dto.ownerType);
    await this.assertOwnerExists(dto.ownerType as AttachmentOwnerType, dto.ownerId);
    const { resource, scope } = await this.buildRbacResourceAndScope(
      dto.ownerType as AttachmentOwnerType,
      dto.ownerId,
      user,
    );
    const action = `attachment.upload.${dto.ownerType}${scope ? '.' + scope : ''}`;
    await this.assertRbacAllowed(user, action, resource);
    await this.assertMimeAllowed(dto.ownerType, dto.mime);
    await this.assertSizeAllowed(dto.ownerType, dto.sizeBytes);
    // PII 检测:upload-url 仅检 originalName(Q-10-5 不接受 description / tags)
    this.assertNoPii({ originalName: dto.originalName });

    // === Step 8:生成 key(沿 §6.4.2 + Q-10-3 + Q-10-4 + Q-10-15) ===
    const settings = await this.storageSettings.getActiveSettings();
    const envPrefix = settings?.envPrefix ?? this.cfg.env;
    const key = this.generateAttachmentKey(envPrefix, dto.mime);

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
    const guarded = await this.issueUploadConfirmGuard(dto, user);
    const guardedState = this.requireUploadConfirmContext(guarded, 'guarded');
    let prepared: object;
    if (isContentAttachmentOwnerType(guardedState.identity.ownerType)) {
      prepared = await this.prisma.$transaction(async (tx) => {
        await this.lockVirginContentForUploadConfirm(tx, guardedState.identity.ownerId);
        return this.prepareUploadConfirmInTransaction(tx, guarded);
      });
    } else {
      const locator = await this.storageConsistency.resolveUploadLocatorForTransaction(
        guardedState.identity.key,
      );
      prepared = await this.prisma.$transaction((tx) =>
        this.prepareUploadConfirmInTransaction(tx, guarded, locator),
      );
    }
    const verified = await this.verifyUploadConfirmEvidence(prepared);
    const verifiedState = this.requireUploadConfirmContext(verified, 'verified');

    // === Step 7:PII 不重做(沿 §8.4 Q10 + Q-10-X) ===

    // === Step 7.5(F10 #399):owner 仍存活复校 —— upload-url 签发后 owner 可能软删,confirm 落库前
    //     与 create() / createUploadUrl() 对齐补 assertOwnerExists,杜绝 owner 软删窗口内落悬空附件行。 ===
    if (!isContentAttachmentOwnerType(verifiedState.identity.ownerType)) {
      await this.assertOwnerExists(
        verifiedState.identity.ownerType as AttachmentOwnerType,
        verifiedState.identity.ownerId,
      );
    }

    // === Step 8:落库 + audit(同事务 fail-fast;沿 §8.4.3 Step 5 + PR #6c F6) ===
    // 需要 ownerTable 进 audit extra(沿现有 create);重查 typeConfig 拿 ownerTable
    const { ownerTable } = await this.assertOwnerTypeAllowed(verifiedState.identity.ownerType);
    // 重新 build scope 给 audit(沿 §8.4.3 Step 5 extra.scope)
    const { scope } = await this.buildRbacResourceAndScope(
      verifiedState.identity.ownerType as AttachmentOwnerType,
      verifiedState.identity.ownerId,
      user,
    );

    const finalized = await this.prisma.$transaction(async (tx) => {
      if (isContentAttachmentOwnerType(verifiedState.identity.ownerType)) {
        // The generic Attachment endpoint accepts Content tokens too. It must participate in the
        // same root-lock fence as the Content wrapper or it becomes a publish-vs-confirm bypass.
        await this.lockVirginContentForUploadConfirm(tx, verifiedState.identity.ownerId);
      }
      return this.finalizeUploadConfirmInTransaction(tx, verified, auditMeta, {
        ownerTable,
        scope,
      });
    });
    const finalizedState = this.requireUploadConfirmContext(finalized, 'finalized');

    // === Step 9-10:返完整 dto(toResponseDto 内已调 generateDownloadUrl 填 accessUrl;沿 PR #90) ===
    return this.toResponseDto(finalizedState.row);
  }

  // 沿 §6.4.2 + Q-10-3 + Q-10-4:`attachments/<env>/<yyyy>/<mm>/<dd>/<random>.<ext>`
  // random:crypto.randomBytes(12).toString('base64url')(16 字符;0 新依赖;沿 Q-10-3)
  // ext:从 MIME 推断;未命中 fallback `.bin`(沿 Q-10-4)
  private generateAttachmentKey(envPrefix: string, mime: string): string {
    const d = new Date();
    const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const random = randomBytes(12).toString('base64url');
    const ext = mimeToExt(mime);
    return `attachments/${envPrefix}/${yyyy}/${mm}/${dd}/${random}${ext}`;
  }
}

function isContentAttachmentOwnerType(ownerType: string): ownerType is ContentAttachmentOwnerType {
  return ownerType === 'content-image' || ownerType === 'content-file';
}

function requireUploadTokenExpiry(identity: AttachmentUploadStorageIdentity): number {
  if (identity.exp === undefined || !Number.isSafeInteger(identity.exp)) {
    throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
  }
  return identity.exp;
}
