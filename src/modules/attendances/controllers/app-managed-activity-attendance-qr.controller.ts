import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Readable } from 'node:stream';

import {
  ApiBizErrorResponse,
  ApiWrappedArrayResponse,
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
import { AttendanceQrCredentialService } from '../attendance-qr-credential.service';
import {
  AppManagedAttendanceQrCredentialDto,
  AppManagedAttendanceQrCredentialParamsDto,
  AppManagedAttendanceQrIssueParamsDto,
  AppManagedAttendanceQrSessionParamsDto,
  IssueAppManagedAttendanceQrDto,
  RevokeAppManagedAttendanceQrDto,
} from '../dto/app/app-managed-attendance-qr.dto';

@ApiTags('Mobile - Managed Activity Attendance QR')
@ApiBearerAuth()
@Controller('app/v1/my/managed-activities/:activityId')
export class AppManagedActivityAttendanceQrController {
  constructor(
    private readonly identity: AppIdentityResolver,
    private readonly service: AttendanceQrCredentialService,
  ) {}

  @Get('sessions/:sessionId/qr-credentials')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['responsibility'],
    engine: 'authz-scoped',
  })
  @ApiOperation({ summary: 'App 考勤责任人读取场次二维码版本与状态（不返回可用 token） [auth]' })
  @ApiWrappedArrayResponse(AppManagedAttendanceQrCredentialDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  async list(
    @Param() params: AppManagedAttendanceQrSessionParamsDto,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<AppManagedAttendanceQrCredentialDto[]> {
    await this.assertAppAccess(user);
    return this.service.list(params.activityId, params.sessionId, user);
  }

  @Post('sessions/:sessionId/qr-credentials/:action/issue')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['responsibility'],
    engine: 'authz-scoped',
  })
  @ApiOperation({ summary: '签发或重签场次签到/签退二维码；窗口只取冻结场次配置 [auth]' })
  @ApiWrappedCreatedResponse(AppManagedAttendanceQrCredentialDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ATTENDANCE_QR_VERSION_CONFLICT,
  )
  async issue(
    @Param() params: AppManagedAttendanceQrIssueParamsDto,
    @Body() dto: IssueAppManagedAttendanceQrDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AppManagedAttendanceQrCredentialDto> {
    await this.assertAppAccess(user);
    return this.service.issue({
      activityId: params.activityId,
      sessionId: params.sessionId,
      actionCode: params.action === 'check-in' ? 'check_in' : 'check_out',
      operationKey: dto.operationKey,
      currentUser: user,
      auditMeta: this.auditMeta(req),
    });
  }

  @Post('qr-credentials/:credentialId/revoke')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['responsibility'],
    engine: 'authz-scoped',
  })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '作废场次二维码；精确 operationKey 重放原安全回执 [auth]' })
  @ApiWrappedOkResponse(AppManagedAttendanceQrCredentialDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ATTENDANCE_QR_NOT_FOUND,
    BizCode.ATTENDANCE_QR_REVOKED,
    BizCode.ATTENDANCE_QR_VERSION_CONFLICT,
  )
  async revoke(
    @Param() params: AppManagedAttendanceQrCredentialParamsDto,
    @Body() dto: RevokeAppManagedAttendanceQrDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AppManagedAttendanceQrCredentialDto> {
    await this.assertAppAccess(user);
    return this.service.revoke({
      activityId: params.activityId,
      credentialId: params.credentialId,
      reason: dto.reason,
      operationKey: dto.operationKey,
      currentUser: user,
      auditMeta: this.auditMeta(req),
    });
  }

  @Post('qr-credentials/:credentialId/render')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['responsibility'],
    engine: 'authz-scoped',
  })
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '生成受保护且不可缓存的 SVG 二维码二进制内容 [auth]' })
  @ApiProduces('image/svg+xml')
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'SVG 二维码二进制内容；不使用 JSON envelope，绝不回显 token',
    content: { 'image/svg+xml': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiBizErrorResponse(
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ATTENDANCE_QR_NOT_FOUND,
    BizCode.ATTENDANCE_QR_REVOKED,
  )
  async render(
    @Param() params: AppManagedAttendanceQrCredentialParamsDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    await this.assertAppAccess(user);
    const svg = await this.service.renderSvg({
      activityId: params.activityId,
      credentialId: params.credentialId,
      currentUser: user,
      auditMeta: this.auditMeta(req),
    });
    res.set({ 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
    return new StreamableFile(Readable.from(svg));
  }

  private async assertAppAccess(user: CurrentUserPayload): Promise<void> {
    const access = await this.identity.resolve(user);
    if (!access.canUseApp || !access.member) throw new BizException(BizCode.FORBIDDEN);
  }

  private auditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }
}
