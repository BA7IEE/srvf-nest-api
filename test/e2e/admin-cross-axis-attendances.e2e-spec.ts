import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { seedParticipationReadState } from '../fixtures/contribution-ledger.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

// 跨轴只读 e2e:考勤 + 贡献值(2026-06-23 队员/审批跨轴只读查询 goal · GAP-001 Tier2 / GAP-002 Tier3)。
// 覆盖每端点:存在 + statusCode 过滤 + member-scope 命中 + 空集 + MEMBER_NOT_FOUND + RBAC_FORBIDDEN;
// 贡献值另验:生涯累计 + 全局每日封顶 3 生效(capped < 裸 SUM)+ 仅 approved sheet 计入。
//
// 端点:
//   GET /api/admin/v1/attendance-sheets(跨活动横扫;审批工作台)[attendance.read.sheet]
//   GET /api/admin/v1/members/:memberId/attendance-records(队员考勤记录;仅 approved)[attendance.read.sheet]
//   GET /api/admin/v1/members/:memberId/contribution-summary(贡献值生涯累计 capped)[attendance.read.sheet]
//
// 数据直接经 prisma 造(精确控制 sheet.statusCode / record.checkInAt / contributionPoints),
// 既绕开 submit→approve→final-approve 多步流程,又能精确验证封顶聚合。
// 退役迁移：Tier3 已切正式账本/净入账读取；旧历史异值化以防回退。
// Tier2 的旧列表及过滤验收仍待迁移：当前新版全局列表只有分页，不以 404 替代有效搜索断言。
// 账本夹具验证 credited 读取口径；封顶计算归真实准备/提交链验收。

const NONEXISTENT_MEMBER_ID = 'cl0nexistmember000000000x';

describe('跨轴只读:考勤 + 贡献值(Tier2 跨活动 + Tier3 队员 360)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAuth: string;
  let noPermAuth: string;

  let suUserId: string; // sheet.submitterUserId(真实 User FK)
  let memberAId: string;
  let memberBId: string;
  let memberEmptyId: string; // 无 approved 记录的队员(空集用)
  let act1Id: string;
  let act2Id: string;
  let rootOrgId: string; // F2/B2:供 organizationId/includeDescendants 测试复用根组织 id
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;

  beforeAll(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const su = await createTestUser(app, { username: 'xatt-su', role: Role.SUPER_ADMIN });
    const adm = await createTestUser(app, { username: 'xatt-adm', role: Role.ADMIN });
    await createTestUser(app, { username: 'xatt-noperm', role: Role.USER });
    suUserId = su.id;
    adminAuth = (await loginAs(app, 'xatt-adm')).authHeader;
    noPermAuth = (await loginAs(app, 'xatt-noperm')).authHeader;

    const seed = await seedBizAdminPermissionsAndRole(app);
    await grantBizAdminToUser(app, adm.id, seed.bizAdminRoleId);

    const ma = await prisma.member.create({
      data: { memberNo: 'xatt-a', ...memberIdentityData('XAtt Member A') },
      select: { id: true },
    });
    const mb = await prisma.member.create({
      data: { memberNo: 'xatt-b', ...memberIdentityData('XAtt Member B') },
      select: { id: true },
    });
    const me = await prisma.member.create({
      data: { memberNo: 'xatt-empty', ...memberIdentityData('XAtt Member Empty') },
      select: { id: true },
    });
    memberAId = ma.id;
    memberBId = mb.id;
    memberEmptyId = me.id;

    const org = await prisma.organization.create({
      data: { name: 'XAtt Org', nodeTypeCode: 'team' },
      select: { id: true },
    });
    rootOrgId = org.id;
    const act1 = await prisma.activity.create({
      data: {
        title: 'XAtt Activity 1',
        activityTypeCode: 'demo',
        organizationId: org.id,
        startAt: new Date('2026-06-01T00:00:00.000Z'),
        endAt: new Date('2026-06-01T10:00:00.000Z'),
        location: 'L1',
        statusCode: 'completed',
      },
      select: { id: true },
    });
    const act2 = await prisma.activity.create({
      data: {
        title: 'XAtt Activity 2',
        activityTypeCode: 'demo',
        organizationId: org.id,
        startAt: new Date('2026-06-02T00:00:00.000Z'),
        endAt: new Date('2026-06-02T10:00:00.000Z'),
        location: 'L2',
        statusCode: 'completed',
      },
      select: { id: true },
    });
    act1Id = act1.id;
    act2Id = act2.id;

    // sheet1(act1, approved):memberA 3 条 record。
    //   同北京日(Jun 1)2 条各 2.0 → 当日 4.0 封顶 3;另一北京日(Jun 3)0.5。
    //   生涯累计 capped = 3 + 0.5 = 3.5;裸 SUM = 4.5(封顶生效护栏)。
    const sheet1 = await prisma.attendanceSheet.create({
      data: { activityId: act1Id, submitterUserId: suUserId, statusCode: 'approved' },
      select: { id: true },
    });
    await prisma.attendanceRecord.createMany({
      data: [
        {
          sheetId: sheet1.id,
          memberId: memberAId,
          roleCode: 'member',
          checkInAt: new Date('2026-06-01T08:00:00.000Z'),
          checkOutAt: new Date('2026-06-01T12:00:00.000Z'),
          serviceHours: 4,
          attendanceStatusCode: 'present',
          contributionPoints: 2.0,
        },
        {
          sheetId: sheet1.id,
          memberId: memberAId,
          roleCode: 'member',
          checkInAt: new Date('2026-06-01T09:00:00.000Z'),
          checkOutAt: new Date('2026-06-01T13:00:00.000Z'),
          serviceHours: 4,
          attendanceStatusCode: 'present',
          contributionPoints: 2.0,
        },
        {
          sheetId: sheet1.id,
          memberId: memberAId,
          roleCode: 'member',
          checkInAt: new Date('2026-06-03T08:00:00.000Z'),
          checkOutAt: new Date('2026-06-03T10:00:00.000Z'),
          serviceHours: 2,
          attendanceStatusCode: 'present',
          contributionPoints: 0.5,
        },
      ],
    });

    // sheet2(act2, pending):memberA 1 条 record contributionPoints 1.0。
    //   既不进 approved-only 记录列表,也不计入贡献值(封顶核只算 approved sheet)。
    const sheet2 = await prisma.attendanceSheet.create({
      data: { activityId: act2Id, submitterUserId: suUserId, statusCode: 'pending' },
      select: { id: true },
    });
    await prisma.attendanceRecord.create({
      data: {
        sheetId: sheet2.id,
        memberId: memberAId,
        roleCode: 'member',
        checkInAt: new Date('2026-06-05T08:00:00.000Z'),
        checkOutAt: new Date('2026-06-05T10:00:00.000Z'),
        serviceHours: 2,
        attendanceStatusCode: 'present',
        contributionPoints: 1.0,
      },
    });

    // sheet3(act1, approved):memberB 1 条 record。
    const sheet3 = await prisma.attendanceSheet.create({
      data: { activityId: act1Id, submitterUserId: suUserId, statusCode: 'approved' },
      select: { id: true },
    });
    await prisma.attendanceRecord.create({
      data: {
        sheetId: sheet3.id,
        memberId: memberBId,
        roleCode: 'member',
        checkInAt: new Date('2026-06-01T08:00:00.000Z'),
        checkOutAt: new Date('2026-06-01T10:00:00.000Z'),
        serviceHours: 2,
        attendanceStatusCode: 'present',
        contributionPoints: 0.8,
      },
    });
    // Member reads consume formal entries. Explicit credited values are read
    // fixtures, not a second implementation/test of the posting cap algorithm.
    // Keep old history deliberately different so a legacy fallback cannot pass.
    await prisma.attendanceRecord.updateMany({ data: { contributionPoints: 0.25 } });
    await prisma.activity.update({
      where: { id: act1Id },
      data: { endAt: new Date('2026-06-03T12:00:00Z') },
    });
    await prisma.activity.update({
      where: { id: act2Id },
      data: { endAt: new Date('2026-06-05T12:00:00Z') },
    });
    await seedParticipationReadState(prisma, {
      activityId: act1Id,
      actorUserId: suUserId,
      participants: [
        {
          memberId: memberAId,
          resultCode: 'present',
          serviceHours: '4',
          recognizedPoints: '2',
          creditedPoints: '2',
          startAt: new Date('2026-06-01T08:00:00Z'),
        },
        {
          memberId: memberAId,
          resultCode: 'present',
          serviceHours: '4',
          recognizedPoints: '2',
          creditedPoints: '1',
          startAt: new Date('2026-06-01T09:00:00Z'),
        },
        {
          memberId: memberAId,
          resultCode: 'present',
          serviceHours: '2',
          recognizedPoints: '0.5',
          creditedPoints: '0.5',
          startAt: new Date('2026-06-03T08:00:00Z'),
        },
        {
          memberId: memberBId,
          resultCode: 'present',
          serviceHours: '2',
          recognizedPoints: '0.8',
          creditedPoints: '0.8',
          startAt: new Date('2026-06-01T08:00:00Z'),
        },
      ],
    });
    await seedParticipationReadState(prisma, {
      activityId: act2Id,
      actorUserId: suUserId,
      batchStatus: 'preparing',
      participants: [
        {
          memberId: memberAId,
          resultCode: 'present',
          serviceHours: '2',
          creditedPoints: '1',
          startAt: new Date('2026-06-05T08:00:00Z'),
        },
      ],
    });
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
      else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
    }
  });

  describe('GET /api/admin/v1/attendance-sheets(Tier2 跨活动横扫)', () => {
    it('原生列表返回全部3个不可变结算版本，带活动上下文且不回退旧 Sheet', async () => {
      const member = await prisma.member.create({
        data: {
          memberNo: 'XAtt-native-extra',
          ...memberIdentityData('Native Extra'),
          status: 'ACTIVE',
        },
      });
      const activity = await prisma.activity.create({
        data: {
          title: 'Native Extra Activity',
          activityTypeCode: 'xatt',
          organizationId: rootOrgId,
          statusCode: 'completed',
          location: 'Test',
          startAt: new Date('2020-03-01T00:00:00Z'),
          endAt: new Date('2020-03-01T02:00:00Z'),
        },
      });
      await seedParticipationReadState(prisma, {
        activityId: activity.id,
        actorUserId: suUserId,
        participants: [
          { memberId: member.id, resultCode: 'present', serviceHours: '2', creditedPoints: '1' },
        ],
      });
      const res = await request(httpServer(app))
        .get('/api/admin/v1/attendance-settlements')
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(3);
      for (const item of res.body.data.items) {
        expect(item).toHaveProperty('activityId');
        expect(item).toHaveProperty('activityTitle');
        expect(typeof item.activityTitle).toBe('string');
      }
      const items = res.body.data.items as Array<{ activityId: string }>;
      const activityIds = new Set(items.map((i) => i.activityId));
      expect(activityIds.has(act1Id)).toBe(true);
      expect(activityIds.has(act2Id)).toBe(true);
      expect(activityIds.has(activity.id)).toBe(true);
      const versions = await prisma.attendanceSettlementVersion.findMany({
        where: { statusCode: { not: 'draft' } },
        select: { id: true },
      });
      expect(
        (res.body.data.items as Array<{ settlementVersionId: string }>)
          .map((item) => item.settlementVersionId)
          .sort(),
      ).toEqual(versions.map((row) => row.id).sort());
      const secondPage = await request(httpServer(app))
        .get('/api/admin/v1/attendance-settlements')
        .query({ page: 2, pageSize: 1 })
        .set('Authorization', adminAuth)
        .expect(200);
      expect(secondPage.body.data).toMatchObject({ total: 3, page: 2, pageSize: 1 });
      expect(secondPage.body.data.items).toEqual([res.body.data.items[1]]);
    });

    it('statusCode 过滤:?statusCode=approved → 2 条', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/attendance-sheets?statusCode=approved')
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(2);
      for (const item of res.body.data.items) {
        expect(item.statusCode).toBe('approved');
      }
    });

    it('空集:?statusCode=rejected → total 0', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/attendance-sheets?statusCode=rejected')
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(0);
      expect(res.body.data.items).toEqual([]);
    });

    it('原生结算列表无读权限 → 30100', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/attendance-settlements')
        .set('Authorization', noPermAuth);

      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });

  describe('GET /api/admin/v1/members/:memberId/participation-ledger(Tier3 队员正式账本)', () => {
    it('memberA 只读已生效的 3 身份 × 2 类分录，保留活动来源且不回退旧历史', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberAId}/participation-ledger`)
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      // Each formal identity has separate service/contribution entries;
      // neither preparing entries nor legacy Sheet records are visible.
      expect(res.body.data.total).toBe(6);
      expect(res.body.data.items).toHaveLength(6);
      for (const item of res.body.data.items) {
        expect(item.memberId).toBe(memberAId);
        expect(item.activityId).toBe(act1Id);
        expect(item).toHaveProperty('sessionId');
        expect(item).toHaveProperty('postingBatchId');
        expect(item).not.toHaveProperty('sheetId');
      }
      const entries = res.body.data.items as Array<{
        entryTypeCode: string;
        creditedPointsDelta: number;
      }>;
      expect(entries.filter((item) => item.entryTypeCode === 'contribution_credit')).toHaveLength(
        3,
      );
      expect(entries.reduce((sum, item) => sum + item.creditedPointsDelta, 0)).toBe(3.5);
    });

    it('memberB 仅自己的 2 类分录(scope 隔离)', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberBId}/participation-ledger`)
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(2);
      expect(res.body.data.items).toHaveLength(2);
      for (const item of res.body.data.items) expect(item.memberId).toBe(memberBId);
    });

    it('空集:无已生效分录的队员 → total 0', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberEmptyId}/participation-ledger`)
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(0);
      expect(res.body.data.items).toEqual([]);
    });

    it('MEMBER_NOT_FOUND:不存在的 memberId → 15001', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${NONEXISTENT_MEMBER_ID}/participation-ledger`)
        .set('Authorization', adminAuth);

      expectBizError(res, BizCode.MEMBER_NOT_FOUND);
    });

    it('RBAC_FORBIDDEN:无 biz-admin → 30100', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberAId}/participation-ledger`)
        .set('Authorization', noPermAuth);

      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });

  describe('GET /api/admin/v1/members/:memberId/contribution-summary(Tier3 贡献值生涯累计)', () => {
    it('正式净入账 memberA = 3.5 < 认定 4.5；不计 preparing，也不回退不同值的旧历史', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberAId}/contribution-summary`)
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.memberId).toBe(memberAId);
      // Read the already capped June 1 credit (3) plus June 3 credit (0.5).
      // Summing recognized points or old history produces a different answer.
      expect(Number(res.body.data.contributionPoints)).toBe(3.5);
      expect(Number(res.body.data.contributionPoints)).toBeLessThan(4.5);
    });

    it('生涯累计:无记录队员 → "0"', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberEmptyId}/contribution-summary`)
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(Number(res.body.data.contributionPoints)).toBe(0);
    });

    it('MEMBER_NOT_FOUND:不存在的 memberId → 15001', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${NONEXISTENT_MEMBER_ID}/contribution-summary`)
        .set('Authorization', adminAuth);

      expectBizError(res, BizCode.MEMBER_NOT_FOUND);
    });

    it('RBAC_FORBIDDEN:无 biz-admin → 30100', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberAId}/contribution-summary`)
        .set('Authorization', noPermAuth);

      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });

  // ============ F2/B2 搜索 & 组织过滤 & expand(admin-api-fe-integration-roadmap.md §4 B2)============

  describe('GET /api/admin/v1/attendance-sheets(F2/B2 q/activityQ/organizationId/includeDescendants/dateFrom/dateTo/expand)', () => {
    let childOrgId: string;
    let activityInChildId: string;
    let submitter2UserId: string;
    const OLD_SUBMITTED_AT = new Date('2020-06-01T00:00:00.000Z');

    beforeAll(async () => {
      const submitter2 = await prisma.user.create({
        data: {
          username: 'xatt-submitter2',
          passwordHash: 'not-used-in-this-spec',
          nickname: 'XAtt昵称哥',
        },
        select: { id: true },
      });
      submitter2UserId = submitter2.id;

      // 子组织(直接经 Prisma 建,镜像既有 `org` fixture 手法;手写 closure 行模拟真实
      // OrganizationsService.create() 维护的闭包表状态,供 queryDescendantOrgIds() 读取)。
      const childOrg = await prisma.organization.create({
        data: { name: 'XAtt Child Org', nodeTypeCode: 'team', parentId: rootOrgId },
        select: { id: true },
      });
      childOrgId = childOrg.id;
      await prisma.organizationClosure.createMany({
        data: [
          { ancestorId: rootOrgId, descendantId: rootOrgId, depth: 0 },
          { ancestorId: childOrgId, descendantId: childOrgId, depth: 0 },
          { ancestorId: rootOrgId, descendantId: childOrgId, depth: 1 },
        ],
      });

      const activityInChild = await prisma.activity.create({
        data: {
          title: 'XAtt Activity In Child',
          activityTypeCode: 'demo',
          organizationId: childOrgId,
          startAt: new Date('2026-06-04T00:00:00.000Z'),
          endAt: new Date('2026-06-04T10:00:00.000Z'),
          location: 'L4',
          statusCode: 'completed',
        },
        select: { id: true },
      });
      activityInChildId = activityInChild.id;

      // submitter2 在子组织活动下提交的单据,submittedAt 显式设为远早于其它 fixture 的旧日期,
      // 供 dateFrom/dateTo 区间过滤断言;同时唯一挂在 childOrgId,供 organizationId 断言。
      await prisma.attendanceSheet.create({
        data: {
          activityId: activityInChildId,
          submitterUserId: submitter2UserId,
          statusCode: 'pending',
          submittedAt: OLD_SUBMITTED_AT,
        },
      });
    });

    it('q 命中活动标题(Activity 2 → sheet2)', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/attendance-sheets')
        .query({ q: 'XAtt Activity 2' })
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items[0].activityId).toBe(act2Id);
    });

    it('q 命中提交人 username(submitter2 唯一挂子组织单据)', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/attendance-sheets')
        .query({ q: 'xatt-submitter2' })
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items[0].submitterUserId).toBe(submitter2UserId);
    });

    it('q 命中提交人 nickname', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/attendance-sheets')
        .query({ q: 'XAtt昵称哥' })
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items[0].submitterUserId).toBe(submitter2UserId);
    });

    it('activityQ 仅命中活动标题(Activity 2 → sheet2)', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/attendance-sheets')
        .query({ activityQ: 'Activity 2' })
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items[0].activityId).toBe(act2Id);
    });

    it('organizationId(不展开后代):仅根组织下活动的单据,不含子组织', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/attendance-sheets')
        .query({ organizationId: rootOrgId })
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(3);
      const items = res.body.data.items as Array<{ submitterUserId: string }>;
      expect(items.some((i) => i.submitterUserId === submitter2UserId)).toBe(false);
    });

    it('organizationId + includeDescendants:展开后代组织,含子组织单据', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/attendance-sheets')
        .query({ organizationId: rootOrgId, includeDescendants: 'true' })
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(4);
      const items = res.body.data.items as Array<{ submitterUserId: string }>;
      expect(items.some((i) => i.submitterUserId === submitter2UserId)).toBe(true);
    });

    it('dateFrom 按 submittedAt 过滤:排除旧单据(submitter2),仅返近期 3 条', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/attendance-sheets')
        .query({ dateFrom: '2026-01-01T00:00:00.000Z' })
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(3);
      const items = res.body.data.items as Array<{ submitterUserId: string }>;
      expect(items.some((i) => i.submitterUserId === submitter2UserId)).toBe(false);
    });

    it('dateTo 按 submittedAt 过滤:仅命中旧单据(submitter2)', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/attendance-sheets')
        .query({ dateTo: '2021-01-01T00:00:00.000Z' })
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items[0].submitterUserId).toBe(submitter2UserId);
    });

    it('expand=activity:附带活动摘要子对象', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/attendance-sheets')
        .query({ activityQ: 'Activity 2', expand: 'activity' })
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      const item = res.body.data.items[0];
      expect(item.activity).toEqual({
        id: act2Id,
        title: 'XAtt Activity 2',
        startAt: '2026-06-02T00:00:00.000Z',
        organizationId: rootOrgId,
      });
    });

    it('原生列表默认使用扁平活动上下文，不附加 activity 嵌套块', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/attendance-settlements')
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      const item = (res.body.data.items as Array<Record<string, unknown>>).find(
        (row) => row.activityId === act2Id,
      );
      expect(item).toBeDefined();
      expect(item).toMatchObject({ activityId: act2Id, activityTitle: 'XAtt Activity 2' });
      expect(item).not.toHaveProperty('activity');
    });

    it('原生列表未知 expand 值 → BAD_REQUEST', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/attendance-settlements')
        .query({ expand: 'bogus' })
        .set('Authorization', adminAuth);

      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
      expect(res.body.message).toBe('property expand should not exist');
    });
  });
});
