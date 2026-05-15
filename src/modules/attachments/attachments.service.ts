import { Injectable } from '@nestjs/common';
import { AttachmentMimeConfigStatus, AttachmentTypeConfigStatus, Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto, PaginationQueryDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { RbacService } from '../permissions/rbac.service';
import {
  ATTACHMENT_OWNER_TYPES,
  AttachmentOwnerType,
  detectPii,
  isKnownAttachmentOwnerType,
  isMimeBlocked,
} from './attachment-validation';
import {
  AttachmentResponseDto,
  CreateAttachmentDto,
  ListAttachmentsByOwnerQueryDto,
  ListAttachmentsQueryDto,
  UpdateAttachmentDto,
} from './attachments.dto';
import { attachmentSelect } from './attachments.select';

// V2.x C-7 attachments 实施 PR #6b(2026-05-15):attachments 主模块业务逻辑。
//
// 沿 D7-attachments v1.0 §5 / §6 + 用户 PR #6b 14 项 Q 拍板:
// - F3 v1.0:Controller 入口仅 @UseGuards JwtAuthGuard;**所有判权在 Service 层** rbac.can()
// - F5 v1.0:RBAC 失败统一抛 BizException(BizCode.RBAC_FORBIDDEN)(30100)
// - Q1 v1.0:ownerType 双层校验 — 先查 attachment_type_configs(权威);enum 兜底
// - Q5 v1.0:Update 仅 description / accessLevel / tags / expireAt 四字段
// - Q8 v1.0:detail / update / delete 软删 / 不存在 / 无权统一返 13001(沿 v1 §10 信息泄漏防御)
// - Q11 v1.0:DELETE 物理删,不查跨表引用(不抛 IN_USE 13030)
// - Q13 v1.0:RBAC 写失败复用 30100;读路径用 13001 信息泄漏防御
// - Q14 v1.0:accessUrl 占位恒返 null(Provider 接通前;沿 D7 §5.5 / §5.6)
//
// **本 PR 不接入 audit_logs**(沿用户 Step 2 拍板:留 PR #6c 单独接入)。

// 全局兜底:无 mime 配置 + type 无 defaultMimeWhitelist 时,**不允许**任何 mime
// (fail-close;沿 v1 §10 / baseline 安全默认拒绝;由 13012 命中)

type SafeAttachment = Prisma.AttachmentGetPayload<{ select: typeof attachmentSelect }>;

// Q14 v1.0:accessUrl 占位恒返 null(Provider 接通前)。
function toResponseDto(row: SafeAttachment): AttachmentResponseDto {
  return { ...row, accessUrl: null };
}

@Injectable()
export class AttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
  ) {}

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
  //    - 先检系统级黑名单(沿 §6.6;命中即 fail-close,**任何配置都不能放行**;失败抛 13012)
  //    - 查 attachment_mime_configs(typeConfigId × mime 复合;ACTIVE + 未软删);若有 → 通过
  //    - 否则走 typeConfig.defaultMimeWhitelist 兜底
  //    - 全部未命中 → 抛 13012 ATTACHMENT_MIME_NOT_ALLOWED
  private async assertMimeAllowed(ownerType: string, mime: string): Promise<void> {
    if (isMimeBlocked(mime)) {
      // 沿 D7 §6.6 + Q3 v1.0:系统级黑名单永久禁;Service 层显式兜底
      throw new BizException(BizCode.ATTACHMENT_MIME_NOT_ALLOWED);
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

  // POST /api/v2/attachments
  async create(dto: CreateAttachmentDto, user: CurrentUserPayload): Promise<AttachmentResponseDto> {
    // 1. ownerType 双层校验
    await this.assertOwnerTypeAllowed(dto.ownerType);

    // 2. ownerId 真实性校验
    await this.assertOwnerExists(dto.ownerType as AttachmentOwnerType, dto.ownerId);

    // 3. 构造 RBAC resource + scope
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

    // 8. 写入(originalUploaderName 从 currentUser 冗余存;Q14 v1.0)。
    //    本 PR 不接 audit_logs(留 PR #6c;沿 Step 2 拍板)。
    const row = await this.prisma.attachment.create({
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
    return toResponseDto(row);
  }

  // GET /api/v2/attachments(管理后台列表;按入参 query 过滤;逐条 ownership 过滤)。
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
    const items = visible.slice(start, start + pageSize).map(toResponseDto);
    return { items, total, page, pageSize };
  }

  // GET /api/v2/attachments/:id
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

    return toResponseDto(row);
  }

  // PATCH /api/v2/attachments/:id
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
    return toResponseDto(updated);
  }

  // DELETE /api/v2/attachments/:id(Q11 v1.0:物理删,不查跨表引用)。
  async delete(id: string, user: CurrentUserPayload): Promise<AttachmentResponseDto> {
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

    // 3. 物理删(沿 D6 Q5 B / 删除矩阵 §6.4;不查 IN_USE)。
    //    本 PR 不接 Provider 文件删除(Q15 挂起待 Provider 评审;沿 Step 2 拍板)。
    await this.prisma.attachment.delete({ where: { id } });
    return toResponseDto(row);
  }

  // GET /api/v2/attachments/by-owner?ownerType=&ownerId=
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
    const items = visible.slice(start, start + query.pageSize).map(toResponseDto);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  // GET /api/v2/attachments/me/uploaded — 本人上传列表(uploadedBy = currentUser.id)。
  // 沿 D7 §5.1 端点 7:**自动按 uploadedBy 筛**,不需要 RBAC(本人查自己豁免)。
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
    return {
      items: rows.map(toResponseDto),
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
}
