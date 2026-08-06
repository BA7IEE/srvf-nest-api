import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedArrayResponse,
  ApiWrappedCreatedResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { BizException } from '../../../common/exceptions/biz.exception';
import type { AuditMeta } from '../../audit-logs/audit-logs.types';
import { AppIdentityResolver } from '../../users/app-identity.resolver';
import { AppManagedActivitiesService } from '../app-managed-activities.service';
import { ActivitySettlementHttpService } from '../activity-settlement-http.service';
import type { CreateActivityDto, UpdateActivityDto } from '../activities.dto';
import { ActivityPublishReviewResponseDto } from '../activity-publish-review.dto';
import {
  AppActivityInitiationOrganizationOptionDto,
  AppManagedActivitiesQueryDto,
  AppManagedActivityDetailDto,
  AppManagedActivityListItemDto,
  AppManagedActivityParamsDto,
  AppManagedActivityProjectionDto,
  AppSubmitActivityChangeReviewDto,
  CreateAppManagedActivityDto,
  UpdateAppManagedActivityDto,
} from '../dto/app/app-managed-activity.dto';
import {
  AppManagedActivitySessionDto,
  AppManagedActivitySessionPositionDto,
  AppManagedActivitySessionPositionParamsDto,
  AppManagedActivitySessionPositionsQueryDto,
  AppManagedActivitySessionParamsDto,
  AppManagedActivitySessionsQueryDto,
  CreateAppManagedActivitySessionDto,
  CreateAppManagedActivitySessionPositionDto,
  UpdateAppManagedActivitySessionDto,
  UpdateAppManagedActivitySessionPositionDto,
} from '../dto/app/app-managed-activity-draft.dto';
import {
  AppSettlementCloseCommandDto,
  AppSettlementCloseResponseDto,
  AppSettlementGenerateCommandDto,
  AppSettlementGenerateResponseDto,
  AppSettlementResubmitCommandDto,
  AppSettlementSubmitCommandDto,
  AppSettlementSubmitResponseDto,
} from '../dto/app/app-settlement-command.dto';
import {
  AppSettlementItemDto,
  AppSettlementItemParamsDto,
  AppSettlementItemsQueryDto,
  AppSettlementUpdatedDraftItemResponseDto,
  AppSettlementVersionDetailResponseDto,
  AppSettlementVersionParamsDto,
  AppSettlementWorkbenchResponseDto,
  AppSettlementUpdateDraftItemDto,
} from '../dto/app/app-settlement-workbench.dto';

@ApiTags('Mobile - Managed Activities')
@ApiBearerAuth()
@Controller('app/v1/my/managed-activities')
export class AppManagedActivitiesController {
  constructor(
    private readonly identity: AppIdentityResolver,
    private readonly service: AppManagedActivitiesService,
    private readonly settlements: ActivitySettlementHttpService,
  ) {}

  @Get('organization-options')
  @ApiOperation({ summary: 'App 获取当前队员可发起活动的组织 options [auth]' })
  @ApiWrappedArrayResponse(AppActivityInitiationOrganizationOptionDto)
  @ApiBizErrorResponse(
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_INITIATOR_NOT_FORMAL,
  )
  async organizationOptions(
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<AppActivityInitiationOrganizationOptionDto[]> {
    const memberId = await this.resolveMemberId(user);
    return this.service.organizationOptions(user, memberId);
  }

  @Get()
  @ApiOperation({ summary: 'App 我发起或承担责任的活动分页 [auth]' })
  @ApiWrappedPageResponse(AppManagedActivityListItemDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  async list(
    @CurrentUser() user: CurrentUserPayload,
    @Query() query: AppManagedActivitiesQueryDto,
  ) {
    return this.service.list(await this.resolveMemberId(user), query);
  }

  @Post()
  @ApiOperation({ summary: 'App 正式队员创建本人作为发起人的活动草稿 [auth]' })
  @ApiWrappedCreatedResponse(AppManagedActivityDetailDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ORGANIZATION_NOT_FOUND,
    BizCode.ORGANIZATION_INACTIVE,
    BizCode.ACTIVITY_ORGANIZATION_ROOT_FORBIDDEN,
    BizCode.ACTIVITY_INITIATOR_NOT_FORMAL,
    BizCode.ACTIVITY_INITIATION_ORG_FORBIDDEN,
  )
  async create(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: CreateAppManagedActivityDto,
    @Req() req: Request,
  ): Promise<AppManagedActivityDetailDto> {
    await this.resolveMemberId(user);
    return this.service.create(this.toCreateDto(dto), user, this.auditMeta(req));
  }

  @Get(':activityId/sessions')
  @ApiOperation({ summary: 'App 分页查看本人草稿活动的场次 [auth]' })
  @ApiWrappedPageResponse(AppManagedActivitySessionDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  async listSessions(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityParamsDto,
    @Query() query: AppManagedActivitySessionsQueryDto,
  ) {
    await this.resolveMemberId(user);
    return this.service.listSessions(params.activityId, query, user);
  }

  @Post(':activityId/sessions')
  @ApiOperation({ summary: 'App 为本人 draft 活动新增场次 [auth]' })
  @ApiWrappedCreatedResponse(AppManagedActivitySessionDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_CHANGE_REVIEW_REQUIRED,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ACTIVITY_SESSION_CODE_ALREADY_EXISTS,
    BizCode.ACTIVITY_SESSION_NAME_ALREADY_EXISTS,
    BizCode.ACTIVITY_SESSION_CAPACITY_INVALID,
    BizCode.ACTIVITY_SESSION_TIME_RANGE_INVALID,
    BizCode.ACTIVITY_SESSION_WINDOW_INVALID,
    BizCode.ACTIVITY_SESSION_LOCATION_POLICY_INVALID,
  )
  async createSession(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityParamsDto,
    @Body() dto: CreateAppManagedActivitySessionDto,
    @Req() req: Request,
  ): Promise<AppManagedActivitySessionDto> {
    await this.resolveMemberId(user);
    return this.service.createSession(params.activityId, dto, user, this.auditMeta(req));
  }

  @Patch(':activityId/sessions/:sessionId')
  @ApiOperation({ summary: 'App 修改本人 draft 活动场次 [auth]' })
  @ApiWrappedOkResponse(AppManagedActivitySessionDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_CHANGE_REVIEW_REQUIRED,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ACTIVITY_SESSION_NAME_ALREADY_EXISTS,
    BizCode.ACTIVITY_SESSION_CAPACITY_INVALID,
    BizCode.ACTIVITY_SESSION_TIME_RANGE_INVALID,
    BizCode.ACTIVITY_SESSION_WINDOW_INVALID,
    BizCode.ACTIVITY_SESSION_LOCATION_POLICY_INVALID,
  )
  async updateSession(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivitySessionParamsDto,
    @Body() dto: UpdateAppManagedActivitySessionDto,
    @Req() req: Request,
  ): Promise<AppManagedActivitySessionDto> {
    await this.resolveMemberId(user);
    return this.service.updateSession(
      params.activityId,
      params.sessionId,
      dto,
      user,
      this.auditMeta(req),
    );
  }

  @Delete(':activityId/sessions/:sessionId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'App 软删本人 draft 活动场次 [auth]' })
  @ApiWrappedOkResponse(AppManagedActivitySessionDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_CHANGE_REVIEW_REQUIRED,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ACTIVITY_PARTICIPATION_EXISTS_DELETE_FORBIDDEN,
  )
  async deleteSession(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivitySessionParamsDto,
    @Req() req: Request,
  ): Promise<AppManagedActivitySessionDto> {
    await this.resolveMemberId(user);
    return this.service.deleteSession(
      params.activityId,
      params.sessionId,
      user,
      this.auditMeta(req),
    );
  }

  @Get(':activityId/sessions/:sessionId/positions')
  @ApiOperation({ summary: 'App 分页查看本人草稿场次岗位 [auth]' })
  @ApiWrappedPageResponse(AppManagedActivitySessionPositionDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  async listSessionPositions(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivitySessionParamsDto,
    @Query() query: AppManagedActivitySessionPositionsQueryDto,
  ) {
    await this.resolveMemberId(user);
    return this.service.listSessionPositions(params.activityId, params.sessionId, query, user);
  }

  @Post(':activityId/sessions/:sessionId/positions')
  @ApiOperation({ summary: 'App 为本人 draft 场次新增岗位 [auth]' })
  @ApiWrappedCreatedResponse(AppManagedActivitySessionPositionDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_CHANGE_REVIEW_REQUIRED,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ATTENDANCE_ROLE_CODE_INVALID,
    BizCode.ACTIVITY_GENDER_REQUIREMENT_CODE_INVALID,
    BizCode.ACTIVITY_RESPONSIBILITY_TARGET_INVALID,
    BizCode.ACTIVITY_SESSION_POSITION_CODE_ALREADY_EXISTS,
    BizCode.ACTIVITY_SESSION_POSITION_NAME_ALREADY_EXISTS,
    BizCode.ACTIVITY_SESSION_POSITION_CAPACITY_INVALID,
    BizCode.ACTIVITY_SESSION_POSITION_TIME_RANGE_INVALID,
    BizCode.ACTIVITY_SESSION_POSITION_LOCATION_POLICY_INVALID,
  )
  async createSessionPosition(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivitySessionParamsDto,
    @Body() dto: CreateAppManagedActivitySessionPositionDto,
    @Req() req: Request,
  ): Promise<AppManagedActivitySessionPositionDto> {
    await this.resolveMemberId(user);
    return this.service.createSessionPosition(
      params.activityId,
      params.sessionId,
      dto,
      user,
      this.auditMeta(req),
    );
  }

  @Patch(':activityId/sessions/:sessionId/positions/:positionId')
  @ApiOperation({ summary: 'App 修改本人 draft 场次岗位 [auth]' })
  @ApiWrappedOkResponse(AppManagedActivitySessionPositionDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_CHANGE_REVIEW_REQUIRED,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ATTENDANCE_ROLE_CODE_INVALID,
    BizCode.ACTIVITY_GENDER_REQUIREMENT_CODE_INVALID,
    BizCode.ACTIVITY_RESPONSIBILITY_TARGET_INVALID,
    BizCode.ACTIVITY_SESSION_POSITION_NAME_ALREADY_EXISTS,
    BizCode.ACTIVITY_SESSION_POSITION_CAPACITY_INVALID,
    BizCode.ACTIVITY_SESSION_POSITION_TIME_RANGE_INVALID,
    BizCode.ACTIVITY_SESSION_POSITION_LOCATION_POLICY_INVALID,
  )
  async updateSessionPosition(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivitySessionPositionParamsDto,
    @Body() dto: UpdateAppManagedActivitySessionPositionDto,
    @Req() req: Request,
  ): Promise<AppManagedActivitySessionPositionDto> {
    await this.resolveMemberId(user);
    return this.service.updateSessionPosition(
      params.activityId,
      params.sessionId,
      params.positionId,
      dto,
      user,
      this.auditMeta(req),
    );
  }

  @Delete(':activityId/sessions/:sessionId/positions/:positionId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'App 软删本人 draft 场次岗位 [auth]' })
  @ApiWrappedOkResponse(AppManagedActivitySessionPositionDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_CHANGE_REVIEW_REQUIRED,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ACTIVITY_PARTICIPATION_EXISTS_DELETE_FORBIDDEN,
  )
  async deleteSessionPosition(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivitySessionPositionParamsDto,
    @Req() req: Request,
  ): Promise<AppManagedActivitySessionPositionDto> {
    await this.resolveMemberId(user);
    return this.service.deleteSessionPosition(
      params.activityId,
      params.sessionId,
      params.positionId,
      user,
      this.auditMeta(req),
    );
  }

  @Post(':activityId/settlement/generate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'App 生成或刷新结算草稿 [rbac: activity.settlement-generate.record]' })
  @ApiWrappedOkResponse(AppSettlementGenerateResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.SETTLEMENT_DRAFT_EVIDENCE_SEAL_MISSING,
    BizCode.SETTLEMENT_DRAFT_EVIDENCE_SEAL_SUPERSEDED,
    BizCode.SETTLEMENT_DRAFT_EVIDENCE_SEAL_STALE,
    BizCode.SETTLEMENT_DRAFT_RUN_STATUS_INVALID,
    BizCode.SETTLEMENT_DRAFT_OPERATION_KEY_CONFLICT,
  )
  async generateSettlement(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityParamsDto,
    @Body() dto: AppSettlementGenerateCommandDto,
    @Req() req: Request,
  ): Promise<AppSettlementGenerateResponseDto> {
    await this.resolveMemberId(user);
    return await this.settlements.generate(
      params.activityId,
      dto.operationKey,
      user,
      this.auditMeta(req),
    );
  }

  @Post(':activityId/settlement/submit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'App 固化当前草稿为不可变结算版本 [rbac: activity.settlement-submit.record]',
  })
  @ApiWrappedOkResponse(AppSettlementSubmitResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.SETTLEMENT_SUBMIT_RUN_STATUS_INVALID,
    BizCode.SETTLEMENT_SUBMIT_DRAFT_MISSING,
    BizCode.SETTLEMENT_SUBMIT_EVIDENCE_SEAL_INACTIVE,
    BizCode.SETTLEMENT_SUBMIT_EVIDENCE_SEAL_STALE,
    BizCode.SETTLEMENT_SUBMIT_EXPECTED_DRAFT_VERSION_MISMATCH,
    BizCode.SETTLEMENT_SUBMIT_EXPECTED_EVIDENCE_SEAL_MISMATCH,
    BizCode.SETTLEMENT_SUBMIT_PENDING_RESULT,
    BizCode.SETTLEMENT_SUBMIT_ITEM_COUNT_MISMATCH,
    BizCode.SETTLEMENT_SUBMIT_DUPLICATE_IDENTITY,
    BizCode.SETTLEMENT_SUBMIT_OPEN_SEGMENT,
    BizCode.SETTLEMENT_SUBMIT_MISSING_RULE,
    BizCode.SETTLEMENT_SUBMIT_OPERATION_KEY_CONFLICT,
  )
  async submitSettlement(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityParamsDto,
    @Body() dto: AppSettlementSubmitCommandDto,
    @Req() req: Request,
  ): Promise<AppSettlementSubmitResponseDto> {
    await this.resolveMemberId(user);
    return await this.settlements.submit(
      params.activityId,
      {
        operationKey: dto.operationKey,
        expectedDraftVersion: dto.expectedDraftVersion,
        evidenceSealId: dto.evidenceSealId,
        confirmation: dto.confirmation,
      },
      user,
      this.auditMeta(req),
    );
  }

  @Post(':activityId/settlement/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'App 执行结算和账本检查后机器关账 [rbac: activity.settlement-close.record]',
  })
  @ApiWrappedOkResponse(AppSettlementCloseResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_CLOSURE_EXPECTED_SETTLEMENT_VERSION_MISMATCH,
    BizCode.ACTIVITY_CLOSURE_EXPECTED_POSTING_BATCH_MISMATCH,
    BizCode.ACTIVITY_CLOSURE_OPERATION_KEY_CONFLICT,
    BizCode.ACTIVITY_CLOSURE_ALREADY_ACTIVE,
    BizCode.ACTIVITY_CLOSURE_SETTLEMENT_INCOMPLETE,
  )
  async closeSettlement(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityParamsDto,
    @Body() dto: AppSettlementCloseCommandDto,
    @Req() req: Request,
  ): Promise<AppSettlementCloseResponseDto> {
    await this.resolveMemberId(user);
    return await this.settlements.close(
      params.activityId,
      {
        operationKey: dto.operationKey,
        expectedSettlementVersionId: dto.expectedSettlementVersionId,
        expectedPostingBatchId: dto.expectedPostingBatchId,
      },
      user,
      this.auditMeta(req),
    );
  }

  @Get(':activityId/settlement')
  @ApiOperation({
    summary: 'App 查看负责人结算工作台摘要 [rbac: activity.settlement-generate.record]',
  })
  @ApiWrappedOkResponse(AppSettlementWorkbenchResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  async settlementWorkbench(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityParamsDto,
  ): Promise<AppSettlementWorkbenchResponseDto> {
    await this.resolveMemberId(user);
    return await this.settlements.workbench(params.activityId, user);
  }

  @Get(':activityId/settlement/items')
  @ApiOperation({
    summary: 'App 分页查看负责人结算逐人结果 [rbac: activity.settlement-generate.record]',
  })
  @ApiWrappedPageResponse(AppSettlementItemDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  async settlementItems(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityParamsDto,
    @Query() query: AppSettlementItemsQueryDto,
  ) {
    await this.resolveMemberId(user);
    return await this.settlements.items(params.activityId, query, user);
  }

  @Patch(':activityId/settlement/items/:identityId')
  @ApiOperation({
    summary:
      'App 负责人编辑当前 working draft 结算项 [rbac: activity.settlement-update-draft.record]',
  })
  @ApiWrappedOkResponse(AppSettlementUpdatedDraftItemResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.SETTLEMENT_DRAFT_UPDATE_RUN_STATUS_INVALID,
    BizCode.SETTLEMENT_DRAFT_UPDATE_EXPECTED_DRAFT_VERSION_MISMATCH,
    BizCode.SETTLEMENT_SUBMIT_DRAFT_MISSING,
  )
  async updateSettlementDraftItem(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppSettlementItemParamsDto,
    @Body() dto: AppSettlementUpdateDraftItemDto,
  ): Promise<AppSettlementUpdatedDraftItemResponseDto> {
    await this.resolveMemberId(user);
    return await this.settlements.updateDraftItem(
      {
        activityId: params.activityId,
        participationIdentityId: params.identityId,
        expectedDraftVersion: dto.expectedDraftVersion,
        resultCode: dto.resultCode,
        recognizedServiceHours: dto.recognizedServiceHours,
        recognizedContributionPoints: dto.recognizedContributionPoints,
        reason: dto.reason,
      },
      user,
    );
  }

  @Get(':activityId/settlement/versions/:versionId')
  @ApiOperation({
    summary: 'App 查看不可变结算版本、差异和封场修订 [rbac: activity.settlement-generate.record]',
  })
  @ApiWrappedOkResponse(AppSettlementVersionDetailResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  async settlementVersionDetail(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppSettlementVersionParamsDto,
  ): Promise<AppSettlementVersionDetailResponseDto> {
    await this.resolveMemberId(user);
    return await this.settlements.versionDetail(params.activityId, params.versionId, user);
  }

  @Post(':activityId/settlement/versions/:versionId/resubmit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'App 将 returned 结算版本基于当前 working draft 重新提交 [rbac: activity.settlement-submit.record]',
  })
  @ApiWrappedOkResponse(AppSettlementSubmitResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.SETTLEMENT_RESUBMIT_VERSION_NOT_RETURNED,
    BizCode.SETTLEMENT_SUBMIT_RUN_STATUS_INVALID,
    BizCode.SETTLEMENT_SUBMIT_DRAFT_MISSING,
    BizCode.SETTLEMENT_SUBMIT_EVIDENCE_SEAL_INACTIVE,
    BizCode.SETTLEMENT_SUBMIT_EVIDENCE_SEAL_STALE,
    BizCode.SETTLEMENT_SUBMIT_EXPECTED_DRAFT_VERSION_MISMATCH,
    BizCode.SETTLEMENT_SUBMIT_EXPECTED_EVIDENCE_SEAL_MISMATCH,
    BizCode.SETTLEMENT_SUBMIT_PENDING_RESULT,
    BizCode.SETTLEMENT_SUBMIT_ITEM_COUNT_MISMATCH,
    BizCode.SETTLEMENT_SUBMIT_DUPLICATE_IDENTITY,
    BizCode.SETTLEMENT_SUBMIT_OPEN_SEGMENT,
    BizCode.SETTLEMENT_SUBMIT_MISSING_RULE,
    BizCode.SETTLEMENT_SUBMIT_OPERATION_KEY_CONFLICT,
  )
  async resubmitSettlement(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppSettlementVersionParamsDto,
    @Body() dto: AppSettlementResubmitCommandDto,
    @Req() req: Request,
  ): Promise<AppSettlementSubmitResponseDto> {
    await this.resolveMemberId(user);
    return await this.settlements.resubmit(
      params.activityId,
      params.versionId,
      {
        operationKey: dto.operationKey,
        expectedDraftVersion: dto.expectedDraftVersion,
        evidenceSealId: dto.evidenceSealId,
        confirmation: dto.confirmation,
      },
      user,
      this.auditMeta(req),
    );
  }

  @Get(':activityId')
  @ApiOperation({ summary: 'App 我管理的活动详情、责任、审核与待办摘要 [auth]' })
  @ApiWrappedOkResponse(AppManagedActivityDetailDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  async detail(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityParamsDto,
  ): Promise<AppManagedActivityDetailDto> {
    return this.service.detail(params.activityId, await this.resolveMemberId(user), user);
  }

  @Patch(':activityId')
  @ApiOperation({ summary: 'App 发起人修改 draft 活动 [auth]' })
  @ApiWrappedOkResponse(AppManagedActivityDetailDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING,
    BizCode.ACTIVITY_CHANGE_REVIEW_REQUIRED,
    BizCode.ORGANIZATION_NOT_FOUND,
    BizCode.ORGANIZATION_INACTIVE,
    BizCode.ACTIVITY_ORGANIZATION_ROOT_FORBIDDEN,
    BizCode.ACTIVITY_INITIATOR_NOT_FORMAL,
    BizCode.ACTIVITY_INITIATION_ORG_FORBIDDEN,
  )
  async update(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityParamsDto,
    @Body() dto: UpdateAppManagedActivityDto,
    @Req() req: Request,
  ): Promise<AppManagedActivityDetailDto> {
    await this.resolveMemberId(user);
    return this.service.update(params.activityId, this.toUpdateDto(dto), user, this.auditMeta(req));
  }

  @Delete(':activityId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'App 发起人删除无参与数据的 draft 活动 [auth]' })
  @ApiWrappedOkResponse(AppManagedActivityProjectionDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_PARTICIPATION_EXISTS_DELETE_FORBIDDEN,
  )
  async softDelete(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityParamsDto,
    @Req() req: Request,
  ): Promise<AppManagedActivityProjectionDto> {
    await this.resolveMemberId(user);
    return this.service.softDelete(params.activityId, user, this.auditMeta(req));
  }

  @Post(':activityId/submit-publish-review')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'App 发起人提交初次发布审核 [auth]' })
  @ApiWrappedOkResponse(ActivityPublishReviewResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING,
  )
  async submitPublishReview(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityParamsDto,
    @Req() req: Request,
  ): Promise<ActivityPublishReviewResponseDto> {
    await this.resolveMemberId(user);
    return this.service.submitInitial(params.activityId, user, this.auditMeta(req));
  }

  @Post(':activityId/direct-publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'App 发起人在持有效发布审核 grant 时直接发布 [auth]' })
  @ApiWrappedOkResponse(AppManagedActivityDetailDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING,
  )
  async directPublish(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityParamsDto,
    @Req() req: Request,
  ): Promise<AppManagedActivityDetailDto> {
    await this.resolveMemberId(user);
    return this.service.directPublish(params.activityId, user, this.auditMeta(req));
  }

  @Post(':activityId/submit-change-review')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'App 活动负责人提交已发布活动的完整变更 proposal [auth]' })
  @ApiWrappedOkResponse(ActivityPublishReviewResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING,
    BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID,
  )
  async submitChangeReview(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityParamsDto,
    @Body() dto: AppSubmitActivityChangeReviewDto,
    @Req() req: Request,
  ): Promise<ActivityPublishReviewResponseDto> {
    await this.resolveMemberId(user);
    return this.service.submitChange(
      params.activityId,
      this.toUpdateDto(dto.activity),
      dto.positions,
      user,
      this.auditMeta(req),
    );
  }

  @Post(':activityId/withdraw-publish-review')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'App 提交人撤回当前 pending 发布审核 [auth]' })
  @ApiWrappedOkResponse(ActivityPublishReviewResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_PUBLISH_REVIEW_NOT_FOUND,
    BizCode.ACTIVITY_PUBLISH_REVIEW_STATUS_INVALID,
  )
  async withdrawPublishReview(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityParamsDto,
    @Req() req: Request,
  ): Promise<ActivityPublishReviewResponseDto> {
    await this.resolveMemberId(user);
    return this.service.withdraw(params.activityId, user, this.auditMeta(req));
  }

  @Post(':activityId/declare-attendance-complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'App 主负责人声明活动考勤已全部提交 [auth]' })
  @ApiWrappedOkResponse(AppManagedActivityDetailDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_ATTENDANCE_DECLARATION_INVALID,
  )
  async declareAttendanceComplete(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityParamsDto,
    @Req() req: Request,
  ): Promise<AppManagedActivityDetailDto> {
    await this.resolveMemberId(user);
    return this.service.declareAttendanceComplete(params.activityId, user, this.auditMeta(req));
  }

  private async resolveMemberId(user: CurrentUserPayload): Promise<string> {
    const access = await this.identity.resolve(user);
    if (!access.canUseApp || !access.member) throw new BizException(BizCode.FORBIDDEN);
    return access.member.id;
  }

  private auditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }

  private toCreateDto(dto: CreateAppManagedActivityDto): CreateActivityDto {
    return {
      title: dto.title,
      activityTypeCode: dto.activityTypeCode,
      organizationId: dto.organizationId,
      registrationModeCode: dto.registrationModeCode,
      visibilityCode: dto.visibilityCode,
      defaultLocationRequired: dto.defaultLocationRequired,
      startAt: dto.startAt,
      endAt: dto.endAt,
      location: dto.location,
      ...(dto.description === undefined ? {} : { description: dto.description }),
      ...(dto.capacity === undefined ? {} : { capacity: dto.capacity }),
      ...(dto.genderRequirementCode === undefined
        ? {}
        : { genderRequirementCode: dto.genderRequirementCode }),
      ...(dto.registrationDeadline === undefined
        ? {}
        : { registrationDeadline: dto.registrationDeadline }),
      ...(dto.registrationNotes === undefined ? {} : { registrationNotes: dto.registrationNotes }),
      ...(dto.isPublicRegistration === undefined
        ? {}
        : { isPublicRegistration: dto.isPublicRegistration }),
      ...(dto.requiresInsurance === undefined ? {} : { requiresInsurance: dto.requiresInsurance }),
      ...(dto.registrationSchema === undefined
        ? {}
        : { registrationSchema: dto.registrationSchema }),
      ...(dto.coverImageUrl === undefined ? {} : { coverImageUrl: dto.coverImageUrl }),
      ...(dto.galleryImageUrls === undefined ? {} : { galleryImageUrls: dto.galleryImageUrls }),
      ...(dto.content === undefined ? {} : { content: dto.content }),
      ...(dto.locationLongitude === undefined ? {} : { locationLongitude: dto.locationLongitude }),
      ...(dto.locationLatitude === undefined ? {} : { locationLatitude: dto.locationLatitude }),
      ...(dto.defaultCheckInRadiusMeters === undefined
        ? {}
        : { defaultCheckInRadiusMeters: dto.defaultCheckInRadiusMeters }),
      ...(dto.archiveWaitingDays === undefined
        ? {}
        : { archiveWaitingDays: dto.archiveWaitingDays }),
    };
  }

  private toUpdateDto(dto: UpdateAppManagedActivityDto): UpdateActivityDto {
    return {
      ...(dto.title === undefined ? {} : { title: dto.title }),
      ...(dto.activityTypeCode === undefined ? {} : { activityTypeCode: dto.activityTypeCode }),
      ...(dto.organizationId === undefined ? {} : { organizationId: dto.organizationId }),
      ...(dto.registrationModeCode === undefined
        ? {}
        : { registrationModeCode: dto.registrationModeCode }),
      ...(dto.visibilityCode === undefined ? {} : { visibilityCode: dto.visibilityCode }),
      ...(dto.defaultLocationRequired === undefined
        ? {}
        : { defaultLocationRequired: dto.defaultLocationRequired }),
      ...(dto.defaultCheckInRadiusMeters === undefined
        ? {}
        : { defaultCheckInRadiusMeters: dto.defaultCheckInRadiusMeters }),
      ...(dto.archiveWaitingDays === undefined
        ? {}
        : { archiveWaitingDays: dto.archiveWaitingDays }),
      ...(dto.startAt === undefined ? {} : { startAt: dto.startAt }),
      ...(dto.endAt === undefined ? {} : { endAt: dto.endAt }),
      ...(dto.location === undefined ? {} : { location: dto.location }),
      ...(dto.description === undefined ? {} : { description: dto.description }),
      ...(dto.capacity === undefined ? {} : { capacity: dto.capacity }),
      ...(dto.genderRequirementCode === undefined
        ? {}
        : { genderRequirementCode: dto.genderRequirementCode }),
      ...(dto.registrationDeadline === undefined
        ? {}
        : { registrationDeadline: dto.registrationDeadline }),
      ...(dto.registrationNotes === undefined ? {} : { registrationNotes: dto.registrationNotes }),
      ...(dto.isPublicRegistration === undefined
        ? {}
        : { isPublicRegistration: dto.isPublicRegistration }),
      ...(dto.requiresInsurance === undefined ? {} : { requiresInsurance: dto.requiresInsurance }),
      ...(dto.registrationSchema === undefined
        ? {}
        : { registrationSchema: dto.registrationSchema }),
      ...(dto.coverImageUrl === undefined ? {} : { coverImageUrl: dto.coverImageUrl }),
      ...(dto.galleryImageUrls === undefined ? {} : { galleryImageUrls: dto.galleryImageUrls }),
      ...(dto.content === undefined ? {} : { content: dto.content }),
      ...(dto.locationLongitude === undefined ? {} : { locationLongitude: dto.locationLongitude }),
      ...(dto.locationLatitude === undefined ? {} : { locationLatitude: dto.locationLatitude }),
    };
  }
}
