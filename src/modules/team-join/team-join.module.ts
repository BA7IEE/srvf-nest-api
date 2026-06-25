import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { UsersModule } from '../users/users.module';
import { TeamJoinApplicationsAdminController } from './team-join-applications.admin.controller';
import { TeamJoinApplicationsAppController } from './team-join-applications.app.controller';
import { AppMeTeamJoinService } from './team-join-applications.app.service';
import { TeamJoinApplicationsService } from './team-join-applications.service';
import { TeamJoinCyclesController } from './team-join-cycles.controller';
import { TeamJoinCyclesService } from './team-join-cycles.service';
import { TeamJoinEnrollmentService } from './team-join-enrollment.service';

// 招新三期(入队:志愿者 → 队员)T2/T3(2026-06-19):team-join 第 27 模块装配(评审稿 §5)。
// 消费 Permissions(rbac.can)/ AuditLogs(审计)/ Users(AppIdentityResolver:App 准入,T3);
// 贡献值只读汇总直读 attendance_records(评审稿 E-J-7)。
// surface:admin/v1(入队轮 CRUD + 报名 list/detail + 标 gate + 综合评估)+ app/v1/me(自助发起/查进度/改候选,T3)。
// 一键入队(enrollment)T4 追加。
@Module({
  imports: [
    DatabaseModule,
    PermissionsModule,
    AuditLogsModule,
    UsersModule,
    NotificationsModule, // 统一通知 S3:入队结果定向通知(NotificationDispatcher;producer → notifications 单向)
  ],
  controllers: [
    TeamJoinCyclesController,
    TeamJoinApplicationsAdminController,
    TeamJoinApplicationsAppController,
  ],
  providers: [
    TeamJoinCyclesService,
    TeamJoinApplicationsService,
    AppMeTeamJoinService,
    TeamJoinEnrollmentService,
  ],
})
export class TeamJoinModule {}
