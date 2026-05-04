import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { httpServer } from '../helpers/http-server';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { loginAs } from '../fixtures/auth.fixture';
import { TEST_PASSWORD, createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { type AdminEndpoint, callEndpoint } from '../helpers/call-endpoint';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 14.6.3 role-boundary spec(14 用例)
// 覆盖角色边界:
//   - USER 调任何管理接口 → FORBIDDEN(40300,Guard @Roles 拦截)
//   - ADMIN 调 PATCH /:id/role(任何 target) → FORBIDDEN(40300,@Roles(SUPER_ADMIN) 拦截)
//   - ADMIN 调其他 5 个 :id 端点操作 SUPER_ADMIN → FORBIDDEN_ROLE_OPERATION(10101,
//     service 层 assertCanManageUser 拒)
//
// 说明:Guard 在 service 之前执行,所以 USER 看不到 service 层的 10101 错误码;
// ADMIN 调 PATCH /:id/role 也是 Guard 先拦,40300 而非 10101——这是 controller
// 层 @Roles vs service 层 assertCanManageUser 的先后顺序差异。

const ALL_ADMIN_ENDPOINTS: AdminEndpoint[] = [
  { name: 'GET /api/users', method: 'get', path: '/api/users' },
  {
    name: 'POST /api/users',
    method: 'post',
    path: '/api/users',
    body: { username: 'rbnewuser1', password: TEST_PASSWORD },
  },
  { name: 'GET /api/users/:id', method: 'get', path: '/api/users/__ID__' },
  {
    name: 'PATCH /api/users/:id',
    method: 'patch',
    path: '/api/users/__ID__',
    body: { nickname: 'X' },
  },
  {
    name: 'PUT /api/users/:id/password',
    method: 'put',
    path: '/api/users/__ID__/password',
    body: { newPassword: TEST_PASSWORD },
  },
  {
    name: 'PATCH /api/users/:id/role',
    method: 'patch',
    path: '/api/users/__ID__/role',
    body: { role: Role.USER },
  },
  {
    name: 'PATCH /api/users/:id/status',
    method: 'patch',
    path: '/api/users/__ID__/status',
    body: { status: 'DISABLED' },
  },
  { name: 'DELETE /api/users/:id', method: 'delete', path: '/api/users/__ID__' },
];

// ADMIN 操作非 USER target 时,service 层 assertCanManageUser 拒(10101)。
// 但 PATCH /:id/role 例外:它装饰 @Roles(SUPER_ADMIN),对 ADMIN 直接 Guard 拒(40300),
// 不进 service。这两类分开测。
const ADMIN_BLOCKED_BY_SERVICE: AdminEndpoint[] = [
  { name: 'GET /api/users/:id', method: 'get', path: '/api/users/__ID__' },
  {
    name: 'PATCH /api/users/:id',
    method: 'patch',
    path: '/api/users/__ID__',
    body: { nickname: 'X' },
  },
  {
    name: 'PUT /api/users/:id/password',
    method: 'put',
    path: '/api/users/__ID__/password',
    body: { newPassword: TEST_PASSWORD },
  },
  {
    name: 'PATCH /api/users/:id/status',
    method: 'patch',
    path: '/api/users/__ID__/status',
    body: { status: 'DISABLED' },
  },
  { name: 'DELETE /api/users/:id', method: 'delete', path: '/api/users/__ID__' },
];

describe('users 管理接口角色边界', () => {
  let app: INestApplication;
  let plainUserAuth: string;
  let adminAuth: string;
  let userTargetId: string;
  let superTargetId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);

    await createTestUser(app, { username: 'rbplain1', role: Role.USER });
    await createTestUser(app, { username: 'rbadmin1', role: Role.ADMIN });
    const userTarget = await createTestUser(app, { username: 'rbusertarget1', role: Role.USER });
    const superTarget = await createTestUser(app, {
      username: 'rbsupertarget1',
      role: Role.SUPER_ADMIN,
    });
    userTargetId = userTarget.id;
    superTargetId = superTarget.id;

    ({ authHeader: plainUserAuth } = await loginAs(app, 'rbplain1'));
    ({ authHeader: adminAuth } = await loginAs(app, 'rbadmin1'));
  });

  afterAll(async () => {
    await app.close();
  });

  describe('USER 调任何管理接口 → 40300(Guard @Roles 拦截)', () => {
    it.each(ALL_ADMIN_ENDPOINTS)('USER 调 $name → 40300', async (ep) => {
      // path 含 __ID__ 时用 userTargetId 替换让 path 合法;Guard 在路由匹配后、
      // controller 调用前拦截,所以 target 实际值不影响行为
      const res = await callEndpoint(app, plainUserAuth, ep, userTargetId);
      expectBizError(res, BizCode.FORBIDDEN);
    });
  });

  describe('ADMIN 调 PATCH /:id/role → 40300(@Roles(SUPER_ADMIN) 拦截,先于 service)', () => {
    it('ADMIN 调 PATCH /:id/role 操作 USER → 40300(Guard 拒,不进 service)', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/users/${userTargetId}/role`)
        .set('Authorization', adminAuth)
        .send({ role: Role.USER });

      // 关键:这里期望 40300 不是 10101,因为 PATCH /:id/role 装饰 @Roles(SUPER_ADMIN),
      // ADMIN 在 Guard 阶段就被拒,根本不进 service
      expectBizError(res, BizCode.FORBIDDEN);
    });
  });

  describe('ADMIN 调其他 5 个 :id 端点操作 SUPER_ADMIN → 10101(service 层 assertCanManageUser 拒)', () => {
    it.each(ADMIN_BLOCKED_BY_SERVICE)(
      'ADMIN 调 $name 操作 SUPER_ADMIN target → 10101',
      async (ep) => {
        const res = await callEndpoint(app, adminAuth, ep, superTargetId);
        expectBizError(res, BizCode.FORBIDDEN_ROLE_OPERATION);
      },
    );
  });
});
