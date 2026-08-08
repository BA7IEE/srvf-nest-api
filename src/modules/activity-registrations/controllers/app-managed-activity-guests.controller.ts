import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
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
import type { PageResultDto } from '../../../common/dto/pagination.dto';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { BizException } from '../../../common/exceptions/biz.exception';
import type { AuditMeta } from '../../audit-logs/audit-logs.types';
import { AppIdentityResolver } from '../../users/app-identity.resolver';
import { ActivityInvitationService } from '../activity-invitation.service';
import { ActivityVisitorService } from '../activity-visitor.service';
import {
  AppActivityInvitationDto,
  AppManagedActivityInvitationActivityParamsDto,
  AppManagedActivityInvitationParamsDto,
  AppManagedActivityInvitationsQueryDto,
  CreateAppManagedActivityInvitationDto,
  RevokeAppManagedActivityInvitationDto,
} from '../dto/app/app-activity-invitation.dto';
import {
  AppActivityVisitorDto,
  AppManagedActivityVisitorActivityParamsDto,
  AppManagedActivityVisitorsQueryDto,
  CreateAppManagedActivityVisitorDto,
} from '../dto/app/app-activity-visitor.dto';

@ApiTags('Mobile - Managed Activity Guests')
@ApiBearerAuth()
@Controller('app/v1/my/managed-activities/:activityId')
export class AppManagedActivityGuestsController {
  constructor(
    private readonly identity: AppIdentityResolver,
    private readonly invitations: ActivityInvitationService,
    private readonly visitors: ActivityVisitorService,
  ) {}

  @Get('invitations')
  @ApiOperation({ summary: 'App 活动负责人或报名协办查看邀请列表 [auth]' })
  @ApiWrappedPageResponse(AppActivityInvitationDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  async listInvitations(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityInvitationActivityParamsDto,
    @Query() query: AppManagedActivityInvitationsQueryDto,
  ): Promise<PageResultDto<AppActivityInvitationDto>> {
    await this.assertAppAccess(user);
    return this.invitations.list(params.activityId, query, user);
  }

  @Post('invitations')
  @ApiOperation({ summary: 'App 活动负责人或报名协办创建定向邀请 [auth]' })
  @ApiWrappedCreatedResponse(AppActivityInvitationDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_INVITATION_NOT_FOUND,
    BizCode.ACTIVITY_INVITATION_ALREADY_PENDING,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.MEMBER_INACTIVE,
  )
  async createInvitation(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityInvitationActivityParamsDto,
    @Body() dto: CreateAppManagedActivityInvitationDto,
    @Req() req: Request,
  ): Promise<AppActivityInvitationDto> {
    await this.assertAppAccess(user);
    return this.invitations.create(params.activityId, dto, user, this.auditMeta(req));
  }

  @Post('invitations/:invitationId/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'App 活动负责人或报名协办撤回未过期的 pending 邀请 [auth]' })
  @ApiWrappedOkResponse(AppActivityInvitationDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_INVITATION_NOT_FOUND,
    BizCode.ACTIVITY_INVITATION_STATUS_INVALID,
  )
  async revokeInvitation(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityInvitationParamsDto,
    @Body() dto: RevokeAppManagedActivityInvitationDto,
    @Req() req: Request,
  ): Promise<AppActivityInvitationDto> {
    await this.assertAppAccess(user);
    return this.invitations.revoke(
      params.activityId,
      params.invitationId,
      dto,
      user,
      this.auditMeta(req),
    );
  }

  @Get('visitors')
  @ApiOperation({ summary: 'App 活动负责人或报名协办查看访客名单 [auth]' })
  @ApiWrappedPageResponse(AppActivityVisitorDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  async listVisitors(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityVisitorActivityParamsDto,
    @Query() query: AppManagedActivityVisitorsQueryDto,
  ): Promise<PageResultDto<AppActivityVisitorDto>> {
    await this.assertAppAccess(user);
    return this.visitors.list(params.activityId, query, user);
  }

  @Post('visitors')
  @ApiOperation({ summary: 'App 活动负责人或报名协办登记外部访客 [auth]' })
  @ApiWrappedCreatedResponse(AppActivityVisitorDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.MEMBER_NOT_FOUND,
  )
  async createVisitor(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityVisitorActivityParamsDto,
    @Body() dto: CreateAppManagedActivityVisitorDto,
    @Req() req: Request,
  ): Promise<AppActivityVisitorDto> {
    await this.assertAppAccess(user);
    return this.visitors.create(params.activityId, dto, user, this.auditMeta(req));
  }

  private async assertAppAccess(user: CurrentUserPayload): Promise<void> {
    const access = await this.identity.resolve(user);
    if (!access.canUseApp || access.member === null) {
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
