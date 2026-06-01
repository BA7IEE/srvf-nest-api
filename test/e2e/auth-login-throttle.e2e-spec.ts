import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { httpServer } from '../helpers/http-server';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { TEST_PASSWORD, createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// V1.1 TASKS.md 15.7:登录接口限流(@nestjs/throttler 内存 storage)。
//
// 关键约束验证:
//   1. POST /api/auth/v1/login 触发限流后返回 BizCode.TOO_MANY_REQUESTS(HTTP 429)
//      + 统一错误体,经 AllExceptionsFilter 输出
//   2. 限流响应**不含** Retry-After / X-RateLimit-Limit / X-RateLimit-Remaining /
//      X-RateLimit-Reset 头(setHeaders: false 顶层关闭)
//   3. 其他接口(GET /api/system/v1/health/live)不受限流影响——验证"反向白名单":
//      ThrottlerBizGuard.shouldSkip 默认 true,只对标 @LoginThrottle() 的方法启用
//   4. 限流不区分成功/失败:正确密码在窗口内被 block 也返回 429
//
// 关于 limit/ttl 来源:
//   .env.test 把 LOGIN_THROTTLE_LIMIT 放宽到 50,避免单 spec 内多次 loginAs
//   (最大 18 次,users-admin-crud)误触限流。本 spec 内 beforeAll **临时覆盖**
//   process.env 把 LIMIT 调到 5,createTestApp 时 app.config 重新读取生效;
//   afterAll 还原 process.env,不影响后续 spec(jest --runInBand 单进程顺序执行)。
//
// storage 隔离:每个 spec 走 createTestApp() 新建 NestApplication,
//             ThrottlerStorageService 是 module scope,实例独立,跨 spec 不共享计数器。
describe('POST /api/auth/v1/login throttling (V1.1 §15.7)', () => {
  let app: INestApplication;
  // 保存 .env.test 加载后的原值,afterAll 还原,避免跨 spec 污染。
  const originalLimit = process.env.LOGIN_THROTTLE_LIMIT;
  const originalTtl = process.env.LOGIN_THROTTLE_TTL_SECONDS;

  // beforeAll 单次建 app + seed 用户;所有 it 顺序复用同一 app(共享 storage 计数器,
  // 这正是限流场景所需——it 之间累计触发 block)。
  beforeAll(async () => {
    process.env.LOGIN_THROTTLE_LIMIT = '5';
    process.env.LOGIN_THROTTLE_TTL_SECONDS = '60';
    app = await createTestApp();
    await resetDb(app);
    await createTestUser(app, { username: 'throttletest' });
  });

  afterAll(async () => {
    await app.close();
    if (originalLimit === undefined) {
      delete process.env.LOGIN_THROTTLE_LIMIT;
    } else {
      process.env.LOGIN_THROTTLE_LIMIT = originalLimit;
    }
    if (originalTtl === undefined) {
      delete process.env.LOGIN_THROTTLE_TTL_SECONDS;
    } else {
      process.env.LOGIN_THROTTLE_TTL_SECONDS = originalTtl;
    }
  });

  // 第 1~5 次错误密码 → 401 LOGIN_FAILED;第 6 次起 → 429 TOO_MANY_REQUESTS。
  // 用错误密码而非正确密码:
  //   - 避免污染 lastLoginAt(成功路径会异步 update)
  //   - 也间接验证"限流命中早于 LOGIN_FAILED 判定"——throttler 在 guard 层,
  //     先于 controller / service 执行
  it('limit 内的失败登录返回 LOGIN_FAILED,超过即返回 TOO_MANY_REQUESTS', async () => {
    for (let i = 1; i <= 5; i++) {
      const res = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'throttletest', password: 'WrongPwd1!' });
      expectBizError(res, BizCode.LOGIN_FAILED);
    }

    const blocked = await request(httpServer(app))
      .post('/api/auth/v1/login')
      .send({ username: 'throttletest', password: 'WrongPwd1!' });
    expectBizError(blocked, BizCode.TOO_MANY_REQUESTS);
    expect(blocked.body).toEqual({
      code: BizCode.TOO_MANY_REQUESTS.code,
      message: BizCode.TOO_MANY_REQUESTS.message,
      data: null,
    });
  });

  it('限流响应不暴露 Retry-After / X-RateLimit-* 头', async () => {
    // 接续上一 it,storage 仍处 block 状态;再发一次直接拿 429
    const res = await request(httpServer(app))
      .post('/api/auth/v1/login')
      .send({ username: 'throttletest', password: 'WrongPwd1!' });
    expect(res.status).toBe(BizCode.TOO_MANY_REQUESTS.httpStatus);

    // 任务卡 15.7 验收:不暴露阈值数字、剩余配额、重置时间
    expect(res.headers['retry-after']).toBeUndefined();
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    expect(res.headers['x-ratelimit-remaining']).toBeUndefined();
    expect(res.headers['x-ratelimit-reset']).toBeUndefined();
    // 兼容 named throttler 后缀格式(throttler 在多 throttler 场景会写 -default 后缀)
    expect(res.headers['retry-after-default']).toBeUndefined();
    expect(res.headers['x-ratelimit-limit-default']).toBeUndefined();
  });

  it('正确密码在窗口内同样被限流(限流不区分成功/失败)', async () => {
    // 接续:发用户的正确密码,因为 IP-method 维度计数仍处 block,返回 429
    const res = await request(httpServer(app))
      .post('/api/auth/v1/login')
      .send({ username: 'throttletest', password: TEST_PASSWORD });
    expectBizError(res, BizCode.TOO_MANY_REQUESTS);
  });

  it('其他接口(GET /api/system/v1/health/live)不被登录限流影响', async () => {
    // 即使 /login 已被 block,health 端点完全独立(ThrottlerBizGuard.shouldSkip
    // 对未标 @LoginThrottle() 的方法直接返回 true 跳过)。
    // 连续 10 次请求都应 200,不会触发任何限流。
    for (let i = 0; i < 10; i++) {
      const res = await request(httpServer(app)).get('/api/system/v1/health/live');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        code: 0,
        message: 'ok',
        data: { status: 'ok' },
      });
    }
  });
});
