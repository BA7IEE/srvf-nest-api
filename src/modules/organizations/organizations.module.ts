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
})
export class OrganizationsModule {}
