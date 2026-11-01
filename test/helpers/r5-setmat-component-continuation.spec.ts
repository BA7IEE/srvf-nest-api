import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import {
  assertR5ComponentContinuation,
  assertR5PreparedContinuationFacts,
  assertR5PreparedGeneration,
  R5_COMPONENT_ORIGIN as o,
  r5ContinuationClaimPath,
  type R5PreparedContinuationFacts,
  type R5ComponentContinuation,
} from './r5-setmat-component-continuation';
import { writeR5DurableReceipt } from './r5-setmat-durable-receipt';
import {
  installR5CallerTransactions,
  R5_SETMAT_CALLER,
  R5_SETMAT_DATABASE,
} from './r5-setmat-observation';
import { capacityClock, type CapacityConfig } from './r5-setmat-capacity.protocol';

const actors = { creatorUserId: 'creator', finalReviewerUserId: 'B' };
function facts(): R5PreparedContinuationFacts {
  const a = 'base',
    run = 'run',
    h = 'a'.repeat(64),
    s = 'b'.repeat(64);
  return {
    xmin: { application: o.xid, proof: o.xid, batch: o.xid, request: o.xid },
    xidStatus: 'committed',
    request: {
      id: o.requestId,
      activityId: o.activityId,
      statusCode: 'applying',
      requestHash: h,
      baseSettlementVersionId: a,
      settlementRunId: run,
      submittedByUserId: 'creator',
      reviewedByUserId: 'B',
      requestedChangeJson: {
        schemaVersion: 3,
        timeCorrection: { baseSettlementVersionId: a, baseTimeLedgerHash: s },
      },
    },
    application: {
      id: o.applicationId,
      correctionRequestId: o.requestId,
      newSettlementVersionId: o.settlementVersionId,
      newPostingBatchId: o.postingBatchId,
      statusCode: 'preparing',
      newResultRevisionIds: Array.from({ length: 2000 }, (_, i) => 'result' + i),
    },
    batch: {
      id: o.postingBatchId,
      settlementVersionId: o.settlementVersionId,
      settlementRunId: run,
      statusCode: 'ready',
      requestKey: `correction-apply:${o.requestId}:${o.operationKey}`,
      requestHash: h,
      preparedByUserId: 'B',
    },
    proof: {
      id: o.proofId,
      applicationId: o.applicationId,
      activityId: o.activityId,
      settlementRunId: run,
      settlementVersionId: o.settlementVersionId,
      baseSettlementVersionId: a,
      postingBatchId: o.postingBatchId,
      correctionManifestId: 'manifest',
      rootManifestId: 'root',
      sourceSetHash: h,
      calculationHash: s,
      expectedSegmentCount: 10000,
      expectedPendingCount: 1000,
      expectedSliceCount: 50000,
      expectedBindingCount: 10000,
    },
    counts: {
      pendingSegments: 1000,
      pendingAllocations: 1000,
      pendingEvidence: 1000,
      evaluations: 8000,
      bindings: 0,
      commitPhases: 0,
      cleanupReceipts: 0,
      preparationReceipts: 1,
      preparedSegments: 1000,
    },
    resultIds: Array.from({ length: 2000 }, (_, i) => 'result' + i),
    preparationPhase: [
      {
        state: 'SEALED',
        actorOid: '1789091',
        transactionId: o.xid,
        batchId: o.postingBatchId,
        requestId: o.requestId,
      },
    ],
    correctionManifest: {
      id: 'manifest',
      correctionRequestId: o.requestId,
      requestHash: h,
      activityId: o.activityId,
      settlementRunId: run,
      postingBatchId: o.postingBatchId,
      settlementVersionId: o.settlementVersionId,
      baseSettlementVersionId: a,
      rootManifestId: 'root',
      sourceProofId: o.proofId,
      sourceProofHash: h,
      baseContentHash: s,
    },
  };
}
describe('exact prepared continuation (pure; NO DATABASE)', () => {
  it('accepts the original committed transaction and all linked immutable inputs', () => {
    expect(() => assertR5PreparedContinuationFacts(facts(), actors)).not.toThrow();
  });
  const mutations: [string, (f: R5PreparedContinuationFacts) => void][] = [
    [
      'unknown XID',
      (f) => {
        f.xidStatus = null;
      },
    ],
    [
      'different XID',
      (f) => {
        f.xmin.application = '158898';
      },
    ],
    [
      'modified proof',
      (f) => {
        f.xmin.proof = '158898';
      },
    ],
    [
      'modified request',
      (f) => {
        f.xmin.request = '158898';
      },
    ],
    [
      'different request',
      (f) => {
        f.request.id = 'other';
      },
    ],
    [
      'different app',
      (f) => {
        f.application.id = 'other';
      },
    ],
    [
      'different batch',
      (f) => {
        f.batch.id = 'other';
      },
    ],
    [
      'different root',
      (f) => {
        f.proof.rootManifestId = 'other';
      },
    ],
    [
      'already committed',
      (f) => {
        f.application.statusCode = 'committed';
      },
    ],
    [
      'changed request status',
      (f) => {
        f.request.statusCode = 'approved';
      },
    ],
    [
      'failed batch',
      (f) => {
        f.batch.statusCode = 'failed';
      },
    ],
    [
      'new operation key',
      (f) => {
        f.batch.requestKey += 'retry';
      },
    ],
    [
      'actor substitution',
      (f) => {
        f.batch.preparedByUserId = 'A';
      },
    ],
    [
      'reviewer substitution',
      (f) => {
        f.request.reviewedByUserId = 'A';
      },
    ],
    [
      'partial pending',
      (f) => {
        f.counts.pendingSegments = 999;
      },
    ],
    [
      'changed allocation',
      (f) => {
        f.counts.pendingAllocations = 999;
      },
    ],
    [
      'missing evidence',
      (f) => {
        f.counts.pendingEvidence = 999;
      },
    ],
    [
      'partial evaluations',
      (f) => {
        f.counts.evaluations = 7999;
      },
    ],
    [
      'component already materialized',
      (f) => {
        f.counts.bindings = 1;
      },
    ],
    [
      'commit already opened',
      (f) => {
        f.counts.commitPhases = 1;
      },
    ],
    [
      'cleanup consumed',
      (f) => {
        f.counts.cleanupReceipts = 1;
      },
    ],
    [
      'result missing',
      (f) => {
        f.resultIds.pop();
      },
    ],
    [
      'result duplicate',
      (f) => {
        f.resultIds[0] = f.resultIds[1];
      },
    ],
    [
      'source hash mismatch',
      (f) => {
        f.correctionManifest.sourceProofHash = 'f'.repeat(64);
      },
    ],
    [
      'request hash mismatch',
      (f) => {
        f.batch.requestHash = 'f'.repeat(64);
      },
    ],
    [
      'base mismatch',
      (f) => {
        f.proof.baseSettlementVersionId = 'other';
      },
    ],
    [
      'prepare unsealed',
      (f) => {
        f.preparationPhase[0].state = 'OPEN';
      },
    ],
    [
      'prepare role changed',
      (f) => {
        f.preparationPhase[0].actorOid = '10';
      },
    ],
  ];
  it.each(mutations)('rejects %s without any prepare/replay fallback', (_label, change) => {
    const f = facts();
    change(f);
    expect(() => assertR5PreparedContinuationFacts(f, actors)).toThrow();
  });
  const continuation: R5ComponentContinuation = {
    schema: 'srvf-r5-exact-prepared-component-continuation/v1',
    purpose: 'ONE_UNSTARTED_COMPONENT1000_FORCED_ROLLBACK',
    origin: o,
    retainedEvidenceDirectory: '/retained',
    originalFailPreserved: true,
    prepareAndReplayForbidden: true,
    full10000Forbidden: true,
  };
  it('requires an explicit new continuation clock after the original failed campaign', () => {
    const start = Date.parse(o.originalCampaignDeadline) + 1000;
    const config = {
      mode: 'component1000',
      continuation,
      window: {
        id: 'new-explicit',
        dispatchReference: 'coordinator',
        previousWindow: 'COMPONENT_NOT_REACHED_FAIL_PREPARE_COMMITTED',
        startedAt: new Date(start).toISOString(),
        deadline: new Date(start + 600000).toISOString(),
      },
    } as CapacityConfig;
    expect(() => capacityClock(config, start, 125000)).not.toThrow();
    expect(() => capacityClock({ ...config, mode: 'full10000' }, start)).toThrow();
    expect(() =>
      capacityClock(
        { ...config, window: { ...config.window, startedAt: o.originalStageDeadline } },
        start,
      ),
    ).toThrow();
    expect(() => capacityClock(config, start + 600000)).toThrow();
    expect(() => capacityClock({ ...config, continuation: undefined }, start)).toThrow();
    expect(() =>
      capacityClock(
        {
          ...config,
          window: { ...config.window, deadline: new Date(start + 1800001).toISOString() },
        },
        start,
      ),
    ).toThrow();
  });
  it('does not allow target substitution or a changed original verdict', () => {
    expect(() => assertR5ComponentContinuation(continuation)).not.toThrow();
    expect(() =>
      assertR5ComponentContinuation({
        ...continuation,
        origin: { ...o, applicationId: 'new' },
      } as unknown as R5ComponentContinuation),
    ).toThrow();
    expect(() =>
      assertR5ComponentContinuation({
        ...continuation,
        originalFailPreserved: false,
      } as unknown as R5ComponentContinuation),
    ).toThrow();
    expect(r5ContinuationClaimPath()).toBe(
      join(
        o.originalRuntimeDirectory,
        o.applicationId + '.component1000-continuation.attempt.json',
      ),
    );
  });
  it('durably creates once and never overwrites previous evidence or claims', () => {
    const directory = mkdtempSync(join(tmpdir(), 'r5-durable-'));
    try {
      const file = join(directory, 'event.json');
      writeR5DurableReceipt(file, { event: 'START' });
      expect(() => writeR5DurableReceipt(file, { event: 'PASS' })).toThrow();
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ event: 'START' });
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
  const generation = () =>
    Object.entries({
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
      ledgerEntry: 4000,
    }).map(([kind, count]) => ({ kind, count, changed: 0 }));
  it('requires the whole prepared generation and refuses replacement/partial rows', () => {
    expect(() => assertR5PreparedGeneration(generation(), 16000)).not.toThrow();
    for (const original of generation()) {
      const rows = generation();
      rows.find((r) => r.kind === original.kind)!.changed = 1;
      expect(() => assertR5PreparedGeneration(rows, 16000)).toThrow();
      expect(() =>
        assertR5PreparedGeneration(
          generation().filter((r) => r.kind !== original.kind),
          16000,
        ),
      ).toThrow();
    }
    expect(() => assertR5PreparedGeneration([...generation(), generation()[0]], 16000)).toThrow();
    expect(() => assertR5PreparedGeneration(generation(), 15999)).toThrow();
  });
});

describe('durable callback and native engine events (fake engine only)', () => {
  function setup(progress: (event: Record<string, unknown>) => void, blockCommit = false) {
    let release!: () => void;
    const gate = blockCommit
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : Promise.resolve();
    const engine = {
      transaction: jest.fn((phase: string) => (phase === 'commit' ? gate : Promise.resolve())),
    };
    const identity = {
      database: R5_SETMAT_DATABASE,
      databaseOid: 1998913,
      role: R5_SETMAT_CALLER,
      pid: 11,
      xid: '900',
      sessionUser: 'original-login',
      roleOid: '1789091',
      isSuperuser: 'off',
    };
    const tx = { $executeRaw: jest.fn(async () => 0), $queryRaw: jest.fn(async () => [identity]) };
    const client = {
      _engine: engine,
      $transaction: async (body: (t: unknown) => Promise<unknown>, _options: unknown) => {
        expect(_options).toBeDefined();
        await engine.transaction('start');
        let result;
        try {
          result = await body(tx);
        } catch (error) {
          await engine.transaction('rollback');
          throw error;
        }
        await engine.transaction('commit');
        return result;
      },
    };
    const observer = {
      $queryRaw: jest.fn(async () => [
        {
          database: R5_SETMAT_DATABASE,
          databaseOid: 1998913,
          observerPid: 12,
          status: 'committed',
        },
      ]),
    };
    const route = installR5CallerTransactions(
      client as unknown as PrismaClient,
      1998913,
      undefined,
      progress,
    );
    return { client, observer, route, release };
  }
  it('persists callback completion and COMMIT start before a pending native COMMIT, without inventing its end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'r5-progress-'));
    let n = 0;
    let started!: () => void;
    const commitStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const f = setup((event) => {
      writeR5DurableReceipt(join(dir, `${++n}.json`), event);
      if (event.event === 'ENGINE_PHASE_STARTED' && event.phase === 'commit') started();
    }, true);
    const receipts: unknown[] = [];
    try {
      const attempt = f.route.observe(
        f.observer as unknown as PrismaClient,
        'PREPARE',
        () =>
          f.client.$transaction(async () => ({ secret: 'never-capture-result' }), {
            timeout: 120000,
          }),
        (r) => {
          receipts.push(r);
          return 'final';
        },
      );
      await commitStarted;
      const bytes = readdirSync(dir)
        .map((p) => readFileSync(join(dir, p), 'utf8'))
        .join('\n');
      expect(bytes).toContain('CALLBACK_SETTLED');
      expect(bytes).toContain('FULFILLED');
      const events = readdirSync(dir).map(
        (p) => JSON.parse(readFileSync(join(dir, p), 'utf8')) as Record<string, unknown>,
      );
      expect(events.some((e) => e.event === 'ENGINE_PHASE_SETTLED' && e.phase === 'commit')).toBe(
        false,
      );
      expect(
        events.every((e) => e.databaseOutcome === 'UNKNOWN_UNTIL_INDEPENDENT_SERVER_CHECK'),
      ).toBe(true);
      expect(bytes).not.toContain('never-capture-result');
      expect(receipts).toHaveLength(0);
      f.release();
      const result = await attempt;
      expect(result.databaseOutcome).toBe('COMMITTED');
      expect(result.observationComplete).toBe(true);
      expect(receipts).toHaveLength(1);
      f.route.restore();
    } finally {
      f.release();
      rmSync(dir, { recursive: true });
    }
  });
  it('refuses work when the initial journal is unavailable', async () => {
    const f = setup(() => {
      throw new Error('disk');
    });
    const body = jest.fn(async () => 1);
    await expect(
      f.route.observe(
        f.observer as unknown as PrismaClient,
        'START',
        () => f.client.$transaction(body, {}),
        () => 'final',
      ),
    ).rejects.toThrow('progress journal unavailable');
    expect(body).not.toHaveBeenCalled();
    expect(f.client._engine.transaction).not.toHaveBeenCalled();
    f.route.restore();
  });
  it('keeps the native rejection object and marks evidence UNKNOWN if later writes fail', async () => {
    const error = new Error('original');
    const f = setup((e) => {
      if (e.event === 'CALLBACK_SETTLED') throw new Error('disk');
    });
    f.observer.$queryRaw.mockResolvedValueOnce([
      { database: R5_SETMAT_DATABASE, databaseOid: 1998913, observerPid: 12, status: 'aborted' },
    ]);
    const result = await f.route.observe(
      f.observer as unknown as PrismaClient,
      'ERROR',
      () =>
        f.client.$transaction(async () => {
          throw error;
        }, {}),
      () => 'final',
    );
    expect(result.client).toEqual({ status: 'rejected', reason: error });
    expect(result.databaseOutcome).toBe('UNKNOWN');
    expect(result.observationComplete).toBe(false);
    f.route.restore();
  });
});
