import type { INestApplication } from '@nestjs/common';
import { AssignmentStatus, Role, SupervisionScopeMode, SupervisionStatus } from '@prisma/client';
import { execSync } from 'child_process';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser } from '../fixtures/biz-admin.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertTestDatabaseUrl } from '../setup/test-db';

// 终态 scoped-authz PR12(2026-07-02;冻结稿 §11 PR12+ 逐面迁移第一批;goal「PR12 —
// 逐面迁移第一批(participation)」):activities / activity-registrations / attendances
// 三模块 HTTP 面 scoped 生效矩阵 + NOT_FOUND 回退矩阵。角色 / 职务 / policy / 组织树(含 closure)
// 用**真 seed**(子进程,沿 authz-three-source / attendances-final-review-authz 范式)—— scoped
// 通路用的是真 seed 的 org-admin(team-leader policy)/ group-manager(group-leader policy)/
// org-supervisor(分管推导),与生产逐字一致。
//
// **本文件只覆盖本刀新增的 scoped 生效面 + NOT_FOUND 回退**(goal DoD 3/4)。既有 GLOBAL 行为锁
// 由既有 e2e(activities*/activity-registrations*/attendances* 22 个 spec)逐字不改验证,见
// PR12 报告;本文件零涉及既有 spec 修改。
//
// 覆盖:
//   ①team-leader@SMRT(经 policy→org-admin@TREE):本队活动 update/publish/cancel ALLOW,
//     他队(SWRT)DENY 30100;本队活动嵌套 registrations 列表+approve ALLOW,他队 DENY;
//     为本队活动 create attendance-sheet + 一级 approve ALLOW,他队 create DENY
//   ②group-leader@SMRT-子组(经 policy→group-manager@TREE):本组 sheet 一级 approve ALLOW;
//     activity.update DENY(角色无码,no_permission)
//   ③org-supervisor(SupervisionAssignment@SMRT,TREE):分管树内单 sheet read ALLOW
//     (BD-3 候选码②③关闭依据的活证),树外 DENY out_of_supervised_scope→30100
//   ④纯 scoped 者(team-leader,无 GLOBAL)访问扁平跨轴列表 → 30100(决断④设计内状态)
//   ⑤NOT_FOUND 回退(沿 PR9 范式,三模块各一例):GLOBAL 持码者(biz-admin)→ 既有模块 NOT_FOUND
//     BizCode;无码者(bare USER)→ 30100 防枚举

const SEED_ENV = {
  APP_ENV: 'test',
  SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
  SUPER_ADMIN_EMAIL: '',
  RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
  SUPER_ADMIN_USERNAME: 'pr12-psa-su',
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

describe('participation 三模块 scoped-authz HTTP 面(PR12:逐面迁移第一批)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  // 组织
  let smrtId: string;
  let swrtId: string;
  let groupId: string; // SMRT 下新建 group 节点(group-leader 测试专用)

  // HTTP 身份
  let teamLeaderAuth: string;
  let groupLeaderAuth: string;
  let supervisorAuth: string;
  let bizAdminAuth: string;
  let bareUserAuth: string;

  // 目标资源
  let smrtActivityId: string; // update/publish/cancel ALLOW 链(draft)
  let swrtActivityId: string; // update/publish/cancel DENY(draft)
  let smrtActivity2Id: string; // registrations + attendance create 载体(published,SMRT)
  let swrtActivity2Id: string; // registrations + attendance create 载体(published,SWRT;他队)
  let groupActivityId: string; // group-leader sheet 载体
  let smrtRegId: string; // pending registration @ smrtActivity2
  let swrtRegId: string; // pending registration @ swrtActivity2
  let smrtSheetId: string; // 直造 sheet @ smrtActivity2(supervisor 树内读)
  let swrtSheetId: string; // 直造 sheet @ swrtActivity2(supervisor 树外读)
  let groupSheetId: string; // 直造 sheet @ groupActivity(group-leader approve)
  let regTargetMemberId: string;
  let attTargetMemberId: string;
  let groupTargetMemberId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    runSeed();

    prisma = app.get(PrismaService);

    const orgByCode = async (code: string): Promise<string> =>
      (await prisma.organization.findFirstOrThrow({ where: { code }, select: { id: true } })).id;
    smrtId = await orgByCode('SMRT');
    swrtId = await orgByCode('SWRT');

    // ===== 新建 group 节点(SMRT 下)+ closure(自环 + 祖先链,沿 authz-three-source 范式) =====
    const grp = await prisma.organization.create({
      data: { name: 'PR12 测试组', nodeTypeCode: 'group', parentId: smrtId },
      select: { id: true },
    });
    groupId = grp.id;
    const smrtAncestors = await prisma.organizationClosure.findMany({
      where: { descendantId: smrtId },
      select: { ancestorId: true, depth: true },
    });
    await prisma.organizationClosure.create({
      data: { ancestorId: groupId, descendantId: groupId, depth: 0 },
    });
    await prisma.organizationClosure.createMany({
      data: smrtAncestors.map((a) => ({
        ancestorId: a.ancestorId,
        descendantId: groupId,
        depth: a.depth + 1,
      })),
    });

    // ===== HTTP 身份 =====
    const teamLeaderUser = await createTestUser(app, {
      username: 'psa-team-leader',
      role: Role.USER,
    });
    const teamLeaderMember = await prisma.member.create({
      data: { memberNo: 'psa-m-tl', displayName: 'PSA 队长' },
      select: { id: true },
    });
    await prisma.user.update({
      where: { id: teamLeaderUser.id },
      data: { memberId: teamLeaderMember.id },
    });
    teamLeaderAuth = (await loginAs(app, 'psa-team-leader')).authHeader;

    const groupLeaderUser = await createTestUser(app, {
      username: 'psa-group-leader',
      role: Role.USER,
    });
    const groupLeaderMember = await prisma.member.create({
      data: { memberNo: 'psa-m-gl', displayName: 'PSA 组长' },
      select: { id: true },
    });
    await prisma.user.update({
      where: { id: groupLeaderUser.id },
      data: { memberId: groupLeaderMember.id },
    });
    groupLeaderAuth = (await loginAs(app, 'psa-group-leader')).authHeader;

    const supervisorUser = await createTestUser(app, {
      username: 'psa-supervisor',
      role: Role.USER,
    });
    const supervisorMember = await prisma.member.create({
      data: { memberNo: 'psa-m-sup', displayName: 'PSA 分管副队长' },
      select: { id: true },
    });
    await prisma.user.update({
      where: { id: supervisorUser.id },
      data: { memberId: supervisorMember.id },
    });
    supervisorAuth = (await loginAs(app, 'psa-supervisor')).authHeader;

    const bizAdminUser = await createTestUser(app, { username: 'psa-biz-admin', role: Role.ADMIN });
    const bizAdminRoleId = (
      await prisma.rbacRole.findFirstOrThrow({
        where: { code: 'biz-admin', deletedAt: null },
        select: { id: true },
      })
    ).id;
    await grantBizAdminToUser(app, bizAdminUser.id, bizAdminRoleId);
    bizAdminAuth = (await loginAs(app, 'psa-biz-admin')).authHeader;

    await createTestUser(app, { username: 'psa-bare-user', role: Role.USER });
    bareUserAuth = (await loginAs(app, 'psa-bare-user')).authHeader;

    // ===== 职务任命(真 seed 职务定义 + policy)=====
    const positionByCode = async (code: string): Promise<string> =>
      (
        await prisma.organizationPosition.findFirstOrThrow({
          where: { code, deletedAt: null },
          select: { id: true },
        })
      ).id;
    const teamLeaderPositionId = await positionByCode('team-leader');
    const groupLeaderPositionId = await positionByCode('group-leader');

    await prisma.organizationPositionAssignment.create({
      data: {
        memberId: teamLeaderMember.id,
        organizationId: smrtId,
        positionId: teamLeaderPositionId,
        status: AssignmentStatus.ACTIVE,
        startedAt: PAST_START,
      },
    });
    await prisma.organizationPositionAssignment.create({
      data: {
        memberId: groupLeaderMember.id,
        organizationId: groupId,
        positionId: groupLeaderPositionId,
        status: AssignmentStatus.ACTIVE,
        startedAt: PAST_START,
      },
    });
    await prisma.organizationSupervisionAssignment.create({
      data: {
        supervisorMemberId: supervisorMember.id,
        organizationId: smrtId,
        scopeMode: SupervisionScopeMode.TREE,
        status: SupervisionStatus.ACTIVE,
        startedAt: PAST_START,
      },
    });

    // ===== 目标资源 =====
    const mkActivity = (organizationId: string, statusCode: string) =>
      prisma.activity.create({
        data: {
          title: `PR12 活动 @${organizationId}`,
          activityTypeCode: 'pr12-demo',
          organizationId,
          startAt: new Date('2026-06-01T01:00:00.000Z'),
          endAt: new Date('2026-06-01T05:00:00.000Z'),
          location: '训练场',
          statusCode,
          isPublicRegistration: true,
        },
        select: { id: true },
      });
    smrtActivityId = (await mkActivity(smrtId, 'draft')).id;
    swrtActivityId = (await mkActivity(swrtId, 'draft')).id;
    smrtActivity2Id = (await mkActivity(smrtId, 'published')).id;
    swrtActivity2Id = (await mkActivity(swrtId, 'published')).id;
    groupActivityId = (await mkActivity(groupId, 'published')).id;

    const mkTargetMember = async (tag: string): Promise<string> =>
      (
        await prisma.member.create({
          data: { memberNo: `psa-t-${tag}`, displayName: `PSA 目标 ${tag}` },
          select: { id: true },
        })
      ).id;
    regTargetMemberId = await mkTargetMember('reg');
    attTargetMemberId = await mkTargetMember('att');
    groupTargetMemberId = await mkTargetMember('grp');

    smrtRegId = (
      await prisma.activityRegistration.create({
        data: { activityId: smrtActivity2Id, memberId: regTargetMemberId, statusCode: 'pending' },
        select: { id: true },
      })
    ).id;
    swrtRegId = (
      await prisma.activityRegistration.create({
        data: {
          activityId: swrtActivity2Id,
          memberId: regTargetMemberId,
          statusCode: 'pending',
        },
        select: { id: true },
      })
    ).id;

    smrtSheetId = (
      await prisma.attendanceSheet.create({
        data: {
          activityId: smrtActivity2Id,
          submitterUserId: bizAdminUser.id,
          statusCode: 'pending',
        },
        select: { id: true },
      })
    ).id;
    swrtSheetId = (
      await prisma.attendanceSheet.create({
        data: {
          activityId: swrtActivity2Id,
          submitterUserId: bizAdminUser.id,
          statusCode: 'pending',
        },
        select: { id: true },
      })
    ).id;
    groupSheetId = (
      await prisma.attendanceSheet.create({
        data: {
          activityId: groupActivityId,
          submitterUserId: bizAdminUser.id,
          statusCode: 'pending',
          records: {
            create: [
              {
                memberId: groupTargetMemberId,
                roleCode: 'member',
                checkInAt: new Date('2026-06-01T01:00:00.000Z'),
                checkOutAt: new Date('2026-06-01T05:00:00.000Z'),
                serviceHours: 4,
                attendanceStatusCode: 'present',
                contributionPoints: 1,
              },
            ],
          },
        },
        select: { id: true },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  // ============ ①team-leader:activity update/publish/cancel(本队 ALLOW / 他队 DENY) ============

  describe('①team-leader@SMRT → org-admin@TREE(SMRT)', () => {
    it('本队(SMRT)活动:update → publish → cancel 全链 ALLOW', async () => {
      const upd = await request(httpServer(app))
        .patch(`/api/admin/v1/activities/${smrtActivityId}`)
        .set('Authorization', teamLeaderAuth)
        .send({ title: 'team-leader 改的标题' });
      expect(upd.status).toBe(200);
      expect(upd.body.data.title).toBe('team-leader 改的标题');

      const pub = await request(httpServer(app))
        .patch(`/api/admin/v1/activities/${smrtActivityId}/publish`)
        .set('Authorization', teamLeaderAuth)
        .send({});
      expect(pub.status).toBe(200);
      expect(pub.body.data.statusCode).toBe('published');

      const can = await request(httpServer(app))
        .patch(`/api/admin/v1/activities/${smrtActivityId}/cancel`)
        .set('Authorization', teamLeaderAuth)
        .send({ cancelReason: 'PR12 scoped 测试' });
      expect(can.status).toBe(200);
      expect(can.body.data.statusCode).toBe('cancelled');
    });

    it('他队(SWRT)活动:update / publish / cancel 全 DENY 30100(树外,活动状态零变化)', async () => {
      expectBizError(
        await request(httpServer(app))
          .patch(`/api/admin/v1/activities/${swrtActivityId}`)
          .set('Authorization', teamLeaderAuth)
          .send({ title: 'x' }),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .patch(`/api/admin/v1/activities/${swrtActivityId}/publish`)
          .set('Authorization', teamLeaderAuth)
          .send({}),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .patch(`/api/admin/v1/activities/${swrtActivityId}/cancel`)
          .set('Authorization', teamLeaderAuth)
          .send({}),
        BizCode.RBAC_FORBIDDEN,
      );
      const stillDraft = await prisma.activity.findUniqueOrThrow({
        where: { id: swrtActivityId },
        select: { statusCode: true },
      });
      expect(stillDraft.statusCode).toBe('draft');
    });

    it('本队活动嵌套 registrations 列表 + approve ALLOW,他队 DENY 30100', async () => {
      const listOwn = await request(httpServer(app))
        .get(`/api/admin/v1/activities/${smrtActivity2Id}/registrations`)
        .set('Authorization', teamLeaderAuth);
      expect(listOwn.status).toBe(200);
      expect(listOwn.body.data.items.map((r: { id: string }) => r.id)).toContain(smrtRegId);

      const approveOwn = await request(httpServer(app))
        .patch(`/api/admin/v1/activities/${smrtActivity2Id}/registrations/${smrtRegId}/approve`)
        .set('Authorization', teamLeaderAuth)
        .send({});
      expect(approveOwn.status).toBe(200);
      expect(approveOwn.body.data.statusCode).toBe('pass');

      expectBizError(
        await request(httpServer(app))
          .get(`/api/admin/v1/activities/${swrtActivity2Id}/registrations`)
          .set('Authorization', teamLeaderAuth),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .patch(`/api/admin/v1/activities/${swrtActivity2Id}/registrations/${swrtRegId}/approve`)
          .set('Authorization', teamLeaderAuth)
          .send({}),
        BizCode.RBAC_FORBIDDEN,
      );
    });

    it('为本队活动 create attendance-sheet + 一级 approve ALLOW,为他队活动 create DENY 30100', async () => {
      const createOwn = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${smrtActivity2Id}/attendance-sheets`)
        .set('Authorization', teamLeaderAuth)
        .send({
          records: [
            {
              memberId: attTargetMemberId,
              roleCode: 'member',
              checkInAt: '2026-06-01T01:00:00.000Z',
              checkOutAt: '2026-06-01T05:00:00.000Z',
              attendanceStatusCode: 'present',
              contributionPoints: 1,
            },
          ],
        });
      expect(createOwn.status).toBe(201);
      const createdSheetId: string = createOwn.body.data.id;

      const approveOwn = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${createdSheetId}/approve`)
        .set('Authorization', teamLeaderAuth)
        .send({});
      expect(approveOwn.status).toBe(200);
      expect(approveOwn.body.data.statusCode).toBe('pending_final_review');

      expectBizError(
        await request(httpServer(app))
          .post(`/api/admin/v1/activities/${swrtActivity2Id}/attendance-sheets`)
          .set('Authorization', teamLeaderAuth)
          .send({
            records: [
              {
                memberId: attTargetMemberId,
                roleCode: 'member',
                checkInAt: '2026-06-01T01:00:00.000Z',
                checkOutAt: '2026-06-01T05:00:00.000Z',
                attendanceStatusCode: 'present',
                contributionPoints: 1,
              },
            ],
          }),
        BizCode.RBAC_FORBIDDEN,
      );
    });
  });

  // ============ ②group-leader:本组 sheet approve ALLOW;activity.update DENY(角色无码) ============

  describe('②group-leader@SMRT 子组 → group-manager@TREE(子组)', () => {
    it('本组 sheet 一级 approve → ALLOW', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${groupSheetId}/approve`)
        .set('Authorization', groupLeaderAuth)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.data.statusCode).toBe('pending_final_review');
    });

    it('activity.update → DENY 30100(group-manager 角色不含 activity 写码,no_permission)', async () => {
      expectBizError(
        await request(httpServer(app))
          .patch(`/api/admin/v1/activities/${groupActivityId}`)
          .set('Authorization', groupLeaderAuth)
          .send({ title: 'x' }),
        BizCode.RBAC_FORBIDDEN,
      );
    });
  });

  // ============ ③org-supervisor:分管树内单 sheet read ALLOW;树外 DENY ============

  describe('③org-supervisor(SupervisionAssignment@SMRT,TREE)', () => {
    it('分管树内(SMRT)单 sheet read → ALLOW(BD-3 候选码②③关闭依据的活证)', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/attendance-sheets/${smrtSheetId}`)
        .set('Authorization', supervisorAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(smrtSheetId);
    });

    it('分管树外(SWRT)单 sheet read → DENY 30100(out_of_supervised_scope)', async () => {
      expectBizError(
        await request(httpServer(app))
          .get(`/api/admin/v1/attendance-sheets/${swrtSheetId}`)
          .set('Authorization', supervisorAuth),
        BizCode.RBAC_FORBIDDEN,
      );
    });
  });

  // ============ ④纯 scoped 者扁平跨轴列表 → 30100(决断④设计内状态) ============

  it('④纯 scoped 者(team-leader,无 GLOBAL)访问扁平跨轴列表 → 30100(无 ref = GLOBAL-only)', async () => {
    expectBizError(
      await request(httpServer(app))
        .get('/api/admin/v1/attendance-sheets')
        .set('Authorization', teamLeaderAuth),
      BizCode.RBAC_FORBIDDEN,
    );
    expectBizError(
      await request(httpServer(app))
        .get('/api/admin/v1/registrations')
        .set('Authorization', teamLeaderAuth),
      BizCode.RBAC_FORBIDDEN,
    );
  });

  // ============ ⑤NOT_FOUND 回退(沿 PR9 范式;三模块各一例) ============

  describe('⑤NOT_FOUND 回退(resource_not_found → rbac.can 全局码回退,「先判权后查资源」行为锁)', () => {
    it('activities.update:GLOBAL 持码者(biz-admin)→ ACTIVITY_NOT_FOUND;无码者 → 30100', async () => {
      expectBizError(
        await request(httpServer(app))
          .patch('/api/admin/v1/activities/no-such-activity')
          .set('Authorization', bizAdminAuth)
          .send({ title: 'x' }),
        BizCode.ACTIVITY_NOT_FOUND,
      );
      expectBizError(
        await request(httpServer(app))
          .patch('/api/admin/v1/activities/no-such-activity')
          .set('Authorization', bareUserAuth)
          .send({ title: 'x' }),
        BizCode.RBAC_FORBIDDEN,
      );
    });

    it('activity-registrations.approve:GLOBAL 持码者 → ACTIVITY_REGISTRATION_NOT_FOUND;无码者 → 30100', async () => {
      expectBizError(
        await request(httpServer(app))
          .patch(
            `/api/admin/v1/activities/${smrtActivity2Id}/registrations/no-such-registration/approve`,
          )
          .set('Authorization', bizAdminAuth)
          .send({}),
        BizCode.ACTIVITY_REGISTRATION_NOT_FOUND,
      );
      expectBizError(
        await request(httpServer(app))
          .patch(
            `/api/admin/v1/activities/${smrtActivity2Id}/registrations/no-such-registration/approve`,
          )
          .set('Authorization', bareUserAuth)
          .send({}),
        BizCode.RBAC_FORBIDDEN,
      );
    });

    it('attendances.findOne:GLOBAL 持码者 → ATTENDANCE_SHEET_NOT_FOUND;无码者 → 30100', async () => {
      expectBizError(
        await request(httpServer(app))
          .get('/api/admin/v1/attendance-sheets/no-such-sheet')
          .set('Authorization', bizAdminAuth),
        BizCode.ATTENDANCE_SHEET_NOT_FOUND,
      );
      expectBizError(
        await request(httpServer(app))
          .get('/api/admin/v1/attendance-sheets/no-such-sheet')
          .set('Authorization', bareUserAuth),
        BizCode.RBAC_FORBIDDEN,
      );
    });
  });
});
