import type { INestApplication } from '@nestjs/common';
import { execSync } from 'child_process';
import { PrismaService } from '../../src/database/prisma.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertTestDatabaseUrl } from '../setup/test-db';

// V2.x C-7 attachments 实施 PR #6a:seed attachment.* permissions + member 内置角色 e2e。
// 沿 D7-attachments v1.0 §6.1 / §10.3 + 用户 PR #6a Q1-Q5 拍板 + seed-rbac.e2e-spec.ts 子进程范式。
//
// 覆盖(沿用户 PR #6a 拍板 e2e 8 项要求):
// 1. 跑 seed 后存在 20 条 attachment.* permission
// 2. 20 条 code 完整一致,无多无少
// 3. 存在 member RbacRole(displayName / description 正确)
// 4. member 角色绑定 9 条 RolePermission
// 5. 9 条映射 code 完整一致(8 .self + activity.view;无 .other / 无 activity 写权限)
// 6. 不存在 ADMIN 内置角色(Q12 v1.0 沿用挂起)
// 7. seed 不自动给任意 user 分配 member 角色(Q2 v1.0)
// 8. seed 连续执行两次完全幂等:permissions count / role id / role-permissions count 不变
//
// 不覆盖(超本 PR 范围):
// - attachments 主模块(留 PR #6b)
// - audit_logs 集成(留 PR #6c)
// - RBAC 业务接入 rbac.can()(留 PR #6b 用此 seed 验证)
// - 真实角色名(.env.seed.local;沿 D7-RBAC F6 / R13)

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

// 沿 prisma/seed.ts 中 ATTACHMENT_PERMISSION_SEED 表(D7-attachments v1.0 §6.1 锁定 20 条);
// 本 spec 维护独立期望集合,与 seed 内部表对照防漂移。
const EXPECTED_ATTACHMENT_PERMISSION_CODES = [
  // member 8 条(4 段)
  'attachment.upload.member.self',
  'attachment.upload.member.other',
  'attachment.view.member.self',
  'attachment.view.member.other',
  'attachment.update.member.self',
  'attachment.update.member.other',
  'attachment.delete.member.self',
  'attachment.delete.member.other',
  // certificate 8 条(4 段)
  'attachment.upload.certificate.self',
  'attachment.upload.certificate.other',
  'attachment.view.certificate.self',
  'attachment.view.certificate.other',
  'attachment.update.certificate.self',
  'attachment.update.certificate.other',
  'attachment.delete.certificate.self',
  'attachment.delete.certificate.other',
  // activity 4 条(3 段;粗粒度)
  'attachment.upload.activity',
  'attachment.view.activity',
  'attachment.update.activity',
  'attachment.delete.activity',
] as const;
const EXPECTED_ATTACHMENT_PERMISSION_COUNT = EXPECTED_ATTACHMENT_PERMISSION_CODES.length;

// member 角色应绑定的 9 条权限点(沿 §6.1 + Q5 v1.0:仅 .self + activity.view)
const EXPECTED_MEMBER_ROLE_PERMISSION_CODES = [
  'attachment.upload.member.self',
  'attachment.view.member.self',
  'attachment.update.member.self',
  'attachment.delete.member.self',
  'attachment.upload.certificate.self',
  'attachment.view.certificate.self',
  'attachment.update.certificate.self',
  'attachment.delete.certificate.self',
  'attachment.view.activity',
] as const;
const EXPECTED_MEMBER_ROLE_PERMISSION_COUNT = EXPECTED_MEMBER_ROLE_PERMISSION_CODES.length;

describe('prisma/seed.ts — attachment permissions and member role', () => {
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

  it('空 db → seed 跑完后 20 条 attachment.* permission 全部存在', async () => {
    const result = runSeed({
      APP_ENV: 'test',
      SUPER_ADMIN_USERNAME: 'atp-seed-su',
      SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
      SUPER_ADMIN_EMAIL: '',
      RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
    });
    expect(result.code).toBe(0);

    // 1 + 2. 20 条 permission 全部存在,code 完整一致
    const perms = await prisma.permission.findMany({
      where: { code: { in: [...EXPECTED_ATTACHMENT_PERMISSION_CODES] } },
      select: { code: true, module: true, resourceType: true },
    });
    expect(perms).toHaveLength(EXPECTED_ATTACHMENT_PERMISSION_COUNT);
    const codes = perms.map((p) => p.code).sort();
    expect(codes).toEqual([...EXPECTED_ATTACHMENT_PERMISSION_CODES].sort());

    // 全部 module=attachment
    expect(perms.every((p) => p.module === 'attachment')).toBe(true);

    // resourceType 分布:8 member + 8 certificate + 4 activity
    const byResourceType = perms.reduce<Record<string, number>>((acc, p) => {
      acc[p.resourceType] = (acc[p.resourceType] ?? 0) + 1;
      return acc;
    }, {});
    expect(byResourceType.member).toBe(8);
    expect(byResourceType.certificate).toBe(8);
    expect(byResourceType.activity).toBe(4);
  });

  it('3 + 4. member RbacRole 存在;displayName / description 正确;绑定 9 条 RolePermission', async () => {
    const result = runSeed({
      APP_ENV: 'test',
      SUPER_ADMIN_USERNAME: 'atp-seed-su-2',
      SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
      SUPER_ADMIN_EMAIL: '',
      RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
    });
    expect(result.code).toBe(0);

    const memberRole = await prisma.rbacRole.findUnique({
      where: { code: 'member' },
      select: { id: true, displayName: true, description: true, deletedAt: true },
    });
    expect(memberRole).not.toBeNull();
    expect(memberRole!.deletedAt).toBeNull();
    expect(memberRole!.displayName).toBe('队员(USER 内置;运营可重命名)');
    expect(memberRole!.description).toBe(
      'USER 内置角色 placeholder;持有本人附件权限与 activity.view 权限',
    );

    // 4. 绑定 9 条 RolePermission
    const rolePerms = await prisma.rolePermission.findMany({
      where: { roleId: memberRole!.id },
      select: { permission: { select: { code: true } } },
    });
    expect(rolePerms).toHaveLength(EXPECTED_MEMBER_ROLE_PERMISSION_COUNT);
  });

  it('5. 9 条映射 code 完整一致;无 .other / 无 activity 写权限', async () => {
    const result = runSeed({
      APP_ENV: 'test',
      SUPER_ADMIN_USERNAME: 'atp-seed-su-3',
      SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
      SUPER_ADMIN_EMAIL: '',
      RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
    });
    expect(result.code).toBe(0);

    const memberRole = await prisma.rbacRole.findUniqueOrThrow({
      where: { code: 'member' },
      select: { id: true },
    });
    const rolePerms = await prisma.rolePermission.findMany({
      where: { roleId: memberRole.id },
      select: { permission: { select: { code: true } } },
    });
    const boundCodes = rolePerms.map((rp) => rp.permission.code).sort();
    expect(boundCodes).toEqual([...EXPECTED_MEMBER_ROLE_PERMISSION_CODES].sort());

    // 显式断言:不含任何 .other 权限点
    expect(boundCodes.filter((c) => c.endsWith('.other'))).toEqual([]);

    // 显式断言:activity 段仅含 .view,不含 .upload / .update / .delete
    const activityBound = boundCodes.filter((c) => c.includes('.activity'));
    expect(activityBound).toEqual(['attachment.view.activity']);
  });

  it('6. 不存在 ADMIN 内置角色(Q12 v1.0 沿用挂起)', async () => {
    const result = runSeed({
      APP_ENV: 'test',
      SUPER_ADMIN_USERNAME: 'atp-seed-su-4',
      SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
      SUPER_ADMIN_EMAIL: '',
      RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
    });
    expect(result.code).toBe(0);

    // 显式断言:RbacRole 表中**不存在** code='admin' 的角色
    const adminRole = await prisma.rbacRole.findUnique({
      where: { code: 'admin' },
      select: { id: true },
    });
    expect(adminRole).toBeNull();

    // 也不存在 ADMIN(大写)
    const adminUpperRole = await prisma.rbacRole.findUnique({
      where: { code: 'ADMIN' },
      select: { id: true },
    });
    expect(adminUpperRole).toBeNull();
  });

  it('7. seed 不自动给任意 user 分配 member 角色(Q2 v1.0:角色分配走 POST /api/v2/users/:userId/roles)', async () => {
    const result = runSeed({
      APP_ENV: 'test',
      SUPER_ADMIN_USERNAME: 'atp-seed-su-5',
      SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
      SUPER_ADMIN_EMAIL: '',
      RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
    });
    expect(result.code).toBe(0);

    const memberRole = await prisma.rbacRole.findUniqueOrThrow({
      where: { code: 'member' },
      select: { id: true },
    });

    // 显式断言:UserRole 表中**没有任何** user 持有 member 角色
    const memberHolderCount = await prisma.userRole.count({
      where: { roleId: memberRole.id },
    });
    expect(memberHolderCount).toBe(0);

    // 对照:同次 seed 已自动给 SUPER_ADMIN 绑定 ops-admin(seedRbac fallback),证明 user 创建+seed 跑过
    const opsAdminRole = await prisma.rbacRole.findUniqueOrThrow({
      where: { code: 'ops-admin' },
      select: { id: true },
    });
    const opsAdminHolderCount = await prisma.userRole.count({
      where: { roleId: opsAdminRole.id },
    });
    expect(opsAdminHolderCount).toBeGreaterThanOrEqual(1);
  });

  it('8. seed 连续执行两次完全幂等:permissions / member role id / role-permissions 不变', async () => {
    // 第一次 seed
    const first = runSeed({
      APP_ENV: 'test',
      SUPER_ADMIN_USERNAME: 'atp-seed-idem',
      SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
      SUPER_ADMIN_EMAIL: '',
      RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
    });
    expect(first.code).toBe(0);

    const perms1 = await prisma.permission.count({
      where: { code: { in: [...EXPECTED_ATTACHMENT_PERMISSION_CODES] } },
    });
    const memberRole1 = await prisma.rbacRole.findUniqueOrThrow({
      where: { code: 'member' },
      select: { id: true, createdAt: true },
    });
    const rolePerms1 = await prisma.rolePermission.count({
      where: { roleId: memberRole1.id },
    });

    expect(perms1).toBe(EXPECTED_ATTACHMENT_PERMISSION_COUNT);
    expect(rolePerms1).toBe(EXPECTED_MEMBER_ROLE_PERMISSION_COUNT);

    // 第二次 seed(同 user;预期 user already exists)
    const second = runSeed({
      APP_ENV: 'test',
      SUPER_ADMIN_USERNAME: 'atp-seed-idem',
      SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
      SUPER_ADMIN_EMAIL: '',
      RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
    });
    expect(second.code).toBe(0);

    // 数量不变
    const perms2 = await prisma.permission.count({
      where: { code: { in: [...EXPECTED_ATTACHMENT_PERMISSION_CODES] } },
    });
    expect(perms2).toBe(EXPECTED_ATTACHMENT_PERMISSION_COUNT);

    // member role id 不变(upsert 幂等)
    const memberRole2 = await prisma.rbacRole.findUniqueOrThrow({
      where: { code: 'member' },
      select: { id: true, createdAt: true },
    });
    expect(memberRole2.id).toBe(memberRole1.id);
    // createdAt 也不变(upsert 不应该更新 createdAt)
    expect(memberRole2.createdAt.toISOString()).toBe(memberRole1.createdAt.toISOString());

    // RolePermission 数量不变
    const rolePerms2 = await prisma.rolePermission.count({
      where: { roleId: memberRole2.id },
    });
    expect(rolePerms2).toBe(EXPECTED_MEMBER_ROLE_PERMISSION_COUNT);
  });
});
