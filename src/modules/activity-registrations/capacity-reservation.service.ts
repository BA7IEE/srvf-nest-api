import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';

type PrismaTx = Prisma.TransactionClient;

export type CapacityReservationScopeType =
  | 'activity_person'
  | 'session_participation'
  | 'position_participation';

export interface CapacityReservationSelectionInput {
  identityId: string;
  positionId?: string | null;
}

export interface CapacityReservationReserveInput {
  activityId: string;
  memberId: string;
  selections: readonly CapacityReservationSelectionInput[];
}

export interface CapacityReservationReleaseInput {
  activityId: string;
  memberId: string;
  identityIds: readonly string[];
  releaseReason: string;
}

export type CapacityReservationReserveResult =
  | {
      outcome: 'reserved';
      activityPersonReservationId: string;
      identities: Array<{
        identityId: string;
        sessionReservationId: string;
        positionReservationId: string | null;
      }>;
    }
  | {
      outcome: 'capacity_unavailable';
      scopeTypeCode: CapacityReservationScopeType;
      scopeId: string;
    };

export interface CapacityReservationReleaseResult {
  outcome: 'released';
  releasedReservationIds: string[];
}

export interface CapacityReservationTarget {
  scopeTypeCode: CapacityReservationScopeType;
  scopeId: string;
}

export interface CapacityReservationDelta {
  target: CapacityReservationTarget;
  delta: number;
}

interface NormalizedSelection {
  identityId: string;
  positionId: string | null;
}

interface LockedIdentity {
  id: string;
  activityId: string;
  memberId: string;
  sessionId: string;
}

interface LockedBucket {
  id: string;
  activityId: string;
  scopeTypeCode: CapacityReservationScopeType;
  scopeId: string;
  capacity: number | null;
  occupied: number;
  version: number;
}

interface LockedPosition {
  id: string;
  activityId: string;
  sessionId: string;
  deletedAt: Date | null;
}

interface LockedReservation {
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
}

interface ReservationState {
  activityPerson: LockedReservation | null;
  memberSessionReservations: LockedReservation[];
  sessionByIdentity: ReadonlyMap<string, LockedReservation>;
  positionByIdentity: ReadonlyMap<string, LockedReservation>;
}

interface ReservationCreateIntent {
  target: CapacityReservationTarget;
  identityId: string;
  memberId: string | null;
  activityId: string | null;
}

function targetKey(target: CapacityReservationTarget): string {
  return `${target.scopeTypeCode}:${target.scopeId}`;
}

function compareTargets(left: CapacityReservationTarget, right: CapacityReservationTarget): number {
  return (
    left.scopeTypeCode.localeCompare(right.scopeTypeCode) ||
    left.scopeId.localeCompare(right.scopeId)
  );
}

function compareBucketRows(
  left: Pick<LockedBucket, 'id' | 'scopeTypeCode' | 'scopeId'>,
  right: Pick<LockedBucket, 'id' | 'scopeTypeCode' | 'scopeId'>,
): number {
  return (
    left.scopeTypeCode.localeCompare(right.scopeTypeCode) ||
    left.scopeId.localeCompare(right.scopeId) ||
    left.id.localeCompare(right.id)
  );
}

/** Sorts capacity scopes in the lock and deterministic-unavailable order. */
export function sortCapacityReservationTargets(
  targets: readonly CapacityReservationTarget[],
): CapacityReservationTarget[] {
  return [...targets].sort(compareTargets);
}

/** Deduplicates exact choices and rejects conflicting choices for one permanent identity. */
export function normalizeCapacityReservationSelections(
  selections: readonly CapacityReservationSelectionInput[],
): NormalizedSelection[] | null {
  if (selections.length === 0) return null;
  const byIdentity = new Map<string, string | null>();
  for (const selection of selections) {
    const positionId = selection.positionId ?? null;
    if (!selection.identityId || positionId === '') return null;
    const existing = byIdentity.get(selection.identityId);
    if (existing !== undefined && existing !== positionId) return null;
    byIdentity.set(selection.identityId, positionId);
  }
  return [...byIdentity.entries()]
    .map(([identityId, positionId]) => ({ identityId, positionId }))
    .sort((left, right) => left.identityId.localeCompare(right.identityId));
}

/** Deduplicates identity ids for a release while preserving the repository-wide stable id order. */
export function normalizeCapacityReservationIdentityIds(ids: readonly string[]): string[] | null {
  if (ids.length === 0 || ids.some((id) => !id)) return null;
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}

/** Collapses same-bucket changes so one bucket version advances once per successful transaction. */
export function planCapacityReservationDeltas(
  changes: readonly CapacityReservationDelta[],
): CapacityReservationDelta[] {
  const deltasByTarget = new Map<string, CapacityReservationDelta>();
  for (const change of changes) {
    const key = targetKey(change.target);
    const existing = deltasByTarget.get(key);
    if (existing) {
      existing.delta += change.delta;
    } else {
      deltasByTarget.set(key, { target: { ...change.target }, delta: change.delta });
    }
  }
  return [...deltasByTarget.values()]
    .filter((change) => change.delta !== 0)
    .sort((left, right) => compareTargets(left.target, right.target));
}

/** Returns the first finite scope that would exceed capacity in stable bucket order. */
export function firstUnavailableCapacityTarget(
  buckets: readonly Pick<
    LockedBucket,
    'id' | 'scopeTypeCode' | 'scopeId' | 'capacity' | 'occupied'
  >[],
  deltas: readonly CapacityReservationDelta[],
): CapacityReservationTarget | null {
  const deltaByTarget = new Map(deltas.map((delta) => [targetKey(delta.target), delta.delta]));
  for (const bucket of [...buckets].sort(compareBucketRows)) {
    const delta = deltaByTarget.get(
      targetKey({
        scopeTypeCode: bucket.scopeTypeCode,
        scopeId: bucket.scopeId,
      }),
    );
    if (
      delta !== undefined &&
      delta > 0 &&
      bucket.capacity !== null &&
      bucket.occupied + delta > bucket.capacity
    ) {
      return {
        scopeTypeCode: bucket.scopeTypeCode,
        scopeId: bucket.scopeId,
      };
    }
  }
  return null;
}

export function isCapacityReservationNoop(missingReservationCount: number): boolean {
  return missingReservationCount === 0;
}

/**
 * Owns only reservation and bucket occupancy facts inside a caller-supplied transaction.
 *
 * Lock order is Activity → identity(id ASC) → bucket(scopeTypeCode, scopeId, id) →
 * active reservation(id ASC). It never starts another transaction or writes registration,
 * participation, audit, or outbox state.
 */
@Injectable()
export class CapacityReservationService {
  async reserveInTransactionTrusted(
    tx: PrismaTx,
    input: CapacityReservationReserveInput,
  ): Promise<CapacityReservationReserveResult> {
    const selections = normalizeCapacityReservationSelections(input.selections);
    if (!selections || !input.activityId || !input.memberId) this.failClosed();

    await this.lockActivity(tx, input.activityId);
    const identities = await this.lockIdentities(tx, input.activityId, input.memberId, selections);
    const selectedPositions = await this.lockAndVerifyReservePositions(
      tx,
      input.activityId,
      identities,
      selections,
    );
    const targets = this.reserveTargets(input.activityId, identities, selections);
    const buckets = await this.lockBucketsForSessions(tx, input.activityId, identities);
    const bucketsByTarget = this.assertExactTargetBuckets(buckets, targets, input.activityId);
    const reservations = await this.lockRelatedActiveReservations(
      tx,
      input.activityId,
      input.memberId,
      identities.map((identity) => identity.id),
      buckets.map((bucket) => bucket.id),
    );
    const positions = await this.loadPositionFactsForReservations(
      tx,
      reservations,
      selectedPositions,
    );

    this.assertBucketsReconciled(buckets, reservations);
    this.assertReservationShapes(reservations, positions);
    const state = this.collectReservationState(
      reservations,
      input.activityId,
      input.memberId,
      selections,
    );
    this.assertReserveSelectionsCompatible(state, selections);

    const activityPersonTarget: CapacityReservationTarget = {
      scopeTypeCode: 'activity_person',
      scopeId: input.activityId,
    };
    const createIntents = this.planReserveCreates(
      activityPersonTarget,
      identities,
      selections,
      state,
    );
    if (isCapacityReservationNoop(createIntents.length)) {
      return this.toReserveResult(input.activityId, identities, state, selections, null);
    }

    const deltas = planCapacityReservationDeltas(
      createIntents.map((intent) => ({ target: intent.target, delta: 1 })),
    );
    const unavailable = firstUnavailableCapacityTarget(buckets, deltas);
    if (unavailable) return { outcome: 'capacity_unavailable', ...unavailable };

    const created = await this.createReservations(tx, bucketsByTarget, createIntents);
    await this.applyBucketDeltas(tx, bucketsByTarget, deltas);
    return this.toReserveResult(input.activityId, identities, state, selections, created);
  }

  async releaseInTransactionTrusted(
    tx: PrismaTx,
    input: CapacityReservationReleaseInput,
  ): Promise<CapacityReservationReleaseResult> {
    const identityIds = normalizeCapacityReservationIdentityIds(input.identityIds);
    if (
      !identityIds ||
      !input.activityId ||
      !input.memberId ||
      typeof input.releaseReason !== 'string' ||
      input.releaseReason.trim().length === 0
    ) {
      this.failClosed();
    }

    await this.lockActivity(tx, input.activityId);
    const identities = await this.lockIdentitiesByIds(
      tx,
      input.activityId,
      input.memberId,
      identityIds,
    );
    const buckets = await this.lockBucketsForSessions(tx, input.activityId, identities);
    const requiredTargets = this.releaseRequiredTargets(input.activityId, identities);
    const bucketsByTarget = this.assertExactTargetBuckets(
      buckets,
      requiredTargets,
      input.activityId,
    );
    const reservations = await this.lockRelatedActiveReservations(
      tx,
      input.activityId,
      input.memberId,
      identityIds,
      buckets.map((bucket) => bucket.id),
    );
    const positions = await this.loadPositionFactsForReservations(tx, reservations, new Map());

    this.assertBucketsReconciled(buckets, reservations);
    this.assertReservationShapes(reservations, positions);
    const selections = identities.map((identity) => ({
      identityId: identity.id,
      positionId: null,
    }));
    const state = this.collectReservationState(
      reservations,
      input.activityId,
      input.memberId,
      selections,
    );
    const releasePlan = this.planRelease(state, identities, bucketsByTarget);
    if (releasePlan.reservations.length === 0) {
      return { outcome: 'released', releasedReservationIds: [] };
    }

    this.assertReleaseDeltas(bucketsByTarget, releasePlan.deltas);
    const releasedAt = new Date();
    const releasedReservationIds = await this.releaseReservations(
      tx,
      releasePlan,
      releasedAt,
      input.releaseReason,
    );
    await this.applyBucketDeltas(tx, bucketsByTarget, releasePlan.deltas);
    return { outcome: 'released', releasedReservationIds };
  }

  private async lockActivity(tx: PrismaTx, activityId: string): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "Activity"
      WHERE "id" = ${activityId} AND "deletedAt" IS NULL
      FOR UPDATE
    `);
    if (rows.length !== 1) this.failClosed();
  }

  private async lockIdentities(
    tx: PrismaTx,
    activityId: string,
    memberId: string,
    selections: readonly NormalizedSelection[],
  ): Promise<LockedIdentity[]> {
    return this.lockIdentitiesByIds(
      tx,
      activityId,
      memberId,
      selections.map((selection) => selection.identityId),
    );
  }

  private async lockIdentitiesByIds(
    tx: PrismaTx,
    activityId: string,
    memberId: string,
    identityIds: readonly string[],
  ): Promise<LockedIdentity[]> {
    const rows = await tx.$queryRaw<LockedIdentity[]>(Prisma.sql`
      SELECT "id", "activityId", "memberId", "sessionId"
      FROM "ActivityParticipationIdentity"
      WHERE "id" IN (${Prisma.join(identityIds)})
      ORDER BY "id" ASC
      FOR UPDATE
    `);
    if (
      rows.length !== identityIds.length ||
      rows.some((row) => row.activityId !== activityId || row.memberId !== memberId)
    ) {
      this.failClosed();
    }
    return rows;
  }

  private async lockAndVerifyReservePositions(
    tx: PrismaTx,
    activityId: string,
    identities: readonly LockedIdentity[],
    selections: readonly NormalizedSelection[],
  ): Promise<Map<string, LockedPosition>> {
    const positionIds = selections
      .map((selection) => selection.positionId)
      .filter((positionId): positionId is string => positionId !== null);
    if (positionIds.length === 0) return new Map();
    const rows = await tx.activitySessionPosition.findMany({
      where: { id: { in: positionIds } },
      select: { id: true, activityId: true, sessionId: true, deletedAt: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const identitiesById = new Map(identities.map((identity) => [identity.id, identity]));
    for (const selection of selections) {
      if (!selection.positionId) continue;
      const identity = identitiesById.get(selection.identityId);
      const position = byId.get(selection.positionId);
      if (
        !identity ||
        !position ||
        position.deletedAt !== null ||
        position.activityId !== activityId ||
        position.sessionId !== identity.sessionId
      ) {
        this.failClosed();
      }
    }
    return byId;
  }

  private reserveTargets(
    activityId: string,
    identities: readonly LockedIdentity[],
    selections: readonly NormalizedSelection[],
  ): CapacityReservationTarget[] {
    return sortCapacityReservationTargets([
      { scopeTypeCode: 'activity_person', scopeId: activityId },
      ...identities.map((identity) => ({
        scopeTypeCode: 'session_participation' as const,
        scopeId: identity.sessionId,
      })),
      ...selections
        .filter((selection): selection is NormalizedSelection & { positionId: string } =>
          Boolean(selection.positionId),
        )
        .map((selection) => ({
          scopeTypeCode: 'position_participation' as const,
          scopeId: selection.positionId,
        })),
    ]);
  }

  private releaseRequiredTargets(
    activityId: string,
    identities: readonly LockedIdentity[],
  ): CapacityReservationTarget[] {
    return sortCapacityReservationTargets([
      { scopeTypeCode: 'activity_person', scopeId: activityId },
      ...identities.map((identity) => ({
        scopeTypeCode: 'session_participation' as const,
        scopeId: identity.sessionId,
      })),
    ]);
  }

  private async lockBucketsForSessions(
    tx: PrismaTx,
    activityId: string,
    identities: readonly LockedIdentity[],
  ): Promise<LockedBucket[]> {
    const sessionIds = identities.map((identity) => identity.sessionId);
    return tx.$queryRaw<LockedBucket[]>(Prisma.sql`
      SELECT b."id", b."activityId", b."scopeTypeCode", b."scopeId", b."capacity", b."occupied", b."version"
      FROM "ActivityCapacityBucket" b
      LEFT JOIN "ActivitySessionPosition" p
        ON b."scopeTypeCode" = 'position_participation' AND b."scopeId" = p."id"
      WHERE
        (b."scopeTypeCode" = 'activity_person' AND b."scopeId" = ${activityId})
        OR (b."scopeTypeCode" = 'session_participation' AND b."scopeId" IN (${Prisma.join(sessionIds)}))
        OR (
          b."scopeTypeCode" = 'position_participation'
          AND p."activityId" = ${activityId}
          AND p."sessionId" IN (${Prisma.join(sessionIds)})
        )
      ORDER BY b."scopeTypeCode", b."scopeId", b."id"
      FOR UPDATE OF b
    `);
  }

  private assertExactTargetBuckets(
    buckets: readonly LockedBucket[],
    targets: readonly CapacityReservationTarget[],
    activityId: string,
  ): Map<string, LockedBucket> {
    const targetsByKey = new Map<string, CapacityReservationTarget>();
    for (const target of targets) {
      const key = targetKey(target);
      if (targetsByKey.has(key)) this.failClosed();
      targetsByKey.set(key, target);
    }
    const bucketsByTarget = new Map<string, LockedBucket>();
    for (const bucket of buckets) {
      const key = targetKey({
        scopeTypeCode: bucket.scopeTypeCode,
        scopeId: bucket.scopeId,
      });
      if (bucket.activityId !== activityId || bucketsByTarget.has(key)) this.failClosed();
      bucketsByTarget.set(key, bucket);
    }
    for (const key of targetsByKey.keys()) {
      if (!bucketsByTarget.has(key)) this.failClosed();
    }
    return bucketsByTarget;
  }

  private async lockRelatedActiveReservations(
    tx: PrismaTx,
    activityId: string,
    memberId: string,
    identityIds: readonly string[],
    bucketIds: readonly string[],
  ): Promise<LockedReservation[]> {
    return tx.$queryRaw<LockedReservation[]>(Prisma.sql`
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
        i."sessionId" AS "identitySessionId"
      FROM "CapacityReservation" r
      INNER JOIN "ActivityCapacityBucket" b ON b."id" = r."bucketId"
      INNER JOIN "ActivityParticipationIdentity" i ON i."id" = r."identityId"
      WHERE r."status" = 'active'
        AND (
          r."bucketId" IN (${Prisma.join(bucketIds)})
          OR r."identityId" IN (${Prisma.join(identityIds)})
          OR (
            r."reservationType" = 'activity_person'
            AND r."memberId" = ${memberId}
            AND r."activityId" = ${activityId}
          )
          OR (i."activityId" = ${activityId} AND i."memberId" = ${memberId})
        )
      ORDER BY r."id" ASC
      FOR UPDATE OF r
    `);
  }

  private async loadPositionFactsForReservations(
    tx: PrismaTx,
    reservations: readonly LockedReservation[],
    seed: ReadonlyMap<string, LockedPosition>,
  ): Promise<Map<string, LockedPosition>> {
    const positionIds = reservations
      .filter((reservation) => reservation.reservationType === 'position_participation')
      .map((reservation) => reservation.bucketScopeId);
    const missingPositionIds = [...new Set(positionIds)].filter((id) => !seed.has(id));
    if (missingPositionIds.length === 0) return new Map(seed);
    const rows = await tx.activitySessionPosition.findMany({
      where: { id: { in: missingPositionIds } },
      select: { id: true, activityId: true, sessionId: true, deletedAt: true },
    });
    return new Map<string, LockedPosition>([
      ...seed,
      ...rows.map((row): [string, LockedPosition] => [row.id, row]),
    ]);
  }

  private assertBucketsReconciled(
    buckets: readonly LockedBucket[],
    reservations: readonly LockedReservation[],
  ): void {
    const bucketIds = new Set(buckets.map((bucket) => bucket.id));
    const activeCounts = new Map<string, number>();
    for (const reservation of reservations) {
      if (!bucketIds.has(reservation.bucketId)) continue;
      activeCounts.set(reservation.bucketId, (activeCounts.get(reservation.bucketId) ?? 0) + 1);
    }
    for (const bucket of buckets) {
      if ((activeCounts.get(bucket.id) ?? 0) !== bucket.occupied) this.failClosed();
    }
  }

  private assertReservationShapes(
    reservations: readonly LockedReservation[],
    positions: ReadonlyMap<string, LockedPosition>,
  ): void {
    for (const reservation of reservations) {
      if (reservation.reservationType !== reservation.bucketScopeTypeCode) this.failClosed();
      if (reservation.reservationType === 'activity_person') {
        if (
          !reservation.memberId ||
          !reservation.activityId ||
          reservation.memberId !== reservation.identityMemberId ||
          reservation.activityId !== reservation.identityActivityId ||
          reservation.bucketActivityId !== reservation.activityId ||
          reservation.bucketScopeId !== reservation.activityId
        ) {
          this.failClosed();
        }
        continue;
      }
      if (
        reservation.reservationType !== 'session_participation' &&
        reservation.reservationType !== 'position_participation'
      ) {
        this.failClosed();
      }
      if (
        reservation.memberId !== null ||
        reservation.activityId !== null ||
        reservation.bucketActivityId !== reservation.identityActivityId
      ) {
        this.failClosed();
      }
      if (reservation.reservationType === 'session_participation') {
        if (reservation.bucketScopeId !== reservation.identitySessionId) this.failClosed();
        continue;
      }
      const position = positions.get(reservation.bucketScopeId);
      if (
        !position ||
        position.activityId !== reservation.identityActivityId ||
        position.sessionId !== reservation.identitySessionId
      ) {
        this.failClosed();
      }
    }
  }

  private collectReservationState(
    reservations: readonly LockedReservation[],
    activityId: string,
    memberId: string,
    selections: readonly NormalizedSelection[],
  ): ReservationState {
    const selectedIdentityIds = new Set(selections.map((selection) => selection.identityId));
    const memberRows = reservations.filter(
      (reservation) =>
        reservation.identityActivityId === activityId && reservation.identityMemberId === memberId,
    );
    const activityPersons = reservations.filter(
      (reservation) =>
        reservation.reservationType === 'activity_person' &&
        reservation.memberId === memberId &&
        reservation.activityId === activityId,
    );
    if (activityPersons.length > 1) this.failClosed();

    const allSessionByIdentity = new Map<string, LockedReservation>();
    const allPositionByIdentity = new Map<string, LockedReservation>();
    for (const reservation of memberRows) {
      if (reservation.reservationType === 'session_participation') {
        if (allSessionByIdentity.has(reservation.identityId)) this.failClosed();
        allSessionByIdentity.set(reservation.identityId, reservation);
      }
      if (reservation.reservationType === 'position_participation') {
        if (allPositionByIdentity.has(reservation.identityId)) this.failClosed();
        allPositionByIdentity.set(reservation.identityId, reservation);
      }
    }
    const memberSessionReservations = [...allSessionByIdentity.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    if ((activityPersons.length === 1) !== memberSessionReservations.length > 0) {
      this.failClosed();
    }
    if (
      [...allPositionByIdentity.values()].some(
        (reservation) => !allSessionByIdentity.has(reservation.identityId),
      )
    ) {
      this.failClosed();
    }

    const sessionByIdentity = new Map<string, LockedReservation>();
    const positionByIdentity = new Map<string, LockedReservation>();
    for (const identityId of selectedIdentityIds) {
      const session = allSessionByIdentity.get(identityId);
      const position = allPositionByIdentity.get(identityId);
      if (session) sessionByIdentity.set(identityId, session);
      if (position) positionByIdentity.set(identityId, position);
    }
    return {
      activityPerson: activityPersons[0] ?? null,
      memberSessionReservations,
      sessionByIdentity,
      positionByIdentity,
    };
  }

  private assertReserveSelectionsCompatible(
    state: ReservationState,
    selections: readonly NormalizedSelection[],
  ): void {
    for (const selection of selections) {
      const existingPosition = state.positionByIdentity.get(selection.identityId);
      if (
        existingPosition &&
        (!selection.positionId || existingPosition.bucketScopeId !== selection.positionId)
      ) {
        this.failClosed();
      }
    }
  }

  private planReserveCreates(
    activityPersonTarget: CapacityReservationTarget,
    identities: readonly LockedIdentity[],
    selections: readonly NormalizedSelection[],
    state: ReservationState,
  ): ReservationCreateIntent[] {
    const identitiesById = new Map(identities.map((identity) => [identity.id, identity]));
    const intents: ReservationCreateIntent[] = [];
    const missingSessionSelections = selections.filter(
      (selection) => !state.sessionByIdentity.has(selection.identityId),
    );
    if (missingSessionSelections.length > 0 && !state.activityPerson) {
      intents.push({
        target: activityPersonTarget,
        identityId: selections[0].identityId,
        memberId: identities[0].memberId,
        activityId: identities[0].activityId,
      });
    }
    for (const selection of missingSessionSelections) {
      const identity = identitiesById.get(selection.identityId);
      if (!identity) this.failClosed();
      intents.push({
        target: { scopeTypeCode: 'session_participation', scopeId: identity.sessionId },
        identityId: identity.id,
        memberId: null,
        activityId: null,
      });
    }
    for (const selection of selections) {
      if (!selection.positionId || state.positionByIdentity.has(selection.identityId)) continue;
      intents.push({
        target: { scopeTypeCode: 'position_participation', scopeId: selection.positionId },
        identityId: selection.identityId,
        memberId: null,
        activityId: null,
      });
    }
    return intents.sort(
      (left, right) =>
        compareTargets(left.target, right.target) ||
        left.identityId.localeCompare(right.identityId),
    );
  }

  private async createReservations(
    tx: PrismaTx,
    bucketsByTarget: ReadonlyMap<string, LockedBucket>,
    intents: readonly ReservationCreateIntent[],
  ): Promise<Map<string, string>> {
    const reservationIdsByIntent = new Map<string, string>();
    try {
      for (const intent of intents) {
        const bucket = bucketsByTarget.get(targetKey(intent.target));
        if (!bucket) this.failClosed();
        const created = await tx.capacityReservation.create({
          data: {
            identityId: intent.identityId,
            bucketId: bucket.id,
            reservationType: intent.target.scopeTypeCode,
            memberId: intent.memberId,
            activityId: intent.activityId,
            status: 'active',
          },
          select: { id: true },
        });
        reservationIdsByIntent.set(
          this.reservationIntentKey(intent.target, intent.identityId),
          created.id,
        );
      }
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        this.failClosed();
      }
      throw error;
    }
    return reservationIdsByIntent;
  }

  private async applyBucketDeltas(
    tx: PrismaTx,
    bucketsByTarget: ReadonlyMap<string, LockedBucket>,
    deltas: readonly CapacityReservationDelta[],
  ): Promise<void> {
    for (const delta of deltas) {
      const bucket = bucketsByTarget.get(targetKey(delta.target));
      if (!bucket || bucket.occupied + delta.delta < 0) this.failClosed();
      const updated = await tx.activityCapacityBucket.updateMany({
        where: { id: bucket.id, version: bucket.version, occupied: bucket.occupied },
        data:
          delta.delta > 0
            ? { occupied: { increment: delta.delta }, version: { increment: 1 } }
            : { occupied: { decrement: -delta.delta }, version: { increment: 1 } },
      });
      if (updated.count !== 1) this.failClosed();
    }
  }

  private toReserveResult(
    activityId: string,
    lockedIdentities: readonly LockedIdentity[],
    state: ReservationState,
    selections: readonly NormalizedSelection[],
    created: ReadonlyMap<string, string> | null,
  ): CapacityReservationReserveResult {
    const identitiesById = new Map(lockedIdentities.map((identity) => [identity.id, identity]));
    const activityPersonReservationId =
      state.activityPerson?.id ??
      created?.get(
        this.reservationIntentKey(
          { scopeTypeCode: 'activity_person', scopeId: activityId },
          selections[0].identityId,
        ),
      );
    if (!activityPersonReservationId) this.failClosed();
    const identities = selections.map((selection) => {
      const sessionReservationId =
        state.sessionByIdentity.get(selection.identityId)?.id ??
        created?.get(
          this.reservationIntentKey(
            {
              scopeTypeCode: 'session_participation',
              scopeId: identitiesById.get(selection.identityId)?.sessionId ?? '',
            },
            selection.identityId,
          ),
        );
      if (!sessionReservationId) this.failClosed();
      const positionReservationId = selection.positionId
        ? (state.positionByIdentity.get(selection.identityId)?.id ??
          created?.get(
            this.reservationIntentKey(
              { scopeTypeCode: 'position_participation', scopeId: selection.positionId },
              selection.identityId,
            ),
          ) ??
          null)
        : null;
      return { identityId: selection.identityId, sessionReservationId, positionReservationId };
    });
    return { outcome: 'reserved', activityPersonReservationId, identities };
  }

  private planRelease(
    state: ReservationState,
    identities: readonly LockedIdentity[],
    bucketsByTarget: ReadonlyMap<string, LockedBucket>,
  ): { reservations: LockedReservation[]; deltas: CapacityReservationDelta[] } {
    const identityIds = new Set(identities.map((identity) => identity.id));
    const positions = [...state.positionByIdentity.values()]
      .filter((reservation) => identityIds.has(reservation.identityId))
      .sort((left, right) => left.id.localeCompare(right.id));
    const sessions = [...state.sessionByIdentity.values()]
      .filter((reservation) => identityIds.has(reservation.identityId))
      .sort((left, right) => left.id.localeCompare(right.id));
    if (positions.some((position) => !state.sessionByIdentity.has(position.identityId))) {
      this.failClosed();
    }
    const releasingSessionIds = new Set(sessions.map((session) => session.id));
    const remainingSessions = state.memberSessionReservations.filter(
      (reservation) => !releasingSessionIds.has(reservation.id),
    );
    const activityPerson =
      sessions.length > 0 && remainingSessions.length === 0 ? state.activityPerson : null;
    if (sessions.length > 0 && remainingSessions.length === 0 && !activityPerson) this.failClosed();

    const reservations = [...positions, ...sessions, ...(activityPerson ? [activityPerson] : [])];
    const deltas = planCapacityReservationDeltas(
      reservations.map((reservation) => ({
        target: {
          scopeTypeCode: reservation.bucketScopeTypeCode as CapacityReservationScopeType,
          scopeId: reservation.bucketScopeId,
        },
        delta: -1,
      })),
    );
    for (const delta of deltas) {
      if (!bucketsByTarget.has(targetKey(delta.target))) this.failClosed();
    }
    return { reservations, deltas };
  }

  private assertReleaseDeltas(
    bucketsByTarget: ReadonlyMap<string, LockedBucket>,
    deltas: readonly CapacityReservationDelta[],
  ): void {
    for (const delta of deltas) {
      const bucket = bucketsByTarget.get(targetKey(delta.target));
      if (!bucket || bucket.occupied + delta.delta < 0) this.failClosed();
    }
  }

  private async releaseReservations(
    tx: PrismaTx,
    plan: { reservations: readonly LockedReservation[] },
    releasedAt: Date,
    releaseReason: string,
  ): Promise<string[]> {
    for (const reservation of plan.reservations) {
      const updated = await tx.capacityReservation.updateMany({
        where: { id: reservation.id, status: 'active' },
        data: { status: 'released', releasedAt, releaseReason },
      });
      if (updated.count !== 1) this.failClosed();
    }
    return plan.reservations.map((reservation) => reservation.id);
  }

  private reservationIntentKey(target: CapacityReservationTarget, identityId: string): string {
    return `${targetKey(target)}:${identityId}`;
  }

  private failClosed(): never {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
}
