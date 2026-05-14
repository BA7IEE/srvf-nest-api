import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AttachmentMimeConfigsController } from './attachment-mime-configs.controller';
import { AttachmentMimeConfigsService } from './attachment-mime-configs.service';
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
//   BizCode 13020 / 13021 / 13023;沿 D7 v1.0 §4.2 / §16 Q1-Q7;入口 @Roles(SUPER_ADMIN, ADMIN);
//   不接 rbac.can();不接 audit_logs)
// - PR #4(2026-05-15):AttachmentMimeConfig CRUD(6 端点 path /api/v2/attachment-mime-configs[/:id[/status]];
//   BizCode 13022 / 13024 / 13025 + 复用 13020;沿 D7 v1.0 §4.3 / §16 + Q1-Q8;入口 @Roles(SUPER_ADMIN, ADMIN);
//   不接 rbac.can();不接 audit_logs;依赖 typeConfigId FK Restrict)
//
// 待实装(留后续 PR):
// - PR #5:AttachmentSizeLimitConfig CRUD(沿 D7 v1.0 §4.4;依赖 typeConfigId;1:1)
// - 跨表引用约束(ATTACHMENT_TYPE_CONFIG_IN_USE / ATTACHMENT_MIME_CONFIG_IN_USE)等 attachments 主模块
//   引用逻辑落地后再触发实装(沿 Q6 / Q7 v1.0 拍板)
@Module({
  imports: [DatabaseModule],
  controllers: [AttachmentTypeConfigsController, AttachmentMimeConfigsController],
  providers: [AttachmentTypeConfigsService, AttachmentMimeConfigsService],
})
export class AttachmentConfigsModule {}
