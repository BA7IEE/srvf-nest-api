import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// P0-E PR-3 e2e:POST /api/auth/refresh 限流(沿评审稿 §8.1 / §3.7 D-7 / §5.8)。
// 关键验证:
//   1. 30/60 IP 命中后第 31 次 → 42900
//   2. 与 default(login)/ password-change(改密)throttler 物理隔离
//   3. 不暴露 Retry-After / X-RateLimit-* 头(沿 V1.1 §17.7 / setHeaders: false)
//
// .env.test REFRESH_THROTTLE_LIMIT=100;本 spec beforeAll **临时覆盖** process.env 把 LIMIT 调到 5
// 触发限流;afterAll 还原(参考 auth-login-throttle.e2e-spec.ts 范式)。

describe('POST /api/auth/refresh throttling', () => {
  let app: INestApplication;
  const originalLimit = process.env.REFRESH_THROTTLE_LIMIT;
  const originalTtl = process.env.REFRESH_THROTTLE_TTL_SECONDS;

  beforeAll(async () => {
    process.env.REFRESH_THROTTLE_LIMIT = '5';
    process.env.REFRESH_THROTTLE_TTL_SECONDS = '60';
    app = await createTestApp();
    await resetDb(app);
    await createTestUser(app, { username: 'refreshthrottle1' });
  });

  afterAll(async () => {
    await app.close();
    if (originalLimit === undefined) delete process.env.REFRESH_THROTTLE_LIMIT;
    else process.env.REFRESH_THROTTLE_LIMIT = originalLimit;
    if (originalTtl === undefined) delete process.env.REFRESH_THROTTLE_TTL_SECONDS;
    else process.env.REFRESH_THROTTLE_TTL_SECONDS = originalTtl;
  });

  it('5 次失败 refresh 后第 6 次 → TOO_MANY_REQUESTS', async () => {
    // 用 invalid token 多次 refresh;每次失败前都会走 throttler 计数
    for (let i = 1; i <= 5; i++) {
      const res = await request(httpServer(app))
        .post('/api/auth/refresh')
        .send({ refreshToken: `bad-token-${i}` });
      expectBizError(res, BizCode.REFRESH_TOKEN_INVALID);
    }

    const blocked = await request(httpServer(app))
      .post('/api/auth/refresh')
      .send({ refreshToken: 'bad-token-blocked' });
    expectBizError(blocked, BizCode.TOO_MANY_REQUESTS);
    expect(blocked.body).toEqual({
      code: BizCode.TOO_MANY_REQUESTS.code,
      message: BizCode.TOO_MANY_REQUESTS.message,
      data: null,
    });
  });

  it('限流响应不暴露 Retry-After / X-RateLimit-* 头', async () => {
    const res = await request(httpServer(app))
      .post('/api/auth/refresh')
      .send({ refreshToken: 'bad-token-headercheck' });
    expect(res.status).toBe(BizCode.TOO_MANY_REQUESTS.httpStatus);

    expect(res.headers['retry-after']).toBeUndefined();
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    expect(res.headers['x-ratelimit-remaining']).toBeUndefined();
    expect(res.headers['x-ratelimit-reset']).toBeUndefined();
    expect(res.headers['retry-after-refresh']).toBeUndefined();
    expect(res.headers['x-ratelimit-limit-refresh']).toBeUndefined();
  });

  it('login 不被 refresh throttler 影响(三 throttler 物理隔离)', async () => {
    // 即使 refresh 已 block,login 走 default throttler 不受影响
    const res = await request(httpServer(app))
      .post('/api/auth/login')
      .send({ username: 'refreshthrottle1', password: 'Passw0rd1!' });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
  });
});
