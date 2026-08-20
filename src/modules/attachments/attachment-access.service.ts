import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { AttachmentMimeConfigStatus, AttachmentTypeConfigStatus, Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import type { AttachmentDeleteReplayResponse } from '../storage/storage-operation-payload';
import { StorageSettingsService } from '../storage/storage-settings.service';
import type { HeadObjectResult, StorageObjectLocator } from '../storage/storage.types';
import {} from '../storage/upload-token.util';
import appConfig from '../../config/app.config';
import { PrismaService } from '../../database/prisma.service';
import { RbacService } from '../permissions/rbac.service';
import { AttachmentStorageOrchestrator } from './attachment-storage-orchestrator';
import type {
  AttachmentUploadStorageIdentity,
  ContentAttachmentOwnerType,
  PreparedAttachmentStorageUpload,
} from './attachment-storage.types';
import {
  ATTACHMENT_OWNER_TYPES,
  AttachmentOwnerType,
  INTERNAL_ONLY_ATTACHMENT_OWNER_TYPES,
  detectPii,
  isKnownAttachmentOwnerType,
  isMimeBlocked,
} from './attachment-validation';
import { AttachmentResponseDto } from './attachments.dto';
import { attachmentSelect } from './attachments.select';
import { mimeToExt } from './mime-to-ext';

export type SafeAttachment = Prisma.AttachmentGetPayload<{ select: typeof attachmentSelect }>;

export const REGISTRATION_UPLOAD_ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);
export const REGISTRATION_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const ATTENDANCE_IMPORT_PREVIEW_OWNER_TYPE = 'attendance-import-preview';
export const ATTENDANCE_IMPORT_PREVIEW_MIME = 'text/csv';
export const ATTENDANCE_IMPORT_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

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

/** The App registration-upload route returns this deliberately small safe projection only. */
export interface RegistrationUploadAttachmentView {
  attachmentId: string;
  originalName: string;
  mime: string;
  size: number;
  createdAt: Date;
}

/** Internal-only binding; never serialized by an HTTP controller or audit payload. */
export interface RegistrationUploadSubmissionBinding {
  sessionId: string;
  attachmentId: string;
}

/** Internal-only success projection; it never contains a storage key, locator, URL, or CSV body. */
export interface AttendanceImportPreviewAttachmentView {
  attachmentId: string;
  fileDigest: string;
  size: number;
}

export interface UploadConfirmContextBase {
  identity: AttachmentUploadStorageIdentity;
  checksum: string | null;
  user: CurrentUserPayload;
  contentFacade: boolean;
}

export type UploadConfirmContextState =
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

export interface RegistrationUploadContextBase {
  identity: AttachmentUploadStorageIdentity;
  body: Buffer;
  locator: StorageObjectLocator;
  expiresAt: Date;
  user: CurrentUserPayload;
}

export type RegistrationUploadContextState =
  | (RegistrationUploadContextBase & { stage: 'validated' })
  | (RegistrationUploadContextBase & {
      stage: 'prepared';
      prepared: PreparedAttachmentStorageUpload;
    })
  | (RegistrationUploadContextBase & {
      stage: 'verified';
      prepared: PreparedAttachmentStorageUpload;
      head: HeadObjectResult;
    })
  | (RegistrationUploadContextBase & {
      stage: 'finalized';
      prepared: PreparedAttachmentStorageUpload;
      head: HeadObjectResult;
      row: SafeAttachment;
    });

export interface AttendanceImportPreviewUploadContextBase {
  identity: AttachmentUploadStorageIdentity;
  body: Buffer;
  locator: StorageObjectLocator;
  user: CurrentUserPayload;
  fileDigest: string;
}

export type AttendanceImportPreviewUploadContextState =
  | (AttendanceImportPreviewUploadContextBase & { stage: 'validated' })
  | (AttendanceImportPreviewUploadContextBase & {
      stage: 'prepared';
      prepared: PreparedAttachmentStorageUpload;
    })
  | (AttendanceImportPreviewUploadContextBase & {
      stage: 'verified';
      prepared: PreparedAttachmentStorageUpload;
      head: HeadObjectResult;
    })
  | (AttendanceImportPreviewUploadContextBase & {
      stage: 'finalized';
      prepared: PreparedAttachmentStorageUpload;
      head: HeadObjectResult;
      row: SafeAttachment;
    });

declare const attendanceImportPreviewAttachmentValidatedBrand: unique symbol;
declare const attendanceImportPreviewAttachmentPreparedBrand: unique symbol;
declare const attendanceImportPreviewAttachmentVerifiedBrand: unique symbol;
declare const attendanceImportPreviewAttachmentFinalizedBrand: unique symbol;

export type AttendanceImportPreviewAttachmentValidated = Readonly<{
  [attendanceImportPreviewAttachmentValidatedBrand]: never;
}>;

export type AttendanceImportPreviewAttachmentPrepared = Readonly<{
  [attendanceImportPreviewAttachmentPreparedBrand]: never;
}>;

export type AttendanceImportPreviewAttachmentVerified = Readonly<{
  [attendanceImportPreviewAttachmentVerifiedBrand]: never;
}>;

export type AttendanceImportPreviewAttachmentFinalized = Readonly<{
  [attendanceImportPreviewAttachmentFinalizedBrand]: never;
}>;

/*
 * 附件的**共享校验与判权层**:属主类型白名单 / 属主存在性 / RBAC 资源与 scope 构造 /
 * MIME 与体积白名单 / PII 守卫 / 按 id 回读 / 读可见性。被建单、改单、删除、三条上传链路共用。
 *
 * ⚠️ 判权做成注入而非把结果当入参传:漏传一个实参 = 一条判权凭空消失,而全仓单测可以零红。
 *
 * (Phase 6-B 第三域第七刀,§3.2;仅"搬家",判权 / 锁序 / 状态闸 / 审计逐字不变。)
 */
@Injectable()
export class AttachmentAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly storageConsistency: AttachmentStorageOrchestrator,
    private readonly storageSettings: StorageSettingsService,
    @Inject(appConfig.KEY) private readonly cfg: ConfigType<typeof appConfig>,
  ) {}

  // 1. ownerType 双层校验(Q1 v1.0):
  //    - 配置表先(权威;查 ACTIVE + 未软删的 AttachmentTypeConfig.code)
  //    - 业务层 enum 兜底(代码防错)
  //    失败抛 13010 ATTACHMENT_OWNER_TYPE_INVALID
  async assertOwnerTypeAllowed(ownerType: string): Promise<{ ownerTable: string }> {
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
  async assertOwnerExists(ownerType: AttachmentOwnerType, ownerId: string): Promise<void> {
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
  async buildRbacResourceAndScope(
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
  async loadCertificateMemberMap(
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
  async assertMimeAllowed(ownerType: string, mime: string): Promise<void> {
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
  async assertSizeAllowed(ownerType: string, size: number): Promise<void> {
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
  assertNoPii(dto: {
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

  // 7. 详情活跃记录查询:不存在统一返 13001
  // (沿 docs/reference/soft-delete-transactions.md §10 信息泄漏防御;Q8 v1.0)。
  async findByIdOrThrow(id: string): Promise<SafeAttachment> {
    const found = await this.prisma.attachment.findFirst({
      where: { id },
      select: attachmentSelect,
    });
    if (!found) throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    if (isInternalRegistrationAttachmentOwner(found.ownerType)) {
      throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    }
    return found;
  }

  // 8. 通用 rbac.can() 失败抛 30100;沿 F5 v1.0
  async assertRbacAllowed(
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
  async assertReadAllowedOrThrowNotFound(
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

  // 给定一条 attachment 行,判当前用户能否 view(走 .self / .other / 粗粒度 RBAC)。
  async canViewAttachment(
    user: CurrentUserPayload,
    row: SafeAttachment,
    certificateMemberById?: ReadonlyMap<string, string>,
  ): Promise<boolean> {
    if (isInternalRegistrationAttachmentOwner(row.ownerType)) return false;
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

  // accessUrl 只能经 durable ledger 的 pinned locator + HEAD 证明后生成；失败降级 null。
  async toResponseDto(row: SafeAttachment): Promise<AttachmentResponseDto> {
    const accessUrl = await this.resolveAccessUrl(row.key, row.expireAt);
    return { ...row, accessUrl };
  }

  deleteReplayToResponseDto(response: AttachmentDeleteReplayResponse): AttachmentResponseDto {
    return {
      ...response,
      uploadedAt: new Date(response.uploadedAt),
      createdAt: new Date(response.createdAt),
      updatedAt: new Date(response.updatedAt),
    };
  }

  // expireAt 在本单点生效；调用方只给 key 时补查 Attachment 行。
  async resolveAccessUrl(key: string, expireAt?: Date | null): Promise<string | null> {
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

  // 沿 §6.4.2 + Q-10-3 + Q-10-4:`attachments/<env>/<yyyy>/<mm>/<dd>/<random>.<ext>`
  // random:crypto.randomBytes(12).toString('base64url')(16 字符;0 新依赖;沿 Q-10-3)
  // ext:从 MIME 推断;未命中 fallback `.bin`(沿 Q-10-4)
  generateAttachmentKey(envPrefix: string, mime: string): string {
    const d = new Date();
    const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const random = randomBytes(12).toString('base64url');
    const ext = mimeToExt(mime);
    return `attachments/${envPrefix}/${yyyy}/${mm}/${dd}/${random}${ext}`;
  }
}

// 名字沿用历史(它最早只管 registration 那两个 owner),**函数名已经名不副实** ——
// 现在它管的是全部 internal-only owner,包括账号头像与队员标准照。
// 刻意不在本刀改名:9 个调用点散在 5 个文件里,改名会把一刀纯 additive 的 diff 冲淡成
// 一片重命名噪音,评审看不清真正的改动。名单本身已收敛到唯一真相(见下)。
export function isInternalRegistrationAttachmentOwner(ownerType: string): boolean {
  return (INTERNAL_ONLY_ATTACHMENT_OWNER_TYPES as readonly string[]).includes(ownerType);
}

export function isContentAttachmentOwnerType(
  ownerType: string,
): ownerType is ContentAttachmentOwnerType {
  return ownerType === 'content-image' || ownerType === 'content-file';
}

export function requireUploadTokenExpiry(identity: AttachmentUploadStorageIdentity): number {
  if (identity.exp === undefined || !Number.isSafeInteger(identity.exp)) {
    throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
  }
  return identity.exp;
}
