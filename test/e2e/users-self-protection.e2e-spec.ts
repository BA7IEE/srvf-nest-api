import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { httpServer } from '../helpers/http-server';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 14.7.1 self-protection spec(5 用例)
// 覆盖 service 层 assertNotSelf 在 softDelete / updateRole / updateStatus(DISABLED) 的触发。
//
// service 顺序细节:
//   - softDelete:assertNotSelf 在最前
//   - updateRole:assertNotSelf 在最前
//   - updateStatus:仅 dto.status === DISABLED 时 assertNotSelf,且在 assertCanManageUser 之后
//     → 故 ADMIN 自己改 DISABLED 实际是 10101(assertCanManageUser 先拒),不是 10102
//     这条不在本 spec 测,语义已被 14.6 role-boundary 覆盖。
describe('用户管理接口自我保护(assertNotSelf)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
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

  it('ADMIN 调 DELETE /:id 操作自己 → CANNOT_OPERATE_SELF(softDelete 内 assertNotSelf 先于 assertCanManageUser)', async () => {
    const b = await createTestUser(app, { username: 'spadmindel1', role: Role.ADMIN });
    const { authHeader } = await loginAs(app, 'spadmindel1');

    const res = await request(httpServer(app))
      .delete(`/api/users/${b.id}`)
      .set('Authorization', authHeader);

    expectBizError(res, BizCode.CANNOT_OPERATE_SELF);
  });
});
