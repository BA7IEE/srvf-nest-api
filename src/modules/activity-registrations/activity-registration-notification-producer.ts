import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { MemberStatus, type Prisma } from '@prisma/client';

import appConfig from '../../config/app.config';
import {
  NOTIFICATION_CHANNEL_IN_APP,
  NOTIFICATION_TYPE_ACTIVITY_CHANGED,
  NOTIFICATION_TYPE_REGISTRATION_RESULT,
  OUTBOX_EVENT_TARGETED_NOTIFICATION,
  OUTBOX_PAYLOAD_VERSION,
} from '../notifications/notification.constants';
import { NotificationOutboxService } from '../notifications/notification-outbox.service';

type PrismaTx = Prisma.TransactionClient;
type ReviewOutcome = 'approved' | 'rejected';

export type SelfCancellationRecipientResolution =
  | 'active-owner'
  | 'legacy-publisher'
  | 'missing-active-owner'
  | 'missing-legacy-publisher';

interface TargetedNotificationInput {
  eventKey: string;
  aggregateId: string;
  memberId: string;
  notificationTypeCode: string;
  title: string;
  body: string;
}

@Injectable()
export class ActivityRegistrationNotificationProducer {
  constructor(
    private readonly outbox: NotificationOutboxService,
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
  ) {}

  async enqueueReview(
    tx: PrismaTx,
    input: {
      registrationId: string;
      activityId: string;
      memberId: string;
      reviewedAt: Date;
      outcome: ReviewOutcome;
      reviewNote: string | null;
    },
  ): Promise<void> {
    const activity = await tx.activity.findUnique({
      where: { id: input.activityId },
      select: { title: true },
    });
    const reviewVersion = await tx.auditLog.count({
      where: { resourceId: input.registrationId, event: 'registration.review' },
    });
    const passed = input.outcome === 'approved';
    const reasonSuffix = input.reviewNote ? ` 理由:${input.reviewNote}` : '';
    await this.enqueueTargeted(tx, {
      eventKey: `registration-review:${input.registrationId}:${input.reviewedAt.toISOString()}:${reviewVersion}`,
      aggregateId: input.registrationId,
      memberId: input.memberId,
      notificationTypeCode: NOTIFICATION_TYPE_REGISTRATION_RESULT,
      title: passed ? '报名已通过' : '报名未通过',
      body: passed
        ? `您报名的「${activity?.title ?? '活动'}」已通过审核。${reasonSuffix}`
        : `您报名的「${activity?.title ?? '活动'}」未通过审核。${reasonSuffix}`,
    });
  }

  async enqueueWaitlistPromotions(
    tx: PrismaTx,
    input: {
      activityTitle: string;
      promoted: Array<{ registrationId: string; memberId: string }>;
    },
  ): Promise<void> {
    if (input.promoted.length === 0) return;
    const promotedRows = await tx.activityRegistration.findMany({
      where: { id: { in: input.promoted.map((item) => item.registrationId) } },
      select: { id: true, updatedAt: true },
    });
    const updatedAtByRegistrationId = new Map(
      promotedRows.map((row) => [row.id, row.updatedAt] as const),
    );
    for (const item of input.promoted) {
      const promotedAt = updatedAtByRegistrationId.get(item.registrationId);
      if (!promotedAt) {
        throw new Error(`promoted registration disappeared: ${item.registrationId}`);
      }
      await this.enqueueTargeted(tx, {
        eventKey: `waitlist-promote:${item.registrationId}:${promotedAt.toISOString()}`,
        aggregateId: item.registrationId,
        memberId: item.memberId,
        notificationTypeCode: NOTIFICATION_TYPE_REGISTRATION_RESULT,
        title: '候补已递补',
        body: `您报名的「${input.activityTitle}」已从候补递补，现已进入待审核。`,
      });
    }
  }

  async enqueueSelfCancellation(
    tx: PrismaTx,
    input: {
      registrationId: string;
      activityId: string;
      activityTitle: string;
      publisherMemberId: string | null;
      cancellingMemberId: string;
      cancelledAt: Date;
      cancelReason: string | null;
    },
  ): Promise<SelfCancellationRecipientResolution> {
    const workflowEnabled = this.config.activityResponsibilityWorkflow.enabled;
    let recipientMemberId: string | null;
    let resolution: SelfCancellationRecipientResolution;
    if (workflowEnabled) {
      const now = new Date();
      const owner = await tx.activityResponsibilityAssignment.findFirst({
        where: {
          activityId: input.activityId,
          responsibilityType: 'owner',
          status: 'active',
          startedAt: { lte: now },
          endedAt: null,
          member: { status: MemberStatus.ACTIVE, deletedAt: null },
        },
        select: { memberId: true },
      });
      recipientMemberId = owner?.memberId ?? null;
      resolution = recipientMemberId === null ? 'missing-active-owner' : 'active-owner';
    } else {
      recipientMemberId = input.publisherMemberId;
      resolution = recipientMemberId === null ? 'missing-legacy-publisher' : 'legacy-publisher';
    }
    if (recipientMemberId === null) return resolution;

    const reason = input.cancelReason ? `，原因：${input.cancelReason}` : '';
    await this.enqueueTargeted(tx, {
      eventKey: `registration-cancel:${input.registrationId}:${input.cancelledAt.toISOString()}`,
      aggregateId: input.registrationId,
      memberId: recipientMemberId,
      notificationTypeCode: NOTIFICATION_TYPE_ACTIVITY_CHANGED,
      title: '队员取消活动报名',
      body: `队员 ${input.cancellingMemberId} 已取消「${input.activityTitle}」报名${reason}。`,
    });
    return resolution;
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
        aggregateType: 'activity_registration',
        aggregateId: input.aggregateId,
        destinationType: 'member',
        destinationRef: input.memberId,
      },
      tx,
    );
  }
}
