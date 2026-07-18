import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import appConfig from '../../config/app.config';
import databaseConfig from '../../config/database.config';
import { DatabaseModule } from '../../database/database.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { SmsModule } from '../sms/sms.module';
import { WechatModule } from '../wechat/wechat.module';
import { NotificationOutboxHandlers } from './notification-outbox.handlers';
import { NotificationOutboxService } from './notification-outbox.service';
import { NotificationOutboxWorker } from './notification-outbox.worker';
import { NotificationSmsDispatchService } from './notification-sms-dispatch.service';
import { NotificationWechatDispatchService } from './notification-wechat-dispatch.service';
import { WechatSubscribeTemplateService } from './wechat-subscribe-template.service';

// 独立 worker 进程的最小依赖图：不 import AppModule / ScheduleModule，因而不注册 HTTP、
// 不启动两个 cron，也不装配全局 Guard。复用既有 SMS/WeChat provider 与 DB-backed RBAC。
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [appConfig, databaseConfig] }),
    DatabaseModule,
    PermissionsModule,
    SmsModule,
    WechatModule,
  ],
  providers: [
    NotificationOutboxService,
    NotificationOutboxHandlers,
    NotificationOutboxWorker,
    NotificationSmsDispatchService,
    NotificationWechatDispatchService,
    WechatSubscribeTemplateService,
  ],
})
export class NotificationOutboxWorkerModule {}
