import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivitiesService } from '../../src/modules/activities/activities.service';
import type { CreateActivityDto } from '../../src/modules/activities/activities.dto';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// activities audit characterization tests
// (ActivityAuditRecorder 抽离前置;沿 activity-registrations-audit-characterization 范式)。
//
// 目标:在抽 `ActivityAuditRecorder` 之前,显式锁定 service 中 5 处 `auditLogs.log(...)`
// 调用的当前 payload 形状:
//   - event name:**5 处共用** `'activity.publish'`(extra.operation 区分;
//     沿 batch3 草案 §20.2 A1 + src/modules/audit-logs/audit-logs.types.ts:29 有意设计;
//     抽 recorder 后**不允许**改 event 名 / 拆分多 event)
//   - resourceType / resourceId / actorUserId / actorRoleSnap / success
//   - context.requestId / ip / ua / before / after / extra 完整字段集
// 这是 audit assembly 抽出后"snapshot 测试不丢字段"的安全门禁。
//
// 沿 docs/api-surface-policy.md §8 P1 禁止事项 + docs/architecture-boundary.md §8 deferred:
//   ❌ 不改 src/**
//   ❌ 不抽 AuditRecorder
//   ❌ 不拆 controller / DTO / schema / migration / OpenAPI / package / CI
//   ✅ 只新增本测试文件 + 同 PR 的 state-transition spec
//
// 覆盖矩阵(5 处写路径):
//   A. create      — operation='create'     / extra 2 字段 / before absent + after present
//   B. update      — operation='update'     / extra 3 字段(含 changedFields) / before+after present
//   C. softDelete  — operation='softDelete' / extra 2 字段 / before present + after **absent**
//   D. publish     — operation='publish'    / extra 3 字段 / before+after present
//   E. cancel      — operation='cancel'     / extra 4 字段(含 cancelReason) / before+after present
//                    + cancelReason ?? null 边界(无 reason → extra.cancelReason=null)

const AUDIT_META: AuditMeta = {
  requestId: 'act-audit-req-0000000000000001',
  ip: '127.0.0.1',
  ua: 'jest/30 activities-audit-characterization',
};

const ACTIVITY_RESOURCE_TYPE = 'activity';
const ACTIVITY_EVENT = 'activity.publish';

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
  service: ActivitiesService;
  adminUserId: string;
  adminPayload: CurrentUserPayload;
  childOrgId: string;
  activityTypeCode: string;
}

describe('ActivitiesService audit characterization', () => {
  let app: INestApplication;
  let ctx: SeedContext;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);

    const prisma = app.get(PrismaService);
    const service = app.get(ActivitiesService);

    const admin = await prisma.user.create({
      data: {
        username: 'act-audit-admin',
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

    const nodeDict = await prisma.dictType.create({
      data: { code: 'node_type', label: '节点类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeDict.id, code: 'act-audit-root', label: '根' },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeDict.id, code: 'act-audit-child', label: '子' },
    });
    const rootOrg = await prisma.organization.create({
      data: { name: 'Act Audit Root Org', nodeTypeCode: 'act-audit-root', parentId: null },
      select: { id: true },
    });
    const childOrg = await prisma.organization.create({
      data: { name: 'Act Audit Child Org', nodeTypeCode: 'act-audit-child', parentId: rootOrg.id },
      select: { id: true },
    });

    const actTypeDict = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    const actType = await prisma.dictItem.create({
      data: { typeId: actTypeDict.id, code: 'act-audit-rotation', label: '演练' },
      select: { code: true },
    });

    ctx = {
      prisma,
      service,
      adminUserId: admin.id,
      adminPayload: {
        id: admin.id,
        username: 'act-audit-admin',
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
        memberId: null,
      },
      childOrgId: childOrg.id,
      activityTypeCode: actType.code,
    };
  });

  afterAll(async () => {
    await app.close();
  });

  // 每个 case 清:Activity + AuditLog;保留 User / Dict / Organization。
  async function isolateFixtures(): Promise<void> {
    await ctx.prisma.activity.deleteMany({});
    await ctx.prisma.auditLog.deleteMany({});
  }

  // 标准 CreateActivityDto(沿 activities.e2e-spec.ts baseCreatePayload 范式)。
  function createDto(override: Partial<CreateActivityDto> = {}): CreateActivityDto {
    return {
      title: '审计形状测试活动',
      activityTypeCode: ctx.activityTypeCode,
      organizationId: ctx.childOrgId,
      startAt: '2099-08-01T08:00:00.000Z',
      endAt: '2099-08-01T12:00:00.000Z',
      location: '测试场地',
      ...override,
    };
  }

  function assertCommonAuditFields(
    a: {
      event: string;
      resourceType: string;
      actorUserId: string | null;
      actorRoleSnap: Role | null;
      resourceId: string | null;
      success: boolean;
    },
    expected: { resourceId: string },
  ): void {
    expect(a.event).toBe(ACTIVITY_EVENT);
    expect(a.resourceType).toBe(ACTIVITY_RESOURCE_TYPE);
    expect(a.actorUserId).toBe(ctx.adminUserId);
    expect(a.actorRoleSnap).toBe(Role.ADMIN);
    expect(a.resourceId).toBe(expected.resourceId);
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

    it('A1. event=activity.publish + extra={operation:create, nextStatusCode:draft} + after present / before absent', async () => {
      const result = await ctx.service.create(createDto(), ctx.adminPayload, AUDIT_META);

      const audits = await ctx.prisma.auditLog.findMany({
        where: { event: ACTIVITY_EVENT, resourceId: result.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(audits).toHaveLength(1);
      const a = audits[0];
      assertCommonAuditFields(a, { resourceId: result.id });

      const c = a.context as unknown as ReadAuditContext<{
        operation?: string;
        nextStatusCode?: string;
      }>;
      assertContextMeta(c);

      // create:before absent(沿 service 现状:create 路径不传 before),after present
      expect(c.before).toBeUndefined();
      expect(c.after).toBeDefined();
      const after = c.after as { statusCode: string; title: string };
      expect(after.statusCode).toBe('draft');
      expect(after.title).toBe('审计形状测试活动');

      // extra 字段集逐字锁(2 字段)
      expect(c.extra).toEqual({
        operation: 'create',
        nextStatusCode: 'draft',
      });
    });
  });

  // ============ B. update audit shape ============
  describe('B. update audit shape', () => {
    beforeEach(isolateFixtures);

    it('B1. event=activity.publish + extra={operation:update, priorStatusCode, changedFields} + before+after present', async () => {
      const created = await ctx.service.create(createDto(), ctx.adminPayload, AUDIT_META);
      // 清掉 create audit,仅保留 update audit 供断言
      await ctx.prisma.auditLog.deleteMany({});

      await ctx.service.update(
        created.id,
        { title: '更新后标题', location: '更新后地点' },
        ctx.adminPayload,
        AUDIT_META,
      );

      const audits = await ctx.prisma.auditLog.findMany({
        where: { event: ACTIVITY_EVENT, resourceId: created.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(audits).toHaveLength(1);
      const a = audits[0];
      assertCommonAuditFields(a, { resourceId: created.id });

      const c = a.context as unknown as ReadAuditContext<{
        operation?: string;
        priorStatusCode?: string;
        changedFields?: string[];
      }>;
      assertContextMeta(c);

      // update:before + after 都存在
      expect(c.before).toBeDefined();
      expect(c.after).toBeDefined();
      const before = c.before as { statusCode: string; title: string; location: string };
      const after = c.after as { statusCode: string; title: string; location: string };
      expect(before.statusCode).toBe('draft');
      expect(before.title).toBe('审计形状测试活动');
      expect(before.location).toBe('测试场地');
      // update 不改 statusCode
      expect(after.statusCode).toBe('draft');
      expect(after.title).toBe('更新后标题');
      expect(after.location).toBe('更新后地点');

      // extra 字段集逐字锁(3 字段;changedFields = Object.keys(dto) 保持插入顺序)
      expect(c.extra).toEqual({
        operation: 'update',
        priorStatusCode: 'draft',
        changedFields: ['title', 'location'],
      });
    });
  });

  // ============ C. softDelete audit shape ============
  describe('C. softDelete audit shape', () => {
    beforeEach(isolateFixtures);

    it('C1. event=activity.publish + extra={operation:softDelete, priorStatusCode} + before present + after absent', async () => {
      const created = await ctx.service.create(createDto(), ctx.adminPayload, AUDIT_META);
      await ctx.prisma.auditLog.deleteMany({});

      await ctx.service.softDelete(created.id, ctx.adminPayload, AUDIT_META);

      const audits = await ctx.prisma.auditLog.findMany({
        where: { event: ACTIVITY_EVENT, resourceId: created.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(audits).toHaveLength(1);
      const a = audits[0];
      assertCommonAuditFields(a, { resourceId: created.id });

      const c = a.context as unknown as ReadAuditContext<{
        operation?: string;
        priorStatusCode?: string;
      }>;
      assertContextMeta(c);

      // softDelete:before present,after **absent**(沿 service 现状:line 546-556 不传 after)
      expect(c.before).toBeDefined();
      expect(c.after).toBeUndefined();
      const before = c.before as { statusCode: string };
      expect(before.statusCode).toBe('draft');

      // extra 字段集逐字锁(2 字段)
      expect(c.extra).toEqual({
        operation: 'softDelete',
        priorStatusCode: 'draft',
      });
    });
  });

  // ============ D. publish audit shape ============
  describe('D. publish audit shape', () => {
    beforeEach(isolateFixtures);

    it('D1. event=activity.publish + extra={operation:publish, priorStatusCode:draft, nextStatusCode:published} + before+after present', async () => {
      const created = await ctx.service.create(createDto(), ctx.adminPayload, AUDIT_META);
      await ctx.prisma.auditLog.deleteMany({});

      await ctx.service.publish(
        created.id,
        { requiresInsuranceConfirmed: true },
        ctx.adminPayload,
        AUDIT_META,
      );

      const audits = await ctx.prisma.auditLog.findMany({
        where: { event: ACTIVITY_EVENT, resourceId: created.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(audits).toHaveLength(1);
      const a = audits[0];
      assertCommonAuditFields(a, { resourceId: created.id });

      const c = a.context as unknown as ReadAuditContext<{
        operation?: string;
        priorStatusCode?: string;
        nextStatusCode?: string;
      }>;
      assertContextMeta(c);

      // publish:before + after 都存在
      expect(c.before).toBeDefined();
      expect(c.after).toBeDefined();
      const before = c.before as { statusCode: string; publishedBy: string | null };
      const after = c.after as { statusCode: string; publishedBy: string | null };
      expect(before.statusCode).toBe('draft');
      expect(before.publishedBy).toBeNull();
      expect(after.statusCode).toBe('published');
      expect(after.publishedBy).toBe(ctx.adminUserId);

      // extra 字段集逐字锁(3 字段)
      expect(c.extra).toEqual({
        operation: 'publish',
        priorStatusCode: 'draft',
        nextStatusCode: 'published',
      });
    });
  });

  // ============ D2. complete audit shape(v0.40.0;event 复用 activity.publish 伞事件)============
  describe('D2. complete audit shape', () => {
    beforeEach(isolateFixtures);

    it('event=activity.publish + extra={operation:complete, priorStatusCode:published, nextStatusCode:completed} + before+after present', async () => {
      const created = await ctx.service.create(createDto(), ctx.adminPayload, AUDIT_META);
      await ctx.service.publish(
        created.id,
        { requiresInsuranceConfirmed: true },
        ctx.adminPayload,
        AUDIT_META,
      );
      // complete 只允许自然结束后的 published 活动；本用例只刻画 complete audit 形状，
      // 因此在直调 complete 前把时间窗推进到过去，不绕过生产生命周期闸。
      await ctx.prisma.activity.update({
        where: { id: created.id },
        data: {
          startAt: new Date('2020-01-01T08:00:00.000Z'),
          endAt: new Date('2020-01-01T12:00:00.000Z'),
        },
      });
      await ctx.prisma.auditLog.deleteMany({});

      await ctx.service.complete(created.id, ctx.adminPayload, AUDIT_META);

      const audits = await ctx.prisma.auditLog.findMany({
        where: { event: ACTIVITY_EVENT, resourceId: created.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(audits).toHaveLength(1);
      const a = audits[0];
      assertCommonAuditFields(a, { resourceId: created.id });

      const c = a.context as unknown as ReadAuditContext<{
        operation?: string;
        priorStatusCode?: string;
        nextStatusCode?: string;
      }>;
      assertContextMeta(c);

      expect(c.before).toBeDefined();
      expect(c.after).toBeDefined();
      const before = c.before as { statusCode: string };
      const after = c.after as { statusCode: string };
      expect(before.statusCode).toBe('published');
      expect(after.statusCode).toBe('completed');

      // extra 字段集逐字锁(3 字段)
      expect(c.extra).toEqual({
        operation: 'complete',
        priorStatusCode: 'published',
        nextStatusCode: 'completed',
      });
    });
  });

  // ============ E. cancel audit shape ============
  describe('E. cancel audit shape', () => {
    beforeEach(isolateFixtures);

    it('E1. with cancelReason → extra={operation:cancel, priorStatusCode, nextStatusCode:cancelled, cancelReason:"..."} (4 字段) + before+after present', async () => {
      const created = await ctx.service.create(createDto(), ctx.adminPayload, AUDIT_META);
      await ctx.prisma.auditLog.deleteMany({});

      await ctx.service.cancel(
        created.id,
        { cancelReason: '雨天延期' },
        ctx.adminPayload,
        AUDIT_META,
      );

      const audits = await ctx.prisma.auditLog.findMany({
        where: { event: ACTIVITY_EVENT, resourceId: created.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(audits).toHaveLength(1);
      const a = audits[0];
      assertCommonAuditFields(a, { resourceId: created.id });

      const c = a.context as unknown as ReadAuditContext<{
        operation?: string;
        priorStatusCode?: string;
        nextStatusCode?: string;
        cancelReason?: string | null;
      }>;
      assertContextMeta(c);

      expect(c.before).toBeDefined();
      expect(c.after).toBeDefined();
      const before = c.before as { statusCode: string };
      const after = c.after as {
        statusCode: string;
        cancelledBy: string | null;
        cancelReason: string | null;
      };
      expect(before.statusCode).toBe('draft');
      expect(after.statusCode).toBe('cancelled');
      expect(after.cancelledBy).toBe(ctx.adminUserId);
      expect(after.cancelReason).toBe('雨天延期');

      // extra 字段集逐字锁(4 字段)
      expect(c.extra).toEqual({
        operation: 'cancel',
        priorStatusCode: 'draft',
        nextStatusCode: 'cancelled',
        cancelReason: '雨天延期',
        pendingRegistrationsCancelled: 0,
      });
    });

    it('E2. without cancelReason → extra.cancelReason=null(显式锁 `?? null` 行为;沿 service line 648)', async () => {
      const created = await ctx.service.create(createDto(), ctx.adminPayload, AUDIT_META);
      await ctx.prisma.auditLog.deleteMany({});

      await ctx.service.cancel(created.id, {}, ctx.adminPayload, AUDIT_META);

      const audits = await ctx.prisma.auditLog.findMany({
        where: { event: ACTIVITY_EVENT, resourceId: created.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(audits).toHaveLength(1);
      const c = audits[0].context as unknown as ReadAuditContext<{
        operation?: string;
        priorStatusCode?: string;
        nextStatusCode?: string;
        cancelReason?: string | null;
      }>;

      // extra 字段集逐字锁(cancelReason=null 是显式字段值,**不能**消失为 undefined)
      expect(c.extra).toEqual({
        operation: 'cancel',
        priorStatusCode: 'draft',
        nextStatusCode: 'cancelled',
        cancelReason: null,
        pendingRegistrationsCancelled: 0,
      });
    });
  });
});
