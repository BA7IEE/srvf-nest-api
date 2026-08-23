import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import * as configAudit from '../../src/modules/permissions/config-audit.util';
import { PermissionsService } from '../../src/modules/permissions/permissions.service';
import { RbacRolesService } from '../../src/modules/permissions/rbac-roles.service';
import { RolePermissionsService } from '../../src/modules/permissions/role-permissions.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// permissions RBAC 授权配置写面 audit characterization
// (第三轮全仓 review v0.38.0 §F&A-2 → NEXT_TASKS P1-19;沿 organizations-audit-characterization /
//  attachments-audit-characterization spec 范式)。
//
// 目标:锁定 3 服务 8 写点新增 audit 的 payload 形状(event / resourceType / before-after-extra),
// 并证明每写点 inline-in-transaction(经 writeConfigAudit 传 tx)——audit 写失败 → 整个 $transaction 回滚。
//
// 与既有 audit-characterization spec 的差异:organizations/attachments 注入 AuditLogsService,故 rollback
// case spy `auditLogs.log`;permissions 三服务为避免 PermissionsModule↔AuditLogsModule 模块环改**直写**
// auditLog(见 permissions/config-audit.util.ts),故 rollback case 改 spy 该模块函数 writeConfigAudit
// (CommonJS 下 service 调用点在运行时读取模块对象属性,spy 生效)。
//
// 测试策略:service-level e2e,createTestApp() + app.get(Service) 直接调用,绕过 HTTP / JwtAuthGuard;
// actor 用 SUPER_ADMIN payload(RbacService.can 对 SUPER_ADMIN 恒短路,不需额外 RBAC seed)。
//
// 覆盖矩阵:
//   A. rbac-role.{create,update,delete}
//   B. role-permission.{grant,revoke}
//   C. permission.{create,update,delete}
//   D. audit failure → $transaction 回滚(每服务一例:无实体变更 + 无 audit 残留)

const AUDIT_META: AuditMeta = {
  requestId: 'perm-config-audit-req-0000000001',
  ip: '127.0.0.1',
  ua: 'jest/30 permissions-config-audit-characterization',
};

interface ReadAuditContext<E = Record<string, unknown>> {
  requestId: string;
  ip: string | null;
  ua: string | null;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  extra?: E;
}

describe('permissions config-audit characterization (F&A-2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let rbacRoles: RbacRolesService;
  let rolePermissions: RolePermissionsService;
  let permissions: PermissionsService;
  let adminUserId: string;
  let actor: CurrentUserPayload;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    rbacRoles = app.get(RbacRolesService);
    rolePermissions = app.get(RolePermissionsService);
    permissions = app.get(PermissionsService);

    const admin = await prisma.user.create({
      data: {
        username: 'perm-config-audit-admin',
        passwordHash: '$2a$10$dummy-hash-not-used-since-no-login-needed',
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      },
      select: { id: true },
    });
    adminUserId = admin.id;
    actor = {
      id: admin.id,
      username: 'perm-config-audit-admin',
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      memberId: null,
    };
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // 每 case 清:RolePermission + RbacRole + Permission + AuditLog;保留 User。
  async function isolate(): Promise<void> {
    await prisma.rolePermission.deleteMany({});
    await prisma.auditLog.deleteMany({});
    await prisma.rbacRole.deleteMany({});
    await prisma.permission.deleteMany({});
  }

  function assertCommon(
    a: {
      resourceType: string;
      actorUserId: string | null;
      actorRoleSnap: Role | null;
      success: boolean;
    },
    resourceType: string,
  ): void {
    expect(a.resourceType).toBe(resourceType);
    expect(a.actorUserId).toBe(adminUserId);
    expect(a.actorRoleSnap).toBe(Role.SUPER_ADMIN);
    expect(a.success).toBe(true); // AuditLog.success @default(true);直写不显式设,取默认
  }

  function assertMeta(c: ReadAuditContext): void {
    expect(c.requestId).toBe(AUDIT_META.requestId);
    expect(c.ip).toBe(AUDIT_META.ip);
    expect(c.ua).toBe(AUDIT_META.ua);
  }

  // ============ A. rbac-role.{create,update,delete} ============
  describe('A. rbac-role', () => {
    beforeEach(isolate);

    it('A1. create → event=rbac-role.create + after 快照 + before 缺席', async () => {
      const role = await rbacRoles.create(
        actor,
        { code: 'audit-role-a', displayName: '审计角色A', description: '初始' },
        AUDIT_META,
      );
      const audits = await prisma.auditLog.findMany({ where: { event: 'rbac-role.create' } });
      expect(audits).toHaveLength(1);
      const a = audits[0];
      assertCommon(a, 'rbac_role');
      expect(a.resourceId).toBe(role.id);
      const c = a.context as unknown as ReadAuditContext;
      assertMeta(c);
      expect(c.before).toBeUndefined();
      expect(c.after).toMatchObject({
        code: 'audit-role-a',
        displayName: '审计角色A',
        description: '初始',
      });
    });

    it('A2. update → event=rbac-role.update + before/after', async () => {
      const role = await rbacRoles.create(
        actor,
        { code: 'audit-role-b', displayName: '旧名', description: '旧述' },
        AUDIT_META,
      );
      await rbacRoles.update(
        actor,
        role.id,
        { displayName: '新名', description: '新述' },
        AUDIT_META,
      );
      const audits = await prisma.auditLog.findMany({ where: { event: 'rbac-role.update' } });
      expect(audits).toHaveLength(1);
      const a = audits[0];
      assertCommon(a, 'rbac_role');
      expect(a.resourceId).toBe(role.id);
      const c = a.context as unknown as ReadAuditContext;
      expect(c.before).toMatchObject({ displayName: '旧名', description: '旧述' });
      expect(c.after).toMatchObject({ displayName: '新名', description: '新述' });
    });

    it('A3. softDelete → event=rbac-role.delete + before 快照 + after 缺席', async () => {
      const role = await rbacRoles.create(
        actor,
        { code: 'audit-role-c', displayName: '待删角色' },
        AUDIT_META,
      );
      await rbacRoles.softDelete(actor, role.id, AUDIT_META);
      const audits = await prisma.auditLog.findMany({ where: { event: 'rbac-role.delete' } });
      expect(audits).toHaveLength(1);
      const a = audits[0];
      assertCommon(a, 'rbac_role');
      expect(a.resourceId).toBe(role.id);
      const c = a.context as unknown as ReadAuditContext;
      expect(c.before).toMatchObject({ code: 'audit-role-c', displayName: '待删角色' });
      expect(c.after).toBeUndefined();
    });
  });

  // ============ B. role-permission.{grant,revoke} ============
  describe('B. role-permission', () => {
    beforeEach(isolate);

    async function seedRoleAndPerm(): Promise<{ roleId: string; permId: string; code: string }> {
      const role = await rbacRoles.create(
        actor,
        { code: 'audit-rp-role', displayName: 'RP角色' },
        AUDIT_META,
      );
      const code = 'audit-test.read.widget';
      const perm = await prisma.permission.create({
        data: { code, module: 'audit-test', action: 'read', resourceType: 'widget' },
        select: { id: true },
      });
      return { roleId: role.id, permId: perm.id, code };
    }

    it('B1. grant → event=role-permission.grant + extra.{operation,permissionCodes,requestedCount}', async () => {
      const { roleId, code } = await seedRoleAndPerm();
      await rolePermissions.assign(actor, roleId, { permissionCodes: [code] }, AUDIT_META);
      const audits = await prisma.auditLog.findMany({ where: { event: 'role-permission.grant' } });
      expect(audits).toHaveLength(1);
      const a = audits[0];
      assertCommon(a, 'role_permission');
      expect(a.resourceId).toBe(roleId); // resourceId = roleId(非 rolePermission 行 id)
      const c = a.context as unknown as ReadAuditContext<{
        operation: string;
        permissionCodes: string[];
        requestedCount: number;
      }>;
      assertMeta(c);
      expect(c.extra?.operation).toBe('grant');
      expect(c.extra?.permissionCodes).toEqual([code]);
      expect(c.extra?.requestedCount).toBe(1);
    });

    it('B2. revoke → event=role-permission.revoke + extra.permissionId', async () => {
      const { roleId, permId, code } = await seedRoleAndPerm();
      await rolePermissions.assign(actor, roleId, { permissionCodes: [code] }, AUDIT_META);
      await rolePermissions.revoke(actor, roleId, permId, AUDIT_META);
      const audits = await prisma.auditLog.findMany({ where: { event: 'role-permission.revoke' } });
      expect(audits).toHaveLength(1);
      const a = audits[0];
      assertCommon(a, 'role_permission');
      expect(a.resourceId).toBe(roleId);
      const c = a.context as unknown as ReadAuditContext<{
        operation: string;
        permissionId: string;
      }>;
      expect(c.extra?.operation).toBe('revoke');
      expect(c.extra?.permissionId).toBe(permId);
    });
  });

  // ============ C. permission.{create,update,delete} ============
  describe('C. permission', () => {
    beforeEach(isolate);

    // 权限目录护栏(2026-08-22)后 create 只接受 seed 闭包内的码。
    // `isolate()` 已把 permissions 表清空,故这里用真码也不会撞唯一约束 ——
    // 换码不改本组要刻画的东西(audit 事件名 / before-after 快照形状)。
    it('C1. create → event=permission.create + after 快照 + before 缺席', async () => {
      const perm = await permissions.create(
        actor,
        { code: 'member.read.record', module: 'member', action: 'read', resourceType: 'record' },
        AUDIT_META,
      );
      const audits = await prisma.auditLog.findMany({ where: { event: 'permission.create' } });
      expect(audits).toHaveLength(1);
      const a = audits[0];
      assertCommon(a, 'permission');
      expect(a.resourceId).toBe(perm.id);
      const c = a.context as unknown as ReadAuditContext;
      assertMeta(c);
      expect(c.before).toBeUndefined();
      expect(c.after).toMatchObject({
        code: 'member.read.record',
        module: 'member',
        action: 'read',
        resourceType: 'record',
      });
    });

    // 权限目录护栏(P1-32 PR 3b,2026-08-23)后 update 只对**闭包外**的码可达
    // (闭包内一律 30110)。而闭包外的码又造不出来(30106)⇒ 被改对象改由 prisma 直建,
    // 与下面 C3 处理 delete 时是**同一手法**。
    // 刻画的对象没变:走的仍是 `PermissionsService.update` 那条 audit 路径。
    it('C2. update → event=permission.update + before/after.description', async () => {
      const perm = await prisma.permission.create({
        data: {
          code: 'audit-c.update.thing',
          module: 'audit-c',
          action: 'update',
          resourceType: 'thing',
          description: '旧述',
        },
        select: { id: true },
      });
      await permissions.update(actor, perm.id, { description: '新述' }, AUDIT_META);
      const audits = await prisma.auditLog.findMany({ where: { event: 'permission.update' } });
      expect(audits).toHaveLength(1);
      const a = audits[0];
      assertCommon(a, 'permission');
      const c = a.context as unknown as ReadAuditContext;
      expect(c.before).toMatchObject({ description: '旧述' });
      expect(c.after).toMatchObject({ description: '新述' });
    });

    // 🔴 C2 曾经是「拿一条 **seed 闭包内**的码(member.update.record)改 description 并成功」。
    //    P1-32 PR 3b 把那条路关上了。本用例保留「这条路曾经通」这个事实:
    //    同样的动作、同样的闭包内码,现在必须被拒(30110),而不是把它从测试里删掉。
    //    ⚠️ 这不是补一道漏接的闸,是**推翻一条刻意设计** —— 见 biz-code 30110 注释块。
    it('C2b. update 对 seed 闭包内的码一律拒(30110;曾经可成功,PR 3b 关上)', async () => {
      const perm = await prisma.permission.create({
        data: {
          code: 'member.update.record',
          module: 'member',
          action: 'update',
          resourceType: 'record',
          description: '旧述',
        },
        select: { id: true },
      });
      await expect(
        permissions.update(actor, perm.id, { description: '新述' }, AUDIT_META),
      ).rejects.toMatchObject({ biz: BizCode.SEED_PERMISSION_UPDATE_FORBIDDEN });

      // 拒绝必须是**真的没写**:既没改行,也没留 audit。
      const after = await prisma.permission.findUnique({
        where: { id: perm.id },
        select: { description: true },
      });
      expect(after?.description).toBe('旧述');
      expect(await prisma.auditLog.count({ where: { event: 'permission.update' } })).toBe(0);
    });

    // 权限目录护栏(2026-08-22)后 delete 只对**闭包外**的码可达(闭包内一律 30105)。
    // 而闭包外的码又造不出来(30106)⇒ 被删对象改由 prisma 直建。
    // 刻画的对象没变:走的仍是 `PermissionsService.delete` 那条 audit 路径。
    it('C3. delete → event=permission.delete + before 快照', async () => {
      const perm = await prisma.permission.create({
        data: {
          code: 'audit-c.delete.thing',
          module: 'audit-c',
          action: 'delete',
          resourceType: 'thing',
        },
        select: { id: true },
      });
      await permissions.delete(actor, perm.id, AUDIT_META);
      const audits = await prisma.auditLog.findMany({ where: { event: 'permission.delete' } });
      expect(audits).toHaveLength(1);
      const a = audits[0];
      assertCommon(a, 'permission');
      const c = a.context as unknown as ReadAuditContext;
      expect(c.before).toMatchObject({
        code: 'audit-c.delete.thing',
        module: 'audit-c',
        action: 'delete',
        resourceType: 'thing',
      });
    });
  });

  // ============ D. audit failure → $transaction 回滚(零残留) ============
  describe('D. audit failure rollback', () => {
    beforeEach(isolate);

    it('D1. rbac-role.create 路径 writeConfigAudit 抛错 → 无新角色 + 无 audit', async () => {
      jest
        .spyOn(configAudit, 'writeConfigAudit')
        .mockRejectedValueOnce(new Error('simulated audit failure'));
      await expect(
        rbacRoles.create(
          actor,
          { code: 'audit-rollback-role', displayName: '回滚角色' },
          AUDIT_META,
        ),
      ).rejects.toThrow('simulated audit failure');

      const role = await prisma.rbacRole.findUnique({ where: { code: 'audit-rollback-role' } });
      expect(role).toBeNull(); // 回滚:未建
      expect(await prisma.auditLog.count()).toBe(0);
    });

    it('D2. permission.create 路径 writeConfigAudit 抛错 → 无新权限点 + 无 audit', async () => {
      jest
        .spyOn(configAudit, 'writeConfigAudit')
        .mockRejectedValueOnce(new Error('simulated audit failure'));
      await expect(
        permissions.create(
          actor,
          {
            code: 'member.create.record',
            module: 'member',
            action: 'create',
            resourceType: 'record',
          },
          AUDIT_META,
        ),
      ).rejects.toThrow('simulated audit failure');

      const perm = await prisma.permission.findUnique({
        where: { code: 'member.create.record' },
      });
      expect(perm).toBeNull();
      expect(await prisma.auditLog.count()).toBe(0);
    });

    it('D3. role-permission.grant 路径 writeConfigAudit 抛错 → 无 RolePermission + 无 audit', async () => {
      const role = await rbacRoles.create(
        actor,
        { code: 'audit-rollback-rp-role', displayName: 'RP回滚' },
        AUDIT_META,
      );
      const perm = await prisma.permission.create({
        data: {
          code: 'audit-rollback-rp.read.x',
          module: 'audit-rollback-rp',
          action: 'read',
          resourceType: 'x',
        },
        select: { id: true },
      });
      await prisma.auditLog.deleteMany({}); // 清掉上面 create role 的 audit,便于断言零残留

      jest
        .spyOn(configAudit, 'writeConfigAudit')
        .mockRejectedValueOnce(new Error('simulated audit failure'));
      await expect(
        rolePermissions.assign(
          actor,
          role.id,
          { permissionCodes: ['audit-rollback-rp.read.x'] },
          AUDIT_META,
        ),
      ).rejects.toThrow('simulated audit failure');

      const rp = await prisma.rolePermission.findUnique({
        where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } },
      });
      expect(rp).toBeNull(); // 回滚:未授予
      expect(await prisma.auditLog.count()).toBe(0);
    });
  });
});
