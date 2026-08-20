import { Injectable } from '@nestjs/common';
import { MembershipType, Prisma, UserStatus } from '@prisma/client';
import { formatMemberLabel } from '../../common/identity/member-label.util';
import {
  buildMemberDirectoryRankLevels,
  MEMBER_DIRECTORY_TIE_BREAK,
} from './member-directory-ranking';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import type { VisibleOrganizationScope } from '../authz/authz.service';
import { MembershipTermStateMachine } from '../member-departments/membership-term-state-machine';
import { OrganizationsService } from '../organizations/organizations.service';
import {
  ListMembersQueryDto,
  MemberOptionItemDto,
  MemberOptionsQueryDto,
  MemberOptionsResponseDto,
} from './members.dto';

type PrismaTx = Prisma.TransactionClient;

// 集中定义对外 select。永不包含 deletedAt(软删除内部状态)。
// §3.2 "include / select strategy" 归 QueryService;`MembersService` 的写路径回读
// 复用同一份投影(import),不另起第二份。
export const memberSafeSelect = {
  id: true,
  memberNo: true,
  realName: true,
  nickname: true,
  memberSinceDate: true,
  memberOriginCode: true,
  gradeCode: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.MemberSelect;

export type SafeMember = Prisma.MemberGetPayload<{ select: typeof memberSafeSelect }>;

// Member 读侧查询构造单一职责类(Phase 6-B 第一刀;沿 docs/architecture-boundary.md §3.2)。
//
// **判权不在这里**:`AuthzService.getVisibleOrganizationScope()` 与 `RBAC_FORBIDDEN` 抛出
// 仍归 `MembersService`(见其 `resolveMemberReadScope()`),本类只接收**算好的**
// `VisibleOrganizationScope` 作为入参 —— 这正是 §3.2 "permission decisions
// (except read-scope filters explicitly passed in)" 那条豁免的口径。授权范围与用户显式
// organizationId 筛选**取交集**这一步本就归业务模块(见 authz.service.ts
// `getVisibleOrganizationScope` 头注末句「业务模块仍负责自己的 organization filter 交集」)。
//
// **职责边界(严守"搬家不优化")**:
// - ✅ list / options 的 where 构造、分页、select 投影、组织范围交集与闭包展开
// - ✅ 关联 live User 的批量 / 单条读(list 走批量版避免 N+1)
// - ❌ 不调 rbac / authz、不做任何 allow/deny 判定
// - ❌ 不写业务表 / 不写 audit / 不开业务事务(list 内那次 `$transaction` 是 Prisma
//      只读批处理数组形式,沿既有实现逐字保留,不是业务事务边界)
// - ❌ 不组装 MemberResponseDto 的账号字段(`attachAccountInfo` 仍在 `MembersService`,
//      待第三刀并入 presenter)
@Injectable()
export class MembersQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationsService,
  ) {}

  // v0.49:成员列表的 organizationId 用户过滤与授权组织集合取交集。成员归属严格只认
  // active PRIMARY，SECONDARY/TEMPORARY/SUPPORT 均不得扩大可见范围。
  async buildOrganizationScopeFilter(
    authScope: VisibleOrganizationScope,
    organizationId: string | undefined,
    includeDescendants: boolean | undefined,
  ): Promise<Prisma.MemberWhereInput | undefined> {
    const requestedOrgIds =
      organizationId === undefined
        ? undefined
        : includeDescendants
          ? await this.organizations.queryDescendantOrgIds(organizationId)
          : [organizationId];

    if (authScope.global && requestedOrgIds === undefined) return undefined;
    const orgIds = authScope.global
      ? (requestedOrgIds ?? [])
      : requestedOrgIds === undefined
        ? authScope.organizationIds
        : requestedOrgIds.filter((id) => authScope.organizationIds.includes(id));

    return {
      memberOrganizationMemberships: {
        some: {
          ...MembershipTermStateMachine.effectiveWhere(new Date()),
          organizationId: { in: orgIds },
          membershipType: MembershipType.PRIMARY,
        },
      },
    };
  }

  /**
   * 五级相关性分页(issue #1048 T2 DoD 2)。
   *
   * 🔴 **授权腿只有一份**:`base` 是调用方算好的完整 where(含 `notDeletedWhere` 与
   * scoped authz 的组织范围腿),这里每一级都是 `{ AND: [base, level] }` —— base 被
   * **原样复用**,没有任何一处重写它。想绕过授权就必须先把这行 AND 删掉,而那会被
   * `members-query.service.spec.ts` 的结构判据当场抓住。
   *
   * 过滤、排序、分页全部在 SQL:每级一条 count,再按落点取 skip/take。
   * 这里**不允许**出现 `.filter(` / `.sort(` —— 8192 人规模下取全量进内存会直接把
   * 这个端点做成不可用(仓内同型不变量见 activity-scale-usability 的「不变量 2」)。
   */
  private async rankedPage(
    base: Prisma.MemberWhereInput,
    rawQuery: string,
    skip: number,
    take: number,
  ): Promise<{ items: SafeMember[]; total: number }> {
    const wheres = buildMemberDirectoryRankLevels(rawQuery).map(
      (level): Prisma.MemberWhereInput => ({ AND: [base, level] }),
    );

    const counts = await this.prisma.$transaction(
      wheres.map((where) => this.prisma.member.count({ where })),
    );
    const total = counts.reduce((sum, count) => sum + count, 0);

    const items: SafeMember[] = [];
    let offset = skip;
    let remaining = take;
    for (let index = 0; index < wheres.length && remaining > 0; index += 1) {
      const size = counts[index];
      // 整级都在请求页之前 → 跳过该级,并把偏移扣掉它的行数。
      if (offset >= size) {
        offset -= size;
        continue;
      }
      const rows = await this.prisma.member.findMany({
        where: wheres[index],
        select: memberSafeSelect,
        orderBy: MEMBER_DIRECTORY_TIE_BREAK,
        skip: offset,
        take: remaining,
      });
      items.push(...rows);
      remaining -= rows.length;
      offset = 0; // 跨级之后就从该级第一行开始取
    }

    return { items, total };
  }

  // 返回原始行 + 总数;账号字段拼装与 PageResultDto 组装仍归调用方。
  async list(
    query: ListMembersQueryDto,
    authScope: VisibleOrganizationScope,
  ): Promise<{ items: SafeMember[]; total: number }> {
    const {
      page,
      pageSize,
      memberNo,
      gradeCode,
      status,
      q,
      organizationId,
      includeDescendants,
      hasAccount,
    } = query;

    const filters: Prisma.MemberWhereInput = {};
    if (memberNo !== undefined) filters.memberNo = memberNo; // 精确匹配(完整字符串相等)
    if (gradeCode !== undefined) filters.gradeCode = gradeCode;
    if (status !== undefined) filters.status = status;
    const orgScope = await this.buildOrganizationScopeFilter(
      authScope,
      organizationId,
      includeDescendants,
    );
    if (orgScope !== undefined) Object.assign(filters, orgScope);
    // 队员账号闭环 v1:hasAccount 经 users 反向关联过滤。
    // 队员账号闭环 v2(评审稿 §1.2 E-1/E-2/E-6):User.memberId 改一对多(partial unique),
    // 关系过滤语法从一对一 `is`/`isNot` 改一对多 `some`/`none`;reopen 落地后同一 memberId
    // 可能有多条软删历史行,显式收窄 `deletedAt: null`——hasAccount 语义与 findLinkedUser /
    // loadLinkedUsersByMemberIds(同一收窄)、grantAccount 的 existingLink(D-2 仅 live)保持一致。
    if (hasAccount === true) filters.users = { some: { deletedAt: null } };
    if (hasAccount === false) filters.users = { none: { deletedAt: null } };

    const where = notDeletedWhere(filters);

    // issue #1048 T2:带 q 时走五级相关性(见 member-directory-ranking.ts);
    // **不带 q 时逐字保持原行为**(createdAt desc)—— 目录排序只在搜索语境下有意义,
    // 顺手改掉无搜索时的默认序会是本刀范围外的行为变更。
    if (q !== undefined) {
      return this.rankedPage(where, q, (page - 1) * pageSize, pageSize);
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.member.findMany({
        where,
        select: memberSafeSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.member.count({ where }),
    ]);

    return { items, total };
  }

  // options = list 的轻量投影;复用 member.read.record(D2,不新增权限码)。
  async options(
    query: MemberOptionsQueryDto,
    authScope: VisibleOrganizationScope,
  ): Promise<MemberOptionsResponseDto> {
    const { q, organizationId, includeDescendants, limit } = query;

    const filters: Prisma.MemberWhereInput = {};
    const orgScope = await this.buildOrganizationScopeFilter(
      authScope,
      organizationId,
      includeDescendants,
    );
    if (orgScope !== undefined) Object.assign(filters, orgScope);

    const where = notDeletedWhere(filters);
    const take = limit ?? 20;

    // 选择器与列表共用同一套相关性(同一个 q 在两处必须给出同序,否则「列表里第一个」
    // 与「下拉里第一个」不是同一个人,用的人会当成 bug)。
    const rows =
      q === undefined
        ? await this.prisma.member.findMany({
            where,
            select: memberSafeSelect,
            orderBy: { createdAt: 'desc' },
            take,
          })
        : (await this.rankedPage(where, q, 0, take)).items;

    const items: MemberOptionItemDto[] = rows.map((r) => ({
      id: r.id,
      label: formatMemberLabel(r),
      memberNo: r.memberNo,
      gradeCode: r.gradeCode,
    }));
    return { items };
  }

  async loadLinkedUsersByMemberIds(
    memberIds: string[],
    tx?: PrismaTx,
  ): Promise<Map<string, { id: string; status: UserStatus }>> {
    if (memberIds.length === 0) return new Map();
    const client = tx ?? this.prisma;
    const users = await client.user.findMany({
      where: { memberId: { in: memberIds }, deletedAt: null },
      select: { id: true, memberId: true, status: true },
    });
    return new Map(users.map((u) => [u.memberId as string, { id: u.id, status: u.status }]));
  }

  // 单条查询版(findOne / update / updateStatus / softDelete 共用;list 走批量版避免 N+1)。
  // 队员账号闭环 v2(评审稿 §1.2 E-6):同 loadLinkedUsersByMemberIds,显式收窄 live。
  async findLinkedUser(
    memberId: string,
    tx?: PrismaTx,
  ): Promise<{ id: string; status: UserStatus } | undefined> {
    const client = tx ?? this.prisma;
    const user = await client.user.findFirst({
      where: { memberId, deletedAt: null },
      select: { id: true, status: true },
    });
    return user ?? undefined;
  }
}
