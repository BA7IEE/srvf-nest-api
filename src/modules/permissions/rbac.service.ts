import { Injectable } from '@nestjs/common';
import { BindingScopeType, BindingStatus, PrincipalType, Role } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type {
  EffectiveRoleDto,
  MyPermissionsResponseDto,
  ReloadRbacDto,
  ReloadRbacResponseDto,
} from './rbac.dto';
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
// 历史阶段边界(PR #6 实装时的"本 PR 不做";部分已被后续 PR 收口,勿据以判断当前事实):
// - reload 接口:已于 PR #7 + P0-F 落地(`POST /api/system/v1/rbac/reload`,Service 层 rbac.can())
// - 业务模块接入 `rbac.can()`:已于 P0-F(v0.15.0)完成,不再限于 attachments
// 仍未做(留后续 PR):
// - `GET /api/system/v1/users/:userId/permissions`(管理员查他人;非 D7 §5.1 端点;未实现 —
//   终态前缀沿 Route B system/v1,与现有 system/v1/users/:userId/roles 并列)
// - dept-chief / dept-deputy 层级真实名 seed(PR #8 仅种 ops-admin)
// 当前事实以 docs/current-state.md 与本目录 CLAUDE.md 为准。
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
  // **判权唯一读源(终态 scoped-authz PR6 起,冻结稿 §8.2 行为锁)**:读 RoleBinding
  //   (principalType=USER, scopeType=GLOBAL, status=ACTIVE, 未软删)聚合权限点 —— 等价替换旧
  //   `user_roles` 读(每条 UserRole 已由第 37 migration 回填为该形态的 RoleBinding),**全局判权语义逐字不变**。
  // **🔴 只读 scopeType=GLOBAL,绝不判 scoped**:经 role-bindings CRUD 建的 ORGANIZATION/TREE/ACTIVITY/
  //   RESOURCE/SELF 绑定入库即止,本函数忽略非 GLOBAL 行(scoped 判权是 PR8 AuthzService)。UserRole 表冻结、零读写。
  // **行为**:
  // - SUPER_ADMIN 不在此处特判:本函数总是返回 global RoleBinding 聚合后的实际权限点集
  //   (SUPER_ADMIN 的短路在 `can()` / `getMyPermissions()` 中各自实现,语义不同)
  // - cache miss → 查 DB → set cache;cache hit → 直接返
  // - 排除已软删的 RbacRole(沿 D7 §13 失效场景:RbacRole 软删时 role_bindings 不联动,join 过滤)
  async getUserPermissionCodes(userId: string): Promise<Set<string>> {
    const cached = this.cache.get(userId);
    if (cached !== null) return cached;

    const bindings = await this.prisma.roleBinding.findMany({
      where: {
        principalType: PrincipalType.USER,
        principalId: userId,
        scopeType: BindingScopeType.GLOBAL,
        status: BindingStatus.ACTIVE,
        deletedAt: null,
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
    for (const b of bindings) {
      for (const rp of b.role.rolePermissions) {
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

  // GET /api/system/v1/rbac/me/permissions 入口:返当前用户的有效权限点集 + 角色摘要。
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

  // PR #7:POST /api/system/v1/rbac/reload 入口(沿 D7 v1.1 §5.4 + 用户拍板四项决策)。
  //
  // - scope 默认 'all';三档 all / user / role 与 RbacCacheService 三个 invalidate 方法 1:1
  // - scope='user' 缺 userId / scope='role' 缺 roleId → BAD_REQUEST(40000;沿用户决策方案 A)
  // - userId / roleId 不存在 → 静默成功(invalidateUser 是 Map.delete,no-op;
  //     invalidateAllUsersWithRole 内部已 try-catch + logger.warn,不抛)
  // - 出参恒为 `{ reloaded: true }`(沿用户决策方案 A;为未来扩展字段预留单对象包装)
  //
  // P0-F PR-1(2026-05-18):入口判权迁移到 RBAC `rbac.config.reload` permission;
  // 失败抛 BizException(BizCode.RBAC_FORBIDDEN)(30100)。
  async reload(user: CurrentUserPayload, dto: ReloadRbacDto): Promise<ReloadRbacResponseDto> {
    if (!(await this.can(user, 'rbac.config.reload'))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
    const scope = dto.scope ?? 'all';

    if (scope === 'user') {
      if (!dto.userId) throw new BizException(BizCode.BAD_REQUEST);
      this.cache.invalidateUser(dto.userId);
    } else if (scope === 'role') {
      if (!dto.roleId) throw new BizException(BizCode.BAD_REQUEST);
      // 沿用 invalidateAllUsersWithRole 内部 swallow + logger.warn 语义:
      // DB 故障由 logger 暴露给运维,reload 对外恒返 reloaded=true
      await this.cache.invalidateAllUsersWithRole(dto.roleId);
    } else {
      this.cache.invalidateAll();
    }

    return { reloaded: true };
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
  // 终态 scoped-authz PR6:读 global RoleBinding(等价替换旧 user_roles 读;回填保 createdAt → 排序逐字不变)。
  // 排除已软删的 RbacRole;按 createdAt 升序(与 UserRolesService.list 一致)。只读 GLOBAL,scoped 不计入摘要。
  private async getEffectiveRoles(userId: string): Promise<EffectiveRoleDto[]> {
    const rows = await this.prisma.roleBinding.findMany({
      where: {
        principalType: PrincipalType.USER,
        principalId: userId,
        scopeType: BindingScopeType.GLOBAL,
        status: BindingStatus.ACTIVE,
        deletedAt: null,
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
