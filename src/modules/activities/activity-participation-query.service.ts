import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuthzService } from '../authz/authz.service';
import type { ResourceRef } from '../authz/authz.types';
import { ACTIVITY_REGISTRATION_STATUS } from '../activity-registrations/activity-registration-state-machine';
import { ActivityFeedbacksQueryService } from '../activity-feedbacks/activity-feedbacks-query.service';
import { ATTENDANCE_SHEET_STATUS } from '../attendances/attendances.dto';
import { RbacService } from '../permissions/rbac.service';
import {
  ActivityParticipationSummaryDto,
  ActivityReconciliationDto,
} from './activity-participation.dto';
import { buildActivityParticipationMetrics } from './activity-participation-metrics';

const PARTICIPATION_READ_ACTIONS = [
  'attendance.read.sheet',
  'activity-registration.read.record',
] as const;

@Injectable()
export class ActivityParticipationQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly rbac: RbacService,
    private readonly feedbacks: ActivityFeedbacksQueryService,
  ) {}

  private async assertCanReadActivity(
    currentUser: CurrentUserPayload,
    activityId: string,
  ): Promise<void> {
    const ref: ResourceRef = { type: 'activity', id: activityId };
    for (const action of PARTICIPATION_READ_ACTIONS) {
      const decision = await this.authz.explain(currentUser, action, ref);
      if (decision.allow) continue;
      if (decision.reason === 'resource_not_found' && (await this.rbac.can(currentUser, action))) {
        continue;
      }
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  private async findActivityOrThrow(
    activityId: string,
  ): Promise<{ id: string; statusCode: string }> {
    const activity = await this.prisma.activity.findFirst({
      where: { id: activityId, deletedAt: null },
      select: { id: true, statusCode: true },
    });
    if (!activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return activity;
  }

  async reconciliation(
    activityId: string,
    currentUser: CurrentUserPayload,
  ): Promise<ActivityReconciliationDto> {
    await this.assertCanReadActivity(currentUser, activityId);
    const activity = await this.findActivityOrThrow(activityId);
    if (activity.statusCode !== 'completed') {
      throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
    }

    // 业务数据固定 3 次查询：activity + registrations + records；两集合一次取全后内存 diff。
    const [allRegistrations, records] = await Promise.all([
      this.prisma.activityRegistration.findMany({
        where: {
          activityId,
          deletedAt: null,
        },
        select: {
          id: true,
          memberId: true,
          statusCode: true,
          member: { select: { memberNo: true, displayName: true } },
        },
        orderBy: [{ registeredAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.attendanceRecord.findMany({
        where: { deletedAt: null, sheet: { activityId, deletedAt: null } },
        select: {
          memberId: true,
          serviceHours: true,
          sheet: { select: { statusCode: true } },
          member: { select: { memberNo: true, displayName: true } },
        },
        orderBy: [{ memberId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);
    const registrations = allRegistrations.filter(
      (registration) => registration.statusCode === ACTIVITY_REGISTRATION_STATUS.PASS,
    );

    const recordsByMember = new Map<string, typeof records>();
    for (const record of records) {
      const rows = recordsByMember.get(record.memberId) ?? [];
      rows.push(record);
      recordsByMember.set(record.memberId, rows);
    }
    const registeredMemberIds = new Set(
      allRegistrations.map((registration) => registration.memberId),
    );

    const summarizeRecords = (memberRecords: typeof records) => {
      const approved = memberRecords.filter(
        (record) => record.sheet.statusCode === ATTENDANCE_SHEET_STATUS.APPROVED,
      );
      const hours = approved.reduce(
        (sum, record) => sum.add(record.serviceHours),
        new Prisma.Decimal(0),
      );
      return {
        recordCount: memberRecords.length,
        approvedRecordCount: approved.length,
        totalServiceHours: hours.toString(),
      };
    };

    const registeredParticipants = registrations.map((registration) => {
      const memberRecords = recordsByMember.get(registration.memberId) ?? [];
      return {
        registrationId: registration.id,
        memberId: registration.memberId,
        memberNo: registration.member.memberNo,
        displayName: registration.member.displayName,
        outcome: memberRecords.length > 0 ? ('attended' as const) : ('no-show' as const),
        ...summarizeRecords(memberRecords),
      };
    });

    const temporaryParticipants = [...recordsByMember.entries()]
      .filter(([memberId]) => !registeredMemberIds.has(memberId))
      .map(([memberId, memberRecords]) => ({
        memberId,
        memberNo: memberRecords[0].member.memberNo,
        displayName: memberRecords[0].member.displayName,
        outcome: 'temporary' as const,
        ...summarizeRecords(memberRecords),
      }));

    return {
      activityId,
      activityStatusCode: activity.statusCode,
      passRegistrationCount: registrations.length,
      attendedCount: registeredParticipants.filter((item) => item.outcome === 'attended').length,
      noShowCount: registeredParticipants.filter((item) => item.outcome === 'no-show').length,
      registeredParticipants,
      temporaryParticipants,
    };
  }

  async participationSummary(
    activityId: string,
    currentUser: CurrentUserPayload,
  ): Promise<ActivityParticipationSummaryDto> {
    await this.assertCanReadActivity(currentUser, activityId);
    const activity = await this.findActivityOrThrow(activityId);

    // 业务数据固定 4 次查询：activity + registrations + records + feedback aggregate；无 N+1。
    const [registrations, records, feedback] = await Promise.all([
      this.prisma.activityRegistration.findMany({
        where: { activityId, deletedAt: null },
        select: { id: true, memberId: true, statusCode: true },
      }),
      this.prisma.attendanceRecord.findMany({
        where: { deletedAt: null, sheet: { activityId, deletedAt: null } },
        select: {
          memberId: true,
          serviceHours: true,
          contributionPoints: true,
          sheet: { select: { statusCode: true } },
        },
      }),
      this.feedbacks.aggregateForActivity(activityId),
    ]);
    const metrics = buildActivityParticipationMetrics(activity.statusCode, registrations, records);

    return {
      activityId,
      activityStatusCode: activity.statusCode,
      registrationCounts: metrics.registrationCounts,
      attendeeCount: metrics.attendeeCount,
      registeredAttendeeCount: metrics.registeredAttendeeCount,
      temporaryAttendeeCount: metrics.temporaryAttendeeCount,
      noShowCount: metrics.noShowCount,
      attendanceRate: metrics.attendanceRate,
      totalServiceHours: metrics.totalServiceHours.toString(),
      totalContributionPoints: metrics.totalContributionPoints.toString(),
      durationHistogram: metrics.durationHistogram,
      feedback,
    };
  }
}
