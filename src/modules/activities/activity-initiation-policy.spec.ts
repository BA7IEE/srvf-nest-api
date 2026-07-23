import {
  BindingScopeType,
  MemberStatus,
  MembershipStatus,
  MembershipType,
  Role,
  UserStatus,
} from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuthzService } from '../authz/authz.service';
import { RbacService } from '../permissions/rbac.service';
import { ActivityInitiationPolicy } from './activity-initiation-policy';

const USER: CurrentUserPayload = {
  id: 'user-activity-initiator',
  username: 'activity-initiator',
  role: Role.USER,
  status: UserStatus.ACTIVE,
  memberId: 'member-activity-initiator',
};
const TARGET_ORG_ID = 'organization-activity-target';

interface PolicyMemberRow {
  gradeCode: string | null;
  memberOrganizationMemberships: Array<{ organizationId: string }>;
}

interface PolicyMemberQuery {
  where: {
    id: string;
    status: MemberStatus;
    deletedAt: null;
  };
  select: {
    memberOrganizationMemberships: {
      where: {
        deletedAt: null;
        status: MembershipStatus;
        startedAt: { lte: Date };
        OR: [{ endedAt: null }, { endedAt: { gt: Date } }];
        organization: {
          status: string;
          deletedAt: null;
          parentId: { not: null };
        };
      };
    };
  };
}

function makePolicy() {
  const findFirst = jest.fn<Promise<PolicyMemberRow | null>, [unknown]>();
  const prisma = {
    member: {
      findFirst,
    },
  };
  const authz = {
    explain: jest.fn().mockResolvedValue({ allow: false, reason: 'no_permission' }),
  };
  const rbac = {
    can: jest.fn().mockResolvedValue(false),
  };
  const policy = new ActivityInitiationPolicy(
    prisma as unknown as PrismaService,
    authz as unknown as AuthzService,
    rbac as unknown as RbacService,
  );
  return { policy, prisma, authz, rbac };
}

describe('ActivityInitiationPolicy', () => {
  it.each(['level-1', 'level-2', 'level-3', 'level-4', 'level-5', 'level-6', 'level-7'])(
    'accepts formal grade %s in an effective own-organization membership',
    async (gradeCode) => {
      const { policy, prisma, authz } = makePolicy();
      prisma.member.findFirst.mockResolvedValue({
        gradeCode,
        memberOrganizationMemberships: [{ organizationId: TARGET_ORG_ID }],
      });

      await expect(policy.resolveInitiator(USER, TARGET_ORG_ID)).resolves.toBe(USER.memberId);
      expect(authz.explain).not.toHaveBeenCalled();
    },
  );

  it.each(['volunteer', 'reserve', null])('rejects non-formal grade %s', async (gradeCode) => {
    const { policy, prisma } = makePolicy();
    prisma.member.findFirst.mockResolvedValue({
      gradeCode,
      memberOrganizationMemberships: [{ organizationId: TARGET_ORG_ID }],
    });

    await expect(policy.resolveInitiator(USER, TARGET_ORG_ID)).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_INITIATOR_NOT_FORMAL,
    });
  });

  it.each(Object.values(MembershipType))(
    'does not exclude effective %s membership type from the member query',
    async () => {
      const { policy, prisma } = makePolicy();
      prisma.member.findFirst.mockResolvedValue({
        gradeCode: 'level-1',
        memberOrganizationMemberships: [{ organizationId: TARGET_ORG_ID }],
      });

      await policy.resolveInitiator(USER, TARGET_ORG_ID);
      const query = prisma.member.findFirst.mock.calls[0]?.[0] as PolicyMemberQuery;
      expect(query.where).toEqual({
        id: USER.memberId,
        status: MemberStatus.ACTIVE,
        deletedAt: null,
      });
      expect(query.select.memberOrganizationMemberships.where).not.toHaveProperty('membershipType');
    },
  );

  it('queries only active, started, unexpired memberships in active non-root organizations', async () => {
    const { policy, prisma } = makePolicy();
    prisma.member.findFirst.mockResolvedValue({
      gradeCode: 'level-4',
      memberOrganizationMemberships: [{ organizationId: TARGET_ORG_ID }],
    });

    await policy.resolveInitiator(USER, TARGET_ORG_ID);
    const query = prisma.member.findFirst.mock.calls[0]?.[0] as PolicyMemberQuery;
    const membershipWhere = query.select.memberOrganizationMemberships.where;
    expect(membershipWhere.deletedAt).toBeNull();
    expect(membershipWhere.status).toBe(MembershipStatus.ACTIVE);
    expect(membershipWhere.startedAt.lte).toBeInstanceOf(Date);
    expect(membershipWhere.OR[0]).toEqual({ endedAt: null });
    expect(membershipWhere.OR[1].endedAt.gt).toBeInstanceOf(Date);
    expect(membershipWhere.organization).toEqual({
      status: 'ACTIVE',
      deletedAt: null,
      parentId: { not: null },
    });
    expect(membershipWhere.startedAt.lte).toBe(membershipWhere.OR[1].endedAt.gt);
  });

  it.each([
    BindingScopeType.ORGANIZATION,
    BindingScopeType.ORGANIZATION_TREE,
    BindingScopeType.GLOBAL,
  ])('accepts cross-org initiation when authz matches %s scope', async (scopeType) => {
    const { policy, prisma, authz } = makePolicy();
    prisma.member.findFirst.mockResolvedValue({
      gradeCode: 'level-5',
      memberOrganizationMemberships: [],
    });
    authz.explain.mockResolvedValue({
      allow: true,
      reason: 'matched',
      matchedGrant: { source: 'role_binding', scopeType },
    });

    await expect(policy.resolveInitiator(USER, TARGET_ORG_ID)).resolves.toBe(USER.memberId);
    expect(authz.explain).toHaveBeenCalledWith(USER, 'activity.create.cross-org', {
      type: 'organization',
      id: TARGET_ORG_ID,
    });
  });

  it('maps missing or expired/suspended membership without a cross-org grant to 20020', async () => {
    const { policy, prisma } = makePolicy();
    prisma.member.findFirst.mockResolvedValue({
      gradeCode: 'level-6',
      memberOrganizationMemberships: [],
    });

    await expect(policy.resolveInitiator(USER, TARGET_ORG_ID)).rejects.toEqual(
      new BizException(BizCode.ACTIVITY_INITIATION_ORG_FORBIDDEN),
    );
  });

  it('requires SUPER_ADMIN or override permission to record another formal initiator', async () => {
    const { policy, rbac, prisma } = makePolicy();
    await expect(
      policy.resolveInitiator(USER, TARGET_ORG_ID, 'member-other-formal'),
    ).rejects.toMatchObject({ biz: BizCode.RBAC_FORBIDDEN });
    expect(prisma.member.findFirst).not.toHaveBeenCalled();

    rbac.can.mockResolvedValue(true);
    prisma.member.findFirst.mockResolvedValue({
      gradeCode: 'level-7',
      memberOrganizationMemberships: [{ organizationId: TARGET_ORG_ID }],
    });
    await expect(policy.resolveInitiator(USER, TARGET_ORG_ID, 'member-other-formal')).resolves.toBe(
      'member-other-formal',
    );
  });
});
