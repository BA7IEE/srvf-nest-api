import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { ActivityInvitationAuditRecorder } from './activity-invitation-audit-recorder';
import { ActivityRegistrationAuditRecorder } from './activity-registration-audit-recorder';
import {
  decideActivityStartExpiry,
  deriveRegistrationStatusSummary,
} from './participation-revision-state-machine';

type PrismaTx = Prisma.TransactionClient;

export const ACTIVITY_RECONCILIATION_JOB_TYPE = 'reconciliation';
const ACTIVITY_START_EXPIRY_OPERATION_PREFIX = 'reconciliation:activity-start-expiry';
const RECONCILIATION_SCAN_LIMIT = 20;

export interface ActivityReconciliationLeaseFence {
  leaseOwner: string;
  leaseGeneration: number;
}

export class ActivityReconciliationLeaseLostError extends Error {
  constructor() {
    super('activity reconciliation lease lost');
    this.name = 'ActivityReconciliationLeaseLostError';
  }
}

export type ActivityStartExpiryResult =
  | { kind: 'succeeded'; expiredIdentityCount: number; expiredInvitationCount: number }
  | { kind: 'rescheduled' }
  | { kind: 'skipped' };

type LockedActivity = {
  id: string;
  statusCode: string;
  startAt: Date;
  deletedAt: Date | null;
};

type LockedJob = {
  id: string;
  activityId: string;
  jobTypeCode: string;
  statusCode: string;
  leaseOwner: string | null;
  leaseGeneration: number;
  leaseExpiresAt: Date | null;
};

type LockedRegistration = {
  id: string;
  activityId: string;
  memberId: string;
  currentRevision: number;
  deletedAt: Date | null;
};

type LockedIdentity = {
  id: string;
  registrationId: string;
  activityId: string;
  memberId: string;
  sessionId: string;
  currentRevision: number;
  currentStatusCode: string;
  currentPositionId: string | null;
  capacityReservationId: string | null;
  populationIncluded: boolean;
  version: number;
  revisionStatusCode: string;
  revisionPositionId: string | null;
};

type LockedInvitation = {
  id: string;
  activityId: string;
  sessionId: string | null;
  positionId: string | null;
  statusCode: string;
  expiresAt: Date;
};

/**
 * The worker-facing reconciliation owner for the canonical registration/invitation chains.
 *
 * It does not touch legacy header-only registration writers.  `ActivityBatchJob` is only the
 * durable trigger and lease fence; the activity, all affected identities/revisions, headers,
 * invitations and audit rows are committed in one Activity-root transaction.
 */
@Injectable()
export class RegistrationReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registrationAudit: ActivityRegistrationAuditRecorder,
    private readonly invitationAudit: ActivityInvitationAuditRecorder,
  ) {}

  /** Creates at most one durable job per already-started published activity. */
  async enqueueDueActivityStartExpiryJobs(now: Date): Promise<number> {
    const activities = await this.prisma.activity.findMany({
      where: {
        deletedAt: null,
        statusCode: 'published',
        batchJobs: { none: { jobTypeCode: ACTIVITY_RECONCILIATION_JOB_TYPE } },
        OR: [
          {
            sessions: {
              some: {
                deletedAt: null,
                statusCode: { not: 'cancelled' },
                startAt: { lte: now },
              },
            },
          },
          {
            startAt: { lte: now },
            sessions: { none: { deletedAt: null, statusCode: { not: 'cancelled' } } },
          },
        ],
      },
      select: { id: true },
      orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
      take: RECONCILIATION_SCAN_LIMIT,
    });

    let enqueued = 0;
    for (const activity of activities) {
      const payload = { kind: 'activity_start_expiry', activityId: activity.id };
      try {
        await this.prisma.activityBatchJob.create({
          data: {
            jobTypeCode: ACTIVITY_RECONCILIATION_JOB_TYPE,
            activityId: activity.id,
            statusCode: 'pending',
            operationKey: `${ACTIVITY_START_EXPIRY_OPERATION_PREFIX}:${activity.id}`,
            requestHash: stablePayloadHash(payload),
            payloadVersion: 1,
            payload,
            availableAt: now,
          },
          select: { id: true },
        });
        enqueued += 1;
      } catch (error) {
        // Another worker may have created the same unique operationKey after the scan.  That is
        // normal contention, not a reason to stop the whole worker round.
        if ((error as { code?: unknown } | null)?.code !== 'P2002') throw error;
      }
    }
    return enqueued;
  }

  async expireAtActivityStart(
    input: { jobId: string; activityId: string; fence: ActivityReconciliationLeaseFence },
  ): Promise<ActivityStartExpiryResult> {
    return await this.prisma.$transaction(async (tx) => {
      // Canonical lock order begins at the Activity aggregate root; the job fence follows it.
      const activity = await this.lockActivity(tx, input.activityId);
      const now = await this.readAuthoritativeNow(tx);
      const job = await this.lockAndVerifyJob(tx, input, now);

      if (activity.deletedAt !== null || activity.statusCode !== 'published') {
        await this.markSucceeded(tx, job, input.fence, now);
        return { kind: 'skipped' };
      }

      const firstStartAt = await this.firstSessionStart(tx, activity);
      if (now.getTime() < firstStartAt.getTime()) {
        await this.reschedule(tx, job, input.fence, firstStartAt);
        return { kind: 'rescheduled' };
      }

      const candidateRows = await tx.$queryRaw<Array<{ id: string; registrationId: string }>>(
        Prisma.sql`
          SELECT "id", "registrationId"
          FROM "ActivityParticipationIdentity"
          WHERE "activityId" = ${activity.id}
            AND "currentStatusCode" IN ('pending', 'waitlisted')
          ORDER BY "id" ASC
        `,
      );
      const candidateIds = new Set(candidateRows.map((row) => row.id));
      const registrationIds = [...new Set(candidateRows.map((row) => row.registrationId))];
      const registrations = await this.lockRegistrations(tx, activity.id, registrationIds);
      const identities = await this.lockIdentities(tx, activity.id, registrationIds);
      const identityById = new Map(identities.map((identity) => [identity.id, identity]));
      if (candidateIds.size !== candidateRows.length || candidateIds.size === 0) {
        if (candidateIds.size !== candidateRows.length) this.failClosed();
      }
      for (const candidateId of candidateIds) {
        const identity = identityById.get(candidateId);
        if (!identity) this.failClosed();
        this.assertExpiryIdentityInvariant(identity);
      }
      await this.assertNoActiveReservations(tx, [...candidateIds]);

      const nextStatusByIdentityId = new Map<
        string,
        'review_expired' | 'waitlist_expired'
      >();
      for (const identity of identities) {
        const decision = decideActivityStartExpiry(identity.currentStatusCode);
        if (decision.kind === 'append') nextStatusByIdentityId.set(identity.id, decision.statusCode);
      }
      if (nextStatusByIdentityId.size !== candidateIds.size) this.failClosed();

      for (const identity of identities) {
        const nextStatusCode = nextStatusByIdentityId.get(identity.id);
        if (!nextStatusCode) continue;
        const nextRevision = identity.currentRevision + 1;
        await tx.activityParticipationRevision.create({
          data: {
            identityId: identity.id,
            revision: nextRevision,
            statusCode: nextStatusCode,
            // A waitlist identity keeps its original position only in immutable history; current
            // pointers are cleared so it cannot later be promoted after activity start.
            positionId: identity.revisionPositionId,
            waitlistRank: null,
            effectiveAt: now,
            createdByUserId: null,
            sourceCode: 'system',
          },
          select: { id: true },
        });
        const updated = await tx.activityParticipationIdentity.updateMany({
          where: {
            id: identity.id,
            currentRevision: identity.currentRevision,
            version: identity.version,
          },
          data: {
            currentRevision: nextRevision,
            currentStatusCode: nextStatusCode,
            currentPositionId: null,
            capacityReservationId: null,
            populationIncluded: false,
            version: { increment: 1 },
          },
        });
        if (updated.count !== 1) this.failClosed();
      }

      const nextStatusesByRegistration = new Map<string, string[]>();
      for (const identity of identities) {
        const statuses = nextStatusesByRegistration.get(identity.registrationId) ?? [];
        statuses.push(nextStatusByIdentityId.get(identity.id) ?? identity.currentStatusCode);
        nextStatusesByRegistration.set(identity.registrationId, statuses);
      }
      const registrationById = new Map(registrations.map((registration) => [registration.id, registration]));
      for (const [registrationId, statuses] of nextStatusesByRegistration) {
        const registration = registrationById.get(registrationId);
        if (!registration) this.failClosed();
        const projection = deriveRegistrationStatusSummary(statuses);
        const updated = await tx.activityRegistration.updateMany({
          where: {
            id: registration.id,
            currentRevision: registration.currentRevision,
            deletedAt: null,
          },
          data: projection,
        });
        if (updated.count !== 1) this.failClosed();
      }

      for (const identity of identities) {
        const nextStatusCode = nextStatusByIdentityId.get(identity.id);
        if (!nextStatusCode) continue;
        if (identity.currentStatusCode !== 'pending' && identity.currentStatusCode !== 'waitlisted') {
          this.failClosed();
        }
        await this.registrationAudit.logActivityStartExpiry({
          registrationId: identity.registrationId,
          activityId: activity.id,
          participationIdentityId: identity.id,
          priorStatusCode: identity.currentStatusCode,
          nextStatusCode,
          auditMeta: { requestId: `activity-batch-worker:${job.id}`, ip: null, ua: null },
          tx,
        });
      }

      const invitations = await this.lockPendingInvitations(tx, activity.id);
      for (const invitation of invitations) {
        const updated = await tx.activityInvitation.updateMany({
          where: { id: invitation.id, statusCode: 'pending' },
          data: { statusCode: 'expired' },
        });
        if (updated.count !== 1) this.failClosed();
        await this.invitationAudit.logInvitationChange({
          invitation: { ...invitation, statusCode: 'expired' },
          before: invitation,
          actorUserId: null,
          actorRoleSnap: null,
          operation: 'expire',
          auditMeta: { requestId: `activity-batch-worker:${job.id}`, ip: null, ua: null },
          tx,
        });
      }

      await this.markSucceeded(tx, job, input.fence, now);
      return {
        kind: 'succeeded',
        expiredIdentityCount: nextStatusByIdentityId.size,
        expiredInvitationCount: invitations.length,
      };
    });
  }

  private async lockActivity(tx: PrismaTx, activityId: string): Promise<LockedActivity> {
    const rows = await tx.$queryRaw<LockedActivity[]>(Prisma.sql`
      SELECT "id", "statusCode", "startAt", "deletedAt"
      FROM "Activity"
      WHERE "id" = ${activityId}
      FOR UPDATE
    `);
    if (rows.length !== 1 || !rows[0]) this.failClosed();
    return rows[0];
  }

  private async lockAndVerifyJob(
    tx: PrismaTx,
    input: { jobId: string; activityId: string; fence: ActivityReconciliationLeaseFence },
    now: Date,
  ): Promise<LockedJob> {
    const rows = await tx.$queryRaw<LockedJob[]>(Prisma.sql`
      SELECT
        "id", "activityId", "jobTypeCode", "statusCode", "leaseOwner",
        "leaseGeneration", "leaseExpiresAt"
      FROM "ActivityBatchJob"
      WHERE "id" = ${input.jobId}
      FOR UPDATE
    `);
    const job = rows[0];
    if (
      rows.length !== 1 ||
      !job ||
      job.activityId !== input.activityId ||
      job.jobTypeCode !== ACTIVITY_RECONCILIATION_JOB_TYPE ||
      job.statusCode !== 'processing' ||
      job.leaseOwner !== input.fence.leaseOwner ||
      job.leaseGeneration !== input.fence.leaseGeneration ||
      job.leaseExpiresAt === null ||
      job.leaseExpiresAt.getTime() <= now.getTime()
    ) {
      throw new ActivityReconciliationLeaseLostError();
    }
    return job;
  }

  private async firstSessionStart(tx: PrismaTx, activity: LockedActivity): Promise<Date> {
    const session = await tx.activitySession.findFirst({
      where: {
        activityId: activity.id,
        deletedAt: null,
        statusCode: { not: 'cancelled' },
      },
      orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
      select: { startAt: true },
    });
    return session?.startAt ?? activity.startAt;
  }

  private async lockRegistrations(
    tx: PrismaTx,
    activityId: string,
    registrationIds: readonly string[],
  ): Promise<LockedRegistration[]> {
    if (registrationIds.length === 0) return [];
    const rows = await tx.$queryRaw<LockedRegistration[]>(Prisma.sql`
      SELECT "id", "activityId", "memberId", "currentRevision", "deletedAt"
      FROM "ActivityRegistration"
      WHERE "id" IN (${Prisma.join(registrationIds)})
      ORDER BY "id" ASC
      FOR UPDATE
    `);
    if (
      rows.length !== registrationIds.length ||
      rows.some((registration) => registration.activityId !== activityId || registration.deletedAt !== null)
    ) {
      this.failClosed();
    }
    return rows;
  }

  private async lockIdentities(
    tx: PrismaTx,
    activityId: string,
    registrationIds: readonly string[],
  ): Promise<LockedIdentity[]> {
    if (registrationIds.length === 0) return [];
    return await tx.$queryRaw<LockedIdentity[]>(Prisma.sql`
      SELECT
        i."id",
        i."registrationId",
        i."activityId",
        i."memberId",
        i."sessionId",
        i."currentRevision",
        i."currentStatusCode",
        i."currentPositionId",
        i."capacityReservationId",
        i."populationIncluded",
        i."version",
        r."statusCode" AS "revisionStatusCode",
        r."positionId" AS "revisionPositionId"
      FROM "ActivityParticipationIdentity" i
      INNER JOIN "ActivityParticipationRevision" r
        ON r."identityId" = i."id" AND r."revision" = i."currentRevision"
      WHERE i."activityId" = ${activityId}
        AND i."registrationId" IN (${Prisma.join(registrationIds)})
      ORDER BY i."id" ASC
      FOR UPDATE OF i, r
    `);
  }

  private assertExpiryIdentityInvariant(identity: LockedIdentity): void {
    if (
      identity.currentRevision < 1 ||
      identity.revisionStatusCode !== identity.currentStatusCode ||
      identity.currentPositionId !== null ||
      identity.capacityReservationId !== null ||
      identity.populationIncluded
    ) {
      this.failClosed();
    }
  }

  private async assertNoActiveReservations(tx: PrismaTx, identityIds: readonly string[]): Promise<void> {
    if (identityIds.length === 0) return;
    const rows = await tx.$queryRaw<Array<{ identityId: string }>>(Prisma.sql`
      SELECT "identityId"
      FROM "CapacityReservation"
      WHERE "identityId" IN (${Prisma.join(identityIds)}) AND "status" = 'active'
      ORDER BY "id" ASC
      FOR UPDATE
    `);
    if (rows.length > 0) this.failClosed();
  }

  private async lockPendingInvitations(
    tx: PrismaTx,
    activityId: string,
  ): Promise<LockedInvitation[]> {
    return await tx.$queryRaw<LockedInvitation[]>(Prisma.sql`
      SELECT "id", "activityId", "sessionId", "positionId", "statusCode", "expiresAt"
      FROM "ActivityInvitation"
      WHERE "activityId" = ${activityId} AND "statusCode" = 'pending'
      ORDER BY "id" ASC
      FOR UPDATE
    `);
  }

  private async readAuthoritativeNow(tx: PrismaTx): Promise<Date> {
    const rows = await tx.$queryRaw<Array<{ authoritativeNow: Date }>>`
      SELECT now() AS "authoritativeNow"
    `;
    const now = rows[0]?.authoritativeNow;
    if (!now) this.failClosed();
    return now;
  }

  private async reschedule(
    tx: PrismaTx,
    job: LockedJob,
    fence: ActivityReconciliationLeaseFence,
    availableAt: Date,
  ): Promise<void> {
    const updated = await tx.activityBatchJob.updateMany({
      where: {
        id: job.id,
        statusCode: 'processing',
        leaseOwner: fence.leaseOwner,
        leaseGeneration: fence.leaseGeneration,
      },
      data: {
        statusCode: 'pending',
        leaseOwner: null,
        leaseExpiresAt: null,
        availableAt,
        completedAt: null,
        lastErrorCode: null,
      },
    });
    if (updated.count !== 1) throw new ActivityReconciliationLeaseLostError();
  }

  private async markSucceeded(
    tx: PrismaTx,
    job: LockedJob,
    fence: ActivityReconciliationLeaseFence,
    completedAt: Date,
  ): Promise<void> {
    const updated = await tx.activityBatchJob.updateMany({
      where: {
        id: job.id,
        statusCode: 'processing',
        leaseOwner: fence.leaseOwner,
        leaseGeneration: fence.leaseGeneration,
      },
      data: {
        statusCode: 'succeeded',
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt,
        lastErrorCode: null,
      },
    });
    if (updated.count !== 1) throw new ActivityReconciliationLeaseLostError();
  }

  private failClosed(): never {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
}

function stablePayloadHash(payload: { kind: string; activityId: string }): string {
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}
