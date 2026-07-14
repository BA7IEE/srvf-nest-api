import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuthzModule } from '../authz/authz.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UsersModule } from '../users/users.module';
import { AppMyAttendanceRecordsService } from './app-my-attendance-records.service';
import { AttendanceAuditRecorder } from './attendance-audit-recorder';
import { AttendancePresenter } from './attendance-presenter';
import {
  AttendanceSheetsCollectionController,
  AttendanceSheetsResourceController,
} from './attendances.controller';
import { AttendanceSheetStateMachine } from './attendance-sheet-state-machine';
import { AttendancesService } from './attendances.service';
import { ContributionCalculator } from './contribution-calculator';
import { TimeOverlapPolicy } from './time-overlap-policy';
import { AdminMemberAttendanceController } from './controllers/admin-member-attendance.controller';
import { AppMyAttendanceRecordsController } from './controllers/app-my-attendance-records.controller';

// V2 批次 6 PR #6(D6 v1.1 §8 / 第二波最后一批):导入 AuditLogsModule 以注入 AuditLogsService,
// attendances 9 处写操作(submit / edit × 2 / softDelete / approve / reject / finalApprove / finalReject / reopen)
// 调 log() 替代 auditPlaceholder;3 处 read.other(list / findOne / reviewDetail)仍走 pino-only
// auditPlaceholder(沿 Q1=A 当前阶段不记录查看行为)。
//
// Phase 2 P2-6(2026-05-20):追加 AppMyAttendanceRecordsController
// (/api/app/v1/my/attendance-records 1 endpoint)+ AppMyAttendanceRecordsService(薄壳)。
// 沿 docs/app-api-p2-6-attendance-records-review.md §7.1 + D-P2-6-3:
//   - 导入 UsersModule 注入 AppIdentityResolver(P2-1 已 exports;P2-6 准入沿同)
//   - 薄壳 service thin-wrap 既有 AttendancesService.listMyRecords(签名 0 diff)
//   - AppMy service 内 2 次 IN 批量自查 AttendanceSheet + Activity 派生字段
// Route B Phase 4d2(2026-06-01):旧 AttendanceRecordsMeController(/v2/users/me/attendance-records)
// 已删除(app/v1/my/attendance-records 对等存在;沿 docs/api-surface-migration-plan.md §6 Phase 4)。
@Module({
  // 统一通知 S4(评审稿 §6.4 / §11):考勤终审通过 → 本人考勤结果/贡献值定向通知(NotificationDispatcher;
  // producer → notifications **单向**,finalApprove commit 后直调,防环:通知绝不回调考勤)。
  // 终态 scoped-authz PR9 + v0.47.0 F2:导入 AuthzModule 注入 AuthzService —— 终审与 reopen
  // 共用带 ref 的 authz.explain;authz 是叶子模块,无反向依赖,不成环。
  imports: [
    DatabaseModule,
    AuditLogsModule,
    PermissionsModule,
    AuthzModule,
    UsersModule,
    NotificationsModule,
    // F2/B2(admin-api-fe-integration-roadmap.md §4 B2;D7 拍板):供 listAllSheetsForAdmin 注入
    // OrganizationsService.queryDescendantOrgIds()(closure 只读展开,非判权)。
    OrganizationsModule,
  ],
  controllers: [
    AttendanceSheetsCollectionController,
    AttendanceSheetsResourceController,
    AdminMemberAttendanceController,
    AppMyAttendanceRecordsController,
  ],
  providers: [
    AttendancesService,
    AppMyAttendanceRecordsService,
    ContributionCalculator,
    TimeOverlapPolicy,
    AttendanceSheetStateMachine,
    AttendanceAuditRecorder,
    AttendancePresenter,
  ],
})
export class AttendancesModule {}
