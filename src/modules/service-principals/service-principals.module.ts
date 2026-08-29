import { Module } from '@nestjs/common';

import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { DatabaseModule } from '../../database/database.module';

import { ServicePrincipalsController } from './service-principals.controller';
import { ServicePrincipalsService } from './service-principals.service';

/**
 * Integration Foundation v1 PR2(规格书 §41/§58):ServicePrincipal 控制面。
 *
 * PR2 只交付控制面(CRUD/status/credential);Token 签发与 Integration 认证是 PR3,
 * DelegationGrant 管理端点归 PR5。本模块不 import 业务模块(零业务耦合)。
 */
@Module({
  imports: [DatabaseModule, AuditLogsModule],
  controllers: [ServicePrincipalsController],
  providers: [ServicePrincipalsService],
  exports: [ServicePrincipalsService],
})
export class ServicePrincipalsModule {}
