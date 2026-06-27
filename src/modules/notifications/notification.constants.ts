// 统一通知模块 S1:站内信渠道业务常量(2026-06-25)。
//
// 冻结评审稿:docs/archive/reviews/unified-notification-dispatcher-review.md(T0 修订;统一形状 §2/§5/§11)
//   supersede 原 docs/archive/reviews/member-notification-review.md §2/§3(站内信渠道照建)。
// 镜像 content(状态机 String 常量无 enum;沿 recruitment / content 范式);可见性**复用** content.visibility
//   纯函数(canSeeContent / buildVisibilityWhere),故 4 档可见值直接引用 content.constants 保证值一致
//   (零第二套口径;通知去 public = 仅 member/formal_member/department/management 入白名单)。

import {
  CONTENT_VISIBILITY_DEPARTMENT,
  CONTENT_VISIBILITY_FORMAL_MEMBER,
  CONTENT_VISIBILITY_MANAGEMENT,
  CONTENT_VISIBILITY_MEMBER,
} from '../content/content.constants';

// ===== 状态(String;admin 动作立即生效无 cron;镜像 content §3)=====
// 值与 content 一致('published' 须等于 content.CONTENT_STATUS_PUBLISHED,使复用的 canSeeContent 对
// 通知行同样判定;状态机本身在 notification.service 内镜像实现,不复用 content.service)。
export const NOTIFICATION_STATUS_DRAFT = 'draft';
export const NOTIFICATION_STATUS_PUBLISHED = 'published';
export const NOTIFICATION_STATUS_ARCHIVED = 'archived';
export const NOTIFICATION_STATUSES = [
  NOTIFICATION_STATUS_DRAFT,
  NOTIFICATION_STATUS_PUBLISHED,
  NOTIFICATION_STATUS_ARCHIVED,
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

// ===== 可见档(每条选一;去 public = 4 档,会员面专属;复用 content 可见值)=====
// 直接引用 content 可见常量 → 复用的 content.visibility 纯函数对通知行天然适用(零第二套);
// 通知永不写 public(本白名单不含),故复用的 buildVisibilityWhere / canSeeContent 中 public 分支对通知恒不命中
// = 效果即「去 public 的 4 档」(原 T0 ⑤ / 修订 §5)。
export const NOTIFICATION_VISIBILITY_MEMBER = CONTENT_VISIBILITY_MEMBER;
export const NOTIFICATION_VISIBILITY_FORMAL_MEMBER = CONTENT_VISIBILITY_FORMAL_MEMBER;
export const NOTIFICATION_VISIBILITY_DEPARTMENT = CONTENT_VISIBILITY_DEPARTMENT;
export const NOTIFICATION_VISIBILITY_MANAGEMENT = CONTENT_VISIBILITY_MANAGEMENT;
export const NOTIFICATION_VISIBILITIES = [
  NOTIFICATION_VISIBILITY_MEMBER,
  NOTIFICATION_VISIBILITY_FORMAL_MEMBER,
  NOTIFICATION_VISIBILITY_DEPARTMENT,
  NOTIFICATION_VISIBILITY_MANAGEMENT,
] as const;
export type NotificationVisibility = (typeof NOTIFICATION_VISIBILITIES)[number];

// ===== 通知类型字典(notificationTypeCode ∈ notification_type 字典 ACTIVE item;评审稿 §9.4)=====
export const NOTIFICATION_TYPE_DICT_CODE = 'notification_type';
// 招新 producer 定向通知类型(发号 / 入队结果;seed notification_type item 'recruitment' 已内置 = '招新公告')。
export const NOTIFICATION_TYPE_RECRUITMENT = 'recruitment';
// 活动/考勤 producer 定向通知类型(S4:考勤结果 / 报名审批 / 活动取消;三者同属活动域,复用 seed
// notification_type item 'activity-reminder' 已内置 = '活动提醒';S4 不新增字典 type,评审稿 §9.4)。
export const NOTIFICATION_TYPE_ACTIVITY_REMINDER = 'activity-reminder';

// 定向(directed)通知的可见档(统一通知 S3):收件人恒为 member,故置 member 档。
// feed 的广播分支已按 audienceType=broadcast 收窄,定向行**不借**可见档泄漏(仅 recipientMemberId=本人可见);
// 此值仅作语义诚实占位 + admin 列表展示,实际可见性由 recipientMemberId 闸控(notification-read.service)。
export const NOTIFICATION_DIRECTED_VISIBILITY = NOTIFICATION_VISIBILITY_MEMBER;

// ===== 统一通知形状值(S1 仅用默认值;S2/S3 additive 扩值不返工;评审稿 §2.1 / §9.1)=====
// audienceType:广播(S1/S2 admin) | directed(S3 producer 定向单一收件人)。
export const NOTIFICATION_AUDIENCE_BROADCAST = 'broadcast';
export const NOTIFICATION_AUDIENCE_DIRECTED = 'directed';
// sourceType:admin 撰写(S1/S2) | system 自动(S3 producer,authorUserId=null,跳过 admin 状态机直 published)。
export const NOTIFICATION_SOURCE_ADMIN = 'admin';
export const NOTIFICATION_SOURCE_SYSTEM = 'system';
// channels:站内(恒发) | wechat(S2) | sms(S5);代码常量非字典(渠道是工程枚举,评审稿 §9.4)。
export const NOTIFICATION_CHANNEL_IN_APP = 'in-app';
export const NOTIFICATION_CHANNEL_WECHAT = 'wechat';
// admin 可勾选渠道白名单(S2 = in-app + wechat;sms = S5 再放开)。站内恒发,service 归一时强制含 in-app。
export const NOTIFICATION_CHANNELS_ALLOWED = [
  NOTIFICATION_CHANNEL_IN_APP,
  NOTIFICATION_CHANNEL_WECHAT,
] as const;

// ===== 微信订阅 quota 渠道常量(统一通知 S2;评审稿 §3 / D-N2)=====
// quota 上限(每 memberId × templateId;D-N2 默认 5):防前端 ack 刷量 + 对齐微信侧累积限制。
// 达上限 ack no-op(+1 仅在 availableCount < cap 时生效)。
export const WECHAT_SUBSCRIPTION_QUOTA_CAP = 5;
// ack / status 单次最多模板数(防滥用;一次订阅授权通常 ≤ 3 模板)。
export const WECHAT_SUBSCRIPTION_TEMPLATE_IDS_MAX = 10;
export const WECHAT_TEMPLATE_ID_MAX = 128;

// NotificationDelivery.status(代码常量;仅推送渠道落,站内不落)。
export const DELIVERY_STATUS_SENT = 'sent';
export const DELIVERY_STATUS_FAILED = 'failed';
export const DELIVERY_STATUS_SKIPPED = 'skipped';

// NotificationDelivery.reasonCode(skipped / failed 的细分原因;前端 / 运维诊断 + 补授权信号)。
export const DELIVERY_REASON_NO_OPENID = 'no-openid'; // 可见但 member 无绑定 openid → 不发
export const DELIVERY_REASON_NO_QUOTA = 'no-quota'; // 原子扣减 count===0(并发竞争扣空)→ 不发 + 补授权信号
export const DELIVERY_REASON_NO_TEMPLATE = 'no-template'; // 该通知类型未配置 / 未启用微信模板 → 整渠道跳过
export const DELIVERY_REASON_NEED_RESUBSCRIBE = 'need-resubscribe'; // 微信 43101 用户拒收/无授权 → 补授权信号(条件回补 quota)
export const DELIVERY_REASON_INVALID_OPENID = 'invalid-openid'; // 微信 40003 openid 非法
export const DELIVERY_REASON_TEMPLATE_PARAM = 'template-param'; // 微信 47003 模板参数不匹配
export const DELIVERY_REASON_TOKEN_FAILED = 'token-failed'; // access_token 取用失败 / 通道不可用
export const DELIVERY_REASON_API_FAILED = 'api-failed'; // 其余微信上游失败(HTTP / 网络 / 非 0 errcode)

// ===== DTO 上限(评审稿 §3;站内信是短文案,body 上限远小于 content 的 50000)=====
export const NOTIFICATION_TITLE_MAX = 200;
export const NOTIFICATION_BODY_MAX = 5000;
export const NOTIFICATION_TYPE_CODE_MAX = 64;
export const NOTIFICATION_VISIBILITY_CODE_MAX = 32;
// 列表分页上限(镜像 content；比通用 100 更紧)
export const NOTIFICATION_PAGE_SIZE_MAX = 50;
