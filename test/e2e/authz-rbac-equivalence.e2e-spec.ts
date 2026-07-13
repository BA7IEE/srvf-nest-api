import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, BindingStatus, PrincipalType, Role } from '@prisma/client';
import { execSync } from 'child_process';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { PrismaService } from '../../src/database/prisma.service';
import { AuthzService } from '../../src/modules/authz/authz.service';
import { RbacCacheService } from '../../src/modules/permissions/rbac-cache.service';
import { RbacService } from '../../src/modules/permissions/rbac.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertTestDatabaseUrl } from '../setup/test-db';

// 终态 scoped-authz PR8:🔴 authz ↔ rbac 等价矩阵 characterization(行为锁最高优先,goal DoD 2)。
//
// 锁定命题(goal 决断①):**无 resourceRef 时,authz.can(user, action) 必须与 rbac.can(user, action)
// 逐项一致** —— SUPER_ADMIN 短路 / GLOBAL 码集(getUserPermissionCodes 缓存)/ `.self` 后缀无 resource
// fail-close 三条路径全部退化等旧;scoped grant(资源未知)一律不 covers,只有 GLOBAL 能 allow。
//
// 矩阵:5 类用户〔SUPER_ADMIN / ADMIN+biz-admin / ops-admin 持有者 / 裸 USER / member 角色持有者〕
//     × 7 个 action〔业务面 / 平台面 / 终审码(约束注册 action)/ `.self` 码 / ops 组织面 / CMS 面 / 不存在码〕
// 断言逐项 authz.can === rbac.can;另锁:
//   - 建一条 scoped RoleBinding(ORGANIZATION_TREE@root)后,该 user 无 ref 判权仍与 rbac 一致且逐码不变
//     (scoped 绑定对无 ref 判权零影响 —— 镜像 PR6「RbacService 只读 GLOBAL」e2e,换 authz 入口再锁一遍)
//   - `.self` 码无 resource 双侧 fail-close(reason 同为 no_permission)
//   - explain 形状:SA → super_admin_pass + matchedGrant.source=super_admin;GLOBAL 命中 → matched + role_binding
//
// 角色 / 码集用**真 seed**(子进程 pnpm tsx prisma/seed.ts,沿 seed-position-role-policies 范式),
// 保真度 = 生产 189 码 / 7 内置角色逐字(PR9 +attendance-final-reviewer;PR10 +authz.explain.decision)。

const SEED_ENV = {
  APP_ENV: 'test',
  SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
  SUPER_ADMIN_EMAIL: '',
  RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
  SUPER_ADMIN_USERNAME: 'pr8-equiv-su',
};

function runSeed(): void {
  const envForChild: NodeJS.ProcessEnv = { ...process.env, ...SEED_ENV };
  assertTestDatabaseUrl(envForChild.DATABASE_URL);
  execSync('pnpm tsx prisma/seed.ts', {
    env: envForChild,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// 各面代表码(真 seed 里全部存在,除最后一个刻意不存在):
// member.read.record(业务面,biz-admin ✓ / ops ✗)/ rbac.role.read(平台面,ops ✓ / biz ✗)/
// attendance.final-approve.sheet(终审码 + ActionConstraint 注册 action;无 ref 不触发约束;
// 2026-07-03 摘码微刀后 biz-admin ✗ —— 两引擎同拒,等价锁不破)/
// attachment.view.member.self(.self 码,member 角色 ✓;无 resource 双侧 fail-close)/
// org.read.node(ops 组织面)/ content.publish.record(CMS 面,biz-admin ✓)/ 不存在码
const MATRIX_ACTIONS = [
  'member.read.record',
  'rbac.role.read',
  'attendance.final-approve.sheet',
  'attachment.view.member.self',
  'org.read.node',
  'content.publish.record',
  'definitely.not.a.code',
] as const;

describe('authz ↔ rbac 等价矩阵(🔴 无 ref 行为锁)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authz: AuthzService;
  let rbac: RbacService;
  let cache: RbacCacheService;

  let saPayload: CurrentUserPayload;
  let bizAdminPayload: CurrentUserPayload;
  let opsHolderPayload: CurrentUserPayload;
  let bareUserPayload: CurrentUserPayload;
  let memberHolderPayload: CurrentUserPayload;

  let rootOrgId: string;
  let orgAdminRoleId: string;

  async function createUser(
    username: string,
    role: Role,
    memberId: string | null = null,
  ): Promise<CurrentUserPayload> {
    const user = await prisma.user.create({
      data: { username, passwordHash: '$2a$10$dummy', role, memberId },
      select: { id: true, username: true, role: true, status: true, memberId: true },
    });
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      memberId: user.memberId,
    };
  }

  async function bindGlobalRole(
    userId: string,
    roleCode: string,
    tenure: { startedAt?: Date; endedAt?: Date | null } = {},
  ): Promise<void> {
    const role = await prisma.rbacRole.findFirstOrThrow({
      where: { code: roleCode, deletedAt: null },
      select: { id: true },
    });
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: userId,
        roleId: role.id,
        scopeType: BindingScopeType.GLOBAL,
        status: BindingStatus.ACTIVE,
        ...tenure,
      },
    });
    cache.invalidateUser(userId);
  }

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    runSeed();

    prisma = app.get(PrismaService);
    authz = app.get(AuthzService);
    rbac = app.get(RbacService);
    cache = app.get(RbacCacheService);

    rootOrgId = (
      await prisma.organization.findFirstOrThrow({ where: { code: 'SRVF' }, select: { id: true } })
    ).id;
    orgAdminRoleId = (
      await prisma.rbacRole.findFirstOrThrow({
        where: { code: 'org-admin', deletedAt: null },
        select: { id: true },
      })
    ).id;

    saPayload = await createUser('pr8-equiv-sa', Role.SUPER_ADMIN);
    bizAdminPayload = await createUser('pr8-equiv-biz', Role.ADMIN);
    await bindGlobalRole(bizAdminPayload.id, 'biz-admin');
    opsHolderPayload = await createUser('pr8-equiv-ops', Role.USER);
    await bindGlobalRole(opsHolderPayload.id, 'ops-admin');
    bareUserPayload = await createUser('pr8-equiv-bare', Role.USER);
    const memberRow = await prisma.member.create({
      data: { memberNo: 'pr8-equiv-m-001', displayName: 'Equiv Member' },
      select: { id: true },
    });
    memberHolderPayload = await createUser('pr8-equiv-member', Role.USER, memberRow.id);
    await bindGlobalRole(memberHolderPayload.id, 'member');
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  function usersUnderTest(): Array<[string, CurrentUserPayload]> {
    return [
      ['SUPER_ADMIN', saPayload],
      ['ADMIN+biz-admin', bizAdminPayload],
      ['ops-admin 持有者', opsHolderPayload],
      ['裸 USER', bareUserPayload],
      ['member 角色持有者', memberHolderPayload],
    ];
  }

  async function assertMatrixEquivalence(): Promise<Array<[string, string, boolean]>> {
    const outcomes: Array<[string, string, boolean]> = [];
    for (const [label, payload] of usersUnderTest()) {
      for (const action of MATRIX_ACTIONS) {
        const viaAuthz = await authz.can(payload, action);
        const viaRbac = await rbac.can(payload, action);
        // 失败信息里带上 user × action,矩阵哪一格不一致一眼可见
        expect({ label, action, viaAuthz }).toEqual({ label, action, viaAuthz: viaRbac });
        outcomes.push([label, action, viaAuthz]);
      }
    }
    return outcomes;
  }

  it('等价矩阵:5 类用户 × 7 action,authz.can(无 ref)逐项 === rbac.can', async () => {
    const outcomes = await assertMatrixEquivalence();

    // 锚点 sanity(防"两边一起错成全 false"的假等价):档位/码集事实抽查
    const by = (label: string, action: string): boolean =>
      outcomes.find(([l, a]) => l === label && a === action)?.[2] ?? false;
    expect(by('SUPER_ADMIN', 'member.read.record')).toBe(true);
    expect(by('SUPER_ADMIN', 'definitely.not.a.code')).toBe(true); // SA 短路对不存在码同样放行(现语义)
    expect(by('ADMIN+biz-admin', 'member.read.record')).toBe(true);
    expect(by('ADMIN+biz-admin', 'rbac.role.read')).toBe(false);
    expect(by('ADMIN+biz-admin', 'attendance.final-approve.sheet')).toBe(false); // 摘码微刀(2026-07-03):终审两码已不绑 biz-admin,双引擎同拒
    expect(by('ops-admin 持有者', 'rbac.role.read')).toBe(true);
    expect(by('ops-admin 持有者', 'org.read.node')).toBe(true);
    expect(by('ops-admin 持有者', 'member.read.record')).toBe(false);
    expect(by('裸 USER', 'member.read.record')).toBe(false);
    expect(by('member 角色持有者', 'attachment.view.member.self')).toBe(false); // .self 无 resource fail-close
  });

  it('.self 码无 resource:双侧 fail-close 且 reason 同为 no_permission', async () => {
    const viaRbac = await rbac.judge(memberHolderPayload, 'attachment.view.member.self');
    const viaAuthz = await authz.explain(memberHolderPayload, 'attachment.view.member.self');
    expect(viaRbac).toEqual({ allowed: false, reason: 'no_permission' });
    expect(viaAuthz.allow).toBe(false);
    expect(viaAuthz.reason).toBe('no_permission');
  });

  it('explain 形状:SA → super_admin_pass;GLOBAL 命中 → matched(source=role_binding, GLOBAL);无码 → no_permission', async () => {
    const sa = await authz.explain(saPayload, 'member.read.record');
    expect(sa.allow).toBe(true);
    expect(sa.reason).toBe('super_admin_pass');
    expect(sa.matchedGrant).toMatchObject({ source: 'super_admin', scopeType: 'GLOBAL' });

    const biz = await authz.explain(bizAdminPayload, 'member.read.record');
    expect(biz.allow).toBe(true);
    expect(biz.reason).toBe('matched');
    expect(biz.matchedGrant).toMatchObject({ source: 'role_binding', scopeType: 'GLOBAL' });

    const bare = await authz.explain(bareUserPayload, 'member.read.record');
    expect(bare).toEqual({ allow: false, reason: 'no_permission' });
  });

  it('finding 5 任期统一：未来/过期/在期 GLOBAL 绑定在 rbac.can、effectiveRoles、authz.explain 三处一致', async () => {
    const referenceNow = new Date();
    const resource = await prisma.member.create({
      data: { memberNo: 'term-equiv-resource', displayName: 'Term Equivalence Resource' },
      select: { id: true },
    });
    const cases = [
      {
        label: '未来 startedAt',
        payload: await createUser('term-equiv-future', Role.USER),
        startedAt: new Date(referenceNow.getTime() + 60 * 60 * 1000),
        endedAt: null,
        expected: false,
      },
      {
        label: '已过 endedAt',
        payload: await createUser('term-equiv-expired', Role.USER),
        startedAt: new Date(referenceNow.getTime() - 2 * 60 * 60 * 1000),
        endedAt: new Date(referenceNow.getTime() - 60 * 60 * 1000),
        expected: false,
      },
      {
        label: '当前在期',
        payload: await createUser('term-equiv-active', Role.USER),
        startedAt: new Date(referenceNow.getTime() - 60 * 60 * 1000),
        endedAt: new Date(referenceNow.getTime() + 60 * 60 * 1000),
        expected: true,
      },
    ];

    for (const c of cases) {
      await bindGlobalRole(c.payload.id, 'biz-admin', {
        startedAt: c.startedAt,
        endedAt: c.endedAt,
      });

      const viaRbac = await rbac.can(c.payload, 'member.read.record');
      const myPermissions = await rbac.getMyPermissions(c.payload);
      const viaAuthz = await authz.explain(c.payload, 'member.read.record', {
        type: 'member',
        id: resource.id,
      });

      expect({ label: c.label, viaRbac }).toEqual({ label: c.label, viaRbac: c.expected });
      expect({
        label: c.label,
        hasEffectiveRole: myPermissions.effectiveRoles.some(({ code }) => code === 'biz-admin'),
      }).toEqual({ label: c.label, hasEffectiveRole: c.expected });
      expect({ label: c.label, viaAuthz: viaAuthz.allow }).toEqual({
        label: c.label,
        viaAuthz: c.expected,
      });
      expect(viaAuthz.reason).toBe(c.expected ? 'matched' : 'expired_grant');
    }
  });

  it('🔴 scoped 绑定无感:建 ORGANIZATION_TREE@root 绑定后,该 user 无 ref 判权仍 === rbac 且逐码不变', async () => {
    const before: Record<string, boolean> = {};
    for (const action of MATRIX_ACTIONS) {
      before[action] = await authz.can(bareUserPayload, action);
    }

    // org-admin(56 业务码)@ TREE(SRVF 根)—— 若 scoped 泄进无 ref 判权,member.read.record 等会翻 true
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: bareUserPayload.id,
        roleId: orgAdminRoleId,
        scopeType: BindingScopeType.ORGANIZATION_TREE,
        scopeOrgId: rootOrgId,
        status: BindingStatus.ACTIVE,
      },
    });
    cache.invalidateUser(bareUserPayload.id);

    for (const action of MATRIX_ACTIONS) {
      const viaAuthz = await authz.can(bareUserPayload, action);
      const viaRbac = await rbac.can(bareUserPayload, action);
      expect({ action, viaAuthz }).toEqual({ action, viaAuthz: viaRbac });
      expect({ action, changed: viaAuthz !== before[action] }).toEqual({ action, changed: false });
    }
    expect(await authz.can(bareUserPayload, 'member.read.record')).toBe(false);
  });
});
