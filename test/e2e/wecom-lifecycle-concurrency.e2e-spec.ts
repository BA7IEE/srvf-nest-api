import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Role, UserStatus } from '@prisma/client';
import { createHash } from 'node:crypto';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import {
  WECOM_BIND_NONCE_COOKIE,
  WECOM_LOGIN_NONCE_COOKIE,
} from '../../src/modules/auth/wecom-browser-nonce';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser, TEST_PASSWORD } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 企业微信接入 T4 e2e 组 D:生命周期撤销 × 身份链路真并发(冻结稿 D-WC-10 + §9.1 / §9.4)
//
// **判据一律是终态不变量,不是"卡在哪把锁上"**(T3 的账,memory `wecom-t3-oauth-binding`):
// 同 User 的两条写路径都取 `lockAuthSessionUser` 的 User 行锁,于是它们**严格串行**——
// 屏障根本等不到第二个 identity waiter,钉锁位置只会写出恒超时的假红。
// 真正要证明的是"无论谁先谁后,终态都只有一种",以及"计数不会因为竞态被记两遍"。
//
// 三条竞态,一一对应 goal DoD 4:
//   ① softDelete ∥ 本人换绑(PUT me/wecom)→ 恰一个终态,无裸 500
//   ② admin clear ∥ softDelete 双撤        → revoke 恰一次,两处计数合计恰 1(不重复)
//   ③ member reopen ∥ 旧 User 企业微信登录 → 无孤儿会话(撤销后 refresh family 不可用)

const AUTHORIZE_PATH = '/api/auth/v1/login-wecom/authorize';
const LOGIN_PATH = '/api/auth/v1/login-wecom';
const SEND_PATH = '/api/auth/v1/wecom-bind/send-code';
const BIND_PATH = '/api/auth/v1/wecom-bind';
const BIND_AUTHORIZE_PATH = '/api/auth/v1/wecom-bind/authorize';
const STEP_UP_PASSWORD_PATH = '/api/auth/v1/step-up/password';
const ME_WECOM_PATH = '/api/app/v1/me/wecom';
const REFRESH_PATH = '/api/auth/v1/refresh';

const FIXED_SMS_CODE = '888888';
const CORP_ID = 'wwT4CorpIdConc';
const AGENT_ID = 1000006;
const WEB_BASE_URL = 'https://srvf-e2e-t4d.example.org';

function stubWecomUserId(code: string): string {
  return `dev-wecom-${createHash('sha256').update(code).digest('hex').slice(0, 24)}`;
}

// P1-27 第一刀 B1(2026-08-03):authorize 下发的浏览器关联 nonce cookie 按 state 存档,
// 模拟"同一个浏览器把流程走完" —— 本文件既有断言逐字不动。
// 「换一个浏览器提交必须失败」的判据在 wecom-account-takeover.e2e-spec.ts。
const browserJar = new Map<string, string>();

function rememberNonce(res: request.Response, state: string, cookieName: string): void {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const line = (raw ?? []).find((c) => c.startsWith(`${cookieName}=`));
  expect(line).toBeDefined();
  browserJar.set(state, (line as string).split(';')[0]);
}

function withBrowser(req: request.Test, state: string): request.Test {
  const cookie = browserJar.get(state);
  return cookie === undefined ? req : req.set('Cookie', cookie);
}

describe('企业微信 User 生命周期撤销真并发(T4 e2e 组 D)', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prismaA: PrismaService;
  let superAdminId: string;
  let superAdminAuth: string;

  let seq = 0;
  function nextSeq(): number {
    seq += 1;
    return seq;
  }
  function phoneOf(n: number): string {
    return `139600${String(n).padStart(5, '0')}`;
  }
  function codeOf(n: number): string {
    return `t4d-code-${n}`;
  }

  beforeAll(async () => {
    process.env.LOGIN_WECOM_THROTTLE_LIMIT = '100';
    process.env.SMS_SEND_THROTTLE_LIMIT = '100';
    process.env.SMS_VERIFY_THROTTLE_LIMIT = '100';
    process.env.PASSWORD_CHANGE_THROTTLE_LIMIT = '100'; // step-up/password 复用该实例
    appA = await createTestApp();
    appB = await createTestApp();
    prismaA = appA.get(PrismaService);
    // 两套 app = 两个独立 Prisma 连接池,竞态才可能真的重叠(单池会把并发请求排成队)。
    // 断言一律走 prismaA 这一条读连接,免得"读到的是哪个池的可见性"混进判据。
    expect(appB.get(PrismaService)).not.toBe(prismaA);
    await resetDb(appA);

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

    const sa = await createTestUser(appA, { username: 't4d_sa', role: Role.SUPER_ADMIN });
    superAdminId = sa.id;
    superAdminAuth = (await loginAs(appA, 't4d_sa')).authHeader;
  });

  afterAll(async () => {
    await Promise.all([appA.close(), appB.close()]);
  });

  // ===== 编排工具 =====

  async function stateVia(app: INestApplication): Promise<string> {
    const res = await request(httpServer(app)).post(AUTHORIZE_PATH).send({});
    expect(res.status).toBe(200);
    const state = /[?&]state=([^&#]+)/.exec(res.body.data.authorizeUrl as string)?.[1] as string;
    rememberNonce(res, state, WECOM_LOGIN_NONCE_COOKIE);
    return state;
  }

  /** 真实 pre-auth 绑定链路(不手写 fixture 行,理由同组 A)。 */
  async function bindWecom(app: INestApplication, phone: string, code: string): Promise<void> {
    const state = await stateVia(app);
    const login = await withBrowser(request(httpServer(app)).post(LOGIN_PATH), state).send({
      code,
      state,
    });
    expect(login.status).toBe(200);
    expect(login.body.data.bindingRequired).toBe(true);
    const bindingTicket = login.body.data.bindingTicket as string;

    expect(
      (await request(httpServer(app)).post(SEND_PATH).send({ bindingTicket, phone })).status,
    ).toBe(200);
    expect(
      (
        await request(httpServer(app))
          .post(BIND_PATH)
          .send({ bindingTicket, phone, smsCode: FIXED_SMS_CODE })
      ).status,
    ).toBe(200);
  }

  async function newPhoneUser(n: number): Promise<{ id: string; phone: string; username: string }> {
    const username = `t4d_u${n}`;
    const user = await createTestUser(appA, { username });
    await prismaA.user.update({
      where: { id: user.id },
      data: { phone: phoneOf(n), phoneVerifiedAt: new Date() },
    });
    return { id: user.id, phone: phoneOf(n), username };
  }

  async function newMemberWithAccount(
    n: number,
  ): Promise<{ memberId: string; userId: string; phone: string }> {
    const member = await prismaA.member.create({
      data: { memberNo: `t4d-m-${n}`, displayName: `T4D-${n}`, status: MemberStatus.ACTIVE },
      select: { id: true },
    });
    const granted = await request(httpServer(appA))
      .post(`/api/admin/v1/members/${member.id}/account`)
      .set('Authorization', superAdminAuth)
      .send({ phone: phoneOf(n) });
    expect(granted.status).toBe(201);
    return { memberId: member.id, userId: granted.body.data.userId as string, phone: phoneOf(n) };
  }

  async function liveRefreshCount(userId: string): Promise<number> {
    return prismaA.refreshToken.count({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    });
  }

  async function activeIdentityCount(userId: string): Promise<number> {
    return prismaA.wecomIdentity.count({ where: { userId, status: 'active', revokedAt: null } });
  }

  // ===== ① softDelete ∥ 本人换绑(PUT me/wecom)=====

  it('softDelete ∥ 本人换绑:恰一个终态(User 已软删 + 0 active 身份 + 0 活 refresh),无裸 500', async () => {
    const n = nextSeq();
    const { id: userId, phone, username } = await newPhoneUser(n);
    await bindWecom(appA, phone, codeOf(n));

    // 本人换绑需要 JWT + action-bound step-up proof(D-WC-8);密码登录拿两者
    const selfAuth = (await loginAs(appA, username)).authHeader;
    const stepUp = await request(httpServer(appB))
      .post(STEP_UP_PASSWORD_PATH)
      .set('Authorization', selfAuth)
      .send({ action: 'WECOM_BIND', password: TEST_PASSWORD });
    expect(stepUp.status).toBe(200);
    const stepUpToken = stepUp.body.data.stepUpToken as string;

    const authorize = await request(httpServer(appB))
      .post(BIND_AUTHORIZE_PATH)
      .set('Authorization', selfAuth)
      .send({});
    expect(authorize.status).toBe(200);
    const state = /[?&]state=([^&#]+)/.exec(
      authorize.body.data.authorizeUrl as string,
    )?.[1] as string;
    rememberNonce(authorize, state, WECOM_BIND_NONCE_COOKIE);

    const rebindCode = codeOf(nextSeq());
    const [deleteRes, rebindRes] = await Promise.all([
      request(httpServer(appA))
        .delete(`/api/admin/v1/users/${userId}`)
        .set('Authorization', superAdminAuth),
      withBrowser(
        request(httpServer(appB)).put(ME_WECOM_PATH).set('Authorization', selfAuth),
        state,
      ).send({ code: rebindCode, state, stepUpToken }),
    ]);

    // 两条路径都取同一把 User 行锁 ⇒ 严格串行;两种序都必须落到同一个终态。
    expect(deleteRes.status).toBe(200);
    expect(rebindRes.status).toBeLessThan(500);

    const user = await prismaA.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.deletedAt).not.toBeNull();
    expect(user.status).toBe(UserStatus.DISABLED);

    // 终态不变量:软删的 User 名下不得留下任何 active 身份 ——
    // 换绑先赢(新身份随即被软删撤掉)与软删先赢(换绑当场 USER_NOT_FOUND)同一终态。
    expect(await activeIdentityCount(userId)).toBe(0);
    expect(await liveRefreshCount(userId)).toBe(0);

    // 计数自证:extra 恰好等于这一刀实际撤掉的行数(换绑赢 → 1,软删赢 → 0),二者必居其一
    const audit = await prismaA.auditLog.findFirstOrThrow({
      where: { event: 'user.soft-delete', resourceId: userId },
    });
    const revoked = (audit.context as { extra?: { wecomIdentitiesRevoked?: number } }).extra
      ?.wecomIdentitiesRevoked;
    expect([0, 1]).toContain(revoked);
    expect(
      await prismaA.wecomIdentity.count({ where: { userId, status: 'revoked' } }),
    ).toBeGreaterThanOrEqual(1);
    if (rebindRes.status === 200) {
      // 换绑赢:新身份被建出来又被软删撤掉 ⇒ 该 User 名下两条 revoked、零条 active
      expect(revoked).toBe(1);
      expect(
        await prismaA.wecomIdentity.count({
          where: { userId, wecomUserId: stubWecomUserId(rebindCode) },
        }),
      ).toBe(1);
    }
  });

  // ===== ② admin clear ∥ softDelete 双撤 =====

  it('clear ∥ softDelete 双撤:身份恰被 revoke 一次,两处计数合计恰 1(不重复记账)', async () => {
    const n = nextSeq();
    const { id: userId, phone } = await newPhoneUser(n);
    await bindWecom(appA, phone, codeOf(n));
    const identityId = (
      await prismaA.wecomIdentity.findFirstOrThrow({ where: { userId, status: 'active' } })
    ).id;

    const [clearRes, deleteRes] = await Promise.all([
      request(httpServer(appA))
        .delete(`/api/admin/v1/users/${userId}/wecom`)
        .set('Authorization', superAdminAuth),
      request(httpServer(appB))
        .delete(`/api/admin/v1/users/${userId}`)
        .set('Authorization', superAdminAuth),
    ]);

    for (const res of [clearRes, deleteRes]) expect(res.status).toBeLessThan(500);
    expect(deleteRes.status).toBe(200);
    // clear 输在锁上时目标已软删 ⇒ 统一 USER_NOT_FOUND(沿 soft-delete-transactions §10);
    // 赢在锁上时 200。两者都不是 500,且都不会把这条身份撤第二次。
    if (clearRes.status !== 200) {
      expect(clearRes.body.code).toBe(BizCode.USER_NOT_FOUND.code);
    }

    // 恰一次 revoke:整行只有一个 revokedAt / 一个 revokedByUserId
    const rows = await prismaA.wecomIdentity.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(identityId);
    expect(rows[0].status).toBe('revoked');
    expect(rows[0].revokedAt).not.toBeNull();
    expect(rows[0].revokedByUserId).toBe(superAdminId);

    // 不重复记账:clear 只在真撤了东西时写 audit(幂等空转不写);
    // softDelete 的 extra 计的是它自己撤掉的行数。两处相加恒 1。
    const clearAudits = await prismaA.auditLog.count({
      where: { event: 'wecom.clear.by-admin', resourceId: userId },
    });
    const deleteAudit = await prismaA.auditLog.findFirstOrThrow({
      where: { event: 'user.soft-delete', resourceId: userId },
    });
    const byDelete =
      (deleteAudit.context as { extra?: { wecomIdentitiesRevoked?: number } }).extra
        ?.wecomIdentitiesRevoked ?? -1;
    expect(clearAudits + byDelete).toBe(1);
  });

  // ===== ③ member reopen ∥ 旧 User 企业微信登录 =====

  it('reopen ∥ 旧 User 企业微信登录:不留孤儿会话(撤销后 refresh family 一律不可用)', async () => {
    const n = nextSeq();
    const { memberId, userId: oldUserId, phone } = await newMemberWithAccount(n);
    await bindWecom(appA, phone, codeOf(n));
    // 清掉绑定链路自带的那张 refresh,让本用例的"活会话"只可能来自竞态里的那次登录
    await prismaA.refreshToken.deleteMany({ where: { userId: oldUserId } });

    const state = await stateVia(appB);
    const newPhone = phoneOf(nextSeq());
    const [reopenRes, loginRes] = await Promise.all([
      request(httpServer(appA))
        .post(`/api/admin/v1/members/${memberId}/account/reopen`)
        .set('Authorization', superAdminAuth)
        .send({ phone: newPhone }),
      withBrowser(request(httpServer(appB)).post(LOGIN_PATH), state).send({
        code: codeOf(n),
        state,
      }),
    ]);

    expect(reopenRes.status).toBe(200);
    expect(loginRes.status).toBeLessThan(500);
    const newUserId = reopenRes.body.data.userId as string;

    // 终态:旧 User 代际终止 + 身份释放 + 新号不继承
    const oldUser = await prismaA.user.findUniqueOrThrow({ where: { id: oldUserId } });
    expect(oldUser.deletedAt).not.toBeNull();
    expect(await activeIdentityCount(oldUserId)).toBe(0);
    expect(await prismaA.wecomIdentity.count({ where: { userId: newUserId } })).toBe(0);

    // 核心:**无孤儿会话** —— 登录赢在锁上时签出的那张票,也必须被 reopen 的同事务撤销撤掉
    expect(await liveRefreshCount(oldUserId)).toBe(0);
    if (loginRes.status === 200 && loginRes.body.data.session !== null) {
      const refreshToken = loginRes.body.data.session.refreshToken as string;
      const refreshed = await request(httpServer(appA)).post(REFRESH_PATH).send({ refreshToken });
      expect(refreshed.status).toBe(BizCode.REFRESH_TOKEN_INVALID.httpStatus);
      expect(refreshed.body.code).toBe(BizCode.REFRESH_TOKEN_INVALID.code);
    } else {
      // 登录输在锁上:锁后重验身份行已 revoked ⇒ 统一 36010,压根不签发
      expect(loginRes.body.data?.session ?? null).toBeNull();
    }
  });
});
