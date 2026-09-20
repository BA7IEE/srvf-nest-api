import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedCreatedResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { RequiresPermission } from '../../../common/decorators/route-authz.decorator';
import { PageResultDto } from '../../../common/dto/pagination.dto';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { ActivityTimeCorrectionCommandService } from '../activity-time-correction-command.service';
import { ActivityTimeCorrectionQueryService } from '../activity-time-correction-query.service';
import {
  AppActivityTimeCorrectionCommitResultDto,
  AppActivityTimeCorrectionDetailDto,
  AppActivityTimeCorrectionDetailQueryDto,
  AppActivityTimeCorrectionListItemDto,
  AppActivityTimeCorrectionListQueryDto,
  AppActivityTimeCorrectionParamsDto,
  AppActivityTimeCorrectionPrepareResultDto,
  AppActivityTimeCorrectionResubmitResultDto,
  AppActivityTimeCorrectionReviewResultDto,
  AppActivityTimeCorrectionSubmitResultDto,
  AppCommitActivityTimeCorrectionDto,
  AppPrepareActivityTimeCorrectionDto,
  AppReviewActivityTimeCorrectionDto,
  AppSubmitActivityTimeCorrectionDto,
} from '../dto/app/app-activity-time-correction.dto';
import { AppManagedActivityParamsDto } from '../dto/app/app-managed-activity.dto';

const READ_ERRORS = [
  BizCode.BAD_REQUEST,
  BizCode.UNAUTHORIZED,
  BizCode.FORBIDDEN,
  BizCode.RBAC_FORBIDDEN,
  BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE,
  BizCode.CORRECTION_CHANGE_SET_INVALID,
] as const;
const WRITE_ERRORS = [
  ...READ_ERRORS,
  BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED,
  BizCode.ACTIVITY_WORKFLOW_READONLY_MAINTENANCE,
  BizCode.CORRECTION_SUBMIT_RUN_STATUS_INVALID,
  BizCode.CORRECTION_SUBMIT_BASE_VERSION_INVALID,
  BizCode.CORRECTION_TARGET_ALREADY_OPEN,
  BizCode.CORRECTION_OPERATION_KEY_CONFLICT,
  BizCode.CORRECTION_REVIEW_STATUS_INVALID,
  BizCode.CORRECTION_REVIEW_SELF_FORBIDDEN,
  BizCode.CORRECTION_BASE_VERSION_CHANGED,
  BizCode.CORRECTION_APPLY_STATUS_INVALID,
  BizCode.ACTIVITY_TIME_LEDGER_SOURCE_INVALID,
] as const;

@ApiTags('Mobile - Managed Activity Fact Corrections')
@ApiBearerAuth()
@ApiExtraModels(PageResultDto, AppActivityTimeCorrectionListItemDto)
@Controller('app/v1/my/managed-activities/:activityId/time-corrections')
export class AppManagedActivityTimeCorrectionController {
  constructor(
    private readonly commands: ActivityTimeCorrectionCommandService,
    private readonly queries: ActivityTimeCorrectionQueryService,
  ) {}

  @Post()
  @RequiresPermission('activity.time-settlement.prepare', 'activity.settlement-submit.record', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility', 'org-scope'],
  })
  @ApiOperation({
    summary:
      '提交冻结事实更正；v3 另在服务层要求 activity.time-allocation.recognize [rbac: activity.time-settlement.prepare]',
  })
  @ApiWrappedCreatedResponse(AppActivityTimeCorrectionSubmitResultDto)
  @ApiBizErrorResponse(...WRITE_ERRORS)
  submit(
    @Param() params: AppManagedActivityParamsDto,
    @Body() dto: AppSubmitActivityTimeCorrectionDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.commands.submit(params.activityId, dto, user, this.auditMeta(req));
  }

  @Get()
  @RequiresPermission('activity.time-settlement.read', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility', 'org-scope'],
  })
  @ApiOperation({ summary: '分页读取事实更正申请摘要 [rbac: activity.time-settlement.read]' })
  @ApiWrappedPageResponse(AppActivityTimeCorrectionListItemDto)
  @ApiBizErrorResponse(...READ_ERRORS)
  list(
    @Param() params: AppManagedActivityParamsDto,
    @Query() query: AppActivityTimeCorrectionListQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.queries.list(params.activityId, query, user);
  }

  @Get(':requestId')
  @RequiresPermission('activity.time-settlement.read', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility', 'org-scope'],
  })
  @ApiOperation({
    summary: '读取一条事实更正及可见范围内的冻结差异 [rbac: activity.time-settlement.read]',
  })
  @ApiWrappedOkResponse(AppActivityTimeCorrectionDetailDto)
  @ApiBizErrorResponse(...READ_ERRORS)
  detail(
    @Param() params: AppActivityTimeCorrectionParamsDto,
    @Query() query: AppActivityTimeCorrectionDetailQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.queries.detail(params.activityId, params.requestId, query, user);
  }

  @Post(':requestId/review')
  @HttpCode(200)
  @RequiresPermission('activity.settlement-final-review.record', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['org-scope'],
  })
  @ApiOperation({
    summary: '审核事实更正；提交人不得自审 [rbac: activity.settlement-final-review.record]',
  })
  @ApiWrappedOkResponse(AppActivityTimeCorrectionReviewResultDto)
  @ApiBizErrorResponse(...WRITE_ERRORS)
  review(
    @Param() params: AppActivityTimeCorrectionParamsDto,
    @Body() dto: AppReviewActivityTimeCorrectionDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.commands.review(
      params.activityId,
      params.requestId,
      dto,
      user,
      this.auditMeta(req),
    );
  }

  @Post(':requestId/resubmit')
  @RequiresPermission('activity.time-settlement.prepare', 'activity.settlement-submit.record', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility', 'org-scope'],
  })
  @ApiOperation({
    summary:
      '将 returned 申请前向作废并创建新申请；另需 activity.settlement-submit.record；v3 另在服务层要求 activity.time-allocation.recognize [rbac: activity.time-settlement.prepare]',
  })
  @ApiWrappedCreatedResponse(AppActivityTimeCorrectionResubmitResultDto)
  @ApiBizErrorResponse(...WRITE_ERRORS)
  resubmit(
    @Param() params: AppActivityTimeCorrectionParamsDto,
    @Body() dto: AppSubmitActivityTimeCorrectionDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.commands.resubmit(
      params.activityId,
      params.requestId,
      dto,
      user,
      this.auditMeta(req),
    );
  }

  @Post(':requestId/prepare')
  @HttpCode(200)
  @RequiresPermission('activity.settlement-final-review.record', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['org-scope'],
  })
  @ApiOperation({
    summary: '准备已批准事实更正，保留准备人绑定 [rbac: activity.settlement-final-review.record]',
  })
  @ApiWrappedOkResponse(AppActivityTimeCorrectionPrepareResultDto)
  @ApiBizErrorResponse(...WRITE_ERRORS)
  prepare(
    @Param() params: AppActivityTimeCorrectionParamsDto,
    @Body() dto: AppPrepareActivityTimeCorrectionDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.commands.prepare(
      params.activityId,
      params.requestId,
      dto,
      user,
      this.auditMeta(req),
    );
  }

  @Post(':requestId/commit')
  @HttpCode(200)
  @RequiresPermission('activity.settlement-final-review.record', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['org-scope'],
  })
  @ApiOperation({
    summary:
      '提交精确 prepared application；仅原准备人可重放 [rbac: activity.settlement-final-review.record]',
  })
  @ApiWrappedOkResponse(AppActivityTimeCorrectionCommitResultDto)
  @ApiBizErrorResponse(...WRITE_ERRORS)
  commit(
    @Param() params: AppActivityTimeCorrectionParamsDto,
    @Body() dto: AppCommitActivityTimeCorrectionDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.commands.commit(
      params.activityId,
      params.requestId,
      dto,
      user,
      this.auditMeta(req),
    );
  }

  private auditMeta(req: Request) {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }
}
