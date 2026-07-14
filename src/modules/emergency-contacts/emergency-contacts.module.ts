import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AuthzModule } from '../authz/authz.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { EmergencyContactsController } from './emergency-contacts.controller';
import { EmergencyContactsService } from './emergency-contacts.service';

// V2 批次 6 PR #2(D6 v1.1 §8.2):导入 AuditLogsModule 以注入 AuditLogsService,
// emergency-contacts 写操作(create / update / softDelete)调 log() 替代 auditPlaceholder。
// Slow-4 T2(2026-06-11):imports PermissionsModule 供 service 注入 RbacService(评审稿 §3.3)。
@Module({
  imports: [DatabaseModule, AuditLogsModule, PermissionsModule, AuthzModule],
  controllers: [EmergencyContactsController],
  providers: [EmergencyContactsService],
})
export class EmergencyContactsModule {}
