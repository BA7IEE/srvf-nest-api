import { Injectable } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { RbacCacheService } from './rbac-cache.service';
import { RbacService } from './rbac.service';
import { AssignUserRoleDto, UserRoleResponseDto } from './user-roles.dto';

// V2.x C-6 RBAC 实施 PR #5:UserRole 模块业务逻辑。
// 沿 D7 v1.1 §5.1 端点 12-14 + §6.2 Q7 角色分级 + §6.3 最后一个 ops-admin 保护 + §9.4 缓存失效 + 用户拍板。
//
// 3 个端点:
//   GET    /api/v2/users/:userId/roles                  查用户角色列表
//   POST   /api/v2/users/:userId/roles                  分配角色(入参 roleCode 单 code)
//   DELETE /api/v2/users/:userId/roles/:roleId          撤销角色
//
// **关键设计**(沿用户拍板):
// 1. **user 失效场景**(沿 v1 §10):user 不存在 / disabled / 已软删 统一返 USER_NOT_FOUND = 10001
// 2. **Q7 角色分级 C2 中庸**(inline canAssignRole 私有 helper):
//    - SUPER_ADMIN(系统级)→ 通过任何
//    - actor 持有 ops-admin(RBAC 角色)→ 可分配/撤销非 ops-admin 目标
//    - 其他(ADMIN / USER / 仅业务角色)→ 30102
//    - dept-chief / dept-deputy 实际层级**不实施**(留 PR #6 + seed 真实名落地)
// 3. **重复分配 → 30006**(D7 §12 锁定,**报错**而非幂等;与 RolePermission 批量幂等不同)
// 4. **最后一个 ops-admin 保护**(沿 D7 §6.3 触发场景 1):
//    - DELETE 撤销 ops-admin 角色时,事务内 count 剩余活跃 ops-admin 持有者数 ≥ 1
//    - 否则抛 30101(沿 v1 §13 最后一个 SUPER_ADMIN 保护范式)

// 运营管理员角色 code(沿 D7 §10.1 placeholder seed;`.env.seed.local` 真实角色名不变此 code)
const OPS_ADMIN_CODE = 'ops-admin';

@Injectable()
export class UserRolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: RbacCacheService,
    private readonly rbac: RbacService,
  ) {}

  // ============ helpers ============

  // P0-F PR-1:RBAC 元接口入口判权(沿 attachments F5 v1.0 范本)。
  // 与 canAssignRole(Q7 角色分级业务保护)是两层独立校验:
  // - 本 helper 拦"actor 是否有权进入 user-role 管理接口"(rbac.* permission)
  // - canAssignRole 拦"actor 能分配 / 撤销哪些 RBAC 角色"(目标角色分级)
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
  private async findRoleOrThrow(
    roleId: string,
  ): Promise<{ id: string; code: string; displayName: string }> {
    const raw = await this.prisma.rbacRole.findUnique({
      where: { id: roleId },
      select: { id: true, code: true, displayName: true, deletedAt: true },
    });
    if (!raw) throw new BizException(BizCode.ROLE_NOT_FOUND);
    if (raw.deletedAt !== null) throw new BizException(BizCode.ROLE_DELETED);
    return { id: raw.id, code: raw.code, displayName: raw.displayName };
  }

  // 沿 PR #3 范式:按 code 查 role(POST 入参 roleCode);软删的视为不存在(沿 v1 §10 信息泄漏防御
  // — POST 时用户传 code,如果该 code 是已软删角色,不应披露存在过)。
  private async findActiveRoleByCodeOrThrow(
    code: string,
  ): Promise<{ id: string; code: string; displayName: string }> {
    const role = await this.prisma.rbacRole.findFirst({
      where: { code, deletedAt: null },
      select: { id: true, code: true, displayName: true },
    });
    if (!role) throw new BizException(BizCode.ROLE_NOT_FOUND);
    return role;
  }

  // Q7 角色分级 C2 中庸方案(沿用户拍板;inline private helper)。
  //
  // 注:P0-F PR-1 起入口 Guard `@Roles` 已撤;`assertCanOrThrow('rbac.user-role.*')`
  // 已挡 v1 USER 系统级(USER 默认无 rbac.* permission)。本函数仅做"角色目标 vs 来源"
  // 的二次业务级判定,**不再依赖 Guard 前置**。
  private async canAssignRole(actor: CurrentUserPayload, targetRoleCode: string): Promise<boolean> {
    // 1. SUPER_ADMIN(系统级)→ 通过任何
    if (actor.role === Role.SUPER_ADMIN) return true;

    // 2. 查 actor 持有的活跃 RBAC 角色(排除已软删角色)
    const actorRoles = await this.prisma.userRole.findMany({
      where: {
        userId: actor.id,
        role: { deletedAt: null },
      },
      select: { role: { select: { code: true } } },
    });
    const hasOpsAdmin = actorRoles.some((ur) => ur.role.code === OPS_ADMIN_CODE);

    // 3. actor 持有 ops-admin → 可分配/撤销非 ops-admin 目标
    if (hasOpsAdmin && targetRoleCode !== OPS_ADMIN_CODE) return true;

    // 4. 其他 → 30102(C2 中庸:不实施 dept-chief / dept-deputy 层级)
    return false;
  }

  // ============ 3 端点 ============

  async list(actor: CurrentUserPayload, userId: string): Promise<UserRoleResponseDto[]> {
    await this.assertCanOrThrow(actor, 'rbac.user-role.read');
    // 1. user 必须存在 + 未 disabled + 未软删
    await this.assertUserAccessibleOrThrow(userId);

    // 2. 查 user 持有的活跃 RBAC 角色(排除已软删的 role;沿 §13 失效场景:
    //    schema RbacRole 软删时 user_roles 不联动,所以这里 join 过滤)
    const userRoles = await this.prisma.userRole.findMany({
      where: {
        userId,
        role: { deletedAt: null },
      },
      select: {
        id: true,
        roleId: true,
        createdAt: true,
        createdBy: true,
        role: { select: { code: true, displayName: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return userRoles.map((ur) => ({
      id: ur.id,
      roleId: ur.roleId,
      roleCode: ur.role.code,
      roleDisplayName: ur.role.displayName,
      createdAt: ur.createdAt,
      createdByUserId: ur.createdBy,
    }));
  }

  async assign(
    actor: CurrentUserPayload,
    targetUserId: string,
    dto: AssignUserRoleDto,
  ): Promise<UserRoleResponseDto> {
    // 0. RBAC 入口判权(P0-F PR-1):actor 是否能进入 user-role 分配接口
    await this.assertCanOrThrow(actor, 'rbac.user-role.create');

    // 1. Q7 角色分级判定(canAssignRole)— 进入接口后的二次业务级保护
    const canAssign = await this.canAssignRole(actor, dto.roleCode);
    if (!canAssign) throw new BizException(BizCode.CANNOT_ASSIGN_HIGHER_ROLE);

    // 2. target user 必须存在 + 未 disabled + 未软删
    await this.assertUserAccessibleOrThrow(targetUserId);

    // 3. target role 必须存在 + 未软删(按 code 查 — POST 入参是 roleCode)
    const role = await this.findActiveRoleByCodeOrThrow(dto.roleCode);

    // 4. 检查重复分配(沿 D7 §12 锁定:报错而非幂等)
    const existing = await this.prisma.userRole.findUnique({
      where: { userId_roleId: { userId: targetUserId, roleId: role.id } },
      select: { id: true },
    });
    if (existing) throw new BizException(BizCode.USER_ROLE_ALREADY_EXISTS);

    // 5. 写入(createdBy 记 actor;沿 D11 audit 字段)
    const created = await this.prisma.userRole.create({
      data: {
        userId: targetUserId,
        roleId: role.id,
        createdBy: actor.id,
      },
      select: {
        id: true,
        roleId: true,
        createdAt: true,
        createdBy: true,
      },
    });

    // 6. 缓存失效(沿 D7 §9.4):单用户 cache 自动失效
    this.cache.invalidateUser(targetUserId);

    return {
      id: created.id,
      roleId: created.roleId,
      roleCode: role.code,
      roleDisplayName: role.displayName,
      createdAt: created.createdAt,
      createdByUserId: created.createdBy,
    };
  }

  async revoke(
    actor: CurrentUserPayload,
    targetUserId: string,
    targetRoleId: string,
  ): Promise<UserRoleResponseDto> {
    // 0. RBAC 入口判权(P0-F PR-1):actor 是否能进入 user-role 撤销接口
    await this.assertCanOrThrow(actor, 'rbac.user-role.delete');

    // 1. target user 必须存在 + 未 disabled + 未软删
    await this.assertUserAccessibleOrThrow(targetUserId);

    // 2. target role 必须存在 + 未软删(按 id 查 — DELETE 路径是 roleId)
    const role = await this.findRoleOrThrow(targetRoleId);

    // 3. Q7 角色分级判定(此时已拿到 role.code)
    const canRevoke = await this.canAssignRole(actor, role.code);
    if (!canRevoke) throw new BizException(BizCode.CANNOT_ASSIGN_HIGHER_ROLE);

    // 4. 关系存在性 + 最后一个 ops-admin 保护 + delete 必须原子(沿 v1 §13 范式)
    return this.prisma.$transaction(async (tx) => {
      // 4a. 关系必须存在
      const existing = await tx.userRole.findUnique({
        where: { userId_roleId: { userId: targetUserId, roleId: targetRoleId } },
        select: { id: true, createdAt: true, createdBy: true },
      });
      if (!existing) throw new BizException(BizCode.USER_ROLE_NOT_FOUND);

      // 4b. 如果撤销的是 ops-admin 角色,事务内 count 剩余活跃 ops-admin 持有者数 ≥ 1
      //     (排除当前正在撤销的 targetUser;沿 D7 §6.3 + v1 §13 范式)
      if (role.code === OPS_ADMIN_CODE) {
        const remainingActiveOpsAdmins = await tx.userRole.count({
          where: {
            role: { code: OPS_ADMIN_CODE, deletedAt: null },
            user: { deletedAt: null, status: UserStatus.ACTIVE },
            NOT: { userId: targetUserId },
          },
        });
        if (remainingActiveOpsAdmins === 0) {
          throw new BizException(BizCode.LAST_OPS_ADMIN_PROTECTED);
        }
      }

      // 4c. 删除关系(物理删;沿 D4 v1.0 UserRole 物理删)
      await tx.userRole.delete({
        where: { userId_roleId: { userId: targetUserId, roleId: targetRoleId } },
      });

      // 4d. 缓存失效(事务外亦可,这里事务内更精确;沿 D7 §9.4)
      this.cache.invalidateUser(targetUserId);

      return {
        id: existing.id,
        roleId: targetRoleId,
        roleCode: role.code,
        roleDisplayName: role.displayName,
        createdAt: existing.createdAt,
        createdByUserId: existing.createdBy,
      };
    });
  }
}
