import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
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
import { PaginationQueryDto, PageResultDto } from '../../../common/dto/pagination.dto';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { ActivityTimeSettlementService } from '../activity-time-settlement.service';
import { ActivityTimeSettlementQueryService } from '../activity-time-settlement-query.service';
import { AppManagedActivityParamsDto } from '../dto/app/app-managed-activity.dto';
import {
  AppTimeSettlementWorkbenchDto,
  AppTimeSettlementSourceDto,
  AppTimeSettlementAllocationDetailDto,
  AppTimeSettlementBucketDto,
  AppTimeSettlementBucketSourceDto,
  AppTimeSettlementAllocationParamsDto,
  AppTimeSettlementRevisionParamsDto,
  AppTimeSettlementSourcesQueryDto,
  AppRecognizeTimeSettlementDto,
  AppPrepareTimeSettlementDto,
  AppSubmitTimeSettlementDto,
  AppTimeSettlementAllocationResultDto,
  AppTimeSettlementResultDto,
} from '../dto/app/app-activity-time-settlement.dto';

const ERRORS = [
  BizCode.BAD_REQUEST,
  BizCode.UNAUTHORIZED,
  BizCode.FORBIDDEN,
  BizCode.ACTIVITY_TIME_SETTLEMENT_INVALID,
  BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE,
  BizCode.ACTIVITY_TIME_SETTLEMENT_STALE,
  BizCode.ACTIVITY_TIME_SETTLEMENT_COMMAND_CONFLICT,
  BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY,
  BizCode.ACTIVITY_TIME_SETTLEMENT_POLICY_MIXED,
  BizCode.ACTIVITY_TIME_SETTLEMENT_OVERLAP,
  BizCode.ACTIVITY_TIME_SETTLEMENT_SCALE_LIMIT,
] as const;
const WRITE_ERRORS = [
  ...ERRORS,
  BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED,
  BizCode.ACTIVITY_WORKFLOW_READONLY_MAINTENANCE,
] as const;
// The classified submission reuses the original submit validator in the same transaction.
// Preserve its error contract rather than disguising an existing rejection as a new error.
const SUBMIT_ERRORS = [
  ...WRITE_ERRORS,
  BizCode.ACTIVITY_NOT_FOUND,
  BizCode.SETTLEMENT_SUBMIT_RUN_STATUS_INVALID,
  BizCode.SETTLEMENT_SUBMIT_EVIDENCE_SEAL_INACTIVE,
  BizCode.SETTLEMENT_SUBMIT_EVIDENCE_SEAL_STALE,
  BizCode.SETTLEMENT_SUBMIT_DRAFT_MISSING,
  BizCode.SETTLEMENT_SUBMIT_OPERATION_KEY_CONFLICT,
  BizCode.SETTLEMENT_SUBMIT_EXPECTED_DRAFT_VERSION_MISMATCH,
  BizCode.SETTLEMENT_SUBMIT_EXPECTED_EVIDENCE_SEAL_MISMATCH,
  BizCode.SETTLEMENT_SUBMIT_ACTIVITY_NOT_ENDED,
  BizCode.SETTLEMENT_SUBMIT_PENDING_RESULT,
  BizCode.SETTLEMENT_SUBMIT_ITEM_COUNT_MISMATCH,
  BizCode.SETTLEMENT_SUBMIT_DUPLICATE_IDENTITY,
  BizCode.SETTLEMENT_SUBMIT_OPEN_SEGMENT,
  BizCode.SETTLEMENT_SUBMIT_MISSING_RULE,
] as const;

@ApiTags('Mobile - Managed Activity Time Settlement')
@ApiBearerAuth()
@ApiExtraModels(
  PageResultDto,
  AppTimeSettlementSourceDto,
  AppTimeSettlementBucketDto,
  AppTimeSettlementBucketSourceDto,
)
@Controller('app/v1/my/managed-activities/:activityId/time-settlement')
export class AppManagedActivityTimeSettlementController {
  constructor(
    private readonly service: ActivityTimeSettlementService,
    private readonly queries: ActivityTimeSettlementQueryService,
  ) {}

  @Get()
  @RequiresPermission('activity.time-settlement.read', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility', 'org-scope'],
  })
  @ApiOperation({
    summary: '读取分类时长结算工作台及阻塞计数 [rbac: activity.time-settlement.read]',
  })
  @ApiWrappedOkResponse(AppTimeSettlementWorkbenchDto)
  @ApiBizErrorResponse(...ERRORS)
  workbench(@Param() params: AppManagedActivityParamsDto, @CurrentUser() user: CurrentUserPayload) {
    return this.queries.workbench(params.activityId, user);
  }

  @Get('sources')
  @RequiresPermission('activity.time-settlement.read', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility', 'org-scope'],
  })
  @ApiOperation({
    summary: '分页读取分类结算当前来源与认定缺口 [rbac: activity.time-settlement.read]',
  })
  @ApiWrappedPageResponse(AppTimeSettlementSourceDto)
  @ApiBizErrorResponse(...ERRORS)
  sources(
    @Param() params: AppManagedActivityParamsDto,
    @Query() query: PaginationQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.queries.currentSources(params.activityId, query, user);
  }

  @Get('allocations/:allocationRevisionId')
  @RequiresPermission('activity.time-settlement.read', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility', 'org-scope'],
  })
  @ApiOperation({ summary: '读取一个冻结认定及政策理由证据 [rbac: activity.time-settlement.read]' })
  @ApiWrappedOkResponse(AppTimeSettlementAllocationDetailDto)
  @ApiBizErrorResponse(...ERRORS)
  allocation(
    @Param() params: AppTimeSettlementAllocationParamsDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.queries.allocationDetail(params.activityId, params.allocationRevisionId, user);
  }

  @Get('revisions/:timeRevisionId/buckets')
  @RequiresPermission('activity.time-settlement.read', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility', 'org-scope'],
  })
  @ApiOperation({ summary: '分页读取指定不可变分类版本的桶 [rbac: activity.time-settlement.read]' })
  @ApiWrappedPageResponse(AppTimeSettlementBucketDto)
  @ApiBizErrorResponse(...ERRORS)
  buckets(
    @Param() params: AppTimeSettlementRevisionParamsDto,
    @Query() query: PaginationQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.queries.buckets(params.activityId, params.timeRevisionId, query, user);
  }

  @Get('revisions/:timeRevisionId/sources')
  @RequiresPermission('activity.time-settlement.read', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility', 'org-scope'],
  })
  @ApiOperation({
    summary: '分页追溯指定分类版本的来源，可筛选 bucketId [rbac: activity.time-settlement.read]',
  })
  @ApiWrappedPageResponse(AppTimeSettlementBucketSourceDto)
  @ApiBizErrorResponse(...ERRORS)
  bucketSources(
    @Param() params: AppTimeSettlementRevisionParamsDto,
    @Query() query: AppTimeSettlementSourcesQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.queries.bucketSources(params.activityId, params.timeRevisionId, query, user);
  }

  @Post('allocations')
  @HttpCode(200)
  @RequiresPermission('activity.time-allocation.recognize', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility', 'org-scope'],
  })
  @ApiOperation({
    summary: '显式认定有当前封印证明的草稿参与段 [rbac: activity.time-allocation.recognize]',
  })
  @ApiWrappedOkResponse(AppTimeSettlementAllocationResultDto)
  @ApiBizErrorResponse(...WRITE_ERRORS)
  allocate(
    @Param() params: AppManagedActivityParamsDto,
    @Body() dto: AppRecognizeTimeSettlementDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.allocate(params.activityId, dto, user, {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    });
  }

  @Post('prepare')
  @HttpCode(200)
  @RequiresPermission('activity.time-settlement.prepare', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility', 'org-scope'],
  })
  @ApiOperation({ summary: '准备完整不可变分类时长草稿 [rbac: activity.time-settlement.prepare]' })
  @ApiWrappedOkResponse(AppTimeSettlementResultDto)
  @ApiBizErrorResponse(...WRITE_ERRORS)
  prepare(
    @Param() params: AppManagedActivityParamsDto,
    @Body() dto: AppPrepareTimeSettlementDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.prepare(params.activityId, dto, user, {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    });
  }

  @Post('submit')
  @HttpCode(200)
  @RequiresPermission('activity.time-settlement.prepare', 'activity.settlement-submit.record', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility', 'org-scope'],
  })
  @ApiOperation({
    summary:
      '分类送审（另需 activity.settlement-submit.record） [rbac: activity.time-settlement.prepare]',
  })
  @ApiWrappedOkResponse(AppTimeSettlementResultDto)
  @ApiBizErrorResponse(...SUBMIT_ERRORS)
  submit(
    @Param() params: AppManagedActivityParamsDto,
    @Body() dto: AppSubmitTimeSettlementDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.submit(params.activityId, dto, user, {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    });
  }
}
