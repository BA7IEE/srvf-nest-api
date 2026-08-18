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

// 结算提交通知 intent(合同 §5.10 ⑨)+ 一审 / 终审结果通知 intent(合同 §5.11)。
//
// 🔴 **本仓 Outbox 铁律**:producer 在**业务事务内**同写 intent,provider 在事务外
//    至少一次投递。❌ 不得 commit 后直调 —— 那会让"业务成功但通知丢了"变成
//    一个没人知道的静默分叉。故本类的每个方法都强制收 `tx`,拿不到事务就编译不过。
//
// ## 收件人取谁
//
// 三个方法的收件人口径**完全一致**:活动当前 active owner
// (`ActivityResponsibilityAssignment.responsibilityType='owner'`)—— 结算账目的责任人。
// 审核结果(通过/退回)要惊动的正是他:退回意味着他得重做,通过意味着他可以等入账。
//
// ⚠️ 审核人自己**不**收通知(他刚刚就是操作人),也**不**向"下一阶段审核人"推送 ——
//    §5.11 没有给出审核人解析规则(谁有资格一审/终审由权限码决定,而本刀零权限码),
//    本刀**不发明审核人解析**。下一阶段待办的机器落点是 `run.statusCode`
//    (§3.19 明写它「是页面投影和流程根」),与第三刀 `pending_first_review` 同一处置。
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
      cohort: FrozenRecipientCohort;
    },
  ): Promise<void> {
    const ownerMemberId = input.cohort.memberIds[0];
    if (ownerMemberId === undefined) return;
    await this.outbox.enqueue(
      {
        eventKey: `settlement-submit:${input.settlementVersionId}`,
        eventType: OUTBOX_EVENT_TARGETED_NOTIFICATION,
        payloadVersion: OUTBOX_PAYLOAD_VERSION,
        payload: {
          recipientMemberId: ownerMemberId,
          notificationTypeCode: NOTIFICATION_TYPE_ATTENDANCE_RESULT,
          title: '结算版本已提交送审',
          body: `「${input.activityTitle}」第 ${input.settlementVersion} 版结算已提交,共 ${input.personCount} 人,等待一审。提交后草稿不再是审核依据,如需修改请等待退回。`,
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

  /**
   * 一审 / 终审有了生效决定(合同 §5.11)。
   *
   * `eventKey` 用 `settlementVersionId + stage` 做稳定键 —— 与 §3.19「一版本一阶段
   * 只允许一个生效决定」**同一粒度**:同一版本同一阶段无论被重放多少次,outbox 里
   * 只会有一条 intent。粒度写粗(只用 versionId)会让终审通知被一审那条挤掉。
   */
  async enqueueReviewed(
    tx: Prisma.TransactionClient,
    input: {
      activityId: string;
      activityTitle: string;
      settlementVersionId: string;
      settlementVersion: number;
      stageCode: 'first' | 'final';
      actionCode: 'approve' | 'return';
      returnReason: string | null;
      cohort: FrozenRecipientCohort;
    },
  ): Promise<void> {
    const ownerMemberId = input.cohort.memberIds[0];
    if (ownerMemberId === undefined) return;
    const stageLabel = input.stageCode === 'first' ? '一审' : '终审';
    const title =
      input.actionCode === 'approve' ? `结算${stageLabel}已通过` : `结算${stageLabel}已退回`;
    const body =
      input.actionCode === 'approve'
        ? input.stageCode === 'first'
          ? `「${input.activityTitle}」第 ${input.settlementVersion} 版结算一审通过,已进入终审。`
          : `「${input.activityTitle}」第 ${input.settlementVersion} 版结算终审通过,账本发布批次已开始准备;入账完成后另行通知。`
        : `「${input.activityTitle}」第 ${input.settlementVersion} 版结算被${stageLabel}退回,原因:${input.returnReason ?? '未填写'}。请修改后重新生成草稿并提交。`;

    await this.outbox.enqueue(
      {
        eventKey: `settlement-review:${input.settlementVersionId}:${input.stageCode}`,
        eventType: OUTBOX_EVENT_TARGETED_NOTIFICATION,
        payloadVersion: OUTBOX_PAYLOAD_VERSION,
        payload: {
          recipientMemberId: ownerMemberId,
          notificationTypeCode: NOTIFICATION_TYPE_ATTENDANCE_RESULT,
          title,
          body,
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

  /**
   * 账本批次已统一生效、结算入账完成(合同 §5.13 ⑦)。
   *
   * `eventKey` 用 `postingBatchId` 做稳定键 —— 与「一个版本至多一个 committed 批次」
   * 同粒度。重放 `commitBatch`(批次已 committed)走的是不 enqueue 的那条路,
   * 这里再多一道:即便有人绕过重放路径再调一次,outbox 也只会有一条 intent。
   *
   * ⚠️ 收件人与本类另外两个方法逐字同口径(当前 active owner),
   *    没有 active owner 时**跳过 enqueue,不拒绝入账** —— 通知缺席不该把一笔
   *    已经算清楚的账挡回去。
   */
  async enqueuePosted(
    tx: Prisma.TransactionClient,
    input: {
      activityId: string;
      activityTitle: string;
      settlementVersionId: string;
      settlementVersion: number;
      postingBatchId: string;
      memberCount: number;
      cohort: FrozenRecipientCohort;
    },
  ): Promise<void> {
    const ownerMemberId = input.cohort.memberIds[0];
    if (ownerMemberId === undefined) return;
    await this.outbox.enqueue(
      {
        eventKey: `settlement-ledger-commit:${input.postingBatchId}`,
        eventType: OUTBOX_EVENT_TARGETED_NOTIFICATION,
        payloadVersion: OUTBOX_PAYLOAD_VERSION,
        payload: {
          recipientMemberId: ownerMemberId,
          notificationTypeCode: NOTIFICATION_TYPE_ATTENDANCE_RESULT,
          title: '结算已入账',
          body: `「${input.activityTitle}」第 ${input.settlementVersion} 版结算已正式入账,共 ${input.memberCount} 名队员的服务时长与贡献值已生效。如需调整请走更正流程。`,
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
