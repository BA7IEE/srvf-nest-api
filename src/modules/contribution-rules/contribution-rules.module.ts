import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { ContributionRulesController } from './contribution-rules.controller';
import { ContributionRulesService } from './contribution-rules.service';

// V2 批次 6 PR #3(D6 v1.1 §8 / 第二波第一步):导入 AuditLogsModule 以注入 AuditLogsService,
// contribution-rules 写操作(create / update / softDelete)调 log() 替代 auditPlaceholder。
//
// P0-F PR-2A(2026-05-18):imports PermissionsModule 供 ContributionRulesService 注入 RbacService
// (沿 PR-1 attachments F5 v1.0 范本)。
@Module({
  imports: [DatabaseModule, AuditLogsModule, PermissionsModule],
  controllers: [ContributionRulesController],
  providers: [ContributionRulesService],
})
export class ContributionRulesModule {}
