import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { NativeLaunchStage } from './native-launch-live.fixture';
import type { R5PreparedPublicationApproval } from './r5-human-correction-prepared-source';

/** Exact committed fixture handoff. These are source inputs, never a prepared
 * Human application or authority to start a new clock. */
export const R5_RETAINED_CAPACITY1000_SOURCE = Object.freeze({
  schema: 'srvf-r5-retained-source/v1',
  evidenceLibraryId: 'libfile_9213bdd2b3208191adccac57c9bdeb8d',
  evidenceSha256: '991bf9680190884f0f0905e09ea9cc7f8bccacab7b798b0070c6f9b3b3071593',
  originalSourceBindingSha256: '785caae232aece1067daef6914681964ddbd87b9dbf8e72835a3c2e0450f8e67',
  activityId: 'cmvwehw3c000fmk123aokqksf',
  mainBatchId: 'cmvweogmy01mzmk12yy22uzf7',
  mainVersionId: 'cmvwenab701mhmk122jd9uswo',
  mainRootId: 'cmvwenjfg01mlmk129amt0j5g',
  unchangedRequestId: 'cmvweqoj307tpmk12kqezbjg0',
  unchangedApplicationId: 'cmvweqpwf07tzmk12001l2ygt',
  unchangedVersionId: 'cmvweqprb07tvmk127jnkh27l',
  unchangedRootId: 'cmvweqv7h07u1mk12aikiwblw',
  unchangedBatchId: 'cmvweqpwb07txmk1264mfuir1',
  campaignStartedAt: '2026-10-31T12:49:18.472967+00:00',
  campaignDeadline: '2026-10-31T13:19:18.472967+00:00',
  closedPhaseId: 'r5_async_capacity1000_20261031_q2',
  closedAt: '2026-10-31T13:01:50.274926+00:00',
  completedFixtureElapsedMs: 466202.708946,
  lastDiskFreeBytes: 10578853888,
  originalFailurePreserved: true,
});

export interface R5RetainedContinuation {
  preparedPublication?: R5PreparedPublicationApproval;
  source: typeof R5_RETAINED_CAPACITY1000_SOURCE;
  clockMode: 'ORIGINAL_CAMPAIGN' | 'NEW_INDEPENDENT_RETAINED_SOURCE_STAGE';
  independentStageApproved: boolean;
  independentStageApprovalReference: string | null;
  measurementBoundary: 'GUARDED_RETAINED_SOURCE_THROUGH_PREPARE_AND_REAL_COMMIT';
}

export function assertR5RetainedContinuation(
  c: R5RetainedContinuation | undefined,
  approval: {
    phaseId: string;
    phaseStartedAt: string;
    campaignStartedAt: string;
    campaignDeadline: string;
  },
) {
  assert(c, 'retained-source handoff is absent');
  assert.deepEqual(c.source, R5_RETAINED_CAPACITY1000_SOURCE, 'retained source/evidence differs');
  assert.equal(c.measurementBoundary, 'GUARDED_RETAINED_SOURCE_THROUGH_PREPARE_AND_REAL_COMMIT');
  assert(/^r5_async_capacity1000_resume_[A-Za-z0-9_-]+$/.test(approval.phaseId));
  assert(!['r5_async_capacity1000_20261031_q1', c.source.closedPhaseId].includes(approval.phaseId));
  assert(Date.parse(approval.phaseStartedAt) >= Date.parse(c.source.closedAt));
  if (c.clockMode === 'ORIGINAL_CAMPAIGN') {
    assert.equal(Date.parse(approval.campaignStartedAt), Date.parse(c.source.campaignStartedAt));
    assert.equal(Date.parse(approval.campaignDeadline), Date.parse(c.source.campaignDeadline));
    assert.equal(c.independentStageApproved, false);
    assert.equal(c.independentStageApprovalReference, null);
  } else {
    assert.equal(c.clockMode, 'NEW_INDEPENDENT_RETAINED_SOURCE_STAGE');
    assert.equal(
      c.independentStageApproved,
      true,
      'new independent retained-source stage is not approved',
    );
    assert(
      typeof c.independentStageApprovalReference === 'string' &&
        c.independentStageApprovalReference.trim().length > 0,
    );
    assert(Date.parse(approval.campaignStartedAt) >= Date.parse(c.source.campaignDeadline));
  }
}

export interface R5RetainedSourceState {
  anchors: { object: string; id: string; state: string; xmin: string }[];
  xidStates: { xid: string; status: string | null }[];
  counts: {
    identities: number;
    segments: number;
    allocations: number;
    slices: number;
    committedAllocations: number;
    pending: number;
    proofs: number;
  };
  requests: string[];
  applications: string[];
}
export function assertR5RetainedSourceState(s: R5RetainedSourceState) {
  const b = R5_RETAINED_CAPACITY1000_SOURCE;
  const expected = [
    { object: 'batch', id: b.mainBatchId, state: 'committed', xmin: '159148' },
    { object: 'batch', id: b.unchangedBatchId, state: 'committed', xmin: '159157' },
    { object: 'request', id: b.unchangedRequestId, state: 'applied', xmin: '159157' },
    { object: 'application', id: b.unchangedApplicationId, state: 'committed', xmin: '159157' },
    { object: 'version', id: b.mainVersionId, state: 'approved', xmin: '159136' },
    { object: 'version', id: b.unchangedVersionId, state: 'approved', xmin: '159156' },
    { object: 'root', id: b.mainRootId, state: 'time_revision', xmin: '159131' },
    { object: 'root', id: b.unchangedRootId, state: 'unchanged_time', xmin: '159156' },
  ];
  const sort = (a: R5RetainedSourceState['anchors']) =>
    [...a].sort((x, y) => x.id.localeCompare(y.id));
  assert.deepEqual(sort(s.anchors), sort(expected), 'committed source anchors changed');
  assert.deepEqual(
    [...s.xidStates].sort((a, b) => a.xid.localeCompare(b.xid)),
    [
      { xid: '159148', status: 'committed' },
      { xid: '159156', status: 'committed' },
      { xid: '159157', status: 'committed' },
    ],
  );
  assert.deepEqual(s.counts, {
    identities: 2000,
    segments: 10000,
    allocations: 10000,
    slices: 50000,
    committedAllocations: 0,
    pending: 0,
    proofs: 0,
  });
  assert.deepEqual(
    s.requests,
    [b.unchangedRequestId],
    'a Human request already exists; do not resubmit',
  );
  assert.deepEqual(
    s.applications,
    [b.unchangedApplicationId],
    'a Human application already exists; do not prepare again',
  );
}

/** Read-only freeze of the exact retained fixture before any resumed domain
 * write. No MAIN/unchanged operation is reachable from this function. */
export async function readR5RetainedCapacitySource(
  db: PrismaClient,
  stage: NativeLaunchStage,
  persist: (value: unknown) => string,
) {
  const b = R5_RETAINED_CAPACITY1000_SOURCE;
  const frozen = await stage('RETAINED_SOURCE_GUARDED_READONLY_FREEZE', () =>
    db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const anchors = await tx.$queryRaw<R5RetainedSourceState['anchors']>`
      SELECT 'batch' AS object,id,"statusCode" AS state,xmin::text FROM "LedgerPostingBatch" WHERE id IN (${b.mainBatchId},${b.unchangedBatchId})
      UNION ALL SELECT 'request',id,"statusCode",xmin::text FROM "AttendanceCorrectionRequest" WHERE id=${b.unchangedRequestId}
      UNION ALL SELECT 'application',id,"statusCode",xmin::text FROM "CorrectionApplication" WHERE id=${b.unchangedApplicationId}
      UNION ALL SELECT 'version',id,"statusCode",xmin::text FROM "AttendanceSettlementVersion" WHERE id IN (${b.mainVersionId},${b.unchangedVersionId})
      UNION ALL SELECT 'root',id,"sourceKindCode",xmin::text FROM "ActivitySettlementContributionRevision" WHERE id IN (${b.mainRootId},${b.unchangedRootId})`;
        const xidStates = await tx.$queryRaw<
          R5RetainedSourceState['xidStates']
        >`SELECT v.xid,pg_xact_status(v.xid::xid8) AS status FROM (VALUES ('159148'),('159156'),('159157')) v(xid)`;
        const requests = await tx.attendanceCorrectionRequest.findMany({
          where: { activityId: b.activityId },
          select: { id: true },
          orderBy: { id: 'asc' },
        });
        const applications = await tx.correctionApplication.findMany({
          where: { correctionRequest: { activityId: b.activityId } },
          select: { id: true },
          orderBy: { id: 'asc' },
        });
        const segments = await tx.participantServiceSegmentRevision.findMany({
          where: { identity: { activityId: b.activityId }, statusCode: { not: 'superseded' } },
          include: { identity: { select: { memberId: true } } },
          orderBy: { id: 'asc' },
        });
        const allocations = await tx.participantTimeAllocationRevision.findMany({
          where: { activityId: b.activityId },
          orderBy: { id: 'asc' },
        });
        const slices = await tx.participantTimeAllocationSlice.findMany({
          where: { activityId: b.activityId },
          orderBy: { id: 'asc' },
        });
        const original = await tx.participantSettlementResultRevision.findMany({
          where: { settlementVersionId: b.mainVersionId },
          orderBy: { id: 'asc' },
        });
        const currentRoot = await tx.activitySettlementContributionRevision.findUniqueOrThrow({
          where: { id: b.unchangedRootId },
        });
        assert.equal(currentRoot.settlementVersionId, b.unchangedVersionId);
        assert.equal(currentRoot.previousContributionRevisionId, b.mainRootId);
        const state: R5RetainedSourceState = {
          anchors,
          xidStates,
          requests: requests.map((r) => r.id),
          applications: applications.map((r) => r.id),
          counts: {
            identities: await tx.activityParticipationIdentity.count({
              where: { activityId: b.activityId },
            }),
            segments: segments.length,
            allocations: allocations.length,
            slices: slices.length,
            committedAllocations: allocations.filter((r) => r.settlementDraftVersionId === null)
              .length,
            pending: await tx.correctionPendingTimeAllocation.count({
              where: { application: { correctionRequest: { activityId: b.activityId } } },
            }),
            proofs: await tx.correctionTimeSourceProof.count({
              where: { activityId: b.activityId },
            }),
          },
        };
        assertR5RetainedSourceState(state);
        assert.equal(original.length, 2000);
        assert(
          segments.every(
            (r) => r.statusCode === 'committed' && r.resultCode === 'valid' && r.checkOutAt,
          ),
        );
        assert.equal(new Set(segments.map((r) => r.participationIdentityId)).size, 2000);
        const content = { state, segments, allocations, slices, original, currentRoot };
        persist({
          kind: 'RETAINED_SOURCE_INPUT_FROZEN_BEFORE_DOMAIN_WRITE',
          evidence: b,
          contentSha256: createHash('sha256').update(JSON.stringify(content)).digest('hex'),
          content,
        });
        return {
          source: {
            activityId: b.activityId,
            segments,
            raw: { people: [{ identityId: segments[0].participationIdentityId }] },
          },
          posted: { batchId: b.mainBatchId },
          unchanged: { newSettlementVersionId: b.unchangedVersionId },
          results: original.map((row) => ({
            participationIdentityId: row.participationIdentityId,
            resultCode: row.resultCode,
            lateFlag: !row.lateFlag,
            earlyLeaveFlag: row.earlyLeaveFlag,
            recognizedServiceHours: row.recognizedServiceHours.toFixed(2),
            recognizedContributionPoints: row.recognizedContributionPoints.toFixed(2),
            adjustmentReason: 'Fresh capacity approved fact correction',
          })),
        };
      },
      { isolationLevel: 'RepeatableRead', timeout: 30000, maxWait: 2000 },
    ),
  );
  // Historical metadata does not freeze every evaluation document. Requalify
  // the retained unchanged copy and its predecessor's full/day oracle in this
  // declared stage, before recognition; never replay either business commit.
  const { assertNativeLaunchFrozenOracle } = await import('./native-launch-live.fixture');
  await assertNativeLaunchFrozenOracle(
    db,
    { id: b.unchangedRootId, sourceKindCode: 'unchanged_time' },
    8000,
    stage,
  );
  return frozen;
}
