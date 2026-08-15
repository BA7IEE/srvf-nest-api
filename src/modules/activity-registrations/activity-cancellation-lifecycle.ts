import { Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { deriveRegistrationStatusSummary } from './participation-revision-state-machine';

type PrismaTx = Prisma.TransactionClient;

type LockedRegistration = {
  id: string;
  activityId: string;
  memberId: string;
  statusCode: string;
  statusSummaryCode: string | null;
  currentRevision: number;
  currentFormVersionId: string | null;
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
  revisionStatusCode: string | null;
  revisionPositionId: string | null;
};

type LockedCapacityBucket = {
  id: string;
  activityId: string;
  scopeTypeCode: string;
  scopeId: string;
  occupied: number;
};

type LockedActiveReservation = {
  id: string;
  identityId: string;
  bucketId: string;
  reservationType: string;
  memberId: string | null;
  activityId: string | null;
  bucketActivityId: string;
  bucketScopeTypeCode: string;
  bucketScopeId: string;
  identityActivityId: string;
  identityMemberId: string;
  identitySessionId: string;
  positionActivityId: string | null;
  positionSessionId: string | null;
};

const CANCELLABLE_IDENTITY_STATUSES = new Set(['pending', 'waitlisted']);
const PRESERVED_EMPTY_IDENTITY_STATUSES = new Set([
  'cancelled',
  'rejected',
  'not_selected',
  'review_expired',
  'waitlist_expired',
]);
const PRESERVED_PARTICIPATING_IDENTITY_STATUSES = new Set(['attended', 'settled']);

/**
 * Closes the unresolved canonical projection for a whole-activity cancellation.
 *
 * The caller owns the Activity-root transaction and has already claimed the Activity state.
 * This coordinator deliberately does not release capacity: a `pass` remains an immutable
 * historical approval during whole cancellation, while pending/waitlisted identities must never
 * carry an active reservation. Header-only rows remain the explicitly bounded legacy bridge.
 */
export async function cancelActivityRegistrationLifecycle(args: {
  activityId: string;
  actorUserId: string;
  cancelledAt: Date;
  cancelReason: string;
  tx: PrismaTx;
}): Promise<{ cancelledRegistrationCount: number }> {
  const registrations = await lockRegistrations(args.tx, args.activityId);
  if (registrations.length === 0) return { cancelledRegistrationCount: 0 };

  const registrationById = new Map(
    registrations.map((registration) => [registration.id, registration]),
  );
  const identities = await lockIdentities(
    args.tx,
    args.activityId,
    registrations.map((row) => row.id),
  );
  const identitiesByRegistrationId = new Map<string, LockedIdentity[]>();
  for (const identity of identities) {
    const registration = registrationById.get(identity.registrationId);
    if (
      !registration ||
      identity.activityId !== args.activityId ||
      identity.memberId !== registration.memberId ||
      identity.currentRevision < 1 ||
      identity.revisionStatusCode !== identity.currentStatusCode
    ) {
      failClosed();
    }
    const group = identitiesByRegistrationId.get(identity.registrationId) ?? [];
    group.push(identity);
    identitiesByRegistrationId.set(identity.registrationId, group);
  }

  const revisionedRegistrations = registrations.filter(
    (registration) => registration.currentRevision > 0,
  );
  const priorRevisionByRegistrationId = await lockAndVerifyRegistrationRevisions(
    args.tx,
    revisionedRegistrations,
  );

  for (const registration of registrations) {
    const registrationIdentities = identitiesByRegistrationId.get(registration.id) ?? [];
    if (registrationIdentities.length === 0) {
      if (registration.currentRevision < 0) failClosed();
      continue;
    }
    if (registration.currentRevision < 1 || !priorRevisionByRegistrationId.has(registration.id)) {
      failClosed();
    }

    const currentProjection = deriveRegistrationStatusSummary(
      registrationIdentities.map((identity) => identity.currentStatusCode),
    );
    if (
      registration.statusCode !== currentProjection.statusCode ||
      registration.statusSummaryCode !== currentProjection.statusSummaryCode
    ) {
      failClosed();
    }

    for (const identity of registrationIdentities) {
      if (CANCELLABLE_IDENTITY_STATUSES.has(identity.currentStatusCode)) {
        assertUnresolvedIdentity(identity);
        continue;
      }
      if (identity.currentStatusCode === 'pass') {
        assertPreservedPassIdentity(identity);
        continue;
      }
      if (PRESERVED_PARTICIPATING_IDENTITY_STATUSES.has(identity.currentStatusCode)) {
        assertPreservedParticipatingIdentity(identity);
        continue;
      }
      if (PRESERVED_EMPTY_IDENTITY_STATUSES.has(identity.currentStatusCode)) {
        assertUnresolvedIdentity(identity);
        continue;
      }
      failClosed();
    }
  }
  await assertCapacityReservationsReconciled(args.tx, args.activityId, identities);

  let cancelledRegistrationCount = 0;
  for (const registration of registrations) {
    const registrationIdentities = identitiesByRegistrationId.get(registration.id) ?? [];
    if (registrationIdentities.length === 0) {
      if (registration.statusCode !== 'pending' && registration.statusCode !== 'waitlisted')
        continue;
      const nextRegistrationRevision = registration.currentRevision + 1;
      await args.tx.activityRegistrationRevision.create({
        data: {
          registrationId: registration.id,
          revision: nextRegistrationRevision,
          formVersionId: registration.currentFormVersionId,
          answersHash: null,
          sourceCode: 'admin',
          submittedByUserId: args.actorUserId,
          submittedAt: args.cancelledAt,
          priorRevisionId: priorRevisionByRegistrationId.get(registration.id) ?? null,
          reason: args.cancelReason,
        },
        select: { id: true },
      });
      const updated = await args.tx.activityRegistration.updateMany({
        where: {
          id: registration.id,
          currentRevision: registration.currentRevision,
          statusCode: registration.statusCode,
          deletedAt: null,
        },
        data: {
          currentRevision: nextRegistrationRevision,
          statusCode: 'cancelled',
          statusSummaryCode: 'cancelled',
          cancelledByUserId: args.actorUserId,
          cancelledAt: args.cancelledAt,
          cancelReason: args.cancelReason,
        },
      });
      if (updated.count !== 1) failClosed();
      cancelledRegistrationCount += 1;
      continue;
    }

    const cancellableIdentities = registrationIdentities.filter((identity) =>
      CANCELLABLE_IDENTITY_STATUSES.has(identity.currentStatusCode),
    );
    if (cancellableIdentities.length === 0) continue;

    const nextRegistrationRevision = registration.currentRevision + 1;
    await args.tx.activityRegistrationRevision.create({
      data: {
        registrationId: registration.id,
        revision: nextRegistrationRevision,
        formVersionId: registration.currentFormVersionId,
        answersHash: null,
        sourceCode: 'admin',
        submittedByUserId: args.actorUserId,
        submittedAt: args.cancelledAt,
        priorRevisionId: priorRevisionByRegistrationId.get(registration.id) ?? null,
        reason: args.cancelReason,
      },
      select: { id: true },
    });

    for (const identity of cancellableIdentities) {
      const nextIdentityRevision = identity.currentRevision + 1;
      await args.tx.activityParticipationRevision.create({
        data: {
          identityId: identity.id,
          revision: nextIdentityRevision,
          statusCode: 'cancelled',
          // The current position pointer is deliberately null for an unresolved identity; its
          // immutable revision is the historical position fact that must survive cancellation.
          positionId: identity.revisionPositionId,
          waitlistRank: null,
          cancelledByUserId: args.actorUserId,
          cancelledAt: args.cancelledAt,
          cancelReason: args.cancelReason,
          effectiveAt: args.cancelledAt,
          createdByUserId: args.actorUserId,
          sourceCode: 'admin',
        },
        select: { id: true },
      });
      const updated = await args.tx.activityParticipationIdentity.updateMany({
        where: {
          id: identity.id,
          currentRevision: identity.currentRevision,
          version: identity.version,
        },
        data: {
          currentRevision: nextIdentityRevision,
          currentStatusCode: 'cancelled',
          currentPositionId: null,
          capacityReservationId: null,
          populationIncluded: false,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) failClosed();
    }

    const nextProjection = deriveRegistrationStatusSummary(
      registrationIdentities.map((identity) =>
        CANCELLABLE_IDENTITY_STATUSES.has(identity.currentStatusCode)
          ? 'cancelled'
          : identity.currentStatusCode,
      ),
    );
    const headerUpdated = await args.tx.activityRegistration.updateMany({
      where: {
        id: registration.id,
        currentRevision: registration.currentRevision,
        deletedAt: null,
      },
      data: {
        currentRevision: nextRegistrationRevision,
        statusCode: nextProjection.statusCode,
        statusSummaryCode: nextProjection.statusSummaryCode,
        ...(nextProjection.statusCode === 'cancelled'
          ? {
              cancelledByUserId: args.actorUserId,
              cancelledAt: args.cancelledAt,
              cancelReason: args.cancelReason,
            }
          : {}),
      },
    });
    if (headerUpdated.count !== 1) failClosed();
    cancelledRegistrationCount += 1;
  }

  return { cancelledRegistrationCount };
}

async function lockRegistrations(tx: PrismaTx, activityId: string): Promise<LockedRegistration[]> {
  return await tx.$queryRaw<LockedRegistration[]>(Prisma.sql`
    SELECT
      "id", "activityId", "memberId", "statusCode", "statusSummaryCode",
      "currentRevision", "currentFormVersionId"
    FROM "ActivityRegistration"
    WHERE "activityId" = ${activityId} AND "deletedAt" IS NULL
    ORDER BY "id" ASC
    FOR UPDATE
  `);
}

async function lockIdentities(
  tx: PrismaTx,
  activityId: string,
  registrationIds: readonly string[],
): Promise<LockedIdentity[]> {
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
    -- Lock identities even when a damaged currentRevision has no immutable row. The null
    -- revision projection is then rejected by the caller instead of silently recategorizing
    -- a canonical registration as the legacy no-identity bridge.
    LEFT JOIN "ActivityParticipationRevision" r
      ON r."identityId" = i."id" AND r."revision" = i."currentRevision"
    WHERE i."activityId" = ${activityId}
      AND i."registrationId" IN (${Prisma.join(registrationIds)})
    ORDER BY i."id" ASC
    FOR UPDATE OF i
  `);
}

async function lockAndVerifyRegistrationRevisions(
  tx: PrismaTx,
  registrations: readonly LockedRegistration[],
): Promise<Map<string, string>> {
  if (registrations.length === 0) return new Map();
  const revisions = await tx.$queryRaw<
    Array<{ id: string; registrationId: string; revision: number }>
  >(
    Prisma.sql`
      SELECT "id", "registrationId", "revision"
      FROM "ActivityRegistrationRevision"
      WHERE (${Prisma.join(
        registrations.map(
          (registration) =>
            Prisma.sql`("registrationId" = ${registration.id} AND "revision" = ${registration.currentRevision})`,
        ),
        ' OR ',
      )})
      ORDER BY "registrationId" ASC
      FOR UPDATE
    `,
  );
  if (revisions.length !== registrations.length) failClosed();
  const byRegistrationId = new Map<string, string>();
  for (const revision of revisions) {
    const registration = registrations.find((row) => row.id === revision.registrationId);
    if (
      !registration ||
      revision.revision !== registration.currentRevision ||
      byRegistrationId.has(revision.registrationId)
    ) {
      failClosed();
    }
    byRegistrationId.set(revision.registrationId, revision.id);
  }
  return byRegistrationId;
}

function assertUnresolvedIdentity(identity: LockedIdentity): void {
  if (
    identity.currentPositionId !== null ||
    identity.capacityReservationId !== null ||
    identity.populationIncluded
  ) {
    failClosed();
  }
}

function assertPreservedPassIdentity(identity: LockedIdentity): void {
  if (
    !identity.populationIncluded ||
    identity.capacityReservationId === null ||
    identity.revisionPositionId !== identity.currentPositionId
  ) {
    failClosed();
  }
}

function assertPreservedParticipatingIdentity(identity: LockedIdentity): void {
  if (!identity.populationIncluded || identity.revisionPositionId !== identity.currentPositionId) {
    failClosed();
  }
}

/**
 * This is a read-only reconciliation of the existing capacity kernel's current facts. It does
 * not calculate availability or perform CapacityReservation / bucket DML; the capacity service
 * remains the only writer. Whole cancellation must still reject a drifted active reservation
 * before it preserves pass history or closes another identity in the same outer transaction.
 */
async function assertCapacityReservationsReconciled(
  tx: PrismaTx,
  activityId: string,
  identities: readonly LockedIdentity[],
): Promise<void> {
  const buckets = await tx.$queryRaw<LockedCapacityBucket[]>(Prisma.sql`
    SELECT "id", "activityId", "scopeTypeCode", "scopeId", "occupied"
    FROM "ActivityCapacityBucket"
    WHERE "activityId" = ${activityId}
    ORDER BY "scopeTypeCode" ASC, "scopeId" ASC, "id" ASC
    FOR UPDATE
  `);
  const reservations = await tx.$queryRaw<LockedActiveReservation[]>(Prisma.sql`
    SELECT
      r."id",
      r."identityId",
      r."bucketId",
      r."reservationType",
      r."memberId",
      r."activityId",
      b."activityId" AS "bucketActivityId",
      b."scopeTypeCode" AS "bucketScopeTypeCode",
      b."scopeId" AS "bucketScopeId",
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
      AND (b."activityId" = ${activityId} OR i."activityId" = ${activityId})
    ORDER BY r."id" ASC
    FOR UPDATE OF r
  `);

  const identityById = new Map(identities.map((identity) => [identity.id, identity]));
  const bucketById = new Map(buckets.map((bucket) => [bucket.id, bucket]));
  if (identityById.size !== identities.length || bucketById.size !== buckets.length) failClosed();
  if (buckets.some((bucket) => bucket.activityId !== activityId)) failClosed();

  const activeCountByBucketId = new Map<string, number>();
  const activityPersonByMemberId = new Map<string, LockedActiveReservation>();
  const sessionByIdentityId = new Map<string, LockedActiveReservation>();
  const positionByIdentityId = new Map<string, LockedActiveReservation>();
  for (const reservation of reservations) {
    const identity = identityById.get(reservation.identityId);
    const bucket = bucketById.get(reservation.bucketId);
    if (
      !identity ||
      !bucket ||
      reservation.identityActivityId !== identity.activityId ||
      reservation.identityMemberId !== identity.memberId ||
      reservation.identitySessionId !== identity.sessionId ||
      reservation.bucketActivityId !== bucket.activityId ||
      reservation.bucketScopeTypeCode !== bucket.scopeTypeCode ||
      reservation.bucketScopeId !== bucket.scopeId ||
      reservation.reservationType !== bucket.scopeTypeCode
    ) {
      failClosed();
    }
    activeCountByBucketId.set(
      reservation.bucketId,
      (activeCountByBucketId.get(reservation.bucketId) ?? 0) + 1,
    );

    if (reservation.reservationType === 'activity_person') {
      if (
        reservation.memberId !== identity.memberId ||
        reservation.activityId !== identity.activityId ||
        reservation.bucketScopeId !== identity.activityId ||
        activityPersonByMemberId.has(identity.memberId)
      ) {
        failClosed();
      }
      activityPersonByMemberId.set(identity.memberId, reservation);
      continue;
    }
    if (
      reservation.memberId !== null ||
      reservation.activityId !== null ||
      reservation.bucketActivityId !== identity.activityId
    ) {
      failClosed();
    }
    if (reservation.reservationType === 'session_participation') {
      if (
        reservation.bucketScopeId !== identity.sessionId ||
        sessionByIdentityId.has(identity.id)
      ) {
        failClosed();
      }
      sessionByIdentityId.set(identity.id, reservation);
      continue;
    }
    if (reservation.reservationType === 'position_participation') {
      if (
        reservation.positionActivityId !== identity.activityId ||
        reservation.positionSessionId !== identity.sessionId ||
        positionByIdentityId.has(identity.id)
      ) {
        failClosed();
      }
      positionByIdentityId.set(identity.id, reservation);
      continue;
    }
    failClosed();
  }

  for (const bucket of buckets) {
    if ((activeCountByBucketId.get(bucket.id) ?? 0) !== bucket.occupied) failClosed();
  }

  for (const identity of identities) {
    const sessionReservation = sessionByIdentityId.get(identity.id) ?? null;
    const positionReservation = positionByIdentityId.get(identity.id) ?? null;
    if (
      (sessionReservation?.id ?? null) !== identity.capacityReservationId ||
      (positionReservation?.bucketScopeId ?? null) !== identity.currentPositionId
    ) {
      failClosed();
    }
    if (
      CANCELLABLE_IDENTITY_STATUSES.has(identity.currentStatusCode) ||
      PRESERVED_EMPTY_IDENTITY_STATUSES.has(identity.currentStatusCode)
    ) {
      if (sessionReservation !== null || positionReservation !== null) failClosed();
    }
  }

  const hasSessionByMemberId = new Set(
    identities
      .filter((identity) => sessionByIdentityId.has(identity.id))
      .map((identity) => identity.memberId),
  );
  for (const memberId of new Set(identities.map((identity) => identity.memberId))) {
    if (activityPersonByMemberId.has(memberId) !== hasSessionByMemberId.has(memberId)) {
      failClosed();
    }
  }
}

function failClosed(): never {
  throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
}
