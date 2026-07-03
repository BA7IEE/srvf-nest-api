import type { INestApplication } from '@nestjs/common';
import { OrganizationStatus, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { PrismaService } from '../../src/database/prisma.service';
import { AuditLogsService } from '../../src/modules/audit-logs/audit-logs.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { OrganizationsService } from '../../src/modules/organizations/organizations.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// organizations audit characterization tests
// (review #484 G18 → NEXT_TASKS P1-16;沿 memberships-audit-characterization spec 范式)。
//
// 目标:锁定 organizations.service.ts(create/move/updateStatus/softDelete)四处新增
// `auditLogs.log(...)` 调用的 payload 形状(event / resourceType / before-after),并证明:
//   - update(PATCH)不写 audit(锁定设计,非遗漏;详见 src/modules/organizations/CLAUDE.md)
//   - move 同父幂等 no-op 分支不写 audit(无实际变更)
//   - 4 处写点均 inline-in-transaction(tx 传参)——audit 写失败 → 整个 $transaction 回滚
//
// 测试策略:service-level e2e,`createTestApp()` + `app.get(XxxService)` 直接调用,绕过 HTTP /
// JwtAuthGuard;actor 用 SUPER_ADMIN payload(RbacService.can 对 SUPER_ADMIN 恒短路,不需额外 RBAC seed)。
//
// 覆盖矩阵:
//   A. create audit shape(after 快照,before 缺席)
//   B. move audit shape(before/after.parentId;同父幂等 no-op 分支 0 条新 audit)
//   C. updateStatus audit shape(before/after.status)
//   D. softDelete audit shape(仅 before 快照,无 after)
//   E. update(PATCH)不写 audit
//   F. audit failure → $transaction 回滚(4 处写点各一例)

const AUDIT_META: AuditMeta = {
  requestId: 'org-audit-charac-req-0000000001',
  ip: '127.0.0.1',
  ua: 'jest/30 organizations-audit-characterization',
};

const RESOURCE_TYPE = 'organization';
const NODE_TYPE_CODE = 'org-audit-type';

interface ReadAuditContext<E extends Record<string, unknown> = Record<string, unknown>> {
  requestId: string;
  ip: string | null;
  ua: string | null;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  extra?: E;
}

type OperationExtra = { operation?: string };

interface SeedContext {
  prisma: PrismaService;
  organizations: OrganizationsService;
  auditLogs: AuditLogsService;
  adminUserId: string;
  adminPayload: CurrentUserPayload;
}

describe('organizations audit characterization', () => {
  let app: INestApplication;
  let ctx: SeedContext;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);

    const prisma = app.get(PrismaService);
    const organizations = app.get(OrganizationsService);
    const auditLogs = app.get(AuditLogsService);

    const admin = await prisma.user.create({
      data: {
        username: 'org-audit-admin',
        passwordHash: '$2a$10$dummy-hash-not-used-since-no-login-needed',
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      },
      select: { id: true },
    });

    const nodeDict = await prisma.dictType.create({
      data: { code: 'node_type', label: '节点类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeDict.id, code: NODE_TYPE_CODE, label: '测试类型' },
    });

    ctx = {
      prisma,
      organizations,
      auditLogs,
      adminUserId: admin.id,
      adminPayload: {
        id: admin.id,
        username: 'org-audit-admin',
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
        memberId: null,
      },
    };
  });

  afterAll(async () => {
    await app.close();
  });

  // 每个 case 清:Organization + OrganizationClosure + AuditLog;保留 User / DictType / DictItem。
  async function isolateFixtures(): Promise<void> {
    await ctx.prisma.organizationClosure.deleteMany({});
    await ctx.prisma.organization.deleteMany({});
    await ctx.prisma.auditLog.deleteMany({});
  }

  function assertCommonAuditMetaFields(a: {
    event: string;
    resourceType: string;
    actorUserId: string | null;
    actorRoleSnap: Role | null;
    success: boolean;
  }): void {
    expect(a.resourceType).toBe(RESOURCE_TYPE);
    expect(a.actorUserId).toBe(ctx.adminUserId);
    expect(a.actorRoleSnap).toBe(Role.SUPER_ADMIN);
    expect(a.success).toBe(true);
  }

  function assertContextMeta(c: ReadAuditContext): void {
    expect(c.requestId).toBe(AUDIT_META.requestId);
    expect(c.ip).toBe(AUDIT_META.ip);
    expect(c.ua).toBe(AUDIT_META.ua);
  }

  // ============ A. create audit shape ============
  describe('A. create audit shape', () => {
    beforeEach(isolateFixtures);

    it('A1. event=organization.create + after 快照 + before 缺席', async () => {
      const result = await ctx.organizations.create(
        ctx.adminPayload,
        { name: 'Org Root A', nodeTypeCode: NODE_TYPE_CODE, sortOrder: 3 },
        AUDIT_META,
      );

      const audits = await ctx.prisma.auditLog.findMany({
        where: { event: 'organization.create' },
      });
      expect(audits).toHaveLength(1);
      const a = audits[0];
      assertCommonAuditMetaFields(a);
      expect(a.resourceId).toBe(result.id);

      const c = a.context as unknown as ReadAuditContext<OperationExtra>;
      assertContextMeta(c);
      expect(c.before).toBeUndefined();
      expect(c.after).toBeDefined();
      const after = c.after as {
        name: string;
        parentId: string | null;
        nodeTypeCode: string;
        sortOrder: number;
        status: string;
      };
      expect(after.name).toBe('Org Root A');
      expect(after.parentId).toBeNull();
      expect(after.nodeTypeCode).toBe(NODE_TYPE_CODE);
      expect(after.sortOrder).toBe(3);
      expect(after.status).toBe('ACTIVE');
      expect(c.extra).toEqual({ operation: 'create' });
    });
  });

  // ============ B. move audit shape ============
  describe('B. move audit shape', () => {
    beforeEach(isolateFixtures);

    it('B1. event=organization.move + before/after.parentId', async () => {
      const root = await ctx.organizations.create(
        ctx.adminPayload,
        { name: 'Root', nodeTypeCode: NODE_TYPE_CODE },
        AUDIT_META,
      );
      const parent1 = await ctx.organizations.create(
        ctx.adminPayload,
        { name: 'Parent 1', nodeTypeCode: NODE_TYPE_CODE, parentId: root.id },
        AUDIT_META,
      );
      const parent2 = await ctx.organizations.create(
        ctx.adminPayload,
        { name: 'Parent 2', nodeTypeCode: NODE_TYPE_CODE, parentId: root.id },
        AUDIT_META,
      );
      const child = await ctx.organizations.create(
        ctx.adminPayload,
        { name: 'Child', nodeTypeCode: NODE_TYPE_CODE, parentId: parent1.id },
        AUDIT_META,
      );
      await ctx.prisma.auditLog.deleteMany({}); // 只留 move 这一条

      await ctx.organizations.move(
        ctx.adminPayload,
        child.id,
        { parentId: parent2.id },
        AUDIT_META,
      );

      const audits = await ctx.prisma.auditLog.findMany({ where: { event: 'organization.move' } });
      expect(audits).toHaveLength(1);
      const a = audits[0];
      assertCommonAuditMetaFields(a);
      expect(a.resourceId).toBe(child.id);

      const c = a.context as unknown as ReadAuditContext<OperationExtra>;
      assertContextMeta(c);
      expect(c.before).toEqual({ parentId: parent1.id });
      expect(c.after).toEqual({ parentId: parent2.id });
      expect(c.extra).toEqual({ operation: 'move' });
    });

    it('B2. 同父幂等 no-op → 0 条新 audit(无实际变更)', async () => {
      const root = await ctx.organizations.create(
        ctx.adminPayload,
        { name: 'Root', nodeTypeCode: NODE_TYPE_CODE },
        AUDIT_META,
      );
      const parent1 = await ctx.organizations.create(
        ctx.adminPayload,
        { name: 'Parent 1', nodeTypeCode: NODE_TYPE_CODE, parentId: root.id },
        AUDIT_META,
      );
      const child = await ctx.organizations.create(
        ctx.adminPayload,
        { name: 'Child', nodeTypeCode: NODE_TYPE_CODE, parentId: parent1.id },
        AUDIT_META,
      );
      await ctx.prisma.auditLog.deleteMany({});

      await ctx.organizations.move(
        ctx.adminPayload,
        child.id,
        { parentId: parent1.id },
        AUDIT_META,
      );

      const audits = await ctx.prisma.auditLog.findMany({ where: { event: 'organization.move' } });
      expect(audits).toHaveLength(0);
    });
  });

  // ============ C. updateStatus audit shape ============
  describe('C. updateStatus audit shape', () => {
    beforeEach(isolateFixtures);

    it('C1. event=organization.status-change + before/after.status', async () => {
      const root = await ctx.organizations.create(
        ctx.adminPayload,
        { name: 'Root', nodeTypeCode: NODE_TYPE_CODE },
        AUDIT_META,
      );
      const child = await ctx.organizations.create(
        ctx.adminPayload,
        { name: 'Child', nodeTypeCode: NODE_TYPE_CODE, parentId: root.id },
        AUDIT_META,
      );
      await ctx.prisma.auditLog.deleteMany({});

      await ctx.organizations.updateStatus(
        ctx.adminPayload,
        child.id,
        { status: OrganizationStatus.INACTIVE },
        AUDIT_META,
      );

      const audits = await ctx.prisma.auditLog.findMany({
        where: { event: 'organization.status-change' },
      });
      expect(audits).toHaveLength(1);
      const a = audits[0];
      assertCommonAuditMetaFields(a);
      expect(a.resourceId).toBe(child.id);

      const c = a.context as unknown as ReadAuditContext<OperationExtra>;
      assertContextMeta(c);
      expect(c.before).toEqual({ status: 'ACTIVE' });
      expect(c.after).toEqual({ status: 'INACTIVE' });
      expect(c.extra).toEqual({ operation: 'status-change' });
    });
  });

  // ============ D. softDelete audit shape ============
  describe('D. softDelete audit shape', () => {
    beforeEach(isolateFixtures);

    it('D1. event=organization.delete + 仅 before 快照(无 after)', async () => {
      const root = await ctx.organizations.create(
        ctx.adminPayload,
        { name: 'Root', nodeTypeCode: NODE_TYPE_CODE },
        AUDIT_META,
      );
      const child = await ctx.organizations.create(
        ctx.adminPayload,
        { name: 'Child', nodeTypeCode: NODE_TYPE_CODE, parentId: root.id },
        AUDIT_META,
      );
      await ctx.prisma.auditLog.deleteMany({});

      await ctx.organizations.softDelete(ctx.adminPayload, child.id, AUDIT_META);

      const audits = await ctx.prisma.auditLog.findMany({
        where: { event: 'organization.delete' },
      });
      expect(audits).toHaveLength(1);
      const a = audits[0];
      assertCommonAuditMetaFields(a);
      expect(a.resourceId).toBe(child.id);

      const c = a.context as unknown as ReadAuditContext<OperationExtra>;
      assertContextMeta(c);
      expect(c.before).toEqual({ status: 'ACTIVE', parentId: root.id });
      expect(c.after).toBeUndefined();
      expect(c.extra).toEqual({ operation: 'delete' });
    });
  });

  // ============ E. update(PATCH)不写 audit ============
  describe('E. update(PATCH)不写 audit', () => {
    beforeEach(isolateFixtures);

    it('E1. 改 name/sortOrder/nodeTypeCode 成功 → 0 条新 audit(锁定设计,非遗漏)', async () => {
      const root = await ctx.organizations.create(
        ctx.adminPayload,
        { name: 'Root', nodeTypeCode: NODE_TYPE_CODE },
        AUDIT_META,
      );
      await ctx.prisma.auditLog.deleteMany({});

      await ctx.organizations.update(ctx.adminPayload, root.id, {
        name: '改名后',
        sortOrder: 9,
      });

      const audits = await ctx.prisma.auditLog.findMany({});
      expect(audits).toHaveLength(0);
    });
  });

  // ============ F. Audit failure rollback(4 处写点各一例) ============
  describe('F. audit failure rollback', () => {
    beforeEach(isolateFixtures);

    it('F1. create 路径 auditLogs.log 抛错 → $transaction 回滚:无新 organization + 无 audit', async () => {
      const beforeCount = await ctx.prisma.organization.count();
      const logSpy = jest
        .spyOn(ctx.auditLogs, 'log')
        .mockRejectedValueOnce(new Error('simulated audit failure'));

      await expect(
        ctx.organizations.create(
          ctx.adminPayload,
          { name: 'Should Rollback', nodeTypeCode: NODE_TYPE_CODE },
          AUDIT_META,
        ),
      ).rejects.toThrow('simulated audit failure');
      expect(logSpy).toHaveBeenCalledTimes(1);

      expect(await ctx.prisma.organization.count()).toBe(beforeCount);
      expect(await ctx.prisma.auditLog.count({ where: { event: 'organization.create' } })).toBe(0);
      logSpy.mockRestore();
    });

    it('F2. move 路径 auditLogs.log 抛错 → $transaction 回滚:parentId 未变 + 无 audit', async () => {
      const root = await ctx.organizations.create(
        ctx.adminPayload,
        { name: 'Root', nodeTypeCode: NODE_TYPE_CODE },
        AUDIT_META,
      );
      const parent1 = await ctx.organizations.create(
        ctx.adminPayload,
        { name: 'Parent 1', nodeTypeCode: NODE_TYPE_CODE, parentId: root.id },
        AUDIT_META,
      );
      const parent2 = await ctx.organizations.create(
        ctx.adminPayload,
        { name: 'Parent 2', nodeTypeCode: NODE_TYPE_CODE, parentId: root.id },
        AUDIT_META,
      );
      const child = await ctx.organizations.create(
        ctx.adminPayload,
        { name: 'Child', nodeTypeCode: NODE_TYPE_CODE, parentId: parent1.id },
        AUDIT_META,
      );
      await ctx.prisma.auditLog.deleteMany({});

      const logSpy = jest
        .spyOn(ctx.auditLogs, 'log')
        .mockRejectedValueOnce(new Error('simulated audit failure'));

      await expect(
        ctx.organizations.move(ctx.adminPayload, child.id, { parentId: parent2.id }, AUDIT_META),
      ).rejects.toThrow('simulated audit failure');
      expect(logSpy).toHaveBeenCalledTimes(1);

      const row = await ctx.prisma.organization.findUnique({ where: { id: child.id } });
      expect(row?.parentId).toBe(parent1.id); // 回滚:未变 parent2
      expect(await ctx.prisma.auditLog.count({ where: { event: 'organization.move' } })).toBe(0);
      logSpy.mockRestore();
    });

    it('F3. updateStatus 路径 auditLogs.log 抛错 → $transaction 回滚:status 仍 ACTIVE + 无 audit', async () => {
      const root = await ctx.organizations.create(
        ctx.adminPayload,
        { name: 'Root', nodeTypeCode: NODE_TYPE_CODE },
        AUDIT_META,
      );
      const child = await ctx.organizations.create(
        ctx.adminPayload,
        { name: 'Child', nodeTypeCode: NODE_TYPE_CODE, parentId: root.id },
        AUDIT_META,
      );
      await ctx.prisma.auditLog.deleteMany({});

      const logSpy = jest
        .spyOn(ctx.auditLogs, 'log')
        .mockRejectedValueOnce(new Error('simulated audit failure'));

      await expect(
        ctx.organizations.updateStatus(
          ctx.adminPayload,
          child.id,
          { status: OrganizationStatus.INACTIVE },
          AUDIT_META,
        ),
      ).rejects.toThrow('simulated audit failure');
      expect(logSpy).toHaveBeenCalledTimes(1);

      const row = await ctx.prisma.organization.findUnique({ where: { id: child.id } });
      expect(row?.status).toBe('ACTIVE'); // 回滚:未变 INACTIVE
      expect(
        await ctx.prisma.auditLog.count({ where: { event: 'organization.status-change' } }),
      ).toBe(0);
      logSpy.mockRestore();
    });

    it('F4. softDelete 路径 auditLogs.log 抛错 → $transaction 回滚:deletedAt 仍 null + 无 audit', async () => {
      const root = await ctx.organizations.create(
        ctx.adminPayload,
        { name: 'Root', nodeTypeCode: NODE_TYPE_CODE },
        AUDIT_META,
      );
      const child = await ctx.organizations.create(
        ctx.adminPayload,
        { name: 'Child', nodeTypeCode: NODE_TYPE_CODE, parentId: root.id },
        AUDIT_META,
      );
      await ctx.prisma.auditLog.deleteMany({});

      const logSpy = jest
        .spyOn(ctx.auditLogs, 'log')
        .mockRejectedValueOnce(new Error('simulated audit failure'));

      await expect(
        ctx.organizations.softDelete(ctx.adminPayload, child.id, AUDIT_META),
      ).rejects.toThrow('simulated audit failure');
      expect(logSpy).toHaveBeenCalledTimes(1);

      const row = await ctx.prisma.organization.findUnique({ where: { id: child.id } });
      expect(row?.deletedAt).toBeNull(); // 回滚:未被软删
      expect(await ctx.prisma.auditLog.count({ where: { event: 'organization.delete' } })).toBe(0);
      logSpy.mockRestore();
    });
  });
});
