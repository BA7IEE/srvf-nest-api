import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityRegistrationsService } from '../../src/modules/activity-registrations/activity-registrations.service';
import { AuditLogsService } from '../../src/modules/audit-logs/audit-logs.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// activity-registrations state transitions characterization tests
// (god-service 拆分前置锁;沿 attendances state-transition / audit-characterization 范式)。
//
// 目标:在抽 `ActivityRegistrationStateMachine` / `ActivityRegistrationAuditRecorder` 之前,
// 显式锁定 `activity-registrations.service.ts` 当前状态机 + 唯一性 + 容量 + 事务回滚的全部 invariant。
// 本 PR 严格 test-only(沿 docs/api-surface-policy.md §8 P1 禁止事项 +
// docs/architecture-boundary.md §8 deferred);**不**改 src/**,**不**抽任何 class。
//
// 测试策略选择(沿 attendances-state-transition spec 范式):
//   - 选 service-level e2e(`test/e2e/*.e2e-spec.ts`)而非 unit spec:
//     * 项目 unit jest 配置无 DB,无法实测 `$transaction` / partial unique / audit 写入;
//     * `createTestApp()` + `app.get(ActivityRegistrationsService)` 直接调用 service 方法,
//       **绕过 HTTP / JwtAuthGuard / RolesGuard**,纯锁 service 层行为。
//   - 直接 Prisma seed 非 pending 起始状态(approved / cancelled / rejected),
//     避免为造状态绕完整业务流程(approve / cancel / reject 多步)。
//     partial unique `(activityId, memberId) WHERE deletedAt IS NULL AND statusCode != 'cancelled'`
//     允许多条 cancelled 共存,不影响 seed。
//   - audit failure rollback case 用 jest.spyOn(auditLogs, 'log').mockRejectedValueOnce 触发
//     auditLogs.log 抛错,断言 service throw + DB 无落库 + audit 不存在
//     (沿 attendances-audit-characterization spec D1 范式)。
//
// 覆盖矩阵:
//   A. approve(pending → pass + 3 个 wrong source state)
//   B. reject(pending → reject + 3 个 wrong source state)
//   C. cancelAdmin(pending → cancelled / pass → cancelled + 2 个 wrong source state)
//   D. cancelMy(pending → cancelled / pass → cancelled + 2 个 wrong source state + ownership)
//   E. Uniqueness & capacity(active dup + cancelled allows re-register + capacity full ×2)
//   F. Audit failure rollback(create 路径)

type RegistrationStatus = 'pending' | 'pass' | 'reject' | 'cancelled';

const AUDIT_META: AuditMeta = {
  requestId: 'reg-state-req-0000000000000001',
  ip: '127.0.0.1',
  ua: 'jest/30 activity-registrations-state-transition',
};

const REGISTRATION_RESOURCE_TYPE = 'activity_registration';

interface SeedContext {
  prisma: PrismaService;
  service: ActivityRegistrationsService;
  auditLogs: AuditLogsService;
  adminUserId: string;
  adminPayload: CurrentUserPayload;
  selfAUserId: string;
  selfAPayload: CurrentUserPayload;
  selfBUserId: string;
  selfBPayload: CurrentUserPayload;
  memberAId: string;
  memberBId: string;
  memberCId: string;
  organizationId: string;
  publishedActivityId: string;
}

describe('ActivityRegistrationsService state transitions (characterization)', () => {
  let app: INestApplication;
  let ctx: SeedContext;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);

    const prisma = app.get(PrismaService);
    const service = app.get(ActivityRegistrationsService);
    const auditLogs = app.get(AuditLogsService);

    // Users:adminUser(代报名 / 审批)+ selfA / selfB(自助报名 / 自取消;memberId 绑定)
    const admin = await prisma.user.create({
      data: {
        username: 'reg-state-admin',
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
      data: { memberNo: 'reg-state-m-a', displayName: 'State Member A' },
      select: { id: true },
    });
    const memberB = await prisma.member.create({
      data: { memberNo: 'reg-state-m-b', displayName: 'State Member B' },
      select: { id: true },
    });
    // memberC:作为 admin 代报名的目标 member(无 user 绑定)
    const memberC = await prisma.member.create({
      data: { memberNo: 'reg-state-m-c', displayName: 'State Member C' },
      select: { id: true },
    });

    const selfA = await prisma.user.create({
      data: {
        username: 'reg-state-self-a',
        passwordHash: '$2a$10$dummy-hash-not-used-since-no-login-needed',
        role: Role.USER,
        status: UserStatus.ACTIVE,
        memberId: memberA.id,
      },
      select: { id: true },
    });
    const selfB = await prisma.user.create({
      data: {
        username: 'reg-state-self-b',
        passwordHash: '$2a$10$dummy-hash-not-used-since-no-login-needed',
        role: Role.USER,
        status: UserStatus.ACTIVE,
        memberId: memberB.id,
      },
      select: { id: true },
    });

    // node_type dict + organization(Activity.organizationId FK,Restrict)
    const nodeDict = await prisma.dictType.create({
      data: { code: 'node_type', label: '节点类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeDict.id, code: 'reg-state-root', label: '根' },
    });
    const rootOrg = await prisma.organization.create({
      data: { name: 'Reg State Root Org', nodeTypeCode: 'reg-state-root', parentId: null },
      select: { id: true },
    });

    // Activity:不限名额(approve / reject / cancel 路径主用);capacity-aware 测试自建 activity
    const activity = await prisma.activity.create({
      data: {
        title: 'Reg State Activity',
        activityTypeCode: 'reg-state-type',
        organizationId: rootOrg.id,
        startAt: new Date('2099-04-01T08:00:00.000Z'), // v0.40.0 endAt 闸:远未来避免墙钟越过
        endAt: new Date('2099-04-01T12:00:00.000Z'),
        location: 'state',
        statusCode: 'published',
        isPublicRegistration: true,
      },
      select: { id: true },
    });

    ctx = {
      prisma,
      service,
      auditLogs,
      adminUserId: admin.id,
      adminPayload: {
        id: admin.id,
        username: 'reg-state-admin',
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
        memberId: null,
      },
      selfAUserId: selfA.id,
      selfAPayload: {
        id: selfA.id,
        username: 'reg-state-self-a',
        role: Role.USER,
        status: UserStatus.ACTIVE,
        memberId: memberA.id,
      },
      selfBUserId: selfB.id,
      selfBPayload: {
        id: selfB.id,
        username: 'reg-state-self-b',
        role: Role.USER,
        status: UserStatus.ACTIVE,
        memberId: memberB.id,
      },
      memberAId: memberA.id,
      memberBId: memberB.id,
      memberCId: memberC.id,
      organizationId: rootOrg.id,
      publishedActivityId: activity.id,
    };
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // 每个 case 之间清:ActivityRegistration + AuditLog;保留 User / Member / Org / Activity。
  async function isolateFixtures(): Promise<void> {
    await ctx.prisma.activityRegistration.deleteMany({});
    await ctx.prisma.auditLog.deleteMany({});
  }

  // 直接 prisma seed 任意起始状态的 registration(绕过 service 业务流)。
  // partial unique 约束:`(activityId, memberId) WHERE deletedAt IS NULL AND statusCode != 'cancelled'`
  //   pending / pass / reject 同 (activityId, memberId) 只能一条 active;cancelled 可多条。
  async function seedRegistration(opts: {
    activityId?: string;
    memberId: string;
    statusCode: RegistrationStatus;
    reviewerUserId?: string | null;
    reviewedAtIso?: string | null;
    reviewNote?: string | null;
    cancelledByUserId?: string | null;
    cancelledAtIso?: string | null;
    cancelReason?: string | null;
  }): Promise<string> {
    const activityId = opts.activityId ?? ctx.publishedActivityId;
    const row = await ctx.prisma.activityRegistration.create({
      data: {
        activityId,
        memberId: opts.memberId,
        statusCode: opts.statusCode,
        reviewedBy: opts.reviewerUserId ?? null,
        reviewedAt: opts.reviewedAtIso ? new Date(opts.reviewedAtIso) : null,
        reviewNote: opts.reviewNote ?? null,
        cancelledByUserId: opts.cancelledByUserId ?? null,
        cancelledAt: opts.cancelledAtIso ? new Date(opts.cancelledAtIso) : null,
        cancelReason: opts.cancelReason ?? null,
      },
      select: { id: true },
    });
    return row.id;
  }

  // 造一个新的 published+public Activity(capacity 可选)
  async function createActivity(opts: { capacity?: number | null }): Promise<string> {
    const a = await ctx.prisma.activity.create({
      data: {
        title: `Reg State Activity ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        activityTypeCode: 'reg-state-type',
        organizationId: ctx.organizationId,
        startAt: new Date('2099-04-15T08:00:00.000Z'),
        endAt: new Date('2099-04-15T12:00:00.000Z'),
        location: 'state-capacity',
        statusCode: 'published',
        isPublicRegistration: true,
        ...(opts.capacity !== undefined ? { capacity: opts.capacity } : {}),
      },
      select: { id: true },
    });
    return a.id;
  }

  // ============ A. approve(pending → pass) ============
  describe('A. approve(pending → pass)', () => {
    beforeEach(isolateFixtures);

    it('A1. 成功:返 pass + DB statusCode/reviewer/reviewedAt 落库 + audit registration.review.approve', async () => {
      const regId = await seedRegistration({ memberId: ctx.memberCId, statusCode: 'pending' });

      const result = await ctx.service.approve(
        ctx.publishedActivityId,
        regId,
        { reviewNote: '审核通过' },
        ctx.adminPayload,
        AUDIT_META,
      );

      expect(result.statusCode).toBe('pass');
      expect(result.reviewedBy).toBe(ctx.adminUserId);
      expect(result.reviewedAt).not.toBeNull();
      expect(result.reviewNote).toBe('审核通过');
      // 取消相关字段保持未触碰
      expect(result.cancelledByUserId).toBeNull();
      expect(result.cancelledAt).toBeNull();
      expect(result.cancelReason).toBeNull();

      // DB 反向断言
      const db = await ctx.prisma.activityRegistration.findUniqueOrThrow({
        where: { id: regId },
        select: {
          statusCode: true,
          reviewedBy: true,
          reviewedAt: true,
          reviewNote: true,
          cancelledByUserId: true,
          cancelledAt: true,
          cancelReason: true,
        },
      });
      expect(db.statusCode).toBe('pass');
      expect(db.reviewedBy).toBe(ctx.adminUserId);
      expect(db.reviewedAt).not.toBeNull();
      expect(db.reviewNote).toBe('审核通过');
      expect(db.cancelledByUserId).toBeNull();
      expect(db.cancelledAt).toBeNull();
      expect(db.cancelReason).toBeNull();

      // audit:event = registration.review,extra.action = approve
      const audits = await ctx.prisma.auditLog.findMany({
        where: { resourceId: regId },
        orderBy: { createdAt: 'asc' },
      });
      expect(audits).toHaveLength(1);
      const a = audits[0];
      expect(a.event).toBe('registration.review');
      expect(a.resourceType).toBe(REGISTRATION_RESOURCE_TYPE);
      const c = a.context as {
        extra?: { action?: string; priorStatusCode?: string; nextStatusCode?: string };
      };
      expect(c.extra?.action).toBe('approve');
      expect(c.extra?.priorStatusCode).toBe('pending');
      expect(c.extra?.nextStatusCode).toBe('pass');
    });

    it.each<RegistrationStatus>(['pass', 'reject', 'cancelled'])(
      'A2. 错误起始状态 %s → 抛 ACTIVITY_REGISTRATION_STATUS_INVALID,DB 状态不变,无 audit',
      async (fromStatus) => {
        const regId = await seedRegistration({
          memberId: ctx.memberCId,
          statusCode: fromStatus,
        });

        await expect(
          ctx.service.approve(
            ctx.publishedActivityId,
            regId,
            { reviewNote: 'x' },
            ctx.adminPayload,
            AUDIT_META,
          ),
        ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID });

        // DB 状态不变,reviewer/审核字段未误写
        const db = await ctx.prisma.activityRegistration.findUniqueOrThrow({
          where: { id: regId },
          select: {
            statusCode: true,
            reviewedBy: true,
            reviewedAt: true,
            reviewNote: true,
            cancelledByUserId: true,
            cancelledAt: true,
            cancelReason: true,
          },
        });
        expect(db.statusCode).toBe(fromStatus);
        expect(db.reviewedBy).toBeNull();
        expect(db.reviewedAt).toBeNull();
        expect(db.reviewNote).toBeNull();
        expect(db.cancelledByUserId).toBeNull();
        expect(db.cancelledAt).toBeNull();
        expect(db.cancelReason).toBeNull();

        // 无 audit 写入
        const audits = await ctx.prisma.auditLog.findMany({
          where: { resourceId: regId, event: 'registration.review' },
        });
        expect(audits).toHaveLength(0);
      },
    );
  });

  // ============ B. reject(pending → reject) ============
  describe('B. reject(pending → reject)', () => {
    beforeEach(isolateFixtures);

    it('B1. 成功:返 reject + reviewNote 入库 + audit registration.review.reject', async () => {
      const regId = await seedRegistration({ memberId: ctx.memberCId, statusCode: 'pending' });

      const result = await ctx.service.reject(
        ctx.publishedActivityId,
        regId,
        { reviewNote: '资质不符' },
        ctx.adminPayload,
        AUDIT_META,
      );

      expect(result.statusCode).toBe('reject');
      expect(result.reviewedBy).toBe(ctx.adminUserId);
      expect(result.reviewedAt).not.toBeNull();
      expect(result.reviewNote).toBe('资质不符');

      const db = await ctx.prisma.activityRegistration.findUniqueOrThrow({
        where: { id: regId },
        select: { statusCode: true, reviewNote: true, reviewedBy: true },
      });
      expect(db.statusCode).toBe('reject');
      expect(db.reviewNote).toBe('资质不符');
      expect(db.reviewedBy).toBe(ctx.adminUserId);

      const audits = await ctx.prisma.auditLog.findMany({
        where: { resourceId: regId },
        orderBy: { createdAt: 'asc' },
      });
      expect(audits).toHaveLength(1);
      const c = audits[0].context as {
        extra?: { action?: string; priorStatusCode?: string; nextStatusCode?: string };
      };
      expect(c.extra?.action).toBe('reject');
      expect(c.extra?.priorStatusCode).toBe('pending');
      expect(c.extra?.nextStatusCode).toBe('reject');
    });

    it.each<RegistrationStatus>(['pass', 'reject', 'cancelled'])(
      'B2. 错误起始状态 %s → 抛 ACTIVITY_REGISTRATION_STATUS_INVALID,DB 状态不变,无 audit',
      async (fromStatus) => {
        const regId = await seedRegistration({
          memberId: ctx.memberCId,
          statusCode: fromStatus,
        });

        await expect(
          ctx.service.reject(
            ctx.publishedActivityId,
            regId,
            { reviewNote: '尝试驳回' },
            ctx.adminPayload,
            AUDIT_META,
          ),
        ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID });

        const db = await ctx.prisma.activityRegistration.findUniqueOrThrow({
          where: { id: regId },
          select: {
            statusCode: true,
            reviewedBy: true,
            reviewedAt: true,
            reviewNote: true,
          },
        });
        expect(db.statusCode).toBe(fromStatus);
        expect(db.reviewedBy).toBeNull();
        expect(db.reviewedAt).toBeNull();
        expect(db.reviewNote).toBeNull();

        const audits = await ctx.prisma.auditLog.findMany({
          where: { resourceId: regId, event: 'registration.review' },
        });
        expect(audits).toHaveLength(0);
      },
    );
  });

  // ============ C. cancelAdmin(pending|pass → cancelled) ============
  describe('C. cancelAdmin(pending|pass → cancelled)', () => {
    beforeEach(isolateFixtures);

    it('C1. pending → cancelled:cancelledByPath=admin + cancelReason 入库 + audit', async () => {
      const regId = await seedRegistration({ memberId: ctx.memberCId, statusCode: 'pending' });

      const result = await ctx.service.cancelAdmin(
        ctx.publishedActivityId,
        regId,
        { cancelReason: '管理员代取消' },
        ctx.adminPayload,
        AUDIT_META,
      );

      expect(result.statusCode).toBe('cancelled');
      expect(result.cancelledByUserId).toBe(ctx.adminUserId);
      expect(result.cancelledAt).not.toBeNull();
      expect(result.cancelReason).toBe('管理员代取消');
      // 审核字段保持未触碰
      expect(result.reviewedBy).toBeNull();
      expect(result.reviewedAt).toBeNull();

      const db = await ctx.prisma.activityRegistration.findUniqueOrThrow({
        where: { id: regId },
        select: {
          statusCode: true,
          cancelledByUserId: true,
          cancelledAt: true,
          cancelReason: true,
        },
      });
      expect(db.statusCode).toBe('cancelled');
      expect(db.cancelledByUserId).toBe(ctx.adminUserId);
      expect(db.cancelledAt).not.toBeNull();
      expect(db.cancelReason).toBe('管理员代取消');

      const audits = await ctx.prisma.auditLog.findMany({ where: { resourceId: regId } });
      expect(audits).toHaveLength(1);
      const c = audits[0].context as {
        extra?: { action?: string; cancelledByPath?: string; nextStatusCode?: string };
      };
      expect(c.extra?.action).toBe('cancel');
      expect(c.extra?.cancelledByPath).toBe('admin');
      expect(c.extra?.nextStatusCode).toBe('cancelled');
    });

    it('C2. pass → cancelled:已审核字段保留 + cancel 三字段写入', async () => {
      const regId = await seedRegistration({
        memberId: ctx.memberCId,
        statusCode: 'pass',
        reviewerUserId: ctx.adminUserId,
        reviewedAtIso: '2026-04-10T10:00:00.000Z',
        reviewNote: '已通过',
      });

      const result = await ctx.service.cancelAdmin(
        ctx.publishedActivityId,
        regId,
        {},
        ctx.adminPayload,
        AUDIT_META,
      );

      expect(result.statusCode).toBe('cancelled');
      expect(result.cancelledByUserId).toBe(ctx.adminUserId);
      expect(result.cancelledAt).not.toBeNull();
      expect(result.cancelReason).toBeNull();
      // 既有审核字段保留
      expect(result.reviewedBy).toBe(ctx.adminUserId);
      expect(result.reviewNote).toBe('已通过');

      const db = await ctx.prisma.activityRegistration.findUniqueOrThrow({
        where: { id: regId },
        select: {
          statusCode: true,
          reviewedBy: true,
          reviewNote: true,
          cancelledByUserId: true,
          cancelReason: true,
        },
      });
      expect(db.statusCode).toBe('cancelled');
      expect(db.reviewedBy).toBe(ctx.adminUserId);
      expect(db.reviewNote).toBe('已通过');
      expect(db.cancelledByUserId).toBe(ctx.adminUserId);
      expect(db.cancelReason).toBeNull();
    });

    it.each<RegistrationStatus>(['reject', 'cancelled'])(
      'C3. 错误起始状态 %s → 抛 ACTIVITY_REGISTRATION_STATUS_INVALID,DB 状态不变,无 audit',
      async (fromStatus) => {
        const regId = await seedRegistration({
          memberId: ctx.memberCId,
          statusCode: fromStatus,
        });

        await expect(
          ctx.service.cancelAdmin(
            ctx.publishedActivityId,
            regId,
            { cancelReason: 'x' },
            ctx.adminPayload,
            AUDIT_META,
          ),
        ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID });

        const db = await ctx.prisma.activityRegistration.findUniqueOrThrow({
          where: { id: regId },
          select: {
            statusCode: true,
            cancelledByUserId: true,
            cancelledAt: true,
            cancelReason: true,
          },
        });
        expect(db.statusCode).toBe(fromStatus);
        expect(db.cancelledByUserId).toBeNull();
        expect(db.cancelledAt).toBeNull();
        expect(db.cancelReason).toBeNull();

        const audits = await ctx.prisma.auditLog.findMany({ where: { resourceId: regId } });
        expect(audits).toHaveLength(0);
      },
    );
  });

  // ============ D. cancelMy(pending|pass → cancelled + ownership) ============
  describe('D. cancelMy(pending|pass → cancelled + ownership)', () => {
    beforeEach(isolateFixtures);

    it('D1. pending → cancelled:cancelledByPath=self,cancelledByUserId=user.id', async () => {
      const regId = await seedRegistration({
        memberId: ctx.memberAId, // selfA owns memberA
        statusCode: 'pending',
      });

      const result = await ctx.service.cancelMy(
        regId,
        { cancelReason: '临时有事' },
        ctx.selfAPayload,
        AUDIT_META,
      );

      expect(result.statusCode).toBe('cancelled');
      expect(result.cancelledByUserId).toBe(ctx.selfAUserId);
      expect(result.cancelReason).toBe('临时有事');

      const audits = await ctx.prisma.auditLog.findMany({ where: { resourceId: regId } });
      expect(audits).toHaveLength(1);
      const c = audits[0].context as {
        extra?: { action?: string; cancelledByPath?: string };
      };
      expect(c.extra?.action).toBe('cancel');
      expect(c.extra?.cancelledByPath).toBe('self');
    });

    it('D2. pass → cancelled:既有 reviewer 保留 + cancel 三字段写入', async () => {
      const regId = await seedRegistration({
        memberId: ctx.memberAId,
        statusCode: 'pass',
        reviewerUserId: ctx.adminUserId,
        reviewedAtIso: '2026-04-10T10:00:00.000Z',
        reviewNote: '审核通过',
      });

      const result = await ctx.service.cancelMy(regId, {}, ctx.selfAPayload, AUDIT_META);

      expect(result.statusCode).toBe('cancelled');
      expect(result.cancelledByUserId).toBe(ctx.selfAUserId);
      expect(result.reviewedBy).toBe(ctx.adminUserId);
      expect(result.reviewNote).toBe('审核通过');

      const db = await ctx.prisma.activityRegistration.findUniqueOrThrow({
        where: { id: regId },
        select: { statusCode: true, reviewedBy: true, cancelledByUserId: true },
      });
      expect(db.statusCode).toBe('cancelled');
      expect(db.reviewedBy).toBe(ctx.adminUserId);
      expect(db.cancelledByUserId).toBe(ctx.selfAUserId);
    });

    it.each<RegistrationStatus>(['reject', 'cancelled'])(
      'D3. 错误起始状态 %s → 抛 ACTIVITY_REGISTRATION_STATUS_INVALID(本人 reg),DB 不变,无 audit',
      async (fromStatus) => {
        const regId = await seedRegistration({
          memberId: ctx.memberAId,
          statusCode: fromStatus,
        });

        await expect(
          ctx.service.cancelMy(regId, { cancelReason: 'x' }, ctx.selfAPayload, AUDIT_META),
        ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID });

        const db = await ctx.prisma.activityRegistration.findUniqueOrThrow({
          where: { id: regId },
          select: {
            statusCode: true,
            cancelledByUserId: true,
            cancelledAt: true,
            cancelReason: true,
          },
        });
        expect(db.statusCode).toBe(fromStatus);
        expect(db.cancelledByUserId).toBeNull();
        expect(db.cancelledAt).toBeNull();
        expect(db.cancelReason).toBeNull();

        const audits = await ctx.prisma.auditLog.findMany({ where: { resourceId: regId } });
        expect(audits).toHaveLength(0);
      },
    );

    it('D4. ownership:cancelMy 他人的 reg → ACTIVITY_REGISTRATION_NOT_FOUND,DB 不变,无 audit', async () => {
      // selfA 试取消 memberB 拥有的 reg → NOT_FOUND
      const regId = await seedRegistration({
        memberId: ctx.memberBId,
        statusCode: 'pending',
      });

      await expect(
        ctx.service.cancelMy(regId, { cancelReason: '试越权' }, ctx.selfAPayload, AUDIT_META),
      ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_REGISTRATION_NOT_FOUND });

      const db = await ctx.prisma.activityRegistration.findUniqueOrThrow({
        where: { id: regId },
        select: { statusCode: true, cancelledByUserId: true, cancelReason: true },
      });
      expect(db.statusCode).toBe('pending');
      expect(db.cancelledByUserId).toBeNull();
      expect(db.cancelReason).toBeNull();

      const audits = await ctx.prisma.auditLog.findMany({ where: { resourceId: regId } });
      expect(audits).toHaveLength(0);
    });
  });

  // ============ E. Uniqueness & capacity ============
  describe('E. Uniqueness & capacity', () => {
    beforeEach(isolateFixtures);

    it('E1. active 报名存在(pending)→ 再 create 拒 ACTIVITY_REGISTRATION_ALREADY_EXISTS,无新 reg / 无 audit', async () => {
      await seedRegistration({ memberId: ctx.memberCId, statusCode: 'pending' });
      const beforeCount = await ctx.prisma.activityRegistration.count();
      const beforeAuditCount = await ctx.prisma.auditLog.count({
        where: { event: 'registration.create' },
      });

      await expect(
        ctx.service.create(
          ctx.publishedActivityId,
          { memberId: ctx.memberCId },
          ctx.adminPayload,
          AUDIT_META,
        ),
      ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_REGISTRATION_ALREADY_EXISTS });

      const afterCount = await ctx.prisma.activityRegistration.count();
      expect(afterCount).toBe(beforeCount); // 无新 reg

      const afterAuditCount = await ctx.prisma.auditLog.count({
        where: { event: 'registration.create' },
      });
      expect(afterAuditCount).toBe(beforeAuditCount); // 无新 audit
    });

    it('E2. cancelled 后允许重新报名:同一 (activity, member) 多条 cancelled + 新 pending', async () => {
      // 先 seed 一条 cancelled(模拟历史取消记录)
      const cancelledRegId = await seedRegistration({
        memberId: ctx.memberCId,
        statusCode: 'cancelled',
        cancelledByUserId: ctx.adminUserId,
        cancelledAtIso: '2026-04-05T10:00:00.000Z',
        cancelReason: '之前取消',
      });

      // 重新报名应成功
      const result = await ctx.service.create(
        ctx.publishedActivityId,
        { memberId: ctx.memberCId },
        ctx.adminPayload,
        AUDIT_META,
      );
      expect(result.statusCode).toBe('pending');
      expect(result.id).not.toBe(cancelledRegId);

      // DB 两条共存:1 cancelled + 1 pending
      const allRows = await ctx.prisma.activityRegistration.findMany({
        where: { activityId: ctx.publishedActivityId, memberId: ctx.memberCId },
        select: { id: true, statusCode: true },
      });
      expect(allRows).toHaveLength(2);
      const statuses = allRows.map((r) => r.statusCode).sort();
      expect(statuses).toEqual(['cancelled', 'pending']);

      // create audit 写了一条
      const audits = await ctx.prisma.auditLog.findMany({
        where: { event: 'registration.create', resourceId: result.id },
      });
      expect(audits).toHaveLength(1);
    });

    it('E3. capacity=1 + 1 pass 时,create 新 reg → ACTIVITY_CAPACITY_EXCEEDED,无新 reg / 无 audit', async () => {
      const capacityActivityId = await createActivity({ capacity: 1 });
      // 已存在 1 个 pass
      await seedRegistration({
        activityId: capacityActivityId,
        memberId: ctx.memberAId,
        statusCode: 'pass',
        reviewerUserId: ctx.adminUserId,
        reviewedAtIso: '2026-04-15T09:00:00.000Z',
      });

      const beforeCount = await ctx.prisma.activityRegistration.count({
        where: { activityId: capacityActivityId },
      });

      await expect(
        ctx.service.create(
          capacityActivityId,
          { memberId: ctx.memberCId },
          ctx.adminPayload,
          AUDIT_META,
        ),
      ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_CAPACITY_EXCEEDED });

      const afterCount = await ctx.prisma.activityRegistration.count({
        where: { activityId: capacityActivityId },
      });
      expect(afterCount).toBe(beforeCount); // 无新 reg

      const audits = await ctx.prisma.auditLog.findMany({
        where: { event: 'registration.create' },
      });
      expect(audits).toHaveLength(0);
    });

    it('E4. capacity=1 + 1 pass 时,approve 第二条 pending → ACTIVITY_CAPACITY_EXCEEDED,DB 状态不变,无 audit', async () => {
      const capacityActivityId = await createActivity({ capacity: 1 });
      // 1 个 pass(占满)
      await seedRegistration({
        activityId: capacityActivityId,
        memberId: ctx.memberAId,
        statusCode: 'pass',
        reviewerUserId: ctx.adminUserId,
        reviewedAtIso: '2026-04-15T09:00:00.000Z',
      });
      // 1 个 pending(待审批)
      const pendingRegId = await seedRegistration({
        activityId: capacityActivityId,
        memberId: ctx.memberCId,
        statusCode: 'pending',
      });

      await expect(
        ctx.service.approve(
          capacityActivityId,
          pendingRegId,
          { reviewNote: 'x' },
          ctx.adminPayload,
          AUDIT_META,
        ),
      ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_CAPACITY_EXCEEDED });

      // pendingReg 状态未变,reviewer 字段未写
      const db = await ctx.prisma.activityRegistration.findUniqueOrThrow({
        where: { id: pendingRegId },
        select: { statusCode: true, reviewedBy: true, reviewedAt: true, reviewNote: true },
      });
      expect(db.statusCode).toBe('pending');
      expect(db.reviewedBy).toBeNull();
      expect(db.reviewedAt).toBeNull();
      expect(db.reviewNote).toBeNull();

      const audits = await ctx.prisma.auditLog.findMany({
        where: { resourceId: pendingRegId, event: 'registration.review' },
      });
      expect(audits).toHaveLength(0);
    });
  });

  // ============ F. Audit failure rollback ============
  describe('F. Audit failure rollback', () => {
    beforeEach(isolateFixtures);

    it('F1. create 路径 AuditLogsService.log 抛错 → $transaction 回滚:无 reg + 无 audit', async () => {
      const beforeCount = await ctx.prisma.activityRegistration.count();

      const logSpy = jest
        .spyOn(ctx.auditLogs, 'log')
        .mockRejectedValueOnce(new Error('simulated audit failure'));

      await expect(
        ctx.service.create(
          ctx.publishedActivityId,
          { memberId: ctx.memberCId },
          ctx.adminPayload,
          AUDIT_META,
        ),
      ).rejects.toThrow('simulated audit failure');

      expect(logSpy).toHaveBeenCalledTimes(1);

      // 回滚证据 1:无新 reg
      const afterCount = await ctx.prisma.activityRegistration.count();
      expect(afterCount).toBe(beforeCount);

      // 回滚证据 2:无 create audit 落库(D-S7 红线:audit 失败 → 整个事务回滚)
      const audits = await ctx.prisma.auditLog.findMany({
        where: { event: 'registration.create' },
      });
      expect(audits).toHaveLength(0);
    });
  });

  // ============ G. reopen(reject → pending;v0.40.0 审批后悔药) ============
  describe('G. reopen(reject → pending)', () => {
    beforeEach(isolateFixtures);

    it('G1. reject → pending:清空 reviewedBy/reviewedAt/reviewNote + audit registration.review.reopen', async () => {
      const regId = await seedRegistration({
        memberId: ctx.memberCId,
        statusCode: 'reject',
        reviewerUserId: ctx.adminUserId,
        reviewedAtIso: '2026-04-10T10:00:00.000Z',
        reviewNote: '资质不符',
      });

      const result = await ctx.service.reopen(
        ctx.publishedActivityId,
        regId,
        ctx.adminPayload,
        AUDIT_META,
      );

      expect(result.statusCode).toBe('pending');
      // 审核三字段清空
      expect(result.reviewedBy).toBeNull();
      expect(result.reviewedAt).toBeNull();
      expect(result.reviewNote).toBeNull();

      const db = await ctx.prisma.activityRegistration.findUniqueOrThrow({
        where: { id: regId },
        select: { statusCode: true, reviewedBy: true, reviewedAt: true, reviewNote: true },
      });
      expect(db.statusCode).toBe('pending');
      expect(db.reviewedBy).toBeNull();
      expect(db.reviewedAt).toBeNull();
      expect(db.reviewNote).toBeNull();

      // audit:event = registration.review,extra.action = reopen
      const audits = await ctx.prisma.auditLog.findMany({ where: { resourceId: regId } });
      expect(audits).toHaveLength(1);
      expect(audits[0].event).toBe('registration.review');
      const c = audits[0].context as {
        extra?: { action?: string; priorStatusCode?: string; nextStatusCode?: string };
      };
      expect(c.extra?.action).toBe('reopen');
      expect(c.extra?.priorStatusCode).toBe('reject');
      expect(c.extra?.nextStatusCode).toBe('pending');
    });

    it.each<RegistrationStatus>(['pending', 'pass', 'cancelled'])(
      'G2. 错误起始状态 %s → 抛 ACTIVITY_REGISTRATION_STATUS_INVALID,DB 状态不变,无 audit',
      async (fromStatus) => {
        const regId = await seedRegistration({ memberId: ctx.memberCId, statusCode: fromStatus });

        await expect(
          ctx.service.reopen(ctx.publishedActivityId, regId, ctx.adminPayload, AUDIT_META),
        ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID });

        const db = await ctx.prisma.activityRegistration.findUniqueOrThrow({
          where: { id: regId },
          select: { statusCode: true },
        });
        expect(db.statusCode).toBe(fromStatus);

        const audits = await ctx.prisma.auditLog.findMany({ where: { resourceId: regId } });
        expect(audits).toHaveLength(0);
      },
    );

    it('G3. reopen 后可重新 approve(pending → pass):解锁"被拒者占槽无法重报"死锁的完整闭环', async () => {
      const regId = await seedRegistration({
        memberId: ctx.memberCId,
        statusCode: 'reject',
        reviewerUserId: ctx.adminUserId,
        reviewNote: '先拒',
      });

      await ctx.service.reopen(ctx.publishedActivityId, regId, ctx.adminPayload, AUDIT_META);
      const approved = await ctx.service.approve(
        ctx.publishedActivityId,
        regId,
        { reviewNote: '改判通过' },
        ctx.adminPayload,
        AUDIT_META,
      );
      expect(approved.statusCode).toBe('pass');
    });
  });

  // ============ H. approve 活动状态闸(cancelled / completed 禁批) ============
  describe('H. approve 活动状态闸(v0.40.0 收口①)', () => {
    beforeEach(isolateFixtures);

    async function createActivityWithStatus(statusCode: string): Promise<string> {
      const a = await ctx.prisma.activity.create({
        data: {
          title: `Reg State Activity ${statusCode}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          activityTypeCode: 'reg-state-type',
          organizationId: ctx.organizationId,
          startAt: new Date('2026-04-20T08:00:00.000Z'),
          endAt: new Date('2026-04-20T12:00:00.000Z'),
          location: 'state-approve-gate',
          statusCode,
          isPublicRegistration: true,
        },
        select: { id: true },
      });
      return a.id;
    }

    it.each(['cancelled', 'completed'])(
      'H1. 活动 %s 时 approve pending 报名 → ACTIVITY_ENDED_OR_CANCELLED_APPROVE_FORBIDDEN,DB 不变,无 audit',
      async (activityStatus) => {
        const activityId = await createActivityWithStatus(activityStatus);
        const regId = await seedRegistration({
          activityId,
          memberId: ctx.memberCId,
          statusCode: 'pending',
        });

        await expect(
          ctx.service.approve(activityId, regId, { reviewNote: 'x' }, ctx.adminPayload, AUDIT_META),
        ).rejects.toMatchObject({
          biz: BizCode.ACTIVITY_ENDED_OR_CANCELLED_APPROVE_FORBIDDEN,
        });

        const db = await ctx.prisma.activityRegistration.findUniqueOrThrow({
          where: { id: regId },
          select: { statusCode: true, reviewedBy: true },
        });
        expect(db.statusCode).toBe('pending'); // 未变
        expect(db.reviewedBy).toBeNull();

        const audits = await ctx.prisma.auditLog.findMany({ where: { resourceId: regId } });
        expect(audits).toHaveLength(0);
      },
    );

    it('H2. reject / cancelAdmin 刻意不受活动状态闸限制(清理残留待审队列):cancelled 活动仍可 reject / cancel', async () => {
      const activityId = await createActivityWithStatus('cancelled');
      const rejectRegId = await seedRegistration({
        activityId,
        memberId: ctx.memberCId,
        statusCode: 'pending',
      });
      const rejected = await ctx.service.reject(
        activityId,
        rejectRegId,
        { reviewNote: '活动已取消,清理' },
        ctx.adminPayload,
        AUDIT_META,
      );
      expect(rejected.statusCode).toBe('reject');

      const cancelRegId = await seedRegistration({
        activityId,
        memberId: ctx.memberBId,
        statusCode: 'pending',
      });
      const cancelled = await ctx.service.cancelAdmin(
        activityId,
        cancelRegId,
        { cancelReason: '活动已取消,清理' },
        ctx.adminPayload,
        AUDIT_META,
      );
      expect(cancelled.statusCode).toBe('cancelled');
    });
  });

  // ============ I. cancel 考勤守卫(已考勤报名禁取消) ============
  describe('I. cancel 考勤守卫(v0.40.0 收口⑦)', () => {
    beforeEach(isolateFixtures);

    afterEach(async () => {
      await ctx.prisma.attendanceRecord.deleteMany({});
      await ctx.prisma.attendanceSheet.deleteMany({});
    });

    // 造一条引用该 registration 的未软删 AttendanceRecord(经最小 AttendanceSheet)。
    async function seedAttendanceForRegistration(
      registrationId: string,
      memberId: string,
    ): Promise<void> {
      const sheet = await ctx.prisma.attendanceSheet.create({
        data: {
          activityId: ctx.publishedActivityId,
          submitterUserId: ctx.adminUserId,
          statusCode: 'pending',
        },
        select: { id: true },
      });
      await ctx.prisma.attendanceRecord.create({
        data: {
          sheetId: sheet.id,
          memberId,
          roleCode: 'member',
          checkInAt: new Date('2026-04-01T08:00:00.000Z'),
          checkOutAt: new Date('2026-04-01T12:00:00.000Z'),
          serviceHours: 4,
          attendanceStatusCode: 'present',
          registrationId,
        },
      });
    }

    it('I1. cancelAdmin:pass 报名有考勤记录 → ACTIVITY_REGISTRATION_HAS_ATTENDANCE,DB 不变,无 audit', async () => {
      const regId = await seedRegistration({
        memberId: ctx.memberCId,
        statusCode: 'pass',
        reviewerUserId: ctx.adminUserId,
      });
      await seedAttendanceForRegistration(regId, ctx.memberCId);

      await expect(
        ctx.service.cancelAdmin(
          ctx.publishedActivityId,
          regId,
          { cancelReason: '试取消' },
          ctx.adminPayload,
          AUDIT_META,
        ),
      ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_REGISTRATION_HAS_ATTENDANCE });

      const db = await ctx.prisma.activityRegistration.findUniqueOrThrow({
        where: { id: regId },
        select: { statusCode: true, cancelledByUserId: true },
      });
      expect(db.statusCode).toBe('pass'); // 未变
      expect(db.cancelledByUserId).toBeNull();

      const audits = await ctx.prisma.auditLog.findMany({ where: { resourceId: regId } });
      expect(audits).toHaveLength(0);
    });

    it('I2. cancelMy:本人 pass 报名有考勤记录 → ACTIVITY_REGISTRATION_HAS_ATTENDANCE,DB 不变', async () => {
      const regId = await seedRegistration({
        memberId: ctx.memberAId, // selfA owns memberA
        statusCode: 'pass',
        reviewerUserId: ctx.adminUserId,
      });
      await seedAttendanceForRegistration(regId, ctx.memberAId);

      await expect(
        ctx.service.cancelMy(regId, { cancelReason: '试取消' }, ctx.selfAPayload, AUDIT_META),
      ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_REGISTRATION_HAS_ATTENDANCE });

      const db = await ctx.prisma.activityRegistration.findUniqueOrThrow({
        where: { id: regId },
        select: { statusCode: true },
      });
      expect(db.statusCode).toBe('pass');
    });

    it('I3. 软删考勤记录不阻断取消:仅未软删记录计数', async () => {
      const regId = await seedRegistration({
        memberId: ctx.memberCId,
        statusCode: 'pass',
        reviewerUserId: ctx.adminUserId,
      });
      const sheet = await ctx.prisma.attendanceSheet.create({
        data: {
          activityId: ctx.publishedActivityId,
          submitterUserId: ctx.adminUserId,
          statusCode: 'pending',
        },
        select: { id: true },
      });
      await ctx.prisma.attendanceRecord.create({
        data: {
          sheetId: sheet.id,
          memberId: ctx.memberCId,
          roleCode: 'member',
          checkInAt: new Date('2026-04-01T08:00:00.000Z'),
          checkOutAt: new Date('2026-04-01T12:00:00.000Z'),
          serviceHours: 4,
          attendanceStatusCode: 'present',
          registrationId: regId,
          deletedAt: new Date('2026-04-02T00:00:00.000Z'), // 已软删
        },
      });

      const cancelled = await ctx.service.cancelAdmin(
        ctx.publishedActivityId,
        regId,
        { cancelReason: '考勤已撤,可取消' },
        ctx.adminPayload,
        AUDIT_META,
      );
      expect(cancelled.statusCode).toBe('cancelled');
    });
  });
});
