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
  currentRevision: number;
  currentStatusCode: string;
  currentPositionId: string | null;
  capacityReservationId: string | null;
  populationIncluded: boolean;
  version: number;
  revisionStatusCode: string | null;
  revisionPositionId: string | null;
};

const CANCELLABLE_IDENTITY_STATUSES = new Set(['pending', 'waitlisted']);
const PRESERVED_IDENTITY_STATUSES = new Set([
  'pass',
  'attended',
  'settled',
  'cancelled',
  'rejected',
  'not_selected',
  'review_expired',
  'waitlist_expired',
]);

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

  const candidates: LockedIdentity[] = [];
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
        candidates.push(identity);
        continue;
      }
      if (!PRESERVED_IDENTITY_STATUSES.has(identity.currentStatusCode)) failClosed();
    }
  }
  await assertNoActiveReservations(
    args.tx,
    candidates.map((candidate) => candidate.id),
  );

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

async function assertNoActiveReservations(
  tx: PrismaTx,
  identityIds: readonly string[],
): Promise<void> {
  if (identityIds.length === 0) return;
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "CapacityReservation"
    WHERE "identityId" IN (${Prisma.join(identityIds)}) AND "status" = 'active'
    ORDER BY "id" ASC
    FOR UPDATE
  `);
  if (rows.length > 0) failClosed();
}

function failClosed(): never {
  throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
}
