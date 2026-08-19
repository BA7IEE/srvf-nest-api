import { Module } from '@nestjs/common';

import { ActivityWorkflowModule } from '../../common/activity-workflow/activity-workflow.module';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AttendancesModule } from '../attendances/attendances.module';
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
  // 活动 v1.1 cutover gate:两个 worker 进程各建**独立 application context**,
  // 拿不到 HTTP 侧的注入图 —— 账本 prepare / commit 也是受闸的写路径,故必须在这里也 import。
  // (漏掉时单测全绿,只有真起 Nest 的 e2e 会在 createApplicationContext 处炸;判据 C5 已就位。)
  imports: [DatabaseModule, AuditLogsModule, AttendancesModule, ActivityWorkflowModule],
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
