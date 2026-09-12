import { OrganizationStatus, Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { AuthzService } from '../authz/authz.service';
import { AppIdentityResolver } from '../users/app-identity.resolver';
import { ActivityResponsibilityPolicy } from './activity-responsibility-policy';
import { ActivityTimeAllocationAccessService } from './activity-time-allocation-access.service';

describe('D3 time-allocation current explicit access', () => {
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
        findFirst: jest
          .fn()
          .mockResolvedValue({ parentId: 'root', status: OrganizationStatus.ACTIVE }),
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
    const service = new ActivityTimeAllocationAccessService(
      identities as unknown as AppIdentityResolver,
      authz as unknown as AuthzService,
      responsibility as unknown as ActivityResponsibilityPolicy,
    );
    return { db, tx, identities, authz, responsibility, service };
  }

  const unavailable = new BizException(BizCode.ACTIVITY_TIME_ALLOCATION_REFERENCE_UNAVAILABLE);
  const authorize = (f: ReturnType<typeof fixture>) =>
    f.service.authorize(f.tx, actor, 'activity', 'activity.time-allocation.recognize');

  it('requires exactly the new explicit grant, resource constraint and current owner', async () => {
    const f = fixture();
    await expect(authorize(f)).resolves.toMatchObject({ actor });
    expect(f.authz.getExplicitVisibleOrganizationScope).toHaveBeenCalledWith(
      actor,
      'activity.time-allocation.recognize',
      f.tx,
    );
    expect(f.authz.can).toHaveBeenCalledWith(
      actor,
      'activity.time-allocation.recognize',
      { type: 'activity', id: 'activity' },
      f.tx,
    );
    expect(f.responsibility.assertOwner).toHaveBeenCalledWith(f.tx, 'activity', actor);
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
      await expect(authorize(f)).rejects.toThrow(unavailable);
      expect(f.responsibility.assertOwner).not.toHaveBeenCalled();
    },
  );

  it('rejects missing/disabled identity before activity lookup and unavailable activity without enumeration', async () => {
    const f = fixture();
    f.db.user.findFirst.mockResolvedValue(null);
    await expect(authorize(f)).rejects.toThrow(new BizException(BizCode.UNAUTHORIZED));
    expect(f.db.activity.findFirst).not.toHaveBeenCalled();

    const next = fixture();
    next.db.activity.findFirst.mockResolvedValue(null);
    await expect(authorize(next)).rejects.toThrow(unavailable);
  });

  it('rejects scope/resource/organization revocation and rechecks it on every call', async () => {
    const f = fixture();
    await authorize(f);
    f.authz.getExplicitVisibleOrganizationScope.mockResolvedValue({
      hasPermission: false,
      global: false,
      organizationIds: [],
    });
    await expect(authorize(f)).rejects.toThrow(unavailable);
    expect(f.db.user.findFirst).toHaveBeenCalledTimes(2);

    const resource = fixture();
    resource.authz.can.mockResolvedValue(false);
    await expect(authorize(resource)).rejects.toThrow(unavailable);

    const organization = fixture();
    organization.db.organization.findFirst.mockResolvedValue({
      parentId: 'root',
      status: OrganizationStatus.INACTIVE,
    });
    await expect(authorize(organization)).rejects.toThrow(unavailable);
  });

  it('uses draft initiator semantics and otherwise keeps owner failure opaque', async () => {
    const draft = fixture();
    draft.db.activity.findFirst.mockResolvedValue({
      id: 'activity',
      organizationId: 'organization',
      statusCode: 'draft',
      archivedFromStatusCode: null,
      initiatorMemberId: 'member',
    });
    await expect(authorize(draft)).resolves.toBeDefined();
    expect(draft.responsibility.assertOwner).not.toHaveBeenCalled();

    const owner = fixture();
    owner.responsibility.assertOwner.mockRejectedValue(new BizException(BizCode.FORBIDDEN));
    await expect(authorize(owner)).rejects.toThrow(unavailable);
  });
});
