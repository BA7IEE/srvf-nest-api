import { RoleBindingAccessService } from './role-binding-access.service';
import { RoleBindingQueryService } from './role-binding-query.service';
import { Injectable } from '@nestjs/common';
import {
  AssignmentStatus,
  BindingScopeType,
  BindingStatus,
  MemberStatus,
  OrganizationStatus,
  PrincipalType,
  Prisma,
  UserStatus,
} from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { lockMemberLifecycle, lockLiveUserLifecycle } from '../members/member-lifecycle-lock';
import { LastAdminProtectionPolicy } from '../permissions/last-admin-protection.policy';
import { RbacService } from '../permissions/rbac.service';
import { OPS_ADMIN_ROLE_CODE } from '../permissions/role-binding-validity';
import {
  isPrivilegedRole,
  RoleDelegationPolicy,
  type RoleDelegationTarget,
} from '../permissions/role-delegation.policy';
import {
  BatchCreateRoleBindingsDto,
  BatchCreateRoleBindingsResponseDto,
  CreateRoleBindingDto,
  PreviewRoleBindingQueryDto,
  RoleBindingBatchItemResultDto,
  RoleBindingPreviewConflictDto,
  RoleBindingPreviewResponseDto,
  UpdateRoleBindingDto,
} from './role-bindings.dto';
import { roleBindingSafeSelect } from './role-bindings.select';

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
    // 第三域第六刀:共享准入/序列化 + 读族实现持有者;本 service 保留同名薄委托作为唯一入口。
    private readonly access: RoleBindingAccessService,
    private readonly queries: RoleBindingQueryService,
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly auditLogs: AuditLogsService,
    private readonly roleDelegation: RoleDelegationPolicy,
    private readonly lastAdminProtection: LastAdminProtectionPolicy,
  ) {}

  // ============ helpers(模块内聚；跨入口最后管理员不变量统一委托 LastAdminProtectionPolicy)============

  // principalType ↔ principalId 一致性 + 被引用主体存在且 active(多态,无 FK)。
  // SYSTEM → principalId 必须为空;非 SYSTEM → principalId 必填且指向存在且 active 的实体(按类型选表)。
  // USER 对齐 UserRolesService.assertUserAccessibleOrThrow 口径要求 status=ACTIVE(review G16);
  // POSITION_ASSIGNMENT 要求 status=ACTIVE、拒绝已 REVOKED/ENDED 但未软删的任职(review G13);
  // MEMBER 无 DISABLED 语义,维持仅校验未软删。
  private async validatePrincipalOrThrow(
    tx: PrismaTx,
    principalType: PrincipalType,
    principalId: string | null,
    options?: { lockLifecycle?: boolean },
  ): Promise<void> {
    if (principalType === PrincipalType.SYSTEM) {
      if (principalId != null) throw new BizException(BizCode.ROLE_BINDING_PRINCIPAL_INVALID);
      return; // SYSTEM 主体无实体表,不校验存在性
    }
    if (principalId == null) throw new BizException(BizCode.ROLE_BINDING_PRINCIPAL_INVALID);
    if (principalType === PrincipalType.USER) {
      const initial = await tx.user.findFirst({
        where: { id: principalId, deletedAt: null },
        select: { memberId: true },
      });
      if (!initial) throw new BizException(BizCode.USER_NOT_FOUND);
      if (options?.lockLifecycle && initial.memberId !== null) {
        await lockMemberLifecycle(tx, initial.memberId);
      }
      if (options?.lockLifecycle) {
        await lockLiveUserLifecycle(tx, principalId);
      }
      const u = await tx.user.findFirst({
        where: { id: principalId, deletedAt: null, status: UserStatus.ACTIVE },
        select: { id: true, memberId: true },
      });
      if (!u) throw new BizException(BizCode.USER_NOT_FOUND);
      if (u.memberId !== null) {
        const member = await tx.member.findFirst({
          where: { id: u.memberId, deletedAt: null },
          select: { status: true },
        });
        if (!member || member.status !== MemberStatus.ACTIVE) {
          throw new BizException(BizCode.MEMBER_INACTIVE);
        }
      }
    } else if (principalType === PrincipalType.MEMBER) {
      if (options?.lockLifecycle) {
        await lockMemberLifecycle(tx, principalId);
      }
      const m = await tx.member.findFirst({
        where: notDeletedWhere({ id: principalId }),
        select: { id: true, status: true },
      });
      if (!m) throw new BizException(BizCode.MEMBER_NOT_FOUND);
      if (m.status !== MemberStatus.ACTIVE) throw new BizException(BizCode.MEMBER_INACTIVE);
    } else {
      // POSITION_ASSIGNMENT
      const initial = await tx.organizationPositionAssignment.findFirst({
        where: notDeletedWhere({ id: principalId }),
        select: { memberId: true },
      });
      if (!initial) throw new BizException(BizCode.POSITION_ASSIGNMENT_NOT_FOUND);
      if (options?.lockLifecycle) {
        await lockMemberLifecycle(tx, initial.memberId);
      }
      const pa = await tx.organizationPositionAssignment.findFirst({
        where: notDeletedWhere({ id: principalId, status: AssignmentStatus.ACTIVE }),
        select: { id: true, memberId: true },
      });
      if (!pa) throw new BizException(BizCode.POSITION_ASSIGNMENT_NOT_FOUND);
      const member = await tx.member.findFirst({
        where: { id: pa.memberId, deletedAt: null },
        select: { status: true },
      });
      if (!member || member.status !== MemberStatus.ACTIVE) {
        throw new BizException(BizCode.MEMBER_INACTIVE);
      }
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

  // create / preview / batch 与 PATCH 恢复生效共用同一 scope 实体真值:
  // 组织 scope 必须存在、未软删且 ACTIVE；活动 scope 维持既有未软删存在性口径。
  private async validateScopeEntityOrThrow(
    tx: PrismaTx,
    dto: {
      scopeType: BindingScopeType;
      scopeOrgId?: string | null;
      scopeActivityId?: string | null;
    },
  ): Promise<void> {
    if (
      dto.scopeType === BindingScopeType.ORGANIZATION ||
      dto.scopeType === BindingScopeType.ORGANIZATION_TREE
    ) {
      if (dto.scopeOrgId == null) return; // 形状校验负责报 SCOPE_INVALID
      const org = await tx.organization.findFirst({
        where: notDeletedWhere({ id: dto.scopeOrgId }),
        select: { status: true },
      });
      if (!org) throw new BizException(BizCode.ORGANIZATION_NOT_FOUND);
      if (org.status !== OrganizationStatus.ACTIVE) {
        throw new BizException(BizCode.ORGANIZATION_INACTIVE);
      }
      return;
    }
    if (dto.scopeType === BindingScopeType.ACTIVITY) {
      if (dto.scopeActivityId == null) return;
      const activity = await tx.activity.findFirst({
        where: notDeletedWhere({ id: dto.scopeActivityId }),
        select: { id: true },
      });
      if (!activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
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

  // ============ F3/C1:GET /api/admin/v1/role-bindings/page(D9 拍板) ============

  // ============ F3/C1:GET /api/admin/v1/role-bindings/:id ============

  // ============ F3/C1:GET /api/admin/v1/role-bindings/preview(dry-run) ============

  // 待建绑定合法性/冲突预检:与 create 走**同一批私有校验器**(scope 形状 / 任期 / 主体 / 角色 /
  // scope 实体存在性),逐项捕获 BizException 收集为 conflicts,绝不写库;防重用只读 findFirst
  // 模拟 partial unique(全 8 scope 维度 + status=ACTIVE + 未软删)—— 与 DB 约束存在提交竞态窗口,
  // preview 是咨询性结论,create 时约束仍兜底(P2002 → 34002)。
  // 权限:复用 read 码(goal 拍板:preview 是 dry-run 只读;冲突可见面 = 持 read 码本可 list 到的绑定行,无泄露)。

  // ============ 读 surface:薄委托(Phase 6-B 第三域第六刀)============
  //
  // 实现已迁至 role-binding-query.service.ts(仅"搬家":判权 / where 构造 /
  // expand 批量装载 / 序列化逐字不变)。本 service 仍是本模块**唯一**对外入口。

  async list(...args: Parameters<RoleBindingQueryService['list']>) {
    return this.queries.list(...args);
  }

  async page(...args: Parameters<RoleBindingQueryService['page']>) {
    return this.queries.page(...args);
  }

  async findOne(...args: Parameters<RoleBindingQueryService['findOne']>) {
    return this.queries.findOne(...args);
  }

  async preview(
    user: CurrentUserPayload,
    query: PreviewRoleBindingQueryDto,
  ): Promise<RoleBindingPreviewResponseDto> {
    await this.access.assertCanOrThrow(user, 'role-binding.read.record');
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
    const response = (): RoleBindingPreviewResponseDto => ({
      valid: conflicts.length === 0,
      conflicts,
      resolvedScope: {
        scopeType: query.scopeType,
        scopeOrgId: query.scopeOrgId ?? null,
        scopeActivityId: query.scopeActivityId ?? null,
        scopeResourceType: query.scopeResourceType ?? null,
        scopeResourceId: query.scopeResourceId ?? null,
      },
    });

    // actor-first：无效 non-SA 只得到统一 30102 conflict，不继续探测 principal / role / duplicate。
    await collect(() => this.roleDelegation.assertActorMayDelegate(user, this.prisma));
    if (conflicts.length > 0) return response();

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
        this.roleDelegation.assertTargetRoleMayBeConferred(user, roleForDelegation),
      );
    }

    await collect(() => this.validateScopeEntityOrThrow(this.prisma, query));

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

    return response();
  }

  // ============ F3/C1:POST /api/admin/v1/role-bindings/batch ============

  // 批量建绑定:逐条独立复用 create()(校验 / audit 全走既有单条路径,零旁路),
  // 单条失败不影响其它条(镜像 announcement-import「deny/blocked 是数据」范式):
  //   ok = 已建;already-exists = 撞同维度 ACTIVE 唯一(34002,幂等 skip —— 重跑同一批不报错);
  //   blocked = 其它校验拒(带底层 BizCode + message)。
  // 调用者判权在循环外整批一次(create 内的同码判定经 RbacCache 命中,不放大查询)。
  async createBatch(
    user: CurrentUserPayload,
    dto: BatchCreateRoleBindingsDto,
    meta: AuditMeta,
  ): Promise<BatchCreateRoleBindingsResponseDto> {
    await this.access.assertCanOrThrow(user, 'role-binding.create.record');
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
    await this.access.assertCanOrThrow(user, 'role-binding.create.record');

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
      // actor-first：ops advisory → 锁内复核 actor，之后才允许读取/锁定任何 target。
      await this.roleDelegation.assertActorMayDelegateForWrite(user, tx);
      await this.validatePrincipalOrThrow(tx, dto.principalType, rawPrincipalId, {
        lockLifecycle: true,
      });
      const role = await this.findRoleOrThrow(tx, dto.roleId);
      this.roleDelegation.assertTargetRoleMayBeConferred(user, role);

      await this.validateScopeEntityOrThrow(tx, dto);

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

      return this.access.toResponseDto(created);
    });

    return result;
  }

  // ============ PATCH /api/admin/v1/role-bindings/:id ============

  // 改状态 / 任期 / note(全可选)。不改 principal / role / scope(换绑定 = 软删旧建新)。
  // 找不到未软删记录 → NOT_FOUND;endedAt(新旧综合)须 > startedAt(新旧综合)→ TENURE_INVALID;
  // 改 status→ACTIVE 撞全 scope 维度唯一 → P2002 → ROLE_BINDING_ALREADY_EXISTS。
  // review G7:仅当本次 PATCH 触碰 status/startedAt/endedAt 任一字段时,额外拒绝结果态自相矛盾的
  // 「status=ACTIVE 但 endedAt 已过期」组合(→ TENURE_INVALID);纯改 note 不受影响(不触碰任期/状态字段)。
  async update(user: CurrentUserPayload, id: string, dto: UpdateRoleBindingDto, meta: AuditMeta) {
    await this.access.assertCanOrThrow(user, 'role-binding.update.record');
    const result = await this.prisma.$transaction(async (tx) => {
      let current = await tx.roleBinding.findFirst({
        where: notDeletedWhere({ id }),
        select: {
          ...roleBindingSafeSelect,
          deletedAt: true,
          role: {
            select: {
              code: true,
              deletedAt: true,
              rolePermissions: { select: { permission: { select: { code: true } } } },
            },
          },
        },
      });
      if (!current) throw new BizException(BizCode.ROLE_BINDING_NOT_FOUND);
      this.roleDelegation.assertRoleIsNotSystemManaged(current.role);

      const touchesTenureOrStatus =
        dto.status !== undefined || dto.startedAt !== undefined || dto.endedAt !== undefined;
      const isGlobalUserOpsAdmin =
        current.principalType === PrincipalType.USER &&
        current.principalId !== null &&
        current.scopeType === BindingScopeType.GLOBAL &&
        current.role.code === OPS_ADMIN_ROLE_CODE;
      if (touchesTenureOrStatus && isGlobalUserOpsAdmin) {
        // 固定锁序：ops advisory 必须早于后续 Member → User lifecycle lock。
        // 锁后重新读取 target，后续任期校验与 mutation 均不使用锁前快照。
        await this.lastAdminProtection.acquireOpsAdminInvariantLock(tx);
        const lockedCurrent = await tx.roleBinding.findFirst({
          where: notDeletedWhere({ id }),
          select: {
            ...roleBindingSafeSelect,
            deletedAt: true,
            role: {
              select: {
                code: true,
                deletedAt: true,
                rolePermissions: { select: { permission: { select: { code: true } } } },
              },
            },
          },
        });
        if (!lockedCurrent) throw new BizException(BizCode.ROLE_BINDING_NOT_FOUND);
        current = lockedCurrent;
      }

      const effectiveStartedAt =
        dto.startedAt !== undefined ? new Date(dto.startedAt) : current.startedAt;
      const effectiveEndedAt = dto.endedAt !== undefined ? new Date(dto.endedAt) : current.endedAt;
      if (effectiveEndedAt !== null && effectiveEndedAt.getTime() <= effectiveStartedAt.getTime()) {
        throw new BizException(BizCode.ROLE_BINDING_TENURE_INVALID);
      }

      if (touchesTenureOrStatus) {
        const effectiveStatus = dto.status ?? current.status;
        const now = new Date();
        if (
          effectiveStatus === BindingStatus.ACTIVE &&
          effectiveEndedAt !== null &&
          effectiveEndedAt.getTime() < now.getTime()
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
      const effectiveStatus = dto.status ?? current.status;
      const now = new Date();
      const wasEffective =
        current.status === BindingStatus.ACTIVE &&
        current.startedAt.getTime() <= now.getTime() &&
        (current.endedAt === null || current.endedAt.getTime() >= now.getTime());
      const willBeEffective =
        effectiveStatus === BindingStatus.ACTIVE &&
        effectiveStartedAt.getTime() <= now.getTime() &&
        (effectiveEndedAt === null || effectiveEndedAt.getTime() >= now.getTime());
      if (touchesTenureOrStatus && isGlobalUserOpsAdmin) {
        await this.lastAdminProtection.assertCanUpdateOpsAdminBinding(tx, current, {
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          ...(dto.startedAt !== undefined ? { startedAt: new Date(dto.startedAt) } : {}),
          ...(dto.endedAt !== undefined ? { endedAt: new Date(dto.endedAt) } : {}),
        });
      }
      if (
        effectiveStatus === BindingStatus.ACTIVE &&
        (dto.status !== undefined || dto.startedAt !== undefined || dto.endedAt !== undefined)
      ) {
        await this.validatePrincipalOrThrow(tx, current.principalType, current.principalId, {
          lockLifecycle: true,
        });
      }
      if (
        dto.status === BindingStatus.ACTIVE ||
        ((dto.startedAt !== undefined || dto.endedAt !== undefined) &&
          !wasEffective &&
          willBeEffective)
      ) {
        await this.validateScopeEntityOrThrow(tx, current);
      }
      if ((reactivatesBinding || startsEarlier || endsLater) && isPrivilegedRole(current.role)) {
        await this.roleDelegation.assertActorMayConferRole(user, current.role, tx);
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
      return this.access.toResponseDto(updated);
    });

    return result;
  }

  // ============ DELETE /api/admin/v1/role-bindings/:id ============

  // 软删(冻结稿 §7.5:DELETE = 软删):status=ENDED + endedAt=now + deletedAt=now(保历史;partial unique 释放槽位)。
  // 找不到未软删记录 → NOT_FOUND。建 / 撤销写 audit(role-binding.revoke + extra.viaPath='role-binding')。
  async remove(user: CurrentUserPayload, id: string, meta: AuditMeta) {
    await this.access.assertCanOrThrow(user, 'role-binding.delete.record');
    const result = await this.prisma.$transaction(async (tx) => {
      const current = await tx.roleBinding.findFirst({
        where: notDeletedWhere({ id }),
        select: {
          ...roleBindingSafeSelect,
          deletedAt: true,
          role: { select: { code: true, deletedAt: true } },
        },
      });
      if (!current) throw new BizException(BizCode.ROLE_BINDING_NOT_FOUND);
      this.roleDelegation.assertRoleIsNotSystemManaged(current.role);

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

      return this.access.toResponseDto(updated);
    });

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
