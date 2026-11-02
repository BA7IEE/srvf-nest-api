import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { LoginScoped, RequiresPermission } from '../../../common/decorators/route-authz.decorator';
import {
  ApiBizErrorResponse,
  ApiWrappedArrayResponse,
  ApiWrappedCreatedResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../../common/decorators/api-response.decorator';
import { IdParamDto } from '../../../common/dto/id-param.dto';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { ActivitySimpleDraftService } from '../activity-simple-draft.service';
import { ActivityMetricSelectionQueryService } from '../activity-metric-selection-query.service';
import { ActivityPublishReviewResponseDto } from '../activity-publish-review.dto';
import {
  AdminCreateSimpleActivityDto,
  AdminSaveSimpleActivityDto,
  AdminSimpleTemplateOptionsQueryDto,
  AdminSubmitSimpleActivityReviewDto,
} from '../dto/admin/admin-simple-activity.dto';
import {
  AdminSimpleActivityCreationResultDto,
  AdminSimpleDraftResponseDto,
  AdminSimpleOrganizationOptionDto,
  AdminSimpleTemplateVersionOptionDto,
} from '../dto/admin/admin-simple-activity-response.dto';

@ApiTags('Admin - Simple Activities')
@ApiBearerAuth()
@Controller('admin/v1/activities')
export class AdminSimpleActivitiesController {
  constructor(
    private readonly drafts: ActivitySimpleDraftService,
    private readonly options: ActivityMetricSelectionQueryService,
  ) {}

  @Get('organization-options')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility'],
  })
  @ApiOperation({ summary: '当前正式成员本人可发起组织，不授予 GLOBAL 权限 [auth]' })
  @ApiWrappedArrayResponse(AdminSimpleOrganizationOptionDto)
  @ApiBizErrorResponse(
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_INITIATOR_NOT_FORMAL,
  )
  organizationOptions(@CurrentUser() user: CurrentUserPayload) {
    return this.drafts.organizationOptions(user);
  }

  @Get('template-version-options')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility'],
  })
  @ApiOperation({ summary: '本人可发起组织的安全模板版本摘要，与 App 同源 [auth]' })
  @ApiWrappedPageResponse(AdminSimpleTemplateVersionOptionDto)
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
  templateOptions(
    @Query() query: AdminSimpleTemplateOptionsQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.options.templateVersionOptions(query, user, true);
  }

  @Post('from-template')
  @RequiresPermission('activity.create.record', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility'],
  })
  @ApiOperation({ summary: '本人从精确模板原子创建单场次草稿 [rbac: activity.create.record]' })
  @ApiWrappedCreatedResponse(AdminSimpleActivityCreationResultDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ACTIVITY_CONTROL_PLANE_UNAVAILABLE,
    BizCode.ACTIVITY_INITIATOR_NOT_FORMAL,
    BizCode.ACTIVITY_INITIATION_ORG_FORBIDDEN,
    BizCode.ORGANIZATION_NOT_FOUND,
    BizCode.ORGANIZATION_INACTIVE,
    BizCode.ACTIVITY_ORGANIZATION_ROOT_FORBIDDEN,
    BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_SELECTABLE,
    BizCode.ACTIVITY_CREATE_FROM_TEMPLATE_OPERATION_KEY_CONFLICT,
    BizCode.ACTIVITY_SESSION_WINDOW_INVALID,
    BizCode.ACTIVITY_START_END_INVALID,
    BizCode.ACTIVITY_REGISTRATION_DEADLINE_INVALID,
    BizCode.ACTIVITY_TIME_POLICY_SELECTION_POLICY_UNAVAILABLE,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_POLICY_UNAVAILABLE,
  )
  create(
    @Body() input: AdminCreateSimpleActivityDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.drafts.create(input, user, this.meta(req));
  }

  @Get(':id/simple-draft')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility'],
  })
  @ApiOperation({ summary: '本人简单活动最终事实、并发指纹和真实审核状态 [auth]' })
  @ApiWrappedOkResponse(AdminSimpleDraftResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ACTIVITY_INITIATOR_NOT_FORMAL,
    BizCode.ACTIVITY_INITIATION_ORG_FORBIDDEN,
    BizCode.ORGANIZATION_NOT_FOUND,
    BizCode.ORGANIZATION_INACTIVE,
    BizCode.ACTIVITY_ORGANIZATION_ROOT_FORBIDDEN,
    BizCode.ACTIVITY_TIME_POLICY_SELECTION_REFERENCE_UNAVAILABLE,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REFERENCE_UNAVAILABLE,
  )
  get(@Param() params: IdParamDto, @CurrentUser() user: CurrentUserPayload) {
    return this.drafts.get(params.id, user);
  }

  @Put(':id/simple-draft')
  @RequiresPermission('activity.update.record', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility'],
  })
  @ApiOperation({ summary: '根锁和指纹保护的一次完整草稿保存 [rbac: activity.update.record]' })
  @ApiWrappedOkResponse(AdminSimpleDraftResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ORGANIZATION_NOT_FOUND,
    BizCode.ORGANIZATION_INACTIVE,
    BizCode.ACTIVITY_ORGANIZATION_ROOT_FORBIDDEN,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ACTIVITY_CHANGE_REVIEW_REQUIRED,
    BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING,
    BizCode.ACTIVITY_SIMPLE_DRAFT_STALE,
    BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_SELECTABLE,
    BizCode.ACTIVITY_SESSION_WINDOW_INVALID,
    BizCode.ACTIVITY_START_END_INVALID,
    BizCode.ACTIVITY_REGISTRATION_DEADLINE_INVALID,
    BizCode.ACTIVITY_TIME_POLICY_SELECTION_POLICY_UNAVAILABLE,
    BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_POLICY_UNAVAILABLE,
  )
  save(
    @Param() params: IdParamDto,
    @Body() input: AdminSaveSimpleActivityDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.drafts.save(params.id, input, user, this.meta(req));
  }

  @Post(':id/publish-reviews')
  @HttpCode(HttpStatus.OK)
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['responsibility'],
  })
  @ApiOperation({ summary: '本人用客户端幂等键提交现行发布审核，成功不代表已发布 [auth]' })
  @ApiWrappedOkResponse(ActivityPublishReviewResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING,
    BizCode.ACTIVITY_PUBLISH_REVIEW_OPERATION_KEY_CONFLICT,
    BizCode.ACTIVITY_INITIATOR_NOT_FORMAL,
    BizCode.ACTIVITY_INITIATION_ORG_FORBIDDEN,
    BizCode.ORGANIZATION_NOT_FOUND,
    BizCode.ORGANIZATION_INACTIVE,
    BizCode.ACTIVITY_ORGANIZATION_ROOT_FORBIDDEN,
  )
  submit(
    @Param() params: IdParamDto,
    @Body() input: AdminSubmitSimpleActivityReviewDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.drafts.submitReview(params.id, input, user, this.meta(req));
  }

  private meta(req: Request) {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }
}
