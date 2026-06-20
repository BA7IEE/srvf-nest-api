import { randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { AttachmentMimeConfigStatus, AttachmentTypeConfigStatus, Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto, PaginationQueryDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { CosProviderUnavailableError } from '../storage/providers/cos.provider';
import { StorageSettingsService } from '../storage/storage-settings.service';
import { STORAGE_PROVIDER } from '../storage/storage.constants';
import type { StorageProvider } from '../storage/storage.interface';
import {
  signUploadToken,
  UploadTokenExpiredError,
  UploadTokenInvalidError,
  verifyUploadToken,
} from '../storage/upload-token.util';
import appConfig from '../../config/app.config';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { RbacService } from '../permissions/rbac.service';
import { AttachmentAuditRecorder } from './attachment-audit-recorder';
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

@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly attachmentAuditRecorder: AttachmentAuditRecorder,
    @Inject(STORAGE_PROVIDER) private readonly provider: StorageProvider,
    private readonly storageSettings: StorageSettingsService,
    @Inject(appConfig.KEY)
    private readonly cfg: ConfigType<typeof appConfig>,
  ) {}

  // Q14 v1.0 + PR #90:Provider 接通后 accessUrl 由 generateDownloadUrl 生成;
  // Provider 不可用(凭证缺失 / 网络抖动 / settings invalid)→ 降级 null(沿 §6.6.3 信息泄漏防御)。
  // toResponseDto 改为实例 async method(沿 Q-90-1;访问 this.provider / this.storageSettings)。
  private async toResponseDto(row: SafeAttachment): Promise<AttachmentResponseDto> {
    const accessUrl = await this.resolveAccessUrl(row.key);
    return { ...row, accessUrl };
  }

  // PR #90:accessUrl 解析失败统一降级 null;不向 client 抛凭证状态(沿 Q13 / §6.6 安全边界)
  private async resolveAccessUrl(key: string): Promise<string | null> {
    try {
      // TTL 来源:storage_settings.downloadUrlTtlSeconds(沿 Q8 + Q-90-2);
      // settings null(DB 空 / Router fallback Local)→ 兜底 300s
      const settings = await this.storageSettings.getActiveSettings();
      const expiresIn = settings?.downloadUrlTtlSeconds ?? 300;
      const result = await this.provider.generateDownloadUrl({ key, expiresIn });
      return result.url;
    } catch (err) {
      if (err instanceof CosProviderUnavailableError) {
        // 不在日志中暴露凭证细节(err.message 已经按 §6.6.2 过滤;只透露状态名)
        this.logger.warn(`accessUrl unavailable (cos): ${err.message}`);
      } else {
        this.logger.warn(`accessUrl generation failed: ${(err as Error).message}; key=${key}`);
      }
      return null;
    }
  }

  // PR #90:事务外同步尝试 Provider 删除(沿 F4 + Q3 路线 C);
  // 失败 logger.warn,不回滚 DB / audit;依赖 Provider lifecycle 30 天兜底(沿 §6.4.5 / Q11)。
  // Q3 audit extra.providerDeleteStatus 留 v1.1+ 评审(沿 Q-90-4)。
  private async tryDeleteFromProvider(key: string): Promise<void> {
    try {
      await this.provider.deleteObject(key);
    } catch (err) {
      this.logger.warn(`provider deleteObject failed; key=${key}; ${(err as Error).message}`);
    }
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
  ): Promise<{
    resource: { ownerType: 'member'; ownerId: string } | undefined;
    scope: 'self' | 'other' | null;
  }> {
    if (ownerType === 'activity') {
      // activity 粗粒度判权,无 self/other 区分(Q10 v1.0 锁)
      return { resource: undefined, scope: null };
    }

    let rbacMemberId: string;
    if (ownerType === 'member') {
      rbacMemberId = ownerId;
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

    // 8. 事务内:写主表 + audit 落库(沿 D7 §7.2 同事务 fail-fast)。
    //    校验链(步骤 1-7)留事务外(PR #6c Q7 拍板;读不需事务);
    //    auditLogs.log 失败 → $transaction 自动回滚 attachment.create。
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.attachment.create({
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
        select: attachmentSelect,
      });

      await this.attachmentAuditRecorder.logUpload({
        created,
        actorUserId: user.id,
        actorRoleSnap: user.role,
        scope,
        ownerTable,
        auditMeta,
        tx,
      });

      return created;
    });
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
    // 性能边界:管理后台列表场景;若数据膨胀至万级再走批量 ownership 优化(后续 PR)。
    const allRows = await this.prisma.attachment.findMany({
      where,
      select: attachmentSelect,
      orderBy: { createdAt: 'desc' },
    });

    const visible: SafeAttachment[] = [];
    for (const row of allRows) {
      if (await this.canViewAttachment(user, row)) {
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

    // 4. 更新 4 字段(其余字段已经 DTO 白名单 + forbidNonWhitelisted 兜底);
    //    expireAt: 显式 null → 清空;undefined → 不动;字符串 → new Date()
    const updated = await this.prisma.attachment.update({
      where: { id },
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
    return this.toResponseDto(updated);
  }

  // DELETE /api/admin/v1/attachments/:id(Q11 v1.0:物理删,不查跨表引用)。
  async delete(
    id: string,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AttachmentResponseDto> {
    // 1. 查活跃记录(不存在 → 13001)
    const row = await this.findByIdOrThrow(id);

    // 2. 判 delete 权限(写路径;失败 → 30100)
    const { resource, scope } = await this.buildRbacResourceAndScope(
      row.ownerType as AttachmentOwnerType,
      row.ownerId,
      user,
    );
    const action = `attachment.delete.${row.ownerType}${scope ? '.' + scope : ''}`;
    await this.assertRbacAllowed(user, action, resource);

    // 3. 事务内:物理删主表 + audit 落库(沿 D7 §7.2 同事务 fail-fast)。
    //    Q11 v1.0:不查跨表引用 IN_USE;Q15 挂起:Provider 文件删除留 Provider 评审。
    //    deletedByPath:沿 Q5 PR #6c 拍板,以 uploadedBy 为基准(currentUser 删自己上传的 → 'owner',
    //    否则 → 'admin';SUPER_ADMIN 删自己上传的也算 owner)。
    await this.prisma.$transaction(async (tx) => {
      await tx.attachment.delete({ where: { id } });

      await this.attachmentAuditRecorder.logDelete({
        attachmentId: row.id,
        before: row,
        actorUserId: user.id,
        actorRoleSnap: user.role,
        scope,
        deletedByPath: user.id === row.uploadedBy ? 'owner' : 'admin',
        auditMeta,
        tx,
      });
    });

    // PR #90 + F4 + Q3 路线 C:事务外同步尝试 Provider 删除;失败不回滚 DB / audit
    // 沿 Q-90-4:audit extra.providerDeleteStatus 不写(留 v1.1+);依赖 Provider lifecycle 兜底
    await this.tryDeleteFromProvider(row.key);

    return this.toResponseDto(row);
  }

  // GET /api/admin/v1/attachments/by-owner?ownerType=&ownerId=
  // 逐条 ownership 过滤;total 按可见数量返(沿 list 范式)。
  async listByOwner(
    query: ListAttachmentsByOwnerQueryDto,
    user: CurrentUserPayload,
  ): Promise<PageResultDto<AttachmentResponseDto>> {
    // 1. ownerType 双层校验(避免 enum 之外的字符串被传)
    await this.assertOwnerTypeAllowed(query.ownerType);

    // 2. ownerId 真实性校验(避免无效 cuid 返空列表泄露语义)
    await this.assertOwnerExists(query.ownerType as AttachmentOwnerType, query.ownerId);

    // 3. 拉全部归属附件,逐条 ownership 过滤
    const allRows = await this.prisma.attachment.findMany({
      where: { ownerType: query.ownerType, ownerId: query.ownerId },
      select: attachmentSelect,
      orderBy: { createdAt: 'desc' },
    });
    const visible: SafeAttachment[] = [];
    for (const row of allRows) {
      if (await this.canViewAttachment(user, row)) {
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

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.attachment.findMany({
        where,
        select: attachmentSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.attachment.count({ where }),
    ]);
    const items = await Promise.all(rows.map((row) => this.toResponseDto(row)));
    return {
      items,
      total,
      page,
      pageSize,
    };
  }

  // ============ 内部:list / by-owner 共用 view ownership 判定 ============

  // 给定一条 attachment 行,判当前用户能否 view(走 .self / .other / 粗粒度 RBAC)。
  private async canViewAttachment(user: CurrentUserPayload, row: SafeAttachment): Promise<boolean> {
    if (!ATTACHMENT_OWNER_TYPES.includes(row.ownerType as AttachmentOwnerType)) {
      // 数据库行 ownerType 不在 enum 内(理论上不该发生;防御性返 false)
      return false;
    }
    const { resource, scope } = await this.buildRbacResourceAndScope(
      row.ownerType as AttachmentOwnerType,
      row.ownerId,
      user,
    );
    const action = `attachment.view.${row.ownerType}${scope ? '.' + scope : ''}`;
    return this.rbac.can(user, action, resource);
  }

  // ============ V2.x C-7.5 PR #10:upload-url + confirm-upload ============
  //
  // 沿评审 §8.3 + §8.4 + Q-10-1 到 Q-10-15 拍板:
  // - upload-url:校验 owner/RBAC/mime/size/PII → 生成 key + signed URL + uploadToken;**不落库 / 不审计**
  // - confirm-upload:验 token + headObject + size 一致 → 落库 + audit `attachment.upload`(沿 B4)
  // - 0 新 BizCode(沿 §8.3.5 + §8.4.5;复用 13001/13010-13013/13015/30100/40100)
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

    // === Step 10:调 provider.generateUploadUrl ===
    const uploadResult = await this.provider.generateUploadUrl({
      key,
      contentType: dto.mime,
      sizeBytes: dto.sizeBytes,
      expiresIn: uploadUrlTtlSeconds,
    });

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
    // === Step 1-3:验 token + exp + uploadedByUserId === user.id(沿 §8.4.3 + Q-10-7) ===
    let claims;
    try {
      claims = verifyUploadToken(dto.uploadToken, this.cfg.storage.encryptionKey);
    } catch (err) {
      if (err instanceof UploadTokenInvalidError || err instanceof UploadTokenExpiredError) {
        // 沿 Q13 信息泄漏防御 + Q-10-11 不新增 BizCode → 统一返 13001
        throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
      }
      throw err;
    }
    if (claims.uploadedByUserId !== user.id) {
      // 沿 §8.4.5 + Q-10-7:claims 已携 uploadedByUserId,不重做 RBAC;
      // 只校验 user 比对;不一致返 30100(写路径)
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }

    // === Step 4:provider.headObject 校验文件已上传 ===
    const head = await this.provider.headObject(claims.key);
    if (!head.exists) {
      // 沿 Q13 信息泄漏防御:不存在统一返 13001(沿 §8.4.5)
      throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    }

    // === Step 5:size 一致性校验(沿 §8.4.3 Step 3) ===
    // head.size === undefined(LocalProvider 不持久化时也会返 size;COS 走 content-length)
    // 严格 ===;不一致返 13013
    if (head.size !== undefined && head.size !== claims.sizeBytes) {
      throw new BizException(BizCode.ATTACHMENT_SIZE_EXCEEDED);
    }

    // === Step 6:contentType 不校验(沿 Q-10-9) ===
    // === Step 7:PII 不重做(沿 §8.4 Q10 + Q-10-X) ===

    // === Step 8:落库 + audit(同事务 fail-fast;沿 §8.4.3 Step 5 + PR #6c F6) ===
    // 需要 ownerTable 进 audit extra(沿现有 create);重查 typeConfig 拿 ownerTable
    const { ownerTable } = await this.assertOwnerTypeAllowed(claims.ownerType);
    // 重新 build scope 给 audit(沿 §8.4.3 Step 5 extra.scope)
    const { scope } = await this.buildRbacResourceAndScope(
      claims.ownerType as AttachmentOwnerType,
      claims.ownerId,
      user,
    );

    let row: SafeAttachment;
    try {
      row = await this.prisma.$transaction(async (tx) => {
        // 沿 Q-10-8 + attachment_key_unique migration:二次提交防御(同 key 重复 confirm)
        // schema 已加 attachment.key @unique(沿评审 §8.4.4);双层防御:
        // - 串行场景:findFirst 早返 13001(省一次 INSERT 尝试 + tx ROLLBACK 开销)
        // - 并发 race:findFirst 都看不到对方时,由 P2002 catch 兜底返 13001(沿 catch 块)
        const exists = await tx.attachment.findFirst({
          where: { key: claims.key },
          select: { id: true },
        });
        if (exists) {
          throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
        }

        const created = await tx.attachment.create({
          data: {
            key: claims.key,
            originalName: claims.originalName,
            mime: claims.mime,
            size: claims.sizeBytes,
            uploadedBy: user.id,
            ownerType: claims.ownerType,
            ownerId: claims.ownerId,
            originalUploaderName: user.username,
            checksum: dto.checksum ?? null,
            etag: head.etag ?? null,
          },
          select: attachmentSelect,
        });

        await this.attachmentAuditRecorder.logUploadConfirmed({
          created,
          actorUserId: user.id,
          actorRoleSnap: user.role,
          scope,
          ownerTable,
          auditMeta,
          tx,
        });

        return created;
      });
    } catch (err) {
      // 双层兜底:若未来 schema 加 @unique → P2002 也走信息泄漏防御
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        ((err.meta?.target as string[] | undefined) ?? []).includes('key')
      ) {
        throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
      }
      throw err;
    }

    // === Step 9-10:返完整 dto(toResponseDto 内已调 generateDownloadUrl 填 accessUrl;沿 PR #90) ===
    return this.toResponseDto(row);
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
