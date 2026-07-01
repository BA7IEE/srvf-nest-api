import { Injectable } from '@nestjs/common';
import { OrganizationStatus, Prisma, Role, type Content } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AttachmentOwnerType } from '../attachments/attachment-validation';
import { AttachmentsService } from '../attachments/attachments.service';
import { RbacService } from '../permissions/rbac.service';
import { AppIdentityResolver } from '../users/app-identity.resolver';
import {
  CONTENT_OWNER_TYPE_FILE,
  CONTENT_OWNER_TYPE_IMAGE,
  rewriteBody,
} from './content.constants';
import type {
  ContentAttachmentDto,
  ContentReadDetailDto,
  ContentReadListItemDto,
  ListContentReadQueryDto,
} from './content.dto';
import {
  ANON_VISIBILITY_CONTEXT,
  buildVisibilityWhere,
  canSeeContent,
  type CallerVisibilityContext,
} from './content.visibility';

// CMS 内容发布模块(第 28 模块)T3/T4(2026-06-21):open/v1(公开)+ app/v1(会员)读取面业务逻辑
// (冻结评审稿 docs/archive/reviews/content-module-review.md §4/§5.4/§5.5/§6/§8)。
//
// 设计骨架:
//   1. caller 上下文**一次性 async 解析**(resolveCtx)→ 喂入 content.visibility.ts 纯同步函数。
//   2. list 用 buildVisibilityWhere(ctx) AND keyword(ILIKE)AND tags(hasSome)AND contentTypeCode;
//      分页正确性靠 DB 过滤,**绝不**读后内存过滤(评审稿 §4.3)。
//   3. detail 取行后 canSeeContent(ctx, row) 判定;不可见 / 不存在统一 CONTENT_NOT_FOUND(防枚举,§4.3)。
//   4. viewCount 非事务原子 `{increment:1}`,**仅在可见级通过后**(详情);list / 404 / 失败可见级不计(§6 C)。
//   5. 签名 URL(封面 / 正文图 / 附件)仅在可见级通过后返回(范围例外 a,§5.7);content 自签走
//      AttachmentsService 可信只读(resolveSignedUrlTrusted / listOwnerAttachmentsTrusted)。
//
// open/v1 用 ANON_VISIBILITY_CONTEXT(只命中 public);app/v1 准入 = canUseApp(否则 403),用真实 ctx。

@Injectable()
export class ContentReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly appIdentity: AppIdentityResolver,
    private readonly attachments: AttachmentsService,
  ) {}

  // ===== caller 上下文一次性解析(评审稿 §4.1)=====
  // isMember = canUseApp(member 绑定 + Member ACTIVE + 未软删);
  // isFormalMember / activeOrgIds = 活跃 member_department(org ACTIVE 且未软删);
  // isManagement = rbac.can('content.read.record') ∨ role ∈ {SUPER_ADMIN, ADMIN}。
  private async resolveCtx(currentUser: CurrentUserPayload): Promise<CallerVisibilityContext> {
    const access = await this.appIdentity.resolve(currentUser);
    const isMember = access.canUseApp;

    // 活跃部门归属(department 档命中判定 + isFormalMember);仅当确为 member 时才查。
    let activeOrgIds: string[] = [];
    if (isMember && access.member !== null) {
      // 终态 scoped-authz PR2:重指向 active PRIMARY membership(= 旧单部门)。
      const depts = await this.prisma.memberOrganizationMembership.findMany({
        where: {
          memberId: access.member.id,
          deletedAt: null,
          membershipType: 'PRIMARY',
          status: 'ACTIVE',
          organization: { status: OrganizationStatus.ACTIVE, deletedAt: null },
        },
        select: { organizationId: true },
      });
      activeOrgIds = depts.map((d) => d.organizationId);
    }
    const isFormalMember = activeOrgIds.length > 0;

    // 管理层:rbac.can 命中 ∨ Role enum 在 {SUPER_ADMIN, ADMIN}(评审稿 §4.1)。
    const isManagement =
      currentUser.role === Role.SUPER_ADMIN ||
      currentUser.role === Role.ADMIN ||
      (await this.rbac.can(currentUser, 'content.read.record'));

    return { isMember, isFormalMember, activeOrgIds, isManagement };
  }

  // ===== where 组装:可见性 where 之上 AND keyword / tags / contentTypeCode(评审稿 §6)=====
  // keyword / tags **绝不旁路可见性**(在 buildVisibilityWhere 之上 AND,搜不到不该看的)。
  private buildListWhere(
    ctx: CallerVisibilityContext,
    query: ListContentReadQueryDto,
  ): Prisma.ContentWhereInput {
    const where: Prisma.ContentWhereInput = buildVisibilityWhere(ctx);
    const and: Prisma.ContentWhereInput[] = [];
    if (query.keyword !== undefined && query.keyword.length > 0) {
      and.push({
        OR: [
          { title: { contains: query.keyword, mode: 'insensitive' } },
          { body: { contains: query.keyword, mode: 'insensitive' } },
        ],
      });
    }
    if (query.tags !== undefined && query.tags.length > 0) {
      and.push({ tags: { hasSome: query.tags } });
    }
    if (query.contentTypeCode !== undefined && query.contentTypeCode.length > 0) {
      and.push({ contentTypeCode: query.contentTypeCode });
    }
    if (and.length > 0) where.AND = and;
    return where;
  }

  private async listWith(
    ctx: CallerVisibilityContext,
    query: ListContentReadQueryDto,
  ): Promise<PageResultDto<ContentReadListItemDto>> {
    const where = this.buildListWhere(ctx, query);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.content.findMany({
        where,
        // pinned desc → publishedAt desc(nulls last)→ createdAt desc(评审稿 §8)
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
    const items = await Promise.all(rows.map((r) => this.toReadListItemDto(r)));
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  // 详情公用:取行 → canSeeContent 判定(不可见 / 不存在统一 404 防枚举)→ viewCount +1 → 读者详情 DTO。
  private async detailWith(
    ctx: CallerVisibilityContext,
    id: string,
  ): Promise<ContentReadDetailDto> {
    const row = await this.prisma.content.findFirst({ where: { id, deletedAt: null } });
    // 防枚举:不存在 OR 可见级不通过 → 同一 CONTENT_NOT_FOUND(不区分「存在但不可见」)。
    if (!row || !canSeeContent(ctx, row)) {
      throw new BizException(BizCode.CONTENT_NOT_FOUND);
    }
    // 可见级通过后才计 PV:非事务原子自增(失败不阻断返回;评审稿 §6 C)。
    const updated = await this.prisma.content.update({
      where: { id },
      data: { viewCount: { increment: 1 } },
    });
    return this.toReadDetailDto(updated);
  }

  // ============ open/v1 列表(@Public;ANON 上下文只命中 public)============
  async publicList(query: ListContentReadQueryDto): Promise<PageResultDto<ContentReadListItemDto>> {
    return this.listWith(ANON_VISIBILITY_CONTEXT, query);
  }

  // ============ open/v1 详情(published+public 才可见,否则 404;+viewCount)============
  async publicDetail(id: string): Promise<ContentReadDetailDto> {
    return this.detailWith(ANON_VISIBILITY_CONTEXT, id);
  }

  // ============ app/v1 列表(准入 canUseApp;按 5 档可见性过滤)============
  async appList(
    currentUser: CurrentUserPayload,
    query: ListContentReadQueryDto,
  ): Promise<PageResultDto<ContentReadListItemDto>> {
    await this.assertCanUseAppOrThrow(currentUser);
    const ctx = await this.resolveCtx(currentUser);
    return this.listWith(ctx, query);
  }

  // ============ app/v1 详情(准入 canUseApp;按 5 档可见性判定;+viewCount)============
  async appDetail(currentUser: CurrentUserPayload, id: string): Promise<ContentReadDetailDto> {
    await this.assertCanUseAppOrThrow(currentUser);
    const ctx = await this.resolveCtx(currentUser);
    return this.detailWith(ctx, id);
  }

  // 准入:canUseApp=false(memberId=null / member 软删 / member 非 ACTIVE)→ 403(镜像 team-join app)。
  private async assertCanUseAppOrThrow(currentUser: CurrentUserPayload): Promise<void> {
    const access = await this.appIdentity.resolve(currentUser);
    if (!access.canUseApp) {
      throw new BizException(BizCode.FORBIDDEN);
    }
  }

  // ============ 读者出参构造(open + app 共用;零 authorUserId / 零 visibleOrganizationIds)============

  // 列表 item:封面缩略图直签 coverImageKey(本地 crypto,无 N+1 DB 查询;评审稿 §5.6);无 body。
  private async toReadListItemDto(row: Content): Promise<ContentReadListItemDto> {
    const coverImageUrl = await this.attachments.resolveSignedUrlTrusted(row.coverImageKey);
    return {
      id: row.id,
      title: row.title,
      summary: row.summary,
      contentTypeCode: row.contentTypeCode,
      tags: row.tags,
      coverImageUrl,
      pinned: row.pinned,
      viewCount: row.viewCount,
      publishedAt: row.publishedAt,
      createdAt: row.createdAt,
    };
  }

  // 详情:取 content-image + content-file 附件(可信只读;此处已过文章可见级)→ body 占位改写
  // (仅本文章 content-image id;评审稿 §5.5)+ 封面签名 + 附件列表。签名 URL 即范围例外 a(§5.7)。
  private async toReadDetailDto(row: Content): Promise<ContentReadDetailDto> {
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

    // body 改写映射:仅本文章 content-image id → 签名 URL(外来 id 在 rewriteBody 内原样保留)。
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
      visibilityCode: row.visibilityCode,
      tags: row.tags,
      coverImageUrl,
      attachments,
      pinned: row.pinned,
      viewCount: row.viewCount,
      publishedAt: row.publishedAt,
      createdAt: row.createdAt,
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
