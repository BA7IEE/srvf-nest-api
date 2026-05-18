import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { AuditLogsController } from './audit-logs.controller';
import { AuditLogsService } from './audit-logs.service';

// V2 第一阶段批次 6 audit_logs module(D6 v1.1 §15.3 模块 6 文件之一)。
//
// 导出 AuditLogsService:PR #2 起 emergency-contacts / certificates 通过 DI 注入
// `AuditLogsService` 调用 `log()` 替代 `auditPlaceholder`(D-A 修订 / §8 8 处迁移)。
//
// P0-F PR-4B(2026-05-18):imports 增 PermissionsModule(沿评审稿 §8.4)
//   - PermissionsModule.exports[RbacService](permissions.module.ts:63)已就位
//   - service 内 list / findOne 首句通过 RbacService.can('audit-log.read.entry') 判权
//   - log() 写入路径**不接** rbac.can(),沿批次 6 R1 红线 + 评审稿 §8.5 + §12.5

@Module({
  imports: [DatabaseModule, PermissionsModule],
  controllers: [AuditLogsController],
  providers: [AuditLogsService],
  exports: [AuditLogsService],
})
export class AuditLogsModule {}
