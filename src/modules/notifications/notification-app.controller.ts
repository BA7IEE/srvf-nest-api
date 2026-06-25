import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';

import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import {
  ListNotificationReadQueryDto,
  MarkNotificationReadResponseDto,
  NotificationReadDetailDto,
  NotificationReadListItemDto,
  NotificationUnreadCountDto,
} from './notification.dto';
import { NotificationReadService } from './notification-read.service';

// 统一通知模块 S1 站内信渠道(第 28 模块 notifications 扩 controller)app/v1 会员读取面
// (评审稿 unified-notification-dispatcher-review.md §5 / member-notification-review.md §7 端点 9-12)。
//
// 入口仅全局 JwtAuthGuard;**不**挂 @Roles / @Public / RBAC / 限流。准入(canUseApp=false → 403)+
// 4 档可见性(复用 content.visibility,去 public)全前置在 service;读者出参零敏感。详情命中不可见档 → 404 防枚举。
// **路由顺序**:字面段 `unread-count` 必须声明在 `:id` 之前,否则被 `:id` 参数捕获(镜像既有惯例)。
@ApiTags('Mobile - Notifications')
@ApiBearerAuth()
@ApiExtraModels(
  NotificationReadListItemDto,
  NotificationReadDetailDto,
  MarkNotificationReadResponseDto,
  NotificationUnreadCountDto,
)
@Controller('app/v1/notifications')
export class NotificationAppController {
  constructor(private readonly service: NotificationReadService) {}

  @Get()
  @ApiOperation({
    summary: '会员通知列表(准入 canUseApp;按 4 档可见性过滤;每项带 read 已读标志) [auth]',
  })
  @ApiWrappedPageResponse(NotificationReadListItemDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  list(
    @Query() query: ListNotificationReadQueryDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ) {
    return this.service.appList(currentUser, query);
  }

  // 字面段:必须在 `:id` 之前声明(否则 'unread-count' 被当作 :id)。
  @Get('unread-count')
  @ApiOperation({ summary: '会员未读通知数(badge;可见 + published − 本人已读) [auth]' })
  @ApiWrappedOkResponse(NotificationUnreadCountDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  unreadCount(@CurrentUser() currentUser: CurrentUserPayload): Promise<NotificationUnreadCountDto> {
    return this.service.unreadCount(currentUser);
  }

  @Get(':id')
  @ApiOperation({
    summary: '会员通知详情(准入 canUseApp;可见级不通过 → 404 防枚举;不自动已读) [auth]',
  })
  @ApiWrappedOkResponse(NotificationReadDetailDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.FORBIDDEN, BizCode.NOTIFICATION_NOT_FOUND)
  detail(
    @Param('id') id: string,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<NotificationReadDetailDto> {
    return this.service.appDetail(currentUser, id);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '标记通知已读(幂等 upsert;首读 readCount 原子 +1,二次 no-op;不可见 → 404 防枚举) [auth]',
  })
  @ApiWrappedOkResponse(MarkNotificationReadResponseDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.FORBIDDEN, BizCode.NOTIFICATION_NOT_FOUND)
  markRead(
    @Param('id') id: string,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<MarkNotificationReadResponseDto> {
    return this.service.markRead(currentUser, id);
  }
}
