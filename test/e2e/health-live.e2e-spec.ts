import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// V1.1 TASKS.md 15.5:GET /api/system/v1/health/live(K8s liveness probe)
//
// 与 v1 已有的 health.e2e-spec.ts 互不重叠:
//   - health.e2e-spec.ts 守 v1 契约 GET /api/system/v1/health 不破坏(向后兼容)
//   - 本 spec 只覆盖 /live(15.5 新增端点)
//
// /live 是纯进程存活检查,**不查 DB / 不查外部依赖**,因此 spec 仅断言:
//   1. HTTP 200 + ResponseInterceptor 包装格式
//   2. data 仅含 { status: 'ok' },不暴露 db 字段、不暴露 terminus 原生
//      { info, error, details } 输出
//   3. @Public() 生效:无 Authorization 头也能访问
describe('GET /api/system/v1/health/live (K8s liveness)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with wrapped { code: 0, message: "ok", data: { status: "ok" } }', async () => {
    const res = await request(httpServer(app)).get('/api/system/v1/health/live');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      code: 0,
      message: 'ok',
      data: { status: 'ok' },
    });
  });

  it('data 不暴露 db 字段,也不暴露 terminus 原生 info / error / details', async () => {
    const res = await request(httpServer(app)).get('/api/system/v1/health/live');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ status: 'ok' });
    expect(res.body.data).not.toHaveProperty('db');
    expect(res.body.data).not.toHaveProperty('info');
    expect(res.body.data).not.toHaveProperty('error');
    expect(res.body.data).not.toHaveProperty('details');
  });

  it('@Public 生效:即便客户端不带任何 Authorization 也能访问', async () => {
    const res = await request(httpServer(app)).get('/api/system/v1/health/live');

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
  });
});
