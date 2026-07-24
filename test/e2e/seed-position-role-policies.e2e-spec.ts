import type { INestApplication } from '@nestjs/common';
import { execSync } from 'child_process';
import { PrismaService } from '../../src/database/prisma.service';
import { RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODES } from '../../src/modules/permissions/reserved-super-admin-permission-codes';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertTestDatabaseUrl } from '../setup/test-db';

// 终态 scoped-authz PR7(2026-07-01;冻结稿 §3.7 / §2.4 BD-1/BD-3 / 🔴 R5 / §10.5):
// 职务→角色 policy seed e2e。沿 seed-positions / seed-biz-admin 子进程范式
// (execSync pnpm tsx prisma/seed.ts;期望码集为本 spec 独立维护,与 seed 内部表对照防漂移)。
//
// 覆盖(goal DoD 5 / 7):
//   1. 内置角色 7→9:新增 org-readonly / group-readonly,码集从对应正职动态投影并逐码相等
//      (v0.61.0 PR-11 contract 后 org-admin 47 / biz-admin 68 / group-manager 20；
//       biz-admin 仍保留 activity.create/delete 与 participation read；
//       2026-07-10 §F&A-3 +member-profile.read.sensitive 自动继承但被排除〕- 敏感 2
//       - recruitment-* 12 - team-join-* 7;org-supervisor 4 = BD-3 定稿,2 候选码不加)
//   2. 6 条默认 policy(3 正职管理 + 3 副职只读,scopeMode 全 TREE);org-supervisor 不是 policy 目标
//   3. R5 v0.49 CI 断言:副职只映射对应只读角色,码集恒零写/零敏感
//   4. R5 运行时护栏生效:人为给副职塞管理 policy 后重跑 seed → 非 0 退出
//   5. 只读角色 RolePermission 精确同步:补缺失、删脏写码
//   6. 零指派 + 零漂移:5 个职务/分管角色无任何 RoleBinding 持有者(判权零影响);
//      ops-admin 96 / member 9 不变；biz-admin 68;
//      6 保留码不绑 3 新角色(F1 哨兵延伸)
//   7. 幂等:连续两次 seed counts / role id 稳定 + policy updatedAt 不 bump
//
// 终态 scoped-authz PR9(2026-07-02)追加:第 7 内置角色 `attendance-final-reviewer`(冻结稿
// 场景 4 / BD-2 终审中枢显式绑定载体)—— 角色全集 6→7;专属用例 7 锁「绑 3 既有码 + 零持有 +
// 零 policy 行(终审不随职务推导)」。
//
// 不覆盖(刻意;PR8 范围):policy → 实际授权推导(本刀 policy 表纯配置,绝不被判权路径读)。

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
    const e = err as { status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      code: e.status ?? -1,
      stdout: typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString() ?? ''),
      stderr: typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString() ?? ''),
    };
  }
}

const SEED_ENV = {
  APP_ENV: 'test',
  SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
  SUPER_ADMIN_EMAIL: '',
  RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
};

// org-admin 47 码(独立期望集;= PR-11 contract 后 biz-admin 68 继续派生；
// 2026-07-04 F4 起含 membership.transfer.record;2026-07-10 §F&A-3 起含 member-profile.read.sensitive)
// 过滤 member-profile.read.sensitive + emergency-contact.read.sensitive〔敏感明文不下放〕
// + recruitment-* 12 + team-join-* 7〔招新/入队中央流程不随组织业务下放〕→ v0.40.0 起 60，
// D-INSURANCE PR2 review.record +1；PR-11 再摘活动责任旧动作 14 条 →47。
const EXPECTED_ORG_ADMIN_CODES = [
  // member 5(v0.40.0 +offboard;member.delete.record 仅 SA,biz-admin 本就不含)
  'member.read.record',
  'member.create.record',
  'member.update.record',
  'member.update.status',
  'member.offboard.record',
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
  // activity 2(PR-11 contract 保留后台 create/delete)
  'activity.create.record',
  'activity.delete.record',
  // activity-registration 1(通用只读)
  'activity-registration.read.record',
  // attendance 1(通用只读；提交/编辑/删除/一审/终审均归责任角色)
  'attendance.read.sheet',
  // team-insurance-policy 6 + member-insurance 2(D-INSURANCE PR2 +review.record)
  'team-insurance-policy.read.record',
  'team-insurance-policy.create.record',
  'team-insurance-policy.update.record',
  'team-insurance-policy.delete.record',
  'team-insurance-policy.add.member',
  'team-insurance-policy.remove.member',
  'member-insurance.read.other',
  'member-insurance.review.record',
  // content 5 + content 附件写 4(CMS α:内容授权随 content 走)
  'content.read.record',
  'content.create.record',
  'content.update.record',
  'content.delete.record',
  'content.publish.record',
  'attachment.upload.content-image',
  'attachment.delete.content-image',
  'attachment.upload.content-file',
  'attachment.delete.content-file',
  // notification 7
  'notification.read.record',
  'notification.create.record',
  'notification.update.record',
  'notification.delete.record',
  'notification.publish.record',
  'notification.update.template',
  'notification.send.sms',
  // F4「D 组」+1(2026-07-04):归属迁移业务写,随 biz-admin 自动继承(排除规则不命中)
  'membership.transfer.record',
] as const;

// group-manager 20 码(本组资料/内容写 + 考勤/报名只读；一审需显式 reviewer RoleBinding)。
const EXPECTED_GROUP_MANAGER_CODES = [
  // attachment.upload.*/view.*(member/certificate self+other + activity;10 条)
  'attachment.upload.member.self',
  'attachment.upload.member.other',
  'attachment.upload.certificate.self',
  'attachment.upload.certificate.other',
  'attachment.upload.activity',
  'attachment.view.member.self',
  'attachment.view.member.other',
  'attachment.view.certificate.self',
  'attachment.view.certificate.other',
  'attachment.view.activity',
  // 本组队员资料只读 3
  'member-profile.read.record',
  'certificate.read.record',
  'emergency-contact.read.record',
  // content.* 5(不含 content-image/content-file 附件写)
  'content.read.record',
  'content.create.record',
  'content.update.record',
  'content.delete.record',
  'content.publish.record',
  // attendance 只读 1
  'attendance.read.sheet',
  // 报名只读 1
  'activity-registration.read.record',
] as const;

const isReadonlyProjectionCode = (code: string): boolean =>
  !code.endsWith('.read.sensitive') &&
  (code.includes('.read.') || code.startsWith('attachment.view.'));

const EXPECTED_ORG_READONLY_CODES = EXPECTED_ORG_ADMIN_CODES.filter(isReadonlyProjectionCode);
const EXPECTED_GROUP_READONLY_CODES = EXPECTED_GROUP_MANAGER_CODES.filter(isReadonlyProjectionCode);

// org-supervisor 4 码(BD-3 定稿;activity.read.record / attendance-record.read.record 2 候选码不加)。
const EXPECTED_ORG_SUPERVISOR_CODES = [
  'member.read.record',
  'activity-registration.read.record',
  'attendance.read.sheet',
  'certificate.read.record',
] as const;

// v0.49.0 默认 policy:3 正职管理 + 3 副职只读投影。
const EXPECTED_POLICIES = [
  { positionCode: 'team-leader', roleCode: 'org-admin', scopeMode: 'TREE' },
  { positionCode: 'dept-leader', roleCode: 'org-admin', scopeMode: 'TREE' },
  { positionCode: 'group-leader', roleCode: 'group-manager', scopeMode: 'TREE' },
  { positionCode: 'vice-captain', roleCode: 'org-readonly', scopeMode: 'TREE' },
  { positionCode: 'dept-deputy', roleCode: 'org-readonly', scopeMode: 'TREE' },
  { positionCode: 'deputy-group-leader', roleCode: 'group-readonly', scopeMode: 'TREE' },
] as const;

const EXPECTED_VICE_POLICIES = EXPECTED_POLICIES.filter((policy) =>
  ['vice-captain', 'dept-deputy', 'deputy-group-leader'].includes(policy.positionCode),
);

const NEW_ROLE_CODES = [
  'org-admin',
  'group-manager',
  'org-readonly',
  'group-readonly',
  'org-supervisor',
] as const;

// 终态 scoped-authz PR9:第 7 内置角色(冻结稿场景 4 / BD-2);
// v0.61.0 PR-2 后承载 read + 终审两码 + reopen + final-return 共 5 码。
const FINAL_REVIEWER_ROLE_CODE = 'attendance-final-reviewer';
const EXPECTED_FINAL_REVIEWER_CODES = [
  'attendance.read.sheet',
  'attendance.final-approve.sheet',
  'attendance.final-reject.sheet',
  'attendance.reopen.sheet',
  'attendance.final-return.sheet',
] as const;

// 既有 3 角色绑定数零漂移基线(seed-rbac 95 / seed-attachment 9 / seed-biz-admin 74〔§F&A-3 起〕同口径;
// 2026-07-02 终态 scoped-authz PR10 authz.explain.decision 绑 ops-admin 88→89;
// PR11 announcement-import 2 码绑 ops-admin 89→91;
// 2026-07-03 摘码微刀:biz-admin 摘终审两码 74→72;
// 2026-07-04 F1「A 组」meta.resolve.label 绑 ops-admin 91→92;
// 2026-07-04 F3「C 组」authz.{explain-batch,action-state}.decision 绑 ops-admin 92→94;
// 2026-07-07 队员账号闭环 v1 member.grant.account 绑 ops-admin 94→95;
// 2026-07-07 队员账号闭环 v2 member.bind.account 绑 ops-admin 95→96)。
const EXPECTED_OPS_ADMIN_BINDING_COUNT = 96;
const EXPECTED_MEMBER_ROLE_BINDING_COUNT = 9;
const EXPECTED_BIZ_ADMIN_BINDING_COUNT = 68;

const CONTRACT_REMOVED_FROM_BIZ_AND_ORG_CODES = [
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
const CONTRACT_REMOVED_FROM_GROUP_CODES = [
  'attendance.approve.sheet',
  'attendance.reject.sheet',
] as const;
const REVIEWER_ONLY_REMOVED_FROM_ORG_CODES = [
  'attendance.final-approve.sheet',
  'attendance.final-reject.sheet',
  'attendance.reopen.sheet',
] as const;
const TARGETED_REMOVED_FROM_ORG_CODES = [
  ...CONTRACT_REMOVED_FROM_BIZ_AND_ORG_CODES,
  ...REVIEWER_ONLY_REMOVED_FROM_ORG_CODES,
] as const;

async function boundCodesOf(prisma: PrismaService, roleCode: string): Promise<string[]> {
  const rows = await prisma.rolePermission.findMany({
    where: { role: { code: roleCode } },
    select: { permission: { select: { code: true } } },
  });
  return rows.map((r) => r.permission.code).sort();
}

describe('prisma/seed.ts — position role policies + v0.61.0 activity workflow(内置角色 15)', () => {
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

  it('1. 内置角色 15;org/biz/group contract 码集与只读投影不漂移', async () => {
    expect(runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'pr7-seed-su-1' }).code).toBe(0);

    const roles = await prisma.rbacRole.findMany({
      where: { deletedAt: null },
      select: { code: true },
    });
    expect(new Set(roles.map((r) => r.code))).toEqual(
      new Set([
        'ops-admin',
        'member',
        'biz-admin',
        'org-admin',
        'org-readonly',
        'group-manager',
        'group-readonly',
        'org-supervisor',
        FINAL_REVIEWER_ROLE_CODE,
        'activity-publish-reviewer',
        'activity-cross-org-initiator',
        'attendance-first-reviewer',
        'activity-owner',
        'activity-registration-collaborator',
        'activity-attendance-collaborator',
      ]),
    );

    expect(await boundCodesOf(prisma, 'org-admin')).toEqual([...EXPECTED_ORG_ADMIN_CODES].sort());
    expect(await boundCodesOf(prisma, 'group-manager')).toEqual(
      [...EXPECTED_GROUP_MANAGER_CODES].sort(),
    );
    expect(await boundCodesOf(prisma, 'org-supervisor')).toEqual(
      [...EXPECTED_ORG_SUPERVISOR_CODES].sort(),
    );
    expect(await boundCodesOf(prisma, 'org-readonly')).toEqual(
      [...EXPECTED_ORG_READONLY_CODES].sort(),
    );
    expect(await boundCodesOf(prisma, 'group-readonly')).toEqual(
      [...EXPECTED_GROUP_READONLY_CODES].sort(),
    );

    // org-admin 负向自证(BD-1 ≠ SUPER_ADMIN / BD-2 终审归中枢 / §4.2 敏感 / 中央流程不下放):
    const orgAdminCodes = await boundCodesOf(prisma, 'org-admin');
    expect(orgAdminCodes).toContain('member-insurance.review.record');
    expect(orgAdminCodes).not.toContain('attendance.final-approve.sheet');
    expect(orgAdminCodes).not.toContain('attendance.final-reject.sheet');
    expect(orgAdminCodes).not.toContain('attendance.reopen.sheet');
    for (const code of CONTRACT_REMOVED_FROM_BIZ_AND_ORG_CODES) {
      expect(orgAdminCodes).not.toContain(code);
    }
    expect(orgAdminCodes.some((c) => c.endsWith('.read.sensitive'))).toBe(false);
    expect(orgAdminCodes.some((c) => c.startsWith('recruitment-'))).toBe(false);
    expect(orgAdminCodes.some((c) => c.startsWith('team-join-'))).toBe(false);
    expect(orgAdminCodes.some((c) => c.startsWith('rbac.'))).toBe(false);
    expect(orgAdminCodes.some((c) => c.startsWith('user.'))).toBe(false);
    // group-manager 负向自证(轻量边界)
    const gmCodes = await boundCodesOf(prisma, 'group-manager');
    expect(gmCodes).not.toContain('member-insurance.review.record');
    expect(gmCodes).not.toContain('member.update.record');
    expect(gmCodes).not.toContain('attendance.final-approve.sheet');
    expect(gmCodes).not.toContain('attendance.reopen.sheet');
    for (const code of CONTRACT_REMOVED_FROM_GROUP_CODES) {
      expect(gmCodes).not.toContain(code);
    }
    expect(gmCodes.some((c) => c.startsWith('activity.'))).toBe(false); // 活动增删改/发布/取消不给组长
    // org-supervisor 只读自证(BD-3:无写、无敏感、无审批)
    const supCodes = await boundCodesOf(prisma, 'org-supervisor');
    expect(supCodes.some((c) => /\.(create|update|delete|approve|reject|set|end)\./.test(c))).toBe(
      false,
    );
    for (const roleCode of ['org-readonly', 'group-readonly']) {
      const readonlyCodes = await boundCodesOf(prisma, roleCode);
      expect(readonlyCodes.length).toBeGreaterThan(0);
      expect(readonlyCodes.every(isReadonlyProjectionCode)).toBe(true);
      expect(readonlyCodes.some((code) => code.endsWith('.read.sensitive'))).toBe(false);
    }
  });

  it('2. 6 条默认 policy(正职管理 + 副职只读,scopeMode 全 TREE);org-supervisor 不是 policy 目标', async () => {
    expect(runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'pr7-seed-su-2' }).code).toBe(0);

    const policies = await prisma.organizationPositionRolePolicy.findMany({
      where: { deletedAt: null },
      select: {
        scopeMode: true,
        conditionJson: true,
        status: true,
        position: { select: { code: true } },
        role: { select: { code: true } },
      },
    });
    expect(policies).toHaveLength(6);
    const got = policies
      .map((p) => ({
        positionCode: p.position.code,
        roleCode: p.role.code,
        scopeMode: p.scopeMode,
      }))
      .sort((a, b) => a.positionCode.localeCompare(b.positionCode));
    expect(got).toEqual(
      [...EXPECTED_POLICIES].sort((a, b) => a.positionCode.localeCompare(b.positionCode)),
    );
    // conditionJson 不用;status 全 ACTIVE
    expect(policies.every((p) => p.conditionJson === null)).toBe(true);
    expect(policies.every((p) => p.status === 'ACTIVE')).toBe(true);
    // org-supervisor 不经职务 policy(分管与职务正交,PR8 由分管推导)
    expect(policies.some((p) => p.role.code === 'org-supervisor')).toBe(false);
  });

  it('3. R5 v0.49:三个副职恰好映射对应只读角色且 scope=TREE', async () => {
    expect(runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'pr7-seed-su-3' }).code).toBe(0);

    const policies = await prisma.organizationPositionRolePolicy.findMany({
      where: {
        position: {
          code: { in: EXPECTED_VICE_POLICIES.map((policy) => policy.positionCode) },
        },
        deletedAt: null,
      },
      select: {
        scopeMode: true,
        position: { select: { code: true } },
        role: { select: { code: true } },
      },
    });
    expect(
      policies
        .map((policy) => ({
          positionCode: policy.position.code,
          roleCode: policy.role.code,
          scopeMode: policy.scopeMode,
        }))
        .sort((a, b) => a.positionCode.localeCompare(b.positionCode)),
    ).toEqual(
      [...EXPECTED_VICE_POLICIES].sort((a, b) => a.positionCode.localeCompare(b.positionCode)),
    );
  });

  it('4. R5 运行时护栏:人为给副职塞管理 policy 后重跑 seed → 非 0 退出', async () => {
    expect(runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'pr7-seed-su-4' }).code).toBe(0);

    const viceCaptain = await prisma.organizationPosition.findUniqueOrThrow({
      where: { code: 'vice-captain' },
      select: { id: true },
    });
    const orgAdmin = await prisma.rbacRole.findUniqueOrThrow({
      where: { code: 'org-admin' },
      select: { id: true },
    });
    await prisma.organizationPositionRolePolicy.create({
      data: { positionId: viceCaptain.id, roleId: orgAdmin.id },
    });

    const second = runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'pr7-seed-su-4' });
    expect(second.code).not.toBe(0);
    expect(second.stderr).toContain('R5');
  });

  it('5. 只读角色精确同步:重跑 seed 会补回缺失读码并删除脏写码', async () => {
    expect(runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'pr7-seed-su-5' }).code).toBe(0);

    const role = await prisma.rbacRole.findUniqueOrThrow({
      where: { code: 'org-readonly' },
      select: { id: true },
    });
    const [readPermission, writePermission] = await Promise.all([
      prisma.permission.findUniqueOrThrow({
        where: { code: 'member.read.record' },
        select: { id: true },
      }),
      prisma.permission.findUniqueOrThrow({
        where: { code: 'member.update.record' },
        select: { id: true },
      }),
    ]);
    await prisma.rolePermission.delete({
      where: { roleId_permissionId: { roleId: role.id, permissionId: readPermission.id } },
    });
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: writePermission.id },
    });

    expect(runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'pr7-seed-su-5' }).code).toBe(0);
    expect(await boundCodesOf(prisma, 'org-readonly')).toEqual(
      [...EXPECTED_ORG_READONLY_CODES].sort(),
    );
  });

  it('6. contract targeted 清理 org/group 残留，保留无关自定义映射与专用角色', async () => {
    expect(runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'pr7-seed-su-6-contract' }).code).toBe(0);

    const [
      orgAdmin,
      groupManager,
      customPermission,
      orgTargetedPermissions,
      groupTargetedPermissions,
    ] = await Promise.all([
      prisma.rbacRole.findUniqueOrThrow({
        where: { code: 'org-admin' },
        select: { id: true },
      }),
      prisma.rbacRole.findUniqueOrThrow({
        where: { code: 'group-manager' },
        select: { id: true },
      }),
      prisma.permission.create({
        data: {
          code: 'test.custom.position-role.keep',
          module: 'test',
          action: 'keep',
          resourceType: 'contract',
        },
        select: { id: true },
      }),
      prisma.permission.findMany({
        where: { code: { in: [...TARGETED_REMOVED_FROM_ORG_CODES] } },
        select: { id: true },
      }),
      prisma.permission.findMany({
        where: { code: { in: [...CONTRACT_REMOVED_FROM_GROUP_CODES] } },
        select: { id: true },
      }),
    ]);
    expect(orgTargetedPermissions).toHaveLength(TARGETED_REMOVED_FROM_ORG_CODES.length);
    expect(groupTargetedPermissions).toHaveLength(CONTRACT_REMOVED_FROM_GROUP_CODES.length);

    await prisma.rolePermission.createMany({
      data: [
        ...orgTargetedPermissions.map((permission) => ({
          roleId: orgAdmin.id,
          permissionId: permission.id,
        })),
        ...groupTargetedPermissions.map((permission) => ({
          roleId: groupManager.id,
          permissionId: permission.id,
        })),
        { roleId: orgAdmin.id, permissionId: customPermission.id },
        { roleId: groupManager.id, permissionId: customPermission.id },
      ],
      skipDuplicates: true,
    });

    expect(runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'pr7-seed-su-6-contract' }).code).toBe(0);
    expect(await boundCodesOf(prisma, 'org-admin')).toEqual(
      [...EXPECTED_ORG_ADMIN_CODES, 'test.custom.position-role.keep'].sort(),
    );
    expect(await boundCodesOf(prisma, 'group-manager')).toEqual(
      [...EXPECTED_GROUP_MANAGER_CODES, 'test.custom.position-role.keep'].sort(),
    );
    expect(await boundCodesOf(prisma, 'activity-publish-reviewer')).toEqual(
      [
        'activity.publish.record',
        'activity-review.read.request',
        'activity-review.return.request',
      ].sort(),
    );
    expect(await boundCodesOf(prisma, 'attendance-first-reviewer')).toEqual(
      [
        'attendance.read.sheet',
        'attendance.approve.sheet',
        'attendance.reject.sheet',
        'attendance.return.sheet',
      ].sort(),
    );
    expect(await boundCodesOf(prisma, FINAL_REVIEWER_ROLE_CODE)).toEqual(
      [...EXPECTED_FINAL_REVIEWER_CODES].sort(),
    );
  });

  it('7. 零指派 + 精确增量:5 个职务/分管角色无持有者;ops 96 / member 9 / biz 68', async () => {
    expect(runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'pr7-seed-su-6' }).code).toBe(0);

    // 5 个职务/分管角色零直接持有(判权唯一读源 RoleBinding 全类型;
    // RbacService.can 只读 GLOBAL RoleBinding → 新角色对现有判权零影响)
    const newRoles = await prisma.rbacRole.findMany({
      where: { code: { in: [...NEW_ROLE_CODES] } },
      select: { id: true },
    });
    expect(newRoles).toHaveLength(5);
    const newRoleIds = newRoles.map((r) => r.id);
    expect(await prisma.roleBinding.count({ where: { roleId: { in: newRoleIds } } })).toBe(0);

    // 既有 3 角色绑定数零漂移
    for (const [code, expected] of [
      ['ops-admin', EXPECTED_OPS_ADMIN_BINDING_COUNT],
      ['member', EXPECTED_MEMBER_ROLE_BINDING_COUNT],
      ['biz-admin', EXPECTED_BIZ_ADMIN_BINDING_COUNT],
    ] as const) {
      expect(await prisma.rolePermission.count({ where: { role: { code } } })).toBe(expected);
    }

    // F1 哨兵延伸:6 条 SUPER_ADMIN 保留码不绑任何新角色
    const reservedBindings = await prisma.rolePermission.findMany({
      where: {
        role: { code: { in: [...NEW_ROLE_CODES] } },
        permission: { code: { in: [...RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODES] } },
      },
    });
    expect(reservedBindings).toEqual([]);
  });

  it('8. 幂等:连续两次 seed counts / role id 稳定 + policy updatedAt 不 bump', async () => {
    expect(runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'pr7-seed-su-7' }).code).toBe(0);

    const roleCount1 = await prisma.rbacRole.count();
    const rolePermCount1 = await prisma.rolePermission.count();
    const policyCount1 = await prisma.organizationPositionRolePolicy.count();
    const orgAdmin1 = await prisma.rbacRole.findUniqueOrThrow({
      where: { code: 'org-admin' },
      select: { id: true },
    });

    expect(runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'pr7-seed-su-7' }).code).toBe(0);

    expect(await prisma.rbacRole.count()).toBe(roleCount1);
    expect(await prisma.rolePermission.count()).toBe(rolePermCount1);
    expect(await prisma.organizationPositionRolePolicy.count()).toBe(policyCount1);
    expect(
      (
        await prisma.rbacRole.findUniqueOrThrow({
          where: { code: 'org-admin' },
          select: { id: true },
        })
      ).id,
    ).toBe(orgAdmin1.id);

    // update:{} 幂等 → 第二次不 bump updatedAt(updatedAt 恒等于 createdAt = diff 空)
    const policies = await prisma.organizationPositionRolePolicy.findMany({
      select: { createdAt: true, updatedAt: true },
    });
    expect(policies).toHaveLength(6);
    expect(policies.every((p) => p.updatedAt.getTime() === p.createdAt.getTime())).toBe(true);
  });

  it('9. 三类 reviewer 零 PositionRolePolicy；final reviewer 精确 5 码且零持有', async () => {
    expect(runSeed({ ...SEED_ENV, SUPER_ADMIN_USERNAME: 'pr9-seed-su-8' }).code).toBe(0);

    // 码集逐码相等(read + 终审两码 + reopen + final-return)。
    expect(await boundCodesOf(prisma, FINAL_REVIEWER_ROLE_CODE)).toEqual(
      [...EXPECTED_FINAL_REVIEWER_CODES].sort(),
    );

    const reviewerRoles = await prisma.rbacRole.findMany({
      where: {
        code: {
          in: ['activity-publish-reviewer', 'attendance-first-reviewer', FINAL_REVIEWER_ROLE_CODE],
        },
      },
      select: { id: true, code: true },
    });
    expect(reviewerRoles).toHaveLength(3);
    const role = reviewerRoles.find(
      (reviewerRole) => reviewerRole.code === FINAL_REVIEWER_ROLE_CODE,
    )!;
    // 零持有(冻结稿 BD-2:生产绑定 = PR11 公告导入建立真实任职后运营经 role-bindings CRUD 挂;
    // seed 绝不发绑定 —— RoleBinding 全类型)
    expect(await prisma.roleBinding.count({ where: { roleId: role.id } })).toBe(0);
    // 零 policy 行(终审不随职务自动推导,必须显式 RoleBinding;与 org-supervisor 同为非 policy 目标)
    expect(
      await prisma.organizationPositionRolePolicy.count({
        where: { roleId: { in: reviewerRoles.map((reviewerRole) => reviewerRole.id) } },
      }),
    ).toBe(0);
  });
});
