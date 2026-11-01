import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Prisma, Role, UserStatus, type PrismaClient } from '@prisma/client';
import { PrismaService } from '../../src/database/prisma.service';
import appConfig from '../../src/config/app.config';
import { ActivityWorkflowGate } from '../../src/common/activity-workflow/activity-workflow.gate';
import { AuthzService } from '../../src/modules/authz/authz.service';
import { createTestApp } from '../setup/test-app';
import { loginAs } from '../fixtures/auth.fixture';
import { selectNativeCapacityChanges } from './native-capacity-change-shape';
import { nativeLaunchV3Allocation, type NativeLaunchStage } from './native-launch-live.fixture';
import { validateR5SetmatOwnedConfig, type R5SetmatOwnedConfig } from './r5-setmat-owned-fixture';
import {
  assertR5NoPolicyBranch,
  assertR5PrepareStorageReadiness,
  readR5PrepareStorageReadiness,
  readR5ZeroAssignmentReadiness,
} from './r5-setmat-preparation-readiness';

/** Published source, NOT an instruction to retry its now successful task. */
export const R5_FULL_CHAIN_SOURCE = Object.freeze({
  schema: 'srvf-r5-published-full-chain-source/v1',
  evidenceLibraryId: 'libfile_382832cf81e08191b4c035168da45fc3',
  evidenceSha256: 'b3071b3eeba9f0329ecdf83845686218af1c6e96b9b33949f12c447a7fd64ec7',
  sourceBindingSha256: '4ba05dfc75496a39c8ed05060cb7c081edf6583ef85ab80eb6bdcb80d286f7c4',
  xid: '159309',
  activityId: 'cmvwehw3c000fmk123aokqksf',
  runId: 'cmvweks8u0028mk129tdw1anl',
  requestId: 'cmvwge0z8000umkpgtzedbgdx',
  applicationId: 'cmvwge2vs0014mkpgl3lcunl7',
  batchId: 'cmvwge2vm0012mkpgm9d9xx9g',
  settlementVersionId: 'cmvwge2p60010mkpgbmxh4ol6',
  contributionRootId: 'cmvwgelhz0d5emkpgbb96jsv5',
  proofId: '80368cc1-d458-47ca-a09d-8aa258009c23',
  timeRootManifestId: 'cmvweomuw01n6mk12g3mm5seo',
  jobId: 'cmvwljrap000lmkjpz2m5p176',
  itemId: 'cmvwljrgf000nmkjpb1q64jrn',
  campaignDeadline: '2026-10-31T19:09:00.000000+00:00',
});
export const R5_PREPARED240_PUBLICATION = Object.freeze({
  evidenceLibraryId: 'libfile_939619b734bc8191b05846bac410d3cd',
  evidenceSha256: 'a75e0970773cc3297dc4dfc7d1eeb3d61d6b82e1ca08b75ecc1ee4f1f358026d',
  xid: '159341',
  activityId: R5_FULL_CHAIN_SOURCE.activityId,
  requestId: 'cmvwtopok000lmk7ej3vfvc67',
  applicationId: 'cmvwtormt000vmk7en4n424pd',
  batchId: 'cmvwtormm000tmk7e3w17qipp',
  settlementVersionId: 'cmvwtorh0000rmk7erhohe3ta',
  rootId: 'cmvwtpru40d55mk7efw8qcegm',
  proofId: '3dd75c63-b098-4482-989e-ca29780149c7',
  requestHash: '3baffc9c5b63f3e925ed32db937d2af29dfaa682c6863aa87fe584c16261cf46',
  sourceProofHash: 'a892342dab2b3d77c1393a86a9a463a50e4949aa2fe49f26e9aabc8792457728',
  actorUserId: 'cmvt8gywm006tmkdfttqk085k',
  operationKey: 'r5_async_capacity_r5_async_capacity1000_fullchain_20261031_q2_prepare',
  baseSettlementVersionId: R5_FULL_CHAIN_SOURCE.settlementVersionId,
  closedPhaseId: 'r5_async_capacity1000_fullchain_20261031_q2',
  campaignDeadline: '2026-10-31T20:27:05.937929+00:00',
});
export interface R5Prepared240State {
  xidStatus: string | null;
  anchors: { object: string; id: string; state: string; xmin: string }[];
  counts: {
    segments: number;
    allocations: number;
    evidence: number;
    bindings: number;
    ledger: number;
    commitPhases: number;
    newJobs: number;
  };
}
export function assertR5Prepared240State(state: R5Prepared240State) {
  const p = R5_PREPARED240_PUBLICATION;
  assert.equal(state.xidStatus, 'committed');
  const expected = [
    ['application', p.applicationId, 'preparing'],
    ['batch', p.batchId, 'ready'],
    ['phase', p.applicationId, 'SEALED'],
    ['proof', p.proofId, 'frozen'],
    ['request', p.requestId, 'applying'],
    ['root', p.rootId, 'correction_time_proof'],
    ['version', p.settlementVersionId, 'approved'],
  ];
  assert.deepEqual(state.anchors.map((a) => [a.object, a.id, a.state]).sort(), expected);
  assert(state.anchors.every((a) => a.xmin === p.xid));
  assert.deepEqual(state.counts, {
    segments: 1000,
    allocations: 1000,
    evidence: 1000,
    bindings: 0,
    ledger: 8000,
    commitPhases: 0,
    newJobs: 0,
  });
}
export async function readR5Prepared240Publication(db: PrismaClient) {
  const p = R5_PREPARED240_PUBLICATION;
  return await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const statuses = await tx.$queryRaw<
        { status: string | null }[]
      >`SELECT pg_xact_status(${p.xid}::xid8) AS status`;
      assert.equal(statuses.length, 1);
      const anchors = await tx.$queryRaw<R5Prepared240State['anchors']>`
      SELECT 'request' AS object,id,"statusCode" AS state,xmin::text FROM "AttendanceCorrectionRequest" WHERE id=${p.requestId}
      UNION ALL SELECT 'application',id,"statusCode",xmin::text FROM "CorrectionApplication" WHERE id=${p.applicationId}
      UNION ALL SELECT 'batch',id,"statusCode",xmin::text FROM "LedgerPostingBatch" WHERE id=${p.batchId}
      UNION ALL SELECT 'version',id,"statusCode",xmin::text FROM "AttendanceSettlementVersion" WHERE id=${p.settlementVersionId}
      UNION ALL SELECT 'root',id,"sourceKindCode",xmin::text FROM "ActivitySettlementContributionRevision" WHERE id=${p.rootId}
      UNION ALL SELECT 'proof',id,'frozen',xmin::text FROM "CorrectionTimeSourceProof" WHERE id=${p.proofId}
      UNION ALL SELECT 'phase',"applicationId",state,xmin::text FROM "CorrectionWritePhase" WHERE "applicationId"=${p.applicationId} AND phase='prepare'`;
      const [counts] = await tx.$queryRaw<R5Prepared240State['counts'][]>`SELECT
      (SELECT count(*)::int FROM "CorrectionPendingSegmentRevision" WHERE "applicationId"=${p.applicationId}) AS segments,
      (SELECT count(*)::int FROM "CorrectionPendingTimeAllocation" WHERE "applicationId"=${p.applicationId}) AS allocations,
      (SELECT count(*)::int FROM "CorrectionPendingTimeAllocationEvidence" e JOIN "CorrectionPendingTimeAllocation" a ON a.id=e."pendingAllocationId" WHERE a."applicationId"=${p.applicationId}) AS evidence,
      (SELECT count(*)::int FROM "CorrectionTimeAllocationBinding" WHERE "proofId"=${p.proofId}) AS bindings,
      (SELECT count(*)::int FROM "ParticipationLedgerEntry" WHERE "postingBatchId"=${p.batchId}) AS ledger,
      (SELECT count(*)::int FROM "CorrectionWritePhase" WHERE "applicationId"=${p.applicationId} AND phase='commit') AS "commitPhases",
      (SELECT count(*)::int FROM "ActivityBatchJob" WHERE "postingBatchId"=${p.batchId} AND "jobTypeCode"='human_correction_commit') AS "newJobs"`;
      const state = { xidStatus: statuses[0].status, anchors, counts };
      assertR5Prepared240State(state);
      const request = await tx.attendanceCorrectionRequest.findUniqueOrThrow({
        where: { id: p.requestId },
      });
      assert.equal(request.activityId, p.activityId);
      assert.equal(request.baseSettlementVersionId, p.baseSettlementVersionId);
      assert.equal(request.requestHash, p.requestHash);
      assert.equal(request.reviewedByUserId, p.actorUserId);
      const app = await tx.correctionApplication.findUniqueOrThrow({
        where: { id: p.applicationId },
      });
      assert.equal(app.correctionRequestId, p.requestId);
      assert.equal(app.newPostingBatchId, p.batchId);
      assert.equal(app.newSettlementVersionId, p.settlementVersionId);
      const batch = await tx.ledgerPostingBatch.findUniqueOrThrow({ where: { id: p.batchId } });
      assert.equal(batch.requestHash, p.requestHash);
      assert.equal(batch.requestKey, `correction-apply:${p.requestId}:${p.operationKey}`);
      assert.equal(batch.preparedByUserId, p.actorUserId);
      const proof = await tx.correctionTimeSourceProof.findUniqueOrThrow({
        where: { id: p.proofId },
      });
      assert.equal(proof.applicationId, p.applicationId);
      assert.equal(proof.sourceSetHash, p.sourceProofHash);
      assert.equal(proof.postingBatchId, p.batchId);
      assert.equal(proof.settlementVersionId, p.settlementVersionId);
      assert.deepEqual(
        [
          proof.expectedSegmentCount,
          proof.expectedPendingCount,
          proof.expectedBindingCount,
          proof.expectedSliceCount,
        ],
        [10000, 1000, 10000, 50000],
      );
      const root = await tx.activitySettlementContributionRevision.findUniqueOrThrow({
        where: { id: p.rootId },
      });
      assert.equal(root.correctionTimeSourceProofId, p.proofId);
      assert.equal(root.settlementVersionId, p.settlementVersionId);
      assert.equal(root.evaluationCount, 8000);
      const ledger = await tx.$queryRaw<
        { xmin: string; count: number }[]
      >`SELECT xmin::text AS xmin,count(*)::int AS count FROM "ParticipationLedgerEntry" WHERE "postingBatchId"=${p.batchId} GROUP BY xmin::text`;
      assert.deepEqual(ledger, [{ xmin: p.xid, count: 8000 }]);
      return {
        state,
        proof,
        root,
        command: {
          operationKey: p.operationKey,
          expectedBaseSettlementVersionId: p.baseSettlementVersionId,
          correctionApplicationId: p.applicationId,
          postingBatchId: p.batchId,
        },
      };
    },
    { isolationLevel: 'RepeatableRead', timeout: 30000, maxWait: 2000 },
  );
}

export interface R5FullChainSegment {
  id: string;
  participationIdentityId: string;
  segmentKey: string;
  checkInAt: Date;
  checkOutAt: Date | null;
  allocationId: string;
  sessionId: string;
  slices: { categoryCode: string; intervalKindCode: string; startAt: Date; endAt: Date }[];
}
export const R5_FULL_CHAIN_BINDING_READ_BATCH = 100;
const fullChainBindingInclude = {
  sourceSegment: true,
  allocationRevision: { include: { slices: true, policyVersion: true } },
} as const;
type FullChainBinding = Prisma.CorrectionTimeAllocationBindingGetPayload<{
  include: typeof fullChainBindingInclude;
}>;

/** Bound each ORM relation request, not the complete source. The caller passes
 * its existing READ ONLY / RepeatableRead transaction; no new transaction or
 * client is opened. All binding/segment/allocation/slice/policy fields survive.
 * The 54001 receipt identifies the old full-root call, not its generated SQL.
 */
export async function readR5FullChainBindings(
  tx: Prisma.TransactionClient,
  proofId: string,
): Promise<FullChainBinding[]> {
  const rows: FullChainBinding[] = [];
  const ids = new Set<string>();
  let cursor: string | undefined;
  // A final empty page proves exhaustion; reject overfull, omitted or repeated
  // source rows rather than accepting the first 10000 of a different root.
  for (let offset = 0; offset <= 10000; offset += R5_FULL_CHAIN_BINDING_READ_BATCH) {
    const page = await tx.correctionTimeAllocationBinding.findMany({
      where: { proofId },
      include: fullChainBindingInclude,
      orderBy: { id: 'asc' },
      take: R5_FULL_CHAIN_BINDING_READ_BATCH,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    });
    assert(page.length <= R5_FULL_CHAIN_BINDING_READ_BATCH, 'relation page exceeds its bound');
    if (page.length === 0) {
      assert.equal(rows.length, 10000, 'complete full-root binding set is required');
      return rows;
    }
    for (const row of page) {
      assert.equal(row.proofId, proofId);
      assert(!ids.has(row.id), 'duplicate binding across relation pages');
      ids.add(row.id);
      assert.equal(row.sourceSegment.id, row.sourceSegmentId);
      assert.equal(row.allocationRevision.id, row.allocationRevisionId);
      assert.equal(row.allocationRevision.policyVersion.id, row.allocationRevision.policyVersionId);
      assert(
        row.allocationRevision.slices.every(
          (s) => s.allocationRevisionId === row.allocationRevisionId,
        ),
      );
      rows.push(row);
    }
    assert(rows.length <= 10000, 'published source contains extra bindings');
    cursor = page[page.length - 1].id;
  }
  throw new Error('full-root relation pagination did not exhaust');
}
interface ResultInput {
  participationIdentityId: string;
  resultCode: string;
  lateFlag: boolean;
  earlyLeaveFlag: boolean;
  recognizedServiceHours: string;
  recognizedContributionPoints: string;
}

/** Fixed synthetic input construction only; the independent frozen full/day
 * oracle still runs on the NEW prepared root and again after real COMMIT.
 * Unlike the first fixture, the published root contains both 19s and 20s spans.
 */
export function buildR5FullChainChange(input: {
  segments: R5FullChainSegment[];
  results: ResultInput[];
  roots: { id: string; participationIdentityId: string; categoryCode: string }[];
  baseSettlementVersionId: string;
  baseTimeLedgerHash: string;
  evidenceAttachmentId: string;
}) {
  assert.equal(input.segments.length, 10000);
  assert.equal(input.results.length, 2000);
  assert.equal(input.roots.length, 8000);
  assert(/^[a-f0-9]{64}$/.test(input.baseTimeLedgerHash));
  assert(input.evidenceAttachmentId.length > 0);
  // The first publication shortened one span for each of 1000 identities.
  // Shorten one still-20s span for each of the OTHER 1000 identities: changing
  // 19s to 18s could round to the same buckets, and a 14s manual span rounds its
  // two-decimal serviceHours to zero (which the real parser correctly rejects).
  const durations = new Map<string, number[]>();
  for (const s of input.segments) {
    assert(s.checkOutAt instanceof Date);
    const values = durations.get(s.participationIdentityId) ?? [];
    values.push(s.checkOutAt.getTime() - s.checkInAt.getTime());
    durations.set(s.participationIdentityId, values);
  }
  assert.equal(durations.size, 2000);
  const unchanged = new Set(
    [...durations]
      .filter(([, ms]) => ms.length === 5 && ms.every((n) => n === 20000))
      .map(([id]) => id),
  );
  assert.equal(unchanged.size, 1000, 'published synthetic source population changed');
  const eligible = input.segments.filter((s) => unchanged.has(s.participationIdentityId));
  assert.equal(eligible.length, 5000);
  const shape = selectNativeCapacityChanges(eligible, 1000);
  assert.equal(shape.metrics.changedIdentities, 1000);
  const selected = new Set(shape.selected.map((x) => x.id));
  const allocations = shape.selected.map((s) => ({
    ...nativeLaunchV3Allocation({
      participationIdentityId: s.participationIdentityId,
      segmentKey: s.segmentKey,
      baseSegmentRevisionId: s.id,
      baseAllocationRevisionId: s.allocationId,
      startsAt: s.checkInAt,
      endsAt: new Date(s.checkOutAt!.getTime() - 1000),
    }),
    evidenceAttachmentIds: [input.evidenceAttachmentId],
  }));
  const replacements = new Map(
    allocations.map((a) => [JSON.stringify([a.participationIdentityId, a.segmentKey]), a]),
  );
  const totals = new Map<string, Map<string, number>>();
  const identities = new Map<string, R5FullChainSegment[]>();
  for (const s of input.segments) {
    assert(s.checkOutAt instanceof Date);
    assert(
      [19000, 20000].includes(s.checkOutAt.getTime() - s.checkInAt.getTime()),
      'published fixture span changed',
    );
    assert.equal(s.slices.length, 5);
    const complete = [...s.slices].sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
    assert.equal(complete[0].startAt.getTime(), s.checkInAt.getTime());
    assert.equal(complete[4].endAt.getTime(), s.checkOutAt.getTime());
    for (let i = 1; i < complete.length; i++)
      assert.equal(complete[i - 1].endAt.getTime(), complete[i].startAt.getTime());
    const group = identities.get(s.participationIdentityId) ?? [];
    group.push(s);
    identities.set(s.participationIdentityId, group);
    const slices = selected.has(s.id)
      ? replacements
          .get(JSON.stringify([s.participationIdentityId, s.segmentKey]))!
          .slices.map((x) => ({
            ...x,
            intervalKindCode: 'service_segment',
            startAt: new Date(x.startAt),
            endAt: new Date(x.endAt),
          }))
      : s.slices;
    const categories = totals.get(s.participationIdentityId) ?? new Map<string, number>();
    for (const slice of slices) {
      assert.equal(slice.intervalKindCode, 'service_segment');
      const duration = slice.endAt.getTime() - slice.startAt.getTime();
      assert(duration > 0 && slice.startAt >= s.checkInAt && slice.endAt <= s.checkOutAt);
      categories.set(slice.categoryCode, (categories.get(slice.categoryCode) ?? 0) + duration);
    }
    totals.set(s.participationIdentityId, categories);
  }
  for (const rows of identities.values()) {
    assert.equal(rows.length, 5);
    assert.equal(new Set(rows.map((r) => r.sessionId)).size, 1);
    const ordered = [...rows].sort((a, b) => a.checkInAt.getTime() - b.checkInAt.getTime());
    for (let i = 1; i < ordered.length; i++)
      assert(ordered[i - 1].checkOutAt! <= ordered[i].checkInAt);
    // Frozen fixture policy floors once per identity/session/category/Beijing day.
    const day = (d: Date) => new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, 10);
    assert.equal(
      new Set(rows.flatMap((r) => [day(r.checkInAt), day(new Date(r.checkOutAt!.getTime() - 1))]))
        .size,
      1,
    );
  }
  assert.equal(new Set(input.results.map((r) => r.participationIdentityId)).size, 2000);
  assert(input.results.every((r) => identities.has(r.participationIdentityId)));
  assert.equal(
    new Set(input.roots.map((r) => JSON.stringify([r.participationIdentityId, r.categoryCode])))
      .size,
    8000,
  );
  return {
    schemaVersion: 3,
    results: input.results.map((r) => ({
      ...r,
      lateFlag: !r.lateFlag,
      adjustmentReason: 'New independent full-chain correction',
    })),
    segments: shape.selected.map((s) => ({
      participationIdentityId: s.participationIdentityId,
      segmentKey: s.segmentKey,
      checkInAt: s.checkInAt.toISOString(),
      checkOutAt: new Date(s.checkOutAt!.getTime() - 1000).toISOString(),
      resultCode: 'valid',
      serviceHours: new Prisma.Decimal(s.checkOutAt!.getTime() - s.checkInAt.getTime() - 1000)
        .div(3600000)
        .toFixed(2),
    })),
    allocations,
    timeCorrection: {
      baseSettlementVersionId: input.baseSettlementVersionId,
      baseTimeLedgerHash: input.baseTimeLedgerHash,
      reason: 'New independent full-chain correction',
      items: input.roots.map((r) => {
        const ms = totals.get(r.participationIdentityId)?.get(r.categoryCode);
        assert(ms !== undefined, 'root category is absent from complete current source');
        return { rootEntryId: r.id, recognizedSeconds: Math.floor(ms / 1000) };
      }),
    },
  };
}

export async function readR5FullChainSource(db: PrismaClient) {
  const p = R5_FULL_CHAIN_SOURCE;
  return await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const status = await tx.$queryRaw<
        { status: string | null }[]
      >`SELECT pg_xact_status(${p.xid}::xid8) AS status`;
      assert.deepEqual(status, [{ status: 'committed' }]);
      const anchors = await tx.$queryRaw<
        { object: string; id: string; state: string; xmin: string }[]
      >`
      SELECT 'request' AS object,id,"statusCode" AS state,xmin::text FROM "AttendanceCorrectionRequest" WHERE id=${p.requestId}
      UNION ALL SELECT 'application',id,"statusCode",xmin::text FROM "CorrectionApplication" WHERE id=${p.applicationId}
      UNION ALL SELECT 'batch',id,"statusCode",xmin::text FROM "LedgerPostingBatch" WHERE id=${p.batchId}
      UNION ALL SELECT 'job',id,"statusCode",xmin::text FROM "ActivityBatchJob" WHERE id=${p.jobId}
      UNION ALL SELECT 'item',id,"statusCode",xmin::text FROM "ActivityBatchJobItem" WHERE id=${p.itemId}`;
      const expected = [
        ['application', p.applicationId, 'committed'],
        ['batch', p.batchId, 'committed'],
        ['item', p.itemId, 'succeeded'],
        ['job', p.jobId, 'succeeded'],
        ['request', p.requestId, 'applied'],
      ];
      assert.deepEqual(anchors.map((a) => [a.object, a.id, a.state]).sort(), expected);
      assert(anchors.every((a) => a.xmin === p.xid));
      const version = await tx.attendanceSettlementVersion.findUniqueOrThrow({
        where: { id: p.settlementVersionId },
      });
      const run = await tx.attendanceSettlementRun.findUniqueOrThrow({ where: { id: p.runId } });
      assert.equal(run.activityId, p.activityId);
      assert.equal(run.currentPostedVersion, version.version);
      assert.equal(version.statusCode, 'approved');
      const application = await tx.correctionApplication.findUniqueOrThrow({
        where: { id: p.applicationId },
      });
      assert.equal(application.newSettlementVersionId, version.id);
      assert.equal(application.newPostingBatchId, p.batchId);
      assert.equal(application.correctionRequestId, p.requestId);
      assert.equal(
        await tx.attendanceCorrectionRequest.count({
          where: {
            activityId: p.activityId,
            statusCode: { in: ['pending', 'approved', 'applying'] },
          },
        }),
        0,
        'another request is open',
      );
      const time = await tx.participationTimeCorrectionManifest.findUniqueOrThrow({
        where: { postingBatchId: p.batchId },
      });
      assert.equal(time.rootManifestId, p.timeRootManifestId);
      assert.equal(time.settlementVersionId, version.id);
      assert.equal(time.sourceProofId, p.proofId);
      const root = await tx.activitySettlementContributionRevision.findUniqueOrThrow({
        where: { id: p.contributionRootId },
      });
      assert.equal(root.settlementVersionId, version.id);
      assert.equal(root.correctionTimeSourceProofId, p.proofId);
      assert.equal(root.evaluationCount, 8000);
      const bindings = await readR5FullChainBindings(tx, p.proofId);
      assert.equal(bindings.length, 10000);
      const current = await tx.participantServiceSegmentRevision.findMany({
        where: { identity: { activityId: p.activityId }, statusCode: 'committed' },
        select: { id: true },
      });
      assert.deepEqual(
        current.map((x) => x.id).sort(),
        bindings.map((x) => x.sourceSegmentId).sort(),
      );
      const latest = await tx.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT ON ("participationIdentityId","segmentKey") id FROM "ParticipantTimeAllocationRevision"
      WHERE "activityId"=${p.activityId} AND "settlementDraftVersionId" IS NULL
      ORDER BY "participationIdentityId","segmentKey",revision DESC`;
      assert.deepEqual(
        latest.map((x) => x.id).sort(),
        bindings.map((x) => x.allocationRevisionId).sort(),
      );
      const segments = bindings.map((b): R5FullChainSegment => {
        assert.equal(b.activityId, p.activityId);
        assert.equal(b.sourceSegment.statusCode, 'committed');
        assert.equal(b.sourceSegment.resultCode, 'valid');
        assert.equal(b.sourceSegment.revision, b.sourceSegmentRevision);
        assert.equal(b.allocationRevision.sourceSegmentId, b.sourceSegmentId);
        assert.equal(b.allocationRevision.sourceSegmentRevision, b.sourceSegmentRevision);
        const definition = b.allocationRevision.policyVersion.definitionJson as {
          rounding?: unknown;
        };
        assert.deepEqual(
          definition.rounding,
          { mode: 'floor', quantumSeconds: 1 },
          'fixed fixture rounding changed',
        );
        return {
          id: b.sourceSegmentId,
          participationIdentityId: b.participationIdentityId,
          segmentKey: b.segmentKey,
          checkInAt: b.sourceSegment.checkInAt,
          checkOutAt: b.sourceSegment.checkOutAt,
          allocationId: b.allocationRevisionId,
          sessionId: b.allocationRevision.sessionId,
          slices: b.allocationRevision.slices,
        };
      });
      const results = (
        await tx.participantSettlementResultRevision.findMany({
          where: { settlementVersionId: version.id },
        })
      ).map((r) => ({
        participationIdentityId: r.participationIdentityId,
        resultCode: r.resultCode,
        lateFlag: r.lateFlag,
        earlyLeaveFlag: r.earlyLeaveFlag,
        recognizedServiceHours: r.recognizedServiceHours.toFixed(2),
        recognizedContributionPoints: r.recognizedContributionPoints.toFixed(2),
      }));
      const roots = await tx.participationTimeLedgerEntry.findMany({
        where: { manifestId: time.rootManifestId },
        select: { id: true, participationIdentityId: true, categoryCode: true },
      });
      const evidence = await tx.correctionPendingTimeAllocationEvidence.findFirstOrThrow({
        where: { pendingAllocation: { applicationId: p.applicationId } },
        orderBy: { id: 'asc' },
        select: { attachmentId: true },
      });
      const change = buildR5FullChainChange({
        segments,
        results,
        roots,
        baseSettlementVersionId: version.id,
        baseTimeLedgerHash: time.contentHash,
        evidenceAttachmentId: evidence.attachmentId,
      });
      return {
        change,
        anchors,
        source: p,
        sourceInputSha256: createHash('sha256').update(JSON.stringify(change)).digest('hex'),
        participationIdentityId: segments[0].participationIdentityId,
      };
    },
    { isolationLevel: 'RepeatableRead', timeout: 30000, maxWait: 2000 },
  );
}

/** The administrator graph is used for existing real test logins only. All new
 * correction commands run later through the actual P/C HTTP application. */
export async function bootstrapR5FullChain(options: {
  config: R5SetmatOwnedConfig;
  observer: PrismaClient;
  stage: NativeLaunchStage;
  persist: (x: unknown) => string;
  verifyCatalog: () => Promise<void>;
  onApplication: (app: INestApplication) => void;
  prepared240?: typeof R5_PREPARED240_PUBLICATION;
}) {
  const { observer, stage, persist } = options;
  const config = validateR5SetmatOwnedConfig(options.config);
  if (options.prepared240) assert.deepEqual(options.prepared240, R5_PREPARED240_PUBLICATION);
  const prepared = options.prepared240
    ? await stage('PREPARED240_READONLY_QUALIFICATION', () =>
        readR5Prepared240Publication(observer),
      )
    : undefined;
  const source = prepared
    ? undefined
    : await stage('PUBLISHED_SOURCE_READONLY_QUALIFICATION', () => readR5FullChainSource(observer));
  if (source) persist({ kind: 'FULL_CHAIN_CURRENT_SOURCE', ...source, change: undefined });
  if (prepared)
    persist({
      kind: 'PREPARED240_PUBLICATION_QUALIFIED',
      source: R5_PREPARED240_PUBLICATION,
      ...prepared,
      prepareReplayed: false,
      priorOraclesReference: R5_PREPARED240_PUBLICATION.evidenceLibraryId,
    });
  const storage = await stage('FULL_CHAIN_STORAGE_READINESS', () =>
    readR5PrepareStorageReadiness(observer),
  );
  assertR5PrepareStorageReadiness(storage);
  persist(storage);
  const assignments = await readR5ZeroAssignmentReadiness(observer, {
    creator: config.creatorUserId,
    A: config.reviewerUserId,
    B: config.finalReviewerUserId,
  });
  assertR5NoPolicyBranch(assignments);
  persist(assignments);
  const app = await stage('FULL_CHAIN_LOGIN_APPLICATION', async () => {
    const a = await createTestApp();
    options.onApplication(a);
    return a;
  });
  const db = app.get(PrismaService),
    cfg = app.get<ReturnType<typeof appConfig>>(appConfig.KEY);
  assert.equal(cfg.env, 'test');
  assert.equal(cfg.contributionSettlementMode, 'active');
  assert(app.get(ActivityWorkflowGate).isV11Enabled());
  assert(!app.get(ActivityWorkflowGate).isReadonlyMaintenance());
  const users = [];
  for (const id of [config.creatorUserId, config.reviewerUserId, config.finalReviewerUserId]) {
    const u = await db.user.findUniqueOrThrow({ where: { id } });
    assert.equal(u.status, UserStatus.ACTIVE);
    assert.equal(u.deletedAt, null);
    assert(u.memberId);
    users.push(u);
  }
  const [creator, a, b] = users;
  assert.equal(creator.role, Role.SUPER_ADMIN);
  assert.equal(a.role, Role.USER);
  assert.equal(b.role, Role.USER);
  const authz = app.get(AuthzService),
    permission = 'activity.settlement-final-review.record';
  assert.equal(
    (await authz.getExplicitVisibleOrganizationScope(a, permission, db)).hasPermission,
    false,
  );
  const grant = await authz.getExplicitVisibleOrganizationScope(b, permission, db);
  assert(grant.hasPermission && grant.global);
  const creatorAuthorization = (
    await stage('FULL_CHAIN_CREATOR_LOGIN', () => loginAs(app, creator.username))
  ).authHeader;
  await stage('FULL_CHAIN_A_LOGIN', () => loginAs(app, a.username));
  await stage('FULL_CHAIN_B_LOGIN', () => loginAs(app, b.username));
  return {
    app,
    observerDb: observer,
    b: { id: b.id, username: b.username },
    activityId: R5_FULL_CHAIN_SOURCE.activityId,
    requestId: prepared ? R5_PREPARED240_PUBLICATION.requestId : 'UNPREPARED_NEW_FULL_CHAIN',
    command: prepared?.command ?? {
      operationKey: 'UNPREPARED',
      expectedBaseSettlementVersionId: R5_FULL_CHAIN_SOURCE.settlementVersionId,
      correctionApplicationId: 'UNPREPARED',
      postingBatchId: 'UNPREPARED',
    },
    verifyCandidate: options.verifyCatalog,
    restoreObservation: () => {},
    source,
    prepared,
    creatorAuthorization,
  };
}

export async function runR5NewFullChainRequests(options: {
  source: Awaited<ReturnType<typeof readR5FullChainSource>>;
  phaseId: string;
  reviewerUserId: string;
  post: (
    label: string,
    path: string,
    actor: 'creator' | 'reviewer',
    body: object,
    metadata: boolean,
  ) => Promise<{ status: number; body: { code?: number; data?: Record<string, unknown> } }>;
  checkpoint: (reserve: number) => void;
  persist: (value: unknown) => string;
}) {
  assert.deepEqual(options.source.source, R5_FULL_CHAIN_SOURCE);
  assert(/^[A-Za-z0-9_-]{8,100}$/.test(options.phaseId));
  const prefix = `r5_async_capacity_${options.phaseId}`;
  const path = `/api/app/v1/my/managed-activities/${R5_FULL_CHAIN_SOURCE.activityId}/time-corrections`;
  const post = async (
    label: string,
    suffix: string,
    actor: 'creator' | 'reviewer',
    body: object,
    metadata: boolean,
  ) => {
    const response = await options.post(label, path + suffix, actor, body, metadata);
    options.persist({
      kind: 'FULL_CHAIN_HTTP_RESULT',
      label,
      status: response.status,
      body: response.body,
      authorizationCaptured: false,
    });
    assert(
      [200, 201].includes(response.status) && response.body.code === 0,
      `${label} rejected; no automatic replay`,
    );
    assert(response.body.data);
    return response.body.data;
  };
  options.checkpoint(400000);
  const submitted = await post(
    'FULL_CHAIN_NEW_HTTP_SUBMIT',
    '',
    'creator',
    {
      participationIdentityId: options.source.participationIdentityId,
      requestTypeCode: 'time',
      requestedChangeJson: options.source.change,
      reason: 'New independent full-chain candidate240/60',
      operationKey: prefix + '_request',
    },
    true,
  );
  assert.equal(submitted.baseSettlementVersionId, R5_FULL_CHAIN_SOURCE.settlementVersionId);
  assert.equal(submitted.replayed, false);
  assert.equal(typeof submitted.requestId, 'string');
  const requestId = submitted.requestId as string;
  assert.notEqual(requestId, R5_FULL_CHAIN_SOURCE.requestId);
  assert(Number.isSafeInteger(submitted.requestVersion));
  options.persist({
    kind: 'FULL_CHAIN_NEW_REQUEST_ANCHOR',
    requestId,
    operationKey: prefix + '_prepare',
    baseSettlementVersionId: submitted.baseSettlementVersionId,
    sourceInputSha256: options.source.sourceInputSha256,
  });
  const reviewed = await post(
    'FULL_CHAIN_INDEPENDENT_HUMAN_REVIEW',
    `/${requestId}/review`,
    'reviewer',
    { actionCode: 'approve', expectedRequestVersion: submitted.requestVersion },
    true,
  );
  assert.equal(reviewed.outcome, 'reviewed');
  assert.equal(reviewed.statusCode, 'approved');
  assert.equal(reviewed.replayed, false);
  assert.equal(reviewed.reviewedByUserId, options.reviewerUserId);
  options.persist({
    kind: 'FULL_CHAIN_REVIEW_PROTOCOL',
    requestId,
    independentHumanApprovals: 1,
    sourceSettlementTwoReviewProtocolUnchanged: true,
    duplicateApproveNotUsedAsSecondApproval: true,
  });
  // 240 prepare + 60 native + at least 60 oracle/closeout, within the original
  // 600 stage. A closed/exhausted claim never gets a fresh clock here.
  options.checkpoint(360000);
  const prepared = await post(
    'FULL_CHAIN_NEW_HTTP_PREPARE240',
    `/${requestId}/prepare`,
    'reviewer',
    {
      operationKey: prefix + '_prepare',
      expectedBaseSettlementVersionId: submitted.baseSettlementVersionId,
    },
    false,
  );
  assert.equal(prepared.requestId, requestId);
  assert.equal(prepared.replayed, false);
  for (const key of ['applicationId', 'postingBatchId', 'settlementVersionId'])
    assert(typeof prepared[key] === 'string' && prepared[key].length > 0);
  assert.notEqual(prepared.applicationId, R5_FULL_CHAIN_SOURCE.applicationId);
  assert.notEqual(prepared.postingBatchId, R5_FULL_CHAIN_SOURCE.batchId);
  options.persist({ kind: 'FULL_CHAIN_NEW_PREPARED_ANCHOR', requestId, ...prepared });
  return {
    requestId,
    command: {
      operationKey: prefix + '_prepare',
      expectedBaseSettlementVersionId: R5_FULL_CHAIN_SOURCE.settlementVersionId,
      correctionApplicationId: prepared.applicationId as string,
      postingBatchId: prepared.postingBatchId as string,
    },
    settlementVersionId: prepared.settlementVersionId as string,
  };
}
