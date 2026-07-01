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
import { SmsProviderRouter } from '../sms/sms-provider.router';
import { SmsSettingsService } from '../sms/sms-settings.service';
import {
  maskPhone,
  SMS_DAILY_WINDOW_UTC_OFFSET_HOURS,
  SMS_PHONE_DAILY_LIMIT,
  SMS_SEND_MIN_INTERVAL_SECONDS,
  SMS_TEMPLATE_KEY_NOTIFICATION,
} from '../sms/sms.constants';
import { SmsChannelUnavailableError, SmsProviderSendError } from '../sms/sms.types';
// 可见性**复用** content.visibility 纯函数(canSeeContent),零第二套(评审稿 §5;镜像 S2 微信派发)。
import { canSeeContent, type CallerVisibilityContext } from '../content/content.visibility';
import { RbacService } from '../permissions/rbac.service';
import {
  DELIVERY_REASON_ALREADY_SENT,
  DELIVERY_REASON_DAILY_LIMIT,
  DELIVERY_REASON_IDEMPOTENT,
  DELIVERY_REASON_INTERVAL,
  DELIVERY_REASON_SEND_FAILED,
  DELIVERY_STATUS_FAILED,
  DELIVERY_STATUS_SENT,
  DELIVERY_STATUS_SKIPPED,
  NOTIFICATION_AUDIENCE_DIRECTED,
  NOTIFICATION_CHANNEL_SMS,
  NOTIFICATION_VISIBILITY_MANAGEMENT,
} from './notification.constants';

// 短信兜底受众单元(已解析:可见 + 有手机的可计费收件人)。
interface SmsRecipient {
  memberId: string;
  phone: string;
}

// 派发摘要(admin 端点回显:可计费受众 N = sent + failed + skipped 不变式)。
export interface SmsDispatchSummary {
  recipientCount: number; // 可见且有手机的可计费受众数(= 预览「将向 N 人发短信 = N 条计费」)
  sent: number;
  failed: number;
  skipped: number; // already-sent / idempotent / daily-limit / interval 各类跳过(不计费)
}

// 统一通知 S5:短信兜底渠道派发(紧急召集兜底;admin 经显式计费确认端点触发,评审稿 §4)。
//
// **本服务不自动触发**(无 cron / queue / 事件总线,§8;短信永不随 publish 自动发,禁区铁律):
// 仅由 NotificationService.sendSms 在 admin 显式 confirmed=true 时同步调用,逐可见且有手机的收件人单发。
//
// **复用 sms 基建不 fork**(评审稿 §4):SmsProviderRouter.sendNotification(additive,不改 verifyCode/birthday)
// + sms_send_logs(流水 + 防滥发查询)+ NotificationDelivery(投递态 + re-trigger 去重)+ maskPhone。
//
// **防滥发继承**(§8.3;逐人查 sms_send_logs):同日同模板幂等(镜像生日批 birthday-greeting.service:107-118,
// 一日一兜底 nudge)+ 同号日封顶(继承 SMS_PHONE_DAILY_LIMIT,跨模板)+ 间隔(继承 SMS_SEND_MIN_INTERVAL_SECONDS,
// 跨模板)。**FAILED 逐人不阻断**(镜像生日批 :143-158);**外部 SMS API 在任何 DB 事务之外**(§6.2)。
@Injectable()
export class NotificationSmsDispatchService {
  private readonly logger = new Logger(NotificationSmsDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly router: SmsProviderRouter,
    private readonly settings: SmsSettingsService,
    private readonly rbac: RbacService,
  ) {}

  // 预览可计费受众数(不发送、不查通道):供 admin confirmed=false 二次确认「将向 N 人发短信」。
  async countRecipients(notification: Notification): Promise<number> {
    return (await this.resolveSmsAudience(notification)).length;
  }

  // 派发短信(admin confirmed=true 路径):逐可计费受众单发。
  // **通道未就绪**(settings 缺失 / 未启用 / templateIdNotification 空 / production-like DEV_STUB)→ 发送前抛
  // SmsChannelUnavailableError(调用方映射 24030,**零计费零 delivery**);进入逐人循环后**永不抛**(FAILED 落 delivery)。
  async dispatch(notification: Notification): Promise<SmsDispatchSummary> {
    // 通道就绪前置(镜像生日批 :64-72:templateId 空整批跳过零成本);templateIdNotification 是「该渠道已配置」闸,
    // DEV_STUB 忽略其值但须非空(对齐生日批口径,e2e 同设)。
    const settings = await this.settings.getActiveSettings();
    if (!settings || !settings.enabled || !settings.templateIdNotification) {
      throw new SmsChannelUnavailableError('notification 短信兜底渠道未配置 / 未启用');
    }
    // providerType:落 sms_send_logs.providerType + production-like DEV_STUB 第②重守护(router.resolve)。
    const providerType = await this.router.resolveProviderType();

    const audience = await this.resolveSmsAudience(notification);
    const summary: SmsDispatchSummary = {
      recipientCount: audience.length,
      sent: 0,
      failed: 0,
      skipped: 0,
    };
    if (audience.length === 0) return summary;

    // re-trigger 去重(§7「不重复打扰」):本通知已 sent 过短信的 member 跳过(镜像 S2 微信 alreadySent)。
    const alreadySent = await this.prisma.notificationDelivery.findMany({
      where: {
        notificationId: notification.id,
        channel: NOTIFICATION_CHANNEL_SMS,
        status: DELIVERY_STATUS_SENT,
        memberId: { in: audience.map((r) => r.memberId) },
      },
      select: { memberId: true },
    });
    const sentSet = new Set(alreadySent.map((d) => d.memberId));

    const now = new Date();
    const dayStart = startOfDayUtc8(now);

    for (const recipient of audience) {
      try {
        const skipReason = sentSet.has(recipient.memberId)
          ? DELIVERY_REASON_ALREADY_SENT
          : await this.resolveSkipReason(recipient.phone, dayStart, now);
        if (skipReason) {
          await this.recordDelivery({
            notificationId: notification.id,
            memberId: recipient.memberId,
            recipientRef: maskPhone(recipient.phone),
            status: DELIVERY_STATUS_SKIPPED,
            reasonCode: skipReason,
          });
          summary.skipped += 1;
          continue;
        }

        // 发送(事务外;FAILED 逐人不阻断,镜像生日批 :131-158)。
        try {
          const result = await this.router.sendNotification({ phone: recipient.phone });
          await this.prisma.smsSendLog.create({
            data: {
              phone: recipient.phone,
              templateKey: SMS_TEMPLATE_KEY_NOTIFICATION,
              providerType,
              status: 'SENT',
              providerMsgId: result.providerMsgId,
            },
          });
          await this.recordDelivery({
            notificationId: notification.id,
            memberId: recipient.memberId,
            recipientRef: maskPhone(recipient.phone),
            status: DELIVERY_STATUS_SENT,
            providerMsgId: result.providerMsgId,
            attemptedAt: new Date(),
          });
          summary.sent += 1;
        } catch (err) {
          // 通道整体中途不可用(运维并发关闭)→ 中止剩余,零成本不写 FAILED(镜像生日批 :120-129)。
          if (err instanceof SmsChannelUnavailableError) {
            this.logger.warn(
              `sms notification dispatch aborted: channel unavailable (${err.message}) notification=${notification.id}`,
            );
            break;
          }
          const { errCode, errMsg } = normalizeSendError(err);
          await this.prisma.smsSendLog.create({
            data: {
              phone: recipient.phone,
              templateKey: SMS_TEMPLATE_KEY_NOTIFICATION,
              providerType,
              status: 'FAILED',
              errCode,
              errMsg,
            },
          });
          await this.recordDelivery({
            notificationId: notification.id,
            memberId: recipient.memberId,
            recipientRef: maskPhone(recipient.phone),
            status: DELIVERY_STATUS_FAILED,
            reasonCode: DELIVERY_REASON_SEND_FAILED,
            errCode,
            attemptedAt: new Date(),
          });
          summary.failed += 1;
          this.logger.warn(
            `sms notification send failed phone=${maskPhone(recipient.phone)} errCode=${errCode}`,
          );
        }
      } catch (err) {
        // 防御:单收件人 delivery/查 DB 异常不阻断下一人(逐人隔离;不外冒)。
        this.logger.warn(
          `sms notification recipient failed (notification=${notification.id} member=${recipient.memberId}): ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `sms notification dispatch done: notification=${notification.id} recipientCount=${summary.recipientCount} ` +
        `sent=${summary.sent} failed=${summary.failed} skipped=${summary.skipped}`,
    );
    return summary;
  }

  // 防滥发继承(逐人查 sms_send_logs;命中即返 reasonCode,顺序:幂等 → 日封顶 → 间隔)。
  private async resolveSkipReason(
    phone: string,
    dayStart: Date,
    now: Date,
  ): Promise<string | null> {
    // ① 同日同模板幂等(镜像生日批 :107-118):同号当日已 SENT notification 短信 → 跳过(一日一兜底 nudge)。
    const idempotent = await this.prisma.smsSendLog.count({
      where: {
        phone,
        templateKey: SMS_TEMPLATE_KEY_NOTIFICATION,
        status: 'SENT',
        createdAt: { gte: dayStart },
      },
    });
    if (idempotent > 0) return DELIVERY_REASON_IDEMPOTENT;

    // ② 同号日封顶(继承 SMS_PHONE_DAILY_LIMIT;跨模板 = 当日该号所有 SENT 短信)。
    const dailyCount = await this.prisma.smsSendLog.count({
      where: { phone, status: 'SENT', createdAt: { gte: dayStart } },
    });
    if (dailyCount >= SMS_PHONE_DAILY_LIMIT) return DELIVERY_REASON_DAILY_LIMIT;

    // ③ 同号间隔(继承 SMS_SEND_MIN_INTERVAL_SECONDS;跨模板 = 该号最近一条 SENT 短信)。
    const latest = await this.prisma.smsSendLog.findFirst({
      where: { phone, status: 'SENT' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (
      latest !== null &&
      now.getTime() - latest.createdAt.getTime() < SMS_SEND_MIN_INTERVAL_SECONDS * 1000
    ) {
      return DELIVERY_REASON_INTERVAL;
    }

    return null;
  }

  // 解析可计费受众:可见(broadcast 走 canSeeContent;directed 仅收件人本人)且有 User.phone 的 active member。
  // 仅发 User.phone(对齐生日批拍板⑤;MemberProfile.mobile 永不用于发送)。
  private async resolveSmsAudience(notification: Notification): Promise<SmsRecipient[]> {
    const isDirected = notification.audienceType === NOTIFICATION_AUDIENCE_DIRECTED;
    const candidateMemberIds = isDirected
      ? notification.recipientMemberId
        ? [notification.recipientMemberId]
        : []
      : (
          await this.prisma.member.findMany({
            where: notDeletedWhere({ status: MemberStatus.ACTIVE }),
            select: { id: true },
          })
        ).map((m) => m.id);
    if (candidateMemberIds.length === 0) return [];

    // active member 再核(directed 候选可能已软删 / 非 ACTIVE)。
    const activeMembers = await this.prisma.member.findMany({
      where: notDeletedWhere({ id: { in: candidateMemberIds }, status: MemberStatus.ACTIVE }),
      select: { id: true },
    });
    const activeMemberIds = activeMembers.map((m) => m.id);
    if (activeMemberIds.length === 0) return [];

    // active user 的 phone(仅 User.phone;memberId 关联)。
    const users = await this.prisma.user.findMany({
      where: notDeletedWhere({ memberId: { in: activeMemberIds }, status: UserStatus.ACTIVE }),
      select: { id: true, memberId: true, role: true, phone: true },
    });
    const userByMember = new Map(users.flatMap((u) => (u.memberId ? [[u.memberId, u]] : [])));

    // 活跃部门(可见性 ctx;broadcast 用)。终态 scoped-authz PR2:重指向 active PRIMARY membership(= 旧单部门)。
    const depts = await this.prisma.memberOrganizationMembership.findMany({
      where: {
        memberId: { in: activeMemberIds },
        deletedAt: null,
        membershipType: 'PRIMARY',
        status: 'ACTIVE',
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

    const needsManagement =
      !isDirected && notification.visibilityCode === NOTIFICATION_VISIBILITY_MANAGEMENT;
    const recipients: SmsRecipient[] = [];
    for (const memberId of activeMemberIds) {
      const user = userByMember.get(memberId);
      const phone = user?.phone ?? null;
      if (!phone) continue; // 可见但无 phone:不计入可计费受众(不发 / 不落 delivery)。
      if (isDirected) {
        // directed 仅收件人本人可见(候选已锁 recipientMemberId);有手机即收件人。
        recipients.push({ memberId, phone });
        continue;
      }
      const activeOrgIds = orgIdsByMember.get(memberId) ?? [];
      const isManagement = needsManagement ? await this.resolveIsManagement(user) : false;
      const ctx: CallerVisibilityContext = {
        isMember: true,
        isFormalMember: activeOrgIds.length > 0,
        activeOrgIds,
        isManagement,
      };
      if (canSeeContent(ctx, notification)) recipients.push({ memberId, phone });
    }
    return recipients;
  }

  // 管理层判定(仅 management 可见档用;镜像 S2 微信派发 resolveIsManagement)。
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
        channel: NOTIFICATION_CHANNEL_SMS,
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

// 固定 UTC+8 日界(评审稿 E-10;与 birthday-greeting / sms-code 私有 startOfDayUtc8 同口径,
// 各模块本地实现,不抽共享 util——AGENTS §2 grab-bag 禁令 + notifications/CLAUDE.md)。
function startOfDayUtc8(now: Date): Date {
  const offsetMs = SMS_DAILY_WINDOW_UTC_OFFSET_HOURS * 3600 * 1000;
  const shifted = now.getTime() + offsetMs;
  const dayStartShifted = Math.floor(shifted / 86_400_000) * 86_400_000;
  return new Date(dayStartShifted - offsetMs);
}

// 发送错误归一(模块内私有;不入 common grab-bag;镜像生日批 normalizeSendError)。
function normalizeSendError(err: unknown): { errCode: string; errMsg: string } {
  if (err instanceof SmsProviderSendError) {
    return { errCode: err.errCode, errMsg: err.errMsg };
  }
  if (err instanceof SmsChannelUnavailableError) {
    return { errCode: 'CHANNEL_UNAVAILABLE', errMsg: err.message };
  }
  return { errCode: 'UNKNOWN', errMsg: err instanceof Error ? err.message : String(err) };
}
