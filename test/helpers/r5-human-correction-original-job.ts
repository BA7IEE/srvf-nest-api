import assert from 'node:assert/strict';
import type { Prisma } from '@prisma/client';
import {
  humanCorrectionItemHash,
  humanCorrectionJobHash,
  parseHumanCorrectionJobPayload,
  type HumanCorrectionJobFence,
} from '../../src/modules/activities/human-correction-intent';

/** Immutable recovery input from the independently captured original failed attempt; not authentication. */
export const R5_ORIGINAL_JOB = Object.freeze({
  schema: 'srvf-r5-original-job-retry/v1',
  evidenceLibraryId: 'libfile_09a87611dad08191bf0d55e70e1503d0',
  evidenceSha256: 'e73cf7632aaee71a4b68579045d04446aed58b5dea9ea5109816321c8c668c35',
  previousSourceBindingSha256: '435b12ce02bc2fede362097f28783e7fdc0d402ab13e4c2f207ca0b9fcacf1cf',
  jobId: 'cmvwljrap000lmkjpz2m5p176',
  itemId: 'cmvwljrgf000nmkjpb1q64jrn',
  requestHash: 'dd0e8a0097aac56d4fc5cdf1b5c0570ea99cb078701e3ee4153264892e75fad9',
  payloadHash: '60205317d90f7cb323b15c38fd4893920e77bd029d11abea0d8d09c93b51c274',
  leaseGeneration: 5,
  itemEpoch: 4,
  failedXid: '159266',
  abortedNativeXid: '159265',
  closedPhaseId: 'r5_async_capacity1000_resume_retry_20261031_q1',
  closedCampaignDeadline: '2026-10-31T17:42:46.637035+00:00',
  payload: {
    action: 'human_correction_commit',
    schemaVersion: 3,
    activityId: 'cmvwehw3c000fmk123aokqksf',
    requestId: 'cmvwge0z8000umkpgtzedbgdx',
    applicationId: 'cmvwge2vs0014mkpgl3lcunl7',
    settlementRunId: 'cmvweks8u0028mk129tdw1anl',
    newSettlementVersionId: 'cmvwge2p60010mkpgbmxh4ol6',
    rootManifestId: 'cmvweomuw01n6mk12g3mm5seo',
    postingBatchId: 'cmvwge2vm0012mkpgm9d9xx9g',
    baseSettlementVersionId: 'cmvweqprb07tvmk127jnkh27l',
    actorUserId: 'cmvt8gywm006tmkdfttqk085k',
    operationKey: 'r5_async_capacity_672ec79088d9_human_prepare_4',
    commitRequestHash: 'aeda130ea88d50bdcc0f7af6ed485d9c414e47617ce32fbf6e414a14057f52f6',
    sourceRequestHash: 'fb3a6be7d1ad52e07b4c748ac12c16918bec8e342967a42f5a2ba8d799539502',
    sourceProofHash: '6948e4456fa820fa32be3e12aad46b0b532bfc6b0960c16090349a842990ddd9',
    segmentCount: 1000,
  },
} as const);

export interface R5OriginalJobRetryApproval {
  original: typeof R5_ORIGINAL_JOB;
  approved: boolean;
  reference: string | null;
}
export function assertR5OriginalJobRetryApproval(
  input: R5OriginalJobRetryApproval | undefined,
  phaseId: string,
  campaignStartedAt: string,
  approvalReference: string | null,
) {
  assert(input, 'explicit original-job retry binding is required');
  assert.deepEqual(input.original, R5_ORIGINAL_JOB);
  assert.equal(input.approved, true, 'original-job retry stage is not approved');
  assert(typeof input.reference === 'string' && input.reference.trim().length > 0);
  assert.equal(
    input.reference,
    approvalReference,
    'retry approval must bind this stage authorization',
  );
  assert.notEqual(phaseId, R5_ORIGINAL_JOB.closedPhaseId, 'closed native claim cannot be reused');
  assert(Date.parse(campaignStartedAt) >= Date.parse(R5_ORIGINAL_JOB.closedCampaignDeadline));
}

export interface R5OriginalJobState {
  abortedNativeStatus: string | null;
  jobs: {
    id: string;
    jobTypeCode: string;
    statusCode: string;
    activityId: string;
    postingBatchId: string | null;
    createdByUserId: string | null;
    payloadVersion: number;
    payload: unknown;
    requestHash: string | null;
    lastErrorCode: string | null;
    leaseOwner: string | null;
    leaseGeneration: number;
    leaseExpiresAt: Date | null;
    xmin: string;
  }[];
  items: {
    id: string;
    jobId: string;
    itemKey: string;
    statusCode: string;
    attempts: number;
    lastErrorCode: string | null;
    resourceType: string | null;
    resourceId: string | null;
    payloadHash: string | null;
    resultReference: string | null;
    xmin: string;
  }[];
}
function assertOriginalPayload(value: unknown) {
  const payload = parseHumanCorrectionJobPayload(value);
  // Payload is JSON with scalar fields. Compare every key/value, independent
  // of a serializer/VM's Object prototype; retain exact immutable parameters.
  const keys = Object.keys(R5_ORIGINAL_JOB.payload).sort();
  assert.deepEqual(Object.keys(payload).sort(), keys);
  for (const key of keys)
    assert.equal(Reflect.get(payload, key), Reflect.get(R5_ORIGINAL_JOB.payload, key), key);
  return payload;
}
export function assertR5OriginalJobState(
  state: R5OriginalJobState,
  mode: 'failed' | 'retry-pending' = 'failed',
) {
  const f = R5_ORIGINAL_JOB;
  assert.equal(
    state.abortedNativeStatus,
    'aborted',
    'old native outcome is not independently aborted',
  );
  assert.equal(state.jobs.length, 1);
  assert.equal(state.items.length, 1);
  const [job] = state.jobs,
    [item] = state.items;
  const payload = assertOriginalPayload(job.payload);
  assert.equal(humanCorrectionJobHash(payload), f.requestHash);
  assert.equal(humanCorrectionItemHash(f.jobId, payload), f.payloadHash);
  assert.deepEqual(
    [
      job.id,
      job.jobTypeCode,
      job.activityId,
      job.postingBatchId,
      job.createdByUserId,
      job.payloadVersion,
      job.requestHash,
    ],
    [
      f.jobId,
      'human_correction_commit',
      payload.activityId,
      payload.postingBatchId,
      payload.actorUserId,
      1,
      f.requestHash,
    ],
  );
  assert.deepEqual(
    [
      item.id,
      item.jobId,
      item.itemKey,
      item.resourceType,
      item.resourceId,
      item.payloadHash,
      item.resultReference,
      item.attempts,
    ],
    [
      f.itemId,
      f.jobId,
      'human-correction-commit:v2',
      'CorrectionApplication',
      payload.applicationId,
      f.payloadHash,
      null,
      f.itemEpoch,
    ],
  );
  assert.equal(job.leaseOwner, null);
  assert.equal(job.leaseExpiresAt, null);
  assert.equal(job.leaseGeneration, f.leaseGeneration + (mode === 'retry-pending' ? 1 : 0));
  const status = mode === 'failed' ? 'failed' : 'pending';
  const code = mode === 'failed' ? 'HUMAN_CORRECTION_CONFIRMED_UNAPPLIED' : null;
  assert.deepEqual(
    [job.statusCode, item.statusCode, job.lastErrorCode, item.lastErrorCode],
    [status, status, code, code],
  );
  if (mode === 'failed') assert.deepEqual([job.xmin, item.xmin], [f.failedXid, f.failedXid]);
  else {
    assert(/^[1-9][0-9]*$/.test(job.xmin));
    assert.notEqual(job.xmin, f.failedXid);
    assert.equal(job.xmin, item.xmin, 'retry Item and Job must share metadata transaction');
  }
}

/** Observer-only qualification. No state transition, privilege switch or auth bypass. */
export async function readR5OriginalJobInTx(
  tx: Prisma.TransactionClient,
  mode: 'failed' | 'retry-pending' = 'failed',
) {
  const f = R5_ORIGINAL_JOB;
  const xids = await tx.$queryRaw<{ status: string | null }[]>`
    SELECT pg_xact_status(${f.abortedNativeXid}::xid8) AS status`;
  assert.equal(xids.length, 1);
  const jobs = await tx.$queryRaw<R5OriginalJobState['jobs']>`
    SELECT id,"jobTypeCode","statusCode","activityId","postingBatchId","createdByUserId",
      "payloadVersion",payload,"requestHash","lastErrorCode","leaseOwner","leaseGeneration",
      "leaseExpiresAt",xmin::text AS xmin FROM "ActivityBatchJob" WHERE id=${f.jobId}`;
  const items = await tx.$queryRaw<R5OriginalJobState['items']>`
    SELECT id,"jobId","itemKey","statusCode",attempts,"lastErrorCode","resourceType",
      "resourceId","payloadHash","resultReference",xmin::text AS xmin
    FROM "ActivityBatchJobItem" WHERE "jobId"=${f.jobId}`;
  const state = { abortedNativeStatus: xids[0].status, jobs, items };
  assertR5OriginalJobState(state, mode);
  return {
    jobId: f.jobId,
    itemId: f.itemId,
    requestHash: f.requestHash,
    payloadHash: f.payloadHash,
    leaseGeneration: jobs[0].leaseGeneration,
    itemEpoch: items[0].attempts,
    mode,
    originalActorUserId: f.payload.actorUserId,
    authenticatedRetryEligibility: false,
  };
}

export function assertR5OriginalJobDetail(response: unknown, pending = false) {
  const f = R5_ORIGINAL_JOB;
  assert(response && typeof response === 'object');
  assert.equal(Reflect.get(response, 'status'), 200);
  const body: unknown = Reflect.get(response, 'body');
  assert(body && typeof body === 'object');
  assert.equal(Reflect.get(body, 'code'), 0);
  const data: unknown = Reflect.get(body, 'data');
  assert(data && typeof data === 'object');
  for (const [key, value] of Object.entries({
    jobId: f.jobId,
    correctionApplicationId: f.payload.applicationId,
    postingBatchId: f.payload.postingBatchId,
    stage: pending ? 'queued' : 'failed',
    applied: false,
    completedUnits: 0,
    totalUnits: 1,
    segmentCount: 1000,
    attempt: f.itemEpoch,
    retryAllowed: !pending,
  }))
    assert.deepEqual(Reflect.get(data, key), value, key);
}

/** Existing authenticated HTTP API only; no acceptance, prepare or direct DML. */
export async function retryR5OriginalJobThroughApi(input: {
  detail: () => Promise<unknown>;
  qualify: () => Promise<void>;
  retry: () => Promise<unknown>;
}) {
  assertR5OriginalJobDetail(await input.detail()); // Real route reauthorizes actor and source.
  await input.qualify(); // Exact live epoch/hash/generation; not a stale read-only receipt.
  const response = await input.retry(); // Its production transaction repeats locks/auth/CAS.
  assertR5OriginalJobDetail(response, true);
  return R5_ORIGINAL_JOB.jobId;
}

export function assertR5OriginalJobFence(
  fence: HumanCorrectionJobFence | undefined,
  actorId: string,
) {
  const f = R5_ORIGINAL_JOB;
  assert(fence, 'original task retry requires its protected attempt fence');
  assert.deepEqual(
    [fence.jobId, fence.intentItemId, fence.intentHash, fence.itemEpoch, fence.leaseGeneration],
    [f.jobId, f.itemId, f.payloadHash, f.itemEpoch + 1, f.leaseGeneration + 2],
    'new worker must consume exactly the retried original task and next epoch/generation',
  );
  assert(typeof fence.leaseOwner === 'string' && fence.leaseOwner.length > 0);
  assertOriginalPayload(fence.payload);
  assert.equal(actorId, f.payload.actorUserId);
}
