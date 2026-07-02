import type { INestApplication } from '@nestjs/common';
import {
  AssignmentStatus,
  BindingScopeType,
  BindingStatus,
  PrincipalType,
  Role,
} from '@prisma/client';
import { execSync } from 'child_process';
import request from 'supertest';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { AuthzService } from '../../src/modules/authz/authz.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser } from '../fixtures/biz-admin.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertTestDatabaseUrl } from '../setup/test-db';

// 终态 scoped-authz PR9(2026-07-02;冻结稿 §5.2/§5.3 + BD-2;首个 authz 消费者):
// 考勤终审 HTTP 面接线矩阵。角色 / 职务 / 组织树(含 closure)用**真 seed**(子进程,沿
// authz-three-source 范式)—— scoped 通路用的是 seed 真第 7 角色 `attendance-final-reviewer`,
// 与生产逐字一致;sheet 直造(pending_final_review + 显式 submitter/reviewer)。
//
// 覆盖(goal DoD 2/3/4):
//   真收紧:①自审 → 22074(SUPER_ADMIN 亦拒)②一级同人 → 22075(默认)
//     ③final-reject 无约束(注册表 PR8 冻结仅 final-approve —— 锁不对称语义)
//   行为锁:④biz-admin ADMIN 终审他人单 → 200(B 方案 GLOBAL 通路契约照旧)
//     ⑤裸 USER / 无 biz-admin 的 ADMIN → 30100(权限拒绝面零变)
//   scoped 通路(BD-2 全链):⑥dept-leader 任职 + RoleBinding(POSITION_ASSIGNMENT,
//     attendance-final-reviewer, TREE@root)且**无 biz-admin** → 终审他人单 200
//     (service 级 explain 自证 matchedGrant.source=role_binding);撤任职(ENDED)→ 同请求
//     30100(explain=expired_grant,换届即失权);⑦同职务无绑定者 → 30100(no_permission ——
//     职务→org-admin policy 不含终审码,BD-2 终审绝不随职务推导)
//   env 开关:⑧ATTENDANCE_ALLOW_SAME_REVIEWER=true(独立 app 实例)→ 同人放行、自审仍拒
//
// 约束语义的纯函数/服务级矩阵在 action-constraints.spec + authz-three-source 场景 4;
// deny → BizCode 映射的 unit 面在 attendances.service.spec「PR9 终审 authz 判权」。

const SEED_ENV = {
  APP_ENV: 'test',
  SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
  SUPER_ADMIN_EMAIL: '',
  RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
  SUPER_ADMIN_USERNAME: 'pr9-fra-su',
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
const FINAL_REVIEWER_ROLE_CODE = 'attendance-final-reviewer';

describe('attendances 终审 authz 接线(PR9:22074/22075/30100 矩阵 + BD-2 scoped 通路)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authz: AuthzService;

  let rootId: string;
  let apdId: string;
  let activityId: string;

  // HTTP 身份(均 loginAs 真登录)
  let subAdminId: string; // ADMIN + biz-admin;固定当 submitter
  let subAdminAuth: string;
  let revAdminId: string; // ADMIN + biz-admin;固定当一级审核人
  let revAdminAuth: string;
  let finalAdminAuth: string; // ADMIN + biz-admin;中性终审人(行为锁 ④)
  let saUserId: string;
  let saAuth: string;
  let bareUserAuth: string;
  let adminNoGrantAuth: string;
  // BD-2 scoped 终审人(无 biz-admin,仅 POSITION_ASSIGNMENT 主体绑定)
  let deptHeadAuth: string;
  let deptHeadPayload: CurrentUserPayload;
  let deptHeadAssignmentId: string;
  // 同职务无绑定者(⑦)
  let deptPeerAuth: string;

  // 直造 pending_final_review sheet(显式 submitter / 一级 reviewer;绕过 submit/approve 状态机,
  // 约束只读这两个事实字段)。时间窗不建 record —— 终审判权/状态机不读 records。
  async function mkSheet(submitterUserId: string, reviewerUserId?: string): Promise<string> {
    const sheet = await prisma.attendanceSheet.create({
      data: {
        activityId,
        submitterUserId,
        reviewerUserId: reviewerUserId ?? null,
        statusCode: 'pending_final_review',
        version: 1,
      },
      select: { id: true },
    });
    return sheet.id;
  }

  function finalApprove(sheetId: string, auth: string) {
    return request(httpServer(app))
      .patch(`/api/admin/v1/attendance-sheets/${sheetId}/final-approve`)
      .set('Authorization', auth)
      .send({ finalReviewNote: 'authz matrix' });
  }

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    runSeed();

    prisma = app.get(PrismaService);
    authz = app.get(AuthzService);

    const orgByCode = async (code: string): Promise<string> =>
      (await prisma.organization.findFirstOrThrow({ where: { code }, select: { id: true } })).id;
    rootId = await orgByCode('SRVF');
    apdId = await orgByCode('APD');

    // 活动挂真 seed 部门(closure 由 seed 维护;TREE@root 经 organizationPath 覆盖)
    const activity = await prisma.activity.create({
      data: {
        title: '终审接线演示',
        activityTypeCode: 'pr9-demo',
        organizationId: apdId,
        startAt: new Date('2026-06-01T01:00:00.000Z'),
        endAt: new Date('2026-06-01T05:00:00.000Z'),
        location: '训练场',
        statusCode: 'completed',
      },
      select: { id: true },
    });
    activityId = activity.id;

    // ===== HTTP 身份 =====
    const subAdmin = await createTestUser(app, { username: 'fra-sub-adm', role: Role.ADMIN });
    const revAdmin = await createTestUser(app, { username: 'fra-rev-adm', role: Role.ADMIN });
    const finalAdmin = await createTestUser(app, { username: 'fra-final-adm', role: Role.ADMIN });
    const saUser = await createTestUser(app, { username: 'fra-su-2', role: Role.SUPER_ADMIN });
    await createTestUser(app, { username: 'fra-bare-user', role: Role.USER });
    await createTestUser(app, { username: 'fra-adm-nogrant', role: Role.ADMIN });
    subAdminId = subAdmin.id;
    revAdminId = revAdmin.id;
    saUserId = saUser.id;

    // biz-admin 用真 seed 角色(74 码含终审两码;B 方案不摘)
    const bizAdminRoleId = (
      await prisma.rbacRole.findFirstOrThrow({
        where: { code: 'biz-admin', deletedAt: null },
        select: { id: true },
      })
    ).id;
    await grantBizAdminToUser(app, subAdmin.id, bizAdminRoleId);
    await grantBizAdminToUser(app, revAdmin.id, bizAdminRoleId);
    await grantBizAdminToUser(app, finalAdmin.id, bizAdminRoleId);

    subAdminAuth = (await loginAs(app, 'fra-sub-adm')).authHeader;
    revAdminAuth = (await loginAs(app, 'fra-rev-adm')).authHeader;
    finalAdminAuth = (await loginAs(app, 'fra-final-adm')).authHeader;
    saAuth = (await loginAs(app, 'fra-su-2')).authHeader;
    bareUserAuth = (await loginAs(app, 'fra-bare-user')).authHeader;
    adminNoGrantAuth = (await loginAs(app, 'fra-adm-nogrant')).authHeader;

    // ===== BD-2 scoped 终审人:APD dept-leader 任职 + attendance-final-reviewer@TREE(root)=====
    const deptHeadUser = await createTestUser(app, { username: 'fra-dept-head', role: Role.USER });
    const deptHeadMember = await prisma.member.create({
      data: { memberNo: 'fra-m-head', displayName: 'FRA 部长' },
      select: { id: true },
    });
    await prisma.user.update({
      where: { id: deptHeadUser.id },
      data: { memberId: deptHeadMember.id },
    });
    deptHeadAuth = (await loginAs(app, 'fra-dept-head')).authHeader;
    deptHeadPayload = {
      id: deptHeadUser.id,
      username: 'fra-dept-head',
      role: Role.USER,
      status: deptHeadUser.status,
      memberId: deptHeadMember.id,
    };

    const deptLeaderPositionId = (
      await prisma.organizationPosition.findFirstOrThrow({
        where: { code: 'dept-leader', deletedAt: null },
        select: { id: true },
      })
    ).id;
    deptHeadAssignmentId = (
      await prisma.organizationPositionAssignment.create({
        data: {
          memberId: deptHeadMember.id,
          organizationId: apdId,
          positionId: deptLeaderPositionId,
          status: AssignmentStatus.ACTIVE,
          startedAt: PAST_START,
        },
        select: { id: true },
      })
    ).id;
    const finalReviewerRoleId = (
      await prisma.rbacRole.findFirstOrThrow({
        where: { code: FINAL_REVIEWER_ROLE_CODE, deletedAt: null },
        select: { id: true },
      })
    ).id;
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.POSITION_ASSIGNMENT,
        principalId: deptHeadAssignmentId,
        roleId: finalReviewerRoleId,
        scopeType: BindingScopeType.ORGANIZATION_TREE,
        scopeOrgId: rootId,
        status: BindingStatus.ACTIVE,
        startedAt: PAST_START,
      },
    });

    // ⑦ 同职务(APD dept-leader)但零 RoleBinding 的对照者
    const peerUser = await createTestUser(app, { username: 'fra-dept-peer', role: Role.USER });
    const peerMember = await prisma.member.create({
      data: { memberNo: 'fra-m-peer', displayName: 'FRA 部长对照' },
      select: { id: true },
    });
    await prisma.user.update({ where: { id: peerUser.id }, data: { memberId: peerMember.id } });
    deptPeerAuth = (await loginAs(app, 'fra-dept-peer')).authHeader;
    await prisma.organizationPositionAssignment.create({
      data: {
        memberId: peerMember.id,
        organizationId: apdId,
        positionId: deptLeaderPositionId,
        status: AssignmentStatus.ACTIVE,
        startedAt: PAST_START,
      },
    });
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  // ============ 真收紧(goal DoD 2)============

  it('①自审:submitter==终审人 → 22074;单据零变化(deny 在事务前)', async () => {
    const sheetId = await mkSheet(subAdminId);
    expectBizError(
      await finalApprove(sheetId, subAdminAuth),
      BizCode.ATTENDANCE_SELF_FINAL_REVIEW_FORBIDDEN,
    );
    const db = await prisma.attendanceSheet.findUniqueOrThrow({
      where: { id: sheetId },
      select: { statusCode: true, finalReviewerUserId: true },
    });
    expect(db).toEqual({ statusCode: 'pending_final_review', finalReviewerUserId: null });
  });

  it('①b 自审对 SUPER_ADMIN 亦拒(域不变量不随短路豁免)→ 22074', async () => {
    const sheetId = await mkSheet(saUserId);
    expectBizError(
      await finalApprove(sheetId, saAuth),
      BizCode.ATTENDANCE_SELF_FINAL_REVIEW_FORBIDDEN,
    );
  });

  it('②一级同人:reviewer==终审人 → 22075(默认禁止)', async () => {
    const sheetId = await mkSheet(subAdminId, revAdminId);
    expectBizError(
      await finalApprove(sheetId, revAdminAuth),
      BizCode.ATTENDANCE_SAME_REVIEWER_FORBIDDEN,
    );
  });

  it('③final-reject 无自审/同人约束(注册表 PR8 冻结仅 final-approve)—— submitter 自 reject → 200', async () => {
    const sheetId = await mkSheet(subAdminId, revAdminId);
    const res = await request(httpServer(app))
      .patch(`/api/admin/v1/attendance-sheets/${sheetId}/final-reject`)
      .set('Authorization', subAdminAuth)
      .send({ finalReviewNote: '终审驳回(无约束面)' });
    expect(res.status).toBe(200);
    expect(res.body.data.statusCode).toBe('final_rejected');
  });

  // ============ 行为锁(goal DoD 3;B 方案契约照旧)============

  it('④biz-admin ADMIN 终审他人提交、他人一级审的单 → 200(GLOBAL grant 通路)', async () => {
    const sheetId = await mkSheet(subAdminId, revAdminId);
    const res = await finalApprove(sheetId, finalAdminAuth);
    expect(res.status).toBe(200);
    expect(res.body.data.statusCode).toBe('approved');
    expect(res.body.data.finalReviewerUserId).toBeTruthy();
  });

  it('⑤裸 USER / 无 biz-admin 的 ADMIN → 30100(权限拒绝面契约零变)', async () => {
    const sheetId = await mkSheet(subAdminId, revAdminId);
    expectBizError(await finalApprove(sheetId, bareUserAuth), BizCode.RBAC_FORBIDDEN);
    expectBizError(await finalApprove(sheetId, adminNoGrantAuth), BizCode.RBAC_FORBIDDEN);
    // final-reject 同样 30100(切 authz 后权限面不变)
    expectBizError(
      await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${sheetId}/final-reject`)
        .set('Authorization', bareUserAuth)
        .send({ finalReviewNote: 'X' }),
      BizCode.RBAC_FORBIDDEN,
    );
  });

  // ============ BD-2 scoped 通路(goal DoD 4)============

  it('⑥scoped 全链:任职+绑定 → 200(source=role_binding);撤任职 → 同请求 30100(expired_grant 换届即失权)', async () => {
    // 无 biz-admin 的 USER,仅凭 POSITION_ASSIGNMENT 主体绑定终审他人单 → ALLOW
    const sheetA = await mkSheet(subAdminId, revAdminId);
    const explainAllow = await authz.explain(deptHeadPayload, 'attendance.final-approve.sheet', {
      type: 'attendance_sheet',
      id: sheetA,
    });
    expect(explainAllow.allow).toBe(true);
    expect(explainAllow.matchedGrant?.source).toBe('role_binding');
    expect(explainAllow.matchedGrant?.roleCode).toBe(FINAL_REVIEWER_ROLE_CODE);
    expect(explainAllow.matchedGrant?.scopeType).toBe(BindingScopeType.ORGANIZATION_TREE);
    const resAllow = await finalApprove(sheetA, deptHeadAuth);
    expect(resAllow.status).toBe(200);
    expect(resAllow.body.data.statusCode).toBe('approved');

    // 换届:任职 ENDED → POSITION_ASSIGNMENT 主体绑定随之失效(不动绑定行)
    await prisma.organizationPositionAssignment.update({
      where: { id: deptHeadAssignmentId },
      data: { status: AssignmentStatus.ENDED, endedAt: new Date('2026-01-01T00:00:00.000Z') },
    });
    const sheetB = await mkSheet(subAdminId, revAdminId);
    const explainDeny = await authz.explain(deptHeadPayload, 'attendance.final-approve.sheet', {
      type: 'attendance_sheet',
      id: sheetB,
    });
    expect(explainDeny.allow).toBe(false);
    expect(explainDeny.reason).toBe('expired_grant');
    expectBizError(await finalApprove(sheetB, deptHeadAuth), BizCode.RBAC_FORBIDDEN);
  });

  it('⑦同职务无绑定者 → 30100(no_permission;终审绝不随职务推导 —— org-admin policy 无终审码)', async () => {
    const sheetId = await mkSheet(subAdminId, revAdminId);
    expectBizError(await finalApprove(sheetId, deptPeerAuth), BizCode.RBAC_FORBIDDEN);
  });

  // ============ env 开关(goal 决断②;独立 app 实例读 env)============

  describe('⑧ATTENDANCE_ALLOW_SAME_REVIEWER=true(独立 app;同人放行、自审仍拒)', () => {
    let relaxedApp: INestApplication;
    let relaxedSubAuth: string;
    let relaxedRevAuth: string;

    beforeAll(async () => {
      process.env.ATTENDANCE_ALLOW_SAME_REVIEWER = 'true';
      relaxedApp = await createTestApp();
      // 同库同用户,对新 app 实例重新登录(fixtures 不重建)
      relaxedSubAuth = (await loginAs(relaxedApp, 'fra-sub-adm')).authHeader;
      relaxedRevAuth = (await loginAs(relaxedApp, 'fra-rev-adm')).authHeader;
    }, 60_000);

    afterAll(async () => {
      delete process.env.ATTENDANCE_ALLOW_SAME_REVIEWER;
      await relaxedApp.close();
    });

    it('一级同人 → 200 放行;自审 → 22074 仍拒(自审永不可配)', async () => {
      const sameReviewerSheet = await mkSheet(subAdminId, revAdminId);
      const res = await request(httpServer(relaxedApp))
        .patch(`/api/admin/v1/attendance-sheets/${sameReviewerSheet}/final-approve`)
        .set('Authorization', relaxedRevAuth)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.data.statusCode).toBe('approved');

      const selfSheet = await mkSheet(subAdminId, revAdminId);
      expectBizError(
        await request(httpServer(relaxedApp))
          .patch(`/api/admin/v1/attendance-sheets/${selfSheet}/final-approve`)
          .set('Authorization', relaxedSubAuth)
          .send({}),
        BizCode.ATTENDANCE_SELF_FINAL_REVIEW_FORBIDDEN,
      );
    });
  });
});
