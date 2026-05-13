import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import {
  ActivityRegistrationsAdminController,
  ActivityRegistrationsMeController,
} from './activity-registrations.controller';
import { ActivityRegistrationsService } from './activity-registrations.service';

// V2 批次 6 PR #5(D6 v1.1 §8 / 第二波第三步):导入 AuditLogsModule 以注入 AuditLogsService,
// activity-registrations 6 处写操作(create / createMy / approve / reject / cancelAdmin / cancelMy)
// 调 log() 替代 auditPlaceholder;exportCsv 是 read/export,仍走 pino-only auditPlaceholder。
@Module({
  imports: [DatabaseModule, AuditLogsModule],
  controllers: [ActivityRegistrationsAdminController, ActivityRegistrationsMeController],
  providers: [ActivityRegistrationsService],
})
export class ActivityRegistrationsModule {}
