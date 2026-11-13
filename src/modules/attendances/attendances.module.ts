import { forwardRef, Module } from '@nestjs/common';
import { ActivityWorkflowModule } from '../../common/activity-workflow/activity-workflow.module';
import { DatabaseModule } from '../../database/database.module';
import { AuthzModule } from '../authz/authz.module';
import { ActivitiesModule } from '../activities/activities.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { UsersModule } from '../users/users.module';
import { ContributionShadowEvidenceService } from './contribution-shadow-evidence.service';
import { ContributionShadowEvidenceQueryService } from './contribution-shadow-evidence.query.service';
import { ContributionShadowEvidencePresenter } from './contribution-shadow-evidence.presenter';
import { ContributionShadowEvidenceAuditRecorder } from './contribution-shadow-evidence.audit-recorder';
import { SystemContributionShadowEvidenceController } from './controllers/system-contribution-shadow-evidence.controller';
import { AdminMemberAttendanceController } from './controllers/admin-member-attendance.controller';
import { AppMyParticipationSummaryController } from './controllers/app-my-participation-summary.controller';
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
import { AttendanceMetricSourceQueryService } from './attendance-metric-source-query.service';
import { AttendanceCorrectionWriteService } from './attendance-correction-write.service';
import { ParticipationSegmentFacade } from './participation-segment.facade';
import { AppActivityPunchesController } from './controllers/app-activity-punches.controller';
import { AppManagedActivityAttendanceQrController } from './controllers/app-managed-activity-attendance-qr.controller';
import { AppManagedActivityOnsitePunchesController } from './controllers/app-managed-activity-onsite-punches.controller';
import { AppManagedActivityOnsiteOperationsController } from './controllers/app-managed-activity-onsite-operations.controller';
import { AppMyAttendanceMemberCredentialController } from './controllers/app-my-attendance-member-credential.controller';

// Runtime composition exposes the v1.1 punch, segment and settlement-facing services.
// Retired sheet / GPS controllers and their writer providers are not registered.
@Module({
  imports: [
    // 活动 v1.1 cutover gate(合同 §16.2 单轨):两个模块 import 同一个模块 ⇒ 同一个闸实例。
    ActivityWorkflowModule,
    DatabaseModule,
    AuditLogsModule,
    PermissionsModule,
    AuthzModule,
    forwardRef(() => ActivitiesModule),
    UsersModule,
    AttachmentsModule,
  ],
  controllers: [
    SystemContributionShadowEvidenceController,
    AdminMemberAttendanceController,
    AppMyParticipationSummaryController,
    AppActivityPunchesController,
    AppManagedActivityAttendanceQrController,
    AppManagedActivityOnsitePunchesController,
    AppManagedActivityOnsiteOperationsController,
    AppMyAttendanceMemberCredentialController,
  ],
  providers: [
    ContributionShadowEvidenceService,
    ContributionShadowEvidenceQueryService,
    ContributionShadowEvidencePresenter,
    ContributionShadowEvidenceAuditRecorder,
    AttendanceMetricSourceQueryService,
    AttendanceCorrectionWriteService,
    ParticipationSegmentFacade,
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
  exports: [
    AttendanceOnsiteBatchJobService,
    AttendanceImportPreviewService,
    AttendanceMetricSourceQueryService,
    AttendanceCorrectionWriteService,
    ParticipationSegmentFacade,
  ],
})
export class AttendancesModule {}
