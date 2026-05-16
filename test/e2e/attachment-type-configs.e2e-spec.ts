import type { INestApplication } from '@nestjs/common';
import { AttachmentTypeConfigStatus, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// V2.x C-7 attachments 实施 PR #3(2026-05-15):AttachmentTypeConfig 模块 e2e。
// 沿 D7 v1.0 §4.2 / §16 决议表 + 用户 Step 1 拍板 Q1-Q7。
//
// 覆盖:
// - 权限边界(未登录 401 / USER 403 / ADMIN / SUPER_ADMIN allowed)
// - CRUD 主成功路径(GET list / GET detail / POST create / PATCH update / PATCH status / DELETE)
// - status 默认 ACTIVE(沿 Prisma schema default)
// - duplicate code 拦截(13021 ATTACHMENT_TYPE_CONFIG_CODE_ALREADY_EXISTS)
// - invalid code format 拦截(13023 INVALID_ATTACHMENT_TYPE_CONFIG_CODE_FORMAT;Service 层显式 regex)
// - 资源不存在 / 已软删统一返(13020 ATTACHMENT_TYPE_CONFIG_NOT_FOUND;沿 v1 §10 信息泄漏防御)
// - List 分页 + status filter + ownerTable filter
// - DTO 白名单(PATCH 拒绝 code / status / deletedAt / id)
// - 软删后行为(不出现在 list / code 不可复用 → 13021)
// - status 走独立端点(Q5 v1.0)
//
// 不覆盖(分散在其它 spec 文件):
// - mime / size config CRUD(详见 attachment-mime-configs.e2e-spec.ts / attachment-size-limit-configs.e2e-spec.ts)
// - attachments 主模块(详见 attachments.e2e-spec.ts)
// - RBAC 业务判权 rbac.can()(F4 v1.0:不接;沿 D7 v1.0)
// - audit_logs 集成(沿 PR #71 边界;本 PR 不动 AuditLogEvent union)
// - ATTACHMENT_TYPE_CONFIG_IN_USE 跨表引用约束(Q7 v1.0 暂不实装)
//
// 测试隔离:spec-local TRUNCATE `attachment_type_configs`
//   (沿 permissions PR #2 范式;reset-db.ts 已追加 4 张 attachment 表 TRUNCATE,spec-local 是否仍需保留由后续评估)

describe('attachment-type-configs 模块', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAdminAuth: string;
  let adminAuth: string;
  let userAuth: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    // spec-local TRUNCATE attachment_type_configs
    // (沿 permissions PR #2 范式;reset-db.ts 已追加 4 张 attachment 表 TRUNCATE,
    //  spec-local 是否仍需保留由后续评估)
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "attachment_type_configs" RESTART IDENTITY CASCADE',
    );

    await createTestUser(app, { username: 'atc-su', role: Role.SUPER_ADMIN });
    await createTestUser(app, { username: 'atc-adm', role: Role.ADMIN });
    await createTestUser(app, { username: 'atc-user', role: Role.USER });

    superAdminAuth = (await loginAs(app, 'atc-su')).authHeader;
    adminAuth = (await loginAs(app, 'atc-adm')).authHeader;
    userAuth = (await loginAs(app, 'atc-user')).authHeader;
  });

  afterAll(async () => {
    await app.close();
  });

  // 每个 describe 块前清空表,避免组间 code 撞库
  const truncate = async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "attachment_type_configs" RESTART IDENTITY CASCADE',
    );
  };

  // ============ 权限边界 ============

  describe('权限边界', () => {
    beforeAll(truncate);

    it('未登录 GET → 401', async () => {
      const res = await request(httpServer(app)).get('/api/v2/attachment-type-configs');
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('USER 角色 GET → 403', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachment-type-configs')
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('USER 角色 POST → 403', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-type-configs')
        .set('Authorization', userAuth)
        .send({
          code: 'pb-user-post',
          displayName: 'User PR-X (forbidden)',
          ownerTable: 'member',
        });
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('ADMIN GET → 200', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachment-type-configs')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
    });

    it('SUPER_ADMIN GET → 200', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachment-type-configs')
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
    });
  });

  // ============ POST create ============

  describe('POST create', () => {
    beforeAll(truncate);

    it('ADMIN create success → 201,返完整出参,status 默认 ACTIVE,不返 deletedAt', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-type-configs')
        .set('Authorization', adminAuth)
        .send({
          code: 'member',
          displayName: '队员证件照(身份证)',
          ownerTable: 'member',
          defaultMaxSizeBytes: 5_242_880,
          defaultMimeWhitelist: ['image/jpeg', 'image/png'],
        });
      expect(res.status).toBe(201);
      expect(res.body.code).toBe(0);
      expect(res.body.data.code).toBe('member');
      expect(res.body.data.displayName).toBe('队员证件照(身份证)');
      expect(res.body.data.ownerTable).toBe('member');
      expect(res.body.data.defaultMaxSizeBytes).toBe(5_242_880);
      expect(res.body.data.defaultMimeWhitelist).toEqual(['image/jpeg', 'image/png']);
      expect(res.body.data.status).toBe(AttachmentTypeConfigStatus.ACTIVE);
      expect(res.body.data).not.toHaveProperty('deletedAt'); // Q2 v1.0:不出参
    });

    it('SUPER_ADMIN create 仅必填 → 201,defaultMimeWhitelist 默认 []', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-type-configs')
        .set('Authorization', superAdminAuth)
        .send({
          code: 'certificate',
          displayName: '队员资质证件',
          ownerTable: 'certificate',
        });
      expect(res.status).toBe(201);
      expect(res.body.data.code).toBe('certificate');
      expect(res.body.data.defaultMaxSizeBytes).toBeNull(); // Q4 v1.0:可空
      expect(res.body.data.defaultMimeWhitelist).toEqual([]); // Q3 v1.0:未传默认 []
    });

    it('duplicate code → 13021', async () => {
      // 先建一条
      await request(httpServer(app))
        .post('/api/v2/attachment-type-configs')
        .set('Authorization', adminAuth)
        .send({ code: 'dup-test', displayName: 'first', ownerTable: 'member' });

      // 撞 code
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-type-configs')
        .set('Authorization', adminAuth)
        .send({ code: 'dup-test', displayName: 'second', ownerTable: 'member' });

      expectBizError(res, BizCode.ATTACHMENT_TYPE_CONFIG_CODE_ALREADY_EXISTS);
    });

    it.each([
      ['too_short', 'ab'], // 总长 < 3(沿正则 [a-z][a-z0-9-]{2,32} 总长 3-33)
      ['uppercase', 'Member'], // 大写
      ['leading_digit', '1member'], // 首字符数字
      ['underscore', 'member_x'], // 下划线(只允许 -)
      ['has_dot', 'member.x'], // 点(本表只允许 [a-z0-9-])
      ['too_long', 'a'.repeat(34)], // 总长 34 > 33(正则上界);沿 RbacRole.code 范式
    ])('invalid code = %s 形如 %s → 13023', async (_name, code) => {
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-type-configs')
        .set('Authorization', adminAuth)
        .send({ code, displayName: 'bad', ownerTable: 'member' });
      expectBizError(res, BizCode.INVALID_ATTACHMENT_TYPE_CONFIG_CODE_FORMAT);
    });

    it('empty code → 400(由 DTO @MinLength 走 ValidationPipe;message 透传字段细节)', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-type-configs')
        .set('Authorization', adminAuth)
        .send({ code: '', displayName: 'bad', ownerTable: 'member' });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('non-whitelisted body field(status / deletedAt / id)→ 400', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-type-configs')
        .set('Authorization', adminAuth)
        .send({
          code: 'wl-test',
          displayName: 'wl',
          ownerTable: 'member',
          status: AttachmentTypeConfigStatus.INACTIVE, // 不允许入参
        });
      // ValidationPipe forbidNonWhitelisted 拒绝;message 透传 "property status should not exist"
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('ownerTable 自由字符串(沿 Q6 v1.0)→ 接受任意合法字符串', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-type-configs')
        .set('Authorization', adminAuth)
        .send({
          code: 'free-table-test',
          displayName: 'Free table',
          ownerTable: 'training_material', // 未来业务表名
        });
      expect(res.status).toBe(201);
      expect(res.body.data.ownerTable).toBe('training_material');
    });
  });

  // ============ GET list ============

  describe('GET list', () => {
    beforeAll(async () => {
      await truncate();
      // 准备 3 条数据:2 ACTIVE / 1 INACTIVE(软删后)
      await prisma.attachmentTypeConfig.createMany({
        data: [
          { code: 'list-a', displayName: 'A', ownerTable: 'member', defaultMimeWhitelist: [] },
          { code: 'list-b', displayName: 'B', ownerTable: 'certificate', defaultMimeWhitelist: [] },
          {
            code: 'list-c',
            displayName: 'C',
            ownerTable: 'activity',
            defaultMimeWhitelist: [],
          },
        ],
      });
    });

    it('默认分页 → 返非软删的 3 条', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachment-type-configs')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(3);
      expect(res.body.data.items).toHaveLength(3);
      expect(res.body.data.page).toBe(1);
      expect(res.body.data.pageSize).toBe(20);
      // 默认排序 createdAt DESC
      const codes = res.body.data.items.map((i: { code: string }) => i.code);
      expect(codes).toContain('list-a');
      expect(codes).toContain('list-b');
      expect(codes).toContain('list-c');
    });

    it('status=ACTIVE filter → 3 条', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachment-type-configs?status=ACTIVE')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(3);
    });

    it('ownerTable=member filter → 1 条', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachment-type-configs?ownerTable=member')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items[0].code).toBe('list-a');
    });

    it('pageSize=2 → 仅 2 条', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachment-type-configs?pageSize=2')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(2);
      expect(res.body.data.total).toBe(3);
    });
  });

  // ============ GET detail ============

  describe('GET detail', () => {
    beforeAll(truncate);

    it('GET detail not found → 13020', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachment-type-configs/cl0000000000000000nonexist')
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ATTACHMENT_TYPE_CONFIG_NOT_FOUND);
    });

    it('GET detail success → 200,完整字段,不返 deletedAt', async () => {
      const created = await prisma.attachmentTypeConfig.create({
        data: {
          code: 'detail-test',
          displayName: 'Detail',
          ownerTable: 'member',
          defaultMimeWhitelist: ['image/png'],
        },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .get(`/api/v2/attachment-type-configs/${created.id}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.code).toBe('detail-test');
      expect(res.body.data.defaultMimeWhitelist).toEqual(['image/png']);
      expect(res.body.data).not.toHaveProperty('deletedAt');
    });
  });

  // ============ PATCH update ============

  describe('PATCH update', () => {
    let id: string;

    beforeAll(async () => {
      await truncate();
      const c = await prisma.attachmentTypeConfig.create({
        data: {
          code: 'upd-test',
          displayName: 'old',
          ownerTable: 'member',
          defaultMimeWhitelist: [],
        },
        select: { id: true },
      });
      id = c.id;
    });

    it('PATCH update success → 200,新值返回', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/attachment-type-configs/${id}`)
        .set('Authorization', adminAuth)
        .send({ displayName: 'new', description: 'new desc' });
      expect(res.status).toBe(200);
      expect(res.body.data.displayName).toBe('new');
      expect(res.body.data.description).toBe('new desc');
      expect(res.body.data.code).toBe('upd-test'); // code 未改
    });

    it('PATCH update not found → 13020', async () => {
      const res = await request(httpServer(app))
        .patch('/api/v2/attachment-type-configs/cl0000000000000000nonexist')
        .set('Authorization', adminAuth)
        .send({ displayName: 'x' });
      expectBizError(res, BizCode.ATTACHMENT_TYPE_CONFIG_NOT_FOUND);
    });

    it('PATCH non-whitelisted code → 400(forbidNonWhitelisted;Q1 v1.0)', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/attachment-type-configs/${id}`)
        .set('Authorization', adminAuth)
        .send({ code: 'new-code' });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('PATCH non-whitelisted status → 400(Q5 v1.0:走独立 status 端点)', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/attachment-type-configs/${id}`)
        .set('Authorization', adminAuth)
        .send({ status: AttachmentTypeConfigStatus.INACTIVE });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('PATCH non-whitelisted deletedAt / id → 400', async () => {
      const res1 = await request(httpServer(app))
        .patch(`/api/v2/attachment-type-configs/${id}`)
        .set('Authorization', adminAuth)
        .send({ deletedAt: new Date().toISOString() });
      expectBizError(res1, BizCode.BAD_REQUEST, { strictMessage: false });

      const res2 = await request(httpServer(app))
        .patch(`/api/v2/attachment-type-configs/${id}`)
        .set('Authorization', adminAuth)
        .send({ id: 'fake' });
      expectBizError(res2, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('PATCH defaultMaxSizeBytes = null → 显式清空(Q4 v1.0)', async () => {
      // 先设个值
      await prisma.attachmentTypeConfig.update({
        where: { id },
        data: { defaultMaxSizeBytes: 1000 },
      });
      // PATCH 显式 null
      const res = await request(httpServer(app))
        .patch(`/api/v2/attachment-type-configs/${id}`)
        .set('Authorization', adminAuth)
        .send({ defaultMaxSizeBytes: null });
      expect(res.status).toBe(200);
      expect(res.body.data.defaultMaxSizeBytes).toBeNull();
    });
  });

  // ============ PATCH /:id/status ============

  describe('PATCH /:id/status', () => {
    let id: string;

    beforeAll(async () => {
      await truncate();
      const c = await prisma.attachmentTypeConfig.create({
        data: {
          code: 'st-test',
          displayName: 'st',
          ownerTable: 'member',
          defaultMimeWhitelist: [],
        },
        select: { id: true },
      });
      id = c.id;
    });

    it('PATCH status INACTIVE → 200', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/attachment-type-configs/${id}/status`)
        .set('Authorization', adminAuth)
        .send({ status: AttachmentTypeConfigStatus.INACTIVE });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe(AttachmentTypeConfigStatus.INACTIVE);
    });

    it('PATCH status back to ACTIVE → 200', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/attachment-type-configs/${id}/status`)
        .set('Authorization', adminAuth)
        .send({ status: AttachmentTypeConfigStatus.ACTIVE });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe(AttachmentTypeConfigStatus.ACTIVE);
    });

    it('PATCH status not found → 13020', async () => {
      const res = await request(httpServer(app))
        .patch('/api/v2/attachment-type-configs/cl0000000000000000nonexist/status')
        .set('Authorization', adminAuth)
        .send({ status: AttachmentTypeConfigStatus.INACTIVE });
      expectBizError(res, BizCode.ATTACHMENT_TYPE_CONFIG_NOT_FOUND);
    });

    it('PATCH status 非法 enum 值 → 400', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/attachment-type-configs/${id}/status`)
        .set('Authorization', adminAuth)
        .send({ status: 'BAD_STATUS' });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });
  });

  // ============ DELETE softDelete ============

  describe('DELETE softDelete', () => {
    let id: string;

    beforeAll(async () => {
      await truncate();
      const c = await prisma.attachmentTypeConfig.create({
        data: {
          code: 'del-test',
          displayName: 'del',
          ownerTable: 'member',
          defaultMimeWhitelist: [],
        },
        select: { id: true },
      });
      id = c.id;
    });

    it('DELETE success → 200,返软删前快照', async () => {
      const res = await request(httpServer(app))
        .delete(`/api/v2/attachment-type-configs/${id}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.code).toBe('del-test');
      // 软删后 status 应已置 INACTIVE(沿 dictionaries 范式;但返回的是软删前快照,
      // 实际 DB 已置 INACTIVE — 详见下面 list 断言)
    });

    it('DELETE twice → 13020(沿 v1 §10 信息泄漏防御;不开 13024 DELETED)', async () => {
      const res = await request(httpServer(app))
        .delete(`/api/v2/attachment-type-configs/${id}`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ATTACHMENT_TYPE_CONFIG_NOT_FOUND);
    });

    it('soft-deleted 不出现在 list', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/attachment-type-configs')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      const codes = res.body.data.items.map((i: { code: string }) => i.code);
      expect(codes).not.toContain('del-test');
    });

    it('soft-deleted code 不可复用 → 13021(沿 §10 软删 unique 预检查铁律)', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-type-configs')
        .set('Authorization', adminAuth)
        .send({ code: 'del-test', displayName: 'reuse', ownerTable: 'member' });
      expectBizError(res, BizCode.ATTACHMENT_TYPE_CONFIG_CODE_ALREADY_EXISTS);
    });

    it('GET soft-deleted detail → 13020', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/attachment-type-configs/${id}`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ATTACHMENT_TYPE_CONFIG_NOT_FOUND);
    });

    it('PATCH soft-deleted → 13020', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/attachment-type-configs/${id}`)
        .set('Authorization', adminAuth)
        .send({ displayName: 'x' });
      expectBizError(res, BizCode.ATTACHMENT_TYPE_CONFIG_NOT_FOUND);
    });

    it('PATCH status soft-deleted → 13020', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/attachment-type-configs/${id}/status`)
        .set('Authorization', adminAuth)
        .send({ status: AttachmentTypeConfigStatus.ACTIVE });
      expectBizError(res, BizCode.ATTACHMENT_TYPE_CONFIG_NOT_FOUND);
    });
  });
});
