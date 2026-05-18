import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/database/prisma.service';
import { RbacCacheService } from '../../src/modules/permissions/rbac-cache.service';

// P0-F PR-1(2026-05-18):RBAC 元接口判权 e2e 共享 fixture。
//
// 背景:test/setup/reset-db.ts 把 RBAC 4 表清空(沿 PR #3),所以 prisma/seed.ts 跑的
// 14 条 rbac.* permissions + ops-admin 角色不在 e2e 数据库里。本 fixture 在 spec 的
// beforeAll 里调用,把 14 条 rbac.* 全集 seed 进去,供 RBAC 元接口 e2e 使用。
//
// **设计**:
// - seedRbacPermissions:幂等 upsert 14 条 rbac.*;返 { roleId, allRbacPerms } 便于 inline grant
// - grantOpsAdminToUser:给 user 绑 ops-admin + 主动 invalidateUser cache(模拟 reload)
// - revokeOpsAdminFromUser:撤回 + invalidateUser cache(沿对称范式)
//
// **不做**(沿 P0-F PR-1 边界):
// - 不动 prisma/seed.ts(seed 是 prod / docker bootstrap 入口,不应被 e2e 影响)
// - 不动 resetDb 顺序(RBAC 4 表 TRUNCATE 仍按原 truncate 序)

export interface RbacSeedResult {
  opsAdminRoleId: string;
  rbacPermissionCount: number; // 永远 = 14
}

// 沿 prisma/seed.ts RBAC_PERMISSION_SEED(14 条;dash + R/C/U/D 4 段拆分;一致绑定到 ops-admin)
const RBAC_PERMISSIONS = [
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
] as const;

// 在 e2e 的 beforeAll 调用一次,seed 14 条 rbac.* + ops-admin 角色 + 全量 RolePermission 绑定。
// 幂等:多次调用不出错(用 upsert 写)。
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
  const allRbac = await prisma.permission.findMany({
    where: { module: 'rbac' },
    select: { id: true },
  });
  await prisma.rolePermission.createMany({
    data: allRbac.map((p) => ({ roleId: opsAdmin.id, permissionId: p.id })),
    skipDuplicates: true,
  });
  return { opsAdminRoleId: opsAdmin.id, rbacPermissionCount: allRbac.length };
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
