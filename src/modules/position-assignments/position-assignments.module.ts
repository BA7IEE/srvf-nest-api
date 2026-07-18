import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { PositionAssignmentPolicy } from './position-assignment-policy';
import { PositionAssignmentsController } from './position-assignments.controller';
import { PositionAssignmentsService } from './position-assignments.service';

// 终态 scoped-authz PR4(2026-07-01;冻结稿 §3.4 / §7.3):任职(position-assignments)管理面模块。
// 单 controller(8 路由,双轴)+ application service + 任命 policy；imports PermissionsModule 供注入 RbacService,
// AuditLogsModule 供注入 AuditLogsService(任命 / 撤销写 audit;沿 content 范式)。
// AuthzService 动态读取 assignment；Position/Rule 只在新任命 policy 中执行，不追溯改写既有 grant。
@Module({
  imports: [DatabaseModule, PermissionsModule, AuditLogsModule],
  controllers: [PositionAssignmentsController],
  providers: [PositionAssignmentsService, PositionAssignmentPolicy],
  // 终态 scoped-authz PR11(2026-07-02):announcement-import 模块需注入 PositionAssignmentsService
  // 复用 create()(含 dryRun);导出前该 service 仅模块内自用,无消费者行为受影响。
  exports: [PositionAssignmentsService],
})
export class PositionAssignmentsModule {}
