import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import {
  NOTIFICATION_BODY_MAX,
  NOTIFICATION_CHANNELS_ALLOWED,
  NOTIFICATION_PAGE_SIZE_MAX,
  NOTIFICATION_STATUSES,
  NOTIFICATION_TITLE_MAX,
  NOTIFICATION_TYPE_CODE_MAX,
  NOTIFICATION_VISIBILITIES,
  NOTIFICATION_VISIBILITY_CODE_MAX,
  WECHAT_SUBSCRIPTION_TEMPLATE_IDS_MAX,
  WECHAT_TEMPLATE_ID_MAX,
} from './notification.constants';

// 统一通知模块 S1 站内信渠道(2026-06-25):admin 写面 + app 会员读取面 DTO 集合
// (评审稿 unified-notification-dispatcher-review.md §5 / member-notification-review.md §3/§6/§7)。
//
// 物理隔离铁律(api-surface-policy §2.1):各 surface DTO 独立 class,**禁止**继承 / Pick / Omit
// 其它 surface DTO。admin 面含 authorUserId / readCount / 统一形状列(管理视角);
// **读取面(app)DTO 永不暴露 authorUserId / visibleOrganizationIds / statusCode / readCount**
// (L3 / 内部纪律;读者只见 published);visibilityCode 可回显(展示档位),org-id 列表对读者隐藏。
// S1 不暴露 audienceType / sourceType / channels 入参(统一形状列由 service 置默认 broadcast/admin/in-app;
// 渠道勾选 / 定向 = S2/S3 additive)。

// ============ admin 入参 ============

export class CreateNotificationDto {
  @ApiProperty({ description: '标题', maxLength: NOTIFICATION_TITLE_MAX })
  @IsString()
  @MinLength(1)
  @MaxLength(NOTIFICATION_TITLE_MAX)
  title!: string;

  @ApiProperty({
    description: '正文(纯文本 / 轻 Markdown;服务端不解析 / 不消毒 HTML)',
    maxLength: NOTIFICATION_BODY_MAX,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(NOTIFICATION_BODY_MAX)
  body!: string;

  @ApiProperty({
    description: '通知类型(notification_type 字典 ACTIVE item;失败 → 31010)',
    maxLength: NOTIFICATION_TYPE_CODE_MAX,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(NOTIFICATION_TYPE_CODE_MAX)
  notificationTypeCode!: string;

  @ApiProperty({
    description: '可见档(每条选一,去 public = 4 档;失败 → 31011)',
    enum: NOTIFICATION_VISIBILITIES as unknown as string[],
    maxLength: NOTIFICATION_VISIBILITY_CODE_MAX,
  })
  @IsString()
  @IsIn(NOTIFICATION_VISIBILITIES, { message: '可见级无效' })
  visibilityCode!: string;

  @ApiPropertyOptional({
    description:
      '可见部门 orgId 数组(仅 department 档必填且须全为活跃部门;非 department 档须空;失败 → 31012)',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  visibleOrganizationIds?: string[];

  @ApiPropertyOptional({ description: '是否置顶', default: false })
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @ApiPropertyOptional({
    description:
      '目标渠道(默认仅站内 ["in-app"];可勾 "wechat" 机会式推送已订阅会员;站内恒发,服务端强制含 in-app)',
    enum: NOTIFICATION_CHANNELS_ALLOWED as unknown as string[],
    isArray: true,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @IsIn(NOTIFICATION_CHANNELS_ALLOWED, { each: true, message: '渠道无效' })
  channels?: string[];
}

// 更新:全字段可选(沿 content / recruitment update 范式);archived 态被 service 冻结(31030)。
export class UpdateNotificationDto {
  @ApiPropertyOptional({ description: '标题', maxLength: NOTIFICATION_TITLE_MAX })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(NOTIFICATION_TITLE_MAX)
  title?: string;

  @ApiPropertyOptional({ description: '正文', maxLength: NOTIFICATION_BODY_MAX })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(NOTIFICATION_BODY_MAX)
  body?: string;

  @ApiPropertyOptional({ description: '通知类型(notification_type 字典 ACTIVE item)' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(NOTIFICATION_TYPE_CODE_MAX)
  notificationTypeCode?: string;

  @ApiPropertyOptional({
    description: '可见档(每条选一,去 public = 4 档)',
    enum: NOTIFICATION_VISIBILITIES as unknown as string[],
  })
  @IsOptional()
  @IsString()
  @IsIn(NOTIFICATION_VISIBILITIES, { message: '可见级无效' })
  visibilityCode?: string;

  @ApiPropertyOptional({
    description: '可见部门 orgId 数组(department 档必填活跃部门;非 department 档须空)',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  visibleOrganizationIds?: string[];

  @ApiPropertyOptional({ description: '是否置顶' })
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @ApiPropertyOptional({
    description: '目标渠道(可改;站内恒发,服务端强制含 in-app;published 也可改,下次 publish 生效)',
    enum: NOTIFICATION_CHANNELS_ALLOWED as unknown as string[],
    isArray: true,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @IsIn(NOTIFICATION_CHANNELS_ALLOWED, { each: true, message: '渠道无效' })
  channels?: string[];
}

// ============ admin 短信兜底发起入参 / 出参(统一通知 S5;评审稿 §4 / D-N4 计费确认)============

// 显式发起短信入参:confirmed 必填(缺失 → 通用 400);仅 confirmed=true 才真发(计费确认必需,防误触发资费)。
// confirmed=false = 预览(返回可计费受众计数,零发送零计费,供前端二次确认「将向 N 人发短信 = N 条计费」)。
export class SendNotificationSmsDto {
  @ApiProperty({
    description:
      '计费确认(必填)。true = 确认发送短信(每收件人 1 条计费);false = 仅预览受众计数,不发送不计费',
  })
  @IsBoolean()
  confirmed!: boolean;
}

// 短信兜底发起回执:recipientCount = 可见且有手机的可计费受众(= sent + failed + skipped,confirmed=true 时);
// confirmed=false 预览时 sent/failed/skipped 恒 0(零发送)。
export class NotificationSmsSendResultDto {
  @ApiProperty({ description: '本次是否实际发送(false = 仅预览计数,未发送)' })
  confirmed!: boolean;
  @ApiProperty({ description: '可计费受众数(可见且有手机;= 将发短信条数,N 人 = N 条计费)' })
  recipientCount!: number;
  @ApiProperty({ description: '实际发送成功条数(预览恒 0)' })
  sent!: number;
  @ApiProperty({ description: '发送失败条数(FAILED 落 delivery 不阻断;预览恒 0)' })
  failed!: number;
  @ApiProperty({
    description: '跳过条数(已发送 / 同日同模板幂等 / 日封顶 / 间隔;不计费;预览恒 0)',
  })
  skipped!: number;
}

// ============ admin 列表入参(评审稿 §6 端点 2;admin 见全部状态 / 全可见档)============

export class ListNotificationAdminQueryDto {
  @ApiPropertyOptional({ description: '页码', default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    description: `每页数量(上限 ${NOTIFICATION_PAGE_SIZE_MAX})`,
    default: 20,
    minimum: 1,
    maximum: NOTIFICATION_PAGE_SIZE_MAX,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(NOTIFICATION_PAGE_SIZE_MAX)
  pageSize: number = 20;

  @ApiPropertyOptional({ description: '按状态过滤(draft/published/archived)' })
  @IsOptional()
  @IsString()
  @IsIn(NOTIFICATION_STATUSES)
  statusCode?: string;

  @ApiPropertyOptional({ description: '按通知类型过滤' })
  @IsOptional()
  @IsString()
  @MaxLength(NOTIFICATION_TYPE_CODE_MAX)
  notificationTypeCode?: string;

  @ApiPropertyOptional({ description: '按可见档过滤' })
  @IsOptional()
  @IsString()
  @IsIn(NOTIFICATION_VISIBILITIES)
  visibilityCode?: string;

  @ApiPropertyOptional({ description: '按置顶过滤' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' || value === true
      ? true
      : value === 'false' || value === false
        ? false
        : value,
  )
  @IsBoolean()
  pinned?: boolean;
}

// ============ admin 出参(含 authorUserId / readCount / 统一形状列)============

// 列表 item(无 body;含 readCount 触达 + 统一形状列;评审稿 §6 端点 2)。
export class NotificationAdminListItemDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() notificationTypeCode!: string;
  @ApiProperty() statusCode!: string;
  @ApiProperty() visibilityCode!: string;
  @ApiProperty({ description: '受众类型(S1 恒 broadcast;统一形状前向兼容)' }) audienceType!: string;
  @ApiProperty({ description: '来源类型(S1 恒 admin;统一形状前向兼容)' }) sourceType!: string;
  @ApiProperty({ type: [String], description: '目标渠道(S1 恒 ["in-app"];统一形状前向兼容)' })
  channels!: string[];
  @ApiProperty() pinned!: boolean;
  @ApiProperty({ description: '已读人数(反范式)' }) readCount!: number;
  @ApiPropertyOptional({ nullable: true }) publishedAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) authorUserId!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

// 详情(含 body + visibleOrganizationIds + readCount〔不增〕;评审稿 §6 端点 3)。
export class NotificationAdminDetailDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() body!: string;
  @ApiProperty() notificationTypeCode!: string;
  @ApiProperty() statusCode!: string;
  @ApiProperty() visibilityCode!: string;
  @ApiProperty({ type: [String] }) visibleOrganizationIds!: string[];
  @ApiProperty({ description: '受众类型(S1 恒 broadcast;统一形状前向兼容)' }) audienceType!: string;
  @ApiProperty({ description: '来源类型(S1 恒 admin;统一形状前向兼容)' }) sourceType!: string;
  @ApiProperty({ type: [String], description: '目标渠道(S1 恒 ["in-app"];统一形状前向兼容)' })
  channels!: string[];
  @ApiProperty() pinned!: boolean;
  @ApiProperty({ description: '已读人数(admin 详情不自增)' }) readCount!: number;
  @ApiPropertyOptional({ nullable: true }) publishedAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) authorUserId!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

// ============ app 读取面入参(评审稿 §7;读者无 status/visibility 过滤——可见性由 service 闸控)============

export class ListNotificationReadQueryDto {
  @ApiPropertyOptional({ description: '页码', default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    description: `每页数量(上限 ${NOTIFICATION_PAGE_SIZE_MAX})`,
    default: 20,
    minimum: 1,
    maximum: NOTIFICATION_PAGE_SIZE_MAX,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(NOTIFICATION_PAGE_SIZE_MAX)
  pageSize: number = 20;
}

// ============ app 读取面出参(零敏感:无 authorUserId / visibleOrganizationIds / statusCode / readCount)============

// 列表 item(无 body;每项带 read 已读标志;评审稿 §7 端点 9)。
export class NotificationReadListItemDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() notificationTypeCode!: string;
  @ApiProperty() pinned!: boolean;
  @ApiProperty({ description: '本人是否已读' }) read!: boolean;
  @ApiPropertyOptional({ nullable: true }) publishedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
}

// 详情(含 body;带 read 标志;**不自动已读**——已读由显式 mark-read 端点;评审稿 §7 端点 10)。
export class NotificationReadDetailDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() body!: string;
  @ApiProperty() notificationTypeCode!: string;
  @ApiProperty({ description: '可见档(展示用;不回显可见部门 orgId 列表)' }) visibilityCode!: string;
  @ApiProperty() pinned!: boolean;
  @ApiProperty({ description: '本人是否已读' }) read!: boolean;
  @ApiPropertyOptional({ nullable: true }) publishedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
}

// mark-read 回执(幂等;恒 read=true;评审稿 §7 端点 11)。
export class MarkNotificationReadResponseDto {
  @ApiProperty({ description: '已读标志(幂等;二次调用仍 true,readCount 不重复增)' }) read!: boolean;
}

// unread-count 未读数(badge;评审稿 §7 端点 12)。
export class NotificationUnreadCountDto {
  @ApiProperty({ description: '未读通知数(可见 + published − 本人已读)' }) unreadCount!: number;
}

// ============ 微信订阅 quota app 面入参 / 出参(统一通知 S2;评审稿 §3.3)============

// ack 入参:本次 wx.requestSubscribeMessage 用户**接受**的模板 ID 列表(前端只在真授权后上报)。
export class WechatSubscriptionAckDto {
  @ApiProperty({
    type: [String],
    description: '本次用户接受授权的微信订阅模板 ID(additive 累积;后端封顶 D-N2)',
  })
  @IsArray()
  @ArrayNotEmpty({ message: '至少一个模板 ID' })
  @ArrayMaxSize(WECHAT_SUBSCRIPTION_TEMPLATE_IDS_MAX)
  @IsString({ each: true })
  @MaxLength(WECHAT_TEMPLATE_ID_MAX, { each: true })
  templateIds!: string[];
}

// status 入参:查这些模板的剩余配额(逗号分隔 query;前端据此判断是否需补授权)。
export class WechatSubscriptionStatusQueryDto {
  @ApiProperty({
    description: '模板 ID 列表(逗号分隔,如 tmpl_a,tmpl_b;或重复 query 参数)',
    type: String,
  })
  @Transform(({ value }: { value: unknown }) => {
    if (Array.isArray(value)) return value.map((v) => String(v));
    if (typeof value === 'string') {
      return value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return [];
  })
  @IsArray()
  @ArrayNotEmpty({ message: '至少一个模板 ID' })
  @ArrayMaxSize(WECHAT_SUBSCRIPTION_TEMPLATE_IDS_MAX)
  @IsString({ each: true })
  @MaxLength(WECHAT_TEMPLATE_ID_MAX, { each: true })
  templateIds!: string[];
}

// 单模板配额(ack / status 共用出参项)。
export class WechatQuotaItemDto {
  @ApiProperty() templateId!: string;
  @ApiProperty({ description: '该模板当前可用配额(0 = 已用尽,前端应提示补授权)' })
  availableCount!: number;
}

// ack 回执:各模板 +1(封顶)后的新配额。
export class WechatSubscriptionAckResponseDto {
  @ApiProperty({ type: [WechatQuotaItemDto] }) quotas!: WechatQuotaItemDto[];
}

// status 回执:各模板当前配额(无配额行 = 0)。
export class WechatSubscriptionStatusResponseDto {
  @ApiProperty({ type: [WechatQuotaItemDto] }) quotas!: WechatQuotaItemDto[];
}

// ============ 微信订阅模板配置 admin 面入参 / 出参(统一通知 S2;D-N3 运营可配)============

// upsert 入参(notificationTypeCode 取自 URL path;body 仅 templateId / enabled / remarks)。
export class UpsertWechatSubscribeTemplateDto {
  @ApiPropertyOptional({
    description: '微信订阅消息模板 ID(小程序后台审批后填;留空 = 该类型微信渠道不可发)',
    maxLength: WECHAT_TEMPLATE_ID_MAX,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(WECHAT_TEMPLATE_ID_MAX)
  templateId?: string;

  @ApiPropertyOptional({ description: '是否启用(默认 true)', default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: '备注', maxLength: 200, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  remarks?: string;
}

// 模板配置出参(admin list / upsert 共用)。
export class WechatSubscribeTemplateDto {
  @ApiProperty() notificationTypeCode!: string;
  @ApiPropertyOptional({ nullable: true, description: '模板 ID(null = 未配置,微信渠道不可发)' })
  templateId!: string | null;
  @ApiProperty() enabled!: boolean;
  @ApiPropertyOptional({ nullable: true }) remarks!: string | null;
  @ApiPropertyOptional({ nullable: true }) updatedBy!: string | null;
  @ApiProperty() updatedAt!: Date;
}
