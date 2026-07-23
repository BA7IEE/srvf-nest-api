import type { INestApplication } from '@nestjs/common';
import {
  AssignmentStatus,
  BindingScopeType,
  BindingStatus,
  MembershipStatus,
  MembershipType,
  PrincipalType,
  Role,
  UserStatus,
} from '@prisma/client';
import { execSync } from 'child_process';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import {
  AUTHZ_REASON_VALUES,
  EXPLAINABLE_RESOURCE_TYPES,
  GRANT_SOURCE_VALUES,
} from '../../src/modules/authz/authz.dto';
import type { AuthzReason, GrantSource } from '../../src/modules/authz/authz.types';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser } from '../fixtures/biz-admin.fixture';
import { grantOpsAdminToUser } from '../fixtures/rbac.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertTestDatabaseUrl } from '../setup/test-db';

// 终态 scoped-authz PR10(2026-07-02;冻结稿 §7.6 + §9 行 20):POST admin/v1/authz/explain 语义 e2e。
// 角色 / 职务 / policy / 组织树用**真 seed**(子进程,沿 authz-three-source / final-review-authz 范式)——
// ops-admin 真绑 authz.explain.decision(第 189 码)、org-admin 真经 dept-leader policy 推导,与生产逐字一致。
//
// 覆盖(goal DoD 3,≥8):
//   判权门:① 缺码调用者(裸 ADMIN / 裸 USER)→ 30100;持 ops-admin 调用者全程可用
//   allow:② GLOBAL biz-admin 源(matchedGrant source=role_binding + bindingId + roleCode)
//     ③ position 源(dept-leader 任职 → policy → org-admin;source='position' + positionAssignmentId)
//     ③b scoped 绑定树内 ref(org-supervisor@TREE 命中;与 ⑤ 同 fixture 的正向对照)
//     ③c 无 ref 退化(GLOBAL 命中返合成 matchedGrant,无 bindingId = 行为锁口径)
//     ③d 目标 SUPER_ADMIN → super_admin_pass
//   deny 是数据(全部 200):④ no_permission(含"码不存在"也是 no_permission = 诊断值)
//     ⑤ out_of_scope(scoped 绑定 + 树外 ref)⑥ self_approval_forbidden(final-approve + 提交人==目标;
//     2026-07-03 摘码微刀后目标用 SA〔持权者才进约束评估〕,SA 亦拒的注册表语义在 three-source;
//     此处锁 HTTP 面 200 形状)⑦ resource_not_found(200 decision,非 404)
//   输入错误(异常):⑧ 目标用户不存在 / 已软删 → 10001;type ∉ 13 类 / action 非法格式 / 未知字段 → 400
//   决断③:DISABLED 目标也可 explain,status 原样返
//   §9 行 20:reason ∈ AuthzReason 稳定枚举(Record 完备性双向锁 + 实测响应 ⊆ 枚举)

const SEED_ENV = {
  APP_ENV: 'test',
  SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
  SUPER_ADMIN_EMAIL: '',
  RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
  SUPER_ADMIN_USERNAME: 'aex-seed-su',
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

const PAST_START = new Date('2020-01-01T00:00:00.000Z');
const EXPLAIN_PATH = '/api/admin/v1/authz/explain';

interface ExplainBody {
  userId?: string;
  action?: string;
  resourceRef?: { type?: string; id?: string; [k: string]: unknown };
}

describe('authz/explain 权限解释端点(PR10:可解释性出口)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let rootId: string;
  let apdId: string;
  let swrtId: string;

  // 调用者
  let opsAuth: string; // ADMIN + ops-admin(持 authz.explain.decision)
  let plainAdminAuth: string; // ADMIN 无任何绑定
  let bareUserAuth: string; // 裸 USER

  // 目标用户(均不登录 —— explain 的对象)
  let tBizId: string; // ADMIN + biz-admin GLOBAL
  let tHeadId: string; // USER + member + dept-leader 任职@APD(position 源)
  let tScopedId: string; // USER + RoleBinding(org-supervisor, TREE@APD)
  let tScopedBindingId: string;
  let tNoneId: string; // USER + member,零授权
  let tSaId: string; // SUPER_ADMIN
  let tDisabledId: string; // USER + biz-admin,DISABLED(决断③)
  let tDeletedId: string; // 已软删
  let tHeadAssignmentId: string;

  // 资源
  let apdMemberId: string; // PRIMARY ACTIVE membership @APD
  let swrtMemberId: string; // PRIMARY ACTIVE membership @SWRT(树外对照)
  // submitter = tSa(自审约束;2026-07-03 摘码微刀后 biz-admin 无终审码 —— 无码者先吃
  // no_permission,self_approval_forbidden 须由持权者〔SA super_admin_pass〕承载)
  let sheetByTSaId: string;

  // 实测出现过的 reason 全集(最终断言 ⊆ AUTHZ_REASON_VALUES,§9 行 20)
  const seenReasons = new Set<string>();

  function explain(auth: string, body: ExplainBody) {
    return request(httpServer(app)).post(EXPLAIN_PATH).set('Authorization', auth).send(body);
  }

  // 200 成功壳断言 + reason 收集(所有 decision 用例走此)
  async function explainOk(
    auth: string,
    body: ExplainBody,
  ): Promise<{
    targetUser: {
      id: string;
      username: string;
      role: string;
      status: string;
      memberId: string | null;
    };
    decision: {
      allow: boolean;
      reason: string;
      matchedGrant?: {
        source: string;
        bindingId?: string;
        positionAssignmentId?: string;
        supervisionAssignmentId?: string;
        roleCode?: string;
        scopeType: string;
        scopeId?: string;
      };
      resource?: {
        resourceType: string;
        resourceId: string;
        organizationId: string | null;
        organizationPath: string[] | null;
        extra?: Record<string, unknown>;
      };
    };
  }> {
    const res = await explain(auth, body);
    expect(res.status).toBe(200); // deny 是数据不是错误(goal 决断②)
    expect(res.body.code).toBe(0);
    const data = res.body.data as Awaited<ReturnType<typeof explainOk>>;
    seenReasons.add(data.decision.reason);
    return data;
  }

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    runSeed();

    prisma = app.get(PrismaService);

    const orgByCode = async (code: string): Promise<string> =>
      (await prisma.organization.findFirstOrThrow({ where: { code }, select: { id: true } })).id;
    rootId = await orgByCode('SRVF');
    apdId = await orgByCode('APD');
    swrtId = await orgByCode('SWRT');

    const roleIdByCode = async (code: string): Promise<string> =>
      (
        await prisma.rbacRole.findFirstOrThrow({
          where: { code, deletedAt: null },
          select: { id: true },
        })
      ).id;
    const opsAdminRoleId = await roleIdByCode('ops-admin');
    const bizAdminRoleId = await roleIdByCode('biz-admin');
    const orgSupervisorRoleId = await roleIdByCode('org-supervisor');

    // ===== 调用者 =====
    const opsCaller = await createTestUser(app, { username: 'aex-ops-adm', role: Role.ADMIN });
    await createTestUser(app, { username: 'aex-adm-plain', role: Role.ADMIN });
    await createTestUser(app, { username: 'aex-bare-user', role: Role.USER });
    await grantOpsAdminToUser(app, opsCaller.id, opsAdminRoleId);
    opsAuth = (await loginAs(app, 'aex-ops-adm')).authHeader;
    plainAdminAuth = (await loginAs(app, 'aex-adm-plain')).authHeader;
    bareUserAuth = (await loginAs(app, 'aex-bare-user')).authHeader;

    // ===== 目标用户 =====
    const tBiz = await createTestUser(app, { username: 'aex-t-biz', role: Role.ADMIN });
    tBizId = tBiz.id;
    await grantBizAdminToUser(app, tBizId, bizAdminRoleId);

    const mkMember = async (tag: string): Promise<string> =>
      (
        await prisma.member.create({
          data: { memberNo: `aex-m-${tag}`, displayName: `AEX ${tag}` },
          select: { id: true },
        })
      ).id;

    // position 源:dept-leader 任职@APD → seed policy dept-leader→org-admin@TREE
    const tHead = await createTestUser(app, { username: 'aex-t-head', role: Role.USER });
    tHeadId = tHead.id;
    const tHeadMemberId = await mkMember('head');
    await prisma.user.update({ where: { id: tHeadId }, data: { memberId: tHeadMemberId } });
    const deptLeaderPositionId = (
      await prisma.organizationPosition.findFirstOrThrow({
        where: { code: 'dept-leader', deletedAt: null },
        select: { id: true },
      })
    ).id;
    tHeadAssignmentId = (
      await prisma.organizationPositionAssignment.create({
        data: {
          memberId: tHeadMemberId,
          organizationId: apdId,
          positionId: deptLeaderPositionId,
          status: AssignmentStatus.ACTIVE,
          startedAt: PAST_START,
        },
        select: { id: true },
      })
    ).id;

    // scoped 绑定:org-supervisor(含 member.read.record)@ ORGANIZATION_TREE(APD)
    const tScoped = await createTestUser(app, { username: 'aex-t-scoped', role: Role.USER });
    tScopedId = tScoped.id;
    tScopedBindingId = (
      await prisma.roleBinding.create({
        data: {
          principalType: PrincipalType.USER,
          principalId: tScopedId,
          roleId: orgSupervisorRoleId,
          scopeType: BindingScopeType.ORGANIZATION_TREE,
          scopeOrgId: apdId,
          status: BindingStatus.ACTIVE,
          startedAt: PAST_START,
        },
        select: { id: true },
      })
    ).id;

    const tNone = await createTestUser(app, { username: 'aex-t-none', role: Role.USER });
    tNoneId = tNone.id;
    await prisma.user.update({
      where: { id: tNoneId },
      data: { memberId: await mkMember('none') },
    });

    const tSa = await createTestUser(app, { username: 'aex-t-sa', role: Role.SUPER_ADMIN });
    tSaId = tSa.id;

    // 决断③:DISABLED 目标(线上真实请求会被 JwtStrategy 挡;explain 仍可诊断,status 原样返)
    const tDisabled = await createTestUser(app, { username: 'aex-t-dis', role: Role.ADMIN });
    tDisabledId = tDisabled.id;
    await grantBizAdminToUser(app, tDisabledId, bizAdminRoleId);
    await prisma.user.update({
      where: { id: tDisabledId },
      data: { status: UserStatus.DISABLED },
    });

    const tDeleted = await createTestUser(app, { username: 'aex-t-del', role: Role.USER });
    tDeletedId = tDeleted.id;
    await prisma.user.update({ where: { id: tDeletedId }, data: { deletedAt: new Date() } });

    // ===== 资源 =====
    apdMemberId = await mkMember('apd');
    await prisma.memberOrganizationMembership.create({
      data: {
        memberId: apdMemberId,
        organizationId: apdId,
        membershipType: MembershipType.PRIMARY,
        status: MembershipStatus.ACTIVE,
      },
    });
    swrtMemberId = await mkMember('swrt');
    await prisma.memberOrganizationMembership.create({
      data: {
        memberId: swrtMemberId,
        organizationId: swrtId,
        membershipType: MembershipType.PRIMARY,
        status: MembershipStatus.ACTIVE,
      },
    });

    // 自审约束资源:APD 活动 + tSa 本人提交的 sheet(约束只读 extra.submitterUserId)
    const activity = await prisma.activity.create({
      data: {
        title: 'explain 诊断演示',
        activityTypeCode: 'aex-demo',
        organizationId: apdId,
        startAt: new Date('2026-06-01T01:00:00.000Z'),
        endAt: new Date('2026-06-01T05:00:00.000Z'),
        location: '训练场',
        statusCode: 'completed',
      },
      select: { id: true },
    });
    sheetByTSaId = (
      await prisma.attendanceSheet.create({
        data: {
          activityId: activity.id,
          submitterUserId: tSaId,
          statusCode: 'pending_final_review',
          version: 1,
        },
        select: { id: true },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  // ===== ① 调用者判权门(R 模式 rbac.can('authz.explain.decision'))=====

  it('缺码调用者 → 30100(裸 ADMIN 与裸 USER;入参合法也不放行)', async () => {
    const body = { userId: tNoneId, action: 'member.read.record' };
    expectBizError(await explain(plainAdminAuth, body), BizCode.RBAC_FORBIDDEN);
    expectBizError(await explain(bareUserAuth, body), BizCode.RBAC_FORBIDDEN);
  });

  // ===== allow 通路(matchedGrant 可解释)=====

  it('② GLOBAL biz-admin 源:allow + matchedGrant(source=role_binding + bindingId + roleCode=biz-admin)+ resource 归属', async () => {
    const data = await explainOk(opsAuth, {
      userId: tBizId,
      action: 'member.read.record',
      resourceRef: { type: 'member', id: apdMemberId },
    });
    expect(data.targetUser).toEqual({
      id: tBizId,
      username: 'aex-t-biz',
      role: Role.ADMIN,
      status: UserStatus.ACTIVE,
      memberId: null,
    });
    expect(data.decision.allow).toBe(true);
    expect(data.decision.reason).toBe('matched');
    expect(data.decision.matchedGrant?.source).toBe('role_binding');
    expect(data.decision.matchedGrant?.scopeType).toBe(BindingScopeType.GLOBAL);
    expect(data.decision.matchedGrant?.roleCode).toBe('biz-admin');
    expect(data.decision.matchedGrant?.bindingId).toEqual(expect.any(String));
    expect(data.decision.resource?.resourceType).toBe('member');
    expect(data.decision.resource?.resourceId).toBe(apdMemberId);
    expect(data.decision.resource?.organizationId).toBe(apdId);
    expect(data.decision.resource?.organizationPath).toEqual([rootId, apdId]);
  });

  it('③ position 源:dept-leader 任职@APD → policy → org-admin@TREE;matchedGrant.source=position + positionAssignmentId', async () => {
    const data = await explainOk(opsAuth, {
      userId: tHeadId,
      action: 'member.read.record',
      resourceRef: { type: 'member', id: apdMemberId },
    });
    expect(data.decision.allow).toBe(true);
    expect(data.decision.reason).toBe('matched');
    expect(data.decision.matchedGrant?.source).toBe('position');
    expect(data.decision.matchedGrant?.roleCode).toBe('org-admin');
    expect(data.decision.matchedGrant?.positionAssignmentId).toBe(tHeadAssignmentId);
    expect(data.decision.matchedGrant?.scopeType).toBe(BindingScopeType.ORGANIZATION_TREE);
    expect(data.decision.matchedGrant?.scopeId).toBe(apdId);
  });

  it('③b scoped 绑定树内 ref:org-supervisor@TREE(APD) 对 APD 队员 → allow(⑤ 的正向对照)', async () => {
    const data = await explainOk(opsAuth, {
      userId: tScopedId,
      action: 'member.read.record',
      resourceRef: { type: 'member', id: apdMemberId },
    });
    expect(data.decision.allow).toBe(true);
    expect(data.decision.reason).toBe('matched');
    expect(data.decision.matchedGrant?.source).toBe('role_binding');
    expect(data.decision.matchedGrant?.bindingId).toBe(tScopedBindingId);
    expect(data.decision.matchedGrant?.scopeType).toBe(BindingScopeType.ORGANIZATION_TREE);
    expect(data.decision.matchedGrant?.scopeId).toBe(apdId);
  });

  it('③c 无 ref 退化:GLOBAL 命中返合成 matchedGrant(无 bindingId;行为锁口径 = rbac 全局判定)', async () => {
    const data = await explainOk(opsAuth, { userId: tBizId, action: 'member.read.record' });
    expect(data.decision.allow).toBe(true);
    expect(data.decision.reason).toBe('matched');
    expect(data.decision.matchedGrant).toEqual({
      source: 'role_binding',
      scopeType: BindingScopeType.GLOBAL,
    });
    expect(data.decision.resource).toBeUndefined();
  });

  it('③d 目标 SUPER_ADMIN → super_admin_pass 短路(matchedGrant.source=super_admin)', async () => {
    const data = await explainOk(opsAuth, { userId: tSaId, action: 'member.read.record' });
    expect(data.decision.allow).toBe(true);
    expect(data.decision.reason).toBe('super_admin_pass');
    expect(data.decision.matchedGrant?.source).toBe('super_admin');
    expect(data.decision.matchedGrant?.scopeType).toBe(BindingScopeType.GLOBAL);
  });

  // ===== deny 是数据(全部 200 decision)=====

  it('④ no_permission:零授权目标(带 ref)与"码不存在"(无 ref)都是 200 诊断结论', async () => {
    const withRef = await explainOk(opsAuth, {
      userId: tNoneId,
      action: 'member.read.record',
      resourceRef: { type: 'member', id: apdMemberId },
    });
    expect(withRef.decision.allow).toBe(false);
    expect(withRef.decision.reason).toBe('no_permission');
    expect(withRef.decision.matchedGrant).toBeUndefined();
    expect(withRef.decision.resource?.resourceId).toBe(apdMemberId);

    // 不存在的码 → no_permission 本身就是诊断价值(不要求码存在,goal DoD 1)
    const ghostCode = await explainOk(opsAuth, {
      userId: tBizId,
      action: 'ghost.read.record',
    });
    expect(ghostCode.decision.allow).toBe(false);
    expect(ghostCode.decision.reason).toBe('no_permission');
  });

  it('⑤ out_of_scope:scoped 绑定(TREE@APD)+ 树外 ref(SWRT 队员)→ 200 allow:false', async () => {
    const data = await explainOk(opsAuth, {
      userId: tScopedId,
      action: 'member.read.record',
      resourceRef: { type: 'member', id: swrtMemberId },
    });
    expect(data.decision.allow).toBe(false);
    expect(data.decision.reason).toBe('out_of_scope');
    expect(data.decision.matchedGrant).toBeUndefined();
    expect(data.decision.resource?.organizationId).toBe(swrtId);
  });

  it('⑥ self_approval_forbidden:final-approve + 提交人==目标用户(SA,持权)→ 200 返 reason(不是 403)', async () => {
    // 摘码微刀(2026-07-03):biz-admin 目标会先吃 no_permission(约束只在 grant 命中后评估),
    // 本 reason 改由 SA(super_admin_pass 后被约束否决)承载 —— 亦即「SA 自审照拒」的 explain 面证据。
    const data = await explainOk(opsAuth, {
      userId: tSaId,
      action: 'attendance.final-approve.sheet',
      resourceRef: { type: 'attendance_sheet', id: sheetByTSaId },
    });
    expect(data.decision.allow).toBe(false);
    expect(data.decision.reason).toBe('self_approval_forbidden');
    expect(data.decision.resource?.extra?.submitterUserId).toBe(tSaId);
  });

  it('⑦ resource_not_found 是 200 的 decision reason(诊断端点回答"为什么",不抛业务错)', async () => {
    const data = await explainOk(opsAuth, {
      userId: tBizId,
      action: 'member.read.record',
      resourceRef: { type: 'member', id: 'aex-no-such-member' },
    });
    expect(data.decision.allow).toBe(false);
    expect(data.decision.reason).toBe('resource_not_found');
    expect(data.decision.resource).toBeUndefined();
  });

  it('决断③:DISABLED 目标也可 explain,status 原样返(运营排查"他为什么不行"的第一层)', async () => {
    const data = await explainOk(opsAuth, { userId: tDisabledId, action: 'member.read.record' });
    expect(data.targetUser.status).toBe(UserStatus.DISABLED);
    expect(data.decision.allow).toBe(true); // 授权层面 biz-admin 命中;登录层由 JwtStrategy 挡
  });

  // ===== ⑧ 输入错误(异常路径)=====

  it('目标用户不存在 / 已软删 → 10001(USER_NOT_FOUND)', async () => {
    expectBizError(
      await explain(opsAuth, { userId: 'aex-ghost-user', action: 'member.read.record' }),
      BizCode.USER_NOT_FOUND,
    );
    expectBizError(
      await explain(opsAuth, { userId: tDeletedId, action: 'member.read.record' }),
      BizCode.USER_NOT_FOUND,
    );
  });

  it('入参白名单:type ∉ 13 类 / action 非法格式 / resourceRef 未知字段 → 400(不新增 BizCode)', async () => {
    const badType = await explain(opsAuth, {
      userId: tBizId,
      action: 'member.read.record',
      resourceRef: { type: 'bogus_type', id: 'x' },
    });
    expectBizError(badType, BizCode.BAD_REQUEST, { strictMessage: false });

    const badAction = await explain(opsAuth, { userId: tBizId, action: 'NotAPermissionCode' });
    expectBizError(badAction, BizCode.BAD_REQUEST, { strictMessage: false });

    const tooFewSegments = await explain(opsAuth, { userId: tBizId, action: 'member.read' });
    expectBizError(tooFewSegments, BizCode.BAD_REQUEST, { strictMessage: false });

    const extraField = await explain(opsAuth, {
      userId: tBizId,
      action: 'member.read.record',
      resourceRef: { type: 'member', id: apdMemberId, hack: true },
    });
    expectBizError(extraField, BizCode.BAD_REQUEST, { strictMessage: false });
  });

  // ===== §9 行 20:reason 枚举契约锁 =====

  it('reason 稳定枚举:DTO 数组与 AuthzReason 联合双向完备,实测响应 ⊆ 枚举', () => {
    // 完备性锁(方向 2):Record<AuthzReason, true> 字面量要求联合的每个成员都在场 ——
    // PR8 加新 reason 而 DTO 枚举没跟上时,本对象编译失败;方向 1(不出联合外值)由
    // authz.dto.ts 的 `satisfies readonly AuthzReason[]` 在编译期锁。
    const reasonCover: Record<AuthzReason, true> = {
      super_admin_pass: true,
      matched: true,
      no_permission: true,
      out_of_scope: true,
      out_of_supervised_scope: true,
      expired_grant: true,
      inactive_org: true,
      self_approval_forbidden: true,
      same_reviewer_forbidden: true,
      sensitive_denied: true,
      resource_not_found: true,
    };
    expect([...AUTHZ_REASON_VALUES].sort()).toEqual(Object.keys(reasonCover).sort());

    const sourceCover: Record<GrantSource, true> = {
      super_admin: true,
      role_binding: true,
      position: true,
      supervision: true,
    };
    expect([...GRANT_SOURCE_VALUES].sort()).toEqual(Object.keys(sourceCover).sort());

    // resourceRef.type 白名单 = resolver 13 类
    expect(EXPLAINABLE_RESOURCE_TYPES).toHaveLength(13);
    expect(EXPLAINABLE_RESOURCE_TYPES).toContain('organization');
    expect(EXPLAINABLE_RESOURCE_TYPES).toContain('activity_publish_review');

    // 本 spec 实测出现过的每个 reason 都必须落在稳定枚举内(响应契约,§9 行 20)
    expect(seenReasons.size).toBeGreaterThanOrEqual(6);
    for (const r of seenReasons) {
      expect(AUTHZ_REASON_VALUES).toContain(r as AuthzReason);
    }
  });
});
