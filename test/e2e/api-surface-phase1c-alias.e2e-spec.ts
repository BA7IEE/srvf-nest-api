import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// Route B Phase 1c alias 双路径回归(沿 docs/api-surface-migration-plan.md §3 / §6 Phase 1)。
// Admin surface(Admin-* tag)v2/* + users → admin/v1/* 双挂(70 路由)。全 70 路由的注册由
// contract EXPECTED_ROUTES(423)精确锁定;本 spec 取代表性 authed admin 端点,证明新前缀
// 路径**实际可服务**且与老 v2 / 老 users 路径**行为等价**(alias = same handler,零 drift)。
describe('Route B Phase 1c alias(admin/v1 Admin surface)', () => {
  let app: INestApplication;
  let auth: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    await createTestUser(app, { username: 'phase1c-su', role: Role.SUPER_ADMIN });
    auth = (await loginAs(app, 'phase1c-su')).authHeader;
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/admin/v1/members 与老 /api/v2/members 返回等价(authed,200 + 同 body)', async () => {
    const oldRes = await request(httpServer(app)).get('/api/v2/members').set('Authorization', auth);
    const newRes = await request(httpServer(app))
      .get('/api/admin/v1/members')
      .set('Authorization', auth);

    expect(newRes.status).toBe(200);
    expect(newRes.status).toBe(oldRes.status);
    expect(newRes.body).toEqual(oldRes.body);
  });

  it('GET /api/admin/v1/users 与老 root-legacy /api/users 返回等价(authed,200 + 同 body)', async () => {
    const oldRes = await request(httpServer(app)).get('/api/users').set('Authorization', auth);
    const newRes = await request(httpServer(app))
      .get('/api/admin/v1/users')
      .set('Authorization', auth);

    expect(newRes.status).toBe(200);
    expect(newRes.status).toBe(oldRes.status);
    expect(newRes.body).toEqual(oldRes.body);
  });

  it('GET /api/admin/v1/activities 可服务(authed,200 + 标准包装)', async () => {
    const res = await request(httpServer(app))
      .get('/api/admin/v1/activities')
      .set('Authorization', auth);

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
  });
});
