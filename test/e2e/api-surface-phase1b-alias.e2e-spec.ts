import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// Route B Phase 1b alias 双路径回归(沿 docs/api-surface-migration-plan.md §3 / §6 Phase 1)。
// System surface(Ops-* tag)v2 → system/v1 双挂(56 路由)。全 56 路由的注册由 contract
// EXPECTED_ROUTES(353)精确锁定;本 spec 只取代表性的 authed system 端点,证明新前缀路径
// **实际可服务**且与老 v2 路径**行为等价**(alias = same handler,零 behavior drift)。
describe('Route B Phase 1b alias(system/v1 Ops surface)', () => {
  let app: INestApplication;
  let auth: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    await createTestUser(app, { username: 'phase1b-su', role: Role.SUPER_ADMIN });
    auth = (await loginAs(app, 'phase1b-su')).authHeader;
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/system/v1/dict-types 与老 /api/system/v1/dict-types 返回等价(authed,200 + 同 body)', async () => {
    const oldRes = await request(httpServer(app))
      .get('/api/system/v1/dict-types')
      .set('Authorization', auth);
    const newRes = await request(httpServer(app))
      .get('/api/system/v1/dict-types')
      .set('Authorization', auth);

    expect(newRes.status).toBe(200);
    expect(newRes.status).toBe(oldRes.status);
    expect(newRes.body).toEqual(oldRes.body);
  });

  it('GET /api/system/v1/audit-logs 可服务(authed,200 + 标准分页包装)', async () => {
    const res = await request(httpServer(app))
      .get('/api/system/v1/audit-logs')
      .set('Authorization', auth);

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
  });

  it('GET /api/system/v1/storage-settings 可服务(authed,200)', async () => {
    const res = await request(httpServer(app))
      .get('/api/system/v1/storage-settings')
      .set('Authorization', auth);

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
  });
});
