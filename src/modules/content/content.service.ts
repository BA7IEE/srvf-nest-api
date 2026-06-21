import { Injectable } from '@nestjs/common';
import {
  DictItemStatus,
  DictTypeStatus,
  OrganizationStatus,
  Prisma,
  type Content,
} from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { AttachmentOwnerType } from '../attachments/attachment-validation';
import { AttachmentsService } from '../attachments/attachments.service';
import { RbacService } from '../permissions/rbac.service';
import {
  CONTENT_OWNER_TYPE_FILE,
  CONTENT_OWNER_TYPE_IMAGE,
  CONTENT_STATUS_ARCHIVED,
  CONTENT_STATUS_DRAFT,
  CONTENT_STATUS_PUBLISHED,
  CONTENT_TYPE_DICT_CODE,
  CONTENT_VISIBILITY_DEPARTMENT,
  ownerTypeForKind,
  rewriteBody,
} from './content.constants';
import type {
  ContentAttachmentConfirmDto,
  ContentAttachmentDto,
  ContentAttachmentUploadUrlDto,
  ContentAdminDetailDto,
  ContentAdminListItemDto,
  CreateContentDto,
  ListContentAdminQueryDto,
  SetContentCoverDto,
  UpdateContentDto,
} from './content.dto';

// CMS 内容发布模块(第 28 模块)T2(2026-06-21):content admin 业务逻辑(评审稿 §3/§5/§6/§8)。
//
// 判权全在 service rbac.can()(R 模式,镜像 attachments/recruitment;入口仅 JwtAuthGuard,无 @Roles)。
// 写路径(create/update/softDelete/状态机/set-cover)= prisma.$transaction wrap DB 写 + audit.log。
// 附件上传/确认/删委托 AttachmentsService(其内部强制 attachment.{upload,delete}.content-* coarse RBAC);
// content 读取面用 listOwnerAttachmentsTrusted / resolveSignedUrlTrusted 自签(可见级闸由 content 控)。
const AUDIT_RESOURCE_TYPE = 'content';

@Injectable()
export class ContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly auditLogs: AuditLogsService,
    private readonly attachments: AttachmentsService,
  ) {}

  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  private async findOrThrow(
    id: string,
    client: PrismaService | Prisma.TransactionClient,
  ): Promise<Content> {
    const row = await client.content.findFirst({ where: notDeletedWhere({ id }) });
    if (!row) {
      throw new BizException(BizCode.CONTENT_NOT_FOUND);
    }
    return row;
  }

  // ===== 校验:contentTypeCode 须为 content_type 字典 ACTIVE item(评审稿 §6) =====
  private async assertContentTypeValid(code: string): Promise<void> {
    const item = await this.prisma.dictItem.findFirst({
      where: notDeletedWhere({
        code,
        status: DictItemStatus.ACTIVE,
        type: { code: CONTENT_TYPE_DICT_CODE, status: DictTypeStatus.ACTIVE, deletedAt: null },
      }),
      select: { id: true },
    });
    if (!item) {
      throw new BizException(BizCode.CONTENT_TYPE_INVALID);
    }
  }

  // ===== 校验 + 归一 visibleOrganizationIds(评审稿 §6) =====
  // department 档:必须非空 + 每个 id 为活跃未软删 Organization;非 department 档:归一为 []。
  private async resolveVisibleOrgIds(
    visibilityCode: string,
    visibleOrganizationIds: string[] | undefined,
  ): Promise<string[]> {
    if (visibilityCode !== CONTENT_VISIBILITY_DEPARTMENT) {
      // 非 department 档:必须为空(传了非空即非法,避免脏数据;归一为 [])
      if (visibleOrganizationIds && visibleOrganizationIds.length > 0) {
        throw new BizException(BizCode.CONTENT_VISIBLE_ORG_INVALID);
      }
      return [];
    }
    // department 档:非空 + 全部存在且活跃
    const ids = visibleOrganizationIds ?? [];
    if (ids.length === 0) {
      throw new BizException(BizCode.CONTENT_VISIBLE_ORG_INVALID);
    }
    const uniqueIds = [...new Set(ids)];
    const found = await this.prisma.organization.findMany({
      where: notDeletedWhere({ id: { in: uniqueIds }, status: OrganizationStatus.ACTIVE }),
      select: { id: true },
    });
    if (found.length !== uniqueIds.length) {
      throw new BizException(BizCode.CONTENT_VISIBLE_ORG_INVALID);
    }
    return uniqueIds;
  }

  // ============ 端点 1:建草稿 ============
  async create(
    dto: CreateContentDto,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ): Promise<ContentAdminDetailDto> {
    await this.assertCanOrThrow(user, 'content.create.record');
    await this.assertContentTypeValid(dto.contentTypeCode);
    const visibleOrganizationIds = await this.resolveVisibleOrgIds(
      dto.visibilityCode,
      dto.visibleOrganizationIds,
    );

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.content.create({
        data: {
          title: dto.title,
          summary: dto.summary ?? null,
          body: dto.body,
          contentTypeCode: dto.contentTypeCode,
          statusCode: CONTENT_STATUS_DRAFT, // create → draft(评审稿 §3)
          visibilityCode: dto.visibilityCode,
          visibleOrganizationIds,
          tags: dto.tags ?? [],
          pinned: dto.pinned ?? false,
          authorUserId: user.id,
        },
      });
      await this.auditLogs.log({
        event: 'content.create',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: created.id,
        meta,
        after: {
          title: created.title,
          statusCode: created.statusCode,
          visibilityCode: created.visibilityCode,
          contentTypeCode: created.contentTypeCode,
        },
        tx,
      });
      return created;
    });
    return this.toDetailDto(row);
  }

  // ============ 端点 2:列表 ============
  async list(
    query: ListContentAdminQueryDto,
    user: CurrentUserPayload,
  ): Promise<PageResultDto<ContentAdminListItemDto>> {
    await this.assertCanOrThrow(user, 'content.read.record');

    // admin 见全部状态/全部可见档(无可见性过滤;评审稿 §4.3)
    const where: Prisma.ContentWhereInput = { deletedAt: null };
    if (query.statusCode !== undefined) where.statusCode = query.statusCode;
    if (query.contentTypeCode !== undefined) where.contentTypeCode = query.contentTypeCode;
    if (query.visibilityCode !== undefined) where.visibilityCode = query.visibilityCode;
    if (query.pinned !== undefined) where.pinned = query.pinned;
    if (query.keyword !== undefined && query.keyword.length > 0) {
      where.OR = [
        { title: { contains: query.keyword, mode: 'insensitive' } },
        { body: { contains: query.keyword, mode: 'insensitive' } },
      ];
    }
    if (query.tags !== undefined && query.tags.length > 0) {
      where.tags = { hasSome: query.tags };
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.content.findMany({
        where,
        // pinned desc → publishedAt desc(nulls last)→ createdAt desc(评审稿 §8 端点 2)
        orderBy: [
          { pinned: 'desc' },
          { publishedAt: { sort: 'desc', nulls: 'last' } },
          { createdAt: 'desc' },
        ],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.content.count({ where }),
    ]);

    const items = await Promise.all(rows.map((r) => this.toListItemDto(r)));
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  // ============ 端点 3:详情(不增 viewCount;评审稿 §8 端点 3 / C)============
  async detail(id: string, user: CurrentUserPayload): Promise<ContentAdminDetailDto> {
    await this.assertCanOrThrow(user, 'content.read.record');
    const row = await this.findOrThrow(id, this.prisma);
    return this.toDetailDto(row);
  }

  // ============ 端点 4:更新(archived 冻结 → 29030)============
  async update(
    id: string,
    dto: UpdateContentDto,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ): Promise<ContentAdminDetailDto> {
    await this.assertCanOrThrow(user, 'content.update.record');

    const row = await this.prisma.$transaction(async (tx) => {
      const existing = await this.findOrThrow(id, tx);
      // 更新仅 draft / published 可改;archived 冻结(评审稿 §3)
      if (existing.statusCode === CONTENT_STATUS_ARCHIVED) {
        throw new BizException(BizCode.CONTENT_INVALID_STATUS_TRANSITION);
      }

      // 校验类型 / 可见档(仅当本次有传入时)
      if (dto.contentTypeCode !== undefined) {
        await this.assertContentTypeValid(dto.contentTypeCode);
      }

      const data: Prisma.ContentUpdateInput = {};
      if (dto.title !== undefined) data.title = dto.title;
      if (dto.summary !== undefined) data.summary = dto.summary;
      if (dto.body !== undefined) data.body = dto.body;
      if (dto.contentTypeCode !== undefined) data.contentTypeCode = dto.contentTypeCode;
      if (dto.tags !== undefined) data.tags = dto.tags;
      if (dto.pinned !== undefined) data.pinned = dto.pinned;

      // 可见档 + 可见部门:visibilityCode 改了要重算 visibleOrganizationIds;
      // 只改 visibleOrganizationIds(visibilityCode 沿用旧值)也要按当前(新或旧)可见档校验。
      const nextVisibility = dto.visibilityCode ?? existing.visibilityCode;
      if (dto.visibilityCode !== undefined || dto.visibleOrganizationIds !== undefined) {
        const nextOrgIds = await this.resolveVisibleOrgIds(
          nextVisibility,
          dto.visibleOrganizationIds !== undefined
            ? dto.visibleOrganizationIds
            : existing.visibleOrganizationIds,
        );
        if (dto.visibilityCode !== undefined) data.visibilityCode = dto.visibilityCode;
        data.visibleOrganizationIds = nextOrgIds;
      }

      const updated = await tx.content.update({ where: { id }, data });
      await this.auditLogs.log({
        event: 'content.update',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: updated.id,
        meta,
        before: { title: existing.title, visibilityCode: existing.visibilityCode },
        after: { title: updated.title, visibilityCode: updated.visibilityCode },
        tx,
      });
      return updated;
    });
    return this.toDetailDto(row);
  }

  // ============ 端点 5:软删(任意态)============
  async softDelete(id: string, user: CurrentUserPayload, meta: AuditMeta): Promise<void> {
    await this.assertCanOrThrow(user, 'content.delete.record');
    await this.prisma.$transaction(async (tx) => {
      const existing = await this.findOrThrow(id, tx);
      await tx.content.update({ where: { id }, data: { deletedAt: new Date() } });
      await this.auditLogs.log({
        event: 'content.delete',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: existing.id,
        meta,
        before: { title: existing.title, statusCode: existing.statusCode },
        tx,
      });
    });
  }

  // ============ 端点 6/7/8:状态机(publish / unpublish / archive)============
  async publish(
    id: string,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ): Promise<ContentAdminDetailDto> {
    return this.transition(id, user, meta, 'publish');
  }

  async unpublish(
    id: string,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ): Promise<ContentAdminDetailDto> {
    return this.transition(id, user, meta, 'unpublish');
  }

  async archive(
    id: string,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ): Promise<ContentAdminDetailDto> {
    return this.transition(id, user, meta, 'archive');
  }

  // 状态机内嵌(评审稿 §3;立即生效无 cron)。非法跃迁 → 29030。
  private async transition(
    id: string,
    user: CurrentUserPayload,
    meta: AuditMeta,
    operation: 'publish' | 'unpublish' | 'archive',
  ): Promise<ContentAdminDetailDto> {
    await this.assertCanOrThrow(user, 'content.publish.record');

    const row = await this.prisma.$transaction(async (tx) => {
      const existing = await this.findOrThrow(id, tx);
      const data: Prisma.ContentUpdateInput = {};

      if (operation === 'publish') {
        // 仅 draft → published;置 publishedAt = now
        if (existing.statusCode !== CONTENT_STATUS_DRAFT) {
          throw new BizException(BizCode.CONTENT_INVALID_STATUS_TRANSITION);
        }
        data.statusCode = CONTENT_STATUS_PUBLISHED;
        data.publishedAt = new Date();
      } else if (operation === 'unpublish') {
        // 仅 published → draft;publishedAt 保留(评审稿 §3)
        if (existing.statusCode !== CONTENT_STATUS_PUBLISHED) {
          throw new BizException(BizCode.CONTENT_INVALID_STATUS_TRANSITION);
        }
        data.statusCode = CONTENT_STATUS_DRAFT;
      } else {
        // archive:仅 published → archived(终态)
        if (existing.statusCode !== CONTENT_STATUS_PUBLISHED) {
          throw new BizException(BizCode.CONTENT_INVALID_STATUS_TRANSITION);
        }
        data.statusCode = CONTENT_STATUS_ARCHIVED;
      }

      const updated = await tx.content.update({ where: { id }, data });
      await this.auditLogs.log({
        event: 'content.publish', // 伞事件:operation 区分(评审稿 §7)
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: updated.id,
        meta,
        before: { statusCode: existing.statusCode },
        after: { statusCode: updated.statusCode },
        extra: { operation },
        tx,
      });
      return updated;
    });
    return this.toDetailDto(row);
  }

  // ============ 端点 9:取上传 URL(委托 AttachmentsService;其内部判 attachment.upload.content-*)============
  async createAttachmentUploadUrl(
    contentId: string,
    dto: ContentAttachmentUploadUrlDto,
    user: CurrentUserPayload,
  ) {
    // owner 先存在(评审稿 §5.3;先草稿后传图/附件)。AttachmentsService 内部亦会复校,此处先给 29001 语义。
    await this.findOrThrow(contentId, this.prisma);
    const ownerType = ownerTypeForKind(dto.kind);
    return this.attachments.createUploadUrl(
      {
        ownerType,
        ownerId: contentId,
        originalName: dto.originalName,
        mime: dto.mime,
        sizeBytes: dto.sizeBytes,
      },
      user,
    );
  }

  // ============ 端点 10:确认上传(委托 AttachmentsService)============
  async confirmAttachmentUpload(
    contentId: string,
    dto: ContentAttachmentConfirmDto,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ) {
    // content 先存在(token claims 内已绑 ownerId,但先给 29001 语义,避免对不存在 content 的端点透 13xxx)
    await this.findOrThrow(contentId, this.prisma);
    return this.attachments.confirmUpload(
      { uploadToken: dto.uploadToken, checksum: dto.checksum },
      user,
      meta,
    );
  }

  // ============ 端点 11:删附件(先校验归属本文章,再委托 AttachmentsService)============
  async deleteAttachment(
    contentId: string,
    attachmentId: string,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ): Promise<void> {
    await this.findOrThrow(contentId, this.prisma);
    // 校验该附件归属本文章(ownerId=contentId 且 ownerType ∈ content-*),否则 404(防越权删他文章附件)
    const att = await this.prisma.attachment.findFirst({
      where: {
        id: attachmentId,
        ownerId: contentId,
        ownerType: { in: [CONTENT_OWNER_TYPE_IMAGE, CONTENT_OWNER_TYPE_FILE] },
      },
      select: { id: true },
    });
    if (!att) {
      throw new BizException(BizCode.CONTENT_NOT_FOUND);
    }
    await this.attachments.delete(attachmentId, user, meta);
  }

  // ============ 端点 12:设 / 清封面 ============
  async setCover(
    id: string,
    dto: SetContentCoverDto,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ): Promise<ContentAdminDetailDto> {
    await this.assertCanOrThrow(user, 'content.update.record');

    const row = await this.prisma.$transaction(async (tx) => {
      const existing = await this.findOrThrow(id, tx);
      let coverImageKey: string | null = null;
      let coverAttachmentId: string | null = null;

      if (dto.attachmentId !== null) {
        // 校验是本文章的 content-image 附件;取其 key 反范式落库
        const att = await tx.attachment.findFirst({
          where: {
            id: dto.attachmentId,
            ownerType: CONTENT_OWNER_TYPE_IMAGE,
            ownerId: id,
          },
          select: { id: true, key: true },
        });
        if (!att) {
          // 非本文章的 content-image 附件 → 404(沿 deleteAttachment 防越权语义)
          throw new BizException(BizCode.CONTENT_NOT_FOUND);
        }
        coverImageKey = att.key;
        coverAttachmentId = att.id;
      }

      const updated = await tx.content.update({
        where: { id },
        data: { coverImageKey, coverAttachmentId },
      });
      await this.auditLogs.log({
        event: 'content.update', // set-cover 复用 content.update,extra.operation 区分(评审稿 §7)
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: updated.id,
        meta,
        before: { coverAttachmentId: existing.coverAttachmentId },
        after: { coverAttachmentId: updated.coverAttachmentId },
        extra: { operation: 'set-cover' },
        tx,
      });
      return updated;
    });
    return this.toDetailDto(row);
  }

  // ============ 出参构造 ============

  // 列表 item:封面缩略图直签 coverImageKey(本地 crypto,无 N+1 DB 查询;评审稿 §5.6)。
  private async toListItemDto(row: Content): Promise<ContentAdminListItemDto> {
    const coverImageUrl = await this.attachments.resolveSignedUrlTrusted(row.coverImageKey);
    return {
      id: row.id,
      title: row.title,
      summary: row.summary,
      contentTypeCode: row.contentTypeCode,
      statusCode: row.statusCode,
      visibilityCode: row.visibilityCode,
      tags: row.tags,
      coverImageUrl,
      pinned: row.pinned,
      viewCount: row.viewCount,
      publishedAt: row.publishedAt,
      authorUserId: row.authorUserId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // 详情:取 content-image + content-file 附件(可信只读;此处已过 content.read.record RBAC)→
  // body 占位改写(只改写本文章 content-image id;评审稿 §5.5)+ 封面签名 + 附件列表映射。
  private async toDetailDto(row: Content): Promise<ContentAdminDetailDto> {
    const [images, files] = await Promise.all([
      this.attachments.listOwnerAttachmentsTrusted(
        CONTENT_OWNER_TYPE_IMAGE as AttachmentOwnerType,
        row.id,
      ),
      this.attachments.listOwnerAttachmentsTrusted(
        CONTENT_OWNER_TYPE_FILE as AttachmentOwnerType,
        row.id,
      ),
    ]);

    // body 改写映射:仅本文章 content-image id → 签名 URL(外来 id 在 rewriteBody 内原样保留)
    const idToUrl = new Map<string, string | null>(images.map((a) => [a.id, a.accessUrl]));
    const body = rewriteBody(row.body, idToUrl);

    const attachments: ContentAttachmentDto[] = [
      ...images.map((a) => this.toAttachmentDto(a, 'image')),
      ...files.map((a) => this.toAttachmentDto(a, 'file')),
    ];

    const coverImageUrl = await this.attachments.resolveSignedUrlTrusted(row.coverImageKey);

    return {
      id: row.id,
      title: row.title,
      summary: row.summary,
      body,
      contentTypeCode: row.contentTypeCode,
      statusCode: row.statusCode,
      visibilityCode: row.visibilityCode,
      visibleOrganizationIds: row.visibleOrganizationIds,
      tags: row.tags,
      coverImageUrl,
      coverAttachmentId: row.coverAttachmentId,
      attachments,
      pinned: row.pinned,
      viewCount: row.viewCount,
      publishedAt: row.publishedAt,
      authorUserId: row.authorUserId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toAttachmentDto(
    a: {
      id: string;
      mime: string;
      originalName: string;
      size: number;
      accessUrl: string | null;
    },
    kind: 'image' | 'file',
  ): ContentAttachmentDto {
    return {
      id: a.id,
      kind,
      mime: a.mime,
      originalName: a.originalName,
      size: a.size,
      url: a.accessUrl,
    };
  }
}
