import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { ActivityStatusCommandService } from './activity-status-command.service';

const user: CurrentUserPayload = { id: 'u', username: 'admin', role: Role.ADMIN, status: UserStatus.ACTIVE, memberId: null };
const meta = { requestId: 'request', ip: null, ua: null };
function fixture() {
  const identityCount = jest.fn().mockResolvedValue(0);
  const runCount = jest.fn().mockResolvedValue(0);
  const oldSheet = jest.fn(() => { throw new Error('legacy sheet must not be read'); });
  const oldGps = jest.fn(() => { throw new Error('legacy GPS must not be read'); });
  const tx = {
    activityRegistration: { count: jest.fn().mockResolvedValue(0) },
    activityParticipationIdentity: { count: identityCount },
    attendanceSettlementRun: { count: runCount },
    activityPublishReview: { count: jest.fn().mockResolvedValue(0) },
    attendanceSheet: { count: oldSheet }, activityCheckIn: { count: oldGps },
    activity: { updateMany: jest.fn().mockRejectedValue(new Error('stop before write')) },
  };
  const transaction = jest.fn((run: (client: typeof tx) => unknown) => Promise.resolve(run(tx)));
  const activity = { id: 'a1', statusCode: 'draft' };
  const access = { assertCanOrThrow: jest.fn().mockResolvedValue(undefined),
    lockAndFindManagedActivityOrThrow: jest.fn().mockResolvedValue(activity),
    lockAndFindActivityOrThrow: jest.fn().mockResolvedValue(activity) };
  const service = new ActivityStatusCommandService(
    { $transaction: transaction } as never, {} as never, access as never, {} as never,
    {} as never, {} as never, {} as never, {} as never,
    { activityResponsibilityWorkflow: { enabled: true } } as never,
  );
  return { service, tx, access, identityCount, runCount, oldSheet, oldGps };
}

describe('activity soft delete against v1.1 participation evidence', () => {
  it.each(['rbac', 'managed'] as const)('refuses %s deletion when a permanent identity exists', async (authorization) => {
    const f = fixture();
    f.identityCount.mockResolvedValue(1);
    await expect(f.service.softDelete('a1', user, meta, authorization)).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_PARTICIPATION_EXISTS_DELETE_FORBIDDEN,
    });
    expect(f.tx.activity.updateMany).not.toHaveBeenCalled();
    expect(f.oldSheet).not.toHaveBeenCalled();
    expect(f.oldGps).not.toHaveBeenCalled();
  });

  it.each(['rbac', 'managed'] as const)('refuses %s deletion when a settlement run exists without an identity', async (authorization) => {
    const f = fixture();
    f.runCount.mockResolvedValue(1);
    await expect(f.service.softDelete('a1', user, meta, authorization)).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_PARTICIPATION_EXISTS_DELETE_FORBIDDEN,
    });
    expect(f.tx.activity.updateMany).not.toHaveBeenCalled();
  });

  it('preserves the permission check before any root lock or evidence read', async () => {
    const f = fixture();
    f.access.assertCanOrThrow.mockRejectedValue(new Error('denied'));
    await expect(f.service.softDelete('a1', user, meta)).rejects.toThrow('denied');
    expect(f.access.lockAndFindActivityOrThrow).not.toHaveBeenCalled();
    expect(f.identityCount).not.toHaveBeenCalled();
  });
});
