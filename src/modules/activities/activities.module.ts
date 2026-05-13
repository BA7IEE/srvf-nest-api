import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { ActivitiesController } from './activities.controller';
import { ActivitiesService } from './activities.service';

// V2 批次 6 PR #4(D6 v1.1 §8 / 第二波第二步):导入 AuditLogsModule 以注入 AuditLogsService,
// activities 写操作(create / update / softDelete / publish / cancel 共 5 处共用 activity.publish)
// 调 log() 替代 auditPlaceholder。
@Module({
  imports: [DatabaseModule, AuditLogsModule],
  controllers: [ActivitiesController],
  providers: [ActivitiesService],
  exports: [ActivitiesService],
})
export class ActivitiesModule {}
