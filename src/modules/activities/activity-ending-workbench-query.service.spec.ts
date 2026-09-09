import type { Activity, Prisma } from '@prisma/client';
import type { PrismaService } from '../../database/prisma.service';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizException } from '../../common/exceptions/biz.exception';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { ActivityOutcomeAccessService } from './activity-outcome-access.service';
import { ActivityEndingWorkbenchQueryService } from './activity-ending-workbench-query.service';

describe('C4 ending workbench transaction', () => {
  function fixture() {
    const order: string[] = [];
    const activity = {
      id: 'activity',
      statusCode: 'draft',
      metricRequirementCode: null,
      selectedMetricSetVersionId: null,
      selectedMetricSetDefinitionHash: null,
      metricSelectionRevision: 0,
    } as Activity;
    const authorize = jest.fn(() => {
      order.push('authorize');
      return Promise.resolve({ activity });
    });
    const findMany = jest.fn().mockResolvedValue([]);
    const findFirst = jest.fn().mockResolvedValue(null);
    const receipt = jest.fn().mockResolvedValue(null);
    const set = jest.fn().mockResolvedValue(null);
    const lock = jest.fn(() => {
      order.push('lock');
      return Promise.resolve([{ id: activity.id }]);
    });
    const tx = {
      $queryRaw: lock,
      activityOutcomeRevision: { findMany, findFirst },
      activityMetricSetVersion: { findUnique: set },
      activityOutcomeFinalizationReceipt: { findFirst: receipt },
    };
    const transaction = jest.fn((fn: (value: Prisma.TransactionClient) => unknown) =>
      fn(tx as unknown as Prisma.TransactionClient),
    );
    const service = new ActivityEndingWorkbenchQueryService(
      { $transaction: transaction } as unknown as PrismaService,
      { authorize } as unknown as ActivityOutcomeAccessService,
    );
    const user = { id: 'user' } as CurrentUserPayload;
    return {
      service,
      activity,
      authorize,
      findMany,
      findFirst,
      receipt,
      set,
      lock,
      transaction,
      order,
      user,
    };
  }
  it('reauthorizes after locking and after reads in one bounded transaction', async () => {
    const f = fixture();
    const result = await f.service.get('activity', f.user);
    expect(f.order).toEqual(['authorize', 'lock', 'authorize', 'authorize']);
    expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'ReadCommitted',
      timeout: 30000,
    });
    expect(result.metricRequirementCode).toBe('unconfigured');
    expect(f.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { activityId: 'activity', statusCode: 'confirmed' },
        take: 2,
        include: {
          metricSetVersion: {
            include: { items: { take: 101, include: { metricDefinition: true } } },
          },
          values: { take: 101, include: { evidence: { take: 21, orderBy: { sortOrder: 'asc' } } } },
        },
      }),
    );
    expect(f.findFirst).toHaveBeenCalledWith({
      where: { activityId: 'activity' },
      orderBy: { revision: 'desc' },
      select: { id: true, revision: true, statusCode: true },
    });
    expect(f.set).not.toHaveBeenCalled();
    expect(f.receipt).not.toHaveBeenCalled();
  });
  it('rejects revoked access after lock without reading facts', async () => {
    const f = fixture();
    f.authorize
      .mockResolvedValueOnce({ activity: f.activity })
      .mockRejectedValueOnce(new BizException(BizCode.FORBIDDEN));
    await expect(f.service.get('activity', f.user)).rejects.toThrow(BizException);
    expect(f.findMany).not.toHaveBeenCalled();
  });
  it('does not hide a final authorization failure', async () => {
    const f = fixture();
    f.authorize
      .mockResolvedValueOnce({ activity: f.activity })
      .mockResolvedValueOnce({ activity: f.activity })
      .mockRejectedValueOnce(new BizException(BizCode.FORBIDDEN));
    await expect(f.service.get('activity', f.user)).rejects.toThrow(BizException);
  });
  it.each(['superseded', 'confirmed'])(
    'does not show a %s latest head as pending',
    async (statusCode) => {
      const f = fixture();
      f.findFirst.mockResolvedValue({ id: 'old', revision: 8, statusCode });
      expect((await f.service.get('activity', f.user)).pendingDraft).toBeNull();
      expect(f.receipt).not.toHaveBeenCalled();
    },
  );
  it('reports an initial draft independently of formal absence', async () => {
    const f = fixture();
    f.findFirst.mockResolvedValue({ id: 'draft', revision: 1, statusCode: 'draft' });
    expect((await f.service.get('activity', f.user)).pendingDraft).toEqual({
      id: 'draft',
      revision: 1,
      kind: 'initial',
      baseConfirmedRevision: null,
    });
  });
  it('rejects damaged selection rather than reporting unconfigured', async () => {
    const f = fixture();
    f.activity.metricSelectionRevision = 1;
    await expect(f.service.get('activity', f.user)).rejects.toThrow(BizException);
  });
  it('rejects multiple formal heads rather than selecting the newest', async () => {
    const f = fixture();
    f.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    await expect(f.service.get('activity', f.user)).rejects.toThrow(BizException);
  });
  it('does not disguise database failures as empty data', async () => {
    const f = fixture();
    const failure = new Error('database unavailable');
    f.findMany.mockRejectedValue(failure);
    await expect(f.service.get('activity', f.user)).rejects.toBe(failure);
  });
});
