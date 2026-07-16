import { Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  ADMIN_ACTIVITY_CHECK_IN_LIST_SELECT,
  ADMIN_ACTIVITY_CHECK_IN_MEMBER_SELECT,
  ATTENDANCE_SHEET_DRAFT_CHECK_IN_SELECT,
  ATTENDANCE_SHEET_DRAFT_REGISTRATION_SELECT,
} from './activity-check-in-field-policy';
import { ActivityCheckInQueryService } from './activity-check-in-query.service';

type PrismaMock = ReturnType<typeof makePrismaMock>;

function makePrismaMock() {
  const prisma = {
    activity: { findFirst: jest.fn() },
    activityCheckIn: { findMany: jest.fn(), count: jest.fn() },
    activityRegistration: { findMany: jest.fn() },
    member: { findMany: jest.fn() },
    $transaction: jest.fn((operations: Array<Promise<unknown>>) => Promise.all(operations)),
  };
  return prisma;
}

function makePresenterMock() {
  return {
    toAdminListItemDto: jest.fn(
      (row: Record<string, unknown>, member: Record<string, unknown>) => ({
        id: row.id,
        activityId: row.activityId,
        registrationId: row.registrationId,
        member,
        checkInAt: row.checkInAt,
        checkOutAt: row.checkOutAt,
        checkInDistance: (row.checkInDistance as Prisma.Decimal | null)?.toString() ?? null,
        checkOutDistance: (row.checkOutDistance as Prisma.Decimal | null)?.toString() ?? null,
        geoVerified: row.geoVerified,
        outOfRange: row.outOfRange,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }),
    ),
    toAttendanceSheetDraftRecordDto: jest.fn(
      (row: Record<string, unknown>, endAt: Date, roleCode: string) => {
        const checkOutAt = (row.checkOutAt as Date | null) ?? endAt;
        return {
          record: {
            memberId: row.memberId,
            roleCode,
            checkInAt: row.checkInAt,
            checkOutAt,
            serviceHours: 1,
            attendanceStatusCode: 'present' as const,
            registrationId: row.registrationId,
          },
          flag: {
            registrationId: row.registrationId,
            memberId: row.memberId,
            noCheckOut: row.checkOutAt === null,
            outOfRange: row.outOfRange,
            unverified: row.geoVerified === false,
          },
        };
      },
    ),
    toAttendanceSheetDraftAbsentRegistrationDto: jest.fn(
      (registration: Record<string, unknown>, member: Record<string, unknown>) => ({
        registrationId: registration.id,
        memberId: member.id,
        memberNo: member.memberNo,
        displayName: member.displayName,
      }),
    ),
    toAttendanceSheetDraftDto: jest.fn(
      (
        activityId: string,
        mapped: Array<{ record: unknown; flag: unknown }>,
        absentRegistrations: unknown[],
      ) => ({
        activityId,
        records: mapped.map(({ record }) => record),
        flags: mapped.map(({ flag }) => flag),
        absentRegistrations,
      }),
    ),
  };
}

function makeService(prisma: PrismaMock, presenter = makePresenterMock()) {
  return {
    service: new ActivityCheckInQueryService(prisma as never, presenter as never),
    presenter,
  };
}

const ACTIVITY = { id: 'activity-1', endAt: new Date('2026-07-15T12:00:00.000Z') };
const ACTIVITY_POSITION_END = new Date('2026-07-15T10:30:00.000Z');
const MEMBER_A = { id: 'member-a', memberNo: 'M-A', displayName: 'Member A' };
const MEMBER_B = { id: 'member-b', memberNo: 'M-B', displayName: 'Member B' };

function checkInRow(id: string, memberId: string, registrationId: string, createdAt: Date) {
  return {
    id,
    activityId: ACTIVITY.id,
    registrationId,
    memberId,
    checkInAt: new Date('2026-07-15T08:00:00.000Z'),
    checkOutAt: new Date('2026-07-15T10:00:00.000Z'),
    checkInDistance: new Prisma.Decimal('12.34'),
    checkOutDistance: null,
    geoVerified: true,
    outOfRange: false,
    createdAt,
    updatedAt: createdAt,
  };
}

describe('ActivityCheckInQueryService', () => {
  describe('list', () => {
    it('固定 4 次业务查询，按 createdAt desc 分页并用一次 members IN 保持证据顺序', async () => {
      const prisma = makePrismaMock();
      const newer = checkInRow(
        'check-in-new',
        MEMBER_A.id,
        'registration-a',
        new Date('2026-07-15T09:00:00.000Z'),
      );
      const older = checkInRow(
        'check-in-old',
        MEMBER_B.id,
        'registration-b',
        new Date('2026-07-15T08:00:00.000Z'),
      );
      prisma.activity.findFirst.mockResolvedValue(ACTIVITY);
      prisma.activityCheckIn.findMany.mockResolvedValue([newer, older]);
      prisma.activityCheckIn.count.mockResolvedValue(7);
      // 故意反序返回，锁定内存 join 而非依赖 Member 查询顺序；列表不得过滤软删 Member。
      prisma.member.findMany.mockResolvedValue([MEMBER_B, MEMBER_A]);
      const { service, presenter } = makeService(prisma);

      const result = await service.list(ACTIVITY.id, { page: 2, pageSize: 2 });

      expect(result).toMatchObject({
        total: 7,
        page: 2,
        pageSize: 2,
        items: [
          { id: newer.id, member: MEMBER_A },
          { id: older.id, member: MEMBER_B },
        ],
      });
      expect(prisma.activity.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.activityCheckIn.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.activityCheckIn.count).toHaveBeenCalledTimes(1);
      expect(prisma.member.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.activityCheckIn.findMany).toHaveBeenCalledWith({
        where: { activityId: ACTIVITY.id, deletedAt: null },
        select: ADMIN_ACTIVITY_CHECK_IN_LIST_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: 2,
        take: 2,
      });
      expect(prisma.member.findMany).toHaveBeenCalledWith({
        where: { id: { in: [MEMBER_A.id, MEMBER_B.id] } },
        select: ADMIN_ACTIVITY_CHECK_IN_MEMBER_SELECT,
      });
      expect(presenter.toAdminListItemDto).toHaveBeenNthCalledWith(1, newer, MEMBER_A);
      expect(presenter.toAdminListItemDto).toHaveBeenNthCalledWith(2, older, MEMBER_B);
    });

    it('空分页仍执行第 4 次 members IN []，保持固定查询预算', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findFirst.mockResolvedValue(ACTIVITY);
      prisma.activityCheckIn.findMany.mockResolvedValue([]);
      prisma.activityCheckIn.count.mockResolvedValue(0);
      prisma.member.findMany.mockResolvedValue([]);
      const { service, presenter } = makeService(prisma);

      await expect(service.list(ACTIVITY.id, { page: 1, pageSize: 20 })).resolves.toEqual({
        items: [],
        total: 0,
        page: 1,
        pageSize: 20,
      });

      expect(prisma.activity.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.activityCheckIn.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.activityCheckIn.count).toHaveBeenCalledTimes(1);
      expect(prisma.member.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.member.findMany).toHaveBeenCalledWith({
        where: { id: { in: [] } },
        select: ADMIN_ACTIVITY_CHECK_IN_MEMBER_SELECT,
      });
      expect(presenter.toAdminListItemDto).not.toHaveBeenCalled();
    });

    it('activity 不存在先抛 ACTIVITY_NOT_FOUND，不查 page/count/member', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findFirst.mockResolvedValue(null);
      const { service } = makeService(prisma);

      await expect(service.list('activity-missing', { page: 1, pageSize: 20 })).rejects.toEqual(
        new BizException(BizCode.ACTIVITY_NOT_FOUND),
      );
      expect(prisma.activityCheckIn.findMany).not.toHaveBeenCalled();
      expect(prisma.activityCheckIn.count).not.toHaveBeenCalled();
      expect(prisma.member.findMany).not.toHaveBeenCalled();
    });
  });

  describe('attendanceSheetDraft', () => {
    it('固定 4 次业务查询，岗位报名草稿带岗位 role/endAt，无岗位报名保持 absent 语义', async () => {
      const prisma = makePrismaMock();
      const registrationA = {
        id: 'registration-a',
        memberId: MEMBER_A.id,
        activityPosition: {
          attendanceRoleCode: 'instructor',
          endAt: ACTIVITY_POSITION_END,
        },
      };
      const registrationB = {
        id: 'registration-b',
        memberId: MEMBER_B.id,
        activityPosition: null,
      };
      const evidenceA = {
        registrationId: registrationA.id,
        memberId: MEMBER_A.id,
        checkInAt: new Date('2026-07-15T08:00:00.000Z'),
        checkOutAt: null,
        geoVerified: false,
        outOfRange: true,
      };
      prisma.activity.findFirst.mockResolvedValue(ACTIVITY);
      prisma.activityRegistration.findMany.mockResolvedValue([registrationA, registrationB]);
      prisma.activityCheckIn.findMany.mockResolvedValue([evidenceA]);
      prisma.member.findMany.mockResolvedValue([MEMBER_B, MEMBER_A]);
      const { service, presenter } = makeService(prisma);

      const result = await service.attendanceSheetDraft(ACTIVITY.id);

      expect(result).toMatchObject({
        activityId: ACTIVITY.id,
        records: [
          {
            memberId: MEMBER_A.id,
            registrationId: registrationA.id,
            roleCode: 'instructor',
            checkOutAt: ACTIVITY_POSITION_END,
          },
        ],
        flags: [
          {
            memberId: MEMBER_A.id,
            registrationId: registrationA.id,
            noCheckOut: true,
            outOfRange: true,
            unverified: true,
          },
        ],
        absentRegistrations: [
          {
            registrationId: registrationB.id,
            memberId: MEMBER_B.id,
            memberNo: MEMBER_B.memberNo,
          },
        ],
      });
      expect(prisma.activity.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.activityRegistration.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.activityCheckIn.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.member.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.activityRegistration.findMany).toHaveBeenCalledWith({
        where: {
          activityId: ACTIVITY.id,
          statusCode: 'pass',
          deletedAt: null,
          member: { deletedAt: null },
        },
        select: ATTENDANCE_SHEET_DRAFT_REGISTRATION_SELECT,
        orderBy: [{ registeredAt: 'asc' }, { id: 'asc' }],
      });
      expect(prisma.activityCheckIn.findMany).toHaveBeenCalledWith({
        where: {
          registrationId: { in: [registrationA.id, registrationB.id] },
          deletedAt: null,
        },
        select: ATTENDANCE_SHEET_DRAFT_CHECK_IN_SELECT,
      });
      expect(prisma.member.findMany).toHaveBeenCalledWith({
        where: { id: { in: [MEMBER_A.id, MEMBER_B.id] }, deletedAt: null },
        select: ADMIN_ACTIVITY_CHECK_IN_MEMBER_SELECT,
      });
      expect(presenter.toAttendanceSheetDraftRecordDto).toHaveBeenCalledWith(
        evidenceA,
        ACTIVITY_POSITION_END,
        'instructor',
      );
      expect(presenter.toAttendanceSheetDraftAbsentRegistrationDto).toHaveBeenCalledWith(
        registrationB,
        MEMBER_B,
      );
    });

    it('零报名仍执行 check-ins/member 两次空 IN，返回空 records/flags/absent', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findFirst.mockResolvedValue(ACTIVITY);
      prisma.activityRegistration.findMany.mockResolvedValue([]);
      prisma.activityCheckIn.findMany.mockResolvedValue([]);
      prisma.member.findMany.mockResolvedValue([]);
      const { service } = makeService(prisma);

      const result = await service.attendanceSheetDraft(ACTIVITY.id);

      expect(result).toEqual({
        activityId: ACTIVITY.id,
        records: [],
        flags: [],
        absentRegistrations: [],
      });
      expect(prisma.activity.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.activityRegistration.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.activityCheckIn.findMany).toHaveBeenCalledWith({
        where: { registrationId: { in: [] }, deletedAt: null },
        select: ATTENDANCE_SHEET_DRAFT_CHECK_IN_SELECT,
      });
      expect(prisma.member.findMany).toHaveBeenCalledWith({
        where: { id: { in: [] }, deletedAt: null },
        select: ADMIN_ACTIVITY_CHECK_IN_MEMBER_SELECT,
      });
    });

    it('activity 不存在先抛 ACTIVITY_NOT_FOUND，不查 registrations/check-ins/member', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findFirst.mockResolvedValue(null);
      const { service } = makeService(prisma);

      await expect(service.attendanceSheetDraft('activity-missing')).rejects.toEqual(
        new BizException(BizCode.ACTIVITY_NOT_FOUND),
      );
      expect(prisma.activityRegistration.findMany).not.toHaveBeenCalled();
      expect(prisma.activityCheckIn.findMany).not.toHaveBeenCalled();
      expect(prisma.member.findMany).not.toHaveBeenCalled();
    });
  });
});
