import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 微信小程序登录 T3 e2e 组 A:pre-auth 三端点全链(冻结评审稿
// docs/archive/reviews/wechat-mini-login-review.md §4 / §10;DevStub 驱动,
// 结构沿 auth-login-sms.e2e-spec 双 app 范式——本组限流配额经 env 调大,
// 限流专测在组 B〔auth-wechat-throttle〕)。
//
// DevStub 语义(评审稿 E-10):openid = `dev-openid-<code>`,确定性映射——
// 不同 code 模拟不同微信用户;SMS 码走 DEV_STUB 固定 888888。
//
// 防枚举断言纪律(评审稿 §4.2/§4.3):wechat-bind/send-code 无效场景响应体与有效场景
// **逐字段一致**且 DB 零留痕;wechat-bind 号码无效统一 24010 与码无效同形;
// login-wechat 账号 DISABLED/软删 统一 25010 与 code 无效场景同码。
// 行为锁:密码登录(auth-login spec)/ OTP 登录断言零修改;本文件仅新增。

const LOGIN_WECHAT_PATH = '/api/auth/v1/login-wechat';
const SEND_PATH = '/api/auth/v1/wechat-bind/send-code';
const BIND_PATH = '/api/auth/v1/wechat-bind';
const REFRESH_PATH = '/api/auth/v1/refresh';
const FIXED_SMS_CODE = '888888';

const PHONE_ACTIVE = '13920000001';
const PHONE_DISABLED = '13920000002';
const PHONE_DELETED = '13920000003';
const PHONE_CLEARED = '13920000004'; // 曾绑定后被清除(DB 视图同从未绑定)
const PHONE_NEVER = '13920000005'; // 从未绑定
const PHONE_REBIND = '13920000006';

describe('微信登录 + 绑定全链(T3 e2e 组 A;IP 限流调大)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let uActiveId: string;
  let uRebindId: string;
  let uDisabledId: string;

  function loginWechat(code: string): Promise<request.Response> {
    return request(httpServer(app)).post(LOGIN_WECHAT_PATH).send({ code });
  }

  function sendCode(phone: string): Promise<request.Response> {
    return request(httpServer(app)).post(SEND_PATH).send({ phone });
  }

  function bind(code: string, phone: string, smsCode: string): Promise<request.Response> {
    return request(httpServer(app)).post(BIND_PATH).send({ code, phone, smsCode });
  }

  // 间隔回拨:同号 60s 间隔为 DB 层常量,用改 createdAt 绕过(沿 app-me-phone-bind 范式)
  async function rewindInterval(phone: string): Promise<void> {
    await prisma.smsVerificationCode.updateMany({
      where: { phone },
      data: { createdAt: new Date(Date.now() - 61_000) },
    });
  }

  beforeAll(async () => {
    // 必须在 createTestApp 之前生效(app.config factory 注册时读取)
    process.env.LOGIN_WECHAT_THROTTLE_LIMIT = '100';
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);
    // 双 DevStub 通道:SMS(固定码)+ wechat(确定性假 openid)
    await prisma.smsSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });
    await prisma.wechatSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });

    const uActive = await createTestUser(app, { username: 'wxl_active' });
    uActiveId = uActive.id;
    await prisma.user.update({
      where: { id: uActiveId },
      data: { phone: PHONE_ACTIVE, phoneVerifiedAt: new Date() },
    });

    const uDisabled = await createTestUser(app, { username: 'wxl_disabled', status: 'DISABLED' });
    uDisabledId = uDisabled.id;
    await prisma.user.update({ where: { id: uDisabledId }, data: { phone: PHONE_DISABLED } });

    const uDeleted = await createTestUser(app, { username: 'wxl_deleted', deletedAt: new Date() });
    await prisma.user.update({ where: { id: uDeleted.id }, data: { phone: PHONE_DELETED } });

    // 曾绑定手机后被清除:落库终态 phone=null
    const uCleared = await createTestUser(app, { username: 'wxl_cleared' });
    await prisma.user.update({ where: { id: uCleared.id }, data: { phone: PHONE_CLEARED } });
    await prisma.user.update({
      where: { id: uCleared.id },
      data: { phone: null, phoneVerifiedAt: null },
    });

    const uRebind = await createTestUser(app, { username: 'wxl_rebind' });
    uRebindId = uRebind.id;
    await prisma.user.update({ where: { id: uRebindId }, data: { phone: PHONE_REBIND } });
  });

  afterAll(async () => {
    delete process.env.LOGIN_WECHAT_THROTTLE_LIMIT;
    await app.close();
  });

  describe('① login-wechat 两路(评审稿 §4.2)', () => {
    it('未绑 openid → 200 bindingRequired:true + session:null(不签发不留痕)', async () => {
      const res = await loginWechat('never-bound-code');
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data).toEqual({ bindingRequired: true, session: null });
      // 零留痕:无 refresh token / 无 audit
      expect(await prisma.refreshToken.count()).toBe(0);
      expect(await prisma.auditLog.count({ where: { event: 'auth.login.wechat' } })).toBe(0);
    });

    it('首次绑定全链:send-code → bind → JWT 可用且与密码登录同构(refresh 可旋转)', async () => {
      // send-code(有效号)
      const sendRes = await sendCode(PHONE_ACTIVE);
      expect(sendRes.status).toBe(200);
      expect(sendRes.body.data).toEqual({ expiresInSeconds: 300 });

      // bind:wx code 'wx-user-1' → openid dev-openid-wx-user-1
      const bindRes = await bind('wx-user-1', PHONE_ACTIVE, FIXED_SMS_CODE);
      expect(bindRes.status).toBe(200);
      const session = bindRes.body.data as Record<string, unknown>;
      // 同 LoginResponseDto 形状(5 字段,与密码登录同构,评审稿 E-15)
      expect(Object.keys(session).sort()).toEqual([
        'accessToken',
        'expiresIn',
        'refreshExpiresAt',
        'refreshToken',
        'tokenType',
      ]);

      // 落库:openid 已绑
      const row = await prisma.user.findUniqueOrThrow({
        where: { id: uActiveId },
        select: { openid: true },
      });
      expect(row.openid).toBe('dev-openid-wx-user-1');

      // audit:wechat.bind.self(viaPath=pre-auth,openid 掩码)+ auth.login.wechat
      const bindAudit = await prisma.auditLog.findFirstOrThrow({
        where: { event: 'wechat.bind.self', actorUserId: uActiveId },
      });
      const bindStr = JSON.stringify(bindAudit);
      expect(bindStr).not.toContain('dev-openid-wx-user-1'); // 完整 openid 不入 audit
      expect(bindStr).toContain('pre-auth');
      expect(await prisma.auditLog.count({ where: { event: 'auth.login.wechat' } })).toBe(1);

      // JWT 同构:refresh token 可旋转(与密码登录同 family 机制)
      const refreshRes = await request(httpServer(app))
        .post(REFRESH_PATH)
        .send({ refreshToken: session.refreshToken });
      expect(refreshRes.status).toBe(200);
      expect(refreshRes.body.data.accessToken).toBeDefined();
    });

    it('已绑 openid → 200 bindingRequired:false + session(同 code 确定性命中)', async () => {
      // DevStub 确定性:同 code 'wx-user-1' 恒得同 openid
      const res = await loginWechat('wx-user-1');
      expect(res.status).toBe(200);
      expect(res.body.data.bindingRequired).toBe(false);
      const session = res.body.data.session as Record<string, unknown>;
      expect(session.accessToken).toBeDefined();
      expect(session.tokenType).toBe('Bearer');
      // access token 可用
      const me = await request(httpServer(app))
        .get('/api/app/v1/me/wechat')
        .set('Authorization', `Bearer ${session.accessToken as string}`);
      expect(me.status).toBe(200);
      expect(me.body.data.bound).toBe(true);
      // openid 掩码回显,完整值不出现
      expect(JSON.stringify(me.body)).not.toContain('dev-openid-wx-user-1');
    });

    it('防侧写:绑定的账号被禁用 / 软删 → 统一 25010(与 code 无效同码)', async () => {
      // 给 DISABLED 账号直接落一个 openid(模拟历史绑定后被禁用)
      await prisma.user.update({
        where: { id: uDisabledId },
        data: { openid: 'dev-openid-disabled-wx' },
      });
      const res = await loginWechat('disabled-wx');
      expectBizError(res, BizCode.WECHAT_CODE_INVALID);
    });
  });

  describe('② wechat-bind/send-code 防枚举(评审稿 §4.3;沿 login-sms E-O4 范式)', () => {
    it('四种无效号码场景响应与有效号逐字段一致(泛化 200)且零留痕', async () => {
      await rewindInterval(PHONE_ACTIVE);
      const valid = await sendCode(PHONE_ACTIVE);
      const invalids = await Promise.all([
        sendCode(PHONE_NEVER), // 不存在
        sendCode(PHONE_CLEARED), // 曾绑定已清除
        sendCode(PHONE_DISABLED), // 禁用
        sendCode(PHONE_DELETED), // 软删
      ]);
      for (const res of invalids) {
        expect(res.status).toBe(valid.status);
        expect(res.body).toEqual(valid.body); // 响应体逐字段一致
      }
      // 零留痕:四个无效号不产生 code 行 / send_log 行
      for (const phone of [PHONE_NEVER, PHONE_CLEARED, PHONE_DISABLED, PHONE_DELETED]) {
        expect(await prisma.smsVerificationCode.count({ where: { phone } })).toBe(0);
        expect(await prisma.smsSendLog.count({ where: { phone } })).toBe(0);
      }
    });

    it('purpose=WECHAT_BIND 落库(与 LOGIN / PASSWORD_RESET 隔离)', async () => {
      const codes = await prisma.smsVerificationCode.findMany({
        where: { phone: PHONE_ACTIVE },
        select: { purpose: true },
      });
      expect(codes.length).toBeGreaterThan(0);
      expect(codes.every((c) => c.purpose === 'WECHAT_BIND')).toBe(true);
    });
  });

  describe('③ wechat-bind 失败面(评审稿 §4.3 顺序冻结)', () => {
    it('号码无效(四场景代表:从未绑定)→ 统一 24010(与码无效同码同形)', async () => {
      const res = await bind('any-code', PHONE_NEVER, FIXED_SMS_CODE);
      expectBizError(res, BizCode.SMS_CODE_INVALID);
    });

    it('SMS 码错误 → 24010;wx code 已在 ① 消耗不烧 SMS 码(同码可重试成功)', async () => {
      await rewindInterval(PHONE_REBIND);
      await sendCode(PHONE_REBIND);
      // 错 SMS 码
      const bad = await bind('wx-user-2', PHONE_REBIND, '000000');
      expectBizError(bad, BizCode.SMS_CODE_INVALID);
      // 同一有效 SMS 码仍可成功(③ 预检不消费,错码只 attempts+1)
      const ok = await bind('wx-user-2', PHONE_REBIND, FIXED_SMS_CODE);
      expect(ok.status).toBe(200);
      const row = await prisma.user.findUniqueOrThrow({
        where: { id: uRebindId },
        select: { openid: true },
      });
      expect(row.openid).toBe('dev-openid-wx-user-2');
    });

    it('openid 已绑他账号 → 25002(仅对持有效 SMS 码者可达)', async () => {
      await rewindInterval(PHONE_ACTIVE);
      await sendCode(PHONE_ACTIVE);
      // wx-user-2 的 openid 已绑 uRebind;用 uActive 的手机锚点试图抢绑
      const res = await bind('wx-user-2', PHONE_ACTIVE, FIXED_SMS_CODE);
      expectBizError(res, BizCode.WECHAT_ALREADY_BOUND);
    });

    it('pre-auth 换绑:同账号绑新 openid(覆盖旧值)→ wechat.rebind.self audit', async () => {
      await rewindInterval(PHONE_REBIND);
      await sendCode(PHONE_REBIND);
      const res = await bind('wx-user-2-new', PHONE_REBIND, FIXED_SMS_CODE);
      expect(res.status).toBe(200);
      const row = await prisma.user.findUniqueOrThrow({
        where: { id: uRebindId },
        select: { openid: true },
      });
      expect(row.openid).toBe('dev-openid-wx-user-2-new');
      const rebindAudit = await prisma.auditLog.findFirstOrThrow({
        where: { event: 'wechat.rebind.self', actorUserId: uRebindId },
      });
      // before/after openid 均掩码
      const s = JSON.stringify(rebindAudit);
      expect(s).not.toContain('dev-openid-wx-user-2-new');
      expect(s).not.toContain('dev-openid-wx-user-2');
    });

    it('已绑本人 + 有效码 → 幂等成功(不重写 audit,直接签发)', async () => {
      const before = await prisma.auditLog.count({
        where: { event: { in: ['wechat.bind.self', 'wechat.rebind.self'] } },
      });
      await rewindInterval(PHONE_REBIND);
      await sendCode(PHONE_REBIND);
      const res = await bind('wx-user-2-new', PHONE_REBIND, FIXED_SMS_CODE);
      expect(res.status).toBe(200);
      const after = await prisma.auditLog.count({
        where: { event: { in: ['wechat.bind.self', 'wechat.rebind.self'] } },
      });
      expect(after).toBe(before); // 幂等:绑定类 audit 零新增
    });

    it('通道未配置 → 25030(settings 禁用即时生效经 invalidate;恢复后还原)', async () => {
      await prisma.wechatSettings.updateMany({ data: { enabled: false } });
      // 60s 缓存:直接清 service 内缓存比等待更稳——用 app 内实例 invalidate
      const { WechatSettingsService } =
        await import('../../src/modules/wechat/wechat-settings.service');
      app.get(WechatSettingsService).invalidate();
      const res = await loginWechat('any');
      expectBizError(res, BizCode.WECHAT_CHANNEL_NOT_CONFIGURED);
      await prisma.wechatSettings.updateMany({ data: { enabled: true } });
      app.get(WechatSettingsService).invalidate();
    });
  });

  // 2026-06-12 增量审计③④⑤收口:此前 auth.login.wechat 仅 count 断言(掩码内容未锁)、
  // 七步③→④顺序冻结无判别用例、:77 软删半边零触达。本组只新增,既有断言零修改。
  describe('④ review 收口增补(增量审计③④⑤)', () => {
    it('auth.login.wechat audit extra:openid 全量掩码,完整值零出现(审计③)', async () => {
      // uActive 已绑 wx-user-1(组①);再走一次已绑登录,连同此前 bind ⑦ 路留痕一并锁内容
      const res = await loginWechat('wx-user-1');
      expect(res.status).toBe(200);
      expect(res.body.data.bindingRequired).toBe(false);

      const rows = await prisma.auditLog.findMany({ where: { event: 'auth.login.wechat' } });
      // 两个调用点(login 已绑路 :85 / bind ⑦ 路 :200)此刻均已留痕
      expect(rows.length).toBeGreaterThanOrEqual(4);
      const s = JSON.stringify(rows);
      expect(s).not.toContain('dev-openid-wx-user-1'); // 完整 openid 零出现
      expect(s).not.toContain('dev-openid-wx-user-2'); // 前缀同时覆盖 wx-user-2-new
      expect(s).toContain('dev-****er-1'); // maskOpenid('dev-openid-wx-user-1') 掩码形态
    });

    it('七步顺序③→④判别:openid 已被他人占用 + SMS 码错 → 24010 非 25002(审计④)', async () => {
      // dev-openid-wx-user-2-new 已绑 uRebind(组③);用 uActive 手机锚点 + 错码试探。
      // 若 ④ 占用检查被挪到 ③ 码预检之前,此处会泄 25002 =
      // 无码攻击者可探测任意 openid 的绑定关系(oracle,评审稿 §4.3 顺序冻结红线)。
      await rewindInterval(PHONE_ACTIVE);
      await sendCode(PHONE_ACTIVE);
      const res = await bind('wx-user-2-new', PHONE_ACTIVE, '000000');
      expectBizError(res, BizCode.SMS_CODE_INVALID);
    });

    it('防侧写:软删账号已绑 openid → 统一 25010(审计⑤;镜像 DISABLED 用例)', async () => {
      // 给软删账号直接落 openid(模拟历史绑定后被软删);status 保持 ACTIVE,
      // 使本用例只能由 deletedAt 半边拦下(:77 两半边各自有判别力)
      const uDeleted = await prisma.user.findFirstOrThrow({
        where: { username: 'wxl_deleted' },
        select: { id: true },
      });
      await prisma.user.update({
        where: { id: uDeleted.id },
        data: { openid: 'dev-openid-deleted-wx' },
      });
      const res = await loginWechat('deleted-wx');
      expectBizError(res, BizCode.WECHAT_CODE_INVALID);
    });
  });
});

describe('微信登录 — 组 B:IP 限流第 8 实例(真实默认 5/60)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    process.env.LOGIN_WECHAT_THROTTLE_LIMIT = '5';
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);
    await prisma.wechatSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });
    await prisma.smsSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });
  });

  afterAll(async () => {
    delete process.env.LOGIN_WECHAT_THROTTLE_LIMIT;
    await app.close();
  });

  it('login-wechat:同 IP 第 6 次 → 42900;计数与 login-sms 实例物理隔离;不暴露限流头', async () => {
    // 5 次配额内(未绑 code,业务上 bindingRequired:true 照常 200;每次计数 1)
    for (let i = 0; i < 5; i += 1) {
      const r = await request(httpServer(app))
        .post(LOGIN_WECHAT_PATH)
        .send({ code: `throttle-${i}` });
      expect(r.status).toBe(200);
    }
    const sixth = await request(httpServer(app))
      .post(LOGIN_WECHAT_PATH)
      .send({ code: 'throttle-6' });
    expectBizError(sixth, BizCode.TOO_MANY_REQUESTS, { strictMessage: false });
    expect(sixth.headers['x-ratelimit-limit']).toBeUndefined();
    expect(sixth.headers['retry-after']).toBeUndefined();

    // 物理隔离:login-wechat 配额吃满后,login-sms 第 7 实例照常可用(无效号泛化 200)
    const sms = await request(httpServer(app))
      .post('/api/auth/v1/login-sms/send-code')
      .send({ phone: '13999990001' });
    expect(sms.status).toBe(200);

    // 端点×IP 各自计数:wechat-bind/send-code 端点自身配额未被 login-wechat 吃掉
    // (无效号防枚举泛化 200,不触 DB 层限频)
    const send = await request(httpServer(app)).post(SEND_PATH).send({ phone: '13999990002' });
    expect(send.status).toBe(200);
  });
});
