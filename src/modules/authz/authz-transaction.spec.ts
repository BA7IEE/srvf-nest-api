import { ConfigService } from '@nestjs/config';
import {
  AssignmentStatus,
  BindingScopeType,
  BindingStatus,
  OrganizationStatus,
  PolicyScopeMode,
  PolicyStatus,
  PrincipalType,
  Role,
  SupervisionScopeMode,
  SupervisionStatus,
  UserStatus,
  type Prisma,
} from '@prisma/client';
import type { PrismaService } from '../../database/prisma.service';
import { RbacService } from '../permissions/rbac.service';
import { AuthzService } from './authz.service';
import { ResourceResolverService } from './resource-resolver.service';

const user = {
  id: 'actor',
  username: 'actor',
  role: Role.USER,
  status: UserStatus.ACTIVE,
  memberId: 'member',
};
const start = new Date('2020-01-01');
function setup() {
  const never = new Proxy(
    {},
    {
      get: () => {
        throw new Error('default DB client used in caller transaction');
      },
    },
  ) as PrismaService;
  const tx = {
    activity: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: 'activity', organizationId: 'org', statusCode: 'draft' }),
    },
    organizationClosure: { findMany: jest.fn().mockResolvedValue([{ ancestorId: 'org' }]) },
    organization: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'org', status: OrganizationStatus.ACTIVE, deletedAt: null }]),
    },
    organizationPositionAssignment: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'assignment',
          positionId: 'position',
          organizationId: 'org',
          status: AssignmentStatus.ACTIVE,
          startedAt: start,
          endedAt: null,
        },
      ]),
    },
    organizationPositionRolePolicy: {
      findMany: jest.fn().mockResolvedValue([
        {
          positionId: 'position',
          roleId: 'position-role',
          role: { code: 'position-role' },
          scopeMode: PolicyScopeMode.TREE,
          conditionJson: null,
          status: PolicyStatus.ACTIVE,
        },
      ]),
    },
    organizationSupervisionAssignment: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'supervision',
          organizationId: 'org',
          scopeMode: SupervisionScopeMode.TREE,
          status: SupervisionStatus.ACTIVE,
          startedAt: start,
          endedAt: null,
        },
      ]),
    },
    rbacRole: {
      findFirst: jest.fn().mockResolvedValue({ id: 'supervisor-role', code: 'org-supervisor' }),
    },
    roleBinding: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'binding',
          roleId: 'direct-role',
          role: { code: 'direct-role' },
          principalType: PrincipalType.USER,
          principalId: user.id,
          scopeType: BindingScopeType.ORGANIZATION_TREE,
          scopeOrgId: 'org',
          scopeActivityId: null,
          scopeResourceType: null,
          scopeResourceId: null,
          status: BindingStatus.ACTIVE,
          startedAt: start,
          endedAt: null,
        },
      ]),
    },
    rolePermission: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { roleId: 'direct-role' },
          { roleId: 'position-role' },
          { roleId: 'supervisor-role' },
        ]),
    },
  };
  const client = tx as unknown as Prisma.TransactionClient;
  const rbac = new RbacService(never);
  const service = new AuthzService(never, rbac, new ResourceResolverService(never), {
    get: () => ({ attendance: { allowSameReviewer: false } }),
  } as unknown as ConfigService);
  return { service, tx, client, rbac };
}

describe('C1 D2b explicit Authz transaction closure', () => {
  it.each(['role_binding', 'position', 'supervision'] as const)(
    'resolves %s from caller delegates, including role and organization checks',
    async (source) => {
      const { service, tx, client } = setup();
      if (source !== 'role_binding') tx.roleBinding.findMany.mockResolvedValue([]);
      if (source === 'supervision')
        tx.organizationPositionRolePolicy.findMany.mockResolvedValue([]);
      await expect(
        service.explain(
          user,
          'activity.update.record',
          { type: 'activity', id: 'activity' },
          client,
        ),
      ).resolves.toMatchObject({ allow: true, matchedGrant: { source } });
      for (const delegate of Object.values(tx))
        expect(Object.values(delegate)[0]).toHaveBeenCalled();
      expect(tx.rolePermission.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ role: { deletedAt: null } }) as unknown,
        }),
      );
    },
  );
  it('no-ref branch invokes the existing GLOBAL judge with caller tx', async () => {
    const { service, client, rbac } = setup();
    const judge = jest
      .spyOn(rbac, 'judge')
      .mockResolvedValue({ allowed: false, reason: 'no_permission' });
    await expect(service.can(user, 'activity.update.record', undefined, client)).resolves.toBe(
      false,
    );
    expect(judge).toHaveBeenCalledWith(user, 'activity.update.record', undefined, client);
  });
  it('SUPER_ADMIN still resolves constraints through the caller tx', async () => {
    const { service, client, tx } = setup();
    await expect(
      service.can(
        { ...user, role: Role.SUPER_ADMIN },
        'activity.update.record',
        { type: 'activity', id: 'activity' },
        client,
      ),
    ).resolves.toBe(true);
    expect(tx.activity.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.roleBinding.findMany).not.toHaveBeenCalled();
  });
  it('next decision re-reads current role membership and fails closed after revocation', async () => {
    const { service, tx, client } = setup();
    const ref = { type: 'activity', id: 'activity' } as const;
    expect(await service.can(user, 'activity.update.record', ref, client)).toBe(true);
    tx.rolePermission.findMany.mockResolvedValue([]);
    expect(await service.can(user, 'activity.update.record', ref, client)).toBe(false);
    expect(tx.rolePermission.findMany).toHaveBeenCalledTimes(2);
  });
  it.each(['role_binding', 'position', 'supervision'] as const)(
    'visible organization scope expands %s using only caller delegates',
    async (source) => {
      const { service, tx, client } = setup();
      if (source !== 'role_binding') tx.roleBinding.findMany.mockResolvedValue([]);
      if (source === 'supervision')
        tx.organizationPositionRolePolicy.findMany.mockResolvedValue([]);
      tx.organizationClosure.findMany.mockResolvedValue([
        { descendantId: 'org' },
        { descendantId: 'child' },
      ]);
      await expect(
        service.getVisibleOrganizationScope(user, 'activity.create.cross-org', client),
      ).resolves.toEqual({ hasPermission: true, global: false, organizationIds: ['child', 'org'] });
      expect(tx.organizationClosure.findMany).toHaveBeenCalledWith({
        where: { ancestorId: { in: ['org'] } },
        select: { descendantId: true },
      });
      expect(tx.rolePermission.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ role: { deletedAt: null } }) as unknown,
        }),
      );
    },
  );
  it('visible scope rereads role permissions after revocation', async () => {
    const { service, tx, client } = setup();
    tx.rolePermission.findMany.mockResolvedValue([]);
    await expect(
      service.getVisibleOrganizationScope(user, 'activity.create.cross-org', client),
    ).resolves.toEqual({ hasPermission: false, global: false, organizationIds: [] });
    expect(tx.organizationClosure.findMany).not.toHaveBeenCalled();
  });
});
