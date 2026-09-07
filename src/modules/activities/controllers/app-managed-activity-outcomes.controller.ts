import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { RequiresPermission } from '../../../common/decorators/route-authz.decorator';
import {
  ApiBizErrorResponse,
  ApiWrappedCreatedResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../../common/decorators/api-response.decorator';
import { PageResultDto, PaginationQueryDto } from '../../../common/dto/pagination.dto';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { ActivityOutcomeService } from '../activity-outcome.service';
import { ActivityOutcomeQueryService } from '../activity-outcome-query.service';
import {
  AppActivityOutcomeDetailDto,
  AppActivityOutcomeDetailParamsDto,
  AppActivityOutcomeParamsDto,
  AppActivityOutcomeResultDto,
  AppActivityOutcomeSummaryDto,
  AppRecordActivityOutcomeDto,
} from '../dto/app/app-activity-outcome.dto';

@ApiTags('Mobile - Managed Activity Outcomes')
@ApiBearerAuth()
@ApiExtraModels(AppActivityOutcomeSummaryDto, PageResultDto)
@Controller('app/v1/my/managed-activities')
export class AppManagedActivityOutcomesController {
  constructor(
    private readonly service: ActivityOutcomeService,
    private readonly queries: ActivityOutcomeQueryService,
  ) {}

  @Post(':activityId/outcomes')
  @RequiresPermission('activity.outcome.record', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility'],
  })
  @ApiOperation({
    summary: '追加完整人工成果草稿，重试返回原创建事实 [rbac: activity.outcome.record]',
  })
  @ApiWrappedCreatedResponse(AppActivityOutcomeResultDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_OUTCOME_INVALID,
    BizCode.ACTIVITY_OUTCOME_STALE,
    BizCode.ACTIVITY_OUTCOME_COMMAND_CONFLICT,
    BizCode.ACTIVITY_OUTCOME_RECEIPT_INVALID,
    BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE,
    BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING,
  )
  record(
    @Param() params: AppActivityOutcomeParamsDto,
    @Body() dto: AppRecordActivityOutcomeDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.record(params.activityId, dto, user, {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    });
  }

  @Get(':activityId/outcomes')
  @RequiresPermission('activity.outcome.read', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility'],
  })
  @ApiOperation({ summary: '分页读取有权活动的成果历史摘要 [rbac: activity.outcome.read]' })
  @ApiWrappedPageResponse(AppActivityOutcomeSummaryDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE,
  )
  list(
    @Param() params: AppActivityOutcomeParamsDto,
    @Query() query: PaginationQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.queries.list(params.activityId, query, user);
  }

  @Get(':activityId/outcomes/:outcomeRevisionId')
  @RequiresPermission('activity.outcome.read', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility'],
  })
  @ApiOperation({ summary: '按历史精确指标集读取同链成果明细 [rbac: activity.outcome.read]' })
  @ApiWrappedOkResponse(AppActivityOutcomeDetailDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE,
  )
  get(@Param() params: AppActivityOutcomeDetailParamsDto, @CurrentUser() user: CurrentUserPayload) {
    return this.queries.get(params.activityId, params.outcomeRevisionId, user);
  }
}
