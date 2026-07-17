import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { StepUpAction } from '../../src/modules/auth/auth.dto';
import {
  IdentityStepUpFactor,
  IdentityStepUpService,
} from '../../src/modules/auth/identity-step-up.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser, TEST_PASSWORD } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

process.env.PASSWORD_CHANGE_THROTTLE_LIMIT = '100';
process.env.SMS_SEND_THROTTLE_LIMIT = '100';
process.env.SMS_VERIFY_THROTTLE_LIMIT = '100';
process.env.LOGIN_WECHAT_THROTTLE_LIMIT = '100';

const PASSWORD_PATH = '/api/auth/v1/step-up/password';
const SMS_SEND_PATH = '/api/auth/v1/step-up/sms/send-code';
const SMS_PATH = '/api/auth/v1/step-up/sms';
const WECHAT_PATH = '/api/auth/v1/step-up/wechat';
const PHONE_BIND_PATH = '/api/app/v1/me/phone';
const WECHAT_BIND_PATH = '/api/app/v1/me/wechat';
const FIXED_SMS_CODE = '888888';

describe('Identity step-up + identity rebind(PR1)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let stepUp: IdentityStepUpService;
  let passwordUserId: string;
  let passwordHeader: string;
  let passwordAccessToken: string;
  let passwordRefreshToken: string;
  let otherHeader: string;
  let phoneOnlyHeader: string;
  let wechatOnlyHeader: string;

  async function passwordProof(header: string, action: StepUpAction): Promise<string> {
    const response = await request(httpServer(app))
      .post(PASSWORD_PATH)
      .set('Authorization', header)
      .send({ action, password: TEST_PASSWORD });
    expect(response.status).toBe(200);
    const body = response.body as { data: { expiresAt: string; stepUpToken: string } };
    expect(Object.keys(body.data).sort()).toEqual(['expiresAt', 'stepUpToken']);
    return body.data.stepUpToken;
  }

  async function rewindSmsInterval(phone: string): Promise<void> {
    await prisma.smsVerificationCode.updateMany({
      where: { phone },
      data: { createdAt: new Date(Date.now() - 61_000) },
    });
  }

  async function expiredProof(userId: string, action: StepUpAction): Promise<string> {
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        passwordHash: true,
        phone: true,
        phoneVerifiedAt: true,
        openid: true,
        status: true,
        deletedAt: true,
      },
    });
    const signingKey = (stepUp as unknown as { signingKey: Buffer }).signingKey;
    return jwt.sign(
      {
        sub: row.id,
        action,
        factor: IdentityStepUpFactor.PASSWORD,
        snapshot: stepUp.computeCredentialSnapshot(row),
      },
      { secret: signingKey, audience: 'srvf.identity-step-up', expiresIn: -1 },
    );
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    stepUp = app.get(IdentityStepUpService);
    await resetDb(app);
    await prisma.smsSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });
    await prisma.wechatSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });

    const passwordUser = await createTestUser(app, { username: 'step_password' });
    passwordUserId = passwordUser.id;
    const passwordLogin = await request(httpServer(app))
      .post('/api/auth/v1/login')
      .send({ username: 'step_password', password: TEST_PASSWORD });
    passwordAccessToken = passwordLogin.body.data.accessToken as string;
    passwordRefreshToken = passwordLogin.body.data.refreshToken as string;
    passwordHeader = `Bearer ${passwordAccessToken}`;

    await createTestUser(app, { username: 'step_other' });
    otherHeader = (await loginAs(app, 'step_other')).authHeader;

    const phoneOnly = await createTestUser(app, {
      username: 'step_phone_only',
      password: 'RandomUnusable937551',
    });
    await prisma.user.update({
      where: { id: phoneOnly.id },
      data: { phone: '13870000001', phoneVerifiedAt: new Date() },
    });
    await request(httpServer(app))
      .post('/api/auth/v1/login-sms/send-code')
      .send({ phone: '13870000001' });
    const phoneLogin = await request(httpServer(app))
      .post('/api/auth/v1/login-sms')
      .send({ phone: '13870000001', code: FIXED_SMS_CODE });
    phoneOnlyHeader = `Bearer ${phoneLogin.body.data.accessToken as string}`;

    const wechatOnly = await createTestUser(app, {
      username: 'step_wechat_only',
      password: 'RandomUnusable937552',
    });
    await prisma.user.update({
      where: { id: wechatOnly.id },
      data: { openid: 'dev-openid-step-current-wechat' },
    });
    const wechatLogin = await request(httpServer(app))
      .post('/api/auth/v1/login-wechat')
      .send({ code: 'step-current-wechat' });
    wechatOnlyHeader = `Bearer ${wechatLogin.body.data.session.accessToken as string}`;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.PASSWORD_CHANGE_THROTTLE_LIMIT;
    delete process.env.SMS_SEND_THROTTLE_LIMIT;
    delete process.env.SMS_VERIFY_THROTTLE_LIMIT;
    delete process.env.LOGIN_WECHAT_THROTTLE_LIMIT;
  });

  it.each([PASSWORD_PATH, SMS_SEND_PATH, SMS_PATH, WECHAT_PATH])(
    '%s 默认 JWT-protected，缺 access 统一 40100',
    async (path) => {
      const response = await request(httpServer(app)).post(path).send({});
      expectBizError(response, BizCode.UNAUTHORIZED);
    },
  );

  it('password / phone-only SMS / openid-only WeChat 三因子都能签发，audit secret-safe', async () => {
    const password = await request(httpServer(app))
      .post(PASSWORD_PATH)
      .set('Authorization', passwordHeader)
      .send({ action: StepUpAction.PHONE_BIND, password: TEST_PASSWORD });
    expect(password.status).toBe(200);

    await rewindSmsInterval('13870000001');
    const send = await request(httpServer(app))
      .post(SMS_SEND_PATH)
      .set('Authorization', phoneOnlyHeader)
      .send({ action: StepUpAction.PHONE_BIND });
    expect(send.status).toBe(200);
    expect(send.body.data).toEqual({ expiresInSeconds: 300 });
    expect(send.body.data).not.toHaveProperty('stepUpToken');
    const sms = await request(httpServer(app))
      .post(SMS_PATH)
      .set('Authorization', phoneOnlyHeader)
      .send({ action: StepUpAction.PHONE_BIND, code: FIXED_SMS_CODE });
    expect(sms.status).toBe(200);

    const wechat = await request(httpServer(app))
      .post(WECHAT_PATH)
      .set('Authorization', wechatOnlyHeader)
      .send({ action: StepUpAction.WECHAT_BIND, code: 'step-current-wechat' });
    expect(wechat.status).toBe(200);

    const audits = await prisma.auditLog.findMany({ where: { event: 'auth.step-up' } });
    expect(audits.length).toBeGreaterThanOrEqual(3);
    for (const audit of audits) {
      const context = audit.context as { extra?: Record<string, unknown> };
      expect(Object.keys(context.extra ?? {}).sort()).toEqual(['action', 'factor']);
      const serialized = JSON.stringify(context);
      expect(serialized).not.toContain(TEST_PASSWORD);
      expect(serialized).not.toContain(FIXED_SMS_CODE);
      expect(serialized).not.toContain('step-current-wechat');
      expect(serialized).not.toContain('stepUpToken');
      expect(serialized).not.toContain('snapshot');
    }
  });

  it('factor unavailable:无 phone 的 SMS、无 openid 的 WeChat 都返 10009', async () => {
    expectBizError(
      await request(httpServer(app))
        .post(SMS_SEND_PATH)
        .set('Authorization', passwordHeader)
        .send({ action: StepUpAction.PHONE_BIND }),
      BizCode.STEP_UP_FACTOR_UNAVAILABLE,
    );
    expectBizError(
      await request(httpServer(app))
        .post(WECHAT_PATH)
        .set('Authorization', passwordHeader)
        .send({ action: StepUpAction.WECHAT_BIND, code: 'any' }),
      BizCode.STEP_UP_FACTOR_UNAVAILABLE,
    );
  });

  it('phone PUT 对缺失/action 错/user 错/stale/expired proof 全部失败关闭', async () => {
    const body = { phone: '13870000011', code: FIXED_SMS_CODE };
    expectBizError(
      await request(httpServer(app))
        .put(PHONE_BIND_PATH)
        .set('Authorization', passwordHeader)
        .send(body),
      BizCode.BAD_REQUEST,
      { strictMessage: false },
    );

    const wrongAction = await passwordProof(passwordHeader, StepUpAction.WECHAT_BIND);
    expectBizError(
      await request(httpServer(app))
        .put(PHONE_BIND_PATH)
        .set('Authorization', passwordHeader)
        .send({ ...body, stepUpToken: wrongAction }),
      BizCode.STEP_UP_PROOF_INVALID,
    );

    const wrongUser = await passwordProof(otherHeader, StepUpAction.PHONE_BIND);
    expectBizError(
      await request(httpServer(app))
        .put(PHONE_BIND_PATH)
        .set('Authorization', passwordHeader)
        .send({ ...body, stepUpToken: wrongUser }),
      BizCode.STEP_UP_PROOF_INVALID,
    );

    const stale = await passwordProof(passwordHeader, StepUpAction.PHONE_BIND);
    await prisma.user.update({
      where: { id: passwordUserId },
      data: { phoneVerifiedAt: new Date('2026-07-17T01:00:00.000Z') },
    });
    expectBizError(
      await request(httpServer(app))
        .put(PHONE_BIND_PATH)
        .set('Authorization', passwordHeader)
        .send({ ...body, stepUpToken: stale }),
      BizCode.STEP_UP_PROOF_INVALID,
    );

    expectBizError(
      await request(httpServer(app))
        .put(PHONE_BIND_PATH)
        .set('Authorization', passwordHeader)
        .send({
          ...body,
          stepUpToken: await expiredProof(passwordUserId, StepUpAction.PHONE_BIND),
        }),
      BizCode.STEP_UP_PROOF_INVALID,
    );
  });

  it('真实 phone 变更同事务撤全部 active refresh + audit；旧 access 仍有效，旧 refresh 失效', async () => {
    const targetPhone = '13870000012';
    const send = await request(httpServer(app))
      .post('/api/app/v1/me/phone/send-code')
      .set('Authorization', passwordHeader)
      .send({ phone: targetPhone });
    expect(send.status).toBe(200);
    const proof = await passwordProof(passwordHeader, StepUpAction.PHONE_BIND);
    const bind = await request(httpServer(app))
      .put(PHONE_BIND_PATH)
      .set('Authorization', passwordHeader)
      .send({ phone: targetPhone, code: FIXED_SMS_CODE, stepUpToken: proof });
    expect(bind.status).toBe(200);

    const refreshRows = await prisma.refreshToken.findMany({
      where: { userId: passwordUserId },
      select: { revokedAt: true, revokedReason: true },
    });
    expect(refreshRows.length).toBeGreaterThan(0);
    expect(
      refreshRows.every(
        (row) => row.revokedAt !== null && row.revokedReason === 'self-phone-identity-change',
      ),
    ).toBe(true);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { event: 'phone.bind.self', resourceId: passwordUserId },
    });
    expect(JSON.stringify(audit.context)).not.toContain(proof);

    const oldAccess = await request(httpServer(app))
      .get('/api/app/v1/me/wechat')
      .set('Authorization', `Bearer ${passwordAccessToken}`);
    expect(oldAccess.status).toBe(200);
    expectBizError(
      await request(httpServer(app))
        .post('/api/auth/v1/refresh')
        .send({ refreshToken: passwordRefreshToken }),
      BizCode.REFRESH_TOKEN_INVALID,
    );
  });

  it('wechat PUT 对缺失/action 错/user 错/stale/expired proof 全部失败关闭', async () => {
    const body = { code: 'new-wx-for-failure' };
    expectBizError(
      await request(httpServer(app))
        .put(WECHAT_BIND_PATH)
        .set('Authorization', passwordHeader)
        .send(body),
      BizCode.BAD_REQUEST,
      { strictMessage: false },
    );

    const wrongAction = await passwordProof(passwordHeader, StepUpAction.PHONE_BIND);
    expectBizError(
      await request(httpServer(app))
        .put(WECHAT_BIND_PATH)
        .set('Authorization', passwordHeader)
        .send({ ...body, stepUpToken: wrongAction }),
      BizCode.STEP_UP_PROOF_INVALID,
    );

    const wrongUser = await passwordProof(otherHeader, StepUpAction.WECHAT_BIND);
    expectBizError(
      await request(httpServer(app))
        .put(WECHAT_BIND_PATH)
        .set('Authorization', passwordHeader)
        .send({ ...body, stepUpToken: wrongUser }),
      BizCode.STEP_UP_PROOF_INVALID,
    );

    const stale = await passwordProof(passwordHeader, StepUpAction.WECHAT_BIND);
    await prisma.user.update({
      where: { id: passwordUserId },
      data: { phoneVerifiedAt: new Date('2026-07-17T02:00:00.000Z') },
    });
    expectBizError(
      await request(httpServer(app))
        .put(WECHAT_BIND_PATH)
        .set('Authorization', passwordHeader)
        .send({ ...body, stepUpToken: stale }),
      BizCode.STEP_UP_PROOF_INVALID,
    );

    expectBizError(
      await request(httpServer(app))
        .put(WECHAT_BIND_PATH)
        .set('Authorization', passwordHeader)
        .send({
          ...body,
          stepUpToken: await expiredProof(passwordUserId, StepUpAction.WECHAT_BIND),
        }),
      BizCode.STEP_UP_PROOF_INVALID,
    );
  });

  it('同一 snapshot proof 并发换绑由 User FOR UPDATE 串行：一条成功，一条 stale 10008', async () => {
    const proof = await passwordProof(passwordHeader, StepUpAction.WECHAT_BIND);
    const responses = await Promise.all([
      request(httpServer(app))
        .put(WECHAT_BIND_PATH)
        .set('Authorization', passwordHeader)
        .send({ code: 'concurrent-wx-a', stepUpToken: proof }),
      request(httpServer(app))
        .put(WECHAT_BIND_PATH)
        .set('Authorization', passwordHeader)
        .send({ code: 'concurrent-wx-b', stepUpToken: proof }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
    const failed = responses.find((response) => response.status === 401);
    expect(failed?.body.code).toBe(BizCode.STEP_UP_PROOF_INVALID.code);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: passwordUserId } });
    expect(['dev-openid-concurrent-wx-a', 'dev-openid-concurrent-wx-b']).toContain(user.openid);
    expect(
      await prisma.auditLog.count({
        where: {
          event: { in: ['wechat.bind.self', 'wechat.rebind.self'] },
          resourceId: passwordUserId,
        },
      }),
    ).toBe(1);
  });

  it('step-up proof 不改变 JwtPayload/access 行为', async () => {
    const payload = jwt.decode<Record<string, unknown>>(passwordAccessToken);
    expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'sub', 'username']);
    expect(payload).not.toHaveProperty('action');
    expect(payload).not.toHaveProperty('factor');
    expect(payload).not.toHaveProperty('snapshot');
    expect(payload).not.toHaveProperty('stepUpToken');
  });
});

describe('Identity step-up 复用既有四类 throttler', () => {
  let app: INestApplication;
  let authHeader: string;

  beforeAll(async () => {
    process.env.PASSWORD_CHANGE_THROTTLE_LIMIT = '1';
    process.env.SMS_SEND_THROTTLE_LIMIT = '1';
    process.env.SMS_VERIFY_THROTTLE_LIMIT = '1';
    process.env.LOGIN_WECHAT_THROTTLE_LIMIT = '1';
    app = await createTestApp();
    const prisma = app.get(PrismaService);
    await resetDb(app);
    await prisma.smsSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });
    await prisma.wechatSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });
    const user = await createTestUser(app, { username: 'step_throttle' });
    await prisma.user.update({
      where: { id: user.id },
      data: {
        phone: '13870000009',
        phoneVerifiedAt: new Date(),
        openid: 'dev-openid-step-throttle-wechat',
      },
    });
    authHeader = (await loginAs(app, 'step_throttle')).authHeader;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.PASSWORD_CHANGE_THROTTLE_LIMIT;
    delete process.env.SMS_SEND_THROTTLE_LIMIT;
    delete process.env.SMS_VERIFY_THROTTLE_LIMIT;
    delete process.env.LOGIN_WECHAT_THROTTLE_LIMIT;
  });

  it.each([
    [PASSWORD_PATH, { action: StepUpAction.PHONE_BIND, password: TEST_PASSWORD }],
    [SMS_SEND_PATH, { action: StepUpAction.PHONE_BIND }],
    [SMS_PATH, { action: StepUpAction.PHONE_BIND, code: FIXED_SMS_CODE }],
    [WECHAT_PATH, { action: StepUpAction.WECHAT_BIND, code: 'step-throttle-wechat' }],
  ])('%s 第二次请求命中复用实例并统一 42900', async (path, body) => {
    const first = await request(httpServer(app))
      .post(path)
      .set('Authorization', authHeader)
      .send(body);
    expect(first.status).toBe(200);
    const second = await request(httpServer(app))
      .post(path)
      .set('Authorization', authHeader)
      .send(body);
    expectBizError(second, BizCode.TOO_MANY_REQUESTS, { strictMessage: false });
    expect(second.headers['x-ratelimit-limit']).toBeUndefined();
    expect(second.headers['retry-after']).toBeUndefined();
  });
});
