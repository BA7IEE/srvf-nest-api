import type { INestApplication } from '@nestjs/common';
import { Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityRegistrationsService } from '../../src/modules/activity-registrations/activity-registrations.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { AttendancesService } from '../../src/modules/attendances/attendances.service';
import type {
  AttendanceRecordInputDto,
  UpdateAttendanceSheetDto,
} from '../../src/modules/attendances/attendances.dto';
import { TEST_PASSWORD_HASH } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 并发审计 K1(A-R1 = B-F1 双确认 · A-Y1 · B-Y1):
// Admin 面的考勤单写路径此前把 Activity 聚合锁绑在 `managedActivityId !== undefined`
// 分支里(第七种形状 S7),Admin 分支既不取 Activity 锁、也不认领 registration ——
// 于是「Admin 编辑考勤单新增一名队员」与「取消该队员的 pass 报名」可以交错成
// **cancelled 报名 + live 考勤记录**,而这正是 21033 守卫存在的目的。
//
// 为什么必须真双连接:被修的缺陷是「读到 registration 是 pass」与「把引用它的 record
// 写进库」之间的窗口。串行调用走不进那个窗口,mock 里根本没有窗口。
//
// 撑开窗口的手法:blocker 占住 `TimeOverlapPolicy.lockMembersForOverlapCheck` 用的
// **member advisory 锁**(`pg_advisory_xact_lock(hashtext(memberId))`)。
// 它恰好位于「批量校验读 registration」之后、「createMany 写 record」之前 ——
// 修复前后 edit 都会走到这里,所以同一个 barrier 对红绿两侧都成立。
//
// 每条用例都标注了**修复前**的表现,那是这些断言存在的理由。

const META: AuditMeta = {
  requestId: 'attendance-admin-edit-registration-concurrency',
  ip: '127.0.0.1',
  ua: 'jest/attendance-admin-edit-registration-concurrency',
};
const WAIT_TIMEOUT_MS = 15_000;
const CASE_TIMEOUT_MS = 60_000;

const ACTIVITY_TYPE = 'aaerc-demo';
const ROLE_MEMBER = 'member';
const STATUS_PRESENT = 'present';

// 活动窗固定在过去:考勤 record 的 `checkOutAt` 必须 <= 服务端 now(22079),
// 用未来时间会让整组用例永远拿不到合法 record。过去的日期只会越来越过去,不会腐烂。
const ACTIVITY_START = new Date('2026-01-02T01:00:00.000Z');
const ACTIVITY_END = new Date('2026-01-02T09:00:00.000Z');

interface Barrier {
  ready: Promise<void>;
  release: () => void;
  done: Promise<void>;
}

describe('attendance Admin edit(records) × 报名取消 并发(K1 · A-R1/B-F1)', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let attendancesB: AttendancesService;
  let registrationsA: ActivityRegistrationsService;
  let admin: CurrentUserPayload;

  let activityId: string;
  let seq = 0;

  /** 等到确实有连接卡在 advisory 锁上 —— sleep 要么不够(假绿)要么太长。 */
  async function waitForAdvisoryLockWaiter(): Promise<void> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const [row] = await prismaB.$queryRaw<Array<{ n: number }>>(Prisma.sql`
        SELECT count(*)::int AS n
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND wait_event = 'advisory'
      `);
      if ((row?.n ?? 0) >= 1) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('expected at least 1 advisory lock waiter');
  }

  async function countActivityRowLockWaiters(): Promise<number> {
    const [row] = await prismaB.$queryRaw<Array<{ n: number }>>(Prisma.sql`
      SELECT count(*)::int AS n
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND query LIKE '%FROM "Activity"%FOR UPDATE%'
    `);
    return row?.n ?? 0;
  }

  /** 轮询到出现 Activity 行锁 waiter 为止;返回观察到的数量(超时返回 0)。 */
  async function pollActivityRowLockWaiter(): Promise<number> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const observed = await countActivityRowLockWaiters();
      if (observed > 0) return observed;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return 0;
  }

  /**
   * 等到取消操作到达一个**确定性**的推进点:
   * - 修复前:Admin edit 不持 Activity 锁,取消一路跑完并提交 → `settled`。
   * - 修复后:Admin edit 无条件持 Activity `FOR UPDATE`,取消卡在该行锁上 → 观察到 waiter。
   * 两条分支都不靠 sleep;都没到就是环境异常,直接抛。
   */
  async function untilSettledOrBlockedOnActivity(pending: Promise<unknown>): Promise<void> {
    let settled = false;
    const mark = (): void => {
      settled = true;
    };
    pending.then(mark, mark);
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (settled) return;
      if ((await countActivityRowLockWaiters()) >= 1) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('取消既未完成,也没有卡在 Activity 行锁上');
  }

  /** 在自己的事务里占住 member advisory 锁,直到调用方放行。 */
  function holdMemberAdvisoryLock(memberId: string): Barrier {
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
        // ::text 与生产侧 `TimeOverlapPolicy` 同款:Prisma 反序列化不了 `void` 列。
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${memberId}))::text AS locked`;
        signalReady();
        await gate;
      },
      { timeout: 60_000, maxWait: 60_000 },
    );
    return { ready, release: () => doRelease(), done };
  }

  /** 在自己的事务里占住 Activity 行锁,直到调用方放行。 */
  function holdActivityRowLock(id: string): Barrier {
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
        await tx.$queryRaw`SELECT id FROM "Activity" WHERE id = ${id} FOR UPDATE`;
        signalReady();
        await gate;
      },
      { timeout: 60_000, maxWait: 60_000 },
    );
    return { ready, release: () => doRelease(), done };
  }

  /**
   * §DoD 全库不变量:任何 live 考勤记录都不得挂在非 pass / 已软删的报名上。
   * 这正是 `attendances/CLAUDE.md`「禁止留下 cancelled + live record」与
   * `docs/handoff/admin-web.md:80` 的 21033 承诺所声明的那条不变式。
   */
  async function assertNoLiveRecordUnderDeadRegistration(): Promise<void> {
    const rows = await prismaA.attendanceRecord.findMany({
      where: {
        deletedAt: null,
        registrationId: { not: null },
        OR: [
          { registration: { statusCode: { not: 'pass' } } },
          { registration: { deletedAt: { not: null } } },
        ],
      },
      select: { id: true, registrationId: true },
    });
    expect(rows).toEqual([]);
  }

  async function createMemberWithPassRegistration(): Promise<{
    memberId: string;
    registrationId: string;
  }> {
    seq += 1;
    const member = await prismaA.member.create({
      data: { memberNo: `aaerc-${seq}`, displayName: `并发考勤${seq}` },
      select: { id: true },
    });
    const registration = await prismaA.activityRegistration.create({
      data: { activityId, memberId: member.id, statusCode: 'pass' },
      select: { id: true },
    });
    return { memberId: member.id, registrationId: registration.id };
  }

  function record(memberId: string, registrationId?: string): AttendanceRecordInputDto {
    return {
      memberId,
      roleCode: ROLE_MEMBER,
      checkInAt: '2026-01-02T02:00:00.000Z',
      checkOutAt: '2026-01-02T05:00:00.000Z',
      attendanceStatusCode: STATUS_PRESENT,
      ...(registrationId === undefined ? {} : { registrationId }),
    };
  }

  /** 直接落一张 pending Sheet + 一条占位 record(留给 edit 去替换)。 */
  async function createPendingSheet(placeholderMemberId: string): Promise<string> {
    const sheet = await prismaA.attendanceSheet.create({
      data: {
        activityId,
        submitterUserId: admin.id,
        lastSubmittedByUserId: admin.id,
        lastSubmittedAt: new Date(),
        statusCode: 'pending',
        version: 1,
        records: {
          create: [
            {
              memberId: placeholderMemberId,
              roleCode: ROLE_MEMBER,
              checkInAt: new Date('2026-01-02T06:00:00.000Z'),
              checkOutAt: new Date('2026-01-02T07:00:00.000Z'),
              serviceHours: new Prisma.Decimal(1),
              attendanceStatusCode: STATUS_PRESENT,
              contributionPoints: new Prisma.Decimal(0),
            },
          ],
        },
      },
      select: { id: true },
    });
    return sheet.id;
  }

  beforeAll(async () => {
    appA = await createTestApp();
    appB = await createTestApp();
    await resetDb(appA);
    prismaA = appA.get(PrismaService);
    prismaB = appB.get(PrismaService);
    attendancesB = appB.get(AttendancesService);
    registrationsA = appA.get(ActivityRegistrationsService);

    const adminRow = await prismaA.user.create({
      data: {
        username: 'aaerc-super-admin',
        passwordHash: TEST_PASSWORD_HASH,
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      },
      select: { id: true, username: true },
    });
    admin = {
      id: adminRow.id,
      username: adminRow.username,
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      memberId: null,
    };

    const organizationId = (
      await prismaA.organization.create({
        data: { name: 'AAERC Org', nodeTypeCode: 'team' },
        select: { id: true },
      })
    ).id;

    const roleDict = await prismaA.dictType.create({
      data: { code: 'attendance_role', label: '考勤角色' },
      select: { id: true },
    });
    await prismaA.dictItem.create({
      data: { typeId: roleDict.id, code: ROLE_MEMBER, label: '队员' },
    });
    const statusDict = await prismaA.dictType.create({
      data: { code: 'attendance_status', label: '考勤状态' },
      select: { id: true },
    });
    await prismaA.dictItem.create({
      data: { typeId: statusDict.id, code: STATUS_PRESENT, label: '出勤' },
    });

    activityId = (
      await prismaA.activity.create({
        data: {
          title: 'AAERC Activity',
          activityTypeCode: ACTIVITY_TYPE,
          organizationId,
          startAt: ACTIVITY_START,
          endAt: ACTIVITY_END,
          location: '深圳',
          statusCode: 'published',
          isPublicRegistration: true,
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
    'Admin edit 新增队员 vs 取消其 pass 报名:取消必须被 21033 拒,不得留下 cancelled 报名 + live 记录',
    async () => {
      const placeholder = await createMemberWithPassRegistration();
      const target = await createMemberWithPassRegistration();
      const sheetId = await createPendingSheet(placeholder.memberId);

      // barrier 占住 target 的 member advisory 锁 —— edit 读完 registration、写 record 之前
      // 必然停在这里。
      const barrier = holdMemberAdvisoryLock(target.memberId);
      await barrier.ready;

      const dto: UpdateAttendanceSheetDto = {
        records: [record(target.memberId, target.registrationId)],
      };
      const editing = attendancesB.edit(sheetId, dto, admin, META);
      await waitForAdvisoryLockWaiter();

      // 此刻 edit 已经把 target 的报名读成 pass,但一条 record 都还没落库。
      const cancelling = registrationsA.cancelAdmin(
        activityId,
        target.registrationId,
        { cancelReason: '并发取消' },
        admin,
        META,
      );
      await untilSettledOrBlockedOnActivity(cancelling);

      barrier.release();
      await barrier.done;
      const [editResult, cancelResult] = await Promise.allSettled([editing, cancelling]);

      // 修复前:edit 既不取 Activity 锁也不认领 registration,取消一路跑完并提交;
      // edit 醒来后按锁前快照 createMany —— 终局是 cancelled 报名 + live 考勤记录,
      // 且此后再也取消不掉(21033 反向自锁)。
      expect(editResult.status).toBe('fulfilled');
      expect(cancelResult.status).toBe('rejected');
      const reason = cancelResult.status === 'rejected' ? cancelResult.reason : undefined;
      expect(reason).toBeInstanceOf(BizException);
      expect((reason as BizException).biz).toBe(BizCode.ACTIVITY_REGISTRATION_HAS_ATTENDANCE);

      expect(
        await prismaA.activityRegistration.findUniqueOrThrow({
          where: { id: target.registrationId },
          select: { statusCode: true, cancelledAt: true },
        }),
      ).toEqual({ statusCode: 'pass', cancelledAt: null });
      expect(
        await prismaA.attendanceRecord.count({
          where: { registrationId: target.registrationId, deletedAt: null },
        }),
      ).toBe(1);
      await assertNoLiveRecordUnderDeadRegistration();
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'Admin edit 的 Activity 聚合锁是无条件取的:Activity 行锁被占住时必须等待,而不是径直提交',
    async () => {
      const placeholder = await createMemberWithPassRegistration();
      const target = await createMemberWithPassRegistration();
      const sheetId = await createPendingSheet(placeholder.memberId);

      const barrier = holdActivityRowLock(activityId);
      await barrier.ready;

      const dto: UpdateAttendanceSheetDto = {
        records: [record(target.memberId, target.registrationId)],
      };
      const editing = attendancesB.edit(sheetId, dto, admin, META);

      // 修复前:Admin 分支根本不取 Activity 锁,这里等不到任何 waiter → 直接红。
      const observed = await pollActivityRowLockWaiter();
      barrier.release();
      await barrier.done;
      await editing;
      expect(observed).toBeGreaterThanOrEqual(1);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'Admin softDelete 同样无条件取 Activity 聚合锁(A-Y1:与 edit/resubmit 三写法收敛为一种)',
    async () => {
      const placeholder = await createMemberWithPassRegistration();
      const sheetId = await createPendingSheet(placeholder.memberId);

      const barrier = holdActivityRowLock(activityId);
      await barrier.ready;

      const removing = attendancesB.softDelete(sheetId, admin, META);

      // 修复前:softDelete 的 Activity 锁同样只在 managed 分支内,Admin 面裸奔 ——
      // 于是并发取消可能读到本事务未提交的 live records 而误报 21033。
      const observed = await pollActivityRowLockWaiter();
      barrier.release();
      await barrier.done;
      await removing;
      expect(observed).toBeGreaterThanOrEqual(1);

      expect(
        (
          await prismaA.attendanceSheet.findUniqueOrThrow({
            where: { id: sheetId },
            select: { deletedAt: true },
          })
        ).deletedAt,
      ).not.toBeNull();
    },
    CASE_TIMEOUT_MS,
  );
});
