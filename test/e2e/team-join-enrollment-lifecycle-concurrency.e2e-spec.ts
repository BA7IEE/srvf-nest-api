import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { AppMeTeamJoinService } from '../../src/modules/team-join/team-join-applications.app.service';
import { TeamJoinEnrollmentService } from '../../src/modules/team-join/team-join-enrollment.service';
import { TEST_PASSWORD_HASH } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 并发审计 K2(B-F4 + B-F5):入队生命周期两头都没收口 ——
// - F4:`submit` 只用普通读判「未入队」,随后向 Application 建行;并发 final join 在这两步之间
//   把该 Member 变成正式队员,于是**写入发生时已经是队员**,却仍新增了一条进行中申请。
// - F5:final join 只终结目标那一条申请,同 Member 的其它 live 申请留成 frozen ——
//   evaluate 还能把它推到 approved,而 final join 从此永远 28210,再无终态通路。
//
// 两条必须一起修:只修 submit 挡不住「submit 先、join 后」这条合法顺序留下的残留;
// 只修 F5 挡不住「join 先、submit 后」新增的那一条。
//
// barrier 手法:blocker 占住 **Member 行锁**(final join 的 `lockMemberLifecycle` 必经),
// 把 final join 钉在「已认领申请、尚未写队员身份」的位置上;此时再发起 submit。
// 修复前 submit 不取任何锁,一路建行;修复后它必须在 member 线性化键上等 final join。

const META: AuditMeta = {
  requestId: 'team-join-enrollment-lifecycle-concurrency',
  ip: '127.0.0.1',
  ua: 'jest/team-join-enrollment-lifecycle-concurrency',
};
// 被测的是**生产事务**,它用 Prisma 默认 5s 交互事务预算 —— barrier 窗口内的等待必须
// 远小于它,否则用例会以 P2028(事务过期)红,而不是以被测行为红。
const LOCK_WAIT_TIMEOUT_MS = 1_500;
const CASE_TIMEOUT_MS = 60_000;
const CYCLE_YEAR = 2026;
// cutoff = 2026-04-01 00:00 +08:00;贡献值记录必须落在它之前才计入本轮。
const BEFORE_CUTOFF = new Date('2026-01-15T00:00:00.000Z');

const GENERAL_GATES = [
  'fitness',
  'first-aid-training',
  'military',
  'psych',
  'interview',
  'dept-assessment',
  'entry-exam',
  'intermediate-outdoor',
] as const;

const LIVE_APPLICATION_STATUSES = ['joining', 'pending_evaluation', 'approved'];

describe('team join submit × final join 生命周期并发(K2 · B-F4/B-F5)', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let enrollmentA: TeamJoinEnrollmentService;
  let appMeB: AppMeTeamJoinService;
  let admin: CurrentUserPayload;
  let adminUserId: string;
  let orgSeq = 0;
  let memberSeq = 0;

  async function countWaiters(pattern: string): Promise<number> {
    const [row] = await prismaB.$queryRaw<Array<{ n: number }>>(Prisma.sql`
      SELECT count(*)::int AS n
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND query LIKE ${pattern}
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

  async function waitForMemberRowLockWaiter(): Promise<void> {
    const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if ((await countWaiters('%FROM "Member"%FOR UPDATE%')) >= 1) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('expected a Member row-lock waiter(final join 没有停在 lockMemberLifecycle)');
  }

  /**
   * 等 submit 到达确定性推进点(此刻 final join 已经是第 1 个 waiter,所以门槛是 **2**):
   * - 修复前:submit 既不复核队员身份也不取线性化键,一路跑到 `INSERT`,才被 Member 的
   *   FK `FOR KEY SHARE` 挡在 blocker 的 `FOR UPDATE` 上 —— 它读到的「未入队」早已是旧事实,
   *   醒来后照样建行。
   * - 修复后:submit 一进事务就取 member 线性化键,在**读之前**就被 final join 挡住。
   * 两种都表现为「出现第 2 个 waiter」,不用 sleep;submit 万一直接跑完也放行。
   */
  async function untilSubmitParked(pending: Promise<unknown>): Promise<void> {
    let settled = false;
    const mark = (): void => {
      settled = true;
    };
    pending.then(mark, mark);
    const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (settled) return;
      if ((await countAnyLockWaiters()) >= 2) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('submit 既未完成,也没有进入锁等待');
  }

  function holdMemberRowLock(memberId: string): {
    ready: Promise<void>;
    release: () => void;
    done: Promise<void>;
  } {
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
        await tx.$queryRaw`SELECT "id" FROM "Member" WHERE "id" = ${memberId} FOR UPDATE`;
        signalReady();
        await gate;
      },
      { timeout: 60_000, maxWait: 60_000 },
    );
    return { ready, release: () => doRelease(), done };
  }

  /**
   * §DoD 全库不变量:已入队(存在 joined 申请)的队员名下不得再有 live 申请。
   * 这正是 B-F5 说的「frozen approved 行」—— 它没有任何现存终态通路。
   */
  async function assertNoLiveApplicationForEnrolledMember(): Promise<void> {
    const rows = await prismaA.$queryRaw<Array<{ id: string; memberId: string; status: string }>>(
      Prisma.sql`
        SELECT live."id", live."memberId", live."statusCode" AS status
        FROM "team_join_applications" live
        WHERE live."deletedAt" IS NULL
          AND live."statusCode" = ANY(${LIVE_APPLICATION_STATUSES})
          AND EXISTS (
            SELECT 1 FROM "team_join_applications" joined
            WHERE joined."memberId" = live."memberId"
              AND joined."deletedAt" IS NULL
              AND joined."statusCode" = 'joined'
          )
      `,
    );
    expect(rows).toEqual([]);
  }

  async function makeOrg(): Promise<string> {
    orgSeq += 1;
    const org = await prismaA.organization.create({
      data: { name: `TJC 部门${orgSeq}`, nodeTypeCode: 'tjc-node', status: 'ACTIVE' },
      select: { id: true },
    });
    return org.id;
  }

  /** legacy 口径的「未入队志愿者」:gradeCode=null + 零部门。附一个可用 App 的账号。 */
  async function createVolunteerWithAccount(): Promise<{
    memberId: string;
    user: CurrentUserPayload;
  }> {
    memberSeq += 1;
    const member = await prismaA.member.create({
      data: {
        memberNo: `TJC${String(memberSeq).padStart(3, '0')}`,
        displayName: `入队并发${memberSeq}`,
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    const user = await prismaA.user.create({
      data: {
        username: `tjc-volunteer-${memberSeq}`,
        passwordHash: TEST_PASSWORD_HASH,
        role: Role.USER,
        status: UserStatus.ACTIVE,
        memberId: member.id,
      },
      select: { id: true, username: true },
    });
    return {
      memberId: member.id,
      user: {
        id: user.id,
        username: user.username,
        role: Role.USER,
        status: UserStatus.ACTIVE,
        memberId: member.id,
      },
    };
  }

  /** 贡献值:每北京日封顶 3,故 5 分摊成 3 + 2 两天,且都落在 cutoff 之前。 */
  async function giveContribution(memberId: string, points: string[]): Promise<void> {
    const organizationId = await makeOrg();
    const activity = await prismaA.activity.create({
      data: {
        title: 'TJC 贡献值活动',
        activityTypeCode: 'tjc-act',
        organizationId,
        startAt: BEFORE_CUTOFF,
        endAt: BEFORE_CUTOFF,
        location: '深圳',
        statusCode: 'completed',
      },
      select: { id: true },
    });
    const sheet = await prismaA.attendanceSheet.create({
      data: { activityId: activity.id, submitterUserId: adminUserId, statusCode: 'approved' },
      select: { id: true },
    });
    for (const [index, value] of points.entries()) {
      const checkInAt = new Date(BEFORE_CUTOFF.getTime() - index * 86_400_000);
      await prismaA.attendanceRecord.create({
        data: {
          sheetId: sheet.id,
          memberId,
          roleCode: 'member',
          checkInAt,
          checkOutAt: new Date(checkInAt.getTime() + 4 * 3600_000),
          serviceHours: '4.00',
          attendanceStatusCode: 'present',
          contributionPoints: value,
        },
      });
    }
  }

  function allGatesPassed(): Prisma.InputJsonValue {
    const nowIso = new Date().toISOString();
    return Object.fromEntries(
      GENERAL_GATES.map((gate) => [
        gate,
        { at: nowIso, by: adminUserId, passed: true, completionDate: nowIso },
      ]),
    );
  }

  /** 关掉所有 open 轮(至多一个 open 的 partial unique),再开一个新轮。 */
  async function openCycle(name: string): Promise<string> {
    await prismaA.teamJoinCycle.updateMany({
      where: { statusCode: 'open' },
      data: { statusCode: 'closed', closedAt: new Date() },
    });
    const cycle = await prismaA.teamJoinCycle.create({
      data: { year: CYCLE_YEAR, name, statusCode: 'open', openedAt: new Date() },
      select: { id: true },
    });
    return cycle.id;
  }

  async function closeCycle(cycleId: string): Promise<void> {
    await prismaA.teamJoinCycle.update({
      where: { id: cycleId },
      data: { statusCode: 'closed', closedAt: new Date() },
    });
  }

  beforeAll(async () => {
    appA = await createTestApp();
    appB = await createTestApp();
    await resetDb(appA);
    prismaA = appA.get(PrismaService);
    prismaB = appB.get(PrismaService);
    enrollmentA = appA.get(TeamJoinEnrollmentService);
    appMeB = appB.get(AppMeTeamJoinService);

    const adminRow = await prismaA.user.create({
      data: {
        username: 'tjc-super-admin',
        passwordHash: TEST_PASSWORD_HASH,
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      },
      select: { id: true, username: true },
    });
    adminUserId = adminRow.id;
    admin = {
      id: adminRow.id,
      username: adminRow.username,
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      memberId: null,
    };

    // 一键入队写 gradeCode='level-1',依赖 member_grade 字典(resetDb 已 truncate)。
    const gradeType = await prismaA.dictType.create({
      data: { code: 'member_grade', label: '队员级别' },
      select: { id: true },
    });
    await prismaA.dictItem.create({
      data: { typeId: gradeType.id, code: 'level-1', label: '级别 1' },
    });
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
    'B-F4:final join 正在写队员身份时并发 submit —— 新一轮申请必须被 28210 拒,不得在已入队后新增',
    async () => {
      const { memberId, user } = await createVolunteerWithAccount();
      const targetOrg = await makeOrg();
      const newRoundOrg = await makeOrg();
      await giveContribution(memberId, ['3.00', '2.00']);

      const oldCycleId = await openCycle('旧轮');
      const approved = await prismaA.teamJoinApplication.create({
        data: {
          cycleId: oldCycleId,
          memberId,
          statusCode: 'approved',
          targetOrganizationIds: [targetOrg],
          gateMarks: allGatesPassed(),
          evaluatedByUserId: adminUserId,
          evaluatedAt: new Date(),
        },
        select: { id: true },
      });
      await closeCycle(oldCycleId);
      await openCycle('新轮');

      const barrier = holdMemberRowLock(memberId);
      await barrier.ready;

      const joining = enrollmentA.join(
        approved.id,
        { organizationId: targetOrg },
        admin,
        META,
        new Date(),
      );
      // 先挂上吞掉的 handler:barrier 内任何一步抛出时这些 promise 还没被 await,
      // 未处理的 rejection 会把整个 jest worker 打死,红的原因就看不见了。
      joining.catch(() => undefined);
      let submitting: Promise<unknown> = Promise.resolve();
      try {
        // 必须等 final join 真的停在 Member 行锁上再发 submit:否则 submit 可能抢先跑完,
        // 那是另一条(合法的)顺序,不是 F4 要复现的交错。
        await waitForMemberRowLockWaiter();
        submitting = appMeB.submit(
          { targetOrganizationIds: [newRoundOrg] },
          user,
          META,
          new Date(),
        );
        submitting.catch(() => undefined);
        await untilSubmitParked(submitting);
      } finally {
        barrier.release();
        await barrier.done;
      }
      const [joinResult, submitResult] = await Promise.allSettled([joining, submitting]);

      // 修复前:submit 全程无锁,在 join 尚未提交时读到「未入队」并建行 ——
      // 提交后该 Member 已是正式队员,名下却多出一条 joining 申请。
      expect(joinResult.status).toBe('fulfilled');
      expect(submitResult.status).toBe('rejected');
      const reason = submitResult.status === 'rejected' ? submitResult.reason : undefined;
      expect(reason).toBeInstanceOf(BizException);
      expect((reason as BizException).biz).toBe(BizCode.TEAM_JOIN_MEMBER_ALREADY_ENROLLED);

      expect(
        await prismaA.teamJoinApplication.count({
          where: { memberId, deletedAt: null, statusCode: { in: LIVE_APPLICATION_STATUSES } },
        }),
      ).toBe(0);
      expect(
        (
          await prismaA.member.findUniqueOrThrow({
            where: { id: memberId },
            select: { gradeCode: true },
          })
        ).gradeCode,
      ).toBe('level-1');
      await assertNoLiveApplicationForEnrolledMember();
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'B-F5:final join 必须同事务终结同 Member 其它 live 申请(不需要并发也能复现)',
    async () => {
      const { memberId } = await createVolunteerWithAccount();
      const targetOrg = await makeOrg();
      const newRoundOrg = await makeOrg();
      await giveContribution(memberId, ['3.00', '2.00']);

      const oldCycleId = await openCycle('旧轮 F5');
      const approved = await prismaA.teamJoinApplication.create({
        data: {
          cycleId: oldCycleId,
          memberId,
          statusCode: 'approved',
          targetOrganizationIds: [targetOrg],
          gateMarks: allGatesPassed(),
          evaluatedByUserId: adminUserId,
          evaluatedAt: new Date(),
        },
        select: { id: true },
      });
      await closeCycle(oldCycleId);

      // 新轮里这名志愿者又发起了一条申请(合法顺序:submit 先、join 后)。
      const newCycleId = await openCycle('新轮 F5');
      const leftover = await prismaA.teamJoinApplication.create({
        data: {
          cycleId: newCycleId,
          memberId,
          statusCode: 'joining',
          targetOrganizationIds: [newRoundOrg],
        },
        select: { id: true },
      });

      await enrollmentA.join(approved.id, { organizationId: targetOrg }, admin, META, new Date());

      // 修复前:join 只把目标申请改成 joined,这条 joining 原封不动留着 ——
      // 它还能被 evaluate 推到 approved,而 final join 从此永远 28210,成为死行。
      const leftoverAfter = await prismaA.teamJoinApplication.findUniqueOrThrow({
        where: { id: leftover.id },
        select: { statusCode: true, eliminationStage: true },
      });
      expect(leftoverAfter.statusCode).toBe('rejected');
      expect(leftoverAfter.eliminationStage).toBe('already-enrolled');
      expect(
        await prismaA.auditLog.count({
          where: { resourceId: leftover.id, event: 'team-join-application.supersede' },
        }),
      ).toBe(1);
      await assertNoLiveApplicationForEnrolledMember();
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'B-F5 边界:关轮不使 approved 失效 —— 终结的只是「已入队后」的同人残留,不是关轮本身',
    async () => {
      const { memberId } = await createVolunteerWithAccount();
      const targetOrg = await makeOrg();
      await giveContribution(memberId, ['3.00', '2.00']);

      const cycleId = await openCycle('关轮边界');
      const approved = await prismaA.teamJoinApplication.create({
        data: {
          cycleId,
          memberId,
          statusCode: 'approved',
          targetOrganizationIds: [targetOrg],
          gateMarks: allGatesPassed(),
          evaluatedByUserId: adminUserId,
          evaluatedAt: new Date(),
        },
        select: { id: true },
      });
      await closeCycle(cycleId);

      // handoff/admin-web.md:528 —— 轮关闭不撤销 approved 资格,一键入队仍必须成功。
      await enrollmentA.join(approved.id, { organizationId: targetOrg }, admin, META, new Date());

      expect(
        (
          await prismaA.teamJoinApplication.findUniqueOrThrow({
            where: { id: approved.id },
            select: { statusCode: true },
          })
        ).statusCode,
      ).toBe('joined');
      await assertNoLiveApplicationForEnrolledMember();
    },
    CASE_TIMEOUT_MS,
  );
});
