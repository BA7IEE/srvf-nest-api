import { ActivityBatchWorker } from './activity-batch.worker';

describe('ActivityBatchWorker automatic ledger commit', () => {
  function readyRound(commitReadyBatch: jest.Mock) {
    const prisma = {
      activityBatchJobItem: { findMany: jest.fn().mockResolvedValue([]) },
      activityBatchJob: {
        update: jest.fn().mockResolvedValue(undefined),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
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
      drainOnce(): Promise<{ batchStatus: string | null }>;
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
      expect.any(Date),
      expect.objectContaining({ name: 'BizException' }),
    );
  });

  it('claims the existing queue before it creates a new reconciliation job', async () => {
    const order: string[] = [];
    const reconciliation = {
      enqueueDueActivityStartExpiryJobs: jest.fn(async () => {
        order.push('reconciliation-enqueue');
        return 1;
      }),
    };
    const worker = new ActivityBatchWorker({} as never, {} as never, {} as never, true, reconciliation as never) as unknown as {
      drainOnce(): Promise<{ jobsEnqueued: number; jobClaimed: boolean }>;
      enqueuePreparingBatches(): Promise<number>;
      claimJob(): Promise<null>;
    };
    worker.enqueuePreparingBatches = jest.fn(async () => {
      order.push('ledger-enqueue');
      return 0;
    });
    worker.claimJob = jest.fn(async () => {
      order.push('claim');
      return null;
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
    const worker = new ActivityBatchWorker({} as never, {} as never, {} as never, true, reconciliation as never) as unknown as {
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
