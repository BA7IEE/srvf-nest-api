import { Injectable } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../database/prisma.service';
import type { EffectiveRoleDto, MyPermissionsResponseDto } from './rbac.dto';
import { RbacCacheService } from './rbac-cache.service';

// V2.x C-6 RBAC 实施 PR #6:RbacService 判权核心。
// 沿 D7 v1.1 §7.1 判权优先级 + §8 judge 函数 + §9 缓存策略 + 用户拍板三项决策。
//
// **本 PR 范围**(沿用户拍板任务边界):
// - getUserPermissionCodes(userId) → Set<string>:走 RbacCacheService(get/set 闭环)
// - can(user, action, resource?) → boolean:实装短路 / 缓存 / .self ownership
// - judge(user, action, resource?) → RbacJudgeResult:同 can 但返详细原因
// - checkOwnership(user, resource):.self 路径 ownership 判定(沿 D7 §8.3 字段映射)
// - getMyPermissions(user) → MyPermissionsResponseDto:GET /me/permissions 入口
//
// **本 PR 不做**(沿用户拍板):
// - 不实现 reload 接口(留 PR #7;`POST /api/v2/rbac/reload`)
// - 不实现 `GET /api/v2/users/:userId/permissions`(管理员查他人;非 D7 §5.1 端点)
// - 不接入 dept-chief / dept-deputy 层级(seed 真实名留 PR #8)
// - 不在任何业务模块(14 个 RBAC CRUD + V2 79 接口)上接 `rbac.can()`(沿 F9 + PR 边界)
//
// **判权优先级**(沿 D7 v1.1 §7.1):
//   1. SUPER_ADMIN 短路(`user.role === SUPER_ADMIN` → 自动通过)
//   2. ADMIN 自动继承 USER 权限 → seed PR #8 通过给 ADMIN 内置角色配 USER 级权限点实现,
//      RbacService 本身不需要特判(本 PR 阶段 seed 未实施,ADMIN 在 RBAC 表上无任何角色,
//      聚合查询返空集 — 符合 D7 §8.2 "本判权步骤不需要特殊处理" 描述)
//   3. RBAC 细粒度:`user_roles` → `role_permissions` → `permissions` 聚合,精确匹配 action
//   4. .self 后缀:命中 action 后,检查 owner 是否匹配 user.id / user.memberId

// 沿 D7 v1.1 §8.1 函数签名
export interface RbacResource {
  ownerType?: 'user' | 'member';
  ownerId?: string;
}

export type RbacJudgeReason =
  | 'super_admin_pass'
  | 'admin_inherits_user'
  | 'has_permission'
  | 'self_match'
  | 'no_permission';

export interface RbacJudgeResult {
  allowed: boolean;
  reason: RbacJudgeReason;
}

@Injectable()
export class RbacService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: RbacCacheService,
  ) {}

  // ============ 公开 API ============

  // 取当前用户的有效权限点集合(走缓存)。
  //
  // **行为**:
  // - SUPER_ADMIN 不在此处特判:本函数总是返回 user_roles 聚合后的实际权限点集
  //   (SUPER_ADMIN 的短路在 `can()` / `getMyPermissions()` 中各自实现,语义不同)
  // - cache miss → 查 DB → set cache;cache hit → 直接返
  // - 排除已软删的 RbacRole(沿 D7 §13 失效场景:RbacRole 软删时 user_roles 不联动,join 过滤)
  async getUserPermissionCodes(userId: string): Promise<Set<string>> {
    const cached = this.cache.get(userId);
    if (cached !== null) return cached;

    const userRoles = await this.prisma.userRole.findMany({
      where: {
        userId,
        role: { deletedAt: null },
      },
      select: {
        role: {
          select: {
            rolePermissions: {
              select: {
                permission: { select: { code: true } },
              },
            },
          },
        },
      },
    });

    const codes = new Set<string>();
    for (const ur of userRoles) {
      for (const rp of ur.role.rolePermissions) {
        codes.add(rp.permission.code);
      }
    }

    this.cache.set(userId, codes);
    return codes;
  }

  // 判权主函数(沿 D7 §8.2 实现伪代码)。
  async can(user: CurrentUserPayload, action: string, resource?: RbacResource): Promise<boolean> {
    const result = await this.judge(user, action, resource);
    return result.allowed;
  }

  // 同 can() 但返详细原因(用于审计 / 调试 / 单元测试断言)。
  async judge(
    user: CurrentUserPayload,
    action: string,
    resource?: RbacResource,
  ): Promise<RbacJudgeResult> {
    // 1. SUPER_ADMIN 短路(沿 D7 §7.1 step 1 + §8.2 step 1)
    if (user.role === Role.SUPER_ADMIN) {
      return { allowed: true, reason: 'super_admin_pass' };
    }

    // 2. 取用户的有效权限点(走缓存;沿 D7 §8.2 step 2)。
    //    ADMIN 继承 USER 权限(D7 §7.1 step 2 / §8.2 step 3)由 seed PR #8 实装
    //    (给 ADMIN 内置角色配 USER 级权限点),本函数对 ADMIN 不特判 — 表里有什么就用什么。
    const permissions = await this.getUserPermissionCodes(user.id);

    // 3. 精确匹配(沿 D7 §8.2 step 4)
    if (!permissions.has(action)) {
      return { allowed: false, reason: 'no_permission' };
    }

    // 4. .self 后缀检查 ownership(沿 D7 §8.2 step 5 + §8.3 字段映射)。
    //    action 以 `.self` 结尾时,必须提供 resource 且 owner 匹配;否则 fail-close。
    if (action.endsWith('.self')) {
      if (!resource || resource.ownerType === undefined || resource.ownerId === undefined) {
        return { allowed: false, reason: 'no_permission' };
      }
      if (!this.checkOwnership(user, resource)) {
        return { allowed: false, reason: 'no_permission' };
      }
      return { allowed: true, reason: 'self_match' };
    }

    return { allowed: true, reason: 'has_permission' };
  }

  // GET /api/v2/rbac/me/permissions 入口:返当前用户的有效权限点集 + 角色摘要。
  //
  // **SUPER_ADMIN 处理**(沿用户拍板方案 B):
  // - `permissions`:返 DB 中 `Permission.code` 全集(短路语义实体化;不返 ["*"];不返空数组)
  // - `effectiveRoles`:仍按 user_roles 查询(SUPER_ADMIN 通常未持任何 RBAC 角色,返空数组)
  //
  // **非 SUPER_ADMIN**:`permissions` 走 getUserPermissionCodes(走缓存);`effectiveRoles` 查表。
  async getMyPermissions(user: CurrentUserPayload): Promise<MyPermissionsResponseDto> {
    const permissions =
      user.role === Role.SUPER_ADMIN
        ? await this.getAllPermissionCodes()
        : Array.from(await this.getUserPermissionCodes(user.id)).sort();

    const effectiveRoles = await this.getEffectiveRoles(user.id);

    return { permissions, effectiveRoles };
  }

  // ============ 内部 helpers ============

  // checkOwnership(沿 D7 §8.2 + §8.3):
  // - ownerType=user:resource.ownerId === user.id
  // - ownerType=member:resource.ownerId === user.memberId(可能 null)
  // - 未知 ownerType / 未绑定 memberId → fail-close
  private checkOwnership(user: CurrentUserPayload, resource: RbacResource): boolean {
    if (resource.ownerType === 'user') {
      return resource.ownerId === user.id;
    }
    if (resource.ownerType === 'member') {
      if (user.memberId === null) return false;
      return resource.ownerId === user.memberId;
    }
    return false;
  }

  // SUPER_ADMIN me/permissions 返 Permission.code 全集(沿用户拍板方案 B)。
  // 物理删的 Permission 自然不在列(D4 v1.0 Permission 物理删)。
  private async getAllPermissionCodes(): Promise<string[]> {
    const all = await this.prisma.permission.findMany({
      select: { code: true },
      orderBy: { code: 'asc' },
    });
    return all.map((p) => p.code);
  }

  // 查当前用户持有的 RBAC 业务角色摘要(沿 D7 §5.2.6 嵌套结构)。
  // 排除已软删的 RbacRole;按 createdAt 升序(与 UserRolesService.list 一致)。
  private async getEffectiveRoles(userId: string): Promise<EffectiveRoleDto[]> {
    const rows = await this.prisma.userRole.findMany({
      where: {
        userId,
        role: { deletedAt: null },
      },
      select: {
        role: { select: { code: true, displayName: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({ code: r.role.code, displayName: r.role.displayName }));
  }
}
