import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedArrayResponse,
  ApiWrappedOkResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../../audit-logs/audit-logs.types';
import {
  ActivityPositionParamsDto,
  ActivityPositionResponseDto,
  ActivityPositionsActivityParamsDto,
  CreateActivityPositionDto,
  UpdateActivityPositionDto,
} from '../activity-positions.dto';
import { ActivityPositionsService } from '../activity-positions.service';

@ApiTags('Admin - Activity Positions')
@ApiBearerAuth()
@Controller('admin/v1/activities')
export class AdminActivityPositionsController {
  constructor(private readonly service: ActivityPositionsService) {}

  @Post(':activityId/positions')
  @ApiOperation({
    summary: '创建活动岗位 [rbac: activity.update.record]',
  })
  @ApiWrappedOkResponse(ActivityPositionResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_POSITION_NAME_ALREADY_EXISTS,
    BizCode.ATTENDANCE_ROLE_CODE_INVALID,
    BizCode.ACTIVITY_GENDER_REQUIREMENT_CODE_INVALID,
    BizCode.ACTIVITY_POSITION_TIME_RANGE_INVALID,
    BizCode.ACTIVITY_POSITION_CAPACITY_INVALID,
  )
  create(
    @Param() params: ActivityPositionsActivityParamsDto,
    @Body() dto: CreateActivityPositionDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ActivityPositionResponseDto> {
    return this.service.create(params.activityId, dto, currentUser, this.buildAuditMeta(req));
  }

  @Get(':activityId/positions')
  @ApiOperation({ summary: '活动岗位列表(sortOrder/createdAt/id 升序) [auth]' })
  @ApiWrappedArrayResponse(ActivityPositionResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.ACTIVITY_NOT_FOUND)
  list(
    @Param() params: ActivityPositionsActivityParamsDto,
  ): Promise<ActivityPositionResponseDto[]> {
    return this.service.list(params.activityId);
  }

  @Get(':activityId/positions/:activityPositionId')
  @ApiOperation({ summary: '活动岗位详情(软删/跨活动统一 20002) [auth]' })
  @ApiWrappedOkResponse(ActivityPositionResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_POSITION_NOT_FOUND,
  )
  findOne(@Param() params: ActivityPositionParamsDto): Promise<ActivityPositionResponseDto> {
    return this.service.findOne(params.activityId, params.activityPositionId);
  }

  @Patch(':activityId/positions/:activityPositionId')
  @ApiOperation({
    summary: '部分更新活动岗位(容量锁后重读) [rbac: activity.update.record]',
  })
  @ApiWrappedOkResponse(ActivityPositionResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_POSITION_NOT_FOUND,
    BizCode.ACTIVITY_POSITION_NAME_ALREADY_EXISTS,
    BizCode.ATTENDANCE_ROLE_CODE_INVALID,
    BizCode.ACTIVITY_GENDER_REQUIREMENT_CODE_INVALID,
    BizCode.ACTIVITY_POSITION_TIME_RANGE_INVALID,
    BizCode.ACTIVITY_POSITION_CAPACITY_INVALID,
  )
  update(
    @Param() params: ActivityPositionParamsDto,
    @Body() dto: UpdateActivityPositionDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ActivityPositionResponseDto> {
    return this.service.update(
      params.activityId,
      params.activityPositionId,
      dto,
      currentUser,
      this.buildAuditMeta(req),
    );
  }

  @Delete(':activityId/positions/:activityPositionId')
  @ApiOperation({
    summary: '软删活动岗位(pending/pass/waitlisted 报名守卫) [rbac: activity.update.record]',
  })
  @ApiWrappedOkResponse(ActivityPositionResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_POSITION_NOT_FOUND,
    BizCode.ACTIVITY_POSITION_HAS_ACTIVE_REGISTRATIONS,
  )
  softDelete(
    @Param() params: ActivityPositionParamsDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ActivityPositionResponseDto> {
    return this.service.softDelete(
      params.activityId,
      params.activityPositionId,
      currentUser,
      this.buildAuditMeta(req),
    );
  }

  private buildAuditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }
}
