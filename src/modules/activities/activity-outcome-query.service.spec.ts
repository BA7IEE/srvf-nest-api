import { Prisma, Role, UserStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { ActivityOutcomeAccessService } from './activity-outcome-access.service';
import { ActivityOutcomeQueryService } from './activity-outcome-query.service';

describe('C2 outcome query boundaries', () => {
  const actor = {
    id: 'actor',
    username: 'actor',
    role: Role.USER,
    status: UserStatus.ACTIVE,
    memberId: 'member',
  };
  function fixture() {
    const row = {
      id: 'outcome',
      activityId: 'activity',
      revision: 1,
      metricSetVersionId: 'historical-set',
      metricSetDefinitionHash: 'a'.repeat(64),
      statusCode: 'superseded',
      priorRevisionId: null,
      createdByUserId: 'private-creator',
      createdAt: new Date('2026-09-07T00:00:00.000Z'),
    };
    const tx = {
      activityOutcomeRevision: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([row]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const prisma = {
      $transaction: jest.fn((fn: (client: Prisma.TransactionClient) => unknown) =>
        fn(tx as unknown as Prisma.TransactionClient),
      ),
    };
    const access = { authorize: jest.fn().mockResolvedValue(undefined) };
    const service = new ActivityOutcomeQueryService(
      prisma as unknown as PrismaService,
      access as unknown as ActivityOutcomeAccessService,
    );
    return { tx, access, service };
  }
  it('paginates in revision order and returns only summary fields', async () => {
    const f = fixture();
    const result = await f.service.list('activity', { page: 2, pageSize: 20 }, actor);
    expect(f.tx.activityOutcomeRevision.findMany).toHaveBeenCalledWith({
      where: { activityId: 'activity' },
      orderBy: { revision: 'desc' },
      skip: 20,
      take: 20,
    });
    expect(Object.keys(result).sort()).toEqual(['items', 'page', 'pageSize', 'total']);
    expect(Object.keys(result.items[0]).sort()).toEqual([
      'activityId',
      'createdAt',
      'metricSetDefinitionHash',
      'metricSetVersionId',
      'outcomeRevisionId',
      'priorRevisionId',
      'revision',
      'statusCode',
    ]);
    expect(result.items[0].metricSetVersionId).toBe('historical-set');
    expect(f.access.authorize).toHaveBeenCalledTimes(2);
  });
  it('does not query records after access denial', async () => {
    const f = fixture();
    f.access.authorize.mockRejectedValue(new BizException(BizCode.FORBIDDEN));
    await expect(f.service.list('activity', new PaginationQueryDto(), actor)).rejects.toThrow(
      new BizException(BizCode.FORBIDDEN),
    );
    expect(f.tx.activityOutcomeRevision.findMany).not.toHaveBeenCalled();
  });
  it('does not return loaded rows if current access has been revoked', async () => {
    const f = fixture();
    f.access.authorize
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new BizException(BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE));
    await expect(f.service.list('activity', new PaginationQueryDto(), actor)).rejects.toThrow(
      new BizException(BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE),
    );
  });
  it('anchors detail by both activity and outcome and never falls back to latest', async () => {
    const f = fixture();
    await expect(f.service.get('activity', 'other-outcome', actor)).rejects.toThrow(
      new BizException(BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE),
    );
    expect(f.tx.activityOutcomeRevision.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'other-outcome', activityId: 'activity' },
      }),
    );
    expect(f.tx.activityOutcomeRevision.findMany).not.toHaveBeenCalled();
  });
  it.each([
    { page: 0, pageSize: 20 },
    { page: 1, pageSize: 101 },
    { page: 1.5, pageSize: 20 },
    { page: Number.MAX_SAFE_INTEGER, pageSize: 100 },
  ])('rejects invalid pagination %j before reading', async (query) => {
    const f = fixture();
    await expect(f.service.list('activity', query, actor)).rejects.toThrow(
      new BizException(BizCode.BAD_REQUEST),
    );
    expect(f.access.authorize).not.toHaveBeenCalled();
  });
});
