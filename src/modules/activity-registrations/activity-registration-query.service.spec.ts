import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../database/prisma.service';
import {
  ActivityRegistrationQueryService,
  registrationAdminListSelect,
  registrationCsvSelect,
  registrationListSelect,
} from './activity-registration-query.service';
import type {
  ListMyRegistrationsQueryDto,
  ListRegistrationsQueryDto,
} from './activity-registrations.dto';

// Phase 6-B 第三域第一刀的 characterization spec。
//
// 本 spec 的**唯一目的**是把「搬家零漂移」钉住:被搬走的是 where 构造 / select 投影 /
// orderBy / 分页 / CSV 游标分页,所以断言全部打在**传给 Prisma 的实参**上,而不是打在
// 返回值上 —— 返回值只是 mock 回什么就是什么,证明不了查询构造对不对。
//
// `$transaction([...])` 在本类里是 Prisma **只读批处理数组形式**:mock 直接 Promise.all,
// 与生产行为一致(批处理不改变各自结果)。

function makePrismaMock() {
  const activityRegistration = {
    findMany: jest.fn<Promise<unknown[]>, [unknown]>().mockResolvedValue([]),
    count: jest.fn<Promise<number>, [unknown]>().mockResolvedValue(0),
  };
  const member = {
    findFirst: jest.fn<Promise<{ id: string } | null>, [unknown]>().mockResolvedValue(null),
  };
  return {
    activityRegistration,
    member,
    $transaction: jest
      .fn<Promise<unknown[]>, [Promise<unknown>[]]>()
      .mockImplementation((ops) => Promise.all(ops)),
  };
}
type PrismaMock = ReturnType<typeof makePrismaMock>;

function makeService(prisma: PrismaMock): ActivityRegistrationQueryService {
  return new ActivityRegistrationQueryService(prisma as unknown as PrismaService);
}

function listQuery(overrides: Partial<ListRegistrationsQueryDto> = {}): ListRegistrationsQueryDto {
  return { page: 1, pageSize: 20, ...overrides };
}

type FindManyArg = {
  where: Prisma.ActivityRegistrationWhereInput;
  select: unknown;
  orderBy: unknown;
  skip?: number;
  take?: number;
  cursor?: { id: string };
};

function findManyArg(prisma: PrismaMock, call = 0): FindManyArg {
  return prisma.activityRegistration.findMany.mock.calls[call][0] as FindManyArg;
}

describe('ActivityRegistrationQueryService (characterization)', () => {
  describe('listByActivity', () => {
    it('where 恒带 activityId + 软删过滤;select/orderBy/分页逐字锁定', async () => {
      const prisma = makePrismaMock();
      await makeService(prisma).listByActivity('act-1', listQuery({ page: 3, pageSize: 10 }));

      const arg = findManyArg(prisma);
      expect(arg.where).toEqual({ activityId: 'act-1', deletedAt: null });
      expect(arg.select).toBe(registrationListSelect);
      expect(arg.orderBy).toEqual({ createdAt: 'desc' });
      expect(arg.skip).toBe(20);
      expect(arg.take).toBe(10);
      // count 与 findMany 必须用**同一个** where,否则 total 与 items 对不上。
      expect((prisma.activityRegistration.count.mock.calls[0][0] as FindManyArg).where).toEqual(
        arg.where,
      );
    });

    it('statusCode 省略时不进 where(不退化成 statusCode: undefined)', async () => {
      const prisma = makePrismaMock();
      await makeService(prisma).listByActivity('act-1', listQuery());
      expect(findManyArg(prisma).where).not.toHaveProperty('statusCode');
    });

    it('statusCode 给出时进 where', async () => {
      const prisma = makePrismaMock();
      await makeService(prisma).listByActivity('act-1', listQuery({ statusCode: 'pending' }));
      expect(findManyArg(prisma).where).toEqual({
        activityId: 'act-1',
        statusCode: 'pending',
        deletedAt: null,
      });
    });
  });

  describe('listAllForAdmin', () => {
    it('全部可选筛选省略时 where 只有软删过滤(additive 语义)', async () => {
      const prisma = makePrismaMock();
      await makeService(prisma).listAllForAdmin(listQuery(), undefined);

      const arg = findManyArg(prisma);
      expect(arg.where).toEqual({ deletedAt: null });
      expect(arg.select).toBe(registrationAdminListSelect);
      expect(arg.orderBy).toEqual({ createdAt: 'desc' });
    });

    it('visibleOrganizationIds 传入时下推到 activity.organizationId in', async () => {
      const prisma = makePrismaMock();
      await makeService(prisma).listAllForAdmin(listQuery(), ['org-1', 'org-2']);
      expect(findManyArg(prisma).where.activity).toEqual({
        organizationId: { in: ['org-1', 'org-2'] },
      });
    });

    it('visibleOrganizationIds 为空数组时仍下推(GLOBAL 无筛选才是 undefined)', async () => {
      const prisma = makePrismaMock();
      await makeService(prisma).listAllForAdmin(listQuery(), []);
      expect(findManyArg(prisma).where.activity).toEqual({ organizationId: { in: [] } });
    });

    it('activityQ 与 visibleOrganizationIds 可共存,累加进同一个 activity where', async () => {
      const prisma = makePrismaMock();
      await makeService(prisma).listAllForAdmin(listQuery({ activityQ: '救援' }), ['org-1']);
      expect(findManyArg(prisma).where.activity).toEqual({
        title: { contains: '救援', mode: 'insensitive' },
        organizationId: { in: ['org-1'] },
      });
    });

    it('memberQ → member OR(memberNo/realName);q → 跨 member+activity OR', async () => {
      const prisma = makePrismaMock();
      await makeService(prisma).listAllForAdmin(listQuery({ memberQ: 'A1', q: 'B2' }), undefined);

      const where = findManyArg(prisma).where;
      expect(where.member).toEqual({
        OR: [
          { memberNo: { contains: 'A1', mode: 'insensitive' } },
          { realName: { contains: 'A1', mode: 'insensitive' } },
        ],
      });
      expect(where.OR).toEqual([
        { member: { memberNo: { contains: 'B2', mode: 'insensitive' } } },
        { member: { realName: { contains: 'B2', mode: 'insensitive' } } },
        { activity: { title: { contains: 'B2', mode: 'insensitive' } } },
      ]);
    });

    it('dateFrom / dateTo 单侧给出时只落单侧边界', async () => {
      const prisma = makePrismaMock();
      await makeService(prisma).listAllForAdmin(
        listQuery({ dateFrom: '2099-01-01T00:00:00.000Z' }),
        undefined,
      );
      expect(findManyArg(prisma).where.registeredAt).toEqual({
        gte: new Date('2099-01-01T00:00:00.000Z'),
      });
    });

    it('memberId / activityId 直接进顶层 where', async () => {
      const prisma = makePrismaMock();
      await makeService(prisma).listAllForAdmin(
        listQuery({ memberId: 'mem-1', activityId: 'act-1' }),
        undefined,
      );
      expect(findManyArg(prisma).where).toMatchObject({
        memberId: 'mem-1',
        activityId: 'act-1',
      });
    });

    it('organizationId / includeDescendants / expand 不由本类消费(判权腿与投影留调用方)', async () => {
      const prisma = makePrismaMock();
      await makeService(prisma).listAllForAdmin(
        listQuery({ organizationId: 'org-9', includeDescendants: true, expand: 'member' }),
        undefined,
      );
      // 组织范围只经 visibleOrganizationIds 入参下推;直接传 organizationId 不该产生任何 where。
      expect(findManyArg(prisma).where).toEqual({ deletedAt: null });
    });
  });

  describe('listForMember / listMine', () => {
    it('listForMember 用 admin select(带 activity 上下文)', async () => {
      const prisma = makePrismaMock();
      await makeService(prisma).listForMember('mem-1', listQuery({ statusCode: 'pass' }));

      const arg = findManyArg(prisma);
      expect(arg.where).toEqual({ memberId: 'mem-1', statusCode: 'pass', deletedAt: null });
      expect(arg.select).toBe(registrationAdminListSelect);
    });

    it('listMine 用精简 select(不带 activity 上下文,App 面不多取)', async () => {
      const prisma = makePrismaMock();
      const myQuery: ListMyRegistrationsQueryDto = { page: 2, pageSize: 5 };
      await makeService(prisma).listMine('mem-1', myQuery);

      const arg = findManyArg(prisma);
      expect(arg.where).toEqual({ memberId: 'mem-1', deletedAt: null });
      expect(arg.select).toBe(registrationListSelect);
      expect(arg.skip).toBe(5);
      expect(arg.take).toBe(5);
    });
  });

  describe('memberExists', () => {
    it('查到 → true;查不到 → false(不抛 BizCode,映射留调用方)', async () => {
      const prisma = makePrismaMock();
      const service = makeService(prisma);
      expect(await service.memberExists('mem-1')).toBe(false);

      prisma.member.findFirst.mockResolvedValueOnce({ id: 'mem-1' });
      expect(await service.memberExists('mem-1')).toBe(true);
      expect(prisma.member.findFirst.mock.calls[0][0]).toMatchObject({
        where: { id: 'mem-1', deletedAt: null },
      });
    });
  });

  describe('buildCsvWhere', () => {
    it('scope 省略 = pass(默认只导已通过)', () => {
      expect(makeService(makePrismaMock()).buildCsvWhere(undefined, 'act-1')).toEqual({
        activityId: 'act-1',
        statusCode: 'pass',
        deletedAt: null,
      });
    });

    it('scope=pass 显式传入,语义与省略一致', () => {
      expect(makeService(makePrismaMock()).buildCsvWhere('pass', 'act-1')).toEqual({
        activityId: 'act-1',
        statusCode: 'pass',
        deletedAt: null,
      });
    });

    it('scope=all 不加状态过滤', () => {
      expect(makeService(makePrismaMock()).buildCsvWhere('all', 'act-1')).toEqual({
        activityId: 'act-1',
        deletedAt: null,
      });
    });
  });

  describe('streamCsvRows', () => {
    const drain = async (
      service: ActivityRegistrationQueryService,
      where: Prisma.ActivityRegistrationWhereInput,
    ): Promise<unknown[]> => {
      const out: unknown[] = [];
      for await (const row of service.streamCsvRows(where)) out.push(row);
      return out;
    };

    it('首批取数在首次 next() 时才发生(惰性;调用方要先 yield BOM/表头)', async () => {
      const prisma = makePrismaMock();
      const gen = makeService(prisma).streamCsvRows({ activityId: 'act-1' });
      expect(prisma.activityRegistration.findMany).not.toHaveBeenCalled();
      await gen.next();
      expect(prisma.activityRegistration.findMany).toHaveBeenCalledTimes(1);
    });

    it('批小于 500 即停,单次查询;select / orderBy / take 逐字锁定', async () => {
      const prisma = makePrismaMock();
      prisma.activityRegistration.findMany.mockResolvedValueOnce([{ id: 'r1' }, { id: 'r2' }]);
      const rows = await drain(makeService(prisma), { activityId: 'act-1' });

      expect(rows).toEqual([{ id: 'r1' }, { id: 'r2' }]);
      expect(prisma.activityRegistration.findMany).toHaveBeenCalledTimes(1);
      const arg = findManyArg(prisma);
      expect(arg.select).toBe(registrationCsvSelect);
      expect(arg.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      expect(arg.take).toBe(500);
      expect(arg).not.toHaveProperty('cursor');
    });

    it('满 500 则继续翻页:第二批带 cursor=末行 id 且 skip:1', async () => {
      const prisma = makePrismaMock();
      const full = Array.from({ length: 500 }, (_, i) => ({ id: `r${i}` }));
      prisma.activityRegistration.findMany
        .mockResolvedValueOnce(full)
        .mockResolvedValueOnce([{ id: 'tail' }]);

      const rows = await drain(makeService(prisma), { activityId: 'act-1' });

      expect(rows).toHaveLength(501);
      expect(prisma.activityRegistration.findMany).toHaveBeenCalledTimes(2);
      const second = findManyArg(prisma, 1);
      expect(second.cursor).toEqual({ id: 'r499' });
      expect(second.skip).toBe(1);
      expect(second.take).toBe(500);
    });

    it('恰好 500 行后第二批空 → 停,不无限翻页', async () => {
      const prisma = makePrismaMock();
      prisma.activityRegistration.findMany
        .mockResolvedValueOnce(Array.from({ length: 500 }, (_, i) => ({ id: `r${i}` })))
        .mockResolvedValueOnce([]);

      const rows = await drain(makeService(prisma), { activityId: 'act-1' });
      expect(rows).toHaveLength(500);
      expect(prisma.activityRegistration.findMany).toHaveBeenCalledTimes(2);
    });

    it('where 原样透传,本类不再叠加任何过滤', async () => {
      const prisma = makePrismaMock();
      const where = { activityId: 'act-1', statusCode: 'pass', deletedAt: null };
      await drain(makeService(prisma), where);
      expect(findManyArg(prisma).where).toBe(where);
    });
  });
});
