import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import { createHash } from 'node:crypto';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantOpsAdminToUser, seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { createTestUser, TEST_PASSWORD } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 企业微信接入 T3 e2e 组 B:登录态本人换绑 + 管理员清除
// (冻结稿 §6.3 / §6.4 / §7.4;§14.2 第 8 / 17 / 18 项)
//
// 覆盖 goal DoD:
//   DoD 1 App GET/PUT me/wecom + Admin 清除 + 新权限码 user.wecom.clear
//   DoD 3 step-up proof 过期 / 复用 / 跨 action 拒;admin clear 后旧 proof 失效
//   DoD 4 admin clear 幂等且不写 Audit;实际清除撤 refresh
//
// §14.2 第 8 项(路径 B 兜底)在这里落地:**无绑定手机号**的用户先用原账号密码登录,
// 再以 PASSWORD 因子 step-up 完成 self-bind —— 这是 D-WC-28 的正式兜底,不是人工改库。

const STEP_UP_PASSWORD_PATH = '/api/auth/v1/step-up/password';
const BIND_AUTHORIZE_PATH = '/api/auth/v1/wecom-bind/authorize';
const ME_WECOM_PATH = '/api/app/v1/me/wecom';

const CORP_ID = 'wwT3CorpIdForE2EB';
const AGENT_ID = 1000003;
const WEB_BASE_URL = 'https://srvf-e2e-b.example.org';

function stubWecomUserId(code: string): string {
  return `dev-wecom-${createHash('sha256').update(code).digest('hex').slice(0, 24)}`;
}

describe('本人企业微信换绑 + 管理员清除(T3 e2e 组 B)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let selfId: string;
  let selfAuth: string;
  let otherId: string;
  let otherAuth: string;
  let adminAuth: string;
  let userAuth: string;

  function stepUp(auth: string, action: string): Promise<request.Response> {
    return request(httpServer(app))
      .post(STEP_UP_PASSWORD_PATH)
      .set('Authorization', auth)
      .send({ action, password: TEST_PASSWORD });
  }

  async function stepUpToken(auth: string, action = 'WECOM_BIND'): Promise<string> {
    const res = await stepUp(auth, action);
    expect(res.status).toBe(200);
    return res.body.data.stepUpToken as string;
  }

  /** bind_self authorize → 从 URL 取 state(前端拿到的也只有这条路径)。 */
  async function bindSelfState(auth: string): Promise<string> {
    const res = await request(httpServer(app))
      .post(BIND_AUTHORIZE_PATH)
      .set('Authorization', auth)
      .send({});
    expect(res.status).toBe(200);
    const url = res.body.data.authorizeUrl as string;
    return /[?&]state=([^&#]+)/.exec(url)?.[1] as string;
  }

  function putWecom(auth: string, body: Record<string, unknown>): Promise<request.Response> {
    return request(httpServer(app)).put(ME_WECOM_PATH).set('Authorization', auth).send(body);
  }

  function getWecom(auth: string): Promise<request.Response> {
    return request(httpServer(app)).get(ME_WECOM_PATH).set('Authorization', auth);
  }

  // loginAs fixture 只返 { accessToken, authHeader };需要拿 refreshToken 的用例
  // 直接走一次原始密码登录(与 fixture 同一端点,只是多取一个字段)。
  async function loginRaw(username: string): Promise<{ authHeader: string; refreshToken: string }> {
    const res = await request(httpServer(app))
      .post('/api/auth/v1/login')
      .send({ username, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    return {
      authHeader: `Bearer ${res.body.data.accessToken as string}`,
      refreshToken: res.body.data.refreshToken as string,
    };
  }

  function clearWecom(auth: string, targetId: string): Promise<request.Response> {
    return request(httpServer(app))
      .delete(`/api/admin/v1/users/${targetId}/wecom`)
      .set('Authorization', auth);
  }

  /** 完整一次本人绑定(authorize → step-up → PUT)。 */
  async function bindSelf(auth: string, code: string): Promise<request.Response> {
    const [state, token] = await Promise.all([bindSelfState(auth), stepUpToken(auth)]);
    return putWecom(auth, { code, state, stepUpToken: token });
  }

  beforeAll(async () => {
    process.env.LOGIN_WECOM_THROTTLE_LIMIT = '100';
    process.env.PASSWORD_CHANGE_THROTTLE_LIMIT = '100'; // step-up/password 复用该实例
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);

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

    // §14.2 第 8 项:self 刻意**不绑手机号** —— 走的正是 D-WC-28 的"无手机号兜底"路径
    const self = await createTestUser(app, { username: 'wcb_self' });
    selfId = self.id;
    const other = await createTestUser(app, { username: 'wcb_other' });
    otherId = other.id;

    const admin = await createTestUser(app, { username: 'wcb_admin', role: Role.ADMIN });
    await createTestUser(app, { username: 'wcb_plain', role: Role.USER });

    const { opsAdminRoleId } = await seedRbacPermissionsAndOpsAdmin(app);
    // 本 spec 自行 seed `user.wecom.clear` 并绑 ops-admin(不动 rbac.fixture 共享清单)
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

    selfAuth = (await loginAs(app, 'wcb_self')).authHeader;
    otherAuth = (await loginAs(app, 'wcb_other')).authHeader;
    adminAuth = (await loginAs(app, 'wcb_admin')).authHeader;
    userAuth = (await loginAs(app, 'wcb_plain')).authHeader;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.wecomIdentity.deleteMany();
    await prisma.wecomAuthAttempt.deleteMany();
    await prisma.auditLog.deleteMany();
  });

  // ===== ① GET me/wecom =====

  describe('GET me/wecom', () => {
    it('未绑定返状态对象而不是错误(§11.2 不开 WECOM_NOT_BOUND)', async () => {
      const res = await getWecom(selfAuth);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ bound: false, wecomUserIdMasked: null, boundAt: null });
    });

    it('已绑定只回掩码,不回完整 wecomUserId / corpId', async () => {
      expect((await bindSelf(selfAuth, 'wecom-b-1')).status).toBe(200);

      const res = await getWecom(selfAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.bound).toBe(true);
      expect(String(res.body.data.wecomUserIdMasked)).toContain('****');
      expect(res.body.data.boundAt).not.toBeNull();

      const body = JSON.stringify(res.body);
      expect(body).not.toContain(stubWecomUserId('wecom-b-1'));
      expect(body).not.toContain(CORP_ID);
    });

    it('未登录 → 401', async () => {
      expect((await request(httpServer(app)).get(ME_WECOM_PATH)).status).toBe(401);
    });
  });

  // ===== ② PUT me/wecom:首绑 / 换绑 / step-up 判据(§6.3 / §7.4)=====

  describe('PUT me/wecom', () => {
    it('无手机号用户可先原账号登录再 PASSWORD step-up 完成 self-bind(§14.2 第 8 项)', async () => {
      // self 从头到尾没有 phone —— 短信锚点这条路对他是走不通的
      const me = await prisma.user.findUniqueOrThrow({ where: { id: selfId } });
      expect(me.phone).toBeNull();

      const res = await bindSelf(selfAuth, 'wecom-b-1');
      expect(res.status).toBe(200);
      expect(res.body.data.bound).toBe(true);

      const identities = await prisma.wecomIdentity.findMany({ where: { userId: selfId } });
      expect(identities).toHaveLength(1);
      expect(identities[0].bindingSource).toBe('me');
      expect(identities[0].wecomUserId).toBe(stubWecomUserId('wecom-b-1'));

      const log = await prisma.auditLog.findFirstOrThrow({ where: { event: 'wecom.bind.self' } });
      const ctx = log.context as { extra?: Record<string, unknown> };
      expect(ctx.extra).toEqual({ viaPath: 'me' });
    });

    it('换绑:结束旧身份 + 建新身份,active 恒 1,并撤销全部 refresh', async () => {
      await bindSelf(selfAuth, 'wecom-b-1');
      const session = await loginRaw('wcb_self');
      await prisma.auditLog.deleteMany();

      expect((await bindSelf(session.authHeader, 'wecom-b-2')).status).toBe(200);

      const all = await prisma.wecomIdentity.findMany({ where: { userId: selfId } });
      expect(all.filter((i) => i.status === 'active')).toHaveLength(1);
      expect(all.filter((i) => i.status === 'revoked')).toHaveLength(1);

      // 真实变更 ⇒ 全部活跃 refresh 被撤销
      const live = await prisma.refreshToken.count({
        where: { userId: selfId, revokedAt: null, expiresAt: { gt: new Date() } },
      });
      expect(live).toBe(0);

      await prisma.auditLog.findFirstOrThrow({ where: { event: 'wecom.rebind.self' } });
    });

    it('同目标幂等:不重写身份、不撤 refresh、不写变更 audit', async () => {
      await bindSelf(selfAuth, 'wecom-b-1');
      const session = await loginRaw('wcb_self');
      await prisma.auditLog.deleteMany();
      const before = await prisma.wecomIdentity.findFirstOrThrow({ where: { userId: selfId } });

      const res = await bindSelf(session.authHeader, 'wecom-b-1');
      expect(res.status).toBe(200);

      const after = await prisma.wecomIdentity.findMany({ where: { userId: selfId } });
      expect(after).toHaveLength(1);
      expect(after[0].id).toBe(before.id);
      expect(after[0].updatedAt.getTime()).toBe(before.updatedAt.getTime());

      // 幂等路径不写 bind/rebind audit
      expect(
        await prisma.auditLog.count({
          where: { event: { in: ['wecom.bind.self', 'wecom.rebind.self'] } },
        }),
      ).toBe(0);
      // 也不撤 refresh:刚签的会话仍活着
      expect(
        await prisma.refreshToken.count({
          where: { userId: selfId, revokedAt: null, expiresAt: { gt: new Date() } },
        }),
      ).toBeGreaterThan(0);
    });

    it('他人已 active 占用同一企业微信号 → 36002', async () => {
      expect((await bindSelf(otherAuth, 'wecom-b-9')).status).toBe(200);
      expectBizError(await bindSelf(selfAuth, 'wecom-b-9'), BizCode.WECOM_IDENTITY_ALREADY_BOUND);
      expect(await prisma.wecomIdentity.count({ where: { userId: selfId } })).toBe(0);
    });

    it('缺 step-up proof / proof 无效 → 10008,不落身份', async () => {
      const state = await bindSelfState(selfAuth);
      expectBizError(
        await putWecom(selfAuth, { code: 'wecom-b-1', state, stepUpToken: 'garbage' }),
        BizCode.STEP_UP_PROOF_INVALID,
      );
      expect(await prisma.wecomIdentity.count()).toBe(0);
    });

    it('跨 action 的 proof 不通用:PHONE_BIND 的 proof 不能用于绑企业微信', async () => {
      const [state, token] = await Promise.all([
        bindSelfState(selfAuth),
        stepUpToken(selfAuth, 'PHONE_BIND'),
      ]);
      expectBizError(
        await putWecom(selfAuth, { code: 'wecom-b-1', state, stepUpToken: token }),
        BizCode.STEP_UP_PROOF_INVALID,
      );
    });

    // ⚠️ proof **超时过期**刻意不在 e2e 测,原因写在这里免得后来者又加一遍:
    //   ① step-up proof 与 OAuth state 的 TTL 都是 300 秒 —— 把时钟往前推 301 秒,
    //      两者会同时过期,请求先撞 state 校验拿到 36010,断言就从"测 proof 过期"
    //      悄悄变成了"测 state 过期"(本刀初版正是这样假失败的);
    //   ② 要绕开 ① 就得在 fake timers 生效期间再发一次 HTTP + DB 请求,
    //      而 Prisma / pg 的连接与超时逻辑依赖真实时钟,实测整条 suite **挂死**。
    // 时间维度的判据留在单测:`identity-step-up.service.spec.ts`
    // 「过期/错误 audience/user/action/stale snapshot 统一 10008」不碰 DB,fake timers 安全。
    // e2e 这一层测的是**状态维度**的失效(下面那条 admin clear 用例),那才是 §7.4 的立项理由。

    it('state 一次性且必须属于本人(拿别人的 state 绑自己 → 36010)', async () => {
      const token = await stepUpToken(selfAuth);
      const otherState = await bindSelfState(otherAuth);
      expectBizError(
        await putWecom(selfAuth, { code: 'wecom-b-1', state: otherState, stepUpToken: token }),
        BizCode.WECOM_LOGIN_CREDENTIAL_INVALID,
      );

      // 自己的 state 也只能用一次
      const state = await bindSelfState(selfAuth);
      expect(
        (await putWecom(selfAuth, { code: 'wecom-b-1', state, stepUpToken: token })).status,
      ).toBe(200);
      expectBizError(
        await putWecom(selfAuth, {
          code: 'wecom-b-1',
          state,
          stepUpToken: await stepUpToken(selfAuth),
        }),
        BizCode.WECOM_LOGIN_CREDENTIAL_INVALID,
      );
    });

    it('login state 不能拿来走 bind_self(目的隔离)', async () => {
      const loginAuthorize = await request(httpServer(app))
        .post('/api/auth/v1/login-wecom/authorize')
        .send({});
      const loginState = /[?&]state=([^&#]+)/.exec(
        loginAuthorize.body.data.authorizeUrl as string,
      )?.[1] as string;

      expectBizError(
        await putWecom(selfAuth, {
          code: 'wecom-b-1',
          state: loginState,
          stepUpToken: await stepUpToken(selfAuth),
        }),
        BizCode.WECOM_LOGIN_CREDENTIAL_INVALID,
      );
    });

    // §7.4 的立项理由 + §14.2 第 17 项
    it('admin 清除后,5 分钟内签发的旧 proof 立即失效(不能把身份绑回来)', async () => {
      await bindSelf(selfAuth, 'wecom-b-1');

      // 用户此刻手里握着一张"当时还绑着 wecom-b-1"的 proof
      const session = await loginRaw('wcb_self');
      const staleToken = await stepUpToken(session.authHeader);
      const state = await bindSelfState(session.authHeader);

      // 管理员清除绑定
      expect((await clearWecom(adminAuth, selfId)).status).toBe(200);

      // 旧 proof 的 snapshot 里含清除前的身份指纹 ⇒ 锁后重算不匹配 ⇒ 拒
      const session2 = await loginRaw('wcb_self');
      expectBizError(
        await putWecom(session2.authHeader, {
          code: 'wecom-b-1',
          state,
          stepUpToken: staleToken,
        }),
        BizCode.STEP_UP_PROOF_INVALID,
      );
      expect(await prisma.wecomIdentity.count({ where: { status: 'active' } })).toBe(0);

      // 重新 step-up(此时无身份,指纹为 null 档)即可正常绑回
      expect((await bindSelf(session2.authHeader, 'wecom-b-1')).status).toBe(200);
    });

    it('通道开关关闭时 PUT 也拒(36030)', async () => {
      const [state, token] = await Promise.all([bindSelfState(selfAuth), stepUpToken(selfAuth)]);
      await prisma.wecomSettings.updateMany({ data: { loginEnabled: false } });
      try {
        expectBizError(
          await putWecom(selfAuth, { code: 'wecom-b-1', state, stepUpToken: token }),
          BizCode.WECOM_CHANNEL_NOT_CONFIGURED,
        );
      } finally {
        await prisma.wecomSettings.updateMany({ data: { loginEnabled: true } });
      }
    });

    it('App 面**没有** DELETE me/wecom(D-WC-9 无本人裸解绑)', async () => {
      const res = await request(httpServer(app))
        .delete(ME_WECOM_PATH)
        .set('Authorization', selfAuth);
      expect(res.status).toBe(404);
    });
  });

  // ===== ③ admin clear(§6.4 / §14.2 第 18 项)=====

  describe('DELETE admin/v1/users/:id/wecom', () => {
    it('无权限用户 → 30100', async () => {
      expectBizError(await clearWecom(userAuth, selfId), BizCode.RBAC_FORBIDDEN);
    });

    it('未登录 → 401', async () => {
      const res = await request(httpServer(app)).delete(`/api/admin/v1/users/${selfId}/wecom`);
      expect(res.status).toBe(401);
    });

    it('目标无 active 身份 → 幂等 200 且不写 Audit、不撤 refresh', async () => {
      const before = await prisma.refreshToken.count({
        where: { userId: selfId, revokedAt: null },
      });
      const res = await clearWecom(adminAuth, selfId);
      expect(res.status).toBe(200);
      expect(await prisma.auditLog.count({ where: { event: 'wecom.clear.by-admin' } })).toBe(0);
      expect(await prisma.refreshToken.count({ where: { userId: selfId, revokedAt: null } })).toBe(
        before,
      );
    });

    it('实际清除:身份转 revoked + 撤全部 refresh + 一条掩码 Audit', async () => {
      await bindSelf(selfAuth, 'wecom-b-1');
      const session = await loginRaw('wcb_self');
      await prisma.auditLog.deleteMany();
      expect(
        await prisma.refreshToken.count({
          where: { userId: selfId, revokedAt: null, expiresAt: { gt: new Date() } },
        }),
      ).toBeGreaterThan(0);

      const res = await clearWecom(adminAuth, selfId);
      expect(res.status).toBe(200);
      // 不回显完整企业微信 UserId
      expect(JSON.stringify(res.body)).not.toContain(stubWecomUserId('wecom-b-1'));

      const identity = await prisma.wecomIdentity.findFirstOrThrow({ where: { userId: selfId } });
      expect(identity.status).toBe('revoked');
      expect(identity.revokedAt).not.toBeNull();

      expect(
        await prisma.refreshToken.count({
          where: { userId: selfId, revokedAt: null, expiresAt: { gt: new Date() } },
        }),
      ).toBe(0);

      const logs = await prisma.auditLog.findMany({ where: { event: 'wecom.clear.by-admin' } });
      expect(logs).toHaveLength(1);
      const ctx = logs[0].context as { before?: Record<string, unknown> };
      expect(String(ctx.before?.wecomUserId)).toContain('****');
      expect(JSON.stringify(logs[0])).not.toContain(stubWecomUserId('wecom-b-1'));

      // 清除后旧 refresh 不能再换 token(统一 10007,不区分子原因)
      const refreshed = await request(httpServer(app))
        .post('/api/auth/v1/refresh')
        .send({ refreshToken: session.refreshToken });
      expectBizError(refreshed, BizCode.REFRESH_TOKEN_INVALID);
    });

    it('清除后同一企业微信号可被另一个人重新绑定(revoked 行不挡新绑)', async () => {
      await bindSelf(selfAuth, 'wecom-b-1');
      await clearWecom(adminAuth, selfId);
      expect((await bindSelf(otherAuth, 'wecom-b-1')).status).toBe(200);

      const active = await prisma.wecomIdentity.findMany({ where: { status: 'active' } });
      expect(active).toHaveLength(1);
      expect(active[0].userId).toBe(otherId);
    });

    it('软删用户 → USER_NOT_FOUND', async () => {
      const ghost = await createTestUser(app, {
        username: 'wcb_ghost',
        deletedAt: new Date(),
      });
      expectBizError(await clearWecom(adminAuth, ghost.id), BizCode.USER_NOT_FOUND);
    });
  });
});
