import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser, TEST_PASSWORD } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// SMS 基础设施 T3 e2e 第 3 组:防刷三层(评审稿 §4 / D-SMS-6)。
//
// 结构:两个独立 app 实例(throttler 内存计数器随 app 隔离)——
//   组 A:IP throttler 配额经 env 调大,专测 DB 层(60s 间隔 / 自然日上限 / 错 5 次作废 /
//        过期 / 单活码 superseded / 重用已消费);时间推进用"DB 回拨",不真等待。
//   组 B:IP throttler 取真实默认(send 5/60、verify 10/60),专测第三层 IP 限流与
//        五实例物理隔离(send 满额不影响 verify / login)+ 不暴露限流头。

const SEND_PATH = '/api/app/v1/me/phone/send-code';
const BIND_PATH = '/api/app/v1/me/phone';
const FIXED_CODE = '888888';

async function phoneBindProof(app: INestApplication, authHeader: string): Promise<string> {
  const response = await request(httpServer(app))
    .post('/api/auth/v1/step-up/password')
    .set('Authorization', authHeader)
    .send({ action: 'PHONE_BIND', password: TEST_PASSWORD });
  expect(response.status).toBe(200);
  return (response.body as { data: { stepUpToken: string } }).data.stepUpToken;
}

async function setupCommon(app: INestApplication, usernames: string[]): Promise<string[]> {
  const prisma = app.get(PrismaService);
  await resetDb(app);
  await prisma.smsSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });
  const headers: string[] = [];
  for (const username of usernames) {
    await createTestUser(app, { username });
    headers.push((await loginAs(app, username)).authHeader);
  }
  return headers;
}

describe('SMS 防刷 — 组 A:DB 层(间隔 / 日限 / 错 5 次 / 过期 / 单活码)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let header: string;

  beforeAll(async () => {
    process.env.SMS_SEND_THROTTLE_LIMIT = '100';
    process.env.SMS_VERIFY_THROTTLE_LIMIT = '100';
    app = await createTestApp();
    prisma = app.get(PrismaService);
    [header] = await setupCommon(app, ['throttle_a1']);
  });

  afterAll(async () => {
    await app.close();
  });

  function send(phone: string): Promise<request.Response> {
    return request(httpServer(app)).post(SEND_PATH).set('Authorization', header).send({ phone });
  }

  async function bind(phone: string, code: string): Promise<request.Response> {
    const stepUpToken = await phoneBindProof(app, header);
    return request(httpServer(app))
      .put(BIND_PATH)
      .set('Authorization', header)
      .send({ phone, code, stepUpToken });
  }

  async function rewindLatest(phone: string, ms: number): Promise<void> {
    const latest = await prisma.smsVerificationCode.findFirstOrThrow({
      where: { phone },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true },
    });
    await prisma.smsVerificationCode.update({
      where: { id: latest.id },
      data: { createdAt: new Date(latest.createdAt.getTime() - ms) },
    });
  }

  it('同号 60s 间隔:发码成功 → 立即再发 → 24120(message 不带阈值数字)', async () => {
    const phone = '13700000001';
    expect((await send(phone)).status).toBe(200);
    const res = await send(phone);
    expectBizError(res, BizCode.SMS_SEND_INTERVAL_LIMIT);
    expect(res.body.message).not.toMatch(/60|阈值/);
  });

  it('回拨 61s 后再发成功;旧活码被 superseded(单活码 E-9)', async () => {
    const phone = '13700000001';
    await rewindLatest(phone, 61_000);
    const oldRow = await prisma.smsVerificationCode.findFirstOrThrow({
      where: { phone },
      orderBy: { createdAt: 'desc' },
    });
    expect((await send(phone)).status).toBe(200);

    const oldAfter = await prisma.smsVerificationCode.findUniqueOrThrow({
      where: { id: oldRow.id },
    });
    expect(oldAfter.supersededAt).not.toBeNull();
    // 全号仅 1 条活码
    const activeCount = await prisma.smsVerificationCode.count({
      where: { phone, consumedAt: null, supersededAt: null },
    });
    expect(activeCount).toBe(1);
  });

  it('同号自然日上限:已有 10 条当日记录 → 再发 → 24121', async () => {
    const phone = '13700000002';
    // 直插 10 行"当日"记录:与业务实现同口径计算 UTC+8 日界并 clamp,任何时刻运行都
    // 确定落在当日窗口(曾在北京时间午夜后 1h 内跑挂过"now-1h"写法);
    // 最旧一行也回拨 ≥61s,让间隔检查通过,逼出日限分支。
    const nowMs = Date.now();
    const offsetMs = 8 * 3600 * 1000; // 评审稿 E-10 固定 UTC+8
    const dayStartMs = Math.floor((nowMs + offsetMs) / 86_400_000) * 86_400_000 - offsetMs;
    await prisma.smsVerificationCode.createMany({
      data: Array.from({ length: 10 }, (_, i) => {
        const ts = Math.max(dayStartMs, nowMs - 61_000 - i * 10);
        return {
          phone,
          purpose: 'PHONE_BIND' as const,
          codeHash: 'f'.repeat(64),
          userId: 'someone',
          expiresAt: new Date(ts + 300_000),
          supersededAt: new Date(ts),
          createdAt: new Date(ts),
        };
      }),
    });
    const res = await send(phone);
    expectBizError(res, BizCode.SMS_PHONE_DAILY_LIMIT);
    expect(res.body.message).not.toMatch(/10|阈值/);
  });

  it('错 5 次作废:5 次错码均 24010 且 attempts 递增;第 6 次用正确码仍 24010', async () => {
    const phone = '13700000003';
    expect((await send(phone)).status).toBe(200);
    for (let i = 1; i <= 5; i++) {
      expectBizError(await bind(phone, '000000'), BizCode.SMS_CODE_INVALID);
    }
    const row = await prisma.smsVerificationCode.findFirstOrThrow({
      where: { phone },
      orderBy: { createdAt: 'desc' },
    });
    expect(row.attempts).toBe(5);
    // 作废后正确码也无效(统一 24010,不细分)
    expectBizError(await bind(phone, FIXED_CODE), BizCode.SMS_CODE_INVALID);
    expect(await prisma.user.findFirst({ where: { phone } })).toBeNull();
  });

  it('过期码 → 24010(统一码)', async () => {
    const phone = '13700000004';
    expect((await send(phone)).status).toBe(200);
    const row = await prisma.smsVerificationCode.findFirstOrThrow({
      where: { phone },
      orderBy: { createdAt: 'desc' },
    });
    await prisma.smsVerificationCode.update({
      where: { id: row.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expectBizError(await bind(phone, FIXED_CODE), BizCode.SMS_CODE_INVALID);
  });

  it('重用已消费码 → 24010(先解除占用,使重放绕开占用预检直达验码层)', async () => {
    const phone = '13700000005';
    expect((await send(phone)).status).toBe(200);
    expect((await bind(phone, FIXED_CODE)).status).toBe(200);
    // 直清占用(等效 admin 清号),让重放命中"已消费码"分支而非占用预检
    await prisma.user.updateMany({
      where: { phone },
      data: { phone: null, phoneVerifiedAt: null },
    });
    expectBizError(await bind(phone, FIXED_CODE), BizCode.SMS_CODE_INVALID);
  });
});

describe('SMS 防刷 — 组 B:IP throttler(send 5/60、verify 10/60;五实例物理隔离)', () => {
  let app: INestApplication;
  let header: string;

  beforeAll(async () => {
    process.env.SMS_SEND_THROTTLE_LIMIT = '5';
    process.env.SMS_VERIFY_THROTTLE_LIMIT = '10';
    app = await createTestApp();
    [header] = await setupCommon(app, ['throttle_b1']);
  });

  afterAll(async () => {
    await app.close();
    // 还原(防对后续 spec 文件残留;jest worker 内 env 共享)
    delete process.env.SMS_SEND_THROTTLE_LIMIT;
    delete process.env.SMS_VERIFY_THROTTLE_LIMIT;
  });

  it('send-code 同 IP 第 6 次 → 42900;响应不带 Retry-After / X-RateLimit-* 头', async () => {
    // 每次换号:避开同号 60s 间隔,纯测 IP 维度;guard 在业务层之前,按请求计数
    for (let i = 1; i <= 5; i++) {
      const res = await request(httpServer(app))
        .post(SEND_PATH)
        .set('Authorization', header)
        .send({ phone: `1370000010${i}` });
      expect(res.status).toBe(200);
    }
    const sixth = await request(httpServer(app))
      .post(SEND_PATH)
      .set('Authorization', header)
      .send({ phone: '13700001066' });
    expectBizError(sixth, BizCode.TOO_MANY_REQUESTS);
    expect(sixth.headers).not.toHaveProperty('retry-after');
    expect(Object.keys(sixth.headers).join(',')).not.toMatch(/x-ratelimit/i);
  });

  it('物理隔离:send 配额已满,verify 端点仍走业务逻辑(24010 而非 42900),login 不受影响', async () => {
    const stepUpToken = await phoneBindProof(app, header);
    const res = await request(httpServer(app))
      .put(BIND_PATH)
      .set('Authorization', header)
      .send({ phone: '13700001088', code: '000000', stepUpToken });
    expectBizError(res, BizCode.SMS_CODE_INVALID); // 无活码 → 统一 24010;证明未被 send 配额波及

    // default(login)throttler 同样隔离
    const login = await request(httpServer(app))
      .post('/api/auth/v1/login')
      .send({ username: 'throttle_b1', password: 'Passw0rd1!' });
    expect(login.status).toBe(200);
  });

  it('verify 同 IP 第 11 次 → 42900(上面已消耗 1 次,这里再 9 次业务码 + 第 10 次触顶)', async () => {
    for (let i = 1; i <= 9; i++) {
      const stepUpToken = await phoneBindProof(app, header);
      const res = await request(httpServer(app))
        .put(BIND_PATH)
        .set('Authorization', header)
        .send({ phone: '13700001088', code: '000000', stepUpToken });
      expectBizError(res, BizCode.SMS_CODE_INVALID);
    }
    const stepUpToken = await phoneBindProof(app, header);
    const eleventh = await request(httpServer(app))
      .put(BIND_PATH)
      .set('Authorization', header)
      .send({ phone: '13700001088', code: '000000', stepUpToken });
    expectBizError(eleventh, BizCode.TOO_MANY_REQUESTS);
  });
});
