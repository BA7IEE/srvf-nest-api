import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// V2.x C-7 attachments 实施 PR #5(2026-05-15):AttachmentSizeLimitConfig 模块 e2e。
// 沿 D7 v1.0 §4.4 + 用户 Step 1 拍板 Q1-Q8 + PR #3 / PR #4 e2e 范式。
//
// 覆盖:
// - 权限边界(未登录 401 / USER 403 / ADMIN / SUPER_ADMIN allowed)
// - CRUD 主成功路径(GET list / GET detail / POST create / PATCH update / DELETE;**无 status 端点**)
// - typeConfigId 不存在 / 已软删 → 13020(沿 Q5 PR #4 复用)
// - duplicate typeConfigId → 13027(P2002 + 预检查双层防护)
// - soft-deleted typeConfigId 仍 → 13027(Q3 v1.0 软删 unique 铁律)
// - maxSizeBytes 越界(< 1 / > 10 GiB)→ 400
// - 不同 type 各自可有 size limit(1:1 仅约束同一 type)
// - List 分页 + typeConfigId filter
// - 资源不存在 / 已软删统一返 13026
// - DTO 白名单(PATCH 拒绝 typeConfigId / deletedAt / id / maxSizeBytes=null;Q4 PR #4 + Q5 v1.0)
// - 出参嵌套 typeConfig 独立摘要 DTO(Q4 v1.0)
// - 软删后行为(不出现 list / 软删后 GET / PATCH → 13026)
//
// 不覆盖(超本 PR 范围):
// - attachments 主模块(留 PR #6+)
// - RBAC 业务判权 rbac.can()(F4 v1.0:不接)
// - audit_logs 集成
// - ATTACHMENT_SIZE_LIMIT_CONFIG_IN_USE 跨表引用约束(Q2 v1.0 暂不实装)
//
// 测试隔离:reset-db.ts 已含 attachment_size_limit_configs TRUNCATE(PR #4 已迁入)。

const MAX_SIZE_BYTES_HARD_LIMIT = 10_737_418_240; // 10 GiB(沿 PR #3 / DTO @Max)

describe('attachment-size-limit-configs 模块', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAdminAuth: string;
  let adminAuth: string;
  let userAuth: string;
  let typeConfigA: { id: string; code: string };
  let typeConfigB: { id: string; code: string };

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    await createTestUser(app, { username: 'aslc-su', role: Role.SUPER_ADMIN });
    await createTestUser(app, { username: 'aslc-adm', role: Role.ADMIN });
    await createTestUser(app, { username: 'aslc-user', role: Role.USER });

    superAdminAuth = (await loginAs(app, 'aslc-su')).authHeader;
    adminAuth = (await loginAs(app, 'aslc-adm')).authHeader;
    userAuth = (await loginAs(app, 'aslc-user')).authHeader;

    // 准备 2 个 type config 作为 FK 锚点
    typeConfigA = await prisma.attachmentTypeConfig.create({
      data: {
        code: 'member',
        displayName: '队员证件照',
        ownerTable: 'member',
        defaultMimeWhitelist: [],
      },
      select: { id: true, code: true },
    });
    typeConfigB = await prisma.attachmentTypeConfig.create({
      data: {
        code: 'certificate',
        displayName: '队员资质证件',
        ownerTable: 'certificate',
        defaultMimeWhitelist: [],
      },
      select: { id: true, code: true },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  // 每个 describe 块前清空 size limit 表(保留 type config fixtures)
  const truncateSizeLimits = async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "attachment_size_limit_configs" RESTART IDENTITY CASCADE',
    );
  };

  // ============ 权限边界 ============

  describe('权限边界', () => {
    beforeAll(truncateSizeLimits);

    it('未登录 GET → 401', async () => {
      const res = await request(httpServer(app)).get('/api/v2/attachment-size-limit-configs');
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('USER 角色 GET → 403', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachment-size-limit-configs')
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('USER 角色 POST → 403', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-size-limit-configs')
        .set('Authorization', userAuth)
        .send({ typeConfigId: typeConfigA.id, maxSizeBytes: 1024 });
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('ADMIN GET → 200', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachment-size-limit-configs')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
    });

    it('SUPER_ADMIN GET → 200', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachment-size-limit-configs')
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
    });
  });

  // ============ POST create ============

  describe('POST create', () => {
    beforeAll(truncateSizeLimits);

    it('ADMIN create success → 201,完整出参 + 嵌套 typeConfig 摘要 + 不返 deletedAt', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-size-limit-configs')
        .set('Authorization', adminAuth)
        .send({
          typeConfigId: typeConfigA.id,
          maxSizeBytes: 5_242_880,
          remark: '5 MiB upper bound',
        });
      expect(res.status).toBe(201);
      expect(res.body.code).toBe(0);
      expect(res.body.data.typeConfigId).toBe(typeConfigA.id);
      expect(res.body.data.maxSizeBytes).toBe(5_242_880);
      expect(res.body.data.remark).toBe('5 MiB upper bound');
      // Q4 v1.0:嵌套独立 typeConfig 摘要
      expect(res.body.data.typeConfig).toEqual({
        id: typeConfigA.id,
        code: 'member',
        displayName: '队员证件照',
      });
      expect(res.body.data).not.toHaveProperty('deletedAt');
      expect(res.body.data).not.toHaveProperty('status'); // 本表无 status 字段(Q1 v1.0)
    });

    it('SUPER_ADMIN create 仅必填 → 201', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-size-limit-configs')
        .set('Authorization', superAdminAuth)
        .send({ typeConfigId: typeConfigB.id, maxSizeBytes: 10_485_760 });
      expect(res.status).toBe(201);
      expect(res.body.data.maxSizeBytes).toBe(10_485_760);
      expect(res.body.data.remark).toBeNull();
    });

    it('typeConfigId 不存在 → 13020(Q5 PR #4 复用)', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-size-limit-configs')
        .set('Authorization', adminAuth)
        .send({ typeConfigId: 'cl0000000000000000nonexist', maxSizeBytes: 1024 });
      expectBizError(res, BizCode.ATTACHMENT_TYPE_CONFIG_NOT_FOUND);
    });

    it('typeConfigId 已软删 → 13020', async () => {
      const tcDeleted = await prisma.attachmentTypeConfig.create({
        data: {
          code: 'tc-deleted-aslc',
          displayName: 'Deleted',
          ownerTable: 'temp',
          defaultMimeWhitelist: [],
          deletedAt: new Date(),
        },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-size-limit-configs')
        .set('Authorization', adminAuth)
        .send({ typeConfigId: tcDeleted.id, maxSizeBytes: 1024 });
      expectBizError(res, BizCode.ATTACHMENT_TYPE_CONFIG_NOT_FOUND);
    });

    it('duplicate typeConfigId → 13027(1:1 UNIQUE)', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-size-limit-configs')
        .set('Authorization', adminAuth)
        .send({ typeConfigId: typeConfigA.id, maxSizeBytes: 999 });
      expectBizError(res, BizCode.ATTACHMENT_SIZE_LIMIT_CONFIG_ALREADY_EXISTS);
    });

    it('soft-deleted typeConfigId 仍 → 13027(Q3 v1.0:软删 unique 铁律)', async () => {
      // 先准备一条软删记录(直接 Prisma 写,绕过 service)
      const tcExtra = await prisma.attachmentTypeConfig.create({
        data: {
          code: 'tc-extra',
          displayName: 'Extra',
          ownerTable: 'extra',
          defaultMimeWhitelist: [],
        },
        select: { id: true },
      });
      await prisma.attachmentSizeLimitConfig.create({
        data: {
          typeConfigId: tcExtra.id,
          maxSizeBytes: 999,
          deletedAt: new Date(),
        },
      });
      // 此时尝试 create 同 typeConfigId 应仍撞 13027
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-size-limit-configs')
        .set('Authorization', adminAuth)
        .send({ typeConfigId: tcExtra.id, maxSizeBytes: 5_000 });
      expectBizError(res, BizCode.ATTACHMENT_SIZE_LIMIT_CONFIG_ALREADY_EXISTS);
    });

    it('maxSizeBytes < 1 → 400', async () => {
      const tcExtra2 = await prisma.attachmentTypeConfig.create({
        data: {
          code: 'tc-extra2',
          displayName: 'Extra2',
          ownerTable: 'extra2',
          defaultMimeWhitelist: [],
        },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-size-limit-configs')
        .set('Authorization', adminAuth)
        .send({ typeConfigId: tcExtra2.id, maxSizeBytes: 0 });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it(`maxSizeBytes > 10 GiB(${MAX_SIZE_BYTES_HARD_LIMIT}) → 400`, async () => {
      const tcExtra3 = await prisma.attachmentTypeConfig.create({
        data: {
          code: 'tc-extra3',
          displayName: 'Extra3',
          ownerTable: 'extra3',
          defaultMimeWhitelist: [],
        },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-size-limit-configs')
        .set('Authorization', adminAuth)
        .send({ typeConfigId: tcExtra3.id, maxSizeBytes: MAX_SIZE_BYTES_HARD_LIMIT + 1 });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('不同 type 各自可有 size limit(1:1 仅约束同一 type)', async () => {
      // typeConfigA / typeConfigB 已各自有 size limit(在前两个 case 创建)
      // 此处验证 listing 时两条共存
      const res = await request(httpServer(app))
        .get('/api/v2/attachment-size-limit-configs')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      const typeIds = res.body.data.items.map((i: { typeConfigId: string }) => i.typeConfigId);
      expect(typeIds).toContain(typeConfigA.id);
      expect(typeIds).toContain(typeConfigB.id);
    });

    it('non-whitelisted body field(deletedAt / id)→ 400', async () => {
      const tcExtra4 = await prisma.attachmentTypeConfig.create({
        data: {
          code: 'tc-extra4',
          displayName: 'Extra4',
          ownerTable: 'extra4',
          defaultMimeWhitelist: [],
        },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-size-limit-configs')
        .set('Authorization', adminAuth)
        .send({
          typeConfigId: tcExtra4.id,
          maxSizeBytes: 1024,
          deletedAt: new Date().toISOString(),
        });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });
  });

  // ============ GET list ============

  describe('GET list', () => {
    beforeAll(async () => {
      await truncateSizeLimits();
      await prisma.attachmentSizeLimitConfig.createMany({
        data: [
          { typeConfigId: typeConfigA.id, maxSizeBytes: 5_242_880 },
          { typeConfigId: typeConfigB.id, maxSizeBytes: 10_485_760 },
        ],
      });
    });

    it('默认分页 → 2 条 + 嵌套 typeConfig', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachment-size-limit-configs')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(2);
      expect(res.body.data.items).toHaveLength(2);
      expect(res.body.data.items[0].typeConfig).toHaveProperty('code');
      expect(res.body.data.items[0].typeConfig).toHaveProperty('displayName');
    });

    it('typeConfigId=A filter → 1 条', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/attachment-size-limit-configs?typeConfigId=${typeConfigA.id}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items[0].typeConfigId).toBe(typeConfigA.id);
    });

    it('pageSize=1 → 1 条', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachment-size-limit-configs?pageSize=1')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.total).toBe(2);
    });
  });

  // ============ GET detail ============

  describe('GET detail', () => {
    beforeAll(truncateSizeLimits);

    it('GET detail not found → 13026', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachment-size-limit-configs/cl0000000000000000nonexist')
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ATTACHMENT_SIZE_LIMIT_CONFIG_NOT_FOUND);
    });

    it('GET detail success → 200,完整字段 + 嵌套 typeConfig 摘要,不返 deletedAt', async () => {
      const created = await prisma.attachmentSizeLimitConfig.create({
        data: {
          typeConfigId: typeConfigA.id,
          maxSizeBytes: 5_242_880,
          remark: 'detail test',
        },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .get(`/api/v2/attachment-size-limit-configs/${created.id}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.maxSizeBytes).toBe(5_242_880);
      expect(res.body.data.remark).toBe('detail test');
      expect(res.body.data.typeConfig.code).toBe('member');
      expect(res.body.data).not.toHaveProperty('deletedAt');
      expect(res.body.data).not.toHaveProperty('status');
    });
  });

  // ============ PATCH update ============

  describe('PATCH update', () => {
    let id: string;

    beforeAll(async () => {
      await truncateSizeLimits();
      const c = await prisma.attachmentSizeLimitConfig.create({
        data: { typeConfigId: typeConfigA.id, maxSizeBytes: 5_242_880, remark: 'old' },
        select: { id: true },
      });
      id = c.id;
    });

    it('PATCH update maxSizeBytes success → 200', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/attachment-size-limit-configs/${id}`)
        .set('Authorization', adminAuth)
        .send({ maxSizeBytes: 10_485_760 });
      expect(res.status).toBe(200);
      expect(res.body.data.maxSizeBytes).toBe(10_485_760);
      expect(res.body.data.typeConfigId).toBe(typeConfigA.id); // typeConfigId 未改
    });

    it('PATCH update remark success → 200', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/attachment-size-limit-configs/${id}`)
        .set('Authorization', adminAuth)
        .send({ remark: 'new remark' });
      expect(res.status).toBe(200);
      expect(res.body.data.remark).toBe('new remark');
    });

    it('PATCH update not found → 13026', async () => {
      const res = await request(httpServer(app))
        .patch('/api/v2/attachment-size-limit-configs/cl0000000000000000nonexist')
        .set('Authorization', adminAuth)
        .send({ maxSizeBytes: 1024 });
      expectBizError(res, BizCode.ATTACHMENT_SIZE_LIMIT_CONFIG_NOT_FOUND);
    });

    it('PATCH non-whitelisted typeConfigId → 400(Q4 PR #4)', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/attachment-size-limit-configs/${id}`)
        .set('Authorization', adminAuth)
        .send({ typeConfigId: typeConfigB.id });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('PATCH non-whitelisted deletedAt / id → 400', async () => {
      const res1 = await request(httpServer(app))
        .patch(`/api/v2/attachment-size-limit-configs/${id}`)
        .set('Authorization', adminAuth)
        .send({ deletedAt: new Date().toISOString() });
      expectBizError(res1, BizCode.BAD_REQUEST, { strictMessage: false });

      const res2 = await request(httpServer(app))
        .patch(`/api/v2/attachment-size-limit-configs/${id}`)
        .set('Authorization', adminAuth)
        .send({ id: 'fake' });
      expectBizError(res2, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('PATCH non-whitelisted status → 400(本表无 status 字段;Q1 v1.0)', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/attachment-size-limit-configs/${id}`)
        .set('Authorization', adminAuth)
        .send({ status: 'INACTIVE' });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('PATCH maxSizeBytes = null → 400(Q5 v1.0:不允许 null;清除走 DELETE)', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/attachment-size-limit-configs/${id}`)
        .set('Authorization', adminAuth)
        .send({ maxSizeBytes: null });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('PATCH maxSizeBytes < 1 → 400', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/attachment-size-limit-configs/${id}`)
        .set('Authorization', adminAuth)
        .send({ maxSizeBytes: 0 });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });
  });

  // ============ DELETE softDelete ============

  describe('DELETE softDelete', () => {
    let id: string;

    beforeAll(async () => {
      await truncateSizeLimits();
      const c = await prisma.attachmentSizeLimitConfig.create({
        data: { typeConfigId: typeConfigA.id, maxSizeBytes: 5_242_880 },
        select: { id: true },
      });
      id = c.id;
    });

    it('DELETE success → 200', async () => {
      const res = await request(httpServer(app))
        .delete(`/api/v2/attachment-size-limit-configs/${id}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.maxSizeBytes).toBe(5_242_880);
    });

    it('DELETE twice → 13026', async () => {
      const res = await request(httpServer(app))
        .delete(`/api/v2/attachment-size-limit-configs/${id}`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ATTACHMENT_SIZE_LIMIT_CONFIG_NOT_FOUND);
    });

    it('soft-deleted 不出现在 list', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/attachment-size-limit-configs?typeConfigId=${typeConfigA.id}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      // typeConfigA 这条已软删,list 不应出现
      const ids = res.body.data.items.map((i: { id: string }) => i.id);
      expect(ids).not.toContain(id);
    });

    it('GET soft-deleted detail → 13026', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/attachment-size-limit-configs/${id}`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ATTACHMENT_SIZE_LIMIT_CONFIG_NOT_FOUND);
    });

    it('PATCH soft-deleted → 13026', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/attachment-size-limit-configs/${id}`)
        .set('Authorization', adminAuth)
        .send({ maxSizeBytes: 1024 });
      expectBizError(res, BizCode.ATTACHMENT_SIZE_LIMIT_CONFIG_NOT_FOUND);
    });
  });
});
