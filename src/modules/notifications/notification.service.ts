import { Injectable } from '@nestjs/common';
import {
  DictItemStatus,
  DictTypeStatus,
  OrganizationStatus,
  Prisma,
  type Notification,
} from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { RbacService } from '../permissions/rbac.service';
import {
  NOTIFICATION_AUDIENCE_BROADCAST,
  NOTIFICATION_CHANNEL_IN_APP,
  NOTIFICATION_SOURCE_ADMIN,
  NOTIFICATION_STATUS_ARCHIVED,
  NOTIFICATION_STATUS_DRAFT,
  NOTIFICATION_STATUS_PUBLISHED,
  NOTIFICATION_TYPE_DICT_CODE,
  NOTIFICATION_VISIBILITY_DEPARTMENT,
} from './notification.constants';
import type {
  CreateNotificationDto,
  ListNotificationAdminQueryDto,
  NotificationAdminDetailDto,
  NotificationAdminListItemDto,
  UpdateNotificationDto,
} from './notification.dto';

// 统一通知模块 S1 站内信渠道(第 28 模块 notifications 扩 controller)admin 业务逻辑
// (评审稿 unified-notification-dispatcher-review.md §5 / member-notification-review.md §3/§6;镜像 content.service)。
//
// 判权全在 service rbac.can()(R 模式,镜像 content / attachments / recruitment;入口仅 JwtAuthGuard,无 @Roles / 无 @RequirePermissions)。
// 写路径(create/update/softDelete/状态机)= prisma.$transaction wrap DB 写 + audit.log。
// 状态机镜像 content(draft → published → archived;立即生效无 cron),非法跃迁 → 31030。
// 统一形状列(audienceType/sourceType/channels)在 create 显式置 S1 值(broadcast/admin/in-app),
// 后续 S2/S3 渠道勾选 / 定向只 additive,本切片状态机 / 出参语义零返工。
const AUDIT_RESOURCE_TYPE = 'notification';

@Injectable()
export class NotificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  private async findOrThrow(
    id: string,
    client: PrismaService | Prisma.TransactionClient,
  ): Promise<Notification> {
    const row = await client.notification.findFirst({ where: notDeletedWhere({ id }) });
    if (!row) {
      throw new BizException(BizCode.NOTIFICATION_NOT_FOUND);
    }
    return row;
  }

  // ===== 校验:notificationTypeCode 须为 notification_type 字典 ACTIVE item(评审稿 §9.4)=====
  private async assertNotificationTypeValid(code: string): Promise<void> {
    const item = await this.prisma.dictItem.findFirst({
      where: notDeletedWhere({
        code,
        status: DictItemStatus.ACTIVE,
        type: { code: NOTIFICATION_TYPE_DICT_CODE, status: DictTypeStatus.ACTIVE, deletedAt: null },
      }),
      select: { id: true },
    });
    if (!item) {
      throw new BizException(BizCode.NOTIFICATION_TYPE_INVALID);
    }
  }

  // ===== 校验 + 归一 visibleOrganizationIds(镜像 content)=====
  // department 档:必须非空 + 每个 id 为活跃未软删 Organization;非 department 档:归一为 []。
  private async resolveVisibleOrgIds(
    visibilityCode: string,
    visibleOrganizationIds: string[] | undefined,
  ): Promise<string[]> {
    if (visibilityCode !== NOTIFICATION_VISIBILITY_DEPARTMENT) {
      if (visibleOrganizationIds && visibleOrganizationIds.length > 0) {
        throw new BizException(BizCode.NOTIFICATION_VISIBLE_ORG_INVALID);
      }
      return [];
    }
    const ids = visibleOrganizationIds ?? [];
    if (ids.length === 0) {
      throw new BizException(BizCode.NOTIFICATION_VISIBLE_ORG_INVALID);
    }
    const uniqueIds = [...new Set(ids)];
    const found = await this.prisma.organization.findMany({
      where: notDeletedWhere({ id: { in: uniqueIds }, status: OrganizationStatus.ACTIVE }),
      select: { id: true },
    });
    if (found.length !== uniqueIds.length) {
      throw new BizException(BizCode.NOTIFICATION_VISIBLE_ORG_INVALID);
    }
    return uniqueIds;
  }

  // ============ 端点 1:建草稿 ============
  async create(
    dto: CreateNotificationDto,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ): Promise<NotificationAdminDetailDto> {
    await this.assertCanOrThrow(user, 'notification.create.record');
    await this.assertNotificationTypeValid(dto.notificationTypeCode);
    const visibleOrganizationIds = await this.resolveVisibleOrgIds(
      dto.visibilityCode,
      dto.visibleOrganizationIds,
    );

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.notification.create({
        data: {
          title: dto.title,
          body: dto.body,
          notificationTypeCode: dto.notificationTypeCode,
          statusCode: NOTIFICATION_STATUS_DRAFT, // create → draft
          visibilityCode: dto.visibilityCode,
          visibleOrganizationIds,
          // 统一形状:S1 显式置广播 / admin / 站内(后续 S2/S3 additive 扩值不返工)
          audienceType: NOTIFICATION_AUDIENCE_BROADCAST,
          sourceType: NOTIFICATION_SOURCE_ADMIN,
          channels: [NOTIFICATION_CHANNEL_IN_APP],
          pinned: dto.pinned ?? false,
          authorUserId: user.id,
        },
      });
      await this.auditLogs.log({
        event: 'notification.create',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: created.id,
        meta,
        after: {
          title: created.title,
          statusCode: created.statusCode,
          visibilityCode: created.visibilityCode,
          notificationTypeCode: created.notificationTypeCode,
        },
        tx,
      });
      return created;
    });
    return this.toDetailDto(row);
  }

  // ============ 端点 2:列表(admin 见全部状态 / 全可见档)============
  async list(
    query: ListNotificationAdminQueryDto,
    user: CurrentUserPayload,
  ): Promise<PageResultDto<NotificationAdminListItemDto>> {
    await this.assertCanOrThrow(user, 'notification.read.record');

    const where: Prisma.NotificationWhereInput = { deletedAt: null };
    if (query.statusCode !== undefined) where.statusCode = query.statusCode;
    if (query.notificationTypeCode !== undefined) {
      where.notificationTypeCode = query.notificationTypeCode;
    }
    if (query.visibilityCode !== undefined) where.visibilityCode = query.visibilityCode;
    if (query.pinned !== undefined) where.pinned = query.pinned;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        // pinned desc → publishedAt desc(nulls last)→ createdAt desc(镜像 content)
        orderBy: [
          { pinned: 'desc' },
          { publishedAt: { sort: 'desc', nulls: 'last' } },
          { createdAt: 'desc' },
        ],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.toListItemDto(r)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  // ============ 端点 3:详情(不增 readCount)============
  async detail(id: string, user: CurrentUserPayload): Promise<NotificationAdminDetailDto> {
    await this.assertCanOrThrow(user, 'notification.read.record');
    const row = await this.findOrThrow(id, this.prisma);
    return this.toDetailDto(row);
  }

  // ============ 端点 4:更新(archived 冻结 → 31030)============
  async update(
    id: string,
    dto: UpdateNotificationDto,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ): Promise<NotificationAdminDetailDto> {
    await this.assertCanOrThrow(user, 'notification.update.record');

    const row = await this.prisma.$transaction(async (tx) => {
      const existing = await this.findOrThrow(id, tx);
      // 更新仅 draft / published 可改;archived 冻结(镜像 content)
      if (existing.statusCode === NOTIFICATION_STATUS_ARCHIVED) {
        throw new BizException(BizCode.NOTIFICATION_INVALID_STATUS_TRANSITION);
      }

      if (dto.notificationTypeCode !== undefined) {
        await this.assertNotificationTypeValid(dto.notificationTypeCode);
      }

      const data: Prisma.NotificationUpdateInput = {};
      if (dto.title !== undefined) data.title = dto.title;
      if (dto.body !== undefined) data.body = dto.body;
      if (dto.notificationTypeCode !== undefined) {
        data.notificationTypeCode = dto.notificationTypeCode;
      }
      if (dto.pinned !== undefined) data.pinned = dto.pinned;

      // 可见档 + 可见部门:visibilityCode 改了要重算 visibleOrganizationIds;
      // 只改 visibleOrganizationIds(visibilityCode 沿用旧值)也按当前(新或旧)可见档校验(镜像 content)。
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

      const updated = await tx.notification.update({ where: { id }, data });
      await this.auditLogs.log({
        event: 'notification.update',
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
    await this.assertCanOrThrow(user, 'notification.delete.record');
    await this.prisma.$transaction(async (tx) => {
      const existing = await this.findOrThrow(id, tx);
      await tx.notification.update({ where: { id }, data: { deletedAt: new Date() } });
      await this.auditLogs.log({
        event: 'notification.delete',
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
  ): Promise<NotificationAdminDetailDto> {
    return this.transition(id, user, meta, 'publish');
  }

  async unpublish(
    id: string,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ): Promise<NotificationAdminDetailDto> {
    return this.transition(id, user, meta, 'unpublish');
  }

  async archive(
    id: string,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ): Promise<NotificationAdminDetailDto> {
    return this.transition(id, user, meta, 'archive');
  }

  // 状态机内嵌(镜像 content;立即生效无 cron)。非法跃迁 → 31030。
  private async transition(
    id: string,
    user: CurrentUserPayload,
    meta: AuditMeta,
    operation: 'publish' | 'unpublish' | 'archive',
  ): Promise<NotificationAdminDetailDto> {
    await this.assertCanOrThrow(user, 'notification.publish.record');

    const row = await this.prisma.$transaction(async (tx) => {
      const existing = await this.findOrThrow(id, tx);
      const data: Prisma.NotificationUpdateInput = {};

      if (operation === 'publish') {
        // 仅 draft → published;置 publishedAt = now(= 推送时刻,会员可见)
        if (existing.statusCode !== NOTIFICATION_STATUS_DRAFT) {
          throw new BizException(BizCode.NOTIFICATION_INVALID_STATUS_TRANSITION);
        }
        data.statusCode = NOTIFICATION_STATUS_PUBLISHED;
        data.publishedAt = new Date();
      } else if (operation === 'unpublish') {
        // 仅 published → draft;publishedAt 保留(撤回;已读会员留存已读痕)
        if (existing.statusCode !== NOTIFICATION_STATUS_PUBLISHED) {
          throw new BizException(BizCode.NOTIFICATION_INVALID_STATUS_TRANSITION);
        }
        data.statusCode = NOTIFICATION_STATUS_DRAFT;
      } else {
        // archive:仅 published → archived(终态)
        if (existing.statusCode !== NOTIFICATION_STATUS_PUBLISHED) {
          throw new BizException(BizCode.NOTIFICATION_INVALID_STATUS_TRANSITION);
        }
        data.statusCode = NOTIFICATION_STATUS_ARCHIVED;
      }

      const updated = await tx.notification.update({ where: { id }, data });
      await this.auditLogs.log({
        event: 'notification.publish', // 伞事件:operation 区分(镜像 content.publish)
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

  // ============ 出参构造 ============

  private toListItemDto(row: Notification): NotificationAdminListItemDto {
    return {
      id: row.id,
      title: row.title,
      notificationTypeCode: row.notificationTypeCode,
      statusCode: row.statusCode,
      visibilityCode: row.visibilityCode,
      audienceType: row.audienceType,
      sourceType: row.sourceType,
      channels: row.channels,
      pinned: row.pinned,
      readCount: row.readCount,
      publishedAt: row.publishedAt,
      authorUserId: row.authorUserId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toDetailDto(row: Notification): NotificationAdminDetailDto {
    return {
      id: row.id,
      title: row.title,
      body: row.body,
      notificationTypeCode: row.notificationTypeCode,
      statusCode: row.statusCode,
      visibilityCode: row.visibilityCode,
      visibleOrganizationIds: row.visibleOrganizationIds,
      audienceType: row.audienceType,
      sourceType: row.sourceType,
      channels: row.channels,
      pinned: row.pinned,
      readCount: row.readCount,
      publishedAt: row.publishedAt,
      authorUserId: row.authorUserId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
