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
import { ActivityContributionPolicySelectionQueryService } from '../activity-contribution-policy-selection-query.service';
import { ActivityContributionPolicySelectionService } from '../activity-contribution-policy-selection.service';
import {
  AppActivityContributionPolicyOptionDto,
  AppActivityContributionPolicyOptionsQueryDto,
  AppActivityContributionPolicySelectionQueryDto,
  AppActivityContributionPolicySelectionResponseDto,
  AppActivityContributionPolicySelectionResultDto,
  AppPatchActivityContributionPolicySelectionDto,
} from '../dto/app/app-activity-contribution-policy-selection.dto';
import { AppManagedActivityParamsDto } from '../dto/app/app-managed-activity.dto';

@ApiTags('Mobile - Managed Activity Contribution Policy Selection')
@ApiBearerAuth()
@ApiExtraModels(AppActivityContributionPolicyOptionDto, PageResultDto)
@Controller('app/v1/my/managed-activities')
export class AppManagedActivityContributionPolicySelectionController {
  constructor(
    private readonly service: ActivityContributionPolicySelectionService,
    private readonly queries: ActivityContributionPolicySelectionQueryService,
  ) {}

  @Get('contribution-policy-options')
  @RequiresPermission('activity.contribution-policy.read', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility'],
  })
  @ApiOperation({
    summary:
      '分页读取当前组织与计划区间可新选的贡献政策版本 [rbac: activity.contribution-policy.read]',
  })
  @ApiWrappedPageResponse(AppActivityContributionPolicyOptionDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REFERENCE_UNAVAILABLE,
  )
  options(
    @Query() query: AppActivityContributionPolicyOptionsQueryDto,
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

  @Get(':activityId/contribution-policy-selection')
  @RequiresPermission('activity.contribution-policy.read', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility'],
  })
  @ApiOperation({
    summary: '分页读取本人负责活动的贡献政策选择 [rbac: activity.contribution-policy.read]',
  })
  @ApiWrappedOkResponse(AppActivityContributionPolicySelectionResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REFERENCE_UNAVAILABLE,
  )
  get(
    @Param() params: AppManagedActivityParamsDto,
    @Query() query: AppActivityContributionPolicySelectionQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.queries.get(params.activityId, query, user, 'app');
  }

  @Patch(':activityId/contribution-policy-selection')
  @RequiresPermission('activity.contribution-policy.select', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility'],
  })
  @ApiOperation({
    summary: '增量设置本人负责草稿活动的贡献政策选择 [rbac: activity.contribution-policy.select]',
  })
  @ApiWrappedOkResponse(AppActivityContributionPolicySelectionResultDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_INVALID,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REFERENCE_UNAVAILABLE,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_STALE,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_COMMAND_CONFLICT,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_RECEIPT_INVALID,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_POLICY_UNAVAILABLE,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_UNCHANGED,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REVISION_LIMIT,
  )
  patch(
    @Param() params: AppManagedActivityParamsDto,
    @Body() dto: AppPatchActivityContributionPolicySelectionDto,
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
