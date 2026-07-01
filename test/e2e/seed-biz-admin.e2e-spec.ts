import type { INestApplication } from '@nestjs/common';
import { execSync } from 'child_process';
import { Role, UserStatus } from '@prisma/client';
import { PrismaService } from '../../src/database/prisma.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertTestDatabaseUrl } from '../setup/test-db';

// Slow-4 T1(2026-06-11)seed 业务面码 + biz-admin 内置角色 e2e;
// 2026-06-13 保险模块 T1 +7(36→43 / 绑定 35→42);2026-06-18 招新一期 T1 +5(43→48 / 绑定 42→47,
// 评审稿 recruitment-phase1-review.md §3.4 / E-R-19)+ REALNAME settings 授权 seed → ops-admin 61→63;
// 2026-06-19 招新二期 T1 +3(48→51 / 绑定 47→50,评审稿 recruitment-phase2-review.md §3.4 / E-R2-11)。
// 2026-06-24 招新闭环优化 S3 +1(67→68 / 绑定 66→67;read.sensitive 敏感查看从 read.record 切出,
// 评审稿 recruitment-phase4-loop-optimization-review.md §11 / Q-P4-10,全绑 biz-admin 无例外)。
// 沿冻结评审稿 docs/archive/reviews/slow4-rbac-business-face-review.md §5 + D-S4-7
// + seed-attachment-permissions.e2e-spec.ts 子进程范式。
//
// 覆盖(评审稿 §5 验收项):
// 1. 跑 seed 后存在 68 条业务面 permission(15 域,byModule 逐码一致)
// 2. 存在 biz-admin RbacRole(displayName / description 正确)
// 3. biz-admin 绑定 50 条 RolePermission;member.delete.record **不**在绑定中(D1=A 镜像)
// 4. 幂等补挂:seed 前已存在的 ADMIN 用户(含 DISABLED)跑 seed 后持有 biz-admin;
//    SUPER_ADMIN / USER 不被挂;软删 ADMIN 不补挂(D-S4-7)
// 5. 零变化项:ops-admin 绑定数(68;WECHAT T2 58→61 + 招新 T1 REALNAME settings 61→63 授权 true-up
//    + 终态 scoped-authz PR1 org.move.node 63→64 + PR2 membership 4 码 64→68;业务面 seed 不绑 ops-admin 的不变式仍成立)
//    与 member 角色绑定数(9)不受业务面 seed 影响
// 6. seed 连续执行两次完全幂等:Permission 总数 / biz-admin role id /
//    RolePermission 数 / UserRole 数全部稳定
//
// 不覆盖(分散在其它 spec):
// - 业务模块 rbac.can() 行为(T2/T3 各模块权限边界 spec)
// - ops-admin / member 角色自身语义(seed-attachment-permissions / users 系 spec)

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

// 沿 prisma/seed.ts BIZ_PERMISSION_SEED(Slow-4 评审稿 §4 + 保险评审稿 §3.4 锁定 43 条);
// 本 spec 维护独立期望集合,与 seed 内部表对照防漂移。
const EXPECTED_BIZ_PERMISSION_CODES = [
  // member 5
  'member.read.record',
  'member.create.record',
  'member.update.record',
  'member.update.status',
  'member.delete.record',
  // member-profile 3
  'member-profile.read.record',
  'member-profile.create.record',
  'member-profile.update.record',
  // emergency-contact 4
  'emergency-contact.read.record',
  'emergency-contact.create.record',
  'emergency-contact.update.record',
  'emergency-contact.delete.record',
  // certificate 6
  'certificate.read.record',
  'certificate.create.record',
  'certificate.update.record',
  'certificate.delete.record',
  'certificate.verify.record',
  'certificate.reject.record',
  // activity 5(列表/详情无码,仅登录;评审稿 §3.5)
  'activity.create.record',
  'activity.update.record',
  'activity.delete.record',
  'activity.publish.record',
  'activity.cancel.record',
  // activity-registration 5
  'activity-registration.read.record',
  'activity-registration.create.record',
  'activity-registration.approve.record',
  'activity-registration.reject.record',
  'activity-registration.cancel.record',
  // attendance 8
  'attendance.create.sheet',
  'attendance.read.sheet',
  'attendance.update.sheet',
  'attendance.delete.sheet',
  'attendance.approve.sheet',
  'attendance.reject.sheet',
  'attendance.final-approve.sheet',
  'attendance.final-reject.sheet',
  // 保险模块 +7(2026-06-13;评审稿 insurance-module-review.md §3.4,全绑无例外)
  'team-insurance-policy.read.record',
  'team-insurance-policy.create.record',
  'team-insurance-policy.update.record',
  'team-insurance-policy.delete.record',
  'team-insurance-policy.add.member',
  'team-insurance-policy.remove.member',
  'member-insurance.read.other',
  // 招新一期 +5(2026-06-18;评审稿 recruitment-phase1-review.md §3.4,全绑无例外)
  'recruitment-cycle.read.record',
  'recruitment-cycle.create.record',
  'recruitment-cycle.update.record',
  'recruitment-application.read.record',
  'recruitment-application.resolve.manual',
  // 招新二期 +3(2026-06-19;评审稿 recruitment-phase2-review.md §3.4,全绑无例外)
  'recruitment-application.mark.threshold',
  'recruitment-application.evaluate.assessment',
  'recruitment-application.promote.member',
  // 招新闭环优化 S3 +1(2026-06-24;评审稿 recruitment-phase4-loop-optimization-review.md §11,全绑无例外)
  'recruitment-application.read.sensitive',
  // 招新三期入队 T2 +6(2026-06-19;评审稿 recruitment-phase3-review.md §3.4,全绑无例外;
  // join.member 随 T4 controller 落)
  'team-join-cycle.read.record',
  'team-join-cycle.create.record',
  'team-join-cycle.update.record',
  'team-join-application.read.record',
  'team-join-application.mark.gate',
  'team-join-application.evaluate.assessment',
  // 招新三期入队 T4 +1(2026-06-19;评审稿 §4.5,全绑无例外)
  'team-join-application.join.member',
  // CMS 内容模块 +9(2026-06-21;评审稿 content-module-review.md §7,全绑 biz-admin):content.* 5 + attachment.content-* 4
  'content.read.record',
  'content.create.record',
  'content.update.record',
  'content.delete.record',
  'content.publish.record',
  'attachment.upload.content-image',
  'attachment.delete.content-image',
  'attachment.upload.content-file',
  'attachment.delete.content-file',
  // 统一通知模块 S1 站内信渠道 +5(2026-06-25;评审稿 unified-notification-dispatcher-review.md §9.2,全绑 biz-admin 无例外)
  'notification.read.record',
  'notification.create.record',
  'notification.update.record',
  'notification.delete.record',
  'notification.publish.record',
  // 统一通知模块 S2 微信订阅 quota 渠道 +1(2026-06-25;§9.2 模板配置写权,运营可配;读复用 read.record,全绑 biz-admin)
  'notification.update.template',
  // 统一通知模块 S5 短信兜底渠道 +1(2026-06-27;§9.2 短信发起成本动作 gating,计费确认必需;全绑 biz-admin)
  'notification.send.sms',
] as const;
const EXPECTED_BIZ_PERMISSION_COUNT = EXPECTED_BIZ_PERMISSION_CODES.length; // 75(2026-06-25 统一通知 S1 +5 / S2 +1;2026-06-27 S5 +1)

// D1=A 镜像:不绑 biz-admin(评审稿 §6)
const MEMBER_DELETE_RECORD_CODE = 'member.delete.record';
const EXPECTED_BIZ_ADMIN_BINDING_COUNT = EXPECTED_BIZ_PERMISSION_COUNT - 1; // 74

// 零变化基线(评审稿 §6):本断言意图 = 业务面 seed 不改 ops-admin / member 绑定;
// 基线数跟随 ops-admin 当前合法总数(2026-06-12 WECHAT T2 +3 → 58→61;
// 2026-06-18 招新一期 T1 REALNAME settings 授权 seed +2 → 61→63,沿 recruitment-phase1-review.md
// §3.4 / E-R-19;realname-setting.reset.credentials 不绑;
// 2026-07-01 终态 scoped-authz PR1 org.move.node 绑 ops-admin +1 → 63→64;
// 2026-07-01 终态 scoped-authz PR2 membership.{list,read,set,end}.record 绑 ops-admin +4 → 64→68;与 seed-rbac 的 73-5=68 推导一致)
const EXPECTED_OPS_ADMIN_BINDING_COUNT = 68;
const EXPECTED_MEMBER_ROLE_BINDING_COUNT = 9;

const SEED_ENV = {
  APP_ENV: 'test',
  SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
  SUPER_ADMIN_EMAIL: '',
  RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
};

describe('prisma/seed.ts — Slow-4 business permissions and biz-admin role', () => {
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

  it('1. 空 db → seed 跑完后 75 条业务面 permission 全部存在(16 域分布一致)', async () => {
    const result = runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'biz-seed-su-1' });
    expect(result.code).toBe(0);

    const perms = await prisma.permission.findMany({
      where: { code: { in: [...EXPECTED_BIZ_PERMISSION_CODES] } },
      select: { code: true, module: true },
    });
    expect(perms).toHaveLength(EXPECTED_BIZ_PERMISSION_COUNT);
    expect(new Set(perms.map((p) => p.code))).toEqual(new Set(EXPECTED_BIZ_PERMISSION_CODES));

    const byModule = perms.reduce<Record<string, number>>((acc, p) => {
      acc[p.module] = (acc[p.module] ?? 0) + 1;
      return acc;
    }, {});
    expect(byModule).toEqual({
      member: 5,
      'member-profile': 3,
      'emergency-contact': 4,
      certificate: 6,
      activity: 5,
      'activity-registration': 5,
      attendance: 8,
      'team-insurance-policy': 6,
      'member-insurance': 1,
      'recruitment-cycle': 3,
      'recruitment-application': 6,
      'team-join-cycle': 3,
      'team-join-application': 4,
      content: 5,
      attachment: 4,
      notification: 7, // S1 站内 5 + S2 update.template 1 + S5 send.sms 1
    });
  });

  it('2 + 3. biz-admin RbacRole 存在;绑定恰 74 条;member.delete.record 不在绑定中', async () => {
    const result = runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'biz-seed-su-2' });
    expect(result.code).toBe(0);

    const bizAdmin = await prisma.rbacRole.findUnique({
      where: { code: 'biz-admin' },
      select: { id: true, displayName: true, description: true },
    });
    expect(bizAdmin).not.toBeNull();
    expect(bizAdmin!.displayName).toBe('业务管理员');
    expect(bizAdmin!.description).toContain('Slow-3 决议');
    expect(bizAdmin!.description).toContain('member.delete.record');

    const bound = await prisma.rolePermission.findMany({
      where: { roleId: bizAdmin!.id },
      select: { permission: { select: { code: true } } },
    });
    const boundCodes = bound.map((b) => b.permission.code).sort();
    expect(boundCodes).toHaveLength(EXPECTED_BIZ_ADMIN_BINDING_COUNT);
    expect(boundCodes).not.toContain(MEMBER_DELETE_RECORD_CODE);
    expect(boundCodes).toEqual(
      [...EXPECTED_BIZ_PERMISSION_CODES].filter((c) => c !== MEMBER_DELETE_RECORD_CODE).sort(),
    );
    // CMS α(2026-06-21,content-module-review.md §7):biz-admin 现含**且仅含** CMS content-* 4 个
    // attachment 写码(演进 Slow-4 §6「biz-admin 不含 attachment.* 码」不变式);
    // member / certificate / activity 既有附件码仍不绑(零漂移)。
    expect(boundCodes.filter((c) => c.startsWith('attachment.'))).toEqual([
      'attachment.delete.content-file',
      'attachment.delete.content-image',
      'attachment.upload.content-file',
      'attachment.upload.content-image',
    ]);
  });

  it('4. 幂等补挂:既存 ADMIN(含 DISABLED)补挂 biz-admin;SA/USER/软删 ADMIN 不挂(D-S4-7)', async () => {
    // seed 之前先注入 4 个用户:ACTIVE ADMIN / DISABLED ADMIN / 软删 ADMIN / USER
    const [adminActive, adminDisabled, adminDeleted, plainUser] = await Promise.all([
      prisma.user.create({
        data: { username: 'biz-adm-active', passwordHash: 'x', role: Role.ADMIN },
        select: { id: true },
      }),
      prisma.user.create({
        data: {
          username: 'biz-adm-disabled',
          passwordHash: 'x',
          role: Role.ADMIN,
          status: UserStatus.DISABLED,
        },
        select: { id: true },
      }),
      prisma.user.create({
        data: {
          username: 'biz-adm-deleted',
          passwordHash: 'x',
          role: Role.ADMIN,
          deletedAt: new Date(),
        },
        select: { id: true },
      }),
      prisma.user.create({
        data: { username: 'biz-plain-user', passwordHash: 'x', role: Role.USER },
        select: { id: true },
      }),
    ]);

    const result = runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'biz-seed-su-3' });
    expect(result.code).toBe(0);

    const bizAdmin = await prisma.rbacRole.findUniqueOrThrow({
      where: { code: 'biz-admin' },
      select: { id: true },
    });
    const holderIds = new Set(
      (
        await prisma.userRole.findMany({
          where: { roleId: bizAdmin.id },
          select: { userId: true },
        })
      ).map((r) => r.userId),
    );
    expect(holderIds.has(adminActive.id)).toBe(true);
    expect(holderIds.has(adminDisabled.id)).toBe(true); // 含 DISABLED(D-S4-7)
    expect(holderIds.has(adminDeleted.id)).toBe(false); // 软删除外
    expect(holderIds.has(plainUser.id)).toBe(false);

    // seed 创建的 SUPER_ADMIN 不持有 biz-admin(SA 走判权短路,无需绑定)
    const su = await prisma.user.findUniqueOrThrow({
      where: { username: 'biz-seed-su-3' },
      select: { id: true },
    });
    expect(holderIds.has(su.id)).toBe(false);
  });

  it('5. 零变化项:ops-admin 绑定数与 member 角色绑定数不受 Slow-4 seed 影响', async () => {
    const result = runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'biz-seed-su-4' });
    expect(result.code).toBe(0);

    const opsAdmin = await prisma.rbacRole.findUniqueOrThrow({
      where: { code: 'ops-admin' },
      select: { id: true },
    });
    const memberRole = await prisma.rbacRole.findUniqueOrThrow({
      where: { code: 'member' },
      select: { id: true },
    });
    expect(await prisma.rolePermission.count({ where: { roleId: opsAdmin.id } })).toBe(
      EXPECTED_OPS_ADMIN_BINDING_COUNT,
    );
    expect(await prisma.rolePermission.count({ where: { roleId: memberRole.id } })).toBe(
      EXPECTED_MEMBER_ROLE_BINDING_COUNT,
    );
    // ops-admin 不含任何 Slow-4 业务面码(双向零变化)
    const opsBound = await prisma.rolePermission.findMany({
      where: { roleId: opsAdmin.id },
      select: { permission: { select: { code: true } } },
    });
    const bizCodeSet = new Set<string>(EXPECTED_BIZ_PERMISSION_CODES);
    expect(opsBound.filter((b) => bizCodeSet.has(b.permission.code))).toEqual([]);
  });

  it('6. seed 连续执行两次完全幂等:counts 与 biz-admin role id 不变', async () => {
    await prisma.user.create({
      data: { username: 'biz-adm-idem', passwordHash: 'x', role: Role.ADMIN },
    });

    const first = runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'biz-seed-su-5' });
    expect(first.code).toBe(0);

    const permCount1 = await prisma.permission.count();
    const role1 = await prisma.rbacRole.findUniqueOrThrow({
      where: { code: 'biz-admin' },
      select: { id: true },
    });
    const rolePermCount1 = await prisma.rolePermission.count();
    const userRoleCount1 = await prisma.userRole.count();

    const second = runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'biz-seed-su-5' });
    expect(second.code).toBe(0);

    const permCount2 = await prisma.permission.count();
    const role2 = await prisma.rbacRole.findUniqueOrThrow({
      where: { code: 'biz-admin' },
      select: { id: true },
    });
    const rolePermCount2 = await prisma.rolePermission.count();
    const userRoleCount2 = await prisma.userRole.count();

    expect(permCount2).toBe(permCount1);
    expect(role2.id).toBe(role1.id);
    expect(rolePermCount2).toBe(rolePermCount1);
    expect(userRoleCount2).toBe(userRoleCount1);
  });
});
