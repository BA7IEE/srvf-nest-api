import { Injectable, Logger } from '@nestjs/common';
import {
  MemberStatus,
  type Notification,
  Prisma,
  type SmsProviderType,
  UserStatus,
} from '@prisma/client';

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
import { RbacService } from '../permissions/rbac.service';
// 受众资格判定(渠道无关)的唯一真相 —— T5A / D-WC-19;短信不再自持第二套可见性口径。
import { authorizeBroadcastRecipients } from './notification-recipient-authorization.service';
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
} from './notification.constants';
import { notificationDispatchFailureLog } from './notification-dispatch-error';

// 短信兜底受众单元(已解析:可见 + 有手机的可计费收件人)。
interface SmsRecipient {
  memberId: string;
  phone: string;
}

type SmsDispatchClient = PrismaService | Prisma.TransactionClient;

export interface SmsRecipientDispatchResult {
  outcome: 'sent' | 'skipped';
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
// **本服务不自动触发**(无第三 cron / Redis / 外部 queue / 事件总线;短信永不随 publish 自动发):
// NotificationService.sendSms 在 admin confirmed=true 时预留逐 member intent；独立 worker 与 HTTP 首轮
// 共用 dispatchRecipient。dispatch 保留既有兼容批语义与测试锁，但不再是 durable admin 入口。
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

  // D-Outbox:request reservation 与受众事实使用同一 transaction client；只返回内部 memberId，
  // phone 永不进入 intent/eventKey/destinationRef。
  async resolveRecipientMemberIds(
    notification: Notification,
    client: SmsDispatchClient,
  ): Promise<string[]> {
    return (await this.resolveSmsAudience(notification, client)).map(({ memberId }) => memberId);
  }

  // NotificationDelivery SENT 是永久幂等事实：后续 generation 不再触碰 provider，但保留
  // re-trigger 可观测，追加一条 DB-only already-sent 诊断流水。recipientRef 复用首次投递的
  // 掩码值，绝不回填明文。
  async recordAlreadySentSkip(
    notificationId: string,
    memberId: string,
    client: SmsDispatchClient = this.prisma,
  ): Promise<void> {
    const previous = await client.notificationDelivery.findFirst({
      where: { notificationId, memberId, channel: NOTIFICATION_CHANNEL_SMS },
      orderBy: { createdAt: 'desc' },
      select: { recipientRef: true },
    });
    const user = previous
      ? null
      : await client.user.findFirst({
          where: notDeletedWhere({ memberId, status: UserStatus.ACTIVE }),
          select: { phone: true },
        });
    await client.notificationDelivery.create({
      data: {
        notificationId,
        channel: NOTIFICATION_CHANNEL_SMS,
        memberId,
        recipientRef: previous?.recipientRef ?? (user?.phone ? maskPhone(user.phone) : '-'),
        status: DELIVERY_STATUS_SKIPPED,
        reasonCode: DELIVERY_REASON_ALREADY_SENT,
      },
    });
  }

  // D-Outbox 每个 child intent 只处理一个收件人。provider 失败或本地成功证据提交失败都外抛，
  // 由 worker nack 该 child；success / 合法 skip 才允许 ack。这样 partial failure 不会吞掉整批重试。
  async dispatchRecipient(
    notification: Notification,
    memberId: string,
    beforeEffect: () => Promise<void>,
  ): Promise<SmsRecipientDispatchResult> {
    // 永久幂等事实必须先于通道/受众解析：provider 已成功但 ack 前崩溃后，即使通道随后
    // disabled，reclaim 也只能记 already-sent skip，绝不能再次调用 provider。
    const sent = await this.prisma.notificationDelivery.findFirst({
      where: {
        notificationId: notification.id,
        channel: NOTIFICATION_CHANNEL_SMS,
        status: DELIVERY_STATUS_SENT,
        memberId,
      },
      select: { id: true },
    });
    if (sent) {
      await this.recordAlreadySentSkip(notification.id, memberId);
      return { outcome: 'skipped' };
    }
    await this.assertChannelReady();
    const recipient = (await this.resolveSmsAudience(notification)).find(
      (candidate) => candidate.memberId === memberId,
    );
    if (!recipient) return { outcome: 'skipped' };
    return this.dispatchResolvedRecipient(notification, recipient, beforeEffect);
  }

  // HTTP confirmed path 在任何 durable reservation 前调用，确保 24030 = 零 intent / 零迟到补发。
  async assertChannelReady(): Promise<SmsProviderType> {
    const settings = await this.settings.getActiveSettings();
    if (!settings || !settings.enabled || !settings.templateIdNotification) {
      throw new SmsChannelUnavailableError('notification 短信兜底渠道未配置 / 未启用');
    }
    return this.router.resolveProviderType();
  }

  // 派发短信(admin confirmed=true 路径):逐可计费受众单发。
  // **通道未就绪**(settings 缺失 / 未启用 / templateIdNotification 空 / production-like DEV_STUB)→ 发送前抛
  // SmsChannelUnavailableError(调用方映射 24030,**零计费零 delivery**);进入逐人循环后**永不抛**(FAILED 落 delivery)。
  async dispatch(notification: Notification): Promise<SmsDispatchSummary> {
    // 通道就绪前置(镜像生日批 :64-72:templateId 空整批跳过零成本);templateIdNotification 是「该渠道已配置」闸,
    // DEV_STUB 忽略其值但须非空(对齐生日批口径,e2e 同设)。
    // production-like DEV_STUB 第②重守护(router.resolve);实际发送证据的 providerType
    // 只取随后每个 prepared Effect 绑定的同一 route snapshot。
    await this.assertChannelReady();

    const audience = await this.resolveSmsAudience(notification);
    const summary: SmsDispatchSummary = {
      recipientCount: audience.length,
      sent: 0,
      failed: 0,
      skipped: 0,
    };
    for (const recipient of audience) {
      try {
        const result = await this.dispatchResolvedRecipient(notification, recipient);
        if (result.outcome === 'sent') summary.sent += 1;
        else summary.skipped += 1;
      } catch (err) {
        if (err instanceof SmsChannelUnavailableError) {
          this.logger.warn(
            notificationDispatchFailureLog('sms-broadcast', err, {
              notificationId: notification.id,
            }),
          );
          break;
        }
        summary.failed += 1;
        this.logger.warn(
          notificationDispatchFailureLog('sms-recipient', err, {
            notificationId: notification.id,
          }),
        );
      }
    }

    this.logger.log(
      `sms notification dispatch done: notification=${notification.id} recipientCount=${summary.recipientCount} ` +
        `sent=${summary.sent} failed=${summary.failed} skipped=${summary.skipped}`,
    );
    return summary;
  }

  private async dispatchResolvedRecipient(
    notification: Notification,
    recipient: SmsRecipient,
    beforeEffect?: () => Promise<void>,
  ): Promise<SmsRecipientDispatchResult> {
    const alreadySentRows = await this.prisma.notificationDelivery.findMany({
      where: {
        notificationId: notification.id,
        channel: NOTIFICATION_CHANNEL_SMS,
        status: DELIVERY_STATUS_SENT,
        memberId: recipient.memberId,
      },
      select: { memberId: true },
    });
    const alreadySent = alreadySentRows.some(({ memberId }) => memberId === recipient.memberId);
    const now = new Date();
    const skipReason = alreadySent
      ? DELIVERY_REASON_ALREADY_SENT
      : await this.resolveSkipReason(recipient.phone, startOfDayUtc8(now), now);
    if (skipReason) {
      await this.recordDelivery({
        notificationId: notification.id,
        memberId: recipient.memberId,
        recipientRef: maskPhone(recipient.phone),
        status: DELIVERY_STATUS_SKIPPED,
        reasonCode: skipReason,
      });
      return { outcome: 'skipped' };
    }

    const prepared = await this.router.prepareNotification({ phone: recipient.phone });
    if (beforeEffect) await beforeEffect();
    let providerMsgId: string | null;
    try {
      const pending = prepared.invoke();
      ({ providerMsgId } = await pending);
    } catch (error) {
      if (error instanceof SmsChannelUnavailableError) throw error;
      const { errCode, errMsg } = normalizeSendError(error);
      await this.prisma.smsSendLog.create({
        data: {
          phone: recipient.phone,
          templateKey: SMS_TEMPLATE_KEY_NOTIFICATION,
          providerType: prepared.providerType,
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
      throw error;
    }

    const attemptedAt = new Date();
    // provider 仍在事务外；accepted 后的两条本地成功证据必须同一短事务提交，避免只有
    // sms_send_logs SENT 却无 NotificationDelivery SENT 时 reclaim 重发。本地事务失败不能
    // 伪造 provider FAILED 证据，直接外抛交给 outbox 的 at-least-once 重试窗口处理。
    await this.prisma.$transaction(async (tx) => {
      await tx.smsSendLog.create({
        data: {
          phone: recipient.phone,
          templateKey: SMS_TEMPLATE_KEY_NOTIFICATION,
          providerType: prepared.providerType,
          status: 'SENT',
          providerMsgId,
        },
      });
      await this.recordDelivery(
        {
          notificationId: notification.id,
          memberId: recipient.memberId,
          recipientRef: maskPhone(recipient.phone),
          status: DELIVERY_STATUS_SENT,
          providerMsgId,
          attemptedAt,
        },
        tx,
      );
    });
    return { outcome: 'sent' };
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

  // 解析可计费受众:可见(broadcast 走渠道无关受众判定;directed 仅收件人本人)且有
  // User.phone 的 active member。仅发 User.phone(对齐生日批拍板⑤;MemberProfile.mobile 永不用于发送)。
  private async resolveSmsAudience(
    notification: Notification,
    client: SmsDispatchClient = this.prisma,
  ): Promise<SmsRecipient[]> {
    // directed 不是「受众判定」问题:收件人已由 producer 显式指定,不过可见档。
    if (notification.audienceType === NOTIFICATION_AUDIENCE_DIRECTED) {
      return notification.recipientMemberId
        ? this.resolveDirectedSmsRecipients(notification.recipientMemberId, client)
        : [];
    }

    const candidateMemberIds = (
      await client.member.findMany({
        where: notDeletedWhere({ status: MemberStatus.ACTIVE }),
        select: { id: true },
      })
    ).map((m) => m.id);
    if (candidateMemberIds.length === 0) return [];

    // 受众资格判定已归 `notification-recipient-authorization.service`(T5A);
    // 本方法只剩渠道职责:注入「要哪些 User 列」(phone)并按可计费口径收窄。
    const authorized = await authorizeBroadcastRecipients({
      client,
      rbac: this.rbac,
      notification,
      candidateMemberIds,
      loadActiveUsers: (audienceClient, activeMemberIds) =>
        audienceClient.user.findMany({
          where: notDeletedWhere({ memberId: { in: activeMemberIds }, status: UserStatus.ACTIVE }),
          select: { id: true, memberId: true, role: true, phone: true },
        }),
    });

    // 可见但无 phone:不计入可计费受众(不发 / 不落 delivery)。
    return authorized.flatMap(({ memberId, user }) =>
      user?.phone ? [{ memberId, phone: user.phone }] : [],
    );
  }

  // directed 收件人解析:active member 再核(候选可能已软删 / 非 ACTIVE)+ active user 的 phone。
  // 不构造可见性 ctx —— 定向行的收件人就是受众本身。
  private async resolveDirectedSmsRecipients(
    recipientMemberId: string,
    client: SmsDispatchClient,
  ): Promise<SmsRecipient[]> {
    const activeMembers = await client.member.findMany({
      where: notDeletedWhere({ id: { in: [recipientMemberId] }, status: MemberStatus.ACTIVE }),
      select: { id: true, gradeCode: true },
    });
    if (activeMembers.length === 0) return [];

    const users = await client.user.findMany({
      where: notDeletedWhere({ memberId: { in: [recipientMemberId] }, status: UserStatus.ACTIVE }),
      select: { id: true, memberId: true, role: true, phone: true },
    });
    const phone = users.find((u) => u.memberId === recipientMemberId)?.phone ?? null;
    return phone ? [{ memberId: recipientMemberId, phone }] : [];
  }

  private async recordDelivery(
    input: {
      notificationId: string;
      memberId: string;
      recipientRef: string;
      status: string;
      reasonCode?: string;
      providerMsgId?: string | null;
      errCode?: string;
      attemptedAt?: Date;
    },
    client: SmsDispatchClient = this.prisma,
  ): Promise<void> {
    await client.notificationDelivery.create({
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
// 各模块本地实现,不抽共享 util——AGENTS §1 / docs/reference/naming-dto-validation.md §2 grab-bag 禁令 + notifications/CLAUDE.md)。
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
