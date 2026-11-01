import { PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { validate } from 'class-validator';
import { ROUTE_AUTHZ_DECLARATION_KEY } from '../../common/decorators/route-authz.decorator';
import { PrismaService } from '../../database/prisma.service';
import { ACTIVITY_BATCH_AUTO_COMMIT_ENABLED, ActivityBatchWorker } from './activity-batch.worker';
import { ActivityTimeCorrectionBackgroundService } from './activity-time-correction-background.service';
import { AppManagedActivityTimeCorrectionJobsController } from './controllers/app-managed-activity-time-correction-jobs.controller';
import { AppCommitActivityTimeCorrectionDto } from './dto/app/app-activity-time-correction.dto';
import { AppActivityTimeCorrectionJobParamsDto } from './dto/app/app-activity-time-correction-job.dto';
import { LedgerPreparationService } from './ledger-preparation.service';
import { LedgerReadyBatchCommitter } from './ledger-ready-batch-committer.service';
import { HumanCorrectionItemAuthority } from './human-correction-item-authority';

describe('Human correction background transport and worker contract (no database)', () => {
  it('declares exactly accept, progress and explicit retry, each under current Human final-review qualification', () => {
    const controller = AppManagedActivityTimeCorrectionJobsController;
    expect(Reflect.getMetadata(PATH_METADATA, controller)).toBe(
      'app/v1/my/managed-activities/:activityId/time-corrections/:requestId/commit-jobs',
    );
    expect(Object.getOwnPropertyNames(controller.prototype).sort()).toEqual([
      'constructor',
      'detail',
      'enqueue',
      'retry',
    ]);
    for (const name of ['enqueue', 'detail', 'retry'] as const) {
      const method: unknown = Object.getOwnPropertyDescriptor(controller.prototype, name)?.value;
      if (typeof method !== 'function') throw new Error('declared method is missing');
      expect(Reflect.getMetadata(ROUTE_AUTHZ_DECLARATION_KEY, method)).toEqual([
        {
          admission: 'app-member',
          require: 'all',
          engine: 'authz-scoped',
          scopes: ['org-scope'],
          codes: [{ code: 'activity.settlement-final-review.record', scope: null }],
        },
      ]);
    }
  });

  it('rejects client actor, hash, lease and timeout overrides in the unchanged commit body', async () => {
    const dto = Object.assign(new AppCommitActivityTimeCorrectionDto(), {
      expectedBaseSettlementVersionId: 'base-version',
      operationKey: 'operation-key',
      correctionApplicationId: 'application',
      postingBatchId: 'posting-batch',
      actorUserId: 'service-user',
      requestHash: 'client-hash',
      leaseGeneration: 999,
      timeout: 60_000,
    });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.map((row) => row.property).sort()).toEqual([
      'actorUserId',
      'leaseGeneration',
      'requestHash',
      'timeout',
    ]);
    const params = Object.assign(new AppActivityTimeCorrectionJobParamsDto(), {
      activityId: 'a',
      requestId: 'r',
      jobId: 'j',
    });
    expect((await validate(params)).map((row) => row.property).sort()).toEqual([
      'activityId',
      'jobId',
      'requestId',
    ]);
  });

  it.each([true, false])(
    'dispatches the durable Human job applied=%s without generic ledger prepare/auto-commit',
    async (applied) => {
      const process = jest.fn().mockResolvedValue(applied);
      const tx = {
        $executeRaw: jest.fn().mockResolvedValue(0),
        $queryRaw: jest
          .fn<Promise<{ id: string }[]>, [Prisma.Sql]>()
          .mockResolvedValue([{ id: 'job' }]),
        activityBatchJob: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          update: jest.fn().mockResolvedValue({
            id: 'job',
            activityId: 'activity',
            jobTypeCode: 'human_correction_commit',
            leaseGeneration: 8,
            payload: { action: 'human_correction_commit' },
          }),
        },
      };
      const prisma = {
        activityBatchJob: {
          updateMany: jest
            .fn<Promise<{ count: number }>, [Prisma.ActivityBatchJobUpdateManyArgs]>()
            .mockResolvedValue({ count: 0 }),
        },
        ledgerPostingBatch: { findMany: jest.fn().mockResolvedValue([]) },
        $transaction: jest.fn(async (body: (client: typeof tx) => Promise<unknown>) => body(tx)),
      };
      const preparation = {
        finalize: jest.fn(),
        prepareChunk: jest.fn(),
        ensurePrepareJob: jest.fn(),
      };
      const committer = { commitReadyBatch: jest.fn() };
      const module = await Test.createTestingModule({
        providers: [
          ActivityBatchWorker,
          { provide: PrismaService, useValue: prisma },
          { provide: LedgerPreparationService, useValue: preparation },
          { provide: LedgerReadyBatchCommitter, useValue: committer },
          { provide: ACTIVITY_BATCH_AUTO_COMMIT_ENABLED, useValue: true },
          { provide: ActivityTimeCorrectionBackgroundService, useValue: { process } },
          {
            provide: HumanCorrectionItemAuthority,
            useValue: {
              hasConnectionBinding: true,
              assertClient: jest.fn(),
              assertCallerInTx: jest.fn().mockResolvedValue(undefined),
            },
          },
        ],
      }).compile();
      try {
        await expect(module.get(ActivityBatchWorker).drainOnce()).resolves.toMatchObject({
          jobId: 'job',
          itemsProcessed: applied ? 1 : 0,
          itemsFailed: 0,
          batchStatus: applied ? 'committed' : null,
          commitAttempted: false,
        });
        expect(process).toHaveBeenCalledTimes(1);
        expect(process).toHaveBeenCalledWith({
          jobId: 'job',
          activityId: 'activity',
          leaseGeneration: 8,
          leaseOwner: expect.any(String) as unknown,
        });
        expect(preparation.finalize).not.toHaveBeenCalled();
        expect(committer.commitReadyBatch).not.toHaveBeenCalled();
        const sql = tx.$queryRaw.mock.calls[0]?.[0];
        if (!sql) throw new Error('claim SQL was not issued');
        expect(sql.values).toContain('human_correction_commit');
        expect(sql.text).toContain('FOR UPDATE SKIP LOCKED');
        expect(sql.text).toContain('"CorrectionApplication"');
        expect(sql.text).toContain("IN ('2','3')");
        expect(prisma.activityBatchJob.updateMany).not.toHaveBeenCalled();
        expect(prisma.ledgerPostingBatch.findMany).not.toHaveBeenCalled();
      } finally {
        await module.close();
      }
    },
  );
  it('general recovery retains the original V2/V3 Human batch exclusion', async () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      $queryRaw: jest.fn().mockResolvedValue([]),
      activityBatchJob: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const prisma = {
      activityBatchJob: {
        updateMany: jest
          .fn<Promise<{ count: number }>, [Prisma.ActivityBatchJobUpdateManyArgs]>()
          .mockResolvedValue({ count: 0 }),
      },
      ledgerPostingBatch: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(async (body: unknown): Promise<unknown> => {
        if (typeof body !== 'function') throw new Error('callback required');
        const outcome: unknown = Reflect.apply(body, undefined, [tx]);
        return await Promise.resolve(outcome);
      }),
    };
    const worker = new ActivityBatchWorker(prisma as never, {} as never, {} as never, true);
    await expect(worker.drainOnce()).resolves.toMatchObject({ jobClaimed: false });
    const reset = prisma.activityBatchJob.updateMany.mock.calls[0]?.[0];
    expect(reset).toMatchObject({
      where: {
        postingBatch: {
          correctionApplied: {
            none: {
              correctionRequest: {
                OR: [
                  { requestedChangeJson: { path: ['schemaVersion'], equals: 2 } },
                  { requestedChangeJson: { path: ['schemaVersion'], equals: 3 } },
                ],
              },
            },
          },
        },
      },
    });
  });
});
