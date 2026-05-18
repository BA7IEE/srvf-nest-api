import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import { execSync } from 'child_process';
import { PrismaService } from '../../src/database/prisma.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertTestDatabaseUrl } from '../setup/test-db';

// V2.x C-6 RBAC 实施 PR #8:seed RBAC bootstrap e2e。
// 沿 D7 v1.1 §10 + 用户拍板六项决策 + 既有 seed.e2e-spec.ts 子进程范式。
//
// 覆盖(沿用户决策方案 B):
// 1. 空 db → seed 后 33 条 permission 全部存在(14 rbac.* + 19 PR-2A,2026-05-18)
// 2. ops-admin RbacRole 存在
// 3. ops-admin 绑定全部 33 条(14 rbac.* + 19 PR-2A 沿 D1=A 全绑)的 RolePermission
// 4. 至少 1 个 user_role 持有 ops-admin(强校验通过)
// 5. fallback 路径:无 RBAC_INITIAL_OPS_ADMIN_USER_ID 时绑到 SUPER_ADMIN
// 6. 连续跑两次 seed 完全幂等:Permission / RbacRole / RolePermission / UserRole 数量不重复
// 7. RBAC_INITIAL_OPS_ADMIN_USER_ID env 指定路径:绑到指定 user 而非 SUPER_ADMIN
// 8. RBAC_INITIAL_OPS_ADMIN_USER_ID 指定不存在的 userId → seed 失败(throw)
//
// 不覆盖(留 D7 §11.2 audit 后续 PR):
// - seed 是否落 audit_logs(本 PR 决策方案 A:不落)

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
    const e = err as {
      status?: number | null;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    return {
      code: e.status ?? -1,
      stdout: typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString() ?? ''),
      stderr: typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString() ?? ''),
    };
  }
}

// 沿 prisma/seed.ts 中 OPS_ADMIN_PERMISSION_SEED 表(D7 v1.1 §10.2 14 rbac.* + P0-F PR-2A 19);
// 本 spec 维护独立期望集合,与 seed 内部表对照防漂移。
// PR-2A(2026-05-18):新增 19 条配置类(dict 8 + org 4 + member-department 3 + contribution 4);
// 全部绑给 ops-admin(D1=A);D3=A 软删放宽;D4=A set/clear。
const EXPECTED_RBAC_PERMISSION_CODES = [
  // 14 条 rbac.*(沿 PR-1 #132)
  'rbac.permission.read',
  'rbac.permission.create',
  'rbac.permission.update',
  'rbac.permission.delete',
  'rbac.role.read',
  'rbac.role.create',
  'rbac.role.update',
  'rbac.role.delete',
  'rbac.role-permission.create',
  'rbac.role-permission.delete',
  'rbac.user-role.read',
  'rbac.user-role.create',
  'rbac.user-role.delete',
  'rbac.config.reload',
  // 8 条 dict.*(PR-2A)
  'dict.read.type',
  'dict.create.type',
  'dict.update.type',
  'dict.delete.type',
  'dict.read.item',
  'dict.create.item',
  'dict.update.item',
  'dict.delete.item',
  // 4 条 org.*(PR-2A)
  'org.read.node',
  'org.create.node',
  'org.update.node',
  'org.delete.node',
  // 3 条 member-department.*(PR-2A;D4=A)
  'member-department.read.current',
  'member-department.set.current',
  'member-department.clear.current',
  // 4 条 contribution.*(PR-2A)
  'contribution.read.rule',
  'contribution.create.rule',
  'contribution.update.rule',
  'contribution.delete.rule',
] as const;
const EXPECTED_PERMISSION_COUNT = EXPECTED_RBAC_PERMISSION_CODES.length;
const EXPECTED_RBAC_ONLY_COUNT = 14; // 仅 rbac.* 段位,供下面 module=rbac 断言用

describe('prisma/seed.ts — RBAC bootstrap', () => {
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

  it('空 db + 合法 env → 33 条 permission(14 rbac + 19 PR-2A) + ops-admin role + 33 条 role-permission + 强校验通过', async () => {
    const result = runSeed({
      APP_ENV: 'test',
      SUPER_ADMIN_USERNAME: 'rbac-seed-su',
      SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
      SUPER_ADMIN_EMAIL: '',
      RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
    });
    expect(result.code).toBe(0);

    // 1. 33 条 permission 全部存在(14 rbac.* + 19 PR-2A)
    const perms = await prisma.permission.findMany({
      where: { code: { in: [...EXPECTED_RBAC_PERMISSION_CODES] } },
      select: { code: true, module: true, resourceType: true },
    });
    expect(perms).toHaveLength(EXPECTED_PERMISSION_COUNT);
    const codes = perms.map((p) => p.code).sort();
    expect(codes).toEqual([...EXPECTED_RBAC_PERMISSION_CODES].sort());

    // module 分布:14 rbac + 19 PR-2A(dict/org/member-department/contribution)
    const rbacOnly = perms.filter((p) => p.module === 'rbac');
    expect(rbacOnly).toHaveLength(EXPECTED_RBAC_ONLY_COUNT);
    // PR-2A 4 module 至少各 1 条
    expect(perms.some((p) => p.module === 'dict')).toBe(true);
    expect(perms.some((p) => p.module === 'org')).toBe(true);
    expect(perms.some((p) => p.module === 'member-department')).toBe(true);
    expect(perms.some((p) => p.module === 'contribution')).toBe(true);

    // 2. ops-admin role 存在
    const opsAdmin = await prisma.rbacRole.findUnique({
      where: { code: 'ops-admin' },
      select: { id: true, displayName: true, deletedAt: true },
    });
    expect(opsAdmin).not.toBeNull();
    expect(opsAdmin!.deletedAt).toBeNull();
    expect(opsAdmin!.displayName).toBe('运营管理员');

    // 3. ops-admin 绑定 33 条 role-permission(14 rbac.* + 19 PR-2A;沿 D1=A 全绑)
    const rolePerms = await prisma.rolePermission.findMany({
      where: { roleId: opsAdmin!.id },
      select: { permission: { select: { code: true } } },
    });
    expect(rolePerms).toHaveLength(EXPECTED_PERMISSION_COUNT);
    const boundCodes = rolePerms.map((rp) => rp.permission.code).sort();
    expect(boundCodes).toEqual([...EXPECTED_RBAC_PERMISSION_CODES].sort());

    // 4. 至少 1 个 user_role 持有 ops-admin(强校验)
    const opsAdminHolderCount = await prisma.userRole.count({
      where: {
        role: { code: 'ops-admin', deletedAt: null },
        user: { deletedAt: null, status: UserStatus.ACTIVE },
      },
    });
    expect(opsAdminHolderCount).toBeGreaterThanOrEqual(1);
  });

  it('fallback 路径:RBAC_INITIAL_OPS_ADMIN_USER_ID 留空 → 绑到 SUPER_ADMIN(本 seed 刚创建的)', async () => {
    const result = runSeed({
      APP_ENV: 'test',
      SUPER_ADMIN_USERNAME: 'rbac-seed-fallback',
      SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
      SUPER_ADMIN_EMAIL: '',
      RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('source=SUPER_ADMIN fallback');

    const su = await prisma.user.findUniqueOrThrow({
      where: { username: 'rbac-seed-fallback' },
      select: { id: true },
    });
    const opsAdmin = await prisma.rbacRole.findUniqueOrThrow({
      where: { code: 'ops-admin' },
      select: { id: true },
    });
    const userRole = await prisma.userRole.findUnique({
      where: { userId_roleId: { userId: su.id, roleId: opsAdmin.id } },
    });
    expect(userRole).not.toBeNull();
  });

  it('env 路径:RBAC_INITIAL_OPS_ADMIN_USER_ID 指定已有 user → 绑到该 user 而非 SUPER_ADMIN', async () => {
    // 先用 fallback 路径建出 SUPER_ADMIN + ops-admin role
    const first = runSeed({
      APP_ENV: 'test',
      SUPER_ADMIN_USERNAME: 'rbac-seed-env-su',
      SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
      SUPER_ADMIN_EMAIL: '',
      RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
    });
    expect(first.code).toBe(0);

    // 再造一个普通 user 作为 env 指定目标
    const target = await prisma.user.create({
      data: {
        username: 'rbac-seed-env-target',
        passwordHash: '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy',
        role: Role.USER,
        status: UserStatus.ACTIVE,
      },
      select: { id: true },
    });

    // 清掉已有的 ops-admin user_role(避免和 fallback 创建的混淆),仅观察 env 路径效果
    await prisma.userRole.deleteMany({});

    const second = runSeed({
      APP_ENV: 'test',
      SUPER_ADMIN_USERNAME: 'rbac-seed-env-su',
      SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
      SUPER_ADMIN_EMAIL: '',
      RBAC_INITIAL_OPS_ADMIN_USER_ID: target.id,
    });
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('source=env RBAC_INITIAL_OPS_ADMIN_USER_ID');

    const opsAdmin = await prisma.rbacRole.findUniqueOrThrow({
      where: { code: 'ops-admin' },
      select: { id: true },
    });
    const userRole = await prisma.userRole.findUnique({
      where: { userId_roleId: { userId: target.id, roleId: opsAdmin.id } },
    });
    expect(userRole).not.toBeNull();
  });

  it('env 指定不存在的 userId → seed 失败 throw,exit ≠ 0', async () => {
    // 先用 fallback 路径建 SUPER_ADMIN(否则 SUPER_ADMIN 校验先失败,无法触达 RBAC 路径)
    // 但这次仅是为了触发 env 校验失败 — SUPER_ADMIN 已存在不影响 RBAC env 校验路径
    const result = runSeed({
      APP_ENV: 'test',
      SUPER_ADMIN_USERNAME: 'rbac-seed-bad-env',
      SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
      SUPER_ADMIN_EMAIL: '',
      RBAC_INITIAL_OPS_ADMIN_USER_ID: 'nonexistent000000000000000000',
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr.toLowerCase()).toMatch(/rbac_initial_ops_admin_user_id|bootstrap/);
  });

  it('幂等:连续跑两次 seed 数量不变(33 / 1 / 33 / 1)', async () => {
    // 第一次
    const first = runSeed({
      APP_ENV: 'test',
      SUPER_ADMIN_USERNAME: 'rbac-seed-idem',
      SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
      SUPER_ADMIN_EMAIL: '',
      RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
    });
    expect(first.code).toBe(0);

    const opsAdminAfter1 = await prisma.rbacRole.findUniqueOrThrow({
      where: { code: 'ops-admin' },
      select: { id: true, createdAt: true },
    });
    const permCountAfter1 = await prisma.permission.count();
    const rolePermCountAfter1 = await prisma.rolePermission.count({
      where: { roleId: opsAdminAfter1.id },
    });
    const userRoleCountAfter1 = await prisma.userRole.count({
      where: { roleId: opsAdminAfter1.id },
    });

    // 第二次:相同 env,seed 应全部 no-op
    const second = runSeed({
      APP_ENV: 'test',
      SUPER_ADMIN_USERNAME: 'rbac-seed-idem',
      SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
      SUPER_ADMIN_EMAIL: '',
      RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
    });
    expect(second.code).toBe(0);

    const opsAdminAfter2 = await prisma.rbacRole.findUniqueOrThrow({
      where: { code: 'ops-admin' },
      select: { id: true, createdAt: true },
    });
    expect(opsAdminAfter2.id).toBe(opsAdminAfter1.id);
    // createdAt 不变 = 第二次走 update: {} 没有重建
    expect(opsAdminAfter2.createdAt.toISOString()).toBe(opsAdminAfter1.createdAt.toISOString());

    expect(await prisma.permission.count()).toBe(permCountAfter1);
    expect(await prisma.rolePermission.count({ where: { roleId: opsAdminAfter1.id } })).toBe(
      rolePermCountAfter1,
    );
    expect(await prisma.userRole.count({ where: { roleId: opsAdminAfter1.id } })).toBe(
      userRoleCountAfter1,
    );
  });
});
