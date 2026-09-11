import { Body, Controller, Get, Param, Patch, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { RequiresPermission } from '../../../common/decorators/route-authz.decorator';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../../common/decorators/api-response.decorator';
import { PageResultDto } from '../../../common/dto/pagination.dto';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { ActivityTimePolicySelectionQueryService } from '../activity-time-policy-selection-query.service';
import { ActivityTimePolicySelectionService } from '../activity-time-policy-selection.service';
import {
  AppActivityTimePolicyOptionDto,
  AppActivityTimePolicyOptionsQueryDto,
  AppActivityTimePolicySelectionQueryDto,
  AppActivityTimePolicySelectionResponseDto,
  AppActivityTimePolicySelectionResultDto,
  AppPatchActivityTimePolicySelectionDto,
} from '../dto/app/app-activity-time-policy-selection.dto';
import { AppManagedActivityParamsDto } from '../dto/app/app-managed-activity.dto';

@ApiTags('Mobile - Managed Activity Time Policy Selection')
@ApiBearerAuth()
@ApiExtraModels(AppActivityTimePolicyOptionDto, PageResultDto)
@Controller('app/v1/my/managed-activities')
export class AppManagedActivityTimePolicySelectionController {
  constructor(
    private readonly service: ActivityTimePolicySelectionService,
    private readonly queries: ActivityTimePolicySelectionQueryService,
  ) {}

  @Get('time-policy-options')
  @RequiresPermission('activity.time-policy.read', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility'],
  })
  @ApiOperation({
    summary: '分页读取当前组织和计划区间内可新选的时长政策版本 [rbac: activity.time-policy.read]',
  })
  @ApiWrappedPageResponse(AppActivityTimePolicyOptionDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_TIME_POLICY_SELECTION_REFERENCE_UNAVAILABLE,
  )
  options(
    @Query() query: AppActivityTimePolicyOptionsQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.queries.options(
      {
        ...query,
        plannedFrom: new Date(query.plannedFrom),
        plannedUntil: new Date(query.plannedUntil),
      },
      user,
    );
  }

  @Get(':activityId/time-policy-selection')
  @RequiresPermission('activity.time-policy.read', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility'],
  })
  @ApiOperation({
    summary: '分页读取本人 managed 活动的时长政策选择 [rbac: activity.time-policy.read]',
  })
  @ApiWrappedOkResponse(AppActivityTimePolicySelectionResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_TIME_POLICY_SELECTION_REFERENCE_UNAVAILABLE,
  )
  get(
    @Param() params: AppManagedActivityParamsDto,
    @Query() query: AppActivityTimePolicySelectionQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.queries.get(params.activityId, query, user, 'app');
  }

  @Patch(':activityId/time-policy-selection')
  @RequiresPermission('activity.time-policy.select', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility'],
  })
  @ApiOperation({
    summary: '增量设置本人 managed 草稿的时长政策选择 [rbac: activity.time-policy.select]',
  })
  @ApiWrappedOkResponse(AppActivityTimePolicySelectionResultDto)
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
    @Param() params: AppManagedActivityParamsDto,
    @Body() dto: AppPatchActivityTimePolicySelectionDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.patch(params.activityId, dto, user, 'app', {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    });
  }
}
