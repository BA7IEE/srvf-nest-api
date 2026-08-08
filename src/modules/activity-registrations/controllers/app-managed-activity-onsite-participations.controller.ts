import { Body, Controller, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import {
  ApiBizErrorResponse,
  ApiWrappedCreatedResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { BizException } from '../../../common/exceptions/biz.exception';
import type { AuditMeta } from '../../audit-logs/audit-logs.types';
import { AppIdentityResolver } from '../../users/app-identity.resolver';
import {
  AppManagedActivityOnsiteParticipationParamsDto,
  AppManagedActivityOnsiteParticipationReceiptDto,
  CreateAppManagedActivityOnsiteParticipationDto,
} from '../dto/app/app-onsite-participation.dto';
import { OnsiteParticipationCommandService } from '../onsite-participation-command.service';

@ApiTags('Mobile - Managed Activity Onsite Participations')
@ApiBearerAuth()
@Controller('app/v1/my/managed-activities/:activityId')
export class AppManagedActivityOnsiteParticipationsController {
  constructor(
    private readonly identity: AppIdentityResolver,
    private readonly onsiteParticipations: OnsiteParticipationCommandService,
  ) {}

  @Post('onsite-participations')
  @ApiOperation({ summary: 'App 活动负责人现场临时补录参加并占用容量 [auth]' })
  @ApiWrappedCreatedResponse(AppManagedActivityOnsiteParticipationReceiptDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_NOT_PUBLISHED_PARTICIPATION_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.MEMBER_INACTIVE,
    BizCode.ACTIVITY_REGISTRATION_OPERATION_KEY_CONFLICT,
    BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID,
    BizCode.ACTIVITY_CAPACITY_EXCEEDED,
    BizCode.ACTIVITY_REGISTRATION_GENDER_MISMATCH,
    BizCode.ACTIVITY_POSITION_REQUIRED,
    BizCode.ACTIVITY_ONSITE_REQUIREMENTS_UNAVAILABLE,
    BizCode.INSURANCE_REQUIRED,
    BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED,
  )
  async create(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityOnsiteParticipationParamsDto,
    @Body() dto: CreateAppManagedActivityOnsiteParticipationDto,
    @Req() req: Request,
  ): Promise<AppManagedActivityOnsiteParticipationReceiptDto> {
    await this.assertAppAccess(user);
    return this.onsiteParticipations.create(params.activityId, dto, user, this.auditMeta(req));
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
