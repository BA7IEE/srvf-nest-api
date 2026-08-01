import { Injectable } from '@nestjs/common';
import { MemberStatus, Prisma, UserStatus } from '@prisma/client';

import {
  NOTIFICATION_CHANNEL_IN_APP,
  NOTIFICATION_TYPE_ATTENDANCE_RESULT,
  NOTIFICATION_TYPE_RECRUITMENT,
  OUTBOX_EVENT_TARGETED_NOTIFICATION,
  OUTBOX_PAYLOAD_VERSION,
} from '../notifications/notification.constants';
import { NotificationOutboxService } from '../notifications/notification-outbox.service';
import type { NotificationOutboxEnqueueInput } from '../notifications/notification-outbox.types';
import type { ContributionResult } from '../team-join/team-join-progress';
import { computeContributionBatch } from '../team-join/team-join-progress';
import {
  APP_STATUS_JOINING as TEAM_JOIN_APP_STATUS_JOINING,
  CONTRIBUTION_THRESHOLD,
} from '../team-join/team-join.constants';

type PrismaTx = Prisma.TransactionClient;

interface FinalApprovedRecord {
  id: string;
  memberId: string;
  contributionPoints: string | null;
}

export interface ContributionThresholdSnapshot {
  applicationId: string;
  memberId: string;
  cycleYear: number;
  beforePoints: Prisma.Decimal;
}

@Injectable()
export class AttendanceNotificationProducer {
  constructor(private readonly outbox: NotificationOutboxService) {}

  async enqueueReturned(
    tx: PrismaTx,
    input: {
      sheetId: string;
      activityId: string;
      returnedAt: Date;
      returnNote: string;
      submitterUserIds: string[];
    },
  ): Promise<void> {
    const [activity, assignments, submitters] = await Promise.all([
      tx.activity.findUnique({
        where: { id: input.activityId },
        select: { title: true },
      }),
      tx.activityResponsibilityAssignment.findMany({
        where: {
          activityId: input.activityId,
          status: 'active',
          canManageAttendance: true,
          startedAt: { lte: input.returnedAt },
          endedAt: null,
          member: { status: MemberStatus.ACTIVE, deletedAt: null },
        },
        select: { memberId: true },
      }),
      tx.user.findMany({
        where: {
          id: { in: [...new Set(input.submitterUserIds)] },
          status: UserStatus.ACTIVE,
          deletedAt: null,
          member: { status: MemberStatus.ACTIVE, deletedAt: null },
        },
        select: { memberId: true },
      }),
    ]);
    const recipientMemberIds = new Set(assignments.map((assignment) => assignment.memberId));
    for (const submitter of submitters) {
      if (submitter.memberId) recipientMemberIds.add(submitter.memberId);
    }
    const activityTitle = activity?.title ?? '活动';
    for (const recipientMemberId of recipientMemberIds) {
      await this.enqueueTargeted(tx, {
        eventKey: `attendance-return:${input.sheetId}:${input.returnedAt.toISOString()}:${recipientMemberId}`,
        aggregateType: 'attendance_sheet',
        aggregateId: input.sheetId,
        memberId: recipientMemberId,
        notificationTypeCode: NOTIFICATION_TYPE_ATTENDANCE_RESULT,
        title: '考勤单已退回修改',
        body: `「${activityTitle}」考勤单已退回修改。原因：${input.returnNote}`,
      });
    }
  }

  /**
   * 每个候选人取「最近一条 joining 申请」+ 该申请所在轮的 before 贡献值快照。
   *
   * M3 批量化:原实现按人循环,每人 2 次 SQL(找申请 + 算贡献值)。200 人的考勤单
   * 就是 400 次往返 —— 与逐条 outbox 一起把 Prisma 默认 5s 交互事务预算跑穿。
   * 现在固定 **1 + (不同 cycleYear 数)** 次;实践中候选人几乎都在同一轮,即 2 次。
   *
   * 唯一的语义调整:并列排序键从 `createdAt desc` 变成 `createdAt desc, id desc`。
   * 原来靠 `findFirst` 取「最新一条」,createdAt 完全相同时取哪条是任意的;
   * 加 id 只是把这份任意性钉成确定的,不改变非并列情形下的结果。
   */
  async prepareContributionThresholdSnapshots(
    tx: PrismaTx,
    records: ReadonlyArray<Pick<FinalApprovedRecord, 'memberId'>>,
  ): Promise<ContributionThresholdSnapshot[]> {
    const memberIds = [...new Set(records.map((record) => record.memberId))];
    if (memberIds.length === 0) return [];

    const applications = await tx.teamJoinApplication.findMany({
      where: {
        memberId: { in: memberIds },
        statusCode: TEAM_JOIN_APP_STATUS_JOINING,
        deletedAt: null,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, memberId: true, cycle: { select: { year: true } } },
    });
    const latestByMember = new Map<string, (typeof applications)[number]>();
    for (const application of applications) {
      if (!latestByMember.has(application.memberId))
        latestByMember.set(application.memberId, application);
    }
    if (latestByMember.size === 0) return [];

    const pointsByYear = await computeContributionByCycleYear(tx, [...latestByMember.values()]);
    const snapshots: ContributionThresholdSnapshot[] = [];
    // 保持与入参 memberIds 同序:快照顺序影响的只是 intent 插入顺序,但确定性便于对账。
    for (const memberId of memberIds) {
      const application = latestByMember.get(memberId);
      if (!application) continue;
      const year = application.cycle.year;
      snapshots.push({
        applicationId: application.id,
        memberId,
        cycleYear: year,
        beforePoints: pointsByYear.get(year)?.get(memberId)?.points ?? new Prisma.Decimal(0),
      });
    }
    return snapshots;
  }

  async enqueueFinalApproved(
    tx: PrismaTx,
    input: {
      sheetId: string;
      activityId: string;
      finalReviewedAt: Date;
      records: FinalApprovedRecord[];
      contributionThresholdSnapshots: ContributionThresholdSnapshot[];
    },
  ): Promise<void> {
    if (input.records.length === 0) return;
    const activity = await tx.activity.findUnique({
      where: { id: input.activityId },
      select: { title: true },
    });
    const activityTitle = activity?.title ?? '活动';
    // M3:逐条 enqueue = 2 次 SQL × N 条;批量恒 2 次。eventKey 与 payload 逐字不变,
    // 所以幂等键、重放语义、worker 侧读取都不受影响。
    await this.outbox.enqueueMany(
      input.records.map((record) =>
        buildTargetedIntent({
          eventKey: `attendance-final:${input.sheetId}:${input.finalReviewedAt.toISOString()}:${record.id}`,
          aggregateType: 'attendance_sheet',
          aggregateId: input.sheetId,
          memberId: record.memberId,
          notificationTypeCode: NOTIFICATION_TYPE_ATTENDANCE_RESULT,
          title: '考勤结果已确认',
          body: `您在「${activityTitle}」的考勤已终审通过,本次贡献值 ${record.contributionPoints ?? '0'}。`,
        }),
      ),
      tx,
    );

    if (input.contributionThresholdSnapshots.length === 0) return;
    const threshold = CONTRIBUTION_THRESHOLD.toString();
    // after 快照同样批量:同一 cycleYear 一次 SQL。判据(before < 5 且 after 满足)逐字不变。
    const afterByYear = await computeContributionByCycleYear(
      tx,
      input.contributionThresholdSnapshots.map((snapshot) => ({
        memberId: snapshot.memberId,
        cycle: { year: snapshot.cycleYear },
      })),
    );
    const milestones = input.contributionThresholdSnapshots.filter((snapshot) => {
      if (snapshot.beforePoints.gte(CONTRIBUTION_THRESHOLD)) return false;
      return afterByYear.get(snapshot.cycleYear)?.get(snapshot.memberId)?.satisfied === true;
    });
    await this.outbox.enqueueMany(
      milestones.map((snapshot) =>
        buildTargetedIntent({
          eventKey: `team-join-contribution-met:${snapshot.applicationId}:${threshold}`,
          aggregateType: 'team_join_application',
          aggregateId: snapshot.applicationId,
          memberId: snapshot.memberId,
          notificationTypeCode: NOTIFICATION_TYPE_RECRUITMENT,
          title: '入队贡献值已达标',
          body: `您的贡献值已达到入队要求（${threshold} 分）。管理员核对其他门槛后将安排综合评估，请留意后续通知。`,
        }),
      ),
      tx,
    );
  }

  private async enqueueTargeted(tx: PrismaTx, input: TargetedIntentInput): Promise<void> {
    await this.outbox.enqueue(buildTargetedIntent(input), tx);
  }
}

interface TargetedIntentInput {
  eventKey: string;
  aggregateType: string;
  aggregateId: string;
  memberId: string;
  notificationTypeCode: string;
  title: string;
  body: string;
}

/** 单条与批量共用同一份 envelope 构造 —— 抄第二份就会出现「两条路径 payload 不一样」。 */
function buildTargetedIntent(input: TargetedIntentInput): NotificationOutboxEnqueueInput {
  return {
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
  };
}

/**
 * 按 cycleYear 分组批量算贡献值 —— cutoff 是 `{year}-04-01 北京日界`,随年变,
 * 所以必须先分组。返回 `Map<cycleYear, Map<memberId, ContributionResult>>`。
 */
async function computeContributionByCycleYear(
  tx: PrismaTx,
  rows: ReadonlyArray<{ memberId: string; cycle: { year: number } }>,
): Promise<Map<number, Map<string, ContributionResult>>> {
  const byYear = new Map<number, string[]>();
  for (const row of rows) {
    const list = byYear.get(row.cycle.year);
    if (list) list.push(row.memberId);
    else byYear.set(row.cycle.year, [row.memberId]);
  }
  const result = new Map<number, Map<string, ContributionResult>>();
  for (const [year, memberIds] of byYear) {
    result.set(year, await computeContributionBatch(tx, memberIds, year));
  }
  return result;
}
