import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { AttachmentAuditRecorder } from './attachment-audit-recorder';
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
//
// Route B Phase 4e(2026-06-01):`AttachmentsMeLegacyController`(`GET /api/v2/attachments/me/uploaded`)
// 已删除(无生产消费者,未建 app/v1 替代;`listMyUploaded` service 保留为未来 app/v1/my/attachments
// building block)。沿 docs/api-surface-migration-plan.md §3.3 / §6 Phase 4。`AttachmentsController`
// 已收为 `@Controller('admin/v1/attachments')`,无前缀共享、无注册顺序约束。
@Module({
  imports: [DatabaseModule, PermissionsModule, AuditLogsModule, StorageModule],
  controllers: [AttachmentsController],
  providers: [AttachmentsService, AttachmentAuditRecorder],
})
export class AttachmentsModule {}
