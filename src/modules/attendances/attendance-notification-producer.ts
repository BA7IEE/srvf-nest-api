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
        sheetId: input.sheetId,
        memberId: recipientMemberId,
        notificationTypeCode: NOTIFICATION_TYPE_ATTENDANCE_RESULT,
        title: '考勤单已退回修改',
        body: `「${activityTitle}」考勤单已退回修改。原因：${input.returnNote}`,
      });
    }
  }

  async enqueueFinalApproved(
    tx: PrismaTx,
    input: {
      sheetId: string;
      activityId: string;
      finalReviewedAt: Date;
      records: FinalApprovedRecord[];
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
        sheetId: input.sheetId,
        memberId: record.memberId,
        notificationTypeCode: NOTIFICATION_TYPE_ATTENDANCE_RESULT,
        title: '考勤结果已确认',
        body: `您在「${activityTitle}」的考勤已终审通过,本次贡献值 ${record.contributionPoints ?? '0'}。`,
      });
    }

    const deltas = new Map<string, Prisma.Decimal>();
    for (const record of input.records) {
      const previous = deltas.get(record.memberId) ?? new Prisma.Decimal(0);
      deltas.set(record.memberId, previous.add(record.contributionPoints ?? 0));
    }
    for (const [memberId, delta] of deltas) {
      const application = await tx.teamJoinApplication.findFirst({
        where: {
          memberId,
          statusCode: TEAM_JOIN_APP_STATUS_JOINING,
          deletedAt: null,
        },
        orderBy: { createdAt: 'desc' },
        select: { cycle: { select: { year: true } } },
      });
      if (!application) continue;
      const after = await computeContribution(tx, memberId, application.cycle.year);
      if (!after.satisfied || after.points.minus(delta).gte(CONTRIBUTION_THRESHOLD)) continue;
      await this.enqueueTargeted(tx, {
        eventKey: `attendance-contribution-met:${input.sheetId}:${input.finalReviewedAt.toISOString()}:${memberId}`,
        sheetId: input.sheetId,
        memberId,
        notificationTypeCode: NOTIFICATION_TYPE_RECRUITMENT,
        title: '入队贡献值已达标',
        body: `您的贡献值已达到入队要求(当前 ${after.points.toString()} 分)。管理员核对门槛后将安排综合评估,请留意后续通知。`,
      });
    }
  }

  private async enqueueTargeted(
    tx: PrismaTx,
    input: {
      eventKey: string;
      sheetId: string;
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
        aggregateType: 'attendance_sheet',
        aggregateId: input.sheetId,
        destinationType: 'member',
        destinationRef: input.memberId,
      },
      tx,
    );
  }
}
