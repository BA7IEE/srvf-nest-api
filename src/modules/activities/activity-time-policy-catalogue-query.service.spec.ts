import { Test } from '@nestjs/testing';
import { Prisma, Role, UserStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ActivityTimePolicyCommand } from './activity-time-policy-command';
import { ActivityTimePolicyCatalogueQueryService } from './activity-time-policy-catalogue-query.service';
import { BizCode } from '../../common/exceptions/biz-code.constant';

describe('D1-2 bounded catalogue queries', () => {
  async function fixture() {
    const db = {
      timePolicy: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      timePolicyVersion: {
        findMany: jest
          .fn<Promise<never[]>, [Prisma.TimePolicyVersionFindManyArgs]>()
          .mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ total: 0n }]),
    };
    const access = jest.fn().mockResolvedValue({});
    const m = await Test.createTestingModule({
      providers: [
        ActivityTimePolicyCatalogueQueryService,
        {
          provide: PrismaService,
          useValue: { $transaction: (fn: (tx: typeof db) => unknown) => fn(db) },
        },
        { provide: ActivityTimePolicyCommand, useValue: { assertAccess: access } },
      ],
    }).compile();
    const user = {
      id: 'actor',
      username: 'actor',
      role: Role.USER,
      status: UserStatus.ACTIVE,
      memberId: null,
    };
    return { db, access, user, service: m.get(ActivityTimePolicyCatalogueQueryService) };
  }
  it('uses canonical pagination, exact filter and stable ordering', async () => {
    const f = await fixture();
    expect(await f.service.list({ page: 2, pageSize: 3, code: 'policy' }, f.user)).toEqual({
      items: [],
      total: 0,
      page: 2,
      pageSize: 3,
    });
    expect(f.access).toHaveBeenCalledWith(f.db, f.user, 'activity-time-policy.read.catalog');
    expect(f.db.timePolicy.findMany).toHaveBeenCalledWith({
      where: { code: 'policy' },
      skip: 3,
      take: 3,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  });
  it('version list does not fetch heavy definition JSON', async () => {
    const f = await fixture();
    await f.service.listVersions(
      'policy',
      { page: 1, pageSize: 20, statusCode: 'retired' },
      f.user,
    );
    const args = f.db.timePolicyVersion.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ policyId: 'policy', statusCode: 'retired' });
    expect(args.select).not.toHaveProperty('definitionJson');
    expect(args.orderBy).toEqual([{ version: 'desc' }, { id: 'desc' }]);
  });
  it('missing policy is not disguised as an empty version page', async () => {
    const f = await fixture();
    f.db.$queryRaw.mockResolvedValue([]);
    await expect(
      f.service.listVersions('missing', { page: 1, pageSize: 20 }, f.user),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TIME_POLICY_NOT_FOUND });
  });
  it('detail requires both immutable anchors', async () => {
    const f = await fixture();
    await expect(f.service.getVersion('policy', 'version', f.user)).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_TIME_POLICY_NOT_FOUND,
    });
    expect(f.db.timePolicyVersion.findFirst).toHaveBeenCalledWith({
      where: { id: 'version', policyId: 'policy' },
    });
  });
  it('denied access cannot query the target', async () => {
    const f = await fixture();
    f.access.mockRejectedValue(new Error('denied'));
    await expect(f.service.get('policy', f.user)).rejects.toThrow('denied');
    expect(f.db.timePolicy.findFirst).not.toHaveBeenCalled();
  });
});
