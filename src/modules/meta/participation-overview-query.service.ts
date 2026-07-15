import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import {
  buildActivityParticipationMetrics,
  type DurationHistogramMetric,
} from '../activities/activity-participation-metrics';
import { AuthzService } from '../authz/authz.service';
import { OrganizationsService } from '../organizations/organizations.service';
import {
  ParticipationOverviewQueryDto,
  ParticipationOverviewResponseDto,
} from './participation-overview.dto';

interface MonthAccumulator {
  activityCount: number;
  completedActivityCount: number;
  participationCount: number;
  totalServiceHours: Prisma.Decimal;
  completedPassCount: number;
  completedAttendeeCount: number;
  completedNoShowCount: number;
  durationHistogram: DurationHistogramMetric;
}

@Injectable()
export class ParticipationOverviewQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly organizations: OrganizationsService,
  ) {}

  private async resolveVisibleOrganizationIds(
    currentUser: CurrentUserPayload,
    query: ParticipationOverviewQueryDto,
  ): Promise<string[] | undefined> {
    const [attendanceScope, registrationScope] = await Promise.all([
      this.authz.getVisibleOrganizationScope(currentUser, 'attendance.read.sheet'),
      this.authz.getVisibleOrganizationScope(currentUser, 'activity-registration.read.record'),
    ]);
    if (!attendanceScope.hasPermission || !registrationScope.hasPermission) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }

    let authorizedIds: string[] | undefined;
    if (attendanceScope.global && registrationScope.global) {
      authorizedIds = undefined;
    } else if (attendanceScope.global) {
      authorizedIds = registrationScope.organizationIds;
    } else if (registrationScope.global) {
      authorizedIds = attendanceScope.organizationIds;
    } else {
      const registrationIds = new Set(registrationScope.organizationIds);
      authorizedIds = attendanceScope.organizationIds.filter((id) => registrationIds.has(id));
    }

    const requestedIds =
      query.organizationId === undefined
        ? undefined
        : query.includeDescendants
          ? await this.organizations.queryDescendantOrgIds(query.organizationId)
          : [query.organizationId];
    if (requestedIds === undefined) return authorizedIds;
    if (authorizedIds === undefined) return requestedIds;

    const requestedSet = new Set(requestedIds);
    return authorizedIds.filter((id) => requestedSet.has(id));
  }

  async getOverview(
    query: ParticipationOverviewQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<ParticipationOverviewResponseDto> {
    const organizationIds = await this.resolveVisibleOrganizationIds(currentUser, query);
    if (organizationIds?.length === 0) return { months: [] };

    const activities = await this.prisma.activity.findMany({
      where: {
        deletedAt: null,
        ...(organizationIds ? { organizationId: { in: organizationIds } } : {}),
        ...(query.activityTypeCode ? { activityTypeCode: query.activityTypeCode } : {}),
        ...(query.dateFrom || query.dateTo
          ? {
              startAt: {
                ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
                ...(query.dateTo ? { lte: new Date(query.dateTo) } : {}),
              },
            }
          : {}),
      },
      select: { id: true, statusCode: true, startAt: true },
      orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
    });
    if (activities.length === 0) return { months: [] };

    const activityIds = activities.map((activity) => activity.id);
    // 正常命中路径固定 3 次业务查询：activities + registrations(IN) + records(IN)。
    const [registrations, records] = await Promise.all([
      this.prisma.activityRegistration.findMany({
        where: { activityId: { in: activityIds }, deletedAt: null },
        select: { id: true, activityId: true, memberId: true, statusCode: true },
      }),
      this.prisma.attendanceRecord.findMany({
        where: {
          deletedAt: null,
          sheet: { activityId: { in: activityIds }, deletedAt: null },
        },
        select: {
          memberId: true,
          serviceHours: true,
          contributionPoints: true,
          sheet: { select: { activityId: true, statusCode: true } },
        },
      }),
    ]);

    const registrationsByActivity = new Map<string, typeof registrations>();
    for (const registration of registrations) {
      const rows = registrationsByActivity.get(registration.activityId) ?? [];
      rows.push(registration);
      registrationsByActivity.set(registration.activityId, rows);
    }
    const recordsByActivity = new Map<string, typeof records>();
    for (const record of records) {
      const rows = recordsByActivity.get(record.sheet.activityId) ?? [];
      rows.push(record);
      recordsByActivity.set(record.sheet.activityId, rows);
    }

    const months = new Map<string, MonthAccumulator>();
    for (const activity of activities) {
      const metrics = buildActivityParticipationMetrics(
        activity.statusCode,
        registrationsByActivity.get(activity.id) ?? [],
        recordsByActivity.get(activity.id) ?? [],
      );
      const month = activity.startAt.toISOString().slice(0, 7);
      const accumulator = months.get(month) ?? {
        activityCount: 0,
        completedActivityCount: 0,
        participationCount: 0,
        totalServiceHours: new Prisma.Decimal(0),
        completedPassCount: 0,
        completedAttendeeCount: 0,
        completedNoShowCount: 0,
        durationHistogram: {
          under2Hours: 0,
          from2To4Hours: 0,
          from4To8Hours: 0,
          atLeast8Hours: 0,
        },
      };
      accumulator.activityCount += 1;
      accumulator.participationCount += metrics.attendeeCount;
      accumulator.totalServiceHours = accumulator.totalServiceHours.add(metrics.totalServiceHours);
      accumulator.durationHistogram.under2Hours += metrics.durationHistogram.under2Hours;
      accumulator.durationHistogram.from2To4Hours += metrics.durationHistogram.from2To4Hours;
      accumulator.durationHistogram.from4To8Hours += metrics.durationHistogram.from4To8Hours;
      accumulator.durationHistogram.atLeast8Hours += metrics.durationHistogram.atLeast8Hours;
      if (activity.statusCode === 'completed') {
        accumulator.completedActivityCount += 1;
        accumulator.completedPassCount += metrics.registrationCounts.pass;
        accumulator.completedAttendeeCount += metrics.registeredAttendeeCount;
        accumulator.completedNoShowCount += metrics.noShowCount;
      }
      months.set(month, accumulator);
    }

    return {
      months: [...months.entries()].map(([month, value]) => ({
        month,
        activityCount: value.activityCount,
        completedActivityCount: value.completedActivityCount,
        participationCount: value.participationCount,
        totalServiceHours: value.totalServiceHours.toString(),
        averageAttendanceRate:
          value.completedPassCount === 0
            ? 0
            : Number((value.completedAttendeeCount / value.completedPassCount).toFixed(4)),
        noShowRate:
          value.completedPassCount === 0
            ? 0
            : Number((value.completedNoShowCount / value.completedPassCount).toFixed(4)),
        durationHistogram: value.durationHistogram,
      })),
    };
  }
}
