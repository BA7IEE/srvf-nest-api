import type { INestApplication } from '@nestjs/common';
import { ContributionRuleStatus, DictItemStatus, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantOpsAdminToUser, seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// V2 第一阶段批次 5-A contribution-rules 模块 e2e。
// 覆盖 D6 v1.1 §7.1 CRUD / 权限矩阵，并由 D-RULE-1 增补 pair 维度 service/DB 唯一性。
//
// P0-F PR-2A(2026-05-18):入口切到 service 层 rbac.can();失败统一 RBAC_FORBIDDEN(30100)。
// `adminAuth` 在 beforeAll 全局 grant ops-admin(沿 dict / org / member-dept e2e 范式);
// 单独建 `adminDefaultAuth` 做"ADMIN 默认 30100"反向断言。

describe('contribution-rules 模块', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAdminAuth: string;
  let adminAuth: string;
  let adminDefaultAuth: string;
  let userAuth: string;
  let superAdminUserId: string;

  // 字典 code(beforeAll 创建,所有用例共用)
  const ACTIVITY_TYPE_ACTIVE = 'crtypea';
  const ACTIVITY_TYPE_ACTIVE_2 = 'crtypeb';
  const ACTIVITY_TYPE_INACTIVE = 'crtypex';
  const ROLE_ACTIVE = 'crrolea';
  const ROLE_ACTIVE_2 = 'crroleb';
  const ROLE_INACTIVE = 'crrolex';

  const URL = '/api/system/v1/contribution-rules';

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    await createTestUser(app, { username: 'cr-su', role: Role.SUPER_ADMIN });
    const admin = await createTestUser(app, { username: 'cr-adm', role: Role.ADMIN });
    await createTestUser(app, { username: 'cr-adm-default', role: Role.ADMIN });
    await createTestUser(app, { username: 'cr-user', role: Role.USER });
    superAdminAuth = (await loginAs(app, 'cr-su')).authHeader;
    adminAuth = (await loginAs(app, 'cr-adm')).authHeader;
    adminDefaultAuth = (await loginAs(app, 'cr-adm-default')).authHeader;
    userAuth = (await loginAs(app, 'cr-user')).authHeader;
    const suRow = await prisma.user.findUniqueOrThrow({
      where: { username: 'cr-su' },
      select: { id: true },
    });
    superAdminUserId = suRow.id;

    // P0-F PR-2A:seed 33 条 RBAC + ops-admin;给 cr-adm 全局 grant ops-admin
    const seed = await seedRbacPermissionsAndOpsAdmin(app);
    await grantOpsAdminToUser(app, admin.id, seed.opsAdminRoleId);

    // 字典:activity_type
    const activityTypeDict = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: activityTypeDict.id, code: ACTIVITY_TYPE_ACTIVE, label: '类型A(活)' },
    });
    await prisma.dictItem.create({
      data: { typeId: activityTypeDict.id, code: ACTIVITY_TYPE_ACTIVE_2, label: '类型B(活)' },
    });
    await prisma.dictItem.create({
      data: {
        typeId: activityTypeDict.id,
        code: ACTIVITY_TYPE_INACTIVE,
        label: '类型C(停)',
        status: DictItemStatus.INACTIVE,
      },
    });

    // 字典:attendance_role
    const roleDict = await prisma.dictType.create({
      data: { code: 'attendance_role', label: '考勤角色' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: roleDict.id, code: ROLE_ACTIVE, label: '角色A(活)' },
    });
    await prisma.dictItem.create({
      data: { typeId: roleDict.id, code: ROLE_ACTIVE_2, label: '角色B(活)' },
    });
    await prisma.dictItem.create({
      data: {
        typeId: roleDict.id,
        code: ROLE_INACTIVE,
        label: '角色C(停)',
        status: DictItemStatus.INACTIVE,
      },
    });
  });

  // 每个 it 前清表,避免上下文耦合
  beforeEach(async () => {
    await prisma.contributionRule.deleteMany({});
  });

  afterAll(async () => {
    await app.close();
  });

  // ============ 公共工厂 ============

  const createRule = (override: Record<string, unknown> = {}): Record<string, unknown> => ({
    activityTypeCode: ACTIVITY_TYPE_ACTIVE,
    attendanceRoleCode: ROLE_ACTIVE,
    pointsBelow: 1.0,
    ...override,
  });

  const postCreate = (body: Record<string, unknown>, auth = adminAuth) =>
    request(httpServer(app)).post(URL).set('Authorization', auth).send(body);

  const seedRule = async (data: Record<string, unknown> = {}): Promise<string> => {
    const rule = await prisma.contributionRule.create({
      data: {
        activityTypeCode: (data.activityTypeCode as string | undefined) ?? ACTIVITY_TYPE_ACTIVE,
        attendanceRoleCode: (data.attendanceRoleCode as string | undefined) ?? ROLE_ACTIVE,
        durationThreshold: (data.durationThreshold as number | null | undefined) ?? null,
        pointsBelow: (data.pointsBelow as number | undefined) ?? 1.0,
        pointsAbove: (data.pointsAbove as number | null | undefined) ?? null,
        dailyCap: (data.dailyCap as number | null | undefined) ?? null,
        status:
          (data.status as ContributionRuleStatus | undefined) ?? ContributionRuleStatus.ACTIVE,
        remark: (data.remark as string | null | undefined) ?? null,
        deletedAt: (data.deletedAt as Date | null | undefined) ?? null,
      },
      select: { id: true },
    });
    return rule.id;
  };

  // ============ list(7) ============

  describe('GET /api/system/v1/contribution-rules', () => {
    it('list-1 默认分页 + 主排序(activityTypeCode / attendanceRoleCode ASC;不断言 NULL 顺位)', async () => {
      await seedRule({ activityTypeCode: ACTIVITY_TYPE_ACTIVE_2, attendanceRoleCode: ROLE_ACTIVE });
      await seedRule({ activityTypeCode: ACTIVITY_TYPE_ACTIVE, attendanceRoleCode: ROLE_ACTIVE_2 });
      await seedRule({ activityTypeCode: ACTIVITY_TYPE_ACTIVE, attendanceRoleCode: ROLE_ACTIVE });

      const res = await request(httpServer(app)).get(URL).set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      const items = res.body.data.items as Array<{
        activityTypeCode: string;
        attendanceRoleCode: string;
      }>;
      expect(items.length).toBe(3);
      // 主排序:activityTypeCode 升序后 attendanceRoleCode 升序
      const keys = items.map((i) => `${i.activityTypeCode}|${i.attendanceRoleCode}`);
      const sorted = [...keys].sort();
      expect(keys).toEqual(sorted);
      expect(res.body.data.total).toBe(3);
      expect(res.body.data.page).toBe(1);
      expect(res.body.data.pageSize).toBe(20);
    });

    it('list-2 过滤 activityTypeCode 命中', async () => {
      await seedRule({ activityTypeCode: ACTIVITY_TYPE_ACTIVE });
      await seedRule({
        activityTypeCode: ACTIVITY_TYPE_ACTIVE_2,
        attendanceRoleCode: ROLE_ACTIVE_2,
      });
      const res = await request(httpServer(app))
        .get(URL)
        .query({ activityTypeCode: ACTIVITY_TYPE_ACTIVE })
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      const items = res.body.data.items as Array<{ activityTypeCode: string }>;
      expect(items.length).toBe(1);
      expect(items[0].activityTypeCode).toBe(ACTIVITY_TYPE_ACTIVE);
    });

    it('list-3 过滤 attendanceRoleCode 命中', async () => {
      await seedRule({ attendanceRoleCode: ROLE_ACTIVE });
      await seedRule({
        activityTypeCode: ACTIVITY_TYPE_ACTIVE_2,
        attendanceRoleCode: ROLE_ACTIVE_2,
      });
      const res = await request(httpServer(app))
        .get(URL)
        .query({ attendanceRoleCode: ROLE_ACTIVE })
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBe(1);
      expect(res.body.data.items[0].attendanceRoleCode).toBe(ROLE_ACTIVE);
    });

    it('list-4 过滤 status=INACTIVE 命中', async () => {
      await seedRule({ status: ContributionRuleStatus.ACTIVE });
      await seedRule({
        attendanceRoleCode: ROLE_ACTIVE_2,
        status: ContributionRuleStatus.INACTIVE,
      });
      const res = await request(httpServer(app))
        .get(URL)
        .query({ status: 'INACTIVE' })
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBe(1);
      expect(res.body.data.items[0].status).toBe('INACTIVE');
    });

    it('list-5 软删数据不可见;不暴露 deletedAt', async () => {
      const activeId = await seedRule({});
      const deletedId = await seedRule({
        attendanceRoleCode: ROLE_ACTIVE_2,
        deletedAt: new Date(),
      });
      const res = await request(httpServer(app)).get(URL).set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      const ids = (res.body.data.items as Array<{ id: string }>).map((i) => i.id);
      expect(ids).toContain(activeId);
      expect(ids).not.toContain(deletedId);
      for (const item of res.body.data.items) {
        expect(item).not.toHaveProperty('deletedAt');
        expect(item).not.toHaveProperty('deletedByUserId');
      }
    });

    it('list-6 pageSize=200 超过上限 → 400(ValidationPipe)', async () => {
      const res = await request(httpServer(app))
        .get(URL)
        .query({ pageSize: 200 })
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('list-7 分页边界 page=1/2 拼接稳定(同维度内不跳序)', async () => {
      // 创建 3 条规则,pageSize=2 → 2 + 1
      await seedRule({
        activityTypeCode: ACTIVITY_TYPE_ACTIVE,
        attendanceRoleCode: ROLE_ACTIVE,
        durationThreshold: 1,
      });
      await seedRule({
        activityTypeCode: ACTIVITY_TYPE_ACTIVE,
        attendanceRoleCode: ROLE_ACTIVE_2,
        durationThreshold: 2,
      });
      await seedRule({
        activityTypeCode: ACTIVITY_TYPE_ACTIVE_2,
        attendanceRoleCode: ROLE_ACTIVE,
        durationThreshold: 1,
      });
      const p1 = await request(httpServer(app))
        .get(URL)
        .query({ page: 1, pageSize: 2 })
        .set('Authorization', adminAuth);
      const p2 = await request(httpServer(app))
        .get(URL)
        .query({ page: 2, pageSize: 2 })
        .set('Authorization', adminAuth);
      expect(p1.status).toBe(200);
      expect(p2.status).toBe(200);
      const allKeys = [
        ...(p1.body.data.items as Array<{ activityTypeCode: string; attendanceRoleCode: string }>),
        ...(p2.body.data.items as Array<{ activityTypeCode: string; attendanceRoleCode: string }>),
      ].map((i) => `${i.activityTypeCode}|${i.attendanceRoleCode}`);
      const sorted = [...allKeys].sort();
      expect(allKeys).toEqual(sorted);
      expect(p1.body.data.total).toBe(3);
      expect(p2.body.data.total).toBe(3);
    });
  });

  // ============ detail(3) ============

  describe('GET /api/system/v1/contribution-rules/:id', () => {
    it('detail-1 命中', async () => {
      const id = await seedRule({});
      const res = await request(httpServer(app))
        .get(`${URL}/${id}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(id);
      expect(res.body.data).not.toHaveProperty('deletedAt');
      expect(res.body.data).not.toHaveProperty('deletedByUserId');
    });

    it('detail-2 不存在 → 23001', async () => {
      const res = await request(httpServer(app))
        .get(`${URL}/cl0000000000000000000000`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.CONTRIBUTION_RULE_NOT_FOUND);
    });

    it('detail-3 已软删 → 23001', async () => {
      const id = await seedRule({ deletedAt: new Date() });
      const res = await request(httpServer(app))
        .get(`${URL}/${id}`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.CONTRIBUTION_RULE_NOT_FOUND);
    });
  });

  // ============ create(17) ============

  describe('POST /api/system/v1/contribution-rules', () => {
    it('create-1 全字段', async () => {
      const res = await postCreate(
        createRule({
          durationThreshold: 2.5,
          pointsAbove: 1.5,
          dailyCap: 2.0,
          status: ContributionRuleStatus.ACTIVE,
          remark: '主用规则',
        }),
        superAdminAuth,
      );
      expect(res.status).toBe(201);
      expect(res.body.data.durationThreshold).toBe(2.5);
      expect(res.body.data.pointsBelow).toBe(1);
      expect(res.body.data.pointsAbove).toBe(1.5);
      expect(res.body.data.dailyCap).toBe(2);
      expect(res.body.data.status).toBe('ACTIVE');
      expect(res.body.data.remark).toBe('主用规则');
      expect(res.body.data.createdByUserId).toBe(superAdminUserId);
    });

    it('create-2 仅必填字段(其他 omit)', async () => {
      const res = await postCreate(createRule({}));
      expect(res.status).toBe(201);
      expect(res.body.data.durationThreshold).toBeNull();
      expect(res.body.data.pointsAbove).toBeNull();
      expect(res.body.data.dailyCap).toBeNull();
      expect(res.body.data.status).toBe('ACTIVE');
      expect(res.body.data.remark).toBeNull();
    });

    it('create-3 显式 durationThreshold: null(无档位)', async () => {
      const res = await postCreate(createRule({ durationThreshold: null }));
      expect(res.status).toBe(201);
      expect(res.body.data.durationThreshold).toBeNull();
    });

    it('create-4 显式 pointsAbove: null(无超档位分值)', async () => {
      const res = await postCreate(createRule({ durationThreshold: 1, pointsAbove: null }));
      expect(res.status).toBe(201);
      expect(res.body.data.pointsAbove).toBeNull();
    });

    it('create-5 同 type×role 不同 threshold 的第二条 ACTIVE → 23002', async () => {
      await seedRule({ durationThreshold: 1 });
      const res = await postCreate(createRule({ durationThreshold: 2 }));
      expectBizError(res, BizCode.CONTRIBUTION_RULE_ACTIVE_DUPLICATE);
    });

    it('create-6 durationThreshold=NULL 多条 ACTIVE → 23002(P1-3 核心)', async () => {
      await seedRule({ durationThreshold: null });
      const res = await postCreate(createRule({ durationThreshold: null }));
      expectBizError(res, BizCode.CONTRIBUTION_RULE_ACTIVE_DUPLICATE);
    });

    it('create-7 同 pair INACTIVE 不占 ACTIVE slot → 允许不同 threshold ACTIVE', async () => {
      await seedRule({ durationThreshold: 1, status: ContributionRuleStatus.INACTIVE });
      const res = await postCreate(createRule({ durationThreshold: 2 }));
      expect(res.status).toBe(201);
    });

    it('create-8 同 pair 已软删 ACTIVE 不占 slot → 允许不同 threshold ACTIVE', async () => {
      await seedRule({ durationThreshold: 1, deletedAt: new Date() });
      const res = await postCreate(createRule({ durationThreshold: 2 }));
      expect(res.status).toBe(201);
    });

    it('create-9 activityTypeCode 不存在 → 23011', async () => {
      const res = await postCreate(createRule({ activityTypeCode: 'no_such_type' }));
      expectBizError(res, BizCode.CONTRIBUTION_RULE_ACTIVITY_TYPE_INVALID);
    });

    it('create-10 activityTypeCode 已停用 → 23011', async () => {
      const res = await postCreate(createRule({ activityTypeCode: ACTIVITY_TYPE_INACTIVE }));
      expectBizError(res, BizCode.CONTRIBUTION_RULE_ACTIVITY_TYPE_INVALID);
    });

    it('create-11 attendanceRoleCode 不存在 → 23012', async () => {
      const res = await postCreate(createRule({ attendanceRoleCode: 'no_such_role' }));
      expectBizError(res, BizCode.CONTRIBUTION_RULE_ROLE_CODE_INVALID);
    });

    it('create-12 attendanceRoleCode 已停用 → 23012', async () => {
      const res = await postCreate(createRule({ attendanceRoleCode: ROLE_INACTIVE }));
      expectBizError(res, BizCode.CONTRIBUTION_RULE_ROLE_CODE_INVALID);
    });

    it('create-13 pointsAbove != null && durationThreshold == null → 23010', async () => {
      const res = await postCreate(createRule({ durationThreshold: null, pointsAbove: 2 }));
      expectBizError(res, BizCode.CONTRIBUTION_RULE_POINTS_INVALID);
    });

    it('create-14 pointsAbove <= pointsBelow → 23010', async () => {
      const res = await postCreate(
        createRule({ durationThreshold: 1, pointsBelow: 2, pointsAbove: 1 }),
      );
      expectBizError(res, BizCode.CONTRIBUTION_RULE_POINTS_INVALID);
    });

    it('create-15 pointsAbove === pointsBelow 边界 → 23010(严格 >)', async () => {
      const res = await postCreate(
        createRule({ durationThreshold: 1, pointsBelow: 1, pointsAbove: 1 }),
      );
      expectBizError(res, BizCode.CONTRIBUTION_RULE_POINTS_INVALID);
    });

    it('create-16 pointsBelow < 0 → ValidationPipe 400', async () => {
      const res = await postCreate(createRule({ pointsBelow: -0.5 }));
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('create-17 durationThreshold = 0 → ValidationPipe 400', async () => {
      const res = await postCreate(createRule({ durationThreshold: 0 }));
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });
  });

  // ============ update(10) ============

  describe('PATCH /api/system/v1/contribution-rules/:id', () => {
    const patch = (id: string, body: Record<string, unknown>, auth = adminAuth) =>
      request(httpServer(app)).patch(`${URL}/${id}`).set('Authorization', auth).send(body);

    it('update-1 改 pointsBelow → updatedByUserId 命中', async () => {
      const id = await seedRule({ pointsBelow: 1 });
      const res = await patch(id, { pointsBelow: 0.5 }, superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.pointsBelow).toBe(0.5);
      expect(res.body.data.updatedByUserId).toBe(superAdminUserId);
    });

    it('update-2 改 status ACTIVE → INACTIVE 不查重', async () => {
      const id = await seedRule({ durationThreshold: 1 });
      const res = await patch(id, { status: 'INACTIVE' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('INACTIVE');
    });

    it('update-3 改 status INACTIVE → ACTIVE 无冲突', async () => {
      const id = await seedRule({
        durationThreshold: 1,
        status: ContributionRuleStatus.INACTIVE,
      });
      const res = await patch(id, { status: 'ACTIVE' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('ACTIVE');
    });

    it('update-4 不同 threshold 的同 pair INACTIVE → ACTIVE 撞既有 ACTIVE → 23002', async () => {
      // 同 pair 不同 threshold:一条 ACTIVE,一条 INACTIVE。把 INACTIVE 激活 → 撞 pair 唯一。
      await seedRule({ durationThreshold: 1, status: ContributionRuleStatus.ACTIVE });
      const inactiveId = await seedRule({
        durationThreshold: 2,
        status: ContributionRuleStatus.INACTIVE,
      });
      const res = await patch(inactiveId, { status: 'ACTIVE' });
      expectBizError(res, BizCode.CONTRIBUTION_RULE_ACTIVE_DUPLICATE);
    });

    it('update-5 显式 pointsAbove: null', async () => {
      const id = await seedRule({ durationThreshold: 1, pointsAbove: 1.5 });
      const res = await patch(id, { pointsAbove: null });
      expect(res.status).toBe(200);
      expect(res.body.data.pointsAbove).toBeNull();
    });

    it('update-6 改 pointsBelow 派生与 pointsAbove 不一致 → 23010', async () => {
      // 既有规则:threshold=1, below=0.5, above=1.0;改 below=2.0 → below > above → 23010
      const id = await seedRule({ durationThreshold: 1, pointsBelow: 0.5, pointsAbove: 1.0 });
      const res = await patch(id, { pointsBelow: 2.0 });
      expectBizError(res, BizCode.CONTRIBUTION_RULE_POINTS_INVALID);
    });

    it('update-7 传 activityTypeCode → ValidationPipe 400(决议 E8 不开 23030)', async () => {
      const id = await seedRule({});
      const res = await patch(id, { activityTypeCode: ACTIVITY_TYPE_ACTIVE_2 });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('update-8 传 attendanceRoleCode → 400', async () => {
      const id = await seedRule({});
      const res = await patch(id, { attendanceRoleCode: ROLE_ACTIVE_2 });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('update-9 传 durationThreshold → 400', async () => {
      const id = await seedRule({});
      const res = await patch(id, { durationThreshold: 5 });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('update-10 不存在 → 23001', async () => {
      const res = await patch('cl0000000000000000000000', { pointsBelow: 1 });
      expectBizError(res, BizCode.CONTRIBUTION_RULE_NOT_FOUND);
    });
  });

  describe('D-RULE-1 PostgreSQL partial unique', () => {
    it('索引定义只含 type×role 且 direct DB 不允许不同 threshold 的第二条 ACTIVE', async () => {
      const indexes = await prisma.$queryRaw<Array<{ indexdef: string }>>`
        SELECT indexdef
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND indexname = 'contribution_rules_activity_role_active_unique'
      `;
      expect(indexes).toHaveLength(1);
      const indexdef = indexes[0].indexdef.replace(/\s+/g, ' ');
      expect(indexdef).toContain('UNIQUE INDEX');
      expect(indexdef).toContain('"activityTypeCode", "attendanceRoleCode"');
      expect(indexdef).not.toContain('"durationThreshold"');
      expect(indexdef).toContain('"deletedAt" IS NULL');
      expect(indexdef).toMatch(/status.*ACTIVE/);

      await seedRule({ durationThreshold: 1 });
      await expect(seedRule({ durationThreshold: 2 })).rejects.toMatchObject({ code: 'P2002' });
      await expect(
        prisma.contributionRule.count({
          where: {
            activityTypeCode: ACTIVITY_TYPE_ACTIVE,
            attendanceRoleCode: ROLE_ACTIVE,
            status: ContributionRuleStatus.ACTIVE,
            deletedAt: null,
          },
        }),
      ).resolves.toBe(1);
    });
  });

  // ============ delete(4) ============

  describe('DELETE /api/system/v1/contribution-rules/:id', () => {
    it('delete-1 命中 → 204;之后 GET 404;schema 含 deletedByUserId', async () => {
      const id = await seedRule({});
      const delRes = await request(httpServer(app))
        .delete(`${URL}/${id}`)
        .set('Authorization', superAdminAuth);
      expect(delRes.status).toBe(204);

      // 后续 GET 返 404
      const getRes = await request(httpServer(app))
        .get(`${URL}/${id}`)
        .set('Authorization', adminAuth);
      expectBizError(getRes, BizCode.CONTRIBUTION_RULE_NOT_FOUND);

      // schema 已含 deletedByUserId 字段(直接查 DB)
      const row = await prisma.contributionRule.findUnique({
        where: { id },
        select: { deletedAt: true, deletedByUserId: true },
      });
      expect(row?.deletedAt).not.toBeNull();
      expect(row?.deletedByUserId).toBe(superAdminUserId);
    });

    it('delete-2 已软删 → 23001', async () => {
      const id = await seedRule({ deletedAt: new Date() });
      const res = await request(httpServer(app))
        .delete(`${URL}/${id}`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.CONTRIBUTION_RULE_NOT_FOUND);
    });

    it('delete-3 不存在 → 23001', async () => {
      const res = await request(httpServer(app))
        .delete(`${URL}/cl0000000000000000000000`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.CONTRIBUTION_RULE_NOT_FOUND);
    });

    it('delete-4 软删后该维度可再次 create(deletedAt 过滤生效)', async () => {
      const id = await seedRule({ durationThreshold: 1 });
      await request(httpServer(app))
        .delete(`${URL}/${id}`)
        .set('Authorization', adminAuth)
        .expect(204);
      const res = await postCreate(createRule({ durationThreshold: 1 }));
      expect(res.status).toBe(201);
    });
  });

  // ============ perm(2) ============

  describe('权限边界', () => {
    it('perm-1 USER 调用 list / detail / POST / PATCH / DELETE 全部 → 30100 RBAC_FORBIDDEN', async () => {
      const id = await seedRule({});
      const listRes = await request(httpServer(app)).get(URL).set('Authorization', userAuth);
      expectBizError(listRes, BizCode.RBAC_FORBIDDEN);
      const detailRes = await request(httpServer(app))
        .get(`${URL}/${id}`)
        .set('Authorization', userAuth);
      expectBizError(detailRes, BizCode.RBAC_FORBIDDEN);
      const postRes = await postCreate(createRule({}), userAuth);
      expectBizError(postRes, BizCode.RBAC_FORBIDDEN);
      const patchRes = await request(httpServer(app))
        .patch(`${URL}/${id}`)
        .set('Authorization', userAuth)
        .send({ pointsBelow: 1 });
      expectBizError(patchRes, BizCode.RBAC_FORBIDDEN);
      const delRes = await request(httpServer(app))
        .delete(`${URL}/${id}`)
        .set('Authorization', userAuth);
      expectBizError(delRes, BizCode.RBAC_FORBIDDEN);
    });

    it('perm-2 未登录 → 40100', async () => {
      const listRes = await request(httpServer(app)).get(URL);
      expectBizError(listRes, BizCode.UNAUTHORIZED);
      const postRes = await request(httpServer(app)).post(URL).send(createRule({}));
      expectBizError(postRes, BizCode.UNAUTHORIZED);
    });

    // P0-F PR-2A:ADMIN 默认无 ops-admin → 30100(显式反向断言)
    it('perm-3 ADMIN 默认无 ops-admin 调用 list / POST → 30100 RBAC_FORBIDDEN', async () => {
      const listRes = await request(httpServer(app))
        .get(URL)
        .set('Authorization', adminDefaultAuth);
      expectBizError(listRes, BizCode.RBAC_FORBIDDEN);
      const postRes = await postCreate(createRule({}), adminDefaultAuth);
      expectBizError(postRes, BizCode.RBAC_FORBIDDEN);
    });

    // P0-F PR-2A:SUPER_ADMIN 短路验证(已在主成功路径多处隐含;此处补显式断言)
    it('perm-4 SUPER_ADMIN 短路通过(无需 ops-admin grant) → list 200', async () => {
      const listRes = await request(httpServer(app)).get(URL).set('Authorization', superAdminAuth);
      expect(listRes.status).toBe(200);
      expect(listRes.body.code).toBe(0);
    });
  });
});
