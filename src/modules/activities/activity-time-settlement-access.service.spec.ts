import { OrganizationStatus, Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { AuthzService } from '../authz/authz.service';
import type { AppIdentityResolver } from '../users/app-identity.resolver';
import type { ActivityResponsibilityPolicy } from './activity-responsibility-policy';
import {
  ActivityTimeSettlementAccessService,
  type TimeSettlementAccess,
} from './activity-time-settlement-access.service';

const actor: CurrentUserPayload = {
  id: 'actor',
  username: 'actor',
  role: Role.USER,
  status: UserStatus.ACTIVE,
  memberId: 'member',
};
const unavailable = new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE);

function fixture() {
  const db = {
    user: { findFirst: jest.fn().mockResolvedValue(actor) },
    activity: { findFirst: jest.fn().mockResolvedValue({ id: 'activity', organizationId: 'org' }) },
    organization: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ parentId: 'root', status: OrganizationStatus.ACTIVE }),
    },
    attendanceSettlementVersion: { findFirst: jest.fn().mockResolvedValue({ id: 'version' }) },
  };
  const identities = { resolve: jest.fn().mockResolvedValue({ canUseApp: true }) };
  const authz = {
    getExplicitVisibleOrganizationScope: jest
      .fn()
      .mockResolvedValue({ hasPermission: true, global: false, organizationIds: ['org'] }),
    can: jest.fn().mockResolvedValue(true),
  };
  const responsibility = { assertOwner: jest.fn().mockResolvedValue(undefined) };
  const tx = db as unknown as Prisma.TransactionClient;
  const service = new ActivityTimeSettlementAccessService(
    identities as unknown as AppIdentityResolver,
    authz as unknown as AuthzService,
    responsibility as unknown as ActivityResponsibilityPolicy,
  );
  const authorize = (mode: TimeSettlementAccess = 'read') =>
    service.authorize(tx, actor, 'activity', mode);
  return { db, tx, identities, authz, responsibility, service, authorize };
}

describe('D4 current identity, explicit grants and actual responsibility', () => {
  it.each<TimeSettlementAccess>(['read', 'allocate', 'prepare', 'submit'])(
    'checks the exact %s grants in the same transaction',
    async (mode) => {
      const f = fixture();
      await expect(f.authorize(mode)).resolves.toMatchObject({ actor });
      const codes = {
        read: ['activity.time-settlement.read'],
        allocate: ['activity.time-allocation.recognize'],
        prepare: ['activity.time-settlement.prepare'],
        submit: ['activity.time-settlement.prepare', 'activity.settlement-submit.record'],
      };
      expect(f.authz.getExplicitVisibleOrganizationScope.mock.calls).toEqual(
        codes[mode].map((code) => [actor, code, f.tx]),
      );
      expect(f.responsibility.assertOwner).toHaveBeenCalledWith(f.tx, 'activity', actor);
    },
  );

  it.each([Role.USER, Role.ADMIN, Role.SUPER_ADMIN])(
    'never replaces an explicit grant with %s',
    async (role) => {
      const f = fixture();
      f.db.user.findFirst.mockResolvedValue({ ...actor, role });
      f.authz.getExplicitVisibleOrganizationScope.mockResolvedValue({
        hasPermission: false,
        global: false,
        organizationIds: [],
      });
      await expect(f.authorize()).rejects.toThrow(unavailable);
      expect(f.responsibility.assertOwner).not.toHaveBeenCalled();
    },
  );

  it('rejects a disabled current user before querying the activity', async () => {
    const f = fixture();
    f.db.user.findFirst.mockResolvedValue(null);
    await expect(f.authorize()).rejects.toThrow(new BizException(BizCode.UNAUTHORIZED));
    expect(f.db.activity.findFirst).not.toHaveBeenCalled();
  });
  it('rejects invalid member admission', async () => {
    const f = fixture();
    f.identities.resolve.mockResolvedValue({ canUseApp: false });
    await expect(f.authorize()).rejects.toThrow(new BizException(BizCode.FORBIDDEN));
  });
  it('makes a missing activity indistinguishable from an inaccessible activity', async () => {
    const f = fixture();
    f.db.activity.findFirst.mockResolvedValue(null);
    await expect(f.authorize()).rejects.toThrow(unavailable);
  });
  it('rejects an unrelated explicit organization scope', async () => {
    const f = fixture();
    f.authz.getExplicitVisibleOrganizationScope.mockResolvedValue({
      hasPermission: true,
      global: false,
      organizationIds: ['other'],
    });
    await expect(f.authorize()).rejects.toThrow(unavailable);
  });
  it('rejects a failed resource constraint', async () => {
    const f = fixture();
    f.authz.can.mockResolvedValue(false);
    await expect(f.authorize()).rejects.toThrow(unavailable);
  });
  it('rejects an inactive activity organization', async () => {
    const f = fixture();
    f.db.organization.findFirst.mockResolvedValue({
      parentId: 'root',
      status: OrganizationStatus.INACTIVE,
    });
    await expect(f.authorize()).rejects.toThrow(unavailable);
  });
  it.each<TimeSettlementAccess>(['allocate', 'prepare', 'submit'])(
    'does not let a reviewer bypass owner qualification on %s',
    async (mode) => {
      const f = fixture();
      f.responsibility.assertOwner.mockRejectedValue(new BizException(BizCode.FORBIDDEN));
      await expect(f.authorize(mode)).rejects.toThrow(unavailable);
      expect(f.db.attendanceSettlementVersion.findFirst).not.toHaveBeenCalled();
    },
  );
  it('allows a currently qualified reviewer only against the actual requested version', async () => {
    const f = fixture();
    f.responsibility.assertOwner.mockRejectedValue(new BizException(BizCode.FORBIDDEN));
    await expect(
      f.service.authorize(f.tx, actor, 'activity', 'read', 'version'),
    ).resolves.toMatchObject({ actor });
    expect(f.db.attendanceSettlementVersion.findFirst).toHaveBeenCalledWith({
      where: { id: 'version', settlementRun: { activityId: 'activity' } },
      orderBy: { version: 'desc' },
      select: { id: true },
    });
    expect(f.authz.can).toHaveBeenCalledWith(
      actor,
      'activity.settlement-first-review.record',
      { type: 'attendance_settlement_version', id: 'version' },
      f.tx,
    );
  });
  it('rejects a read grant with no owner or actual review qualification', async () => {
    const f = fixture();
    f.responsibility.assertOwner.mockRejectedValue(new BizException(BizCode.FORBIDDEN));
    f.authz.can.mockImplementation((_actor: unknown, permission: string) =>
      Promise.resolve(permission === 'activity.time-settlement.read'),
    );
    await expect(f.authorize()).rejects.toThrow(unavailable);
  });
  it('does not let review role labels replace an explicit review grant', async () => {
    const f = fixture();
    f.responsibility.assertOwner.mockRejectedValue(new BizException(BizCode.FORBIDDEN));
    f.authz.getExplicitVisibleOrganizationScope.mockImplementation(
      (_actor: unknown, permission: string) =>
        Promise.resolve({
          hasPermission: permission === 'activity.time-settlement.read',
          global: true,
          organizationIds: [],
        }),
    );
    await expect(f.authorize()).rejects.toThrow(unavailable);
  });
  it('rereads current identity and rejects revocation on the next authorization', async () => {
    const f = fixture();
    await f.authorize('prepare');
    f.db.user.findFirst.mockResolvedValue(null);
    await expect(f.authorize('prepare')).rejects.toThrow(new BizException(BizCode.UNAUTHORIZED));
    expect(f.db.user.findFirst).toHaveBeenCalledTimes(2);
  });
  it('does not conceal unexpected responsibility database failures as a denied role', async () => {
    const f = fixture();
    f.responsibility.assertOwner.mockRejectedValue(new Error('database failure'));
    await expect(f.authorize()).rejects.toThrow('database failure');
  });
});
