import { Body, Controller, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { BizException } from '../../../common/exceptions/biz.exception';
import type { AuditMeta } from '../../audit-logs/audit-logs.types';
import { AppIdentityResolver } from '../../users/app-identity.resolver';
import { ActivityInvitationService } from '../activity-invitation.service';
import {
  AppActivityInvitationDto,
  AppMyActivityInvitationParamsDto,
  DeclineAppMyActivityInvitationDto,
} from '../dto/app/app-activity-invitation.dto';
import {
  AppActivityRegistrationCommandDto,
} from '../dto/app/app-activity-registration-command.dto';
import { AppActivityRegistrationCommandReceiptDto } from '../dto/app/create-app-activity-registration.dto';
import { LoginScoped } from '../../../common/decorators/route-authz.decorator';

@ApiTags('Mobile - My Activity Invitations')
@ApiBearerAuth()
@Controller('app/v1/my/activity-invitations')
export class AppMyActivityInvitationsController {
  constructor(
    private readonly identity: AppIdentityResolver,
    private readonly invitations: ActivityInvitationService,
  ) {}

  @Post(':invitationId/accept')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['self'],
    engine: 'authz-scoped',
  })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'App 队员接受自己的未过期 pending 邀请并提交 canonical 报名 [auth]' })
  @ApiWrappedOkResponse(AppActivityRegistrationCommandReceiptDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_INVITATION_NOT_FOUND,
    BizCode.ACTIVITY_INVITATION_STATUS_INVALID,
    BizCode.ACTIVITY_INVITATION_OPERATION_KEY_CONFLICT,
    BizCode.ACTIVITY_REGISTRATION_OPERATION_KEY_CONFLICT,
    BizCode.ACTIVITY_QUALIFICATION_NOT_MET,
    BizCode.ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID,
    BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED,
  )
  async accept(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppMyActivityInvitationParamsDto,
    @Body() dto: AppActivityRegistrationCommandDto,
    @Req() req: Request,
  ): Promise<AppActivityRegistrationCommandReceiptDto> {
    const access = await this.identity.resolve(user);
    if (!access.canUseApp || access.member === null) {
      throw new BizException(BizCode.FORBIDDEN);
    }
    return this.invitations.accept(params.invitationId, dto, user, this.auditMeta(req));
  }

  @Post(':invitationId/decline')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['self'],
    engine: 'authz-scoped',
  })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'App 队员拒绝自己的未过期 pending 邀请 [auth]' })
  @ApiWrappedOkResponse(AppActivityInvitationDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_INVITATION_NOT_FOUND,
    BizCode.ACTIVITY_INVITATION_STATUS_INVALID,
    BizCode.ACTIVITY_INVITATION_OPERATION_KEY_CONFLICT,
  )
  async decline(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppMyActivityInvitationParamsDto,
    @Body() dto: DeclineAppMyActivityInvitationDto,
    @Req() req: Request,
  ): Promise<AppActivityInvitationDto> {
    const access = await this.identity.resolve(user);
    if (!access.canUseApp || access.member === null) {
      throw new BizException(BizCode.FORBIDDEN);
    }
    return this.invitations.decline(params.invitationId, dto, user, this.auditMeta(req));
  }

  private auditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }
}
