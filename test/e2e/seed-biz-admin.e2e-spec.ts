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
// 2026-07-03 摘码微刀:终审两码摘除绑定(75 码绑 74→**72**;2026-07-04 F4 +membership.transfer.record → 76 码绑 **73**;终审 = attendance-final-reviewer
// scoped 绑定或 SUPER_ADMIN 兜底;seed 新增 targeted 幂等清理老库残留,见用例 7)。
// 2026-07-10 第三轮 review §F&A-3:member-profile.read.sensitive 敏感明文码 +1(全绑 biz-admin)→ **77 码绑 74**。
// 2026-07-11 参与域生命周期收口②(v0.40.0):activity-registration.reopen.record +1(全绑 biz-admin)→ **78 码绑 75**。
// 2026-07-11 参与域生命周期收口③(v0.40.0):activity.complete.record +1(全绑 biz-admin)→ **79 码绑 76**。
// 2026-07-11 参与域生命周期收口⑤(v0.40.0):member.offboard.record +1(全绑 biz-admin)→ **80 码绑 77**。
// 2026-07-11 招新可用性收口 F2/F3:recruitment-application +update.record/+promote.single(全绑)→ **82 码绑 79**。
// 2026-07-11 十项收口刀D:emergency-contact.read.sensitive +1(全绑 biz-admin)→ **83 码绑 80**。
// 2026-07-19 D-INSURANCE v3 PR2:member-insurance.review.record +1(全绑)→ **86 码绑 82**。
// 沿冻结评审稿 docs/archive/reviews/slow4-rbac-business-face-review.md §5 + D-S4-7
// + seed-attachment-permissions.e2e-spec.ts 子进程范式。
//
// 覆盖(评审稿 §5 验收项):
// 1. 跑 seed 后存在 86 条业务面 permission(17 域,byModule 逐码一致)
// 2. 存在 biz-admin RbacRole(displayName / description 正确)
// 3. biz-admin 绑定 82 条 RolePermission;member.delete.record 与终审/reopen 三码 **不**在绑定中
// 4. 幂等补挂:seed 前已存在的 ADMIN 用户(含 DISABLED)跑 seed 后持有 biz-admin;
//    SUPER_ADMIN / USER 不被挂;软删 ADMIN 不补挂(D-S4-7)
// 5. 零变化项:ops-admin 绑定数(96;WECHAT T2 58→61 + 招新 T1 REALNAME settings 61→63 授权 true-up
//    + 终态 scoped-authz PR1 org.move.node 63→64 + PR2 membership 4 码 64→68 + PR3 position/rule 8 码 68→76
//    + PR4 position-assignment 4 码 76→80 + PR5 supervision-assignment 4 码 80→84 + PR6 role-binding 4 码 84→88
//    + PR10 authz.explain.decision 88→89 + PR11 announcement-import 2 码 89→91 + F1「A 组」meta.resolve.label 91→92
//    + F3「C 组」authz.{explain-batch,action-state}.decision 2 码 92→94 + 队员账号闭环 v1 member.grant.account 94→95
//    + 队员账号闭环 v2 member.bind.account 95→96;业务面(本文件)seed 不绑 ops-admin 的不变式仍成立)
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
  // member 6(v0.40.0 +offboard)
  'member.read.record',
  'member.create.record',
  'member.update.record',
  'member.update.status',
  'member.offboard.record',
  'member.delete.record',
  // member-profile 4(第三轮 review §F&A-3:+read.sensitive 敏感明文码,全绑 biz-admin)
  'member-profile.read.record',
  'member-profile.create.record',
  'member-profile.update.record',
  'member-profile.read.sensitive',
  // emergency-contact 5(十项收口刀D 2026-07-11:+read.sensitive 敏感明文码,全绑 biz-admin;
  // org-admin 派生排除、group-manager 不绑)
  'emergency-contact.read.record',
  'emergency-contact.create.record',
  'emergency-contact.update.record',
  'emergency-contact.delete.record',
  'emergency-contact.read.sensitive',
  // certificate 6
  'certificate.read.record',
  'certificate.create.record',
  'certificate.update.record',
  'certificate.delete.record',
  'certificate.verify.record',
  'certificate.reject.record',
  // activity 6(列表/详情无码,仅登录;评审稿 §3.5;v0.40.0 +complete)
  'activity.create.record',
  'activity.update.record',
  'activity.delete.record',
  'activity.publish.record',
  'activity.cancel.record',
  'activity.complete.record',
  // activity-registration 6(v0.40.0 +reopen)
  'activity-registration.read.record',
  'activity-registration.create.record',
  'activity-registration.approve.record',
  'activity-registration.reject.record',
  'activity-registration.cancel.record',
  'activity-registration.reopen.record',
  // attendance 9(v0.47.0 +reopen)
  'attendance.create.sheet',
  'attendance.read.sheet',
  'attendance.update.sheet',
  'attendance.delete.sheet',
  'attendance.approve.sheet',
  'attendance.reject.sheet',
  'attendance.final-approve.sheet',
  'attendance.final-reject.sheet',
  'attendance.reopen.sheet',
  // 保险模块 +8(2026-06-13 基线 + D-INSURANCE v3 PR2 review.record,全绑无例外)
  'team-insurance-policy.read.record',
  'team-insurance-policy.create.record',
  'team-insurance-policy.update.record',
  'team-insurance-policy.delete.record',
  'team-insurance-policy.add.member',
  'team-insurance-policy.remove.member',
  'member-insurance.read.other',
  'member-insurance.review.record',
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
  // 招新可用性收口 F2/F3 +2(2026-07-11;评审稿 recruitment-usability-closeout-review.md §3 R1/R3,全绑无例外)
  'recruitment-application.update.record',
  'recruitment-application.promote.single',
  'recruitment-application.review.certificate',
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
  // F4「D 组」memberships +1(2026-07-04;路线图 §6.2 归属迁移业务写;绑 biz-admin —— 区别于
  // membership.{list,read,set,end} 4 条 ops-admin 管理面码,module 同为 'membership' 但归业务面 seed)
  'membership.transfer.record',
] as const;
const EXPECTED_BIZ_PERMISSION_COUNT = EXPECTED_BIZ_PERMISSION_CODES.length; // 86(D-INSURANCE PR2 +review.record)

// D1=A 镜像:不绑 biz-admin(评审稿 §6)
const MEMBER_DELETE_RECORD_CODE = 'member.delete.record';
// biz-admin 不绑 4 码 = member.delete.record(D1=A 镜像)+ 终审/reopen 三码:
// 终审权只归 attendance-final-reviewer scoped 绑定 + SUPER_ADMIN 短路兜底,RBAC_MAP §5 挂账关闭)
const BIZ_ADMIN_UNBOUND_CODES: ReadonlyArray<string> = [
  MEMBER_DELETE_RECORD_CODE,
  'attendance.final-approve.sheet',
  'attendance.final-reject.sheet',
  'attendance.reopen.sheet',
];
const EXPECTED_BIZ_ADMIN_BINDING_COUNT = EXPECTED_BIZ_PERMISSION_COUNT - 4; // 82(86 - 4 excluded)

// 零变化基线(评审稿 §6):本断言意图 = 业务面 seed 不改 ops-admin / member 绑定;
// 基线数跟随 ops-admin 当前合法总数(2026-06-12 WECHAT T2 +3 → 58→61;
// 2026-06-18 招新一期 T1 REALNAME settings 授权 seed +2 → 61→63,沿 recruitment-phase1-review.md
// §3.4 / E-R-19;realname-setting.reset.credentials 不绑;
// 2026-07-01 终态 scoped-authz PR1 org.move.node 绑 ops-admin +1 → 63→64;
// 2026-07-01 终态 scoped-authz PR2 membership.{list,read,set,end}.record 绑 ops-admin +4 → 64→68;
// 2026-07-01 终态 scoped-authz PR3 position.*.definition 4 + position-rule.*.record 4 绑 ops-admin +8 → 68→76;
// 2026-07-01 终态 scoped-authz PR4 position-assignment.* 4 绑 ops-admin +4 → 76→80;
// 2026-07-01 终态 scoped-authz PR5 supervision-assignment.* 4 绑 ops-admin +4 → 80→84;
// 2026-07-01 终态 scoped-authz PR6 role-binding.* 4 绑 ops-admin +4 → 84→88;
// 2026-07-02 终态 scoped-authz PR10 authz.explain.decision +1 → 88→89;与 seed-rbac 的 94-5=89 推导一致;
// 2026-07-02 终态 scoped-authz PR11 announcement-import.{preview,execute}.record +2 → 89→91;
// 与 seed-rbac 的 96-5=91 推导一致;
// 2026-07-04 F1「A 组」meta.resolve.label +1 → 91→92;与 seed-rbac 的 97-5=92 推导一致;
// 2026-07-04 F3「C 组」authz.{explain-batch,action-state}.decision +2 → 92→94;与 seed-rbac 的 99-5=94 推导一致;
// 2026-07-07 队员账号闭环 v1 member.grant.account +1 → 94→95;与 seed-rbac 的 100-5=95 推导一致;
// 2026-07-07 队员账号闭环 v2 member.bind.account +1 → 95→96;与 seed-rbac 的 101-5=96 推导一致)
const EXPECTED_OPS_ADMIN_BINDING_COUNT = 96;
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

  it('1. 空 db → seed 跑完后 86 条业务面 permission 全部存在(17 域分布一致)', async () => {
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
      member: 6,
      'member-profile': 4,
      'emergency-contact': 5,
      certificate: 6,
      activity: 6,
      'activity-registration': 6,
      attendance: 9,
      'team-insurance-policy': 6,
      'member-insurance': 2,
      'recruitment-cycle': 3,
      'recruitment-application': 9, // 十三项收口刀G +review.certificate(2026-07-12)
      'team-join-cycle': 3,
      'team-join-application': 4,
      content: 5,
      attachment: 4,
      notification: 7, // S1 站内 5 + S2 update.template 1 + S5 send.sms 1
      membership: 1, // F4 transfer(业务面唯一 membership 码;list/read/set/end 4 条属 rbac 面 seed 不在本集)
    });
  });

  it('2 + 3. biz-admin RbacRole 存在;绑定恰 82 条且含 insurance review;保留四码不绑定', async () => {
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
    // 摘码微刀(2026-07-03):description 明示终审两码不绑
    expect(bizAdmin!.description).toContain('attendance.final-approve.sheet');

    const bound = await prisma.rolePermission.findMany({
      where: { roleId: bizAdmin!.id },
      select: { permission: { select: { code: true } } },
    });
    const boundCodes = bound.map((b) => b.permission.code).sort();
    expect(boundCodes).toHaveLength(EXPECTED_BIZ_ADMIN_BINDING_COUNT);
    for (const code of BIZ_ADMIN_UNBOUND_CODES) {
      expect(boundCodes).not.toContain(code);
    }
    expect(boundCodes).toContain('member-insurance.review.record');
    expect(boundCodes).toEqual(
      [...EXPECTED_BIZ_PERMISSION_CODES].filter((c) => !BIZ_ADMIN_UNBOUND_CODES.includes(c)).sort(),
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
    // 终态 scoped-authz PR6:biz-admin 补挂现写 global RoleBinding(判权唯一读源;旧 UserRole 表已 DROP)。
    const holderIds = new Set(
      (
        await prisma.roleBinding.findMany({
          where: {
            roleId: bizAdmin.id,
            principalType: 'USER',
            scopeType: 'GLOBAL',
            status: 'ACTIVE',
            deletedAt: null,
          },
          select: { principalId: true },
        })
      ).map((r) => r.principalId),
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
    // 终态 scoped-authz PR6:授予现写 global RoleBinding,幂等计数改数 role_bindings。
    const bindingCount1 = await prisma.roleBinding.count();

    const second = runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'biz-seed-su-5' });
    expect(second.code).toBe(0);

    const permCount2 = await prisma.permission.count();
    const role2 = await prisma.rbacRole.findUniqueOrThrow({
      where: { code: 'biz-admin' },
      select: { id: true },
    });
    const rolePermCount2 = await prisma.rolePermission.count();
    const bindingCount2 = await prisma.roleBinding.count();

    expect(permCount2).toBe(permCount1);
    expect(role2.id).toBe(role1.id);
    expect(rolePermCount2).toBe(rolePermCount1);
    expect(bindingCount2).toBe(bindingCount1);
  });

  it('7. reviewer-only 幂等清理:老库残留三码绑定 → 再跑 seed 被 targeted 清除;他角色零触碰', async () => {
    const first = runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'biz-seed-su-6' });
    expect(first.code).toBe(0);

    const bizAdmin = await prisma.rbacRole.findUniqueOrThrow({
      where: { code: 'biz-admin' },
      select: { id: true },
    });
    const finalPerms = await prisma.permission.findMany({
      where: {
        code: {
          in: [
            'attendance.final-approve.sheet',
            'attendance.final-reject.sheet',
            'attendance.reopen.sheet',
          ],
        },
      },
      select: { id: true },
    });
    expect(finalPerms).toHaveLength(3); // 三码仍在 Permission 表(不删码)

    // 模拟 v0.34.0 及以前 seed 留下的旧绑定(seed 纯 upsert 无对账删除 → 老库会残留)
    await prisma.rolePermission.createMany({
      data: finalPerms.map((p) => ({ roleId: bizAdmin.id, permissionId: p.id })),
      skipDuplicates: true,
    });
    expect(await prisma.rolePermission.count({ where: { roleId: bizAdmin.id } })).toBe(
      EXPECTED_BIZ_ADMIN_BINDING_COUNT + 3,
    );

    const second = runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'biz-seed-su-6' });
    expect(second.code).toBe(0);

    const bound = await prisma.rolePermission.findMany({
      where: { roleId: bizAdmin.id },
      select: { permission: { select: { code: true } } },
    });
    expect(bound).toHaveLength(EXPECTED_BIZ_ADMIN_BINDING_COUNT);
    const codes = bound.map((b) => b.permission.code);
    expect(codes).not.toContain('attendance.final-approve.sheet');
    expect(codes).not.toContain('attendance.final-reject.sheet');
    expect(codes).not.toContain('attendance.reopen.sheet');

    // 清理只咬合 biz-admin:attendance-final-reviewer 的 4 条绑定原样保留。
    const finalReviewer = await prisma.rbacRole.findUniqueOrThrow({
      where: { code: 'attendance-final-reviewer' },
      select: { id: true },
    });
    expect(await prisma.rolePermission.count({ where: { roleId: finalReviewer.id } })).toBe(4);
  });
});
