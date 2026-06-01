import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { TEST_PASSWORD, createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// Route B Phase 1a alias 双路径回归(沿 docs/api-surface-migration-plan.md §3 / §6 Phase 1)。
// 目标:证明新前缀路径(auth/v1、system/v1/health)与老路径**行为一致**(alias = same handler,
// 零 behavior drift),且老路径无回归。老路径的完整行为矩阵由既有 auth-login / health spec 覆盖,
// 本 spec 只锁"新路径可服务 + 与老路径等价"。
describe('Route B Phase 1a alias(auth/v1 + system/v1/health)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('health → system/v1/health 双挂', () => {
    it('GET /api/system/v1/health 与老 /api/health 返回完全一致的包装体', async () => {
      const oldRes = await request(httpServer(app)).get('/api/health');
      const newRes = await request(httpServer(app)).get('/api/system/v1/health');

      expect(newRes.status).toBe(200);
      expect(newRes.body).toEqual({ code: 0, message: 'ok', data: { status: 'ok' } });
      // 新老路径 status + body 严格相等(alias 行为等价)
      expect(newRes.status).toBe(oldRes.status);
      expect(newRes.body).toEqual(oldRes.body);
    });

    it('GET /api/system/v1/health/live 与 /ready 均 200(子路径随数组前缀一并挂载)', async () => {
      const live = await request(httpServer(app)).get('/api/system/v1/health/live');
      const ready = await request(httpServer(app)).get('/api/system/v1/health/ready');
      expect(live.status).toBe(200);
      expect(ready.status).toBe(200);
    });
  });

  describe('auth → auth/v1 双挂', () => {
    it('POST /api/auth/v1/login 正确凭证 → 200 + 标准 LoginResponse(新路径可服务)', async () => {
      await createTestUser(app, { username: 'phase1alias1' });

      const res = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'phase1alias1', password: TEST_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(typeof res.body.data.accessToken).toBe('string');
      expect(res.body.data.accessToken.split('.')).toHaveLength(3);
      expect(res.body.data.tokenType).toBe('Bearer');
      expect(typeof res.body.data.refreshToken).toBe('string');
    });

    it('老 /api/auth/login 与新 /api/auth/v1/login 对同一凭证行为等价(均 200 + code 0)', async () => {
      await createTestUser(app, { username: 'phase1alias2' });

      const oldRes = await request(httpServer(app))
        .post('/api/auth/login')
        .send({ username: 'phase1alias2', password: TEST_PASSWORD });
      const newRes = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'phase1alias2', password: TEST_PASSWORD });

      expect(oldRes.status).toBe(200);
      expect(newRes.status).toBe(200);
      expect(newRes.body.code).toBe(oldRes.body.code);
      // 两路径返回的字段集一致(都是 5 项 LoginResponse)
      const newData = newRes.body.data as Record<string, unknown>;
      const oldData = oldRes.body.data as Record<string, unknown>;
      expect(Object.keys(newData).sort()).toEqual(Object.keys(oldData).sort());
    });
  });
});
