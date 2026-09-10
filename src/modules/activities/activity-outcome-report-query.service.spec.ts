import { Test } from '@nestjs/testing';
import { Prisma, Role, UserStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { ActivityOutcomeAccessService } from './activity-outcome-access.service';
import { ActivityOutcomeReportQueryService } from './activity-outcome-report-query.service';

describe('C5 bounded report transaction', () => {
  async function fixture() {
    const order: string[] = [];
    const authorize = jest.fn((_tx: unknown, _user: unknown, id: string) => {
      order.push(`auth:${id}`);
      return Promise.resolve({
        activity: {
          id,
          statusCode: 'draft',
          metricRequirementCode: null,
          selectedMetricSetVersionId: null,
          selectedMetricSetDefinitionHash: null,
          metricSelectionRevision: 0,
        },
      });
    });
    const findMany = jest.fn((args: { where: { activityId: string } }) => {
      order.push(`read:${args.where.activityId}`);
      return Promise.resolve([]);
    });
    const lock = jest.fn((_strings: TemplateStringsArray, id: string) => {
      order.push(`lock:${id}`);
      return Promise.resolve([{ id }]);
    });
    const tx = { $queryRaw: lock, activityOutcomeRevision: { findMany } };
    const transaction = jest.fn(
      (
        fn: (client: typeof tx) => unknown,
        options: { isolationLevel: Prisma.TransactionIsolationLevel; timeout: number },
      ) => {
        expect(options.timeout).toBe(30000);
        return Promise.resolve(fn(tx));
      },
    );
    const module = await Test.createTestingModule({
      providers: [
        ActivityOutcomeReportQueryService,
        { provide: PrismaService, useValue: { $transaction: transaction } },
        { provide: ActivityOutcomeAccessService, useValue: { authorize } },
      ],
    }).compile();
    const service = module.get(ActivityOutcomeReportQueryService);
    return { service, module, authorize, lock, findMany, transaction, order };
  }
  const user = {
    id: 'user',
    username: 'user',
    role: Role.USER,
    status: UserStatus.ACTIVE,
    memberId: 'member',
  };

  it('authorizes all, locks stable IDs and rechecks each wait plus the final response', async () => {
    const f = await fixture();
    try {
      const result = await f.service.query(['b', 'a'], user);
      expect(result.items.map((row) => row.activityId)).toEqual(['a', 'b']);
      expect(
        result.items.every(
          (row) => row.currentConfirmed === null && row.formalStatus === 'not_confirmed',
        ),
      ).toBe(true);
      expect(f.order).toEqual([
        'auth:a',
        'auth:b',
        'lock:a',
        'auth:a',
        'lock:b',
        'auth:b',
        'auth:a',
        'read:a',
        'auth:b',
        'read:b',
        'auth:a',
        'auth:b',
      ]);
      expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: 'ReadCommitted',
        timeout: 30000,
      });
      expect(f.findMany).toHaveBeenCalledWith({
        where: { activityId: 'a', statusCode: 'confirmed' },
        take: 2,
        include: {
          metricSetVersion: {
            include: { items: { take: 101, include: { metricDefinition: true } } },
          },
          values: { take: 101, include: { evidence: { take: 21, orderBy: { sortOrder: 'asc' } } } },
        },
      });
    } finally {
      await f.module.close();
    }
  });
  it.each([[], ['a', 'a'], Array.from({ length: 21 }, (_, i) => `a${i}`), [''], ['a'.repeat(65)]])(
    'rejects invalid explicit sets before starting a transaction (%j)',
    async (...ids) => {
      const f = await fixture();
      try {
        await expect(f.service.query(ids, user)).rejects.toThrow(BizException);
        expect(f.transaction).not.toHaveBeenCalled();
      } finally {
        await f.module.close();
      }
    },
  );
  it('refuses the whole batch before reading facts when one activity is inaccessible', async () => {
    const f = await fixture();
    f.authorize.mockRejectedValueOnce(
      new BizException(BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE),
    );
    try {
      await expect(f.service.query(['a', 'b'], user)).rejects.toThrow(BizException);
      expect(f.lock).not.toHaveBeenCalled();
      expect(f.findMany).not.toHaveBeenCalled();
    } finally {
      await f.module.close();
    }
  });
  it('checks access after the real lock call before any formal query', async () => {
    const f = await fixture();
    f.lock.mockImplementationOnce(() => {
      f.authorize.mockRejectedValueOnce(
        new BizException(BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE),
      );
      return Promise.resolve([]);
    });
    try {
      await expect(f.service.get('a', user)).rejects.toThrow(BizException);
      expect(f.findMany).not.toHaveBeenCalled();
    } finally {
      await f.module.close();
    }
  });
});
