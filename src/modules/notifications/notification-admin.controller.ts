import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import {
  ApiBizErrorResponse,
  ApiWrappedNullResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  CreateNotificationDto,
  ListNotificationAdminQueryDto,
  NotificationAdminDetailDto,
  NotificationAdminListItemDto,
  NotificationSmsSendResultDto,
  SendNotificationSmsDto,
  UpdateNotificationDto,
} from './notification.dto';
import { NotificationService } from './notification.service';

// 统一通知模块 S1 站内信渠道(第 28 模块 notifications 扩 controller)admin surface
// (评审稿 unified-notification-dispatcher-review.md §5 / member-notification-review.md §6 端点 1-8)。
// 入口仅 JwtAuthGuard(全局),**不**挂 @Roles / @RequirePermissions;判权全在 service rbac.can()(R 模式,镜像 content)。

function buildAuditMeta(req: Request): AuditMeta {
  return {
    requestId: req.id as string,
    ip: req.ip ?? null,
    ua: req.headers['user-agent'] ?? null,
  };
}

@ApiTags('Admin - Notifications')
@ApiBearerAuth()
@ApiExtraModels(
  NotificationAdminDetailDto,
  NotificationAdminListItemDto,
  NotificationSmsSendResultDto,
)
@Controller('admin/v1/notifications')
export class NotificationAdminController {
  constructor(private readonly service: NotificationService) {}

  @Post()
  @ApiOperation({ summary: '新建通知草稿(create → draft) [rbac: notification.create.record]' })
  @ApiWrappedOkResponse(NotificationAdminDetailDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.NOTIFICATION_TYPE_INVALID,
    BizCode.NOTIFICATION_VISIBILITY_INVALID,
    BizCode.NOTIFICATION_VISIBLE_ORG_INVALID,
  )
  create(
    @Body() dto: CreateNotificationDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<NotificationAdminDetailDto> {
    return this.service.create(dto, user, buildAuditMeta(req));
  }

  @Get()
  @ApiOperation({
    summary:
      '通知分页列表(status/type/visibility/pinned 过滤;admin 见全部状态全可见档;回显 readCount) [rbac: notification.read.record]',
  })
  @ApiWrappedPageResponse(NotificationAdminListItemDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(@Query() query: ListNotificationAdminQueryDto, @CurrentUser() user: CurrentUserPayload) {
    return this.service.list(query, user);
  }

  @Get(':id')
  @ApiOperation({
    summary: '通知详情(回显 readCount〔不自增〕) [rbac: notification.read.record]',
  })
  @ApiWrappedOkResponse(NotificationAdminDetailDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN, BizCode.NOTIFICATION_NOT_FOUND)
  detail(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<NotificationAdminDetailDto> {
    return this.service.detail(id, user);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      '更新 admin 广播通知(published 的 Effect 字段真实变化自动回 draft;pinned/语义等价更新不撤回;archived/system-directed → 31030) [rbac: notification.update.record]',
  })
  @ApiWrappedOkResponse(NotificationAdminDetailDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.NOTIFICATION_NOT_FOUND,
    BizCode.NOTIFICATION_TYPE_INVALID,
    BizCode.NOTIFICATION_VISIBILITY_INVALID,
    BizCode.NOTIFICATION_VISIBLE_ORG_INVALID,
    BizCode.NOTIFICATION_INVALID_STATUS_TRANSITION,
  )
  update(
    @Param('id') id: string,
    @Body() dto: UpdateNotificationDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<NotificationAdminDetailDto> {
    return this.service.update(id, dto, user, buildAuditMeta(req));
  }

  @Delete(':id')
  @ApiOperation({
    summary: '软删 admin 广播通知(system-directed → 31030) [rbac: notification.delete.record]',
  })
  @ApiWrappedNullResponse()
  @ApiBizErrorResponse(
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.NOTIFICATION_NOT_FOUND,
    BizCode.NOTIFICATION_INVALID_STATUS_TRANSITION,
  )
  @HttpCode(HttpStatus.OK)
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<null> {
    await this.service.softDelete(id, user, buildAuditMeta(req));
    return null;
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '发布 admin 广播通知(draft → published,publishGeneration 原子 +1,置 publishedAt = 推送时刻;system-directed → 31030) [rbac: notification.publish.record]',
  })
  @ApiWrappedOkResponse(NotificationAdminDetailDto)
  @ApiBizErrorResponse(
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.NOTIFICATION_NOT_FOUND,
    BizCode.NOTIFICATION_INVALID_STATUS_TRANSITION,
  )
  publish(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<NotificationAdminDetailDto> {
    return this.service.publish(id, user, buildAuditMeta(req));
  }

  @Post(':id/unpublish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '撤回 admin 广播通知(published → draft,保留 publishedAt;system-directed → 31030) [rbac: notification.publish.record]',
  })
  @ApiWrappedOkResponse(NotificationAdminDetailDto)
  @ApiBizErrorResponse(
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.NOTIFICATION_NOT_FOUND,
    BizCode.NOTIFICATION_INVALID_STATUS_TRANSITION,
  )
  unpublish(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<NotificationAdminDetailDto> {
    return this.service.unpublish(id, user, buildAuditMeta(req));
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '归档 admin 广播通知(published → archived,终态不可逆;system-directed → 31030) [rbac: notification.publish.record]',
  })
  @ApiWrappedOkResponse(NotificationAdminDetailDto)
  @ApiBizErrorResponse(
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.NOTIFICATION_NOT_FOUND,
    BizCode.NOTIFICATION_INVALID_STATUS_TRANSITION,
  )
  archive(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<NotificationAdminDetailDto> {
    return this.service.archive(id, user, buildAuditMeta(req));
  }

  @Post(':id/send-sms')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '显式发起 admin 广播短信兜底(计费确认必需:confirmed=true 才真发,false 仅预览;须已发布且声明短信渠道;system-directed → 31013) [rbac: notification.send.sms]',
  })
  @ApiWrappedOkResponse(NotificationSmsSendResultDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.NOTIFICATION_NOT_FOUND,
    BizCode.NOTIFICATION_SMS_NOT_SENDABLE,
    BizCode.SMS_CHANNEL_NOT_CONFIGURED,
  )
  sendSms(
    @Param('id') id: string,
    @Body() dto: SendNotificationSmsDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<NotificationSmsSendResultDto> {
    return this.service.sendSms(id, dto, user, buildAuditMeta(req));
  }
}
