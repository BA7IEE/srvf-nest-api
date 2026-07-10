import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityRegistrationsService } from '../../src/modules/activity-registrations/activity-registrations.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// activity-registrations audit characterization tests
// (AuditRecorder 抽离前置;沿 attendances-audit-characterization spec 范式)。
//
// 目标:在抽 `ActivityRegistrationAuditRecorder` 之前,显式锁定 service 中 6 处
// `auditLogs.log(...)` 调用的当前 payload 形状:
//   - event name(`registration.create` / `registration.review`)
//   - resourceType / resourceId / actorUserId / actorRoleSnap
//   - context.requestId / ip / ua / before / after / extra 完整字段集
// 这是 audit assembly 抽出后"snapshot 测试不丢字段"的安全门禁。
//
// 沿 docs/api-surface-policy.md §8 P1 禁止事项 + docs/architecture-boundary.md §8 deferred:
//   ❌ 不改 src/**
//   ❌ 不抽 AuditRecorder
//   ❌ 不拆 controller / DTO / schema / migration / OpenAPI / package / CI
//   ✅ 只新增本测试文件 + 同 PR 的 state-transition spec
//
// 覆盖矩阵(6 处写路径):
//   A. create(admin)   — viaPath='admin'
//   B. createMy(self)  — viaPath='self'
//   C. approve         — action='approve' / priorStatusCode='pending' / nextStatusCode='pass'
//   D. reject          — action='reject' / priorStatusCode='pending' / nextStatusCode='reject'
//   E. cancelAdmin     — action='cancel' / cancelledByPath='admin' / nextStatusCode='cancelled'
//   F. cancelMy        — action='cancel' / cancelledByPath='self' / nextStatusCode='cancelled'

const AUDIT_META: AuditMeta = {
  requestId: 'reg-audit-req-0000000000000001',
  ip: '127.0.0.1',
  ua: 'jest/30 activity-registrations-audit-characterization',
};

const REGISTRATION_RESOURCE_TYPE = 'activity_registration';

// 安全的 audit context 形状(沿 audit-logs.types.AuditContext);per-case 用泛型 extra 约束字段。
interface ReadAuditContext<E extends Record<string, unknown> = Record<string, unknown>> {
  requestId: string;
  ip: string | null;
  ua: string | null;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  extra?: E;
}

interface SeedContext {
  prisma: PrismaService;
  service: ActivityRegistrationsService;
  adminUserId: string;
  adminPayload: CurrentUserPayload;
  selfAUserId: string;
  selfAPayload: CurrentUserPayload;
  memberAId: string;
  memberCId: string;
  publishedActivityId: string;
}

describe('ActivityRegistrationsService audit characterization', () => {
  let app: INestApplication;
  let ctx: SeedContext;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);

    const prisma = app.get(PrismaService);
    const service = app.get(ActivityRegistrationsService);

    const admin = await prisma.user.create({
      data: {
        username: 'reg-audit-admin',
        passwordHash: '$2a$10$dummy-hash-not-used-since-no-login-needed',
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
      },
      select: { id: true },
    });

    // Slow-4 T3(评审稿 §8 / D-S4-6):本 spec 直调 service(绕过 Guard),判权已下沉
    // service 层 rbac.can();给 ADMIN 测试用户 admin 补挂 biz-admin(零漂移:对应迁移前
    // @Roles(SUPER_ADMIN, ADMIN) 放行语义;断言零修改)。
    const bizSeed = await seedBizAdminPermissionsAndRole(app);
    await grantBizAdminToUser(app, admin.id, bizSeed.bizAdminRoleId);

    const memberA = await prisma.member.create({
      data: { memberNo: 'reg-audit-m-a', displayName: 'Audit Member A' },
      select: { id: true },
    });
    const memberC = await prisma.member.create({
      data: { memberNo: 'reg-audit-m-c', displayName: 'Audit Member C' },
      select: { id: true },
    });

    const selfA = await prisma.user.create({
      data: {
        username: 'reg-audit-self-a',
        passwordHash: '$2a$10$dummy-hash-not-used-since-no-login-needed',
        role: Role.USER,
        status: UserStatus.ACTIVE,
        memberId: memberA.id,
      },
      select: { id: true },
    });

    const nodeDict = await prisma.dictType.create({
      data: { code: 'node_type', label: '节点类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeDict.id, code: 'reg-audit-root', label: '根' },
    });
    const rootOrg = await prisma.organization.create({
      data: { name: 'Reg Audit Root Org', nodeTypeCode: 'reg-audit-root', parentId: null },
      select: { id: true },
    });

    const activity = await prisma.activity.create({
      data: {
        title: 'Reg Audit Activity',
        activityTypeCode: 'reg-audit-type',
        organizationId: rootOrg.id,
        startAt: new Date('2026-04-20T08:00:00.000Z'),
        endAt: new Date('2026-04-20T12:00:00.000Z'),
        location: 'audit',
        statusCode: 'published',
        isPublicRegistration: true,
      },
      select: { id: true },
    });

    ctx = {
      prisma,
      service,
      adminUserId: admin.id,
      adminPayload: {
        id: admin.id,
        username: 'reg-audit-admin',
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
        memberId: null,
      },
      selfAUserId: selfA.id,
      selfAPayload: {
        id: selfA.id,
        username: 'reg-audit-self-a',
        role: Role.USER,
        status: UserStatus.ACTIVE,
        memberId: memberA.id,
      },
      memberAId: memberA.id,
      memberCId: memberC.id,
      publishedActivityId: activity.id,
    };
  });

  afterAll(async () => {
    await app.close();
  });

  // 每个 case 清:ActivityRegistration + AuditLog;保留 User / Member / Org / Activity。
  async function isolateFixtures(): Promise<void> {
    await ctx.prisma.activityRegistration.deleteMany({});
    await ctx.prisma.auditLog.deleteMany({});
  }

  // seed helper(沿 state-transition spec 范式)
  async function seedRegistration(opts: {
    memberId: string;
    statusCode: 'pending' | 'pass' | 'reject' | 'cancelled';
    reviewerUserId?: string | null;
    reviewedAtIso?: string | null;
    reviewNote?: string | null;
  }): Promise<string> {
    const row = await ctx.prisma.activityRegistration.create({
      data: {
        activityId: ctx.publishedActivityId,
        memberId: opts.memberId,
        statusCode: opts.statusCode,
        reviewedBy: opts.reviewerUserId ?? null,
        reviewedAt: opts.reviewedAtIso ? new Date(opts.reviewedAtIso) : null,
        reviewNote: opts.reviewNote ?? null,
      },
      select: { id: true },
    });
    return row.id;
  }

  function assertCommonAuditMetaFields(
    a: {
      event: string;
      resourceType: string;
      actorUserId: string | null;
      actorRoleSnap: Role | null;
      success: boolean;
    },
    expected: { event: string; actorUserId: string; actorRoleSnap: Role },
  ): void {
    expect(a.event).toBe(expected.event);
    expect(a.resourceType).toBe(REGISTRATION_RESOURCE_TYPE);
    expect(a.actorUserId).toBe(expected.actorUserId);
    expect(a.actorRoleSnap).toBe(expected.actorRoleSnap);
    expect(a.success).toBe(true);
  }

  function assertContextMeta(c: ReadAuditContext): void {
    expect(c.requestId).toBe(AUDIT_META.requestId);
    expect(c.ip).toBe(AUDIT_META.ip);
    expect(c.ua).toBe(AUDIT_META.ua);
  }

  // ============ A. create(admin)audit shape ============
  describe('A. create(admin)audit shape', () => {
    beforeEach(isolateFixtures);

    it('A1. event=registration.create + extra={operation:create, viaPath:admin, activityId, targetMemberId} + after present / before absent', async () => {
      const result = await ctx.service.create(
        ctx.publishedActivityId,
        { memberId: ctx.memberCId, extras: { wantsAccommodation: true } },
        ctx.adminPayload,
        AUDIT_META,
      );

      const audits = await ctx.prisma.auditLog.findMany({
        where: { event: 'registration.create' },
        orderBy: { createdAt: 'asc' },
      });
      expect(audits).toHaveLength(1);
      const a = audits[0];

      assertCommonAuditMetaFields(a, {
        event: 'registration.create',
        actorUserId: ctx.adminUserId,
        actorRoleSnap: Role.ADMIN,
      });
      expect(a.resourceId).toBe(result.id);

      const c = a.context as unknown as ReadAuditContext<{
        operation?: string;
        viaPath?: string;
        activityId?: string;
        targetMemberId?: string;
      }>;
      assertContextMeta(c);

      // create 路径:before absent,after present(toAuditSnapshot 包含完整字段集)
      expect(c.before).toBeUndefined();
      expect(c.after).toBeDefined();
      const after = c.after as {
        activityId: string;
        memberId: string;
        statusCode: string;
        extras: Record<string, unknown> | null;
        reviewedBy: string | null;
        reviewedAt: Date | string | null;
        reviewNote: string | null;
        cancelledByUserId: string | null;
        cancelledAt: Date | string | null;
        cancelReason: string | null;
      };
      expect(after.activityId).toBe(ctx.publishedActivityId);
      expect(after.memberId).toBe(ctx.memberCId);
      expect(after.statusCode).toBe('pending');
      expect(after.extras).toEqual({ wantsAccommodation: true });
      expect(after.reviewedBy).toBeNull();
      expect(after.cancelledByUserId).toBeNull();

      // extra:锁定 4 字段
      expect(c.extra).toEqual({
        operation: 'create',
        viaPath: 'admin',
        activityId: ctx.publishedActivityId,
        targetMemberId: ctx.memberCId,
      });
    });
  });

  // ============ B. createMy(self)audit shape ============
  describe('B. createMy(self)audit shape', () => {
    beforeEach(isolateFixtures);

    it('B1. event=registration.create + extra={operation:create, viaPath:self, activityId, targetMemberId=resolved-memberId}', async () => {
      const result = await ctx.service.createMy(
        ctx.publishedActivityId,
        {},
        ctx.selfAPayload,
        AUDIT_META,
      );

      const audits = await ctx.prisma.auditLog.findMany({
        where: { event: 'registration.create' },
        orderBy: { createdAt: 'asc' },
      });
      expect(audits).toHaveLength(1);
      const a = audits[0];

      assertCommonAuditMetaFields(a, {
        event: 'registration.create',
        actorUserId: ctx.selfAUserId,
        actorRoleSnap: Role.USER,
      });
      expect(a.resourceId).toBe(result.id);

      const c = a.context as unknown as ReadAuditContext<{
        operation?: string;
        viaPath?: string;
        activityId?: string;
        targetMemberId?: string;
      }>;
      assertContextMeta(c);

      // create 路径:before absent,after 含 memberId=resolved(self resolved memberA)
      expect(c.before).toBeUndefined();
      expect(c.after).toBeDefined();
      const after = c.after as { memberId: string; statusCode: string };
      expect(after.memberId).toBe(ctx.memberAId);
      expect(after.statusCode).toBe('pending');

      // extra:锁定 4 字段(注意 viaPath='self' + targetMemberId 是 resolved 的 memberAId 而非 dto)
      expect(c.extra).toEqual({
        operation: 'create',
        viaPath: 'self',
        activityId: ctx.publishedActivityId,
        targetMemberId: ctx.memberAId,
      });
    });
  });

  // ============ C. approve audit shape ============
  describe('C. approve audit shape', () => {
    beforeEach(isolateFixtures);

    it('C1. event=registration.review + extra={operation:review, action:approve, priorStatusCode:pending, nextStatusCode:pass, activityId, targetMemberId} + before+after both present', async () => {
      const regId = await seedRegistration({
        memberId: ctx.memberCId,
        statusCode: 'pending',
      });

      await ctx.service.approve(
        ctx.publishedActivityId,
        regId,
        { reviewNote: '审核通过' },
        ctx.adminPayload,
        AUDIT_META,
      );

      const audits = await ctx.prisma.auditLog.findMany({
        where: { event: 'registration.review', resourceId: regId },
        orderBy: { createdAt: 'asc' },
      });
      expect(audits).toHaveLength(1);
      const a = audits[0];

      assertCommonAuditMetaFields(a, {
        event: 'registration.review',
        actorUserId: ctx.adminUserId,
        actorRoleSnap: Role.ADMIN,
      });
      expect(a.resourceId).toBe(regId);

      const c = a.context as unknown as ReadAuditContext<{
        operation?: string;
        action?: string;
        priorStatusCode?: string;
        nextStatusCode?: string;
        activityId?: string;
        targetMemberId?: string;
      }>;
      assertContextMeta(c);

      // approve:before + after 都存在
      expect(c.before).toBeDefined();
      expect(c.after).toBeDefined();
      const before = c.before as { statusCode: string; reviewedBy: string | null };
      const after = c.after as {
        statusCode: string;
        reviewedBy: string | null;
        reviewNote: string | null;
      };
      expect(before.statusCode).toBe('pending');
      expect(before.reviewedBy).toBeNull();
      expect(after.statusCode).toBe('pass');
      expect(after.reviewedBy).toBe(ctx.adminUserId);
      expect(after.reviewNote).toBe('审核通过');

      // extra:锁定 6 字段
      expect(c.extra).toEqual({
        operation: 'review',
        action: 'approve',
        priorStatusCode: 'pending',
        nextStatusCode: 'pass',
        activityId: ctx.publishedActivityId,
        targetMemberId: ctx.memberCId,
      });
    });
  });

  // ============ D. reject audit shape ============
  describe('D. reject audit shape', () => {
    beforeEach(isolateFixtures);

    it('D1. event=registration.review + extra={action:reject, priorStatusCode:pending, nextStatusCode:reject, ...} + before+after present', async () => {
      const regId = await seedRegistration({
        memberId: ctx.memberCId,
        statusCode: 'pending',
      });

      await ctx.service.reject(
        ctx.publishedActivityId,
        regId,
        { reviewNote: '资质不符' },
        ctx.adminPayload,
        AUDIT_META,
      );

      const audits = await ctx.prisma.auditLog.findMany({
        where: { event: 'registration.review', resourceId: regId },
        orderBy: { createdAt: 'asc' },
      });
      expect(audits).toHaveLength(1);
      const a = audits[0];

      assertCommonAuditMetaFields(a, {
        event: 'registration.review',
        actorUserId: ctx.adminUserId,
        actorRoleSnap: Role.ADMIN,
      });

      const c = a.context as unknown as ReadAuditContext<{
        operation?: string;
        action?: string;
        priorStatusCode?: string;
        nextStatusCode?: string;
        activityId?: string;
        targetMemberId?: string;
      }>;
      assertContextMeta(c);

      expect(c.before).toBeDefined();
      expect(c.after).toBeDefined();
      const before = c.before as { statusCode: string };
      const after = c.after as { statusCode: string; reviewNote: string | null };
      expect(before.statusCode).toBe('pending');
      expect(after.statusCode).toBe('reject');
      expect(after.reviewNote).toBe('资质不符');

      expect(c.extra).toEqual({
        operation: 'review',
        action: 'reject',
        priorStatusCode: 'pending',
        nextStatusCode: 'reject',
        activityId: ctx.publishedActivityId,
        targetMemberId: ctx.memberCId,
      });
    });
  });

  // ============ D2. reopen audit shape(v0.40.0 审批后悔药;event 复用 registration.review) ============
  describe('D2. reopen audit shape', () => {
    beforeEach(isolateFixtures);

    it('reopen: event=registration.review + extra={action:reopen, priorStatusCode:reject, nextStatusCode:pending, ...} + after 清空审核字段', async () => {
      const regId = await seedRegistration({
        memberId: ctx.memberCId,
        statusCode: 'reject',
        reviewerUserId: ctx.adminUserId,
        reviewedAtIso: '2026-04-10T10:00:00.000Z',
        reviewNote: '资质不符',
      });

      await ctx.service.reopen(ctx.publishedActivityId, regId, ctx.adminPayload, AUDIT_META);

      const audits = await ctx.prisma.auditLog.findMany({
        where: { event: 'registration.review', resourceId: regId },
        orderBy: { createdAt: 'asc' },
      });
      expect(audits).toHaveLength(1);
      const a = audits[0];

      assertCommonAuditMetaFields(a, {
        event: 'registration.review',
        actorUserId: ctx.adminUserId,
        actorRoleSnap: Role.ADMIN,
      });

      const c = a.context as unknown as ReadAuditContext<{
        operation?: string;
        action?: string;
        priorStatusCode?: string;
        nextStatusCode?: string;
        activityId?: string;
        targetMemberId?: string;
      }>;
      assertContextMeta(c);

      expect(c.before).toBeDefined();
      expect(c.after).toBeDefined();
      const before = c.before as { statusCode: string; reviewNote: string | null };
      const after = c.after as {
        statusCode: string;
        reviewedBy: string | null;
        reviewedAt: string | Date | null;
        reviewNote: string | null;
      };
      expect(before.statusCode).toBe('reject');
      expect(before.reviewNote).toBe('资质不符');
      expect(after.statusCode).toBe('pending');
      // 审核三字段清空反映在 after 快照
      expect(after.reviewedBy).toBeNull();
      expect(after.reviewedAt).toBeNull();
      expect(after.reviewNote).toBeNull();

      expect(c.extra).toEqual({
        operation: 'review',
        action: 'reopen',
        priorStatusCode: 'reject',
        nextStatusCode: 'pending',
        activityId: ctx.publishedActivityId,
        targetMemberId: ctx.memberCId,
      });
    });
  });

  // ============ E. cancelAdmin audit shape ============
  describe('E. cancelAdmin audit shape', () => {
    beforeEach(isolateFixtures);

    it('E1. event=registration.review + extra={action:cancel, cancelledByPath:admin, cancelReason:"...", priorStatusCode, nextStatusCode:cancelled, activityId, targetMemberId} (8 字段)', async () => {
      const regId = await seedRegistration({
        memberId: ctx.memberCId,
        statusCode: 'pending',
      });

      await ctx.service.cancelAdmin(
        ctx.publishedActivityId,
        regId,
        { cancelReason: '管理员代取消' },
        ctx.adminPayload,
        AUDIT_META,
      );

      const audits = await ctx.prisma.auditLog.findMany({
        where: { event: 'registration.review', resourceId: regId },
        orderBy: { createdAt: 'asc' },
      });
      expect(audits).toHaveLength(1);
      const a = audits[0];

      assertCommonAuditMetaFields(a, {
        event: 'registration.review',
        actorUserId: ctx.adminUserId,
        actorRoleSnap: Role.ADMIN,
      });

      const c = a.context as unknown as ReadAuditContext<{
        operation?: string;
        action?: string;
        priorStatusCode?: string;
        nextStatusCode?: string;
        cancelledByPath?: string;
        cancelReason?: string | null;
        activityId?: string;
        targetMemberId?: string;
      }>;
      assertContextMeta(c);

      expect(c.before).toBeDefined();
      expect(c.after).toBeDefined();
      const before = c.before as { statusCode: string };
      const after = c.after as {
        statusCode: string;
        cancelledByUserId: string | null;
        cancelReason: string | null;
      };
      expect(before.statusCode).toBe('pending');
      expect(after.statusCode).toBe('cancelled');
      expect(after.cancelledByUserId).toBe(ctx.adminUserId);
      expect(after.cancelReason).toBe('管理员代取消');

      // extra:锁定 8 字段(cancelAdmin / cancelMy 比 approve/reject 多 cancelledByPath / cancelReason)
      expect(c.extra).toEqual({
        operation: 'review',
        action: 'cancel',
        priorStatusCode: 'pending',
        nextStatusCode: 'cancelled',
        cancelledByPath: 'admin',
        cancelReason: '管理员代取消',
        activityId: ctx.publishedActivityId,
        targetMemberId: ctx.memberCId,
      });
    });

    it('E2. cancelAdmin 无 cancelReason → extra.cancelReason=null(显式锁 ?? null 行为)', async () => {
      const regId = await seedRegistration({
        memberId: ctx.memberCId,
        statusCode: 'pass',
        reviewerUserId: ctx.adminUserId,
        reviewedAtIso: '2026-04-20T09:00:00.000Z',
      });

      await ctx.service.cancelAdmin(
        ctx.publishedActivityId,
        regId,
        {},
        ctx.adminPayload,
        AUDIT_META,
      );

      const audits = await ctx.prisma.auditLog.findMany({
        where: { event: 'registration.review', resourceId: regId },
      });
      expect(audits).toHaveLength(1);
      const c = audits[0].context as unknown as ReadAuditContext<{
        priorStatusCode?: string;
        cancelReason?: string | null;
        cancelledByPath?: string;
      }>;
      expect(c.extra?.priorStatusCode).toBe('pass');
      expect(c.extra?.cancelReason).toBeNull();
      expect(c.extra?.cancelledByPath).toBe('admin');
    });
  });

  // ============ F. cancelMy audit shape ============
  describe('F. cancelMy audit shape', () => {
    beforeEach(isolateFixtures);

    it('F1. event=registration.review + extra={action:cancel, cancelledByPath:self, ...} + actor=selfA', async () => {
      const regId = await seedRegistration({
        memberId: ctx.memberAId, // selfA owns memberA
        statusCode: 'pending',
      });

      await ctx.service.cancelMy(regId, { cancelReason: '临时有事' }, ctx.selfAPayload, AUDIT_META);

      const audits = await ctx.prisma.auditLog.findMany({
        where: { event: 'registration.review', resourceId: regId },
        orderBy: { createdAt: 'asc' },
      });
      expect(audits).toHaveLength(1);
      const a = audits[0];

      assertCommonAuditMetaFields(a, {
        event: 'registration.review',
        actorUserId: ctx.selfAUserId,
        actorRoleSnap: Role.USER,
      });

      const c = a.context as unknown as ReadAuditContext<{
        operation?: string;
        action?: string;
        priorStatusCode?: string;
        nextStatusCode?: string;
        cancelledByPath?: string;
        cancelReason?: string | null;
        activityId?: string;
        targetMemberId?: string;
      }>;
      assertContextMeta(c);

      expect(c.before).toBeDefined();
      expect(c.after).toBeDefined();
      const after = c.after as {
        statusCode: string;
        cancelledByUserId: string | null;
        cancelReason: string | null;
      };
      expect(after.statusCode).toBe('cancelled');
      expect(after.cancelledByUserId).toBe(ctx.selfAUserId);
      expect(after.cancelReason).toBe('临时有事');

      // extra:锁定 8 字段(与 cancelAdmin 同形,仅 cancelledByPath 不同)
      expect(c.extra).toEqual({
        operation: 'review',
        action: 'cancel',
        priorStatusCode: 'pending',
        nextStatusCode: 'cancelled',
        cancelledByPath: 'self',
        cancelReason: '临时有事',
        activityId: ctx.publishedActivityId,
        targetMemberId: ctx.memberAId,
      });
    });
  });
});
