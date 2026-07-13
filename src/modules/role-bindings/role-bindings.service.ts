import { Injectable } from '@nestjs/common';
import {
  AssignmentStatus,
  BindingScopeType,
  BindingStatus,
  PrincipalType,
  Prisma,
  UserStatus,
} from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PageResultDto } from '../../common/dto/pagination.dto';
import { parseExpandQuery } from '../../common/dto/expand-query.util';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { LastAdminProtectionPolicy } from '../permissions/last-admin-protection.policy';
import { RbacCacheService } from '../permissions/rbac-cache.service';
import { RbacService } from '../permissions/rbac.service';
import {
  isPrivilegedRole,
  RoleDelegationPolicy,
  type RoleDelegationTarget,
} from '../permissions/role-delegation.policy';
import {
  BatchCreateRoleBindingsDto,
  BatchCreateRoleBindingsResponseDto,
  CreateRoleBindingDto,
  ListRoleBindingsQueryDto,
  PageRoleBindingsQueryDto,
  PreviewRoleBindingQueryDto,
  ROLE_BINDING_EXPAND_TOKENS,
  RoleBindingBatchItemResultDto,
  RoleBindingExpandedPrincipalDto,
  RoleBindingExpandedRoleDto,
  RoleBindingPreviewConflictDto,
  RoleBindingPreviewResponseDto,
  RoleBindingResponseDto,
  UpdateRoleBindingDto,
} from './role-bindings.dto';
import { roleBindingSafeSelect, type SafeRoleBinding } from './role-bindings.select';

// 终态 scoped-authz PR6「RoleBinding」(2026-07-01 goal;冻结稿 §3.6 / §7.5 / §4.3 / §10.6 / §11 PR6):
//   带 scope 的角色绑定管理面 service。判权单轨 service 层 rbac.can(0 @Roles;沿 supervision-assignments 范式)。
//   建 / 改 / 软删写 audit(inline;resourceType='role_binding';event role-binding.{create,update,revoke} + extra.viaPath='role-binding')。
//
// **🔴 scoped 绑定可存不判(PR8 边界):** 本 service 建的 GLOBAL / ORGANIZATION / ORGANIZATION_TREE / ACTIVITY /
//   RESOURCE / SELF 各型绑定**入库即止**;RbacService 只读 scopeType=GLOBAL(全局判权),**绝不判 scoped 行**
//   (scoped 判权是 PR8 AuthzService)。本 service 绝不进任何 rbac.can / 判权路径,纯数据 + 一致性校验。
// **principalId 多态无 FK(沿 Attachment.ownerType/ownerId 范式):** 随 principalType 按存在性校验,不建通用 Prisma FK;
//   仅 roleId→RbacRole、scopeOrgId→Organization 是真 FK(Restrict)。

const AUDIT_RESOURCE_TYPE = 'role_binding';

type PrismaTx = Prisma.TransactionClient;

@Injectable()
export class RoleBindingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly auditLogs: AuditLogsService,
    private readonly cache: RbacCacheService,
    private readonly roleDelegation: RoleDelegationPolicy,
    private readonly lastAdminProtection: LastAdminProtectionPolicy,
  ) {}

  // ============ helpers(模块内聚；跨入口最后管理员不变量统一委托 LastAdminProtectionPolicy)============

  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  // 终态 scoped-authz PR6:USER 主体的绑定变更影响其 global 判权(RbacService 读源),失效其权限缓存
  //   (沿 UserRolesService.cache.invalidateUser 现范式;非 USER 主体无 user 缓存,no-op)。scoped 绑定虽不判权,
  //   失效亦无害(缓存重建结果不变),故对 USER 主体一律失效,保证 GLOBAL 绑定即时生效、失效链不破。
  private invalidateIfUser(principalType: PrincipalType, principalId: string | null): void {
    if (principalType === PrincipalType.USER && principalId != null) {
      this.cache.invalidateUser(principalId);
    }
  }

  private toResponseDto(row: SafeRoleBinding) {
    return {
      id: row.id,
      principalType: row.principalType,
      principalId: row.principalId,
      roleId: row.roleId,
      scopeType: row.scopeType,
      scopeOrgId: row.scopeOrgId,
      scopeActivityId: row.scopeActivityId,
      scopeResourceType: row.scopeResourceType,
      scopeResourceId: row.scopeResourceId,
      status: row.status,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      createdByUserId: row.createdByUserId,
      note: row.note,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // principalType ↔ principalId 一致性 + 被引用主体存在且 active(多态,无 FK)。
  // SYSTEM → principalId 必须为空;非 SYSTEM → principalId 必填且指向存在且 active 的实体(按类型选表)。
  // USER 对齐 UserRolesService.assertUserAccessibleOrThrow 口径要求 status=ACTIVE(review G16);
  // POSITION_ASSIGNMENT 要求 status=ACTIVE、拒绝已 REVOKED/ENDED 但未软删的任职(review G13);
  // MEMBER 无 DISABLED 语义,维持仅校验未软删。
  private async validatePrincipalOrThrow(
    tx: PrismaTx,
    principalType: PrincipalType,
    principalId: string | null,
  ): Promise<void> {
    if (principalType === PrincipalType.SYSTEM) {
      if (principalId != null) throw new BizException(BizCode.ROLE_BINDING_PRINCIPAL_INVALID);
      return; // SYSTEM 主体无实体表,不校验存在性
    }
    if (principalId == null) throw new BizException(BizCode.ROLE_BINDING_PRINCIPAL_INVALID);
    if (principalType === PrincipalType.USER) {
      const u = await tx.user.findFirst({
        where: { id: principalId, deletedAt: null, status: UserStatus.ACTIVE },
        select: { id: true },
      });
      if (!u) throw new BizException(BizCode.USER_NOT_FOUND);
    } else if (principalType === PrincipalType.MEMBER) {
      const m = await tx.member.findFirst({
        where: notDeletedWhere({ id: principalId }),
        select: { id: true },
      });
      if (!m) throw new BizException(BizCode.MEMBER_NOT_FOUND);
    } else {
      // POSITION_ASSIGNMENT
      const pa = await tx.organizationPositionAssignment.findFirst({
        where: notDeletedWhere({ id: principalId, status: AssignmentStatus.ACTIVE }),
        select: { id: true },
      });
      if (!pa) throw new BizException(BizCode.POSITION_ASSIGNMENT_NOT_FOUND);
    }
  }

  // scopeType ↔ scope 字段一致性(纯输入,不触库):缺必填 scope 或提供多余 scope → SCOPE_INVALID。
  private validateScopeShapeOrThrow(dto: {
    scopeType: BindingScopeType;
    scopeOrgId?: string;
    scopeActivityId?: string;
    scopeResourceType?: string;
    scopeResourceId?: string;
  }): void {
    const hasOrg = dto.scopeOrgId != null;
    const hasActivity = dto.scopeActivityId != null;
    const hasResType = dto.scopeResourceType != null;
    const hasResId = dto.scopeResourceId != null;
    const invalid = (): never => {
      throw new BizException(BizCode.ROLE_BINDING_SCOPE_INVALID);
    };
    switch (dto.scopeType) {
      case BindingScopeType.GLOBAL:
      case BindingScopeType.SELF:
        if (hasOrg || hasActivity || hasResType || hasResId) invalid();
        break;
      case BindingScopeType.ORGANIZATION:
      case BindingScopeType.ORGANIZATION_TREE:
        if (!hasOrg || hasActivity || hasResType || hasResId) invalid();
        break;
      case BindingScopeType.ACTIVITY:
        if (!hasActivity || hasOrg || hasResType || hasResId) invalid();
        break;
      case BindingScopeType.RESOURCE:
        if (!hasResType || !hasResId || hasOrg || hasActivity) invalid();
        break;
    }
  }

  // roleId → RbacRole 存在且未软删(沿 user-roles findRoleOrThrow 范式)。
  private async findRoleOrThrow(tx: PrismaTx, roleId: string) {
    const role = await tx.rbacRole.findUnique({
      where: { id: roleId },
      select: {
        id: true,
        code: true,
        deletedAt: true,
        rolePermissions: { select: { permission: { select: { code: true } } } },
      },
    });
    if (!role) throw new BizException(BizCode.ROLE_NOT_FOUND);
    if (role.deletedAt !== null) throw new BizException(BizCode.ROLE_DELETED);
    return role;
  }

  // ============ GET /api/admin/v1/role-bindings ============

  // 列出角色绑定(全部未软删;可按 principalType × principalId × role × scopeType × status 过滤)。
  // 含 scoped 各型(GLOBAL / ORGANIZATION / TREE / ACTIVITY / RESOURCE / SELF);仅展示,不判权。
  async list(user: CurrentUserPayload, query: ListRoleBindingsQueryDto) {
    await this.assertCanOrThrow(user, 'role-binding.read.record');
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
    return rows.map((r) => this.toResponseDto(r));
  }

  // ============ F3/C1:GET /api/admin/v1/role-bindings/page(D9 拍板) ============

  // 分页总表(旧 bare 数组端点逐字不动的兄弟路由)。过滤 = 既有 5 项 + scopeOrgId / roleCode /
  // principalQ(多态主体模糊,批量解析 id 集,零 N+1)/ includeExpired(默认 false = 仅当前生效)/
  // q(note + 角色 code/显示名)/ expand=role,principal(D6 约定;缺省不展开,响应形状与旧端点一致)。
  // 仅展示,不判权(scoped 绑定入库即止铁律不变)。
  async page(
    user: CurrentUserPayload,
    query: PageRoleBindingsQueryDto,
  ): Promise<PageResultDto<RoleBindingResponseDto>> {
    await this.assertCanOrThrow(user, 'role-binding.read.record');
    const expand = parseExpandQuery(query.expand, ROLE_BINDING_EXPAND_TOKENS);

    const where: Prisma.RoleBindingWhereInput = { deletedAt: null };
    const and: Prisma.RoleBindingWhereInput[] = [];
    if (query.principalType !== undefined) where.principalType = query.principalType;
    if (query.principalId !== undefined) where.principalId = query.principalId;
    if (query.roleId !== undefined) where.roleId = query.roleId;
    if (query.scopeType !== undefined) where.scopeType = query.scopeType;
    if (query.scopeOrgId !== undefined) where.scopeOrgId = query.scopeOrgId;
    if (query.roleCode !== undefined) where.role = { code: query.roleCode };

    // status 显式传参优先;否则 includeExpired=false(默认)收窄为「当前生效」
    // (status=ACTIVE 且 endedAt 为空或未到 —— startedAt 未来的排期绑定仍展示,与判权侧 isWithinTerm 刻意不同:
    //  列表是管理面,排期中的绑定也要能看见)。
    if (query.status !== undefined) {
      where.status = query.status;
    } else if (query.includeExpired !== true) {
      where.status = BindingStatus.ACTIVE;
      and.push({ OR: [{ endedAt: null }, { endedAt: { gt: new Date() } }] });
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

    let items: RoleBindingResponseDto[] = rows.map((r) => this.toResponseDto(r));
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

  // ============ F3/C1:GET /api/admin/v1/role-bindings/:id ============

  // detail(此前无)。找不到未软删记录 → ROLE_BINDING_NOT_FOUND;同读码。
  async findOne(user: CurrentUserPayload, id: string): Promise<RoleBindingResponseDto> {
    await this.assertCanOrThrow(user, 'role-binding.read.record');
    const row = await this.prisma.roleBinding.findFirst({
      where: notDeletedWhere({ id }),
      select: roleBindingSafeSelect,
    });
    if (!row) throw new BizException(BizCode.ROLE_BINDING_NOT_FOUND);
    return this.toResponseDto(row);
  }

  // ============ F3/C1:GET /api/admin/v1/role-bindings/preview(dry-run) ============

  // 待建绑定合法性/冲突预检:与 create 走**同一批私有校验器**(scope 形状 / 任期 / 主体 / 角色 /
  // scope 实体存在性),逐项捕获 BizException 收集为 conflicts,绝不写库;防重用只读 findFirst
  // 模拟 partial unique(全 8 scope 维度 + status=ACTIVE + 未软删)—— 与 DB 约束存在提交竞态窗口,
  // preview 是咨询性结论,create 时约束仍兜底(P2002 → 34002)。
  // 权限:复用 read 码(goal 拍板:preview 是 dry-run 只读;冲突可见面 = 持 read 码本可 list 到的绑定行,无泄露)。
  async preview(
    user: CurrentUserPayload,
    query: PreviewRoleBindingQueryDto,
  ): Promise<RoleBindingPreviewResponseDto> {
    await this.assertCanOrThrow(user, 'role-binding.read.record');
    const conflicts: RoleBindingPreviewConflictDto[] = [];
    const collect = async (check: () => void | Promise<void>): Promise<void> => {
      try {
        await check();
      } catch (err) {
        if (err instanceof BizException) {
          conflicts.push({ bizCode: err.biz.code, message: err.biz.message });
          return;
        }
        throw err;
      }
    };

    await collect(() => this.validateScopeShapeOrThrow(query));

    const startedAt = query.startedAt !== undefined ? new Date(query.startedAt) : new Date();
    const endedAt = query.endedAt !== undefined ? new Date(query.endedAt) : null;
    await collect(() => {
      if (endedAt !== null && endedAt.getTime() <= startedAt.getTime()) {
        throw new BizException(BizCode.ROLE_BINDING_TENURE_INVALID);
      }
    });

    const rawPrincipalId = query.principalId ?? null;
    await collect(() =>
      this.validatePrincipalOrThrow(this.prisma, query.principalType, rawPrincipalId),
    );
    let targetRole: RoleDelegationTarget | null = null;
    await collect(async () => {
      targetRole = await this.findRoleOrThrow(this.prisma, query.roleId);
    });
    const roleForDelegation = targetRole;
    if (roleForDelegation !== null) {
      await collect(() =>
        this.roleDelegation.assertActorMayConferRole(user, roleForDelegation, this.prisma),
      );
    }

    if (
      query.scopeType === BindingScopeType.ORGANIZATION ||
      query.scopeType === BindingScopeType.ORGANIZATION_TREE
    ) {
      await collect(async () => {
        if (query.scopeOrgId === undefined) return; // 形状校验已报 SCOPE_INVALID,不重复报
        const org = await this.prisma.organization.findFirst({
          where: notDeletedWhere({ id: query.scopeOrgId }),
          select: { id: true },
        });
        if (!org) throw new BizException(BizCode.ORGANIZATION_NOT_FOUND);
      });
    }
    if (query.scopeType === BindingScopeType.ACTIVITY) {
      await collect(async () => {
        if (query.scopeActivityId === undefined) return;
        const activity = await this.prisma.activity.findFirst({
          where: notDeletedWhere({ id: query.scopeActivityId }),
          select: { id: true },
        });
        if (!activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
      });
    }

    // 防重预检(镜像 role_bindings_active_unique 全 8 维度 NULLS NOT DISTINCT:相等含「均为 null」)
    await collect(async () => {
      const dup = await this.prisma.roleBinding.findFirst({
        where: {
          principalType: query.principalType,
          principalId: rawPrincipalId,
          roleId: query.roleId,
          scopeType: query.scopeType,
          scopeOrgId: query.scopeOrgId ?? null,
          scopeActivityId: query.scopeActivityId ?? null,
          scopeResourceType: query.scopeResourceType ?? null,
          scopeResourceId: query.scopeResourceId ?? null,
          status: BindingStatus.ACTIVE,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (dup) throw new BizException(BizCode.ROLE_BINDING_ALREADY_EXISTS);
    });

    return {
      valid: conflicts.length === 0,
      conflicts,
      resolvedScope: {
        scopeType: query.scopeType,
        scopeOrgId: query.scopeOrgId ?? null,
        scopeActivityId: query.scopeActivityId ?? null,
        scopeResourceType: query.scopeResourceType ?? null,
        scopeResourceId: query.scopeResourceId ?? null,
      },
    };
  }

  // ============ F3/C1:POST /api/admin/v1/role-bindings/batch ============

  // 批量建绑定:逐条独立复用 create()(校验 / audit / 缓存失效全走既有单条路径,零旁路),
  // 单条失败不影响其它条(镜像 announcement-import「deny/blocked 是数据」范式):
  //   ok = 已建;already-exists = 撞同维度 ACTIVE 唯一(34002,幂等 skip —— 重跑同一批不报错);
  //   blocked = 其它校验拒(带底层 BizCode + message)。
  // 调用者判权在循环外整批一次(create 内的同码判定经 RbacCache 命中,不放大查询)。
  async createBatch(
    user: CurrentUserPayload,
    dto: BatchCreateRoleBindingsDto,
    meta: AuditMeta,
  ): Promise<BatchCreateRoleBindingsResponseDto> {
    await this.assertCanOrThrow(user, 'role-binding.create.record');
    const items: RoleBindingBatchItemResultDto[] = [];
    for (const [index, item] of dto.items.entries()) {
      try {
        const created = await this.create(user, item, meta);
        items.push({ index, outcome: 'ok', bindingId: created.id, bizCode: null, message: null });
      } catch (err) {
        if (!(err instanceof BizException)) throw err;
        items.push({
          index,
          outcome:
            err.biz.code === BizCode.ROLE_BINDING_ALREADY_EXISTS.code
              ? 'already-exists'
              : 'blocked',
          bindingId: null,
          bizCode: err.biz.code,
          message: err.biz.message,
        });
      }
    }
    return {
      items,
      summary: {
        total: items.length,
        ok: items.filter((i) => i.outcome === 'ok').length,
        blocked: items.filter((i) => i.outcome === 'blocked').length,
        alreadyExists: items.filter((i) => i.outcome === 'already-exists').length,
      },
    };
  }

  // ============ POST /api/admin/v1/role-bindings ============

  // 建角色绑定(principal × role × scope + 任期)。校验:
  //   1. scopeType ↔ scope 字段一致性(SCOPE_INVALID)
  //   2. 任期:endedAt 有值须 > startedAt(TENURE_INVALID)
  //   3. 事务内:principalType ↔ principalId + 主体存在(PRINCIPAL_INVALID / 复用各 NOT_FOUND)/
  //      role 存在未软删(ROLE_NOT_FOUND / ROLE_DELETED)/ scopeOrg 存在(ORGANIZATION_NOT_FOUND)/
  //      scopeActivity 存在(ACTIVITY_NOT_FOUND)
  //   4. 防重:全 scope 维度 active 唯一(P2002 → ROLE_BINDING_ALREADY_EXISTS;partial unique NULLS NOT DISTINCT)
  async create(user: CurrentUserPayload, dto: CreateRoleBindingDto, meta: AuditMeta) {
    await this.assertCanOrThrow(user, 'role-binding.create.record');

    this.validateScopeShapeOrThrow(dto);

    // 任期校验(纯输入)。startedAt 缺省 = 建立时刻。
    const startedAt = dto.startedAt !== undefined ? new Date(dto.startedAt) : new Date();
    const endedAt = dto.endedAt !== undefined ? new Date(dto.endedAt) : null;
    if (endedAt !== null && endedAt.getTime() <= startedAt.getTime()) {
      throw new BizException(BizCode.ROLE_BINDING_TENURE_INVALID);
    }

    // 校验用原始输入(SYSTEM 带 principalId → PRINCIPAL_INVALID;非 SYSTEM 缺 principalId → PRINCIPAL_INVALID)。
    // 校验通过后 SYSTEM 的 principalId 必为 null,故直接用 rawPrincipalId 落库(不静默丢弃)。
    const rawPrincipalId = dto.principalId ?? null;

    const result = await this.prisma.$transaction(async (tx) => {
      await this.validatePrincipalOrThrow(tx, dto.principalType, rawPrincipalId);
      const role = await this.findRoleOrThrow(tx, dto.roleId);
      await this.roleDelegation.assertActorMayConferRole(user, role, tx);

      if (
        dto.scopeType === BindingScopeType.ORGANIZATION ||
        dto.scopeType === BindingScopeType.ORGANIZATION_TREE
      ) {
        const org = await tx.organization.findFirst({
          where: notDeletedWhere({ id: dto.scopeOrgId! }),
          select: { id: true },
        });
        if (!org) throw new BizException(BizCode.ORGANIZATION_NOT_FOUND);
      }
      if (dto.scopeType === BindingScopeType.ACTIVITY) {
        const activity = await tx.activity.findFirst({
          where: notDeletedWhere({ id: dto.scopeActivityId! }),
          select: { id: true },
        });
        if (!activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
      }

      const created = await this.runWithUniqueGuard(() =>
        tx.roleBinding.create({
          data: {
            principalType: dto.principalType,
            principalId: rawPrincipalId,
            roleId: dto.roleId,
            scopeType: dto.scopeType,
            scopeOrgId: dto.scopeOrgId ?? null,
            scopeActivityId: dto.scopeActivityId ?? null,
            scopeResourceType: dto.scopeResourceType ?? null,
            scopeResourceId: dto.scopeResourceId ?? null,
            status: BindingStatus.ACTIVE,
            startedAt,
            endedAt,
            createdByUserId: user.id,
            note: dto.note ?? null,
          },
          select: roleBindingSafeSelect,
        }),
      );

      await this.auditLogs.log({
        event: 'role-binding.create',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: created.id,
        meta,
        after: {
          principalType: created.principalType,
          principalId: created.principalId,
          roleId: created.roleId,
          scopeType: created.scopeType,
          scopeOrgId: created.scopeOrgId,
          status: created.status,
        },
        extra: {
          viaPath: 'role-binding',
          operation: 'create',
          scopeType: created.scopeType,
          roleId: created.roleId,
        },
        tx,
      });

      return this.toResponseDto(created);
    });

    // 事务提交后失效目标 user 缓存(USER 主体的 GLOBAL 绑定即时生效;非 USER no-op)。
    this.invalidateIfUser(result.principalType, result.principalId);
    return result;
  }

  // ============ PATCH /api/admin/v1/role-bindings/:id ============

  // 改状态 / 任期 / note(全可选)。不改 principal / role / scope(换绑定 = 软删旧建新)。
  // 找不到未软删记录 → NOT_FOUND;endedAt(新旧综合)须 > startedAt(新旧综合)→ TENURE_INVALID;
  // 改 status→ACTIVE 撞全 scope 维度唯一 → P2002 → ROLE_BINDING_ALREADY_EXISTS。
  // review G7:仅当本次 PATCH 触碰 status/startedAt/endedAt 任一字段时,额外拒绝结果态自相矛盾的
  // 「status=ACTIVE 但 endedAt 已过期」组合(→ TENURE_INVALID);纯改 note 不受影响(不触碰任期/状态字段)。
  async update(user: CurrentUserPayload, id: string, dto: UpdateRoleBindingDto, meta: AuditMeta) {
    await this.assertCanOrThrow(user, 'role-binding.update.record');
    const result = await this.prisma.$transaction(async (tx) => {
      const current = await tx.roleBinding.findFirst({
        where: notDeletedWhere({ id }),
        select: {
          ...roleBindingSafeSelect,
          role: {
            select: {
              code: true,
              rolePermissions: { select: { permission: { select: { code: true } } } },
            },
          },
        },
      });
      if (!current) throw new BizException(BizCode.ROLE_BINDING_NOT_FOUND);

      const effectiveStartedAt =
        dto.startedAt !== undefined ? new Date(dto.startedAt) : current.startedAt;
      const effectiveEndedAt = dto.endedAt !== undefined ? new Date(dto.endedAt) : current.endedAt;
      if (effectiveEndedAt !== null && effectiveEndedAt.getTime() <= effectiveStartedAt.getTime()) {
        throw new BizException(BizCode.ROLE_BINDING_TENURE_INVALID);
      }

      const touchesTenureOrStatus =
        dto.status !== undefined || dto.startedAt !== undefined || dto.endedAt !== undefined;
      if (touchesTenureOrStatus) {
        const effectiveStatus = dto.status ?? current.status;
        const now = new Date();
        if (
          effectiveStatus === BindingStatus.ACTIVE &&
          effectiveEndedAt !== null &&
          effectiveEndedAt.getTime() <= now.getTime()
        ) {
          throw new BizException(BizCode.ROLE_BINDING_TENURE_INVALID);
        }
      }

      const reactivatesBinding =
        current.status !== BindingStatus.ACTIVE && dto.status === BindingStatus.ACTIVE;
      const startsEarlier =
        dto.startedAt !== undefined &&
        new Date(dto.startedAt).getTime() < current.startedAt.getTime();
      const endsLater =
        dto.endedAt !== undefined &&
        current.endedAt !== null &&
        new Date(dto.endedAt).getTime() > current.endedAt.getTime();
      if ((reactivatesBinding || startsEarlier || endsLater) && isPrivilegedRole(current.role)) {
        await this.roleDelegation.assertActorMayConferRole(user, current.role, tx);
      }

      if (
        current.status === BindingStatus.ACTIVE &&
        dto.status !== undefined &&
        dto.status !== BindingStatus.ACTIVE
      ) {
        await this.lastAdminProtection.assertCanRemoveOpsAdminBinding(tx, current);
      }

      const data: Prisma.RoleBindingUpdateInput = {};
      if (dto.status !== undefined) data.status = dto.status;
      if (dto.startedAt !== undefined) data.startedAt = new Date(dto.startedAt);
      if (dto.endedAt !== undefined) data.endedAt = new Date(dto.endedAt);
      if (dto.note !== undefined) data.note = dto.note;

      const updated = await this.runWithUniqueGuard(() =>
        tx.roleBinding.update({ where: { id }, data, select: roleBindingSafeSelect }),
      );

      await this.auditLogs.log({
        event: 'role-binding.update',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: updated.id,
        meta,
        before: {
          status: current.status,
          startedAt: current.startedAt,
          endedAt: current.endedAt,
          note: current.note,
        },
        after: {
          status: updated.status,
          startedAt: updated.startedAt,
          endedAt: updated.endedAt,
          note: updated.note,
        },
        extra: {
          viaPath: 'role-binding',
          operation: 'update',
          scopeType: updated.scopeType,
          roleId: updated.roleId,
        },
        tx,
      });
      return this.toResponseDto(updated);
    });

    // 状态/任期变更影响 USER 主体 GLOBAL 判权(如 status ACTIVE↔ENDED),失效其缓存。
    this.invalidateIfUser(result.principalType, result.principalId);
    return result;
  }

  // ============ DELETE /api/admin/v1/role-bindings/:id ============

  // 软删(冻结稿 §7.5:DELETE = 软删):status=ENDED + endedAt=now + deletedAt=now(保历史;partial unique 释放槽位)。
  // 找不到未软删记录 → NOT_FOUND。建 / 撤销写 audit(role-binding.revoke + extra.viaPath='role-binding')。
  async remove(user: CurrentUserPayload, id: string, meta: AuditMeta) {
    await this.assertCanOrThrow(user, 'role-binding.delete.record');
    const result = await this.prisma.$transaction(async (tx) => {
      const current = await tx.roleBinding.findFirst({
        where: notDeletedWhere({ id }),
        select: { ...roleBindingSafeSelect, role: { select: { code: true } } },
      });
      if (!current) throw new BizException(BizCode.ROLE_BINDING_NOT_FOUND);

      await this.lastAdminProtection.assertCanRemoveOpsAdminBinding(tx, current);

      const now = new Date();
      const updated = await tx.roleBinding.update({
        where: { id },
        data: { status: BindingStatus.ENDED, endedAt: now, deletedAt: now },
        select: roleBindingSafeSelect,
      });

      await this.auditLogs.log({
        event: 'role-binding.revoke',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: updated.id,
        meta,
        before: { status: current.status },
        after: { status: updated.status, endedAt: updated.endedAt },
        extra: { viaPath: 'role-binding', operation: 'revoke', scopeType: updated.scopeType },
        tx,
      });

      return this.toResponseDto(updated);
    });

    // 软删移除 USER 主体的绑定,失效其缓存(GLOBAL 绑定即时撤销生效)。
    this.invalidateIfUser(result.principalType, result.principalId);
    return result;
  }

  // ============ P2002 兜底 ============

  // partial unique role_bindings_active_unique 由 migration.sql 末尾手写(NULLS NOT DISTINCT),
  // P2002 meta.target 不可靠 → 任何 P2002 直接抛 ALREADY_EXISTS(34002;并发下全 scope 维度防重底线)。
  private async runWithUniqueGuard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BizException(BizCode.ROLE_BINDING_ALREADY_EXISTS);
      }
      throw err;
    }
  }
}
