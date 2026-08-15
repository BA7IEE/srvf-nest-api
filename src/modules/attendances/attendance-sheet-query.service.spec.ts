import { Prisma } from '@prisma/client';
import type { PaginationQueryDto } from '../../common/dto/pagination.dto';
import type { PrismaService } from '../../database/prisma.service';
import {
  adminMemberRecordSelect,
  adminSheetListSelect,
  AttendanceSheetQueryService,
  recordWithMemberSelect,
  sheetListSelect,
} from './attendance-sheet-query.service';
import {
  ATTENDANCE_SHEET_STATUS,
  ListAttendanceSheetsQueryDto,
  MyAttendanceRecordsQueryDto,
} from './attendances.dto';

// Phase 6-B 第二域第一刀的 characterization spec。
//
// 本 spec 的**唯一目的**是把「搬家零漂移」钉住:被搬走的是 where 构造 / select 投影 /
// orderBy / 分页,所以断言全部打在**传给 Prisma 的实参**上,而不是打在返回值上 ——
// 返回值只是 mock 回什么就是什么,证明不了查询构造对不对。
//
// `$transaction([...])` 在本类里是 Prisma **只读批处理数组形式**:mock 直接把数组原样
// resolve(数组元素就是两个 mock 的返回值),这与生产行为一致(批处理不改变各自结果)。

function makePrismaMock() {
  const attendanceSheet = {
    findMany: jest.fn<Promise<unknown[]>, [unknown]>().mockResolvedValue([]),
    count: jest.fn<Promise<number>, [unknown]>().mockResolvedValue(0),
  };
  const attendanceRecord = {
    findMany: jest.fn<Promise<unknown[]>, [unknown]>().mockResolvedValue([]),
    count: jest.fn<Promise<number>, [unknown]>().mockResolvedValue(0),
  };
  const member = {
    findFirst: jest.fn<Promise<{ id: string } | null>, [unknown]>().mockResolvedValue(null),
  };
  return {
    attendanceSheet,
    attendanceRecord,
    member,
    // 只读批处理:数组形式的 $transaction 只是把各 promise 一起 await。
    $transaction: jest
      .fn<Promise<unknown[]>, [Promise<unknown>[]]>()
      .mockImplementation((ops) => Promise.all(ops)),
  };
}
type PrismaMock = ReturnType<typeof makePrismaMock>;

function makeService(prisma: PrismaMock): AttendanceSheetQueryService {
  return new AttendanceSheetQueryService(prisma as unknown as PrismaService);
}

function listQuery(
  overrides: Partial<ListAttendanceSheetsQueryDto> = {},
): ListAttendanceSheetsQueryDto {
  return { page: 1, pageSize: 20, ...overrides };
}

type SheetFindManyArg = {
  where: Prisma.AttendanceSheetWhereInput;
  select: unknown;
  orderBy: unknown;
  skip: number;
  take: number;
};
type RecordFindManyArg = {
  where: Prisma.AttendanceRecordWhereInput;
  select: unknown;
  orderBy: unknown;
  skip: number;
  take: number;
};

function sheetArg(prisma: PrismaMock): SheetFindManyArg {
  return prisma.attendanceSheet.findMany.mock.calls[0][0] as SheetFindManyArg;
}
function recordArg(prisma: PrismaMock): RecordFindManyArg {
  return prisma.attendanceRecord.findMany.mock.calls[0][0] as RecordFindManyArg;
}

describe('AttendanceSheetQueryService (characterization:搬家零漂移)', () => {
  describe('listSheetsByActivity', () => {
    it('where = {activityId, deletedAt:null};statusCode 省略时不进 where', async () => {
      const prisma = makePrismaMock();
      await makeService(prisma).listSheetsByActivity('act-1', listQuery());

      const arg = sheetArg(prisma);
      expect(arg.where).toEqual({ activityId: 'act-1', deletedAt: null });
      expect(arg.select).toBe(sheetListSelect);
      expect(arg.orderBy).toEqual({ createdAt: 'desc' });
    });

    it('statusCode 入参进 where;分页 skip=(page-1)*pageSize', async () => {
      const prisma = makePrismaMock();
      await makeService(prisma).listSheetsByActivity(
        'act-1',
        listQuery({ page: 3, pageSize: 10, statusCode: ATTENDANCE_SHEET_STATUS.PENDING }),
      );

      const arg = sheetArg(prisma);
      expect(arg.where).toEqual({
        activityId: 'act-1',
        statusCode: ATTENDANCE_SHEET_STATUS.PENDING,
        deletedAt: null,
      });
      expect(arg.skip).toBe(20);
      expect(arg.take).toBe(10);
    });

    it('count 与 findMany 用同一个 where(分页 total 与列表不得错位)', async () => {
      const prisma = makePrismaMock();
      await makeService(prisma).listSheetsByActivity(
        'act-1',
        listQuery({ statusCode: 'approved' }),
      );

      const countArg = prisma.attendanceSheet.count.mock.calls[0][0] as { where: unknown };
      expect(countArg.where).toEqual(sheetArg(prisma).where);
    });
  });

  describe('listSheetsForAdmin', () => {
    it('visibleOrganizationIds 下推进 activity.organizationId.in', async () => {
      const prisma = makePrismaMock();
      await makeService(prisma).listSheetsForAdmin(listQuery(), ['org-1', 'org-2']);

      expect(sheetArg(prisma).where).toEqual({
        activity: { organizationId: { in: ['org-1', 'org-2'] } },
        deletedAt: null,
      });
    });

    it('visibleOrganizationIds=undefined(GLOBAL 无筛选)⇒ where 里没有 activity 键', async () => {
      const prisma = makePrismaMock();
      await makeService(prisma).listSheetsForAdmin(listQuery(), undefined);

      expect(sheetArg(prisma).where).toEqual({ deletedAt: null });
    });

    it('空的可见组织集合 ⇒ in: [](有效持码但范围为空返空列表,不是不加过滤)', async () => {
      const prisma = makePrismaMock();
      await makeService(prisma).listSheetsForAdmin(listQuery(), []);

      expect(sheetArg(prisma).where).toEqual({
        activity: { organizationId: { in: [] } },
        deletedAt: null,
      });
    });

    it('activityQ 与组织范围**共存**于同一个 activity where(不是互相覆盖)', async () => {
      const prisma = makePrismaMock();
      await makeService(prisma).listSheetsForAdmin(listQuery({ activityQ: '救援' }), ['org-1']);

      expect(sheetArg(prisma).where).toEqual({
        activity: {
          title: { contains: '救援', mode: 'insensitive' },
          organizationId: { in: ['org-1'] },
        },
        deletedAt: null,
      });
    });

    it('q ⇒ OR 三支(activity.title + submitter.username + submitter.nickname)', async () => {
      const prisma = makePrismaMock();
      await makeService(prisma).listSheetsForAdmin(listQuery({ q: '张' }), undefined);

      expect(sheetArg(prisma).where.OR).toEqual([
        { activity: { title: { contains: '张', mode: 'insensitive' } } },
        { submitter: { username: { contains: '张', mode: 'insensitive' } } },
        { submitter: { nickname: { contains: '张', mode: 'insensitive' } } },
      ]);
    });

    it('dateFrom/dateTo ⇒ submittedAt gte/lte;只给一头时只出一头', async () => {
      const prisma = makePrismaMock();
      await makeService(prisma).listSheetsForAdmin(
        listQuery({ dateFrom: '2026-01-01T00:00:00.000Z' }),
        undefined,
      );
      expect(sheetArg(prisma).where.submittedAt).toEqual({
        gte: new Date('2026-01-01T00:00:00.000Z'),
      });

      const prisma2 = makePrismaMock();
      await makeService(prisma2).listSheetsForAdmin(
        listQuery({
          dateFrom: '2026-01-01T00:00:00.000Z',
          dateTo: '2026-02-01T00:00:00.000Z',
        }),
        undefined,
      );
      expect(sheetArg(prisma2).where.submittedAt).toEqual({
        gte: new Date('2026-01-01T00:00:00.000Z'),
        lte: new Date('2026-02-01T00:00:00.000Z'),
      });
    });

    it('select 用 adminSheetListSelect(带 activity 子 select,供 expand 与 activityTitle)', async () => {
      const prisma = makePrismaMock();
      await makeService(prisma).listSheetsForAdmin(listQuery(), undefined);
      expect(sheetArg(prisma).select).toBe(adminSheetListSelect);
    });
  });

  describe('memberExists', () => {
    it('查到 → true;查不到 → false(BizCode 映射不在本类)', async () => {
      const prisma = makePrismaMock();
      const service = makeService(prisma);

      expect(await service.memberExists('m-1')).toBe(false);

      prisma.member.findFirst.mockResolvedValue({ id: 'm-1' });
      expect(await service.memberExists('m-1')).toBe(true);

      expect(prisma.member.findFirst.mock.calls[0][0]).toEqual({
        where: { id: 'm-1', deletedAt: null },
        select: { id: true },
      });
    });
  });

  describe('listApprovedRecordsForMember', () => {
    it('只返 approved 且未软删 Sheet 内的 records;orderBy checkInAt desc', async () => {
      const prisma = makePrismaMock();
      const paginationQuery: PaginationQueryDto = { page: 2, pageSize: 5 };
      await makeService(prisma).listApprovedRecordsForMember('m-1', paginationQuery);

      const arg = recordArg(prisma);
      expect(arg.where).toEqual({
        memberId: 'm-1',
        sheet: { statusCode: ATTENDANCE_SHEET_STATUS.APPROVED, deletedAt: null },
        deletedAt: null,
      });
      expect(arg.select).toBe(adminMemberRecordSelect);
      expect(arg.orderBy).toEqual({ checkInAt: 'desc' });
      expect(arg.skip).toBe(5);
      expect(arg.take).toBe(5);
    });
  });

  describe('listApprovedRecordsForSelf', () => {
    it('无 activityId:where 锁本人 + approved sheet', async () => {
      const prisma = makePrismaMock();
      const myQuery: MyAttendanceRecordsQueryDto = { page: 1, pageSize: 20 };
      await makeService(prisma).listApprovedRecordsForSelf('m-1', myQuery);

      const arg = recordArg(prisma);
      expect(arg.where).toEqual({
        memberId: 'm-1',
        sheet: { statusCode: ATTENDANCE_SHEET_STATUS.APPROVED, deletedAt: null },
        deletedAt: null,
      });
      expect(arg.select).toBe(recordWithMemberSelect);
    });

    it('带 activityId:进 sheet 子 where,不覆盖 statusCode/deletedAt', async () => {
      const prisma = makePrismaMock();
      const myQuery: MyAttendanceRecordsQueryDto = {
        page: 1,
        pageSize: 20,
        activityId: 'act-9',
      };
      await makeService(prisma).listApprovedRecordsForSelf('m-1', myQuery);

      expect(recordArg(prisma).where).toEqual({
        memberId: 'm-1',
        sheet: {
          statusCode: ATTENDANCE_SHEET_STATUS.APPROVED,
          deletedAt: null,
          activityId: 'act-9',
        },
        deletedAt: null,
      });
    });
  });
});
