import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { AuthzService, VisibleOrganizationScope } from '../authz/authz.service';
import { MemberReferenceResolver } from './member-reference-resolver';
import type { MembersQueryService } from './members-query.service';

// issue #1048 T3 · MemberReferenceResolver(§5.2)。
// 严格模式六条规则**逐条一个红**;规则 4 / 5 是否定式合同,各自另配反面样本。

const CURRENT_USER = { id: 'u1', role: 'ADMIN' } as unknown as CurrentUserPayload;

const GLOBAL_SCOPE: VisibleOrganizationScope = {
  hasPermission: true,
  global: true,
  organizationIds: [],
};

const ORG_SCOPE_LEG: Prisma.MemberWhereInput = {
  memberOrganizationMemberships: { some: { organizationId: { in: ['org-a'] } } },
};

function makeHarness(
  options: { scope?: VisibleOrganizationScope; scopeLeg?: Prisma.MemberWhereInput } = {},
) {
  const findFirst = jest.fn().mockResolvedValue(null);
  const findMany = jest.fn().mockResolvedValue([]);
  const prisma = { member: { findFirst, findMany } } as unknown as PrismaService;

  const getVisibleOrganizationScope = jest.fn().mockResolvedValue(options.scope ?? GLOBAL_SCOPE);
  const authz = { getVisibleOrganizationScope } as unknown as AuthzService;

  const buildOrganizationScopeFilter = jest.fn().mockResolvedValue(options.scopeLeg);
  const query = { buildOrganizationScopeFilter } as unknown as MembersQueryService;

  return {
    resolver: new MemberReferenceResolver(prisma, authz, query),
    findFirst,
    findMany,
    getVisibleOrganizationScope,
    buildOrganizationScopeFilter,
  };
}

/** 取某次查询的 where(findFirst / findMany 通用)。 */
function whereOf(mock: jest.Mock, call = 0): Prisma.MemberWhereInput {
  return (mock.mock.calls as unknown as Array<[{ where: Prisma.MemberWhereInput }]>)[call][0].where;
}

describe('MemberReferenceResolver — 规则 1:memberNo 必须精确定位一名', () => {
  it('编号命中恰好一人 → MATCHED,带该 memberId', async () => {
    const { resolver, findFirst } = makeHarness();
    findFirst.mockResolvedValue({ id: 'm1', realName: '张三' });
    await expect(resolver.resolve(CURRENT_USER, { memberNo: 'M-0001' })).resolves.toEqual({
      state: 'MATCHED',
      memberId: 'm1',
    });
    // 编号走**精确等值**,不是模糊 —— 前缀命中不算数
    expect(whereOf(findFirst).memberNo).toBe('M-0001');
  });

  it('编号查无此人 → NOT_FOUND(不退化成按姓名找)', async () => {
    const { resolver, findFirst, findMany } = makeHarness();
    findFirst.mockResolvedValue(null);
    await expect(
      resolver.resolve(CURRENT_USER, { memberNo: 'M-NOPE', realName: '张三' }),
    ).resolves.toEqual({ state: 'NOT_FOUND' });
    // 🔴 关键:给了编号就只认编号。若这里回退到姓名查询,一个打错的编号会被"纠正"成另一个人。
    expect(findMany).not.toHaveBeenCalled();
  });

  it('编号两端空白被 trim(复用 normalizeMemberNo,与写路径同源)', async () => {
    const { resolver, findFirst } = makeHarness();
    findFirst.mockResolvedValue({ id: 'm1', realName: '张三' });
    await resolver.resolve(CURRENT_USER, { memberNo: '  M-0001  ' });
    expect(whereOf(findFirst).memberNo).toBe('M-0001');
  });
});

describe('MemberReferenceResolver — 规则 2:编号与姓名互相打架 → CONFLICT', () => {
  it('编号命中但 realName 规范化后不一致 → CONFLICT(不是 NOT_FOUND、更不是按编号认下来)', async () => {
    const { resolver, findFirst } = makeHarness();
    findFirst.mockResolvedValue({ id: 'm1', realName: '张三' });
    await expect(
      resolver.resolve(CURRENT_USER, { memberNo: 'M-0001', realName: '李四' }),
    ).resolves.toEqual({ state: 'CONFLICT', reason: 'member-no-and-real-name-mismatch' });
  });

  it('两端空白不算不一致(规范化后相等 → 仍 MATCHED)', async () => {
    const { resolver, findFirst } = makeHarness();
    findFirst.mockResolvedValue({ id: 'm1', realName: '张三' });
    await expect(
      resolver.resolve(CURRENT_USER, { memberNo: 'M-0001', realName: '  张三  ' }),
    ).resolves.toEqual({ state: 'MATCHED', memberId: 'm1' });
  });
});

describe('MemberReferenceResolver — 规则 3:只有姓名且重名 → AMBIGUOUS', () => {
  it('姓名唯一命中 → MATCHED', async () => {
    const { resolver, findMany } = makeHarness();
    findMany.mockResolvedValue([{ id: 'm1' }]);
    await expect(resolver.resolve(CURRENT_USER, { realName: '张三' })).resolves.toEqual({
      state: 'MATCHED',
      memberId: 'm1',
    });
  });

  it('姓名命中多人 → AMBIGUOUS(**不得**挑第一个)', async () => {
    const { resolver, findMany } = makeHarness();
    findMany.mockResolvedValue([{ id: 'm1' }, { id: 'm2' }]);
    const result = await resolver.resolve(CURRENT_USER, { realName: '张三' });
    expect(result).toEqual({ state: 'AMBIGUOUS' });
    // AMBIGUOUS 不得携带 memberId —— 携带了下游就会拿去用
    expect(result).not.toHaveProperty('memberId');
  });

  it('姓名零命中 → NOT_FOUND', async () => {
    const { resolver, findMany } = makeHarness();
    findMany.mockResolvedValue([]);
    await expect(resolver.resolve(CURRENT_USER, { realName: '查无此人' })).resolves.toEqual({
      state: 'NOT_FOUND',
    });
  });

  it('只查两条即可判唯一性(不全表扫,也不把候选人数变成信号面)', async () => {
    const { resolver, findMany } = makeHarness();
    findMany.mockResolvedValue([{ id: 'm1' }, { id: 'm2' }]);
    await resolver.resolve(CURRENT_USER, { realName: '张三' });
    expect((findMany.mock.calls as unknown as Array<[{ take: number }]>)[0][0].take).toBe(2);
  });
});

describe('MemberReferenceResolver — 🔴 规则 4:nickname 永远不能自动 MATCHED(否定式合同)', () => {
  // ---- 反面样本:外号**唯一**命中 —— 最容易被"顺手认下来"的那一格 ----
  it('外号唯一命中仍**不得** MATCHED,落 AMBIGUOUS', async () => {
    const { resolver, findMany } = makeHarness();
    findMany.mockResolvedValue([{ id: 'm1' }]); // 唯一命中
    const result = await resolver.resolve(CURRENT_USER, { nickname: '老张' });
    expect(result).toEqual({ state: 'AMBIGUOUS' });
    expect(result.state).not.toBe('MATCHED');
    expect(result).not.toHaveProperty('memberId');
  });

  it('外号零命中 → NOT_FOUND', async () => {
    const { resolver, findMany } = makeHarness();
    findMany.mockResolvedValue([]);
    await expect(resolver.resolve(CURRENT_USER, { nickname: '查无此外号' })).resolves.toEqual({
      state: 'NOT_FOUND',
    });
  });

  // ---- 反面样本:外号**不得**用来在重名里二选一 ----
  it('姓名重名 + 外号唯一 → 仍 AMBIGUOUS(外号不参与消歧)', async () => {
    const { resolver, findMany } = makeHarness();
    findMany.mockResolvedValue([{ id: 'm1' }, { id: 'm2' }]);
    await expect(
      resolver.resolve(CURRENT_USER, { realName: '张三', nickname: '老张' }),
    ).resolves.toEqual({ state: 'AMBIGUOUS' });
    // 只发生了**一次**姓名查询;若实现拿外号再查一轮去挑人,这里会是 2
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(whereOf(findMany)).not.toHaveProperty('nickname');
  });

  it('给了 memberNo 时外号完全不参与(既不确认也不否定)', async () => {
    const { resolver, findFirst, findMany } = makeHarness();
    findFirst.mockResolvedValue({ id: 'm1', realName: '张三' });
    await expect(
      resolver.resolve(CURRENT_USER, { memberNo: 'M-0001', nickname: '对不上的外号' }),
    ).resolves.toEqual({ state: 'MATCHED', memberId: 'm1' });
    expect(findMany).not.toHaveBeenCalled();
    expect(whereOf(findFirst)).not.toHaveProperty('nickname');
  });
});

describe('MemberReferenceResolver — 🔴 规则 5:解析限定在可见组织范围内(否定式合同)', () => {
  it('无 member.read.record → 30100,而不是"解析不到"', async () => {
    const { resolver, findFirst, findMany } = makeHarness({
      scope: { hasPermission: false, global: false, organizationIds: [] },
    });
    // 沿仓内既有断言范式(audit-logs / activity-invitation spec):整个异常对象相等,
    // 而不是只比 message —— 只比 message 时换一个同文案的码也能骗过去。
    await expect(resolver.resolve(CURRENT_USER, { memberNo: 'M-0001' })).rejects.toEqual(
      new BizException(BizCode.RBAC_FORBIDDEN),
    );
    // 无码时**一条查询都不该发出**
    expect(findFirst).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('范围腿必须 AND 进**每一种**解析路径的 where(编号 / 姓名 / 外号)', async () => {
    for (const reference of [{ memberNo: 'M-0001' }, { realName: '张三' }, { nickname: '老张' }]) {
      const { resolver, findFirst, findMany } = makeHarness({ scopeLeg: ORG_SCOPE_LEG });
      await resolver.resolve(CURRENT_USER, reference);
      const mock = findFirst.mock.calls.length > 0 ? findFirst : findMany;
      const where = whereOf(mock);
      const and = where.AND as Prisma.MemberWhereInput[] | undefined;
      if (and === undefined) {
        throw new Error(`解析路径 ${JSON.stringify(reference)} 的 where 未 AND 上组织范围腿`);
      }
      expect(and).toContainEqual(ORG_SCOPE_LEG);
      expect(where.deletedAt).toBeNull();
    }
  });

  // ---- 反面样本:范围外的**精确编号**仍不得命中 ----
  // 这是规则 5 最尖锐的一格:编号是真实存在的、拼写完全正确,唯一的问题是不在调用者
  // 可见范围内。范围腿一旦漏掉,这一格就会静默变成 MATCHED —— 跨范围枚举由此成立。
  it('范围外的精确 memberNo:范围腿使其查不到 → NOT_FOUND(而非 MATCHED)', async () => {
    const { resolver, findFirst } = makeHarness({ scopeLeg: ORG_SCOPE_LEG });
    // 模拟 DB:带上范围腿后查不到(库里有这个人,但不在范围内)
    findFirst.mockResolvedValue(null);
    await expect(resolver.resolve(CURRENT_USER, { memberNo: 'M-OUTSIDE' })).resolves.toEqual({
      state: 'NOT_FOUND',
    });
    expect(whereOf(findFirst).AND as Prisma.MemberWhereInput[]).toContainEqual(ORG_SCOPE_LEG);
  });

  it('GLOBAL 范围 → 不下推组织腿(保持既有查询形状,不无中生有)', async () => {
    const { resolver, findFirst } = makeHarness({ scopeLeg: undefined });
    findFirst.mockResolvedValue({ id: 'm1', realName: '张三' });
    await resolver.resolve(CURRENT_USER, { memberNo: 'M-0001' });
    expect(whereOf(findFirst).AND).toBeUndefined();
    expect(whereOf(findFirst).memberNo).toBe('M-0001');
  });
});

describe('MemberReferenceResolver — 规则 6:只交出 memberId,不交出可被当成 FK 的姓名', () => {
  it('MATCHED 的字段集**恰好** {state, memberId} —— 不回显姓名/外号', async () => {
    const { resolver, findFirst } = makeHarness();
    findFirst.mockResolvedValue({ id: 'm1', realName: '张三' });
    const result = await resolver.resolve(CURRENT_USER, { memberNo: 'M-0001' });
    // 🔴 回显姓名 = 给调用方一个"顺手存下来"的机会,而姓名会变、且不唯一。
    // 字段集锁死,多一个字段就红。
    expect(Object.keys(result).sort()).toEqual(['memberId', 'state']);
  });

  it('三个非 MATCHED 态一律不带 memberId', async () => {
    const notFound = makeHarness();
    notFound.findFirst.mockResolvedValue(null);
    expect(await notFound.resolver.resolve(CURRENT_USER, { memberNo: 'x' })).not.toHaveProperty(
      'memberId',
    );

    const ambiguous = makeHarness();
    ambiguous.findMany.mockResolvedValue([{ id: 'm1' }, { id: 'm2' }]);
    expect(await ambiguous.resolver.resolve(CURRENT_USER, { realName: '张三' })).not.toHaveProperty(
      'memberId',
    );

    const conflict = makeHarness();
    conflict.findFirst.mockResolvedValue({ id: 'm1', realName: '张三' });
    expect(
      await conflict.resolver.resolve(CURRENT_USER, { memberNo: 'M-1', realName: '李四' }),
    ).not.toHaveProperty('memberId');
  });
});

describe('MemberReferenceResolver — 空输入与边界', () => {
  it('三项都不给 → NOT_FOUND(不是"随便挑一个",也不报错)', async () => {
    const { resolver, findFirst, findMany } = makeHarness();
    await expect(resolver.resolve(CURRENT_USER, {})).resolves.toEqual({ state: 'NOT_FOUND' });
    expect(findFirst).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('全空白等同于没给(不会拿空串去查出全表第一个人)', async () => {
    const { resolver, findFirst, findMany } = makeHarness();
    await expect(
      resolver.resolve(CURRENT_USER, { memberNo: '   ', realName: '  ', nickname: ' ' }),
    ).resolves.toEqual({ state: 'NOT_FOUND' });
    expect(findFirst).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });
});
