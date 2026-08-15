import { MemberStatus, MembershipStatus, Prisma } from '@prisma/client';
import type { PrismaService } from '../../database/prisma.service';
import type { VisibleOrganizationScope } from '../authz/authz.service';
import type { OrganizationsService } from '../organizations/organizations.service';
import { MembersQueryService } from './members-query.service';
import type { ListMembersQueryDto } from './members.dto';

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
  displayName: '张三',
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

  it('关键字 q → displayName / memberNo 双字段 insensitive 模糊', async () => {
    const { service, findMany } = makeHarness();
    await service.list(listQuery({ q: '张' }), GLOBAL_SCOPE);
    expect(whereOf(findMany).OR).toEqual([
      { displayName: { contains: '张', mode: 'insensitive' } },
      { memberNo: { contains: '张', mode: 'insensitive' } },
    ]);
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
    const where = whereOf(findMany);
    expect(where.status).toBe(MemberStatus.ACTIVE);
    expect(orgLegOf(where)!.some.organizationId).toEqual({ in: ['org-a'] });
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

  it('投影为 { id, label, memberNo, gradeCode }(label 取 displayName)', async () => {
    const { service } = makeHarness();
    const result = await service.options({}, GLOBAL_SCOPE);
    expect(result.items).toEqual([
      { id: 'm1', label: '张三', memberNo: 'm-001', gradeCode: 'level-1' },
    ]);
  });

  it('同样受组织范围交集约束', async () => {
    const { service, findMany } = makeHarness();
    await service.options({}, scopedTo(['org-a']));
    expect(orgLegOf(whereOf(findMany))!.some.organizationId).toEqual({ in: ['org-a'] });
  });
});
