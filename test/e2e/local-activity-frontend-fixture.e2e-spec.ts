import type { INestApplication } from '@nestjs/common';
import {
  BindingScopeType,
  BindingStatus,
  DictItemStatus,
  DictTypeStatus,
  MemberStatus,
  MembershipStatus,
  MembershipType,
  OrganizationStatus,
  PrincipalType,
  Role,
  UserStatus,
  type Prisma,
  type PrismaClient,
} from '@prisma/client';
import { PrismaService } from '../../src/database/prisma.service';
import {
  LOCAL_ACTIVITY_FRONTEND_ACCOUNTS,
  LOCAL_ACTIVITY_FRONTEND_ORGANIZATIONS,
  setupLocalActivityFrontendFixture,
  verifyLocalActivityFrontendFixture,
} from '../../src/local-activity-frontend-fixture';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { TEST_PASSWORD } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const REVIEWER_ROLE_PERMISSIONS = {
  'activity-publish-reviewer': [
    'activity-review.read.request',
    'activity.publish.record',
    'activity-review.return.request',
  ],
  'attendance-first-reviewer': [
    'attendance.read.sheet',
    'attendance.approve.sheet',
    'attendance.reject.sheet',
    'attendance.return.sheet',
  ],
  'attendance-final-reviewer': [
    'attendance.read.sheet',
    'attendance.final-approve.sheet',
    'attendance.final-reject.sheet',
    'attendance.reopen.sheet',
    'attendance.final-return.sheet',
  ],
  'activity-cross-org-initiator': ['activity.create.cross-org'],
} as const;

const BIZ_ADMIN_ACTIVITY_SLICE = [
  'activity.create.record',
  'activity.delete.record',
  'activity-registration.read.record',
  'attendance.read.sheet',
] as const;

const SYSTEM_MANAGED_ROLE_CASES = [
  ['activity-owner', 'OWNER'],
  ['activity-registration-collaborator', 'REG-COLLAB'],
  ['activity-attendance-collaborator', 'ATT-COLLAB'],
] as const;

const LEGACY_ACTIVITY_ROLE_CODE = 'test-legacy-activity-actions';
const EXPECTED_SETUP_RESULT = {
  organizations: 2,
  accounts: 17,
  memberships: 17,
  roleBindings: 8,
};
const EXPECTED_VERIFY_RESULT = {
  accounts: 17,
  memberships: 17,
  roleBindings: 8,
};

class RollbackInjectedDrift extends Error {}

describe('local activity frontend fixture engine', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    await seedRequiredLocalFixtureBaseline(app, prisma);
  });

  afterAll(async () => {
    await resetDb(app);
    await app.close();
  });

  it('rolls back every newly created fixture row when a later identity collision fails', async () => {
    const collision = await prisma.member.create({
      data: {
        memberNo: 'LOCAL-FE-PUBLISH-REVIEWER',
        displayName: 'not the fixture placeholder',
        gradeCode: 'level-3',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    try {
      await expect(setupLocalActivityFrontendFixture(prisma, TEST_PASSWORD)).rejects.toThrow(
        "fixture Member 'LOCAL-FE-PUBLISH-REVIEWER' 已存在但形状不一致",
      );
      const [organizations, users, fixtureBindings, fixtureMembers] = await Promise.all([
        prisma.organization.count({ where: { code: { startsWith: 'LOCAL-FE-' } } }),
        prisma.user.count({ where: { username: { startsWith: 'local_fe_' } } }),
        prisma.roleBinding.count({ where: { note: 'LOCAL-FE fixture' } }),
        prisma.member.count({ where: { memberNo: { startsWith: 'LOCAL-FE-' } } }),
      ]);
      expect({ organizations, users, fixtureBindings, fixtureMembers }).toEqual({
        organizations: 0,
        users: 0,
        fixtureBindings: 0,
        fixtureMembers: 1,
      });
    } finally {
      await prisma.member.delete({ where: { id: collision.id } });
    }
  });

  it('creates the complete fixture once and keeps every identity stable on the second setup', async () => {
    const first = await setupLocalActivityFrontendFixture(prisma, TEST_PASSWORD);
    expect(first).toEqual(EXPECTED_SETUP_RESULT);

    const firstSnapshot = await loadFixtureIdentitySnapshot(prisma);
    const second = await setupLocalActivityFrontendFixture(prisma, TEST_PASSWORD);
    const secondSnapshot = await loadFixtureIdentitySnapshot(prisma);

    expect(second).toEqual(EXPECTED_SETUP_RESULT);
    expect(secondSnapshot).toEqual(firstSnapshot);

    const verified = await verifyLocalActivityFrontendFixture(prisma);
    expect(verified).toMatchObject(EXPECTED_VERIFY_RESULT);

    const users = await prisma.user.findMany({
      where: {
        username: { in: LOCAL_ACTIVITY_FRONTEND_ACCOUNTS.map((account) => account.username) },
      },
      select: { id: true, memberId: true, role: true, status: true, deletedAt: true },
    });
    expect(users).toHaveLength(17);
    expect(new Set(users.map((user) => user.memberId)).size).toBe(17);
    expect(users.filter((user) => user.role === Role.ADMIN)).toHaveLength(1);
    expect(
      users.every(
        (user) =>
          user.memberId !== null && user.status === UserStatus.ACTIVE && user.deletedAt === null,
      ),
    ).toBe(true);

    const memberIds = users.map((user) => user.memberId!);
    const memberships = await prisma.memberOrganizationMembership.findMany({
      where: {
        memberId: { in: memberIds },
        status: MembershipStatus.ACTIVE,
        deletedAt: null,
      },
      select: { memberId: true, membershipType: true, endedAt: true },
    });
    expect(memberships).toHaveLength(17);
    expect(new Set(memberships.map((membership) => membership.memberId)).size).toBe(17);
    expect(
      memberships.every(
        (membership) =>
          membership.membershipType === MembershipType.PRIMARY && membership.endedAt === null,
      ),
    ).toBe(true);

    const activeBindings = await prisma.roleBinding.count({
      where: {
        status: BindingStatus.ACTIVE,
        deletedAt: null,
        OR: [
          { principalType: PrincipalType.USER, principalId: { in: users.map((user) => user.id) } },
          { principalType: PrincipalType.MEMBER, principalId: { in: memberIds } },
        ],
      },
    });
    expect(activeBindings).toBe(8);
  });

  it('rejects a password change without rewriting hashes or bypassing session revocation', async () => {
    const before = await prisma.user.findMany({
      where: {
        username: { in: LOCAL_ACTIVITY_FRONTEND_ACCOUNTS.map((account) => account.username) },
      },
      select: { id: true, username: true, passwordHash: true, updatedAt: true },
      orderBy: { username: 'asc' },
    });

    await expect(setupLocalActivityFrontendFixture(prisma, 'DifferentFixture9!')).rejects.toThrow(
      /既有密码与本次输入不一致；拒绝绕过会话撤销与审计/,
    );

    const after = await prisma.user.findMany({
      where: {
        username: { in: LOCAL_ACTIVITY_FRONTEND_ACCOUNTS.map((account) => account.username) },
      },
      select: { id: true, username: true, passwordHash: true, updatedAt: true },
      orderBy: { username: 'asc' },
    });
    expect(after).toEqual(before);
  });

  it('stores the three negative-grade accounts without changing their active identity shape', async () => {
    const negativeMembers = await prisma.member.findMany({
      where: {
        memberNo: {
          in: ['LOCAL-FE-VOLUNTEER', 'LOCAL-FE-RESERVE', 'LOCAL-FE-NO-GRADE'],
        },
      },
      select: { memberNo: true, gradeCode: true, status: true, deletedAt: true },
      orderBy: { memberNo: 'asc' },
    });
    expect(negativeMembers).toEqual([
      {
        memberNo: 'LOCAL-FE-NO-GRADE',
        gradeCode: null,
        status: MemberStatus.ACTIVE,
        deletedAt: null,
      },
      {
        memberNo: 'LOCAL-FE-RESERVE',
        gradeCode: 'reserve',
        status: MemberStatus.ACTIVE,
        deletedAt: null,
      },
      {
        memberNo: 'LOCAL-FE-VOLUNTEER',
        gradeCode: 'volunteer',
        status: MemberStatus.ACTIVE,
        deletedAt: null,
      },
    ]);
    await expect(verifyLocalActivityFrontendFixture(prisma)).resolves.toMatchObject(
      EXPECTED_VERIFY_RESULT,
    );
  });

  it('verify rejects a missing active required role', async () => {
    await expectRolledBackDrift(
      prisma,
      async (tx) => {
        await tx.rbacRole.update({
          where: { code: 'attendance-first-reviewer' },
          data: { deletedAt: new Date() },
        });
      },
      /缺少 active 系统角色 'attendance-first-reviewer'/,
    );
  });

  it('setup and verify reject a required RoleBinding whose term starts in the future', async () => {
    const binding = await prisma.roleBinding.findFirstOrThrow({
      where: { note: 'LOCAL-FE fixture' },
      select: { id: true, startedAt: true },
      orderBy: { id: 'asc' },
    });
    await prisma.roleBinding.update({
      where: { id: binding.id },
      data: { startedAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
    });

    try {
      await expect(setupLocalActivityFrontendFixture(prisma, TEST_PASSWORD)).rejects.toThrow(
        /未声明或形状错误的 active RoleBinding/,
      );
      await expect(verifyLocalActivityFrontendFixture(prisma)).rejects.toThrow(/RoleBinding.*任期/);
    } finally {
      await prisma.roleBinding.update({
        where: { id: binding.id },
        data: { startedAt: binding.startedAt },
      });
    }

    await expect(verifyLocalActivityFrontendFixture(prisma)).resolves.toMatchObject(
      EXPECTED_VERIFY_RESULT,
    );
  });

  it('verify rejects an extra reviewer permission', async () => {
    await expectRolledBackDrift(
      prisma,
      async (tx) => {
        const [role, permission] = await Promise.all([
          tx.rbacRole.findUniqueOrThrow({
            where: { code: 'activity-publish-reviewer' },
            select: { id: true },
          }),
          tx.permission.create({
            data: {
              code: 'activity-review.fixture-extra.request',
              module: 'activity-review',
              action: 'fixture-extra',
              resourceType: 'request',
            },
            select: { id: true },
          }),
        ]);
        await tx.rolePermission.create({
          data: { roleId: role.id, permissionId: permission.id },
        });
      },
      /seed 角色 'activity-publish-reviewer' 的权限集合与冻结契约不一致/,
    );
  });

  it('verify rejects a reviewer permission substituted with a wrong code', async () => {
    await expectRolledBackDrift(
      prisma,
      async (tx) => {
        const role = await tx.rbacRole.findUniqueOrThrow({
          where: { code: 'activity-publish-reviewer' },
          select: { id: true },
        });
        const expectedPermission = await tx.permission.findUniqueOrThrow({
          where: { code: 'activity.publish.record' },
          select: { id: true },
        });
        await tx.rolePermission.delete({
          where: {
            roleId_permissionId: {
              roleId: role.id,
              permissionId: expectedPermission.id,
            },
          },
        });
        const wrongPermission = await tx.permission.create({
          data: {
            code: 'activity-review.fixture-wrong.request',
            module: 'activity-review',
            action: 'fixture-wrong',
            resourceType: 'request',
          },
          select: { id: true },
        });
        await tx.rolePermission.create({
          data: { roleId: role.id, permissionId: wrongPermission.id },
        });
      },
      /seed 角色 'activity-publish-reviewer' 的权限集合与冻结契约不一致/,
    );
  });

  it.each(['activity-review.return.request', 'activity-responsibility.override.record'])(
    "verify rejects biz-admin drift granting activity responsibility write permission '%s'",
    async (permissionCode) => {
      await expectRolledBackDrift(
        prisma,
        async (tx) => {
          const [module, action, resourceType] = permissionCode.split('.');
          if (!module || !action || !resourceType) {
            throw new Error(`invalid test permission code '${permissionCode}'`);
          }
          const [role, permission] = await Promise.all([
            tx.rbacRole.findUniqueOrThrow({
              where: { code: 'biz-admin' },
              select: { id: true },
            }),
            tx.permission.upsert({
              where: { code: permissionCode },
              update: {},
              create: { code: permissionCode, module, action, resourceType },
              select: { id: true },
            }),
          ]);
          await tx.rolePermission.create({
            data: { roleId: role.id, permissionId: permission.id },
          });
        },
        new RegExp(
          `seed 角色 'biz-admin' 错误持有活动责任写权限：${permissionCode.replace(
            /[.*+?^${}()|[\]\\]/g,
            '\\$&',
          )}`,
        ),
      );
    },
  );

  it('verify rejects a test-only legacy activity binding on the unrelated admin', async () => {
    await expectRolledBackDrift(
      prisma,
      async (tx) => {
        const [user, legacyRole] = await Promise.all([
          tx.user.findUniqueOrThrow({
            where: { username: 'local_fe_unrelated_admin' },
            select: { id: true },
          }),
          tx.rbacRole.create({
            data: {
              code: LEGACY_ACTIVITY_ROLE_CODE,
              displayName: 'E2E legacy activity actions',
              description: 'test-only drift injected by this transaction',
            },
            select: { id: true },
          }),
        ]);
        await tx.roleBinding.create({
          data: {
            principalType: PrincipalType.USER,
            principalId: user.id,
            roleId: legacyRole.id,
            scopeType: BindingScopeType.GLOBAL,
            status: BindingStatus.ACTIVE,
            note: 'LOCAL-FE fixture',
          },
        });
      },
      /期望 8 个 active RoleBinding，实际 9/,
    );
  });

  it.each(SYSTEM_MANAGED_ROLE_CASES)(
    'verify rejects an active %s binding anywhere in the initial database',
    async (roleCode, memberNoSuffix) => {
      await expectRolledBackDrift(
        prisma,
        async (tx) => {
          const [member, role] = await Promise.all([
            tx.member.create({
              data: {
                memberNo: `LOCAL-FE-DRIFT-${memberNoSuffix}`,
                displayName: `LOCAL-FE drift ${roleCode}`,
                gradeCode: 'level-3',
                status: MemberStatus.ACTIVE,
              },
              select: { id: true },
            }),
            tx.rbacRole.findUniqueOrThrow({
              where: { code: roleCode },
              select: { id: true },
            }),
          ]);
          await tx.roleBinding.create({
            data: {
              principalType: PrincipalType.MEMBER,
              principalId: member.id,
              roleId: role.id,
              scopeType: BindingScopeType.ACTIVITY,
              scopeActivityId: `local-fixture-drift-${roleCode}`,
              status: BindingStatus.ACTIVE,
            },
          });
        },
        /初始环境存在 active owner\/collaborator 系统 RoleBinding/,
      );
    },
  );
});

async function seedRequiredLocalFixtureBaseline(
  app: INestApplication,
  prisma: PrismaService,
): Promise<void> {
  await prisma.dictType.create({
    data: {
      code: 'node_type',
      label: '组织节点类型',
      status: DictTypeStatus.ACTIVE,
      items: {
        create: {
          code: 'group',
          label: '组',
          status: DictItemStatus.ACTIVE,
        },
      },
    },
  });
  await prisma.dictType.create({
    data: {
      code: 'member_grade',
      label: '队员等级',
      status: DictTypeStatus.ACTIVE,
      items: {
        create: ['level-3', 'volunteer', 'reserve'].map((code) => ({
          code,
          label: code,
          status: DictItemStatus.ACTIVE,
        })),
      },
    },
  });

  const root = await prisma.organization.create({
    data: {
      name: '深圳公益救援队',
      code: 'SRVF',
      nodeTypeCode: 'headquarters',
      status: OrganizationStatus.ACTIVE,
    },
    select: { id: true },
  });
  await prisma.organizationClosure.create({
    data: { ancestorId: root.id, descendantId: root.id, depth: 0 },
  });

  await seedActivityResponsibilitySystemRoles(app);
  for (const [roleCode, permissionCodes] of Object.entries(REVIEWER_ROLE_PERMISSIONS)) {
    await seedExactRole(prisma, roleCode, [...permissionCodes]);
  }
  await seedExactRole(prisma, 'biz-admin', [...BIZ_ADMIN_ACTIVITY_SLICE]);

  await expect(
    prisma.rbacRole.findUnique({ where: { code: LEGACY_ACTIVITY_ROLE_CODE } }),
  ).resolves.toBeNull();
}

async function seedExactRole(
  prisma: PrismaService,
  roleCode: string,
  permissionCodes: string[],
): Promise<void> {
  for (const code of permissionCodes) {
    const [module, action, resourceType] = code.split('.');
    if (!module || !action || !resourceType) {
      throw new Error(`invalid permission code in E2E baseline: ${code}`);
    }
    await prisma.permission.upsert({
      where: { code },
      update: {},
      create: { code, module, action, resourceType },
    });
  }
  const role = await prisma.rbacRole.upsert({
    where: { code: roleCode },
    update: { deletedAt: null },
    create: { code: roleCode, displayName: roleCode },
    select: { id: true },
  });
  const permissions = await prisma.permission.findMany({
    where: { code: { in: permissionCodes } },
    select: { id: true },
  });
  await prisma.rolePermission.createMany({
    data: permissions.map((permission) => ({
      roleId: role.id,
      permissionId: permission.id,
    })),
    skipDuplicates: true,
  });
}

async function expectRolledBackDrift(
  prisma: PrismaService,
  mutate: (tx: Prisma.TransactionClient) => Promise<void>,
  expectedError: RegExp,
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await mutate(tx);
      await expect(
        verifyLocalActivityFrontendFixture(tx as unknown as PrismaClient),
      ).rejects.toThrow(expectedError);
      throw new RollbackInjectedDrift();
    });
    throw new Error('drift transaction unexpectedly committed');
  } catch (error) {
    if (!(error instanceof RollbackInjectedDrift)) throw error;
  }

  await expect(verifyLocalActivityFrontendFixture(prisma)).resolves.toMatchObject(
    EXPECTED_VERIFY_RESULT,
  );
}

async function loadFixtureIdentitySnapshot(prisma: PrismaService): Promise<{
  organizations: unknown[];
  users: unknown[];
  members: unknown[];
  memberships: unknown[];
  roleBindings: unknown[];
}> {
  const [organizations, users, members] = await Promise.all([
    prisma.organization.findMany({
      where: {
        code: {
          in: LOCAL_ACTIVITY_FRONTEND_ORGANIZATIONS.map((organization) => organization.code),
        },
      },
      select: { id: true, code: true, parentId: true },
      orderBy: { code: 'asc' },
    }),
    prisma.user.findMany({
      where: {
        username: { in: LOCAL_ACTIVITY_FRONTEND_ACCOUNTS.map((account) => account.username) },
      },
      select: { id: true, username: true, memberId: true },
      orderBy: { username: 'asc' },
    }),
    prisma.member.findMany({
      where: {
        memberNo: { in: LOCAL_ACTIVITY_FRONTEND_ACCOUNTS.map((account) => account.memberNo) },
      },
      select: { id: true, memberNo: true },
      orderBy: { memberNo: 'asc' },
    }),
  ]);
  const memberIds = members.map((member) => member.id);
  const userIds = users.map((user) => user.id);
  const [memberships, roleBindings] = await Promise.all([
    prisma.memberOrganizationMembership.findMany({
      where: {
        memberId: { in: memberIds },
        status: MembershipStatus.ACTIVE,
        deletedAt: null,
      },
      select: { id: true, memberId: true, organizationId: true, membershipType: true },
      orderBy: { id: 'asc' },
    }),
    prisma.roleBinding.findMany({
      where: {
        status: BindingStatus.ACTIVE,
        deletedAt: null,
        OR: [
          { principalType: PrincipalType.USER, principalId: { in: userIds } },
          { principalType: PrincipalType.MEMBER, principalId: { in: memberIds } },
        ],
      },
      select: {
        id: true,
        principalType: true,
        principalId: true,
        roleId: true,
        scopeType: true,
        scopeOrgId: true,
      },
      orderBy: { id: 'asc' },
    }),
  ]);
  return { organizations, users, members, memberships, roleBindings };
}
