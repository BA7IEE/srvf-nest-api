import { Injectable } from '@nestjs/common';
import { type Member, OrganizationStatus, Prisma, Role, type Notification } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { RbacService } from '../permissions/rbac.service';
import { AppIdentityResolver } from '../users/app-identity.resolver';
// 可见性**复用** content.visibility 纯函数(canSeeContent / buildVisibilityWhere),零第二套(评审稿 §5)。
// 通知去 public:本模块从不写 visibilityCode='public'(DTO 白名单不含),故复用函数中的 public 分支对通知行恒不命中,
// 效果即 4 档(member / formal_member / department / management)。
import {
  buildVisibilityWhere,
  canSeeContent,
  type CallerVisibilityContext,
} from '../content/content.visibility';
import type {
  ListNotificationReadQueryDto,
  MarkNotificationReadResponseDto,
  NotificationReadDetailDto,
  NotificationReadListItemDto,
  NotificationUnreadCountDto,
} from './notification.dto';

// 统一通知模块 S1 站内信渠道(第 28 模块 notifications 扩 controller)app 会员读取面业务逻辑
// (评审稿 unified-notification-dispatcher-review.md §5 / member-notification-review.md §7;镜像 content-read.service)。
//
// 入口仅全局 JwtAuthGuard;**不**挂 @Roles / @Public / RBAC;准入 = canUseApp(否则 403)+ 4 档可见性
// (复用 content.visibility 纯函数,去 public)全前置在 service;读者出参零敏感(无 authorUserId / visibleOrganizationIds /
// statusCode / readCount)。详情 / mark-read 命中不可见 / 不存在 → 31001 防枚举。
//
// 站内信增量(原 T0 ④):每项 read 已读标志 + mark-read 幂等(NotificationRead create + P2002 兜底,首插原子 +1
// readCount,二次 no-op 不重复增)+ unread-count(NOT EXISTS 子查询 reads.none)。
@Injectable()
export class NotificationReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly appIdentity: AppIdentityResolver,
  ) {}

  // 准入:canUseApp=false(memberId=null / member 软删 / member 非 ACTIVE)→ 403(镜像 content-read)。
  // 返回非空 member(canUseApp=true 蕴含 member ACTIVE 非空)。
  private async assertCanUseAppOrThrow(currentUser: CurrentUserPayload): Promise<Member> {
    const access = await this.appIdentity.resolve(currentUser);
    if (!access.canUseApp || access.member === null) {
      throw new BizException(BizCode.FORBIDDEN);
    }
    return access.member;
  }

  // caller 上下文一次性解析(镜像 content-read.resolveCtx;isManagement 用 notification.read.record)。
  // 准入已确保是 member(canUseApp),故 isMember 恒 true。
  private async resolveCtx(
    currentUser: CurrentUserPayload,
    memberId: string,
  ): Promise<CallerVisibilityContext> {
    const depts = await this.prisma.memberDepartment.findMany({
      where: {
        memberId,
        deletedAt: null,
        organization: { status: OrganizationStatus.ACTIVE, deletedAt: null },
      },
      select: { organizationId: true },
    });
    const activeOrgIds = depts.map((d) => d.organizationId);
    const isManagement =
      currentUser.role === Role.SUPER_ADMIN ||
      currentUser.role === Role.ADMIN ||
      (await this.rbac.can(currentUser, 'notification.read.record'));
    return { isMember: true, isFormalMember: activeOrgIds.length > 0, activeOrgIds, isManagement };
  }

  // 复用 content.visibility 的 list where(published + 命中可见档 OR);ContentWhereInput 与 NotificationWhereInput
  // 在可见性列(deletedAt / statusCode / visibilityCode / visibleOrganizationIds / OR)上结构同形 → 安全转型。
  private buildVisibleNotificationWhere(
    ctx: CallerVisibilityContext,
  ): Prisma.NotificationWhereInput {
    return buildVisibilityWhere(ctx) as unknown as Prisma.NotificationWhereInput;
  }

  // ============ 端点 9:会员列表(准入 + 4 档可见性 + 每项 read 标志)============
  async appList(
    currentUser: CurrentUserPayload,
    query: ListNotificationReadQueryDto,
  ): Promise<PageResultDto<NotificationReadListItemDto>> {
    const member = await this.assertCanUseAppOrThrow(currentUser);
    const ctx = await this.resolveCtx(currentUser, member.id);
    const where = this.buildVisibleNotificationWhere(ctx);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        // pinned desc → publishedAt desc(nulls last)→ createdAt desc(镜像 content feed)
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

    // read 标志:本页命中 NotificationRead 的 notificationId 集合(单次 IN 查询,无 N+1)。
    const readIds = await this.readNotificationIdSet(
      member.id,
      rows.map((r) => r.id),
    );
    const items = rows.map((r) => this.toReadListItemDto(r, readIds.has(r.id)));
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  // ============ 端点 10:会员详情(可见级闸 + 防枚举 404;不自动已读)============
  async appDetail(currentUser: CurrentUserPayload, id: string): Promise<NotificationReadDetailDto> {
    const member = await this.assertCanUseAppOrThrow(currentUser);
    const ctx = await this.resolveCtx(currentUser, member.id);
    const row = await this.findVisibleOrThrow(ctx, id);
    const read = await this.hasRead(member.id, id);
    return this.toReadDetailDto(row, read);
  }

  // ============ 端点 11:标记已读(幂等;首插 readCount 原子 +1,P2002 兜底不重复增)============
  async markRead(
    currentUser: CurrentUserPayload,
    id: string,
  ): Promise<MarkNotificationReadResponseDto> {
    const member = await this.assertCanUseAppOrThrow(currentUser);
    const ctx = await this.resolveCtx(currentUser, member.id);
    // 对不存在 / 不可见 / 未发布通知 → 31001 防侧信道(不可 mark-read 看不到的)。
    await this.findVisibleOrThrow(ctx, id);

    try {
      // 首插:create 成功 → 原子自增 readCount(非事务,镜像 content viewCount;失败不阻断已读语义)。
      await this.prisma.notificationRead.create({
        data: { notificationId: id, memberId: member.id },
      });
      await this.prisma.notification.update({
        where: { id },
        data: { readCount: { increment: 1 } },
      });
    } catch (err) {
      // 已读过(plain unique [notificationId, memberId] 撞)→ 幂等 no-op,**不**重复 +1 readCount。
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return { read: true };
      }
      throw err;
    }
    return { read: true };
  }

  // ============ 端点 12:未读数(badge;NOT EXISTS 子查询 reads.none)============
  async unreadCount(currentUser: CurrentUserPayload): Promise<NotificationUnreadCountDto> {
    const member = await this.assertCanUseAppOrThrow(currentUser);
    const ctx = await this.resolveCtx(currentUser, member.id);
    const where: Prisma.NotificationWhereInput = {
      ...this.buildVisibleNotificationWhere(ctx),
      // 本人未读 = 不存在该 member 的 NotificationRead 行(Prisma none → NOT EXISTS 相关子查询)。
      reads: { none: { memberId: member.id } },
    };
    const unreadCount = await this.prisma.notification.count({ where });
    return { unreadCount };
  }

  // ===== 私有 helper =====

  // 取行 → canSeeContent 判定(不可见 / 不存在统一 31001 防枚举);复用 content.visibility 单条判定。
  private async findVisibleOrThrow(
    ctx: CallerVisibilityContext,
    id: string,
  ): Promise<Notification> {
    const row = await this.prisma.notification.findFirst({ where: { id, deletedAt: null } });
    if (!row || !canSeeContent(ctx, row)) {
      throw new BizException(BizCode.NOTIFICATION_NOT_FOUND);
    }
    return row;
  }

  private async hasRead(memberId: string, notificationId: string): Promise<boolean> {
    const found = await this.prisma.notificationRead.findUnique({
      where: { notificationId_memberId: { notificationId, memberId } },
      select: { id: true },
    });
    return found !== null;
  }

  private async readNotificationIdSet(
    memberId: string,
    notificationIds: string[],
  ): Promise<Set<string>> {
    if (notificationIds.length === 0) return new Set();
    const reads = await this.prisma.notificationRead.findMany({
      where: { memberId, notificationId: { in: notificationIds } },
      select: { notificationId: true },
    });
    return new Set(reads.map((r) => r.notificationId));
  }

  // ===== 读者出参构造(零 authorUserId / visibleOrganizationIds / statusCode / readCount)=====

  private toReadListItemDto(row: Notification, read: boolean): NotificationReadListItemDto {
    return {
      id: row.id,
      title: row.title,
      notificationTypeCode: row.notificationTypeCode,
      pinned: row.pinned,
      read,
      publishedAt: row.publishedAt,
      createdAt: row.createdAt,
    };
  }

  private toReadDetailDto(row: Notification, read: boolean): NotificationReadDetailDto {
    return {
      id: row.id,
      title: row.title,
      body: row.body,
      notificationTypeCode: row.notificationTypeCode,
      visibilityCode: row.visibilityCode,
      pinned: row.pinned,
      read,
      publishedAt: row.publishedAt,
      createdAt: row.createdAt,
    };
  }
}
