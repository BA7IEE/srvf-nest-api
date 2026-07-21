import type { INestApplication } from '@nestjs/common';
import { Prisma, Role, UserStatus } from '@prisma/client';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { PrismaService } from '../../src/database/prisma.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { AttendancesService } from '../../src/modules/attendances/attendances.service';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// attendances 状态机 characterization tests(只读评审报告 §10 优先级 2)。
//
// 目标:在抽 `StateMachine` / `ContributionCalculator` 与拆 `attendances.controller.ts` 之前,
// 显式锁定 `attendances.service.ts` 三组核心状态转移方法的现状行为:
//   - approve:        pending → pending_final_review(R31 校验 contributionPoints 非 null)
//   - finalApprove:   pending_final_review → approved(贡献值生效;触发 attendance.recorded event)
//   - finalReject:    pending_final_review → final_rejected(records 同事务软删;event 不触发)
//
// 沿 docs/api-surface-policy.md §8 P1 禁止事项 + only-read review report §10:
//   ❌ 不改 attendances.service.ts(本 PR 只补测试)
//   ❌ 不抽 StateMachine / ContributionCalculator / Policy(后续独立 PR)
//   ❌ 不拆 controller(P1-C step 4 独立 PR)
//
// 测试策略选择(report §2):
//   - 选择 service-level e2e spec(`test/e2e/*.e2e-spec.ts`)而非 unit spec(`src/**/*.spec.ts`):
//     * 项目既有 unit spec 范式(`audit-logs.service.spec.ts:17` 明确"$transaction + findMany + count
//       复杂 mock,留 e2e 覆盖")— 本任务核心是事务 / audit / records soft-delete,不适合 mock
//     * e2e jest config 已配 globalSetup,自动准备 test database(`app_test` PostgreSQL);
//       unit jest config 无 DB,运行时无法实测 `$transaction` 行为
//     * 通过 `createTestApp()` + `app.get(AttendancesService)` 直接调用 service 方法,
//       **绕过 HTTP / Guard / RolesGuard**,纯锁 service 层状态机与副作用
//   - 不 spy `eventPlaceholder('attendance.recorded')`(它是 module-level free function,
//     无法通过 DI 注入 spy);改用 `audit_logs.extra.eventTriggered` 字段间接断言(沿
//     既有 `attendances.e2e-spec.ts:1394-1435` Q-S13 范式)

type SheetStatus = 'pending' | 'pending_final_review' | 'approved' | 'rejected' | 'final_rejected';

interface SeedContext {
  prisma: PrismaService;
  prismaB: PrismaService;
  service: AttendancesService;
  serviceB: AttendancesService;
  reviewerUserId: string;
  reviewerPayload: CurrentUserPayload;
  // 摘码微刀(2026-07-03):biz-admin 不再持终审两码 → finalApprove/finalReject 一律用
  // 独立 SUPER_ADMIN 终审身份(SA 兜底通路;authz 先于状态机,无码者会先吃 30100)
  finalReviewerUserId: string;
  finalReviewerPayload: CurrentUserPayload;
  // PR9 自审约束(22074)后 seedSheet 不能再「reviewer 兼作 submitter」—— 独立 submitter FK
  submitterUserId: string;
  memberId: string;
  activityId: string;
}

interface PgWaiter {
  pid: number;
  databaseName: string;
  blockingPids: number[];
}

const LOCK_OBSERVE_TIMEOUT_MS = 4_000;
const OPERATION_TIMEOUT_MS = 8_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const BLOCKER_TIMEOUT_MS = 20_000;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function settleAllWithTimeout(promises: Promise<unknown>[], label: string): Promise<void> {
  const results = await withTimeout(Promise.allSettled(promises), label, CLEANUP_TIMEOUT_MS);
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (rejected) throw rejected.reason;
}

function preservePrimaryFailure(primary: unknown, cleanup: unknown): void {
  if (primary instanceof Error) {
    Object.defineProperty(primary, 'cause', { value: cleanup, configurable: true });
  }
}

function throwFailure(failure: unknown): never {
  if (failure instanceof Error) throw failure;
  throw new Error('non-Error test failure', { cause: failure });
}

async function waitForDirectPgWaiter(
  observer: PrismaService,
  directBlockerPid: number,
  operation: Promise<unknown>,
  queryPattern: string,
  excludedPids: number[] = [],
): Promise<PgWaiter> {
  let settled = false;
  void operation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const deadline = Date.now() + LOCK_OBSERVE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (settled) throw new Error('attendance operation settled before expected lock wait');
    const rows = await withTimeout(
      observer.$queryRaw<PgWaiter[]>(Prisma.sql`
        SELECT pid, datname AS "databaseName", pg_blocking_pids(pid) AS "blockingPids"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND CAST(${directBlockerPid} AS integer) = ANY(pg_blocking_pids(pid))
          AND query LIKE ${queryPattern}
          AND NOT (pid = ANY(${excludedPids}::integer[]))
        LIMIT 1
      `),
      'attendance lock observer query',
      LOCK_OBSERVE_TIMEOUT_MS,
    );
    if (rows[0]) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`attendance direct waiter missing blocker=${directBlockerPid}`);
}

const AUDIT_META: AuditMeta = {
  requestId: 'attstate-req-0000000000000001',
  ip: '127.0.0.1',
  ua: 'jest/30 attendances-state-transition',
};

describe('AttendancesService state transitions (characterization)', () => {
  let app: INestApplication;
  let appB: INestApplication;
  let ctx: SeedContext;

  beforeAll(async () => {
    app = await createTestApp();
    appB = await createTestApp();
    await resetDb(app);

    const prisma = app.get(PrismaService);
    const prismaB = appB.get(PrismaService);
    const service = app.get(AttendancesService);
    const serviceB = appB.get(AttendancesService);

    // 一次性 seed 全局公共数据(reviewer / member / org / activity)
    // 注意:由于 approve 等方法**仅校验** sheet.statusCode + records.contributionPoints,
    // 不需要真实 dict / org 校验路径(那走 submit/edit;本 spec 仅测 approve/finalApprove/finalReject)
    const reviewer = await prisma.user.create({
      data: {
        username: 'att-state-reviewer',
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

    const submitter = await prisma.user.create({
      data: {
        username: 'att-state-submitter',
        passwordHash: '$2a$10$dummy-hash-not-used-since-no-login-needed',
        role: Role.USER,
        status: UserStatus.ACTIVE,
      },
      select: { id: true },
    });

    // 摘码微刀(2026-07-03):独立 SUPER_ADMIN 终审身份(见 SeedContext 注释;
    // ≠ submitter / ≠ 一级 reviewer,避开 22074/22075)
    const finalReviewer = await prisma.user.create({
      data: {
        username: 'att-state-final-reviewer',
        passwordHash: '$2a$10$dummy-hash-not-used-since-no-login-needed',
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      },
      select: { id: true },
    });

    const member = await prisma.member.create({
      data: { memberNo: 'att-state-m-001', displayName: 'State Member' },
      select: { id: true },
    });

    // Activity 需要 Organization FK(沿 schema.prisma Activity.organizationId Restrict)
    const nodeDict = await prisma.dictType.create({
      data: { code: 'node_type', label: '节点类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeDict.id, code: 'state-root', label: '根' },
    });
    const rootOrg = await prisma.organization.create({
      data: { name: 'State Root Org', nodeTypeCode: 'state-root', parentId: null },
      select: { id: true },
    });

    const activity = await prisma.activity.create({
      data: {
        title: 'State Activity',
        activityTypeCode: 'state-type',
        organizationId: rootOrg.id,
        startAt: new Date('2026-07-01T08:00:00.000Z'),
        endAt: new Date('2026-07-01T12:00:00.000Z'),
        location: '状态机演示',
        statusCode: 'completed',
        isPublicRegistration: true,
      },
      select: { id: true },
    });

    ctx = {
      prisma,
      prismaB,
      service,
      serviceB,
      // PR9:submitter 真正接进 seedSheet(此前仅占位)—— 终审 authz 自审约束下
      // submitter 必须 ≠ 终审人(reviewerPayload),否则全 spec 吃 22074
      submitterUserId: submitter.id,
      reviewerUserId: reviewer.id,
      reviewerPayload: {
        id: reviewer.id,
        username: 'att-state-reviewer',
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
        memberId: null,
      },
      finalReviewerUserId: finalReviewer.id,
      finalReviewerPayload: {
        id: finalReviewer.id,
        username: 'att-state-final-reviewer',
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
        memberId: null,
      },
      memberId: member.id,
      activityId: activity.id,
    };
  });

  afterAll(async () => {
    await settleAllWithTimeout([app.close(), appB.close()], 'attendance app shutdown');
  });

  // 测试前清空 sheets/records/audit_logs(保留 user/member/org/activity)
  async function isolateFixtures(): Promise<void> {
    // 顺序很关键:先删 child records,再删 parent sheets(Restrict FK)
    await ctx.prisma.attendanceRecord.deleteMany({});
    await ctx.prisma.attendanceSheet.deleteMany({});
    await ctx.prisma.auditLog.deleteMany({});
  }

  /**
   * 直接 prisma seed AttendanceSheet + N records(绕过 submit 状态机);
   * 用于初始化任意起始状态(包括非 pending 的 approved / rejected / final_rejected 等),
   * 供状态护栏测试构造前置条件。
   */
  async function seedSheet(opts: {
    statusCode: SheetStatus;
    recordsContributionPoints?: Array<number | null>;
    checkInOffsetHours?: number;
  }): Promise<string> {
    const offsetHours = opts.checkInOffsetHours ?? 0;
    const sheet = await ctx.prisma.attendanceSheet.create({
      data: {
        activityId: ctx.activityId,
        submitterUserId: ctx.submitterUserId, // PR9:独立 submitter(自审约束下不可 reviewer 兼作)
        statusCode: opts.statusCode,
        version: 1,
      },
      select: { id: true },
    });
    const pointsList = opts.recordsContributionPoints ?? [1];
    for (let i = 0; i < pointsList.length; i++) {
      const cp = pointsList[i];
      const checkIn = new Date(
        new Date('2026-07-10T08:00:00.000Z').getTime() + (offsetHours + i * 6) * 60 * 60 * 1000,
      );
      const checkOut = new Date(checkIn.getTime() + 4 * 60 * 60 * 1000);
      await ctx.prisma.attendanceRecord.create({
        data: {
          sheetId: sheet.id,
          memberId: ctx.memberId,
          roleCode: 'state-role',
          checkInAt: checkIn,
          checkOutAt: checkOut,
          serviceHours: 4,
          attendanceStatusCode: 'normal',
          contributionPoints: cp,
        },
      });
    }
    return sheet.id;
  }

  async function runPrimaryReviewLinearization(
    firstAction: 'approve' | 'reject',
    secondAction: 'approve' | 'reject',
  ): Promise<void> {
    const sheetId = await seedSheet({ statusCode: 'pending', recordsContributionPoints: [1] });
    const identities = await Promise.all(
      [ctx.prisma, ctx.prismaB].map(async (client) => {
        const rows = await client.$queryRaw<
          Array<{ pid: number; databaseName: string }>
        >(Prisma.sql`
          SELECT pg_backend_pid() AS pid, current_database() AS "databaseName"
        `);
        return rows[0];
      }),
    );
    expect(identities[0].databaseName).toBe(identities[1].databaseName);
    expect(identities[0].pid).not.toBe(identities[1].pid);
    const notificationCountBefore = await ctx.prisma.notification.count();
    const outboxCountBefore = await ctx.prisma.notificationOutboxIntent.count();

    const rootReached = deferred();
    const mutateRoot = deferred();
    const rootMutated = deferred();
    const releaseRoot = deferred();
    let root!: { pid: number; databaseName: string };
    const blocker = ctx.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ pid: number; databaseName: string }>>(Prisma.sql`
          SELECT pg_backend_pid() AS pid, current_database() AS "databaseName"
          FROM "AttendanceSheet"
          WHERE "id" = ${sheetId}
          FOR UPDATE
        `);
        root = rows[0];
        rootReached.resolve();
        await mutateRoot.promise;
        await tx.attendanceSheet.update({ where: { id: sheetId }, data: { version: 7 } });
        rootMutated.resolve();
        await releaseRoot.promise;
      },
      { timeout: BLOCKER_TIMEOUT_MS },
    );
    const invoke = (service: AttendancesService, action: 'approve' | 'reject') =>
      action === 'approve'
        ? service.approve(
            sheetId,
            { reviewNote: 'linear approve' },
            ctx.reviewerPayload,
            AUDIT_META,
          )
        : service.reject(sheetId, { reviewNote: 'linear reject' }, ctx.reviewerPayload, AUDIT_META);
    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    let primaryFailure: unknown;
    let cleanupFailure: unknown;
    try {
      await withTimeout(rootReached.promise, 'attendance root blocker', BLOCKER_TIMEOUT_MS);
      first = invoke(ctx.service, firstAction);
      const firstWaiter = await waitForDirectPgWaiter(
        ctx.prismaB,
        root.pid,
        first,
        '%FROM "AttendanceSheet"%FOR NO KEY UPDATE%',
      );
      expect(firstWaiter.databaseName).toBe(root.databaseName);
      expect(firstWaiter.blockingPids).toContain(root.pid);
      mutateRoot.resolve();
      await withTimeout(rootMutated.promise, 'attendance root mutation', OPERATION_TIMEOUT_MS);

      second = invoke(ctx.serviceB, secondAction);
      const secondWaiter = await waitForDirectPgWaiter(
        ctx.prisma,
        firstWaiter.pid,
        second,
        '%FROM "AttendanceSheet"%FOR NO KEY UPDATE%',
        [root.pid, firstWaiter.pid],
      );
      expect(secondWaiter.databaseName).toBe(root.databaseName);
      expect(secondWaiter.pid).not.toBe(firstWaiter.pid);
      expect(secondWaiter.blockingPids).toContain(firstWaiter.pid);

      releaseRoot.resolve();
      const results = await withTimeout(
        Promise.allSettled([first, second]),
        'attendance competing reviews',
        OPERATION_TIMEOUT_MS,
      );
      expect(results[0].status).toBe('fulfilled');
      expect(results[1]).toMatchObject({
        status: 'rejected',
        reason: { biz: BizCode.ATTENDANCE_SHEET_STATUS_INVALID },
      });
      expect(JSON.stringify(results[1])).not.toContain('40P01');
      const expectedStatus = firstAction === 'approve' ? 'pending_final_review' : 'rejected';
      expect(
        await ctx.prisma.attendanceSheet.findUniqueOrThrow({
          where: { id: sheetId },
          select: { statusCode: true },
        }),
      ).toEqual({ statusCode: expectedStatus });
      const record = await ctx.prisma.attendanceRecord.findFirstOrThrow({
        where: { sheetId },
        select: { deletedAt: true },
      });
      if (firstAction === 'approve') expect(record.deletedAt).toBeNull();
      else expect(record.deletedAt).toEqual(expect.any(Date));
      expect(
        await ctx.prisma.auditLog.count({
          where: { resourceId: sheetId, event: 'attendance-sheet.review' },
        }),
      ).toBe(1);
      const reviewAudit = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { resourceId: sheetId, event: 'attendance-sheet.review' },
        select: { context: true },
      });
      expect(reviewAudit.context).toMatchObject({ before: { sheet: { version: 7 } } });
      expect(await ctx.prisma.notification.count()).toBe(notificationCountBefore);
      expect(await ctx.prisma.notificationOutboxIntent.count()).toBe(outboxCountBefore);
    } catch (error) {
      primaryFailure = error;
    } finally {
      mutateRoot.resolve();
      releaseRoot.resolve();
      try {
        await settleAllWithTimeout(
          [
            blocker,
            ...(first ? [first.catch(() => undefined)] : []),
            ...(second ? [second.catch(() => undefined)] : []),
          ],
          'attendance linearization cleanup',
        );
      } catch (cleanupError) {
        cleanupFailure = cleanupError;
      }
    }
    if (primaryFailure !== undefined) {
      if (cleanupFailure !== undefined) preservePrimaryFailure(primaryFailure, cleanupFailure);
      throwFailure(primaryFailure);
    }
    if (cleanupFailure !== undefined) throwFailure(cleanupFailure);
  }

  describe('PostgreSQL primary review direct/soft blocker chain', () => {
    beforeEach(isolateFixtures);

    it('approve-first:root → approve waiter → reject soft waiter', async () => {
      await runPrimaryReviewLinearization('approve', 'reject');
    });

    it('reject-first:root → reject waiter → approve soft waiter', async () => {
      await runPrimaryReviewLinearization('reject', 'approve');
    });
  });

  // ============ A. approve: pending → pending_final_review ============
  describe('A. approve(pending → pending_final_review)', () => {
    beforeEach(isolateFixtures);

    it('成功路径:返 pending_final_review + DB 落库 + reviewer 三字段 + audit review.approve', async () => {
      const sheetId = await seedSheet({
        statusCode: 'pending',
        recordsContributionPoints: [1, 2],
      });

      const result = await ctx.service.approve(
        sheetId,
        { reviewNote: 'all good' },
        ctx.reviewerPayload,
        AUDIT_META,
      );

      expect(result.statusCode).toBe('pending_final_review');

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
        },
      });
      expect(db.statusCode).toBe('pending_final_review');
      expect(db.reviewerUserId).toBe(ctx.reviewerUserId);
      expect(db.reviewedAt).not.toBeNull();
      expect(db.reviewNote).toBe('all good');
      // finalReviewer 三字段尚未填(由 finalApprove/finalReject 写)
      expect(db.finalReviewerUserId).toBeNull();
      expect(db.finalReviewedAt).toBeNull();

      // audit:event = attendance-sheet.review,extra.action = approve
      const audits = await ctx.prisma.auditLog.findMany({
        where: { resourceId: sheetId },
        orderBy: { createdAt: 'desc' },
        take: 1,
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].event).toBe('attendance-sheet.review');
      const ctx0 = audits[0].context as { extra?: { action?: string; nextStatusCode?: string } };
      expect(ctx0.extra?.action).toBe('approve');
      expect(ctx0.extra?.nextStatusCode).toBe('pending_final_review');
    });
  });

  // ============ B. approve: R31 contributionPoints 非 null 校验 ============
  describe('B. approve(R31:records.contributionPoints 全部非 null)', () => {
    beforeEach(isolateFixtures);

    it('records 中存在 contributionPoints=null → 抛 22072,Sheet 状态不变 + 无 review audit', async () => {
      const sheetId = await seedSheet({
        statusCode: 'pending',
        recordsContributionPoints: [1, null], // 第二条 null
      });

      await expect(
        ctx.service.approve(sheetId, { reviewNote: 'x' }, ctx.reviewerPayload, AUDIT_META),
      ).rejects.toMatchObject({
        biz: BizCode.ATTENDANCE_RECORD_CONTRIBUTION_POINTS_REQUIRED,
      });

      // DB 状态不变
      const db = await ctx.prisma.attendanceSheet.findUniqueOrThrow({
        where: { id: sheetId },
        select: { statusCode: true, reviewerUserId: true, reviewedAt: true },
      });
      expect(db.statusCode).toBe('pending');
      expect(db.reviewerUserId).toBeNull();
      expect(db.reviewedAt).toBeNull();

      // 无 review audit(事务整体回滚)
      const audits = await ctx.prisma.auditLog.findMany({
        where: { resourceId: sheetId, event: 'attendance-sheet.review' },
      });
      expect(audits).toHaveLength(0);
    });
  });

  describe('finding #6:edit/softDelete 前置 claim', () => {
    beforeEach(isolateFixtures);

    it('同一 pending softDelete 并发且两边均已读旧态 → 恰一方成功,败者 STATUS_INVALID 且仅赢家软删 records', async () => {
      const sheetId = await seedSheet({ statusCode: 'pending', recordsContributionPoints: [1] });
      const serviceInternals = ctx.service as unknown as {
        findSheetOrThrow: (
          targetId: string,
          tx: Prisma.TransactionClient,
        ) => Promise<{ id: string; statusCode: string }>;
      };
      const originalFind = serviceInternals.findSheetOrThrow.bind(ctx.service);
      let readCount = 0;
      let releaseBothReads: () => void = () => undefined;
      const bothReads = new Promise<void>((resolve) => {
        releaseBothReads = resolve;
      });
      const findSpy = jest
        .spyOn(serviceInternals, 'findSheetOrThrow')
        .mockImplementation(async (targetId, tx) => {
          const row = await originalFind(targetId, tx);
          readCount += 1;
          if (readCount === 2) releaseBothReads();
          await bothReads;
          return row;
        });

      const results = await Promise.allSettled([
        ctx.service.softDelete(sheetId, ctx.reviewerPayload, AUDIT_META),
        ctx.service.softDelete(sheetId, ctx.reviewerPayload, AUDIT_META),
      ]);
      findSpy.mockRestore();

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const loser = results.find((result) => result.status === 'rejected');
      expect(loser).toMatchObject({
        status: 'rejected',
        reason: { biz: BizCode.ATTENDANCE_SHEET_STATUS_INVALID },
      });
      expect(JSON.stringify(loser)).not.toContain('40P01');
      expect(
        await ctx.prisma.attendanceSheet.findUniqueOrThrow({
          where: { id: sheetId },
          select: { deletedAt: true },
        }),
      ).toEqual({ deletedAt: expect.any(Date) });
      const records = await ctx.prisma.attendanceRecord.findMany({
        where: { sheetId },
        select: { deletedAt: true },
      });
      expect(records).toHaveLength(1);
      expect(records[0].deletedAt).toEqual(expect.any(Date));
      expect(await ctx.prisma.auditLog.count({ where: { resourceId: sheetId } })).toBe(1);
    });
  });

  // ============ C. approve 错误状态护栏 ============
  describe('C. approve 错误状态护栏(非 pending 一律拒)', () => {
    beforeEach(isolateFixtures);

    it.each<SheetStatus>(['pending_final_review', 'approved', 'rejected', 'final_rejected'])(
      'from %s → 抛 ATTENDANCE_SHEET_STATUS_INVALID,DB 状态不变',
      async (fromStatus) => {
        const sheetId = await seedSheet({ statusCode: fromStatus });

        await expect(
          ctx.service.approve(sheetId, { reviewNote: 'x' }, ctx.reviewerPayload, AUDIT_META),
        ).rejects.toMatchObject({
          biz: BizCode.ATTENDANCE_SHEET_STATUS_INVALID,
        });

        const db = await ctx.prisma.attendanceSheet.findUniqueOrThrow({
          where: { id: sheetId },
          select: { statusCode: true },
        });
        expect(db.statusCode).toBe(fromStatus);
      },
    );
  });

  // ============ D. finalApprove: pending_final_review → approved ============
  describe('D. finalApprove(pending_final_review → approved)', () => {
    beforeEach(isolateFixtures);

    it('成功路径:返 approved + DB finalReviewer 三字段 + records 未软删 + audit final-review.final-approve + eventTriggered=true', async () => {
      const sheetId = await seedSheet({
        statusCode: 'pending_final_review',
        recordsContributionPoints: [1, 2],
      });

      const result = await ctx.service.finalApprove(
        sheetId,
        { finalReviewNote: 'final ok' },
        ctx.finalReviewerPayload,
        AUDIT_META,
      );

      expect(result.statusCode).toBe('approved');

      // DB 落库
      const db = await ctx.prisma.attendanceSheet.findUniqueOrThrow({
        where: { id: sheetId },
        select: {
          statusCode: true,
          finalReviewerUserId: true,
          finalReviewedAt: true,
          finalReviewNote: true,
        },
      });
      expect(db.statusCode).toBe('approved');
      expect(db.finalReviewerUserId).toBe(ctx.finalReviewerUserId);
      expect(db.finalReviewedAt).not.toBeNull();
      expect(db.finalReviewNote).toBe('final ok');

      // records 未软删(finalApprove 不动 records;沿评审稿 §1)
      const recs = await ctx.prisma.attendanceRecord.findMany({
        where: { sheetId },
        select: { deletedAt: true },
      });
      expect(recs.every((r) => r.deletedAt === null)).toBe(true);

      // audit:event = attendance-sheet.final-review,extra.action = final-approve,extra.eventTriggered = true
      // (eventTriggered 字段由 service.finalApprove 写入,作为 attendance.recorded event placeholder
      //  触发的间接断言;沿 attendances.service.ts:1287)
      const audits = await ctx.prisma.auditLog.findMany({
        where: { resourceId: sheetId, event: 'attendance-sheet.final-review' },
        orderBy: { createdAt: 'desc' },
        take: 1,
      });
      expect(audits).toHaveLength(1);
      const audit0 = audits[0].context as {
        extra?: { action?: string; nextStatusCode?: string; eventTriggered?: boolean };
      };
      expect(audit0.extra?.action).toBe('final-approve');
      expect(audit0.extra?.nextStatusCode).toBe('approved');
      expect(audit0.extra?.eventTriggered).toBe(true);
    });
  });

  describe('findings #5/#6:终审并发守卫', () => {
    beforeEach(isolateFixtures);

    it('同一 pending_final_review finalApprove || finalReject 仅一方成功,明细不被败者误删', async () => {
      const sheetId = await seedSheet({
        statusCode: 'pending_final_review',
        recordsContributionPoints: [2],
      });
      const results = await Promise.allSettled([
        ctx.service.finalApprove(
          sheetId,
          { finalReviewNote: 'race approve' },
          ctx.finalReviewerPayload,
          AUDIT_META,
        ),
        ctx.service.finalReject(
          sheetId,
          { finalReviewNote: 'race reject' },
          ctx.finalReviewerPayload,
          AUDIT_META,
        ),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const loser = results.find((r) => r.status === 'rejected');
      expect(loser).toMatchObject({
        status: 'rejected',
        reason: { biz: BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID },
      });
      expect(JSON.stringify(loser)).not.toContain('40P01');
      const sheet = await ctx.prisma.attendanceSheet.findUniqueOrThrow({
        where: { id: sheetId },
        select: { statusCode: true },
      });
      const record = await ctx.prisma.attendanceRecord.findFirstOrThrow({
        where: { sheetId },
        select: { deletedAt: true },
      });
      if (sheet.statusCode === 'approved') expect(record.deletedAt).toBeNull();
      else {
        expect(sheet.statusCode).toBe('final_rejected');
        expect(record.deletedAt).not.toBeNull();
      }
      expect(await ctx.prisma.auditLog.count({ where: { resourceId: sheetId } })).toBe(1);
    });
  });

  // ============ E. finalApprove 错误状态护栏 ============
  describe('E. finalApprove 错误状态护栏(非 pending_final_review 一律拒)', () => {
    beforeEach(isolateFixtures);

    it.each<SheetStatus>(['pending', 'approved', 'rejected', 'final_rejected'])(
      'from %s → 抛 ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID,DB 状态不变',
      async (fromStatus) => {
        const sheetId = await seedSheet({ statusCode: fromStatus });

        await expect(
          ctx.service.finalApprove(
            sheetId,
            { finalReviewNote: 'x' },
            ctx.finalReviewerPayload,
            AUDIT_META,
          ),
        ).rejects.toMatchObject({
          biz: BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID,
        });

        const db = await ctx.prisma.attendanceSheet.findUniqueOrThrow({
          where: { id: sheetId },
          select: { statusCode: true, finalReviewerUserId: true },
        });
        expect(db.statusCode).toBe(fromStatus);
        // 错误状态护栏路径不写 finalReviewer
        expect(db.finalReviewerUserId).toBeNull();
      },
    );
  });

  // ============ F. finalReject: pending_final_review → final_rejected + records 软删 ============
  describe('F. finalReject(pending_final_review → final_rejected;records 同事务软删)', () => {
    beforeEach(isolateFixtures);

    it('成功路径:返 final_rejected + DB finalReviewer 三字段 + 所有 records.deletedAt 非 null + audit final-review.final-reject', async () => {
      const sheetId = await seedSheet({
        statusCode: 'pending_final_review',
        recordsContributionPoints: [1, 2, 3], // 3 条 record
      });

      const result = await ctx.service.finalReject(
        sheetId,
        { finalReviewNote: 'rejected for state-transition test' },
        ctx.finalReviewerPayload,
        AUDIT_META,
      );

      expect(result.statusCode).toBe('final_rejected');

      // DB 落库
      const db = await ctx.prisma.attendanceSheet.findUniqueOrThrow({
        where: { id: sheetId },
        select: {
          statusCode: true,
          finalReviewerUserId: true,
          finalReviewedAt: true,
          finalReviewNote: true,
        },
      });
      expect(db.statusCode).toBe('final_rejected');
      expect(db.finalReviewerUserId).toBe(ctx.finalReviewerUserId);
      expect(db.finalReviewedAt).not.toBeNull();
      expect(db.finalReviewNote).toBe('rejected for state-transition test');

      // **关键不变式**:所有 records.deletedAt 非 null(同事务软删,沿 D8 主路径)
      const recs = await ctx.prisma.attendanceRecord.findMany({
        where: { sheetId },
        select: { id: true, deletedAt: true },
      });
      expect(recs).toHaveLength(3);
      expect(recs.every((r) => r.deletedAt !== null)).toBe(true);

      // audit:event = attendance-sheet.final-review,extra.action = final-reject,recordsCount = 3
      const audits = await ctx.prisma.auditLog.findMany({
        where: { resourceId: sheetId, event: 'attendance-sheet.final-review' },
        orderBy: { createdAt: 'desc' },
        take: 1,
      });
      expect(audits).toHaveLength(1);
      const audit0 = audits[0].context as {
        extra?: { action?: string; nextStatusCode?: string; recordsCount?: number };
      };
      expect(audit0.extra?.action).toBe('final-reject');
      expect(audit0.extra?.nextStatusCode).toBe('final_rejected');
      expect(audit0.extra?.recordsCount).toBe(3);
    });
  });

  // ============ G. finalReject note 必填 ============
  describe('G. finalReject(finalReviewNote 必填)', () => {
    beforeEach(isolateFixtures);

    it('空 note → 抛 ATTENDANCE_SHEET_FINAL_REVIEW_NOTE_REQUIRED,DB 状态不变 + records 不软删', async () => {
      const sheetId = await seedSheet({
        statusCode: 'pending_final_review',
        recordsContributionPoints: [1],
      });

      // 注:DTO 层 @MinLength(1) 在 controller 路径校验;service 层用 trim().length === 0 兜底。
      // 本 spec 直接调 service,所以传入空字符串(空白)走 service 内部冗余校验。
      await expect(
        ctx.service.finalReject(
          sheetId,
          { finalReviewNote: '   ' },
          ctx.finalReviewerPayload,
          AUDIT_META,
        ),
      ).rejects.toMatchObject({
        biz: BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_NOTE_REQUIRED,
      });

      // DB 状态不变
      const db = await ctx.prisma.attendanceSheet.findUniqueOrThrow({
        where: { id: sheetId },
        select: { statusCode: true, finalReviewerUserId: true, finalReviewNote: true },
      });
      expect(db.statusCode).toBe('pending_final_review');
      expect(db.finalReviewerUserId).toBeNull();
      expect(db.finalReviewNote).toBeNull();

      // records 不软删(事务整体回滚)
      const recs = await ctx.prisma.attendanceRecord.findMany({
        where: { sheetId },
        select: { deletedAt: true },
      });
      expect(recs.every((r) => r.deletedAt === null)).toBe(true);
    });
  });

  // ============ H. finalReject 错误状态护栏 ============
  describe('H. finalReject 错误状态护栏(非 pending_final_review 一律拒)', () => {
    beforeEach(isolateFixtures);

    it.each<SheetStatus>(['pending', 'approved', 'rejected', 'final_rejected'])(
      'from %s → 抛 ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID,DB 状态不变 + records 不软删',
      async (fromStatus) => {
        const sheetId = await seedSheet({
          statusCode: fromStatus,
          recordsContributionPoints: [1],
        });

        await expect(
          ctx.service.finalReject(
            sheetId,
            { finalReviewNote: 'rejected note' },
            ctx.finalReviewerPayload,
            AUDIT_META,
          ),
        ).rejects.toMatchObject({
          biz: BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID,
        });

        const db = await ctx.prisma.attendanceSheet.findUniqueOrThrow({
          where: { id: sheetId },
          select: { statusCode: true, finalReviewerUserId: true },
        });
        expect(db.statusCode).toBe(fromStatus);
        expect(db.finalReviewerUserId).toBeNull();

        // records 不软删(护栏路径整体回滚)
        const recs = await ctx.prisma.attendanceRecord.findMany({
          where: { sheetId },
          select: { deletedAt: true },
        });
        expect(recs.every((r) => r.deletedAt === null)).toBe(true);
      },
    );
  });
});
