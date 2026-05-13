import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { ContributionRulesController } from './contribution-rules.controller';
import { ContributionRulesService } from './contribution-rules.service';

// V2 批次 6 PR #3(D6 v1.1 §8 / 第二波第一步):导入 AuditLogsModule 以注入 AuditLogsService,
// contribution-rules 写操作(create / update / softDelete)调 log() 替代 auditPlaceholder。
@Module({
  imports: [DatabaseModule, AuditLogsModule],
  controllers: [ContributionRulesController],
  providers: [ContributionRulesService],
})
export class ContributionRulesModule {}
