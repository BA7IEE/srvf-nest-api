import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, BindingStatus, PrincipalType, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { PROTECTED_ROLE_CODES } from '../../src/modules/permissions/protected-role-codes';
import { loginAs } from '../fixtures/auth.fixture';
import { grantOpsAdminToUser, seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { createTestUser, TEST_PASSWORD } from '../fixtures/users.fixture';
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

// ⚠️ **P1-32 PR 8(2026-08-24)迁移说明 —— 本 spec 的 9 处是改打新端点,不是删**:
//    旧 `POST /roles/:id/permissions`(增量授权)与 `DELETE /roles/:id/permissions/:permissionId`
//    (精确撤权)已退役,唯一写入口是 `PUT`(整集替换,必带 expectedRevision)。
//    本 spec 守的是**委派安全**(谁能把什么码授给哪个角色),那与用哪个动词写无关 ——
//    逐条改成 PUT 后闸的判定序列一字未改:
//      ① 判权(PUT 要 rbac.role-permission.create **与** delete 两条码,比 POST 更严)
//      ② 角色三态闸(30003 / 30005 / **30108 内建角色只读**)—— 在事务之前,早于版本号校验
//      ③ D2 控制面两层闸(30103 / 30109)—— 早于 Permission 存在性查询
//      ④ step-up(30112)—— ⭐ **PUT 独有**:控制面码 / CRITICAL 差集要二次验证。
//    ⇒ ③ 恒早于 ④,所以「ops-admin 授控制面码 → 30103」这类断言的**码一个没变**;
//      而 SA 走得过 ③ 的那条,现在要多铸一把 proof —— 见 `mintStepUpToken()`。
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

  /** 整集替换 —— 旧 POST / DELETE 退役后本 spec 唯一的写角色权限手段。 */
  function putPermissions(
    auth: string,
    roleId: string,
    body: { permissionCodes: string[]; expectedRevision: number; stepUpToken?: string },
  ): request.Test {
    return request(httpServer(app))
      .put(`/api/system/v1/roles/${roleId}/permissions`)
      .set('Authorization', auth)
      .send(body);
  }

  /**
   * 铸一把绑死 (roleId, expectedRevision, 目标码集) 的 step-up proof。
   * ⚠️ payloadHash 的算法在这里**独立实现一遍**(去重 → 升序 → JSON.stringify → sha256 →
   *    base64url),与 `role-permissions.e2e-spec.ts` 同款:不 import 服务端函数,
   *    这样它顺带验证 `docs/handoff/admin-web.md` §3.5 写给前端的算法是可实现的。
   */
  async function mintStepUpToken(
    auth: string,
    roleId: string,
    expectedRevision: number,
    permissionCodes: readonly string[],
  ): Promise<string> {
    const payloadHash = createHash('sha256')
      .update(JSON.stringify([...new Set<string>(permissionCodes)].sort()))
      .digest('base64url');
    const res = await request(httpServer(app))
      .post('/api/auth/v1/step-up/password')
      .set('Authorization', auth)
      .send({
        action: 'RBAC_ROLE_PERMISSION_SET_REPLACE',
        password: TEST_PASSWORD,
        rolePermissionSet: { roleId, expectedRevision, payloadHash },
      });
    expect(res.status).toBe(200);
    return res.body.data.stepUpToken as string;
  }

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
          startedAt: new Date('2102-01-01T00:00:00.000Z'),
        },
      );
      expectBizError(
        await request(httpServer(app))
          .patch(`/api/admin/v1/role-bindings/${earlier.id}`)
          .set('Authorization', opsAdminAuth)
          .send({ startedAt: '2101-01-01T00:00:00.000Z' }),
        BizCode.CANNOT_ASSIGN_HIGHER_ROLE,
      );

      const laterTarget = await createTarget('rd-later');
      const later = await insertBinding(laterTarget.id, 'rd-control-role', BindingStatus.ACTIVE, {
        startedAt: new Date('2100-01-01T00:00:00.000Z'),
        endedAt: new Date('2102-01-01T00:00:00.000Z'),
      });
      expectBizError(
        await request(httpServer(app))
          .patch(`/api/admin/v1/role-bindings/${later.id}`)
          .set('Authorization', opsAdminAuth)
          .send({ endedAt: '2103-01-01T00:00:00.000Z' }),
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
        // 新建角色 permissionRevision 从 0 起;D2 闸(③)早于版本号校验与 step-up(④),
        // 所以这里拿到的仍然是 30103 而不是 30111 / 30112。
        expectBizError(
          await putPermissions(opsAdminAuth, role.id, {
            permissionCodes: [permissionCode],
            expectedRevision: 0,
          }),
          BizCode.PERMISSION_RESERVED_SUPER_ADMIN_ONLY,
        );
      },
    );

    // ⚠️ 这两条码是 `rbac.*` / `role-binding.*` **前缀族**,不是那 7 条保留码 ——
    //    P1-32 PR 3a 对 SUPER_ADMIN 的收紧**只覆盖保留码**,前缀族语义一字未变。
    //    (前缀族里有 `rbac.permission.read` 这类纯只读码,SA 建「RBAC 只读观察员」
    //     角色是合法用途;砍掉它没有任何拍板支持。保留码那条见下面单独一个用例。)
    it('SUPER_ADMIN 可授控制面前缀族码；ops-admin 授业务码不受影响', async () => {
      const saRole = await prisma.rbacRole.create({
        data: { code: 'rd-grant-sa', displayName: '超级管理员授码测试角色' },
        select: { id: true },
      });
      const saCodes = ['rbac.permission.read', 'role-binding.create.record'];
      // ⭐ 先证 **D2 闸(③)确实对 SA 短路** —— 若它没短路,这里会是 30103 而不是 30112。
      //    (30112 = step-up 要求,是**下一道**闸接手的指纹;两个码可区分 ⇒ 断言没变钝。)
      expectBizError(
        await putPermissions(superAdminAuth, saRole.id, {
          permissionCodes: saCodes,
          expectedRevision: 0,
        }),
        BizCode.ROLE_PERMISSION_STEP_UP_REQUIRED,
      );
      // 再带 proof 走完,证明**真的授得成功**(原断言「201」的那半,一条没丢)
      const saRes = await putPermissions(superAdminAuth, saRole.id, {
        permissionCodes: saCodes,
        expectedRevision: 0,
        stepUpToken: await mintStepUpToken(superAdminAuth, saRole.id, 0, saCodes),
      });
      expect(saRes.status).toBe(200);
      expect(saRes.body.data.permissions).toHaveLength(2);

      const businessRole = await prisma.rbacRole.create({
        data: { code: 'rd-grant-business', displayName: '业务授码测试角色' },
        select: { id: true },
      });
      // 业务码既非控制面也非 CRITICAL ⇒ 不触 step-up,一趟到位。
      const businessRes = await putPermissions(opsAdminAuth, businessRole.id, {
        permissionCodes: ['rd-business.manage.record'],
        expectedRevision: 0,
      });
      expect(businessRes.status).toBe(200);
    });

    // P1-32 PR 3a:拍板②「7 条保留码一条都不该进任何角色」的执行位。
    // 与上一条形成**对照**:同是「控制面码 + SUPER_ADMIN」,前缀族放行、保留码拒绝 ——
    // 两条并排放,才能证明收紧确实只落在保留码那一维上,不是一刀切。
    it('SUPER_ADMIN 也不能把保留码授给角色 → 30109,且一条都没写进去', async () => {
      const role = await prisma.rbacRole.create({
        data: { code: 'rd-grant-reserved-sa', displayName: '保留码授码测试角色' },
        select: { id: true },
      });
      expectBizError(
        await putPermissions(superAdminAuth, role.id, {
          permissionCodes: ['user.update.role'],
          expectedRevision: 0,
        }),
        BizCode.RESERVED_PERMISSION_NOT_ROLE_GRANTABLE,
      );
      expect(await prisma.rolePermission.count({ where: { roleId: role.id } })).toBe(0);
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

  // ============ P1-32 PR 3a(2026-08-23):内建角色运行时只读 ============
  //
  // D3 只锁住了「删」。改名、加权限、减权限在此之前**一个拦阻都没有** ——
  // `PROTECTED_ROLE_CODE_SET` 全仓只被 softDelete 查过一次。
  //
  // 🔴 下面第一条是本刀存在的理由,不是补充覆盖:它是一条**真实可利用路径**。
  //    ops-admin 持 rbac.role-permission.create,把 member-profile.read.sensitive
  //    (明文证件号 / 手机)加到 member 角色上 —— 控制面闸拦不住(它不是那 7 条保留码),
  //    于是全体队员当场能看彼此明文 PII。
  describe('PR 3a:15 个内建角色运行时只读(改名 / 加权限 / 减权限)', () => {
    const SENSITIVE_CODE = 'member-profile.read.sensitive';

    beforeAll(async () => {
      // 该码由 prisma/seed.ts 定义,但 resetDb 清空了 RBAC 表且 rbac.fixture 不含它。
      await prisma.permission.upsert({
        where: { code: SENSITIVE_CODE },
        update: {},
        create: {
          code: SENSITIVE_CODE,
          module: 'member-profile',
          action: 'read',
          resourceType: 'sensitive',
        },
      });
    });

    it('⭐ ops-admin 把 member-profile.read.sensitive 加到 member 角色 → 30108,且一条都没写进去', async () => {
      const memberRoleId = getRoleId('member');
      const before = await prisma.rolePermission.count({ where: { roleId: memberRoleId } });

      // ⚠️ 内建角色只读闸(②)在**开事务之前**判,早于 expectedRevision 校验 ⇒
      //    这里传 0 不会把 30108 换成 30111(那正是本条要钉的次序)。
      expectBizError(
        await putPermissions(opsAdminAuth, memberRoleId, {
          permissionCodes: [SENSITIVE_CODE],
          expectedRevision: 0,
        }),
        BizCode.PROTECTED_ROLE_PERMISSION_CHANGE_FORBIDDEN,
      );

      // 拒绝 = 什么都没写(闸在事务之前);顺带钉住「明文 PII 那条码确实没绑上去」
      expect(await prisma.rolePermission.count({ where: { roleId: memberRoleId } })).toBe(before);
      const sensitive = await prisma.permission.findUniqueOrThrow({
        where: { code: SENSITIVE_CODE },
        select: { id: true },
      });
      const leaked = await prisma.rolePermission.findUnique({
        where: {
          roleId_permissionId: { roleId: memberRoleId, permissionId: sensitive.id },
        },
        select: { id: true },
      });
      expect(leaked).toBeNull();
    });

    it.each(PROTECTED_ROLE_CODES)('%s 改名即使 SUPER_ADMIN 也 → 30107', async (roleCode) => {
      expectBizError(
        await request(httpServer(app))
          .patch(`/api/system/v1/roles/${getRoleId(roleCode)}`)
          .set('Authorization', superAdminAuth)
          .send({ displayName: '被改名的内建角色' }),
        BizCode.PROTECTED_ROLE_UPDATE_FORBIDDEN,
      );
      // 真没改(不是「返错码但已落库」)
      const row = await prisma.rbacRole.findUniqueOrThrow({
        where: { code: roleCode },
        select: { displayName: true },
      });
      expect(row.displayName).not.toBe('被改名的内建角色');
    });

    it.each(PROTECTED_ROLE_CODES)('%s 加权限即使 SUPER_ADMIN 也 → 30108', async (roleCode) => {
      expectBizError(
        await putPermissions(superAdminAuth, getRoleId(roleCode), {
          permissionCodes: ['rd-business.manage.record'],
          expectedRevision: 0,
        }),
        BizCode.PROTECTED_ROLE_PERMISSION_CHANGE_FORBIDDEN,
      );
    });

    it('内建角色减权限即使 SUPER_ADMIN 也 → 30108,且既有映射原样还在', async () => {
      // 直插一条内建角色上的映射(内建角色的映射本来就由 seed 造,不经 API)
      const roleId = getRoleId('org-readonly');
      const perm = await prisma.permission.findUniqueOrThrow({
        where: { code: 'rd-business.manage.record' },
        select: { id: true },
      });
      await prisma.rolePermission.createMany({
        data: [{ roleId, permissionId: perm.id }],
        skipDuplicates: true,
      });

      // 「减权限」在 PUT 语义下 = 把目标集写成不含它的集合(这里直接清空)。
      expectBizError(
        await putPermissions(superAdminAuth, roleId, {
          permissionCodes: [],
          expectedRevision: 0,
        }),
        BizCode.PROTECTED_ROLE_PERMISSION_CHANGE_FORBIDDEN,
      );

      const still = await prisma.rolePermission.findUnique({
        where: { roleId_permissionId: { roleId, permissionId: perm.id } },
        select: { id: true },
      });
      expect(still).not.toBeNull();
    });

    // 🔴 反向用例,**不能省**。只验「该拦的拦住了」的话,一个「角色写操作一律拒绝」的
    //    实现也会让上面全绿 —— 那不是修洞,那是把整个角色管理功能废掉。
    describe('反向:自定义角色的改名 / 授权 / 撤权全部照常', () => {
      it('自定义角色改名 → 200', async () => {
        const custom = await prisma.rbacRole.create({
          data: { code: 'rd-3a-rename-ok', displayName: '旧名' },
          select: { id: true },
        });
        const res = await request(httpServer(app))
          .patch(`/api/system/v1/roles/${custom.id}`)
          .set('Authorization', superAdminAuth)
          .send({ displayName: '新名' });
        expect(res.status).toBe(200);
        expect(res.body.data.displayName).toBe('新名');
      });

      // ⚠️ 状态码由 201(旧 POST)变 200(PUT)—— 那是 `PUT` 的既有契约,不是断言被放宽:
      //    「授得进去 / 撤得干净」这两件被测的事逐条都还在,且多钉了一条版本号推进。
      it('ops-admin 给自定义角色授业务码 → 200,再撤 → 200(版本号逐次 +1)', async () => {
        const custom = await prisma.rbacRole.create({
          data: { code: 'rd-3a-grant-ok', displayName: '自定义可授角色' },
          select: { id: true },
        });
        const granted = await putPermissions(opsAdminAuth, custom.id, {
          permissionCodes: ['rd-business.manage.record'],
          expectedRevision: 0,
        });
        expect(granted.status).toBe(200);
        expect(granted.body.data.permissions).toHaveLength(1);
        expect(granted.body.data.permissionRevision).toBe(1);

        const revoked = await putPermissions(opsAdminAuth, custom.id, {
          permissionCodes: [],
          expectedRevision: 1,
        });
        expect(revoked.status).toBe(200);
        expect(revoked.body.data.permissions).toHaveLength(0);
        expect(revoked.body.data.permissionRevision).toBe(2);
      });
    });
  });
});
