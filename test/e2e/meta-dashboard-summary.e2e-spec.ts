import type { INestApplication } from '@nestjs/common';
import { AssignmentStatus, BindingScopeType, PrincipalType, Role } from '@prisma/client';
import { execSync } from 'child_process';
import request from 'supertest';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantOpsAdminToUser } from '../fixtures/rbac.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertTestDatabaseUrl } from '../setup/test-db';

// GAP-003(handoff/admin-web.md §4;goal「GAP-003 收口」):
// GET admin/v1/meta/dashboard-summary 工作台/首页待办汇总 e2e。
//
// 角色用**真 seed**(子进程,沿 meta-resolve-labels.e2e-spec.ts 范式)——
// 需要真实 biz-admin / ops-admin 两个内置角色的实际码集,不能用 test/fixtures/rbac.fixture.ts
// 那份轻量 ops-admin-only fixture(只覆盖 PR-1~PR-4B 时代的码,不含业务面 activity-registration/
// attendance 码)。
//
// ⚠️ 重要发现(亲核 prisma/seed.ts,非本 PR 引入的行为):goal 原文权限矩阵写「SA 全见 /
// ops-admin 全见 / 仅持 registration 读码者只见该块 / 零权限空对象」。亲核 seed.ts 后:
// `activity-registration.read.record` / `attendance.read.sheet` 是**业务面**码,归属
// biz-admin(73 码集,seed.ts:3119 注释「activity-registration 5 + attendance 8」),
// **不在** ops-admin(94 码,运营/系统面:rbac.*/dict.*/org.*/attachment-config.*/
// storage-setting.*/user.*/audit-log.*/sms/wechat/realname/authz/announcement-import/
// meta.resolve.label)的绑定集合内。即 ops-admin 实际只能看到 activities 裸块,与「全见」
// 描述不符。这不是本端点的缺陷,而是既有业务面/运营面码分层的既定事实(与
// admin-web.md §2.3 「两个扁平列表 GLOBAL-only」的权限来源完全一致——那两个列表本身也
// 只认 activity-registration.read.record / attendance.read.sheet,ops-admin 一样调不通)。
// 故本文件用 **biz-admin** 承载「全见」人设(与两个扁平列表的真实权限来源一致),
// 另外**追加**一个真 ops-admin 用例验证其确实只见 activities 裸块 —— 比 goal 原文矩阵
// 覆盖更全,且不掩盖这处事实纠正(已在 PR body 登记)。
//
// 覆盖:
//   ① 裸 token 缺失 → 401
//   ② SUPER_ADMIN 三块全见(rbac.can 短路)
//   ③ biz-admin(持两码)三块全见
//   ④ ops-admin(不持两码)只见 activities 裸块 —— 证实 codeless 设计意图,非缺口
//   ⑤ 仅持 activity-registration.read.record 的自定义角色 → 只见 registrations + activities
//   ⑥ 零权限 ADMIN(无任何角色绑定)→ 只见 activities(非字面空对象,见 codeless 说明)
//   ⑦ org-readonly(副队长@SMRT)summary 与 scoped 扁平列表对账
//   ⑧ group-readonly(副组长@SMRT 子组)summary 与 scoped 扁平列表对账
//   ⑨ 有码但无组织范围返回两个零值块,不报错
//   ⑩ GLOBAL 计数对账:registrations.{pending,waitlisted} / attendanceSheets.{pending,pendingFinalReview} /
//      activities.published 与对应列表端点同条件 total 严格相等

const SEED_ENV = {
  APP_ENV: 'test',
  SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
  SUPER_ADMIN_EMAIL: '',
  RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
  SUPER_ADMIN_USERNAME: 'dashsum-seed-su',
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

const SUMMARY_PATH = '/api/admin/v1/meta/dashboard-summary';

describe('GET admin/v1/meta/dashboard-summary(GAP-003 工作台/首页待办汇总)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let superAdminAuth: string;
  let bizAdminAuth: string; // ADMIN + biz-admin(持 activity-registration.read.record + attendance.read.sheet)
  let opsAdminAuth: string; // ADMIN + ops-admin(运营面,不持业务面两码)
  let registrationOnlyAuth: string; // ADMIN + 自定义角色,仅 activity-registration.read.record
  let publishReviewerAuth: string; // USER + activity-publish-reviewer@SMRT TREE
  let firstReviewerAuth: string; // USER + attendance-first-reviewer@SMRT TREE
  let orgReadonlyAuth: string; // USER + vice-captain@SMRT → org-readonly@TREE
  let groupReadonlyAuth: string; // USER + deputy-group-leader@SMRT 子组 → group-readonly@TREE
  let emptyScopeAuth: string; // USER + biz-admin@SELF,有码但无组织范围
  let zeroPermAuth: string; // 裸 ADMIN,零角色绑定

  let organizationId: string;
  let groupOrganizationId: string;
  let outsideOrganizationId: string;
  let submitterUserId: string;

  function getSummary(auth?: string) {
    const req = request(httpServer(app)).get(SUMMARY_PATH);
    return auth ? req.set('Authorization', auth) : req;
  }

  async function expectScopedSummaryMatchesLists(
    auth: string,
    expected: {
      registrations: { pending: number; waitlisted: number };
      attendanceSheets: {
        pending: number;
        pendingFirstReview?: number;
        pendingFinalReview: number;
      };
    },
  ): Promise<void> {
    const [summary, pendingRegistrations, waitlistedRegistrations, pendingSheets, finalSheets] =
      await Promise.all([
        getSummary(auth),
        request(httpServer(app))
          .get('/api/admin/v1/registrations')
          .query({ statusCode: 'pending' })
          .set('Authorization', auth),
        request(httpServer(app))
          .get('/api/admin/v1/registrations')
          .query({ statusCode: 'waitlisted' })
          .set('Authorization', auth),
        request(httpServer(app))
          .get('/api/admin/v1/attendance-sheets')
          .query({ statusCode: 'pending' })
          .set('Authorization', auth),
        request(httpServer(app))
          .get('/api/admin/v1/attendance-sheets')
          .query({ statusCode: 'pending_final_review' })
          .set('Authorization', auth),
      ]);

    for (const res of [
      summary,
      pendingRegistrations,
      waitlistedRegistrations,
      pendingSheets,
      finalSheets,
    ]) {
      expect(res.status).toBe(200);
    }
    expect(summary.body.data.registrations).toEqual(expected.registrations);
    expect(summary.body.data.attendanceSheets).toEqual(expected.attendanceSheets);
    expect(summary.body.data.activities).toEqual({ published: 3, pendingCompletion: 1 });
    expect(pendingRegistrations.body.data.total).toBe(summary.body.data.registrations.pending);
    expect(waitlistedRegistrations.body.data.total).toBe(
      summary.body.data.registrations.waitlisted,
    );
    expect(pendingSheets.body.data.total).toBe(summary.body.data.attendanceSheets.pending);
    expect(finalSheets.body.data.total).toBe(summary.body.data.attendanceSheets.pendingFinalReview);
  }

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    runSeed();
    prisma = app.get(PrismaService);

    organizationId = (
      await prisma.organization.findFirstOrThrow({ where: { code: 'SMRT' }, select: { id: true } })
    ).id;
    outsideOrganizationId = (
      await prisma.organization.findFirstOrThrow({ where: { code: 'SWRT' }, select: { id: true } })
    ).id;
    groupOrganizationId = (
      await prisma.organization.create({
        data: { name: 'dashboard scoped 对账组', nodeTypeCode: 'group', parentId: organizationId },
        select: { id: true },
      })
    ).id;
    const organizationAncestors = await prisma.organizationClosure.findMany({
      where: { descendantId: organizationId },
      select: { ancestorId: true, depth: true },
    });
    await prisma.organizationClosure.create({
      data: { ancestorId: groupOrganizationId, descendantId: groupOrganizationId, depth: 0 },
    });
    await prisma.organizationClosure.createMany({
      data: organizationAncestors.map((ancestor) => ({
        ancestorId: ancestor.ancestorId,
        descendantId: groupOrganizationId,
        depth: ancestor.depth + 1,
      })),
    });

    const bizAdminRoleId = (
      await prisma.rbacRole.findFirstOrThrow({ where: { code: 'biz-admin' }, select: { id: true } })
    ).id;
    const opsAdminRoleId = (
      await prisma.rbacRole.findFirstOrThrow({ where: { code: 'ops-admin' }, select: { id: true } })
    ).id;
    const publishReviewerRoleId = (
      await prisma.rbacRole.findFirstOrThrow({
        where: { code: 'activity-publish-reviewer' },
        select: { id: true },
      })
    ).id;
    const firstReviewerRoleId = (
      await prisma.rbacRole.findFirstOrThrow({
        where: { code: 'attendance-first-reviewer' },
        select: { id: true },
      })
    ).id;

    const bizCaller = await createTestUser(app, { username: 'dashsum-biz', role: Role.ADMIN });
    await grantOpsAdminToUser(app, bizCaller.id, bizAdminRoleId); // helper 名沿旧,实为通用 grantRoleToUser
    bizAdminAuth = (await loginAs(app, 'dashsum-biz')).authHeader;

    const opsCaller = await createTestUser(app, { username: 'dashsum-ops', role: Role.ADMIN });
    await grantOpsAdminToUser(app, opsCaller.id, opsAdminRoleId);
    opsAdminAuth = (await loginAs(app, 'dashsum-ops')).authHeader;

    const regOnlyRole = await prisma.rbacRole.create({
      data: { code: 'dashsum-e2e-registration-only', displayName: 'e2e:仅报名读权限' },
      select: { id: true },
    });
    const regPermission = await prisma.permission.findFirstOrThrow({
      where: { code: 'activity-registration.read.record' },
      select: { id: true },
    });
    await prisma.rolePermission.create({
      data: { roleId: regOnlyRole.id, permissionId: regPermission.id },
    });
    const regOnlyCaller = await createTestUser(app, {
      username: 'dashsum-regonly',
      role: Role.ADMIN,
    });
    await grantOpsAdminToUser(app, regOnlyCaller.id, regOnlyRole.id);
    registrationOnlyAuth = (await loginAs(app, 'dashsum-regonly')).authHeader;

    const createScopedReviewer = async (username: string, roleId: string): Promise<string> => {
      const caller = await createTestUser(app, { username, role: Role.USER });
      await prisma.roleBinding.create({
        data: {
          principalType: PrincipalType.USER,
          principalId: caller.id,
          roleId,
          scopeType: BindingScopeType.ORGANIZATION_TREE,
          scopeOrgId: organizationId,
        },
      });
      return (await loginAs(app, username)).authHeader;
    };
    publishReviewerAuth = await createScopedReviewer(
      'dashsum-publish-reviewer',
      publishReviewerRoleId,
    );
    firstReviewerAuth = await createScopedReviewer('dashsum-first-reviewer', firstReviewerRoleId);

    const createPositionScopedUser = async (
      username: string,
      memberNo: string,
      positionCode: string,
      scopedOrganizationId: string,
    ): Promise<string> => {
      const caller = await createTestUser(app, { username, role: Role.USER });
      const member = await prisma.member.create({
        data: { memberNo, displayName: `dashboard ${positionCode}` },
        select: { id: true },
      });
      await prisma.user.update({ where: { id: caller.id }, data: { memberId: member.id } });
      const position = await prisma.organizationPosition.findFirstOrThrow({
        where: { code: positionCode, deletedAt: null },
        select: { id: true },
      });
      await prisma.organizationPositionAssignment.create({
        data: {
          organizationId: scopedOrganizationId,
          positionId: position.id,
          memberId: member.id,
          status: AssignmentStatus.ACTIVE,
          startedAt: new Date('2020-01-01T00:00:00.000Z'),
        },
      });
      return (await loginAs(app, username)).authHeader;
    };
    orgReadonlyAuth = await createPositionScopedUser(
      'dashsum-org-readonly',
      'dashsum-m-org-ro',
      'vice-captain',
      organizationId,
    );
    groupReadonlyAuth = await createPositionScopedUser(
      'dashsum-group-readonly',
      'dashsum-m-group-ro',
      'deputy-group-leader',
      groupOrganizationId,
    );

    const emptyScopeCaller = await createTestUser(app, {
      username: 'dashsum-empty-scope',
      role: Role.USER,
    });
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: emptyScopeCaller.id,
        roleId: bizAdminRoleId,
        scopeType: BindingScopeType.SELF,
      },
    });
    emptyScopeAuth = (await loginAs(app, 'dashsum-empty-scope')).authHeader;

    await createTestUser(app, { username: 'dashsum-zero', role: Role.ADMIN });
    zeroPermAuth = (await loginAs(app, 'dashsum-zero')).authHeader;

    superAdminAuth = (await loginAs(app, SEED_ENV.SUPER_ADMIN_USERNAME)).authHeader;

    submitterUserId = (
      await prisma.user.findFirstOrThrow({
        where: { username: 'dashsum-zero' },
        select: { id: true },
      })
    ).id;

    // ---- 计数对账用固定数据(reset-db 已清空 Activity/ActivityRegistration/AttendanceSheet,
    //      本文件独占计数,可精确断言绝对值)----
    const mkActivity = (
      title: string,
      statusCode: string,
      activityOrganizationId: string = organizationId,
    ) =>
      prisma.activity.create({
        data: {
          title,
          activityTypeCode: 'dashsum-e2e-type',
          organizationId: activityOrganizationId,
          startAt: new Date('2027-02-01T08:00:00.000Z'),
          endAt: new Date('2027-02-01T12:00:00.000Z'),
          location: 'e2e 测试地点',
          statusCode,
        },
        select: { id: true },
      });

    const actPublished1 = await mkActivity('dashsum活动·已发布1', 'published');
    const actPublished2 = await mkActivity('dashsum活动·已发布2', 'published', groupOrganizationId);
    const actDraft = await mkActivity('dashsum活动·草稿', 'draft', groupOrganizationId);
    const actOutside = await mkActivity('dashsum活动·范围外', 'published', outsideOrganizationId);
    await prisma.activity.update({
      where: { id: actPublished1.id },
      data: {
        startAt: new Date('2020-02-01T08:00:00.000Z'),
        endAt: new Date('2020-02-01T12:00:00.000Z'),
      },
    });
    // activities 块不按 scope 裁剪：published = 3；仅 actPublished1 已过 endAt。

    const mkMember = (memberNo: string) =>
      prisma.member.create({ data: { memberNo, displayName: `dashsum队员${memberNo}` } });

    const regMembers = await Promise.all(
      [
        'dashsum-r1',
        'dashsum-r2',
        'dashsum-r3',
        'dashsum-r4',
        'dashsum-r5',
        'dashsum-r6',
        'dashsum-r7',
        'dashsum-r8',
      ].map(mkMember),
    );
    const mkRegistration = (activityId: string, memberId: string, statusCode: string) =>
      prisma.activityRegistration.create({ data: { activityId, memberId, statusCode } });

    await mkRegistration(actPublished1.id, regMembers[0].id, 'pending');
    await mkRegistration(actPublished1.id, regMembers[1].id, 'pending');
    await mkRegistration(actPublished2.id, regMembers[2].id, 'pending');
    await mkRegistration(actPublished1.id, regMembers[3].id, 'pass');
    await mkRegistration(actPublished2.id, regMembers[4].id, 'cancelled');
    await mkRegistration(actPublished2.id, regMembers[5].id, 'waitlisted');
    await mkRegistration(actOutside.id, regMembers[6].id, 'pending');
    await mkRegistration(actOutside.id, regMembers[7].id, 'waitlisted');
    // GLOBAL pending=4/waitlisted=2；org-readonly pending=3/waitlisted=1；group-readonly 各 1。

    const mkSheet = (activityId: string, statusCode: string) =>
      prisma.attendanceSheet.create({ data: { activityId, submitterUserId, statusCode } });

    await mkSheet(actPublished1.id, 'pending');
    await mkSheet(actPublished2.id, 'pending');
    await mkSheet(actDraft.id, 'pending_final_review');
    await mkSheet(actPublished1.id, 'approved');
    await mkSheet(actPublished2.id, 'rejected');
    await mkSheet(actOutside.id, 'pending');
    // GLOBAL pending=3/final=1；org-readonly pending=2/final=1；group-readonly 各 1。

    await prisma.activityPublishReview.createMany({
      data: [
        {
          activityId: actPublished1.id,
          requestType: 'change',
          requestVersion: 1,
          baseRevision: 0,
          status: 'pending',
          snapshot: {},
          submittedByUserId: submitterUserId,
        },
        {
          activityId: actOutside.id,
          requestType: 'change',
          requestVersion: 1,
          baseRevision: 0,
          status: 'pending',
          snapshot: {},
          submittedByUserId: submitterUserId,
        },
        {
          activityId: actPublished2.id,
          requestType: 'change',
          requestVersion: 1,
          baseRevision: 0,
          status: 'approved',
          snapshot: {},
          submittedByUserId: submitterUserId,
        },
      ],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('① 无 Authorization → 401', async () => {
    const res = await getSummary();
    expect(res.status).toBe(401);
  });

  it('② SUPER_ADMIN(rbac.can 短路)三块全见', async () => {
    const res = await getSummary(superAdminAuth);
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    const data = res.body.data;
    expect(data.registrations).toEqual({ pending: 4, waitlisted: 2 });
    expect(data.attendanceSheets).toEqual({
      pending: 3,
      pendingFirstReview: 3,
      pendingFinalReview: 1,
    });
    expect(data.activityPublishReviews).toEqual({ pending: 2 });
    expect(data.activities).toEqual({ published: 3, pendingCompletion: 1 });
  });

  it('③ biz-admin(持 activity-registration.read.record + attendance.read.sheet)三块全见', async () => {
    const res = await getSummary(bizAdminAuth);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.registrations).toEqual({ pending: 4, waitlisted: 2 });
    expect(data.attendanceSheets).toEqual({
      pending: 3,
      pendingFirstReview: 3,
      pendingFinalReview: 1,
    });
    expect(data).not.toHaveProperty('activityPublishReviews');
    expect(data.activities).toEqual({ published: 3, pendingCompletion: 1 });
  });

  it('④ ops-admin(运营面,不持业务面两码)只见 activities 裸块——codeless 设计意图,非缺陷', async () => {
    const res = await getSummary(opsAdminAuth);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data).not.toHaveProperty('registrations');
    expect(data).not.toHaveProperty('attendanceSheets');
    expect(data.activities).toEqual({ published: 3, pendingCompletion: 1 });
  });

  it('⑤ 仅持 activity-registration.read.record 的自定义角色 → 只见 registrations + activities', async () => {
    const res = await getSummary(registrationOnlyAuth);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.registrations).toEqual({ pending: 4, waitlisted: 2 });
    expect(data).not.toHaveProperty('attendanceSheets');
    expect(data.activities).toEqual({ published: 3, pendingCompletion: 1 });
  });

  it('⑥ 零权限 ADMIN(无任何角色绑定)→ 只见 activities(codeless 块恒在,非字面空对象)', async () => {
    const res = await getSummary(zeroPermAuth);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data).not.toHaveProperty('registrations');
    expect(data).not.toHaveProperty('attendanceSheets');
    expect(data.activities).toEqual({ published: 3, pendingCompletion: 1 });
  });

  it('⑦ scoped 发布审核员只见范围内发布待办，无码块静默省略', async () => {
    const res = await getSummary(publishReviewerAuth);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      activityPublishReviews: { pending: 1 },
      activities: { published: 3, pendingCompletion: 1 },
    });
  });

  it('⑧ scoped 一审员得到独立的一审待办数，且仍保留兼容读计数', async () => {
    const res = await getSummary(firstReviewerAuth);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      attendanceSheets: {
        pending: 2,
        pendingFirstReview: 2,
        pendingFinalReview: 1,
      },
      activities: { published: 3, pendingCompletion: 1 },
    });
  });

  it('⑨ org-readonly(副队长@SMRT)的 summary 与其 scoped 报名/考勤列表一致', async () => {
    await expectScopedSummaryMatchesLists(orgReadonlyAuth, {
      registrations: { pending: 3, waitlisted: 1 },
      attendanceSheets: { pending: 2, pendingFinalReview: 1 },
    });
  });

  it('⑩ group-readonly(副组长@子组)的 summary 与其 scoped 报名/考勤列表一致', async () => {
    await expectScopedSummaryMatchesLists(groupReadonlyAuth, {
      registrations: { pending: 1, waitlisted: 1 },
      attendanceSheets: { pending: 1, pendingFinalReview: 1 },
    });
  });

  it('⑪ 有码但无组织范围时保留两个零值块，且与 scoped 空列表一致', async () => {
    await expectScopedSummaryMatchesLists(emptyScopeAuth, {
      registrations: { pending: 0, waitlisted: 0 },
      attendanceSheets: { pending: 0, pendingFirstReview: 0, pendingFinalReview: 0 },
    });
  });

  it('⑫ GLOBAL 计数与对应列表端点同条件 total 严格相等', async () => {
    const summaryRes = await getSummary(superAdminAuth);
    expect(summaryRes.status).toBe(200);
    const data = summaryRes.body.data;

    const regRes = await request(httpServer(app))
      .get('/api/admin/v1/registrations')
      .query({ statusCode: 'pending' })
      .set('Authorization', superAdminAuth);
    expect(regRes.status).toBe(200);
    expect(regRes.body.data.total).toBe(data.registrations.pending);
    expect(regRes.body.data.total).toBe(4);

    const waitlistedRes = await request(httpServer(app))
      .get('/api/admin/v1/registrations')
      .query({ statusCode: 'waitlisted' })
      .set('Authorization', superAdminAuth);
    expect(waitlistedRes.status).toBe(200);
    expect(waitlistedRes.body.data.total).toBe(data.registrations.waitlisted);
    expect(waitlistedRes.body.data.total).toBe(2);

    const sheetPendingRes = await request(httpServer(app))
      .get('/api/admin/v1/attendance-sheets')
      .query({ statusCode: 'pending' })
      .set('Authorization', superAdminAuth);
    expect(sheetPendingRes.status).toBe(200);
    expect(sheetPendingRes.body.data.total).toBe(data.attendanceSheets.pending);
    expect(sheetPendingRes.body.data.total).toBe(3);

    const sheetFinalRes = await request(httpServer(app))
      .get('/api/admin/v1/attendance-sheets')
      .query({ statusCode: 'pending_final_review' })
      .set('Authorization', superAdminAuth);
    expect(sheetFinalRes.status).toBe(200);
    expect(sheetFinalRes.body.data.total).toBe(data.attendanceSheets.pendingFinalReview);
    expect(sheetFinalRes.body.data.total).toBe(1);

    const activitiesRes = await request(httpServer(app))
      .get('/api/admin/v1/activities')
      .query({ statusCode: 'published' })
      .set('Authorization', superAdminAuth);
    expect(activitiesRes.status).toBe(200);
    expect(activitiesRes.body.data.total).toBe(data.activities.published);
    expect(activitiesRes.body.data.total).toBe(3);
  });
});
