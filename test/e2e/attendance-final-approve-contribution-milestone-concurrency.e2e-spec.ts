import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { PrismaService } from '../../src/database/prisma.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { AttendancesService } from '../../src/modules/attendances/attendances.service';
import { TEST_PASSWORD_HASH } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 并发审计 K3(B-F2):考勤终审的入队贡献值里程碑是 **write skew**。
//
// `computeContribution` 跨该队员当年**全部** approved Sheet 聚合,而 `finalApprove`
// 只认领当前这一张 Sheet —— 判定依据横跨多行,持有的锁只锁住一行。
// 于是两张 Sheet 同时终审:各自读到 before=3、各自算出 after=4,谁都没跨过 5 分阈值,
// 谁都不尝试 enqueue;提交后正式总分是 5,durable milestone intent 却是 0。
// outbox 的唯一键兜不住 —— 兜底的前提是「至少有一方尝试插入」,而这里两边都没试。
// 任一串行顺序下,第二个终审都会观察到 4→5 并发出通知;并发下这条通知**永久**丢失
// (同 application + 门槛只有一次首跨机会)。
//
// 本 spec 两条用例分工:
// ① 结构位:member 线性化键被占住时,finalApprove 必须等 —— 修复前没有这把键,直接红。
// ② 行为位:两张 Sheet 真并发终审,恰好一条 milestone intent。
//    ② 的窗口由 `audit_logs` 表级 SHARE 锁按住 —— 不按住时红是概率性的:
//    只要有一方先提交,另一方的 after 就会读到 5 分并正确发通知,bug 自己藏起来
//    (首版本用例正是这样在修复前意外通过的,所以才补了这道 barrier)。

const META: AuditMeta = {
  requestId: 'attendance-final-approve-milestone-concurrency',
  ip: '127.0.0.1',
  ua: 'jest/attendance-final-approve-milestone-concurrency',
};
// ⚠️ 被 barrier 钉住的是**生产事务**,它用 Prisma 默认 5s 交互事务预算。
// 观测窗必须远小于 5s:waiter 正常 20-40ms 就出现,等不到就是「锁没取」(那正是我们要的红)。
// 把窗开大反而会让用例在并行负载下以 P2028(事务过期)红,掩盖真正的判据 —— 实测栽过一次:
// 5 worker 并行时轮询本身跑了 14.6s,生产事务先超时。
const LOCK_WAIT_TIMEOUT_MS = 1_200;
const CASE_TIMEOUT_MS = 60_000;
const CYCLE_YEAR = 2026;
// cutoff = 2026-04-01 00:00 +08:00;贡献值只计 checkInAt 早于它的 approved 记录。
const DAY_A = new Date('2026-01-10T02:00:00.000Z');
const DAY_B = new Date('2026-01-11T02:00:00.000Z');
const DAY_C = new Date('2026-01-12T02:00:00.000Z');

describe('考勤终审 × 入队贡献值里程碑并发(K3 · B-F2 write skew)', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let attendancesA: AttendancesService;
  let attendancesB: AttendancesService;
  let finalReviewer: CurrentUserPayload;
  let submitterUserId: string;
  let reviewerUserId: string;
  let activityId: string;
  let seq = 0;

  async function countAdvisoryWaiters(): Promise<number> {
    const [row] = await prismaB.$queryRaw<Array<{ n: number }>>(Prisma.sql`
      SELECT count(*)::int AS n
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND wait_event = 'advisory'
    `);
    return row?.n ?? 0;
  }

  async function countAnyLockWaiters(): Promise<number> {
    const [row] = await prismaB.$queryRaw<Array<{ n: number }>>(Prisma.sql`
      SELECT count(*)::int AS n
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
    `);
    return row?.n ?? 0;
  }

  interface Barrier {
    ready: Promise<void>;
    release: () => void;
    done: Promise<void>;
  }

  function holdInOwnTransaction(hold: (tx: Prisma.TransactionClient) => Promise<void>): Barrier {
    let signalReady!: () => void;
    let doRelease!: () => void;
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      doRelease = resolve;
    });
    const done = prismaA.$transaction(
      async (tx) => {
        await hold(tx);
        signalReady();
        await gate;
      },
      { timeout: 60_000, maxWait: 60_000 },
    );
    return { ready, release: () => doRelease(), done };
  }

  function holdMemberAdvisoryLock(memberId: string): Barrier {
    return holdInOwnTransaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${memberId}))::text AS locked`;
    });
  }

  /**
   * 把两个终审事务钉在「已读 before、已写自己那张 Sheet、尚未读 after」这个位置上。
   *
   * 用的是 `audit_logs` 的表级 SHARE 锁:它与 INSERT 需要的 RowExclusiveLock 冲突,
   * 而 finalApprove 恰好在 before 之后、after 之前写一条 audit —— 这是这段代码里
   * 唯一一个「两个事务都必经、且能从外部按住」的点。
   *
   * 没有它,这条用例的红就只是概率:两个事务谁先提交是时序决定的,
   * 只要有一方先提交,另一方的 after 就会读到 5 分并正确发出通知,bug 自己藏起来。
   */
  function holdAuditLogInserts(): Barrier {
    return holdInOwnTransaction(async (tx) => {
      await tx.$executeRawUnsafe('LOCK TABLE "audit_logs" IN SHARE MODE');
    });
  }

  /** 建一名志愿者 + 一条 joining 入队申请(贡献值里程碑挂在申请上)。 */
  async function createCandidate(): Promise<{ memberId: string; applicationId: string }> {
    seq += 1;
    const member = await prismaA.member.create({
      data: {
        memberNo: `AFM${String(seq).padStart(3, '0')}`,
        displayName: `里程碑${seq}`,
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    const cycle = await prismaA.teamJoinCycle.create({
      data: {
        year: CYCLE_YEAR,
        name: `里程碑轮 ${seq}`,
        statusCode: 'closed',
        openedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      select: { id: true },
    });
    const application = await prismaA.teamJoinApplication.create({
      data: {
        cycleId: cycle.id,
        memberId: member.id,
        statusCode: 'joining',
        targetOrganizationIds: [],
      },
      select: { id: true },
    });
    return { memberId: member.id, applicationId: application.id };
  }

  /** 已生效的历史贡献值(approved sheet);每北京日封顶 3,所以一天最多 3 分。 */
  async function giveApprovedContribution(
    memberId: string,
    points: string,
    checkInAt: Date,
  ): Promise<void> {
    const sheet = await prismaA.attendanceSheet.create({
      data: { activityId, submitterUserId, statusCode: 'approved' },
      select: { id: true },
    });
    await prismaA.attendanceRecord.create({
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

  /** 待终审的 Sheet:终审人 ≠ 提交人(22074)且 ≠ 一级审核人(22075)。 */
  async function createPendingFinalReviewSheet(
    memberId: string,
    points: string,
    checkInAt: Date,
  ): Promise<string> {
    const sheet = await prismaA.attendanceSheet.create({
      data: {
        activityId,
        submitterUserId,
        lastSubmittedByUserId: submitterUserId,
        lastSubmittedAt: new Date(),
        reviewerUserId,
        reviewedAt: new Date(),
        statusCode: 'pending_final_review',
        version: 1,
        records: {
          create: [
            {
              memberId,
              roleCode: 'member',
              checkInAt,
              checkOutAt: new Date(checkInAt.getTime() + 3600_000),
              serviceHours: new Prisma.Decimal(1),
              attendanceStatusCode: 'present',
              contributionPoints: new Prisma.Decimal(points),
            },
          ],
        },
      },
      select: { id: true },
    });
    return sheet.id;
  }

  async function countMilestoneIntents(applicationId: string): Promise<number> {
    return prismaA.notificationOutboxIntent.count({
      where: { eventKey: `team-join-contribution-met:${applicationId}:5` },
    });
  }

  beforeAll(async () => {
    appA = await createTestApp();
    appB = await createTestApp();
    await resetDb(appA);
    prismaA = appA.get(PrismaService);
    prismaB = appB.get(PrismaService);
    attendancesA = appA.get(AttendancesService);
    attendancesB = appB.get(AttendancesService);

    const submitter = await prismaA.user.create({
      data: {
        username: 'afm-submitter',
        passwordHash: TEST_PASSWORD_HASH,
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
      },
      select: { id: true },
    });
    submitterUserId = submitter.id;
    const reviewer = await prismaA.user.create({
      data: {
        username: 'afm-reviewer',
        passwordHash: TEST_PASSWORD_HASH,
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
      },
      select: { id: true },
    });
    reviewerUserId = reviewer.id;
    const finalReviewerRow = await prismaA.user.create({
      data: {
        username: 'afm-final-reviewer',
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
      await prismaA.organization.create({
        data: { name: 'AFM Org', nodeTypeCode: 'afm-node' },
        select: { id: true },
      })
    ).id;
    activityId = (
      await prismaA.activity.create({
        data: {
          title: 'AFM Activity',
          activityTypeCode: 'afm-act',
          organizationId,
          startAt: DAY_A,
          endAt: DAY_C,
          location: '深圳',
          statusCode: 'completed',
        },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    await Promise.all([appA.close(), appB.close()]);
  });

  it('两个 app 确实是两条独立连接(否则下面的锁等待全是自欺)', async () => {
    expect(prismaA).not.toBe(prismaB);
    const [[a], [b]] = await Promise.all([
      prismaA.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`,
      prismaB.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`,
    ]);
    expect(a?.pid).not.toBe(b?.pid);
  });

  it(
    '① 结构位:finalApprove 必须在 member 线性化键内读贡献聚合(键被占住时它得等)',
    async () => {
      const { memberId } = await createCandidate();
      await giveApprovedContribution(memberId, '3.00', DAY_A);
      const sheetId = await createPendingFinalReviewSheet(memberId, '1.00', DAY_B);

      const barrier = holdMemberAdvisoryLock(memberId);
      await barrier.ready;

      const approving = attendancesB.finalApprove(sheetId, {}, finalReviewer, META);
      approving.catch(() => undefined);

      // 修复前:finalApprove 只锁自己那张 Sheet,从不碰 member 维度的共同键 ——
      // 这里等不到任何 advisory waiter,直接红。
      let observed = 0;
      try {
        const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
        while (Date.now() < deadline && observed === 0) {
          observed = await countAdvisoryWaiters();
          if (observed === 0) await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally {
        barrier.release();
        await barrier.done;
      }
      await approving;
      expect(observed).toBeGreaterThanOrEqual(1);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    '② 行为位:两张 Sheet 并发终审跨过 5 分阈值 —— 恰好一条 milestone intent,不是零条',
    async () => {
      const { memberId, applicationId } = await createCandidate();
      // 已生效 3 分(封顶 3/北京日,所以单独占一天)。
      await giveApprovedContribution(memberId, '3.00', DAY_A);
      // 两张待终审 Sheet 各 1 分,落在各自独立的北京日 ⇒ 生效后总分 5,恰好首次跨阈值。
      const sheetOne = await createPendingFinalReviewSheet(memberId, '1.00', DAY_B);
      const sheetTwo = await createPendingFinalReviewSheet(memberId, '1.00', DAY_C);

      expect(await countMilestoneIntents(applicationId)).toBe(0);

      // 按住 audit 写入 = 把两个事务钉在 before 与 after 之间,窗口不再靠运气。
      const barrier = holdAuditLogInserts();
      await barrier.ready;

      const firstRun = attendancesA.finalApprove(sheetOne, {}, finalReviewer, META);
      const secondRun = attendancesB.finalApprove(sheetTwo, {}, finalReviewer, META);
      firstRun.catch(() => undefined);
      secondRun.catch(() => undefined);
      try {
        // 修复前:两个都读完 before(各 3 分)才卡在 audit 插入上 → 两个 waiter。
        // 修复后:第一个卡在 audit 插入上,第二个卡在它持有的 member 键上 → 同样两个 waiter。
        const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
        let waiters = 0;
        while (Date.now() < deadline && waiters < 2) {
          waiters = await countAnyLockWaiters();
          if (waiters < 2) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(waiters).toBeGreaterThanOrEqual(2);
      } finally {
        barrier.release();
        await barrier.done;
      }
      const [first, second] = await Promise.allSettled([firstRun, secondRun]);
      expect(first.status).toBe('fulfilled');
      expect(second.status).toBe('fulfilled');

      // 修复前:两个事务各读 before=3、各算 after=4,谁都不 enqueue → 0 条,通知永久丢失。
      expect(await countMilestoneIntents(applicationId)).toBe(1);

      // 正式总分确实是 5(否则上面那条断言是在证明一个不成立的前提)。
      const records = await prismaA.attendanceRecord.findMany({
        where: { memberId, deletedAt: null, sheet: { statusCode: 'approved', deletedAt: null } },
        select: { contributionPoints: true },
      });
      const total = records.reduce(
        (sum, record) => sum.add(record.contributionPoints ?? new Prisma.Decimal(0)),
        new Prisma.Decimal(0),
      );
      expect(total.toString()).toBe('5');
    },
    CASE_TIMEOUT_MS,
  );
});
