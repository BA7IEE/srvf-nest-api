import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import {
  NOTIFICATION_CHANNEL_IN_APP,
  OUTBOX_EVENT_TARGETED_NOTIFICATION,
  OUTBOX_PAYLOAD_VERSION,
} from '../notifications/notification.constants';
import { NotificationOutboxService } from '../notifications/notification-outbox.service';

type PrismaTx = Prisma.TransactionClient;

interface ResponsibilityNotification {
  eventKey: string;
  assignmentId: string;
  memberId: string;
  title: string;
  body: string;
}

@Injectable()
export class ActivityResponsibilityNotificationProducer {
  constructor(private readonly outbox: NotificationOutboxService) {}

  enqueueCollaboratorAssigned(
    tx: PrismaTx,
    input: {
      assignmentId: string;
      memberId: string;
      activityTitle: string;
    },
  ): Promise<void> {
    return this.enqueueTargeted(tx, {
      eventKey: `responsibility-delegate:${input.assignmentId}`,
      assignmentId: input.assignmentId,
      memberId: input.memberId,
      title: '你已被指定为活动协办人',
      body: `你已成为「${input.activityTitle}」的活动协办人。`,
    });
  }

  enqueueCollaboratorEnded(
    tx: PrismaTx,
    input: {
      assignmentId: string;
      memberId: string;
      activityTitle: string;
      endedAt: Date;
    },
  ): Promise<void> {
    return this.enqueueTargeted(tx, {
      eventKey: `responsibility-delegate-end:${input.assignmentId}:${input.endedAt.toISOString()}`,
      assignmentId: input.assignmentId,
      memberId: input.memberId,
      title: '活动协办职责已结束',
      body: `你在「${input.activityTitle}」中的活动协办职责已结束。`,
    });
  }

  async enqueueOwnerTransferred(
    tx: PrismaTx,
    input: {
      assignmentId: string;
      oldOwnerMemberId: string;
      newOwnerMemberId: string;
      activityTitle: string;
    },
  ): Promise<void> {
    await this.enqueueTargeted(tx, {
      eventKey: `responsibility-transfer:${input.assignmentId}:previous`,
      assignmentId: input.assignmentId,
      memberId: input.oldOwnerMemberId,
      title: '活动负责人已移交',
      body: `你已不再是「${input.activityTitle}」的活动负责人。`,
    });
    await this.enqueueTargeted(tx, {
      eventKey: `responsibility-transfer:${input.assignmentId}:current`,
      assignmentId: input.assignmentId,
      memberId: input.newOwnerMemberId,
      title: '你已成为活动负责人',
      body: `你已成为「${input.activityTitle}」的活动负责人。`,
    });
  }

  private async enqueueTargeted(tx: PrismaTx, input: ResponsibilityNotification): Promise<void> {
    await this.outbox.enqueue(
      {
        eventKey: input.eventKey,
        eventType: OUTBOX_EVENT_TARGETED_NOTIFICATION,
        payloadVersion: OUTBOX_PAYLOAD_VERSION,
        payload: {
          recipientMemberId: input.memberId,
          notificationTypeCode: 'general',
          title: input.title,
          body: input.body,
          channels: [NOTIFICATION_CHANNEL_IN_APP],
        },
        aggregateType: 'activity_responsibility_assignment',
        aggregateId: input.assignmentId,
        destinationType: 'member',
        destinationRef: input.memberId,
      },
      tx,
    );
  }
}
