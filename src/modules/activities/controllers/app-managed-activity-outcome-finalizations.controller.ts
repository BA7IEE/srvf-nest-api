import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { RequiresPermission } from '../../../common/decorators/route-authz.decorator';
import {
  ApiWrappedCreatedResponse,
  ApiWrappedNullableResponse,
  ApiWrappedOkResponse,
} from '../../../common/decorators/api-response.decorator';
import { ActivityOutcomeFinalizationService } from '../activity-outcome-finalization.service';
import { ActivityOutcomeConfirmedQueryService } from '../activity-outcome-confirmed-query.service';
import {
  AppActivityOutcomeParamsDto,
  AppActivityOutcomeDetailParamsDto,
} from '../dto/app/app-activity-outcome.dto';
import {
  AppConfirmActivityOutcomeDto,
  AppPrepareActivityOutcomeCorrectionDto,
  AppOutcomeFinalizationAnchorsDto,
  AppActivityOutcomeFinalizationResultDto,
  AppActivityOutcomeConfirmedDto,
} from '../dto/app/app-activity-outcome-finalization.dto';

@ApiTags('Mobile - Managed Activity Outcome Finalizations')
@ApiBearerAuth()
@Controller('app/v1/my/managed-activities')
export class AppManagedActivityOutcomeFinalizationsController {
  constructor(
    private readonly service: ActivityOutcomeFinalizationService,
    private readonly queries: ActivityOutcomeConfirmedQueryService,
  ) {}

  @Post(':activityId/outcome-confirmations')
  @RequiresPermission('activity.outcome.confirm', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility'],
  })
  @ApiOperation({ summary: '确认完整成果快照 [rbac: activity.outcome.confirm]' })
  @ApiWrappedCreatedResponse(AppActivityOutcomeFinalizationResultDto)
  confirm(
    @Param() params: AppActivityOutcomeParamsDto,
    @Body() dto: AppConfirmActivityOutcomeDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.confirm(params.activityId, dto, user, {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    });
  }

  @Post(':activityId/outcome-corrections')
  @RequiresPermission('activity.outcome.correct', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility'],
  })
  @ApiOperation({ summary: '准备完整更正草稿，保留当前正式成果 [rbac: activity.outcome.correct]' })
  @ApiWrappedCreatedResponse(AppActivityOutcomeFinalizationResultDto)
  prepare(
    @Param() params: AppActivityOutcomeParamsDto,
    @Body() dto: AppPrepareActivityOutcomeCorrectionDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.prepareCorrection(params.activityId, dto, user, {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    });
  }

  @Post(':activityId/outcome-corrections/:outcomeRevisionId/cancel')
  @HttpCode(HttpStatus.OK)
  @RequiresPermission('activity.outcome.correct', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility'],
  })
  @ApiOperation({ summary: '取消待确认更正，不删除历史数据 [rbac: activity.outcome.correct]' })
  @ApiWrappedOkResponse(AppActivityOutcomeFinalizationResultDto)
  cancel(
    @Param() params: AppActivityOutcomeDetailParamsDto,
    @Body() dto: AppOutcomeFinalizationAnchorsDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.cancelCorrection(params.activityId, params.outcomeRevisionId, dto, user, {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    });
  }

  @Get(':activityId/outcome-confirmed')
  @RequiresPermission('activity.outcome.read', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility'],
  })
  @ApiOperation({
    summary: '读取当前唯一正式成果，无正式成果返回 null [rbac: activity.outcome.read]',
  })
  @ApiWrappedNullableResponse(AppActivityOutcomeConfirmedDto)
  get(@Param() params: AppActivityOutcomeParamsDto, @CurrentUser() user: CurrentUserPayload) {
    return this.queries.get(params.activityId, user);
  }
}
