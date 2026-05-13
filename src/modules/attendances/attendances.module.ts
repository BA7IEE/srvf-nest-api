import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import {
  AttendanceRecordsMeController,
  AttendanceSheetsCollectionController,
  AttendanceSheetsResourceController,
} from './attendances.controller';
import { AttendancesService } from './attendances.service';

// V2 批次 6 PR #6(D6 v1.1 §8 / 第二波最后一批):导入 AuditLogsModule 以注入 AuditLogsService,
// attendances 8 处写操作(submit / edit × 2 / softDelete / approve / reject / finalApprove / finalReject)
// 调 log() 替代 auditPlaceholder;3 处 read.other(list / findOne / reviewDetail)仍走 pino-only
// auditPlaceholder(沿 Q1=A 当前阶段不记录查看行为)。
@Module({
  imports: [DatabaseModule, AuditLogsModule],
  controllers: [
    AttendanceSheetsCollectionController,
    AttendanceSheetsResourceController,
    AttendanceRecordsMeController,
  ],
  providers: [AttendancesService],
})
export class AttendancesModule {}
