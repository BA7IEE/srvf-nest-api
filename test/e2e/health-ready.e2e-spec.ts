import type { INestApplication } from '@nestjs/common';
import { PrismaHealthIndicator } from '@nestjs/terminus';
import request from 'supertest';
import { httpServer } from '../helpers/http-server';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { expectBizError } from '../helpers/biz-code.assert';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// ARCHITECTURE.md §11.1:GET /api/system/v1/health/ready(K8s readiness probe)
//
// 覆盖三条核心路径:
//   1. 成功路径:DB 连通 → 200 + { status: 'ok', db: 'up' }
//   2. 失败路径:DB 不可用 → HTTP 500 + code 50000 + data null
//      (当前行为由 BizCode.INTERNAL_ERROR.httpStatus = 500 + 全局异常过滤器锁定,
//       HTTP status 语义沿 docs/reference/response-pagination-errors.md §5。
//       历史 V1.1 文档的 "503" 仅为历史口径,不作当前权威。
//       后续若需标准 503,应单独新增 BizCode.SERVICE_UNAVAILABLE,不在 15.5 内处理。)
//   3. 包装语义:不暴露 terminus 原生 { info, error, details } 输出
//
// 失败路径用 jest.spyOn 把 PrismaHealthIndicator.pingCheck 临时换成抛错版,
// 不实际断 DB 连接(避免污染其它 spec 与并行测试)。afterEach 还原。
describe('GET /api/system/v1/health/ready (K8s readiness)', () => {
  let app: INestApplication;
  let prismaIndicator: PrismaHealthIndicator;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prismaIndicator = app.get(PrismaHealthIndicator);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it('DB 连通时返回 200 + wrapped { data: { status: "ok", db: "up" } }', async () => {
    const res = await request(httpServer(app)).get('/api/system/v1/health/ready');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      code: 0,
      message: 'ok',
      data: { status: 'ok', db: 'up' },
    });
  });

  it('成功路径:data 不暴露 terminus 原生 info / error / details', async () => {
    const res = await request(httpServer(app)).get('/api/system/v1/health/ready');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ status: 'ok', db: 'up' });
    expect(res.body.data).not.toHaveProperty('info');
    expect(res.body.data).not.toHaveProperty('error');
    expect(res.body.data).not.toHaveProperty('details');
  });

  it('DB 不可用时返回 HTTP 500 + code 50000 + data null(方案 A)', async () => {
    // 模拟 DB 探测失败:让 PrismaHealthIndicator.pingCheck 抛错。
    // HealthCheckService.check 内部检测到非 HealthCheckError 会重新抛出,
    // 被 controller 的 try/catch 接住,转抛 BizException(BizCode.INTERNAL_ERROR)。
    jest.spyOn(prismaIndicator, 'pingCheck').mockRejectedValue(new Error('simulated DB outage'));

    const res = await request(httpServer(app)).get('/api/system/v1/health/ready');

    // expectBizError 会同时断言 HTTP status === BizCode.httpStatus(500)
    // 与 body.code === BizCode.code(50000) 和 body.data === null。
    expectBizError(res, BizCode.INTERNAL_ERROR);
  });

  it('@Public 生效:即便客户端不带任何 Authorization 也能访问', async () => {
    const res = await request(httpServer(app)).get('/api/system/v1/health/ready');

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
  });
});
