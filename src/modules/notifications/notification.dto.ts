import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
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
  NOTIFICATION_PAGE_SIZE_MAX,
  NOTIFICATION_STATUSES,
  NOTIFICATION_TITLE_MAX,
  NOTIFICATION_TYPE_CODE_MAX,
  NOTIFICATION_VISIBILITIES,
  NOTIFICATION_VISIBILITY_CODE_MAX,
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
