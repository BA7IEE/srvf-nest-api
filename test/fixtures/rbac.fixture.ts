import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/database/prisma.service';
import { RbacCacheService } from '../../src/modules/permissions/rbac-cache.service';

// P0-F PR-1(2026-05-18)初版;P0-F PR-2A(2026-05-18)扩展至 33 条。
//
// 背景:test/setup/reset-db.ts 把 RBAC 4 表清空(沿 PR #3),所以 prisma/seed.ts 跑的
// 33 条 permissions(14 rbac.* + 19 PR-2A)+ ops-admin 角色不在 e2e 数据库里。本 fixture 在 spec 的
// beforeAll 里调用,把 33 条全集 seed 进去 + 全部绑给 ops-admin,供 RBAC 元接口与 PR-2A 配置类
// 接口 e2e 使用。
//
// **设计**:
// - seedRbacPermissionsAndOpsAdmin:幂等 upsert 33 条 + ops-admin 角色 + 全量 RolePermission 绑定;
//   返 { opsAdminRoleId, rbacPermissionCount } 便于 inline grant
// - grantOpsAdminToUser:给 user 绑 ops-admin + 主动 invalidateUser cache(模拟 reload)
// - revokeOpsAdminFromUser:撤回 + invalidateUser cache(沿对称范式)
//
// **不做**(沿 P0-F PR-2A 边界):
// - 不为 PR-2B(attachment-config / storage-setting)预 seed,留 PR-2B 启动时扩展
// - 不动 resetDb 顺序(RBAC 4 表 TRUNCATE 仍按原 truncate 序)

export interface RbacSeedResult {
  opsAdminRoleId: string;
  rbacPermissionCount: number; // PR-2A 后 = 33(14 rbac.* + 19 PR-2A)
}

// 沿 prisma/seed.ts OPS_ADMIN_PERMISSION_SEED(33 条;14 rbac.* + 19 PR-2A;一致绑定到 ops-admin)。
// PR-2A 19 条 = dict 8 + org 4 + member-department 3 + contribution 4(沿评审稿 §4.2)。
const RBAC_PERMISSIONS = [
  // ============ 14 条 rbac.*(沿 PR-1 #132)============
  { code: 'rbac.permission.read', module: 'rbac', action: 'read', resourceType: 'permission' },
  { code: 'rbac.permission.create', module: 'rbac', action: 'create', resourceType: 'permission' },
  { code: 'rbac.permission.update', module: 'rbac', action: 'update', resourceType: 'permission' },
  { code: 'rbac.permission.delete', module: 'rbac', action: 'delete', resourceType: 'permission' },
  { code: 'rbac.role.read', module: 'rbac', action: 'read', resourceType: 'role' },
  { code: 'rbac.role.create', module: 'rbac', action: 'create', resourceType: 'role' },
  { code: 'rbac.role.update', module: 'rbac', action: 'update', resourceType: 'role' },
  { code: 'rbac.role.delete', module: 'rbac', action: 'delete', resourceType: 'role' },
  {
    code: 'rbac.role-permission.create',
    module: 'rbac',
    action: 'create',
    resourceType: 'role-permission',
  },
  {
    code: 'rbac.role-permission.delete',
    module: 'rbac',
    action: 'delete',
    resourceType: 'role-permission',
  },
  { code: 'rbac.user-role.read', module: 'rbac', action: 'read', resourceType: 'user-role' },
  { code: 'rbac.user-role.create', module: 'rbac', action: 'create', resourceType: 'user-role' },
  { code: 'rbac.user-role.delete', module: 'rbac', action: 'delete', resourceType: 'user-role' },
  { code: 'rbac.config.reload', module: 'rbac', action: 'reload', resourceType: 'config' },
  // ============ 8 条 dict.*(PR-2A;D3=A 软删放宽)============
  { code: 'dict.read.type', module: 'dict', action: 'read', resourceType: 'type' },
  { code: 'dict.create.type', module: 'dict', action: 'create', resourceType: 'type' },
  { code: 'dict.update.type', module: 'dict', action: 'update', resourceType: 'type' },
  { code: 'dict.delete.type', module: 'dict', action: 'delete', resourceType: 'type' },
  { code: 'dict.read.item', module: 'dict', action: 'read', resourceType: 'item' },
  { code: 'dict.create.item', module: 'dict', action: 'create', resourceType: 'item' },
  { code: 'dict.update.item', module: 'dict', action: 'update', resourceType: 'item' },
  { code: 'dict.delete.item', module: 'dict', action: 'delete', resourceType: 'item' },
  // ============ 4 条 org.*(PR-2A;D3=A 软删放宽)============
  { code: 'org.read.node', module: 'org', action: 'read', resourceType: 'node' },
  { code: 'org.create.node', module: 'org', action: 'create', resourceType: 'node' },
  { code: 'org.update.node', module: 'org', action: 'update', resourceType: 'node' },
  { code: 'org.delete.node', module: 'org', action: 'delete', resourceType: 'node' },
  // ============ 3 条 member-department.*(PR-2A;D4=A set/clear)============
  {
    code: 'member-department.read.current',
    module: 'member-department',
    action: 'read',
    resourceType: 'current',
  },
  {
    code: 'member-department.set.current',
    module: 'member-department',
    action: 'set',
    resourceType: 'current',
  },
  {
    code: 'member-department.clear.current',
    module: 'member-department',
    action: 'clear',
    resourceType: 'current',
  },
  // ============ 4 条 contribution.*(PR-2A)============
  { code: 'contribution.read.rule', module: 'contribution', action: 'read', resourceType: 'rule' },
  {
    code: 'contribution.create.rule',
    module: 'contribution',
    action: 'create',
    resourceType: 'rule',
  },
  {
    code: 'contribution.update.rule',
    module: 'contribution',
    action: 'update',
    resourceType: 'rule',
  },
  {
    code: 'contribution.delete.rule',
    module: 'contribution',
    action: 'delete',
    resourceType: 'rule',
  },
] as const;

// 在 e2e 的 beforeAll 调用一次,seed 33 条(14 rbac.* + 19 PR-2A)+ ops-admin 角色 + 全量
// RolePermission 绑定。幂等:多次调用不出错(用 upsert 写)。
export async function seedRbacPermissionsAndOpsAdmin(
  app: INestApplication,
): Promise<RbacSeedResult> {
  const prisma = app.get(PrismaService);
  for (const p of RBAC_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code: p.code },
      update: {},
      create: { code: p.code, module: p.module, action: p.action, resourceType: p.resourceType },
    });
  }
  const opsAdmin = await prisma.rbacRole.upsert({
    where: { code: 'ops-admin' },
    update: {},
    create: { code: 'ops-admin', displayName: '运营管理员' },
    select: { id: true },
  });
  // 按 code 精确取本 fixture 声明的 33 条(避免被其它 spec 在同一 DB 注入的 attachment.* 干扰)
  const seeded = await prisma.permission.findMany({
    where: { code: { in: RBAC_PERMISSIONS.map((p) => p.code) } },
    select: { id: true },
  });
  await prisma.rolePermission.createMany({
    data: seeded.map((p) => ({ roleId: opsAdmin.id, permissionId: p.id })),
    skipDuplicates: true,
  });
  return { opsAdminRoleId: opsAdmin.id, rbacPermissionCount: seeded.length };
}

// 给 user 绑 ops-admin + 主动失效缓存(模拟运行时"绑角色后 POST /rbac/reload"流程)。
export async function grantOpsAdminToUser(
  app: INestApplication,
  userId: string,
  opsAdminRoleId: string,
): Promise<void> {
  const prisma = app.get(PrismaService);
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId, roleId: opsAdminRoleId } },
    update: {},
    create: { userId, roleId: opsAdminRoleId },
  });
  app.get(RbacCacheService).invalidateUser(userId);
}

// 撤回 ops-admin + 失效缓存(对称范式)。
export async function revokeOpsAdminFromUser(
  app: INestApplication,
  userId: string,
  opsAdminRoleId: string,
): Promise<void> {
  const prisma = app.get(PrismaService);
  await prisma.userRole
    .delete({ where: { userId_roleId: { userId, roleId: opsAdminRoleId } } })
    .catch(() => {
      /* 关系不存在 — 静默 */
    });
  app.get(RbacCacheService).invalidateUser(userId);
}
