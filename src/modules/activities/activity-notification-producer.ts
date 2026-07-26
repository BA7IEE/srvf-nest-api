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
}

@Injectable()
export class ActivityNotificationProducer {
  constructor(private readonly outbox: NotificationOutboxService) {}

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
        },
        aggregateType: 'activity',
        aggregateId: input.activityId,
        destinationType: 'visibility',
        destinationRef: NOTIFICATION_DIRECTED_VISIBILITY,
      },
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
      memberIds: string[];
    },
  ): Promise<void> {
    const reasonSuffix = input.cancelReason ? ` 取消原因:${input.cancelReason}` : '';
    for (const memberId of input.memberIds) {
      await this.enqueueTargeted(tx, {
        eventKey: `activity-cancel:${input.activityId}:${input.cancelledAt.toISOString()}:${memberId}`,
        aggregateType: 'activity',
        aggregateId: input.activityId,
        memberId,
        notificationTypeCode: NOTIFICATION_TYPE_ACTIVITY_CHANGED,
        title: '活动已取消',
        body: `您报名的「${input.activityTitle}」已取消。${reasonSuffix}`,
      });
    }
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
      memberIds: string[];
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
    for (const memberId of input.memberIds) {
      await this.enqueueTargeted(tx, {
        eventKey: `activity-change:${input.activityId}:${input.versionKey}:${memberId}`,
        aggregateType: 'activity',
        aggregateId: input.activityId,
        memberId,
        notificationTypeCode: NOTIFICATION_TYPE_ACTIVITY_CHANGED,
        title: '活动安排已变更',
        body,
      });
    }
  }

  async enqueueWaitlistPromotions(
    tx: PrismaTx,
    input: {
      activityTitle: string;
      promoted: Array<{ registrationId: string; memberId: string }>;
    },
  ): Promise<void> {
    if (input.promoted.length === 0) return;
    const rows = await tx.activityRegistration.findMany({
      where: { id: { in: input.promoted.map((item) => item.registrationId) } },
      select: { id: true, updatedAt: true },
    });
    const updatedAtById = new Map(rows.map((row) => [row.id, row.updatedAt] as const));
    for (const item of input.promoted) {
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
      recipientMemberId: string | null;
      approved: boolean;
      reviewNote?: string;
    },
  ): Promise<void> {
    if (input.recipientMemberId === null) return;
    await this.enqueueTargeted(tx, {
      eventKey: `activity-review-outcome:${input.reviewId}:${input.reviewedAt.toISOString()}`,
      aggregateType: 'activity_publish_review',
      aggregateId: input.reviewId,
      memberId: input.recipientMemberId,
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
