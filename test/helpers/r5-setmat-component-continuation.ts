import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { PrismaClient } from '@prisma/client';

export const R5_COMPONENT_ORIGIN = Object.freeze({
  libraryId: 'libfile_8a320f84d01c8191835a777be31e61a3',
  zipSha256: 'a5eaea25f23d74980810ae83dacc493c65c55c3c265efc6afb4750ea2c4de9a4',
  baseSha256: 'd499bfe10d5ea768f3421b3b11e8b0a093926e64a42934604f7070884b5a3264',
  databaseOid: 1998913,
  xid: '158897',
  activityId: 'cmvuy3p5t000fmkqq1eqk0qa4',
  requestId: 'cmvuydqsk07uqmkqqrlr9s2pj',
  applicationId: 'cmvuydsic07v0mkqq7k2rl3ho',
  postingBatchId: 'cmvuydsi807uymkqqsiiqxyqn',
  settlementVersionId: 'cmvuydscx07uwmkqqhc3z3u4e',
  proofId: '06bb09dc-911d-4a21-b639-aec315526a9f',
  operationKey: 'r5_capacity_12a12b91d802_human_prepare_23',
  originalStageDeadline: '2026-10-30T12:35:21.766691+00:00',
  originalCampaignDeadline: '2026-10-30T12:39:17.379014+00:00',
  originalVerdict: 'FAIL_OR_UNKNOWN_STOP_NOT_CAPACITY_PASS',
  originalRuntimeDirectory: '/workspace/r5-ordinary-capacity-entry-20261030/component1000',
});

export interface R5ComponentContinuation {
  schema: 'srvf-r5-exact-prepared-component-continuation/v1';
  purpose: 'ONE_UNSTARTED_COMPONENT1000_FORCED_ROLLBACK';
  origin: typeof R5_COMPONENT_ORIGIN;
  retainedEvidenceDirectory: string;
  originalFailPreserved: true;
  prepareAndReplayForbidden: true;
  full10000Forbidden: true;
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export function assertR5ComponentContinuation(value: R5ComponentContinuation) {
  assert.equal(value.schema, 'srvf-r5-exact-prepared-component-continuation/v1');
  assert.equal(value.purpose, 'ONE_UNSTARTED_COMPONENT1000_FORCED_ROLLBACK');
  assert.deepEqual(value.origin, R5_COMPONENT_ORIGIN);
  assert.equal(value.originalFailPreserved, true);
  assert.equal(value.prepareAndReplayForbidden, true);
  assert.equal(value.full10000Forbidden, true);
  assert(isAbsolute(value.retainedEvidenceDirectory));
}
export const r5ContinuationClaimPath = () =>
  join(
    R5_COMPONENT_ORIGIN.originalRuntimeDirectory,
    R5_COMPONENT_ORIGIN.applicationId + '.component1000-continuation.attempt.json',
  );

/** The original evidence is immutable input, never an overwritten result directory. */
export function verifyR5ComponentOrigin(directory: string) {
  const expected: Record<string, string> = {
    'RESULT.json': '7df6f1720f237305ba2b8e0c06fbc48a68325fb1dcab6c11d2bc575ccdfaa1c1',
    'component/EXECUTION.json': '143e287fb5d03bbf692287a835b8d3bb6f848b724649189b1998871059078f2c',
    'component/stage-state.json':
      '216b1da20a9f9e71514682aa1cebd51107774eaa5696654e98d98da4be2da2dd',
    'component/post-stop/COMMITTED-PREPARE-IDENTITY.json':
      '06cfb09a80863b35fed78a5cff9d86fcb0072ea2c1fb0d8f2554285ebc6e166c',
    'component/receipts/receipt-0108.json':
      'a6975e7892cd0297fa4a17c82112879aceea654d89cedf6d077c074897f550af',
  };
  for (const [path, sha256] of Object.entries(expected))
    assert.equal(hash(readFileSync(join(directory, path))), sha256, path);
  const identity = JSON.parse(
    readFileSync(join(directory, 'component/post-stop/COMMITTED-PREPARE-IDENTITY.json'), 'utf8'),
  ) as { xidStatus: string; databaseOid: number; requestId: string };
  assert.equal(identity.xidStatus, 'committed');
  assert.equal(identity.databaseOid, R5_COMPONENT_ORIGIN.databaseOid);
  assert.equal(identity.requestId, R5_COMPONENT_ORIGIN.requestId);
}

export interface R5PreparedContinuationFacts {
  xmin: { application: string; proof: string; batch: string; request: string };
  xidStatus: string | null;
  request: {
    id: string;
    activityId: string;
    statusCode: string;
    requestHash: string | null;
    baseSettlementVersionId: string;
    settlementRunId: string;
    submittedByUserId: string | null;
    reviewedByUserId: string | null;
    requestedChangeJson: unknown;
  };
  application: {
    id: string;
    correctionRequestId: string;
    newSettlementVersionId: string;
    newPostingBatchId: string;
    statusCode: string;
    newResultRevisionIds: unknown;
  };
  batch: {
    id: string;
    settlementVersionId: string;
    settlementRunId: string;
    statusCode: string;
    requestKey: string;
    requestHash: string | null;
    preparedByUserId: string | null;
  };
  proof: {
    id: string;
    applicationId: string;
    activityId: string;
    settlementRunId: string;
    settlementVersionId: string;
    baseSettlementVersionId: string;
    postingBatchId: string;
    correctionManifestId: string;
    rootManifestId: string;
    sourceSetHash: string;
    calculationHash: string;
    expectedSegmentCount: number;
    expectedPendingCount: number;
    expectedSliceCount: number;
    expectedBindingCount: number;
  };
  counts: {
    pendingSegments: number;
    pendingAllocations: number;
    pendingEvidence: number;
    evaluations: number;
    bindings: number;
    commitPhases: number;
    cleanupReceipts: number;
    preparationReceipts: number;
    preparedSegments: number;
  };
  resultIds: string[];
  preparationPhase: {
    state: string;
    actorOid: string;
    transactionId: string;
    batchId: string;
    requestId: string;
  }[];
  correctionManifest: {
    id: string;
    correctionRequestId: string;
    requestHash: string;
    activityId: string;
    settlementRunId: string;
    postingBatchId: string;
    settlementVersionId: string;
    baseSettlementVersionId: string;
    rootManifestId: string;
    sourceProofId: string | null;
    sourceProofHash: string | null;
    baseContentHash: string;
  };
}

/** Exact original identities and immutable prepare xmin; no current-site values become expected pins. */
export function assertR5PreparedContinuationFacts(
  facts: R5PreparedContinuationFacts,
  actors: { creatorUserId: string; finalReviewerUserId: string },
) {
  const o = R5_COMPONENT_ORIGIN,
    { request: r, application: a, batch: b, proof: p, correctionManifest: m } = facts;
  assert.equal(facts.xidStatus, 'committed');
  assert.deepEqual(facts.xmin, { application: o.xid, proof: o.xid, batch: o.xid, request: o.xid });
  assert.equal(r.id, o.requestId);
  assert.equal(r.activityId, o.activityId);
  assert.equal(r.statusCode, 'applying');
  assert.match(r.requestHash ?? '', /^[a-f0-9]{64}$/);
  assert.equal(r.submittedByUserId, actors.creatorUserId);
  assert.equal(r.reviewedByUserId, actors.finalReviewerUserId);
  assert.equal(a.id, o.applicationId);
  assert.equal(a.correctionRequestId, r.id);
  assert.equal(a.newSettlementVersionId, o.settlementVersionId);
  assert.equal(a.newPostingBatchId, o.postingBatchId);
  assert.equal(a.statusCode, 'preparing');
  assert.equal(b.id, o.postingBatchId);
  assert.equal(b.settlementVersionId, o.settlementVersionId);
  assert.equal(b.settlementRunId, r.settlementRunId);
  assert.equal(b.statusCode, 'ready');
  assert.equal(b.requestKey, `correction-apply:${r.id}:${o.operationKey}`);
  assert.equal(b.requestHash, r.requestHash);
  assert.equal(b.preparedByUserId, actors.finalReviewerUserId);
  assert.equal(p.id, o.proofId);
  assert.equal(p.applicationId, a.id);
  assert.equal(p.activityId, r.activityId);
  assert.equal(p.settlementRunId, r.settlementRunId);
  assert.equal(p.settlementVersionId, a.newSettlementVersionId);
  assert.equal(p.baseSettlementVersionId, r.baseSettlementVersionId);
  assert.equal(p.postingBatchId, b.id);
  assert.deepEqual(
    [p.expectedSegmentCount, p.expectedPendingCount, p.expectedBindingCount, p.expectedSliceCount],
    [10000, 1000, 10000, 50000],
  );
  assert.match(p.sourceSetHash, /^[a-f0-9]{64}$/);
  assert.match(p.calculationHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(facts.counts, {
    pendingSegments: 1000,
    pendingAllocations: 1000,
    pendingEvidence: 1000,
    evaluations: 8000,
    bindings: 0,
    commitPhases: 0,
    cleanupReceipts: 0,
    preparationReceipts: 1,
    preparedSegments: 1000,
  });
  assert(Array.isArray(a.newResultRevisionIds));
  const ids: unknown[] = a.newResultRevisionIds;
  assert(ids.every((id): id is string => typeof id === 'string' && id.length > 0));
  assert.equal(ids.length, 2000);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ids].sort(), [...facts.resultIds].sort());
  assert.deepEqual(facts.preparationPhase, [
    {
      state: 'SEALED',
      actorOid: '1789091',
      transactionId: o.xid,
      batchId: o.postingBatchId,
      requestId: o.requestId,
    },
  ]);
  assert.equal(m.id, p.correctionManifestId);
  assert.equal(m.correctionRequestId, r.id);
  assert.equal(m.requestHash, r.requestHash);
  assert.equal(m.activityId, r.activityId);
  assert.equal(m.settlementRunId, r.settlementRunId);
  assert.equal(m.postingBatchId, b.id);
  assert.equal(m.settlementVersionId, a.newSettlementVersionId);
  assert.equal(m.baseSettlementVersionId, r.baseSettlementVersionId);
  assert.equal(m.rootManifestId, p.rootManifestId);
  assert.equal(m.sourceProofId, p.id);
  assert.equal(m.sourceProofHash, p.sourceSetHash);
  assert(r.requestedChangeJson && typeof r.requestedChangeJson === 'object');
  assert.equal(Reflect.get(r.requestedChangeJson, 'schemaVersion'), 3);
  const time: unknown = Reflect.get(r.requestedChangeJson, 'timeCorrection');
  assert(time && typeof time === 'object');
  assert.equal(Reflect.get(time, 'baseSettlementVersionId'), r.baseSettlementVersionId);
  assert.equal(Reflect.get(time, 'baseTimeLedgerHash'), m.baseContentHash);
}

export async function readR5PreparedContinuation(
  observer: PrismaClient,
  actors: { creatorUserId: string; finalReviewerUserId: string },
) {
  const o = R5_COMPONENT_ORIGIN;
  return await observer.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$executeRaw`SET LOCAL statement_timeout='30s'`;
      const request = await tx.attendanceCorrectionRequest.findUniqueOrThrow({
        where: { id: o.requestId },
      });
      const application = await tx.correctionApplication.findUniqueOrThrow({
        where: { id: o.applicationId },
      });
      const batch = await tx.ledgerPostingBatch.findUniqueOrThrow({
        where: { id: o.postingBatchId },
      });
      const proof = await tx.correctionTimeSourceProof.findUniqueOrThrow({
        where: { applicationId: o.applicationId },
      });
      const correctionManifest = await tx.participationTimeCorrectionManifest.findUniqueOrThrow({
        where: { id: proof.correctionManifestId },
      });
      const roots = await tx.activitySettlementContributionRevision.findMany({
        where: { settlementVersionId: o.settlementVersionId },
      });
      assert.equal(roots.length, 1);
      const root = roots[0];
      assert.equal(root.sourceKindCode, 'correction_time_proof');
      assert.equal(root.correctionTimeSourceProofId, o.proofId);
      const [xmin] = await tx.$queryRaw<
        (R5PreparedContinuationFacts['xmin'] & { xidStatus: string | null })[]
      >`
      SELECT a.xmin::text AS application, p.xmin::text AS proof, b.xmin::text AS batch,
        r.xmin::text AS request, pg_xact_status(${o.xid}::xid8) AS "xidStatus"
      FROM "CorrectionApplication" a JOIN "CorrectionTimeSourceProof" p ON p."applicationId"=a.id
      JOIN "LedgerPostingBatch" b ON b.id=a."newPostingBatchId"
      JOIN "AttendanceCorrectionRequest" r ON r.id=a."correctionRequestId" WHERE a.id=${o.applicationId}`;
      assert(xmin);
      const { xidStatus, ...rowXmin } = xmin;
      const receipt = await tx.correctionSegmentPreparationReceipt.findUniqueOrThrow({
        where: { applicationId: o.applicationId },
      });
      const resultRows = await tx.participantSettlementResultRevision.findMany({
        where: { settlementVersionId: o.settlementVersionId },
        select: { id: true, correctionRequestId: true },
      });
      assert(resultRows.every((row) => row.correctionRequestId === o.requestId));
      const preparationPhase = await tx.$queryRaw<
        {
          state: string;
          actorOid: string;
          transactionId: string;
          batchId: string;
          requestId: string;
        }[]
      >`
      SELECT state,"actorOid"::text AS "actorOid","transactionId"::text AS "transactionId","batchId","requestId" FROM "CorrectionWritePhase" WHERE "applicationId"=${o.applicationId} AND phase='prepare'`;
      const [countRows] = await tx.$queryRaw<R5PreparedContinuationFacts['counts'][]>`
      SELECT (SELECT count(*)::int FROM "CorrectionPendingSegmentRevision" WHERE "applicationId"=${o.applicationId}) AS "pendingSegments",
      (SELECT count(*)::int FROM "CorrectionPendingTimeAllocation" WHERE "applicationId"=${o.applicationId}) AS "pendingAllocations",
      (SELECT count(*)::int FROM "CorrectionPendingTimeAllocationEvidence" e JOIN "CorrectionPendingTimeAllocation" p ON e."pendingAllocationId"=p.id WHERE p."applicationId"=${o.applicationId}) AS "pendingEvidence",
      (SELECT count(*)::int FROM "ParticipantContributionEvaluation" WHERE "contributionRevisionId"=${root.id}) AS evaluations,
      (SELECT count(*)::int FROM "CorrectionTimeAllocationBinding" WHERE "proofId"=${o.proofId}) AS bindings,
      (SELECT count(*)::int FROM "CorrectionWritePhase" WHERE "applicationId"=${o.applicationId} AND phase='commit') AS "commitPhases",
      (SELECT count(*)::int FROM "CorrectionSegmentCleanupReceipt" WHERE "applicationId"=${o.applicationId}) AS "cleanupReceipts",
      (SELECT count(*)::int FROM "CorrectionSegmentPreparationReceipt" WHERE "applicationId"=${o.applicationId}) AS "preparationReceipts",
      ${receipt.preparedSegmentCount}::int AS "preparedSegments"`;
      const facts: R5PreparedContinuationFacts = {
        request,
        application,
        batch,
        proof,
        correctionManifest,
        xmin: rowXmin,
        xidStatus,
        counts: countRows,
        resultIds: resultRows.map((row) => row.id),
        preparationPhase,
      };
      assertR5PreparedContinuationFacts(facts, actors);
      const generation = await tx.$queryRaw<{ kind: string; count: number; changed: number }[]>`
      SELECT kind,count(*)::int AS count,count(*) FILTER (WHERE original_xmin<>${o.xid})::int AS changed FROM (
        SELECT 'version' AS kind,xmin::text AS original_xmin FROM "AttendanceSettlementVersion" WHERE id=${o.settlementVersionId}
        UNION ALL SELECT 'result',xmin::text FROM "ParticipantSettlementResultRevision" WHERE "settlementVersionId"=${o.settlementVersionId}
        UNION ALL SELECT 'root',xmin::text FROM "ActivitySettlementContributionRevision" WHERE id=${root.id}
        UNION ALL SELECT 'evaluation',xmin::text FROM "ParticipantContributionEvaluation" WHERE "contributionRevisionId"=${root.id}
        UNION ALL SELECT 'manifest',xmin::text FROM "ParticipationTimeCorrectionManifest" WHERE id=${proof.correctionManifestId}
        UNION ALL SELECT 'timeEntry',xmin::text FROM "ParticipationTimeCorrectionEntry" WHERE "manifestId"=${proof.correctionManifestId}
        UNION ALL SELECT 'pendingSegment',xmin::text FROM "CorrectionPendingSegmentRevision" WHERE "applicationId"=${o.applicationId}
        UNION ALL SELECT 'pendingAllocation',xmin::text FROM "CorrectionPendingTimeAllocation" WHERE "applicationId"=${o.applicationId}
        UNION ALL SELECT 'pendingEvidence',e.xmin::text FROM "CorrectionPendingTimeAllocationEvidence" e JOIN "CorrectionPendingTimeAllocation" p ON p.id=e."pendingAllocationId" WHERE p."applicationId"=${o.applicationId}
        UNION ALL SELECT 'phase',xmin::text FROM "CorrectionWritePhase" WHERE "applicationId"=${o.applicationId}
        UNION ALL SELECT 'segmentReceipt',xmin::text FROM "CorrectionSegmentPreparationReceipt" WHERE "applicationId"=${o.applicationId}
        UNION ALL SELECT 'job',xmin::text FROM "ActivityBatchJob" WHERE "postingBatchId"=${o.postingBatchId}
        UNION ALL SELECT 'ledgerEntry',xmin::text FROM "ParticipationLedgerEntry" WHERE "postingBatchId"=${o.postingBatchId}
      ) g GROUP BY kind ORDER BY kind COLLATE "C"`;
      assertR5PreparedGeneration(generation, correctionManifest.expectedEntryCount);
      const version = await tx.attendanceSettlementVersion.findUniqueOrThrow({
        where: { id: o.settlementVersionId },
      });
      assert.equal(version.personCount, 2000);
      assert.equal(version.settlementRunId, request.settlementRunId);
      const baseVersion = await tx.attendanceSettlementVersion.findUniqueOrThrow({
        where: { id: request.baseSettlementVersionId },
      });
      assert.equal(baseVersion.settlementRunId, request.settlementRunId);
      const run = await tx.attendanceSettlementRun.findUniqueOrThrow({
        where: { id: request.settlementRunId },
      });
      assert.equal(run.activityId, o.activityId);
      assert.equal(run.statusCode, 'posting');
      assert.equal(run.currentSubmittedVersion, version.version);
      assert.equal(run.currentPostedVersion, baseVersion.version);
      const jobs = await tx.activityBatchJob.findMany({
        where: { postingBatchId: o.postingBatchId },
      });
      assert.equal(jobs.length, 1);
      const job = jobs[0];
      assert.equal(job.statusCode, 'succeeded');
      assert.equal(job.operationKey, `settlement_prepare:${o.postingBatchId}`);
      assert.equal(job.requestHash, request.requestHash);
      assert.equal(job.activityId, o.activityId);
      assert.equal(job.settlementVersionId, o.settlementVersionId);
      assert.equal(job.createdByUserId, actors.finalReviewerUserId);
      assert.equal(batch.totalCount, 2000);
      assert.equal(batch.preparedCount, 2000);
      assert.equal(batch.failureCount, 0);
      assert(batch.baselineJsonHash);
      assert.equal(batch.committedAt, null);
      const hashes = await tx.$queryRaw<
        {
          requestHash: string;
          applicationHash: string;
          proofHash: string;
          batchHash: string;
          manifestHash: string;
        }[]
      >`
      SELECT encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') AS "requestHash",
      encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex') AS "applicationHash",
      encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') AS "proofHash",
      encode(sha256(convert_to(to_jsonb(b)::text,'UTF8')),'hex') AS "batchHash",
      encode(sha256(convert_to(to_jsonb(m)::text,'UTF8')),'hex') AS "manifestHash"
      FROM "CorrectionApplication" a JOIN "CorrectionTimeSourceProof" p ON p."applicationId"=a.id
      JOIN "LedgerPostingBatch" b ON b.id=a."newPostingBatchId" JOIN "AttendanceCorrectionRequest" r ON r.id=a."correctionRequestId"
      JOIN "ParticipationTimeCorrectionManifest" m ON m.id=p."correctionManifestId" WHERE a.id=${o.applicationId}`;
      assert.equal(hashes.length, 1);
      return {
        root,
        baseSettlementVersionId: request.baseSettlementVersionId,
        summary: {
          kind: 'EXACT_PREPARED_CONTINUATION_IDENTITY',
          origin: o,
          xmin: rowXmin,
          xidStatus,
          requestHash: request.requestHash,
          sourceSetHash: proof.sourceSetHash,
          calculationHash: proof.calculationHash,
          rootId: root.id,
          resultIdsSha256: hash(Buffer.from(JSON.stringify([...facts.resultIds].sort()))),
          counts: countRows,
          generation,
          rowHashes: hashes[0],
          prepareReplayed: false,
          oldStageVerdictUnchanged: true,
        },
      };
    },
    { isolationLevel: 'RepeatableRead', timeout: 30000, maxWait: 2000 },
  );
}

export function assertR5PreparedGeneration(
  rows: { kind: string; count: number; changed: number }[],
  timeEntries: number,
) {
  const expected: Record<string, number> = {
    version: 1,
    result: 2000,
    root: 1,
    evaluation: 8000,
    manifest: 1,
    timeEntry: 16000,
    pendingSegment: 1000,
    pendingAllocation: 1000,
    pendingEvidence: 1000,
    phase: 1,
    segmentReceipt: 1,
    job: 1,
  };
  assert.equal(timeEntries, 16000);
  assert.equal(new Set(rows.map((r) => r.kind)).size, rows.length);
  assert.deepEqual(
    rows.map((r) => r.kind).sort(),
    [...Object.keys(expected), 'ledgerEntry'].sort(),
  );
  for (const row of rows) {
    assert.equal(row.changed, 0, `${row.kind} no longer belongs to original prepare transaction`);
    if (row.kind === 'ledgerEntry') assert(Number.isSafeInteger(row.count) && row.count > 0);
    else assert.equal(row.count, expected[row.kind]);
  }
}
