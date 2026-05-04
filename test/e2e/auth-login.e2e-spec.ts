import type { INestApplication } from '@nestjs/common';
import { UserStatus } from '@prisma/client';
import request, { type Response } from 'supertest';
import { httpServer } from '../helpers/http-server';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { TEST_PASSWORD, createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { waitFor } from '../helpers/wait-for';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 14.4 auth-login spec(11 用例,跨 4 块)。
// 防账号枚举四场景一致性是核心:用户要求 body 完全一致,不只断 code。
describe('POST /api/auth/login', () => {
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

  describe('成功路径', () => {
    it('正确凭证 → 200,返回标准 LoginResponse 结构', async () => {
      await createTestUser(app, { username: 'logintest1' });

      const res = await request(httpServer(app))
        .post('/api/auth/login')
        .send({ username: 'logintest1', password: TEST_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.message).toBe('ok');
      expect(typeof res.body.data.accessToken).toBe('string');
      expect(res.body.data.accessToken.split('.')).toHaveLength(3);
      expect(res.body.data.tokenType).toBe('Bearer');
      expect(typeof res.body.data.expiresIn).toBe('string');
      expect(res.body.data.expiresIn.length).toBeGreaterThan(0);
    });

    it('accessToken payload 仅含 sub + username + 标准 jwt 字段(无 role / passwordHash)', async () => {
      const user = await createTestUser(app, { username: 'logintest2' });

      const res = await request(httpServer(app))
        .post('/api/auth/login')
        .send({ username: 'logintest2', password: TEST_PASSWORD });

      expect(res.status).toBe(200);
      const token: string = res.body.data.accessToken;
      const payloadB64 = token.split('.')[1];
      const payload: Record<string, unknown> = JSON.parse(
        Buffer.from(payloadB64, 'base64url').toString('utf-8'),
      );

      expect(payload.sub).toBe(user.id);
      expect(payload.username).toBe('logintest2');
      // 除 sub / username / 标准 jwt 字段(iat/exp/nbf)外不应有任何业务字段
      const allowed = new Set(['sub', 'username', 'iat', 'exp', 'nbf']);
      const extraKeys = Object.keys(payload).filter((k) => !allowed.has(k));
      expect(extraKeys).toEqual([]);
    });

    it('username 大写 "AdminTest" 也能登录(service 内 toLowerCase 归一化)', async () => {
      // fixture 存 lowercase,验证 service 在登录时把入参归一化后命中
      await createTestUser(app, { username: 'admintest' });

      const res = await request(httpServer(app))
        .post('/api/auth/login')
        .send({ username: 'AdminTest', password: TEST_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
    });

    it('登录后 lastLoginAt 异步更新成功(fire-and-forget)', async () => {
      const user = await createTestUser(app, { username: 'lastloginat1' });
      expect(user.lastLoginAt).toBeNull();

      const testStart = new Date();
      // 至少 1ms 间隔,保证 lastLoginAt > testStart 的严格 > 比较成立
      await new Promise((r) => setTimeout(r, 5));

      const res = await request(httpServer(app))
        .post('/api/auth/login')
        .send({ username: 'lastloginat1', password: TEST_PASSWORD });
      expect(res.status).toBe(200);

      // auth.service 用 `void prisma.update().catch()`,响应返回时 update 不一定完成。
      // waitFor 轮询直到 lastLoginAt !== null。
      await waitFor(async () => {
        const u = await prisma.user.findUnique({ where: { id: user.id } });
        return u !== null && u.lastLoginAt !== null;
      });

      const updated = await prisma.user.findUnique({ where: { id: user.id } });
      expect(updated?.lastLoginAt).not.toBeNull();
      expect(updated!.lastLoginAt!.getTime()).toBeGreaterThanOrEqual(testStart.getTime());
    });
  });

  // 防账号枚举四场景:四种失败路径必须返回完全相同的响应,
  // 任何 message / code / status / data 上的差异都视为枚举漏洞。
  describe('防账号枚举(LOGIN_FAILED 四场景必须 body + status 完全相等)', () => {
    let resNoUser: Response;
    let resWrongPwd: Response;
    let resDisabled: Response;
    let resSoftDeleted: Response;

    beforeAll(async () => {
      // 三种状态用户:ACTIVE 用于"密码错"、DISABLED、deletedAt!=null
      await createTestUser(app, { username: 'enumactive' });
      await createTestUser(app, {
        username: 'enumdisabled',
        status: UserStatus.DISABLED,
      });
      await createTestUser(app, {
        username: 'enumdeleted',
        deletedAt: new Date(),
      });

      const send = (username: string, password: string): Promise<Response> =>
        request(httpServer(app)).post('/api/auth/login').send({ username, password });

      resNoUser = await send('nonexistentuser', TEST_PASSWORD);
      resWrongPwd = await send('enumactive', 'WrongPwd1!');
      resDisabled = await send('enumdisabled', TEST_PASSWORD);
      resSoftDeleted = await send('enumdeleted', TEST_PASSWORD);
    });

    it('username 不存在 → LOGIN_FAILED', () => {
      expectBizError(resNoUser, BizCode.LOGIN_FAILED);
    });

    it('password 错误(用户 ACTIVE) → LOGIN_FAILED', () => {
      expectBizError(resWrongPwd, BizCode.LOGIN_FAILED);
    });

    it('status=DISABLED → LOGIN_FAILED', () => {
      expectBizError(resDisabled, BizCode.LOGIN_FAILED);
    });

    it('deletedAt!=null → LOGIN_FAILED', () => {
      expectBizError(resSoftDeleted, BizCode.LOGIN_FAILED);
    });

    it('四场景响应必须 body + status 完全相等(用 toEqual 严格比较,不只看 code)', () => {
      const reference = { status: resNoUser.status, body: resNoUser.body };
      for (const res of [resWrongPwd, resDisabled, resSoftDeleted]) {
        expect(res.status).toBe(reference.status);
        expect(res.body).toEqual(reference.body);
      }
    });
  });

  describe('ValidationPipe 边界(直接走 BAD_REQUEST,不查库)', () => {
    it('空 body → BAD_REQUEST,message 含 username 与 password', async () => {
      const res = await request(httpServer(app)).post('/api/auth/login').send({});

      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
      expect(res.body.message).toContain('username');
      expect(res.body.message).toContain('password');
    });

    it('username 太短(2 字符)或含非法字符 → BAD_REQUEST', async () => {
      const resTooShort = await request(httpServer(app))
        .post('/api/auth/login')
        .send({ username: 'ab', password: TEST_PASSWORD });
      expectBizError(resTooShort, BizCode.BAD_REQUEST, { strictMessage: false });
      expect(resTooShort.body.message).toContain('username');

      const resBadChar = await request(httpServer(app))
        .post('/api/auth/login')
        .send({ username: 'bad!@#', password: TEST_PASSWORD });
      expectBizError(resBadChar, BizCode.BAD_REQUEST, { strictMessage: false });
      expect(resBadChar.body.message).toContain('username');
    });
  });
});
