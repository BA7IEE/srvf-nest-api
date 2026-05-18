import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/database/prisma.service';
import { RbacCacheService } from '../../src/modules/permissions/rbac-cache.service';

// P0-F PR-1(2026-05-18)初版;P0-F PR-2A(2026-05-18)扩展至 33 条;
// P0-F PR-2B(2026-05-18)扩展至 48 条(ops-admin 绑 47 条,凭证 reset 不绑;沿 D2=A)。
//
// 背景:test/setup/reset-db.ts 把 RBAC 4 表清空(沿 PR #3),所以 prisma/seed.ts 跑的
// 48 条 permissions(14 rbac.* + 19 PR-2A + 15 PR-2B)+ ops-admin 角色不在 e2e 数据库里。
// 本 fixture 在 spec 的 beforeAll 里调用,把 48 条全集 seed 进去 + 47 条绑给 ops-admin
//(`storage-setting.reset.credentials` 加入 permission.upsert 但**不**进 rolePermission.createMany;
// 沿 D2=A 凭证收紧;evaluator 走 SUPER_ADMIN 短路),供 RBAC 元接口与 PR-2A / PR-2B
// 配置类接口 e2e 使用。
//
// **设计**:
// - seedRbacPermissionsAndOpsAdmin:幂等 upsert 48 条 + ops-admin 角色 + 47 条 RolePermission 绑定;
//   返 { opsAdminRoleId, rbacPermissionCount } 便于 inline grant
// - grantOpsAdminToUser:给 user 绑 ops-admin + 主动 invalidateUser cache(模拟 reload)
// - revokeOpsAdminFromUser:撤回 + invalidateUser cache(沿对称范式)
//
// **D2=A 凭证收紧验证**:storage-settings.e2e 单独断言
// "ADMIN+ops-admin 调 reset-credentials → 30100" / "SUPER_ADMIN → 200"。

export interface RbacSeedResult {
  opsAdminRoleId: string;
  rbacPermissionCount: number; // PR-2B 后 = 48(Permission 总数;含 reset.credentials)
  opsAdminRolePermissionCount: number; // PR-2B 后 = 47(ops-admin 绑定数;不含 reset.credentials)
}

// D2=A:`storage-setting.reset.credentials` 不绑 ops-admin(SA 短路;沿评审稿 §5.2 / §6.2)
const RESET_CREDENTIALS_CODE = 'storage-setting.reset.credentials';

// 沿 prisma/seed.ts ALL_PERMISSION_SEED(48 条;14 rbac.* + 19 PR-2A + 15 PR-2B)。
// PR-2A 19 条 = dict 8 + org 4 + member-department 3 + contribution 4(沿评审稿 §4.2)。
// PR-2B 15 条 = attachment-config 12 + storage-setting 3(沿评审稿 §4.3)。
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
  // ============ 12 条 attachment-config.*(PR-2B;沿评审稿 §4.3)============
  {
    code: 'attachment-config.read.type',
    module: 'attachment-config',
    action: 'read',
    resourceType: 'type',
  },
  {
    code: 'attachment-config.create.type',
    module: 'attachment-config',
    action: 'create',
    resourceType: 'type',
  },
  {
    code: 'attachment-config.update.type',
    module: 'attachment-config',
    action: 'update',
    resourceType: 'type',
  },
  {
    code: 'attachment-config.delete.type',
    module: 'attachment-config',
    action: 'delete',
    resourceType: 'type',
  },
  {
    code: 'attachment-config.read.mime',
    module: 'attachment-config',
    action: 'read',
    resourceType: 'mime',
  },
  {
    code: 'attachment-config.create.mime',
    module: 'attachment-config',
    action: 'create',
    resourceType: 'mime',
  },
  {
    code: 'attachment-config.update.mime',
    module: 'attachment-config',
    action: 'update',
    resourceType: 'mime',
  },
  {
    code: 'attachment-config.delete.mime',
    module: 'attachment-config',
    action: 'delete',
    resourceType: 'mime',
  },
  {
    code: 'attachment-config.read.size-limit',
    module: 'attachment-config',
    action: 'read',
    resourceType: 'size-limit',
  },
  {
    code: 'attachment-config.create.size-limit',
    module: 'attachment-config',
    action: 'create',
    resourceType: 'size-limit',
  },
  {
    code: 'attachment-config.update.size-limit',
    module: 'attachment-config',
    action: 'update',
    resourceType: 'size-limit',
  },
  {
    code: 'attachment-config.delete.size-limit',
    module: 'attachment-config',
    action: 'delete',
    resourceType: 'size-limit',
  },
  // ============ 3 条 storage-setting.*(PR-2B;沿评审稿 §4.3;reset.credentials 沿 D2=A 不绑 ops-admin)============
  {
    code: 'storage-setting.read.singleton',
    module: 'storage-setting',
    action: 'read',
    resourceType: 'singleton',
  },
  {
    code: 'storage-setting.update.singleton',
    module: 'storage-setting',
    action: 'update',
    resourceType: 'singleton',
  },
  {
    code: RESET_CREDENTIALS_CODE,
    module: 'storage-setting',
    action: 'reset',
    resourceType: 'credentials',
  },
] as const;

// 在 e2e 的 beforeAll 调用一次,seed 48 条(14 rbac.* + 19 PR-2A + 15 PR-2B)+ ops-admin 角色 +
// 47 条 RolePermission 绑定(过滤 `storage-setting.reset.credentials`;沿 D2=A)。
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
  // 按 code 精确取本 fixture 声明的 48 条(避免被其它 spec 在同一 DB 注入的 attachment.* 干扰)
  const seeded = await prisma.permission.findMany({
    where: { code: { in: RBAC_PERMISSIONS.map((p) => p.code) } },
    select: { id: true, code: true },
  });
  // D2=A:绑给 ops-admin 时过滤 `storage-setting.reset.credentials`(凭证仅 SA 短路通过)
  const opsAdminBindings = seeded.filter((p) => p.code !== RESET_CREDENTIALS_CODE);
  await prisma.rolePermission.createMany({
    data: opsAdminBindings.map((p) => ({ roleId: opsAdmin.id, permissionId: p.id })),
    skipDuplicates: true,
  });
  return {
    opsAdminRoleId: opsAdmin.id,
    rbacPermissionCount: seeded.length,
    opsAdminRolePermissionCount: opsAdminBindings.length,
  };
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
