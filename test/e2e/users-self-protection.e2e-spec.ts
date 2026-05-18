import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { httpServer } from '../helpers/http-server';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { loginAs } from '../fixtures/auth.fixture';
import { grantOpsAdminToUser, seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 14.7.1 self-protection spec(5 用例)
// 覆盖 service 层 assertNotSelf 在 softDelete / updateRole / updateStatus(DISABLED) 的触发。
//
// service 顺序细节(P0-F PR-3B 后):
//   - 所有管理方法首句 assertCanOrThrow('user.*')(沿评审稿 §8.2)
//   - softDelete:assertCanOrThrow → assertNotSelf → assertCanManageUser
//   - updateRole:assertCanOrThrow → assertNotSelf → assertCanManageUser → canChangeRole
//   - updateStatus:assertCanOrThrow → assertCanManageUser → assertNotSelf(DISABLED)
//     → 故 ADMIN 自己改 DISABLED 实际是 10101(assertCanManageUser 先拒),不是 10102
//     这条不在本 spec 测,语义已被 14.6 role-boundary 覆盖。
//
// P0-F PR-3B:ADMIN 自删用例需 ops-admin grant(否则 RBAC 拒 30100,assertNotSelf 不触发)。
// SUPER_ADMIN 经 RbacService 短路通过,无需 grant。
describe('用户管理接口自我保护(assertNotSelf)', () => {
  let app: INestApplication;
  let opsAdminRoleId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    ({ opsAdminRoleId } = await seedRbacPermissionsAndOpsAdmin(app));
  });

  afterAll(async () => {
    await app.close();
  });

  it('SUPER_ADMIN 调 DELETE /:id 操作自己 → CANNOT_OPERATE_SELF', async () => {
    const a = await createTestUser(app, { username: 'spsuperdel1', role: Role.SUPER_ADMIN });
    const { authHeader } = await loginAs(app, 'spsuperdel1');

    const res = await request(httpServer(app))
      .delete(`/api/users/${a.id}`)
      .set('Authorization', authHeader);

    expectBizError(res, BizCode.CANNOT_OPERATE_SELF);
  });

  it('SUPER_ADMIN 改自己 status=DISABLED → CANNOT_OPERATE_SELF', async () => {
    const a = await createTestUser(app, { username: 'spsuperdis1', role: Role.SUPER_ADMIN });
    const { authHeader } = await loginAs(app, 'spsuperdis1');

    const res = await request(httpServer(app))
      .patch(`/api/users/${a.id}/status`)
      .set('Authorization', authHeader)
      .send({ status: 'DISABLED' });

    expectBizError(res, BizCode.CANNOT_OPERATE_SELF);
  });

  it('SUPER_ADMIN 改自己 role → CANNOT_OPERATE_SELF', async () => {
    const a = await createTestUser(app, { username: 'spsuperrole1', role: Role.SUPER_ADMIN });
    const { authHeader } = await loginAs(app, 'spsuperrole1');

    const res = await request(httpServer(app))
      .patch(`/api/users/${a.id}/role`)
      .set('Authorization', authHeader)
      .send({ role: Role.ADMIN });

    expectBizError(res, BizCode.CANNOT_OPERATE_SELF);
  });

  it('SUPER_ADMIN 改自己 status=ACTIVE → 200(自我保护只拦 DISABLED)', async () => {
    const a = await createTestUser(app, { username: 'spsuperact1', role: Role.SUPER_ADMIN });
    const { authHeader } = await loginAs(app, 'spsuperact1');

    const res = await request(httpServer(app))
      .patch(`/api/users/${a.id}/status`)
      .set('Authorization', authHeader)
      .send({ status: 'ACTIVE' });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.status).toBe('ACTIVE');
  });

  it('ADMIN+ops-admin 调 DELETE /:id 操作自己 → CANNOT_OPERATE_SELF(P0-F PR-3B:RBAC 通过后 assertNotSelf 先于 assertCanManageUser 触发)', async () => {
    const b = await createTestUser(app, { username: 'spadmindel1', role: Role.ADMIN });
    // P0-F PR-3B(2026-05-18):RBAC 入口判权先于 service 业务护栏;
    // 必须 grant ops-admin 使 assertCanOrThrow('user.delete.account') 通过,
    // 才能让 service.softDelete 内的 assertNotSelf 触发 10102 业务护栏(原 v1 走 Guard 通过)。
    await grantOpsAdminToUser(app, b.id, opsAdminRoleId);
    const { authHeader } = await loginAs(app, 'spadmindel1');

    const res = await request(httpServer(app))
      .delete(`/api/users/${b.id}`)
      .set('Authorization', authHeader);

    expectBizError(res, BizCode.CANNOT_OPERATE_SELF);
  });
});
