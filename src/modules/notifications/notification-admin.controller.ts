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
@ApiExtraModels(NotificationAdminDetailDto, NotificationAdminListItemDto)
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
      '更新通知(draft/published 可改,archived 冻结 → 31030) [rbac: notification.update.record]',
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
  @ApiOperation({ summary: '软删通知(任意态) [rbac: notification.delete.record]' })
  @ApiWrappedNullResponse()
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN, BizCode.NOTIFICATION_NOT_FOUND)
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
      '发布通知(draft → published,置 publishedAt = 推送时刻) [rbac: notification.publish.record]',
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
    summary: '撤回通知(published → draft,保留 publishedAt) [rbac: notification.publish.record]',
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
    summary: '归档通知(published → archived,终态不可逆) [rbac: notification.publish.record]',
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
}
