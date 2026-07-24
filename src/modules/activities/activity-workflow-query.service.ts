import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuthzService } from '../authz/authz.service';
import {
  ActivityClosurePolicy,
  type ActivityAttendanceWorkflowCounts,
} from './activity-closure-policy';
import type {
  AppManagedActivitiesQueryDto,
  AppManagedActivityDetailDto,
  AppManagedActivityListItemDto,
  AppManagedActivityProjectionDto,
} from './dto/app/app-managed-activity.dto';

export const managedActivitySelect = {
  id: true,
  title: true,
  activityTypeCode: true,
  organizationId: true,
  startAt: true,
  endAt: true,
  location: true,
  description: true,
  capacity: true,
  statusCode: true,
  workflowRevision: true,
  requiresInsurance: true,
  isPublicRegistration: true,
  attendanceDeclaredCompleteAt: true,
  createdAt: true,
  updatedAt: true,
  initiator: {
    select: { id: true, memberNo: true, displayName: true, gradeCode: true },
  },
  responsibilityAssignments: {
    where: { status: 'active' },
    select: {
      memberId: true,
      responsibilityType: true,
      canManageRegistrations: true,
      canManageAttendance: true,
      member: {
        select: { id: true, memberNo: true, displayName: true, gradeCode: true },
      },
    },
  },
  publishReviews: {
    orderBy: [{ requestVersion: 'desc' }],
    take: 1,
    select: {
      id: true,
      requestType: true,
      status: true,
      reviewNote: true,
    },
  },
  _count: {
    select: {
      registrations: { where: { deletedAt: null } },
      attendanceSheets: { where: { deletedAt: null } },
    },
  },
} as const satisfies Prisma.ActivitySelect;

export type ManagedActivityRow = Prisma.ActivityGetPayload<{
  select: typeof managedActivitySelect;
}>;

type AttendanceStatusGroup = {
  activityId: string;
  statusCode: string;
  _count: { _all: number };
};

const EMPTY_ATTENDANCE_COUNTS: ActivityAttendanceWorkflowCounts = {
  total: 0,
  pending: 0,
  returned: 0,
  pendingFinalReview: 0,
  unresolved: 0,
};

@Injectable()
export class ActivityWorkflowQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly closurePolicy: ActivityClosurePolicy,
  ) {}

  async list(
    memberId: string,
    query: AppManagedActivitiesQueryDto,
  ): Promise<PageResultDto<AppManagedActivityListItemDto>> {
    const where: Prisma.ActivityWhereInput = {
      deletedAt: null,
      ...(query.statusCode ? { statusCode: query.statusCode } : {}),
      OR: [
        { initiatorMemberId: memberId },
        { responsibilityAssignments: { some: { memberId, status: 'active' } } },
      ],
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.activity.findMany({
        where,
        select: managedActivitySelect,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.activity.count({ where }),
    ]);
    const activityIds = rows.map((row) => row.id);
    const [registrationGroups, attendanceGroups] =
      activityIds.length === 0
        ? [[], []]
        : await Promise.all([
            this.prisma.activityRegistration.groupBy({
              by: ['activityId', 'statusCode'],
              where: {
                activityId: { in: activityIds },
                deletedAt: null,
                statusCode: { in: ['pending', 'waitlisted'] },
              },
              _count: { _all: true },
            }),
            this.prisma.attendanceSheet.groupBy({
              by: ['activityId', 'statusCode'],
              where: { activityId: { in: activityIds }, deletedAt: null },
              _count: { _all: true },
            }),
          ]);
    const pendingByActivity = new Map<string, number>();
    for (const group of registrationGroups) {
      if (group.statusCode === 'pending') {
        pendingByActivity.set(group.activityId, group._count._all);
      }
    }
    const attendanceByActivity = this.indexAttendanceCounts(attendanceGroups);
    const now = new Date();

    return {
      items: rows.map((row) => {
        const assignment = row.responsibilityAssignments.find((item) => item.memberId === memberId);
        const relationship =
          assignment?.responsibilityType === 'owner'
            ? 'owner'
            : assignment?.responsibilityType === 'collaborator'
              ? 'collaborator'
              : 'initiator';
        const attendance = attendanceByActivity.get(row.id) ?? EMPTY_ATTENDANCE_COUNTS;
        const closure = this.closurePolicy.decide(this.toClosureInput(row, attendance), now);
        return {
          activityId: row.id,
          title: row.title,
          statusCode: row.statusCode,
          startAt: row.startAt,
          endAt: row.endAt,
          relationship,
          pendingRegistrations: pendingByActivity.get(row.id) ?? 0,
          unresolvedAttendanceSheets: attendance.unresolved,
          nextAction: closure.nextAction,
        };
      }),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async detail(
    activityId: string,
    memberId: string,
    user: CurrentUserPayload,
  ): Promise<AppManagedActivityDetailDto> {
    const row = await this.loadManaged(activityId, memberId);
    const [registrationGroups, attendanceGroups, canPublish] = await Promise.all([
      this.prisma.activityRegistration.groupBy({
        by: ['statusCode'],
        where: {
          activityId,
          deletedAt: null,
          statusCode: { in: ['pending', 'waitlisted'] },
        },
        _count: { _all: true },
      }),
      this.prisma.attendanceSheet.groupBy({
        by: ['activityId', 'statusCode'],
        where: { activityId, deletedAt: null },
        _count: { _all: true },
      }),
      this.authz.can(user, 'activity.publish.record', { type: 'activity', id: activityId }),
    ]);
    const registrationCount = (statusCode: string) =>
      registrationGroups.find((group) => group.statusCode === statusCode)?._count._all ?? 0;
    const attendance =
      this.indexAttendanceCounts(attendanceGroups).get(activityId) ?? EMPTY_ATTENDANCE_COUNTS;
    const owner = row.responsibilityAssignments.find(
      (assignment) => assignment.responsibilityType === 'owner',
    );
    const mine = row.responsibilityAssignments.find(
      (assignment) => assignment.memberId === memberId,
    );
    const latest = row.publishReviews[0] ?? null;
    const closure = this.closurePolicy.decide(this.toClosureInput(row, attendance));

    return {
      activity: this.toProjection(row),
      initiator: row.initiator,
      owner: owner?.member ?? null,
      myResponsibility: mine
        ? {
            responsibilityType: mine.responsibilityType === 'owner' ? 'owner' : 'collaborator',
            canManageRegistrations: mine.canManageRegistrations,
            canManageAttendance: mine.canManageAttendance,
          }
        : null,
      publishReview: {
        latestRequestId: latest?.id ?? null,
        requestType:
          latest?.requestType === 'initial' || latest?.requestType === 'change'
            ? latest.requestType
            : null,
        status:
          latest?.status === 'pending' ||
          latest?.status === 'approved' ||
          latest?.status === 'returned' ||
          latest?.status === 'withdrawn' ||
          latest?.status === 'cancelled'
            ? latest.status
            : null,
        reviewNote: latest?.reviewNote ?? null,
        canDirectPublish: row.initiator?.id === memberId && canPublish,
      },
      counts: {
        pendingRegistrations: registrationCount('pending'),
        waitlistedRegistrations: registrationCount('waitlisted'),
        attendanceSheets: attendance.total,
        unresolvedAttendanceSheets: attendance.unresolved,
      },
      closure: {
        attendanceDeclaredCompleteAt: row.attendanceDeclaredCompleteAt,
        ...closure,
      },
    };
  }

  async loadOwned(activityId: string, memberId: string): Promise<ManagedActivityRow> {
    const activity = await this.prisma.activity.findFirst({
      where: {
        id: activityId,
        deletedAt: null,
        responsibilityAssignments: {
          some: { memberId, responsibilityType: 'owner', status: 'active' },
        },
      },
      select: managedActivitySelect,
    });
    if (!activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return activity;
  }

  async loadManaged(activityId: string, memberId: string): Promise<ManagedActivityRow> {
    const activity = await this.prisma.activity.findFirst({
      where: {
        id: activityId,
        deletedAt: null,
        OR: [
          { initiatorMemberId: memberId },
          { responsibilityAssignments: { some: { memberId, status: 'active' } } },
        ],
      },
      select: managedActivitySelect,
    });
    if (!activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return activity;
  }

  private indexAttendanceCounts(
    groups: AttendanceStatusGroup[],
  ): Map<string, ActivityAttendanceWorkflowCounts> {
    const result = new Map<string, ActivityAttendanceWorkflowCounts>();
    for (const group of groups) {
      const current = result.get(group.activityId) ?? { ...EMPTY_ATTENDANCE_COUNTS };
      const count = group._count._all;
      current.total += count;
      if (group.statusCode === 'pending') current.pending += count;
      if (group.statusCode === 'returned') current.returned += count;
      if (group.statusCode === 'pending_final_review') current.pendingFinalReview += count;
      if (!['approved', 'rejected', 'final_rejected'].includes(group.statusCode)) {
        current.unresolved += count;
      }
      result.set(group.activityId, current);
    }
    return result;
  }

  private toClosureInput(row: ManagedActivityRow, attendance: ActivityAttendanceWorkflowCounts) {
    return {
      statusCode: row.statusCode,
      endAt: row.endAt,
      attendanceDeclaredCompleteAt: row.attendanceDeclaredCompleteAt,
      latestPublishReviewStatus: row.publishReviews[0]?.status ?? null,
      attendance,
    };
  }

  private toProjection(row: ManagedActivityRow): AppManagedActivityProjectionDto {
    return {
      id: row.id,
      title: row.title,
      activityTypeCode: row.activityTypeCode,
      organizationId: row.organizationId,
      startAt: row.startAt,
      endAt: row.endAt,
      location: row.location,
      description: row.description,
      capacity: row.capacity,
      statusCode: row.statusCode,
      workflowRevision: row.workflowRevision,
      requiresInsurance: row.requiresInsurance,
      isPublicRegistration: row.isPublicRegistration,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
