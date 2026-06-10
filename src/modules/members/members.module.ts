import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';

// Slow-4 T2(2026-06-11):imports PermissionsModule 供 MembersService 注入 RbacService
// (沿 P0-F contribution-rules 范本;评审稿 slow4-rbac-business-face-review.md §3.1)。
@Module({
  imports: [DatabaseModule, PermissionsModule],
  controllers: [MembersController],
  providers: [MembersService],
})
export class MembersModule {}
