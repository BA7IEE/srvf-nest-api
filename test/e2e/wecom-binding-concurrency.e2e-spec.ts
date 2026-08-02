import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import { createHash } from 'node:crypto';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { WECOM_LOGIN_NONCE_COOKIE } from '../../src/modules/auth/wecom-browser-nonce';
import { loginAs } from '../fixtures/auth.fixture';
import { grantOpsAdminToUser, seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 企业微信接入 T3 e2e 组 C:绑定链路真并发(冻结稿 §9.3 / §9.4 / §9.5;§14.2 第 4/13/14/15 项)
//
// 覆盖 goal DoD 3「并发红先行」四条:
//   ① 同 ticket 双消费单赢家
//   ② 同 User 并发双绑定单赢家(active identity 恒 1)
//   ③ 两 User 并发绑同一 wecomUserId:一成功一 36002,**禁裸 500**
//   ④ 管理员清除 × 本人登录竞态:任何交错下都不得留下"身份已撤销却还有活会话"
//
// **测试编排**(不是被测语义的一部分,沿 wecom-settings-concurrency 同款屏障):
//   两套独立 Nest app(各自 Prisma 池)发请求;第三条池外连接持
//   `LOCK TABLE "wecom_identities" IN SHARE MODE`。
//   - 事务内的 SELECT(含 settings FOR SHARE / User FOR UPDATE / identity findFirst)**不受阻**
//     → 两条请求都能读到"目标身份还没人占"这一旧事实,这正是要钉住的窗口
//   - `INSERT INTO wecom_identities` 要 RowExclusiveLock,与 ShareLock **冲突** → 双双卡住
//   等两条都卡住再放行,partial unique 才真正成为唯一裁判。
//
// ⚠️ 屏障窗口必须远小于 Prisma 交互事务的 5s 预算 —— 否则用例会以 P2028 红盖住真判据。
// ⚠️ `datname = current_database()` 不可省:pg_stat_activity 是**实例级**视图,
//   per-worker 测试库由 TEMPLATE 克隆,别的 worker 的等待者会被计进来 → 屏障提前放行
//   → 两条请求退化为串行 → 断言照样通过(假绿)。

const AUTHORIZE_PATH = '/api/auth/v1/login-wecom/authorize';
const LOGIN_PATH = '/api/auth/v1/login-wecom';
const SEND_PATH = '/api/auth/v1/wecom-bind/send-code';
const BIND_PATH = '/api/auth/v1/wecom-bind';

const FIXED_SMS_CODE = '888888';
const CORP_ID = 'wwT3CorpIdConc';
const AGENT_ID = 1000004;
const WEB_BASE_URL = 'https://srvf-e2e-c.example.org';

const PHONE_A = '13940000001';
const PHONE_B = '13940000002';

function stubWecomUserId(code: string): string {
  return `dev-wecom-${createHash('sha256').update(code).digest('hex').slice(0, 24)}`;
}

describe('企业微信绑定链路真并发(T3 e2e 组 C)', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let userAId: string;
  let userBId: string;
  let adminAuth: string;

  beforeAll(async () => {
    process.env.LOGIN_WECOM_THROTTLE_LIMIT = '100';
    process.env.SMS_SEND_THROTTLE_LIMIT = '100';
    process.env.SMS_VERIFY_THROTTLE_LIMIT = '100';
    appA = await createTestApp();
    appB = await createTestApp();
    await resetDb(appA);
    prismaA = appA.get(PrismaService);
    prismaB = appB.get(PrismaService);

    await prismaA.smsSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });
    await prismaA.wecomSettings.create({
      data: {
        providerType: 'DEV_STUB',
        enabled: true,
        loginEnabled: true,
        corpId: CORP_ID,
        agentId: AGENT_ID,
        webBaseUrl: WEB_BASE_URL,
      },
    });

    const ua = await createTestUser(appA, { username: 'wcc_a' });
    userAId = ua.id;
    await prismaA.user.update({ where: { id: userAId }, data: { phone: PHONE_A } });

    const ub = await createTestUser(appA, { username: 'wcc_b' });
    userBId = ub.id;
    await prismaA.user.update({ where: { id: userBId }, data: { phone: PHONE_B } });

    const admin = await createTestUser(appA, { username: 'wcc_admin', role: Role.ADMIN });
    const { opsAdminRoleId } = await seedRbacPermissionsAndOpsAdmin(appA);
    const perm = await prismaA.permission.upsert({
      where: { code: 'user.wecom.clear' },
      update: {},
      create: { code: 'user.wecom.clear', module: 'user', action: 'clear', resourceType: 'wecom' },
      select: { id: true },
    });
    await prismaA.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: opsAdminRoleId, permissionId: perm.id } },
      update: {},
      create: { roleId: opsAdminRoleId, permissionId: perm.id },
    });
    await grantOpsAdminToUser(appA, admin.id, opsAdminRoleId);
    adminAuth = (await loginAs(appA, 'wcc_admin')).authHeader;
  });

  afterAll(async () => {
    await Promise.all([appA.close(), appB.close()]);
  });

  beforeEach(async () => {
    await prismaA.wecomIdentity.deleteMany();
    await prismaA.wecomAuthAttempt.deleteMany();
    await prismaA.smsVerificationCode.deleteMany();
    await prismaA.refreshToken.deleteMany();
    await prismaA.auditLog.deleteMany();
  });

  // ===== 编排工具 =====

  // P1-27 第一刀 B1(2026-08-03):authorize 下发的浏览器关联 nonce cookie 按 state 存档。
  // 本文件测的是并发正确性,「换浏览器提交必须失败」在 wecom-account-takeover.e2e-spec.ts;
  // 这里一律模拟"同一个浏览器",于是全部并发判据与终态断言逐字不动
  // —— 包括「同一个 state 并发消费两次」:两个请求带的是**同一份** nonce,
  // 单赢家仍然只能由 CAS 决出,而不是被 cookie 判据抢答。
  const browserJar = new Map<string, string>();

  async function stateVia(app: INestApplication): Promise<string> {
    const res = await request(httpServer(app)).post(AUTHORIZE_PATH).send({});
    expect(res.status).toBe(200);
    const state = /[?&]state=([^&#]+)/.exec(res.body.data.authorizeUrl as string)?.[1] as string;
    const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
    const line = (raw ?? []).find((c) => c.startsWith(`${WECOM_LOGIN_NONCE_COOKIE}=`));
    expect(line).toBeDefined();
    browserJar.set(state, (line as string).split(';')[0]);
    return state;
  }

  /** 以"持有该 state 对应 nonce 的那个浏览器"的身份发 login 请求。 */
  function loginVia(app: INestApplication, code: string, state: string): request.Test {
    const req = request(httpServer(app)).post(LOGIN_PATH);
    const cookie = browserJar.get(state);
    if (cookie !== undefined) req.set('Cookie', cookie);
    return req.send({ code, state });
  }

  async function ticketVia(app: INestApplication, code: string): Promise<string> {
    const res = await loginVia(app, code, await stateVia(app));
    expect(res.status).toBe(200);
    expect(res.body.data.bindingRequired).toBe(true);
    return res.body.data.bindingTicket as string;
  }

  async function issueSmsCode(app: INestApplication, ticket: string, phone: string): Promise<void> {
    const res = await request(httpServer(app))
      .post(SEND_PATH)
      .send({ bindingTicket: ticket, phone });
    expect(res.status).toBe(200);
  }

  function bindVia(app: INestApplication, ticket: string, phone: string): request.Test {
    return request(httpServer(app))
      .post(BIND_PATH)
      .send({ bindingTicket: ticket, phone, smsCode: FIXED_SMS_CODE });
  }

  /**
   * 等到两条请求都真的卡住。
   *
   * ⚠️ **两条请求卡在哪张表上,取决于它们是不是同一个 User** —— 这一条是实测出来的,
   * 也正是锁序 §9.1 在起作用的证据,不是测试脚手架的细节:
   *
   * - **跨 User**:两条各锁各的 User 行,互不阻塞,双双走到
   *   `INSERT INTO wecom_identities` 撞上屏障 ⇒ 2 个 `wecom_identities` waiter。
   * - **同 User**:先到者拿到 `SELECT … FROM "User" … FOR UPDATE`,后到者**在这一步就排队**,
   *   根本走不到 INSERT ⇒ 只有 1 个 `wecom_identities` waiter + 1 个 `User` 行锁 waiter。
   *   初版一律等 2 个 identity waiter,同 User 的两条用例因此恒超时假红。
   *
   * 所以按「卡在本链路任一把锁上的连接数」计数,而不是钉死某一张表。
   */
  async function waitForBindingLockWaiters(expected: number): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const [row] = await prismaB.$queryRaw<Array<{ waitingCount: number }>>`
        SELECT count(*)::int AS "waitingCount"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND (
            query LIKE '%wecom_identities%'
            OR (query LIKE '%FROM "User"%' AND query LIKE '%FOR UPDATE%')
          )
      `;
      if ((row?.waitingCount ?? 0) >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`expected at least ${expected} binding-chain lock waiter(s)`);
  }

  /** 在 wecom_identities 表屏障窗口内并发跑两条请求。 */
  async function raceUnderIdentityBarrier(
    first: () => request.Test,
    second: () => request.Test,
  ): Promise<request.Response[]> {
    let signalReady!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = prismaA.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('LOCK TABLE "wecom_identities" IN SHARE MODE');
      signalReady();
      await released;
    });

    await ready;
    const attempts = Promise.all([first(), second()]);
    try {
      await waitForBindingLockWaiters(2);
    } finally {
      release();
      await blocker;
    }
    return attempts;
  }

  function statusesOf(responses: request.Response[]): number[] {
    return responses.map((r) => r.status).sort((a, b) => a - b);
  }

  // ===== ① 两 User 并发绑同一 wecomUserId(§9.3 / §14.2 第 13 项)=====

  it('两 User 并发绑同一企业微信身份 → 一个 200、一个 36002,**无裸 500**', async () => {
    expect(prismaA).not.toBe(prismaB);
    expect(appA.getHttpServer()).not.toBe(appB.getHttpServer());

    // 两张票都在任何人绑定之前签发 —— 这才构造得出"同时以为身份没人占"的窗口
    const tA = await ticketVia(appA, 'conc-code-1');
    const tB = await ticketVia(appB, 'conc-code-1');
    await issueSmsCode(appA, tA, PHONE_A);
    await issueSmsCode(appB, tB, PHONE_B);

    const responses = await raceUnderIdentityBarrier(
      () => bindVia(appA, tA, PHONE_A),
      () => bindVia(appB, tB, PHONE_B),
    );

    // 核心判据:恰一个赢家 + 输家拿到业务码而不是 500
    expect(statusesOf(responses)).toEqual([200, 409]);
    const loser = responses.find((r) => r.status !== 200);
    expect(loser?.body.code).toBe(BizCode.WECOM_IDENTITY_ALREADY_BOUND.code);
    for (const r of responses) expect(r.status).toBeLessThan(500);

    // active partial unique 是最终裁判:同 (corpId, wecomUserId) 恒一条 active
    const active = await prismaA.wecomIdentity.findMany({
      where: { wecomUserId: stubWecomUserId('conc-code-1'), status: 'active' },
    });
    expect(active).toHaveLength(1);
  });

  // ===== ② 同 User 并发双绑定(§14.2 第 14 项)=====

  // ⚠️ 下面两条**同 User** 的用例刻意**不走屏障**,原因是实测出来的:
  //   pre-auth bind 的第 ⑤ 步 `SmsCodeService.verifyAndConsume` 是**事务之前**的原子消费。
  //   同号同码的两条请求里,输家在这一步就拿到 24010 —— 它根本走不到 settings / User /
  //   identity 任何一把锁上,屏障因此永远等不到第 2 个 waiter(初版在这里恒超时假红)。
  //
  //   这不是缺陷,是冻结稿 §6.2 七步顺序的直接结果:短信码 CAS 是这条路径上**更靠前**的
  //   单赢家闸。真正需要 partial unique 当裁判的,是**跨 User**那一条(上面那个用例)——
  //   那里两人各有各的手机号与验证码,前面所有闸都放行,只剩唯一索引能分胜负。
  //
  //   所以这两条用例的判据是**终态不变量**(恰一个赢家 + active 恒 1 + 无裸 500),
  //   不去断言"卡在哪把锁上"。

  it('同 User 并发绑两个不同企业微信号 → 单赢家,active identity 恒 1', async () => {
    const t1 = await ticketVia(appA, 'conc-code-2');
    const t2 = await ticketVia(appB, 'conc-code-3');
    await issueSmsCode(appA, t1, PHONE_A);

    const responses = await Promise.all([bindVia(appA, t1, PHONE_A), bindVia(appB, t2, PHONE_A)]);

    for (const r of responses) expect(r.status).toBeLessThan(500);
    expect(statusesOf(responses).filter((s) => s === 200)).toHaveLength(1);

    // 该 User 在当前 corpId 下恒**恰好一条** active
    // (`wecom_identity_user_active_unique` + User 行锁 + 短信码 CAS 三层共同保证)
    const active = await prismaA.wecomIdentity.findMany({
      where: { userId: userAId, status: 'active' },
    });
    expect(active).toHaveLength(1);
  });

  // ===== ③ 同一张 ticket 双消费(§9.5)=====

  it('同一张 binding ticket 并发消费两次 → 单赢家,只建一条身份', async () => {
    const ticket = await ticketVia(appA, 'conc-code-4');
    await issueSmsCode(appA, ticket, PHONE_A);

    const responses = await Promise.all([
      bindVia(appA, ticket, PHONE_A),
      bindVia(appB, ticket, PHONE_A),
    ]);

    for (const r of responses) expect(r.status).toBeLessThan(500);
    expect(statusesOf(responses).filter((s) => s === 200)).toHaveLength(1);

    // ticket 恰好被消费一次,身份恰好建一条
    const attempt = await prismaA.wecomAuthAttempt.findFirstOrThrow({
      where: { bindingTicketHash: { not: null } },
    });
    expect(attempt.status).toBe('completed');
    expect(attempt.bindingConsumedAt).not.toBeNull();
    expect(await prismaA.wecomIdentity.count({ where: { userId: userAId } })).toBe(1);
  });

  // ⚠️ 曾想再补一条"绕开短信码、单独证 ticket CAS"的用例:先绑成功,再给同一张票发一次码、
  // 用同一张票重放。**构造不出来** —— 票被消费后 `send-code` 自己就先返 36011 了
  // (它的第一步就是 `findValidBinding`),第二次发码根本发不出去。
  // 这条路已经被两处判据夹住,不需要第三条:
  //   · 串行重放:auth-wecom spec「bind 重放:同 ticket 第二次 → 36011」——
  //     命中的是第 ① 步 ticket 预检,在短信码之前,所以不会被 24010 抢答;
  //   · 并发双消费:上面那条同票并发用例,终态断言 ticket 恰好 consumed 一次、身份恰好一条。

  // ===== ④ state 并发双消费(§9.5 / §14.2 第 4 项)=====

  it('同一个 state 并发消费两次 → 单赢家,另一个 36010', async () => {
    const state = await stateVia(appA);

    const responses = await Promise.all([
      loginVia(appA, 'conc-code-5', state),
      loginVia(appB, 'conc-code-5', state),
    ]);

    for (const r of responses) expect(r.status).toBeLessThan(500);
    const ok = responses.filter((r) => r.status === 200);
    const failed = responses.filter((r) => r.status !== 200);
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].body.code).toBe(BizCode.WECOM_LOGIN_CREDENTIAL_INVALID.code);

    // 只签出一张 ticket
    const attempts = await prismaA.wecomAuthAttempt.findMany();
    expect(attempts).toHaveLength(1);
    expect(attempts[0].stateConsumedAt).not.toBeNull();
  });

  // ===== ⑤ 管理员清除 × 本人登录竞态(§9.4 / §14.2 第 15 项)=====

  it('clear ∥ login:任何交错下都不得留下「身份已撤销却还有活会话」', async () => {
    // 先完成绑定
    const ticket = await ticketVia(appA, 'conc-code-6');
    await issueSmsCode(appA, ticket, PHONE_A);
    expect((await bindVia(appA, ticket, PHONE_A)).status).toBe(200);
    await prismaA.refreshToken.deleteMany({ where: { userId: userAId } });

    const state = await stateVia(appA);
    const [loginRes, clearRes] = await Promise.all([
      loginVia(appA, 'conc-code-6', state),
      request(httpServer(appB))
        .delete(`/api/admin/v1/users/${userAId}/wecom`)
        .set('Authorization', adminAuth),
    ]);

    expect(loginRes.status).toBeLessThan(500);
    expect(clearRes.status).toBe(200);

    // 两条路径都统一 `User → WecomIdentity` 锁序,故二者严格串行:
    // - login 先持锁 → 签发成功,随后 clear 把这批 refresh 一并撤掉
    // - clear 先持锁 → login 锁后看到 identity 已撤销 → 36010,压根不签发
    // 无论哪一序,终态都必须是:0 条 active 身份 + 0 条活 refresh。
    expect(
      await prismaA.wecomIdentity.count({ where: { userId: userAId, status: 'active' } }),
    ).toBe(0);
    const liveRefresh = await prismaA.refreshToken.count({
      where: { userId: userAId, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    expect(liveRefresh).toBe(0);

    if (loginRes.status !== 200) {
      expect(loginRes.body.code).toBe(BizCode.WECOM_LOGIN_CREDENTIAL_INVALID.code);
    }
  });

  it('清除后再登录恒 36010(不因 revoked 历史行而误签发)', async () => {
    const ticket = await ticketVia(appA, 'conc-code-7');
    await issueSmsCode(appA, ticket, PHONE_A);
    await bindVia(appA, ticket, PHONE_A);

    await request(httpServer(appA))
      .delete(`/api/admin/v1/users/${userAId}/wecom`)
      .set('Authorization', adminAuth)
      .expect(200);

    const res = await loginVia(appA, 'conc-code-7', await stateVia(appA));
    // 身份已撤销 ⇒ 回到"未绑定"形态:发 ticket,而不是签发会话
    expect(res.status).toBe(200);
    expect(res.body.data.bindingRequired).toBe(true);
    expect(res.body.data.session).toBeNull();
  });

  // ===== ⑥ 反向对照:互不冲突的并发不得被误杀 =====

  it('反向对照:两 User 并发绑**不同**企业微信号 → 双 200,各建一条 active', async () => {
    const tA = await ticketVia(appA, 'conc-code-8');
    const tB = await ticketVia(appB, 'conc-code-9');
    await issueSmsCode(appA, tA, PHONE_A);
    await issueSmsCode(appB, tB, PHONE_B);

    const responses = await raceUnderIdentityBarrier(
      () => bindVia(appA, tA, PHONE_A),
      () => bindVia(appB, tB, PHONE_B),
    );

    expect(statusesOf(responses)).toEqual([200, 200]);
    expect(await prismaA.wecomIdentity.count({ where: { status: 'active' } })).toBe(2);
    expect(
      await prismaA.wecomIdentity.count({ where: { userId: userAId, status: 'active' } }),
    ).toBe(1);
    expect(
      await prismaA.wecomIdentity.count({ where: { userId: userBId, status: 'active' } }),
    ).toBe(1);
  });
});
