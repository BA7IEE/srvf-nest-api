import * as native from './r5-setmat-native-only';
import {
  R5_COMPONENT_ORIGIN as origin,
  r5ContinuationClaimPath,
} from './r5-setmat-component-continuation';
import { r5SeparatedClaimPath } from './r5-setmat-separated-policy';
import { capacityClock, type CapacityConfig } from './r5-setmat-capacity.protocol';
import { measureR5NativeOnly } from './r5-setmat-separated-component';
import type { R5CapacityFixture } from './r5-setmat-capacity.fixture';
import * as durable from './r5-setmat-durable-receipt';
import * as projection from './r5-setmat-capacity-projection';
const request = (): native.R5NativeOnly => ({
  schema: 'srvf-r5-native-only-dispatch/v1',
  scope: native.R5_NATIVE_ONLY_SCOPE,
  authorization: { approved: true, reference: 'PURE_TEST_ONLY_NOT_APPROVAL' },
  evidenceDirectory: '/pure-evidence',
  originalEvidenceDirectory: '/pure-origin',
});
const now = Date.parse('2026-10-30T17:00:00Z');
const config = () =>
  ({
    mode: 'component1000',
    nativeOnly: request(),
    outputDirectory: '/pure-no-write',
    window: {
      id: 'pure',
      dispatchReference: 'pure',
      previousWindow: 'DIAGNOSTIC_FACTS_COMPLETE_PHASE_FAIL_NATIVE_NOT_RUN',
      startedAt: new Date(now).toISOString(),
      deadline: new Date(now + 1800000).toISOString(),
    },
  }) as CapacityConfig;
describe('native-only exact unstarted phase (PURE, no DB)', () => {
  afterEach(() => jest.restoreAllMocks());
  it('requires exact new approval and preserves both consumed prior claims', () => {
    expect(() => native.assertR5NativeOnly(request())).not.toThrow();
    const paths = [
      r5ContinuationClaimPath(),
      r5SeparatedClaimPath(),
      native.r5NativeOnlyClaimPath(),
    ];
    expect(new Set(paths).size).toBe(3);
    const r = request();
    Reflect.set(r.authorization, 'approved', false);
    expect(() => native.assertR5NativeOnly(r)).toThrow();
  });
  it.each([
    'nativeTransactionMs',
    'candidateControlMs',
    'newDiagnosticTransactions',
    'guardPolicy',
    'historicalDiagnosticXid',
    'evidenceZipSha256',
    'normalRealLoginSetup',
    'full10000Admission',
  ])('refuses altered scope %s', (key) => {
    const r = structuredClone(request());
    Reflect.set(r.scope, key, 'altered');
    expect(() => native.assertR5NativeOnly(r)).toThrow();
  });
  it('retains closed deadlines,600phase/1800campaign and no full10000 admission', () => {
    const c = config();
    expect(() => capacityClock(c, now, 125000)).not.toThrow();
    expect(() => capacityClock(c, now + 600000)).toThrow();
    expect(() => capacityClock({ ...c, mode: 'full10000' }, now)).toThrow();
    expect(() =>
      capacityClock(
        {
          ...c,
          window: { ...c.window, previousWindow: 'COMPONENT_COMPARISON_FAIL_ROLLBACK_PROVED' },
        },
        now,
      ),
    ).toThrow();
    expect(() =>
      capacityClock({ ...c, window: { ...c.window, startedAt: '2026-10-30T15:00:00Z' } }, now),
    ).toThrow();
  });
  function fixture(
    change: {
      xid?: string;
      outcome?: string;
      fail?: Error;
      overTime?: boolean;
      drift?: boolean;
    } = {},
  ) {
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const journals: unknown[] = [];
    jest.spyOn(durable, 'writeR5AtomicControlReceipt').mockImplementation((file, value) => {
      journals.push({ file, value });
      return file;
    });
    jest.spyOn(native, 'verifyR5NativeOnlyEvidence').mockReturnValue({
      diagnosticXid: '158936',
      historicalPhase: 'FAIL_PRESERVED',
      sourceLibraryId: 'libfile_f9e8fc88a57481918db9e1201c8f7dca',
      completedParityFactsReused: true,
      performanceEvidenceReused: false,
      priorNativeTransactions: 0,
    });
    jest.spyOn(projection, 'capacityProjection').mockImplementation(() => {
      throw new Error('diagnostic comparison forbidden');
    });
    jest.spyOn(projection, 'capacityCensus').mockImplementation(() => {
      throw new Error('diagnostic census forbidden');
    });
    const tx = {
      $queryRaw: jest.fn(async (...args: unknown[]) => {
        void args;
        return [];
      }),
      ledgerPostingBatch: {
        update: jest.fn(async (...args: unknown[]) => {
          void args;
          return {};
        }),
      },
    };
    const timeCorrection = {
      createCommitReceipt: jest.fn(async () => {}),
      hasReadyV3CommitReceiptAnchor: jest.fn(async () => true),
      assertComplete: jest.fn(async () => {}),
    };
    const contributions = {
      readNativePostingBoundaryCandidateInTx: jest.fn(async () => ({})),
      assertVersionInTx: jest.fn(async () => {}),
      assertNativePostingBoundaryInTx: jest.fn(async () => {}),
    };
    const c = {
      timeCorrection,
      ledgerPosting: {
        timeCorrection,
        contributions,
        commitBatchWithin: jest.fn(async () => {
          await timeCorrection.hasReadyV3CommitReceiptAnchor();
          await contributions.readNativePostingBoundaryCandidateInTx();
          await tx.ledgerPostingBatch.update({
            where: { id: origin.postingBatchId },
            data: { statusCode: 'committed' },
          });
          await contributions.assertNativePostingBoundaryInTx();
        }),
      },
      humanAccess: { authorizeCommit: jest.fn(async () => {}) },
      audit: {
        logCommit: jest.fn(async (...args: unknown[]) => {
          void args;
        }),
      },
      materializeV3PendingSegments: jest.fn(async () => {
        throw new Error('diagnostic reference forbidden');
      }),
      materializePendingSegments: jest.fn(async (...args: unknown[]) => {
        void args;
        if (change.fail) throw change.fail;
        return 1000;
      }),
    };
    const commit = jest.fn(async () => {
      await c.humanAccess.authorizeCommit();
      await c.materializePendingSegments(
        tx,
        origin.applicationId,
        origin.activityId,
        origin.postingBatchId,
        {},
        'B',
      );
      await c.timeCorrection.createCommitReceipt();
      await c.ledgerPosting.commitBatchWithin();
      await c.humanAccess.authorizeCommit();
      await tx.$queryRaw`
    SELECT * FROM public.r5_correction_seal_phase(${origin.applicationId}::text, ${'commit'}::text)
  `;
      await c.audit.logCommit({ correctionApplicationId: origin.applicationId });
      throw new Error('missing forced rollback');
    });
    const receipt = {
      transactions: [
        {
          callback: 'REJECTED',
          transactionPromise: 'REJECTED',
          callbackStartedMs: 1,
          callbackEndedMs: 10,
          transactionStartedMs: 0,
          transactionSettledMs: change.overTime ? 15001 : 11,
        },
      ],
      entry: { elapsedMs: 12 },
      engine: {
        status: 'COMPLETE',
        pending: 0,
        phases: [
          { phase: 'start', outcome: 'ok', elapsedMs: 1 },
          { phase: 'rollback', outcome: 'ok', elapsedMs: 1 },
        ],
      },
      server: [{ status: 'aborted', identity: { xid: change.xid ?? '200001' } }],
    };
    let snapshots = 0;
    const f = {
      delta: 1000,
      applicationId: origin.applicationId,
      activityId: origin.activityId,
      postingBatchId: origin.postingBatchId,
      runId: 'pure',
      corrections: c,
      commit,
      persist: (v: unknown) => {
        journals.push(v);
        return 'memory';
      },
      checkpoint: () => {},
      verifyCatalog: jest.fn(async () => {}),
      assertRetainedState: jest.fn(async () => {}),
      assertExclusiveBoundary: jest.fn(async () => {}),
      snapshot: jest.fn(async () => ({
        schemaSha256: 'fake',
        tables: ['fake'],
        rows: [],
        hash: change.drift && ++snapshots === 3 ? 'drift' : 'same',
      })),
      getLastObservation: () => receipt,
      observe: jest.fn(
        async (_label: string, work: () => Promise<unknown>, policy: { kind: string }) => {
          expect(policy.kind).toBe('R5_SETMAT_CANDIDATE_15S');
          let reason: unknown;
          try {
            await work();
          } catch (e) {
            reason = e;
          }
          return {
            client: { status: 'rejected', reason },
            databaseOutcome: change.outcome ?? 'ROLLED_BACK',
            observationComplete: true,
            configuredTimeoutMs: 15000,
            configuredIsolationLevel: 'ReadCommitted',
          };
        },
      ),
    } as unknown as R5CapacityFixture;
    return { f, c, commit, journals };
  }
  it('executes one native path through original receipt/ledger/seal/audit, never diagnostic or prepare', async () => {
    const { f, c, commit, journals } = fixture();
    const result = await measureR5NativeOnly(f, config());
    expect(commit).toHaveBeenCalledTimes(1);
    expect(c.materializeV3PendingSegments).not.toHaveBeenCalled();
    expect(projection.capacityProjection).not.toHaveBeenCalled();
    expect(projection.capacityCensus).not.toHaveBeenCalled();
    expect(result.diagnosticTransactionsExecuted).toBe(0);
    expect(result.oldDiagnosticPhaseVerdict).toBe('FAIL_PRESERVED');
    expect(result.includedRealCommit).toBe(false);
    expect(result.full10000Admission).toBe(false);
    expect(result.candidate.tailProfile?.completedTail).toBe(true);
    expect(result.candidate.tailProfile?.pendingStageIds).toEqual([]);
    expect(result.candidate.observerOverheadSubtracted).toBe(false);
    expect(JSON.stringify(journals)).not.toContain('control-correctness');
    expect(JSON.stringify(journals)).toContain('control-candidate-start');
  });
  it.each([
    { xid: '158936' },
    { xid: '158897' },
    { outcome: 'UNKNOWN' },
    { overTime: true },
    { drift: true },
  ])('stops without retry on fresh-XID/outcome/budget/state failure %s', async (change) => {
    const f = fixture(change);
    await expect(measureR5NativeOnly(f.f, config())).rejects.toThrow();
    expect(f.commit).toHaveBeenCalledTimes(1);
  });
  it('preserves original P2028 object and partial stage evidence with no second attempt', async () => {
    const failure = new Error('P2028'),
      f = fixture({ fail: failure });
    await expect(measureR5NativeOnly(f.f, config())).rejects.toBe(failure);
    expect(f.commit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.journals)).toContain('NATIVE_ONLY_TAIL_PROFILE');
  });
});
