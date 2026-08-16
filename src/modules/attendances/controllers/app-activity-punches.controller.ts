import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import {
  ApiBizErrorResponse,
  ApiWrappedCreatedResponse,
  ApiWrappedOkResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { LoginScoped } from '../../../common/decorators/route-authz.decorator';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { BizException } from '../../../common/exceptions/biz.exception';
import type { AuditMeta } from '../../audit-logs/audit-logs.types';
import { AppIdentityResolver } from '../../users/app-identity.resolver';
import { AttendancePunchCommandService } from '../attendance-punch-command.service';
import {
  AppActivityPunchDto,
  AppActivityPunchParamsDto,
  AppActivityPunchReceiptDto,
  AppActivityPunchStateDto,
} from '../dto/app/app-activity-punch.dto';

@ApiTags('Mobile - My Activity Punches')
@ApiBearerAuth()
@Controller('app/v1/activities/:activityId/sessions/:sessionId')
export class AppActivityPunchesController {
  constructor(
    private readonly identity: AppIdentityResolver,
    private readonly command: AttendancePunchCommandService,
  ) {}

  @Post('punches/check-in')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['self'],
    engine: 'authz-scoped',
  })
  @ApiOperation({ summary: '本人扫描场次签到二维码并追加正式签到事实 [auth]' })
  @ApiWrappedCreatedResponse(AppActivityPunchReceiptDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ATTENDANCE_REGISTRATION_INVALID,
    BizCode.ATTENDANCE_QR_NOT_FOUND,
    BizCode.ATTENDANCE_QR_REVOKED,
    BizCode.ATTENDANCE_QR_ACTION_MISMATCH,
    BizCode.ATTENDANCE_QR_VERSION_CONFLICT,
    BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT,
    BizCode.ATTENDANCE_PUNCH_OUTSIDE_WINDOW,
    BizCode.ATTENDANCE_PUNCH_LOCATION_REQUIRED,
    BizCode.ATTENDANCE_PUNCH_LOCATION_OUT_OF_RANGE,
    BizCode.ATTENDANCE_PUNCH_OPEN_SEGMENT_EXISTS,
  )
  async checkIn(
    @Param() params: AppActivityPunchParamsDto,
    @Body() dto: AppActivityPunchDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AppActivityPunchReceiptDto> {
    await this.assertAppAccess(user);
    return this.command.selfPunch({
      activityId: params.activityId,
      sessionId: params.sessionId,
      actionCode: 'check_in',
      dto,
      currentUser: user,
      auditMeta: this.auditMeta(req),
    });
  }

  @Post('punches/check-out')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['self'],
    engine: 'authz-scoped',
  })
  @ApiOperation({ summary: '本人扫描场次签退二维码并追加正式签退事实 [auth]' })
  @ApiWrappedCreatedResponse(AppActivityPunchReceiptDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ATTENDANCE_QR_NOT_FOUND,
    BizCode.ATTENDANCE_QR_REVOKED,
    BizCode.ATTENDANCE_QR_ACTION_MISMATCH,
    BizCode.ATTENDANCE_QR_VERSION_CONFLICT,
    BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT,
    BizCode.ATTENDANCE_PUNCH_OUTSIDE_WINDOW,
    BizCode.ATTENDANCE_PUNCH_LOCATION_REQUIRED,
    BizCode.ATTENDANCE_PUNCH_LOCATION_OUT_OF_RANGE,
    BizCode.ATTENDANCE_PUNCH_CHECK_OUT_REQUIRES_OPEN_SEGMENT,
    BizCode.ATTENDANCE_PUNCH_MIN_DURATION_NOT_REACHED,
  )
  async checkOut(
    @Param() params: AppActivityPunchParamsDto,
    @Body() dto: AppActivityPunchDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AppActivityPunchReceiptDto> {
    await this.assertAppAccess(user);
    return this.command.selfPunch({
      activityId: params.activityId,
      sessionId: params.sessionId,
      actionCode: 'check_out',
      dto,
      currentUser: user,
      auditMeta: this.auditMeta(req),
    });
  }

  @Get('my-punch-state')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['self'],
    engine: 'authz-scoped',
  })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '读取本人当前服务段的安全打卡状态 [auth]' })
  @ApiWrappedOkResponse(AppActivityPunchStateDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ATTENDANCE_REGISTRATION_INVALID,
  )
  async state(
    @Param() params: AppActivityPunchParamsDto,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<AppActivityPunchStateDto> {
    const memberId = await this.resolveMemberId(user);
    return this.command.myState({
      activityId: params.activityId,
      sessionId: params.sessionId,
      memberId,
    });
  }

  private async resolveMemberId(user: CurrentUserPayload): Promise<string> {
    const access = await this.identity.resolve(user);
    if (!access.canUseApp || !access.member) throw new BizException(BizCode.FORBIDDEN);
    return access.member.id;
  }

  private async assertAppAccess(user: CurrentUserPayload): Promise<void> {
    await this.resolveMemberId(user);
  }

  private auditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }
}
