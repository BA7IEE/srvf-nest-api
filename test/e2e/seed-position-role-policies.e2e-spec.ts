import type { INestApplication } from '@nestjs/common';
import { execSync } from 'child_process';
import { RBAC_SEED_CATALOG } from '../../prisma/seed';
import { PrismaService } from '../../src/database/prisma.service';
import { RBAC_PERMISSION_SEED } from '../../src/modules/permissions/permission-catalog';
import { RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODES } from '../../src/modules/permissions/reserved-super-admin-permission-codes';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertTestDatabaseUrl } from '../setup/test-db';

// 终态 scoped-authz PR7(2026-07-01;冻结稿 §3.7 / §2.4 BD-1/BD-3 / 🔴 R5 / §10.5):
// 职务→角色 policy seed e2e。沿 seed-positions / seed-biz-admin 子进程范式
// (execSync pnpm tsx prisma/seed.ts;期望码集为本 spec 独立维护,与 seed 内部表对照防漂移)。
//
// 覆盖(goal DoD 5 / 7):
//   1. 只读角色 org-readonly / group-readonly:码集从对应正职**动态投影**并逐码相等
//      (投影规则见 seed 的 isReadonlyProjectionCode:只取 `.read.` 与 `attachment.view.`;
//       biz-admin 仍保留 activity.create/delete 与 participation read;
//       org-supervisor = BD-3 定稿,2 候选码不加)
//
//      ⚠️ **此处刻意不写各角色的码数与内置角色总数。** 这段注释此前写的是
//      「内置角色 7→9 / org-admin 47 / biz-admin 69 / group-manager 20」——
//      到 2026-08-21 实测已是 15 个角色、group-manager 26 条,**三个数字全部失准**,
//      而没有任何判据会发现注释里的数字过期(第七轮评审顺带发现 ③)。
//      填新数字只会把同一个缺陷再犯一遍 ⇒ 改为指向权威源:
//      当期读数见 `docs/ai-harness/RBAC_MAP.md` 的「角色 → 权限码覆盖」生成表
//      (`pnpm docs:rbacmap` 生成,禁手改);本 spec 的断言取自 seed 事实闭包,
//      **不依赖这段散文**。
//   2. 6 条默认 policy(3 正职管理 + 3 副职只读,scopeMode 全 TREE);org-supervisor 不是 policy 目标
//   3. R5 v0.49 CI 断言:副职只映射对应只读角色,码集恒零写/零敏感
//   4. R5 运行时护栏生效:人为给副职塞管理 policy 后重跑 seed → 非 0 退出
//   5. 只读角色 RolePermission 精确同步:补缺失、删脏写码
//   6. 零指派 + 零漂移:5 个职务/分管角色无任何 RoleBinding 持有者(判权零影响);
//      ops-admin 104(PR-2 +8 配置面码)/ member 9 不变；biz-admin 69(PR-1 +read.sensitive;PR-2 配置面码只绑 ops-admin);
//      7 保留码不绑 3 新角色(F1 哨兵延伸)
//   7. 幂等:连续两次 seed counts / role id 稳定 + policy updatedAt 不 bump
//
// 终态 scoped-authz PR9(2026-07-02)追加:第 7 内置角色 `attendance-final-reviewer`(冻结稿
// 场景 4 / BD-2 终审中枢显式绑定载体)—— 角色全集 6→7;专属用例 7 锁「绑 3 既有码 + 零持有 +
// 零 policy 行(终审不随职务推导)」。
//
// 不覆盖(刻意;PR8 范围):policy → 实际授权推导(本刀 policy 表纯配置,绝不被判权路径读)。

interface SeedRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runSeed(envOverrides: Record<string, string>): SeedRunResult {
  const envForChild = { ...process.env, ...envOverrides };
  assertTestDatabaseUrl(envForChild.DATABASE_URL);
  try {
    const stdout = execSync('pnpm tsx prisma/seed.ts', {
      env: envForChild,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      code: e.status ?? -1,
      stdout: typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString() ?? ''),
      stderr: typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString() ?? ''),
    };
  }
}

const SEED_ENV = {
  APP_ENV: 'test',
  SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
  SUPER_ADMIN_EMAIL: '',
  RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
};

const ORG_ADMIN_ROLE_SEED = RBAC_SEED_CATALOG.roles.orgAdmin;
const EXPECTED_ORG_ADMIN_CODES = ORG_ADMIN_ROLE_SEED.permissionCodes;

const GROUP_MANAGER_ROLE_SEED = RBAC_SEED_CATALOG.roles.groupManager;
const EXPECTED_GROUP_MANAGER_CODES = GROUP_MANAGER_ROLE_SEED.permissionCodes;

const isReadonlyProjectionCode = (code: string): boolean =>
  !code.endsWith('.read.sensitive') &&
  (code.includes('.read.') || code.startsWith('attachment.view.'));

const ORG_READONLY_ROLE_SEED = RBAC_SEED_CATALOG.roles.orgReadonly;
const GROUP_READONLY_ROLE_SEED = RBAC_SEED_CATALOG.roles.groupReadonly;
const ORG_SUPERVISOR_ROLE_SEED = RBAC_SEED_CATALOG.roles.orgSupervisor;
const FINAL_REVIEWER_ROLE_SEED = RBAC_SEED_CATALOG.roles.attendanceFinalReviewer;
const EXPECTED_ORG_READONLY_CODES = ORG_READONLY_ROLE_SEED.permissionCodes;
const EXPECTED_GROUP_READONLY_CODES = GROUP_READONLY_ROLE_SEED.permissionCodes;
const EXPECTED_ORG_SUPERVISOR_CODES = ORG_SUPERVISOR_ROLE_SEED.permissionCodes;
const EXPECTED_POLICIES = RBAC_SEED_CATALOG.positionRolePolicies.all;
const EXPECTED_VICE_POLICIES = RBAC_SEED_CATALOG.positionRolePolicies.vice;
const NEW_ROLE_CODES = [
  ORG_ADMIN_ROLE_SEED.code,
  GROUP_MANAGER_ROLE_SEED.code,
  ORG_READONLY_ROLE_SEED.code,
  GROUP_READONLY_ROLE_SEED.code,
  ORG_SUPERVISOR_ROLE_SEED.code,
];
const FINAL_REVIEWER_ROLE_CODE = FINAL_REVIEWER_ROLE_SEED.code;
const EXPECTED_FINAL_REVIEWER_CODES = FINAL_REVIEWER_ROLE_SEED.permissionCodes;
const ACTIVITY_WORKFLOW_ROLE_SEEDS = RBAC_SEED_CATALOG.roles.activityResponsibility;
const ALL_SEED_ROLE_CODES = [
  RBAC_SEED_CATALOG.roles.opsAdmin.code,
  RBAC_SEED_CATALOG.roles.member.code,
  RBAC_SEED_CATALOG.roles.bizAdmin.code,
  ...NEW_ROLE_CODES,
  FINAL_REVIEWER_ROLE_CODE,
  ...ACTIVITY_WORKFLOW_ROLE_SEEDS.map((role) => role.code),
];

function workflowRoleSeed(code: string) {
  const role = ACTIVITY_WORKFLOW_ROLE_SEEDS.find((seedRole) => seedRole.code === code);
  if (!role) {
    throw new Error(`missing workflow seed role '${code}'`);
  }
  return role;
}

// 既有 3 角色绑定数零漂移基线(seed-rbac 95 / seed-attachment 9 / seed-biz-admin 74〔§F&A-3 起〕同口径;
// 2026-07-02 终态 scoped-authz PR10 authz.explain.decision 绑 ops-admin 88→89;
// PR11 announcement-import 2 码绑 ops-admin 89→91;
// 2026-07-03 摘码微刀:biz-admin 摘终审两码 74→72;
// 2026-07-04 F1「A 组」meta.resolve.label 绑 ops-admin 91→92;
// 2026-07-04 F3「C 组」authz.{explain-batch,action-state}.decision 绑 ops-admin 92→94;
// 2026-07-07 队员账号闭环 v1 member.grant.account 绑 ops-admin 94→95;
// 2026-07-07 队员账号闭环 v2 member.bind.account 绑 ops-admin 95→96)。
const EXPECTED_OPS_ADMIN_BINDING_COUNT = RBAC_SEED_CATALOG.roles.opsAdmin.permissionCodes.length;
const EXPECTED_MEMBER_ROLE_BINDING_COUNT = RBAC_SEED_CATALOG.roles.member.permissionCodes.length;
// 证书标准库 PR-1(2026-07-30):+1 = certificate.read.sensitive(§15.3)。
// 同刀已把该码加入 ORG_ADMIN_EXCLUDED_CODES,故 EXPECTED_ORG_ADMIN_CODES 逐字不变 ——
// 上面那份精确码表就是「敏感明文不随组织业务下放」的阳性对照:漏加排除即红。
const EXPECTED_BIZ_ADMIN_BINDING_COUNT = RBAC_SEED_CATALOG.roles.bizAdmin.permissionCodes.length;

const CONTRACT_REMOVED_FROM_BIZ_AND_ORG_CODES =
  RBAC_SEED_CATALOG.contract.activityResponsibilityRemovedFromBizAdminCodes;
const CONTRACT_REMOVED_FROM_GROUP_CODES =
  RBAC_SEED_CATALOG.contract.groupManagerTargetedRemovalCodes;
const TARGETED_REMOVED_FROM_ORG_CODES = RBAC_SEED_CATALOG.contract.orgAdminTargetedRemovalCodes;

async function boundCodesOf(prisma: PrismaService, roleCode: string): Promise<string[]> {
  const rows = await prisma.rolePermission.findMany({
    where: { role: { code: roleCode } },
    select: { permission: { select: { code: true } } },
  });
  return rows.map((r) => r.permission.code).sort();
}

describe('prisma/seed.ts — position role policies + v0.61.0 activity workflow(内置角色 15)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(app);
  });

  it('1. 内置角色与 seed 目录一致；org/biz/group contract 码集与只读投影不漂移', async () => {
    expect(runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'pr7-seed-su-1' }).code).toBe(0);
    expect(RBAC_SEED_CATALOG.permissions.rbac).toEqual(RBAC_PERMISSION_SEED);
    expect(RBAC_SEED_CATALOG.contract.reservedSuperAdminOnlyPermissionCodes).toEqual(
      RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODES,
    );

    const roles = await prisma.rbacRole.findMany({
      where: { deletedAt: null },
      select: { code: true },
    });
    expect(new Set(roles.map((r) => r.code))).toEqual(new Set(ALL_SEED_ROLE_CODES));

    expect(await boundCodesOf(prisma, ORG_ADMIN_ROLE_SEED.code)).toEqual(
      [...EXPECTED_ORG_ADMIN_CODES].sort(),
    );
    expect(await boundCodesOf(prisma, GROUP_MANAGER_ROLE_SEED.code)).toEqual(
      [...EXPECTED_GROUP_MANAGER_CODES].sort(),
    );
    expect(await boundCodesOf(prisma, ORG_SUPERVISOR_ROLE_SEED.code)).toEqual(
      [...EXPECTED_ORG_SUPERVISOR_CODES].sort(),
    );
    expect(await boundCodesOf(prisma, ORG_READONLY_ROLE_SEED.code)).toEqual(
      [...EXPECTED_ORG_READONLY_CODES].sort(),
    );
    expect(await boundCodesOf(prisma, GROUP_READONLY_ROLE_SEED.code)).toEqual(
      [...EXPECTED_GROUP_READONLY_CODES].sort(),
    );

    // org-admin 负向自证(BD-1 ≠ SUPER_ADMIN / BD-2 终审归中枢 / §4.2 敏感 / 中央流程不下放):
    const orgAdminCodes = await boundCodesOf(prisma, ORG_ADMIN_ROLE_SEED.code);
    expect(orgAdminCodes).toContain('member-insurance.review.record');
    expect(orgAdminCodes).not.toContain('attendance.final-approve.sheet');
    expect(orgAdminCodes).not.toContain('attendance.final-reject.sheet');
    expect(orgAdminCodes).not.toContain('attendance.reopen.sheet');
    for (const code of CONTRACT_REMOVED_FROM_BIZ_AND_ORG_CODES) {
      expect(orgAdminCodes).not.toContain(code);
    }
    expect(orgAdminCodes.some((c) => c.endsWith('.read.sensitive'))).toBe(false);
    expect(orgAdminCodes.some((c) => c.startsWith('recruitment-'))).toBe(false);
    expect(orgAdminCodes.some((c) => c.startsWith('team-join-'))).toBe(false);
    expect(orgAdminCodes.some((c) => c.startsWith('rbac.'))).toBe(false);
    expect(orgAdminCodes.some((c) => c.startsWith('user.'))).toBe(false);
    // group-manager 负向自证(轻量边界)
    const gmCodes = await boundCodesOf(prisma, GROUP_MANAGER_ROLE_SEED.code);
    expect(gmCodes).not.toContain('member-insurance.review.record');
    expect(gmCodes).not.toContain('member.update.record');
    expect(gmCodes).not.toContain('attendance.final-approve.sheet');
    expect(gmCodes).not.toContain('attendance.reopen.sheet');
    for (const code of CONTRACT_REMOVED_FROM_GROUP_CODES) {
      expect(gmCodes).not.toContain(code);
    }
    expect(gmCodes.some((c) => c.startsWith('activity.'))).toBe(false); // 活动增删改/发布/取消不给组长
    // org-supervisor 只读自证(BD-3:无写、无敏感、无审批)
    const supCodes = await boundCodesOf(prisma, ORG_SUPERVISOR_ROLE_SEED.code);
    expect(supCodes.some((c) => /\.(create|update|delete|approve|reject|set|end)\./.test(c))).toBe(
      false,
    );
    for (const roleCode of [ORG_READONLY_ROLE_SEED.code, GROUP_READONLY_ROLE_SEED.code]) {
      const readonlyCodes = await boundCodesOf(prisma, roleCode);
      expect(readonlyCodes.length).toBeGreaterThan(0);
      expect(readonlyCodes.every(isReadonlyProjectionCode)).toBe(true);
      expect(readonlyCodes.some((code) => code.endsWith('.read.sensitive'))).toBe(false);
    }
  });

  it('2. 默认 policy 与 seed 一致；org-supervisor 不是 policy 目标', async () => {
    expect(runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'pr7-seed-su-2' }).code).toBe(0);

    const policies = await prisma.organizationPositionRolePolicy.findMany({
      where: { deletedAt: null },
      select: {
        scopeMode: true,
        conditionJson: true,
        status: true,
        position: { select: { code: true } },
        role: { select: { code: true } },
      },
    });
    expect(policies).toHaveLength(EXPECTED_POLICIES.length);
    const got = policies
      .map((p) => ({
        positionCode: p.position.code,
        roleCode: p.role.code,
        scopeMode: p.scopeMode,
      }))
      .sort((a, b) => a.positionCode.localeCompare(b.positionCode));
    expect(got).toEqual(
      [...EXPECTED_POLICIES].sort((a, b) => a.positionCode.localeCompare(b.positionCode)),
    );
    // conditionJson 不用;status 全 ACTIVE
    expect(policies.every((p) => p.conditionJson === null)).toBe(true);
    expect(policies.every((p) => p.status === 'ACTIVE')).toBe(true);
    // org-supervisor 不经职务 policy(分管与职务正交,PR8 由分管推导)
    expect(policies.some((p) => p.role.code === ORG_SUPERVISOR_ROLE_SEED.code)).toBe(false);
  });

  it('3. R5 v0.49:三个副职恰好映射对应只读角色且 scope=TREE', async () => {
    expect(runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'pr7-seed-su-3' }).code).toBe(0);

    const policies = await prisma.organizationPositionRolePolicy.findMany({
      where: {
        position: {
          code: { in: EXPECTED_VICE_POLICIES.map((policy) => policy.positionCode) },
        },
        deletedAt: null,
      },
      select: {
        scopeMode: true,
        position: { select: { code: true } },
        role: { select: { code: true } },
      },
    });
    expect(
      policies
        .map((policy) => ({
          positionCode: policy.position.code,
          roleCode: policy.role.code,
          scopeMode: policy.scopeMode,
        }))
        .sort((a, b) => a.positionCode.localeCompare(b.positionCode)),
    ).toEqual(
      [...EXPECTED_VICE_POLICIES].sort((a, b) => a.positionCode.localeCompare(b.positionCode)),
    );
  });

  it('4. R5 运行时护栏:人为给副职塞管理 policy 后重跑 seed → 非 0 退出', async () => {
    expect(runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'pr7-seed-su-4' }).code).toBe(0);

    const viceCaptain = await prisma.organizationPosition.findUniqueOrThrow({
      where: { code: 'vice-captain' },
      select: { id: true },
    });
    const orgAdmin = await prisma.rbacRole.findUniqueOrThrow({
      where: { code: ORG_ADMIN_ROLE_SEED.code },
      select: { id: true },
    });
    await prisma.organizationPositionRolePolicy.create({
      data: { positionId: viceCaptain.id, roleId: orgAdmin.id },
    });

    const second = runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'pr7-seed-su-4' });
    expect(second.code).not.toBe(0);
    expect(second.stderr).toContain('R5');
  });

  it('5. 只读角色精确同步:重跑 seed 会补回缺失读码并删除脏写码', async () => {
    expect(runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'pr7-seed-su-5' }).code).toBe(0);

    const role = await prisma.rbacRole.findUniqueOrThrow({
      where: { code: ORG_READONLY_ROLE_SEED.code },
      select: { id: true },
    });
    const [readPermission, writePermission] = await Promise.all([
      prisma.permission.findUniqueOrThrow({
        where: { code: 'member.read.record' },
        select: { id: true },
      }),
      prisma.permission.findUniqueOrThrow({
        where: { code: 'member.update.record' },
        select: { id: true },
      }),
    ]);
    await prisma.rolePermission.delete({
      where: { roleId_permissionId: { roleId: role.id, permissionId: readPermission.id } },
    });
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: writePermission.id },
    });

    expect(runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'pr7-seed-su-5' }).code).toBe(0);
    expect(await boundCodesOf(prisma, ORG_READONLY_ROLE_SEED.code)).toEqual(
      [...EXPECTED_ORG_READONLY_CODES].sort(),
    );
  });

  it('6. contract targeted 清理 org/group 残留，保留无关自定义映射与专用角色', async () => {
    expect(runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'pr7-seed-su-6-contract' }).code).toBe(0);

    const [
      orgAdmin,
      groupManager,
      customPermission,
      orgTargetedPermissions,
      groupTargetedPermissions,
    ] = await Promise.all([
      prisma.rbacRole.findUniqueOrThrow({
        where: { code: ORG_ADMIN_ROLE_SEED.code },
        select: { id: true },
      }),
      prisma.rbacRole.findUniqueOrThrow({
        where: { code: GROUP_MANAGER_ROLE_SEED.code },
        select: { id: true },
      }),
      prisma.permission.create({
        data: {
          code: 'test.custom.position-role.keep',
          module: 'test',
          action: 'keep',
          resourceType: 'contract',
        },
        select: { id: true },
      }),
      prisma.permission.findMany({
        where: { code: { in: [...TARGETED_REMOVED_FROM_ORG_CODES] } },
        select: { id: true },
      }),
      prisma.permission.findMany({
        where: { code: { in: [...CONTRACT_REMOVED_FROM_GROUP_CODES] } },
        select: { id: true },
      }),
    ]);
    expect(orgTargetedPermissions).toHaveLength(TARGETED_REMOVED_FROM_ORG_CODES.length);
    expect(groupTargetedPermissions).toHaveLength(CONTRACT_REMOVED_FROM_GROUP_CODES.length);

    await prisma.rolePermission.createMany({
      data: [
        ...orgTargetedPermissions.map((permission) => ({
          roleId: orgAdmin.id,
          permissionId: permission.id,
        })),
        ...groupTargetedPermissions.map((permission) => ({
          roleId: groupManager.id,
          permissionId: permission.id,
        })),
        { roleId: orgAdmin.id, permissionId: customPermission.id },
        { roleId: groupManager.id, permissionId: customPermission.id },
      ],
      skipDuplicates: true,
    });

    expect(runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'pr7-seed-su-6-contract' }).code).toBe(0);
    expect(await boundCodesOf(prisma, ORG_ADMIN_ROLE_SEED.code)).toEqual(
      [...EXPECTED_ORG_ADMIN_CODES, 'test.custom.position-role.keep'].sort(),
    );
    expect(await boundCodesOf(prisma, GROUP_MANAGER_ROLE_SEED.code)).toEqual(
      [...EXPECTED_GROUP_MANAGER_CODES, 'test.custom.position-role.keep'].sort(),
    );
    expect(await boundCodesOf(prisma, 'activity-publish-reviewer')).toEqual(
      [...workflowRoleSeed('activity-publish-reviewer').permissionCodes].sort(),
    );
    expect(await boundCodesOf(prisma, 'attendance-first-reviewer')).toEqual(
      [...workflowRoleSeed('attendance-first-reviewer').permissionCodes].sort(),
    );
    expect(await boundCodesOf(prisma, 'activity-owner')).toEqual(
      [...workflowRoleSeed('activity-owner').permissionCodes].sort(),
    );
    expect(await boundCodesOf(prisma, 'activity-attendance-collaborator')).toEqual(
      [...workflowRoleSeed('activity-attendance-collaborator').permissionCodes].sort(),
    );
    expect(await boundCodesOf(prisma, FINAL_REVIEWER_ROLE_CODE)).toEqual(
      [...EXPECTED_FINAL_REVIEWER_CODES].sort(),
    );
  });

  it('7. 零指派 + 精确增量：职务/分管角色无持有者，既有绑定与 seed 一致', async () => {
    expect(runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'pr7-seed-su-6' }).code).toBe(0);

    // 5 个职务/分管角色零直接持有(判权唯一读源 RoleBinding 全类型;
    // RbacService.can 只读 GLOBAL RoleBinding → 新角色对现有判权零影响)
    const newRoles = await prisma.rbacRole.findMany({
      where: { code: { in: [...NEW_ROLE_CODES] } },
      select: { id: true },
    });
    expect(newRoles).toHaveLength(NEW_ROLE_CODES.length);
    const newRoleIds = newRoles.map((r) => r.id);
    expect(await prisma.roleBinding.count({ where: { roleId: { in: newRoleIds } } })).toBe(0);

    // 既有 3 角色绑定数零漂移
    for (const [code, expected] of [
      [RBAC_SEED_CATALOG.roles.opsAdmin.code, EXPECTED_OPS_ADMIN_BINDING_COUNT],
      [RBAC_SEED_CATALOG.roles.member.code, EXPECTED_MEMBER_ROLE_BINDING_COUNT],
      [RBAC_SEED_CATALOG.roles.bizAdmin.code, EXPECTED_BIZ_ADMIN_BINDING_COUNT],
    ] as const) {
      expect(await prisma.rolePermission.count({ where: { role: { code } } })).toBe(expected);
    }

    // F1 哨兵延伸:7 条 SUPER_ADMIN 保留码不绑任何新角色
    const reservedBindings = await prisma.rolePermission.findMany({
      where: {
        role: { code: { in: [...NEW_ROLE_CODES] } },
        permission: { code: { in: [...RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODES] } },
      },
    });
    expect(reservedBindings).toEqual([]);
  });

  it('8. 幂等:连续两次 seed counts / role id 稳定 + policy updatedAt 不 bump', async () => {
    expect(runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'pr7-seed-su-7' }).code).toBe(0);

    const roleCount1 = await prisma.rbacRole.count();
    const rolePermCount1 = await prisma.rolePermission.count();
    const policyCount1 = await prisma.organizationPositionRolePolicy.count();
    const orgAdmin1 = await prisma.rbacRole.findUniqueOrThrow({
      where: { code: ORG_ADMIN_ROLE_SEED.code },
      select: { id: true },
    });

    expect(runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'pr7-seed-su-7' }).code).toBe(0);

    expect(await prisma.rbacRole.count()).toBe(roleCount1);
    expect(await prisma.rolePermission.count()).toBe(rolePermCount1);
    expect(await prisma.organizationPositionRolePolicy.count()).toBe(policyCount1);
    expect(
      (
        await prisma.rbacRole.findUniqueOrThrow({
          where: { code: ORG_ADMIN_ROLE_SEED.code },
          select: { id: true },
        })
      ).id,
    ).toBe(orgAdmin1.id);

    // update:{} 幂等 → 第二次不 bump updatedAt(updatedAt 恒等于 createdAt = diff 空)
    const policies = await prisma.organizationPositionRolePolicy.findMany({
      select: { createdAt: true, updatedAt: true },
    });
    expect(policies).toHaveLength(EXPECTED_POLICIES.length);
    expect(policies.every((p) => p.updatedAt.getTime() === p.createdAt.getTime())).toBe(true);
  });

  it('9. 三类 reviewer 零 PositionRolePolicy；final reviewer 精确 5 码且零持有', async () => {
    expect(runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'pr9-seed-su-8' }).code).toBe(0);

    // 码集逐码相等(read + 终审两码 + reopen + final-return)。
    expect(await boundCodesOf(prisma, FINAL_REVIEWER_ROLE_CODE)).toEqual(
      [...EXPECTED_FINAL_REVIEWER_CODES].sort(),
    );

    const reviewerRoleCodes = [
      ...ACTIVITY_WORKFLOW_ROLE_SEEDS.filter((role) => role.code.endsWith('reviewer')).map(
        (role) => role.code,
      ),
      FINAL_REVIEWER_ROLE_CODE,
    ];
    const reviewerRoles = await prisma.rbacRole.findMany({
      where: {
        code: {
          in: reviewerRoleCodes,
        },
      },
      select: { id: true, code: true },
    });
    expect(reviewerRoles).toHaveLength(reviewerRoleCodes.length);
    const role = reviewerRoles.find(
      (reviewerRole) => reviewerRole.code === FINAL_REVIEWER_ROLE_CODE,
    )!;
    // 零持有(冻结稿 BD-2:生产绑定 = PR11 公告导入建立真实任职后运营经 role-bindings CRUD 挂;
    // seed 绝不发绑定 —— RoleBinding 全类型)
    expect(await prisma.roleBinding.count({ where: { roleId: role.id } })).toBe(0);
    // 零 policy 行(终审不随职务自动推导,必须显式 RoleBinding;与 org-supervisor 同为非 policy 目标)
    expect(
      await prisma.organizationPositionRolePolicy.count({
        where: { roleId: { in: reviewerRoles.map((reviewerRole) => reviewerRole.id) } },
      }),
    ).toBe(0);
  });
});
