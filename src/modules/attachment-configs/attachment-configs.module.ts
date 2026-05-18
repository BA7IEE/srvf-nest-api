import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { AttachmentMimeConfigsController } from './attachment-mime-configs.controller';
import { AttachmentMimeConfigsService } from './attachment-mime-configs.service';
import { AttachmentSizeLimitConfigsController } from './attachment-size-limit-configs.controller';
import { AttachmentSizeLimitConfigsService } from './attachment-size-limit-configs.service';
import { AttachmentTypeConfigsController } from './attachment-type-configs.controller';
import { AttachmentTypeConfigsService } from './attachment-type-configs.service';

// V2.x C-7 attachments:attachment-configs 模块声明。
//
// 沿 D7 v1.0 §2.2 实施物清单 + 用户 Step 1 拍板:**单模块多 controller** 范式
// (沿 PermissionsModule / DictionariesModule):三张配置表强相关,放一个 module;
// 但 controller / service 按表拆,便于后续 PR 增量加入。
//
// 已实装(累计):
// - PR #3(2026-05-15):AttachmentTypeConfig CRUD(6 端点 path /api/v2/attachment-type-configs[/:id[/status]];
//   BizCode 13020 / 13021 / 13023;沿 D7 v1.0 §4.2 / §16 Q1-Q7)
// - PR #4(2026-05-15):AttachmentMimeConfig CRUD(6 端点 path /api/v2/attachment-mime-configs[/:id[/status]];
//   BizCode 13022 / 13024 / 13025 + 复用 13020;依赖 typeConfigId FK Restrict)
// - PR #5(2026-05-15):AttachmentSizeLimitConfig CRUD(**5 端点** path /api/v2/attachment-size-limit-configs[/:id];
//   BizCode 13026 / 13027 + 复用 13020;依赖 typeConfigId FK Restrict;
//   **本表无 status 字段**,5 端点不含独立 status 端点;1:1 关系)
// - PR #6d(2026-05-15):imports AuditLogsModule;3 个 config service 注入 AuditLogsService;
//   11 个写端点同事务 fail-fast 落 audit(event=attachment.config.change)
// - P0-F PR-2B(2026-05-18):**撤销 F4 v1.0 "不接 rbac.can()" 锁**;
//   imports PermissionsModule;3 个 service 注入 RbacService;入口移除 @Roles(SA, ADMIN);
//   失败统一抛 BizException(BizCode.RBAC_FORBIDDEN)(30100);沿 PR-2A dict / org 范本
//
// 配置三表 CRUD 完整落地;后续:
// - 跨表引用约束(ATTACHMENT_TYPE_CONFIG_IN_USE / ATTACHMENT_MIME_CONFIG_IN_USE /
//   ATTACHMENT_SIZE_LIMIT_CONFIG_IN_USE)等 attachments 主模块引用逻辑落地后再触发实装
//   (沿 Q2 / Q6 / Q7 v1.0 拍板)
@Module({
  imports: [DatabaseModule, AuditLogsModule, PermissionsModule],
  controllers: [
    AttachmentTypeConfigsController,
    AttachmentMimeConfigsController,
    AttachmentSizeLimitConfigsController,
  ],
  providers: [
    AttachmentTypeConfigsService,
    AttachmentMimeConfigsService,
    AttachmentSizeLimitConfigsService,
  ],
})
export class AttachmentConfigsModule {}
