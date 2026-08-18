import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import {
  NOTIFICATION_CHANNEL_IN_APP,
  NOTIFICATION_TYPE_ATTENDANCE_RESULT,
  OUTBOX_EVENT_TARGETED_NOTIFICATION,
  OUTBOX_PAYLOAD_VERSION,
} from '../notifications/notification.constants';
import { NotificationOutboxService } from '../notifications/notification-outbox.service';
import type { FrozenRecipientCohort } from './activity-recipient-freeze';

// 机器关账后的「评价开放」intent(合同 §5.15 ⑪)。
//
// 🔴 **本仓 Outbox 铁律**:producer 在**业务事务内**同写 intent,provider 在事务外
//    至少一次投递。❌ 不得 commit 后直调 —— 那会让"关账成功但通知丢了"变成一个
//    没人知道的静默分叉。故本方法强制收 `tx`,拿不到事务就编译不过。
//    判据:e2e 让 enqueue 之后的一步(audit)抛错,断言 intent 与 closure 一起回滚。
//
// ## ⚠️ 为什么只发**一条**给负责人,而不是逐人 fan-out
//
// §5.15 ⑪ 原文是「写 Audit 和评价开放 intent」(单数)。逐人展开在本刀会有两个问题:
//   ① **规模**:万人活动 = 一万条 intent 塞进一个语义像钱的短事务里(合同 §0.4 死线
//      正是"万人任务不许把事务撑爆");
//   ② §3.27 已经为此定义了 `notification_expand` 作业类型 —— 逐人展开是**它**的职责。
// ⇒ 本刀发一条给当前 active owner(与前五刀收件人逐字同口径),逐人展开留给
//    第 ⑧ 刀接线 worker 之后。这是与合同的**显式偏离**,已在报告逐条列明。
//
// 🔴 **并且本刀刻意不创建那条 `notification_expand` job**:关账的第 ③ 类检查把
//    "未完成 job"算作缺口,而第 ⑧ 刀之前没有任何进程注册 `ActivityBatchWorker`
//    ⇒ 关账自己造出来的 job 永远不会完成,会把**更正后重新关账**永久堵死。
//    (这条已写进报告,作为第 ⑧ 刀的必读约束。)
//
// ⚠️ 没有 active owner 时**跳过 enqueue,不拒绝关账**:通知缺席从来不该把一场已经
//    算清楚的账挡回去,而"活动没有在任 owner"是先于本刀存在的数据形态 ——
//    与前五刀同一处置(有意的降级,已列明)。
//
// ⚠️ 通知类型复用既有 `attendance-result`,**不新增 notification_type 字典项**
//    (新增字典项要动 seed,属本刀写集之外)。
@Injectable()
export class ActivityClosureNotificationProducer {
  constructor(private readonly outbox: NotificationOutboxService) {}

  /**
   * 活动结算已正式关闭,评价窗口开放(§5.15 ⑪)。
   *
   * `eventKey` 用 `activityId + closureRevision` 做稳定键 —— 与「一活动至多一个 active
   * closure」**同粒度**:同一版关闭无论被重放多少次,outbox 只会有一条 intent;而
   * 更正后重新关账(revision+1)是**另一件该通知的事**,不会被上一版挤掉。
   * 粒度写粗(只用 activityId)恰好会吞掉重新关账那一条。
   */
  async enqueueClosed(
    tx: Prisma.TransactionClient,
    input: {
      activityId: string;
      activityTitle: string;
      closureRevision: number;
      settlementVersion: number;
      personCount: number;
      serviceHours: string;
      contributionPoints: string;
      archiveWaitingUntil: Date;
      cohort: FrozenRecipientCohort;
    },
  ): Promise<void> {
    const ownerMemberId = input.cohort.memberIds[0];
    if (ownerMemberId === undefined) return;
    const waitingUntil = input.archiveWaitingUntil.toISOString().slice(0, 10);
    await this.outbox.enqueue(
      {
        eventKey: `settlement-closure:${input.activityId}:${input.closureRevision}`,
        eventType: OUTBOX_EVENT_TARGETED_NOTIFICATION,
        payloadVersion: OUTBOX_PAYLOAD_VERSION,
        payload: {
          recipientMemberId: ownerMemberId,
          notificationTypeCode: NOTIFICATION_TYPE_ATTENDANCE_RESULT,
          title: '活动结算已关闭,评价已开放',
          body:
            `「${input.activityTitle}」第 ${input.settlementVersion} 版结算已通过全部关账检查并正式关闭` +
            `(关闭版本 ${input.closureRevision}),共 ${input.personCount} 名队员、` +
            `${input.serviceHours} 服务小时、${input.contributionPoints} 贡献值。` +
            `参与队员的评价入口已开放;资料归档等待期至 ${waitingUntil},` +
            `此后如仍需订正,请走更正申请流程。`,
          channels: [NOTIFICATION_CHANNEL_IN_APP],
          recipientFreeze: { ...input.cohort.stamp },
        },
        aggregateType: 'activity',
        aggregateId: input.activityId,
        destinationType: 'member',
        destinationRef: ownerMemberId,
      },
      tx,
    );
  }
}
