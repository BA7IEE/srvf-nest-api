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

const identity = (id: string, memberId: string) => ({
  id,
  activityId: 'activity-1',
  sessionId: 'session-' + id,
  memberId,
  registrationId: 'registration-' + id,
  currentRevision: 1,
  currentStatusCode: 'pass',
  populationIncluded: true,
  revisions: [{ revision: 1, statusCode: 'pass', sourceCode: 'self' }],
  registration: { deletedAt: null },
  member: { memberNo: memberId, realName: memberId, nickname: null },
});
const posted = (id: string, resultCode: string, expectedCount: number) => ({
  activityId: 'activity-1',
  currentPostedVersion: 1,
  versionId: 'version-1',
  expectedCount,
  batchId: 'batch-1',
  resultId: 'result-' + id,
  identityId: id,
  resultCode,
  identityActivityId: 'activity-1',
});

describe('ActivityParticipationQueryService feedback aggregate integration', () => {
  it('participation-summary 在同一事务调用一次 feedback aggregate，旧考勤不再参与', async () => {
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
    const tx = {
      activity: { findFirst: activityFindFirst },
      activityRegistration: { findMany: registrationFindMany },
      attendanceRecord: { findMany: attendanceFindMany },
      activityParticipationIdentity: {
        findMany: jest.fn().mockResolvedValue([identity('1', 'member-1')]),
      },
      $queryRaw: jest.fn().mockResolvedValue([posted('1', 'present', 1)]),
    };
    const prisma = {
      ...tx,
      $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)),
    } as unknown as PrismaService;
    const authzExplain = jest.fn().mockResolvedValue({ allow: true, reason: 'allowed' });
    const authz = { explain: authzExplain } as unknown as AuthzService;
    const rbac = { can: jest.fn().mockResolvedValue(false) } as unknown as RbacService;
    const feedbackAggregate = jest.fn().mockResolvedValue({ count: 2, avgRating: 4.5 });
    const feedbacks = {
      aggregateForActivity: feedbackAggregate,
    } as unknown as ActivityFeedbacksQueryService;
    // 闸关不再回退旧结算；闸开时工时与贡献取 committed 账本。
    const ledgerQuery = {
      sumCommittedByMemberForActivities: jest.fn().mockResolvedValue([
        {
          activityId: 'activity-1',
          memberId: 'member-1',
          serviceHours: '3',
          creditedPoints: '2',
        },
      ]),
    } as unknown as LedgerQueryService;
    const gate = {
      participationReadSource: jest.fn().mockReturnValue('committed-ledger'),
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
    expect(result.totalServiceHours).toBe('3');
    expect(result.totalContributionPoints).toBe('2');
    expect(activityFindFirst).toHaveBeenCalledTimes(1);
    expect(registrationFindMany).toHaveBeenCalledTimes(1);
    expect(attendanceFindMany).not.toHaveBeenCalled();
    expect(feedbackAggregate).toHaveBeenCalledTimes(1);
    expect(feedbackAggregate).toHaveBeenCalledWith('activity-1', tx);
  });

  it('receipt 后使用 eligible 精确秒，只对正式到场成员计直方图', async () => {
    const tx = {
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
      activityParticipationIdentity: {
        findMany: jest
          .fn()
          .mockResolvedValue([identity('1', 'member-1'), identity('2', 'member-2')]),
      },
      $queryRaw: jest.fn().mockResolvedValue([posted('1', 'present', 2), posted('2', 'absent', 2)]),
    };
    const prisma = {
      ...tx,
      $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)),
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
      from2To4Hours: 0,
      from4To8Hours: 0,
      atLeast8Hours: 0,
    });
    expect(result.registrationCounts.pass).toBe(2);
    expect(result.attendeeCount).toBe(1);
    expect(result.noShowCount).toBe(1);
    expect(tx.attendanceRecord.findMany).not.toHaveBeenCalled();
    expect(result.feedback).toEqual({ count: 3, avgRating: 4 });
  });
});
