import type { Prisma } from '@prisma/client';

import {
  NOTIFICATION_CHANNEL_IN_APP,
  NOTIFICATION_TYPE_RECRUITMENT,
  OUTBOX_EVENT_TARGETED_NOTIFICATION,
  OUTBOX_PAYLOAD_VERSION,
} from '../notifications/notification.constants';
import type { NotificationOutboxEnqueueInput } from '../notifications/notification-outbox.types';
import { CONTRIBUTION_THRESHOLD } from './team-join.constants';

/**
 * Build the existing one-per-application milestone intent when a committed net crosses the
 * threshold. This function does not read the ledger or enqueue anything: the caller must obtain
 * both snapshots and enqueue the returned intent in the same locked transaction as the posting.
 * The fixed application/threshold key deduplicates reversals and re-crossings only while the
 * outbox row is retained. The retention SOP permits deleting terminal rows; a caller must provide
 * a durable deduplication decision across that boundary before enabling this notification.
 */
export function contributionMilestoneIntent(input: {
  applicationId: string;
  memberId: string;
  beforePoints: Prisma.Decimal;
  afterPoints: Prisma.Decimal;
}): NotificationOutboxEnqueueInput | null {
  if (!input.beforePoints.isFinite() || !input.afterPoints.isFinite()) {
    throw new Error('Contribution milestone requires finite ledger totals');
  }
  if (
    input.beforePoints.gte(CONTRIBUTION_THRESHOLD) ||
    input.afterPoints.lt(CONTRIBUTION_THRESHOLD)
  ) {
    return null;
  }

  const threshold = CONTRIBUTION_THRESHOLD.toString();
  return {
    eventKey: `team-join-contribution-met:${input.applicationId}:${threshold}`,
    eventType: OUTBOX_EVENT_TARGETED_NOTIFICATION,
    payloadVersion: OUTBOX_PAYLOAD_VERSION,
    payload: {
      recipientMemberId: input.memberId,
      notificationTypeCode: NOTIFICATION_TYPE_RECRUITMENT,
      title: '入队贡献值已达标',
      body: `您的贡献值已达到入队要求（${threshold} 分）。管理员核对其他门槛后将安排综合评估，请留意后续通知。`,
      channels: [NOTIFICATION_CHANNEL_IN_APP],
    },
    aggregateType: 'team_join_application',
    aggregateId: input.applicationId,
    destinationType: 'member',
    destinationRef: input.memberId,
  };
}
