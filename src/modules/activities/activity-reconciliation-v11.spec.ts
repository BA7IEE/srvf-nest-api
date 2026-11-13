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
const member = (id: string) => ({ memberNo: id, realName: id, nickname: null });
const identity = (id: string, memberId: string, sourceCode = 'self') => ({
  id,
  activityId: 'a1',
  sessionId: 's-' + id,
  memberId,
  registrationId: 'r-' + id,
  currentRevision: 1,
  currentStatusCode: 'pass',
  populationIncluded: true,
  revisions: [{ revision: 1, statusCode: 'pass', sourceCode }],
  member: member(memberId),
  registration: { deletedAt: null },
});
const result = (id: string, code: string) => ({
  activityId: 'a1',
  currentPostedVersion: 2,
  versionId: 'v2',
  expectedCount: 2,
  batchId: 'b2',
  resultId: 'rr-' + id,
  identityId: id,
  resultCode: code,
  identityActivityId: 'a1',
});

function fixture(enabled = true, readonlyMaintenance = false) {
  const tx = {
    activity: { findFirst: jest.fn().mockResolvedValue({ id: 'a1', statusCode: 'completed' }) },
    activityRegistration: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'r-i1', memberId: 'm1', statusCode: 'pending', member: member('m1') },
        { id: 'r-i2', memberId: 'm2', statusCode: 'pass', member: member('m2') },
        { id: 'r-i3', memberId: 'm3', statusCode: 'pass', member: member('m3') },
        { id: 'r-i4', memberId: 'm4', statusCode: 'pass', member: member('m4') },
      ]),
    },
    activityParticipationIdentity: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          identity('i1', 'm1', 'onsite'),
          identity('i2', 'm2'),
          identity('i3', 'm3'),
        ]),
    },
    attendanceRecord: {
      findMany: jest.fn(() => {
        throw new Error('legacy attendance must not be read');
      }),
    },
    $queryRaw: jest
      .fn()
      .mockResolvedValueOnce([result('i1', 'present'), result('i2', 'absent')])
      .mockResolvedValueOnce([
        { identityId: 'i1', dayCount: 2 },
        { identityId: 'i2', dayCount: 1 },
      ]),
  };
  const transaction = jest.fn((run: (client: typeof tx) => unknown) => Promise.resolve(run(tx)));
  const explain = jest.fn().mockResolvedValue({ allow: true, reason: 'allowed' });
  const ledger = jest.fn().mockResolvedValue([
    { activityId: 'a1', memberId: 'm1', serviceHours: '9', creditedPoints: '0' },
    { activityId: 'a1', memberId: 'm2', serviceHours: '0', creditedPoints: '0' },
  ]);
  const official = jest.fn().mockResolvedValue({
    receipt: {},
    totals: [{ activityId: 'a1', memberId: 'm1', eligibleSeconds: 7200 }],
  });
  const service = new ActivityParticipationQueryService(
    { $transaction: transaction } as never,
    { explain } as never,
    { can: jest.fn() } as never,
    {} as never,
    { sumCommittedByMemberForActivities: ledger } as never,
    { readOfficialTotalsInTx: official } as never,
    new ActivityWorkflowGate({
      activityV11Workflow: { enabled, readonlyMaintenance },
    } as AppConfig),
  );
  return { service, tx, transaction, explain, ledger, official };
}

describe('activity reconciliation from v1.1 facts', () => {
  it('reports posted outcomes, zero-valued onsite participation, pending identities and known current day counts', async () => {
    const f = fixture();
    const value = await f.service.reconciliation('a1', user);
    expect(value).toMatchObject({
      passRegistrationCount: 3,
      attendedCount: 1,
      noShowCount: 1,
      pendingCount: 2,
      otherResultCount: 0,
    });
    expect(value.temporaryParticipants).toHaveLength(1);
    expect(value.temporaryParticipants[0]).toMatchObject({
      memberId: 'm1',
      outcome: 'attended',
      origin: 'onsite',
      recordCount: 2,
      postedResultCount: 1,
      totalServiceHours: '2',
      sessions: [{ identityId: 'i1', resultCode: 'present', ledgerDayCount: 2 }],
    });
    expect(value.registeredParticipants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberId: 'm2',
          outcome: 'no-show',
          totalServiceHours: null,
          recordCount: 1,
        }),
        expect.objectContaining({ memberId: 'm3', outcome: 'pending', totalServiceHours: null }),
      ]),
    );
    expect(value.unclassifiedParticipants).toEqual([
      expect.objectContaining({
        memberId: 'm4',
        origin: 'unknown',
        outcome: 'pending',
        sessions: [],
      }),
    ]);
    expect(f.tx.attendanceRecord.findMany).not.toHaveBeenCalled();
    expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
    });
    expect(f.explain).toHaveBeenNthCalledWith(
      1,
      user,
      'attendance.read.sheet',
      { type: 'activity', id: 'a1' },
      f.tx,
    );
    expect(f.ledger).toHaveBeenCalledWith(['a1'], f.tx);
    expect(f.official).toHaveBeenCalledWith(f.tx, { activityIds: ['a1'] });
  });

  it.each([false, true])(
    'refuses a disabled v1.1 read before data sources, readonly=%s',
    async (readonly) => {
      const f = fixture(false, readonly);
      await expect(f.service.reconciliation('a1', user)).rejects.toMatchObject({
        biz: BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED,
      });
      expect(f.tx.$queryRaw).not.toHaveBeenCalled();
      expect(f.tx.attendanceRecord.findMany).not.toHaveBeenCalled();
    },
  );

  it('preserves access and activity-status checks before participation data', async () => {
    const f = fixture();
    f.explain.mockResolvedValue({ allow: false, reason: 'scope_denied' });
    await expect(f.service.reconciliation('a1', user)).rejects.toMatchObject({
      biz: BizCode.RBAC_FORBIDDEN,
    });
    expect(f.tx.activity.findFirst).not.toHaveBeenCalled();
    expect(f.tx.$queryRaw).not.toHaveBeenCalled();
    const g = fixture();
    g.tx.activity.findFirst.mockResolvedValue({ id: 'a1', statusCode: 'draft' });
    await expect(g.service.reconciliation('a1', user)).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_STATUS_INVALID,
    });
    expect(g.tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('deduplicates a person across sessions while preserving each posted day count', async () => {
    const f = fixture();
    f.tx.activityParticipationIdentity.findMany.mockResolvedValue([
      identity('i1', 'm1', 'onsite'),
      identity('i2', 'm2'),
      identity('i3', 'm3'),
      { ...identity('i5', 'm1', 'onsite'), registrationId: 'r-i1' },
    ]);
    f.tx.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([
        { ...result('i1', 'present'), expectedCount: 3 },
        { ...result('i2', 'absent'), expectedCount: 3 },
        { ...result('i5', 'present'), expectedCount: 3 },
      ])
      .mockResolvedValueOnce([
        { identityId: 'i1', dayCount: 2 },
        { identityId: 'i2', dayCount: 1 },
        { identityId: 'i5', dayCount: 1 },
      ]);
    const value = await f.service.reconciliation('a1', user);
    expect(value.attendedCount).toBe(1);
    expect(value.temporaryParticipants[0]).toMatchObject({
      memberId: 'm1',
      recordCount: 3,
      postedResultCount: 2,
    });
    expect(value.temporaryParticipants[0].sessions).toHaveLength(2);
  });

  it('fails instead of attaching a day count to an unknown or unposted identity', async () => {
    const f = fixture();
    f.tx.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([result('i1', 'present'), result('i2', 'absent')])
      .mockResolvedValueOnce([{ identityId: 'i3', dayCount: 1 }]);
    await expect(f.service.reconciliation('a1', user)).rejects.toThrow(
      'invalid current participation day count',
    );
    expect(f.tx.attendanceRecord.findMany).not.toHaveBeenCalled();
  });
});
