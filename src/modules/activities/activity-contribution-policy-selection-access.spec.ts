import { OrganizationStatus, Role, UserStatus, type Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuthzService } from '../authz/authz.service';
import type { AppIdentityResolver } from '../users/app-identity.resolver';
import type { ActivityInitiationPolicy } from './activity-initiation-policy';
import { ActivityContributionPolicySelectionAccess } from './activity-contribution-policy-selection-access';
import type { ActivityResponsibilityPolicy } from './activity-responsibility-policy';

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
  const service = new ActivityContributionPolicySelectionAccess(
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

describe('E1-3 contribution policy selection explicit access', () => {
  it('requires the current Human identity and exact explicit permission for SUPER_ADMIN', async () => {
    const f = fixture();
    await expect(
      f.service.authorize(
        f.tx,
        requestActor,
        'admin',
        'activity-one',
        'activity.contribution-policy.select',
      ),
    ).resolves.toMatchObject({ actor: currentActor });
    expect(f.authz.getExplicitVisibleOrganizationScope).toHaveBeenCalledWith(
      currentActor,
      'activity.contribution-policy.select',
      f.tx,
    );
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
        'activity.contribution-policy.select',
      ),
    ).rejects.toMatchObject({ biz: BizCode.FORBIDDEN });
  });

  it('re-reads App membership and requires the current draft initiator', async () => {
    const f = fixture();
    await expect(
      f.service.authorize(
        f.tx,
        requestActor,
        'app',
        'activity-one',
        'activity.contribution-policy.read',
      ),
    ).resolves.toMatchObject({ actor: currentActor });
    f.identities.resolve.mockResolvedValueOnce({ canUseApp: false });
    await expect(f.service.current(f.tx, requestActor, 'app')).rejects.toMatchObject({
      biz: BizCode.FORBIDDEN,
    });
    f.db.activity.findFirst.mockResolvedValue({
      id: 'activity-one',
      organizationId: 'organization-one',
      statusCode: 'draft',
      archivedFromStatusCode: null,
      initiatorMemberId: 'another-member',
    });
    await expect(
      f.service.authorize(
        f.tx,
        requestActor,
        'app',
        'activity-one',
        'activity.contribution-policy.read',
      ),
    ).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REFERENCE_UNAVAILABLE,
    });
  });

  it('keeps scope, resource authorization, organization eligibility and initiation conjunctive', async () => {
    const f = fixture();
    f.authz.can.mockResolvedValue(false);
    await expect(
      f.service.authorizeOptions(f.tx, requestActor, 'organization-one'),
    ).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REFERENCE_UNAVAILABLE,
    });
    f.authz.can.mockResolvedValue(true);
    f.initiation.resolveInitiator.mockRejectedValueOnce(new Error('not eligible'));
    await expect(
      f.service.authorizeOptions(f.tx, requestActor, 'organization-one'),
    ).rejects.toThrow('not eligible');
  });

  it('allows standalone writes only for draft activities without a pending review', async () => {
    const f = fixture();
    await expect(f.service.assertStandaloneWritable(f.tx, 'activity-one')).resolves.toBeUndefined();
    f.db.activityPublishReview.findFirst.mockResolvedValue({ id: 'review-one' });
    await expect(f.service.assertStandaloneWritable(f.tx, 'activity-one')).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REFERENCE_UNAVAILABLE,
    });
  });
});
