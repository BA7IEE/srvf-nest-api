import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { TEST_PASSWORD, createTestUser } from '../fixtures/users.fixture';
import { truncateAuditLogsTestOnly } from '../helpers/audit-logs-cleanup';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// P0-D PR-3(2026-05-17)本人自助改密 e2e。
//
// 验收基准:docs/first-release-p0d-change-my-password-review.md §7。
// 覆盖维度:
//   - 7.1 核心路径:改密成功 / 旧密码失效 / 新密码可登录
//   - 7.2 错误码:OLD_PASSWORD_INVALID / NEW_PASSWORD_SAME_AS_OLD / BAD_REQUEST 各路径
//   - 7.3 鉴权:未登录 + SUPER_ADMIN / ADMIN 走 me/password 改自己
//   - 7.4 限流:5/60 IP 维度,第 6 次 → TOO_MANY_REQUESTS;响应不暴露阈值头
//   - 7.5 反向锁定:改密后旧 token 仍可 GET /me 返 200(v1 故意不吊销)
//   - 7.6 audit:写入 password.change.self;不含 oldPassword / newPassword / passwordHash 子串
//   - 7.7 DB 状态:passwordHash 改变;lastLoginAt 不变

const NEW_PASSWORD = 'BrandNew1!';

const WEAK_PASSWORDS: Array<[string, string]> = [
  ['短(7 字符,< MinLength(8))', 'Pass1!a'],
  ['纯字母(无数字)', 'PasswordOnly'],
  ['纯数字(无字母)', '12345678'],
];

describe('本人自助改密 PUT /api/users/me/password', () => {
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

  // ============ 7.1 核心成功路径 + 7.7 DB 状态 ============
  describe('核心成功路径 + DB 状态', () => {
    it('USER 改密成功:200 / code=0 / 字段集严格 = 10 / 永不含 passwordHash', async () => {
      const user = await createTestUser(app, { username: 'cmpuser1' });
      const { authHeader } = await loginAs(app, 'cmpuser1');

      const before = await prisma.user.findUnique({ where: { id: user.id } });
      expect(before).not.toBeNull();

      const res = await request(httpServer(app))
        .put('/api/users/me/password')
        .set('Authorization', authHeader)
        .send({ oldPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.message).toBe('ok');
      expect(res.body.data.id).toBe(user.id);
      expect(res.body.data.username).toBe('cmpuser1');
      expect(res.body.data).not.toHaveProperty('passwordHash');
      expect(res.body.data).not.toHaveProperty('deletedAt');

      const after = await prisma.user.findUnique({ where: { id: user.id } });
      // 7.7 passwordHash 已改变
      expect(after?.passwordHash).not.toBe(before?.passwordHash);
      // 7.7 lastLoginAt 不因改密而被刷(评审稿 §3.3 / §7.7)
      expect(after?.lastLoginAt?.getTime() ?? null).toBe(before?.lastLoginAt?.getTime() ?? null);
    });

    it('改密后旧密码登录 → LOGIN_FAILED', async () => {
      await createTestUser(app, { username: 'cmpoldfail1' });
      const { authHeader } = await loginAs(app, 'cmpoldfail1');

      await request(httpServer(app))
        .put('/api/users/me/password')
        .set('Authorization', authHeader)
        .send({ oldPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

      const res = await request(httpServer(app))
        .post('/api/auth/login')
        .send({ username: 'cmpoldfail1', password: TEST_PASSWORD });

      expectBizError(res, BizCode.LOGIN_FAILED);
    });

    it('改密后新密码登录 → 200 + accessToken', async () => {
      await createTestUser(app, { username: 'cmpnewok1' });
      const { authHeader } = await loginAs(app, 'cmpnewok1');

      await request(httpServer(app))
        .put('/api/users/me/password')
        .set('Authorization', authHeader)
        .send({ oldPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

      const res = await request(httpServer(app))
        .post('/api/auth/login')
        .send({ username: 'cmpnewok1', password: NEW_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(typeof res.body.data.accessToken).toBe('string');
    });
  });

  // ============ P0-E PR-3:本人改密 → 主动撤销 refresh token ============
  describe('P0-E PR-3 改密联动 refresh 撤销', () => {
    it('改密后该 user 全部 refresh 被撤销 + revokedReason=self-password-change', async () => {
      const user = await createTestUser(app, { username: 'cmprefresh1' });
      const { authHeader } = await loginAs(app, 'cmprefresh1');

      await request(httpServer(app))
        .put('/api/users/me/password')
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
      await createTestUser(app, { username: 'cmprefresh2' });
      const lb = await request(httpServer(app))
        .post('/api/auth/login')
        .send({ username: 'cmprefresh2', password: TEST_PASSWORD });
      const refreshRaw = lb.body.data.refreshToken;
      const authHeader = `Bearer ${lb.body.data.accessToken}`;

      await request(httpServer(app))
        .put('/api/users/me/password')
        .set('Authorization', authHeader)
        .send({ oldPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

      const refreshRes = await request(httpServer(app))
        .post('/api/auth/refresh')
        .send({ refreshToken: refreshRaw });
      expect(refreshRes.status).toBe(401);
      expect(refreshRes.body.code).toBe(10007);
    });

    it('audit password.change.self 含 extra.refreshTokensRevoked: 1', async () => {
      const user = await createTestUser(app, { username: 'cmprefresh3' });
      const { authHeader } = await loginAs(app, 'cmprefresh3');

      await request(httpServer(app))
        .put('/api/users/me/password')
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

  // ============ 7.2 错误码 ============
  describe('错误码', () => {
    it('oldPassword 错 → OLD_PASSWORD_INVALID + HTTP 401', async () => {
      await createTestUser(app, { username: 'cmpoldwrong1' });
      const { authHeader } = await loginAs(app, 'cmpoldwrong1');

      const res = await request(httpServer(app))
        .put('/api/users/me/password')
        .set('Authorization', authHeader)
        .send({ oldPassword: 'WrongOld1!', newPassword: NEW_PASSWORD });

      expectBizError(res, BizCode.OLD_PASSWORD_INVALID);
    });

    it('newPassword === oldPassword → NEW_PASSWORD_SAME_AS_OLD + HTTP 400', async () => {
      await createTestUser(app, { username: 'cmpsame1' });
      const { authHeader } = await loginAs(app, 'cmpsame1');

      const res = await request(httpServer(app))
        .put('/api/users/me/password')
        .set('Authorization', authHeader)
        .send({ oldPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD });

      expectBizError(res, BizCode.NEW_PASSWORD_SAME_AS_OLD);
    });
  });

  // ============ 7.2 DTO 校验 ============
  describe('DTO 校验', () => {
    let authHeader: string;

    beforeAll(async () => {
      await createTestUser(app, { username: 'cmpdtouser1' });
      ({ authHeader } = await loginAs(app, 'cmpdtouser1'));
    });

    it('缺 oldPassword → BAD_REQUEST,message 含 oldPassword', async () => {
      const res = await request(httpServer(app))
        .put('/api/users/me/password')
        .set('Authorization', authHeader)
        .send({ newPassword: NEW_PASSWORD });

      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
      expect(res.body.message).toContain('oldPassword');
    });

    it('缺 newPassword → BAD_REQUEST,message 含 newPassword', async () => {
      const res = await request(httpServer(app))
        .put('/api/users/me/password')
        .set('Authorization', authHeader)
        .send({ oldPassword: TEST_PASSWORD });

      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
      expect(res.body.message).toContain('newPassword');
    });

    // 三类 message 来源不同:
    //   - 短 → "newPassword must be longer than or equal to 8 characters"
    //   - 纯字母 / 纯数字 → DTO 自定义 message "password 至少 8 位,且必须包含字母和数字"
    // 用 toLowerCase + toContain('password') 兼容两类。
    it.each(WEAK_PASSWORDS)(
      'newPassword %s → BAD_REQUEST,message 含 password 关键词',
      async (_label, weak) => {
        const res = await request(httpServer(app))
          .put('/api/users/me/password')
          .set('Authorization', authHeader)
          .send({ oldPassword: TEST_PASSWORD, newPassword: weak });

        expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
        expect(res.body.message.toLowerCase()).toContain('password');
      },
    );

    it.each([
      ['passwordHash', '$2a$10$abc'],
      ['role', Role.SUPER_ADMIN],
      ['status', 'DISABLED'],
      ['id', 'cl0000000000000000000000'],
    ])(
      '额外字段 %s → BAD_REQUEST,message 含字段名(forbidNonWhitelisted 兜底)',
      async (field, value) => {
        const res = await request(httpServer(app))
          .put('/api/users/me/password')
          .set('Authorization', authHeader)
          .send({ oldPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD, [field]: value });

        expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
        expect(res.body.message).toContain(field);
      },
    );
  });

  // ============ 7.3 鉴权与跨角色 ============
  describe('鉴权与跨角色', () => {
    it('未登录 → UNAUTHORIZED + HTTP 401', async () => {
      const res = await request(httpServer(app))
        .put('/api/users/me/password')
        .send({ oldPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('SUPER_ADMIN 走 me/password 改自己 → 成功,新密码登录有效', async () => {
      await createTestUser(app, { username: 'cmpsuper1', role: Role.SUPER_ADMIN });
      const { authHeader } = await loginAs(app, 'cmpsuper1');

      const res = await request(httpServer(app))
        .put('/api/users/me/password')
        .set('Authorization', authHeader)
        .send({ oldPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.data.role).toBe(Role.SUPER_ADMIN);

      const login = await request(httpServer(app))
        .post('/api/auth/login')
        .send({ username: 'cmpsuper1', password: NEW_PASSWORD });
      expect(login.status).toBe(200);
      expect(typeof login.body.data.accessToken).toBe('string');
    });

    it('ADMIN 走 me/password 改自己 → 成功(填补评审稿 §1.3 缺口)', async () => {
      await createTestUser(app, { username: 'cmpadmin1', role: Role.ADMIN });
      const { authHeader } = await loginAs(app, 'cmpadmin1');

      const res = await request(httpServer(app))
        .put('/api/users/me/password')
        .set('Authorization', authHeader)
        .send({ oldPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.data.role).toBe(Role.ADMIN);

      const login = await request(httpServer(app))
        .post('/api/auth/login')
        .send({ username: 'cmpadmin1', password: NEW_PASSWORD });
      expect(login.status).toBe(200);
      expect(typeof login.body.data.accessToken).toBe('string');
    });
  });

  // ============ 7.5 反向锁定:旧 token 不吊销 ============
  // 评审稿 §5.7 + §7.5:v1 故意不吊销;JwtStrategy.validate 不读 passwordHash。
  // 未来若有人"顺手加吊销 token 逻辑",此用例会立刻挂,逼回头先改 security.md。
  describe('反向锁定:改密后旧 token 仍有效', () => {
    it('改密后用旧 token GET /me → 200,锁定不吊销旧 token', async () => {
      await createTestUser(app, { username: 'cmptokenstay1' });
      const { authHeader } = await loginAs(app, 'cmptokenstay1');

      const before = await request(httpServer(app))
        .get('/api/users/me')
        .set('Authorization', authHeader);
      expect(before.status).toBe(200);

      const change = await request(httpServer(app))
        .put('/api/users/me/password')
        .set('Authorization', authHeader)
        .send({ oldPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });
      expect(change.status).toBe(200);

      // 用同一旧 token 再调 GET /me 仍应 200
      const after = await request(httpServer(app))
        .get('/api/users/me')
        .set('Authorization', authHeader);
      expect(after.status).toBe(200);
      expect(after.body.code).toBe(0);
      expect(after.body.data.username).toBe('cmptokenstay1');
    });
  });

  // ============ 7.6 audit log 写入 ============
  describe('audit log', () => {
    beforeAll(async () => {
      // 清空 audit_logs,避免前面 it 写入的记录污染本块断言。
      await truncateAuditLogsTestOnly(app);
    });

    it('改密成功后 audit_logs 新增 1 条 password.change.self;不含密码任何明文 / hash', async () => {
      const user = await createTestUser(app, { username: 'cmpaudituser1' });
      const { authHeader } = await loginAs(app, 'cmpaudituser1');

      const before = await prisma.auditLog.count();

      const change = await request(httpServer(app))
        .put('/api/users/me/password')
        .set('Authorization', authHeader)
        .send({ oldPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });
      expect(change.status).toBe(200);

      const after = await prisma.auditLog.count();
      expect(after).toBe(before + 1);

      // 取最新一条 audit 验事件名 / 字段 / context 三必填 / 敏感字段不泄漏
      const log = await prisma.auditLog.findFirst({
        orderBy: { createdAt: 'desc' },
      });
      expect(log).not.toBeNull();
      expect(log!.event).toBe('password.change.self');
      expect(log!.actorUserId).toBe(user.id);
      expect(log!.actorRoleSnap).toBe(Role.USER);
      expect(log!.resourceType).toBe('user');
      expect(log!.resourceId).toBe(user.id);
      expect(log!.success).toBe(true);

      // AuditContext 锁形 3 必填
      const ctx = log!.context as { requestId: string; ip: string | null; ua: string | null };
      expect(typeof ctx.requestId).toBe('string');
      expect(ctx.requestId.length).toBeGreaterThan(0);
      expect(ctx).toHaveProperty('ip');
      expect(ctx).toHaveProperty('ua');

      // 敏感字段反向断言:序列化的 audit 记录中不得出现任何明文密码 / hash 子串
      // (评审稿 §5.6 / §7.6:禁止把 oldPassword / newPassword / passwordHash 写入 audit)
      const serialized = JSON.stringify(log);
      expect(serialized).not.toContain(TEST_PASSWORD);
      expect(serialized).not.toContain(NEW_PASSWORD);
      expect(serialized).not.toContain('$2'); // bcrypt hash 前缀

      // 取数据库当前 passwordHash,确认它也未被 audit 记录
      const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
      expect(serialized).not.toContain(dbUser!.passwordHash);
    });
  });
});

// ============ 7.4 限流 ============
// 独立 describe 块 + 独立 createTestApp,避免污染上面共享 app 的 throttler 计数器。
// 通过 beforeAll 临时覆盖 process.env.PASSWORD_CHANGE_THROTTLE_LIMIT=5,
// createTestApp 内 app.config 重读取生效;afterAll 还原。
//
// 沿 auth-login-throttle.e2e-spec.ts 范式。
describe('本人自助改密限流 PUT /api/users/me/password throttling', () => {
  let app: INestApplication;

  const originalLimit = process.env.PASSWORD_CHANGE_THROTTLE_LIMIT;
  const originalTtl = process.env.PASSWORD_CHANGE_THROTTLE_TTL_SECONDS;

  beforeAll(async () => {
    process.env.PASSWORD_CHANGE_THROTTLE_LIMIT = '5';
    process.env.PASSWORD_CHANGE_THROTTLE_TTL_SECONDS = '60';
    app = await createTestApp();
    await resetDb(app);
    await createTestUser(app, { username: 'cmpthrottle1' });
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

  // 用错误 oldPassword 触发(避免成功路径修改实际密码导致后续请求 oldPassword 错位)。
  // 前 5 次 → OLD_PASSWORD_INVALID;第 6 次 → TOO_MANY_REQUESTS。
  it('5 次窗口内失败返回 OLD_PASSWORD_INVALID,第 6 次起返回 TOO_MANY_REQUESTS', async () => {
    const { authHeader } = await loginAs(app, 'cmpthrottle1');

    for (let i = 1; i <= 5; i++) {
      const res = await request(httpServer(app))
        .put('/api/users/me/password')
        .set('Authorization', authHeader)
        .send({ oldPassword: 'WrongOld1!', newPassword: NEW_PASSWORD });
      expectBizError(res, BizCode.OLD_PASSWORD_INVALID);
    }

    const blocked = await request(httpServer(app))
      .put('/api/users/me/password')
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
    // 接续上一 it,storage 仍处 block 状态;再发一次直接拿 429。
    const { authHeader } = await loginAs(app, 'cmpthrottle1');
    const res = await request(httpServer(app))
      .put('/api/users/me/password')
      .set('Authorization', authHeader)
      .send({ oldPassword: 'WrongOld1!', newPassword: NEW_PASSWORD });
    expect(res.status).toBe(BizCode.TOO_MANY_REQUESTS.httpStatus);

    expect(res.headers['retry-after']).toBeUndefined();
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    expect(res.headers['x-ratelimit-remaining']).toBeUndefined();
    expect(res.headers['x-ratelimit-reset']).toBeUndefined();
    // 兼容 named throttler 后缀格式
    expect(res.headers['retry-after-password-change']).toBeUndefined();
    expect(res.headers['x-ratelimit-limit-password-change']).toBeUndefined();
  });
});
