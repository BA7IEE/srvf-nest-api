import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { TEST_PASSWORD, createTestUser } from '../fixtures/users.fixture';
import { truncateAuditLogsTestOnly } from '../helpers/audit-logs-cleanup';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { waitFor } from '../helpers/wait-for';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// Phase 2 P2-3(2026-05-20)App 视角本人自助改密 e2e。
//
// 验收基准:docs/app-api-p2-3-password-review.md §10 + Phase 2 review §9.3 #14。
// 沿 P0-D users-change-my-password.e2e-spec.ts 范式逐项移植 + 新增 App 特定用例:
//   - 10.2.1 ~ 10.2.8 沿 P0-D 范式(成功 / 错误码 / DTO 校验 / 鉴权 / refresh 撤销 / audit / 限流)
//   - 10.2.9 path stability(新 App path 与旧 /api/users/me/password 共存,行为不互相干扰)
//   - 10.2.10 admin without member 行为锁定(D-P2-3-1 = X:允许使用)
//
// 关键反向断言:
//   - response body 不含 passwordHash / deletedAt / accessToken / refreshToken
//   - audit 不含密码明文 / hash
//   - 限流响应不暴露 Retry-After / X-RateLimit-* 头
//   - 改密后旧 access token 仍可调 /me(反向锁定:沿 P0-D §7.5 + P0-E v1 D-4)

const NEW_PASSWORD = 'BrandNew1!';
const APP_PATH = '/api/app/v1/me/password';

const WEAK_PASSWORDS: Array<[string, string]> = [
  ['短(7 字符,< MinLength(8))', 'Pass1!a'],
  ['纯字母(无数字)', 'PasswordOnly'],
  ['纯数字(无字母)', '12345678'],
];

describe('App 视角本人自助改密 PUT /api/app/v1/me/password (P2-3)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  async function createActiveMember(
    memberNo: string,
    displayName = '测试队员',
  ): Promise<{ id: string }> {
    const m = await prisma.member.create({
      data: { memberNo, displayName, gradeCode: 'L1', status: MemberStatus.ACTIVE },
    });
    return { id: m.id };
  }

  async function setupLinkedUser(opts: {
    username: string;
    role?: Role;
    memberNo: string;
  }): Promise<{ userId: string; memberId: string; authHeader: string }> {
    const user = await createTestUser(app, {
      username: opts.username,
      role: opts.role ?? Role.USER,
    });
    const member = await createActiveMember(opts.memberNo);
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    const { authHeader } = await loginAs(app, opts.username);
    return { userId: user.id, memberId: member.id, authHeader };
  }

  // ============ 10.2.1 核心成功路径 + DB 状态 ============
  describe('核心成功路径 + DB 状态', () => {
    it('USER 改密成功:200 / code=0 / 永不含 passwordHash / 永不含 token', async () => {
      const user = await createTestUser(app, { username: 'appcmpuser1' });
      const { authHeader } = await loginAs(app, 'appcmpuser1');

      // loginAs 的 lastLoginAt 写入是 fire-and-forget；先等登录副作用落库再取
      // 基线，避免它在改密请求期间完成而被误判为 changeMyPassword 修改。
      await waitFor(async () => {
        const row = await prisma.user.findUnique({ where: { id: user.id } });
        return row !== null && row.lastLoginAt !== null;
      });
      const before = await prisma.user.findUnique({ where: { id: user.id } });
      expect(before).not.toBeNull();

      const res = await request(httpServer(app))
        .put(APP_PATH)
        .set('Authorization', authHeader)
        .send({ oldPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.message).toBe('ok');
      expect(res.body.data.id).toBe(user.id);
      expect(res.body.data.username).toBe('appcmpuser1');
      // 反向锁定(沿评审稿 §3.3):response body 永不含敏感字段
      expect(res.body.data).not.toHaveProperty('passwordHash');
      expect(res.body.data).not.toHaveProperty('deletedAt');
      expect(res.body.data).not.toHaveProperty('accessToken');
      expect(res.body.data).not.toHaveProperty('refreshToken');
      expect(res.body.data).not.toHaveProperty('tokenHash');

      const after = await prisma.user.findUnique({ where: { id: user.id } });
      expect(after?.passwordHash).not.toBe(before?.passwordHash);
      // lastLoginAt 不因改密而被刷(沿 P0-D §7.7 zero drift)
      expect(after?.lastLoginAt?.getTime() ?? null).toBe(before?.lastLoginAt?.getTime() ?? null);
    });

    it('改密后旧密码登录 → LOGIN_FAILED', async () => {
      await createTestUser(app, { username: 'appcmpoldfail1' });
      const { authHeader } = await loginAs(app, 'appcmpoldfail1');

      await request(httpServer(app))
        .put(APP_PATH)
        .set('Authorization', authHeader)
        .send({ oldPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

      const res = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'appcmpoldfail1', password: TEST_PASSWORD });

      expectBizError(res, BizCode.LOGIN_FAILED);
    });

    it('改密后新密码登录 → 200 + accessToken', async () => {
      await createTestUser(app, { username: 'appcmpnewok1' });
      const { authHeader } = await loginAs(app, 'appcmpnewok1');

      await request(httpServer(app))
        .put(APP_PATH)
        .set('Authorization', authHeader)
        .send({ oldPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

      const res = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'appcmpnewok1', password: NEW_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(typeof res.body.data.accessToken).toBe('string');
    });
  });

  // ============ 10.2.2 P0-E PR-3 改密联动 refresh 撤销 ============
  describe('P0-E PR-3 改密联动 refresh 撤销', () => {
    it('改密后该 user 全部 refresh 被撤销 + revokedReason=self-password-change', async () => {
      const user = await createTestUser(app, { username: 'appcmprefresh1' });
      const { authHeader } = await loginAs(app, 'appcmprefresh1');

      await request(httpServer(app))
        .put(APP_PATH)
        .set('Authorization', authHeader)
        .send({ oldPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

      const rows = await prisma.refreshToken.findMany({ where: { userId: user.id } });
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.revokedAt).not.toBeNull();
        expect(r.revokedReason).toBe('self-password-change');
      }
    });

    it('改密前的 refresh token 不能再换 access → 10007', async () => {
      await createTestUser(app, { username: 'appcmprefresh2' });
      const lb = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'appcmprefresh2', password: TEST_PASSWORD });
      const refreshRaw = lb.body.data.refreshToken;
      const authHeader = `Bearer ${lb.body.data.accessToken}`;

      await request(httpServer(app))
        .put(APP_PATH)
        .set('Authorization', authHeader)
        .send({ oldPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

      const refreshRes = await request(httpServer(app))
        .post('/api/auth/v1/refresh')
        .send({ refreshToken: refreshRaw });
      expect(refreshRes.status).toBe(401);
      expect(refreshRes.body.code).toBe(10007);
    });

    it('audit password.change.self 含 extra.refreshTokensRevoked: 1', async () => {
      const user = await createTestUser(app, { username: 'appcmprefresh3' });
      const { authHeader } = await loginAs(app, 'appcmprefresh3');

      await request(httpServer(app))
        .put(APP_PATH)
        .set('Authorization', authHeader)
        .send({ oldPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

      const audit = await prisma.auditLog.findFirst({
        where: { actorUserId: user.id, event: 'password.change.self' },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit).not.toBeNull();
      const ctx = audit?.context as { extra?: { refreshTokensRevoked?: number } } | null;
      expect(ctx?.extra?.refreshTokensRevoked).toBe(1);
    });
  });

  // ============ 10.2.3 错误码 ============
  describe('错误码', () => {
    it('oldPassword 错 → OLD_PASSWORD_INVALID + HTTP 401', async () => {
      await createTestUser(app, { username: 'appcmpoldwrong1' });
      const { authHeader } = await loginAs(app, 'appcmpoldwrong1');

      const res = await request(httpServer(app))
        .put(APP_PATH)
        .set('Authorization', authHeader)
        .send({ oldPassword: 'WrongOld1!', newPassword: NEW_PASSWORD });

      expectBizError(res, BizCode.OLD_PASSWORD_INVALID);
    });

    it('newPassword === oldPassword → NEW_PASSWORD_SAME_AS_OLD + HTTP 400', async () => {
      await createTestUser(app, { username: 'appcmpsame1' });
      const { authHeader } = await loginAs(app, 'appcmpsame1');

      const res = await request(httpServer(app))
        .put(APP_PATH)
        .set('Authorization', authHeader)
        .send({ oldPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD });

      expectBizError(res, BizCode.NEW_PASSWORD_SAME_AS_OLD);
    });
  });

  // ============ 10.2.4 DTO 校验 ============
  describe('DTO 校验', () => {
    let authHeader: string;

    beforeAll(async () => {
      await createTestUser(app, { username: 'appcmpdtouser1' });
      ({ authHeader } = await loginAs(app, 'appcmpdtouser1'));
    });

    it('缺 oldPassword → BAD_REQUEST,message 含 oldPassword', async () => {
      const res = await request(httpServer(app))
        .put(APP_PATH)
        .set('Authorization', authHeader)
        .send({ newPassword: NEW_PASSWORD });

      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
      expect(res.body.message).toContain('oldPassword');
    });

    it('缺 newPassword → BAD_REQUEST,message 含 newPassword', async () => {
      const res = await request(httpServer(app))
        .put(APP_PATH)
        .set('Authorization', authHeader)
        .send({ oldPassword: TEST_PASSWORD });

      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
      expect(res.body.message).toContain('newPassword');
    });

    it.each(WEAK_PASSWORDS)(
      'newPassword %s → BAD_REQUEST,message 含 password 关键词',
      async (_label, weak) => {
        const res = await request(httpServer(app))
          .put(APP_PATH)
          .set('Authorization', authHeader)
          .send({ oldPassword: TEST_PASSWORD, newPassword: weak });

        expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
        expect(res.body.message.toLowerCase()).toContain('password');
      },
    );

    // 沿评审稿 §2.3 字段白名单铁律:覆盖 P0-D 既有 4 类 + App 特定字段(memberId / userId / appAccessReason)
    it.each([
      ['passwordHash', '$2a$10$abc'],
      ['role', Role.SUPER_ADMIN],
      ['status', 'DISABLED'],
      ['id', 'cl0000000000000000000000'],
      ['memberId', 'cl0000000000000000000mem'],
      ['userId', 'cl0000000000000000000usr'],
      ['appAccessReason', 'MEMBER_NOT_LINKED'],
    ])(
      '额外字段 %s → BAD_REQUEST,message 含字段名(forbidNonWhitelisted 兜底)',
      async (field, value) => {
        const res = await request(httpServer(app))
          .put(APP_PATH)
          .set('Authorization', authHeader)
          .send({ oldPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD, [field]: value });

        expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
        expect(res.body.message).toContain(field);
      },
    );
  });

  // ============ 10.2.5 鉴权与跨角色 ============
  describe('鉴权与跨角色', () => {
    it('未登录 → UNAUTHORIZED + HTTP 401', async () => {
      const res = await request(httpServer(app))
        .put(APP_PATH)
        .send({ oldPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('SUPER_ADMIN 走 App /me/password 改自己 → 成功,新密码登录有效', async () => {
      await createTestUser(app, { username: 'appcmpsuper1', role: Role.SUPER_ADMIN });
      const { authHeader } = await loginAs(app, 'appcmpsuper1');

      const res = await request(httpServer(app))
        .put(APP_PATH)
        .set('Authorization', authHeader)
        .send({ oldPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.data.role).toBe(Role.SUPER_ADMIN);

      const login = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'appcmpsuper1', password: NEW_PASSWORD });
      expect(login.status).toBe(200);
      expect(typeof login.body.data.accessToken).toBe('string');
    });

    it('ADMIN 走 App /me/password 改自己 → 成功', async () => {
      await createTestUser(app, { username: 'appcmpadmin1', role: Role.ADMIN });
      const { authHeader } = await loginAs(app, 'appcmpadmin1');

      const res = await request(httpServer(app))
        .put(APP_PATH)
        .set('Authorization', authHeader)
        .send({ oldPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.data.role).toBe(Role.ADMIN);

      const login = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'appcmpadmin1', password: NEW_PASSWORD });
      expect(login.status).toBe(200);
    });
  });

  // ============ 10.2.6 反向锁定:旧 token 不吊销 ============
  describe('反向锁定:改密后旧 access token 仍有效(沿 P0-D §7.5 + P0-E v1 D-4)', () => {
    it('改密后用旧 token GET /api/app/v1/me → 200,锁定不吊销旧 access', async () => {
      const { memberId, authHeader } = await setupLinkedUser({
        username: 'appcmptokenstay1',
        memberNo: 'APP-TK-1',
      });
      expect(memberId).not.toBeUndefined();

      const before = await request(httpServer(app))
        .get('/api/app/v1/me')
        .set('Authorization', authHeader);
      expect(before.status).toBe(200);

      const change = await request(httpServer(app))
        .put(APP_PATH)
        .set('Authorization', authHeader)
        .send({ oldPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });
      expect(change.status).toBe(200);

      // 用同一旧 token 再调 GET /api/app/v1/me 仍应 200
      const after = await request(httpServer(app))
        .get('/api/app/v1/me')
        .set('Authorization', authHeader);
      expect(after.status).toBe(200);
      expect(after.body.code).toBe(0);
      expect(after.body.data.username).toBe('appcmptokenstay1');
    });
  });

  // ============ 10.2.7 audit log ============
  describe('audit log', () => {
    beforeAll(async () => {
      await truncateAuditLogsTestOnly(app);
    });

    it('改密成功后 audit_logs 新增 1 条 password.change.self;不含密码任何明文 / hash', async () => {
      const user = await createTestUser(app, { username: 'appcmpaudituser1' });
      const { authHeader } = await loginAs(app, 'appcmpaudituser1');

      const before = await prisma.auditLog.count();

      const change = await request(httpServer(app))
        .put(APP_PATH)
        .set('Authorization', authHeader)
        .send({ oldPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });
      expect(change.status).toBe(200);

      const after = await prisma.auditLog.count();
      expect(after).toBe(before + 1);

      const log = await prisma.auditLog.findFirst({
        orderBy: { createdAt: 'desc' },
      });
      expect(log).not.toBeNull();
      // P2-3 复用 P0-D event name 'password.change.self'(沿评审稿 §7.1 不新增 event)
      expect(log!.event).toBe('password.change.self');
      expect(log!.actorUserId).toBe(user.id);
      expect(log!.actorRoleSnap).toBe(Role.USER);
      expect(log!.resourceType).toBe('user');
      expect(log!.resourceId).toBe(user.id);
      expect(log!.success).toBe(true);

      const ctx = log!.context as { requestId: string; ip: string | null; ua: string | null };
      expect(typeof ctx.requestId).toBe('string');
      expect(ctx.requestId.length).toBeGreaterThan(0);
      expect(ctx).toHaveProperty('ip');
      expect(ctx).toHaveProperty('ua');

      // 沿评审稿 §7.3 + §10.3:序列化的 audit 记录中不得出现任何明文密码 / hash 子串
      const serialized = JSON.stringify(log);
      expect(serialized).not.toContain(TEST_PASSWORD);
      expect(serialized).not.toContain(NEW_PASSWORD);
      expect(serialized).not.toContain('$2'); // bcrypt hash 前缀

      const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
      expect(serialized).not.toContain(dbUser!.passwordHash);
    });
  });

  // Route B Phase 4d(2026-06-01):旧 /api/users/me/password path-stability 共存测试已删除
  // (legacy controller 已移除;app/v1/me/password 行为由本 spec 其余用例覆盖)。

  // ============ 10.2.10 Admin without member 行为锁定(D-P2-3-1 = X) ============
  // 评审稿 §4.2.1 / §4.3 锁定:Admin / SUPER_ADMIN without member 允许使用 App 改密。
  // 该豁免**严格仅本端点**(沿 §4.6);不得复用于其他 App endpoint。
  describe('D-P2-3-1 = X: Admin without member 允许使用(沿评审稿 §4.3 + §4.6)', () => {
    it('SUPER_ADMIN without member → 200 改密成功', async () => {
      await createTestUser(app, { username: 'appcmpsa_nomember', role: Role.SUPER_ADMIN });
      const { authHeader } = await loginAs(app, 'appcmpsa_nomember');

      const res = await request(httpServer(app))
        .put(APP_PATH)
        .set('Authorization', authHeader)
        .send({ oldPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data.role).toBe(Role.SUPER_ADMIN);

      // 新密码登录可用
      const login = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'appcmpsa_nomember', password: NEW_PASSWORD });
      expect(login.status).toBe(200);
    });

    it('ADMIN without member → 200 改密成功(沿 §4.2.1 理由:不读 member 业务字段)', async () => {
      await createTestUser(app, { username: 'appcmpadm_nomember', role: Role.ADMIN });
      const { authHeader } = await loginAs(app, 'appcmpadm_nomember');

      const res = await request(httpServer(app))
        .put(APP_PATH)
        .set('Authorization', authHeader)
        .send({ oldPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data.role).toBe(Role.ADMIN);
    });

    it('USER without member → 200(对照:USER 也不要求 canUseApp=true;本端点豁免准入)', async () => {
      // 本用例锁定 §4.6 例外边界:USER 无 member 也能改密
      //(与 /me/profile 必须 canUseApp=true 形成对照)
      await createTestUser(app, { username: 'appcmpuser_nomember' });
      const { authHeader } = await loginAs(app, 'appcmpuser_nomember');

      const res = await request(httpServer(app))
        .put(APP_PATH)
        .set('Authorization', authHeader)
        .send({ oldPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.data.role).toBe(Role.USER);
    });

    it('Member INACTIVE 也能改密(账号级操作不受 member 状态影响;沿 §4.6)', async () => {
      const { memberId, authHeader } = await setupLinkedUser({
        username: 'appcmpmember_inactive',
        memberNo: 'APP-MI-1',
      });
      await prisma.member.update({
        where: { id: memberId },
        data: { status: MemberStatus.INACTIVE },
      });

      const res = await request(httpServer(app))
        .put(APP_PATH)
        .set('Authorization', authHeader)
        .send({ oldPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
    });

    it('豁免边界对照:Admin without member 调 /me/profile 仍 → 403 FORBIDDEN(沿 §4.6)', async () => {
      // 此用例是反向锁定 §4.6 例外边界:**豁免仅本 password 端点**;
      // 同一 admin without member 调 /me/profile 必须仍被拒,以防豁免泛化为 App 准入松绑
      await createTestUser(app, { username: 'appcmpadm_profile_blocked', role: Role.ADMIN });
      const { authHeader } = await loginAs(app, 'appcmpadm_profile_blocked');

      // /me/password:豁免允许 → 200
      const pwdRes = await request(httpServer(app))
        .put(APP_PATH)
        .set('Authorization', authHeader)
        .send({ oldPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });
      expect(pwdRes.status).toBe(200);

      // /me/profile:豁免不复用 → 403
      const profileRes = await request(httpServer(app))
        .get('/api/app/v1/me/profile')
        .set('Authorization', authHeader);
      expectBizError(profileRes, BizCode.FORBIDDEN);
    });
  });
});

// ============ 10.2.8 限流(独立 describe + 独立 createTestApp) ============
// 沿 P0-D users-change-my-password.e2e-spec.ts §7.4 范式;throttler 实例 'password-change'
// 与旧 /api/users/me/password 共享同一计数器(沿评审稿 §8.2 + §8.3 A 档锁定)。
describe('App 视角本人自助改密限流 PUT /api/app/v1/me/password throttling', () => {
  let app: INestApplication;

  const originalLimit = process.env.PASSWORD_CHANGE_THROTTLE_LIMIT;
  const originalTtl = process.env.PASSWORD_CHANGE_THROTTLE_TTL_SECONDS;

  beforeAll(async () => {
    process.env.PASSWORD_CHANGE_THROTTLE_LIMIT = '5';
    process.env.PASSWORD_CHANGE_THROTTLE_TTL_SECONDS = '60';
    app = await createTestApp();
    await resetDb(app);
    await createTestUser(app, { username: 'appcmpthrottle1' });
  });

  afterAll(async () => {
    await app.close();
    if (originalLimit === undefined) {
      delete process.env.PASSWORD_CHANGE_THROTTLE_LIMIT;
    } else {
      process.env.PASSWORD_CHANGE_THROTTLE_LIMIT = originalLimit;
    }
    if (originalTtl === undefined) {
      delete process.env.PASSWORD_CHANGE_THROTTLE_TTL_SECONDS;
    } else {
      process.env.PASSWORD_CHANGE_THROTTLE_TTL_SECONDS = originalTtl;
    }
  });

  it('5 次窗口内失败返回 OLD_PASSWORD_INVALID,第 6 次起返回 TOO_MANY_REQUESTS', async () => {
    const { authHeader } = await loginAs(app, 'appcmpthrottle1');

    for (let i = 1; i <= 5; i++) {
      const res = await request(httpServer(app))
        .put('/api/app/v1/me/password')
        .set('Authorization', authHeader)
        .send({ oldPassword: 'WrongOld1!', newPassword: NEW_PASSWORD });
      expectBizError(res, BizCode.OLD_PASSWORD_INVALID);
    }

    const blocked = await request(httpServer(app))
      .put('/api/app/v1/me/password')
      .set('Authorization', authHeader)
      .send({ oldPassword: 'WrongOld1!', newPassword: NEW_PASSWORD });
    expectBizError(blocked, BizCode.TOO_MANY_REQUESTS);
    expect(blocked.body).toEqual({
      code: BizCode.TOO_MANY_REQUESTS.code,
      message: BizCode.TOO_MANY_REQUESTS.message,
      data: null,
    });
  });

  it('限流响应不暴露 Retry-After / X-RateLimit-* 头', async () => {
    const { authHeader } = await loginAs(app, 'appcmpthrottle1');
    const res = await request(httpServer(app))
      .put('/api/app/v1/me/password')
      .set('Authorization', authHeader)
      .send({ oldPassword: 'WrongOld1!', newPassword: NEW_PASSWORD });
    expect(res.status).toBe(BizCode.TOO_MANY_REQUESTS.httpStatus);

    expect(res.headers['retry-after']).toBeUndefined();
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    expect(res.headers['x-ratelimit-remaining']).toBeUndefined();
    expect(res.headers['x-ratelimit-reset']).toBeUndefined();
    expect(res.headers['retry-after-password-change']).toBeUndefined();
    expect(res.headers['x-ratelimit-limit-password-change']).toBeUndefined();
  });
});
