import { Logger, Module, type OnModuleInit } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { SmsModule } from '../sms/sms.module';
import { UsersModule } from '../users/users.module';
import { WechatModule } from '../wechat/wechat.module';
import { BirthdayGreetingService } from './birthday-greeting.service';
import { NotificationAdminController } from './notification-admin.controller';
import { NotificationAppController } from './notification-app.controller';
import { NotificationReadService } from './notification-read.service';
import { NotificationService } from './notification.service';
import { NotificationSubscriptionService } from './notification-subscription.service';
import { NotificationWechatDispatchService } from './notification-wechat-dispatch.service';
import { NotificationWechatTemplateAdminController } from './notification-wechat-template.admin.controller';
import { WechatSubscribeTemplateService } from './wechat-subscribe-template.service';

// B 队列 F5-T2(2026-06-11):notifications 模块——G-7(通知/短信/推送)首个落地点
// (冻结评审稿 docs/archive/reviews/queue-b-otp-birthday-infra-review.md §6.3)。
//
// 统一通知模块 S1 站内信渠道(2026-06-25;冻结评审稿
// docs/archive/reviews/unified-notification-dispatcher-review.md §5/§11):本模块从生日批单服务扩为
// 「统一通知中枢」首切片——admin 撰写/发布面(NotificationAdminController 8 端点)+ 会员站内信拉取面
// (NotificationAppController 4 端点)。**站内 = 纯 pull 零发送**,不新增第二个 @Cron / queue / 事件总线
// (§8 同步发送;微信 quota / 短信兜底 / producer 定向 = S2-S5 切片,additive 不返工)。
// 消费:Database(PrismaService 主表 + dict/org 校验)/ Sms(生日批)/ Permissions(rbac.can,R 模式判权)/
// AuditLogs(admin 写 4 事件)/ Users(AppIdentityResolver:app/v1 准入 canUseApp + 可见性 ctx)。
//
// 统一通知 S2 微信订阅 quota 渠道(2026-06-25;评审稿 §3/§7/§9.1):additive 接入 WechatModule(订阅消息发送)+
// 微信派发分支(NotificationWechatDispatchService,publish 事务外同步调用)+ quota ack/status(app)+
// 模板配置(admin)。**派发器 Effect 正式化仍待 S3**(本切片是聚焦微信渠道分支,非通用 NotificationDispatcher);
// 站内 S1 状态机 / 可见性 / 已读零改,微信为 additive 分支。
//
// onModuleInit 锚行:docker-smoke 以 grep 本行确证 ScheduleModule.forRoot() 在
// 生产镜像内装配成功且生日 job 完成注册(评审稿 E-B10;改动本文案需同步
// .github/workflows/docker-smoke.yml 的 grep 步骤)。
@Module({
  imports: [
    DatabaseModule,
    SmsModule,
    PermissionsModule,
    AuditLogsModule,
    UsersModule,
    WechatModule,
  ],
  controllers: [
    NotificationAdminController,
    NotificationAppController,
    NotificationWechatTemplateAdminController,
  ],
  providers: [
    BirthdayGreetingService,
    NotificationService,
    NotificationReadService,
    NotificationSubscriptionService,
    NotificationWechatDispatchService,
    WechatSubscribeTemplateService,
  ],
})
export class NotificationsModule implements OnModuleInit {
  private readonly logger = new Logger(NotificationsModule.name);

  onModuleInit(): void {
    this.logger.log('Birthday greeting cron registered (09:00 Asia/Shanghai)');
  }
}
