import type { INestApplication } from '@nestjs/common';
import { UserStatus } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// P0-E PR-3 e2e:POST /api/auth/refresh(沿评审稿 §8.1 + §3.5 D-5 + §6 rotation 流程)。
// 关键不变式:rotation always + family revoke + absolute expiration + 失败统一 10007 不分原因。

describe('POST /api/auth/refresh', () => {
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

  describe('成功路径 + rotation 不变式', () => {
    it('正常 refresh → 200 + 新 access + 新 refresh + 字段集恰好 5 项', async () => {
      await createTestUser(app, { username: 'refreshok1' });
      const { body: loginBody } = await request(httpServer(app))
        .post('/api/auth/login')
        .send({ username: 'refreshok1', password: 'Passw0rd1!' });

      const refreshRaw = loginBody.data.refreshToken;
      const refreshExpiresAtFirst = loginBody.data.refreshExpiresAt;

      const res = await request(httpServer(app))
        .post('/api/auth/refresh')
        .send({ refreshToken: refreshRaw });

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      // 字段集恰好 5 项
      const data = res.body.data as Record<string, unknown>;
      expect(Object.keys(data).sort()).toEqual(
        ['accessToken', 'expiresIn', 'refreshExpiresAt', 'refreshToken', 'tokenType'].sort(),
      );
      expect(data.tokenType).toBe('Bearer');
      // rotation:新 refresh != 旧 refresh
      expect(data.refreshToken).not.toBe(refreshRaw);
      // absolute expiration:新 refresh 的 refreshExpiresAt 与 login 首次完全相等
      expect(data.refreshExpiresAt).toBe(refreshExpiresAtFirst);
    });

    it('refreshExpiresAt 是 ISO 8601 UTC 可被 Date 解析', async () => {
      await createTestUser(app, { username: 'refreshiso1' });
      const { body: loginBody } = await request(httpServer(app))
        .post('/api/auth/login')
        .send({ username: 'refreshiso1', password: 'Passw0rd1!' });

      const iso: string = loginBody.data.refreshExpiresAt;
      expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(Number.isFinite(new Date(iso).getTime())).toBe(true);
    });

    it('JWT payload 字段集恰好 { sub, username, iat, exp, nbf }(zero drift)', async () => {
      const user = await createTestUser(app, { username: 'refreshpld1' });
      const { body: loginBody } = await request(httpServer(app))
        .post('/api/auth/login')
        .send({ username: 'refreshpld1', password: 'Passw0rd1!' });
      const refreshRaw = loginBody.data.refreshToken;

      const res = await request(httpServer(app))
        .post('/api/auth/refresh')
        .send({ refreshToken: refreshRaw });

      const token: string = res.body.data.accessToken;
      const payloadB64 = token.split('.')[1];
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8')) as Record<
        string,
        unknown
      >;
      expect(payload.sub).toBe(user.id);
      expect(payload.username).toBe('refreshpld1');
      const allowed = new Set(['sub', 'username', 'iat', 'exp', 'nbf']);
      const extraKeys = Object.keys(payload).filter((k) => !allowed.has(k));
      expect(extraKeys).toEqual([]);
    });
  });

  describe('reuse detection → family revoke', () => {
    it('重复用同一 raw 第二次 refresh → 10007 + family 全部撤销', async () => {
      const user = await createTestUser(app, { username: 'refreshreuse1' });
      const { body: loginBody } = await request(httpServer(app))
        .post('/api/auth/login')
        .send({ username: 'refreshreuse1', password: 'Passw0rd1!' });
      const refreshRaw = loginBody.data.refreshToken;

      // 第 1 次 rotation:成功
      const ok = await request(httpServer(app))
        .post('/api/auth/refresh')
        .send({ refreshToken: refreshRaw });
      expect(ok.status).toBe(200);
      const newRefresh = ok.body.data.refreshToken;

      // 第 2 次用旧 raw → 重放命中
      const replay = await request(httpServer(app))
        .post('/api/auth/refresh')
        .send({ refreshToken: refreshRaw });
      expectBizError(replay, BizCode.REFRESH_TOKEN_INVALID);

      // family 全部撤销:rotation 出来的新 refresh 也不能再换 access
      const newRefreshAfter = await request(httpServer(app))
        .post('/api/auth/refresh')
        .send({ refreshToken: newRefresh });
      expectBizError(newRefreshAfter, BizCode.REFRESH_TOKEN_INVALID);

      // DB 验证:该 user 所有 refresh 全部 revokedReason = 'family-revoked' 或 'rotated'
      const all = await prisma.refreshToken.findMany({ where: { userId: user.id } });
      expect(all.length).toBeGreaterThan(0);
      for (const row of all) {
        expect(row.revokedAt).not.toBeNull();
        expect(['family-revoked', 'rotated']).toContain(row.revokedReason);
      }
    });
  });

  describe('失败 4 场景统一 10007(不区分子原因)', () => {
    let resNotFound: request.Response;
    let resRevoked: request.Response;
    let resExpired: request.Response;
    let resUserDisabled: request.Response;

    beforeAll(async () => {
      // 1. 不存在
      resNotFound = await request(httpServer(app))
        .post('/api/auth/refresh')
        .send({ refreshToken: 'nonexistent-token-raw' });

      // 2. 已撤销(走 logout 来撤销)
      await createTestUser(app, { username: 'refreshrev1' });
      const { body: lb1 } = await request(httpServer(app))
        .post('/api/auth/login')
        .send({ username: 'refreshrev1', password: 'Passw0rd1!' });
      await request(httpServer(app))
        .post('/api/auth/logout')
        .send({ refreshToken: lb1.data.refreshToken });
      resRevoked = await request(httpServer(app))
        .post('/api/auth/refresh')
        .send({ refreshToken: lb1.data.refreshToken });

      // 3. 已过期(手工把 DB 里 expiresAt 改为过去)
      const user2 = await createTestUser(app, { username: 'refreshexp1' });
      const { body: lb2 } = await request(httpServer(app))
        .post('/api/auth/login')
        .send({ username: 'refreshexp1', password: 'Passw0rd1!' });
      await prisma.refreshToken.updateMany({
        where: { userId: user2.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      resExpired = await request(httpServer(app))
        .post('/api/auth/refresh')
        .send({ refreshToken: lb2.data.refreshToken });

      // 4. user 被禁
      const user3 = await createTestUser(app, { username: 'refreshdis1' });
      const { body: lb3 } = await request(httpServer(app))
        .post('/api/auth/login')
        .send({ username: 'refreshdis1', password: 'Passw0rd1!' });
      await prisma.user.update({
        where: { id: user3.id },
        data: { status: UserStatus.DISABLED },
      });
      resUserDisabled = await request(httpServer(app))
        .post('/api/auth/refresh')
        .send({ refreshToken: lb3.data.refreshToken });
    });

    it('不存在 → 10007', () => expectBizError(resNotFound, BizCode.REFRESH_TOKEN_INVALID));
    it('已撤销 → 10007', () => expectBizError(resRevoked, BizCode.REFRESH_TOKEN_INVALID));
    it('已过期 → 10007', () => expectBizError(resExpired, BizCode.REFRESH_TOKEN_INVALID));
    it('user 被禁 → 10007', () => expectBizError(resUserDisabled, BizCode.REFRESH_TOKEN_INVALID));

    it('4 场景响应体 + status 完全相等(toEqual 严格比较)', () => {
      const reference = { status: resNotFound.status, body: resNotFound.body };
      for (const res of [resRevoked, resExpired, resUserDisabled]) {
        expect(res.status).toBe(reference.status);
        expect(res.body).toEqual(reference.body);
      }
    });
  });

  describe('DTO 校验', () => {
    it('缺 refreshToken → BAD_REQUEST', async () => {
      const res = await request(httpServer(app)).post('/api/auth/refresh').send({});
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('额外字段(forbidNonWhitelisted)→ BAD_REQUEST', async () => {
      const res = await request(httpServer(app))
        .post('/api/auth/refresh')
        .send({ refreshToken: 'x', extra: 'y' });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });
  });

  describe('反向使用 loginAs helper(冒烟)', () => {
    it('login + refresh 流;loginAs 仍可正常拿 access', async () => {
      await createTestUser(app, { username: 'refreshflow1' });
      const cred = await loginAs(app, 'refreshflow1');
      expect(cred.authHeader).toMatch(/^Bearer /);
    });
  });
});
