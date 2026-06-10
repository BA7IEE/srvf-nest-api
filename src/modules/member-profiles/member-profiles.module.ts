import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { MemberProfilesController } from './member-profiles.controller';
import { MemberProfilesService } from './member-profiles.service';

// Slow-4 T2(2026-06-11):imports PermissionsModule 供 MemberProfilesService 注入 RbacService
// (沿 P0-F contribution-rules 范本;评审稿 slow4-rbac-business-face-review.md §3.2)。
@Module({
  imports: [DatabaseModule, PermissionsModule],
  controllers: [MemberProfilesController],
  providers: [MemberProfilesService],
})
export class MemberProfilesModule {}
