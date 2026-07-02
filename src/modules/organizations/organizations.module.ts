import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';

// P0-F PR-2A(2026-05-18):imports PermissionsModule 供 OrganizationsService 注入 RbacService
// (沿 PR-1 attachments F5 v1.0 范本)。
@Module({
  imports: [DatabaseModule, PermissionsModule],
  controllers: [OrganizationsController],
  providers: [OrganizationsService],
  // 终态 scoped-authz PR11(2026-07-02):announcement-import 模块需注入 OrganizationsService
  // 复用 create()(含 dryRun);导出前该 service 仅模块内自用,无消费者行为受影响。
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
