import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { MemberStatus, type Prisma } from '@prisma/client';
import { formatMemberLabel } from '../../common/identity/member-label.util';

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
type AllocationOutcome = 'allocated' | 'waitlisted' | 'not_selected';

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

interface CancellingMemberSnapshot {
  memberNo: string | null;
  realName: string | null;
  nickname: string | null;
}

// ⚠️ issue #1048 T1 **行为变更(用户可见)**:本函数原本自带一套人员标签格式
// `姓名（编号）`(全角括号、姓名在前),与全仓其它地方的 `编号 · 姓名` 不是同一个形状 ——
// 这正是 DoD 6「人员 label 全仓统一」要消灭的第二份格式。现改为委托统一实现。
// 通知正文里的这段文字会随之改变,是刻意的,不是回归。
export function formatCancellingMemberLabel(
  member: CancellingMemberSnapshot | null,
): string | null {
  const memberNo = member?.memberNo?.trim();
  const realName = member?.realName?.trim();
  if (!memberNo || !realName) return null;
  return formatMemberLabel({ memberNo, realName, nickname: member?.nickname ?? null });
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

  /**
   * Allocation results are durable intents written by the same root transaction that commits the
   * candidate, participation projection and capacity reservation.  The payload deliberately
   * contains no qualification explanation, score, draw seed or reservation identifier.
   */
  async enqueueAllocationOutcome(
    tx: PrismaTx,
    input: {
      allocationKey: string;
      participationIdentityId: string;
      registrationId: string;
      memberId: string;
      activityTitle: string;
      resultCode: AllocationOutcome;
    },
  ): Promise<void> {
    const result =
      input.resultCode === 'allocated'
        ? {
            title: '报名分配结果：已通过',
            body: `您报名的「${input.activityTitle}」已完成分配并通过。`,
          }
        : input.resultCode === 'waitlisted'
          ? {
              title: '报名分配结果：候补',
              body: `您报名的「${input.activityTitle}」暂未获得名额，已进入候补。`,
            }
          : {
              title: '报名分配结果：未入选',
              body: `您报名的「${input.activityTitle}」未通过本次分配。`,
            };
    await this.enqueueTargeted(tx, {
      eventKey: `allocation-outcome:${input.allocationKey}:${input.participationIdentityId}`,
      aggregateId: input.registrationId,
      memberId: input.memberId,
      notificationTypeCode: NOTIFICATION_TYPE_REGISTRATION_RESULT,
      title: result.title,
      body: result.body,
    });
  }

  /** A later promotion is distinct from the immutable batch's original waitlist outcome. */
  async enqueueAllocationPromotion(
    tx: PrismaTx,
    input: {
      promotionKey: string;
      participationIdentityId: string;
      registrationId: string;
      memberId: string;
      activityTitle: string;
    },
  ): Promise<void> {
    await this.enqueueTargeted(tx, {
      eventKey: `allocation-promotion:${input.promotionKey}:${input.participationIdentityId}`,
      aggregateId: input.registrationId,
      memberId: input.memberId,
      notificationTypeCode: NOTIFICATION_TYPE_REGISTRATION_RESULT,
      title: '候补已递补',
      body: `您报名的「${input.activityTitle}」已从候补递补并通过。`,
    });
  }

  async enqueueSelfCancellation(
    tx: PrismaTx,
    input: {
      registrationId: string;
      activityId: string;
      activityTitle: string;
      publisherMemberId: string | null;
      cancellingMember: CancellingMemberSnapshot | null;
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

    const memberLabel = formatCancellingMemberLabel(input.cancellingMember);
    const body = memberLabel
      ? `队员${memberLabel}已取消「${input.activityTitle}」报名${
          input.cancelReason ? `，原因：${input.cancelReason}` : ''
        }。`
      : `有队员已取消「${input.activityTitle}」报名，请查看活动报名列表。${
          input.cancelReason ? `原因：${input.cancelReason}。` : ''
        }`;
    await this.enqueueTargeted(tx, {
      eventKey: `registration-cancel:${input.registrationId}:${input.cancelledAt.toISOString()}`,
      aggregateId: input.registrationId,
      memberId: recipientMemberId,
      notificationTypeCode: NOTIFICATION_TYPE_ACTIVITY_CHANGED,
      title: '队员取消活动报名',
      body,
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
