import { forwardRef, Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuthzModule } from '../authz/authz.module';
import { ActivitiesModule } from '../activities/activities.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { UsersModule } from '../users/users.module';
import { AdminActivityCheckInsService } from './admin-activity-check-ins.service';
import { ActivityCheckInQueryService } from './activity-check-in-query.service';
import { AppMyAttendanceRecordsService } from './app-my-attendance-records.service';
import { AppManagedActivityAttendancesService } from './app-managed-activity-attendances.service';
import { ActivityCheckInFieldPolicy } from './activity-check-in-field-policy';
import { ActivityCheckInLocationPolicy } from './activity-check-in-location-policy';
import { ActivityCheckInPolicy } from './activity-check-in-policy';
import { ActivityCheckInPresenter } from './activity-check-in-presenter';
import { AppActivityCheckInsService } from './app-activity-check-ins.service';
import { AttendanceAuditRecorder } from './attendance-audit-recorder';
import { AttendanceNotificationProducer } from './attendance-notification-producer';
import { AttendancePresenter } from './attendance-presenter';
import { AttendanceSheetQueryService } from './attendance-sheet-query.service';
import {
  AttendanceSheetsCollectionController,
  AttendanceSheetsResourceController,
} from './attendances.controller';
import { AttendanceSheetStateMachine } from './attendance-sheet-state-machine';
import { AttendanceAccessService } from './attendance-access.service';
import { AttendanceReadService } from './attendance-read.service';
import { AttendanceReviewService } from './attendance-review.service';
import { AttendancesService } from './attendances.service';
import { ContributionCalculator } from './contribution-calculator';
import { TimeOverlapPolicy } from './time-overlap-policy';
import { AdminActivityCheckInsController } from './controllers/admin-activity-check-ins.controller';
import { AdminMemberAttendanceController } from './controllers/admin-member-attendance.controller';
import { AppActivityCheckInsController } from './controllers/app-activity-check-ins.controller';
import { AppMyAttendanceRecordsController } from './controllers/app-my-attendance-records.controller';
import { AppMyParticipationSummaryController } from './controllers/app-my-participation-summary.controller';
import { AppManagedActivityAttendancesController } from './controllers/app-managed-activity-attendances.controller';
import { ParticipationSummaryQueryService } from './participation-summary-query.service';
import { AttendancePunchAuditRecorder } from './attendance-punch-audit-recorder';
import { AttendancePunchCommandService } from './attendance-punch-command.service';
import { AttendancePunchAccessService } from './attendance-punch-access.service';
import { AttendancePunchLocationPolicy } from './attendance-punch-location-policy';
import { AttendancePunchPresenter } from './attendance-punch-presenter';
import { AttendancePunchSegmentRevisionService } from './attendance-punch-segment-revision.service';
import { AttendanceQrCredentialService } from './attendance-qr-credential.service';
import { AttendanceQrPresenter } from './attendance-qr-presenter';
import { AttendanceMemberCredentialService } from './attendance-member-credential.service';
import { AttendanceOfflinePackageTokenService } from './attendance-offline-package-token';
import { AttendanceOfflinePackageService } from './attendance-offline-package.service';
import { AttendanceOfflinePackageAccessService } from './attendance-offline-package-access.service';
import { AttendanceOfflineReviewService } from './attendance-offline-review.service';
import { AttendanceOnsiteBatchJobService } from './attendance-onsite-batch-job.service';
import { AttendanceImportAttachmentService } from './attendance-import-attachment.service';
import { AttendanceImportPreviewService } from './attendance-import-preview.service';
import { AppActivityPunchesController } from './controllers/app-activity-punches.controller';
import { AppManagedActivityAttendanceQrController } from './controllers/app-managed-activity-attendance-qr.controller';
import { AppManagedActivityOnsitePunchesController } from './controllers/app-managed-activity-onsite-punches.controller';
import { AppManagedActivityOnsiteOperationsController } from './controllers/app-managed-activity-onsite-operations.controller';
import { AppMyAttendanceMemberCredentialController } from './controllers/app-my-attendance-member-credential.controller';

// V2 批次 6 PR #6(D6 v1.1 §8 / 第二波最后一批):导入 AuditLogsModule 以注入 AuditLogsService,
// attendances 12 处写操作(submit / edit × 2 / softDelete / approve / return / reject /
// finalApprove / finalReturn / finalReject / resubmit / reopen)
// 调 log() 落库;2026-07-19 C-2 起 3 处 read.other(list / findOne / reviewDetail)也经
// AttendanceAuditRecorder 在查询完成后 fail-closed 落库,不再存在 pino-only placeholder。
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
  // PR-L4:考勤退回/终审由 AttendanceNotificationProducer 在业务事务内写 durable intent；
  // NotificationsModule 提供既有 outbox，worker 在 commit 后执行 Effect，依赖仍为单向。
  // 终态 scoped-authz PR9 + v0.47.0 F2:导入 AuthzModule 注入 AuthzService —— 终审与 reopen
  // 共用带 ref 的 authz.explain;authz 是叶子模块,无反向依赖,不成环。
  imports: [
    DatabaseModule,
    AuditLogsModule,
    PermissionsModule,
    AuthzModule,
    forwardRef(() => ActivitiesModule),
    UsersModule,
    NotificationsModule,
    AttachmentsModule,
    // F2/B2(admin-api-fe-integration-roadmap.md §4 B2;D7 拍板):供 listAllSheetsForAdmin 注入
    // OrganizationsService.queryDescendantOrgIds()(closure 只读展开,非判权)。
    OrganizationsModule,
  ],
  controllers: [
    AttendanceSheetsCollectionController,
    AttendanceSheetsResourceController,
    AdminActivityCheckInsController,
    AdminMemberAttendanceController,
    AppActivityCheckInsController,
    AppMyAttendanceRecordsController,
    AppMyParticipationSummaryController,
    AppManagedActivityAttendancesController,
    AppActivityPunchesController,
    AppManagedActivityAttendanceQrController,
    AppManagedActivityOnsitePunchesController,
    AppManagedActivityOnsiteOperationsController,
    AppMyAttendanceMemberCredentialController,
  ],
  providers: [
    AttendanceAccessService,
    AttendanceReadService,
    AttendanceReviewService,
    AttendancesService,
    AdminActivityCheckInsService,
    ActivityCheckInQueryService,
    AppMyAttendanceRecordsService,
    AppManagedActivityAttendancesService,
    AppActivityCheckInsService,
    ActivityCheckInPolicy,
    ActivityCheckInLocationPolicy,
    ActivityCheckInFieldPolicy,
    ActivityCheckInPresenter,
    ContributionCalculator,
    TimeOverlapPolicy,
    AttendanceSheetStateMachine,
    AttendanceAuditRecorder,
    AttendanceNotificationProducer,
    AttendancePresenter,
    // Phase 6-B 第二域第一刀:读侧查询构造。**刻意不进 exports** —— 跨模块读仍走
    // AttendancesService 那一个入口,避免出现绕过判权腿的第二条读路径(沿 members #1008 先例)。
    AttendanceSheetQueryService,
    ParticipationSummaryQueryService,
    AttendanceQrCredentialService,
    AttendanceQrPresenter,
    AttendanceMemberCredentialService,
    AttendanceOfflinePackageTokenService,
    AttendanceOfflinePackageService,
    AttendanceOfflinePackageAccessService,
    AttendanceOfflineReviewService,
    AttendanceOnsiteBatchJobService,
    AttendanceImportAttachmentService,
    AttendanceImportPreviewService,
    AttendancePunchCommandService,
    AttendancePunchAccessService,
    AttendancePunchLocationPolicy,
    AttendancePunchPresenter,
    AttendancePunchSegmentRevisionService,
    AttendancePunchAuditRecorder,
  ],
  exports: [AttendanceOnsiteBatchJobService, AttendanceImportPreviewService],
})
export class AttendancesModule {}
