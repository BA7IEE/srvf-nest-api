import {
  MemberStatus,
  MembershipStatus,
  OrganizationStatus,
  Role,
  UserStatus,
  type Prisma,
} from '@prisma/client';
import type { PrismaService } from '../../database/prisma.service';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuthzService } from '../authz/authz.service';
import { AppManagedActivitiesService } from './app-managed-activities.service';

const user = {
  id: 'actor',
  username: 'actor',
  memberId: 'member',
  role: Role.USER,
  status: UserStatus.ACTIVE,
};
function setup(useDefault = false) {
  const tx = {
    member: { findFirst: jest.fn().mockResolvedValue({ gradeCode: 'level-1' }) },
    memberOrganizationMembership: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ organizationId: 'org-own', membershipType: 'PRIMARY' }]),
    },
    organization: {
      findMany: jest
        .fn<Promise<{ id: string; name: string }[]>, [Prisma.OrganizationFindManyArgs]>()
        .mockResolvedValue([
          { id: 'org-own', name: '本组织' },
          { id: 'org-granted', name: '授权组织' },
        ]),
    },
    organizationClosure: {
      findMany: jest.fn().mockResolvedValue([
        { descendantId: 'org-own', ancestor: { name: '上级' } },
        { descendantId: 'org-own', ancestor: { name: '本组织' } },
      ]),
    },
  };
  const getVisibleOrganizationScope = jest
    .fn<
      ReturnType<AuthzService['getVisibleOrganizationScope']>,
      Parameters<AuthzService['getVisibleOrganizationScope']>
    >()
    .mockResolvedValue({ hasPermission: true, global: false, organizationIds: ['org-granted'] });
  const forbidden = new Proxy(
    {},
    {
      get: () => {
        throw new Error('default Prisma client escaped caller tx');
      },
    },
  );
  const service = new AppManagedActivitiesService(
    (useDefault ? tx : forbidden) as unknown as PrismaService,
    { getVisibleOrganizationScope } as unknown as AuthzService,
    undefined!,
    undefined!,
    undefined!,
    undefined!,
    undefined!,
    undefined!,
    undefined!,
    undefined!,
  );
  return {
    service,
    tx,
    client: tx as unknown as Prisma.TransactionClient,
    getVisibleOrganizationScope,
  };
}

describe('C1 D2b managed organization options caller transaction', () => {
  it('uses caller delegates for member, membership, organization and path, and forwards tx to scope', async () => {
    const { service, tx, client, getVisibleOrganizationScope } = setup();
    expect(await service.organizationOptions(user, 'member', client)).toEqual([
      {
        organizationId: 'org-own',
        name: '本组织',
        pathLabel: '上级 / 本组织',
        source: 'membership',
        membershipType: 'PRIMARY',
      },
      {
        organizationId: 'org-granted',
        name: '授权组织',
        pathLabel: '授权组织',
        source: 'cross-org-grant',
        membershipType: null,
      },
    ]);
    expect(tx.member.findFirst).toHaveBeenCalledWith({
      where: { id: 'member', status: MemberStatus.ACTIVE, deletedAt: null },
      select: { gradeCode: true },
    });
    expect(tx.memberOrganizationMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          memberId: 'member',
          status: MembershipStatus.ACTIVE,
          deletedAt: null,
          startedAt: { lte: expect.any(Date) as unknown },
          OR: [{ endedAt: null }, { endedAt: { gt: expect.any(Date) as unknown } }],
          organization: {
            status: OrganizationStatus.ACTIVE,
            deletedAt: null,
            parentId: { not: null },
          },
        },
      }),
    );
    expect(tx.organization.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: OrganizationStatus.ACTIVE,
          deletedAt: null,
          parentId: { not: null },
          id: { in: ['org-own', 'org-granted'] },
        },
      }),
    );
    expect(tx.organizationClosure.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { descendantId: { in: ['org-own', 'org-granted'] } } }),
    );
    expect(getVisibleOrganizationScope).toHaveBeenCalledWith(
      user,
      'activity.create.cross-org',
      client,
    );
  });
  it('missing/inactive Member fails before membership or scope reads', async () => {
    const { service, tx, client, getVisibleOrganizationScope } = setup();
    tx.member.findFirst.mockResolvedValue(null);
    await expect(service.organizationOptions(user, 'member', client)).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_INITIATOR_NOT_FORMAL,
    });
    expect(getVisibleOrganizationScope).not.toHaveBeenCalled();
    expect(tx.memberOrganizationMembership.findMany).not.toHaveBeenCalled();
  });
  it('revoked cross-org permission narrows the next ORM query to current memberships', async () => {
    const { service, tx, client, getVisibleOrganizationScope } = setup();
    await service.organizationOptions(user, 'member', client);
    getVisibleOrganizationScope.mockResolvedValue({
      hasPermission: false,
      global: false,
      organizationIds: [],
    });
    await service.organizationOptions(user, 'member', client);
    expect(tx.organization.findMany.mock.calls[1][0].where?.id).toEqual({ in: ['org-own'] });
  });
  it('GLOBAL grants keep active/non-root filters without adding an id restriction', async () => {
    const { service, tx, client, getVisibleOrganizationScope } = setup();
    getVisibleOrganizationScope.mockResolvedValue({
      hasPermission: true,
      global: true,
      organizationIds: [],
    });
    await service.organizationOptions(user, 'member', client);
    expect(tx.organization.findMany.mock.calls[0][0].where).toEqual({
      status: OrganizationStatus.ACTIVE,
      deletedAt: null,
      parentId: { not: null },
    });
  });
  it('omitted tx uses the existing default client without changing the projection', async () => {
    const { service, tx, getVisibleOrganizationScope } = setup(true);
    expect(await service.organizationOptions(user, 'member')).toHaveLength(2);
    expect(tx.member.findFirst).toHaveBeenCalledTimes(1);
    expect(getVisibleOrganizationScope.mock.calls[0][2]).toBeUndefined();
  });
});
