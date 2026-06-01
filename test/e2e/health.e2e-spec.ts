import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 14.1 阶段唯一的 smoke 测试,目的是验证 E2E 测试链路能跑通:
// - createTestApp() 与 main.ts 的全局配置一致(全局前缀 /api、ResponseInterceptor)
// - supertest 经 app.getHttpServer() 内存 HTTP 工作正常
// - health 走包装(在 SKIP_PREFIXES 之外),响应外层是 { code, message, data }
//
// 14.2 起 beforeAll 内追加 resetDb(app):health 不读 DB,调用它纯粹为打通 truncate 链路,
// 让任何未来 spec 默认有干净表面。
//
// 完整 health / response-format / swagger 等用例集见 14.3。
describe('GET /api/system/v1/health (smoke)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with wrapped { code: 0, message: "ok", data: { status: "ok" } }', async () => {
    const res = await request(httpServer(app)).get('/api/system/v1/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      code: 0,
      message: 'ok',
      data: { status: 'ok' },
    });
  });
});
