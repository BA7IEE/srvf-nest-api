import { Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { CapacityReservationReserveResult } from './capacity-reservation.service';
import { compareUtf8, type AllocationModeCode } from './activity-allocation-request-hash';
import type {
  FirstComeWaitlistRow,
  FreedAllocationSlot,
  LockedApplicationProjection,
  LockedBatchPromotionCandidate,
  PrismaTx,
  ProjectedReservationRow,
  PromotionWaitlistCandidate,
  ReservationAnchors,
} from './activity-allocation.types';

/*
 * 活动名额分配的**锁定读取层**(Phase 6-B 第五域第二刀)。
 *
 * 六个函数的共同形态:在**调用方已开启的事务**里加锁、按确定顺序读出事实,再做一致性断言。
 * 它们实测**零 `this.` 注入依赖** —— 只吃传入的 `tx`,故为模块级纯函数而非 @Injectable:
 * 不进 DI 图,两个 module 都无需改注册(#1034 曾因漏注册第二个 module 导致 Nest 起不来)。
 *
 * ⚠️ 锁序:本层是**被调用方**而非事务起点 —— 它在调用方的事务中间加锁,
 * 因此**调用顺序即锁顺序**。把任意两个 lock* 的调用位置对调,或把某个 lock* 移到
 * 调用链更早/更晚处,都会改变全局取锁次序,**而不会有任何编译错或测试失败**。
 * 唯一的权威次序在 activity-allocation.service.ts 各命令方法的调用序列里,本文件不复制它。
 *
 * 另:多处 `ORDER BY` 是**死锁防线**(同批次并发命令按同一顺序取锁),不是为了输出有序。
 */

export async function lockBatchWaitlistHead(
  tx: PrismaTx,
  activityId: string,
  slot: FreedAllocationSlot,
  expectedModeCode: AllocationModeCode,
): Promise<PromotionWaitlistCandidate | null> {
  if (slot.allocationBatchId === null) {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
  const rows = await tx.$queryRaw<LockedBatchPromotionCandidate[]>(Prisma.sql`
      SELECT
        c."participationIdentityId", c."registrationId", i."memberId", i."sessionId",
        c."activityId" AS "candidateActivityId", c."sessionId" AS "candidateSessionId",
        c."waitlistPositionId", pr."positionId", c."allocationBatchId", c."waitlistRank", c."acceptedAt",
        pr."preferenceSnapshot", i."currentRevision" AS "identityRevision",
        i."version" AS "identityVersion", i."currentStatusCode", i."currentPositionId",
        i."capacityReservationId", i."populationIncluded", b."modeCode" AS "batchModeCode",
        b."statusCode" AS "batchStatusCode", b."positionId" AS "batchPositionId",
        projection."id" AS "applicationProjectionId",
        projection."appliedResultCode", projection."appliedStatusCode",
        projection."positionId" AS "appliedPositionId",
        projection."populationIncluded" AS "appliedPopulationIncluded",
        projection."expectedIdentityCapacityReservationId" AS "appliedExpectedReservationId",
        projection."activityPersonReservationId" AS "appliedActivityReservationId",
        projection."sessionReservationId" AS "appliedSessionReservationId",
        projection."positionReservationId" AS "appliedPositionReservationId"
      FROM "ActivityAllocationCandidate" c
      INNER JOIN "ActivityAllocationBatch" b ON b."id" = c."allocationBatchId"
      INNER JOIN "ActivityParticipationIdentity" i ON i."id" = c."participationIdentityId"
      INNER JOIN "ActivityParticipationRevision" pr
        ON pr."identityId" = i."id" AND pr."revision" = i."currentRevision"
      LEFT JOIN "ActivityAllocationApplicationProjection" projection
        ON projection."allocationCandidateId" = c."id"
      WHERE c."allocationBatchId" = ${slot.allocationBatchId}
        AND c."resultCode" = 'waitlisted'
        AND c."waitlistRank" IS NOT NULL
        AND c."activityId" = ${activityId}
        AND c."sessionId" = ${slot.sessionId}
        AND c."waitlistPositionId" IS NOT DISTINCT FROM ${slot.positionId}
        AND b."activityId" = ${activityId}
        AND b."sessionId" = ${slot.sessionId}
        AND b."statusCode" = 'committed'
        AND i."activityId" = ${activityId}
        AND i."sessionId" = ${slot.sessionId}
        AND i."currentStatusCode" = 'waitlisted'
        AND pr."statusCode" = 'waitlisted'
        AND pr."allocationBatchId" = c."allocationBatchId"
        AND pr."positionId" IS NOT DISTINCT FROM ${slot.positionId}
      ORDER BY c."id" ASC
      FOR UPDATE OF c, b, i, pr
    `);
  if (rows.length === 0) return null;
  if (
    rows.some(
      (row) =>
        row.batchModeCode !== expectedModeCode ||
        row.batchStatusCode !== 'committed' ||
        row.candidateActivityId !== activityId ||
        row.candidateSessionId !== slot.sessionId ||
        row.waitlistPositionId !== slot.positionId ||
        (row.batchPositionId !== null && row.batchPositionId !== slot.positionId) ||
        row.waitlistRank === null ||
        row.waitlistRank < 1 ||
        row.positionId !== slot.positionId ||
        row.currentStatusCode !== 'waitlisted' ||
        row.currentPositionId !== null ||
        row.capacityReservationId !== null ||
        row.populationIncluded ||
        row.applicationProjectionId === null ||
        row.appliedResultCode !== 'waitlisted' ||
        row.appliedStatusCode !== 'waitlisted' ||
        row.appliedPositionId !== null ||
        row.appliedPopulationIncluded !== false ||
        row.appliedExpectedReservationId !== null ||
        row.appliedActivityReservationId !== null ||
        row.appliedSessionReservationId !== null ||
        row.appliedPositionReservationId !== null,
    )
  ) {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
  const queue = [...rows].sort(
    (left, right) =>
      left.waitlistRank - right.waitlistRank ||
      compareUtf8(left.participationIdentityId, right.participationIdentityId),
  );
  if (
    new Set(queue.map((row) => row.waitlistRank)).size !== queue.length ||
    new Set(queue.map((row) => row.participationIdentityId)).size !== queue.length
  ) {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
  return queue[0] ?? null;
}

export async function lockFirstComeWaitlistHead(
  tx: PrismaTx,
  activityId: string,
  slot: FreedAllocationSlot,
): Promise<PromotionWaitlistCandidate | null> {
  const rows = await tx.$queryRaw<PromotionWaitlistCandidate[]>(Prisma.sql`
      SELECT
        i."id" AS "participationIdentityId", i."registrationId", i."memberId", i."sessionId",
        pr."positionId", pr."allocationBatchId", pr."waitlistRank",
        pr."effectiveAt" AS "acceptedAt", pr."preferenceSnapshot",
        i."currentRevision" AS "identityRevision", i."version" AS "identityVersion",
        i."currentStatusCode", i."currentPositionId", i."capacityReservationId", i."populationIncluded"
      FROM "ActivityParticipationIdentity" i
      INNER JOIN "ActivityParticipationRevision" pr
        ON pr."identityId" = i."id" AND pr."revision" = i."currentRevision"
      WHERE i."activityId" = ${activityId}
        AND i."sessionId" = ${slot.sessionId}
        AND i."currentStatusCode" = 'waitlisted'
        AND pr."statusCode" = 'waitlisted'
        AND pr."allocationBatchId" IS NULL
        AND pr."sourceCode" IN ('self', 'invitation')
        AND pr."requestKey" IS NOT NULL
        AND pr."positionId" IS NOT DISTINCT FROM ${slot.positionId}
      ORDER BY i."id" ASC
      FOR UPDATE OF i, pr
    `);
  if (rows.length === 0) return null;
  if (
    rows.some(
      (row) =>
        row.allocationBatchId !== null ||
        row.waitlistRank === null ||
        row.waitlistRank < 1 ||
        row.positionId !== slot.positionId ||
        row.currentStatusCode !== 'waitlisted' ||
        row.currentPositionId !== null ||
        row.capacityReservationId !== null ||
        row.populationIncluded,
    )
  ) {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
  const queue = [...rows].sort(
    (left, right) =>
      left.acceptedAt.getTime() - right.acceptedAt.getTime() ||
      compareUtf8(left.participationIdentityId, right.participationIdentityId),
  );
  if (new Set(queue.map((row) => row.participationIdentityId)).size !== queue.length) {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
  return queue[0] ?? null;
}

export async function lockApplicationProjections(
  tx: PrismaTx,
  allocationBatchId: string,
): Promise<LockedApplicationProjection[]> {
  return tx.$queryRaw<LockedApplicationProjection[]>(Prisma.sql`
      SELECT
        "id", "allocationCandidateId", "participationIdentityId", "memberId",
        "appliedParticipationRevisionId", "appliedResultCode", "appliedStatusCode", "positionId",
        "populationIncluded", "expectedIdentityCapacityReservationId",
        "activityPersonReservationId", "activityPersonBucketId", "sessionReservationId",
        "sessionBucketId", "positionReservationId", "positionBucketId"
      FROM "ActivityAllocationApplicationProjection"
      WHERE "allocationBatchId" = ${allocationBatchId}
      ORDER BY "allocationCandidateId" ASC
      FOR UPDATE
    `);
}

export async function assertProjectedReservationsExact(
  tx: PrismaTx,
  activityId: string,
  projections: readonly LockedApplicationProjection[],
): Promise<void> {
  const allocated = projections.filter(
    (projection) => projection.appliedResultCode === 'allocated',
  );
  const reservationIds = [
    ...new Set(
      allocated.flatMap((projection) => [
        projection.activityPersonReservationId!,
        projection.sessionReservationId!,
        ...(projection.positionReservationId ? [projection.positionReservationId] : []),
      ]),
    ),
  ].sort(compareUtf8);
  if (reservationIds.length === 0) return;
  const rows = await tx.$queryRaw<ProjectedReservationRow[]>(Prisma.sql`
      SELECT
        r."id", r."identityId", r."reservationType", r."memberId", r."activityId",
        r."bucketId", r."status", b."occupied" AS "bucketOccupied",
        (SELECT COUNT(*)::int FROM "CapacityReservation" active_for_bucket
         WHERE active_for_bucket."bucketId" = b."id" AND active_for_bucket."status" = 'active')
          AS "bucketActiveCount"
      FROM "CapacityReservation" r
      INNER JOIN "ActivityCapacityBucket" b ON b."id" = r."bucketId"
      WHERE r."id" IN (${Prisma.join(reservationIds)}) AND b."activityId" = ${activityId}
      ORDER BY r."id" ASC
      FOR UPDATE OF r, b
    `);
  if (rows.length !== reservationIds.length) {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const projection of allocated) {
    const activityPerson = byId.get(projection.activityPersonReservationId!);
    const session = byId.get(projection.sessionReservationId!);
    const position = projection.positionReservationId
      ? byId.get(projection.positionReservationId)
      : null;
    const positionInvalid =
      projection.positionReservationId === null
        ? position !== null
        : !position ||
          position.status !== 'active' ||
          position.reservationType !== 'position_participation' ||
          position.identityId !== projection.participationIdentityId ||
          position.bucketId !== projection.positionBucketId;
    if (
      !activityPerson ||
      !session ||
      activityPerson.status !== 'active' ||
      session.status !== 'active' ||
      activityPerson.reservationType !== 'activity_person' ||
      session.reservationType !== 'session_participation' ||
      activityPerson.memberId !== projection.memberId ||
      activityPerson.activityId !== activityId ||
      activityPerson.bucketId !== projection.activityPersonBucketId ||
      session.identityId !== projection.participationIdentityId ||
      session.bucketId !== projection.sessionBucketId ||
      positionInvalid ||
      [activityPerson, session, ...(position ? [position] : [])].some(
        (row) => row.bucketOccupied !== row.bucketActiveCount,
      )
    ) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
  }
}

export async function firstComeWaitlistRank(
  tx: PrismaTx,
  input: {
    activityId: string;
    sessionId: string;
    positionId: string | null;
    participationIdentityId: string;
    acceptedAt: Date;
  },
): Promise<number> {
  const rows = await tx.$queryRaw<FirstComeWaitlistRow[]>(Prisma.sql`
      SELECT
        i."id" AS "participationIdentityId",
        pr."effectiveAt" AS "acceptedAt",
        pr."waitlistRank",
        i."currentPositionId", i."capacityReservationId", i."populationIncluded"
      FROM "ActivityParticipationIdentity" i
      INNER JOIN "ActivityParticipationRevision" pr
        ON pr."identityId" = i."id" AND pr."revision" = i."currentRevision"
      WHERE i."activityId" = ${input.activityId}
        AND i."sessionId" = ${input.sessionId}
        AND i."currentStatusCode" = 'waitlisted'
        AND pr."statusCode" = 'waitlisted'
        AND pr."allocationBatchId" IS NULL
        AND pr."positionId" IS NOT DISTINCT FROM ${input.positionId}
      FOR UPDATE OF i, pr
    `);
  if (
    rows.some(
      (row) =>
        row.waitlistRank === null ||
        row.waitlistRank < 1 ||
        row.currentPositionId !== null ||
        row.capacityReservationId !== null ||
        row.populationIncluded,
    )
  ) {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
  const ranks = rows.map((row) => row.waitlistRank!);
  if (
    new Set(ranks).size !== ranks.length ||
    new Set(rows.map((row) => row.participationIdentityId)).size !== rows.length
  ) {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
  // Revisions are append-only: a departure must not rewrite the ranks stored on earlier queue
  // facts. Actual promotion always re-sorts by acceptedAt + UTF-8 identity below; this ordinal
  // is only a durable entry sequence and therefore deliberately permits gaps after departures.
  return Math.max(0, ...ranks) + 1;
}

export async function readReservationAnchors(
  tx: PrismaTx,
  identityId: string,
  positionId: string | null,
  reservation: Extract<CapacityReservationReserveResult, { outcome: 'reserved' }>,
): Promise<ReservationAnchors> {
  const identityReservation = reservation.identities.find(
    (candidate) => candidate.identityId === identityId,
  );
  if (!identityReservation) throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  if (
    (positionId === null && identityReservation.positionReservationId !== null) ||
    (positionId !== null && identityReservation.positionReservationId === null)
  ) {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
  const reservationIds = [
    reservation.activityPersonReservationId,
    identityReservation.sessionReservationId,
    ...(identityReservation.positionReservationId
      ? [identityReservation.positionReservationId]
      : []),
  ];
  const rows = await tx.capacityReservation.findMany({
    where: { id: { in: reservationIds }, status: 'active' },
    select: { id: true, bucketId: true, reservationType: true, identityId: true },
  });
  if (rows.length !== reservationIds.length) {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  const activityPerson = byId.get(reservation.activityPersonReservationId);
  const session = byId.get(identityReservation.sessionReservationId);
  const position = identityReservation.positionReservationId
    ? byId.get(identityReservation.positionReservationId)
    : null;
  if (
    !activityPerson ||
    !session ||
    activityPerson.reservationType !== 'activity_person' ||
    session.reservationType !== 'session_participation' ||
    session.identityId !== identityId ||
    (positionId === null
      ? position !== null
      : !position ||
        position.reservationType !== 'position_participation' ||
        position.identityId !== identityId)
  ) {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
  return {
    activityPersonReservationId: activityPerson.id,
    activityPersonBucketId: activityPerson.bucketId,
    sessionReservationId: session.id,
    sessionBucketId: session.bucketId,
    positionReservationId: position?.id ?? null,
    positionBucketId: position?.bucketId ?? null,
  };
}
