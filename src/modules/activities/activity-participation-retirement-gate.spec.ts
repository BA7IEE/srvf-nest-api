import { Prisma, Role, UserStatus } from '@prisma/client';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AppConfig } from '../../config/app.config';
import type { PrismaService } from '../../database/prisma.service';
import type { ActivityFeedbacksQueryService } from '../activity-feedbacks/activity-feedbacks-query.service';
import type { AuthzService } from '../authz/authz.service';
import type { RbacService } from '../permissions/rbac.service';
import { ActivityParticipationQueryService } from './activity-participation-query.service';
import type { LedgerQueryService } from './ledger-query.service';
import type { ParticipationTimeTruthQueryService } from './participation-time-truth-query.service';

const user: CurrentUserPayload = {
  id: 'admin',
  username: 'admin',
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  memberId: null,
};

function fixture(enabled: boolean, readonlyMaintenance: boolean) {
  const activity = jest.fn().mockResolvedValue({ id: 'activity-1', statusCode: 'completed' });
  const records = jest.fn().mockRejectedValue(new Error('unexpected old attendance read'));
  const registrations = jest.fn().mockRejectedValue(new Error('unexpected registration read'));
  const official = jest.fn().mockRejectedValue(new Error('unexpected official-time read'));
  const identities = jest.fn().mockResolvedValue([]);
  const queryRaw = jest.fn().mockResolvedValue([
    {
      activityId: 'activity-1',
      currentPostedVersion: null,
      versionId: null,
      expectedCount: null,
      batchId: null,
      resultId: null,
      identityId: null,
      resultCode: null,
      identityActivityId: null,
    },
  ]);
  const tx = {
    activity: { findFirst: activity },
    activityRegistration: { findMany: registrations },
    attendanceRecord: { findMany: records },
    activityParticipationIdentity: { findMany: identities },
    $queryRaw: queryRaw,
  };
  const transaction = jest.fn((run: (client: typeof tx) => unknown) => Promise.resolve(run(tx)));
  const ledger = jest.fn().mockRejectedValue(new Error('unexpected ledger read'));
  const feedback = jest.fn().mockRejectedValue(new Error('unexpected feedback read'));
  const authz = jest.fn().mockResolvedValue({ allow: true, reason: 'allowed' });
  const gate = new ActivityWorkflowGate({
    activityV11Workflow: { enabled, readonlyMaintenance },
  } as AppConfig);
  const service = new ActivityParticipationQueryService(
    {
      activity: { findFirst: activity },
      activityRegistration: { findMany: registrations },
      attendanceRecord: { findMany: records },
      $transaction: transaction,
    } as unknown as PrismaService,
    { explain: authz } as unknown as AuthzService,
    { can: jest.fn().mockResolvedValue(false) } as unknown as RbacService,
    { aggregateForActivity: feedback } as unknown as ActivityFeedbacksQueryService,
    { sumCommittedByMemberForActivities: ledger } as unknown as LedgerQueryService,
    { readOfficialTotalsInTx: official } as unknown as ParticipationTimeTruthQueryService,
    gate,
  );
  return {
    service,
    authz,
    activity,
    records,
    registrations,
    transaction,
    ledger,
    feedback,
    official,
    identities,
    queryRaw,
  };
}

describe('activity participation gate after legacy retirement', () => {
  it.each([false, true])(
    'rejects both reads before their data sources with gate off, readonly=%s',
    async (readonly) => {
      const f = fixture(false, readonly);
      await expect(f.service.reconciliation('activity-1', user)).rejects.toMatchObject({
        biz: BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED,
      });
      await expect(f.service.participationSummary('activity-1', user)).rejects.toMatchObject({
        biz: BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED,
      });
      expect(f.authz).toHaveBeenCalledTimes(4);
      expect(f.records).not.toHaveBeenCalled();
      expect(f.registrations).not.toHaveBeenCalled();
      // Both reads now start a repeatable-read transaction before authorization and gate checks.
      expect(f.transaction).toHaveBeenCalledTimes(2);
      expect(f.queryRaw).not.toHaveBeenCalled();
      expect(f.identities).not.toHaveBeenCalled();
      expect(f.official).not.toHaveBeenCalled();
      expect(f.ledger).not.toHaveBeenCalled();
      expect(f.feedback).not.toHaveBeenCalled();
    },
  );

  it('preserves denial before activity lookup and gate evaluation', async () => {
    const f = fixture(false, false);
    f.authz.mockResolvedValue({ allow: false, reason: 'scope_denied' });
    await expect(f.service.participationSummary('activity-1', user)).rejects.toMatchObject({
      biz: BizCode.RBAC_FORBIDDEN,
    });
    expect(f.activity).not.toHaveBeenCalled();
    expect(f.records).not.toHaveBeenCalled();
  });

  it('preserves activity-not-found and reconciliation status checks before the gate', async () => {
    const f = fixture(false, false);
    f.activity
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'activity-1', statusCode: 'draft' });
    await expect(f.service.participationSummary('missing', user)).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_NOT_FOUND,
    });
    await expect(f.service.reconciliation('activity-1', user)).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_STATUS_INVALID,
    });
    expect(f.records).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'allows the existing read path when enabled, readonly=%s',
    async (readonly) => {
      const f = fixture(true, readonly);
      f.registrations.mockResolvedValue([]);
      f.records.mockResolvedValue([]);
      f.official.mockResolvedValue(null);
      f.ledger.mockResolvedValue([]);
      f.feedback.mockResolvedValue({ count: 0, avgRating: null });
      await expect(f.service.participationSummary('activity-1', user)).resolves.toMatchObject({
        activityId: 'activity-1',
      });
      expect(f.ledger).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps official duration ahead of legacy record hours in reconciliation', async () => {
    const f = fixture(true, true);
    const member = { memberNo: 'M1', realName: '成员', nickname: null };
    f.registrations.mockResolvedValue([{ id: 'r1', memberId: 'm1', statusCode: 'pass', member }]);
    f.records.mockResolvedValue([
      {
        memberId: 'm1',
        serviceHours: new Prisma.Decimal(99),
        sheet: { statusCode: 'approved' },
        member,
      },
    ]);
    f.identities.mockResolvedValue([
      {
        id: 'i1',
        activityId: 'activity-1',
        sessionId: 's1',
        memberId: 'm1',
        registrationId: 'r1',
        currentRevision: 1,
        currentStatusCode: 'pass',
        populationIncluded: true,
        revisions: [{ revision: 1, statusCode: 'pass', sourceCode: 'self' }],
        member,
        registration: { deletedAt: null },
      },
    ]);
    f.queryRaw
      .mockResolvedValueOnce([
        {
          activityId: 'activity-1',
          currentPostedVersion: 1,
          versionId: 'v1',
          expectedCount: 1,
          batchId: 'b1',
          resultId: 'rr1',
          identityId: 'i1',
          resultCode: 'present',
          identityActivityId: 'activity-1',
        },
      ])
      .mockResolvedValueOnce([{ identityId: 'i1', dayCount: 1 }]);
    f.official.mockResolvedValue({
      receipt: {},
      totals: [{ activityId: 'activity-1', memberId: 'm1', eligibleSeconds: 7200 }],
    });
    f.ledger.mockResolvedValue([]);
    const result = await f.service.reconciliation('activity-1', user);
    expect(result.registeredParticipants[0].totalServiceHours).toBe('2');
    expect(result.registeredParticipants[0].recordCount).toBe(1);
    expect(f.ledger).toHaveBeenCalledTimes(1);
    expect(f.records).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', [], '0', '0'],
    [
      'negative',
      [{ activityId: 'activity-1', memberId: 'm1', serviceHours: '-1', creditedPoints: '-0.5' }],
      '-1',
      '-0.5',
    ],
  ])(
    'does not substitute old totals for %s committed ledger',
    async (_case, rows, hours, points) => {
      const f = fixture(true, true);
      f.registrations.mockResolvedValue([{ id: 'r1', memberId: 'm1', statusCode: 'pass' }]);
      f.records.mockResolvedValue([
        {
          memberId: 'm1',
          serviceHours: new Prisma.Decimal(99),
          contributionPoints: new Prisma.Decimal(50),
          sheet: { statusCode: 'approved' },
        },
      ]);
      f.official.mockResolvedValue(null);
      f.ledger.mockResolvedValue(rows);
      f.feedback.mockResolvedValue({ count: 0, avgRating: null });
      const result = await f.service.participationSummary('activity-1', user);
      expect(result.totalServiceHours).toBe(hours);
      expect(result.totalContributionPoints).toBe(points);
      expect(f.records).not.toHaveBeenCalled();
    },
  );
});
