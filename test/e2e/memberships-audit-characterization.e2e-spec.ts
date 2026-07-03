import type { INestApplication } from '@nestjs/common';
import { MemberStatus, OrganizationStatus, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { PrismaService } from '../../src/database/prisma.service';
import { AuditLogsService } from '../../src/modules/audit-logs/audit-logs.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { MemberDepartmentsService } from '../../src/modules/member-departments/member-departments.service';
import { MembershipsService } from '../../src/modules/member-departments/memberships.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// memberships / member-departments audit characterization tests
// (review #484 G5;沿 activity-registrations-audit-characterization / attachments-audit-characterization
//  spec 范式)。
//
// 目标:锁定 memberships.service.ts(create/end)+ member-departments.service.ts(set/remove)四处新增
// `auditLogs.log(...)` 调用的 payload 形状(event / resourceType / viaPath / before-after),并证明:
//   - memberships.update(PATCH)与 member-departments.set 幂等分支(无状态变更)不写 audit(锁定设计,非遗漏)
//   - 4 处写点均 inline-in-transaction(tx 传参)——audit 写失败 → 整个 $transaction 回滚(D-S7 红线)
//
// 沿 docs/api-surface-policy.md §8 P1 禁止事项:
//   ❌ 不改 src/**(本文件为唯一新增)
//   ✅ 只新增本测试文件
//
// 测试策略:service-level e2e,`createTestApp()` + `app.get(XxxService)` 直接调用,绕过 HTTP /
// JwtAuthGuard;actor 用 SUPER_ADMIN payload(RbacService.can 对 SUPER_ADMIN 恒短路,不需额外 RBAC seed)。
//
// 覆盖矩阵:
//   A. memberships.create audit shape(viaPath=membership,before 缺席)
//   B. memberships.end audit shape(viaPath=membership,before/after status)
//   C. member-departments.set audit shape(viaPath=department;首次建 before 缺席 / 换部门 before=旧行 / 幂等不写)
//   D. member-departments.remove audit shape(viaPath=department)
//   E. memberships.update(PATCH)不写 audit
//   F. audit failure → $transaction 回滚(4 处写点各一例)

const AUDIT_META: AuditMeta = {
  requestId: 'membership-audit-charac-req-0000000001',
  ip: '127.0.0.1',
  ua: 'jest/30 memberships-audit-characterization',
};

const RESOURCE_TYPE = 'membership';

interface ReadAuditContext<E extends Record<string, unknown> = Record<string, unknown>> {
  requestId: string;
  ip: string | null;
  ua: string | null;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  extra?: E;
}

type ViaPathExtra = {
  viaPath?: string;
  operation?: string;
  targetMemberId?: string;
};

interface SeedContext {
  prisma: PrismaService;
  memberships: MembershipsService;
  memberDepartments: MemberDepartmentsService;
  auditLogs: AuditLogsService;
  adminUserId: string;
  adminPayload: CurrentUserPayload;
  memberId: string;
  orgIdA: string;
  orgIdB: string;
}

describe('memberships / member-departments audit characterization', () => {
  let app: INestApplication;
  let ctx: SeedContext;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);

    const prisma = app.get(PrismaService);
    const memberships = app.get(MembershipsService);
    const memberDepartments = app.get(MemberDepartmentsService);
    const auditLogs = app.get(AuditLogsService);

    const admin = await prisma.user.create({
      data: {
        username: 'ms-audit-admin',
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
      data: { typeId: nodeDict.id, code: 'ms-audit-root', label: '根' },
    });
    const orgA = await prisma.organization.create({
      data: {
        name: 'MS Audit Org A',
        nodeTypeCode: 'ms-audit-root',
        status: OrganizationStatus.ACTIVE,
      },
      select: { id: true },
    });
    const orgB = await prisma.organization.create({
      data: {
        name: 'MS Audit Org B',
        nodeTypeCode: 'ms-audit-root',
        status: OrganizationStatus.ACTIVE,
      },
      select: { id: true },
    });

    const member = await prisma.member.create({
      data: { memberNo: 'ms-audit-m-1', displayName: 'Audit Member', status: MemberStatus.ACTIVE },
      select: { id: true },
    });

    ctx = {
      prisma,
      memberships,
      memberDepartments,
      auditLogs,
      adminUserId: admin.id,
      adminPayload: {
        id: admin.id,
        username: 'ms-audit-admin',
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
        memberId: null,
      },
      memberId: member.id,
      orgIdA: orgA.id,
      orgIdB: orgB.id,
    };
  });

  afterAll(async () => {
    await app.close();
  });

  // 每个 case 清:MemberOrganizationMembership + AuditLog;保留 User / Member / Organization。
  async function isolateFixtures(): Promise<void> {
    await ctx.prisma.memberOrganizationMembership.deleteMany({});
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

  // ============ A. memberships.create audit shape ============
  describe('A. memberships.create audit shape', () => {
    beforeEach(isolateFixtures);

    it('A1. event=membership.set + viaPath=membership + before 缺席 + after 快照', async () => {
      const result = await ctx.memberships.create(
        ctx.adminPayload,
        ctx.memberId,
        { organizationId: ctx.orgIdA, membershipType: 'PRIMARY', reason: '首次编入' },
        AUDIT_META,
      );

      const audits = await ctx.prisma.auditLog.findMany({ where: { event: 'membership.set' } });
      expect(audits).toHaveLength(1);
      const a = audits[0];
      assertCommonAuditMetaFields(a);
      expect(a.resourceId).toBe(result.id);

      const c = a.context as unknown as ReadAuditContext<ViaPathExtra>;
      assertContextMeta(c);
      expect(c.before).toBeUndefined();
      expect(c.after).toBeDefined();
      const after = c.after as {
        memberId: string;
        organizationId: string;
        membershipType: string;
        status: string;
        reason: string | null;
      };
      expect(after.memberId).toBe(ctx.memberId);
      expect(after.organizationId).toBe(ctx.orgIdA);
      expect(after.membershipType).toBe('PRIMARY');
      expect(after.status).toBe('ACTIVE');
      expect(after.reason).toBe('首次编入');

      expect(c.extra).toEqual({
        viaPath: 'membership',
        operation: 'create',
        targetMemberId: ctx.memberId,
      });
    });
  });

  // ============ B. memberships.end audit shape ============
  describe('B. memberships.end audit shape', () => {
    beforeEach(isolateFixtures);

    it('B1. event=membership.end + viaPath=membership + before/after status', async () => {
      const created = await ctx.memberships.create(
        ctx.adminPayload,
        ctx.memberId,
        { organizationId: ctx.orgIdA, membershipType: 'SECONDARY' },
        AUDIT_META,
      );
      await ctx.prisma.auditLog.deleteMany({}); // 只留 end 这一条

      await ctx.memberships.end(ctx.adminPayload, ctx.memberId, created.id, AUDIT_META);

      const audits = await ctx.prisma.auditLog.findMany({ where: { event: 'membership.end' } });
      expect(audits).toHaveLength(1);
      const a = audits[0];
      assertCommonAuditMetaFields(a);
      expect(a.resourceId).toBe(created.id);

      const c = a.context as unknown as ReadAuditContext<ViaPathExtra>;
      assertContextMeta(c);
      expect(c.before).toEqual({ status: 'ACTIVE' });
      const after = c.after as { status: string; endedAt: string; endedByUserId: string };
      expect(after.status).toBe('ENDED');
      expect(after.endedByUserId).toBe(ctx.adminUserId);
      expect(after.endedAt).not.toBeNull();

      expect(c.extra).toEqual({
        viaPath: 'membership',
        operation: 'end',
        targetMemberId: ctx.memberId,
      });
    });
  });

  // ============ C. member-departments.set audit shape(legacy 入口) ============
  describe('C. member-departments.set audit shape', () => {
    beforeEach(isolateFixtures);

    it('C1. 首次建(无旧 PRIMARY)→ event=membership.set + viaPath=department + before 缺席', async () => {
      const result = await ctx.memberDepartments.set(
        ctx.adminPayload,
        ctx.memberId,
        { organizationId: ctx.orgIdA },
        AUDIT_META,
      );

      const audits = await ctx.prisma.auditLog.findMany({ where: { event: 'membership.set' } });
      expect(audits).toHaveLength(1);
      const a = audits[0];
      assertCommonAuditMetaFields(a);
      expect(a.resourceId).toBe(result.id);

      const c = a.context as unknown as ReadAuditContext<ViaPathExtra>;
      assertContextMeta(c);
      expect(c.before).toBeUndefined();
      const after = c.after as { id: string; memberId: string; organizationId: string };
      expect(after.id).toBe(result.id);
      expect(after.organizationId).toBe(ctx.orgIdA);
      expect(c.extra).toEqual({
        viaPath: 'department',
        operation: 'set',
        targetMemberId: ctx.memberId,
      });
    });

    it('C2. 换部门(不同 organizationId)→ before=旧 PRIMARY 行快照', async () => {
      const first = await ctx.memberDepartments.set(
        ctx.adminPayload,
        ctx.memberId,
        { organizationId: ctx.orgIdA },
        AUDIT_META,
      );
      await ctx.prisma.auditLog.deleteMany({}); // 只留换部门这一条

      const second = await ctx.memberDepartments.set(
        ctx.adminPayload,
        ctx.memberId,
        { organizationId: ctx.orgIdB },
        AUDIT_META,
      );

      const audits = await ctx.prisma.auditLog.findMany({ where: { event: 'membership.set' } });
      expect(audits).toHaveLength(1);
      const c = audits[0].context as unknown as ReadAuditContext<ViaPathExtra>;
      const before = c.before as { id: string; organizationId: string };
      const after = c.after as { id: string; organizationId: string };
      expect(before.id).toBe(first.id);
      expect(before.organizationId).toBe(ctx.orgIdA);
      expect(after.id).toBe(second.id);
      expect(after.organizationId).toBe(ctx.orgIdB);
    });

    it('C3. 幂等(同 organizationId)→ 0 条新 audit(无状态变更)', async () => {
      await ctx.memberDepartments.set(
        ctx.adminPayload,
        ctx.memberId,
        { organizationId: ctx.orgIdA },
        AUDIT_META,
      );
      await ctx.prisma.auditLog.deleteMany({});

      await ctx.memberDepartments.set(
        ctx.adminPayload,
        ctx.memberId,
        { organizationId: ctx.orgIdA },
        AUDIT_META,
      );

      const audits = await ctx.prisma.auditLog.findMany({});
      expect(audits).toHaveLength(0);
    });
  });

  // ============ D. member-departments.remove audit shape(legacy 入口) ============
  describe('D. member-departments.remove audit shape', () => {
    beforeEach(isolateFixtures);

    it('D1. event=membership.end + viaPath=department', async () => {
      const created = await ctx.memberDepartments.set(
        ctx.adminPayload,
        ctx.memberId,
        { organizationId: ctx.orgIdA },
        AUDIT_META,
      );
      await ctx.prisma.auditLog.deleteMany({});

      await ctx.memberDepartments.remove(ctx.adminPayload, ctx.memberId, AUDIT_META);

      const audits = await ctx.prisma.auditLog.findMany({ where: { event: 'membership.end' } });
      expect(audits).toHaveLength(1);
      const a = audits[0];
      assertCommonAuditMetaFields(a);
      expect(a.resourceId).toBe(created.id);

      const c = a.context as unknown as ReadAuditContext<ViaPathExtra>;
      assertContextMeta(c);
      const before = c.before as { id: string; organizationId: string };
      const after = c.after as { id: string; organizationId: string; deletedAt: string };
      expect(before.id).toBe(created.id);
      expect(before.organizationId).toBe(ctx.orgIdA);
      expect(after.id).toBe(created.id);
      expect(after.deletedAt).not.toBeNull();
      expect(c.extra).toEqual({
        viaPath: 'department',
        operation: 'remove',
        targetMemberId: ctx.memberId,
      });
    });
  });

  // ============ E. memberships.update(PATCH)不写 audit ============
  describe('E. memberships.update(PATCH)不写 audit', () => {
    beforeEach(isolateFixtures);

    it('E1. 改类型 / 任期 / 原因成功 → 0 条新 audit(锁定设计,非遗漏)', async () => {
      const created = await ctx.memberships.create(
        ctx.adminPayload,
        ctx.memberId,
        { organizationId: ctx.orgIdA, membershipType: 'SECONDARY' },
        AUDIT_META,
      );
      await ctx.prisma.auditLog.deleteMany({}); // 只留 update 之后的观察窗口

      await ctx.memberships.update(ctx.adminPayload, ctx.memberId, created.id, {
        reason: '调整',
      });

      const audits = await ctx.prisma.auditLog.findMany({});
      expect(audits).toHaveLength(0);
    });
  });

  // ============ F. Audit failure rollback(D-S7 红线;4 处写点各一例) ============
  describe('F. audit failure rollback', () => {
    beforeEach(isolateFixtures);

    it('F1. memberships.create 路径 auditLogs.log 抛错 → $transaction 回滚:无新 membership + 无 audit', async () => {
      const beforeCount = await ctx.prisma.memberOrganizationMembership.count();
      const logSpy = jest
        .spyOn(ctx.auditLogs, 'log')
        .mockRejectedValueOnce(new Error('simulated audit failure'));

      await expect(
        ctx.memberships.create(
          ctx.adminPayload,
          ctx.memberId,
          { organizationId: ctx.orgIdA, membershipType: 'PRIMARY' },
          AUDIT_META,
        ),
      ).rejects.toThrow('simulated audit failure');
      expect(logSpy).toHaveBeenCalledTimes(1);

      expect(await ctx.prisma.memberOrganizationMembership.count()).toBe(beforeCount);
      expect(await ctx.prisma.auditLog.count({ where: { event: 'membership.set' } })).toBe(0);
      logSpy.mockRestore();
    });

    it('F2. memberships.end 路径 auditLogs.log 抛错 → $transaction 回滚:status 仍 ACTIVE + 无 audit', async () => {
      const created = await ctx.memberships.create(
        ctx.adminPayload,
        ctx.memberId,
        { organizationId: ctx.orgIdA, membershipType: 'PRIMARY' },
        AUDIT_META,
      );
      await ctx.prisma.auditLog.deleteMany({});

      const logSpy = jest
        .spyOn(ctx.auditLogs, 'log')
        .mockRejectedValueOnce(new Error('simulated audit failure'));

      await expect(
        ctx.memberships.end(ctx.adminPayload, ctx.memberId, created.id, AUDIT_META),
      ).rejects.toThrow('simulated audit failure');
      expect(logSpy).toHaveBeenCalledTimes(1);

      const row = await ctx.prisma.memberOrganizationMembership.findUnique({
        where: { id: created.id },
      });
      expect(row?.status).toBe('ACTIVE'); // 回滚:未变 ENDED
      expect(await ctx.prisma.auditLog.count({ where: { event: 'membership.end' } })).toBe(0);
      logSpy.mockRestore();
    });

    it('F3. member-departments.set 路径 auditLogs.log 抛错 → $transaction 回滚:无新 membership + 无 audit', async () => {
      const beforeCount = await ctx.prisma.memberOrganizationMembership.count();
      const logSpy = jest
        .spyOn(ctx.auditLogs, 'log')
        .mockRejectedValueOnce(new Error('simulated audit failure'));

      await expect(
        ctx.memberDepartments.set(
          ctx.adminPayload,
          ctx.memberId,
          { organizationId: ctx.orgIdA },
          AUDIT_META,
        ),
      ).rejects.toThrow('simulated audit failure');
      expect(logSpy).toHaveBeenCalledTimes(1);

      expect(await ctx.prisma.memberOrganizationMembership.count()).toBe(beforeCount);
      expect(await ctx.prisma.auditLog.count({ where: { event: 'membership.set' } })).toBe(0);
      logSpy.mockRestore();
    });

    it('F4. member-departments.remove 路径 auditLogs.log 抛错 → $transaction 回滚:deletedAt 仍 null + 无 audit', async () => {
      const created = await ctx.memberDepartments.set(
        ctx.adminPayload,
        ctx.memberId,
        { organizationId: ctx.orgIdA },
        AUDIT_META,
      );
      await ctx.prisma.auditLog.deleteMany({});

      const logSpy = jest
        .spyOn(ctx.auditLogs, 'log')
        .mockRejectedValueOnce(new Error('simulated audit failure'));

      await expect(
        ctx.memberDepartments.remove(ctx.adminPayload, ctx.memberId, AUDIT_META),
      ).rejects.toThrow('simulated audit failure');
      expect(logSpy).toHaveBeenCalledTimes(1);

      const row = await ctx.prisma.memberOrganizationMembership.findUnique({
        where: { id: created.id },
      });
      expect(row?.deletedAt).toBeNull(); // 回滚:未被软删
      expect(await ctx.prisma.auditLog.count({ where: { event: 'membership.end' } })).toBe(0);
      logSpy.mockRestore();
    });
  });
});
