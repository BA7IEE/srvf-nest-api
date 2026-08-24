import { createHash } from 'node:crypto';

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
import { createTestUser, TEST_PASSWORD } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// V2.x C-6 RBAC 实施 PR #4:RolePermission 关联表 e2e。
// 沿 D7 v1.1 §5.1 端点 10-11 + 用户拍板。
//
// 覆盖(沿任务 #9):
// - 授权(成功 / 重复提交幂等 / role 不存在 / role 已软删 / permission 不存在)
// - 撤权(成功 / role 不存在 / role 已软删 / permission 不存在)
// - role detail 返回真实 permissions
// - 权限边界(未登录 / USER 403 / ADMIN 允许)
// - DB-backed permission resolution 在 role-permission 增减 / role soft-delete 后下一请求收敛
//
// ══════════════════════════════════════════════════════════════════════════
// ⚠️ **P1-32 PR 8(2026-08-24)迁移说明 —— 本 spec 的 41 处调用点是改打新端点,不是删**
// ══════════════════════════════════════════════════════════════════════════
// 退役的两条旧增量端点:
//   · `POST   /api/system/v1/roles/:id/permissions`               批量增量授权
//   · `DELETE /api/system/v1/roles/:id/permissions/:permissionId` 精确撤权
// 仅存写入口:`PUT /api/system/v1/roles/:id/permissions`(整集替换,必带 expectedRevision)
// + `POST …/preview`(dry-run)。
//
// **逐条改写口径**(每个用例上方另有就地说明):
//   ① 「加 N 条」→ 目标集 = 现状 ∪ N;「撤 1 条」→ 目标集 = 现状 \ {那条}。
//   ② 状态码 201 → 200(`PUT` 的既有契约,不是断言放宽)。
//   ③ 高风险差集(控制面码 / CRITICAL)在 `PUT` 上要 step-up proof(30112)——
//      ⚠️ 它排在 D2 撤码方向闸(30103)**之前**,会遮蔽下层边界。
//      ⇒ 要断言 30103 的用例**必须先铸一把 proof**,否则测到的是上层那道闸。
//      (仓内教训:「上层边界遮蔽下层边界」——反面样本必须在被测那一维上单独不同。)
//
// 🔴 **三处「被测对象随端点消失」的,已就地改成「新契约标记用例」并逐条写明丢了什么**
//    (没有删掉任何 it,登记见 NEXT_TASKS P1-32 PR 8):
//      · 「空数组 → 400(@ArrayMinSize(1))」—— 新 DTO **刻意允许空目标集**,契约相反
//      · 「关系不存在 → 30011」—— 30011 失去唯一产出者;整集替换下「撤一条本来没有的」= no-op
//      · 「POST / DELETE 同样 +1」—— 主语就是那两条已删端点
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

  /** 整集替换 —— PR 8 之后本 spec 唯一的写手段。 */
  function putAs(auth: string, roleId: string, body: Record<string, unknown>) {
    return request(httpServer(app))
      .put(`/api/system/v1/roles/${roleId}/permissions`)
      .set('Authorization', auth)
      .send(body);
  }

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

  /**
   * 铸一把绑死 (roleId, expectedRevision, 目标码集) 的 step-up proof。
   * ⚠️ payloadHash 在这里**独立实现一遍**(去重 → 升序 → JSON.stringify → sha256 → base64url),
   *    不 import 服务端函数 —— 它同时验证 `docs/handoff/admin-web.md` §3.5 的算法可实现。
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

  // ============ 权限边界 ============

  describe('权限边界', () => {
    // ⚠️ PR 8 后这三条与下方 `PUT` describe 里的同名边界用例**落在同一根轴上**(写面只剩一条)。
    //    刻意**保留为冗余对照**而不是合并删除 —— 删测试是硬红线;
    //    「本 describe 与 PUT describe 的边界用例可去重」已登记进 NEXT_TASKS,由后续整理刀处理。
    it('未登录写角色权限 → 401', async () => {
      const res = await request(httpServer(app))
        .put('/api/system/v1/roles/nonexistent000000000000000000/permissions')
        .send({ permissionCodes: ['x.y.z'], expectedRevision: 0 });
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('USER 写角色权限 → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .put('/api/system/v1/roles/nonexistent000000000000000000/permissions')
        .set('Authorization', userAuth)
        .send({ permissionCodes: ['x.y.z'], expectedRevision: 0 });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER 撤角色权限(目标集清空)→ 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .put('/api/system/v1/roles/nonexistent000000000000000000/permissions')
        .set('Authorization', userAuth)
        .send({ permissionCodes: [], expectedRevision: 0 });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    // P0-F PR-1(2026-05-18):v1 ADMIN 不再自动放行 RBAC 元接口;必须持 RBAC 角色。
    it('ADMIN 默认无 RBAC 权限 → 30100 RBAC_FORBIDDEN', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'admin-no-rbac-rp',
        permCodes: ['adm.norbac.a'],
      });
      const res = await putAs(adminAuth, roleId, {
        permissionCodes: [perms[0].code],
        expectedRevision: 0,
      });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    // P0-F PR-1:ADMIN 持 ops-admin 后能通过(seed 14 条 rbac.* 含
    // rbac.role-permission.create **与** delete —— PUT 两条都要,ops-admin 两条都有)。
    it('ADMIN 持 ops-admin 角色 → 写角色权限 200', async () => {
      await grantOpsAdminToUser(app, rpAdminUserId, rpOpsAdminRoleId);
      try {
        const { roleId, perms } = await setupRoleAndPermissions({
          roleCode: 'admin-with-ops-rp',
          permCodes: ['adm.ops.b'],
        });
        const res = await putAs(adminAuth, roleId, {
          permissionCodes: [perms[0].code],
          expectedRevision: 0,
        });
        expect(res.status).toBe(200);
      } finally {
        await revokeOpsAdminFromUser(app, rpAdminUserId, rpOpsAdminRoleId);
      }
    });
  });

  // ============ 批量授权 ============
  // ⚠️ PR 8 前本组打的是 `POST`(增量授权);端点退役后逐条改打 `PUT`(整集替换)。
  //    「加 N 条」在整集语义下 = 目标集 = 现状 ∪ N;本组多数用例的现状是空集,直接给 N。

  describe('写角色权限集(PUT;PR 8 前是 POST 增量授权)', () => {
    it('一次写入多条 → 200,detail.permissions 含全部', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'assign-multi',
        permCodes: ['multi.a.r1', 'multi.b.r2', 'multi.c.r3'],
      });

      const res = await putAs(superAdminAuth, roleId, {
        permissionCodes: perms.map((p) => p.code),
        expectedRevision: 0,
      });

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data.permissions).toHaveLength(3);
      const returnedCodes = res.body.data.permissions.map((p: { code: string }) => p.code);
      expect(returnedCodes).toEqual(
        expect.arrayContaining(['multi.a.r1', 'multi.b.r2', 'multi.c.r3']),
      );
    });

    it('重复提交同一目标集 → 200 幂等,行数仍为去重后的数量', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'assign-idempotent',
        permCodes: ['idem.a.x'],
      });

      // 第一次写入
      const first = await putAs(superAdminAuth, roleId, {
        permissionCodes: [perms[0].code],
        expectedRevision: 0,
      });
      expect(first.status).toBe(200);
      expect(first.body.data.permissions).toHaveLength(1);

      // 第二次提交同一目标集 —— 幂等成功,不抛 30010,permissions 仍 1 条
      // (整集语义下这是 no-op:不写、不 +1;版本号语义见下方 PUT describe 的 no-op 用例)
      const second = await putAs(superAdminAuth, roleId, {
        permissionCodes: [perms[0].code],
        expectedRevision: 1,
      });
      expect(second.status).toBe(200);
      expect(second.body.data.permissions).toHaveLength(1);

      // DB 中实际 RolePermission 行数也应是 1(不重复建行)
      const dbCount = await prisma.rolePermission.count({ where: { roleId } });
      expect(dbCount).toBe(1);
    });

    it('目标集含已有 + 新增 → 200,只新增不存在的关系', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'assign-partial',
        permCodes: ['part.a.x', 'part.b.y', 'part.c.z'],
      });

      // 先写 a + b
      await putAs(superAdminAuth, roleId, {
        permissionCodes: ['part.a.x', 'part.b.y'],
        expectedRevision: 0,
      });

      // 再提交 a + b + c(含 2 个已存在 + 1 个新增)
      const res = await putAs(superAdminAuth, roleId, {
        permissionCodes: perms.map((p) => p.code),
        expectedRevision: 1,
      });
      expect(res.status).toBe(200);
      expect(res.body.data.permissions).toHaveLength(3);
      // 「只新增不存在的」在整集语义下由差集表达:audit 里 addedCodes 只有 c
      const audit = await prisma.auditLog.findFirst({
        where: { resourceType: 'role_permission', resourceId: roleId },
        orderBy: { createdAt: 'desc' },
        select: { context: true },
      });
      const extra = (audit?.context as { extra?: { addedCodes?: string[] } } | null)?.extra;
      expect(extra?.addedCodes).toEqual(['part.c.z']);
    });

    it('入参中包含重复 code → 200,Service 内部 dedup', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'assign-input-dup',
        permCodes: ['dup.x.x'],
      });
      const res = await putAs(superAdminAuth, roleId, {
        permissionCodes: [perms[0].code, perms[0].code, perms[0].code],
        expectedRevision: 0,
      });
      expect(res.status).toBe(200);
      expect(res.body.data.permissions).toHaveLength(1);
    });

    it('role 不存在 → 30003', async () => {
      const res = await putAs(superAdminAuth, 'nonexistent000000000000000000', {
        permissionCodes: ['any.x.y'],
        expectedRevision: 0,
      });
      expectBizError(res, BizCode.ROLE_NOT_FOUND);
    });

    it('role 已软删 → 30005', async () => {
      const { roleId } = await setupRoleAndPermissions({
        roleCode: 'assign-softdel',
        permCodes: [],
        roleDeletedAt: new Date(),
      });
      const res = await putAs(superAdminAuth, roleId, {
        permissionCodes: ['x.y.z'],
        expectedRevision: 0,
      });
      expectBizError(res, BizCode.ROLE_DELETED);
    });

    it('permission code 不存在 → 30001,整批拒绝', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'assign-perm-missing',
        permCodes: ['exist.a.x'],
      });
      const res = await putAs(superAdminAuth, roleId, {
        permissionCodes: [perms[0].code, 'does.not.exist'],
        expectedRevision: 0,
      });
      expectBizError(res, BizCode.PERMISSION_NOT_FOUND);

      // 确认部分写入也未发生(整批拒绝)
      const dbCount = await prisma.rolePermission.count({ where: { roleId } });
      expect(dbCount).toBe(0);
    });

    // 🔴 **契约反转标记用例(P1-32 PR 8)—— 原断言是「空数组 → 400」,现在相反。**
    //    原用例打的是已退役的 `POST`,它的 `AssignRolePermissionsDto` 有 `@ArrayMinSize(1)`:
    //    「增量加 0 条」没有意义,所以被 DTO 挡在 service 之前。
    //    仅存的 `ReplaceRolePermissionsDto` **刻意没有** `@ArrayMinSize` ——
    //    空数组是合法目标集(= 清空该角色全部权限点),理由逐字写在该 DTO 头注:
    //    「整集替换若不许传空,『把权限收干净』就只能靠逐条 DELETE」。
    //    ⇒ 这条断言**无法迁移**(新旧契约方向相反)。**不删**,就地改成守住新契约的标记用例,
    //      并在此写明丢掉的是什么:「写入口拒绝空入参」这个性质在本模块已不存在。
    //      (「空目标集真的把权限清空」由下方 PUT describe 的「替换成 [] → 清空」用例守。)
    it('⚠️〔PR 8 契约反转〕空数组不再 400 —— 它是合法目标集(清空),原 @ArrayMinSize(1) 随旧 DTO 一并消失', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'assign-empty',
        permCodes: ['empty.a.x'],
      });
      await putAs(superAdminAuth, roleId, {
        permissionCodes: [perms[0].code],
        expectedRevision: 0,
      });
      expect(await codeSetOf(roleId)).toEqual(new Set(['empty.a.x']));

      const res = await putAs(superAdminAuth, roleId, {
        permissionCodes: [],
        expectedRevision: 1,
      });
      expect(res.status).toBe(200);
      expect(await codeSetOf(roleId)).toEqual(new Set());
    });
  });

  // ============ 撤权 ============
  // ⚠️ PR 8 前本组打的是 `DELETE /:permissionId`(精确撤一条);端点退役后改打 `PUT`:
  //    「撤 x」= 目标集 = 现状 \ {x}。⚠️ 路径参数也从 permission.**id** 变成目标集里的 **code**。

  describe('撤角色权限(PUT 目标集减项;PR 8 前是 DELETE 精确撤权)', () => {
    it('撤一条 → 200,detail.permissions 移除指定项', async () => {
      const { roleId } = await setupRoleAndPermissions({
        roleCode: 'revoke-success',
        permCodes: ['rev.a.x', 'rev.b.y'],
      });

      // 先写入 2 个
      await putAs(superAdminAuth, roleId, {
        permissionCodes: ['rev.a.x', 'rev.b.y'],
        expectedRevision: 0,
      });

      // 撤 a(= 目标集只留 b)
      const res = await putAs(superAdminAuth, roleId, {
        permissionCodes: ['rev.b.y'],
        expectedRevision: 1,
      });
      expect(res.status).toBe(200);
      expect(res.body.data.permissions).toHaveLength(1);
      expect(res.body.data.permissions[0].code).toBe('rev.b.y');
    });

    // 🔴 **契约反转标记用例(P1-32 PR 8)—— 原断言是「关系不存在 → 30011」。**
    //    `30011 ROLE_PERMISSION_NOT_FOUND` 的**唯一产出者**是已退役的 `revoke()`
    //    (它先查 (roleId, permissionId) 关系,查不到就抛)。整集替换没有「撤某一条」这个动作 ——
    //    提交一个不含 x 的目标集,而 x 本来就不在,差集为空 ⇒ 这就是 **no-op**,不是错误。
    //    ⇒ 这条断言**无法迁移**(新语义下不存在该错误态)。**不删**,就地改成守住新契约的
    //      标记用例;`30011` 已成孤儿码(词条保留、全仓无 throw 点),登记见 NEXT_TASKS。
    it('⚠️〔PR 8 契约反转〕目标集不含一条本来就没有的码 → no-op 200(旧 DELETE 在这里返 30011)', async () => {
      const { roleId } = await setupRoleAndPermissions({
        roleCode: 'revoke-no-relation',
        permCodes: ['norel.a.x'],
      });
      // role 与 permission 都存在,但没建过关系;目标集给空 = 「撤掉它」
      const res = await putAs(superAdminAuth, roleId, {
        permissionCodes: [],
        expectedRevision: 0,
      });
      expect(res.status).toBe(200);
      expect(await codeSetOf(roleId)).toEqual(new Set());
      // no-op:不写、不 +1(差集为空)
      expect(await revisionOf(roleId)).toBe(0);
    });

    it('role 不存在 → 30003', async () => {
      // 这条码**故意建出来但不用**:它证明 30003 是「角色不存在」判出来的,
      // 而不是「顺带发现权限码也不存在」—— 库里确实有一条合法权限码可用时,结论不变。
      await prisma.permission.create({
        data: { code: 'rev.norole.x', module: 'rev', action: 'norole', resourceType: 'x' },
        select: { id: true },
      });
      const res = await putAs(superAdminAuth, 'nonexistent000000000000000000', {
        permissionCodes: [],
        expectedRevision: 0,
      });
      expectBizError(res, BizCode.ROLE_NOT_FOUND);
    });

    it('role 已软删 → 30005', async () => {
      const { roleId } = await setupRoleAndPermissions({
        roleCode: 'revoke-softdel-role',
        permCodes: ['rsdr.a.x'],
        roleDeletedAt: new Date(),
      });
      const res = await putAs(superAdminAuth, roleId, {
        permissionCodes: [],
        expectedRevision: 0,
      });
      expectBizError(res, BizCode.ROLE_DELETED);
    });

    it('permission 不存在 → 30001', async () => {
      const { roleId } = await setupRoleAndPermissions({
        roleCode: 'revoke-no-perm',
        permCodes: [],
      });
      const res = await putAs(superAdminAuth, roleId, {
        permissionCodes: ['missing.no.such'],
        expectedRevision: 0,
      });
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
        // D2 授码方向闸(runReplaceSet 第 2 步)排在 step-up(第 2.5 步)**之前**
        // ⇒ 这里拿到的仍是 30103,不会被 30112 遮蔽。
        const res = await putAs(adminAuth, roleId, {
          permissionCodes: ['f1.normal.ok', 'member.delete.record'],
          expectedRevision: 0,
        });
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
        const res = await putAs(adminAuth, roleId, {
          permissionCodes: ['user.update.role'],
          expectedRevision: 0,
        });
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
      const res = await putAs(superAdminAuth, roleId, {
        permissionCodes: ['user.update.role'],
        expectedRevision: 0,
      });
      expectBizError(res, BizCode.RESERVED_PERMISSION_NOT_ROLE_GRANTABLE);

      // 拒绝 = 一条都没写进去(闸在事务之前)
      const written = await prisma.rolePermission.count({ where: { roleId } });
      expect(written).toBe(0);
    });

    // 🔴 反向用例:闸只认「控制面码」这一维,不是「SA 干什么都拒」。
    //    少了它,一个「assign 一律拒绝」的实现也会让上面几条全绿。
    it('SUPER_ADMIN 分配普通码 → 200(授码侧的收紧不误伤正常配置)', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'f1-su-normal',
        permCodes: ['f1.su.plain'],
      });
      // 普通码既非控制面也非 CRITICAL ⇒ 差集不高风险,不触 step-up,一趟到位。
      const res = await putAs(superAdminAuth, roleId, {
        permissionCodes: perms.map((p) => p.code),
        expectedRevision: 0,
      });
      expect(res.status).toBe(200);
      const codes = res.body.data.permissions.map((p: { code: string }) => p.code);
      expect(codes).toEqual(['f1.su.plain']);
    });

    it('ops-admin 分配纯普通码 → 200(闸不误伤非保留码)', async () => {
      await grantOpsAdminToUser(app, rpAdminUserId, rpOpsAdminRoleId);
      try {
        const { roleId, perms } = await setupRoleAndPermissions({
          roleCode: 'f1-ops-normal',
          permCodes: ['f1.plain.a', 'f1.plain.b'],
        });
        const res = await putAs(adminAuth, roleId, {
          permissionCodes: perms.map((p) => p.code),
          expectedRevision: 0,
        });
        expect(res.status).toBe(200);
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

    // ⚠️ **P1-32 PR 8 迁移的关键点(仓内教训:上层边界遮蔽下层边界)**:
    //    旧 `DELETE` 没有 step-up;`PUT` 有,而 step-up(runReplaceSet 第 2.5 步)排在
    //    D2 **撤码方向**闸(写原语第 8 步,在事务内)**之前**。
    //    ⇒ 非 SA 撤控制面码时,不带 proof 会先拿 30112,把要测的 30103 遮住。
    //    本组因此**先铸 proof 再打** —— 让被测的那一维(撤码方向的控制面判定)单独暴露出来。
    //    ⚠️ 上游那道 30112 本身也没被漏测:下面第二条用例把「不带 proof → 30112」一并钉住。

    /** 直插一条控制面码绑定作为夹具 —— 走 API 授它现在要 SA + proof,那不是本组要测的东西。 */
    async function seedControlPlaneBinding(roleId: string): Promise<string> {
      const permissionId = await controlPlanePermissionId();
      await prisma.rolePermission.create({ data: { roleId, permissionId } });
      return permissionId;
    }

    // 🔴 这条**不能省**。只验「被拒」的话,一个「一律拒绝」的实现也会全绿 ——
    //    那不是修洞,那是把 ops-admin 的 rbac.role-permission.delete 整个废掉。
    it('ops-admin 撤销普通码 → 200(闸不误伤正常运维)', async () => {
      await grantOpsAdminToUser(app, rpAdminUserId, rpOpsAdminRoleId);
      try {
        const { roleId } = await setupRoleAndPermissions({
          roleCode: 'eb2-ops-normal',
          permCodes: ['eb2.plain.a', 'eb2.plain.b'],
        });
        await putAs(superAdminAuth, roleId, {
          permissionCodes: ['eb2.plain.a', 'eb2.plain.b'],
          expectedRevision: 0,
        });

        // 撤普通码:差集不含高风险码 ⇒ 不触 step-up,不带 proof 也应直接成功。
        const res = await putAs(adminAuth, roleId, {
          permissionCodes: ['eb2.plain.b'],
          expectedRevision: 1,
        });
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

    it('ops-admin 撤销控制面码 → 先 30112(未二次验证),带 proof 后 30103,且绑定原样还在', async () => {
      await grantOpsAdminToUser(app, rpAdminUserId, rpOpsAdminRoleId);
      try {
        const { roleId } = await setupRoleAndPermissions({
          roleCode: 'eb2-ops-control-plane',
          permCodes: [],
        });
        const permissionId = await seedControlPlaneBinding(roleId);

        // ① 上层:不带 proof → 30112(撤控制面码属高风险差集)。这道闸本身也被钉住。
        expectBizError(
          await putAs(adminAuth, roleId, { permissionCodes: [], expectedRevision: 0 }),
          BizCode.ROLE_PERMISSION_STEP_UP_REQUIRED,
        );

        // ② 下层(本组真正要测的):带上真 proof 越过 step-up 之后,
        //    D2 撤码方向闸照样拒非 SA → 30103。少了 ① 那一步,这里测到的会是上层那道闸。
        const res = await putAs(adminAuth, roleId, {
          permissionCodes: [],
          expectedRevision: 0,
          stepUpToken: await mintStepUpToken(adminAuth, roleId, 0, []),
        });
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

    it('SUPER_ADMIN 撤销同一控制面码 → 带 proof 后 200(短路语义不变)', async () => {
      const { roleId } = await setupRoleAndPermissions({
        roleCode: 'eb2-su-control-plane',
        permCodes: [],
      });
      await seedControlPlaneBinding(roleId);

      const res = await putAs(superAdminAuth, roleId, {
        permissionCodes: [],
        expectedRevision: 0,
        stepUpToken: await mintStepUpToken(superAdminAuth, roleId, 0, []),
      });
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

      // 用写接口授权(走 service 完整路径;PR 8 前这里是 POST)
      await putAs(superAdminAuth, roleId, {
        permissionCodes: perms.map((p) => p.code),
        expectedRevision: 0,
      });

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

    it('授权后持有者下一次解析立即获得权限', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'db-visible-post',
        permCodes: ['db.post.visible'],
      });
      const user = await createBoundUser('rp-db-post', roleId);
      await expect(rbac.getUserPermissionCodes(user.id)).resolves.toEqual(new Set());

      await putAs(superAdminAuth, roleId, {
        permissionCodes: [perms[0].code],
        expectedRevision: 0,
      });

      await expect(rbac.getUserPermissionCodes(user.id)).resolves.toEqual(
        new Set(['db.post.visible']),
      );
    });

    it('撤权后持有者下一次解析立即失去权限', async () => {
      const { roleId, perms } = await setupRoleAndPermissions({
        roleCode: 'db-visible-delete',
        permCodes: ['db.delete.visible'],
      });
      await putAs(superAdminAuth, roleId, {
        permissionCodes: [perms[0].code],
        expectedRevision: 0,
      });
      const user = await createBoundUser('rp-db-delete', roleId);
      await expect(rbac.getUserPermissionCodes(user.id)).resolves.toEqual(
        new Set(['db.delete.visible']),
      );

      await putAs(superAdminAuth, roleId, { permissionCodes: [], expectedRevision: 1 });

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
    // ⚠️ `putAs` / `codeSetOf` / `revisionOf` 原是本 describe 的私有 helper;
    //    P1-32 PR 8 后整份 spec 都要用它们(旧 POST / DELETE 的用例全改打 PUT),
    //    已提到顶层 describe。这里只留本组独用的 `auditCountOf`。
    async function auditCountOf(roleId: string): Promise<number> {
      return prisma.auditLog.count({
        where: { resourceType: 'role_permission', resourceId: roleId },
      });
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

    // ---------- 每一次真写都推进版本号(乐观并发的正确性前提) ----------

    // 🔴 **主语随端点消失的标记用例(P1-32 PR 8)—— 原题是「POST / DELETE 同样 +1」。**
    //    它当年要证的是「+1 覆盖**全部**写路径」,因为那时有三条写入口;
    //    PR 8 退役 POST / DELETE 之后**写入口只剩 PUT 一条**,「全部写路径」= 它自己,
    //    那半个命题在结构上不再有内容。⇒ **不删**,就地收成仍然成立的那半:
    //    每一次真写都 +1,拿旧版本号回来提交必被拒。
    //    ⚠️ 丢掉的是「旧增量入口也 +1」这一条 —— 登记见 NEXT_TASKS P1-32 PR 8。
    it('每次真写都 +1,拿过期版本号回来提交 → 30111', async () => {
      const { roleId } = await setupRoleAndPermissions({
        roleCode: 'put-legacy-bumps',
        permCodes: ['legacy.a.x'],
      });
      expect(await revisionOf(roleId)).toBe(0);

      await putAs(superAdminAuth, roleId, {
        permissionCodes: ['legacy.a.x'],
        expectedRevision: 0,
      });
      expect(await revisionOf(roleId)).toBe(1);

      await putAs(superAdminAuth, roleId, { permissionCodes: [], expectedRevision: 1 });
      expect(await revisionOf(roleId)).toBe(2);

      // 拿着最初的版本号提交 → 必须被拒
      const res = await putAs(superAdminAuth, roleId, {
        permissionCodes: [],
        expectedRevision: 0,
      });
      expectBizError(res, BizCode.ROLE_PERMISSION_REVISION_CONFLICT);
    });

    // 🔴 **契约变化,不是 bug**(P1-32 PR 4a):重复提交同一目标集是真正的空转 ——
    //    不写、不 +1、**也不再产生 audit**。请求 / 响应形状一字未变(200 + detail)。
    //    ⚠️ PR 8 前本条打的是已退役的 POST(状态码 201);改打 PUT 后语义与断言逐条对应,
    //       只有状态码随 PUT 契约变成 200。
    it('重复提交同一目标集(纯空转)→ 200 但不 +1、不产生 audit(P1-32 PR 4a 起)', async () => {
      const { roleId } = await setupRoleAndPermissions({
        roleCode: 'put-post-noop',
        permCodes: ['pn.a.x'],
      });
      await putAs(superAdminAuth, roleId, {
        permissionCodes: ['pn.a.x'],
        expectedRevision: 0,
      });
      const revAfterFirst = await revisionOf(roleId);
      const auditAfterFirst = await auditCountOf(roleId);
      expect(revAfterFirst).toBe(1);
      expect(auditAfterFirst).toBe(1);

      const again = await putAs(superAdminAuth, roleId, {
        permissionCodes: ['pn.a.x'],
        expectedRevision: 1,
      });
      expect(again.status).toBe(200); // 形状不变
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

    // P1-32 PR 5(2026-08-24)起本条**多一道正交要求**:撤掉控制面码属高风险差异 ⇒ 要二次验证。
    //
    // 🔴 **本条守的不变量一个字没变** —— 「撤码侧对 SUPER_ADMIN 开着」(那是历史脏数据的
    //    唯一清理路)。step-up **不抹平那条不对称**,它只是要求先证明「确实是本人在操作」。
    //    ⇒ 断言从「200」扩成「不带 proof 必 30112 / 带 proof 仍 200」,**比原来更严,没有放宽**。
    //
    // ⚠️ 「撤码也要 step-up」不是本刀的发明:冻结稿 §12.1 第一条逐字是
    //    「**增加或移除** `CRITICAL` 权限」。damage 方向相反但同属高风险变更 ——
    //    把终审 / 控制面能力从一批人手上撤掉,与授出去一样危险。
    it('SUPER_ADMIN 用 PUT 撤掉控制面码:不带 proof → 30112,带 proof → 200(撤码侧的刻意不对称没有被抹平)', async () => {
      const { roleId } = await setupRoleAndPermissions({
        roleCode: 'put-su-drop-control-plane',
        permCodes: [],
      });
      const perm = await prisma.permission.findUniqueOrThrow({
        where: { code: 'rbac.role.read' },
        select: { id: true },
      });
      await prisma.rolePermission.create({ data: { roleId, permissionId: perm.id } });

      // ① 不带 proof:高风险差集 ⇒ 30112。**且一个字节都没写**(权限集原样、版本号不动)。
      const without = await putAs(superAdminAuth, roleId, {
        permissionCodes: [],
        expectedRevision: 0,
      });
      expectBizError(without, BizCode.ROLE_PERMISSION_STEP_UP_REQUIRED);
      expect(await codeSetOf(roleId)).toEqual(new Set(['rbac.role.read']));
      expect(await revisionOf(roleId)).toBe(0);

      // ② 换一条真 proof 再来。⭐ `payloadHash` 在这里**独立实现一遍**(去重 → 升序 →
      //    JSON.stringify → sha256 → base64url),不 import 服务端那个函数 ——
      //    这样它同时验证了 `docs/handoff/admin-web.md` §3.5 写给前端的算法是可实现的。
      const payloadHash = createHash('sha256')
        .update(JSON.stringify([...new Set<string>([])].sort()))
        .digest('base64url');
      const stepUp = await request(httpServer(app))
        .post('/api/auth/v1/step-up/password')
        .set('Authorization', superAdminAuth)
        .send({
          action: 'RBAC_ROLE_PERMISSION_SET_REPLACE',
          password: TEST_PASSWORD,
          rolePermissionSet: { roleId, expectedRevision: 0, payloadHash },
        });
      expect(stepUp.status).toBe(200);
      const stepUpToken: string = stepUp.body.data.stepUpToken;

      const res = await putAs(superAdminAuth, roleId, {
        permissionCodes: [],
        expectedRevision: 0,
        stepUpToken,
      });
      expect(res.status).toBe(200);
      expect(await codeSetOf(roleId)).toEqual(new Set());
    });

    // 🔴 反向对照(与上面那条同等重要):proof **不能跨角色复用**。
    //    少了它,一个「只要带了任意 proof 就放行」的实现会让上面那条照样绿。
    it('SUPER_ADMIN 拿 A 角色的 proof 去撤 B 角色的控制面码 → 10008(proof 绑死 roleId)', async () => {
      const perm = await prisma.permission.findUniqueOrThrow({
        where: { code: 'rbac.role.read' },
        select: { id: true },
      });
      const a = await setupRoleAndPermissions({ roleCode: 'put-proof-role-a', permCodes: [] });
      const b = await setupRoleAndPermissions({ roleCode: 'put-proof-role-b', permCodes: [] });
      await prisma.rolePermission.create({ data: { roleId: b.roleId, permissionId: perm.id } });

      const payloadHash = createHash('sha256')
        .update(JSON.stringify([...new Set<string>([])].sort()))
        .digest('base64url');
      // 为 **A** 角色签的 proof —— 除 roleId 外,expectedRevision 与 payloadHash 与 B 那次逐字相同。
      const stepUp = await request(httpServer(app))
        .post('/api/auth/v1/step-up/password')
        .set('Authorization', superAdminAuth)
        .send({
          action: 'RBAC_ROLE_PERMISSION_SET_REPLACE',
          password: TEST_PASSWORD,
          rolePermissionSet: { roleId: a.roleId, expectedRevision: 0, payloadHash },
        });
      expect(stepUp.status).toBe(200);

      const res = await putAs(superAdminAuth, b.roleId, {
        permissionCodes: [],
        expectedRevision: 0,
        stepUpToken: stepUp.body.data.stepUpToken,
      });
      expectBizError(res, BizCode.STEP_UP_PROOF_INVALID);
      expect(await codeSetOf(b.roleId)).toEqual(new Set(['rbac.role.read']));
      expect(await revisionOf(b.roleId)).toBe(0);
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

      // 🔴 反向对照,**不能省**:少了它,一个「这人啥都不能干」的实现也会让上面那条绿。
      //
      // ⚠️ **P1-32 PR 8 迁移说明 —— 这条是换轴,不是放宽**。原先的反向对照是
      //    「同一个人用 POST(只需 create)必须真的成功」;POST 退役后,只持 create
      //    的人在本模块**确实什么都写不了**(那正是收成单一写入口的目的)⇒ 原对照的前提没了。
      //    换成**在同一维上单独不同**的样本:给这个人补上另一半码 `delete`,
      //    同一条 PUT 必须**真的成功**。这证明拒绝来自 `require:'all'` 少了一半,
      //    而不是「一律拒绝」;比原来多钉一条 —— 两半齐全才放行。
      const deletePerm = await prisma.permission.findUniqueOrThrow({
        where: { code: 'rbac.role-permission.delete' },
        select: { id: true },
      });
      await prisma.rolePermission.create({
        data: { roleId: halfRole.id, permissionId: deletePerm.id },
      });

      const bothHalves = await putAs(halfAuth, roleId, {
        permissionCodes: [],
        expectedRevision: 0,
      });
      expect(bothHalves.status).toBe(200);
      expect(await codeSetOf(roleId)).toEqual(new Set());
    });
  });
});
