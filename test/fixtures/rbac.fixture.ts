import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/database/prisma.service';
import { RbacCacheService } from '../../src/modules/permissions/rbac-cache.service';

// P0-F PR-1(2026-05-18)初版;P0-F PR-2A(2026-05-18)扩展至 33 条;
// P0-F PR-2B(2026-05-18)扩展至 48 条(ops-admin 绑 47 条,凭证 reset 不绑;沿 PR-2 D2=A);
// P0-F PR-3B(2026-05-18)扩展至 55 条(ops-admin 绑 53 条;凭证 reset + user.update.role 不绑;
// 沿 PR-3 D1=A user.update.role 收紧 + D2=B user.reset.password 放宽 + D3=A 其余 5 条全绑);
// P0-F PR-4B(2026-05-18)扩展至 56 条(ops-admin 绑 54 条;audit-log.read.entry 整条加入;
// 沿 PR-4 D2=B audit-log 读放宽 + D3=A 不拆 self/other + D4=A list/findOne 共用 read)。
//
// 背景:test/setup/reset-db.ts 把 RBAC 4 表清空(沿 PR #3),所以 prisma/seed.ts 跑的
// 56 条 permissions(14 rbac.* + 19 PR-2A + 15 PR-2B + 7 PR-3B + 1 PR-4B)+ ops-admin 角色不在 e2e 数据库里。
// 本 fixture 在 spec 的 beforeAll 里调用,把 56 条全集 seed 进去 + 54 条绑给 ops-admin
//(`storage-setting.reset.credentials` + `user.update.role` 加入 permission.upsert
// 但**不**进 rolePermission.createMany;凭证收紧沿 PR-2 D2=A,角色修改收紧沿 PR-3 D1=A;
// `audit-log.read.entry` 整条加入沿 PR-4 D2=B;evaluator 走 SUPER_ADMIN 短路),
// 供 RBAC 元接口与 PR-2A / PR-2B / PR-3B 配置 + users + PR-4B audit-logs e2e 使用。
//
// **设计**:
// - seedRbacPermissionsAndOpsAdmin:幂等 upsert 56 条 + ops-admin 角色 + 54 条 RolePermission 绑定;
//   返 { opsAdminRoleId, rbacPermissionCount } 便于 inline grant
// - grantOpsAdminToUser:给 user 绑 ops-admin + 主动 invalidateUser cache(模拟 reload)
// - revokeOpsAdminFromUser:撤回 + invalidateUser cache(沿对称范式)
//
// **D2=A 凭证收紧验证**:storage-settings.e2e 单独断言
// "ADMIN+ops-admin 调 reset-credentials → 30100" / "SUPER_ADMIN → 200"。
// **PR-3 D1=A user.update.role 收紧验证**:users-role-boundary.e2e 单独断言
// "ADMIN+ops-admin 调 PATCH /:id/role → 30100" / "SUPER_ADMIN → 200(+ canChangeRole 永禁升 SA)"。
// **PR-4 D2=B audit-log 放宽验证**:audit-logs.e2e 单独断言
// "ADMIN+ops-admin 调 GET /api/v2/audit-logs → 200(数据范围 service 层兜底)"。

export interface RbacSeedResult {
  opsAdminRoleId: string;
  rbacPermissionCount: number; // PR-4B 后 = 56(Permission 总数;含 reset.credentials + user.update.role)
  opsAdminRolePermissionCount: number; // PR-4B 后 = 54(ops-admin 绑定数;不含 reset.credentials + user.update.role)
}

// PR-2 D2=A:`storage-setting.reset.credentials` 不绑 ops-admin(SA 短路;沿评审稿 §5.2 / §6.2)
const RESET_CREDENTIALS_CODE = 'storage-setting.reset.credentials';

// PR-3 D1=A:`user.update.role` 不绑 ops-admin(SA 短路;沿评审稿 §5.1 / §6.2)
const USER_UPDATE_ROLE_CODE = 'user.update.role';

// 沿 prisma/seed.ts ALL_PERMISSION_SEED(56 条;14 rbac.* + 19 PR-2A + 15 PR-2B + 7 PR-3B + 1 PR-4B)。
// PR-2A 19 条 = dict 8 + org 4 + member-department 3 + contribution 4(沿评审稿 §4.2)。
// PR-2B 15 条 = attachment-config 12 + storage-setting 3(沿评审稿 §4.3)。
// PR-3B 7 条 = user 7(read/create/update/reset/update.role/update.status/delete;沿评审稿 §4.2)。
// PR-4B 1 条 = audit-log.read.entry(list / findOne 共享 read;沿评审稿 §4.2 + D4=A)。
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
  // ============ 7 条 user.*(PR-3B;沿评审稿 §4.2;D1=A user.update.role 不绑 ops-admin)============
  { code: 'user.read.account', module: 'user', action: 'read', resourceType: 'account' },
  { code: 'user.create.account', module: 'user', action: 'create', resourceType: 'account' },
  { code: 'user.update.account', module: 'user', action: 'update', resourceType: 'account' },
  { code: 'user.reset.password', module: 'user', action: 'reset', resourceType: 'password' },
  { code: USER_UPDATE_ROLE_CODE, module: 'user', action: 'update', resourceType: 'role' },
  { code: 'user.update.status', module: 'user', action: 'update', resourceType: 'status' },
  { code: 'user.delete.account', module: 'user', action: 'delete', resourceType: 'account' },
  // ============ 1 条 audit-log.*(PR-4B;沿评审稿 §4.2;D2=B 整条绑 ops-admin)============
  { code: 'audit-log.read.entry', module: 'audit-log', action: 'read', resourceType: 'entry' },
] as const;

// 在 e2e 的 beforeAll 调用一次,seed 56 条(14 rbac.* + 19 PR-2A + 15 PR-2B + 7 PR-3B + 1 PR-4B)+ ops-admin 角色 +
// 54 条 RolePermission 绑定(过滤 `storage-setting.reset.credentials` + `user.update.role`;
// 沿 PR-2 D2=A + PR-3 D1=A 双重收紧;PR-4 D2=B `audit-log.read.entry` 整条加入)。
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
  // 按 code 精确取本 fixture 声明的 56 条(避免被其它 spec 在同一 DB 注入的 attachment.* 干扰)
  const seeded = await prisma.permission.findMany({
    where: { code: { in: RBAC_PERMISSIONS.map((p) => p.code) } },
    select: { id: true, code: true },
  });
  // 绑给 ops-admin 时双重过滤(沿评审稿 §6.2):
  //   PR-2 D2=A:`storage-setting.reset.credentials`(凭证仅 SA 短路)
  //   PR-3 D1=A:`user.update.role`(角色修改仅 SA 短路 + canChangeRole 业务护栏)
  //   PR-4 D2=B:`audit-log.read.entry` 不过滤,整条加入(数据范围 service 层兜底)
  const opsAdminBindings = seeded.filter(
    (p) => p.code !== RESET_CREDENTIALS_CODE && p.code !== USER_UPDATE_ROLE_CODE,
  );
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
