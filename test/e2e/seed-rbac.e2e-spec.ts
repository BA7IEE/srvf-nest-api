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
// 1. 空 db → seed 后 68 条 permission 全部存在(14 rbac.* + 19 PR-2A + 15 PR-2B + 7 PR-3B + 1 PR-4B + 5 SMS + 4 WECHAT + 3 REALNAME)
// 2. ops-admin RbacRole 存在
// 3. ops-admin 绑定 63 条(14 rbac.* + 19 PR-2A + 14 PR-2B + 6 PR-3B + 1 PR-4B + 4 SMS + 3 WECHAT + 2 REALNAME;**不含**
//    storage-setting.reset.credentials(沿 PR-2 D2=A)+ user.update.role(沿 PR-3 D1=A);
//    PR-4B D2=B audit-log.read.entry 整条加入)
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

// 沿 prisma/seed.ts 中 ALL_PERMISSION_SEED 表(D7 v1.1 §10.2 14 rbac.* + P0-F PR-2A 19 + PR-2B 15 + PR-3B 7 + PR-4B 1);
// 本 spec 维护独立期望集合,与 seed 内部表对照防漂移。
// PR-2A(2026-05-18):新增 19 条配置类(dict 8 + org 4 + member-department 3 + contribution 4);
//   全部绑给 ops-admin(D1=A);D3=A 软删放宽;D4=A set/clear。
// PR-2B(2026-05-18):新增 15 条配置类(attachment-config 12 + storage-setting 3);
//   D2=A:storage-setting.reset.credentials 加入 Permission upsert 但**不**绑 ops-admin(SA 短路);
//   其余 14 条全绑 ops-admin。
// PR-3B(2026-05-18):新增 7 条 user 管理(read/create/update/reset/update.role/update.status/delete);
//   D1=A:user.update.role 加入 Permission upsert 但**不**绑 ops-admin(SA 短路);
//   D2=B:user.reset.password 绑 ops-admin;D3=A:其余 5 条全绑;共 6 条 user.* 绑 ops-admin。
// PR-4B(2026-05-18):新增 1 条 audit-log.read.entry(list / findOne 共享 read);
//   D1=A 命名 audit-log.* 单数;D2=B audit-log.read.entry 整条绑 ops-admin(数据范围 service 层兜底);
//   D3=A 不拆 self/other;D4=A list/findOne 共用 code;D5=A 不预留 export/sensitive。
// SMS T2(2026-06-10):新增 5 条(sms-setting 3 + sms-send-log 1 + user.phone.clear;评审稿
//   docs/archive/reviews/sms-verification-infra-review.md §3.4 / E-3);
//   sms-setting.reset.credentials 镜像 D2=A 不绑 ops-admin;其余 4 条绑;76→81 / 54→58。
// WECHAT T2(2026-06-12):新增 4 条(wechat-setting 3 + user.wechat.clear;评审稿
//   docs/archive/reviews/wechat-mini-login-review.md §3.4 / E-22);
//   wechat-setting.reset.credentials 镜像 D2=A 不绑 ops-admin;其余 3 条绑;117→121 / 58→61。
const RESET_CREDENTIALS_CODE = 'storage-setting.reset.credentials';
const USER_UPDATE_ROLE_CODE = 'user.update.role';
const SMS_RESET_CREDENTIALS_CODE = 'sms-setting.reset.credentials';
const WECHAT_RESET_CREDENTIALS_CODE = 'wechat-setting.reset.credentials';
const REALNAME_RESET_CREDENTIALS_CODE = 'realname-setting.reset.credentials';
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
  // 12 条 attachment-config.*(PR-2B)
  'attachment-config.read.type',
  'attachment-config.create.type',
  'attachment-config.update.type',
  'attachment-config.delete.type',
  'attachment-config.read.mime',
  'attachment-config.create.mime',
  'attachment-config.update.mime',
  'attachment-config.delete.mime',
  'attachment-config.read.size-limit',
  'attachment-config.create.size-limit',
  'attachment-config.update.size-limit',
  'attachment-config.delete.size-limit',
  // 3 条 storage-setting.*(PR-2B;reset.credentials 沿 D2=A 不绑 ops-admin)
  'storage-setting.read.singleton',
  'storage-setting.update.singleton',
  RESET_CREDENTIALS_CODE,
  // 7 条 user.*(PR-3B;user.update.role 沿 D1=A 不绑 ops-admin)
  'user.read.account',
  'user.create.account',
  'user.update.account',
  'user.reset.password',
  USER_UPDATE_ROLE_CODE,
  'user.update.status',
  'user.delete.account',
  // 1 条 audit-log.*(PR-4B;D2=B 整条绑 ops-admin;D4=A list/findOne 共用 read)
  'audit-log.read.entry',
  // 5 条 SMS T2(sms-setting.reset.credentials 镜像 D2=A 不绑 ops-admin;评审稿 §3.4)
  'sms-setting.read.singleton',
  'sms-setting.update.singleton',
  SMS_RESET_CREDENTIALS_CODE,
  'sms-send-log.read.list',
  'user.phone.clear',
  // 4 条 WECHAT T2(wechat-setting.reset.credentials 镜像 D2=A 不绑 ops-admin;wechat 评审稿 §3.4)
  'wechat-setting.read.singleton',
  'wechat-setting.update.singleton',
  WECHAT_RESET_CREDENTIALS_CODE,
  'user.wechat.clear',
  // 3 条 REALNAME T1(realname-setting.reset.credentials 镜像 D2=A 不绑 ops-admin;招新评审稿 §3.4)
  'realname-setting.read.singleton',
  'realname-setting.update.singleton',
  REALNAME_RESET_CREDENTIALS_CODE,
] as const;
// Permission 总数(含 reset.credentials + user.update.role;沿 D2=A + D1=A 仍 upsert 进表,仅 SA 短路通过)
const EXPECTED_PERMISSION_COUNT = EXPECTED_RBAC_PERMISSION_CODES.length;
// ops-admin RolePermission 数(过滤 reset.credentials(PR-2 D2=A)+ user.update.role(PR-3 D1=A)
// + sms-setting.reset.credentials(SMS T2 镜像 D2=A)+ wechat-setting.reset.credentials(WECHAT T2)
// + realname-setting.reset.credentials(REALNAME T1 镜像 D2=A,招新评审稿 §3.4)→ 68 - 5 = 63)
const EXPECTED_OPS_ADMIN_ROLE_PERMISSION_COUNT = EXPECTED_PERMISSION_COUNT - 5;
const EXPECTED_OPS_ADMIN_BOUND_CODES = EXPECTED_RBAC_PERMISSION_CODES.filter(
  (c) =>
    c !== RESET_CREDENTIALS_CODE &&
    c !== USER_UPDATE_ROLE_CODE &&
    c !== SMS_RESET_CREDENTIALS_CODE &&
    c !== WECHAT_RESET_CREDENTIALS_CODE &&
    c !== REALNAME_RESET_CREDENTIALS_CODE,
);
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

  it('空 db + 合法 env → 68 条 permission(14 rbac + 19 PR-2A + 15 PR-2B + 7 PR-3B + 1 PR-4B + 5 SMS + 4 WECHAT + 3 REALNAME) + ops-admin role + 63 条 role-permission(D2=A 4 把凭证 reset + D1=A user.update.role 共 5 不绑;D2=B audit-log.read.entry 整条绑) + 强校验通过', async () => {
    const result = runSeed({
      APP_ENV: 'test',
      SUPER_ADMIN_USERNAME: 'rbac-seed-su',
      SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
      SUPER_ADMIN_EMAIL: '',
      RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
    });
    expect(result.code).toBe(0);

    // 1. 68 条 permission 全部存在(14 rbac.* + 19 PR-2A + 15 PR-2B + 7 PR-3B + 1 PR-4B + 5 SMS + 4 WECHAT + 3 REALNAME;
    //    含 4 把 reset.credentials + user.update.role)
    const perms = await prisma.permission.findMany({
      where: { code: { in: [...EXPECTED_RBAC_PERMISSION_CODES] } },
      select: { code: true, module: true, resourceType: true },
    });
    expect(perms).toHaveLength(EXPECTED_PERMISSION_COUNT);
    const codes = perms.map((p) => p.code).sort();
    expect(codes).toEqual([...EXPECTED_RBAC_PERMISSION_CODES].sort());

    // module 分布:14 rbac + 19 PR-2A + 15 PR-2B + 7 PR-3B + 1 PR-4B
    const rbacOnly = perms.filter((p) => p.module === 'rbac');
    expect(rbacOnly).toHaveLength(EXPECTED_RBAC_ONLY_COUNT);
    // PR-2A 4 module 至少各 1 条
    expect(perms.some((p) => p.module === 'dict')).toBe(true);
    expect(perms.some((p) => p.module === 'org')).toBe(true);
    expect(perms.some((p) => p.module === 'member-department')).toBe(true);
    expect(perms.some((p) => p.module === 'contribution')).toBe(true);
    // PR-2B 2 module 至少各 1 条
    expect(perms.some((p) => p.module === 'attachment-config')).toBe(true);
    expect(perms.some((p) => p.module === 'storage-setting')).toBe(true);
    // PR-3B 1 module 至少 1 条
    expect(perms.some((p) => p.module === 'user')).toBe(true);
    // PR-4B 1 module 至少 1 条
    expect(perms.some((p) => p.module === 'audit-log')).toBe(true);
    // D2=A:storage-setting.reset.credentials 加入 Permission upsert(56 条全集);
    // 但下面断言 ops-admin RolePermission 时不含此条(54 条)
    expect(codes).toContain(RESET_CREDENTIALS_CODE);
    // D1=A:user.update.role 同样加入 Permission upsert 但**不**绑 ops-admin(SA 短路)
    expect(codes).toContain(USER_UPDATE_ROLE_CODE);
    // PR-4B D2=B:audit-log.read.entry 整条绑 ops-admin(下方反向断言验证)
    expect(codes).toContain('audit-log.read.entry');

    // 2. ops-admin role 存在
    const opsAdmin = await prisma.rbacRole.findUnique({
      where: { code: 'ops-admin' },
      select: { id: true, displayName: true, deletedAt: true },
    });
    expect(opsAdmin).not.toBeNull();
    expect(opsAdmin!.deletedAt).toBeNull();
    expect(opsAdmin!.displayName).toBe('运营管理员');

    // 3. ops-admin 绑定 63 条 role-permission(14 rbac.* + 19 PR-2A + 14 PR-2B + 6 PR-3B + 1 PR-4B + 4 SMS + 3 WECHAT + 2 REALNAME;
    //    沿 PR-2 D1=A 全绑 + PR-2 D2=A 凭证 reset 不绑 + PR-3 D1=A user.update.role 不绑 +
    //    PR-3 D2=B user.reset.password 绑 + PR-3 D3=A 其余 5 条 user.* 全绑 +
    //    PR-4 D2=B audit-log.read.entry 整条绑;详见 §6.2)
    const rolePerms = await prisma.rolePermission.findMany({
      where: { roleId: opsAdmin!.id },
      select: { permission: { select: { code: true } } },
    });
    expect(rolePerms).toHaveLength(EXPECTED_OPS_ADMIN_ROLE_PERMISSION_COUNT);
    const boundCodes = rolePerms.map((rp) => rp.permission.code).sort();
    expect(boundCodes).toEqual([...EXPECTED_OPS_ADMIN_BOUND_CODES].sort());
    // D2=A 显式反向断言:reset.credentials **不**在 ops-admin RolePermission 中
    expect(boundCodes).not.toContain(RESET_CREDENTIALS_CODE);
    // D1=A 显式反向断言:user.update.role **不**在 ops-admin RolePermission 中
    expect(boundCodes).not.toContain(USER_UPDATE_ROLE_CODE);
    // SMS / WECHAT / REALNAME 镜像 D2=A 显式反向断言:三把凭证 reset 码均**不**在 ops-admin RolePermission 中
    expect(boundCodes).not.toContain(SMS_RESET_CREDENTIALS_CODE);
    expect(boundCodes).not.toContain(WECHAT_RESET_CREDENTIALS_CODE);
    expect(boundCodes).not.toContain(REALNAME_RESET_CREDENTIALS_CODE);
    // PR-4 D2=B 正向断言:audit-log.read.entry **在** ops-admin RolePermission 中
    expect(boundCodes).toContain('audit-log.read.entry');

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

  it('幂等:连续跑两次 seed 数量不变(全表 136 permission / 1 ops-admin role / 63 role-permission / 1 user-role;断言相对稳定)', async () => {
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
