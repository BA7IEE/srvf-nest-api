import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import type { NativeLaunchStage } from './native-launch-live.fixture';
import { readR5OriginalJobInTx } from './r5-human-correction-original-job';

export const R5_COMMITTED_PREPARE = Object.freeze({
  schema: 'srvf-r5-committed-prepare/v1',
  evidenceLibraryId: 'libfile_b2c3266fd12081918283f8550f893761',
  evidenceSha256: '42fb34ba12ea684f18f8c6dda5d71ed4a5c93c8ac24ea34c13f3d666d968e9f2',
  sourceBindingSha256: '02fb356c02ae6890f61363a932749ca1ff645b47bce37ff631a72def04c16518',
  xid: '159207',
  activityId: 'cmvwehw3c000fmk123aokqksf',
  requestId: 'cmvwge0z8000umkpgtzedbgdx',
  applicationId: 'cmvwge2vs0014mkpgl3lcunl7',
  postingBatchId: 'cmvwge2vm0012mkpgm9d9xx9g',
  settlementVersionId: 'cmvwge2p60010mkpgbmxh4ol6',
  rootId: 'cmvwgelhz0d5emkpgbb96jsv5',
  proofId: '80368cc1-d458-47ca-a09d-8aa258009c23',
  baseSettlementVersionId: 'cmvweqprb07tvmk127jnkh27l',
  operationKey: 'r5_async_capacity_672ec79088d9_human_prepare_4',
  campaignDeadline: '2026-10-31T14:13:01.168111+00:00',
  closedAt: '2026-10-31T13:52:54.089125+00:00',
  closedPhaseId: 'r5_async_capacity1000_resume_20261031_q1',
  prepareClientVerdict: 'FAIL_120S_BUDGET_P2028',
  prepareDatabaseVerdict: 'COMMITTED',
});

export interface R5PreparedPublicationApproval {
  prepared: typeof R5_COMMITTED_PREPARE;
  approved: boolean;
  reference: string | null;
}
export function assertR5PreparedPublicationApproval(
  p: R5PreparedPublicationApproval | undefined,
  campaignStartedAt: string,
  reference: string | null,
  phaseId: string,
) {
  assert(p, 'prepared publication binding is absent');
  assert.deepEqual(p.prepared, R5_COMMITTED_PREPARE);
  assert.equal(p.approved, true, 'prepared-publication-only stage is not approved');
  assert(typeof p.reference === 'string' && p.reference.trim().length > 0);
  assert.equal(
    reference,
    p.reference,
    'specific publication approval must bind the declared new stage',
  );
  assert.notEqual(
    phaseId,
    R5_COMMITTED_PREPARE.closedPhaseId,
    'closed prepare claim cannot be reused',
  );
  assert(Date.parse(campaignStartedAt) >= Date.parse(R5_COMMITTED_PREPARE.campaignDeadline));
}

export interface R5PreparedState {
  xidStatus: string | null;
  anchors: { object: string; id: string; state: string; xmin: string }[];
  counts: {
    segments: number;
    allocations: number;
    evidence: number;
    bindings: number;
    ledger: number;
    commitPhases: number;
    humanJobs: number;
  };
}
export function assertR5CommittedPrepareState(s: R5PreparedState) {
  assertPreparedState(s, 0);
}
function assertPreparedState(s: R5PreparedState, humanJobs: 0 | 1) {
  const p = R5_COMMITTED_PREPARE;
  assert.equal(s.xidStatus, 'committed');
  const expected = [
    { object: 'request', id: p.requestId, state: 'applying', xmin: p.xid },
    { object: 'application', id: p.applicationId, state: 'preparing', xmin: p.xid },
    { object: 'batch', id: p.postingBatchId, state: 'ready', xmin: p.xid },
    { object: 'version', id: p.settlementVersionId, state: 'approved', xmin: p.xid },
    { object: 'root', id: p.rootId, state: 'correction_time_proof', xmin: p.xid },
    { object: 'proof', id: p.proofId, state: 'frozen', xmin: p.xid },
    { object: 'phase', id: p.applicationId, state: 'SEALED', xmin: p.xid },
  ];
  const sort = (a: R5PreparedState['anchors']) =>
    [...a].sort((x, y) => x.object.localeCompare(y.object));
  assert.deepEqual(
    sort(s.anchors),
    sort(expected),
    'prepared state changed; do not prepare or publish again',
  );
  assert.deepEqual(s.counts, {
    segments: 1000,
    allocations: 1000,
    evidence: 1000,
    bindings: 0,
    ledger: 8000,
    commitPhases: 0,
    humanJobs,
  });
}

/** No source recognition, request, prepare or persistent DML. The next domain
 * write belongs solely to the real HTTP/worker publication path. */
export async function readR5CommittedPrepare(
  db: PrismaClient,
  stage: NativeLaunchStage,
  persist: (value: unknown) => string,
) {
  return await readPrepared(db, stage, persist, false);
}
/** Separate recovery entry: exactly the frozen original failed Job is required.
 * The fresh publication entry retains its humanJobs=0 guard. */
export async function readR5CommittedPrepareForOriginalJobRetry(
  db: PrismaClient,
  stage: NativeLaunchStage,
  persist: (value: unknown) => string,
) {
  return await readPrepared(db, stage, persist, true);
}
async function readPrepared(
  db: PrismaClient,
  stage: NativeLaunchStage,
  persist: (value: unknown) => string,
  originalJobRetry: boolean,
) {
  const p = R5_COMMITTED_PREPARE;
  await stage('COMMITTED_PREPARE_READONLY_QUALIFICATION', () =>
    db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const status = await tx.$queryRaw<
          { status: string | null }[]
        >`SELECT pg_xact_status(${p.xid}::xid8) AS status`;
        const anchors = await tx.$queryRaw<R5PreparedState['anchors']>`
      SELECT 'request' AS object,id,"statusCode" AS state,xmin::text FROM "AttendanceCorrectionRequest" WHERE id=${p.requestId}
      UNION ALL SELECT 'application',id,"statusCode",xmin::text FROM "CorrectionApplication" WHERE id=${p.applicationId}
      UNION ALL SELECT 'batch',id,"statusCode",xmin::text FROM "LedgerPostingBatch" WHERE id=${p.postingBatchId}
      UNION ALL SELECT 'version',id,"statusCode",xmin::text FROM "AttendanceSettlementVersion" WHERE id=${p.settlementVersionId}
      UNION ALL SELECT 'root',id,"sourceKindCode",xmin::text FROM "ActivitySettlementContributionRevision" WHERE id=${p.rootId}
      UNION ALL SELECT 'phase',"applicationId",state,xmin::text FROM "CorrectionWritePhase" WHERE "applicationId"=${p.applicationId} AND phase='prepare'
      UNION ALL SELECT 'proof',id,'frozen',xmin::text FROM "CorrectionTimeSourceProof" WHERE id=${p.proofId}`;
        const [counts] = await tx.$queryRaw<R5PreparedState['counts'][]>`SELECT
      (SELECT count(*)::int FROM "CorrectionPendingSegmentRevision" WHERE "applicationId"=${p.applicationId}) AS segments,
      (SELECT count(*)::int FROM "CorrectionPendingTimeAllocation" WHERE "applicationId"=${p.applicationId}) AS allocations,
      (SELECT count(*)::int FROM "CorrectionPendingTimeAllocationEvidence" e JOIN "CorrectionPendingTimeAllocation" a ON a.id=e."pendingAllocationId" WHERE a."applicationId"=${p.applicationId}) AS evidence,
      (SELECT count(*)::int FROM "CorrectionTimeAllocationBinding" WHERE "proofId"=${p.proofId}) AS bindings,
      (SELECT count(*)::int FROM "ParticipationLedgerEntry" WHERE "postingBatchId"=${p.postingBatchId}) AS ledger,
      (SELECT count(*)::int FROM "CorrectionWritePhase" WHERE "applicationId"=${p.applicationId} AND phase='commit') AS "commitPhases",
      (SELECT count(*)::int FROM "ActivityBatchJob" WHERE "activityId"=${p.activityId} AND "jobTypeCode"='human_correction_commit') AS "humanJobs"`;
        assert.equal(status.length, 1);
        const preparedState = { xidStatus: status[0].status, anchors, counts };
        if (originalJobRetry) {
          assertPreparedState(preparedState, 1);
          persist({
            kind: 'ORIGINAL_FAILED_JOB_READONLY_BINDING',
            ...(await readR5OriginalJobInTx(tx)),
          });
        } else assertR5CommittedPrepareState(preparedState);
        const ledger = await tx.$queryRaw<
          { xmin: string; count: number }[]
        >`SELECT xmin::text AS xmin,count(*)::int AS count FROM "ParticipationLedgerEntry" WHERE "postingBatchId"=${p.postingBatchId} GROUP BY xmin::text`;
        assert.deepEqual(ledger, [{ xmin: p.xid, count: 8000 }]);
        const request = await tx.attendanceCorrectionRequest.findUniqueOrThrow({
          where: { id: p.requestId },
        });
        assert.equal(request.activityId, p.activityId);
        assert.equal(request.baseSettlementVersionId, p.baseSettlementVersionId);
        const app = await tx.correctionApplication.findUniqueOrThrow({
          where: { id: p.applicationId },
        });
        assert.equal(app.correctionRequestId, p.requestId);
        assert.equal(app.newPostingBatchId, p.postingBatchId);
        assert.equal(app.newSettlementVersionId, p.settlementVersionId);
        const batch = await tx.ledgerPostingBatch.findUniqueOrThrow({
          where: { id: p.postingBatchId },
        });
        assert.equal(batch.requestKey, `correction-apply:${p.requestId}:${p.operationKey}`);
        assert(request.requestHash);
        assert.equal(batch.requestHash, request.requestHash);
        const proof = await tx.correctionTimeSourceProof.findUniqueOrThrow({
          where: { applicationId: p.applicationId },
        });
        assert.equal(proof.id, p.proofId);
        assert.equal(proof.activityId, p.activityId);
        assert.equal(proof.postingBatchId, p.postingBatchId);
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
        assert.equal(root.settlementVersionId, p.settlementVersionId);
        assert.equal(root.correctionTimeSourceProofId, p.proofId);
        persist({
          kind: 'COMMITTED_PREPARE_QUALIFIED_NOT_REPLAYED',
          source: p,
          anchors,
          counts,
          proof,
          root,
          previousPrepareClientFailurePreserved: true,
        });
      },
      { isolationLevel: 'RepeatableRead', timeout: 30000, maxWait: 2000 },
    ),
  );
  const { assertNativeLaunchFrozenOracle } = await import('./native-launch-live.fixture');
  await assertNativeLaunchFrozenOracle(
    db,
    { id: p.rootId, sourceKindCode: 'correction_time_proof' },
    8000,
    stage,
  );
  return {
    activityId: p.activityId,
    requestId: p.requestId,
    proofId: p.proofId,
    command: {
      operationKey: p.operationKey,
      expectedBaseSettlementVersionId: p.baseSettlementVersionId,
      correctionApplicationId: p.applicationId,
      postingBatchId: p.postingBatchId,
    },
    preparedOracle: { rootId: p.rootId, proofId: p.proofId, evaluations: 8000 as const },
  };
}
