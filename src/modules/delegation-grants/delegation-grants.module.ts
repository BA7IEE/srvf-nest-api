import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AuthzModule } from '../authz/authz.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { IntegrationAuthzModule } from '../integration-authz/integration-authz.module';
import { DelegationGrantsController } from './delegation-grants.controller';
import { DelegationGrantRuntimeService } from './delegation-grant-runtime.service';
import { DelegationGrantsService } from './delegation-grants.service';

/**
 * Integration Foundation v1 PR5(规格书 §36/§41/§61):Delegation 控制面 + runtime 三腿交集。
 */
@Module({
  imports: [
    DatabaseModule,
    PermissionsModule,
    IntegrationAuthzModule,
    AuthzModule,
    AuditLogsModule,
  ],
  controllers: [DelegationGrantsController],
  providers: [DelegationGrantRuntimeService, DelegationGrantsService],
  exports: [DelegationGrantRuntimeService],
})
export class DelegationGrantsModule {}
