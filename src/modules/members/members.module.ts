import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';

// Slow-4 T2(2026-06-11):imports PermissionsModule 供 MembersService 注入 RbacService
// (沿 P0-F contribution-rules 范本;评审稿 slow4-rbac-business-face-review.md §3.1)。
// F1/A1(路线图 §4;D7 拍板):imports OrganizationsModule 供注入 OrganizationsService,
// 复用其 queryDescendantOrgIds() 只读 helper 展开 includeDescendants(closure 非判权)。
@Module({
  imports: [DatabaseModule, PermissionsModule, OrganizationsModule],
  controllers: [MembersController],
  providers: [MembersService],
})
export class MembersModule {}
