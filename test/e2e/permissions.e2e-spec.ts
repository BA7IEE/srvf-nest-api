import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import {
  grantOpsAdminToUser,
  revokeOpsAdminFromUser,
  seedRbacPermissionsAndOpsAdmin,
} from '../fixtures/rbac.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// V2.x C-6 RBAC 实施 PR #2:permissions 模块 e2e。
// 沿 D7 v1.1 §5.1 端点 1-4。
//
// 覆盖:
// - CRUD 主成功路径(GET list / POST create / PATCH update / DELETE)
// - 重复 code 拦截(30002 PERMISSION_CODE_ALREADY_EXISTS)
// - 非法 code 格式拦截(30008 INVALID_PERMISSION_CODE_FORMAT;Service 层显式 regex)
// - 资源不存在(30001 PERMISSION_NOT_FOUND;PATCH / DELETE 不存在的 id)
// - 权限边界(未登录 / USER 角色 / ADMIN 与 SUPER_ADMIN 都允许)
// - DTO 白名单(PATCH 拒绝 code / module / action / resourceType / id 等)
// - 物理删验证(D4 v1.0;DELETE 后 GET 返回 404)
//
// 不覆盖(超本 PR 范围):
// - RBAC 判权(rbac.can();留 PR #6)
// - 与 Role / RolePermission / UserRole 的关联(留 PR #3-#5)
// - audit_logs 集成(留 PR #6 或后续审计批次)

describe('permissions 模块', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAdminAuth: string;
  let adminAuth: string;
  let userAuth: string;
  let opsAdminRoleId: string;
  let adminUserId: string;

  beforeAll(async () => {
    app = await createTestApp();
    // resetDb 自 PR #3 起已包含 RBAC 4 表(roles / permissions / role_permissions / user_roles);
    // 不再需要 spec-local TRUNCATE workaround。
    await resetDb(app);
    prisma = app.get(PrismaService);

    await createTestUser(app, { username: 'perm-su', role: Role.SUPER_ADMIN });
    const adminUser = await createTestUser(app, { username: 'perm-adm', role: Role.ADMIN });
    adminUserId = adminUser.id;
    await createTestUser(app, { username: 'perm-user', role: Role.USER });

    superAdminAuth = (await loginAs(app, 'perm-su')).authHeader;
    adminAuth = (await loginAs(app, 'perm-adm')).authHeader;
    userAuth = (await loginAs(app, 'perm-user')).authHeader;

    // P0-F PR-1:resetDb 已清 RBAC 表;e2e 自行 seed 14 条 rbac.* + ops-admin。
    const seed = await seedRbacPermissionsAndOpsAdmin(app);
    opsAdminRoleId = seed.opsAdminRoleId;
  });

  afterAll(async () => {
    await app.close();
  });

  // ============ 权限边界 ============

  describe('权限边界', () => {
    it('未登录 GET /api/v2/permissions → 401', async () => {
      const res = await request(httpServer(app)).get('/api/v2/permissions');
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    // P0-F PR-1:前一 it 触发 rbac.can() 时会把 admin 的空权限集写进 RbacCacheService;
    // ADMIN 持 ops-admin 用例需先 invalidate 清掉(沿真实运行时:绑 ops-admin 后必须 reload)
    it('USER 角色 GET → 403', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/permissions')
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER 角色 POST → 403', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/permissions')
        .set('Authorization', userAuth)
        .send({
          code: 'attachment.upload.cert',
          module: 'attachment',
          action: 'upload',
          resourceType: 'cert',
        });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER 角色 PATCH → 403', async () => {
      const created = await prisma.permission.create({
        data: {
          code: 'pb.user.patch',
          module: 'pb',
          action: 'user',
          resourceType: 'patch',
        },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .patch(`/api/v2/permissions/${created.id}`)
        .set('Authorization', userAuth)
        .send({ description: 'try' });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER 角色 DELETE → 403', async () => {
      const created = await prisma.permission.create({
        data: {
          code: 'pb.user.delete',
          module: 'pb',
          action: 'user',
          resourceType: 'delete',
        },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .delete(`/api/v2/permissions/${created.id}`)
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    // P0-F PR-1(2026-05-18):入口已切到 RBAC `rbac.permission.*`;v1 ADMIN 系统级身份
    // 不再自动放行,必须显式持有 RBAC 角色(ops-admin 或自定角色)才能通过。
    it('ADMIN 默认无 RBAC 权限 → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/permissions')
        .set('Authorization', adminAuth)
        .send({
          code: 'pb.admin.create',
          module: 'pb',
          action: 'admin',
          resourceType: 'create',
        });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    // P0-F PR-1:ADMIN 持 ops-admin 后能通过(seed 14 条 rbac.* 全集含 rbac.permission.create)。
    // SUPER_ADMIN 短路在 CRUD 主成功路径已覆盖。
    it('ADMIN 持 ops-admin 角色 → POST 201(RBAC 入口通过)', async () => {
      await grantOpsAdminToUser(app, adminUserId, opsAdminRoleId);
      try {
        const res = await request(httpServer(app))
          .post('/api/v2/permissions')
          .set('Authorization', adminAuth)
          .send({
            code: 'pb.adm-ok.create',
            module: 'pb',
            action: 'adm-ok',
            resourceType: 'create',
          });
        expect(res.status).toBe(201);
        expect(res.body.code).toBe(0);
        expect(res.body.data.code).toBe('pb.adm-ok.create');
      } finally {
        await revokeOpsAdminFromUser(app, adminUserId, opsAdminRoleId);
      }
    });
  });

  // ============ CRUD 主成功路径 ============

  describe('CRUD 主成功路径', () => {
    it('SUPER_ADMIN POST → 201,字段集严格', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/permissions')
        .set('Authorization', superAdminAuth)
        .send({
          code: 'attachment.upload.cert',
          module: 'attachment',
          action: 'upload',
          resourceType: 'cert',
          description: '上传证件附件',
        });

      expect(res.status).toBe(201);
      expect(res.body.code).toBe(0);
      expect(res.body.data).toMatchObject({
        code: 'attachment.upload.cert',
        module: 'attachment',
        action: 'upload',
        resourceType: 'cert',
        description: '上传证件附件',
      });
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.createdAt).toBeDefined();
      expect(res.body.data.updatedAt).toBeDefined();
      // Permission 物理删,无 deletedAt 字段
      expect(res.body.data).not.toHaveProperty('deletedAt');
    });

    it('SUPER_ADMIN POST 不传 description → 201,description 为 null', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/permissions')
        .set('Authorization', superAdminAuth)
        .send({
          code: 'attachment.view.cert',
          module: 'attachment',
          action: 'view',
          resourceType: 'cert',
        });
      expect(res.status).toBe(201);
      expect(res.body.data.description).toBeNull();
    });

    it('GET 列表 → 200,分页结构正确', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/permissions')
        .set('Authorization', superAdminAuth);

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data.items).toBeInstanceOf(Array);
      expect(typeof res.body.data.total).toBe('number');
      expect(res.body.data.page).toBe(1);
      expect(res.body.data.pageSize).toBe(20);
    });

    it('GET 列表 + module 过滤 → 200,只返回该 module', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/permissions?module=attachment')
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBeGreaterThan(0);
      for (const item of res.body.data.items) {
        expect(item.module).toBe('attachment');
      }
    });

    it('GET 列表 + resourceType 过滤 → 200', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/permissions?resourceType=cert')
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      for (const item of res.body.data.items) {
        expect(item.resourceType).toBe('cert');
      }
    });

    it('PATCH description → 200,只改 description', async () => {
      const created = await prisma.permission.create({
        data: {
          code: 'pb.patch.desc',
          module: 'pb',
          action: 'patch',
          resourceType: 'desc',
          description: 'old',
        },
        select: { id: true, code: true, module: true },
      });
      const res = await request(httpServer(app))
        .patch(`/api/v2/permissions/${created.id}`)
        .set('Authorization', superAdminAuth)
        .send({ description: 'new desc' });
      expect(res.status).toBe(200);
      expect(res.body.data.description).toBe('new desc');
      expect(res.body.data.code).toBe(created.code); // code 不变
      expect(res.body.data.module).toBe(created.module);
    });

    it('DELETE → 200,物理删(再 PATCH 同 id 返回 30001)', async () => {
      const created = await prisma.permission.create({
        data: {
          code: 'pb.del.physical',
          module: 'pb',
          action: 'del',
          resourceType: 'physical',
        },
        select: { id: true },
      });

      const delRes = await request(httpServer(app))
        .delete(`/api/v2/permissions/${created.id}`)
        .set('Authorization', superAdminAuth);
      expect(delRes.status).toBe(200);
      expect(delRes.body.data.id).toBe(created.id);

      // 物理删验证:DB 中已查不到
      const stillThere = await prisma.permission.findUnique({ where: { id: created.id } });
      expect(stillThere).toBeNull();

      // 后续 PATCH 同 id → 30001
      const patchRes = await request(httpServer(app))
        .patch(`/api/v2/permissions/${created.id}`)
        .set('Authorization', superAdminAuth)
        .send({ description: 'try update deleted' });
      expectBizError(patchRes, BizCode.PERMISSION_NOT_FOUND);
    });
  });

  // ============ 重复 code(30002) ============

  describe('重复 code(30002 PERMISSION_CODE_ALREADY_EXISTS)', () => {
    it('POST 重复 code → 30002', async () => {
      await request(httpServer(app))
        .post('/api/v2/permissions')
        .set('Authorization', superAdminAuth)
        .send({
          code: 'dup.test.code',
          module: 'dup',
          action: 'test',
          resourceType: 'code',
        });

      const res = await request(httpServer(app))
        .post('/api/v2/permissions')
        .set('Authorization', superAdminAuth)
        .send({
          code: 'dup.test.code',
          module: 'dup',
          action: 'test',
          resourceType: 'code',
        });
      expectBizError(res, BizCode.PERMISSION_CODE_ALREADY_EXISTS);
    });
  });

  // ============ 非法 code 格式(30008) ============

  describe('非法 code 格式(30008 INVALID_PERMISSION_CODE_FORMAT)', () => {
    // v1.2 修订(C-7 attachments 实施 PR #1):正则 `{2}$` → `{2,3}$`,支持 3-4 段(scope 可选)。
    // - 4 段(`a.b.c.d` / `attachment.upload.cert.self` 等)现在是**合法**,从非法挪到合法
    // - **5 段**(`a.b.c.d.e` / `attachment.upload.cert.self.extra`)继续非法,作为新反例
    it.each([
      ['no_dots', 'nodots'], // 0 个点(1 段;`attachment` 等同)
      ['one_dot', 'a.b'], // 1 个点(2 段;`attachment.upload` 等同)
      ['five_dots', 'a.b.c.d.e'], // 5 段(超过 4 段;v1.2 上限)
      ['attachment_5_segments', 'attachment.upload.cert.self.extra'], // 5 段命中场景
      ['uppercase', 'A.B.C'], // 大写
      ['attachment_uppercase', 'Attachment.upload.cert'], // 大写场景
      ['leading_digit', '1a.b.c'], // 首字母数字
      ['underscore', 'a_b.c.d'], // 下划线(只允许 -)
      ['empty_segment_3seg', 'a..c'], // 3 段空段
      ['empty_segment_4seg', 'attachment..cert.self'], // 4 段中间空段
      ['empty_scope', 'attachment.upload..self'], // 4 段第三段空
      ['trailing_dot', 'a.b.c.'], // 末尾点
      ['leading_dot', '.a.b.c'], // 开头点
    ])('POST code = %s 形如 %s → 30008', async (_name, code) => {
      const res = await request(httpServer(app))
        .post('/api/v2/permissions')
        .set('Authorization', superAdminAuth)
        .send({
          code,
          module: 'm',
          action: 'a',
          resourceType: 'r',
        });
      expectBizError(res, BizCode.INVALID_PERMISSION_CODE_FORMAT);
    });

    it.each([
      ['simple_3seg', 'a.b.c'],
      ['with_dashes_3seg', 'attachment-mod.upload-action.cert-type'],
      ['with_digits_3seg', 'mod1.action2.type3'],
      // P0-F PR-1:rbac.* 14 条已在 seedRbacPermissionsAndOpsAdmin 落库,POST 撞 409;
      // 改用 spec.* 命名空间保留"3 段合法格式"语义,与 seed 不冲突。
      ['spec_3seg_read', 'spec.permission.read'],
      ['spec_3seg_create', 'spec.role.create'],
      // ===== v1.2 新增 4 段合法 case(attachment.* 4 段 scope 后缀) =====
      ['attachment_4seg_upload_self', 'attachment.upload.cert.self'],
      ['attachment_4seg_upload_other', 'attachment.upload.cert.other'],
      ['attachment_4seg_view_self', 'attachment.view.cert.self'],
      ['attachment_4seg_view_other', 'attachment.view.cert.other'],
    ])('POST code = %s 合法形如 %s → 201', async (_name, code) => {
      const res = await request(httpServer(app))
        .post('/api/v2/permissions')
        .set('Authorization', superAdminAuth)
        .send({
          code,
          module: 'm',
          action: 'a',
          resourceType: 'r',
        });
      expect(res.status).toBe(201);
      expect(res.body.data.code).toBe(code);
    });
  });

  // ============ 资源不存在(30001) ============

  describe('PATCH / DELETE 不存在 id → 30001', () => {
    it('PATCH 不存在 id → 30001', async () => {
      const res = await request(httpServer(app))
        .patch('/api/v2/permissions/nonexistent000000000000000000')
        .set('Authorization', superAdminAuth)
        .send({ description: 'x' });
      expectBizError(res, BizCode.PERMISSION_NOT_FOUND);
    });

    it('DELETE 不存在 id → 30001', async () => {
      const res = await request(httpServer(app))
        .delete('/api/v2/permissions/nonexistent000000000000000000')
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.PERMISSION_NOT_FOUND);
    });
  });

  // ============ DTO 白名单(纵深防御) ============

  describe('DTO 白名单(forbidNonWhitelisted)', () => {
    it('PATCH 含 code 字段 → 400(forbidNonWhitelisted 拦截)', async () => {
      const created = await prisma.permission.create({
        data: {
          code: 'wl.patch.code',
          module: 'wl',
          action: 'patch',
          resourceType: 'code',
        },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .patch(`/api/v2/permissions/${created.id}`)
        .set('Authorization', superAdminAuth)
        .send({ code: 'try.change.code' });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it.each(['module', 'action', 'resourceType', 'id', 'createdAt', 'updatedAt'])(
      'PATCH 含 %s 字段 → 400',
      async (field) => {
        const created = await prisma.permission.create({
          data: {
            code: `wl.field.${field.toLowerCase()}`.replace(/[^a-z0-9.-]/g, '-'),
            module: 'wl',
            action: 'field',
            resourceType: field.toLowerCase(),
          },
          select: { id: true },
        });
        const res = await request(httpServer(app))
          .patch(`/api/v2/permissions/${created.id}`)
          .set('Authorization', superAdminAuth)
          .send({ [field]: 'try' });
        expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
      },
    );
  });
});
