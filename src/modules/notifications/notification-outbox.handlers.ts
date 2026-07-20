import { Injectable } from '@nestjs/common';
import {
  MemberStatus,
  type Notification,
  type NotificationOutboxIntent,
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
  NOTIFICATION_AUDIENCE_BROADCAST,
  NOTIFICATION_AUDIENCE_DIRECTED,
  NOTIFICATION_CHANNEL_IN_APP,
  NOTIFICATION_CHANNEL_SMS,
  NOTIFICATION_CHANNEL_WECHAT,
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
  OUTBOX_PAYLOAD_VERSION,
  WECHAT_SUBSCRIPTION_QUOTA_CAP,
} from './notification.constants';
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
} from './notification-outbox.types';
import {
  assertStoredNotificationOutboxIntentSafe,
  extractWechatDeliveryRootId,
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
