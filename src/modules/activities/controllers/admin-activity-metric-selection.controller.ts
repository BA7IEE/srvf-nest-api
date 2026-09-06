import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
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
} from '../../../common/decorators/api-response.decorator';
import { IdParamDto } from '../../../common/dto/id-param.dto';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { ActivityMetricSelectionService } from '../activity-metric-selection.service';
import { ActivityMetricSelectionQueryService } from '../activity-metric-selection-query.service';
import {
  AdminActivityMetricSelectionResponseDto,
  AdminActivityMetricSelectionResultDto,
  AdminSelectActivityMetricSetDto,
} from '../dto/admin/activity-metric-selection.dto';

@ApiTags('Admin - Activity Metric Selection')
@ApiBearerAuth()
@Controller('admin/v1/activities')
export class AdminActivityMetricSelectionController {
  constructor(
    private readonly service: ActivityMetricSelectionService,
    private readonly queries: ActivityMetricSelectionQueryService,
  ) {}
  @Get(':id/metric-selection')
  @LoginScoped('activity-visibility', { require: 'all', engine: 'authz-scoped' })
  @ApiOperation({ summary: '查询活动当前指标选择与历史指针 [auth]' })
  @ApiWrappedOkResponse(AdminActivityMetricSelectionResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE,
  )
  get(@Param() params: IdParamDto, @CurrentUser() user: CurrentUserPayload) {
    return this.queries.get(params.id, user, 'admin');
  }
  @Put(':id/metric-selection')
  @RequiresPermission('activity.update.record', {
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility'],
  })
  @ApiOperation({ summary: '完整设置草稿活动指标选择 [rbac: activity.update.record]' })
  @ApiWrappedOkResponse(AdminActivityMetricSelectionResultDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
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
    @Param() params: IdParamDto,
    @Body() dto: AdminSelectActivityMetricSetDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.select(params.id, dto, user, 'admin', {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    });
  }
}
