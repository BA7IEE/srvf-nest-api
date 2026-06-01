import type { IncomingMessage } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { httpServer } from '../helpers/http-server';
import { buildHttpLogProps } from '../../src/app.module';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// V1.1 TASKS.md 15.3 验收:请求 ID 贯通(x-request-id)
//
// 黑盒(经 supertest 打真实 HTTP 接口):
//   1. 客户端不传 x-request-id → 响应头有合法生成值(cuid-like:^c[0-9a-z]{32,}$)
//   2. 客户端传 x-request-id: <legal value> → 响应头原样回显
//   3. 客户端传非法值(超长 / 含禁用字符) → 后端忽略并生成新值,不暴露给前端
//   4. 响应体 { code, message, data } 永不包含 reqId / requestId 字段
//      (任务卡明确要求"不在响应体的 data / message / code 中暴露 requestId")
//
// 白盒(直接调用 customProps 工厂):
//   5. buildHttpLogProps(req) 返回的对象顶层必须有 reqId,值来自 req.id
//      (即 pino-http 用 genReqId 写入的 ID,与响应头 x-request-id 同一来源)。
//      test 环境 LOG_LEVEL='silent'(buildLoggerModuleParams 强制)使日志不可观测,
//      直接调用工厂函数等价于"customProps 真的返回了 reqId",不需要触碰
//      test/setup/test-app.ts 把日志 destination 重定向到 buffer。
//
// 手工日志验证(silent 模式压制了真实日志输出,需用非 silent 启动 dev server 复核):
//   1. APP_ENV=development LOG_LEVEL=info pnpm start(其余环境变量参考 .env.example)
//   2. curl -i -H "x-request-id: my-trace-123" http://localhost:3000/api/system/v1/health
//   3. server stdout 中的 "request completed" 日志条目应同时出现:
//        - 顶层 reqId: "my-trace-123"(本次新增,由 buildHttpLogProps 注入)
//        - req.id: "my-trace-123"(pino-http 默认行为)
//        - res.headers["x-request-id"]: "my-trace-123"(genReqId 写回)
//      三处值相同 = 单一来源(genReqId),日志与响应头不会漂移。
//
// 选用接口:
//   - GET /api/system/v1/health(@Public,无需 token):覆盖 GET 路径
//   - GET /api/admin/v1/users(受保护,无 token → 401):覆盖异常路径(确认错误响应也带 reqId 头)
const REQUEST_ID_HEADER = 'x-request-id';
// 后端生成的 ID 形态:`c` 前缀 + base36 时间戳(>=8 字符) + 24 字符 hex,长度 >=33。
// 这里只验证语义形态(c 开头 + alphanumeric + 长度合理),不锁死长度上限,避免 base36
// 时间戳位数随时间增长后误判。
const GENERATED_ID_PATTERN = /^c[0-9a-z]{32,}$/;

describe('Request ID 贯通(x-request-id)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('客户端未传 x-request-id', () => {
    it('成功响应:响应头携带后端生成的 cuid-like ID', async () => {
      const res = await request(httpServer(app)).get('/api/system/v1/health');

      expect(res.status).toBe(200);
      const id = res.headers[REQUEST_ID_HEADER];
      expect(typeof id).toBe('string');
      expect(id).toMatch(GENERATED_ID_PATTERN);
    });

    it('错误响应:401 也必须带 x-request-id 头', async () => {
      const res = await request(httpServer(app)).get('/api/admin/v1/users');

      expect(res.status).toBe(401);
      const id = res.headers[REQUEST_ID_HEADER];
      expect(typeof id).toBe('string');
      expect(id).toMatch(GENERATED_ID_PATTERN);
    });

    it('两次独立请求生成的 ID 必须不同(随机性)', async () => {
      const r1 = await request(httpServer(app)).get('/api/system/v1/health');
      const r2 = await request(httpServer(app)).get('/api/system/v1/health');

      const id1 = r1.headers[REQUEST_ID_HEADER];
      const id2 = r2.headers[REQUEST_ID_HEADER];
      expect(id1).toMatch(GENERATED_ID_PATTERN);
      expect(id2).toMatch(GENERATED_ID_PATTERN);
      expect(id1).not.toBe(id2);
    });
  });

  describe('客户端传入 x-request-id', () => {
    it('合法值原样回显', async () => {
      const traceId = 'my-trace-123';
      const res = await request(httpServer(app))
        .get('/api/system/v1/health')
        .set(REQUEST_ID_HEADER, traceId);

      expect(res.status).toBe(200);
      expect(res.headers[REQUEST_ID_HEADER]).toBe(traceId);
    });

    it('合法 cuid 格式原样回显', async () => {
      const traceId = 'cl9z3a8b00000abcd1234efgh';
      const res = await request(httpServer(app))
        .get('/api/system/v1/health')
        .set(REQUEST_ID_HEADER, traceId);

      expect(res.headers[REQUEST_ID_HEADER]).toBe(traceId);
    });

    it('合法 UUID 格式原样回显(允许字符集兼容前端常用 UUID 透传)', async () => {
      const traceId = '550e8400-e29b-41d4-a716-446655440000';
      const res = await request(httpServer(app))
        .get('/api/system/v1/health')
        .set(REQUEST_ID_HEADER, traceId);

      expect(res.headers[REQUEST_ID_HEADER]).toBe(traceId);
    });

    it('超长值(>128 字符)被忽略,改用后端生成的 ID', async () => {
      const tooLong = 'a'.repeat(200);
      const res = await request(httpServer(app))
        .get('/api/system/v1/health')
        .set(REQUEST_ID_HEADER, tooLong);

      const id = res.headers[REQUEST_ID_HEADER];
      expect(id).not.toBe(tooLong);
      expect(id).toMatch(GENERATED_ID_PATTERN);
    });

    it('含禁用字符(空格 / 引号)被忽略,改用后端生成的 ID', async () => {
      // 空格 + 引号是常见 header 注入风险点,REQUEST_ID_PATTERN 不允许
      const malicious = 'evil "header" injection';
      const res = await request(httpServer(app))
        .get('/api/system/v1/health')
        .set(REQUEST_ID_HEADER, malicious);

      const id = res.headers[REQUEST_ID_HEADER];
      expect(id).not.toBe(malicious);
      expect(id).toMatch(GENERATED_ID_PATTERN);
    });
  });

  // 白盒断言:silent 配置阻止了日志输出,直接调用 customProps 工厂函数,
  // 等价于"日志条目顶层会出现 reqId 字段"。E2E 黑盒已经覆盖响应头一致性,
  // 这一组确保"日志值与响应头同源"——只要 customProps 真的从 req.id 取值,
  // 而 req.id 又是 genReqId 写入响应头的同一个字符串,就不会漂移。
  describe('日志 customProps:顶层 reqId 字段(白盒)', () => {
    function makeFakeReq(id?: string, userId?: string): IncomingMessage {
      // 仅模拟 buildHttpLogProps 真实读取的两个字段,其余 IncomingMessage 属性
      // 在该函数中不被访问;两步断言 (unknown → IncomingMessage) 绕过结构匹配。
      return { id, user: userId ? { id: userId } : undefined } as unknown as IncomingMessage;
    }

    it('已登录请求:返回 { reqId, userId },reqId 来自 req.id', () => {
      const props = buildHttpLogProps(makeFakeReq('cabc123', 'u_001'));
      expect(props).toEqual({ reqId: 'cabc123', userId: 'u_001' });
    });

    it('未登录请求:只返回 { reqId },不含 userId 噪声字段', () => {
      const props = buildHttpLogProps(makeFakeReq('cdef456'));
      expect(props).toEqual({ reqId: 'cdef456' });
    });

    it('客户端传入的 trace ID 同样作为日志 reqId(与响应头一致)', () => {
      // 模拟 genReqId 把 my-trace-123 写入 req.id 后,customProps 应原样取出。
      const props = buildHttpLogProps(makeFakeReq('my-trace-123'));
      expect(props).toEqual({ reqId: 'my-trace-123' });
    });

    it('防御:req.id 缺失时不打 reqId 字段(避免 reqId: undefined 噪声)', () => {
      const props = buildHttpLogProps(makeFakeReq(undefined));
      expect(props).toEqual({});
    });
  });

  describe('响应体永不暴露 requestId', () => {
    it('成功响应体严格只有 { code, message, data } 三字段', async () => {
      const res = await request(httpServer(app)).get('/api/system/v1/health');

      expect(res.body).toEqual({
        code: 0,
        message: 'ok',
        data: { status: 'ok' },
      });
      // 排除 reqId / requestId 任何形态泄漏
      expect(res.body).not.toHaveProperty('reqId');
      expect(res.body).not.toHaveProperty('requestId');
      expect(res.body.data).not.toHaveProperty('reqId');
      expect(res.body.data).not.toHaveProperty('requestId');
    });

    it('错误响应体严格只有 { code, message, data: null }', async () => {
      const res = await request(httpServer(app)).get('/api/admin/v1/users');

      expect(res.body).toEqual({
        code: expect.any(Number),
        message: expect.any(String),
        data: null,
      });
      expect(res.body).not.toHaveProperty('reqId');
      expect(res.body).not.toHaveProperty('requestId');
      // message 也不能拼接 ID(防止误把 ID 写进 message 暴露)
      expect(res.body.message).not.toMatch(/req|cuid|trace|id/i);
    });
  });
});
