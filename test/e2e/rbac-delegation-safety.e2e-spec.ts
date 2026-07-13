import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, BindingStatus, PrincipalType, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { PROTECTED_ROLE_CODES } from '../../src/modules/permissions/protected-role-codes';
import { loginAs } from '../fixtures/auth.fixture';
import { grantOpsAdminToUser, seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const ROLE_BINDING_CODES = [
  'role-binding.read.record',
  'role-binding.create.record',
  'role-binding.update.record',
  'role-binding.delete.record',
] as const;

const PRIVILEGED_ROLE_CODES = ['rd-control-role', 'rd-reserved-role', 'ops-admin'] as const;
const BUSINESS_ROLE_CODE = 'rd-business-role';
const PREVIEW_PATH = '/api/admin/v1/role-bindings/preview';

describe('第一档安全收口:委派、控制面授码与受保护角色', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAdminAuth: string;
  let opsAdminAuth: string;
  let superAdminId: string;
  let sequence = 0;
  const roleIds = new Map<string, string>();

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const superAdmin = await createTestUser(app, { username: 'rd-su', role: Role.SUPER_ADMIN });
    const opsAdmin = await createTestUser(app, { username: 'rd-ops', role: Role.ADMIN });
    superAdminId = superAdmin.id;
    superAdminAuth = (await loginAs(app, 'rd-su')).authHeader;
    opsAdminAuth = (await loginAs(app, 'rd-ops')).authHeader;

    const seed = await seedRbacPermissionsAndOpsAdmin(app);
    roleIds.set('ops-admin', seed.opsAdminRoleId);

    for (const code of ROLE_BINDING_CODES) {
      const [module, action, resourceType] = code.split('.');
      await prisma.permission.upsert({
        where: { code },
        update: {},
        create: { code, module, action, resourceType },
      });
    }
    const roleBindingPermissions = await prisma.permission.findMany({
      where: { code: { in: [...ROLE_BINDING_CODES] } },
      select: { id: true },
    });
    await prisma.rolePermission.createMany({
      data: roleBindingPermissions.map((permission) => ({
        roleId: seed.opsAdminRoleId,
        permissionId: permission.id,
      })),
      skipDuplicates: true,
    });
    await grantOpsAdminToUser(app, opsAdmin.id, seed.opsAdminRoleId);

    const controlRole = await prisma.rbacRole.create({
      data: { code: 'rd-control-role', displayName: '控制面测试角色' },
      select: { id: true },
    });
    const reservedRole = await prisma.rbacRole.create({
      data: { code: 'rd-reserved-role', displayName: '保留码测试角色' },
      select: { id: true },
    });
    const businessRole = await prisma.rbacRole.create({
      data: { code: BUSINESS_ROLE_CODE, displayName: '业务测试角色' },
      select: { id: true },
    });
    roleIds.set('rd-control-role', controlRole.id);
    roleIds.set('rd-reserved-role', reservedRole.id);
    roleIds.set(BUSINESS_ROLE_CODE, businessRole.id);

    const rbacPermission = await prisma.permission.findUniqueOrThrow({
      where: { code: 'rbac.role.read' },
      select: { id: true },
    });
    const reservedPermission = await prisma.permission.findUniqueOrThrow({
      where: { code: 'user.update.role' },
      select: { id: true },
    });
    const businessPermission = await prisma.permission.create({
      data: {
        code: 'rd-business.manage.record',
        module: 'rd-business',
        action: 'manage',
        resourceType: 'record',
      },
      select: { id: true },
    });
    await prisma.rolePermission.createMany({
      data: [
        { roleId: controlRole.id, permissionId: rbacPermission.id },
        { roleId: reservedRole.id, permissionId: reservedPermission.id },
        { roleId: businessRole.id, permissionId: businessPermission.id },
      ],
    });

    for (const code of PROTECTED_ROLE_CODES) {
      const role = await prisma.rbacRole.upsert({
        where: { code },
        update: {},
        create: { code, displayName: `内置角色 ${code}` },
        select: { id: true },
      });
      roleIds.set(code, role.id);
    }
  });

  afterAll(async () => {
    await app.close();
  });

  function getRoleId(code: string): string {
    const id = roleIds.get(code);
    if (id === undefined) throw new Error(`missing test role: ${code}`);
    return id;
  }

  async function createTarget(prefix: string) {
    sequence += 1;
    return createTestUser(app, {
      username: `${prefix}-${sequence}`,
      role: Role.USER,
    });
  }

  function createBinding(auth: string, principalId: string, roleCode: string) {
    return request(httpServer(app))
      .post('/api/admin/v1/role-bindings')
      .set('Authorization', auth)
      .send({
        principalType: PrincipalType.USER,
        principalId,
        roleId: getRoleId(roleCode),
        scopeType: BindingScopeType.SELF,
      });
  }

  async function insertBinding(
    principalId: string,
    roleCode: string,
    status: BindingStatus,
    tenure?: { startedAt?: Date; endedAt?: Date },
    scopeType: BindingScopeType = BindingScopeType.SELF,
  ) {
    return prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId,
        roleId: getRoleId(roleCode),
        scopeType,
        status,
        startedAt: tenure?.startedAt,
        endedAt: tenure?.endedAt,
        createdByUserId: superAdminId,
      },
      select: { id: true },
    });
  }

  function preview(auth: string, principalId: string, roleCode: string) {
    return request(httpServer(app))
      .get(PREVIEW_PATH)
      .set('Authorization', auth)
      .query({
        principalType: PrincipalType.USER,
        principalId,
        roleId: getRoleId(roleCode),
        scopeType: BindingScopeType.SELF,
      });
  }

  function assignUserRole(auth: string, targetUserId: string, roleCode: string) {
    return request(httpServer(app))
      .post(`/api/system/v1/users/${targetUserId}/roles`)
      .set('Authorization', auth)
      .send({ roleCode });
  }

  function revokeUserRole(auth: string, targetUserId: string, roleCode: string) {
    return request(httpServer(app))
      .delete(`/api/system/v1/users/${targetUserId}/roles/${getRoleId(roleCode)}`)
      .set('Authorization', auth);
  }

  describe('D1:三类特权角色的全部委派入口', () => {
    it.each(PRIVILEGED_ROLE_CODES)('ops-admin bind %s → 30102', async (roleCode) => {
      const target = await createTarget('rd-bind-deny');
      expectBizError(
        await createBinding(opsAdminAuth, target.id, roleCode),
        BizCode.CANNOT_ASSIGN_HIGHER_ROLE,
      );
    });

    it.each(PRIVILEGED_ROLE_CODES)('ops-admin patch-reactivate %s → 30102', async (roleCode) => {
      const target = await createTarget('rd-patch-deny');
      const binding = await insertBinding(target.id, roleCode, BindingStatus.SUSPENDED);
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/role-bindings/${binding.id}`)
        .set('Authorization', opsAdminAuth)
        .send({ status: BindingStatus.ACTIVE });
      expectBizError(res, BizCode.CANNOT_ASSIGN_HIGHER_ROLE);
    });

    it.each(PRIVILEGED_ROLE_CODES)('ops-admin preview %s → valid=false/30102', async (roleCode) => {
      const target = await createTarget('rd-preview-deny');
      const res = await preview(opsAdminAuth, target.id, roleCode);
      expect(res.status).toBe(200);
      expect(res.body.data.valid).toBe(false);
      expect(res.body.data.conflicts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ bizCode: BizCode.CANNOT_ASSIGN_HIGHER_ROLE.code }),
        ]),
      );
    });

    it.each(PRIVILEGED_ROLE_CODES)('ops-admin user-roles assign %s → 30102', async (roleCode) => {
      const target = await createTarget('rd-assign-deny');
      expectBizError(
        await assignUserRole(opsAdminAuth, target.id, roleCode),
        BizCode.CANNOT_ASSIGN_HIGHER_ROLE,
      );
    });

    it.each(PRIVILEGED_ROLE_CODES)('ops-admin user-roles revoke %s → 30102', async (roleCode) => {
      const target = await createTarget('rd-revoke-deny');
      await insertBinding(
        target.id,
        roleCode,
        BindingStatus.ACTIVE,
        undefined,
        BindingScopeType.GLOBAL,
      );
      expectBizError(
        await revokeUserRole(opsAdminAuth, target.id, roleCode),
        BizCode.CANNOT_ASSIGN_HIGHER_ROLE,
      );
    });

    it.each(PRIVILEGED_ROLE_CODES)('SUPER_ADMIN 对 %s 的五入口全部放行', async (roleCode) => {
      const bindTarget = await createTarget('rd-su-bind');
      expect((await createBinding(superAdminAuth, bindTarget.id, roleCode)).status).toBe(201);

      const patchTarget = await createTarget('rd-su-patch');
      const suspended = await insertBinding(patchTarget.id, roleCode, BindingStatus.SUSPENDED);
      expect(
        (
          await request(httpServer(app))
            .patch(`/api/admin/v1/role-bindings/${suspended.id}`)
            .set('Authorization', superAdminAuth)
            .send({ status: BindingStatus.ACTIVE })
        ).status,
      ).toBe(200);

      const previewTarget = await createTarget('rd-su-preview');
      const previewRes = await preview(superAdminAuth, previewTarget.id, roleCode);
      expect(previewRes.status).toBe(200);
      expect(previewRes.body.data.valid).toBe(true);

      const assignTarget = await createTarget('rd-su-assign');
      expect((await assignUserRole(superAdminAuth, assignTarget.id, roleCode)).status).toBe(201);

      const revokeTarget = await createTarget('rd-su-revoke');
      await insertBinding(
        revokeTarget.id,
        roleCode,
        BindingStatus.ACTIVE,
        undefined,
        BindingScopeType.GLOBAL,
      );
      expect((await revokeUserRole(superAdminAuth, revokeTarget.id, roleCode)).status).toBe(200);
    });

    it('普通业务角色的五入口对 ops-admin 保持放行', async () => {
      const bindTarget = await createTarget('rd-biz-bind');
      expect((await createBinding(opsAdminAuth, bindTarget.id, BUSINESS_ROLE_CODE)).status).toBe(
        201,
      );

      const patchTarget = await createTarget('rd-biz-patch');
      const suspended = await insertBinding(
        patchTarget.id,
        BUSINESS_ROLE_CODE,
        BindingStatus.SUSPENDED,
      );
      expect(
        (
          await request(httpServer(app))
            .patch(`/api/admin/v1/role-bindings/${suspended.id}`)
            .set('Authorization', opsAdminAuth)
            .send({ status: BindingStatus.ACTIVE })
        ).status,
      ).toBe(200);

      const previewTarget = await createTarget('rd-biz-preview');
      expect(
        (await preview(opsAdminAuth, previewTarget.id, BUSINESS_ROLE_CODE)).body.data.valid,
      ).toBe(true);

      const assignTarget = await createTarget('rd-biz-assign');
      expect((await assignUserRole(opsAdminAuth, assignTarget.id, BUSINESS_ROLE_CODE)).status).toBe(
        201,
      );

      const revokeTarget = await createTarget('rd-biz-revoke');
      await insertBinding(
        revokeTarget.id,
        BUSINESS_ROLE_CODE,
        BindingStatus.ACTIVE,
        undefined,
        BindingScopeType.GLOBAL,
      );
      expect((await revokeUserRole(opsAdminAuth, revokeTarget.id, BUSINESS_ROLE_CODE)).status).toBe(
        200,
      );
    });

    it('特权绑定提前 startedAt / 延后 endedAt 均重跑委派闸；纯 note PATCH 不误伤', async () => {
      const earlierTarget = await createTarget('rd-earlier');
      const earlier = await insertBinding(
        earlierTarget.id,
        'rd-control-role',
        BindingStatus.ACTIVE,
        {
          startedAt: new Date('2030-01-01T00:00:00.000Z'),
        },
      );
      expectBizError(
        await request(httpServer(app))
          .patch(`/api/admin/v1/role-bindings/${earlier.id}`)
          .set('Authorization', opsAdminAuth)
          .send({ startedAt: '2029-01-01T00:00:00.000Z' }),
        BizCode.CANNOT_ASSIGN_HIGHER_ROLE,
      );

      const laterTarget = await createTarget('rd-later');
      const later = await insertBinding(laterTarget.id, 'rd-control-role', BindingStatus.ACTIVE, {
        startedAt: new Date('2028-01-01T00:00:00.000Z'),
        endedAt: new Date('2030-01-01T00:00:00.000Z'),
      });
      expectBizError(
        await request(httpServer(app))
          .patch(`/api/admin/v1/role-bindings/${later.id}`)
          .set('Authorization', opsAdminAuth)
          .send({ endedAt: '2031-01-01T00:00:00.000Z' }),
        BizCode.CANNOT_ASSIGN_HIGHER_ROLE,
      );

      const noteRes = await request(httpServer(app))
        .patch(`/api/admin/v1/role-bindings/${later.id}`)
        .set('Authorization', opsAdminAuth)
        .send({ note: 'metadata-only' });
      expect(noteRes.status).toBe(200);
    });
  });

  describe('D2:非 SUPER_ADMIN 不得授予控制面权限码', () => {
    it.each(['rbac.permission.read', 'role-binding.create.record'])(
      'ops-admin 授予 %s → 30103',
      async (permissionCode) => {
        const role = await prisma.rbacRole.create({
          data: { code: `rd-grant-deny-${sequence++}`, displayName: '授码拒绝测试角色' },
          select: { id: true },
        });
        expectBizError(
          await request(httpServer(app))
            .post(`/api/system/v1/roles/${role.id}/permissions`)
            .set('Authorization', opsAdminAuth)
            .send({ permissionCodes: [permissionCode] }),
          BizCode.PERMISSION_RESERVED_SUPER_ADMIN_ONLY,
        );
      },
    );

    it('SUPER_ADMIN 可授控制面码；ops-admin 授业务码不受影响', async () => {
      const saRole = await prisma.rbacRole.create({
        data: { code: 'rd-grant-sa', displayName: '超级管理员授码测试角色' },
        select: { id: true },
      });
      const saRes = await request(httpServer(app))
        .post(`/api/system/v1/roles/${saRole.id}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: ['rbac.permission.read', 'role-binding.create.record'] });
      expect(saRes.status).toBe(201);

      const businessRole = await prisma.rbacRole.create({
        data: { code: 'rd-grant-business', displayName: '业务授码测试角色' },
        select: { id: true },
      });
      const businessRes = await request(httpServer(app))
        .post(`/api/system/v1/roles/${businessRole.id}/permissions`)
        .set('Authorization', opsAdminAuth)
        .send({ permissionCodes: ['rd-business.manage.record'] });
      expect(businessRes.status).toBe(201);
    });
  });

  describe('D3:7 个内置角色禁止 API 删除', () => {
    it.each(PROTECTED_ROLE_CODES)('%s 即使 SUPER_ADMIN 删除也 → 30104', async (roleCode) => {
      const res = await request(httpServer(app))
        .delete(`/api/system/v1/roles/${getRoleId(roleCode)}`)
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.PROTECTED_ROLE_DELETE_FORBIDDEN);
    });

    it('自定义角色仍可删除', async () => {
      const custom = await prisma.rbacRole.create({
        data: { code: 'rd-delete-custom', displayName: '自定义可删角色' },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .delete(`/api/system/v1/roles/${custom.id}`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.code).toBe('rd-delete-custom');
    });
  });
});
