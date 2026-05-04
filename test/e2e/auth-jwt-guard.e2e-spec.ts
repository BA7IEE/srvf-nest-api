import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserStatus } from '@prisma/client';
import request from 'supertest';
import { httpServer } from '../helpers/http-server';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 14.4 jwt-guard spec(7 用例)。
// 验证 JwtAuthGuard + JwtStrategy.validate 在所有 token 失效路径都返回 UNAUTHORIZED (40100)。
//
// 关键不变式(对应 ARCHITECTURE.md §7.6):JwtStrategy 每请求查库,旧 token 在
// 用户被禁用 / 软删后立即失效——这是 v1 不引入 Redis 缓存的有意设计。
describe('JwtAuthGuard / JwtStrategy.validate 失效路径', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    // 优先 app.get;JwtModule 没 export JwtService 的话 fallback 到 select。
    try {
      jwtService = app.get(JwtService);
    } catch {
      jwtService = app.select(AuthModule).get(JwtService);
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('Authorization 头格式错(非 Bearer 前缀) → 40100', async () => {
    const res = await request(httpServer(app))
      .get('/api/users/me')
      .set('Authorization', 'Token abc');
    expectBizError(res, BizCode.UNAUTHORIZED);
  });

  it('token 是乱字符串(非三段 base64) → 40100', async () => {
    const res = await request(httpServer(app))
      .get('/api/users/me')
      .set('Authorization', 'Bearer not-a-real-jwt');
    expectBizError(res, BizCode.UNAUTHORIZED);
  });

  it('破坏合法 token 末尾两字节(签名校验失败) → 40100', async () => {
    const user = await createTestUser(app, { username: 'jwtbreak1' });
    const token = await jwtService.signAsync({ sub: user.id, username: user.username });
    const broken = token.slice(0, -2) + 'xx';

    const res = await request(httpServer(app))
      .get('/api/users/me')
      .set('Authorization', `Bearer ${broken}`);
    expectBizError(res, BizCode.UNAUTHORIZED);
  });

  it('token 签名对但 sub 指向不存在的 cuid → 40100', async () => {
    // cuid 格式但 db 没这个用户(与现实 cuid 长度/前缀类似,DTO IdParamDto 长度 8-64 通过)
    const fakeCuid = 'clxxx0000000000000000000';
    const token = await jwtService.signAsync({ sub: fakeCuid, username: 'ghost' });

    const res = await request(httpServer(app))
      .get('/api/users/me')
      .set('Authorization', `Bearer ${token}`);
    expectBizError(res, BizCode.UNAUTHORIZED);
  });

  it('登录拿 token 后用户被改 status=DISABLED → 旧 token 立即失效(每请求查库)', async () => {
    const user = await createTestUser(app, { username: 'jwtdisable1' });
    const { authHeader } = await loginAs(app, 'jwtdisable1');

    // 先确认 token 现在有效——证明用例失败时不是 token 本身就坏的
    const before = await request(httpServer(app))
      .get('/api/users/me')
      .set('Authorization', authHeader);
    expect(before.status).toBe(200);

    await prisma.user.update({
      where: { id: user.id },
      data: { status: UserStatus.DISABLED },
    });

    const after = await request(httpServer(app))
      .get('/api/users/me')
      .set('Authorization', authHeader);
    expectBizError(after, BizCode.UNAUTHORIZED);

    // 关键交叉断言:登录失败用 LOGIN_FAILED (10004),已登录请求失效用 UNAUTHORIZED (40100),
    // 前端按 code 区分(避免管理员重置/禁用后,前端把"账号被禁"提示成"密码错")。
    expect(after.body.code).toBe(BizCode.UNAUTHORIZED.code);
    expect(after.body.code).not.toBe(BizCode.LOGIN_FAILED.code);
  });

  it('登录拿 token 后用户被软删(deletedAt 非空) → 旧 token 立即失效', async () => {
    const user = await createTestUser(app, { username: 'jwtsoftdel1' });
    const { authHeader } = await loginAs(app, 'jwtsoftdel1');

    await prisma.user.update({
      where: { id: user.id },
      data: { deletedAt: new Date() },
    });

    const res = await request(httpServer(app))
      .get('/api/users/me')
      .set('Authorization', authHeader);
    expectBizError(res, BizCode.UNAUTHORIZED);
  });

  it('token 过期(expiresIn 1ms + sleep 50ms) → 40100', async () => {
    const user = await createTestUser(app, { username: 'jwtexpire1' });
    const expiredToken = await jwtService.signAsync(
      { sub: user.id, username: user.username },
      { expiresIn: '1ms' },
    );
    await new Promise((r) => setTimeout(r, 50));

    const res = await request(httpServer(app))
      .get('/api/users/me')
      .set('Authorization', `Bearer ${expiredToken}`);
    expectBizError(res, BizCode.UNAUTHORIZED);
  });
});
