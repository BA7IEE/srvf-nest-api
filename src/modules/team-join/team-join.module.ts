import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { TeamJoinApplicationsAdminController } from './team-join-applications.admin.controller';
import { TeamJoinApplicationsService } from './team-join-applications.service';
import { TeamJoinCyclesController } from './team-join-cycles.controller';
import { TeamJoinCyclesService } from './team-join-cycles.service';

// 招新三期(入队:志愿者 → 队员)T2(2026-06-19):team-join 第 27 模块装配(评审稿 §5)。
// 消费 Permissions(rbac.can)/ AuditLogs(审计);贡献值只读汇总直读 attendance_records(评审稿 E-J-7)。
// T2 surface = admin/v1(入队轮 CRUD + 报名 list/detail + 标 gate + 综合评估)。
// app/v1 自助面(发起/查进度)T3 追加;一键入队(enrollment)T4 追加。
@Module({
  imports: [DatabaseModule, PermissionsModule, AuditLogsModule],
  controllers: [TeamJoinCyclesController, TeamJoinApplicationsAdminController],
  providers: [TeamJoinCyclesService, TeamJoinApplicationsService],
})
export class TeamJoinModule {}
