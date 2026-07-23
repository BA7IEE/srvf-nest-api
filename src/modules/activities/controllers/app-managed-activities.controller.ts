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

@ApiTags('Mobile - Managed Activities')
@ApiBearerAuth()
@Controller('app/v1/my/managed-activities')
export class AppManagedActivitiesController {
  constructor(
    private readonly identity: AppIdentityResolver,
    private readonly service: AppManagedActivitiesService,
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
      ...(dto.content === undefined ? {} : { content: dto.content }),
      ...(dto.locationLongitude === undefined ? {} : { locationLongitude: dto.locationLongitude }),
      ...(dto.locationLatitude === undefined ? {} : { locationLatitude: dto.locationLatitude }),
    };
  }

  private toUpdateDto(dto: UpdateAppManagedActivityDto): UpdateActivityDto {
    return {
      ...(dto.title === undefined ? {} : { title: dto.title }),
      ...(dto.activityTypeCode === undefined ? {} : { activityTypeCode: dto.activityTypeCode }),
      ...(dto.organizationId === undefined ? {} : { organizationId: dto.organizationId }),
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
      ...(dto.content === undefined ? {} : { content: dto.content }),
      ...(dto.locationLongitude === undefined ? {} : { locationLongitude: dto.locationLongitude }),
      ...(dto.locationLatitude === undefined ? {} : { locationLatitude: dto.locationLatitude }),
    };
  }
}
