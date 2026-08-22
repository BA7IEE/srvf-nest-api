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
    // 现在授码侧对 SUPER_ADMIN 也拒 —— 把保留码写进某角色的 role_permissions,
    // 就是让**持有该角色的非 SA** 永久拥有 SA-only 能力,由谁按下按钮不改变结果。
    // SA 依然能用 SA 身份直接做那些控制面操作(SA 走身份短路,根本不查 role_permissions)。
    it('SUPER_ADMIN 分配同一保留码 → 也 30103(授码侧不再有 SA 短路)', async () => {
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
      expectBizError(res, BizCode.PERMISSION_RESERVED_SUPER_ADMIN_ONLY);

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
        // 直插一条映射,制造一条「可撤」的真实绑定。
        // ⚠️ P1-32 PR 3a 起**任何身份都授不了控制面码**(含 SA),所以这条映射不能再经 API 造。
        //    这不是绕过被测路径 —— 恰恰是 revoke 侧保留 SA 通道的**唯一现实来源**:
        //    历史脏数据(PR 3a 之前 SA 授上的、或直接改库留下的)。
        await prisma.rolePermission.create({ data: { roleId, permissionId } });

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
      // 同上:PR 3a 后控制面码不能再经 API 授上,直插模拟历史脏数据。
      await prisma.rolePermission.create({ data: { roleId, permissionId } });

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
});
