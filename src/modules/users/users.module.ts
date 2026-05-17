import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

// P0-D PR-3(2026-05-17):import AuditLogsModule 注入 AuditLogsService,供
// UsersService.changeMyPassword 在事务内写 audit log(event: password.change.self)。
// 沿 emergency-contacts / certificates / activity-registrations 等模块的接入范式。
@Module({
  imports: [DatabaseModule, AuditLogsModule],
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
