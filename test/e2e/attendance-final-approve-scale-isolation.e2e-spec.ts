import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import {
  MEMBER_LOCK_WAIT_BUDGET_MS,
  MEMBER_TX_TIMEOUT_MS,
  MEMBER_TX_WORK_BUDGET_MS,
} from '../../src/common/prisma/member-advisory-lock.util';
import { PrismaService } from '../../src/database/prisma.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { AttendancesService } from '../../src/modules/attendances/attendances.service';
import { TEST_PASSWORD_HASH } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

// M3(并发复审 P1):考勤终审的三条债一起还。
//
// ① **N+1 打穿事务预算**:before/after 贡献值快照与 outbox intent 都是逐条发的 ——
//    200 人的考勤单约 1000+ 次往返,跑穿 Prisma 默认 5s 交互事务预算就是 P2028。
//    评审明确不许「只调大 timeout」:那只是把锁持有得更久,让 convoy 更严重。
//    刀口必须落在查询次数上,所以本 spec 的判据是 **SQL 次数**,不是「跑通了」。
// ② **隔离级别是隐含前提**:member 键把两个事务排成队,但排到之后要读**跨行聚合**。
//    PostgreSQL 的 REPEATABLE READ 在事务第一条语句就固定快照 —— 排到了也读不到前一个
//    事务刚提交的事实,write skew 原封不动复活。测试库默认 RC 把这个前提完全掩盖:
//    同一份代码在默认 RR 的库上是错的,而没有任何用例会红。用例 ③ 就是把库默认值真的
//    改成 RR 再跑一遍。
// ③ **锁等待此前无界**:一直等到事务预算耗尽 → P2028 → 50000「服务器内部错误」。
//    那既不是事实(服务器没坏,只是有人在排队)也不可重试。现在是 40901。

const META: AuditMeta = {
  requestId: 'attendance-final-approve-scale-isolation',
  ip: '127.0.0.1',
  ua: 'jest/attendance-final-approve-scale-isolation',
};
const CASE_TIMEOUT_MS = 180_000;
const CYCLE_YEAR = 2026;
const DAY_A = new Date('2026-01-10T02:00:00.000Z');
const DAY_B = new Date('2026-01-11T02:00:00.000Z');
const DAY_C = new Date('2026-01-12T02:00:00.000Z');

/** 考勤单上限(评审给的规模);超过它的单子在业务上不存在。 */
const SCALE_RECORDS = 200;
/**
 * 事务内 SQL 次数上限。批量化后实测约 16 次(与 records 数**无关**);
 * 评审记录的现状基数是 1008 / 1408 次。留到 40 是给未来几次无害的读留余量 ——
 * 但它必须远小于「随 N 增长」的量级,否则这条断言就不再是判据。
 */
const MAX_TX_QUERIES = 40;
/**
 * 无争用时 200 人终审的耗时上限 = **业务工作预算本身**(实测 222ms,预算 3000ms)。
 *
 * ⚠️ 刻意绑定到生产常量而不是另写一个数:R4 把事务预算显式抬到
 * `MEMBER_TX_TIMEOUT_MS`(锁预算 + 工作预算),如果这里还留着一个手写的
 * 「5s 减 1s」的 4000,它就与预算脱钩,变成第二把尺子 —— 而「调大 timeout 顶过
 * N+1 退化」正是要靠这条断言挡住的。绑死之后:抬预算不会顺带放松这条。
 */
const MAX_TX_DURATION_MS = MEMBER_TX_WORK_BUDGET_MS;
/**
 * Prisma 未显式指定 timeout 时的交互事务预算。R4 之前本仓吃的就是它。
 * 只用于**自证前提**:近预算用例必须把总耗时推到它以上,否则那些用例
 * 在修复前也是绿的 —— 绿的对抗用例证明不了任何事。
 */
const PRISMA_DEFAULT_TX_TIMEOUT_MS = 5_000;

interface QueryCounter {
  reset: () => void;
  count: () => number;
  restore: () => void;
}

/**
 * 数「业务代码在事务里发了多少次 SQL」。
 *
 * 做法:接管 `$transaction`,把交给回调的 tx 客户端换成计数 Proxy。
 * 不数 Prisma 自己的 BEGIN/COMMIT —— 判据是业务侧的往返次数,那正是 N+1 的量纲。
 * 只包 model delegate(有 findFirst 的对象)与 `$` 开头的裸 SQL 方法,不碰内部字段。
 */
function installQueryCounter(prisma: PrismaService): QueryCounter {
  const original = prisma.$transaction.bind(prisma) as (...args: unknown[]) => unknown;
  let count = 0;
  const tally = <T extends (...args: never[]) => unknown>(self: object, fn: T): T =>
    ((...args: never[]) => {
      count += 1;
      return fn.apply(self, args);
    }) as unknown as T;

  const wrap = (tx: object): object =>
    new Proxy(tx, {
      get(target, prop, receiver): unknown {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof prop !== 'string') return value;
        if (prop.startsWith('$') && typeof value === 'function') {
          return tally(target, value as (...args: never[]) => unknown);
        }
        if (
          value !== null &&
          typeof value === 'object' &&
          typeof (value as { findFirst?: unknown }).findFirst === 'function'
        ) {
          const delegate = value;
          return new Proxy(delegate, {
            get(d, m, r): unknown {
              const fn: unknown = Reflect.get(d, m, r);
              return typeof fn === 'function' ? tally(d, fn as (...args: never[]) => unknown) : fn;
            },
          });
        }
        return value;
      },
    });

  const patched = (arg: unknown, options: unknown): unknown =>
    typeof arg === 'function'
      ? original((tx: object) => (arg as (t: object) => unknown)(wrap(tx)), options)
      : original(arg, options);
  (prisma as unknown as Record<string, unknown>).$transaction = patched;

  return {
    reset: () => {
      count = 0;
    },
    count: () => count,
    restore: () => {
      (prisma as unknown as Record<string, unknown>).$transaction = original;
    },
  };
}

describe('考勤终审:规模、隔离级别与有界锁等待(M3)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let attendances: AttendancesService;
  let finalReviewer: CurrentUserPayload;
  let submitterUserId: string;
  let reviewerUserId: string;
  let activityId: string;
  let databaseName: string;
  let seq = 0;

  async function makeMember(): Promise<string> {
    seq += 1;
    const member = await prisma.member.create({
      data: {
        memberNo: `M3S${String(seq).padStart(4, '0')}`,
        ...memberIdentityData(`规模${seq}`),
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    return member.id;
  }

  /** 建一条 joining 申请(milestone 路径的挂载点);返回 applicationId。 */
  async function giveJoiningApplication(memberId: string): Promise<string> {
    seq += 1;
    const cycle = await prisma.teamJoinCycle.create({
      data: {
        year: CYCLE_YEAR,
        name: `M3 轮 ${seq}`,
        statusCode: 'closed',
        openedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      select: { id: true },
    });
    const application = await prisma.teamJoinApplication.create({
      data: { cycleId: cycle.id, memberId, statusCode: 'joining', targetOrganizationIds: [] },
      select: { id: true },
    });
    return application.id;
  }

  async function giveApprovedContribution(
    memberId: string,
    points: string,
    checkInAt: Date,
  ): Promise<void> {
    const sheet = await prisma.attendanceSheet.create({
      data: { activityId, submitterUserId, statusCode: 'approved' },
      select: { id: true },
    });
    await prisma.attendanceRecord.create({
      data: {
        sheetId: sheet.id,
        memberId,
        roleCode: 'member',
        checkInAt,
        checkOutAt: new Date(checkInAt.getTime() + 3600_000),
        serviceHours: '1.00',
        attendanceStatusCode: 'present',
        contributionPoints: points,
      },
    });
  }

  async function createPendingFinalReviewSheet(
    entries: ReadonlyArray<{ memberId: string; points: string; checkInAt: Date }>,
  ): Promise<string> {
    const sheet = await prisma.attendanceSheet.create({
      data: {
        activityId,
        submitterUserId,
        lastSubmittedByUserId: submitterUserId,
        lastSubmittedAt: new Date(),
        reviewerUserId,
        reviewedAt: new Date(),
        statusCode: 'pending_final_review',
        version: 1,
      },
      select: { id: true },
    });
    await prisma.attendanceRecord.createMany({
      data: entries.map((entry) => ({
        sheetId: sheet.id,
        memberId: entry.memberId,
        roleCode: 'member',
        checkInAt: entry.checkInAt,
        checkOutAt: new Date(entry.checkInAt.getTime() + 3600_000),
        serviceHours: new Prisma.Decimal(1),
        attendanceStatusCode: 'present',
        contributionPoints: new Prisma.Decimal(entry.points),
      })),
    });
    return sheet.id;
  }

  /**
   * 占住一把锁直到 `release()`,返回三件事:
   *   · `acquired` —— 锁**真的到手**后才 resolve。不等它就开始被测事务 = 用竞态碰运气,
   *     偶尔锁还没拿到,被测事务一路畅通,用例变成一条什么都没证明的绿。
   *   · `release()` —— 放锁(提交占位事务)。
   *   · `done` —— 占位事务的 promise,必须 await,否则连接泄漏到下一条用例。
   */
  function holdLock(take: (tx: Prisma.TransactionClient) => Promise<unknown>): {
    acquired: Promise<void>;
    release: () => void;
    done: Promise<unknown>;
  } {
    let markAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => {
      markAcquired = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = prisma.$transaction(
      async (tx) => {
        await take(tx);
        markAcquired();
        await gate;
      },
      // 占位事务自己不受被测预算约束 —— 它是环境,不是被测对象。
      { timeout: 120_000, maxWait: 120_000 },
    );
    return { acquired, release, done };
  }

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    attendances = app.get(AttendancesService);
    [{ current_database: databaseName }] = await prisma.$queryRaw<
      Array<{ current_database: string }>
    >(Prisma.sql`SELECT current_database()`);

    const submitter = await prisma.user.create({
      data: {
        username: 'm3s-submitter',
        passwordHash: TEST_PASSWORD_HASH,
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
      },
      select: { id: true },
    });
    submitterUserId = submitter.id;
    const reviewer = await prisma.user.create({
      data: {
        username: 'm3s-reviewer',
        passwordHash: TEST_PASSWORD_HASH,
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
      },
      select: { id: true },
    });
    reviewerUserId = reviewer.id;
    const finalReviewerRow = await prisma.user.create({
      data: {
        username: 'm3s-final-reviewer',
        passwordHash: TEST_PASSWORD_HASH,
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      },
      select: { id: true, username: true },
    });
    finalReviewer = {
      id: finalReviewerRow.id,
      username: finalReviewerRow.username,
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      memberId: null,
    };

    const organizationId = (
      await prisma.organization.create({
        data: { name: 'M3S Org', nodeTypeCode: 'm3s-node', status: 'ACTIVE' },
        select: { id: true },
      })
    ).id;
    activityId = (
      await prisma.activity.create({
        data: {
          title: 'M3S Activity',
          activityTypeCode: 'm3s-act',
          organizationId,
          startAt: DAY_A,
          endAt: DAY_C,
          location: '深圳',
          statusCode: 'completed',
        },
        select: { id: true },
      })
    ).id;
    // ⚠️ 显式给 beforeAll 一个大预算:resetDb 是 TRUNCATE 55 表的全库擦除,
    // 磁盘紧张时单次可以远超 jest 默认的 30s hook 预算 —— 那样红的是环境不是判据。
  }, 300_000);

  afterAll(async () => {
    await app.close();
  });

  it(
    `① 规模位:${SCALE_RECORDS} 人考勤单一次终审 —— SQL 次数不随人数增长,且在事务预算内`,
    async () => {
      const memberIds: string[] = [];
      for (let i = 0; i < SCALE_RECORDS; i += 1) memberIds.push(await makeMember());
      // 每人一条 joining 申请 ⇒ 走满 before/after 两次快照 + milestone 判定(评审的 1408 基数场景)。
      const applicationIds: string[] = [];
      for (const memberId of memberIds) applicationIds.push(await giveJoiningApplication(memberId));
      const sheetId = await createPendingFinalReviewSheet(
        memberIds.map((memberId) => ({ memberId, points: '1.00', checkInAt: DAY_B })),
      );

      const counter = installQueryCounter(prisma);
      let elapsedMs = 0;
      try {
        counter.reset();
        const startedAt = Date.now();
        await attendances.finalApprove(sheetId, {}, finalReviewer, META);
        elapsedMs = Date.now() - startedAt;
      } finally {
        counter.restore();
      }

      // 修复前:逐人查申请 + 逐人两次贡献值 + 逐条 outbox(2 次/条)≈ 1000+ 次,
      // 一路把 5s 交互事务预算跑穿 → P2028 → 50000。
      expect(counter.count()).toBeLessThan(MAX_TX_QUERIES);
      expect(elapsedMs).toBeLessThan(MAX_TX_DURATION_MS);

      // 行为不许因批量化而变:每条 record 一条结果通知,一个人一条 milestone。
      expect(
        await prisma.notificationOutboxIntent.count({
          where: { aggregateType: 'attendance_sheet', aggregateId: sheetId },
        }),
      ).toBe(SCALE_RECORDS);
      expect(
        await prisma.notificationOutboxIntent.count({
          where: { eventKey: { startsWith: 'team-join-contribution-met:' } },
        }),
      ).toBe(0); // 每人只有 1 分,没人跨过 5 分门槛
      expect(
        (
          await prisma.attendanceSheet.findUniqueOrThrow({
            where: { id: sheetId },
            select: { statusCode: true },
          })
        ).statusCode,
      ).toBe('approved');
      expect(applicationIds).toHaveLength(SCALE_RECORDS);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    '② convoy 位:同一队员的键被长时间占住 —— 终审以 40901 有界失败,不是 P2028→50000',
    async () => {
      const memberId = await makeMember();
      const sheetId = await createPendingFinalReviewSheet([
        { memberId, points: '1.00', checkInAt: DAY_C },
      ]);

      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      // 占住键的时间**超过** MEMBER_LOCK_WAIT_BUDGET_MS(4s),逼终审真的等到超时。
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${memberId}))::text AS locked`;
          await gate;
        },
        { timeout: 60_000, maxWait: 60_000 },
      );

      const startedAt = Date.now();
      let caught: unknown;
      try {
        await attendances.finalApprove(sheetId, {}, finalReviewer, META);
      } catch (err) {
        caught = err;
      }
      const elapsedMs = Date.now() - startedAt;
      release();
      await holder;

      // 修复前:一直等到 Prisma 5s 事务预算耗尽 → P2028 → 全局过滤器 50000。
      expect(caught).toBeInstanceOf(BizException);
      expect((caught as BizException).biz).toBe(BizCode.CONCURRENT_WRITE_LOCK_TIMEOUT);
      // 有界:必须在 5s 事务预算**之前**失败,否则闸没生效(先撞的仍是 P2028)。
      expect(elapsedMs).toBeLessThan(5_000);
      // 失败即全回滚:Sheet 状态、intent 都不得留下半成品。
      expect(
        (
          await prisma.attendanceSheet.findUniqueOrThrow({
            where: { id: sheetId },
            select: { statusCode: true },
          })
        ).statusCode,
      ).toBe('pending_final_review');
      expect(
        await prisma.notificationOutboxIntent.count({
          where: { aggregateType: 'attendance_sheet', aggregateId: sheetId },
        }),
      ).toBe(0);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    '② convoy 位(反向):键空闲时,同一队员的多张单串行终审全部成功',
    async () => {
      const memberId = await makeMember();
      const sheetIds = await Promise.all([
        createPendingFinalReviewSheet([{ memberId, points: '1.00', checkInAt: DAY_A }]),
        createPendingFinalReviewSheet([{ memberId, points: '1.00', checkInAt: DAY_B }]),
        createPendingFinalReviewSheet([{ memberId, points: '1.00', checkInAt: DAY_C }]),
      ]);

      const results = await Promise.allSettled(
        sheetIds.map((sheetId) => attendances.finalApprove(sheetId, {}, finalReviewer, META)),
      );
      for (const result of results) {
        expect(result.status).toBe('fulfilled');
      }
      expect(
        await prisma.attendanceSheet.count({
          where: { id: { in: sheetIds }, statusCode: 'approved' },
        }),
      ).toBe(3);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    '③ 隔离级别位:把**库默认**改成 REPEATABLE READ,里程碑通知仍恰好一条',
    async () => {
      // 判据:显式 `isolationLevel: ReadCommitted` 必须压过库默认值。
      // 去掉那一行、库默认 RR 时:两个终审各自在取键**之前**就固定了快照,排队排到了也
      // 读不到对方刚提交的分数,两边都算出 4 分、谁都不 enqueue —— write skew 完整复活。
      await prisma.$executeRawUnsafe(
        `ALTER DATABASE "${databaseName}" SET default_transaction_isolation = 'repeatable read'`,
      );
      // 新连接才吃得到新默认值,所以必须在 ALTER **之后**建 app。
      const rrAppA = await createTestApp();
      const rrAppB = await createTestApp();
      try {
        const rrPrismaA = rrAppA.get(PrismaService);
        const [shown] = await rrPrismaA.$queryRaw<Array<{ default_transaction_isolation: string }>>(
          Prisma.sql`SHOW default_transaction_isolation`,
        );
        // 前提自证:库默认真的是 RR,否则本用例什么都没证明。
        expect(shown.default_transaction_isolation).toBe('repeatable read');

        const memberId = await makeMember();
        const applicationId = await giveJoiningApplication(memberId);
        await giveApprovedContribution(memberId, '3.00', DAY_A);
        const sheetOne = await createPendingFinalReviewSheet([
          { memberId, points: '1.00', checkInAt: DAY_B },
        ]);
        const sheetTwo = await createPendingFinalReviewSheet([
          { memberId, points: '1.00', checkInAt: DAY_C },
        ]);

        const [first, second] = await Promise.allSettled([
          rrAppA.get(AttendancesService).finalApprove(sheetOne, {}, finalReviewer, META),
          rrAppB.get(AttendancesService).finalApprove(sheetTwo, {}, finalReviewer, META),
        ]);
        expect(first.status).toBe('fulfilled');
        expect(second.status).toBe('fulfilled');

        expect(
          await prisma.notificationOutboxIntent.count({
            where: { eventKey: `team-join-contribution-met:${applicationId}:5` },
          }),
        ).toBe(1);
      } finally {
        await Promise.all([rrAppA.close(), rrAppB.close()]);
        await prisma.$executeRawUnsafe(
          `ALTER DATABASE "${databaseName}" RESET default_transaction_isolation`,
        );
      }
    },
    CASE_TIMEOUT_MS,
  );

  // ── ④ 近预算位(M3 遗留 P2,2026-08-01)────────────────────────────────────
  //
  // ②(convoy)证的是「等**超时**了要给 40901」。它证不了对称的另一半:
  // **等到了**锁的那个事务,还有没有预算把活干完。
  //
  // 上一版两个预算是这样凑起来的:`lock_timeout` 显式 4s,交互事务预算**继承 Prisma
  // 默认的 5s**。于是真正排过一次队的事务,留给业务的只剩 1s —— 而 200 人终审实测
  // 222ms,慢一个数量级的库就跑穿,以 P2028 → 50000 收场。它排了队、拿到了锁、
  // 什么都没做错,却拿到一个不可重试的 500:M3 花力气从 500 改成 40901 的那件事,
  // 从另一条路原样回来了。修法是把总预算也显式写出来(MEMBER_TX_TIMEOUT_MS)。
  //
  // 两条用例分工不同,都要留:
  //   ④-a = 评审点名的那一条(等 3.8s → 完整 200 人终审)。**它在本机修复前是绿的**
  //         (3.8s + 0.22s ≈ 4.0s < 5s),写它是因为它钉住的是「余量」这个量纲:
  //         修复前余量 1s、修复后 3s,而 200 人的活要 0.22s —— 余量必须比活大一个
  //         数量级,不能只大 4 倍。它是回归闸,不是复现闸。
  //   ④-b = 真正的 red-first。`lock_timeout` 是 **per-acquisition** 语义,而这条路径上
  //         有两个会阻塞的取锁点(claimAtStatus 的 FOR NO KEY UPDATE → member advisory
  //         键),串行等待**相加**。两段各自都在 4s 锁预算之内,加起来越过 5s ——
  //         修复前 P2028 → 500,修复后产出业务结果。
  it(
    `④-a 近预算位:等 ${MEMBER_LOCK_WAIT_BUDGET_MS - 200}ms 拿到键后,${SCALE_RECORDS} 人终审仍跑完(不是 P2028→500)`,
    async () => {
      /** 卡在锁预算之内 —— 本例要的是「等到了」,不是「等超时」(那是 ② 的判据)。 */
      const HOLD_MS = MEMBER_LOCK_WAIT_BUDGET_MS - 200;
      expect(HOLD_MS).toBeLessThan(MEMBER_LOCK_WAIT_BUDGET_MS);

      const memberIds: string[] = [];
      for (let i = 0; i < SCALE_RECORDS; i += 1) memberIds.push(await makeMember());
      for (const memberId of memberIds) await giveJoiningApplication(memberId);
      const sheetId = await createPendingFinalReviewSheet(
        memberIds.map((memberId) => ({ memberId, points: '1.00', checkInAt: DAY_B })),
      );

      // lockMembersForWrite 是**一条** SQL 批量取键,占住其中任意一把就足以让整条语句排队;
      // 取排序最末那把,让它先拿到前 199 把再卡住 —— 更接近真实 convoy 的形状。
      const heldMemberId = [...memberIds].sort().at(-1)!;
      const holder = holdLock(
        (tx) =>
          tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${heldMemberId}))::text AS locked`,
      );
      await holder.acquired;

      const startedAt = Date.now();
      const timer = setTimeout(holder.release, HOLD_MS);
      let caught: unknown;
      try {
        await attendances.finalApprove(sheetId, {}, finalReviewer, META);
      } catch (err) {
        caught = err;
      }
      const elapsedMs = Date.now() - startedAt;
      clearTimeout(timer);
      holder.release();
      await holder.done;

      // 判据一:产出的是业务结果,不是 P2028 → 50000。
      expect(caught).toBeUndefined();
      // 判据二:它**真的排过队** —— 否则本例退化成「无争用跑一遍」,什么都没证明。
      expect(elapsedMs).toBeGreaterThanOrEqual(HOLD_MS - 300);
      // 判据三:排队 + 干活合起来仍在显式预算内(修复前这里只有 5s 可用)。
      expect(elapsedMs).toBeLessThan(MEMBER_TX_TIMEOUT_MS);

      // 行为不许因排队而缩水:200 条结果通知一条不少,状态照常落到 approved。
      expect(
        (
          await prisma.attendanceSheet.findUniqueOrThrow({
            where: { id: sheetId },
            select: { statusCode: true },
          })
        ).statusCode,
      ).toBe('approved');
      expect(
        await prisma.notificationOutboxIntent.count({
          where: { aggregateType: 'attendance_sheet', aggregateId: sheetId },
        }),
      ).toBe(SCALE_RECORDS);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    '④-b 近预算位(串行两段等待):Sheet 行锁 + member 键各自都在锁预算内,相加越过旧的 5s 默认预算',
    async () => {
      /** 第一段:claimAtStatus 的 FOR NO KEY UPDATE 等这么久。 */
      const SHEET_HOLD_MS = 3_000;
      /** 第二段结束点(从终审起算):member 键等到这一刻。 */
      const MEMBER_HOLD_MS = MEMBER_TX_TIMEOUT_MS - 1_200;

      // ── 前提自证:这四条任意一条不成立,本用例就不再是它自称的那个判据 ──
      // 单段都必须在锁预算内,否则先撞的是 40901(那是 ② 的判据,不是本例的)。
      expect(SHEET_HOLD_MS).toBeLessThan(MEMBER_LOCK_WAIT_BUDGET_MS);
      expect(MEMBER_HOLD_MS - SHEET_HOLD_MS).toBeLessThan(MEMBER_LOCK_WAIT_BUDGET_MS);
      // 相加必须越过旧的 5s 默认预算,否则修复前它也是绿的 —— 绿的对抗用例证明不了任何事。
      expect(MEMBER_HOLD_MS).toBeGreaterThan(PRISMA_DEFAULT_TX_TIMEOUT_MS);
      // 且必须落在新预算之内,否则修复后它也是红的。
      expect(MEMBER_HOLD_MS).toBeLessThan(MEMBER_TX_TIMEOUT_MS);

      const memberId = await makeMember();
      const sheetId = await createPendingFinalReviewSheet([
        { memberId, points: '1.00', checkInAt: DAY_A },
      ]);

      // 两把锁都先到手,再放终审进来 —— 顺序颠倒就变成竞态。
      const sheetHolder = holdLock(
        (tx) => tx.$queryRaw`SELECT "id" FROM "AttendanceSheet" WHERE "id" = ${sheetId} FOR UPDATE`,
      );
      const memberHolder = holdLock(
        (tx) => tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${memberId}))::text AS locked`,
      );
      await Promise.all([sheetHolder.acquired, memberHolder.acquired]);

      const startedAt = Date.now();
      const timers = [
        setTimeout(sheetHolder.release, SHEET_HOLD_MS),
        setTimeout(memberHolder.release, MEMBER_HOLD_MS),
      ];
      let caught: unknown;
      try {
        await attendances.finalApprove(sheetId, {}, finalReviewer, META);
      } catch (err) {
        caught = err;
      }
      const elapsedMs = Date.now() - startedAt;
      for (const t of timers) clearTimeout(t);
      sheetHolder.release();
      memberHolder.release();
      await Promise.all([sheetHolder.done, memberHolder.done]);

      // 修复前:两段等待相加 ≈ 5.8s > Prisma 默认 5s ⇒ P2028 ⇒ 全局过滤器 50000。
      expect(caught).toBeUndefined();
      // 自证它真的走完了两段等待(不是某一段没生效)。
      expect(elapsedMs).toBeGreaterThanOrEqual(MEMBER_HOLD_MS - 300);
      expect(elapsedMs).toBeLessThan(MEMBER_TX_TIMEOUT_MS);
      expect(
        (
          await prisma.attendanceSheet.findUniqueOrThrow({
            where: { id: sheetId },
            select: { statusCode: true },
          })
        ).statusCode,
      ).toBe('approved');
    },
    CASE_TIMEOUT_MS,
  );
});
