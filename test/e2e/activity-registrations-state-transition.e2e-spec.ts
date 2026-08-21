import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Prisma, Role, UserStatus } from '@prisma/client';
import request, { type Response } from 'supertest';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityRegistrationsService } from '../../src/modules/activity-registrations/activity-registrations.service';
import { AuditLogsService } from '../../src/modules/audit-logs/audit-logs.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { TEST_PASSWORD_HASH } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { assertConnectedTestDatabase } from '../setup/test-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

// activity-registrations state transitions characterization tests
// (god-service 拆分前置锁;沿 attendances state-transition / audit-characterization 范式)。
//
// 目标:在抽 `ActivityRegistrationStateMachine` / `ActivityRegistrationAuditRecorder` 之前,
// 显式锁定 `activity-registrations.service.ts` 当前状态机 + 唯一性 + 容量 + 事务回滚的全部 invariant。
// 本 spec 只锁既有 service 行为；第 81 migration 的永久报名头结构切换不改本文件外的 runtime。
//
// 测试策略选择(沿 attendances-state-transition spec 范式):
//   - 选 service-level e2e(`test/e2e/*.e2e-spec.ts`)而非 unit spec:
//     * 项目 unit jest 配置无 DB,无法实测 `$transaction` / DB unique / audit 写入;
//     * `createTestApp()` + `app.get(ActivityRegistrationsService)` 直接调用 service 方法,
//       **绕过 HTTP / JwtAuthGuard / RolesGuard**,纯锁 service 层行为。
//   - 直接 Prisma seed 非 pending 起始状态(approved / cancelled / rejected),
//     避免为造状态绕完整业务流程(approve / cancel / reject 多步)。
//     永久报名头 unique 下每个 fixture 均使用独立 `(activityId, memberId)`,不造历史双头。
//   - audit failure rollback case 用 jest.spyOn(auditLogs, 'log').mockRejectedValueOnce 触发
//     auditLogs.log 抛错,断言 service throw + DB 无落库 + audit 不存在
//     (沿 attendances-audit-characterization spec D1 范式)。
//
// 覆盖矩阵:
//   A. approve(pending → pass + 4 个 wrong source state，含 waitlisted 不可直通)
//   B. reject(pending|waitlisted → reject + 3 个 wrong source state)
//   C. cancelAdmin(pending|pass|waitlisted → cancelled + 2 个 wrong source state)
//   D. cancelMy(pending|pass|waitlisted → cancelled + 2 个 wrong source state + ownership)
//   E. Uniqueness & capacity(active dup + cancelled same-head reapply + capacity full ×2)
//   F. Audit failure rollback(create 路径)

type RegistrationStatus = 'pending' | 'pass' | 'reject' | 'cancelled' | 'waitlisted';

const AUDIT_META: AuditMeta = {
  requestId: 'reg-state-req-0000000000000001',
  ip: '127.0.0.1',
  ua: 'jest/30 activity-registrations-state-transition',
};

const REGISTRATION_RESOURCE_TYPE = 'activity_registration';

interface SeedContext {
  prisma: PrismaService;
  prismaB: PrismaService;
  service: ActivityRegistrationsService;
  auditLogs: AuditLogsService;
  adminAuth: string;
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

interface BackendIdentity {
  pid: number;
  databaseName: string;
}

interface BlockedBackend extends BackendIdentity {
  blockingPids: number[];
  waitEventType: string | null;
  querySnippet: string;
}

interface PgActivitySnapshot extends BackendIdentity {
  state: string | null;
  waitEventType: string | null;
  waitEvent: string | null;
  blockingPids: number[];
  xactAgeMs: number | null;
  queryAgeMs: number | null;
  querySnippet: string;
}

const LOCK_OBSERVE_TIMEOUT_MS = 4_000;
const HTTP_TIMEOUT_MS = 8_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const BLOCKER_TIMEOUT_MS = 20_000;
const CASE_TIMEOUT_MS = 30_000;
const REVIEW_RACE_STRESS_ITERATIONS = Number.parseInt(
  process.env.REGISTRATION_REVIEW_RACE_ITERATIONS ?? '0',
  10,
);

interface ReviewRaceDiagnosticRecord {
  iteration: number;
  order: string;
  rootPid: number;
  firstWaiterPid: number;
  secondWaiterPid: number;
  firstBlockingPids: number[];
  secondBlockingPids: number[];
  firstQuerySnippet: string;
  secondQuerySnippet: string;
  firstResponse: { action: 'approve' | 'reject'; httpStatus: number; bizCode: number | null };
  secondResponse: { action: 'approve' | 'reject'; httpStatus: number; bizCode: number | null };
  winnerAction: 'approve' | 'reject' | null;
  finalStatus: string;
  auditCount: number;
  auditAction: string | null;
  notificationCount: number;
  notificationTitle: string | null;
  deliveryCount: number;
  outboxIntentCount: number;
  failures: string[];
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
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

async function readBackendIdentity(
  client: Pick<PrismaService, '$queryRaw'> | Prisma.TransactionClient,
): Promise<BackendIdentity> {
  const rows = await client.$queryRaw<BackendIdentity[]>(Prisma.sql`
    SELECT pg_backend_pid() AS pid, current_database() AS "databaseName"
  `);
  const identity = rows[0];
  if (!identity) throw new Error('PostgreSQL backend identity missing');
  return identity;
}

async function waitForBlockedBackend(
  observer: PrismaService,
  blocker: BackendIdentity,
  operation: Promise<unknown>,
  queryPattern: string,
  excludedPids: number[] = [],
): Promise<BlockedBackend> {
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
    if (settled) throw new Error('operation settled before the expected PostgreSQL lock wait');
    const rows = await observer.$queryRaw<BlockedBackend[]>(Prisma.sql`
      SELECT
        pid,
        datname AS "databaseName",
        pg_blocking_pids(pid) AS "blockingPids",
        wait_event_type AS "waitEventType",
        LEFT(REGEXP_REPLACE(query, '[[:space:]]+', ' ', 'g'), 240) AS "querySnippet"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> CAST(${blocker.pid} AS integer)
        AND wait_event_type = 'Lock'
        AND CAST(${blocker.pid} AS integer) = ANY(pg_blocking_pids(pid))
        AND query LIKE ${queryPattern}
        AND NOT (pid = ANY(${excludedPids}::integer[]))
      LIMIT 1
    `);
    const waiter = rows[0];
    if (waiter) {
      expect(waiter.databaseName).toBe(blocker.databaseName);
      expect(waiter.blockingPids).toContain(blocker.pid);
      expect(waiter.waitEventType).toBe('Lock');
      return waiter;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const snapshot = await observer.$queryRaw<PgActivitySnapshot[]>(Prisma.sql`
    SELECT
      pid,
      datname AS "databaseName",
      state,
      wait_event_type AS "waitEventType",
      wait_event AS "waitEvent",
      pg_blocking_pids(pid) AS "blockingPids",
      CASE
        WHEN xact_start IS NULL THEN NULL
        ELSE (EXTRACT(EPOCH FROM (clock_timestamp() - xact_start)) * 1000)::double precision
      END AS "xactAgeMs",
      CASE
        WHEN query_start IS NULL THEN NULL
        ELSE (EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) * 1000)::double precision
      END AS "queryAgeMs",
      LEFT(REGEXP_REPLACE(query, '[[:space:]]+', ' ', 'g'), 240) AS "querySnippet"
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND (
        pid = CAST(${blocker.pid} AS integer)
        OR CAST(${blocker.pid} AS integer) = ANY(pg_blocking_pids(pid))
        OR wait_event_type = 'Lock'
      )
    ORDER BY pid
  `);
  throw new Error(
    `no PostgreSQL lock waiter observed blocker=${JSON.stringify(blocker)} ` +
      `pattern=${JSON.stringify(queryPattern)} excludedPids=${JSON.stringify(excludedPids)} ` +
      `snapshot=${JSON.stringify(snapshot)}`,
  );
}

describe('ActivityRegistrationsService state transitions (characterization)', () => {
  let app: INestApplication;
  let appB: INestApplication;
  let ctx: SeedContext;

  beforeAll(async () => {
    app = await createTestApp();
    appB = await createTestApp();
    await resetDb(app);

    const prisma = app.get(PrismaService);
    const prismaB = appB.get(PrismaService);
    expect(appB).not.toBe(app);
    expect(prismaB).not.toBe(prisma);
    const service = app.get(ActivityRegistrationsService);
    const auditLogs = app.get(AuditLogsService);

    // Users:adminUser(代报名 / 审批)+ selfA / selfB(自助报名 / 自取消;memberId 绑定)
    const admin = await prisma.user.create({
      data: {
        username: 'reg-state-admin',
        passwordHash: TEST_PASSWORD_HASH,
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
    const adminAuth = (await loginAs(app, 'reg-state-admin')).authHeader;

    const memberA = await prisma.member.create({
      data: { memberNo: 'reg-state-m-a', ...memberIdentityData('State Member A') },
      select: { id: true },
    });
    const memberB = await prisma.member.create({
      data: { memberNo: 'reg-state-m-b', ...memberIdentityData('State Member B') },
      select: { id: true },
    });
    // memberC:作为 admin 代报名的目标 member(无 user 绑定)
    const memberC = await prisma.member.create({
      data: { memberNo: 'reg-state-m-c', ...memberIdentityData('State Member C') },
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
      prismaB,
      service,
      auditLogs,
      adminAuth,
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
    await settleAllWithTimeout(
      [app.close(), appB.close()],
      'activity state-transition app shutdown',
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // 每个 case 之间清:ActivityRegistration + AuditLog;保留 User / Member / Org / Activity。
  async function isolateFixtures(): Promise<void> {
    await ctx.prisma.notificationDelivery.deleteMany({});
    await ctx.prisma.notificationRead.deleteMany({});
    await ctx.prisma.notificationOutboxIntent.deleteMany({});
    await ctx.prisma.notification.deleteMany({});
    // Cancellation now appends immutable registration/participation revisions. Row-level
    // immutability deliberately rejects DELETE, so this spec-local isolation must use the same
    // guarded TRUNCATE shape as resetDb rather than weakening the production trigger.
    await assertConnectedTestDatabase(ctx.prisma);
    await ctx.prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ActivityRegistration" RESTART IDENTITY CASCADE',
    );
    await ctx.prisma.auditLog.deleteMany({});
  }

  // 直接 prisma seed 任意起始状态的 registration(绕过 service 业务流)。
  // 永久报名头约束:同一 (activityId, memberId) 跨全部历史只能一条。
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

  function reviewRegistration(
    targetApp: INestApplication,
    registrationId: string,
    action: 'approve' | 'reject',
  ): Promise<Response> {
    return Promise.resolve(
      request(httpServer(targetApp))
        .patch(
          `/api/admin/v1/activities/${ctx.publishedActivityId}/registrations/${registrationId}/${action}`,
        )
        .set('Authorization', ctx.adminAuth)
        .send(action === 'reject' ? { reviewNote: 'deterministic reject' } : {})
        .timeout({ deadline: HTTP_TIMEOUT_MS }),
    );
  }

  async function collectReviewRaceDiagnostic(
    iteration: number,
    firstAction: 'approve' | 'reject',
    secondAction: 'approve' | 'reject',
    rootBackend: BackendIdentity,
    firstWaiter: BlockedBackend,
    secondWaiter: BlockedBackend,
    firstResponse: Response,
    secondResponse: Response,
    registrationId: string,
    expectedBeforeReviewNote: string,
  ): Promise<ReviewRaceDiagnosticRecord> {
    const responses = [
      { action: firstAction, response: firstResponse },
      { action: secondAction, response: secondResponse },
    ];
    const winners = responses.filter(({ response }) => response.status === 200);
    const losers = responses.filter(({ response }) => response.status !== 200);
    const winnerAction = winners.length === 1 ? winners[0].action : null;
    const row = await ctx.prisma.activityRegistration.findUniqueOrThrow({
      where: { id: registrationId },
      select: { statusCode: true },
    });
    const audits = await ctx.prisma.auditLog.findMany({
      where: { resourceId: registrationId, event: 'registration.review' },
      select: { context: true },
    });
    const auditContext =
      audits.length === 1
        ? (audits[0].context as {
            before?: { reviewNote?: string | null };
            extra?: { action?: string };
          })
        : null;
    const auditAction = auditContext === null ? null : (auditContext.extra?.action ?? null);
    const notifications = await ctx.prisma.notification.findMany({
      where: {
        recipientMemberId: ctx.memberCId,
        notificationTypeCode: 'registration-result',
      },
      select: { title: true, statusCode: true, channels: true },
    });
    const deliveryCount = await ctx.prisma.notificationDelivery.count();
    const outboxIntents = await ctx.prisma.notificationOutboxIntent.findMany({
      where: {
        aggregateType: 'activity_registration',
        aggregateId: registrationId,
        eventType: 'notification.targeted',
      },
      select: { payload: true, status: true },
    });
    const outboxPayload =
      outboxIntents.length === 1
        ? (outboxIntents[0].payload as {
            title?: string;
            channels?: string[];
            recipientMemberId?: string;
          })
        : null;
    const failures: string[] = [];
    if (winners.length !== 1) failures.push(`winner-count=${winners.length}`);
    if (losers.length !== 1) failures.push(`loser-count=${losers.length}`);
    if (winners.length === 1 && winners[0].response.body.code !== 0) {
      failures.push(`winner-biz-code=${String(winners[0].response.body.code)}`);
    }
    if (
      losers.length === 1 &&
      (losers[0].response.status !==
        Number(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID.httpStatus) ||
        losers[0].response.body.code !== BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID.code)
    ) {
      failures.push(
        `loser-response=${losers[0].response.status}/${String(losers[0].response.body.code)}`,
      );
    }
    if (
      responses.some(
        ({ response }) => response.status >= 500 || JSON.stringify(response.body).includes('40P01'),
      )
    ) {
      failures.push('server-error-or-deadlock');
    }
    const expectedFinalStatus =
      winnerAction === 'approve' ? 'pass' : winnerAction === 'reject' ? 'reject' : null;
    if (expectedFinalStatus === null || row.statusCode !== expectedFinalStatus) {
      failures.push(`final-status=${row.statusCode}/expected=${String(expectedFinalStatus)}`);
    }
    if (audits.length !== 1) failures.push(`audit-count=${audits.length}`);
    if (auditContext?.before?.reviewNote !== expectedBeforeReviewNote) {
      failures.push(
        `audit-before-review-note=${String(
          auditContext?.before?.reviewNote,
        )}/expected=${expectedBeforeReviewNote}`,
      );
    }
    if (winnerAction !== null && auditAction !== winnerAction) {
      failures.push(`audit-action=${String(auditAction)}/winner=${winnerAction}`);
    }
    if (notifications.length !== 0) failures.push(`notification-count=${notifications.length}`);
    const expectedTitle =
      winnerAction === 'approve' ? '报名已通过' : winnerAction === 'reject' ? '报名未通过' : null;
    if (outboxIntents.length !== 1) failures.push(`outbox-intent-count=${outboxIntents.length}`);
    if (
      outboxPayload?.title !== expectedTitle ||
      outboxPayload.recipientMemberId !== ctx.memberCId ||
      JSON.stringify(outboxPayload.channels) !== JSON.stringify(['in-app'])
    ) {
      failures.push(
        `outbox-payload=${String(outboxPayload?.title)}/${String(
          outboxPayload?.recipientMemberId,
        )}/${JSON.stringify(outboxPayload?.channels)}`,
      );
    }
    if (outboxIntents.length === 1 && outboxIntents[0].status !== 'pending') {
      failures.push(`outbox-status=${outboxIntents[0].status}`);
    }
    if (deliveryCount !== 0) failures.push(`delivery-count=${deliveryCount}`);

    return {
      iteration,
      order: `${firstAction}-first`,
      rootPid: rootBackend.pid,
      firstWaiterPid: firstWaiter.pid,
      secondWaiterPid: secondWaiter.pid,
      firstBlockingPids: firstWaiter.blockingPids,
      secondBlockingPids: secondWaiter.blockingPids,
      firstQuerySnippet: firstWaiter.querySnippet,
      secondQuerySnippet: secondWaiter.querySnippet,
      firstResponse: {
        action: firstAction,
        httpStatus: firstResponse.status,
        bizCode: typeof firstResponse.body.code === 'number' ? firstResponse.body.code : null,
      },
      secondResponse: {
        action: secondAction,
        httpStatus: secondResponse.status,
        bizCode: typeof secondResponse.body.code === 'number' ? secondResponse.body.code : null,
      },
      winnerAction,
      finalStatus: row.statusCode,
      auditCount: audits.length,
      auditAction,
      notificationCount: notifications.length,
      notificationTitle: notifications.length === 1 ? notifications[0].title : null,
      deliveryCount,
      outboxIntentCount: outboxIntents.length,
      failures,
    };
  }

  async function runWinnerAgnosticReviewRace(
    firstAction: 'approve' | 'reject',
    secondAction: 'approve' | 'reject',
    diagnostic?: { iteration: number; records: ReviewRaceDiagnosticRecord[] },
  ): Promise<void> {
    const registrationId = await seedRegistration({
      memberId: ctx.memberCId,
      statusCode: 'pending',
    });
    const prismaA = app.get(PrismaService);
    const prismaB = appB.get(PrismaService);
    expect(prismaA).toBe(ctx.prisma);
    expect(prismaB).toBe(ctx.prismaB);
    expect(prismaB).not.toBe(prismaA);
    const [poolA, poolB] = await Promise.all([
      readBackendIdentity(prismaA),
      readBackendIdentity(prismaB),
    ]);
    expect(poolA.databaseName).toBe(poolB.databaseName);
    expect(poolA.pid).not.toBe(poolB.pid);

    const blockerReached = deferred<BackendIdentity>();
    const mutateBlocker = deferred();
    const blockerMutated = deferred();
    const releaseBlocker = deferred();
    const rootReviewNote = `root committed ${firstAction}`;
    const blocker = prismaA.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<BackendIdentity[]>(Prisma.sql`
          SELECT
            pg_backend_pid() AS pid,
            current_database() AS "databaseName"
          FROM "ActivityRegistration"
          WHERE "id" = ${registrationId}
          FOR UPDATE
        `);
        const identity = rows[0];
        if (!identity) throw new Error('registration blocker row missing');
        blockerReached.resolve(identity);
        await mutateBlocker.promise;
        await tx.activityRegistration.update({
          where: { id: registrationId },
          data: { reviewNote: rootReviewNote },
        });
        blockerMutated.resolve(undefined);
        await releaseBlocker.promise;
      },
      { timeout: BLOCKER_TIMEOUT_MS },
    );
    let first: Promise<Response> | undefined;
    let second: Promise<Response> | undefined;
    let primaryFailure: unknown;
    let cleanupFailure: unknown;
    try {
      const rootBackend = await withTimeout(
        blockerReached.promise,
        `${firstAction}-first registration blocker`,
        BLOCKER_TIMEOUT_MS,
      );
      expect(rootBackend.databaseName).toBe(poolA.databaseName);

      first = reviewRegistration(app, registrationId, firstAction);
      const firstWaiter = await waitForBlockedBackend(
        prismaB,
        rootBackend,
        first,
        '%FROM "ActivityRegistration"%FOR NO KEY UPDATE%',
      );
      expect(firstWaiter.pid).not.toBe(rootBackend.pid);
      mutateBlocker.resolve(undefined);
      await withTimeout(
        blockerMutated.promise,
        `${firstAction}-first registration root mutation`,
        HTTP_TIMEOUT_MS,
      );

      second = reviewRegistration(appB, registrationId, secondAction);
      const secondWaiter = await waitForBlockedBackend(
        prismaA,
        firstWaiter,
        second,
        '%FROM "Activity"%FOR UPDATE%',
      );
      expect(secondWaiter.pid).not.toBe(rootBackend.pid);
      expect(secondWaiter.pid).not.toBe(firstWaiter.pid);
      expect(secondWaiter.databaseName).toBe(rootBackend.databaseName);

      releaseBlocker.resolve(undefined);
      const [firstResponse, secondResponse] = await Promise.all([
        withTimeout(first, `${firstAction}-first response`, HTTP_TIMEOUT_MS),
        withTimeout(second, `${secondAction}-second response`, HTTP_TIMEOUT_MS),
      ]);
      const record = await collectReviewRaceDiagnostic(
        diagnostic?.iteration ?? 1,
        firstAction,
        secondAction,
        rootBackend,
        firstWaiter,
        secondWaiter,
        firstResponse,
        secondResponse,
        registrationId,
        rootReviewNote,
      );
      if (diagnostic) {
        diagnostic.records.push(record);
        console.info(JSON.stringify({ event: 'registration-review-race.iteration', ...record }));
      } else {
        expect(record.failures).toEqual([]);
      }
    } catch (error) {
      primaryFailure = error;
    } finally {
      mutateBlocker.resolve(undefined);
      releaseBlocker.resolve(undefined);
      try {
        await settleAllWithTimeout(
          [blocker, ...(first ? [first] : []), ...(second ? [second] : [])],
          `${firstAction}-first cleanup`,
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

  async function runReviewRaceStress(
    firstAction: 'approve' | 'reject',
    secondAction: 'approve' | 'reject',
  ): Promise<void> {
    const records: ReviewRaceDiagnosticRecord[] = [];
    for (let iteration = 1; iteration <= REVIEW_RACE_STRESS_ITERATIONS; iteration += 1) {
      if (iteration > 1) await isolateFixtures();
      await runWinnerAgnosticReviewRace(firstAction, secondAction, {
        iteration,
        records,
      });
    }
    const firstWinnerCount = records.filter((record) => record.winnerAction === firstAction).length;
    const secondWinnerCount = records.filter(
      (record) => record.winnerAction === secondAction,
    ).length;
    const failures = records.flatMap((record) =>
      record.failures.map((failure) => ({ iteration: record.iteration, failure })),
    );
    console.info(
      JSON.stringify({
        event: 'registration-review-race.summary',
        order: `${firstAction}-first`,
        iterations: records.length,
        firstWinnerCount,
        secondWinnerCount,
        invariantFailureCount: failures.length,
        failures,
      }),
    );
    expect(records).toHaveLength(REVIEW_RACE_STRESS_ITERATIONS);
    expect(failures).toEqual([]);
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

    it.each<RegistrationStatus>(['pass', 'reject', 'cancelled', 'waitlisted'])(
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

    it('A3. Member INACTIVE → approve 拒 MEMBER_INACTIVE，状态/审核字段/容量/audit/通知均不变', async () => {
      const activityId = await createActivity({ capacity: 1 });
      const member = await ctx.prisma.member.create({
        data: {
          memberNo: `reg-state-inactive-${Date.now()}`,
          ...memberIdentityData('Inactive Approve Target'),
          status: MemberStatus.INACTIVE,
        },
        select: { id: true },
      });
      const regId = await seedRegistration({
        activityId,
        memberId: member.id,
        statusCode: 'pending',
      });

      await expect(
        ctx.service.approve(
          activityId,
          regId,
          { reviewNote: '不得落库' },
          ctx.adminPayload,
          AUDIT_META,
        ),
      ).rejects.toMatchObject({ biz: BizCode.MEMBER_INACTIVE });

      expect(
        await ctx.prisma.activityRegistration.findUniqueOrThrow({
          where: { id: regId },
          select: {
            statusCode: true,
            reviewedBy: true,
            reviewedAt: true,
            reviewNote: true,
          },
        }),
      ).toEqual({
        statusCode: 'pending',
        reviewedBy: null,
        reviewedAt: null,
        reviewNote: null,
      });
      expect(
        await ctx.prisma.activityRegistration.count({
          where: { activityId, statusCode: 'pass', deletedAt: null },
        }),
      ).toBe(0);
      expect(
        await ctx.prisma.auditLog.count({
          where: { resourceId: regId, event: 'registration.review' },
        }),
      ).toBe(0);
      expect(
        await ctx.prisma.notification.count({
          where: { recipientMemberId: member.id, notificationTypeCode: 'registration-result' },
        }),
      ).toBe(0);
      expect(await ctx.prisma.notificationDelivery.count()).toBe(0);
      expect(await ctx.prisma.notificationOutboxIntent.count()).toBe(0);
    });

    it('A3-Q. approves against current qualification facts, so a grade changed after registration blocks without pass/audit/outbox writes', async () => {
      const activityId = await createActivity({});
      const member = await ctx.prisma.member.create({
        data: {
          memberNo: `reg-state-qualification-grade-${Date.now()}`,
          ...memberIdentityData('Qualification review target'),
          gradeCode: 'L1',
          status: MemberStatus.ACTIVE,
        },
        select: { id: true },
      });
      const ruleSet = await ctx.prisma.activityQualificationRuleSet.create({
        data: {
          activityId,
          version: 1,
          statusCode: 'draft',
          rules: {
            create: {
              ruleTypeCode: 'grade',
              enforcementCode: 'block',
              operator: 'in',
              valueJson: { codes: ['L1'] },
              sortOrder: 1,
            },
          },
        },
        select: { id: true },
      });
      await ctx.prisma.activityQualificationRuleSet.update({
        where: { id: ruleSet.id },
        data: { statusCode: 'active' },
      });
      const regId = await seedRegistration({
        activityId,
        memberId: member.id,
        statusCode: 'pending',
      });
      await ctx.prisma.member.update({
        where: { id: member.id },
        data: { gradeCode: 'L0' },
      });
      const before = await Promise.all([
        ctx.prisma.activityRegistration.findUniqueOrThrow({
          where: { id: regId },
          select: { statusCode: true, reviewedAt: true },
        }),
        ctx.prisma.auditLog.count({ where: { resourceId: regId } }),
        ctx.prisma.notificationOutboxIntent.count({ where: { aggregateId: regId } }),
        ctx.prisma.qualificationEvaluationSnapshot.count({
          where: { ruleSetVersionId: ruleSet.id },
        }),
      ]);

      await expect(
        ctx.service.approve(
          activityId,
          regId,
          { reviewNote: '资格变化后不得通过' },
          ctx.adminPayload,
          AUDIT_META,
        ),
      ).rejects.toMatchObject({ biz: { code: 21040 } });

      await expect(
        Promise.all([
          ctx.prisma.activityRegistration.findUniqueOrThrow({
            where: { id: regId },
            select: { statusCode: true, reviewedAt: true },
          }),
          ctx.prisma.auditLog.count({ where: { resourceId: regId } }),
          ctx.prisma.notificationOutboxIntent.count({ where: { aggregateId: regId } }),
          ctx.prisma.qualificationEvaluationSnapshot.count({
            where: { ruleSetVersionId: ruleSet.id },
          }),
        ]),
      ).resolves.toEqual(before);
    });

    it('A4. Member 已软删 → approve 拒 MEMBER_NOT_FOUND，报名保持 pending 且零副作用', async () => {
      const member = await ctx.prisma.member.create({
        data: {
          memberNo: `reg-state-deleted-${Date.now()}`,
          ...memberIdentityData('Deleted Approve Target'),
        },
        select: { id: true },
      });
      const regId = await seedRegistration({
        memberId: member.id,
        statusCode: 'pending',
      });
      await ctx.prisma.member.update({
        where: { id: member.id },
        data: { deletedAt: new Date() },
      });

      await expect(
        ctx.service.approve(
          ctx.publishedActivityId,
          regId,
          { reviewNote: '不得落库' },
          ctx.adminPayload,
          AUDIT_META,
        ),
      ).rejects.toMatchObject({ biz: BizCode.MEMBER_NOT_FOUND });
      expect(
        await ctx.prisma.activityRegistration.findUniqueOrThrow({
          where: { id: regId },
          select: {
            statusCode: true,
            reviewedBy: true,
            reviewedAt: true,
            reviewNote: true,
          },
        }),
      ).toEqual({
        statusCode: 'pending',
        reviewedBy: null,
        reviewedAt: null,
        reviewNote: null,
      });
      expect(
        await ctx.prisma.auditLog.count({
          where: { resourceId: regId, event: 'registration.review' },
        }),
      ).toBe(0);
      expect(
        await ctx.prisma.notification.count({
          where: { recipientMemberId: member.id, notificationTypeCode: 'registration-result' },
        }),
      ).toBe(0);
    });

    /*
     * PR-K report-only baseline (2026-07-26, 100 iterations per order):
     * approve-first winners=92/100 (reject won 8); reject-first winners=96/100
     * (approve won 4); invariant failures=0/200. The first observed inversion was
     * approve-first iteration 6: root=24696, first=24694 blocked by root, second=24695
     * blocked by first; reject nevertheless won with 200 while approve returned 409/21030.
     * PostgreSQL waiter order is therefore diagnostic evidence, not the winner contract.
     */
    it(
      'finding #3 winner-agnostic approve/reject:保留 approve-first 锁等待链并冻结唯一成功',
      async () => {
        if (REVIEW_RACE_STRESS_ITERATIONS > 0) {
          await runReviewRaceStress('approve', 'reject');
        } else {
          await runWinnerAgnosticReviewRace('approve', 'reject');
        }
      },
      REVIEW_RACE_STRESS_ITERATIONS > 0
        ? CASE_TIMEOUT_MS * REVIEW_RACE_STRESS_ITERATIONS
        : CASE_TIMEOUT_MS,
    );

    it(
      'finding #3 winner-agnostic reject/approve:保留 reject-first 锁等待链并冻结唯一成功',
      async () => {
        if (REVIEW_RACE_STRESS_ITERATIONS > 0) {
          await runReviewRaceStress('reject', 'approve');
        } else {
          await runWinnerAgnosticReviewRace('reject', 'approve');
        }
      },
      REVIEW_RACE_STRESS_ITERATIONS > 0
        ? CASE_TIMEOUT_MS * REVIEW_RACE_STRESS_ITERATIONS
        : CASE_TIMEOUT_MS,
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

    it('B1b. waitlisted → reject:管理员可清理候补 + audit priorStatusCode=waitlisted', async () => {
      const regId = await seedRegistration({
        memberId: ctx.memberCId,
        statusCode: 'waitlisted',
      });

      const result = await ctx.service.reject(
        ctx.publishedActivityId,
        regId,
        { reviewNote: '候补清理' },
        ctx.adminPayload,
        AUDIT_META,
      );

      expect(result.statusCode).toBe('reject');
      const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { resourceId: regId } });
      expect(audit.context).toMatchObject({
        extra: {
          action: 'reject',
          priorStatusCode: 'waitlisted',
          nextStatusCode: 'reject',
        },
      });
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

    it('C0. 同一 pending 并发 cancelAdmin 两次 → 恰一方成功,败者 ACTIVITY_REGISTRATION_STATUS_INVALID', async () => {
      const regId = await seedRegistration({ memberId: ctx.memberCId, statusCode: 'pending' });
      const results = await Promise.allSettled([
        ctx.service.cancelAdmin(
          ctx.publishedActivityId,
          regId,
          { cancelReason: 'race left' },
          ctx.adminPayload,
          AUDIT_META,
        ),
        ctx.service.cancelAdmin(
          ctx.publishedActivityId,
          regId,
          { cancelReason: 'race right' },
          ctx.adminPayload,
          AUDIT_META,
        ),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((result) => result.status === 'rejected')).toMatchObject({
        status: 'rejected',
        reason: { biz: BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID },
      });
      expect(
        await ctx.prisma.activityRegistration.findUniqueOrThrow({
          where: { id: regId },
          select: { statusCode: true },
        }),
      ).toEqual({ statusCode: 'cancelled' });
      expect(await ctx.prisma.auditLog.count({ where: { resourceId: regId } })).toBe(1);
    });

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

    it('C1b. waitlisted → cancelled:管理员可移出候补且不触发递补', async () => {
      const regId = await seedRegistration({
        memberId: ctx.memberCId,
        statusCode: 'waitlisted',
      });

      const result = await ctx.service.cancelAdmin(
        ctx.publishedActivityId,
        regId,
        { cancelReason: '退出候补' },
        ctx.adminPayload,
        AUDIT_META,
      );

      expect(result.statusCode).toBe('cancelled');
      expect(
        await ctx.prisma.auditLog.count({
          where: {
            resourceId: { not: regId },
            event: 'registration.review',
          },
        }),
      ).toBe(0);
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

    it('D1b. waitlisted → cancelled:本人可退出候补', async () => {
      const regId = await seedRegistration({
        memberId: ctx.memberAId,
        statusCode: 'waitlisted',
      });

      const result = await ctx.service.cancelMy(
        regId,
        { cancelReason: '不再等待' },
        ctx.selfAPayload,
        AUDIT_META,
      );

      expect(result.statusCode).toBe('cancelled');
      expect(result.cancelReason).toBe('不再等待');
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

    it('E2. cancelled 后 legacy 同头重报并追加新 revision/保险 evidence', async () => {
      // 先 seed 一条 cancelled(模拟历史取消记录)
      const cancelledRegId = await seedRegistration({
        memberId: ctx.memberCId,
        statusCode: 'cancelled',
        cancelledByUserId: ctx.adminUserId,
        cancelledAtIso: '2026-04-05T10:00:00.000Z',
        cancelReason: '之前取消',
      });

      const beforeAuditCount = await ctx.prisma.auditLog.count({
        where: { event: 'registration.create' },
      });
      const beforeInsuranceEvidenceCount = await ctx.prisma.insuranceEligibilityEvidence.count();
      const beforeRevisionCount = await ctx.prisma.activityRegistrationRevision.count({
        where: { registrationId: cancelledRegId },
      });

      const result = await ctx.service.create(
        ctx.publishedActivityId,
        { memberId: ctx.memberCId },
        ctx.adminPayload,
        AUDIT_META,
      );
      expect(result.id).toBe(cancelledRegId);

      const allRows = await ctx.prisma.activityRegistration.findMany({
        where: { activityId: ctx.publishedActivityId, memberId: ctx.memberCId },
        select: { id: true, statusCode: true },
      });
      expect(allRows).toEqual([{ id: cancelledRegId, statusCode: 'pending' }]);
      expect(
        await ctx.prisma.activityRegistrationRevision.count({
          where: { registrationId: cancelledRegId },
        }),
      ).toBe(beforeRevisionCount + 1);

      const afterAuditCount = await ctx.prisma.auditLog.count({
        where: { event: 'registration.create' },
      });
      expect(afterAuditCount).toBe(beforeAuditCount + 1);
      expect(await ctx.prisma.insuranceEligibilityEvidence.count()).toBe(
        beforeInsuranceEvidenceCount,
      );
    });

    it('E2b. cancelled 头仍有永久 identity 时 legacy 新请求返回 21038 且零写', async () => {
      const cancelledRegId = await seedRegistration({
        memberId: ctx.memberCId,
        statusCode: 'cancelled',
        cancelledByUserId: ctx.adminUserId,
        cancelledAtIso: '2026-04-05T10:00:00.000Z',
        cancelReason: '历史 canonical 取消',
      });
      const historicalSession = await ctx.prisma.activitySession.create({
        data: {
          activityId: ctx.publishedActivityId,
          code: `legacy-identity-guard-${Date.now()}`,
          name: 'Legacy identity guard session',
          startAt: new Date('2099-04-01T08:00:00.000Z'),
          endAt: new Date('2099-04-01T12:00:00.000Z'),
          locationText: 'state',
          checkInOpenAt: new Date('2099-04-01T07:30:00.000Z'),
          checkInCloseAt: new Date('2099-04-01T09:00:00.000Z'),
          checkOutOpenAt: new Date('2099-04-01T11:00:00.000Z'),
          checkOutCloseAt: new Date('2099-04-01T12:30:00.000Z'),
          locationRequired: false,
          locationPolicySourceCode: 'activity',
          statusCode: 'scheduled',
          deletedAt: new Date('2026-04-05T11:00:00.000Z'),
        },
        select: { id: true },
      });
      const historicalIdentity = await ctx.prisma.activityParticipationIdentity.create({
        data: {
          activityId: ctx.publishedActivityId,
          sessionId: historicalSession.id,
          registrationId: cancelledRegId,
          memberId: ctx.memberCId,
          currentStatusCode: 'cancelled',
        },
        select: { id: true },
      });
      const before = {
        revisions: await ctx.prisma.activityRegistrationRevision.count({
          where: { registrationId: cancelledRegId },
        }),
        audits: await ctx.prisma.auditLog.count({ where: { resourceId: cancelledRegId } }),
        evidences: await ctx.prisma.insuranceEligibilityEvidence.count({
          where: { activityRegistrationId: cancelledRegId },
        }),
      };

      try {
        await expect(
          ctx.service.create(
            ctx.publishedActivityId,
            { memberId: ctx.memberCId },
            ctx.adminPayload,
            AUDIT_META,
          ),
        ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_REGISTRATION_V11_FLOW_REQUIRED });
        expect(
          await ctx.prisma.activityRegistration.findUniqueOrThrow({
            where: { id: cancelledRegId },
            select: { statusCode: true, currentRevision: true },
          }),
        ).toEqual({ statusCode: 'cancelled', currentRevision: 0 });
        await expect(
          Promise.all([
            ctx.prisma.activityRegistrationRevision.count({
              where: { registrationId: cancelledRegId },
            }),
            ctx.prisma.auditLog.count({ where: { resourceId: cancelledRegId } }),
            ctx.prisma.insuranceEligibilityEvidence.count({
              where: { activityRegistrationId: cancelledRegId },
            }),
          ]),
        ).resolves.toEqual([before.revisions, before.audits, before.evidences]);
      } finally {
        await ctx.prisma.activityParticipationIdentity.delete({
          where: { id: historicalIdentity.id },
        });
        await ctx.prisma.activitySession.delete({ where: { id: historicalSession.id } });
      }
    });

    // 复合锚点闭合(第六轮评审 A-2 + B-03)之后,「identity 错挂他人报名头」这个状态
    // **在数据库层面已不可能存在**:identity 指回报名头的外键是
    // [registrationId, activityId, memberId] → [id, activityId, memberId],而
    // ActivityRegistration 的 (activityId, memberId) 唯一 ⇒ 一个队员在一个活动里至多
    // 一张头,identity 只能挂在自己那张上。
    //
    // 原用例先直插一行"错挂他人头"的 identity,再断言 legacy create 返回 21038 且零写。
    // 那条输入现在**构造不出来**,用例遂改为钉住「数据库在这一步就拒掉」这件事本身。
    // ⚠️ service 侧那道判断**刻意保留不动**(本刀不改 service 校验)—— 数据库闭合后
    // 它由"唯一防线"降级为纵深冗余,是否删除另行判断。
    it('E2c. identity 错挂他人报名头:数据库直接拒(23503),该状态已结构上不可达', async () => {
      const foreignRegistrationId = await seedRegistration({
        memberId: ctx.memberAId,
        statusCode: 'cancelled',
      });
      const historicalSession = await ctx.prisma.activitySession.create({
        data: {
          activityId: ctx.publishedActivityId,
          code: `legacy-foreign-head-${Date.now()}`,
          name: 'Legacy foreign-head identity session',
          startAt: new Date('2099-04-01T08:00:00.000Z'),
          endAt: new Date('2099-04-01T12:00:00.000Z'),
          locationText: 'state',
          checkInOpenAt: new Date('2099-04-01T07:30:00.000Z'),
          checkInCloseAt: new Date('2099-04-01T09:00:00.000Z'),
          checkOutOpenAt: new Date('2099-04-01T11:00:00.000Z'),
          checkOutCloseAt: new Date('2099-04-01T12:30:00.000Z'),
          locationRequired: false,
          locationPolicySourceCode: 'activity',
          statusCode: 'scheduled',
          deletedAt: new Date('2026-04-05T11:00:00.000Z'),
        },
        select: { id: true },
      });

      try {
        // memberA 的报名头 + memberC 的 memberId ⇒ 复合外键当场拒,并点名到具体约束。
        await expect(
          ctx.prisma.activityParticipationIdentity.create({
            data: {
              activityId: ctx.publishedActivityId,
              sessionId: historicalSession.id,
              registrationId: foreignRegistrationId,
              memberId: ctx.memberCId,
              currentStatusCode: 'cancelled',
            },
            select: { id: true },
          }),
        ).rejects.toThrow(/ActivityParticipationIdentity_registrationId_activityId_me_fkey/);

        // 反向对照:同一张头配**它自己的**队员就放行 —— 证明这条外键不是恒拒。
        const ownIdentity = await ctx.prisma.activityParticipationIdentity.create({
          data: {
            activityId: ctx.publishedActivityId,
            sessionId: historicalSession.id,
            registrationId: foreignRegistrationId,
            memberId: ctx.memberAId,
            currentStatusCode: 'cancelled',
          },
          select: { id: true },
        });
        await ctx.prisma.activityParticipationIdentity.delete({ where: { id: ownIdentity.id } });

        // 零写核对:被拒的那次没有给 memberC 留下任何身份行。
        await expect(
          ctx.prisma.activityParticipationIdentity.count({
            where: { activityId: ctx.publishedActivityId, memberId: ctx.memberCId },
          }),
        ).resolves.toBe(0);
      } finally {
        await ctx.prisma.activitySession.delete({ where: { id: historicalSession.id } });
      }
    });

    it('E3. capacity=1 + 1 pass 时,create 新 reg → waitlisted + create audit', async () => {
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

      const result = await ctx.service.create(
        capacityActivityId,
        { memberId: ctx.memberCId },
        ctx.adminPayload,
        AUDIT_META,
      );
      expect(result.statusCode).toBe('waitlisted');

      const afterCount = await ctx.prisma.activityRegistration.count({
        where: { activityId: capacityActivityId },
      });
      expect(afterCount).toBe(beforeCount + 1);

      const audits = await ctx.prisma.auditLog.findMany({
        where: { event: 'registration.create', resourceId: result.id },
      });
      expect(audits).toHaveLength(1);
      const context = audits[0].context as unknown as {
        after?: { statusCode?: string };
      };
      expect(context.after).toMatchObject({ statusCode: 'waitlisted' });
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

    it('G4. inactive Member 允许 reject→pending reopen，但后续 approve 必须重验并拒 MEMBER_INACTIVE', async () => {
      const member = await ctx.prisma.member.create({
        data: {
          memberNo: `reg-state-reopen-inactive-${Date.now()}`,
          ...memberIdentityData('Inactive Reopen Target'),
          status: MemberStatus.INACTIVE,
        },
        select: { id: true },
      });
      const regId = await seedRegistration({
        memberId: member.id,
        statusCode: 'reject',
        reviewerUserId: ctx.adminUserId,
        reviewedAtIso: '2026-04-10T10:00:00.000Z',
        reviewNote: '先拒',
      });

      const reopened = await ctx.service.reopen(
        ctx.publishedActivityId,
        regId,
        ctx.adminPayload,
        AUDIT_META,
      );
      expect(reopened).toMatchObject({
        statusCode: 'pending',
        reviewedBy: null,
        reviewedAt: null,
        reviewNote: null,
      });

      await expect(
        ctx.service.approve(
          ctx.publishedActivityId,
          regId,
          { reviewNote: '不得改判' },
          ctx.adminPayload,
          AUDIT_META,
        ),
      ).rejects.toMatchObject({ biz: BizCode.MEMBER_INACTIVE });
      expect(
        await ctx.prisma.activityRegistration.findUniqueOrThrow({
          where: { id: regId },
          select: { statusCode: true, reviewedBy: true, reviewedAt: true, reviewNote: true },
        }),
      ).toEqual({
        statusCode: 'pending',
        reviewedBy: null,
        reviewedAt: null,
        reviewNote: null,
      });
      expect(
        await ctx.prisma.auditLog.count({
          where: {
            resourceId: regId,
            event: 'registration.review',
            context: { path: ['extra', 'action'], equals: 'approve' },
          },
        }),
      ).toBe(0);
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

    it.each(['published', 'cancelled', 'completed'])(
      'H1. 活动 %s（published 已过 endAt）时 approve pending 报名 → ACTIVITY_ENDED_OR_CANCELLED_APPROVE_FORBIDDEN,DB 不变,无 audit',
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

  describe('J. legacy qualification bypass guard', () => {
    beforeEach(isolateFixtures);

    async function activateScopedRuleSetAfterLegacyRegistration(
      activityId: string,
      scope: 'session' | 'position',
    ): Promise<string> {
      const session = await ctx.prisma.activitySession.create({
        data: {
          activityId,
          code: `legacy-review-qualification-${scope}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          name: 'Legacy review qualification guard session',
          startAt: new Date('2099-04-15T08:00:00.000Z'),
          endAt: new Date('2099-04-15T12:00:00.000Z'),
          locationText: 'state',
          checkInOpenAt: new Date('2099-04-15T07:30:00.000Z'),
          checkInCloseAt: new Date('2099-04-15T09:00:00.000Z'),
          checkOutOpenAt: new Date('2099-04-15T11:00:00.000Z'),
          checkOutCloseAt: new Date('2099-04-15T12:30:00.000Z'),
          locationRequired: false,
          locationPolicySourceCode: 'activity',
          statusCode: 'scheduled',
        },
        select: { id: true },
      });
      const position =
        scope === 'position'
          ? await ctx.prisma.activitySessionPosition.create({
              data: {
                activityId,
                sessionId: session.id,
                code: `legacy-review-position-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                name: 'Legacy review qualification guard position',
                attendanceRoleCode: 'volunteer',
              },
              select: { id: true },
            })
          : null;
      const ruleSet = await ctx.prisma.activityQualificationRuleSet.create({
        data: {
          activityId,
          sessionId: session.id,
          positionId: position?.id,
          version: 1,
          statusCode: 'draft',
          rules: {
            create: {
              ruleTypeCode: 'grade',
              enforcementCode: 'block',
              operator: 'in',
              valueJson: { codes: ['L1'] },
              sortOrder: 1,
            },
          },
        },
        select: { id: true },
      });
      if (position !== null) {
        await ctx.prisma.activitySessionPosition.update({
          where: { id: position.id },
          data: { qualificationRuleSetId: ruleSet.id },
        });
      }
      await ctx.prisma.activityQualificationRuleSet.update({
        where: { id: ruleSet.id },
        data: { statusCode: 'active' },
      });
      return ruleSet.id;
    }

    it('J1. active session-level RuleSet blocks legacy admin create even when the session is no longer scheduled', async () => {
      const activityId = await createActivity({});
      const session = await ctx.prisma.activitySession.create({
        data: {
          activityId,
          code: `legacy-qualification-${Date.now()}`,
          name: 'Legacy qualification guard session',
          startAt: new Date('2099-04-15T08:00:00.000Z'),
          endAt: new Date('2099-04-15T12:00:00.000Z'),
          locationText: 'state',
          checkInOpenAt: new Date('2099-04-15T07:30:00.000Z'),
          checkInCloseAt: new Date('2099-04-15T09:00:00.000Z'),
          checkOutOpenAt: new Date('2099-04-15T11:00:00.000Z'),
          checkOutCloseAt: new Date('2099-04-15T12:30:00.000Z'),
          locationRequired: false,
          locationPolicySourceCode: 'activity',
          statusCode: 'cancelled',
        },
        select: { id: true },
      });
      const ruleSet = await ctx.prisma.activityQualificationRuleSet.create({
        data: {
          activityId,
          sessionId: session.id,
          version: 1,
          statusCode: 'draft',
          rules: {
            create: {
              ruleTypeCode: 'grade',
              enforcementCode: 'block',
              operator: 'in',
              valueJson: { codes: ['L1'] },
              sortOrder: 1,
            },
          },
        },
        select: { id: true },
      });
      await ctx.prisma.activityQualificationRuleSet.update({
        where: { id: ruleSet.id },
        data: { statusCode: 'active' },
      });

      await expect(
        ctx.service.create(activityId, { memberId: ctx.memberCId }, ctx.adminPayload, AUDIT_META),
      ).rejects.toMatchObject({ biz: { code: 21038 } });
      expect(
        await ctx.prisma.activityRegistration.count({
          where: { activityId, memberId: ctx.memberCId },
        }),
      ).toBe(0);
    });

    it.each(['session', 'position'] as const)(
      'J2. legacy pending created before active %s RuleSet cannot bypass approve and leaves every write target unchanged',
      async (scope) => {
        const activityId = await createActivity({});
        const legacy = await ctx.service.create(
          activityId,
          { memberId: ctx.memberCId },
          ctx.adminPayload,
          AUDIT_META,
        );
        const revision = await ctx.prisma.activityRegistrationRevision.findFirstOrThrow({
          where: { registrationId: legacy.id },
          select: { id: true },
        });
        await expect(
          Promise.all([
            ctx.prisma.activityParticipationIdentity.count({
              where: { registrationId: legacy.id },
            }),
            ctx.prisma.activityPositionPreference.count({
              where: { registrationRevisionId: revision.id },
            }),
          ]),
        ).resolves.toEqual([0, 0]);

        const ruleSetId = await activateScopedRuleSetAfterLegacyRegistration(activityId, scope);
        const before = await Promise.all([
          ctx.prisma.activityRegistration.findUniqueOrThrow({
            where: { id: legacy.id },
            select: {
              statusCode: true,
              reviewedBy: true,
              reviewedAt: true,
              reviewNote: true,
              currentRevision: true,
            },
          }),
          ctx.prisma.activityRegistrationRevision.count({ where: { registrationId: legacy.id } }),
          ctx.prisma.activityParticipationIdentity.count({ where: { registrationId: legacy.id } }),
          ctx.prisma.activityPositionPreference.count({
            where: { registrationRevision: { registrationId: legacy.id } },
          }),
          ctx.prisma.auditLog.count({ where: { resourceId: legacy.id } }),
          ctx.prisma.notificationOutboxIntent.count({ where: { aggregateId: legacy.id } }),
          ctx.prisma.qualificationEvaluationSnapshot.findMany({
            where: { ruleSetVersionId: ruleSetId },
            select: { id: true, inputFactsHash: true },
            orderBy: { id: 'asc' },
          }),
        ]);

        await expect(
          ctx.service.approve(
            activityId,
            legacy.id,
            { reviewNote: '旧报名不得猜测场次或岗位' },
            ctx.adminPayload,
            AUDIT_META,
          ),
        ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_REGISTRATION_V11_FLOW_REQUIRED });

        await expect(
          Promise.all([
            ctx.prisma.activityRegistration.findUniqueOrThrow({
              where: { id: legacy.id },
              select: {
                statusCode: true,
                reviewedBy: true,
                reviewedAt: true,
                reviewNote: true,
                currentRevision: true,
              },
            }),
            ctx.prisma.activityRegistrationRevision.count({ where: { registrationId: legacy.id } }),
            ctx.prisma.activityParticipationIdentity.count({
              where: { registrationId: legacy.id },
            }),
            ctx.prisma.activityPositionPreference.count({
              where: { registrationRevision: { registrationId: legacy.id } },
            }),
            ctx.prisma.auditLog.count({ where: { resourceId: legacy.id } }),
            ctx.prisma.notificationOutboxIntent.count({ where: { aggregateId: legacy.id } }),
            ctx.prisma.qualificationEvaluationSnapshot.findMany({
              where: { ruleSetVersionId: ruleSetId },
              select: { id: true, inputFactsHash: true },
              orderBy: { id: 'asc' },
            }),
          ]),
        ).resolves.toEqual(before);
      },
    );

    it('J3. an activity-only active RuleSet still permits legacy approve without an identity or preference', async () => {
      const member = await ctx.prisma.member.create({
        data: {
          memberNo: `legacy-activity-only-${Date.now()}`,
          ...memberIdentityData('Legacy activity-only qualification target'),
          gradeCode: 'L1',
          status: MemberStatus.ACTIVE,
        },
        select: { id: true },
      });
      const activityId = await createActivity({});
      const legacy = await ctx.service.create(
        activityId,
        { memberId: member.id },
        ctx.adminPayload,
        AUDIT_META,
      );
      const ruleSet = await ctx.prisma.activityQualificationRuleSet.create({
        data: {
          activityId,
          version: 1,
          statusCode: 'draft',
          rules: {
            create: {
              ruleTypeCode: 'grade',
              enforcementCode: 'block',
              operator: 'in',
              valueJson: { codes: ['L1'] },
              sortOrder: 1,
            },
          },
        },
        select: { id: true },
      });
      await ctx.prisma.activityQualificationRuleSet.update({
        where: { id: ruleSet.id },
        data: { statusCode: 'active' },
      });

      await expect(
        Promise.all([
          ctx.prisma.activityParticipationIdentity.count({ where: { registrationId: legacy.id } }),
          ctx.prisma.activityPositionPreference.count({
            where: { registrationRevision: { registrationId: legacy.id } },
          }),
        ]),
      ).resolves.toEqual([0, 0]);
      await expect(
        ctx.service.approve(activityId, legacy.id, {}, ctx.adminPayload, AUDIT_META),
      ).resolves.toMatchObject({ statusCode: 'pass' });
      await expect(
        ctx.prisma.qualificationEvaluationSnapshot.findMany({
          where: { ruleSetVersionId: ruleSet.id, evaluationPhaseCode: 'review' },
          select: { identityId: true, resultCode: true },
        }),
      ).resolves.toEqual([{ identityId: null, resultCode: 'pass' }]);
    });
  });
});
