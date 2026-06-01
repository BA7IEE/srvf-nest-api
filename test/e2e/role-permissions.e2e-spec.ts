import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { RbacCacheService } from '../../src/modules/permissions/rbac-cache.service';
import { loginAs } from '../fixtures/auth.fixture';
import {
  grantOpsAdminToUser,
  revokeOpsAdminFromUser,
  seedRbacPermissionsAndOpsAdmin,
} from '../fixtures/rbac.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// V2.x C-6 RBAC 实施 PR #4:RolePermission 关联表 + 缓存骨架 e2e。
// 沿 D7 v1.1 §5.1 端点 10-11 + §9 缓存策略 + 用户拍板。
//
// 覆盖(沿任务 #9):
// - 批量授权(成功 / 含已存在的幂等 / role 不存在 / role 已软删 / permission 不存在)
// - 撤权(成功 / 关系不存在 30011 / role 不存在 / role 已软删 / permission 不存在)
// - role detail 返回真实 permissions
// - 权限边界(未登录 / USER 403 / ADMIN 允许)
// - cache invalidate 入口被调用(skeleton:用 RbacCacheService 内部测试方法验证)
//
// 不覆盖(超本 PR 范围):
// - 完整 rbac.can() / 缓存命中路径(留 PR #6)
// - reload 接口(留 PR #7)
// - UserRole(留 PR #5)
// - audit_logs 集成(留后续审计批次)

describe('role-permissions 模块 + cache skeleton', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cache: RbacCacheService;
  let superAdminAuth: string;
  let adminAuth: string;
  let userAuth: string;
  let rpOpsAdminRoleId: string;
  let rpAdminUserId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    cache = app.get(RbacCacheService);

    await createTestUser(app, { username: 'rp-su', role: Role.SUPER_ADMIN });
    const adm = await createTestUser(app, { username: 'rp-adm', role: Role.ADMIN });
    rpAdminUserId = adm.id;
    await createTestUser(app, { username: 'rp-user', role: Role.USER });

    superAdminAuth = (await loginAs(app, 'rp-su')).authHeader;
    adminAuth = (await loginAs(app, 'rp-adm')).authHeader;
    userAuth = (await loginAs(app, 'rp-user')).authHeader;

    // P0-F PR-1:resetDb 已清 RBAC 表;e2e 自行 seed 14 条 rbac.* + ops-admin。
    const seed = await seedRbacPermissionsAndOpsAdmin(app);
    rpOpsAdminRoleId = seed.opsAdminRoleId;
  });

  afterAll(async () => {
    await app.close();
  });

  // 辅助:创建测试用 role + N 个 permission
  async function setupRoleAndPermissions(opts: {
    roleCode: string;
    permCodes: string[];
    roleDeletedAt?: Date | null;
  }) {
    const role = await prisma.rbacRole.create({
      data: {
        code: opts.roleCode,
        displayName: opts.roleCode,
        deletedAt: opts.roleDeletedAt ?? null,
      },
      select: { id: true },
    });
    const perms = [];
    for (const code of opts.permCodes) {
      const p = await prisma.permission.create({
        data: {
          code,
          module: code.split('.')[0],
          action: code.split('.')[1],
          resourceType: code.split('.')[2] ?? '',
        },
        select: { id: true, code: true },
      });
      perms.push(p);
    }
    return { roleId: role.id, perms };
  }

  // ============ 权限边界 ============

  describe('权限边界', () => {
    it('未登录 POST → 401', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/roles/nonexistent000000000000000000/permissions')
        .send({ permissionCodes: ['x.y.z'] });
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('USER POST → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/roles/nonexistent000000000000000000/permissions')
        .set('Authorization', userAuth)
        .send({ permissionCodes: ['x.y.z'] });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER DELETE → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .delete(
          '/api/system/v1/roles/nonexistent000000000000000000/permissions/abc-perm-00000000000000000000',
        )
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    // P0-F PR-1(2026-05-18):v1 ADMIN 不再自动放行 RBAC 元接口;必须持 RBAC 角色。
    it('ADMIN 默认无 RBAC 权限 → 30100 RBAC_FORBIDDEN', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'admin-no-rbac-rp',
        permCodes: ['adm.norbac.a'],
      });
      const res = await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', adminAuth)
        .send({ permissionCodes: [perms[0].code] });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    // P0-F PR-1:ADMIN 持 ops-admin 后能通过(seed 14 条 rbac.* 含 rbac.role-permission.create)。
    it('ADMIN 持 ops-admin 角色 → POST 201', async () => {
      await grantOpsAdminToUser(app, rpAdminUserId, rpOpsAdminRoleId);
      try {
        const { roleId, perms } = await setupRoleAndPermissions({
          roleCode: 'admin-with-ops-rp',
          permCodes: ['adm.ops.b'],
        });
        const res = await request(httpServer(app))
          .post(`/api/system/v1/roles/${roleId}/permissions`)
          .set('Authorization', adminAuth)
          .send({ permissionCodes: [perms[0].code] });
        expect(res.status).toBe(201);
      } finally {
        await revokeOpsAdminFromUser(app, rpAdminUserId, rpOpsAdminRoleId);
      }
    });
  });

  // ============ 批量授权 ============

  describe('POST /api/system/v1/roles/:id/permissions', () => {
    it('批量授权 → 200,detail.permissions 含全部新加', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'assign-multi',
        permCodes: ['multi.a.r1', 'multi.b.r2', 'multi.c.r3'],
      });

      const res = await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: perms.map((p) => p.code) });

      expect(res.status).toBe(201);
      expect(res.body.code).toBe(0);
      expect(res.body.data.permissions).toHaveLength(3);
      const returnedCodes = res.body.data.permissions.map((p: { code: string }) => p.code);
      expect(returnedCodes).toEqual(
        expect.arrayContaining(['multi.a.r1', 'multi.b.r2', 'multi.c.r3']),
      );
    });

    it('重复授权幂等成功 → 200,total 仍为去重后的数量', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'assign-idempotent',
        permCodes: ['idem.a.x'],
      });

      // 第一次授权
      const first = await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: [perms[0].code] });
      expect(first.status).toBe(201);
      expect(first.body.data.permissions).toHaveLength(1);

      // 第二次重复授权(同一 code)— 幂等成功,不抛 30010,permissions 仍 1 条
      const second = await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: [perms[0].code] });
      expect(second.status).toBe(201);
      expect(second.body.data.permissions).toHaveLength(1);

      // DB 中实际 RolePermission 行数也应是 1(skipDuplicates)
      const dbCount = await prisma.rolePermission.count({ where: { roleId } });
      expect(dbCount).toBe(1);
    });

    it('部分重复部分新增 → 200,只新增不存在的关系', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'assign-partial',
        permCodes: ['part.a.x', 'part.b.y', 'part.c.z'],
      });

      // 先授 a + b
      await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: ['part.a.x', 'part.b.y'] });

      // 再发送 a + b + c(含 2 个已存在 + 1 个新增)
      const res = await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: perms.map((p) => p.code) });
      expect(res.status).toBe(201);
      expect(res.body.data.permissions).toHaveLength(3);
    });

    it('入参中包含重复 code → 200,Service 内部 dedup', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'assign-input-dup',
        permCodes: ['dup.x.x'],
      });
      const res = await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: [perms[0].code, perms[0].code, perms[0].code] });
      expect(res.status).toBe(201);
      expect(res.body.data.permissions).toHaveLength(1);
    });

    it('role 不存在 → 30003', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/roles/nonexistent000000000000000000/permissions')
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: ['any.x.y'] });
      expectBizError(res, BizCode.ROLE_NOT_FOUND);
    });

    it('role 已软删 → 30005', async () => {
      const { roleId } = await setupRoleAndPermissions({
        roleCode: 'assign-softdel',
        permCodes: [],
        roleDeletedAt: new Date(),
      });
      const res = await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: ['x.y.z'] });
      expectBizError(res, BizCode.ROLE_DELETED);
    });

    it('permission code 不存在 → 30001,整批拒绝', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'assign-perm-missing',
        permCodes: ['exist.a.x'],
      });
      const res = await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: [perms[0].code, 'does.not.exist'] });
      expectBizError(res, BizCode.PERMISSION_NOT_FOUND);

      // 确认部分授权也未发生(整批拒绝)
      const dbCount = await prisma.rolePermission.count({ where: { roleId } });
      expect(dbCount).toBe(0);
    });

    it('空数组 → 400(DTO @ArrayMinSize(1))', async () => {
      const { roleId } = await setupRoleAndPermissions({
        roleCode: 'assign-empty',
        permCodes: [],
      });
      const res = await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: [] });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });
  });

  // ============ 撤权 ============

  describe('DELETE /api/system/v1/roles/:id/permissions/:permissionId', () => {
    it('撤权 → 200,detail.permissions 移除指定项', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'revoke-success',
        permCodes: ['rev.a.x', 'rev.b.y'],
      });

      // 先授 2 个
      await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: ['rev.a.x', 'rev.b.y'] });

      // 撤 a
      const res = await request(httpServer(app))
        .delete(`/api/system/v1/roles/${roleId}/permissions/${perms[0].id}`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.permissions).toHaveLength(1);
      expect(res.body.data.permissions[0].code).toBe('rev.b.y');
    });

    it('关系不存在 → 30011 ROLE_PERMISSION_NOT_FOUND', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'revoke-no-relation',
        permCodes: ['norel.a.x'],
      });
      // role 和 permission 都存在,但没建过关系
      const res = await request(httpServer(app))
        .delete(`/api/system/v1/roles/${roleId}/permissions/${perms[0].id}`)
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.ROLE_PERMISSION_NOT_FOUND);
    });

    it('role 不存在 → 30003', async () => {
      const perm = await prisma.permission.create({
        data: { code: 'rev.norole.x', module: 'rev', action: 'norole', resourceType: 'x' },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .delete(`/api/system/v1/roles/nonexistent000000000000000000/permissions/${perm.id}`)
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.ROLE_NOT_FOUND);
    });

    it('role 已软删 → 30005', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'revoke-softdel-role',
        permCodes: ['rsdr.a.x'],
        roleDeletedAt: new Date(),
      });
      const res = await request(httpServer(app))
        .delete(`/api/system/v1/roles/${roleId}/permissions/${perms[0].id}`)
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.ROLE_DELETED);
    });

    it('permission 不存在 → 30001', async () => {
      const { roleId } = await setupRoleAndPermissions({
        roleCode: 'revoke-no-perm',
        permCodes: [],
      });
      const res = await request(httpServer(app))
        .delete(`/api/system/v1/roles/${roleId}/permissions/missing000000000000000000000`)
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.PERMISSION_NOT_FOUND);
    });
  });

  // ============ role detail 真实 permissions 填充 ============

  describe('GET /api/system/v1/roles/:id detail 返回真实 permissions(端到端)', () => {
    it('授权后 GET role detail → permissions 数组填充正确', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'detail-real-fill',
        permCodes: ['drf.a.x', 'drf.b.y'],
      });

      // 用 POST 接口授权(走 service 完整路径)
      await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: perms.map((p) => p.code) });

      // GET detail 验证
      const detailRes = await request(httpServer(app))
        .get(`/api/system/v1/roles/${roleId}`)
        .set('Authorization', superAdminAuth);
      expect(detailRes.status).toBe(200);
      expect(detailRes.body.data.permissions).toHaveLength(2);
      const detailCodes = detailRes.body.data.permissions.map((p: { code: string }) => p.code);
      expect(detailCodes).toEqual(expect.arrayContaining(['drf.a.x', 'drf.b.y']));
    });
  });

  // ============ cache skeleton ============

  describe('RbacCacheService skeleton', () => {
    it('cache get / set / invalidate 接口可用(未来 PR #6 接 rbac.can() 时复用)', () => {
      const userId = 'test-user-skeleton';
      // 初始 miss
      expect(cache.get(userId)).toBeNull();
      // set 后能 get 到
      cache.set(userId, new Set(['x.y.z']));
      expect(cache.get(userId)?.has('x.y.z')).toBe(true);
      // invalidate 后再 miss
      cache.invalidateUser(userId);
      expect(cache.get(userId)).toBeNull();
    });

    it('POST 授权后 cache invalidate 被调用(skeleton 验证)', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'cache-invalidate-post',
        permCodes: ['ci.a.x'],
      });

      // 先 seed 一个 fake cache entry,期望授权后清掉
      // 注:本 PR cache 是 skeleton — 没人会真正 set(rbac.can() 留 PR #6);
      // 但 invalidate 调用链在 POST/DELETE 完成后被触发是可验证的。
      const fakeUserId = 'fake-user-with-role';
      cache.set(fakeUserId, new Set(['old.cached.code']));
      expect(cache.get(fakeUserId)).not.toBeNull();

      // 让 userRole 表里存在 fakeUserId 与本 role 的关联(否则 invalidateAllUsersWithRole 找不到)
      // 注:UserRole CRUD 留 PR #5;这里用 prisma 直接插入测试数据。
      // user fixture 用 'rp-su' 已创建;为简化,用其 id 与 fakeUserId 不重复,所以这里直接插 fakeUserId 不合法(User 表无该 id);
      // 改方案:用 prisma 直接 insert UserRole 记录用 rp-su 的真实 user.id。
      const realUser = await prisma.user.findUnique({
        where: { username: 'rp-su' },
        select: { id: true },
      });
      cache.set(realUser!.id, new Set(['old.cached.code']));
      await prisma.userRole.create({
        data: { userId: realUser!.id, roleId },
      });

      // 触发授权
      await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: [perms[0].code] });

      // realUser cache 应已被清(invalidateAllUsersWithRole 走的是 prisma 查 user_roles 然后清)
      expect(cache.get(realUser!.id)).toBeNull();
      // fakeUserId 因为没在 user_roles 表里,不会被本次清掉(skeleton 验证粒度)
      // — 但这是端到端测,fakeUserId 也未必残留;不强断言,只验证 realUser 被清的关键路径。
    });

    it('DELETE 撤权后 cache invalidate 被调用', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'cache-invalidate-delete',
        permCodes: ['cid.a.x'],
      });

      // 先授权
      await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: [perms[0].code] });

      // 关联 rp-adm 到该 role + 给其 set cache
      const realUser = await prisma.user.findUnique({
        where: { username: 'rp-adm' },
        select: { id: true },
      });
      await prisma.userRole.create({
        data: { userId: realUser!.id, roleId },
      });
      cache.set(realUser!.id, new Set(['some.cached.code']));
      expect(cache.get(realUser!.id)).not.toBeNull();

      // 撤权
      await request(httpServer(app))
        .delete(`/api/system/v1/roles/${roleId}/permissions/${perms[0].id}`)
        .set('Authorization', superAdminAuth);

      // realUser cache 应已被清
      expect(cache.get(realUser!.id)).toBeNull();
    });

    it('invalidateAll 全量清', () => {
      cache.set('u1', new Set(['a']));
      cache.set('u2', new Set(['b']));
      expect(cache.size()).toBeGreaterThanOrEqual(2);
      cache.invalidateAll();
      expect(cache.size()).toBe(0);
    });
  });
});
