import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedCreatedResponse,
  ApiWrappedOkResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { RequiresPermission } from '../../../common/decorators/route-authz.decorator';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { ActivityMetricCandidateService } from '../activity-metric-candidate.service';
import { ActivityMetricCandidateQueryService } from '../activity-metric-candidate-query.service';
import {
  AppActivityMetricCandidateDetailDto,
  AppActivityMetricCandidateDetailParamsDto,
  AppActivityMetricCandidateParamsDto,
  AppActivityMetricCandidateResultDto,
  AppCalculateActivityMetricCandidateDto,
} from '../dto/app/app-activity-metric-candidate.dto';

@ApiTags('Mobile - Managed Activity Metric Candidates')
@ApiBearerAuth()
@Controller('app/v1/my/managed-activities')
export class AppManagedActivityMetricCandidatesController {
  constructor(
    private readonly service: ActivityMetricCandidateService,
    private readonly queries: ActivityMetricCandidateQueryService,
  ) {}

  @Post(':activityId/metric-candidates')
  @RequiresPermission('activity.outcome.calculate', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility'],
  })
  @ApiOperation({ summary: '计算并保留指标候选；不确认成果 [rbac: activity.outcome.calculate]' })
  @ApiWrappedCreatedResponse(AppActivityMetricCandidateResultDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE,
    BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE,
    BizCode.ACTIVITY_METRIC_CANDIDATE_INVALID,
    BizCode.ACTIVITY_METRIC_CANDIDATE_STALE,
    BizCode.ACTIVITY_METRIC_CANDIDATE_COMMAND_CONFLICT,
    BizCode.ACTIVITY_METRIC_CANDIDATE_REFERENCE_UNAVAILABLE,
    BizCode.ACTIVITY_METRIC_CANDIDATE_RECEIPT_INVALID,
    BizCode.ACTIVITY_METRIC_SOURCE_INCOMPLETE,
    BizCode.ACTIVITY_METRIC_SOURCE_UNAVAILABLE,
    BizCode.ACTIVITY_METRIC_SOURCE_LIMIT_EXCEEDED,
  )
  calculate(
    @Param() params: AppActivityMetricCandidateParamsDto,
    @Body() dto: AppCalculateActivityMetricCandidateDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.calculate(params.activityId, dto, user, {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    });
  }

  @Get(':activityId/metric-candidates/:candidateId')
  @RequiresPermission('activity.outcome.read', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility'],
  })
  @ApiOperation({
    summary: '读取候选及当前有效性，不返回原始参与明细 [rbac: activity.outcome.read]',
  })
  @ApiWrappedOkResponse(AppActivityMetricCandidateDetailDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE,
    BizCode.ACTIVITY_METRIC_CANDIDATE_REFERENCE_UNAVAILABLE,
  )
  get(
    @Param() params: AppActivityMetricCandidateDetailParamsDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.queries.get(params.activityId, params.candidateId, user);
  }
}
