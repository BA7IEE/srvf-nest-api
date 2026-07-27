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
import { computeContribution } from '../team-join/team-join-progress';
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

  async prepareContributionThresholdSnapshots(
    tx: PrismaTx,
    records: ReadonlyArray<Pick<FinalApprovedRecord, 'memberId'>>,
  ): Promise<ContributionThresholdSnapshot[]> {
    const snapshots: ContributionThresholdSnapshot[] = [];
    for (const memberId of new Set(records.map((record) => record.memberId))) {
      const application = await tx.teamJoinApplication.findFirst({
        where: {
          memberId,
          statusCode: TEAM_JOIN_APP_STATUS_JOINING,
          deletedAt: null,
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, cycle: { select: { year: true } } },
      });
      if (!application) continue;
      const before = await computeContribution(tx, memberId, application.cycle.year);
      snapshots.push({
        applicationId: application.id,
        memberId,
        cycleYear: application.cycle.year,
        beforePoints: before.points,
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
    for (const record of input.records) {
      await this.enqueueTargeted(tx, {
        eventKey: `attendance-final:${input.sheetId}:${input.finalReviewedAt.toISOString()}:${record.id}`,
        aggregateType: 'attendance_sheet',
        aggregateId: input.sheetId,
        memberId: record.memberId,
        notificationTypeCode: NOTIFICATION_TYPE_ATTENDANCE_RESULT,
        title: '考勤结果已确认',
        body: `您在「${activityTitle}」的考勤已终审通过,本次贡献值 ${record.contributionPoints ?? '0'}。`,
      });
    }

    const threshold = CONTRIBUTION_THRESHOLD.toString();
    for (const snapshot of input.contributionThresholdSnapshots) {
      const after = await computeContribution(tx, snapshot.memberId, snapshot.cycleYear);
      if (snapshot.beforePoints.gte(CONTRIBUTION_THRESHOLD) || !after.satisfied) continue;
      await this.enqueueTargeted(tx, {
        eventKey: `team-join-contribution-met:${snapshot.applicationId}:${threshold}`,
        aggregateType: 'team_join_application',
        aggregateId: snapshot.applicationId,
        memberId: snapshot.memberId,
        notificationTypeCode: NOTIFICATION_TYPE_RECRUITMENT,
        title: '入队贡献值已达标',
        body: `您的贡献值已达到入队要求（${threshold} 分）。管理员核对其他门槛后将安排综合评估，请留意后续通知。`,
      });
    }
  }

  private async enqueueTargeted(
    tx: PrismaTx,
    input: {
      eventKey: string;
      aggregateType: string;
      aggregateId: string;
      memberId: string;
      notificationTypeCode: string;
      title: string;
      body: string;
    },
  ): Promise<void> {
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
