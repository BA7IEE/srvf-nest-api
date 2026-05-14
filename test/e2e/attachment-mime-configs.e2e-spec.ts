import type { INestApplication } from '@nestjs/common';
import { AttachmentMimeConfigStatus, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// V2.x C-7 attachments 实施 PR #4(2026-05-15):AttachmentMimeConfig 模块 e2e。
// 沿 D7 v1.0 §4.3 / §16 + 用户 Step 1 拍板 Q1-Q8 + PR #3 attachment-type-configs.e2e 范式。
//
// 覆盖:
// - 权限边界(未登录 401 / USER 403 / ADMIN / SUPER_ADMIN allowed)
// - CRUD 主成功路径(GET list / GET detail / POST create / PATCH update / PATCH status / DELETE)
// - status 默认 ACTIVE(沿 Prisma schema default)
// - typeConfigId 不存在 → 13020(Q5 v1.0:复用 type config 码)
// - duplicate (typeConfigId, mime) → 13024(P2002 + 预检查双层防护)
// - soft-deleted duplicate 仍 → 13024(Q8 v1.0:软删 unique 铁律)
// - invalid MIME → 13025(Service 层显式 regex;Q1 v1.0)
// - 同 type 下不同 mime / 不同 type 下同 mime 可共存
// - List 分页 + typeConfigId / status / mime filter
// - 资源不存在 / 已软删统一返 13022(沿 v1 §10 信息泄漏防御)
// - DTO 白名单(PATCH 拒绝 mime / typeConfigId / status / deletedAt / id;Q3 + Q4 + Q5 v1.0)
// - 出参嵌套 typeConfig: { id, code, displayName }(Q2 v1.0)
// - 软删后行为(不出现在 list)
// - status 走独立端点(Q5 v1.0)
//
// 不覆盖(超本 PR 范围):
// - size config CRUD(留 PR #5)
// - attachments 主模块(留 PR #6+)
// - RBAC 业务判权 rbac.can()(F4 v1.0:不接)
// - audit_logs 集成(沿 PR #71 边界)
// - ATTACHMENT_MIME_CONFIG_IN_USE 跨表引用约束(Q6 v1.0 暂不实装)
//
// 测试隔离:reset-db.ts 已迁入 4 张 attachment 表 TRUNCATE(Q7 v1.0;PR #3 spec-local 临时方案
// 同步迁出到公共 reset-db.ts;沿 permissions PR #2 / PR #3 公共基建迁移范式)。

describe('attachment-mime-configs 模块', () => {
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

    await createTestUser(app, { username: 'amc-su', role: Role.SUPER_ADMIN });
    await createTestUser(app, { username: 'amc-adm', role: Role.ADMIN });
    await createTestUser(app, { username: 'amc-user', role: Role.USER });

    superAdminAuth = (await loginAs(app, 'amc-su')).authHeader;
    adminAuth = (await loginAs(app, 'amc-adm')).authHeader;
    userAuth = (await loginAs(app, 'amc-user')).authHeader;

    // 准备 2 个 type config 作为 FK 锚点(沿 D7 v1.0 §4.2 ownerTable 范式)
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

  // 每个 describe 块前清空 mime config 表(保留 type config fixtures)
  const truncateMimeConfigs = async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "attachment_mime_configs" RESTART IDENTITY CASCADE',
    );
  };

  // ============ 权限边界 ============

  describe('权限边界', () => {
    beforeAll(truncateMimeConfigs);

    it('未登录 GET → 401', async () => {
      const res = await request(httpServer(app)).get('/api/v2/attachment-mime-configs');
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('USER 角色 GET → 403', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachment-mime-configs')
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('USER 角色 POST → 403', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-mime-configs')
        .set('Authorization', userAuth)
        .send({ typeConfigId: typeConfigA.id, mime: 'image/jpeg' });
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('ADMIN GET → 200', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachment-mime-configs')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
    });

    it('SUPER_ADMIN GET → 200', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachment-mime-configs')
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
    });
  });

  // ============ POST create ============

  describe('POST create', () => {
    beforeAll(truncateMimeConfigs);

    it('ADMIN create success → 201,完整出参 + 嵌套 typeConfig 摘要 + status 默认 ACTIVE + 不返 deletedAt', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-mime-configs')
        .set('Authorization', adminAuth)
        .send({
          typeConfigId: typeConfigA.id,
          mime: 'image/jpeg',
          remark: 'JPEG image',
        });
      expect(res.status).toBe(201);
      expect(res.body.code).toBe(0);
      expect(res.body.data.typeConfigId).toBe(typeConfigA.id);
      expect(res.body.data.mime).toBe('image/jpeg');
      expect(res.body.data.remark).toBe('JPEG image');
      expect(res.body.data.status).toBe(AttachmentMimeConfigStatus.ACTIVE);
      // Q2 v1.0:嵌套 typeConfig 摘要
      expect(res.body.data.typeConfig).toEqual({
        id: typeConfigA.id,
        code: 'member',
        displayName: '队员证件照',
      });
      expect(res.body.data).not.toHaveProperty('deletedAt');
    });

    it('SUPER_ADMIN create 仅必填 → 201', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-mime-configs')
        .set('Authorization', superAdminAuth)
        .send({ typeConfigId: typeConfigA.id, mime: 'image/png' });
      expect(res.status).toBe(201);
      expect(res.body.data.mime).toBe('image/png');
      expect(res.body.data.remark).toBeNull();
    });

    it('typeConfigId 不存在 → 13020(Q5 v1.0:复用 type config 码)', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-mime-configs')
        .set('Authorization', adminAuth)
        .send({ typeConfigId: 'cl0000000000000000nonexist', mime: 'image/heic' });
      expectBizError(res, BizCode.ATTACHMENT_TYPE_CONFIG_NOT_FOUND);
    });

    it('typeConfigId 已软删 → 13020', async () => {
      // 创建并软删一个 type config
      const tcDeleted = await prisma.attachmentTypeConfig.create({
        data: {
          code: 'tc-deleted',
          displayName: 'Deleted',
          ownerTable: 'temp',
          defaultMimeWhitelist: [],
          deletedAt: new Date(),
        },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-mime-configs')
        .set('Authorization', adminAuth)
        .send({ typeConfigId: tcDeleted.id, mime: 'image/heic' });
      expectBizError(res, BizCode.ATTACHMENT_TYPE_CONFIG_NOT_FOUND);
    });

    it('duplicate (typeConfigId, mime) → 13024', async () => {
      await request(httpServer(app))
        .post('/api/v2/attachment-mime-configs')
        .set('Authorization', adminAuth)
        .send({ typeConfigId: typeConfigA.id, mime: 'application/pdf' });

      const res = await request(httpServer(app))
        .post('/api/v2/attachment-mime-configs')
        .set('Authorization', adminAuth)
        .send({ typeConfigId: typeConfigA.id, mime: 'application/pdf' });
      expectBizError(res, BizCode.ATTACHMENT_MIME_CONFIG_DUPLICATE);
    });

    it('soft-deleted (typeConfigId, mime) 仍 → 13024(Q8 v1.0:软删 unique 铁律)', async () => {
      // 准备一条软删记录
      await prisma.attachmentMimeConfig.create({
        data: {
          typeConfigId: typeConfigA.id,
          mime: 'image/webp',
          deletedAt: new Date(),
          status: AttachmentMimeConfigStatus.INACTIVE,
        },
      });
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-mime-configs')
        .set('Authorization', adminAuth)
        .send({ typeConfigId: typeConfigA.id, mime: 'image/webp' });
      expectBizError(res, BizCode.ATTACHMENT_MIME_CONFIG_DUPLICATE);
    });

    it.each([
      ['no_slash', 'imagejpeg'], // 无斜杠
      ['empty_type', '/jpeg'], // 主类型空
      ['empty_subtype', 'image/'], // 子类型空
      ['uppercase', 'Image/JPEG'], // 大写
      ['leading_digit', '1image/jpeg'], // 主类型首字符数字
      ['invalid_chars', 'image/jpeg?q=1'], // 子类型含非法字符
      ['multi_slash', 'image/jpeg/x'], // 多斜杠
    ])('invalid MIME = %s 形如 %s → 13025', async (_name, mime) => {
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-mime-configs')
        .set('Authorization', adminAuth)
        .send({ typeConfigId: typeConfigA.id, mime });
      expectBizError(res, BizCode.INVALID_ATTACHMENT_MIME_FORMAT);
    });

    it.each([
      ['standard_image', 'image/heic'],
      ['standard_pdf', 'application/pdf'],
      ['standard_docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['wildcard_image', 'image/*'],
      ['wildcard_video', 'video/*'],
    ])('合法 MIME = %s 形如 %s → 201(Q1 v1.0:允许 wildcard)', async (_name, mime) => {
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-mime-configs')
        .set('Authorization', adminAuth)
        .send({ typeConfigId: typeConfigB.id, mime });
      expect(res.status).toBe(201);
      expect(res.body.data.mime).toBe(mime);
    });

    it('同 type 下不同 mime 可共存', async () => {
      // typeConfigA + image/jpeg 已在第一个 case 创建
      // 此处 create image/svg+xml 应成功
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-mime-configs')
        .set('Authorization', adminAuth)
        .send({ typeConfigId: typeConfigA.id, mime: 'image/svg+xml' });
      expect(res.status).toBe(201);
    });

    it('不同 type 下同 mime 可共存', async () => {
      // typeConfigA + image/jpeg 已在第一个 case 创建
      // typeConfigB + image/jpeg 此处应成功
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-mime-configs')
        .set('Authorization', adminAuth)
        .send({ typeConfigId: typeConfigB.id, mime: 'image/jpeg' });
      expect(res.status).toBe(201);
    });

    it('non-whitelisted body field(status / deletedAt / id)→ 400', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-mime-configs')
        .set('Authorization', adminAuth)
        .send({
          typeConfigId: typeConfigB.id,
          mime: 'image/gif',
          status: AttachmentMimeConfigStatus.INACTIVE, // 不允许入参
        });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });
  });

  // ============ GET list ============

  describe('GET list', () => {
    beforeAll(async () => {
      await truncateMimeConfigs();
      // 准备:typeConfigA × 3 / typeConfigB × 2
      await prisma.attachmentMimeConfig.createMany({
        data: [
          { typeConfigId: typeConfigA.id, mime: 'image/jpeg' },
          { typeConfigId: typeConfigA.id, mime: 'image/png' },
          { typeConfigId: typeConfigA.id, mime: 'image/heic' },
          { typeConfigId: typeConfigB.id, mime: 'application/pdf' },
          { typeConfigId: typeConfigB.id, mime: 'image/png' },
        ],
      });
    });

    it('默认分页 → 5 条', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachment-mime-configs')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(5);
      expect(res.body.data.items).toHaveLength(5);
      // 每条出参带 typeConfig 摘要(Q2)
      expect(res.body.data.items[0].typeConfig).toHaveProperty('code');
      expect(res.body.data.items[0].typeConfig).toHaveProperty('displayName');
    });

    it('typeConfigId=A filter → 3 条', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/attachment-mime-configs?typeConfigId=${typeConfigA.id}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(3);
    });

    it('status=ACTIVE filter → 5 条', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachment-mime-configs?status=ACTIVE')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(5);
    });

    it('mime=image/png filter → 2 条(A+B 各 1)', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachment-mime-configs?mime=image%2Fpng')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(2);
    });

    it('pageSize=2 → 2 条', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachment-mime-configs?pageSize=2')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(2);
      expect(res.body.data.total).toBe(5);
    });
  });

  // ============ GET detail ============

  describe('GET detail', () => {
    beforeAll(truncateMimeConfigs);

    it('GET detail not found → 13022', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachment-mime-configs/cl0000000000000000nonexist')
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ATTACHMENT_MIME_CONFIG_NOT_FOUND);
    });

    it('GET detail success → 200,完整字段 + 嵌套 typeConfig 摘要,不返 deletedAt', async () => {
      const created = await prisma.attachmentMimeConfig.create({
        data: {
          typeConfigId: typeConfigA.id,
          mime: 'image/jpeg',
          remark: 'detail test',
        },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .get(`/api/v2/attachment-mime-configs/${created.id}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.mime).toBe('image/jpeg');
      expect(res.body.data.remark).toBe('detail test');
      expect(res.body.data.typeConfig.code).toBe('member');
      expect(res.body.data).not.toHaveProperty('deletedAt');
    });
  });

  // ============ PATCH update ============

  describe('PATCH update', () => {
    let id: string;

    beforeAll(async () => {
      await truncateMimeConfigs();
      const c = await prisma.attachmentMimeConfig.create({
        data: { typeConfigId: typeConfigA.id, mime: 'image/jpeg', remark: 'old' },
        select: { id: true },
      });
      id = c.id;
    });

    it('PATCH update success → 200,只改 remark', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/attachment-mime-configs/${id}`)
        .set('Authorization', adminAuth)
        .send({ remark: 'new remark' });
      expect(res.status).toBe(200);
      expect(res.body.data.remark).toBe('new remark');
      expect(res.body.data.mime).toBe('image/jpeg'); // mime 未改
      expect(res.body.data.typeConfigId).toBe(typeConfigA.id); // typeConfigId 未改
    });

    it('PATCH update not found → 13022', async () => {
      const res = await request(httpServer(app))
        .patch('/api/v2/attachment-mime-configs/cl0000000000000000nonexist')
        .set('Authorization', adminAuth)
        .send({ remark: 'x' });
      expectBizError(res, BizCode.ATTACHMENT_MIME_CONFIG_NOT_FOUND);
    });

    it('PATCH non-whitelisted mime → 400(Q3 v1.0)', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/attachment-mime-configs/${id}`)
        .set('Authorization', adminAuth)
        .send({ mime: 'application/pdf' });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('PATCH non-whitelisted typeConfigId → 400(Q4 v1.0)', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/attachment-mime-configs/${id}`)
        .set('Authorization', adminAuth)
        .send({ typeConfigId: typeConfigB.id });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('PATCH non-whitelisted status → 400(Q5 v1.0:走独立 status 端点)', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/attachment-mime-configs/${id}`)
        .set('Authorization', adminAuth)
        .send({ status: AttachmentMimeConfigStatus.INACTIVE });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('PATCH non-whitelisted deletedAt / id → 400', async () => {
      const res1 = await request(httpServer(app))
        .patch(`/api/v2/attachment-mime-configs/${id}`)
        .set('Authorization', adminAuth)
        .send({ deletedAt: new Date().toISOString() });
      expectBizError(res1, BizCode.BAD_REQUEST, { strictMessage: false });

      const res2 = await request(httpServer(app))
        .patch(`/api/v2/attachment-mime-configs/${id}`)
        .set('Authorization', adminAuth)
        .send({ id: 'fake' });
      expectBizError(res2, BizCode.BAD_REQUEST, { strictMessage: false });
    });
  });

  // ============ PATCH /:id/status ============

  describe('PATCH /:id/status', () => {
    let id: string;

    beforeAll(async () => {
      await truncateMimeConfigs();
      const c = await prisma.attachmentMimeConfig.create({
        data: { typeConfigId: typeConfigA.id, mime: 'image/jpeg' },
        select: { id: true },
      });
      id = c.id;
    });

    it('PATCH status INACTIVE → 200', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/attachment-mime-configs/${id}/status`)
        .set('Authorization', adminAuth)
        .send({ status: AttachmentMimeConfigStatus.INACTIVE });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe(AttachmentMimeConfigStatus.INACTIVE);
    });

    it('PATCH status back to ACTIVE → 200', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/attachment-mime-configs/${id}/status`)
        .set('Authorization', adminAuth)
        .send({ status: AttachmentMimeConfigStatus.ACTIVE });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe(AttachmentMimeConfigStatus.ACTIVE);
    });

    it('PATCH status not found → 13022', async () => {
      const res = await request(httpServer(app))
        .patch('/api/v2/attachment-mime-configs/cl0000000000000000nonexist/status')
        .set('Authorization', adminAuth)
        .send({ status: AttachmentMimeConfigStatus.INACTIVE });
      expectBizError(res, BizCode.ATTACHMENT_MIME_CONFIG_NOT_FOUND);
    });

    it('PATCH status 非法 enum 值 → 400', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/attachment-mime-configs/${id}/status`)
        .set('Authorization', adminAuth)
        .send({ status: 'BAD_STATUS' });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });
  });

  // ============ DELETE softDelete ============

  describe('DELETE softDelete', () => {
    let id: string;

    beforeAll(async () => {
      await truncateMimeConfigs();
      const c = await prisma.attachmentMimeConfig.create({
        data: { typeConfigId: typeConfigA.id, mime: 'application/pdf' },
        select: { id: true },
      });
      id = c.id;
    });

    it('DELETE success → 200', async () => {
      const res = await request(httpServer(app))
        .delete(`/api/v2/attachment-mime-configs/${id}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.mime).toBe('application/pdf');
    });

    it('DELETE twice → 13022', async () => {
      const res = await request(httpServer(app))
        .delete(`/api/v2/attachment-mime-configs/${id}`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ATTACHMENT_MIME_CONFIG_NOT_FOUND);
    });

    it('soft-deleted 不出现在 list', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/attachment-mime-configs?typeConfigId=${typeConfigA.id}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      const mimes = res.body.data.items.map((i: { mime: string }) => i.mime);
      expect(mimes).not.toContain('application/pdf');
    });

    it('GET soft-deleted detail → 13022', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/attachment-mime-configs/${id}`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ATTACHMENT_MIME_CONFIG_NOT_FOUND);
    });

    it('PATCH soft-deleted → 13022', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/attachment-mime-configs/${id}`)
        .set('Authorization', adminAuth)
        .send({ remark: 'x' });
      expectBizError(res, BizCode.ATTACHMENT_MIME_CONFIG_NOT_FOUND);
    });

    it('PATCH status soft-deleted → 13022', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/attachment-mime-configs/${id}/status`)
        .set('Authorization', adminAuth)
        .send({ status: AttachmentMimeConfigStatus.ACTIVE });
      expectBizError(res, BizCode.ATTACHMENT_MIME_CONFIG_NOT_FOUND);
    });
  });
});
