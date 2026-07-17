import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { RbacService } from '../../src/modules/permissions/rbac.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// D-RBAC 真实 PostgreSQL 多实例一致性行为锁。
//
// 本 spec 同一进程内启动两套独立 TestingModule/NestApplication/HTTP listener；两者只共享
// DATABASE_URL 指向的 PostgreSQL，不共享 RbacService 或 PrismaService provider 实例。
// A 先成功判权（若恢复旧 Map 会在 A 内形成 cache hit），B 再经真实 HTTP 写端点变更
// GLOBAL RoleBinding / RolePermission；A 的下一次 HTTP 请求必须立即读取 DB 当前事实。
//
// 该测试会杀死以下回归：恢复 per-process permission Map、写路径只清 B 本地 provider、
// RolePermission 变更后依赖提交后 invalidate 广播。
describe('RBAC multi-instance PostgreSQL consistency', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prismaA: PrismaService;
  let targetAuthA: string;
  let superAdminAuthB: string;
  let targetUserId: string;
  let roleId: string;
  let permissionId: string;

  beforeAll(async () => {
    appA = await createTestApp();
    appB = await createTestApp();
    await resetDb(appA);

    prismaA = appA.get(PrismaService);
    await createTestUser(appA, { username: 'rbac-mi-su', role: Role.SUPER_ADMIN });
    const target = await createTestUser(appA, {
      username: 'rbac-mi-target',
      role: Role.USER,
    });
    targetUserId = target.id;

    const permission = await prismaA.permission.create({
      data: {
        code: 'rbac.permission.read',
        module: 'rbac',
        action: 'permission',
        resourceType: 'read',
      },
      select: { id: true },
    });
    permissionId = permission.id;
    const role = await prismaA.rbacRole.create({
      data: { code: 'rbac-mi-reader', displayName: '多实例读取角色' },
      select: { id: true },
    });
    roleId = role.id;
    await prismaA.rolePermission.create({ data: { roleId, permissionId } });
    await prismaA.roleBinding.create({
      data: {
        principalType: 'USER',
        principalId: targetUserId,
        roleId,
        scopeType: 'GLOBAL',
        status: 'ACTIVE',
      },
    });

    targetAuthA = (await loginAs(appA, 'rbac-mi-target')).authHeader;
    superAdminAuthB = (await loginAs(appB, 'rbac-mi-su')).authHeader;
  });

  afterAll(async () => {
    await Promise.all([appA.close(), appB.close()]);
  });

  it('两套独立 provider 共库时,GLOBAL grant/revoke 与 RolePermission 变更在 A 下一请求即时收敛', async () => {
    expect(appA.get(RbacService)).not.toBe(appB.get(RbacService));
    expect(appA.get(PrismaService)).not.toBe(appB.get(PrismaService));
    expect(appA.getHttpServer()).not.toBe(appB.getHttpServer());

    // A 先成功判权；若代码恢复旧进程内 Map，此请求会把 allow 结果预热在 A。
    const warmup = await request(httpServer(appA))
      .get('/api/system/v1/permissions')
      .set('Authorization', targetAuthA);
    expect(warmup.status).toBe(200);
    expect(warmup.body.code).toBe(0);

    // B 撤销目标用户的 GLOBAL RoleBinding，A 下一请求必须立即拒绝。
    const revokeBinding = await request(httpServer(appB))
      .delete(`/api/system/v1/users/${targetUserId}/roles/${roleId}`)
      .set('Authorization', superAdminAuthB);
    expect(revokeBinding.status).toBe(200);

    const deniedAfterBindingRevoke = await request(httpServer(appA))
      .get('/api/system/v1/permissions')
      .set('Authorization', targetAuthA);
    expectBizError(deniedAfterBindingRevoke, BizCode.RBAC_FORBIDDEN);

    // B 重新授予同一角色，A 下一请求必须立即允许。
    const grantBinding = await request(httpServer(appB))
      .post(`/api/system/v1/users/${targetUserId}/roles`)
      .set('Authorization', superAdminAuthB)
      .send({ roleCode: 'rbac-mi-reader' });
    expect(grantBinding.status).toBe(201);

    const allowedAfterBindingGrant = await request(httpServer(appA))
      .get('/api/system/v1/permissions')
      .set('Authorization', targetAuthA);
    expect(allowedAfterBindingGrant.status).toBe(200);

    // B 撤销 role-permission，A 下一请求必须立即拒绝。
    const revokePermission = await request(httpServer(appB))
      .delete(`/api/system/v1/roles/${roleId}/permissions/${permissionId}`)
      .set('Authorization', superAdminAuthB);
    expect(revokePermission.status).toBe(200);

    const deniedAfterPermissionRevoke = await request(httpServer(appA))
      .get('/api/system/v1/permissions')
      .set('Authorization', targetAuthA);
    expectBizError(deniedAfterPermissionRevoke, BizCode.RBAC_FORBIDDEN);

    // B 恢复 role-permission，A 下一请求必须立即允许。
    const grantPermission = await request(httpServer(appB))
      .post(`/api/system/v1/roles/${roleId}/permissions`)
      .set('Authorization', superAdminAuthB)
      .send({ permissionCodes: ['rbac.permission.read'] });
    expect(grantPermission.status).toBe(201);

    const allowedAfterPermissionGrant = await request(httpServer(appA))
      .get('/api/system/v1/permissions')
      .set('Authorization', targetAuthA);
    expect(allowedAfterPermissionGrant.status).toBe(200);
    expect(allowedAfterPermissionGrant.body.code).toBe(0);
  });
});
