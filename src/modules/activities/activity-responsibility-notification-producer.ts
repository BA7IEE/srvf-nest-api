import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import {
  NOTIFICATION_CHANNEL_IN_APP,
  OUTBOX_EVENT_TARGETED_NOTIFICATION,
  OUTBOX_PAYLOAD_VERSION,
} from '../notifications/notification.constants';
import { NotificationOutboxService } from '../notifications/notification-outbox.service';
import type { FrozenRecipientCohort, RecipientFreezeStamp } from './activity-recipient-freeze';

type PrismaTx = Prisma.TransactionClient;

interface ResponsibilityNotification {
  eventKey: string;
  assignmentId: string;
  memberId: string;
  title: string;
  body: string;
  /** 冻结快照头。**必填** —— 少盖一次章就等于少冻结一个事件。 */
  freeze: RecipientFreezeStamp;
}

@Injectable()
export class ActivityResponsibilityNotificationProducer {
  constructor(private readonly outbox: NotificationOutboxService) {}

  async enqueueCollaboratorAssigned(
    tx: PrismaTx,
    input: {
      assignmentId: string;
      activityTitle: string;
      cohort: FrozenRecipientCohort;
    },
  ): Promise<void> {
    const memberId = input.cohort.memberIds[0];
    if (memberId === undefined) return;
    await this.enqueueTargeted(tx, {
      eventKey: `responsibility-delegate:${input.assignmentId}`,
      assignmentId: input.assignmentId,
      memberId,
      title: '你已被指定为活动协办人',
      body: `你已成为「${input.activityTitle}」的活动协办人。`,
      freeze: input.cohort.stamp,
    });
  }

  async enqueueCollaboratorEnded(
    tx: PrismaTx,
    input: {
      assignmentId: string;
      activityTitle: string;
      endedAt: Date;
      cohort: FrozenRecipientCohort;
    },
  ): Promise<void> {
    const memberId = input.cohort.memberIds[0];
    if (memberId === undefined) return;
    await this.enqueueTargeted(tx, {
      eventKey: `responsibility-delegate-end:${input.assignmentId}:${input.endedAt.toISOString()}`,
      assignmentId: input.assignmentId,
      memberId,
      title: '活动协办职责已结束',
      body: `你在「${input.activityTitle}」中的活动协办职责已结束。`,
      freeze: input.cohort.stamp,
    });
  }

  /**
   * owner 移交:旧、新两位各发一条。
   *
   * ⚠️ 两条**共用同一个冻结批次**(`cohort.memberIds` 恒为 `[旧, 新]` 排序后的两人),
   * 但收件人不能从 `memberIds[0]/[1]` 取 —— 排序后谁在前取决于 cuid 大小,
   * 拿错就把两条通知的正文发反了。所以这里显式收 `oldOwnerMemberId` / `newOwnerMemberId`,
   * 再断言两人都在冻结批次里:**冻结管的是「有没有被换掉」,不是「谁排第一」。**
   */
  async enqueueOwnerTransferred(
    tx: PrismaTx,
    input: {
      assignmentId: string;
      oldOwnerMemberId: string;
      newOwnerMemberId: string;
      activityTitle: string;
      cohort: FrozenRecipientCohort;
    },
  ): Promise<void> {
    const frozen = new Set(input.cohort.memberIds);
    if (!frozen.has(input.oldOwnerMemberId) || !frozen.has(input.newOwnerMemberId)) return;
    await this.enqueueTargeted(tx, {
      eventKey: `responsibility-transfer:${input.assignmentId}:previous`,
      assignmentId: input.assignmentId,
      memberId: input.oldOwnerMemberId,
      title: '活动负责人已移交',
      body: `你已不再是「${input.activityTitle}」的活动负责人。`,
      freeze: input.cohort.stamp,
    });
    await this.enqueueTargeted(tx, {
      eventKey: `responsibility-transfer:${input.assignmentId}:current`,
      assignmentId: input.assignmentId,
      memberId: input.newOwnerMemberId,
      title: '你已成为活动负责人',
      body: `你已成为「${input.activityTitle}」的活动负责人。`,
      freeze: input.cohort.stamp,
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
          recipientFreeze: { ...input.freeze },
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
