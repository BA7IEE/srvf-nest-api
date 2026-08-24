import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { RbacService } from '../../src/modules/permissions/rbac.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser, TEST_PASSWORD } from '../fixtures/users.fixture';
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

  /** 取该角色当前 permissionRevision —— `PUT` 必带,而它在本用例里会被推进两次。 */
  async function readPermissionRevision(): Promise<number> {
    const res = await request(httpServer(appB))
      .get(`/api/system/v1/roles/${roleId}/permissions`)
      .set('Authorization', superAdminAuthB);
    expect(res.status).toBe(200);
    return res.body.data.permissionRevision as number;
  }

  /**
   * 🔴 **本用例的靶子码 `rbac.permission.read` 是控制面码 ⇒ 增删它都属高风险差集,
   *    `PUT` 必须带 step-up proof,否则返 30112(403)。**
   *
   * ⚠️ 这一格比 `role-permissions.e2e-spec.ts` 里那处更隐蔽:那处是「撤一条控制面码」,
   *    一眼看得出危险;这里的写法是 `permissionCodes: []`,**字面上只是「清空」** ——
   *    但按冻结稿 §12.1「增加**或移除** CRITICAL 权限」,清空当然覆盖了被清掉的每一条高风险码。
   *    ⇒ **判高风险看的是差集,不是字面上的动作像不像危险操作。**
   *
   * ⚠️ 本 spec 被测的性质是「B 改了映射,A 下一请求立即看见」—— step-up 与它无关,
   *    proof 在这里纯粹是**为了让写请求能真的落库**的前置,不是新增断言。
   */
  async function mintStepUpToken(
    expectedRevision: number,
    permissionCodes: readonly string[],
  ): Promise<string> {
    const payloadHash = createHash('sha256')
      .update(JSON.stringify([...new Set<string>(permissionCodes)].sort()))
      .digest('base64url');
    const res = await request(httpServer(appB))
      .post('/api/auth/v1/step-up/password')
      .set('Authorization', superAdminAuthB)
      .send({
        action: 'RBAC_ROLE_PERMISSION_SET_REPLACE',
        password: TEST_PASSWORD,
        rolePermissionSet: { roleId, expectedRevision, payloadHash },
      });
    expect(res.status).toBe(200);
    return res.body.data.stepUpToken as string;
  }

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
    // ⚠️ P1-32 PR 8(2026-08-24):旧 `DELETE /:permissionId` 已退役,改用整集替换清空。
    //    被测性质不变 —— 「B 改了映射,A 下一请求立即看见」与用哪个动词改无关。
    const revisionBeforeRevoke = await readPermissionRevision();
    const revokePermission = await request(httpServer(appB))
      .put(`/api/system/v1/roles/${roleId}/permissions`)
      .set('Authorization', superAdminAuthB)
      .send({
        permissionCodes: [],
        expectedRevision: revisionBeforeRevoke,
        stepUpToken: await mintStepUpToken(revisionBeforeRevoke, []),
      });
    expect(revokePermission.status).toBe(200);

    const deniedAfterPermissionRevoke = await request(httpServer(appA))
      .get('/api/system/v1/permissions')
      .set('Authorization', targetAuthA);
    expectBizError(deniedAfterPermissionRevoke, BizCode.RBAC_FORBIDDEN);

    // B 恢复 role-permission，A 下一请求必须立即允许。
    // ⚠️ 同上:旧 `POST`(增量授权)已退役,改用整集替换写回同一条码。
    //    ⚠️ 状态码随之从 201 变 200 —— 那是 `PUT` 的既有契约,不是本条断言被放宽。
    const revisionBeforeGrant = await readPermissionRevision();
    const grantPermission = await request(httpServer(appB))
      .put(`/api/system/v1/roles/${roleId}/permissions`)
      .set('Authorization', superAdminAuthB)
      .send({
        permissionCodes: ['rbac.permission.read'],
        expectedRevision: revisionBeforeGrant,
        stepUpToken: await mintStepUpToken(revisionBeforeGrant, ['rbac.permission.read']),
      });
    expect(grantPermission.status).toBe(200);

    const allowedAfterPermissionGrant = await request(httpServer(appA))
      .get('/api/system/v1/permissions')
      .set('Authorization', targetAuthA);
    expect(allowedAfterPermissionGrant.status).toBe(200);
    expect(allowedAfterPermissionGrant.body.code).toBe(0);
  });
});
