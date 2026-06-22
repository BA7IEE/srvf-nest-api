import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 跨轴只读 e2e:考勤 + 贡献值(2026-06-23 队员/审批跨轴只读查询 goal · GAP-001 Tier2 / GAP-002 Tier3)。
// 覆盖每端点:存在 + statusCode 过滤 + member-scope 命中 + 空集 + MEMBER_NOT_FOUND + RBAC_FORBIDDEN;
// 贡献值另验:生涯累计 + 全局每日封顶 1.5 生效(capped < 裸 SUM)+ 仅 approved sheet 计入。
//
// 端点:
//   GET /api/admin/v1/attendance-sheets(跨活动横扫;审批工作台)[attendance.read.sheet]
//   GET /api/admin/v1/members/:memberId/attendance-records(队员考勤记录;仅 approved)[attendance.read.sheet]
//   GET /api/admin/v1/members/:memberId/contribution-summary(贡献值生涯累计 capped)[attendance.read.sheet]
//
// 数据直接经 prisma 造(精确控制 sheet.statusCode / record.checkInAt / contributionPoints),
// 既绕开 submit→approve→final-approve 多步流程,又能精确验证封顶聚合。

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

  beforeAll(async () => {
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
      data: { memberNo: 'xatt-a', displayName: 'XAtt Member A' },
      select: { id: true },
    });
    const mb = await prisma.member.create({
      data: { memberNo: 'xatt-b', displayName: 'XAtt Member B' },
      select: { id: true },
    });
    const me = await prisma.member.create({
      data: { memberNo: 'xatt-empty', displayName: 'XAtt Member Empty' },
      select: { id: true },
    });
    memberAId = ma.id;
    memberBId = mb.id;
    memberEmptyId = me.id;

    const org = await prisma.organization.create({
      data: { name: 'XAtt Org', nodeTypeCode: 'team' },
      select: { id: true },
    });
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
    //   同北京日(Jun 1)2 条各 1.0 → 当日 2.0 封顶 1.5;另一北京日(Jun 3)0.5。
    //   生涯累计 capped = 1.5 + 0.5 = 2.0;裸 SUM = 2.5(封顶生效护栏)。
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
          contributionPoints: 1.0,
        },
        {
          sheetId: sheet1.id,
          memberId: memberAId,
          roleCode: 'member',
          checkInAt: new Date('2026-06-01T09:00:00.000Z'),
          checkOutAt: new Date('2026-06-01T13:00:00.000Z'),
          serviceHours: 4,
          attendanceStatusCode: 'present',
          contributionPoints: 1.0,
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
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/admin/v1/attendance-sheets(Tier2 跨活动横扫)', () => {
    it('存在:返回全部单据(3),item 带 activity 上下文(activityId/title)', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/attendance-sheets')
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

    it('RBAC_FORBIDDEN:无 biz-admin → 30100', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/attendance-sheets')
        .set('Authorization', noPermAuth);

      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });

  describe('GET /api/admin/v1/members/:memberId/attendance-records(Tier3 队员考勤记录)', () => {
    it('member-scope 命中:memberA 仅 approved sheet 内 3 条,均属本人 + 带 activity 上下文', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberAId}/attendance-records`)
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      // sheet1(approved)3 条计入;sheet2(pending)1 条**不**计入(approved-only)。
      expect(res.body.data.total).toBe(3);
      for (const item of res.body.data.items) {
        expect(item.memberId).toBe(memberAId);
        expect(item.activityId).toBe(act1Id);
        expect(item).toHaveProperty('activityTitle');
        expect(item).toHaveProperty('sheetId');
      }
    });

    it('member-scope 命中:memberB 仅 1 条(scope 隔离)', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberBId}/attendance-records`)
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items[0].memberId).toBe(memberBId);
    });

    it('空集:无 approved 记录的队员 → total 0', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberEmptyId}/attendance-records`)
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(0);
      expect(res.body.data.items).toEqual([]);
    });

    it('MEMBER_NOT_FOUND:不存在的 memberId → 15001', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${NONEXISTENT_MEMBER_ID}/attendance-records`)
        .set('Authorization', adminAuth);

      expectBizError(res, BizCode.MEMBER_NOT_FOUND);
    });

    it('RBAC_FORBIDDEN:无 biz-admin → 30100', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberAId}/attendance-records`)
        .set('Authorization', noPermAuth);

      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });

  describe('GET /api/admin/v1/members/:memberId/contribution-summary(Tier3 贡献值生涯累计)', () => {
    it('生涯累计 capped:memberA = 2.0(封顶生效,严格 < 裸 SUM 2.5;pending sheet 不计)', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberAId}/contribution-summary`)
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.memberId).toBe(memberAId);
      // Jun1: 1.0+1.0=2.0 → 封顶 1.5;Jun3: 0.5;总 2.0。裸 SUM(含封顶前)= 2.5。
      expect(Number(res.body.data.contributionPoints)).toBe(2);
      expect(Number(res.body.data.contributionPoints)).toBeLessThan(2.5);
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
});
