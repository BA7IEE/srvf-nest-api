import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/database/prisma.service';
import { RbacCacheService } from '../../src/modules/permissions/rbac-cache.service';

// Slow-4 T2/T3(2026-06-11):biz-admin 业务面角色 e2e fixture。
// 沿冻结评审稿 docs/archive/reviews/slow4-rbac-business-face-review.md §8 + rbac.fixture.ts 范式。
//
// 背景:test/setup/reset-db.ts 把 RBAC 4 表清空,prisma/seed.ts 的 51 条业务面码 + biz-admin
// 角色不在 e2e 数据库里。本 fixture 在 spec 的 beforeAll 调用:
// - seedBizAdminPermissionsAndRole:幂等 upsert 51 条业务面码 + biz-admin 角色 + 50 条绑定
//   (`member.delete.record` 进 Permission 表但**不**绑,D1=A 镜像;评审稿 §6)
// - grantBizAdminToUser:给 user 绑 biz-admin + 主动 invalidateUser cache(模拟 reload)
// - revokeBizAdminFromUser:撤回 + invalidateUser cache(对称范式)
//
// **零漂移用法约定**(评审稿 §7/§8):既有业务 spec 的 ADMIN 测试用户在 beforeAll 统一
// grant biz-admin(对应迁移前 @Roles(SUPER_ADMIN, ADMIN) 放行语义);"ADMIN 默认无
// biz-admin → 30100" 反向断言用单独的未 grant 用户(沿 organizations adminDefaultAuth 范式)。

export interface BizAdminSeedResult {
  bizAdminRoleId: string;
  bizPermissionCount: number; // 51(2026-06-19 招新二期 +3)
  bizAdminRolePermissionCount: number; // 50(过滤 member.delete.record)
}

// D1=A 镜像:members DELETE 仅 SUPER_ADMIN 短路;不绑 biz-admin(评审稿 §6)
const MEMBER_DELETE_RECORD_CODE = 'member.delete.record';

// 沿 prisma/seed.ts BIZ_PERMISSION_SEED(51 条;Slow-4 §4 + 保险 §3.4 + 招新一期/二期 §3.4 锁定);
// 本 fixture 维护独立集合,与 seed 内部表对照防漂移(沿 rbac.fixture.ts 范式)。
const BIZ_PERMISSIONS = [
  // ============ member 5 条 ============
  { code: 'member.read.record', module: 'member', action: 'read', resourceType: 'record' },
  { code: 'member.create.record', module: 'member', action: 'create', resourceType: 'record' },
  { code: 'member.update.record', module: 'member', action: 'update', resourceType: 'record' },
  { code: 'member.update.status', module: 'member', action: 'update', resourceType: 'status' },
  { code: MEMBER_DELETE_RECORD_CODE, module: 'member', action: 'delete', resourceType: 'record' },
  // ============ member-profile 3 条 ============
  {
    code: 'member-profile.read.record',
    module: 'member-profile',
    action: 'read',
    resourceType: 'record',
  },
  {
    code: 'member-profile.create.record',
    module: 'member-profile',
    action: 'create',
    resourceType: 'record',
  },
  {
    code: 'member-profile.update.record',
    module: 'member-profile',
    action: 'update',
    resourceType: 'record',
  },
  // ============ emergency-contact 4 条 ============
  {
    code: 'emergency-contact.read.record',
    module: 'emergency-contact',
    action: 'read',
    resourceType: 'record',
  },
  {
    code: 'emergency-contact.create.record',
    module: 'emergency-contact',
    action: 'create',
    resourceType: 'record',
  },
  {
    code: 'emergency-contact.update.record',
    module: 'emergency-contact',
    action: 'update',
    resourceType: 'record',
  },
  {
    code: 'emergency-contact.delete.record',
    module: 'emergency-contact',
    action: 'delete',
    resourceType: 'record',
  },
  // ============ certificate 6 条 ============
  {
    code: 'certificate.read.record',
    module: 'certificate',
    action: 'read',
    resourceType: 'record',
  },
  {
    code: 'certificate.create.record',
    module: 'certificate',
    action: 'create',
    resourceType: 'record',
  },
  {
    code: 'certificate.update.record',
    module: 'certificate',
    action: 'update',
    resourceType: 'record',
  },
  {
    code: 'certificate.delete.record',
    module: 'certificate',
    action: 'delete',
    resourceType: 'record',
  },
  {
    code: 'certificate.verify.record',
    module: 'certificate',
    action: 'verify',
    resourceType: 'record',
  },
  {
    code: 'certificate.reject.record',
    module: 'certificate',
    action: 'reject',
    resourceType: 'record',
  },
  // ============ activity 5 条(列表/详情无码,仅登录;评审稿 §3.5) ============
  { code: 'activity.create.record', module: 'activity', action: 'create', resourceType: 'record' },
  { code: 'activity.update.record', module: 'activity', action: 'update', resourceType: 'record' },
  { code: 'activity.delete.record', module: 'activity', action: 'delete', resourceType: 'record' },
  {
    code: 'activity.publish.record',
    module: 'activity',
    action: 'publish',
    resourceType: 'record',
  },
  { code: 'activity.cancel.record', module: 'activity', action: 'cancel', resourceType: 'record' },
  // ============ activity-registration 5 条 ============
  {
    code: 'activity-registration.read.record',
    module: 'activity-registration',
    action: 'read',
    resourceType: 'record',
  },
  {
    code: 'activity-registration.create.record',
    module: 'activity-registration',
    action: 'create',
    resourceType: 'record',
  },
  {
    code: 'activity-registration.approve.record',
    module: 'activity-registration',
    action: 'approve',
    resourceType: 'record',
  },
  {
    code: 'activity-registration.reject.record',
    module: 'activity-registration',
    action: 'reject',
    resourceType: 'record',
  },
  {
    code: 'activity-registration.cancel.record',
    module: 'activity-registration',
    action: 'cancel',
    resourceType: 'record',
  },
  // ============ attendance 8 条 ============
  {
    code: 'attendance.create.sheet',
    module: 'attendance',
    action: 'create',
    resourceType: 'sheet',
  },
  { code: 'attendance.read.sheet', module: 'attendance', action: 'read', resourceType: 'sheet' },
  {
    code: 'attendance.update.sheet',
    module: 'attendance',
    action: 'update',
    resourceType: 'sheet',
  },
  {
    code: 'attendance.delete.sheet',
    module: 'attendance',
    action: 'delete',
    resourceType: 'sheet',
  },
  {
    code: 'attendance.approve.sheet',
    module: 'attendance',
    action: 'approve',
    resourceType: 'sheet',
  },
  {
    code: 'attendance.reject.sheet',
    module: 'attendance',
    action: 'reject',
    resourceType: 'sheet',
  },
  {
    code: 'attendance.final-approve.sheet',
    module: 'attendance',
    action: 'final-approve',
    resourceType: 'sheet',
  },
  {
    code: 'attendance.final-reject.sheet',
    module: 'attendance',
    action: 'final-reject',
    resourceType: 'sheet',
  },
  // ============ 保险模块 +7(2026-06-13;评审稿 insurance-module-review.md §3.4,全绑)============
  {
    code: 'team-insurance-policy.read.record',
    module: 'team-insurance-policy',
    action: 'read',
    resourceType: 'record',
  },
  {
    code: 'team-insurance-policy.create.record',
    module: 'team-insurance-policy',
    action: 'create',
    resourceType: 'record',
  },
  {
    code: 'team-insurance-policy.update.record',
    module: 'team-insurance-policy',
    action: 'update',
    resourceType: 'record',
  },
  {
    code: 'team-insurance-policy.delete.record',
    module: 'team-insurance-policy',
    action: 'delete',
    resourceType: 'record',
  },
  {
    code: 'team-insurance-policy.add.member',
    module: 'team-insurance-policy',
    action: 'add',
    resourceType: 'member',
  },
  {
    code: 'team-insurance-policy.remove.member',
    module: 'team-insurance-policy',
    action: 'remove',
    resourceType: 'member',
  },
  {
    code: 'member-insurance.read.other',
    module: 'member-insurance',
    action: 'read',
    resourceType: 'other',
  },
  // ============ 招新一期 +5(2026-06-18;评审稿 recruitment-phase1-review.md §3.4,全绑)============
  {
    code: 'recruitment-cycle.read.record',
    module: 'recruitment-cycle',
    action: 'read',
    resourceType: 'record',
  },
  {
    code: 'recruitment-cycle.create.record',
    module: 'recruitment-cycle',
    action: 'create',
    resourceType: 'record',
  },
  {
    code: 'recruitment-cycle.update.record',
    module: 'recruitment-cycle',
    action: 'update',
    resourceType: 'record',
  },
  {
    code: 'recruitment-application.read.record',
    module: 'recruitment-application',
    action: 'read',
    resourceType: 'record',
  },
  {
    code: 'recruitment-application.resolve.manual',
    module: 'recruitment-application',
    action: 'resolve',
    resourceType: 'manual',
  },
  // ============ 招新二期 +3(2026-06-19;评审稿 recruitment-phase2-review.md §3.4,全绑)============
  {
    code: 'recruitment-application.mark.threshold',
    module: 'recruitment-application',
    action: 'mark',
    resourceType: 'threshold',
  },
  {
    code: 'recruitment-application.evaluate.assessment',
    module: 'recruitment-application',
    action: 'evaluate',
    resourceType: 'assessment',
  },
  {
    code: 'recruitment-application.promote.member',
    module: 'recruitment-application',
    action: 'promote',
    resourceType: 'member',
  },
] as const;

// 在 e2e 的 beforeAll 调用一次,seed 51 条业务面码 + biz-admin 角色 + 50 条 RolePermission
// 绑定(过滤 `member.delete.record`;沿 D1=A 镜像)。幂等:多次调用不出错(upsert + skipDuplicates)。
export async function seedBizAdminPermissionsAndRole(
  app: INestApplication,
): Promise<BizAdminSeedResult> {
  const prisma = app.get(PrismaService);
  for (const p of BIZ_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code: p.code },
      update: {},
      create: { code: p.code, module: p.module, action: p.action, resourceType: p.resourceType },
    });
  }
  const bizAdmin = await prisma.rbacRole.upsert({
    where: { code: 'biz-admin' },
    update: {},
    create: { code: 'biz-admin', displayName: '业务管理员' },
    select: { id: true },
  });
  // 按 code 精确取本 fixture 声明的 51 条(避免被其它 spec 在同一 DB 注入的码干扰)
  const seeded = await prisma.permission.findMany({
    where: { code: { in: BIZ_PERMISSIONS.map((p) => p.code) } },
    select: { id: true, code: true },
  });
  // 绑给 biz-admin 时过滤 `member.delete.record`(仅 SUPER_ADMIN 短路;评审稿 §6)
  const bizAdminBindings = seeded.filter((p) => p.code !== MEMBER_DELETE_RECORD_CODE);
  await prisma.rolePermission.createMany({
    data: bizAdminBindings.map((p) => ({ roleId: bizAdmin.id, permissionId: p.id })),
    skipDuplicates: true,
  });
  return {
    bizAdminRoleId: bizAdmin.id,
    bizPermissionCount: seeded.length,
    bizAdminRolePermissionCount: bizAdminBindings.length,
  };
}

// 给 user 绑 biz-admin + 主动失效缓存(模拟运行时"绑角色后 POST /rbac/reload"流程)。
// 终态 scoped-authz PR6:判权唯一读源 = global RoleBinding,故 grant 写 RoleBinding(USER, GLOBAL, ACTIVE);
//   无 Prisma 复合唯一键 → findFirst active 缺则 create(幂等)。UserRole 表冻结、fixture 不再写。
export async function grantBizAdminToUser(
  app: INestApplication,
  userId: string,
  bizAdminRoleId: string,
): Promise<void> {
  const prisma = app.get(PrismaService);
  const existing = await prisma.roleBinding.findFirst({
    where: {
      principalType: 'USER',
      principalId: userId,
      roleId: bizAdminRoleId,
      scopeType: 'GLOBAL',
      status: 'ACTIVE',
      deletedAt: null,
    },
    select: { id: true },
  });
  if (!existing) {
    await prisma.roleBinding.create({
      data: {
        principalType: 'USER',
        principalId: userId,
        roleId: bizAdminRoleId,
        scopeType: 'GLOBAL',
        status: 'ACTIVE',
      },
    });
  }
  app.get(RbacCacheService).invalidateUser(userId);
}

// 撤回 biz-admin + 失效缓存(对称范式)。终态 scoped-authz PR6:清该 user+role 的 global 绑定(测试清理硬删即可)。
export async function revokeBizAdminFromUser(
  app: INestApplication,
  userId: string,
  bizAdminRoleId: string,
): Promise<void> {
  const prisma = app.get(PrismaService);
  await prisma.roleBinding.deleteMany({
    where: {
      principalType: 'USER',
      principalId: userId,
      roleId: bizAdminRoleId,
      scopeType: 'GLOBAL',
    },
  });
  app.get(RbacCacheService).invalidateUser(userId);
}
