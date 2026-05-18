import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { MemberDepartmentsController } from './member-departments.controller';
import { MemberDepartmentsService } from './member-departments.service';

// P0-F PR-2A(2026-05-18):imports PermissionsModule 供 MemberDepartmentsService 注入 RbacService
// (沿 PR-1 attachments F5 v1.0 范本)。
@Module({
  imports: [DatabaseModule, PermissionsModule],
  controllers: [MemberDepartmentsController],
  providers: [MemberDepartmentsService],
})
export class MemberDepartmentsModule {}
