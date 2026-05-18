import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { RbacCacheService } from '../../src/modules/permissions/rbac-cache.service';
import { grantOpsAdminToUser, seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// V2.x C-6 RBAC 实施 PR #7:POST /api/v2/rbac/reload e2e。
// 沿 D7 v1.1 §5.4 + F4 v1.0 三档 scope + 用户拍板四项决策。
//
// 覆盖:
// - 权限边界:未登录 401 / USER 403 / ADMIN 200 / SUPER_ADMIN 200
// - scope=all(默认 + 显式):清空全部 cache;后续 me/permissions 重新查 DB
// - scope=user + userId:仅清空指定 user cache
// - scope=role + roleId:清空所有持有该角色的 user cache
// - scope=user 缺 userId → 400(沿用户决策方案 A)
// - scope=role 缺 roleId → 400
// - scope=user + userId 不存在 → 200 静默成功(沿用户决策方案 A)
// - scope=role + roleId 不存在 → 200 静默成功

describe('rbac reload (POST /api/v2/rbac/reload)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cache: RbacCacheService;

  let superAdminAuth: string;
  let adminAuth: string;
  let userAuth: string;

  let user1Id: string;
  let user2Id: string;
  let roleAId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    cache = app.get(RbacCacheService);

    await createTestUser(app, { username: 'reload-su', role: Role.SUPER_ADMIN });
    await createTestUser(app, { username: 'reload-adm', role: Role.ADMIN });
    await createTestUser(app, { username: 'reload-user', role: Role.USER });
    const u1 = await createTestUser(app, { username: 'reload-target-1', role: Role.USER });
    const u2 = await createTestUser(app, { username: 'reload-target-2', role: Role.USER });
    user1Id = u1.id;
    user2Id = u2.id;

    superAdminAuth = (await loginAs(app, 'reload-su')).authHeader;
    adminAuth = (await loginAs(app, 'reload-adm')).authHeader;
    userAuth = (await loginAs(app, 'reload-user')).authHeader;

    // P0-F PR-1(2026-05-18):reload 入口已切 rbac.config.reload;
    //   resetDb 把 permissions 表清空;e2e 自行 seed 14 条 rbac.* + ops-admin
    //   全量绑定(沿 test/fixtures/rbac.fixture.ts)+ 给 ADMIN 绑 ops-admin
    //   (让"ADMIN 持 ops-admin → 200"用例 + 与 me/permissions 串联用例继续工作)。
    const seed = await seedRbacPermissionsAndOpsAdmin(app);
    const admin = await prisma.user.findUniqueOrThrow({ where: { username: 'reload-adm' } });
    await grantOpsAdminToUser(app, admin.id, seed.opsAdminRoleId);

    // seed:1 RbacRole 给 user1 + user2(scope=role 测试需要 invalidateAllUsersWithRole 命中 2 个)
    const roleA = await prisma.rbacRole.create({
      data: { code: 'reload-role-a', displayName: '业务角色 A' },
      select: { id: true },
    });
    roleAId = roleA.id;
    await prisma.userRole.createMany({
      data: [
        { userId: user1Id, roleId: roleAId },
        { userId: user2Id, roleId: roleAId },
      ],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  // 辅助:把指定 user 写入 cache,模拟 me/permissions 调用后 cache 已 set
  function seedUserCache(userId: string): void {
    cache.set(userId, new Set(['fake.code']));
  }

  describe('权限边界', () => {
    it('未登录 → 401', async () => {
      const res = await request(httpServer(app)).post('/api/v2/rbac/reload').send({});
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('USER → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/rbac/reload')
        .set('Authorization', userAuth)
        .send({});
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    // P0-F PR-1(2026-05-18):入口已切 rbac.config.reload;
    // ADMIN 持 ops-admin(setUp 已绑)→ 通过。
    it('ADMIN 持 ops-admin → 200', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/rbac/reload')
        .set('Authorization', adminAuth)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ reloaded: true });
    });

    it('SUPER_ADMIN → 200', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/rbac/reload')
        .set('Authorization', superAdminAuth)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ reloaded: true });
    });
  });

  describe('scope=all', () => {
    it('入参为空 → 默认 scope=all → 清空全部 cache', async () => {
      seedUserCache(user1Id);
      seedUserCache(user2Id);
      expect(cache.size()).toBeGreaterThanOrEqual(2);

      const res = await request(httpServer(app))
        .post('/api/v2/rbac/reload')
        .set('Authorization', superAdminAuth)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ reloaded: true });
      expect(cache.size()).toBe(0);
    });

    it('显式 scope=all → 同上', async () => {
      seedUserCache(user1Id);
      seedUserCache(user2Id);

      const res = await request(httpServer(app))
        .post('/api/v2/rbac/reload')
        .set('Authorization', superAdminAuth)
        .send({ scope: 'all' });
      expect(res.status).toBe(200);
      expect(cache.size()).toBe(0);
    });
  });

  describe('scope=user', () => {
    it('scope=user + 已存在 userId → 仅清空该 user cache', async () => {
      seedUserCache(user1Id);
      seedUserCache(user2Id);
      expect(cache.get(user1Id)).not.toBeNull();
      expect(cache.get(user2Id)).not.toBeNull();

      const res = await request(httpServer(app))
        .post('/api/v2/rbac/reload')
        .set('Authorization', superAdminAuth)
        .send({ scope: 'user', userId: user1Id });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ reloaded: true });

      expect(cache.get(user1Id)).toBeNull();
      expect(cache.get(user2Id)).not.toBeNull(); // 其他 user 不被波及
      cache.invalidateAll(); // 清理
    });

    it('scope=user 缺 userId → 400', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/rbac/reload')
        .set('Authorization', superAdminAuth)
        .send({ scope: 'user' });
      expectBizError(res, BizCode.BAD_REQUEST);
    });

    it('scope=user + userId 不存在 → 200 静默成功(沿用户决策方案 A)', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/rbac/reload')
        .set('Authorization', superAdminAuth)
        .send({ scope: 'user', userId: 'nonexistent000000000000000000' });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ reloaded: true });
    });
  });

  describe('scope=role', () => {
    it('scope=role + roleId 命中 2 个 holder → 全清', async () => {
      seedUserCache(user1Id);
      seedUserCache(user2Id);
      // 再加一个不持 role-a 的 user(superAdmin),应当不被清
      const superAdminId = (
        await prisma.user.findFirstOrThrow({
          where: { username: 'reload-su' },
          select: { id: true },
        })
      ).id;
      seedUserCache(superAdminId);

      const res = await request(httpServer(app))
        .post('/api/v2/rbac/reload')
        .set('Authorization', superAdminAuth)
        .send({ scope: 'role', roleId: roleAId });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ reloaded: true });

      expect(cache.get(user1Id)).toBeNull();
      expect(cache.get(user2Id)).toBeNull();
      expect(cache.get(superAdminId)).not.toBeNull(); // 不持 role-a 不波及
      cache.invalidateAll();
    });

    it('scope=role 缺 roleId → 400', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/rbac/reload')
        .set('Authorization', superAdminAuth)
        .send({ scope: 'role' });
      expectBizError(res, BizCode.BAD_REQUEST);
    });

    it('scope=role + roleId 不存在 → 200 静默成功', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/rbac/reload')
        .set('Authorization', superAdminAuth)
        .send({ scope: 'role', roleId: 'nonexistent000000000000000000' });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ reloaded: true });
    });
  });

  describe('与 me/permissions 串联(端到端缓存失效)', () => {
    it('me/permissions 后 cache 已 set → reload all → cache 清 → 再 me/permissions 重新查 DB', async () => {
      // 1. user1 触发 me/permissions(loginAs 已在 beforeAll 完成,但本 it 直接复用 user1 的真实 login)
      const { authHeader: user1Auth } = await loginAs(app, 'reload-target-1');
      await request(httpServer(app))
        .get('/api/v2/rbac/me/permissions')
        .set('Authorization', user1Auth);
      expect(cache.get(user1Id)).not.toBeNull();

      // 2. ADMIN 触发 reload(scope=all)
      await request(httpServer(app))
        .post('/api/v2/rbac/reload')
        .set('Authorization', adminAuth)
        .send({});
      expect(cache.get(user1Id)).toBeNull();

      // 3. 再 me/permissions → cache miss → 重新聚合 + set
      await request(httpServer(app))
        .get('/api/v2/rbac/me/permissions')
        .set('Authorization', user1Auth);
      expect(cache.get(user1Id)).not.toBeNull();
    });
  });

  describe('入参严格校验(forbidNonWhitelisted + IsIn)', () => {
    it('scope=invalid → 400(IsIn 拦截)', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/rbac/reload')
        .set('Authorization', superAdminAuth)
        .send({ scope: 'invalid-scope' });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('多余字段 → 400(forbidNonWhitelisted)', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/rbac/reload')
        .set('Authorization', superAdminAuth)
        .send({ scope: 'all', extraField: 'x' });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });
  });
});
