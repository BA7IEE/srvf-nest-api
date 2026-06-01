import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { httpServer } from '../helpers/http-server';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 抽样验证 BizCode.X.httpStatus 与实际 HTTP status 一致——
// 防止未来新增 BizCode 时漏配 / 写错 httpStatus 字段。
//
// 这里**不写死数字**,直接用 BizCode 常量做断言;只要常量值与实际响应不一致,
// 用例就会挂,这正是它的反向保护价值。
//
// 14.3 阶段只覆盖通用 HTTP 段(401 / 404 / 400),业务级 BizCode
// (USER_NOT_FOUND / LOGIN_FAILED / LAST_SUPER_ADMIN_PROTECTED 等)
// 在 14.4+ 各自的业务 spec 内顺带覆盖。
describe('BizCode httpStatus ↔ HTTP status 一致性(抽样)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('UNAUTHORIZED:无 token 访问受保护接口 → res.status === BizCode.UNAUTHORIZED.httpStatus', async () => {
    const res = await request(httpServer(app)).get('/api/users/me');

    expect(res.status).toBe(BizCode.UNAUTHORIZED.httpStatus);
    expect(res.body.code).toBe(BizCode.UNAUTHORIZED.code);
  });

  it('NOT_FOUND:访问不存在的路由 → res.status === BizCode.NOT_FOUND.httpStatus', async () => {
    const res = await request(httpServer(app)).get('/api/no-such-route');

    expect(res.status).toBe(BizCode.NOT_FOUND.httpStatus);
    expect(res.body.code).toBe(BizCode.NOT_FOUND.code);
  });

  it('BAD_REQUEST:ValidationPipe 失败 → res.status === BizCode.BAD_REQUEST.httpStatus', async () => {
    const res = await request(httpServer(app)).post('/api/auth/v1/login').send({});

    expect(res.status).toBe(BizCode.BAD_REQUEST.httpStatus);
    expect(res.body.code).toBe(BizCode.BAD_REQUEST.code);
  });
});
