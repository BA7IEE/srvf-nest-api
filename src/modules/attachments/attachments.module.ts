import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';

// V2.x C-7 attachments 实施 PR #6b(2026-05-15):attachments 主模块声明。
//
// **依赖**:
// - DatabaseModule:PrismaService(主表 + 配置三表查询 + 业务表 ownerId 校验)
// - PermissionsModule:RbacService(Service 层 rbac.can();首次业务模块接 RBAC;
//     PermissionsModule 同步加 exports: [RbacService])
//
// **本 PR 不接入 AuditLogsModule**(沿 Step 2 拍板:audit 留 PR #6c)。
@Module({
  imports: [DatabaseModule, PermissionsModule],
  controllers: [AttachmentsController],
  providers: [AttachmentsService],
})
export class AttachmentsModule {}
