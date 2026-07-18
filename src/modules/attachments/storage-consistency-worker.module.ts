import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import appConfig from '../../config/app.config';
import databaseConfig from '../../config/database.config';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { StorageModule } from '../storage/storage.module';
import { AttachmentAuditRecorder } from './attachment-audit-recorder';
import { AttachmentContentValidator } from './attachment-content-validator';
import { AttachmentStorageOrchestrator } from './attachment-storage-orchestrator';
import { StorageConsistencyWorker } from './storage-consistency.worker';

// 独立 storage worker application context：不 import AppModule/ScheduleModule，不注册 HTTP、
// Guard 或第三个 cron；只复用 PostgreSQL ledger、pinned Provider 与 attachment audit 终态。
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [appConfig, databaseConfig] }),
    DatabaseModule,
    AuditLogsModule,
    StorageModule,
  ],
  providers: [
    AttachmentAuditRecorder,
    AttachmentContentValidator,
    AttachmentStorageOrchestrator,
    StorageConsistencyWorker,
  ],
})
export class StorageConsistencyWorkerModule {}
