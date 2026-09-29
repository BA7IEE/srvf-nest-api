import { Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PrismaService } from '../../database/prisma.service';
import type { ActivityFeedbacksQueryService } from '../activity-feedbacks/activity-feedbacks-query.service';
import type { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import type { LedgerQueryService } from './ledger-query.service';
import type { AuthzService } from '../authz/authz.service';
import type { RbacService } from '../permissions/rbac.service';
import { ActivityParticipationQueryService } from './activity-participation-query.service';
import type { ParticipationTimeTruthQueryService } from './participation-time-truth-query.service';

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
      $transaction: jest.fn((run: (tx: unknown) => unknown) => run({})),
    } as unknown as PrismaService;
    const authzExplain = jest.fn().mockResolvedValue({ allow: true, reason: 'allowed' });
    const authz = { explain: authzExplain } as unknown as AuthzService;
    const rbac = { can: jest.fn().mockResolvedValue(false) } as unknown as RbacService;
    const feedbackAggregate = jest.fn().mockResolvedValue({ count: 2, avgRating: 4.5 });
    const feedbacks = {
      aggregateForActivity: feedbackAggregate,
    } as unknown as ActivityFeedbacksQueryService;
    // 闸关(默认)下取数逐字不变 —— 故 ledgerQuery 给一个「被调用即失败」的替身:
    // 本用例若哪天走进了账本分支,会当场炸,而不是悄悄换了口径还全绿。
    const ledgerQuery = {
      sumCommittedByMemberForActivities: jest.fn(() => {
        throw new Error('闸关时不应触碰账本读面');
      }),
    } as unknown as LedgerQueryService;
    const gate = {
      participationReadSource: jest.fn().mockReturnValue('approved-attendance'),
    } as unknown as ActivityWorkflowGate;
    const participationTimeTruth = {
      readOfficialTotalsInTx: jest.fn().mockResolvedValue(null),
    } as unknown as ParticipationTimeTruthQueryService;
    const service = new ActivityParticipationQueryService(
      prisma,
      authz,
      rbac,
      feedbacks,
      ledgerQuery,
      participationTimeTruth,
      gate,
    );

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

  it('receipt 存在后只切 eligible 工时与按人精确秒直方图，贡献和参与事实不漂移', async () => {
    const prisma = {
      activity: {
        findFirst: jest.fn().mockResolvedValue({ id: 'activity-1', statusCode: 'completed' }),
      },
      activityRegistration: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'registration-1', memberId: 'member-1', statusCode: 'pass' },
          { id: 'registration-2', memberId: 'member-2', statusCode: 'pass' },
        ]),
      },
      attendanceRecord: {
        findMany: jest.fn().mockResolvedValue([
          {
            memberId: 'member-1',
            serviceHours: new Prisma.Decimal(9),
            contributionPoints: new Prisma.Decimal(1.5),
            sheet: { statusCode: 'approved' },
          },
        ]),
      },
      $transaction: jest.fn((run: (tx: unknown) => unknown) => run({})),
    } as unknown as PrismaService;
    const authz = {
      explain: jest.fn().mockResolvedValue({ allow: true, reason: 'allowed' }),
    } as unknown as AuthzService;
    const participationTimeTruth = {
      readOfficialTotalsInTx: jest.fn().mockResolvedValue({
        receipt: {},
        totals: [
          { activityId: 'activity-1', memberId: 'member-1', eligibleSeconds: 7_199 },
          { activityId: 'activity-1', memberId: 'member-2', eligibleSeconds: 7_200 },
        ],
      }),
    } as unknown as ParticipationTimeTruthQueryService;
    const ledgerQuery = {
      sumCommittedByMemberForActivities: jest.fn().mockResolvedValue([
        {
          activityId: 'activity-1',
          memberId: 'member-1',
          serviceHours: '8',
          creditedPoints: '2',
        },
      ]),
    } as unknown as LedgerQueryService;
    const service = new ActivityParticipationQueryService(
      prisma,
      authz,
      { can: jest.fn() } as unknown as RbacService,
      {
        aggregateForActivity: jest.fn().mockResolvedValue({ count: 3, avgRating: 4 }),
      } as unknown as ActivityFeedbacksQueryService,
      ledgerQuery,
      participationTimeTruth,
      {
        participationReadSource: jest.fn().mockReturnValue('committed-ledger'),
      } as unknown as ActivityWorkflowGate,
    );

    const result = await service.participationSummary('activity-1', CURRENT_USER);

    expect(result.totalServiceHours).toBe('4');
    expect(result.totalContributionPoints).toBe('2');
    expect(result.durationHistogram).toEqual({
      under2Hours: 1,
      from2To4Hours: 1,
      from4To8Hours: 0,
      atLeast8Hours: 0,
    });
    expect(result.registrationCounts.pass).toBe(2);
    expect(result.attendeeCount).toBe(1);
    expect(result.feedback).toEqual({ count: 3, avgRating: 4 });
  });
});
