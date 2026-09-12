import { Test } from '@nestjs/testing';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuthzService } from '../authz/authz.service';
import { AppIdentityResolver } from '../users/app-identity.resolver';
import { SettlementDraftService } from './settlement-draft.service';
import {
  SettlementDraftBatchService,
  SettlementDraftLeaseLostError,
} from './settlement-draft-batch.service';

function partial(value: Record<string, unknown>): unknown {
  return expect.objectContaining(value);
}

describe('SettlementDraftBatchService fail-closed task boundary', () => {
  const input = {
    jobId: 'job-1',
    activityId: 'activity-1',
    leaseOwner: 'worker-1',
    leaseGeneration: 2,
    maxAttempts: 5,
    retryBackoffMs: 30000,
  };
  async function fixture() {
    const job = {
      id: input.jobId,
      activityId: input.activityId,
      jobTypeCode: 'bulk_proxy',
      payloadVersion: 1,
      payload: { action: 'settlement_draft_generate', executionMode: 'async' },
      statusCode: 'processing',
      leaseOwner: input.leaseOwner,
      leaseGeneration: input.leaseGeneration,
      leaseExpiresAt: new Date(Date.now() + 300000),
      total: 1,
      attempts: 1,
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      activityBatchJob: {
        findUnique: jest.fn().mockResolvedValue(job),
        update: jest.fn().mockResolvedValue({}),
      },
      activityBatchJobItem: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      $transaction: jest.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
    };
    const drafts = { generateInTransaction: jest.fn() };
    const gate = { assertV11WriteAllowed: jest.fn() };
    const module = await Test.createTestingModule({
      providers: [
        SettlementDraftBatchService,
        { provide: PrismaService, useValue: prisma },
        { provide: SettlementDraftService, useValue: drafts },
        { provide: ActivityWorkflowGate, useValue: gate },
        { provide: AppIdentityResolver, useValue: {} },
        { provide: AuthzService, useValue: {} },
      ],
    }).compile();
    return {
      module,
      service: module.get(SettlementDraftBatchService),
      job,
      tx,
      prisma,
      drafts,
      gate,
    };
  }

  it('legacy async without proof becomes a safe failed item, never a generated draft', async () => {
    const f = await fixture();
    try {
      await expect(f.service.process(input)).resolves.toEqual({ succeeded: false });
      expect(f.drafts.generateInTransaction).not.toHaveBeenCalled();
      expect(f.tx.activityBatchJobItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: partial({
            statusCode: 'failed',
            lastErrorCode: 'DraftJobProofMissing',
            safeMessage: '旧任务缺少执行凭据，请重新发起',
          }),
        }),
      );
      expect(f.tx.activityBatchJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: partial({
            statusCode: 'failed',
            failed: 1,
            succeeded: 0,
            skipped: 0,
          }),
        }),
      );
    } finally {
      await f.module.close();
    }
  });

  it.each(['generation', 'owner', 'expiry', 'cancel', 'action', 'activity'] as const)(
    'lost %s refuses both business writes and failure receipt writes',
    async (kind) => {
      const f = await fixture();
      try {
        if (kind === 'generation') f.job.leaseGeneration++;
        if (kind === 'owner') f.job.leaseOwner = 'other-worker';
        if (kind === 'expiry') f.job.leaseExpiresAt = new Date(0);
        if (kind === 'cancel') f.job.statusCode = 'cancelled';
        if (kind === 'action') f.job.payload.action = 'onsite_bulk_punch';
        if (kind === 'activity') f.job.activityId = 'other-activity';
        await expect(f.service.process(input)).rejects.toBeInstanceOf(
          SettlementDraftLeaseLostError,
        );
        expect(f.drafts.generateInTransaction).not.toHaveBeenCalled();
        expect(f.tx.activityBatchJob.update).not.toHaveBeenCalled();
        expect(f.tx.activityBatchJobItem.updateMany).not.toHaveBeenCalled();
      } finally {
        await f.module.close();
      }
    },
  );

  it.each([
    BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED,
    BizCode.ACTIVITY_WORKFLOW_READONLY_MAINTENANCE,
  ])('Gate %s defers without pretending a permanent business failure', async (code) => {
    const f = await fixture();
    try {
      f.gate.assertV11WriteAllowed.mockImplementation(() => {
        throw new BizException(code);
      });
      await expect(f.service.process(input)).resolves.toEqual({ succeeded: false });
      expect(f.drafts.generateInTransaction).not.toHaveBeenCalled();
      expect(f.tx.activityBatchJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: partial({
            statusCode: 'pending',
            failed: 0,
            succeeded: 0,
          }),
        }),
      );
    } finally {
      await f.module.close();
    }
  });

  it.each([1, 5])(
    'temporary failure at attempt %i uses bounded retry and never retains exception text',
    async (attempts) => {
      const f = await fixture();
      try {
        f.job.attempts = attempts;
        f.gate.assertV11WriteAllowed.mockImplementation(() => {
          throw new Error('private diagnostic must not be persisted');
        });
        await expect(f.service.process(input)).resolves.toEqual({ succeeded: false });
        expect(f.tx.activityBatchJob.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: partial({
              statusCode: attempts === 5 ? 'dead' : 'pending',
              failed: attempts === 5 ? 1 : 0,
              succeeded: 0,
              skipped: 0,
              lastErrorCode: 'DraftJobTemporaryFailure',
              leaseOwner: null,
            }),
          }),
        );
        expect(f.tx.activityBatchJobItem.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: partial({
              statusCode: attempts === 5 ? 'failed' : 'pending',
              lastErrorCode: 'DraftJobTemporaryFailure',
              safeMessage: '草稿生成未完成，请检查任务状态',
            }),
          }),
        );
        expect(JSON.stringify(f.tx.activityBatchJob.update.mock.calls)).not.toContain(
          'private diagnostic',
        );
        expect(JSON.stringify(f.tx.activityBatchJobItem.updateMany.mock.calls)).not.toContain(
          'private diagnostic',
        );
      } finally {
        await f.module.close();
      }
    },
  );
});
