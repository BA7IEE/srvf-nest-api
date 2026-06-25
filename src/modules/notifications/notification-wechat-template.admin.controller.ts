import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';

import {
  ApiBizErrorResponse,
  ApiWrappedArrayResponse,
  ApiWrappedOkResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { UpsertWechatSubscribeTemplateDto, WechatSubscribeTemplateDto } from './notification.dto';
import { WechatSubscribeTemplateService } from './wechat-subscribe-template.service';

// 统一通知 S2:微信订阅模板配置 admin 面(D-N3 运营可配;notificationTypeCode → templateId)。
// 入口仅 JwtAuthGuard;R 模式 service rbac.can(读 notification.read.record / 写 notification.update.template),
// **无 @RequirePermissions**(镜像本仓 content / notification S1 范式)。独立 base path 避与
// admin/v1/notifications/:id 参数路由冲突。
@ApiTags('Admin - Notifications')
@ApiBearerAuth()
@ApiExtraModels(WechatSubscribeTemplateDto)
@Controller('admin/v1/notification-wechat-templates')
export class NotificationWechatTemplateAdminController {
  constructor(private readonly service: WechatSubscribeTemplateService) {}

  @Get()
  @ApiOperation({
    summary:
      '列出微信订阅模板配置(各通知类型 → templateId / 启用态;运维查哪些类型可发微信) [rbac: notification.read.record]',
  })
  @ApiWrappedArrayResponse(WechatSubscribeTemplateDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(@CurrentUser() user: CurrentUserPayload): Promise<WechatSubscribeTemplateDto[]> {
    return this.service.listForAdmin(user);
  }

  @Put(':typeCode')
  @ApiOperation({
    summary:
      '配置某通知类型的微信模板 ID + 启用态(upsert;运营改不重部署;类型须 ∈ notification_type 字典) [rbac: notification.update.template]',
  })
  @ApiWrappedOkResponse(WechatSubscribeTemplateDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.NOTIFICATION_TYPE_INVALID,
  )
  upsert(
    @Param('typeCode') typeCode: string,
    @Body() dto: UpsertWechatSubscribeTemplateDto,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<WechatSubscribeTemplateDto> {
    return this.service.upsertForAdmin(typeCode, dto, user);
  }
}
