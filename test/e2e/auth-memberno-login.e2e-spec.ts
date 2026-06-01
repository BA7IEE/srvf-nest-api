import type { INestApplication } from '@nestjs/common';
import { UserStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { TEST_PASSWORD, TEST_PASSWORD_HASH } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// V2 Step 5 — auth.service.ts memberNo 登录回退 e2e。
// 严格按 docs/v2-api-contract.md §6.6 + ARCHITECTURE.md §12.8.2.4 验收:
//   - v1 username 登录路径零退化(本 spec 仅证明 memberNo 路径,既有 auth-login.e2e
//     spec 仍覆盖 v1 字段防御四场景)
//   - memberNo 命中 + 绑定 user + 密码正确 → 200
//   - 账号枚举失败场景 4 行(§6.6.3):响应体 / HTTP / message 完全一致
//   - memberNo trim 后查找(前后空格被吃)
//   - memberNo 大小写敏感(与 username toLowerCase 不同)
//   - memberNo 命中但 member 已软删 → 视作未命中,走 dummy bcrypt
//   - memberNo 命中但 user 已禁用 / 已软删 → LOGIN_FAILED 401
//
// 真实 memberNo 样例不进 fixture(R13 红线);所有 memberNo 用 'demo-*' 抽象占位。

const BCRYPT_SALT_ROUNDS = 10;

async function createUserWithPassword(
  prisma: PrismaService,
  username: string,
  password: string,
): Promise<{ id: string }> {
  const passwordHash =
    password === TEST_PASSWORD
      ? TEST_PASSWORD_HASH
      : await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
  return prisma.user.create({
    data: {
      username,
      passwordHash,
      status: UserStatus.ACTIVE,
    },
    select: { id: true },
  });
}

describe('auth memberNo 登录回退', () => {
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

  // ============ 主成功路径 ============

  describe('memberNo 命中 + 绑定 user + 密码正确 → 200', () => {
    it('用 memberNo 作为 username 字段登录,返回 JWT', async () => {
      // 创建 user
      const user = await createUserWithPassword(prisma, 'mnologin1', TEST_PASSWORD);
      // 创建 member 并绑定
      const member = await prisma.member.create({
        data: { memberNo: 'demo-MN-100', displayName: 'M100' },
      });
      await prisma.user.update({
        where: { id: user.id },
        data: { memberId: member.id },
      });

      const res = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'demo-MN-100', password: TEST_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(typeof res.body.data.accessToken).toBe('string');
      expect(res.body.data.accessToken.length).toBeGreaterThan(0);
      expect(res.body.data.tokenType).toBe('Bearer');
    });

    it('memberNo 含前后空格 → 400(LoginDto @Matches 拒绝)', async () => {
      // 注:contract §6.6.2 "service trim" 描述的是防御性 trim,实际 LoginDto.username
      // @Matches(/^[a-zA-Z0-9_-]+$/) 不允许空格,DTO 层先拦截。这与 v1 username 行为
      // 完全一致(LoginDto schema 严格 zero drift,不能加 @Transform)。运营对带空格
      // 输入需在前端裁剪,API 层视为非法输入。
      const res = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: '  demo-MN-100  ', password: TEST_PASSWORD });

      expect(res.status).toBe(400);
    });
  });

  // ============ 账号枚举失败场景(§6.6.3) ============

  describe('账号枚举防护:响应体 / HTTP status / message 完全一致', () => {
    it('场景 1:输入值 username 与 memberNo 两路径均未命中 → LOGIN_FAILED 401', async () => {
      const res = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'demo-no-such-user', password: TEST_PASSWORD });
      expectBizError(res, BizCode.LOGIN_FAILED);
    });

    it('场景 2:memberNo 命中 member,但 member 未绑定 user → LOGIN_FAILED', async () => {
      // 创建一个 member,**不**绑定任何 user
      await prisma.member.create({
        data: { memberNo: 'demo-MN-200', displayName: 'M200' },
      });

      const res = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'demo-MN-200', password: TEST_PASSWORD });
      expectBizError(res, BizCode.LOGIN_FAILED);
    });

    it('场景 3a:命中 user 但 status=DISABLED → LOGIN_FAILED', async () => {
      const user = await createUserWithPassword(prisma, 'mndisabled', TEST_PASSWORD);
      const member = await prisma.member.create({
        data: { memberNo: 'demo-MN-300', displayName: 'M300' },
      });
      await prisma.user.update({
        where: { id: user.id },
        data: { memberId: member.id, status: UserStatus.DISABLED },
      });

      const res = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'demo-MN-300', password: TEST_PASSWORD });
      expectBizError(res, BizCode.LOGIN_FAILED);
    });

    it('场景 3b:命中 user 但 deletedAt!=null → LOGIN_FAILED', async () => {
      const user = await createUserWithPassword(prisma, 'mnsoftdel', TEST_PASSWORD);
      const member = await prisma.member.create({
        data: { memberNo: 'demo-MN-310', displayName: 'M310' },
      });
      await prisma.user.update({
        where: { id: user.id },
        data: { memberId: member.id, deletedAt: new Date() },
      });

      const res = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'demo-MN-310', password: TEST_PASSWORD });
      expectBizError(res, BizCode.LOGIN_FAILED);
    });

    it('场景 4:命中 user + 密码错 → LOGIN_FAILED', async () => {
      // 复用最早 mnologin1 / demo-MN-100
      const res = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'demo-MN-100', password: 'WrongPassw0rd' });
      expectBizError(res, BizCode.LOGIN_FAILED);
    });

    it('场景:memberNo 命中但 member 已软删 → 视作未命中,LOGIN_FAILED', async () => {
      const user = await createUserWithPassword(prisma, 'mnsoftmem', TEST_PASSWORD);
      const member = await prisma.member.create({
        data: {
          memberNo: 'demo-MN-400',
          displayName: 'M400',
          deletedAt: new Date(),
        },
      });
      await prisma.user.update({
        where: { id: user.id },
        data: { memberId: member.id },
      });

      const res = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'demo-MN-400', password: TEST_PASSWORD });
      expectBizError(res, BizCode.LOGIN_FAILED);
    });

    it('memberNo 大小写敏感:lower-case 输入查不到 upper-case memberNo', async () => {
      // demo-MN-100 已存在(大写 MN);用 demo-mn-100 登录应失败
      // (member.findUnique by memberNo 严格匹配,大小写敏感)
      const res = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'demo-mn-100', password: TEST_PASSWORD });
      expectBizError(res, BizCode.LOGIN_FAILED);
    });
  });

  // ============ Timing 抽样(粗粒度,不要求严格 ms 级) ============

  describe('Timing 抽样:账号枚举相关失败场景响应耗时无统计显著差异', () => {
    // 粗粒度:仅断言所有失败场景耗时在合理范围内(都跑过 bcrypt.compare,
    // 不应该有数量级差异)。严格 ms 级 timing 校验是单元测试范畴,e2e 仅做 sanity。
    const SAMPLES = 3;
    const MAX_RATIO = 5; // 最快 / 最慢 比值不超过 5x

    it('两路径未命中 / member 未绑 user / 密码错 / member 软删 — 耗时合理', async () => {
      const cases: Array<{ label: string; username: string }> = [
        { label: '两路径未命中', username: 'demo-totally-absent' },
        { label: 'member 未绑 user', username: 'demo-MN-200' },
        { label: '密码错', username: 'demo-MN-100' },
        { label: 'member 软删', username: 'demo-MN-400' },
      ];

      const timings: Array<{ label: string; avg: number }> = [];
      for (const c of cases) {
        const samples: number[] = [];
        for (let i = 0; i < SAMPLES; i++) {
          const t0 = Date.now();
          await request(httpServer(app))
            .post('/api/auth/v1/login')
            .send({ username: c.username, password: 'WrongPassw0rd' });
          samples.push(Date.now() - t0);
        }
        timings.push({
          label: c.label,
          avg: samples.reduce((a, b) => a + b, 0) / samples.length,
        });
      }

      const min = Math.min(...timings.map((t) => t.avg));
      const max = Math.max(...timings.map((t) => t.avg));
      // 所有路径都跑过 bcrypt.compare,耗时应在同一数量级
      expect(max / Math.max(min, 1)).toBeLessThan(MAX_RATIO);
    });
  });
});
