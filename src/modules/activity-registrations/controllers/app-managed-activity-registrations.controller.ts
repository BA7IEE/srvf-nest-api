import {
  Body,
  Controller,
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
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import type { PageResultDto } from '../../../common/dto/pagination.dto';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { BizException } from '../../../common/exceptions/biz.exception';
import type { AuditMeta } from '../../audit-logs/audit-logs.types';
import { AppIdentityResolver } from '../../users/app-identity.resolver';
import { AppManagedActivityRegistrationsService } from '../app-managed-activity-registrations.service';
import {
  AppManagedRegistrationActivityParamsDto,
  AppManagedRegistrationBulkResponseDto,
  AppManagedRegistrationDto,
  AppManagedRegistrationListItemDto,
  AppManagedRegistrationParamsDto,
  AppManagedRegistrationsQueryDto,
  ApproveAppManagedRegistrationDto,
  BulkReviewAppManagedRegistrationsDto,
  CancelAppManagedRegistrationDto,
  RejectAppManagedRegistrationDto,
} from '../dto/app/app-managed-registration.dto';

@ApiTags('Mobile - Managed Activity Registrations')
@ApiBearerAuth()
@Controller('app/v1/my/managed-activities/:activityId/registrations')
export class AppManagedActivityRegistrationsController {
  constructor(
    private readonly identity: AppIdentityResolver,
    private readonly service: AppManagedActivityRegistrationsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'App 活动负责人或报名协办查看报名列表 [auth]' })
  @ApiWrappedPageResponse(AppManagedRegistrationListItemDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  async list(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedRegistrationActivityParamsDto,
    @Query() query: AppManagedRegistrationsQueryDto,
  ): Promise<PageResultDto<AppManagedRegistrationListItemDto>> {
    await this.assertAppAccess(user);
    return this.service.list(params.activityId, query, user);
  }

  @Patch('bulk-approve')
  @ApiOperation({ summary: 'App 批量通过活动报名；逐条独立事务并返回部分成功结果 [auth]' })
  @ApiWrappedOkResponse(AppManagedRegistrationBulkResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  async bulkApprove(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedRegistrationActivityParamsDto,
    @Body() dto: BulkReviewAppManagedRegistrationsDto,
    @Req() req: Request,
  ): Promise<AppManagedRegistrationBulkResponseDto> {
    await this.assertAppAccess(user);
    return this.service.bulkApprove(params.activityId, dto, user, this.auditMeta(req));
  }

  @Patch('bulk-reject')
  @ApiOperation({ summary: 'App 批量拒绝活动报名；逐条独立事务并返回部分成功结果 [auth]' })
  @ApiWrappedOkResponse(AppManagedRegistrationBulkResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  async bulkReject(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedRegistrationActivityParamsDto,
    @Body() dto: BulkReviewAppManagedRegistrationsDto,
    @Req() req: Request,
  ): Promise<AppManagedRegistrationBulkResponseDto> {
    await this.assertAppAccess(user);
    return this.service.bulkReject(params.activityId, dto, user, this.auditMeta(req));
  }

  @Patch(':registrationId/approve')
  @ApiOperation({ summary: 'App 活动负责人或报名协办通过待审报名 [auth]' })
  @ApiWrappedOkResponse(AppManagedRegistrationDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_REGISTRATION_NOT_FOUND,
    BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID,
    BizCode.ACTIVITY_ENDED_OR_CANCELLED_APPROVE_FORBIDDEN,
    BizCode.ACTIVITY_CAPACITY_EXCEEDED,
    BizCode.INSURANCE_REQUIRED,
  )
  async approve(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedRegistrationParamsDto,
    @Body() dto: ApproveAppManagedRegistrationDto,
    @Req() req: Request,
  ): Promise<AppManagedRegistrationDto> {
    await this.assertAppAccess(user);
    return this.service.approve(
      params.activityId,
      params.registrationId,
      dto,
      user,
      this.auditMeta(req),
    );
  }

  @Patch(':registrationId/reject')
  @ApiOperation({ summary: 'App 活动负责人或报名协办拒绝待审或候补报名 [auth]' })
  @ApiWrappedOkResponse(AppManagedRegistrationDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_REGISTRATION_NOT_FOUND,
    BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID,
  )
  async reject(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedRegistrationParamsDto,
    @Body() dto: RejectAppManagedRegistrationDto,
    @Req() req: Request,
  ): Promise<AppManagedRegistrationDto> {
    await this.assertAppAccess(user);
    return this.service.reject(
      params.activityId,
      params.registrationId,
      dto,
      user,
      this.auditMeta(req),
    );
  }

  @Patch(':registrationId/cancel')
  @ApiOperation({ summary: 'App 活动负责人或报名协办代取消报名 [auth]' })
  @ApiWrappedOkResponse(AppManagedRegistrationDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_REGISTRATION_NOT_FOUND,
    BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID,
    BizCode.ACTIVITY_REGISTRATION_HAS_ATTENDANCE,
  )
  async cancel(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedRegistrationParamsDto,
    @Body() dto: CancelAppManagedRegistrationDto,
    @Req() req: Request,
  ): Promise<AppManagedRegistrationDto> {
    await this.assertAppAccess(user);
    return this.service.cancel(
      params.activityId,
      params.registrationId,
      dto,
      user,
      this.auditMeta(req),
    );
  }

  @Post(':registrationId/reopen')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'App 活动负责人或报名协办将已拒报名重开为待审 [auth]' })
  @ApiWrappedOkResponse(AppManagedRegistrationDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_REGISTRATION_NOT_FOUND,
    BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID,
  )
  async reopen(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedRegistrationParamsDto,
    @Req() req: Request,
  ): Promise<AppManagedRegistrationDto> {
    await this.assertAppAccess(user);
    return this.service.reopen(params.activityId, params.registrationId, user, this.auditMeta(req));
  }

  private async assertAppAccess(user: CurrentUserPayload): Promise<void> {
    const access = await this.identity.resolve(user);
    if (!access.canUseApp || !access.member) {
      throw new BizException(BizCode.FORBIDDEN);
    }
  }

  private auditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }
}
