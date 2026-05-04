import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// /api/docs* 必须由 ResponseInterceptor SKIP_PREFIXES 跳过包装,
// 否则前端 SDK 生成器拿到的不是 OpenAPI spec,而是 { code, message, data: <spec> }。
//
// 三条用例覆盖 setGlobalPrefix('/api') + SwaggerModule.setup('docs', ..., useGlobalPrefix:true)
// 自动派生的三个端点:HTML / JSON / YAML。
//
// 注:本 spec 依赖 ENABLE_SWAGGER=true(.env.test 已设),
// 与 swaggerEnabled = (env !== 'production' || ENABLE_SWAGGER === 'true') 一致。
describe('Swagger 跳过响应包装', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/docs 返回 Swagger UI HTML,不是 JSON 包装', async () => {
    const res = await request(httpServer(app)).get('/api/docs');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text.toLowerCase()).toContain('swagger');
    // 双重验证:res.body 不应是 ResponseInterceptor 包装结构
    expect(res.body).not.toEqual(expect.objectContaining({ code: 0, message: 'ok' }));
  });

  it('GET /api/docs-json 返回原始 OpenAPI JSON,顶层无 code/message/data', async () => {
    const res = await request(httpServer(app)).get('/api/docs-json');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(typeof res.body.openapi).toBe('string');
    expect(typeof res.body.paths).toBe('object');
    expect(res.body).not.toHaveProperty('code');
    expect(res.body).not.toHaveProperty('message');
    expect(res.body).not.toHaveProperty('data');
  });

  it('GET /api/docs-yaml 返回原始 YAML,顶层有 openapi: 行', async () => {
    const res = await request(httpServer(app)).get('/api/docs-yaml');

    expect(res.status).toBe(200);
    // YAML 顶层必有 "openapi: <版本>",作为 OpenAPI spec 的标志
    expect(res.text).toMatch(/^openapi:\s*['"]?\d/m);
  });
});
