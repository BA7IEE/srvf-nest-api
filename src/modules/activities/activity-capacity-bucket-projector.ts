import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';

type PrismaTx = Prisma.TransactionClient;

type CapacityScopeTypeCode =
  | 'activity_person'
  | 'position_participation'
  | 'session_participation';

interface CapacityTarget {
  scopeTypeCode: CapacityScopeTypeCode;
  scopeId: string;
  capacity: number | null;
}

interface LockedCapacityBucket {
  id: string;
  activityId: string;
  scopeTypeCode: string;
  scopeId: string;
  capacity: number | null;
  occupied: number;
  version: number;
}

function targetKey(scopeTypeCode: string, scopeId: string): string {
  return `${scopeTypeCode}:${scopeId}`;
}

function compareTarget(left: CapacityTarget, right: CapacityTarget): number {
  return (
    left.scopeTypeCode.localeCompare(right.scopeTypeCode) || left.scopeId.localeCompare(right.scopeId)
  );
}

/**
 * Projects the published Activity/Session/Position capacities into durable buckets.
 *
 * The caller already holds the aggregate-root Activity lock. This projector deliberately acquires
 * bucket rows only after that lock, in stable (scopeTypeCode, scopeId) order. It never changes
 * occupied or writes CapacityReservation; a later reservation command owns those facts.
 */
@Injectable()
export class ActivityCapacityBucketProjector {
  async apply(tx: PrismaTx, activityId: string): Promise<void> {
    const targets = await this.readTargets(tx, activityId);
    const buckets = await this.lockRelevantBuckets(tx, activityId, targets);
    const activeReservationCounts = await this.activeReservationCounts(tx, buckets);

    this.assertExistingFactsAreConsistent(buckets, activeReservationCounts);

    const targetsByKey = new Map<string, CapacityTarget>();
    for (const target of targets) {
      const key = targetKey(target.scopeTypeCode, target.scopeId);
      if (targetsByKey.has(key)) this.failClosed();
      targetsByKey.set(key, target);
    }

    const bucketsByTarget = new Map<string, LockedCapacityBucket>();
    for (const bucket of buckets) {
      const key = targetKey(bucket.scopeTypeCode, bucket.scopeId);
      if (!targetsByKey.has(key)) {
        if (bucket.activityId === activityId && bucket.occupied !== 0) this.failClosed();
        continue;
      }
      if (bucketsByTarget.has(key)) this.failClosed();
      bucketsByTarget.set(key, bucket);
    }

    for (const target of targets) {
      const key = targetKey(target.scopeTypeCode, target.scopeId);
      const bucket = bucketsByTarget.get(key);
      if (!bucket) {
        await this.createTargetBucket(tx, activityId, target);
        continue;
      }
      if (bucket.activityId !== activityId) this.failClosed();
      if (bucket.capacity === target.capacity) continue;
      if (target.capacity !== null && target.capacity < bucket.occupied) this.failClosed();
      await this.updateCapacityWithCas(tx, bucket, target.capacity);
    }
  }

  private async readTargets(tx: PrismaTx, activityId: string): Promise<CapacityTarget[]> {
    const [activity, sessions] = await Promise.all([
      tx.activity.findUniqueOrThrow({
        where: { id: activityId },
        select: { capacity: true },
      }),
      tx.activitySession.findMany({
        where: { activityId, deletedAt: null, statusCode: 'scheduled' },
        select: { id: true, capacity: true },
      }),
    ]);
    const sessionIds = sessions.map((session) => session.id);
    const positions =
      sessionIds.length === 0
        ? []
        : await tx.activitySessionPosition.findMany({
            where: { activityId, deletedAt: null, sessionId: { in: sessionIds } },
            select: { id: true, capacity: true },
          });

    return [
      {
        scopeTypeCode: 'activity_person' as const,
        scopeId: activityId,
        capacity: activity.capacity,
      },
      ...sessions.map((session) => ({
        scopeTypeCode: 'session_participation' as const,
        scopeId: session.id,
        capacity: session.capacity,
      })),
      ...positions.map((position) => ({
        scopeTypeCode: 'position_participation' as const,
        scopeId: position.id,
        capacity: position.capacity,
      })),
    ].sort(compareTarget);
  }

  private async lockRelevantBuckets(
    tx: PrismaTx,
    activityId: string,
    targets: readonly CapacityTarget[],
  ): Promise<LockedCapacityBucket[]> {
    const targetPairs = Prisma.join(
      targets.map((target) => Prisma.sql`(${target.scopeTypeCode}, ${target.scopeId})`),
    );
    return tx.$queryRaw<LockedCapacityBucket[]>(Prisma.sql`
      SELECT "id", "activityId", "scopeTypeCode", "scopeId", "capacity", "occupied", "version"
      FROM "ActivityCapacityBucket"
      WHERE "activityId" = ${activityId}
         OR ("scopeTypeCode", "scopeId") IN (VALUES ${targetPairs})
      ORDER BY "scopeTypeCode", "scopeId", "id"
      FOR UPDATE
    `);
  }

  private async activeReservationCounts(
    tx: PrismaTx,
    buckets: readonly LockedCapacityBucket[],
  ): Promise<Map<string, number>> {
    if (buckets.length === 0) return new Map();
    const counts = await tx.capacityReservation.groupBy({
      by: ['bucketId'],
      where: { bucketId: { in: buckets.map((bucket) => bucket.id) }, status: 'active' },
      _count: { _all: true },
    });
    return new Map(counts.map((count) => [count.bucketId, count._count._all]));
  }

  private assertExistingFactsAreConsistent(
    buckets: readonly LockedCapacityBucket[],
    activeReservationCounts: ReadonlyMap<string, number>,
  ): void {
    for (const bucket of buckets) {
      if ((activeReservationCounts.get(bucket.id) ?? 0) !== bucket.occupied) this.failClosed();
    }
  }

  private async createTargetBucket(
    tx: PrismaTx,
    activityId: string,
    target: CapacityTarget,
  ): Promise<void> {
    try {
      await tx.activityCapacityBucket.create({
        data: {
          activityId,
          scopeTypeCode: target.scopeTypeCode,
          scopeId: target.scopeId,
          capacity: target.capacity,
          occupied: 0,
          version: 0,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        this.failClosed();
      }
      throw error;
    }
  }

  private async updateCapacityWithCas(
    tx: PrismaTx,
    bucket: LockedCapacityBucket,
    capacity: number | null,
  ): Promise<void> {
    const result = await tx.activityCapacityBucket.updateMany({
      where:
        capacity === null
          ? { id: bucket.id, version: bucket.version, occupied: bucket.occupied }
          : { id: bucket.id, version: bucket.version, occupied: { lte: capacity } },
      data: { capacity, version: { increment: 1 } },
    });
    if (result.count !== 1) this.failClosed();
  }

  private failClosed(): never {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
}
