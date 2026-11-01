import { HumanCorrectionItemAuthority } from './human-correction-item-authority';
import {
  HUMAN_CORRECTION_BACKGROUND_BUDGET,
  HUMAN_CORRECTION_BACKGROUND_BUDGET_OFF,
} from './human-correction-background-budget';
import { Module } from '@nestjs/common';

import { ActivityWorkflowModule } from '../../common/activity-workflow/activity-workflow.module';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { AttendancesModule } from '../attendances/attendances.module';
import { ActivityInvitationAuditRecorder } from '../activity-registrations/activity-invitation-audit-recorder';
import { ActivityRegistrationAuditRecorder } from '../activity-registrations/activity-registration-audit-recorder';
import { RegistrationReconciliationService } from '../activity-registrations/registration-reconciliation.service';
import { NotificationOutboxService } from '../notifications/notification-outbox.service';
import { ACTIVITY_BATCH_AUTO_COMMIT_ENABLED, ActivityBatchWorker } from './activity-batch.worker';
import { LedgerPostingAuditRecorder } from './ledger-posting-audit-recorder';
import { LedgerPostingService } from './ledger-posting.service';
import { LedgerPreparationService } from './ledger-preparation.service';
import { ParticipationTimeLedgerService } from './participation-time-ledger.service';
import { ParticipationTimeCorrectionService } from './participation-time-correction.service';
import { ParticipationTimeLedgerAccessService } from './participation-time-ledger-access.service';
import { LedgerReadyBatchCommitter } from './ledger-ready-batch-committer.service';
import { ActivityContributionSettlementService } from './activity-contribution-settlement.service';
import { ActivityContributionSettlementQueryService } from './activity-contribution-settlement-query.service';
import { AuthzModule } from '../authz/authz.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { UsersModule } from '../users/users.module';
import { ContributionCalculator } from '../attendances/contribution-calculator';
import { SettlementDraftAuditRecorder } from './settlement-draft-audit-recorder';
import { SettlementDraftService } from './settlement-draft.service';
import { SettlementDraftBatchService } from './settlement-draft-batch.service';
import { SettlementNotificationProducer } from './settlement-notification-producer';
import { ActivityClosureService } from './activity-closure.service';
import { ActivityClosureAuditRecorder } from './activity-closure-audit-recorder';
import { ActivityClosureNotificationProducer } from './activity-closure-notification-producer';
import { ParticipationTimeTruthQueryService } from './participation-time-truth-query.service';
import { CorrectionAuditRecorder } from './correction-audit-recorder';
import { CorrectionApplicationService } from './correction-application.service';
import { CorrectionTimeAllocationService } from './correction-time-allocation.service';
import { ActivityResponsibilityPolicy } from './activity-responsibility-policy';
import { ActivityTimeSettlementAccessService } from './activity-time-settlement-access.service';
import { ActivityTimeCorrectionAccessService } from './activity-time-correction-access.service';
import { ActivityTimeCorrectionCommandService } from './activity-time-correction-command.service';
import { ActivityTimeCorrectionBackgroundService } from './activity-time-correction-background.service';

// 两个独立 worker 进程复用活动任务的服务图，不 import ActivitiesModule 或新增
// ScheduleModule / cron / 外部 queue；当前身份和授权由同一 Human access 服务检查。
@Module({
  // 活动 v1.1 cutover gate:两个 worker 进程各建**独立 application context**,
  // 拿不到 HTTP 侧的注入图 —— 账本 prepare / commit 也是受闸的写路径,故必须在这里也 import。
  // (漏掉时单测全绿,只有真起 Nest 的 e2e 会在 createApplicationContext 处炸;判据 C5 已就位。)
  imports: [
    DatabaseModule,
    AuditLogsModule,
    AttachmentsModule,
    AttendancesModule,
    ActivityWorkflowModule,
    AuthzModule,
    PermissionsModule,
    UsersModule,
  ],
  providers: [
    // This is the ordinary worker graph. Protected Human work uses the separate
    // root; an imported HTTP graph cannot enable its bulk budget implicitly.
    {
      provide: HUMAN_CORRECTION_BACKGROUND_BUDGET,
      useValue: HUMAN_CORRECTION_BACKGROUND_BUDGET_OFF,
    },
    NotificationOutboxService,
    SettlementNotificationProducer,
    LedgerPostingAuditRecorder,
    LedgerPostingService,
    LedgerPreparationService,
    // The independent worker graph must enforce the same native proof/gate contract as HTTP.
    ActivityContributionSettlementService,
    ActivityContributionSettlementQueryService,
    ParticipationTimeLedgerService,
    ParticipationTimeCorrectionService,
    ParticipationTimeLedgerAccessService,
    LedgerReadyBatchCommitter,
    ContributionCalculator,
    SettlementDraftAuditRecorder,
    SettlementDraftService,
    SettlementDraftBatchService,
    ActivityClosureAuditRecorder,
    ActivityClosureNotificationProducer,
    ParticipationTimeTruthQueryService,
    ActivityClosureService,
    CorrectionAuditRecorder,
    CorrectionTimeAllocationService,
    ActivityResponsibilityPolicy,
    ActivityTimeSettlementAccessService,
    ActivityTimeCorrectionAccessService,
    CorrectionApplicationService,
    ActivityTimeCorrectionCommandService,
    ActivityTimeCorrectionBackgroundService,
    HumanCorrectionItemAuthority,
    // Reconciliation is worker-only.  Importing ActivityRegistrationsModule would also construct
    // its HTTP/notification graph in the two independent worker application contexts.
    ActivityRegistrationAuditRecorder,
    ActivityInvitationAuditRecorder,
    RegistrationReconciliationService,
    { provide: ACTIVITY_BATCH_AUTO_COMMIT_ENABLED, useValue: true },
    ActivityBatchWorker,
  ],
  exports: [ActivityBatchWorker],
})
export class ActivityBatchWorkerModule {}
