import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { httpServer } from '../helpers/http-server';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { TEST_PASSWORD, createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// P1-B characterization tests — Root Legacy `/api/users/me*` 端点行为锁定。
//
// 目标:在 P1-C 物理拆 `users.controller.ts` Mixed Controller 之前,
// 显式锁定 3 个 Root Legacy mobile-like 端点的现状行为,作为拆分前的回归保护。
//
// 沿 docs/api-surface-policy.md §5 项 1 + §6 项 1/2/3 + §7 P1-B。
//
// 覆盖 3 个端点:
//   - GET    /api/users/me
//   - PATCH  /api/users/me
//   - PUT    /api/users/me/password
//
// 与既有 spec 的关系(本文件**只补缺口**,不重复覆盖):
//   - test/e2e/users-me.e2e-spec.ts       已锁:字段集 / PATCH 白名单 / 长度边界
//   - test/e2e/users-change-my-password.e2e-spec.ts  已锁:成功路径 / 错误码 / DTO / 限流 / audit
//   - test/e2e/auth-jwt-guard.e2e-spec.ts            已锁:7 种 token 失效路径
//
// 本文件补的缺口:
//   1. **完全未带 Authorization 头** 时 3 个端点的 401 行为(既有 spec 只测了 token 错的路径,
//      没测"完全无 header"路径)
//   2. **L3 凭证字段非泄漏断言**:`refreshToken` / `tokenHash` / `secretKey*` / `secretId*` /
//      `passwordHash` / `deletedAt` 在 3 个端点响应里**全部不得出现**;既有 spec 仅断言
//      `passwordHash` / `deletedAt`,未覆盖更广的 L3 集合(沿 docs/api-surface-policy.md §2.1)
//   3. **3 端点联动 contract guard**:一次登录贯通 GET → PATCH → PUT,确认 path 存在且
//      Root Legacy contract zero drift

const EXPECTED_USER_RESPONSE_KEYS = [
  'avatarKey',
  'createdAt',
  'email',
  'id',
  'lastLoginAt',
  'nickname',
  'role',
  'status',
  'updatedAt',
  'username',
].sort();

// 沿 docs/api-surface-policy.md §2.1 ❌ "App API 永远不返回 L3 凭证字段"。
// users/me Root Legacy 端点 v0.15.0 起亦应满足同等约束(沿 §6 项 1/2/3 处置铁律)。
const L3_FORBIDDEN_FIELDS = [
  'passwordHash',
  'refreshToken',
  'tokenHash',
  'secretKey',
  'secretKeyEncrypted',
  'secretId',
  'secretIdEncrypted',
  'storageSecret',
  'deletedAt',
] as const;

function assertNoL3FieldLeak(data: Record<string, unknown> | undefined | null): void {
  for (const f of L3_FORBIDDEN_FIELDS) {
    expect(data).not.toHaveProperty(f);
  }
}

describe('Root Legacy users/me endpoints (P1-B characterization)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  // ============ A. Auth guard:完全未带 Authorization 头 ============
  describe('A. 完全未登录(无 Authorization 头) → UNAUTHORIZED', () => {
    it('GET /api/users/me 无 header → 40100 + HTTP 401 + data=null', async () => {
      const res = await request(httpServer(app)).get('/api/users/me');
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('PATCH /api/users/me 无 header → 40100 + HTTP 401 + 数据不变', async () => {
      const user = await createTestUser(app, { username: 'p1bnoauthpatch1' });
      const before = await prisma.user.findUnique({ where: { id: user.id } });

      const res = await request(httpServer(app))
        .patch('/api/users/me')
        .send({ nickname: 'Hacker' });
      expectBizError(res, BizCode.UNAUTHORIZED);

      const after = await prisma.user.findUnique({ where: { id: user.id } });
      expect(after?.nickname).toBe(before?.nickname ?? null);
    });

    it('PUT /api/users/me/password 无 header → 40100 + HTTP 401 + passwordHash 不变', async () => {
      const user = await createTestUser(app, { username: 'p1bnoauthpwd1' });
      const before = await prisma.user.findUnique({ where: { id: user.id } });

      const res = await request(httpServer(app))
        .put('/api/users/me/password')
        .send({ oldPassword: TEST_PASSWORD, newPassword: 'BrandNew1!' });
      expectBizError(res, BizCode.UNAUTHORIZED);

      const after = await prisma.user.findUnique({ where: { id: user.id } });
      expect(after?.passwordHash).toBe(before?.passwordHash);
    });
  });

  // ============ B. GET /api/users/me Root Legacy L3 字段反向断言 ============
  describe('B. GET /api/users/me Root Legacy 响应不得泄漏 L3 字段', () => {
    it('USER 登录 → 200 + 字段集 = 10 + L3 字段全部缺席', async () => {
      await createTestUser(app, { username: 'p1bgetl3leak1', role: Role.USER });
      const { authHeader } = await loginAs(app, 'p1bgetl3leak1');

      const res = await request(httpServer(app))
        .get('/api/users/me')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.message).toBe('ok');

      // 字段集严格断言:重复 users-me.e2e-spec.ts 的字段锁(范围扩到 P1-B 拆分前的状态保护)
      expect(Object.keys(res.body.data as object).sort()).toEqual(EXPECTED_USER_RESPONSE_KEYS);

      // L3 凭证字段反向断言(本 spec 独有覆盖)
      assertNoL3FieldLeak(res.body.data as Record<string, unknown>);
    });

    it('SUPER_ADMIN 登录 → 同样不得泄漏 L3(角色升级不应放宽字段集)', async () => {
      await createTestUser(app, { username: 'p1bgetl3leak2', role: Role.SUPER_ADMIN });
      const { authHeader } = await loginAs(app, 'p1bgetl3leak2');

      const res = await request(httpServer(app))
        .get('/api/users/me')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      assertNoL3FieldLeak(res.body.data as Record<string, unknown>);
      expect(Object.keys(res.body.data as object).sort()).toEqual(EXPECTED_USER_RESPONSE_KEYS);
    });
  });

  // ============ C. PATCH /api/users/me Root Legacy 响应 + db 反向断言 ============
  describe('C. PATCH /api/users/me Root Legacy 响应不得泄漏 L3 字段', () => {
    it('改 nickname 成功 → 200,响应不含 L3 字段,字段集仍为 10', async () => {
      const user = await createTestUser(app, { username: 'p1bpatchl31' });
      const { authHeader } = await loginAs(app, 'p1bpatchl31');

      const res = await request(httpServer(app))
        .patch('/api/users/me')
        .set('Authorization', authHeader)
        .send({ nickname: 'Charlie' });

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data.nickname).toBe('Charlie');
      expect(Object.keys(res.body.data as object).sort()).toEqual(EXPECTED_USER_RESPONSE_KEYS);
      assertNoL3FieldLeak(res.body.data as Record<string, unknown>);

      // 持久化反向断言:db 也不应被越权写入 L3 字段(P1-B 没改任何 DTO 白名单,只锁现状)
      const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
      expect(dbUser?.nickname).toBe('Charlie');
      // role / status 仍为 fixture 默认值,未被越权改
      expect(dbUser?.role).toBe(Role.USER);
    });
  });

  // ============ D. PUT /api/users/me/password Root Legacy 响应反向断言 ============
  describe('D. PUT /api/users/me/password Root Legacy 响应不得泄漏 L3 字段', () => {
    it('改密成功 → 200,响应不含 L3 字段(包括 newPassword 明文)', async () => {
      const NEW_PASSWORD = 'BrandNew1!';
      const user = await createTestUser(app, { username: 'p1bpwdl31' });
      const { authHeader } = await loginAs(app, 'p1bpwdl31');

      const before = await prisma.user.findUnique({ where: { id: user.id } });

      const res = await request(httpServer(app))
        .put('/api/users/me/password')
        .set('Authorization', authHeader)
        .send({ oldPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(Object.keys(res.body.data as object).sort()).toEqual(EXPECTED_USER_RESPONSE_KEYS);
      assertNoL3FieldLeak(res.body.data as Record<string, unknown>);

      // 旁断:序列化响应不得包含密码明文或 bcrypt hash 子串
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(NEW_PASSWORD);
      expect(serialized).not.toContain(TEST_PASSWORD);
      expect(serialized).not.toContain('$2'); // bcrypt prefix

      // db passwordHash 实际已变(行为锁定,沿 users-change-my-password.e2e-spec.ts §7.7)
      const after = await prisma.user.findUnique({ where: { id: user.id } });
      expect(after?.passwordHash).not.toBe(before?.passwordHash);
    });
  });

  // ============ E. 3 端点联动 contract guard:path 存在 + Root Legacy 全链路 ============
  describe('E. Root Legacy contract guard:3 端点一次登录贯通', () => {
    it('GET → PATCH → PUT 一次登录依次成功,3 path 全部存在(非 404)', async () => {
      const NEW_PASSWORD = 'BrandNew1!';
      await createTestUser(app, { username: 'p1bcontract1' });
      const { authHeader } = await loginAs(app, 'p1bcontract1');

      // GET
      const getRes = await request(httpServer(app))
        .get('/api/users/me')
        .set('Authorization', authHeader);
      expect(getRes.status).toBe(200);
      expect(getRes.body.data.username).toBe('p1bcontract1');
      assertNoL3FieldLeak(getRes.body.data as Record<string, unknown>);

      // PATCH
      const patchRes = await request(httpServer(app))
        .patch('/api/users/me')
        .set('Authorization', authHeader)
        .send({ nickname: 'Dave' });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.data.nickname).toBe('Dave');
      assertNoL3FieldLeak(patchRes.body.data as Record<string, unknown>);

      // PUT password(用新密码登录验证生效)
      const putRes = await request(httpServer(app))
        .put('/api/users/me/password')
        .set('Authorization', authHeader)
        .send({ oldPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });
      expect(putRes.status).toBe(200);
      assertNoL3FieldLeak(putRes.body.data as Record<string, unknown>);

      // 新密码可登录(锁定改密生效)
      const reLogin = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'p1bcontract1', password: NEW_PASSWORD });
      expect(reLogin.status).toBe(200);
      expect(typeof reLogin.body.data.accessToken).toBe('string');
    });
  });
});
