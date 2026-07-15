import { Injectable } from '@nestjs/common';
import { type Notification } from '@prisma/client';

import { PrismaService } from '../../database/prisma.service';
import {
  NOTIFICATION_AUDIENCE_DIRECTED,
  NOTIFICATION_AUDIENCE_BROADCAST,
  NOTIFICATION_CHANNEL_IN_APP,
  NOTIFICATION_CHANNEL_WECHAT,
  NOTIFICATION_DIRECTED_VISIBILITY,
  NOTIFICATION_VISIBILITY_MANAGEMENT,
  NOTIFICATION_SOURCE_SYSTEM,
  NOTIFICATION_STATUS_PUBLISHED,
} from './notification.constants';
import { NotificationWechatDispatchService } from './notification-wechat-dispatch.service';

// 统一通知模块 S3:派发器 Effect 正式化(评审稿 unified-notification-dispatcher-review.md §2.2 / §3.6;
// architecture-boundary.md §3.6 的**首个真实 Effect 类**——「真实副作用路径」= 微信订阅消息外部 API)。
//
// **Effect 含**(§3.6 Should contain):通知派发 / 外部 API 调用(微信,委派 S2 渠道臂)/ 渠道 payload 组装 / 投递记录。
// **Effect 不含**(§3.6 Should not contain):核心状态跃迁决策(留 producer service)/ 主 DB 事务所有权
//   (producer 业务事务由 producer 持有;本 Effect 的定向行 create 是 commit 后**独立**小写,不并入 producer 事务)/
//   DTO 呈现。**外部 HTTP 一律在 producer 业务事务之外**(§6.2:8s HTTP 绝不拖事务)。
//
// 形态:producer(招新发号 / 入队)在业务事务 **commit 之后**直调 dispatchTargeted(D-N5 同步直调,无事件总线);
// **防环**:producer → notifications **单向**,本 Effect **绝不** import / 回调招新或 team-join。
// **系统定向跳过 admin 状态机**:直接建 published 行(sourceType=system / authorUserId=null),不污染 admin CRUD 路径。
export interface DispatchTargetedInput {
  // 收件人 member(广播为 null,本入口仅定向故必填);recipientMemberId 挂行,feed 仅本人可见。
  recipientMemberId: string;
  // notificationTypeCode ∈ notification_type 字典(招新走 'recruitment');system 来源由 producer 固定,不校验用户输入。
  notificationTypeCode: string;
  title: string;
  body: string;
  // 目标渠道(默认仅站内;发号传 ['in-app','wechat']、入队传 ['in-app']);站内恒发,normalize 强制含 in-app。
  channels?: string[];
}

export interface DispatchSystemBroadcastInput {
  notificationTypeCode: string;
  title: string;
  body: string;
}

@Injectable()
export class NotificationDispatcher {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wechatDispatch: NotificationWechatDispatchService,
  ) {}

  // 定向派发:建已发布定向行(站内即达)+ 按声明派微信(机会式,有 quota 才推)。返建出的行(供测试 / 追溯)。
  // **本方法可能抛**(如定向行 create 的 DB 异常);producer 侧以 try-catch 包裹保证「派发失败绝不破坏 promote/入队」
  // (行为锁);微信分支本身永不抛(dispatchDirected 内 catch)。
  async dispatchTargeted(input: DispatchTargetedInput): Promise<Notification> {
    const channels = this.normalizeChannels(input.channels);

    // 1. 建已发布定向 Notification 行(system / authorUserId=null / 跳过 draft 直 published,不走 admin 状态机)。
    const row = await this.prisma.notification.create({
      data: {
        title: input.title,
        body: input.body,
        notificationTypeCode: input.notificationTypeCode,
        statusCode: NOTIFICATION_STATUS_PUBLISHED,
        publishedAt: new Date(),
        visibilityCode: NOTIFICATION_DIRECTED_VISIBILITY,
        audienceType: NOTIFICATION_AUDIENCE_DIRECTED,
        sourceType: NOTIFICATION_SOURCE_SYSTEM,
        channels,
        recipientMemberId: input.recipientMemberId,
        authorUserId: null,
      },
    });

    // 2. 站内 = 该行本身(会员 feed 拉取消费,零发送)。
    // 3. 微信(声明含 wechat 时;复用 S2 单收件人发送 + delivery + quota 扣减;dispatchDirected 永不抛)。
    if (channels.includes(NOTIFICATION_CHANNEL_WECHAT)) {
      await this.wechatDispatch.dispatchDirected(row);
    }

    return row;
  }

  // 系统管理面广播：直接建 published 行，management 可见、仅站内、无收件人 fan-out。
  // v0.47.0 队保单到期提醒使用；不走 admin 草稿状态机，也不触发微信 / 短信。
  async dispatchSystemBroadcast(input: DispatchSystemBroadcastInput): Promise<Notification> {
    return this.prisma.notification.create({
      data: {
        title: input.title,
        body: input.body,
        notificationTypeCode: input.notificationTypeCode,
        statusCode: NOTIFICATION_STATUS_PUBLISHED,
        publishedAt: new Date(),
        visibilityCode: NOTIFICATION_VISIBILITY_MANAGEMENT,
        audienceType: NOTIFICATION_AUDIENCE_BROADCAST,
        sourceType: NOTIFICATION_SOURCE_SYSTEM,
        channels: [NOTIFICATION_CHANNEL_IN_APP],
        recipientMemberId: null,
        authorUserId: null,
      },
    });
  }

  // 系统会员面广播：一个 broadcast 行供所有可使用 App 的未删除会员读取；不展开 N 条定向行。
  // 当前由公开活动发布使用，仍是 commit 后独立 Effect，失败由 producer 吞并记录。
  async dispatchSystemMemberBroadcast(input: DispatchSystemBroadcastInput): Promise<Notification> {
    return this.prisma.notification.create({
      data: {
        title: input.title,
        body: input.body,
        notificationTypeCode: input.notificationTypeCode,
        statusCode: NOTIFICATION_STATUS_PUBLISHED,
        publishedAt: new Date(),
        visibilityCode: NOTIFICATION_DIRECTED_VISIBILITY,
        audienceType: NOTIFICATION_AUDIENCE_BROADCAST,
        sourceType: NOTIFICATION_SOURCE_SYSTEM,
        channels: [NOTIFICATION_CHANNEL_IN_APP],
        recipientMemberId: null,
        authorUserId: null,
      },
    });
  }

  // 渠道归一:站内恒发 → 强制含 in-app;去重保序(in-app 在前)。producer 传码非用户输入,不做白名单校验。
  private normalizeChannels(channels: string[] | undefined): string[] {
    const set = new Set<string>([NOTIFICATION_CHANNEL_IN_APP]);
    for (const c of channels ?? []) set.add(c);
    return [
      NOTIFICATION_CHANNEL_IN_APP,
      ...[...set].filter((c) => c !== NOTIFICATION_CHANNEL_IN_APP),
    ];
  }
}
