import { Body, Controller, Get, Param, Patch, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { RequiresPermission } from '../../../common/decorators/route-authz.decorator';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
} from '../../../common/decorators/api-response.decorator';
import { IdParamDto } from '../../../common/dto/id-param.dto';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { ActivityTimePolicySelectionQueryService } from '../activity-time-policy-selection-query.service';
import { ActivityTimePolicySelectionService } from '../activity-time-policy-selection.service';
import {
  AdminActivityTimePolicySelectionQueryDto,
  AdminActivityTimePolicySelectionResponseDto,
  AdminActivityTimePolicySelectionResultDto,
  AdminPatchActivityTimePolicySelectionDto,
} from '../dto/admin/activity-time-policy-selection.dto';

@ApiTags('Admin - Activity Time Policy Selection')
@ApiBearerAuth()
@Controller('admin/v1/activities')
export class AdminActivityTimePolicySelectionController {
  constructor(
    private readonly service: ActivityTimePolicySelectionService,
    private readonly queries: ActivityTimePolicySelectionQueryService,
  ) {}

  @Get(':id/time-policy-selection')
  @RequiresPermission('activity.time-policy.read', { require: 'all', engine: 'authz-scoped' })
  @ApiOperation({ summary: '分页读取活动时长政策选择及解析摘要 [rbac: activity.time-policy.read]' })
  @ApiWrappedOkResponse(AdminActivityTimePolicySelectionResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_TIME_POLICY_SELECTION_REFERENCE_UNAVAILABLE,
  )
  get(
    @Param() params: IdParamDto,
    @Query() query: AdminActivityTimePolicySelectionQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.queries.get(params.id, query, user, 'admin');
  }

  @Patch(':id/time-policy-selection')
  @RequiresPermission('activity.time-policy.select', { require: 'all', engine: 'authz-scoped' })
  @ApiOperation({ summary: '增量设置草稿活动的时长政策选择 [rbac: activity.time-policy.select]' })
  @ApiWrappedOkResponse(AdminActivityTimePolicySelectionResultDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_TIME_POLICY_SELECTION_INVALID,
    BizCode.ACTIVITY_TIME_POLICY_SELECTION_REFERENCE_UNAVAILABLE,
    BizCode.ACTIVITY_TIME_POLICY_SELECTION_STALE,
    BizCode.ACTIVITY_TIME_POLICY_SELECTION_COMMAND_CONFLICT,
    BizCode.ACTIVITY_TIME_POLICY_SELECTION_RECEIPT_INVALID,
    BizCode.ACTIVITY_TIME_POLICY_SELECTION_POLICY_UNAVAILABLE,
    BizCode.ACTIVITY_TIME_POLICY_SELECTION_UNCHANGED,
  )
  patch(
    @Param() params: IdParamDto,
    @Body() dto: AdminPatchActivityTimePolicySelectionDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.patch(params.id, dto, user, 'admin', {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    });
  }
}
