import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import { createHash } from 'node:crypto';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import {
  WECOM_BIND_NONCE_COOKIE,
  WECOM_LOGIN_NONCE_COOKIE,
} from '../../src/modules/auth/wecom-browser-nonce';
import { grantOpsAdminToUser, seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { createTestUser, TEST_PASSWORD } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 企业微信 T3 账号接管面(外部评审 2026-08-03,NEXT_TASKS P1-27 第一刀 B1 / B2)
//
// 本文件是**红先行**证据:两条 BLOCKER 各自的用例在未修代码上必须真红。
//
// B1 —— OAuth `state` 未绑定发起浏览器 ⇒ 登录 CSRF;攻击者身份**未绑定**时可升级为
//       完整账号接管(受害者在自己浏览器里看到 bindingRequired,输入自己手机号 + 短信码,
//       于是攻击者的企业微信身份被绑到受害者 User)。
//       修法:authorize 另发浏览器关联 nonce(Secure+HttpOnly+SameSite Cookie),
//       callback 必须同时携带匹配 Cookie,state / nonce / attempt 一次性原子消费。
//       ⚠️ 判据是**双 user-agent**:同一份 code+state 在 A 浏览器成功、在 B 浏览器必须失败。
//          单浏览器跑不出这条 —— 那正是本仓原 e2e 全绿却带着这个洞的原因。
//
// B2 —— `WECOM_BIND` step-up proof 的 ABA 回环:无绑定态指纹是字面 `null`,
//       `null → bind → admin clear → null` 之后**旧 proof 复活**。
//       修法:单调身份代际 `User.wecomIdentityVersion`,proof snapshot 纳入 version。
//       ⚠️ 判据必须是 `无绑定签 proof → 绑定 → admin clear → 新 state + 旧 proof → 10008`;
//          只测 `active → clear` 的既有用例**永远绿**,抓不到这条。
//
// 与既有两组 T3 e2e 的关系:auth-wecom(组 A)/ app-me-wecom(组 B)断言**零修改**;
// 本文件只新增。

const AUTHORIZE_PATH = '/api/auth/v1/login-wecom/authorize';
const LOGIN_PATH = '/api/auth/v1/login-wecom';
const SEND_PATH = '/api/auth/v1/wecom-bind/send-code';
const BIND_PATH = '/api/auth/v1/wecom-bind';
const BIND_AUTHORIZE_PATH = '/api/auth/v1/wecom-bind/authorize';
const STEP_UP_PASSWORD_PATH = '/api/auth/v1/step-up/password';
const ME_WECOM_PATH = '/api/app/v1/me/wecom';

const FIXED_SMS_CODE = '888888';
const CORP_ID = 'wwT3CorpIdTakeover';
const AGENT_ID = 1000004;
const WEB_BASE_URL = 'https://srvf-e2e-takeover.example.org';

const PHONE_VICTIM = '13930001001';
const PHONE_ABA = '13930001002';

/** DevStub 的确定性身份映射(与 dev-stub-wecom.provider.ts 同式)。 */
function stubWecomUserId(code: string): string {
  return `dev-wecom-${createHash('sha256').update(code).digest('hex').slice(0, 24)}`;
}

function findSetCookie(res: request.Response, name: string): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const hit = (raw ?? []).find((line) => line.startsWith(`${name}=`));
  expect(hit).toBeDefined();
  return hit as string;
}

/**
 * 从 Set-Cookie 里取出 `name=value`(供另一个"浏览器"显式携带 / 显式不携带)。
 *
 * 刻意**不用** supertest 的 agent 自动 cookie jar:本文件的全部判据都是
 * "哪个浏览器持有哪份 cookie",自动 jar 会把这件事藏起来。
 */
function readCookiePair(res: request.Response, name: string): string {
  return findSetCookie(res, name).split(';')[0];
}

describe('企业微信 T3 账号接管面(P1-27 第一刀 B1 / B2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let victimId: string;
  let abaId: string;
  let abaAuth: string;
  let adminAuth: string;

  // ===== 低层请求(全部显式声明"这个请求来自哪个浏览器")=====

  function authorizeLogin(cookie?: string): Promise<request.Response> {
    const req = request(httpServer(app)).post(AUTHORIZE_PATH);
    if (cookie !== undefined) req.set('Cookie', cookie);
    return req.send({ returnPath: '/activities' });
  }

  function login(code: string, state: string, cookie?: string): Promise<request.Response> {
    const req = request(httpServer(app)).post(LOGIN_PATH);
    if (cookie !== undefined) req.set('Cookie', cookie);
    return req.send({ code, state });
  }

  function sendBindCode(bindingTicket: string, phone: string): Promise<request.Response> {
    return request(httpServer(app)).post(SEND_PATH).send({ bindingTicket, phone });
  }

  function bind(bindingTicket: string, phone: string, smsCode: string): Promise<request.Response> {
    return request(httpServer(app)).post(BIND_PATH).send({ bindingTicket, phone, smsCode });
  }

  function authorizeBindSelf(auth: string): Promise<request.Response> {
    return request(httpServer(app)).post(BIND_AUTHORIZE_PATH).set('Authorization', auth).send({});
  }

  function putMyWecom(
    auth: string,
    body: Record<string, unknown>,
    cookie?: string,
  ): Promise<request.Response> {
    const req = request(httpServer(app)).put(ME_WECOM_PATH).set('Authorization', auth);
    if (cookie !== undefined) req.set('Cookie', cookie);
    return req.send(body);
  }

  function clearWecom(auth: string, targetId: string): Promise<request.Response> {
    return request(httpServer(app))
      .delete(`/api/admin/v1/users/${targetId}/wecom`)
      .set('Authorization', auth);
  }

  async function stepUpToken(auth: string, action = 'WECOM_BIND'): Promise<string> {
    const res = await request(httpServer(app))
      .post(STEP_UP_PASSWORD_PATH)
      .set('Authorization', auth)
      .send({ action, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    return res.body.data.stepUpToken as string;
  }

  function stateFromAuthorizeUrl(res: request.Response): string {
    const url = res.body.data.authorizeUrl as string;
    const state = /[?&]state=([^&#]+)/.exec(url)?.[1];
    expect(state).toBeDefined();
    return state as string;
  }

  /** 一个"浏览器"发起 login authorize:同时拿到 state 与它自己的 nonce cookie。 */
  async function openLoginFlow(): Promise<{ state: string; cookie: string }> {
    const res = await authorizeLogin();
    expect(res.status).toBe(200);
    return {
      state: stateFromAuthorizeUrl(res),
      cookie: readCookiePair(res, WECOM_LOGIN_NONCE_COOKIE),
    };
  }

  /** 一个"浏览器"发起 bind_self authorize。 */
  async function openBindFlow(auth: string): Promise<{ state: string; cookie: string }> {
    const res = await authorizeBindSelf(auth);
    expect(res.status).toBe(200);
    return {
      state: stateFromAuthorizeUrl(res),
      cookie: readCookiePair(res, WECOM_BIND_NONCE_COOKIE),
    };
  }

  async function rewindSmsInterval(phone: string): Promise<void> {
    await prisma.smsVerificationCode.updateMany({
      where: { phone },
      data: { createdAt: new Date(Date.now() - 61_000) },
    });
  }

  beforeAll(async () => {
    process.env.LOGIN_WECOM_THROTTLE_LIMIT = '100';
    process.env.SMS_SEND_THROTTLE_LIMIT = '100';
    process.env.SMS_VERIFY_THROTTLE_LIMIT = '100';
    process.env.PASSWORD_CHANGE_THROTTLE_LIMIT = '100'; // step-up/password 复用该实例
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

    const victim = await createTestUser(app, { username: 'wct_victim' });
    victimId = victim.id;
    await prisma.user.update({
      where: { id: victimId },
      data: { phone: PHONE_VICTIM, phoneVerifiedAt: new Date() },
    });

    const aba = await createTestUser(app, { username: 'wct_aba' });
    abaId = aba.id;
    await prisma.user.update({ where: { id: abaId }, data: { phone: PHONE_ABA } });

    const admin = await createTestUser(app, { username: 'wct_admin', role: Role.ADMIN });

    const { opsAdminRoleId } = await seedRbacPermissionsAndOpsAdmin(app);
    const perm = await prisma.permission.upsert({
      where: { code: 'user.wecom.clear' },
      update: {},
      create: {
        code: 'user.wecom.clear',
        module: 'user',
        action: 'clear',
        resourceType: 'wecom',
      },
      select: { id: true },
    });
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: opsAdminRoleId, permissionId: perm.id } },
      update: {},
      create: { roleId: opsAdminRoleId, permissionId: perm.id },
    });
    await grantOpsAdminToUser(app, admin.id, opsAdminRoleId);

    const authHeaderFor = async (username: string): Promise<string> => {
      const res = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username, password: TEST_PASSWORD });
      expect(res.status).toBe(200);
      return `Bearer ${res.body.data.accessToken as string}`;
    };
    abaAuth = await authHeaderFor('wct_aba');
    adminAuth = await authHeaderFor('wct_admin');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.wecomIdentity.deleteMany();
    await prisma.wecomAuthAttempt.deleteMany();
    await prisma.smsVerificationCode.deleteMany();
    await prisma.auditLog.deleteMany();
  });

  // ===== B1:OAuth state 必须绑定发起浏览器 =====

  describe('B1 —— state 绑定发起浏览器(登录 CSRF / 账号接管)', () => {
    it('authorize 下发 HttpOnly + Secure + SameSite 的浏览器 nonce cookie,原值既不是 state 也不落库', async () => {
      const res = await authorizeLogin();
      expect(res.status).toBe(200);

      const line = findSetCookie(res, WECOM_LOGIN_NONCE_COOKIE);
      expect(line).toMatch(/;\s*HttpOnly/i);
      expect(line).toMatch(/;\s*Secure/i);
      expect(line).toMatch(/;\s*SameSite=/i);

      const nonce = line.split(';')[0].slice(`${WECOM_LOGIN_NONCE_COOKIE}=`.length);
      expect(nonce).toMatch(/^[0-9a-f]{64}$/);

      // nonce 原值 ≠ state 原值(state 会经 WeCom 重定向暴露在 URL / referer / 日志里)
      const state = stateFromAuthorizeUrl(res);
      expect(nonce).not.toBe(state);

      // 台账里既没有 nonce 原值,也没有 state 原值
      const rows = await prisma.wecomAuthAttempt.findMany();
      expect(rows).toHaveLength(1);
      const serialized = JSON.stringify(rows[0]);
      expect(serialized).not.toContain(nonce);
      expect(serialized).not.toContain(state);
    });

    it('发起浏览器自己提交 code+state → 200(正向对照:修复没有把整条链锁死)', async () => {
      const a = await openLoginFlow();
      const res = await login('wct-self-ok', a.state, a.cookie);
      expect(res.status).toBe(200);
      expect(res.body.data.bindingRequired).toBe(true);
      expect(typeof res.body.data.bindingTicket).toBe('string');
    });

    it('A 浏览器发起、B 浏览器提交同一份 code+state → 36010(登录 CSRF 被挡)', async () => {
      const a = await openLoginFlow();
      // 浏览器 B:完全没有 cookie
      expectBizError(await login('wct-csrf-1', a.state), BizCode.WECOM_LOGIN_CREDENTIAL_INVALID);
      // 浏览器 B':持有自己另一次 authorize 的 cookie(不是 A 的那份)
      const b = await openLoginFlow();
      expectBizError(
        await login('wct-csrf-1', a.state, b.cookie),
        BizCode.WECOM_LOGIN_CREDENTIAL_INVALID,
      );
    });

    it('非发起浏览器的失败**不消费** state —— 发起浏览器随后仍能正常完成(不可被 DoS)', async () => {
      const a = await openLoginFlow();
      expectBizError(await login('wct-nodos', a.state), BizCode.WECOM_LOGIN_CREDENTIAL_INVALID);

      const ok = await login('wct-nodos', a.state, a.cookie);
      expect(ok.status).toBe(200);
      expect(ok.body.data.bindingRequired).toBe(true);
    });

    // ⚠️ 本条是 B1 里**唯一**能走到"完整账号接管"的分支,必须单独覆盖:
    // 攻击者的企业微信身份尚未绑定任何账号,受害者浏览器一旦被诱导提交 code+state,
    // 就会拿到 bindingRequired + ticket,并在自己的页面上输入**自己的**手机号与短信码 ——
    // 于是攻击者的企业微信身份被绑到受害者 User,攻击者此后可直接用企业微信登录受害者账号。
    it('攻击者身份未绑定 + 受害者浏览器:不得签出 bindingTicket,接管链在第一步断掉', async () => {
      const attacker = await openLoginFlow();
      const attackerCode = 'wct-takeover-attacker';

      // 受害者浏览器(没有攻击者的 nonce cookie)提交攻击者的 code+state
      const victimBrowser = await login(attackerCode, attacker.state);
      expectBizError(victimBrowser, BizCode.WECOM_LOGIN_CREDENTIAL_INVALID);

      // 响应里没有票 —— 受害者页面根本渲染不出"输入手机号"那一步
      expect(victimBrowser.body.data).toBeNull();

      // 台账:attempt 不得进入 binding_required、不得签出 bindingTicketHash
      const rows = await prisma.wecomAuthAttempt.findMany();
      expect(rows.every((row) => row.status !== 'binding_required')).toBe(true);
      expect(rows.every((row) => row.bindingTicketHash === null)).toBe(true);

      // 终态不变量:攻击者身份没有落到受害者账号上
      const bound = await prisma.wecomIdentity.findFirst({
        where: { wecomUserId: stubWecomUserId(attackerCode) },
      });
      expect(bound).toBeNull();
    });

    it('bind_self(PUT me/wecom)同样绑定发起浏览器', async () => {
      const flow = await openBindFlow(abaAuth);
      const token = await stepUpToken(abaAuth);

      // 没有 cookie 的第二个"浏览器"提交 → 36010
      expectBizError(
        await putMyWecom(abaAuth, { code: 'wct-bindself', state: flow.state, stepUpToken: token }),
        BizCode.WECOM_LOGIN_CREDENTIAL_INVALID,
      );

      // 发起浏览器仍可完成(state 未被上一步消费)
      const ok = await putMyWecom(
        abaAuth,
        { code: 'wct-bindself', state: flow.state, stepUpToken: token },
        flow.cookie,
      );
      expect(ok.status).toBe(200);
      expect(ok.body.data.bound).toBe(true);
    });

    // 正向对照:带着正确 cookie 的完整 pre-auth 绑定链仍然可用(手机 + 短信码锚点不受影响)
    it('发起浏览器完整走完 未绑定 → 发码 → 绑定,链路不被 B1 修复破坏', async () => {
      const a = await openLoginFlow();
      const code = 'wct-happy-path';
      const res = await login(code, a.state, a.cookie);
      expect(res.status).toBe(200);
      const ticket = res.body.data.bindingTicket as string;

      expect((await sendBindCode(ticket, PHONE_VICTIM)).status).toBe(200);
      await rewindSmsInterval(PHONE_VICTIM);
      const bound = await bind(ticket, PHONE_VICTIM, FIXED_SMS_CODE);
      expect(bound.status).toBe(200);
      expect(typeof bound.body.data.accessToken).toBe('string');

      const identity = await prisma.wecomIdentity.findFirstOrThrow({
        where: { userId: victimId, status: 'active' },
      });
      expect(identity.wecomUserId).toBe(stubWecomUserId(code));
    });
  });

  // ===== B2:单调身份代际(WECOM_BIND proof 的 ABA 回环)=====

  describe('B2 —— 身份代际(proof ABA 回环)', () => {
    /** 完整一次本人绑定:authorize(拿 cookie)+ 新 proof + PUT。 */
    async function bindSelfOnce(auth: string, code: string): Promise<request.Response> {
      const flow = await openBindFlow(auth);
      const token = await stepUpToken(auth);
      return putMyWecom(auth, { code, state: flow.state, stepUpToken: token }, flow.cookie);
    }

    it('正向对照:无绑定态签的 proof,当场用于首绑 → 200(代际未变即有效)', async () => {
      const flow = await openBindFlow(abaAuth);
      const proofAtV0 = await stepUpToken(abaAuth);
      const res = await putMyWecom(
        abaAuth,
        { code: 'wct-aba-control', state: flow.state, stepUpToken: proofAtV0 },
        flow.cookie,
      );
      expect(res.status).toBe(200);
      expect(res.body.data.bound).toBe(true);
    });

    it('null → bind → admin clear → null 之后,无绑定态签的旧 proof 必须失效(10008)', async () => {
      // ① 无绑定态签 proof(此刻身份指纹 = 字面 null)
      const proofAtV0 = await stepUpToken(abaAuth);

      // ② 真正绑定一次(用另一份新 proof,不动 proofAtV0)
      const bound = await bindSelfOnce(abaAuth, 'wct-aba-bound');
      expect(bound.status).toBe(200);

      // ③ 管理员清除 → 身份回到"无绑定",指纹**字面上**又变回 null
      expect((await clearWecom(adminAuth, abaId)).status).toBe(200);
      expect(await prisma.wecomIdentity.count({ where: { userId: abaId, status: 'active' } })).toBe(
        0,
      );

      // ④ 用**新 state + 新 cookie**,但拿 ① 那份早已"过时"的 proof 再绑一次。
      //    修复前:指纹又是 null ⇒ snapshot 相等 ⇒ 旧 proof 复活 ⇒ 200(账号被绑回去)。
      //    修复后:User.wecomIdentityVersion 单调递增(0→1→2),snapshot 不再相等 ⇒ 10008。
      const replayFlow = await openBindFlow(abaAuth);
      const replay = await putMyWecom(
        abaAuth,
        { code: 'wct-aba-replay', state: replayFlow.state, stepUpToken: proofAtV0 },
        replayFlow.cookie,
      );
      expectBizError(replay, BizCode.STEP_UP_PROOF_INVALID);

      // 终态不变量:没有任何 active 身份被这条重放建出来
      expect(await prisma.wecomIdentity.count({ where: { userId: abaId, status: 'active' } })).toBe(
        0,
      );
    });

    it('代际列单调递增:bind / rebind / admin clear 各 +1,幂等空转不制造代际', async () => {
      const readVersion = async (): Promise<number> =>
        (
          await prisma.user.findUniqueOrThrow({
            where: { id: abaId },
            select: { wecomIdentityVersion: true },
          })
        ).wecomIdentityVersion;

      const v0 = await readVersion();

      expect((await bindSelfOnce(abaAuth, 'wct-gen-1')).status).toBe(200);
      const v1 = await readVersion();
      expect(v1).toBeGreaterThan(v0);

      // rebind(换成另一个企业微信号)
      expect((await bindSelfOnce(abaAuth, 'wct-gen-2')).status).toBe(200);
      const v2 = await readVersion();
      expect(v2).toBeGreaterThan(v1);

      // admin clear
      expect((await clearWecom(adminAuth, abaId)).status).toBe(200);
      const v3 = await readVersion();
      expect(v3).toBeGreaterThan(v2);

      // 幂等空转的 clear 不制造代际(什么都没变)
      expect((await clearWecom(adminAuth, abaId)).status).toBe(200);
      expect(await readVersion()).toBe(v3);
    });

    it('同目标 no-op 换绑不制造代际(与"什么都没变不写 audit"同口径)', async () => {
      expect((await bindSelfOnce(abaAuth, 'wct-noop')).status).toBe(200);
      const before = await prisma.user.findUniqueOrThrow({
        where: { id: abaId },
        select: { wecomIdentityVersion: true },
      });

      expect((await bindSelfOnce(abaAuth, 'wct-noop')).status).toBe(200);
      const after = await prisma.user.findUniqueOrThrow({
        where: { id: abaId },
        select: { wecomIdentityVersion: true },
      });
      expect(after.wecomIdentityVersion).toBe(before.wecomIdentityVersion);
    });

    it('User 软删也走同一撤销原语 ⇒ 同样制造代际(reopen 由该原语覆盖,不另写一套)', async () => {
      const doomed = await createTestUser(app, { username: `wct_soft_${Date.now() % 100000}` });
      await prisma.wecomIdentity.create({
        data: {
          userId: doomed.id,
          corpId: CORP_ID,
          wecomUserId: `dev-wecom-soft-${doomed.id.slice(-8)}`,
          status: 'active',
          bindingSource: 'pre-auth',
          boundAt: new Date(),
        },
      });
      const before = await prisma.user.findUniqueOrThrow({
        where: { id: doomed.id },
        select: { wecomIdentityVersion: true },
      });

      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/users/${doomed.id}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: doomed.id },
        select: { wecomIdentityVersion: true },
      });
      expect(after.wecomIdentityVersion).toBeGreaterThan(before.wecomIdentityVersion);
    });

    it('代际列不出现在任何 App / Admin 响应里(它是判据不是可见字段)', async () => {
      expect((await bindSelfOnce(abaAuth, 'wct-gen-hidden')).status).toBe(200);

      const me = await request(httpServer(app)).get(ME_WECOM_PATH).set('Authorization', abaAuth);
      expect(me.status).toBe(200);
      expect(JSON.stringify(me.body)).not.toContain('wecomIdentityVersion');

      const cleared = await clearWecom(adminAuth, abaId);
      expect(cleared.status).toBe(200);
      expect(JSON.stringify(cleared.body)).not.toContain('wecomIdentityVersion');
    });
  });
});
