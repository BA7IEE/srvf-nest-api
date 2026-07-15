import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { PrismaService } from '../../src/database/prisma.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { AttendancesService } from '../../src/modules/attendances/attendances.service';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// attendances reject(...) 状态转移 characterization tests(StateMachine 抽离前最后一块前置)。
//
// 目标:在抽 `StateMachine` 前显式锁定 `AttendancesService.reject(...)` 的现状行为。
//
// 范围(complement of PR #176 + PR #181):
//   - PR #176 attendances-state-transition.e2e-spec.ts 锁了 approve / finalApprove / finalReject
//   - PR #181 attendances-status-guards.e2e-spec.ts 锁了 submit / edit / softDelete
//   - 本 spec 锁 reject(pending → rejected)+ 4 个 wrong-state 拒绝;沿 PR #176 Group A + Group C 范式。
//
// 现状(只读复核):
//   - reject 仅允许 `pending`;非 pending 统一抛 `ATTENDANCE_SHEET_STATUS_INVALID`(单 BizCode,
//     不分 source state — 与 edit / softDelete 的 per-state 4 个 BizCode 不同)。
//   - 成功:Sheet.statusCode → 'rejected';写 reviewerUserId / reviewedAt / reviewNote。
//   - audit:event = 'attendance-sheet.review';extra.operation = 'review';extra.action = 'reject';
//     extra.priorStatusCode / extra.nextStatusCode 写实际 source / target。
//
// 测试策略(沿 PR #176 范式):
//   - createTestApp + resetDb + 真实 PrismaService(test database)。
//   - service-level e2e:绕过 HTTP / Guard / RolesGuard,直接 `app.get(AttendancesService).reject(...)`。
//   - per-test `isolateFixtures()` 清 sheets / records / audit_logs(保留 user/member/org/activity)。
//   - direct prisma seed Sheet 任意起始 statusCode(包括非 pending 4 种),覆盖护栏路径。
//   - **不测 reviewNote 必填** — DTO `@MinLength(1)` 在 controller path 校验;service 不做空字符串兜底
//     (reject 与 finalReject 不同;finalReject 在 service 内有 trim 兜底,reject 没有)。本 spec
//     只锁 transition 决策与副作用,不锁 DTO validation。
//
// 本 PR 范围:
//   ❌ 不改 attendances.service.ts
//   ❌ 不抽 StateMachine / TimeOverlapPolicy / ContributionCalculator / AuditRecorder
//   ❌ 不拆 controller / DTO / schema / migration / OpenAPI snapshot
//   ✅ 只新增本测试文件

type SheetStatus = 'pending' | 'pending_final_review' | 'approved' | 'rejected' | 'final_rejected';

interface SeedContext {
  prisma: PrismaService;
  service: AttendancesService;
  reviewerUserId: string;
  reviewerPayload: CurrentUserPayload;
  memberId: string;
  activityId: string;
}

const AUDIT_META: AuditMeta = {
  requestId: 'rej-test-req-00000000000000001',
  ip: '127.0.0.1',
  ua: 'jest/30 attendances-reject-transition',
};

describe('AttendancesService reject transition (characterization)', () => {
  let app: INestApplication;
  let ctx: SeedContext;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);

    const prisma = app.get(PrismaService);
    const service = app.get(AttendancesService);

    // 一次性 seed 全局公共数据(reviewer / member / org / activity)
    // 与 PR #176 状态转移 spec 一致:reject(...) **仅校验** sheet.statusCode,不走 dict / org
    // 校验路径(那是 submit / edit 的逻辑),因此 dict items 字符串内容随意,FK 由 organization 兜底。
    const reviewer = await prisma.user.create({
      data: {
        username: 'att-rej-reviewer',
        passwordHash: '$2a$10$dummy-hash-not-used-since-no-login-needed',
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
      },
      select: { id: true },
    });

    // Slow-4 T3(评审稿 §8 / D-S4-6):本 spec 直调 service(绕过 Guard),判权已下沉
    // service 层 rbac.can();给 ADMIN 测试用户 reviewer 补挂 biz-admin(零漂移:对应迁移前
    // @Roles(SUPER_ADMIN, ADMIN) 放行语义;断言零修改)。
    const bizSeed = await seedBizAdminPermissionsAndRole(app);
    await grantBizAdminToUser(app, reviewer.id, bizSeed.bizAdminRoleId);

    const member = await prisma.member.create({
      data: { memberNo: 'att-rej-m-001', displayName: 'Reject Member' },
      select: { id: true },
    });

    // Activity 需要 Organization FK(沿 schema.prisma Activity.organizationId Restrict)
    const nodeDict = await prisma.dictType.create({
      data: { code: 'node_type', label: '节点类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeDict.id, code: 'rej-root', label: '根' },
    });
    const rootOrg = await prisma.organization.create({
      data: { name: 'Reject Root Org', nodeTypeCode: 'rej-root', parentId: null },
      select: { id: true },
    });

    // Activity statusCode 用 'completed':reject 不依赖 activity status,任意非 cancelled 即可;
    // 用 completed 锁定补录考勤仍允许的参与状态语义。
    const activity = await prisma.activity.create({
      data: {
        title: 'Reject Activity',
        activityTypeCode: 'rej-type',
        organizationId: rootOrg.id,
        startAt: new Date('2026-08-01T08:00:00.000Z'),
        endAt: new Date('2026-08-01T12:00:00.000Z'),
        location: 'reject demo',
        statusCode: 'completed',
        isPublicRegistration: true,
      },
      select: { id: true },
    });

    ctx = {
      prisma,
      service,
      reviewerUserId: reviewer.id,
      reviewerPayload: {
        id: reviewer.id,
        username: 'att-rej-reviewer',
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
        memberId: null,
      },
      memberId: member.id,
      activityId: activity.id,
    };
  });

  afterAll(async () => {
    await app.close();
  });

  // 每个 case 清 sheets / records / audit_logs(保留 user / member / org / activity)。
  async function isolateFixtures(): Promise<void> {
    // 顺序很关键:先删 child records,再删 parent sheets(Restrict FK)
    await ctx.prisma.attendanceRecord.deleteMany({});
    await ctx.prisma.attendanceSheet.deleteMany({});
    await ctx.prisma.auditLog.deleteMany({});
  }

  /**
   * 直接 prisma seed AttendanceSheet + 1 条 active record(绕过 submit 状态机)。
   * 沿 attendances-state-transition.e2e-spec.ts seedSheet 范式;仅简化为 1 条 record(reject 不依赖 records)。
   */
  async function seedSheet(opts: {
    statusCode: SheetStatus;
    checkInOffsetHours?: number;
  }): Promise<string> {
    const offsetHours = opts.checkInOffsetHours ?? 0;
    const sheet = await ctx.prisma.attendanceSheet.create({
      data: {
        activityId: ctx.activityId,
        submitterUserId: ctx.reviewerUserId, // 简化:reviewer 兼作 submitter(FK 满足)
        statusCode: opts.statusCode,
        version: 1,
      },
      select: { id: true },
    });
    const checkIn = new Date(
      new Date('2026-08-10T08:00:00.000Z').getTime() + offsetHours * 60 * 60 * 1000,
    );
    const checkOut = new Date(checkIn.getTime() + 4 * 60 * 60 * 1000);
    await ctx.prisma.attendanceRecord.create({
      data: {
        sheetId: sheet.id,
        memberId: ctx.memberId,
        roleCode: 'rej-role',
        checkInAt: checkIn,
        checkOutAt: checkOut,
        serviceHours: 4,
        attendanceStatusCode: 'normal',
        contributionPoints: 1, // 任意非 null;reject 不读 contributionPoints
      },
    });
    return sheet.id;
  }

  // ============ A. reject(pending → rejected)============
  describe('A. reject(pending → rejected)', () => {
    beforeEach(isolateFixtures);

    it('成功路径:返 rejected + DB 落库 + reviewer 三字段 + record 跟随软删(F4)+ audit review.reject', async () => {
      const sheetId = await seedSheet({ statusCode: 'pending' });

      const result = await ctx.service.reject(
        sheetId,
        { reviewNote: '数据有误,驳回' },
        ctx.reviewerPayload,
        AUDIT_META,
      );

      // DTO 返回
      expect(result.statusCode).toBe('rejected');
      expect(result.reviewerUserId).toBe(ctx.reviewerUserId);
      expect(result.reviewedAt).not.toBeNull();
      expect(result.reviewNote).toBe('数据有误,驳回');

      // DB 落库反向断言
      const db = await ctx.prisma.attendanceSheet.findUniqueOrThrow({
        where: { id: sheetId },
        select: {
          statusCode: true,
          reviewerUserId: true,
          reviewedAt: true,
          reviewNote: true,
          finalReviewerUserId: true,
          finalReviewedAt: true,
          finalReviewNote: true,
        },
      });
      expect(db.statusCode).toBe('rejected');
      expect(db.reviewerUserId).toBe(ctx.reviewerUserId);
      expect(db.reviewedAt).not.toBeNull();
      expect(db.reviewNote).toBe('数据有误,驳回');
      // finalReviewer 三字段不写(reject 是 APD 一级路径,不触及终审)
      expect(db.finalReviewerUserId).toBeNull();
      expect(db.finalReviewedAt).toBeNull();
      expect(db.finalReviewNote).toBeNull();

      // F4(#399):record 跟随软删(对称 final_rejected;deletedAt 写为 reviewedAt 同刻)
      const recs = await ctx.prisma.attendanceRecord.findMany({
        where: { sheetId },
        select: { deletedAt: true },
      });
      expect(recs).toHaveLength(1);
      expect(recs[0].deletedAt).not.toBeNull();
      // 软删时刻 = sheet.reviewedAt 同刻
      expect(recs[0].deletedAt?.getTime()).toBe(db.reviewedAt?.getTime());

      // audit:event = 'attendance-sheet.review',extra 全字段断(F4:reject 现写 recordsCount)
      const audits = await ctx.prisma.auditLog.findMany({
        where: { resourceId: sheetId },
        orderBy: { createdAt: 'desc' },
        take: 1,
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].event).toBe('attendance-sheet.review');
      const ctx0 = audits[0].context as {
        extra?: {
          operation?: string;
          action?: string;
          priorStatusCode?: string;
          nextStatusCode?: string;
          recordsCount?: number;
        };
      };
      expect(ctx0.extra?.operation).toBe('review');
      expect(ctx0.extra?.action).toBe('reject');
      expect(ctx0.extra?.priorStatusCode).toBe('pending');
      expect(ctx0.extra?.nextStatusCode).toBe('rejected');
      // F4:reject 软删 records → 审计写 recordsCount(被软删条数)
      expect(ctx0.extra?.recordsCount).toBe(1);
    });

    it('findings #4/#6:同一 pending approve || reject 仅一方成功且明细与 winner 一致', async () => {
      const sheetId = await seedSheet({ statusCode: 'pending' });
      const results = await Promise.allSettled([
        ctx.service.approve(
          sheetId,
          { reviewNote: 'race approve' },
          ctx.reviewerPayload,
          AUDIT_META,
        ),
        ctx.service.reject(sheetId, { reviewNote: 'race reject' }, ctx.reviewerPayload, AUDIT_META),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((r) => r.status === 'rejected')).toMatchObject({
        status: 'rejected',
        reason: { biz: BizCode.ATTENDANCE_SHEET_STATUS_INVALID },
      });
      const sheet = await ctx.prisma.attendanceSheet.findUniqueOrThrow({
        where: { id: sheetId },
        select: { statusCode: true },
      });
      const record = await ctx.prisma.attendanceRecord.findFirstOrThrow({
        where: { sheetId },
        select: { deletedAt: true },
      });
      if (sheet.statusCode === 'pending_final_review') expect(record.deletedAt).toBeNull();
      else {
        expect(sheet.statusCode).toBe('rejected');
        expect(record.deletedAt).not.toBeNull();
      }
      expect(await ctx.prisma.auditLog.count({ where: { resourceId: sheetId } })).toBe(1);
    });
  });

  // ============ B. reject 错误状态护栏(非 pending 一律拒)============
  // 沿 service.ts:1048-1050 单一 if 守卫:`if (sheet.statusCode !== SHEET_STATUS_PENDING)`;
  // 4 个 source 共用同一 BizCode = ATTENDANCE_SHEET_STATUS_INVALID(与 approve 同型,
  // 与 edit / softDelete 的 per-source-state BizCode 不同 — 此为现状,本 spec 显式锁定)。
  describe('B. reject 错误状态护栏(非 pending 一律拒 ATTENDANCE_SHEET_STATUS_INVALID)', () => {
    beforeEach(isolateFixtures);

    it.each<SheetStatus>(['pending_final_review', 'approved', 'rejected', 'final_rejected'])(
      'from %s → 抛 ATTENDANCE_SHEET_STATUS_INVALID;DB 状态/reviewer 字段/record 不变 + 无 review audit',
      async (fromStatus) => {
        const sheetId = await seedSheet({ statusCode: fromStatus });

        await expect(
          ctx.service.reject(
            sheetId,
            { reviewNote: 'attempting reject from ' + fromStatus },
            ctx.reviewerPayload,
            AUDIT_META,
          ),
        ).rejects.toMatchObject({
          biz: BizCode.ATTENDANCE_SHEET_STATUS_INVALID,
        });

        // DB Sheet 状态/reviewer 字段不变(事务整体回滚)
        const db = await ctx.prisma.attendanceSheet.findUniqueOrThrow({
          where: { id: sheetId },
          select: {
            statusCode: true,
            reviewerUserId: true,
            reviewedAt: true,
            reviewNote: true,
          },
        });
        expect(db.statusCode).toBe(fromStatus);
        expect(db.reviewerUserId).toBeNull();
        expect(db.reviewedAt).toBeNull();
        expect(db.reviewNote).toBeNull();

        // record 不软删
        const recs = await ctx.prisma.attendanceRecord.findMany({
          where: { sheetId },
          select: { deletedAt: true },
        });
        expect(recs).toHaveLength(1);
        expect(recs[0].deletedAt).toBeNull();

        // 无 review audit(护栏前抛出,事务回滚)
        const audits = await ctx.prisma.auditLog.findMany({
          where: { resourceId: sheetId, event: 'attendance-sheet.review' },
        });
        expect(audits).toHaveLength(0);
      },
    );
  });
});
