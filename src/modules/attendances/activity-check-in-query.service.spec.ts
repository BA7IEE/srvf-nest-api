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
import { memberIdentityData } from '../../../test/helpers/member-identity.fixture';

type PrismaMock = ReturnType<typeof makePrismaMock>;

function makePrismaMock() {
  const prisma = {
    activity: { findFirst: jest.fn() },
    activityCheckIn: { findMany: jest.fn(), count: jest.fn() },
    participantServiceSegmentRevision: { findMany: jest.fn(), count: jest.fn() },
    activityRegistration: { findMany: jest.fn() },
    member: { findMany: jest.fn() },
    $transaction: jest.fn((operations: Array<Promise<unknown>>) => Promise.all(operations)),
  };
  return prisma;
}

function makeGateMock(enabled = false) {
  return { isV11Enabled: jest.fn(() => enabled) };
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
        realName: member.realName,
        nickname: member.nickname ?? null,
        label: `${String(member.memberNo)} · ${String(member.realName)}`,
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

function makeService(
  prisma: PrismaMock,
  presenter = makePresenterMock(),
  gate = makeGateMock(false),
) {
  return {
    service: new ActivityCheckInQueryService(prisma as never, presenter as never, gate as never),
    presenter,
    gate,
  };
}

const ACTIVITY = { id: 'activity-1', endAt: new Date('2026-07-15T12:00:00.000Z') };
const ACTIVITY_POSITION_END = new Date('2026-07-15T10:30:00.000Z');
const MEMBER_A = { id: 'member-a', memberNo: 'M-A', ...memberIdentityData('Member A') };
const MEMBER_B = { id: 'member-b', memberNo: 'M-B', ...memberIdentityData('Member B') };

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

  describe('v1.1 official segment reads', () => {
    function officialSegment(params: {
      id: string;
      memberId: string;
      registrationId: string;
      createdAt: Date;
      checkOutAt?: Date | null;
      outOfRange?: boolean;
    }) {
      return {
        id: params.id,
        createdAt: params.createdAt,
        updatedAt: params.createdAt,
        checkInAt: new Date('2026-07-15T08:00:00.000Z'),
        checkOutAt:
          params.checkOutAt === undefined
            ? new Date('2026-07-15T10:00:00.000Z')
            : params.checkOutAt,
        sourceCheckInEvent: {
          distance: new Prisma.Decimal('3.21'),
          geoVerified: true,
          outOfRange: params.outOfRange ?? false,
        },
        sourceCloseEvent:
          params.checkOutAt === null
            ? null
            : { distance: null, geoVerified: true, outOfRange: false },
        identity: {
          activityId: ACTIVITY.id,
          registrationId: params.registrationId,
          memberId: params.memberId,
        },
      };
    }

    it('list 改读当前官方段，不再查询 ActivityCheckIn', async () => {
      const prisma = makePrismaMock();
      const { service } = makeService(prisma, makePresenterMock(), makeGateMock(true));
      const newer = officialSegment({
        id: 'seg-new',
        memberId: MEMBER_A.id,
        registrationId: 'reg-a',
        createdAt: new Date('2026-07-15T09:00:00.000Z'),
      });
      const older = officialSegment({
        id: 'seg-old',
        memberId: MEMBER_B.id,
        registrationId: 'reg-b',
        createdAt: new Date('2026-07-15T08:00:00.000Z'),
      });
      prisma.activity.findFirst.mockResolvedValue(ACTIVITY);
      prisma.participantServiceSegmentRevision.findMany.mockResolvedValue([newer, older]);
      prisma.participantServiceSegmentRevision.count.mockResolvedValue(2);
      prisma.member.findMany.mockResolvedValue([MEMBER_A, MEMBER_B]);

      const page = await service.list(ACTIVITY.id, { page: 1, pageSize: 20 });

      expect(prisma.activityCheckIn.findMany).not.toHaveBeenCalled();
      expect(prisma.participantServiceSegmentRevision.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.participantServiceSegmentRevision.count).toHaveBeenCalledTimes(1);
      expect(page.total).toBe(2);
      expect(page.items).toHaveLength(2);
      expect(page.items[0]).toMatchObject({
        id: 'seg-new',
        registrationId: 'reg-a',
        checkInDistance: '3.21',
      });
    });

    it('list 空分页在 v11 下仍执行 members IN []，且不碰 ActivityCheckIn', async () => {
      const prisma = makePrismaMock();
      const { service } = makeService(prisma, makePresenterMock(), makeGateMock(true));
      prisma.activity.findFirst.mockResolvedValue(ACTIVITY);
      prisma.participantServiceSegmentRevision.findMany.mockResolvedValue([]);
      prisma.participantServiceSegmentRevision.count.mockResolvedValue(0);
      prisma.member.findMany.mockResolvedValue([]);

      const page = await service.list(ACTIVITY.id, { page: 1, pageSize: 20 });

      expect(page.total).toBe(0);
      expect(page.items).toEqual([]);
      expect(prisma.member.findMany).toHaveBeenCalledWith({
        where: { id: { in: [] } },
        select: ADMIN_ACTIVITY_CHECK_IN_MEMBER_SELECT,
      });
      expect(prisma.activityCheckIn.findMany).not.toHaveBeenCalled();
    });

    it('attendanceSheetDraft 把当前官方段映射为 records，无段的 pass 报名仍为 absent', async () => {
      const prisma = makePrismaMock();
      const { service, presenter } = makeService(prisma, makePresenterMock(), makeGateMock(true));
      const registrationA = {
        id: 'reg-a',
        memberId: MEMBER_A.id,
        registeredAt: new Date('2026-07-14T00:00:00.000Z'),
        activityPosition: { attendanceRoleCode: 'member', endAt: ACTIVITY_POSITION_END },
      };
      const registrationB = {
        id: 'reg-b',
        memberId: MEMBER_B.id,
        registeredAt: new Date('2026-07-14T01:00:00.000Z'),
        activityPosition: null,
      };
      prisma.activity.findFirst.mockResolvedValue(ACTIVITY);
      prisma.activityRegistration.findMany.mockResolvedValue([registrationA, registrationB]);
      prisma.participantServiceSegmentRevision.findMany.mockResolvedValue([
        officialSegment({
          id: 'seg-a',
          memberId: MEMBER_A.id,
          registrationId: 'reg-a',
          createdAt: new Date('2026-07-15T08:00:00.000Z'),
        }),
      ]);
      prisma.member.findMany.mockResolvedValue([MEMBER_A, MEMBER_B]);

      const draft = await service.attendanceSheetDraft(ACTIVITY.id);

      expect(prisma.activityCheckIn.findMany).not.toHaveBeenCalled();
      expect(draft.records).toHaveLength(1);
      expect(draft.absentRegistrations).toHaveLength(1);
      expect(draft.absentRegistrations[0]).toMatchObject({ registrationId: 'reg-b' });
      expect(presenter.toAttendanceSheetDraftRecordDto).toHaveBeenCalledWith(
        expect.objectContaining({ registrationId: 'reg-a', memberId: MEMBER_A.id }),
        ACTIVITY_POSITION_END,
        'member',
      );
    });
  });
});
