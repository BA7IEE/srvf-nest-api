import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import appConfig from '../../config/app.config';
import databaseConfig from '../../config/database.config';
import { DatabaseModule } from '../../database/database.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { SmsModule } from '../sms/sms.module';
import { WechatModule } from '../wechat/wechat.module';
import { WecomModule } from '../wecom/wecom.module';
import { NotificationOutboxHandlers } from './notification-outbox.handlers';
import { NotificationOutboxService } from './notification-outbox.service';
import { NotificationOutboxWorker } from './notification-outbox.worker';
import { NotificationSmsDispatchService } from './notification-sms-dispatch.service';
import { NotificationWechatDispatchService } from './notification-wechat-dispatch.service';
import { NotificationWecomDispatchService } from './notification-wecom-dispatch.service';
import { WecomMessagePresenter } from './notification-wecom.presenter';
import { WechatSubscribeTemplateService } from './wechat-subscribe-template.service';

// 独立 worker 进程的最小依赖图：不 import AppModule / ScheduleModule，因而不注册 HTTP、
// 不启动两个 cron，也不装配全局 Guard。复用既有 SMS/WeChat provider 与 DB-backed RBAC。
//
// T5B(2026-08-02)接入 WecomModule:企业微信 child 的 Effect 由本进程执行,
// 故 route/凭证/settings 必须在这张依赖图里可解析。
// ⚠️ **旧 worker 不认识 `notification.wecom-*`**,会把它判成 unsupported terminal dead(§10.8)——
// 启用 messageEnabled 之前必须确认 fleet 只剩新版本,流程见
// docs/ops/wecom-message-channel-rollout.md。
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [appConfig, databaseConfig] }),
    DatabaseModule,
    PermissionsModule,
    SmsModule,
    WechatModule,
    WecomModule,
  ],
  providers: [
    NotificationOutboxService,
    NotificationOutboxHandlers,
    NotificationOutboxWorker,
    NotificationSmsDispatchService,
    NotificationWechatDispatchService,
    NotificationWecomDispatchService,
    WecomMessagePresenter,
    WechatSubscribeTemplateService,
  ],
})
export class NotificationOutboxWorkerModule {}
