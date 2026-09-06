import { Body, Controller, Get, Param, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { LoginScoped, RequiresPermission } from '../../../common/decorators/route-authz.decorator';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../../common/decorators/api-response.decorator';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { ActivityMetricSelectionService } from '../activity-metric-selection.service';
import { ActivityMetricSelectionQueryService } from '../activity-metric-selection-query.service';
import { AppManagedActivityParamsDto } from '../dto/app/app-managed-activity.dto';
import {
  AppActivityMetricSelectionResponseDto,
  AppActivityMetricSelectionResultDto,
  AppSelectActivityMetricSetDto,
} from '../dto/app/app-activity-metric-selection.dto';
import {
  AppActivityMetricOptionsQueryDto,
  AppActivityMetricSetOptionDto,
  AppActivityTemplateVersionOptionDto,
} from '../dto/app/app-activity-metric-options.dto';

@ApiTags('Mobile - Managed Activity Metrics')
@ApiBearerAuth()
@Controller('app/v1/my/managed-activities')
export class AppManagedActivityMetricsController {
  constructor(
    private readonly service: ActivityMetricSelectionService,
    private readonly queries: ActivityMetricSelectionQueryService,
  ) {}
  @Get('metric-set-options')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['responsibility'],
    engine: 'authz-scoped',
  })
  @ApiOperation({ summary: '分页查询可新选指标集；候选超过 1000 条明确报错 [auth]' })
  @ApiWrappedPageResponse(AppActivityMetricSetOptionDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_INITIATOR_NOT_FORMAL,
    BizCode.ORGANIZATION_NOT_FOUND,
    BizCode.ORGANIZATION_INACTIVE,
    BizCode.ACTIVITY_ORGANIZATION_ROOT_FORBIDDEN,
    BizCode.ACTIVITY_INITIATION_ORG_FORBIDDEN,
    BizCode.ACTIVITY_OPTIONS_CANDIDATE_LIMIT_EXCEEDED,
  )
  metricSetOptions(
    @Query() query: AppActivityMetricOptionsQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.queries.metricSetOptions(query, user);
  }

  @Get('template-version-options')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['responsibility'],
    engine: 'authz-scoped',
  })
  @ApiOperation({ summary: '分页查询可新选全局模板版本；候选超过 1000 条明确报错 [auth]' })
  @ApiWrappedPageResponse(AppActivityTemplateVersionOptionDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_INITIATOR_NOT_FORMAL,
    BizCode.ORGANIZATION_NOT_FOUND,
    BizCode.ORGANIZATION_INACTIVE,
    BizCode.ACTIVITY_ORGANIZATION_ROOT_FORBIDDEN,
    BizCode.ACTIVITY_INITIATION_ORG_FORBIDDEN,
    BizCode.ACTIVITY_OPTIONS_CANDIDATE_LIMIT_EXCEEDED,
  )
  templateVersionOptions(
    @Query() query: AppActivityMetricOptionsQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.queries.templateVersionOptions(query, user);
  }

  @Get(':activityId/metric-selection')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['responsibility'],
    engine: 'authz-scoped',
  })
  @ApiOperation({ summary: '查询本人 managed 活动指标选择 [auth]' })
  @ApiWrappedOkResponse(AppActivityMetricSelectionResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE,
  )
  get(@Param() params: AppManagedActivityParamsDto, @CurrentUser() user: CurrentUserPayload) {
    return this.queries.get(params.activityId, user, 'app');
  }
  @Put(':activityId/metric-selection')
  @RequiresPermission('activity.update.record', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility'],
  })
  @ApiOperation({ summary: '完整设置本人 managed 草稿的指标选择 [rbac: activity.update.record]' })
  @ApiWrappedOkResponse(AppActivityMetricSelectionResultDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ACTIVITY_CHANGE_REVIEW_REQUIRED,
    BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING,
    BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE,
    BizCode.ACTIVITY_METRIC_SELECTION_INVALID,
    BizCode.ACTIVITY_METRIC_SELECTION_STALE,
    BizCode.ACTIVITY_METRIC_SELECTION_COMMAND_CONFLICT,
    BizCode.ACTIVITY_METRIC_SELECTION_RECEIPT_INVALID,
  )
  select(
    @Param() params: AppManagedActivityParamsDto,
    @Body() dto: AppSelectActivityMetricSetDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.select(params.activityId, dto, user, 'app', {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    });
  }
}
