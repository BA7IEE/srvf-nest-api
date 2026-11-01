import assert from 'node:assert/strict';
import type { Prisma } from '@prisma/client';

export interface CapacityBag {
  kind: string;
  count: string;
  hash: string;
}

/** Full row bags, retaining duplicates and every business/anchor column.
 * Only newly generated child IDs and method-dependent creation/update clocks
 * differ between the two implementations. Their receipt clock relation is
 * checked independently below. No business field or array order is removed.
 */
export async function capacityProjection(tx: Prisma.TransactionClient, applicationId: string) {
  const rows = await tx.$queryRaw<CapacityBag[]>`
    WITH p AS (SELECT * FROM "CorrectionPendingTimeAllocation" WHERE "applicationId"=${applicationId}),
    s AS (SELECT * FROM "CorrectionPendingSegmentRevision" WHERE "applicationId"=${applicationId}),
    a AS (SELECT a.* FROM "ParticipantTimeAllocationRevision" a JOIN p ON a.id=p."targetAllocationRevisionId"),
    proof AS (SELECT * FROM "CorrectionTimeSourceProof" WHERE "applicationId"=${applicationId}),
    docs AS (
      SELECT 'baseSegment' AS kind, to_jsonb(t)-'updatedAt' AS doc
      FROM "ParticipantServiceSegmentRevision" t JOIN s ON t.id=s."baseRevisionId"
      UNION ALL SELECT 'targetSegment',to_jsonb(t)-'createdAt'-'updatedAt'
      FROM "ParticipantServiceSegmentRevision" t JOIN p ON t.id=p."targetSegmentRevisionId"
      UNION ALL SELECT 'allocation',to_jsonb(a)-'createdAt' FROM a
      UNION ALL SELECT 'slice',to_jsonb(t)-'id' FROM "ParticipantTimeAllocationSlice" t JOIN a ON t."allocationRevisionId"=a.id
      UNION ALL SELECT 'evidence',to_jsonb(t)-'id' FROM "ParticipantTimeAllocationEvidence" t JOIN a ON t."allocationRevisionId"=a.id
      UNION ALL SELECT 'receipt',(to_jsonb(t)-'id'-'createdAt') #- '{resultJson,createdAt}'
      FROM "ParticipantTimeAllocationCommandReceipt" t JOIN a ON t."allocationRevisionId"=a.id
      UNION ALL SELECT 'binding',to_jsonb(t)-'id'-'createdAt'
      FROM "CorrectionTimeAllocationBinding" t JOIN proof ON t."proofId"=proof.id
    )
    SELECT kind,count(*)::text AS count,
      encode(sha256(convert_to(jsonb_agg(doc ORDER BY doc::text COLLATE "C")::text,'UTF8')),'hex') AS hash
    FROM docs GROUP BY kind ORDER BY kind COLLATE "C"
  `;
  const clocks = await tx.$queryRaw<{ bad: string }[]>`
    SELECT count(*)::text AS bad FROM "ParticipantTimeAllocationCommandReceipt" r
    JOIN "ParticipantTimeAllocationRevision" a ON a.id=r."allocationRevisionId"
    JOIN "CorrectionPendingTimeAllocation" p ON p."targetAllocationRevisionId"=a.id
    WHERE p."applicationId"=${applicationId} AND (
      r."createdAt" IS DISTINCT FROM a."createdAt" OR
      r."resultJson"->>'createdAt' IS DISTINCT FROM to_char(a."createdAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  `;
  assert.deepEqual(
    clocks,
    [{ bad: '0' }],
    'receipt and parent clocks must agree before normalization',
  );
  return rows;
}

export function assertCapacityBags(rows: readonly CapacityBag[], delta: number) {
  assert.deepEqual(
    rows.map(({ kind, count }) => ({ kind, count })),
    [
      { kind: 'allocation', count: String(delta) },
      { kind: 'baseSegment', count: String(delta) },
      { kind: 'binding', count: '10000' },
      { kind: 'evidence', count: String(delta) },
      { kind: 'receipt', count: String(delta) },
      { kind: 'slice', count: String(delta * 5) },
      { kind: 'targetSegment', count: String(delta) },
    ],
  );
  for (const row of rows) assert(/^[0-9a-f]{64}$/.test(row.hash));
}

/** All rows in the fresh activity, including out-of-pending-set extras. */
export async function capacityCensus(tx: Prisma.TransactionClient, activityId: string) {
  return await tx.$queryRaw<{ kind: string; count: number }[]>`
    SELECT * FROM (SELECT 'segment' AS kind,count(*)::int AS count FROM "ParticipantServiceSegmentRevision" s
      JOIN "ActivityParticipationIdentity" i ON i.id=s."participationIdentityId" WHERE i."activityId"=${activityId}
    UNION ALL SELECT 'allocation',count(*)::int FROM "ParticipantTimeAllocationRevision" WHERE "activityId"=${activityId}
    UNION ALL SELECT 'slice',count(*)::int FROM "ParticipantTimeAllocationSlice" WHERE "activityId"=${activityId}
    UNION ALL SELECT 'evidence',count(*)::int FROM "ParticipantTimeAllocationEvidence" WHERE "activityId"=${activityId}
    UNION ALL SELECT 'receipt',count(*)::int FROM "ParticipantTimeAllocationCommandReceipt" WHERE "activityId"=${activityId}
    UNION ALL SELECT 'binding',count(*)::int FROM "CorrectionTimeAllocationBinding" WHERE "activityId"=${activityId}
    ) counts ORDER BY kind COLLATE "C"
  `;
}
export function assertCapacityCensusDelta(
  before: Awaited<ReturnType<typeof capacityCensus>>,
  after: Awaited<ReturnType<typeof capacityCensus>>,
  delta: number,
) {
  const increments = {
    allocation: delta,
    binding: 10000,
    evidence: delta,
    receipt: delta,
    segment: delta,
    slice: delta * 5,
  };
  assert.deepEqual(
    after,
    before.map((row) => {
      assert(row.kind in increments);
      return { kind: row.kind, count: row.count + Reflect.get(increments, row.kind) };
    }),
  );
}
