import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import {
  NOTIFICATION_CHANNEL_IN_APP,
  NOTIFICATION_DIRECTED_VISIBILITY,
  NOTIFICATION_TYPE_ACTIVITY_CHANGED,
  NOTIFICATION_TYPE_ACTIVITY_PUBLISHED,
  NOTIFICATION_TYPE_REGISTRATION_RESULT,
  OUTBOX_EVENT_SYSTEM_BROADCAST,
  OUTBOX_EVENT_TARGETED_NOTIFICATION,
  OUTBOX_PAYLOAD_VERSION,
} from '../notifications/notification.constants';
import { NotificationOutboxService } from '../notifications/notification-outbox.service';
import type {
  FrozenBroadcastAudience,
  FrozenRecipientCohort,
  RecipientFreezeStamp,
} from './activity-recipient-freeze';

type PrismaTx = Prisma.TransactionClient;

interface ActivityScheduleSnapshot {
  startAt: Date;
  endAt: Date;
  location: string;
}

interface TargetedNotificationInput {
  eventKey: string;
  aggregateType: string;
  aggregateId: string;
  memberId: string;
  notificationTypeCode: string;
  title: string;
  body: string;
  /** 冻结快照头。**必填** —— 少盖一次章就等于少冻结一个事件,不能是可选项。 */
  freeze: RecipientFreezeStamp;
}

@Injectable()
export class ActivityNotificationProducer {
  constructor(private readonly outbox: NotificationOutboxService) {}

  async enqueueEmergencyCall(
    tx: PrismaTx,
    input: {
      activityId: string;
      initiationId: string;
      title: string;
      startAt: Date;
      endAt: Date;
      coarseLocation: string;
      cohort: FrozenRecipientCohort;
    },
  ): Promise<void> {
    await this.outbox.enqueueMany(
      input.cohort.memberIds.map((memberId) => ({
        eventKey: `activity-emergency:${input.initiationId}:${memberId}`,
        eventType: OUTBOX_EVENT_TARGETED_NOTIFICATION,
        payloadVersion: OUTBOX_PAYLOAD_VERSION,
        aggregateType: 'activity',
        aggregateId: input.activityId,
        destinationType: 'member',
        destinationRef: memberId,
        payload: {
          recipientMemberId: memberId,
          notificationTypeCode: 'emergency',
          title: '紧急呼叫（非正式发布）',
          body: `「${input.title}」紧急呼叫，预计时间 ${input.startAt.toISOString()} 至 ${input.endAt.toISOString()}，粗略地点 ${input.coarseLocation}。`,
          channels: [NOTIFICATION_CHANNEL_IN_APP],
          recipientFreeze: { ...input.cohort.stamp },
        },
      })),
      tx,
    );
  }

  /**
   * legacy 广播发布。收件人是「此刻能看见它的人」,没有集合可冻 —— 但**必须**带上
   * `ActivityRecipientFreezeService` 发的 `broadcast-visibility` 盖章:
   * 「这条不冻结」得是冻结入口做出的决定,不能是这里悄悄漏了。
   */
  async enqueuePublished(
    tx: PrismaTx,
    input: {
      activityId: string;
      activityTitle: string;
      publishedAt: Date;
      startAt: Date;
      location: string;
      requiresInsurance: boolean;
      isPublicRegistration: boolean;
      audience: FrozenBroadcastAudience;
    },
  ): Promise<void> {
    if (!input.isPublicRegistration) return;
    const insurance = input.requiresInsurance ? ' 本活动要求有效保险，请在报名前确认覆盖期。' : '';
    await this.outbox.enqueue(
      {
        eventKey: `activity-publish:${input.activityId}:${input.publishedAt.toISOString()}`,
        eventType: OUTBOX_EVENT_SYSTEM_BROADCAST,
        payloadVersion: OUTBOX_PAYLOAD_VERSION,
        payload: {
          notificationTypeCode: NOTIFICATION_TYPE_ACTIVITY_PUBLISHED,
          title: '新活动已发布',
          body: `「${input.activityTitle}」已发布，开始时间 ${input.startAt.toISOString()}，地点 ${input.location}。${insurance}`,
          visibilityCode: NOTIFICATION_DIRECTED_VISIBILITY,
          recipientFreeze: { ...input.audience.stamp },
        },
        aggregateType: 'activity',
        aggregateId: input.activityId,
        destinationType: 'visibility',
        destinationRef: NOTIFICATION_DIRECTED_VISIBILITY,
      },
      tx,
    );
  }

  // B7 定向发布：活动发布时把已锁定事务内的受众快照写成逐会员 durable intent，绝不回退为广播。
  async enqueuePublishedWithAudienceTags(
    tx: PrismaTx,
    input: {
      activityId: string;
      activityTitle: string;
      publishedAt: Date;
      startAt: Date;
      location: string;
      requiresInsurance: boolean;
      cohort: FrozenRecipientCohort;
    },
  ): Promise<void> {
    if (input.cohort.memberIds.length === 0) return;
    const insurance = input.requiresInsurance ? ' 本活动要求有效保险，请在报名前确认覆盖期。' : '';
    const body = `「${input.activityTitle}」已发布，开始时间 ${input.startAt.toISOString()}，地点 ${input.location}。${insurance}`;
    await this.outbox.enqueueMany(
      input.cohort.memberIds.map((memberId) => ({
        eventKey: `activity-publish-audience:${input.activityId}:${input.publishedAt.toISOString()}:${memberId}`,
        eventType: OUTBOX_EVENT_TARGETED_NOTIFICATION,
        payloadVersion: OUTBOX_PAYLOAD_VERSION,
        payload: {
          recipientMemberId: memberId,
          notificationTypeCode: NOTIFICATION_TYPE_ACTIVITY_PUBLISHED,
          title: '新活动已发布',
          body,
          channels: [NOTIFICATION_CHANNEL_IN_APP],
          recipientFreeze: { ...input.cohort.stamp },
        },
        aggregateType: 'activity',
        aggregateId: input.activityId,
        destinationType: 'member',
        destinationRef: memberId,
      })),
      tx,
    );
  }

  async enqueueCancellation(
    tx: PrismaTx,
    input: {
      activityId: string;
      activityTitle: string;
      cancelledAt: Date;
      cancelReason: string | null;
      cohort: FrozenRecipientCohort;
    },
  ): Promise<void> {
    const reasonSuffix = input.cancelReason ? ` 取消原因:${input.cancelReason}` : '';
    for (const memberId of input.cohort.memberIds) {
      await this.enqueueTargeted(tx, {
        eventKey: `activity-cancel:${input.activityId}:${input.cancelledAt.toISOString()}:${memberId}`,
        aggregateType: 'activity',
        aggregateId: input.activityId,
        memberId,
        notificationTypeCode: NOTIFICATION_TYPE_ACTIVITY_CHANGED,
        title: '活动已取消',
        body: `您报名的「${input.activityTitle}」已取消。${reasonSuffix}`,
        freeze: input.cohort.stamp,
      });
    }
  }

  /**
   * 单个场次被取消 → 只通知**报了这个场次**的人(维护者 2026-08-25 拍板)。
   *
   * 与 `enqueueCancellation`(整活动取消)刻意分开:那条的 `cohort` 是整活动名册,
   * 这条的 `cohort` 必须是**按场次收窄**的名册,冻结依据里带 `session:<id>` 以便事后对账。
   *
   * 走 `enqueueMany` 而不是逐人 `enqueue`:一个场次可能上千人,而本链路挂在发布审核那条
   * 事务上;逐条 await 会把审批拖出事务预算。
   */
  async enqueueSessionCancellation(
    tx: PrismaTx,
    input: {
      activityId: string;
      activityTitle: string;
      versionKey: string;
      sessionNames: readonly string[];
      cohort: FrozenRecipientCohort;
    },
  ): Promise<void> {
    if (input.cohort.memberIds.length === 0) return;
    const sessionLabel =
      input.sessionNames.length === 0 ? '' : `（${input.sessionNames.join('、')}）`;
    const body = `您报名的「${input.activityTitle}」中有场次${sessionLabel}已取消，该场次的报名已自动退出、签到二维码已作废。其他场次不受影响。`;
    await this.outbox.enqueueMany(
      input.cohort.memberIds.map((memberId) => ({
        eventKey: `activity-session-cancel:${input.activityId}:${input.versionKey}:${memberId}`,
        eventType: OUTBOX_EVENT_TARGETED_NOTIFICATION,
        payloadVersion: OUTBOX_PAYLOAD_VERSION,
        payload: {
          recipientMemberId: memberId,
          notificationTypeCode: NOTIFICATION_TYPE_ACTIVITY_CHANGED,
          title: '活动场次已取消',
          body,
          channels: [NOTIFICATION_CHANNEL_IN_APP],
          recipientFreeze: { ...input.cohort.stamp },
        },
        aggregateType: 'activity',
        aggregateId: input.activityId,
        destinationType: 'member',
        destinationRef: memberId,
      })),
      tx,
    );
  }

  async enqueueScheduleChange(
    tx: PrismaTx,
    input: {
      activityId: string;
      activityTitle: string;
      versionKey: string;
      before: ActivityScheduleSnapshot | null;
      after: ActivityScheduleSnapshot | null;
      requiresInsurance: boolean;
      cohort: FrozenRecipientCohort;
    },
  ): Promise<void> {
    const before = input.before;
    const after = input.after;
    const body =
      before === null || after === null
        ? `您报名的「${input.activityTitle}」已通过变更审核，请查看最新安排。`
        : this.scheduleChangeBody({
            activityTitle: input.activityTitle,
            before,
            after,
            requiresInsurance: input.requiresInsurance,
          });
    for (const memberId of input.cohort.memberIds) {
      await this.enqueueTargeted(tx, {
        eventKey: `activity-change:${input.activityId}:${input.versionKey}:${memberId}`,
        aggregateType: 'activity',
        aggregateId: input.activityId,
        memberId,
        notificationTypeCode: NOTIFICATION_TYPE_ACTIVITY_CHANGED,
        title: '活动安排已变更',
        body,
        freeze: input.cohort.stamp,
      });
    }
  }

  async enqueueWaitlistPromotions(
    tx: PrismaTx,
    input: {
      activityTitle: string;
      promoted: Array<{ registrationId: string; memberId: string }>;
      cohort: FrozenRecipientCohort;
    },
  ): Promise<void> {
    if (input.promoted.length === 0) return;
    const rows = await tx.activityRegistration.findMany({
      where: { id: { in: input.promoted.map((item) => item.registrationId) } },
      select: { id: true, updatedAt: true },
    });
    const updatedAtById = new Map(rows.map((row) => [row.id, row.updatedAt] as const));
    // 冻结集合是权威:递补名单在冻结之后又变长了,多出来的人**不发** ——
    // 否则这一批的实际收件人就成了两次计算的并集。
    const frozen = new Set(input.cohort.memberIds);
    for (const item of input.promoted.filter((candidate) => frozen.has(candidate.memberId))) {
      const promotedAt = updatedAtById.get(item.registrationId);
      if (!promotedAt) {
        throw new Error(`promoted registration disappeared: ${item.registrationId}`);
      }
      await this.enqueueTargeted(tx, {
        eventKey: `waitlist-promote:${item.registrationId}:${promotedAt.toISOString()}`,
        aggregateType: 'activity_registration',
        aggregateId: item.registrationId,
        memberId: item.memberId,
        notificationTypeCode: NOTIFICATION_TYPE_REGISTRATION_RESULT,
        title: '候补已递补',
        body: `您报名的「${input.activityTitle}」已从候补递补，现已进入待审核。`,
        freeze: input.cohort.stamp,
      });
    }
  }

  async enqueueReviewOutcome(
    tx: PrismaTx,
    input: {
      reviewId: string;
      activityId: string;
      activityTitle: string;
      reviewedAt: Date;
      cohort: FrozenRecipientCohort;
      approved: boolean;
      reviewNote?: string;
    },
  ): Promise<void> {
    const recipientMemberId = input.cohort.memberIds[0];
    if (recipientMemberId === undefined) return;
    await this.enqueueTargeted(tx, {
      eventKey: `activity-review-outcome:${input.reviewId}:${input.reviewedAt.toISOString()}`,
      aggregateType: 'activity_publish_review',
      aggregateId: input.reviewId,
      memberId: recipientMemberId,
      freeze: input.cohort.stamp,
      notificationTypeCode: 'general',
      title: input.approved ? '活动发布审核已通过' : '活动发布审核已退回',
      body: input.approved
        ? `「${input.activityTitle}」已通过发布审核。`
        : `「${input.activityTitle}」发布审核已退回。原因：${input.reviewNote ?? '未填写'}`,
    });
  }

  private scheduleChangeBody(input: {
    activityTitle: string;
    before: ActivityScheduleSnapshot;
    after: ActivityScheduleSnapshot;
    requiresInsurance: boolean;
  }): string {
    const changed: string[] = [];
    if (input.before.startAt.getTime() !== input.after.startAt.getTime()) {
      changed.push(
        `开始时间：${input.before.startAt.toISOString()} → ${input.after.startAt.toISOString()}`,
      );
    }
    if (input.before.endAt.getTime() !== input.after.endAt.getTime()) {
      changed.push(
        `结束时间：${input.before.endAt.toISOString()} → ${input.after.endAt.toISOString()}`,
      );
    }
    if (input.before.location !== input.after.location) {
      changed.push(`地点：${input.before.location} → ${input.after.location}`);
    }
    const insurance = input.requiresInsurance
      ? ' 保险覆盖按原日期核验，请按调整后的活动时段重新确认。'
      : '';
    return `您报名的「${input.activityTitle}」安排有变更：${changed.join('；')}。${insurance}`;
  }

  private async enqueueTargeted(tx: PrismaTx, input: TargetedNotificationInput): Promise<void> {
    await this.outbox.enqueue(
      {
        eventKey: input.eventKey,
        eventType: OUTBOX_EVENT_TARGETED_NOTIFICATION,
        payloadVersion: OUTBOX_PAYLOAD_VERSION,
        payload: {
          recipientMemberId: input.memberId,
          notificationTypeCode: input.notificationTypeCode,
          title: input.title,
          body: input.body,
          channels: [NOTIFICATION_CHANNEL_IN_APP],
          recipientFreeze: { ...input.freeze },
        },
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        destinationType: 'member',
        destinationRef: input.memberId,
      },
      tx,
    );
  }
}
