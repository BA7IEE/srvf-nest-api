import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { RoleBindingsController } from './role-bindings.controller';
import { RoleBindingsService } from './role-bindings.service';

// 终态 scoped-authz PR6「RoleBinding」(2026-07-01;冻结稿 §3.6 / §7.5):带 scope 的角色绑定管理面模块(第 32 模块)。
// 单 controller(4 路由,GLOBAL/scoped 各型 CRUD)+ 单 service;imports PermissionsModule 供注入 RbacService
// (R 模式 rbac.can),AuditLogsModule 供注入 AuditLogsService(建 / 软删写 audit;沿 supervision-assignments 范式)。
// **🔴 本模块是叶子(import Permissions + AuditLogs,无被反向 import),故不成模块环**
//   (区别于 UserRolesService 内 permissions 模块直写 audit 规避环)。
// **scoped 绑定入库即止,RbacService 只读 GLOBAL、绝不判 scoped**(判权是 PR8 AuthzService)。
@Module({
  imports: [DatabaseModule, PermissionsModule, AuditLogsModule],
  controllers: [RoleBindingsController],
  providers: [RoleBindingsService],
})
export class RoleBindingsModule {}
