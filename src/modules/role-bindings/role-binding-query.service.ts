import { RoleBindingAccessService } from './role-binding-access.service';
import { Injectable } from '@nestjs/common';
import { PrincipalType, Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PageResultDto } from '../../common/dto/pagination.dto';
import { parseExpandQuery } from '../../common/dto/expand-query.util';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { effectiveRoleBindingWhere } from '../permissions/role-binding-validity';
import {} from '../permissions/role-delegation.policy';
import {
  ListRoleBindingsQueryDto,
  PageRoleBindingsQueryDto,
  ROLE_BINDING_EXPAND_TOKENS,
  RoleBindingExpandedPrincipalDto,
  RoleBindingExpandedRoleDto,
  RoleBindingResponseDto,
} from './role-bindings.dto';
import { roleBindingSafeSelect } from './role-bindings.select';

/*
 * 角色绑定的**读 surface 族**(Phase 6-B 第三域第六刀,D-7 QueryService)。
 *
 * 六条:list · page(带主体模糊搜索与 expand 展开)· findOne,
 * 外加三个只服务它们的构造 —— 主体 q 的 OR 条件、expand 批量装载、展开后主体的序列化。
 *
 * ⚠️ 与主 service 的分工:判权仍在**每个方法体内**调 this.access.assertCanOrThrow,
 * 不接受「上游已判过」的入参 —— 漏传即漏判权,而全仓单测可以零红。
 *
 * ⚠️ attachExpansions 是**批量装载**(按 principalType 分组一次取):
 * 改成逐条查会把 page 变成 N+1,而现有断言只看结果不看查询次数,不会红。
 */
@Injectable()
export class RoleBindingQueryService {
  constructor(
    private readonly prisma: PrismaService,
    // 判权与序列化经共享层;判权调用点仍在本类各方法体内。
    private readonly access: RoleBindingAccessService,
  ) {}

  // 列出角色绑定(全部未软删;可按 principalType × principalId × role × scopeType × status 过滤)。
  // 含 scoped 各型(GLOBAL / ORGANIZATION / TREE / ACTIVITY / RESOURCE / SELF);仅展示,不判权。
  async list(user: CurrentUserPayload, query: ListRoleBindingsQueryDto) {
    await this.access.assertCanOrThrow(user, 'role-binding.read.record');
    const where: Prisma.RoleBindingWhereInput = { deletedAt: null };
    if (query.principalType !== undefined) where.principalType = query.principalType;
    if (query.principalId !== undefined) where.principalId = query.principalId;
    if (query.roleId !== undefined) where.roleId = query.roleId;
    if (query.scopeType !== undefined) where.scopeType = query.scopeType;
    if (query.status !== undefined) where.status = query.status;

    const rows = await this.prisma.roleBinding.findMany({
      where,
      select: roleBindingSafeSelect,
      orderBy: [{ createdAt: 'asc' }],
    });
    return rows.map((r) => this.access.toResponseDto(r));
  }

  // 分页总表(旧 bare 数组端点逐字不动的兄弟路由)。过滤 = 既有 5 项 + scopeOrgId / roleCode /
  // principalQ(多态主体模糊,批量解析 id 集,零 N+1)/ includeExpired(默认 false = 仅当前生效)/
  // q(note + 角色 code/显示名)/ expand=role,principal(D6 约定;缺省不展开,响应形状与旧端点一致)。
  // 仅展示,不判权(scoped 绑定入库即止铁律不变)。
  async page(
    user: CurrentUserPayload,
    query: PageRoleBindingsQueryDto,
  ): Promise<PageResultDto<RoleBindingResponseDto>> {
    await this.access.assertCanOrThrow(user, 'role-binding.read.record');
    const expand = parseExpandQuery(query.expand, ROLE_BINDING_EXPAND_TOKENS);

    const where: Prisma.RoleBindingWhereInput = { deletedAt: null };
    const and: Prisma.RoleBindingWhereInput[] = [];
    if (query.principalType !== undefined) where.principalType = query.principalType;
    if (query.principalId !== undefined) where.principalId = query.principalId;
    if (query.roleId !== undefined) where.roleId = query.roleId;
    if (query.scopeType !== undefined) where.scopeType = query.scopeType;
    if (query.scopeOrgId !== undefined) where.scopeOrgId = query.scopeOrgId;
    if (query.roleCode !== undefined) where.role = { code: query.roleCode };

    // status 显式传参优先；否则 includeExpired=false(默认)严格复用当前有效任期真值。
    // 排期/历史行仍可用 includeExpired=true 查看，默认“当前生效”不得自创第二套边界。
    if (query.status !== undefined) {
      where.status = query.status;
    } else if (query.includeExpired !== true) {
      Object.assign(where, effectiveRoleBindingWhere(new Date()));
    }

    if (query.principalQ !== undefined && query.principalQ !== '') {
      and.push({ OR: await this.buildPrincipalQOr(query.principalQ) });
    }

    if (query.q !== undefined && query.q !== '') {
      const contains = { contains: query.q, mode: 'insensitive' as const };
      and.push({
        OR: [{ note: contains }, { role: { code: contains } }, { role: { displayName: contains } }],
      });
    }
    if (and.length > 0) where.AND = and;

    const [rows, total] = await Promise.all([
      this.prisma.roleBinding.findMany({
        where,
        select: roleBindingSafeSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.roleBinding.count({ where }),
    ]);

    let items: RoleBindingResponseDto[] = rows.map((r) => this.access.toResponseDto(r));
    if (expand.size > 0) {
      items = await this.attachExpansions(items, {
        role: expand.has('role'),
        principal: expand.has('principal'),
      });
    }
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  // principalQ 多态主体模糊命中 → 三型 id 集(user / member / member 背后的任职)。
  // 三次批量查询(零 N+1);`in: []` 在 Prisma 恒不命中,故三支 OR 可无条件拼装。
  private async buildPrincipalQOr(principalQ: string): Promise<Prisma.RoleBindingWhereInput[]> {
    const contains = { contains: principalQ, mode: 'insensitive' as const };
    const [users, members] = await Promise.all([
      this.prisma.user.findMany({
        where: { deletedAt: null, OR: [{ username: contains }, { nickname: contains }] },
        select: { id: true },
      }),
      this.prisma.member.findMany({
        where: notDeletedWhere({ OR: [{ displayName: contains }, { memberNo: contains }] }),
        select: { id: true },
      }),
    ]);
    const memberIds = members.map((m) => m.id);
    const assignments =
      memberIds.length > 0
        ? await this.prisma.organizationPositionAssignment.findMany({
            where: { deletedAt: null, memberId: { in: memberIds } },
            select: { id: true },
          })
        : [];
    return [
      { principalType: PrincipalType.USER, principalId: { in: users.map((u) => u.id) } },
      { principalType: PrincipalType.MEMBER, principalId: { in: memberIds } },
      {
        principalType: PrincipalType.POSITION_ASSIGNMENT,
        principalId: { in: assignments.map((a) => a.id) },
      },
    ];
  }

  // expand 展开(D6):按命中 token 批量取回 role / principal 摘要后逐行挂载(零 N+1)。
  private async attachExpansions(
    items: RoleBindingResponseDto[],
    want: { role: boolean; principal: boolean },
  ): Promise<RoleBindingResponseDto[]> {
    const roleMap = new Map<string, RoleBindingExpandedRoleDto>();
    if (want.role && items.length > 0) {
      const roleIds = [...new Set(items.map((i) => i.roleId))];
      const roles = await this.prisma.rbacRole.findMany({
        where: { id: { in: roleIds } },
        select: { id: true, code: true, displayName: true },
      });
      for (const r of roles) roleMap.set(r.id, r);
    }

    const userMap = new Map<string, { id: string; username: string; nickname: string | null }>();
    const memberMap = new Map<string, { id: string; memberNo: string; displayName: string }>();
    const assignmentMap = new Map<
      string,
      {
        id: string;
        organizationId: string;
        positionId: string;
        memberId: string;
        member: { displayName: string };
      }
    >();
    if (want.principal && items.length > 0) {
      const idsOf = (t: PrincipalType): string[] => [
        ...new Set(
          items
            .filter((i) => i.principalType === t && i.principalId !== null)
            .map((i) => i.principalId as string),
        ),
      ];
      const userIds = idsOf(PrincipalType.USER);
      const memberIds = idsOf(PrincipalType.MEMBER);
      const assignmentIds = idsOf(PrincipalType.POSITION_ASSIGNMENT);
      const [users, members, assignments] = await Promise.all([
        userIds.length > 0
          ? this.prisma.user.findMany({
              where: { id: { in: userIds } },
              select: { id: true, username: true, nickname: true },
            })
          : Promise.resolve([]),
        memberIds.length > 0
          ? this.prisma.member.findMany({
              where: { id: { in: memberIds } },
              select: { id: true, memberNo: true, displayName: true },
            })
          : Promise.resolve([]),
        assignmentIds.length > 0
          ? this.prisma.organizationPositionAssignment.findMany({
              where: { id: { in: assignmentIds } },
              select: {
                id: true,
                organizationId: true,
                positionId: true,
                memberId: true,
                member: { select: { displayName: true } },
              },
            })
          : Promise.resolve([]),
      ]);
      for (const u of users) userMap.set(u.id, u);
      for (const m of members) memberMap.set(m.id, m);
      for (const a of assignments) assignmentMap.set(a.id, a);
    }

    return items.map((item) => {
      const out = { ...item };
      if (want.role) {
        const role = roleMap.get(item.roleId);
        if (role) out.role = role;
      }
      if (want.principal && item.principalId !== null) {
        out.principal = this.toExpandedPrincipal(item.principalType, item.principalId, {
          userMap,
          memberMap,
          assignmentMap,
        });
      }
      return out;
    });
  }

  private toExpandedPrincipal(
    type: PrincipalType,
    id: string,
    maps: {
      userMap: ReadonlyMap<string, { id: string; username: string; nickname: string | null }>;
      memberMap: ReadonlyMap<string, { id: string; memberNo: string; displayName: string }>;
      assignmentMap: ReadonlyMap<
        string,
        {
          id: string;
          organizationId: string;
          positionId: string;
          memberId: string;
          member: { displayName: string };
        }
      >;
    },
  ): RoleBindingExpandedPrincipalDto | undefined {
    if (type === PrincipalType.USER) {
      const u = maps.userMap.get(id);
      return u ? { type, id, username: u.username, nickname: u.nickname } : undefined;
    }
    if (type === PrincipalType.MEMBER) {
      const m = maps.memberMap.get(id);
      return m ? { type, id, memberNo: m.memberNo, displayName: m.displayName } : undefined;
    }
    if (type === PrincipalType.POSITION_ASSIGNMENT) {
      const a = maps.assignmentMap.get(id);
      return a
        ? {
            type,
            id,
            organizationId: a.organizationId,
            positionId: a.positionId,
            memberId: a.memberId,
            displayName: a.member.displayName,
          }
        : undefined;
    }
    return undefined; // SYSTEM 主体无实体(调用方已按 principalId=null 跳过,此处兜底)
  }

  // detail(此前无)。找不到未软删记录 → ROLE_BINDING_NOT_FOUND;同读码。
  async findOne(user: CurrentUserPayload, id: string): Promise<RoleBindingResponseDto> {
    await this.access.assertCanOrThrow(user, 'role-binding.read.record');
    const row = await this.prisma.roleBinding.findFirst({
      where: notDeletedWhere({ id }),
      select: roleBindingSafeSelect,
    });
    if (!row) throw new BizException(BizCode.ROLE_BINDING_NOT_FOUND);
    return this.access.toResponseDto(row);
  }
}
