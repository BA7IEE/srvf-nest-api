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

// 跨轴只读 e2e:报名(2026-06-23 队员/审批跨轴只读查询 goal · GAP-001 Tier2 / GAP-002 Tier3)。
// 覆盖每端点:存在 + statusCode 过滤 + member-scope 命中 + 空集 + MEMBER_NOT_FOUND + RBAC_FORBIDDEN。
//
// 端点:
//   GET /api/admin/v1/registrations(跨活动横扫;审批工作台)[activity-registration.read.record]
//   GET /api/admin/v1/members/:memberId/registrations(队员履历;队员 360)[activity-registration.read.record]
//
// 既有嵌套路径 GET /activities/:activityId/registrations 行为零变更(本 goal 只新增 surface)。

const NONEXISTENT_MEMBER_ID = 'cl0nexistmember000000000x';

describe('跨轴只读:报名(Tier2 跨活动 + Tier3 队员履历)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAuth: string; // biz-admin(有 activity-registration.read.record)
  let noPermAuth: string; // 无 biz-admin(判权失败 → 30100)

  let memberAId: string;
  let memberBId: string;
  let act1Id: string;
  let act2Id: string;
  let rootOrgId: string; // F2/B1:供 organizationId/includeDescendants 测试复用根组织 id

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    await createTestUser(app, { username: 'xreg-su', role: Role.SUPER_ADMIN });
    const adm = await createTestUser(app, { username: 'xreg-adm', role: Role.ADMIN });
    await createTestUser(app, { username: 'xreg-noperm', role: Role.USER });
    adminAuth = (await loginAs(app, 'xreg-adm')).authHeader;
    noPermAuth = (await loginAs(app, 'xreg-noperm')).authHeader;

    const seed = await seedBizAdminPermissionsAndRole(app);
    await grantBizAdminToUser(app, adm.id, seed.bizAdminRoleId);

    const ma = await prisma.member.create({
      data: { memberNo: 'xreg-a', displayName: 'XReg Member A' },
      select: { id: true },
    });
    const mb = await prisma.member.create({
      data: { memberNo: 'xreg-b', displayName: 'XReg Member B' },
      select: { id: true },
    });
    memberAId = ma.id;
    memberBId = mb.id;

    const org = await prisma.organization.create({
      data: { name: 'XReg Org', nodeTypeCode: 'team' },
      select: { id: true },
    });
    rootOrgId = org.id;
    const act1 = await prisma.activity.create({
      data: {
        title: 'XReg Activity 1',
        activityTypeCode: 'demo',
        organizationId: org.id,
        startAt: new Date('2026-06-01T00:00:00.000Z'),
        endAt: new Date('2026-06-01T10:00:00.000Z'),
        location: 'L1',
        statusCode: 'published',
      },
      select: { id: true },
    });
    const act2 = await prisma.activity.create({
      data: {
        title: 'XReg Activity 2',
        activityTypeCode: 'demo',
        organizationId: org.id,
        startAt: new Date('2026-06-02T00:00:00.000Z'),
        endAt: new Date('2026-06-02T10:00:00.000Z'),
        location: 'L2',
        statusCode: 'published',
      },
      select: { id: true },
    });
    act1Id = act1.id;
    act2Id = act2.id;

    // A→act1 pending / A→act2 pass / B→act1 pending(跨活动 3 条;memberA 履历 2 条)。
    await prisma.activityRegistration.create({
      data: { activityId: act1Id, memberId: memberAId, statusCode: 'pending' },
    });
    await prisma.activityRegistration.create({
      data: { activityId: act2Id, memberId: memberAId, statusCode: 'pass' },
    });
    await prisma.activityRegistration.create({
      data: { activityId: act1Id, memberId: memberBId, statusCode: 'pending' },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/admin/v1/registrations(Tier2 跨活动横扫)', () => {
    it('存在:返回全部报名,item 带 activity 上下文(activityId/title)', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/registrations')
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(3);
      expect(res.body.data.items).toHaveLength(3);
      for (const item of res.body.data.items) {
        expect(item).toHaveProperty('activityId');
        expect(item).toHaveProperty('activityTitle');
        expect(typeof item.activityTitle).toBe('string');
      }
      // 跨活动:item 同时含 act1 与 act2。
      const items = res.body.data.items as Array<{ activityId: string }>;
      const activityIds = new Set(items.map((i) => i.activityId));
      expect(activityIds.has(act1Id)).toBe(true);
      expect(activityIds.has(act2Id)).toBe(true);
    });

    it('statusCode 过滤:?statusCode=pass 仅返通过的 1 条', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/registrations?statusCode=pass')
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items[0].statusCode).toBe('pass');
      expect(res.body.data.items[0].memberId).toBe(memberAId);
      expect(res.body.data.items[0].activityId).toBe(act2Id);
    });

    it('空集:?statusCode=cancelled → total 0 / items []', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/registrations?statusCode=cancelled')
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(0);
      expect(res.body.data.items).toEqual([]);
    });

    it('RBAC_FORBIDDEN:无 biz-admin → 30100', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/registrations')
        .set('Authorization', noPermAuth);

      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });

  describe('GET /api/admin/v1/members/:memberId/registrations(Tier3 队员履历)', () => {
    it('member-scope 命中:memberA 跨活动履历 2 条,均属本人', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberAId}/registrations`)
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(2);
      for (const item of res.body.data.items) {
        expect(item.memberId).toBe(memberAId);
        expect(item).toHaveProperty('activityTitle');
      }
    });

    it('member-scope 命中:memberB 仅 1 条(scope 隔离)', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberBId}/registrations`)
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items[0].memberId).toBe(memberBId);
    });

    it('statusCode 过滤(member 内):memberA ?statusCode=pass → 1 条', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberAId}/registrations?statusCode=pass`)
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items[0].statusCode).toBe('pass');
    });

    it('空集:memberB ?statusCode=pass → total 0(队员存在但无该状态)', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberBId}/registrations?statusCode=pass`)
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(0);
      expect(res.body.data.items).toEqual([]);
    });

    it('MEMBER_NOT_FOUND:不存在的 memberId → 15001', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${NONEXISTENT_MEMBER_ID}/registrations`)
        .set('Authorization', adminAuth);

      expectBizError(res, BizCode.MEMBER_NOT_FOUND);
    });

    it('RBAC_FORBIDDEN:无 biz-admin → 30100', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberAId}/registrations`)
        .set('Authorization', noPermAuth);

      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });

  // ============ F2/B1 搜索 & 组织过滤 & expand(admin-api-fe-integration-roadmap.md §4 B1)============

  describe('GET /api/admin/v1/registrations(F2/B1 q/memberQ/activityQ/memberId/activityId/organizationId/includeDescendants/dateFrom/dateTo/expand)', () => {
    let memberCId: string;
    let childOrgId: string;
    let activityInChildId: string;
    const OLD_REGISTERED_AT = new Date('2020-06-01T00:00:00.000Z');

    beforeAll(async () => {
      const mc = await prisma.member.create({
        data: { memberNo: 'xreg-c', displayName: 'XReg Member C' },
        select: { id: true },
      });
      memberCId = mc.id;

      // 子组织(直接经 Prisma 建,镜像既有 `org` fixture 手法;手写 closure 行模拟真实
      // OrganizationsService.create() 维护的闭包表状态,供 queryDescendantOrgIds() 读取)。
      const childOrg = await prisma.organization.create({
        data: { name: 'XReg Child Org', nodeTypeCode: 'team', parentId: rootOrgId },
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
          title: 'XReg Activity In Child',
          activityTypeCode: 'demo',
          organizationId: childOrgId,
          startAt: new Date('2026-06-03T00:00:00.000Z'),
          endAt: new Date('2026-06-03T10:00:00.000Z'),
          location: 'L3',
          statusCode: 'published',
        },
        select: { id: true },
      });
      activityInChildId = activityInChild.id;

      // memberC 在子组织活动下的报名,registeredAt 显式设为远早于其它 fixture 的旧日期,
      // 供 dateFrom/dateTo 区间过滤断言;同时唯一挂在 childOrgId,供 organizationId 断言。
      await prisma.activityRegistration.create({
        data: {
          activityId: activityInChildId,
          memberId: memberCId,
          statusCode: 'pending',
          registeredAt: OLD_REGISTERED_AT,
        },
      });
    });

    it('q 跨字段命中 memberNo+memberDisplayName+activityTitle(命中 memberA 两条,不看 activity)', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/registrations')
        .query({ q: 'xreg-a' })
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(2);
      const items = res.body.data.items as Array<{ memberId: string }>;
      expect(items.every((i) => i.memberId === memberAId)).toBe(true);
    });

    it('memberQ 仅命中队员字段(memberB)', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/registrations')
        .query({ memberQ: 'xreg-b' })
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items[0].memberId).toBe(memberBId);
    });

    it('activityQ 仅命中活动标题(Activity 2)', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/registrations')
        .query({ activityQ: 'Activity 2' })
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items[0].activityId).toBe(act2Id);
    });

    it('memberId 精确过滤', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/registrations')
        .query({ memberId: memberBId })
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items[0].activityId).toBe(act1Id);
    });

    it('activityId 精确过滤(act1 命中 memberA + memberB 两条)', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/registrations')
        .query({ activityId: act1Id })
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(2);
    });

    it('organizationId(不展开后代):仅根组织下活动的报名,不含子组织', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/registrations')
        .query({ organizationId: rootOrgId })
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(3);
      const items = res.body.data.items as Array<{ memberId: string }>;
      expect(items.some((i) => i.memberId === memberCId)).toBe(false);
    });

    it('organizationId + includeDescendants:展开后代组织,含子组织报名', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/registrations')
        .query({ organizationId: rootOrgId, includeDescendants: 'true' })
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(4);
      const items = res.body.data.items as Array<{ memberId: string }>;
      expect(items.some((i) => i.memberId === memberCId)).toBe(true);
    });

    it('dateFrom 按 registeredAt 过滤:排除旧报名(memberC),仅返近期 3 条', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/registrations')
        .query({ dateFrom: '2026-01-01T00:00:00.000Z' })
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(3);
      const items = res.body.data.items as Array<{ memberId: string }>;
      expect(items.some((i) => i.memberId === memberCId)).toBe(false);
    });

    it('dateTo 按 registeredAt 过滤:仅命中旧报名(memberC)', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/registrations')
        .query({ dateTo: '2021-01-01T00:00:00.000Z' })
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items[0].memberId).toBe(memberCId);
    });

    it('expand=member,activity:附带队员/活动摘要子对象', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/registrations')
        .query({ activityId: act1Id, memberId: memberAId, expand: 'member,activity' })
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      const item = res.body.data.items[0];
      expect(item.member).toEqual({
        id: memberAId,
        memberNo: 'xreg-a',
        displayName: 'XReg Member A',
        gradeCode: null,
      });
      expect(item.activity).toEqual({
        id: act1Id,
        title: 'XReg Activity 1',
        startAt: '2026-06-01T00:00:00.000Z',
        organizationId: rootOrgId,
      });
    });

    it('expand 默认关闭:响应形状逐字不变(不含 member/activity 键)', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/registrations')
        .query({ activityId: act1Id, memberId: memberAId })
        .set('Authorization', adminAuth);

      expect(res.status).toBe(200);
      const item = res.body.data.items[0] as Record<string, unknown>;
      expect(item).not.toHaveProperty('member');
      expect(item).not.toHaveProperty('activity');
    });

    it('expand 白名单外值 → BAD_REQUEST', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/registrations')
        .query({ expand: 'bogus' })
        .set('Authorization', adminAuth);

      expectBizError(res, BizCode.BAD_REQUEST);
    });
  });
});
