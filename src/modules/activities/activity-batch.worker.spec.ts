import { Test } from '@nestjs/testing';
import { PrismaService } from '../../database/prisma.service';
import { ACTIVITY_BATCH_AUTO_COMMIT_ENABLED, ActivityBatchWorker } from './activity-batch.worker';
import { LedgerPreparationService } from './ledger-preparation.service';
import { LedgerReadyBatchCommitter } from './ledger-ready-batch-committer.service';
import {
  SettlementDraftBatchService,
  SettlementDraftLeaseLostError,
} from './settlement-draft-batch.service';

describe('ActivityBatchWorker draft dispatch', () => {
  async function fixture(handlerAvailable = true) {
    const process = jest.fn().mockResolvedValue({ succeeded: true });
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'draft-job' }]),
      activityBatchJob: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        update: jest.fn().mockResolvedValue({
          id: 'draft-job',
          activityId: 'activity',
          jobTypeCode: 'bulk_proxy',
          leaseGeneration: 3,
          payload: { action: 'settlement_draft_generate', executionMode: 'async' },
        }),
      },
    };
    const prisma = {
      activityBatchJob: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      activityBatchJobItem: { findMany: jest.fn() },
      ledgerPostingBatch: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(async (body: (client: typeof tx) => Promise<unknown>) => body(tx)),
    };
    const preparation = { finalize: jest.fn(), prepareChunk: jest.fn() };
    const committer = { commitReadyBatch: jest.fn() };
    const module = await Test.createTestingModule({
      providers: [
        ActivityBatchWorker,
        { provide: PrismaService, useValue: prisma },
        { provide: LedgerPreparationService, useValue: preparation },
        { provide: LedgerReadyBatchCommitter, useValue: committer },
        { provide: ACTIVITY_BATCH_AUTO_COMMIT_ENABLED, useValue: true },
        ...(handlerAvailable
          ? [{ provide: SettlementDraftBatchService, useValue: { process } }]
          : []),
      ],
    }).compile();
    return {
      module,
      worker: module.get(ActivityBatchWorker),
      process,
      prisma,
      preparation,
      committer,
    };
  }

  it.each([true, false])(
    'maps draft succeeded=%s without entering ledger finalization',
    async (succeeded) => {
      const f = await fixture();
      try {
        f.process.mockResolvedValueOnce({ succeeded });
        await expect(f.worker.drainOnce()).resolves.toEqual({
          jobsEnqueued: 0,
          jobClaimed: true,
          jobId: 'draft-job',
          itemsProcessed: succeeded ? 1 : 0,
          itemsFailed: succeeded ? 0 : 1,
          itemsSkipped: 0,
          batchStatus: null,
          commitAttempted: false,
          commitErrorCode: null,
        });
        expect(f.process).toHaveBeenCalledWith(
          expect.objectContaining({
            jobId: 'draft-job',
            activityId: 'activity',
            leaseGeneration: 3,
            maxAttempts: 5,
            retryBackoffMs: 30000,
          }),
        );
        expect(f.process).toHaveBeenCalledTimes(1);
        expect(f.prisma.activityBatchJobItem.findMany).not.toHaveBeenCalled();
        expect(f.preparation.finalize).not.toHaveBeenCalled();
        expect(f.committer.commitReadyBatch).not.toHaveBeenCalled();
      } finally {
        await f.module.close();
      }
    },
  );

  it('lease loss reports neither success nor failure and never commits a ledger', async () => {
    const f = await fixture();
    try {
      f.process.mockRejectedValueOnce(new SettlementDraftLeaseLostError());
      await expect(f.worker.drainOnce()).resolves.toMatchObject({
        jobId: 'draft-job',
        itemsProcessed: 0,
        itemsFailed: 0,
        itemsSkipped: 0,
        batchStatus: null,
        commitAttempted: false,
      });
      expect(f.preparation.finalize).not.toHaveBeenCalled();
      expect(f.committer.commitReadyBatch).not.toHaveBeenCalled();
    } finally {
      await f.module.close();
    }
  });

  it('unexpected handler failure is not converted into a successful drain receipt', async () => {
    const f = await fixture();
    try {
      const failure = new Error('test-draft-handler-failure');
      f.process.mockRejectedValueOnce(failure);
      await expect(f.worker.drainOnce()).rejects.toBe(failure);
      expect(f.preparation.finalize).not.toHaveBeenCalled();
      expect(f.committer.commitReadyBatch).not.toHaveBeenCalled();
    } finally {
      await f.module.close();
    }
  });

  it('a missing handler fails explicitly instead of falling through to ledger work', async () => {
    const f = await fixture(false);
    try {
      await expect(f.worker.drainOnce()).rejects.toThrow('SettlementDraftHandlerUnavailable');
      expect(f.process).not.toHaveBeenCalled();
      expect(f.prisma.activityBatchJobItem.findMany).not.toHaveBeenCalled();
      expect(f.preparation.finalize).not.toHaveBeenCalled();
      expect(f.committer.commitReadyBatch).not.toHaveBeenCalled();
    } finally {
      await f.module.close();
    }
  });
});

describe('ActivityBatchWorker automatic ledger commit', () => {
  // `fencedRows` = 带围栏的收尾写影响到的行数。1 = 租约仍在我手上(常态);
  // 0 = 已被新一代持有者接管 ⇒ 收尾写落空(第六轮评审 B-02)。
  function readyRound(commitReadyBatch: jest.Mock, fencedRows = 1) {
    const prisma = {
      activityBatchJobItem: { findMany: jest.fn().mockResolvedValue([]) },
      activityBatchJob: {
        update: jest.fn().mockResolvedValue(undefined),
        updateMany: jest.fn().mockResolvedValue({ count: fencedRows }),
      },
    };
    const preparation = {
      finalize: jest.fn().mockResolvedValue({
        postingBatchId: 'batch-1',
        batchStatus: 'ready',
      }),
    };
    const worker = new ActivityBatchWorker(
      prisma as never,
      preparation as never,
      { commitReadyBatch } as never,
      true,
    ) as unknown as {
      drainOnce(): Promise<{
        batchStatus: string | null;
        jobClaimed: boolean;
        commitAttempted: boolean;
        commitErrorCode: string | null;
      }>;
      enqueuePreparingBatches(): Promise<number>;
      claimJob(): Promise<{ id: string; leaseOwner: string; leaseGeneration: number }>;
    };
    worker.enqueuePreparingBatches = jest.fn().mockResolvedValue(0);
    worker.claimJob = jest.fn().mockResolvedValue({
      id: 'job-1',
      leaseOwner: 'worker-1',
      leaseGeneration: 1,
    });
    return { worker, prisma, preparation };
  }

  it('准备收口到 ready 后,同一轮调用自动提交者并返回 committed', async () => {
    const commitReadyBatch = jest.fn().mockResolvedValue({ batchStatus: 'committed' });
    const { worker } = readyRound(commitReadyBatch);

    await expect(worker.drainOnce()).resolves.toMatchObject({ batchStatus: 'committed' });
    expect(commitReadyBatch).toHaveBeenCalledWith('batch-1');
  });

  it('自动提交失败时不改 batch 状态,把同一 job 退回 pending 供下一轮重试', async () => {
    const commitReadyBatch = jest.fn().mockRejectedValue({
      name: 'BizException',
      biz: { code: 20084, message: 'baseline changed' },
    });
    const { worker } = readyRound(commitReadyBatch);
    const releaseForRetry = jest.fn().mockResolvedValue(undefined);
    (worker as unknown as { releaseForRetry: jest.Mock }).releaseForRetry = releaseForRetry;

    await expect(worker.drainOnce()).resolves.toMatchObject({ batchStatus: 'ready' });
    expect(releaseForRetry).toHaveBeenCalledWith(
      'job-1',
      { leaseOwner: 'worker-1', leaseGeneration: 1 },
      expect.any(Date),
      expect.objectContaining({ name: 'BizException' }),
    );
  });

  // 第六轮评审 B-02:围栏落空是**正常路径**(我已不是持有者),不是异常 ——
  // 安静退出,既不抛错也不重试,更不替新持有者去跑 commit。
  it('ready 收口时围栏已失效 ⇒ 放弃本轮,不调用自动提交者', async () => {
    const commitReadyBatch = jest.fn().mockResolvedValue({ batchStatus: 'committed' });
    const { worker } = readyRound(commitReadyBatch, 0);

    await expect(worker.drainOnce()).resolves.toMatchObject({
      jobClaimed: true,
      batchStatus: null,
      commitAttempted: false,
      commitErrorCode: null,
    });
    expect(commitReadyBatch).not.toHaveBeenCalled();
  });

  it('claims the existing queue before it creates a new reconciliation job', async () => {
    const order: string[] = [];
    const reconciliation = {
      enqueueDueActivityStartExpiryJobs: jest.fn(() => {
        order.push('reconciliation-enqueue');
        return Promise.resolve(1);
      }),
    };
    const worker = new ActivityBatchWorker(
      {} as never,
      {} as never,
      {} as never,
      true,
      reconciliation as never,
    ) as unknown as {
      drainOnce(): Promise<{ jobsEnqueued: number; jobClaimed: boolean }>;
      enqueuePreparingBatches(): Promise<number>;
      claimJob(): Promise<null>;
    };
    worker.enqueuePreparingBatches = jest.fn(() => {
      order.push('ledger-enqueue');
      return Promise.resolve(0);
    });
    worker.claimJob = jest.fn(() => {
      order.push('claim');
      return Promise.resolve(null);
    });

    await expect(worker.drainOnce()).resolves.toMatchObject({ jobsEnqueued: 1, jobClaimed: false });
    expect(order).toEqual(['ledger-enqueue', 'claim', 'reconciliation-enqueue']);
  });

  it('maps a claimed reconciliation result into the same drain receipt without ledger finalization', async () => {
    const reconciliation = {
      enqueueDueActivityStartExpiryJobs: jest.fn().mockResolvedValue(0),
      expireAtActivityStart: jest.fn().mockResolvedValue({
        kind: 'succeeded',
        expiredIdentityCount: 2,
        expiredInvitationCount: 1,
      }),
    };
    const worker = new ActivityBatchWorker(
      {} as never,
      {} as never,
      {} as never,
      true,
      reconciliation as never,
    ) as unknown as {
      drainOnce(): Promise<{
        jobClaimed: boolean;
        itemsProcessed: number;
        itemsFailed: number;
        batchStatus: string | null;
      }>;
      enqueuePreparingBatches(): Promise<number>;
      claimJob(): Promise<{
        id: string;
        activityId: string;
        jobTypeCode: string;
        leaseOwner: string;
        leaseGeneration: number;
      }>;
    };
    worker.enqueuePreparingBatches = jest.fn().mockResolvedValue(0);
    worker.claimJob = jest.fn().mockResolvedValue({
      id: 'reconciliation-job-1',
      activityId: 'activity-1',
      jobTypeCode: 'reconciliation',
      leaseOwner: 'worker-1',
      leaseGeneration: 3,
    });

    await expect(worker.drainOnce()).resolves.toMatchObject({
      jobClaimed: true,
      itemsProcessed: 3,
      itemsFailed: 0,
      batchStatus: null,
    });
    expect(reconciliation.expireAtActivityStart).toHaveBeenCalledWith({
      jobId: 'reconciliation-job-1',
      activityId: 'activity-1',
      fence: { leaseOwner: 'worker-1', leaseGeneration: 3 },
    });
  });
});
