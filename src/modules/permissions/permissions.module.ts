import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PermissionsController } from './permissions.controller';
import { PermissionsService } from './permissions.service';
import { RbacCacheService } from './rbac-cache.service';
import { RbacController } from './rbac.controller';
import { RbacService } from './rbac.service';
import { RbacRolesController } from './rbac-roles.controller';
import { RbacRolesService } from './rbac-roles.service';
import { RolePermissionsController } from './role-permissions.controller';
import { RolePermissionsService } from './role-permissions.service';
import { UserRolesController } from './user-roles.controller';
import { UserRolesService } from './user-roles.service';

// V2.x C-6 RBAC permissions 模块声明。
// 沿 D7 v1.1 §4.1-§4.4 / §5.1 端点 1-14 / §6.2 Q7 / §6.3 / §9 缓存策略 / D4 软删决议。
//
// 已实装(累计):
// - PR #2(2026-05-14):Permission CRUD(端点 1-4;路径 /api/v2/permissions;BizCode 30001/30002/30008)
// - PR #3(2026-05-14):RbacRole CRUD(端点 5-9;路径 /api/v2/roles;BizCode 30003/30004/30005/30009)
// - PR #4(2026-05-14):RolePermission 关联表(端点 10-11;路径 /api/v2/roles/:id/permissions[/:permissionId];
//   BizCode 30011)+ RbacCacheService skeleton(Map + TTL + invalidate 入口;
//   完整 rbac.can() 留 PR #6)
// - PR #5(2026-05-14):UserRole CRUD(端点 12-14;路径 /api/v2/users/:userId/roles[/:roleId];
//   BizCode 30006/30007/30101/30102)+ Q7 角色分级 C2 中庸 + 最后一个 ops-admin 保护 +
//   接入 RbacCacheService.invalidateUser
// - PR #6(2026-05-14):RbacService + GET /api/v2/rbac/me/permissions(端点 15;
//   BizCode 30100 段位预留)+ RbacCacheService 接入 RBAC_CACHE_TTL_SECONDS env +
//   CurrentUserPayload.memberId 扩展
//
// 仍未做(留后续 PR):
// - reload 接口(端点 16;留 PR #7)+ 14 个 RBAC CRUD 接 `rbac.can()`(沿用户拍板 PR #6 范围)
// - seed migration + bootstrap + ADMIN 内置角色配 USER 级权限(留 PR #8)
//
// 本模块归口设计(沿 dictionaries 单模块多 controller 范式):
// - 同一 PermissionsModule 同时管理 Permission + RbacRole + RolePermission + UserRole + RbacService
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
  ],
})
export class PermissionsModule {}
