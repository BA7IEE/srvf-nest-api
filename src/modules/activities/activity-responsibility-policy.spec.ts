import { Role, UserStatus, type Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuthzService } from '../authz/authz.service';
import { ActivityResponsibilityPolicy } from './activity-responsibility-policy';

const user = {
  id: 'actor',
  username: 'actor',
  memberId: 'member',
  role: Role.USER,
  status: UserStatus.ACTIVE,
};
function setup() {
  const tx = {
    activity: { findFirst: jest.fn().mockResolvedValue(null) },
    activityResponsibilityAssignment: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const explain = jest
    .fn<Promise<{ allow: boolean; reason?: string }>, Parameters<AuthzService['explain']>>()
    .mockResolvedValue({ allow: true });
  const service = new ActivityResponsibilityPolicy({ explain } as unknown as AuthzService);
  return { tx, client: tx as unknown as Prisma.TransactionClient, service, explain };
}

describe('C1 D2b responsibility permission caller transaction', () => {
  it.each(['assertOwnerOrOverride', 'assertInitiatorOrOverride'] as const)(
    '%s forwards the exact tx through override',
    async (method) => {
      const { service, explain, client } = setup();
      await service[method](client, 'activity', user);
      expect(explain).toHaveBeenCalledWith(
        user,
        'activity-responsibility.override.record',
        { type: 'activity', id: 'activity' },
        client,
      );
    },
  );
  it('active owner retains the existing ownership short circuit', async () => {
    const { service, explain, tx, client } = setup();
    tx.activityResponsibilityAssignment.findFirst.mockResolvedValue({ id: 'assignment' });
    await service.assertOwnerOrOverride(client, 'activity', user);
    expect(explain).not.toHaveBeenCalled();
    expect(tx.activityResponsibilityAssignment.findFirst).toHaveBeenCalledWith({
      where: {
        activityId: 'activity',
        memberId: user.memberId,
        responsibilityType: 'owner',
        status: 'active',
      },
      select: { id: true },
    });
  });
  it('initiator query retains live Activity and exact current member predicates', async () => {
    const { service, explain, tx, client } = setup();
    tx.activity.findFirst.mockResolvedValue({ id: 'activity' });
    await service.assertInitiatorOrOverride(client, 'activity', user);
    expect(explain).not.toHaveBeenCalled();
    expect(tx.activity.findFirst).toHaveBeenCalledWith({
      where: { id: 'activity', initiatorMemberId: 'member', deletedAt: null },
      select: { id: true },
    });
  });
  it.each([
    ['no_permission', BizCode.RBAC_FORBIDDEN],
    ['resource_not_found', BizCode.ACTIVITY_NOT_FOUND],
  ] as const)('retains %s denial mapping', async (reason, biz) => {
    const { service, explain, client } = setup();
    explain.mockResolvedValue({ allow: false, reason });
    await expect(service.assertOwnerOrOverride(client, 'activity', user)).rejects.toMatchObject({
      biz,
    });
  });
  it('no-tx direct override retains default Authz behavior', async () => {
    const { service, explain } = setup();
    await service.assertOverride('activity', user);
    expect(explain.mock.calls[0][3]).toBeUndefined();
  });
  it('a second ownership miss rechecks revoked override instead of retaining the first decision', async () => {
    const { service, explain, client } = setup();
    await service.assertOwnerOrOverride(client, 'activity', user);
    explain.mockResolvedValue({ allow: false, reason: 'no_permission' });
    await expect(service.assertOwnerOrOverride(client, 'activity', user)).rejects.toMatchObject({
      biz: BizCode.RBAC_FORBIDDEN,
    });
    expect(explain).toHaveBeenCalledTimes(2);
  });
});
