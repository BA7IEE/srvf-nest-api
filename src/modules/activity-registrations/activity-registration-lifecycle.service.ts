import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { CapacityReservationService } from './capacity-reservation.service';

type PrismaTx = Prisma.TransactionClient;

type LockedRegistrationLifecycle = {
  id: string;
  activityId: string;
  memberId: string;
  currentRevision: number;
  currentFormVersionId: string | null;
};

type LockedParticipationLifecycle = {
  id: string;
  activityId: string;
  memberId: string;
  sessionId: string;
  currentRevision: number;
  currentStatusCode: string;
  currentPositionId: string | null;
  capacityReservationId: string | null;
  populationIncluded: boolean;
  version: number;
};

type ActiveCapacityReservation = {
  id: string;
  identityId: string;
  reservationType: string;
  memberId: string | null;
  activityId: string | null;
  bucketActivityId: string;
  bucketScopeTypeCode: string;
  scopeId: string;
  bucketOccupied: number;
  bucketActiveCount: number;
  identityActivityId: string;
  identityMemberId: string;
  identitySessionId: string;
  positionActivityId: string | null;
  positionSessionId: string | null;
};

type ParticipationProjection = {
  id: string;
  activityId: string;
  memberId: string;
  sessionId: string;
  currentRevision: number;
  currentStatusCode: string;
  currentPositionId: string | null;
  capacityReservationId: string | null;
  populationIncluded: boolean;
};

export type RegistrationCancellationSource = 'admin' | 'self';

/**
 * Owns the cross-table projection for one registration cancellation. Callers must already hold
 * the Activity root lock. The capacity kernel remains the only writer of reservations/buckets;
 * this coordinator owns immutable revisions and their current projections.
 */
@Injectable()
export class ActivityRegistrationLifecycleService {
  constructor(private readonly capacityReservations: CapacityReservationService) {}

  async rejectInTransactionTrusted(
    tx: PrismaTx,
    input: {
      activityId: string;
      registrationId: string;
      memberId: string;
      actorUserId: string;
      reviewNote: string;
      reviewedAt: Date;
    },
  ): Promise<void> {
    await this.lockRegistration(tx, input);
    const identities = await this.lockIdentities(tx, input);
    await this.assertCapacityPointersReconciledInTransactionTrusted(tx, identities, {
      activityId: input.activityId,
      memberId: input.memberId,
    });
    await this.assertParticipationRevisionsReconciledInTransactionTrusted(tx, identities);

    const rejectedIdentities: LockedParticipationLifecycle[] = [];
    const occupiedIdentities: LockedParticipationLifecycle[] = [];
    for (const identity of identities) {
      if (identity.currentStatusCode === 'pending' || identity.currentStatusCode === 'waitlisted') {
        this.assertEmptyParticipationProjection(identity);
        rejectedIdentities.push(identity);
        continue;
      }
      if (identity.currentStatusCode === 'pass') {
        if (identity.capacityReservationId === null || !identity.populationIncluded) {
          this.failClosed();
        }
        rejectedIdentities.push(identity);
        occupiedIdentities.push(identity);
        continue;
      }
      if (
        identity.currentStatusCode === 'cancelled' ||
        identity.currentStatusCode === 'rejected' ||
        identity.currentStatusCode === 'not_selected'
      ) {
        this.assertEmptyParticipationProjection(identity);
        continue;
      }
      this.failClosed();
    }

    if (occupiedIdentities.length > 0) {
      await this.capacityReservations.releaseInTransactionTrusted(tx, {
        activityId: input.activityId,
        memberId: input.memberId,
        identityIds: occupiedIdentities.map((identity) => identity.id),
        releaseReason: 'registration_rejected',
      });
    }

    let populationChanged = false;
    for (const identity of rejectedIdentities) {
      const nextRevision = identity.currentRevision + 1;
      await tx.activityParticipationRevision.create({
        data: {
          identityId: identity.id,
          revision: nextRevision,
          statusCode: 'rejected',
          positionId: identity.currentPositionId,
          reviewedByUserId: input.actorUserId,
          reviewedAt: input.reviewedAt,
          reviewNote: input.reviewNote,
          effectiveAt: input.reviewedAt,
          createdByUserId: input.actorUserId,
          sourceCode: 'admin',
        },
      });
      const updated = await tx.activityParticipationIdentity.updateMany({
        where: {
          id: identity.id,
          currentRevision: identity.currentRevision,
          version: identity.version,
        },
        data: {
          currentRevision: nextRevision,
          currentStatusCode: 'rejected',
          currentPositionId: null,
          capacityReservationId: null,
          populationIncluded: false,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) this.failClosed();
      populationChanged ||= identity.populationIncluded;
    }

    if (populationChanged) {
      await this.incrementPopulationRevisionInTransactionTrusted(
        tx,
        input.activityId,
        input.reviewedAt,
      );
    }
  }

  async reopenInTransactionTrusted(
    tx: PrismaTx,
    input: {
      activityId: string;
      registrationId: string;
      memberId: string;
      actorUserId: string;
      reopenedAt: Date;
    },
  ): Promise<void> {
    await this.lockRegistration(tx, input);
    const identities = await this.lockIdentities(tx, input);
    await this.assertCapacityPointersReconciledInTransactionTrusted(tx, identities, {
      activityId: input.activityId,
      memberId: input.memberId,
    });
    await this.assertParticipationRevisionsReconciledInTransactionTrusted(tx, identities);

    const reopenedIdentities: LockedParticipationLifecycle[] = [];
    for (const identity of identities) {
      if (identity.currentStatusCode === 'rejected') {
        this.assertEmptyParticipationProjection(identity);
        reopenedIdentities.push(identity);
        continue;
      }
      if (
        identity.currentStatusCode === 'cancelled' ||
        identity.currentStatusCode === 'not_selected'
      ) {
        this.assertEmptyParticipationProjection(identity);
        continue;
      }
      this.failClosed();
    }

    for (const identity of reopenedIdentities) {
      const nextRevision = identity.currentRevision + 1;
      await tx.activityParticipationRevision.create({
        data: {
          identityId: identity.id,
          revision: nextRevision,
          statusCode: 'pending',
          positionId: null,
          effectiveAt: input.reopenedAt,
          createdByUserId: input.actorUserId,
          sourceCode: 'admin',
        },
      });
      const updated = await tx.activityParticipationIdentity.updateMany({
        where: {
          id: identity.id,
          currentRevision: identity.currentRevision,
          version: identity.version,
        },
        data: {
          currentRevision: nextRevision,
          currentStatusCode: 'pending',
          currentPositionId: null,
          capacityReservationId: null,
          populationIncluded: false,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) this.failClosed();
    }
  }

  async cancelInTransactionTrusted(
    tx: PrismaTx,
    input: {
      activityId: string;
      registrationId: string;
      memberId: string;
      actorUserId: string;
      sourceCode: RegistrationCancellationSource;
      cancelReason: string | null;
      cancelledAt: Date;
    },
  ): Promise<void> {
    const registration = await this.lockRegistration(tx, input);
    const identities = await this.lockIdentities(tx, input);
    await this.assertCapacityPointersReconciledInTransactionTrusted(tx, identities, {
      activityId: input.activityId,
      memberId: input.memberId,
    });
    await this.assertParticipationRevisionsReconciledInTransactionTrusted(tx, identities);
    const cancellableIdentities: LockedParticipationLifecycle[] = [];
    for (const identity of identities) {
      if (
        identity.currentStatusCode === 'pending' ||
        identity.currentStatusCode === 'waitlisted' ||
        identity.currentStatusCode === 'pass'
      ) {
        cancellableIdentities.push(identity);
        continue;
      }
      if (
        identity.currentStatusCode === 'cancelled' ||
        identity.currentStatusCode === 'rejected' ||
        identity.currentStatusCode === 'not_selected'
      ) {
        if (
          identity.capacityReservationId !== null ||
          identity.currentPositionId !== null ||
          identity.populationIncluded
        ) {
          this.failClosed();
        }
        continue;
      }
      this.failClosed();
    }

    if (cancellableIdentities.length > 0) {
      await this.capacityReservations.releaseInTransactionTrusted(tx, {
        activityId: input.activityId,
        memberId: input.memberId,
        identityIds: cancellableIdentities.map((identity) => identity.id),
        releaseReason: 'registration_cancelled',
      });
    }

    const previousRevision =
      registration.currentRevision > 0
        ? await tx.activityRegistrationRevision.findFirst({
            where: {
              registrationId: registration.id,
              revision: registration.currentRevision,
            },
            select: { id: true },
          })
        : null;
    if (registration.currentRevision > 0 && previousRevision === null) this.failClosed();

    const nextRegistrationRevision = registration.currentRevision + 1;
    await tx.activityRegistrationRevision.create({
      data: {
        registrationId: registration.id,
        revision: nextRegistrationRevision,
        formVersionId: registration.currentFormVersionId,
        answersHash: null,
        sourceCode: input.sourceCode,
        submittedByUserId: input.actorUserId,
        submittedAt: input.cancelledAt,
        priorRevisionId: previousRevision?.id ?? null,
        reason: input.cancelReason,
      },
    });

    let populationChanged = false;
    for (const identity of cancellableIdentities) {
      const nextRevision = identity.currentRevision + 1;
      await tx.activityParticipationRevision.create({
        data: {
          identityId: identity.id,
          revision: nextRevision,
          statusCode: 'cancelled',
          positionId: identity.currentPositionId,
          cancelledByUserId: input.actorUserId,
          cancelledAt: input.cancelledAt,
          cancelReason: input.cancelReason,
          effectiveAt: input.cancelledAt,
          createdByUserId: input.actorUserId,
          sourceCode: input.sourceCode,
        },
      });
      const updated = await tx.activityParticipationIdentity.updateMany({
        where: {
          id: identity.id,
          currentRevision: identity.currentRevision,
          version: identity.version,
        },
        data: {
          currentRevision: nextRevision,
          currentStatusCode: 'cancelled',
          currentPositionId: null,
          capacityReservationId: null,
          populationIncluded: false,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) this.failClosed();
      populationChanged ||= identity.populationIncluded;
    }

    const headerUpdated = await tx.activityRegistration.updateMany({
      where: { id: registration.id, currentRevision: registration.currentRevision },
      data: {
        statusCode: 'cancelled',
        currentRevision: nextRegistrationRevision,
        statusSummaryCode: 'cancelled',
        cancelledByUserId: input.actorUserId,
        cancelledAt: input.cancelledAt,
        cancelReason: input.cancelReason,
      },
    });
    if (headerUpdated.count !== 1) this.failClosed();

    if (populationChanged) {
      await this.incrementPopulationRevisionInTransactionTrusted(
        tx,
        input.activityId,
        input.cancelledAt,
      );
    }
  }

  async incrementPopulationRevisionInTransactionTrusted(
    tx: PrismaTx,
    activityId: string,
    now: Date,
  ): Promise<void> {
    const states = await tx.$queryRaw<Array<{ id: string; version: number }>>(Prisma.sql`
      SELECT "id", "version"
      FROM "ActivityEvidenceState"
      WHERE "activityId" = ${activityId}
      FOR UPDATE
    `);
    if (states.length > 1) this.failClosed();
    const state = states[0];
    if (!state) {
      await tx.activityEvidenceState.create({
        data: {
          activityId,
          populationRevision: 1,
          version: 1,
          lastPopulationAt: now,
        },
        select: { id: true },
      });
      return;
    }
    const updated = await tx.activityEvidenceState.updateMany({
      where: { id: state.id, version: state.version },
      data: {
        populationRevision: { increment: 1 },
        version: { increment: 1 },
        lastPopulationAt: now,
      },
    });
    if (updated.count !== 1) this.failClosed();
  }

  async assertCapacityPointersReconciledInTransactionTrusted(
    tx: PrismaTx,
    identities: ReadonlyArray<
      Pick<
        ParticipationProjection,
        | 'id'
        | 'activityId'
        | 'memberId'
        | 'sessionId'
        | 'currentStatusCode'
        | 'currentPositionId'
        | 'capacityReservationId'
        | 'populationIncluded'
      >
    >,
    context: { activityId: string; memberId: string },
  ): Promise<void> {
    const identityById = new Map(identities.map((identity) => [identity.id, identity]));
    if (identityById.size !== identities.length) this.failClosed();
    if (
      identities.some(
        (identity) =>
          identity.activityId !== context.activityId || identity.memberId !== context.memberId,
      )
    ) {
      this.failClosed();
    }
    for (const identity of identities) {
      if (
        identity.currentStatusCode === 'pass' ||
        identity.currentStatusCode === 'attended' ||
        identity.currentStatusCode === 'settled'
      ) {
        if (
          !identity.populationIncluded ||
          (identity.currentStatusCode === 'pass' && identity.capacityReservationId === null)
        ) {
          this.failClosed();
        }
        continue;
      }
      if (
        identity.currentStatusCode === 'pending' ||
        identity.currentStatusCode === 'waitlisted' ||
        identity.currentStatusCode === 'cancelled' ||
        identity.currentStatusCode === 'rejected' ||
        identity.currentStatusCode === 'not_selected'
      ) {
        if (
          identity.capacityReservationId !== null ||
          identity.currentPositionId !== null ||
          identity.populationIncluded
        ) {
          this.failClosed();
        }
      }
    }
    const identityIds =
      identities.length > 0
        ? Prisma.join(identities.map((identity) => identity.id))
        : Prisma.sql`NULL`;
    const reservations = await tx.$queryRaw<ActiveCapacityReservation[]>(Prisma.sql`
      SELECT
        r."id",
        r."identityId",
        r."reservationType",
        r."memberId",
        r."activityId",
        b."activityId" AS "bucketActivityId",
        b."scopeTypeCode" AS "bucketScopeTypeCode",
        b."scopeId",
        b."occupied" AS "bucketOccupied",
        (
          SELECT COUNT(*)::int
          FROM "CapacityReservation" active_for_bucket
          WHERE active_for_bucket."bucketId" = b."id"
            AND active_for_bucket."status" = 'active'
        ) AS "bucketActiveCount",
        i."activityId" AS "identityActivityId",
        i."memberId" AS "identityMemberId",
        i."sessionId" AS "identitySessionId",
        p."activityId" AS "positionActivityId",
        p."sessionId" AS "positionSessionId"
      FROM "CapacityReservation" r
      INNER JOIN "ActivityCapacityBucket" b ON b."id" = r."bucketId"
      INNER JOIN "ActivityParticipationIdentity" i ON i."id" = r."identityId"
      LEFT JOIN "ActivitySessionPosition" p
        ON r."reservationType" = 'position_participation' AND p."id" = b."scopeId"
      WHERE r."status" = 'active'
        AND (
          r."identityId" IN (${identityIds})
          OR (
            r."reservationType" = 'activity_person'
            AND r."memberId" = ${context.memberId}
            AND r."activityId" = ${context.activityId}
          )
        )
      ORDER BY r."id" ASC
      FOR UPDATE OF r
    `);
    let activityPerson: ActiveCapacityReservation | null = null;
    const sessionByIdentity = new Map<string, ActiveCapacityReservation>();
    const positionByIdentity = new Map<string, ActiveCapacityReservation>();
    for (const reservation of reservations) {
      const identity = identityById.get(reservation.identityId);
      if (
        !identity ||
        reservation.identityActivityId !== identity.activityId ||
        reservation.identityMemberId !== identity.memberId ||
        reservation.identitySessionId !== identity.sessionId ||
        reservation.reservationType !== reservation.bucketScopeTypeCode ||
        reservation.bucketOccupied !== reservation.bucketActiveCount
      ) {
        this.failClosed();
      }
      if (reservation.reservationType === 'activity_person') {
        if (
          activityPerson !== null ||
          reservation.memberId !== identity.memberId ||
          reservation.activityId !== identity.activityId ||
          reservation.bucketActivityId !== identity.activityId ||
          reservation.scopeId !== identity.activityId
        ) {
          this.failClosed();
        }
        activityPerson = reservation;
        continue;
      }
      if (
        reservation.memberId !== null ||
        reservation.activityId !== null ||
        reservation.bucketActivityId !== identity.activityId
      ) {
        this.failClosed();
      }
      if (reservation.reservationType === 'session_participation') {
        if (sessionByIdentity.has(identity.id) || reservation.scopeId !== identity.sessionId) {
          this.failClosed();
        }
        sessionByIdentity.set(identity.id, reservation);
        continue;
      }
      if (reservation.reservationType === 'position_participation') {
        if (
          positionByIdentity.has(identity.id) ||
          reservation.positionActivityId !== identity.activityId ||
          reservation.positionSessionId !== identity.sessionId
        ) {
          this.failClosed();
        }
        positionByIdentity.set(identity.id, reservation);
        continue;
      }
      this.failClosed();
    }
    if ((activityPerson !== null) !== sessionByIdentity.size > 0) this.failClosed();
    if ([...positionByIdentity.keys()].some((identityId) => !sessionByIdentity.has(identityId))) {
      this.failClosed();
    }
    for (const identity of identities) {
      const sessionReservation = sessionByIdentity.get(identity.id) ?? null;
      const positionReservation = positionByIdentity.get(identity.id) ?? null;
      if (
        (sessionReservation?.id ?? null) !== identity.capacityReservationId ||
        (positionReservation?.scopeId ?? null) !== identity.currentPositionId
      ) {
        this.failClosed();
      }
    }
  }

  async assertParticipationRevisionsReconciledInTransactionTrusted(
    tx: PrismaTx,
    identities: ReadonlyArray<
      Pick<
        ParticipationProjection,
        'id' | 'currentRevision' | 'currentStatusCode' | 'currentPositionId'
      >
    >,
  ): Promise<void> {
    if (identities.length === 0) return;
    if (identities.some((identity) => identity.currentRevision < 1)) this.failClosed();
    const revisions = await tx.activityParticipationRevision.findMany({
      where: {
        OR: identities.map((identity) => ({
          identityId: identity.id,
          revision: identity.currentRevision,
        })),
      },
      select: { identityId: true, revision: true, statusCode: true, positionId: true },
    });
    if (revisions.length !== identities.length) this.failClosed();
    const revisionByIdentity = new Map(
      revisions.map((revision) => [revision.identityId, revision]),
    );
    for (const identity of identities) {
      const revision = revisionByIdentity.get(identity.id);
      if (
        !revision ||
        revision.revision !== identity.currentRevision ||
        revision.statusCode !== identity.currentStatusCode ||
        (identity.currentStatusCode !== 'cancelled' &&
          identity.currentStatusCode !== 'rejected' &&
          revision.positionId !== identity.currentPositionId)
      ) {
        this.failClosed();
      }
    }
  }

  private async lockRegistration(
    tx: PrismaTx,
    input: { activityId: string; registrationId: string; memberId: string },
  ): Promise<LockedRegistrationLifecycle> {
    const rows = await tx.$queryRaw<LockedRegistrationLifecycle[]>(Prisma.sql`
      SELECT "id", "activityId", "memberId", "currentRevision", "currentFormVersionId"
      FROM "ActivityRegistration"
      WHERE "id" = ${input.registrationId}
        AND "activityId" = ${input.activityId}
        AND "memberId" = ${input.memberId}
        AND "deletedAt" IS NULL
      FOR UPDATE
    `);
    if (rows.length !== 1 || !rows[0]) this.failClosed();
    return rows[0];
  }

  private assertEmptyParticipationProjection(identity: LockedParticipationLifecycle): void {
    if (
      identity.capacityReservationId !== null ||
      identity.currentPositionId !== null ||
      identity.populationIncluded
    ) {
      this.failClosed();
    }
  }

  private async lockIdentities(
    tx: PrismaTx,
    input: { activityId: string; registrationId: string; memberId: string },
  ): Promise<LockedParticipationLifecycle[]> {
    const rows = await tx.$queryRaw<LockedParticipationLifecycle[]>(Prisma.sql`
      SELECT
        "id",
        "activityId",
        "memberId",
        "sessionId",
        "currentRevision",
        "currentStatusCode",
        "currentPositionId",
        "capacityReservationId",
        "populationIncluded",
        "version"
      FROM "ActivityParticipationIdentity"
      WHERE "activityId" = ${input.activityId} AND "memberId" = ${input.memberId}
      ORDER BY "id" ASC
      FOR UPDATE
    `);
    const foreignIdentity = await tx.activityParticipationIdentity.findFirst({
      where: {
        activityId: input.activityId,
        memberId: input.memberId,
        registrationId: { not: input.registrationId },
      },
      select: { id: true },
    });
    if (foreignIdentity !== null) this.failClosed();
    return rows;
  }

  private failClosed(): never {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
}
