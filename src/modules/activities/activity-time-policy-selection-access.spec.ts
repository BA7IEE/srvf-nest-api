import { OrganizationStatus, Role, UserStatus, type Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { AuthzService } from '../authz/authz.service';
import type { AppIdentityResolver } from '../users/app-identity.resolver';
import type { ActivityInitiationPolicy } from './activity-initiation-policy';
import type { ActivityResponsibilityPolicy } from './activity-responsibility-policy';
import { ActivityTimePolicySelectionAccess } from './activity-time-policy-selection-access';

const requestActor: CurrentUserPayload = {
  id: 'actor-one',
  username: 'request-actor',
  role: Role.SUPER_ADMIN,
  status: UserStatus.ACTIVE,
  memberId: 'old-member',
};
const currentActor: CurrentUserPayload = {
  ...requestActor,
  username: 'current-actor',
  memberId: 'member-one',
};

function fixture() {
  const db = {
    user: { findFirst: jest.fn().mockResolvedValue(currentActor) },
    activity: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'activity-one',
        organizationId: 'organization-one',
        statusCode: 'draft',
        archivedFromStatusCode: null,
        initiatorMemberId: currentActor.memberId,
      }),
    },
    organization: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ parentId: 'root-organization', status: OrganizationStatus.ACTIVE }),
    },
    activityPublishReview: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const identities = { resolve: jest.fn().mockResolvedValue({ canUseApp: true }) };
  const authz = {
    getExplicitVisibleOrganizationScope: jest.fn().mockResolvedValue({
      hasPermission: true,
      global: false,
      organizationIds: ['organization-one'],
    }),
    can: jest.fn().mockResolvedValue(true),
  };
  const initiation = { resolveInitiator: jest.fn().mockResolvedValue('member-one') };
  const responsibility = { assertOwner: jest.fn().mockResolvedValue(undefined) };
  const service = new ActivityTimePolicySelectionAccess(
    identities as unknown as AppIdentityResolver,
    authz as unknown as AuthzService,
    initiation as unknown as ActivityInitiationPolicy,
    responsibility as unknown as ActivityResponsibilityPolicy,
  );
  return {
    db,
    tx: db as unknown as Prisma.TransactionClient,
    identities,
    authz,
    initiation,
    responsibility,
    service,
  };
}

describe('D1-3 time policy selection explicit access', () => {
  it('uses the current identity and exact explicit select grant even for SUPER_ADMIN', async () => {
    const f = fixture();
    await expect(
      f.service.authorize(
        f.tx,
        requestActor,
        'admin',
        'activity-one',
        'activity.time-policy.select',
      ),
    ).resolves.toMatchObject({ actor: currentActor });
    expect(f.authz.getExplicitVisibleOrganizationScope).toHaveBeenCalledWith(
      currentActor,
      'activity.time-policy.select',
      f.tx,
    );
    expect(f.authz.can).toHaveBeenCalledWith(
      currentActor,
      'activity.time-policy.select',
      { type: 'activity', id: 'activity-one' },
      f.tx,
    );
    expect(f.db.user.findFirst).toHaveBeenCalledWith({
      where: { id: requestActor.id, status: UserStatus.ACTIVE, deletedAt: null },
      select: { id: true, username: true, role: true, status: true, memberId: true },
    });

    f.authz.getExplicitVisibleOrganizationScope.mockResolvedValue({
      hasPermission: false,
      global: true,
      organizationIds: [],
    });
    await expect(
      f.service.authorize(
        f.tx,
        requestActor,
        'admin',
        'activity-one',
        'activity.time-policy.select',
      ),
    ).rejects.toMatchObject({ biz: BizCode.FORBIDDEN });
    expect(f.authz.can).toHaveBeenCalledTimes(1);
  });

  it('does not cache identity across lock boundaries and requires current App membership', async () => {
    const f = fixture();
    await expect(f.service.current(f.tx, requestActor, 'app')).resolves.toEqual(currentActor);
    f.db.user.findFirst.mockResolvedValueOnce(null);
    await expect(f.service.current(f.tx, requestActor, 'app')).rejects.toMatchObject({
      biz: BizCode.UNAUTHORIZED,
    });
    expect(f.identities.resolve).toHaveBeenCalledTimes(1);

    const g = fixture();
    g.identities.resolve.mockResolvedValue({ canUseApp: false });
    await expect(
      g.service.authorize(g.tx, requestActor, 'app', 'activity-one', 'activity.time-policy.read'),
    ).rejects.toMatchObject({ biz: BizCode.FORBIDDEN });
    expect(g.db.activity.findFirst).not.toHaveBeenCalled();
  });

  it('keeps organization scope, resource constraint, eligibility and App responsibility conjunctive', async () => {
    const f = fixture();
    f.authz.getExplicitVisibleOrganizationScope.mockResolvedValue({
      hasPermission: true,
      global: false,
      organizationIds: ['other-organization'],
    });
    await expect(
      f.service.authorize(f.tx, requestActor, 'admin', 'activity-one', 'activity.time-policy.read'),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TIME_POLICY_SELECTION_REFERENCE_UNAVAILABLE });

    f.authz.getExplicitVisibleOrganizationScope.mockResolvedValue({
      hasPermission: true,
      global: false,
      organizationIds: ['organization-one'],
    });
    f.authz.can.mockResolvedValue(false);
    await expect(
      f.service.authorize(f.tx, requestActor, 'admin', 'activity-one', 'activity.time-policy.read'),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TIME_POLICY_SELECTION_REFERENCE_UNAVAILABLE });

    f.authz.can.mockResolvedValue(true);
    f.db.organization.findFirst.mockResolvedValue({
      parentId: null,
      status: OrganizationStatus.ACTIVE,
    });
    await expect(
      f.service.authorize(f.tx, requestActor, 'admin', 'activity-one', 'activity.time-policy.read'),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TIME_POLICY_SELECTION_REFERENCE_UNAVAILABLE });

    f.db.organization.findFirst.mockResolvedValue({
      parentId: 'root-organization',
      status: OrganizationStatus.ACTIVE,
    });
    f.db.activity.findFirst.mockResolvedValue({
      id: 'activity-one',
      organizationId: 'organization-one',
      statusCode: 'published',
      archivedFromStatusCode: null,
      initiatorMemberId: 'someone-else',
    });
    await f.service.authorize(
      f.tx,
      requestActor,
      'app',
      'activity-one',
      'activity.time-policy.read',
    );
    expect(f.responsibility.assertOwner).toHaveBeenCalledWith(f.tx, 'activity-one', currentActor);
  });

  it('uses draft initiator ownership and translates only ordinary policy denials', async () => {
    const f = fixture();
    f.db.activity.findFirst.mockResolvedValue({
      id: 'activity-one',
      organizationId: 'organization-one',
      statusCode: 'draft',
      archivedFromStatusCode: null,
      initiatorMemberId: 'other-member',
    });
    await expect(
      f.service.authorize(f.tx, requestActor, 'app', 'activity-one', 'activity.time-policy.read'),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TIME_POLICY_SELECTION_REFERENCE_UNAVAILABLE });
    expect(f.responsibility.assertOwner).not.toHaveBeenCalled();

    f.db.activity.findFirst.mockResolvedValue({
      id: 'activity-one',
      organizationId: 'organization-one',
      statusCode: 'published',
      archivedFromStatusCode: null,
      initiatorMemberId: 'other-member',
    });
    f.responsibility.assertOwner.mockRejectedValue(new BizException(BizCode.FORBIDDEN));
    await expect(
      f.service.authorize(f.tx, requestActor, 'app', 'activity-one', 'activity.time-policy.read'),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TIME_POLICY_SELECTION_REFERENCE_UNAVAILABLE });

    const infrastructureFailure = new Error('database unavailable');
    f.responsibility.assertOwner.mockRejectedValue(infrastructureFailure);
    await expect(
      f.service.authorize(f.tx, requestActor, 'app', 'activity-one', 'activity.time-policy.read'),
    ).rejects.toBe(infrastructureFailure);
  });

  it('uses the separately granted read/select creation routes without borrowing activity permissions', async () => {
    const f = fixture();
    await f.service.authorizeOptions(f.tx, requestActor, 'organization-one');
    expect(f.authz.getExplicitVisibleOrganizationScope).toHaveBeenLastCalledWith(
      currentActor,
      'activity.time-policy.read',
      f.tx,
    );
    expect(f.authz.can).toHaveBeenLastCalledWith(
      currentActor,
      'activity.time-policy.read',
      { type: 'organization', id: 'organization-one' },
      f.tx,
    );
    expect(f.initiation.resolveInitiator).toHaveBeenCalledWith(
      currentActor,
      'organization-one',
      undefined,
      f.tx,
    );

    await f.service.authorizeCreation(f.tx, requestActor, 'app', 'organization-one', 'member-one');
    expect(f.authz.getExplicitVisibleOrganizationScope).toHaveBeenLastCalledWith(
      currentActor,
      'activity.time-policy.select',
      f.tx,
    );
    expect(f.authz.can).toHaveBeenLastCalledWith(
      currentActor,
      'activity.time-policy.select',
      { type: 'organization', id: 'organization-one' },
      f.tx,
    );
    expect(f.initiation.resolveInitiator).toHaveBeenLastCalledWith(
      currentActor,
      'organization-one',
      'member-one',
      f.tx,
    );
  });

  it('allows standalone writes only in draft with no pending review', async () => {
    const f = fixture();
    await expect(f.service.assertStandaloneWritable(f.tx, 'activity-one')).resolves.toBeUndefined();
    f.db.activityPublishReview.findFirst.mockResolvedValue({ id: 'pending-review' });
    await expect(f.service.assertStandaloneWritable(f.tx, 'activity-one')).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_TIME_POLICY_SELECTION_REFERENCE_UNAVAILABLE,
    });
    f.db.activity.findFirst.mockResolvedValue({ statusCode: 'published' });
    await expect(f.service.assertStandaloneWritable(f.tx, 'activity-one')).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_TIME_POLICY_SELECTION_REFERENCE_UNAVAILABLE,
    });
  });
});
