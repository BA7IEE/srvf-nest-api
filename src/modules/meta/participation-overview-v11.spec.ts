import { Role, UserStatus } from '@prisma/client';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AppConfig } from '../../config/app.config';
import { ParticipationOverviewQueryService } from './participation-overview-query.service';

const user: CurrentUserPayload = {
  id: 'u',
  username: 'admin',
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  memberId: null,
};
const identity = (activityId: string, id: string, memberId: string) => ({
  id,
  activityId,
  sessionId: 's-' + id,
  memberId,
  registrationId: 'r-' + id,
  currentRevision: 1,
  currentStatusCode: 'pass',
  populationIncluded: true,
  revisions: [{ revision: 1, statusCode: 'pass', sourceCode: 'self' }],
  member: { memberNo: memberId, realName: memberId, nickname: null },
  registration: { deletedAt: null },
});
const result = (activityId: string, id: string, code: string, count: number) => ({
  activityId,
  currentPostedVersion: 2,
  versionId: 'v-' + activityId,
  batchId: 'b-' + activityId,
  expectedCount: count,
  resultId: 'rr-' + id,
  identityId: id,
  resultCode: code,
  identityActivityId: activityId,
});
function fixture() {
  const tx = {
    activity: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'a1', statusCode: 'completed', startAt: new Date('2026-01-31T23:30:00Z') },
        { id: 'a2', statusCode: 'completed', startAt: new Date('2026-02-01T00:30:00Z') },
      ]),
    },
    activityRegistration: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'r-i1', activityId: 'a1', memberId: 'm1', statusCode: 'pass' },
        { id: 'r-i2', activityId: 'a1', memberId: 'm2', statusCode: 'pass' },
        { id: 'r-i3', activityId: 'a1', memberId: 'm3', statusCode: 'pass' },
        { id: 'r-i4', activityId: 'a2', memberId: 'm1', statusCode: 'pass' },
      ]),
    },
    activityParticipationIdentity: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          identity('a1', 'i1', 'm1'),
          identity('a1', 'i2', 'm2'),
          identity('a1', 'i3', 'm3'),
          identity('a2', 'i4', 'm1'),
        ]),
    },
    attendanceRecord: {
      findMany: jest.fn(() => {
        throw new Error('legacy attendance must not be read');
      }),
    },
    $queryRaw: jest
      .fn()
      .mockResolvedValue([
        result('a1', 'i1', 'present', 2),
        result('a1', 'i2', 'absent', 2),
        result('a2', 'i4', 'present', 1),
      ]),
  };
  const transaction = jest.fn((fn: (client: typeof tx) => unknown) => Promise.resolve(fn(tx)));
  const scope = jest
    .fn()
    .mockResolvedValue({ hasPermission: true, global: true, organizationIds: [] });
  const descendants = jest.fn().mockResolvedValue(['org1', 'child', 'other']);
  const ledger = jest.fn().mockResolvedValue([
    { activityId: 'a1', memberId: 'm1', serviceHours: '0', creditedPoints: '0' },
    { activityId: 'a1', memberId: 'm2', serviceHours: '0', creditedPoints: '0' },
    { activityId: 'a2', memberId: 'm1', serviceHours: '2', creditedPoints: '1' },
  ]);
  const official = jest.fn().mockResolvedValue(null);
  const service = new ParticipationOverviewQueryService(
    { $transaction: transaction } as never,
    { getVisibleOrganizationScope: scope } as never,
    { queryDescendantOrgIds: descendants } as never,
    {
      sumCommittedByMemberForActivities: ledger,
      readOfficialParticipationTimeTotalsInTx: official,
    } as never,
    new ActivityWorkflowGate({
      activityV11Workflow: { enabled: true, readonlyMaintenance: true },
    } as AppConfig),
  );
  return { service, tx, transaction, scope, descendants, ledger, official };
}

describe('v1.1 monthly participation overview', () => {
  it('uses the same posted outcome projection per activity and UTC activity-start month', async () => {
    const f = fixture();
    const value = await f.service.getOverview({}, user);
    expect(value.months).toHaveLength(2);
    expect(value.months[0]).toMatchObject({
      month: '2026-01',
      participationCount: 1,
      pendingCount: 1,
      averageAttendanceRate: 0.5,
      noShowRate: 0.5,
      totalServiceHours: '0',
      durationUnknownCount: 0,
      durationHistogram: { under2Hours: 1, from2To4Hours: 0, from4To8Hours: 0, atLeast8Hours: 0 },
    });
    expect(value.months[1]).toMatchObject({
      month: '2026-02',
      participationCount: 1,
      averageAttendanceRate: 1,
      noShowRate: 0,
      totalServiceHours: '2',
      durationHistogram: { under2Hours: 0, from2To4Hours: 1, from4To8Hours: 0, atLeast8Hours: 0 },
    });
    expect(f.tx.attendanceRecord.findMany).not.toHaveBeenCalled();
    expect(f.scope).toHaveBeenNthCalledWith(1, user, 'attendance.read.sheet', f.tx);
    expect(f.ledger).toHaveBeenCalledWith(['a1', 'a2'], f.tx);
    expect(f.official).toHaveBeenCalledWith(f.tx, { activityIds: ['a1', 'a2'] });
    expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
    });
  });

  it('intersects both permissions with requested descendants inside the same snapshot', async () => {
    const f = fixture();
    f.scope
      .mockResolvedValueOnce({
        hasPermission: true,
        global: false,
        organizationIds: ['org1', 'other'],
      })
      .mockResolvedValueOnce({
        hasPermission: true,
        global: false,
        organizationIds: ['org1', 'child'],
      });
    await f.service.getOverview({ organizationId: 'org1', includeDescendants: true }, user);
    expect(f.descendants).toHaveBeenCalledWith('org1', f.tx);
    expect(f.tx.activity.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null, organizationId: { in: ['org1'] } },
      select: { id: true, statusCode: true, startAt: true },
      orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
    });
  });

  it('adds official seconds before rounding monthly hours', async () => {
    const f = fixture();
    f.tx.activity.findMany.mockResolvedValue([
      { id: 'a1', statusCode: 'completed', startAt: new Date('2026-01-01T00:00:00Z') },
      { id: 'a2', statusCode: 'completed', startAt: new Date('2026-01-02T00:00:00Z') },
    ]);
    f.official.mockResolvedValue({
      receipt: {},
      totals: [
        { activityId: 'a1', memberId: 'm1', eligibleSeconds: 17 },
        { activityId: 'a2', memberId: 'm1', eligibleSeconds: 17 },
      ],
    });
    const value = await f.service.getOverview({}, user);
    expect(value.months[0]).toMatchObject({
      totalServiceHours: '0.01',
      durationUnknownCount: 0,
      durationHistogram: { under2Hours: 2 },
    });
  });

  it('reports unknown duration instead of summing a missing source as zero', async () => {
    const f = fixture();
    f.official.mockResolvedValue({ receipt: {}, totals: [] });
    const value = await f.service.getOverview({}, user);
    expect(value.months[0]).toMatchObject({ totalServiceHours: null, durationUnknownCount: 1 });
    expect(value.months[1]).toMatchObject({ totalServiceHours: null, durationUnknownCount: 1 });
  });

  it('denies missing permission before activity reads', async () => {
    const f = fixture();
    f.scope.mockResolvedValue({ hasPermission: false, global: false, organizationIds: [] });
    await expect(f.service.getOverview({}, user)).rejects.toMatchObject({
      biz: BizCode.RBAC_FORBIDDEN,
    });
    expect(f.tx.activity.findMany).not.toHaveBeenCalled();
    expect(f.tx.$queryRaw).not.toHaveBeenCalled();
  });
});
