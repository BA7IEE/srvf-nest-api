import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { httpServer } from '../helpers/http-server';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { expectBizError } from '../helpers/biz-code.assert';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 横切验证:所有非 SKIP_PREFIXES 路径的响应必须符合 { code, message, data } 三字段结构。
//
// 不依赖任何 fixtures——用例全部走 NestJS 内置异常通道:
// - 成功包装:health(已在 14.1 验证,这里再快速过一次确保结构稳定)
// - UnauthorizedException:Passport JwtAuthGuard 无 token 命中
// - NotFoundException:Nest 路由未匹配自动抛
// - BadRequestException:ValidationPipe 字段校验失败 / forbidNonWhitelisted 命中
describe('Response format (横切)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('成功响应外层固定为 { code: 0, message: "ok", data }', async () => {
    const res = await request(httpServer(app)).get('/api/system/v1/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      code: 0,
      message: 'ok',
      data: { status: 'ok' },
    });
  });

  it('未带 token 访问受保护接口 → UNAUTHORIZED 严格 message', async () => {
    const res = await request(httpServer(app)).get('/api/users/me');

    expectBizError(res, BizCode.UNAUTHORIZED);
  });

  it('访问不存在的路由 → NOT_FOUND 严格 message,不泄漏路径', async () => {
    const res = await request(httpServer(app)).get('/api/no-such-route');

    // 严格 message:断言响应 message 是 BizCode.NOT_FOUND.message,而不是
    // NestJS 默认的 "Cannot GET /api/no-such-route"——这是反向验证
    // AllExceptionsFilter.resolveHttpExceptionMessage 在 status≠400 时
    // 用 fallback,不泄漏请求路径细节。
    expectBizError(res, BizCode.NOT_FOUND);
  });

  it('POST 缺字段 → BAD_REQUEST,message 由 ValidationPipe 透传字段错误', async () => {
    const res = await request(httpServer(app)).post('/api/auth/v1/login').send({});

    // strictMessage:false:ValidationPipe 错误细节会拼成多条消息,
    // 不是 BizCode.BAD_REQUEST.message 字面量。
    expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    expect(typeof res.body.message).toBe('string');
    expect(res.body.message.length).toBeGreaterThan(0);
  });

  it('POST 多余字段 → BAD_REQUEST,message 必须包含字段名(forbidNonWhitelisted 生效)', async () => {
    const res = await request(httpServer(app))
      .post('/api/auth/v1/login')
      .send({ username: 'admin1', password: 'whatever', extra: 'y' });

    expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    expect(res.body.message).toContain('extra');
  });
});
