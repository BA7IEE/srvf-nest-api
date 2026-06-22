import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiBizErrorResponse,
  ApiWrappedPageResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../../common/dto/pagination.dto';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import {
  AdminRegistrationListItemDto,
  ListRegistrationsQueryDto,
} from '../activity-registrations.dto';
import { ActivityRegistrationsService } from '../activity-registrations.service';

// 跨轴只读 admin controller(2026-06-23;队员/审批跨轴只读查询 goal)。
//
// 背景:后端把报名建成沿活动轴嵌套子资源(admin/v1/activities/:activityId/registrations),
// 沿轴下钻全有;本文件补**跨轴横扫**两类只读缺口(GAP-001 Tier2 / GAP-002 Tier3):
//   1. AdminRegistrationsController(admin/v1/registrations):跨所有活动按 status 横扫报名
//      (审批工作台「待我审批的」);
//   2. AdminMemberRegistrationsController(admin/v1/members/:memberId/registrations):某队员
//      跨活动报名履历(队员 360「活动履历」tab;镜像 admin-member-insurances 结构 + MEMBER_NOT_FOUND)。
//
// 入口仅全局 JwtAuthGuard,判权下沉 service 层 rbac.can('activity-registration.read.record')
// (复用现成 read 码,零新码;沿既有 admin registrations controller Slow-4 T3 范式)。
// 既有嵌套路径 controller(activity-registrations.controller.ts)行为零变更——此为新增只读 surface。
// item 自带 activity 上下文(activityId/title);出参 AdminRegistrationListItemDto(同 surface,不派生)。

@ApiTags('Admin - Registrations')
@ApiBearerAuth()
@Controller('admin/v1/registrations')
export class AdminRegistrationsController {
  constructor(private readonly service: ActivityRegistrationsService) {}

  @Get()
  @ApiOperation({
    summary:
      '跨活动报名横扫(审批工作台;分页 + 可选 statusCode;脱离 :activityId 路径段;item 带 activity 上下文) [rbac: activity-registration.read.record]',
  })
  @ApiWrappedPageResponse(AdminRegistrationListItemDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  listAll(
    @Query() query: ListRegistrationsQueryDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AdminRegistrationListItemDto>> {
    return this.service.listAllForAdmin(query, currentUser);
  }
}

@ApiTags('Admin - Registrations')
@ApiBearerAuth()
@Controller('admin/v1/members/:memberId/registrations')
export class AdminMemberRegistrationsController {
  constructor(private readonly service: ActivityRegistrationsService) {}

  @Get()
  @ApiOperation({
    summary:
      '某队员报名履历(队员 360;分页 + 可选 statusCode;item 带 activity 上下文;不存在/软删 → MEMBER_NOT_FOUND) [rbac: activity-registration.read.record]',
  })
  @ApiWrappedPageResponse(AdminRegistrationListItemDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
  )
  listForMember(
    @Param('memberId') memberId: string,
    @Query() query: ListRegistrationsQueryDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AdminRegistrationListItemDto>> {
    return this.service.listForMemberAdmin(memberId, query, currentUser);
  }
}
