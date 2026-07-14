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
import { createTestUser, TEST_PASSWORD } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// OTP(验证码)登录 e2e(goal DoD-5/7;冻结评审稿 queue-b-otp-birthday-infra-review.md §5/§7)。
//
// 结构沿 auth-password-reset.e2e-spec.ts 双 app 范式(throttler 内存计数器随 app 隔离):
//   组 A:login-sms IP throttler 配额经 env 调大,专测防枚举一致性 / 全链同构 /
//        码语义(错 5 次 / 重用)/ purpose 双向隔离 / 双轨并行;时间推进用 DB 回拨。
//   组 B:throttler 取真实默认(5/60),专测第 7 实例 IP 限流与物理隔离。
//
// 防枚举断言纪律(评审稿 E-O4/E-O5):send-code 无效场景响应体与有效场景**逐字节一致**
// 且 DB 零留痕;login 一切失败统一 24010 响应体两两一致(永不可达 10004/10005)。
// 行为锁:密码登录(auth-login spec)断言零修改;本文件仅新增。

const SEND_PATH = '/api/auth/v1/login-sms/send-code';
const LOGIN_SMS_PATH = '/api/auth/v1/login-sms';
const LOGIN_PATH = '/api/auth/v1/login';
const FIXED_CODE = '888888';

const PHONE_ACTIVE = '13910000001';
const PHONE_DISABLED = '13910000002';
const PHONE_DELETED = '13910000003';
const PHONE_CLEARED = '13910000004'; // 曾绑定后被清除(DB 视图同从未绑定,独立场景验证)
const PHONE_NEVER = '13910000005'; // 从未绑定
const PHONE_CHAIN = '13910000006';
const PHONE_ISO = '13910000007';

describe('OTP 登录 — 组 A:防枚举 / 全链同构 / 码语义(IP 限流调大)', () => {
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

  function loginSms(phone: string, code: string): Promise<request.Response> {
    return request(httpServer(app)).post(LOGIN_SMS_PATH).send({ phone, code });
  }

  function loginPwd(username: string, password: string): Promise<request.Response> {
    return request(httpServer(app)).post(LOGIN_PATH).send({ username, password });
  }

  // DB 回拨:把同号既有 code 行挪出 60s 间隔与自然日窗口(沿 auth-password-reset 范式)
  async function rewindPhoneCodes(phone: string): Promise<void> {
    await prisma.smsVerificationCode.updateMany({
      where: { phone },
      data: { createdAt: new Date(Date.now() - 25 * 3600 * 1000) },
    });
  }

  // lastLoginAt 为 fire-and-forget 写入,短轮询等待(≤2s)防竞态
  async function waitLastLoginAt(userId: string): Promise<Date | null> {
    for (let i = 0; i < 20; i += 1) {
      const row = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { lastLoginAt: true },
      });
      if (row.lastLoginAt !== null) return row.lastLoginAt;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }

  beforeAll(async () => {
    process.env.LOGIN_SMS_THROTTLE_LIMIT = '100';
    app = await createTestApp();
    const cfg = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);
    smsCodePepperKey = deriveSmsCodePepperKey(cfg.sms.encryptionKey);
    prisma = app.get(PrismaService);
    await resetDb(app);
    await prisma.smsSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });

    const uActive = await createTestUser(app, { username: 'otpl_active' });
    uActiveId = uActive.id;
    await prisma.user.update({
      where: { id: uActiveId },
      data: { phone: PHONE_ACTIVE, phoneVerifiedAt: new Date() },
    });

    const uDisabled = await createTestUser(app, { username: 'otpl_disabled', status: 'DISABLED' });
    await prisma.user.update({ where: { id: uDisabled.id }, data: { phone: PHONE_DISABLED } });

    const uDeleted = await createTestUser(app, { username: 'otpl_deleted', deletedAt: new Date() });
    await prisma.user.update({ where: { id: uDeleted.id }, data: { phone: PHONE_DELETED } });

    // 曾绑定后被清除:绑上再清空,落库终态 phone=null(评审稿 E-O2 场景 ②)
    const uCleared = await createTestUser(app, { username: 'otpl_cleared' });
    await prisma.user.update({ where: { id: uCleared.id }, data: { phone: PHONE_CLEARED } });
    await prisma.user.update({
      where: { id: uCleared.id },
      data: { phone: null, phoneVerifiedAt: null },
    });

    const uChain = await createTestUser(app, { username: 'otpl_chain' });
    uChainId = uChain.id;
    await prisma.user.update({ where: { id: uChainId }, data: { phone: PHONE_CHAIN } });

    const uIso = await createTestUser(app, { username: 'otpl_iso' });
    uIsoId = uIso.id;
    await prisma.user.update({ where: { id: uIsoId }, data: { phone: PHONE_ISO } });
  });

  afterAll(async () => {
    delete process.env.LOGIN_SMS_THROTTLE_LIMIT;
    await app.close();
  });

  describe('防枚举(评审稿 E-O4/E-O5,本功能安全核心)', () => {
    it('四种无效号码场景 send-code 返回完全相同泛化 200,且零留痕(不发码不写 send_logs)', async () => {
      const resNever = await sendCode(PHONE_NEVER);
      const resCleared = await sendCode(PHONE_CLEARED);
      const resDisabled = await sendCode(PHONE_DISABLED);
      const resDeleted = await sendCode(PHONE_DELETED);

      for (const res of [resNever, resCleared, resDisabled, resDeleted]) {
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ code: 0, message: 'ok', data: { expiresInSeconds: 300 } });
      }

      const phones = [PHONE_NEVER, PHONE_CLEARED, PHONE_DISABLED, PHONE_DELETED];
      expect(await prisma.smsVerificationCode.count({ where: { phone: { in: phones } } })).toBe(0);
      expect(await prisma.smsSendLog.count({ where: { phone: { in: phones } } })).toBe(0);
    });

    it('有效号 send-code 响应与无效场景逐字节一致,真实发码留痕且码归属目标用户', async () => {
      const res = await sendCode(PHONE_ACTIVE);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ code: 0, message: 'ok', data: { expiresInSeconds: 300 } });

      const codeRow = await prisma.smsVerificationCode.findFirstOrThrow({
        where: { phone: PHONE_ACTIVE, purpose: 'LOGIN' },
      });
      expect(codeRow.userId).toBe(uActiveId);
      expect(codeRow.consumedAt).toBeNull();
      expect(
        await prisma.smsSendLog.count({ where: { phone: PHONE_ACTIVE, status: 'SENT' } }),
      ).toBe(1);
    });

    it('登录一切失败统一 24010 且响应体一致:号码无效四场景 + 有效号码错码;永不可达 10004/10005', async () => {
      const rNever = await loginSms(PHONE_NEVER, FIXED_CODE);
      const rCleared = await loginSms(PHONE_CLEARED, FIXED_CODE);
      const rDisabled = await loginSms(PHONE_DISABLED, FIXED_CODE);
      const rDeleted = await loginSms(PHONE_DELETED, FIXED_CODE);
      const rWrongCode = await loginSms(PHONE_ACTIVE, '000000');

      for (const res of [rNever, rCleared, rDisabled, rDeleted, rWrongCode]) {
        expectBizError(res, BizCode.SMS_CODE_INVALID);
      }
      expect(rCleared.body).toEqual(rNever.body);
      expect(rDisabled.body).toEqual(rNever.body);
      expect(rDeleted.body).toEqual(rNever.body);
      expect(rWrongCode.body).toEqual(rNever.body);

      // 错码路径 attempts+1 不因防枚举弱化
      const codeRow = await prisma.smsVerificationCode.findFirstOrThrow({
        where: { phone: PHONE_ACTIVE, purpose: 'LOGIN' },
      });
      expect(codeRow.attempts).toBe(1);
    });

    it('DTO 校验:非法手机号 / 非 6 位码 / 夹带字段 → 400(任何值同样校验,无存在性信息)', async () => {
      const badPhone = await request(httpServer(app)).post(SEND_PATH).send({ phone: '12345' });
      expectBizError(badPhone, BizCode.BAD_REQUEST, { strictMessage: false });

      const badCode = await loginSms(PHONE_ACTIVE, '12ab56');
      expectBizError(badCode, BizCode.BAD_REQUEST, { strictMessage: false });

      const extra = await request(httpServer(app))
        .post(LOGIN_SMS_PATH)
        .send({ phone: PHONE_ACTIVE, code: FIXED_CODE, username: 'hack' });
      expectBizError(extra, BizCode.BAD_REQUEST, { strictMessage: false });
    });
  });

  describe('验证码语义(沿 SMS 基础设施)', () => {
    it('码错 5 次作废:第 6 次用正确码仍 24010', async () => {
      await rewindPhoneCodes(PHONE_ACTIVE);
      await sendCode(PHONE_ACTIVE);

      for (let i = 0; i < 5; i += 1) {
        expectBizError(await loginSms(PHONE_ACTIVE, '111111'), BizCode.SMS_CODE_INVALID);
      }
      expectBizError(await loginSms(PHONE_ACTIVE, FIXED_CODE), BizCode.SMS_CODE_INVALID);

      const codeRow = await prisma.smsVerificationCode.findFirstOrThrow({
        where: { phone: PHONE_ACTIVE, purpose: 'LOGIN' },
        orderBy: { createdAt: 'desc' },
      });
      expect(codeRow.attempts).toBe(5);
      expect(codeRow.consumedAt).toBeNull();
    });

    it('purpose 双向隔离:PASSWORD_RESET 码不能登录;LOGIN 码不能重置密码', async () => {
      // 直插一条有效 PASSWORD_RESET 码;不存在 LOGIN 活码 → 登录 24010 且该行零触碰
      await prisma.smsVerificationCode.create({
        data: {
          phone: PHONE_ISO,
          purpose: 'PASSWORD_RESET',
          codeHash: codeHash(PHONE_ISO, 'PASSWORD_RESET', FIXED_CODE),
          userId: uIsoId,
          expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        },
      });
      expectBizError(await loginSms(PHONE_ISO, FIXED_CODE), BizCode.SMS_CODE_INVALID);
      const resetRow = await prisma.smsVerificationCode.findFirstOrThrow({
        where: { phone: PHONE_ISO, purpose: 'PASSWORD_RESET' },
      });
      expect(resetRow.consumedAt).toBeNull();
      expect(resetRow.attempts).toBe(0);

      // 反向:清掉上半段的 PASSWORD_RESET 活码(避免 reset 命中它),
      // 直插 LOGIN 码,password-reset 走不通(统一 24010)
      await prisma.smsVerificationCode.deleteMany({
        where: { phone: PHONE_ISO, purpose: 'PASSWORD_RESET' },
      });
      await prisma.smsVerificationCode.create({
        data: {
          phone: PHONE_ISO,
          purpose: 'LOGIN',
          codeHash: codeHash(PHONE_ISO, 'LOGIN', FIXED_CODE),
          userId: uIsoId,
          expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        },
      });
      const resetTry = await request(httpServer(app))
        .post('/api/auth/v1/password-reset')
        .send({ phone: PHONE_ISO, code: FIXED_CODE, newPassword: 'IsoNew123' });
      expectBizError(resetTry, BizCode.SMS_CODE_INVALID);
      const loginRow = await prisma.smsVerificationCode.findFirstOrThrow({
        where: { phone: PHONE_ISO, purpose: 'LOGIN' },
      });
      expect(loginRow.consumedAt).toBeNull();
    });
  });

  describe('全链同构(评审稿 E-O6;goal DoD-5)', () => {
    it('发码→OTP 登录→响应形状同密码登录→access 调 /me→refresh 轮换→码重放 24010→lastLoginAt→audit 掩码', async () => {
      // 双轨基线:密码登录拿一份响应形状(同 DTO 对照)
      const pwdLogin = await loginPwd('otpl_chain', TEST_PASSWORD);
      expect(pwdLogin.status).toBe(200);

      expect((await sendCode(PHONE_CHAIN)).status).toBe(200);
      const otp = await loginSms(PHONE_CHAIN, FIXED_CODE);
      expect(otp.status).toBe(200);

      // 同 DTO 同构:字段集与密码登录完全一致
      const otpData = (otp.body as { data: Record<string, unknown> }).data;
      const pwdData = (pwdLogin.body as { data: Record<string, unknown> }).data;
      expect(Object.keys(otpData).sort()).toEqual(Object.keys(pwdData).sort());
      expect(otpData.tokenType).toBe('Bearer');
      expect(otpData.expiresIn).toBe(pwdData.expiresIn);

      const accessToken = otpData.accessToken as string;
      const refreshToken = otpData.refreshToken as string;

      // access 可用:调 /me
      const me = await request(httpServer(app))
        .get('/api/app/v1/me')
        .set('Authorization', `Bearer ${accessToken}`);
      expect(me.status).toBe(200);

      // refresh 轮换:同 family 机制(P0-E 冻结行为直接复用)
      const rotated = await request(httpServer(app))
        .post('/api/auth/v1/refresh')
        .send({ refreshToken });
      expect(rotated.status).toBe(200);
      const newRefresh = (rotated.body as { data: { refreshToken: string } }).data.refreshToken;
      expect(newRefresh).not.toBe(refreshToken);

      // OTP 会话的 refresh 行与密码登录同表同 family 机制
      const families = await prisma.refreshToken.findMany({ where: { userId: uChainId } });
      expect(families.length).toBeGreaterThanOrEqual(3); // 密码 1 + OTP 1 + 轮换 1

      // 码已消费:同码重放登录 → 24010
      expectBizError(await loginSms(PHONE_CHAIN, FIXED_CODE), BizCode.SMS_CODE_INVALID);

      // lastLoginAt 同步更新(fire-and-forget,短轮询)
      expect(await waitLastLoginAt(uChainId)).not.toBeNull();

      // audit auth.login.sms:actor=本人;extra = familyId + 掩码 phone + codeId;无明文
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { event: 'auth.login.sms', resourceId: uChainId },
      });
      expect(audit.actorUserId).toBe(uChainId);
      const context = audit.context as {
        extra?: { familyId?: string; phone?: string; codeId?: string };
      };
      expect(context.extra?.familyId).toBeTruthy();
      expect(context.extra?.phone).toBe('139****0006');
      const consumedCode = await prisma.smsVerificationCode.findFirstOrThrow({
        where: { phone: PHONE_CHAIN, purpose: 'LOGIN', consumedAt: { not: null } },
      });
      expect(context.extra?.codeId).toBe(consumedCode.id);
      const serialized = JSON.stringify(audit.context);
      expect(serialized).not.toContain(PHONE_CHAIN);
      expect(serialized).not.toContain(consumedCode.codeHash);
      expect(serialized).not.toContain(FIXED_CODE);

      // 双轨并行:OTP 登录后密码登录仍照常可用(密码契约零变化)
      expect((await loginPwd('otpl_chain', TEST_PASSWORD)).status).toBe(200);
    });
  });
});

describe('OTP 登录 — 组 B:IP 限流第 7 实例(真实默认 5/60)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const PHONE_B = '13910000011';

  beforeAll(async () => {
    process.env.LOGIN_SMS_THROTTLE_LIMIT = '5';
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);
    await prisma.smsSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });
    const uB = await createTestUser(app, { username: 'otpl_throttle' });
    await prisma.user.update({ where: { id: uB.id }, data: { phone: PHONE_B } });
  });

  afterAll(async () => {
    delete process.env.LOGIN_SMS_THROTTLE_LIMIT;
    await app.close();
  });

  it('login-sms:同 IP 第 6 次 → 42900(无效号同样消耗配额);计数与 password-reset 实例物理隔离;不暴露限流头', async () => {
    // 5 次配额内(用无效码,业务 24010 但不吃 throttler 之外的配额;每次计数 1)
    for (let i = 0; i < 5; i += 1) {
      const r = await request(httpServer(app))
        .post(LOGIN_SMS_PATH)
        .send({ phone: PHONE_B, code: '000000' });
      expectBizError(r, BizCode.SMS_CODE_INVALID);
    }
    const sixth = await request(httpServer(app))
      .post(LOGIN_SMS_PATH)
      .send({ phone: PHONE_B, code: '000000' });
    expectBizError(sixth, BizCode.TOO_MANY_REQUESTS, { strictMessage: false });
    expect(sixth.headers['x-ratelimit-limit']).toBeUndefined();
    expect(sixth.headers['retry-after']).toBeUndefined();

    // 物理隔离:login-sms 配额吃满后,password-reset 第 6 实例照常可用
    const pwReset = await request(httpServer(app))
      .post('/api/auth/v1/password-reset/send-code')
      .send({ phone: PHONE_B });
    expect(pwReset.status).toBe(200);

    // send-code 与 login 同实例共享计数维度为 端点×IP:send-code 端点自身仍有独立计数
    const send = await request(httpServer(app)).post(SEND_PATH).send({ phone: PHONE_B });
    expectBizError(send, BizCode.SMS_SEND_INTERVAL_LIMIT); // 60s 间隔(password-reset 刚发过,跨 purpose 合计)
  });
});
