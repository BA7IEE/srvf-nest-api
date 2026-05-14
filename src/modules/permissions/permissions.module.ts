import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PermissionsController } from './permissions.controller';
import { PermissionsService } from './permissions.service';
import { RbacCacheService } from './rbac-cache.service';
import { RbacRolesController } from './rbac-roles.controller';
import { RbacRolesService } from './rbac-roles.service';
import { RolePermissionsController } from './role-permissions.controller';
import { RolePermissionsService } from './role-permissions.service';

// V2.x C-6 RBAC permissions 模块声明。
// 沿 D7 v1.1 §4.1-§4.3 / §5.1 端点 1-11 / §9 缓存策略 / D4 软删决议。
//
// 已实装(累计):
// - PR #2(2026-05-14):Permission CRUD(端点 1-4;路径 /api/v2/permissions;BizCode 30001/30002/30008)
// - PR #3(2026-05-14):RbacRole CRUD(端点 5-9;路径 /api/v2/roles;BizCode 30003/30004/30005/30009)
// - PR #4(2026-05-14):RolePermission 关联表(端点 10-11;路径 /api/v2/roles/:id/permissions[/:permissionId];
//   BizCode 30011)+ RbacCacheService skeleton(Map + TTL + invalidate 入口;
//   完整 rbac.can() 留 PR #6)
//
// 仍未做(留后续 PR):
// - UserRole CRUD(端点 12-14;留 PR #5)
// - RbacService / rbac.can() / @RbacRequired(留 PR #6 — 将复用本 PR 落地的 RbacCacheService)
// - reload 接口(端点 16;留 PR #7)
// - seed migration + bootstrap(留 PR #8)
//
// 本模块归口设计(沿 dictionaries 单模块多 controller 范式):
// - 同一 PermissionsModule 同时管理 Permission + RbacRole + RolePermission + 后续 UserRole
//   (因为它们语义紧耦合 — 都是 RBAC 配置中心)
// - 多 controller / 多 service:permissions.* + rbac-roles.* + role-permissions.* + (未来)user-roles.*
// - RbacCacheService 是模块内共享 provider,被 RolePermissionsService(本 PR)+ 未来的
//   UserRolesService(PR #5)+ RbacService(PR #6)+ ReloadController(PR #7)共同消费
@Module({
  imports: [DatabaseModule],
  controllers: [PermissionsController, RbacRolesController, RolePermissionsController],
  providers: [PermissionsService, RbacRolesService, RolePermissionsService, RbacCacheService],
})
export class PermissionsModule {}
