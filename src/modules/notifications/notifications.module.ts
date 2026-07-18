import { Logger, Module, type OnModuleInit } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { SmsModule } from '../sms/sms.module';
import { UsersModule } from '../users/users.module';
import { WechatModule } from '../wechat/wechat.module';
import { BirthdayGreetingService } from './birthday-greeting.service';
import { ExpiryReminderService } from './expiry-reminder.service';
import { NotificationAdminController } from './notification-admin.controller';
import { NotificationAppController } from './notification-app.controller';
import { NotificationDispatcher } from './notification-dispatcher';
import { NotificationOutboxHandlers } from './notification-outbox.handlers';
import { NotificationOutboxService } from './notification-outbox.service';
import { NotificationOutboxWorker } from './notification-outbox.worker';
import { NotificationReadService } from './notification-read.service';
import { NotificationService } from './notification.service';
import { NotificationSmsDispatchService } from './notification-sms-dispatch.service';
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
// (NotificationAppController 4 端点)。**站内 = 纯 pull 零发送**；v0.47.0 经独立 D 档评审只解锁第二个
// expiry-reminder @Cron；D-Outbox 只引 PostgreSQL durable outbox + 独立 worker，不引 Redis / BullMQ /
// 事件总线或第三个 cron。生日/到期/publish/admin SMS 的业务事务只写 intent，provider 始终在 worker 事务外执行。
// 消费:Database(PrismaService 主表 + dict/org 校验)/ Sms(生日批)/ Permissions(rbac.can,R 模式判权)/
// AuditLogs(admin 写 4 事件)/ Users(AppIdentityResolver:app/v1 准入 canUseApp + 可见性 ctx)。
//
// 统一通知 S2 微信订阅 quota 渠道(2026-06-25;评审稿 §3/§7/§9.1):additive 接入 WechatModule(订阅消息发送)+
// 微信派发分支(NotificationWechatDispatchService,由 publish 同事务 intent 驱动)+ quota ack/status(app)+
// 模板配置(admin)。站内 S1 状态机 / 可见性 / 已读零改,微信为 additive 分支。
//
// 统一通知 S3 producer 接入 + 派发器 Effect 正式化(2026-06-25;评审稿 §2.2/§3.6/§6):NotificationDispatcher
// (architecture-boundary §3.6 首个真实 Effect;dispatchTargeted 建已发布定向行 → 站内 + 微信〔复用 S2 dispatchDirected〕)
// **exports 出**供 producer(招新 recruitment / 入队 team-join)在业务事务 commit 后单向直调(D-N5;防环:本模块绝不回调 producer)。
// feed 扩 buildFeedWhere(广播可见 ∪ 本人定向),recipientMemberId 定向收件人;S3 本身**不引 cron/queue/事件总线**。
//
// 统一通知 S4 活动·考勤 producer 定向触发(2026-06-25):报名审批 / 活动取消 / 考勤终审三处 producer commit 后
// 事务外 try-catch 直调 S3 dispatchTargeted(仅站内;0 schema/0 端点/0 RBAC 码,纯 producer 接入)。
//
// 统一通知 S5 短信兜底渠道(2026-06-27;评审稿 §4):NotificationSmsDispatchService —— admin 显式发起紧急召集短信
// (NotificationAdminController +1 端点 send-sms,计费确认必需;新码 notification.send.sms)。复用 SmsModule
// SmsProviderRouter.sendNotification(additive)+ NotificationDelivery + sms_send_logs,逐可见有手机者单发,
// 防滥发继承同号封顶/间隔/同日同模板幂等,FAILED 逐人不阻断,maskPhone;**短信永不随 publish 自动发**;
// confirmed=true 同事务写 audit + 逐 member reserved intent，提交后仅执行 request-owned fence；失败 child 独立重试，
// HTTP 结果不是最终投递态。
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
    ExpiryReminderService,
    NotificationService,
    NotificationReadService,
    NotificationSubscriptionService,
    NotificationWechatDispatchService,
    NotificationSmsDispatchService,
    NotificationDispatcher,
    NotificationOutboxService,
    NotificationOutboxHandlers,
    NotificationOutboxWorker,
    WechatSubscribeTemplateService,
  ],
  // 统一通知 S3:导出 NotificationDispatcher Effect 供 producer(招新发号 / 入队)commit 后直调(D-N5 单向直调)。
  exports: [NotificationDispatcher, NotificationOutboxService],
})
export class NotificationsModule implements OnModuleInit {
  private readonly logger = new Logger(NotificationsModule.name);

  onModuleInit(): void {
    this.logger.log('Birthday greeting cron registered (09:00 Asia/Shanghai)');
    this.logger.log('Expiry reminder cron registered (09:00 Asia/Shanghai)');
  }
}
