import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ActivityClosurePolicy } from './activity-closure-policy';

export type MemberOffboardActivitySummary = {
  activityId: string;
  title: string;
  statusCode: string;
  closure: { status: string };
  responsibilityType: 'initiator' | 'owner' | 'collaborator';
};

export type MemberOffboardRegistrationSummary = {
  activityId: string;
  title: string;
  statusCode: string;
  closure: { status: string };
  registrationId: string;
  registrationStatus: string;
  hasParticipationEvidence: boolean;
};

export type ActivityMemberOffboardImpact = {
  draftInitiatedActivities: MemberOffboardActivitySummary[];
  activeOwnerActivities: MemberOffboardActivitySummary[];
  activeCollaboratorActivities: MemberOffboardActivitySummary[];
  futureRegistrations: MemberOffboardRegistrationSummary[];
  historicalRegistrationsWithEvidence: MemberOffboardRegistrationSummary[];
  canOffboard: boolean;
  blockingReasons: string[];
};

type ImpactClient = Pick<Prisma.TransactionClient, 'activity'>;

@Injectable()
export class ActivityMemberOffboardImpactService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly closurePolicy: ActivityClosurePolicy,
  ) {}

  async getImpact(
    memberId: string,
    client: ImpactClient = this.prisma,
    now: Date = new Date(),
  ): Promise<ActivityMemberOffboardImpact> {
    const activities = await client.activity.findMany({
      where: {
        deletedAt: null,
        OR: [
          { initiatorMemberId: memberId },
          {
            responsibilityAssignments: {
              some: { memberId, status: 'active' },
            },
          },
          {
            registrations: {
              some: {
                memberId,
                deletedAt: null,
                statusCode: { in: ['pending', 'waitlisted', 'pass'] },
              },
            },
          },
        ],
      },
      select: {
        id: true,
        title: true,
        statusCode: true,
        endAt: true,
        attendanceDeclaredCompleteAt: true,
        initiatorMemberId: true,
        publishReviews: {
          orderBy: [{ requestVersion: 'desc' }, { id: 'desc' }],
          take: 1,
          select: { status: true },
        },
        responsibilityAssignments: {
          where: { memberId, status: 'active' },
          select: { responsibilityType: true },
        },
        registrations: {
          where: {
            memberId,
            deletedAt: null,
            statusCode: { in: ['pending', 'waitlisted', 'pass'] },
          },
          orderBy: [{ registeredAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            statusCode: true,
            activityCheckIns: {
              where: { deletedAt: null },
              take: 1,
              select: { id: true },
            },
            attendanceRecords: {
              where: { deletedAt: null },
              take: 1,
              select: { id: true },
            },
          },
        },
        attendanceSheets: {
          where: { deletedAt: null },
          select: { statusCode: true },
        },
      },
      orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
    });

    const draftInitiatedActivities: MemberOffboardActivitySummary[] = [];
    const activeOwnerActivities: MemberOffboardActivitySummary[] = [];
    const activeCollaboratorActivities: MemberOffboardActivitySummary[] = [];
    const futureRegistrations: MemberOffboardRegistrationSummary[] = [];
    const historicalRegistrationsWithEvidence: MemberOffboardRegistrationSummary[] = [];
    let hasBlockingOwner = false;

    for (const activity of activities) {
      const attendance = {
        total: activity.attendanceSheets.length,
        pending: 0,
        returned: 0,
        pendingFinalReview: 0,
        unresolved: 0,
      };
      for (const sheet of activity.attendanceSheets) {
        if (sheet.statusCode === 'pending') attendance.pending += 1;
        if (sheet.statusCode === 'returned') attendance.returned += 1;
        if (sheet.statusCode === 'pending_final_review') attendance.pendingFinalReview += 1;
        if (!['approved', 'rejected', 'final_rejected'].includes(sheet.statusCode)) {
          attendance.unresolved += 1;
        }
      }
      const closure = this.closurePolicy.decide(
        {
          statusCode: activity.statusCode,
          endAt: activity.endAt,
          attendanceDeclaredCompleteAt: activity.attendanceDeclaredCompleteAt,
          latestPublishReviewStatus: activity.publishReviews[0]?.status ?? null,
          attendance,
        },
        now,
      );

      if (activity.statusCode === 'draft' && activity.initiatorMemberId === memberId) {
        draftInitiatedActivities.push({
          activityId: activity.id,
          title: activity.title,
          statusCode: activity.statusCode,
          closure: { status: closure.status },
          responsibilityType: 'initiator',
        });
      }

      for (const responsibility of activity.responsibilityAssignments) {
        if (responsibility.responsibilityType === 'owner') {
          activeOwnerActivities.push({
            activityId: activity.id,
            title: activity.title,
            statusCode: activity.statusCode,
            closure: { status: closure.status },
            responsibilityType: 'owner',
          });
          if (activity.statusCode !== 'cancelled' && closure.status !== 'closed') {
            hasBlockingOwner = true;
          }
        } else if (responsibility.responsibilityType === 'collaborator') {
          activeCollaboratorActivities.push({
            activityId: activity.id,
            title: activity.title,
            statusCode: activity.statusCode,
            closure: { status: closure.status },
            responsibilityType: 'collaborator',
          });
        }
      }

      for (const registration of activity.registrations) {
        const hasParticipationEvidence =
          registration.activityCheckIns.length > 0 || registration.attendanceRecords.length > 0;
        const summary: MemberOffboardRegistrationSummary = {
          activityId: activity.id,
          title: activity.title,
          statusCode: activity.statusCode,
          closure: { status: closure.status },
          registrationId: registration.id,
          registrationStatus: registration.statusCode,
          hasParticipationEvidence,
        };
        if (registration.statusCode === 'pass' && hasParticipationEvidence) {
          historicalRegistrationsWithEvidence.push(summary);
        }
        if (
          activity.statusCode === 'published' &&
          activity.endAt.getTime() >= now.getTime() &&
          (registration.statusCode === 'pending' ||
            registration.statusCode === 'waitlisted' ||
            (registration.statusCode === 'pass' && !hasParticipationEvidence))
        ) {
          futureRegistrations.push(summary);
        }
      }
    }

    const blockingReasons: string[] = [];
    if (draftInitiatedActivities.length > 0) {
      blockingReasons.push('draft-initiator-handoff-required');
    }
    if (hasBlockingOwner) {
      blockingReasons.push('active-owner-handoff-required');
    }
    if (futureRegistrations.length > 0) {
      blockingReasons.push('registration-cleanup-required');
    }

    return {
      draftInitiatedActivities,
      activeOwnerActivities,
      activeCollaboratorActivities,
      futureRegistrations,
      historicalRegistrationsWithEvidence,
      canOffboard: blockingReasons.length === 0,
      blockingReasons,
    };
  }
}
