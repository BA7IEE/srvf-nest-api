import type { INestApplication } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import appConfig from '../../src/config/app.config';
import { PrismaService } from '../../src/database/prisma.service';
import {
  deriveSmsCodePepperKey,
  hashSmsVerificationCode,
} from '../../src/modules/sms/sms-code-hash.util';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser, TEST_PASSWORD } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 找回密码 e2e(goal DoD-4/5/6;冻结评审稿 password-reset-by-sms-review.md §4/§5/§7)。
//
// 结构沿 sms-throttle.e2e-spec.ts 双 app 范式(throttler 内存计数器随 app 隔离):
//   组 A:password-reset IP throttler 配额经 env 调大,专测防枚举一致性 / 全链后效 /
//        码语义(错 5 次 / 过期 / 重用 / 10006 不烧码)/ purpose 隔离;时间推进用 DB 回拨。
//   组 B:throttler 取真实默认(3/60),专测第 6 实例 IP 限流与物理隔离。
//
// 防枚举断言纪律(评审稿 §4):无效场景响应体与有效场景**逐字节一致**(toEqual 深比较),
// 且 DB 零留痕(codes / send_logs 计数 0)。

const SEND_PATH = '/api/auth/v1/password-reset/send-code';
const RESET_PATH = '/api/auth/v1/password-reset';
const LOGIN_PATH = '/api/auth/v1/login';
const FIXED_CODE = '888888';

const PHONE_ACTIVE = '13900000001';
const PHONE_DISABLED = '13900000002';
const PHONE_DELETED = '13900000003';
const PHONE_CLEARED = '13900000004'; // 曾绑定后被清除(DB 视图同从未绑定,独立场景验证)
const PHONE_NEVER = '13900000005'; // 从未绑定
const PHONE_CHAIN = '13900000006';
const PHONE_ISO = '13900000007';
const PHONE_CROSS = '13900000008';

describe('找回密码 — 组 A:防枚举 / 全链后效 / 码语义(IP 限流调大)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let uActiveId: string;
  let uChainId: string;
  let uIsoId: string;
  let smsCodePepperKey: Buffer;

  function codeHash(phone: string, purpose: string, code: string): string {
    return hashSmsVerificationCode({ phone, purpose, code }, smsCodePepperKey);
  }

  function sendCode(phone: string): Promise<request.Response> {
    return request(httpServer(app)).post(SEND_PATH).send({ phone });
  }

  function reset(phone: string, code: string, newPassword: string): Promise<request.Response> {
    return request(httpServer(app)).post(RESET_PATH).send({ phone, code, newPassword });
  }

  function login(username: string, password: string): Promise<request.Response> {
    return request(httpServer(app)).post(LOGIN_PATH).send({ username, password });
  }

  // DB 回拨:把同号既有 code 行挪出 60s 间隔与自然日窗口(不真等待;沿 sms-throttle 组 A 范式)
  async function rewindPhoneCodes(phone: string): Promise<void> {
    await prisma.smsVerificationCode.updateMany({
      where: { phone },
      data: { createdAt: new Date(Date.now() - 25 * 3600 * 1000) },
    });
  }

  beforeAll(async () => {
    process.env.PASSWORD_RESET_THROTTLE_LIMIT = '100';
    app = await createTestApp();
    const cfg = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);
    smsCodePepperKey = deriveSmsCodePepperKey(cfg.sms.encryptionKey);
    prisma = app.get(PrismaService);
    await resetDb(app);
    await prisma.smsSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });

    const uActive = await createTestUser(app, { username: 'pwreset_active' });
    uActiveId = uActive.id;
    await prisma.user.update({
      where: { id: uActiveId },
      data: { phone: PHONE_ACTIVE, phoneVerifiedAt: new Date() },
    });

    const uDisabled = await createTestUser(app, {
      username: 'pwreset_disabled',
      status: 'DISABLED',
    });
    await prisma.user.update({ where: { id: uDisabled.id }, data: { phone: PHONE_DISABLED } });

    const uDeleted = await createTestUser(app, {
      username: 'pwreset_deleted',
      deletedAt: new Date(),
    });
    await prisma.user.update({ where: { id: uDeleted.id }, data: { phone: PHONE_DELETED } });

    // 曾绑定后被清除:绑上再清空,落库终态 phone=null(评审稿 §4 场景 ②)
    const uCleared = await createTestUser(app, { username: 'pwreset_cleared' });
    await prisma.user.update({ where: { id: uCleared.id }, data: { phone: PHONE_CLEARED } });
    await prisma.user.update({
      where: { id: uCleared.id },
      data: { phone: null, phoneVerifiedAt: null },
    });

    const uChain = await createTestUser(app, { username: 'pwreset_chain' });
    uChainId = uChain.id;
    await prisma.user.update({ where: { id: uChainId }, data: { phone: PHONE_CHAIN } });

    const uIso = await createTestUser(app, { username: 'pwreset_iso' });
    uIsoId = uIso.id;
    await prisma.user.update({ where: { id: uIsoId }, data: { phone: PHONE_ISO } });

    await createTestUser(app, { username: 'pwreset_cross' }); // 无 phone;测跨 purpose 间隔
  });

  afterAll(async () => {
    delete process.env.PASSWORD_RESET_THROTTLE_LIMIT;
    await app.close();
  });

  describe('防枚举(DoD-4,本功能安全核心)', () => {
    it('四种无效号码场景 send-code 返回完全相同泛化 200,且零留痕(不发码不写 send_logs)', async () => {
      const resNever = await sendCode(PHONE_NEVER);
      const resCleared = await sendCode(PHONE_CLEARED);
      const resDisabled = await sendCode(PHONE_DISABLED);
      const resDeleted = await sendCode(PHONE_DELETED);

      // 四场景响应体两两完全一致(且与有效号成功响应同形状同值,见下一用例)
      for (const res of [resNever, resCleared, resDisabled, resDeleted]) {
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ code: 0, message: 'ok', data: { expiresInSeconds: 300 } });
      }

      // 零侧写痕迹:不建 code 行、不写 send_logs
      const phones = [PHONE_NEVER, PHONE_CLEARED, PHONE_DISABLED, PHONE_DELETED];
      expect(await prisma.smsVerificationCode.count({ where: { phone: { in: phones } } })).toBe(0);
      expect(await prisma.smsSendLog.count({ where: { phone: { in: phones } } })).toBe(0);
    });

    it('有效号 send-code 响应与无效场景逐字节一致,真实发码留痕且码归属目标用户(E-7)', async () => {
      const res = await sendCode(PHONE_ACTIVE);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ code: 0, message: 'ok', data: { expiresInSeconds: 300 } });

      const codeRow = await prisma.smsVerificationCode.findFirstOrThrow({
        where: { phone: PHONE_ACTIVE, purpose: 'PASSWORD_RESET' },
      });
      expect(codeRow.userId).toBe(uActiveId);
      expect(codeRow.consumedAt).toBeNull();
      expect(
        await prisma.smsSendLog.count({ where: { phone: PHONE_ACTIVE, status: 'SENT' } }),
      ).toBe(1);
    });

    it('reset 一切失败统一 24010 且响应体一致:号码无效四场景 + 有效号码错码', async () => {
      const rNever = await reset(PHONE_NEVER, FIXED_CODE, 'NewPass123');
      const rCleared = await reset(PHONE_CLEARED, FIXED_CODE, 'NewPass123');
      const rDisabled = await reset(PHONE_DISABLED, FIXED_CODE, 'NewPass123');
      const rDeleted = await reset(PHONE_DELETED, FIXED_CODE, 'NewPass123');
      const rWrongCode = await reset(PHONE_ACTIVE, '000000', 'NewPass123');

      for (const res of [rNever, rCleared, rDisabled, rDeleted, rWrongCode]) {
        expectBizError(res, BizCode.SMS_CODE_INVALID);
      }
      // 响应体两两完全一致(零可区分账号存在性字段)
      expect(rCleared.body).toEqual(rNever.body);
      expect(rDisabled.body).toEqual(rNever.body);
      expect(rDeleted.body).toEqual(rNever.body);
      expect(rWrongCode.body).toEqual(rNever.body);

      // 错码路径 attempts+1 不因防枚举弱化(评审稿 §4)
      const codeRow = await prisma.smsVerificationCode.findFirstOrThrow({
        where: { phone: PHONE_ACTIVE, purpose: 'PASSWORD_RESET' },
      });
      expect(codeRow.attempts).toBe(1);
    });

    it('DTO 校验:newPassword 镜像 ChangeMyPasswordDto;多余字段 forbidNonWhitelisted 拒绝', async () => {
      // ValidationPipe message 为具体校验文案,只核 code/status(strictMessage:false)
      // 弱密码(无数字)
      const weak = await reset(PHONE_ACTIVE, FIXED_CODE, 'abcdefgh');
      expectBizError(weak, BizCode.BAD_REQUEST, { strictMessage: false });
      // 夹带字段
      const extra = await request(httpServer(app))
        .post(RESET_PATH)
        .send({ phone: PHONE_ACTIVE, code: FIXED_CODE, newPassword: 'NewPass123', role: 'ADMIN' });
      expectBizError(extra, BizCode.BAD_REQUEST, { strictMessage: false });
      // 非法手机号格式(任何值同样校验,无存在性信息)
      const badPhone = await request(httpServer(app)).post(SEND_PATH).send({ phone: '12345' });
      expectBizError(badPhone, BizCode.BAD_REQUEST, { strictMessage: false });
    });
  });

  describe('验证码语义(沿 SMS 基础设施;DoD-6)', () => {
    it('码错 5 次作废:第 6 次用正确码仍 24010', async () => {
      await rewindPhoneCodes(PHONE_ACTIVE);
      await sendCode(PHONE_ACTIVE);

      for (let i = 0; i < 5; i += 1) {
        expectBizError(await reset(PHONE_ACTIVE, '111111', 'NewPass123'), BizCode.SMS_CODE_INVALID);
      }
      const afterFive = await reset(PHONE_ACTIVE, FIXED_CODE, 'NewPass123');
      expectBizError(afterFive, BizCode.SMS_CODE_INVALID);

      const codeRow = await prisma.smsVerificationCode.findFirstOrThrow({
        where: { phone: PHONE_ACTIVE, purpose: 'PASSWORD_RESET' },
        orderBy: { createdAt: 'desc' },
      });
      expect(codeRow.attempts).toBe(5);
      expect(codeRow.consumedAt).toBeNull();
    });

    it('过期码 → 24010', async () => {
      await rewindPhoneCodes(PHONE_ACTIVE);
      await sendCode(PHONE_ACTIVE);
      await prisma.smsVerificationCode.updateMany({
        where: { phone: PHONE_ACTIVE, purpose: 'PASSWORD_RESET', consumedAt: null },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expectBizError(await reset(PHONE_ACTIVE, FIXED_CODE, 'NewPass123'), BizCode.SMS_CODE_INVALID);
    });

    it('10006 不烧码:新密码与当前相同 → 10006 且不消费不计次;同一验证码换密码即成功;重用已消费码 → 24010', async () => {
      await rewindPhoneCodes(PHONE_ACTIVE);
      await sendCode(PHONE_ACTIVE);

      // ① 新密码 == 当前密码(bcrypt 比对旧 hash)→ 10006,验证码不消费、attempts 不变
      const same = await reset(PHONE_ACTIVE, FIXED_CODE, TEST_PASSWORD);
      expectBizError(same, BizCode.NEW_PASSWORD_SAME_AS_OLD);
      const codeRow = await prisma.smsVerificationCode.findFirstOrThrow({
        where: { phone: PHONE_ACTIVE, purpose: 'PASSWORD_RESET' },
        orderBy: { createdAt: 'desc' },
      });
      expect(codeRow.consumedAt).toBeNull();
      expect(codeRow.attempts).toBe(0);

      // ② 同一验证码换新密码重试 → 成功,data:null(不返 token,D-PR-1)
      const ok = await reset(PHONE_ACTIVE, FIXED_CODE, 'BrandNew123');
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ code: 0, message: 'ok', data: null });

      // ③ 码已消费:同码重放 → 24010
      expectBizError(await reset(PHONE_ACTIVE, FIXED_CODE, 'Another123'), BizCode.SMS_CODE_INVALID);

      // ④ 错误码值(10006 路径)未泄露重置能力:旧密码已失效、新密码可登录
      expectBizError(await login('pwreset_active', TEST_PASSWORD), BizCode.LOGIN_FAILED);
      expect((await login('pwreset_active', 'BrandNew123')).status).toBe(200);
    });

    it('PHONE_BIND 码不能用于 PASSWORD_RESET(purpose 隔离,评审稿 §7 附)', async () => {
      // 直插一条有效 PHONE_BIND 码(DevStub 固定码 hash);不存在 PASSWORD_RESET 活码
      await prisma.smsVerificationCode.create({
        data: {
          phone: PHONE_ISO,
          purpose: 'PHONE_BIND',
          codeHash: codeHash(PHONE_ISO, 'PHONE_BIND', FIXED_CODE),
          userId: uIsoId,
          expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        },
      });
      expectBizError(await reset(PHONE_ISO, FIXED_CODE, 'IsoNew123'), BizCode.SMS_CODE_INVALID);

      // PHONE_BIND 行零触碰(未被消费、未计 attempts)
      const bindRow = await prisma.smsVerificationCode.findFirstOrThrow({
        where: { phone: PHONE_ISO, purpose: 'PHONE_BIND' },
      });
      expect(bindRow.consumedAt).toBeNull();
      expect(bindRow.attempts).toBe(0);
    });

    it('发码 60s 间隔跨 purpose 合计:绑定发码后立即找回发码 → 24120(E-18)', async () => {
      const { authHeader } = await loginAs(app, 'pwreset_cross');
      const bindSend = await request(httpServer(app))
        .post('/api/app/v1/me/phone/send-code')
        .set('Authorization', authHeader)
        .send({ phone: PHONE_CROSS });
      expect(bindSend.status).toBe(200);
      const bind = await request(httpServer(app))
        .put('/api/app/v1/me/phone')
        .set('Authorization', authHeader)
        .send({ phone: PHONE_CROSS, code: FIXED_CODE });
      expect(bind.status).toBe(200);

      // PHONE_BIND 签发距今 <60s,PASSWORD_RESET 发码命中同号间隔(跨 purpose 共享)
      expectBizError(await sendCode(PHONE_CROSS), BizCode.SMS_SEND_INTERVAL_LIMIT);
    });
  });

  describe('全链后效(DoD-5/6)', () => {
    it('发码→重置→旧密码失效→新密码登录→旧 refresh 全部 10007→旧 access 仍可用(D-4)→audit 掩码落库', async () => {
      // 重置前两次登录:两条独立 refresh family,验证"全部"撤销
      const login1 = await login('pwreset_chain', TEST_PASSWORD);
      const login2 = await login('pwreset_chain', TEST_PASSWORD);
      expect(login1.status).toBe(200);
      const oldAccess = (login1.body as { data: { accessToken: string } }).data.accessToken;
      const oldRefresh1 = (login1.body as { data: { refreshToken: string } }).data.refreshToken;
      const oldRefresh2 = (login2.body as { data: { refreshToken: string } }).data.refreshToken;

      expect((await sendCode(PHONE_CHAIN)).status).toBe(200);
      const ok = await reset(PHONE_CHAIN, FIXED_CODE, 'ChainNew123');
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ code: 0, message: 'ok', data: null });

      // 旧密码失效 / 新密码可登录
      expectBizError(await login('pwreset_chain', TEST_PASSWORD), BizCode.LOGIN_FAILED);
      expect((await login('pwreset_chain', 'ChainNew123')).status).toBe(200);

      // 旧 refresh 全部失效(第 5 联动撤销场景;统一 10007 不细分)
      for (const token of [oldRefresh1, oldRefresh2]) {
        const r = await request(httpServer(app))
          .post('/api/auth/v1/refresh')
          .send({ refreshToken: token });
        expectBizError(r, BizCode.REFRESH_TOKEN_INVALID);
      }
      const revoked = await prisma.refreshToken.findMany({
        where: { userId: uChainId, revokedReason: 'self-password-reset' },
      });
      expect(revoked.length).toBeGreaterThanOrEqual(2);
      for (const row of revoked) {
        expect(row.revokedAt).not.toBeNull();
      }

      // 旧 access 沿 D-4 不吊销:重置后仍可调 /me(与改密 §7.5 反向锁定对称)
      const me = await request(httpServer(app))
        .get('/api/app/v1/me')
        .set('Authorization', `Bearer ${oldAccess}`);
      expect(me.status).toBe(200);

      // audit:actor=本人;extra 含撤销计数 + codeId;手机号一律掩码,无明文码/完整号码
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { event: 'password.reset.by-sms', resourceId: uChainId },
      });
      expect(audit.actorUserId).toBe(uChainId);
      const context = audit.context as {
        extra?: { refreshTokensRevoked?: number; phone?: string; codeId?: string };
      };
      expect(context.extra?.refreshTokensRevoked).toBeGreaterThanOrEqual(2);
      expect(context.extra?.phone).toBe('139****0006');
      const consumedCode = await prisma.smsVerificationCode.findFirstOrThrow({
        where: { phone: PHONE_CHAIN, purpose: 'PASSWORD_RESET', consumedAt: { not: null } },
      });
      expect(context.extra?.codeId).toBe(consumedCode.id);
      const serialized = JSON.stringify(audit.context);
      expect(serialized).not.toContain(PHONE_CHAIN);
      expect(serialized).not.toContain(consumedCode.codeHash);
    });
  });
});

describe('找回密码 — 组 B:IP 限流第 6 实例(真实默认 3/60)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const PHONE_B = '13900000011';

  beforeAll(async () => {
    process.env.PASSWORD_RESET_THROTTLE_LIMIT = '3';
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);
    await prisma.smsSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });
    const uB = await createTestUser(app, { username: 'pwreset_throttle' });
    await prisma.user.update({ where: { id: uB.id }, data: { phone: PHONE_B } });
  });

  afterAll(async () => {
    delete process.env.PASSWORD_RESET_THROTTLE_LIMIT;
    await app.close();
  });

  it('send-code:同 IP 第 4 次 → 42900(无效号同样消耗配额,限流与号码状态无关);不暴露限流头', async () => {
    const first = await request(httpServer(app)).post(SEND_PATH).send({ phone: PHONE_B });
    expect(first.status).toBe(200);
    // 无效号请求同样计数(防"用无效号探路不耗配额")
    const second = await request(httpServer(app)).post(SEND_PATH).send({ phone: '13900000012' });
    expect(second.status).toBe(200);
    const third = await request(httpServer(app)).post(SEND_PATH).send({ phone: '13900000013' });
    expect(third.status).toBe(200);

    const fourth = await request(httpServer(app)).post(SEND_PATH).send({ phone: PHONE_B });
    expectBizError(fourth, BizCode.TOO_MANY_REQUESTS);
    expect(fourth.headers['x-ratelimit-limit']).toBeUndefined();
    expect(fourth.headers['retry-after']).toBeUndefined();
  });

  it('reset:独立按端点计数,第 4 次 → 42900;与 login(default 实例)物理隔离', async () => {
    for (let i = 0; i < 3; i += 1) {
      expectBizError(
        await request(httpServer(app))
          .post(RESET_PATH)
          .send({ phone: PHONE_B, code: '000000', newPassword: 'NewPass123' }),
        BizCode.SMS_CODE_INVALID,
      );
    }
    expectBizError(
      await request(httpServer(app))
        .post(RESET_PATH)
        .send({ phone: PHONE_B, code: '000000', newPassword: 'NewPass123' }),
      BizCode.TOO_MANY_REQUESTS,
    );

    // 物理隔离:password-reset 满额不消耗 login(default)配额
    const loginRes = await request(httpServer(app))
      .post(LOGIN_PATH)
      .send({ username: 'pwreset_throttle', password: TEST_PASSWORD });
    expect(loginRes.status).toBe(200);
  });
});
