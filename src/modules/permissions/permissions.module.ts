import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PermissionsController } from './permissions.controller';
import { PermissionsService } from './permissions.service';
import { RbacRolesController } from './rbac-roles.controller';
import { RbacRolesService } from './rbac-roles.service';

// V2.x C-6 RBAC permissions 模块声明。
// 沿 D7 v1.1 §4.1-§4.2 / §5.1 端点 1-9 / D4 软删决议。
//
// 已实装(累计):
// - PR #2(2026-05-14):Permission CRUD(端点 1-4;路径 /api/v2/permissions;BizCode 30001/30002/30008)
// - PR #3(2026-05-14):RbacRole CRUD(端点 5-9;路径 /api/v2/roles;BizCode 30003/30004/30005/30009)
//
// 仍未做(留后续 PR):
// - RolePermission CRUD(端点 10-11;留 PR #4)
// - UserRole CRUD(端点 12-14;留 PR #5)
// - RbacService / rbac.can() / @RbacRequired(留 PR #6)
// - reload 接口(端点 16;留 PR #7)
// - seed migration + bootstrap(留 PR #8)
//
// 本模块归口设计(沿 dictionaries 单模块多 controller 范式):
// - 同一 PermissionsModule 同时管理 Permission + RbacRole + 后续 RolePermission /
//   UserRole(因为它们语义紧耦合 — 都是 RBAC 配置中心)
// - 多 controller / 多 service:permissions.* + rbac-roles.* + (未来)role-permissions.* + user-roles.*
@Module({
  imports: [DatabaseModule],
  controllers: [PermissionsController, RbacRolesController],
  providers: [PermissionsService, RbacRolesService],
})
export class PermissionsModule {}
