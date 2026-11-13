import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { DurationHistogramMetric } from '../activities/activity-participation-metrics';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import {
  LedgerQueryService,
  listParticipationOverviewActivitiesInTx,
  readPostedParticipationFactsInTx,
  buildV11ParticipationMetrics,
  eligibleSecondsToServiceHours,
  sumOfficialEligibleSeconds,
} from '../activities/ledger-query.service';
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
  registeredParticipationCount: number;
  temporaryParticipationCount: number;
  mixedOriginParticipationCount: number;
  unknownOriginParticipationCount: number;
  pendingCount: number;
  pendingSessionCount: number;
  otherResultCount: number;
  durationUnknownCount: number;
  totalServiceHours: Prisma.Decimal;
  officialEligibleSeconds: number;
  completedAttendeeCount: number;
  completedNoShowCount: number;
  durationHistogram: DurationHistogramMetric;
}

function byActivity<T extends { activityId: string }>(rows: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const group = groups.get(row.activityId) ?? [];
    group.push(row);
    groups.set(row.activityId, group);
  }
  return groups;
}

@Injectable()
export class ParticipationOverviewQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly organizations: OrganizationsService,
    private readonly ledgerQuery: LedgerQueryService,
    private readonly activityWorkflowGate: ActivityWorkflowGate,
  ) {}

  private async resolveVisibleOrganizationIds(
    currentUser: CurrentUserPayload,
    query: ParticipationOverviewQueryDto,
    tx: Prisma.TransactionClient,
  ): Promise<string[] | undefined> {
    const [attendanceScope, registrationScope] = await Promise.all([
      this.authz.getVisibleOrganizationScope(currentUser, 'attendance.read.sheet', tx),
      this.authz.getVisibleOrganizationScope(currentUser, 'activity-registration.read.record', tx),
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
          ? await this.organizations.queryDescendantOrgIds(query.organizationId, tx)
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
    return this.prisma.$transaction(
      async (tx) => {
        const organizationIds = await this.resolveVisibleOrganizationIds(currentUser, query, tx);
        if (organizationIds?.length === 0) return { months: [] };
        if (this.activityWorkflowGate.participationReadSource() !== 'committed-ledger') {
          throw new BizException(BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED);
        }
        const activities = await listParticipationOverviewActivitiesInTx(tx, {
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
        });
        if (activities.length === 0) return { months: [] };
        const activityIds = activities.map((activity) => activity.id);
        const [registrations, facts, ledgerRows, official] = await Promise.all([
          tx.activityRegistration.findMany({
            where: { activityId: { in: activityIds }, deletedAt: null },
            select: { id: true, activityId: true, memberId: true, statusCode: true },
          }),
          readPostedParticipationFactsInTx(tx, activityIds),
          this.ledgerQuery.sumCommittedByMemberForActivities(activityIds, tx),
          this.ledgerQuery.readOfficialParticipationTimeTotalsInTx(tx, { activityIds }),
        ]);
        const registrationGroups = byActivity(registrations);
        const factGroups = byActivity(facts);
        const ledgerGroups = byActivity(ledgerRows);
        const officialGroups = byActivity(official?.totals ?? []);
        const months = new Map<string, MonthAccumulator>();
        for (const activity of activities) {
          const officialRows = officialGroups.get(activity.id) ?? [];
          const metrics = buildV11ParticipationMetrics({
            registrations: registrationGroups.get(activity.id) ?? [],
            facts: factGroups.get(activity.id) ?? [],
            ledgerRows: ledgerGroups.get(activity.id) ?? [],
            officialRows: official === null ? null : officialRows,
          });
          // Activity.startAt's UTC month remains the grouping key; ledger Beijing dates do not split it.
          const month = activity.startAt.toISOString().slice(0, 7);
          const value = months.get(month) ?? {
            activityCount: 0,
            completedActivityCount: 0,
            participationCount: 0,
            registeredParticipationCount: 0,
            temporaryParticipationCount: 0,
            mixedOriginParticipationCount: 0,
            unknownOriginParticipationCount: 0,
            pendingCount: 0,
            pendingSessionCount: 0,
            otherResultCount: 0,
            durationUnknownCount: 0,
            totalServiceHours: new Prisma.Decimal(0),
            officialEligibleSeconds: 0,
            completedAttendeeCount: 0,
            completedNoShowCount: 0,
            durationHistogram: {
              under2Hours: 0,
              from2To4Hours: 0,
              from4To8Hours: 0,
              atLeast8Hours: 0,
            },
          };
          value.activityCount += 1;
          value.participationCount += metrics.attendeeCount;
          value.registeredParticipationCount += metrics.registeredAttendeeCount;
          value.temporaryParticipationCount += metrics.temporaryAttendeeCount;
          value.mixedOriginParticipationCount += metrics.mixedOriginAttendeeCount;
          value.unknownOriginParticipationCount += metrics.unknownOriginAttendeeCount;
          value.pendingCount += metrics.pendingCount;
          value.pendingSessionCount += metrics.pendingSessionCount;
          value.otherResultCount += metrics.otherResultCount;
          value.durationUnknownCount += metrics.durationUnknownCount;
          if (official === null && metrics.totalServiceHours !== null) {
            value.totalServiceHours = value.totalServiceHours.add(metrics.totalServiceHours);
          } else if (official !== null) {
            value.officialEligibleSeconds = sumOfficialEligibleSeconds([
              { eligibleSeconds: value.officialEligibleSeconds },
              ...officialRows,
            ]);
          }
          value.durationHistogram.under2Hours += metrics.durationHistogram.under2Hours;
          value.durationHistogram.from2To4Hours += metrics.durationHistogram.from2To4Hours;
          value.durationHistogram.from4To8Hours += metrics.durationHistogram.from4To8Hours;
          value.durationHistogram.atLeast8Hours += metrics.durationHistogram.atLeast8Hours;
          if (activity.statusCode === 'completed') {
            value.completedActivityCount += 1;
            value.completedAttendeeCount += metrics.attendeeCount;
            value.completedNoShowCount += metrics.noShowCount;
          }
          months.set(month, value);
        }
        return {
          months: [...months.entries()].map(([month, value]) => {
            const denominator = value.completedAttendeeCount + value.completedNoShowCount;
            return {
              month,
              activityCount: value.activityCount,
              completedActivityCount: value.completedActivityCount,
              participationCount: value.participationCount,
              registeredParticipationCount: value.registeredParticipationCount,
              temporaryParticipationCount: value.temporaryParticipationCount,
              mixedOriginParticipationCount: value.mixedOriginParticipationCount,
              unknownOriginParticipationCount: value.unknownOriginParticipationCount,
              pendingCount: value.pendingCount,
              pendingSessionCount: value.pendingSessionCount,
              otherResultCount: value.otherResultCount,
              durationUnknownCount: value.durationUnknownCount,
              totalServiceHours:
                value.durationUnknownCount > 0
                  ? null
                  : official === null
                    ? value.totalServiceHours.toString()
                    : eligibleSecondsToServiceHours(value.officialEligibleSeconds).toString(),
              averageAttendanceRate:
                denominator === 0
                  ? null
                  : Number((value.completedAttendeeCount / denominator).toFixed(4)),
              noShowRate:
                denominator === 0
                  ? null
                  : Number((value.completedNoShowCount / denominator).toFixed(4)),
              durationHistogram: value.durationHistogram,
            };
          }),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
