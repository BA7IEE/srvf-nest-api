import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { RbacCacheService } from '../../src/modules/permissions/rbac-cache.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// V2.x C-6 RBAC 实施 PR #6:GET /api/v2/rbac/me/permissions e2e。
// 沿 D7 v1.1 §5.1 端点 15 + §5.3 详解 + 用户拍板三项决策。
//
// 覆盖:
// - 未登录 → 401
// - USER 未持任何角色 → permissions=[] / effectiveRoles=[]
// - USER 持有 1 业务角色 + 该角色配 2 权限点 → permissions 含 2 个 code / effectiveRoles 1 项
// - ADMIN 未持任何 RBAC 角色(seed 未实施)→ permissions=[] / effectiveRoles=[]
//   (符合 D7 §8.2 描述:ADMIN 通过 seed 给 ADMIN 内置角色配 USER 级权限实现自动继承;
//    本 PR seed 未实施,空集是正确行为)
// - SUPER_ADMIN → permissions=Permission.code 全集(已排序)+ effectiveRoles 走 user_roles
// - 缓存行为:第一次查 DB 后命中 cache;invalidate 后再查 → DB 重新聚合

describe('rbac me/permissions', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cache: RbacCacheService;

  let superAdminAuth: string;
  let adminAuth: string;
  let userEmptyAuth: string;
  let userWithRolesAuth: string;

  let userWithRolesId: string;
  let roleAId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    cache = app.get(RbacCacheService);

    await createTestUser(app, { username: 'rbac-me-su', role: Role.SUPER_ADMIN });
    await createTestUser(app, { username: 'rbac-me-adm', role: Role.ADMIN });
    await createTestUser(app, { username: 'rbac-me-empty', role: Role.USER });
    const userWithRoles = await createTestUser(app, {
      username: 'rbac-me-withroles',
      role: Role.USER,
    });
    userWithRolesId = userWithRoles.id;

    superAdminAuth = (await loginAs(app, 'rbac-me-su')).authHeader;
    adminAuth = (await loginAs(app, 'rbac-me-adm')).authHeader;
    userEmptyAuth = (await loginAs(app, 'rbac-me-empty')).authHeader;
    userWithRolesAuth = (await loginAs(app, 'rbac-me-withroles')).authHeader;

    // seed Permission(2 条:用于 SUPER_ADMIN 全集 + USER 角色映射)
    await prisma.permission.createMany({
      data: [
        {
          code: 'attachment.upload.cert',
          module: 'attachment',
          action: 'upload',
          resourceType: 'cert',
          description: 'e2e seed',
        },
        {
          code: 'attachment.view.cert',
          module: 'attachment',
          action: 'view',
          resourceType: 'cert',
          description: 'e2e seed',
        },
      ],
    });

    // seed RbacRole + RolePermission(给业务角色配 2 权限点)
    const roleA = await prisma.rbacRole.create({
      data: { code: 'me-role-a', displayName: '业务角色 A' },
      select: { id: true },
    });
    roleAId = roleA.id;

    const perms = await prisma.permission.findMany({
      where: { code: { in: ['attachment.upload.cert', 'attachment.view.cert'] } },
      select: { id: true, code: true },
    });
    await prisma.rolePermission.createMany({
      data: perms.map((p) => ({ roleId: roleAId, permissionId: p.id })),
    });

    // 给 userWithRoles 分配 me-role-a
    await prisma.userRole.create({
      data: { userId: userWithRolesId, roleId: roleAId },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('权限边界', () => {
    it('未登录 → 401', async () => {
      const res = await request(httpServer(app)).get('/api/v2/rbac/me/permissions');
      expectBizError(res, BizCode.UNAUTHORIZED);
    });
  });

  describe('权限点聚合', () => {
    it('USER 未持任何角色 → permissions=[] / effectiveRoles=[]', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/rbac/me/permissions')
        .set('Authorization', userEmptyAuth);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ permissions: [], effectiveRoles: [] });
    });

    it('USER 持业务角色(2 权限点)→ permissions 含 2 项(已排序) / effectiveRoles 1 项', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/rbac/me/permissions')
        .set('Authorization', userWithRolesAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.permissions).toEqual(['attachment.upload.cert', 'attachment.view.cert']);
      expect(res.body.data.effectiveRoles).toEqual([
        { code: 'me-role-a', displayName: '业务角色 A' },
      ]);
    });

    it('ADMIN 未持任何 RBAC 角色(seed 未实施)→ permissions=[] / effectiveRoles=[]', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/rbac/me/permissions')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ permissions: [], effectiveRoles: [] });
    });

    it('SUPER_ADMIN → permissions=Permission.code 全集(已排序;沿用户拍板方案 B)', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/rbac/me/permissions')
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      // 注:此时 DB Permission 全集 = e2e seed 的 2 条(本 spec 在 reset 后独立 seed)
      expect(res.body.data.permissions).toEqual(['attachment.upload.cert', 'attachment.view.cert']);
      // SUPER_ADMIN 未持任何 RBAC 业务角色 → effectiveRoles 为空
      expect(res.body.data.effectiveRoles).toEqual([]);
    });
  });

  describe('缓存行为(沿 D7 §9)', () => {
    it('第一次查 → cache miss → set;invalidateUser 后再查 → 重新聚合', async () => {
      // 第一次查:确保 cache 中有该 user 的条目
      await request(httpServer(app))
        .get('/api/v2/rbac/me/permissions')
        .set('Authorization', userWithRolesAuth);
      expect(cache.get(userWithRolesId)).not.toBeNull();

      // 模拟 RolePermissionsService 撤权:invalidateUser
      cache.invalidateUser(userWithRolesId);
      expect(cache.get(userWithRolesId)).toBeNull();

      // 再查应当重新聚合
      const res = await request(httpServer(app))
        .get('/api/v2/rbac/me/permissions')
        .set('Authorization', userWithRolesAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.permissions).toEqual(['attachment.upload.cert', 'attachment.view.cert']);
      // 重新聚合后 cache 应再次有条目
      expect(cache.get(userWithRolesId)).not.toBeNull();
    });

    it('SUPER_ADMIN 不走 user 权限缓存(走 Permission 全表查询)', async () => {
      // SUPER_ADMIN getMyPermissions 走 getAllPermissionCodes,不会 set user cache
      const superAdminUser = await prisma.user.findFirstOrThrow({
        where: { username: 'rbac-me-su' },
        select: { id: true },
      });
      cache.invalidateUser(superAdminUser.id);

      await request(httpServer(app))
        .get('/api/v2/rbac/me/permissions')
        .set('Authorization', superAdminAuth);

      // SUPER_ADMIN 路径不应 set cache(因为不走 getUserPermissionCodes)
      expect(cache.get(superAdminUser.id)).toBeNull();
    });
  });

  describe('JWT 状态校验(memberId 字段填充)', () => {
    it('已扩展 CurrentUserPayload.memberId,JWT 携带未变形(登录仍正常)', async () => {
      // 隐式覆盖:loginAs 走真实登录链路,JwtStrategy.validate select 加 memberId 后
      // 仍能正确填充 request.user;若 select / payload 形状破坏,前面所有 it 都会 401。
      // 这里再补一条显式断言:status=200 + 响应是结构化 data。
      const res = await request(httpServer(app))
        .get('/api/v2/rbac/me/permissions')
        .set('Authorization', userEmptyAuth);
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data).toBeDefined();
    });

    it('user 被禁用后(DISABLED)→ JwtStrategy 拒绝 → 401', async () => {
      const tempUser = await createTestUser(app, {
        username: 'rbac-me-disable-target',
        role: Role.USER,
      });
      const { authHeader } = await loginAs(app, 'rbac-me-disable-target');

      // 把 user 改成 DISABLED
      await prisma.user.update({
        where: { id: tempUser.id },
        data: { status: UserStatus.DISABLED },
      });

      const res = await request(httpServer(app))
        .get('/api/v2/rbac/me/permissions')
        .set('Authorization', authHeader);
      expectBizError(res, BizCode.UNAUTHORIZED);
    });
  });
});
