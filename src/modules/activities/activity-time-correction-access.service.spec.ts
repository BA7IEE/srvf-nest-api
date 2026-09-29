import { OrganizationStatus, Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { AuthzService } from '../authz/authz.service';
import type { AppIdentityResolver } from '../users/app-identity.resolver';
import type { ActivityTimeSettlementAccessService } from './activity-time-settlement-access.service';
import { ActivityTimeCorrectionAccessService } from './activity-time-correction-access.service';
import type { ActivityResponsibilityPolicy } from './activity-responsibility-policy';

const actor: CurrentUserPayload = {
  id: 'actor',
  username: 'actor',
  role: Role.USER,
  status: UserStatus.ACTIVE,
  memberId: 'member',
};

function fixture() {
  const db = {
    user: { findFirst: jest.fn().mockResolvedValue(actor) },
    activity: { findFirst: jest.fn().mockResolvedValue({ organizationId: 'org' }) },
    organization: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ parentId: 'root', status: OrganizationStatus.ACTIVE }),
    },
    attendanceSettlementVersion: { findFirst: jest.fn().mockResolvedValue({ id: 'base-version' }) },
  };
  const settlement = {
    authorize: jest.fn().mockResolvedValue({ actor, activity: { organizationId: 'org' } }),
  };
  const identities = { resolve: jest.fn().mockResolvedValue({ canUseApp: true }) };
  const authz = {
    getExplicitVisibleOrganizationScope: jest
      .fn()
      .mockResolvedValue({ hasPermission: true, global: true, organizationIds: [] }),
    can: jest.fn().mockResolvedValue(true),
  };
  const responsibility = { assertOwner: jest.fn().mockResolvedValue(undefined) };
  const tx = db as unknown as Prisma.TransactionClient;
  const service = new ActivityTimeCorrectionAccessService(
    settlement as unknown as ActivityTimeSettlementAccessService,
    identities as unknown as AppIdentityResolver,
    authz as unknown as AuthzService,
    responsibility as unknown as ActivityResponsibilityPolicy,
  );
  return { db, tx, settlement, identities, authz, responsibility, service };
}

describe('D7-2 Human fact-correction access', () => {
  it('keeps submit/resubmit on existing owner write grants and adds allocation only for V3', async () => {
    const f = fixture();
    await expect(f.service.authorizeSubmission(f.tx, actor, 'activity', 2)).resolves.toEqual(actor);
    expect(f.settlement.authorize.mock.calls).toEqual([[f.tx, actor, 'activity', 'submit']]);

    f.settlement.authorize.mockClear();
    await expect(f.service.authorizeSubmission(f.tx, actor, 'activity', 3)).resolves.toEqual(actor);
    expect(f.settlement.authorize.mock.calls).toEqual([
      [f.tx, actor, 'activity', 'submit'],
      [f.tx, actor, 'activity', 'allocate'],
    ]);
  });

  it('fails closed for an unknown schema before checking any write grant', async () => {
    const f = fixture();
    await expect(f.service.authorizeSubmission(f.tx, actor, 'activity', 99)).rejects.toThrow(
      new BizException(BizCode.CORRECTION_CHANGE_SET_INVALID),
    );
    expect(f.settlement.authorize).not.toHaveBeenCalled();
  });

  it.each([
    [
      'review',
      (service: ActivityTimeCorrectionAccessService, tx: Prisma.TransactionClient) =>
        service.authorizeReview(tx, actor, 'activity', 'base-version'),
    ],
    [
      'prepare',
      (service: ActivityTimeCorrectionAccessService, tx: Prisma.TransactionClient) =>
        service.authorizePrepare(tx, actor, 'activity', 'base-version'),
    ],
    [
      'commit',
      (service: ActivityTimeCorrectionAccessService, tx: Prisma.TransactionClient) =>
        service.authorizeCommit(tx, actor, 'activity', 'base-version'),
    ],
  ] as const)(
    '%s requires current App admission, a GLOBAL final-review grant, and the exact base version',
    async (_operation, authorize) => {
      const f = fixture();
      await expect(authorize(f.service, f.tx)).resolves.toEqual(actor);
      expect(f.authz.getExplicitVisibleOrganizationScope).toHaveBeenCalledWith(
        actor,
        'activity.settlement-final-review.record',
        f.tx,
      );
      expect(f.authz.can).toHaveBeenCalledWith(
        actor,
        'activity.settlement-final-review.record',
        { type: 'attendance_settlement_version', id: 'base-version' },
        f.tx,
      );
    },
  );

  it('does not treat an organization-scoped or role-only final-review grant as GLOBAL', async () => {
    const f = fixture();
    f.db.user.findFirst.mockResolvedValue({ ...actor, role: Role.SUPER_ADMIN });
    f.authz.getExplicitVisibleOrganizationScope.mockResolvedValue({
      hasPermission: true,
      global: false,
      organizationIds: ['org'],
    });
    await expect(
      f.service.authorizeReview(f.tx, actor, 'activity', 'base-version'),
    ).rejects.toThrow(new BizException(BizCode.RBAC_FORBIDDEN));
    expect(f.authz.can).not.toHaveBeenCalled();
  });

  it('rejects loss of resource-target qualification even with a GLOBAL directory grant', async () => {
    const f = fixture();
    f.authz.can.mockResolvedValue(false);
    await expect(
      f.service.authorizePrepare(f.tx, actor, 'activity', 'base-version'),
    ).rejects.toThrow(new BizException(BizCode.RBAC_FORBIDDEN));
  });

  it('fails closed for a disabled user, invalid App member, missing activity, or wrong base version', async () => {
    const f = fixture();
    f.db.user.findFirst.mockResolvedValue(null);
    await expect(
      f.service.authorizeCommit(f.tx, actor, 'activity', 'base-version'),
    ).rejects.toThrow(new BizException(BizCode.UNAUTHORIZED));

    f.db.user.findFirst.mockResolvedValue(actor);
    f.identities.resolve.mockResolvedValue({ canUseApp: false });
    await expect(
      f.service.authorizeCommit(f.tx, actor, 'activity', 'base-version'),
    ).rejects.toThrow(new BizException(BizCode.FORBIDDEN));

    f.identities.resolve.mockResolvedValue({ canUseApp: true });
    f.db.activity.findFirst.mockResolvedValue(null);
    await expect(
      f.service.authorizeCommit(f.tx, actor, 'activity', 'base-version'),
    ).rejects.toThrow(new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE));

    f.db.activity.findFirst.mockResolvedValue({ organizationId: 'org' });
    f.db.attendanceSettlementVersion.findFirst.mockResolvedValue(null);
    await expect(
      f.service.authorizeCommit(f.tx, actor, 'activity', 'base-version'),
    ).rejects.toThrow(new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE));
  });

  it('delegates read to the existing current reviewed-version visibility surface', async () => {
    const f = fixture();
    await expect(f.service.authorizeRead(f.tx, actor, 'activity', 'base-version')).resolves.toEqual(
      actor,
    );
    expect(f.settlement.authorize).toHaveBeenCalledWith(
      f.tx,
      actor,
      'activity',
      'read',
      'base-version',
    );
  });

  it('lets an owner list every base, but requires a non-owner reviewer to name one exact base', async () => {
    const f = fixture();
    await expect(f.service.authorizeListRead(f.tx, actor, 'activity')).resolves.toEqual({
      actor,
      baseSettlementVersionId: null,
    });

    f.responsibility.assertOwner.mockRejectedValue(new BizException(BizCode.RBAC_FORBIDDEN));
    await expect(f.service.authorizeListRead(f.tx, actor, 'activity')).rejects.toThrow(
      new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE),
    );
    await expect(
      f.service.authorizeListRead(f.tx, actor, 'activity', 'base-version'),
    ).resolves.toEqual({ actor, baseSettlementVersionId: 'base-version' });
  });

  it('rechecks identity on every final action; a replay cannot reuse an earlier grant', async () => {
    const f = fixture();
    await f.service.authorizeCommit(f.tx, actor, 'activity', 'base-version');
    f.db.user.findFirst.mockResolvedValue(null);
    await expect(
      f.service.authorizeCommit(f.tx, actor, 'activity', 'base-version'),
    ).rejects.toThrow(new BizException(BizCode.UNAUTHORIZED));
    expect(f.db.user.findFirst).toHaveBeenCalledTimes(2);
  });
});
