import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { grantOpsAdminToUser, seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// V2.x C-6 RBAC 实施 PR #7:POST /api/system/v1/rbac/reload e2e。
// 沿 D7 v1.1 §5.4 + F4 v1.0 三档 scope + 用户拍板四项决策。
//
// 覆盖:
// - 权限边界:未登录 401 / USER 403 / ADMIN 200 / SUPER_ADMIN 200
// - scope=all(默认 + 显式):兼容返回 `{reloaded:true}`
// - scope=user + userId / scope=role + roleId:保留既有输入与响应契约,内部无需清缓存
// - scope=user 缺 userId → 400(沿用户决策方案 A)
// - scope=role 缺 roleId → 400
// - scope=user + userId 不存在 → 200 静默成功(沿用户决策方案 A)
// - scope=role + roleId 不存在 → 200 静默成功

describe('rbac reload (POST /api/system/v1/rbac/reload)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

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

    // seed:1 RbacRole 给 user1 + user2,用于验证 reload 不改变当前 DB-backed 角色摘要。
    const roleA = await prisma.rbacRole.create({
      data: { code: 'reload-role-a', displayName: '业务角色 A' },
      select: { id: true },
    });
    roleAId = roleA.id;
    // 终态 scoped-authz PR6:判权读源 = global RoleBinding,故授予角色写 RoleBinding(USER, GLOBAL, ACTIVE)。
    await prisma.roleBinding.createMany({
      data: [
        {
          principalType: 'USER',
          principalId: user1Id,
          roleId: roleAId,
          scopeType: 'GLOBAL',
          status: 'ACTIVE',
        },
        {
          principalType: 'USER',
          principalId: user2Id,
          roleId: roleAId,
          scopeType: 'GLOBAL',
          status: 'ACTIVE',
        },
      ],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('权限边界', () => {
    it('未登录 → 401', async () => {
      const res = await request(httpServer(app)).post('/api/system/v1/rbac/reload').send({});
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('USER → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/rbac/reload')
        .set('Authorization', userAuth)
        .send({});
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    // P0-F PR-1(2026-05-18):入口已切 rbac.config.reload;
    // ADMIN 持 ops-admin(setUp 已绑)→ 通过。
    it('ADMIN 持 ops-admin → 200', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/rbac/reload')
        .set('Authorization', adminAuth)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ reloaded: true });
    });

    it('SUPER_ADMIN → 200', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/rbac/reload')
        .set('Authorization', superAdminAuth)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ reloaded: true });
    });
  });

  describe('scope=all', () => {
    it('入参为空 → 默认 scope=all → 兼容返回 reloaded=true', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/rbac/reload')
        .set('Authorization', superAdminAuth)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ reloaded: true });
    });

    it('显式 scope=all → 同上', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/rbac/reload')
        .set('Authorization', superAdminAuth)
        .send({ scope: 'all' });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ reloaded: true });
    });
  });

  describe('scope=user', () => {
    it('scope=user + 已存在 userId → 200 且不改变 DB-backed 角色摘要', async () => {
      const { authHeader } = await loginAs(app, 'reload-target-1');
      const before = await request(httpServer(app))
        .get('/api/system/v1/rbac/me/permissions')
        .set('Authorization', authHeader);
      const res = await request(httpServer(app))
        .post('/api/system/v1/rbac/reload')
        .set('Authorization', superAdminAuth)
        .send({ scope: 'user', userId: user1Id });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ reloaded: true });
      const after = await request(httpServer(app))
        .get('/api/system/v1/rbac/me/permissions')
        .set('Authorization', authHeader);
      expect(after.body.data).toEqual(before.body.data);
    });

    it('scope=user 缺 userId → 400', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/rbac/reload')
        .set('Authorization', superAdminAuth)
        .send({ scope: 'user' });
      expectBizError(res, BizCode.BAD_REQUEST);
    });

    it('scope=user + userId 不存在 → 200 静默成功(沿用户决策方案 A)', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/rbac/reload')
        .set('Authorization', superAdminAuth)
        .send({ scope: 'user', userId: 'nonexistent000000000000000000' });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ reloaded: true });
    });
  });

  describe('scope=role', () => {
    it('scope=role + roleId 命中 holder → 兼容返回且不改变绑定', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/rbac/reload')
        .set('Authorization', superAdminAuth)
        .send({ scope: 'role', roleId: roleAId });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ reloaded: true });
      const activeBindings = await prisma.roleBinding.count({
        where: { roleId: roleAId, status: 'ACTIVE', deletedAt: null },
      });
      expect(activeBindings).toBe(2);
    });

    it('scope=role 缺 roleId → 400', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/rbac/reload')
        .set('Authorization', superAdminAuth)
        .send({ scope: 'role' });
      expectBizError(res, BizCode.BAD_REQUEST);
    });

    it('scope=role + roleId 不存在 → 200 静默成功', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/rbac/reload')
        .set('Authorization', superAdminAuth)
        .send({ scope: 'role', roleId: 'nonexistent000000000000000000' });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ reloaded: true });
    });
  });

  describe('与 me/permissions 串联(DB-backed 兼容)', () => {
    it('reload all 前后 me/permissions 契约与当前 DB 事实保持一致', async () => {
      const { authHeader: user1Auth } = await loginAs(app, 'reload-target-1');
      const before = await request(httpServer(app))
        .get('/api/system/v1/rbac/me/permissions')
        .set('Authorization', user1Auth);

      await request(httpServer(app))
        .post('/api/system/v1/rbac/reload')
        .set('Authorization', adminAuth)
        .send({});

      const after = await request(httpServer(app))
        .get('/api/system/v1/rbac/me/permissions')
        .set('Authorization', user1Auth);
      expect(after.body.data).toEqual(before.body.data);
    });
  });

  describe('入参严格校验(forbidNonWhitelisted + IsIn)', () => {
    it('scope=invalid → 400(IsIn 拦截)', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/rbac/reload')
        .set('Authorization', superAdminAuth)
        .send({ scope: 'invalid-scope' });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('多余字段 → 400(forbidNonWhitelisted)', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/rbac/reload')
        .set('Authorization', superAdminAuth)
        .send({ scope: 'all', extraField: 'x' });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });
  });
});
