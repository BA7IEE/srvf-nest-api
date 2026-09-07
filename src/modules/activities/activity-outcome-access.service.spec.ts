import { OrganizationStatus, Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { AuthzService } from '../authz/authz.service';
import { AppIdentityResolver } from '../users/app-identity.resolver';
import { ActivityResponsibilityPolicy } from './activity-responsibility-policy';
import { ActivityOutcomeAccessService } from './activity-outcome-access.service';

describe('C2 outcome current explicit access', () => {
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
      activity: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'activity',
          organizationId: 'organization',
          statusCode: 'published',
          archivedFromStatusCode: null,
          initiatorMemberId: 'member',
        }),
      },
      organization: {
        findFirst: jest.fn().mockResolvedValue({
          parentId: 'root',
          status: OrganizationStatus.ACTIVE,
        }),
      },
    };
    const tx = db as unknown as Prisma.TransactionClient;
    const identities = { resolve: jest.fn().mockResolvedValue({ canUseApp: true }) };
    const authz = {
      getExplicitVisibleOrganizationScope: jest.fn().mockResolvedValue({
        hasPermission: true,
        global: false,
        organizationIds: ['organization'],
      }),
      can: jest.fn().mockResolvedValue(true),
    };
    const responsibility = { assertOwner: jest.fn().mockResolvedValue(undefined) };
    const service = new ActivityOutcomeAccessService(
      identities as unknown as AppIdentityResolver,
      authz as unknown as AuthzService,
      responsibility as unknown as ActivityResponsibilityPolicy,
    );
    const run = () => service.authorize(tx, actor, 'activity', 'activity.outcome.read');
    return { db, tx, identities, authz, responsibility, run };
  }
  const unavailable = new BizException(BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE);

  it('uses refreshed identity and the caller transaction at each owner boundary', async () => {
    const f = fixture();
    await expect(f.run()).resolves.toMatchObject({ actor });
    expect(f.db.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: actor.id, status: UserStatus.ACTIVE, deletedAt: null },
      }),
    );
    expect(f.identities.resolve).toHaveBeenCalledWith(actor, f.tx);
    expect(f.authz.getExplicitVisibleOrganizationScope).toHaveBeenCalledWith(
      actor,
      'activity.outcome.read',
      f.tx,
    );
    expect(f.authz.can).toHaveBeenCalledWith(
      actor,
      'activity.outcome.read',
      { type: 'activity', id: 'activity' },
      f.tx,
    );
    expect(f.responsibility.assertOwner).toHaveBeenCalledWith(f.tx, 'activity', actor);
  });
  it('rejects a disabled or removed user before resource lookup', async () => {
    const f = fixture();
    f.db.user.findFirst.mockResolvedValue(null);
    await expect(f.run()).rejects.toThrow(new BizException(BizCode.UNAUTHORIZED));
    expect(f.db.activity.findFirst).not.toHaveBeenCalled();
  });
  it('requires current App membership', async () => {
    const f = fixture();
    f.identities.resolve.mockResolvedValue({ canUseApp: false });
    await expect(f.run()).rejects.toThrow(new BizException(BizCode.FORBIDDEN));
    expect(f.db.activity.findFirst).not.toHaveBeenCalled();
  });
  it.each([Role.USER, Role.ADMIN, Role.SUPER_ADMIN])(
    'does not bypass explicit grants for %s',
    async (role) => {
      const f = fixture();
      f.db.user.findFirst.mockResolvedValue({ ...actor, role });
      f.authz.getExplicitVisibleOrganizationScope.mockResolvedValue({
        hasPermission: false,
        global: false,
        organizationIds: [],
      });
      await expect(f.run()).rejects.toThrow(unavailable);
      expect(f.responsibility.assertOwner).not.toHaveBeenCalled();
    },
  );
  it('requires the action grant to cover the activity organization', async () => {
    const f = fixture();
    f.authz.getExplicitVisibleOrganizationScope.mockResolvedValue({
      hasPermission: true,
      global: false,
      organizationIds: ['other'],
    });
    await expect(f.run()).rejects.toThrow(unavailable);
  });
  it('keeps resource constraints in addition to explicit organization scope', async () => {
    const f = fixture();
    f.authz.can.mockResolvedValue(false);
    await expect(f.run()).rejects.toThrow(unavailable);
  });
  it.each([
    null,
    { parentId: null, status: OrganizationStatus.ACTIVE },
    { parentId: 'root', status: OrganizationStatus.INACTIVE },
  ])('rejects an ineligible organization %j', async (organization) => {
    const f = fixture();
    f.db.organization.findFirst.mockResolvedValue(organization);
    await expect(f.run()).rejects.toThrow(unavailable);
  });
  it('gives missing and inaccessible activity the same error', async () => {
    const f = fixture();
    f.db.activity.findFirst.mockResolvedValue(null);
    await expect(f.run()).rejects.toThrow(unavailable);
  });
  it.each(['draft', 'archived'])(
    'uses initiator semantics for %s originating in draft',
    async (statusCode) => {
      const f = fixture();
      f.db.activity.findFirst.mockResolvedValue({
        id: 'activity',
        organizationId: 'organization',
        statusCode,
        archivedFromStatusCode: 'draft',
        initiatorMemberId: actor.memberId,
      });
      await f.run();
      expect(f.responsibility.assertOwner).not.toHaveBeenCalled();
      f.db.activity.findFirst.mockResolvedValue({
        id: 'activity',
        organizationId: 'organization',
        statusCode,
        archivedFromStatusCode: 'draft',
        initiatorMemberId: 'other',
      });
      await expect(f.run()).rejects.toThrow(unavailable);
    },
  );
  it.each(['published', 'completed', 'terminated', 'archived'])(
    'requires current owner for %s, not collaborator or legacy initiator',
    async (statusCode) => {
      const f = fixture();
      f.db.activity.findFirst.mockResolvedValue({
        id: 'activity',
        organizationId: 'organization',
        statusCode,
        archivedFromStatusCode: 'published',
        initiatorMemberId: actor.memberId,
      });
      f.responsibility.assertOwner.mockRejectedValue(new BizException(BizCode.FORBIDDEN));
      await expect(f.run()).rejects.toThrow(unavailable);
    },
  );
  it('rechecks revocation on a second call after a lock wait', async () => {
    const f = fixture();
    await f.run();
    f.authz.getExplicitVisibleOrganizationScope.mockResolvedValue({
      hasPermission: false,
      global: false,
      organizationIds: [],
    });
    await expect(f.run()).rejects.toThrow(unavailable);
    expect(f.db.user.findFirst).toHaveBeenCalledTimes(2);
    expect(f.authz.getExplicitVisibleOrganizationScope).toHaveBeenCalledTimes(2);
  });
  it('does not disguise infrastructure failure as denial', async () => {
    const f = fixture();
    const error = new Error('test infrastructure failure');
    f.responsibility.assertOwner.mockRejectedValue(error);
    await expect(f.run()).rejects.toBe(error);
  });
});
