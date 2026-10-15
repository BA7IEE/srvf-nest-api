import { Test } from '@nestjs/testing';
import {
  Prisma,
  PrismaClient,
  type ActivityBatchJob,
  type LedgerPostingBatch,
} from '@prisma/client';

import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { ActivityContributionSettlementService } from './activity-contribution-settlement.service';
import {
  LEDGER_BASELINE_PAYLOAD_KEY,
  LEDGER_PREPARE_FINALIZE_TX_TIMEOUT_MS,
  LEDGER_PREPARE_ITEM_TX_TIMEOUT_MS,
  LedgerPreparationService,
  ledgerBaselineDigest,
} from './ledger-preparation.service';
import { ParticipationTimeLedgerService } from './participation-time-ledger.service';

describe('LedgerPreparationService finalize characterization', () => {
  // This client never connects: real delegate methods are spied on, so the
  // service still receives one typed transaction client for locks and guards.
  const tx = new PrismaClient();
  const baseline = { 'member-b|2026-10-01': '2:100', 'member-a|2026-10-01': '1:50' };
  const timeLedger = new ParticipationTimeLedgerService();
  const gate = { assertV11WriteAllowed: jest.fn() };
  const contributions = {
    assertNativeWriteAllowed: jest.fn(),
    assertVersionInTx: jest.fn(),
  };
  let service: LedgerPreparationService;
  let events: string[];
  let commitFailure: Error | undefined;
  let query: jest.SpiedFunction<typeof tx.$queryRaw>;
  let pendingCount: jest.SpiedFunction<typeof tx.activityBatchJobItem.count>;
  let jobUpdate: jest.SpiedFunction<typeof tx.activityBatchJob.update>;
  let batchUpdate: jest.SpiedFunction<typeof tx.ledgerPostingBatch.update>;
  let timeComplete: jest.SpiedFunction<typeof timeLedger.assertComplete>;
  let rethrowConstraint: jest.SpiedFunction<typeof timeLedger.rethrowConstraint>;
  const transaction = jest.fn(
    async (body: (client: Prisma.TransactionClient) => Promise<unknown>) => {
      events.push('transaction');
      const result = await body(tx);
      if (commitFailure) throw commitFailure;
      events.push('commit');
      return result;
    },
  );

  function job(): ActivityBatchJob {
    return {
      id: 'job-one',
      createdAt: new Date(0),
      updatedAt: new Date(0),
      jobTypeCode: 'settlement_prepare',
      activityId: 'activity-one',
      sessionId: null,
      settlementVersionId: 'version-one',
      postingBatchId: 'batch-one',
      statusCode: 'processing',
      operationKey: 'settlement_prepare:batch-one',
      requestHash: null,
      payloadVersion: 1,
      payload: { [LEDGER_BASELINE_PAYLOAD_KEY]: baseline },
      total: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
      leaseOwner: null,
      leaseGeneration: 0,
      leaseExpiresAt: null,
      attempts: 1,
      availableAt: new Date(0),
      createdByUserId: null,
      startedAt: null,
      completedAt: null,
      lastErrorCode: null,
    };
  }

  function batch(): LedgerPostingBatch & { activityId: string; contributionRegimeCode: string } {
    return {
      id: 'batch-one',
      createdAt: new Date(0),
      updatedAt: new Date(0),
      settlementRunId: 'run-one',
      settlementVersionId: 'version-one',
      batchRevision: 1,
      statusCode: 'preparing',
      requestKey: 'request-one',
      requestHash: null,
      baselineJsonHash: null,
      preparedCount: 500,
      totalCount: 500,
      failureCount: 0,
      preparedAt: null,
      committedAt: null,
      failedAt: null,
      voidedAt: null,
      preparedByUserId: null,
      committedByUserId: null,
      version: 1,
      activityId: 'activity-one',
      contributionRegimeCode: 'policy_v1',
    };
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      providers: [
        LedgerPreparationService,
        { provide: PrismaService, useValue: { $transaction: transaction } },
        { provide: ActivityWorkflowGate, useValue: gate },
        { provide: ParticipationTimeLedgerService, useValue: timeLedger },
        { provide: ActivityContributionSettlementService, useValue: contributions },
      ],
    }).compile();
    service = module.get(LedgerPreparationService);
  });

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.resetAllMocks();
    events = [];
    commitFailure = undefined;
    // resetAllMocks also resets this implementation, so restore the boundary.
    transaction.mockImplementation(async (body) => {
      events.push('transaction');
      const result = await body(tx);
      if (commitFailure) throw commitFailure;
      events.push('commit');
      return result;
    });
    gate.assertV11WriteAllowed.mockImplementation(() => {
      events.push('workflow-gate');
    });
    contributions.assertNativeWriteAllowed.mockImplementation(() => {
      events.push('native-gate');
    });
    contributions.assertVersionInTx.mockImplementation(() => {
      events.push('contribution-complete');
      return Promise.resolve();
    });
    query = jest
      .spyOn(tx, '$queryRaw')
      .mockResolvedValueOnce([job()])
      .mockResolvedValueOnce([batch()]);
    pendingCount = jest.spyOn(tx.activityBatchJobItem, 'count').mockResolvedValue(0);
    timeComplete = jest.spyOn(timeLedger, 'assertComplete').mockImplementation(() => {
      events.push('time-complete');
      return Promise.resolve(true);
    });
    rethrowConstraint = jest.spyOn(timeLedger, 'rethrowConstraint');
    jobUpdate = jest.spyOn(tx.activityBatchJob, 'update').mockResolvedValue(job());
    batchUpdate = jest
      .spyOn(tx.ledgerPostingBatch, 'update')
      .mockResolvedValue({ ...batch(), statusCode: 'ready' });
  });

  afterAll(() => tx.$disconnect());

  function lockedBatch(value: ReturnType<typeof batch>) {
    query.mockReset().mockResolvedValueOnce([job()]).mockResolvedValueOnce([value]);
  }

  function expectNoWritesOrChecks() {
    expect(jobUpdate).not.toHaveBeenCalled();
    expect(batchUpdate).not.toHaveBeenCalled();
    expect(timeComplete).not.toHaveBeenCalled();
    expect(contributions.assertVersionInTx).not.toHaveBeenCalled();
  }

  it('checks the workflow gate before opening a transaction', async () => {
    const error = new BizException(BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED);
    gate.assertV11WriteAllowed.mockImplementation(() => {
      throw error;
    });
    await expect(service.finalize('job-one')).rejects.toBe(error);
    expect(transaction).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('locks the job then its exact batch before counting pending items', async () => {
    await service.finalize('job-one');
    expect(query).toHaveBeenCalledTimes(2);
    const [jobParts, ...jobValues] = query.mock.calls[0];
    const [batchParts, ...batchValues] = query.mock.calls[1];
    expect(Array.isArray(jobParts) ? jobParts.join('?') : '').toContain('FROM "ActivityBatchJob"');
    expect(Array.isArray(jobParts) ? jobParts.join('?') : '').toContain('FOR UPDATE');
    expect(jobValues).toEqual(['job-one']);
    expect(Array.isArray(batchParts) ? batchParts.join('?') : '').toContain('FOR UPDATE OF b');
    expect(batchValues).toEqual(['batch-one']);
    expect(query.mock.invocationCallOrder[1]).toBeLessThan(
      pendingCount.mock.invocationCallOrder[0],
    );
    expect(pendingCount).toHaveBeenCalledWith({
      where: { jobId: 'job-one', statusCode: { not: 'succeeded' } },
    });
  });

  it('passes an explicit finalize-only 30s budget on the transaction that runs all guards', async () => {
    await service.finalize('job-one');
    expect(LEDGER_PREPARE_FINALIZE_TX_TIMEOUT_MS).toBe(30_000);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30_000 });
    expect(LEDGER_PREPARE_ITEM_TX_TIMEOUT_MS).toBe(60_000);
  });

  it('leaves ensurePrepareJob on its original implicit budget', async () => {
    query.mockReset().mockResolvedValueOnce([batch()]);
    jest.spyOn(timeLedger, 'assertManifestForReplay').mockResolvedValue(null);
    jest.spyOn(tx.activityBatchJob, 'findUnique').mockResolvedValue(job());
    await expect(service.ensurePrepareJob('batch-one')).resolves.toEqual({
      jobId: 'job-one',
      itemCount: 1,
    });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function));
  });

  it('replays an existing native job with contribution writes off using only immutable source checks', async () => {
    query.mockReset().mockResolvedValueOnce([batch()]);
    const find = jest.spyOn(tx.activityBatchJob, 'findUnique').mockResolvedValue(job());
    const replay = jest.spyOn(timeLedger, 'assertManifestForReplay').mockResolvedValue(null);
    const ensure = jest.spyOn(timeLedger, 'ensureManifest');
    const create = jest.spyOn(tx.activityBatchJob, 'create');
    const items = jest.spyOn(tx.activityBatchJobItem, 'createMany');
    contributions.assertNativeWriteAllowed.mockImplementation(() => {
      throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY);
    });
    await expect(service.ensurePrepareJob('batch-one')).resolves.toEqual({
      jobId: 'job-one',
      itemCount: 1,
    });
    expect(find).toHaveBeenCalledWith({
      where: { operationKey: 'settlement_prepare:batch-one' },
      select: { id: true, total: true },
    });
    expect(gate.assertV11WriteAllowed).toHaveBeenCalledTimes(1);
    expect(replay).toHaveBeenCalledWith(tx, batch());
    expect(query.mock.invocationCallOrder[0]).toBeLessThan(find.mock.invocationCallOrder[0]);
    expect(gate.assertV11WriteAllowed.mock.invocationCallOrder[0]).toBeLessThan(
      replay.mock.invocationCallOrder[0],
    );
    expect(contributions.assertNativeWriteAllowed).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(items).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledWith(expect.any(Function));
  });

  it.each([
    BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED,
    BizCode.ACTIVITY_WORKFLOW_READONLY_MAINTENANCE,
  ])('keeps the independent workflow gate on native job replay (%s)', async (biz) => {
    query.mockReset().mockResolvedValueOnce([batch()]);
    jest.spyOn(tx.activityBatchJob, 'findUnique').mockResolvedValue(job());
    const replay = jest.spyOn(timeLedger, 'assertManifestForReplay');
    const failure = new BizException(biz);
    gate.assertV11WriteAllowed.mockImplementation(() => {
      throw failure;
    });
    await expect(service.ensurePrepareJob('batch-one')).rejects.toBe(failure);
    expect(replay).not.toHaveBeenCalled();
    expect(contributions.assertNativeWriteAllowed).not.toHaveBeenCalled();
  });

  it('refuses a new native job with writes off before creating any manifest or item', async () => {
    query.mockReset().mockResolvedValueOnce([batch()]);
    jest.spyOn(tx.activityBatchJob, 'findUnique').mockResolvedValue(null);
    const ensure = jest.spyOn(timeLedger, 'ensureManifest');
    const create = jest.spyOn(tx.activityBatchJob, 'create');
    const items = jest.spyOn(tx.activityBatchJobItem, 'createMany');
    const failure = new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY);
    contributions.assertNativeWriteAllowed.mockImplementation(() => {
      throw failure;
    });
    await expect(service.ensurePrepareJob('batch-one')).rejects.toBe(failure);
    expect(ensure).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(items).not.toHaveBeenCalled();
  });

  it('preserves source-validation errors during an existing job replay without repairing it', async () => {
    query.mockReset().mockResolvedValueOnce([batch()]);
    jest.spyOn(tx.activityBatchJob, 'findUnique').mockResolvedValue(job());
    const failure = new BizException(BizCode.ACTIVITY_TIME_LEDGER_NOT_READY);
    jest.spyOn(timeLedger, 'assertManifestForReplay').mockRejectedValue(failure);
    const ensure = jest.spyOn(timeLedger, 'ensureManifest');
    await expect(service.ensurePrepareJob('batch-one')).rejects.toBe(failure);
    expect(ensure).not.toHaveBeenCalled();
  });

  it('leaves prepareChunk on its original explicit 60s budget', async () => {
    query
      .mockReset()
      .mockResolvedValueOnce([job()])
      .mockResolvedValueOnce([
        {
          id: 'item-one',
          jobId: 'job-one',
          itemKey: 'chunk:0',
          statusCode: 'succeeded',
        },
      ]);
    await expect(service.prepareChunk('job-one', 'item-one')).resolves.toMatchObject({
      skipped: true,
    });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 60_000 });
  });

  it('returns unchanged preparing state when an item is pending, even with a count mismatch', async () => {
    lockedBatch({ ...batch(), preparedCount: 499 });
    pendingCount.mockResolvedValue(1);
    await expect(service.finalize('job-one')).resolves.toEqual({
      jobId: 'job-one',
      postingBatchId: 'batch-one',
      batchStatus: 'preparing',
      preparedCount: 499,
      totalCount: 500,
      baselineJsonHash: null,
    });
    expect(contributions.assertNativeWriteAllowed).not.toHaveBeenCalled();
    expectNoWritesOrChecks();
  });

  it.each(['ready', 'committed', 'failed', 'voided'])(
    'replays a %s batch without rerunning validations or changing facts',
    async (statusCode) => {
      const hash = 'a'.repeat(64);
      lockedBatch({ ...batch(), statusCode, baselineJsonHash: hash });
      await expect(service.finalize('job-one')).resolves.toEqual({
        jobId: 'job-one',
        postingBatchId: 'batch-one',
        batchStatus: statusCode,
        preparedCount: 500,
        totalCount: 500,
        baselineJsonHash: hash,
      });
      expect(contributions.assertNativeWriteAllowed).not.toHaveBeenCalled();
      expectNoWritesOrChecks();
    },
  );

  it('atomically fails both records on a population mismatch before integrity checks', async () => {
    lockedBatch({ ...batch(), preparedCount: 499 });
    batchUpdate.mockResolvedValue({
      ...batch(),
      statusCode: 'failed',
      preparedCount: 499,
    });
    await expect(service.finalize('job-one')).resolves.toEqual({
      jobId: 'job-one',
      postingBatchId: 'batch-one',
      batchStatus: 'failed',
      preparedCount: 499,
      totalCount: 500,
      baselineJsonHash: null,
    });
    const completedAt = jobUpdate.mock.calls[0][0].data.completedAt;
    const failedAt = batchUpdate.mock.calls[0][0].data.failedAt;
    expect(completedAt).toBeInstanceOf(Date);
    expect(failedAt).toBeInstanceOf(Date);
    expect(jobUpdate).toHaveBeenCalledWith({
      where: { id: 'job-one' },
      data: {
        statusCode: 'failed',
        completedAt,
        lastErrorCode: 'LEDGER_PREPARE_COUNT_MISMATCH',
      },
    });
    expect(batchUpdate).toHaveBeenCalledWith({
      where: { id: 'batch-one' },
      data: {
        statusCode: 'failed',
        failedAt,
        failureCount: { increment: 1 },
        version: { increment: 1 },
      },
      select: { statusCode: true, preparedCount: true, totalCount: true },
    });
    expect(timeComplete).not.toHaveBeenCalled();
    expect(contributions.assertVersionInTx).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it.each(['policy_v1', 'legacy'])(
    'keeps %s validation order and both updates in the caller transaction',
    async (regime) => {
      lockedBatch({ ...batch(), contributionRegimeCode: regime });
      const hash = ledgerBaselineDigest(baseline);
      await expect(service.finalize('job-one')).resolves.toEqual({
        jobId: 'job-one',
        postingBatchId: 'batch-one',
        batchStatus: 'ready',
        preparedCount: 500,
        totalCount: 500,
        baselineJsonHash: hash,
      });
      expect(events).toEqual([
        'workflow-gate',
        'transaction',
        ...(regime === 'policy_v1' ? ['native-gate'] : []),
        'time-complete',
        ...(regime === 'policy_v1' ? ['contribution-complete'] : []),
        'commit',
      ]);
      expect(timeComplete).toHaveBeenCalledWith(tx, expect.objectContaining({ id: 'batch-one' }));
      if (regime === 'policy_v1') {
        expect(contributions.assertVersionInTx).toHaveBeenCalledWith(
          tx,
          'version-one',
          'batch-one',
        );
      } else {
        expect(contributions.assertNativeWriteAllowed).not.toHaveBeenCalled();
        expect(contributions.assertVersionInTx).not.toHaveBeenCalled();
      }
      const completedAt = jobUpdate.mock.calls[0][0].data.completedAt;
      expect(completedAt).toBeInstanceOf(Date);
      expect(pendingCount.mock.invocationCallOrder[0]).toBeLessThan(
        timeComplete.mock.invocationCallOrder[0],
      );
      expect(timeComplete.mock.invocationCallOrder[0]).toBeLessThan(
        jobUpdate.mock.invocationCallOrder[0],
      );
      if (regime === 'policy_v1')
        expect(contributions.assertVersionInTx.mock.invocationCallOrder[0]).toBeLessThan(
          jobUpdate.mock.invocationCallOrder[0],
        );
      expect(jobUpdate.mock.invocationCallOrder[0]).toBeLessThan(
        batchUpdate.mock.invocationCallOrder[0],
      );
      expect(jobUpdate).toHaveBeenCalledWith({
        where: { id: 'job-one' },
        data: { statusCode: 'succeeded', completedAt, lastErrorCode: null },
      });
      expect(batchUpdate).toHaveBeenCalledWith({
        where: { id: 'batch-one' },
        data: {
          statusCode: 'ready',
          preparedAt: completedAt,
          baselineJsonHash: hash,
          version: { increment: 1 },
        },
        select: { statusCode: true, preparedCount: true, totalCount: true },
      });
      const jobData = jobUpdate.mock.calls[0][0].data;
      const batchData = batchUpdate.mock.calls[0][0].data;
      expect(jobData.completedAt).toBe(batchData.preparedAt);
      expect(transaction).toHaveBeenCalledTimes(1);
    },
  );

  it('propagates native gate rejection before even marking a mismatched batch failed', async () => {
    lockedBatch({ ...batch(), preparedCount: 499 });
    const error = new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY);
    contributions.assertNativeWriteAllowed.mockImplementation(() => {
      throw error;
    });
    await expect(service.finalize('job-one')).rejects.toBe(error);
    expectNoWritesOrChecks();
  });

  it.each(['time', 'contribution'])(
    'propagates %s integrity failure without either state update',
    async (stage) => {
      const error = new Error('synthetic integrity failure');
      if (stage === 'time') timeComplete.mockRejectedValue(error);
      else contributions.assertVersionInTx.mockRejectedValue(error);
      await expect(service.finalize('job-one')).rejects.toBe(error);
      expect(jobUpdate).not.toHaveBeenCalled();
      expect(batchUpdate).not.toHaveBeenCalled();
      if (stage === 'time') expect(contributions.assertVersionInTx).not.toHaveBeenCalled();
    },
  );

  it.each(['job', 'batch'])(
    'propagates %s update failure from the same transaction',
    async (stage) => {
      const error = new Error('synthetic update failure');
      if (stage === 'job') jobUpdate.mockRejectedValue(error);
      else batchUpdate.mockRejectedValue(error);
      await expect(service.finalize('job-one')).rejects.toBe(error);
      if (stage === 'job') expect(batchUpdate).not.toHaveBeenCalled();
      else expect(rethrowConstraint).toHaveBeenCalledWith(error);
      expect(events).not.toContain('commit');
    },
  );

  it('preserves the named ledger visibility constraint rejection', async () => {
    const error = new Prisma.PrismaClientKnownRequestError('ptl_visibility_guard', {
      code: 'P2004',
      clientVersion: '6.19.3',
    });
    batchUpdate.mockRejectedValue(error);
    await expect(service.finalize('job-one')).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_TIME_LEDGER_NOT_READY,
    });
    expect(rethrowConstraint).toHaveBeenCalledWith(error);
    expect(events).not.toContain('commit');
  });

  it('propagates a COMMIT failure after the callback instead of reporting ready', async () => {
    commitFailure = new Error('synthetic deferred commit failure');
    await expect(service.finalize('job-one')).rejects.toBe(commitFailure);
    expect(jobUpdate).toHaveBeenCalledTimes(1);
    expect(batchUpdate).toHaveBeenCalledTimes(1);
    expect(rethrowConstraint).not.toHaveBeenCalled();
    expect(events).not.toContain('commit');
  });

  it.each(['missing-job', 'missing-pointer', 'missing-batch'])(
    'rejects %s without checks or writes',
    async (missing) => {
      query.mockReset();
      query.mockResolvedValueOnce(
        missing === 'missing-job'
          ? []
          : [{ ...job(), postingBatchId: missing === 'missing-pointer' ? null : 'batch-one' }],
      );
      query.mockResolvedValueOnce([]);
      await expect(service.finalize('job-one')).rejects.toMatchObject({
        biz: BizCode.LEDGER_PREPARE_BATCH_STATUS_INVALID,
      });
      expect(pendingCount).not.toHaveBeenCalled();
      expectNoWritesOrChecks();
    },
  );

  it('propagates pending-count failure rather than treating it as zero', async () => {
    const error = new Error('synthetic pending query failure');
    pendingCount.mockRejectedValue(error);
    await expect(service.finalize('job-one')).rejects.toBe(error);
    expectNoWritesOrChecks();
  });
});
