import { Injectable } from '@nestjs/common';
import { BindingScopeType, BindingStatus, PrincipalType, Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { RbacCacheService } from '../permissions/rbac-cache.service';
import { RbacService } from '../permissions/rbac.service';
import {
  CreateRoleBindingDto,
  ListRoleBindingsQueryDto,
  UpdateRoleBindingDto,
} from './role-bindings.dto';
import { roleBindingSafeSelect, type SafeRoleBinding } from './role-bindings.select';

// 终态 scoped-authz PR6「RoleBinding」(2026-07-01 goal;冻结稿 §3.6 / §7.5 / §4.3 / §10.6 / §11 PR6):
//   带 scope 的角色绑定管理面 service。判权单轨 service 层 rbac.can(0 @Roles;沿 supervision-assignments 范式)。
//   建 / 软删写 audit(inline;resourceType='role_binding';event role-binding.{create,revoke} + extra.viaPath='role-binding')。
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
  ) {}

  // ============ helpers(自包含;沿 supervision-assignments 范式,不抽共享类)============

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

  // principalType ↔ principalId 一致性 + 被引用主体存在性(多态,无 FK)。
  // SYSTEM → principalId 必须为空;非 SYSTEM → principalId 必填且指向存在的实体(按类型选表)。
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
        where: { id: principalId, deletedAt: null },
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
        where: notDeletedWhere({ id: principalId }),
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
  private async findRoleOrThrow(tx: PrismaTx, roleId: string): Promise<void> {
    const role = await tx.rbacRole.findUnique({
      where: { id: roleId },
      select: { id: true, deletedAt: true },
    });
    if (!role) throw new BizException(BizCode.ROLE_NOT_FOUND);
    if (role.deletedAt !== null) throw new BizException(BizCode.ROLE_DELETED);
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
      await this.findRoleOrThrow(tx, dto.roleId);

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
  // 改 status→ACTIVE 撞全 scope 维度唯一 → P2002 → ROLE_BINDING_ALREADY_EXISTS。**不写 audit**(沿 PR5 update)。
  async update(user: CurrentUserPayload, id: string, dto: UpdateRoleBindingDto) {
    await this.assertCanOrThrow(user, 'role-binding.update.record');
    const result = await this.prisma.$transaction(async (tx) => {
      const current = await tx.roleBinding.findFirst({
        where: notDeletedWhere({ id }),
        select: { id: true, startedAt: true, endedAt: true },
      });
      if (!current) throw new BizException(BizCode.ROLE_BINDING_NOT_FOUND);

      const effectiveStartedAt =
        dto.startedAt !== undefined ? new Date(dto.startedAt) : current.startedAt;
      const effectiveEndedAt = dto.endedAt !== undefined ? new Date(dto.endedAt) : current.endedAt;
      if (effectiveEndedAt !== null && effectiveEndedAt.getTime() <= effectiveStartedAt.getTime()) {
        throw new BizException(BizCode.ROLE_BINDING_TENURE_INVALID);
      }

      const data: Prisma.RoleBindingUpdateInput = {};
      if (dto.status !== undefined) data.status = dto.status;
      if (dto.startedAt !== undefined) data.startedAt = new Date(dto.startedAt);
      if (dto.endedAt !== undefined) data.endedAt = new Date(dto.endedAt);
      if (dto.note !== undefined) data.note = dto.note;

      const updated = await this.runWithUniqueGuard(() =>
        tx.roleBinding.update({ where: { id }, data, select: roleBindingSafeSelect }),
      );
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
        select: { id: true, status: true },
      });
      if (!current) throw new BizException(BizCode.ROLE_BINDING_NOT_FOUND);

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
