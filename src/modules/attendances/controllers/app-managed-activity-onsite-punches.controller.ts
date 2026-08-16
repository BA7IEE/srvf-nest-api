import { Body, Controller, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { ApiBizErrorResponse, ApiWrappedCreatedResponse } from '../../../common/decorators/api-response.decorator';
import { CurrentUser, type CurrentUserPayload } from '../../../common/decorators/current-user.decorator';
import { LoginScoped } from '../../../common/decorators/route-authz.decorator';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { BizException } from '../../../common/exceptions/biz.exception';
import type { AuditMeta } from '../../audit-logs/audit-logs.types';
import { AppIdentityResolver } from '../../users/app-identity.resolver';
import { AttendancePunchCommandService } from '../attendance-punch-command.service';
import { AppActivityPunchReceiptDto } from '../dto/app/app-activity-punch.dto';
import {
  AppManagedOnsitePunchEventParamsDto,
  AppManagedOnsiteSessionParamsDto,
  CorrectAppManagedOnsitePunchDto,
  EarlyDepartureCloseAppManagedOnsitePunchDto,
} from '../dto/app/app-managed-onsite-punch.dto';

@ApiTags('Mobile - Managed Activity Onsite Punches')
@ApiBearerAuth()
@Controller('app/v1/my/managed-activities/:activityId/onsite')
export class AppManagedActivityOnsitePunchesController {
  constructor(
    private readonly identity: AppIdentityResolver,
    private readonly command: AttendancePunchCommandService,
  ) {}

  @Post('sessions/:sessionId/early-departure-close')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['responsibility'],
    engine: 'authz-scoped',
  })
  @ApiOperation({ summary: '考勤责任人特殊提前离场闭合；固定零时长零分 [auth]' })
  @ApiWrappedCreatedResponse(AppActivityPunchReceiptDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ATTENDANCE_PUNCH_CHECK_OUT_REQUIRES_OPEN_SEGMENT,
    BizCode.ATTENDANCE_EARLY_DEPARTURE_REASON_REQUIRED,
    BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT,
    BizCode.ATTENDANCE_PUNCH_OUTSIDE_WINDOW,
  )
  async earlyClose(
    @Param() params: AppManagedOnsiteSessionParamsDto,
    @Body() dto: EarlyDepartureCloseAppManagedOnsitePunchDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AppActivityPunchReceiptDto> {
    await this.assertAppAccess(user);
    return this.command.earlyDepartureClose({
      activityId: params.activityId,
      sessionId: params.sessionId,
      participationIdentityId: dto.participationIdentityId,
      reason: dto.reason,
      eventKey: dto.eventKey,
      currentUser: user,
      auditMeta: this.auditMeta(req),
    });
  }

  @Post('punch-events/:eventId/void')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['responsibility'],
    engine: 'authz-scoped',
  })
  @ApiOperation({ summary: '考勤责任人追加作废事实，不覆盖原现场事件 [auth]' })
  @ApiWrappedCreatedResponse(AppActivityPunchReceiptDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT,
    BizCode.ATTENDANCE_PUNCH_EVENT_ALREADY_VOIDED,
  )
  async voidEvent(
    @Param() params: AppManagedOnsitePunchEventParamsDto,
    @Body() dto: CorrectAppManagedOnsitePunchDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AppActivityPunchReceiptDto> {
    await this.assertAppAccess(user);
    return this.command.voidEvent({
      activityId: params.activityId,
      eventId: params.eventId,
      actionCode: 'void',
      reason: dto.reason,
      operationKey: dto.operationKey,
      currentUser: user,
      auditMeta: this.auditMeta(req),
    });
  }

  @Post('punch-events/:eventId/replace')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['responsibility'],
    engine: 'authz-scoped',
  })
  @ApiOperation({ summary: '考勤责任人追加替代事实，不覆盖原现场事件 [auth]' })
  @ApiWrappedCreatedResponse(AppActivityPunchReceiptDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT,
    BizCode.ATTENDANCE_PUNCH_EVENT_ALREADY_VOIDED,
  )
  async replaceEvent(
    @Param() params: AppManagedOnsitePunchEventParamsDto,
    @Body() dto: CorrectAppManagedOnsitePunchDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AppActivityPunchReceiptDto> {
    await this.assertAppAccess(user);
    return this.command.replaceEvent({
      activityId: params.activityId,
      eventId: params.eventId,
      actionCode: 'replace',
      reason: dto.reason,
      operationKey: dto.operationKey,
      currentUser: user,
      auditMeta: this.auditMeta(req),
    });
  }

  private async assertAppAccess(user: CurrentUserPayload): Promise<void> {
    const access = await this.identity.resolve(user);
    if (!access.canUseApp || !access.member) throw new BizException(BizCode.FORBIDDEN);
  }

  private auditMeta(req: Request): AuditMeta {
    return { requestId: req.id as string, ip: req.ip ?? null, ua: req.headers['user-agent'] ?? null };
  }
}
