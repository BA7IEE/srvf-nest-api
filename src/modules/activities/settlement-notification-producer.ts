import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import {
  NOTIFICATION_CHANNEL_IN_APP,
  NOTIFICATION_TYPE_ATTENDANCE_RESULT,
  OUTBOX_EVENT_TARGETED_NOTIFICATION,
  OUTBOX_PAYLOAD_VERSION,
} from '../notifications/notification.constants';
import { NotificationOutboxService } from '../notifications/notification-outbox.service';

// 结算提交通知 intent(合同 §5.10 ⑨)。
//
// 🔴 **本仓 Outbox 铁律**:producer 在**业务事务内**同写 intent,provider 在事务外
//    至少一次投递。❌ 不得 commit 后直调 —— 那会让"业务成功但通知丢了"变成
//    一个没人知道的静默分叉。故本类的每个方法都强制收 `tx`,拿不到事务就编译不过。
//
// ## 收件人取谁
//
// 一审人/终审人的解析规则是 **§5.11** 的事(含"提交人/一审人/终审人分离"这条硬
// 不变量),本刀**不发明审核人解析**。此刻唯一确定且确实该被惊动的人是
// **活动当前 active owner**(`ActivityResponsibilityAssignment.responsibilityType='owner'`)
// —— 结算账目的责任人。
//
// ⚠️ 没有 active owner 时**跳过 enqueue,不拒绝提交**:通知缺席从来不该把一次
//    合法的结算提交挡回去,而"活动没有在任 owner"是先于本刀存在的数据形态。
//    这是**有意的降级**,已在报告里列明。
//
// ⚠️ 通知类型复用既有 `attendance-result`,**不新增 notification_type 字典项**
//    (新增字典项要动 seed,属本刀写集之外)。
@Injectable()
export class SettlementNotificationProducer {
  constructor(private readonly outbox: NotificationOutboxService) {}

  /**
   * 结算版本已提交、进入一审待办。
   *
   * `eventKey` 用 `settlementVersionId` 做稳定键:同一个版本无论被重放多少次,
   * outbox 只会有一条 intent(重放路径本就不该再惊动一次收件人)。
   */
  async enqueueSubmitted(
    tx: Prisma.TransactionClient,
    input: {
      activityId: string;
      activityTitle: string;
      settlementVersionId: string;
      settlementVersion: number;
      personCount: number;
      ownerMemberId: string | null;
    },
  ): Promise<void> {
    if (input.ownerMemberId === null) return;
    await this.outbox.enqueue(
      {
        eventKey: `settlement-submit:${input.settlementVersionId}`,
        eventType: OUTBOX_EVENT_TARGETED_NOTIFICATION,
        payloadVersion: OUTBOX_PAYLOAD_VERSION,
        payload: {
          recipientMemberId: input.ownerMemberId,
          notificationTypeCode: NOTIFICATION_TYPE_ATTENDANCE_RESULT,
          title: '结算版本已提交送审',
          body: `「${input.activityTitle}」第 ${input.settlementVersion} 版结算已提交,共 ${input.personCount} 人,等待一审。提交后草稿不再是审核依据,如需修改请等待退回。`,
          channels: [NOTIFICATION_CHANNEL_IN_APP],
        },
        aggregateType: 'activity',
        aggregateId: input.activityId,
        destinationType: 'member',
        destinationRef: input.ownerMemberId,
      },
      tx,
    );
  }
}
