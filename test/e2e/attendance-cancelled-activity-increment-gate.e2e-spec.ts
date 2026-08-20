import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { AttendancesService } from '../../src/modules/attendances/attendances.service';
import type {
  AttendanceRecordInputDto,
  CreateAttendanceSheetDto,
  UpdateAttendanceSheetDto,
} from '../../src/modules/attendances/attendances.dto';
import { TEST_PASSWORD_HASH } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

// A-R2 拍板落地(2026-07-31,**方案乙:放行存量、掐断增量**)。
//
// 修复前的事实:`activities.cancel` 只把 pending/waitlisted 报名改 cancelled,**完全不碰考勤单**;
// 而 `submit` 之外的九个考勤写方法从不读 `Activity.statusCode` —— 已取消活动上的考勤单
// 能一路走完审批、结算服务时长与贡献值,并喂进入队门槛。这条不需要并发就能到达。
//
// 拍板的语义是**两半**,少一半都不是方案乙,所以两半都得有执行位:
//   放行存量:活动取消前已提交的考勤单,仍能 approve → finalApprove 并结算贡献值(工是真做了的)。
//   掐断增量:活动取消后不得再新建考勤单(既有 20122),也不得改写既有单的 records
//            —— 那是贡献值仅剩的另一条增量来源。
//
// 本 spec 是单连接的:被测的是状态闸,不是竞态。并发面由 K1 的 Activity 聚合锁承担
// (edit 持 `FOR UPDATE`,cancel 必须排队,挤不进这道闸旁边)。

const META: AuditMeta = {
  requestId: 'attendance-cancelled-activity-increment-gate',
  ip: '127.0.0.1',
  ua: 'jest/attendance-cancelled-activity-increment-gate',
};

const ROLE_MEMBER = 'member';
const STATUS_PRESENT = 'present';
// 考勤 record 的 checkOutAt 必须 <= 服务端 now,所以活动窗固定在过去(只会越来越过去,不腐烂)。
const ACTIVITY_START = new Date('2026-01-03T01:00:00.000Z');
const ACTIVITY_END = new Date('2026-01-03T09:00:00.000Z');

describe('已取消活动的考勤增量闸(A-R2 · 方案乙)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let attendances: AttendancesService;
  let submitter: CurrentUserPayload;
  let reviewer: CurrentUserPayload;
  let finalReviewer: CurrentUserPayload;
  let organizationId: string;
  let seq = 0;

  function record(memberId: string): AttendanceRecordInputDto {
    return {
      memberId,
      roleCode: ROLE_MEMBER,
      checkInAt: '2026-01-03T02:00:00.000Z',
      checkOutAt: '2026-01-03T05:00:00.000Z',
      attendanceStatusCode: STATUS_PRESENT,
    };
  }

  async function createMember(): Promise<string> {
    seq += 1;
    const member = await prisma.member.create({
      data: {
        memberNo: `ACG${String(seq).padStart(3, '0')}`,
        ...memberIdentityData(`取消闸${seq}`),
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    return member.id;
  }

  async function createPublishedActivity(): Promise<string> {
    seq += 1;
    const activity = await prisma.activity.create({
      data: {
        title: `ACG 活动${seq}`,
        activityTypeCode: 'acg-act',
        organizationId,
        startAt: ACTIVITY_START,
        endAt: ACTIVITY_END,
        location: '深圳',
        statusCode: 'published',
        isPublicRegistration: true,
      },
      select: { id: true },
    });
    return activity.id;
  }

  /** 直接把活动置 cancelled —— 本 spec 测的是考勤侧的闸,不是 activities.cancel 的编排。 */
  async function cancelActivity(activityId: string): Promise<void> {
    await prisma.activity.update({
      where: { id: activityId },
      data: { statusCode: 'cancelled' },
    });
  }

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    attendances = app.get(AttendancesService);

    const make = async (username: string, role: Role): Promise<CurrentUserPayload> => {
      const row = await prisma.user.create({
        data: { username, passwordHash: TEST_PASSWORD_HASH, role, status: UserStatus.ACTIVE },
        select: { id: true, username: true },
      });
      return {
        id: row.id,
        username: row.username,
        role,
        status: UserStatus.ACTIVE,
        memberId: null,
      };
    };
    submitter = await make('acg-submitter', Role.SUPER_ADMIN);
    reviewer = await make('acg-reviewer', Role.SUPER_ADMIN);
    finalReviewer = await make('acg-final-reviewer', Role.SUPER_ADMIN);

    organizationId = (
      await prisma.organization.create({
        data: { name: 'ACG Org', nodeTypeCode: 'acg-node' },
        select: { id: true },
      })
    ).id;

    const roleDict = await prisma.dictType.create({
      data: { code: 'attendance_role', label: '考勤角色' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: roleDict.id, code: ROLE_MEMBER, label: '队员' },
    });
    const statusDict = await prisma.dictType.create({
      data: { code: 'attendance_status', label: '考勤状态' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: statusDict.id, code: STATUS_PRESENT, label: '出勤' },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('放行存量:取消前已提交的考勤单仍能走完 approve → finalApprove 并结算贡献值', async () => {
    const activityId = await createPublishedActivity();
    const memberId = await createMember();
    const dto: CreateAttendanceSheetDto = { records: [record(memberId)] };
    const sheet = await attendances.submit(activityId, dto, submitter, META);

    await cancelActivity(activityId);

    // 拍板的「放行」这一半:工是真做了的,不因活动取消而作废。
    await attendances.approve(sheet.id, {}, reviewer, META);
    await attendances.finalApprove(sheet.id, {}, finalReviewer, META);

    const after = await prisma.attendanceSheet.findUniqueOrThrow({
      where: { id: sheet.id },
      select: { statusCode: true },
    });
    expect(after.statusCode).toBe('approved');
    expect(
      await prisma.attendanceRecord.count({ where: { sheetId: sheet.id, deletedAt: null } }),
    ).toBe(1);
  });

  it('掐断增量①:已取消活动不得新建考勤单(既有 20122 闸)', async () => {
    const activityId = await createPublishedActivity();
    const memberId = await createMember();
    await cancelActivity(activityId);

    const dto: CreateAttendanceSheetDto = { records: [record(memberId)] };
    await expect(attendances.submit(activityId, dto, submitter, META)).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN,
    });
    expect(await prisma.attendanceSheet.count({ where: { activityId } })).toBe(0);
  });

  it('掐断增量②:已取消活动不得再改写既有考勤单的 records —— 修复前这里能把新队员写进去', async () => {
    const activityId = await createPublishedActivity();
    const memberId = await createMember();
    const sheet = await attendances.submit(
      activityId,
      { records: [record(memberId)] },
      submitter,
      META,
    );
    await cancelActivity(activityId);

    const newcomer = await createMember();
    const editDto: UpdateAttendanceSheetDto = {
      records: [record(memberId), record(newcomer)],
    };
    const editing = attendances.edit(sheet.id, editDto, submitter, META);
    await expect(editing).rejects.toBeInstanceOf(BizException);
    await expect(editing).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN,
    });

    // 整个事务回滚:records 与 version 都不动。
    const [records, after] = await Promise.all([
      prisma.attendanceRecord.findMany({
        where: { sheetId: sheet.id, deletedAt: null },
        select: { memberId: true },
      }),
      prisma.attendanceSheet.findUniqueOrThrow({
        where: { id: sheet.id },
        select: { version: true },
      }),
    ]);
    expect(records).toEqual([{ memberId }]);
    expect(after.version).toBe(1);
  });

  it('闸只拦 cancelled:completed 活动的既有考勤单照旧可编辑(不扩大到别的状态)', async () => {
    const activityId = await createPublishedActivity();
    const memberId = await createMember();
    const sheet = await attendances.submit(
      activityId,
      { records: [record(memberId)] },
      submitter,
      META,
    );
    await prisma.activity.update({
      where: { id: activityId },
      data: { statusCode: 'completed' },
    });

    const newcomer = await createMember();
    await attendances.edit(
      sheet.id,
      { records: [record(memberId), record(newcomer)] },
      submitter,
      META,
    );
    expect(
      await prisma.attendanceRecord.count({ where: { sheetId: sheet.id, deletedAt: null } }),
    ).toBe(2);
  });

  it('全库巡检:已取消活动上不得存在**新增**的考勤事实 —— 本 spec 跑完后 records 计数与提交时一致', async () => {
    const rows = await prisma.$queryRaw<Array<{ activityId: string; n: number }>>(Prisma.sql`
      SELECT a."id" AS "activityId", count(r."id")::int AS n
      FROM "Activity" a
      JOIN "AttendanceSheet" s ON s."activityId" = a."id" AND s."deletedAt" IS NULL
      JOIN "AttendanceRecord" r ON r."sheetId" = s."id" AND r."deletedAt" IS NULL
      WHERE a."statusCode" = 'cancelled' AND a."deletedAt" IS NULL
      GROUP BY a."id"
    `);
    // 方案乙刻意允许「取消前已存在的单」留在已取消活动上(那正是被放行的存量),
    // 但每张单的 records 数必须还是提交时那一条 —— 没有任何一条是取消之后加进去的。
    expect(rows.every((row) => row.n === 1)).toBe(true);
  });
});
