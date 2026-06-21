import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { UsersModule } from '../users/users.module';
import { ContentAdminController } from './content-admin.controller';
import { ContentAppController } from './content-app.controller';
import { ContentPublicController } from './content-public.controller';
import { ContentReadService } from './content-read.service';
import { ContentService } from './content.service';

// CMS 内容发布模块(第 28 模块)T2-T4(2026-06-21):content 模块装配(评审稿 §5.2 / §8)。
// 消费:Database(PrismaService 主表 + dict/org 校验)/ Permissions(rbac.can)/ AuditLogs(写审计)/
// Attachments(AttachmentsService:上传/确认/删走写路径 RBAC + listOwnerAttachmentsTrusted /
// resolveSignedUrlTrusted 可信只读)/ Users(AppIdentityResolver:app/v1 准入 canUseApp)。
// 三 surface:admin(ContentAdminController 12 端点;T2)+ open(ContentPublicController 2 端点,
// @Public + content-public throttle;T3)+ app(ContentAppController 2 端点,canUseApp 准入 + 5 档可见性;T4)。
@Module({
  imports: [DatabaseModule, PermissionsModule, AuditLogsModule, AttachmentsModule, UsersModule],
  controllers: [ContentAdminController, ContentPublicController, ContentAppController],
  providers: [ContentService, ContentReadService],
})
export class ContentModule {}
