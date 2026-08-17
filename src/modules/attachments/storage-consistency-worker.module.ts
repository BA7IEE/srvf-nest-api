import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import appConfig from '../../config/app.config';
import databaseConfig from '../../config/database.config';
import jwtConfig from '../../config/jwt.config';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { ActivityBatchWorkerModule } from '../activities/activity-batch-worker.module';
import { StorageModule } from '../storage/storage.module';
import { AttachmentAuditRecorder } from './attachment-audit-recorder';
import { AttachmentContentValidator } from './attachment-content-validator';
import { AttachmentManualAttestService } from './attachment-manual-attest.service';
import { AttachmentManualIntakeService } from './attachment-manual-intake.service';
import { AttachmentManualRelocateService } from './attachment-manual-relocate.service';
import { AttachmentReconciliationService } from './attachment-reconciliation.service';
import { AttachmentUploadService } from './attachment-upload.service';
import { AttachmentStorageOrchestrator } from './attachment-storage-orchestrator';
import { StorageConsistencyWorker } from './storage-consistency.worker';

// 独立 storage worker application context：不 import AppModule/ScheduleModule，不注册 HTTP、
// Guard 或第三个 cron；只复用 PostgreSQL ledger、pinned Provider 与 attachment audit 终态。
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [appConfig, databaseConfig, jwtConfig] }),
    DatabaseModule,
    AuditLogsModule,
    StorageModule,
    ActivityBatchWorkerModule,
  ],
  providers: [
    AttachmentAuditRecorder,
    AttachmentContentValidator,
    // orchestrator 的构造依赖 —— 本 module 与 AttachmentsModule **各自独立组装**同一个
    // orchestrator,给它加构造参数必须两处同步注册。漏一处的表现不是编译错,而是
    // Nest 解析失败 → DEFAULT_TEARDOWN → process.exit(1) → 用到该 context 的 e2e 整片崩。
    AttachmentManualRelocateService,
    AttachmentManualAttestService,
    AttachmentManualIntakeService,
    AttachmentReconciliationService,
    AttachmentUploadService,
    AttachmentStorageOrchestrator,
    StorageConsistencyWorker,
  ],
})
export class StorageConsistencyWorkerModule {}
