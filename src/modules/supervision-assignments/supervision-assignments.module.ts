import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { SupervisionAssignmentsController } from './supervision-assignments.controller';
import { SupervisionAssignmentsService } from './supervision-assignments.service';

// 终态 scoped-authz PR5(2026-07-01;冻结稿 §3.5 / §7.4):分管(supervision-assignments)管理面模块。
// 单 controller(6 路由,扁平 CRUD + 队员轴分管范围 + 组织轴被谁分管)+ 单 service;imports PermissionsModule
// 供注入 RbacService(R 模式 rbac.can),AuditLogsModule 供注入 AuditLogsService(建 / 撤销写 audit;沿 content 范式)。
// **分管 = 数据 + 展示,绝不被任何判权路径读**(判权是 PR8;closure 仅展示读非 judge)。
@Module({
  imports: [DatabaseModule, PermissionsModule, AuditLogsModule],
  controllers: [SupervisionAssignmentsController],
  providers: [SupervisionAssignmentsService],
})
export class SupervisionAssignmentsModule {}
