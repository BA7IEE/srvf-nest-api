import { Injectable } from '@nestjs/common';
import {
  MemberStatus,
  type Notification,
  type NotificationOutboxIntent,
  Prisma,
  UserStatus,
} from '@prisma/client';

import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { SmsProviderRouter } from '../sms/sms-provider.router';
import { SmsSettingsService } from '../sms/sms-settings.service';
import { SMS_TEMPLATE_KEY_BIRTHDAY } from '../sms/sms.constants';
import { SmsChannelUnavailableError, SmsProviderSendError } from '../sms/sms.types';
import {
  maskOpenid,
  WECHAT_ERRCODE_INVALID_OPENID,
  WECHAT_ERRCODE_SUBSCRIBE_NO_AUTH,
  WECHAT_ERRCODE_TEMPLATE_PARAM,
  WECHAT_ERRCODE_TOKEN_INVALID,
} from '../wechat/wechat.constants';
import { WechatService } from '../wechat/wechat.service';
import { maskWecomUserId, WECOM_ERROR_KIND, type WecomErrorKind } from '../wecom/wecom.constants';
import { WecomService, type WecomMessageContext } from '../wecom/wecom.service';
import {
  WecomApiError,
  WecomChannelUnavailableError,
  type WecomSendResult,
} from '../wecom/wecom.types';
import {
  DELIVERY_REASON_API_FAILED,
  DELIVERY_REASON_CHANNEL_DISABLED,
  DELIVERY_REASON_INVALID_OPENID,
  DELIVERY_REASON_NEED_RESUBSCRIBE,
  DELIVERY_REASON_NO_OPENID,
  DELIVERY_REASON_NO_QUOTA,
  DELIVERY_REASON_NO_TEMPLATE,
  DELIVERY_REASON_NO_WECOM_IDENTITY,
  DELIVERY_REASON_PROVIDER_CONTRACT_ERROR,
  DELIVERY_REASON_RATE_LIMITED,
  DELIVERY_REASON_RECIPIENT_UNAVAILABLE,
  DELIVERY_REASON_RECIPIENT_UNLICENSED,
  DELIVERY_REASON_TEMPLATE_PARAM,
  DELIVERY_REASON_TOKEN_FAILED,
  DELIVERY_STATUS_FAILED,
  DELIVERY_STATUS_SENT,
  DELIVERY_STATUS_SKIPPED,
  NOTIFICATION_AUDIENCE_BROADCAST,
  NOTIFICATION_AUDIENCE_DIRECTED,
  NOTIFICATION_CHANNEL_IN_APP,
  NOTIFICATION_CHANNEL_SMS,
  NOTIFICATION_CHANNEL_WECHAT,
  NOTIFICATION_CHANNEL_WECOM,
  NOTIFICATION_DIRECTED_VISIBILITY,
  NOTIFICATION_SOURCE_ADMIN,
  NOTIFICATION_SOURCE_SYSTEM,
  NOTIFICATION_STATUS_PUBLISHED,
  OUTBOX_ADMIN_PAYLOAD_VERSION,
  OUTBOX_EVENT_ADMIN_SMS,
  OUTBOX_EVENT_BIRTHDAY_SMS,
  OUTBOX_EVENT_SYSTEM_BROADCAST,
  OUTBOX_EVENT_TARGETED_NOTIFICATION,
  OUTBOX_EVENT_WECHAT_BROADCAST,
  OUTBOX_EVENT_WECHAT_DELIVERY,
  OUTBOX_EVENT_WECOM_BROADCAST,
  OUTBOX_EVENT_WECOM_DELIVERY,
  OUTBOX_PAYLOAD_VERSION,
  WECHAT_SUBSCRIPTION_QUOTA_CAP,
} from './notification.constants';
import {
  WECOM_TEXTCARD_BTN_TXT,
  WecomDeepLinkUnavailableError,
  WecomMessagePresenter,
  type WecomTextCardContent,
} from './notification-wecom.presenter';
import {
  NotificationWecomDispatchService,
  type WecomRecipientAuthorization,
} from './notification-wecom-dispatch.service';
import { buildWechatSubscribeData } from './notification.wechat-data';
import { NotificationSmsDispatchService } from './notification-sms-dispatch.service';
import { NotificationWechatDispatchService } from './notification-wechat-dispatch.service';
import {
  type ClaimedNotificationOutboxIntent,
  NotificationOutboxService,
} from './notification-outbox.service';
import type {
  AdminSmsOutboxPayload,
  BirthdaySmsOutboxPayload,
  OutboxExecutionResult,
  SystemBroadcastOutboxPayload,
  TargetedNotificationOutboxPayload,
  WechatBroadcastOutboxPayload,
  WechatDeliveryOutboxPayload,
  WecomBroadcastOutboxPayload,
  WecomDeliveryOutboxPayload,
} from './notification-outbox.types';
import {
  assertStoredNotificationOutboxIntentSafe,
  extractWechatDeliveryRootId,
  extractWecomDeliveryRootId,
  NotificationOutboxLeaseLostError,
  NotificationOutboxPayloadError,
  parseKnownNotificationOutboxPayload,
} from './notification-outbox.types';
import { WechatSubscribeTemplateService } from './wechat-subscribe-template.service';

export class UnsupportedNotificationOutboxEventError extends Error {
  readonly terminal = true;

  constructor(eventType: string, payloadVersion: number) {
    super(`UNSUPPORTED_NOTIFICATION_OUTBOX_EVENT: ${eventType}@${payloadVersion}`);
    this.name = 'UnsupportedNotificationOutboxEventError';
  }
}

class TransientNotificationProviderError extends Error {
  constructor(readonly errCode: string) {
    super(`TRANSIENT_NOTIFICATION_PROVIDER: ${errCode}`);
    this.name = 'TransientNotificationProviderError';
  }
}

/**
 * Provider 侧的**终态**失败(T5B):不再重试,intent 直接 dead 等人工处置。
 *
 * 与 `TransientNotificationProviderError` 的分野不是"严重程度",而是"重试有没有用":
 * - 45009 限流:官方拦截窗口内重试**只会延长拦截**(§10.7 末段 / D-WC-27)——
 *   必须停下来,由运维在窗口结束后显式 replay。
 * - invalidparty/invalidtag:单 touser 请求收到它 = 请求根本不是我们以为的那个,
 *   重发同一个坏请求一万次也还是坏的(§10.7 第 5 条「不得忽略」)。
 *
 * 为什么要 dead 而不是像其它终态失败那样 ack:ack 掉的 intent 是 succeeded,
 * **运维再也 replay 不了**。这两种恰恰是唯二需要人来接手的情况。
 */
class TerminalNotificationProviderError extends Error {
  readonly terminal = true;

  constructor(readonly errCode: string) {
    super(`TERMINAL_NOTIFICATION_PROVIDER: ${errCode}`);
    this.name = 'TerminalNotificationProviderError';
  }
}

export { TerminalNotificationProviderError };

export interface NotificationOutboxEffectGuard {
  beforeEffect: () => Promise<void>;
}

@Injectable()
export class NotificationOutboxHandlers {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: NotificationOutboxService,
    private readonly smsRouter: SmsProviderRouter,
    private readonly smsSettings: SmsSettingsService,
    private readonly smsDispatch: NotificationSmsDispatchService,
    private readonly wechat: WechatService,
    private readonly wechatTemplates: WechatSubscribeTemplateService,
    private readonly wechatDispatch: NotificationWechatDispatchService,
    // T5B 企业微信三件套:通道编排(route/凭证)· 受众与最终闸 · 呈现。
    // 三者职责严格分开 —— presenter 不认识凭证,dispatch 不认识 HTTP,wecom 不认识受众。
    private readonly wecom: WecomService,
    private readonly wecomDispatch: NotificationWecomDispatchService,
    private readonly wecomPresenter: WecomMessagePresenter,
  ) {}

  async execute(
    intent: ClaimedNotificationOutboxIntent,
    guard: NotificationOutboxEffectGuard,
  ): Promise<OutboxExecutionResult> {
    try {
      assertStoredNotificationOutboxIntentSafe(intent);
    } catch {
      throw new UnsupportedNotificationOutboxEventError(intent.eventType, intent.payloadVersion);
    }
    switch (intent.eventType) {
      case OUTBOX_EVENT_TARGETED_NOTIFICATION:
        return this.createTargetedNotification(intent);
      case OUTBOX_EVENT_SYSTEM_BROADCAST:
        return this.createSystemBroadcast(intent);
      case OUTBOX_EVENT_WECHAT_BROADCAST:
        return this.expandWechatBroadcast(intent);
      case OUTBOX_EVENT_WECHAT_DELIVERY:
        return this.deliverWechat(intent, guard);
      case OUTBOX_EVENT_WECOM_BROADCAST:
        return this.expandWecomBroadcast(intent);
      case OUTBOX_EVENT_WECOM_DELIVERY:
        return this.deliverWecom(intent, guard);
      case OUTBOX_EVENT_BIRTHDAY_SMS:
        return this.deliverBirthdaySms(intent, guard);
      case OUTBOX_EVENT_ADMIN_SMS:
        return this.deliverAdminSms(intent, guard);
      default:
        throw new UnsupportedNotificationOutboxEventError(intent.eventType, intent.payloadVersion);
    }
  }

  private async createTargetedNotification(
    intent: ClaimedNotificationOutboxIntent,
  ): Promise<OutboxExecutionResult> {
    const payload = parsePayload<TargetedNotificationOutboxPayload>(intent);
    await this.prisma.$transaction(async (tx) => {
      await tx.notification.createMany({
        data: [
          {
            id: intent.id,
            title: payload.title,
            body: payload.body,
            notificationTypeCode: payload.notificationTypeCode,
            statusCode: NOTIFICATION_STATUS_PUBLISHED,
            publishedAt: intent.createdAt,
            visibilityCode: NOTIFICATION_DIRECTED_VISIBILITY,
            audienceType: NOTIFICATION_AUDIENCE_DIRECTED,
            sourceType: NOTIFICATION_SOURCE_SYSTEM,
            channels: payload.channels,
            recipientMemberId: payload.recipientMemberId,
            authorUserId: null,
          },
        ],
        skipDuplicates: true,
      });
      if (payload.channels.includes(NOTIFICATION_CHANNEL_WECHAT)) {
        await this.outbox.enqueue(
          {
            eventKey: `wechat-delivery:${intent.id}:${payload.recipientMemberId}`,
            eventType: OUTBOX_EVENT_WECHAT_DELIVERY,
            payloadVersion: OUTBOX_PAYLOAD_VERSION,
            payload: { notificationId: intent.id, memberId: payload.recipientMemberId },
            aggregateType: 'notification',
            aggregateId: intent.id,
            destinationType: 'member',
            destinationRef: payload.recipientMemberId,
          },
          tx,
        );
      }
      // T5B:系统定向通知的企业微信 child(§10.3「系统定向」)。与微信分支**并列而非互斥** ——
      // 同一条定向通知声明了两个渠道时,两个 child 各自独立创建、独立投递、独立记账。
      // 用 `enqueue` 而不是 `enqueueWecomDeliveryAttempt`:v1 定向 child 的 eventKey 已经
      // 天然唯一(notificationId 就是 intent.id,一条通知一个收件人),不存在 generation 竞争,
      // 与微信 v1 定向分支的处置逐字一致。
      if (payload.channels.includes(NOTIFICATION_CHANNEL_WECOM)) {
        await this.outbox.enqueue(
          {
            eventKey: `wecom-delivery:${intent.id}:${payload.recipientMemberId}`,
            eventType: OUTBOX_EVENT_WECOM_DELIVERY,
            payloadVersion: OUTBOX_PAYLOAD_VERSION,
            payload: { notificationId: intent.id, memberId: payload.recipientMemberId },
            aggregateType: 'notification',
            aggregateId: intent.id,
            destinationType: 'member',
            destinationRef: payload.recipientMemberId,
          },
          tx,
        );
      }
    });
    return { effectPerformed: true };
  }

  private async createSystemBroadcast(
    intent: ClaimedNotificationOutboxIntent,
  ): Promise<OutboxExecutionResult> {
    const payload = parsePayload<SystemBroadcastOutboxPayload>(intent);
    await this.prisma.notification.createMany({
      data: [
        {
          id: intent.id,
          title: payload.title,
          body: payload.body,
          notificationTypeCode: payload.notificationTypeCode,
          statusCode: NOTIFICATION_STATUS_PUBLISHED,
          publishedAt: intent.createdAt,
          visibilityCode: payload.visibilityCode,
          audienceType: NOTIFICATION_AUDIENCE_BROADCAST,
          sourceType: NOTIFICATION_SOURCE_SYSTEM,
          channels: [NOTIFICATION_CHANNEL_IN_APP],
          recipientMemberId: null,
          authorUserId: null,
        },
      ],
      skipDuplicates: true,
    });
    return { effectPerformed: true };
  }

  private async expandWechatBroadcast(
    intent: ClaimedNotificationOutboxIntent,
  ): Promise<OutboxExecutionResult> {
    const payload = parsePayload<WechatBroadcastOutboxPayload>(intent);
    if (intent.payloadVersion !== OUTBOX_ADMIN_PAYLOAD_VERSION) {
      throw new UnsupportedNotificationOutboxEventError(intent.eventType, intent.payloadVersion);
    }
    const notification = await this.outbox.authorizeAdminNotificationEffect(
      intent,
      payload.notificationId,
      payload.publishGeneration,
      NOTIFICATION_CHANNEL_WECHAT,
    );
    if (!notification) return { effectPerformed: false, value: { expanded: 0 } };
    const memberIds = await this.wechatDispatch.resolveDurableBroadcastMemberIds(notification);
    await this.prisma.$transaction(async (tx) => {
      for (const memberId of memberIds) {
        await this.outbox.enqueueWechatDeliveryAttempt(
          {
            // root id 区分 publish generation；active-slot partial unique 让并发 roots 收敛到
            // 同一 child，terminal 后新 generation 才获得新 attempt。SENT guard 继续跨 generation 去重。
            eventKey: `wechat-delivery:${notification.id}:${intent.id}:${memberId}`,
            eventType: OUTBOX_EVENT_WECHAT_DELIVERY,
            payloadVersion: OUTBOX_ADMIN_PAYLOAD_VERSION,
            payload: {
              notificationId: notification.id,
              memberId,
              publishGeneration: payload.publishGeneration,
            },
            aggregateType: 'notification',
            aggregateId: notification.id,
            destinationType: 'member',
            destinationRef: memberId,
          },
          tx,
        );
      }
    });
    return { effectPerformed: false, value: { expanded: memberIds.length } };
  }

  private async deliverWechat(
    intent: ClaimedNotificationOutboxIntent,
    guard: NotificationOutboxEffectGuard,
  ): Promise<OutboxExecutionResult> {
    const payload = parsePayload<WechatDeliveryOutboxPayload>(intent);
    const preparedTemplateId = requireCompletePreparedTemplate(intent);
    if (intent.payloadVersion === OUTBOX_ADMIN_PAYLOAD_VERSION) {
      await this.requireAdminWechatRoot(intent, payload);
    }
    const notification =
      intent.payloadVersion === OUTBOX_ADMIN_PAYLOAD_VERSION
        ? await this.readAdminNotificationCandidate(
            payload.notificationId,
            payload.publishGeneration!,
          )
        : await this.requireLegacySystemNotification(
            intent,
            payload.notificationId,
            payload.memberId,
          );
    if (!notification) return { effectPerformed: false };
    const existingIntentDelivery = await this.prisma.notificationDelivery.findUnique({
      where: { id: intent.id },
      select: { id: true },
    });
    if (existingIntentDelivery) return { effectPerformed: false };
    const existingSent = await this.prisma.notificationDelivery.findFirst({
      where: {
        notificationId: notification.id,
        memberId: payload.memberId,
        channel: NOTIFICATION_CHANNEL_WECHAT,
        status: DELIVERY_STATUS_SENT,
      },
      select: { id: true },
    });
    if (existingSent) return { effectPerformed: false };

    const requestedTemplateId =
      preparedTemplateId ??
      (await this.wechatTemplates.getEnabledTemplateId(notification.notificationTypeCode));
    if (!requestedTemplateId) {
      await this.recordWechatDeliveryOnce(intent.id, {
        notificationId: notification.id,
        memberId: payload.memberId,
        recipientRef: '-',
        status: DELIVERY_STATUS_SKIPPED,
        reasonCode: DELIVERY_REASON_NO_TEMPLATE,
      });
      return { effectPerformed: false };
    }

    let openid =
      intent.payloadVersion === OUTBOX_ADMIN_PAYLOAD_VERSION
        ? undefined
        : await this.resolveMemberOpenid(payload.memberId);
    if (!openid && intent.payloadVersion !== OUTBOX_ADMIN_PAYLOAD_VERSION) {
      await this.recordWechatDeliveryOnce(intent.id, {
        notificationId: notification.id,
        memberId: payload.memberId,
        recipientRef: '-',
        status: DELIVERY_STATUS_SKIPPED,
        reasonCode: DELIVERY_REASON_NO_OPENID,
      });
      return { effectPerformed: false };
    }

    let quotaUnavailable = false;
    let quotaReserved = false;
    const preparation = await this.outbox.markPrepared(
      intent,
      requestedTemplateId,
      async (tx, templateId) => {
        const decremented = await tx.wechatSubscriptionQuota.updateMany({
          where: { memberId: payload.memberId, templateId, availableCount: { gt: 0 } },
          data: { availableCount: { decrement: 1 } },
        });
        if (decremented.count === 0) {
          quotaUnavailable = true;
          const hasFinalDestination =
            intent.payloadVersion !== OUTBOX_ADMIN_PAYLOAD_VERSION && openid !== undefined;
          await tx.notificationDelivery.createMany({
            data: [
              {
                id: intent.id,
                notificationId: notification.id,
                channel: NOTIFICATION_CHANNEL_WECHAT,
                memberId: payload.memberId,
                recipientRef: hasFinalDestination && openid ? maskOpenid(openid) : '-',
                status: DELIVERY_STATUS_SKIPPED,
                reasonCode:
                  intent.payloadVersion === OUTBOX_ADMIN_PAYLOAD_VERSION || hasFinalDestination
                    ? DELIVERY_REASON_NO_QUOTA
                    : DELIVERY_REASON_NO_OPENID,
              },
            ],
            skipDuplicates: true,
          });
        } else {
          quotaReserved = true;
        }
      },
    );
    const templateId = preparation.templateId;

    const preparedSkip = await this.prisma.notificationDelivery.findUnique({
      where: { id: intent.id },
      select: { status: true },
    });
    if (quotaUnavailable || preparedSkip) return { effectPerformed: false };

    const refundSameAttemptReservation = async (): Promise<void> => {
      if (!preparation.preparedNow || !quotaReserved) return;
      await this.outbox.refundPrepared(intent, preparation, async (tx, preparedTemplateId) => {
        const restored = await tx.wechatSubscriptionQuota.updateMany({
          where: {
            memberId: payload.memberId,
            templateId: preparedTemplateId,
            availableCount: { lt: WECHAT_SUBSCRIPTION_QUOTA_CAP },
          },
          data: { availableCount: { increment: 1 } },
        });
        return restored.count === 1;
      });
    };

    let authorizedOpenid: string | null | undefined;
    const finalNotification =
      intent.payloadVersion === OUTBOX_ADMIN_PAYLOAD_VERSION
        ? await this.outbox.authorizeAdminNotificationEffect(
            intent,
            payload.notificationId,
            payload.publishGeneration!,
            NOTIFICATION_CHANNEL_WECHAT,
            undefined,
            async (tx, lockedNotification) => {
              const authorization = await this.wechatDispatch.authorizeDurableBroadcastRecipient(
                tx,
                lockedNotification,
                payload.memberId,
              );
              if (!authorization) return false;
              authorizedOpenid = authorization.openid;
              return true;
            },
          )
        : notification;
    if (!finalNotification) {
      await refundSameAttemptReservation();
      return { effectPerformed: false };
    }
    if (intent.payloadVersion === OUTBOX_ADMIN_PAYLOAD_VERSION) {
      openid = authorizedOpenid;
    }
    if (!openid) {
      await refundSameAttemptReservation();
      await this.recordWechatDeliveryOnce(intent.id, {
        notificationId: notification.id,
        memberId: payload.memberId,
        recipientRef: '-',
        status: DELIVERY_STATUS_SKIPPED,
        reasonCode: DELIVERY_REASON_NO_OPENID,
      });
      return { effectPerformed: false };
    }

    const result = await this.wechat.sendSubscribeMessage(
      {
        openid,
        templateId,
        data: buildWechatSubscribeData(finalNotification),
      },
      guard.beforeEffect,
    );
    if (result.ok) {
      await this.prisma.notificationDelivery.createMany({
        data: [
          {
            id: intent.id,
            notificationId: notification.id,
            channel: NOTIFICATION_CHANNEL_WECHAT,
            memberId: payload.memberId,
            recipientRef: maskOpenid(openid),
            status: DELIVERY_STATUS_SENT,
            providerMsgId: result.msgId,
            attemptedAt: new Date(),
          },
        ],
        skipDuplicates: true,
      });
      return { effectPerformed: true };
    }

    const reasonCode = mapWechatError(result.errCode);
    const transient = isTransientWechatError(result.errCode);
    await this.prisma.$transaction(async (tx) => {
      const created = transient
        ? await tx.notificationDelivery.create({
            data: {
              notificationId: notification.id,
              channel: NOTIFICATION_CHANNEL_WECHAT,
              memberId: payload.memberId,
              recipientRef: maskOpenid(openid),
              status: DELIVERY_STATUS_FAILED,
              reasonCode,
              errCode: result.errCode,
              attemptedAt: new Date(),
            },
            select: { id: true },
          })
        : await tx.notificationDelivery.createMany({
            data: [
              {
                id: intent.id,
                notificationId: notification.id,
                channel: NOTIFICATION_CHANNEL_WECHAT,
                memberId: payload.memberId,
                recipientRef: maskOpenid(openid),
                status: DELIVERY_STATUS_FAILED,
                reasonCode,
                errCode: result.errCode,
                attemptedAt: new Date(),
              },
            ],
            skipDuplicates: true,
          });
      const createdCount = 'count' in created ? created.count : 1;
      if (createdCount === 1 && Number(result.errCode) === WECHAT_ERRCODE_SUBSCRIBE_NO_AUTH) {
        await tx.wechatSubscriptionQuota.updateMany({
          where: {
            memberId: payload.memberId,
            templateId,
            availableCount: { lt: WECHAT_SUBSCRIPTION_QUOTA_CAP },
          },
          data: { availableCount: { increment: 1 } },
        });
      }
    });
    if (transient) {
      throw new TransientNotificationProviderError(result.errCode);
    }
    return { effectPerformed: true };
  }

  // ==========================================================================
  // T5B 企业微信应用消息(冻结稿 §10)
  // ==========================================================================

  /**
   * 广播 root:算候选 → 逐人建 child intent。**自己不发任何消息**(effectPerformed 恒 false)。
   *
   * 返回值里的三个计数是运营五指标的前两项 + 去重项(§10.4 末条要求分开记录)。
   * 它们进 worker 的 drain 结果与日志,**不进 payload、不进 Audit** —— 计数不是敏感信息,
   * 但也没有理由长期落库。
   */
  private async expandWecomBroadcast(
    intent: ClaimedNotificationOutboxIntent,
  ): Promise<OutboxExecutionResult> {
    // parser 已强制 v2(企业微信广播不存在 v1 历史行),这里无需再判版本。
    const payload = parsePayload<WecomBroadcastOutboxPayload>(intent);
    const notification = await this.outbox.authorizeAdminNotificationEffect(
      intent,
      payload.notificationId,
      payload.publishGeneration,
      NOTIFICATION_CHANNEL_WECOM,
    );
    if (!notification) {
      return { effectPerformed: false, value: { expanded: 0, reason: 'notification-ineligible' } };
    }

    const audience = await this.wecomDispatch.resolveDurableBroadcastAudience(notification);
    await this.prisma.$transaction(async (tx) => {
      for (const memberId of audience.memberIds) {
        await this.outbox.enqueueWecomDeliveryAttempt(
          {
            // root id 进 eventKey 区分 publish generation;active-slot partial unique 让并发
            // root 收敛到同一条 child,terminal 后新 generation 才拿得到新 attempt。
            // NotificationDelivery SENT guard 继续跨 generation 去重。
            eventKey: `wecom-delivery:${notification.id}:${intent.id}:${memberId}`,
            eventType: OUTBOX_EVENT_WECOM_DELIVERY,
            payloadVersion: OUTBOX_ADMIN_PAYLOAD_VERSION,
            payload: {
              notificationId: notification.id,
              memberId,
              publishGeneration: payload.publishGeneration,
            },
            aggregateType: 'notification',
            aggregateId: notification.id,
            destinationType: 'member',
            destinationRef: memberId,
          },
          tx,
        );
      }
    });
    return {
      effectPerformed: false,
      value: {
        visibleAudience: audience.visibleAudience,
        identityCandidates: audience.identityCandidates,
        alreadySent: audience.alreadySent,
        expanded: audience.memberIds.length,
      },
    };
  }

  /**
   * 逐人 child:最终闸 → 呈现 → 单 touser 发送 → 回执分类记账。
   *
   * **顺序不可调换**。尤其"最终闸在呈现与发送之前":呈现需要的 webBaseUrl 与发送需要的
   * wecomUserId 都只从最终闸的事务内快照来 —— 先取地址再判资格,等于给"刚被撤销的身份"
   * 留了一个发送窗口。
   */
  private async deliverWecom(
    intent: ClaimedNotificationOutboxIntent,
    guard: NotificationOutboxEffectGuard,
  ): Promise<OutboxExecutionResult> {
    const payload = parsePayload<WecomDeliveryOutboxPayload>(intent);
    const isAdminChild = intent.payloadVersion === OUTBOX_ADMIN_PAYLOAD_VERSION;
    if (isAdminChild) {
      await this.requireAdminWecomRoot(intent, payload);
    }

    // 幂等前置:本 intent 已记过账 / 本通知本人本渠道已 SENT 过 → 直接结束。
    // SENT 是跨 generation 的永久事实,re-publish 不重复推同一个人。
    const existingIntentDelivery = await this.prisma.notificationDelivery.findUnique({
      where: { id: intent.id },
      select: { id: true },
    });
    if (existingIntentDelivery) return { effectPerformed: false };
    const existingSent = await this.prisma.notificationDelivery.findFirst({
      where: {
        notificationId: payload.notificationId,
        memberId: payload.memberId,
        channel: NOTIFICATION_CHANNEL_WECOM,
        status: DELIVERY_STATUS_SENT,
      },
      select: { id: true },
    });
    if (existingSent) return { effectPerformed: false };

    // ===== 同代配置快照(B5)=====
    // **必须在最终闸之前**取一次,之后整条投递只认这一份:最终闸据它校验代际,
    // 发送用它里面的 Provider。提交之后**不再**解析"最新 route" —— 那正是
    // "闸按 A 企业查出收件人、事后按 B 企业的凭证发出去"的成因。
    //
    // 通道闸关着(null)与凭证不可用(抛)在这里**合并成同一档**:两者都让 `expected=null`,
    // 由最终闸统一记 `skipped/channel-disabled`。在这里短路会让"资格已失效的人"
    // (退队 / 停用)也平白落一条 delivery,而现状是不落 —— 这条不变量比少写两行重要。
    let messageContext: WecomMessageContext | null = null;
    try {
      messageContext = await this.wecom.resolveMessageContext();
    } catch (error) {
      if (!(error instanceof WecomChannelUnavailableError)) throw error;
      messageContext = null;
    }

    // ===== Provider 前最终闸(§10.4)=====
    // 回调返回 true 的条件是"资格没失效",而不是"能发" —— channel-disabled 与
    // no-wecom-identity 都要求**记一条 terminal skipped**,所以必须放行到闸外去记账;
    // 只有真正的资格失效(退队 / 停用 / 撤权 / 通知失效)才让整个闸返 null 且不落 delivery。
    let authorization: WecomRecipientAuthorization | undefined;
    const authorizeRecipient = async (
      tx: Prisma.TransactionClient,
      locked: Notification,
    ): Promise<boolean> => {
      authorization = await this.wecomDispatch.authorizeDurableRecipient(
        tx,
        locked,
        payload.memberId,
        messageContext === null
          ? null
          : {
              corpId: messageContext.corpId,
              configurationGeneration: messageContext.configurationGeneration,
            },
      );
      return authorization.outcome !== 'ineligible';
    };
    const finalNotification = isAdminChild
      ? await this.outbox.authorizeAdminNotificationEffect(
          intent,
          payload.notificationId,
          payload.publishGeneration!,
          NOTIFICATION_CHANNEL_WECOM,
          undefined,
          authorizeRecipient,
        )
      : await this.outbox.authorizeSystemDirectedNotificationEffect(
          intent,
          payload.notificationId,
          payload.memberId,
          NOTIFICATION_CHANNEL_WECOM,
          undefined,
          authorizeRecipient,
        );
    if (!finalNotification || !authorization) return { effectPerformed: false };

    if (authorization.outcome === 'channel-disabled') {
      // §10.7 末条:通道关闭是**终态 skipped**,不允许"等恢复后迟到补发"。
      await this.recordWecomDeliveryOnce(intent.id, {
        notificationId: finalNotification.id,
        memberId: payload.memberId,
        recipientRef: '-',
        status: DELIVERY_STATUS_SKIPPED,
        reasonCode: DELIVERY_REASON_CHANNEL_DISABLED,
      });
      return { effectPerformed: false };
    }
    if (authorization.outcome === 'no-identity') {
      // §14.3 #15:child 创建后身份被清除,最终闸负责记 skipped/no-wecom-identity。
      await this.recordWecomDeliveryOnce(intent.id, {
        notificationId: finalNotification.id,
        memberId: payload.memberId,
        recipientRef: '-',
        status: DELIVERY_STATUS_SKIPPED,
        reasonCode: DELIVERY_REASON_NO_WECOM_IDENTITY,
      });
      return { effectPerformed: false };
    }
    if (authorization.outcome === 'config-changed') {
      // B5:配置在"取快照"与"最终闸提交"之间变了。**不落 delivery**、不发送 ——
      // 下一次 attempt 会用新一代配置重走完整判定,自然收敛到那一代该有的结局。
      // 记一条暂态流水都不写:什么外部动作都没发生,写了只会污染运营指标。
      throw new TransientNotificationProviderError('CONFIG_CHANGED');
    }
    if (authorization.outcome !== 'authorized' || messageContext === null) {
      return { effectPerformed: false };
    }

    const { wecomUserId, webBaseUrl } = authorization;
    const maskedRecipient = maskWecomUserId(wecomUserId);

    // ===== 呈现(纯函数;不碰 DB、不认识凭证)=====
    let card: WecomTextCardContent;
    try {
      card = this.wecomPresenter.present(finalNotification, webBaseUrl);
    } catch (error) {
      if (!(error instanceof WecomDeepLinkUnavailableError)) throw error;
      // webBaseUrl 缺失 / 非 https / 深链超长 = 通道没配全。归 channel-disabled 终态 skipped:
      // 与"开关关着"同类(都是配置问题,重试不会自愈),且不把配置错误伪装成上游故障。
      await this.recordWecomDeliveryOnce(intent.id, {
        notificationId: finalNotification.id,
        memberId: payload.memberId,
        recipientRef: maskedRecipient,
        status: DELIVERY_STATUS_SKIPPED,
        reasonCode: DELIVERY_REASON_CHANNEL_DISABLED,
      });
      return { effectPerformed: false };
    }

    // ===== 发送(**恒在事务外**;每次真实外部请求紧前独立过 fence guard)=====
    // route 来自闸前那一份同代快照(B5),**不再** `resolveRoute()` 重解析。
    const route = messageContext.provider;

    const send = async (forceRefresh: boolean): Promise<WecomSendResult> => {
      const accessToken = await route.getAccessToken(forceRefresh, guard.beforeEffect);
      return route.sendTextCard(
        accessToken,
        {
          toUser: wecomUserId,
          title: card.title,
          description: card.description,
          url: card.url,
          btnTxt: WECOM_TEXTCARD_BTN_TXT,
        },
        guard.beforeEffect,
      );
    };

    let result: WecomSendResult;
    try {
      result = await send(false);
      // §10.7:40014/42001 强刷 token 后**只重试一次**。禁止刷新循环 —— 一次配置错误
      // 会变成对上游的持续打点,而 45009 正是这么被触发的。
      // 判据只认 `kind`(B7):此前写的是 `Number(result.errCode)`,而 gettoken 阶段抛出的
      // token 失效根本走不到这里(它被下面的 catch 一律压成 TOKEN_FAILED 了)。
      if (!result.ok && result.kind === WECOM_ERROR_KIND.TOKEN_INVALID) {
        result = await send(true);
      }
    } catch (error) {
      // fence 丢失(lease lost)必须原样冒泡:那时 worker 不该 ack/nack/dead,
      // 更不该重新启动 Provider。
      if (error instanceof NotificationOutboxLeaseLostError) throw error;
      // ⚠️ **抛出的错误与返回的失败走同一个分类器**(B7)。此前这里把**任何**错误
      // 一律压成 `TOKEN_FAILED` 暂态 —— 于是 gettoken 阶段的 45009、HTTP 4xx、
      // 40001 Secret 错全被当成"取 token 失败",白白退避 8 次才 dead,
      // 而 45009 的语义恰恰是"再打就延长拦截"。Provider 已经分过类了,这里只做搬运。
      const normalized = normalizeWecomProviderError(error);
      // 不是企业微信域错误(DB / 编程错 / 未知)⇒ 原样冒泡,不伪装成通道问题。
      if (normalized === null) throw error;
      result = normalized;
    }

    return this.recordWecomSendResult(intent, finalNotification, payload, result, maskedRecipient);
  }

  /**
   * 回执分类(§10.7 逐条)。**这是整刀最容易写错的一段**,所以判据写死在一处:
   *
   * `SENT` 必须**同时**满足三条:errcode=0、当前这个 userid 不在 `invaliduser`、
   * 也不在 `unlicenseduser`。它只表示"企业微信接口接受了且没报告该收件人无效",
   * **不表示用户看见了或读了**。
   */
  private async recordWecomSendResult(
    intent: ClaimedNotificationOutboxIntent,
    notification: Notification,
    payload: WecomDeliveryOutboxPayload,
    result: WecomSendResult,
    maskedRecipient: string,
  ): Promise<OutboxExecutionResult> {
    if (result.ok) {
      // errcode=0 仍必须逐条查这两个名单(§10.4 业务结果第 4 条 / D-WC-27)。
      // 少了这一步,"接口调用成功"会被记成"消息送到了" —— 这正是运营指标④⑤存在的理由。
      if (result.invalidUsers.length > 0) {
        await this.recordWecomDeliveryOnce(intent.id, {
          notificationId: notification.id,
          memberId: payload.memberId,
          recipientRef: maskedRecipient,
          status: DELIVERY_STATUS_SKIPPED,
          reasonCode: DELIVERY_REASON_RECIPIENT_UNAVAILABLE,
        });
        return { effectPerformed: false };
      }
      if (result.unlicensedUsers.length > 0) {
        await this.recordWecomDeliveryOnce(intent.id, {
          notificationId: notification.id,
          memberId: payload.memberId,
          recipientRef: maskedRecipient,
          status: DELIVERY_STATUS_SKIPPED,
          reasonCode: DELIVERY_REASON_RECIPIENT_UNLICENSED,
        });
        return { effectPerformed: false };
      }
      await this.prisma.notificationDelivery.createMany({
        data: [
          {
            id: intent.id,
            notificationId: notification.id,
            channel: NOTIFICATION_CHANNEL_WECOM,
            memberId: payload.memberId,
            recipientRef: maskedRecipient,
            status: DELIVERY_STATUS_SENT,
            // msgid 可保存;**原始 errmsg 与完整响应不保存**(§10.7 第 6 条)。
            providerMsgId: result.msgId,
            attemptedAt: new Date(),
          },
        ],
        skipDuplicates: true,
      });
      return { effectPerformed: true };
    }

    // 81013 = 全部收件人无效。单 touser 请求下它与 invaliduser 同义,
    // 统一 terminal skipped/recipient-unavailable,**绝不记 SENT**(§10.4 业务结果第 4 条)。
    if (Number(result.errCode) === WECOM_ERRCODE_ALL_RECIPIENTS_INVALID) {
      await this.recordWecomDeliveryOnce(intent.id, {
        notificationId: notification.id,
        memberId: payload.memberId,
        recipientRef: maskedRecipient,
        status: DELIVERY_STATUS_SKIPPED,
        reasonCode: DELIVERY_REASON_RECIPIENT_UNAVAILABLE,
      });
      return { effectPerformed: false };
    }

    const reasonCode = mapWecomSendError(result.kind);

    // 暂态 —— **只有** network / timeout / http-5xx / system-busy / token-invalid 这五种(B7)。
    // 只记一条**不占 intent.id** 的流水,交给 worker 退避重试,耗尽后 dead。
    // 占了 intent.id 就等于把重试判据自己关掉。
    if (isTransientWecomKind(result.kind)) {
      await this.recordWecomTransientAttempt({
        notificationId: notification.id,
        memberId: payload.memberId,
        recipientRef: maskedRecipient,
        reasonCode,
        errCode: result.errCode,
      });
      throw new TransientNotificationProviderError(result.errCode);
    }

    // 以下都是终态:delivery 行占 intent.id,重放时直接短路。
    await this.recordWecomDeliveryOnce(intent.id, {
      notificationId: notification.id,
      memberId: payload.memberId,
      recipientRef: maskedRecipient,
      status: DELIVERY_STATUS_FAILED,
      reasonCode,
      errCode: result.errCode,
      attemptedAt: new Date(),
    });

    // 45009 限流 / 请求契约错(invalidparty·invalidtag / HTTP 4xx)→ intent 终态 **dead**,
    // 等人工 replay(见 TerminalNotificationProviderError)。dead 而不是 ack:
    // ack 掉的 intent 是 succeeded,运维再也 replay 不了。
    if (isTerminalDeadWecomKind(result.kind)) {
      throw new TerminalNotificationProviderError(result.errCode);
    }
    // 其余确定性失败(配置错 / 畸形回执 / 其它非 0 errcode):已逐人记账,
    // intent 本身算完成(与微信侧同一处置)—— 重试改变不了结果,也没有人工 replay 的余地。
    return { effectPerformed: true };
  }

  /**
   * v2 child 的 root 身份校验(镜像 `requireAdminWechatRoot`)。
   *
   * 防的是"直插一条 child、把 rootIntentId 指向别的通知的 root"——
   * 那样 child 就能借另一条通知的授权把消息发给不该收的人。
   */
  private async requireAdminWecomRoot(
    intent: ClaimedNotificationOutboxIntent,
    payload: WecomDeliveryOutboxPayload,
  ): Promise<void> {
    const rootId = extractWecomDeliveryRootId(intent.eventKey, intent.payloadVersion);
    const canonicalEventKey = `wecom-broadcast:${payload.notificationId}:${payload.publishGeneration}`;
    const root = await this.outbox.findByEventKey(canonicalEventKey);
    try {
      if (
        !rootId ||
        !root ||
        root.id !== rootId ||
        root.eventType !== OUTBOX_EVENT_WECOM_BROADCAST ||
        root.payloadVersion !== OUTBOX_ADMIN_PAYLOAD_VERSION ||
        root.eventKey !== canonicalEventKey ||
        root.aggregateType !== 'notification' ||
        root.aggregateId !== payload.notificationId ||
        root.destinationType !== 'broadcast' ||
        root.destinationRef !== payload.notificationId
      ) {
        throw new Error('wecom root identity mismatch');
      }
      assertStoredNotificationOutboxIntentSafe(root);
      const rootPayload = parseKnownNotificationOutboxPayload(
        root.eventType,
        root.payloadVersion,
        root.payload,
      ) as WecomBroadcastOutboxPayload;
      if (
        rootPayload.notificationId !== payload.notificationId ||
        rootPayload.publishGeneration !== payload.publishGeneration
      ) {
        throw new Error('wecom root payload mismatch');
      }
    } catch {
      throw new UnsupportedNotificationOutboxEventError(intent.eventType, intent.payloadVersion);
    }
  }

  /**
   * 终态记账:delivery 行的主键**就是** intent.id。
   *
   * 这把"这条 intent 已经有最终结论"变成一条数据库事实:重领同一条 intent 时,
   * `deliverWecom` 开头的 `findUnique({ id: intent.id })` 会命中并直接结束,
   * 于是崩溃重放不会重复发送。**只用于终态**(skipped / SENT / 确定性失败)。
   */
  private async recordWecomDeliveryOnce(
    id: string,
    input: {
      notificationId: string;
      memberId: string;
      recipientRef: string;
      status: string;
      reasonCode: string;
      errCode?: string;
      attemptedAt?: Date;
    },
  ): Promise<void> {
    await this.prisma.notificationDelivery.createMany({
      data: [{ id, channel: NOTIFICATION_CHANNEL_WECOM, ...input }],
      skipDuplicates: true,
    });
  }

  /**
   * **暂态**失败流水:自动主键,**绝不占用 intent.id**。
   *
   * ⚠️ 这条区分不是洁癖。暂态失败若也按 intent.id 落行,下一次重试一进 `deliverWecom`
   * 就会命中"本 intent 已记过账"而直接返回 —— 于是"退避重试 8 次"变成"第一次网络抖动
   * 即永久放弃",而且现场看起来一切正常(intent succeeded、delivery 有一行 failed)。
   * 微信侧对 transient 用的也是自动主键 `create`,这里保持同一取舍。
   */
  private async recordWecomTransientAttempt(input: {
    notificationId: string;
    memberId: string;
    recipientRef: string;
    reasonCode: string;
    errCode?: string;
  }): Promise<void> {
    await this.prisma.notificationDelivery.create({
      data: {
        notificationId: input.notificationId,
        channel: NOTIFICATION_CHANNEL_WECOM,
        memberId: input.memberId,
        recipientRef: input.recipientRef,
        status: DELIVERY_STATUS_FAILED,
        reasonCode: input.reasonCode,
        errCode: input.errCode ?? null,
        attemptedAt: new Date(),
      },
    });
  }

  private async deliverBirthdaySms(
    intent: ClaimedNotificationOutboxIntent,
    guard: NotificationOutboxEffectGuard,
  ): Promise<OutboxExecutionResult> {
    const payload = parsePayload<BirthdaySmsOutboxPayload>(intent);
    const user = await this.prisma.user.findFirst({
      where: notDeletedWhere({
        memberId: payload.memberId,
        status: UserStatus.ACTIVE,
        member: { status: MemberStatus.ACTIVE, deletedAt: null },
      }),
      select: { phone: true },
    });
    if (!user?.phone) return { effectPerformed: false };

    const dayStart = dateKeyStart(payload.dateKey);
    const alreadySent = await this.prisma.smsSendLog.count({
      where: {
        phone: user.phone,
        templateKey: SMS_TEMPLATE_KEY_BIRTHDAY,
        status: 'SENT',
        createdAt: { gte: dayStart, lt: new Date(dayStart.getTime() + 86_400_000) },
      },
    });
    if (alreadySent > 0) return { effectPerformed: false };

    const settings = await this.smsSettings.getActiveSettings();
    if (!settings || !settings.enabled || !settings.templateIdBirthday) {
      throw new SmsChannelUnavailableError('birthday 短信渠道未配置 / 未启用');
    }
    const prepared = await this.smsRouter.prepareBirthdayGreeting({ phone: user.phone });
    await guard.beforeEffect();
    let providerMsgId: string | null;
    try {
      const pending = prepared.invoke();
      ({ providerMsgId } = await pending);
    } catch (error) {
      const normalized = normalizeSmsError(error);
      await this.prisma.smsSendLog.create({
        data: {
          phone: user.phone,
          templateKey: SMS_TEMPLATE_KEY_BIRTHDAY,
          providerType: prepared.providerType,
          status: 'FAILED',
          errCode: normalized.errCode,
          errMsg: normalized.errMsg,
        },
      });
      throw error;
    }
    await this.prisma.smsSendLog.create({
      data: {
        phone: user.phone,
        templateKey: SMS_TEMPLATE_KEY_BIRTHDAY,
        providerType: prepared.providerType,
        status: 'SENT',
        providerMsgId,
      },
    });
    return { effectPerformed: true };
  }

  private async deliverAdminSms(
    intent: ClaimedNotificationOutboxIntent,
    guard: NotificationOutboxEffectGuard,
  ): Promise<OutboxExecutionResult> {
    const payload = parsePayload<AdminSmsOutboxPayload>(intent);
    if (intent.payloadVersion !== OUTBOX_ADMIN_PAYLOAD_VERSION) {
      throw new UnsupportedNotificationOutboxEventError(intent.eventType, intent.payloadVersion);
    }
    const notification = await this.outbox.authorizeAdminNotificationEffect(
      intent,
      payload.notificationId,
      payload.publishGeneration!,
      NOTIFICATION_CHANNEL_SMS,
    );
    if (!notification) {
      return { effectPerformed: false, value: { outcome: 'skipped' } };
    }
    const result = await this.smsDispatch.dispatchRecipient(
      notification,
      payload.memberId,
      guard.beforeEffect,
    );
    return {
      effectPerformed: result.outcome === 'sent',
      value: result,
    };
  }

  private async requireNotification(id: string): Promise<Notification> {
    const row = await this.prisma.notification.findFirst({ where: { id, deletedAt: null } });
    if (!row) throw new Error(`notification missing for outbox aggregate=${id}`);
    return row;
  }

  private async requireLegacySystemNotification(
    intent: ClaimedNotificationOutboxIntent,
    id: string,
    memberId: string,
  ): Promise<Notification> {
    const row = await this.prisma.notification.findUnique({ where: { id } });
    if (
      !row ||
      row.deletedAt !== null ||
      row.sourceType !== NOTIFICATION_SOURCE_SYSTEM ||
      row.statusCode !== NOTIFICATION_STATUS_PUBLISHED ||
      row.audienceType !== NOTIFICATION_AUDIENCE_DIRECTED ||
      row.recipientMemberId !== memberId ||
      !row.channels.includes(NOTIFICATION_CHANNEL_WECHAT)
    ) {
      throw new UnsupportedNotificationOutboxEventError(intent.eventType, intent.payloadVersion);
    }
    return row;
  }

  private async readAdminNotificationCandidate(
    id: string,
    publishGeneration: number,
  ): Promise<Notification | null> {
    const row = await this.prisma.notification.findUnique({ where: { id } });
    if (
      !row ||
      row.deletedAt !== null ||
      row.sourceType !== NOTIFICATION_SOURCE_ADMIN ||
      row.audienceType !== NOTIFICATION_AUDIENCE_BROADCAST ||
      row.statusCode !== NOTIFICATION_STATUS_PUBLISHED ||
      row.publishGeneration !== publishGeneration ||
      !row.channels.includes(NOTIFICATION_CHANNEL_WECHAT)
    ) {
      return null;
    }
    return row;
  }

  private async requireAdminWechatRoot(
    intent: ClaimedNotificationOutboxIntent,
    payload: WechatDeliveryOutboxPayload,
  ): Promise<void> {
    const rootId = extractWechatDeliveryRootId(intent.eventKey, intent.payloadVersion);
    const canonicalEventKey = `wechat-broadcast:${payload.notificationId}:${payload.publishGeneration}`;
    const root = await this.outbox.findByEventKey(canonicalEventKey);
    try {
      if (
        !rootId ||
        !root ||
        root.id !== rootId ||
        root.eventType !== OUTBOX_EVENT_WECHAT_BROADCAST ||
        root.payloadVersion !== OUTBOX_ADMIN_PAYLOAD_VERSION ||
        root.eventKey !== canonicalEventKey ||
        root.aggregateType !== 'notification' ||
        root.aggregateId !== payload.notificationId ||
        root.destinationType !== 'broadcast' ||
        root.destinationRef !== payload.notificationId
      ) {
        throw new Error('wechat root identity mismatch');
      }
      assertStoredNotificationOutboxIntentSafe(root);
      const rootPayload = parseKnownNotificationOutboxPayload(
        root.eventType,
        root.payloadVersion,
        root.payload,
      ) as WechatBroadcastOutboxPayload;
      if (
        rootPayload.notificationId !== payload.notificationId ||
        rootPayload.publishGeneration !== payload.publishGeneration
      ) {
        throw new Error('wechat root payload mismatch');
      }
    } catch {
      throw new UnsupportedNotificationOutboxEventError(intent.eventType, intent.payloadVersion);
    }
  }

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

  private async recordWechatDeliveryOnce(
    id: string,
    input: {
      notificationId: string;
      memberId: string;
      recipientRef: string;
      status: string;
      reasonCode: string;
    },
  ): Promise<void> {
    await this.prisma.notificationDelivery.createMany({
      data: [{ id, channel: NOTIFICATION_CHANNEL_WECHAT, ...input }],
      skipDuplicates: true,
    });
  }
}

function requireCompletePreparedTemplate(intent: NotificationOutboxIntent): string | null {
  if ((intent.preparedAt === null) !== (intent.preparedTemplateId === null)) {
    throw new UnsupportedNotificationOutboxEventError(intent.eventType, intent.payloadVersion);
  }
  return intent.preparedTemplateId;
}

function parsePayload<T>(intent: NotificationOutboxIntent): T {
  try {
    return parseKnownNotificationOutboxPayload(
      intent.eventType,
      intent.payloadVersion,
      intent.payload,
    ) as T;
  } catch (error) {
    if (!(error instanceof NotificationOutboxPayloadError)) throw error;
    throw new UnsupportedNotificationOutboxEventError(intent.eventType, intent.payloadVersion);
  }
}

function mapWechatError(errCode: string): string {
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

function isTransientWechatError(errCode: string): boolean {
  return (
    errCode === 'TOKEN_FAILED' ||
    errCode === 'CHANNEL_UNAVAILABLE' ||
    errCode === 'FETCH_ERROR' ||
    errCode === 'HTTP_ERROR' ||
    WECHAT_ERRCODE_TOKEN_INVALID.includes(Number(errCode))
  );
}

// 81013 = 企业微信"全部收件人无效"。单 touser 请求下它与 invaliduser 同义(§10.7 第 3 条)。
// 声明在本文件而不是 wecom.constants.ts:它是**投递语义**常量,只有 outbox 记账这一处消费,
// 而 wecom.constants 里那几组 errcode 是**通道语义**(重试策略)常量,两者不该混住。
const WECOM_ERRCODE_ALL_RECIPIENTS_INVALID = 81013;

/**
 * Provider **抛出**的域错误 → 与 `sendTextCard` 失败分支**逐字同形**的结果对象。
 *
 * 这个函数的存在本身就是 B7 的执行位:分类只在 Provider 里发生一次,这里只做搬运。
 * 上一版在 catch 里把一切压成 `TOKEN_FAILED`,等于把 Provider 刚做完的分类当场丢掉。
 *
 * 返回 `null` = 不是企业微信域错误(DB 异常 / 编程错 / lease 相关)⇒ 调用方原样冒泡。
 */
function normalizeWecomProviderError(
  error: unknown,
): { ok: false; kind: WecomErrorKind; errCode: string; errMsg: string } | null {
  if (error instanceof WecomApiError) {
    return { ok: false, kind: error.kind, errCode: error.errCode, errMsg: error.errCode };
  }
  if (error instanceof WecomChannelUnavailableError) {
    return {
      ok: false,
      kind: error.kind,
      errCode: 'CHANNEL_UNAVAILABLE',
      errMsg: 'CHANNEL_UNAVAILABLE',
    };
  }
  return null;
}

/**
 * 企业微信错误 kind → delivery reasonCode(§10.7)。
 *
 * **只认 kind,不看 errCode**(B7)。上一版按 errCode 字符串嗅探,两处当场失真:
 * `throwByErrcode(45009)` 抛的 errCode 是 `'RATE_LIMITED'` 而这里拿 `Number(errCode)` 比 45009
 * (⇒ NaN,限流被读成"其它上游失败");HTTP 4xx 与 5xx 共用 `'HTTP_ERROR'`(⇒ 4xx 被当暂态)。
 *
 * 与微信版 `mapWechatError` 刻意分开:两套 errcode 数值空间不同,合并成一个函数
 * 只需要一个数字巧合就能把"微信模板参数错"读成"企业微信限流"。
 */
function mapWecomSendError(kind: WecomErrorKind): string {
  switch (kind) {
    case WECOM_ERROR_KIND.RATE_LIMITED:
      return DELIVERY_REASON_RATE_LIMITED;
    case WECOM_ERROR_KIND.PROVIDER_CONTRACT:
    case WECOM_ERROR_KIND.HTTP_4XX:
      // HTTP 4xx 与 invalidparty/invalidtag 同类:发出去的请求本身就是坏的。
      return DELIVERY_REASON_PROVIDER_CONTRACT_ERROR;
    case WECOM_ERROR_KIND.TOKEN_INVALID:
      return DELIVERY_REASON_TOKEN_FAILED;
    case WECOM_ERROR_KIND.CHANNEL_DISABLED:
      return DELIVERY_REASON_CHANNEL_DISABLED;
    // 确定性配置 / 权限错误(Secret 错、agentid 错、IP 不在白名单…):重试解决不了,
    // 但它确实是"上游拒绝了这次调用",归 api-failed 而不是伪装成 token 问题。
    case WECOM_ERROR_KIND.CONFIG_FATAL:
    case WECOM_ERROR_KIND.INVALID_RESPONSE:
    case WECOM_ERROR_KIND.UPSTREAM_REJECTED:
    case WECOM_ERROR_KIND.NETWORK:
    case WECOM_ERROR_KIND.TIMEOUT:
    case WECOM_ERROR_KIND.HTTP_5XX:
    case WECOM_ERROR_KIND.SYSTEM_BUSY:
      return DELIVERY_REASON_API_FAILED;
  }
}

/**
 * 是否暂态(可退避重试)—— **闭集,只有这五种**(B7 / 评审原话:
 * Outbox 只对 network / timeout / 5xx / 明确允许的 token-invalid 退避)。
 *
 * `system-busy`(-1)也在内:那是**上游自己**说的"稍后再试",与 5xx 同类。
 *
 * ⚠️ `rate-limited` 不在,而且不能在:官方拦截窗口内重试只会延长拦截 ——
 * 它由 `TerminalNotificationProviderError` 直接送进 dead(§10.7 末段)。
 * `config-fatal` / `invalid-response` / `http-4xx` 同样不在:退避改变不了确定性错误。
 */
function isTransientWecomKind(kind: WecomErrorKind): boolean {
  return (
    kind === WECOM_ERROR_KIND.NETWORK ||
    kind === WECOM_ERROR_KIND.TIMEOUT ||
    kind === WECOM_ERROR_KIND.HTTP_5XX ||
    kind === WECOM_ERROR_KIND.SYSTEM_BUSY ||
    kind === WECOM_ERROR_KIND.TOKEN_INVALID
  );
}

/**
 * 是否终态 **dead**(等人工 replay),而不是终态 ack。
 *
 * 判别标准是"人能不能做点什么让它成功":限流等窗口过去再 replay 就成;
 * 请求契约错是 bug 信号,要人看一眼再决定。其余确定性失败(Secret 配错、回执畸形)
 * 没有可 replay 的余地,逐人记账后 ack 即可。
 */
function isTerminalDeadWecomKind(kind: WecomErrorKind): boolean {
  return (
    kind === WECOM_ERROR_KIND.RATE_LIMITED ||
    kind === WECOM_ERROR_KIND.PROVIDER_CONTRACT ||
    kind === WECOM_ERROR_KIND.HTTP_4XX
  );
}

function normalizeSmsError(error: unknown): { errCode: string; errMsg: string } {
  if (error instanceof SmsProviderSendError) {
    return { errCode: error.errCode, errMsg: error.errMsg };
  }
  if (error instanceof SmsChannelUnavailableError) {
    return { errCode: 'CHANNEL_UNAVAILABLE', errMsg: error.message };
  }
  return {
    errCode: 'UNKNOWN',
    errMsg: error instanceof Error ? error.name : typeof error,
  };
}

function dateKeyStart(dateKey: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    throw new Error('invalid birthday outbox dateKey');
  }
  return new Date(`${dateKey}T00:00:00.000+08:00`);
}
