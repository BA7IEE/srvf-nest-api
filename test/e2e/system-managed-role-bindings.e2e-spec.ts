import type { INestApplication } from '@nestjs/common';
import { BindingStatus, PrincipalType, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const ROLE_BINDINGS_PATH = '/api/admin/v1/role-bindings';

describe('system-managed role 通用入口禁写', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAdminAuth: string;
  let roleId: string;
  let assignTargetUserId: string;
  let revokeTargetUserId: string;
  let existingBindingId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    await createTestUser(app, { username: 'smr-su', role: Role.SUPER_ADMIN });
    assignTargetUserId = (
      await createTestUser(app, { username: 'smr-assign-target', role: Role.USER })
    ).id;
    revokeTargetUserId = (
      await createTestUser(app, { username: 'smr-revoke-target', role: Role.USER })
    ).id;
    superAdminAuth = (await loginAs(app, 'smr-su')).authHeader;

    roleId = (
      await prisma.rbacRole.create({
        data: { code: 'activity-owner', displayName: '活动负责人' },
        select: { id: true },
      })
    ).id;
    existingBindingId = (
      await prisma.roleBinding.create({
        data: {
          principalType: PrincipalType.USER,
          principalId: revokeTargetUserId,
          roleId,
          scopeType: 'GLOBAL',
          status: BindingStatus.ACTIVE,
          note: 'system:activity-responsibility:test-assignment',
        },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    await app.close();
  });

  const createPayload = () => ({
    principalType: 'USER',
    principalId: assignTargetUserId,
    roleId,
    scopeType: 'GLOBAL',
  });

  it('role-bindings create / preview / batch 均返回 34006 且零写入', async () => {
    const countBefore = await prisma.roleBinding.count();

    expectBizError(
      await request(httpServer(app))
        .post(ROLE_BINDINGS_PATH)
        .set('Authorization', superAdminAuth)
        .send(createPayload()),
      BizCode.ROLE_BINDING_SYSTEM_MANAGED_ROLE_FORBIDDEN,
    );

    const preview = await request(httpServer(app))
      .get(`${ROLE_BINDINGS_PATH}/preview`)
      .query(createPayload())
      .set('Authorization', superAdminAuth);
    expect(preview.status).toBe(200);
    expect(preview.body.data.valid).toBe(false);
    expect(preview.body.data.conflicts).toContainEqual({
      bizCode: BizCode.ROLE_BINDING_SYSTEM_MANAGED_ROLE_FORBIDDEN.code,
      message: BizCode.ROLE_BINDING_SYSTEM_MANAGED_ROLE_FORBIDDEN.message,
    });

    const batch = await request(httpServer(app))
      .post(`${ROLE_BINDINGS_PATH}/batch`)
      .set('Authorization', superAdminAuth)
      .send({ items: [createPayload()] });
    expect(batch.status).toBe(200);
    expect(batch.body.data.summary).toEqual({
      total: 1,
      ok: 0,
      blocked: 1,
      alreadyExists: 0,
    });
    expect(batch.body.data.items[0]).toMatchObject({
      outcome: 'blocked',
      bizCode: BizCode.ROLE_BINDING_SYSTEM_MANAGED_ROLE_FORBIDDEN.code,
    });

    expect(await prisma.roleBinding.count()).toBe(countBefore);
  });

  it('role-bindings update / delete 均返回 34006 且不改现存 binding', async () => {
    const before = await prisma.roleBinding.findUniqueOrThrow({ where: { id: existingBindingId } });

    expectBizError(
      await request(httpServer(app))
        .patch(`${ROLE_BINDINGS_PATH}/${existingBindingId}`)
        .set('Authorization', superAdminAuth)
        .send({ note: 'manual-change' }),
      BizCode.ROLE_BINDING_SYSTEM_MANAGED_ROLE_FORBIDDEN,
    );
    expectBizError(
      await request(httpServer(app))
        .delete(`${ROLE_BINDINGS_PATH}/${existingBindingId}`)
        .set('Authorization', superAdminAuth),
      BizCode.ROLE_BINDING_SYSTEM_MANAGED_ROLE_FORBIDDEN,
    );

    const after = await prisma.roleBinding.findUniqueOrThrow({ where: { id: existingBindingId } });
    expect(after.note).toBe(before.note);
    expect(after.status).toBe(before.status);
    expect(after.deletedAt).toBeNull();
  });

  it('legacy user-role assign / revoke 均返回 34006 且零写入', async () => {
    const countBefore = await prisma.roleBinding.count();

    expectBizError(
      await request(httpServer(app))
        .post(`/api/system/v1/users/${assignTargetUserId}/roles`)
        .set('Authorization', superAdminAuth)
        .send({ roleCode: 'activity-owner' }),
      BizCode.ROLE_BINDING_SYSTEM_MANAGED_ROLE_FORBIDDEN,
    );
    expectBizError(
      await request(httpServer(app))
        .delete(`/api/system/v1/users/${revokeTargetUserId}/roles/${roleId}`)
        .set('Authorization', superAdminAuth),
      BizCode.ROLE_BINDING_SYSTEM_MANAGED_ROLE_FORBIDDEN,
    );

    expect(await prisma.roleBinding.count()).toBe(countBefore);
    expect(
      await prisma.roleBinding.findFirst({
        where: {
          id: existingBindingId,
          status: BindingStatus.ACTIVE,
          deletedAt: null,
        },
      }),
    ).not.toBeNull();
  });
});
