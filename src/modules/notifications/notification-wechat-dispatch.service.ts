import { Injectable, Logger } from '@nestjs/common';
import {
  MemberStatus,
  type Notification,
  OrganizationStatus,
  Role,
  UserStatus,
} from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { MembershipTermStateMachine } from '../member-departments/membership-term-state-machine';
import {
  maskOpenid,
  WECHAT_ERRCODE_INVALID_OPENID,
  WECHAT_ERRCODE_SUBSCRIBE_NO_AUTH,
  WECHAT_ERRCODE_TEMPLATE_PARAM,
  WECHAT_ERRCODE_TOKEN_INVALID,
} from '../wechat/wechat.constants';
import { WechatService } from '../wechat/wechat.service';
// 可见性**复用** content.visibility 纯函数(canSeeContent);通知去 public,4 档天然适用(零第二套)。
import { canSeeContent, type CallerVisibilityContext } from '../content/content.visibility';
import { RbacService } from '../permissions/rbac.service';
import {
  DELIVERY_REASON_API_FAILED,
  DELIVERY_REASON_INVALID_OPENID,
  DELIVERY_REASON_NEED_RESUBSCRIBE,
  DELIVERY_REASON_NO_OPENID,
  DELIVERY_REASON_NO_QUOTA,
  DELIVERY_REASON_NO_TEMPLATE,
  DELIVERY_REASON_TEMPLATE_PARAM,
  DELIVERY_REASON_TOKEN_FAILED,
  DELIVERY_STATUS_FAILED,
  DELIVERY_STATUS_SENT,
  DELIVERY_STATUS_SKIPPED,
  NOTIFICATION_CHANNEL_WECHAT,
  NOTIFICATION_VISIBILITY_MANAGEMENT,
  WECHAT_SUBSCRIPTION_QUOTA_CAP,
} from './notification.constants';
import { buildWechatSubscribeData } from './notification.wechat-data';
import { WechatSubscribeTemplateService } from './wechat-subscribe-template.service';

// 派发受众单元(已解析:可见 + openid〔可空 → 后续记 no-openid〕)。
interface AudienceMember {
  memberId: string;
  openid: string | null;
}

// 统一通知 S2:微信渠道派发(广播勾微信 → 对可见且有 quota 的会员逐人下发)。
//
// **本服务不是 S3 的 NotificationDispatcher Effect**(派发器 Effect 正式化 = S3);S2 = 聚焦微信渠道分支,
// 由 NotificationService.publish 在 **publish DB 事务之外** 同步调用(§6.2:8s HTTP 绝不拖事务)。
//
// fan-out 收窄(§2.1 / §8.1):候选 = 该类型微信模板下 **有 quota 的会员**(已 ack 订阅,远少于全员)∩ 可见,
// 减去本通知已 sent 的(re-publish 去重,§7「不重复推」)。非订阅者**不 fan-out**(无 delivery 行)。
//
// 逐人(§3.4;失败不阻断下一人,镜像生日批 FAILED 不阻断):openid(无→skipped no-openid)→ 条件原子扣 quota
// (count===0 并发扣空→skipped no-quota〔补授权信号〕)→ count===1 → 发送 → 写 NotificationDelivery
// (sent / failed + errCode)。43101→failed need-resubscribe + 条件回补 quota;token 失效刷一次重试(WechatService 内)。
@Injectable()
export class NotificationWechatDispatchService {
  private readonly logger = new Logger(NotificationWechatDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wechat: WechatService,
    private readonly rbac: RbacService,
    private readonly templates: WechatSubscribeTemplateService,
  ) {}

  // 广播通知派发微信渠道。调用方已确认 channels 含 wechat 且 audienceType=broadcast。
  // **永不抛**:整渠道异常仅 log(publish 已 commit,站内已达,微信失败不回滚业务)。
  async dispatchBroadcast(notification: Notification): Promise<void> {
    try {
      await this.dispatchBroadcastInner(notification);
    } catch (err) {
      // 防御:派发整体异常不外冒(不影响 publish 响应);逐人异常已在 loop 内 catch。
      this.logger.error(
        `wechat dispatch failed for notification=${notification.id}: ${(err as Error).message}`,
      );
    }
  }

  // 统一通知 S3:定向通知微信渠道派发(单一收件人 = notification.recipientMemberId)。
  // 由 NotificationDispatcher Effect 在 producer 事务 **commit 之后** 调用(§6.2:8s HTTP 绝不拖事务)。
  // **永不抛**(镜像 dispatchBroadcast):微信失败仅 log + delivery,绝不回滚已建定向行 / 阻断 producer。
  // 复用 dispatchOne(§3.4 五步:openid → 原子扣 quota → send → delivery + 失败码语义)——与广播同一套渠道机制。
  // 与广播差异:无可见性 fan-out(收件人显式)、无 re-publish 去重(定向行每次新建唯一);新志愿者通常无 quota → skipped no-quota。
  async dispatchDirected(notification: Notification): Promise<void> {
    try {
      const recipientMemberId = notification.recipientMemberId;
      if (!recipientMemberId) return; // 防御:定向通知必有收件人(dispatcher 已置)

      // 1. 该类型有可发微信模板(enabled + templateId 非空)?无 → 记 skipped no-template(单收件人留痕,便于运维诊断)。
      const templateId = await this.templates.getEnabledTemplateId(
        notification.notificationTypeCode,
      );
      if (!templateId) {
        await this.recordDelivery({
          notificationId: notification.id,
          memberId: recipientMemberId,
          recipientRef: '-',
          status: DELIVERY_STATUS_SKIPPED,
          reasonCode: DELIVERY_REASON_NO_TEMPLATE,
        });
        return;
      }

      // 2. 解析收件人 openid(active member → active user.openid;无 → dispatchOne 记 skipped no-openid)。
      const openid = await this.resolveMemberOpenid(recipientMemberId);

      // 3. 单收件人下发(复用 dispatchOne:openid 空 → skipped no-openid;有 → 原子扣 quota → send → delivery)。
      await this.dispatchOne(notification, templateId, { memberId: recipientMemberId, openid });
    } catch (err) {
      this.logger.error(
        `wechat directed dispatch failed for notification=${notification.id}: ${(err as Error).message}`,
      );
    }
  }

  // D-Outbox 广播根 intent 只做安全 fan-out：解析当前模板 quota 候选与可见性，
  // 返回 memberId 供每收件人 child intent 持久化；openid/templateId 不进入 outbox payload。
  async resolveDurableBroadcastMemberIds(notification: Notification): Promise<string[]> {
    const templateId = await this.templates.getEnabledTemplateId(notification.notificationTypeCode);
    if (!templateId) return [];
    const quotaRows = await this.prisma.wechatSubscriptionQuota.findMany({
      where: { templateId, availableCount: { gt: 0 } },
      select: { memberId: true },
    });
    if (quotaRows.length === 0) return [];
    const alreadySent = await this.prisma.notificationDelivery.findMany({
      where: {
        notificationId: notification.id,
        channel: NOTIFICATION_CHANNEL_WECHAT,
        status: DELIVERY_STATUS_SENT,
        memberId: { in: quotaRows.map((row) => row.memberId) },
      },
      select: { memberId: true },
    });
    const sent = new Set(alreadySent.map((row) => row.memberId));
    const audience = await this.resolveAudience(
      quotaRows.map((row) => row.memberId).filter((memberId) => !sent.has(memberId)),
      notification,
    );
    return audience.map((member) => member.memberId);
  }

  // 定向收件人 openid 解析:active member 的 active user.openid(单收件人,非批量 resolveAudience)。
  private async resolveMemberOpenid(memberId: string): Promise<string | null> {
    const member = await this.prisma.member.findFirst({
      where: notDeletedWhere({ id: memberId, status: MemberStatus.ACTIVE }),
      select: { id: true },
    });
    if (!member) return null;
    const user = await this.prisma.user.findFirst({
      where: notDeletedWhere({ memberId, status: UserStatus.ACTIVE }),
      select: { openid: true },
    });
    return user?.openid ?? null;
  }

  private async dispatchBroadcastInner(notification: Notification): Promise<void> {
    // 1. 该类型是否有可发的微信模板(enabled + templateId 非空)?无 → 整渠道跳过(不 fan-out skip 行)。
    const templateId = await this.templates.getEnabledTemplateId(notification.notificationTypeCode);
    if (!templateId) {
      this.logger.log(
        `wechat dispatch skipped: no enabled template for type=${notification.notificationTypeCode} (notification=${notification.id})`,
      );
      return;
    }

    // 2. 候选 = 该 templateId 有 quota(>0)的会员,减去本通知已 sent 的(re-publish 去重)。
    const quotaRows = await this.prisma.wechatSubscriptionQuota.findMany({
      where: { templateId, availableCount: { gt: 0 } },
      select: { memberId: true },
    });
    const candidateMemberIds = quotaRows.map((r) => r.memberId);
    if (candidateMemberIds.length === 0) return;

    const alreadySent = await this.prisma.notificationDelivery.findMany({
      where: {
        notificationId: notification.id,
        channel: NOTIFICATION_CHANNEL_WECHAT,
        status: DELIVERY_STATUS_SENT,
        memberId: { in: candidateMemberIds },
      },
      select: { memberId: true },
    });
    const sentSet = new Set(alreadySent.map((d) => d.memberId));
    const pendingMemberIds = candidateMemberIds.filter((id) => !sentSet.has(id));
    if (pendingMemberIds.length === 0) return;

    // 3. 批量解析候选的可见性 ctx + openid;只保留可见者(canSeeContent 复用 content.visibility)。
    const audience = await this.resolveAudience(pendingMemberIds, notification);

    // 4. 逐个可见候选下发(一人失败不阻断下一人)。
    for (const member of audience) {
      try {
        await this.dispatchOne(notification, templateId, member);
      } catch (err) {
        this.logger.warn(
          `wechat dispatch one failed (notification=${notification.id} member=${member.memberId}): ${(err as Error).message}`,
        );
      }
    }
  }

  // 批量解析候选受众:active member + active user(openid)+ 活跃部门 → 构造 ctx,canSeeContent 过滤。
  // isManagement 仅在 visibilityCode=management 时按 user 逐个 rbac.can 解析(候选已被 quota 收窄,可接受)。
  private async resolveAudience(
    memberIds: string[],
    notification: Notification,
  ): Promise<AudienceMember[]> {
    const members = await this.prisma.member.findMany({
      where: notDeletedWhere({ id: { in: memberIds }, status: MemberStatus.ACTIVE }),
      select: { id: true },
    });
    const activeMemberIds = members.map((m) => m.id);
    if (activeMemberIds.length === 0) return [];

    const users = await this.prisma.user.findMany({
      where: notDeletedWhere({ memberId: { in: activeMemberIds }, status: UserStatus.ACTIVE }),
      select: { id: true, memberId: true, role: true, openid: true },
    });
    const userByMember = new Map(users.flatMap((u) => (u.memberId ? [[u.memberId, u]] : [])));

    // 终态 scoped-authz PR2:重指向 active PRIMARY membership(= 旧单部门)。
    const depts = await this.prisma.memberOrganizationMembership.findMany({
      where: {
        ...MembershipTermStateMachine.effectiveWhere(new Date()),
        memberId: { in: activeMemberIds },
        membershipType: 'PRIMARY',
        organization: { status: OrganizationStatus.ACTIVE, deletedAt: null },
      },
      select: { memberId: true, organizationId: true },
    });
    const orgIdsByMember = new Map<string, string[]>();
    for (const d of depts) {
      const list = orgIdsByMember.get(d.memberId) ?? [];
      list.push(d.organizationId);
      orgIdsByMember.set(d.memberId, list);
    }

    const needsManagement = notification.visibilityCode === NOTIFICATION_VISIBILITY_MANAGEMENT;
    const audience: AudienceMember[] = [];
    for (const memberId of activeMemberIds) {
      const user = userByMember.get(memberId);
      const activeOrgIds = orgIdsByMember.get(memberId) ?? [];
      const isManagement = needsManagement ? await this.resolveIsManagement(user) : false;
      const ctx: CallerVisibilityContext = {
        isMember: true, // active member 准入(canUseApp 等价)
        isFormalMember: activeOrgIds.length > 0,
        activeOrgIds,
        isManagement,
      };
      if (canSeeContent(ctx, notification)) {
        audience.push({ memberId, openid: user?.openid ?? null });
      }
    }
    return audience;
  }

  // 管理层判定(仅 management 可见档用):SUPER_ADMIN / ADMIN 或持 notification.read.record。
  private async resolveIsManagement(
    user: { id: string; role: Role; memberId: string | null } | undefined,
  ): Promise<boolean> {
    if (!user) return false;
    if (user.role === Role.SUPER_ADMIN || user.role === Role.ADMIN) return true;
    const payload: CurrentUserPayload = {
      id: user.id,
      username: '',
      role: user.role,
      status: UserStatus.ACTIVE,
      memberId: user.memberId,
    };
    return this.rbac.can(payload, 'notification.read.record');
  }

  // 单收件人下发(§3.4 五步:openid → 原子扣 → send → delivery + 失败码语义)。
  private async dispatchOne(
    notification: Notification,
    templateId: string,
    member: AudienceMember,
  ): Promise<void> {
    // ① 可见但无绑定 openid → skipped no-openid(不扣 quota,无法发)。
    if (!member.openid) {
      await this.recordDelivery({
        notificationId: notification.id,
        memberId: member.memberId,
        recipientRef: '-',
        status: DELIVERY_STATUS_SKIPPED,
        reasonCode: DELIVERY_REASON_NO_OPENID,
      });
      return;
    }
    const maskedOpenid = maskOpenid(member.openid);

    // ② 条件原子扣减 quota(availableCount>0;count===1 才扣成功并发,count===0 = 并发扣空)。
    const decremented = await this.prisma.wechatSubscriptionQuota.updateMany({
      where: { memberId: member.memberId, templateId, availableCount: { gt: 0 } },
      data: { availableCount: { decrement: 1 } },
    });
    if (decremented.count === 0) {
      // 并发竞争扣空 → skipped no-quota + 补授权信号(前端据 status 端点提示补授权)。
      await this.recordDelivery({
        notificationId: notification.id,
        memberId: member.memberId,
        recipientRef: maskedOpenid,
        status: DELIVERY_STATUS_SKIPPED,
        reasonCode: DELIVERY_REASON_NO_QUOTA,
      });
      return;
    }

    // ③ 扣减成功 → 下发(WechatService 内编排 token 失效刷一次重试)。
    const result = await this.wechat.sendSubscribeMessage({
      openid: member.openid,
      templateId,
      data: buildWechatSubscribeData(notification),
    });

    if (result.ok) {
      await this.recordDelivery({
        notificationId: notification.id,
        memberId: member.memberId,
        recipientRef: maskedOpenid,
        status: DELIVERY_STATUS_SENT,
        providerMsgId: result.msgId,
        attemptedAt: new Date(),
      });
      return;
    }

    // ④ 发送失败:映射 reasonCode;43101 用户拒收/无授权 → 条件回补 quota(发送明确失败才回补)。
    const reasonCode = this.mapErrCodeToReason(result.errCode);
    if (Number(result.errCode) === WECHAT_ERRCODE_SUBSCRIBE_NO_AUTH) {
      await this.refundQuota(member.memberId, templateId);
    }
    await this.recordDelivery({
      notificationId: notification.id,
      memberId: member.memberId,
      recipientRef: maskedOpenid,
      status: DELIVERY_STATUS_FAILED,
      reasonCode,
      errCode: result.errCode,
      attemptedAt: new Date(),
    });
  }

  // 发送明确失败(43101)→ 回补被扣的 quota 槽(条件封顶,避免越上限)。
  private async refundQuota(memberId: string, templateId: string): Promise<void> {
    await this.prisma.wechatSubscriptionQuota.updateMany({
      where: { memberId, templateId, availableCount: { lt: WECHAT_SUBSCRIPTION_QUOTA_CAP } },
      data: { availableCount: { increment: 1 } },
    });
  }

  // 微信 errcode / 归一化标签 → delivery reasonCode。
  private mapErrCodeToReason(errCode: string): string {
    const numeric = Number(errCode);
    if (numeric === WECHAT_ERRCODE_SUBSCRIBE_NO_AUTH) return DELIVERY_REASON_NEED_RESUBSCRIBE;
    if (numeric === WECHAT_ERRCODE_INVALID_OPENID) return DELIVERY_REASON_INVALID_OPENID;
    if (numeric === WECHAT_ERRCODE_TEMPLATE_PARAM) return DELIVERY_REASON_TEMPLATE_PARAM;
    if (WECHAT_ERRCODE_TOKEN_INVALID.includes(numeric)) return DELIVERY_REASON_TOKEN_FAILED;
    if (errCode === 'TOKEN_FAILED' || errCode === 'CHANNEL_UNAVAILABLE') {
      return DELIVERY_REASON_TOKEN_FAILED;
    }
    return DELIVERY_REASON_API_FAILED;
  }

  private async recordDelivery(input: {
    notificationId: string;
    memberId: string;
    recipientRef: string;
    status: string;
    reasonCode?: string;
    providerMsgId?: string | null;
    errCode?: string;
    attemptedAt?: Date;
  }): Promise<void> {
    await this.prisma.notificationDelivery.create({
      data: {
        notificationId: input.notificationId,
        channel: NOTIFICATION_CHANNEL_WECHAT,
        memberId: input.memberId,
        recipientRef: input.recipientRef,
        status: input.status,
        reasonCode: input.reasonCode ?? null,
        providerMsgId: input.providerMsgId ?? null,
        errCode: input.errCode ?? null,
        attemptedAt: input.attemptedAt ?? null,
      },
    });
  }
}
