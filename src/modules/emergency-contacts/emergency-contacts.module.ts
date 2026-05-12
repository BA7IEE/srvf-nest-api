import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { EmergencyContactsController } from './emergency-contacts.controller';
import { EmergencyContactsService } from './emergency-contacts.service';

// V2 批次 6 PR #2(D6 v1.1 §8.2):导入 AuditLogsModule 以注入 AuditLogsService,
// emergency-contacts 写操作(create / update / softDelete)调 log() 替代 auditPlaceholder。
@Module({
  imports: [DatabaseModule, AuditLogsModule],
  controllers: [EmergencyContactsController],
  providers: [EmergencyContactsService],
})
export class EmergencyContactsModule {}
