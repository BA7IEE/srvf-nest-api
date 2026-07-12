import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { RbacCacheService } from '../../src/modules/permissions/rbac-cache.service';
import { RbacRolesService } from '../../src/modules/permissions/rbac-roles.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// V2.x C-6 RBAC 实施 PR #6:GET /api/system/v1/rbac/me/permissions e2e。
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
//
// P1-B characterization framing(2026-05-21 P1-B 第三单):
//   本端点在 docs/api-surface-policy.md §6 项 7 中标记为"**必须保留**,不 deprecate,不拆分"。
//   理由:`GET /api/system/v1/rbac/me/permissions` 返回 raw RBAC `Permission.code` 数组 +
//   `effectiveRoles` 业务角色摘要,语义**不等价于** `GET /api/app/v1/me/capabilities`
//   (后者返 product-level capability map:`account / activities / attendance / certificates
//   / tasks` 嵌套布尔结构,沿 D-5.3 故意不暴露 raw permission code)。
//   PC 管理后台靠 me/permissions 显示按钮可见性;App 客户端靠 me/capabilities 控制 UI。
//   本文件以下用例锁定 me/permissions 的现状契约,作为后续治理的回归保护;**不进入 P1-C
//   拆分目标**(沿 docs/api-surface-policy.md §7 P1-C "暂不拆 rbac.controller.ts")。
//   既有 6 个 describe(权限边界 / 权限点聚合 / 缓存行为 / JWT 状态校验)已锁定核心契约;
//   本次新增 2 个 describe 补 P1-B 缺口:① L3 凭证字段反向断言;② 与 me/capabilities
//   响应形态的对比(静态 key 反向断言;不跨端点调用)。

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

    // 给 userWithRoles 分配 me-role-a(终态 scoped-authz PR6:判权读源 = global RoleBinding)
    await prisma.roleBinding.create({
      data: {
        principalType: 'USER',
        principalId: userWithRolesId,
        roleId: roleAId,
        scopeType: 'GLOBAL',
        status: 'ACTIVE',
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('权限边界', () => {
    it('未登录 → 401', async () => {
      const res = await request(httpServer(app)).get('/api/system/v1/rbac/me/permissions');
      expectBizError(res, BizCode.UNAUTHORIZED);
    });
  });

  describe('权限点聚合', () => {
    it('USER 未持任何角色 → permissions=[] / effectiveRoles=[]', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/rbac/me/permissions')
        .set('Authorization', userEmptyAuth);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ permissions: [], effectiveRoles: [] });
    });

    it('USER 持业务角色(2 权限点)→ permissions 含 2 项(已排序) / effectiveRoles 1 项', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/rbac/me/permissions')
        .set('Authorization', userWithRolesAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.permissions).toEqual(['attachment.upload.cert', 'attachment.view.cert']);
      expect(res.body.data.effectiveRoles).toEqual([
        { code: 'me-role-a', displayName: '业务角色 A' },
      ]);
    });

    it('ADMIN 未持任何 RBAC 角色(seed 未实施)→ permissions=[] / effectiveRoles=[]', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/rbac/me/permissions')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ permissions: [], effectiveRoles: [] });
    });

    it('SUPER_ADMIN → permissions=Permission.code 全集(已排序;沿用户拍板方案 B)', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/rbac/me/permissions')
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
        .get('/api/system/v1/rbac/me/permissions')
        .set('Authorization', userWithRolesAuth);
      expect(cache.get(userWithRolesId)).not.toBeNull();

      // 模拟 RolePermissionsService 撤权:invalidateUser
      cache.invalidateUser(userWithRolesId);
      expect(cache.get(userWithRolesId)).toBeNull();

      // 再查应当重新聚合
      const res = await request(httpServer(app))
        .get('/api/system/v1/rbac/me/permissions')
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
        .get('/api/system/v1/rbac/me/permissions')
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
        .get('/api/system/v1/rbac/me/permissions')
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
        .get('/api/system/v1/rbac/me/permissions')
        .set('Authorization', authHeader);
      expectBizError(res, BizCode.UNAUTHORIZED);
    });
  });

  // ============ P1-B 第三单(2026-05-21):L3 凭证字段反向断言 ============
  // 沿 docs/api-surface-policy.md §2.1 ❌ "App API 永远不返回 L3 凭证字段"。
  // /api/system/v1/rbac/me/permissions 虽属 Ops surface,亦应满足同等约束(沿 §6 项 7 处置铁律)。
  describe('P1-B characterization:L3 凭证字段不得泄漏', () => {
    const L3_FORBIDDEN_FIELDS = [
      'passwordHash',
      'refreshToken',
      'tokenHash',
      'secretKey',
      'secretKeyEncrypted',
      'secretId',
      'secretIdEncrypted',
      'storageSecret',
    ] as const;

    it.each<[string, () => string]>([
      ['USER(无角色)', (): string => userEmptyAuth],
      ['USER(持业务角色)', (): string => userWithRolesAuth],
      ['ADMIN', (): string => adminAuth],
      ['SUPER_ADMIN', (): string => superAdminAuth],
    ])('%s → response 不含 L3 凭证字段 + 序列化反向兜底', async (_label, getAuth) => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/rbac/me/permissions')
        .set('Authorization', getAuth());
      expect(res.status).toBe(200);

      // 顶层 data 不含 L3 字段
      for (const f of L3_FORBIDDEN_FIELDS) {
        expect(res.body.data).not.toHaveProperty(f);
      }

      // 序列化兜底:整体响应字符串不得包含任何 L3 字段名子串(防止透露 schema)
      const serialized = JSON.stringify(res.body);
      for (const f of L3_FORBIDDEN_FIELDS) {
        expect(serialized).not.toContain(`"${f}"`);
      }
    });
  });

  // ============ P1-B 第三单(2026-05-21):与 me/capabilities 响应形态不等价 ============
  // me/permissions 返 raw `Permission.code` 字符串数组 + effectiveRoles;
  // me/capabilities 返 product-level capability 嵌套对象(account / activities / attendance /
  // certificates / tasks)。两者**不可互相替代**;前端必须区分使用。
  // 沿 docs/api-surface-policy.md §6 项 7 + D-5.3(故意不返 raw permission code 给 App)。
  describe('P1-B characterization:响应形态与 /api/app/v1/me/capabilities 不等价', () => {
    it('me/permissions 顶层 data 含 permissions / effectiveRoles,**不**含 capabilities 形态键', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/rbac/me/permissions')
        .set('Authorization', userWithRolesAuth);

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);

      // 正向锁定:me/permissions 的两键
      expect(Array.isArray(res.body.data.permissions)).toBe(true);
      expect(Array.isArray(res.body.data.effectiveRoles)).toBe(true);

      // 反向锁定:不得意外暴露 capabilities 形态的嵌套布尔结构
      // (沿 AppCapabilityResponseDto 顶层字段:account / activities / attendance /
      //  certificates / tasks / managedActivities / managedRegistrations / managedAttendance)
      const dataKeys = Object.keys(res.body.data as object);
      expect(dataKeys).toEqual(expect.arrayContaining(['permissions', 'effectiveRoles']));
      expect(dataKeys).not.toContain('account');
      expect(dataKeys).not.toContain('activities');
      expect(dataKeys).not.toContain('attendance');
      expect(dataKeys).not.toContain('certificates');
      expect(dataKeys).not.toContain('tasks');

      // permissions 是 raw RBAC code 字符串数组(沿 D7 §5.3)
      for (const code of res.body.data.permissions as unknown[]) {
        expect(typeof code).toBe('string');
      }
    });

    it('SUPER_ADMIN 路径同样不返 capabilities 形态(锁定"raw permission code 不漂移为 product capability")', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/rbac/me/permissions')
        .set('Authorization', superAdminAuth);

      expect(res.status).toBe(200);
      const dataKeys = Object.keys(res.body.data as object);
      expect(dataKeys.sort()).toEqual(['effectiveRoles', 'permissions']);
    });
  });

  describe('finding #18:角色软删主动撤权', () => {
    it('缓存命中后软删角色,持有者下一次请求立即失去旧权限', async () => {
      await request(httpServer(app))
        .get('/api/system/v1/rbac/me/permissions')
        .set('Authorization', userWithRolesAuth);
      expect(cache.get(userWithRolesId)).not.toBeNull();

      const superAdmin = await prisma.user.findFirstOrThrow({
        where: { username: 'rbac-me-su' },
        select: { id: true, username: true, status: true },
      });
      await app.get(RbacRolesService).softDelete(
        {
          id: superAdmin.id,
          username: superAdmin.username,
          role: Role.SUPER_ADMIN,
          status: superAdmin.status,
          memberId: null,
        },
        roleAId,
        { requestId: 'finding-18', ip: '127.0.0.1', ua: 'jest' },
      );

      expect(cache.get(userWithRolesId)).toBeNull();
      const res = await request(httpServer(app))
        .get('/api/system/v1/rbac/me/permissions')
        .set('Authorization', userWithRolesAuth);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ permissions: [], effectiveRoles: [] });
    });
  });
});
