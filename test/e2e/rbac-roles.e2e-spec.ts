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

// V2.x C-6 RBAC 实施 PR #3:RbacRole 模块 e2e。
// 沿 D7 v1.1 §5.1 端点 5-9 + §12.1 + D4 v1.0 软删决议。
//
// 覆盖(沿任务 #9):
// - list(分页 / code 模糊过滤 / 排除已软删)
// - detail(含 permissions 数组结构 — 即使为空也返 [];不存在 30003 / 已软删 30005)
// - create(成功 / 重复 code / 非法 code 格式 / 含软删历史撞唯一)
// - patch(成功 / 不存在 30003 / 软删后再 PATCH 30003 / DTO 白名单拒 code)
// - soft delete(成功 / 不存在 30003 / 再删 30003 / 软删后从 list 消失)
// - 权限边界(未登录 / USER / ADMIN / SUPER_ADMIN)
//
// 不覆盖(超本 PR 范围):
// - 与 RolePermission 关联(detail.permissions 永远空数组;留 PR #4 实施时扩 e2e)
// - 与 UserRole 关联(留 PR #5)
// - RBAC 判权(rbac.can();留 PR #6)
// - audit_logs 集成(rbac.role.delete 等事件;留后续审计批次)

describe('rbac-roles 模块', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAdminAuth: string;
  let adminAuth: string;
  let userAuth: string;
  let opsAdminRoleId: string;
  let adminUserId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    await createTestUser(app, { username: 'role-su', role: Role.SUPER_ADMIN });
    const adm = await createTestUser(app, { username: 'role-adm', role: Role.ADMIN });
    adminUserId = adm.id;
    await createTestUser(app, { username: 'role-user', role: Role.USER });

    superAdminAuth = (await loginAs(app, 'role-su')).authHeader;
    adminAuth = (await loginAs(app, 'role-adm')).authHeader;
    userAuth = (await loginAs(app, 'role-user')).authHeader;

    // P0-F PR-1:resetDb 已清 RBAC 表;e2e 自行 seed 14 条 rbac.* + ops-admin。
    const seed = await seedRbacPermissionsAndOpsAdmin(app);
    opsAdminRoleId = seed.opsAdminRoleId;
  });

  afterAll(async () => {
    await app.close();
  });

  // ============ 权限边界 ============

  describe('权限边界', () => {
    it('未登录 GET → 401', async () => {
      const res = await request(httpServer(app)).get('/api/system/v1/roles');
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it.each([
      [
        'get_list',
        () => request(httpServer(app)).get('/api/system/v1/roles').set('Authorization', userAuth),
      ],
      [
        'get_detail',
        () =>
          request(httpServer(app))
            .get('/api/system/v1/roles/some-id-00000000000000000000')
            .set('Authorization', userAuth),
      ],
      [
        'post',
        () =>
          request(httpServer(app))
            .post('/api/system/v1/roles')
            .set('Authorization', userAuth)
            .send({ code: 'apd-chief', displayName: '部长' }),
      ],
      [
        'patch',
        () =>
          request(httpServer(app))
            .patch('/api/system/v1/roles/some-id-00000000000000000000')
            .set('Authorization', userAuth)
            .send({ displayName: 'x' }),
      ],
      [
        'delete',
        () =>
          request(httpServer(app))
            .delete('/api/system/v1/roles/some-id-00000000000000000000')
            .set('Authorization', userAuth),
      ],
    ])('USER 角色 %s → 30100 RBAC_FORBIDDEN', async (_name, mkReq) => {
      const res = await mkReq();
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    // P0-F PR-1(2026-05-18):v1 ADMIN 不再自动放行 RBAC 元接口,必须显式持 RBAC 角色。
    it('ADMIN 默认无 RBAC 权限 → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/roles')
        .set('Authorization', adminAuth)
        .send({ code: 'admin-no-rbac', displayName: 'admin 无权' });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    // P0-F PR-1:ADMIN 持 ops-admin 后能通过(seed 14 条 rbac.* 包含 rbac.role.create)。
    it('ADMIN 持 ops-admin 角色 → POST 201(RBAC 入口通过)', async () => {
      await grantOpsAdminToUser(app, adminUserId, opsAdminRoleId);
      try {
        const res = await request(httpServer(app))
          .post('/api/system/v1/roles')
          .set('Authorization', adminAuth)
          .send({ code: 'admin-with-ops-admin', displayName: 'ADMIN with ops-admin' });
        expect(res.status).toBe(201);
        expect(res.body.code).toBe(0);
        expect(res.body.data.code).toBe('admin-with-ops-admin');
      } finally {
        await revokeOpsAdminFromUser(app, adminUserId, opsAdminRoleId);
      }
    });
  });

  // ============ list ============

  describe('list /api/system/v1/roles', () => {
    beforeAll(async () => {
      // 先准备一些数据(混合活跃 + 软删)
      await prisma.rbacRole.createMany({
        data: [
          { code: 'apd-chief', displayName: 'APD 部长' },
          { code: 'apd-deputy', displayName: 'APD 副部长' },
          { code: 'eq-mgr', displayName: '装备管理员' },
          { code: 'softdel-role', displayName: '将被软删', deletedAt: new Date() },
        ],
      });
    });

    it('GET 列表 → 200,分页结构正确,排除已软删', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/roles')
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data.items).toBeInstanceOf(Array);
      expect(res.body.data.page).toBe(1);
      expect(res.body.data.pageSize).toBe(20);

      const codes: string[] = res.body.data.items.map((i: { code: string }) => i.code);
      // 已软删的 'softdel-role' 不应出现
      expect(codes).not.toContain('softdel-role');
      // 活跃的 3 个应出现
      expect(codes).toEqual(expect.arrayContaining(['apd-chief', 'apd-deputy', 'eq-mgr']));
    });

    it('GET +code 过滤 contains → 200', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/roles?code=apd')
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      const codes: string[] = res.body.data.items.map((i: { code: string }) => i.code);
      expect(codes).toEqual(expect.arrayContaining(['apd-chief', 'apd-deputy']));
      expect(codes).not.toContain('eq-mgr');
      expect(codes).not.toContain('softdel-role');
    });

    it('列表项不含 permissions 字段(仅 detail 返)', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/roles')
        .set('Authorization', superAdminAuth);
      for (const item of res.body.data.items) {
        expect(item).not.toHaveProperty('permissions');
        expect(item).not.toHaveProperty('deletedAt');
      }
    });
  });

  // ============ detail ============

  describe('detail GET /api/system/v1/roles/:id', () => {
    it('详情 → 200,含 permissions: [](RolePermission CRUD 未实施时永远空数组)', async () => {
      const created = await prisma.rbacRole.create({
        data: { code: 'detail-test', displayName: 'detail 测试' },
        select: { id: true },
      });

      const res = await request(httpServer(app))
        .get(`/api/system/v1/roles/${created.id}`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.code).toBe('detail-test');
      // 关键:permissions 字段必返,即使为空
      expect(res.body.data.permissions).toEqual([]);
      expect(Array.isArray(res.body.data.permissions)).toBe(true);
      expect(res.body.data).not.toHaveProperty('deletedAt');
    });

    it('详情 不存在 id → 30003', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/roles/nonexistent000000000000000000')
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.ROLE_NOT_FOUND);
    });

    it('详情 已软删 id → 30005 ROLE_DELETED(410 Gone)', async () => {
      const created = await prisma.rbacRole.create({
        data: { code: 'softdel-detail', displayName: 'x', deletedAt: new Date() },
        select: { id: true },
      });

      const res = await request(httpServer(app))
        .get(`/api/system/v1/roles/${created.id}`)
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.ROLE_DELETED);
      expect(res.status).toBe(410);
    });

    it('详情 带 permissions:RolePermission 实有数据时返填充数组(用 raw insert 模拟)', async () => {
      // 准备:1 个角色 + 1 个权限 + 1 条 RolePermission 关联(直接 prisma 插入)
      const role = await prisma.rbacRole.create({
        data: { code: 'detail-with-perms', displayName: 'x' },
        select: { id: true },
      });
      const perm = await prisma.permission.create({
        data: {
          code: 'detail.test.read',
          module: 'detail',
          action: 'test',
          resourceType: 'read',
        },
        select: { id: true },
      });
      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionId: perm.id },
      });

      const res = await request(httpServer(app))
        .get(`/api/system/v1/roles/${role.id}`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.permissions).toHaveLength(1);
      expect(res.body.data.permissions[0]).toMatchObject({
        code: 'detail.test.read',
        module: 'detail',
        action: 'test',
        resourceType: 'read',
      });
    });
  });

  // ============ create ============

  describe('create POST /api/system/v1/roles', () => {
    it('SUPER_ADMIN POST → 201,字段集严格', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/roles')
        .set('Authorization', superAdminAuth)
        .send({
          code: 'create-test',
          displayName: '创建测试',
          description: '描述',
        });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        code: 'create-test',
        displayName: '创建测试',
        description: '描述',
      });
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data).not.toHaveProperty('deletedAt');
      expect(res.body.data).not.toHaveProperty('permissions');
    });

    it('POST 不传 description → 201,description 为 null', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/roles')
        .set('Authorization', superAdminAuth)
        .send({ code: 'create-no-desc', displayName: 'x' });
      expect(res.status).toBe(201);
      expect(res.body.data.description).toBeNull();
    });

    it('POST 重复 code → 30004', async () => {
      await request(httpServer(app))
        .post('/api/system/v1/roles')
        .set('Authorization', superAdminAuth)
        .send({ code: 'dup-test', displayName: 'first' });
      const res = await request(httpServer(app))
        .post('/api/system/v1/roles')
        .set('Authorization', superAdminAuth)
        .send({ code: 'dup-test', displayName: 'second' });
      expectBizError(res, BizCode.ROLE_CODE_ALREADY_EXISTS);
    });

    it('POST 撞软删历史 code → 30004(沿 v1 §10 软删 code 不复用)', async () => {
      await prisma.rbacRole.create({
        data: {
          code: 'softdel-dup-code',
          displayName: 'old',
          deletedAt: new Date(),
        },
      });
      const res = await request(httpServer(app))
        .post('/api/system/v1/roles')
        .set('Authorization', superAdminAuth)
        .send({ code: 'softdel-dup-code', displayName: 'new' });
      expectBizError(res, BizCode.ROLE_CODE_ALREADY_EXISTS);
    });

    it.each([
      ['too_short', 'ab'], // 2 字符,小于 3
      ['too_long', 'a'.repeat(34)], // 34 字符,超过 33
      ['uppercase', 'APD-Chief'], // 大写
      ['leading_digit', '1-role'], // 首字符数字
      ['underscore', 'apd_chief'], // 下划线(只允许 -)
      ['leading_dot', '.apd'], // 点
      ['trailing_dash_too_long', 'apd----------------------------------'], // 太长(>33)
      ['leading_dash', '-apd'], // 首字符 -(必须 [a-z])
    ])('POST 非法 code %s = "%s" → 30009', async (_name, code) => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/roles')
        .set('Authorization', superAdminAuth)
        .send({ code, displayName: 'x' });
      expectBizError(res, BizCode.INVALID_ROLE_CODE_FORMAT);
    });

    it.each([
      ['simple', 'abc'],
      ['kebab', 'apd-chief-deputy'],
      ['with_digits', 'role-2024-q1'],
      ['min_length', 'a-z'],
      ['max_length_33', 'a' + '-'.repeat(31) + 'b'], // 33 字符
    ])('POST 合法 code %s = "%s" → 201', async (_name, code) => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/roles')
        .set('Authorization', superAdminAuth)
        .send({ code, displayName: 'x' });
      expect(res.status).toBe(201);
    });
  });

  // ============ patch ============

  describe('patch PATCH /api/system/v1/roles/:id', () => {
    it('PATCH displayName + description → 200,只改 2 字段', async () => {
      const created = await prisma.rbacRole.create({
        data: { code: 'patch-test', displayName: 'old', description: 'old desc' },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .patch(`/api/system/v1/roles/${created.id}`)
        .set('Authorization', superAdminAuth)
        .send({ displayName: 'new', description: 'new desc' });
      expect(res.status).toBe(200);
      expect(res.body.data.displayName).toBe('new');
      expect(res.body.data.description).toBe('new desc');
      expect(res.body.data.code).toBe('patch-test'); // code 不变
    });

    it('PATCH 不存在 id → 30003', async () => {
      const res = await request(httpServer(app))
        .patch('/api/system/v1/roles/nonexistent000000000000000000')
        .set('Authorization', superAdminAuth)
        .send({ displayName: 'x' });
      expectBizError(res, BizCode.ROLE_NOT_FOUND);
    });

    it('PATCH 已软删 id → 30003(沿 v1 §10 信息泄漏防御;不返 30005)', async () => {
      const created = await prisma.rbacRole.create({
        data: { code: 'patch-softdel', displayName: 'x', deletedAt: new Date() },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .patch(`/api/system/v1/roles/${created.id}`)
        .set('Authorization', superAdminAuth)
        .send({ displayName: 'try' });
      expectBizError(res, BizCode.ROLE_NOT_FOUND);
    });

    it.each(['code', 'id', 'createdAt', 'updatedAt', 'deletedAt'])(
      'PATCH 含 %s 字段 → 400(forbidNonWhitelisted)',
      async (field) => {
        const created = await prisma.rbacRole.create({
          data: { code: `pwl-${field.toLowerCase()}-r`, displayName: 'x' },
          select: { id: true },
        });
        const res = await request(httpServer(app))
          .patch(`/api/system/v1/roles/${created.id}`)
          .set('Authorization', superAdminAuth)
          .send({ [field]: 'try' });
        expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
      },
    );
  });

  // ============ soft delete ============

  describe('soft delete DELETE /api/system/v1/roles/:id', () => {
    it('DELETE → 200,软删(再 GET list 不见,GET detail 返 30005)', async () => {
      const created = await prisma.rbacRole.create({
        data: { code: 'softdel-flow', displayName: 'x' },
        select: { id: true, code: true },
      });

      // DELETE
      const delRes = await request(httpServer(app))
        .delete(`/api/system/v1/roles/${created.id}`)
        .set('Authorization', superAdminAuth);
      expect(delRes.status).toBe(200);
      expect(delRes.body.data.code).toBe(created.code);

      // DB 中 deletedAt 应已被设置
      const raw = await prisma.rbacRole.findUnique({
        where: { id: created.id },
        select: { deletedAt: true },
      });
      expect(raw?.deletedAt).not.toBeNull();

      // list 不再返回
      const listRes = await request(httpServer(app))
        .get('/api/system/v1/roles?code=softdel-flow')
        .set('Authorization', superAdminAuth);
      const codes: string[] = listRes.body.data.items.map((i: { code: string }) => i.code);
      expect(codes).not.toContain('softdel-flow');

      // detail 返 30005
      const detailRes = await request(httpServer(app))
        .get(`/api/system/v1/roles/${created.id}`)
        .set('Authorization', superAdminAuth);
      expectBizError(detailRes, BizCode.ROLE_DELETED);

      // 再 PATCH 返 30003(信息泄漏防御)
      const patchRes = await request(httpServer(app))
        .patch(`/api/system/v1/roles/${created.id}`)
        .set('Authorization', superAdminAuth)
        .send({ displayName: 'x' });
      expectBizError(patchRes, BizCode.ROLE_NOT_FOUND);

      // 再 DELETE 也返 30003
      const delAgain = await request(httpServer(app))
        .delete(`/api/system/v1/roles/${created.id}`)
        .set('Authorization', superAdminAuth);
      expectBizError(delAgain, BizCode.ROLE_NOT_FOUND);
    });

    it('DELETE 不存在 id → 30003', async () => {
      const res = await request(httpServer(app))
        .delete('/api/system/v1/roles/nonexistent000000000000000000')
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.ROLE_NOT_FOUND);
    });
  });
});
