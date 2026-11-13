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
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import { LedgerQueryService } from './ledger-query.service';
import { RbacService } from '../permissions/rbac.service';
import {
  ActivityParticipationSummaryDto,
  ActivityReconciliationDto,
  type ActivityReconciliationParticipantDto,
} from './activity-participation.dto';
import {
  readPostedParticipationDayCountsInTx,
  readPostedParticipationFactsInTx,
} from './activity-participation-projection-query';
import { projectParticipation } from './activity-participation-projection';
import { buildV11ParticipationMetrics } from './activity-participation-v11-metrics';
import { toMemberLabelFields } from '../../common/identity/member-label.util';
import {
  ParticipationTimeTruthQueryService,
  eligibleSecondsToServiceHours,
} from './participation-time-truth-query.service';

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
    private readonly ledgerQuery: LedgerQueryService,
    private readonly participationTimeTruth: ParticipationTimeTruthQueryService,
    // 活动 v1.1 cutover gate —— 统计读面取数源的判闸依据(合同 §16.2 单轨第三项)。
    private readonly activityWorkflowGate: ActivityWorkflowGate,
  ) {}

  private async assertCanReadActivity(
    currentUser: CurrentUserPayload,
    activityId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const ref: ResourceRef = { type: 'activity', id: activityId };
    for (const action of PARTICIPATION_READ_ACTIONS) {
      const decision =
        tx === undefined
          ? await this.authz.explain(currentUser, action, ref)
          : await this.authz.explain(currentUser, action, ref, tx);
      if (decision.allow) continue;
      if (
        decision.reason === 'resource_not_found' &&
        (tx === undefined
          ? await this.rbac.can(currentUser, action)
          : await this.rbac.can(currentUser, action, undefined, tx))
      ) {
        continue;
      }
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  private async findActivityOrThrow(
    activityId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{ id: string; statusCode: string }> {
    const activity = await (tx ?? this.prisma).activity.findFirst({
      where: { id: activityId, deletedAt: null },
      select: { id: true, statusCode: true },
    });
    if (!activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return activity;
  }

  private assertV11ReadAvailable(): void {
    if (this.activityWorkflowGate.participationReadSource() !== 'committed-ledger') {
      throw new BizException(BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED);
    }
  }

  async reconciliation(
    activityId: string,
    currentUser: CurrentUserPayload,
  ): Promise<ActivityReconciliationDto> {
    return this.prisma.$transaction(
      async (tx) => {
        await this.assertCanReadActivity(currentUser, activityId, tx);
        const activity = await this.findActivityOrThrow(activityId, tx);
        if (activity.statusCode !== 'completed') {
          throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
        }
        this.assertV11ReadAvailable();
        const [registrations, facts, dayCounts, officialTime, ledgerRows] = await Promise.all([
          tx.activityRegistration.findMany({
            where: { activityId, deletedAt: null },
            select: {
              id: true,
              memberId: true,
              statusCode: true,
              member: { select: { memberNo: true, realName: true, nickname: true } },
            },
            orderBy: [{ registeredAt: 'asc' }, { id: 'asc' }],
          }),
          readPostedParticipationFactsInTx(tx, [activityId]),
          readPostedParticipationDayCountsInTx(tx, [activityId]),
          this.participationTimeTruth.readOfficialTotalsInTx(tx, { activityIds: [activityId] }),
          this.ledgerQuery.sumCommittedByMemberForActivities([activityId], tx),
        ]);
        const factsByIdentity = new Map(facts.map((fact) => [fact.identityId, fact]));
        for (const identityId of dayCounts.keys()) {
          const fact = factsByIdentity.get(identityId);
          if (fact === undefined || fact.resultCode === null)
            throw new Error('invalid current participation day count');
        }
        const factsByMember = new Map<string, typeof facts>();
        for (const fact of facts) {
          const group = factsByMember.get(fact.memberId) ?? [];
          group.push(fact);
          factsByMember.set(fact.memberId, group);
        }
        const officialByMember = new Map<string, number>();
        for (const row of officialTime?.totals ?? []) {
          if (officialByMember.has(row.memberId))
            throw new Error('duplicate official participation time');
          officialByMember.set(row.memberId, row.eligibleSeconds);
        }
        const ledgerByMember = new Map<string, string>();
        for (const row of ledgerRows) {
          if (ledgerByMember.has(row.memberId))
            throw new Error('duplicate committed participation total');
          ledgerByMember.set(row.memberId, row.serviceHours);
        }
        const serviceHours = (memberId: string): string | null => {
          if (officialTime !== null) {
            const seconds = officialByMember.get(memberId);
            return seconds === undefined ? null : eligibleSecondsToServiceHours(seconds).toString();
          }
          const hours = ledgerByMember.get(memberId);
          if (hours === undefined) return null;
          const value = new Prisma.Decimal(hours);
          if (!value.isFinite() || value.isNegative())
            throw new RangeError('invalid committed service hours');
          return value.toString();
        };
        const buildSessions = (group: typeof facts) =>
          group.map((fact) => ({
            identityId: fact.identityId,
            sessionId: fact.sessionId,
            currentStatusCode: fact.currentStatusCode,
            populationIncluded: fact.populationIncluded,
            resultCode: fact.resultCode,
            ledgerDayCount: dayCounts.get(fact.identityId) ?? 0,
          }));
        const participants: ActivityReconciliationParticipantDto[] = [];
        const knownMembers = new Set<string>();
        for (const projected of projectParticipation(facts)) {
          if (projected.outcome === 'excluded') continue;
          const group = factsByMember.get(projected.memberId);
          if (
            group === undefined ||
            group.length === 0 ||
            new Set(group.map((fact) => fact.registrationId)).size !== 1
          ) {
            throw new Error('invalid participation member registration');
          }
          const sessions = buildSessions(group);
          const recordCount = sessions.reduce(
            (total, session) => total + session.ledgerDayCount,
            0,
          );
          if (!Number.isSafeInteger(recordCount))
            throw new RangeError('participation day count overflow');
          participants.push({
            registrationId: group[0].registrationId,
            memberId: projected.memberId,
            ...toMemberLabelFields(group[0].member),
            outcome: projected.outcome,
            origin: projected.origin,
            recordCount,
            postedResultCount: sessions.filter((session) => session.resultCode !== null).length,
            totalServiceHours: serviceHours(projected.memberId),
            sessions,
          });
          knownMembers.add(projected.memberId);
        }
        for (const registration of registrations) {
          if (
            registration.statusCode !== ACTIVITY_REGISTRATION_STATUS.PASS ||
            knownMembers.has(registration.memberId)
          )
            continue;
          const group = factsByMember.get(registration.memberId) ?? [];
          if (group.some((fact) => fact.registrationId !== registration.id))
            throw new Error('invalid participation registration');
          const sessions = buildSessions(group);
          participants.push({
            registrationId: registration.id,
            memberId: registration.memberId,
            ...toMemberLabelFields(registration.member),
            outcome: 'pending',
            origin: 'unknown',
            recordCount: 0,
            postedResultCount: 0,
            totalServiceHours: serviceHours(registration.memberId),
            sessions,
          });
          knownMembers.add(registration.memberId);
        }
        const metrics = buildV11ParticipationMetrics({
          registrations,
          facts,
          ledgerRows,
          officialRows: officialTime?.totals ?? null,
        });
        return {
          activityId,
          activityStatusCode: activity.statusCode,
          passRegistrationCount: registrations.filter(
            (registration) => registration.statusCode === ACTIVITY_REGISTRATION_STATUS.PASS,
          ).length,
          attendedCount: metrics.attendeeCount,
          noShowCount: metrics.noShowCount,
          pendingCount: metrics.pendingCount,
          otherResultCount: metrics.otherResultCount,
          registeredParticipants: participants.filter(
            (participant) => participant.origin === 'registered',
          ),
          temporaryParticipants: participants.filter(
            (participant) => participant.origin === 'onsite',
          ),
          unclassifiedParticipants: participants.filter(
            (participant) => participant.origin === 'mixed' || participant.origin === 'unknown',
          ),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async participationSummary(
    activityId: string,
    currentUser: CurrentUserPayload,
  ): Promise<ActivityParticipationSummaryDto> {
    return this.prisma.$transaction(
      async (tx) => {
        await this.assertCanReadActivity(currentUser, activityId, tx);
        const activity = await this.findActivityOrThrow(activityId, tx);
        this.assertV11ReadAvailable();
        const [registrations, facts, feedback, officialTime, ledgerRows] = await Promise.all([
          tx.activityRegistration.findMany({
            where: { activityId, deletedAt: null },
            select: { id: true, memberId: true, statusCode: true },
          }),
          readPostedParticipationFactsInTx(tx, [activityId]),
          this.feedbacks.aggregateForActivity(activityId, tx),
          this.participationTimeTruth.readOfficialTotalsInTx(tx, { activityIds: [activityId] }),
          this.ledgerQuery.sumCommittedByMemberForActivities([activityId], tx),
        ]);
        return {
          activityId,
          activityStatusCode: activity.statusCode,
          ...buildV11ParticipationMetrics({
            registrations,
            facts,
            ledgerRows,
            officialRows: officialTime?.totals ?? null,
          }),
          feedback,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
