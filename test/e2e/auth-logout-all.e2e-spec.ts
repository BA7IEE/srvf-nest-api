import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// P0-E PR-3 e2e:POST /api/auth/v1/logout-all(沿评审稿 §8.1 / §4.4 / §7.2)。
// 走 JwtAuthGuard;撤销该 user 全部未过期且未撤销的 refresh token;返 { revokedCount }。
// 复用 password-change throttler(5/60 IP)。

describe('POST /api/auth/v1/logout-all', () => {
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

  describe('成功路径 + revokedCount', () => {
    it('单设备 logout-all → revokedCount === 1', async () => {
      await createTestUser(app, { username: 'logoutallok1' });
      const { authHeader } = await loginAs(app, 'logoutallok1');

      const res = await request(httpServer(app))
        .post('/api/auth/v1/logout-all')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data.revokedCount).toBe(1);
    });

    it('多设备 logout-all → revokedCount > 1', async () => {
      const u = await createTestUser(app, { username: 'logoutallmulti1' });

      // 模拟 3 个设备 login
      for (let i = 0; i < 3; i++) {
        await request(httpServer(app))
          .post('/api/auth/v1/login')
          .send({ username: 'logoutallmulti1', password: 'Passw0rd1!' });
      }
      const before = await prisma.refreshToken.findMany({
        where: { userId: u.id, revokedAt: null },
      });
      expect(before.length).toBe(3);

      const { authHeader } = await loginAs(app, 'logoutallmulti1'); // 第 4 次 login
      const res = await request(httpServer(app))
        .post('/api/auth/v1/logout-all')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      // 4 个 refresh 全部撤销(含本次 loginAs 拿的)
      expect(res.body.data.revokedCount).toBe(4);

      const after = await prisma.refreshToken.findMany({
        where: { userId: u.id, revokedAt: null },
      });
      expect(after.length).toBe(0);
    });

    it('logout-all 后所有 refresh 都不能再换 access', async () => {
      await createTestUser(app, { username: 'logoutallinv1' });
      const lb = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'logoutallinv1', password: 'Passw0rd1!' });
      const refreshRaw = lb.body.data.refreshToken;
      const authHeader = `Bearer ${lb.body.data.accessToken}`;

      await request(httpServer(app))
        .post('/api/auth/v1/logout-all')
        .set('Authorization', authHeader);

      const refreshRes = await request(httpServer(app))
        .post('/api/auth/v1/refresh')
        .send({ refreshToken: refreshRaw });
      expectBizError(refreshRes, BizCode.REFRESH_TOKEN_INVALID);
    });
  });

  describe('幂等', () => {
    it('两次 logout-all → 第二次 revokedCount === 0', async () => {
      await createTestUser(app, { username: 'logoutallidem1' });
      const { authHeader } = await loginAs(app, 'logoutallidem1');

      await request(httpServer(app))
        .post('/api/auth/v1/logout-all')
        .set('Authorization', authHeader);
      const res = await request(httpServer(app))
        .post('/api/auth/v1/logout-all')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.data.revokedCount).toBe(0);
    });
  });

  describe('未登录 → 40100', () => {
    it('无 Authorization 头 → UNAUTHORIZED', async () => {
      const res = await request(httpServer(app)).post('/api/auth/v1/logout-all');
      expectBizError(res, BizCode.UNAUTHORIZED);
    });
  });

  describe('audit 写入(extra.revokedCount)', () => {
    it('logout-all 后 audit_logs 含 auth.logout-all + extra.revokedCount', async () => {
      const u = await createTestUser(app, { username: 'logoutallaudit1' });
      const { authHeader } = await loginAs(app, 'logoutallaudit1');

      await request(httpServer(app))
        .post('/api/auth/v1/logout-all')
        .set('Authorization', authHeader);

      const audit = await prisma.auditLog.findFirst({
        where: { actorUserId: u.id, event: 'auth.logout-all' },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit).not.toBeNull();
      const ctx = audit?.context as { extra?: { revokedCount?: number } } | null;
      expect(ctx?.extra?.revokedCount).toBe(1);
    });
  });

  describe('access token 不被吊销(沿 D-4)', () => {
    it('logout-all 后 access token 仍可调 GET /me', async () => {
      await createTestUser(app, { username: 'logoutallaccess1' });
      const { authHeader } = await loginAs(app, 'logoutallaccess1');

      await request(httpServer(app))
        .post('/api/auth/v1/logout-all')
        .set('Authorization', authHeader);

      const me = await request(httpServer(app))
        .get('/api/users/me')
        .set('Authorization', authHeader);
      expect(me.status).toBe(200);
    });
  });
});
