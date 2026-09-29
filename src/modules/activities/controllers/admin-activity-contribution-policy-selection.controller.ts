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
import { ActivityContributionPolicySelectionQueryService } from '../activity-contribution-policy-selection-query.service';
import { ActivityContributionPolicySelectionService } from '../activity-contribution-policy-selection.service';
import {
  AdminActivityContributionPolicySelectionQueryDto,
  AdminActivityContributionPolicySelectionResponseDto,
  AdminActivityContributionPolicySelectionResultDto,
  AdminPatchActivityContributionPolicySelectionDto,
} from '../dto/admin/activity-contribution-policy-selection.dto';

@ApiTags('Admin - Activity Contribution Policy Selection')
@ApiBearerAuth()
@Controller('admin/v1/activities')
export class AdminActivityContributionPolicySelectionController {
  constructor(
    private readonly service: ActivityContributionPolicySelectionService,
    private readonly queries: ActivityContributionPolicySelectionQueryService,
  ) {}

  @Get(':id/contribution-policy-selection')
  @RequiresPermission('activity.contribution-policy.read', {
    require: 'all',
    engine: 'authz-scoped',
  })
  @ApiOperation({
    summary: '分页读取活动贡献政策选择、解析来源与问题 [rbac: activity.contribution-policy.read]',
  })
  @ApiWrappedOkResponse(AdminActivityContributionPolicySelectionResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REFERENCE_UNAVAILABLE,
  )
  get(
    @Param() params: IdParamDto,
    @Query() query: AdminActivityContributionPolicySelectionQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.queries.get(params.id, query, user, 'admin');
  }

  @Patch(':id/contribution-policy-selection')
  @RequiresPermission('activity.contribution-policy.select', {
    require: 'all',
    engine: 'authz-scoped',
  })
  @ApiOperation({
    summary: '增量设置草稿活动的贡献政策选择 [rbac: activity.contribution-policy.select]',
  })
  @ApiWrappedOkResponse(AdminActivityContributionPolicySelectionResultDto)
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
    @Param() params: IdParamDto,
    @Body() dto: AdminPatchActivityContributionPolicySelectionDto,
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
