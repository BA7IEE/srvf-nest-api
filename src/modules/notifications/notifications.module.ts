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
import { NotificationDispatcher } from './notification-dispatcher';
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
// 模板配置(admin)。站内 S1 状态机 / 可见性 / 已读零改,微信为 additive 分支。
//
// 统一通知 S3 producer 接入 + 派发器 Effect 正式化(2026-06-25;评审稿 §2.2/§3.6/§6):NotificationDispatcher
// (architecture-boundary §3.6 首个真实 Effect;dispatchTargeted 建已发布定向行 → 站内 + 微信〔复用 S2 dispatchDirected〕)
// **exports 出**供 producer(招新 recruitment / 入队 team-join)在业务事务 commit 后单向直调(D-N5;防环:本模块绝不回调 producer)。
// feed 扩 buildFeedWhere(广播可见 ∪ 本人定向),recipientMemberId 定向收件人;**仍不引 cron/queue/事件总线**。
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
    NotificationDispatcher,
    WechatSubscribeTemplateService,
  ],
  // 统一通知 S3:导出 NotificationDispatcher Effect 供 producer(招新发号 / 入队)commit 后直调(D-N5 单向直调)。
  exports: [NotificationDispatcher],
})
export class NotificationsModule implements OnModuleInit {
  private readonly logger = new Logger(NotificationsModule.name);

  onModuleInit(): void {
    this.logger.log('Birthday greeting cron registered (09:00 Asia/Shanghai)');
  }
}
