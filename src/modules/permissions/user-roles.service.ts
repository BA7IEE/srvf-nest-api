import { Injectable } from '@nestjs/common';
import {
  BindingScopeType,
  BindingStatus,
  MemberStatus,
  PrincipalType,
  Prisma,
  UserStatus,
} from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditContext, AuditLogEvent, AuditMeta } from '../audit-logs/audit-logs.types';
import { lockMemberLifecycle, lockLiveUserLifecycle } from '../members/member-lifecycle-lock';
import { LastAdminProtectionPolicy } from './last-admin-protection.policy';
import { RbacService } from './rbac.service';
import { RoleDelegationPolicy, type RoleDelegationTarget } from './role-delegation.policy';
import { AssignUserRoleDto, UserRoleResponseDto } from './user-roles.dto';

// V2.x C-6 RBAC 实施 PR #5:UserRole 模块业务逻辑。
// 沿 D7 v1.1 §5.1 端点 12-14 + §6.2 Q7 角色分级 + §6.3 最后一个 ops-admin 保护 + 用户拍板。
//
// **终态 scoped-authz PR6(2026-07-01;冻结稿 §8.2 行为锁):内部换存储,对外契约零变。**
// - 全部读 / 写从旧 `user_roles` 重指向 `RoleBinding(principalType=USER, scopeType=GLOBAL, status=ACTIVE)`
//   —— 旧 UserRole 表已 DROP(冻结表 cleanup,第 39 migration);单一真相源 = RoleBinding。
// - 端点路径 + 权限码(rbac.user-role.{read,create,delete})+ 请求/响应 DTO **逐字不变**。
// - 撤销 = **软删**(status=ENDED + endedAt + deletedAt),保历史;partial unique WHERE deletedAt IS NULL AND
//   status='ACTIVE' 令软删行不阻断再分配 = 与旧「物理删后可再分配」外部行为一致。
// - 建 / 撤销写 audit(resourceType='role_binding';event role-binding.{create,revoke} + extra.viaPath='user-role';
//   沿冻结稿 §10.6 / DoD#7)。
//
// 3 个端点:
//   GET    /api/system/v1/users/:userId/roles                  查用户角色列表
//   POST   /api/system/v1/users/:userId/roles                  分配角色(入参 roleCode 单 code)
//   DELETE /api/system/v1/users/:userId/roles/:roleId          撤销角色
//
// **关键设计**(沿用户拍板):
// 1. **user 失效场景**(沿 v1 §10):user 不存在 / disabled / 已软删 统一返 USER_NOT_FOUND = 10001
// 2. **Q7 角色分级 C2 中庸**(inline canAssignRole 私有 helper):
//    - SUPER_ADMIN(系统级)→ 通过任何
//    - actor 持有 ops-admin(RBAC 角色)→ 可分配/撤销非 ops-admin 目标
//    - 其他(ADMIN / USER / 仅业务角色)→ 30102
// 3. **重复分配 → 30006**(D7 §12 锁定,**报错**而非幂等;与 RolePermission 批量幂等不同)
// 4. **最后一个 ops-admin 保护**(沿 D7 §6.3 触发场景 1):
//    - DELETE 撤销 ops-admin 角色时,与 role-bindings/users 共用 advisory lock 后重算,剩余活跃持有者数 ≥ 1
//    - 否则抛 30101(沿 v1 §13 最后一个 SUPER_ADMIN 保护范式)

type PrismaTx = Prisma.TransactionClient;
type UserRoleDelegationTarget = RoleDelegationTarget & {
  id: string;
  displayName: string;
};

@Injectable()
export class UserRolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly roleDelegation: RoleDelegationPolicy,
    private readonly lastAdminProtection: LastAdminProtectionPolicy,
  ) {}

  // ============ helpers ============

  // 判权读源单一真相 = RoleBinding(principalType=USER, scopeType=GLOBAL, status=ACTIVE, 未软删)。
  // 各查询点复用本 where 基座,避免遗漏 scope / status / 软删过滤(否则 scoped/失效绑定误入 user-role 面)。
  private activeGlobalUserWhere(principalId?: string): Prisma.RoleBindingWhereInput {
    return {
      principalType: PrincipalType.USER,
      scopeType: BindingScopeType.GLOBAL,
      status: BindingStatus.ACTIVE,
      deletedAt: null,
      ...(principalId !== undefined ? { principalId } : {}),
    };
  }

  // P0-F PR-1:RBAC 元接口入口判权(沿 attachments F5 v1.0 范本)。
  // 与 RoleDelegationPolicy(角色分级业务保护)是两层独立校验:
  // - 本 helper 拦"actor 是否有权进入 user-role 管理接口"(rbac.* permission)
  // - RoleDelegationPolicy 拦"actor 能分配 / 撤销哪些 RBAC 角色"(目标角色分级)
  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  // 沿 v1 §10:user 不存在 / disabled / 已软删 统一抛 USER_NOT_FOUND(10001),
  // 信息泄漏防御(避免告知"该 user id 曾存在 / 已被禁用 / 已软删")。
  private async assertUserAccessibleOrThrow(userId: string): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: {
        id: userId,
        deletedAt: null,
        status: UserStatus.ACTIVE,
      },
      select: { id: true },
    });
    if (!user) throw new BizException(BizCode.USER_NOT_FOUND);
  }

  // 沿 PR #3 RbacRole 范式:role 不存在 → 30003;role 已软删 → 30005(写操作披露)。
  private async findRoleOrThrow(roleId: string): Promise<UserRoleDelegationTarget> {
    const raw = await this.prisma.rbacRole.findUnique({
      where: { id: roleId },
      select: {
        id: true,
        code: true,
        displayName: true,
        deletedAt: true,
        rolePermissions: { select: { permission: { select: { code: true } } } },
      },
    });
    if (!raw) throw new BizException(BizCode.ROLE_NOT_FOUND);
    if (raw.deletedAt !== null) throw new BizException(BizCode.ROLE_DELETED);
    const { deletedAt, ...role } = raw;
    void deletedAt;
    return role;
  }

  // 沿 PR #3 范式:按 code 查 role(POST 入参 roleCode);软删的视为不存在(沿 v1 §10 信息泄漏防御
  // — POST 时用户传 code,如果该 code 是已软删角色,不应披露存在过)。
  private async findActiveRoleByCodeOrThrow(code: string): Promise<UserRoleDelegationTarget> {
    const role = await this.prisma.rbacRole.findFirst({
      where: { code, deletedAt: null },
      select: {
        id: true,
        code: true,
        displayName: true,
        rolePermissions: { select: { permission: { select: { code: true } } } },
      },
    });
    if (!role) throw new BizException(BizCode.ROLE_NOT_FOUND);
    return role;
  }

  // 审计直写(终态 scoped-authz PR6):user-role assign/remove 现经 RoleBinding,写 audit(冻结稿 §10.6 / DoD#7)。
  // **为何不注入 AuditLogsService**:AuditLogsModule 已 import PermissionsModule(取 RbacService 供 list/findOne 判权),
  //   本模块反向 import AuditLogsModule 会成模块环;本仓 forwardRef 零使用(简单显式原则)。故此处按
  //   AuditContext 锁形(audit-logs.types,仅类型 import,无 DI/模块依赖)**直写** auditLog —— log() 写入路径本就是
  //   薄封装(不接 rbac.can),等价复刻其 context 构造。resourceType 恒 'role_binding';event ⊆ 闭 union AuditLogEvent。
  private async writeRoleBindingAudit(
    client: PrismaTx,
    input: {
      event: AuditLogEvent;
      actor: CurrentUserPayload;
      resourceId: string;
      meta: AuditMeta;
      before?: Record<string, unknown>;
      after?: Record<string, unknown>;
      extra?: Record<string, unknown>;
    },
  ): Promise<void> {
    const context: AuditContext = {
      requestId: input.meta.requestId,
      ip: input.meta.ip,
      ua: input.meta.ua,
    };
    if (input.before !== undefined) context.before = input.before;
    if (input.after !== undefined) context.after = input.after;
    if (input.extra !== undefined) context.extra = input.extra;
    await client.auditLog.create({
      data: {
        actorUserId: input.actor.id,
        actorRoleSnap: input.actor.role,
        resourceType: 'role_binding',
        resourceId: input.resourceId,
        event: input.event,
        context: context as unknown as Prisma.InputJsonValue,
      },
    });
  }

  // ============ 3 端点 ============

  async list(actor: CurrentUserPayload, userId: string): Promise<UserRoleResponseDto[]> {
    await this.assertCanOrThrow(actor, 'rbac.user-role.read');
    // 1. user 必须存在 + 未 disabled + 未软删
    await this.assertUserAccessibleOrThrow(userId);

    // 2. 查 user 持有的活跃 RBAC 角色(global RoleBinding;排除已软删的 role;沿 §13 失效场景 join 过滤)。
    //    orderBy createdAt asc:回填保源 createdAt → 现有行排序逐字不变(行为锁)。
    const bindings = await this.prisma.roleBinding.findMany({
      where: { ...this.activeGlobalUserWhere(userId), role: { deletedAt: null } },
      select: {
        id: true,
        roleId: true,
        createdAt: true,
        createdByUserId: true,
        role: { select: { code: true, displayName: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return bindings.map((b) => ({
      id: b.id,
      roleId: b.roleId,
      roleCode: b.role.code,
      roleDisplayName: b.role.displayName,
      createdAt: b.createdAt,
      createdByUserId: b.createdByUserId,
    }));
  }

  async assign(
    actor: CurrentUserPayload,
    targetUserId: string,
    dto: AssignUserRoleDto,
    meta: AuditMeta,
  ): Promise<UserRoleResponseDto> {
    // 0. RBAC 入口判权(P0-F PR-1):actor 是否能进入 user-role 分配接口
    await this.assertCanOrThrow(actor, 'rbac.user-role.create');

    // 1. target role 必须存在 + 未软删(按 code 查 — POST 入参是 roleCode)
    const role = await this.findActiveRoleByCodeOrThrow(dto.roleCode);

    // 2. 单一委派入口:SA 短路；ops-admin 仅能授予不含控制面权限的普通角色。
    await this.roleDelegation.assertActorMayConferRole(actor, role);

    // 3. target user 必须存在 + 未 disabled + 未软删
    await this.assertUserAccessibleOrThrow(targetUserId);

    // 4. 检查重复分配(沿 D7 §12 锁定:报错而非幂等)—— 读 active global 绑定(软删/失效行不算重复,可再分配)。
    const existing = await this.prisma.roleBinding.findFirst({
      where: { ...this.activeGlobalUserWhere(targetUserId), roleId: role.id },
      select: { id: true },
    });
    if (existing) throw new BizException(BizCode.USER_ROLE_ALREADY_EXISTS);

    // 5. 写入 global RoleBinding + audit(事务内原子;createdByUserId 记 actor;沿 D11 audit 字段)。
    const created = await this.prisma.$transaction(async (tx) => {
      const initialUser = await tx.user.findFirst({
        where: { id: targetUserId, deletedAt: null },
        select: { memberId: true },
      });
      if (!initialUser) throw new BizException(BizCode.USER_NOT_FOUND);
      if (initialUser.memberId !== null) {
        await lockMemberLifecycle(tx, initialUser.memberId);
      }
      await lockLiveUserLifecycle(tx, targetUserId);
      const lockedUser = await tx.user.findFirst({
        where: { id: targetUserId, deletedAt: null, status: UserStatus.ACTIVE },
        select: { memberId: true },
      });
      if (!lockedUser) throw new BizException(BizCode.USER_NOT_FOUND);
      if (lockedUser.memberId !== null) {
        const member = await tx.member.findFirst({
          where: { id: lockedUser.memberId, deletedAt: null },
          select: { status: true },
        });
        if (!member || member.status !== MemberStatus.ACTIVE) {
          throw new BizException(BizCode.MEMBER_INACTIVE);
        }
      }

      const row = await tx.roleBinding.create({
        data: {
          principalType: PrincipalType.USER,
          principalId: targetUserId,
          roleId: role.id,
          scopeType: BindingScopeType.GLOBAL,
          status: BindingStatus.ACTIVE,
          createdByUserId: actor.id,
        },
        select: { id: true, roleId: true, createdAt: true, createdByUserId: true },
      });
      await this.writeRoleBindingAudit(tx, {
        event: 'role-binding.create',
        actor,
        resourceId: row.id,
        meta,
        after: {
          principalType: PrincipalType.USER,
          principalId: targetUserId,
          roleId: role.id,
          scopeType: BindingScopeType.GLOBAL,
          status: BindingStatus.ACTIVE,
        },
        extra: { viaPath: 'user-role', operation: 'create', targetUserId },
      });
      return row;
    });

    return {
      id: created.id,
      roleId: created.roleId,
      roleCode: role.code,
      roleDisplayName: role.displayName,
      createdAt: created.createdAt,
      createdByUserId: created.createdByUserId,
    };
  }

  async revoke(
    actor: CurrentUserPayload,
    targetUserId: string,
    targetRoleId: string,
    meta: AuditMeta,
  ): Promise<UserRoleResponseDto> {
    // 0. RBAC 入口判权(P0-F PR-1):actor 是否能进入 user-role 撤销接口
    await this.assertCanOrThrow(actor, 'rbac.user-role.delete');

    // 1. target user 必须存在 + 未 disabled + 未软删
    await this.assertUserAccessibleOrThrow(targetUserId);

    // 2. target role 必须存在 + 未软删(按 id 查 — DELETE 路径是 roleId)
    const role = await this.findRoleOrThrow(targetRoleId);

    // 3. 赋予/撤销共用同一个委派入口。
    await this.roleDelegation.assertActorMayConferRole(actor, role);

    // 4. 关系存在性 + 最后一个 ops-admin 保护 + 软删必须原子(沿 v1 §13 范式)
    return this.prisma.$transaction(async (tx) => {
      // 4a. 关系必须存在(active global 绑定)
      const existing = await tx.roleBinding.findFirst({
        where: { ...this.activeGlobalUserWhere(targetUserId), roleId: targetRoleId },
        select: { id: true, createdAt: true, createdByUserId: true },
      });
      if (!existing) throw new BizException(BizCode.USER_ROLE_NOT_FOUND);

      // 4b. 与 role-bindings / users 削权路径共用同一 advisory lock + 锁后计数策略。
      await this.lastAdminProtection.assertCanRemoveOpsAdminBinding(tx, {
        id: existing.id,
        principalType: PrincipalType.USER,
        principalId: targetUserId,
        scopeType: BindingScopeType.GLOBAL,
        status: BindingStatus.ACTIVE,
        role: { code: role.code },
      });

      // 4c. 软删(终态 scoped-authz PR6:status=ENDED + endedAt + deletedAt,保历史;
      //     外部行为等同旧物理删 —— judgment/list 只读 active,软删行不再出现,partial unique 释放槽位可再分配)。
      const now = new Date();
      await tx.roleBinding.update({
        where: { id: existing.id },
        data: { status: BindingStatus.ENDED, endedAt: now, deletedAt: now },
      });

      // 4d. audit(建 / 撤销写;沿冻结稿 §10.6 / DoD#7;resourceType='role_binding' + extra.viaPath='user-role')
      await this.writeRoleBindingAudit(tx, {
        event: 'role-binding.revoke',
        actor,
        resourceId: existing.id,
        meta,
        before: { status: BindingStatus.ACTIVE },
        after: { status: BindingStatus.ENDED, endedAt: now },
        extra: { viaPath: 'user-role', operation: 'revoke', targetUserId },
      });

      return {
        id: existing.id,
        roleId: targetRoleId,
        roleCode: role.code,
        roleDisplayName: role.displayName,
        createdAt: existing.createdAt,
        createdByUserId: existing.createdByUserId,
      };
    });
  }
}
