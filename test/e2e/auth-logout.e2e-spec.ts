import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Role } from '@prisma/client';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import {
  generateRefreshTokenRaw,
  hashRefreshToken,
} from '../../src/modules/auth/refresh-token.util';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// Identity Session P0 PR2 e2e:POST /api/auth/v1/logout(冻结评审稿 §4.8)。
// 任一可识别且未过期的 row(含 rotated ancestor)撤销所属 family 全部活跃未过期 token。
// 未知 / row 过期 / family 已全撤仍幂等 200;仅真实状态变化写 audit;access 不吊销。

describe('POST /api/auth/v1/logout', () => {
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

  describe('family 撤销', () => {
    it('fresh leaf logout → 200 + 撤销 family + 精确写一次 auth.logout audit', async () => {
      const u = await createTestUser(app, { username: 'logoutok1' });
      const { body: lb } = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'logoutok1', password: 'Passw0rd1!' });
      const beforeRow = await prisma.refreshToken.findFirstOrThrow({ where: { userId: u.id } });

      const res = await request(httpServer(app))
        .post('/api/auth/v1/logout')
        .send({ refreshToken: lb.data.refreshToken });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ code: 0, message: 'ok', data: null });

      const row = await prisma.refreshToken.findUniqueOrThrow({ where: { id: beforeRow.id } });
      expect(row.revokedAt).not.toBeNull();
      expect(row.revokedReason).toBe('logout');

      const audits = await prisma.auditLog.findMany({
        where: { event: 'auth.logout', actorUserId: u.id },
      });
      expect(audits).toHaveLength(1);
      expect((audits[0].context as { extra: Record<string, unknown> }).extra).toEqual({
        familyId: beforeRow.familyId,
        revokedCount: 1,
      });
    });

    it('logout 后同一 refresh 再 refresh → HTTP 401 + REFRESH_TOKEN_INVALID', async () => {
      await createTestUser(app, { username: 'logoutreuse1' });
      const { body: lb } = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'logoutreuse1', password: 'Passw0rd1!' });
      await request(httpServer(app))
        .post('/api/auth/v1/logout')
        .send({ refreshToken: lb.data.refreshToken });

      const res = await request(httpServer(app))
        .post('/api/auth/v1/refresh')
        .send({ refreshToken: lb.data.refreshToken });
      expectBizError(res, BizCode.REFRESH_TOKEN_INVALID);
    });

    it('同 family 多个 active unexpired row → 一次全部撤销且使用相同 revokedAt', async () => {
      const u = await createTestUser(app, { username: 'logoutmulti1' });
      const { body: lb } = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'logoutmulti1', password: 'Passw0rd1!' });
      const leaf = await prisma.refreshToken.findFirstOrThrow({ where: { userId: u.id } });
      const extraRaw1 = generateRefreshTokenRaw();
      const extraRaw2 = generateRefreshTokenRaw();
      await prisma.refreshToken.createMany({
        data: [extraRaw1, extraRaw2].map((raw) => ({
          userId: u.id,
          tokenHash: hashRefreshToken(raw),
          familyId: leaf.familyId,
          expiresAt: leaf.expiresAt,
        })),
      });

      const res = await request(httpServer(app))
        .post('/api/auth/v1/logout')
        .send({ refreshToken: lb.data.refreshToken });
      expect(res.status).toBe(200);

      const family = await prisma.refreshToken.findMany({
        where: { familyId: leaf.familyId },
        orderBy: { createdAt: 'asc' },
      });
      expect(family).toHaveLength(3);
      expect(family.every((row) => row.revokedReason === 'logout')).toBe(true);
      expect(new Set(family.map((row) => row.revokedAt?.getTime()))).toEqual(
        new Set([family[0].revokedAt?.getTime()]),
      );

      const audits = await prisma.auditLog.findMany({
        where: { event: 'auth.logout', actorUserId: u.id },
      });
      expect(audits).toHaveLength(1);
      expect((audits[0].context as { extra: Record<string, unknown> }).extra).toEqual({
        familyId: leaf.familyId,
        revokedCount: 3,
      });
    });

    it('rotated ancestor logout → 撤销 active leaf,不触发 reuse detection', async () => {
      const u = await createTestUser(app, { username: 'logoutfam1' });
      const { body: lb } = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'logoutfam1', password: 'Passw0rd1!' });
      const r1 = lb.data.refreshToken;
      const rotated = await request(httpServer(app))
        .post('/api/auth/v1/refresh')
        .send({ refreshToken: r1 });
      expect(rotated.status).toBe(200);
      const r2 = rotated.body.data.refreshToken;
      const refreshAuditBefore = await prisma.auditLog.count({
        where: { event: 'auth.refresh', actorUserId: u.id },
      });

      const logoutRes = await request(httpServer(app))
        .post('/api/auth/v1/logout')
        .send({ refreshToken: r1 });
      expect(logoutRes.status).toBe(200);
      expect(logoutRes.body).toEqual({ code: 0, message: 'ok', data: null });

      const refreshAuditAfter = await prisma.auditLog.count({
        where: { event: 'auth.refresh', actorUserId: u.id },
      });
      expect(refreshAuditAfter).toBe(refreshAuditBefore);

      const family = await prisma.refreshToken.findMany({
        where: { userId: u.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(family).toHaveLength(2);
      expect(family[0].revokedReason).toBe('rotated');
      expect(family[1].revokedReason).toBe('logout');
      expect(family.some((row) => row.revokedReason === 'family-revoked')).toBe(false);

      const leafUse = await request(httpServer(app))
        .post('/api/auth/v1/refresh')
        .send({ refreshToken: r2 });
      expectBizError(leafUse, BizCode.REFRESH_TOKEN_INVALID);

      const audits = await prisma.auditLog.findMany({
        where: { event: 'auth.logout', actorUserId: u.id },
      });
      expect(audits).toHaveLength(1);
      expect((audits[0].context as { extra: Record<string, unknown> }).extra).toEqual({
        familyId: family[0].familyId,
        revokedCount: 1,
      });
    });

    it('logout 只按 familyId 撤销,其他 family 保持可用', async () => {
      const u = await createTestUser(app, { username: 'logoutother1' });
      const first = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'logoutother1', password: 'Passw0rd1!' });
      const second = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'logoutother1', password: 'Passw0rd1!' });
      const firstRefreshToken: unknown = first.body.data.refreshToken;
      const secondRefreshToken: unknown = second.body.data.refreshToken;
      expect(typeof firstRefreshToken).toBe('string');
      expect(typeof secondRefreshToken).toBe('string');
      if (typeof firstRefreshToken !== 'string' || typeof secondRefreshToken !== 'string') {
        throw new Error('login response refreshToken must be a string');
      }
      const before = await prisma.refreshToken.findMany({ where: { userId: u.id } });
      expect(new Set(before.map((row) => row.familyId)).size).toBe(2);
      const firstRow = before.find((row) => row.tokenHash === hashRefreshToken(firstRefreshToken));
      const secondRow = before.find(
        (row) => row.tokenHash === hashRefreshToken(secondRefreshToken),
      );
      expect(firstRow).toBeDefined();
      expect(secondRow).toBeDefined();

      const logoutRes = await request(httpServer(app))
        .post('/api/auth/v1/logout')
        .send({ refreshToken: firstRefreshToken });
      expect(logoutRes.status).toBe(200);

      const after = await prisma.refreshToken.findMany({ where: { userId: u.id } });
      expect(after.find((row) => row.id === firstRow?.id)?.revokedReason).toBe('logout');
      expect(after.find((row) => row.id === secondRow?.id)?.revokedAt).toBeNull();

      const otherFamilyUse = await request(httpServer(app))
        .post('/api/auth/v1/refresh')
        .send({ refreshToken: secondRefreshToken });
      expect(otherFamilyUse.status).toBe(200);
    });
  });

  describe('幂等 no-op', () => {
    it('不存在的 refresh → 仍 200 且 auth.logout audit 零新增', async () => {
      const before = await prisma.auditLog.count({ where: { event: 'auth.logout' } });
      const res = await request(httpServer(app))
        .post('/api/auth/v1/logout')
        .send({ refreshToken: generateRefreshTokenRaw() });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ code: 0, message: 'ok', data: null });
      const after = await prisma.auditLog.count({ where: { event: 'auth.logout' } });
      expect(after).toBe(before);
    });

    it('family 已全部 revoked → 重复 logout 仍 200 且只保留首次状态变化 audit', async () => {
      const u = await createTestUser(app, { username: 'logoutidem1' });
      const { body: lb } = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'logoutidem1', password: 'Passw0rd1!' });
      await request(httpServer(app))
        .post('/api/auth/v1/logout')
        .send({ refreshToken: lb.data.refreshToken });

      const res = await request(httpServer(app))
        .post('/api/auth/v1/logout')
        .send({ refreshToken: lb.data.refreshToken });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ code: 0, message: 'ok', data: null });
      expect(
        await prisma.auditLog.count({ where: { event: 'auth.logout', actorUserId: u.id } }),
      ).toBe(1);
    });

    it('已过期的 refresh row → 仍 200 且不写 audit', async () => {
      const u = await createTestUser(app, { username: 'logoutexp1' });
      const { body: lb } = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'logoutexp1', password: 'Passw0rd1!' });
      await prisma.refreshToken.updateMany({
        where: { userId: u.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const res = await request(httpServer(app))
        .post('/api/auth/v1/logout')
        .send({ refreshToken: lb.data.refreshToken });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ code: 0, message: 'ok', data: null });
      expect(
        await prisma.auditLog.count({ where: { event: 'auth.logout', actorUserId: u.id } }),
      ).toBe(0);
    });
  });

  describe('access token 不被吊销(沿 D-4)', () => {
    it('logout 后旧 access token 仍可调受保护 endpoint', async () => {
      await createTestUser(app, { username: 'logoutaccess1', role: Role.SUPER_ADMIN });
      const { body: lb } = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'logoutaccess1', password: 'Passw0rd1!' });

      const authHeader = `Bearer ${lb.data.accessToken}`;
      await request(httpServer(app))
        .post('/api/auth/v1/logout')
        .send({ refreshToken: lb.data.refreshToken });

      const meRes = await request(httpServer(app))
        .get('/api/admin/v1/users')
        .set('Authorization', authHeader);
      expect(meRes.status).toBe(200);
      expect(meRes.body.code).toBe(0);
    });
  });

  describe('route / DTO 契约', () => {
    it('不带 Authorization 头也能 logout(refresh token 自身即凭证)', async () => {
      await createTestUser(app, { username: 'logoutpub1' });
      const { body: lb } = await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'logoutpub1', password: 'Passw0rd1!' });

      const res = await request(httpServer(app))
        .post('/api/auth/v1/logout')
        .send({ refreshToken: lb.data.refreshToken });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ code: 0, message: 'ok', data: null });
    });

    it('缺 refreshToken → HTTP 400 + BAD_REQUEST', async () => {
      const res = await request(httpServer(app)).post('/api/auth/v1/logout').send({});
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });
  });
});
