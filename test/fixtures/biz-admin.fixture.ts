import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/database/prisma.service';

// Slow-4 T2/T3(2026-06-11):biz-admin 业务面角色 e2e fixture。
// 沿冻结评审稿 docs/archive/reviews/slow4-rbac-business-face-review.md §8 + rbac.fixture.ts 范式。
//
// 背景:test/setup/reset-db.ts 把 RBAC 4 表清空,prisma/seed.ts 的业务面码 + biz-admin
// 角色不在 e2e 数据库里。本 fixture 在 spec 的 beforeAll 调用:
// - seedBizAdminPermissionsAndRole:幂等 upsert 本 fixture 所需业务面码 + biz-admin 角色 + 对应绑定
//   (`member.delete.record`〔D1=A 镜像,评审稿 §6〕+ reviewer-only +
//   v0.61.0 PR-11 contract 活动动作码进 Permission 表但**不**绑,
//   与 prisma/seed.ts BIZ_ADMIN_EXCLUDED_CODES 同口径镜像)
// - grantBizAdminToUser:给 user 绑 biz-admin；既有 gate=false 功能回归默认额外挂明确标注的
//   test-only legacy role，边界 spec 用 includeLegacyActivityActions=false 验证真实 contract
// - revokeBizAdminFromUser:撤回 global 绑定
//
// **零漂移用法约定**(评审稿 §7/§8):既有业务 spec 的 ADMIN 测试用户在 beforeAll 统一
// grant biz-admin(对应迁移前 @Roles(SUPER_ADMIN, ADMIN) 放行语义);"ADMIN 默认无
// biz-admin → 30100" 反向断言用单独的未 grant 用户(沿 organizations adminDefaultAuth 范式)。

export interface BizAdminSeedResult {
  bizAdminRoleId: string;
  bizPermissionCount: number; // = seeded 业务面码数(动态 = 本 fixture 列表长度;勿硬编码,防漂移)
  bizAdminRolePermissionCount: number; // = 绑定数(动态,过滤 member.delete.record + reviewer/contract 动作码)
}

// D1=A 镜像:members DELETE 仅 SUPER_ADMIN 短路;不绑 biz-admin(评审稿 §6)
const MEMBER_DELETE_RECORD_CODE = 'member.delete.record';

const ACTIVITY_RESPONSIBILITY_CONTRACT_ACTION_CODES = [
  'activity.publish.record',
  'activity.update.record',
  'activity.cancel.record',
  'activity.complete.record',
  'activity-registration.create.record',
  'activity-registration.approve.record',
  'activity-registration.reject.record',
  'activity-registration.cancel.record',
  'activity-registration.reopen.record',
  'attendance.create.sheet',
  'attendance.update.sheet',
  'attendance.delete.sheet',
  'attendance.approve.sheet',
  'attendance.reject.sheet',
  'attendance.return.sheet',
  'attendance.final-return.sheet',
] as const;

const TEST_LEGACY_ACTIVITY_ACTIONS_ROLE_CODE = 'test-legacy-activity-actions';

async function ensureLegacyActivityActionsRole(prisma: PrismaService): Promise<string> {
  const legacyActionPermissions = await prisma.permission.findMany({
    where: {
      code: { in: [...ACTIVITY_RESPONSIBILITY_CONTRACT_ACTION_CODES] },
    },
    select: { id: true, code: true },
  });
  if (legacyActionPermissions.length !== ACTIVITY_RESPONSIBILITY_CONTRACT_ACTION_CODES.length) {
    throw new Error(
      `test legacy activity role requires ${ACTIVITY_RESPONSIBILITY_CONTRACT_ACTION_CODES.length} permissions, found ${legacyActionPermissions.length}`,
    );
  }
  const legacyActivityActionsRole = await prisma.rbacRole.upsert({
    where: { code: TEST_LEGACY_ACTIVITY_ACTIONS_ROLE_CODE },
    update: {},
    create: {
      code: TEST_LEGACY_ACTIVITY_ACTIONS_ROLE_CODE,
      displayName: 'E2E legacy activity actions',
      description: 'test-only compatibility role; never seeded by prisma/seed.ts',
    },
    select: { id: true },
  });
  await prisma.rolePermission.createMany({
    data: legacyActionPermissions.map((permission) => ({
      roleId: legacyActivityActionsRole.id,
      permissionId: permission.id,
    })),
    skipDuplicates: true,
  });
  await prisma.rolePermission.deleteMany({
    where: {
      roleId: legacyActivityActionsRole.id,
      permissionId: { notIn: legacyActionPermissions.map((permission) => permission.id) },
    },
  });
  return legacyActivityActionsRole.id;
}

async function ensureUserRoleBinding(
  prisma: PrismaService,
  userId: string,
  roleId: string,
  options: {
    scopeType: 'GLOBAL' | 'ORGANIZATION_TREE';
    scopeOrgId?: string;
  },
): Promise<void> {
  const existing = await prisma.roleBinding.findFirst({
    where: {
      principalType: 'USER',
      principalId: userId,
      roleId,
      scopeType: options.scopeType,
      scopeOrgId: options.scopeOrgId ?? null,
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
        roleId,
        scopeType: options.scopeType,
        scopeOrgId: options.scopeOrgId,
        status: 'ACTIVE',
      },
    });
  }
}

export async function grantLegacyActivityActionsToUser(
  app: INestApplication,
  userId: string,
  options: {
    scopeType?: 'GLOBAL' | 'ORGANIZATION_TREE';
    scopeOrgId?: string;
  } = {},
): Promise<void> {
  const prisma = app.get(PrismaService);
  await ensureUserRoleBinding(prisma, userId, await ensureLegacyActivityActionsRole(prisma), {
    scopeType: options.scopeType ?? 'GLOBAL',
    scopeOrgId: options.scopeOrgId,
  });
}

// 新增 return 只归显式 attendance-first-reviewer；终审/reopen 只归
// attendance-final-reviewer；PR-11 contract 活动动作只归 owner/collaborator/reviewer。
const BIZ_ADMIN_UNBOUND_CODES: ReadonlySet<string> = new Set([
  MEMBER_DELETE_RECORD_CODE,
  'attendance.final-approve.sheet',
  'attendance.final-reject.sheet',
  'attendance.reopen.sheet',
  ...ACTIVITY_RESPONSIBILITY_CONTRACT_ACTION_CODES,
]);

// 沿 prisma/seed.ts BIZ_PERMISSION_SEED 取 e2e 实际使用子集;
// 本 fixture 维护独立集合,与 seed 内部表对照防漂移(沿 rbac.fixture.ts 范式)。
const BIZ_PERMISSIONS = [
  // ============ member 6 条(v0.40.0 +offboard)============
  { code: 'member.read.record', module: 'member', action: 'read', resourceType: 'record' },
  { code: 'member.create.record', module: 'member', action: 'create', resourceType: 'record' },
  { code: 'member.update.record', module: 'member', action: 'update', resourceType: 'record' },
  { code: 'member.update.status', module: 'member', action: 'update', resourceType: 'status' },
  { code: 'member.offboard.record', module: 'member', action: 'offboard', resourceType: 'record' },
  { code: MEMBER_DELETE_RECORD_CODE, module: 'member', action: 'delete', resourceType: 'record' },
  // ============ member-profile 4 条(第三轮 review §F&A-3:+read.sensitive) ============
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
  {
    code: 'member-profile.read.sensitive',
    module: 'member-profile',
    action: 'read',
    resourceType: 'sensitive',
  },
  // ============ emergency-contact 5 条(十项收口刀D:+read.sensitive) ============
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
  {
    code: 'emergency-contact.read.sensitive',
    module: 'emergency-contact',
    action: 'read',
    resourceType: 'sensitive',
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
  // ============ activity 6 条(列表/详情无码,仅登录;评审稿 §3.5;v0.40.0 +complete) ============
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
  {
    code: 'activity.complete.record',
    module: 'activity',
    action: 'complete',
    resourceType: 'record',
  },
  // ============ activity-registration 6 条(v0.40.0 +reopen)============
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
  {
    code: 'activity-registration.reopen.record',
    module: 'activity-registration',
    action: 'reopen',
    resourceType: 'record',
  },
  // ============ attendance 11 条(v0.61.0 +return/final-return)============
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
    code: 'attendance.return.sheet',
    module: 'attendance',
    action: 'return',
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
  {
    code: 'attendance.final-return.sheet',
    module: 'attendance',
    action: 'final-return',
    resourceType: 'sheet',
  },
  {
    code: 'attendance.reopen.sheet',
    module: 'attendance',
    action: 'reopen',
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
  {
    code: 'recruitment-application.review.certificate',
    module: 'recruitment-application',
    action: 'review',
    resourceType: 'certificate',
  },
] as const;

// 在 e2e 的 beforeAll 调用一次,seed 本 fixture 所需业务面码 + biz-admin 角色 + 对应 RolePermission
// 绑定(过滤 `member.delete.record` + reviewer-only + v0.61.0 contract 动作码)。
// 幂等:多次调用不出错(upsert + skipDuplicates)。
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
  // 按 code 精确取本 fixture 声明集合(避免被其它 spec 在同一 DB 注入的码干扰)
  const seeded = await prisma.permission.findMany({
    where: { code: { in: BIZ_PERMISSIONS.map((p) => p.code) } },
    select: { id: true, code: true },
  });
  // 绑给 biz-admin 时过滤 `member.delete.record`(仅 SUPER_ADMIN 短路;评审稿 §6)
  // + 新 return / 终审 / reopen 码(与 prisma/seed.ts 当前 rollout 同口径)
  const bizAdminBindings = seeded.filter((p) => !BIZ_ADMIN_UNBOUND_CODES.has(p.code));
  await prisma.rolePermission.createMany({
    data: bizAdminBindings.map((p) => ({ roleId: bizAdmin.id, permissionId: p.id })),
    skipDuplicates: true,
  });

  // gate=false 历史功能回归仍需一个能执行旧动作的主体。它必须与真实 biz-admin 分离，
  // 才能让 contract 边界测试证明通用角色已摘权。
  await ensureLegacyActivityActionsRole(prisma);
  return {
    bizAdminRoleId: bizAdmin.id,
    bizPermissionCount: seeded.length,
    bizAdminRolePermissionCount: bizAdminBindings.length,
  };
}

// 给 user 绑 biz-admin；DB-backed 判权在下一请求直接读取该 GLOBAL 绑定。
// 终态 scoped-authz PR6:判权唯一读源 = global RoleBinding,故 grant 写 RoleBinding(USER, GLOBAL, ACTIVE);
//   无 Prisma 复合唯一键 → findFirst active 缺则 create(幂等)。旧 UserRole 表已 DROP,fixture 不写该表。
export async function grantBizAdminToUser(
  app: INestApplication,
  userId: string,
  bizAdminRoleId: string,
  options: { includeLegacyActivityActions?: boolean } = {},
): Promise<void> {
  const prisma = app.get(PrismaService);
  await ensureUserRoleBinding(prisma, userId, bizAdminRoleId, { scopeType: 'GLOBAL' });
  if (options.includeLegacyActivityActions !== false) {
    await grantLegacyActivityActionsToUser(app, userId);
  }
}

// 撤回 biz-admin。终态 scoped-authz PR6:清该 user+role 的 global 绑定(测试清理硬删即可)。
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
}
