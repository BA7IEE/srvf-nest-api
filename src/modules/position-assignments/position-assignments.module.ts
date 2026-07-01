import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { PositionAssignmentsController } from './position-assignments.controller';
import { PositionAssignmentsService } from './position-assignments.service';

// 终态 scoped-authz PR4(2026-07-01;冻结稿 §3.4 / §7.3):任职(position-assignments)管理面模块。
// 单 controller(5 路由,双轴)+ 单 service;imports PermissionsModule 供注入 RbacService(R 模式 rbac.can),
// AuditLogsModule 供注入 AuditLogsService(任命 / 撤销写 audit;沿 content 范式)。
// **任职 = 数据 + 任命校验,绝不被任何判权路径读**(判权是 PR8)。
@Module({
  imports: [DatabaseModule, PermissionsModule, AuditLogsModule],
  controllers: [PositionAssignmentsController],
  providers: [PositionAssignmentsService],
})
export class PositionAssignmentsModule {}
