import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsController } from './audit-logs.controller';
import { AuditLogsService } from './audit-logs.service';

// V2 第一阶段批次 6 audit_logs module(D6 v1.1 §15.3 模块 6 文件之一)。
//
// 导出 AuditLogsService:PR #2 起 emergency-contacts / certificates 通过 DI 注入
// `AuditLogsService` 调用 `log()` 替代 `auditPlaceholder`(D-A 修订 / §8 8 处迁移)。
// 本 PR(#1)范围内 service 已就绪但**无业务模块调用**,export 提前留好。

@Module({
  imports: [DatabaseModule],
  controllers: [AuditLogsController],
  providers: [AuditLogsService],
  exports: [AuditLogsService],
})
export class AuditLogsModule {}
