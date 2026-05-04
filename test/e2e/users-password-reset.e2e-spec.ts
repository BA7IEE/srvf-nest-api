import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { httpServer } from '../helpers/http-server';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { TEST_PASSWORD, createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 14.7.4 password-reset spec(9 用例)
// 系统化覆盖管理员重置密码的完整流程 + DTO 校验 + 反向断言。

const NEW_PASSWORD = 'BrandNew1!';

// newPassword 弱密码 it.each 三类
const WEAK_PASSWORDS: Array<[string, string]> = [
  ['短(7 字符,< MinLength(8))', 'Pass1!a'],
  ['纯字母(无数字)', 'PasswordOnly'],
  ['纯数字(无字母)', '12345678'],
];

describe('管理员重置密码 PUT /api/users/:id/password', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAuth: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    await createTestUser(app, { username: 'pwsuper1', role: Role.SUPER_ADMIN });
    ({ authHeader: superAuth } = await loginAs(app, 'pwsuper1'));
  });

  afterAll(async () => {
    await app.close();
  });

  describe('核心流程', () => {
    it('SUPER_ADMIN PUT /:id/password { newPassword } → 200,db.passwordHash 改变', async () => {
      const target = await createTestUser(app, { username: 'pwflowtarget1' });
      const before = await prisma.user.findUnique({ where: { id: target.id } });

      const res = await request(httpServer(app))
        .put(`/api/users/${target.id}/password`)
        .set('Authorization', superAuth)
        .send({ newPassword: NEW_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);

      const after = await prisma.user.findUnique({ where: { id: target.id } });
      expect(after?.passwordHash).not.toBe(before?.passwordHash);
    });

    it('重置后用旧密码登录 → LOGIN_FAILED', async () => {
      const target = await createTestUser(app, { username: 'pwoldfail1' });

      // 重置
      await request(httpServer(app))
        .put(`/api/users/${target.id}/password`)
        .set('Authorization', superAuth)
        .send({ newPassword: NEW_PASSWORD });

      // 用旧密码登录
      const res = await request(httpServer(app))
        .post('/api/auth/login')
        .send({ username: 'pwoldfail1', password: TEST_PASSWORD });

      expectBizError(res, BizCode.LOGIN_FAILED);
    });

    it('重置后用新密码登录 → 200', async () => {
      const target = await createTestUser(app, { username: 'pwnewok1' });

      await request(httpServer(app))
        .put(`/api/users/${target.id}/password`)
        .set('Authorization', superAuth)
        .send({ newPassword: NEW_PASSWORD });

      const res = await request(httpServer(app))
        .post('/api/auth/login')
        .send({ username: 'pwnewok1', password: NEW_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(typeof res.body.data.accessToken).toBe('string');
    });
  });

  describe('DTO 校验', () => {
    let targetId: string;
    beforeAll(async () => {
      const t = await createTestUser(app, { username: 'pwdtotarget1' });
      targetId = t.id;
    });

    it('body 含 oldPassword(本设计不接受) → BAD_REQUEST,message 含 oldPassword', async () => {
      const res = await request(httpServer(app))
        .put(`/api/users/${targetId}/password`)
        .set('Authorization', superAuth)
        .send({ oldPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
      expect(res.body.message).toContain('oldPassword');
    });

    it('缺 newPassword → BAD_REQUEST,message 含 newPassword', async () => {
      const res = await request(httpServer(app))
        .put(`/api/users/${targetId}/password`)
        .set('Authorization', superAuth)
        .send({});

      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
      expect(res.body.message).toContain('newPassword');
    });
  });

  describe('newPassword 强度校验', () => {
    let targetId: string;
    beforeAll(async () => {
      const t = await createTestUser(app, { username: 'pwweaktarget1' });
      targetId = t.id;
    });

    // 注:三类 message 来源不同:
    //   - 短(MinLength) → "newPassword must be longer than or equal to 8 characters"
    //   - 纯字母 / 纯数字(@Matches) → "password 至少 8 位,且必须包含字母和数字"
    //     (DTO 自定义 message 字面量写 'password' 而非字段名 'newPassword',src 内文案小不一致)
    // 用 toLowerCase + toContain('password') 兼容两类,'newPassword'.toLowerCase() 含 'password' 子串。
    // v1 不动 src,测试按实际 message 适配。
    it.each(WEAK_PASSWORDS)(
      'newPassword %s → BAD_REQUEST,message 含 password 关键词(大小写不敏感)',
      async (_label, weak) => {
        const res = await request(httpServer(app))
          .put(`/api/users/${targetId}/password`)
          .set('Authorization', superAuth)
          .send({ newPassword: weak });

        expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
        expect(res.body.message.toLowerCase()).toContain('password');
      },
    );
  });

  // 反向断言:CLAUDE.md §9 明确"管理员重置密码后不主动吊销旧 token;
  // 如需立即阻断,管理员同步把目标 status 改 DISABLED"。
  // 这条用例确认 v1 故意保留此行为——未来若有人"顺手加吊销 token 逻辑",
  // 此用例会立刻挂,逼回头先改文档 §9。
  it('反向断言:重置密码后旧 token 仍有效(v1 故意不吊销;§9)', async () => {
    const target = await createTestUser(app, { username: 'pwtokenstay1' });
    const { authHeader: targetAuth } = await loginAs(app, 'pwtokenstay1');

    // 先确认 target 旧 token 有效
    const before = await request(httpServer(app))
      .get('/api/users/me')
      .set('Authorization', targetAuth);
    expect(before.status).toBe(200);

    // 管理员重置 target 密码
    const reset = await request(httpServer(app))
      .put(`/api/users/${target.id}/password`)
      .set('Authorization', superAuth)
      .send({ newPassword: NEW_PASSWORD });
    expect(reset.status).toBe(200);

    // 关键:用 target 的旧 token 调 GET /me 仍应 200
    // (JwtStrategy.validate 不读 passwordHash,只看 deletedAt + status === ACTIVE;
    //  passwordHash 改变不影响已签发 token)
    const after = await request(httpServer(app))
      .get('/api/users/me')
      .set('Authorization', targetAuth);
    expect(after.status).toBe(200);
    expect(after.body.code).toBe(0);
    expect(after.body.data.username).toBe('pwtokenstay1');
  });
});
