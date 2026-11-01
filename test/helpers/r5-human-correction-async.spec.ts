import {
  assertR5AsyncBindingReview,
  assertR5AsyncCatalogPair,
  assertR5AsyncItemAcl,
  assertR5AsyncManifest,
  assertR5AsyncResources,
  assertR5AsyncSingleCommit,
  assertR5AsyncNativeReceipt,
  assertR5AsyncWindow,
  assertR5AsyncRuntimeManifest,
  R5_ASYNC_ITEM_COLUMNS,
  R5_ASYNC_ITEM_INSERT,
  R5_ASYNC_ITEM_UPDATE,
  R5_ASYNC_SCOPE,
  R5_ASYNC_CAPACITY1000_SCOPE,
  R5_ASYNC_CAPACITY1000_UNITS,
  R5_ASYNC_RETAINED_CAPACITY1000_SCOPE,
  R5_ASYNC_PREPARED_CAPACITY1000_SCOPE,
  R5_ASYNC_ORIGINAL_JOB_RETRY_SCOPE,
  R5_ASYNC_FIRST_LAUNCH_SCOPE,
  R5_FIRST_LAUNCH_POLICY,
  r5AsyncCallerUrl,
  type R5AsyncBindingReview,
  type R5AsyncManifest,
} from './r5-human-correction-async';
import type { R5ObservedAttempt } from './r5-setmat-concurrency-barrier';
import bindingDraft from './r5-human-correction-async-binding.draft.json';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { observeR5BatchCommitUpdate } from './r5-native-method-observation';
import { capacityDiagnostics } from './r5-setmat-capacity.measurement';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runR5HumanCorrectionAsyncSmoke,
  runR5HumanCorrectionAsyncCapacity1000,
} from './r5-human-correction-async-driver';
import { R5_ASYNC_CAPACITY1000_EVIDENCE_BOUNDARY } from './r5-human-correction-async-capacity';
import {
  R5_ASYNC_INSTALLED_IDENTITIES,
  parseR5AsyncMemoryCredentials,
  r5AsyncPrincipalUrl,
  captureR5AsyncSessionBirth,
  assertR5AsyncRuntimeSource,
} from './r5-human-correction-async-runtime';
import { PrismaClient, Prisma } from '@prisma/client';
import {
  R5_COMMITTED_PREPARE as prepared,
  assertR5CommittedPrepareState,
  type R5PreparedState,
} from './r5-human-correction-prepared-source';
import {
  assertR5RetainedContinuation,
  assertR5RetainedSourceState,
  R5_RETAINED_CAPACITY1000_SOURCE as retained,
  type R5RetainedSourceState,
} from './r5-human-correction-retained-source';
import {
  R5_ORIGINAL_JOB,
  assertR5OriginalJobState,
  assertR5OriginalJobFence,
  retryR5OriginalJobThroughApi,
  type R5OriginalJobState,
} from './r5-human-correction-original-job';

function originalJobState(): R5OriginalJobState {
  const f = R5_ORIGINAL_JOB;
  return {
    abortedNativeStatus: 'aborted',
    jobs: [
      {
        id: f.jobId,
        jobTypeCode: 'human_correction_commit',
        statusCode: 'failed',
        activityId: f.payload.activityId,
        postingBatchId: f.payload.postingBatchId,
        createdByUserId: f.payload.actorUserId,
        payloadVersion: 1,
        payload: structuredClone(f.payload),
        requestHash: f.requestHash,
        lastErrorCode: 'HUMAN_CORRECTION_CONFIRMED_UNAPPLIED',
        leaseOwner: null,
        leaseExpiresAt: null,
        leaseGeneration: f.leaseGeneration,
        xmin: f.failedXid,
      },
    ],
    items: [
      {
        id: f.itemId,
        jobId: f.jobId,
        itemKey: 'human-correction-commit:v2',
        statusCode: 'failed',
        attempts: f.itemEpoch,
        lastErrorCode: 'HUMAN_CORRECTION_CONFIRMED_UNAPPLIED',
        resourceType: 'CorrectionApplication',
        resourceId: f.payload.applicationId,
        payloadHash: f.payloadHash,
        resultReference: null,
        xmin: f.failedXid,
      },
    ],
  };
}
function originalJobResponse(pending = false) {
  const f = R5_ORIGINAL_JOB;
  return {
    status: 200,
    body: {
      code: 0,
      data: {
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
      },
    },
  };
}
describe('explicit original failed Job recovery, without database or automatic retry', () => {
  it('requires the explicit first-launch policy and keeps all historical15 scopes strict', () => {
    const m = preparedManifest();
    m.schema = R5_ASYNC_FIRST_LAUNCH_SCOPE.schema;
    m.approval.scope = R5_ASYNC_FIRST_LAUNCH_SCOPE.approvalScope;
    m.approval.reference = R5_FIRST_LAUNCH_POLICY.approvalReference;
    m.originalJobRetry = {
      original: R5_ORIGINAL_JOB,
      approved: true,
      reference: m.approval.reference,
    };
    expect(() => assertR5AsyncManifest(m, start + 1, R5_ASYNC_FIRST_LAUNCH_SCOPE)).toThrow();
    m.firstLaunchCandidate = R5_FIRST_LAUNCH_POLICY;
    expect(() => assertR5AsyncManifest(m, start + 1, R5_ASYNC_FIRST_LAUNCH_SCOPE)).not.toThrow();
    expect(() =>
      assertR5AsyncSingleCommit(
        [{ ...attempt(), configuredTimeoutMs: 60000 }],
        R5_ASYNC_FIRST_LAUNCH_SCOPE,
      ),
    ).not.toThrow();
    expect(() =>
      assertR5AsyncSingleCommit([{ ...attempt(), configuredTimeoutMs: 60000 }]),
    ).toThrow();
    const r = nativeReceipt();
    r.transactions[0].transactionSettledMs = 20000;
    expect(() => assertR5AsyncNativeReceipt(r, R5_ASYNC_FIRST_LAUNCH_SCOPE)).not.toThrow();
    r.transactions[0].transactionSettledMs = 60001;
    expect(() => assertR5AsyncNativeReceipt(r, R5_ASYNC_FIRST_LAUNCH_SCOPE)).toThrow('60-second');
  });
  it('refuses stale2/2 input after independently observed159265 rollback and5/4 reconciliation', () => {
    const s = originalJobState();
    s.jobs[0].leaseGeneration = 2;
    s.items[0].attempts = 2;
    s.jobs[0].xmin = '159239';
    s.items[0].xmin = '159239';
    expect(() => assertR5OriginalJobState(s)).toThrow();
  });
  it('recomputes both immutable hashes from the exact original payload and checks next metadata state', () => {
    const state = originalJobState();
    expect(() => assertR5OriginalJobState(state)).not.toThrow();
    state.jobs[0] = {
      ...state.jobs[0],
      statusCode: 'pending',
      lastErrorCode: null,
      leaseGeneration: R5_ORIGINAL_JOB.leaseGeneration + 1,
      xmin: '999999',
    };
    state.items[0] = {
      ...state.items[0],
      statusCode: 'pending',
      lastErrorCode: null,
      xmin: '999999',
    };
    expect(() => assertR5OriginalJobState(state, 'retry-pending')).not.toThrow();
    expect(() => assertR5OriginalJobState(state)).toThrow();
  });
  it.each([
    'unknown',
    'jobSafeCode',
    'itemSafeCode',
    'epoch',
    'generation',
    'hash',
    'actor',
    'reattach',
    'extraItem',
  ])('rejects %s before invoking the retry API', async (name) => {
    const state = originalJobState();
    if (name === 'unknown') state.abortedNativeStatus = null;
    if (name === 'jobSafeCode')
      state.jobs[0].lastErrorCode = 'HUMAN_CORRECTION_OUTCOME_UNCONFIRMED';
    if (name === 'itemSafeCode') state.items[0].lastErrorCode = null;
    if (name === 'epoch') state.items[0].attempts = 3;
    if (name === 'generation') state.jobs[0].leaseGeneration = 3;
    if (name === 'hash') state.items[0].payloadHash = 'a'.repeat(64);
    if (name === 'actor')
      state.jobs[0].payload = { ...R5_ORIGINAL_JOB.payload, actorUserId: 'different' };
    if (name === 'reattach') state.items[0].jobId = 'other';
    if (name === 'extraItem') state.items.push({ ...state.items[0], id: 'other' });
    const retry = jest.fn(async () => originalJobResponse(true));
    await expect(
      retryR5OriginalJobThroughApi({
        detail: async () => originalJobResponse(),
        qualify: async () => assertR5OriginalJobState(state),
        retry,
      }),
    ).rejects.toThrow();
    expect(retry).not.toHaveBeenCalled();
  });
  it('reauthorizes by detail before live qualification and calls only the existing retry once', async () => {
    const calls: string[] = [];
    await expect(
      retryR5OriginalJobThroughApi({
        detail: async () => {
          calls.push('authenticated-detail');
          return originalJobResponse();
        },
        qualify: async () => {
          calls.push('live-full-binding');
          assertR5OriginalJobState(originalJobState());
        },
        retry: async () => {
          calls.push('original-retry');
          return originalJobResponse(true);
        },
      }),
    ).resolves.toBe(R5_ORIGINAL_JOB.jobId);
    expect(calls).toEqual(['authenticated-detail', 'live-full-binding', 'original-retry']);
  });
  it('does not qualify, retry, prepare or run a worker after authenticated detail rejects', async () => {
    const qualify = jest.fn(async () => {}),
      retry = jest.fn(async () => originalJobResponse(true));
    await expect(
      retryR5OriginalJobThroughApi({
        detail: async () => ({ status: 403, body: { code: 1 } }),
        qualify,
        retry,
      }),
    ).rejects.toThrow();
    expect(qualify).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });
  it('preserves a retry response failure without reissuing it', async () => {
    const failure = new Error('response lost');
    const retry = jest.fn(async () => {
      throw failure;
    });
    await expect(
      retryR5OriginalJobThroughApi({
        detail: async () => originalJobResponse(),
        qualify: async () => assertR5OriginalJobState(originalJobState()),
        retry,
      }),
    ).rejects.toBe(failure);
    expect(retry).toHaveBeenCalledTimes(1);
  });
  it('requires the next protected epoch and worker generation, retaining original actor', () => {
    const f = R5_ORIGINAL_JOB;
    const fence = {
      jobId: f.jobId,
      intentItemId: f.itemId,
      intentHash: f.payloadHash,
      itemEpoch: f.itemEpoch + 1,
      leaseGeneration: f.leaseGeneration + 2,
      leaseOwner: 'new-worker',
      payload: structuredClone(f.payload),
    };
    expect(() => assertR5OriginalJobFence(fence, f.payload.actorUserId)).not.toThrow();
    expect(() =>
      assertR5OriginalJobFence({ ...fence, itemEpoch: 2 }, f.payload.actorUserId),
    ).toThrow();
    expect(() =>
      assertR5OriginalJobFence({ ...fence, leaseGeneration: 2 }, f.payload.actorUserId),
    ).toThrow();
    expect(() => assertR5OriginalJobFence(fence, 'other')).toThrow();
  });
  it('requires separately approved retry scope and refuses the old closed claim or another Job', () => {
    const m = preparedManifest();
    m.schema = R5_ASYNC_ORIGINAL_JOB_RETRY_SCOPE.schema;
    m.approval.scope = R5_ASYNC_ORIGINAL_JOB_RETRY_SCOPE.approvalScope;
    m.originalJobRetry = { original: R5_ORIGINAL_JOB, approved: false, reference: null };
    expect(() => assertR5AsyncManifest(m, start + 1, R5_ASYNC_ORIGINAL_JOB_RETRY_SCOPE)).toThrow(
      'not approved',
    );
    m.originalJobRetry.approved = true;
    m.originalJobRetry.reference = m.approval.reference;
    expect(() =>
      assertR5AsyncManifest(m, start + 1, R5_ASYNC_ORIGINAL_JOB_RETRY_SCOPE),
    ).not.toThrow();
    m.approval.phaseId = R5_ORIGINAL_JOB.closedPhaseId;
    expect(() => assertR5AsyncManifest(m, start + 1, R5_ASYNC_ORIGINAL_JOB_RETRY_SCOPE)).toThrow(
      'closed native claim',
    );
    m.approval.phaseId = 'r5_async_capacity1000_resume_retry_synthetic';
    m.originalJobRetry.original = {
      ...R5_ORIGINAL_JOB,
      jobId: 'other',
    } as unknown as typeof R5_ORIGINAL_JOB;
    expect(() => assertR5AsyncManifest(m, start + 1, R5_ASYNC_ORIGINAL_JOB_RETRY_SCOPE)).toThrow();
  });
});

function retainedManifest(): R5AsyncManifest {
  const m = manifest();
  m.schema = R5_ASYNC_RETAINED_CAPACITY1000_SCOPE.schema;
  m.capacity = { ...R5_ASYNC_CAPACITY1000_UNITS };
  m.approval.scope = R5_ASYNC_RETAINED_CAPACITY1000_SCOPE.approvalScope;
  m.approval.phaseId = 'r5_async_capacity1000_resume_SYNTHETIC_ONLY';
  m.continuation = {
    source: { ...retained },
    clockMode: 'NEW_INDEPENDENT_RETAINED_SOURCE_STAGE',
    independentStageApproved: true,
    independentStageApprovalReference: 'synthetic-test-only',
    measurementBoundary: 'GUARDED_RETAINED_SOURCE_THROUGH_PREPARE_AND_REAL_COMMIT',
  };
  return m;
}
function retainedState(): R5RetainedSourceState {
  return {
    anchors: [
      { object: 'batch', id: retained.mainBatchId, state: 'committed', xmin: '159148' },
      { object: 'batch', id: retained.unchangedBatchId, state: 'committed', xmin: '159157' },
      { object: 'request', id: retained.unchangedRequestId, state: 'applied', xmin: '159157' },
      {
        object: 'application',
        id: retained.unchangedApplicationId,
        state: 'committed',
        xmin: '159157',
      },
      { object: 'version', id: retained.mainVersionId, state: 'approved', xmin: '159136' },
      { object: 'version', id: retained.unchangedVersionId, state: 'approved', xmin: '159156' },
      { object: 'root', id: retained.mainRootId, state: 'time_revision', xmin: '159131' },
      { object: 'root', id: retained.unchangedRootId, state: 'unchanged_time', xmin: '159156' },
    ],
    xidStates: [
      { xid: '159148', status: 'committed' },
      { xid: '159156', status: 'committed' },
      { xid: '159157', status: 'committed' },
    ],
    counts: {
      identities: 2000,
      segments: 10000,
      allocations: 10000,
      slices: 50000,
      committedAllocations: 0,
      pending: 0,
      proofs: 0,
    },
    requests: [retained.unchangedRequestId],
    applications: [retained.unchangedApplicationId],
  };
}

function preparedManifest(): R5AsyncManifest {
  const m = retainedManifest();
  m.schema = R5_ASYNC_PREPARED_CAPACITY1000_SCOPE.schema;
  m.approval.scope = R5_ASYNC_PREPARED_CAPACITY1000_SCOPE.approvalScope;
  m.approval.phaseId = 'r5_async_capacity1000_resume_publish_SYNTHETIC';
  m.continuation!.preparedPublication = {
    prepared: { ...prepared },
    approved: true,
    reference: 'synthetic-test-only',
  };
  return m;
}
function preparedState(): R5PreparedState {
  return {
    xidStatus: 'committed',
    counts: {
      segments: 1000,
      allocations: 1000,
      evidence: 1000,
      bindings: 0,
      ledger: 8000,
      commitPhases: 0,
      humanJobs: 0,
    },
    anchors: [
      { object: 'request', id: prepared.requestId, state: 'applying', xmin: prepared.xid },
      { object: 'application', id: prepared.applicationId, state: 'preparing', xmin: prepared.xid },
      { object: 'batch', id: prepared.postingBatchId, state: 'ready', xmin: prepared.xid },
      {
        object: 'version',
        id: prepared.settlementVersionId,
        state: 'approved',
        xmin: prepared.xid,
      },
      { object: 'root', id: prepared.rootId, state: 'correction_time_proof', xmin: prepared.xid },
      { object: 'proof', id: prepared.proofId, state: 'frozen', xmin: prepared.xid },
      { object: 'phase', id: prepared.applicationId, state: 'SEALED', xmin: prepared.xid },
    ],
  };
}
describe('committed prepare is consumed without repeating prepare', () => {
  it('accepts exact reconciled durable prepare state despite its client failure', () => {
    expect(() => assertR5CommittedPrepareState(preparedState())).not.toThrow();
    expect(() =>
      assertR5AsyncManifest(preparedManifest(), start + 1, R5_ASYNC_PREPARED_CAPACITY1000_SCOPE),
    ).not.toThrow();
  });
  it.each([
    'unknown',
    'committedPublication',
    'materialized',
    'workerAlreadyCreated',
    'phaseStarted',
    'missingLedger',
  ])('refuses %s before a second publication', (name) => {
    const s = preparedState();
    if (name === 'unknown') s.xidStatus = null;
    if (name === 'committedPublication') s.anchors[1].state = 'committed';
    if (name === 'materialized') s.counts.bindings = 1;
    if (name === 'workerAlreadyCreated') s.counts.humanJobs = 1;
    if (name === 'phaseStarted') s.counts.commitPhases = 1;
    if (name === 'missingLedger') s.counts.ledger = 7999;
    expect(() => assertR5CommittedPrepareState(s)).toThrow();
  });
  it('a generic retained-stage approval does not approve this publication-only stage', () => {
    const m = preparedManifest();
    m.continuation!.preparedPublication!.approved = false;
    expect(() => assertR5AsyncManifest(m, start + 1, R5_ASYNC_PREPARED_CAPACITY1000_SCOPE)).toThrow(
      'not approved',
    );
  });
  it('does not accept publication state through the old source-recognition entry', () => {
    const m = preparedManifest();
    m.schema = R5_ASYNC_RETAINED_CAPACITY1000_SCOPE.schema;
    m.approval.scope = R5_ASYNC_RETAINED_CAPACITY1000_SCOPE.approvalScope;
    expect(() => assertR5AsyncManifest(m, start + 1, R5_ASYNC_RETAINED_CAPACITY1000_SCOPE)).toThrow(
      'publication-only',
    );
  });
});

describe('retained-source continuation preserves old failure and clocks', () => {
  it('accepts only the exact reconciled committed source state', () => {
    expect(() => assertR5RetainedSourceState(retainedState())).not.toThrow();
  });
  it.each([
    'anchor',
    'xidUnknown',
    'newRequest',
    'newApplication',
    'recognized',
    'pending',
    'proof',
    'slices',
  ])('refuses %s before source recognition or Human prepare', (name) => {
    const s = retainedState();
    if (name === 'anchor') s.anchors[0].xmin = '159149';
    if (name === 'xidUnknown') s.xidStates[0].status = null;
    if (name === 'newRequest') s.requests.push('already-submitted-human');
    if (name === 'newApplication') s.applications.push('already-prepared-human');
    if (name === 'recognized') s.counts.committedAllocations = 1;
    if (name === 'pending') s.counts.pending = 1;
    if (name === 'proof') s.counts.proofs = 1;
    if (name === 'slices') s.counts.slices = 49999;
    expect(() => assertR5RetainedSourceState(s)).toThrow();
  });
  it('requires specific independent-stage approval in addition to the general run flag', () => {
    const m = retainedManifest();
    m.continuation!.independentStageApproved = false;
    expect(() => assertR5AsyncManifest(m, start + 1, R5_ASYNC_RETAINED_CAPACITY1000_SCOPE)).toThrow(
      'not approved',
    );
  });
  it('does not turn the old campaign into a fresh 1800 seconds', () => {
    const m = retainedManifest();
    m.continuation!.clockMode = 'ORIGINAL_CAMPAIGN';
    m.continuation!.independentStageApproved = false;
    m.continuation!.independentStageApprovalReference = null;
    expect(() => assertR5RetainedContinuation(m.continuation, m.approval)).toThrow();
  });
  it('refuses an expired original campaign even with a new unused claim', () => {
    const m = retainedManifest();
    m.continuation!.clockMode = 'ORIGINAL_CAMPAIGN';
    m.continuation!.independentStageApproved = false;
    m.continuation!.independentStageApprovalReference = null;
    m.approval.campaignStartedAt = retained.campaignStartedAt;
    m.approval.campaignDeadline = retained.campaignDeadline;
    m.approval.phaseStartedAt = '2026-10-31T13:02:00Z';
    m.approval.phaseDeadline = '2026-10-31T13:12:00Z';
    expect(() =>
      assertR5AsyncManifest(
        m,
        Date.parse(retained.campaignDeadline) + 1,
        R5_ASYNC_RETAINED_CAPACITY1000_SCOPE,
      ),
    ).toThrow('closed or exhausted');
  });
  it('rejects using the retained fixture through the fresh entry scope', () => {
    const m = retainedManifest();
    m.schema = R5_ASYNC_CAPACITY1000_SCOPE.schema;
    m.approval.scope = R5_ASYNC_CAPACITY1000_SCOPE.approvalScope;
    expect(() => assertR5AsyncManifest(m, start + 1, R5_ASYNC_CAPACITY1000_SCOPE)).toThrow(
      'fresh entry',
    );
  });
  it('rejects a changed evidence source or reuse of the closed claim', () => {
    const m = retainedManifest();
    m.continuation!.source = { ...retained, activityId: 'other' } as unknown as typeof retained;
    expect(() => assertR5RetainedContinuation(m.continuation, m.approval)).toThrow(
      'source/evidence',
    );
    m.continuation!.source = { ...retained };
    m.approval.phaseId = retained.closedPhaseId;
    expect(() => assertR5RetainedContinuation(m.continuation, m.approval)).toThrow();
  });
});

const start = Date.parse('2099-01-01T00:00:00Z'); // Synthetic clock only; never a DB dispatch.

describe('minimal native rejection and batch-method observation without database', () => {
  const args = { where: { id: 'batch' }, data: { statusCode: 'committed' } };
  const correlation = () => ({
    phaseId: 'synthetic',
    nativeAttempt: 1,
    identity: { pid: 11, xid: '123' },
    jobId: 'job',
    leaseGeneration: 2,
    itemEpoch: 3,
  });
  it('preserves actual arguments, receiver, lazy thenable and result without capturing payload', async () => {
    const value = { privateResult: 'not-recorded' };
    const events: Record<string, unknown>[] = [];
    const delegate = {
      update: function (this: unknown, input: unknown) {
        expect(this).toBe(delegate);
        expect(input).toBe(args);
        return { then: (resolve: (v: unknown) => void) => resolve(value) };
      },
    };
    const original: unknown = Reflect.get(delegate, 'update');
    let tick = 0;
    const restore = observeR5BatchCommitUpdate(
      delegate,
      'batch',
      correlation,
      (x) => events.push(x),
      () => ({}),
      () => ++tick,
    );
    await expect(delegate.update(args)).resolves.toBe(value);
    expect(events.map((x) => x.event)).toEqual(['STARTED', 'FULFILLED']);
    expect(events[0].correlation).toEqual(correlation());
    expect(JSON.stringify(events)).not.toContain('privateResult');
    restore();
    restore();
    expect(Reflect.get(delegate, 'update')).toBe(original);
  });
  it('keeps the original rejection even if clock, serializer and persistence fail', async () => {
    const error = new Error('original');
    const delegate = {
      update: async (...input: unknown[]) => {
        expect(input).toEqual([args]);
        throw error;
      },
    };
    const restore = observeR5BatchCommitUpdate(
      delegate,
      'batch',
      correlation,
      () => {
        throw new Error('sink');
      },
      () => {
        throw new Error('serializer');
      },
      () => {
        throw new Error('clock');
      },
    );
    await expect(delegate.update(args)).rejects.toBe(error);
    restore();
  });
  it('does not wrap or observe an unrelated batch update', () => {
    const value = Promise.resolve(7);
    const delegate = {
      update: (input: unknown) => {
        expect(input).toEqual({ where: { id: 'other' }, data: { statusCode: 'committed' } });
        return value;
      },
    };
    const events: unknown[] = [];
    const restore = observeR5BatchCommitUpdate(
      delegate,
      'batch',
      correlation,
      (x) => events.push(x),
      () => ({}),
    );
    expect(delegate.update({ where: { id: 'other' }, data: { statusCode: 'committed' } })).toBe(
      value,
    );
    expect(events).toEqual([]);
    restore();
  });
  it('retains strict ownership and marks restored only after a successful restore', () => {
    const delegate = { update: async () => 7 };
    const original = delegate.update;
    const restore = observeR5BatchCommitUpdate(
      delegate,
      'batch',
      correlation,
      () => {},
      () => ({}),
    );
    const hook = delegate.update;
    delegate.update = original;
    expect(restore).toThrow('ownership');
    delegate.update = hook;
    restore();
    restore();
    expect(delegate.update).toBe(original);
  });
  it('supports the real Prisma transaction delegate without connecting', () => {
    const client = new PrismaClient({
      datasourceUrl: 'postgresql://fake:FAKE_ONLY@localhost:1/fake',
    });
    const make: unknown = Reflect.get(client, '_createItxClient');
    expect(typeof make).toBe('function');
    const tx = Reflect.apply(make as (...args: unknown[]) => Prisma.TransactionClient, client, [
      { kind: 'itx', id: 'fake-only' },
    ]);
    const delegate = tx.ledgerPostingBatch;
    const descriptor = Object.getOwnPropertyDescriptor(delegate, 'update');
    const restore = observeR5BatchCommitUpdate(
      delegate,
      'batch',
      correlation,
      () => {},
      () => ({}),
    );
    const hook: unknown = Reflect.get(delegate, 'update');
    restore();
    restore();
    expect(typeof Reflect.get(delegate, 'update')).toBe('function');
    expect(Reflect.get(delegate, 'update')).not.toBe(hook);
    expect(Object.getOwnPropertyDescriptor(delegate, 'update')).toEqual(descriptor);
    expect(delegate).not.toBe(client.ledgerPostingBatch);
  });
  it('executes the actual driver rejection branch before a worker can swallow it, retaining redacted cause and original error', () => {
    const source = readFileSync(join(__dirname, 'r5-human-correction-async-driver.ts'), 'utf8');
    const file = ts.createSourceFile('driver.ts', source, ts.ScriptTarget.Latest, true);
    let block: ts.IfStatement | undefined;
    const visit = (node: ts.Node) => {
      if (
        ts.isIfStatement(node) &&
        node.thenStatement.getText(file).includes("kind: 'ASYNC_NATIVE_ORIGINAL_REJECTION'")
      )
        block = node;
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(block).toBeDefined();
    const text = ts.createPrinter().printNode(ts.EmitHint.Unspecified, block!, file);
    const javascript = ts.transpileModule(
      `(function(attempt,diagnostics,nativeCorrelation){${text}})`,
      { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } },
    ).outputText;
    const invoke = runInNewContext(javascript) as (a: unknown, b: unknown, c: unknown) => void;
    const records: unknown[] = [];
    const diagnostics = capacityDiagnostics(
      (v) => {
        records.push(v);
        return 'pure';
      },
      () => 'native',
      () => [],
    );
    const cause = new Prisma.PrismaClientKnownRequestError(
      'SQL password="PW_PRIVATE_123" https://upload.invalid/?sig=SIGNED_PRIVATE_123',
      {
        code: 'P2010',
        clientVersion: 'synthetic',
        meta: { code: '57014', message: 'secret=SECRET_PRIVATE_123' },
      },
    );
    const error = new Error('token=TOKEN_PRIVATE_123', { cause });
    Object.defineProperty(error, 'sqlState', { value: '57014' });
    let caught: unknown;
    try {
      invoke(
        {
          client: { status: 'rejected', reason: error },
          databaseOutcome: 'ROLLED_BACK',
          observationComplete: true,
          configuredTimeoutMs: 15000,
          evidenceRef: 'pure',
        },
        diagnostics,
        correlation(),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(error);
    expect(records).toHaveLength(1);
    const encoded = JSON.stringify(records);
    for (const secret of [
      'PW_PRIVATE_123',
      'SIGNED_PRIVATE_123',
      'SECRET_PRIVATE_123',
      'TOKEN_PRIVATE_123',
    ])
      expect(encoded).not.toContain(secret);
    expect(encoded).toContain('P2010');
    expect(encoded).toContain('57014');
    expect(encoded).toContain('sqlState');
    expect(encoded).toContain('cause');
    expect(encoded).toContain('stack');
    expect(encoded).toContain('ROLLED_BACK');
  });
});
function manifest(): R5AsyncManifest {
  return {
    schema: R5_ASYNC_SCOPE.schema,
    checkout: '/tmp/synthetic-checkout',
    sourceBinding: { path: '/tmp/synthetic-source.json', sha256: 'a'.repeat(64) },
    base: {
      schema: 'srvf-r5-setmat-safety/v1',
      databaseOid: 1998913,
      creatorUserId: 'creator',
      reviewerUserId: 'A',
      finalReviewerUserId: 'B',
      organizationId: 'org',
      expectedCatalogPath: '/tmp/synthetic-old.json',
      expectedCatalogSha256: 'b'.repeat(64),
      boundPreflightBodySha256: 'c'.repeat(64),
      catalogQueryPath: '/tmp/synthetic-query.sql',
      catalogQuerySha256: 'd'.repeat(64),
      outputDirectory: '/tmp/synthetic-fixture',
    },
    supplemental: {
      querySha256: 'e'.repeat(64),
      expectedPath: '/tmp/synthetic-supplement.json',
      expectedSha256: 'f'.repeat(64),
      origin: 'OFFLINE_SOURCE_REVIEWED',
      sourceReviewReference: 'synthetic-source-review',
      permissionApprovalReference: 'synthetic-permission',
      installedBindingReference: 'synthetic-installation',
    },
    approval: {
      approved: true,
      scope: 'one-fresh-v3-async-real-commit',
      reference: 'synthetic-not-user-approval',
      phaseId: 'synthetic-one-use',
      phaseStartedAt: new Date(start).toISOString(),
      phaseDeadline: new Date(start + 600_000).toISOString(),
      campaignStartedAt: new Date(start).toISOString(),
      campaignDeadline: new Date(start + 1_800_000).toISOString(),
      originalFailuresPreserved: true,
    },
    outputDirectory: '/tmp/synthetic-output',
    control: {
      pid: process.pid + 10000,
      receiptPath: '/tmp/synthetic-control.json',
      receiptSha256: '1'.repeat(64),
    },
  };
}
function review(): R5AsyncBindingReview {
  const m = manifest();
  return {
    status: 'REVIEWED_AND_APPROVED',
    supplementalExpectedCatalogSha256: m.supplemental.expectedSha256,
    installedPreflightBodySha256: m.base.boundPreflightBodySha256,
    originalExpectedCatalogSha256: m.base.expectedCatalogSha256,
    originalCollectorSha256: m.base.catalogQuerySha256,
    queueProvenanceReviewReference: 'synthetic-not-real-review',
    sourceReviewReference: m.supplemental.sourceReviewReference,
    permissionApprovalReference: m.supplemental.permissionApprovalReference,
    installedBindingReference: m.supplemental.installedBindingReference,
  };
}
function acl() {
  return R5_ASYNC_ITEM_COLUMNS.map((column) => ({
    table: 'ActivityBatchJobItem',
    column,
    select: true,
    insert: R5_ASYNC_ITEM_INSERT.includes(column),
    update: R5_ASYNC_ITEM_UPDATE.includes(column),
    tableSelect: false,
    tableInsert: false,
    tableUpdate: false,
    tableDelete: false,
  }));
}
function attempt(): R5ObservedAttempt<unknown> {
  return {
    client: { status: 'fulfilled', value: {} },
    databaseOutcome: 'COMMITTED',
    observationComplete: true,
    configuredTimeoutMs: 15000,
    configuredIsolationLevel: 'ReadCommitted',
    evidenceRef: 'synthetic-only',
  };
}
function catalog() {
  return {
    database: R5_ASYNC_SCOPE.database,
    databaseOid: 1998913,
    namespace: { owner: 'owner', acl: 'synthetic' },
    functions: [{ name: 'guard', bodyHash: 'same' }],
    tables: R5_ASYNC_SCOPE.supplementaryTables.map((name) => ({ name })),
  };
}
function nativeReceipt() {
  const identity = {
    xid: 'synthetic-xid',
    pid: 11,
    role: String(R5_ASYNC_SCOPE.caller),
    sessionUser: R5_ASYNC_INSTALLED_IDENTITIES.P.name,
    roleOid: String(R5_ASYNC_SCOPE.callerOid),
    isSuperuser: 'off',
    database: R5_ASYNC_SCOPE.database,
    databaseOid: R5_ASYNC_SCOPE.databaseOid,
  };
  return {
    transactions: [
      {
        identity,
        callback: 'FULFILLED',
        transactionPromise: 'FULFILLED',
        callbackStartedMs: 1,
        callbackEndedMs: 900,
        transactionStartedMs: 0,
        transactionSettledMs: 1000,
      },
    ],
    engine: {
      status: 'COMPLETE',
      pending: 0,
      phases: [
        { phase: 'start', outcome: 'ok', elapsedMs: 1 },
        { phase: 'commit', outcome: 'ok', elapsedMs: 2 },
      ],
    },
    server: [{ identity, observerPid: 12, status: 'committed' }],
    entry: { elapsedMs: 1001 },
  };
}

describe('R5 async opt-in driver admission without database', () => {
  it('the actual driver refuses unapproved input before reading source or constructing clients', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'r5-async-entry-'));
    const m = manifest();
    m.approval.approved = false;
    const path = join(dir, 'manifest.json');
    writeFileSync(path, JSON.stringify(m));
    try {
      await expect(runR5HumanCorrectionAsyncSmoke(path, 'a'.repeat(64))).rejects.toThrow(
        'not approved',
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
  it('the actual entry refuses a CLI self-signed source inventory before opening it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'r5-async-source-'));
    const path = join(dir, 'manifest.json');
    writeFileSync(path, JSON.stringify(manifest()));
    const now = jest.spyOn(Date, 'now').mockReturnValue(start + 1);
    try {
      await expect(runR5HumanCorrectionAsyncSmoke(path, '9'.repeat(64))).rejects.toThrow(
        'independently frozen',
      );
    } finally {
      now.mockRestore();
      rmSync(dir, { recursive: true });
    }
  });
  it('accepts a shape-valid synthetic plan without granting execution', () => {
    expect(() => assertR5AsyncManifest(manifest(), start + 1)).not.toThrow();
  });
  it('rejects unapproved real-COMMIT stages before any DB work', () => {
    const m = manifest();
    m.approval.approved = false;
    expect(() => assertR5AsyncManifest(m, start + 1)).toThrow('not approved');
  });
  it('cannot promote a source-bound draft with CLI flags', () => {
    expect(() =>
      assertR5AsyncBindingReview(manifest(), {
        ...bindingDraft,
        status: 'DRAFT_UNAPPROVED',
      }),
    ).toThrow('draft');
  });
  it('admits the frozen reviewed receipt only with its exact source and installation pins', () => {
    const m = manifest();
    m.base.expectedCatalogSha256 = bindingDraft.originalExpectedCatalogSha256;
    m.base.boundPreflightBodySha256 = bindingDraft.installedPreflightBodySha256;
    m.base.catalogQuerySha256 = bindingDraft.originalCollectorSha256;
    m.supplemental.expectedSha256 = bindingDraft.supplementalExpectedCatalogSha256;
    m.supplemental.sourceReviewReference = bindingDraft.sourceReviewReference;
    m.supplemental.permissionApprovalReference = bindingDraft.permissionApprovalReference;
    m.supplemental.installedBindingReference = bindingDraft.installedBindingReference;
    expect(() => assertR5AsyncBindingReview(m, bindingDraft as R5AsyncBindingReview)).not.toThrow();
    expect(bindingDraft.runtimeQualification.businessCommitProven).toBe(false);
    m.supplemental.installedBindingReference = 'CLI cannot replace the reviewed installation';
    expect(() => assertR5AsyncBindingReview(m, bindingDraft as R5AsyncBindingReview)).toThrow();
  });
  it('requires the same reviewed source, permission, installation and function pins', () => {
    expect(() => assertR5AsyncBindingReview(manifest(), review())).not.toThrow();
  });
  it('does not treat writable queue rows or a public payload hash as a provenance review', () => {
    const r = review();
    r.queueProvenanceReviewReference = null;
    expect(() => assertR5AsyncBindingReview(manifest(), r)).toThrow('provenance');
  });
  it.each(['originalExpectedCatalogSha256', 'originalCollectorSha256'] as const)(
    'does not substitute the original safety catalog pin %s',
    (field) => {
      const r = review();
      r[field] = '0'.repeat(64);
      expect(() => assertR5AsyncBindingReview(manifest(), r)).toThrow();
    },
  );
  it.each([
    'supplementalExpectedCatalogSha256',
    'installedPreflightBodySha256',
    'sourceReviewReference',
    'permissionApprovalReference',
    'installedBindingReference',
  ] as const)('rejects a mismatched binding-review field %s', (field) => {
    const r = review();
    r[field] = 'wrong';
    expect(() => assertR5AsyncBindingReview(manifest(), r)).toThrow();
  });
  it.each([start - 1, start + 600_000, start + 1_800_000])(
    'refuses a closed phase at %d',
    (now) => {
      expect(() => assertR5AsyncWindow(manifest(), now)).toThrow();
    },
  );
  it('does not grant a 601-second stage or extend the campaign', () => {
    const m = manifest();
    m.approval.phaseDeadline = new Date(start + 601_000).toISOString();
    expect(() => assertR5AsyncWindow(m, start + 1)).toThrow();
    m.approval.phaseDeadline = new Date(start + 600_000).toISOString();
    m.approval.campaignDeadline = new Date(start + 1_800_001).toISOString();
    expect(() => assertR5AsyncWindow(m, start + 1)).toThrow();
  });
  it('reserves the native prepare allowance and owned exit before fixture creation', () => {
    expect(() => assertR5AsyncManifest(manifest(), start + 480_000)).toThrow();
  });
  it('uses startup caller on every worker connection without creating credentials', () => {
    const u = new URL(
      r5AsyncCallerUrl(
        'postgresql://existing:synthetic@localhost/app_test_r5_setmat_20261029_q1?sslmode=require',
      ),
    );
    expect(u.username).toBe('existing');
    expect(u.password).toBe('synthetic');
    expect(u.searchParams.get('options')).toBe('-c role=r5_boundary_caller_h7c6');
    expect(u.searchParams.get('sslmode')).toBe('require');
    expect(u.searchParams.get('connection_limit')).toBe('1');
  });
  it.each(['app_test_r5_native_capacity_20261027_b8a9cd_w95', 'postgres', 'production'])(
    'rejects another database %s',
    (db) => expect(() => r5AsyncCallerUrl(`postgresql://u:synthetic@localhost/${db}`)).toThrow(),
  );
  it.each(['options=-c%20role%3Dpostgres', 'pgbouncer=true', 'schema=other'])(
    'refuses a conflicting connection option %s',
    (options) => {
      expect(() =>
        r5AsyncCallerUrl(
          `postgresql://u:synthetic@localhost/app_test_r5_setmat_20261029_q1?${options}`,
        ),
      ).toThrow();
    },
  );
  it('accepts the proposed finite Item column categories, not a new grant', () => {
    expect(() => assertR5AsyncItemAcl(acl())).not.toThrow();
  });
  it.each(['select', 'insert', 'update'] as const)(
    'rejects missing Item %s even if Job is writable',
    (permission) => {
      const rows = acl();
      const row = rows.find((x) => x[permission]);
      expect(row).toBeDefined();
      row![permission] = false;
      expect(() => assertR5AsyncItemAcl(rows)).toThrow();
    },
  );
  it('rejects duplicate, missing or extra Item columns rather than passing vacuously', () => {
    expect(() => assertR5AsyncItemAcl([])).toThrow();
    expect(() => assertR5AsyncItemAcl([...acl(), acl()[0]])).toThrow();
    expect(() => assertR5AsyncItemAcl(acl().slice(1))).toThrow();
  });
  it('rejects extra mutable identity columns and table-level DELETE', () => {
    const rows = acl();
    rows.find((x) => x.column === 'jobId')!.update = true;
    expect(() => assertR5AsyncItemAcl(rows)).toThrow();
    const broad = acl();
    broad[0].tableDelete = true;
    expect(() => assertR5AsyncItemAcl(broad)).toThrow();
  });
  it('binds supplemental table metadata to exactly the same old function and namespace version', () => {
    expect(() => assertR5AsyncCatalogPair(catalog(), catalog())).not.toThrow();
  });
  it.each(['functions', 'namespace', 'databaseOid', 'tables'] as const)(
    'rejects mismatched supplemental %s',
    (field) => {
      const x: Record<string, unknown> = catalog();
      x[field] = field === 'databaseOid' ? 1971161 : [];
      expect(() => assertR5AsyncCatalogPair(catalog(), x)).toThrow();
    },
  );
  it('requires the 15-second real COMMIT observation separately from metadata', () => {
    expect(() => assertR5AsyncSingleCommit([attempt()])).not.toThrow();
  });
  it('requires callback, transaction Promise, engine COMMIT and independent server terminal evidence', () => {
    expect(() => assertR5AsyncNativeReceipt(nativeReceipt())).not.toThrow();
  });
  it('rejects a real COMMIT that exceeded 15 seconds rather than subtracting instrumentation', () => {
    const r = nativeReceipt();
    r.transactions[0].transactionSettledMs = 15001;
    expect(() => assertR5AsyncNativeReceipt(r)).toThrow('15-second');
  });
  it('rejects engine rollback, wrong caller and callback rejection despite a server committed label', () => {
    const r = nativeReceipt();
    r.engine.phases[1].phase = 'rollback';
    expect(() => assertR5AsyncNativeReceipt(r)).toThrow();
    const wrong = nativeReceipt();
    wrong.transactions[0].identity.role = 'postgres';
    expect(() => assertR5AsyncNativeReceipt(wrong)).toThrow();
    const callback = nativeReceipt();
    callback.transactions[0].callback = 'REJECTED';
    expect(() => assertR5AsyncNativeReceipt(callback)).toThrow();
  });
  it.each(['UNKNOWN', 'ROLLED_BACK', 'NO_TRANSACTION'] as const)(
    'does not convert %s into COMMIT',
    (databaseOutcome) => {
      expect(() => assertR5AsyncSingleCommit([{ ...attempt(), databaseOutcome }])).toThrow();
    },
  );
  it('rejects incomplete observation, rejected Promise, relaxed native budget and multiple native attempts', () => {
    expect(() =>
      assertR5AsyncSingleCommit([{ ...attempt(), observationComplete: false }]),
    ).toThrow();
    expect(() =>
      assertR5AsyncSingleCommit([{ ...attempt(), configuredTimeoutMs: 60000 }]),
    ).toThrow();
    expect(() =>
      assertR5AsyncSingleCommit([
        { ...attempt(), client: { status: 'rejected', reason: new Error('P2028') } },
      ]),
    ).toThrow();
    expect(() => assertR5AsyncSingleCommit([attempt(), attempt()])).toThrow();
  });
  it.each([10 * 1024 ** 3, 9 * 1024 ** 3, NaN])(
    'retains original disk gate for %d bytes',
    (diskAvailableBytes) => {
      expect(() =>
        assertR5AsyncResources({
          cpuMax: '400000 100000',
          memoryMaxBytes: '17179869184',
          diskAvailableBytes,
        }),
      ).toThrow();
    },
  );
});

describe('fresh full-root delta1000 entry admission (no database)', () => {
  const capacityManifest = (): R5AsyncManifest => {
    const m = manifest();
    m.schema = R5_ASYNC_CAPACITY1000_SCOPE.schema;
    m.approval.scope = R5_ASYNC_CAPACITY1000_SCOPE.approvalScope;
    m.capacity = R5_ASYNC_CAPACITY1000_UNITS;
    return m;
  };
  it('requires exactly N10000/Delta1000/2000 identities and the full 8000-row oracle', () => {
    expect(() =>
      assertR5AsyncManifest(capacityManifest(), start + 1, R5_ASYNC_CAPACITY1000_SCOPE),
    ).not.toThrow();
    expect(R5_ASYNC_CAPACITY1000_SCOPE.nativeMs).toBe(15000);
    expect(R5_ASYNC_CAPACITY1000_SCOPE.oracleEvaluations).toBe(8000);
  });
  it.each([
    { sourceCount: 1000 },
    { delta: 10000 },
    { identities: 1000 },
    { bindingCount: 1000 },
    { sliceCount: 5000 },
    { oracleEvaluations: 4 },
    { preparedApplicationId: 'cmvuydsic07v0mkqq7k2rl3ho' },
  ])('rejects changed or appended capacity units %j', (change) => {
    const m = capacityManifest();
    m.capacity = { ...m.capacity, ...change } as typeof R5_ASYNC_CAPACITY1000_UNITS;
    expect(() => assertR5AsyncManifest(m, start + 1, R5_ASYNC_CAPACITY1000_SCOPE)).toThrow();
  });
  it('keeps the one-person entry and capacity approval scopes separate', () => {
    expect(() => assertR5AsyncManifest(capacityManifest(), start + 1)).toThrow();
    expect(() =>
      assertR5AsyncManifest(manifest(), start + 1, R5_ASYNC_CAPACITY1000_SCOPE),
    ).toThrow();
  });
  it('the actual capacity entry refuses unapproved work before source reads or clients', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'r5-capacity-entry-'));
    const m = capacityManifest();
    m.approval.approved = false;
    const path = join(dir, 'manifest.json');
    writeFileSync(path, JSON.stringify(m));
    try {
      await expect(runR5HumanCorrectionAsyncCapacity1000(path, 'a'.repeat(64))).rejects.toThrow(
        'not approved',
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
  it('the actual capacity entry refuses a self-signed inventory before opening it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'r5-capacity-source-'));
    const path = join(dir, 'manifest.json');
    writeFileSync(path, JSON.stringify(capacityManifest()));
    const now = jest.spyOn(Date, 'now').mockReturnValue(start + 1);
    try {
      await expect(runR5HumanCorrectionAsyncCapacity1000(path, '9'.repeat(64))).rejects.toThrow(
        'independently frozen',
      );
    } finally {
      now.mockRestore();
      rmSync(dir, { recursive: true });
    }
  });
  it('a positive committed case cannot claim rollback, differential or full-stage completion', () => {
    expect(R5_ASYNC_CAPACITY1000_EVIDENCE_BOUNDARY.completeThousandStage).toBe(false);
    expect(R5_ASYNC_CAPACITY1000_EVIDENCE_BOUNDARY.rollback).toBe(
      'NOT_EXERCISED_BY_POSITIVE_COMMIT',
    );
    expect(R5_ASYNC_CAPACITY1000_EVIDENCE_BOUNDARY.referenceDifferential).toBe(
      'NOT_EXERCISED_BY_POSITIVE_COMMIT',
    );
  });
});

describe('integrated real-identity async admission (pure, no PG authentication proof)', () => {
  const runtime = () => ({
    installationReceiptSha256: R5_ASYNC_INSTALLED_IDENTITIES.sha256,
    installationState: 'INSTALLED_INACTIVE' as const,
    runtimeRequirement: 'FRESH_STAGE_LOGIN_AND_LIVE_QUALIFICATION' as const,
    installedConnectionPath: '/tmp/synthetic-installed.json',
    installedConnectionSha256: '1'.repeat(64),
    credentialsFd: 3 as const,
  });
  const url = (kind: 'P' | 'U') =>
    `postgresql://${R5_ASYNC_INSTALLED_IDENTITIES[kind].name}:synthetic-only@localhost/${R5_ASYNC_SCOPE.database}`;
  it('preserves the successful sealed installation without claiming current LOGIN or a captured historical birth', () => {
    expect(R5_ASYNC_INSTALLED_IDENTITIES.stateAtCloseout).toBe('NOLOGIN_PASSWORD_NULL');
    expect(R5_ASYNC_INSTALLED_IDENTITIES.historicalBackendStart).toBeNull();
    expect(() => assertR5AsyncRuntimeManifest({ ...manifest(), runtime: runtime() })).not.toThrow();
    expect(() => assertR5AsyncRuntimeManifest(manifest())).toThrow('absent');
  });
  it.each([
    { credentialsFd: 0 },
    { installationState: 'ACTIVE' },
    { runtimeRequirement: 'TRUST_OLD_AUTH' },
    { installationReceiptSha256: '0'.repeat(64) },
    { installedConnectionSha256: '' },
  ])('rejects wrong runtime prerequisites %#', (change) => {
    expect(() =>
      assertR5AsyncRuntimeManifest({
        ...manifest(),
        runtime: { ...runtime(), ...change } as ReturnType<typeof runtime>,
      }),
    ).toThrow();
  });
  it('accepts only phase-bound memory frames and exact P/U principals, retaining startup C on every connection', () => {
    const r = parseR5AsyncMemoryCredentials(
      Buffer.from(
        JSON.stringify({
          schema: 'srvf-r5-async-memory-credentials/v1',
          phaseId: 'new-phase',
          pUrl: url('P'),
          uUrl: url('U'),
        }),
      ),
      'new-phase',
    );
    expect(new URL(r.pUrl).username).toBe(R5_ASYNC_INSTALLED_IDENTITIES.P.name);
    expect(new URL(r.uUrl).username).toBe(R5_ASYNC_INSTALLED_IDENTITIES.U.name);
    expect(new URL(r.pUrl).searchParams.get('options')).toBe('-c role=' + R5_ASYNC_SCOPE.caller);
  });
  it.each(['postgres', 'r5_boundary_caller_h7c6'])(
    'never turns %s plus SET ROLE into a trusted or untrusted login',
    (name) => {
      expect(() =>
        r5AsyncPrincipalUrl(url('P').replace(R5_ASYNC_INSTALLED_IDENTITIES.P.name, name), 'P'),
      ).toThrow();
    },
  );
  it('rejects another phase and any extra runtime input before client construction', () => {
    const frame = {
      schema: 'srvf-r5-async-memory-credentials/v1',
      phaseId: 'old-phase',
      pUrl: url('P'),
      uUrl: url('U'),
    };
    expect(() =>
      parseR5AsyncMemoryCredentials(Buffer.from(JSON.stringify(frame)), 'new-phase'),
    ).toThrow('different stage');
    expect(() =>
      parseR5AsyncMemoryCredentials(
        Buffer.from(JSON.stringify({ ...frame, qualifyInTx: 'bypass' })),
        'old-phase',
      ),
    ).toThrow();
  });
  it('requires the independently authenticated P session in native receipts, even when current C and COMMIT match', () => {
    const r = nativeReceipt();
    r.transactions[0].identity.sessionUser = 'postgres';
    expect(() => assertR5AsyncNativeReceipt(r)).toThrow();
  });
  function birth(change: Record<string, unknown> = {}) {
    const row = {
      session: R5_ASYNC_INSTALLED_IDENTITIES.P.name,
      current: R5_ASYNC_INSTALLED_IDENTITIES.P.name,
      sessionOid: String(R5_ASYNC_INSTALLED_IDENTITIES.P.oid),
      databaseOid: 1998913,
      pid: 123,
      backendStart: 'synthetic-birth',
      backendType: 'client backend',
      login: true,
      ...change,
    };
    const persist = jest.fn();
    const execute = jest.fn(() => Promise.resolve(0)),
      query = jest.fn(() => Promise.resolve([row]));
    const tx = { $executeRaw: execute, $queryRaw: query } as unknown as Prisma.TransactionClient;
    const transaction = jest.fn((body: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      body(tx),
    );
    return {
      row,
      persist,
      execute,
      query,
      transaction,
      client: { $transaction: transaction } as unknown as PrismaClient,
    };
  }
  it('captures actual birth under P in a read-only bounded tx without changing native15', async () => {
    const f = birth();
    await expect(captureR5AsyncSessionBirth(f.client, 'P', f.persist)).resolves.toEqual({
      pid: 123,
      databaseOid: 1998913,
      backendStart: 'synthetic-birth',
    });
    expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 7000,
      maxWait: 2000,
    });
    expect(f.persist).toHaveBeenCalledWith(expect.objectContaining({ rows: [f.row] }) as unknown);
  });
  it.each([
    { backendStart: null },
    { login: false },
    { sessionOid: '2035123' },
    { current: 'postgres' },
    { session: 'postgres' },
  ])('persists then refuses incomplete/wrong runtime identity %#', async (change) => {
    const f = birth(change);
    await expect(captureR5AsyncSessionBirth(f.client, 'P', f.persist)).rejects.toThrow();
    expect(f.persist).toHaveBeenCalledWith(expect.objectContaining({ rows: [f.row] }) as unknown);
  });
  it.each(['different-cluster', 'missing-session', 'valid'] as const)(
    'independently correlates U with target cluster: %s',
    async (kind) => {
      const f = birth({
        session: R5_ASYNC_INSTALLED_IDENTITIES.U.name,
        current: R5_ASYNC_INSTALLED_IDENTITIES.U.name,
        sessionOid: String(R5_ASYNC_INSTALLED_IDENTITIES.U.oid),
      });
      const q = jest.fn(() =>
        Promise.resolve(
          kind === 'missing-session'
            ? []
            : [
                {
                  cluster:
                    kind === 'different-cluster' ? '999' : R5_ASYNC_INSTALLED_IDENTITIES.cluster,
                  databaseOid: '1998913',
                  pid: 123,
                  backendStart: 'synthetic-birth',
                  session: R5_ASYNC_INSTALLED_IDENTITIES.U.name,
                },
              ],
        ),
      );
      const promise = captureR5AsyncSessionBirth(f.client, 'U', f.persist, {
        $queryRaw: q,
      } as unknown as Pick<PrismaClient, '$queryRaw'>);
      if (kind === 'valid')
        await expect(promise).resolves.toMatchObject({ pid: 123, backendStart: 'synthetic-birth' });
      else await expect(promise).rejects.toThrow('target cluster');
      expect(q).toHaveBeenCalledTimes(1);
      expect(f.persist).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'ASYNC_U_LIVE_CLUSTER_CORRELATION' }) as unknown,
      );
    },
  );
  it('runtime connection cannot replace the independently frozen source expectations', () => {
    const base = { source: 'fixed-base' },
      extra = { source: 'fixed-supplement' };
    const r = {
      source: {
        baseCatalog: { source: 'actual-refilled' },
        supplementalCatalog: extra,
        expectedCatalogSha256: '0'.repeat(64),
      },
    };
    expect(() =>
      assertR5AsyncRuntimeSource(
        r as unknown as import('../../src/modules/activities/human-correction-trusted-connection').HumanCorrectionInstalledConnection,
        base,
        extra,
      ),
    ).toThrow('source-pinned base');
  });
});
