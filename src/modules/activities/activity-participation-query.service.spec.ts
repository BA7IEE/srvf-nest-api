import { Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PrismaService } from '../../database/prisma.service';
import type { ActivityFeedbacksQueryService } from '../activity-feedbacks/activity-feedbacks-query.service';
import type { AuthzService } from '../authz/authz.service';
import type { RbacService } from '../permissions/rbac.service';
import { ActivityParticipationQueryService } from './activity-participation-query.service';

const CURRENT_USER: CurrentUserPayload = {
  id: 'admin-1',
  username: 'admin',
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  memberId: null,
};

describe('ActivityParticipationQueryService feedback aggregate integration', () => {
  it('participation-summary 在既有 3 读上只追加 1 次 feedback aggregate', async () => {
    const activityFindFirst = jest
      .fn()
      .mockResolvedValue({ id: 'activity-1', statusCode: 'completed' });
    const registrationFindMany = jest
      .fn()
      .mockResolvedValue([{ id: 'registration-1', memberId: 'member-1', statusCode: 'pass' }]);
    const attendanceFindMany = jest.fn().mockResolvedValue([
      {
        memberId: 'member-1',
        serviceHours: new Prisma.Decimal(2),
        contributionPoints: new Prisma.Decimal(1),
        sheet: { statusCode: 'approved' },
      },
    ]);
    const prisma = {
      activity: { findFirst: activityFindFirst },
      activityRegistration: { findMany: registrationFindMany },
      attendanceRecord: { findMany: attendanceFindMany },
    } as unknown as PrismaService;
    const authzExplain = jest.fn().mockResolvedValue({ allow: true, reason: 'allowed' });
    const authz = { explain: authzExplain } as unknown as AuthzService;
    const rbac = { can: jest.fn().mockResolvedValue(false) } as unknown as RbacService;
    const feedbackAggregate = jest.fn().mockResolvedValue({ count: 2, avgRating: 4.5 });
    const feedbacks = {
      aggregateForActivity: feedbackAggregate,
    } as unknown as ActivityFeedbacksQueryService;
    const service = new ActivityParticipationQueryService(prisma, authz, rbac, feedbacks);

    const result = await service.participationSummary('activity-1', CURRENT_USER);

    expect(result.feedback).toEqual({ count: 2, avgRating: 4.5 });
    expect(result.registrationCounts.pass).toBe(1);
    expect(result.attendeeCount).toBe(1);
    expect(activityFindFirst).toHaveBeenCalledTimes(1);
    expect(registrationFindMany).toHaveBeenCalledTimes(1);
    expect(attendanceFindMany).toHaveBeenCalledTimes(1);
    expect(feedbackAggregate).toHaveBeenCalledTimes(1);
    expect(feedbackAggregate).toHaveBeenCalledWith('activity-1');
  });
});
