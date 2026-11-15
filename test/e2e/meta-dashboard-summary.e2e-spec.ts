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
import { memberIdentityData } from '../helpers/member-identity.fixture';

// 使用真实 seed 验证内置角色、职务动态只读投影和 TREE 绑定。
// 报名计数按 scope；新版结算待办要求 GLOBAL 读码及对应 GLOBAL 审核码。
// 无权省略与关闸不可用分开；旧 Sheet、历史版本和 run 待办数不得混用。

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
  const previousWorkflowGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  let app: INestApplication;
  let prisma: PrismaService;

  let superAdminAuth: string;
  let bizAdminAuth: string; // ADMIN + biz-admin(持 activity-registration.read.record + attendance.read.sheet)
  let opsAdminAuth: string; // ADMIN + ops-admin(运营面,不持业务面两码)
  let registrationOnlyAuth: string; // ADMIN + 自定义角色,仅 activity-registration.read.record
  let publishReviewerAuth: string; // USER + activity-publish-reviewer@SMRT TREE
  let firstReviewerAuth: string; // USER + attendance-first-reviewer@SMRT TREE
  let globalFirstReviewerAuth: string;
  let orgReadonlyAuth: string; // USER + vice-captain@SMRT → org-readonly@TREE
  let groupReadonlyAuth: string; // USER + deputy-group-leader@SMRT 子组 → group-readonly@TREE
  let emptyScopeAuth: string; // USER + biz-admin@SELF,有码但无组织范围
  let zeroPermAuth: string; // 裸 ADMIN,零角色绑定

  let organizationId: string;
  let groupOrganizationId: string;
  let outsideOrganizationId: string;
  let submitterUserId: string;
  let orgSettlementActivityIds: string[];
  let groupSettlementActivityIds: string[];

  function getSummary(auth?: string) {
    const req = request(httpServer(app)).get(SUMMARY_PATH);
    return auth ? req.set('Authorization', auth) : req;
  }

  async function expectScopedSummaryMatchesLists(
    auth: string,
    expected: {
      registrations: { pending: number; waitlisted: number };
      settlementActivityIds: string[];
      settlementVersionCount: number;
    },
  ): Promise<void> {
    const [summary, pendingRegistrations, waitlistedRegistrations, settlements] = await Promise.all(
      [
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
          .get('/api/admin/v1/attendance-settlements')
          .set('Authorization', auth),
      ],
    );

    for (const res of [summary, pendingRegistrations, waitlistedRegistrations]) {
      expect(res.status).toBe(200);
    }
    expect(summary.body.data.registrations).toEqual(expected.registrations);
    expect(summary.body.data).not.toHaveProperty('attendanceSheets');
    expect(summary.body.data).not.toHaveProperty('settlementReviews');
    // 待办块的 GLOBAL 门槛与版本列表的组织可见范围是两个不同合同。
    expect(settlements.status).toBe(200);
    expect(settlements.body.data.total).toBe(expected.settlementVersionCount);
    expect(settlements.body.data.items).toHaveLength(expected.settlementVersionCount);
    const items = settlements.body.data.items as Array<{ activityId: string }>;
    expect([...new Set(items.map((item) => item.activityId))].sort()).toEqual(
      [...expected.settlementActivityIds].sort(),
    );
    expect(summary.body.data.activities).toEqual({ published: 3, pendingCompletion: 1 });
    expect(pendingRegistrations.body.data.total).toBe(summary.body.data.registrations.pending);
    expect(waitlistedRegistrations.body.data.total).toBe(
      summary.body.data.registrations.waitlisted,
    );
  }

  beforeAll(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
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
    const globalFirstReviewer = await createTestUser(app, {
      username: 'dashsum-global-first-reviewer',
      role: Role.ADMIN,
    });
    await grantOpsAdminToUser(app, globalFirstReviewer.id, firstReviewerRoleId);
    globalFirstReviewerAuth = (await loginAs(app, 'dashsum-global-first-reviewer')).authHeader;

    const createPositionScopedUser = async (
      username: string,
      memberNo: string,
      positionCode: string,
      scopedOrganizationId: string,
    ): Promise<string> => {
      const caller = await createTestUser(app, { username, role: Role.USER });
      const member = await prisma.member.create({
        data: { memberNo, ...memberIdentityData(`dashboard ${positionCode}`) },
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
          startAt: new Date('2099-02-01T08:00:00.000Z'),
          endAt: new Date('2099-02-01T12:00:00.000Z'),
          location: 'e2e 测试地点',
          statusCode,
        },
        select: { id: true },
      });

    const actPublished1 = await mkActivity('dashsum活动·已发布1', 'published');
    const actPublished2 = await mkActivity('dashsum活动·已发布2', 'published', groupOrganizationId);
    const actDraft = await mkActivity('dashsum活动·草稿', 'draft', groupOrganizationId);
    const actOutside = await mkActivity('dashsum活动·范围外', 'published', outsideOrganizationId);
    orgSettlementActivityIds = [actPublished1.id, actPublished2.id, actDraft.id];
    groupSettlementActivityIds = [actPublished2.id, actDraft.id];
    await prisma.activity.update({
      where: { id: actPublished1.id },
      data: {
        startAt: new Date('2020-02-01T08:00:00.000Z'),
        endAt: new Date('2020-02-01T12:00:00.000Z'),
      },
    });
    // activities 块不按 scope 裁剪：published = 3；仅 actPublished1 已过 endAt。

    const mkMember = (memberNo: string) =>
      prisma.member.create({ data: { memberNo, ...memberIdentityData(`dashsum队员${memberNo}`) } });

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

    // 新待办按 run 状态计数，故意与旧 Sheet 不同；历史版本也不能重复算待办。
    const mkSettlement = async (activityId: string, statusCode: string) => {
      const seal = await prisma.evidenceSeal.create({
        data: {
          activityId,
          sealRevision: 1,
          evidenceRevision: 0,
          populationRevision: 0,
          workflowRevision: 0,
          allWindowsClosedAt: new Date(),
          openSegmentCount: 0,
          manualReviewPendingCount: 0,
          populationCountDistinct: 0,
          populationCountBySession: {},
          contentHash: `dashboard-seal-${activityId}`,
          statusCode: 'active',
          sealedByUserId: submitterUserId,
          sealedAt: new Date(),
        },
      });
      const run = await prisma.attendanceSettlementRun.create({
        data: {
          activityId,
          statusCode,
          currentSubmittedVersion: statusCode === 'drafting' ? 1 : 2,
        },
      });
      for (const version of [1, 2]) {
        const draft = version === 2 && statusCode === 'drafting';
        await prisma.attendanceSettlementVersion.create({
          data: {
            settlementRunId: run.id,
            version,
            evidenceSealId: seal.id,
            evidenceRevision: 0,
            populationRevision: 0,
            workflowRevision: 0,
            contentHash: `dashboard-version-${activityId}-${version}`,
            personCount: 0,
            sessionParticipationCount: 0,
            serviceSegmentCount: 0,
            createdByUserId: submitterUserId,
            submittedAt: draft ? null : new Date(),
            statusCode: draft ? 'draft' : version === 1 ? 'returned' : 'submitted',
            operationKey: `dashboard-version-${activityId}-${version}`,
          },
        });
      }
    };
    await mkSettlement(actPublished1.id, 'pending_first_review');
    await mkSettlement(actPublished2.id, 'pending_final_review');
    await mkSettlement(actDraft.id, 'drafting');
    await mkSettlement(actOutside.id, 'pending_first_review');

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
    try {
      await app.close();
    } finally {
      if (previousWorkflowGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
      else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousWorkflowGate;
    }
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
    expect(data).not.toHaveProperty('attendanceSheets');
    expect(data.settlementReviews).toEqual({
      available: true,
      pendingFirstReview: 2,
      pendingFinalReview: 1,
    });
    expect(data.activityPublishReviews).toEqual({ pending: 2 });
    expect(data.activities).toEqual({ published: 3, pendingCompletion: 1 });
  });

  it('③ biz-admin 有业务读码但无新审核码，不获得结算待办', async () => {
    const res = await getSummary(bizAdminAuth);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.registrations).toEqual({ pending: 4, waitlisted: 2 });
    expect(data).not.toHaveProperty('attendanceSheets');
    expect(data).not.toHaveProperty('settlementReviews');
    expect(data).not.toHaveProperty('activityPublishReviews');
    expect(data.activities).toEqual({ published: 3, pendingCompletion: 1 });
  });

  it('④ ops-admin(运营面,不持业务面两码)只见 activities 裸块——codeless 设计意图,非缺陷', async () => {
    const res = await getSummary(opsAdminAuth);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data).not.toHaveProperty('registrations');
    expect(data).not.toHaveProperty('attendanceSheets');
    expect(data).not.toHaveProperty('settlementReviews');
    expect(data.activities).toEqual({ published: 3, pendingCompletion: 1 });
  });

  it('⑤ 仅持 activity-registration.read.record 的自定义角色 → 只见 registrations + activities', async () => {
    const res = await getSummary(registrationOnlyAuth);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.registrations).toEqual({ pending: 4, waitlisted: 2 });
    expect(data).not.toHaveProperty('attendanceSheets');
    expect(data).not.toHaveProperty('settlementReviews');
    expect(data.activities).toEqual({ published: 3, pendingCompletion: 1 });
  });

  it('⑥ 零权限 ADMIN(无任何角色绑定)→ 只见 activities(codeless 块恒在,非字面空对象)', async () => {
    const res = await getSummary(zeroPermAuth);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data).not.toHaveProperty('registrations');
    expect(data).not.toHaveProperty('attendanceSheets');
    expect(data).not.toHaveProperty('settlementReviews');
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

  it('⑧ 旧 TREE 一审绑定不满足新版审核台 GLOBAL 前置，不泄露结算待办', async () => {
    const res = await getSummary(firstReviewerAuth);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      activities: { published: 3, pendingCompletion: 1 },
    });
    const list = await request(httpServer(app))
      .get('/api/admin/v1/attendance-settlements')
      .set('Authorization', firstReviewerAuth);
    expect(list.status).toBe(200);
    expect(list.body.data.total).toBe(5);
    const items = list.body.data.items as Array<{ activityId: string }>;
    expect([...new Set(items.map((item) => item.activityId))].sort()).toEqual(
      [...orgSettlementActivityIds].sort(),
    );
  });

  it('⑨ org-readonly 保留 TREE 报名/结算版本范围，不获得审核待办块', async () => {
    await expectScopedSummaryMatchesLists(orgReadonlyAuth, {
      registrations: { pending: 3, waitlisted: 1 },
      settlementActivityIds: orgSettlementActivityIds,
      settlementVersionCount: 5,
    });
  });

  it('⑩ group-readonly 保留子组报名/结算版本范围，不获得审核待办块', async () => {
    await expectScopedSummaryMatchesLists(groupReadonlyAuth, {
      registrations: { pending: 1, waitlisted: 1 },
      settlementActivityIds: groupSettlementActivityIds,
      settlementVersionCount: 3,
    });
  });

  it('⑪ 无有效组织范围时报名零值与空列表一致，结算无权块省略', async () => {
    await expectScopedSummaryMatchesLists(emptyScopeAuth, {
      registrations: { pending: 0, waitlisted: 0 },
      settlementActivityIds: [],
      settlementVersionCount: 0,
    });
  });

  it('⑫ GLOBAL 报名/活动计数与列表相等，结算历史版本数不伪装成待办数', async () => {
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

    const settlementList = await request(httpServer(app))
      .get('/api/admin/v1/attendance-settlements')
      .query({ pageSize: 100 })
      .set('Authorization', superAdminAuth);
    expect(settlementList.status).toBe(200);
    expect(settlementList.body.data.total).toBe(7);
    expect(settlementList.body.data.items).toHaveLength(7);
    expect(data.settlementReviews).toEqual({
      available: true,
      pendingFirstReview: 2,
      pendingFinalReview: 1,
    });

    const activitiesRes = await request(httpServer(app))
      .get('/api/admin/v1/activities')
      .query({ statusCode: 'published' })
      .set('Authorization', superAdminAuth);
    expect(activitiesRes.status).toBe(200);
    expect(activitiesRes.body.data.total).toBe(data.activities.published);
    expect(activitiesRes.body.data.total).toBe(3);
  });

  it('GLOBAL 仅一审授权只返回一审字段，不透出终审待办', async () => {
    const res = await getSummary(globalFirstReviewerAuth);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      settlementReviews: { available: true, pendingFirstReview: 2 },
      activities: { published: 3, pendingCompletion: 1 },
    });
  });

  it('关闸时有权结算块明确不可用，其余计数保持正常', async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'false';
    let closedApp: INestApplication | undefined;
    try {
      closedApp = await createTestApp();
      const res = await request(httpServer(closedApp))
        .get(SUMMARY_PATH)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        registrations: { pending: 4, waitlisted: 2 },
        activityPublishReviews: { pending: 2 },
        settlementReviews: { available: false },
        activities: { published: 3, pendingCompletion: 1 },
      });
    } finally {
      await closedApp?.close();
      process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    }
  });
});
