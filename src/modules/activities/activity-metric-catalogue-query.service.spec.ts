import { Test } from '@nestjs/testing';
import { Role, UserStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ActivityMetricCommand } from './activity-metric-command';
import { ActivityMetricCatalogueQueryService } from './activity-metric-catalogue-query.service';
describe('metric catalogue query boundaries', () => {
  it('checks access before bounded exact-filter queries and stable ordering', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(0);
    const tx = { activityMetricDefinition: { findMany, count } };
    const access = jest.fn().mockImplementation(() => {
      expect(findMany).not.toHaveBeenCalled();
      expect(count).not.toHaveBeenCalled();
      return Promise.resolve();
    });
    const module = await Test.createTestingModule({
      providers: [
        ActivityMetricCatalogueQueryService,
        {
          provide: PrismaService,
          useValue: { $transaction: (fn: (value: typeof tx) => Promise<unknown>) => fn(tx) },
        },
        { provide: ActivityMetricCommand, useValue: { assertAccess: access } },
      ],
    }).compile();
    const user = {
      id: 'user_one',
      username: 'test',
      role: Role.USER,
      status: UserStatus.ACTIVE,
      memberId: null,
    };
    try {
      expect(
        await module
          .get(ActivityMetricCatalogueQueryService)
          .listDefinitions(
            { page: 2, pageSize: 3, code: 'one', statusCode: 'active', kindCode: 'boolean' },
            user,
          ),
      ).toEqual({ items: [], total: 0, page: 2, pageSize: 3 });
      expect(access).toHaveBeenCalledWith(tx, user, 'activity-metric.read.catalog');
      expect(findMany).toHaveBeenCalledWith({
        where: { code: 'one', statusCode: 'active', kindCode: 'boolean' },
        skip: 3,
        take: 3,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      expect(count).toHaveBeenCalledWith({
        where: { code: 'one', statusCode: 'active', kindCode: 'boolean' },
      });
    } finally {
      await module.close();
    }
  });
});
