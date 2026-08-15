import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { ActivityInvitationAuditRecorder } from '../activity-registrations/activity-invitation-audit-recorder';
import { ActivityRegistrationAuditRecorder } from '../activity-registrations/activity-registration-audit-recorder';
import { RegistrationReconciliationService } from '../activity-registrations/registration-reconciliation.service';
import { NotificationOutboxService } from '../notifications/notification-outbox.service';
import { ACTIVITY_BATCH_AUTO_COMMIT_ENABLED, ActivityBatchWorker } from './activity-batch.worker';
import { LedgerPostingAuditRecorder } from './ledger-posting-audit-recorder';
import { LedgerPostingService } from './ledger-posting.service';
import { LedgerPreparationService } from './ledger-preparation.service';
import { LedgerReadyBatchCommitter } from './ledger-ready-batch-committer.service';
import { SettlementNotificationProducer } from './settlement-notification-producer';

// 两个独立 worker 进程共用的最小活动任务依赖图。不 import ActivitiesModule，因而不装配
// HTTP controller、Authz 或 ScheduleModule；也不注册任何 cron / 外部 queue。
@Module({
  imports: [DatabaseModule, AuditLogsModule],
  providers: [
    NotificationOutboxService,
    SettlementNotificationProducer,
    LedgerPostingAuditRecorder,
    LedgerPostingService,
    LedgerPreparationService,
    LedgerReadyBatchCommitter,
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
