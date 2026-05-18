import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

// P0-D PR-3(2026-05-17):import AuditLogsModule 注入 AuditLogsService,供
// UsersService.changeMyPassword 在事务内写 audit log(event: password.change.self)。
// 沿 emergency-contacts / certificates / activity-registrations 等模块的接入范式。
//
// P0-F PR-3B(2026-05-18):import PermissionsModule 注入 RbacService,供 UsersService
// 8 个管理方法首句 `await this.assertCanOrThrow(currentUser, '<permission.code>')`。
// 沿 PR-1 permissions / PR-2A dict / org / member-department / contribution-rule /
// PR-2B attachment-config / storage-setting 接入范式。
@Module({
  imports: [DatabaseModule, AuditLogsModule, PermissionsModule],
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
