import { Role, UserStatus } from '@prisma/client';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AppConfig } from '../../config/app.config';
import { ActivityParticipationQueryService } from './activity-participation-query.service';

const user: CurrentUserPayload = {
  id: 'u1',
  username: 'admin',
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  memberId: null,
};
const row = (id: string, memberId: string, sourceCode = 'self') => ({
  id,
  activityId: 'a1',
  sessionId: 's-' + id,
  memberId,
  registrationId: 'r-' + id,
  currentRevision: 1,
  currentStatusCode: 'pass',
  populationIncluded: true,
  revisions: [{ revision: 1, statusCode: 'pass', sourceCode }],
  member: { memberNo: memberId, realName: memberId, nickname: null },
  registration: { deletedAt: null },
});
const result = (identityId: string, resultCode: string) => ({
  activityId: 'a1',
  currentPostedVersion: 2,
  versionId: 'v2',
  expectedCount: 2,
  batchId: 'b2',
  resultId: 'result-' + identityId,
  identityId,
  resultCode,
  identityActivityId: 'a1',
});
function fixture(readonlyMaintenance = false) {
  const tx = {
    activity: { findFirst: jest.fn().mockResolvedValue({ id: 'a1', statusCode: 'completed' }) },
    activityRegistration: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'r-i1', memberId: 'm1', statusCode: 'pending' },
        { id: 'r-i2', memberId: 'm2', statusCode: 'pass' },
        { id: 'r-i3', memberId: 'm3', statusCode: 'pass' },
        { id: 'r-without-identity', memberId: 'm4', statusCode: 'pass' },
      ]),
    },
    activityParticipationIdentity: {
      findMany: jest
        .fn()
        .mockResolvedValue([row('i1', 'm1', 'onsite'), row('i2', 'm2'), row('i3', 'm3')]),
    },
    attendanceRecord: {
      findMany: jest.fn(() => {
        throw new Error('legacy attendance must not be read');
      }),
    },
    $queryRaw: jest.fn().mockResolvedValue([result('i1', 'present'), result('i2', 'absent')]),
  };
  const transaction = jest.fn((fn: (client: typeof tx) => unknown) => Promise.resolve(fn(tx)));
  const explain = jest.fn().mockResolvedValue({ allow: true, reason: 'allowed' });
  const ledger = jest.fn().mockResolvedValue([
    { activityId: 'a1', memberId: 'm1', serviceHours: '0', creditedPoints: '0' },
    { activityId: 'a1', memberId: 'm2', serviceHours: '0', creditedPoints: '0' },
  ]);
  const official = jest.fn().mockResolvedValue(null);
  const feedback = jest.fn().mockResolvedValue({ count: 2, avgRating: 4 });
  const service = new ActivityParticipationQueryService(
    { $transaction: transaction } as never,
    { explain } as never,
    { can: jest.fn() } as never,
    { aggregateForActivity: feedback } as never,
    { sumCommittedByMemberForActivities: ledger } as never,
    { readOfficialTotalsInTx: official } as never,
    new ActivityWorkflowGate({
      activityV11Workflow: { enabled: true, readonlyMaintenance },
    } as AppConfig),
  );
  return { service, tx, transaction, explain, ledger, official, feedback };
}

describe('activity participation v1.1 summary', () => {
  it.each([false, true])(
    'uses posted outcomes, explicit onsite evidence and one transaction, readonly=%s',
    async (readonly) => {
      const f = fixture(readonly);
      const value = await f.service.participationSummary('a1', user);
      expect(value).toMatchObject({
        attendeeCount: 1,
        registeredAttendeeCount: 0,
        temporaryAttendeeCount: 1,
        noShowCount: 1,
        pendingCount: 2,
        otherResultCount: 0,
        attendanceRate: 0.5,
        totalServiceHours: '0',
        totalContributionPoints: '0',
        durationUnknownCount: 0,
        durationHistogram: { under2Hours: 1, from2To4Hours: 0, from4To8Hours: 0, atLeast8Hours: 0 },
      });
      expect(value.registrationCounts).toMatchObject({ pending: 1, pass: 3 });
      expect(f.tx.attendanceRecord.findMany).not.toHaveBeenCalled();
      expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: 'RepeatableRead',
      });
      expect(f.explain).toHaveBeenCalledTimes(2);
      expect(f.explain).toHaveBeenNthCalledWith(
        1,
        user,
        'attendance.read.sheet',
        { type: 'activity', id: 'a1' },
        f.tx,
      );
      expect(f.ledger).toHaveBeenCalledWith(['a1'], f.tx);
      expect(f.official).toHaveBeenCalledWith(f.tx, { activityIds: ['a1'] });
      expect(f.feedback).toHaveBeenCalledWith('a1', f.tx);
    },
  );

  it('does not infer a duration from a missing selector row and leaves pending out of the rate', async () => {
    const f = fixture();
    f.official.mockResolvedValue({ receipt: {}, totals: [] });
    const value = await f.service.participationSummary('a1', user);
    expect(value.durationUnknownCount).toBe(1);
    expect(value.totalServiceHours).toBeNull();
    expect(value.durationHistogram).toEqual({
      under2Hours: 0,
      from2To4Hours: 0,
      from4To8Hours: 0,
      atLeast8Hours: 0,
    });
    expect(value.attendanceRate).toBe(0.5);
  });

  it('does not mark unposted identities absent or fabricate an attendance rate', async () => {
    const f = fixture();
    f.tx.$queryRaw.mockResolvedValue([
      {
        activityId: 'a1',
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
    const value = await f.service.participationSummary('a1', user);
    expect(value).toMatchObject({
      attendeeCount: 0,
      noShowCount: 0,
      pendingCount: 4,
      attendanceRate: null,
    });
  });

  it('reports a pending second session even when that member already has a present result', async () => {
    const f = fixture();
    f.tx.activityParticipationIdentity.findMany.mockResolvedValue([
      row('i1', 'm1', 'onsite'),
      row('i2', 'm2'),
      row('i3', 'm3'),
      row('i5', 'm1', 'onsite'),
    ]);
    expect(await f.service.participationSummary('a1', user)).toMatchObject({
      attendeeCount: 1,
      pendingCount: 2,
      pendingSessionCount: 2,
    });
  });

  it('retains a posted result despite later soft deletion and exclusion', async () => {
    const f = fixture();
    f.tx.activityParticipationIdentity.findMany.mockResolvedValue([
      {
        ...row('i1', 'm1', 'onsite'),
        populationIncluded: false,
        registration: { deletedAt: new Date() },
      },
      row('i2', 'm2'),
      row('i3', 'm3'),
    ]);
    expect((await f.service.participationSummary('a1', user)).attendeeCount).toBe(1);
  });

  it('rejects a negative net duration for an attendee instead of clamping it or reading old records', async () => {
    const f = fixture();
    f.ledger.mockResolvedValue([
      { activityId: 'a1', memberId: 'm1', serviceHours: '-1', creditedPoints: '-0.5' },
    ]);
    await expect(f.service.participationSummary('a1', user)).rejects.toThrow(RangeError);
    expect(f.tx.attendanceRecord.findMany).not.toHaveBeenCalled();
  });

  it('retains a zero-valued present result when no ledger row exists, reporting unknown time', async () => {
    const f = fixture();
    f.ledger.mockResolvedValue([]);
    const value = await f.service.participationSummary('a1', user);
    expect(value).toMatchObject({
      attendeeCount: 1,
      totalServiceHours: null,
      totalContributionPoints: '0',
      durationUnknownCount: 1,
    });
    expect(f.tx.attendanceRecord.findMany).not.toHaveBeenCalled();
  });

  it('preserves a negative committed contribution without changing attendance', async () => {
    const f = fixture();
    f.ledger.mockResolvedValue([
      { activityId: 'a1', memberId: 'm1', serviceHours: '0', creditedPoints: '-0.5' },
    ]);
    const value = await f.service.participationSummary('a1', user);
    expect(value).toMatchObject({
      attendeeCount: 1,
      totalServiceHours: '0',
      totalContributionPoints: '-0.5',
    });
  });

  it('keeps permission denial ahead of activity and participation data access', async () => {
    const f = fixture();
    f.explain.mockResolvedValue({ allow: false, reason: 'scope_denied' });
    await expect(f.service.participationSummary('a1', user)).rejects.toMatchObject({
      biz: BizCode.RBAC_FORBIDDEN,
    });
    expect(f.tx.activity.findFirst).not.toHaveBeenCalled();
    expect(f.tx.$queryRaw).not.toHaveBeenCalled();
    expect(f.tx.attendanceRecord.findMany).not.toHaveBeenCalled();
  });
});
