import type { INestApplication } from '@nestjs/common';
import { DictItemStatus, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// V2 第一阶段批次 3A activities 模块 e2e。
// 覆盖 7 接口主成功 + 关键失败:权限 / 字典 / 根节点 / 起止时间 / 状态机 /
// USER 角色过滤(Q-A7)/ cancelled 拒改(Q-A12)/ 软删 / 字段白名单。

describe('activities 模块', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAdminAuth: string;
  let adminAuth: string;
  let userAuth: string;

  let rootOrgId: string;
  let childOrgId: string;
  let activeActivityTypeCode: string;
  let inactiveActivityTypeCode: string;
  let activeGenderRequirementCode: string;
  let inactiveGenderRequirementCode: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    await createTestUser(app, { username: 'act-su', role: Role.SUPER_ADMIN });
    await createTestUser(app, { username: 'act-adm', role: Role.ADMIN });
    await createTestUser(app, { username: 'act-user', role: Role.USER });
    superAdminAuth = (await loginAs(app, 'act-su')).authHeader;
    adminAuth = (await loginAs(app, 'act-adm')).authHeader;
    userAuth = (await loginAs(app, 'act-user')).authHeader;

    // node_type 字典(Organization.nodeTypeCode 校验依赖)
    const nodeTypeDict = await prisma.dictType.create({
      data: { code: 'node_type', label: '节点类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeTypeDict.id, code: 'demo-root', label: '根' },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeTypeDict.id, code: 'demo-child', label: '子' },
    });

    // 组织节点:根 + 子节点(根节点 parentId=null,activity 禁挂)
    const rootOrg = await prisma.organization.create({
      data: { name: 'Demo Root', nodeTypeCode: 'demo-root', parentId: null },
      select: { id: true },
    });
    rootOrgId = rootOrg.id;
    const childOrg = await prisma.organization.create({
      data: { name: 'Demo Child', nodeTypeCode: 'demo-child', parentId: rootOrgId },
      select: { id: true },
    });
    childOrgId = childOrg.id;

    // activity_type 字典(active + inactive item)
    const actTypeDict = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    const actTypeActive = await prisma.dictItem.create({
      data: { typeId: actTypeDict.id, code: 'demo-rotation', label: '演示-轮值' },
      select: { code: true },
    });
    activeActivityTypeCode = actTypeActive.code;
    const actTypeInactive = await prisma.dictItem.create({
      data: {
        typeId: actTypeDict.id,
        code: 'demo-inactive',
        label: '已停用',
        status: DictItemStatus.INACTIVE,
      },
      select: { code: true },
    });
    inactiveActivityTypeCode = actTypeInactive.code;

    // gender_requirement 字典(seed 没有,e2e 手动建)
    const genderReqDict = await prisma.dictType.create({
      data: { code: 'gender_requirement', label: '性别要求' },
      select: { id: true },
    });
    const grActive = await prisma.dictItem.create({
      data: { typeId: genderReqDict.id, code: 'any', label: '不限' },
      select: { code: true },
    });
    activeGenderRequirementCode = grActive.code;
    const grInactive = await prisma.dictItem.create({
      data: {
        typeId: genderReqDict.id,
        code: 'gr-inactive',
        label: '已停用',
        status: DictItemStatus.INACTIVE,
      },
      select: { code: true },
    });
    inactiveGenderRequirementCode = grInactive.code;
  });

  afterAll(async () => {
    await app.close();
  });

  const baseCreatePayload = (override: Record<string, unknown> = {}): Record<string, unknown> => ({
    title: '梧桐山轮值演练',
    activityTypeCode: activeActivityTypeCode,
    organizationId: childOrgId,
    startAt: '2026-06-01T08:00:00.000Z',
    endAt: '2026-06-01T12:00:00.000Z',
    location: '梧桐山',
    ...override,
  });

  // ============ 权限边界 ============

  describe('权限边界', () => {
    it('未登录 GET list → 401', async () => {
      const res = await request(httpServer(app)).get('/api/v2/activities');
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('USER POST → 403', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', userAuth)
        .send(baseCreatePayload());
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('USER PATCH → 403', async () => {
      const res = await request(httpServer(app))
        .patch('/api/v2/activities/cl000000000000000000xxxx')
        .set('Authorization', userAuth)
        .send({ title: 'X' });
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('USER DELETE → 403', async () => {
      const res = await request(httpServer(app))
        .delete('/api/v2/activities/cl000000000000000000xxxx')
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('USER PATCH /publish → 403', async () => {
      const res = await request(httpServer(app))
        .patch('/api/v2/activities/cl000000000000000000xxxx/publish')
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('USER PATCH /cancel → 403', async () => {
      const res = await request(httpServer(app))
        .patch('/api/v2/activities/cl000000000000000000xxxx/cancel')
        .set('Authorization', userAuth)
        .send({});
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('USER GET list → 200(允许,Q-A7 同路由 + service Role 过滤)', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/activities')
        .set('Authorization', userAuth);
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
    });
  });

  // ============ POST 主路径 ============

  describe('POST 主路径', () => {
    it('ADMIN 创建仅必填 → 200,statusCode=draft / publishedBy=null / cancelledBy=null', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(baseCreatePayload());
      expect(res.status).toBe(201);
      expect(res.body.code).toBe(0);
      expect(res.body.data.statusCode).toBe('draft');
      expect(res.body.data.publishedBy).toBeNull();
      expect(res.body.data.publishedAt).toBeNull();
      expect(res.body.data.cancelledBy).toBeNull();
      expect(res.body.data.cancelledAt).toBeNull();
      expect(res.body.data.cancelReason).toBeNull();
      expect(res.body.data.isPublicRegistration).toBe(true); // Prisma default
      expect(res.body.data).not.toHaveProperty('deletedAt');
    });

    it('SUPER_ADMIN 完整字段 + 经纬度 → 200,Decimal 序列化为 string', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', superAdminAuth)
        .send(
          baseCreatePayload({
            title: '完整字段活动',
            description: '说明',
            capacity: 20,
            genderRequirementCode: activeGenderRequirementCode,
            registrationDeadline: '2026-05-30T23:59:59.000Z',
            registrationNotes: '请提前报名',
            isPublicRegistration: true,
            coverImageUrl: 'https://example.com/cover.jpg',
            galleryImageUrls: ['https://example.com/1.jpg', 'https://example.com/2.jpg'],
            content: { sections: ['intro', 'agenda'] },
            registrationSchema: { fields: [] },
            locationLongitude: 114.123456,
            locationLatitude: 22.654321,
          }),
        );
      expect(res.status).toBe(201);
      expect(res.body.data.capacity).toBe(20);
      expect(typeof res.body.data.locationLongitude).toBe('string');
      expect(typeof res.body.data.locationLatitude).toBe('string');
      expect(res.body.data.galleryImageUrls).toEqual([
        'https://example.com/1.jpg',
        'https://example.com/2.jpg',
      ]);
      expect(res.body.data.content).toEqual({ sections: ['intro', 'agenda'] });
    });

    it('根节点 organizationId → ACTIVITY_ORGANIZATION_ROOT_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ organizationId: rootOrgId }));
      expectBizError(res, BizCode.ACTIVITY_ORGANIZATION_ROOT_FORBIDDEN);
    });

    it('organizationId 不存在 → ORGANIZATION_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ organizationId: 'cl0000000000000000000000' }));
      expectBizError(res, BizCode.ORGANIZATION_NOT_FOUND);
    });

    it('activityTypeCode 不存在 → ACTIVITY_TYPE_CODE_INVALID', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ activityTypeCode: 'no-such-type' }));
      expectBizError(res, BizCode.ACTIVITY_TYPE_CODE_INVALID);
    });

    it('activityTypeCode INACTIVE → ACTIVITY_TYPE_CODE_INVALID', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ activityTypeCode: inactiveActivityTypeCode }));
      expectBizError(res, BizCode.ACTIVITY_TYPE_CODE_INVALID);
    });

    it('genderRequirementCode 不存在 → ACTIVITY_GENDER_REQUIREMENT_CODE_INVALID', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ genderRequirementCode: 'no-such-gr' }));
      expectBizError(res, BizCode.ACTIVITY_GENDER_REQUIREMENT_CODE_INVALID);
    });

    it('genderRequirementCode INACTIVE → ACTIVITY_GENDER_REQUIREMENT_CODE_INVALID', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ genderRequirementCode: inactiveGenderRequirementCode }));
      expectBizError(res, BizCode.ACTIVITY_GENDER_REQUIREMENT_CODE_INVALID);
    });

    it('startAt >= endAt → ACTIVITY_START_END_INVALID', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(
          baseCreatePayload({
            startAt: '2026-06-01T12:00:00.000Z',
            endAt: '2026-06-01T12:00:00.000Z',
          }),
        );
      expectBizError(res, BizCode.ACTIVITY_START_END_INVALID);
    });

    it('startAt > endAt → ACTIVITY_START_END_INVALID', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(
          baseCreatePayload({
            startAt: '2026-06-01T13:00:00.000Z',
            endAt: '2026-06-01T12:00:00.000Z',
          }),
        );
      expectBizError(res, BizCode.ACTIVITY_START_END_INVALID);
    });

    it('缺 title → 400', async () => {
      const payload = baseCreatePayload();
      delete payload.title;
      const res = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(payload);
      expect(res.status).toBe(400);
    });

    it('缺 organizationId → 400', async () => {
      const payload = baseCreatePayload();
      delete payload.organizationId;
      const res = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(payload);
      expect(res.status).toBe(400);
    });

    it('non-whitelisted statusCode → 400', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ statusCode: 'published' }));
      expect(res.status).toBe(400);
    });

    it('non-whitelisted publishedBy → 400', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ publishedBy: 'cl0000000000000000000000' }));
      expect(res.status).toBe(400);
    });

    it('non-whitelisted cancelledBy → 400', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ cancelledBy: 'cl0000000000000000000000' }));
      expect(res.status).toBe(400);
    });

    it('non-whitelisted cancelReason(应通过 /cancel 接口写入)→ 400', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ cancelReason: '禁止透传' }));
      expect(res.status).toBe(400);
    });

    it('capacity < 1 → 400', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ capacity: 0 }));
      expect(res.status).toBe(400);
    });

    it('locationLongitude 精度 > 7 位 → 400', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ locationLongitude: 114.12345678 }));
      expect(res.status).toBe(400);
    });

    it('Q-A13 extras 不在 Activity DTO 中,传入应被白名单拒绝 → 400', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ extras: { foo: 1 } }));
      expect(res.status).toBe(400);
    });

    it('Q-A13 registrationSchema 任意对象通过(@IsObject)', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ registrationSchema: { random: 'shape', arr: [1, 2] } }));
      expect(res.status).toBe(201);
      expect(res.body.data.registrationSchema).toEqual({ random: 'shape', arr: [1, 2] });
    });

    it('Q-A13 registrationSchema 非对象(string)→ 400', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ registrationSchema: 'plain string' }));
      expect(res.status).toBe(400);
    });
  });

  // ============ GET list + Role 过滤 ============

  describe('GET list + Q-A7 Role 过滤', () => {
    let draftId: string;
    let publishedId: string;
    let cancelledId: string;

    beforeAll(async () => {
      // 造一组状态:1 draft / 1 published / 1 cancelled
      const draft = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ title: 'LIST-DRAFT' }));
      draftId = draft.body.data.id;

      const pubCreate = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ title: 'LIST-PUB' }));
      publishedId = pubCreate.body.data.id;
      await request(httpServer(app))
        .patch(`/api/v2/activities/${publishedId}/publish`)
        .set('Authorization', adminAuth);

      const cancelCreate = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ title: 'LIST-CANCEL' }));
      cancelledId = cancelCreate.body.data.id;
      await request(httpServer(app))
        .patch(`/api/v2/activities/${cancelledId}/cancel`)
        .set('Authorization', adminAuth)
        .send({ cancelReason: '用于列表测试' });
    });

    it('ADMIN 列表见所有状态(含 draft / cancelled)', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/activities')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      const ids: string[] = (res.body.data.items as Array<{ id: string }>).map((i) => i.id);
      expect(ids).toEqual(expect.arrayContaining([draftId, publishedId, cancelledId]));
    });

    it('USER 列表只见 published / completed(Q-A7)', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/activities')
        .set('Authorization', userAuth);
      expect(res.status).toBe(200);
      const statuses = (res.body.data.items as Array<{ statusCode: string }>).map(
        (i) => i.statusCode,
      );
      for (const s of statuses) {
        expect(['published', 'completed']).toContain(s);
      }
    });

    it('USER 传 statusCode=draft 仍被 service 强制过滤(只见 published)', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/activities')
        .query({ statusCode: 'draft' })
        .set('Authorization', userAuth);
      expect(res.status).toBe(200);
      const statuses = (res.body.data.items as Array<{ statusCode: string }>).map(
        (i) => i.statusCode,
      );
      for (const s of statuses) {
        expect(['published', 'completed']).toContain(s);
      }
    });

    it('分页参数生效', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/activities')
        .query({ page: 1, pageSize: 2 })
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBeLessThanOrEqual(2);
      expect(res.body.data.page).toBe(1);
      expect(res.body.data.pageSize).toBe(2);
      expect(typeof res.body.data.total).toBe('number');
    });
  });

  // ============ GET detail + Role 过滤 ============

  describe('GET detail + Q-A7 Role 过滤', () => {
    let draftId: string;
    let publishedId: string;

    beforeAll(async () => {
      const d = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ title: 'DETAIL-DRAFT' }));
      draftId = d.body.data.id;

      const p = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ title: 'DETAIL-PUB' }));
      publishedId = p.body.data.id;
      await request(httpServer(app))
        .patch(`/api/v2/activities/${publishedId}/publish`)
        .set('Authorization', adminAuth);
    });

    it('ADMIN 详情:draft 可见', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/activities/${draftId}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.statusCode).toBe('draft');
    });

    it('USER 详情:draft → 404(避免存在性泄漏)', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/activities/${draftId}`)
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.ACTIVITY_NOT_FOUND);
    });

    it('USER 详情:published 可见', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/activities/${publishedId}`)
        .set('Authorization', userAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.statusCode).toBe('published');
    });

    it('不存在 id → ACTIVITY_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/activities/cl0000000000000000000000')
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ACTIVITY_NOT_FOUND);
    });
  });

  // ============ PATCH update ============

  describe('PATCH update', () => {
    let id: string;

    beforeAll(async () => {
      const r = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ title: 'UPDATE-TARGET' }));
      id = r.body.data.id;
    });

    it('部分更新 title / location → 200', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/activities/${id}`)
        .set('Authorization', adminAuth)
        .send({ title: '新标题', location: '新地点' });
      expect(res.status).toBe(200);
      expect(res.body.data.title).toBe('新标题');
      expect(res.body.data.location).toBe('新地点');
    });

    it('更新 startAt 但 endAt 不变 → 起止合并复校(失败 → 20015)', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/activities/${id}`)
        .set('Authorization', adminAuth)
        .send({ startAt: '2026-06-01T15:00:00.000Z' });
      expectBizError(res, BizCode.ACTIVITY_START_END_INVALID);
    });

    it('non-whitelisted statusCode → 400', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/activities/${id}`)
        .set('Authorization', adminAuth)
        .send({ statusCode: 'published' });
      expect(res.status).toBe(400);
    });

    it('non-whitelisted publishedAt → 400', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/activities/${id}`)
        .set('Authorization', adminAuth)
        .send({ publishedAt: new Date().toISOString() });
      expect(res.status).toBe(400);
    });

    it('non-whitelisted cancelReason(应走 cancel 接口)→ 400', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/activities/${id}`)
        .set('Authorization', adminAuth)
        .send({ cancelReason: '禁止透传' });
      expect(res.status).toBe(400);
    });

    it('activityTypeCode invalid → ACTIVITY_TYPE_CODE_INVALID', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/activities/${id}`)
        .set('Authorization', adminAuth)
        .send({ activityTypeCode: 'no-such' });
      expectBizError(res, BizCode.ACTIVITY_TYPE_CODE_INVALID);
    });

    it('改 organizationId 为根节点 → ACTIVITY_ORGANIZATION_ROOT_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/activities/${id}`)
        .set('Authorization', adminAuth)
        .send({ organizationId: rootOrgId });
      expectBizError(res, BizCode.ACTIVITY_ORGANIZATION_ROOT_FORBIDDEN);
    });

    it('不存在 id → ACTIVITY_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .patch('/api/v2/activities/cl0000000000000000000000')
        .set('Authorization', adminAuth)
        .send({ title: 'X' });
      expectBizError(res, BizCode.ACTIVITY_NOT_FOUND);
    });
  });

  // ============ PATCH /publish 状态机 ============

  describe('PATCH /publish', () => {
    let draftId: string;
    let alreadyPublishedId: string;
    let cancelledId: string;

    beforeAll(async () => {
      const d = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ title: 'PUB-DRAFT' }));
      draftId = d.body.data.id;

      const p = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ title: 'PUB-ALREADY' }));
      alreadyPublishedId = p.body.data.id;
      await request(httpServer(app))
        .patch(`/api/v2/activities/${alreadyPublishedId}/publish`)
        .set('Authorization', adminAuth);

      const c = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ title: 'PUB-CANCEL' }));
      cancelledId = c.body.data.id;
      await request(httpServer(app))
        .patch(`/api/v2/activities/${cancelledId}/cancel`)
        .set('Authorization', adminAuth)
        .send({});
    });

    it('draft → published 成功;写 publishedBy/At', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/activities/${draftId}/publish`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.statusCode).toBe('published');
      expect(res.body.data.publishedBy).toBeTruthy();
      expect(res.body.data.publishedAt).toBeTruthy();
    });

    it('再次 publish 已 published → ACTIVITY_STATUS_INVALID', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/activities/${alreadyPublishedId}/publish`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ACTIVITY_STATUS_INVALID);
    });

    it('publish cancelled → ACTIVITY_STATUS_INVALID(Q-A12 / 状态机)', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/activities/${cancelledId}/publish`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ACTIVITY_STATUS_INVALID);
    });

    it('不存在 id → ACTIVITY_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .patch('/api/v2/activities/cl0000000000000000000000/publish')
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ACTIVITY_NOT_FOUND);
    });
  });

  // ============ PATCH /cancel 状态机 ============

  describe('PATCH /cancel', () => {
    let draftId: string;
    let publishedId: string;
    let cancelledId: string;

    beforeAll(async () => {
      const d = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ title: 'CANCEL-DRAFT' }));
      draftId = d.body.data.id;

      const p = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ title: 'CANCEL-PUB' }));
      publishedId = p.body.data.id;
      await request(httpServer(app))
        .patch(`/api/v2/activities/${publishedId}/publish`)
        .set('Authorization', adminAuth);

      const c = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ title: 'CANCEL-CANCEL' }));
      cancelledId = c.body.data.id;
      await request(httpServer(app))
        .patch(`/api/v2/activities/${cancelledId}/cancel`)
        .set('Authorization', adminAuth)
        .send({});
    });

    it('draft → cancelled 成功;cancelReason 写入', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/activities/${draftId}/cancel`)
        .set('Authorization', adminAuth)
        .send({ cancelReason: '雨天延期' });
      expect(res.status).toBe(200);
      expect(res.body.data.statusCode).toBe('cancelled');
      expect(res.body.data.cancelReason).toBe('雨天延期');
      expect(res.body.data.cancelledBy).toBeTruthy();
      expect(res.body.data.cancelledAt).toBeTruthy();
    });

    it('published → cancelled 成功', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/activities/${publishedId}/cancel`)
        .set('Authorization', adminAuth)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.data.statusCode).toBe('cancelled');
      expect(res.body.data.cancelReason).toBeNull();
    });

    it('cancelled → cancelled 拒绝(Q-A12 防重复)', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/activities/${cancelledId}/cancel`)
        .set('Authorization', adminAuth)
        .send({});
      expectBizError(res, BizCode.ACTIVITY_STATUS_INVALID);
    });
  });

  // ============ Q-A12:cancelled Activity 拒改 ============

  describe('Q-A12 cancelled 拒改', () => {
    let cancelledId: string;

    beforeAll(async () => {
      const c = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ title: 'CANCEL-LOCK' }));
      cancelledId = c.body.data.id;
      await request(httpServer(app))
        .patch(`/api/v2/activities/${cancelledId}/cancel`)
        .set('Authorization', adminAuth)
        .send({});
    });

    it('PATCH update cancelled → ACTIVITY_STATUS_INVALID', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/activities/${cancelledId}`)
        .set('Authorization', adminAuth)
        .send({ title: '试图修改' });
      expectBizError(res, BizCode.ACTIVITY_STATUS_INVALID);
    });

    it('PATCH publish cancelled → ACTIVITY_STATUS_INVALID', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/activities/${cancelledId}/publish`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ACTIVITY_STATUS_INVALID);
    });

    it('DELETE cancelled → 200(D3:删除 ≠ 取消,软删允许)', async () => {
      const res = await request(httpServer(app))
        .delete(`/api/v2/activities/${cancelledId}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
    });
  });

  // ============ DELETE 软删 ============

  describe('DELETE 软删', () => {
    let id: string;

    beforeAll(async () => {
      const r = await request(httpServer(app))
        .post('/api/v2/activities')
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ title: 'DEL-TARGET' }));
      id = r.body.data.id;
    });

    it('软删 → 200 + DB.deletedAt 非空 + 列表过滤 + 详情 NOT_FOUND', async () => {
      const del = await request(httpServer(app))
        .delete(`/api/v2/activities/${id}`)
        .set('Authorization', adminAuth);
      expect(del.status).toBe(200);

      const dbRow = await prisma.activity.findUnique({ where: { id } });
      expect(dbRow?.deletedAt).not.toBeNull();

      const detail = await request(httpServer(app))
        .get(`/api/v2/activities/${id}`)
        .set('Authorization', adminAuth);
      expectBizError(detail, BizCode.ACTIVITY_NOT_FOUND);

      const list = await request(httpServer(app))
        .get('/api/v2/activities')
        .set('Authorization', adminAuth);
      const ids: string[] = (list.body.data.items as Array<{ id: string }>).map((i) => i.id);
      expect(ids).not.toContain(id);
    });

    it('再次 DELETE 已软删 → ACTIVITY_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .delete(`/api/v2/activities/${id}`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ACTIVITY_NOT_FOUND);
    });
  });

  // ============ IdParamDto 长度边界 ============

  describe('IdParamDto 校验', () => {
    it('短 id(< 8 字符)→ 400', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/activities/short')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(400);
    });
  });
});
