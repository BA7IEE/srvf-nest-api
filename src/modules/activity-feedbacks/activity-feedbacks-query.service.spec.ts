import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { PrismaService } from '../../database/prisma.service';
import type { AuthzService } from '../authz/authz.service';
import type { RbacService } from '../permissions/rbac.service';
import { ActivityFeedbacksQueryService } from './activity-feedbacks-query.service';

const CURRENT_USER: CurrentUserPayload = {
  id: 'admin-1',
  username: 'admin',
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  memberId: null,
};

const ROW = {
  rating: 4,
  comment: '很好',
  createdAt: new Date('2026-02-01T00:00:00.000Z'),
  updatedAt: new Date('2026-02-02T00:00:00.000Z'),
  member: { memberNo: 'V001', displayName: '队员甲' },
};

function makeService() {
  const activityFindFirst = jest.fn().mockResolvedValue({ id: 'activity-1' });
  const feedbackFindMany = jest.fn().mockResolvedValue([ROW]);
  const feedbackCount = jest.fn().mockResolvedValue(1);
  const feedbackAggregate = jest.fn().mockResolvedValue({
    _count: { _all: 2 },
    _avg: { rating: 3.666 },
  });
  const feedbackGroupBy = jest.fn().mockResolvedValue([
    { rating: 1, _count: { _all: 1 } },
    { rating: 4, _count: { _all: 1 } },
  ]);
  const memberCount = jest.fn().mockResolvedValue(3);
  const prisma = {
    activity: { findFirst: activityFindFirst },
    activityFeedback: {
      findMany: feedbackFindMany,
      count: feedbackCount,
      aggregate: feedbackAggregate,
      groupBy: feedbackGroupBy,
    },
    member: { count: memberCount },
  } as unknown as PrismaService;
  const authzExplain = jest.fn().mockResolvedValue({ allow: true, reason: 'allowed' });
  const authz = { explain: authzExplain } as unknown as AuthzService;
  const rbacCan = jest.fn().mockResolvedValue(false);
  const rbac = { can: rbacCan } as unknown as RbacService;
  return {
    service: new ActivityFeedbacksQueryService(prisma, authz, rbac),
    activityFindFirst,
    feedbackFindMany,
    feedbackCount,
    feedbackAggregate,
    feedbackGroupBy,
    memberCount,
    authzExplain,
    rbacCan,
  };
}

describe('ActivityFeedbacksQueryService Admin read model', () => {
  it('列表固定 3 次业务读，member 摘要随 relation select 批量返回', async () => {
    const { service, activityFindFirst, feedbackFindMany, feedbackCount, authzExplain } =
      makeService();

    await expect(
      service.list('activity-1', { page: 2, pageSize: 10 }, CURRENT_USER),
    ).resolves.toEqual({
      items: [
        {
          memberNo: 'V001',
          displayName: '队员甲',
          rating: 4,
          comment: '很好',
          createdAt: ROW.createdAt,
          updatedAt: ROW.updatedAt,
        },
      ],
      total: 1,
      page: 2,
      pageSize: 10,
    });
    expect(authzExplain).toHaveBeenCalledWith(CURRENT_USER, 'attendance.read.sheet', {
      type: 'activity',
      id: 'activity-1',
    });
    expect(activityFindFirst).toHaveBeenCalledTimes(1);
    expect(feedbackFindMany).toHaveBeenCalledTimes(1);
    expect(feedbackCount).toHaveBeenCalledTimes(1);
    expect(feedbackFindMany).toHaveBeenCalledWith({
      where: { activityId: 'activity-1', deletedAt: null },
      select: {
        rating: true,
        comment: true,
        createdAt: true,
        updatedAt: true,
        member: { select: { memberNo: true, displayName: true } },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      skip: 10,
      take: 10,
    });
  });

  it('汇总固定 4 次业务读，均分两位、五桶补零、并集分母评价率四位', async () => {
    const { service, activityFindFirst, feedbackAggregate, feedbackGroupBy, memberCount } =
      makeService();

    await expect(service.summary('activity-1', CURRENT_USER)).resolves.toEqual({
      count: 2,
      avgRating: 3.67,
      ratingDistribution: [
        { rating: 1, count: 1 },
        { rating: 2, count: 0 },
        { rating: 3, count: 0 },
        { rating: 4, count: 1 },
        { rating: 5, count: 0 },
      ],
      feedbackRate: 0.6667,
    });
    expect(activityFindFirst).toHaveBeenCalledTimes(1);
    expect(feedbackAggregate).toHaveBeenCalledTimes(1);
    expect(feedbackGroupBy).toHaveBeenCalledTimes(1);
    expect(memberCount).toHaveBeenCalledTimes(1);
    expect(memberCount).toHaveBeenCalledWith({
      where: {
        OR: [
          {
            attendanceRecords: {
              some: {
                deletedAt: null,
                sheet: { activityId: 'activity-1', deletedAt: null, statusCode: 'approved' },
              },
            },
          },
          {
            activityFeedbacks: {
              some: { activityId: 'activity-1', deletedAt: null },
            },
          },
        ],
      },
    });
  });

  it('无评价且 approved 分母为 0 时 avgRating=null、feedbackRate=0', async () => {
    const setup = makeService();
    setup.feedbackAggregate.mockResolvedValue({
      _count: { _all: 0 },
      _avg: { rating: null },
    });
    setup.feedbackGroupBy.mockResolvedValue([]);
    setup.memberCount.mockResolvedValue(0);

    await expect(setup.service.summary('activity-1', CURRENT_USER)).resolves.toEqual({
      count: 0,
      avgRating: null,
      ratingDistribution: [
        { rating: 1, count: 0 },
        { rating: 2, count: 0 },
        { rating: 3, count: 0 },
        { rating: 4, count: 0 },
        { rating: 5, count: 0 },
      ],
      feedbackRate: 0,
    });
  });

  it('resource_not_found + 全局持码时回退，真实 Activity 不存在仍返 20001', async () => {
    const setup = makeService();
    setup.authzExplain.mockResolvedValue({ allow: false, reason: 'resource_not_found' });
    setup.rbacCan.mockResolvedValue(true);
    setup.activityFindFirst.mockResolvedValue(null);

    await expect(setup.service.summary('activity-1', CURRENT_USER)).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_NOT_FOUND,
    });
    expect(setup.rbacCan).toHaveBeenCalledWith(CURRENT_USER, 'attendance.read.sheet');
    expect(setup.feedbackAggregate).not.toHaveBeenCalled();
  });

  it('无码拒权时不触发任何业务查询', async () => {
    const setup = makeService();
    setup.authzExplain.mockResolvedValue({ allow: false, reason: 'forbidden' });

    await expect(
      setup.service.list('activity-1', { page: 1, pageSize: 20 }, CURRENT_USER),
    ).rejects.toMatchObject({ biz: BizCode.RBAC_FORBIDDEN });
    expect(setup.activityFindFirst).not.toHaveBeenCalled();
    expect(setup.feedbackFindMany).not.toHaveBeenCalled();
    expect(setup.feedbackCount).not.toHaveBeenCalled();
  });

  it('aggregateForActivity 是 participation-summary 的单查询复用出口', async () => {
    const setup = makeService();

    await expect(setup.service.aggregateForActivity('activity-1')).resolves.toEqual({
      count: 2,
      avgRating: 3.67,
    });
    expect(setup.feedbackAggregate).toHaveBeenCalledTimes(1);
    expect(setup.activityFindFirst).not.toHaveBeenCalled();
    expect(setup.authzExplain).not.toHaveBeenCalled();
  });
});
