import { MemberStatus, MembershipStatus, Prisma } from '@prisma/client';
import type { PrismaService } from '../../database/prisma.service';
import type { VisibleOrganizationScope } from '../authz/authz.service';
import type { OrganizationsService } from '../organizations/organizations.service';
import { MembersQueryService } from './members-query.service';
import type { ListMembersQueryDto } from './members.dto';
import { memberIdentityData } from '../../../test/helpers/member-identity.fixture';

// Phase 6-B 第一刀:读侧查询构造边界的 characterization spec(纯构造器注入 mock,
// 不连库、不起 Nest)。锁定的是**抽出前后逐字不变**的 where 构造:组织范围交集、
// 状态 / 关键字 / memberNo / hasAccount 过滤、分页与轻量投影。
//
// 判权腿不在本类(见 members-query.service.ts 头注),故本文件不出现任何 rbac / authz
// stub —— 若将来有人把判权塞回来,这里会因为缺少依赖而立刻显形。
// 端到端行为仍由 department-data-scope-members / members-rbac-boundary e2e 钉住。

const GLOBAL_SCOPE: VisibleOrganizationScope = {
  hasPermission: true,
  global: true,
  organizationIds: [],
};

function scopedTo(organizationIds: string[]): VisibleOrganizationScope {
  return { hasPermission: true, global: false, organizationIds };
}

const ROW = {
  id: 'm1',
  memberNo: 'm-001',
  ...memberIdentityData('张三'),
  gradeCode: 'level-1',
  status: MemberStatus.ACTIVE,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

function makeHarness(descendants: string[] = []) {
  const findMany = jest.fn().mockResolvedValue([ROW]);
  const count = jest.fn().mockResolvedValue(1);
  const prisma = {
    member: { findMany, count },
    // list 的 `$transaction([...])` 是 Prisma 只读批处理数组形式。
    $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
  } as unknown as PrismaService;
  const queryDescendantOrgIds = jest.fn().mockResolvedValue(descendants);
  const organizations = { queryDescendantOrgIds } as unknown as OrganizationsService;
  return {
    service: new MembersQueryService(prisma, organizations),
    findMany,
    count,
    queryDescendantOrgIds,
  };
}

function listQuery(over: Partial<ListMembersQueryDto> = {}): ListMembersQueryDto {
  return { page: 1, pageSize: 20, ...over };
}

/** findMany 的首个实参(Prisma findMany args)。 */
type FindManyArgs = {
  where: Prisma.MemberWhereInput;
  select: Record<string, unknown>;
  orderBy: unknown;
  skip?: number;
  take?: number;
};

function argsOf(findMany: jest.Mock): FindManyArgs {
  const calls = findMany.mock.calls as unknown as Array<[FindManyArgs]>;
  return calls[0][0];
}

/** 取 findMany 实参里的 where(list 与 options 共用)。 */
function whereOf(findMany: jest.Mock): Prisma.MemberWhereInput {
  return argsOf(findMany).where;
}

/** 组织范围腿:membership 子过滤(不存在时返回 undefined)。 */
type OrgLeg = { some: Record<string, unknown> & { organizationId: { in: string[] } } };

function orgLegOf(where: Prisma.MemberWhereInput): OrgLeg | undefined {
  return where.memberOrganizationMemberships as OrgLeg | undefined;
}

// issue #1048 T2:带 q 时 where 变成 `{ AND: [base, level] }`(见 rankedPage)。
// base 就是原来那个完整 where —— 解包出来继续用老断言,语义不变。
function baseOf(where: Prisma.MemberWhereInput): Prisma.MemberWhereInput {
  const and = where.AND as Prisma.MemberWhereInput[] | undefined;
  return and === undefined ? where : and[0];
}

/** 相关性级:`{ AND: [base, level] }` 的第二项。 */
function levelOf(where: Prisma.MemberWhereInput): Prisma.MemberWhereInput {
  return (where.AND as Prisma.MemberWhereInput[])[1];
}

/**
 * 🔴 授权腿探测器:被测 where 必须 **AND 上带组织腿的 base**。
 * 单独抽出来是为了能对它做正对照 —— 探测器自己不报阳,下面所有阴性读数都没有意义。
 */
function assertCarriesOrgScope(where: Prisma.MemberWhereInput, expectedOrgIds: string[]): void {
  const base = baseOf(where);
  const leg = orgLegOf(base);
  if (leg === undefined) throw new Error('where 未携带组织范围腿');
  expect(leg.some.organizationId).toEqual({ in: expectedOrgIds });
  expect(base.deletedAt).toBeNull();
}

describe('MembersQueryService.buildOrganizationScopeFilter — 组织范围交集', () => {
  it('GLOBAL 且无显式筛选 → 不下推任何组织 where(保持旧查询)', async () => {
    const { service } = makeHarness();
    await expect(
      service.buildOrganizationScopeFilter(GLOBAL_SCOPE, undefined, undefined),
    ).resolves.toBeUndefined();
  });

  it('非 GLOBAL 且无显式筛选 → 下推授权组织集合', async () => {
    const { service } = makeHarness();
    const filter = await service.buildOrganizationScopeFilter(
      scopedTo(['org-a', 'org-b']),
      undefined,
      undefined,
    );
    expect(orgLegOf(filter!)!.some.organizationId).toEqual({ in: ['org-a', 'org-b'] });
  });

  it('非 GLOBAL + 显式筛选 → 取交集(越界 org 被剔除)', async () => {
    const { service } = makeHarness();
    const filter = await service.buildOrganizationScopeFilter(
      scopedTo(['org-a', 'org-b']),
      'org-z',
      undefined,
    );
    // 请求 org-z 不在授权集合内 ⇒ 交集为空 ⇒ 空列表(而不是放行)
    expect(orgLegOf(filter!)!.some.organizationId).toEqual({ in: [] });
  });

  it('GLOBAL + 显式筛选 → 只按显式筛选下推', async () => {
    const { service } = makeHarness();
    const filter = await service.buildOrganizationScopeFilter(GLOBAL_SCOPE, 'org-z', undefined);
    expect(orgLegOf(filter!)!.some.organizationId).toEqual({ in: ['org-z'] });
  });

  it('includeDescendants → 走 closure 展开后再取交集', async () => {
    const { service, queryDescendantOrgIds } = makeHarness(['org-a', 'org-a1', 'org-a2']);
    const filter = await service.buildOrganizationScopeFilter(
      scopedTo(['org-a', 'org-a1']),
      'org-a',
      true,
    );
    expect(queryDescendantOrgIds).toHaveBeenCalledWith('org-a');
    // 展开出的 org-a2 不在授权集合内,交集把它剔除
    expect(orgLegOf(filter!)!.some.organizationId).toEqual({ in: ['org-a', 'org-a1'] });
  });

  it('归属只认 active PRIMARY(SECONDARY/TEMPORARY/SUPPORT 不扩大可见范围)', async () => {
    const { service } = makeHarness();
    const filter = await service.buildOrganizationScopeFilter(scopedTo(['org-a']), undefined, true);
    const some = orgLegOf(filter!)!.some;
    expect(some.membershipType).toBe('PRIMARY');
    expect(some.status).toBe(MembershipStatus.ACTIVE);
    expect(some.deletedAt).toBeNull();
    expect(some.endedAt).toBeNull();
  });
});

describe('MembersQueryService.list — 过滤 / 分页', () => {
  it('状态过滤 + 软删排除', async () => {
    const { service, findMany } = makeHarness();
    await service.list(listQuery({ status: MemberStatus.INACTIVE }), GLOBAL_SCOPE);
    const where = whereOf(findMany);
    expect(where.status).toBe(MemberStatus.INACTIVE);
    expect(where.deletedAt).toBeNull();
  });

  it('关键字 q → 五级相关性的第一级 = memberNo 完全匹配', async () => {
    const { service, findMany } = makeHarness();
    await service.list(listQuery({ q: '张' }), GLOBAL_SCOPE);
    expect(levelOf(whereOf(findMany))).toEqual({
      memberNo: { equals: '张', mode: 'insensitive' },
    });
  });

  it('memberNo 是精确匹配,不是模糊', async () => {
    const { service, findMany } = makeHarness();
    await service.list(listQuery({ memberNo: 'm-001' }), GLOBAL_SCOPE);
    expect(whereOf(findMany).memberNo).toBe('m-001');
  });

  it('hasAccount true/false → live User 反向关联 some / none', async () => {
    const yes = makeHarness();
    await yes.service.list(listQuery({ hasAccount: true }), GLOBAL_SCOPE);
    expect(whereOf(yes.findMany).users).toEqual({ some: { deletedAt: null } });

    const no = makeHarness();
    await no.service.list(listQuery({ hasAccount: false }), GLOBAL_SCOPE);
    expect(whereOf(no.findMany).users).toEqual({ none: { deletedAt: null } });
  });

  it('分页 → skip=(page-1)*pageSize,take=pageSize,按 createdAt desc', async () => {
    const { service, findMany } = makeHarness();
    await service.list(listQuery({ page: 3, pageSize: 15 }), GLOBAL_SCOPE);
    const args = argsOf(findMany);
    expect(args.skip).toBe(30);
    expect(args.take).toBe(15);
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('组织范围与业务过滤并存(交集腿不被业务过滤覆盖)', async () => {
    const { service, findMany } = makeHarness();
    await service.list(listQuery({ status: MemberStatus.ACTIVE, q: '张' }), scopedTo(['org-a']));
    const base = baseOf(whereOf(findMany));
    expect(base.status).toBe(MemberStatus.ACTIVE);
    expect(orgLegOf(base)!.some.organizationId).toEqual({ in: ['org-a'] });
  });

  it('返回原始行与总数(账号字段拼装不在本类)', async () => {
    const { service } = makeHarness();
    const result = await service.list(listQuery(), GLOBAL_SCOPE);
    expect(result).toEqual({ items: [ROW], total: 1 });
    expect(result.items[0]).not.toHaveProperty('hasAccount');
  });

  it('select 投影永不包含 deletedAt', async () => {
    const { service, findMany } = makeHarness();
    await service.list(listQuery(), GLOBAL_SCOPE);
    const select = argsOf(findMany).select;
    expect(select).not.toHaveProperty('deletedAt');
    expect(select.memberNo).toBe(true);
  });
});

describe('MembersQueryService.options — 轻量投影', () => {
  it('默认 limit=20,可被显式 limit 覆盖', async () => {
    const dflt = makeHarness();
    await dflt.service.options({}, GLOBAL_SCOPE);
    expect(argsOf(dflt.findMany).take).toBe(20);

    const explicit = makeHarness();
    await explicit.service.options({ limit: 5 }, GLOBAL_SCOPE);
    expect(argsOf(explicit.findMany).take).toBe(5);
  });

  it('投影为 { id, label, memberNo, gradeCode }(label 取 realName)', async () => {
    const { service } = makeHarness();
    const result = await service.options({}, GLOBAL_SCOPE);
    expect(result.items).toEqual([
      { id: 'm1', label: 'm-001 · 张三', memberNo: 'm-001', gradeCode: 'level-1' },
    ]);
  });

  it('同样受组织范围交集约束', async () => {
    const { service, findMany } = makeHarness();
    await service.options({}, scopedTo(['org-a']));
    expect(orgLegOf(whereOf(findMany))!.some.organizationId).toEqual({ in: ['org-a'] });
  });
});

// ============================================================================
// issue #1048 T2 · MemberDirectory 相关性排序与授权不可绕过
// ============================================================================

describe('MembersQueryService.list — 五级相关性(T2 DoD 2)', () => {
  it('五级顺序逐字锁定:memberNo 完全 > realName 完全 > memberNo 前缀 > realName 部分 > nickname', async () => {
    const { service, count } = makeHarness();
    await service.list(listQuery({ q: '张三' }), GLOBAL_SCOPE);

    const levels = (count.mock.calls as unknown as Array<[{ where: Prisma.MemberWhereInput }]>).map(
      (call) => levelOf(call[0].where),
    );
    expect(levels).toHaveLength(5);

    // 第 1 级不排除任何前序;第 2..5 级各自 AND 上 NOT(前序并集)。
    expect(levels[0]).toEqual({ memberNo: { equals: '张三', mode: 'insensitive' } });
    expect((levels[1].AND as Prisma.MemberWhereInput[])[0]).toEqual({
      realName: { equals: '张三', mode: 'insensitive' },
    });
    expect((levels[2].AND as Prisma.MemberWhereInput[])[0]).toEqual({
      memberNo: { startsWith: '张三', mode: 'insensitive' },
    });
    expect((levels[3].AND as Prisma.MemberWhereInput[])[0]).toEqual({
      realName: { contains: '张三', mode: 'insensitive' },
    });
    expect((levels[4].AND as Prisma.MemberWhereInput[])[0]).toEqual({
      nickname: { contains: '张三', mode: 'insensitive' },
    });
  });

  it('级间互斥:第 i 级显式 NOT 掉前 i 级(否则同一人被数多次,total 虚高、翻页重复)', async () => {
    const { service, count } = makeHarness();
    await service.list(listQuery({ q: '张三' }), GLOBAL_SCOPE);
    const levels = (count.mock.calls as unknown as Array<[{ where: Prisma.MemberWhereInput }]>).map(
      (call) => levelOf(call[0].where),
    );

    for (let index = 1; index < levels.length; index += 1) {
      const not = (levels[index].AND as Prisma.MemberWhereInput[])[1].NOT as {
        OR: Prisma.MemberWhereInput[];
      };
      expect(not.OR).toHaveLength(index); // 恰好排除前 index 级
    }
  });

  it('q 统一 trim;memberNo 侧复用 normalizeMemberNo(与写路径同源)', async () => {
    const { service, count } = makeHarness();
    await service.list(listQuery({ q: '  张三  ' }), GLOBAL_SCOPE);
    const first = levelOf(
      (count.mock.calls as unknown as Array<[{ where: Prisma.MemberWhereInput }]>)[0][0].where,
    );
    expect(first).toEqual({ memberNo: { equals: '张三', mode: 'insensitive' } });
  });

  it('级内按 memberNo asc + id asc 定序(PG 无 ORDER BY 不保证行序 ⇒ 翻页会重复/漏行)', async () => {
    const { service, findMany } = makeHarness();
    await service.list(listQuery({ q: '张' }), GLOBAL_SCOPE);
    expect(argsOf(findMany).orderBy).toEqual([{ memberNo: 'asc' }, { id: 'asc' }]);
  });

  it('不传 q → 逐字保持旧行为(createdAt desc,单条 where,不进相关性分页)', async () => {
    const { service, findMany } = makeHarness();
    await service.list(listQuery({}), GLOBAL_SCOPE);
    const args = argsOf(findMany);
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
    expect(whereOf(findMany).AND).toBeUndefined();
  });

  it('total = 五级计数之和(每级一条 count)', async () => {
    const { service, count } = makeHarness();
    count.mockResolvedValue(2);
    const page = await service.list(listQuery({ q: '张' }), GLOBAL_SCOPE);
    expect(count).toHaveBeenCalledTimes(5);
    expect(page.total).toBe(10);
  });
});

describe('MembersQueryService — 🔴 相关性排序不得绕过 scoped authz(T2 DoD 3)', () => {
  // ---- 自证:探测器必须对「base 里没有组织腿」报阳 ----
  // 否则下面那条"每一级都带组织腿"的阴性读数只是空绿。
  it('自证:探测器对缺组织腿的 where 报阳', () => {
    expect(() => assertCarriesOrgScope({ AND: [{ deletedAt: null }, {}] }, ['org-a'])).toThrow(
      /未携带组织范围腿/u,
    );
    // 反向:带腿的必须不抛
    expect(() =>
      assertCarriesOrgScope(
        {
          AND: [
            {
              deletedAt: null,
              memberOrganizationMemberships: { some: { organizationId: { in: ['org-a'] } } },
            },
            {},
          ],
        },
        ['org-a'],
      ),
    ).not.toThrow();
  });

  it('五级 count 与每次 findMany —— **每一条** where 都 AND 上带组织腿的 base', async () => {
    const { service, findMany, count } = makeHarness();
    await service.list(listQuery({ q: '张' }), scopedTo(['org-a']));

    const wheres = [
      ...(count.mock.calls as unknown as Array<[{ where: Prisma.MemberWhereInput }]>).map(
        (call) => call[0].where,
      ),
      ...(findMany.mock.calls as unknown as Array<[{ where: Prisma.MemberWhereInput }]>).map(
        (call) => call[0].where,
      ),
    ];
    // 5 条 count + 至少 1 条 findMany;少于这个数说明有级被悄悄跳过
    expect(wheres.length).toBeGreaterThanOrEqual(6);
    for (const where of wheres) assertCarriesOrgScope(where, ['org-a']);
  });

  it('options 走同一条相关性路径,组织腿同样一条不漏', async () => {
    const { service, findMany, count } = makeHarness();
    await service.options({ q: '张' }, scopedTo(['org-b']));
    const wheres = [
      ...(count.mock.calls as unknown as Array<[{ where: Prisma.MemberWhereInput }]>).map(
        (call) => call[0].where,
      ),
      ...(findMany.mock.calls as unknown as Array<[{ where: Prisma.MemberWhereInput }]>).map(
        (call) => call[0].where,
      ),
    ];
    expect(wheres.length).toBeGreaterThanOrEqual(6);
    for (const where of wheres) assertCarriesOrgScope(where, ['org-b']);
  });
});
