import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { RbacService } from '../../src/modules/permissions/rbac.service';
import { loginAs } from '../fixtures/auth.fixture';
import {
  grantOpsAdminToUser,
  revokeOpsAdminFromUser,
  seedRbacPermissionsAndOpsAdmin,
} from '../fixtures/rbac.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// V2.x C-6 RBAC 实施 PR #4:RolePermission 关联表 e2e。
// 沿 D7 v1.1 §5.1 端点 10-11 + 用户拍板。
//
// 覆盖(沿任务 #9):
// - 批量授权(成功 / 含已存在的幂等 / role 不存在 / role 已软删 / permission 不存在)
// - 撤权(成功 / 关系不存在 30011 / role 不存在 / role 已软删 / permission 不存在)
// - role detail 返回真实 permissions
// - 权限边界(未登录 / USER 403 / ADMIN 允许)
// - DB-backed permission resolution 在 role-permission grant/revoke/role soft-delete 后下一请求收敛
//
// 不覆盖(超本 PR 范围):
// - 完整 rbac.can() 判权矩阵(由 rbac.service.spec.ts / RBAC 相关 e2e 覆盖)
// - reload 接口(留 PR #7)
// - UserRole(留 PR #5)
// - audit_logs 集成(留后续审计批次)

describe('role-permissions 模块', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let rbac: RbacService;
  let superAdminAuth: string;
  let adminAuth: string;
  let userAuth: string;
  let rpOpsAdminRoleId: string;
  let rpAdminUserId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    rbac = app.get(RbacService);

    await createTestUser(app, { username: 'rp-su', role: Role.SUPER_ADMIN });
    const adm = await createTestUser(app, { username: 'rp-adm', role: Role.ADMIN });
    rpAdminUserId = adm.id;
    await createTestUser(app, { username: 'rp-user', role: Role.USER });

    superAdminAuth = (await loginAs(app, 'rp-su')).authHeader;
    adminAuth = (await loginAs(app, 'rp-adm')).authHeader;
    userAuth = (await loginAs(app, 'rp-user')).authHeader;

    // P0-F PR-1:resetDb 已清 RBAC 表;e2e 自行 seed 14 条 rbac.* + ops-admin。
    const seed = await seedRbacPermissionsAndOpsAdmin(app);
    rpOpsAdminRoleId = seed.opsAdminRoleId;
  });

  afterAll(async () => {
    await app.close();
  });

  // 辅助:创建测试用 role + N 个 permission
  async function setupRoleAndPermissions(opts: {
    roleCode: string;
    permCodes: string[];
    roleDeletedAt?: Date | null;
  }) {
    const role = await prisma.rbacRole.create({
      data: {
        code: opts.roleCode,
        displayName: opts.roleCode,
        deletedAt: opts.roleDeletedAt ?? null,
      },
      select: { id: true },
    });
    const perms = [];
    for (const code of opts.permCodes) {
      const p = await prisma.permission.create({
        data: {
          code,
          module: code.split('.')[0],
          action: code.split('.')[1],
          resourceType: code.split('.')[2] ?? '',
        },
        select: { id: true, code: true },
      });
      perms.push(p);
    }
    return { roleId: role.id, perms };
  }

  // ============ 权限边界 ============

  describe('权限边界', () => {
    it('未登录 POST → 401', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/roles/nonexistent000000000000000000/permissions')
        .send({ permissionCodes: ['x.y.z'] });
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('USER POST → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/roles/nonexistent000000000000000000/permissions')
        .set('Authorization', userAuth)
        .send({ permissionCodes: ['x.y.z'] });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER DELETE → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .delete(
          '/api/system/v1/roles/nonexistent000000000000000000/permissions/abc-perm-00000000000000000000',
        )
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    // P0-F PR-1(2026-05-18):v1 ADMIN 不再自动放行 RBAC 元接口;必须持 RBAC 角色。
    it('ADMIN 默认无 RBAC 权限 → 30100 RBAC_FORBIDDEN', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'admin-no-rbac-rp',
        permCodes: ['adm.norbac.a'],
      });
      const res = await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', adminAuth)
        .send({ permissionCodes: [perms[0].code] });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    // P0-F PR-1:ADMIN 持 ops-admin 后能通过(seed 14 条 rbac.* 含 rbac.role-permission.create)。
    it('ADMIN 持 ops-admin 角色 → POST 201', async () => {
      await grantOpsAdminToUser(app, rpAdminUserId, rpOpsAdminRoleId);
      try {
        const { roleId, perms } = await setupRoleAndPermissions({
          roleCode: 'admin-with-ops-rp',
          permCodes: ['adm.ops.b'],
        });
        const res = await request(httpServer(app))
          .post(`/api/system/v1/roles/${roleId}/permissions`)
          .set('Authorization', adminAuth)
          .send({ permissionCodes: [perms[0].code] });
        expect(res.status).toBe(201);
      } finally {
        await revokeOpsAdminFromUser(app, rpAdminUserId, rpOpsAdminRoleId);
      }
    });
  });

  // ============ 批量授权 ============

  describe('POST /api/system/v1/roles/:id/permissions', () => {
    it('批量授权 → 200,detail.permissions 含全部新加', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'assign-multi',
        permCodes: ['multi.a.r1', 'multi.b.r2', 'multi.c.r3'],
      });

      const res = await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: perms.map((p) => p.code) });

      expect(res.status).toBe(201);
      expect(res.body.code).toBe(0);
      expect(res.body.data.permissions).toHaveLength(3);
      const returnedCodes = res.body.data.permissions.map((p: { code: string }) => p.code);
      expect(returnedCodes).toEqual(
        expect.arrayContaining(['multi.a.r1', 'multi.b.r2', 'multi.c.r3']),
      );
    });

    it('重复授权幂等成功 → 200,total 仍为去重后的数量', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'assign-idempotent',
        permCodes: ['idem.a.x'],
      });

      // 第一次授权
      const first = await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: [perms[0].code] });
      expect(first.status).toBe(201);
      expect(first.body.data.permissions).toHaveLength(1);

      // 第二次重复授权(同一 code)— 幂等成功,不抛 30010,permissions 仍 1 条
      const second = await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: [perms[0].code] });
      expect(second.status).toBe(201);
      expect(second.body.data.permissions).toHaveLength(1);

      // DB 中实际 RolePermission 行数也应是 1(skipDuplicates)
      const dbCount = await prisma.rolePermission.count({ where: { roleId } });
      expect(dbCount).toBe(1);
    });

    it('部分重复部分新增 → 200,只新增不存在的关系', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'assign-partial',
        permCodes: ['part.a.x', 'part.b.y', 'part.c.z'],
      });

      // 先授 a + b
      await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: ['part.a.x', 'part.b.y'] });

      // 再发送 a + b + c(含 2 个已存在 + 1 个新增)
      const res = await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: perms.map((p) => p.code) });
      expect(res.status).toBe(201);
      expect(res.body.data.permissions).toHaveLength(3);
    });

    it('入参中包含重复 code → 200,Service 内部 dedup', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'assign-input-dup',
        permCodes: ['dup.x.x'],
      });
      const res = await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: [perms[0].code, perms[0].code, perms[0].code] });
      expect(res.status).toBe(201);
      expect(res.body.data.permissions).toHaveLength(1);
    });

    it('role 不存在 → 30003', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/roles/nonexistent000000000000000000/permissions')
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: ['any.x.y'] });
      expectBizError(res, BizCode.ROLE_NOT_FOUND);
    });

    it('role 已软删 → 30005', async () => {
      const { roleId } = await setupRoleAndPermissions({
        roleCode: 'assign-softdel',
        permCodes: [],
        roleDeletedAt: new Date(),
      });
      const res = await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: ['x.y.z'] });
      expectBizError(res, BizCode.ROLE_DELETED);
    });

    it('permission code 不存在 → 30001,整批拒绝', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'assign-perm-missing',
        permCodes: ['exist.a.x'],
      });
      const res = await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: [perms[0].code, 'does.not.exist'] });
      expectBizError(res, BizCode.PERMISSION_NOT_FOUND);

      // 确认部分授权也未发生(整批拒绝)
      const dbCount = await prisma.rolePermission.count({ where: { roleId } });
      expect(dbCount).toBe(0);
    });

    it('空数组 → 400(DTO @ArrayMinSize(1))', async () => {
      const { roleId } = await setupRoleAndPermissions({
        roleCode: 'assign-empty',
        permCodes: [],
      });
      const res = await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: [] });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });
  });

  // ============ 撤权 ============

  describe('DELETE /api/system/v1/roles/:id/permissions/:permissionId', () => {
    it('撤权 → 200,detail.permissions 移除指定项', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'revoke-success',
        permCodes: ['rev.a.x', 'rev.b.y'],
      });

      // 先授 2 个
      await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: ['rev.a.x', 'rev.b.y'] });

      // 撤 a
      const res = await request(httpServer(app))
        .delete(`/api/system/v1/roles/${roleId}/permissions/${perms[0].id}`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.permissions).toHaveLength(1);
      expect(res.body.data.permissions[0].code).toBe('rev.b.y');
    });

    it('关系不存在 → 30011 ROLE_PERMISSION_NOT_FOUND', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'revoke-no-relation',
        permCodes: ['norel.a.x'],
      });
      // role 和 permission 都存在,但没建过关系
      const res = await request(httpServer(app))
        .delete(`/api/system/v1/roles/${roleId}/permissions/${perms[0].id}`)
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.ROLE_PERMISSION_NOT_FOUND);
    });

    it('role 不存在 → 30003', async () => {
      const perm = await prisma.permission.create({
        data: { code: 'rev.norole.x', module: 'rev', action: 'norole', resourceType: 'x' },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .delete(`/api/system/v1/roles/nonexistent000000000000000000/permissions/${perm.id}`)
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.ROLE_NOT_FOUND);
    });

    it('role 已软删 → 30005', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'revoke-softdel-role',
        permCodes: ['rsdr.a.x'],
        roleDeletedAt: new Date(),
      });
      const res = await request(httpServer(app))
        .delete(`/api/system/v1/roles/${roleId}/permissions/${perms[0].id}`)
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.ROLE_DELETED);
    });

    it('permission 不存在 → 30001', async () => {
      const { roleId } = await setupRoleAndPermissions({
        roleCode: 'revoke-no-perm',
        permCodes: [],
      });
      const res = await request(httpServer(app))
        .delete(`/api/system/v1/roles/${roleId}/permissions/missing000000000000000000000`)
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.PERMISSION_NOT_FOUND);
    });
  });

  // ============ F1 分级闸:SA-only 保留码 ============
  // #399 F1:assign() 原先只判 rbac.role-permission.create,未阻止持 ops-admin 者把
  // SA-only 保留码(seed 有意不绑 biz-admin/ops-admin)自授给任意角色 → 间接获 SA-only 能力。
  describe('F1 分级闸:SA-only 保留码不可被非 SUPER_ADMIN 分配', () => {
    it('ops-admin 分配保留码 → 30103,且整批不写入(连同批普通码)', async () => {
      await grantOpsAdminToUser(app, rpAdminUserId, rpOpsAdminRoleId);
      try {
        const { roleId } = await setupRoleAndPermissions({
          roleCode: 'f1-ops-reserved',
          permCodes: ['f1.normal.ok'],
        });
        // 保留码 Permission 真实存在(模拟 seed),证明闸早于存在性查询、不退化成 30001。
        // upsert:rbac.fixture 可能已 seed 部分保留码,避免唯一冲突。
        await prisma.permission.upsert({
          where: { code: 'member.delete.record' },
          update: {},
          create: {
            code: 'member.delete.record',
            module: 'member',
            action: 'delete',
            resourceType: 'record',
          },
        });
        const res = await request(httpServer(app))
          .post(`/api/system/v1/roles/${roleId}/permissions`)
          .set('Authorization', adminAuth)
          .send({ permissionCodes: ['f1.normal.ok', 'member.delete.record'] });
        expectBizError(res, BizCode.PERMISSION_RESERVED_SUPER_ADMIN_ONLY);

        // 整批拒绝:连同批的普通码也未写入
        const dbCount = await prisma.rolePermission.count({ where: { roleId } });
        expect(dbCount).toBe(0);
      } finally {
        await revokeOpsAdminFromUser(app, rpAdminUserId, rpOpsAdminRoleId);
      }
    });

    it('ops-admin 分配保留码(即便该码尚未 seed)→ 仍 30103(fail-close,不泄漏存在性)', async () => {
      await grantOpsAdminToUser(app, rpAdminUserId, rpOpsAdminRoleId);
      try {
        const { roleId } = await setupRoleAndPermissions({
          roleCode: 'f1-ops-reserved-unseeded',
          permCodes: [],
        });
        // 不创建 user.update.role Permission;闸在字符串层拦截,先于 findMany
        const res = await request(httpServer(app))
          .post(`/api/system/v1/roles/${roleId}/permissions`)
          .set('Authorization', adminAuth)
          .send({ permissionCodes: ['user.update.role'] });
        expectBizError(res, BizCode.PERMISSION_RESERVED_SUPER_ADMIN_ONLY);
      } finally {
        await revokeOpsAdminFromUser(app, rpAdminUserId, rpOpsAdminRoleId);
      }
    });

    // P1-32 PR 3a(2026-08-23)**行为反转**:此前这条断言的是「SA 短路放行 → 201」。
    // 现在保留码在授码侧对 SUPER_ADMIN 也拒(30109)—— 把保留码写进某角色的
    // role_permissions,就是让**持有该角色的非 SA** 永久拥有 SA-only 能力,
    // 由谁按下按钮不改变结果。SA 依然能用 SA 身份直接做那些操作(走身份短路,
    // 根本不查 role_permissions)。
    // ⚠️ 收紧**只覆盖那 7 条保留码**;`rbac.*` / `role-binding.*` 前缀族对 SA 仍放行,
    //    对照用例见 rbac-delegation-safety.e2e「SUPER_ADMIN 可授控制面前缀族码」。
    it('SUPER_ADMIN 分配同一保留码 → 30109(保留码不得沉淀成角色常驻权限)', async () => {
      const { roleId } = await setupRoleAndPermissions({
        roleCode: 'f1-su-reserved',
        permCodes: [],
      });
      // upsert:user.update.role 已由 rbac.fixture seed,避免唯一冲突
      await prisma.permission.upsert({
        where: { code: 'user.update.role' },
        update: {},
        create: {
          code: 'user.update.role',
          module: 'user',
          action: 'update',
          resourceType: 'role',
        },
      });
      const res = await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: ['user.update.role'] });
      expectBizError(res, BizCode.RESERVED_PERMISSION_NOT_ROLE_GRANTABLE);

      // 拒绝 = 一条都没写进去(闸在事务之前)
      const written = await prisma.rolePermission.count({ where: { roleId } });
      expect(written).toBe(0);
    });

    // 🔴 反向用例:闸只认「控制面码」这一维,不是「SA 干什么都拒」。
    //    少了它,一个「assign 一律拒绝」的实现也会让上面几条全绿。
    it('SUPER_ADMIN 分配普通码 → 201(授码侧的收紧不误伤正常配置)', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'f1-su-normal',
        permCodes: ['f1.su.plain'],
      });
      const res = await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: perms.map((p) => p.code) });
      expect(res.status).toBe(201);
      const codes = res.body.data.permissions.map((p: { code: string }) => p.code);
      expect(codes).toEqual(['f1.su.plain']);
    });

    it('ops-admin 分配纯普通码 → 201(闸不误伤非保留码)', async () => {
      await grantOpsAdminToUser(app, rpAdminUserId, rpOpsAdminRoleId);
      try {
        const { roleId, perms } = await setupRoleAndPermissions({
          roleCode: 'f1-ops-normal',
          permCodes: ['f1.plain.a', 'f1.plain.b'],
        });
        const res = await request(httpServer(app))
          .post(`/api/system/v1/roles/${roleId}/permissions`)
          .set('Authorization', adminAuth)
          .send({ permissionCodes: perms.map((p) => p.code) });
        expect(res.status).toBe(201);
        expect(res.body.data.permissions).toHaveLength(2);
      } finally {
        await revokeOpsAdminFromUser(app, rpAdminUserId, rpOpsAdminRoleId);
      }
    });
  });

  // E-B2(第六轮全仓评审,2026-08-21):**授码有闸、撤码没有** —— 控制面策略不对称。
  // revoke() 此前只查三件事:`rbac.role-permission.delete` 权限 / 角色存在且未软删 / 绑定存在,
  // **一个控制面判定都没有**。于是持 `rbac.role-permission.delete` 的 ops-admin 授不了控制面码
  // (F1 那道闸挡着),**却撤得掉** —— 包括把某个角色的 `rbac.*` / `role-binding.*` 权限一路撤空。
  // 与 F1 用保留集成员(member.delete.record / user.update.role)不同,这里刻意取 `rbac.*` 前缀码,
  // 把 isControlPlanePermissionCode() 的**另一半**定义域也钉在行为面上。
  //
  // 结构面(「将来新增的写方法也必须挂闸」)由
  // src/modules/permissions/role-permissions-control-plane-gate.spec.ts 动态判据守;这里守行为。
  describe('E-B2 分级闸:控制面码不可被非 SUPER_ADMIN 撤销(与 assign 对称)', () => {
    const CONTROL_PLANE_CODE = 'rbac.role.read'; // 前缀型控制面码,由 rbac.fixture seed

    async function controlPlanePermissionId(): Promise<string> {
      const perm = await prisma.permission.findUnique({
        where: { code: CONTROL_PLANE_CODE },
        select: { id: true },
      });
      expect(perm).not.toBeNull();
      return (perm as { id: string }).id;
    }

    // 🔴 这条**不能省**。只验「被拒」的话,一个「一律拒绝」的实现也会全绿 ——
    //    那不是修洞,那是把 ops-admin 的 rbac.role-permission.delete 整个废掉。
    it('ops-admin 撤销普通码 → 200(闸不误伤正常运维)', async () => {
      await grantOpsAdminToUser(app, rpAdminUserId, rpOpsAdminRoleId);
      try {
        const { roleId, perms } = await setupRoleAndPermissions({
          roleCode: 'eb2-ops-normal',
          permCodes: ['eb2.plain.a', 'eb2.plain.b'],
        });
        await request(httpServer(app))
          .post(`/api/system/v1/roles/${roleId}/permissions`)
          .set('Authorization', superAdminAuth)
          .send({ permissionCodes: ['eb2.plain.a', 'eb2.plain.b'] });

        const res = await request(httpServer(app))
          .delete(`/api/system/v1/roles/${roleId}/permissions/${perms[0].id}`)
          .set('Authorization', adminAuth);
        expect(res.status).toBe(200);
        expect(res.body.data.permissions).toHaveLength(1);
        expect(res.body.data.permissions[0].code).toBe('eb2.plain.b');

        // 真删了,不是「返 200 但没动」
        const remaining = await prisma.rolePermission.count({ where: { roleId } });
        expect(remaining).toBe(1);
      } finally {
        await revokeOpsAdminFromUser(app, rpAdminUserId, rpOpsAdminRoleId);
      }
    });

    it('ops-admin 撤销控制面码 → 30103,且绑定原样还在', async () => {
      await grantOpsAdminToUser(app, rpAdminUserId, rpOpsAdminRoleId);
      try {
        const { roleId } = await setupRoleAndPermissions({
          roleCode: 'eb2-ops-control-plane',
          permCodes: [],
        });
        const permissionId = await controlPlanePermissionId();
        // 由 SUPER_ADMIN 先授上(SA 短路放行),制造一条「可撤」的真实绑定
        const granted = await request(httpServer(app))
          .post(`/api/system/v1/roles/${roleId}/permissions`)
          .set('Authorization', superAdminAuth)
          .send({ permissionCodes: [CONTROL_PLANE_CODE] });
        expect(granted.status).toBe(201);

        const res = await request(httpServer(app))
          .delete(`/api/system/v1/roles/${roleId}/permissions/${permissionId}`)
          .set('Authorization', adminAuth);
        expectBizError(res, BizCode.PERMISSION_RESERVED_SUPER_ADMIN_ONLY);

        // 拒绝 = 什么都没删(闸在事务之前,不存在「删一半」)
        const still = await prisma.rolePermission.findUnique({
          where: { roleId_permissionId: { roleId, permissionId } },
          select: { id: true },
        });
        expect(still).not.toBeNull();
      } finally {
        await revokeOpsAdminFromUser(app, rpAdminUserId, rpOpsAdminRoleId);
      }
    });

    it('SUPER_ADMIN 撤销同一控制面码 → 200(短路语义不变)', async () => {
      const { roleId } = await setupRoleAndPermissions({
        roleCode: 'eb2-su-control-plane',
        permCodes: [],
      });
      const permissionId = await controlPlanePermissionId();
      const granted = await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: [CONTROL_PLANE_CODE] });
      expect(granted.status).toBe(201);

      const res = await request(httpServer(app))
        .delete(`/api/system/v1/roles/${roleId}/permissions/${permissionId}`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.permissions).toHaveLength(0);
    });
  });

  // ============ role detail 真实 permissions 填充 ============

  describe('GET /api/system/v1/roles/:id detail 返回真实 permissions(端到端)', () => {
    it('授权后 GET role detail → permissions 数组填充正确', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'detail-real-fill',
        permCodes: ['drf.a.x', 'drf.b.y'],
      });

      // 用 POST 接口授权(走 service 完整路径)
      await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: perms.map((p) => p.code) });

      // GET detail 验证
      const detailRes = await request(httpServer(app))
        .get(`/api/system/v1/roles/${roleId}`)
        .set('Authorization', superAdminAuth);
      expect(detailRes.status).toBe(200);
      expect(detailRes.body.data.permissions).toHaveLength(2);
      const detailCodes = detailRes.body.data.permissions.map((p: { code: string }) => p.code);
      expect(detailCodes).toEqual(expect.arrayContaining(['drf.a.x', 'drf.b.y']));
    });
  });

  // ============ DB-backed permission resolution ============

  describe('DB-backed permission resolution', () => {
    async function createBoundUser(username: string, roleId: string) {
      const user = await createTestUser(app, { username, role: Role.USER });
      await prisma.roleBinding.create({
        data: {
          principalType: 'USER',
          principalId: user.id,
          roleId,
          scopeType: 'GLOBAL',
          status: 'ACTIVE',
        },
      });
      return user;
    }

    it('同一 user 每次解析都查询当前 DB 事实', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'db-direct-read',
        permCodes: ['db.direct.read'],
      });
      const user = await createBoundUser('rp-db-direct', roleId);
      await expect(rbac.getUserPermissionCodes(user.id)).resolves.toEqual(new Set());

      await prisma.rolePermission.create({
        data: { roleId, permissionId: perms[0].id },
      });

      await expect(rbac.getUserPermissionCodes(user.id)).resolves.toEqual(
        new Set(['db.direct.read']),
      );
    });

    it('POST 授权后持有者下一次解析立即获得权限', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'db-visible-post',
        permCodes: ['db.post.visible'],
      });
      const user = await createBoundUser('rp-db-post', roleId);
      await expect(rbac.getUserPermissionCodes(user.id)).resolves.toEqual(new Set());

      await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: [perms[0].code] });

      await expect(rbac.getUserPermissionCodes(user.id)).resolves.toEqual(
        new Set(['db.post.visible']),
      );
    });

    it('DELETE 撤权后持有者下一次解析立即失去权限', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'db-visible-delete',
        permCodes: ['db.delete.visible'],
      });
      await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: [perms[0].code] });
      const user = await createBoundUser('rp-db-delete', roleId);
      await expect(rbac.getUserPermissionCodes(user.id)).resolves.toEqual(
        new Set(['db.delete.visible']),
      );

      await request(httpServer(app))
        .delete(`/api/system/v1/roles/${roleId}/permissions/${perms[0].id}`)
        .set('Authorization', superAdminAuth);

      await expect(rbac.getUserPermissionCodes(user.id)).resolves.toEqual(new Set());
    });

    it('role 软删后持有者下一次解析立即忽略该角色', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'db-role-soft-delete',
        permCodes: ['db.role.deleted'],
      });
      await prisma.rolePermission.create({
        data: { roleId, permissionId: perms[0].id },
      });
      const user = await createBoundUser('rp-db-role-delete', roleId);
      await expect(rbac.getUserPermissionCodes(user.id)).resolves.toEqual(
        new Set(['db.role.deleted']),
      );

      await prisma.rbacRole.update({ where: { id: roleId }, data: { deletedAt: new Date() } });

      await expect(rbac.getUserPermissionCodes(user.id)).resolves.toEqual(new Set());
    });
  });
  // ══════════════════════════════════════════════════════════════════════════
  // P1-32 PR 4a(2026-08-23):PUT 整集替换 + permissionRevision 乐观并发
  //
  // 本组守**行为面**;结构面(「新增写方法必须挂闸」「三条写路径全部经同一条原语」)
  // 由 src/modules/permissions/role-permissions-control-plane-gate.spec.ts 的静态判据守。
  // **真并发**(两条真连接 + 屏障)另起一份:test/e2e/role-permissions-replace-concurrency.e2e-spec.ts
  //  —— 行锁与事务隔离在单进程顺序用例里根本不存在,放这里等于没测。
  // ══════════════════════════════════════════════════════════════════════════
  describe('PUT /api/system/v1/roles/:id/permissions(整集替换)', () => {
    /** 取该角色当前权限码**集合**(比集合不比计数:计数相等会掩盖内容互换)。 */
    async function codeSetOf(roleId: string): Promise<Set<string>> {
      const rows = await prisma.rolePermission.findMany({
        where: { roleId },
        select: { permission: { select: { code: true } } },
      });
      return new Set(rows.map((r) => r.permission.code));
    }

    async function revisionOf(roleId: string): Promise<number> {
      const row = await prisma.rbacRole.findUniqueOrThrow({
        where: { id: roleId },
        select: { permissionRevision: true },
      });
      return row.permissionRevision;
    }

    async function auditCountOf(roleId: string): Promise<number> {
      return prisma.auditLog.count({
        where: { resourceType: 'role_permission', resourceId: roleId },
      });
    }

    function putAs(auth: string, roleId: string, body: Record<string, unknown>) {
      return request(httpServer(app))
        .put(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', auth)
        .send(body);
    }

    // ---------- 版本号本身 ----------

    it('新建角色的 permissionRevision 从 0 起,且出现在 detail 响应里', async () => {
      const { roleId } = await setupRoleAndPermissions({ roleCode: 'rev-initial', permCodes: [] });
      expect(await revisionOf(roleId)).toBe(0);

      const detail = await request(httpServer(app))
        .get(`/api/system/v1/roles/${roleId}`)
        .set('Authorization', superAdminAuth);
      expect(detail.status).toBe(200);
      expect(detail.body.data.permissionRevision).toBe(0);
    });

    // ---------- 替换语义 ----------

    it('替换 {a,b} → {b,c}:结果**恰好**是 {b,c},revision +1', async () => {
      const { roleId } = await setupRoleAndPermissions({
        roleCode: 'put-swap',
        permCodes: ['put.a.x', 'put.b.y', 'put.c.z'],
      });
      await putAs(superAdminAuth, roleId, {
        permissionCodes: ['put.a.x', 'put.b.y'],
        expectedRevision: 0,
      });
      expect(await codeSetOf(roleId)).toEqual(new Set(['put.a.x', 'put.b.y']));
      expect(await revisionOf(roleId)).toBe(1);

      const res = await putAs(superAdminAuth, roleId, {
        permissionCodes: ['put.b.y', 'put.c.z'],
        expectedRevision: 1,
      });
      expect(res.status).toBe(200);
      // 出参与库内必须一致,且都是**目标集合**而非并集(并集 = 没在删)
      const returned = (res.body.data.permissions as Array<{ code: string }>).map((p) => p.code);
      expect(new Set(returned)).toEqual(new Set(['put.b.y', 'put.c.z']));
      expect(await codeSetOf(roleId)).toEqual(new Set(['put.b.y', 'put.c.z']));
      expect(res.body.data.permissionRevision).toBe(2);
      expect(await revisionOf(roleId)).toBe(2);
    });

    it('替换成 [] → 清空,revision +1(整集替换必须允许空目标集)', async () => {
      const { roleId } = await setupRoleAndPermissions({
        roleCode: 'put-clear',
        permCodes: ['put.clear.a'],
      });
      await putAs(superAdminAuth, roleId, {
        permissionCodes: ['put.clear.a'],
        expectedRevision: 0,
      });
      const res = await putAs(superAdminAuth, roleId, {
        permissionCodes: [],
        expectedRevision: 1,
      });
      expect(res.status).toBe(200);
      expect(res.body.data.permissions).toEqual([]);
      expect(await codeSetOf(roleId)).toEqual(new Set());
      expect(await revisionOf(roleId)).toBe(2);
    });

    // ---------- no-op:比集合,不比计数 ----------

    it('no-op:目标集合与现状相同(顺序不同)→ 不写、不 +1、不产生 audit', async () => {
      const { roleId } = await setupRoleAndPermissions({
        roleCode: 'put-noop-same',
        permCodes: ['noop.a.x', 'noop.b.y'],
      });
      await putAs(superAdminAuth, roleId, {
        permissionCodes: ['noop.a.x', 'noop.b.y'],
        expectedRevision: 0,
      });
      const revBefore = await revisionOf(roleId);
      const auditBefore = await auditCountOf(roleId);
      const rowsBefore = await prisma.rolePermission.findMany({
        where: { roleId },
        select: { id: true },
        orderBy: { id: 'asc' },
      });

      // 同一集合,**顺序颠倒** —— 集合相同即空转
      const res = await putAs(superAdminAuth, roleId, {
        permissionCodes: ['noop.b.y', 'noop.a.x'],
        expectedRevision: revBefore,
      });
      expect(res.status).toBe(200);
      expect(await revisionOf(roleId)).toBe(revBefore);
      expect(await auditCountOf(roleId)).toBe(auditBefore);
      // 连行都没被重建(否则 id 会变):no-op 是「一个字节都不写」,不是「删了再写回去」
      const rowsAfter = await prisma.rolePermission.findMany({
        where: { roleId },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      expect(rowsAfter).toEqual(rowsBefore);
    });

    // 🔴 这条是上一条的**反面样本**,不能省:no-op 判据若退化成「比条数」,
    //    「换掉一条」会被当成空转 —— 而那正是最危险的漏写(管理员以为改了,实际没改)。
    it('反面样本:条数相同但内容互换 → **不是** no-op,集合真的换掉且 revision +1', async () => {
      const { roleId } = await setupRoleAndPermissions({
        roleCode: 'put-not-noop-swap',
        permCodes: ['swap.a.x', 'swap.b.y'],
      });
      await putAs(superAdminAuth, roleId, {
        permissionCodes: ['swap.a.x'],
        expectedRevision: 0,
      });
      const revBefore = await revisionOf(roleId);
      const auditBefore = await auditCountOf(roleId);

      const res = await putAs(superAdminAuth, roleId, {
        permissionCodes: ['swap.b.y'], // 条数一样(1 → 1),内容全换
        expectedRevision: revBefore,
      });
      expect(res.status).toBe(200);
      expect(await codeSetOf(roleId)).toEqual(new Set(['swap.b.y']));
      expect(await revisionOf(roleId)).toBe(revBefore + 1);
      expect(await auditCountOf(roleId)).toBe(auditBefore + 1);
    });

    it('audit 形状:有变化时 event=role-permission.replace + 增减 / 结果 / 版本区间双记', async () => {
      const { roleId } = await setupRoleAndPermissions({
        roleCode: 'put-audit-shape',
        permCodes: ['aud.a.x', 'aud.b.y'],
      });
      await putAs(superAdminAuth, roleId, {
        permissionCodes: ['aud.a.x'],
        expectedRevision: 0,
      });
      await putAs(superAdminAuth, roleId, {
        permissionCodes: ['aud.b.y'],
        expectedRevision: 1,
      });
      const audits = await prisma.auditLog.findMany({
        where: { event: 'role-permission.replace', resourceId: roleId },
        orderBy: { createdAt: 'asc' },
      });
      expect(audits).toHaveLength(2);
      const last = audits[1].context as unknown as {
        extra?: {
          operation?: string;
          addedCodes?: string[];
          removedCodes?: string[];
          resultCodes?: string[];
          fromRevision?: number;
          toRevision?: number;
        };
      };
      expect(last.extra?.operation).toBe('replace');
      expect(last.extra?.addedCodes).toEqual(['aud.b.y']);
      expect(last.extra?.removedCodes).toEqual(['aud.a.x']);
      expect(new Set(last.extra?.resultCodes)).toEqual(new Set(['aud.b.y']));
      expect(last.extra?.fromRevision).toBe(1);
      expect(last.extra?.toRevision).toBe(2);
    });

    // ---------- 乐观并发(顺序面;真并发在另一份 spec) ----------

    it('expectedRevision 落后 → 30111,且**一个字节都没写**', async () => {
      const { roleId } = await setupRoleAndPermissions({
        roleCode: 'put-stale-rev',
        permCodes: ['stale.a.x', 'stale.b.y'],
      });
      await putAs(superAdminAuth, roleId, {
        permissionCodes: ['stale.a.x'],
        expectedRevision: 0,
      });
      // 客户端手里还是 0,库里已经是 1
      const res = await putAs(superAdminAuth, roleId, {
        permissionCodes: ['stale.b.y'],
        expectedRevision: 0,
      });
      expectBizError(res, BizCode.ROLE_PERMISSION_REVISION_CONFLICT);
      expect(await codeSetOf(roleId)).toEqual(new Set(['stale.a.x']));
      expect(await revisionOf(roleId)).toBe(1);
    });

    it('expectedRevision 超前(客户端瞎填)→ 同样 30111,不静默接受', async () => {
      const { roleId } = await setupRoleAndPermissions({
        roleCode: 'put-ahead-rev',
        permCodes: ['ahead.a.x'],
      });
      const res = await putAs(superAdminAuth, roleId, {
        permissionCodes: ['ahead.a.x'],
        expectedRevision: 99,
      });
      expectBizError(res, BizCode.ROLE_PERMISSION_REVISION_CONFLICT);
      expect(await revisionOf(roleId)).toBe(0);
    });

    it('缺 expectedRevision → 40000(必填,不许退化成无脑覆盖)', async () => {
      const { roleId } = await setupRoleAndPermissions({ roleCode: 'put-no-rev', permCodes: [] });
      const res = await putAs(superAdminAuth, roleId, { permissionCodes: [] });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    // ---------- 旧写路径也会推进版本号(乐观并发的正确性前提) ----------

    it('POST / DELETE 同样 +1 —— 否则 PUT 的乐观校验看不见它们的改动', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'put-legacy-bumps',
        permCodes: ['legacy.a.x'],
      });
      expect(await revisionOf(roleId)).toBe(0);

      await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: ['legacy.a.x'] });
      expect(await revisionOf(roleId)).toBe(1);

      await request(httpServer(app))
        .delete(`/api/system/v1/roles/${roleId}/permissions/${perms[0].id}`)
        .set('Authorization', superAdminAuth);
      expect(await revisionOf(roleId)).toBe(2);

      // 拿着 POST 之前的版本号提交 → 必须被拒(这正是「+1 要覆盖全部写路径」的意义)
      const res = await putAs(superAdminAuth, roleId, {
        permissionCodes: [],
        expectedRevision: 0,
      });
      expectBizError(res, BizCode.ROLE_PERMISSION_REVISION_CONFLICT);
    });

    // 🔴 **契约变化,不是 bug**:POST 走同一条原语后,「重复授权」变成真正的空转 ——
    //    不写、不 +1、**也不再产生 audit**。请求 / 响应形状一字未变(仍 201 + detail)。
    it('POST 重复授权(纯空转)→ 201 但不 +1、不产生 audit(P1-32 PR 4a 起)', async () => {
      const { roleId } = await setupRoleAndPermissions({
        roleCode: 'put-post-noop',
        permCodes: ['pn.a.x'],
      });
      await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: ['pn.a.x'] });
      const revAfterFirst = await revisionOf(roleId);
      const auditAfterFirst = await auditCountOf(roleId);
      expect(revAfterFirst).toBe(1);
      expect(auditAfterFirst).toBe(1);

      const again = await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', superAdminAuth)
        .send({ permissionCodes: ['pn.a.x'] });
      expect(again.status).toBe(201); // 形状不变
      expect(again.body.data.permissions).toHaveLength(1);
      expect(await revisionOf(roleId)).toBe(revAfterFirst);
      expect(await auditCountOf(roleId)).toBe(auditAfterFirst);
    });

    // ---------- 角色三态闸 / 权限码存在性 ----------

    it('role 不存在 → 30003', async () => {
      const res = await putAs(superAdminAuth, 'nonexistent000000000000000000', {
        permissionCodes: [],
        expectedRevision: 0,
      });
      expectBizError(res, BizCode.ROLE_NOT_FOUND);
    });

    it('role 已软删 → 30005', async () => {
      const { roleId } = await setupRoleAndPermissions({
        roleCode: 'put-soft-deleted',
        permCodes: [],
        roleDeletedAt: new Date(),
      });
      const res = await putAs(superAdminAuth, roleId, {
        permissionCodes: [],
        expectedRevision: 0,
      });
      expectBizError(res, BizCode.ROLE_DELETED);
    });

    it('系统内置角色 → 30108(PR 3a 的闸对新入口同样生效,含 SUPER_ADMIN)', async () => {
      // `group-readonly` 在 protected-role-codes.ts 的 15 条清单里;
      // fixture 只建了 ops-admin,这里建它不会撞唯一约束。
      const builtIn = await prisma.rbacRole.create({
        data: { code: 'group-readonly', displayName: '副组长(只读)' },
        select: { id: true },
      });
      const res = await putAs(superAdminAuth, builtIn.id, {
        permissionCodes: [],
        expectedRevision: 0,
      });
      expectBizError(res, BizCode.PROTECTED_ROLE_PERMISSION_CHANGE_FORBIDDEN);
    });

    it('目标集合含不存在的 code → 30001,整批拒绝', async () => {
      const { roleId } = await setupRoleAndPermissions({
        roleCode: 'put-unknown-code',
        permCodes: ['known.a.x'],
      });
      await putAs(superAdminAuth, roleId, {
        permissionCodes: ['known.a.x'],
        expectedRevision: 0,
      });
      const res = await putAs(superAdminAuth, roleId, {
        permissionCodes: ['known.a.x', 'definitely.not.a.code'],
        expectedRevision: 1,
      });
      expectBizError(res, BizCode.PERMISSION_NOT_FOUND);
      expect(await codeSetOf(roleId)).toEqual(new Set(['known.a.x']));
      expect(await revisionOf(roleId)).toBe(1);
    });

    // ---------- PR 3a 两层控制面闸:新入口必须原样继承 ----------

    it('ops-admin 用 PUT 加控制面码 → 30103(第 1 层原样生效)', async () => {
      await grantOpsAdminToUser(app, rpAdminUserId, rpOpsAdminRoleId);
      try {
        const { roleId } = await setupRoleAndPermissions({
          roleCode: 'put-ops-control-plane',
          permCodes: [],
        });
        const res = await putAs(adminAuth, roleId, {
          permissionCodes: ['rbac.role.read'], // 前缀型控制面码,由 rbac.fixture seed
          expectedRevision: 0,
        });
        expectBizError(res, BizCode.PERMISSION_RESERVED_SUPER_ADMIN_ONLY);
        expect(await codeSetOf(roleId)).toEqual(new Set());
      } finally {
        await revokeOpsAdminFromUser(app, rpAdminUserId, rpOpsAdminRoleId);
      }
    });

    it('SUPER_ADMIN 用 PUT 加保留码 → 30109(第 2 层原样生效,且早于存在性查询)', async () => {
      const { roleId } = await setupRoleAndPermissions({
        roleCode: 'put-su-reserved',
        permCodes: [],
      });
      // 刻意**不**创建该 Permission 行:闸在字符串层拦截,必须先于 findMany 生效,
      // 否则会退化成 30001 泄漏「这条码还没 seed」。
      const res = await putAs(superAdminAuth, roleId, {
        permissionCodes: ['member.delete.record'],
        expectedRevision: 0,
      });
      expectBizError(res, BizCode.RESERVED_PERMISSION_NOT_ROLE_GRANTABLE);
      expect(await codeSetOf(roleId)).toEqual(new Set());
      expect(await revisionOf(roleId)).toBe(0);
    });

    it('SUPER_ADMIN 用 PUT 撤掉控制面码 → 200(撤码侧的刻意不对称没有被抹平)', async () => {
      const { roleId } = await setupRoleAndPermissions({
        roleCode: 'put-su-drop-control-plane',
        permCodes: [],
      });
      const perm = await prisma.permission.findUniqueOrThrow({
        where: { code: 'rbac.role.read' },
        select: { id: true },
      });
      await prisma.rolePermission.create({ data: { roleId, permissionId: perm.id } });

      const res = await putAs(superAdminAuth, roleId, {
        permissionCodes: [],
        expectedRevision: 0,
      });
      expect(res.status).toBe(200);
      expect(await codeSetOf(roleId)).toEqual(new Set());
    });

    // 🔴 反向用例(与上面几条同等重要):闸只认「控制面码」这一维。
    //    少了它,一个「PUT 一律拒绝」的实现也会让上面三条全绿。
    it('ops-admin 用 PUT 改纯普通码 → 200(自定义角色的正常授权仍可用)', async () => {
      await grantOpsAdminToUser(app, rpAdminUserId, rpOpsAdminRoleId);
      try {
        const { roleId } = await setupRoleAndPermissions({
          roleCode: 'put-ops-normal',
          permCodes: ['pon.a.x', 'pon.b.y'],
        });
        const first = await putAs(adminAuth, roleId, {
          permissionCodes: ['pon.a.x'],
          expectedRevision: 0,
        });
        expect(first.status).toBe(200);
        const second = await putAs(adminAuth, roleId, {
          permissionCodes: ['pon.b.y'],
          expectedRevision: 1,
        });
        expect(second.status).toBe(200);
        expect(await codeSetOf(roleId)).toEqual(new Set(['pon.b.y']));
      } finally {
        await revokeOpsAdminFromUser(app, rpAdminUserId, rpOpsAdminRoleId);
      }
    });

    // ---------- 判权入口 ----------

    it('未登录 → 401', async () => {
      const res = await request(httpServer(app))
        .put('/api/system/v1/roles/nonexistent000000000000000000/permissions')
        .send({ permissionCodes: [], expectedRevision: 0 });
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('USER → 30100 RBAC_FORBIDDEN', async () => {
      const res = await putAs(userAuth, 'nonexistent000000000000000000', {
        permissionCodes: [],
        expectedRevision: 0,
      });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    // 🔴 PUT 要**两个**码:只有 create 或只有 delete 都不够 ——
    //    只拿 create 就能撤权、只拿 delete 就能授权,都是绕过另一半闸。
    it('只持 rbac.role-permission.create 的角色 → PUT 仍 30100', async () => {
      const halfRole = await prisma.rbacRole.create({
        data: { code: 'put-half-grant', displayName: '半权' },
        select: { id: true },
      });
      const createPerm = await prisma.permission.findUniqueOrThrow({
        where: { code: 'rbac.role-permission.create' },
        select: { id: true },
      });
      await prisma.rolePermission.create({
        data: { roleId: halfRole.id, permissionId: createPerm.id },
      });
      const half = await createTestUser(app, { username: 'rp-half', role: Role.ADMIN });
      await grantOpsAdminToUser(app, half.id, halfRole.id);
      const halfAuth = (await loginAs(app, 'rp-half')).authHeader;

      const { roleId } = await setupRoleAndPermissions({
        roleCode: 'put-half-target',
        permCodes: ['half.a.x'],
      });
      const res = await putAs(halfAuth, roleId, { permissionCodes: [], expectedRevision: 0 });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);

      // 🔴 反向对照:同一个人用 POST(只需 create)必须**真的成功** ——
      //    少了它,一个「这人啥都不能干」的实现也会让上面那条绿。
      //    (刻意不用空数组:空数组会被 DTO 的 @ArrayMinSize(1) 挡在 service 之前,
      //     根本走不到 rbac.can(),证不了任何事。)
      const post = await request(httpServer(app))
        .post(`/api/system/v1/roles/${roleId}/permissions`)
        .set('Authorization', halfAuth)
        .send({ permissionCodes: ['half.a.x'] });
      expect(post.status).toBe(201);
    });
  });
});
