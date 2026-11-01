import assert from 'node:assert/strict';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  capacityCensus,
  capacityProjection,
  assertCapacityBags,
  assertCapacityCensusDelta,
} from './r5-setmat-capacity-projection';
import { R5_ASYNC_CAPACITY1000_UNITS } from './r5-human-correction-async';
import type { R5AsyncCapacity1000Fixture } from './r5-human-correction-async-capacity.fixture';

export const R5_ASYNC_CAPACITY1000_EVIDENCE_BOUNDARY = Object.freeze({
  positiveCase: 'FRESH_FULL_ROOT_DELTA1000_REAL_COMMIT',
  rollback: 'NOT_EXERCISED_BY_POSITIVE_COMMIT',
  referenceDifferential: 'NOT_EXERCISED_BY_POSITIVE_COMMIT',
  completeThousandStage: false,
});

const fullRootQuery = (proofId: string) => Prisma.sql`
  SELECT count(DISTINCT b.id)::int AS bindings,
    count(DISTINCT (b."participationIdentityId",b."segmentKey"))::int AS "logicalKeys",
    count(DISTINCT b."allocationRevisionId")::int AS allocations,
    count(DISTINCT b."participationIdentityId")::int AS identities,
    count(*)::int AS slices
  FROM "CorrectionTimeAllocationBinding" b
  JOIN "ParticipantTimeAllocationSlice" s ON s."allocationRevisionId"=b."allocationRevisionId"
  WHERE b."proofId"=${proofId}`;

/** Parse/plan the new readback before fixture writes; never ANALYZE or DML. */
export async function preflightR5AsyncCapacity1000Readback(observer: PrismaClient) {
  return await observer.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$executeRaw`SET LOCAL statement_timeout='2s'`;
      return await tx.$queryRaw(
        Prisma.sql`EXPLAIN (FORMAT JSON) ${fullRootQuery('r5-unallocated-readonly-plan')}`,
      );
    },
    { timeout: 7_000, maxWait: 2_000 },
  );
}

export function assertR5AsyncFreshCapacityFixture(f: R5AsyncCapacity1000Fixture) {
  assert.deepEqual(f.expected, R5_ASYNC_CAPACITY1000_UNITS);
  assert(
    !['cmvuydsic07v0mkqq7k2rl3ho', 'cmvwainrc004pmk6actp3um3e'].includes(
      f.command.correctionApplicationId,
    ),
    'retained or already committed application cannot be replayed',
  );
  assert(f.command.operationKey.startsWith('r5_async_capacity_'));
  assert(f.proofId.length > 0);
}

export async function readR5AsyncCapacity1000Before(
  observer: PrismaClient,
  f: R5AsyncCapacity1000Fixture,
) {
  assertR5AsyncFreshCapacityFixture(f);
  return await observer.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const proof = await tx.correctionTimeSourceProof.findUniqueOrThrow({
        where: { applicationId: f.command.correctionApplicationId },
      });
      assert.equal(proof.id, f.proofId);
      assert.equal(proof.activityId, f.activityId);
      assert.equal(proof.postingBatchId, f.command.postingBatchId);
      assert.deepEqual(
        [
          proof.expectedSegmentCount,
          proof.expectedPendingCount,
          proof.expectedBindingCount,
          proof.expectedSliceCount,
        ],
        [10000, 1000, 10000, 50000],
      );
      assert.equal(
        await tx.correctionTimeAllocationBinding.count({ where: { proofId: proof.id } }),
        0,
        'fresh prepare must not already be materialized',
      );
      const phase = await tx.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM public."CorrectionWritePhase"
        WHERE "applicationId"=${f.command.correctionApplicationId} AND phase='commit'`;
      assert.deepEqual(phase, [{ count: 0 }]);
      return { proof, census: await capacityCensus(tx, f.activityId) };
    },
    { isolationLevel: 'RepeatableRead', timeout: 30_000, maxWait: 2_000 },
  );
}

export async function assertR5AsyncCapacity1000Published(
  observer: PrismaClient,
  f: R5AsyncCapacity1000Fixture,
  before: Awaited<ReturnType<typeof readR5AsyncCapacity1000Before>>,
) {
  const result = await observer.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const proof = await tx.correctionTimeSourceProof.findUniqueOrThrow({
        where: { applicationId: f.command.correctionApplicationId },
      });
      assert.deepEqual(proof, before.proof, 'the frozen prepared source proof cannot change');
      const phase = await tx.$queryRaw<{ state: string }[]>`
        SELECT state FROM public."CorrectionWritePhase"
        WHERE "applicationId"=${f.command.correctionApplicationId} AND phase='commit'`;
      assert.deepEqual(phase, [{ state: 'SEALED' }]);
      const bags = await capacityProjection(tx, f.command.correctionApplicationId);
      assertCapacityBags(bags, 1000);
      const census = await capacityCensus(tx, f.activityId);
      assertCapacityCensusDelta(before.census, census, 1000);
      const targets = await tx.$queryRaw<{ statusCode: string; count: number }[]>`
        SELECT s."statusCode",count(*)::int AS count
        FROM "ParticipantServiceSegmentRevision" s
        JOIN "CorrectionPendingTimeAllocation" p ON p."targetSegmentRevisionId"=s.id
        WHERE p."applicationId"=${f.command.correctionApplicationId} GROUP BY s."statusCode"`;
      assert.deepEqual(targets, [{ statusCode: 'committed', count: 1000 }]);
      const fullRoot = await tx.$queryRaw<
        {
          bindings: number;
          logicalKeys: number;
          allocations: number;
          identities: number;
          slices: number;
        }[]
      >(fullRootQuery(proof.id));
      assert.deepEqual(fullRoot, [
        {
          bindings: 10000,
          logicalKeys: 10000,
          allocations: 10000,
          identities: 2000,
          slices: 50000,
        },
      ]);
      return { bags, census, phase, targets, fullRoot, proofId: proof.id };
    },
    { isolationLevel: 'RepeatableRead', timeout: 30_000, maxWait: 2_000 },
  );
  assert.equal(
    await observer.auditLog.count({
      where: {
        resourceType: 'activity',
        resourceId: f.activityId,
        event: 'activity.publish',
        success: true,
        AND: [
          { context: { path: ['extra', 'operation'], equals: 'correction-commit' } },
          {
            context: {
              path: ['extra', 'correctionApplicationId'],
              equals: f.command.correctionApplicationId,
            },
          },
          { context: { path: ['extra', 'postingBatchId'], equals: f.command.postingBatchId } },
        ],
      },
    }),
    1,
    'exact committed correction audit must be durable',
  );
  return result;
}
