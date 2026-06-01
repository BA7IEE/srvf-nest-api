import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { httpServer } from '../helpers/http-server';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { TEST_PASSWORD, createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { type AdminEndpoint, callEndpoint } from '../helpers/call-endpoint';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 14.7.3 soft-delete spec(7 用例)
// 系统化覆盖软删用户的副作用矩阵:
//   - 5 个 :id 写/读端点对软删用户统一表现 USER_NOT_FOUND
//   - 重复 DELETE 同一软删用户 → USER_NOT_FOUND
//   - 软删后用该 username + 正确密码登录 → LOGIN_FAILED(防账号枚举)
//
// 14.6 已覆盖的不重复:列表过滤、username/email 不复用、DELETE 后 db.deletedAt 非空。

// 软删用户的 :id 端点矩阵(GET/PATCH/PUT pwd/PATCH role/PATCH status)
const TARGET_ENDPOINTS: AdminEndpoint[] = [
  { name: 'GET /:id', method: 'get', path: '/api/users/__ID__' },
  {
    name: 'PATCH /:id',
    method: 'patch',
    path: '/api/users/__ID__',
    body: { nickname: 'X' },
  },
  {
    name: 'PUT /:id/password',
    method: 'put',
    path: '/api/users/__ID__/password',
    body: { newPassword: 'NewPass123!' },
  },
  {
    name: 'PATCH /:id/role',
    method: 'patch',
    path: '/api/users/__ID__/role',
    body: { role: Role.ADMIN },
  },
  {
    name: 'PATCH /:id/status',
    method: 'patch',
    path: '/api/users/__ID__/status',
    body: { status: 'ACTIVE' },
  },
];

describe('软删用户的副作用矩阵', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authHeader: string;
  let ghostUserId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    // 操作者:活跃 SUPER_ADMIN
    await createTestUser(app, { username: 'sdsuper1', role: Role.SUPER_ADMIN });
    ({ authHeader } = await loginAs(app, 'sdsuper1'));

    // 被软删用户:14.6 已测 DELETE 接口本身,这里直接用 prisma 设状态,
    // 聚焦"软删后的副作用"而非"DELETE 调用"
    const ghost = await createTestUser(app, { username: 'sdghost1' });
    await prisma.user.update({
      where: { id: ghost.id },
      data: { deletedAt: new Date(), status: 'DISABLED' },
    });
    ghostUserId = ghost.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // 5 端点 it.each:对软删用户操作均为 USER_NOT_FOUND(notDeletedWhere 过滤生效,
  // 找不到目标 → findRawByIdOrThrow 抛 USER_NOT_FOUND)
  it.each(TARGET_ENDPOINTS)('已软删用户被调 $name → USER_NOT_FOUND', async (ep) => {
    const res = await callEndpoint(app, authHeader, ep, ghostUserId);
    expectBizError(res, BizCode.USER_NOT_FOUND);
  });

  it('已软删用户再 DELETE /:id → USER_NOT_FOUND(softDelete 内 findRawByIdOrThrow 找不到)', async () => {
    const res = await request(httpServer(app))
      .delete(`/api/users/${ghostUserId}`)
      .set('Authorization', authHeader);

    expectBizError(res, BizCode.USER_NOT_FOUND);
  });

  it('软删后用该 username + 正确密码登录 → LOGIN_FAILED(防账号枚举,与"用户不存在"响应一致)', async () => {
    const res = await request(httpServer(app))
      .post('/api/auth/v1/login')
      .send({ username: 'sdghost1', password: TEST_PASSWORD });

    expectBizError(res, BizCode.LOGIN_FAILED);
  });

  // P0-E PR-3:DELETE 软删 → 主动撤销目标 user 全部 refresh token(revokedReason=admin-delete)。
  // 沿评审稿 §7.4 + CLAUDE/AGENTS §9 P0-E 联动撤销 4 场景之一。
  // 本 PR **不**为软删写 audit(沿 D-PR3-2 用户拍板;仅撤销 refresh)。
  describe('P0-E PR-3 软删联动 refresh 撤销', () => {
    it('DELETE 后目标 user 全部 refresh 被撤销 + revokedReason=admin-delete', async () => {
      // 新建一个 user + login 拿 refresh,然后 SUPER_ADMIN DELETE
      const target = await createTestUser(app, { username: 'sdrefresh1' });
      await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'sdrefresh1', password: TEST_PASSWORD });

      const before = await prisma.refreshToken.findMany({
        where: { userId: target.id, revokedAt: null },
      });
      expect(before.length).toBe(1);

      const del = await request(httpServer(app))
        .delete(`/api/users/${target.id}`)
        .set('Authorization', authHeader);
      expect(del.status).toBe(200);

      const after = await prisma.refreshToken.findMany({ where: { userId: target.id } });
      expect(after.length).toBeGreaterThan(0);
      for (const r of after) {
        expect(r.revokedAt).not.toBeNull();
        expect(r.revokedReason).toBe('admin-delete');
      }
    });
  });
});
