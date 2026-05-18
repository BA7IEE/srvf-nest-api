import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { httpServer } from '../helpers/http-server';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { loginAs } from '../fixtures/auth.fixture';
import { grantOpsAdminToUser, seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { TEST_PASSWORD, createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { type AdminEndpoint, callEndpoint } from '../helpers/call-endpoint';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 14.6.3 role-boundary spec(覆盖角色边界)
//
// P0-F PR-3B(2026-05-18)重写:
//   - users 8 管理端点入口移除 @Roles,改走 rbac.can('user.*');失败 30100 RBAC_FORBIDDEN
//   - service 内 6 项业务护栏全保留:canViewUser / canManageUser / canCreateRole /
//     canChangeRole / assertNotSelf / assertNotLastSuperAdmin
//
// 覆盖矩阵:
//   - USER 调任何管理接口 → 30100(P0-F PR-3B:USER 无 user.* permission)
//   - ADMIN 默认(未 grant ops-admin) → 30100(同上)
//   - ADMIN+ops-admin 调 PATCH /:id/role → 30100(D1=A:user.update.role 不绑 ops-admin)
//   - ADMIN+ops-admin 调其他 5 个 :id 端点操作 SUPER_ADMIN target → 10101
//     (RBAC 通过后 service 层 assertCanManageUser 拒,业务护栏触发)
//   - SUPER_ADMIN 调 PATCH /:id/role { role: SUPER_ADMIN } → 10101
//     (canChangeRole 业务护栏永禁升 SA;RBAC 短路通过但业务拒)
//
// 沿评审稿 docs/first-release-p0f-pr3-users-rbac-review.md §9.2 + §9.4。

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

// ADMIN+ops-admin 持 6 条 user.* permission(D3=A 5 条 + D2=B 1 条;不持 user.update.role);
// 调 PATCH /:id/role 仍 30100(D1=A 不绑);
// 调其它 5 个 :id 端点操作 SUPER_ADMIN target → service 层 assertCanManageUser 拒 10101。
const ADMIN_OPS_BLOCKED_BY_SERVICE: AdminEndpoint[] = [
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

describe('users 管理接口角色边界(P0-F PR-3B)', () => {
  let app: INestApplication;
  let plainUserAuth: string;
  let adminDefaultAuth: string;
  let adminOpsAuth: string;
  let superAuth: string;
  let userTargetId: string;
  let superTargetId: string;
  let opsAdminRoleId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    ({ opsAdminRoleId } = await seedRbacPermissionsAndOpsAdmin(app));

    await createTestUser(app, { username: 'rbplain1', role: Role.USER });
    await createTestUser(app, {
      username: 'rbadmindefault1',
      role: Role.ADMIN,
    });
    const adminOps = await createTestUser(app, { username: 'rbadminops1', role: Role.ADMIN });
    // ADMIN+ops-admin 绑定 6 条 user.*(不含 user.update.role;D1=A)
    await grantOpsAdminToUser(app, adminOps.id, opsAdminRoleId);

    await createTestUser(app, { username: 'rbsuper1', role: Role.SUPER_ADMIN });
    const userTarget = await createTestUser(app, { username: 'rbusertarget1', role: Role.USER });
    const superTarget = await createTestUser(app, {
      username: 'rbsupertarget1',
      role: Role.SUPER_ADMIN,
    });
    userTargetId = userTarget.id;
    superTargetId = superTarget.id;

    ({ authHeader: plainUserAuth } = await loginAs(app, 'rbplain1'));
    ({ authHeader: adminDefaultAuth } = await loginAs(app, 'rbadmindefault1'));
    ({ authHeader: adminOpsAuth } = await loginAs(app, 'rbadminops1'));
    ({ authHeader: superAuth } = await loginAs(app, 'rbsuper1'));
  });

  afterAll(async () => {
    await app.close();
  });

  describe('USER 调任何管理接口 → 30100(P0-F PR-3B:USER 无 user.* permission)', () => {
    it.each(ALL_ADMIN_ENDPOINTS)('USER 调 $name → 30100', async (ep) => {
      // path 含 __ID__ 时用 userTargetId 替换让 path 合法;RBAC 在 service 首句拦截,
      // 所以 target 实际值不影响行为
      const res = await callEndpoint(app, plainUserAuth, ep, userTargetId);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });

  describe('ADMIN 默认(未 grant ops-admin)调任何管理接口 → 30100', () => {
    it.each(ALL_ADMIN_ENDPOINTS)('ADMIN 默认调 $name → 30100', async (ep) => {
      const res = await callEndpoint(app, adminDefaultAuth, ep, userTargetId);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });

  describe('ADMIN+ops-admin 调 PATCH /:id/role → 30100(D1=A:user.update.role 不绑 ops-admin)', () => {
    it('ADMIN+ops-admin 调 PATCH /:id/role 操作 USER → 30100(RBAC 拒,不进 service)', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/users/${userTargetId}/role`)
        .set('Authorization', adminOpsAuth)
        .send({ role: Role.USER });

      // 关键:ADMIN+ops-admin 持 6 条 user.* 但**不持** user.update.role(D1=A);
      // RbacService.can 返 false → assertCanOrThrow 抛 RBAC_FORBIDDEN(30100)
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });

  describe('ADMIN+ops-admin 调其他 5 个 :id 端点操作 SUPER_ADMIN target → 10101(service 层 assertCanManageUser 拒)', () => {
    it.each(ADMIN_OPS_BLOCKED_BY_SERVICE)(
      'ADMIN+ops-admin 调 $name 操作 SUPER_ADMIN target → 10101',
      async (ep) => {
        // ADMIN+ops-admin RBAC 通过(持对应 user.* permission)→ 进 service;
        // service 内 assertCanManageUser(currentUser.role=ADMIN, target.role=SUPER_ADMIN) 返 false
        // → 抛 FORBIDDEN_ROLE_OPERATION(10101)。**业务护栏反向断言**:RBAC 通过不等于业务通过。
        const res = await callEndpoint(app, adminOpsAuth, ep, superTargetId);
        expectBizError(res, BizCode.FORBIDDEN_ROLE_OPERATION);
      },
    );
  });

  describe('SUPER_ADMIN 调 PATCH /:id/role { role: SUPER_ADMIN } → 10101(canChangeRole 业务护栏永禁升 SA)', () => {
    it('SUPER_ADMIN 调 PATCH /:id/role 把 USER 升为 SUPER_ADMIN → 10101', async () => {
      // SUPER_ADMIN 经 RbacService 短路通过(`user.role === SUPER_ADMIN`)→ 进 service;
      // canChangeRole 永禁升 SA(沿 users.policy.ts:49-52)→ 抛 FORBIDDEN_ROLE_OPERATION(10101)。
      // **业务护栏反向断言**:RBAC 短路不等于业务允许任意改角色。
      const res = await request(httpServer(app))
        .patch(`/api/users/${userTargetId}/role`)
        .set('Authorization', superAuth)
        .send({ role: Role.SUPER_ADMIN });

      expectBizError(res, BizCode.FORBIDDEN_ROLE_OPERATION);
    });
  });
});
