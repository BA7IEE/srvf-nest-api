import { Test } from '@nestjs/testing';
import { Prisma, Role, UserStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ActivityContributionPolicyCommand } from './activity-contribution-policy-command';
import { ActivityContributionPolicyCatalogueQueryService } from './activity-contribution-policy-catalogue-query.service';
import { BizCode } from '../../common/exceptions/biz-code.constant';

describe('E1-2 bounded catalogue queries', () => {
  async function fixture() {
    const db = {
      contributionPolicy: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      contributionPolicyVersion: {
        findMany: jest
          .fn<Promise<never[]>, [Prisma.ContributionPolicyVersionFindManyArgs]>()
          .mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ total: 0n }]),
    };
    const access = jest.fn().mockResolvedValue({});
    const transaction = jest.fn((fn: (tx: typeof db) => unknown) => fn(db));
    const m = await Test.createTestingModule({
      providers: [
        ActivityContributionPolicyCatalogueQueryService,
        {
          provide: PrismaService,
          useValue: { $transaction: transaction },
        },
        { provide: ActivityContributionPolicyCommand, useValue: { assertAccess: access } },
      ],
    }).compile();
    const user = {
      id: 'actor',
      username: 'actor',
      role: Role.USER,
      status: UserStatus.ACTIVE,
      memberId: null,
    };
    return {
      db,
      access,
      transaction,
      user,
      service: m.get(ActivityContributionPolicyCatalogueQueryService),
    };
  }
  it('uses canonical pagination, exact filter and stable ordering', async () => {
    const f = await fixture();
    expect(await f.service.list({ page: 2, pageSize: 3, code: 'policy' }, f.user)).toEqual({
      items: [],
      total: 0,
      page: 2,
      pageSize: 3,
    });
    expect(f.access).toHaveBeenCalledWith(f.db, f.user, 'contribution-policy.read.catalog');
    expect(f.db.contributionPolicy.findMany).toHaveBeenCalledWith({
      where: { code: 'policy' },
      skip: 3,
      take: 3,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 2000,
      timeout: 5000,
    });
  });
  it('version list does not fetch heavy definition JSON', async () => {
    const f = await fixture();
    await f.service.listVersions(
      'policy',
      { page: 1, pageSize: 20, statusCode: 'retired' },
      f.user,
    );
    const args = f.db.contributionPolicyVersion.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ policyId: 'policy', statusCode: 'retired' });
    expect(args.select).not.toHaveProperty('definitionJson');
    expect(args.orderBy).toEqual([{ version: 'desc' }, { id: 'desc' }]);
  });
  it('missing policy is not disguised as an empty version page', async () => {
    const f = await fixture();
    f.db.$queryRaw.mockResolvedValue([]);
    await expect(
      f.service.listVersions('missing', { page: 1, pageSize: 20 }, f.user),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_CONTRIBUTION_POLICY_NOT_FOUND });
  });
  it('detail requires both immutable anchors', async () => {
    const f = await fixture();
    await expect(f.service.getVersion('policy', 'version', f.user)).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_CONTRIBUTION_POLICY_NOT_FOUND,
    });
    expect(f.db.contributionPolicyVersion.findFirst).toHaveBeenCalledWith({
      where: { id: 'version', policyId: 'policy' },
    });
  });
  it('denied access cannot query the target', async () => {
    const f = await fixture();
    f.access.mockRejectedValue(new Error('denied'));
    await expect(f.service.get('policy', f.user)).rejects.toThrow('denied');
    expect(f.db.contributionPolicy.findFirst).not.toHaveBeenCalled();
  });
});
