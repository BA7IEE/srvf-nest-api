import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { RbacCacheService } from '../../src/modules/permissions/rbac-cache.service';
import { loginAs } from '../fixtures/auth.fixture';
import { seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// V2.x C-6 RBAC 实施 PR #5:UserRole CRUD + Q7 角色分级 + ops-admin 保护 e2e。
// 沿 D7 v1.1 §5.1 端点 12-14 + §6.2 Q7 C2 中庸 + §6.3 + §9.4 + 用户拍板。
//
// 覆盖(沿任务 #9):
// - GET 查用户角色 / 分配角色 / 重复分配 30006 / 撤销角色 / 撤销不存在 30007
// - user 不存在 / disabled / softdel 全 10001(沿 v1 §10 信息泄漏防御)
// - role 不存在 / 已软删(POST 30003 / DELETE 30003 + 30005)
// - Q7 C2 中庸:SUPER_ADMIN 通过 / ADMIN 单独 30102 / ADMIN+持 ops-admin 通过 /
//   ops-admin 自己不能被 ops-admin 分配 / 业务角色互不分配
// - 最后一个 ops-admin 保护(30101)
// - 缓存失效:invalidateUser(targetUserId)
// - 权限边界(USER 入口 403)

describe('user-roles 模块 + Q7 角色分级 + ops-admin 保护', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cache: RbacCacheService;
  let superAdminAuth: string;
  let adminAuth: string;
  let userAuth: string;
  let opsAdminRoleId: string;
  let bizRoleId: string;

  // 测试用户 id 收集(用于 e2e 内部反复使用)
  let superAdminId: string;
  let adminId: string;
  let userId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    cache = app.get(RbacCacheService);

    const su = await createTestUser(app, { username: 'ur-su', role: Role.SUPER_ADMIN });
    const adm = await createTestUser(app, { username: 'ur-adm', role: Role.ADMIN });
    const us = await createTestUser(app, { username: 'ur-user', role: Role.USER });
    superAdminId = su.id;
    adminId = adm.id;
    userId = us.id;

    superAdminAuth = (await loginAs(app, 'ur-su')).authHeader;
    adminAuth = (await loginAs(app, 'ur-adm')).authHeader;
    userAuth = (await loginAs(app, 'ur-user')).authHeader;

    // P0-F PR-1(2026-05-18):resetDb 把 permissions 表清空;e2e 自行 seed
    //   14 条 rbac.* + ops-admin 全量绑定(沿 test/fixtures/rbac.fixture.ts)。
    //   后续 Q7 用例临时给 ADMIN 配 ops-admin 时才能通过 rbac.user-role.* 入口判权。
    const seed = await seedRbacPermissionsAndOpsAdmin(app);
    opsAdminRoleId = seed.opsAdminRoleId;
    const biz = await prisma.rbacRole.create({
      data: { code: 'role-a', displayName: '业务角色 A' },
      select: { id: true },
    });
    bizRoleId = biz.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // 辅助:创建一个不撞名的 target user
  async function createTargetUser(suffix: string) {
    return createTestUser(app, { username: `ur-target-${suffix}`, role: Role.USER });
  }

  // ============ 权限边界 ============

  describe('权限边界', () => {
    it('未登录 GET → 401', async () => {
      const res = await request(httpServer(app)).get(`/api/v2/users/${userId}/roles`);
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it.each([
      ['get', 'get', `/api/v2/users/${'x'.repeat(25)}/roles`],
      ['post', 'post', `/api/v2/users/${'x'.repeat(25)}/roles`],
      ['delete', 'delete', `/api/v2/users/${'x'.repeat(25)}/roles/${'y'.repeat(25)}`],
    ])('USER 角色 %s → 30100 RBAC_FORBIDDEN', async (_name, method, path) => {
      const req = request(httpServer(app));
      let res;
      if (method === 'get') res = await req.get(path).set('Authorization', userAuth);
      else if (method === 'post')
        res = await req.post(path).set('Authorization', userAuth).send({ roleCode: 'role-a' });
      else res = await req.delete(path).set('Authorization', userAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });

  // ============ GET ============

  describe('GET /api/v2/users/:userId/roles', () => {
    it('查用户角色 → 200,空数组(未分配)', async () => {
      const target = await createTargetUser('get-empty');
      const res = await request(httpServer(app))
        .get(`/api/v2/users/${target.id}/roles`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('查用户角色 → 200,含已分配的扁平字段集', async () => {
      const target = await createTargetUser('get-with-roles');
      await prisma.userRole.create({
        data: { userId: target.id, roleId: bizRoleId, createdBy: superAdminId },
      });
      const res = await request(httpServer(app))
        .get(`/api/v2/users/${target.id}/roles`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({
        roleId: bizRoleId,
        roleCode: 'role-a',
        roleDisplayName: '业务角色 A',
        createdByUserId: superAdminId,
      });
      expect(res.body.data[0].id).toBeDefined();
      expect(res.body.data[0].createdAt).toBeDefined();
    });

    it('查用户角色 → 软删的 role 不返(沿 §13)', async () => {
      const target = await createTargetUser('get-softdel-role');
      const softdelRole = await prisma.rbacRole.create({
        data: { code: 'softdel-role-for-get', displayName: 'x', deletedAt: new Date() },
        select: { id: true },
      });
      await prisma.userRole.create({
        data: { userId: target.id, roleId: softdelRole.id },
      });
      const res = await request(httpServer(app))
        .get(`/api/v2/users/${target.id}/roles`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('user 不存在 → 10001', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/nonexistent000000000000000000/roles')
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.USER_NOT_FOUND);
    });

    it('user disabled → 10001(信息泄漏防御)', async () => {
      const target = await createTestUser(app, {
        username: 'ur-disabled-get',
        role: Role.USER,
        status: UserStatus.DISABLED,
      });
      const res = await request(httpServer(app))
        .get(`/api/v2/users/${target.id}/roles`)
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.USER_NOT_FOUND);
    });

    it('user 软删 → 10001', async () => {
      const target = await createTestUser(app, {
        username: 'ur-softdel-get',
        role: Role.USER,
        deletedAt: new Date(),
      });
      const res = await request(httpServer(app))
        .get(`/api/v2/users/${target.id}/roles`)
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.USER_NOT_FOUND);
    });
  });

  // ============ POST 分配 ============

  describe('POST /api/v2/users/:userId/roles', () => {
    it('SUPER_ADMIN 分配角色 → 201,扁平字段集 + createdByUserId 记 actor', async () => {
      const target = await createTargetUser('assign-success');
      const res = await request(httpServer(app))
        .post(`/api/v2/users/${target.id}/roles`)
        .set('Authorization', superAdminAuth)
        .send({ roleCode: 'role-a' });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        roleId: bizRoleId,
        roleCode: 'role-a',
        roleDisplayName: '业务角色 A',
        createdByUserId: superAdminId,
      });
    });

    it('SUPER_ADMIN 分配 ops-admin 角色 → 201(Q7 C2:SUPER_ADMIN 通过任何)', async () => {
      const target = await createTargetUser('assign-ops-admin');
      const res = await request(httpServer(app))
        .post(`/api/v2/users/${target.id}/roles`)
        .set('Authorization', superAdminAuth)
        .send({ roleCode: 'ops-admin' });
      expect(res.status).toBe(201);
      expect(res.body.data.roleCode).toBe('ops-admin');
    });

    it('重复分配 → 30006', async () => {
      const target = await createTargetUser('assign-duplicate');
      await prisma.userRole.create({ data: { userId: target.id, roleId: bizRoleId } });
      const res = await request(httpServer(app))
        .post(`/api/v2/users/${target.id}/roles`)
        .set('Authorization', superAdminAuth)
        .send({ roleCode: 'role-a' });
      expectBizError(res, BizCode.USER_ROLE_ALREADY_EXISTS);
    });

    it('role code 不存在 → 30003', async () => {
      const target = await createTargetUser('assign-role-missing');
      const res = await request(httpServer(app))
        .post(`/api/v2/users/${target.id}/roles`)
        .set('Authorization', superAdminAuth)
        .send({ roleCode: 'does-not-exist' });
      expectBizError(res, BizCode.ROLE_NOT_FOUND);
    });

    it('role 已软删 → 30003(POST 沿 v1 §10:不区分 30005,不复用以避免披露)', async () => {
      const target = await createTargetUser('assign-role-softdel');
      await prisma.rbacRole.create({
        data: { code: 'softdel-role-post', displayName: 'x', deletedAt: new Date() },
      });
      const res = await request(httpServer(app))
        .post(`/api/v2/users/${target.id}/roles`)
        .set('Authorization', superAdminAuth)
        .send({ roleCode: 'softdel-role-post' });
      expectBizError(res, BizCode.ROLE_NOT_FOUND);
    });

    it('user 不存在 → 10001', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/users/nonexistent000000000000000000/roles')
        .set('Authorization', superAdminAuth)
        .send({ roleCode: 'role-a' });
      expectBizError(res, BizCode.USER_NOT_FOUND);
    });

    it('user disabled → 10001', async () => {
      const target = await createTestUser(app, {
        username: 'ur-disabled-post',
        role: Role.USER,
        status: UserStatus.DISABLED,
      });
      const res = await request(httpServer(app))
        .post(`/api/v2/users/${target.id}/roles`)
        .set('Authorization', superAdminAuth)
        .send({ roleCode: 'role-a' });
      expectBizError(res, BizCode.USER_NOT_FOUND);
    });

    // P0-F PR-1(2026-05-18):入口已切 rbac.user-role.create;
    // ADMIN 不持 ops-admin → 入口直接 30100 RBAC_FORBIDDEN,不会到 Q7 30102。
    it('ADMIN 不持 ops-admin 分配 → 30100 RBAC_FORBIDDEN(入口拦)', async () => {
      const target = await createTargetUser('q7-admin-no-rbac');
      const res = await request(httpServer(app))
        .post(`/api/v2/users/${target.id}/roles`)
        .set('Authorization', adminAuth)
        .send({ roleCode: 'role-a' });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('Q7 C2 — ADMIN 持 ops-admin 分配业务角色 → 201', async () => {
      // 给 admin 配 ops-admin 角色;P0-F PR-1:必须 invalidateUser 让 cache 失效
      await prisma.userRole.create({ data: { userId: adminId, roleId: opsAdminRoleId } });
      cache.invalidateUser(adminId);
      const target = await createTargetUser('q7-admin-with-ops');
      const res = await request(httpServer(app))
        .post(`/api/v2/users/${target.id}/roles`)
        .set('Authorization', adminAuth)
        .send({ roleCode: 'role-a' });
      expect(res.status).toBe(201);
      // 清理:撤回 admin 的 ops-admin,避免影响后续测试
      await prisma.userRole.delete({
        where: { userId_roleId: { userId: adminId, roleId: opsAdminRoleId } },
      });
      cache.invalidateUser(adminId);
    });

    it('Q7 C2 — ADMIN 持 ops-admin **分配 ops-admin** → 30102', async () => {
      await prisma.userRole.create({ data: { userId: adminId, roleId: opsAdminRoleId } });
      cache.invalidateUser(adminId);
      const target = await createTargetUser('q7-admin-with-ops-assign-ops');
      const res = await request(httpServer(app))
        .post(`/api/v2/users/${target.id}/roles`)
        .set('Authorization', adminAuth)
        .send({ roleCode: 'ops-admin' });
      expectBizError(res, BizCode.CANNOT_ASSIGN_HIGHER_ROLE);
      await prisma.userRole.delete({
        where: { userId_roleId: { userId: adminId, roleId: opsAdminRoleId } },
      });
      cache.invalidateUser(adminId);
    });

    it('缓存失效:POST 后 invalidateUser 被调用', async () => {
      const target = await createTargetUser('cache-invalidate-post');
      // 预先 set cache
      cache.set(target.id, new Set(['some.cached.code']));
      expect(cache.get(target.id)).not.toBeNull();

      await request(httpServer(app))
        .post(`/api/v2/users/${target.id}/roles`)
        .set('Authorization', superAdminAuth)
        .send({ roleCode: 'role-a' });

      expect(cache.get(target.id)).toBeNull();
    });
  });

  // ============ DELETE 撤销 ============

  describe('DELETE /api/v2/users/:userId/roles/:roleId', () => {
    it('撤销成功 → 200,返回原 UserRole 元信息', async () => {
      const target = await createTargetUser('revoke-success');
      await prisma.userRole.create({ data: { userId: target.id, roleId: bizRoleId } });
      const res = await request(httpServer(app))
        .delete(`/api/v2/users/${target.id}/roles/${bizRoleId}`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.roleCode).toBe('role-a');

      // DB 已删
      const stillThere = await prisma.userRole.findUnique({
        where: { userId_roleId: { userId: target.id, roleId: bizRoleId } },
      });
      expect(stillThere).toBeNull();
    });

    it('关系不存在 → 30007', async () => {
      const target = await createTargetUser('revoke-no-relation');
      const res = await request(httpServer(app))
        .delete(`/api/v2/users/${target.id}/roles/${bizRoleId}`)
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.USER_ROLE_NOT_FOUND);
    });

    it('role 不存在 → 30003', async () => {
      const target = await createTargetUser('revoke-role-missing');
      const res = await request(httpServer(app))
        .delete(`/api/v2/users/${target.id}/roles/nonexistent000000000000000000`)
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.ROLE_NOT_FOUND);
    });

    it('role 已软删 → 30005(DELETE 沿 PR #3 / PR #4 写操作披露范式)', async () => {
      const target = await createTargetUser('revoke-role-softdel');
      const softRole = await prisma.rbacRole.create({
        data: { code: 'softdel-role-delete', displayName: 'x', deletedAt: new Date() },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .delete(`/api/v2/users/${target.id}/roles/${softRole.id}`)
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.ROLE_DELETED);
    });

    it('user 不存在 → 10001', async () => {
      const res = await request(httpServer(app))
        .delete(`/api/v2/users/nonexistent000000000000000000/roles/${bizRoleId}`)
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.USER_NOT_FOUND);
    });

    // P0-F PR-1(2026-05-18):入口已切 rbac.user-role.delete;
    // ADMIN 不持 ops-admin → 入口直接 30100,不会到 Q7 30102。
    it('ADMIN 不持 ops-admin 撤销 → 30100 RBAC_FORBIDDEN(入口拦)', async () => {
      const target = await createTargetUser('revoke-q7-admin-no-rbac');
      await prisma.userRole.create({ data: { userId: target.id, roleId: bizRoleId } });
      const res = await request(httpServer(app))
        .delete(`/api/v2/users/${target.id}/roles/${bizRoleId}`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('最后一个 ops-admin 保护 → 30101', async () => {
      // 前置:清空所有 ops-admin 持有者(因前面的 it 已分配过 ops-admin,
      // 直接撤销可能剩余 ≥ 2 不触发保护)
      await prisma.userRole.deleteMany({ where: { roleId: opsAdminRoleId } });

      // 准备:确保有且仅有 1 个 ops-admin 持有者(target1)
      const target1 = await createTargetUser('last-ops-admin-1');
      await prisma.userRole.create({ data: { userId: target1.id, roleId: opsAdminRoleId } });

      // 撤销 target1 的 ops-admin → 剩余 0 → 30101
      const res = await request(httpServer(app))
        .delete(`/api/v2/users/${target1.id}/roles/${opsAdminRoleId}`)
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.LAST_OPS_ADMIN_PROTECTED);

      // 验证 DB 中关系仍在(事务回滚)
      const stillThere = await prisma.userRole.findUnique({
        where: { userId_roleId: { userId: target1.id, roleId: opsAdminRoleId } },
      });
      expect(stillThere).not.toBeNull();
    });

    it('有 ≥ 2 个 ops-admin 持有者时,撤销一个 → 200', async () => {
      // 准备:2 个 ops-admin 持有者
      const t1 = await createTargetUser('two-ops-admins-1');
      const t2 = await createTargetUser('two-ops-admins-2');
      await prisma.userRole.create({ data: { userId: t1.id, roleId: opsAdminRoleId } });
      await prisma.userRole.create({ data: { userId: t2.id, roleId: opsAdminRoleId } });

      // 撤销 t1 → 剩余 1(t2)→ 通过
      const res = await request(httpServer(app))
        .delete(`/api/v2/users/${t1.id}/roles/${opsAdminRoleId}`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);

      // 清理 t2(避免影响后续 "最后一个" 测试)
      await prisma.userRole.delete({
        where: { userId_roleId: { userId: t2.id, roleId: opsAdminRoleId } },
      });
    });

    it('缓存失效:DELETE 后 invalidateUser 被调用', async () => {
      const target = await createTargetUser('cache-invalidate-delete');
      await prisma.userRole.create({ data: { userId: target.id, roleId: bizRoleId } });
      cache.set(target.id, new Set(['some.cached.code']));
      expect(cache.get(target.id)).not.toBeNull();

      await request(httpServer(app))
        .delete(`/api/v2/users/${target.id}/roles/${bizRoleId}`)
        .set('Authorization', superAdminAuth);

      expect(cache.get(target.id)).toBeNull();
    });
  });
});
