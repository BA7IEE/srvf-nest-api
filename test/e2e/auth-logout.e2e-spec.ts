import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Role } from '@prisma/client';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// P0-E PR-3 e2e:POST /api/auth/v1/logout(沿评审稿 §8.1 / §4.3 / §7.1)。
// 幂等:不存在 / 已撤销 / 已过期 → 仍 200 + data:null。
// 只撤销当前 row;不吊销 access token(沿 D-4)。

describe('POST /api/auth/v1/logout', () => {
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

  describe('成功路径', () => {
    it('正常 logout → 200 + DB 内 revokedAt != null + revokedReason="logout"', async () => {
      const u = await createTestUser(app, { username: 'logoutok1' });
      const { body: lb } = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'logoutok1', password: 'Passw0rd1!' });

      const res = await request(httpServer(app))
        .post('/api/auth/v1/logout')
        .send({ refreshToken: lb.data.refreshToken });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ code: 0, message: 'ok', data: null });

      const row = await prisma.refreshToken.findFirst({ where: { userId: u.id } });
      expect(row?.revokedAt).not.toBeNull();
      expect(row?.revokedReason).toBe('logout');
    });

    it('logout 后同一 refresh 再 refresh → 10007', async () => {
      await createTestUser(app, { username: 'logoutreuse1' });
      const { body: lb } = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'logoutreuse1', password: 'Passw0rd1!' });
      await request(httpServer(app))
        .post('/api/auth/v1/logout')
        .send({ refreshToken: lb.data.refreshToken });

      const res = await request(httpServer(app))
        .post('/api/auth/v1/refresh')
        .send({ refreshToken: lb.data.refreshToken });
      expectBizError(res, BizCode.REFRESH_TOKEN_INVALID);
    });
  });

  describe('幂等', () => {
    it('不存在的 refresh → 仍 200 且 auth.logout audit 零新增(finding #9)', async () => {
      const before = await prisma.auditLog.count({ where: { event: 'auth.logout' } });
      const res = await request(httpServer(app))
        .post('/api/auth/v1/logout')
        .send({ refreshToken: 'nonexistent-raw' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ code: 0, message: 'ok', data: null });
      const after = await prisma.auditLog.count({ where: { event: 'auth.logout' } });
      expect(after).toBe(before);
    });

    it('已撤销的 refresh → 仍 200(幂等)', async () => {
      await createTestUser(app, { username: 'logoutidem1' });
      const { body: lb } = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'logoutidem1', password: 'Passw0rd1!' });
      await request(httpServer(app))
        .post('/api/auth/v1/logout')
        .send({ refreshToken: lb.data.refreshToken });

      const res = await request(httpServer(app))
        .post('/api/auth/v1/logout')
        .send({ refreshToken: lb.data.refreshToken });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ code: 0, message: 'ok', data: null });
    });

    it('已过期的 refresh → 仍 200', async () => {
      const u = await createTestUser(app, { username: 'logoutexp1' });
      const { body: lb } = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'logoutexp1', password: 'Passw0rd1!' });
      await prisma.refreshToken.updateMany({
        where: { userId: u.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const res = await request(httpServer(app))
        .post('/api/auth/v1/logout')
        .send({ refreshToken: lb.data.refreshToken });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ code: 0, message: 'ok', data: null });
    });
  });

  describe('access token 不被吊销(沿 D-4)', () => {
    it('logout 后旧 access token 仍可调 GET /me', async () => {
      await createTestUser(app, { username: 'logoutaccess1', role: Role.SUPER_ADMIN });
      const { body: lb } = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'logoutaccess1', password: 'Passw0rd1!' });

      const authHeader = `Bearer ${lb.data.accessToken}`;
      await request(httpServer(app))
        .post('/api/auth/v1/logout')
        .send({ refreshToken: lb.data.refreshToken });

      const meRes = await request(httpServer(app))
        .get('/api/admin/v1/users')
        .set('Authorization', authHeader);
      // access token 15m 内仍有效(P0-E v1 D-4:不主动吊销 access;CLAUDE/AGENTS §9)
      expect(meRes.status).toBe(200);
      expect(meRes.body.code).toBe(0);
    });
  });

  describe('access token 不必传(@Public)', () => {
    it('不带 Authorization 头也能 logout(refresh token 自身即凭证)', async () => {
      await createTestUser(app, { username: 'logoutpub1' });
      const { body: lb } = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'logoutpub1', password: 'Passw0rd1!' });

      const res = await request(httpServer(app))
        .post('/api/auth/v1/logout')
        .send({ refreshToken: lb.data.refreshToken });
      expect(res.status).toBe(200);
    });
  });

  describe('DTO 校验', () => {
    it('缺 refreshToken → BAD_REQUEST', async () => {
      const res = await request(httpServer(app)).post('/api/auth/v1/logout').send({});
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });
  });

  describe('logout 只撤销当前 row,不动同 family 其他链', () => {
    it('rotation 后 logout 旧 token → 旧已 rotated,新 refresh 仍可用', async () => {
      const u = await createTestUser(app, { username: 'logoutfam1' });
      const { body: lb } = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'logoutfam1', password: 'Passw0rd1!' });
      const r1 = lb.data.refreshToken;

      const ok = await request(httpServer(app))
        .post('/api/auth/v1/refresh')
        .send({ refreshToken: r1 });
      expect(ok.status).toBe(200);
      const r2 = ok.body.data.refreshToken;

      // logout 旧 r1(已经 rotated;按设计逻辑,旧 row.revokedAt != null,logout 路径
      // 走幂等;不会再额外撤销 r2)
      const logoutRes = await request(httpServer(app))
        .post('/api/auth/v1/logout')
        .send({ refreshToken: r1 });
      expect(logoutRes.status).toBe(200);

      // r2 仍可用
      const r2use = await request(httpServer(app))
        .post('/api/auth/v1/refresh')
        .send({ refreshToken: r2 });
      expect(r2use.status).toBe(200);

      // DB:r2 仍未 revoke 直到本次 rotation;rotation 后 r2 也 revokedReason='rotated'
      const all = await prisma.refreshToken.findMany({
        where: { userId: u.id },
        orderBy: { createdAt: 'asc' },
      });
      // r1 (rotated) + r2 (rotated) + r3 (active)
      expect(all.length).toBe(3);
    });
  });
});
