import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PermissionsController } from './permissions.controller';
import { PermissionsService } from './permissions.service';
import { LastAdminProtectionPolicy } from './last-admin-protection.policy';
import { RbacCacheService } from './rbac-cache.service';
import { RbacController } from './rbac.controller';
import { RbacService } from './rbac.service';
import { RbacRolesController } from './rbac-roles.controller';
import { RbacRolesService } from './rbac-roles.service';
import { RoleDelegationPolicy } from './role-delegation.policy';
import { RolePermissionsController } from './role-permissions.controller';
import { RolePermissionsService } from './role-permissions.service';
import { UserRolesController } from './user-roles.controller';
import { UserRolesService } from './user-roles.service';

// V2.x C-6 RBAC permissions 模块声明。
// 沿 D7 v1.1 §4.1-§4.4 / §5.1 端点 1-14 / §6.2 Q7 / §6.3 / §9 缓存策略 / D4 软删决议。
//
// 已实装(累计):
// - PR #2(2026-05-14):Permission CRUD(端点 1-4;路径 /api/system/v1/permissions;BizCode 30001/30002/30008)
// - PR #3(2026-05-14):RbacRole CRUD(端点 5-9;路径 /api/system/v1/roles;BizCode 30003/30004/30005/30009)
// - PR #4(2026-05-14):RolePermission 关联表(端点 10-11;路径 /api/system/v1/roles/:id/permissions[/:permissionId];
//   BizCode 30011)+ RbacCacheService skeleton(Map + TTL + invalidate 入口;
//   完整 rbac.can() 留 PR #6)
// - PR #5(2026-05-14):UserRole CRUD(端点 12-14;路径 /api/system/v1/users/:userId/roles[/:roleId];
//   BizCode 30006/30007/30101/30102)+ Q7 角色分级 C2 中庸 + 最后一个 ops-admin 保护 +
//   接入 RbacCacheService.invalidateUser
// - PR #6(2026-05-14):RbacService + GET /api/system/v1/rbac/me/permissions(端点 15;
//   BizCode 30100 段位预留)+ RbacCacheService 接入 RBAC_CACHE_TTL_SECONDS env +
//   CurrentUserPayload.memberId 扩展
// - PR #7(2026-05-14):POST /api/system/v1/rbac/reload(端点 16;沿 D7 §5.4 三档 scope
//   all / user(+userId) / role(+roleId);入口 @Roles(SUPER_ADMIN, ADMIN),
//   rbac.can() 接入留后续 PR)
//
// RBAC 业务判权 / seed 接入进度(上方逐 PR 注释为历史记录,勿据以判断当前事实):
// - 14 个 RBAC CRUD 接 `rbac.can()`:**已于 P0-F(v0.15.0)完成**
// - 14 条 rbac.* permission seed + `ops-admin` 角色 + bootstrap:**已于 PR #8 完成**
// 仍未做(留后续 PR):
// - ADMIN 内置角色配 USER 级权限(Slow-3;等业务方拍板)
// 当前事实以 docs/current-state.md 与本目录 CLAUDE.md 为准。
//
// 本模块归口设计(沿 dictionaries 单模块多 controller 范式):
// - 同一 PermissionsModule 同时管理 Permission + RbacRole + RolePermission + RbacService,
//   加上 UserRolesService(终态 scoped-authz PR6 起读写 RoleBinding 的 USER×GLOBAL 子集;
//   RoleBinding 全量 CRUD 归口独立的 role-bindings/ 模块)
//   (语义紧耦合,都是 RBAC 配置中心)
// - 多 controller / 多 service:permissions.* + rbac-roles.* + role-permissions.* + user-roles.* + rbac.*
// - RbacCacheService 是模块内共享 provider,被 RolePermissionsService + UserRolesService
//   (PR #4-#5)+ RbacService(PR #6)+ ReloadController(PR #7)共同消费
@Module({
  imports: [DatabaseModule],
  controllers: [
    PermissionsController,
    RbacRolesController,
    RolePermissionsController,
    UserRolesController,
    RbacController,
  ],
  providers: [
    PermissionsService,
    RbacRolesService,
    RolePermissionsService,
    UserRolesService,
    RbacCacheService,
    RbacService,
    RoleDelegationPolicy,
    LastAdminProtectionPolicy,
  ],
  // export RbacService 供业务模块在 Service 层接入 rbac.can()
  // (D7 v1.1 §8 / D7-attachments §6.2;首个消费方 AttachmentsModule,P0-F 后已扩展到管理面等多模块)。
  // 终态 scoped-authz PR6:export RbacCacheService 供 role-bindings 模块在建/改/软删 USER 主体的 GLOBAL 绑定后
  //   失效该 user 的权限缓存(判权读源 = global RoleBinding,失效链不破;沿 UserRolesService 现范式)。
  exports: [RbacService, RbacCacheService, RoleDelegationPolicy, LastAdminProtectionPolicy],
})
export class PermissionsModule {}
