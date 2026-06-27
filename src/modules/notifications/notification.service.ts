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
import { SmsChannelUnavailableError } from '../sms/sms.types';
import {
  NOTIFICATION_AUDIENCE_BROADCAST,
  NOTIFICATION_CHANNEL_IN_APP,
  NOTIFICATION_CHANNEL_SMS,
  NOTIFICATION_CHANNEL_WECHAT,
  NOTIFICATION_SOURCE_ADMIN,
  NOTIFICATION_STATUS_ARCHIVED,
  NOTIFICATION_STATUS_DRAFT,
  NOTIFICATION_STATUS_PUBLISHED,
  NOTIFICATION_TYPE_DICT_CODE,
  NOTIFICATION_VISIBILITY_DEPARTMENT,
} from './notification.constants';
import { NotificationSmsDispatchService } from './notification-sms-dispatch.service';
import { NotificationWechatDispatchService } from './notification-wechat-dispatch.service';
import type {
  CreateNotificationDto,
  ListNotificationAdminQueryDto,
  NotificationAdminDetailDto,
  NotificationAdminListItemDto,
  NotificationSmsSendResultDto,
  SendNotificationSmsDto,
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
    private readonly wechatDispatch: NotificationWechatDispatchService,
    private readonly smsDispatch: NotificationSmsDispatchService,
  ) {}

  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  // 渠道归一(S2):站内恒发 → 强制含 in-app;去重保序;DTO 已校验各值 ∈ 白名单(in-app / wechat)。
  // 未传 → 默认仅站内(['in-app'],与 S1 行为一致)。
  private normalizeChannels(channels: string[] | undefined): string[] {
    const set = new Set<string>([NOTIFICATION_CHANNEL_IN_APP]);
    for (const c of channels ?? []) set.add(c);
    // 稳定序:in-app 在前,wechat 在后(仅这两值;sms = S5)
    return [
      NOTIFICATION_CHANNEL_IN_APP,
      ...[...set].filter((c) => c !== NOTIFICATION_CHANNEL_IN_APP),
    ];
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
          // 统一形状:广播 / admin;channels = 站内恒发 + admin 勾选(S2 可含 wechat)
          audienceType: NOTIFICATION_AUDIENCE_BROADCAST,
          sourceType: NOTIFICATION_SOURCE_ADMIN,
          channels: this.normalizeChannels(dto.channels),
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
      // 渠道勾选改动(S2):归一保证站内恒发(admin 可加/去 wechat;published 也可改,下次 publish 生效)
      if (dto.channels !== undefined) data.channels = this.normalizeChannels(dto.channels);

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
    const row = await this.transition(id, user, meta, 'publish');
    // 微信渠道:在 publish DB 事务**之外**同步派发(§6.2:8s HTTP 绝不拖事务)。
    // 仅广播勾微信走;派发器永不抛(失败落 delivery 不阻断 publish 响应,§8.3)。
    if (
      row.channels.includes(NOTIFICATION_CHANNEL_WECHAT) &&
      row.audienceType === NOTIFICATION_AUDIENCE_BROADCAST
    ) {
      await this.wechatDispatch.dispatchBroadcast(row);
    }
    return this.toDetailDto(row);
  }

  async unpublish(
    id: string,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ): Promise<NotificationAdminDetailDto> {
    return this.toDetailDto(await this.transition(id, user, meta, 'unpublish'));
  }

  async archive(
    id: string,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ): Promise<NotificationAdminDetailDto> {
    return this.toDetailDto(await this.transition(id, user, meta, 'archive'));
  }

  // ============ 端点:admin 显式发起短信兜底(紧急召集;统一通知 S5,评审稿 §4 / D-N4)============
  // **计费确认必需**:confirmed=true 才真发(每收件人 1 条计费);confirmed=false = 预览受众计数零发送零计费。
  // **前置闸**:通知须 published 且 channels 声明含 'sms'(否则 31013);通道未配置 → 24030(发送前抛,零计费)。
  // **短信外发在任何 DB 事务之外**(§6.2;dispatch 逐人 send_log/delivery 非事务,FAILED 逐人不阻断)。
  // **审计**:仅 confirmed 真发记 audit(admin 显式管理动作 + 收件人计数;复用 notification.publish 伞事件
  // operation='send-sms',§13.2 admin 入 audit / 逐条投递不入 audit;手机号经 delivery/send_log 掩码,audit 仅计数无明文)。
  async sendSms(
    id: string,
    dto: SendNotificationSmsDto,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ): Promise<NotificationSmsSendResultDto> {
    await this.assertCanOrThrow(user, 'notification.send.sms');
    const notification = await this.findOrThrow(id, this.prisma);

    // 前置闸:须已发布 + 声明含 sms 渠道(紧急召集兜底意图;排除草稿 / 未声明短信的通知)。
    if (
      notification.statusCode !== NOTIFICATION_STATUS_PUBLISHED ||
      !notification.channels.includes(NOTIFICATION_CHANNEL_SMS)
    ) {
      throw new BizException(BizCode.NOTIFICATION_SMS_NOT_SENDABLE);
    }

    // 预览(未确认):返回可计费受众计数,零发送零计费零审计(供前端二次确认「将向 N 人发短信 = N 条计费」)。
    if (!dto.confirmed) {
      const recipientCount = await this.smsDispatch.countRecipients(notification);
      return { confirmed: false, recipientCount, sent: 0, failed: 0, skipped: 0 };
    }

    // 确认发送:外部 SMS 在任何 DB 事务之外;通道未就绪 → 24030(发送前抛,零计费零 delivery)。
    let summary;
    try {
      summary = await this.smsDispatch.dispatch(notification);
    } catch (err) {
      if (err instanceof SmsChannelUnavailableError) {
        throw new BizException(BizCode.SMS_CHANNEL_NOT_CONFIGURED);
      }
      throw err;
    }

    // 审计 admin 显式管理动作 + 收件人计数(复用 publish 伞事件,无新 audit 串;手机号不入 audit,仅计数)。
    await this.auditLogs.log({
      event: 'notification.publish',
      actorUserId: user.id,
      actorRoleSnap: user.role,
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: notification.id,
      meta,
      extra: {
        operation: 'send-sms',
        recipientCount: summary.recipientCount,
        sent: summary.sent,
        failed: summary.failed,
        skipped: summary.skipped,
      },
    });

    return { confirmed: true, ...summary };
  }

  // 状态机内嵌(镜像 content;立即生效无 cron)。非法跃迁 → 31030。返原始 row(publish 据 channels 派发)。
  private async transition(
    id: string,
    user: CurrentUserPayload,
    meta: AuditMeta,
    operation: 'publish' | 'unpublish' | 'archive',
  ): Promise<Notification> {
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
    return row;
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
