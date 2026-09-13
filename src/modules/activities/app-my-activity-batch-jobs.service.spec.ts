import { Test } from '@nestjs/testing';
import { PrismaService } from '../../database/prisma.service';
import { AppMyActivityBatchJobsService } from './app-my-activity-batch-jobs.service';

describe('App draft batch job compatibility', () => {
  async function fixture(statusCode = 'failed') {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const row = {
      id: 'draft-job',
      jobTypeCode: 'bulk_proxy',
      statusCode,
      total: 1,
      succeeded: statusCode === 'succeeded' ? 1 : 0,
      failed: ['failed', 'dead', 'partial_failed'].includes(statusCode) ? 1 : 0,
      skipped: 0,
      attempts: 2,
      leaseExpiresAt: null,
      createdAt: now,
      startedAt: now,
      completedAt: null,
      activity: { id: 'activity', title: 'Activity', statusCode: 'settling' },
      createdBy: null,
    };
    const tx = {
      activityBatchJob: {
        findUnique: jest.fn().mockResolvedValue({ activityId: 'activity' }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      activityBatchJobItem: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      activity: { findFirst: jest.fn().mockResolvedValue(null) },
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ id: 'activity' }])
        .mockResolvedValueOnce([{ id: row.id, activityId: 'activity', statusCode }])
        .mockResolvedValueOnce([{ id: 'current-responsibility' }])
        .mockResolvedValueOnce([{ authoritativeNow: now }]),
    };
    const prisma = {
      activityBatchJob: {
        findFirst: jest.fn(
          (query: {
            where: unknown;
            select: Record<string, unknown>;
          }): Promise<typeof row | null> => {
            void query;
            return Promise.resolve(row);
          },
        ),
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([row]),
      },
      activityBatchJobItem: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'item',
            itemKey: 'generate',
            statusCode: 'failed',
            attempts: 1,
            lastErrorCode: 'DraftJobProofMissing',
            safeMessage: 'DraftJobProofMissing',
          },
        ]),
      },
      $transaction: jest.fn(
        async (body: ((client: typeof tx) => Promise<void>) | Promise<unknown>[]) =>
          Array.isArray(body) ? Promise.all(body) : body(tx),
      ),
    };
    const module = await Test.createTestingModule({
      providers: [AppMyActivityBatchJobsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    return { module, service: module.get(AppMyActivityBatchJobsService), prisma, tx, now };
  }

  it('list applies identical current scope to the count and paginated query', async () => {
    const f = await fixture();
    try {
      const result = await f.service.list('current-member', {
        activityId: 'activity',
        page: 2,
        pageSize: 10,
      });
      const where = {
        activityId: 'activity',
        activity: {
          deletedAt: null,
          OR: [
            { initiatorMemberId: 'current-member' },
            {
              responsibilityAssignments: { some: { memberId: 'current-member', status: 'active' } },
            },
          ],
        },
      };
      expect(f.prisma.activityBatchJob.count).toHaveBeenCalledWith({ where });
      expect(f.prisma.activityBatchJob.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where,
          skip: 10,
          take: 10,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      );
      expect(result).toMatchObject({
        total: 1,
        page: 2,
        pageSize: 10,
        items: [{ jobId: 'draft-job' }],
      });
      expect(result.items[0]).not.toHaveProperty('resultReference');
      expect(result.items[0]).not.toHaveProperty('payload');
      expect(result.items[0]).not.toHaveProperty('retryFailedAllowed');
      expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
    } finally {
      await f.module.close();
    }
  });

  it('items checks current scope before reading and projects only existing safe fields', async () => {
    const f = await fixture();
    try {
      const result = await f.service.listItems('current-member', 'draft-job', {
        status: 'failed',
        page: 2,
        pageSize: 10,
      });
      expect(f.prisma.activityBatchJob.findFirst).toHaveBeenCalledWith({
        where: {
          id: 'draft-job',
          activity: {
            deletedAt: null,
            OR: [
              { initiatorMemberId: 'current-member' },
              {
                responsibilityAssignments: {
                  some: { memberId: 'current-member', status: 'active' },
                },
              },
            ],
          },
        },
        select: { id: true },
      });
      expect(f.prisma.activityBatchJobItem.count).toHaveBeenCalledWith({
        where: { jobId: 'draft-job', statusCode: 'failed' },
      });
      expect(f.prisma.activityBatchJobItem.findMany).toHaveBeenCalledWith({
        where: { jobId: 'draft-job', statusCode: 'failed' },
        skip: 10,
        take: 10,
        orderBy: [{ itemKey: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          itemKey: true,
          statusCode: true,
          attempts: true,
          lastErrorCode: true,
          safeMessage: true,
        },
      });
      expect(result).toEqual({
        total: 1,
        page: 2,
        pageSize: 10,
        items: [
          {
            itemId: 'item',
            itemKey: 'generate',
            statusCode: 'failed',
            attempts: 1,
            lastErrorCode: 'DraftJobProofMissing',
            safeMessage: 'DraftJobProofMissing',
          },
        ],
      });
      expect(f.prisma.activityBatchJob.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
        f.prisma.activityBatchJobItem.findMany.mock.invocationCallOrder[0],
      );
    } finally {
      await f.module.close();
    }
  });

  it.each(['detail', 'items'] as const)(
    '%s hides an unavailable task without reading its items',
    async (surface) => {
      const f = await fixture();
      try {
        f.prisma.activityBatchJob.findFirst.mockResolvedValueOnce(null);
        const request =
          surface === 'detail'
            ? f.service.detail('current-member', 'draft-job')
            : f.service.listItems('current-member', 'draft-job', { page: 1, pageSize: 10 });
        await expect(request).rejects.toHaveProperty('biz.code', 40400);
        expect(f.prisma.activityBatchJobItem.count).not.toHaveBeenCalled();
        expect(f.prisma.activityBatchJobItem.findMany).not.toHaveBeenCalled();
        expect(f.prisma.$transaction).not.toHaveBeenCalled();
      } finally {
        await f.module.close();
      }
    },
  );

  it.each([
    ['failed', true, true],
    ['dead', true, false],
    ['succeeded', false, false],
    ['pending', false, true],
    ['cancelled', false, false],
  ])('detail keeps existing safe fields and controls for %s', async (status, retry, cancel) => {
    const f = await fixture(String(status));
    try {
      const detail = await f.service.detail('current-member', 'draft-job');
      expect(detail).toMatchObject({
        jobId: 'draft-job',
        jobTypeCode: 'bulk_proxy',
        total: 1,
        retryFailedAllowed: retry,
        cancelAllowed: cancel,
      });
      expect(Object.keys(detail).sort()).toEqual(
        [
          'jobId',
          'jobTypeCode',
          'activity',
          'createdBy',
          'statusCode',
          'total',
          'succeeded',
          'failed',
          'skipped',
          'leaseStateText',
          'retryStateText',
          'createdAt',
          'startedAt',
          'completedAt',
          'retryFailedAllowed',
          'cancelAllowed',
        ].sort(),
      );
      expect(f.prisma.activityBatchJob.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 'draft-job',
            activity: {
              deletedAt: null,
              OR: [
                { initiatorMemberId: 'current-member' },
                {
                  responsibilityAssignments: {
                    some: { memberId: 'current-member', status: 'active' },
                  },
                },
              ],
            },
          },
        }),
      );
      const select = f.prisma.activityBatchJob.findFirst.mock.calls[0][0].select;
      for (const key of ['payload', 'resultReference', 'leaseOwner', 'requestHash']) {
        expect(select).not.toHaveProperty(key);
      }
    } finally {
      await f.module.close();
    }
  });

  it.each(['failed', 'dead', 'partial_failed'])(
    'retry %s only resets failed items and matching count',
    async (status) => {
      const f = await fixture(status);
      try {
        await f.service.retryFailed('current-member', 'draft-job');
        expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(f.tx.activityBatchJobItem.updateMany).toHaveBeenCalledWith({
          where: { jobId: 'draft-job', statusCode: 'failed' },
          data: { statusCode: 'pending', lastErrorCode: null, safeMessage: null },
        });
        expect(f.tx.activityBatchJob.update).toHaveBeenCalledWith({
          where: { id: 'draft-job' },
          data: {
            statusCode: 'pending',
            failed: { decrement: 1 },
            attempts: 0,
            leaseOwner: null,
            leaseExpiresAt: null,
            completedAt: null,
            lastErrorCode: null,
          },
        });
        // A retry cannot replace the original actor, payload, successful items or result pointer.
        expect(f.tx.$queryRaw).toHaveBeenCalledTimes(3);
        expect(f.prisma.activityBatchJob.findFirst).toHaveBeenCalledTimes(1);
      } finally {
        await f.module.close();
      }
    },
  );

  it('cancel uses the transaction clock and preserves the draft task data', async () => {
    const f = await fixture('pending');
    try {
      await f.service.cancel('current-member', 'draft-job');
      expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(f.tx.activityBatchJob.update).toHaveBeenCalledWith({
        where: { id: 'draft-job' },
        data: {
          statusCode: 'cancelled',
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: f.now,
        },
      });
      expect(f.tx.activityBatchJobItem.updateMany).not.toHaveBeenCalled();
      expect(f.tx.$queryRaw).toHaveBeenCalledTimes(4);
    } finally {
      await f.module.close();
    }
  });

  it.each(['retryFailed', 'cancel'] as const)(
    '%s refuses writes when current responsibility is absent',
    async (command) => {
      const f = await fixture();
      try {
        f.tx.$queryRaw
          .mockReset()
          .mockResolvedValueOnce([{ id: 'activity' }])
          .mockResolvedValueOnce([
            { id: 'draft-job', activityId: 'activity', statusCode: 'failed' },
          ])
          .mockResolvedValueOnce([]);
        await expect(f.service[command]('current-member', 'draft-job')).rejects.toHaveProperty(
          'biz.code',
          40400,
        );
        expect(f.tx.activity.findFirst).toHaveBeenCalledWith({
          where: {
            id: 'activity',
            deletedAt: null,
            initiatorMemberId: 'current-member',
          },
          select: { id: true },
        });
        expect(f.tx.activityBatchJob.update).not.toHaveBeenCalled();
        expect(f.tx.activityBatchJobItem.updateMany).not.toHaveBeenCalled();
      } finally {
        await f.module.close();
      }
    },
  );
});
