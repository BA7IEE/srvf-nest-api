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

// ===== 统一通知形状值(S1 仅用默认值;S2/S3 additive 扩值不返工;评审稿 §2.1 / §9.1)=====
// audienceType:广播(S1 唯一) | directed(S3 定向)。
export const NOTIFICATION_AUDIENCE_BROADCAST = 'broadcast';
// sourceType:admin 撰写(S1 唯一) | system 自动(S3 producer)。
export const NOTIFICATION_SOURCE_ADMIN = 'admin';
// channels:站内(S1 唯一) | wechat(S2) | sms(S5)。
export const NOTIFICATION_CHANNEL_IN_APP = 'in-app';

// ===== DTO 上限(评审稿 §3;站内信是短文案,body 上限远小于 content 的 50000)=====
export const NOTIFICATION_TITLE_MAX = 200;
export const NOTIFICATION_BODY_MAX = 5000;
export const NOTIFICATION_TYPE_CODE_MAX = 64;
export const NOTIFICATION_VISIBILITY_CODE_MAX = 32;
// 列表分页上限(镜像 content；比通用 100 更紧)
export const NOTIFICATION_PAGE_SIZE_MAX = 50;
