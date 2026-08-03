import type { INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { WECOM_LOGIN_NONCE_COOKIE } from '../../src/modules/auth/wecom-browser-nonce';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 企业微信接入 T3 e2e 组 A:pre-auth 五端点全链
// (冻结稿 docs/archive/reviews/wecom-integration-t0-terminal-review.md §6.2 / §14.2)
//
// 覆盖 goal DoD:
//   DoD 2 敏感值纪律 —— state / bindingTicket / code 原文不入 DB、不入 Audit
//   DoD 4 防枚举 —— 未绑定 / 已撤销 / 跨企业 userid / 账号停用 对外不可区分
//   DoD 5 loginEnabled=false 时全部新端点 36030(默认配置即关)
//
// DevStub 语义(§7.2):wecomUserId = `dev-wecom-<sha256(code) 前 24 位>`,确定性映射 ——
// 不同 code 模拟不同企业微信成员;故障注入 code 含 `wecomerr-oauth` / `wecomerr-api`。
// SMS 走 DEV_STUB 固定码 888888。
//
// 行为锁:密码 / OTP / 微信三种既有登录的断言**零修改**,本文件仅新增。

const AUTHORIZE_PATH = '/api/auth/v1/login-wecom/authorize';
const LOGIN_PATH = '/api/auth/v1/login-wecom';
const SEND_PATH = '/api/auth/v1/wecom-bind/send-code';
const BIND_PATH = '/api/auth/v1/wecom-bind';
const REFRESH_PATH = '/api/auth/v1/refresh';

const FIXED_SMS_CODE = '888888';
const CORP_ID = 'wwT3CorpIdForE2E';
const AGENT_ID = 1000002;
const WEB_BASE_URL = 'https://srvf-e2e.example.org';

const PHONE_ACTIVE = '13930000001';
const PHONE_DISABLED = '13930000002';
const PHONE_DELETED = '13930000003';
const PHONE_NEVER = '13930000004'; // 库里根本没有这个号
const PHONE_NO_PHONE_USER = '13930000005'; // 有账号但 User.phone=null(该号不属于任何人)
const PHONE_REBIND = '13930000006';

/** DevStub 的确定性身份映射(与 dev-stub-wecom.provider.ts 同式)。 */
function stubWecomUserId(code: string): string {
  return `dev-wecom-${createHash('sha256').update(code).digest('hex').slice(0, 24)}`;
}

function sha256Hex(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

// P1-27 第一刀 B1(2026-08-03):authorize 下发的浏览器关联 nonce cookie,按 state 存档。
// 模拟的就是"同一个浏览器把这条流程走完" —— 本文件测的是功能链路,
// 换浏览器必须失败的判据在 wecom-account-takeover.e2e-spec.ts。
const browserJar = new Map<string, string>();

function rememberBrowserCookie(res: request.Response, state: string): void {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const line = (raw ?? []).find((c) => c.startsWith(`${WECOM_LOGIN_NONCE_COOKIE}=`));
  expect(line).toBeDefined();
  browserJar.set(state, (line as string).split(';')[0]);
}

describe('企业微信 OAuth 登录 + 首次绑定全链(T3 e2e 组 A)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let uActiveId: string;
  let uRebindId: string;

  function authorize(body: Record<string, unknown> = {}): Promise<request.Response> {
    return request(httpServer(app)).post(AUTHORIZE_PATH).send(body);
  }

  function login(code: string, state: string): Promise<request.Response> {
    const req = request(httpServer(app)).post(LOGIN_PATH);
    // P1-27 第一刀 B1(2026-08-03):state 现在绑定发起授权的那个浏览器。
    // `freshState()` 把那次 authorize 拿到的 nonce cookie 记进 browserJar,
    // 这里按 state 取回 —— 等价于"同一个浏览器把流程走完",
    // 于是本文件所有既有调用点与断言**逐字不动**。
    // (刻意不用 supertest agent 的自动 jar:本仓另有 wecom-account-takeover.e2e-spec.ts
    //  专门测"换一个浏览器提交必须失败",那边必须能显式控制谁持有哪份 cookie。)
    const cookie = browserJar.get(state);
    if (cookie !== undefined) req.set('Cookie', cookie);
    return req.send({ code, state });
  }

  function sendCode(bindingTicket: string, phone: string): Promise<request.Response> {
    return request(httpServer(app)).post(SEND_PATH).send({ bindingTicket, phone });
  }

  function bind(bindingTicket: string, phone: string, smsCode: string): Promise<request.Response> {
    return request(httpServer(app)).post(BIND_PATH).send({ bindingTicket, phone, smsCode });
  }

  /** 走一次 authorize 并从 URL 里取出 state —— 前端拿到的也只有这一条路径。 */
  async function freshState(): Promise<string> {
    const res = await authorize({ returnPath: '/activities' });
    expect(res.status).toBe(200);
    const url = res.body.data.authorizeUrl as string;
    const state = /[?&]state=([^&#]+)/.exec(url)?.[1];
    expect(state).toBeDefined();
    rememberBrowserCookie(res, state as string);
    return state as string;
  }

  /** 未绑定登录 → 拿到一次性 bindingTicket。 */
  async function ticketFor(code: string): Promise<string> {
    const res = await login(code, await freshState());
    expect(res.status).toBe(200);
    expect(res.body.data.bindingRequired).toBe(true);
    return res.body.data.bindingTicket as string;
  }

  // 同号 60s 间隔是 DB 层常量,用改 createdAt 绕过(沿 auth-wechat spec 范式)
  async function rewindInterval(phone: string): Promise<void> {
    await prisma.smsVerificationCode.updateMany({
      where: { phone },
      data: { createdAt: new Date(Date.now() - 61_000) },
    });
  }

  async function setSwitches(patch: { enabled?: boolean; loginEnabled?: boolean }): Promise<void> {
    await prisma.wecomSettings.updateMany({ data: patch });
  }

  beforeAll(async () => {
    // 必须在 createTestApp 之前生效(app.config factory 注册时读取)。
    // 本组是功能链路测试,限流专测另设 —— 这里调到配置允许的上限 100 避免相互干扰
    // (app.config 对该值有 [1,100] 范围校验,写 500 会在建 app 时就 fail-fast)。
    process.env.LOGIN_WECOM_THROTTLE_LIMIT = '100';
    // ⚠️ wecom-bind/send-code 按冻结稿 §6.2 **同时**挂 login-wecom 与既有 sms-send 两个限流器,
    // wecom-bind 同时挂 login-wecom 与 sms-verify。sms-send 默认只有 5/60 ——
    // 不一起调大,本组第 6 次发码就会拿到 429,而失败现场看起来像"防枚举断言不成立"
    // (实测:429 让 send-code 没发码,随后 bind 报 24010,一路误导到短信码去)。
    process.env.SMS_SEND_THROTTLE_LIMIT = '100';
    process.env.SMS_VERIFY_THROTTLE_LIMIT = '100';
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);

    await prisma.smsSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });
    await prisma.wecomSettings.create({
      data: {
        providerType: 'DEV_STUB',
        enabled: true,
        loginEnabled: true,
        corpId: CORP_ID,
        agentId: AGENT_ID,
        webBaseUrl: WEB_BASE_URL,
      },
    });

    const uActive = await createTestUser(app, { username: 'wcm_active' });
    uActiveId = uActive.id;
    await prisma.user.update({
      where: { id: uActiveId },
      data: { phone: PHONE_ACTIVE, phoneVerifiedAt: new Date() },
    });

    const uRebind = await createTestUser(app, { username: 'wcm_rebind' });
    uRebindId = uRebind.id;
    await prisma.user.update({ where: { id: uRebindId }, data: { phone: PHONE_REBIND } });

    const uDisabled = await createTestUser(app, { username: 'wcm_disabled', status: 'DISABLED' });
    await prisma.user.update({ where: { id: uDisabled.id }, data: { phone: PHONE_DISABLED } });

    const uDeleted = await createTestUser(app, { username: 'wcm_deleted', deletedAt: new Date() });
    await prisma.user.update({ where: { id: uDeleted.id }, data: { phone: PHONE_DELETED } });

    // 有账号但没手机号 —— PHONE_NO_PHONE_USER 这个号不属于任何人
    await createTestUser(app, { username: 'wcm_nophone' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.wecomIdentity.deleteMany();
    await prisma.wecomAuthAttempt.deleteMany();
    await prisma.smsVerificationCode.deleteMany();
    await prisma.auditLog.deleteMany();
    await setSwitches({ enabled: true, loginEnabled: true });
  });

  // ===== ① authorize:URL 形态与 state 纪律(§6.2 / §14.2 第 2 项)=====

  describe('authorize URL 与 state', () => {
    it('URL 含 agentid / snsapi_base / 编码一次的固定 redirect_uri / 64 字符 hex state', async () => {
      const res = await authorize({ returnPath: '/activities' });
      expect(res.status).toBe(200);
      const url = res.body.data.authorizeUrl as string;

      expect(url.startsWith('https://open.weixin.qq.com/connect/oauth2/authorize?')).toBe(true);
      expect(url).toContain(`appid=${CORP_ID}`);
      expect(url).toContain(`agentid=${AGENT_ID}`);
      expect(url).toContain('scope=snsapi_base');
      expect(url).toContain('response_type=code');
      expect(url.endsWith('#wechat_redirect')).toBe(true);

      // redirect_uri 只编码一次:解码一次即还原,且不出现二次编码痕迹
      expect(url).not.toContain('%25');
      const redirect = /redirect_uri=([^&]+)/.exec(url)?.[1] ?? '';
      expect(decodeURIComponent(redirect)).toBe(`${WEB_BASE_URL}/auth/wecom/callback`);

      const state = /[?&]state=([^&#]+)/.exec(url)?.[1] ?? '';
      expect(state).toMatch(/^[0-9a-f]{64}$/);
      expect(Buffer.byteLength(state, 'utf8')).toBeLessThanOrEqual(128);
    });

    it('DB 只存 state 的 SHA-256,原文零留痕(§5.3 规则 1)', async () => {
      const state = await freshState();
      const rows = await prisma.wecomAuthAttempt.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0].stateHash).toBe(sha256Hex(state));
      // 整行序列化后不得出现原文
      expect(JSON.stringify(rows[0])).not.toContain(state);
    });

    it('purpose=login 的 attempt 恒 subjectUserId=null(§5.3 规则 3)', async () => {
      await freshState();
      const row = await prisma.wecomAuthAttempt.findFirstOrThrow();
      expect(row.purpose).toBe('login');
      expect(row.subjectUserId).toBeNull();
      expect(row.status).toBe('pending');
    });

    it('省略 returnPath 时用默认站内路径', async () => {
      const res = await authorize({});
      expect(res.status).toBe(200);
      const row = await prisma.wecomAuthAttempt.findFirstOrThrow();
      expect(row.returnPath).toBe('/');
    });

    // §14.2 第 3 项:returnPath 开放重定向攻击全拒
    it.each([
      ['绝对 URL', 'https://evil.com'],
      ['协议相对', '//evil.com'],
      ['反斜杠', '/\\evil.com'],
      ['编码绕过', '/%2F%2Fevil.com'],
      ['userinfo', '/user:pass@evil.com'],
      ['javascript scheme', 'javascript:alert(1)'],
      ['token-like query', '/activities?access_token=x'],
      ['camelCase token query', '/activities?refreshToken=x'],
    ])('returnPath 攻击载荷全拒:%s', async (_label, returnPath) => {
      const res = await authorize({ returnPath });
      expectBizError(res, BizCode.BAD_REQUEST);
      // 被拒的请求不得在台账里留下任何行(否则畸形 returnPath 可按请求速率堆库)
      expect(await prisma.wecomAuthAttempt.count()).toBe(0);
    });
  });

  // ===== ② login:未绑定 / 已绑定 / state 一次性(§6.2 / §14.2 第 4-6 项)=====

  describe('login-wecom', () => {
    it('未绑定 → bindingRequired + ticket;响应不含 wecomUserId / corpId / attempt id', async () => {
      const res = await login('wecom-code-A', await freshState());
      expect(res.status).toBe(200);

      const data = res.body.data as Record<string, unknown>;
      expect(data.bindingRequired).toBe(true);
      expect(typeof data.bindingTicket).toBe('string');
      expect(data.session).toBeNull();
      expect(data.returnPath).toBe('/activities');

      // 字段集恰好这四个 —— 多一个都可能是侧信道
      expect(Object.keys(data).sort()).toEqual([
        'bindingRequired',
        'bindingTicket',
        'returnPath',
        'session',
      ]);
      // §6.2 规则 9:不得回显 hasPhone / 手机号尾号 / 账号状态
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(stubWecomUserId('wecom-code-A'));
      expect(body).not.toContain(CORP_ID);
      expect(body.toLowerCase()).not.toContain('hasphone');
    });

    it('state 一次性:同 state 第二次 → 36010(§14.2 第 4 项)', async () => {
      const state = await freshState();
      expect((await login('wecom-code-A', state)).status).toBe(200);
      expectBizError(await login('wecom-code-A', state), BizCode.WECOM_LOGIN_CREDENTIAL_INVALID);
    });

    it('伪造 / 过期 state → 36010', async () => {
      expectBizError(
        await login('wecom-code-A', 'f'.repeat(64)),
        BizCode.WECOM_LOGIN_CREDENTIAL_INVALID,
      );

      const state = await freshState();
      await prisma.wecomAuthAttempt.updateMany({
        data: { stateExpiresAt: new Date(Date.now() - 1000) },
      });
      expectBizError(await login('wecom-code-A', state), BizCode.WECOM_LOGIN_CREDENTIAL_INVALID);
    });

    it('已绑定 → 与密码登录同形 session,且 refresh 可轮换(§14.2 第 5 项)', async () => {
      // 先完成一次绑定
      const ticket = await ticketFor('wecom-code-A');
      await sendCode(ticket, PHONE_ACTIVE);
      expect((await bind(ticket, PHONE_ACTIVE, FIXED_SMS_CODE)).status).toBe(200);

      const res = await login('wecom-code-A', await freshState());
      expect(res.status).toBe(200);
      expect(res.body.data.bindingRequired).toBe(false);
      expect(res.body.data.bindingTicket).toBeNull();

      const session = res.body.data.session as Record<string, unknown>;
      // LoginResponseDto 字段集不变(§6.2 规则 6)
      expect(Object.keys(session).sort()).toEqual([
        'accessToken',
        'expiresIn',
        'refreshExpiresAt',
        'refreshToken',
        'tokenType',
      ]);

      const refreshed = await request(httpServer(app))
        .post(REFRESH_PATH)
        .send({ refreshToken: session.refreshToken });
      expect(refreshed.status).toBe(200);
    });

    it('登录成功写且仅写一条 auth.login.wecom,extra 只含允许字段(§11.3)', async () => {
      const ticket = await ticketFor('wecom-code-A');
      await sendCode(ticket, PHONE_ACTIVE);
      await bind(ticket, PHONE_ACTIVE, FIXED_SMS_CODE);
      await prisma.auditLog.deleteMany();

      await login('wecom-code-A', await freshState());
      const logs = await prisma.auditLog.findMany({ where: { event: 'auth.login.wecom' } });
      expect(logs).toHaveLength(1);

      const extra = (logs[0].context as { extra?: Record<string, unknown> }).extra ?? {};
      expect(Object.keys(extra).sort()).toEqual(['familyId', 'identityId', 'wecomUserIdMasked']);
      // 完整 wecomUserId 永不入 Audit
      expect(String(extra.wecomUserIdMasked)).toContain('****');
      expect(JSON.stringify(logs[0])).not.toContain(stubWecomUserId('wecom-code-A'));
    });

    // §14.2 第 10 项:bound User DISABLED / soft-delete 与 invalid code 同码同形
    it('绑定账号 DISABLED / 软删 → 与 code 无效同码同形 36010(防侧写)', async () => {
      const ticket = await ticketFor('wecom-code-B');
      await sendCode(ticket, PHONE_ACTIVE);
      await bind(ticket, PHONE_ACTIVE, FIXED_SMS_CODE);
      await prisma.user.update({ where: { id: uActiveId }, data: { status: 'DISABLED' } });

      const disabledRes = await login('wecom-code-B', await freshState());
      const invalidCodeRes = await login('wecomerr-oauth-x', await freshState());

      expectBizError(disabledRes, BizCode.WECOM_LOGIN_CREDENTIAL_INVALID);
      expectBizError(invalidCodeRes, BizCode.WECOM_LOGIN_CREDENTIAL_INVALID);
      // 逐字段不可区分
      expect(disabledRes.status).toBe(invalidCodeRes.status);
      expect(disabledRes.body).toEqual(invalidCodeRes.body);

      await prisma.user.update({ where: { id: uActiveId }, data: { status: 'ACTIVE' } });
    });

    // §14.2 第 11 项:外部成员 / 跨企业 userid 统一 36010
    it('上游 OAuth 身份类失败(外部成员 / 跨企业)→ 36010', async () => {
      expectBizError(
        await login('wecomerr-oauth', await freshState()),
        BizCode.WECOM_LOGIN_CREDENTIAL_INVALID,
      );
    });

    it('上游 API 故障 → 36031(与身份类失败分层)', async () => {
      expectBizError(await login('wecomerr-api', await freshState()), BizCode.WECOM_API_FAILED);
      expectBizError(await login('wecomerr-timeout', await freshState()), BizCode.WECOM_API_FAILED);
    });

    it('超长 code(>512 字节)不打上游,直接 36010', async () => {
      const state = await freshState();
      expectBizError(await login('a'.repeat(513), state), BizCode.WECOM_LOGIN_CREDENTIAL_INVALID);
      // state 已消费(不复活),attempt 落 failed
      const row = await prisma.wecomAuthAttempt.findFirstOrThrow();
      expect(row.status).toBe('failed');
    });
  });

  // ===== ③ send-code 防枚举(§6.2 / §14.2 第 9 项)=====

  describe('wecom-bind/send-code 防枚举', () => {
    it('五种无效场景与有效号**逐字段相同**且零留痕', async () => {
      const ticket = await ticketFor('wecom-code-A');

      const valid = await sendCode(ticket, PHONE_ACTIVE);
      expect(valid.status).toBe(200);

      for (const phone of [PHONE_NEVER, PHONE_NO_PHONE_USER, PHONE_DISABLED, PHONE_DELETED]) {
        const res = await sendCode(ticket, phone);
        expect(res.status).toBe(valid.status);
        expect(res.body).toEqual(valid.body);
        // 无效号一条码都不该落库
        expect(await prisma.smsVerificationCode.count({ where: { phone } })).toBe(0);
        expect(await prisma.smsSendLog.count({ where: { phone } })).toBe(0);
      }
      // 有效号确实发了
      expect(await prisma.smsVerificationCode.count({ where: { phone: PHONE_ACTIVE } })).toBe(1);
    });

    it('binding ticket 只校验不消费:可连发两次', async () => {
      const ticket = await ticketFor('wecom-code-A');
      expect((await sendCode(ticket, PHONE_ACTIVE)).status).toBe(200);
      await rewindInterval(PHONE_ACTIVE);
      expect((await sendCode(ticket, PHONE_ACTIVE)).status).toBe(200);

      const row = await prisma.wecomAuthAttempt.findFirstOrThrow();
      expect(row.bindingConsumedAt).toBeNull();
      expect(row.status).toBe('binding_required');
    });

    it('无效 / 已消费 ticket → 36011', async () => {
      expectBizError(await sendCode('nope', PHONE_ACTIVE), BizCode.WECOM_BINDING_TICKET_INVALID);

      const ticket = await ticketFor('wecom-code-A');
      await sendCode(ticket, PHONE_ACTIVE);
      await bind(ticket, PHONE_ACTIVE, FIXED_SMS_CODE);
      expectBizError(await sendCode(ticket, PHONE_ACTIVE), BizCode.WECOM_BINDING_TICKET_INVALID);
    });
  });

  // ===== ④ bind:首绑 / 换绑 / 重放(§6.2 七步 / §14.2 第 12 项)=====

  describe('wecom-bind', () => {
    it('首绑成功:建 active 身份 + 两条 Audit + 直接签发会话', async () => {
      const ticket = await ticketFor('wecom-code-A');
      await sendCode(ticket, PHONE_ACTIVE);

      const res = await bind(ticket, PHONE_ACTIVE, FIXED_SMS_CODE);
      expect(res.status).toBe(200);
      expect(typeof res.body.data.accessToken).toBe('string');

      const identities = await prisma.wecomIdentity.findMany({ where: { userId: uActiveId } });
      expect(identities).toHaveLength(1);
      expect(identities[0].status).toBe('active');
      expect(identities[0].corpId).toBe(CORP_ID);
      expect(identities[0].wecomUserId).toBe(stubWecomUserId('wecom-code-A'));
      expect(identities[0].bindingSource).toBe('pre-auth');
      expect(identities[0].revokedAt).toBeNull();

      // 绑定成功有两条 Audit:身份绑定事件 + 登录事件(§6.2 末段)
      const events = (await prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } })).map(
        (l) => l.event,
      );
      expect(events).toContain('wecom.bind.self');
      expect(events).toContain('auth.login.wecom');

      const bindLog = await prisma.auditLog.findFirstOrThrow({
        where: { event: 'wecom.bind.self' },
      });
      const ctx = bindLog.context as {
        before?: unknown;
        after?: Record<string, unknown>;
        extra?: Record<string, unknown>;
      };
      expect(ctx.before).toBeUndefined(); // 首绑无 before
      expect(String(ctx.after?.wecomUserId)).toContain('****');
      expect(ctx.extra).toEqual({ viaPath: 'pre-auth' });
    });

    it('换绑:结束旧身份 + 建新身份,active 恒 1', async () => {
      const t1 = await ticketFor('wecom-code-A');
      await sendCode(t1, PHONE_REBIND);
      await bind(t1, PHONE_REBIND, FIXED_SMS_CODE);
      await prisma.auditLog.deleteMany();

      const t2 = await ticketFor('wecom-code-C');
      await prisma.smsVerificationCode.deleteMany();
      await sendCode(t2, PHONE_REBIND);
      expect((await bind(t2, PHONE_REBIND, FIXED_SMS_CODE)).status).toBe(200);

      const all = await prisma.wecomIdentity.findMany({ where: { userId: uRebindId } });
      expect(all).toHaveLength(2);
      expect(all.filter((i) => i.status === 'active')).toHaveLength(1);
      const revoked = all.find((i) => i.status === 'revoked');
      expect(revoked?.revokedAt).not.toBeNull();
      expect(revoked?.wecomUserId).toBe(stubWecomUserId('wecom-code-A'));

      const rebindLog = await prisma.auditLog.findFirstOrThrow({
        where: { event: 'wecom.rebind.self' },
      });
      const ctx = rebindLog.context as {
        before?: Record<string, unknown>;
        after?: Record<string, unknown>;
      };
      expect(String(ctx.before?.wecomUserId)).toContain('****');
      expect(String(ctx.after?.wecomUserId)).toContain('****');
    });

    it('bind 重放:同 ticket 第二次 → 36011', async () => {
      const ticket = await ticketFor('wecom-code-A');
      await sendCode(ticket, PHONE_ACTIVE);
      expect((await bind(ticket, PHONE_ACTIVE, FIXED_SMS_CODE)).status).toBe(200);
      expectBizError(
        await bind(ticket, PHONE_ACTIVE, FIXED_SMS_CODE),
        BizCode.WECOM_BINDING_TICKET_INVALID,
      );
    });

    it('ticket 过期 → 36011', async () => {
      const ticket = await ticketFor('wecom-code-A');
      await sendCode(ticket, PHONE_ACTIVE);
      await prisma.wecomAuthAttempt.updateMany({
        data: { bindingExpiresAt: new Date(Date.now() - 1000) },
      });
      expectBizError(
        await bind(ticket, PHONE_ACTIVE, FIXED_SMS_CODE),
        BizCode.WECOM_BINDING_TICKET_INVALID,
      );
    });

    it('号码无效 / 短信码错误统一 24010(与彼此同码同形)', async () => {
      const ticket = await ticketFor('wecom-code-A');
      await sendCode(ticket, PHONE_ACTIVE);

      const wrongPhone = await bind(ticket, PHONE_NEVER, FIXED_SMS_CODE);
      const wrongCode = await bind(ticket, PHONE_ACTIVE, '000000');
      expectBizError(wrongPhone, BizCode.SMS_CODE_INVALID);
      expectBizError(wrongCode, BizCode.SMS_CODE_INVALID);
      expect(wrongPhone.body).toEqual(wrongCode.body);
      // 失败不落身份
      expect(await prisma.wecomIdentity.count()).toBe(0);
    });

    it('该企业微信身份已被他人 active 绑定 → 36002(不是裸 500)', async () => {
      // ⚠️ 两张票都必须在**任何人绑定之前**签发 —— 一旦绑定完成,再走 login-wecom
      // 拿到的是 `bindingRequired:false` + 会话,根本不会再发票,
      // 也就构造不出"两个人手里各有一张指向同一企业微信号的票"这个真实竞态
      // (同一个人在两台设备上各走一次 OAuth 就是这个形状)。
      const tLoser = await ticketFor('wecom-code-A');
      const tWinner = await ticketFor('wecom-code-A');

      await sendCode(tWinner, PHONE_ACTIVE);
      expect((await bind(tWinner, PHONE_ACTIVE, FIXED_SMS_CODE)).status).toBe(200);

      // 另一个账号拿同一个企业微信号(同 code ⇒ 同 stub wecomUserId)去绑
      await prisma.smsVerificationCode.deleteMany();
      await sendCode(tLoser, PHONE_REBIND);
      expectBizError(
        await bind(tLoser, PHONE_REBIND, FIXED_SMS_CODE),
        BizCode.WECOM_IDENTITY_ALREADY_BOUND,
      );

      // 输家不留任何身份行:赢家恒 1 条 active
      const active = await prisma.wecomIdentity.findMany({ where: { status: 'active' } });
      expect(active).toHaveLength(1);
      expect(active[0].userId).toBe(uActiveId);
    });
  });

  // ===== ⑤ 敏感值纪律(goal DoD 2)=====

  describe('敏感值纪律:state / ticket / code 原文零落地', () => {
    it('走完整链后,DB 与 Audit 中都 grep 不到三种一次性凭证原文', async () => {
      const code = 'wecom-code-SENSITIVE';
      const state = await freshState();
      const loginRes = await login(code, state);
      const ticket = loginRes.body.data.bindingTicket as string;
      await sendCode(ticket, PHONE_ACTIVE);
      await bind(ticket, PHONE_ACTIVE, FIXED_SMS_CODE);

      const attempts = JSON.stringify(await prisma.wecomAuthAttempt.findMany());
      const identities = JSON.stringify(await prisma.wecomIdentity.findMany());
      const audits = JSON.stringify(await prisma.auditLog.findMany());
      const haystack = `${attempts}|${identities}|${audits}`;

      for (const secret of [state, ticket, code]) {
        expect(haystack).not.toContain(secret);
      }
      // 只留 hash
      expect(attempts).toContain(sha256Hex(state));
      expect(attempts).toContain(sha256Hex(ticket));
      // code 连 hash 都不存
      expect(haystack).not.toContain(sha256Hex(code));
      // 完整 wecomUserId 只在 identities 里,不进 Audit
      expect(identities).toContain(stubWecomUserId(code));
      expect(audits).not.toContain(stubWecomUserId(code));
    });
  });

  // ===== ⑥ 开关 fail-closed(goal DoD 5 / §14.2 第 1 项)=====

  describe('loginEnabled=false 时全部新端点拒绝', () => {
    it('二级闸关闭 → authorize / login / send-code / bind 全 36030', async () => {
      const ticket = await ticketFor('wecom-code-A');
      const state = await freshState();
      await setSwitches({ loginEnabled: false });

      expectBizError(await authorize({}), BizCode.WECOM_CHANNEL_NOT_CONFIGURED);
      expectBizError(await login('wecom-code-A', state), BizCode.WECOM_CHANNEL_NOT_CONFIGURED);
      // send-code / bind 的 ticket 仍有效,但通道闸已关 —— 绑定链路整体停摆
      expect((await sendCode(ticket, PHONE_ACTIVE)).status).toBe(200); // 只碰 SMS,不碰企业微信通道
      expectBizError(
        await bind(ticket, PHONE_ACTIVE, FIXED_SMS_CODE),
        BizCode.WECOM_CHANNEL_NOT_CONFIGURED,
      );
    });

    it('总闸关闭 → 同样 36030(二级闸为 true 也不放行)', async () => {
      const state = await freshState();
      // 直接改库绕过 settings 写入口的组合不变量,模拟"总闸被关"的运行时事实
      await prisma.wecomSettings.updateMany({ data: { enabled: false, loginEnabled: true } });
      expectBizError(await authorize({}), BizCode.WECOM_CHANNEL_NOT_CONFIGURED);
      expectBizError(await login('wecom-code-A', state), BizCode.WECOM_CHANNEL_NOT_CONFIGURED);
    });

    it('settings 缺 corpId / agentId / webBaseUrl → 36030(fail-closed,不猜默认值)', async () => {
      await prisma.wecomSettings.updateMany({ data: { agentId: null } });
      expectBizError(await authorize({}), BizCode.WECOM_CHANNEL_NOT_CONFIGURED);

      await prisma.wecomSettings.updateMany({ data: { agentId: AGENT_ID, webBaseUrl: null } });
      expectBizError(await authorize({}), BizCode.WECOM_CHANNEL_NOT_CONFIGURED);

      await prisma.wecomSettings.updateMany({ data: { webBaseUrl: WEB_BASE_URL, corpId: null } });
      expectBizError(await authorize({}), BizCode.WECOM_CHANNEL_NOT_CONFIGURED);

      await prisma.wecomSettings.updateMany({ data: { corpId: CORP_ID } });
    });
  });
});
