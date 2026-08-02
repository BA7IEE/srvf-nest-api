import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Role, UserStatus } from '@prisma/client';
import { createHash } from 'node:crypto';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 企业微信接入 T4 e2e 组 A:User 生命周期闭环 —— 行为矩阵
// (冻结稿 docs/archive/reviews/wecom-integration-t0-terminal-review.md D-WC-10 + §11.3 末条;
//  §14.2 第 19 / 20 项)
//
// 本 spec 钉住 D-WC-10 的**两侧**,缺一侧都不算钉住:
//   · 释放侧:User soft-delete / member account reopen(**代际终止**)→ 同事务撤销 active identity
//   · 保留侧:disable / enable / offboard(**临时停用**)→ WecomIdentity 行**逐字段零变化**
// 保留侧才是容易出错的那一半 —— 顺手在"停用用户"里也撤掉绑定,会让每次误禁再恢复
// 都逼用户重走一遍企业微信授权,而这条错误没有任何断言会红。故保留侧用**整行快照相等**
// 断言(含 updatedAt),任何多余的 UPDATE 都当场显形。
//
// 断言口径:身份状态一律**直读 DB**(API 面只有掩码),Audit 计数读 context.extra。

const AUTHORIZE_PATH = '/api/auth/v1/login-wecom/authorize';
const LOGIN_PATH = '/api/auth/v1/login-wecom';
const SEND_PATH = '/api/auth/v1/wecom-bind/send-code';
const BIND_PATH = '/api/auth/v1/wecom-bind';

const FIXED_SMS_CODE = '888888';
const CORP_ID = 'wwT4CorpIdLifecycle';
const AGENT_ID = 1000005;
const WEB_BASE_URL = 'https://srvf-e2e-t4a.example.org';

function stubWecomUserId(code: string): string {
  return `dev-wecom-${createHash('sha256').update(code).digest('hex').slice(0, 24)}`;
}

/** WecomIdentity 全字段快照 —— 保留侧断言的判据本体(少一列就漏一列)。 */
type IdentityRow = {
  id: string;
  userId: string;
  corpId: string;
  wecomUserId: string;
  status: string;
  bindingSource: string;
  boundAt: Date;
  revokedAt: Date | null;
  revokedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

describe('企业微信 User 生命周期闭环:行为矩阵(T4 e2e 组 A)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAdminAuth: string;
  let superAdminId: string;

  // 每条用例一套全新号码 / code,避免 partial unique 与手机号唯一约束跨用例串味
  let seq = 0;
  function nextSeq(): number {
    seq += 1;
    return seq;
  }
  function phoneOf(n: number): string {
    return `139500${String(n).padStart(5, '0')}`;
  }
  function codeOf(n: number): string {
    return `t4a-code-${n}`;
  }

  beforeAll(async () => {
    process.env.LOGIN_WECOM_THROTTLE_LIMIT = '100';
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

    // 全部管理动作用 SUPER_ADMIN:rbac.can 短路通过,本 spec 因此不动任何共享
    // permission fixture(其 count 被 rbac 元 e2e 依赖)。
    const sa = await createTestUser(app, { username: 't4a_sa', role: Role.SUPER_ADMIN });
    superAdminId = sa.id;
    superAdminAuth = (await loginAs(app, 't4a_sa')).authHeader;
  });

  afterAll(async () => {
    await app.close();
  });

  // ===== 编排工具 =====

  async function stateFor(): Promise<string> {
    const res = await request(httpServer(app)).post(AUTHORIZE_PATH).send({});
    expect(res.status).toBe(200);
    return /[?&]state=([^&#]+)/.exec(res.body.data.authorizeUrl as string)?.[1] as string;
  }

  /**
   * 用**真实 pre-auth 绑定链路**给某个手机号所属账号建一条 active 身份。
   *
   * 刻意不直连 prisma 造行:身份行的 corpId / bindingSource / boundAt 由生产路径写,
   * 手写 fixture 一旦与生产写法漂移,保留侧的"逐字段零变化"就会变成和一个假行比对。
   */
  async function bindWecom(phone: string, code: string): Promise<void> {
    const login = await request(httpServer(app))
      .post(LOGIN_PATH)
      .send({ code, state: await stateFor() });
    expect(login.status).toBe(200);
    expect(login.body.data.bindingRequired).toBe(true);
    const bindingTicket = login.body.data.bindingTicket as string;

    const sent = await request(httpServer(app)).post(SEND_PATH).send({ bindingTicket, phone });
    expect(sent.status).toBe(200);

    const bound = await request(httpServer(app))
      .post(BIND_PATH)
      .send({ bindingTicket, phone, smsCode: FIXED_SMS_CODE });
    expect(bound.status).toBe(200);
  }

  async function identityRowOf(userId: string): Promise<IdentityRow> {
    const rows = await prisma.wecomIdentity.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  async function activeCountOf(userId: string): Promise<number> {
    return prisma.wecomIdentity.count({ where: { userId, status: 'active', revokedAt: null } });
  }

  async function auditExtraOf(
    event: string,
    resourceId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const row = await prisma.auditLog.findFirstOrThrow({
      where: { event, resourceId },
      orderBy: { createdAt: 'desc' },
    });
    return (row.context as { extra?: Record<string, unknown> }).extra;
  }

  /** 建一个带手机号的独立 User(用户轴用例)。 */
  async function newPhoneUser(n: number): Promise<{ id: string; phone: string }> {
    const user = await createTestUser(app, { username: `t4a_u${n}` });
    await prisma.user.update({
      where: { id: user.id },
      data: { phone: phoneOf(n), phoneVerifiedAt: new Date() },
    });
    return { id: user.id, phone: phoneOf(n) };
  }

  /** 建一个 ACTIVE 队员并给它开一个带手机号的关联账号(队员轴用例)。 */
  async function newMemberWithAccount(
    n: number,
  ): Promise<{ memberId: string; userId: string; phone: string }> {
    const member = await prisma.member.create({
      data: { memberNo: `t4a-m-${n}`, displayName: `T4A-${n}`, status: MemberStatus.ACTIVE },
      select: { id: true },
    });
    const granted = await request(httpServer(app))
      .post(`/api/admin/v1/members/${member.id}/account`)
      .set('Authorization', superAdminAuth)
      .send({ phone: phoneOf(n) });
    expect(granted.status).toBe(201);
    return { memberId: member.id, userId: granted.body.data.userId as string, phone: phoneOf(n) };
  }

  function softDelete(userId: string): request.Test {
    return request(httpServer(app))
      .delete(`/api/admin/v1/users/${userId}`)
      .set('Authorization', superAdminAuth);
  }

  function clearWecom(userId: string): request.Test {
    return request(httpServer(app))
      .delete(`/api/admin/v1/users/${userId}/wecom`)
      .set('Authorization', superAdminAuth);
  }

  function setUserStatus(userId: string, status: UserStatus): request.Test {
    return request(httpServer(app))
      .patch(`/api/admin/v1/users/${userId}/status`)
      .set('Authorization', superAdminAuth)
      .send({ status });
  }

  function reopen(memberId: string, phone: string): request.Test {
    return request(httpServer(app))
      .post(`/api/admin/v1/members/${memberId}/account/reopen`)
      .set('Authorization', superAdminAuth)
      .send({ phone });
  }

  // ===== ① softDelete × {active / 无 / 已 revoked}(DoD 1)=====

  describe('① User soft-delete(代际终止 → 撤销)', () => {
    it('有 active 绑定:同事务翻 revoked(revokedByUserId=操作者)+ umbrella extra 计 1 + refresh 撤销行为不变', async () => {
      const n = nextSeq();
      const { id: userId, phone } = await newPhoneUser(n);
      await bindWecom(phone, codeOf(n));

      // 造一条活 refresh(既有联动撤销行为的对照物)
      const identityBefore = await identityRowOf(userId);
      expect(identityBefore.status).toBe('active');
      const liveRefreshBefore = await prisma.refreshToken.count({
        where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      });
      expect(liveRefreshBefore).toBeGreaterThan(0);

      expect((await softDelete(userId)).status).toBe(200);

      const after = await identityRowOf(userId);
      expect(after.status).toBe('revoked');
      expect(after.revokedAt).not.toBeNull();
      expect(after.revokedByUserId).toBe(superAdminId);
      // 身份键与来源列不动 —— 撤销是"作废"不是"改写"
      expect(after.corpId).toBe(identityBefore.corpId);
      expect(after.wecomUserId).toBe(identityBefore.wecomUserId);
      expect(after.bindingSource).toBe(identityBefore.bindingSource);
      expect(after.boundAt).toEqual(identityBefore.boundAt);
      expect(await activeCountOf(userId)).toBe(0);

      // 既有 refresh 联动撤销(P0-E PR-3)逐字不变
      expect(
        await prisma.refreshToken.count({
          where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
        }),
      ).toBe(0);
      expect(
        await prisma.refreshToken.count({ where: { userId, revokedReason: 'admin-delete' } }),
      ).toBeGreaterThan(0);

      expect(await auditExtraOf('user.soft-delete', userId)).toEqual({
        wecomIdentitiesRevoked: 1,
      });
    });

    it('无绑定:200 且 extra 计 0(恒写数值,不缺席)——不因"没东西可撤"就静默', async () => {
      const n = nextSeq();
      const { id: userId } = await newPhoneUser(n);

      expect((await softDelete(userId)).status).toBe(200);

      expect(await prisma.wecomIdentity.count({ where: { userId } })).toBe(0);
      expect(await auditExtraOf('user.soft-delete', userId)).toEqual({
        wecomIdentitiesRevoked: 0,
      });
    });

    it('已 revoked(先 admin clear):extra 计 0 且历史行逐字段不被二次改写', async () => {
      const n = nextSeq();
      const { id: userId, phone } = await newPhoneUser(n);
      await bindWecom(phone, codeOf(n));
      expect((await clearWecom(userId)).status).toBe(200);

      const revokedByClear = await identityRowOf(userId);
      expect(revokedByClear.status).toBe('revoked');

      expect((await softDelete(userId)).status).toBe(200);

      // 整行相等:revokedAt / revokedByUserId / updatedAt 都不得被软删这一刀再动一次
      expect(await identityRowOf(userId)).toEqual(revokedByClear);
      expect(await auditExtraOf('user.soft-delete', userId)).toEqual({
        wecomIdentitiesRevoked: 0,
      });
    });
  });

  // ===== ② reopenAccount × {active / 无 / 已 revoked}(DoD 2)=====

  describe('② member account reopen(旧 User 代际终止 → 撤销,新号不继承)', () => {
    it('旧号有 active 绑定:同事务撤销 + 计 1;新号查库零 WecomIdentity 行', async () => {
      const n = nextSeq();
      const { memberId, userId: oldUserId, phone } = await newMemberWithAccount(n);
      await bindWecom(phone, codeOf(n));
      expect(await activeCountOf(oldUserId)).toBe(1);

      const newPhone = phoneOf(nextSeq());
      const res = await reopen(memberId, newPhone);
      expect(res.status).toBe(200);
      const newUserId = res.body.data.userId as string;
      expect(newUserId).not.toBe(oldUserId);

      const old = await identityRowOf(oldUserId);
      expect(old.status).toBe('revoked');
      expect(old.revokedAt).not.toBeNull();
      expect(old.revokedByUserId).toBe(superAdminId);
      expect(await activeCountOf(oldUserId)).toBe(0);

      // 核心:身份**不随账号迁移** —— 新 User 名下零行(不是"有一条 revoked",是根本没有)
      expect(await prisma.wecomIdentity.count({ where: { userId: newUserId } })).toBe(0);

      const extra = await auditExtraOf('member.account-reopened', memberId);
      expect(extra?.wecomIdentitiesRevoked).toBe(1);
      // 既有 extra 字段逐字保留(不因新增计数而漂移)
      expect(extra?.oldUserId).toBe(oldUserId);
      expect(extra?.newUserId).toBe(newUserId);
    });

    it('旧号无绑定:extra 计 0', async () => {
      const n = nextSeq();
      const { memberId, userId: oldUserId } = await newMemberWithAccount(n);

      const res = await reopen(memberId, phoneOf(nextSeq()));
      expect(res.status).toBe(200);

      expect(await prisma.wecomIdentity.count({ where: { userId: oldUserId } })).toBe(0);
      expect(
        (await auditExtraOf('member.account-reopened', memberId))?.wecomIdentitiesRevoked,
      ).toBe(0);
    });

    it('旧号已 revoked:extra 计 0 且历史行逐字段不被二次改写', async () => {
      const n = nextSeq();
      const { memberId, userId: oldUserId, phone } = await newMemberWithAccount(n);
      await bindWecom(phone, codeOf(n));
      expect((await clearWecom(oldUserId)).status).toBe(200);
      const revokedByClear = await identityRowOf(oldUserId);

      expect((await reopen(memberId, phoneOf(nextSeq()))).status).toBe(200);

      expect(await identityRowOf(oldUserId)).toEqual(revokedByClear);
      expect(
        (await auditExtraOf('member.account-reopened', memberId))?.wecomIdentitiesRevoked,
      ).toBe(0);
    });

    it('撤销后用旧号的企业微信身份走 OAuth 登录 → 回到"未绑定"形态(bindingRequired,不签发会话)', async () => {
      const n = nextSeq();
      const { memberId, phone } = await newMemberWithAccount(n);
      await bindWecom(phone, codeOf(n));

      expect((await reopen(memberId, phoneOf(nextSeq()))).status).toBe(200);

      const res = await request(httpServer(app))
        .post(LOGIN_PATH)
        .send({ code: codeOf(n), state: await stateFor() });
      // 冻结稿 §6.2:无 active 身份 = 未绑定面 —— 签一次性 binding ticket,不签会话。
      // 响应里不得出现企业微信号本身(防侧写)。
      expect(res.status).toBe(200);
      expect(res.body.data.bindingRequired).toBe(true);
      expect(res.body.data.session).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain(stubWecomUserId(codeOf(n)));
    });

    it('软删后用其企业微信身份走 OAuth 登录 → 同样回到"未绑定"形态', async () => {
      const n = nextSeq();
      const { id: userId, phone } = await newPhoneUser(n);
      await bindWecom(phone, codeOf(n));
      expect((await softDelete(userId)).status).toBe(200);

      const res = await request(httpServer(app))
        .post(LOGIN_PATH)
        .send({ code: codeOf(n), state: await stateFor() });
      expect(res.status).toBe(200);
      expect(res.body.data.bindingRequired).toBe(true);
      expect(res.body.data.session).toBeNull();
    });
  });

  // ===== ③ 保留侧:disable / enable / offboard 逐字段零变化(DoD 3)=====

  describe('③ 临时停用不动绑定(D-WC-10 保留侧)', () => {
    it('用户轴 disable → enable:WecomIdentity 整行(含 updatedAt)零变化', async () => {
      const n = nextSeq();
      const { id: userId, phone } = await newPhoneUser(n);
      await bindWecom(phone, codeOf(n));
      const snapshot = await identityRowOf(userId);

      expect((await setUserStatus(userId, UserStatus.DISABLED)).status).toBe(200);
      expect(await identityRowOf(userId)).toEqual(snapshot);
      expect(await activeCountOf(userId)).toBe(1);

      expect((await setUserStatus(userId, UserStatus.ACTIVE)).status).toBe(200);
      expect(await identityRowOf(userId)).toEqual(snapshot);
      expect(await activeCountOf(userId)).toBe(1);
    });

    it('队员轴 account/status disable → enable:WecomIdentity 整行零变化', async () => {
      const n = nextSeq();
      const { memberId, userId, phone } = await newMemberWithAccount(n);
      await bindWecom(phone, codeOf(n));
      const snapshot = await identityRowOf(userId);

      const patch = (status: UserStatus): request.Test =>
        request(httpServer(app))
          .patch(`/api/admin/v1/members/${memberId}/account/status`)
          .set('Authorization', superAdminAuth)
          .send({ status });

      expect((await patch(UserStatus.DISABLED)).status).toBe(200);
      expect(await identityRowOf(userId)).toEqual(snapshot);

      expect((await patch(UserStatus.ACTIVE)).status).toBe(200);
      expect(await identityRowOf(userId)).toEqual(snapshot);
      expect(await activeCountOf(userId)).toBe(1);
    });

    it('一键离队 offboard:账号被停用、refresh 被撤,但 WecomIdentity 整行零变化', async () => {
      const n = nextSeq();
      const { memberId, userId, phone } = await newMemberWithAccount(n);
      await bindWecom(phone, codeOf(n));
      const snapshot = await identityRowOf(userId);

      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberId}/offboard`)
        .set('Authorization', superAdminAuth)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.data.accountDisabled).toBe(true);

      // 反向对照:这一刀**确实**动了别的东西(否则"零变化"可能只是因为整条路径没跑)
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(user.status).toBe(UserStatus.DISABLED);
      expect(
        await prisma.refreshToken.count({
          where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
        }),
      ).toBe(0);

      expect(await identityRowOf(userId)).toEqual(snapshot);
      expect(await activeCountOf(userId)).toBe(1);
    });

    it('停用期间企业微信登录被 User 级判据挡下,但绑定仍在;恢复后照常登录', async () => {
      const n = nextSeq();
      const { id: userId, phone } = await newPhoneUser(n);
      await bindWecom(phone, codeOf(n));
      const snapshot = await identityRowOf(userId);

      expect((await setUserStatus(userId, UserStatus.DISABLED)).status).toBe(200);
      const blocked = await request(httpServer(app))
        .post(LOGIN_PATH)
        .send({ code: codeOf(n), state: await stateFor() });
      // 账号不可用统一 36010(**不是** bindingRequired —— 那会泄露"这个企业微信号没人绑")
      expectBizError(blocked, BizCode.WECOM_LOGIN_CREDENTIAL_INVALID);
      expect(await identityRowOf(userId)).toEqual(snapshot);

      expect((await setUserStatus(userId, UserStatus.ACTIVE)).status).toBe(200);
      const ok = await request(httpServer(app))
        .post(LOGIN_PATH)
        .send({ code: codeOf(n), state: await stateFor() });
      expect(ok.status).toBe(200);
      expect(ok.body.data.bindingRequired).toBe(false);
      expect(ok.body.data.session).not.toBeNull();
    });
  });
});
