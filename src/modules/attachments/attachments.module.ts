import { Module } from '@nestjs/common';
import { StorageModule } from '../../common/storage/storage.module';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';

// V2.x C-7 attachments 实施 PR #6b / #6c + PR #90:attachments 主模块声明。
//
// **依赖**:
// - DatabaseModule:PrismaService(主表 + 配置三表查询 + 业务表 ownerId 校验)
// - PermissionsModule:RbacService(Service 层 rbac.can();PermissionsModule export RbacService)
// - AuditLogsModule(PR #6c):AuditLogsService(create / delete 同事务 fail-fast 落 audit;
//     沿 cert / emergency-contacts / activities 范式)
// - StorageModule(PR #90):STORAGE_PROVIDER + StorageSettingsService;接通 accessUrl + delete 事务外删 Provider
@Module({
  imports: [DatabaseModule, PermissionsModule, AuditLogsModule, StorageModule],
  controllers: [AttachmentsController],
  providers: [AttachmentsService],
})
export class AttachmentsModule {}
